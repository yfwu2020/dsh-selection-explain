import { stopIcon, sendIcon } from './icons.js'
import { QUOTE_ONLY_QUESTION, API, PROMOTE } from './constants.js'
import { el } from './dom.js'
import { splitSections } from './render.js'
import { CHAT_REQUEST_BYTES, contextSource, prepareChatHistory, readContextState } from '../chat-context.js'

/** conversation state and operations; dependencies are supplied as live node/callback accessors. */
export function createConversationController(env) {

  /** 发送按钮/输入框的可用状态：空内容或正在生成时不可发。 */
  /** 当前有没有一轮在跑（首轮/详解 或 追问）。 */
  function isGenerating() {
    return env.state.asking || env.state.phase === 'loading' || env.state.phase === 'streaming'
  }

  /**
   * 发送键 = 「发送」还是「停止」：生成中变成方形停止键（点了打断这次输出），
   * 空闲时是上箭头发送键（空输入才禁用）。
   */
  /**
   * 输入框跟着内容长高（到 132px 为止，再高就内部滚动）。
   *
   * textarea 的**高度由 rows 决定**，内容换行它不会自己长 —— 不补这一步，第二行起
   * 下面的字就被裁掉了。语音输入的实时字幕最吃亏：字是边说边自己长出来的，
   * 用户根本没在敲键盘，也就不会想到去拖那个框。
   * 超过上限时把最新那几行滚进视野（实时落字时光标一直在末尾）。
   */
  function autoGrowAskBox() {
    if (!env.askBox || !env.askBox.style) return
    var cap = 132
    // 先松开高度再量，否则量到的是上一次的高度（经典递归式变高）
    env.askBox.style.height = 'auto'
    var content = typeof env.askBox.scrollHeight === 'number' ? env.askBox.scrollHeight : 0
    if (content > 0) {
      env.askBox.style.height = Math.min(content, cap) + 'px'
      env.askBox.style.overflowY = content > cap ? 'auto' : 'hidden'
    } else {
      // 量不到内容（面板收着 / DOM 桩）：交回 CSS 的 min-height
      env.askBox.style.height = ''
      env.askBox.style.overflowY = ''
    }
    try {
      if (content > cap) env.askBox.scrollTop = env.askBox.scrollHeight
    } catch (error) {
      /* 桩环境没有 scrollTop 语义 */
    }
    // 长高之后面板可能顶出视口：拉回来（面板没开时它自己会早退）
    env.keepInsideViewport()
  }

  function refreshAskState() {
    autoGrowAskBox()
    var generating = isGenerating()
    var mode = generating ? 'stop' : 'send'
    if (env.askSend.getAttribute('data-mode') !== mode) {
      env.askSend.textContent = ''
      env.askSend.appendChild(generating ? stopIcon() : sendIcon())
      env.askSend.setAttribute('data-mode', mode)
      env.askSend.setAttribute('aria-label', generating ? '停止' : '发送')
      env.askSend.title = generating ? '停止生成（点一下打断这次输出）' : '发送（Enter）'
    }
    // 附件还在传时**发送键置灰**：这一轮的材料还没齐，发出去模型看到的是残缺的
    //（只有"生成中"才让按钮变成可点的「停止」——那是另一件事）
    var waitingAttachments = env.attachmentsBusy()
    env.askSend.disabled = generating ? false : waitingAttachments || (!String(env.askBox.value || '').trim() && env.state.quotes.length === 0 && env.state.attachments.length === 0)
    // 输入框的提示跟着"有没有附件"走：没附件时把"可以拖 / 可以粘"写出来（这两条入口没有按钮，不说就没人知道）
    var placeholder = env.state.attachments.length > 0
      ? '就这段文字继续追问…（Enter 发送，Shift+Enter 换行）'
      : '就这段文字继续追问…（可拖入图片 / 文件，或 ⌘V 粘贴）'
    if (env.askBox.placeholder !== placeholder) env.askBox.placeholder = placeholder
  }

  /** 停止当前这一轮：追问走自己的 abort；首轮/详解复用"用户中止"那条路径。 */
  function stopCurrent() {
    if (env.state.askRequest) {
      env.state.stopped = true
      try {
        env.state.askRequest.abort()
      } catch (error) {
        /* noop */
      }
      return true
    }
    if (env.state.request) {
      env.state.aborted = true // 让 fail() 走"已停止"而不是"解读失败"
      try {
        env.state.request.abort()
      } catch (error) {
        /* noop */
      }
      env.state.request = null
      return true
    }
    return false
  }

  /**
   * 发送一个追问（多轮，带历史；走 host 的 chat 模式）。
   *
   * 两段式：先**取引用的上下文**（会话里那几段要问 host 要，见 resolveQuoteContexts），
   * 再真正发。取上下文期间用 state.resolvingQuotes 挡住重复发送 ——
   * 那一刻输入框和引用区都已经清空了，再按一次 Enter 会变成"空发一条"。
   */
  async function ask(question) {
    var generating = env.state.asking || env.state.phase === 'loading' || env.state.phase === 'streaming'
    if (generating) {
      // 以前这里是静默 return —— 点了没反应，用户不知道在等什么
      env.setStatus('还在生成，请稍候…（生成完就能追问）')
      return
    }
    // 这条消息发出去了，正在录的那一段就不再是"下一条提问"了：
    // 收掉它可以避免"发送后麦克风还红着"（用户会以为还在录）。
    // 已经识别出来的文字在输入框里，不受影响。
    if (env.voice.phase === 'recording' || env.voice.phase === 'requesting' || env.voice.phase === 'transcribing') {
      env.cancelVoice({ note: '已停止录音（这条先发出去）' })
    }
    var asked = String(question || '').trim()
    // ⚠️ 附件现在是"点发送才上传"：先传完再取引用。
    // 好处是叉掉的图根本没落盘；代价是发送时多等上传（通常不到 1 秒）。
    if (env.attachEnsureUploaded && env.state.uploadingAttachments) return
    if (env.attachEnsureUploaded) {
      env.state.uploadingAttachments = true
      env.setStatus('正在上传附件…')
      try {
        await env.attachEnsureUploaded()
      } finally {
        env.state.uploadingAttachments = false
      }
      // 上传期间用户可能又点了发送 / 已经开始生成了：这一枪就别再发了
      if (env.state.asking || env.state.phase === 'loading' || env.state.phase === 'streaming') return
    }
    // 引用先取出来：只挂引用、没写问题也允许发（这时用一句兜底提问）
    var quotes = env.state.quotes.slice()
    // 附件同理：只挂附件、一个字没写也允许发（附件本身就是内容）
    var attachments = env.attachmentsPayload()
    if ((!asked && quotes.length === 0 && attachments.length === 0) || !env.state.payload) return
    if (env.attachmentsBusy()) {
      // 还有附件在传：发出去的话模型看到的是残缺材料 —— 拦住并说清楚在等什么
      env.setStatus('附件还在上传，稍等一下…')
      return
    }
    if (env.state.resolvingQuotes) {
      env.setStatus('正在取引用的上下文…')
      return
    }
    // ⚠️ 到这里才算"收下了这条提问"，此刻才清空输入框。
    //
    // 以前是**调用方先清空、再调 ask()**：于是"生成中按 Enter"这种被 ask() 拒掉的情况，
    // 输入框已经被清空 —— 用户打的字直接丢了（只剩一句"还在生成，请稍候…"）。
    // 清空放在这里，就不会再出现"没送出去却清掉了"。
    // 只清"确实是这条提问的内容"：ask() 也可能被程序用别的文本调用（测试钩子等），
    // 那种情况下输入框里的东西不该被抹掉。
    if (env.askBox.value && String(env.askBox.value).trim() === asked) {
      env.askBox.value = ''
      refreshAskState()
    }
    // 引用是"下一条提问"的：立刻清空（提问已经在手上，别让下一轮又带上）
    if (quotes.length > 0) {
      env.state.quotes = []
      env.renderQuotes()
      refreshAskState()
    }
    // ⚠️ 附件说明必须在**清空之前**拼好：describe() 要读每件的 name / status，
    // 而 payload() 给的是 `{kind, ref}`（没有名字），清空之后更是什么都读不到。
    // 这里先算，再往下清空，最后连同引用一起交给 sendAsk。
    var attachmentsNote = env.attachmentsDescribe()
    // 附件同理：引用（ref）已经在手上，composer 里那一排缩略图可以收了 ——
    // 本地 object URL 也在这时释放，不然每发一次都留一份内存里的预览
    if (attachments.length > 0) {
      env.clearAttachments()
      refreshAskState()
    }
    if (quotes.length === 0) {
      sendAsk(asked, quotes, attachments, attachmentsNote)
      return
    }
    env.state.resolvingQuotes = true
    env.resolveQuoteContexts(quotes).then(function (resolved) {
      env.state.resolvingQuotes = false
      sendAsk(asked, resolved, attachments, attachmentsNote)
    })
  }

  /** 真正把这一轮发出去（引用已经带上上下文了）。 */
  function sendAsk(asked, quotes, attachments, attachmentsNote) {
    var payload = env.state.payload
    if (!payload) return
    var withAttachments = attachments || []
    // 引用拼进**这一条**消息：发给模型、进历史、升格用的都是拼好的那份
    var sent = env.composeQuestion(quotes, asked)
    // 附件也拼一行进正文：小窗的历史只存文本，不写这一行的话，
    // 后面几轮模型就不知道"上一轮还带了张图 / 一个文件"（见 attach.js 的 describe）
    if (attachmentsNote) sent = attachmentsNote + '\n' + sent
    if (env.state.turns.length === 0 && (env.state.raw.trim() || env.state.parts.translation || env.state.parts.detail)) {
      env.state.turns.push({ role: 'assistant', text: env.seedHistoryFromExplanation(), seed: true, hidden: true })
    }
    // attachments 挂在这一轮上：它既随历史落盘（saveHistory → history-store），
    // 也在下面拼模型历史时回传（→ analyze 的图片预算）。**只存引用，不存字节**。
    var questionTurn = { role: 'user', text: asked || QUOTE_ONLY_QUESTION, quotes: quotes, sent: sent, attachments: withAttachments }
    env.state.turns.push(questionTurn)
    // asking 只管"等待特效要不要显示"（首字一到就置 false），
    // streaming 才是"这一轮还没写完"。两者必须分开：以前拿 asking 当定稿判据，
    // 结果是首字一到就认定"定稿了"→ 每个 delta 都重建一个 iframe（实测一条回答建了 24 个），
    // 既看不到源码，最后一帧还因为连续销毁/加载而卡成空白，得关掉小窗重开才渲染。
    var answerTurn = {
      role: 'assistant',
      text: '',
      asking: true,
      streaming: true,
      startedAt: Date.now(),
      thought: '',
      effort: env.state.chatEffort || 'high',
    }
    env.state.turns.push(answerTurn)
    env.state.asking = true
    env.state.askingStartedAt = Date.now()
    env.syncPanelStage()
    // 发过追问了：把「展开详解」收起来
    env.syncExpandCta()
    refreshAskState()
    // 刚发出的问题必须立刻可见（用户主动发的话，跟到底）
    env.state.follow = true
    env.ensureChatFollow()
    env.renderTurns({ stick: true })
    // 之后不再"定时硬贴"：面板切宽版的重排、思考尾巴、预览 iframe 上报高度……
    // 都会让消息区长高，由 ResizeObserver 负责续贴；定时硬贴会在用户翻看上文时把他拽回底部。
    if (env.state.sessionOpen !== undefined) { /* noop */ }
    var startedAt = Date.now()
    var timer = env.timerScope.interval(function () {
      env.paintPill()
      // 追问期间也一样：只报"在检索/在生成"，不报工具细节
      env.setStatus(
        (env.state.toolBusy ? '正在检索资料… ' : '追问中… ') + ((Date.now() - startedAt) / 1000).toFixed(1) + 's',
      )
      updateWaitClocks()
    }, 200)

    var historyTurns = env.state.turns.slice(0, env.state.turns.length - 2)
    var initialExplanation = env.state.skipInterpretation ? '' : env.seedHistoryFromExplanation()
    var source = contextSource(env.panelOrCurrentSessionId(), payload.text.trim(), payload.context, initialExplanation)
    if (env.state.contextState && env.state.contextState.source !== source) env.state.contextState = null
    var prepared = prepareChatHistory(historyTurns, env.state.contextState)
    env.state.contextState = prepared.contextState
    var history = prepared.history
    var requestTurns = env.state.turns
    var requestKey = env.state.cacheKey

    // 这一轮的 abort 句柄：生成中按「停止」会打断它（不是失败，保留已流出的内容）
    env.state.stopped = false
    var askController = new AbortController()
    env.state.askRequest = {
      abort: function () {
        try {
          askController.abort()
        } catch (error) {
          /* noop */
        }
      },
    }

    function finish(error) {
      env.timerScope.clear(timer)
      env.state.asking = false
      env.state.toolBusy = false
      // 本轮结束了："正在整理结论…"这类过程提示一律撤掉（结论轮一个字没吐时也别留着）
      env.clearTransientNotice(answerTurn)
      answerTurn.asking = false
      answerTurn.streaming = false
      clearWaiting(env.chatLog)
      if (env.state.turns === requestTurns && env.state.cacheKey === requestKey) env.saveHistory()
      env.syncPanelStage()
      refreshAskState()
      env.state.askRequest = null
      if (env.state.stopped) {
        // 用户点了「停止」：不算失败，保留已经流出来的内容
        answerTurn.stopped = true
        env.state.stopped = false
      } else if (error) {
        answerTurn.error = true
        answerTurn.text = '追问失败：' + error
      }
      env.renderTurns()
      env.setStatus(
        answerTurn.stopped
          ? '已停止（你打断了这次输出）'
          : error
            ? ''
            : '追问完成 · 耗时 ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's',
      )
      // 一轮**追问**结束（成功 / 失败 / 被停止）—— 与小窗其它轮同一条规则：光标交回输入框。
      // ⚠️ 这里原来是漏的：首轮的 succeed/fail 有规则，追问这条路径没有，
      // 所以"追问失败"之后输入框里不出现光标（用户实测）。
      env.askFocusAfterTurn()
    }

    var requestBody = JSON.stringify({
        text: payload.text,
        context: payload.context,
        label: payload.label,
        sessionId: env.panelOrCurrentSessionId(),
        question: sent,
        history: history,
        key: requestKey,
        historyStart: prepared.historyStart,
        contextState: prepared.contextState,
        materials: prepared.materials,
        initialExplanation: initialExplanation,
        // 附件只带**引用**（图片/文件都已经在 host 的附件服务里），body 不会因为一张截图胖几 MB
        ...(withAttachments.length > 0 ? { attachments: withAttachments } : {}),
        // 网页输出要跟着当前深浅走：深色 Harness 里给一张白底页面会很刺眼
        ...(env.state.webAnswer ? { webAnswer: true, theme: env.currentSurfaceTheme() } : {}),
        ...(env.state.modelChoice ? { provider: env.state.modelChoice.provider, model: env.state.modelChoice.model } : {}),
        ...(env.state.effort ? { effort: env.state.effort } : {}),
        ...(env.state.toolDigest ? { toolDigest: env.state.toolDigest } : {}),
    })
    if (new TextEncoder().encode(requestBody).byteLength > CHAT_REQUEST_BYTES) {
      questionTurn.contextExcluded = true
      answerTurn.contextExcluded = true
      finish('本轮材料超过请求容量，请缩小提问或引用范围；原文仍保留在当前历史中')
      return
    }

    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
      signal: askController.signal,
    })
      .then(function (response) {
        if (!response.ok) {
          return response
            .json()
            .catch(function () {
              return {}
            })
            .then(function (data) {
              throw new Error(data && data.error ? data.error : 'HTTP ' + response.status)
            })
        }
        var reader = response.body.getReader()
        var decoder = new TextDecoder()
        var buffer = ''
        function handle(block) {
          var lines = block.split('\n')
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]
            if (line.indexOf('data:') !== 0) continue
            var json = line.slice(5).trim()
            if (!json) continue
            var message
            try {
              message = JSON.parse(json)
            } catch (error) {
              continue
            }
            if (message.type === 'context-state') {
              if (!askController.signal.aborted && env.state.turns === requestTurns && env.state.cacheKey === requestKey) {
                env.state.contextState = readContextState(message.state)
              }
            } else if (message.type === 'material-restored') {
              var material = message.attachment
              if (!askController.signal.aborted && material && (material.kind === 'image' || material.kind === 'file') && material.ref && material.ref.attachmentId) {
                if (!questionTurn.attachments.some(function (a) { return a.kind === material.kind && a.ref.attachmentId === material.ref.attachmentId })) questionTurn.attachments.push(material)
              }
            } else if (message.type === 'delta') {
              // 正文开始到达 → 撤掉"正在整理结论…"这类过程提示（以前它永远挂着）
              env.clearTransientNotice(answerTurn)
              if (!answerTurn.text.trim()) answerTurn.asking = false
              answerTurn.text += message.text
              scheduleTurnsRender()
            } else if (message.type === 'thought') {
              // 追问也能看到"在想什么"；只改文本，不重绘
              answerTurn.thought = (answerTurn.thought + message.text).slice(-400)
            } else if (message.type === 'start') {
              if (message.effort) answerTurn.effort = String(message.effort)
            } else if (message.type === 'drop') {
              // 同首轮：工具轮里的旁白不算答案，撤回去并挂到思考尾巴上
              var askDrop = typeof message.chars === 'number' ? message.chars : 0
              var askDropText = typeof message.text === 'string' ? message.text : ''
              var askDropped = ''
              if (askDropText && answerTurn.text.length >= askDropText.length && answerTurn.text.slice(-askDropText.length) === askDropText) {
                askDropped = askDropText
                answerTurn.text = answerTurn.text.slice(0, answerTurn.text.length - askDropText.length)
              } else if (askDrop > 0 && answerTurn.text.length > 0) {
                askDropped = answerTurn.text.slice(Math.max(0, answerTurn.text.length - askDrop))
                answerTurn.text = answerTurn.text.slice(0, Math.max(0, answerTurn.text.length - askDrop))
              }
              if (askDropped.trim()) answerTurn.thought = (answerTurn.thought + ' ' + askDropped.replace(/\s+/g, ' ')).slice(-400)
              env.renderTurns()
            } else if (message.type === 'tool') {
              // 追问里的检索同样只留状态，不留日志
              env.applyToolEvent(message)
            } else if (message.type === 'strip') {
              // host 判定"这段是模型写进正文的思考"：从已流出的正文里把这段前缀撤掉
              var stripText = typeof message.text === 'string' ? message.text : ''
              if (stripText && answerTurn.text.indexOf(stripText) === 0) {
                answerTurn.text = answerTurn.text.slice(stripText.length)
                env.renderTurns()
              }
            } else if (message.type === 'notice') {
              // host 发现档位被上游拒绝（400/401/500）会自动去掉档位重试，这里如实告诉用户，
              // 并把"这个模型不吃这个档位"记下来 —— 下次不再拿同一个组合去撞墙
              answerTurn.notice = String(message.text || '')
              // 记下 code：'conclusion-retry' 是"进行中"状态，正文到了/本轮结束就该撤
              answerTurn.noticeCode = String(message.code || '')
              if ((message.code === 'effort-rejected' || message.code === 'reasoning-leak') && message.tier) {
                // 记下"这个模型的这一档被拒 / 会泄漏"，菜单里给它划一道斜线（下次不再撞）
                env.rememberBadTier(message.tier, message.code === 'reasoning-leak' ? 'leak' : 'rejected')
                // **不动**用户选的那一格：设置页与菜单读的就是它（唯一一份数据），
                // 悄悄清掉会让人以为自己没选过；这一轮该发什么由 host 的换档重试兜。
                env.paintModelPill()
              }
              scheduleTurnsRender()                } else if (message.type === 'error') {
              if (message.code === 'context-rejected') { questionTurn.contextExcluded = true; answerTurn.contextExcluded = true }
              finish(message.message || '模型返回错误')
            }
          }
        }
        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              if (buffer.trim()) handle(buffer)
              if (!answerTurn.error) finish(null)
              return
            }
            buffer += decoder.decode(result.value, { stream: true })
            var index
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              var block = buffer.slice(0, index)
              buffer = buffer.slice(index + 2)
              handle(block)
            }
            return pump()
          })
        }
        return pump()
      })
      .catch(function (error) {
        finish(String((error && error.message) || error))
      })
  }

  /** 等待提示要不要显示"正在检索资料"（默认共用全局的检索开关）。 */
  function toolBusyNow() {
    return !!env.state.toolBusy
  }

  /**
   * 等待特效：呼吸点 + 文案 + 实时秒数 + 慢速流光条。
   *
   * 用**注册表**而不是单个引用：首轮解读和追问可能同时在跑，各自有自己的起始时间、
   * 推理档位和思考尾巴，不能互相盖。关键仍然是**同处同文案复用节点**——每帧重建会让
   * CSS 动画从 0% 重来，看起来就是"一直在闪"。
   */
  /**
   * 追问流式期间**限速重绘**：整块重建气泡 + 重新语法高亮很贵，
   * 一条 6KB 网页回答按每 delta 重绘会造 **22 万个 DOM 节点**（实测），小窗就是卡在这里。
   * 限到 ~11 次/秒：观感上仍是流式，节点量降一个数量级；收尾那一次照旧立刻重绘。
   */
  function scheduleTurnsRender() {
    if (env.turnsRenderPending) return
    var wait = Math.max(0, env.lastTurnsRenderAt + env.STREAM_RENDER_MS - Date.now())
    env.turnsRenderPending = true
    env.later(function () {
      env.turnsRenderPending = false
      env.lastTurnsRenderAt = Date.now()
      env.renderTurns()
    }, wait)
  }

  function showWaiting(container, label, options) {
    var text = label || '正在生成…'
    var opts = options || {}
    var entry = null
    for (var i = 0; i < env.waitList.length; i += 1) {
      if (env.waitList[i].host === container) {
        entry = env.waitList[i]
        break
      }
    }
    if (
      entry &&
      entry.label === text &&
      entry.node &&
      entry.node.parentNode === container &&
      container.children.length === 1
    ) {
      entry.startedAt = opts.startedAt || entry.startedAt
      updateWaitClocks()
      return entry
    }
    container.textContent = ''
    var wrap = el('div', 'dsh-sel-wait')
    var line = el('div', 'dsh-sel-waitline')
    var dots = el('span', 'dsh-sel-dots')
    dots.appendChild(el('i'))
    dots.appendChild(el('i'))
    dots.appendChild(el('i'))
    line.appendChild(dots)
    line.appendChild(el('span', null, text))
    var clock = el('span', 'dsh-sel-waitclock', '')
    line.appendChild(clock)
    wrap.appendChild(line)
    var hint = el('div', 'dsh-sel-waithint', '')
    wrap.appendChild(hint)
    var row = el('div', 'dsh-sel-skrow')
    var widths = ['100%', '66%']
    for (var b = 0; b < widths.length; b += 1) {
      var bar = el('div', 'dsh-sel-sk')
      bar.style.width = widths[b]
      row.appendChild(bar)
    }
    wrap.appendChild(row)
    container.appendChild(wrap)
    if (!entry) {
      entry = { host: container }
      env.waitList.push(entry)
    }
    entry.node = wrap
    entry.label = text
    entry.clock = clock
    entry.hint = hint
    entry.startedAt = opts.startedAt || Date.now()
    entry.effort = opts.effort || ''
    entry.effortOf = opts.effortOf || null
    entry.thoughtOf = opts.thoughtOf || null
    entry.noticeOf = opts.noticeOf || null
    entry.busyOf = opts.busyOf || toolBusyNow
    updateWaitClocks()
    return entry
  }

  /** 清掉等待节点（可按容器清，也可全清）。节点被别的渲染顶掉时 entry 会被自动回收。 */
  function clearWaiting(container) {
    for (var i = env.waitList.length - 1; i >= 0; i -= 1) {
      var entry = env.waitList[i]
      if (container && entry.host !== container) continue
      if (entry.node && entry.node.parentNode) entry.node.parentNode.removeChild(entry.node)
      env.waitList.splice(i, 1)
    }
  }

  /** 秒数/思考尾巴由 200ms 的 ticker 直接写字（不重建 DOM，动画不中断）。 */
  function updateWaitClocks() {
    for (var i = env.waitList.length - 1; i >= 0; i -= 1) {
      var entry = env.waitList[i]
      if (!entry.node || !entry.node.parentNode) {
        // 宽限几拍再回收：新建的节点可能还没挂进 DOM（挂载与渲染是两步）
        entry.missed = (entry.missed || 0) + 1
        if (entry.missed > 3) env.waitList.splice(i, 1)
        continue
      }
      entry.missed = 0
      var seconds = entry.startedAt ? (Date.now() - entry.startedAt) / 1000 : 0
      if (entry.clock) entry.clock.textContent = seconds >= 0.3 ? seconds.toFixed(1) + 's' : ''
      if (!entry.hint) continue
      var thinking = entry.thoughtOf ? String(entry.thoughtOf() || '') : ''
      thinking = thinking.replace(/\s+/g, ' ').trim()
      var notice = entry.noticeOf ? String(entry.noticeOf() || '') : ''
      notice = notice.replace(/\s+/g, ' ').trim()
      if (entry.busyOf && entry.busyOf()) {
        // 检索阶段：只说"在查资料"。查询词/命中/链接都不进小窗（那是模型的原料，不是结果）
        entry.hint.textContent = '🔍 正在检索资料…'
      } else if (notice) {
        // host 的"正在换档重试 / 上游偶发错误"比思考尾巴更该让人看见（它解释了这段时间去哪了）
        entry.hint.textContent = '↻ ' + notice.slice(-72)
      } else if (thinking) {
        // 看得见它在想什么，就不会以为"没反应"了
        entry.hint.textContent = '💭 ' + thinking.slice(-72)
      } else {
        // 等过 6 秒就说明一句"这是正常的"，否则用户只会觉得卡住了
        var effort = entry.effortOf ? String(entry.effortOf() || '') : entry.effort
        entry.hint.textContent = seconds >= 6 ? '推理档位 ' + (effort || 'high') + '：首字通常 4–8 秒' : ''
      }
    }
  }

  function runRequest(payload, cacheKey, options) {
    // 捕获"这一枪属于哪段对话"：小窗关掉后虽然还会继续跑，但用户可能已经换了下一段
    var requestTurns = env.state.turns
    var requestKey = cacheKey
    env.state.cacheState = 'miss'
    if (env.state.request) env.state.request.abort()
    var controller = new AbortController()
    env.state.request = {
      abort: function () {
        try {
          controller.abort()
        } catch (error) {
          /* noop */
        }
      },
    }
    env.state.raw = ''
    env.state.phase = 'loading'
    env.state.error = ''
    env.state.chars = 0
    env.state.fromCache = false
    env.state.sharedCache = false
    env.state.toolBusy = false
    env.state.aborted = false
    env.state.stageEffort = ''
    env.state.thought = ''
    env.state.notice = ''
    env.state.tools = []
    env.state.startedAt = Date.now()
    env.state.elapsed = 0
    env.paint()

    var ticker = env.timerScope.interval(function () {
      env.paintPill()
      if (env.state.phase === 'loading' || env.state.phase === 'streaming') {
        env.setStatus(env.progressText())
        // 卡片里的等待特效也走秒（只改文本、不重建节点 → 动画不中断）
        updateWaitClocks()
      }
    }, 200)

    function stopTicker() {
      env.timerScope.clear(ticker)
    }

    function fail(message) {
      if (env.state.phase === 'done') return
      // 用户收起小窗导致的中止：不算失败，记成"已停止"，重开还能接着看
      env.state.phase = env.state.aborted ? 'paused' : 'error'
      env.state.error = env.state.aborted ? '' : message
      // 一轮失败/中止结束 → 同样把光标交回输入框，用户可以直接重试或换个问法
      env.askFocusAfterTurn()
      env.state.toolBusy = false
      env.state.elapsed = Date.now() - env.state.startedAt
      stopTicker()
      env.state.request = null
      clearWaiting()
      env.paint()
    }

    function succeed() {
      env.state.phase = 'done'
      // 一轮成功结束 → 光标交回输入框（小窗自己的规则，见 askFocusAfterTurn）
      env.askFocusAfterTurn()
      // 按内容归并（stage 只决定"请求哪一节"，不决定结果落到哪个格子）：
      // 模型偶尔会两节都写，或没写标题，这里都要接住
      var parsed = splitSections(env.visibleRaw())
      var translation = parsed.translation.trim()
      var detail = parsed.detail.trim()
      var loose = parsed.other.trim()
      if (!translation && !detail && loose) {
        if (env.state.stage === 'detail') detail = loose
        else translation = loose
      }
      if (translation) env.state.parts.translation = translation
      if (detail) env.state.parts.detail = detail
      env.state.elapsed = Date.now() - env.state.startedAt
      env.state.chars = env.state.raw.length
      env.state.toolBusy = false
      stopTicker()
      env.state.request = null
      clearWaiting()
      if (cacheKey) env.cache.set(cacheKey, { parts: { ...env.state.parts }, turns: env.state.turns.slice() })
      // 小窗关掉也继续落盘；只有"已经换了一段对话"时才不写（避免把旧内容写到新对话上）
      if (env.state.turns === requestTurns && env.state.cacheKey === requestKey) env.saveHistory()
      env.paint()
    }

    /** 本次 read 是否带来会改变画面的内容（思考流不改变画面 → 不触发重绘）。 */
    var dirty = false

    function handleEvent(block) {
      var lines = block.split('\n')
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        if (line.indexOf('data:') !== 0) continue
        var json = line.slice(5).trim()
        if (!json) continue
        var message
        try {
          message = JSON.parse(json)
        } catch (error) {
          continue
        }
        if (message.type === 'start') {
          env.state.model = message.model ? message.provider + ' · ' + message.model : message.provider || ''
          if (message.stage) env.state.stage = message.stage
          if (message.effort) env.state.stageEffort = String(message.effort)
          if (message.cached) {
            env.state.sharedCache = true
            env.state.cacheState = 'shared'
          }
          if (env.state.phase === 'loading') env.state.phase = 'streaming'
          dirty = true
          updateWaitClocks()
        } else if (message.type === 'delta') {
          env.state.raw += message.text
          env.state.phase = 'streaming'
          // 正文到了 = 那次换档重试成功了，等待提示里那句"已自动重试"不必再挂着
          env.state.notice = ''
          dirty = true
        } else if (message.type === 'notice') {
          // host 的"正在换档重试 / 上游偶发错误"：以前这条分支不存在，全被丢掉。
          // 不 schedulePaint：由 200ms 的 ticker 写字，和 thought 同一条路。
          env.state.notice = String(message.text || '')
        } else if (message.type === 'thought') {
          // 只留尾巴：等待提示里显示"正在想什么"，不给正文添乱；
          // 刻意不 schedulePaint —— 由 200ms 的 ticker 写字，思考流不会把界面刷爆
          env.state.thought = (env.state.thought + message.text).slice(-400)
        } else if (message.type === 'drop') {
          // 这一轮的正文本是"过程旁白"（要调工具之前先念叨的那段）→ 从正文里撤回，
          // 挪到等待提示的思考尾巴上（它确实是模型在想什么，只是不该当答案）
          var dropChars = typeof message.chars === 'number' ? message.chars : 0
          var dropText = typeof message.text === 'string' ? message.text : ''
          var dropped = ''
          // 优先按"精确后缀"撤：host 给的就是这一轮流出来的原文，不依赖字数算得准不准；
          // 对不上（比如客户端缓存过的老会话）再退化成按字数截
          if (dropText && env.state.raw.length >= dropText.length && env.state.raw.slice(-dropText.length) === dropText) {
            dropped = dropText
            env.state.raw = env.state.raw.slice(0, env.state.raw.length - dropText.length)
          } else if (dropChars > 0 && env.state.raw.length > 0) {
            dropped = env.state.raw.slice(Math.max(0, env.state.raw.length - dropChars))
            env.state.raw = env.state.raw.slice(0, Math.max(0, env.state.raw.length - dropChars))
          }
          if (dropped.trim()) env.state.thought = (env.state.thought + ' ' + dropped.replace(/\s+/g, ' ')).slice(-400)
          dirty = true
        } else if (message.type === 'tool') {
          // 工具事件只更新内部状态（digest + 检索中标记），不落 DOM
          env.applyToolEvent(message)
          dirty = true
        } else if (message.type === 'error') {
          fail(message.message || '模型返回错误')
        } else if (message.type === 'done') {
          succeed()
        }
      }
    }

    var lastPaintAt = 0

    function schedulePaint() {
      if (env.rafPending) return
      env.rafPending = true
      var run = function () {
        requestAnimationFrame(function () {
          env.rafPending = false
          lastPaintAt = Date.now()
          if (env.state.phase === 'streaming' || env.state.phase === 'loading') {
            env.state.elapsed = Date.now() - env.state.startedAt
            env.state.chars = env.state.raw.length
          }
          env.paint()
          // 复核放在**绘制之后**：内容这时候才在 DOM 里，面板这一帧长高的量当场就能夹住
          //（放在 paint 开头会晚一帧——那帧量到的还是旧高度，实测过）。
          // 位置只在开窗/拖拽/窗口 resize 时夹过，内容长高这条路径原先没人管 ——
          // 面板是 position:fixed、页面不滚，顶出去那截（回复框）就点不到了。
          env.ensurePanelInsideViewportNow()
        })
      }
      // 流式期间限速（同 scheduleTurnsRender）：长内容每帧整块重建会把小窗拖卡
      var wait = env.state.phase === 'streaming' ? Math.max(0, lastPaintAt + env.STREAM_RENDER_MS - Date.now()) : 0
      if (wait > 0) env.later(run, wait)
      else run()
    }

    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then(function (response) {
        if (!response.ok) {
          return response
            .json()
            .catch(function () {
              return {}
            })
            .then(function (data) {
              throw new Error(data && data.error ? data.error : 'HTTP ' + response.status)
            })
        }
        if (!response.body || !response.body.getReader) {
          return response.text().then(function (text) {
            text.split('\n\n').forEach(handleEvent)
            succeed()
          })
        }
        var reader = response.body.getReader()
        var decoder = new TextDecoder()
        var buffer = ''
        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              if (buffer.trim()) handleEvent(buffer)
              if (env.state.phase !== 'done' && env.state.phase !== 'error') succeed()
              return
            }
            buffer += decoder.decode(result.value, { stream: true })
            var index
            dirty = false
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              var block = buffer.slice(0, index)
              buffer = buffer.slice(index + 2)
              handleEvent(block)
            }
            // 思考流每秒几百个事件：它只更新 ticker 写的提示行，不该把正文重绘刷爆
            if (dirty) schedulePaint()
            return pump()
          })
        }
        return pump()
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') {
          // 两种中止要分开：
          //  ① 被"重新生成"顶掉 —— state.request 已经指向新请求，什么都别做，新请求会接管画面；
          //  ② 用户收起小窗 —— state.request 已被 closePanel 清空，记成「已停止」，
          //     这样点胶囊回来还能看到进度并在原地重新生成（以前这里一律 return，
          //     结果收起小窗后状态永远停在 streaming，重开是个永不结束的等待动画）。
          if (env.state.aborted) fail('中止')
          return
        }
        fail(String((error && error.message) || error))
      })
  }

  /** 把这次解读（选中文字 + 两节结论 + 追问）升格成正式会话，建在来源会话同一个项目下。 */
  function promote() {
    if (env.state.promoting) return
    var payload = env.state.payload
    if (!payload) return
    // 用分阶段保存的结果：展开详解后 state.raw 里只有详解那一段，
    // 直接拿 raw 解析会导致翻译丢失（升格出来的会话里翻译变成「未记录」）
    var sections = {
      translation: env.state.parts.translation || splitSections(env.state.raw).translation,
      detail: env.state.parts.detail || splitSections(env.state.raw).detail,
    }
    env.state.promoting = true
    env.promoteButton.disabled = true
    env.setStatus('正在升格为会话…')
    fetch(PROMOTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: env.panelOrCurrentSessionId(),
        text: payload.text,
        context: payload.context,
        label: payload.label,
        translation: (sections.translation || '').trim(),
        detail: (sections.detail || '').trim(),
        // 带引用块的轮次：升格出来的会话里，用户当时发的就是拼好的那份
        turns: env.exportTurns(),
      }),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok || !data || data.ok !== true) {
            throw new Error((data && data.error) || 'HTTP ' + response.status)
          }
          return data
        })
      })
      .then(function (data) {
        env.state.promoting = false
        env.promoteButton.disabled = false
        var newId = String(data.sessionId || '')
        env.saveHistory({ pinned: true })
        env.setStatus('已升格为会话：' + newId.slice(0, 18) + '…')
        // 跳到新会话（同项目），并把小窗收起来
        openSession(newId)
        env.later(function () {
          env.closePanel()
        }, 120)
      })
      .catch(function (error) {
        env.state.promoting = false
        env.promoteButton.disabled = false
        env.setStatus('升格失败：' + String((error && error.message) || error))
      })
  }

  /** 让前端跳到新会话（GUI 会切成那个会话）。 */
  function openSession(sessionId) {
    if (!sessionId) return
    try {
      var sessions = env.ctx.get('sessions')
      if (sessions && typeof sessions.open === 'function') {
        sessions.open(sessionId)
        return
      }
      var workspace = env.ctx.get('uiWorkspace')
      if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
    } catch (error) {
      /* 跳转失败不影响会话已创建的事实 */
    }
  }

  /** 第二阶段：加载完整会话背景（24 条）并生成详解。 */
  function expandDetail() {
    var payload = env.state.payload
    if (!payload || env.state.parts.detail) return
    env.state.stage = 'detail'
    env.state.raw = ''
    // 不再带 refresh：详解请求也允许命中 host 结果缓存（背景变了 key 自然就变了）；
    // 并且把结果写回本地缓存 —— 以前传 null，导致"同一个词每次展开详解都要重跑一遍"
    env.state.payload = env.buildPayload(payload.text, payload.context, payload.label, false, 'detail')
    runRequest(env.state.payload, env.state.cacheKey)
  }

  function regenerate() {
    var payload = env.state.payload
    if (!payload) return
    env.state.fromCache = false
    // 重新生成：回到第一阶段（仅翻译），并清掉已生成的详解
    env.state.parts = { translation: '', detail: '' }
    env.state.stage = 'translation'
    env.state.payload = env.buildPayload(payload.text, payload.context, payload.label, true, 'translation')
    runRequest(env.state.payload, env.state.cacheKey)
  }
  return {
    autoGrowAskBox,
    promote,
    regenerate,
    expandDetail,
    ask,
    refreshAskState,
    isGenerating,
    stopCurrent,
    sendAsk,
    runRequest,
    showWaiting,
    clearWaiting,
  }
}
