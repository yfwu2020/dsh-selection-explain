/**
 * 划词桥的**真浏览器**冒烟测试（本机 Chrome headless）。
 *
 * 为什么需要它：沙箱 / CSP / 跨不透明源 postMessage / document.write 冲掉监听
 * ——这些行为只有真浏览器引擎说了算。`scripts/test-bridge.mjs` 只测纯逻辑，
 * `scripts/test-client.mjs` 只测父侧接线（DOM 桩）。
 *
 * 做法：起一个临时 http 服务（blob: 的导航在 file:// 下会被拒，必须走 http 源），
 * 页面上放两个 iframe 模拟宿主 ui-sidebar-documentpreview 的两种 HTML 预览：
 *   A. 基础预览：srcdoc + sandbox="allow-scripts" + 清洗版 CSP（script-src 'none' → 放宽）
 *   B. 交互式预览：blob: 外层 bootstrap（document.open/write 整份文档）+ sandbox="allow-scripts"
 * 两份文档都用 lib/client.js 里**同一份** bridgeIntoHtml 注入（不是抄一份代码），
 * 再由文档内的脚本**同步**造一段选区 → 断言父页面收到了 __dshSel 消息。
 *
 * 同步是必须的：headless 的 --virtual-time-budget 不推进子框架里的定时器
 * （实测：主文档的定时器会跑、iframe 里的不跑），而桥的即时路径正是
 * `selectionchange`（document 监听、同步触发），所以不依赖轮询也能验证。
 *
 * 用法：node scripts/smoke-bridge.mjs          （找不到 Chrome 就 SKIP，退出码 0）
 *      CHROME=/path/to/chrome node scripts/smoke-bridge.mjs
 *      node scripts/smoke-bridge.mjs --dump > /tmp/x.html   （只产出页面，不跑浏览器）
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..', 'lib', 'client.js')
const source = readFileSync(BUNDLE, 'utf8')

/** 从 bundle 里抠一个具名函数（与 test-bridge.mjs 同一套配平逻辑）。 */
function sliceFunction(text, name) {
  const start = text.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('bundle 里找不到函数：' + name)
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    } else if (ch === "'" || ch === '"' || ch === '`') {
      for (i += 1; i < text.length; i += 1) {
        if (text[i] === '\\') i += 1
        else if (text[i] === ch) break
      }
    }
  }
  throw new Error('函数没配平：' + name)
}

const injector = [
  sliceFunction(source, 'bridgeBody'),
  sliceFunction(source, 'bridgeIntoHtml'),
  sliceFunction(source, 'insertIntoHtml'),
  'return bridgeIntoHtml',
].join('\n')

/**
 * 造一段选区并**同步**敲一下 selectionchange。
 *
 * 真实的 selectionchange 是**异步任务**（规范里 queue a task），而 headless 的虚拟时钟在
 * "帧加载 vs 预算耗尽"上有竞态，异步任务可能来不及跑（实测：同一页面 A 报得到、C 报不到）。
 * 桥对两者的处理是同一条代码路径，所以这里补一次同步派发，让冒烟测试稳定可判。
 */
const selectScript = (start, end, tag) =>
  '<scr' +
  'ipt>try{parent.postMessage("alive-' +
  tag +
  '","*");var p=document.querySelector("p");var r=document.createRange();r.setStart(p.firstChild,' +
  start +
  ');r.setEnd(p.firstChild,' +
  end +
  ');var s=getSelection();s.removeAllRanges();s.addRange(r);' +
  'document.dispatchEvent(new Event("selectionchange"))}catch(e){parent.postMessage("err-' +
  tag +
  ':"+e,"*")}</scr' +
  'ipt>'

