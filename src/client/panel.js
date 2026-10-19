import { normalizeSpace, collectContext } from './context.js'
import { PANEL_SIZE, PANEL_GROW_MS, PANEL_GROW_EASE } from './constants.js'
import { listen, el, formatDuration, clamp } from './dom.js'
import { splitSections, stripEchoPrefix, renderRich } from './render.js'

/** panel state and operations; dependencies are supplied as live node/callback accessors. */
export function createPanelController(env) {

  // —— 面板 ——

  /** 当前会话 id（客户端 sessions 快照；取不到就留空，host 会跳过会话背景）。 */
  /**
   * 小窗相关请求该带的会话 id。
   *
   * 用 `panelSessionId`（划词那一刻的会话）而不是 `currentSessionId()`（当前正在看的会话）：
   * 小窗开着时用户可能切走，若还用后者，解读/追问/升格都会跑到**另一个会话**上 ——
   * 背景取错、模型也跟着换成另一个会话的（设置页括号里显示的也会与实际用的对不上）。
   * 还没划过词（panelSessionId 为空，比如启动时的 ping）自然落回当前会话。
   */
  function panelOrCurrentSessionId() {
    return env.panelSessionId || currentSessionId()
  }

  function currentSessionId() {
    try {
      // 新版 DSH 的列表只保存目录；导航身份在 uiSession 的主视图绑定中。
      var uiSession = env.ctx.get('uiSession')
      var bindingSource = uiSession && uiSession.adapter && uiSession.adapter.current
      if (bindingSource && typeof bindingSource.getSnapshot === 'function') {
        var binding = bindingSource.getSnapshot()
        var boundId = binding && binding.props && binding.props.sessionId
        return typeof boundId === 'string' ? boundId : ''
      }
      // 兼容尚未提供主视图绑定的旧版 DSH。
      var sessions = env.ctx.get('sessions')
      var store = sessions && sessions.list
      var snapshot = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null
      var id = snapshot && snapshot.current
      return typeof id === 'string' ? id : ''
    } catch (error) {
      return ''
    }
  }

  /**
   * 缓存 key：选中文字 + 局部上下文片段（空白归一，避免多选/少选一个空格就换 key）。
   * 注意 key 里**不含**会话背景——本地缓存的作用就是"同一个词再点一次立刻回放"。
   */
  function cacheKeyOf(text, context) {
    return normalizeSpace(text) + '\u0000' + normalizeSpace(context)
  }

  /** 缓存里有没有"同一个词、但上下文不同"的旧结果（用来解释这次为什么没命中）。 */
  function hasSameTextElsewhere(text) {
    var prefix = normalizeSpace(text) + '\u0000'
    var keys = env.cache.keys()
    for (var step = keys.next(); !step.done; step = keys.next()) {
      if (step.value.indexOf(prefix) === 0) return true
    }
    return false
  }

  /**
   * 选中文字是不是**代码**。
   * 先看容器（<pre>/<code> 直接判代码），容器看不出来再按文本特征打分：
   * 行首赋值/调用、花括号分号收尾、缩进块、关键字、运算符、注释行……
   * 阈值刻意偏高——宁可把一段英文当散文，也不要把散文当代码去"逐句注释"。
   */
  function looksLikeCode(text) {
    var t = String(text || '')
    if (!t.trim()) return false
    if (t.indexOf('\n') < 0 && t.trim().length < 24) return false // 单个短词几乎不可能是代码块
    var strong = 0
    if (/^\s*(?:[\w$.]+\s*[=(]|\}|\{|<[a-zA-Z/!])/m.test(t)) strong += 1
    if (/\{\s*$|\}\s*$|;\s*$/m.test(t)) strong += 1
    if (/^\s{2,}\S/m.test(t)) strong += 1
    if (/\b(function|def|class|import|export|const|let|var|return|async|await|public|private|static|interface|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|npm|pnpm|yarn|git|docker|curl)\b/.test(t)) strong += 1
    if (/=>|->|::|!=|===?|\+=|&&|\|\||<\/[a-zA-Z]/.test(t)) strong += 1
    if (/^\s*(#|\/\/|\/\*|\*|--|<!--)/m.test(t)) strong += 1
    var lines = t.split('\n').filter(function (line) { return line.trim() })
    if (strong >= 2) return true
    return lines.length >= 3 && strong >= 1 && /[{};=()]/.test(t)
  }

  /** 'code' | 'text'：代码走「注释」，文本走「翻译 / 解读」。 */
  function selectionKind(text, label) {
    if (label === '代码块') return 'code'
    return looksLikeCode(text) ? 'code' : 'text'
  }

  /**
   * 选中文字里有没有"需要翻译的英文"（拉丁字母组成的词/句）。
   * 决定了第一节的标题：有英文 → 「翻译」，纯中文 → 「解读」（纯汉字不翻译）。
   * 规则要和 host 侧提示词一致：至少两个连续拉丁字母才算。
   */
  function hasEnglishToTranslate(text) {
    return /[A-Za-z]{2,}/.test(String(text || ''))
  }

  function applySectionTitle(kind, text) {
    var title = kind === 'code' ? '注释' : hasEnglishToTranslate(text) ? '翻译' : '解读'
    env.state.sectionTitle = title
    env.translationSection.title.textContent = title
    env.expandButton.title = '当前只给了' + title + '（背景 8 条，首字更快）。点这里加载完整会话背景并生成详解。'
  }

  /** 一次解读请求的载荷（会话 id 让 host 能拉取会话背景）。 */
  function buildPayload(text, context, label, refresh, stage) {
    return {
      text: text,
      context: context,
      label: label,
      title: document.title,
      url: location.href,
      sessionId: panelOrCurrentSessionId(),
      kind: selectionKind(text, label),
      stage: stage === 'detail' ? 'detail' : 'translation',
      ...(refresh ? { refresh: true } : {}),
      // 模型对三个阶段一致；此处不携带追问思考档位。
      ...(env.state.modelChoice ? { provider: env.state.modelChoice.provider, model: env.state.modelChoice.model } : {}),
    }
  }

  /**
   * 点完「✦ 解读」就把**本文档**那次选区收掉。
   *
   * 为什么必须收：小窗一开，浮标就切成「❝ 引用」，而引用浮标是按"有没有活选区"判定的 ——
   * 留着解读用的那次选区，用户在小窗里敲字、按一下方向键（keyup 会触发一次检查），
   * 就会在小窗上方又冒出一个「❝ 引用」，指的是他刚才解读的那段文字，莫名其妙。
   *
   * 为什么能安全收掉：解读要的东西**在 mouseup 那一刻就都抓好了** ——
   * `state.selection` 里存的是文字副本 + **克隆的 Range**，上下文也是从克隆 Range 采的
   * （checkSelection → openForSelection），之后的请求、缓存 key、展开详解、历史回放、
   * 升格都不再读活选区。唯一的代价是那行字的高亮没了 —— 而小窗顶部本来就写着选中文字。
   *
   * 顺序要紧：必须在 openForSelection **采完上下文之后**调用 —— 万一环境没有 cloneRange，
   * 那边会退回读活选区（老浏览器），先清就采不到了。
   */
  function clearDocSelection() {
    try {
      var selection = window.getSelection && window.getSelection()
      if (selection && typeof selection.removeAllRanges === 'function' && selection.rangeCount > 0) {
        selection.removeAllRanges()
      }
    } catch (error) {
      /* 桩环境/老浏览器没有 removeAllRanges：留着就留着，不影响主流程 */
    }
  }

  function openForSelection(selection) {
    // 侧边栏网页里的选区：父页面读不到那个文档，上下文只能由帧内桥就地采好带过来
    if (selection.source === 'iframe') {
      openPanelWith(selection.text, selection.context || '', selection.label, selection.rect, selection.keyContext)
      // 帧内那条高亮清不掉（不透明源，父页面碰不到它的选区）——只能让浮标自己收着；
      // 好在帧内的桥按指纹去重，同一条选区不会反复上报。
      return
    }
    var contextInfo = collectContext(selection.range ? rangeSelection(selection.range) : window.getSelection())
    openPanelWith(selection.text, contextInfo.context, contextInfo.label, selection.rect, contextInfo.keyContext)
    clearDocSelection()
    // 选区连同它的记录一起作废：之后要引用就重新划一段（那会走 checkQuoteSelection）
    env.state.selection = null
  }

  /**
   * 打开面板的公共路径：真实选区与自检钩子**共用**这一条，
   * 否则钩子会绕过缓存（缓存行为只能靠人工点选才能验证）。
   */
  function openPanelWithInner(text, context, label, anchor, keyContext, options) {
    // 这段对话有没有解读：「从语音卡直接进追问」那条路没有（paint() 靠它决定不画翻译节、
    // 并让追问输入框直接可见）。它不是"只在这一次开窗时有效"的临时标记 ——
    // 历史回放 / 本地缓存命中会按条目里存的 skipped 复原它（见 history.js 的
    // applyHistoryEntry 与 saveHistory），所以同一个词下次再开也还是"没有解读"的样子。
    env.state.skipInterpretation = !!(options && options.askFirst)
    // 记下"这次划词发生在哪个会话"——小窗后续所有按会话解析的东西都用它
    env.panelSessionId = currentSessionId()
    env.state.payload = buildPayload(text, context, label)
    env.state.kind = env.state.payload.kind
    env.hideButton()
    showPanel(anchor)
    env.quote.textContent = text.length > 240 ? text.slice(0, 240) + ' …' : text
    applySectionTitle(env.state.kind, text)
    // key 用稳定上下文（选中文字**之前**那段）；真正喂模型时仍然用完整上下文
    var cacheKey = cacheKeyOf(text, keyContext === undefined ? context : keyContext)
    var cached = env.cache.get(cacheKey)
    env.state.cacheKey = cacheKey
    env.state.turns = []
    // 换了一段选中文字 = 换了一次对话：上一段攒的引用**和检索结果**都不该跟过来。
    //
    // ⚠️ toolDigest 原来漏在这一步（属遗漏，不是有意保留）。它的语义单位就是"一次对话"：
    // 按历史条目落盘、按条目恢复，宿主发给模型的措辞也是「本会话已经查到的结果」。
    // 但 state 是整页只建一次的，而它**只在历史回放时被恢复、别处从不复位** ——
    // 于是只要某段对话搜过东西（比如问过一次新闻），之后**每一段新选区**的追问
    // 都会把那段结果一并带给模型（用户实测："每次后面都带着我之前搜的新闻"）。
    //
    // 只清 digest、不动 tools/thought：那几个在请求开始处另有一份复位，
    // digest 则该在这里（以及历史回放）动。
    env.state.toolDigest = ''
    env.clearQuotes()
    // 附件同理：它属于"上一次那段文字的追问"。换选区还留着，就会把上一段的截图
    // 带进一段毫不相干的追问里（而且用户多半已经忘了它还挂在输入框上面）。
    env.clearAttachments()
    env.state.parts = (cached && cached.parts) || { translation: '', detail: '' }
    env.state.stage = ''
    env.state.raw = ''
    // 语音卡那条路（options.askFirst）：**不请求 /analyze**，直接把说的话当第一条追问发出去。
    // 面板停在"追问"阶段、翻译与详解两节是空的 —— 这正是"跳过解读"的字面意思。
    // 缓存与历史回放一律不参与：用户要的是"现在这句"，不是"这段文字上次的解读"。
    if (options && options.askFirst) {
      env.state.parts = { translation: '', detail: '' }
      env.state.phase = 'done'
      env.state.chars = 0
      env.state.error = ''
      env.state.fromCache = false
      env.state.sharedCache = false
      env.state.elapsed = 0
      env.state.toolBusy = false
      env.state.cacheState = ''
      env.renderTurns()
      paint()
      env.sendAsk(options.askFirst)
      return
    }
    env.renderTurns()
    if (cached) {
      // 缓存条目只可能来自**跑过解读**的那一轮（succeed() 里才写缓存）→ 这段对话有解读，
      // 别把上一段"跳过解读"的对话留下的标记带过来（那会把这次的翻译节整节藏掉）。
      env.state.skipInterpretation = false
      env.state.turns = (cached.turns || []).slice()
      env.state.phase = 'done'
      env.state.stage = ''
      env.state.chars = (env.state.parts.translation || '').length + (env.state.parts.detail || '').length
      env.state.error = ''
      env.state.sharedCache = false
      env.state.fromCache = true
      env.state.sameTextHint = false
      env.state.elapsed = 0
      env.state.toolBusy = false
      env.state.cacheState = 'local'
      paint()
      env.renderTurns()
      return
    }
    // 未命中：如果缓存里躺过"同一个词"，多半是上下文不同——说清楚，别让人以为缓存坏了
    env.state.sameTextHint = hasSameTextElsewhere(text)
    // 先问 host 有没有这段对话的历史：命中就直接回放，不调模型；没有才发请求
    env.state.phase = 'loading'
    env.state.startedAt = Date.now()
    paint()
    env.restoreFromHistory(cacheKey, function () {
      env.runRequest(env.state.payload, cacheKey)
    })
  }

  /**
   * 开窗（带"卡片 → 小窗"的交接动画）。
   *
   * 为什么动画放在**内容画完之后**、而不是 showPanel 里面：showPanel 那一刻面板还挂着
   * 上一轮的 DOM（新内容要到后面的 renderTurns / paint 才换上去），在那里量高度量到的是旧的 ——
   * 实测起点 scaleY 用的是上一轮的 398px 高度，而这一轮内容是 354px。
   * 起点本来就要把面板压到卡片那一格（视觉上一样），但拿旧高度算缩放会让中段多一折。
   *
   * 只有"从语音卡发送"那条路会留下起点（vcardHandoff）；其余开窗路径这里是 null，
   * 行为与以前完全一致（瞬开）。
   */
  function openPanelWith(text, context, label, anchor, keyContext, options) {
    openPanelWithInner(text, context, label, anchor, keyContext, options)
    var handoff = env.vcardHandoff
    env.vcardHandoff = null
    growPanelFromCard(handoff)
  }

  /** 由 Range 还原一个 selection 形状的对象（collectContext 只用到这两个方法）。 */
  function rangeSelection(range) {
    return {
      rangeCount: 1,
      getRangeAt: function () {
        return range
      },
      toString: function () {
        return range.toString()
      },
    }
  }

  /**
   * 小窗的尺寸（用户拖角改过之后才有值；null = 用 CSS 里的默认尺寸）。
   *
   * **只记尺寸，不记位置**：小窗每次开窗都必须按选区重新锚定（见 showPanel），
   * 这是既有的设计 —— 位置一旦被记住，开窗就不再跟着划词的地方走，等于把那套锚定架空了。
   * 尺寸是用户明确调过的东西，跨开窗保留才合理。
   */
  var panelSize = null

  var panelSizeAsked = false

  var panelSizeTimer = 0

  /** 正在拖手柄 / 拖标题栏时，别让 window resize 的夹取插一脚。 */
  var panelInteracting = false

  /**
   * 尺寸下限：比"设置页要放得下"低一点就行。真实约束在 CSS/JS 里：
   * 太窄了模型下拉和提示文案会挤成一团，太矮了正文没得看。
   */
  var PANEL_MIN_W = 320

  var PANEL_MIN_H = 240

  /**
   * 开窗时应用"记住的尺寸"。
   *
   * ⚠️ 宽度是**固定值**，高度只能是**上限**（max-height）。
   *
   * 高度要是写成固定值，新开一个会话（内容只有一小段翻译）时面板会硬撑到上次那么大，
   * 下面留一大片空白 —— 那是回退。以前高度一直是内容撑的（`max-height` 只是个天花板），
   * 这个手感必须保住：内容短就短，内容长才长到上限、再滚动。
   *
   * 所以每次开窗都把 `height` **清掉**（回到自适应），只把用户调过的高度当作新的天花板。
   * 用户当场拖出来的尺寸在**本次**打开里照旧生效（拖动时直接写 inline height），
   * 只是下次开窗会重新按内容自适应 —— 既没有空白，拖动也看得见反馈。
   */
  function applyPanelSizeOnOpen() {
    // 先还原成"内容撑高 + CSS 默认天花板"
    env.panel.style.height = ''
    env.panel.style.maxHeight = ''
    if (!panelSize) {
      env.panel.style.width = ''
      env.panel.removeAttribute('data-resized')
      return
    }
    env.panel.style.width = Math.round(panelSize.w) + 'px'
    env.panel.style.maxHeight = Math.round(panelSize.h) + 'px'
    // 打过标记：设置页那条约 560 的 min-height 就别再插手了（用户已经自己定了高）
    env.panel.setAttribute('data-resized', '1')
  }

  /**
   * 面板的**布局**矩形（不受"卡片 → 小窗"交接动画的 transform 影响）。
   *
   * 为什么需要它：交接那 260ms 里面板带着 `translate+scale`，这时 `getBoundingClientRect()`
   * 给的是**缩放后**的框 —— 谁在这段时间里量它（拖拽、夹进视口、历史列表定位、测试钩子），
   * 拿到的都是错的（比如把面板拖到卡片那个小格子的位置上去）。
   * `offsetLeft/Top/Width/Height` 是布局值，不受 transform 影响；面板是 position:fixed，
   * 所以它们本来就是视口坐标，与 getBoundingClientRect 同源。
   */
  function panelLayoutRect() {
    var width = env.panel.offsetWidth
    var height = env.panel.offsetHeight
    var left = env.panel.offsetLeft
    var top = env.panel.offsetTop
    // 拿不到布局值时（单测的桩 DOM、面板隐藏着量到 0×0）退回渲染矩形：
    // 那两种情况下也不可能有交接动画，退回是安全的，而且与改动前的行为一致。
    if (!isFinite(width) || !isFinite(height) || !isFinite(left) || !isFinite(top) || (width === 0 && height === 0)) {
      var rect = env.panel.getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
    }
    return { left: left, top: top, width: width, height: height, right: left + width, bottom: top + height }
  }

  /** 当前尺寸（读实际渲染值，比拿变量算更稳 —— 拖拽过程中变量会漂）。 */
  function currentPanelSize() {
    return { w: env.panel.offsetWidth, h: env.panel.offsetHeight }
  }

  /** 夹进视口：改大小/窗口变化后都调，保证手柄还在屏幕里、小窗不会超出可视区。 */
  function clampPanelSize(size) {
    var maxW = Math.max(PANEL_MIN_W, window.innerWidth - 8)
    var maxH = Math.max(PANEL_MIN_H, window.innerHeight - 8)
    return {
      w: Math.min(maxW, Math.max(PANEL_MIN_W, size.w)),
      h: Math.min(maxH, Math.max(PANEL_MIN_H, size.h)),
    }
  }

  /**
   * 把面板夹回可视区。
   *
   * **每次尺寸变化之后都要调**：位置是当初按旧尺寸算好的，尺寸一变就可能把面板顶出屏幕。
   * 用户报的就是这个 —— 小窗贴着屏幕边缘时双击角标恢复默认尺寸，一部分直接跑到屏幕外。
   * 优先保住左上角（那是用户看到的锚点），右边/下边放不下才往回收。
   */
  function clampPanelPosition() {
    var rect = panelLayoutRect()
    var maxLeft = Math.max(4, window.innerWidth - rect.width - 4)
    var maxTop = Math.max(4, window.innerHeight - rect.height - 4)
    env.panel.style.left = Math.round(Math.min(Math.max(rect.left, 4), maxLeft)) + 'px'
    env.panel.style.top = Math.round(Math.min(Math.max(rect.top, 4), maxTop)) + 'px'
    if (env.historyList.style.display === 'flex') env.placeHistoryList()
  }

  /** 存到 host（防抖：拖动过程中每帧都存会把接口打爆）。 */
  function savePanelSize() {
    if (panelSizeTimer) clearTimeout(panelSizeTimer)
    panelSizeTimer = setTimeout(function () {
      panelSizeTimer = 0
      var size = clampPanelSize(currentPanelSize())
      panelSize = size
      fetch(PANEL_SIZE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ size: size }),
      }).catch(function () { /* 存不上不影响使用，下次再改还会存 */ })
    }, 300)
  }

  /** 挂载时问一次（异步，回来再摆；用户已经动过就以用户的为准）。 */
  function loadPanelSize() {
    if (panelSizeAsked) return
    panelSizeAsked = true
    fetch(PANEL_SIZE)
      .then(function (res) { return res.json() })
      .then(function (data) {
        var size = data && data.size
        if (!size || panelInteracting) return
        if (typeof size.w !== 'number' || typeof size.h !== 'number') return
        panelSize = clampPanelSize(size)
        if (env.panelOpen) {
          applyPanelSizeOnOpen()
          clampPanelPosition()
        }
      })
      .catch(function () {})
  }

  /**
   * 恢复默认尺寸（双击右下角）。
   *
   * 和"高度自适应"是**同一个动作**：把整份存档清掉 ——
   * 宽度回到 CSS 默认（540 / 首轮阶段 440），高度清成 auto 由内容撑（也就是自适应）。
   *
   * ⚠️ 必须走 applyPanelSizeOnOpen() 来清，而不是手写两行 `style.width = ''`：
   * 高度上限是写在 `style.maxHeight` 上的，只清 width/height 会把它留下 ——
   * 用户先前把窗口**拉小**过的话，双击之后高度仍被旧上限卡着，看着就不像"恢复默认"。
   */
  function resetPanelSize() {
    panelSize = null
    // ⚠️ 先掐掉还没落盘的那次保存。
    // savePanelSize 是防抖的，而且**在定时器触发时**才去读当前尺寸 ——
    // 刚拖完角标马上双击还原时，这一次来不及取消的保存会在 300ms 后读到
    // "已经还原好的默认尺寸"，又把它当成"用户选的尺寸"写回去：
    // 还原被无声撤销，宽度还被钉死在那一刻（连带把按阶段收窄那套也废掉）。
    if (panelSizeTimer) {
      clearTimeout(panelSizeTimer)
      panelSizeTimer = 0
    }
    applyPanelSizeOnOpen() // 宽度 / 高度 / 高度上限 一次全还原
    fetch(PANEL_SIZE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    }).catch(function () {})
    // 宽度/高度都变了 → 位置得重夹，否则贴着屏幕边缘时会被顶出去
    clampPanelPosition()
    env.autoGrowAskBox()
  }

  /**
   * 拖手柄改大小。
   *
   * edge 决定这次动哪几个方向：'se' 角标两个方向都能动，'e' 只动宽，'s' 只动高。
   * 用 pointer 事件（不是 mouse）：触控板/触屏一样能拖，而且能 setPointerCapture，
   * 鼠标划出窗口也不会丢掉这一轮（mouse 版本会卡在中途）。
   */
  function bindResizeGrip(node, edge) {
    listen(node, 'pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      var startSize = currentPanelSize()
      var startX = event.clientX
      var startY = event.clientY
      panelInteracting = true
      var layer = env.panel.parentNode
      if (layer) layer.setAttribute('data-resizing', '1')
      try { node.setPointerCapture(event.pointerId) } catch (error) { /* 老浏览器没有就算了 */ }
      var changed = 0
      var move = function (moveEvent) {
        var next = { w: startSize.w, h: startSize.h }
        if (edge.indexOf('e') >= 0) next.w = startSize.w + (moveEvent.clientX - startX)
        if (edge.indexOf('s') >= 0) next.h = startSize.h + (moveEvent.clientY - startY)
        var clamped = clampPanelSize(next)
        changed = Math.abs(clamped.w - startSize.w) + Math.abs(clamped.h - startSize.h)
        env.panel.style.width = Math.round(clamped.w) + 'px'
        env.panel.style.height = Math.round(clamped.h) + 'px'
        // ⚠️ **必须同步抬高 max-height**。
        // 开窗时 applyPanelSizeOnOpen() 会把"上次记住的高度"写成 max-height 当天花板；
        // 拖拽如果只写 height，写大的部分会被那条旧天花板直接截掉 ——
        // 用户实测就是"拖拽的上限不是视口高度减 8，而是上次关闭小窗之前的高度"。
        // （反过来拖小没问题：height 小于旧天花板，看不出来。）
        env.panel.style.maxHeight = Math.round(clamped.h) + 'px'
        panelSize = clamped
        env.panel.setAttribute('data-resized', '1')
        if (env.historyList.style.display === 'flex') env.placeHistoryList()
      }
      var up = function () {
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', up, true)
        panelInteracting = false
        if (layer) layer.removeAttribute('data-resizing')
        // 尺寸定下来后，正文/输入框要按新高度重新分配（composer 自动撑高那套）
        env.autoGrowAskBox()
        // 尺寸变了 → 位置重夹，别让面板被顶出屏幕
        if (changed >= 2) {
          clampPanelPosition()
          savePanelSize()
        }
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', up, true)
    })
    // 双击角标 = 恢复默认大小
    if (edge === 'se') {
      listen(node, 'dblclick', function (event) {
        event.preventDefault()
        event.stopPropagation()
        resetPanelSize()
      })
    }
  }

  function showPanel(anchor) {
    env.panelOpen = true
    // 键盘用户开窗即可打字：这一轮的输入框一旦可见就聚焦一次（见 focusComposerOnce）
    env.askFocusPending = true
    // 小窗一开，浮标就换成「❝ 引用」那一套（解读浮标收掉，引用浮标等新选区）
    env.hideButton()
    env.hideQuoteButton()
    env.state.quoteSelection = null
    env.panel.style.display = 'flex'
    env.panel.style.left = '0px'
    env.panel.style.top = '0px'
    // 每次都按选区重新锚定 —— **不要**在这里插"用上次的位置"的分支：
    // 位置一旦被记住，开窗就不再跟着划词的地方走，这套锚定逻辑等于被架空。
    // 尺寸是另一回事：宽度沿用用户调过的，高度**每次开窗都回到自适应**（只保留天花板），
    // 否则新会话内容短、面板却硬撑成上次那么高，下面留一大片空白。
    applyPanelSizeOnOpen()
    // 面板刚显示出来才量得到 scrollHeight：草稿里原来的几行要立刻撑开
    env.autoGrowAskBox()
    var width = env.panel.offsetWidth
    var height = env.panel.offsetHeight
    var left = anchor ? anchor.left : window.innerWidth / 2 - width / 2
    var top = anchor ? anchor.bottom + 10 : 80
    if (left + width > window.innerWidth - 10) left = window.innerWidth - width - 10
    if (top + height > window.innerHeight - 10) {
      top = anchor ? anchor.top - height - 10 : Math.max(10, window.innerHeight - height - 10)
    }
    env.panel.style.left = Math.round(Math.max(10, left)) + 'px'
    env.panel.style.top = Math.round(Math.max(10, top)) + 'px'
    env.paintPill()
    // 跟随态下输入框那枚胶囊报的是"本会话在用的模型"：开窗先对齐一次，
    // 之后交给 2 秒的轮询（主会话里换了模型，这里自己就跟着变，不用等开一次设置页）。
    env.refreshFollowRoute()
    env.syncRouteWatch()
    // 胶囊上的模型名要按 provider + model 从清单里换（否则显示裸 id），顺手拉一次清单
    env.warmModelCatalog()
  }

  /**
   * 让小窗"从卡片那一格长出来"（260ms，只动 transform）。
   *
   * 起手把面板用 transform 压到卡片矩形上（`translate(dx,dy) scale(sx,sy)`，原点取左上角），
   * 再回到 `transform:none` —— 于是"卡片 → 小窗"是一段连续的量变，而不是两次 display 切换。
   *
   * 几个必须这么写的点：
   *   · 量 `to` 之前先**清掉残留的 transform**：否则量到的是上一次动画的半截几何；
   *   · 先 `transition:none` 摆好起点、强制重排，再开过渡 —— 否则浏览器会把"设起点"和
   *     "设终点"合并成一次样式变更，动画根本不播（插件在 openVCard 里踩过同一个坑）；
   *   · 收尾必须把内联的 `transform/transition/transformOrigin` 清干净 —— 面板之后还要被
   *     拖拽改大小、还要开设置抽屉（抽屉是 inset:0 贴在面板上的），留着 transform 会连累它们；
   *   · 系统要求减少动效时**不做**（与 playCrtOff 同一条规矩）。
   */
  function growPanelFromCard(from) {
    if (!from || !env.panel || !from.width || !from.height) return
    if (env.prefersReducedMotion()) return
    env.panel.style.transition = 'none'
    env.panel.style.transform = ''
    env.panel.style.transformOrigin = ''
    var to = env.panel.getBoundingClientRect()
    if (!to.width || !to.height) return
    var sx = from.width / to.width
    var sy = from.height / to.height
    var dx = from.left - to.left
    var dy = from.top - to.top
    // 卡片正好在面板位置上（差不到 1px）就没必要做 —— 那是"没动"，别白播一段
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(1 - sx) < 0.02 && Math.abs(1 - sy) < 0.02) return
    env.panel.style.transformOrigin = '0 0'
    env.panel.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')'
    void env.panel.offsetWidth
    env.panel.style.transition = 'transform ' + PANEL_GROW_MS + 'ms ' + PANEL_GROW_EASE
    env.panel.style.transform = 'none'
    if (env.panelGrowTimer) {
      clearTimeout(env.panelGrowTimer)
      env.panelGrowTimer = null
    }
    var settle = function () {
      if (env.panelGrowTimer) {
        clearTimeout(env.panelGrowTimer)
        env.panelGrowTimer = null
      }
      if (env.panelGrowHandler) {
        env.panel.removeEventListener('transitionend', env.panelGrowHandler)
        env.panelGrowHandler = null
      }
      env.panel.style.transition = ''
      env.panel.style.transform = ''
      env.panel.style.transformOrigin = ''
    }
    env.panelGrowHandler = function (event) {
      if (event.target === env.panel && event.propertyName === 'transform') settle()
    }
    env.panel.addEventListener('transitionend', env.panelGrowHandler)
    // transitionend 是主路径；标签页在后台时动画不跑、事件也就不会来，所以另挂兜底
    env.panelGrowTimer = env.later(settle, PANEL_GROW_MS + 140)
  }

  function closePanel() {
    env.closeModelMenu()
    // 小窗关掉时设置抽屉也一起收：否则下次开窗会直接停在设置页上
    // （用户上次是在关窗前改的设置，回来想看的是解读，不是设置）。
    // closeSettings 顺手把还没落盘的改动补发掉，不会"关掉就走"丢改动。
    env.closeSettings()
    env.panelOpen = false
    env.panel.style.display = 'none'
    // 交接动画还没跑完就被关掉：连同它的定时器一起收干净，别把半截 transform 留在面板上
    // （下次开窗量几何会量到它，拖拽改大小也会被它带偏）
    if (env.panelGrowTimer) {
      clearTimeout(env.panelGrowTimer)
      env.panelGrowTimer = null
    }
    if (env.panelGrowHandler) {
      env.panel.removeEventListener('transitionend', env.panelGrowHandler)
      env.panelGrowHandler = null
    }
    env.panel.style.transition = ''
    env.panel.style.transform = ''
    env.panel.style.transformOrigin = ''
    env.vcardHandoff = null
    env.hideHistoryList()
    // 小窗收起来了：引用浮标跟着走（它只在"小窗开着"时有意义）
    env.hideQuoteButton()
    env.state.quoteSelection = null
    // 正在录音/识别就到此为止：麦**一定要松开**（不能让标签页一直显示"正在使用麦克风"），
    // 识别出来的文字也没地方放了 —— 连同提示一起静默收掉。
    env.cancelVoice()
    // 收起小窗不该被记成"失败"：打个标记，让 fail() 走「已停止」而不是「解读失败」
    if (env.state.request) env.state.aborted = true
    if (env.state.request) env.state.request.abort()
    env.state.request = null
    env.paintPill()
    // 小窗收了：抽屉若也关着就把轮询停掉（两处都不需要这个值了）
    env.syncRouteWatch()
  }

  /**
   * 状态提示：**界面上不显示**（页脚那条和后来的浮层都去掉了）。
   * 保留函数是为了语义不丢——最近一条记进 state.lastStatus，自检钩子可读，17 处调用点也不用改。
   */
  function setStatus(text) {
    env.state.lastStatus = String(text || '')
  }

  /**
   * 面板用"宽版"还是"窄版"：详解已出、或已有对话（含正在追问）时宽版。
   *
   * 单独抽出来是因为追问路径（ask 开始 / finish）不经过 paint()，
   * 不在这里同步的话"翻译出完直接追问"会一直卡在窄面板里，消息区挤成一列。
   */
  /**
   * 「展开详解」什么时候露面：翻译刚出完、还没追问过、也还没展开过。
   * 一旦发过追问（有用户轮次）就收起来——已经在对话里了，再摆一个"展开详解"是多余的。
   */
  function syncExpandCta() {
    var hasDetail = !!(env.state.parts.detail || env.state.stage === 'detail')
    var translationReady = env.state.phase === 'done' && !!env.state.parts.translation
    var asked = false
    for (var i = 0; i < env.state.turns.length; i += 1) {
      if (env.state.turns[i].role === 'user') asked = true
    }
    // 语音卡那条路没有解读可展开，别摆一个点了没反应的按钮
    env.expandButton.style.display = !hasDetail && translationReady && !asked && !env.state.skipInterpretation ? '' : 'none'
    env.expandButton.disabled = false
    return asked
  }

  function syncPanelStage() {
    var hasDetail = !!(env.state.parts.detail || env.state.stage === 'detail')
    var wide = hasDetail || env.state.turns.length > 0 || env.state.asking
    env.panel.setAttribute('data-stage', wide ? 'detail' : 'translation')
    return wide
  }

  /**
   * 页脚进度文案：**只有阶段和秒数**，不含任何工具细节。
   * 检索阶段说"正在检索资料"，其余按流式阶段说话——几十秒的检索总得有个交代，
   * 但"查了什么、命中多少、拿了哪些链接"属于模型的原料，不往小窗里发。
   */
  function progressText() {
    var seconds = ((Date.now() - env.state.startedAt) / 1000).toFixed(1)
    var what = env.state.toolBusy ? '正在检索资料…' : env.state.phase === 'loading' ? '正在分析…' : '生成中…'
    return what + ' ' + seconds + 's'
  }

  function paint() {
    var streaming = env.state.phase === 'loading' || env.state.phase === 'streaming'
    var stage = env.state.stage
    var selected = env.state.payload && env.state.payload.text ? env.state.payload.text : env.state.selection ? env.state.selection.text : ''
    var sections = splitSections(env.visibleRaw())
    // 翻译节：首轮流式期间逐字渲染；已有结果就用结果；一个字都还没有时给等待特效
    var live = stripEchoPrefix(stage === 'detail' ? '' : sections.translation || sections.other, selected)
    var liveDetail = (sections.detail || sections.other || '').trim()
    // 这段对话没有解读（语音卡那条"跳过翻译与详解、直接追问"的路）：翻译节整节不画 ——
    // 不是"画个空节、里面写这次没有返回内容"（用户否掉的正是它）。
    // 标记跟着**对话**走（回放时按条目里的 skipped 复原），不是只跟着这一次开窗走：
    // 少了这一层，同一个词再开一次（历史/缓存回放）那张空翻译卡片就又冒出来了（用户实测）。
    //
    // 兜底（2026-10-19 补）：光靠上面的标记不够 —— 老条目磁盘上根本没有 skipped 这个键，
    // 而宿主过去读盘时会把它改写成 false，客户端永远看不到"缺失"。所以这里再按**内容**判一次：
    // 一节正文都没有、却已经有用户追问了 → 这一节没有任何可看的东西，整节不画。
    // 真正"跑了翻译但模型没返回"的对话也会有追问，同样不画 —— 那张卡片本来就只有一句
    // "（这次没有返回内容）"、而且重试按钮在 done 状态会被摘掉，留着只是噪音。
    var askedSoFar = false
    for (var qi = 0; qi < env.state.turns.length; qi += 1) {
      if (env.state.turns[qi].role === 'user') {
        askedSoFar = true
        break
      }
    }
    var emptyInterpretation = !env.state.parts.translation && !env.state.parts.detail && !live.trim()
    env.translationSection.root.style.display = env.state.skipInterpretation || (emptyInterpretation && askedSoFar) ? 'none' : ''
    if (env.state.parts.translation) {
      renderRich(env.translationSection.content, stripEchoPrefix(env.state.parts.translation, selected), { callout: true, settled: true })
    } else if (stage !== 'detail' && live.trim()) {
      renderRich(env.translationSection.content, live, { callout: true, settled: env.state.phase === 'done' })
    } else if (stage !== 'detail' && streaming) {
      // 首轮：请求刚发出到第一个字之间（含模型思考期，可能好几秒）必须有动静
      env.showWaiting(env.translationSection.content, '正在翻译…', {
        startedAt: env.state.startedAt,
        effort: env.state.effort,
        // 创建时 start 事件还没到，state.effort 是空的；用函数实时读，档位才不会显示成兜底值
        effortOf: function () { return env.state.stageEffort || 'low' },
        thoughtOf: function () { return env.state.thought },
        noticeOf: function () { return env.state.notice },
      })
    } else if (env.state.phase === 'error') {
      env.translationSection.content.textContent = ''
    } else if (env.state.phase === 'done') {
      // 流结束了却一个字都没有：别留空白，明确说一声（否则看起来和"还在加载"一样）
      env.translationSection.content.textContent = '（这次没有返回内容）'
      env.translationSection.content.appendChild(env.retryButton)
      env.retryButton.style.display = ''
    }

    // 已停止（收起小窗 / 按了停止）：**不管有没有半截内容**都要交代清楚，并把「重新生成」放到下面
    if (env.state.phase === 'paused') {
      env.translationSection.content.appendChild(
        el('div', 'dsh-sel-note', '（已停止：这一轮被中断了，上面是已经生成的部分）'),
      )
      env.translationSection.content.appendChild(env.retryButton)
      env.retryButton.style.display = ''
    }

    // 详解节：只在第二阶段出现（或已缓存过）
    var wantDetail = !!(env.state.parts.detail || stage === 'detail')
    env.detailSection.root.style.display = wantDetail ? '' : 'none'
    if (env.state.parts.detail) {
      renderRich(env.detailSection.content, env.state.parts.detail, { callout: true, settled: true })
    } else if (stage === 'detail' && liveDetail) {
      renderRich(env.detailSection.content, liveDetail, { callout: true, settled: env.state.phase === 'done' })
    } else if (wantDetail && streaming) {
      env.showWaiting(env.detailSection.content, '正在读完整会话背景…', {
        startedAt: env.state.startedAt,
        effort: env.state.effort,
        effortOf: function () { return env.state.stageEffort || 'high' },
        thoughtOf: function () { return env.state.thought },
        noticeOf: function () { return env.state.notice },
      })
    }

    // —— 按阶段重排 ——
    // 只有翻译时：不显示小节序号（轻量卡片形态）。宽度**不随阶段变**（恒 540）——
    // 以前这里还顺手收窄到 440，追问一下又跳回 540，用户看着像窗口自己抖了一下。
    var hasDetail = !!(env.state.parts.detail || stage === 'detail')
    // 追问输入框：**翻译一出来就能问，不必先展开详解**
    var translationReady = env.state.phase === 'done' && !!env.state.parts.translation
    var wide = syncPanelStage()
    // 配色按**面板实际底色**选（不看系统偏好）：主题实现方式怎么变都不影响
    var surfaceTheme = env.currentSurfaceTheme()
    env.layer.setAttribute('data-theme', surfaceTheme)
    env.panel.setAttribute('data-theme', surfaceTheme)
    env.askRow.style.display = wide || translationReady || env.state.skipInterpretation || env.state.quotes.length > 0 ? '' : 'none'
    // 展开 CTA：翻译还在跑（含思考期）时先不出现——那时候该看的是等待特效，
    // 摆在下面只会是个灰着的按钮，反而像"没反应"；发过追问之后也收起（见 syncExpandCta）。
    syncExpandCta()
    env.closeButton.title = '关闭（Esc）'
    // 「重新生成」是内容区里的临时按钮：正常路径上先收回，避免被上一次追加后留在正文里
    if (env.state.phase !== 'error' && env.state.phase !== 'paused' && env.retryButton.parentNode) {
      env.retryButton.parentNode.removeChild(env.retryButton)
    }
    if (env.state.phase === 'loading' || env.state.phase === 'streaming') {
      setStatus(progressText())
      env.retryButton.style.display = 'none'
    } else if (env.state.phase === 'paused') {
      setStatus('已停止（收起小窗时中止）')
      env.retryButton.style.display = ''
    } else if (env.state.phase === 'error') {
      setStatus('')
      env.translationSection.content.textContent = ''
      env.detailSection.content.textContent = ''
      var err = el('div', 'dsh-sel-err', '解读失败：' + env.state.error)
      env.translationSection.content.appendChild(err)
      env.translationSection.content.appendChild(env.retryButton)
      env.detailSection.root.style.display = 'none'
      env.retryButton.style.display = ''
    } else if (env.state.phase === 'done') {
      setStatus(
        '完成 · 耗时 ' +
          formatDuration(env.state.elapsed) +
          ' · ' +
          env.state.chars +
          ' 字' +
          (env.state.fromHistory
            ? ' · 历史回放（上次的对话）'
            : env.state.fromCache
              ? ' · 本地缓存（未重新请求）'
              : env.state.sharedCache
                ? ' · 结果缓存（host 回放）'
                : env.state.sameTextHint
                  ? ' · 同词但上下文不同，重新生成'
                  : ''),
      )
      env.retryButton.style.display = ''
    }
    env.renderTurns()
    // 首轮解读还在流式时不让追问（历史里还没有完整结论）
    env.refreshAskState()
    env.paintPill()
    keepInsideViewport()
    focusComposerOnce()
  }

  /**
   * 开窗后**只聚焦一次**输入框（键盘用户不用先 Tab 两下）。
   *
   * 三个克制的地方：
   *   · 等输入框真的可见才聚焦（首轮翻译还在跑时它是藏着的，聚焦藏着的元素没意义）；
   *   · 用户已经在别处打字（主会话输入框、侧边栏…）就**不抢**焦点，并就此作罢；
   *   · preventScroll：别因为聚焦把页面滚一下（划完词页面跳走最难受）。
   */
  function focusComposerOnce() {
    env.focusBail = 'pending=' + String(env.askFocusPending) + ' panel=' + String(env.panelOpen)
    if (!env.askFocusPending || !env.panelOpen) return
    env.focusBail = 'composerVisible=' + String(composerVisible()) + ' panelSel=' + String(hasPanelSelection())
    if (!composerVisible()) return
    // 小窗里正有一段选中文字（用户正在划词、准备点「❝ 引用」）：**这一下聚焦会把选区清掉**。
    // 让位给用户，并且不再补焦 —— 引用浮标是这个功能的主入口，不能因为抢焦点而让它消失。
    //（实测：开窗后那一帧恰好落在"首轮刚出完"的自动聚焦上，划好的词会瞬间没了。）
    if (hasPanelSelection()) {
      env.focusBail = '让位给小窗里的选区'
      env.askFocusPending = false
      return
    }
    var active = document.activeElement
    var inside = active && (active === env.panel || active === env.askBox || (env.panel.contains && env.panel.contains(active)))
            env.focusBail = 'active=' + String((active && active.className) || active) + ' typing=' + String(isTypingTarget(active))
    // 只有"人家正在别处打字"才值得让路。
    // 注意别把普通的按钮焦点也算进去：点浮标时焦点正好落在浮标那个 <button> 上
    //（Chrome 点按钮会给它焦点），照"非 body 就不抢"的老写法会把我们自己挡在门外 ——
    // 这正是"开窗后没有自动聚焦"的原因。
    if (!inside && isTypingTarget(active)) {
      env.focusBail = '让位给别处正在打字（' + String((active && active.tagName) || active) + '.' + String((active && active.className) || '')
        + ' 链=' + (function(){ var n=/** @type {HTMLElement | null} */ (active), out=[]; while(n && out.length<5){ out.push(String(n.className||n.tagName)+':'+String((n.style&&n.style.display)||'')); n=n.parentElement } return out.join('>') })() + '）'
      env.askFocusPending = false // 人家真的在别处打字，这次开窗就不再抢
      return
    }
    env.askFocusPending = false
    env.focusBail = 'ok'
    focusAskBox()
  }

  /** 小窗正文里这会儿有没有一段活选区（划词中/选好了还没点引用）。 */
  function hasPanelSelection() {
    try {
      var selection = window.getSelection && window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false
      var range = selection.getRangeAt(0)
      return env.insidePanelContent(range.startContainer) || env.insidePanelContent(range.endContainer)
    } catch (error) {
      return false
    }
  }

  /** 正在打字的地方（input / textarea / 可编辑区）—— 只有这种焦点值得让路。 */
  function isTypingTarget(node) {
    if (!node || node === env.askBox) return false
    var tag = String(node.tagName || '').toLowerCase()
    var editable = tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true
    if (!editable) return false
    // 已经隐藏起来的输入框不算"人家正在打字"：它既收不到键盘，也不该挡住我们聚焦。
    // 典型场景就是临时语音卡收起后焦点还挂在它的 textarea 上（display:none 的元素
    // 在部分浏览器里仍然是 activeElement）。
    if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) return false
    return true
  }

  /**
   * 小窗自己的规则：**一轮输出结束（成功或失败）后，把光标交回输入框**。
   *
   * 为什么是规则而不是某个入口的特例：不管是划词解读、语音卡直接追问、还是打开历史，
   * 用户看完一轮结果之后，下一步十有八九是接着追问 —— 光标本来就该在那儿。
   *
   * 与"开窗时聚焦一次"（focusComposerOnce 的首次调用）的区别：
   * 那次可能因为"人家正在别处打字"而作废并就此作罢；这次是每轮结束都重新申请，
   * 仍然尊重同一条礼貌规则（不抢正在别处打字的人的焦点）。
   */
  function askFocusAfterTurn() {
    env.focusBail = 'panelOpen=' + String(env.panelOpen)
    if (!env.panelOpen) return
    env.askFocusPending = true
    focusComposerOnce()
  }

  /**
   * 把光标交给输入框（preventScroll：别因为聚焦把页面滚一下）。
   *
   * 先 blur 再 focus：如果输入法的输入上下文还绑在别处（见 closeVCard 里的注释 ——
   * 典型就是刚收起的临时卡片），单叫 focus() 不足以让它重新绑定到这个输入框；
   * 走一次 blur → focus 才能把输入法重新挂过来。已经是当前焦点时，blur 是无害的。
   */
  function focusAskBox() {
    try {
      env.askBox.blur()
    } catch (error) {
      /* 桩环境 */
    }
    try {
      env.askBox.focus({ preventScroll: true })
    } catch (error) {
      try {
        env.askBox.focus()
      } catch (ignored) {
        /* 桩环境 */
      }
    }
  }

  /** 输入框这会儿真的看得见吗（藏着的元素聚焦没有意义）。 */
  function composerVisible() {
    if (!env.askRow || env.askRow.style.display === 'none') return false
    if (typeof env.askBox.getBoundingClientRect !== 'function') return true
    try {
      var rect = env.askBox.getBoundingClientRect()
      if (rect && rect.width === 0 && rect.height === 0) return false
    } catch (error) {
      /* noop */
    }
    return true
  }

  /** 内容变高后把面板拉回视口内。 */
  function keepInsideViewport() {
    if (!env.panelOpen) return
    var rect = panelLayoutRect()
    var width = Math.min(rect.width, window.innerWidth - 12)
    var left = clamp(rect.left, 6, Math.max(6, window.innerWidth - width - 6))
    var top = clamp(rect.top, 6, Math.max(6, window.innerHeight - 64))
    env.panel.style.left = Math.round(left) + 'px'
    env.panel.style.top = Math.round(top) + 'px'
  }
  return {
    openForSelection,
    currentSessionId,
    loadPanelSize,
    keepInsideViewport,
    closePanel,
    panelLayoutRect,
    get panelInteracting() { return panelInteracting },
    set panelInteracting(value) { panelInteracting = value },
    bindResizeGrip,
    get panelSize() { return panelSize },
    set panelSize(value) { panelSize = value },
    clampPanelSize,
    applyPanelSizeOnOpen,
    clampPanelPosition,
    savePanelSize,
    get panelSizeAsked() { return panelSizeAsked },
    set panelSizeAsked(value) { panelSizeAsked = value },
    openPanelWith,
    paint,
    isTypingTarget,
    rangeSelection,
    clearDocSelection,
    composerVisible,
    focusAskBox,
    setStatus,
    showPanel,
    buildPayload,
    askFocusAfterTurn,
    applySectionTitle,
    progressText,
    syncPanelStage,
    syncExpandCta,
    panelOrCurrentSessionId,
  }
}
