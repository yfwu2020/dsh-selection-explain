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
import { readFileSync, existsSync } from 'node:fs'
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