/** 基础预览那份文档：宿主 DOMPurify 清洗后的形态（无脚本、带 script-src 'none' 的 CSP）。 */
const basicDoc = [
  '<!doctype html><html><head>',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; frame-src \'none\'; form-action \'none\'; base-uri \'none\'">',
  '<style>body{font:14px/1.7 -apple-system,sans-serif;padding:12px}</style>',
  '</head><body>',
  '<p>PM: 这周能发布吗？ Dev: the migration ran long, so we ship Wednesday.</p>',
  // 这段脚本在原始文档里被 CSP 挡着（script-src 'none'）——注入放宽后它才会跑
  selectScript(17, 39, 'A'),
  '</body></html>',
].join('')

/** 交互式预览的页面正文（会被 bootstrap 用 document.write 写进来）。 */
const interactiveDoc = [
  '<!doctype html><html><head><style>body{font:14px/1.7 sans-serif;padding:12px}</style></head><body>',
  '<p>Release note: the deadline slipped to Wednesday because the migration ran long.</p>',
  selectScript(14, 29, 'B'),
  '</body></html>',
].join('')

/**
 * 「图解」那种帧（别的插件在侧边栏渲染的生成网页）：blob: + allow-scripts、**没有宿主标记**。
 * 顺便验浮现时机：按住鼠标拖拽期间不许上报，松手之后才报。
 *
 * 编码也照线上来：**页面自己不写 charset**，编码只由 blob 的 `text/html;charset=utf-8` 提供
 * （「图解」就是这么建 blob 的）——插件重发那一份时必须把 content-type 搬过去，
 * 否则整页中文会变成乱码（实测 `鍥捐В椤?`）。
 */
const visualDoc = [
  '<!doctype html><html><head><style>body{font:14px/1.7 sans-serif;padding:12px}</style></head><body>',
  '<p>图解页：迁移跑得久，发布顺延到周三。</p>',
  '<scr' +
    'ipt>try{' +
    'parent.postMessage("alive-C","*");' +
    'window.dispatchEvent(new MouseEvent("mousedown"));' +
    'var p=document.querySelector("p");var r=document.createRange();r.setStart(p.firstChild,5);r.setEnd(p.firstChild,12);' +
    'var s=getSelection();s.removeAllRanges();s.addRange(r);' +
    'parent.postMessage("C-drag-mid","*");' +
    'window.dispatchEvent(new MouseEvent("mouseup"));' +
    // 松手后再动一下选区：这一步必然触发 selectionchange，用来验证闸门已经放开
    // （帧内定时器在 headless 虚拟时间下不推进，所以不能靠 mouseup 里那个 setTimeout）
    'r.setEnd(p.firstChild,14);s.removeAllRanges();s.addRange(r);' +
    'document.dispatchEvent(new Event("selectionchange"));' +
    'parent.postMessage("C-drag-end","*");' +
    // ── 消失时机：在网页里点一下（取消选区）→ 桥要先发 press、再发 clear ──
    'window.dispatchEvent(new MouseEvent("mousedown"));' +
    's.removeAllRanges();' +
    'parent.postMessage("C-click-mid","*");' +
    'window.dispatchEvent(new MouseEvent("mouseup"));' +
    // 同理：headless 里帧内定时器不跑，手动补一次 selectionchange 让 clear 同步发出来
    'document.dispatchEvent(new Event("selectionchange"));' +
    'parent.postMessage("C-click-end","*")' +
    '}catch(e){parent.postMessage("err-C:"+e,"*")}</scr' +
    'ipt>',
  '</body></html>',
].join('')

