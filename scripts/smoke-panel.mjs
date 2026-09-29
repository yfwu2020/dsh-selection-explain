/**
 * 小窗面板的**真浏览器**冒烟测试（无头 Chrome）。
 *
 * 为什么需要它：`test-client.mjs` 用的是手搓 DOM 桩，桩上"什么都对"但真实浏览器里
 * 连着踩过三次（都是它测不出来的那类问题）：
 *   ① `mouseup` 对面板内的目标直接 return —— 小窗里划词毫无反应（桩里 target 用的是 document.body）；
 *   ② 引用浮标的 z-index 比面板低 —— 浮标画在面板**底下**，看不见也点不着（桩里不跑层叠）；
 *   ③ 翻译 / 详解两节里划词取不到（桩里没覆盖"节"这条路径）。
 * 所以这里用真 DOM、真选区、真 MouseEvent、真层叠（`elementFromPoint`）跑一遍主要交互。
 *
 * 用法：node scripts/smoke-panel.mjs [lib/client.js 路径]
 *       CHROME=/path/to/chrome node scripts/smoke-panel.mjs
 * 退出码：全部 PASS = 0；找不到 Chrome 打印 SKIP 后退出 0（与 smoke-bridge 一致）。
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BUNDLE = process.argv[2] || resolve(ROOT, 'lib', 'client.js')

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  for (const item of candidates) if (existsSync(item)) return item
  return ''
}

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP  没找到 Chrome/Chromium（设 CHROME=/path/to/chrome 可指定）')
  process.exit(0)
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>panel smoke</title>
<style>html,body{margin:0;padding:0;background:#fff}
/* 给主界面留一块"正文"，用来验主界面划词那条路 */
#doc{padding:40px;font:14px/1.7 -apple-system,"PingFang SC",sans-serif}
</style></head>
<body>
<div id="doc"><p id="docp">Dev: the migration ran long, so we ship Wednesday.</p></div>
<div id="mount"></div>
<pre id="out">PENDING</pre>
<script>
// ── 自检结果收集 ──
var RESULTS = []
function check(name, ok, extra) { RESULTS.push({ name: name, ok: !!ok, extra: extra === undefined ? '' : String(extra).slice(0, 300) }) }
function finish() { document.getElementById('out').textContent = JSON.stringify(RESULTS) }
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
function waitFor(fn, ms) {
  var deadline = Date.now() + (ms || 3000)
  return new Promise(function (done) {
    ;(function tick() {
      var value
      try { value = fn() } catch (error) { value = false }
      if (value || Date.now() > deadline) return done(value)
      setTimeout(tick, 25)
    })()
  })
}

// ── 插件 bundle 需要的环境：ModuleLoader / React 垫片 / ctx ──
var captured = null
window.__ModuleLoader__ = { load: function (spec) { captured = spec } }
var React = {
  createElement: function (type, props) {
    var children = Array.prototype.slice.call(arguments, 2)
    var out = { type: type, props: Object.assign({}, props || {}) }
    if (children.length === 1) out.props.children = children[0]
    else if (children.length > 1) out.props.children = children
    return out
  },
}

var fixture = {
  translation: '## 翻译\\n第一段译文：the migration ran long——迁移跑得比预期久，可以被划词引用。\\n\\n> 在本句中：进度延迟。\\n',
  detail: '## 详解\\n详解第二段：这句话在排期上意味着顺延，也可以被划词引用。\\n',
  chat: '这是对追问的回答：冒烟用例。',
}
function sse(events) {
  var body = events.map(function (e) { return 'data: ' + JSON.stringify(e) + '\\n\\n' }).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
window.fetch = function (input, init) {
  var url = String(input)
  var body = {}
  try { body = init && init.body ? JSON.parse(String(init.body)) : {} } catch (error) { body = {} }
  if (url.indexOf('/selection-explain/api/ping') >= 0) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, route: { provider: 'fixture', model: 'fixture' }, reasoningEffortByStage: { translation: 'low', detail: 'high', chat: 'high' }, limits: {} }), { headers: { 'content-type': 'application/json' } }))
  }
  if (url.indexOf('/selection-explain/api/quote-context') >= 0) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, matched: true, context: '用户：上一问\\n助手：上一答\\n用户：【' + (body.text || '') + '】\\n助手：下一答', rounds: 2 }), { headers: { 'content-type': 'application/json' } }))
  }
  if (url.indexOf('/selection-explain/api/history') >= 0) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, entry: null, entries: [] }), { headers: { 'content-type': 'application/json' } }))
  }
  if (url.indexOf('/selection-explain/api/models') >= 0) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, current: null, stages: null, models: [] }), { headers: { 'content-type': 'application/json' } }))
  }
  if (url.indexOf('/selection-explain/api/analyze') >= 0) {
    if (body.question) return Promise.resolve(sse([{ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat' }, { type: 'delta', text: fixture.chat }, { type: 'done', chars: 8 }]))
    var fence = String.fromCharCode(96, 96, 96)
    var code = '## 注释\\n' + fence + 'js\\n// 注释：先声明常量\\nconst x = 1\\n' + fence + '\\n\\n> 小结：一句话说清。\\n'
    var text = body.kind === 'code' ? code : body.stage === 'detail' ? fixture.detail : fixture.translation
    return Promise.resolve(sse([{ type: 'start', provider: 'fixture', model: 'fixture', stage: body.stage || 'translation' }, { type: 'delta', text: text }, { type: 'done', chars: text.length }]))
  }
  return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }))
}

var disposers = []
var registration = null
var ctx = {
  logger: { info: function () {}, warn: function () {} },
  get: function () { return undefined },
  effect: function (fn) { var d = fn(); if (typeof d === 'function') disposers.push(d); return d },
  slots: {
    inject: function (key, callback) { var d = callback(); if (typeof d === 'function') disposers.push(d); return d },
    register: function (options, component) { registration = { options: options, component: component }; return function () {} },
  },
}

// ── 真选区 + 真事件 ──
</script>
<script src="/client.js"></script>
<script>
function selectIn(node, needle) {
  var text = node.textContent || ''
  var at = needle ? text.indexOf(needle) : 0
  if (at < 0) return null
  var len = needle ? needle.length : Math.min(6, text.length)
  var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null)
  var acc = 0, startNode = null, startOffset = 0, endNode = null, endOffset = 0, current
  while ((current = walker.nextNode())) {
    var next = acc + current.nodeValue.length
    if (startNode === null && at < next) { startNode = current; startOffset = at - acc }
    if (startNode !== null && at + len <= next) { endNode = current; endOffset = at + len - acc; break }
    acc = next
  }
  if (!startNode || !endNode) return null
  var range = document.createRange()
  range.setStart(startNode, Math.max(0, startOffset))
  range.setEnd(endNode, Math.max(0, endOffset))
  var sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  return range
}
function mouseUpOn(node) {
  node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
}
function clickOn(node) {
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
}
/**
 * 像用户那样点一下：mousedown → mouseup → click。
 * 只派发 click 是"程序化点击"，浏览器不会走聚焦/选区那套默认行为 ——
 * 而浮标靠 mousedown 的 preventDefault 保住选区，正是那条路要验。
 */
function realClick(node) {
  var opts = { bubbles: true, cancelable: true, view: window, detail: 1 }
  node.dispatchEvent(new MouseEvent("mousedown", opts))
  node.dispatchEvent(new MouseEvent("mouseup", opts))
  node.dispatchEvent(new MouseEvent("click", opts))
}
/**
 * 量几何之前先把过渡/动画冻住。
 *
 * 为什么必须冻：这个冒烟脚本跑在 --virtual-time-budget 下，定时器是虚拟时间（秒级飞快），
 * 但 **CSS 过渡的动画时钟不跟着走** —— 胶囊的宽度/位置过渡（.32s）会在"中间某一帧"被量到，
 * 于是"等了 420ms 还是量到起点值"。冻住之后量到的是终值，断言才是确定的；
 * "到底有没有动画"另外用 getComputedStyle 断言（transition-property 里有没有 max-width）。
 */
