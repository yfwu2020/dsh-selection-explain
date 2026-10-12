import { el, listen } from './dom.js'
import { VOICE_SETTLE_COMPOSE_MS, VCARD_TEXT_MAX, VCARD_PAD_Y, VCARD_W, VOICE_SETTLE_MAX_MS, VOICE_SETTLE_MS, VOICE_SETTLE_POLL_MS, FRAME_FOCUS_EVIDENCE_MS, IME_BUNDLES, MIC_POLL_MS, MIC_API } from './constants.js'
import { isDarkSurface } from './render.js'
import { collectContext } from './context.js'

/** voice-card state and operations; dependencies are supplied as live node/callback accessors. */
export function createVoiceCardController(env) {

  // ══════════════════ 语音卡：选中文字 + 输入法正在语音输入 ══════════════════
  //
  // 场景：用户划选一段文字，同时正用输入法（豆包）对着麦克风说话。
  // 这时在那段文字**下方**弹一张临时输入框并自动聚焦 —— 输入法"上屏"的文字会直接
  // 落进这个框（IME 只认焦点元素），所以我们**不需要**读它的转写结果，也不需要任何
  // 输入法权限。点发送就跳过翻译与详解，直接进追问。
  //
  // 三条前提，缺一不可（缺了就完全不弹，不装作在等）：
  //   ① 选区在本文档里（原生 App 里的选区我们既看不到、也接不住上屏）；
  //   ② 占着麦克风的是已知输入法（IME_BUNDLES）；
  //   ③ 页面有焦点、且用户没在别处打字（否则会把人家在别处的听写抢过来）。
  //
  // 时序是整件事成立的关键：检测到开麦（≤400ms）→ 弹卡 + 抢焦点 → 用户继续说 →
  // **松手时**输入法才上屏。抢焦点发生在开始时、上屏发生在结束时，中间有几秒余量；
  // 反过来"等检测到文字再弹框"就已经晚了 —— 字会落到原来那个焦点里去。
  //
  // ── 两条路，按"小窗开没开"分（2026-10-09 起）──
  //   · 小窗**没开**：上面这套语音卡（选区是"要解读的对象"，说完进一个新的追问）。
  //   · 小窗**开着**：划词浮出的是「❝ 引用」浮标，这时开麦等于**点一下那个浮标** ——
  //     选中的文字挂进小窗、光标移到小窗输入框，输入法上屏的字直接落进小窗，
  //     和引用一起成为下一条追问（`autoQuoteFromVoice`）。
  //     两种情形互斥：面板一开，`state.selection` 就被清成 null，语音卡那套根本不启动。
  //     轮询也只跟着浮标走（浮标亮着才问 /api/mic），没浮标就没人问。

  var vcard = null

  var vcardBox = null

  var vcardSend = null

  /** 关机动画那条亮线（懒建）。 */
  var crtLine = null

  /**
   * 发送那一刻卡片的矩形（视口坐标）—— 小窗据此"从那一格长出来"。
   * 只在 sendVCard 里写、只在 showPanel 里消费（用完即清）：其余开窗路径（划词解读 /
   * 历史回放 / 升格）这里是 null，因此不受影响、保持原来的"瞬开"。
   */
  var vcardHandoff = null

  /** 交接动画的兜底定时器与 transitionend 句柄（收尾要把内联的 transform/transition 清干净）。 */
  var panelGrowTimer = null

  var panelGrowHandler = null

  /**
   * 这一次录音周期里，"开麦 → 自动加引用 + 移光标"处理过没有。
   *
   * 为什么要这个：麦克风是每 200ms 问一次的，同一次录音会被问到十几遍 ——
   * 不抑制的话引用会被反复加（虽然 addQuote 对重复文本会挡掉，但 hideQuoteButton /
   * focusAskBox 会被反复执行，输入法的输入上下文也会被反复重绑）。
   * 与 vcardState.suppress 同一套思路：录音**停止**时复位（见 micTick 的 !matchingIme 分支）。
   */
  var quoteVoiceHandled = false

  /** 选中提示：下划线层 / 牵引线 / 牵引线起点的小圆点（懒建）。 */
  var selMark = null

  var selThread = null

  var selThreadPath = null

  var selThreadDot = null

  var vcardState = {
    open: false,
    /** 打开时的选区快照（滚动 / 改窗口大小时按它重算位置）。 */
    range: null,
    /**
     * 打开时的锚点矩形（视口坐标）。
     *
     * 侧边栏网页那条路**没有 Range**（不透明源帧里的选区拿不出来），定位只能靠桥换算好的
     * 矩形 —— 新的 selection 消息会刷新它，于是帧内滚动 / 重报时卡片跟着走。
     */
    anchorRect: null,
    timer: null,
    /** 上一次 /mic 还没回来（不叠请求）。 */
    busy: false,
    /**
     * 用户刚取消过这次录音（Esc / 点空白）：在**这次录音结束之前**不再自动弹卡片。
     * 没有它的话：Esc 收卡片 → 恢复浮标 → 下一拍轮询发现"还在录" → 卡片又弹回来，
     * Esc 看起来像失灵（实测就是这么暴露出来的）。等 !capturing 才解除。
     */
    suppress: false,
    /** 形变期间钉住正文宽度用的兜底定时器 / transitionend 句柄。 */
    unpinTimer: null,
    unpinHandler: null,
    /** 正在播关机动画（这段时间内卡片还没真正隐藏）。 */
    closing: false,
    /** 关机动画的兜底定时器 / animationend 句柄。 */
    crtTimer: null,
    crtHandler: null,
    /** "等文字定稿"的观察（松手后豆包还会智能整理，见 VOICE_SETTLE_MS）。 */
    settleTimer: null,
    settleLastText: '',
    settleStableAt: 0,
    settleDeadline: 0,
    /** 收到 compositionend 后的短定时器（见 VOICE_SETTLE_COMPOSE_MS）。 */
    settleComposeTimer: null,
  }

  function ensureVCard() {
    if (vcard) return
    vcard = el('div', 'dsh-sel-vcard')
    vcard.setAttribute('data-voiced', '0')
    vcard.setAttribute('data-text', '0')
    // 「在听」那根 3px 竖条：作为第一个 flex 子元素，正文排在它右边（占 3+9=12px）
    vcard.appendChild(el('div', 'dsh-sel-vbar'))
    vcardBox = el('textarea', 'dsh-sel-vcard-box')
    vcardBox.rows = 1
    vcardBox.placeholder = '正在听…'
    vcardBox.setAttribute('spellcheck', 'false')
    vcardSend = el('button', 'dsh-sel-vcard-send')
    vcardSend.type = 'button'
    vcardSend.title = '直接追问（跳过翻译与详解）'
    vcardSend.textContent = '↑'
    vcard.appendChild(vcardBox)
    vcard.appendChild(vcardSend)
    env.layer.appendChild(vcard)
    listen(vcardBox, 'input', syncVCardText)
    // 输入法上屏有的环境只发 compositionend 而不发 input：补一次（幂等）
    listen(vcardBox, 'compositionend', syncVCardText)
    // 「等定稿」的主信号：输入法的智能整理**走合成 API 提交**（实测 8 次录音里 6 次都有
    // inputType=insertCompositionText + compositionend）。收到就在短窗口后决定，
    // 不必等兜底的 500ms 静默；连着来两次（标点一次、改词一次）就重新计时。
    listen(vcardBox, 'compositionend', function () {
      if (!vcardState.settleTimer) return
      if (vcardState.settleComposeTimer) clearTimeout(vcardState.settleComposeTimer)
      vcardState.settleComposeTimer = setTimeout(function () {
        vcardState.settleComposeTimer = null
        if (!vcardState.open || !vcardState.settleTimer) return
        var settled = String((vcardBox && vcardBox.value) || '')
        stopVoiceSettle()
        finishVoiceSettle(settled)
      }, VOICE_SETTLE_COMPOSE_MS)
    })
    listen(vcardBox, 'keyup', syncVCardText)
    listen(vcardBox, 'keydown', function (event) {
      // Enter 发送、Shift+Enter 换行；输入法确认候选词的那个 Enter 不算（与追问框同一套判断）
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        sendVCard()
      }
    })
    listen(vcardSend, 'click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      sendVCard()
    })
    // 卡片里的鼠标动作别冒泡出去：外面那套"点别处就收浮标"的逻辑会把卡收掉
    listen(vcard, 'mousedown', function (event) {
      event.stopPropagation()
    })
    // ④ 点屏幕空白处收卡片。用 capture：卡片自己的 mousedown 是冒泡阶段，
    // 这里先跑，所以判断"在不在卡片里"必须用 contains 而不是靠冒泡顺序。
    listen(document, 'mousedown', function (event) {
      if (!vcardState.open) return
      var target = event.target
      if (target && (target === vcard || (vcard.contains && vcard.contains(target)))) return
      vcardState.suppress = true
      closeVCard(true)
    }, true)
    listen(window, 'scroll', function () {
      if (vcardState.open) repositionVCard()
    }, true)
    listen(window, 'resize', function () {
      if (vcardState.open) repositionVCard()
    })
  }

  /** 有字了才摆出发送键；高度跟着内容长（最多 4 行，再多内部滚动并停在最新一行）。 */
  function syncVCardText() {
    if (!vcard || !vcardBox) return
    vcard.setAttribute('data-text', String(vcardBox.value || '').trim() ? '1' : '0')
    growVCardBox()
  }

  /**
   * 形变结束后解开正文宽度（回到 flex 布局）。
   *
   * 形变期间正文宽度被钉在终值（见 openVCard ②）：卡片变宽只是"揭开"它。
   * 不解开的话，之后打字时正文宽度不会再跟着卡片走。
   */
  function unpinVCardBox() {
    if (vcardState.unpinTimer) {
      clearTimeout(vcardState.unpinTimer)
      vcardState.unpinTimer = null
    }
    if (vcard && vcardState.unpinHandler) {
      vcard.removeEventListener('transitionend', vcardState.unpinHandler)
      vcardState.unpinHandler = null
    }
    if (!vcardBox) return
    vcardBox.style.flex = ''
    vcardBox.style.width = ''
  }

  /**
   * 排一次"解开正文宽度"。
   *
   * transitionend 是主路径；另挂一个兜底定时器 —— 形变被打断（切窗口、立刻关卡片）时
   * transitionend 可能永远不来，正文宽度就会一直钉着。
   */
  function scheduleVCardUnpin() {
    if (!vcard) return
    if (vcardState.unpinTimer) {
      clearTimeout(vcardState.unpinTimer)
      vcardState.unpinTimer = null
    }
    if (vcardState.unpinHandler) {
      vcard.removeEventListener('transitionend', vcardState.unpinHandler)
      vcardState.unpinHandler = null
    }
    vcardState.unpinHandler = function (event) {
      if (event.target !== vcard) return
      if (event.propertyName === 'width') unpinVCardBox()
      // ⚠️ 这里**不要**重画选中提示。
      // 曾经加过"形变结束后重画一次"当安全网，结果是**闪一下**：
      // 重画会先 clearSelectionMarkers()（牵引线 display:none）再重画（block），
      // 而 display:none → block 会让生长动画**重放** —— 用户看到的就是"曲线生成后闪一下、
      // 再重新长一遍"。而且卡片形变会分别触发 top 和 height 两次，所以闪两次。
      // 现在终点用的是算出来的**最终位置**（不读卡片当下的 rect），本来就不需要这次重画。
    }
    vcard.addEventListener('transitionend', vcardState.unpinHandler)
    vcardState.unpinTimer = env.later(unpinVCardBox, 420)
  }

  function growVCardBox() {
    if (!vcardBox || !vcard) return
    vcardBox.style.height = 'auto'
    var content = Math.max(24, Math.min(vcardBox.scrollHeight, VCARD_TEXT_MAX))
    vcardBox.style.height = content + 'px'
    vcardBox.style.overflowY = vcardBox.scrollHeight > VCARD_TEXT_MAX ? 'auto' : 'hidden'
    if (vcardBox.scrollHeight > VCARD_TEXT_MAX) vcardBox.scrollTop = vcardBox.scrollHeight
    vcard.style.height = (content + VCARD_PAD_Y) + 'px'
  }

  /**
   * 卡片几何：右缘钉在浮标右缘（横向不跳），左缘展开到**正文列左边**。
   * 宽度不是拍脑袋定的 —— 它是"浮标右缘 − 正文列左边"，所以展开后左缘正好和正文对齐。
   * 纵向落在整块文字下方（不是选中那一行下方）：否则会压住下面那行正文。
   */
  function vcardGeometry() {
    var range = vcardState.range
    var rect = null
    if (range) {
      try {
        rect = range.getBoundingClientRect()
      } catch (error) {
        rect = null
      }
    }
    // 侧边栏网页那条路没有 Range：锚点用桥换算好的视口矩形（两者都是视口坐标，可直接混用）。
    if ((!rect || (!rect.width && !rect.height)) && vcardState.anchorRect) rect = vcardState.anchorRect
    if (!rect || (!rect.width && !rect.height)) return null
    // 帧内选区只知道自己那一段（"块"是帧内的事，父页面看不见）：整块就用它自己，
    // 于是"落在整段文字下方"这条规则在网页里退化成"落在这段选区下方"。
    var blockRect = (range && selectionBlockRect(range)) || rect
    var right = Math.min(rect.right, Math.max(8, window.innerWidth - 8))
    var width = VCARD_W
    var left = Math.max(8, right - width)
    // ⚠️ 纵向必须按**整个选区**的底边算，不能只按"选区起点所在的块"：
    // 选中跨多个段落 / 代码块时，起点那个块的底边落在选区**中间**，
    // 卡片就会压在剩下的选中文字上（用户实测："选大段文字时卡片有概率遮住文字"）。
    var below = Math.max(blockRect.bottom, rect.bottom) + 22
    var top = below
    var cardHeight = 42
    try {
      var own = vcard && vcard.getBoundingClientRect()
      if (own && own.height) cardHeight = own.height
    } catch (error) {
      /* 读不到就按单行 42 估 */
    }
    // 下方放不下就翻到选区上方；上方也放不下（选区比视口还高）就贴视口底边 ——
    // 宁可压在可见文字的下缘，也不要把卡片推到屏幕外（那样等于没弹）
    if (below + cardHeight > window.innerHeight - 8) {
      var above = rect.top - cardHeight - 22
      top = above >= 8 ? above : Math.max(8, window.innerHeight - cardHeight - 16)
    }
    return { left: left, top: top, width: width, height: cardHeight }
  }

  /** 选区所在的那个"块"（段落 / 列表项 / 单元格）—— 卡片挂在它的下方。 */
  function selectionBlockRect(range) {
    var node = range.startContainer
    var element = node && node.nodeType === 1 ? node : node && node.parentElement
    while (element && element !== document.body && element !== document.documentElement) {
      var display = ''
      try {
        display = window.getComputedStyle(element).display
      } catch (error) {
        display = ''
      }
      if (display === 'block' || display === 'list-item' || display === 'table-cell') {
        return element.getBoundingClientRect()
      }
      element = element.parentElement
    }
    return null
  }

  function applyVCardGeometry(geo) {
    if (!vcard || !geo) return
    vcard.style.left = Math.round(geo.left) + 'px'
    vcard.style.top = Math.round(geo.top) + 'px'
    vcard.style.width = Math.round(geo.width) + 'px'
  }

  /** 滚动 / 改窗口时重新贴住那段文字（关掉过渡，免得跟着滚"飘"）。 */
  function repositionVCard() {
    var geo = vcardGeometry()
    if (!vcard || !geo) return
    vcard.style.transition = 'none'
    applyVCardGeometry(geo)
    void vcard.offsetWidth
    vcard.style.transition = ''
    // 选中提示是按视口坐标摆的，滚动 / 改窗口要跟着重画
    if (vcardState.open) paintSelectionMarkers(false)
  }

  /**
   * 从浮标那一格**形变**过来：先按浮标的几何摆好（关过渡），强制重排，再切到最终几何。
   * 于是"下移 + 展开"是一段连续动画，而不是旧的消失、新的出现。
   */
  function openVCard() {
    if (vcardState.open || env.panelOpen) return
    if (!env.state.selection) return
    // ⚠️ 两条来源的定位依据不一样，不能只认 Range：
    //   · 本文档里的选区 → 有 Range（几何 / 选中提示都按它算）；
    //   · 侧边栏网页（不透明源 iframe）→ 父页面**拿不到那个 Range**，只有桥换算好的
    //     视口矩形（state.selection.rect）和桥采好的上下文 —— 见 vcardGeometry / sendVCard。
    if (!env.state.selection.range && env.state.selection.source !== 'iframe') return
    // 页面没焦点 / 用户正在别处打字：不抢 —— 抢了就是把人家别处的听写拽过来
    if (!hasFocusEvidence(env.state.selection)) return
    if (env.isTypingTarget(document.activeElement)) return
    ensureVCard()
    // 上一轮的关机动画可能还没收尾（用户马上又划了新文字、又开麦）：先收干净再开
    if (vcardState.closing || vcardState.crtTimer) finishCrtOff()
    vcardState.range = env.state.selection.range || null
    vcardState.anchorRect = env.state.selection.rect || null
    var geo = vcardGeometry()
    if (!geo) return
    var pillRect = env.button.getBoundingClientRect()
    vcardState.open = true
    vcard.style.transition = 'none'
    vcard.style.display = 'flex'
    // ── ① 先在**最终宽度**下量一次（同一帧内完成，用户看不见）──
    // 为什么必须在这个宽度下量：正文按宽度折行，在浮标那条窄缝（~86px）里量出来的行数会暴涨
    // （踩过：单行卡被顶到 111px）。量完之后形变全程不再读 scrollHeight。
    vcard.style.width = Math.round(geo.width) + 'px'
    void vcard.offsetWidth
    var finalBoxHeight = Math.max(24, Math.min(vcardBox.scrollHeight, VCARD_TEXT_MAX))
    var finalCardHeight = finalBoxHeight + VCARD_PAD_Y
    var finalBoxWidth = Math.round(vcardBox.getBoundingClientRect().width)
    // ── ② 形变期间把**正文宽度钉死** ──
    // 卡片变宽只是"揭开"正文，正文自己不再逐帧重新折行 —— 这是"下移展开"卡顿的主因
    // （每帧重排 textarea 里的文本）。钉死之后，卡片变宽只是一次裁剪，代价小得多。
    if (finalBoxWidth > 0) {
      vcardBox.style.flex = '0 0 auto'
      vcardBox.style.width = finalBoxWidth + 'px'
    }
    vcardBox.style.height = finalBoxHeight + 'px'
    vcardBox.style.overflowY = finalBoxHeight >= VCARD_TEXT_MAX ? 'auto' : 'hidden'
    // ── ③ 回到浮标那一格：位置 / 宽 / 高 / 圆角都从那里出发 ──
    vcard.style.width = Math.round(pillRect.width || 86) + 'px'
    vcard.style.left = Math.round(pillRect.left) + 'px'
    vcard.style.top = Math.round(pillRect.top) + 'px'
    vcard.style.height = Math.round(pillRect.height || 28) + 'px'
    vcard.style.borderRadius = '999px'
    markVCardListening(true)
    void vcard.offsetWidth
    // ── ④ 开过渡，走向终态 ──
    // 宽度这次**也参与**：上一版它不参与，第一帧就从 86px 跳到 460px（用户报的"跳变"）。
    vcard.style.transition = ''
    vcard.style.borderRadius = ''
    vcard.style.left = Math.round(geo.left) + 'px'
    vcard.style.top = Math.round(geo.top) + 'px'
    vcard.style.width = Math.round(geo.width) + 'px'
    vcard.style.height = finalCardHeight + 'px'
    scheduleVCardUnpin()
    // 卡片打开后才画选中提示（选中/浮标阶段不画：那时原生底纹还在）
    ensureSelectionMarkers()
    paintSelectionMarkers(true)
    env.hideButton()
    // 卡片开着期间必须继续看麦克风：既要判断"这次录音结束了"（停掉呼吸），
    // 也要能接住"又按了一次 Fn"（重新标记在听）。幂等，正常路径上计时器本来就在跑。
    startMicWatch()
    // 关键一步：输入法上屏只认焦点元素，焦点必须在我们这个框里
    focusVCard()
    // 注意：焦点一转移，原生选区就被浏览器清掉了，于是**卡片开着时看不到选中底纹**。
    // 这是已知取舍：补底纹的两条路（CSS Custom Highlight / 自绘色块）都被否掉了 ——
    // 前者只有 Chromium 系支持，后者是盖在字上的色块。要恢复就从这里接回去。
  }

  /**
   * 「在听」标记与空框占位文案。
   *
   * 麦克风一松开就必须停掉呼吸 —— 否则卡片还在泛青呼吸，等于在说"我还在听"，
   * 而这时输入法早就松手了。空框的占位也跟着换（"正在听…" → "直接打字也行…"），
   * 不然那句话同样是在撒谎。
   */
  function markVCardListening(on) {
    if (!vcard) return
    vcard.setAttribute('data-voiced', on ? '1' : '0')
    if (!vcardBox) return
    if (String(vcardBox.value || '').trim()) return
    // 松手之后、框还空着时显示什么：
    //   · 「空录音时收起」开着（默认）→ 「正在关闭…」：这张卡马上要被收掉，
    //     如实说它正在走（而不是"直接打字也行…"那种假邀请）；
    //   · 两个收尾开关都关着（卡会留着）→ 才给"直接打字也行…"这句邀请。
    vcardBox.placeholder = on ? '正在听…' : env.settingsLive.voiceCancelOnSilence !== false ? '正在关闭…' : '直接打字也行…'
  }

  function focusVCard() {
    if (!vcardBox) return
    try {
      vcardBox.focus({ preventScroll: true })
    } catch (error) {
      try {
        vcardBox.focus()
      } catch (inner) {
        /* 桩环境没有 focus：不影响逻辑 */
      }
    }
  }

  /**
   * 收起卡片。
   *
   * **不还回「✦ 解读」浮标**（用户要求）：取消就是取消 —— 浮标再冒出来，等于在问
   * "要不要解读"，而用户刚表达的是"这次算了"。要解读就重新划一次。
   * 发送那条路也不还（它直接开面板了）。
   */
  /** 选中提示的元素（懒建）：下划线层 + 牵引线（SVG 贝塞尔）+ 锚点圆。 */
  function ensureSelectionMarkers() {
    if (selMark) return
    selMark = el('div', 'dsh-sel-umark')
    env.layer.appendChild(selMark)
    var NS = 'http://www.w3.org/2000/svg'
    selThread = document.createElementNS(NS, 'svg')
    selThread.setAttribute('class', 'dsh-sel-thread')
    selThreadPath = document.createElementNS(NS, 'path')
    selThreadPath.setAttribute('class', 'dsh-sel-threadpath')
    selThreadPath.setAttribute('fill', 'none')
    selThread.appendChild(selThreadPath)
    selThreadDot = document.createElementNS(NS, 'circle')
    selThreadDot.setAttribute('class', 'dsh-sel-threaddot')
    selThreadDot.setAttribute('r', '2.6')
    selThreadDot.setAttribute('stroke-width', '1.5')
    selThread.appendChild(selThreadDot)
    env.layer.appendChild(selThread)
  }

  /**
   * 画"选中提示"：下划线（逐行矩形、两端渐隐）+ 从选区牵引到卡片的虚线。
   *
   * **只在卡片打开后才出现**（用户定的）：选中/浮标阶段不画 —— 那时原生底纹还在，
   * 两者同时出现会互相打架。等底纹被抢焦点吃掉，这两样正好接上。
   *
   * 下划线按 range 的**逐行矩形**贴（多行选区就是多条），不是整块一条线。
   * 牵引线从选区**末行中点**竖直落到卡片上缘 —— 这一条会穿过下方文字（用户接受），
   * 所以它是 2px 宽的竖条 + repeating-gradient 虚线，而不是实线。
   */
  function paintSelectionMarkers(grow) {
    if (!selMark) return
    clearSelectionMarkers()
    var range = vcardState.range
    if (!vcard || !vcardState.open) return
    if (!range && !vcardState.anchorRect) return
    /**
     * 侧边栏网页那条路（没有 Range）：**只画牵引线，不画下划线**。
     *
     * 两个理由：① 逐行矩形在帧内，父页面拿不到（桥只报了一个锚点矩形）；
     * ② 帧内原生底纹是否还在由浏览器说了算 —— 万一还在，我们按估算位置再画一条
     * 下划线就是"划两层"（本文档那条路当初踩过同一个坑）。
     * 牵引线是独立的一条线，不存在这个冲突，所以留着：卡片和那段文字之间得有可见的联系。
     */
    var fromFrame = !range && !!vcardState.anchorRect
    var rects = fromFrame ? null : range.getClientRects ? range.getClientRects() : null
    if (!fromFrame && (!rects || !rects.length)) return
    var accent = 'var(--sel-a1)'
    // ⚠️ 必须先**按行归并**再画：
    // 一行里如果有行内元素（<code>、粗体、链接），getClientRects() 会给出**多个矩形**，
    // 而且它们的高度 / 底边各不相同 —— 按矩形各画一条就会"划两层"，
    // 渐隐也会出现在行中间（用户实测的两个问题，同一个根因）。
    // ⚠️ 第一步：丢掉"容器矩形"。
    // 选区跨**整块**时，getClientRects() 会把块级盒子也返回 —— 一个覆盖整段的高矩形
    // （实测：一段两行会额外给出 h=53 的块盒，一个代码块给出 h=80 的块盒）。
    // 它会把段内所有行吞进一组，结果整段只画一条下划线、很多行没线（用户实测）。
    // 判据用高度中位数：行片段的高度都接近行高，块盒是它的数倍。
    // ⚠️ 这一整段只在有 `rects` 时跑：帧内那条根本没有逐行矩形（rects = null），
    // 它只画下面的牵引线。
    var lines = []
    if (!fromFrame) {
      var heights = []
      for (var h = 0; h < rects.length; h += 1) {
        var probe = rects[h]
        if (probe && probe.width) heights.push(probe.bottom - probe.top)
      }
      heights.sort(function (a, b) {
        return a - b
      })
      var median = heights.length ? heights[Math.floor(heights.length / 2)] : 0
      var maxLineHeight = median > 0 ? median * 1.8 : Infinity
      for (var i = 0; i < rects.length; i += 1) {
        var rect = rects[i]
        if (!rect || !rect.width) continue
        if (rect.bottom - rect.top > maxLineHeight) continue
        var height = rect.bottom - rect.top
        var center = rect.top + height / 2
        var line = null
        for (var j = 0; j < lines.length; j += 1) {
          var group = lines[j]
          var groupHeight = group.bottom - group.top
          var groupCenter = group.top + groupHeight / 2
          // ⚠️ 判"同一行"必须看**垂直中心**，不能看重叠面积：
          // 行内 code 的盒子可能比整行还高（行高 1.8 时尤其明显），
          // 按重叠判会把**下一行**也吞进同一组 → 那几行就没有下划线了（用户实测）。
          // 中心距的容差取"较矮者的一半"：同一行的元素中心几乎重合，
          // 相邻行的中心差至少一个行高，两者区分得很干净。
          if (height > 0 && groupHeight > 0 && Math.abs(groupCenter - center) <= Math.min(groupHeight, height) * 0.5) {
            line = group
            break
          }
        }
        if (line) {
          line.left = Math.min(line.left, rect.left)
          line.right = Math.max(line.right, rect.right)
          line.top = Math.min(line.top, rect.top)
          line.bottom = Math.max(line.bottom, rect.bottom)
        } else {
          lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
        }
      }
    }
    for (var k = 0; k < lines.length; k += 1) {
      var row = lines[k]
      var mark = el('div', 'dsh-sel-uline')
      mark.style.left = Math.round(row.left) + 'px'
      mark.style.top = Math.round(row.bottom + 3) + 'px'
      mark.style.width = Math.round(row.right - row.left) + 'px'
      // U3：两端渐隐 —— 归并之后就是"一行的两端"，不会再出现在行中间
      mark.style.background =
        'linear-gradient(90deg,transparent,' + accent + ' 12%,' + accent + ' 88%,transparent)'
      selMark.appendChild(mark)
    }
    var first = fromFrame ? vcardState.anchorRect : lines[0]
    var last = fromFrame ? vcardState.anchorRect : lines[lines.length - 1]
    var geo = vcardGeometry()
    if (!first || !last || !geo) return
    // 终点用**算出来的最终位置**（geo.top），不是卡片此刻的 rect ——
    // 开卡片时卡片还在从"解读按钮"那一格形变过来，读当下的 rect 会先指到按钮上，
    // 等形变结束才跳过去（用户："慢半拍""一开始不要连接到解读按钮上"）。
    // 所以这里一律瞄准最终位置；形变期间不需要跟随（形变结束后那次重画只是安全网）。
    var cardTop = geo.top
    var above = cardTop < first.top
    var anchor = above ? first : last
    var sx = (anchor.left + anchor.right) / 2
    var sy = above ? anchor.top - 2 : anchor.bottom + 2
    // 终点：卡片上（下）缘，x 落在卡片宽度内、左右各留 24px；
    // **多探进卡片 4px** —— SVG 在卡片下层，多出来那段被卡片盖住，视觉上正好接住。
    var endY = above ? cardTop + (geo.height || 42) + 4 : cardTop + 4
    var endX = Math.max(geo.left + 24, Math.min(sx, geo.left + geo.width - 24))
    // 可见的贝塞尔：两端各一个反向的横向控制量 → S 形（原来控制点和端点同 x，是直线）
    var dy = Math.abs(endY - sy) || 1
    var bend = 18
    selThreadPath.setAttribute(
      'd',
      'M' + sx + ' ' + sy + ' C ' + (sx + bend) + ' ' + (sy + dy * 0.45) + ', ' +
        (endX - bend) + ' ' + (endY - dy * 0.45) + ', ' + endX + ' ' + endY,
    )
    selThreadPath.setAttribute('stroke', accent)
    selThreadDot.setAttribute('cx', sx)
    selThreadDot.setAttribute('cy', sy)
    selThreadDot.setAttribute('fill', accent)
    selThreadDot.setAttribute('stroke', 'var(--dsw-alias-bg-base,#fff)')
    // 生长动画**只在开卡片时**播：滚动 / 缩放也会走到这里，而 display:none → block
    // 会重启动画 —— 那就是又一次"闪一下"（同一个坑，别踩第二遍）。
    if (grow) selThread.setAttribute('data-grow', '1')
    else selThread.removeAttribute('data-grow')
    selThread.style.display = 'block'
    selThread.style.opacity = '1'
  }

  /** 收起选中提示（幂等）。 */
  function clearSelectionMarkers() {
    if (selMark && selMark.children.length) selMark.textContent = ''
    if (selMark) selMark.style.opacity = ''
    if (selThread) {
      selThread.style.display = 'none'
      selThread.style.opacity = ''
    }
  }

  /** 关机动画那条亮线（懒建）。 */
  function ensureCrtLine() {
    if (crtLine) return crtLine
    crtLine = el('div', 'dsh-sel-crtline')
    env.layer.appendChild(crtLine)
    return crtLine
  }

  /**
   * 亮线的分段与火花（懒建，只建一次）。
   *
   * 5 段首尾相接拼成整条线（看上去就是一条实线）；收缩时各段延迟不同，
   * 于是"往中间收"和"错位露缝"同时发生 —— 这点像素故障是刻意做的。
   * 末尾两个火花是段子死掉之后还在原位闪两下的残留像素。
   */
  function ensureCrtSegments(line) {
    if (line.children && line.children.length) return
    for (var i = 0; i < 5; i += 1) line.appendChild(el('div', 'dsh-sel-crtseg'))
    line.appendChild(el('div', 'dsh-sel-crtspark'))
    line.appendChild(el('div', 'dsh-sel-crtspark'))
  }

  /** 系统是否要求减少动效。 */
  function prefersReducedMotion() {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch (error) {
      return false
    }
  }

  /**
   * 播"老式电视机关机"：卡片塌成一条线，亮线再横缩成一个点（A 方案，420ms）。
   *
   * 只在**取消**时播 —— 发送那条要立刻开面板，动画会和面板叠在一起。
   *
   * 亮线是**独立元素**，不是卡片的 box-shadow：box-shadow 会跟着 transform 一起被压扁，
   * 塌到 5% 时连光晕都成一条（实测踩过）。颜色也按明暗给两套 ——
   * 浅色底上白线看不见（实测只差 ~15/255），深色底上反过来，白线才亮得起来。
   *
   * 返回 false 表示没播（系统要求减少动效 / 卡片量不出尺寸），调用方直接收掉。
   */
  function playCrtOff() {
    if (!vcard || prefersReducedMotion()) return false
    var rect = vcard.getBoundingClientRect()
    if (!rect.width || !rect.height) return false
    var line = ensureCrtLine()
    var dark = false
    try {
      dark = isDarkSurface(document.body)
    } catch (error) {
      dark = false
    }
    // 亮线摆在卡片正中、宽度跟着卡片（都是 fixed 定位，同一套视口坐标）
    line.style.left = Math.round(rect.left) + 'px'
    line.style.top = Math.round(rect.top + rect.height / 2 - 1.5) + 'px'
    line.style.width = Math.round(rect.width) + 'px'
    ensureCrtSegments(line)
    // 颜色挂在容器上，分段/火花用 currentColor 继承 —— 一处赋值，7 个子元素跟着变
    line.style.color = dark ? '#FFFFFF' : 'var(--sel-a1)'
    line.style.background = 'transparent'
    line.style.boxShadow = 'none'
    line.style.filter = dark
      ? 'drop-shadow(0 0 6px rgba(190,245,255,.8))'
      : 'drop-shadow(0 0 6px rgba(13,148,136,.55))'
    vcardState.closing = true
    // 选中提示跟着卡片一起淡掉（它俩是"卡片这一段"的注解，卡片塌了就不该还挂着）
    if (selMark) selMark.style.opacity = '0'
    if (selThread) selThread.style.opacity = '0'
    if (selThreadDot) selThreadDot.style.opacity = '0'
    // 摘掉再挂上：让动画能重播（同一元素上连续两次收卡片）
    vcard.removeAttribute('data-off')
    line.removeAttribute('data-off')
    void vcard.offsetWidth
    vcard.setAttribute('data-off', 'a')
    line.setAttribute('data-off', 'a')
    var done = function () {
      if (vcardState.crtTimer) {
        clearTimeout(vcardState.crtTimer)
        vcardState.crtTimer = null
      }
      if (vcard && vcardState.crtHandler) {
        vcard.removeEventListener('animationend', vcardState.crtHandler)
        vcardState.crtHandler = null
      }
      finishCrtOff()
    }
    // animationend 是主路径；另挂兜底 —— 标签页在后台时动画根本不跑，事件也就不会来
    vcardState.crtHandler = function (event) {
      if (event.target === vcard) done()
    }
    vcard.addEventListener('animationend', vcardState.crtHandler)
    vcardState.crtTimer = env.later(done, 700)
    return true
  }

  /**
   * 关机动画收尾：真正把卡片和亮线藏掉。
   *
   * 幂等 —— 不播动画时 closeVCard 直接调它，顺便清掉上一轮动画的残留。
   */
  function finishCrtOff() {
    vcardState.closing = false
    if (vcardState.crtTimer) {
      clearTimeout(vcardState.crtTimer)
      vcardState.crtTimer = null
    }
    if (vcard && vcardState.crtHandler) {
      vcard.removeEventListener('animationend', vcardState.crtHandler)
      vcardState.crtHandler = null
    }
    if (vcard) {
      vcard.removeAttribute('data-off')
      vcard.style.display = 'none'
      vcard.style.opacity = ''
      vcard.style.filter = ''
      vcard.style.transform = ''
      vcard.style.borderRadius = ''
      vcard.setAttribute('data-voiced', '0')
      vcard.setAttribute('data-text', '0')
    }
    if (vcardBox) {
      vcardBox.value = ''
      vcardBox.style.height = ''
      vcardBox.style.overflowY = 'hidden'
    }
    if (crtLine) {
      crtLine.removeAttribute('data-off')
      crtLine.style.opacity = ''
      crtLine.style.filter = ''
    }
    clearSelectionMarkers()
  }

  /**
   * 收起卡片。
   *
   * animate=true（取消：Esc / 点空白）时先播关机动画，动画结束再真正隐藏；
   * 其余路径（发送 / 调试钩子）立刻收掉。
   * **不还回「✦ 解读」浮标**：取消就是取消，要解读就重新划一次。
   */
  /** 停掉"等文字定稿"的观察（幂等）。 */
  function stopVoiceSettle() {
    if (vcardState.settleTimer) {
      clearInterval(vcardState.settleTimer)
      vcardState.settleTimer = null
    }
    if (vcardState.settleComposeTimer) {
      clearTimeout(vcardState.settleComposeTimer)
      vcardState.settleComposeTimer = null
    }
    // ⚠️ 这里**不**上报测量：停表既发生在"正常决定之前"（那一拍马上就要 finishVoiceSettle），
    // 也发生在"被提前打断"时。在这里上报会把决策一律记成 stopped（踩过）。
    // 提前打断的场景由调用方各自上报（closeVCard / 新录音）。
    vcardState.settleLastText = ''
    vcardState.settleStableAt = 0
    vcardState.settleDeadline = 0
  }

  /** 文字定稿后，才真正执行收尾（发送 / 取消 / 什么都不做）。 */
  function finishVoiceSettle(text) {
    if (!vcardState.open) return
    var spoken = String(text || '').trim()
    if (spoken && env.settingsLive.voiceAutoSend !== false) {
      sendVCard()
      return
    }
    if (!spoken && env.settingsLive.voiceCancelOnSilence !== false) {
      closeVCard(true)
      return
    }
    markVCardListening(false)
  }

  /**
   * 松手之后，等文字定稿再决定收尾动作。
   *
   * 判据是"连续 VOICE_SETTLE_MS 没有变化"，最长等 VOICE_SETTLE_MAX_MS。
   * 豆包的智能整理通常会在这段窗口里把内容改写一到两次；每改一次就重新计时。
   */
  function startVoiceSettle() {
    stopVoiceSettle()
    vcardState.settleLastText = String((vcardBox && vcardBox.value) || '')
    vcardState.settleStableAt = Date.now()
    vcardState.settleDeadline = Date.now() + VOICE_SETTLE_MAX_MS
    vcardState.settleTimer = setInterval(function () {
      if (!vcardState.open) {
        stopVoiceSettle()
        return
      }
      var now = Date.now()
      var text = String((vcardBox && vcardBox.value) || '')
      if (text !== vcardState.settleLastText) {
        // 还在改写（智能整理）→ 重新计时，继续等
        vcardState.settleLastText = text
        vcardState.settleStableAt = now
        return
      }
      if (now - vcardState.settleStableAt < VOICE_SETTLE_MS && now < vcardState.settleDeadline) return
      stopVoiceSettle()
      finishVoiceSettle(text)
    }, VOICE_SETTLE_POLL_MS)
  }

  function closeVCard(animate) {
    if (!vcardState.open) return
    vcardState.open = false
    // 取消的那一刻就把空框的占位换成「正在关闭…」：卡正在塌缩，空框里挂着"直接打字也行…"
    // 是句假话。已经打出来的字**不动** —— 它就是那个塌缩动画要收掉的东西。
    if (vcardBox && !String(vcardBox.value || '').trim()) vcardBox.placeholder = '正在关闭…'
    vcardState.range = null
    vcardState.anchorRect = null
    // ⚠️ 必须**显式 blur**，不能只把卡片 display:none 掉。
    //
    // 输入法（豆包）的输入上下文是绑在"当前那个文本输入框"上的：卡片打开时我们把焦点
    // 抢给它，上下文就绑在了卡片的 textarea 上；卡片只是被隐藏时，它**仍然是输入法的输入框**
    // （display:none 不会让 macOS 的输入法自己解绑）。于是之后焦点虽然转到小窗输入框，
    // 输入法的合成仍然发生在卡片上 —— 用户实测的症状就是：
    //   小窗输入框能收到 keydown，却**永远收不到 beforeinput**（输入法合成），
    //   打不进字、也没有插入符。
    // focus-trace 抓到的实测序列：
    //   临时卡片上有 beforeinput（正常）→ 小窗输入框上只有 keydown（打不进）
    //   → 焦点回到宿主输入框后 beforeinput 立刻恢复。
    if (vcardBox && typeof vcardBox.blur === 'function') {
      try {
        vcardBox.blur()
      } catch (error) {
        /* 桩环境 */
      }
    }
    stopVoiceSettle()
    stopMicWatch()
    // 形变还没结束就被关掉时，正文宽度可能还钉着 —— 一并解开
    unpinVCardBox()
    // 动画期间正文/占位都留着（要塌的就是它），收尾时才清
    if (animate && playCrtOff()) return
    finishCrtOff()
  }

  /** 发送：跳过翻译与详解，把说的话当作第一条追问直接发出去。 */
  function sendVCard() {
    var asked = String((vcardBox && vcardBox.value) || '').trim()
    if (!asked) {
      focusVCard()
      return
    }
    var selection = env.state.selection
    if (!selection) {
      closeVCard()
      return
    }
    // 侧边栏网页那条路没有 Range（不透明源帧的选区拿不出来），上下文 / 标签直接用
    // 帧内桥采好带过来的那份 —— 与 openForSelection 的 iframe 分支同一条规则。
    var contextInfo =
      selection.source === 'iframe' || !selection.range
        ? {
            context: String(selection.context || ''),
            keyContext: String(selection.keyContext || ''),
            label: selection.label,
          }
        : collectContext(env.rangeSelection(selection.range))
    // 交接起点：卡片**现在**的矩形。必须在 closeVCard 之前量 —— 之后它 display:none，量出来是 0。
    // 小窗会从这一格"长出来"（见 growPanelFromCard）。
    vcardHandoff = vcardRect()
    closeVCard()
    env.openPanelWith(
      selection.text,
      contextInfo.context,
      contextInfo.label,
      selection.rect,
      contextInfo.keyContext,
      { askFirst: asked },
    )
    env.clearDocSelection()
    // 选区连同它的记录一起作废（与 openForSelection 一致）
    env.state.selection = null
    env.state.bridgeActive = false
  }

  /**
   * "现在这一下该不该抢焦点"。
   *
   * 本文档里的选区：`document.hasFocus()` 就是答案（与改动前完全一致）。
   * 侧边栏网页里的选区：焦点其实落在**不透明源子框架**里，父文档的 `hasFocus()`
   * 有没有为真由浏览器实现说了算（跨引擎没有统一答案），所以对它改用
   * "这一帧刚报过动作"当证据 —— 桥报上来的那一刻，用户确实正在那个网页里划词 / 点按。
   */
  function hasFocusEvidence(selection) {
    if (typeof document.hasFocus !== 'function') return true
    if (document.hasFocus()) return true
    if (!selection || selection.source !== 'iframe' || !selection.frame) return false
    return Date.now() - (env.frameTouchedAt.get(selection.frame) || 0) < FRAME_FOCUS_EVIDENCE_MS
  }

  /** 卡片当前的视口矩形（拿不到就返回 null —— 那就不做交接动画，老实瞬开）。 */
  function vcardRect() {
    if (!vcard || typeof vcard.getBoundingClientRect !== 'function') return null
    try {
      var rect = vcard.getBoundingClientRect()
      return rect && rect.width && rect.height ? rect : null
    } catch (error) {
      return null
    }
  }

  /** host 报的占用者里，有没有已知输入法。 */
  function matchingIme(data) {
    if (!data || !data.capturing || !Array.isArray(data.processes)) return null
    for (var i = 0; i < data.processes.length; i++) {
      var proc = data.processes[i] || {}
      var id = String(proc.bundleId || '')
      for (var j = 0; j < IME_BUNDLES.length; j++) {
        if (id.indexOf(IME_BUNDLES[j]) === 0) return proc
      }
    }
    return null
  }

  /**
   * 只在"有选区"时轮询（浮标亮着的那几拍）。不叠请求：上一拍没回来就跳过这一拍。
   * 拿不到 host 的能力（非 macOS / 探针没编出来）就**停掉轮询**，不再空转。
   */
  function startMicWatch() {
    if (vcardState.timer) return
    // 两条路都要盯麦克风：解读选区（面板没开 → 语音卡）与引用选区（面板开着 → 自动引用）
    if (!env.state.selection && !env.state.quoteSelection) return
    vcardState.timer = setInterval(micTick, MIC_POLL_MS)
    env.timers.push(vcardState.timer)
    micTick()
  }

  function stopMicWatch() {
    // ⚠️ 抑制标记必须**跟着轮询一起复位**，不能只放在"轮询到没在录"那一拍上：
    // 自动引用做完就会 hideQuoteButton → 停轮询（浮标收了就没什么可等的），
    // 那一拍于是可能永远不来，标记就一直挂着 true。
    //
    // 靠"下一次划词自愈"也不可靠：只有浮标亮起来那一刻麦克风**已经关着**，
    // 最早那一拍才会答"没在录"、顺手把它复位；麦克风正开着时每一拍都答"在录"，
    // 标记就没机会复位。真实用法里这个顺序几乎凑不出来（鼠标一划，语音就断了），
    // 所以它更像颗埋着的雷而不是现行 bug —— 但状态机不该建立在
    // "用户凑不出这个顺序"上（将来若给这条路加"说完直接发送"，它就立刻变成真问题）。
    //
    // 语义上这样才对：一次观察窗口（浮标亮着的这段时间）里只处理第一次开麦。
    quoteVoiceHandled = false
    if (!vcardState.timer) return
    clearInterval(vcardState.timer)
    vcardState.timer = null
  }

  function micTick() {
    if (vcardState.busy) return
    // 两个都空了（选区没了 / 引用浮标收了）：没什么可等的，停掉轮询
    if (!env.state.selection && !env.state.quoteSelection) {
      stopMicWatch()
      return
    }
    vcardState.busy = true
    fetch(MIC_API)
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        vcardState.busy = false
        if (!data || !data.available) {
          stopMicWatch()
          return
        }
        if (matchingIme(data)) {
          // ── 小窗开着：引用那条路（开麦 = 点一下「❝ 引用」+ 光标进小窗输入框）──
          // 与语音卡互斥：panelOpen 时前者根本不该启动（openVCard 自己也会拒）。
          if (env.panelOpen && env.state.quoteSelection && !vcardState.open) {
            if (quoteVoiceHandled) return
            quoteVoiceHandled = true
            autoQuoteFromVoice()
            return
          }
          if (vcardState.suppress) return
          // 又开始录了：上一次的"等定稿"作废
          stopVoiceSettle()
          if (!vcardState.open) openVCard()
          else markVCardListening(true)
          return
        }
        // 没人在录了：这一次录音结束，解除抑制（下一次开麦才允许再弹 / 再加引用）
        vcardState.suppress = false
        quoteVoiceHandled = false
        if (!vcardState.open) return
        // 开麦结束了。卡片**不立刻退出**：下面两个收尾行为都要等文字定稿
        //（松手那一刻输入法还会做一次智能整理，见 startVoiceSettle）。
        // 两个开关都关掉时卡片就留着 —— 一个字都没说也能接着手动打字。
        // 这里只把"在听"停掉（见 markVCardListening）。
        //
        // 两个收尾行为（设置页「界面 · 语音输入」，**默认都开**，见 Config 注释）：
        //   · voiceAutoSend：有字 → 等于替用户点了发送键（发送自己会关卡片、开小窗）；
        //   · voiceCancelOnSilence：没字 → 等于替用户按了 Esc（带关机动画）。
        // 都从 settingsLive 现读，所以设置一改下一次松手就生效；判断用 `!== false` ——
        // 还没加载完 / 读失败时按**出厂默认（开）**处理，与 host 侧 Config 的缺省值一致。
        // ⚠️ 松手这一刻**文字还没定稿**：豆包紧接着还会做一次智能整理，会改写输入框内容。
        // 所以两个收尾行为都不在这里执行，而是先挂上"等定稿"的观察（见 startVoiceSettle）。
        markVCardListening(false)
        // ⚠️ 这个分支在"麦克风关着"期间**每一拍都会走**（200ms 一次），
        // 所以必须幂等：已经在等定稿就不要再 startVoiceSettle() ——
        // 那会把"稳定起点"重置，永远等不到 VOICE_SETTLE_MS（实测就是这个坑：
        // settleFor 一直停在几十毫秒，卡片永远不动作）。
        if (
          !vcardState.settleTimer &&
          (env.settingsLive.voiceAutoSend !== false || env.settingsLive.voiceCancelOnSilence !== false)
        ) {
          startVoiceSettle()
        }
      })
      .catch(function () {
        vcardState.busy = false
        stopMicWatch()
      })
  }

  /**
   * 开麦 = 点一下「❝ 引用」（用户 2026-10-09 定的行为）。
   *
   * 小窗开着时，划词浮出的是引用浮标；这时用户按下输入法的语音键，我们做的正是
   * "点一下那个浮标"那件事：把选中的文字挂进小窗、并把光标移到小窗输入框 ——
   * 于是输入法上屏的字直接落进小窗，和引用一起成为下一条追问。
   *
   * 为什么必须在**开麦那一刻**做：输入法上屏发生在松手那一刻，焦点得提前挪好
   * （与语音卡抢焦点同一条时序，见文件上方那段注释）。检测延迟由"探针 125ms +
   * 页面轮询 200ms"构成，豆包从按下到松手通常有几秒，够用。
   *
   * 守卫与 openVCard 完全一致（页面没焦点 / 用户正在别处打字 → 不抢，否则就是把
   * 人家在别处的听写拽进小窗），另外多加一条：插件自己的 🎤 正在录音时不抢 ——
   * 那套走 host 识别、与输入法语音是两回事，焦点该留给它。
   * （"没焦点"同样按 hasFocusEvidence 判：侧边栏网页里那条选区也得能走这条路。）
   *
   * 用户取消语音（Esc）或一个字没说：**引用留着**（可一键 ✕ 删）。撤销会让"引用到底
   * 加没加"变得难预期，而且点浮标那条路也是加了就加了。
   */
  function autoQuoteFromVoice() {
    var selection = env.state.quoteSelection
    if (!env.panelOpen || !selection) return
    if (!hasFocusEvidence(selection)) return
    if (env.isTypingTarget(document.activeElement)) return
    if (env.voice && env.voice.phase !== 'idle') return
    // 与点浮标同一条路：上下文在这一刻才采（"引用当时在哪一段对话里"最有用的就是它）
    env.addQuote(selection.text, selection.label, env.quoteContextFor(selection))
    hideQuoteButton()
    // addQuote 在"重复引用 / 到上限"时会提前 return（那两条路不会聚焦），但"说话的字要落进
    // 小窗"这件事仍然必须成立 —— 所以焦点在这里再兜一次（composerVisible 已由 addQuote 保证）。
    if (env.composerVisible()) env.focusAskBox()
  }

  function hideQuoteButton() {
    env.quoteButton.style.display = 'none'
    env.setQuotePop(false)
    // 浮标收了就没什么可等的了（与 hideButton 同一条规则）；语音卡开着时不能停
    if (!vcardState.open) stopMicWatch()
  }
  return {
    hideQuoteButton,
    get vcardState() { return vcardState },
    set vcardState(value) { vcardState = value },
    closeVCard,
    repositionVCard,
    get vcard() { return vcard },
    set vcard(value) { vcard = value },
    get vcardBox() { return vcardBox },
    set vcardBox(value) { vcardBox = value },
    openVCard,
    syncVCardText,
    sendVCard,
    startMicWatch,
    stopMicWatch,
    get vcardHandoff() { return vcardHandoff },
    set vcardHandoff(value) { vcardHandoff = value },
    prefersReducedMotion,
    get panelGrowTimer() { return panelGrowTimer },
    set panelGrowTimer(value) { panelGrowTimer = value },
    get panelGrowHandler() { return panelGrowHandler },
    set panelGrowHandler(value) { panelGrowHandler = value },
  }
}
