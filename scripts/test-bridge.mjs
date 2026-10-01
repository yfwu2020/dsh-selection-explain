/**
 * 侧边栏网页划词桥的纯逻辑测试（无浏览器、无宿主）。
 *
 * 覆盖两块最容易写坏、又最难人工发现的东西：
 *   ① 注入本身：桥脚本插在哪、CSP 只放宽哪一条、沙箱补了哪个 token；
 *   ② 帧内脚本行为：给它一个"帧里的 DOM + 一段选区"，它报给父页面的消息
 *      对不对（文字 / 带【】的上下文窗口 / keyContext / 帧内坐标）。
 *
 * 做法：从 lib/client.js 里把 bridgeBody / bridgeIntoHtml / insertIntoHtml
 * 三个**纯函数**抠出来单独跑 —— 不加载整个 client bundle，也就不需要 DOM 桩。
 *
 * 用法：node scripts/test-bridge.mjs [lib/client.js 路径]
 * 退出码：全部 PASS = 0。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = process.argv[2] || resolve(HERE, '..', 'lib', 'client.js')
const source = readFileSync(BUNDLE, 'utf8')

let failed = 0
const assert = (label, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed += 1
}

/** 从 bundle 里抠一个具名函数（按花括号配平找结尾，字符串/注释里的花括号不参与计数）。 */
function sliceFunction(text, name) {
  const start = text.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('bundle 里找不到函数：' + name)
  let depth = 0
  let index = text.indexOf('{', start)
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    } else if (ch === "'" || ch === '"' || ch === '`') {
      // 跳过字符串字面量（里面的花括号不能算进配平）
      for (i += 1; i < text.length; i += 1) {
        if (text[i] === '\\') i += 1
        else if (text[i] === ch) break
      }
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1
    }
  }
  throw new Error('函数没配平：' + name)
}

// ───────────────────────── 抠出纯函数 ─────────────────────────
const MARK = 'data-dsh-sel-bridge'
const api = new Function(
  'BRIDGE_MARK',
  [
    sliceFunction(source, 'bridgeBody'),
    sliceFunction(source, 'bridgeIntoHtml'),
    sliceFunction(source, 'insertIntoHtml'),
    'return { bridgeBody: bridgeBody, bridgeIntoHtml: bridgeIntoHtml, insertIntoHtml: insertIntoHtml }',
  ].join('\n'),
)(MARK)

assert('从 bundle 抠出 bridgeBody / bridgeIntoHtml / insertIntoHtml', typeof api.bridgeIntoHtml === 'function')

// ───────────────────────── ① 注入 ─────────────────────────

/** 宿主基础预览（ui-sidebar-documentpreview 的 BasicHtmlFrame）长这样：
 *  DOMPurify 清洗 + 一条 script-src 'none' 的 CSP，装进 srcdoc + sandbox=""。 */
const BASIC =
  '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
  "script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; " +
  'form-action \'none\'; base-uri \'none\'"><style>body{color:red}</style></head>' +
  '<body><p>the migration ran long, so we ship Wednesday</p></body></html>'

const basicOut = api.bridgeIntoHtml(BASIC)
assert('基础预览：注入成功', typeof basicOut === 'string' && basicOut.indexOf(MARK) > 0)
assert('基础预览：只放宽 script-src', /script-src 'unsafe-inline'/.test(basicOut) && !/script-src 'none'/.test(basicOut))
assert(
  '基础预览：其余 CSP 一条不动（不许联网/外链）',
  /default-src 'none'/.test(basicOut) && /connect-src 'none'/.test(basicOut) && /img-src data:/.test(basicOut) && /frame-src 'none'/.test(basicOut),
)
assert('基础预览：原文一字不少', basicOut.indexOf('the migration ran long, so we ship Wednesday') > 0)
assert('基础预览：只注入一段脚本', basicOut.split(MARK).length - 1 === 1, String(basicOut.split(MARK).length - 1))
assert('基础预览：脚本落在 <head> 内（head 之后）', basicOut.indexOf('<head>') < basicOut.indexOf(MARK) && basicOut.indexOf(MARK) < basicOut.indexOf('</head>'))
assert('基础预览：重复注入返回 null（幂等）', api.bridgeIntoHtml(basicOut) === null)

