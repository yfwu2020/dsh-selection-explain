/**
 * 生成 README 用的小窗演示页（docs/demo/*.html）。
 *
 * 目的：README 里的功能截图必须**和真实面板长得一样**，所以样式不能手抄 ——
 * 这里直接从 lib/client.js 里把模块级 `CSS` 常量抽出来注入演示页，
 * 类名 / 结构 / 文案也照 src/client/index.js 的渲染器与真实输出写。
 *
 * 用法：node scripts/build-demo-pages.mjs
 * 产物：docs/demo/stage1.html / stage2.html / code.html（再交给 Chrome 截图）
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
  // 元素是 '...' 单引号字符串字面量
  const parts = []
  const re = /'((?:[^'\\]|\\.)*)'/g
  let e
  while ((e = re.exec(m[1])) !== null) parts.push(e[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'))
  return parts.join('\n')
}

/** DSH 主题变量：用浅色主题的实际取值，让截图看起来像真的嵌在 DSH 里。 */
const THEME_VARS = `
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-label-primary: #1a1a1a;
  --dsw-alias-label-secondary: #6b7280;
  --dsw-alias-label-primary-foreground: #ffffff;
  --dsw-alias-interactive-bg-hover: rgba(140,140,140,.11);
  --dsw-alias-border-l3: rgba(140,140,140,.35);
  --dsw-alias-border-l4: rgba(140,140,140,.22);
  --dsw-alias-button-primary-fill: #3b6ef5;
  --sel-a1: #0d9488;
  --sel-a2: #0f766e;
`

