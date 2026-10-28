import { handlePanelEscape, handleVoiceCardEscape } from './keyboard.js'
import { listen, clamp } from './dom.js'

import { previewFrames, applyPreviewHeight } from './render.js'

/** @param {import('./controller-contracts.js').ClientEventsEnv} env */
export function bindClientEvents(env) {

  /**
   * 帧内桥报过来的选区：换算坐标 → 复用同一套浮标与面板。
   *
   * 只认"我们桥过的帧"发来的消息（`frameBySource`）。
   * 小窗开着时它走**引用**那条路（划侧边栏网页里的文字，同样能挂进输入框）；
   * 小窗关着时才是「✦ 解读」（要划新词开新窗，先按 Esc 收起当前这扇）。
   */
  var offBridgeMessage = listen(window, 'message', function (event) {
    var data = event && event.data
    if (!env.previewController.bridgeOn || !data || data.__dshSel !== 1) return
    var frame = env.previewController.frameBySource(event.source)
    if (!frame) return
    // 这条消息本身就是"用户此刻正在那个网页里"的证据（见 hasFocusEvidence）
    env.previewController.frameTouchedAt.set(frame, Date.now())
    if (data.kind === 'press') {
      // 帧内按下：与主会话一致——先收浮标。父页面收不到帧内的 mousedown，
      // 少了这一条，在网页里点一下（取消选区、点别处、点另一个网页）浮标就赖着不走。
      if (env.state.selection && env.state.selection.source === 'iframe' && env.state.selection.frame !== frame) {
        // 点的是**另一个**帧：那条选区已经不是用户此刻在看的了，连状态一起清
        env.state.selection = null
        env.state.bridgeActive = false
      }
      env.selectionController.hideButton()
      env.voiceCardController.hideQuoteButton()
      // 卡片开着时同理要收卡片（与主会话"点别处就收卡"同一条规则：那边靠 document 上的
      // mousedown，帧内的点击父页面收不到）。suppress 也要置上，否则下一拍轮询发现
      // "还在录"会把卡片又弹回来 —— Esc 那条路同样是这么处理的。
      if (env.voiceCardController.vcardState.open && env.state.selection && env.state.selection.frame === frame) {
        env.voiceCardController.vcardState.suppress = true
        env.voiceCardController.closeVCard(true)
      }
      return
    }
    if (data.kind === 'clear') {
      if (env.state.selection && env.state.selection.frame === frame) {
        env.state.bridgeActive = false
        // ⚠️ 卡片开着时**不清选区**：抢焦点必然让帧内选区塌掉（输入法上屏要的正是焦点），
        // 桥于是报 clear —— 但用户选的那段文字仍然是这一轮的解读对象（发送时要用它，
        // 麦克风轮询也要靠 state.selection 判断"说完了没有"）。
        // 本文档那条路是一致的：顶层选区被抢焦点搞塌时也只收浮标，不清 state.selection。
        if (!env.voiceCardController.vcardState.open) env.state.selection = null
        env.selectionController.hideButton()
        env.voiceCardController.hideQuoteButton()
      }
      return
    }
    if (data.kind !== 'selection' || !data.sel) return
    if (!frame.isConnected) return
    var text = String(data.sel.text || '')
    if (!text.trim() || text.length > env.preferences.maxSelectionChars) return
    var rect = env.previewController.mapFrameRect(frame, data.sel.rect)
    if (!rect) {
      // 选区滚出帧的可视区：把浮标收掉（帧内再滚回来会重新报）
      if (env.state.selection && env.state.selection.frame === frame) {
        env.selectionController.hideButton()
        env.voiceCardController.hideQuoteButton()
      }
      return
    }
    env.state.selection = {
      text: text.trim(),
      /** 'document'（顶层选区，缺省）| 'iframe'（侧边栏网页，上下文由帧内桥给）。 */
      source: 'iframe',
      frame: frame,
      rect: rect,
      frameRect: data.sel.rect,
      context: String(data.sel.context || ''),
      keyContext: String(data.sel.keyContext || ''),
      label: env.previewController.labelForFrame(frame, data.sel.label),
    }
    env.state.bridgeActive = true
    // 卡片开着时，帧内的重报（滚动 / 改尺寸 / 挪选区）只是"那段文字动了"：
    // 跟着挪卡片与锚点，**不要**再浮出浮标（浮标与卡片是互斥的两态）。
    if (env.voiceCardController.vcardState.open) {
      if (env.state.selection.frame === frame) {
        env.voiceCardController.vcardState.anchorRect = rect
        env.voiceCardController.repositionVCard()
        return
      }
      // 另一帧报了新选区：这张卡已经不是用户在看的东西了，收掉再按新选区走
      env.voiceCardController.closeVCard(true)
    }
    if (env.runtime.panelOpen) {
      // 小窗开着：帧内这条选区也只是"一段可以引用的文字"（上下文由帧内的桥给）
      env.state.quoteSelection = {
        text: text.trim(),
        label: env.state.selection.label || '侧边栏网页',
        source: 'iframe',
        rect: rect,
        context: String(env.state.selection.context || ''),
        turnIndex: -1,
      }
      env.selectionController.showQuoteButton(rect)
      return
    }
    env.selectionController.showButton(rect)
  })

  // —— 事件 ——

  // 动画结束就摘掉动效类：`.dsh-sel-btn-pop` 用了 fill:both，
  // 不摘的话 transform 会一直被动画钉在 none 上，`:active` 的按压缩放就永远不生效
  var offPopEnd = listen(env.button, 'animationend', function () {
    env.selectionController.setButtonPop(false)
  })

  var offQuotePopEnd = listen(env.quoteButton, 'animationend', function () {
    env.selectionController.setQuotePop(false)
  })

  var offMouseUp = listen(document, 'mouseup', function (event) {
    env.selectPressedAt = 0
    // 面板里的 mouseup **也要走一次检查**：小窗开着时"划小窗正文"正是「引用」的主入口
    // （早先这里对面板直接 return —— 那是"面板里划词一律不管"年代的写法，
    //  结果就是小窗里划词毫无反应，只有气泡末尾的「引用整条」能用）。
    if (env.button.contains(event.target) || env.quoteButton.contains(event.target)) return
    env.selectionController.scheduleCheck()
  }, true)

  var offKeyUp = listen(document, 'keyup', function (event) {
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Meta' || event.key.indexOf('Arrow') === 0) {
      env.selectionController.scheduleCheck()
    }
  }, true)

  /**
   * 选中的文字**没了** → 浮标跟着消失。
   *
   * 为什么非要有这一条：浮标只在 mouseup 和少数几个键的 keyup 之后被检查，
   * 而"把选中的字删掉"这两种动作都不在那条路径上 ——
   *   · Backspace / Delete / 直接打字覆盖 / 剪切 / 撤回（⌘Z）；
   *   · 内容刷新把选中的节点整个换掉（流式回答重渲染、消息重画）。
   * 于是浮标赖在屏幕上不走，点下去还会解读一段**屏幕上已经不存在**的文字（用户报的正是这个）。
   *
   * `selectionchange` 是浏览器对"选区变了"最权威的信号（塌陷 / 被删 / 被程序改动都会发），
   * 用它兜住所有非鼠标路径；节点被摘掉但选区没塌陷那种（Firefox）另有 selectionDetached 判死。
   */
  var offSelectionChange = listen(document, 'selectionchange', function () {
    if (env.selectPressing()) return
    env.selectionController.scheduleCheck()
  }, true)

  /**
   * Esc 收语音卡。
   *
   * 用 capture 抢在最前面：卡片是当下最内层的东西，Esc 该先退它
   * （小窗那套 Esc 是"从最内层往外退"，这里是同一条规则往外多包一层）。
   * 已经说出来的字**丢掉**：卡还没发出去，取消就是取消；要留着就先点发送。
   */
  var offVoiceEscape = listen(document, 'keydown', function (event) { handleVoiceCardEscape(event, { document: document, vcardState: env.voiceCardController.vcardState, closeVCard: env.voiceCardController.closeVCard }) }, true)

  var offMouseDown = listen(document, 'mousedown', function (event) {
    env.selectPressedAt = Date.now()
    var target = event.target
    // 模型菜单：点它自己和胶囊之外**任何地方**都收起。
    // 必须放在最前面 —— 下面的 historyButton / pill / panel 分支都会 return，
    // 放在后面就会被短路掉（实测：点了别处菜单不关）。
    if (env.modelMenu.getAttribute('data-open') === '1' && !env.modelMenu.contains(target) && !env.modelPill.contains(target)) {
      env.modelsController.closeModelMenu()
    }
    if (env.historyList.contains(target)) return // 列表内部：行自己处理
    if (env.historyButton.contains(target)) return // 「最近」开关自己 toggle
    if (env.button.contains(target)) return // 浮标
    if (env.quoteButton.contains(target)) return // 引用浮标：点它不能先把自己收掉
    // 状态胶囊：它自己就是开关，点它的 mousedown 不能被当成"点了外面"（否则先关后开，看着像没反应）
    if (env.pill.contains(target)) return
    // 到这里说明点的不是侧边栏本身：**含面板正文**（消息区/输入框/选中文字）在内，
    // 一律先把侧边栏收回——它是用完就走的导航，不该等你点了"外面"才收。
    env.historyController.hideHistoryList()
    if (env.panel.contains(target)) return // 面板内的点击只收侧边栏，不关面板
    env.selectionController.hideButton()
    env.voiceCardController.hideQuoteButton()
    // 点面板外**不关小窗**（无论有没有追问过）：答案留在原地，只有 ✕ / Esc / 胶囊能收。
    // 曾经的规则是"没追问过才关"，但那会让用户在读第一屏翻译时被误关（点一下别处就没了）。
  }, true)

  // 让按钮吞掉 mousedown：点击时不破坏选区高亮
  var offButtonDown = listen(env.button, 'mousedown', function (event) {
    event.preventDefault()
    event.stopPropagation()
  })

  var offButtonClick = listen(env.button, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    var selection = env.state.selection
    if (selection) env.panelController.openForSelection(selection)
  })

  // 引用浮标：吞掉 mousedown（点了不能把选区打散、也不能让面板失焦），
  // 点一下 = 把这段文字挂进输入框的引用区，然后自己收起来（"已经进去了"的信号）
  var offQuoteDown = listen(env.quoteButton, 'mousedown', function (event) {
    event.preventDefault()
    event.stopPropagation()
  })

  var offQuoteClick = listen(env.quoteButton, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    var selection = env.state.quoteSelection
    if (!selection) return
    // 上下文在这里才采：引用**当时**在哪一段对话里，是这条引用最有用的信息
    env.quotesController.addQuote(selection.text, selection.label, env.quotesController.quoteContextFor(selection))
    env.voiceCardController.hideQuoteButton()
  })

  var offScroll = listen(window, 'scroll', function (event) {
    env.selectionController.hideButton()
    env.voiceCardController.hideQuoteButton()
    // 页面/面板滚动也收回侧边栏；滚动列表自身不算（它有自己的滚动条）。
    // event.target 不一定是 Node（合成事件可能是 window），contains 会抛，得自己挡一道
    var target = event && event.target
    var insideList = !!(target && target.nodeType && env.historyList.contains(target))
    if (env.historyList.style.display === 'flex' && !insideList) env.historyController.hideHistoryList()
  }, true)

  var offModelPill = listen(env.modelPill, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    env.modelsController.modelPillClicks += 1
    if (env.modelMenu.getAttribute('data-open') === '1') env.modelsController.closeModelMenu()
    else env.modelsController.openModelMenu()
  })

  var offModelMenu = listen(env.modelMenu, 'click', function (event) {
    event.stopPropagation() // 菜单内部点击不要触发"点到外面"
  })

  var offModelKeys = listen(env.modelMenu, 'keydown', function (event) {
    if (event.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]')) env.modelsController.closeModelMenu()
  })

  // 点哪一格就选哪一格（不再"点一下翻转"）——分段控件的标准行为
  var offCellMd = listen(env.cellMd, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    env.modelsController.setPref(false)
  })

  var offCellWeb = listen(env.cellWeb, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    env.modelsController.setPref(true)
  })

  // 键盘：左右方向键在两格间切换（radiogroup 惯例；Enter/Space 由 button 原生支持）
  var offPrefKeys = listen(env.prefSeg, 'keydown', function (event) {
    var key = event && event.key
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
    event.preventDefault()
    env.modelsController.setPref(key === 'ArrowRight', true)
  })

  var offPillDown = listen(env.pill, 'mousedown', function (event) {
    // 拖拽/划词的手势不该被胶囊接走
    event.preventDefault()
    event.stopPropagation()
    env.pillController.beginPillDrag(event)
  })

  var offPillClick = listen(env.pill, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    // 刚拖完的那一下不算点击（否则拖到别处会顺手把抽屉开开关关）
    if (env.pillState.pillDragMoved) {
      env.pillState.pillDragMoved = false
      return
    }
    env.pillController.reopenLast()
    env.pillController.notePillActivity()
  })

  // 鼠标停在上面就不收球（要"点得到"，不是"藏起来"）；离开时重新开始静置计时
  var offPillEnter = listen(env.pill, 'mouseenter', function () {
    env.pillState.pillHover = true
    env.pillController.notePillActivity()
  })

  var offPillLeave = listen(env.pill, 'mouseleave', function () {
    env.pillState.pillHover = false
    env.pillController.notePillActivity()
  })

  var offPillKey = listen(env.pill, 'keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    env.pillController.reopenLast()
    env.pillController.notePillActivity()
  })

  /**
   * 预览页把自身高度报过来（见 adaptPreviewHtml 注入的 hook）→ 直接长到内容那么高，
   * 框里就不会出现那条碍眼的滚动条；超过上限才回落成内部滚动（上限跟着面板可视高度走）。
   */
  var offPreviewHeight = listen(window, 'message', function (event) {
    var data = event && event.data
    // 用真值判断而不是 `!== true`：注入端发过 1（数字），严格相等会把自家消息挡掉（实测踩过）
    if (!data || !data.__dshPreview) return
    var item = previewFrames[String(data.id || '')]
    if (!item || !item.frame) return
    var frame = item.frame
    try {
      // 只认这一帧发来的（消息可以被任意页面伪造，来源必须对得上）
      if (frame.contentWindow && event.source !== frame.contentWindow) return
    } catch (error) {
      return
    }
    var reported = Math.max(140, Number(data.h) || 0)
    if (!reported) return
    var current = Number(frame.getAttribute('data-preview-h')) || 0
    if (Math.abs(reported - current) < 4) return
    frame.setAttribute('data-preview-h', String(reported))
    // 全量模式：直接长到内容高度（内部不滚动）；还原模式：清掉 inline 高度，用 CSS 的 320px
    applyPreviewHeight(frame, frame.parentNode && frame.parentNode.parentNode)
  })

  var offResize = listen(window, 'resize', function () {
    env.selectionController.hideButton()
    env.voiceCardController.hideQuoteButton()
    // 宽度变了 → 换行位置变了 → 输入框高度要重量（否则会是按旧宽度算出来的高度）
    env.conversationController.autoGrowAskBox()
    // 拖窗口变小后，面板本身也要拉回视口内（否则历史列表会跟着算到屏幕外）
    env.panelController.keepInsideViewport()
    if (env.historyList.style.display === 'flex') env.historyController.placeHistoryList()
    // 窗口尺寸变了：立刻量一次，并把节奏调回最快
    env.pillController.placePill()
    env.pillState.pillPollDelay = env.PILL_POLL_MIN
  })

  var offKeyDown = listen(document, 'keydown', function (event) { handlePanelEscape(event, { document: document, panelOpen: env.runtime.panelOpen, panel: env.panel, historyList: env.historyList, captureRow: env.captureRow, settingsOpen: env.settingsController.settingsOpen, settingsByKey: env.settingsController.settingsByKey, closeModelPicks: env.settingsController.closeModelPicks, closeSettings: env.settingsController.closeSettings, cancelVoice: env.voiceController.cancelVoice, closePanel: env.panelController.closePanel }) }, true)

  var offSettingsOpen = listen(env.settingsButton, 'click', function (event) {
    event.stopPropagation()
    if (env.settingsController.settingsOpen) env.settingsController.closeSettings()
    else env.settingsController.openSettings()
  })

  var offSettingsBack = listen(env.settingsBack, 'click', function (event) {
    event.stopPropagation()
    env.settingsController.closeSettings()
  })

  var offSettingsClose = listen(env.settingsClose, 'click', function (event) {
    event.stopPropagation()
    env.settingsController.closeSettings()
  })

  var offSettingsReset = listen(env.settingsReset, 'click', function (event) {
    event.stopPropagation()
    env.settingsController.resetSettings()
  })

  // 抽屉里不该触发起拖面板 / 划词：整个抽屉吞掉 mousedown 的冒泡
  var offSettingsStop = listen(env.settingsSheet, 'mousedown', function (event) {
    event.stopPropagation()
  })

  // 点抽屉里的空白处（正文 / 分类栏）把模型下拉收掉 —— 点菜单内部不会走到这里（行自己 stopPropagation）
  var offSettingsPickAway = listen(env.settingsSheet, 'click', function () {
    env.settingsController.closeModelPicks()
  })

  var offSettingsScrim = listen(env.settingsScrim, 'click', function (event) {
    event.stopPropagation()
    env.settingsController.closeSettings()
  })

  var offHistory = listen(env.historyButton, 'click', function (event) {
    event.stopPropagation()
    env.historyController.toggleHistoryList()
  })

  var offPromote = listen(env.promoteButton, 'click', function (event) {
    event.stopPropagation()
    env.conversationController.promote()
  })

  var offRetry = listen(env.retryButton, 'click', function (event) {
    event.stopPropagation()
    env.conversationController.regenerate()
  })

  var offExpand = listen(env.expandButton, 'click', function (event) {
    event.stopPropagation()
    env.conversationController.expandDetail()
  })

  var offAskKey = listen(env.askBox, 'keydown', function (event) {
    if (event.key !== 'Enter' || event.shiftKey) return
    // 输入法（中文/日文…）在组合期间按 Enter 是"确认候选词"，不是发送：
    // 这时 askBox.value 往往还是空的，照发会清空输入框 + 发空内容 → 看起来"没反应"
    if (event.isComposing === true || event.keyCode === 229) return
    event.preventDefault()
    event.stopPropagation()
    var question = env.askBox.value
    // 空输入框照发**只在挂了引用或附件时**成立（引用/附件本身就是用户要送出去的内容）
    if (!question.trim() && env.state.quotes.length === 0 && env.state.attachments.length === 0) return
    // 清空交给 ask()：它收下才清（生成中被拒时保留你打的字）
    env.conversationController.ask(question)
  })

  var offAskInput = listen(env.askBox, 'input', function () {
    env.conversationController.refreshAskState()
  })

  var offAskSend = listen(env.askSend, 'click', function (event) {
    event.stopPropagation()
    if (env.conversationController.isGenerating()) {
      env.conversationController.stopCurrent()
      return
    }
    var question = env.askBox.value
    if (!question.trim() && env.state.quotes.length === 0 && env.state.attachments.length === 0) return
    // 清空交给 ask()：它收下才清
    env.conversationController.ask(question)
  })

  // ── 附件：三个入口（＋ / 粘贴 / 拖放）──
  var offAttachPick = listen(env.attachInput, 'change', function () {
    env.attachController.addFiles(env.attachInput.files || [])
    // 清掉 value：同一个文件连选两次也要能触发 change（不清的话第二次选它毫无反应）
    env.attachInput.value = ''
  })

  var offAttachButton = listen(env.addButton, 'click', function (event) {
    event.stopPropagation()
    env.attachController.pick()
  })

  // 粘贴挂在**面板**上而不是输入框上：截图之后很多人不会先把光标点进输入框。
  // 纯文本粘贴不受影响（handlePaste 只在剪贴板里真有文件时才拦）。
  var offAttachPaste = listen(env.panel, 'paste', function (event) {
    env.attachController.handlePaste(event)
  })

  var offMic = listen(env.micButton, 'click', function (event) {
    event.stopPropagation()
    env.voiceController.startVoice()
  })

  // 切走这个窗口（换到别的 App）就停止录音 —— 主会话也是这么做的：
  // 人已经不在说话了，继续占着麦克风只会录一串环境噪音。识别**不打断**（那时音频已经拿到了）。
  var offVoiceBlur = listen(window, 'blur', function () {
    if (env.voiceController.voice.phase === 'recording') env.voiceController.cancelVoice()
  })

  var offVoiceCancel = listen(env.voiceCancel, 'click', function (event) {
    event.stopPropagation()
    // feedback 阶段点 ✕ 只是"关掉这条提示"，其余阶段是取消这次录音/识别。
    // 取消**不删字**：已经说出来的（含半句预览）一律留在输入框里。
    env.voiceController.cancelVoice()
  })

  var offVoiceStop = listen(env.voiceStop, 'click', function (event) {
    event.stopPropagation()
    env.voiceController.finishVoice()
  })

  // ═════════════════════════ 语音输入（结束） ═════════════════════════

  // 用户自己滚消息区（滚轮/触摸）→ 不再强行把他拉回底部
  var offBodyWheel = listen(env.body, 'wheel', env.historyController.noteUserScroll)

  var offBodyTouch = listen(env.body, 'touchmove', env.historyController.noteUserScroll)

  var offBodyScroll = listen(env.body, 'scroll', env.historyController.noteBodyScroll)

  var offClose = listen(env.closeButton, 'click', function (event) {
    event.stopPropagation()
    env.panelController.closePanel()
  })

  var offDrag = listen(env.head, 'mousedown', function (event) {
    if (env.promoteButton.contains(event.target) || env.closeButton.contains(event.target)) return
    if (env.settingsButton.contains(event.target) || env.historyButton.contains(event.target)) return
    event.preventDefault()
    var rect = env.panelController.panelLayoutRect()
    var offsetX = event.clientX - rect.left
    var offsetY = event.clientY - rect.top
    env.panelController.panelInteracting = true
    var move = function (moveEvent) {
      env.panel.style.left = clamp(moveEvent.clientX - offsetX, 4, window.innerWidth - rect.width - 4) + 'px'
      env.panel.style.top = clamp(moveEvent.clientY - offsetY, 4, window.innerHeight - 40) + 'px'
      if (env.historyList.style.display === 'flex') env.historyController.placeHistoryList()
    }
    var up = function () {
      window.removeEventListener('mousemove', move, true)
      window.removeEventListener('mouseup', up, true)
      env.panelController.panelInteracting = false
      // **不存位置**：拖动只对这一次有效；下次开窗仍按选区重新锚定。
    }
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mouseup', up, true)
  })

  // 窗口变小：把**尺寸**夹回可视区（位置不归这里管 —— 它由 showPanel 的锚定决定）
  var offPanelResize = listen(window, 'resize', function () {
    if (!env.panelController.panelSize || env.panelController.panelInteracting) return
    var next = env.panelController.clampPanelSize({ w: env.panelController.panelSize.w, h: env.panelController.panelSize.h })
    if (next.w === env.panelController.panelSize.w && next.h === env.panelController.panelSize.h) return
    env.panelController.panelSize = next
    env.panelController.applyPanelSizeOnOpen()
    env.panelController.clampPanelPosition()
    env.panelController.savePanelSize()
  })
  return { dispose() { offBridgeMessage(); offPopEnd(); offQuotePopEnd(); offMouseUp(); offKeyUp(); offSelectionChange(); offVoiceEscape(); offMouseDown(); offButtonDown(); offButtonClick(); offQuoteDown(); offQuoteClick(); offScroll(); offModelPill(); offModelMenu(); offModelKeys(); offCellMd(); offCellWeb(); offPrefKeys(); offPillDown(); offPillClick(); offPillEnter(); offPillLeave(); offPillKey(); offPreviewHeight(); offResize(); offKeyDown(); offSettingsOpen(); offSettingsBack(); offSettingsClose(); offSettingsReset(); offSettingsStop(); offSettingsPickAway(); offSettingsScrim(); offHistory(); offPromote(); offRetry(); offExpand(); offAskKey(); offAskInput(); offAskSend(); offAttachPick(); offAttachButton(); offAttachPaste(); offMic(); offVoiceBlur(); offVoiceCancel(); offVoiceStop(); offBodyWheel(); offBodyTouch(); offBodyScroll(); offClose(); offDrag(); offPanelResize() } }
}