// 交互式预览：外层是宿主的 bootstrap（charset → script），桥必须插在 charset 之后、bootstrap 之前
const BOOTSTRAP = '<!doctype html><meta charset="utf-8"><script>(()=>{document.open();document.write("<p>x</p>");document.close()})()</scr' + 'ipt>'
const bootstrapOut = api.bridgeIntoHtml(BOOTSTRAP)
assert(
  '交互式 bootstrap：插在 charset 之后、bootstrap 之前',
  bootstrapOut.indexOf('<meta charset="utf-8">') < bootstrapOut.indexOf(MARK) && bootstrapOut.indexOf(MARK) < bootstrapOut.indexOf('<script>'),
)
assert('交互式 bootstrap：没有 CSP 时不硬塞 CSP', bootstrapOut.indexOf('Content-Security-Policy') < 0)

// 没有 head / html / charset 的碎片：插在最前（不能因为找不到锚点就丢掉）
const fragmentOut = api.bridgeIntoHtml('<p>裸片段</p>')
assert('碎片文档：插在最前', fragmentOut.indexOf('<script') === 0 && fragmentOut.indexOf('<p>裸片段</p>') > 0, fragmentOut.slice(0, 30))
assert('空串 / null 不注入', api.bridgeIntoHtml('') === null && api.bridgeIntoHtml(null) === null)

// 插入位置：doctype 之后（有 doctype 但没 html/head/charset 时）
const doctypeOut = api.insertIntoHtml('<!doctype html><p>t</p>', '<X>')
assert('只有 doctype 时插在 doctype 之后（不破坏怪异模式判断）', doctypeOut === '<!doctype html><X><p>t</p>', doctypeOut)

// ───────────────────────── ② 帧内脚本行为 ─────────────────────────

/** 把 bridgeBody 变成注入用的脚本本体（与 bridgeIntoHtml 里同一形态）。 */
const FRAME_SCRIPT = '(' + String(api.bridgeBody) + ')();'

