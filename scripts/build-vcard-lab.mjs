/**
 * 生成「临时输入框（语音卡）→ 解读小窗」交接动效的**方案实验室**页。
 *
 * 用法：node scripts/build-vcard-lab.mjs
 * 产物：docs/vcard-to-panel-lab.html（单文件、离线可开）
 *
 * 为什么用生成器而不是手写页面：
 *   · 卡片/小窗的样式必须**和线上一模一样**，否则"哪个方案好看"这个判断本身就不成立 ——
 *     所以 CSS 直接从 lib/client.js 的模块级 `CSS` 常量抽出来注入（与 build-demo-pages.mjs 同一手法，不手抄）。
 *   · 几何也照真实规则算：卡片 360 宽、**右缘**贴选区右缘、选区底边 +22；小窗 540 宽、
 *     **左缘**贴选区左缘、选区底边 +10（见 src/client/index.js 的 vcardGeometry / showPanel）。
 *
 * 页面上跑的是**六个方案**：0 现状（对照）／1 面板淡入／2 缩放长出／3 几何补间／4 CRT 交接／5 文字搬家。
 * 每个方案都能单独重播、0.25× 慢放、开几何参考线、开并排对比；还能切"减少动效"看各自的降级形态。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** 从客户端 bundle 里取出模块级 CSS 常量（不手抄，保证与线上一致）。 */