function freezeMotion() {
  if (document.getElementById('freeze-motion')) return
  var style = document.createElement('style')
  style.id = 'freeze-motion'
  style.textContent = '*{transition:none!important;animation:none!important}'
  document.head.appendChild(style)
}
/** 按**顶层**逗号切分 CSS 列表值：cubic-bezier(0.4, 0, 0.6, 1) 里面也有逗号，直接 split 会切碎。 */
function splitCssList(value) {
  var out = []
  var depth = 0
  var current = ''
  for (var i = 0; i < String(value).length; i += 1) {
    var ch = String(value)[i]
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) { out.push(current.trim()); current = '' } else { current += ch }
  }
  if (current.trim()) out.push(current.trim())
  return out
}
/** 浮标是不是**最上层**（z-index 低于面板时 elementFromPoint 会返回面板）。 */
function onTop(node) {
  var rect = node.getBoundingClientRect()
  if (!rect.width || !rect.height) return false
  var hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return hit === node || node.contains(hit)
}

async function main() {
  var mount = document.getElementById('mount')
  var hook = null
  try {
    var modules = captured.factory(function (name) { return name === 'react' ? React : {} })
    modules.apply(ctx)
    check('插件装载（槽注册 + apply）', !!registration && registration.options.id === '@yfwu2020/dsh-selection-explain', registration && registration.options.id)
    registration.component().props.ref(mount)
    hook = window.__dshSelectionExplain
    check('浮层挂进 mount', !!document.querySelector('.dsh-sel-layer'), '')
  } catch (error) {
    check('插件装载（槽注册 + apply）', false, error && error.message)
    finish()
    return
  }

  var panel = document.querySelector('.dsh-sel-panel')
  var quoteBtn = hook.quoteNode()
  var quotesBox = document.querySelector('.dsh-sel-quotes')

  function chipCount() { return hook.quotes().length }
  function dropQuotes() {
    var xs = quotesBox.querySelectorAll('.dsh-sel-quotechip-x')
    for (var i = xs.length - 1; i >= 0; i -= 1) clickOn(xs[i])
  }
  /** 等面板"安顿下来"（开窗自动聚焦那一下会清掉选区，等它过去再划）。 */
  async function settlePanel() {
    var box = document.querySelector(".dsh-sel-askbox")
    await waitFor(function () { return box && document.activeElement === box }, 800)
    await sleep(30)
  }
  /** 划一段 → 点引用 → 返回那一段引用（并清场）。find() 返回 { node, needle }。 */
  async function quoteOnce(label, find) {
    await settlePanel()
    var target = find()
    if (!target || !target.node) { check(label + '：找到目标节点', false, '未找到'); return null }
    var range = selectIn(target.node, target.needle)
    check(label + '：能建出真选区', !!range, range ? range.toString().slice(0, 24) : '未找到目标文字')
    if (!range) return null
    mouseUpOn(target.node)
    var shown = await waitFor(function () { return hook.quoteState().visible === true }, 1500)
    check(label + '：浮出「❝ 引用」', shown === true, JSON.stringify(hook.quoteState()))
    if (!shown) return null
    check(label + '：浮标在最上层（不被面板盖住）', onTop(quoteBtn), '')
    clickOn(quoteBtn)
    await sleep(40)
    var quotes = hook.quotes()
    var picked = quotes.length ? quotes[quotes.length - 1] : null
    check(label + '：进了引用区', chipCount() === 1 && !!picked, JSON.stringify(quotes.map(function (q) { return q.label + ':' + q.text.slice(0, 12) })))
    dropQuotes()
    await sleep(30)
    return picked
  }
  function sectionContent(key) {
    return document.querySelector('.dsh-sel-sec[data-sec="' + key + '"] .dsh-sel-c')
  }

  // ── 打开面板（fetch 桩给固定两节内容）──
  hook.open('冒烟探针', '上下文片段 ABC', '冒烟')
  await waitFor(function () { return hook.state().phase === 'done' }, 4000)
  check('首轮渲染完成', hook.state().phase === 'done', hook.state().phase)

  // ① 翻译节
  var picked1 = await quoteOnce('翻译节划词', function () {
    return { node: sectionContent('translation'), needle: '迁移跑得比预期久' }
  })
  var transTitle = document.querySelector('.dsh-sel-sec[data-sec="translation"] .dsh-sel-sh span')
  var transTitleText = transTitle ? transTitle.textContent : ''
  check(
    '翻译节的来源写明是哪一节（用该节自己的标题）',
    !!picked1 && !!transTitleText && picked1.label === '小窗「' + transTitleText + '」节',
    picked1 && picked1.label + ' vs ' + transTitleText,
  )

  // ② 结论条（.dsh-sel-callout，也在翻译节里）
  await quoteOnce('结论条划词', function () {
    return { node: document.querySelector('.dsh-sel-callout'), needle: '进度延迟' }
  })

  // ③ 展开详解 → 详解节
  hook.expand()
  await waitFor(function () { return (hook.parts().detail || '').length > 0 && hook.state().phase === 'done' }, 4000)
  check('详解节渲染出来了', !!sectionContent('detail'), '')
  var picked3 = await quoteOnce('详解节划词', function () {
    return { node: sectionContent('detail'), needle: '也可以被划词引用' }
  })
  check('详解节的来源写明是哪一节', !!picked3 && picked3.label.indexOf('详解') >= 0, picked3 && picked3.label)

  // ④ 跨节选择：从翻译节拖到详解节
  {
    var from = sectionContent('translation')
    var to = sectionContent('detail')
    var texts = []
    var walker = document.createTreeWalker(from, NodeFilter.SHOW_TEXT, null)
    var node
    while ((node = walker.nextNode())) if (node.nodeValue.trim()) texts.push(node)
    if (texts.length && to.firstChild) {
      var range = document.createRange()
      range.setStart(texts[0], 0)
      var endNode = to.firstChild.nodeType === 3 ? to.firstChild : to
      range.setEnd(endNode, Math.min(4, (endNode.nodeValue || '').length))
      var sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      mouseUpOn(to)
      var shown = await waitFor(function () { return hook.quoteState().visible === true }, 1500)
      check('跨节选择：也浮出「❝ 引用」', shown === true, JSON.stringify(hook.quoteState()))
      if (shown) {
        clickOn(quoteBtn)
        await sleep(40)
        check('跨节选择：进了引用区', chipCount() === 1, JSON.stringify(hook.quotes().map(function (q) { return q.text.length })))
        dropQuotes()
        await sleep(30)
      }
    } else {
      check('跨节选择：也浮出「❝ 引用」', false, '没找到可跨的文本节点')
    }
  }

  // ⑤ 面板**滚动之后**再划词（长内容 + 滚动是真实常态）
  {
    var body = document.querySelector('.dsh-sel-body')
    body.scrollTop = Math.min(120, Math.max(0, body.scrollHeight - body.clientHeight))
    await sleep(30)
    var picked5 = await quoteOnce('滚动后划翻译节', function () {
      return { node: sectionContent('translation'), needle: '迁移跑得比预期久' }
    })
    check('滚动之后划词照常能用', !!picked5, '')
  }

  // ⑥ 代码注释节（「## 注释」+ <pre>，划词落在 pre 里）
  {
    hook.close()
    hook.open('function add(a, b) { return a + b }', 'const x = 1', '代码块')
    await waitFor(function () { return hook.state().phase === 'done' }, 4000)
    var header = document.querySelector('.dsh-sel-sec[data-sec="translation"] .dsh-sel-sh')
    check('代码用例切到「注释」节', !!header && header.textContent.indexOf('注释') >= 0, header ? header.textContent : '未找到')
    await quoteOnce('代码块里划词', function () {
      return { node: document.querySelector('.dsh-sel-pre'), needle: 'const x' }
    })
  }

  // ⑦ 对话气泡（不带上下文，但要写清出处）
  {
    hook.close()
    hook.open('冒烟探针', '上下文片段 ABC', '冒烟')
    await waitFor(function () { return hook.state().phase === 'done' }, 4000)
    hook.ask('冒烟追问')
    await waitFor(function () { return hook.state().asking === false }, 4000)
    var bubbles = document.querySelectorAll('.dsh-sel-chatlog .dsh-sel-bubble-bot')
    var bot = bubbles[bubbles.length - 1]
    check('追问气泡渲染出来了', !!bot && bot.textContent.indexOf('冒烟用例') >= 0, bot ? bot.textContent.slice(0, 24) : '未找到')
    var picked7 = await quoteOnce('对话气泡划词', function () { return { node: bot, needle: '冒烟用例' } })
    check('对话引用写清了出处（第 N 轮 + 角色）', !!picked7 && /第 [0-9]+ 轮/.test(picked7.label), picked7 && picked7.label)
    check('对话引用不带上下文（小窗对话本来就在历史里）', !!picked7 && !picked7.context, picked7 && JSON.stringify(picked7.context))
    var all = bot.querySelector('.dsh-sel-bubquote')
    check('气泡末尾有「引用整条」', !!all, '')
    if (all) {
      clickOn(all)
      await sleep(40)
      var quoted = hook.quotes()
      var last = quoted.length ? quoted[quoted.length - 1] : null
      check('「引用整条」也不带上下文', !!last && !last.context, last && JSON.stringify(last.context))
      check('「引用整条」也写清出处', !!last && /第 [0-9]+ 轮/.test(last.label), last && last.label)
      dropQuotes()
      await sleep(30)
    }
  }

  // ⑧ 主界面划词（小窗开着）→ 会话里的引用（带 host 上下文）
  {
    var docp = document.getElementById('docp')
    var picked8 = await quoteOnce('主界面划词', function () { return { node: docp, needle: 'the migration ran long' } })
    check('主界面引用标成会话里的', !!picked8 && picked8.session === true, picked8 && String(picked8.session))
  }

  // ⑨ 点「✦ 解读」后立刻收掉本文档选区（用户报的：小窗亮起时旧选区又触发「❝ 引用」浮标）
  {
    hook.close()
    await sleep(80)
    var planBtn = document.querySelector('.dsh-sel-btn:not(.dsh-sel-quotebtn)')
    var docp2 = document.getElementById('docp')
    selectIn(docp2, 'the migration ran long')
    mouseUpOn(docp2)
    var planShown = await waitFor(function () {
      return planBtn && planBtn.style.display !== 'none' && planBtn.getBoundingClientRect().width > 0
    }, 1500)
    check('主界面划词：浮出「✦ 解读」', planShown === true, planBtn ? planBtn.style.display : '未找到按钮')
    if (planShown) {
      realClick(planBtn)
      // ⚠️ 这里**同步**检查，一下都不 await：开窗自动聚焦那一下是异步的（要等输入框可见），
      //    所以"选区这会儿已经没了"只可能是我们自己在点的时候清的 —— 它骗不过这一条。
      var live = window.getSelection()
      check(
        '点「解读」后选区立刻收掉（同步检查，不等聚焦那一下）',
        !!live && (live.rangeCount === 0 || live.isCollapsed === true),
        live ? 'rangeCount=' + live.rangeCount + ' collapsed=' + live.isCollapsed : 'null',
      )
      check('选区记录也一并作废（不再拿它当"当前选区"）', hook.selection() === null, JSON.stringify(hook.selection()))
      await sleep(120)
      check('旧选区没有让「❝ 引用」浮标复活', !onTop(quoteBtn), String(quoteBtn.style.display))
      // 用户报症状的那一步：小窗亮着时在输入框里按方向键（keyup 会触发一次选区检查）
      var askBox = document.querySelector('.dsh-sel-askbox')
      if (askBox) {
        askBox.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))
        await sleep(120)
        check('开窗后按方向键也不再冒出引用浮标', !onTop(quoteBtn), String(quoteBtn.style.display))
      }
      hook.close()
      await sleep(60)
    }
  }

  // ⑩ 浮标图标的**墨迹**要在画布里居中（用户报的："✦ 和 解读 好像没对齐，也没在按钮里居中"）
  //    为什么量 getBBox 而不是截图：浮动按钮是 align-items:center 的 flex，居中的是**画布盒子**，
  //    图形在画布里偏一点，图标就整体偏一点 —— 老星形路径 y 占 1.2~12.4（中心 6.8，不是 8），
  //    于是比右边「解读」两个字高 1.1px（8x 截图量出来的）。文字墨迹没法用 DOM 量，
  //    但"图标墨迹居中"这一条就足以拦住这类回归。
  {
    var icons = [
      ['解读浮标 ✦ 图标', document.querySelector('.dsh-sel-btn:not(.dsh-sel-quotebtn) svg')],
      ['引用浮标 ❝ 图标', quoteBtn.querySelector('svg')],
    ]
    for (var k = 0; k < icons.length; k += 1) {
      var svg = icons[k][1]
      // 浮标这会儿多半是隐藏的（display:none）—— 隐藏元素的 getBBox() 一律返回 0，
      // 所以量之前先临时摆出来，量完还原（不改它此刻的真实状态）。
      var btn = svg ? svg.closest('.dsh-sel-btn') : null
      var prev = btn ? btn.style.display : ''
      if (btn) btn.style.display = 'inline-flex'
      var box = svg ? svg.getBBox() : null
      if (btn) btn.style.display = prev
      var cx = box ? box.x + box.width / 2 : 0
      var cy = box ? box.y + box.height / 2 : 0
      check(
        icons[k][0] + '墨迹在 16×16 画布里居中',
        !!box && Math.abs(cx - 8) <= 0.25 && Math.abs(cy - 8) <= 0.25,
        box ? 'cx=' + cx.toFixed(2) + ' cy=' + cy.toFixed(2) : '未找到 svg',
      )
    }
  }

  // ⑪ 胶囊宽度：**有**费用胶囊就跟随它，**没有**就收到 PILL_FALLBACK_MAX = 200px（用户定的规则）
  //    这条只有真浏览器能量：要真布局（getBoundingClientRect）、真 CSS（max-width 生效），
  //    还要能挂一个假的 dsh-spend 挂载点。
  {
    var pillNode = hook.pill()
    var pillName = pillNode.querySelector('.dsh-sel-pillname')
    var pillMeta = pillNode.querySelector('.dsh-sel-pillmeta')
    var savedName = pillName.textContent
    var savedMeta = pillMeta.textContent
    // 先确认"动画是声明过的"（冻住之后就量不出来了）：收球/吸附靠 max-width / padding / gap / 位置的过渡
    var pillTrans = getComputedStyle(pillNode).transitionProperty
    check('胶囊声明了过渡（收球/吸附是动画，不是跳变）', /max-width/.test(pillTrans) && /padding/.test(pillTrans) && /left/.test(pillTrans), pillTrans)
    check('过渡只在"第一帧已经贴好位置"之后才打开（data-ready）', hook.pillState().ready === true, String(hook.pillState().ready))

    // 收 / 放**严格互逆**的结构前提：所有会变的属性共用同一条时长 + 同一条曲线，
    // 而且那条曲线必须时间对称（x1+x2=1 且 y1+y2=1 → 把动画倒过来放就是另一个方向）。
    // 之前用 easeOutQuint(.22,1,.36,1)：.22+.36≠1，两个方向前后半程不镜像 —— 用户报的"不对称"就是它。
    var durList = splitCssList(getComputedStyle(pillNode).transitionDuration)
    var easeList = splitCssList(getComputedStyle(pillNode).transitionTimingFunction)
    var morphDur = durList.slice(1) // 第 0 条是 box-shadow 的 .15s，不属于形变
    var morphEase = easeList.slice(1)
    check('收/放所有属性共用一条时长', morphDur.length > 0 && morphDur.every(function (x) { return x === morphDur[0] }), durList.join(' | '))
    check('收/放所有属性共用一条曲线', morphEase.length > 0 && morphEase.every(function (x) { return x === morphEase[0] }), easeList.join(' | '))
    // 不用正则：这段代码在模板字符串里，\( 这种转义会被吃掉（踩过）
    var easeText = morphEase[0] || ''
    var easeAt = easeText.indexOf('cubic-bezier(')
    var easeArgs = easeAt >= 0
      ? easeText.slice(easeAt + 'cubic-bezier('.length, -1).split(',').map(function (x) { return Number(x.trim()) })
      : []
    check(
      '曲线时间对称（x1+x2=1 且 y1+y2=1 → 倒放即另一个方向）',
      easeArgs.length === 4 && Math.abs(easeArgs[0] + easeArgs[2] - 1) < 1e-6 && Math.abs(easeArgs[1] + easeArgs[3] - 1) < 1e-6,
      easeText + ' → ' + JSON.stringify(easeArgs),
    )
    var nameDur = splitCssList(getComputedStyle(pillName).transitionDuration)[0]
    var starEl = pillNode.querySelector('.dsh-sel-pillstar')
    var starTrans = getComputedStyle(starEl)
    check('文字那格的时长和胶囊一致（不一致 → 中间帧宽度由另一条曲线决定）', nameDur === morphDur[0], nameDur + ' vs ' + morphDur[0])

    // ── 球心图形的形变轨迹（这一组是重点：光看两端点会漏掉中间帧的形状） ──
    // 曾经踩过的坑：用 CSS 的 transition:d 在两条静态 path 之间插值 —— CSS 只能线性插值，
    // 于是中途会经过一个正菱形（谷跟着尖一起动），读起来像方块；而且尖在 160ms 就停住、
    // 胶囊还要走到 280ms，"配合"就散了。所以现在路径由 JS 按 p 现算（两段 smoothstep）。
    check('球心图形不走 CSS 的 d 过渡（线性插值会经过正菱形）', starTrans.transitionProperty.trim() !== 'd', starTrans.transitionProperty.trim() || '(无过渡)')
    var radiiAt = function (p) {
      // 不写正则：模板字符串里反斜杠会被吃掉。按 M/L 切段再取两个数。
      var parts = String(hook.pillStarAt(p)).split('L')
      parts[0] = parts[0].charAt(0) === 'M' ? parts[0].slice(1) : parts[0]
      return parts.map(function (seg) {
        var z = seg.indexOf('Z')
        if (z >= 0) seg = seg.slice(0, z)
        var xy = seg.split(' ')
        return Math.sqrt(parseFloat(xy[0]) * parseFloat(xy[0]) + parseFloat(xy[1]) * parseFloat(xy[1]))
      })
    }
    var r0 = radiiAt(0)
    var r25 = radiiAt(0.25)
    var r50 = radiiAt(0.5)
    var r80 = radiiAt(0.8)
    var r100 = radiiAt(1)
    check('p=0：32 个顶点同半径 4.00（8px 圆点）', r0.length === 32 && r0.every(function (r) { return Math.abs(r - 4) < 0.02 }), r0.length + ' 顶点，半径 ' + r0[0].toFixed(3))
    check('p=0.25：谷仍停在 4.00（"两段"的签名 —— 线性插值会把它拉到 3.80，那就是菱形相）', Math.abs(r25[4] - 4) < 0.02, '谷 ' + r25[4].toFixed(3))
    check('p=0.25：尖已经在长（> 4 但远未到顶，尖先长）', r25[0] > 4.3 && r25[0] < r100[0] - 0.5, '尖 ' + r25[0].toFixed(3) + '（顶 ' + r100[0].toFixed(2) + '）')
    check('p=0.5：尖接近满长（≥ 顶-0.6），身刚开始收（谷仍 > 3.6）', r50[0] >= r100[0] - 0.6 && r50[4] > 3.6, '尖 ' + r50[0].toFixed(2) + ' / 谷 ' + r50[4].toFixed(2))
    // 同一个 p 下，从尖到谷的半径必须单调递减（尖 > 11.25° > 22.5° > 33.75° > 谷），
    // 且左右对称 —— 这就是"不出现波浪边"的可测形式。
    var sectorOk = function (r) {
      var k
      for (k = 0; k < 4; k += 1) if (r[k] < r[k + 1] - 0.02) return false
      for (k = 1; k < 16; k += 1) if (Math.abs(r[k] - r[32 - k]) > 0.02) return false
      return true
    }
    check('同一进度下：尖→谷单调递减且左右对称（没有波浪边）', sectorOk(r25) && sectorOk(r50) && sectorOk(radiiAt(0.8)), JSON.stringify(r50.map(function (r) { return Number(r.toFixed(2)) }).slice(0, 5)))
    // 形状空间的过冲：尖在 p≈0.8 处冲过终点一点，到 p=1 精确回到终点
    check('尖有轻微过冲（p=0.8 处高出终点一点，再收回）', r80[0] > r100[0] + 0.05, 'p=.8 尖 ' + r80[0].toFixed(3) + ' / p=1 尖 ' + r100[0].toFixed(3))
    check('p=1 的路径与客户端常量逐字相同（和「✦ 解读」那颗星同一条几何）', hook.pillStarAt(1) === hook.pillStarD(), hook.pillStarAt(1) === hook.pillStarD() ? '逐字一致' : '不一致')
    check('p=0 的路径与客户端常量逐字相同（展开态就是那枚 8px 圆点）', hook.pillStarAt(0) === hook.pillStarDotD(), hook.pillStarAt(0) === hook.pillStarDotD() ? '逐字一致' : '不一致')
    // 曲线：时间对称（倒放即另一个方向）+ 轻微蓄势/过冲（不直来直去）
    var xs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    var ys = xs.map(function (x) { return hook.pillStarEaseAt(x) })
    var symOk = xs.every(function (x) { return Math.abs(hook.pillStarEaseAt(x) + hook.pillStarEaseAt(1 - x) - 1) < 1e-6 })
    check('球心图形的曲线时间对称（收/放互为倒放）', symOk, ys.map(function (y) { return y.toFixed(3) }).join(' '))
    // 曲线本身要"干净"（单调 S，不能是波浪）：过冲放在形状空间，不放在时间轴上
    var monotone = true
    for (var mi = 1; mi < xs.length; mi += 1) if (hook.pillStarEaseAt(xs[mi]) <= hook.pillStarEaseAt(xs[mi - 1])) monotone = false
    check('时间轴上的曲线是干净单调的 S（过冲不放在这里 —— 对称曲线的过冲必成波浪）', monotone && ys[0] > 0 && ys[ys.length - 1] < 1, ys.map(function (y) { return y.toFixed(3) }).join(' '))
    check('JS 那条时长与 CSS 那条同拍（280ms ↔ .28s）', hook.pillMorphMs() === 280 && morphDur[0] === '0.28s', hook.pillMorphMs() + 'ms vs ' + morphDur[0])
    freezeMotion()
    // 最坏内容（选中文字 12 字 + 最长状态）：自然宽度 301px，最容易被上限拦到
    pillName.textContent = '迁移作业耗时超出了原计划…'
    pillMeta.textContent = '· 追问中 12.3s'

    // ① 没有费用胶囊 → 兜底上限 200
    hook.place()
    check('没有费用胶囊：上限收到 200px', pillNode.style.maxWidth === '200px', pillNode.style.maxWidth || '(空 = 回落 CSS 280)')
    check('没有费用胶囊：不写死宽度（内容自适应）', pillNode.style.width === '', pillNode.style.width || '(空)')
    var cappedWidth = Math.round(pillNode.getBoundingClientRect().width)
    check('没有费用胶囊：最坏内容也真的被拦在 200px', cappedWidth === 200, cappedWidth + 'px')
    check('没有费用胶囊：拦到上限后选中文字走省略号（不撑破）', pillName.scrollWidth > pillName.clientWidth, pillName.clientWidth + 'px 可见 / ' + pillName.scrollWidth + 'px 全长')

    // ② 挂一个假的费用胶囊（宽 240）→ 跟随它的实测宽度，并清掉兜底上限
    var fakeSpend = document.createElement('div')
    fakeSpend.id = 'dsh-spend-widget'
    fakeSpend.innerHTML = '<div class="dsu-widget" style="position:fixed;right:20px;bottom:20px">'
      + '<div class="dsu-pill" style="box-sizing:border-box;width:240px;height:32px"></div></div>'
    document.body.appendChild(fakeSpend)
    hook.place()
    check('有费用胶囊：宽度写死成它的实测宽度', pillNode.style.width === '240px', pillNode.style.width || '(空)')
    check('有费用胶囊：清掉兜底上限（回到 CSS 280，和它同宽）', pillNode.style.maxWidth === '', pillNode.style.maxWidth || '(空)')
    // ⚠️ 宽度现在有过渡（.32s）：改完立刻量会量到**起点**，得等它走完
    await sleep(420)
    var followedWidth = Math.round(pillNode.getBoundingClientRect().width)
    check('有费用胶囊：最坏内容跟着它到 240px（上限确实放开了）', followedWidth === 240, followedWidth + 'px')

    // ③ 费用胶囊消失 → 立刻回到兜底
    fakeSpend.remove()
    hook.place()
    check(
      '费用胶囊消失后又回到 200px 兜底',
      pillNode.style.maxWidth === '200px' && pillNode.style.width === '',
      pillNode.style.maxWidth + ' / ' + (pillNode.style.width || '宽=空'),
    )
    // ⚠️ 这里必须把"最坏内容"重新写一遍再量：paintPill() 会在异步里把文案换回**真实内容**
    //    （真实内容自然宽 184px < 200，于是量到 184 而不是 200）—— 这条断言想验的是
    //    "上限回到 200"，不是"内容恰好 301px"，写回最坏内容才与内容变化解耦（否则偶发红）。
    pillName.textContent = '迁移作业耗时超出了原计划…'
    pillMeta.textContent = '· 追问中 12.3s'
    await sleep(420)
    check('回到兜底后宽度也收回来了', Math.round(pillNode.getBoundingClientRect().width) === 200, Math.round(pillNode.getBoundingClientRect().width) + 'px')

    // 还原内容（后面的断言不受影响）
    pillName.textContent = savedName
    pillMeta.textContent = savedMeta
    hook.place()
  }

  // ⑫ 胶囊可以拖：拖到别处就留在那儿；拖回右下角附近自动吸附回去；拖完那一下不算点击。
  //    全用真鼠标事件（mousedown 打在胶囊上，mousemove/mouseup 打在 window —— 和面板拖动同一套）。
  //    过渡已在 ⑪ 冻住（见 freezeMotion），所以每一步都能**同步**断言，不用等动画。
  {
    var pillEl = hook.pill()
    var panelOpen = function () {
      return hook.quoteState().panelOpen === true
    }
    function fire(type, x, y, onWindow) {
      var event = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 })
      if (onWindow) window.dispatchEvent(event)
      else pillEl.dispatchEvent(event)
    }
    function dragTo(x, y) {
      var rect = pillEl.getBoundingClientRect()
      fire('mousedown', Math.round(rect.left) + 20, Math.round(rect.top) + 10, false)
      fire('mousemove', x, y, true)
      fire('mousemove', x + 4, y + 2, true) // 第二下：确保"位移超过阈值"这条判定走完
      fire('mouseup', x + 4, y + 2, true)
    }
    /** 拖到右下角那一带（吸附区）—— 用视口右下角算，和"贴角位置"差得不多，必落在吸附半径里。 */
    function dragToCorner() {
      dragTo(Math.round(window.innerWidth - 30), Math.round(window.innerHeight - 30))
    }

    hook.place()
    var home = hook.pillState()
    check('起始：贴着右下角（dock=anchor，right/bottom=20）', home.dock === 'anchor' && home.rect.right === 20 && home.rect.bottom === 20, home.dock + ' ' + home.rect.right + '/' + home.rect.bottom)

    // ① 拖到屏幕中间 → 留在那儿（自由摆放）
    var midX = Math.round(window.innerWidth / 2)
    var midY = Math.round(window.innerHeight / 2)
    dragTo(midX, midY)
    var free = hook.pillState()
    check('拖到屏幕中间：位置跟着走了（dock=free）', free.dock === 'free', free.dock)
    check('拖到屏幕中间：落在松手的地方（±40px）', Math.abs(free.rect.left + 20 - midX) < 40 && Math.abs(free.rect.top + 10 - midY) < 40, free.rect.left + ',' + free.rect.top)

    // 自由摆放时，贴角轮询不许把它拽回去
    hook.place()
    var stillFree = hook.pillState()
    check('自由摆放时轮询不把它拽回去', stillFree.dock === 'free' && Math.abs(stillFree.rect.left - free.rect.left) <= 2, stillFree.dock + ' ' + stillFree.rect.left)

    // ② 拖回右下角附近 → 自动吸附回贴角位置（没有费用胶囊就是 20/20）
    dragToCorner()
    var snapped = hook.pillState()
    check('拖回右下角附近：自动吸附（dock=anchor）', snapped.dock === 'anchor', snapped.dock)
    check('吸附回右下角 20/20', snapped.rect.right === 20 && snapped.rect.bottom === 20, snapped.rect.right + '/' + snapped.rect.bottom)

    // ③ 拖完浏览器会补一个 click —— 不能被当成"点了一下"（否则会顺手开关小窗）
    if (panelOpen()) hook.close()
    dragTo(midX, midY)
    fire('click', midX, midY, false) // 模拟浏览器在拖完之后补的那一下
    check('拖完那一下不算点击（小窗没被打开）', panelOpen() === false, String(panelOpen()))
    check('拖完那一下也不算"点开"（胶囊还在自由摆放位）', hook.pillState().dock === 'free', hook.pillState().dock)

    // ④ 有费用胶囊时：拖到右下角附近 → 吸附到"跟随它的位置"（在那枚胶囊上方、同宽）
    var fakeSpend2 = document.createElement('div')
    fakeSpend2.id = 'dsh-spend-widget'
    fakeSpend2.innerHTML = '<div class="dsu-widget" style="position:fixed;right:20px;bottom:20px">'
      + '<div class="dsu-pill" style="box-sizing:border-box;width:240px;height:32px"></div></div>'
    document.body.appendChild(fakeSpend2)
    hook.place()
    dragToCorner()
    var withSpend = hook.pillState()
    check('有费用胶囊时拖到右下角：吸附到跟随它的位置', withSpend.dock === 'anchor' && withSpend.rect.right === 20, withSpend.dock + ' right=' + withSpend.rect.right)
    check('吸附后宽度是跟随它的 240px', withSpend.rect.width === 240, withSpend.rect.width + 'px')
    check('吸附位置在费用胶囊**上方**（不压住它）', withSpend.rect.bottom >= 42, 'bottom=' + withSpend.rect.bottom)

    // 再拖走 → 留在那儿；再拖回 → 又吸附回去
    dragTo(midX, midY)
    check('有费用胶囊时也能拖走（dock=free）', hook.pillState().dock === 'free', hook.pillState().dock)
    dragToCorner()
    var backHome = hook.pillState()
    check('再拖回右下角：又吸附回去', backHome.dock === 'anchor' && backHome.rect.right === 20, backHome.dock + ' right=' + backHome.rect.right)
    fakeSpend2.remove()
    hook.place()

    // ⑤ 没动的那一下仍然是"点击"（拖动不能把点击吃掉）
    if (panelOpen()) hook.close()
    var clickRect = pillEl.getBoundingClientRect()
    fire('mousedown', Math.round(clickRect.left) + 20, Math.round(clickRect.top) + 10, false)
    fire('mouseup', Math.round(clickRect.left) + 20, Math.round(clickRect.top) + 10, true)
    fire('click', Math.round(clickRect.left) + 20, Math.round(clickRect.top) + 10, false)
    await sleep(160)
    check('没位移的那一下照旧是点击（小窗打开了）', panelOpen() === true, String(panelOpen()))
    hook.close()
    // 关小窗会让面板尺寸变 0 → 面板那个 ResizeObserver 会补一次 placePanel→paintPill（= 一次"活动"）。
    // 生产上无所谓（只是把静置计时重新拨满），测试里得先把这拍异步排掉，否则会和下面的收球抢时序。
    await sleep(200)
  }

  // ⑬ 静置收球：**没有费用胶囊**时收成小球；有费用胶囊 / 小窗开着 / 鼠标停着都不收。
  //    过渡已冻住，所以"收成 32×32"是同步可断言的；"到底有没有过渡"在 ⑪ 用 computed style 断言过。
  {
    var pillBall = hook.pill()
    var panelIsOpen = function () {
      return hook.quoteState().panelOpen === true
    }
    if (panelIsOpen()) hook.close()
    await sleep(200)
    var before = hook.pillState()
    check('收球前是展开的胶囊', before.ball === false && before.rect.width > 100, before.rect.width + 'px')

    var anchoredRightBefore = window.innerWidth - before.rect.right
    var idleCollapsed = hook.pillIdle()
    var balled = hook.pillState()
    check('没有费用胶囊 → 静置收球', idleCollapsed === true && balled.ball === true, JSON.stringify(balled.style))
    check('收成小球：32×32 的圆', balled.rect.width === balled.ballSize && balled.rect.height === balled.ballSize, balled.rect.width + '×' + balled.rect.height)
    check('小球仍然贴着右下角（位置没跑）', balled.rect.right === 20 && balled.rect.bottom === 20, balled.rect.right + '/' + balled.rect.bottom)
    check(
      '锚定态收球：以胶囊自己的右边缘为锚（右边缘不动，往左收成球）',
      Math.abs((window.innerWidth - balled.rect.right) - anchoredRightBefore) <= 1,
      '右边缘 ' + anchoredRightBefore.toFixed(1) + ' → ' + (window.innerWidth - balled.rect.right).toFixed(1),
    )

    // ── 球心里的星芒：收球时 d 换成星、展开时换回圆点，几何都得对得上 ──
    //    球心图形是 JS 按时间推进的（胶囊那条是 CSS 过渡，被 freezeMotion 冻成瞬时），
    //    所以分三件事验：① 目标对不对（同步）② 计时器真的在推进（短等几拍）③ 终态几何（同步画到终点再量）。
    //    ⚠️ 不能靠"等 280ms 再看"：这段时间里任何一次活动（比如首轮解读流式结束后的 paintPill）
    //       都会按设计把球展开回胶囊，等出来的就不是球态了。
    var starCanvas = pillBall.querySelector('.dsh-sel-pillicon')
    var starPath = pillBall.querySelector('.dsh-sel-pillstar')
    var starWant = hook.pillStarD()
    var dotWant = hook.pillStarDotD()
    check('收球时球心图形的目标是"星芒"（1）', hook.pillStarTarget() === 1, String(hook.pillStarTarget()))
    // "计时器真的在推进"用解耦的钩子验（不依赖胶囊此刻是不是球态 ——
    //  首轮解读收尾时 paintPill→notePillActivity 会按设计把球展开，和这条无关）
    hook.pillStarAnimate(0)
    var pAtStart = hook.pillStarProgress()
    hook.pillStarAnimate(1)
    var grew = false
    for (var tick = 0; tick < 12 && !grew; tick += 1) {
      await sleep(24)
      if (hook.pillStarProgress() > pAtStart + 0.05) grew = true
    }
    check('球心图形的动画真的在推进（计时器在跑，不是画一帧就停）', grew, pAtStart.toFixed(3) + ' → ' + hook.pillStarProgress().toFixed(3))
    // 球态的画布居中：这是 CSS 那边的事（margin 过渡），冻住运动后是瞬时终值，可以同步量。
    // ⚠️ 先显式确保还在球态：上面的等待里任何一次活动都会按设计把球展开。
    if (hook.pillState().ball !== true) {
      hook.pillIdle()
      await sleep(80)
    }
    check('（前置）此刻确实是球态，下面量的是球心几何', hook.pillState().ball === true, String(hook.pillState().ball))
    var ballRect = pillBall.getBoundingClientRect()
    var canvasRect = starCanvas.getBoundingClientRect()
    check(
      '星芒在球里居中（图形中心 = 球的中心，±0.6px）',
      Math.abs(canvasRect.left + canvasRect.width / 2 - (ballRect.left + ballRect.width / 2)) <= 0.6,
      '画布中心 ' + (canvasRect.left + canvasRect.width / 2).toFixed(1) + ' vs 球中心 ' + (ballRect.left + ballRect.width / 2).toFixed(1),
    )
    check('球态画布用 -1px 负边距摆正（内宽 32-2 边框 = 30）', getComputedStyle(starCanvas).marginLeft === '-1px', getComputedStyle(starCanvas).marginLeft)
    // 同步画到终点，再量终态几何（不受计时器与异步活动影响）
    hook.pillStarTo(1)
    var starD = starPath.getAttribute('d')
    var starBox = starPath.getBBox()
    check('收球终态：d 与客户端那条常量逐字相同', starD === starWant, starD === starWant ? '32 顶点一致' : starD.slice(0, 18) + '… ≠ ' + starWant.slice(0, 18))
    var pillFontSize = parseFloat(getComputedStyle(pillBall).fontSize)
    check(
      '星芒和胶囊里的文字一样高（墨迹 ≈ 字号，±0.8px）',
      Math.abs(starBox.height - pillFontSize) <= 1.0 && Math.abs(starBox.width - starBox.height) < 0.15,
      '星芒 ' + starBox.width.toFixed(2) + '×' + starBox.height.toFixed(2) + ' vs 字号 ' + pillFontSize + 'px',
    )
    check(
      '星芒的内外半径比 = .3788（和「✦ 解读」浮标那颗星同一条几何，只是缩小了）+ 顶点数 32',
      Math.abs(r100[0] / r100[4] - 1 / 0.3788) < 0.05 && r100.length === 32,
      '尖 ' + r100[0].toFixed(2) + ' / 谷 ' + r100[4].toFixed(2) + ' = ' + (r100[0] / r100[4]).toFixed(3) + '（应为 2.640）',
    )

    // 鼠标一放上去就展开（若已被异步活动展开过，先收回球态，好让 mouseenter 真的走一次展开）
    if (hook.pillState().ball !== true) {
      hook.pillIdle()
      await sleep(80)
    }
    pillBall.dispatchEvent(new MouseEvent('mouseenter', { view: window }))
    var expanded = hook.pillState()
    check('鼠标移上去：小球展开回胶囊', expanded.ball === false && expanded.rect.width > 100, expanded.rect.width + 'px')
    check(
      '锚定态展开：右边缘同样不动（往右长回去）',
      Math.abs((window.innerWidth - expanded.rect.right) - anchoredRightBefore) <= 1,
      '右边缘 ' + anchoredRightBefore.toFixed(1) + ' → ' + (window.innerWidth - expanded.rect.right).toFixed(1),
    )
    // 展开态：图形回到 8px 圆点，且画布**布局占位**仍是 8px（两侧 -12px）——
    // 这样胶囊的排版与宽度和以前那枚 8px 圆点完全一样，不会因为换了个 SVG 就把胶囊撑宽。
    check('展开时球心图形的目标是"圆点"（0）', hook.pillStarTarget() === 0, String(hook.pillStarTarget()))
    // 真实悬停路径：展开会重置静置计时，不能因此取消球心图形的动画。
    pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }))
    if (hook.pillState().ball !== true) hook.pillIdle()
    hook.pillStarTo(1)
    pillBall.dispatchEvent(new MouseEvent('mouseenter', { view: window }))
    await sleep(350)
    check(
      '悬停展开后星芒自行回到圆点',
      hook.pillState().ball === false && hook.pillStarProgress() === 0 && starPath.getAttribute('d') === dotWant,
      'ball=' + hook.pillState().ball + ' progress=' + hook.pillStarProgress(),
    )
    hook.pillStarTo(0) // 同步画回圆点，量终态
    var dotD = pillBall.querySelector('.dsh-sel-pillstar').getAttribute('d')
    var dotBox = pillBall.querySelector('.dsh-sel-pillstar').getBBox()
    var iconCanvas = pillBall.querySelector('.dsh-sel-pillicon')
    var iconStyle = getComputedStyle(iconCanvas)
    var pillRectForDot = pillBall.getBoundingClientRect()
    var canvasForDot = iconCanvas.getBoundingClientRect()
    var dotRect = starPath.getBoundingClientRect()
    var dotCx = dotRect.left + dotRect.width / 2
    var dotCy = dotRect.top + dotRect.height / 2
    var canvasCx = canvasForDot.left + canvasForDot.width / 2
    var pillCy = pillRectForDot.top + pillRectForDot.height / 2
    check(
      '展开后圆点墨迹居中：横向在 SVG 画布中心，纵向在胶囊中心',
      Math.abs(dotCx - canvasCx) < 0.25 && Math.abs(dotCy - pillCy) < 0.25,
      '偏移 x=' + (dotCx - canvasCx).toFixed(2) + ' y=' + (dotCy - pillCy).toFixed(2),
    )
    check('展开后回到圆点态：d 与客户端那条常量**逐字相同**', dotD === dotWant, dotD === dotWant ? '32 顶点一致' : dotD.slice(0, 14) + '… ≠ ' + dotWant.slice(0, 14))
    // 这条是补覆盖：上面用 pillStarTo(0) 同步画到终点，验的是"终点长什么样"，
    // 但"展开这条动画**自己**会不会走到终点"没验过 —— 用户报的"展开后没恢复成圆点"正是这里。
    hook.pillStarAnimate(1)
    await sleep(60)
    hook.pillStarAnimate(0)
    var settled = false
    for (var settleTick = 0; settleTick < 24 && !settled; settleTick += 1) {
      await sleep(24)
      if (hook.pillStarProgress() === 0) settled = true
    }
    check('展开动画自己会走到圆点（不是停在星芒上）', settled, 'progress=' + hook.pillStarProgress())

    // 用户报的"展开后没恢复成圆点"，根因是**打断**：来回打断时每一段都跑满 280ms，
    // 于是图形永远追不上目标（实测序列 10101010、进度卡在 0.158）。
    // 这里用高频交替打断复现它，然后断言"停手之后能很快落到目标上"。
    // （比"等悬停那一下走完"稳：冒烟跑在虚拟时钟下，10 秒静置会瞬间到期、球态随时可能翻。）
    hook.pillStarAnimate(0)
    for (var ham = 0; ham < 8; ham += 1) {
      hook.pillStarAnimate(1)
      await sleep(16)
      hook.pillStarAnimate(0)
      await sleep(16)
    }
    var settleTicks = -1
    for (var st = 0; st < 40 && settleTicks < 0; st += 1) {
      await sleep(24)
      if (hook.pillStarProgress() === 0) settleTicks = st + 1
    }
    check(
      '来回打断之后图形仍会落到目标上，且很快（不再卡在半路）',
      settleTicks > 0 && settleTicks <= 6,
      '停手后第 ' + settleTicks + ' 拍到位（每拍 24ms）· progress=' + hook.pillStarProgress() + ' · 起跑=' + hook.pillStarStarts(),
    )
    pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }))
    check('圆点态墨迹 8×8（和以前那枚 8px 圆点一致）', Math.abs(dotBox.width - 8) < 0.1 && Math.abs(dotBox.height - 8) < 0.1, dotBox.width.toFixed(2) + '×' + dotBox.height.toFixed(2))
    check('展开态画布布局占位 = 8px（两侧 -12px 负边距）', iconStyle.marginLeft === '-12px' && iconStyle.marginRight === '-12px', iconStyle.marginLeft + '/' + iconStyle.marginRight)
    check('展开态画布本身仍是 32px（1 单位 = 1px，几何数字照抄设计稿）', iconStyle.width === '32px' && iconStyle.height === '32px', iconStyle.width + '×' + iconStyle.height)
    check('展开后还是贴右下角', expanded.rect.right === 20 && expanded.rect.bottom === 20, expanded.rect.right + '/' + expanded.rect.bottom)

    // 鼠标离开 → 又能收
    pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }))
    check('鼠标离开后静置又能收球', hook.pillIdle() === true && hook.pillState().ball === true, String(hook.pillState().ball))

    // 鼠标停在上面时不许收（"点得到"优先于"藏起来"）
    pillBall.dispatchEvent(new MouseEvent('mouseenter', { view: window }))
    check('鼠标停在小球上时不收球', hook.pillIdle() === false && hook.pillState().ball === false, String(hook.pillState().ball))
    pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }))

    // 自由摆放时收球/展开都以**右边缘**为锚（往左收成球、往右展开回原样，右边缘一个像素都不动）
    // 这条只有真浏览器能验：要真布局量矩形、真过渡（这里已冻住 → 量到的是终值）。
    {
      var homeRect = hook.pillState().rect
      hook.pillIdle() // 先收起来（锚定态）
      var anchored = hook.pillState()
      var midX2 = Math.round(window.innerWidth / 2)
      var midY2 = Math.round(window.innerHeight / 2)
      pillBall.dispatchEvent(new MouseEvent('mouseenter', { view: window })) // 展开再拖（拖的是展开态）
      pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }))
      var r0 = pillBall.getBoundingClientRect()
      var fireOn = function (type, x, y, onWindow) {
        var event = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 })
        if (onWindow) window.dispatchEvent(event)
        else pillBall.dispatchEvent(event)
      }
      fireOn('mousedown', Math.round(r0.left) + 20, Math.round(r0.top) + 10, false)
      fireOn('mousemove', midX2, midY2, true)
      fireOn('mousemove', midX2 + 4, midY2 + 2, true)
      fireOn('mouseup', midX2 + 4, midY2 + 2, true)
      var wideFree = hook.pillState()
      check('自由摆放（拖到中间）', wideFree.dock === 'free' && wideFree.rect.width > 100, wideFree.dock + ' ' + wideFree.rect.width)
      check(
        '自由摆放使用固定的 CSS right 定位，使过渡每一帧都能守住右边缘',
        wideFree.style.left === 'auto' && wideFree.style.right !== 'auto' && wideFree.style.right !== '',
        'left=' + wideFree.style.left + ' right=' + wideFree.style.right,
      )
      var rightBefore = wideFree.rect.right
      hook.pillIdle()
      var ballFree = hook.pillState()
      check('自由摆放时收球：右边缘不动（±1px，往左收成球）', ballFree.ball === true && Math.abs(ballFree.rect.right - rightBefore) <= 1, '右边缘 ' + rightBefore.toFixed(1) + ' → ' + ballFree.rect.right.toFixed(1))
      var geoRightBefore = window.innerWidth - rightBefore
      var geoRightBall = window.innerWidth - ballFree.rect.right
      check('自由摆放时收球：球确实贴到了右边缘（球右边 = 原胶囊右边，球宽 32）', Math.abs(geoRightBall - geoRightBefore) <= 1 && ballFree.rect.width === ballFree.ballSize, '几何右边 ' + geoRightBefore.toFixed(1) + ' → ' + geoRightBall.toFixed(1) + '，球宽 ' + ballFree.rect.width)
      pillBall.dispatchEvent(new MouseEvent('mouseenter', { view: window }))
      var wideAgain = hook.pillState()
      check('自由摆放时展开：右边缘也不动（±1px）', wideAgain.ball === false && Math.abs(wideAgain.rect.right - rightBefore) <= 1, '右边缘 ' + rightBefore.toFixed(1) + ' → ' + wideAgain.rect.right.toFixed(1))
      pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }))
      // 拖回右下角，后面的断言接着用锚定态
      var frozenStyle = document.getElementById('freeze-motion')
      fireOn('mousedown', Math.round(pillBall.getBoundingClientRect().left) + 20, Math.round(pillBall.getBoundingClientRect().top) + 10, false)
      fireOn('mousemove', Math.round(window.innerWidth - 30), Math.round(window.innerHeight - 30), true)
      frozenStyle.remove() // 拖动中 data-drag 会关过渡，此时解除全局冻结，不会让胶囊跳
      fireOn('mouseup', Math.round(window.innerWidth - 30), Math.round(window.innerHeight - 30), true)
      var snapAnimated = pillBall.getAnimations().some(function (animation) { return animation.transitionProperty === 'left' })
      check('自由摆放从 CSS right 切回吸附时仍有滑行动画', snapAnimated, String(snapAnimated))
      document.head.appendChild(frozenStyle)
      check('拖回右下角后又吸附（回到 anchor）', hook.pillState().dock === 'anchor', JSON.stringify(hook.pillState()))
      check('锚定位置和最初一致', Math.abs(hook.pillState().rect.left - homeRect.left) <= 2, hook.pillState().rect.left + ' vs ' + homeRect.left)
      void anchored
    }

    // 有费用胶囊时不收球（收球的前提是"没有可跟随的胶囊"）
    var fakeSpend3 = document.createElement('div')
    fakeSpend3.id = 'dsh-spend-widget'
    fakeSpend3.innerHTML = '<div class="dsu-widget" style="position:fixed;right:20px;bottom:20px">'
      + '<div class="dsu-pill" style="box-sizing:border-box;width:240px;height:32px"></div></div>'
    document.body.appendChild(fakeSpend3)
    hook.place()
    check('有费用胶囊时静置也不收球', hook.pillIdle() === false, String(hook.pillState().ball))
    check('有费用胶囊时保持展开', hook.pillState().ball === false, String(hook.pillState().ball))

    // 收着球时费用胶囊出现 → 立刻展开（球没有存在的意义了）
    fakeSpend3.remove()
    hook.place()
    check('静置收球后费用胶囊出现 → 立刻展开', hook.pillIdle() === true && hook.pillState().ball === true, String(hook.pillState().ball))
    document.body.appendChild(fakeSpend3)
    hook.place()
    check('费用胶囊一出现，小球立刻展开', hook.pillState().ball === false && hook.pillState().rect.width === 240, hook.pillState().ball + ' ' + hook.pillState().rect.width)
    fakeSpend3.remove()
    hook.place()

    // 小窗开着时不收球（"小窗活动"也是活动）
    hook.open('收球冒烟：小窗开着', '上下文', '冒烟')
    await sleep(200)
    check('小窗开着时不收球', hook.pillIdle() === false, String(hook.pillState().ball))
    hook.close()
    await sleep(200)
    check('小窗关掉后又能收球', hook.pillIdle() === true && hook.pillState().ball === true, String(hook.pillState().ball))

    // 收着球也能点开（小球仍然是个按钮）
    var ballRect = pillBall.getBoundingClientRect()
    var bx = Math.round(ballRect.left) + 16
    var by = Math.round(ballRect.top) + 16
    pillBall.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: bx, clientY: by, button: 0 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: bx, clientY: by, button: 0 }))
    pillBall.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: bx, clientY: by }))
    await sleep(200)
    check('小球状态点一下照样打开小窗', panelIsOpen() === true, String(panelIsOpen()))
    hook.close()
    await sleep(120)
  }

  // 可选截图模式（?shot=1）：把两个**终态**摆出来（展开=圆点 / 收球=星芒），
  // 真实大小各一份 + 几何各一份放大，给人工核对，也给以后换图标留一张回归图。
  // 用克隆而不是改原胶囊：克隆同样吃到那套 CSS（选择器都是 .dsh-sel-pill[data-ball="1"] …）。
  if (location.search.indexOf('shot=1') >= 0) {
    freezeMotion()
    if (panelIsOpen()) hook.close()
    await sleep(200)
    hook.pillIdle()
    await sleep(400)
    var src = hook.pill()
    var stage = document.createElement('div')
    stage.setAttribute('id', 'shotstage')
    stage.setAttribute('style',
      'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483600;background:#f4f6f8;' +
      'display:flex;flex-direction:column;gap:22px;align-items:center;justify-content:center;color:#57606a;' +
      'font:12px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif')
    var row1 = document.createElement('div')
    row1.setAttribute('style', 'display:flex;gap:26px;align-items:center')
    /**
     * 造一格：clone 是胶囊的克隆；ball 决定它摆成球还是展开；scale 是放大倍数；
     * dotOnly 时把球态画布里的 d 换成"圆点"那条 —— 用来单独看圆点的几何。
     * 盒子尺寸按**放大后的视觉尺寸**给（球 32×scale），克隆的布局盒仍是被 scale 前的尺寸，
     * 所以放大后的图形会对称溢出布局盒、正好落在盒子里。
     */
    function cell(ball, dotOnly, scale, label) {
      var wrap = document.createElement('div')
      wrap.setAttribute('style', 'display:flex;flex-direction:column;align-items:center;gap:9px')
      var boxW = ball ? Math.round(48 * scale) + 24 : 232
      var boxH = ball ? Math.round(48 * scale) + 24 : 92
      var box = document.createElement('div')
      box.setAttribute('style', 'display:flex;align-items:center;justify-content:center;' +
        'width:' + boxW + 'px;height:' + boxH + 'px;background:#fff;border-radius:14px;' +
        'box-shadow:0 6px 20px rgba(0,0,0,.10)')
      var clone = src.cloneNode(true)
      clone.style.position = 'static'
      clone.style.right = 'auto'
      clone.style.bottom = 'auto'
      clone.style.transition = 'none'
      clone.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')'
      if (ball) clone.setAttribute('data-ball', '1')
      else clone.removeAttribute('data-ball')
      clone.setAttribute('data-ready', '1')
      var starClone = clone.querySelector('.dsh-sel-pillstar')
      if (starClone) {
        starClone.setAttribute('d', ball && !dotOnly
          ? window.__dshSelectionExplain.pillStarD()
          : window.__dshSelectionExplain.pillStarDotD())
      }
      box.appendChild(clone)
      wrap.appendChild(box)
      var cap = document.createElement('div')
      cap.setAttribute('style', 'max-width:240px;text-align:center;line-height:1.6')
      cap.textContent = label
      wrap.appendChild(cap)
      return wrap
    }
    row1.appendChild(cell(false, false, 1, '展开态（真实大小）：球心里是 8px 圆点'))
    row1.appendChild(cell(true, false, 1, '收球态（真实大小）：8px 圆点长成星芒 16.8px'))
    row1.appendChild(cell(true, true, 4, '圆点 8px（4×）—— 32 边形，半径恒 4'))
    row1.appendChild(cell(true, false, 4, '星芒 16.8px（4×）—— 与「✦ 解读」那颗星逐点同形'))
    stage.appendChild(row1)

    // 下行：形变逐帧（直接用 hook.pillStarAt(p) 画真实轨迹）——
    // 这一条就是"中间帧形状不对"的可视回归图：曾经用 CSS 的 d 过渡做线性插值，
    // 25%~38% 那几帧会是一个正菱形（谷跟着尖一起动），在这里一眼就能看出来。
    var row2 = document.createElement('div')
    row2.setAttribute('style', 'display:flex;gap:9px;align-items:flex-end')
    for (var fi = 0; fi <= 8; fi += 1) {
      var fp = fi / 8
      var fcell = document.createElement('div')
      fcell.setAttribute('style', 'display:flex;flex-direction:column;align-items:center;gap:5px')
      var fclone = src.cloneNode(true)
      fclone.style.position = 'static'
      fclone.style.right = 'auto'
      fclone.style.bottom = 'auto'
      fclone.style.transition = 'none'
      fclone.setAttribute('data-ball', '1')
      fclone.setAttribute('data-ready', '1')
      var fstar = fclone.querySelector('.dsh-sel-pillstar')
      if (fstar) {
        fstar.setAttribute('d', window.__dshSelectionExplain.pillStarAt(fp))
        fstar.style.transform = 'rotate(' + Math.round(8 * (1 - fp) * 100) / 100 + 'deg)'
      }
      fcell.appendChild(fclone)
      var fcap = document.createElement('div')
      fcap.setAttribute('style', 'font-size:10px;color:#8c959f')
      fcap.textContent = Math.round(fp * 100) + '%'
      fcell.appendChild(fcap)
      row2.appendChild(fcell)
    }
    stage.appendChild(row2)
    document.body.appendChild(stage)
    await sleep(400)
  }

  finish()
}

