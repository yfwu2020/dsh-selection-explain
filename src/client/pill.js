import { createPillState } from './state.js'
import { PILL_POS, PILL_BALL_SIZE, PILL_FALLBACK_MAX, PILL_STAR_EASE, PILL_STAR_TIP_END, PILL_STAR_BODY_START, PILL_STAR_SAMPLES, PILL_STAR_POP, PILL_STAR_TWIST, PILL_MORPH_MS, createPreferences, PILL_DRAG_SLOP, PILL_SNAP_RADIUS, PILL_SNAP_MS, HISTORY } from './constants.js'
import { clamp } from './dom.js'

/** pill state and operations; dependencies are supplied as live node/callback accessors. */
/** @param {import('./controller-contracts.js').PillEnv} env */
export function createPillController(env) {
  var interaction = env.interaction || createPillState()
  var preferences = env.preferences || createPreferences()

  /** 胶囊左侧那截"最近一次划的是什么"（太长就截断）。 */
  function pillSnippet() {
    // 截图对话：优先用模型起的标题；还没生成时才退回用户问的那句话
    var title = env.state.shotTitle ? String(env.state.shotTitle) : ''
    title = title.replace(/\s+/g, ' ').trim()
    var text = title || (env.state.payload && env.state.payload.text ? String(env.state.payload.text) : '')
    text = text.replace(/\s+/g, ' ').trim()
    if (!text) return ''
    return text.length > 12 ? text.slice(0, 12) + '…' : text
  }

  /** 胶囊状态：进行中报阶段 + 秒数，其余报结果状态。tone 决定圆点颜色。 */
  function pillStatus() {
    if (env.state.asking) {
      var askingFor = env.state.askingStartedAt ? ((Date.now() - env.state.askingStartedAt) / 1000).toFixed(1) + 's' : ''
      return { tone: 'busy', text: '追问中 ' + askingFor }
    }
    if (env.state.phase === 'loading' || env.state.phase === 'streaming') {
      var label = env.state.toolBusy ? '检索中' : env.state.stage === 'detail' ? '详解中' : env.state.chars > 0 ? '生成中' : '翻译中'
      var seconds = env.state.startedAt ? ((Date.now() - env.state.startedAt) / 1000).toFixed(1) + 's' : ''
      return { tone: 'busy', text: label + ' ' + seconds }
    }
    if (env.state.phase === 'error') return { tone: 'error', text: '失败' }
    if (env.state.phase === 'paused') return { tone: 'paused', text: '已停止' }
    if (env.state.phase === 'done') {
      var rounds = 0
      for (var i = 0; i < env.state.turns.length; i += 1) if (env.state.turns[i].role === 'user') rounds += 1
      return { tone: 'done', text: rounds > 0 ? '完成 · ' + rounds + ' 轮' : '完成' }
    }
    return { tone: 'idle', text: '就绪' }
  }

  /** 画胶囊（只在文本真的变了才写 DOM，避免每帧动布局）。 */
  function paintPill() {
    var status = pillStatus()
    var snippet = pillSnippet()
    var name = snippet || '划词解读'
    var meta = '· ' + status.text
    if (env.pillName.textContent !== name) env.pillName.textContent = name
    if (env.pillMeta.textContent !== meta) env.pillMeta.textContent = meta
    if (env.pill.getAttribute('data-tone') !== status.tone) env.pill.setAttribute('data-tone', status.tone)
    env.pill.setAttribute('data-open', env.panelOpen ? '1' : '0')
    // 和费用胶囊一样的小三角：▴ 收起状态可展开，▾ 已展开
    var caret = env.panelOpen ? '▾' : '▴'
    if (env.pillCaret.textContent !== caret) env.pillCaret.textContent = caret
    env.pill.title = [
      snippet ? (env.state.shotTitle ? '最近一次截图：' : '最近一次划词：') + snippet : '还没有划过词',
      status.text,
      env.panelOpen ? '点击收起小窗' : '点击回到这个小窗',
      '可拖动（拖到右下角附近会吸附回去）',
    ].join('｜')
    // 画一次就算一次活动：状态在变（翻译中/生成中/完成）时不该被收成小球，也顺便重置静置计时
    notePillActivity()
  }

  /**
   * 找 dsh-spend 那枚费用胶囊的容器。
   *
   * 真实 DOM（0.19.x 实测）：外层 `<div id="dsh-spend-widget">` **没有 class**，
   * 里面才是带 `.dsu-widget` 的那层（position:fixed 的就是它），胶囊本身是 `.dsu-pill`。
   * 之前只按 class `.dsh-spend-widget` 找——真实页面里**永远找不到**，
   * 于是位置退化成兜底值、宽度也固定不了（表现：胶囊随文字伸缩、和费用胶囊差 2px 没对齐）。
   */
  function spendHost() {
    var outer = null
    try {
      if (typeof document.getElementById === 'function') outer = document.getElementById('dsh-spend-widget')
    } catch (error) {
      /* noop */
    }
    if (!outer) outer = document.querySelector('.dsu-widget') || document.querySelector('.dsh-spend-widget')
    if (!outer) return null
    // 真正定位/定宽的是里层那层；外层只是挂载点
    var inner = outer.querySelector ? outer.querySelector('.dsu-widget') : null
    return inner || outer
  }

  /**
   * 量一次"贴哪儿、多宽"。
   * 那个插件不一定装着、也不一定什么时候出现，所以每次都用实测位置，取不到才用兜底偏移。
   * 返回 { right, bottom, width }：right/bottom 是视口右/下边距；width 是那枚胶囊的实测宽度
   * （0 = 没量到 —— 调用方据此决定"跟随它"还是"走兜底"）。
   */
  function measurePillAnchor() {
    // 兜底位置：**贴页面底部**（和费用胶囊自己的 right:20/bottom:20 同高）。
    // 以前兜底是 64，等于永远给"下面那枚胶囊"留位置——没装那个插件时就悬在半空（实测被吐槽）。
    var right = 20
    var bottom = 20
    var width = 0
    try {
      var host = spendHost()
      interaction.pillHost = host || null
      if (host) {
        var rect = host.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) {
          right = Math.max(8, Math.round(window.innerWidth - rect.right))
          // 纵向按整个容器算：费用面板展开时，胶囊要待在面板**上方**而不是压住它
          bottom = Math.max(8, Math.round(window.innerHeight - rect.top + 10))
        }
        // 宽度只认那枚胶囊本身（容器展开成面板时会变宽，不能跟着走）
        var capsule = host.querySelector('.dsu-pill') || host.firstElementChild
        if (capsule) {
          var capsuleRect = capsule.getBoundingClientRect()
          if (capsuleRect.width > 0) {
            right = Math.max(8, Math.round(window.innerWidth - capsuleRect.right))
            width = Math.round(capsuleRect.width)
          }
        }
      }
    } catch (error) {
      /* noop：量不到就留在兜底位置 */
    }
    return { right: right, bottom: bottom, width: width }
  }

  /* ── 位置记忆（host 存储）：拖到别处就存，吸附回右下角就清，挂载时读回来 ── */

  function savePillPos() {
    if (!interaction.pillFreeRight) return
    fetch(PILL_POS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ right: Math.round(interaction.pillFreeRight.right), y: Math.round(interaction.pillFreeRight.y) }),
    }).catch(function () {})
  }

  function clearPillPos() {
    fetch(PILL_POS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    }).catch(function () {})
  }

  var pillPosAsked = false

  /** 用户自己拖过位置（拖过就不再用 host 上的存档覆盖） */
  var pillUserPlaced = false

  /** 挂载时读回上次拖到的位置：有就切成自由摆放、按右边缘摆回去（host 不可达时静默忽略）。 */
  function loadPillPos() {
    if (pillPosAsked) return
    pillPosAsked = true
    fetch(PILL_POS)
      .then(function (res) {
        return res.json()
      })
      .then(function (data) {
        var pos = data && data.position
        if (!pos || typeof pos.right !== 'number' || typeof pos.y !== 'number') return
        if (pillUserPlaced) return // 用户已经自己拖过了，别用存档覆盖他
        interaction.pillDock = 'free'
        interaction.pillFreeRight = { right: pos.right, y: pos.y }
        applyFreePill()
        clampFreePill()
        placePill()
      })
      .catch(function () {})
  }

  /** 自由摆放：用 CSS right 钉住右边缘，宽度过渡的每一帧都往左长/往左收。 */
  function applyFreePill() {
    if (!interaction.pillFreeRight) return
    var h = env.pill.offsetHeight || 0
    env.pill.style.left = 'auto'
    env.pill.style.right = Math.round(window.innerWidth - interaction.pillFreeRight.right) + 'px'
    env.pill.style.top = Math.round(interaction.pillFreeRight.y - h / 2) + 'px'
    env.pill.style.bottom = 'auto'
  }

  /**
   * 自由摆放时也必须还在视口里（用户拖出去过 / 窗口变小了）。
   * 右边缘为锚：先把右边缘夹进视口，再保证左边缘不出界（展开变宽时右边缘可能被推右一点）。
   * 位置没变就一个像素都不写。
   */
  function clampFreePill() {
    if (!interaction.pillFreeRight) return false
    var w = env.pill.offsetWidth || 0
    var h = env.pill.offsetHeight || 0
    var right = clamp(interaction.pillFreeRight.right, w + 4, Math.max(w + 4, window.innerWidth - 4))
    var top = clamp(interaction.pillFreeRight.y - h / 2, 4, Math.max(4, window.innerHeight - h - 4))
    var y = top + h / 2
    if (Math.abs(right - interaction.pillFreeRight.right) < 0.5 && Math.abs(y - interaction.pillFreeRight.y) < 0.5) return false
    interaction.pillFreeRight = { right: right, y: y }
    applyFreePill()
    return true
  }

  /** 贴角/跟随时那枚胶囊会落在哪（视口坐标）—— 松手时拿它判"要不要吸附回去"。 */
  function pillAnchorRect() {
    var anchor = measurePillAnchor()
    var w = anchor.width > 0 ? anchor.width : env.pill.offsetWidth || 0
    var h = env.pill.offsetHeight || 0
    return {
      left: window.innerWidth - anchor.right - w,
      top: window.innerHeight - anchor.bottom - h,
      width: w,
      height: h,
    }
  }

  /**
   * 把胶囊摆到右下角"费用胶囊"上方。
   *
   * 三种处境：
   *   · anchor（默认）：贴费用胶囊；量不到就贴右下角 20/20，宽度收到 PILL_FALLBACK_MAX；
   *   · free：用户把它拖到别处了 —— 位置归用户（**右边缘**为锚，见 applyFreePill），
   *     这里只保证"别掉出视口"；
   *   · ball：静置太久收成小球 —— 上限收到 PILL_BALL_SIZE（见 collapsePill）。
   * 宽度和上限三种处境都一样算（拖动不该顺手改宽度），只有位置分家。
   */
  function placePill() {
    // 关掉胶囊时不做任何定位工作：它已经 display:none，量位置纯属白费（而且会一直轮询）
    if (interaction.pillHidden) return
    var anchor = measurePillAnchor()
    interaction.pillAnchorWidth = anchor.width
    // 费用胶囊**出现**了：小球没有存在的意义（收球的前提就是"没有可跟随的胶囊"）→ 立刻展开
    if (interaction.pillAnchorWidth > 0 && interaction.pillBall) expandPill()
    // 只在真的变了才写 style（每帧无脑赋值会让浏览器反复标脏样式）
    var changed = false
    function write(prop, value) {
      if (env.pill.style[prop] !== value) {
        env.pill.style[prop] = value
        changed = true
      }
    }
    // 宽度**写死**成费用胶囊的宽度：文字长短不再让它伸缩（长文字自己省略号收尾）
    write('width', anchor.width > 0 ? anchor.width + 'px' : '')
    // 上限分三种情况（前两条是用户定的规则）：
    //   · 收成小球 → 球的尺寸（max-width 参与过渡，收/放才是动画而不是跳变）；
    //   · 量到了费用胶囊 → 清掉内联上限，回到 CSS 那条 280 —— 和它并排时同宽；
    //   · 量不到（没装 dsh-spend / 它的胶囊此刻宽高为 0）→ 收到 PILL_FALLBACK_MAX。
    // 判据是**本次量到的宽度**而不是"有没有找到容器"：容器在但胶囊被折叠/隐藏时同样跟不了，
    // 那种情况也该走兜底。
    write('maxWidth', interaction.pillBall ? PILL_BALL_SIZE + 'px' : anchor.width > 0 ? '' : PILL_FALLBACK_MAX + 'px')
    // min-width 也一起过渡：球是 32×32 的圆，展开时要**平滑回到 0**。
    // 之前它挂在 [data-ball="1"] 上，一摘属性就瞬间失效 → 展开第一帧宽度塌到内容宽（10px）
    // 再长回来，看着就是先抽一下（真时间轴采样到的 0:10）。
    write('minWidth', interaction.pillBall ? PILL_BALL_SIZE + 'px' : '0px')
    if (interaction.pillDock === 'free') {
      // 位置归用户：CSS right 持续钉住右边缘，只保证胶囊还在视口里。
      clampFreePill()
      return changed
    }
    if (Date.now() < interaction.pillSnapUntil) {
      // 吸附那一下的"滑回去"窗口（见 settlePillDrop）：这期间位置仍按 left/top 维持 ——
      // left/top 与 right/bottom 之间**不可插值**（left:124px → auto 会直接瞬移），
      // 所以滑行必须靠 left/top 走完，之后再交还给 right/bottom 那套稳态定位。
      var snapWidth = anchor.width > 0 ? anchor.width : env.pill.offsetWidth || 0
      write('left', Math.round(window.innerWidth - anchor.right - snapWidth) + 'px')
      write('top', Math.round(window.innerHeight - anchor.bottom - (env.pill.offsetHeight || 0)) + 'px')
      write('right', 'auto')
      write('bottom', 'auto')
      return changed
    }
    // 稳态：right/bottom 定位（宽度一变，右边缘仍和费用胶囊对齐）
    write('left', '')
    write('top', '')
    write('right', anchor.right + 'px')
    write('bottom', anchor.bottom + 'px')
    return changed
  }

  /**
   * 静置收球。
   *
   * 规则（用户定的）：**只有量不到费用胶囊时**才收球 —— 有费用胶囊时它是要跟人家并排的，
   * 收成球反而突兀。下面几种情况一律不收：小窗开着、正在翻译/追问、鼠标停在上面、正在拖。
   * 动画靠 max-width 过渡（收球 = 把上限收到 PILL_BALL_SIZE），所以收/放是同一条平滑曲线，
   * 不需要预先量宽度，也不会有跳变。
   */
  function pillCanBall() {
    return (
      interaction.pillAnchorWidth === 0 &&
      !interaction.pillBall &&
      !env.panelOpen &&
      !interaction.pillHover &&
      !interaction.pillDrag &&
      pillStatus().tone !== 'busy'
    )
  }

  /* ── 球心图形的形变：一个纯函数 f(p) + 一条时间对称曲线 ──────────────────
     ⚠️ 这里**不能**用 CSS 的 `transition:d`：两条静态 path 之间 CSS 只能**线性**插值，
        于是中途会经过一个正菱形（谷跟着尖一起动）——正是设计阶段否掉的那版。
        必须在 JS 里按 p 现算路径，才能让"尖先抽出来、身再收进去"这个非线性轨迹成立。
     另：f(p) 只依赖 p，p 又由时间对称曲线给出，所以收/放天然互为倒放（镜像）。 */

  /** 时间对称曲线的 y(x)：和 CSS 的 cubic-bezier 同一套解法（二分 24 次足够）。 */
  function pillStarEase(x) {
    var c = PILL_STAR_EASE
    var cx = 3 * c[0]
    var bx = 3 * (c[2] - c[0]) - cx
    var ax = 1 - cx - bx
    var cy = 3 * c[1]
    var by = 3 * (c[3] - c[1]) - cy
    var ay = 1 - cy - by
    var lo = 0
    var hi = 1
    var t = x
    for (var i = 0; i < 24; i += 1) {
      t = (lo + hi) / 2
      if (((ax * t + bx) * t + cx) * t < x) lo = t
      else hi = t
    }
    t = (lo + hi) / 2
    return ((ay * t + by) * t + cy) * t
  }

  /** smoothstep：两端速度都为 0 —— 段与段交界处不会有速度断点（那正是"生硬"的来源）。 */
  function pillStarSmooth(x) {
    var c = x < 0 ? 0 : x > 1 ? 1 : x
    return c * c * (3 - 2 * c)
  }

  /** 星的多边形顶点（8 个：尖谷交替，与「✦ 解读」那颗星同一条几何）。 */
  function pillStarPolygon() {
    var tip = 6.0 // 墨迹 12.0px：与胶囊里 12px 的文字同高
    var valley = tip * 0.3788
    var pts = []
    for (var k = 0; k < 4; k += 1) {
      pts.push([tip * Math.cos(k * Math.PI / 2), tip * Math.sin(k * Math.PI / 2)])
      pts.push([valley * Math.cos((k * 90 + 45) * Math.PI / 180), valley * Math.sin((k * 90 + 45) * Math.PI / 180)])
    }
    return pts
  }

  /** 从原点沿 angDeg 打射线，和多边形求交 → 该角度的边界半径。 */
  function pillStarBoundaryRadius(poly, angDeg) {
    var a = angDeg * Math.PI / 180
    var dx = Math.cos(a)
    var dy = Math.sin(a)
    var best = Infinity
    for (var i = 0; i < poly.length; i += 1) {
      var p0 = poly[i]
      var p1 = poly[(i + 1) % poly.length]
      var ex = p1[0] - p0[0]
      var ey = p1[1] - p0[1]
      var den = dx * ey - dy * ex
      if (Math.abs(den) < 1e-9) continue
      var t = (p0[0] * ey - p0[1] * ex) / den
      var u = (p0[0] * dy - p0[1] * dx) / den
      if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6 && t < best) best = t
    }
    return best === Infinity ? 4 : best
  }

  var pillStarPoly = pillStarPolygon()

  /**
   * p=0 → 32 个顶点同半径 4（8px 圆点，与正圆最大偏差 0.02px）；
   * p=1 → 32 个顶点正好落在按钮那颗星的边界上（尖与谷仍是精确顶点）。
   * 尖走 p/.62 的 smoothstep、身走 (p-.38)/.62 的 smoothstep —— 两条都两端速度为 0，
   * 于是整个 280ms 里图形一直在动、且没有速度断点（实测：旧版尖在 160ms 速度从 4.98 直接掉到 0）。
   * p 允许略微越界（过冲曲线会给到 -0.03…1.06），半径按同一式子外推 —— 于是"冲出去一点再收回"。
   */
  function pillStarPathAt(p) {
    var pTip = pillStarSmooth(p / PILL_STAR_TIP_END)
    var pBody = pillStarSmooth((p - PILL_STAR_BODY_START) / (1 - PILL_STAR_BODY_START))
    var popEnv = pillStarPopEnvelope(p)
    var out = []
    for (var i = 0; i < PILL_STAR_SAMPLES; i += 1) {
      var ang = i * 360 / PILL_STAR_SAMPLES
      var rStar = pillStarBoundaryRadius(pillStarPoly, ang)
      // 顶点按"要往外长还是要往里收"分流：
      //   目标半径 ≥ 4（尖和紧邻的顶点）跟"尖"的进度 pTip；< 4（往内收的顶点）跟"身"的进度 pBody。
      // 为什么不能按"离尖的角度权重 w"混合（试过）：22.5° 那个顶点目标半径已 < 4（要往里收），却因为
      //   w 不小而跟着尖的进度**提前**内收 → 比谷还深，边上出现一道波浪（缩小尺寸后 22.5° 比 33.75°
      //   还深 0.11px，被冒烟抓到）。分流之后单调性可证：
      //   外扩顶点 r = 4 + (rStar-4)·pTip ≥ 4 ≥ 4 + (rStar-4)·pBody = 内收顶点。
      var prog = rStar >= 4 ? pTip : pBody
      // 过冲只加在"尖"上（外扩顶点）：尖先冲出去一点、谷按部就班收 —— 呼吸感来自这里
      if (rStar >= 4) prog += PILL_STAR_POP * popEnv
      var r = 4 + (rStar - 4) * prog
      var rad = ang * Math.PI / 180
      var x = Math.round(r * Math.cos(rad) * 100) / 100
      var y = Math.round(r * Math.sin(rad) * 100) / 100
      out.push((i ? 'L' : 'M') + x + ' ' + y)
    }
    return out.join('') + 'Z'
  }

  /** 过冲的包络：p≤.55 为 0，p≈.8 到顶，p=1 归零（两端为 0 → 不破坏端点）。 */
  function pillStarPopEnvelope(p) {
    if (p <= 0.55 || p >= 1) return 0
    return Math.sin(Math.PI * (p - 0.55) / 0.45)
  }

  /** 微转：圆点态 -8° → 星芒态 0°。 */
  function pillStarTwistAt(p) {
    return PILL_STAR_TWIST * (1 - p)
  }

  var pillStarP = 0

  var pillStarTargetP = 0

  var pillStarTimer = 0

  var pillStarStarts = 0

  var pillStarLog = ''

  /** 按 p 画一帧（路径 + 微转）。 */
  function paintPillStar(p) {
    pillStarP = p
    env.pillStar.setAttribute('d', pillStarPathAt(p))
    env.pillStar.style.transform = 'rotate(' + (Math.round(pillStarTwistAt(p) * 100) / 100) + 'deg)'
  }

  /**
   * 从当前 p 走到 to（1=收球成星，0=展开回圆点）。
   * 时长与胶囊那条 CSS 过渡一致（PILL_MORPH_MS / PILL_MORPH），两者同拍；
   * 被打断（比如收球途中鼠标移上去）就从当前 p 接着走，不会跳。
   *
   * 为什么用 setTimeout 而不是 requestAnimationFrame：
   *   · 进度是**按时间算的**（Date.now()），不是按帧累加的 —— 所以节奏用什么驱动不影响保真度；
   *   · 冒烟脚本跑在 --virtual-time-budget 下，那个环境**不派发 rAF**（定时器照走），
   *     用 rAF 的话整段动画在测试里根本观察不到（也就会漏掉"中途形状不对"这类 bug）；
   *   · 用 Date.now() 而不是 performance.now()：虚拟时钟下后者是冻住的。
   * 16ms ≈ 60fps，和 rAF 同档；后台标签里被节流也只是直接跳到终值，无副作用。
   */
  function animatePillStar(to) {
    // ① 同目标的重复调用 = 空操作。**不要**重置已经跑了一半的动画 ——
    //    否则"反复收到同一条指令"会让它永远停在半路（实测踩过：序列 10101010、进度卡在 0.158）。
    if (to === pillStarTargetP && (pillStarTimer || pillStarP === to)) return
    if (pillStarTimer) {
      clearTimeout(pillStarTimer)
      pillStarTimer = 0
    }
    pillStarTargetP = to
    pillStarStarts += 1
    pillStarLog = (pillStarLog + (to ? '1' : '0')).slice(-40)
    var from = pillStarP
    if (from === to) {
      paintPillStar(to)
      return
    }
    // ② 打断后接着走：时长按**剩余距离**等比缩短 → 速度不变，而且一定会走到终点。
    //    否则"收球途中被展开"这种来回打断会让每一段都跑满 280ms，永远追不上目标。
    var span = Math.max(60, PILL_MORPH_MS * Math.abs(to - from))
    var done = 0
    var last = Date.now()
    function step() {
      var now = Date.now()
      var elapsed = now - last
      // 时钟被冻住时（--virtual-time-budget 那种虚拟时钟：定时器照走、Date.now() 不动）
      // 按"一拍 16ms"推进 —— 否则动画永远停在第一帧，测试也就看不到中途形状
      //（而"中途形状不对"正是上一版漏掉的那个 bug）。真实环境里 elapsed 就是真实间隔。
      if (elapsed <= 0) elapsed = 16
      last = now
      done += elapsed
      var x = done / span
      if (x >= 1) {
        pillStarTimer = 0
        paintPillStar(to)
        return
      }
      paintPillStar(from + (to - from) * pillStarEase(x))
      pillStarTimer = setTimeout(step, 16)
    }
    step()
  }

  /** 球心里的图形切到"圆点"（展开）或"星芒"（收球）。 */
  function setPillStar(ball) {
    animatePillStar(ball ? 1 : 0)
  }

  function collapsePill() {
    if (interaction.pillBall) return false
    interaction.pillBall = true
    env.pill.setAttribute('data-ball', '1')
    setPillStar(true)
    placePill() // 上限 → 球的尺寸（过渡动画交给 CSS 的 max-width）
    if (interaction.pillDock === 'free') applyFreePill()
    return true
  }

  function expandPill() {
    if (!interaction.pillBall) return false
    interaction.pillBall = false
    env.pill.removeAttribute('data-ball')
    setPillStar(false)
    placePill() // 上限交回 200 / 费用胶囊那条
    if (interaction.pillDock === 'free') applyFreePill()
    return true
  }

  /**
   * 静置计时：任何"活动"都把它重新拨满（见 notePillActivity）。
   * 用裸 setTimeout 而不是 later()：这个计时器每帧都可能被重置，塞进 timers 数组会一直长。
   */
  function schedulePillIdle() {
    if (interaction.pillIdleId) clearTimeout(interaction.pillIdleId)
    interaction.pillIdleId = setTimeout(function () {
      interaction.pillIdleId = 0
      if (pillCanBall()) collapsePill()
    }, preferences.pillIdleMs)
  }

  /** 有活动（点/划过/小窗在动/状态在变）→ 收着球就展开，并把静置计时重新拨满。 */
  function notePillActivity() {
    if (interaction.pillBall) expandPill()
    schedulePillIdle()
  }

  /**
   * 开始拖胶囊（鼠标；和面板拖动同一套写法）。
   *
   * 三个要点：
   *   · 位移超过 PILL_DRAG_SLOP 才算"拖"，否则仍按点击处理（点一下要能开关小窗）；
   *   · 一开拖就切到 free —— 贴角的轮询从此不许再动它（否则拖到一半会被拽回去）；
   *   · 拖动期间关掉过渡（data-drag），松手再打开：吸附那一下才有动画，拖的时候不黏手。
   */
  function beginPillDrag(event) {
    if (event.button !== undefined && event.button !== 0) return
    if (interaction.pillBall) expandPill() // 球也能直接拖：先展开（hover 那条路通常已经展开了）
    var rect = env.pill.getBoundingClientRect()
    var drag = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    }
    interaction.pillDrag = drag
    interaction.pillDragMoved = false
    interaction.pillSnapUntil = 0
    var move = function (moveEvent) {
      if (interaction.pillDrag !== drag) return
      if (!drag.moved) {
        var travelled = Math.abs(moveEvent.clientX - drag.startX) + Math.abs(moveEvent.clientY - drag.startY)
        if (travelled < PILL_DRAG_SLOP) return
        drag.moved = true
        interaction.pillDragMoved = true
        env.pill.setAttribute('data-drag', '1')
      }
      var w = env.pill.offsetWidth
      var h = env.pill.offsetHeight
      var left = clamp(moveEvent.clientX - drag.offsetX, 4, Math.max(4, window.innerWidth - w - 4))
      var top = clamp(moveEvent.clientY - drag.offsetY, 4, Math.max(4, window.innerHeight - h - 4))
      // 真的拖了 → 从"贴角/跟随"切成自由摆放：位置归用户，轮询不再动它
      interaction.pillDock = 'free'
      interaction.pillFreeRight = { right: left + w, y: top + h / 2 }
      applyFreePill()
    }
    var up = function () {
      window.removeEventListener('mousemove', move, true)
      window.removeEventListener('mouseup', up, true)
      if (interaction.pillDrag !== drag) return
      var dropRect = drag.moved ? env.pill.getBoundingClientRect() : null
      interaction.pillDrag = null
      if (!drag.moved) {
        env.pill.removeAttribute('data-drag')
        return // 没动 = 点击：交给 click 处理（不在这里 reopen）
      }
      settlePillDrop(dropRect)
      notePillActivity()
    }
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mouseup', up, true)
  }

  /**
   * 松手：拖到贴角位置附近就吸附回去 —— 有费用胶囊就吸附到"跟随它的位置"，
   * 没有就吸附到右下角 20/20；离得远就留在原地（位置归用户）。
   */
  function settlePillDrop(rect) {
    var target = pillAnchorRect()
    var near =
      Math.abs(rect.left - target.left) <= PILL_SNAP_RADIUS && Math.abs(rect.top - target.top) <= PILL_SNAP_RADIUS
    if (!near) {
      interaction.pillDock = 'free'
      pillUserPlaced = true
      clampFreePill()
      savePillPos() // 位置归用户：记住它（存 host 上）
      env.pill.removeAttribute('data-drag')
      return false
    }
    // 吸附：要"滑回去"而不是瞬移。
    // left/top 与 right/bottom 之间不可插值（left:124px → auto 会直接跳），所以先把目标位置
    // 写成 left/top 让过渡跑完，窗口结束（PILL_SNAP_MS）再交还给 right/bottom 那套稳态定位。
    var snappedTo = pillAnchorRect()
    interaction.pillDock = 'anchor'
    interaction.pillFreeRight = null
    clearPillPos() // 吸附回右下角 = 默认位置，不用记了
    interaction.pillSnapUntil = Date.now() + PILL_SNAP_MS
    // 拖动时位置由 right 控制；吸附滑行由 left 控制。先在禁用过渡时
    // 把当前几何位置交给 left，再启用过渡写目标位置，避免 auto 属性瞬跳。
    env.pill.style.left = Math.round(rect.left) + 'px'
    env.pill.style.top = Math.round(rect.top) + 'px'
    env.pill.style.right = 'auto'
    env.pill.style.bottom = 'auto'
    void env.pill.offsetWidth
    env.pill.removeAttribute('data-drag')
    env.pill.style.left = Math.round(snappedTo.left) + 'px'
    env.pill.style.top = Math.round(snappedTo.top) + 'px'
    env.later(function () {
      interaction.pillSnapUntil = 0
      if (interaction.pillDock === 'anchor') placePill()
    }, PILL_SNAP_MS)
    return true
  }

  /**
   * 贴位置的节奏：**自适应退避**。
   *
   * 量一次很便宜（实测 500 次共 2ms ≈ 4µs/次，且 0 次 DOM 写入），但不该永远按固定频率空转：
   * 位置/宽度没变就逐次拉长间隔（2s → 3s → 4.5s … 封顶 60s），一旦发现变化立刻回到 2s。
   * 这样"费用数字在涨、面板在开合"时跟得紧，长时间不动时几乎不占任何东西。
   */
  /**
   * 费用胶囊尺寸一变就立刻重贴（浏览器有 ResizeObserver 就用它，事件驱动、零空转）。
   *
   * 光靠轮询的话，"费用数字变长"要等下一次 tick 才被发现——退避到 15s 时就是最多 15s 的错位。
   * 观察器负责"立刻"，轮询退化成兜底（发现迟到挂载的插件、以及没有 ResizeObserver 的环境）。
   */
  function ensureResizeWatch() {
    if (typeof ResizeObserver !== 'function' || !interaction.pillHost || interaction.pillHost === interaction.pillWatched) return
    if (interaction.pillObserver) {
      try {
        interaction.pillObserver.disconnect()
      } catch (error) {
        /* noop */
      }
    }
    interaction.pillWatched = interaction.pillHost
    try {
      interaction.pillObserver = new ResizeObserver(function () {
        interaction.pillPollDelay = 2000
        placePill()
      })
      interaction.pillObserver.observe(interaction.pillHost)
    } catch (error) {
      interaction.pillObserver = null
    }
  }

  function pillPollStep() {
    var changed = placePill()
    ensureResizeWatch()
    interaction.pillPollDelay = changed ? 2000 : Math.min(60000, Math.round(interaction.pillPollDelay * 1.5))
    return interaction.pillPollDelay
  }

  function schedulePillPlacer() {
    interaction.pillPlacerId = setTimeout(function () {
      pillPollStep()
      schedulePillPlacer()
    }, interaction.pillPollDelay)
  }

  /**
   * 点胶囊：**开关小窗**。
   * 关着 → 回到"最近一次小窗"的状态（内存里没有了就回放 host 上的最近一条）；
   * 开着 → 收起（再点一次又能原样打开，不会重新请求）。
   */
  function reopenLast() {
    if (env.panelOpen) {
      // 再点一次 = 收起（和右上角 ✕ 同一条路径：还在飞的请求会被中止并记成「已停止」）
      env.closePanel()
      return
    }
    var hasLive = !!(
      env.state.payload &&
      (env.state.parts.translation ||
        env.state.parts.detail ||
        env.state.turns.length > 0 ||
        env.state.phase === 'error' ||
        env.state.phase === 'paused' ||
        env.state.phase === 'loading' ||
        env.state.phase === 'streaming')
    )
    if (hasLive) {
      // 原位重开：一个字都不重新请求，连进度都是刚才那个
      env.showPanel(rectOfPill())
      env.paint()
      env.renderTurns()
      return
    }
    // 内存里没有：问 host 要最近一条小窗记录（A′ 落盘的历史），回放它
    env.setStatus('正在取回最近一次小窗…')
    fetch(HISTORY)
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        var entry = data && data.ok === true && data.entries && data.entries[0] ? data.entries[0] : null
        if (!entry) {
          env.setStatus('还没有可回放的小窗：先选一段文字试试')
          return
        }
        env.loadHistoryEntry(entry.key, rectOfPill())
      })
      .catch(function () {
        env.setStatus('取回最近一次小窗失败')
      })
  }

  /** 胶囊的屏幕矩形（当作面板的锚点：面板会落在它上方）。 */
  function rectOfPill() {
    var rect = env.pill.getBoundingClientRect()
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
  }
  return {
    beginPillDrag,
    reopenLast,
    notePillActivity,
    loadPillPos,
    placePill,
    ensureResizeWatch,
    schedulePillPlacer,
    paintPill,
    get pillPosAsked() { return pillPosAsked },
    set pillPosAsked(value) { pillPosAsked = value },
    get pillUserPlaced() { return pillUserPlaced },
    set pillUserPlaced(value) { pillUserPlaced = value },
    pillStarPathAt,
    get pillStarP() { return pillStarP },
    set pillStarP(value) { pillStarP = value },
    get pillStarTargetP() { return pillStarTargetP },
    set pillStarTargetP(value) { pillStarTargetP = value },
    get pillStarStarts() { return pillStarStarts },
    set pillStarStarts(value) { pillStarStarts = value },
    get pillStarLog() { return pillStarLog },
    set pillStarLog(value) { pillStarLog = value },
    animatePillStar,
    get pillStarTimer() { return pillStarTimer },
    set pillStarTimer(value) { pillStarTimer = value },
    paintPillStar,
    pillStarEase,
    pillCanBall,
    collapsePill,
    pillPollStep,
    schedulePillIdle,
    rectOfPill,
  }
}