/** JSON 内嵌进 <script> 时必须把 </ 转义，否则文档里的 </script> 会把父页面脚本截断。 */
const jsonInScript = (value) => JSON.stringify(value).replace(/<\//g, '<\\/')

const page = `<!doctype html><html><head><meta charset="utf-8"><title>bridge-smoke</title></head>
<body>
<h3>bridge smoke</h3>
<div id="frames"></div>
<pre id="out">pending</pre>
<script>
// BRIDGE_MARK 是 bundle 里的模块级常量：抠出来的函数要用它，这里补一个同名变量
var BRIDGE_MARK = 'data-dsh-sel-bridge';
var bridgeIntoHtml = (function(){${injector}})();
var results = [];
var log = [];
var seq = [];
function flush() { document.getElementById('out').textContent = JSON.stringify({ msgs: results, diag: log, seq: seq }, null, 1) }
function diag(line) { log.push(line); flush() }
window.onerror = function (message, src, line, col) { diag('ERR ' + message + ' @' + line + ':' + col) }
function nameOf(source) {
  if (source === frameA.contentWindow) return 'A'
  if (source === frameB.contentWindow) return 'B'
  if (source === frameC.contentWindow) return 'C'
  return '?'
}

window.addEventListener('message', function (event) {
  var data = event.data
  var from = nameOf(event.source)
  if (!data || data.__dshSel !== 1) { seq.push('raw:' + from + ':' + String(data).slice(0, 40)); diag('raw:' + from + ':' + String(data).slice(0, 60)); return }
  seq.push(from + ':' + data.kind)
  results.push({ kind: data.kind, from: from, text: data.sel && data.sel.text, context: data.sel && data.sel.context, rect: data.sel && data.sel.rect })
  flush()
})

// ── A：基础预览。宿主先渲染 srcdoc（sandbox=""），插件随后重写 srcdoc + 补 allow-scripts。
//    实测（Chrome 153）：沙箱与 srcdoc **必须在同一个任务里、且先改沙箱**，
//    否则帧不会带着 allow-scripts 重新加载（见 docs/DEVELOPMENT.md 的"两个坑"）。
var basicHtml = ${jsonInScript(basicDoc)};
var frameA = document.createElement('iframe')
frameA.setAttribute('data-html-preview', 'true')
frameA.setAttribute('sandbox', '')
frameA.setAttribute('srcdoc', basicHtml)
frameA.style.cssText = 'width:420px;height:140px;border:1px solid #999'
document.getElementById('frames').appendChild(frameA)

var nextA = bridgeIntoHtml(basicHtml)
frameA.setAttribute('sandbox', 'allow-scripts')
frameA.setAttribute('srcdoc', nextA)
diag('A injected marker=' + (nextA.indexOf('data-dsh-sel-bridge') > 0) + ' cspRelaxed=' + (nextA.indexOf("script-src 'unsafe-inline'") > 0))

// ── B：交互式预览。外层是 blob bootstrap（document.write），同样注入后换成我们那份 blob。
//    bootstrap 里写进去的文档必须把闭合的 script 标签转义（宿主的真 bootstrap 用 base64
//    达到同样效果），否则内层文档里的闭合标签会把 bootstrap 自己的 script 元素截断。
var innerHtml = ${jsonInScript(interactiveDoc)};
var bootstrap = '<!doctype html><meta charset="utf-8"><scr' + 'ipt>(function(){document.open();document.write(' + JSON.stringify(innerHtml).replace(/<\\//g, '<\\\\/') + ');document.close()})()</scr' + 'ipt>';
var frameB = document.createElement('iframe')
frameB.setAttribute('data-html-preview', 'true')
frameB.setAttribute('sandbox', 'allow-scripts')
frameB.style.cssText = 'width:420px;height:140px;border:1px solid #999'
document.getElementById('frames').appendChild(frameB)

var bootstrapBlob = URL.createObjectURL(new Blob([bootstrap], { type: 'text/html' }))
fetch(bootstrapBlob).then(function (r) {
  var type = (r.headers && r.headers.get && r.headers.get('content-type')) || 'text/html'
  return r.text().then(function (text) { return { text: text, type: type } })
}).then(function (loaded) {
  var injected = bridgeIntoHtml(loaded.text)
  var owned = URL.createObjectURL(new Blob([injected], { type: loaded.type }))
  frameB.setAttribute('src', owned)
  diag('B injected marker=' + (String(injected).indexOf('data-dsh-sel-bridge') > 0) + ' srcOwned=' + (frameB.getAttribute('src') === owned) + ' type=' + loaded.type)
}).catch(function (error) { diag('B inject threw ' + error) })

// ── C：「图解」那种帧（别的插件的生成网页）：blob: + allow-scripts、没有宿主标记，
//    插件照样要桥它；同时验拖拽期间不上报（浮现时机）。
var visualHtml = ${jsonInScript(visualDoc)};
var frameC = document.createElement('iframe')
frameC.setAttribute('title', '图解')
frameC.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups')
frameC.style.cssText = 'width:420px;height:140px;border:1px solid #999'
document.getElementById('frames').appendChild(frameC)

// 与插件 bridgeFrame 的 blob 分支同逻辑（含"content-type 要跟着搬"这条）
var visualBlob = URL.createObjectURL(new Blob([visualHtml], { type: 'text/html;charset=utf-8' }))
fetch(visualBlob).then(function (r) {
  var type = (r.headers && r.headers.get && r.headers.get('content-type')) || 'text/html'
  return r.text().then(function (text) { return { text: text, type: type } })
}).then(function (loaded) {
  var injected = bridgeIntoHtml(loaded.text)
  var owned = URL.createObjectURL(new Blob([injected], { type: loaded.type }))
  frameC.setAttribute('src', owned)
  diag('C injected marker=' + (String(injected).indexOf('data-dsh-sel-bridge') > 0) + ' srcOwned=' + (frameC.getAttribute('src') === owned) + ' type=' + loaded.type)
}).catch(function (error) { diag('C inject threw ' + error) })
</script>
</body></html>`

// ───────────────────────── 跑浏览器并断言 ─────────────────────────

if (process.argv.includes('--dump')) {
  process.stdout.write(page)
  process.exit(0)
}

/** 找一个能用的 Chrome/Chromium。 */
function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  for (const item of candidates) {
    if (existsSync(item)) return item
  }
  return ''
}

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP  没找到 Chrome/Chromium（设 CHROME=/path/to/chrome 可指定）；页面可用 --dump 导出后手动跑')
  process.exit(0)
}