main().catch(function (error) {
  check('冒烟脚本自身没抛错', false, (error && error.message) || String(error))
  finish()
})
</script>
</body></html>`

const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
    res.end(readFileSync(BUNDLE))
    return
  }
  if (url === '/' || url === '/smoke.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port

function parseDump(dump) {
  const matched = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dump || '')
  if (!matched) return null
  const text = matched[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

let results = null
let dump = ''
try {
  for (let attempt = 1; attempt <= 2 && !results; attempt += 1) {
    const out = await new Promise((done) => {
      execFile(
        chrome,
        [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--window-size=1200,900',
          '--virtual-time-budget=25000',
          '--dump-dom',
          `http://127.0.0.1:${port}/smoke.html`,
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90000 },
        (error, stdout) => done(stdout || ''),
      )
    })
    dump = out
    results = parseDump(dump)
  }

  // 截图（可选，失败不影响判定）：把两个终态并排拍一张 —— 换图标时人工核对用。
  // 走同一个页面，加 ?shot=1 让页面在跑完检查后把"展开态 / 收球态"克隆出来并排摆好。
  try {
    const shotDir = resolve(ROOT, 'docs')
    if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true })
    const shotPath = resolve(shotDir, 'pill-star-states.png')
    await new Promise((done) => {
      execFile(
        chrome,
        [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--window-size=1180,560',
          '--virtual-time-budget=20000',
          `--screenshot=${shotPath}`,
          `http://127.0.0.1:${port}/smoke.html?shot=1`,
        ],
        { encoding: 'utf8', timeout: 90000 },
        () => done(),
      )
    })
    console.log(`=== 截图（圆点 / 星芒 两个终态）：${shotPath} ===`)
  } catch (error) {
    console.log('（截图跳过：' + ((error && error.message) || String(error)) + '）')
  }
} finally {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  server.close()
}

let failed = 0
if (!results) {
  console.log('FAIL  浏览器里没拿到结果（<pre id="out">）')
  console.log(dump.slice(0, 400))
  failed += 1
} else {
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.extra ? ' — ' + item.extra : ''}`)
    if (!item.ok) failed += 1
  }
}
console.log(`\n=== 小窗面板冒烟结束：${results ? results.length - failed : 0} 通过 / ${failed} 失败 ===`)
process.exit(failed === 0 ? 0 : 1)