const PAGE = (title, css, body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
  html,body{margin:0;padding:0;background:#eef1f4;font-family:-apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif}
  .demo-wrap{padding:26px 22px;display:flex;justify-content:center}
  ${THEME_VARS}
${css}
  /* 演示页专用：把浮层定位改成静态排版、并显示面板（真实面板默认 display:none，由 JS 打开） */
  .dsh-sel-layer{position:static !important;pointer-events:auto}
  .dsh-sel-panel{position:static !important;display:flex !important;max-height:none !important}
  .dsh-sel-panel[data-stage="translation"]{width:440px}
</style></head>
<body><div class="demo-wrap">${body}</div></body></html>
`

const panel = (stage, inner) => `<div class="dsh-sel-layer">
  <div class="dsh-sel-panel" data-stage="${stage}" data-theme="light" role="dialog" aria-label="划词解读">
    <div class="dsh-sel-head">
      <span class="dsh-sel-mark"></span>
      <span class="dsh-sel-title">划词解读</span>
      <span class="dsh-sel-headspace"></span>
      <button class="dsh-sel-action">🕘 最近</button>
      <button class="dsh-sel-action">↗ 升格</button>
      <button class="dsh-sel-icon" title="关闭">✕</button>
    </div>
    <div class="dsh-sel-body">
${inner}
    </div>
  </div>
</div>`

const quote = (text) => `      <div class="dsh-sel-quote">${text}</div>`

const section = (key, title, content) => `      <div class="dsh-sel-sec" data-sec="${key}">
        <div class="dsh-sel-sh"><i></i><span>${title}</span><span class="dsh-sel-hint"></span></div>
        <div class="dsh-sel-c">
${content}
        </div>
      </div>`

const p = (html) => `          <p>${html}</p>`
const list = (level, items) => `          <div class="dsh-sel-list" data-level="${level}">
${items.map((it) => `            <div class="dsh-sel-item"${it.num ? ' data-num="1"' : ''}><span class="dsh-sel-bullet">${it.bullet || '•'}</span><span>${it.text}</span></div>`).join('\n')}
          </div>`
const callout = (tag, text) => `          <div class="dsh-sel-callout"><span class="dsh-sel-callout-tag">${tag}</span>${text}</div>`

const expand = `      <button class="dsh-sel-expand"><span>↓ 展开详解</span></button>`

const askRow = (webOn) => `      <div class="dsh-sel-ask" style="display:flex">
        <textarea class="dsh-sel-askbox" rows="1" placeholder="就这段文字继续追问…（Enter 发送，Shift+Enter 换行）"></textarea>
        <span class="dsh-sel-asktools">
          <span class="dsh-sel-pref" data-on="${webOn ? '1' : '0'}">
            <span class="dsh-sel-preftext">输出偏好</span>
            <span class="dsh-sel-seg" role="radiogroup">
              <span class="dsh-sel-segopt" data-on="${webOn ? '0' : '1'}">文字</span>
              <span class="dsh-sel-segopt" data-on="${webOn ? '1' : '0'}">网页</span>
            </span>
          </span>
          <button class="dsh-sel-send" title="发送">↑</button>
        </span>
      </div>`

const chatBubble = (role, html) =>
  `        <div class="dsh-sel-bubble ${role === 'user' ? 'dsh-sel-bubble-user' : 'dsh-sel-bubble-bot'}">${html}</div>`

// ───────────────────────── 状态一：首轮只出翻译 ─────────────────────────
const stage1 = panel(
  'translation',
  [
    quote('the migration ran long'),
    section(
      'translation',
      '翻译',
      [
        p('这句话里需要翻译的是 <b>the migration ran long</b>：'),
        list(0, [{ text: '<b>migration</b> /maɪˈɡreɪʃn/ —— 迁移（把数据/服务从一处搬到另一处）' }]),
        list(0, [{ text: '<b>ran long</b> —— 跑得比预期久（ran = run 的过去式，long 指耗时超出预期）' }]),
        p('合起来：<b>迁移跑得比预期久</b>。'),
        callout('在本句中', '迁移作业耗时超出了原计划——这是在陈述进度延迟的事实，不含"失败了"的意思。'),
      ].join('\n'),
    ),
    expand,
  ].join('\n'),
)

// ───────────────────────── 状态二：展开详解 + 追问 ─────────────────────────
const stage2 = panel(
  'detail',
  [
    quote('the migration ran long'),
    section(
      'translation',
      '翻译',
      [
        p('这句话里需要翻译的是 <b>the migration ran long</b>：'),
        list(0, [{ text: '<b>migration</b> /maɪˈɡreɪʃn/ —— 迁移（把数据/服务从一处搬到另一处）' }]),
        list(0, [{ text: '<b>ran long</b> —— 跑得比预期久（ran = run 的过去式，long 指耗时超出预期）' }]),
        callout('在本句中', '迁移作业耗时超出了原计划——这是在陈述进度延迟的事实，不含"失败了"的意思。'),
      ].join('\n'),
    ),
    section(
      'detail',
      '详解',
      [
        p('这句话出自一句对话，是开发者在向 PM 说明<b>进度为什么需要重新安排</b>——它不是报错，而是在为后面的决定做铺垫。'),
        p('两个关键说法各指什么：'),
        list(0, [
          { text: '<b>migration</b>（迁移）：把数据或服务从旧结构搬到新结构的一次作业。在数据库语境里通常指改表结构、搬数据这类"不能中途停"的操作。' },
          { text: '<b>ran long</b>（跑久了）：完成时态，说的是这次已经发生的执行<b>耗时超过预期</b>，而不是"即将变慢"。' },
        ]),
        p('承接关系：既然迁移比预期久，后面的 <b>freeze features</b>（冻结功能开发）就不是随口一说，而是把人力腾出来的实际动作。'),
        callout('小结', '在说"迁移耗时超预期"，用来解释接下来的功能冻结——重点在<b>排期</b>，不在迁移本身的对错。'),
      ].join('\n'),
    ),
    `      <div class="dsh-sel-chatlog" style="display:flex">`,
    chatBubble('user', '那 freeze features 是指完全停止开发吗？'),
    chatBubble('assistant', '不是完全停止，而是<b>暂停新功能合入</b>：已有功能的修 bug 与收尾照常，只是不再往主干加新特性，好让迁移期间的分支收敛。'),
    '      </div>',
    askRow(false),
  ].join('\n'),
)

/** 代码块：真实渲染器逐行输出 `.dsh-sel-pre-line`，注释行带 data-wrap（可折行），代码行不折。 */
const codeBlock = (lines) => `          <pre class="dsh-sel-pre" data-hl="light">${lines
  .map((l) => `<div class="dsh-sel-pre-line"${l.wrap ? ' data-wrap="1"' : ''}>${l.wrap ? `<span class="dsh-sel-pre-cmt">${l.text}</span>` : l.text}</div>`)
  .join('')}</pre>`

// ───────────────────────── 状态三：选中代码 → 出注释 ─────────────────────────
const codeDemo = panel(
  'translation',
  [
    quote('function debounce(fn, wait) { … }'),
    section(
      'translation',
      '注释',
      [
        codeBlock([
          { wrap: true, text: '// 防抖：把连续触发压成「最后一次之后 wait 毫秒才真正执行」' },
          { text: 'function debounce(fn, wait) {' },
          { wrap: true, text: '  // 闭包变量：保存上一次的定时器，用来取消它' },
          { text: '  let timer = null' },
          { wrap: true, text: '  // 每次触发都先清掉上一个定时器，再重新计时' },
          { text: '  return function (...args) {' },
          { text: '    clearTimeout(timer)' },
          { wrap: true, text: '    // wait 毫秒内没有新触发，才执行原函数' },
          { text: '    timer = setTimeout(() =&gt; fn.apply(this, args), wait)' },
          { text: '  }' },
          { text: '}' },
        ]),
        callout('小结', '把高频触发收敛成一次执行——常用于搜索输入、窗口 resize 这类"只要最终结果"的场景。'),
      ].join('\n'),
    ),
  ].join('\n'),
)

const css = extractCss()
mkdirSync(resolve(ROOT, 'docs', 'demo'), { recursive: true })
const out = {
  'stage1.html': PAGE('划词解读 · 首轮翻译', css, stage1),
  'stage2.html': PAGE('划词解读 · 详解与追问', css, stage2),
  'code.html': PAGE('划词解读 · 代码注释', css, codeDemo),
}
for (const [name, html] of Object.entries(out)) {
  writeFileSync(resolve(ROOT, 'docs', 'demo', name), html, 'utf8')
  console.log(`✓ docs/demo/${name}  ${(html.length / 1024).toFixed(1)} kB`)
}
console.log(`\nCSS 来源：lib/client.js（${css.length} 字符，未手抄）`)