let failed = 0
const assert = (label, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed += 1
}

// blob: 的导航在 file:// 下会被拒（父页面 origin 是 null），所以必须走 http 源
const server = createServer((req, res) => {
  if (req.url && req.url.startsWith('/smoke.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
    return
  }
  res.writeHead(404)
  res.end('not found')
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port

function parseDump(dump) {
  const matched = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dump || '')
  if (!matched) return null
  try {
    return JSON.parse(
      matched[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    )
  } catch (error) {
    return null
  }
}

/** 三个帧都报了才算这一趟跑齐（虚拟时钟下子框架的加载顺序有竞态）。 */
function complete(payload) {
  if (!payload) return false
  const seen = new Set(payload.msgs.filter((m) => m.kind === 'selection').map((m) => m.from))
  return seen.has('A') && seen.has('B') && seen.has('C')
}

let payload = null
let dump = ''
try {
  // 最多试 3 趟：--virtual-time-budget 下"帧的加载 vs 预算耗尽"有竞态（实测偶发某帧还没报就 dump 了），
  // 重试是这里最省事又可靠的兜底。
  for (let attempt = 1; attempt <= 3 && !complete(payload); attempt += 1) {
    // 必须用**异步**的 execFile：同步版会堵住本进程的事件循环，
    // 上面那个临时 http 服务就没法应答 Chrome 的请求 → 浏览器一直等（实测挂死）。
    // 也不要给 --user-data-dir：本机 Chrome 在跑时，全新 profile 的 headless 会卡住不退出。
    const result = await execFileAsync(
      chrome,
      ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=20000', '--dump-dom', `http://127.0.0.1:${port}/smoke.html`],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000 },
    )
    dump = result.stdout
    payload = parseDump(dump)
  }
} catch (error) {
  console.log('（Chrome 调用失败：' + String((error && error.message) || error).slice(0, 200) + '）')
} finally {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  server.close()
}

assert('浏览器里拿到了验证结果（<pre id="out">）', !!payload, dump.slice(0, 120))
if (payload) {
  const fromA = payload.msgs.filter((m) => m.from === 'A' && m.kind === 'selection')
  const fromB = payload.msgs.filter((m) => m.from === 'B' && m.kind === 'selection')
  assert('基础预览（srcdoc + CSP script-src none）：注入后桥跑起来了', payload.diag.some((d) => d.indexOf('A injected marker=true') === 0), payload.diag.join(' | '))
  assert('基础预览：父页面收到帧内上报的选区', fromA.length > 0, JSON.stringify(payload.msgs.map((m) => m.from + ':' + m.kind)))
  assert('基础预览：报的文字正确', !!fromA[0] && fromA[0].text === 'the migration ran long', fromA[0] && fromA[0].text)
  assert('基础预览：上下文用【】标出选中部分', !!fromA[0] && fromA[0].context.indexOf('【the migration ran long】') > 0, fromA[0] && fromA[0].context)
  assert('基础预览：上下文里没有页面脚本源码（跳过 script/style）', !!fromA[0] && fromA[0].context.indexOf('postMessage') < 0, fromA[0] && fromA[0].context)
  assert('基础预览：坐标是帧内视口坐标（正数、有宽高）', !!fromA[0] && fromA[0].rect.w > 0 && fromA[0].rect.h > 0, JSON.stringify(fromA[0] && fromA[0].rect))
  assert('交互式预览（blob bootstrap + document.write）：桥扛住了 document.write', payload.diag.some((d) => d.indexOf('B injected marker=true') === 0), payload.diag.join(' | '))
  assert('交互式预览：父页面收到帧内上报的选区', fromB.length > 0, JSON.stringify(payload.msgs.map((m) => m.from + ':' + m.kind)))
  assert('交互式预览：上下文用【】标出选中部分', !!fromB[0] && fromB[0].context.indexOf('【') > 0 && fromB[0].context.indexOf('】') > 0, fromB[0] && fromB[0].context)

  // C：「图解」那种帧（blob + allow-scripts、没有宿主标记）—— 别的插件在侧边栏渲染的生成网页
  const fromC = payload.msgs.filter((m) => m.from === 'C' && m.kind === 'selection')
  const seq = payload.seq || []
  const midAt = seq.indexOf('raw:C:C-drag-mid')
  const selAt = seq.indexOf('C:selection')
  assert('「图解」那种 blob 帧：注入后桥也跑起来了', payload.diag.some((d) => d.indexOf('C injected marker=true') === 0), payload.diag.join(' | '))
  assert('「图解」那种 blob 帧：父页面收到帧内上报的选区', fromC.length > 0, JSON.stringify(seq))
  assert('「图解」帧：上下文用【】标出选中部分', !!fromC[0] && fromC[0].context.indexOf('【') > 0, fromC[0] && fromC[0].context)
  assert(
    '浮现时机：拖拽进行中（按住鼠标）不上报，松手后才报',
    midAt >= 0 && selAt > midAt,
    'seq=' + JSON.stringify(seq) + ' midAt=' + midAt + ' selAt=' + selAt,
  )
  // 消失时机：在网页里点一下 → 先 press（收浮标）→ 再 clear（选区没了）
  const dragEndAt = seq.indexOf('raw:C:C-drag-end')
  const pressAt = seq.lastIndexOf('C:press')
  const clearAt = seq.indexOf('C:clear')
  assert('消失时机：帧内按下会通知父页面收浮标（press）', pressAt > dragEndAt, 'seq=' + JSON.stringify(seq))
  assert('消失时机：选区清空后发 clear', clearAt > pressAt, 'seq=' + JSON.stringify(seq))
}

console.log(`\n=== 划词桥浏览器冒烟：${failed === 0 ? '全部通过' : failed + ' 项失败'} ===`)
process.exit(failed === 0 ? 0 : 1)
