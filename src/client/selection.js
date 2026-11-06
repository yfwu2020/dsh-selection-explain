import { selectionDetached, insideEditable, clamp } from './dom.js'
import { MAX_QUOTE_SELECTION, createPreferences } from './constants.js'

/** selection state and operations; dependencies are supplied as live node/callback accessors. */
/** @param {import('./controller-contracts.js').SelectionEnv} env */
export function createSelectionController(env) {
  var preferences = env.preferences || createPreferences()

  // —— 选区 → 浮标 ——

  /**
   * 排一次选区检查（下一拍执行）。
   *
   * 同一拍里的多次请求**合并成一次**：`selectionchange` 在打字 / 流式重绘时会连发很多下，
   * 每下都排一个计时器的话 `timers` 数组会一直长（文件里别处也刻意避开这种写法，
   * 见 schedulePillIdle 的注释）。合并是安全的 —— 检查读的是"当下"的选区，
   * 而不是排队那一刻的快照。
   */
  var checkPending = false

  /**
   * 被 Esc 连带收掉的那一条选区（内置浮层消失时记下）。
   *
   * 作用：Esc 之后鼠标再松开、键盘再调整，只要选区没变就不再弹浮标；
   * 用户重新划线（选区变了）自动解除。这样两枚按钮才是真的"同生同灭"。
   */
  var dismissedRange = null

  // 宿主在 document capture 的 pointerdown 里关闭自己的浮层，早于按钮的 click。
  // 从按下到 click 结束期间固定浮标，避免观察器把点击目标藏掉或挪走。
  var floatInteracting = false
  var floatInteractionVersion = 0

  function beginFloatInteraction() {
    floatInteracting = true
    floatInteractionVersion += 1
  }

  function endFloatInteraction() {
    if (!floatInteracting) return
    var version = floatInteractionVersion
    env.later(function () {
      if (version !== floatInteractionVersion) return
      floatInteracting = false
      syncPlatformSurface()
    }, 0)
  }

  /** 两段选区是不是同一处（容器 + 偏移）。取不到容器（桩环境/异常）时一律当"不同"，不拦截。 */
  function sameRange(a, b) {
    if (!a || !b || !a.startContainer || !b.startContainer) return false
    return a.startContainer === b.startContainer && a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer && a.endOffset === b.endOffset
  }

  /** 当前本文档选区的一份克隆（取不到就 null）。 */
  function currentDocumentRange() {
    try {
      var selection = window.getSelection()
      if (!selection || !selection.rangeCount) return null
      var range = selection.getRangeAt(0)
      return typeof range.cloneRange === 'function' ? range.cloneRange() : range
    } catch (error) {
      return null
    }
  }

  function scheduleCheck() {
    if (checkPending) return
    checkPending = true
    env.later(function () {
      checkPending = false
      checkSelection()
    }, 0)
  }

  /**
   * 选区是不是落在**我们自己的界面**里（胶囊 / 面板 / 历史浮层）。
   *
   * 不加这道判断的话，在主会话里顺手划中胶囊上的文字（比如"已停止"），
   * 就会拿它当选中文字再开一个小窗——实测真踩到过：胶囊上出现「已停止 · 已停止」。
   */
  function insideOwnUI(node) {
    var current = node && node.nodeType === 3 ? node.parentNode : node
    for (var depth = 0; current && depth < 24; depth += 1) {
      var cls = typeof current.className === 'string' ? current.className : ''
      if (cls.indexOf('dsh-sel-') === 0 || cls.indexOf(' dsh-sel-') >= 0) return true
      if (current === env.layer || current === env.panel || current === env.pill) return true
      current = current.parentNode
    }
    return false
  }

  /**
   * 这一段选区是不是**小窗正文**里的（可以引用）。
   *
   * 往上走到小窗的滚动内容区（body）为止：中途碰到输入框 / 按钮 / 引用卡片本身
   * 就不算 —— 那些地方的选区要么是输入（textarea），要么引用了也没意义（"✕"这种按钮文字）。
   * 历史列表、胶囊、模型菜单都在 panel/body 之外，自然被挡掉。
   * 不用 closest()：无浏览器测试的桩 DOM 没有它，而按祖先链走一遍在两边都一样准。
   */
  function insidePanelContent(node) {
    var current = node && node.nodeType === 3 ? node.parentNode : node
    for (var depth = 0; current && depth < 32; depth += 1) {
      if (current === env.body) return true
      if (current === env.panel || current === env.layer || !env.panel.contains(current)) return false
      var tag = String(current.tagName || '').toUpperCase()
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON' || tag === 'IFRAME') return false
      var cls = typeof current.className === 'string' ? current.className : ''
      if (cls.indexOf('dsh-sel-quotes') >= 0) return false
      current = current.parentNode
    }
    return false
  }

  /**
   * 「小窗第 N 轮回答 / 提问」。
   *
   * 小窗里的引用**不带上下文**（那几轮对话本来就会随历史进模型），所以出处全靠标签说清：
   * 只写"小窗回答"太笼统 —— 第 1 轮和第 4 轮的回答是两回事。
   */
  function turnLabelOf(turn) {
    if (!turn) return '小窗内容'
    var index = env.state.turns.indexOf(turn)
    var round = 0
    for (var i = 0; i <= index && i < env.state.turns.length; i += 1) {
      if (env.state.turns[i].role === 'user') round += 1
    }
    var role = turn.role === 'user' ? '提问' : '回答'
    return round > 0 ? '小窗第 ' + round + ' 轮' + role : '小窗' + role
  }

  /** 小窗正文里这段选区的出处：回答（第 N 轮）/ 某一节 / 顶部选中文字条。 */
  function panelSourceLabel(node) {
    var current = node && node.nodeType === 3 ? node.parentNode : node
    for (var depth = 0; current && depth < 32; depth += 1) {
      if (current.__turn) return turnLabelOf(current.__turn)
      // 两节用**它们自己的标题**（标题是「翻译」/「解读」/「注释」，随选中内容变）：
      // 写死"小窗解读"会在注释节里指错地方
      if (current === env.translationSection.root) return '小窗「' + env.translationSection.title.textContent + '」节'
      if (current === env.detailSection.root) return '小窗「' + env.detailSection.title.textContent + '」节'
      var cls = typeof current.className === 'string' ? current.className : ''
      if (cls.indexOf('dsh-sel-quote') === 0) return '小窗顶部的选中文字'
      if (current === env.body || current === env.panel || !current.parentNode) break
      current = current.parentNode
    }
    return '小窗内容'
  }

  /**
   * 小窗开着时的选区检查：这时候浮标是「❝ 引用」而不是「✦ 解读」。
   *
   * 两种来源都认：
   *   ① 小窗正文里的选区（回答 / 两节 / 顶部选中文字条）→ 引用的就是小窗自己的内容；
   *   ② 主界面上的选区 → 引用主界面选中的文字。
   * 帧内（侧边栏网页）那条不在这里 —— 它由桥的 message 送过来，见 offBridgeMessage。
   */
  function checkQuoteSelection() {
    hideButton() // 小窗开着时不提供「解读」：要解读直接在输入框里问
    var selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      // 帧内那条选区还活着（本文档塌陷只是点浮标造成的）→ 留着浮标
      if (env.state.bridgeActive && env.state.selection && env.state.selection.source === 'iframe') return
      env.state.quoteSelection = null
      env.hideQuoteButton()
      return
    }
    var range
    try {
      range = selection.getRangeAt(0)
    } catch (error) {
      return
    }
    // 选中的节点被整个摘掉了（流式回答重渲染 / 消息换掉）：那段文字已经不在屏幕上
    if (selectionDetached(range)) {
      env.state.quoteSelection = null
      env.hideQuoteButton()
      return
    }
    var text = String(selection.toString() || '')
    if (!text.trim() || text.length > MAX_QUOTE_SELECTION) {
      env.state.quoteSelection = null
      env.hideQuoteButton()
      return
    }
    if (insideEditable(range.startContainer)) {
      env.state.quoteSelection = null
      env.hideQuoteButton()
      return
    }
    // 同 checkSelection：Esc 收过的那条选区不再参与（直到选区变了）
    if (dismissedRange && !sameRange(range, dismissedRange)) dismissedRange = null
    if (dismissedRange) {
      env.state.quoteSelection = null
      env.hideQuoteButton()
      return
    }
    var inPanel = insidePanelContent(range.startContainer) || insidePanelContent(range.endContainer)
    // 小窗里划词：帧内那条让位（两处同时有选区时以本文档为准）
    env.state.bridgeActive = false
    if (!inPanel && (insideOwnUI(range.startContainer) || insideOwnUI(range.endContainer))) {
      // 历史列表 / 胶囊 / 工具行的选区：引用没有意义，也不该弹浮标
      env.state.quoteSelection = null
      env.hideQuoteButton()
      return
    }
    var label = inPanel ? panelSourceLabel(range.startContainer) : '主界面选中'
    var rects = range.getClientRects()
    var rect = rects && rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      env.state.quoteSelection = null
      env.hideQuoteButton()
      return
    }
    env.state.quoteSelection = {
      text: text.trim(),
      label: label,
      source: inPanel ? 'panel' : 'document',
      rect: rect,
      // 上下文留到**点引用那一刻**才采（每次 selectionchange 都采太贵）：
      // 这里只记下"在哪一轮上"（小窗）/ 选区本身（主界面，用来采局部窗口）
      turnIndex: inPanel ? env.turnIndexOfNode(range.startContainer) : -1,
      range: inPanel ? null : safeCloneRange(range),
    }
    showQuoteButton(rect)
  }

  /** 克隆选区（桩环境/老浏览器没有 cloneRange 就返回 null，后面走"取不到上下文"那条路）。 */
  function safeCloneRange(range) {
    try {
      return typeof range.cloneRange === 'function' ? range.cloneRange() : null
    } catch (error) {
      return null
    }
  }

  function checkSelection() {
    if (env.panelOpen) {
      checkQuoteSelection()
      return
    }
    env.hideQuoteButton()
    env.state.quoteSelection = null
    var selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      // 侧边栏网页里的选区**不在本文档**：点浮标会让本文档的选区塌掉
      // （于是每次点浮标都会先跑到这里），所以只要帧内那条选区还活着就别收浮标。
      // 帧内清空选区时桥会发 clear，那里才是真正的"该收"信号。
      if (env.state.bridgeActive && env.state.selection && env.state.selection.source === 'iframe') return
      hideButton()
      return
    }
    // 本文档里出现了真选区：帧内那条让位（两处同时有选区时以本文档为准）
    env.state.bridgeActive = false
    // 划到自己界面上（胶囊/面板/历史列表）时什么都不做
    try {
      var ownRange = selection.getRangeAt(0)
      if (insideOwnUI(ownRange.startContainer) || insideOwnUI(ownRange.endContainer)) {
        hideButton()
        return
      }
    } catch (error) {
      /* 老浏览器/桩环境取不到 range 就算了，按老路子走 */
    }
    var text = String(selection.toString() || '')
    if (!text.trim() || text.length > preferences.maxSelectionChars) {
      hideButton()
      return
    }
    var range = selection.getRangeAt(0)
    // 选中的节点被整个摘掉了（流式回答重渲染 / 消息换掉）：那段文字已经不在屏幕上，
    // 浮标不该留着（否则点下去解读的是一段不存在的文字）
    if (selectionDetached(range)) {
      hideButton()
      return
    }
    if (insideEditable(range.startContainer)) {
      hideButton()
      return
    }
    // 内置浮层被 Esc 收掉时，这一条选区我们已经跟着收过一次：
    // 在用户重新划线（选区变了）之前不再弹，避免"收了又冒出来半条工具条"。
    if (dismissedRange && !sameRange(range, dismissedRange)) dismissedRange = null
    if (dismissedRange) {
      hideButton()
      return
    }
    var rects = range.getClientRects()
    var rect = rects && rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideButton()
      return
    }
    env.state.selection = { text: text.trim(), range: range.cloneRange(), rect: rect, source: 'document' }
    showButton(rect)
  }

  /** 挂/摘浮现动效（用 data 属性驱动动画，不动类名）。 */
  function setButtonPop(on) {
    if (on) env.button.setAttribute('data-pop', '1')
    else env.button.removeAttribute('data-pop')
  }

  function showButton(rect) {
    // 浮标也在同一套配色下：它的底色是"页面背景"（浮层自身透明），按它判深浅
    if (!env.panelOpen) env.layer.setAttribute('data-theme', env.currentSurfaceTheme())
    // 只在"浮现"那一次播动效；已经可见时（划选范围被拖动、键盘调整）只平移，避免一直闪
    if (placeFloat(env.button, rect)) {
      setButtonPop(false)
      void env.button.offsetWidth // 强制重排，让动画能重播
      setButtonPop(true)
    }
    watchPlatformSurface()
    // 内置浮层是 React 布局后才定位的，可能比这次 selectionchange 晚：补两拍再对齐一次
    env.later(refreshPlacement, 0)
    env.later(refreshPlacement, 80)
    // 有选区了：开始看"输入法是不是正在语音输入"（幂等，重复调用无副作用）
    env.startMicWatch()
  }

  function hideButton() {
    env.button.style.display = 'none'
    setButtonPop(false)
    // 浮标收了就没什么可等的了 —— 但语音卡开着时**不能停**：
    // 卡片本身就是"检测到开麦"的结果，它还要靠轮询判断"说完了没有"
    if (!env.vcardState.open) env.stopMicWatch()
  }

  /**
   * 宿主内置的「引用文本」浮层（DSH 0.2.2+ 的 `conversation.chat.text-interaction`）。
   *
   * 它由 ui-chat 自己绝对定位在聊天列里（z-index 6，随内容滚动），未激活时
   * `aria-hidden="true"`。这里只读它的状态当锚点 —— 不掺和它的层叠，也不改它的
   * DOM（它归 React 管，塞节点进去下次渲染就没了）。
   *
   * 为什么要区分"收掉"和"滚出视区"：
   *   · 收掉（Esc / 点别处）= `aria-hidden` 变 true，React 把内容卸了 → 这次交互结束；
   *   · 滚出视区 = 还是同一次交互，只是宿主把 `visibility` 设成 hidden（或矩形为空）。
   *     滚回来它会自己重新出现，所以我们的浮标也要跟着回来，否则又变成半条工具条。
   *
   * @returns {{rect: DOMRect|null, visible: boolean, dismissed: boolean}} 当前状态。
   */
  function surfaceSnapshot() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return { rect: null, visible: false, dismissed: true }
    }
    var node = document.querySelector('[data-text-interaction-surface]')
    if (!node) return { rect: null, visible: false, dismissed: true }
    // aria-hidden=true 才是"这次交互被收掉"；visibility/矩形为空只是"暂时看不见"
    if (node.getAttribute('aria-hidden') === 'true') return { rect: null, visible: false, dismissed: true }
    var view = node.ownerDocument && node.ownerDocument.defaultView
    if (view && typeof view.getComputedStyle === 'function') {
      try {
        if (view.getComputedStyle(node).visibility === 'hidden') return { rect: null, visible: false, dismissed: false }
      } catch (error) {
        /* 取不到样式就按可见处理，交给 rect 兜底 */
      }
    }
    var box = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
    if (!box || !box.width || !box.height) return { rect: null, visible: false, dismissed: false }
    return { rect: box, visible: true, dismissed: false }
  }

  /** 只要"看得见时的矩形"（定位用）。 */
  function platformSurface() {
    return surfaceSnapshot().rect
  }

  /**
   * 浮标定位（「解读」与「引用」两个浮标共用一套规则）。
   *
   * 有内置「引用文本」浮层时：**贴它右侧 8px、与它同一条基线**，两枚按钮读起来是一条
   * 工具条；右边放不下就翻到左边，再放不下就排到它下面（仍放不下时夹回视口）。
   * 没有内置浮层时沿用老规则：贴选区右下角，上面放不下就翻到选区下方。
   *
   * 返回"这次是从隐藏变可见" —— 调用方据此决定要不要播浮现动效。
   */
  function placeFloat(node, rect) {
    if (floatInteracting) return false
    var wasHidden = node.style.display !== 'inline-flex'
    node.style.display = 'inline-flex'
    var width = node.offsetWidth || 62
    var height = node.offsetHeight || 30
    var surface = platformSurface()
    var left
    var top
    if (surface) {
      var gap = 8
      left = surface.right + gap
      top = surface.top + (surface.height - height) / 2
      var dock = 'right'
      if (left + width > window.innerWidth - 8) {
        // 右边放不下：翻到内置浮层左边
        left = surface.left - gap - width
        dock = 'left'
        if (left < 8) {
          // 左边也放不下：排到它下面（居中），再把位置夹回视口
          left = clamp(surface.left, 8, Math.max(8, window.innerWidth - width - 8))
          top = surface.bottom + gap
          dock = 'below'
        }
      }
      node.setAttribute('data-dock', dock)
    } else {
      left = clamp(rect.right - width, 8, Math.max(8, window.innerWidth - width - 8))
      top = rect.top - height - 7
      if (top < 8) top = Math.min(rect.bottom + 7, window.innerHeight - height - 8)
      node.removeAttribute('data-dock')
    }
    top = clamp(top, 8, Math.max(8, window.innerHeight - height - 8))
    node.style.left = Math.round(left) + 'px'
    node.style.top = Math.round(top) + 'px'
    return wasHidden
  }

  /** 当前可见的那枚浮标（没有返回 null）。 */
  function visibleFloat() {
    if (env.button.style.display === 'inline-flex') {
      return { node: env.button, rect: (env.state.selection && env.state.selection.rect) || null }
    }
    if (env.quoteButton.style.display === 'inline-flex') {
      return { node: env.quoteButton, rect: (env.state.quoteSelection && env.state.quoteSelection.rect) || null }
    }
    return null
  }

  /**
   * 重新贴一次。宿主浮层出现/移动/消失、页面滚动、窗口缩放时都走这一条：
   * 有内置浮层就跟着它重排，没有就按存下来的选区 rect 兜底。
   *
   * @returns {boolean} 这次确实重排了一枚可见浮标。
   */
  function refreshPlacement() {
    var current = visibleFloat()
    if (!current) return false
    // 没有内置浮层可依附、又丢了选区 rect（理论上不该发生）：保持原样，别去算 NaN
    if (!current.rect && !platformSurface()) return false
    placeFloat(current.node, current.rect)
    return true
  }

  /**
   * 页面上有内置「引用文本」浮层时跟随它（而不是把我们的浮标收起来）。
   *
   * 为什么要有它：以前一滚动就收浮标；现在内置浮层是"跟着内容走"的，两枚按钮同排时
   * 一个跟着走、一个消失会显得像坏了。跟不动（没有内置浮层）时仍按老规则收起。
   *
   * @returns {boolean} 是否已跟随重排。
   */
  function followPlatformSurface() {
    if (!platformSurface()) return false
    return refreshPlacement()
  }

  /** 盯内置浮层的显隐/位置变化：它是在 React 布局后才定位的，比我们的 selectionchange 晚。 */
  var surfaceObserver = null
  var surfaceObserved = null
  /** 上一次观察到的内置浮层可见状态（判"从有到无"用）。 */
  var surfaceVisible = false
  /** 这次隐藏是不是"滚出视区"造成的（滚回来要把浮标放回去，而不是一直收着）。 */
  var surfaceScrolledOut = false

  /**
   * 滚回来时把浮标放回原来那段选区上。
   *
   * 只在三种条件都成立时放回：选区没变、没被 Esc 收过、宿主浮层确实又可见了。
   * 否则宁可让它迟一点由下一次 mouseup / selectionchange 重新弹。
   */
  function restoreFloating() {
    var stored = env.state.selection
    if (!stored || !stored.rect || stored.source !== 'document') return
    var live = currentDocumentRange()
    if (!live || !sameRange(live, stored.range)) return
    if (dismissedRange && sameRange(live, dismissedRange)) return
    if (env.panelOpen) showQuoteButton(stored.rect)
    else showButton(stored.rect)
  }

  function watchPlatformSurface() {
    if (typeof MutationObserver !== 'function') return
    var node = typeof document !== 'undefined' && typeof document.querySelector === 'function'
      ? document.querySelector('[data-text-interaction-surface]')
      : null
    if (!node) return
    // 切会话会换掉整个聊天列：旧节点已断开就换到新节点上重新观察
    if (surfaceObserver && surfaceObserved === node && node.isConnected !== false) return
    if (surfaceObserver) {
      try {
        surfaceObserver.disconnect()
      } catch (error) {
        /* noop */
      }
      surfaceObserver = null
    }
    surfaceObserved = node
    surfaceVisible = surfaceSnapshot().visible
    surfaceObserver = new MutationObserver(syncPlatformSurface)
    surfaceObserver.observe(node, {
      attributes: true,
      attributeFilter: ['aria-hidden', 'style', 'class'],
      childList: true,
    })
  }

  function syncPlatformSurface() {
    if (floatInteracting) return
    var next = surfaceSnapshot()
    var changed = next.visible !== surfaceVisible
    surfaceVisible = next.visible
    if (changed && !next.visible) {
      if (next.dismissed) {
        // 真被收掉（Esc / 点别处）：记下这条选区，之后同一选区不再复现
        dismissedRange = currentDocumentRange()
        surfaceScrolledOut = false
      } else {
        // 只是滚出视区：先跟着藏，滚回来再放回去
        surfaceScrolledOut = true
      }
      hideButton()
      env.hideQuoteButton()
      return
    }
    if (changed && next.visible) {
      var restore = surfaceScrolledOut
      surfaceScrolledOut = false
      if (restore) {
        restoreFloating()
        return
      }
    }
    refreshPlacement()
  }

  function setQuotePop(on) {
    if (on) env.quoteButton.setAttribute('data-pop', '1')
    else env.quoteButton.removeAttribute('data-pop')
  }

  function showQuoteButton(rect) {
    if (placeFloat(env.quoteButton, rect)) {
      setQuotePop(false)
      void env.quoteButton.offsetWidth
      setQuotePop(true)
    }
    watchPlatformSurface()
    env.later(refreshPlacement, 0)
    env.later(refreshPlacement, 80)
    // 浮标亮着就盯"输入法有没有开麦"（幂等）：这时开麦的语义是"引用这段 + 把光标移进小窗"，
    // 见 autoQuoteFromVoice。没浮标就没人问 —— 探针也跟着停（它只在被问时活着）。
    env.startMicWatch()
  }
  /** 插件卸载时摘掉对内置浮层的观察（否则会一直挂着一个 MutationObserver）。 */
  function dispose() {
    if (surfaceObserver) {
      try {
        surfaceObserver.disconnect()
      } catch (error) {
        /* noop */
      }
      surfaceObserver = null
    }
    surfaceObserved = null
  }
  return {
    hideButton,
    showQuoteButton,
    showButton,
    setButtonPop,
    setQuotePop,
    scheduleCheck,
    panelSourceLabel,
    insidePanelContent,
    turnLabelOf,
    refreshPlacement,
    followPlatformSurface,
    beginFloatInteraction,
    endFloatInteraction,
    dispose,
  }
}