/** 帧内的最小 DOM：够 getSelection + createRange + closest + innerText 用。 */
function makeFrameEnv(htmlText, selected, rect, containerTag, muteDocListeners) {
  const sent = []
  const timers = []

  class Node {
    constructor(tag, text) {
      this.tagName = tag
      this.nodeType = tag === '#text' ? 3 : 1
      this.children = []
      this.parentElement = null
      this.parentNode = null
      this._text = text || ''
      this.className = ''
      this.attrs = {}
    }
    appendChild(child) {
      child.parentElement = this
      child.parentNode = this
      this.children.push(child)
      return child
    }
    /** 桥里的 collectText 走 childNodes / nodeValue（真实 DOM 的文本节点属性）。 */
    get childNodes() {
      return this.children
    }
    get nodeValue() {
      return this._text
    }
    get textContent() {
      return (this._text || '') + this.children.map((c) => c.textContent).join('')
    }
    get innerText() {
      return this.textContent
    }
    getAttribute(key) {
      return this.attrs[key] ?? null
    }
    setAttribute(key, value) {
      this.attrs[key] = String(value)
    }
    closest(selector) {
      const want = String(selector).split(',').map((s) => s.trim().toUpperCase())
      let node = this
      while (node) {
        if (want.includes(node.tagName)) return node
        node = node.parentElement
      }
      return null
    }
  }

  const body = new Node('BODY')
  const paragraph = new Node(containerTag || 'P')
  const textNode = new Node('#text', htmlText)
  paragraph.appendChild(textNode)
  body.appendChild(paragraph)

  // 选区是可变的：拖拽用例要在"按住鼠标"期间改变它
  const state = { text: selected, collapsed: false, rect: rect }
  const range = {
    startContainer: textNode,
    get startOffset() {
      return htmlText.indexOf(state.text)
    },
    toString: () => state.text,
    getClientRects: () => [state.rect],
    getBoundingClientRect: () => state.rect,
  }
  const selection = {
    rangeCount: 1,
    get isCollapsed() {
      return state.collapsed
    },
    toString: () => state.text,
    getRangeAt: () => range,
  }

  const doc = {
    body,
    title: 'fixture',
    _listeners: new Map(),
    addEventListener(type, handler) {
      // muteDocListeners：模拟"document.write 把 document 上的监听冲掉了"的交互式预览，
      // 这时只剩 window 上的监听 + 250ms 轮询兜底
      if (muteDocListeners) return
      if (!this._listeners.has(type)) this._listeners.set(type, [])
      this._listeners.get(type).push(handler)
    },
    dispatch(type, event) {
      for (const handler of [...(this._listeners.get(type) || [])]) handler(event)
    },
    hasFocus: () => true,
    getSelection: () => selection,
    createRange() {
      return {
        _node: null,
        _end: null,
        selectNodeContents(node) {
          this._node = node
        },
        setEnd(node, offset) {
          this._end = { node, offset }
        },
        toString() {
          const full = this._node.textContent
          return this._end ? full.slice(0, this._end.offset) : full
        },
      }
    },
  }

  const win = {
    _listeners: new Map(),
    addEventListener(type, handler) {
      if (!this._listeners.has(type)) this._listeners.set(type, [])
      this._listeners.get(type).push(handler)
    },
    dispatch(type, event) {
      for (const handler of [...(this._listeners.get(type) || [])]) handler(event)
    },
    getSelection: () => selection,
  }

  const parent = {
    postMessage(message) {
      sent.push(message)
    },
  }

  const intervals = []
  const run = new Function('window', 'document', 'parent', 'setTimeout', 'setInterval', FRAME_SCRIPT)
  run(win, doc, parent, (fn, ms) => timers.push({ fn, ms }), (fn) => intervals.push(fn))
  // 注入后脚本自己排了 setTimeout(report, 60)：手动跑掉所有排队的定时器
  for (const timer of timers.splice(0)) timer.fn()
  return {
    win,
    doc,
    sent,
    timers,
    intervals,
    selection,
    /** 跑掉排队的 setTimeout（mouseup 之后那次 report 就在里面）。 */
    flushTimers() {
      for (const timer of timers.splice(0)) timer.fn()
    },
    /** 跑一拍轮询（250ms 那次）。 */
    tick() {
      for (const fn of intervals) fn()
    },
    /** 改选区（拖拽中每动一下都算一次变化）。 */
    setSelection(text, nextRect) {
      state.text = text
      state.collapsed = !text
      if (nextRect) state.rect = nextRect
      doc.dispatch('selectionchange', {})
    },
  }
}

const FIXTURE = 'PM: 这周能发布吗？ Dev: the migration ran long, so we ship Wednesday.'
const RECT = { left: 12, top: 34, right: 190, bottom: 52, width: 178, height: 18 }
const longSelection = '长'.repeat(4500)
const longFrame = makeFrameEnv(longSelection, longSelection, RECT)
assert('帧内不以旧的 4000 字默认限制提前拦截（实际限额由父页面设置判断）',
  longFrame.sent.some(m => m.kind === 'selection' && m.sel.text.length === 4500))
const env = makeFrameEnv(FIXTURE, 'the migration ran long', RECT)
const first = env.sent[env.sent.length - 1]
assert('帧内脚本：注入后立刻上报一次', !!first && first.__dshSel === 1 && first.kind === 'selection')
assert('帧内脚本：报的文字就是选中文字', first && first.sel && first.sel.text === 'the migration ran long', first && first.sel && first.sel.text)
assert('帧内脚本：报的是帧内视口坐标', first && first.sel.rect.x === 12 && first.sel.rect.bottom === 52 && first.sel.rect.w === 178, JSON.stringify(first && first.sel.rect))
assert(
  '帧内脚本：上下文用【】标出选中部分，前后文都在',
  first && first.sel.context === 'PM: 这周能发布吗？ Dev: 【the migration ran long】, so we ship Wednesday.',
  first && first.sel.context,
)
assert('帧内脚本：keyContext 只取选中之前那一小段', first && first.sel.keyContext === 'PM: 这周能发布吗？ Dev:', first && first.sel.keyContext)
assert('帧内脚本：普通段落不给标签（标签由父页面按帧来源定）', first && first.sel.label === '', first && first.sel.label)

