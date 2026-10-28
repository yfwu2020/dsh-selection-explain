import { createControllers } from './controllers.js'
import { bindClientEvents } from './events.js'

import { el, selectionDetached } from './dom.js'
import { createClientView } from './view.js'
import { createClientState, createPanelRuntime, createPillState } from './state.js'
import { PILL_STAR_DOT_D, createPreferences, PING, PILL_MORPH_MS, PILL_STAR_D, VOICE_FALLBACK_SECONDS, PILL_BALL_SIZE, PILL_SNAP_RADIUS } from './constants.js'

import React from 'react'
import { previewFrames, splitSections } from './render.js'
import { recordingSupported } from './audio.js'

import { createResultCache, createTimerScope } from './memory.js'

export function apply(ctx) {

  var state = createClientState()
  var runtime = createPanelRuntime()
  var pillState = createPillState()
  var preferences = createPreferences()

  /** 结果缓存：同选区+上下文第二次点开即秒回。 */
  var cache = createResultCache()
  var timerScope = createTimerScope()

  var view = createClientView()
  var { settingsSheet, modelMenu, settingsNote, settingsNoteText, settingsRail, settingsBody, pill, panel, settingsScrim, settingsButton, layer, body, translationSection, detailSection, button, quoteButton, askRow, quotesBox, expandButton, quote, retryButton, closeButton, askBox, pillName, pillMeta, pillCaret, pillStar, historyButton, chatLog, askSend, promoteButton, attachBox, attachNote, attachInput, modelPillName, modelPillTier, modelPill, webMode, cellMd, cellWeb, voiceActivityText, voiceActivity, voiceDot, voiceActionSlot, captureRow, askTools, askSpacer, micButton, waveSvg, voiceStop, voiceCancel, waveBars, prefSeg, settingsBack, settingsClose, settingsReset, addButton, head, gripCorner, gripRight, gripBottom, styleEl } = view
  var { settingsController, selectionController, voiceCardController, quotesController, previewController, lightboxController, panelController, pillController, historyController, conversationController, attachController, shotController, modelsController, voiceController } = createControllers({
    get preferences() { return preferences },
    get state() { return state },
    get runtime() { return runtime },
    get settingsSheet() { return settingsSheet },
    get modelMenu() { return modelMenu },
    get settingsNote() { return settingsNote },
    get settingsNoteText() { return settingsNoteText },
    get settingsRail() { return settingsRail },
    get settingsBody() { return settingsBody },
    get pillState() { return pillState },
    get pill() { return pill },
    get panel() { return panel },
    get settingsScrim() { return settingsScrim },
    get settingsButton() { return settingsButton },
    get later() { return later },
    get layer() { return layer },
    get body() { return body },
    get translationSection() { return translationSection },
    get detailSection() { return detailSection },
    get button() { return button },
    get quoteButton() { return quoteButton },
    get ensureLayer() { return ensureLayer },
    get timerScope() { return timerScope },
    get askRow() { return askRow },
    get quotesBox() { return quotesBox },
    get ctx() { return ctx },
    get cache() { return cache },
    get expandButton() { return expandButton },
    get quote() { return quote },
    get historyList() { return historyList },
    get retryButton() { return retryButton },
    get closeButton() { return closeButton },
    get askBox() { return askBox },
    get pillName() { return pillName },
    get pillMeta() { return pillMeta },
    get pillCaret() { return pillCaret },
    get pillStar() { return pillStar },
    get historyButton() { return historyButton },
    get chatLog() { return chatLog },
    get askSend() { return askSend },
    get turnsRenderPending() { return turnsRenderPending },
    set turnsRenderPending(value) { turnsRenderPending = value },
    get lastTurnsRenderAt() { return lastTurnsRenderAt },
    set lastTurnsRenderAt(value) { lastTurnsRenderAt = value },
    get STREAM_RENDER_MS() { return STREAM_RENDER_MS },
    get waitList() { return waitList },
    get rafPending() { return rafPending },
    set rafPending(value) { rafPending = value },
    get promoteButton() { return promoteButton },
    get attachBox() { return attachBox },
    get attachNote() { return attachNote },
    get attachInput() { return attachInput },
    get modelPillName() { return modelPillName },
    get modelPillTier() { return modelPillTier },
    get modelPill() { return modelPill },
    get webMode() { return webMode },
    get cellMd() { return cellMd },
    get cellWeb() { return cellWeb },
    get voiceActivityText() { return voiceActivityText },
    get voiceActivity() { return voiceActivity },
    get voiceDot() { return voiceDot },
    get voiceActionSlot() { return voiceActionSlot },
    get captureRow() { return captureRow },
    get askTools() { return askTools },
    get askSpacer() { return askSpacer },
    get micButton() { return micButton },
    get waveSvg() { return waveSvg },
    get voiceStop() { return voiceStop },
    get voiceCancel() { return voiceCancel },
    get waveBars() { return waveBars },
  })

  quotesController.renderQuotes()

  // 「最近聊过的」是**独立的浮层**（贴面板侧边），不和消息共用一个滚动区
  var historyList = el('div', 'dsh-sel-history')

  historyList.style.display = 'none'

  layer.appendChild(historyList)

  /**
   * 官方槽仅保留不可见的生命周期锚点；界面根由本插件挂到 body。
   * 稳定 ref 避免 React 重渲染时摘挂根节点、丢失输入焦点。
   */
  function syncFullViewLayer() {
    var fullView = !!document.querySelector('[data-dsh-full-view]')
    if (fullView !== layer.hasAttribute('data-full-view')) {
      if (fullView) layer.setAttribute('data-full-view', '')
      else layer.removeAttribute('data-full-view')
    }
  }

  /**
   * 确保浮层还挂在 document.body 上。
   *
   * 为什么要这个：layer 是靠 slot(`shell.overlay`) 挂上去的，而 slot 重渲染时
   * 会把它的子节点（包括我们的 layer）一起摘掉，ref 回调却不会因此再触发一次。
   * 结果就是：框、卡片全都 append 进一个**已经脱离文档**的节点 —— 表现是
   * "按了快捷键什么都没出现"，而且 getBoundingClientRect 全是 0（实测踩到）。
   * 显示任何浮层之前调一下，代价是一次 parentNode 比较。
   */
  function ensureLayer() {
    if (typeof document === 'undefined' || !document.body) return
    if (layer.parentNode !== document.body) document.body.appendChild(layer)
  }

  function mountFloatingLayer(node) {
    if (node) {
      if (layer.parentNode !== document.body) document.body.appendChild(layer)
      syncFullViewLayer()
    } else if (layer.parentNode) layer.parentNode.removeChild(layer)
  }

  var fullViewObserver = null

  if (typeof MutationObserver === 'function') {
    fullViewObserver = new MutationObserver(syncFullViewLayer)
    fullViewObserver.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['data-dsh-full-view']})
  }

  /** 开窗后"还没聚焦过输入框"（见 focusComposerOnce）。 */

  /** 调试：最后一次"没聚焦"卡在哪一步（-1 表示聚焦成功）。 */
  /** 调试：最后一次"没聚焦"卡在哪一步（成功时是 'ok'）。自动聚焦这类问题很难从外部看出来。 */

  var offSlot = null

  if (ctx.slots && typeof ctx.slots.inject === 'function') {
    try {
      offSlot = ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: '@yfwu2020/dsh-selection-explain',
          order: 20,
          label: function () {
            return '划词解读'
          },
        }, function SelectionExplainLayer() {
          return React.createElement('div', {
            className: 'dsh-sel-anchor',
            style: { display: 'none', pointerEvents: 'none' },
            ref: mountFloatingLayer,
          })
        })
      })
    } catch (error) {
      // 槽注册失败仅报错，自有界面根保持未挂载，不影响其他插件。
      console.error('[dsh-selection-explain] shell.overlay 槽注册失败：', error)
    }
  } else {
    console.error('[dsh-selection-explain] slots 服务不可用，划词解读 UI 未挂载')
  }

  /**
   * **本小窗所属的会话**（划词那一刻所在的那个）。
   *
   * 不能直接用 currentSessionId()：那是"当前正在看的会话"，用户切走之后它立刻变了。
   * 小窗的模型、背景、升格都该按**它自己那个会话**算 ——
   * 否则切到别的会话再打开设置，括号里会报成另一个会话的模型（用户报的问题）。
   */

  var rafPending = false

  /** 流式重绘限速（毫秒）：见 scheduleTurnsRender / schedulePaint。 */
  var STREAM_RENDER_MS = 90

  var turnsRenderPending = false

  var lastTurnsRenderAt = 0

  /** 贴位置的自适应节奏（见 schedulePillPlacer）。 */
  var PILL_POLL_MIN = 2000

  var PILL_POLL_MAX = 60000

  /**
   * 胶囊的拖动 / 吸附 / 收球状态（几何参数 PILL_* 在文件上方，CSS 也要用）。
   *
   *   · pillDock：'anchor' = 贴费用胶囊（量不到就贴右下角，由 placePill 管）；
   *               'free'   = 用户拖到别处了 —— 位置归用户，轮询不许再动它。
   *   · pillFreeRight：自由摆放时记的是**右边缘**（收球/展开都以右侧为锚点：
   *     胶囊向左展开、向右收成球，右边缘一个像素都不动 —— 用户要的就是这个）。
   *     记中心是不行的：收球时右边缘会往左跑，球看起来"飘"了一下。
   *   · pillAnchorWidth：本次量到的费用胶囊宽度（0 = 没量到）—— 决定"跟随"还是"兜底"，
   *     也是"能不能收球"的前提（用户定的：只有没有费用胶囊时才收成小球）。
   */
  /** 胶囊总开关：host 的 pillEnabled 说关就关（见下面 ping 分支）。 */

  /** 刚拖完的那一下 click 要吞掉（拖动不该顺手开关小窗）。 */

  /** 静置计时器 id（0 = 没有）。用裸 setTimeout：它每帧都可能被重置，塞进 timers 数组会一直长。 */

  /**
   * 吸附滑行窗口的截止时刻（见 settlePillDrop / placePill）：
   * 这段时间内位置按 left/top 维持（能过渡），之后再交还给 right/bottom 的稳态定位。
   */

  /** 上一次量到的费用胶囊容器 / 正在观察它的 ResizeObserver（浏览器没有这个 API 时为 null）。 */

  /** 正在显示的等待特效（每个容器一条；同处同文案复用节点，避免重建打断动画）。 */
  var waitList = []

  function later(fn, ms) {
    return timerScope.later(fn, ms)
  }

  // 侧边栏里的预览帧是宿主 React 渲染的：新开标签、切预览/源码、文件变了都会换帧，
  // 所以既要初始扫一遍，也要盯着 DOM（只盯 srcdoc/src 两个属性 + 子节点增删）。
  if (typeof MutationObserver === 'function') {
    previewController.bridgeObserver = new MutationObserver(previewController.scheduleBridgeScan)
    previewController.bridgeObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['srcdoc', 'src'],
    })
  }

  previewController.scheduleBridgeScan()

  /**
   * 鼠标是不是按着（拖拽划词进行中）—— 记的是"按下那一刻"。
   *
   * 为什么记时刻而不是记一个布尔：松手落在浏览器窗口外时**不会补发 mouseup**，
   * 布尔一旦卡在 true，`selectionchange` 就被永久忽略 —— 浮标从此再也不会自己收了。
   * 超过 SELECT_PRESS_STALE_MS 就当已经松开（帧内那条桥用的是同一个兜底，见 bridgeBody）。
   *
   * 拖拽期间一律不查选区：时机要和"松手才弹浮标"一致，否则拖到一半浮标就冒出来，
   * 还跟着手指跑。
   */
  var SELECT_PRESS_STALE_MS = 6000

  var selectPressedAt = 0

  function selectPressing() {
    return selectPressedAt > 0 && Date.now() - selectPressedAt < SELECT_PRESS_STALE_MS
  }

  /**
   * 浮标亮着的时候，隔几拍确认一次"那段文字还在不在"。
   *
   * 为什么光有事件还不够：**Chrome 把选中的节点整个摘掉时会悄悄把选区塌陷，却不发
   * `selectionchange`**（真浏览器实测：替换 textContent 后 `rangeCount` 仍是 1、
   * `isCollapsed` 变成 true，而事件计数一个都不涨）。流式回答重渲染 / 消息重画走的正是这条路 ——
   * 只靠事件的话，浮标会一直亮着，点下去解读的是一段屏幕上已经没有的文字。
   *
   * 代价是可控的：**只在浮标可见的那几拍里干活**（它不可见时这一拍立刻返回，
   * 连选区都不读），而且只有发现选区没了/锚点被摘掉时才去排一次检查 ——
   * 正常亮着的那几拍不做任何 DOM 写。
   */
  var FLOAT_WATCH_MS = 400

  function watchFloatLiveness() {
    // 拖拽划词进行中不查：浮标要等松手才出现（与 mouseup 那条路径同一套时机）
    if (selectPressing()) return
    if (button.style.display !== 'inline-flex' && quoteButton.style.display !== 'inline-flex') return
    var selection = window.getSelection && window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      // 帧内那条选区**不在本文档**：点浮标会让本文档的选区塌掉，别把它误当成"文字没了"
      if (state.bridgeActive && state.selection && state.selection.source === 'iframe') return
      selectionController.scheduleCheck()
      return
    }
    var range = null
    try {
      range = selection.getRangeAt(0)
    } catch (error) {
      return
    }
    // 选区没塌陷、锚点却被摘掉了（Firefox 的行为）：也当"文字没了"
    if (selectionDetached(range)) selectionController.scheduleCheck()
  }

  var floatWatchId = setInterval(watchFloatLiveness, FLOAT_WATCH_MS)

  state.webAnswer = modelsController.readWebMode()

  modelsController.paintWebMode()

  // 模型/档位：从 localStorage 恢复；没存过就跟随"当前路由 + 配置档位"（ping 里就有）
  // 从 host 的统一设置恢复模型，不读取旧浏览器模型覆盖。
  settingsController.loadSettings(false)

  // 「追问」档位不再有浏览器本地覆盖：设置页那一行、小窗那四个格子、发出去的请求
  // 读的都是同一份配置（chatReasoningEffort，加载完由 applyServerValues 同步进 state.effort）
  modelsController.paintModelPill()

  fetch(PING + (panelController.currentSessionId() ? '?sessionId=' + encodeURIComponent(panelController.currentSessionId()) : ''), {
    headers: { accept: 'application/json' },
  })
    .then(function (response) {
      return response.json()
    })
    .then(function (data) {
      modelsController.modelCatalog.current = (data && data.route) || null
      modelsController.modelCatalog.stages = { chat: (data && data.reasoningEffortByStage && data.reasoningEffortByStage.chat) || '' }
      if (!settingsController.settingsSpec && data && data.limits) settingsController.applySelectionLimit(data.limits)
      // 侧边栏网页划词桥的总开关（host 配置 bridgeSidebarPreview，默认开）
      if (data && data.bridgeSidebarPreview === false) previewController.bridgeOn = false
      // 悬浮胶囊的两个偏好跟着 ping 一起下发（省得为它单开一次请求）。
      // 拿不到就保持默认（显示 + 10 秒收球）—— ping 失败不该让胶囊消失。
      if (data && data.pill) settingsController.applyPillPrefs(data.pill)
      modelsController.paintModelPill()
      return null
    })
    .catch(function () {
      /* ping 失败不影响使用：胶囊显示默认文案 */
    })

  // 费用胶囊的位置/尺寸会变（展开、缩放、数字变长、插件迟到挂载）→ 自适应频率地贴上去
  pillController.loadPillPos()
   // 先问一句上次拖到哪儿（异步，回来再摆）
  panelController.loadPanelSize()
   // 小窗的尺寸也问一句（拖角改过之后才有的值；位置不记）
  pillController.placePill()

  pillController.ensureResizeWatch()

  pillController.schedulePillPlacer()

  pillController.paintPill()

  // 过渡要等"第一帧已经贴好位置"之后再打开：否则挂载那一下会从 CSS 默认的 bottom:64
  // 一路滑到实测位置（右下角看着像自己飞过去）
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function () {
      pill.setAttribute('data-ready', '1')
    })
  } else {
    pill.setAttribute('data-ready', '1')
  }

  attachController.wireDrop()

  voiceController.paintVoice()

  historyController.ensurePanelInsideViewport()

  panelController.bindResizeGrip(gripCorner, 'se')

  panelController.bindResizeGrip(gripRight, 'e')

  panelController.bindResizeGrip(gripBottom, 's')
  var clientEvents = bindClientEvents({
    get previewController() { return previewController },
    get state() { return state },
    get selectionController() { return selectionController },
    get voiceCardController() { return voiceCardController },
    get preferences() { return preferences },
    get runtime() { return runtime },
    get button() { return button },
    get quoteButton() { return quoteButton },
    get selectPressedAt() { return selectPressedAt },
    set selectPressedAt(value) { selectPressedAt = value },
    get selectPressing() { return selectPressing },
    get modelMenu() { return modelMenu },
    get modelPill() { return modelPill },
    get modelsController() { return modelsController },
    get historyList() { return historyList },
    get historyButton() { return historyButton },
    get pill() { return pill },
    get historyController() { return historyController },
    get panel() { return panel },
    get panelController() { return panelController },
    get quotesController() { return quotesController },
    get cellMd() { return cellMd },
    get cellWeb() { return cellWeb },
    get prefSeg() { return prefSeg },
    get pillController() { return pillController },
    get pillState() { return pillState },
    get conversationController() { return conversationController },
    get PILL_POLL_MIN() { return PILL_POLL_MIN },
    get captureRow() { return captureRow },
    get settingsController() { return settingsController },
    get voiceController() { return voiceController },
    get settingsButton() { return settingsButton },
    get settingsBack() { return settingsBack },
    get settingsClose() { return settingsClose },
    get settingsReset() { return settingsReset },
    get settingsSheet() { return settingsSheet },
    get settingsScrim() { return settingsScrim },
    get promoteButton() { return promoteButton },
    get retryButton() { return retryButton },
    get expandButton() { return expandButton },
    get askBox() { return askBox },
    get askSend() { return askSend },
    get attachInput() { return attachInput },
    get attachController() { return attachController },
    get addButton() { return addButton },
    get micButton() { return micButton },
    get voiceCancel() { return voiceCancel },
    get voiceStop() { return voiceStop },
    get body() { return body },
    get closeButton() { return closeButton },
    get head() { return head },
  })

  // —— 调试钩子（自动化验证用） ——
  window.__dshSelectionExplain = {
    /** 截图提问的状态（调试/自动化）。 */
    shot: function () {
      return shotController.state()
    },
    /** 手动起一次截图（等同按 ⌘⇧X）。 */
    shotStart: function () {
      shotController.capture()
      return true
    },
    /**
     * 语音卡（选中文字 + 输入法正在语音输入 → 就地追问）的状态。
     * 给自动化验证用：能不能弹、有没有焦点、几何对不对，全在这里读。
     */
    voiceCard: function () {
      return {
        open: voiceCardController.vcardState.open,
        closing: voiceCardController.vcardState.closing,
        watching: !!voiceCardController.vcardState.timer,
        /** 正在等文字定稿（松手后输入法还会智能整理）；settleFor = 距上次文字变化多久（毫秒）。 */
        settling: !!voiceCardController.vcardState.settleTimer,
        settleFor: voiceCardController.vcardState.settleStableAt ? Date.now() - voiceCardController.vcardState.settleStableAt : -1,
        voiced: !!(voiceCardController.vcard && voiceCardController.vcard.getAttribute('data-voiced') === '1'),
        hasText: !!(voiceCardController.vcard && voiceCardController.vcard.getAttribute('data-text') === '1'),
        text: voiceCardController.vcardBox ? voiceCardController.vcardBox.value : '',
        focused: !!(voiceCardController.vcardBox && document.activeElement === voiceCardController.vcardBox),
        geometry: voiceCardController.vcard
          ? {
              left: voiceCardController.vcard.style.left,
              top: voiceCardController.vcard.style.top,
              width: voiceCardController.vcard.style.width,
              height: voiceCardController.vcard.style.height,
            }
          : null,
      }
    },
    /** 手工把卡打开/收起/发送（测试与调试用；正常路径由麦克风轮询驱动）。 */
    /** 调试：最后一次自动聚焦卡在哪一步。 */
    focusBail: function () {
      return runtime.focusBail
    },
    /** 重新拉一次设置（测试用：设置只在启动时读一次，桩里改完值要能刷新）。 */
    reloadSettings: function () {
      settingsController.loadSettings(true)
      return Object.assign({}, settingsController.settingsLive)
    },
    voiceCardOpen: function () {
      voiceCardController.openVCard()
      return window.__dshSelectionExplain.voiceCard()
    },
    voiceCardClose: function () {
      voiceCardController.closeVCard()
      return window.__dshSelectionExplain.voiceCard()
    },
    voiceCardSend: function (text) {
      if (voiceCardController.vcardBox && text !== undefined) {
        voiceCardController.vcardBox.value = String(text)
        voiceCardController.syncVCardText()
      }
      voiceCardController.sendVCard()
      return true
    },
    /** 重新读一次 host 上的小窗尺寸（测试用；正常路径只在挂载时读一次）。 */
    loadPanelSize: function () {
      panelController.panelSizeAsked = false
      panelController.loadPanelSize()
      return true
    },
    /** 当前小窗几何（测试用：直接读渲染值，不经过变量）。 */
    panelGeom: function () {
      var rect = panelController.panelLayoutRect()
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height, resized: panel.getAttribute('data-resized') === '1' }
    },
    /** 重新读一次 host 上的胶囊位置（测试用；正常路径只在挂载时读一次）。 */
    loadPillPos: function () {
      pillController.pillPosAsked = false
      pillController.pillUserPlaced = false // 测试要确定性地验"读回来"这条路径
      pillController.loadPillPos()
      return true
    },
    /** 球心图形在进度 p 处的 path（p 可略越界）—— 测试按它核对整条形变轨迹。 */
    pillStarAt: function (p) {
      return pillController.pillStarPathAt(p)
    },
    /** 当前进度与目标（测试核对收/放确实把图形推向了正确的一端）。 */
    pillStarProgress: function () {
      return pillController.pillStarP
    },
    pillStarTarget: function () {
      return pillController.pillStarTargetP
    },
    /** 形变动画被起跑了几次 + 目标序列（诊断用：一直重新起跑就永远到不了终点）。 */
    pillStarStarts: function () {
      return pillController.pillStarStarts
    },
    pillStarLog: function () {
      return pillController.pillStarLog
    },
    /** 直接跑一次形变动画（与胶囊状态解耦）：测试用它确定性地验"计时器在推进"。 */
    pillStarAnimate: function (to) {
      pillController.animatePillStar(to ? 1 : 0)
      return true
    },
    /** 同步画到某个进度（几何断言/截图用，绕开计时器与异步活动）。 */
    pillStarTo: function (p) {
      if (pillController.pillStarTimer) {
        clearTimeout(pillController.pillStarTimer)
        pillController.pillStarTimer = 0
      }
      pillController.pillStarTargetP = p
      pillController.paintPillStar(p)
      return true
    },
    pillStarEaseAt: function (x) {
      return pillController.pillStarEase(x)
    },
    /** JS 那条时长（毫秒）—— 测试核对它与 CSS 那条 .28s 是否同拍。 */
    pillMorphMs: function () {
      return PILL_MORPH_MS
    },
    /** 球心里那两条 path（圆点态 / 星芒态）—— 自检与截图模式用它，避免在测试里抄一遍几何。 */
    pillStarD: function () {
      return PILL_STAR_D
    },
    pillStarDotD: function () {
      return PILL_STAR_DOT_D
    },
    open: function (text, context, label, keyContext) {
      state.selection = { text: text, range: null, rect: null }
      // 和真实划词完全同一条路径（含本地缓存命中）；keyContext 省略时与 context 相同
      panelController.openPanelWith(text, context || '', label || '调试', null, keyContext)
      return true
    },
    expand: function () {
      conversationController.expandDetail()
      return true
    },
    parts: function () {
      return { ...state.parts, stage: state.stage }
    },
    promote: function () {
      conversationController.promote()
      return true
    },
    ask: function (question) {
      conversationController.ask(question)
      return true
    },
    turns: function () {
      return state.turns.slice()
    },
    memory: function () {
      return { cacheEntries: cache.size, cacheTextBytes: cache.textBytes,
        timers: timerScope.size, previewFrames: Object.keys(previewFrames).length }
    },
    /** 自检用：当前待发送的引用（引用区里那几张卡片）。 */
    quotes: function () {
      return state.quotes.map(function (quote) {
        return {
          id: quote.id,
          label: quote.label,
          text: quote.text,
          context: quote.context || '',
          contextChars: (quote.context || '').length,
          session: quote.session === true,
        }
      })
    },
    /** 自检用：手工加一段引用（等价于点了「❝ 引用」/「引用整条」）。 */
    quote: function (text, label, extra) {
      return quotesController.addQuote(text, label || '调试', extra || {})
    },
    /** 自检用：某个节点上的选区会被标成什么出处（等价于点引用那一刻算出来的那个）。 */
    quoteLabel: function (node) {
      return node ? selectionController.panelSourceLabel(node) : '（需要传节点）'
    },
    /** 自检用：引用 + 提问拼出来的那条消息原文（发给模型的就是它）。 */
    compose: function (quotes, question) {
      return quotesController.composeQuestion(quotes || state.quotes, question)
    },
    /** 自检用：引用浮标与最近一次可引用选区的状态。 */
    quoteState: function () {
      return {
        visible: quoteButton.style.display === 'inline-flex',
        selection: state.quoteSelection
          ? {
              text: state.quoteSelection.text,
              label: state.quoteSelection.label,
              source: state.quoteSelection.source,
              turnIndex: state.quoteSelection.turnIndex === undefined ? -1 : state.quoteSelection.turnIndex,
              hasRange: !!state.quoteSelection.range,
            }
          : null,
        panelOpen: runtime.panelOpen,
        resolving: state.resolvingQuotes === true,
      }
    },
    /** 自检用：引用浮标的节点（无头环境里页面可能挂了两棵树，用这个拿真正带监听的那个）。 */
    quoteNode: function () {
      return quoteButton
    },
    close: panelController.closePanel,
    /**
     * 自检用：语音输入的状态（阶段 / 提示 / 目录 / 最近一次转写）。
     * phase：idle / requesting / recording / transcribing / done
     */
    voice: function () {
      return {
        phase: voiceController.voice.phase,
        supported: recordingSupported(),
        /** 录音行出来了没有（出来了 = 工具行换成了 ✕ / 波形 / ■ 那一套）。 */
        capture: captureRow.getAttribute('data-show') === '1',
        /** 状态文案（请允许使用麦克风… / 识别中… / 出错原因）。 */
        activity: voiceActivityText.textContent,
        activityTone: voiceActivity.getAttribute('data-tone') || '',
        dot: voiceDot.style.display !== 'none',
        waveform: waveSvg.style.display !== 'none',
        stop: voiceStop.style.display !== 'none',
        /** 行内动作：'prepare'（准备模型）/ 'retry'（🎤 重录）/ ''。 */
        action: voiceController.voice.action || '',
        maxSeconds: voiceController.voice.maxSeconds || VOICE_FALLBACK_SECONDS,
        level: Number(voiceController.voice.level.toFixed(3)),
        lastText: voiceController.voice.lastText,
        /** 波形 80 根线的高度（自检/冒烟用：静音时全是 2px 的基线）。 */
        bars: waveBars.map(function (bar) {
          return Number(bar.node.getAttribute('y2')) - Number(bar.node.getAttribute('y1'))
        }),
        /** 实时字幕：定稿 / 半句预览 / 拍数 / 有没有被整段识别改写过。 */
        live: {
          active: voiceController.voice.live.active,
          disabled: voiceController.voice.live.disabled,
          reason: voiceController.voice.live.reason,
          committed: voiceController.voice.live.committed,
          preview: voiceController.voice.live.preview,
          text: voiceController.voice.live.text,
          passes: { preview: voiceController.voice.live.passes.preview, commit: voiceController.voice.live.passes.commit },
          rewritten: voiceController.voice.live.rewritten,
          boundary: voiceController.voice.live.boundary,
          phraseStart: voiceController.voice.live.phraseStart,
          tap: voiceController.voice.capture && voiceController.voice.capture.tap && voiceController.voice.capture.tap.supported()
            ? {
                length: voiceController.voice.capture.tap.length(),
                loudIndex: voiceController.voice.capture.tap.loudIndex(),
                loudAt: voiceController.voice.capture.tap.loudAt(),
              }
            : null,
        },
        catalog: voiceController.voice.catalog
          ? {
              available: voiceController.voice.catalog.available === true,
              reason: voiceController.voice.catalog.reason || '',
              error: voiceController.voice.catalog.error || '',
              providers: (voiceController.voice.catalog.providers || []).map(function (provider) {
                return { id: provider.id, name: provider.name, phase: provider.phase }
              }),
            }
          : null,
      }
    },
    /** 自检用：麦克风按钮节点（无头环境里页面可能挂了两棵树，用这个拿真正带监听的那个）。 */
    voiceNode: function () {
      return micButton
    },
    /** 自检用：手动催一拍实时字幕（测试里不用干等 1.3s 的节流）。 */
    voiceTick: function () {
      voiceController.voice.live.tickAt = 0
      voiceController.liveTick()
      return true
    },
    /** 自检用：录音行的各部件（✕ / 波形 / 状态 / 动作位 / ■）。 */
    voiceNodes: function () {
      return {
        row: captureRow,
        cancel: voiceCancel,
        wave: waveSvg,
        activity: voiceActivity,
        action: voiceActionSlot,
        stop: voiceStop,
      }
    },
    /** 自检用：读/写追问输入框（验证"转写文字插进输入框"）。 */
    askValue: function (text) {
      if (text !== undefined) {
        askBox.value = String(text)
        conversationController.refreshAskState()
      }
      return askBox.value
    },
    /** 自检用：清掉本地缓存，模拟"刷新页面后重开"（验证历史回放路径）。 */
    forget: function () {
      cache.clear()
      return true
    },
    state: function () {
      return {
        phase: state.phase,
        cache: state.cacheState,
        cacheKey: state.cacheKey.slice(0, 24),
        sameTextSeen: state.sameTextHint,
        chars: state.chars,
        /** host 回报的本次请求实际档位（等待提示用）；和用户选的 effort 是两码事 */
        stageEffort: state.stageEffort,
        raw: state.raw,
        model: state.model,
        sections: splitSections(state.raw),
        tools: state.tools.length,
        toolBusy: state.toolBusy,
        toolDigest: state.toolDigest,
        /** 自检用：有没有在飞的请求 / 是不是"收起小窗中止"的那一轮。 */
        thought: state.thought,
        status: state.lastStatus,
        follow: state.follow,
        hasRequest: !!state.request,
        aborted: !!state.aborted,
        asking: !!state.asking,
      }
    },
    panel: function () {
      return panel
    },
    pill: function () {
      return pill
    },
    /** 自检用：模型/档位当前值 + 已加载的目录规模。 */
    modelState: function () {
      return {
        choice: state.modelChoice,
        effort: state.effort,
        pill: modelPillName.textContent + modelPillTier.textContent,
        menuOpen: modelMenu.getAttribute('data-open') === '1',
        catalog: { count: (modelsController.modelCatalog.items || []).length, current: modelsController.modelCatalog.current, stages: modelsController.modelCatalog.stages, error: modelsController.modelCatalog.error },
      }
    },
    /** 自检用：模型控件节点（无头环境里页面可能挂了两棵树，用这个拿到真正带监听的那个）。 */
    modelNodes: function () {
      return { pill: modelPill, menu: modelMenu }
    },
    /** 自检用：菜单开合与点击计数。 */
    modelMenuDebug: function () {
      return { clicks: modelsController.modelPillClicks, open: modelMenu.getAttribute('data-open'), expanded: modelPill.getAttribute('aria-expanded') }
    },
    openModel: function () {
      modelsController.openModelMenu()
      return modelMenu.getAttribute('data-open')
    },
    /** 自检用：拉一次模型目录（菜单会自己拉，这里给测试用）。 */
    loadModels: function (force) {
      return modelsController.loadModelCatalog(force === true).then(function (catalog) {
        modelsController.renderModelMenu()
        modelsController.paintModelPill()
        return { count: (catalog.items || []).length, current: catalog.current, stages: catalog.stages, error: catalog.error }
      })
    },
    /** 自检用：折叠统计与"即将发出去的历史"。 */
    foldStats: function () {
      return {
        folds: historyController.foldCount,
        turns: state.turns.map(function (turn) {
          return {
            role: turn.role,
            chars: String(turn.text || '').length,
            folded: typeof turn.foldedCache === 'string' ? turn.foldedCache.length : null,
          }
        }),
      }
    },
    /** 自检用：手工折一段文本（验证折叠函数本身）。 */
    foldText: function (text) {
      return historyController.foldForHistory(text)
    },
    /** 自检用：读/写网页模式开关。 */
    webMode: function () {
      return !!state.webAnswer
    },
    setWebMode: function (on) {
      return modelsController.setPref(on === true)
    },
    /** 自检用：当前档位的 aria 状态（两格各自的 aria-checked）。 */
    prefCells: function () {
      return {
        markdown: cellMd.getAttribute('aria-checked') === 'true',
        web: cellWeb.getAttribute('aria-checked') === 'true',
        pillShift: webMode.getAttribute('data-on') === '1',
      }
    },
    /** 自检用：手动触发一次"贴到费用胶囊上"，并报出这次有没有真的变。 */
    place: function () {
      return pillController.placePill()
    },
    /**
     * 自检用：胶囊的停靠 / 拖动 / 收球状态。
     * 拖动、吸附、收球那几条断言都读它（真浏览器里跑，量的是真布局）。
     */
    pillState: function () {
      var rect = pill.getBoundingClientRect()
      return {
        dock: pillState.pillDock,
        ball: pillState.pillBall,
        hover: pillState.pillHover,
        dragging: !!pillState.pillDrag,
        ready: pill.getAttribute('data-ready') === '1',
        anchorWidth: pillState.pillAnchorWidth,
        freeRight: pillState.pillFreeRight ? { right: Math.round(pillState.pillFreeRight.right), y: Math.round(pillState.pillFreeRight.y) } : null,
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          right: Math.round(window.innerWidth - rect.right),
          bottom: Math.round(window.innerHeight - rect.bottom),
        },
        style: {
          left: pill.style.left,
          top: pill.style.top,
          right: pill.style.right,
          bottom: pill.style.bottom,
          width: pill.style.width,
          maxWidth: pill.style.maxWidth,
        },
        ballSize: PILL_BALL_SIZE,
        idleMs: preferences.pillIdleMs,
        snapRadius: PILL_SNAP_RADIUS,
      }
    },
    /**
     * 自检用：立刻跑一次"静置该不该收球"（测试里等不起 PILL_BALL_IDLE_MS 那 10 秒）。
     * 返回 true = 这次真的收成球了。
     */
    pillIdle: function () {
      if (pillState.pillIdleId) {
        clearTimeout(pillState.pillIdleId)
        pillState.pillIdleId = 0
      }
      if (!pillController.pillCanBall()) return false
      pillController.collapsePill()
      return true
    },
    /** 自检用：当前的自适应间隔（毫秒）。 */
    pollDelay: function () {
      return pillState.pillPollDelay
    },
    /** 自检用：走一次调度器的单步（贴一次 + 按结果调整节奏），返回新的间隔。 */
    pollStep: function () {
      return pillController.pillPollStep()
    },
    /** 自检用：有没有用上 ResizeObserver（浏览器里有，Node 测试环境里没有）。 */
    resizing: function () {
      return !!pillState.pillObserver
    },
    /**
     * 自检用：侧边栏网页划词桥的状态。
     * frames 里的每一项对应一个"桥过的预览帧"；own=true 表示那一帧的文档
     * 是我们自己重发过的 blob（交互式预览走这条）。
     */
    bridge: function () {
      var frames = []
      previewController.bridged.forEach(function (url, frame) {
        frames.push({
          connected: frame.isConnected === true,
          own: !!url,
          srcdoc: frame.getAttribute('srcdoc') !== null,
          sandbox: frame.getAttribute('sandbox'),
        })
      })
      return {
        on: previewController.bridgeOn,
        frames: frames,
        active: !!state.bridgeActive,
        selection: state.selection && state.selection.source === 'iframe' ? state.selection.text : '',
      }
    },
    /** 自检用：扫一遍预览帧（等价于 DOM 变动后的那次自动扫描）。 */
    bridgeScan: function () {
      previewController.scanPreviewFrames()
      return window.__dshSelectionExplain.bridge()
    },
    /** 自检用：当前选区的来源与标签（source=iframe 表示来自侧边栏网页里的桥）。 */
    selection: function () {
      if (!state.selection) return null
      return {
        text: state.selection.text,
        source: state.selection.source || 'document',
        label: state.selection.label || '',
        context: state.selection.context || '',
        keyContext: state.selection.keyContext || '',
      }
    },
    /** 自检用：最近一次请求载荷的关键字段（标签 / 上下文 / 选中文字）。 */
    payload: function () {
      if (!state.payload) return null
      return {
        text: state.payload.text,
        label: state.payload.label,
        context: state.payload.context,
        kind: state.payload.kind,
        stage: state.payload.stage,
      }
    },
    /** 模拟"刷新页面后"：内存里那段小窗没了，只剩 host 上的历史。 */
    reset: function () {
      panelController.closePanel()
      state.payload = null
      state.selection = null
      state.bridgeActive = false
      state.parts = { translation: '', detail: '' }
      state.contextState = null
      state.turns = []
      quotesController.clearQuotes()
      state.raw = ''
      state.phase = 'idle'
      state.error = ''
      state.chars = 0
      state.aborted = false
      state.asking = false
      state.cacheKey = ''
      quote.textContent = ''
      panelController.paint()
      historyController.renderTurns()
      return true
    },
    ping: function () {
      // 带上会话 id：工具是按会话作用域注册的，不带就看不到 web_search
      var id = panelController.currentSessionId()
      var url = PING + (id ? '?sessionId=' + encodeURIComponent(id) : '')
      return fetch(url).then(function (response) {
        return response.json()
      })
    },
  }

  /**
   * 全局错误采集（诊断用，只上报不改变任何行为）。
   *
   * 为什么需要：页面里的报错只能靠开发者工具看，而"点某个按钮没反应"这类问题
   * 只能靠猜。这里把 window 的 error / unhandledrejection 报给 host
   * （/shot/status 的 clientError 字段），一眼就能看到真实堆栈。
   */
  ctx.effect(function () {
    if (typeof window === 'undefined' || !window.addEventListener) return function () {}
    function send(payload) {
      try {
        fetch('/selection-explain/api/shot/hello', {
          method: 'POST',
          body: JSON.stringify(Object.assign({ at: Date.now() }, payload)),
        }).catch(function () {})
      } catch (error) {
        /* ignore */
      }
    }
    function onError(event) {
      var err = event && (event.error || event)
      send({
        stage: 'window-error',
        message: String((err && err.message) || event.message || ''),
        stack: String((err && err.stack) || '').slice(0, 2000),
        source: String((event && event.filename) || ''),
        line: event && event.lineno,
      })
    }
    function onRejection(event) {
      var reason = event && event.reason
      send({
        stage: 'unhandled-rejection',
        message: String((reason && reason.message) || reason || ''),
        stack: String((reason && reason.stack) || '').slice(0, 2000),
      })
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return function () {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, 'selection-explain: error reporter')

  // —— 截图提问的快捷键（DSH 自己的快捷键服务；只在窗口有焦点时响应）——
  // 默认 ⌘⇧X。注册时 DSH 会做冲突校验，用户也能在设置里改键。
  // ⚠️ 必须走 inject 声明（见文件末尾 `inject`）：cordis 的服务按插件隔离，
  // 没声明就用 ctx.get('shortcuts') 取到的是 undefined（实测踩过）。
  var shortcutsService = ctx.shortcuts
  var shortcutReport = { loaded: true, shortcuts: !!shortcutsService, registered: false, error: '' }
  function reportShortcut() {
    try {
      fetch('/selection-explain/api/shot/hello', { method: 'POST', body: JSON.stringify(shortcutReport) }).catch(function () {})
    } catch (error) {
      /* 没有 fetch 的环境跳过 */
    }
  }
  reportShortcut()
  if (shortcutsService && typeof shortcutsService.register === 'function') {
    ctx.effect(function () {
      try {
        var off = shortcutsService.register({
        id: 'selection-explain.screenshot',
        label: function () {
          return '截图提问'
        },
        // ⚠️ 必须给数组：设置页渲染列表时会 `[...row.aliases]`，
        // 留成 undefined 会直接抛 TypeError，整个快捷键弹窗打不开（实测踩到）。
        aliases: [],
        // 键位是**物理键 + 修饰键**的结构（不是 "Mod+Shift+X" 这种字符串）：
        // code 必须是 KeyA-Z / Digit0-9 / F1-24 这类物理 code，modifiers 是 meta/control/alt/shift/primary
        // （primary 在 macOS 上是 ⌘、Windows 上是 Ctrl）。
        defaults: {
          'desktop:macos': { code: 'KeyX', modifiers: ['meta', 'shift'] },
          'web:macos': { code: 'KeyX', modifiers: ['meta', 'shift'] },
          'desktop:windows': { code: 'KeyX', modifiers: ['primary', 'shift'] },
          'web:windows': { code: 'KeyX', modifiers: ['primary', 'shift'] },
        },
        resolve: function () {
          return {
            status: 'handled',
            run: function () {
              shotController.capture()
            },
          }
        },
        })
        shortcutReport.registered = true
        reportShortcut()
        return off
      } catch (error) {
        shortcutReport.error = String((error && error.message) || error)
        reportShortcut()
        return function () {}
      }
    }, 'selection-explain: screenshot shortcut')
    // 长轮询一直挂着等结果（host 那边框选完成才会回）
    shotController.start()
  }

  // —— 可逆清理 ——
  ctx.effect(function () {
    if (typeof console !== 'undefined' && console.log) {
      console.log('[dsh-selection-explain] 划词解读已就绪（选中文字试试）')
    }
    return function () {
      runtime.panelOpen = false
      timerScope.dispose()
      cache.dispose()
      voiceCardController.closeVCard(false)
      lightboxController.dispose()
      attachController.clear()
      shotController.stop()
      shotController.clearMarkers()
      panelController.releaseRenderedContent()
      if (state.askRequest) state.askRequest.abort()
      clientEvents.dispose()

      if (floatWatchId) clearInterval(floatWatchId)

      // 语音输入：摘掉麦克风监听，并把正在录/正在识别的这一轮彻底作废（松开麦克风）

      voiceController.cancelVoice()

      if (historyController.chatGrowWatch) historyController.chatGrowWatch.disconnect()
      if (historyController.panelGrowWatch) {
        historyController.panelGrowWatch.disconnect()
        historyController.panelGrowWatch = null
      }
      if (pillState.pillPlacerId) clearTimeout(pillState.pillPlacerId)
      if (pillState.pillObserver) {
        try {
          pillState.pillObserver.disconnect()
        } catch (error) {
          /* noop */
        }
        pillState.pillObserver = null
      }
      if (fullViewObserver) fullViewObserver.disconnect()
      if (typeof offSlot === 'function') offSlot()
      // 划词桥：摘观察者与消息监听，并把我们自己建的预览 blob 全部回收
      if (previewController.bridgeScanId) clearTimeout(previewController.bridgeScanId)
      previewController.bridgeScanId = 0
      if (previewController.bridgeObserver) {
        try {
          previewController.bridgeObserver.disconnect()
        } catch (error) {
          /* noop */
        }
        previewController.bridgeObserver = null
      }
      previewController.bridged.forEach(function (url) {
        if (!url) return
        try {
          URL.revokeObjectURL(url)
        } catch (error) {
          /* noop */
        }
      })
      previewController.bridged.clear()
      previewController.frameTouchedAt.clear()
      state.turns = []
      state.quotes = []
      state.selection = null
      state.quoteSelection = null
      state.payload = null
      state.parts = { translation: '', detail: '' }
      state.raw = ''
      if (state.request) state.request.abort()
      // 胶囊的原生计时器不在 timerScope 中，单独清理。
      if (pillState.pillIdleId) clearTimeout(pillState.pillIdleId)
      if (pillController.pillStarTimer) clearTimeout(pillController.pillStarTimer)
      if (layer.parentNode) layer.parentNode.removeChild(layer)
      if (button.parentNode) button.parentNode.removeChild(button)
      if (quoteButton.parentNode) quoteButton.parentNode.removeChild(quoteButton)
      if (panel.parentNode) panel.parentNode.removeChild(panel)
      if (pill.parentNode) pill.parentNode.removeChild(pill)
      if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      try {
        delete window.__dshSelectionExplain
      } catch (error) {
        window.__dshSelectionExplain = undefined
      }
    }
  }, '@yfwu2020/dsh-selection-explain: 划词解读 UI')
}
export const inject = ['slots', 'shortcuts']
