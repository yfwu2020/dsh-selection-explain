/** Scroll following and viewport observers, scoped to the existing panel DOM. */
export function createHistoryScrollController(env) {
  /**
   * 内容变化前先量一次"现在是不是贴着底"。
   *
   * 之前用 scroll 事件维护 followScroll 开关：程序化 scrollTop 赋值本身也会派发 scroll，
   * 叠上流式追加，很容易算出一次假的"用户往上翻了"，开关一旦翻成 false 就再也不跟了——
   * 表现就是"追问后消息不回到底部"。改成变化前测量，稳。
   */
  function nearBottom() {
    return env.body.scrollHeight - env.body.scrollTop - env.body.clientHeight < 40
  }

  var stickAt = 0

  function stickToBottom() {
    stickAt = Date.now()
    env.body.scrollTop = env.body.scrollHeight
  }

  /**
   * 发完消息后**持续**贴底：内容会在之后异步长高——等待特效的思考尾巴、上一轮的预览 iframe
   * 上报新高度、面板从窄版切宽版引起重排……只在 renderTurns 里贴一次是不够的
   * （用户看到的就是"点了发送，消息没跟到最新位置"）。所以生成期间用 ResizeObserver 盯着消息区，
   * 只要"还在跟随"就再贴一次。
   */
  var chatGrowWatch = null

  function ensureChatFollow() {
    if (chatGrowWatch || typeof ResizeObserver !== 'function') return null
    chatGrowWatch = new ResizeObserver(function () {
      if (env.state.follow) stickToBottom()
    })
    chatGrowWatch.observe(env.chatLog)
    return function () {
      if (chatGrowWatch) chatGrowWatch.disconnect()
      chatGrowWatch = null
    }
  }

  /**
   * 面板被内容顶出屏幕 → 收回可视区。
   *
   * 为什么需要：开窗时"放得下吗"是按**当时**的高度算的（那会儿往往只有一行翻译在流），
   * 之后正文长高（上限 78vh 或 720px），面板从固定的 top 往下长 —— 而它是 position:fixed、
   * 页面不滚，被顶出视口的那部分（通常是回复框）就点不到了（实测能挂出去 287px）。
   *
   * 用面板**自己**的 ResizeObserver：只在尺寸变化时触发（内容长高、拖拽、阶段切换都算），
   * 而挪位置（left/top）不改变尺寸 → 不存在"写回自身"的循环。
   * 每帧只多一次 getBoundingClientRect，且只在真的溢出时才写样式。
   */
  var panelGrowWatch = null

  /**
   * 复核一次：面板被顶出视口就收回来（只在真的溢出时才写样式）。
   *
   * 两条入口都会调它：
   *   · paint() —— 流式/内容变化时的**主力**（渲染本来就节流在 90ms，一次 rect 读约 0.02ms）；
   *   · 面板自己的 ResizeObserver —— 兜住不经过 paint 的尺寸变化（阶段切换、composer 长高）。
   *
   * ⚠️ 曾经只挂 ResizeObserver，实测**不生效**：内容长高时面板往往已经顶到 max-height，
   * 伸长的是内部滚动区 —— 面板尺寸不变，观察器根本不触发（冒烟用例里探针显示 open:false、
   * 且灌内容后零唤醒）。所以主力必须是绘制路径上的复核。
   */
  function ensurePanelInsideViewportNow() {
    if (!env.panelOpen || env.panelInteracting) return
    var rect = env.panelLayoutRect()
    if (rect.bottom <= window.innerHeight - 4) return
    env.clampPanelPosition()
  }

  function ensurePanelInsideViewport() {
    if (panelGrowWatch || typeof ResizeObserver !== 'function') return null
    panelGrowWatch = new ResizeObserver(function () {
      ensurePanelInsideViewportNow()
    })
    panelGrowWatch.observe(env.panel)
    return function () {
      if (panelGrowWatch) {
        panelGrowWatch.disconnect()
        panelGrowWatch = null
      }
    }
  }

  /** 滚轮/触摸：用户自己滚 = 立刻收回跟随权；滚回底部再交还。 */
  function noteUserScroll(event) {
    var up = event && typeof event.deltaY === 'number' && event.deltaY < 0
    if (up) env.state.follow = false
    else env.state.follow = nearBottom()
  }

  /**
   * 普通 scroll（拖动滚动条、键盘、惯性滚动都会走到这里）。
   * 程序化赋值 scrollTop 同样会派发 scroll —— 用 stickAt 时间戳把"自己贴的底"排除，
   * 否则会被误判成"用户往上翻"，开关翻掉后再也不跟（这个坑之前踩过）。
   */
  function noteBodyScroll() {
    if (Date.now() - stickAt < 150) return
    env.state.follow = nearBottom()
  }

  return {
    nearBottom, stickToBottom, noteUserScroll, noteBodyScroll,
    ensureChatFollow, ensurePanelInsideViewport, ensurePanelInsideViewportNow,
    get chatGrowWatch() { return chatGrowWatch },
    set chatGrowWatch(value) { chatGrowWatch = value },
    get panelGrowWatch() { return panelGrowWatch },
    set panelGrowWatch(value) { panelGrowWatch = value },
  }
}
