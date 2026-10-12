import { VOICE_FALLBACK_SECONDS, VOICE_CATALOG_TTL, SPEECH_API, VOICE_SILENCE_RMS, SPEECH_TRANSCRIBE, VOICE_COMMIT_MAX_SECONDS, VOICE_PREVIEW_WINDOW, VOICE_PAUSE_MS, VOICE_PAUSE_MIN_MS, VOICE_PREVIEW_EVERY, VOICE_MAX_BYTES, SPEECH_PREPARE } from './constants.js'
import { el, listen, clamp } from './dom.js'
import { micIcon } from './icons.js'
import { encodeWave, bytesToBase64, recordingSupported } from './audio.js'

/** voice state and operations; dependencies are supplied as live node/callback accessors. */
export function createVoiceController(env) {

  // ══════════════════════════ 语音输入（麦克风） ══════════════════════════
  //
  // 要解决的问题：追问往往只有一两句话（"这词在这里是不是贬义？"），
  // 但**打字**这件事本身就要把手从鼠标挪到键盘——和"划词"这个动作是矛盾的。
  //
  // **UI 与主会话同一套**（官方 @deepseek-ai/dsh-experimental-client-ui-voice-input）：
  // 平时是输入框右边的 🎤；开始录之后工具行换成录音行 ——`✕` | 实时波形 | `■`，
  // 请求权限/识别中是「呼吸点 + 请允许使用麦克风…/识别中…」，出错是「原因 + 行内动作」。
  // 波形算法（80 根线 / 50ms 采样 / 1+min(1,amp*5)*17 / 右侧最新）逐行照抄，
  // 只有尺寸按小窗的 composer 收成 26px（主会话 32px）——两处看起来才是同一个东西。
  //
  // 识别出来的文字**插进输入框**（不是直接发送：识别有错字，插进去还能改，
  // 也能在同一条里接着说第二段）。录音中切走/收起小窗/这条消息发出去/停用插件
  // 都会立刻松开麦克风（不留下一直亮着的录音标识）。

  /** 状态机：idle → requesting → recording → transcribing →（feedback | idle）→ idle。 */
  var voice = {
    phase: 'idle',
    /**
     * 第几轮。停/取消/关面板都会 +1 —— 晚到的回调据此丢弃自己。
     * 没有它就会出现"明明取消了，过两秒却冒出一段文字"（异步的权限、识别都可能晚到）。
     */
    generation: 0,
    capture: null,
    abort: null,
    ticker: 0,
    waveFrame: 0,
    waveAt: 0,
    startedAt: 0,
    maxSeconds: VOICE_FALLBACK_SECONDS,
    catalog: null,
    catalogAt: 0,
    idleTimer: 0,
    pollTimer: 0,
    lastClock: -1,
    level: 0,
    lastText: '',
    /** feedback 阶段的行内动作（null = 只显示原因，不给按钮）。 */
    action: null,
    /**
     * 实时字幕（半句预览 + 停顿定稿）的运行时状态。
     * text/committed/preview 都是输入框里那一段的一部分，start 是它在 value 里的起点。
     */
    live: {
      active: false,
      disabled: false,
      reason: '',
      separator: '',
      start: -1,
      text: '',
      committed: '',
      preview: '',
      boundary: 0,
      phraseStart: 0,
      inflight: false,
      controller: null,
      timer: 0,
      tickAt: 0,
      startedAt: 0,
      previewFails: 0,
      passes: { preview: 0, commit: 0 },
      rewritten: false,
    },
  }

  /** 录音失败的统一话术（浏览器抛的是 DOMException，用户看不懂）。 */
  var VOICE_ERRORS = {
    unavailable: '当前浏览器不支持录音，请使用支持麦克风的浏览器。',
    permission: '麦克风权限未开启，请在浏览器和系统设置中允许访问。',
    missing: '没有找到麦克风设备。',
    interrupted: '录音中断，请重试。',
    empty: '未识别到语音',
    cancelled: '已取消语音输入。',
  }

  function voiceError(kind, extra) {
    var error = /** @type {Error & { voiceKind?: string }} */ (new Error(VOICE_ERRORS[kind] || '录音失败'))
    error.voiceKind = kind
    if (extra) error.cause = extra
    return error
  }

  /** 出错信息 → 一句人话。 */
  function voiceMessageOf(error) {
    if (!error) return '未知错误'
    if (error.voiceKind) return VOICE_ERRORS[error.voiceKind] || '录音失败'
    return String(error.message || error)
  }

  /**
   * 状态行文案：
   * @param text 文案
   * @param {{ dot?: boolean, tone?: string }} options 状态行显示选项
   */
  function setVoiceActivity(text, options) {
    var opts = options || {}
    env.voiceActivityText.textContent = String(text || '')
    env.voiceActivity.setAttribute('data-tone', opts.tone || '')
    env.voiceDot.style.display = opts.dot ? '' : 'none'
  }

  /** 行内动作位：'prepare'（准备模型文字键）/ null（用 🎤 重录）/ 'none'（什么都不要）。 */
  function setVoiceAction(kind) {
    while (env.voiceActionSlot.firstChild) env.voiceActionSlot.removeChild(env.voiceActionSlot.firstChild)
    voice.action = kind || null
    if (kind === 'prepare') {
      var prepareBtn = el('button', 'dsh-sel-vact', '准备模型')
      prepareBtn.type = 'button'
      prepareBtn.title = '在本机下载并准备识别模型（首次要下载，之后一直可用）'
      listen(prepareBtn, 'click', function (event) {
        event.stopPropagation()
        prepareVoice()
      })
      env.voiceActionSlot.appendChild(prepareBtn)
      return prepareBtn
    }
    if (kind === 'retry') {
      var retryMic = el('button', 'dsh-sel-round')
      retryMic.type = 'button'
      retryMic.setAttribute('aria-label', '重新录音')
      retryMic.title = '重新录音'
      retryMic.appendChild(micIcon())
      listen(retryMic, 'click', function (event) {
        event.stopPropagation()
        startVoice()
      })
      env.voiceActionSlot.appendChild(retryMic)
      return retryMic
    }
    return null
  }

  /**
   * 出错/提示：录音行里给一句原因 +（有救的）一个动作。`retryable` 为真时给 🎤 重录键。
   * 这是主会话的 feedback 阶段：它就一直停在那儿，直到用户点 ✕（或行内动作）。
   */
  function voiceFeedback(text, tone, action) {
    voice.phase = 'feedback'
    setVoiceActivity(text, { tone: tone || '' })
    setVoiceAction(action)
    paintVoice()
  }

  /** 按状态摆好录音行：idle 显 🎤，其余显录音行（✕ / 波形或文案 / ■ 或行内动作）。 */
  function paintVoice() {
    var phase = voice.phase
    var capturing = phase !== 'idle'
    env.captureRow.setAttribute('data-show', capturing ? '1' : '0')
    env.captureRow.style.display = capturing ? 'flex' : 'none'
    // 工具行也标记一下：录音时 flex-wrap 锁死（发送键必须还在这一行）
    env.askTools.setAttribute('data-capturing', capturing ? '1' : '0')
    // 录音行出现时，工具行左边那三样（输出偏好 / 模型 / 🎤）让位——和主会话一样，
    // 录音时那行只讲一件事：怎么结束、结束之后会得到什么。
    env.webMode.style.display = capturing ? 'none' : ''
    env.askSpacer.style.display = capturing ? 'none' : ''
    env.modelPill.style.display = capturing ? 'none' : ''
    env.micButton.style.display = capturing ? 'none' : ''
    // 中间那格：录音时是波形，其余是文案；■ 只在录音时出现
    var recording = phase === 'recording'
    env.waveSvg.style.display = recording ? '' : 'none'
    env.voiceActivity.style.display = recording ? 'none' : 'flex'
    env.voiceStop.style.display = recording ? 'inline-grid' : 'none'
    env.voiceCancel.title = phase === 'feedback' ? '关闭（Esc）' : '取消这次语音（Esc，已经说出来的字留着）'
    env.voiceCancel.setAttribute('aria-label', env.voiceCancel.title)
    // 🎤 触发键的状态：只在"请求权限"时转圈（其余都是普通图标 —— 和主会话一致）
    env.micButton.setAttribute('data-state', phase === 'requesting' ? 'requesting' : 'idle')
    env.micButton.setAttribute('aria-pressed', capturing ? 'true' : 'false')
    env.micButton.title = '语音输入（点一下开始说，再点一下结束并转成文字）'
  }

  /** 识别器：目录里默认那个（没有就第一个）。 */
  function voiceProvider(catalog) {
    if (!catalog || !catalog.providers || !catalog.providers.length) return null
    var id = catalog.selection && catalog.selection.providerId
    for (var i = 0; i < catalog.providers.length; i += 1) {
      if (catalog.providers[i].id === id) return catalog.providers[i]
    }
    return catalog.providers[0]
  }

  /** 目录（有哪些识别器、能不能录、能录多久）：短暂缓存，别每点一次都问一遍 host。 */
  function fetchSpeechCatalog(force) {
    var now = Date.now()
    if (!force && voice.catalog && now - voice.catalogAt < VOICE_CATALOG_TTL) {
      return Promise.resolve(voice.catalog)
    }
    return fetch(SPEECH_API)
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        voice.catalog = data
        voice.catalogAt = Date.now()
        return data
      })
  }

  /**
   * 波形推进一帧（算法照抄主会话的 Waveform）：
   * 新的电平从右边挤进来，整排往左推；静音时每条线只有 2px 高 —— 就是那条虚线。
   * @param level 本帧电平（0 = 不采样，只把尺寸摆正）
   */
  function repaintWave(level) {
    var next = level
    for (var i = 0; i < env.waveBars.length; i += 1) {
      var bar = env.waveBars[i]
      var previous = bar.level
      bar.level = next
      next = previous
      var height = 1 + Math.min(1, bar.level * 5) * 17
      bar.node.setAttribute('y1', String(20 - height))
      bar.node.setAttribute('y2', String(20 + height))
    }
  }

  /** 把波形清回静音基线（新一次录音从头开始画；主会话是重建 SVG，效果一样）。 */
  function resetWave() {
    for (var i = 0; i < env.waveBars.length; i += 1) {
      env.waveBars[i].level = 0
      env.waveBars[i].node.setAttribute('y1', '19')
      env.waveBars[i].node.setAttribute('y2', '21')
    }
  }

  function stopWaveLoop() {
    if (voice.waveFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(voice.waveFrame)
    voice.waveFrame = 0
    voice.waveAt = 0
  }

  /** 录音时的波形循环：50ms 采一次音量（和主会话同一个节拍）。 */
  function startWaveLoop() {
    stopWaveLoop()
    if (typeof requestAnimationFrame !== 'function') return
    var draw = function (now) {
      if (voice.phase !== 'recording') return
      // rAF 会给时间戳，但不是所有环境都给（桩、老实现）——缺了就用当前时间，别让波形卡住
      var at = typeof now === 'number' ? now : Date.now()
      if (at - voice.waveAt >= 50) {
        voice.waveAt = at
        var level = 0
        try {
          level = voice.capture ? voice.capture.level() : 0
        } catch (error) {
          level = 0
        }
        voice.level = level
        repaintWave(level)
      }
      voice.waveFrame = requestAnimationFrame(draw)
    }
    voice.waveFrame = requestAnimationFrame(draw)
  }

  function stopVoiceTicker() {
    if (voice.ticker) clearInterval(voice.ticker)
    voice.ticker = 0
    voice.lastClock = -1
    stopWaveLoop()
  }

  /**
   * 一次录音的全部资源：麦克风流、MediaRecorder、AudioContext、分析器。
   *
   * 这几个东西**必须一起释放**：只停 MediaRecorder 的话，标签页上会一直挂着
   * "正在使用麦克风"的标识（用户会以为在偷听），AudioContext 也会一直占着音频线程。
   */
  function createCapture(onError) {
    var stream = null
    var recorder = null
    var context = null
    var analyser = null
    var samples = new Float32Array(256)
    var chunks = []
    var lifetime = new AbortController()
    var disposal = null
    // ── 采样水龙头（实时字幕用）──
    var tap = null
    var tapGain = null
    /** 16k 采样的分片表（按时序），tapLength 是总采样数。 */
    var tapChunks = []
    var tapLength = 0
    /** 线性重采样的分数位置：跨回调连续，接缝处才不会每 93ms 丢一个点。 */
    var tapPos = 0
    /** 最近一次"有声"的采样位置与墙钟时间（停顿定稿靠它切边界）。 */
    var tapLoudIndex = -1
    var tapLoudAt = 0

    /** 把一块原始采样（context 采样率）重采样到 16k 攒起来，同时判"有声/静音"。 */
    function acceptChunk(input) {
      var rate = context && context.sampleRate ? context.sampleRate : 48000
      var step = rate / 16000
      var out = []
      var pos = tapPos
      while (pos + 1 < input.length) {
        var index = Math.floor(pos)
        var frac = pos - index
        out.push(input[index] * (1 - frac) + input[index + 1] * frac)
        pos += step
      }
      tapPos = pos - input.length
      if (out.length) {
        var piece = Float32Array.from(out)
        tapChunks.push(piece)
        tapLength += piece.length
      }
      var sum = 0
      for (var i = 0; i < input.length; i += 1) sum += input[i] * input[i]
      if (Math.sqrt(sum / input.length) >= VOICE_SILENCE_RMS) {
        tapLoudIndex = tapLength
        tapLoudAt = Date.now()
      }
    }

    /** 取 [from, to) 的 16k 采样（越界自动夹住）。 */
    function readSamples(from, to) {
      var a = Math.max(0, Math.floor(from))
      var b = Math.min(tapLength, Math.ceil(to))
      if (b <= a) return new Float32Array(0)
      var out = new Float32Array(b - a)
      var cursor = 0
      for (var i = 0; i < tapChunks.length; i += 1) {
        var piece = tapChunks[i]
        var end = cursor + piece.length
        if (end > a && cursor < b) {
          var s = Math.max(0, a - cursor)
          var e = Math.min(piece.length, b - cursor)
          out.set(piece.subarray(s, e), cursor + s - a)
        }
        cursor = end
        if (cursor >= b) break
      }
      return out
    }

    function release() {
      try {
        lifetime.abort()
      } catch (error) {
        /* noop */
      }
      if (tap) {
        try {
          tap.onaudioprocess = null
          tap.disconnect()
        } catch (error) {
          /* noop */
        }
      }
      if (tapGain) {
        try {
          tapGain.disconnect()
        } catch (error) {
          /* noop */
        }
      }
      try {
        if (recorder && recorder.state === 'recording') recorder.stop()
      } catch (error) {
        /* noop */
      }
      if (stream) {
        var tracks = stream.getTracks ? stream.getTracks() : []
        for (var i = 0; i < tracks.length; i += 1) {
          try {
            tracks[i].stop()
          } catch (error) {
            /* noop */
          }
        }
      }
      if (context && typeof context.close === 'function') {
        try {
          context.close()
        } catch (error) {
          /* noop */
        }
      }
      return Promise.resolve()
    }

    function dispose() {
      if (!disposal) disposal = release()
      return disposal
    }

    /** decodeAudioData：新浏览器返回 Promise，老 Safari 只认回调 —— 两种都接住。 */
    function decode(buffer) {
      return new Promise(function (resolve, reject) {
        var pending = context.decodeAudioData(buffer, resolve, reject)
        if (pending && typeof pending.then === 'function') pending.then(resolve, reject)
      })
    }

    return {
      /** 拿麦克风并开始录（权限弹窗可能很久，晚到的授权要能作废）。 */
      start: function () {
        var devices = navigator.mediaDevices
        if (!devices || typeof devices.getUserMedia !== 'function' || typeof window.MediaRecorder === 'undefined') {
          return Promise.reject(voiceError('unavailable'))
        }
        return devices
          .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
          .then(
            function (got) {
              stream = got
              if (lifetime.signal.aborted) {
                var granted = got.getTracks ? got.getTracks() : []
                for (var i = 0; i < granted.length; i += 1) granted[i].stop()
                throw voiceError('cancelled')
              }
              var Ctx = window.AudioContext || window.webkitAudioContext
              try {
                context = new Ctx()
                // 没有用户手势时浏览器会把 AudioContext 挂起：波形要动就得唤醒它
                if (context.state === 'suspended' && typeof context.resume === 'function') {
                  var resumed = context.resume()
                  if (resumed && typeof resumed.catch === 'function') resumed.catch(function () {})
                }
                analyser = context.createAnalyser()
                analyser.fftSize = samples.length
                var source = context.createMediaStreamSource(stream)
                source.connect(analyser)
                // 原始采样水龙头（只服务于实时字幕）：
                // MediaRecorder 那条路不变，最终那份规范 WAV 还是它出的；这里多接一路，
                // 直接把麦克风的采样按 16k 攒起来 —— 切窗口时不用每个 tick 去 decode 整个 blob。
                // ScriptProcessorNode 已废弃但仍在（实测 Chrome 153 可用）；没有就关掉实时层。
                try {
                  if (typeof context.createScriptProcessor === 'function') {
                    tap = context.createScriptProcessor(4096, 1, 1)
                    tapGain = context.createGain()
                    tapGain.gain.value = 0 // 静音：别把麦克风回灌到扬声器（会啸叫）
                    tap.onaudioprocess = function (event) {
                      var input = event && event.inputBuffer ? event.inputBuffer.getChannelData(0) : null
                      if (input) acceptChunk(input)
                    }
                    source.connect(tap)
                    tap.connect(tapGain)
                    tapGain.connect(context.destination)
                  }
                } catch (error) {
                  tap = null
                }
                recorder = new window.MediaRecorder(stream)
                recorder.ondataavailable = function (event) {
                  if (!lifetime.signal.aborted && event.data && event.data.size > 0) chunks.push(event.data)
                }
                recorder.onerror = function () {
                  if (lifetime.signal.aborted) return
                  dispose()
                  if (onError) onError(voiceError('interrupted'))
                }
                recorder.start()
                return true
              } catch (error) {
                return dispose().then(function () {
                  throw error
                })
              }
            },
            function (error) {
              if (error && error.name === 'NotAllowedError') throw voiceError('permission')
              if (error && error.name === 'NotFoundError') throw voiceError('missing')
              throw error
            },
          )
      },

      /** 实时音量（0..1 左右）：只用来驱动波形。 */
      level: function () {
        if (!analyser) return 0
        try {
          analyser.getFloatTimeDomainData(samples)
        } catch (error) {
          return 0
        }
        var sum = 0
        for (var i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
        return Math.sqrt(sum / samples.length)
      },

      /**
       * 结束录音 → 规范 WAV。
       * 重采样交给 OfflineAudioContext（浏览器自带的重采样质量比自己写的线性插值好得多），
       * 采样率固定 16kHz —— host 只收这一种（见 host 的 validateWave）。
       */
      stop: function (maxSeconds) {
        return new Promise(function (resolve, reject) {
          if (!recorder || !context || recorder.state !== 'recording') {
            dispose().then(function () {
              reject(voiceError('empty'))
            })
            return
          }
          var settled = false
          function giveUp(error) {
            if (settled) return
            settled = true
            dispose().then(function () {
              reject(error)
            })
          }
          recorder.onstop = function () {
            if (settled) return
            settled = true
            var blob
            try {
              var tracks = stream && stream.getTracks ? stream.getTracks() : []
              for (var i = 0; i < tracks.length; i += 1) tracks[i].stop()
              blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
              if (!blob.size) throw voiceError('empty')
            } catch (error) {
              dispose().then(function () {
                reject(error)
              })
              return
            }
            blob
              .arrayBuffer()
              .then(function (buffer) {
                return decode(buffer)
              })
              .then(function (decoded) {
                if (lifetime.signal.aborted) throw voiceError('cancelled')
                var rate = 16000
                var seconds = Math.min(decoded.duration || 0, maxSeconds)
                var frames = Math.max(1, Math.floor(seconds * rate))
                var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext
                var offline = new Offline(1, frames, rate)
                var source = offline.createBufferSource()
                source.buffer = decoded
                source.connect(offline.destination)
                source.start()
                return offline.startRendering()
              })
              .then(function (rendered) {
                return encodeWave(rendered.getChannelData(0))
              })
              .then(resolve, function (error) {
                reject(error)
              })
          }
          recorder.onerror = function () {
            giveUp(voiceError('empty'))
          }
          try {
            recorder.stop()
          } catch (error) {
            giveUp(error)
          }
        }).then(
          function (bytes) {
            return dispose().then(function () {
              return bytes
            })
          },
          function (error) {
            return dispose().then(function () {
              throw error
            })
          },
        )
      },

      dispose: dispose,
      /** 实时字幕的水龙头：没接上（浏览器没有 ScriptProcessor）时为 null。 */
      tap: {
        supported: function () {
          return !!tap
        },
        length: function () {
          return tapLength
        },
        loudIndex: function () {
          return tapLoudIndex
        },
        loudAt: function () {
          return tapLoudAt
        },
        read: readSamples,
        /** 自检/单测用：直接喂一块原始采样（真浏览器里由 onaudioprocess 调）。 */
        accept: acceptChunk,
      },
    }
  }

  /** 录音中的心跳：到点自动收尾 + 记一次电平（波形另有自己的 50ms 循环）。 */
  /** 录音开始时把光标交给输入框：预览落字时光标要在末尾跳（textarea 没焦点就不显示光标）。 */
  function focusAskForRecording() {
    env.focusAskBox()
  }

  function startVoiceTicker() {
    stopVoiceTicker()
    voice.ticker = setInterval(function () {
      if (voice.phase !== 'recording') return
      var elapsed = Date.now() - voice.startedAt
      var limit = voice.maxSeconds || VOICE_FALLBACK_SECONDS
      if (elapsed >= limit * 1000) {
        finishVoice()
        return
      }
      voice.lastClock = Math.floor(elapsed / 1000)
    }, 200)
    startWaveLoop()
  }

  /** 识别出来的文字 → 输入框（插在光标处，前后补空格，光标落在末尾，接着还能打字）。 */
  function insertTranscript(text) {
    var current = String(env.askBox.value || '')
    var start = typeof env.askBox.selectionStart === 'number' && env.askBox.selectionStart >= 0 ? env.askBox.selectionStart : current.length
    var end = typeof env.askBox.selectionEnd === 'number' && env.askBox.selectionEnd >= start ? env.askBox.selectionEnd : start
    var before = current.slice(0, start)
    var after = current.slice(end)
    var prefix = before && !/\s$/.test(before) ? ' ' : ''
    var suffix = after && !/^\s/.test(after) ? ' ' : ''
    env.askBox.value = before + prefix + text + suffix + after
    var caret = (before + prefix + text).length
    try {
      env.askBox.setSelectionRange(caret, caret)
    } catch (error) {
      /* 桩环境没有这个方法 */
    }
    try {
      env.askBox.focus()
    } catch (error) {
      /* noop */
    }
    voice.lastText = text
    env.refreshAskState()
    return env.askBox.value
  }

  function failVoice(generation, error) {
    if (generation !== voice.generation) return
    voice.generation += 1
    var capture = voice.capture
    voice.capture = null
    stopVoiceTicker()
    if (capture) capture.dispose()
    // "用户取消"不是错（点了 ✕、收了小窗、插件停用都走这里），不给错误提示
    var kind = error && error.voiceKind
    if (kind === 'cancelled') {
      resetVoiceRow()
      return
    }
    // 没听清 / 中断 / 失败：留在 feedback 里给原因 + 🎤 重录（和主会话一致）
    voiceFeedback(voiceMessageOf(error), kind === 'empty' || kind === 'interrupted' ? 'warn' : 'error', 'retry')
  }

  /** 回到 idle：工具行原样还回去。 */
  function resetVoiceRow() {
    stopVoiceTicker()
    stopLive()
    if (voice.idleTimer) clearTimeout(voice.idleTimer)
    voice.idleTimer = 0
    voice.phase = 'idle'
    voice.action = null
    while (env.voiceActionSlot.firstChild) env.voiceActionSlot.removeChild(env.voiceActionSlot.firstChild)
    setVoiceActivity('', {})
    paintVoice()
  }

  // ── 实时字幕（半句预览 + 停顿定稿）──────────────────────────────────────
  //
  // 说话时字就往输入框里长：每 ~1.3s 把"还没定稿的这半句"送去识别一次，整段替换上一拍
  // 的预览；检测到 ~0.6s 静音（这句说完了）就把这句送去识别并**定稿**，之后不再变。
  // 停止（■）时仍然走原来那条"整段规范 WAV"的路，回来的结果给这一整段收口：
  //   · 整段识别**以已定稿的文字开头**（正常情况）→ 只补后半句，定稿的字一个不动；
  //   · 对不上（整段上下文让引擎改了前面）→ 以整段为准整块替换，并在自检里记一笔。
  // ✕ 取消 = 把这次插进去的文字整块撤掉（对应主会话那个 aria-label「丢弃识别文字」）。
  //
  // 为什么预览用**采样水龙头**而不是 MediaRecorder 的 blob：切窗口只要一段连续采样，
  // 而每个 tick 去 decode 整个 blob 是 O(总时长) 的白活（说到 60 秒就是每秒 decode 60 秒音频）。

  /** 定稿与预览拼起来时的连接处（中文直接接，英文补一个空格）。 */
  function liveJoin(left, right) {
    if (!left) return right
    if (!right) return left
    if (/[\s]$/.test(left) || /^[\s，。；：！？、,.!?;:]/.test(right)) return left + right
    return left + ' ' + right
  }

  /** 光标位置（拿不到就当作末尾）。 */
  function caretIndex() {
    var value = String(env.askBox.value || '')
    return typeof env.askBox.selectionStart === 'number' && env.askBox.selectionStart >= 0
      ? Math.min(env.askBox.selectionStart, value.length)
      : value.length
  }

  /** 这一段（分隔空格 + 定稿 + 预览）在输入框里该长什么样。 */
  function liveCompose() {
    var live = voice.live
    var body = liveJoin(live.committed, live.preview)
    live.text = body ? live.separator + body : ''
    return live.text
  }

  /**
   * 把这一段落到输入框里（原位替换）。
   * 用户在我们这段**里面**改过字就不抢他的编辑：停掉实时层，以后按"停止后再出字"走。
   */
  function liveWrite() {
    var live = voice.live
    var value = String(env.askBox.value || '')
    var previous = live.text
    var start = live.start
    if (previous) {
      if (value.indexOf(previous) >= 0) start = value.indexOf(previous)
      else if (start >= 0 && value.slice(start, start + previous.length) === previous) {
        /* 位置没变 */
      } else {
        live.disabled = true
        live.reason = 'edited'
        stopLive()
        return false
      }
    }
    if (start < 0) start = caretIndex()
    var end = previous ? start + previous.length : start
    var caret = typeof env.askBox.selectionStart === 'number' ? env.askBox.selectionStart : end
    // 光标原本就贴在这段文字的末尾（= 用户没在改这段，只是在看）→ 跟着最新文字走，
    // 这样光标一直在新冒出来的字后面跳；用户把光标挪到别处（或在后面打字）就原位保留。
    var atBlockEnd = previous ? caret === end : caret === start
    var next = liveCompose()
    env.askBox.value = value.slice(0, start) + next + value.slice(end)
    live.start = next ? start : -1
    live.text = next
    var moved = next.length - previous.length
    var nextCaret = atBlockEnd ? start + next.length : caret > end ? caret + moved : caret
    if (nextCaret < 0) nextCaret = 0
    if (nextCaret > env.askBox.value.length) nextCaret = env.askBox.value.length
    try {
      env.askBox.setSelectionRange(nextCaret, nextCaret)
    } catch (error) {
      /* 桩环境没有这个方法 */
    }
    env.refreshAskState()
    return true
  }

  function stopLive() {
    var live = voice.live
    live.active = false
    live.inflight = false
    if (live.timer) clearInterval(live.timer)
    live.timer = 0
    if (live.controller) {
      try {
        live.controller.abort()
      } catch (error) {
        /* noop */
      }
    }
    live.controller = null
  }

  /** 开实时层（拿不到采样水龙头就不开：功能退回"说完点 ■ 再出字"）。 */
  function startLive(capture) {
    var live = voice.live
    stopLive()
    live.committed = ''
    live.preview = ''
    live.text = ''
    live.start = -1
    live.inflight = false
    live.passes = { preview: 0, commit: 0 }
    live.rewritten = false
    live.disabled = false
    live.reason = ''
    if (!capture || !capture.tap || !capture.tap.supported()) {
      live.disabled = true
      live.reason = 'no-tap'
      return false
    }
    // 云端识别器：每一拍都是一次**付费**调用（1.3 秒一拍 ≈ 46 次/分钟），不做预览。
    // 本机模型不花钱、只占点 CPU，才是实时字幕该待的地方。
    var provider = voiceProvider(voice.catalog)
    if (provider && provider.location === 'cloud') {
      live.disabled = true
      live.reason = 'cloud'
      return false
    }
    // 我们这段文字从**当前光标处**开始长；前面不是空白就补一个分隔空格
    var value = String(env.askBox.value || '')
    var caret = caretIndex()
    live.separator = caret > 0 && !/\s$/.test(value.slice(0, caret)) ? ' ' : ''
    live.start = -1
    live.boundary = capture.tap.length()
    live.phraseStart = live.boundary
    live.startedAt = Date.now()
    live.tickAt = 0
    live.active = true
    live.timer = setInterval(liveTick, 200)
    return true
  }

  /**
   * 送一段（16k 采样，[from,to)）去识别。
   * **"没听清"不是故障**：停顿那几秒里窗口是纯静音，识别本来就该返回空
   *（曾经把空结果当失败计数，连挂 3 次就把整个实时层关了 —— 表现是"只跟第一句，后面不吐字"）。
   * @returns 识别到的文字（可能是 ''）
   */
  function liveSend(from, to) {
    var live = voice.live
    var capture = voice.capture
    if (!capture || !capture.tap) return Promise.reject(new Error('没有采样水龙头'))
    var samples = capture.tap.read(from, to)
    if (samples.length < 1600) return Promise.reject(new Error('这段太短了'))
    var controller = typeof AbortController === 'function' ? new AbortController() : null
    live.controller = controller
    return fetch(SPEECH_TRANSCRIBE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: bytesToBase64(encodeWave(samples)), partial: true }),
      signal: controller ? controller.signal : undefined,
    })
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        if (data && data.ok === true) return String(data.text || '').trim()
        if (data && data.code === 'empty-transcript') return ''
        throw new Error(String((data && data.error) || '识别失败'))
      })
  }

  /** 一句话说完了（静音够久）：把它送去识别并定稿。 */
  function liveCommit(boundary) {
    var live = voice.live
    var from = live.phraseStart
    var to = Math.min(boundary, from + 16000 * VOICE_COMMIT_MAX_SECONDS)
    if (to - from < 1600) return
    live.inflight = true
    live.passes.commit += 1
    liveSend(from, to)
      .then(function (text) {
        if (!live.active) return
        live.previewFails = 0
        if (text) {
          live.committed = liveJoin(live.committed, text)
          live.preview = ''
          liveWrite()
        }
        live.boundary = to
        live.phraseStart = to
      })
      .catch(function () {
        /* 这一句没转出来：不打断录音，等停止时整段再试一次 */
      })
      .then(function () {
        live.inflight = false
        live.controller = null
      })
  }

  /**
   * 半句预览：把"最后 10 秒还没定稿的那半句"送去识别，整段替换上一拍的预览。
   * @returns 这一拍真的发出去了没有（没发就不该吃掉节流窗口 —— 否则录到 0.2 秒时那次空转
   *          会把第一拍预览推到 1.5 秒之后，用户会觉得"怎么半天不出字"）。
   */
  function livePreview() {
    var live = voice.live
    var capture = voice.capture
    if (!capture || !capture.tap) return false
    // 上次定稿之后还没开口（一直是静音）→ 不浪费调用，也别把上一拍预览抹掉
    var loudIndex = capture.tap.loudIndex()
    if (loudIndex < 0 || loudIndex <= live.phraseStart) return false
    var length = capture.tap.length()
    var from = Math.max(live.phraseStart, length - 16000 * VOICE_PREVIEW_WINDOW)
    if (length - from < 16000 * 0.5) return false
    live.inflight = true
    live.passes.preview += 1
    liveSend(from, length)
      .then(function (text) {
        if (!live.active) return
        live.previewFails = 0
        if (text === live.preview) return
        // 这一拍没识别到内容（窗口里正好都是静音）：留着上一拍的预览，别闪没
        if (!text) return
        live.preview = text
        liveWrite()
      })
      .catch(function (error) {
        if (!live.active) return
        // 预览连续失败就不再打扰用户（停止时那条路仍然会出字）；
        // 阈值给宽一点：偶发一次超时不该把实时字幕整个关掉
        if (error && error.name === 'AbortError') return
        live.previewFails = (live.previewFails || 0) + 1
        if (live.previewFails >= 5) {
          live.disabled = true
          live.reason = 'preview-failed'
          stopLive()
        }
      })
      .then(function () {
        live.inflight = false
        live.controller = null
      })
    return true
  }

  /** 实时层的节拍：先看有没有"一句话说完了"，再看要不要刷半句预览。 */
  function liveTick() {
    var live = voice.live
    if (!live.active || live.disabled || voice.phase !== 'recording') return
    var capture = voice.capture
    if (!capture || !capture.tap || !capture.tap.supported()) return
    if (live.inflight) return
    var now = Date.now()
    var length = capture.tap.length()
    var loudIndex = capture.tap.loudIndex()
    var loudAt = capture.tap.loudAt()
    // ① 停顿定稿：最近一次有声已经过去 600ms 以上，且这句够长
    if (loudIndex >= 0 && now - loudAt >= VOICE_PAUSE_MS && now - loudAt < 5000) {
      var boundary = Math.min(length, loudIndex + Math.round(16000 * 0.25))
      if (boundary - live.phraseStart >= (16000 * VOICE_PAUSE_MIN_MS) / 1000) {
        live.pendingReady = true
        liveCommit(boundary)
        return
      }
    }
    // ② 半句预览：每 1.3 秒刷一次（只有真发出去才算用掉这一拍）
    if (now - live.tickAt < VOICE_PREVIEW_EVERY) return
    if (livePreview()) live.tickAt = now
  }

  /**
   * ■ 停止后的收口：整段识别已经拿到 fullText，把它和已经插进去的那段对齐。
   * 正常情况（整段以定稿开头）只补后半句；对不上就整块替换（以整段为准）。
   */
  function liveFinalize(fullText) {
    var live = voice.live
    var committed = live.committed
    var text = String(fullText || '').trim()
    stopLive()
    if (!text) {
      // 整段一个都没识别出来：已经定稿的部分留着（用户看得见），预览丢掉
      live.preview = ''
      liveWrite()
      return live.committed
    }
    var merged = text
    if (committed) {
      var rest = liveTailAfterCommitted(committed, text)
      if (rest === null) {
        live.rewritten = true
        merged = text
      } else {
        merged = liveJoin(committed, rest)
      }
    }
    live.committed = merged
    live.preview = ''
    liveWrite()
    return merged
  }

  /**
   * 整段识别里"已定稿那部分"之后还剩什么。
   * 归一化（去空白与标点）之后比前缀：对得上 → 返回剩余原文；对不上 → null。
   */
  function liveTailAfterCommitted(committed, full) {
    var norm = function (text) {
      var out = []
      for (var i = 0; i < text.length; i += 1) {
        var ch = text[i]
        if (/[\s，。；：！？、,.!?;:'"（）()\[\]【】…—-]/.test(ch)) continue
        out.push({ ch: ch, at: i })
      }
      return out
    }
    var want = norm(committed)
    var got = norm(full)
    if (!want.length || got.length < want.length) return null
    for (var i = 0; i < want.length; i += 1) {
      if (want[i].ch !== got[i].ch) return null
    }
    return full.slice(got[want.length - 1].at + 1).trim()
  }

  /** 开始一段录音（先问 host 要目录：能不能录、最长多久）。 */
  function startVoice() {
    if (!recordingSupported()) {
      voiceFeedback(VOICE_ERRORS.unavailable, 'error', null)
      return
    }
    var generation = ++voice.generation
    voice.phase = 'requesting'
    setVoiceActivity('请允许使用麦克风…', { dot: true })
    setVoiceAction(null)
    paintVoice()
    fetchSpeechCatalog(true)
      .then(function (catalog) {
        if (generation !== voice.generation) return null
        if (!catalog || catalog.available !== true) {
          var provider = voiceProvider(catalog)
          var reason = catalog ? catalog.reason : ''
          var text =
            reason === 'unprepared' || (provider && provider.phase !== 'ready' && provider.phase !== 'standby')
              ? '语音模型还没准备好' + (provider && provider.name ? '（' + provider.name + '）' : '')
              : catalog && catalog.error
                ? catalog.error
                : '这个部署没有可用的语音识别服务'
          // 有救的（模型没装）给一个「准备模型」按钮：下载在 host 上跑，几百 MB 到 1G，得用户自己点
          voiceFeedback(text, 'warn', provider ? 'prepare' : 'retry')
          return null
        }
        var limits = catalog.limits || {}
        voice.maxSeconds = clamp(Number(limits.maxSeconds) || VOICE_FALLBACK_SECONDS, 5, 600)
        var capture = createCapture(function (error) {
          failVoice(generation, error)
        })
        voice.capture = capture
        return capture.start().then(function () {
          if (generation !== voice.generation) {
            capture.dispose()
            return null
          }
          voice.phase = 'recording'
          voice.startedAt = Date.now()
          resetWave()
          setVoiceActivity('', {})
          paintVoice()
          // 光标交给输入框：实时字幕落字时要看见光标在末尾跳（textarea 没焦点就不画光标）
          focusAskForRecording()
          startVoiceTicker()
          // 实时字幕：说话时字就往输入框里长（拿不到采样水龙头就自动退回"停止后出字"）
          startLive(capture)
          return true
        })
      })
      .catch(function (error) {
        failVoice(generation, error)
      })
  }

  /** 结束录音 → 送去识别 → 文字插进输入框。 */
  function finishVoice() {
    if (voice.phase !== 'recording') return
    var generation = voice.generation
    var capture = voice.capture
    var maxSeconds = voice.maxSeconds || VOICE_FALLBACK_SECONDS
    stopVoiceTicker()
    voice.phase = 'transcribing'
    setVoiceActivity('识别中…', { dot: true })
    setVoiceAction(null)
    paintVoice()
    var abort = typeof AbortController === 'function' ? new AbortController() : null
    voice.abort = abort
    capture
      .stop(maxSeconds)
      .then(function (bytes) {
        if (generation !== voice.generation) return null
        if (!bytes || !bytes.length) throw voiceError('empty')
        if (bytes.length > VOICE_MAX_BYTES) throw new Error('录音超过服务限制，请缩短录音后重试。')
        return fetch(SPEECH_TRANSCRIBE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audioBase64: bytesToBase64(bytes) }),
          signal: abort ? abort.signal : undefined,
        })
      })
      .then(function (response) {
        if (generation !== voice.generation || !response) return null
        return response.json().then(function (data) {
          if (generation !== voice.generation) return null
          if (!data || data.ok !== true) {
            var error = String((data && data.error) || '识别失败')
            if (data && data.code === 'unprepared') {
              voiceFeedback(error, 'warn', 'prepare')
            } else if (data && data.code === 'empty-transcript') {
              voiceFeedback(VOICE_ERRORS.empty, 'warn', 'retry')
            } else {
              voiceFeedback('语音识别失败：' + error, 'error', 'retry')
            }
            return null
          }
          var text = String(data.text || '').trim()
          var liveHasText = voice.live.active && !!(voice.live.committed || voice.live.preview || voice.live.text)
          if (!text) {
            if (liveHasText) {
              // 整段没转出来，但实时那几段已经落进输入框了：留着他看得见的那份
              voice.lastText = liveFinalize('')
              voice.capture = null
              voice.abort = null
              resetVoiceRow()
              return null
            }
            voiceFeedback(VOICE_ERRORS.empty, 'warn', 'retry')
            return null
          }
          if (liveHasText) {
            // 实时字幕已经在输入框里写了字：用它给整段收口（定稿部分尽量不动）
            voice.lastText = liveFinalize(text)
          } else {
            insertTranscript(text)
          }
          // 插入成功 = **直接回 idle**：文字就摆在上面那行，不必再报一次
          //（主会话也是这样：成功不额外说话，录音行收起、🎤 回位）。
          voice.capture = null
          voice.abort = null
          resetVoiceRow()
          return text
        })
      })
      .catch(function (error) {
        if (generation !== voice.generation) return
        // 用户点了 ✕ / 收起小窗：静默（这不是失败，是他自己不要了）
        if (error && error.name === 'AbortError') return
        var kind = error && error.voiceKind
        if (kind === 'cancelled') return
        if (kind === 'empty') {
          voiceFeedback(VOICE_ERRORS.empty, 'warn', 'retry')
          return
        }
        voiceFeedback('语音识别失败：' + voiceMessageOf(error), 'error', 'retry')
      })
      .then(function () {
        if (generation !== voice.generation) return
        voice.capture = null
        voice.abort = null
      })
  }

  /**
   * 取消当前这一轮（录音或识别）→ 回到 idle。✕ / Esc / 关面板 / 停用插件都走它。
   * 一定会松开麦克风、并且让晚到的回调全部作废（generation + 1）。
   */
  function cancelVoice(options) {
    if (!voice) return
    var opts = typeof options === 'string' ? { note: options } : options || {}
    var capture = voice.capture
    voice.generation += 1
    voice.capture = null
    if (voice.abort) {
      try {
        voice.abort.abort()
      } catch (error) {
        /* noop */
      }
    }
    voice.abort = null
    if (voice.pollTimer) clearTimeout(voice.pollTimer)
    voice.pollTimer = 0
    // 取消 = 只停（不再更新那段实时文字），**已经说出来的字一律留着**。
    // 早先跟着主会话的 ✕ 做过"丢弃识别文字"，实际用起来是"我按了取消，字没了" ——
    // 录到一半反悔时更常见的诉求是"留着我已经说出来的"，所以统一成都留。
    stopLive()
    if (capture) capture.dispose()
    resetVoiceRow()
    // 少数情况下要交代一句（例如"这条消息先发出去了"）：留在 feedback 里，2 秒后自己回 idle
    if (opts.note) {
      voiceFeedback(opts.note, '', null)
      voice.idleTimer = setTimeout(function () {
        if (voice.phase !== 'feedback') return
        resetVoiceRow()
      }, 2200)
    }
  }

  /** 让 host 去准备识别模型（首次要下载）；下载在 host 上跑，关掉面板也继续。 */
  function prepareVoice() {
    voice.phase = 'transcribing' // 复用"进行中"的形态：✕ + 呼吸点 + 文案
    setVoiceActivity('正在准备语音模型…', { dot: true })
    setVoiceAction(null)
    paintVoice()
    fetch(SPEECH_PREPARE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        if (!data || data.ok !== true) {
          voiceFeedback('准备失败：' + ((data && data.error) || '未知原因'), 'error', 'prepare')
          return
        }
        voice.catalog = data.catalog || null
        voice.catalogAt = 0 // 状态变了，下一次点击重新问 host
        pollPrepare(0)
      })
      .catch(function (error) {
        voiceFeedback('准备失败：' + voiceMessageOf(error), 'error', 'prepare')
      })
  }

  /** 轮询准备进度（下载在 host 上，这里只是播报）。 */
  function pollPrepare(round) {
    if (round > 480) return // 最多看 ~12 分钟，之后交给用户自己再来
    if (voice.pollTimer) clearTimeout(voice.pollTimer)
    voice.pollTimer = setTimeout(function () {
      fetchSpeechCatalog(true)
        .then(function (catalog) {
          if (catalog && catalog.available) {
            voiceFeedback('语音模型已就绪，可以开始说话', '', 'retry')
            return
          }
          var provider = voiceProvider(catalog)
          if (provider && provider.phase === 'failed') {
            voiceFeedback('准备失败：' + (provider.message || '模型下载出错'), 'error', 'prepare')
            return
          }
          var total = provider && provider.totalBytes ? provider.totalBytes : 0
          var done = provider && provider.completedBytes ? provider.completedBytes : 0
          var progress = total > 0 ? '（' + Math.round((done / total) * 100) + '%）' : ''
          setVoiceActivity('正在准备语音模型' + progress + '…（可以先去忙别的，下载在后台继续）', { dot: true })
          voice.phase = 'transcribing'
          paintVoice()
          pollPrepare(round + 1)
        })
        .catch(function () {
          pollPrepare(round + 1)
        })
    }, 1500)
  }
  return {
    cancelVoice,
    startVoice,
    get voice() { return voice },
    set voice(value) { voice = value },
    finishVoice,
    paintVoice,
    liveTick,
  }
}
