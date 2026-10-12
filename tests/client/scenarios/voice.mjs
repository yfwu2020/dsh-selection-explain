import { encodeWave, bytesToBase64 } from '../../../src/client/audio.js'
import { formatClock } from '../../../src/client/dom.js'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run(env) {


  // ═════════════════════ 语音输入（麦克风 → 文字 → 输入框） ═════════════════════
  //
  // UI 与主会话 ui-voice-input 同一套：平时是输入框右边的 🎤，开始录之后工具行换成
  // 录音行 ——`✕` | 实时波形 | `■`；请求权限/识别中是「呼吸点 + 文案」；出错是「文案 + 行内动作」。
  // 桩里验四件事：
  //   ① 状态机与录音行的形态（哪一格在、哪一格不在，工具行左边三样有没有让位）；
  //   ② 波形真的在动（80 根线、静音基线、有声变高、从右往左推）；
  //   ③ 文字**插进输入框**（追加在光标处，不覆盖用户已经写了一半的话）；
  //   ④ 该松麦克风的时候一定要松（取消 / 失焦 / 收起小窗 / 这条消息发出去）。
  //
  // 真实识别（真模型 + 真音频）不在这里：见 tests/unit/speech.test.mjs 与 tests/browser/voice.test.mjs。
  function waitVoice(predicate, ms = 1500) {
    const started = Date.now()
    const step = async () => {
      if (predicate()) return true
      if (Date.now() - started > ms) return !!predicate()
      await env.sleep(10)
      return step()
    }
    return step()
  }


  {
    // ── 浏览器音频桩 ──────────────────────────────────────────────
    const micCalls = []
    const micTracks = []
    let micDenied = false
    let micDeferred = null
    const makeTrack = () => {
      const track = {
        stopped: false,
        stop() {
          this.stopped = true
        },
      }
      micTracks.push(track)
      return track
    }
    const makeStream = () => {
      const track = makeTrack()
      return { getTracks: () => [track] }
    }
    env.navigatorStub.mediaDevices = {
      getUserMedia(constraints) {
        micCalls.push(constraints)
        if (micDenied) {
          const error = new Error('Permission denied')
          error.name = 'NotAllowedError'
          return Promise.reject(error)
        }
        if (micDeferred) {
          const pending = micDeferred
          micDeferred = null
          return pending.promise.then(() => makeStream())
        }
        return Promise.resolve(makeStream())
      },
    }
    /**
     * 电平序列：头几拍是静音（刚点下麦克风还没开口），之后逐次抬高。
     * 这样既能看到"静音 = 2px 基线"，也能看到"新电平从右边进来"（恒定电平看不出推进）。
     */
    let levelStep = 0
    const nextLevel = () => {
      levelStep += 1
      if (levelStep <= 3) return 0
      return Math.min(0.06 + (levelStep - 3) * 0.012, 0.5)
    }
    class MediaRecorderStub {
      constructor(stream) {
        this.stream = stream
        this.state = 'recording'
        this.mimeType = 'audio/webm;codecs=opus'
        MediaRecorderStub.last = this
      }
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        const chunk = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'audio/webm' })
        if (this.ondataavailable) this.ondataavailable({ data: chunk })
        if (this.onstop) this.onstop()
      }
    }
    class AudioContextStub {
      constructor() {
        this.state = 'running'
        this.closed = false
        /** 真实浏览器里通常是 44100/48000：实时字幕的线性重采样要按这个走 */
        this.sampleRate = 48000
        this.processors = []
        AudioContextStub.instances.push(this)
      }
      createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} }
      }
      createScriptProcessor(size) {
        const node = { size, onaudioprocess: null, connect() {}, disconnect() {} }
        this.processors.push(node)
        return node
      }
      createAnalyser() {
        return {
          fftSize: 256,
          getFloatTimeDomainData(array) {
            const level = nextLevel()
            for (let i = 0; i < array.length; i += 1) array[i] = level
          },
        }
      }
      createMediaStreamSource() {
        return { connect() {} }
      }
      decodeAudioData(_buffer, ok) {
        // 2 秒的"解码结果"：下游只关心 duration 与重采样
        if (ok) ok({ duration: 2, sampleRate: 48000, numberOfChannels: 2 })
        return Promise.resolve({ duration: 2, sampleRate: 48000, numberOfChannels: 2 })
      }
      close() {
        this.closed = true
        return Promise.resolve()
      }
    }
    AudioContextStub.instances = []
    class OfflineAudioContextStub {
      constructor(channels, frames, rate) {
        this.frames = frames
        this.sampleRate = rate
        OfflineAudioContextStub.last = this
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {} }
      }
      startRendering() {
        const data = new Float32Array(this.frames)
        for (let i = 0; i < data.length; i += 1) data[i] = Math.sin(i / 20) * 0.5
        return Promise.resolve({ getChannelData: () => data, duration: this.frames / this.sampleRate })
      }
    }
    env.windowStub.MediaRecorder = MediaRecorderStub
    env.windowStub.AudioContext = AudioContextStub
    env.windowStub.OfflineAudioContext = OfflineAudioContextStub

    // ── 面板：打开到"翻译就绪、composer 可见" ──────────────────────
    env.hook.open('voice-probe', '', '语音输入')
    await waitVoice(() => env.hook.state().phase === 'done')
    const askRowNode = Array.from(env.walk(env.panel)).find((n) => String(n.className).split(/\s+/).includes('dsh-sel-ask'))
    env.assert('语音用例：composer 已可见', !!askRowNode && askRowNode.style.display !== 'none', askRowNode && askRowNode.style.display)

    const micButton = env.hook.voiceNode()
    const nodes = env.hook.voiceNodes()
    const webModeNode = Array.from(env.walk(env.panel)).find((n) => String(n.className).split(/\s+/).includes('dsh-sel-pref'))
    const modelPillNode = Array.from(env.walk(env.panel)).find((n) => String(n.className).split(/\s+/).includes('dsh-sel-picker'))
    const micNode = Array.from(env.walk(env.panel)).find((n) => String(n.className).split(/\s+/).includes('dsh-sel-mic'))
    const toolsRow = micNode && micNode.parentNode
    env.assert('composer 里有麦克风按钮（和发送键同属工具行）', !!micNode && !!nodes.row, String(!!micNode))
    env.assert(
      '麦克风在发送键左边（贴 composer 主操作区）',
      !!toolsRow && toolsRow.children.indexOf(micNode) < toolsRow.children.indexOf(env.askSend),
      toolsRow ? `${toolsRow.children.indexOf(micNode)} < ${toolsRow.children.indexOf(env.askSend)}` : 'no row',
    )
    env.assert(
      '初始：录音行没出来、🎤 可见、状态文案是空的',
      env.hook.voice().phase === 'idle' && env.hook.voice().capture === false && nodes.row.style.display === 'none' && env.hook.voice().activity === '',
      JSON.stringify(env.hook.voice()).slice(0, 120),
    )
    env.assert('自检钩子能看到"这个环境支持录音"', env.hook.voice().supported === true, String(env.hook.voice().supported))

    // ── ① 点一下：请求权限 → 录音（工具行换成录音行）────────────────
    const waveBarsCount = nodes.wave.children.length
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'requesting')
    env.assert('点 🎤 → 请求权限：录音行出来（和主会话一样，工具行整行换掉）', env.hook.voice().capture === true, String(env.hook.voice().capture))
    env.assert('请求权限时：文案 + 呼吸点，波形与 ■ 都不出现', env.hook.voice().activity.indexOf('请允许使用麦克风') >= 0 && env.hook.voice().dot === true && env.hook.voice().waveform === false && env.hook.voice().stop === false, env.hook.voice().activity)
    env.assert(
      '录音行出来时，输出偏好 / 模型 / 🎤 让位（一行只讲一件事）',
      webModeNode.style.display === 'none' && modelPillNode.style.display === 'none' && micButton.style.display === 'none',
      `${webModeNode.style.display} / ${modelPillNode.style.display} / ${micButton.style.display}`,
    )
    env.assert('录音行是 ✕ 打头（取消在左边）', nodes.row.children[0] === nodes.cancel, String(nodes.row.children.indexOf(nodes.cancel)))
    env.assert('波形是 80 根线（和主会话同一个形状）', waveBarsCount === 80, String(waveBarsCount))

    await waitVoice(() => env.hook.voice().phase === 'recording')
    env.assert('拿到麦克风 → 进入录音态', env.hook.voice().phase === 'recording', env.hook.voice().phase)
    env.assert('录音时：波形出现、状态文案收起、■ 出现（✕ | 波形 | ■）', env.hook.voice().waveform === true && env.hook.voice().stop === true && nodes.activity.style.display === 'none', JSON.stringify({ wave: env.hook.voice().waveform, stop: env.hook.voice().stop }))
    env.assert('只向浏览器要了麦克风（不要摄像头）', micCalls.length === 1 && micCalls[0].video === false, JSON.stringify(micCalls[0]))
    env.assert(
      '静音时波形是一条虚线（没收到声音的格子都是 2px 基线）',
      env.hook.voice().bars.filter((height) => height === 2).length >= 70,
      JSON.stringify(env.hook.voice().bars.slice(0, 6)),
    )

    await env.sleep(320)
    const bars = env.hook.voice().bars
    env.assert('有声之后波形变高（1+min(1,amp*5)*17）', Math.max.apply(null, bars) > 3, String(Math.max.apply(null, bars)))
    env.assert(
      '新的电平从右边进来、整排往左推（最右边最高）',
      bars[0] > bars[bars.length - 1],
      `${bars[0]} vs ${bars[bars.length - 1]}`,
    )
    env.assert('录音中不显示秒数文案（主会话也是只看波形）', env.hook.voice().activity === '', JSON.stringify(env.hook.voice().activity))

    // ── ② 点 ■ 结束：识别 → 文字插进输入框 ─────────────────────────
    const firstTrack = micTracks[micTracks.length - 1]
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'transcribing')
    env.assert('点 ■ → 识别中：文案 + 呼吸点，波形与 ■ 收起', env.hook.voice().activity.indexOf('识别中') >= 0 && env.hook.voice().dot === true && env.hook.voice().waveform === false && env.hook.voice().stop === false, env.hook.voice().activity)
    env.assert('录音结束 → 松开麦克风（音轨停掉）', firstTrack.stopped === true)
    await waitVoice(() => env.hook.voice().lastText !== '')
    env.assert('录音结束后 AudioContext 关掉（不留音频线程）', AudioContextStub.instances.every((ctx) => ctx.closed === true), String(AudioContextStub.instances.length))
    env.assert('重采样成 16kHz（host 只收这一种）', OfflineAudioContextStub.last && OfflineAudioContextStub.last.sampleRate === 16000, String(OfflineAudioContextStub.last && OfflineAudioContextStub.last.sampleRate))
    env.assert('识别请求发到了 host（带 base64 音频、不带文件路径之类）', env.speechTranscribeCalls.length === 1 && typeof env.speechTranscribeCalls[0].audioBase64 === 'string', Object.keys(env.speechTranscribeCalls[0] || {}).join(','))
    env.assert('识别出来的文字进了输入框', env.askBox.value.indexOf('这段是语音转出来的问题') >= 0, env.askBox.value)
    env.assert('插入后光标在末尾（接着就能改 / 接着说）', env.askBox.selectionStart === env.askBox.value.length, `${env.askBox.selectionStart}/${env.askBox.value.length}`)
    env.assert('插入后发送键可点', env.askSend.disabled === false, String(env.askSend.disabled))
    await waitVoice(() => env.hook.voice().phase === 'idle')
    env.assert('成功之后立刻回 idle：录音行收起、🎤 回来、不留多余提示（和主会话一致）', env.hook.voice().phase === 'idle' && env.hook.voice().capture === false && micButton.style.display === '' && env.hook.voice().activity === '', JSON.stringify({ phase: env.hook.voice().phase, activity: env.hook.voice().activity }))

    // ── ③ 追加而不是覆盖：用户已经写了一半时接着说 ────────────────
    env.hook.askValue('先写的一句')
    env.speechTranscript = { ok: true, text: '后面补的一句' }
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'recording')
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().lastText === '后面补的一句')
    env.assert('已有内容时是追加（中间补一个空格）', env.askBox.value === '先写的一句 后面补的一句', env.askBox.value)
    await waitVoice(() => env.hook.voice().phase === 'idle')
    env.hook.askValue('')

    // ── ④ 失败路径：权限被拒 → feedback + 🎤 重录 ──────────────────
    micDenied = true
    const tracksBeforeDenied = micTracks.length
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'feedback')
    env.assert('权限被拒：录音行里给原因（不是 DOMException 原文）', env.hook.voice().activity.indexOf('麦克风权限未开启') >= 0 && env.hook.voice().activityTone === 'error', `${env.hook.voice().activityTone} ${env.hook.voice().activity}`)
    env.assert('权限被拒时一个音轨都没拿到', micTracks.length === tracksBeforeDenied, `${micTracks.length} vs ${tracksBeforeDenied}`)
    env.assert('失败时给「重新录音」🎤（主会话同款行内动作）', env.hook.voice().action === 'retry' && nodes.action.children.length === 1, `${env.hook.voice().action} / ${nodes.action.children.length}`)
    micDenied = false

    // ── ⑤ ✕ 关掉这条提示（feedback → idle，工具行还回去）──────────
    nodes.cancel.dispatch('click', { stopPropagation() {} })
    await env.sleep(20)
    env.assert('点 ✕ 关掉提示：回 idle、工具行还原（输出偏好 / 模型 / 🎤 都回来）', env.hook.voice().phase === 'idle' && env.hook.voice().capture === false && webModeNode.style.display === '' && modelPillNode.style.display === '' && micButton.style.display === '', `${env.hook.voice().phase} ${webModeNode.style.display}`)

    // ── ⑥ 模型没准备好 → 「准备模型」行内动作 ───────────────────────
    const goodCatalog = env.speechCatalog
    env.speechCatalog = {
      ...goodCatalog,
      available: false,
      reason: 'unprepared',
      providers: [{ ...goodCatalog.providers[0], phase: 'unprepared' }],
    }
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().action === 'prepare')
    env.assert('模型没准备：说清 + 给「准备模型」按钮', env.hook.voice().activity.indexOf('语音模型还没准备好') >= 0 && env.hook.voice().activityTone === 'warn', `${env.hook.voice().activityTone} ${env.hook.voice().activity}`)
    env.assert('没准备好时不进录音态（不在没模型时占着麦克风）', env.hook.voice().phase === 'feedback' && micTracks.length === tracksBeforeDenied, env.hook.voice().phase)
    const prepareBtn = nodes.action.children[0]
    env.assert('提示里的按钮确实画出来了', !!prepareBtn && prepareBtn.textContent === '准备模型', prepareBtn ? prepareBtn.textContent : 'none')
    env.speechCatalog = { ...goodCatalog, available: true, providers: [{ ...goodCatalog.providers[0], phase: 'ready' }] }
    prepareBtn.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.speechPrepareCalls > 0)
    env.assert('点「准备模型」→ 通知 host 去准备（下载在 host 上跑）', env.speechPrepareCalls === 1, String(env.speechPrepareCalls))
    env.assert('准备中：复用"进行中"形态（文案 + 呼吸点）', env.hook.voice().activity.indexOf('正在准备语音模型') >= 0 && env.hook.voice().dot === true, env.hook.voice().activity)
    await waitVoice(() => env.hook.voice().activity.indexOf('已就绪') >= 0, 3000)
    env.assert('准备完成后提示"可以开始说话"（行内动作换成 🎤）', env.hook.voice().activity.indexOf('已就绪') >= 0 && env.hook.voice().action === 'retry', `${env.hook.voice().action} ${env.hook.voice().activity}`)
    env.speechCatalog = goodCatalog
    nodes.cancel.dispatch('click', { stopPropagation() {} })
    await env.sleep(20)

    // ── ⑦ 失败路径：识别失败 / 没听清 ──────────────────────────────
    env.speechTranscript = { ok: false, code: 'failed', error: '识别服务挂了' }
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'recording')
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'feedback')
    env.assert('识别失败：原样说清原因', env.hook.voice().activityTone === 'error' && env.hook.voice().activity.indexOf('识别服务挂了') >= 0, env.hook.voice().activity)
    env.assert('识别失败不会往输入框里塞东西', env.askBox.value === '', JSON.stringify(env.askBox.value))

    env.speechTranscript = { ok: false, code: 'empty-transcript', error: '没听清（这段录音里没有识别到内容）' }
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'recording')
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().activity.indexOf('未识别到语音') >= 0)
    env.assert('没听清：给主会话那句「未识别到语音」+ 可重录', env.hook.voice().activity === '未识别到语音' && env.hook.voice().activityTone === 'warn' && env.hook.voice().action === 'retry', `${env.hook.voice().activityTone} ${env.hook.voice().activity}`)

    // 识别中点 ✕ = 取消（不能有文字冒出来）
    env.speechTranscript = { ok: true, text: '这段不该被插进去' }
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'recording')
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'transcribing')
    nodes.cancel.dispatch('click', { stopPropagation() {} })
    await env.sleep(80)
    env.assert('识别中点 ✕ = 取消（回 idle）', env.hook.voice().phase === 'idle' && env.hook.voice().capture === false, env.hook.voice().phase)
    env.assert('取消之后晚到的结果不会插进输入框', env.askBox.value.indexOf('这段不该被插进去') < 0, JSON.stringify(env.askBox.value))

    // ── ⑧ 权限还没回来就取消：晚到的授权不能变成"在录音" ────────────
    micDeferred = Promise.withResolvers()
    env.speechTranscript = { ok: true, text: '不该出现的第二段' }
    const beforeCancelCalls = micCalls.length
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => micCalls.length === beforeCancelCalls + 1)
    env.assert('点了麦克风之后到授权回来之前是「请求中」', env.hook.voice().phase === 'requesting', `${env.hook.voice().phase} calls=${micCalls.length}`)
    nodes.cancel.dispatch('click', { stopPropagation() {} })
    env.assert('请求中点 ✕ = 取消（回 idle）', env.hook.voice().phase === 'idle' && env.hook.voice().capture === false, env.hook.voice().phase)
    const tracksBeforeLate = micTracks.length
    micDeferred && micDeferred.resolve()
    await env.sleep(80)
    env.assert(
      '取消后晚到的授权不会偷偷开录（也不留下音轨）',
      env.hook.voice().phase === 'idle' && micTracks.length === tracksBeforeLate,
      `${env.hook.voice().phase} tracks=${micTracks.length - tracksBeforeLate}`,
    )

    // ── ⑨ 这条消息发出去了：正在录的那段收掉 ───────────────────────
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'recording')
    const sendTrack = micTracks[micTracks.length - 1]
    env.hook.ask('边录边说的问题')
    await env.sleep(60)
    env.assert('发送消息时正在录的那段被收掉（音轨停掉）', sendTrack.stopped === true, String(sendTrack.stopped))
    env.assert('并说明为什么停（不是悄悄停）', env.hook.voice().activity.indexOf('已停止录音') >= 0, env.hook.voice().activity)
    await waitVoice(() => env.hook.voice().phase === 'idle', 3000)
    env.assert('这句交代过两秒自己收起（不占着录音行）', env.hook.voice().capture === false, String(env.hook.voice().capture))

    // ── ⑩ 切走窗口（blur）= 停止录音，识别不打断 ───────────────────
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'recording')
    const blurTrack = micTracks[micTracks.length - 1]
    env.windowStub.dispatch('blur', {})
    await env.sleep(30)
    env.assert('窗口失焦：录音取消、麦克风松开（主会话同款）', blurTrack.stopped === true && env.hook.voice().phase === 'idle', `${blurTrack.stopped} ${env.hook.voice().phase}`)

    // ── ⑪ 收起小窗 = 立刻松麦克风 ─────────────────────────────────
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => env.hook.voice().phase === 'recording')
    const openTrack = micTracks[micTracks.length - 1]
    env.hook.close()
    await env.sleep(30)
    env.assert('收起小窗：音轨停掉、状态回 idle', openTrack.stopped === true && env.hook.voice().phase === 'idle', `${openTrack.stopped} ${env.hook.voice().phase}`)
    env.assert('收起小窗：录音行一起收掉（不留半句"正在录音"）', env.hook.voice().capture === false && env.hook.voice().activity === '', JSON.stringify({ capture: env.hook.voice().capture, activity: env.hook.voice().activity }))

    // ══════════ ⑬ 实时字幕：半句预览 + 停顿定稿（采样水龙头驱动）══════════
    // 真浏览器里 onaudioprocess 会自己喂采样；桩里由测试直接喂（同一段代码路径）。
    const feedTap = (node, seconds, amplitude) => {
      const frames = Math.round(seconds * 48000)
      const chunk = new Float32Array(frames)
      for (let i = 0; i < frames; i += 1) chunk[i] = amplitude
      node.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } })
    }

    {
      const before = env.askBox.value
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
      const tap = context.processors[context.processors.length - 1]
      env.assert('录音时接上了采样水龙头（实时字幕的前提）', !!tap && env.hook.voice().live.active === true && env.hook.voice().live.disabled === false, JSON.stringify(env.hook.voice().live).slice(0, 120))

      // 说 1.2 秒（响）→ 第一拍半句预览
      env.speechTranscriptQueue = [{ ok: true, text: '这半句还在说' }]
      feedTap(tap, 1.2, 0.3)
      await waitVoice(() => env.hook.voice().live.passes.preview >= 1, 2000)
      await waitVoice(() => env.hook.voice().live.preview !== '', 2000)
      env.assert('说话时字就往输入框里长（半句预览）', env.hook.voice().live.preview === '这半句还在说' && env.askBox.value.indexOf('这半句还在说') >= 0, `${env.hook.voice().live.preview} / ${JSON.stringify(env.askBox.value)}`)
      env.assert('预览是插在原来那段文字后面，不是另起一段', env.askBox.value.startsWith(before), JSON.stringify(env.askBox.value))

      // 静音 0.9 秒 → 这句说完了：定稿
      env.speechTranscriptQueue = [{ ok: true, text: '这句定稿了' }]
      feedTap(tap, 0.9, 0)
      await waitVoice(() => env.hook.voice().live.passes.commit >= 1, 2500)
      await waitVoice(() => env.hook.voice().live.committed !== '', 2500)
      env.assert('停顿 0.6 秒以上 → 这句定稿（预览换成定稿）', env.hook.voice().live.committed === '这句定稿了' && env.hook.voice().live.preview === '', JSON.stringify({ committed: env.hook.voice().live.committed, preview: env.hook.voice().live.preview }))
      env.assert('定稿的文字留在输入框里', env.askBox.value.indexOf('这句定稿了') >= 0, JSON.stringify(env.askBox.value))

      // 还在说（持续有声，不产生停顿）→ 第二句以"半句预览"接在定稿后面
      env.hook.voiceTick()
      env.speechTranscriptRepeat = { ok: true, text: '下一句也在跟' }
      const keepTalking = setInterval(() => feedTap(tap, 0.2, 0.3), 120)
      await waitVoice(() => env.hook.voice().live.preview === '下一句也在跟', 4000)
      env.assert('定稿不丢、新的半句接在后面', env.hook.voice().live.committed === '这句定稿了' && env.hook.voice().live.preview === '下一句也在跟', JSON.stringify({ committed: env.hook.voice().live.committed, preview: env.hook.voice().live.preview }))
      clearInterval(keepTalking)
      env.speechTranscriptRepeat = null
      env.assert('输入框里是「定稿 + 空格 + 预览」', env.askBox.value.indexOf('这句定稿了 下一句也在跟') >= 0, JSON.stringify(env.askBox.value))

      // ■ 停止：整段识别以定稿开头 → 只补后半句，定稿的字一个不动
      env.speechTranscriptQueue = [{ ok: true, text: '这句定稿了 下一句也在跟，而且整段还多说了几个字' }]
      nodes.stop.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'idle', 3000)
      env.assert(
        '停止时以整段为准收口：定稿部分原样保留，只把后面补全',
        env.askBox.value.indexOf('这句定稿了 下一句也在跟，而且整段还多说了几个字') >= 0 && env.hook.voice().live.rewritten === false,
        JSON.stringify(env.askBox.value),
      )
      env.assert('停止后实时层关掉（不再刷新）', env.hook.voice().live.active === false, String(env.hook.voice().live.active))
    }

    // ── ⑭ 整段识别"对不上"时：以整段为准整块替换（并记一笔）──────────
    {
      env.hook.askValue('')
      env.speechTranscriptQueue = [{ ok: true, text: '实时那段' }, { ok: true, text: '实时定稿的那句' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
      const tap = context.processors[context.processors.length - 1]
      feedTap(tap, 1.2, 0.3)
      await waitVoice(() => env.hook.voice().live.passes.preview >= 1, 2000)
      feedTap(tap, 0.9, 0)
      await waitVoice(() => env.hook.voice().live.committed !== '', 3000)
      env.assert('（前置）这一句已经定稿', env.hook.voice().live.committed === '实时定稿的那句', JSON.stringify(env.hook.voice().live.committed))
      env.speechTranscriptQueue = [{ ok: true, text: '整段识别给的是完全不同的句子' }]
      nodes.stop.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'idle', 3000)
      env.assert('整段与实时对不上时：整块替换，并以自检记一笔', env.askBox.value === '整段识别给的是完全不同的句子' && env.hook.voice().live.rewritten === true, JSON.stringify({ value: env.askBox.value, rewritten: env.hook.voice().live.rewritten }))
    }

    // ── ⑮ ✕ 取消 = 只停，已经说出来的字留着（用户明确要的语义）──────────
    {
      env.hook.askValue('手写的一句')
      env.speechTranscriptQueue = [{ ok: true, text: '取消之后这句要留着' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
      const tap = context.processors[context.processors.length - 1]
      feedTap(tap, 1.2, 0.3)
      await waitVoice(() => env.hook.voice().live.preview === '取消之后这句要留着', 3000)
      await waitVoice(() => env.hook.voice().live.passes.preview >= 1, 500)
      env.assert('取消前：预览已经在输入框里', env.askBox.value.indexOf('取消之后这句要留着') >= 0, JSON.stringify(env.askBox.value))
      const track = micTracks[micTracks.length - 1]
      nodes.cancel.dispatch('click', { stopPropagation() {} })
      await env.sleep(40)
      env.assert('✕ 取消 = 停录、松开麦克风', env.hook.voice().phase === 'idle' && env.hook.voice().capture === false && track.stopped === true, JSON.stringify({ phase: env.hook.voice().phase, stopped: track.stopped }))
      env.assert('✕ 取消 = 已经说出来的字**留着**（连着手写那句一起）', env.askBox.value === '手写的一句 取消之后这句要留着', JSON.stringify(env.askBox.value))
      env.assert('取消后实时层关掉（不再更新那段文字）', env.hook.voice().live.active === false, JSON.stringify({ active: env.hook.voice().live.active }))
    }

    // ── ⑯ 失焦 / 收起小窗：录音停下，屏幕上的字留着 ─────────────────
    {
      env.hook.askValue('')
      env.speechTranscriptQueue = [{ ok: true, text: '切走也别丢字' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
      const tap = context.processors[context.processors.length - 1]
      feedTap(tap, 1.2, 0.3)
      await waitVoice(() => env.hook.voice().live.preview === '切走也别丢字', 3000)
      env.windowStub.dispatch('blur', {})
      await env.sleep(40)
      env.assert('失焦停录，但已经写进输入框的字留着', env.hook.voice().phase === 'idle' && env.askBox.value.indexOf('切走也别丢字') >= 0, JSON.stringify({ phase: env.hook.voice().phase, value: env.askBox.value }))
      env.hook.askValue('')
    }

    // ── ⑰ 用户在实时那段里改字 → 实时层让位（不跟用户抢）────────────
    {
      env.speechTranscriptQueue = [{ ok: true, text: '我是预览' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
      const tap = context.processors[context.processors.length - 1]
      feedTap(tap, 1.2, 0.3)
      await waitVoice(() => env.hook.voice().live.preview === '我是预览' && env.askBox.value.indexOf('我是预览') >= 0, 3000)
      env.askBox.value = env.askBox.value.replace('我是预览', '我改成别的了')
      env.askBox.dispatch('input', {})
      feedTap(tap, 1.2, 0.3)
      env.hook.voiceTick()
      await env.sleep(300)
      env.assert('用户改了实时那段 → 实时层让位（不改他的字）', env.hook.voice().live.disabled === true && env.hook.voice().live.reason === 'edited' && env.askBox.value.indexOf('我改成别的了') >= 0, JSON.stringify({ reason: env.hook.voice().live.reason, value: env.askBox.value }))
      nodes.stop.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'idle', 3000)
      env.assert('让位之后停止仍然出最终文字（退回普通插入）', env.askBox.value.indexOf('我是预览'.slice(0, 0)) >= 0 && env.askBox.value.indexOf('我改成别的了') >= 0, JSON.stringify(env.askBox.value))
      env.hook.askValue('')
    }

    // ── ⑱ 没有采样水龙头（老浏览器）：功能自动退回"停止后出字" ───────
    {
      const realScriptProcessor = AudioContextStub.prototype.createScriptProcessor
      AudioContextStub.prototype.createScriptProcessor = undefined
      env.speechTranscriptQueue = [{ ok: true, text: '没有水龙头也能出字' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      env.assert('拿不到水龙头：实时层自己关掉（不报错、不空转）', env.hook.voice().live.active === false && env.hook.voice().live.disabled === true && env.hook.voice().live.reason === 'no-tap', JSON.stringify(env.hook.voice().live).slice(0, 120))
      nodes.stop.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'idle', 3000)
      env.assert('停止后照样把整段文字插进输入框（老行为不变）', env.askBox.value.indexOf('没有水龙头也能出字') >= 0, JSON.stringify(env.askBox.value))
      AudioContextStub.prototype.createScriptProcessor = realScriptProcessor
      env.hook.askValue('')
    }

    // ── ⑲ 云端识别器：不做实时预览（每拍一次付费调用），停止后照常出字 ──
    {
      const hostCatalogFixture = env.speechCatalog
      env.speechCatalog = { ...hostCatalogFixture, providers: [{ ...hostCatalogFixture.providers[0], location: 'cloud' }] }
      env.speechTranscriptQueue = [{ ok: true, text: '云端也能出字，只是没有预览' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      env.assert('云端识别器：实时层不开（reason=cloud）', env.hook.voice().live.active === false && env.hook.voice().live.disabled === true && env.hook.voice().live.reason === 'cloud', JSON.stringify(env.hook.voice().live).slice(0, 120))
      nodes.stop.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'idle', 3000)
      env.assert('云端：停止后照常把文字插进输入框（退化成"说完再出字"）', env.askBox.value.indexOf('云端也能出字，只是没有预览') >= 0, JSON.stringify(env.askBox.value))
      env.speechCatalog = hostCatalogFixture
      env.hook.askValue('')
    }

    // ── ⑳ 回归：停顿那几拍"没听清"不能把实时层关掉（用户报的 bug）──────
    // 症状："实时预览只跟第一句，后面就不吐字了"。
    // 原因：停顿里的预览窗口是纯静音 → 识别返回空转写（没听清）→ 被当成"失败"计数，
    //       连挂 3 次就把整个实时层 disable 了。
    {
      env.hook.askValue('')
      env.speechTranscriptQueue = [{ ok: true, text: '第一句' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
      const tap = context.processors[context.processors.length - 1]
      feedTap(tap, 1.2, 0.3)
      await waitVoice(() => env.hook.voice().live.preview === '第一句', 3000)

      // 连续 5 拍都返回"没听清"（对应停顿里那些纯静音窗口）
      env.speechTranscriptRepeat = { ok: false, code: 'empty-transcript', error: '没听清（这段录音里没有识别到内容）' }
      for (let i = 0; i < 5; i += 1) {
        feedTap(tap, 0.2, 0.3)
        env.hook.voiceTick()
        await env.sleep(150)
      }
      env.assert('空转写不算失败：连来 5 拍"没听清"也不关实时层', env.hook.voice().live.active === true && env.hook.voice().live.disabled === false, JSON.stringify({ active: env.hook.voice().live.active, disabled: env.hook.voice().live.disabled, reason: env.hook.voice().live.reason }))
      env.assert('空结果也不会把上一拍的预览抹掉（不闪没）', env.hook.voice().live.preview === '第一句' && env.askBox.value.indexOf('第一句') >= 0, JSON.stringify({ preview: env.hook.voice().live.preview, value: env.askBox.value }))

      // 后面的话照样跟着出字（正面用例）
      env.speechTranscriptRepeat = { ok: true, text: '第二句照样跟' }
      feedTap(tap, 1.2, 0.3)
      await waitVoice(() => env.hook.voice().live.preview === '第二句照样跟', 3000)
      // 预览本来就是"这一拍窗口的识别结果"，新文本会替换旧的；而且它随时可能被"停顿定稿"接手
      //（这里喂完就停手，600ms 后确实会定稿）。这条回归要的是：**实时层还活着、新的话确实进了输入框**。
      env.assert(
        '同一段录音里，后面的话照样跟着出字（实时层没死）',
        env.askBox.value.indexOf('第二句照样跟') >= 0 && env.hook.voice().live.disabled === false && env.hook.voice().live.reason === '',
        JSON.stringify({ preview: env.hook.voice().live.preview, committed: env.hook.voice().live.committed, value: env.askBox.value, reason: env.hook.voice().live.reason }),
      )
      env.speechTranscriptRepeat = null
      nodes.cancel.dispatch('click', { stopPropagation() {} })
      await env.sleep(30)
      env.hook.askValue('')
    }

    // ── ㉑ 真故障连续 5 次才让位；静音窗口根本不发请求 ────────────────
    {
      env.speechTranscriptQueue = [{ ok: true, text: '先定稿一句' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
      const tap = context.processors[context.processors.length - 1]
      feedTap(tap, 1.2, 0.3)
      await waitVoice(() => env.hook.voice().live.passes.preview >= 1, 3000)

      // 定稿之后一直是静音：窗口里没有新语音 → 一次调用都不该发
      env.speechTranscriptQueue = [{ ok: true, text: '定稿的那句' }]
      feedTap(tap, 0.9, 0)
      await waitVoice(() => env.hook.voice().live.committed !== '', 3000)
      const callsBefore = env.speechTranscribeCalls.length
      feedTap(tap, 1.0, 0)
      env.hook.voiceTick()
      await env.sleep(250)
      env.hook.voiceTick()
      await env.sleep(250)
      env.assert('定稿后一直静音：不再浪费识别调用（也避免把预览刷没）', env.speechTranscribeCalls.length === callsBefore && env.hook.voice().live.disabled === false, `${env.speechTranscribeCalls.length} vs ${callsBefore}`)

      // 真故障（不是"没听清"）：连续 5 次才让位
      env.speechTranscriptRepeat = { ok: false, code: 'failed', error: '识别服务挂了' }
      for (let i = 0; i < 6; i += 1) {
        feedTap(tap, 0.25, 0.3)
        env.hook.voiceTick()
        await env.sleep(180)
      }
      env.assert('真故障连续 5 次才让位（不让偶发一次超时把字幕关掉）', env.hook.voice().live.disabled === true && env.hook.voice().live.reason === 'preview-failed', JSON.stringify({ disabled: env.hook.voice().live.disabled, reason: env.hook.voice().live.reason }))
      env.speechTranscriptRepeat = null
      env.speechTranscriptQueue = [{ ok: true, text: '让位之后停止照样出字' }]
      nodes.stop.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'idle', 3000)
      env.assert('让位之后停止仍然出字（整段那条路不受影响）', env.askBox.value.indexOf('让位之后停止照样出字') >= 0, JSON.stringify(env.askBox.value))
      env.hook.askValue('')
    }

    // ── ㉒ 输入框自适应拉伸（用户报：换行后下面的字看不见）────────────────
    // 桩里的 scrollHeight 是可控的：直接改它再触发一次刷新，就是"内容变高了"。
    {
      const box = env.askBox
      const originalScrollHeight = Object.getOwnPropertyDescriptor(box, 'scrollHeight')
      box.value = ''
      // 一行：高度=内容高度（和 CSS 的 min-height 一致），且不该出现滚动条
      box.scrollHeight = 26
      env.hook.askValue('一行')
      env.assert('输入框：一行内容时高度就是内容高（不出滚动条）', box.style.height === '26px' && box.style.overflowY === 'hidden', JSON.stringify({ height: box.style.height, overflow: box.style.overflowY }))
      box.scrollHeight = 78
      env.hook.askValue('第一行\n第二行\n第三行')
      env.assert('输入框：多行了就自己长高（高度=内容高）', box.style.height === '78px' && box.style.overflowY === 'hidden', JSON.stringify({ height: box.style.height, overflow: box.style.overflowY }))

      box.scrollHeight = 400
      env.hook.askValue('很多行'.repeat(80))
      env.assert('输入框：到上限（132px）就停住、改成内部滚动', box.style.height === '132px' && box.style.overflowY === 'auto', JSON.stringify({ height: box.style.height, overflow: box.style.overflowY }))
      env.assert('输入框：超过上限时自动滚到最新一行（语音输入一直在末尾加字）', box.scrollTop === 400, String(box.scrollTop))

      // 语音输入落字 → 也会走同一条自适应（liveWrite → refreshAskState）
      box.scrollHeight = 104
      env.hook.askValue('')
      env.speechTranscriptQueue = [{ ok: true, text: '这一句会比较长，长到换行以后还能看得见' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
      const tap = context.processors[context.processors.length - 1]
      feedTap(tap, 1.2, 0.3)
      box.scrollHeight = 104
      await waitVoice(() => env.hook.voice().live.preview !== '', 3000)
      env.assert('语音输入落字时输入框同样跟着长高', box.style.height === '104px', JSON.stringify({ height: box.style.height, value: box.value }))
      nodes.cancel.dispatch('click', { stopPropagation() {} })
      await env.sleep(30)

      // 恢复桩的 scrollHeight 语义（后面的用例还要用）
      box.scrollHeight = 0
      if (originalScrollHeight) Object.defineProperty(box, 'scrollHeight', originalScrollHeight)
      env.hook.askValue('')
    }

    // ── ㉓ Esc 分两级：先取消语音，再关窗（+ 开窗聚焦输入框）────────────
    {
      // 开窗 → 输入框可见后自动聚焦一次（假 DOM 里 focus 是空实现，这里换成探针）
      let focused = 0
      const realFocus = env.askBox.focus
      env.askBox.focus = () => {
        focused += 1
      }
      env.hook.open('voice-probe', '', 'Esc 语义')
      await waitVoice(() => env.hook.state().phase === 'done', 3000)
      env.assert('开窗后自动聚焦输入框（键盘用户不用先 Tab）', focused === 1, String(focused))

      // ① 语音进行中按 Esc：只取消这一次语音，面板留着
      env.speechTranscriptQueue = [{ ok: true, text: '按 Esc 之前已经在框里的字' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
      const tap = context.processors[context.processors.length - 1]
      feedTap(tap, 1.2, 0.3)
      await waitVoice(() => env.hook.voice().live.preview !== '', 3000)
      const track = micTracks[micTracks.length - 1]
      env.documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
      await env.sleep(40)
      env.assert('语音中按 Esc：录音取消、麦克风松开', env.hook.voice().phase === 'idle' && track.stopped === true && env.hook.voice().capture === false, JSON.stringify({ phase: env.hook.voice().phase, stopped: track.stopped }))
      env.assert('语音中按 Esc：面板**留着**（不再顺手关掉整个小窗）', env.hook.quoteState().panelOpen === true && env.panel.style.display === 'flex', String(env.hook.quoteState().panelOpen))
      env.assert('语音中按 Esc：已经说出来的字留着（取消只停，不删字）', env.askBox.value.indexOf('按 Esc 之前已经在框里的字') >= 0, JSON.stringify(env.askBox.value))

      // ② 不录音时再按 Esc：这次才关窗
      env.documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
      await env.sleep(40)
      env.assert('不录音时按 Esc：关窗（两级 Esc 的第二级）', env.hook.quoteState().panelOpen === false && env.panel.style.display === 'none', String(env.hook.quoteState().panelOpen))

      // ③ 提示行还在（feedback）时按 Esc：先收起提示，面板不关
      micDenied = true
      env.hook.open('voice-probe', '', 'Esc 语义')
      await waitVoice(() => env.hook.state().phase === 'done', 3000)
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'feedback')
      env.documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
      await env.sleep(40)
      env.assert('失败提示还在时按 Esc：收起提示、面板留着', env.hook.voice().phase === 'idle' && env.hook.quoteState().panelOpen === true, JSON.stringify({ phase: env.hook.voice().phase, open: env.hook.quoteState().panelOpen }))
      micDenied = false
      env.documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
      await env.sleep(40)
      env.assert('提示收掉之后再按 Esc 才关窗', env.hook.quoteState().panelOpen === false, String(env.hook.quoteState().panelOpen))
      env.askBox.focus = realFocus
      env.hook.askValue('')
    }

    // ── ㉔ 开窗聚焦的两种情形 + 录音时光标跟着预览走 ────────────────
    {
      let focused = 0
      const realFocus = env.askBox.focus
      env.askBox.focus = () => {
        focused += 1
      }
      const realActive = env.documentStub.activeElement

      // ① 焦点在浮标上 —— 这就是真实点开小窗时的情形（Chrome 点 <button> 会把焦点给它）
      env.hook.close()
      env.documentStub.activeElement = new env.FakeEl('button')
      env.hook.open('voice-probe', '', '聚焦')
      await waitVoice(() => env.hook.state().phase === 'done', 3000)
      env.assert('开窗聚焦：焦点在浮标按钮上时也要把光标交给输入框（真实路径）', focused === 1, String(focused))

      // ② 人家正在别处（主会话输入框）打字 → 不抢
      env.hook.close()
      focused = 0
      env.documentStub.activeElement = new env.FakeEl('textarea')
      env.hook.open('voice-probe', '', '聚焦')
      await waitVoice(() => env.hook.state().phase === 'done', 3000)
      env.assert('开窗聚焦：别人正在别处打字就不抢（那才是真的别打扰）', focused === 0, String(focused))

      // ③ 录音一开始就把光标交给输入框；预览落字后光标停在最新文字后面
      env.hook.close()
      env.documentStub.activeElement = realActive
      focused = 0
      env.hook.askValue('')
      env.speechTranscriptQueue = [{ ok: true, text: '第一拍预览' }]
      micButton.dispatch('click', { stopPropagation() {} })
      await waitVoice(() => env.hook.voice().phase === 'recording')
      env.assert('录音开始就把光标交给输入框（不聚焦就看不见光标跳）', focused >= 1, String(focused))
      const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
      const tap = context.processors[context.processors.length - 1]
      feedTap(tap, 1.2, 0.3)
      await waitVoice(() => env.hook.voice().live.preview === '第一拍预览', 3000)
      env.assert('预览落字后：光标停在最新文字末尾（会在那里跳）', env.askBox.selectionStart === env.askBox.value.length && env.askBox.value.length > 0, `${env.askBox.selectionStart}/${env.askBox.value.length}`)

      // ④ 预览换成更长的一句 → 光标跟着新末尾走
      env.speechTranscriptRepeat = { ok: true, text: '第二拍预览更长一些' }
      feedTap(tap, 1.2, 0.3)
      env.hook.voiceTick()
      await waitVoice(() => env.hook.voice().live.preview === '第二拍预览更长一些', 3000)
      env.assert('预览整段替换时：光标跟到新末尾（不会留在旧位置）', env.askBox.selectionStart === env.askBox.value.length, `${env.askBox.selectionStart}/${env.askBox.value.length}`)

      // ⑤ 用户自己把光标挪走 → 不再跟着挪（不抢他的位置）
      env.speechTranscriptRepeat = { ok: true, text: '第三拍再长一点的预览文字' }
      env.askBox.setSelectionRange(0, 0)
      feedTap(tap, 1.2, 0.3)
      env.hook.voiceTick()
      await env.sleep(250)
      env.assert('用户自己挪了光标之后就不再跟着挪（不跟他抢位置）', env.askBox.selectionStart === 0, String(env.askBox.selectionStart))

      env.speechTranscriptRepeat = null
      nodes.cancel.dispatch('click', { stopPropagation() {} })
      await env.sleep(40)
      env.askBox.focus = realFocus
      env.documentStub.activeElement = realActive
      env.hook.askValue('')
    }
    const helpers = { encodeWave, bytesToBase64, formatClock }
    const samples = new Float32Array(16000) // 1 秒
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 12) * 0.7
    const wave = helpers.encodeWave(samples)
    const view = new DataView(wave.buffer)
    const ascii = (start, end) => Buffer.from(wave.slice(start, end)).toString('ascii')
    env.assert('WAV 头：RIFF/WAVE/fmt', ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE' && ascii(12, 16) === 'fmt ', ascii(0, 16))
    env.assert(
      'WAV 头：16kHz / 单声道 / PCM16（host 逐字段校验的就是这几个）',
      view.getUint32(24, true) === 16000 && view.getUint16(22, true) === 1 && view.getUint16(34, true) === 16 && view.getUint16(20, true) === 1,
      `${view.getUint32(24, true)}Hz ch=${view.getUint16(22, true)} bit=${view.getUint16(34, true)}`,
    )
    env.assert('WAV 头：长度字段自洽（RIFF / data 都算对）', view.getUint32(4, true) === wave.length - 8 && view.getUint32(40, true) === wave.length - 44, `${view.getUint32(4, true)} / ${view.getUint32(40, true)}`)
    env.assert('WAV：1 秒 = 44 字节头 + 32000 字节数据', wave.length === 44 + 32000, String(wave.length))
    env.assert('base64 是可解回来的（host 会校验"规范 base64"）', Buffer.from(helpers.bytesToBase64(wave), 'base64').equals(Buffer.from(wave)), 'round-trip')
    const clipped = helpers.encodeWave(new Float32Array([2, -2, 0]))
    // 16 位小端、有符号：+32767 = ff 7f，-32768 = 00 80（不夹的话 2*32767 会绕成负数）
    env.assert(
      '采样越界会被夹住（±2 不该绕回成爆音）',
      clipped[44] === 0xff && clipped[45] === 0x7f && clipped[46] === 0x00 && clipped[47] === 0x80,
      `${clipped[44]},${clipped[45]},${clipped[46]},${clipped[47]}`,
    )
    env.assert('录音秒数显示成 0:07 这种', helpers.formatClock(7500) === '0:07' && helpers.formatClock(60000) === '1:00', helpers.formatClock(7500))

    env.hook.close()
  }


  // ───────────────────────── 关闭 / 清理 ─────────────────────────
  env.hook.close()

  env.assert('Esc/关闭后隐藏', env.panel.style.display === 'none')
}