// 重复 report 不应该重复发（轮询每 250ms 一次）
env.win.dispatch('mouseup', {})
env.flushTimers()
assert('帧内脚本：同一选区 + 同一位置不重复上报', env.sent.filter((m) => m.kind === 'selection').length === 1, String(env.sent.filter((m) => m.kind === 'selection').length))

// 选区清空 → 发 clear（父页面据此收浮标）
env.setSelection('')
env.win.dispatch('mouseup', {})
env.flushTimers()
assert('帧内脚本：选区清空后发 clear', env.sent[env.sent.length - 1].kind === 'clear', env.sent[env.sent.length - 1].kind)

// ── 浮现时机（拖拽中不许冒浮标）──
const dragEnv = makeFrameEnv(FIXTURE, '', RECT)
dragEnv.setSelection('')
const dragSent = () => dragEnv.sent.filter((m) => m.kind === 'selection').length
dragEnv.win.dispatch('mousedown', {})
assert('帧内脚本：按下先发一条 press（父页面据此收浮标）', dragEnv.sent[dragEnv.sent.length - 1].kind === 'press', JSON.stringify(dragEnv.sent.map((m) => m.kind)))
dragEnv.setSelection('the')
dragEnv.setSelection('the migration')
dragEnv.setSelection('the migration ran long')
dragEnv.flushTimers()
assert('帧内脚本：拖拽进行中（按住鼠标）不上报', dragSent() === 0, String(dragSent()))
dragEnv.win.dispatch('mouseup', {})
dragEnv.flushTimers()
assert('帧内脚本：松手后才上报一次', dragSent() === 1, String(dragSent()))
assert('帧内脚本：松手那次报的就是最终选区', dragEnv.sent[dragEnv.sent.length - 1].sel.text === 'the migration ran long')

// 松手落在帧外（收不到 mouseup）：轮询不能永久卡死
dragEnv.win.dispatch('mousedown', {})
const staleEnv = dragEnv
staleEnv.setSelection('ran long')
staleEnv.tick()
assert('帧内脚本：按住时轮询也不报', dragSent() === 1, String(dragSent()))
// 把"按下时间"往前拨：模拟松手发生在帧外、已经过了 STALE_PRESS_MS
const realNow = Date.now
Date.now = () => realNow() + 7000
staleEnv.tick()
staleEnv.tick()
Date.now = realNow
assert('帧内脚本：超时后轮询恢复上报（松手落在帧外也能自愈）', dragSent() === 2, String(dragSent()))

// 轮询的"稳定一拍"（交互式预览里 document 上的监听被 document.write 冲掉后，只剩这条路）
const pollEnv = makeFrameEnv(FIXTURE, '', RECT, 'P', true)
pollEnv.setSelection('migration')
pollEnv.tick()
assert('帧内脚本：轮询第一拍看到变化只记账、不报', pollEnv.sent.filter((m) => m.kind === 'selection').length === 0, String(pollEnv.sent.length))
pollEnv.tick()
assert('帧内脚本：稳定一拍后轮询上报', pollEnv.sent.filter((m) => m.kind === 'selection').length === 1, String(pollEnv.sent.length))

// 键盘扩选（Shift+方向键）：没有 mousedown，selectionchange 立刻上报
const keyEnv = makeFrameEnv(FIXTURE, '', RECT)
keyEnv.setSelection('')
keyEnv.setSelection('the migration')
keyEnv.win.dispatch('keyup', { key: 'ArrowRight' })
keyEnv.flushTimers()
assert('帧内脚本：键盘扩选即时上报（不受拖拽闸门影响）', keyEnv.sent.filter((m) => m.kind === 'selection').length === 1, String(keyEnv.sent.length))