function extractCss() {
  const src = readFileSync(resolve(ROOT, 'lib', 'client.js'), 'utf8')
  const m = src.match(/var CSS = \[([\s\S]*?)\]\s*\.join\(''\)/) || src.match(/var CSS = \[([\s\S]*?)\]\.join\('\\n'\)/)
  if (!m) throw new Error('未能在 lib/client.js 里找到 CSS 常量')
  const parts = []
  const re = /'((?:[^'\\]|\\.)*)'/g
  let e
  while ((e = re.exec(m[1])) !== null) parts.push(e[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'))
  return parts.join('\n')
}

/** DSH 主题变量：浅色一套（与真实宿主一致），深色一套由页面上的开关切。 */
const THEME_VARS = `:root{
  --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-label-primary:#1a1a1a; --dsw-alias-label-secondary:#6b7280;
  --dsw-alias-label-primary-foreground:#ffffff; --dsw-alias-interactive-bg-hover:rgba(140,140,140,.11);
  --dsw-alias-border-l3:rgba(140,140,140,.35); --dsw-alias-border-l4:rgba(140,140,140,.22);
  --dsw-alias-bg-base:#ffffff; --dsw-alias-border-l2:rgba(140,140,140,.28);
  --dsw-alias-button-primary-fill:#3b6ef5; --sel-a1:#0d9488; --sel-a2:#0f766e;
}`
const THEME_VARS_DARK = `.lab-dark .dsh-sel-layer, .lab-dark .dsh-sel-vcard{
  --dsw-alias-bg-layer-1:#1c1c1e; --dsw-alias-label-primary:#f2f2f7; --dsw-alias-label-secondary:#9b9ba1;
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.09);
  --dsw-alias-border-l3:rgba(255,255,255,.22); --dsw-alias-border-l4:rgba(255,255,255,.14);
  --dsw-alias-bg-base:#1c1c1e; --dsw-alias-border-l2:rgba(255,255,255,.18);
  --sel-a1:#4ecdc4; --sel-a2:#4ecdc4;
}`

// ───────────────────────── 舞台里的"演员"（真实结构 + 真实类名）─────────────────────────

/** 假文档：一段被划中的话。选区就是交接的锚点。 */
const DOC = `<div class="lab-doc">
  <div class="lab-doctitle">release-notes.md</div>
  <p>把这次上线的情况同步一下：<span class="lab-sel">the migration ran long</span>，所以后面的
  <code>freeze features</code> 不是随口一提 —— 那是把人力腾出来的实际动作。</p>
  <p class="lab-docdim">（这段是假文档，只为了让"选区 → 浮标 → 卡片 → 小窗"这条链路有真实锚点。）</p>
</div>`

/** 浮标：真实类名与结构（.dsh-sel-btn + spark 图标）。 */
const FLOAT_BTN = `<button class="dsh-sel-btn lab-float" type="button">
  <svg class="lab-spark" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.6l1.5 4.3 4.3 1.5-4.3 1.5L8 13.2l-1.5-4.3L2.2 7.4l4.3-1.5z"></path></svg>
  <span>解读</span>
</button>`

/** 临时输入框：真实结构（vbar + textarea + 发送键），在听态 data-voiced="1"。 */
const VCARD = `<div class="dsh-sel-vcard lab-card" data-voiced="1" data-text="1">
  <div class="dsh-sel-vbar"></div>
  <textarea class="dsh-sel-vcard-box" rows="1" spellcheck="false" placeholder="正在听…">这是 在推迟 还是提前</textarea>
  <button class="dsh-sel-vcard-send" type="button" title="直接追问（跳过翻译与详解）">↑</button>
</div>`

/** 关机亮线：真实结构（5 段 + 2 个火花）。 */
const CRTLINE = `<div class="dsh-sel-crtline lab-crt"><div class="dsh-sel-crtseg"></div><div class="dsh-sel-crtseg"></div><div class="dsh-sel-crtseg"></div><div class="dsh-sel-crtseg"></div><div class="dsh-sel-crtseg"></div><div class="dsh-sel-crtspark"></div><div class="dsh-sel-crtspark"></div></div>`

const SEND_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13.2V3.4"></path><path d="M3.9 7.5 8 3.4l4.1 4.1"></path></svg>`

const askRow = (value = '') => `<div class="dsh-sel-ask">
  <div class="dsh-sel-quotes"></div>
  <textarea class="dsh-sel-askbox" rows="1" placeholder="就这段文字继续追问…（Enter 发送，Shift+Enter 换行）">${value}</textarea>
  <div class="dsh-sel-asktools">
    <span class="dsh-sel-pref" data-on="0">
      <span class="dsh-sel-preftext">输出偏好</span>
      <span class="dsh-sel-seg" role="radiogroup" aria-label="输出偏好">
        <span class="dsh-sel-segpill"></span>
        <button class="dsh-sel-segcell" role="radio" aria-label="Markdown" data-on="1">M↓</button>
        <button class="dsh-sel-segcell" role="radio" aria-label="网页">▢</button>
      </span>
    </span>
    <span class="dsh-sel-askspace"></span>
    <button class="dsh-sel-picker" type="button"><span class="dsh-sel-picker-name">Step 5 Preview Free</span><span class="dsh-sel-picker-tier">· 高</span><span class="dsh-sel-picker-caret">▼</span></button>
    <button class="dsh-sel-iconbtn dsh-sel-asksend" type="button" aria-label="发送">${SEND_ICON}</button>
  </div>
</div>`

/** 解读小窗：语音那条路（state.voiceAsk）的形态 —— 没有翻译/详解两节，直接是「选中文字 + 第一条追问」。 */
const PANEL = `<div class="dsh-sel-panel lab-panel" data-stage="translation" data-theme="light" role="dialog" aria-label="划词解读">
  <div class="dsh-sel-head">
    <span class="dsh-sel-mark"></span><span class="dsh-sel-title">划词解读</span><span class="dsh-sel-headspace"></span>
    <button class="dsh-sel-action">最近</button><button class="dsh-sel-action">升格</button><button class="dsh-sel-icon">✕</button>
  </div>
  <div class="dsh-sel-body">
    <div class="dsh-sel-quote">the migration ran long</div>
    <div class="dsh-sel-chatlog" style="display:flex">
      <div class="dsh-sel-bubble dsh-sel-bubble-user lab-firstask">这是 在推迟 还是提前</div>
      <div class="dsh-sel-bubble dsh-sel-bubble-bot">是「推迟」——<b>ran long</b> 说的是这次迁移已经跑得比预期久，不是"提前"。<br>提前会用 <b>ran ahead of schedule</b>。</div>
    </div>
    ${askRow()}
  </div>
</div>`

/** 几何补间方案专用：一个从卡片矩形长成小窗矩形的"形变箱"，里面两套内容按最终宽度钉死、裁切换。 */
const MORPH = `<div class="lab-morph" hidden>
  <div class="lab-morphcard">
    <div class="dsh-sel-vcard" data-voiced="0" data-text="1" style="position:absolute;right:0;top:0">
      <div class="dsh-sel-vbar"></div>
      <textarea class="dsh-sel-vcard-box" rows="1" spellcheck="false">这是 在推迟 还是提前</textarea>
      <button class="dsh-sel-vcard-send" type="button">↑</button>
    </div>
  </div>
  <div class="lab-morphpanel">
    <div class="dsh-sel-panel" data-stage="translation" data-theme="light">
      <div class="dsh-sel-head"><span class="dsh-sel-mark"></span><span class="dsh-sel-title">划词解读</span><span class="dsh-sel-headspace"></span>
        <button class="dsh-sel-action">最近</button><button class="dsh-sel-action">升格</button><button class="dsh-sel-icon">✕</button></div>
      <div class="dsh-sel-body">
        <div class="dsh-sel-quote">the migration ran long</div>
        <div class="dsh-sel-chatlog" style="display:flex">
          <div class="dsh-sel-bubble dsh-sel-bubble-user">这是 在推迟 还是提前</div>
          <div class="dsh-sel-bubble dsh-sel-bubble-bot">是「推迟」——<b>ran long</b> 说的是这次迁移已经跑得比预期久，不是"提前"。</div>
        </div>
        ${askRow()}
      </div>
    </div>
  </div>
</div>`

/** 文字搬家方案专用：把"你说的那句话"复制一份，飞进小窗成为第一条追问。 */
const GHOST = `<div class="lab-ghost" hidden>这是 在推迟 还是提前</div>`
/** CRT 交接方案专用：小窗"开机"那条亮线。 */
const PANEL_LINE = `<div class="lab-panelline" hidden></div>`

const ACTORS = (withExtras) => `${FLOAT_BTN}${VCARD}${PANEL}${CRTLINE}${withExtras ? MORPH + GHOST + PANEL_LINE : ''}`

// ───────────────────────── 页面外壳 ─────────────────────────
const SHELL_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#0d1117;color:#e6edf3;font:13.5px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;padding:18px 20px 40px}
h1{font-size:17px;margin:0 0 4px;letter-spacing:.2px}
.sub{color:#8b949e;font-size:12.5px;margin:0 0 14px;max-width:1000px}
.sub b{color:#e6edf3;font-weight:600}
.wrap{display:grid;grid-template-columns:minmax(0,1fr) 372px;gap:16px;align-items:start}
@media (max-width:1120px){.wrap{grid-template-columns:1fr}}
.card{background:#161b22;border:1px solid #2a3038;border-radius:14px;padding:13px 15px}
.card + .card{margin-top:12px}
.card h3{margin:0 0 9px;font-size:13px;color:#79c0ff;font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:8px}
.card h3 small{color:#6e7681;font-weight:400;font-size:11px}
.hint{color:#8b949e;font-size:11.5px;line-height:1.6;margin:8px 0 0}

/* 舞台：一块浅色"文档"，浮层在里面绝对定位（真实是 position:fixed 贴视口） */
.lab-stage{position:relative;background:#fbfaf7;border:1px solid #2a3038;border-radius:14px;padding:20px 22px;min-height:486px;overflow:hidden}
.lab-dark .lab-stage{background:#15161a}
.lab-doc{color:#1d2126;font-size:14.5px;line-height:1.9;max-width:520px;position:relative;z-index:1}
.lab-dark .lab-doc{color:#dfe3e8}
.lab-doctitle{font:600 11.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9aa3ad;letter-spacing:.4px;margin-bottom:12px;text-transform:uppercase}
.lab-doc p{margin:0 0 12px}
.lab-doc code{background:#eceff3;padding:1px 5px;border-radius:4px;font-size:12.5px}
.lab-dark .lab-doc code{background:#24262c}
.lab-docdim{color:#9aa3ad;font-size:12px}
.lab-sel{background:rgba(13,148,136,.16);box-shadow:inset 0 -1px 0 rgba(13,148,136,.5);border-radius:3px;padding:1px 2px}

/* 浮层：真实是 position:fixed，这里改成舞台内绝对定位（几何由 JS 按真实规则算） */
.lab-stage .dsh-sel-btn,.lab-stage .dsh-sel-vcard,.lab-stage .dsh-sel-panel,
.lab-stage .dsh-sel-crtline,.lab-stage .lab-morph,.lab-stage .lab-ghost,.lab-stage .lab-panelline{position:absolute !important}
.lab-stage .dsh-sel-btn{display:inline-flex}
.lab-stage .dsh-sel-vcard{display:flex}
.lab-stage .dsh-sel-panel{display:flex;transform-origin:0 0}
.lab-stage .lab-float{visibility:hidden;transform-origin:100% 100%}
.lab-stage .lab-card{visibility:hidden}
.lab-stage .lab-panel{visibility:hidden;opacity:0}
.lab-stage .lab-crt{visibility:hidden}
.lab-stage .lab-morph{overflow:hidden;visibility:hidden}
.lab-stage .lab-ghost{visibility:hidden;font:inherit;white-space:nowrap;pointer-events:none;z-index:2147483002;
  background:rgba(13,148,136,.14);border-radius:3px;padding:1px 2px;color:#1d2126}
.lab-dark .lab-stage .lab-ghost{color:#dfe3e8}
.lab-stage .lab-panelline{visibility:hidden;height:2px;border-radius:2px;background:#0d9488;z-index:2147483002;
  box-shadow:0 0 10px rgba(13,148,136,.75)}
.lab-stage .lab-morph .dsh-sel-panel{position:absolute !important;left:0;top:0;width:540px !important;visibility:visible !important;opacity:1 !important}
.lab-stage .lab-morph .dsh-sel-vcard{visibility:visible}
.lab-morphcard{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden}
.lab-morphpanel{position:absolute;left:0;top:0;overflow:hidden}
.lab-morphpanel{opacity:0}

/* 几何参考线 */
.lab-stage[data-guides="1"] .lab-guide{display:block}
.lab-guide{display:none;position:absolute;border:1px dashed rgba(13,148,136,.75);border-radius:6px;pointer-events:none;z-index:2147483001}
.lab-guide::after{content:attr(data-label);position:absolute;left:0;top:-15px;font:600 10px/1 ui-monospace,Menlo,monospace;color:#0d9488;letter-spacing:.3px}
.lab-guide[data-kind="panel"]{border-color:rgba(59,110,245,.8)}
.lab-guide[data-kind="panel"]::after{color:#3b6ef5}

/* 侧栏控件 */
.opt{display:flex;gap:9px;align-items:flex-start;padding:8px 9px;border-radius:10px;cursor:pointer;font-size:12.5px;border:1px solid transparent}
.opt:hover{background:rgba(255,255,255,.04)}
.opt[data-on="1"]{background:rgba(13,148,136,.12);border-color:rgba(13,148,136,.45)}
.opt input{margin-top:3px;accent-color:#12a594;flex:0 0 auto}
.opt b{font-weight:600;display:block}
.opt small{display:block;color:#8b949e;font-size:11.5px;line-height:1.5;margin-top:1px}
.opt .tag{display:inline-block;margin-left:6px;font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(126,231,135,.14);color:#7ee787;vertical-align:1px}
.opt .tag.warn{background:rgba(255,166,87,.14);color:#ffa657}
.opt .tag.cool{background:rgba(121,192,255,.14);color:#79c0ff}
.btnrow{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
button.act{border:1px solid #2a3038;background:#1b2230;color:#e6edf3;font:inherit;font-size:12.5px;padding:7px 13px;border-radius:10px;cursor:pointer}
button.act:hover{border-color:#3d4652}
button.act.primary{background:#0f766e;border-color:transparent;color:#fff;font-weight:600}
button.act[data-on="1"]{background:rgba(13,148,136,.18);border-color:rgba(13,148,136,.55)}
.switches{display:flex;gap:14px;flex-wrap:wrap;margin-top:11px;font-size:12px;color:#8b949e}
.switches label{display:flex;gap:6px;align-items:center;cursor:pointer}
.switches input{accent-color:#12a594}
table.spec{width:100%;border-collapse:collapse;font-size:12px;margin-top:2px}
table.spec th,table.spec td{padding:6px 4px;border-bottom:1px solid #232a33;text-align:left;vertical-align:top}
table.spec th{color:#8b949e;font-weight:500;width:88px}
table.spec td b{color:#e6edf3;font-weight:600}
.verdict{margin-top:10px;padding:9px 11px;border-radius:10px;background:rgba(126,231,135,.07);border:1px solid rgba(126,231,135,.22);font-size:12px;line-height:1.6}
.verdict b{color:#7ee787}
.verdict.warn{background:rgba(255,166,87,.07);border-color:rgba(255,166,87,.22)}
.verdict.warn b{color:#ffa657}
.verdict.cool{background:rgba(121,192,255,.07);border-color:rgba(121,192,255,.22)}
.verdict.cool b{color:#79c0ff}

/* 并排对比 */
.grid{display:none;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.grid[data-on="1"]{display:grid}
@media (max-width:1120px){.grid[data-on="1"]{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cell{background:#161b22;border:1px solid #2a3038;border-radius:12px;overflow:hidden}
.cellh{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;font-size:12px;border-bottom:1px solid #232a33}
.cellh b{font-weight:600}
.cellh span{color:#6e7681;font-size:11px;font-variant-numeric:tabular-nums}
.cellstage{position:relative;height:300px;background:#fbfaf7;overflow:hidden}
.lab-dark .cellstage{background:#15161a}
/* 并排对比：整块舞台缩到 60%，让 540 宽的小窗也能完整落在窄格子里。
   缩放只影响视觉 —— 几何由 data-scale 除回本地坐标，规则与单舞台完全一致。 */
.lab-scaler{position:absolute;left:50%;top:6px;width:456px;height:296px;margin-left:-228px;overflow:hidden}
.lab-scaler .lab-stage{width:760px;min-height:486px;transform:scale(.6);transform-origin:0 0;border-radius:20px}
`

// ───────────────────────── 页面脚本（方案引擎 + 控件）─────────────────────────
const SCRIPT = String.raw`
(() => {
  const $ = (sel, root) => (root || document).querySelector(sel)
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel))
  let TIME = 1          // 播放倍率：0.25 = 慢放到 1/4 速（时长 ×4）
  let LOOP = false
  let MODE = 'intro'    // intro = 含前置；solo = 只播交接
  let REDUCED = false   // 强制走"减少动效"的降级形态
  let busy = false
  let runToken = 0

  const rate = () => (REDUCED ? 2.6 : 1 / TIME)   // 时长倍率：慢放时把每一段都拉长
  const wait = (ms) => new Promise((r) => setTimeout(r, ms * rate()))
  /** WAAPI 包装：时长/延迟都跟着速度倍率走。 */
  const anim = (el, frames, ms, easing, delay) => el.animate(frames, {
    duration: Math.max(1, ms * rate()),
    delay: Math.max(0, (delay || 0) * rate()),
    easing: easing || 'cubic-bezier(.22,1,.36,1)',
    fill: 'both',
  })
  const done = (a) => a.finished.catch(() => {})
  const all = (list) => Promise.all(list.map(done))

  // ── 几何：照真实规则算（卡片 360 右贴选区、+22；小窗 540 左贴选区、+10）──
  const CARD_W = 360
  const CARD_H = 42
  const PANEL_W = 540
  function geom(root) {
    // 舞台可能被整体缩放（并排对比里 scale(.6)）：getBoundingClientRect 给的是缩放后的值，
    // 而 style.left/top 是在**本地坐标系**里解释的 —— 所以这里统一除回本地坐标。
    const s = parseFloat(root.getAttribute('data-scale') || '1') || 1
    const box = root.getBoundingClientRect()
    const sel = $('.lab-sel', root)
    const sb = sel.getBoundingClientRect()
    const selBox = {
      left: (sb.left - box.left) / s, right: (sb.right - box.left) / s,
      top: (sb.top - box.top) / s, bottom: (sb.bottom - box.top) / s,
    }
    const card = {
      left: Math.max(8, selBox.right - CARD_W), top: selBox.bottom + 22, width: CARD_W, height: CARD_H,
    }
    const panelEl = $('.lab-panel', root)
    const panelH = panelEl.offsetHeight || 186
    const panel = {
      left: Math.min(Math.max(8, selBox.left), Math.max(8, box.width / s - PANEL_W - 8)),
      top: selBox.bottom + 10, width: PANEL_W, height: panelH,
    }
    return { box, sel: selBox, card, panel }
  }
  const place = (el, r, extra) => {
    el.style.left = r.left + 'px'
    el.style.top = r.top + 'px'
    if (r.width) el.style.width = r.width + 'px'
    if (r.height) el.style.height = r.height + 'px'
    if (extra) Object.assign(el.style, extra)
  }

  // ── 一个舞台的完整装配 ──
  function mount(root) {
    const h = { root }
    h.doc = $('.lab-doc', root)
    h.float = $('.lab-float', root)
    h.card = $('.lab-card', root)
    h.crt = $('.lab-crt', root)
    h.panel = $('.lab-panel', root)
    h.morph = $('.lab-morph', root)
    h.morphCard = $('.lab-morphcard', root)
    h.morphPanel = $('.lab-morphpanel', root)
    h.ghost = $('.lab-ghost', root)
    h.panelLine = $('.lab-panelline', root)
    h.askbox = $('.dsh-sel-askbox', h.panel)
    h.firstAsk = $('.lab-firstask', h.panel)
    h.guides = { card: null, panel: null }
    return h
  }

  /** 复位到"还没开始"：浮标藏、卡片藏、小窗藏。 */
  function reset(h) {
    // ⚠️ 先**取消**上一轮留下的动画：WAAPI 用 fill:'both'，跑完会一直占着属性
    // （踩过：方案 2 把卡片 opacity 定格在 0，之后方案 4 的 CRT 卡片整个看不见）。
    // 取消之后属性回到 CSS/内联值，每个方案都从同一个干净起点开始。
    for (const el of [h.float, h.card, h.crt, h.panel, h.morph, h.morphCard, h.morphPanel, h.ghost, h.panelLine]) {
      if (!el || typeof el.getAnimations !== 'function') continue
      for (const a of el.getAnimations()) { try { a.cancel() } catch (error) { /* noop */ } }
      if (el.getAnimations && el.getAnimations().length === 0) el.style.animationDuration = ''
    }
    const g = geom(h.root)
    h.g = g
    h.card.style.transition = 'none'
    h.panel.style.transition = 'none'
    h.card.style.transform = 'none'
    h.card.style.opacity = ''
    h.card.style.borderRadius = ''
    h.card.removeAttribute('data-off')
    h.card.style.visibility = 'hidden'
    h.panel.style.transform = 'none'
    h.panel.style.opacity = '0'
    h.panel.style.visibility = 'hidden'
    h.panel.style.borderRadius = ''
    h.panel.style.filter = ''
    h.crt.style.visibility = 'hidden'
    h.crt.removeAttribute('data-off')
    h.float.style.visibility = 'hidden'
    h.float.style.opacity = ''
    h.float.style.transform = ''
    if (h.morph) { h.morph.hidden = true; h.morph.style.visibility = 'hidden' }
    if (h.ghost) { h.ghost.hidden = true; h.ghost.style.visibility = 'hidden'; h.ghost.style.transform = 'none'; h.ghost.style.opacity = '1' }
    if (h.panelLine) { h.panelLine.hidden = true; h.panelLine.style.visibility = 'hidden' }
    if (h.morphPanel) h.morphPanel.style.opacity = '0'
    if (h.morphCard) h.morphCard.style.opacity = '1'
    if (h.firstAsk) h.firstAsk.style.opacity = ''
    if (h.askbox) h.askbox.value = ''
    // 参考线
    const st = h.root
    st.setAttribute('data-guides', st.getAttribute('data-guides') === '1' ? '1' : '0')
    if (h.guides.card) h.guides.card.remove()
    if (h.guides.panel) h.guides.panel.remove()
    const mk = (kind, r, label) => {
      const d = document.createElement('div')
      d.className = 'lab-guide'
      d.setAttribute('data-kind', kind)
      d.setAttribute('data-label', label)
      d.style.left = r.left + 'px'; d.style.top = r.top + 'px'
      d.style.width = r.width + 'px'; d.style.height = r.height + 'px'
      st.appendChild(d)
      return d
    }
    h.guides.card = mk('card', g.card, '卡片 360×42')
    h.guides.panel = mk('panel', g.panel, '小窗 540×' + Math.round(g.panel.height))
    // 摆好各自的起点
    place(h.float, { left: g.sel.right - 78, top: g.sel.top - 35, width: 0, height: 0 })
    place(h.card, g.card)
    place(h.panel, g.panel)
    place(h.crt, { left: g.card.left, top: g.card.top + CARD_H / 2 - 1.5, width: g.card.width, height: 0 })
    if (h.morph) {
      place(h.morph, g.card)
      h.morph.style.width = g.card.width + 'px'
      h.morph.style.height = g.card.height + 'px'
      h.morph.style.borderRadius = '20px'
      h.morph.style.background = getComputedStyle(h.card).backgroundColor
      h.morph.style.border = getComputedStyle(h.card).border
      h.morph.style.boxShadow = getComputedStyle(h.card).boxShadow
      h.morph.style.overflow = 'hidden'
      h.morphPanel.style.width = PANEL_W + 'px'
      h.morphPanel.style.height = g.panel.height + 'px'
    }
    if (h.ghost) {
      const r = h.card.getBoundingClientRect()
      const b = h.root.getBoundingClientRect()
      h.ghost.style.left = (r.left - b.left + 13) + 'px'
      h.ghost.style.top = (r.top - b.top + 9) + 'px'
      h.ghost.style.fontSize = getComputedStyle($('.dsh-sel-vcard-box', h.card)).fontSize
    }
    return g
  }

  // ── 前置（六个方案共用）：浮标浮现 → 卡片形变出来 → 逐字上屏 → 停一拍 ──
  async function intro(h, stale) {
    const g = h.g
    const gone = () => (stale ? stale() : false)
    h.float.style.visibility = 'visible'
    await done(anim(h.float, [{ opacity: 0, transform: 'scale(.74) translateY(6px)' }, { opacity: 1, transform: 'none' }], 240, 'cubic-bezier(.34,1.56,.64,1)'))
    if (gone()) return
    await wait(220)
    if (gone()) return
    // 形变：先从浮标那一格出发，再走向卡片终态（与插件 openVCard 同一手法：改几何 + 过渡）
    const pill = h.float.getBoundingClientRect()
    const b = h.root.getBoundingClientRect()
    const from = { left: pill.left - b.left, top: pill.top - b.top, width: pill.width, height: pill.height }
    h.card.style.transition = 'none'
    place(h.card, from, { borderRadius: '999px' })
    h.card.style.visibility = 'visible'
    void h.card.offsetWidth
    h.card.style.transition = ''
    place(h.card, g.card, { borderRadius: '20px' })
    h.float.style.transition = 'opacity .16s ease'
    h.float.style.opacity = '0'
    await wait(320)
    if (gone()) return
    h.float.style.visibility = 'hidden'
    // 逐字上屏（真实是输入法上屏，这里只做视觉）
    const box = $('.dsh-sel-vcard-box', h.card)
    const text = box.value
    box.value = ''
    for (let i = 1; i <= text.length; i += 1) {
      box.value = text.slice(0, i)
      await wait(28)
      if (gone()) return
    }
    // 松手：真实行为是 markVCardListening(false) —— 竖条停、占位换成"直接打字也行…"、
    // 卡片描边从"在听"的青转回常规灰（形变箱复制的就是这一版描边）
    h.card.setAttribute('data-voiced', '0')
    box.placeholder = '直接打字也行…'
    await wait(420)
  }

  // ── 六个方案 ──
  const VARIANTS = [
    {
      id: 'now', name: '0 · 现状（对照）', tag: '对照组', tagKind: 'warn',
      line: '卡片瞬间消失、小窗瞬间出现。零过渡 —— 也是现在线上的行为。',
      spec: [['时长', '<b>0ms</b>（瞬切）'], ['缓动', '—'], ['动了什么', '卡片 <code>display:none</code>；小窗 <code>display:flex</code>'],
        ['实现代价', '<b>零</b>（已经是现状）'], ['代价/风险', '尺寸与对齐同时跳：360 右贴选区 → 540 左贴选区']],
      verdict: '只作为对照。要改的就是它。', kind: 'warn',
      reduced: async (h, stale) => { if (stale && stale()) return; h.card.style.visibility = 'hidden'; h.panel.style.visibility = 'visible'; h.panel.style.opacity = '1' },
      run: async (h, stale) => { if (stale && stale()) return; h.card.style.visibility = 'hidden'; h.panel.style.visibility = 'visible'; h.panel.style.opacity = '1' },
    },
    {
      id: 'fade', name: '1 · 面板淡入', tag: '最省', tagKind: '',
      line: '卡片立刻收掉，小窗原地淡入（轻微放大 + 上浮 6px）。不追求"连续"，只把"啪一下"抹掉。',
      spec: [['时长', '<b>180ms</b>'], ['缓动', 'cubic-bezier(.22,1,.36,1)'],
        ['动了什么', '小窗 <code>opacity</code> + <code>transform</code>（scale .965 → 1、translateY 6 → 0）'],
        ['实现代价', '<b>极低</b>：一个 <code>data-pop</code> 类 + 一段 keyframes'], ['代价/风险', '卡片与小窗仍是两次独立变化，中段有"两个都不在"的一瞬']],
      verdict: '性价比最高的一档：几乎零风险，观感立刻从"跳"变成"淡入"。', kind: '',
      reduced: async (h, stale) => { if (stale && stale()) return; h.card.style.visibility = 'hidden'; h.panel.style.visibility = 'visible'; await done(anim(h.panel, [{ opacity: 0 }, { opacity: 1 }], 120, 'ease')) },
      run: async (h, stale) => {
        await wait(70)
        if (stale && stale()) return
        h.card.style.visibility = 'hidden'
        h.panel.style.visibility = 'visible'
        await done(anim(h.panel, [{ opacity: 0, transform: 'scale(.965) translateY(6px)' }, { opacity: 1, transform: 'none' }], 180))
      },
    },
    {
      id: 'grow', name: '2 · 缩放长出', tag: '已实现', tagKind: 'cool',
      line: '小窗从"卡片那一格"缩放着长出来：起手就是卡片的矩形，260ms 长到自己的位置与大小。只动 transform。',
      spec: [['时长', '<b>260ms</b>'], ['缓动', 'cubic-bezier(.2,.8,.2,1)（与插件"浮标→卡片"同一族）'],
        ['动了什么', '小窗 <code>transform: translate+scale</code>（+ 圆角 20 → 16）；卡片 90ms 淡出'],
        ['实现代价', '<b>低</b>：量两个矩形，写一条 WAAPI/CSS 动画；<b>只碰合成器属性</b>'],
        ['代价/风险', '起手那几帧内容被压扁（缩放态）；内容一开始就是最终排版，不会逐帧重排']],
      verdict: '视觉上最顺、代价又低的一档 —— 用户选定了它，已按这个方案落到插件里（260ms，只动 transform）。', kind: 'cool',
      reduced: async (h, stale) => { if (stale && stale()) return; h.card.style.visibility = 'hidden'; h.panel.style.visibility = 'visible'; await done(anim(h.panel, [{ opacity: 0 }, { opacity: 1 }], 120, 'ease')) },
      run: async (h, stale) => {
        const g = h.g
        const sx = g.card.width / g.panel.width
        const sy = g.card.height / g.panel.height
        const dx = g.card.left - g.panel.left
        const dy = g.card.top - g.panel.top
        h.panel.style.visibility = 'visible'
        const a = anim(h.panel, [
          { opacity: .85, transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')', borderRadius: '20px' },
          { opacity: 1, transform: 'none', borderRadius: '16px' },
        ], 260, 'cubic-bezier(.2,.8,.2,1)')
        const b = anim(h.card, [{ opacity: 1 }, { opacity: 0 }], 90, 'linear')
        await Promise.all([done(a), done(b)])
        if (stale && stale()) return
        h.card.style.visibility = 'hidden'
      },
    },
    {
      id: 'morph', name: '3 · 几何补间', tag: '最连续', tagKind: '',
      line: '一个盒子从卡片矩形真的"长"成小窗矩形：宽/高/左/上/圆角一起补间，两套内容按最终宽度钉死、裁切换。',
      spec: [['时长', '<b>320ms</b>'], ['缓动', 'cubic-bezier(.2,.8,.2,1)（与插件既有的"浮标→卡片"同一族）'],
        ['动了什么', '<code>left/top/width/height/border-radius</code> + 内容交叉淡入'],
        ['实现代价', '<b>中</b>：要一个形变容器 + 两套内容；手法插件里已有（openVCard 就是这么做的）'],
        ['代价/风险', '每帧改的是<b>布局属性</b>（非合成器友好），长内容时可能掉帧；内容必须钉死宽度，否则逐帧重排']],
      verdict: '最"连续"的一档，也最像原生形变；代价是布局动画 + 内容裁切换的实现量。', kind: '',
      reduced: async (h, stale) => { if (stale && stale()) return; h.card.style.visibility = 'hidden'; h.panel.style.visibility = 'visible'; await done(anim(h.panel, [{ opacity: 0 }, { opacity: 1 }], 120, 'ease')) },
      run: async (h, stale) => {
        const g = h.g
        h.morph.hidden = false
        h.morph.style.visibility = 'visible'
        h.card.style.visibility = 'hidden'
        const a = anim(h.morph, [
          { left: g.card.left + 'px', top: g.card.top + 'px', width: g.card.width + 'px', height: g.card.height + 'px', borderRadius: '20px' },
          { left: g.panel.left + 'px', top: g.panel.top + 'px', width: g.panel.width + 'px', height: g.panel.height + 'px', borderRadius: '16px' },
        ], 320, 'cubic-bezier(.2,.8,.2,1)')
        // 内容交叉换：卡片那套早退（0–90ms），小窗那套在 70–210ms 之间进来 ——
        // 都落在形变的前 2/3 里，免得盒子长大了里面还是空的（前几版就栽在这）
        const cross = anim(h.morphCard, [{ opacity: 1 }, { opacity: 0 }], 90, 'linear')
        const crossIn = anim(h.morphPanel, [{ opacity: 0 }, { opacity: 1 }], 140, 'ease', 70)
        await all([a, cross, crossIn])
        if (stale && stale()) return
        h.panel.style.visibility = 'visible'
        h.panel.style.opacity = '1'
        h.morph.style.visibility = 'hidden'
      },
    },
    {
      id: 'crt', name: '4 · CRT 交接', tag: '最贴世界观', tagKind: '',
      line: '卡片照插件既有的"老电视关机"塌成一条线，小窗再以一条亮线"开机"展开 —— 和取消时的关机动画同一套语言。',
      spec: [['时长', '<b>≈560ms</b>（关机 460 + 开机 180，有重叠）'], ['缓动', 'cubic-bezier(.3,0,.2,1)（沿用既有 CRT 曲线）'],
        ['动了什么', '卡片 <code>data-off="a"</code>（既有动画）+ 亮线 <code>scaleX</code> + 小窗淡入'],
        ['实现代价', '<b>低</b>：关机动画已存在，只需给发送路径放行 + 一条开机亮线'],
        ['代价/风险', '总时长最长；发送是"高频动作"，每次都等 0.5 秒可能嫌慢（可缩短到 ~380ms）']],
      verdict: '风格最统一的一档（和 Esc 取消是同一套语言），但发送是高频动作，我建议压缩到 ~380ms 再考虑。', kind: '',
      reduced: async (h, stale) => { if (stale && stale()) return; h.card.style.visibility = 'hidden'; h.panel.style.visibility = 'visible'; await done(anim(h.panel, [{ opacity: 0 }, { opacity: 1 }], 120, 'ease')) },
      run: async (h, stale) => {
        const g = h.g
        // 卡片此刻是"看得见"的（真实场景里它一直在画面上），CRT 是把它塌掉 —— 不是从无到无
        h.card.style.visibility = 'visible'
        h.crt.style.visibility = 'visible'
        // 关键帧时长写死在 CSS 里（460ms）：慢放时把它一起拉长，否则动画早就跑完了还在等
        const ms = 460 * rate() + 'ms'
        h.card.style.animationDuration = ms
        h.crt.style.animationDuration = ms
        for (const seg of $$('.dsh-sel-crtseg, .dsh-sel-crtspark', h.crt)) seg.style.animationDuration = ms
        h.card.setAttribute('data-off', 'a')
        h.crt.setAttribute('data-off', 'a')
        await wait(470)
        if (stale && stale()) return
        h.card.style.animationDuration = ''
        h.crt.style.animationDuration = ''
        h.card.style.visibility = 'hidden'
        h.card.removeAttribute('data-off')
        h.crt.style.visibility = 'hidden'
        h.crt.removeAttribute('data-off')
        // 小窗"开机"：一条亮线从中间横向展开，随后小窗淡入
        h.panel.style.visibility = 'visible'
        h.panelLine.hidden = false
        h.panelLine.style.visibility = 'visible'
        h.panelLine.style.left = g.panel.left + 'px'
        h.panelLine.style.top = (g.panel.top + g.panel.height / 2 - 1) + 'px'
        h.panelLine.style.width = g.panel.width + 'px'
        const a = anim(h.panelLine, [{ transform: 'scaleX(.02)', opacity: .95 }, { transform: 'scaleX(1)', opacity: .95 }, { transform: 'scaleX(1)', opacity: 0 }], 240, 'cubic-bezier(.3,0,.2,1)')
        const b = anim(h.panel, [{ opacity: 0, filter: 'brightness(1.5)' }, { opacity: 1, filter: 'brightness(1)' }], 180, 'ease', 60)
        await all([a, b])
        if (stale && stale()) return
        h.panelLine.style.visibility = 'hidden'
      },
    },
    {
      id: 'carry', name: '5 · 文字搬家', tag: '最有语义', tagKind: 'cool',
      line: '把"你说的那句话"复制一份，从小卡片飞进小窗、落成第一条追问 —— 强调"这句话变成了问题"，而不是"两个框换了换"。',
      spec: [['时长', '<b>≈420ms</b>'], ['缓动', 'cubic-bezier(.3,.9,.25,1)'],
        ['动了什么', '一个文字副本 <code>translate+scale</code> 飞到追问气泡位置；卡片 140ms 收掉；小窗 170ms 淡入'],
        ['实现代价', '<b>中高</b>：要克隆一段文字 + 量气泡位置；好处是只用 transform/opacity'],
        ['代价/风险', '小窗里的第一条追问是"后出现"的，若内容很长会有一拍空窗；文字副本与真实输入框的字号必须对齐']],
      verdict: '语义最好的一档（"我说的这句变成了追问"），实现最重。若只想改观感，选 2；想要一个记忆点，选它。', kind: 'cool',
      reduced: async (h, stale) => { if (stale && stale()) return; h.card.style.visibility = 'hidden'; h.panel.style.visibility = 'visible'; await done(anim(h.panel, [{ opacity: 0 }, { opacity: 1 }], 120, 'ease')) },
      run: async (h, stale) => {
        const g = h.g
        const b = h.root.getBoundingClientRect()
        // 终点 = 小窗里第一条追问气泡的位置（先把气泡藏起来，等文字飞到了再显形）
        h.panel.style.visibility = 'visible'
        h.panel.style.opacity = '0'
        h.firstAsk.style.opacity = '0'   // 气泡等文字飞到了再显形（否则同一句话会同时出现两次）
        const target = h.firstAsk.getBoundingClientRect()
        const askStyle = getComputedStyle(h.firstAsk)
        const ghost = h.ghost
        ghost.hidden = false
        ghost.style.visibility = 'visible'
        const gb = ghost.getBoundingClientRect()
        // 终点 = 气泡里**文字**的原点（含内边距），这样落点与气泡里的字重合
        const dx = (target.left - b.left + (parseFloat(askStyle.paddingLeft) || 0)) - (gb.left - b.left)
        const dy = (target.top - b.top + (parseFloat(askStyle.paddingTop) || 0)) - (gb.top - b.top)
        const boxFont = parseFloat(getComputedStyle($('.dsh-sel-vcard-box', h.card)).fontSize) || 13
        const targetFont = parseFloat(getComputedStyle(h.firstAsk).fontSize) || 13
        const sc = targetFont / boxFont
        const fly = anim(ghost, [
          { transform: 'none', opacity: 1 },
          { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sc + ')', opacity: .9 },
        ], 300, 'cubic-bezier(.3,.9,.25,1)')
        const collapse = anim(h.card, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }], 140, 'ease')
        const fadeIn = anim(h.panel, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], 180, 'ease-out', 90)
        await Promise.all([done(fly), done(collapse), done(fadeIn)])
        if (stale && stale()) return
        h.card.style.visibility = 'hidden'
        h.panel.style.opacity = '1'
        // 落定：追问气泡显形，文字副本退场
        await done(anim(h.firstAsk, [{ opacity: 0 }, { opacity: 1 }], 120, 'ease'))
        if (stale && stale()) return
        ghost.style.visibility = 'hidden'
      },
    },
  ]

  // ── 播放 ──
  async function play(h, variant, opts) {
    const token = ++runToken
    const stale = () => token !== runToken
    reset(h)
    if (opts && opts.intro) {
      await intro(h, stale)
      if (stale()) return
    }
    if (stale()) return
    const fn = REDUCED ? variant.reduced : variant.run
    await fn(h, stale)
  }
  /** 让"正在跑的那一次"作废（点别的方案、外部脚本接管时用）。 */
  function stopPlay() { runToken += 1 }

  // ── 单舞台 ──
  const stage = $('#stage')
  const h = mount(stage)
  let current = VARIANTS[2]

  function paintSide() {
    $$('#variants .opt').forEach((el) => el.setAttribute('data-on', el.dataset.id === current.id ? '1' : '0'))
    $('#vname').textContent = current.name
    $('#vline').textContent = current.line
    $('#vspec').innerHTML = current.spec.map((row) => '<tr><th>' + row[0] + '</th><td>' + row[1] + '</td></tr>').join('')
    const v = $('#vverdict')
    v.className = 'verdict' + (current.kind ? ' ' + current.kind : '')
    v.innerHTML = '<b>判断 · </b>' + current.verdict
  }

  async function replay(intro) {
    if (busy) return
    busy = true
    $('#play').disabled = true
    try {
      do {
        await play(h, current, { intro: !!intro })
        if (!LOOP) break
        await wait(700)
      } while (LOOP && !$('#grid').matches('[data-on="1"]'))
    } finally {
      busy = false
      $('#play').disabled = false
    }
  }

  // 变体列表
  $('#variants').innerHTML = VARIANTS.map((v) => (
    '<label class="opt" data-id="' + v.id + '" data-on="' + (v.id === current.id ? '1' : '0') + '">' +
    '<input type="radio" name="variant" value="' + v.id + '"' + (v.id === current.id ? ' checked' : '') + '>' +
    '<span><b>' + v.name + (v.tag ? '<span class="tag ' + (v.tagKind || '') + '">' + v.tag + '</span>' : '') + '</b>' +
    '<small>' + v.line + '</small></span></label>'
  )).join('')
  $('#variants').addEventListener('change', (e) => {
    const v = VARIANTS.find((x) => x.id === e.target.value)
    if (!v) return
    current = v
    paintSide()
    stopPlay()
    if ($('#grid').matches('[data-on="1"]')) paintGrid()
    else replay(MODE === 'intro')
  })
  $$('#variants .opt').forEach((el) => el.addEventListener('click', () => {
    el.querySelector('input').checked = true
    el.querySelector('input').dispatchEvent(new Event('change', { bubbles: true }))
  }))

  $('#play').addEventListener('click', () => replay(MODE === 'intro'))
  $('#solo').addEventListener('click', () => replay(false))
  $('#loop').addEventListener('click', () => {
    LOOP = !LOOP
    $('#loop').setAttribute('data-on', LOOP ? '1' : '0')
    if (LOOP && !busy) replay(MODE === 'intro')
  })
  $('#mode').addEventListener('click', () => {
    MODE = MODE === 'intro' ? 'solo' : 'intro'
    $('#mode').setAttribute('data-on', MODE === 'intro' ? '1' : '0')
    $('#mode').textContent = MODE === 'intro' ? '含前置（浮标→卡片→发送）' : '只播交接'
  })
  $('#speed').addEventListener('change', (e) => { TIME = parseFloat(e.target.value) || 1 })
  $('#reduced').addEventListener('change', (e) => { REDUCED = e.target.checked; replay(MODE === 'intro') })
  $('#guides').addEventListener('change', (e) => {
    stage.setAttribute('data-guides', e.target.checked ? '1' : '0')
  })
  $('#theme').addEventListener('change', (e) => {
    document.body.classList.toggle('lab-dark', e.target.checked)
    $$('.dsh-sel-panel').forEach((p) => p.setAttribute('data-theme', e.target.checked ? 'dark' : 'light'))
    $$('.dsh-sel-layer').forEach((l) => l.setAttribute('data-theme', e.target.checked ? 'dark' : 'light'))
  })

  // ── 并排对比：六个小舞台同时播 ──
  let gridHandles = []
  function buildGrid() {
    const grid = $('#grid')
    grid.innerHTML = VARIANTS.map((v) => (
      '<div class="cell"><div class="cellh"><b>' + v.name + '</b><span data-role="t">—</span></div>' +
      '<div class="cellstage"><div class="lab-scaler">' +
      '<div class="lab-stage" data-guides="0" data-scale="0.6">' + STAGE_HTML + '</div>' +
      '</div></div></div>'
    )).join('')
    gridHandles = $$('.cellstage .lab-stage', grid).map((root, i) => ({ h: mount(root), v: VARIANTS[i] }))
  }
  async function paintGrid() {
    runToken += 1
    const token = runToken
    const jobs = gridHandles.map(async (g) => {
      const cell = g.h.root.parentNode
      const t0 = performance.now()
      await play(g.h, g.v, { intro: true })
      if (token === runToken) {
        cell.querySelector('[data-role="t"]').textContent = Math.round(performance.now() - t0) + 'ms（含前置）'
      }
    })
    await Promise.all(jobs)
  }
  $('#grid-toggle').addEventListener('click', () => {
    const grid = $('#grid')
    const on = !grid.matches('[data-on="1"]')
    grid.setAttribute('data-on', on ? '1' : '0')
    $('#grid-toggle').setAttribute('data-on', on ? '1' : '0')
    $('#stage').style.display = on ? 'none' : ''
    if (on) {
      if (!gridHandles.length) buildGrid()
      paintGrid()
    } else {
      runToken += 1
      replay(MODE === 'intro')
    }
  })

  // 给外部脚本（抓帧、回归）一个确定的驱动口：不走 UI、不排"忙"队列。
  window.__labPlay = (id, opts) => {
    const v = VARIANTS.find((x) => x.id === id)
    if (!v) return null
    current = v
    paintSide()
    stopPlay()
    return play(h, v, opts || { intro: false })
  }
  window.__labVariantIds = VARIANTS.map((v) => v.id)

  paintSide()
  replay(true)
})()
`

const BODY = `<h1>临时输入框 → 解读小窗 · 交接动效实验室</h1>
<p class="sub">
  场景：输入法开麦时弹出<b>临时输入框</b>（语音卡），说完发送 → <b>解读小窗</b>。现在这两步是<b>瞬切</b>
  （卡片 <code>display:none</code>、小窗 <code>display:flex</code>，中间零过渡），而且几何本身也换了：
  卡片 360 宽、<b>右缘</b>贴选区右缘；小窗 540 宽、<b>左缘</b>贴选区左缘 —— 所以看起来是"跳"。
  下面六个方案都按<b>真实样式</b>（CSS 直接从 lib/client.js 抽）与<b>真实几何</b>跑，可以逐个对比。
</p>
<div class="wrap">
  <div>
    <div class="lab-stage" id="stage" data-guides="0" data-scale="1">${DOC}${ACTORS(true)}</div>
    <div class="grid" id="grid" data-on="0"></div>
  </div>
  <aside>
    <div class="card">
      <h3>方案 <small>点一个即可重播</small></h3>
      <div id="variants"></div>
      <div class="btnrow">
        <button class="act primary" id="play">重播</button>
        <button class="act" id="solo">只看交接</button>
        <button class="act" id="loop" data-on="0">循环</button>
        <button class="act" id="mode" data-on="1">含前置（浮标→卡片→发送）</button>
      </div>
      <div class="switches">
        <label>速度
          <select id="speed" style="background:#1b2230;color:#e6edf3;border:1px solid #2a3038;border-radius:8px;padding:3px 6px;font:inherit">
            <option value="1">1×</option><option value="0.5">0.5×</option><option value="0.25">0.25× 慢放</option><option value="0.1">0.1× 极慢</option>
          </select>
        </label>
        <label><input type="checkbox" id="guides">几何参考线</label>
        <label><input type="checkbox" id="reduced">减少动效形态</label>
        <label><input type="checkbox" id="theme">深色宿主</label>
      </div>
      <div class="btnrow"><button class="act" id="grid-toggle" data-on="0">并排对比（六个一起播）</button></div>
    </div>
    <div class="card">
      <h3><span id="vname">—</span> <small>参数</small></h3>
      <p class="hint" id="vline" style="margin:0 0 6px"></p>
      <table class="spec"><tbody id="vspec"></tbody></table>
      <div class="verdict" id="vverdict"></div>
      <p class="hint">
        说明：卡片与发送键走的是<b>同一条</b>交接（手动点发送、说完自动发送，都进 <code>sendVCard()</code>），
        所以这套动画一处生效、两条路都受益。「减少动效形态」= 系统开了"减少动态效果"时各自的降级形态
        （插件里已有这条规矩：<code>prefers-reduced-motion</code> 下关掉形变与 CRT）。
      </p>
    </div>
  </aside>
</div>`

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>临时输入框 → 解读小窗 · 交接动效实验室</title>
<style>
${THEME_VARS}
${THEME_VARS_DARK}
${SHELL_CSS}
/* ── 以下为真实插件 CSS（从 lib/client.js 抽出，未手抄） ── */
${extractCss()}
</style>
</head>
<body>
${BODY}
<script>${'const STAGE_HTML = ' + JSON.stringify(DOC + ACTORS(true)) + ';\n'}${SCRIPT}</script>
</body>
</html>
`

mkdirSync(resolve(ROOT, 'docs'), { recursive: true })
const outPath = resolve(ROOT, 'docs', 'vcard-to-panel-lab.html')
writeFileSync(outPath, html, 'utf8')
console.log(`✓ docs/vcard-to-panel-lab.html  ${(html.length / 1024).toFixed(1)} kB`)
console.log(`  CSS 来源：lib/client.js（未手抄）；方案数：6`)