// ── 消失时机：别"自己消失" ──
// 页面重绘/动画期间 getClientRects() 会短暂拿不到矩形 → read() 返回 null。
// 这种瞬时读不到不能当成"选区没了"，否则用户看到的就是浮标自己消失。
const flapEnv = makeFrameEnv(FIXTURE, '', RECT, 'P', true) // 关掉 document 监听，逼它走轮询
flapEnv.setSelection('migration')
flapEnv.tick()
flapEnv.tick()
assert('（准备）瞬时抖动前浮标是亮的', flapEnv.sent.filter((m) => m.kind === 'selection').length === 1)
flapEnv.setSelection('', null) // 读不到了（瞬时）
flapEnv.tick()
flapEnv.tick()
assert('帧内脚本：连续两拍读不到选区也不 clear（页面重绘的瞬时抖动）', flapEnv.sent.filter((m) => m.kind === 'clear').length === 0, JSON.stringify(flapEnv.sent.map((m) => m.kind)))
for (let i = 0; i < 6; i += 1) flapEnv.tick()
assert('帧内脚本：连续 6 拍都读不到才 clear（选区真的没了）', flapEnv.sent.filter((m) => m.kind === 'clear').length === 1, JSON.stringify(flapEnv.sent.map((m) => m.kind)))

// 滚动重报（帧内滚动挪浮标）不许有清空权
const scrollEnv = makeFrameEnv(FIXTURE, '', RECT, 'P', true)
scrollEnv.setSelection('migration')
scrollEnv.tick()
scrollEnv.tick()
scrollEnv.setSelection('')
scrollEnv.win.dispatch('scroll', {})
scrollEnv.flushTimers()
assert('帧内脚本：帧内滚动重报不清空（只有用户动作才有清空权）', scrollEnv.sent.filter((m) => m.kind === 'clear').length === 0, JSON.stringify(scrollEnv.sent.map((m) => m.kind)))

// 代码块里的选区 → 标签「代码块」（父页面拿它决定走「注释」提示词）
// 注意：容器判定与父页面 pickContainer 同规则（往上找到第一个 ≥120 字的元素），
// 所以 fixture 要够长，容器才会落在 <pre> 自己身上。
const CODE_FIXTURE = [
  'function clampSelection(text, max) {',
  '  if (!text) return ""',
  '  return text.length > max ? text.slice(0, max) : text',
  '}',
  'export default clampSelection',
].join('\n')
const codeEnv = makeFrameEnv(CODE_FIXTURE, 'return text.length > max ? text.slice(0, max) : text', RECT, 'PRE')
assert(
  '帧内脚本：pre 容器里的选区带「代码块」标签',
  codeEnv.sent.length === 1 && codeEnv.sent[0].sel.label === '代码块',
  JSON.stringify(codeEnv.sent.map((m) => m.sel && m.sel.label)),
)

// 表格里的选区 → 标签「表格」
const TABLE_FIXTURE =
  '| 说法 | 在此处的含义 |\n| --- | --- |\n| the migration | 发布前那次数据迁移，跑完才敢发版 |\n| ran long | 耗时超出预期，所以顺延到周三 |\n| ship | 发布、上线（这里指把这一版推出去） |'
const tableEnv = makeFrameEnv(TABLE_FIXTURE, '耗时超出预期', RECT, 'TABLE')
assert('帧内脚本：table 容器里的选区带「表格」标签', tableEnv.sent[0].sel.label === '表格', tableEnv.sent[0].sel.label)

// 输入框里的选区 → 一律不报（别干扰输入）
const inputEnv = makeFrameEnv('hello world', 'world', RECT, 'TEXTAREA')
assert('帧内脚本：输入框里的选区不报', inputEnv.sent.length === 0, String(inputEnv.sent.length))

// ping 消息 → hello + 当前选区（父页面用来探测桥在不在）
const pinged = []
env.setSelection('the migration ran long')
env.win.dispatch('message', { data: { __dshSel: 1, kind: 'ping' } })
env.flushTimers()
assert('帧内脚本：应答 ping（hello + 当前选区）', env.sent.some((m) => m.kind === 'hello') && env.sent.some((m) => m.kind === 'selection'), env.sent.map((m) => m.kind).join(','))
void pinged

console.log(`\n=== 划词桥单测结束：${failed === 0 ? '全部通过' : failed + ' 项失败'} ===`)
process.exit(failed === 0 ? 0 : 1)
