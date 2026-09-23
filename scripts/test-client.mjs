/**
 * 划词解读 client bundle 的无浏览器集成测试。
 * - 真实：lib/client.js 源文件、真实 host 路由（/selection-explain/api/analyze，真实 LLM 流）
 * - 打桩：最小 DOM（够 renderRich / 定位 / 选区用）、React.createElement、shell.overlay 槽
 * 覆盖：apply → 槽注册 → 划词浮标 → 点击 → SSE 流式渲染 → 两节内容 → 清理
 *
 * 用法：node scripts/test-client.mjs [lib/client.js 路径]
 *       SEL_ORIGIN=http://127.0.0.1:3080 node scripts/test-client.mjs   # host 已在跑
 * 退出码：全部 PASS = 0。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = process.argv[2] || resolve(HERE, '..', 'lib', 'client.js')

// ───────────────────────── 最小 DOM ─────────────────────────
function textOf(node) {
  if (!node) return ''
  let out = node._text || ''
  for (const child of node.children || []) out += textOf(child)
  return out
}

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    // 真实 DOM 里元素是 1、文本是 3：插件里有 target.nodeType 之类的判断，桩要跟上
    this.nodeType = String(tag) === '#text' ? 3 : 1
    this.children = []
    this.style = {}
    this.dataset = {}
    this.attrs = {}
    this._text = ''
    this.parentNode = null
    this.className = ''
    this.offsetWidth = 0
    this.offsetHeight = 0
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
    this._listeners = new Map()
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
    child.parentNode = null
    return child
  }
  contains(node) {
    let cur = node
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }
  setAttribute(key, value) {
    this.attrs[key] = String(value)
  }
  removeAttribute(key) {
    delete this.attrs[key]
  }
  getAttribute(key) {
    return this.attrs[key] ?? null
  }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(handler)
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type) || []
    const i = list.indexOf(handler)
    if (i >= 0) list.splice(i, 1)
  }
  dispatch(type, event) {
    for (const handler of this._listeners.get(type) || []) handler(event)
  }
  getBoundingClientRect() {
    return { left: 40, top: 100, right: 500, bottom: 400, width: 460, height: 300 }
  }
  getClientRects() {
    return [{ left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }]
  }
  get textContent() {
    return textOf(this)
  }
  set textContent(value) {
    this.children = []
    this._text = value === undefined || value === null ? '' : String(value)
  }
  get innerText() {
    return textOf(this)
  }
  querySelector(selector) {
    // 只认 .class 选择器（够 placePill 量费用胶囊用）；真实 DOM 的行为由浏览器实测覆盖
    const want = typeof selector === 'string' && selector.startsWith('.') ? selector.slice(1) : null
    if (!want) return null
    for (const node of walk(this)) {
      if (String(node.className || '').split(/\s+/).includes(want)) return node
    }
    return null
  }
  focus() {}
  select() {}
}

const head = new FakeEl('head')
const body = new FakeEl('body')
const documentStub = {
  head,
  body,
  title: 'stub-doc',
  _listeners: new Map(),
  createElement: (tag) => new FakeEl(tag),
  createElementNS: (_ns, tag) => new FakeEl(tag),
  createTextNode: (text) => {
    const node = new FakeEl('#text')
    node._text = String(text)
    return node
  },
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(handler)
  },
  removeEventListener(type, handler) {
    const list = this._listeners.get(type) || []
    const i = list.indexOf(handler)
    if (i >= 0) list.splice(i, 1)
  },
  dispatch(type, event) {
    for (const handler of [...(this._listeners.get(type) || [])]) handler(event)
  },
  // 默认没有费用胶囊；测试里挂上假的（globalThis.__fakeSpendWidget）后就能被量到。
  // 真实 DOM 是 id="dsh-spend-widget"（无 class）> .dsu-widget > .dsu-pill，这里两种都认。
  querySelector: (selector) =>
    selector === '.dsu-widget' || selector === '.dsh-spend-widget' ? globalThis.__fakeSpendWidget || null : null,
  getElementById: (id) => (id === 'dsh-spend-widget' ? globalThis.__fakeSpendWidget || null : null),
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
      cloneRange() {
        const clone = { ...this, cloneRange: this.cloneRange }
        return Object.assign(Object.create(Object.getPrototypeOf(this)), this)
      },
      toString() {
        const full = textOf(this._node)
        return this._end ? full.slice(0, this._end.offset) : full
      },
      getClientRects: () => [{ left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }],
      getBoundingClientRect: () => ({ left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }),
    }
  },
}

/** ResizeObserver 桩：只记录回调，测试里手动 fire（触发时机由浏览器决定，逻辑在这里验）。 */
const resizeObservers = []
class ResizeObserverStub {
  constructor(cb) {
    this.cb = cb
    resizeObservers.push(this)
  }
  observe() {}
  disconnect() {
    this.disconnected = true
  }
  fire() {
    if (!this.disconnected) this.cb([])
  }
}

const windowStub = {
  innerWidth: 1440,
  innerHeight: 900,
  _listeners: new Map(),
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(handler)
  },
  removeEventListener(type, handler) {
    const list = this._listeners.get(type) || []
    const i = list.indexOf(handler)
    if (i >= 0) list.splice(i, 1)
  },
  dispatch(type, event) {
    for (const handler of [...(this._listeners.get(type) || [])]) handler(event)
  },
  localStorage: {
    _map: new Map(),
    getItem(key) {
      return this._map.has(key) ? this._map.get(key) : null
    },
    setItem(key, value) {
      this._map.set(key, String(value))
    },
  },
  getSelection: () => null,
  __ModuleLoader__: { load: (spec) => { globalThis.__captured = spec } },
}

// bundle 通过 new Function 注入这些全局（Node 24 的 navigator 是只读 getter，不能挂 globalThis）
const navigatorStub = {}

// ───────────────────────── 载入 bundle ─────────────────────────
const source = readFileSync(BUNDLE, 'utf8')
globalThis.ResizeObserver = ResizeObserverStub
const ORIGIN = process.env.SEL_ORIGIN || 'http://127.0.0.1:3080'
const sent = []
const promoted = []
/** A′：小窗历史的内存版存储（测试用）。 */
const historyStore = new Map()
const historySaved = []
let historyList = []
const openedSessions = []
/** 散文样本（固定 fixture，避免依赖真实网络/缓存命中）。 */
const PROSE_PROBE = 'the migration ran long, so we ship Wednesday'

/** Python 代码选区用例（验证语言标记影响高亮规则）。 */
const PY_SNIPPET = ['def add(a, b):', '    # 这里是可以相加的数字', '    return a + b'].join('\n')

/** 代码选区用例：真实的代码形状（会被 looksLikeCode 判成 code）。 */
const CODE_SNIPPET = [
  'const MAX = 4000',
  'function clampText(text) {',
  '  return text.length > MAX ? text.slice(0, MAX) : text;',
  '}',
].join('\n')

/** 渲染专项测试的固定模型输出（不经过真实 LLM，保证断言稳定）。 */
const RENDER_FIXTURE = [
  '## 翻译',
  '- **slipped** /slɪpt/ 英 /slɪpt/ 美',
  '  - **v.** 滑落；滑倒（过去式）',
  '  - **adj.** 被延误的',
  '- **slipped**：滑落；滑倒',
  '- **slip**（动词）：滑倒；滑落',
  '  - 嵌套项：被延误、被错过',
  '1. 有序第一项',
  '2. 有序第二项',
  '',
  '### 小标题',
  '正文段落，含 **加粗** 与 `code`。',
  '',
  '> 在本句中：（期限）被错过、被推迟',
  '',
  '## 详解',
  '- **关键词**：在上下文里的具体所指（详见 [官方文档](https://example.com/docs)）',
  '| 说法 | 在此处的含义 |',
  '| --- | --- |',
  '| the migration | 发布前那次数据迁移 |',
  '| ran long | 耗时超出预期 |',
  '',
  '```',
  'npm run build',
  '```',
].join('\n')

/**
 * 让 AbortSignal 真的生效：真实 fetch 被 abort 时会取消 body 流，
 * 而这里的手搓 Response 不会——不补这一层，"收起小窗 = 中止这一轮"就测不出来
 * （客户端的 read() 永远不 reject，请求会一路跑完）。
 */
function withAbort(response, signal) {
  if (!response.body || signal.aborted) return response
  const reader = response.body.getReader()
  signal.addEventListener('abort', () => {
    try {
      reader.cancel().catch(() => {})
    } catch {
      /* noop */
    }
  })
  const stream = new ReadableStream({
    start(controller) {
      let aborted = false
      signal.addEventListener('abort', () => {
        aborted = true
        const error = new Error('The operation was aborted.')
        error.name = 'AbortError'
        try {
          controller.error(error)
        } catch {
          /* noop */
        }
      })
      const pump = () =>
        reader
          .read()
          .then(({ done, value }) => {
            if (aborted) return
            if (done) {
              try {
                controller.close()
              } catch {
                /* noop */
              }
              return
            }
            controller.enqueue(value)
            return pump()
          })
          .catch((error) => {
            try {
              controller.error(error)
            } catch {
              /* noop */
            }
          })
      pump()
    },
  })
  return new Response(stream, { headers: response.headers })
}

const routeFetch = (input, init) => {
  const url = typeof input === 'string' ? input : ''
  // 模型清单：用 fixture（真实 host 有 41 个模型，跑用例时不该依赖它）
  if (url.indexOf('/selection-explain/api/models') >= 0) {
    const body = globalThis.__modelCatalogFixture || { ok: true, current: null, stages: null, models: [] }
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))
  }
  // 小窗历史（A′）：内存版实现，避免打到真实 host 拿到脏历史
  if (url.indexOf('/selection-explain/api/history') >= 0) {
    if (init && init.method === 'DELETE') {
      const m = /[?&]key=([^&]+)/.exec(url)
      const key = m ? decodeURIComponent(m[1]) : ''
      const entry = historyStore.get(key) || null
      if (entry) historyStore.delete(key)
      return Promise.resolve(new Response(JSON.stringify({ ok: true, removed: entry ? 1 : 0, entry }), { headers: { 'content-type': 'application/json' } }))
    }
    if (init && init.method === 'POST' && url.indexOf('restore=1') >= 0) {
      const body = JSON.parse(String(init.body))
      if (body && body.entry && body.entry.key) historyStore.set(body.entry.key, body.entry)
      return Promise.resolve(new Response(JSON.stringify({ ok: true, size: historyStore.size }), { headers: { 'content-type': 'application/json' } }))
    }
    if (init && init.method === 'POST') {
      const entry = JSON.parse(String(init.body))
      historyStore.set(entry.key, { ...entry, at: Date.now() })
      historySaved.push(entry)
      return Promise.resolve(new Response(JSON.stringify({ ok: true, size: historyStore.size }), { headers: { 'content-type': 'application/json' } }))
    }
    const key = /[?&]key=([^&]+)/.exec(url)
    if (key) {
      const entry = historyStore.get(decodeURIComponent(key[1])) || null
      return Promise.resolve(new Response(JSON.stringify({ ok: true, entry }), { headers: { 'content-type': 'application/json' } }))
    }
    const entries = Array.from(historyStore.values())
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .map((e) => ({ key: e.key, text: e.text, label: e.label, at: e.at, turns: (e.turns || []).filter((t) => t.role === 'user').length, hasDetail: !!(e.parts && e.parts.detail), pinned: !!e.pinned }))
    historyList = entries
    return Promise.resolve(new Response(JSON.stringify({ ok: true, entries }), { headers: { 'content-type': 'application/json' } }))
  }
  if (url.indexOf('/selection-explain/api/promote') >= 0) {
    try {
      promoted.push(JSON.parse(String(init && init.body)))
    } catch (error) {
      promoted.push({ parse_error: String(error) })
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, sessionId: 'session-promoted-1', cwd: '/tmp/project', chars: 42 }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  let body = null
  if (init && init.body) {
    try {
      body = JSON.parse(String(init.body))
    } catch (error) {
      body = { parse_error: String(error) }
    }
    sent.push(body)
  }
  if (body && body.text === 'stage-probe') {
    const only = body.stage === 'detail' ? '## 详解\nSTAGE-DETAIL' : '## 翻译\nSTAGE-TRANSLATION'
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: body.stage || 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: only })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: only.length })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 慢速流：start 立刻回，250ms 一个空 delta（触发重绘）、450ms 才吐内容
  // —— 用来验证"思考期不空窗"+"等待节点不被重绘打断"+"等待里走秒"
  if (body && body.text === 'slow-probe' && !body.question) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation', effort: 'high' })}\n\n`),
        )
        await new Promise((r) => setTimeout(r, 250))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thought', text: '先判断这段英文在句子里的角色……' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '' })}\n\n`))
        await new Promise((r) => setTimeout(r, 650))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n慢速翻译结果\n' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 8 })}\n\n`))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 分三段、每段隔 60ms 的追问流：用来验证滚动跟随（贴底→跟随 / 翻上去→不拽回）
  // 追问等待特效用例：首字前静默 450ms，用来观察气泡里的等待动画与走秒
  if (body && body.question && body.text === 'wait-ask-probe') {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`))
        await new Promise((r) => setTimeout(r, 450))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '等到了回答。' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === 'wait-ask-probe' && !body.question) {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n等待用例的翻译\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done' })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.question && body.text === 'slow-ask-probe') {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`),
        )
        for (const piece of ['第一段回答。', '第二段回答。', '第三段回答。']) {
          await new Promise((r) => setTimeout(r, 60))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: piece })}\n\n`))
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === 'slow-ask-probe' && !body.question) {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n滚动用例的翻译\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 8 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 分块流式的网页回答：一次 delta 一小段（真实模型就是这样，之前一次给完的用例盖不住）
  if (body && body.question === '分块网页追问') {
    const encoder = new TextEncoder()
    const page = '<!DOCTYPE html>\n<html><body><h1>分块渲染</h1><p>这段 HTML 被切成 6 段吐出来。</p></body></html>'
    const stream = new ReadableStream({
      async start(controller) {
        const send = (o) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`))
        send({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'high' })
        send({ type: 'delta', text: '给你一个页面：\n\n```html\n' })
        await new Promise((r) => setTimeout(r, 150))
        const step = Math.ceil(page.length / 5)
        for (let i = 0; i < page.length; i += step) {
          send({ type: 'delta', text: page.slice(i, i + step) })
          await new Promise((r) => setTimeout(r, 150))
        }
        send({ type: 'delta', text: '\n```\n' })
        send({ type: 'done', chars: page.length })
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 慢速追问：分三段、每段 700ms，留出"按停止"的窗口
  if (body && body.question === '慢速追问') {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (o) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`))
        send({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'high' })
        send({ type: 'delta', text: '第一段回答。' })
        await new Promise((r) => setTimeout(r, 700))
        send({ type: 'delta', text: '第二段回答。' })
        await new Promise((r) => setTimeout(r, 700))
        send({ type: 'delta', text: '第三段回答。' })
        send({ type: 'done', chars: 15 })
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 追问里的"过程旁白"：先吐英文盘算 → 调工具 → drop 撤回 → 再给中文结论
  if (body && body.question === '旁白追问') {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'high', tools: ['web_search'] })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: 'Let me think about it and search again. ' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool', phase: 'start', callId: 'n2', name: 'web_search', detail: '今日新闻' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool', phase: 'done', callId: 'n2', name: 'web_search', detail: '今日新闻', ok: true, ms: 500, chars: 300, preview: 'x', urls: [] })}\n\n`,
      `data: ${JSON.stringify({ type: 'drop', chars: 37, text: 'Let me think about it and search again.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '这是追问的正式回答。' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 10, toolCalls: 1 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.question) {
    const extra = globalThis.__askExtra || {}
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`,
      ...(extra.notice && !extra.strip ? [`data: ${JSON.stringify({ type: 'notice', ...extra.notice })}\n\n`] : []),
      `data: ${JSON.stringify({ type: 'delta', text: extra.delta || '这是对追问的回答：' + body.question })}\n\n`,
      ...(extra.strip ? [`data: ${JSON.stringify({ type: 'strip', text: extra.strip })}\n\n`] : []),
      ...(extra.notice && extra.strip ? [`data: ${JSON.stringify({ type: 'notice', ...extra.notice })}\n\n`] : []),
      `data: ${JSON.stringify({ type: 'done', chars: 12, toolCalls: 0 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 工具正在跑的那段时间（流式）：用来验证"等待提示说在检索，但不泄露查询词/链接"
  // 中止用例：首字很快到，但整轮要 2.5s——留出"收起小窗"的窗口
  if (body && body.text === '中止探测') {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n中止用例的开头\n' })}\n\n`))
        await new Promise((r) => setTimeout(r, 2500))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 10 })}\n\n`))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 「发过追问后 CTA 收起 / 换选区后 CTA 复位」专用：首轮只给翻译，stage=detail 时给详解
  if (body && body.text === 'cta-reset-probe') {
    const only = body.stage === 'detail' ? '## 详解\nCTA 复位用例的详解\n' : '## 翻译\nCTA 复位用例的翻译\n'
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: body.stage === 'detail' ? 'detail' : 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: only })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: only.length })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 网页预览用例：先流一半（此时不该有 iframe），再补齐收尾
  if (body && body.text === 'html-probe') {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n给你一个页面：\n\n```html\n<!DOCTYPE html>\n<html><body><h1>Hello 预览</h1></body></html>\n' })}\n\n`))
        await new Promise((r) => setTimeout(r, 400))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '```\n\n```js\nconst a = 1\n```\n\n```\n<div>只是片段</div>\n```\n' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 120 })}\n\n`))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === 'tool-live-probe') {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', tools: ['web_search'] })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool', phase: 'start', callId: 'L1', name: 'web_search', detail: '检索中的查询词' })}\n\n`))
        await new Promise((r) => setTimeout(r, 500))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool', phase: 'done', callId: 'L1', name: 'web_search', detail: '检索中的查询词', ok: true, ms: 520, chars: 999, preview: '检索结果原文预览', urls: ['https://example.com/secret-source'] })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '## 解读\n模型消化后的结论\n' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 10, toolCalls: 1 })}\n\n`))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 档位提示用例：start 报了 effort=max，然后静默 6s+（没有思考流）→ 提示行必须写 max
  if (body && body.text === 'effort-hint-probe') {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', effort: 'max', stage: 'translation' })}\n\n`))
        // 提示行是"等过 6 秒"才写的，静默必须明显长于 6s，否则 done 会把它抢掉
        await new Promise((r) => setTimeout(r, 8500))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n档位提示用例\n' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 10 })}\n\n`))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 工具轮里的"过程旁白"：先流一段英文盘算 → 调工具 → 发 drop 撤回 → 再给中文结论
  if (body && body.text === 'narrate-probe') {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', tools: ['web_search'] })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: 'I have sources but no content. Maybe I should search once more. ' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool', phase: 'start', callId: 'n1', name: 'web_search', detail: '今日新闻' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool', phase: 'done', callId: 'n1', name: 'web_search', detail: '今日新闻', ok: true, ms: 900, chars: 500, preview: '标题列表', urls: [] })}\n\n`,
      `data: ${JSON.stringify({ type: 'drop', chars: 64, text: 'I have sources but no content. Maybe I should search once more. ' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n这是撤回旁白之后的正式结论。\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 20, toolCalls: 1 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // drop 的 text 和真正流出去的对不上（老缓存/异常）时，必须退化成按字数撤
  if (body && body.text === 'narrate-fallback-probe') {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', tools: ['web_search'] })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: 'NARRATION-A NARRATION-B ' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool', phase: 'start', callId: 'n3', name: 'web_search', detail: 'x' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool', phase: 'done', callId: 'n3', name: 'web_search', detail: 'x', ok: true, ms: 10, chars: 1, preview: '', urls: [] })}\n\n`,
      `data: ${JSON.stringify({ type: 'drop', chars: 24, text: '（对不上的文本）' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n兜底撤回后的结论。\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 12, toolCalls: 1 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === 'tool-probe') {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', tools: ['web_search', 'web_fetch'] })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool', phase: 'start', callId: 'c1', name: 'web_search', detail: 'MCP 协议' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n工具测试\n\n## 详解\n先查再答\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool', phase: 'done', callId: 'c1', name: 'web_search', detail: 'MCP 协议', ok: true, ms: 1800, chars: 420, preview: 'MCP（Model Context Protocol）是…', urls: ['https://modelcontextprotocol.io/docs', 'https://example.com/mcp'] })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 18, toolCalls: 1 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 没有工具可用时，模型会把调用写成正文（实测）——客户端必须剥掉
  if (body && body.text === 'fake-tool-probe') {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', tools: [] })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '<ds_safety_tool_call>\n<tool_name>web_search</tool_name>\n<parameters>\n<query>DSH 插件</query>\n</parameters>\n</ds_safety_tool_call>\n\n## 翻译\n没有工具时的回答\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 30 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === '尾注探测') {
    const out = ['```js', 'const a = 1 // 尾注', '```'].join('\n')
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: out })}\n\n`,
      `data: ${JSON.stringify({ type: 'done' })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === '稳定key探测') {
    const out = '## 解读\n稳定 key 用例内容\n'
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: out })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: out.length })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === PROSE_PROBE) {
    const out = '## 翻译\n- **the migration ran long**：这次迁移耗时超出预期\n'
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: out })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: out.length })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === PY_SNIPPET) {
    const out = ['## 注释', '```python', '# 两数相加', 'def add(a, b):', '    return a + b', '```', '', '> 小结：返回两数之和。'].join('\n')
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation', mode: 'code' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: out })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: out.length })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === CODE_SNIPPET) {
    const out = [
      '## 注释',
      '```js',
      '// 定义文本长度上限',
      'const MAX = 4000',
      '// 声明一个把文本截断到上限的函数',
      'function clampText(text) {',
      '  // 超限就截断，否则原样返回',
      '  return text.length > MAX ? text.slice(0, MAX) : text;',
      '}',
      '```',
      '',
      '> 小结：把输入文本按 4000 字截断后再返回。',
    ].join('\n')
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation', mode: 'code' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: out })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: out.length })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === '缓存探测词') {
    const only = body.stage === 'detail' ? '## 详解\n详解内容（缓存用例）\n' : '## 解读\n缓存测试内容\n'
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: body.stage || 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: only })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: only.length })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === '中文标题探测') {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 解读\n就是"把临时窗口变成正式会话"。\n\n> 在本句中：指把这次解读搬进一个正式会话。\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 30 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === 'legacy-heading-probe') {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n旧标题兼容\n\n## 语境含义\n旧标题下的解释\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done' })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === 'residue-probe' && !body.question) {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation', effort: 'high' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n残渣用例的翻译\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 12 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === 'strip-probe' && !body.question) {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation', effort: 'high' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n泄漏用例的翻译\n\n## 语境含义\n泄漏用例的解释\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 30 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === 'shared-cache-probe') {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'opencode-go', model: 'deepseek-v4.1-flash', cached: true })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n来自共享缓存\n\n## 语境含义\n直接回放\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 24, cached: true })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === 'slipped') {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture-model' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: RENDER_FIXTURE })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: RENDER_FIXTURE.length })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  return fetch(typeof input === 'string' && input.startsWith('/') ? ORIGIN + input : input, init)
}

const browserFetch = (input, init) => {
  const out = routeFetch(input, init)
  const signal = init && init.signal
  if (!signal || !out || typeof out.then !== 'function') return out
  return out.then((response) => (response && response.body ? withAbort(response, signal) : response))
}
new Function('window', 'document', 'location', 'navigator', 'requestAnimationFrame', 'fetch', source)(
  windowStub,
  documentStub,
  { href: ORIGIN + '/' },
  navigatorStub,
  (cb) => setTimeout(cb, 0),
  browserFetch,
)
const captured = globalThis.__captured
/** 深度优先遍历 DOM 桩。 */
function* walk(node) {
  for (const child of node.children || []) {
    yield child
    yield* walk(child)
  }
}

/** 把 DOM 桩打成缩进大纲，便于人眼核对层次。 */
function outline(node, depth) {
  if (!node || depth > 5) return ''
  const indent = '  '.repeat(depth)
  const cls = node.className ? '.' + node.className.split(' ').join('.') : ''
  const level = node.getAttribute && node.getAttribute('data-level') !== null ? `[level=${node.getAttribute('data-level')}]` : ''
  const num = node.getAttribute && node.getAttribute('data-num') ? '[num]' : ''
  const own = (node._text || '').trim()
  let out = `${indent}${node.tagName.toLowerCase()}${cls}${level}${num}${own ? '  ' + own.slice(0, 70) : ''}\n`
  for (const child of node.children || []) out += outline(child, depth + 1)
  return out
}

const assert = (label, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) process.exitCode = 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
assert('bundle 注册 ModuleLoader 工厂', !!captured && typeof captured.factory === 'function', captured && captured.id)

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
}
const modules = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
assert("导出 apply / inject(['slots'])", typeof modules.apply === 'function' && Array.isArray(modules.inject) && modules.inject[0] === 'slots')

// ───────────────────────── 假 ctx + 槽注册 ─────────────────────────
const disposers = []
let registration = null
const ctx = {
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return () => {}
  },
  on() {},
  get(name) {
    if (name === 'sessions') {
      return {
        list: { getSnapshot: () => ({ current: 'session-stub-1' }) },
        open: (id) => {
          openedSessions.push(String(id))
        },
      }
    }
    return undefined
  },
  slots: {
    inject(key, callback) {
      assert('注册到 shell.overlay 槽', key === 'shell.overlay', key)
      const d = callback()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  },
}
modules.apply(ctx)
assert('槽注册带 id/order', !!registration && registration.options.id === '@yfwu2020/dsh-selection-explain' && registration.options.order === 20, JSON.stringify(registration && registration.options))

// React 渲染 → ref 挂载 layer
const mount = new FakeEl('div')
const element = registration.component()
assert('浮层组件返回 React 元素', !!element && element.type === 'div')
element.props.ref(mount)
assert('layer 容器已挂进浮层', mount.children.length === 1 && mount.children[0].className === 'dsh-sel-layer')

// ───────────────────────── 划词 → 浮标 ─────────────────────────
const container = new FakeEl('div')
const textEl = new FakeEl('span')
textEl._text = 'Dev: the migration ran long, so we ship Wednesday. PM: fine, freeze features.'
container.appendChild(textEl)
body.appendChild(container)
const selection = {
  isCollapsed: false,
  rangeCount: 1,
  toString: () => 'the migration ran long',
  getRangeAt: () => documentStub.createRange(),
}
windowStub.getSelection = () => selection
documentStub.dispatch('mouseup', { target: body })
await new Promise((r) => setTimeout(r, 20))
const button = mount.children[0].children.find((c) => c.className === 'dsh-sel-btn')
assert('选中文字后浮标出现', !!button && button.style.display === 'inline-flex', button && `left=${button.style.left} top=${button.style.top}`)
// 浮现动效：只在"隐藏 → 显示"那一次挂动效类；已可见时只平移；animationend 后自动摘掉
{
  const css = readFileSync(BUNDLE, 'utf8')
  assert('CSS 契约：有 pop 关键帧（74% → 100%）', /@keyframes dsh-sel-pop\{from\{opacity:0;transform:scale\(\.74\) translateY\(6px\)\}to\{opacity:1;transform:none\}\}/.test(css), '')
  assert('CSS 契约：动效 240ms + 带过冲的缓动', /\.dsh-sel-btn\[data-pop="1"\]\{animation:dsh-sel-pop \.24s cubic-bezier\(\.34,1\.56,\.64,1\) both\}/.test(css), '')
  assert('CSS 契约：缩放原点是锚点（右下角）', /\.dsh-sel-btn\{transform-origin:100% 100%/.test(css), '')
  assert('CSS 契约：reduced-motion 下关掉 pop', /@media \(prefers-reduced-motion:reduce\)\{[\s\S]{0,400}?\.dsh-sel-btn\[data-pop="1"\]\{animation:none\}/.test(css), '')

}


// ───────────────────────── 点击 → 弹窗 + 真实 host 流 ─────────────────────────
button.dispatch('click', { preventDefault() {}, stopPropagation() {} })
const panel = mount.children[0].children.find((c) => c.className === 'dsh-sel-panel')
// 面板内的固定引用点（后续断言共用）
const sections = Array.from(walk(panel)).filter((node) => node.className.indexOf('dsh-sel-sec') >= 0)
const panelHead = Array.from(walk(panel)).find((node) => node.className === 'dsh-sel-head')
const histBtn = Array.from(walk(panelHead)).find((n) => n.className.indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('最近') >= 0)
const histList = mount.children[0].children.find((n) => n.className === 'dsh-sel-history')
assert('「最近聊过的」是独立浮层，不在消息滚动区里（B 方案）', !!histList && histList.parentNode.className === 'dsh-sel-layer' && !panel.contains(histList), histList ? histList.parentNode.className : '未找到')
const detailCard = sections.find((node) => node.getAttribute('data-sec') === 'detail')
const expandBtn = Array.from(walk(panel)).find((node) => node.className === 'dsh-sel-expand')
const chatLog = Array.from(walk(panel)).find((node) => node.className === 'dsh-sel-chatlog')
const askRow = Array.from(walk(panel)).find((node) => node.className === 'dsh-sel-ask')
assert('弹窗打开', !!panel && panel.style.display === 'flex')
assert('弹窗显示选中文字', !!panel && textOf(panel).indexOf('the migration ran long') >= 0)

const hook = windowStub.__dshSelectionExplain
assert('自检钩子可用', !!hook && typeof hook.state === 'function')

// ── 宿主可达性探测 ──
// 本脚本的一部分断言是**真实 host 集成测试**（连 ORIGIN 上的 /ping 与 SSE /analyze）。
// 本地开发时 host 在跑，这些断言全跑；CI（GitHub Actions）里没有宿主，
// 此时**跳过**在线断言并打印说明，而不是抛 ECONNREFUSED 崩掉整条发布流水线。
let HOST_UP = false
let ping = null
try {
  ping = await hook.ping()
  HOST_UP = !!(ping && ping.ok === true)
} catch (error) {
  HOST_UP = false
}
if (HOST_UP) {
  assert('host ping 可达', !!ping && ping.ok === true, JSON.stringify(ping && ping.route))
  assert('请求载荷携带当前会话 id', sent.length > 0 && sent[0].sessionId === 'session-stub-1', JSON.stringify(sent[0] && { sessionId: sent[0].sessionId, label: sent[0].label }))
  assert('载荷不带 effort（推理档位固定在 host 配置）', sent[0] && sent[0].effort === undefined, String(sent[0] && sent[0].effort))
  assert(
    '三档档位都能从 /ping 读到',
    !!ping && !!ping.reasoningEffortByStage && typeof ping.reasoningEffortByStage.translation === 'string' && typeof ping.reasoningEffortByStage.detail === 'string' && typeof ping.reasoningEffortByStage.chat === 'string',
    JSON.stringify(ping && ping.reasoningEffortByStage),
  )
} else {
  console.log(`SKIP  host 不可达（${ORIGIN}）—— 跳过在线断言（/ping 可达性、SSE 流式渲染、面板交互）`)
  console.log('SKIP  本地开发想跑全量：先启动 DSH（默认 http://127.0.0.1:3080）再执行本脚本')
}
{
  // 默认值断言走源码（不依赖 3080 上那份部署配置改没改）
  const hostSrc = readFileSync(resolve(HERE, '..', 'src', 'index.ts'), 'utf8')
  assert(
    '默认不设输出上限（config 0 = 不传 maxTokens，交给模型自己）',
    /maxTokens: z\.number\(\)\.min\(0\)\.max\(32000\)\.default\(0\)/.test(hostSrc) &&
      /maxTokens: rawConfig\?\.maxTokens \?\? 0/.test(hostSrc) &&
      // 两处调用点（主循环 + 结论轮）都必须"只在 >0 时传"（续写轮已随"输出长度与中断"一起去掉）
      (hostSrc.match(/config\.maxTokens > 0 \? \{ maxTokens: config\.maxTokens \} : \{\}/g) || []).length >= 2,
    'src/index.ts',
  )
  assert(
    '已按要求去掉"输出长度与中断"机制（不再检测截断、不再续写/短收尾/提示）',
    !/chunk\.reason\.kind === 'max-tokens'/.test(hostSrc) &&
      !/runContinuation/.test(hostSrc) &&
      !/markTailRepair/.test(hostSrc) &&
      !/code: 'continue'/.test(hostSrc) &&
      !/code: 'tail-unfinished'/.test(hostSrc) &&
      !/code: 'tail-residue'/.test(hostSrc) &&
      !/code: 'wrap-up'/.test(hostSrc),
    'src/index.ts',
  )
  // 小窗的搜索工具改用 free-search 插件（advanced_search / platform_search），不再用官方 web_search
  assert(
    '备用联网工具：默认清单是 web_search（没装联网插件时补上）',
    /fallbackToolNames: z\.string\(\)\.default\('web_search'\)/.test(hostSrc) &&
      /fallbackToolNames: rawConfig\?\.fallbackToolNames \?\? 'web_search'/.test(hostSrc) &&
      /const SEARCH_TOOL_NAMES = \['advanced_search', 'platform_search', 'web_search'\]/.test(hostSrc) &&
      /function resolveToolNames\(preferred: string\[\], fallback: string\[\], visible: string\[\]\): string\[\]/.test(hostSrc),
    'src/index.ts',
  )
  assert(
    '默认白名单用 free-search 的两个搜索工具（web_search 移出首选、留作备用）',
    /toolNames: z\.string\(\)\.default\('advanced_search,platform_search,read,grep,glob'\)/.test(hostSrc) &&
      /toolNames: rawConfig\?\.toolNames \?\? 'advanced_search,platform_search,read,grep,glob'/.test(hostSrc),
    'src/index.ts',
  )
  assert('客户端给了新搜索工具中文标签', /\(name === 'advanced_search'\) return '联网搜索'/.test(readFileSync(resolve(HERE, '..', 'src', 'client', 'index.js'), 'utf8')), '')
  assert(
    '追问档位默认 high（翻译仍 low、详解仍 high）',
    /chatReasoningEffort: z\.string\(\)\.default\('high'\)/.test(hostSrc) &&
      /chatReasoningEffort: rawConfig\?\.chatReasoningEffort \?\? 'high'/.test(hostSrc) &&
      /translationReasoningEffort: z\.string\(\)\.default\('low'\)/.test(hostSrc),
    'src/index.ts',
  )
}

// ── 以下全部是真实 host 集成断言（SSE 流式渲染 / 面板交互 / 历史 / 清理）──
// CI 里没有宿主，跳过；本地开发有宿主时全跑。
if (HOST_UP) {

const deadline = Date.now() + 90000
while (Date.now() < deadline) {
  const state = hook.state()
  if (state.phase === 'done' || state.phase === 'error') break
  await new Promise((r) => setTimeout(r, 400))
}
const final = hook.state()
const stage1 = hook.parts()
assert('流式渲染完成（无错误）', final.phase === 'done', `phase=${final.phase} chars=${final.chars}`)
assert('首轮只产出翻译节', (stage1.translation || '').trim().length > 0 && !(stage1.detail || '').trim(), JSON.stringify({ stage: stage1.stage, t: stage1.translation.length, d: stage1.detail.length }))
assert('首轮请求带 stage=translation', sent[0] && sent[0].stage === 'translation', String(sent[0] && sent[0].stage))
assert('首轮不显示详解卡片', !!detailCard && detailCard.style.display === 'none', detailCard ? detailCard.style.display : '未找到')
assert(
  '底部有「展开详解」按钮且不带说明行',
  !!expandBtn && textOf(expandBtn).trim() === '↓ 展开详解',
  expandBtn ? JSON.stringify(textOf(expandBtn)) : '未找到',
)

// 只有翻译时的轻量形态：窄面板 / 无序号 / CTA 在内容流里（但**可以越过详解直接追问**）
const translateCard = sections.find((node) => node.getAttribute('data-sec') === 'translation')
assert('首轮面板标为 translation 阶段（宽度收窄）', panel.getAttribute('data-stage') === 'translation', String(panel.getAttribute('data-stage')))
assert(
  '两节标题都不带序号（①② 已去掉）',
  !Array.from(walk(panel)).some((n) => n.tagName === 'B' && /^[①②12]$/.test(textOf(n))),
  Array.from(walk(panel)).filter((n) => n.tagName === 'B').map((n) => textOf(n)).join(','),
)
assert('翻译出完就能追问（不必先展开详解）', !!askRow && askRow.style.display !== 'none', askRow ? askRow.style.display : '未找到')
assert(
  '展开 CTA 在正文内容流里（详解卡片之后）',
  !!expandBtn && expandBtn.parentNode === detailCard.parentNode,
  expandBtn && expandBtn.parentNode ? expandBtn.parentNode.className : '未找到',
)

// 越过详解直接追问：翻译刚出来就能问，不必先点「展开详解」
{
  const before = sent.length
  hook.ask('不展开详解，直接问一句')
  for (let i = 0; i < 80 && sent.length === before; i += 1) await sleep(20)
  const payload = sent[sent.length - 1] || {}
  assert('越过详解也能发出追问', payload.question === '不展开详解，直接问一句', JSON.stringify({ q: payload.question, stage: payload.stage }))
  const seed = payload.history && payload.history[0] ? String(payload.history[0].text) : ''
  assert('前情只带翻译：不留空的「详解：」', seed.indexOf('前情') >= 0 && seed.indexOf('详解：') < 0, seed.slice(0, 70))
  for (let i = 0; i < 80 && textOf(chatLog).indexOf('这是对追问的回答') < 0; i += 1) await sleep(20)
  assert('回答渲染进小窗消息区', textOf(chatLog).indexOf('这是对追问的回答') >= 0, textOf(chatLog).slice(0, 60))
  assert('一旦有对话，面板恢复宽版（消息区更好读）', panel.getAttribute('data-stage') === 'detail', String(panel.getAttribute('data-stage')))
  assert('发过追问后「展开详解」自动收起', expandBtn.style.display === 'none', String(expandBtn.style.display))

  // 换一段新的选中文字：状态重置，CTA 该回来（后面的"点展开"流程从这里接着走）。
  // 用英文 fixture（标题才是「翻译」，后面的"两节标题"断言才对得上），且它首轮只出翻译、不出详解。
  hook.open('cta-reset-probe', '', 'CTA 复位')
  for (let i = 0; i < 120 && hook.state().phase !== 'done'; i += 1) await sleep(20)
  assert('新选区里 CTA 回来', expandBtn.style.display !== 'none', String(expandBtn.style.display))
  assert('新选区把追问记录清空', hook.turns().filter((t) => t.role === 'user').length === 0, JSON.stringify(hook.turns().map((t) => t.role)))
}

// 点击展开：第二阶段（完整上下文 + 详解）
const beforeExpand = sent.length
expandBtn.dispatch('click', { stopPropagation() {} })
for (let i = 0; i < 200; i += 1) {
  const parts = hook.parts()
  if ((parts.detail || '').trim().length > 0) break
  await new Promise((r) => setTimeout(r, 100))
}
const stage2 = hook.parts()
const expandPayload = sent[sent.length - 1]
assert(
  '展开请求带 stage=detail，且不再强制 refresh（详解也能命中缓存）',
  expandPayload.stage === 'detail' && expandPayload.refresh === undefined,
  JSON.stringify({ stage: expandPayload.stage, refresh: expandPayload.refresh, sent: sent.length - beforeExpand }),
)
// 偶发失败过：只等"有内容"会在流还没收尾时抢跑，这里等到阶段真正结束再断言
for (let i = 0; i < 100 && !(hook.parts().detail || '').trim(); i += 1) await sleep(50)
for (let i = 0; i < 100 && hook.state().phase !== 'done'; i += 1) await sleep(50)
assert('第二阶段产出详解', (hook.parts().detail || '').trim().length > 0, (hook.parts().detail || '').trim().slice(0, 60).replace(/\n/g, ' '))
assert('展开后按钮隐藏、详解卡片出现', expandBtn.style.display === 'none' && detailCard.style.display !== 'none', `btn=${expandBtn.style.display} card=${detailCard.style.display}`)
assert('展开后面板切到 detail 阶段（恢复宽度）', panel.getAttribute('data-stage') === 'detail', String(panel.getAttribute('data-stage')))
assert(
  '展开后标题仍不带序号',
  !Array.from(walk(panel)).some((n) => n.tagName === 'B' && /^[①②12]$/.test(textOf(n))),
)
assert('展开后出现追问输入框', !!askRow && askRow.style.display !== 'none', askRow ? askRow.style.display : '未找到')
assert('DOM 渲染出两节标题', textOf(panel).indexOf('翻译') >= 0 && textOf(panel).indexOf('详解') >= 0)
assert(
  '页眉不再显示模型名（模型只在 composer 的胶囊里）',
  !Array.from(walk(panelHead)).some((n) => /fixture/.test(textOf(n))),
  Array.from(walk(panelHead)).map((n) => textOf(n)).join('|').slice(0, 60),
)
assert('耗时信息仍有记录（不再上界面，自检可读）', /耗时/.test(String(hook.state().status || '')), String(hook.state().status))

// ───────────────────────── 渲染层次（固定输出，离线可验） ─────────────────────────
hook.open('slipped', '', '渲染测试')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) {
  await new Promise((r) => setTimeout(r, 25))
}
const translationContent = sections[0] && Array.from(walk(sections[0])).find((n) => n.className === 'dsh-sel-c')
const detailContent = sections[1] && Array.from(walk(sections[1])).find((n) => n.className === 'dsh-sel-c')

function classesIn(root, cls) {
  return Array.from(walk(root)).filter((node) => node.className.split(' ').indexOf(cls) >= 0)
}
const flatLists = classesIn(translationContent, 'dsh-sel-list')
const levels = flatLists.map((node) => node.getAttribute('data-level'))
const orderedItems = classesIn(translationContent, 'dsh-sel-item').filter((n) => n.getAttribute('data-num') === '1')
assert('两节各自成卡片（data-sec 标记）', sections.length === 2 && sections[0].getAttribute('data-sec') === 'translation' && sections[1].getAttribute('data-sec') === 'detail')
assert(
  '列表按缩进分级（顶层 + 嵌套各成表，编号切换另起表）',
  levels[0] === '0' && levels.indexOf('1') >= 0,
  '数据级别=' + levels.join(','),
)
assert('有序列表保留编号', orderedItems.length === 2 && textOf(orderedItems[0]).indexOf('1.') === 0, orderedItems.map((n) => textOf(n).slice(0, 12)).join(' | '))
assert('小标题走独立子标题节点', classesIn(translationContent, 'dsh-sel-sub').some((n) => textOf(n).indexOf('小标题') >= 0))
assert('加粗与行内代码分别成节点', classesIn(translationContent, 'dsh-sel-strong').length >= 2 && classesIn(translationContent, 'dsh-sel-code').length === 1)
{
  const rendered = Array.from(translationContent.children)
  const echoLine = rendered.find((n) => textOf(n) === '滑落；滑倒')
  assert(
    '译文回声前缀被剥掉（行首的「- **选中文字**：」被去掉，只留内容）',
    !!echoLine && echoLine.tagName === 'P' && !rendered.some((n) => textOf(n) === 'slipped'),
    echoLine ? echoLine.tagName + '：' + textOf(echoLine) : rendered.slice(0, 3).map((n) => textOf(n)).join(' | '),
  )
  // 带音标的那一行是"词头 + 音标"，词头要留着（否则只剩一串斜杠）
  const ipaLine = rendered.find((n) => textOf(n).indexOf('/slɪpt/') >= 0)
  const ipaText = ipaLine ? textOf(ipaLine) : ''
  assert(
    '带音标的词头行不被剥（词头在前、音标在后，都留着）',
    !!ipaLine && ipaText.indexOf('slipped') >= 0 && ipaText.indexOf('/slɪpt/') > ipaText.indexOf('slipped'),
    ipaText || '未找到音标行',
  )
}
const pres = classesIn(detailContent, 'dsh-sel-pre')
assert(
  '围栏代码块渲染（保留原始缩进、不走行内解析）',
  pres.length === 1 && textOf(pres[0]).indexOf('npm run build') >= 0,
  pres.length ? JSON.stringify(textOf(pres[0])) : '未找到 pre',
)
const callouts = classesIn(translationContent, 'dsh-sel-callout')
{
  // 词头是父项（level 0），词性义项是缩进子项（level 1）——
  // 用户看到的"单词本身和词性一个层级"就是这个层次没拉开
  const lists = classesIn(translationContent, 'dsh-sel-list')
  const levelOf = (list) => list.getAttribute('data-level')
  const itemsAt = (lvl) => lists.filter((n) => levelOf(n) === String(lvl)).flatMap((n) => Array.from(n.children).map((c) => textOf(c)))
  const top = itemsAt(0)
  const sub = itemsAt(1)
  assert('词头在父级（level 0）', top.some((t) => t.indexOf('slipped') >= 0 && t.indexOf('/slɪpt/') > 0), JSON.stringify(top.slice(0, 3)))
  const hasPos = (t) => /^•?\s*(v\.|adj\.|n\.|adv\.|prep\.|conj\.|pron\.)/.test(t)
  assert(
    '词性义项缩进成子级（level 1），父级里没有裸词性行',
    sub.filter(hasPos).length >= 2 && !top.some(hasPos),
    JSON.stringify({ 子级词性行: sub.filter(hasPos).slice(0, 3), 父级: top.slice(0, 3) }),
  )
}
assert(
  '单词条目带音标：词头加粗、音标原文原样渲染',
  textOf(translationContent).indexOf('/slɪpt/') >= 0 && classesIn(translationContent, 'dsh-sel-strong').length > 0,
  textOf(translationContent).slice(0, 90),
)
assert(
  '翻译节结论条高亮渲染（标签胶囊 + 正文）',
  callouts.length === 1 && textOf(callouts[0]).indexOf('在本句中') === 0 && textOf(callouts[0]).indexOf('被推迟') > 0,
  callouts.length ? textOf(callouts[0]).slice(0, 40) : '未找到结论条',
)
// 链接：markdown 链接渲染成可点的 a[href]
const answerLinks = classesIn(detailContent, 'dsh-sel-link')
assert('正文里的 markdown 链接渲染成可点链接', answerLinks.length === 1 && answerLinks[0].getAttribute('href') === 'https://example.com/docs' && textOf(answerLinks[0]) === '官方文档', answerLinks.map((n) => textOf(n) + '→' + n.getAttribute('href')).join(','))
assert('链接带 target=_blank 与 noopener', answerLinks[0].getAttribute('target') === '_blank' && /noopener/.test(answerLinks[0].getAttribute('rel') || ''), answerLinks[0].getAttribute('rel'))
const tables = classesIn(detailContent, 'dsh-sel-table')
const headerCells = tables.length ? classesIn(tables[0], 'dsh-sel-table') : []
const ths = tables.length ? Array.from(walk(tables[0])).filter((n) => n.tagName === 'TH') : []
const tds = tables.length ? Array.from(walk(tables[0])).filter((n) => n.tagName === 'TD') : []
assert(
  '对照表格渲染（表头 2 列 + 2 行数据）',
  tables.length === 1 && tables[0].tagName === 'TABLE' && ths.length === 2 && tds.length === 4,
  `table=${tables.length} th=${ths.length} td=${tds.length}`,
)
console.log('\n--- 渲染结构：翻译节 ---')
console.log(outline(translationContent, 0).slice(0, 1200))
console.log('--- 渲染结构：详解节 ---')
console.log(outline(detailContent, 0).slice(0, 900))

// ───────────────────────── 共享缓存命中（host 回放） ─────────────────────────
hook.open('shared-cache-probe', '', '缓存测试')
for (let i = 0; i < 60 && hook.state().phase !== 'done'; i += 1) {
  await new Promise((r) => setTimeout(r, 20))
}
assert(
  '共享缓存命中时状态栏标注「共享缓存」',
  /共享缓存/.test(textOf(panel)) && textOf(panel).indexOf('来自共享缓存') >= 0,
  textOf(panel).match(/完成[^重]{0,40}/)?.[0] || textOf(panel).slice(0, 40),
)

assert(
  '右上角是「最近 + 升格 + 关闭」三个，没有复制按钮',
  !Array.from(walk(panelHead)).some((n) => textOf(n).indexOf('复制') >= 0) &&
    Array.from(walk(panelHead)).filter((n) => n.className === 'dsh-sel-icon').length === 1 &&
    Array.from(walk(panelHead)).filter((n) => n.className.indexOf('dsh-sel-action') >= 0).length === 2 &&
    Array.from(walk(panelHead)).some((n) => n.className.indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('最近') >= 0),
  Array.from(walk(panelHead)).map((n) => n.className + ':' + textOf(n).slice(0, 6)).join(' | '),
)
const promoteBtn = Array.from(walk(panelHead)).find((n) => n.className.indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('升格') >= 0)
assert(
  '升格按钮是自适应宽度的文字按钮（不再挤进 24px 方块）',
  !!promoteBtn && textOf(promoteBtn).indexOf('升格') >= 0,
  promoteBtn ? promoteBtn.className + '｜' + textOf(promoteBtn) : '未找到',
)

// ───────────────────────── 升格为正式会话 ─────────────────────────
// 先走一遍两阶段（翻译 → 展开详解），确保升格时取的是两个阶段的结果而不是最后一段流
hook.open('stage-probe', '', '分阶段')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await new Promise((r) => setTimeout(r, 20))
hook.expand()
for (let i = 0; i < 80 && !(hook.parts().detail || '').trim(); i += 1) await new Promise((r) => setTimeout(r, 20))
assert(
  '两阶段各自的结果都留存（raw 只会有最后一段）',
  (hook.parts().translation || '').indexOf('STAGE-TRANSLATION') >= 0 && (hook.parts().detail || '').indexOf('STAGE-DETAIL') >= 0,
  JSON.stringify(hook.parts()),
)

const promoteButton = Array.from(walk(panelHead)).find((n) => n.className.indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('升格') >= 0)
promoteButton.dispatch('click', { stopPropagation() {} })
for (let i = 0; i < 60 && promoted.length === 0; i += 1) {
  await new Promise((r) => setTimeout(r, 20))
}
for (let i = 0; i < 60 && openedSessions.length === 0; i += 1) {
  await new Promise((r) => setTimeout(r, 20))
}
const promotePayload = promoted[0] || {}
assert(
  '升格请求带上两节结论（分阶段取，翻译不丢）',
  !!promotePayload.text &&
    (promotePayload.translation || '').indexOf('STAGE-TRANSLATION') >= 0 &&
    (promotePayload.detail || '').indexOf('STAGE-DETAIL') >= 0 &&
    Array.isArray(promotePayload.turns),
  JSON.stringify({ t: (promotePayload.translation || '').slice(0, 20), d: (promotePayload.detail || '').slice(0, 20) }),
)
assert('升格请求剔除种子轮次（seed 不入正式会话）', !(promotePayload.turns || []).some((t) => t.seed === true))
assert('升格后跳到新会话', openedSessions[0] === 'session-promoted-1', JSON.stringify(openedSessions))
assert('升格结果仍有记录（自检可读）', /已升格/.test(String(hook.state().status || '')), String(hook.state().status))
for (let i = 0; i < 60 && panel.style.display !== 'none'; i += 1) {
  await new Promise((r) => setTimeout(r, 20))
}
assert('升格后小窗自动关闭', panel.style.display === 'none', 'display=' + panel.style.display)

assert('页脚不再有档位开关', !Array.from(walk(panel)).some((n) => /深入|快速/.test(textOf(n)) && n.className === 'dsh-sel-more'))
{
  const quoteEl = Array.from(walk(panel)).find((n) => n.className === 'dsh-sel-quote')
  const bodyEl = Array.from(walk(panel)).find((n) => n.className === 'dsh-sel-body')
  assert('选中文字条在滚动区里（跟着消息一起滚，不再钉在顶部）', !!quoteEl && !!bodyEl && quoteEl.parentNode === bodyEl, quoteEl ? String(quoteEl.parentNode && quoteEl.parentNode.className) : '未找到')
  assert('选中文字条是滚动区的第一项（在最顶端，不在消息后面）', !!bodyEl && bodyEl.children[0] === quoteEl, bodyEl ? bodyEl.children.map((n) => n.className).join(' > ') : '')
  // CSS 契约（桩环境不跑样式，直接查产物里的规则文本）
  const cssText = readFileSync(BUNDLE, 'utf8')
  assert('选中文字条不被 flex 压扁（flex:0 0 auto）', /\.dsh-sel-quote\{[^']*flex:0 0 auto/.test(cssText), '')
  assert('选中文字条可自动换行 + 上限内滚动', /\.dsh-sel-quote\{[\s\S]{0,900}?white-space:pre-wrap/.test(cssText) && /\.dsh-sel-quote\{[\s\S]{0,900}?max-height:84px/.test(cssText), '')
  assert('选中文字条不显示滚动条', /\.dsh-sel-quote::-webkit-scrollbar/.test(cssText) && /display:none/.test(cssText) && /\.dsh-sel-quote\{[\s\S]{0,900}?scrollbar-width:none/.test(cssText), '')
}

// ───────────────────────── 工具调用：只进上下文，不进小窗 ─────────────────────────
// 明确要求：小窗里只允许出现"模型处理后的结果"。工具日志（卡片、查询词、命中字数、
// 预览原文、链接、耗时）一律不渲染——它们只是模型的原料。
hook.open('tool-probe', '', '工具测试')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
assert(
  '页脚不再报"用过 N 次工具"',
  !/用过/.test(textOf(panel)),
  textOf(panel).match(/完成[^重]{0,50}/)?.[0] || textOf(panel).slice(0, 60),
)
assert('小窗里没有工具卡片容器', !Array.from(walk(panel)).some((n) => n.className === 'dsh-sel-toollog'), 'dsh-sel-toollog')

const toolText = textOf(panel)
assert('面板里没有工具卡片节点', !Array.from(walk(panel)).some((n) => /^dsh-sel-tool/.test(n.className)), '')
assert('查询词不进小窗', toolText.indexOf('MCP 协议') < 0, toolText.slice(0, 80))
assert('命中字数/耗时不进小窗', !/420 字/.test(toolText) && !/1\.8s/.test(toolText), '')
assert('工具结果预览不进小窗', toolText.indexOf('Model Context Protocol') < 0 && toolText.indexOf('modelcontextprotocol.io') < 0, '')
assert('工具名不进小窗', toolText.indexOf('联网搜索') < 0 && toolText.indexOf('web_search') < 0, '')
assert('内部仍记录工具调用（供自检与上下文）', hook.state().tools === 1, String(hook.state().tools))
assert('工具摘要仍生成（追问时带给模型）', /联网搜索/.test(hook.state().toolDigest) && /MCP/.test(hook.state().toolDigest), hook.state().toolDigest.slice(0, 60))

hook.ask('那它和 LSP 有什么关系？')
for (let i = 0; i < 80 && textOf(chatLog).indexOf('这是对追问的回答') < 0; i += 1) await sleep(20)
const digPayload = sent[sent.length - 1]
assert('追问请求带上 toolDigest', typeof digPayload.toolDigest === 'string' && digPayload.toolDigest.indexOf('MCP') >= 0, String(digPayload.toolDigest || '').slice(0, 60))

// 检索**正在进行**时：只有一句"正在检索资料"，查询词/预览/链接仍然一个字都不出现
hook.open('tool-live-probe', '', '检索中')
let busySeen = false
let busyHint = ''
let busyText = ''
for (let i = 0; i < 60 && hook.state().phase !== 'done'; i += 1) {
  await sleep(20)
  if (hook.state().toolBusy) {
    busySeen = true
    busyText = textOf(panel)
    const hint = Array.from(walk(panel)).find((n) => n.className === 'dsh-sel-waithint')
    if (hint && textOf(hint).indexOf('正在检索资料') >= 0) busyHint = textOf(hint)
  }
}
assert('检索期间有"正在检索资料"提示', busySeen && busyHint.indexOf('正在检索资料') >= 0, `busy=${busySeen} hint=${busyHint}`)
assert('检索期间也不显示查询词', busyText.indexOf('检索中的查询词') < 0, busyText.slice(0, 80))
assert('检索期间也不显示结果链接', busyText.indexOf('secret-source') < 0, '')
assert('检索结束后清掉检索标记', hook.state().toolBusy === false, String(hook.state().toolBusy))
assert('检索完成后正文照常显示', textOf(sections[0]).indexOf('模型消化后的结论') >= 0, textOf(sections[0]).slice(0, 60))

// 等待提示里的"推理档位"必须是**这次真正用的档位**：
// 等待节点是在 start 事件之前建的，那里只能实时读，不能用创建时的兜底值。
hook.open('effort-hint-probe', '', '档位提示')
let effortHint = ''
for (let i = 0; i < 70 && hook.state().phase !== 'done'; i += 1) {
  await sleep(200)
  const hint = Array.from(walk(panel)).find((n) => n.className === 'dsh-sel-waithint')
  if (hint && /推理档位/.test(textOf(hint))) { effortHint = textOf(hint); break }
}
assert('等待提示显示本次实际推理档位', /推理档位 max/.test(effortHint), effortHint || '未出现档位提示')
for (let i = 0; i < 40 && hook.state().phase !== 'done'; i += 1) await sleep(100)

// ───────────────────────── 工具轮里的"过程旁白"不许当正文 ─────────────────────────
hook.open('narrate-probe', '', '旁白探测')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
{
  const answer = String(hook.parts().translation || '')
  assert(
    '工具轮里的旁白被撤回（不进答案正文，一个字都不留）',
    answer.indexOf('I have') < 0 && answer.indexOf('Maybe I should search') < 0,
    answer.slice(0, 80),
  )
  assert('撤回后正式结论照常显示', answer.indexOf('这是撤回旁白之后的正式结论') >= 0, answer.slice(0, 80))
  assert(
    '旁白转成了思考尾巴（还能看到它在想什么）',
    String(hook.state().thought || '').indexOf('Maybe I should search') >= 0,
    String(hook.state().thought || '').slice(0, 60),
  )
  assert(
    '结束后等待节点被清掉（旁白不会留在界面上）',
    !Array.from(walk(sections[0])).some((n) => n.className === 'dsh-sel-waithint'),
    Array.from(walk(sections[0])).filter((n) => n.className === 'dsh-sel-waithint').map((n) => textOf(n)).join('|'),
  )
}
// text 对不上时退化成按字数撤（兜底路径）
hook.open('narrate-fallback-probe', '', '兜底探测')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
{
  const answer = String(hook.parts().translation || '')
  assert(
    'drop 的 text 对不上时按字数兜底撤回（一个字都不剩）',
    answer.indexOf('NARRATION') < 0 && answer.indexOf('兜底撤回后的结论') >= 0,
    JSON.stringify(answer.slice(0, 60)),
  )
}

// 追问里同样要撤（askBox/chatLog 在这一节已就绪）
await sleep(20)
hook.ask('旁白追问')
for (let i = 0; i < 80 && textOf(chatLog).indexOf('这是追问的正式回答') < 0; i += 1) await sleep(20)
{
  const bubbleText = textOf(chatLog)
  assert('追问气泡里也撤掉了旁白', bubbleText.indexOf('Let me think') < 0, bubbleText.slice(-120))
  assert('追问的正式回答保留', bubbleText.indexOf('这是追问的正式回答') >= 0, bubbleText.slice(-120))
}

// ───────────────────────── AI 回复里的网页：定稿后实时渲染成 iframe ─────────────────────────
hook.open('html-probe', '', '网页预览')
await sleep(150)
{
  const during = Array.from(walk(sections[0])).filter((n) => n.className === 'dsh-sel-preview')
  assert('流式期间只给源码、不建 iframe（避免每帧重载闪白）', during.length === 0, `preview=${during.length}`)
}
for (let i = 0; i < 120 && hook.state().phase !== 'done'; i += 1) await sleep(20)
{
  const blocks = Array.from(walk(sections[0])).filter((n) => n.className === 'dsh-sel-preview')
  assert('定稿后渲染出网页预览块', blocks.length === 1, `preview=${blocks.length}`)
  const block = blocks[0]
  const frame = block ? Array.from(walk(block)).find((n) => n.className === 'dsh-sel-previewframe') : null
  const srcdoc = frame ? String(frame.getAttribute('srcdoc') || '') : ''
  assert('预览用沙箱 iframe 装 HTML（srcdoc 带原文）', srcdoc.indexOf('<h1>Hello 预览</h1>') >= 0, srcdoc.slice(0, 60))
  assert('沙箱只给 allow-scripts、不给 allow-same-origin', frame && String(frame.getAttribute('sandbox')).indexOf('allow-scripts') >= 0 && String(frame.getAttribute('sandbox')).indexOf('allow-same-origin') < 0, frame ? String(frame.getAttribute('sandbox')) : '无')
  assert('同一块里也保留源码（可切到代码视图）', !!block && Array.from(walk(block)).some((n) => n.className === 'dsh-sel-pre'), '')
  assert('js 代码块不会被当成网页', Array.from(walk(sections[0])).filter((n) => n.className === 'dsh-sel-preview').length === 1 && textOf(sections[0]).indexOf('const a = 1') >= 0, '')
  assert('未标语言的 <div> 片段不会被当成网页', !Array.from(walk(sections[0])).some((n) => n.className === 'dsh-sel-previewframe' && String(n.getAttribute('srcdoc') || '').indexOf('只是片段') >= 0), '')
  assert('D：注入了窄容器自适应样式（viewport + reset）', srcdoc.indexOf('data-dsh-preview-reset') >= 0 && srcdoc.indexOf('width=device-width') >= 0, srcdoc.slice(0, 90))
  assert('注入点在 doctype 之后（不把文档推进怪异模式）', /^\s*<!DOCTYPE html>/i.test(srcdoc) && srcdoc.indexOf('data-dsh-preview-reset') > srcdoc.indexOf('<!DOCTYPE'), srcdoc.slice(0, 40))
  assert('注入了"上报自身高度"的 hook（消灭框内滚动条的前提）', srcdoc.indexOf('data-dsh-preview-hook') >= 0 && srcdoc.indexOf('__dshPreview') >= 0, '')
  assert('内置滚动条被隐藏（高度自适应后本来也不需要）', srcdoc.indexOf('::-webkit-scrollbar') >= 0 && srcdoc.indexOf('scrollbar-width:none') >= 0, '')
  assert('预览帧带 id（用于把上报的高度对回来）', !!frame && /^pv\d+$/.test(String(frame.getAttribute('data-preview-id'))), frame ? String(frame.getAttribute('data-preview-id')) : '无')
  // 交互：预览/代码切换 + 放大
  const tabs = Array.from(walk(block)).filter((n) => n.className === 'dsh-sel-previewtab')
  assert('默认停在预览视图', block.getAttribute('data-view') === 'preview' && tabs[0].getAttribute('data-on') === '1', `${block.getAttribute('data-view')} on=${tabs[0] && tabs[0].getAttribute('data-on')}`)
  tabs[1].dispatch('click', { stopPropagation() {} })
  assert('点「代码」切到源码视图', block.getAttribute('data-view') === 'code' && tabs[1].getAttribute('data-on') === '1', String(block.getAttribute('data-view')))
  tabs[0].dispatch('click', { stopPropagation() {} })
  const zoomBtn = Array.from(walk(block)).find((n) => n.className === 'dsh-sel-previewzoom')
  assert('默认是"全量展示"（整页铺在消息区，内部不滚）', block.getAttribute('data-full') === '1' && textOf(zoomBtn) === '⤡ 还原', `${block.getAttribute('data-full')} / ${textOf(zoomBtn)}`)
  zoomBtn.dispatch('click', { stopPropagation() {} })
  assert('点「还原」切回固定高度档', block.getAttribute('data-full') === '0' && textOf(zoomBtn) === '⤢ 全量', `${block.getAttribute('data-full')} / ${textOf(zoomBtn)}`)
  const cssFull = readFileSync(BUNDLE, 'utf8')
  assert('固定高度档是 320px（超出走内部滚动）', /\.dsh-sel-preview\[data-full="0"\] \.dsh-sel-previewframe\{height:320px\}/.test(cssFull), '')
  assert('旧的 data-zoom 高度档已移除', !/data-zoom/.test(cssFull), '')
}

// ───────────────────────── 历史折叠（整页 HTML 只发 Markdown） ─────────────────────────
{
  // ① 折叠函数本身：没有整页 HTML → 原样（快路径）
  const plain = '## 翻译\n就是一段普通文字回答。'
  assert('没有整页 HTML 的轮次原样返回（快路径，零成本）', hook.foldText(plain) === plain, '')
  // ② 有整页 HTML → 折叠：标签/样式消失、结构留下
  const html = '<!doctype html><html><head><style>.card{color:#12a594;background:#111}</style></head><body>'
    + '<h1>标题一</h1><p>正文 <strong>重点</strong>。</p>'
    + '<table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>'
    + '<ul><li>要点甲</li><li>要点乙</li></ul><svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'
    + '<div class="card" style="color:red">带 class 的一段</div></body></html>'
  const folded = hook.foldText('看这个：\n\n```html\n' + html + '\n```\n')
  assert('折叠后不再有标签/样式/class', !/<[a-z]/i.test(folded) && folded.indexOf('style=') < 0 && folded.indexOf('class=') < 0, folded.slice(0, 80))
  assert('标题层级保留（# 标题一）', folded.indexOf('# 标题一') >= 0, '')
  assert('强调保留（**重点**）', folded.indexOf('**重点**') >= 0, '')
  assert('表格行列保留（两行 + 分隔行）', (folded.match(/^\|.*\|$/gm) || []).length === 3, JSON.stringify(folded.match(/^\|.*\|$/gm)))
  assert('列表逐项保留', folded.indexOf('- 要点甲') >= 0 && folded.indexOf('- 要点乙') >= 0, '')
  assert('SVG 折成 [图示]（图形丢了、位置留下）', folded.indexOf('[图示]') >= 0, '')
  assert('附了一行版式摘要（主色/标题/表格/图示）', /版式摘要/.test(folded) && folded.indexOf('#12a594') >= 0, folded.slice(-90))
  assert('正文文字一个不丢', ['正文', '带 class 的一段', '列A', '1'].every((w) => folded.indexOf(w) >= 0), '')
  // ③ 缓存：同一轮只折一次
  const before = hook.foldStats().folds
  const again = hook.foldText('```html\n' + html + '\n```')
  assert('foldText 每次都折（无缓存时）', hook.foldStats().folds === before + 1, String(hook.foldStats().folds))
}

{
  // ④ 追问时的实际历史：更早的整页折叠、最近一轮保持原样、且不重折
  const before = hook.foldStats().folds
  const n0 = sent.length
  hook.ask('网页版')                                  // 产生一轮"整页 HTML"回答
  for (let i = 0; i < 120 && sent.length === n0; i += 1) await sleep(20)
  for (let i = 0; i < 200 && hook.turns().some((t) => t.streaming === true); i += 1) await sleep(20)
  const turnsAfterFirst = hook.foldStats().turns.length
  hook.ask('再问一句')                                // 第二轮：历史里应出现折叠后的第一轮
  for (let i = 0; i < 120 && sent.length === n0 + 1; i += 1) await sleep(20)
  const payload = sent[sent.length - 1] || {}
  const hist = payload.history || []
  // 判据要精确：把围栏（```…```）里的代码样例排除掉之后再找标签 ——
  // 代码样例里的 <div> 是**内容**，本来就该保留；真正不该出现的，是围栏之外的整页标记。
  const outsideFences = (text) => String(text).replace(/```[\s\S]*?```/g, '')
  const rawPageLeft = (text) => /<[a-z][a-z0-9]*[\s>/]/i.test(outsideFences(text))
  const pageTurn = hist.filter((h) => rawPageLeft(String(h.text)))
  const foldedTurn = hist.filter((h) => /^#|\n\|/m.test(String(h.text)))
  assert(
    '历史里带整页 HTML 的轮次已被折叠（围栏之外不再有标签）',
    pageTurn.length === 0,
    JSON.stringify(pageTurn.map((h) => outsideFences(String(h.text)).slice(0, 60))),
  )
  assert('折叠后的历史仍是结构化 Markdown', foldedTurn.length >= 1, JSON.stringify(foldedTurn.map((h) => String(h.text).slice(0, 40))))
  assert('最近一轮保持原样（可继续改版式）', hist.length >= 2 && /版式摘要/.test(String(hist[hist.length - 1].text)) === false, JSON.stringify(hist.map((h) => String(h.text).slice(0, 24))))
  const foldsAfterFirst = hook.foldStats().folds
  for (let i = 0; i < 200 && hook.turns().some((t) => t.streaming === true); i += 1) await sleep(20)
  hook.ask('第三轮')                                  // 第二轮：第一轮已缓存，不该重折
  for (let i = 0; i < 120 && sent.length === n0 + 2; i += 1) await sleep(20)
  assert('已经折过的轮次不再重折（有缓存）', hook.foldStats().folds === foldsAfterFirst, `${foldsAfterFirst} → ${hook.foldStats().folds}`)
  const cache = hook.foldStats().turns.filter((t) => t.folded !== null)
  assert('折叠结果缓存在那一轮上', cache.length >= 1 && cache[0].folded > 0, JSON.stringify(cache))
  for (let i = 0; i < 200 && hook.turns().some((t) => t.streaming === true); i += 1) await sleep(20)
}

// ───────────────────────── 网页模式开关（复杂问题默认用网页回答） ─────────────────────────
{
  const webBtn = Array.from(walk(panel)).find((n) => String(n.className).indexOf('dsh-sel-pref') >= 0)
  const prefSeg = webBtn && Array.from(walk(webBtn)).find((n) => String(n.className) === 'dsh-sel-seg')
  const cells = prefSeg ? Array.from(walk(prefSeg)).filter((n) => String(n.className) === 'dsh-sel-segcell') : []
  const cellIcon = (cell) => (cell ? Array.from(walk(cell)).find((n) => n.tagName === 'SVG') : null)
  assert('追问行里有「输出偏好」控件', !!webBtn && textOf(webBtn).indexOf('输出偏好') >= 0, webBtn ? textOf(webBtn) : '未找到')
  assert('它是 radiogroup（两格各自 aria-checked）', !!prefSeg && prefSeg.getAttribute('role') === 'radiogroup' && cells.length === 2 && cells.every((c) => c.getAttribute('role') === 'radio'), prefSeg ? `${prefSeg.getAttribute('role')} / cells=${cells.length}` : '')
  assert('左格是 Markdown 图标（M↓ 两峰 + 箭头，13px）', !!cellIcon(cells[0]) && Array.from(walk(cells[0])).filter((n) => n.tagName === 'PATH').length === 2 && cellIcon(cells[0]).getAttribute('width') === '13', String(cellIcon(cells[0]) && cellIcon(cells[0]).getAttribute('width')))
  assert('右格是网页窗口图标（矩形 + 顶栏）', !!cellIcon(cells[1]) && Array.from(walk(cells[1])).some((n) => n.tagName === 'RECT') && Array.from(walk(cells[1])).some((n) => n.tagName === 'PATH'), '')
  assert('两格都没文字（纯图标）', cells.every((c) => textOf(c).trim() === ''), cells.map((c) => JSON.stringify(textOf(c))).join(' '))
  assert('默认停在 Markdown（左格选中、药丸在左）', hook.prefCells().markdown === true && hook.prefCells().web === false && webBtn.getAttribute('data-on') === '0', JSON.stringify(hook.prefCells()))
  assert('控件在输入框内部的工具行里（仿主会话两行结构）', !!webBtn && String(webBtn.parentNode.className) === 'dsh-sel-asktools' && String(webBtn.parentNode.parentNode.className).indexOf('dsh-sel-ask') >= 0, webBtn ? `${webBtn.parentNode.className} < ${webBtn.parentNode.parentNode.className}` : '')
  const sendBtn = Array.from(walk(panel)).find((n) => String(n.className).indexOf('dsh-sel-asksend') >= 0)
  assert('发送也是符号化的（图标 + aria-label，无文字）', !!sendBtn && textOf(sendBtn).trim() === '' && sendBtn.getAttribute('aria-label') === '发送', sendBtn ? `${JSON.stringify(textOf(sendBtn))} / ${sendBtn.getAttribute('aria-label')}` : '')
  assert('图标带显式宽高（不会退回 SVG 默认的 300×150）', !!sendBtn && String(Array.from(walk(sendBtn))[0].getAttribute('width')) === '16' && String(Array.from(walk(sendBtn))[0].getAttribute('height')) === '16', '')
  // CSS 契约：圆形按钮、不能被旧的 padding 规则挤扁
  const composerCss = readFileSync(BUNDLE, 'utf8')
  assert('按钮边距归零、尺寸缩小到 26px', /\.dsh-sel-iconbtn\{[^']*height:26px/.test(composerCss) && /\.dsh-sel-iconbtn\{[^']*padding:0/.test(composerCss), '')
  // 输出偏好分段的 CSS 契约（桩环境不跑样式）
  assert('两格各 30×22、图标 13px', /\.dsh-sel-segcell\{[^']*width:30px;height:22px/.test(composerCss) && /\.dsh-sel-segcell svg\{width:13px/.test(composerCss), '')
  assert('药丸 30×22 且靠 data-on 平移 30px', /\.dsh-sel-segpill\{[^']*width:30px;height:22px/.test(composerCss) && /\.dsh-sel-pref\[data-on="1"\] \.dsh-sel-segpill\{transform:translateX\(30px\)\}/.test(composerCss), '')
  assert('药丸位移有回弹过渡', /\.dsh-sel-segpill\{[\s\S]{0,400}?cubic-bezier\(\.3,1\.2,\.4,1\)/.test(composerCss), '')
  assert('选中格的图标变白（有 aria-checked 样式）', /\.dsh-sel-segcell\[aria-checked="true"\]/.test(composerCss), '')
  assert('旧滑块/胶囊样式已清掉', !/\.dsh-sel-preftrack\{/.test(composerCss) && !/\.dsh-sel-prefknob\{/.test(composerCss) && !/\.dsh-sel-webmode\{/.test(composerCss), '')
  assert('生成中发送键变方形"停止"（有独立样式）', /\.dsh-sel-asksend\[data-mode="stop"\]/.test(composerCss), '')
  assert('没有残留的 .dsh-sel-asksend{padding:0 14px} 旧规则', !/\.dsh-sel-asksend\{[^']*padding:0 14px/.test(composerCss), '')
  assert('输入区是两行结构（工具行 + 撑开占位）', /\.dsh-sel-asktools\{display:flex/.test(composerCss) && /\.dsh-sel-askspace\{flex:1 1 auto\}/.test(composerCss), '')
  assert('底部那条页脚已经没有了', !Array.from(walk(panel)).some((n) => String(n.className).indexOf('dsh-sel-foot') >= 0), '')
  assert('短提示浮层也没有了（界面上不显示状态）', !Array.from(walk(panel)).some((n) => String(n.className).indexOf('dsh-sel-toast') >= 0), '')
  assert('状态仍有记录（自检可读，不渲染）', typeof hook.state().status === 'string', typeof hook.state().status)
  // 点右格 → 切到网页；药丸跟着滑
  cells[1].dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert('点右格就滑到右档（并落盘到 localStorage）', hook.webMode() === true && webBtn.getAttribute('data-on') === '1' && windowStub.localStorage.getItem('dsh-selection-explain:webAnswer') === '1', String(windowStub.localStorage.getItem('dsh-selection-explain:webAnswer')))
  assert('两格 aria-checked 互换', hook.prefCells().web === true && hook.prefCells().markdown === false, JSON.stringify(hook.prefCells()))
  assert('两格各有自己的说明（title）', /网页/.test(String(cells[1].title)) && /Markdown/.test(String(cells[0].title)), `${cells[0].title} | ${cells[1].title}`)
  // 点左格 → 切回 Markdown
  cells[0].dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert('点左格切回 Markdown', hook.webMode() === false && webBtn.getAttribute('data-on') === '0', String(webBtn.getAttribute('data-on')))
  // 键盘：右方向键切到网页
  prefSeg.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} })
  assert('方向键也能换档（radiogroup 惯例）', hook.webMode() === true, String(hook.webMode()))
  // 开着的时候追问：请求要带 webAnswer: true，host 据此注入设计规范
  // 等这一轮真的结束（用它自己的 streaming 标记），否则下一轮 ask 会被"还在生成"挡掉
  const waitIdle = async () => {
    for (let i = 0; i < 200 && hook.turns().some((t) => t.streaming === true); i += 1) await sleep(20)
    await sleep(40)
  }
  const beforeWeb = sent.length
  hook.ask('复杂问题：三种方式对比')
  for (let i = 0; i < 80 && sent.length === beforeWeb; i += 1) await sleep(20)
  const webPayload = sent[sent.length - 1] || {}
  assert('开启后追问请求带 webAnswer: true', webPayload.webAnswer === true, JSON.stringify({ webAnswer: webPayload.webAnswer, q: webPayload.question }))
  await waitIdle()
  hook.setWebMode(false)
  const beforePlain = sent.length
  hook.ask('简单问题')
  for (let i = 0; i < 80 && sent.length === beforePlain; i += 1) await sleep(20)
  assert('关掉后不带 webAnswer（走普通文字回答）', (sent[sent.length - 1] || {}).webAnswer === undefined, JSON.stringify((sent[sent.length - 1] || {}).webAnswer))
  await waitIdle()
}

// 分块流式：流式期间只给源码、跑完只建 1 个 iframe（回归：曾经每个 delta 建一个，一条回答建了 24 个，
// 结果流式期间看不到源码，最后一帧还因为反复销毁/加载卡成空白，得关掉小窗重开才渲染）
{
  let framesCreated = 0
  const origCreate = documentStub.createElement
  // 只统计"这条回答的" iframe：按 srcdoc 内容认（页面同时还有翻译节的预览块，
  // 早先按"创建次数"统计被它污染，误判成流式期间也建了 iframe）
  documentStub.createElement = (tag) => {
    const node = origCreate(tag)
    if (String(tag).toLowerCase() === 'iframe') {
      const origSet = node.setAttribute.bind(node)
      node.setAttribute = (key, value) => {
        if (key === 'srcdoc' && String(value).indexOf('分块渲染') >= 0) framesCreated += 1
        return origSet(key, value)
      }
    }
    return node
  }
  const framesInChat = () => Array.from(walk(chatLog)).filter((n) => n.className === 'dsh-sel-previewframe').length
  const codeInChat = () => Array.from(walk(chatLog)).filter((n) => n.className === 'dsh-sel-pre').length
  const stillStreaming = () => hook.turns().some((t) => t.streaming === true)

  framesCreated = 0 // 只统计这一条回答
  hook.ask('分块网页追问')
  for (let i = 0; i < 60 && codeInChat() === 0; i += 1) await sleep(10)
  assert(
    '流式期间显示源码、不建 iframe',
    framesCreated === 0 && framesInChat() === 0 && codeInChat() > 0,
    `frames=${framesCreated} code=${codeInChat()}`,
  )

  // 等这一轮真的结束（用它自己的 streaming 标记，别跟流式赛跑）
  for (let i = 0; i < 200 && (stillStreaming() || !/分块渲染/.test(textOf(chatLog))); i += 1) await sleep(20)
  await sleep(80)
  assert('这一轮已收尾（没有残留的流式标记）', !stillStreaming(), JSON.stringify(hook.turns().map((t) => t.streaming)))
  assert('跑完只建 1 个 iframe（不是每个 delta 一个）', framesCreated === 1, `frames=${framesCreated}`)
  {
    // 消息排版对齐主会话：助手消息整宽无气泡（所以"有网页的"和"普通"宽度天然一致），用户消息才是右对齐气泡
    const bubbles = Array.from(walk(chatLog)).filter((n) => String(n.className).indexOf('dsh-sel-bubble ') >= 0)
    const bots = bubbles.filter((n) => /dsh-sel-bubble-bot/.test(String(n.className)))
    const users = bubbles.filter((n) => /dsh-sel-bubble-user/.test(String(n.className)))
    assert('助手消息不再用气泡样式（整宽，和主会话一致）', bots.length >= 1 && users.length >= 1, JSON.stringify(bubbles.map((n) => n.className)))
  }
  const frames = Array.from(walk(chatLog)).filter((n) => n.className === 'dsh-sel-previewframe')
  assert(
    '最终 iframe 装的是完整 HTML',
    frames.length === 1 && String(frames[0].getAttribute('srcdoc')).indexOf('分块渲染') >= 0,
    frames.length ? String(frames[0].getAttribute('srcdoc')).slice(0, 50) : '无',
  )
  documentStub.createElement = origCreate
}

// 预览页上报高度 → iframe 直接长到内容那么高（框内不再有滚动条）
{
  const frame = Array.from(walk(chatLog)).find((n) => n.className === 'dsh-sel-previewframe')
  const id = frame ? String(frame.getAttribute('data-preview-id')) : ''
  assert('分块用例的预览帧也带 id', /^pv\d+$/.test(id), id || '无')
  if (frame && id) {
    frame.contentWindow = { __tag: 'me' }
    windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 999 }, source: { __tag: 'other' } })
    assert('不认来源不符的高度上报', !frame.style.height, String(frame.style.height))
    windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 480 }, source: frame.contentWindow })
    assert('页面自己多高，预览就多高', frame.style.height === '480px', String(frame.style.height))
    // 注入端曾经发的是数字 1，监听端写成 `!== true` 会把自家消息挡掉（实测踩过）→ 这里两种都要认
    windowStub.dispatch('message', { data: { __dshPreview: 1, id: id, h: 500 }, source: frame.contentWindow })
    assert('标记为 1（数字）也认（不再依赖严格相等）', frame.style.height === '500px', String(frame.style.height))
    windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 498 }, source: frame.contentWindow })
    assert('高度抖动小于 4px 不折腾（避免反复回流）', frame.style.height === '500px', String(frame.style.height))
    windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 540 }, source: frame.contentWindow })
    assert('真变高了就跟着长', frame.style.height === '540px', String(frame.style.height))
    // 全量模式：长到内容高度（不再夹在面板可视高度里——"整页铺开"就是这个意思）
    windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 2400 }, source: frame.contentWindow })
    assert('全量模式：iframe 直接长到整页高度（内部不滚）', frame.style.height === '2400px', String(frame.style.height))
    // 病态页面兜底：几万像素不至于把消息区撑爆
    windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 40000 }, source: frame.contentWindow })
    assert('病态高度有兜底上限（6000px）', frame.style.height === '6000px', String(frame.style.height))
    // 点「还原」→ 固定高度：清掉 inline 高度，交给 CSS 的 320px
    const blockWrap = Array.from(walk(chatLog)).find((n) => String(n.className).indexOf('dsh-sel-preview') >= 0)
    const restoreBtn = Array.from(walk(blockWrap)).find((n) => String(n.className).indexOf('dsh-sel-previewzoom') >= 0)
    restoreBtn.dispatch('click', { stopPropagation() {} })
    assert('点「还原」后 inline 高度清空（回到固定的 320px 内部滚动）', frame.style.height === '' && blockWrap.getAttribute('data-full') === '0', `${JSON.stringify(frame.style.height)} / ${blockWrap.getAttribute('data-full')}`)
    restoreBtn.dispatch('click', { stopPropagation() {} })
    assert('再点「全量」又按上报高度铺开', frame.style.height === '6000px' && blockWrap.getAttribute('data-full') === '1', `${frame.style.height} / ${blockWrap.getAttribute('data-full')}`)
  }
}

// ───────────────────────── 生成中：发送键变「停止」，点一下打断 ─────────────────────────
{
  const sendBtn = Array.from(walk(panel)).find((n) => String(n.className).indexOf('dsh-sel-asksend') >= 0)
  // 首轮（慢速 fixture）：流式期间按钮应变成 stop
  // 注意：用独一无二的 text，否则会把"中止探测"的缓存/历史污染掉，后面的用例会直接命中缓存
  hook.open('停止键专用探测词', '', '停止用例')
  for (let i = 0; i < 60 && hook.state().phase !== 'streaming'; i += 1) await sleep(20)
  assert('生成中发送键变成「停止」（方形图标 + data-mode=stop）', sendBtn.getAttribute('data-mode') === 'stop' && sendBtn.getAttribute('aria-label') === '停止' && !!Array.from(walk(sendBtn)).find((n) => n.tagName === 'RECT'), `${sendBtn.getAttribute('data-mode')} / ${sendBtn.getAttribute('aria-label')}`)
  sendBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  for (let i = 0; i < 60 && hook.state().phase !== 'paused'; i += 1) await sleep(20)
  assert('点「停止」打断首轮：记成已停止而不是失败', hook.state().phase === 'paused', hook.state().phase)
  assert('停止后按钮恢复成「发送」', sendBtn.getAttribute('data-mode') === 'send' && sendBtn.getAttribute('aria-label') === '发送', String(sendBtn.getAttribute('data-mode')))
  assert('停止后正文里有交代 + 重新生成入口', textOf(panel).indexOf('已停止') >= 0 && !!Array.from(walk(panel)).find((n) => String(n.className).indexOf('dsh-sel-retry') >= 0), '')

  // 追问（慢速 fixture）：同样能打断，且保留已经流出来的内容
  const beforeAskStop = sent.length
  hook.ask('慢速追问')
  for (let i = 0; i < 80 && sent.length === beforeAskStop; i += 1) await sleep(20)
  for (let i = 0; i < 80 && textOf(chatLog).indexOf('第一段') < 0; i += 1) await sleep(20)
  assert('追问生成中也是「停止」键', sendBtn.getAttribute('data-mode') === 'stop', String(sendBtn.getAttribute('data-mode')))
  sendBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await sleep(120)
  const stoppedTurn = hook.turns()[hook.turns().length - 1]
  assert('点停止打断追问：标记 stopped、不是 error', stoppedTurn && stoppedTurn.stopped === true && !stoppedTurn.error, JSON.stringify({ stopped: stoppedTurn && stoppedTurn.stopped, error: stoppedTurn && stoppedTurn.error }))
  assert('已流出的内容保留下来了', String(stoppedTurn && stoppedTurn.text).indexOf('第一段') >= 0, String(stoppedTurn && stoppedTurn.text).slice(0, 30))
  assert('追问停止也有记录（自检可读）', /已停止/.test(String(hook.state().status || '')), String(hook.state().status))
}

// ───────────────────────── 没有工具时不许伪造调用 ─────────────────────────
hook.open('fake-tool-probe', '', '伪造调用')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
assert('模型吐出的 <ds_safety_tool_call> 被剥掉', textOf(sections[0]).indexOf('ds_safety_tool_call') < 0 && textOf(sections[0]).indexOf('tool_name') < 0, textOf(sections[0]).slice(0, 60))
assert('正文其余内容保留', textOf(sections[0]).indexOf('没有工具时的回答') >= 0, textOf(sections[0]).slice(0, 60))
assert('明确告知"本轮没有可用工具"', textOf(sections[0]).indexOf('没有可用工具') >= 0, textOf(sections[0]).slice(0, 80))
assert('自检钩子报出伪造残渣标记', hook.state().toolResidue === true, String(hook.state().toolResidue))

// ───────────────────────── 追问小窗（临时多轮对话） ─────────────────────────
const askBox = Array.from(walk(panel)).find((n) => n.className === 'dsh-sel-askbox')
const askSend = Array.from(walk(panel)).find((n) => String(n.className).indexOf('dsh-sel-asksend') >= 0)
assert('面板有追问输入框与发送按钮', !!askBox && !!askSend, askBox ? askBox.placeholder.slice(0, 18) : '未找到')

// 输入法组合态按 Enter 不能发送（中文输入"确认候选词"不是发送）
askBox.value = '输入法组合中的半成品'
const beforeIme = sent.length
askBox.dispatch('keydown', { key: 'Enter', isComposing: true, keyCode: 229, preventDefault() {}, stopPropagation() {} })
await new Promise((r) => setTimeout(r, 30))
assert('输入法组合态按 Enter 不发送、也不清空输入框', sent.length === beforeIme && askBox.value.length > 0, `sent=${sent.length - beforeIme} value=${askBox.value}`)
askBox.value = ''

// 空内容按 Enter 不发送
const beforeEmpty = sent.length
askBox.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
await new Promise((r) => setTimeout(r, 30))
assert('空内容按 Enter 不发送', sent.length === beforeEmpty, `sent=${sent.length - beforeEmpty}`)

const beforeAsk = sent.length
hook.ask('为什么不让每个插件自己适配？')
for (let i = 0; i < 80 && hook.state().phase === 'done' && sent.length === beforeAsk; i += 1) {
  await new Promise((r) => setTimeout(r, 20))
}
for (let i = 0; i < 80; i += 1) {
  const turns = hook.turns()
  if (turns.length >= 2 && turns[turns.length - 1].text && turns[turns.length - 1].text.indexOf('这是对追问的回答') >= 0) break
  await new Promise((r) => setTimeout(r, 20))
}
const turns = hook.turns()
assert('追问后出现「用户 + 助手」两条气泡', turns.length >= 2 && turns[turns.length - 2].role === 'user' && turns[turns.length - 1].role === 'assistant', JSON.stringify(turns.map((t) => t.role)))
assert('助手气泡渲染了回答内容', textOf(chatLog).indexOf('这是对追问的回答') >= 0, textOf(chatLog).slice(0, 60))
assert('追问气泡容器可见（不能画进隐藏容器）', chatLog.style.display === 'flex', 'display=' + chatLog.style.display)
const visibleBubbles = Array.from(walk(chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble') >= 0)
assert(
  '小窗只显示「我的问题 + 回答」两条气泡，不重复翻译/详解',
  visibleBubbles.length === 2 &&
    textOf(visibleBubbles[0]).indexOf('为什么不让每个插件自己适配？') >= 0 &&
    textOf(chatLog).indexOf('前情：已就这段选中文字给出解读') < 0,
  visibleBubbles.map((n) => textOf(n).slice(0, 18)).join(' | '),
)
const askPayload = sent[sent.length - 1]
assert(
  '种子轮仍作为历史发给模型（role=assistant）',
  (askPayload.history || []).some((t) => t.role === 'assistant' && t.text.indexOf('前情') >= 0),
  JSON.stringify((askPayload.history || []).map((t) => t.role)),
)
assert('追问请求带 question 与 history', !!askPayload.question && Array.isArray(askPayload.history) && askPayload.history.length >= 1, JSON.stringify({ q: askPayload.question, h: askPayload.history && askPayload.history.length }))
assert('追问请求不带 refresh / effort（走 host 的 chat 档位）', askPayload.refresh === undefined && askPayload.effort === undefined)
assert('追问成功后输入框状态刷新（空内容时发送键禁用）', askSend.disabled === true, 'disabled=' + askSend.disabled)

// 再追问一次：历史里应带上上一轮
hook.ask('那我们自己实现划算吗？')
for (let i = 0; i < 100; i += 1) {
  const list = hook.turns()
  if (list.length >= 4 && list[list.length - 1].text && list[list.length - 1].text.indexOf('划算吗') >= 0) break
  await new Promise((r) => setTimeout(r, 20))
}
const secondPayload = sent[sent.length - 1]
assert('第二轮追问的历史含上一轮问答', (secondPayload.history || []).length >= 3, JSON.stringify((secondPayload.history || []).map((t) => t.role)))

// ───────────────────────── 旧标题兼容（## 语境含义 → 详解节） ─────────────────────────
hook.open('legacy-heading-probe', '', '兼容测试')
for (let i = 0; i < 60 && hook.state().phase !== 'done'; i += 1) {
  await new Promise((r) => setTimeout(r, 20))
}
const legacyState = hook.state()
assert(
  '旧标题「## 语境含义」仍切到详解节',
  (legacyState.sections.detail || '').indexOf('旧标题下的解释') >= 0 && (legacyState.sections.translation || '').indexOf('旧标题兼容') >= 0,
  JSON.stringify(legacyState.sections).slice(0, 120),
)

// ───────────────────────── 首轮等待特效 + CTA 时机（回归） ─────────────────────────
// 痛点：请求发出到第一个字之间（模型思考期可能好几秒）面板一片空白，
// 而底部那时已经躺着一个灰着的「展开详解」，看起来像"卡住了"。
hook.open('slow-probe', '', '等待特效')
const waitAtLoading = classesIn(panel, 'dsh-sel-wait')
assert(
  '请求刚发出（还没收到任何字节）就有等待特效',
  waitAtLoading.length >= 1 && textOf(waitAtLoading[0]).indexOf('正在翻译') >= 0,
  waitAtLoading.length ? JSON.stringify(textOf(waitAtLoading[0]).slice(0, 24)) : '未找到等待节点',
)
assert('等待特效是动态的（呼吸点 + 流光骨架条）', classesIn(panel, 'dsh-sel-dots').length >= 1 && classesIn(panel, 'dsh-sel-sk').length >= 2, `dots=${classesIn(panel, 'dsh-sel-dots').length} sk=${classesIn(panel, 'dsh-sel-sk').length}`)
assert('首轮翻译还没出字时，展开 CTA 不显示', expandBtn.style.display === 'none', 'display=' + JSON.stringify(expandBtn.style.display))
assert('等待特效里预留了秒数与提示位（不重建节点也能更新）', classesIn(panel, 'dsh-sel-waitclock').length === 1 && classesIn(panel, 'dsh-sel-waithint').length === 1)
const waitNodeA = classesIn(panel, 'dsh-sel-wait')[0]
await sleep(330)
assert('收到 start（模型思考期）等待特效仍在，不空窗', classesIn(panel, 'dsh-sel-wait').length >= 1 && hook.state().phase === 'streaming', `phase=${hook.state().phase}`)
const waitNodeB = classesIn(panel, 'dsh-sel-wait')[0]
// 关键回归：中间来过一次重绘（空 delta），等待节点必须是同一个——每帧重建会让 CSS 动画
// 从 0% 重头开始，视觉上就是"一直在闪"
assert('重绘不会重建等待节点（动画不被打断成闪烁）', !!waitNodeA && waitNodeA === waitNodeB, waitNodeA === waitNodeB ? '同一节点' : '被重建了')
let clockText = ''
for (let i = 0; i < 20; i += 1) {
  clockText = textOf(classesIn(panel, 'dsh-sel-waitclock')[0] || new FakeEl('span'))
  if (/^\d+\.\ds$/.test(clockText.trim())) break
  await sleep(40)
}
assert('等待特效里在走秒（≥0.3s 才显示）', /^\d+\.\ds$/.test(clockText.trim()), JSON.stringify(clockText))
const hintText = textOf(classesIn(panel, 'dsh-sel-waithint')[0] || new FakeEl('div'))
assert('等待里能看到模型在想什么（thought 事件）', hintText.indexOf('先判断这段英文') >= 0, JSON.stringify(hintText))
await sleep(600)
const waitAfterDone = classesIn(panel, 'dsh-sel-wait')
assert('翻译出完后等待特效消失', waitAfterDone.length === 0 && hook.state().phase === 'done', `phase=${hook.state().phase} wait=${waitAfterDone.length}`)
assert('翻译出完后展开 CTA 才出现（不再灰着等人）', expandBtn.style.display !== 'none', 'display=' + JSON.stringify(expandBtn.style.display))

// ───────────────────────── 第一节标题：有英文 → 翻译 / 纯中文 → 解读 ─────────────────────────
const sectionTitles = () => Array.from(walk(panel)).filter((n) => n.className === 'dsh-sel-sh').map((n) => textOf(n).trim())
hook.open('slipped', '', '英文标题')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
assert('选中文字含英文 → 第一节标题是「翻译」', sectionTitles()[0] === '翻译', JSON.stringify(sectionTitles()))
hook.open('中文标题探测', '', '中文标题')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
assert('选中文字全是中文 → 第一节标题改叫「解读」', sectionTitles()[0] === '解读', JSON.stringify(sectionTitles()))
assert('纯中文时模型写 `## 解读` 也进第一节（不被丢进 other）', textOf(sections[0]).indexOf('把临时窗口变成正式会话') >= 0, textOf(sections[0]).slice(0, 40))
assert('纯中文解读内容渲染完整（含结论行）', textOf(sections[0]).indexOf('在本句中') >= 0)
hook.open('the migration ran long', '', '英文标题2')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
assert('再换成英文选区，标题又变回「翻译」', sectionTitles()[0] === '翻译', JSON.stringify(sectionTitles()))

// ───────────────────────── 追问滚动：贴底跟随 / 翻上去不拽回 ─────────────────────────
const panelBody = Array.from(walk(panel)).find((n) => n.className === 'dsh-sel-body')
assert('找到面板滚动容器', !!panelBody, panelBody ? panelBody.className : '未找到')
panelBody.scrollHeight = 1200
panelBody.clientHeight = 400
panelBody.scrollTop = 800 // 800 + 400 = 1200：贴着底
hook.open('slow-ask-probe', '', '滚动用例')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
panelBody.scrollHeight = 1200
panelBody.clientHeight = 400
panelBody.scrollTop = 800
hook.ask('滚动测试')
await sleep(10)
assert('追问发送后立刻回到底部（问题可见）', panelBody.scrollTop === panelBody.scrollHeight, `scrollTop=${panelBody.scrollTop} scrollHeight=${panelBody.scrollHeight}`)
await sleep(90)
assert('回答流式期间持续贴底', panelBody.scrollTop === panelBody.scrollHeight, `scrollTop=${panelBody.scrollTop} scrollHeight=${panelBody.scrollHeight}`)

// 发完之后内容还会异步长高（思考尾巴 / 预览 iframe 上报新高度 / 面板切宽版重排）——
// 只在 renderTurns 里贴一次不够，这正是"点了发送消息没跟到最新位置"的成因
{
  assert('发送后进入"跟随最新消息"状态', hook.state().follow === true, String(hook.state().follow))
  panelBody.scrollHeight = 2000
  for (const ro of resizeObservers) ro.fire()
  assert('内容异步长高后自动再贴底（ResizeObserver）', panelBody.scrollTop === 2000, `scrollTop=${panelBody.scrollTop}`)
  // 用户自己往上滚 → 收回跟随，不再被拉回底部
  panelBody.dispatch('wheel', { deltaY: -120 })
  assert('用户往上滚后放弃跟随', hook.state().follow === false, String(hook.state().follow))
  panelBody.scrollHeight = 2600
  for (const ro of resizeObservers) ro.fire()
  assert('放弃跟随后内容再长也不抢滚动条', panelBody.scrollTop === 2000, `scrollTop=${panelBody.scrollTop}`)
  // 滚回底部 → 重新跟随
  panelBody.scrollTop = panelBody.scrollHeight
  panelBody.dispatch('wheel', { deltaY: 120 })
  assert('滚回底部后重新跟随', hook.state().follow === true, String(hook.state().follow))
}
panelBody.scrollTop = 100 // 模拟用户往上翻去看前面的内容
await sleep(140)
assert('用户往上翻之后不再被拽回底部', panelBody.scrollTop === 100, `scrollTop=${panelBody.scrollTop}`)
assert('翻上去期间回答仍在继续渲染', textOf(chatLog).indexOf('第三段回答') >= 0 || textOf(chatLog).indexOf('第二段回答') >= 0, textOf(chatLog).slice(0, 40))

// ───────────────────────── 关闭策略：点面板外永不关闭；✕ / Esc / 胶囊可关 ─────────────────────────
hook.open('slow-ask-probe', '', '关闭策略-未追问')
await sleep(80)
documentStub.dispatch('mousedown', { target: new FakeEl('div') })
assert('没追问时点面板外也不关闭（答案不能被误关掉）', panel.style.display === 'flex', 'display=' + panel.style.display)

hook.open('slow-probe', '', '关闭策略')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
hook.ask('这个改动会不会影响缓存前缀？')
for (let i = 0; i < 100; i += 1) {
  const list = hook.turns()
  if (list.length >= 2 && list[list.length - 1].text) break
  await sleep(20)
}
assert('关闭策略用例已产生对话内容', hook.turns().length >= 2, JSON.stringify(hook.turns().map((t) => t.role)))
histBtn.dispatch('click', { stopPropagation() {} })
await sleep(60)
documentStub.dispatch('mousedown', { target: histList })
assert('点列表内部不算"点外面"（面板不关）', panel.style.display === 'flex', 'display=' + panel.style.display)
assert('点列表内部侧边栏也不收', histList.style.display === 'flex', 'display=' + histList.style.display)
// 点别处：侧边栏收回，但"追问过"的面板照旧留着
documentStub.dispatch('mousedown', { target: new FakeEl('div') })
assert('点别处侧边栏收回', histList.style.display === 'none', 'display=' + histList.style.display)
assert('侧边栏收回不影响面板本身', panel.style.display === 'flex', 'display=' + panel.style.display)
// 点面板正文（消息区）也要收回侧边栏
histBtn.dispatch('click', { stopPropagation() {} })
await sleep(60)
assert('（前置）侧边栏已打开', histList.style.display === 'flex', 'display=' + histList.style.display)
documentStub.dispatch('mousedown', { target: chatLog })
assert('点小窗消息区域收回侧边栏', histList.style.display === 'none', 'display=' + histList.style.display)
assert('点消息区域不关面板', panel.style.display === 'flex', 'display=' + panel.style.display)
histBtn.dispatch('click', { stopPropagation() {} })
await sleep(60)
documentStub.dispatch('mousedown', { target: askBox })
assert('点输入框也收回侧边栏', histList.style.display === 'none', 'display=' + histList.style.display)
histBtn.dispatch('click', { stopPropagation() {} })
await sleep(60)
assert('「最近」按钮能再次打开（开关没被收回逻辑破坏）', histList.style.display === 'flex', 'display=' + histList.style.display)
// 页面滚动也收回；滚动列表自身不收（此刻列表是开着的）
windowStub._listeners.get('scroll')[0]({ target: histList })
assert('滚动列表自身不会把它收掉', histList.style.display === 'flex', 'display=' + histList.style.display)
windowStub._listeners.get('scroll')[0]({ target: body })
assert('页面滚动会收回侧边栏', histList.style.display === 'none', 'display=' + histList.style.display)
histBtn.dispatch('click', { stopPropagation() {} })
documentStub.dispatch('mousedown', { target: new FakeEl('div') })
assert('追问后点面板外不关闭', panel.style.display === 'flex', 'display=' + panel.style.display)
assert('面板外点击/滚动不会打断正在渲染的对话', textOf(chatLog).indexOf('这是对追问的回答') >= 0)
assert('追问后点面板外仍然不关闭（对照：上面连点了两次）', panel.style.display === 'flex', 'display=' + panel.style.display)
// Esc：任何时候都能关（这一版把"追问后不许 Esc"的限制去掉了）
documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
assert('追问后 Esc 也能关闭（不受"有没有追问过"限制）', panel.style.display === 'none', 'display=' + panel.style.display)
// ✕ 仍然能关（换一个场景再验一次）
hook.open('slow-probe', '', '关闭策略-✕')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
const closeBtn = Array.from(walk(panelHead)).find((n) => n.className === 'dsh-sel-icon')
closeBtn.dispatch('click', { stopPropagation() {} })
assert('点右上角 ✕ 仍然能关闭', panel.style.display === 'none', 'display=' + panel.style.display)

// ───────────────────────── 选中代码：逐句注释 + 代码块 + 小结 ─────────────────────────
hook.open(CODE_SNIPPET, 'DSH 插件的文本截断逻辑', '代码')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
const codePayload = sent[sent.length - 1]
assert('代码选区在载荷里标成 kind=code', codePayload.kind === 'code' && codePayload.text === CODE_SNIPPET, JSON.stringify({ kind: codePayload.kind }))
assert('代码选区的第一节标题是「注释」', sectionTitles()[0] === '注释', JSON.stringify(sectionTitles()))
const codeBlocks = classesIn(sections[0], 'dsh-sel-pre')
assert('代码用代码块渲染（pre 节点）', codeBlocks.length === 1, `pre=${codeBlocks.length}`)
assert('代码块里是原样代码', textOf(codeBlocks[0]).indexOf('function clampText(text)') >= 0 && textOf(codeBlocks[0]).indexOf('const MAX = 4000') >= 0, textOf(codeBlocks[0]).slice(0, 60))
assert('注释与代码在同一个代码块里（块外没有逐句注释列表）', classesIn(sections[0], 'dsh-sel-item').length === 0, `items=${classesIn(sections[0], 'dsh-sel-item').length}`)
const preText = textOf(codeBlocks[0])
assert('注释贴着对应语句、顺序一致', /定义文本长度上限[\s\S]*const MAX = 4000[\s\S]*声明一个把文本截断到上限的函数[\s\S]*function clampText/.test(preText), preText.slice(0, 80))
const cmtSpans = classesIn(codeBlocks[0], 'dsh-sel-pre-cmt')
assert('注释行被标成注释（弱化显示）', cmtSpans.length === 3 && textOf(cmtSpans[0]).trim() === '// 定义文本长度上限', `cmt=${cmtSpans.length}`)
assert('代码行没有被当成注释', !cmtSpans.some((n) => textOf(n).indexOf('const MAX = 4000') >= 0), cmtSpans.map((n) => textOf(n).trim()).join(' | '))
const codeCallouts = classesIn(sections[0], 'dsh-sel-callout')
assert('最后的总结渲染成结论条（小结）', codeCallouts.length === 1 && textOf(codeCallouts[0]).indexOf('小结') >= 0 && textOf(codeCallouts[0]).indexOf('按 4000 字截断') >= 0, textOf(codeCallouts[0]).slice(0, 50))
// 语法高亮：关键字/数字/函数名/注释各自上色
const hl = (root, cls) => classesIn(root, cls).map((n) => textOf(n))
assert('关键字上色', hl(codeBlocks[0], 'dsh-hl-kw').join(',') === 'const,function,return', hl(codeBlocks[0], 'dsh-hl-kw').join(','))
assert('数字上色', hl(codeBlocks[0], 'dsh-hl-num').indexOf('4000') >= 0, hl(codeBlocks[0], 'dsh-hl-num').join(','))
assert('函数名上色', hl(codeBlocks[0], 'dsh-hl-fn').indexOf('clampText') >= 0 && hl(codeBlocks[0], 'dsh-hl-fn').indexOf('slice') >= 0, hl(codeBlocks[0], 'dsh-hl-fn').join(','))
assert('行尾注释也上色', hl(codeBlocks[0], 'dsh-hl-com').length === 3, hl(codeBlocks[0], 'dsh-hl-com').join(' | '))
// 折行：注释行整行可折（不顶出小窗），代码行不折（长代码宁可横向滚动）
const preLines = codeBlocks[0].children.filter((n) => n.className === 'dsh-sel-pre-line')
assert('代码块逐行成块', preLines.length === 7, `lines=${preLines.length}`)
const wrapLines = preLines.filter((n) => n.getAttribute('data-wrap') === '1')
assert('注释行可折行、代码行不折', wrapLines.length === 3 && wrapLines.every((n) => textOf(n).trim().indexOf('//') === 0), `wrap=${wrapLines.length}`)
assert('代码行没有被标成可折行', !preLines.some((n) => n.getAttribute('data-wrap') === '1' && textOf(n).indexOf('const MAX') >= 0), preLines.map((n) => n.getAttribute('data-wrap') || '-').join(','))
// 折行缩进：续行必须从注释起始列开始（padding-left 与 text-indent 等值反向）
const indented = preLines.filter((n) => n.style.paddingLeft)
assert('注释行的续行有悬挂缩进（padding 与负 text-indent 等值）', indented.length === 1 && indented[0].style.paddingLeft === '2ch' && indented[0].style.textIndent === '-2ch', indented.map((n) => n.style.paddingLeft + '/' + n.style.textIndent).join(','))
// 行尾注释：拆成独立注释行，缩进 = 它在原行的起始列（这里第 8 列）
const trailing = ['const a = 1 // 尾注', 'def b():  # 尾注']
hook.open('尾注探测', '', '尾注')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
const trailLines = classesIn(sections[0], 'dsh-sel-pre-line')
assert('行尾注释被拆成独立注释行', trailLines.length === 2 && textOf(trailLines[0]).trim() === 'const a = 1' && textOf(trailLines[1]).trim() === '// 尾注', trailLines.map((n) => JSON.stringify(textOf(n))).join(' , '))
assert('行尾注释的缩进等于它原来的起始列', trailLines[1].style.paddingLeft === '12ch' && trailLines[1].style.textIndent === '-12ch', trailLines[1].style.paddingLeft + '/' + trailLines[1].style.textIndent)
assert('代码块带主题标记（按底色选调色板）', codeBlocks[0].getAttribute('data-hl') === 'light' || codeBlocks[0].getAttribute('data-hl') === 'dark', String(codeBlocks[0].getAttribute('data-hl')))
// 语言标记生效：python 的 # 是注释、def/return 是关键字
hook.open(PY_SNIPPET, '上下文', '代码')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
const pyBlock = classesIn(sections[0], 'dsh-sel-pre')[0]
assert('python 语言标记生效：# 行是注释', hl(pyBlock, 'dsh-hl-com').some((t) => t.indexOf('# 两数相加') >= 0), hl(pyBlock, 'dsh-hl-com').join(' | '))
assert('python 关键字上色', hl(pyBlock, 'dsh-hl-kw').indexOf('def') >= 0 && hl(pyBlock, 'dsh-hl-kw').indexOf('return') >= 0, hl(pyBlock, 'dsh-hl-kw').join(','))
assert('python 代码未被当成 javascript 注释规则', pyBlock.textContent.indexOf('def add(a, b):') >= 0, pyBlock.textContent.slice(0, 40))

// 散文不能被误判成代码
hook.open(PROSE_PROBE, '', '非代码')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
assert('普通文本仍标 kind=text（不误判成代码）', sent[sent.length - 1].kind === 'text' && sent[sent.length - 1].text === PROSE_PROBE, JSON.stringify({ kind: sent[sent.length - 1].kind }))
assert('普通文本标题不受影响', sectionTitles()[0] === '翻译', JSON.stringify(sectionTitles()))

// ───────────────────────── 追问也要有等待特效（和首轮同一套） ─────────────────────────
hook.open('wait-ask-probe', '', '追问等待')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
hook.ask('这个要等多久？')
await sleep(40)
const askBubbles = () => Array.from(walk(chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble-bot') >= 0)
let waitInBubble = classesIn(askBubbles()[askBubbles().length - 1], 'dsh-sel-wait')
assert('追问等待期：助手气泡里出现等待特效', waitInBubble.length === 1 && textOf(waitInBubble[0]).indexOf('正在回答') >= 0, waitInBubble.length ? JSON.stringify(textOf(waitInBubble[0]).slice(0, 20)) : '未找到')
assert('追问等待特效是动态的（呼吸点 + 流光条）', classesIn(waitInBubble[0] || new FakeEl('div'), 'dsh-sel-dots').length === 1 && classesIn(waitInBubble[0] || new FakeEl('div'), 'dsh-sel-sk').length >= 1, '')
const askWaitNode = waitInBubble[0]
let askClock = ''
for (let i = 0; i < 14; i += 1) {
  const nodes = classesIn(askBubbles()[askBubbles().length - 1], 'dsh-sel-waitclock')
  askClock = nodes.length ? textOf(nodes[0]) : ''
  if (/^\d+\.\ds$/.test(askClock.trim())) break
  await sleep(40)
}
assert('追问等待期在走秒', /^\d+\.\ds$/.test(askClock.trim()), JSON.stringify(askClock))
assert('追问等待期不重建节点（动画不被打断）', classesIn(askBubbles()[askBubbles().length - 1], 'dsh-sel-wait')[0] === askWaitNode, '')
await sleep(400)
const botBubbles = askBubbles()
assert('首个字到达后等待特效换成正文', classesIn(botBubbles[botBubbles.length - 1], 'dsh-sel-wait').length === 0 && textOf(botBubbles[botBubbles.length - 1]).indexOf('等到了回答') >= 0, JSON.stringify(textOf(botBubbles[botBubbles.length - 1]).slice(0, 24)))

// ───────────────────────── 本地缓存：同一个词再点一次必须秒回 ─────────────────────────
hook.open('缓存探测词', '上下文片段 A', '缓存用例')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
assert('首次打开发出请求并落到本地缓存', hook.state().cache === 'miss' && textOf(sections[0]).indexOf('缓存测试内容') >= 0, `cache=${hook.state().cache}`)
const sentAfterFirst = sent.length
const t0open = Date.now()
hook.open('缓存探测词', '上下文片段 A', '缓存用例')
const openMs = Date.now() - t0open
assert('同词同处再打开：不发请求（本地缓存命中）', sent.length === sentAfterFirst, `新增请求 ${sent.length - sentAfterFirst}`)
assert('命中时同步渲染（不用等）', hook.state().phase === 'done' && textOf(sections[0]).indexOf('缓存测试内容') >= 0, `phase=${hook.state().phase} openMs=${openMs}`)
assert('本地缓存标记仍在（自检可读）', /本地缓存/.test(String(hook.state().status || '')) && hook.state().cache === 'local', `${hook.state().cache} / ${hook.state().status}`)
assert('自检钩子报出命中情况', hook.state().cache === 'local', String(hook.state().cache))
const sentBeforeSpace = sent.length
hook.open('缓存探测词 ', '上下文片段 A  ', '缓存用例')
assert('多选一个空格也算命中（key 做了空白归一）', sent.length === sentBeforeSpace, `新增请求 ${sent.length - sentBeforeSpace}`)
// 展开详解：结果要写回同一个 key（以前传 null，点一次跑一次）
// 先切回原始选区文本（上一步的 hook.open 带了尾空格，会打到 live fixture 之外）
hook.open('缓存探测词', '上下文片段 A', '缓存用例')
hook.expand()
for (let i = 0; i < 80 && !(hook.parts().detail || '').trim(); i += 1) await sleep(20)
assert('展开详解产出内容', (hook.parts().detail || '').indexOf('详解内容') >= 0, JSON.stringify(hook.parts().detail))
const sentAfterDetail = sent.length
hook.open('缓存探测词', '上下文片段 A', '缓存用例')
assert('展开后再打开：连详解一起命中，不发请求', sent.length === sentAfterDetail, `新增请求 ${sent.length - sentAfterDetail}`)
assert('缓存里带着详解（两节都回来）', textOf(sections[1]).indexOf('详解内容') >= 0 && sections[1].style.display !== 'none', `detail=${textOf(sections[1]).slice(0, 20)} display=${sections[1].style.display}`)
assert('两节都有时展开 CTA 隐藏', expandBtn.style.display === 'none', `display=${expandBtn.style.display}`)

// 同词不同上下文：命中不了要说明白，而不是让用户以为缓存坏了
const sentBeforeOther = sent.length
hook.open('缓存探测词', '完全不同的上下文片段 B', '缓存用例')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
assert('同词不同上下文会重新请求（缓存按上下文区分）', sent.length > sentBeforeOther, `新增请求 ${sent.length - sentBeforeOther}`)
assert('"同词但上下文不同"仍有记录', /同词但上下文不同/.test(String(hook.state().status || '')) && hook.state().sameTextSeen === true, `${hook.state().sameTextSeen} / ${hook.state().status}`)
assert('自检钩子报出 sameTextSeen', hook.state().sameTextSeen === true, String(hook.state().sameTextSeen))

// ───────────────────────── A′：小窗对话历史（落库 / 回放 / 列表） ─────────────────────────
hook.open('缓存探测词', '上下文片段 A', '缓存用例')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
hook.ask('历史写入测试')
for (let i = 0; i < 80 && textOf(chatLog).indexOf('这是对追问的回答') < 0; i += 1) await sleep(20)
await sleep(60)
const saved = historySaved[historySaved.length - 1] || {}
assert('追问结束后整段对话写回历史', saved.key && saved.parts && saved.parts.translation.indexOf('缓存测试内容') >= 0, JSON.stringify({ key: String(saved.key || '').slice(0, 12), t: (saved.parts || {}).translation?.slice(0, 12) }))
assert('历史里带着追问轮次（不含隐藏的种子轮）', Array.isArray(saved.turns) && saved.turns.filter((t) => t.role === 'user').length === 1 && !saved.turns.some((t) => String(t.text).indexOf('前情') === 0), JSON.stringify((saved.turns || []).map((t) => t.role)))
assert('历史里带着工具结果摘要字段', typeof saved.toolDigest === 'string', typeof saved.toolDigest)
// 模拟"刷新页面"：清掉浏览器内存缓存，历史应当把它救回来（且不再调模型）
hook.forget()
const sentBeforeRestore = sent.length
hook.open('缓存探测词', '上下文片段 A', '缓存用例')
for (let i = 0; i < 60 && hook.state().cache !== 'history'; i += 1) await sleep(20)
assert('刷新后重开同一个词：从历史回放', hook.state().cache === 'history', String(hook.state().cache))
assert('历史回放不调模型（请求数为 0）', sent.length === sentBeforeRestore, `新增请求 ${sent.length - sentBeforeRestore}`)
assert('回放带回翻译正文', textOf(sections[0]).indexOf('缓存测试内容') >= 0, textOf(sections[0]).slice(0, 24))
assert('回放带回追问记录（气泡都在）', textOf(chatLog).indexOf('历史写入测试') >= 0 && textOf(chatLog).indexOf('这是对追问的回答') >= 0, textOf(chatLog).slice(0, 40))
assert('历史回放标记仍在（自检可读）', /历史回放/.test(String(hook.state().status || '')) && hook.state().cache === 'history', `${hook.state().cache} / ${hook.state().status}`)
// 「最近聊过的」列表
assert('头部有「最近」入口', !!histBtn, histBtn ? textOf(histBtn) : '未找到')
histBtn.dispatch('click', { stopPropagation() {} })
for (let i = 0; i < 40 && !Array.from(walk(histList)).some((n) => n.className === 'dsh-sel-historyrow'); i += 1) await sleep(20)
const rows = Array.from(walk(histList)).filter((n) => n.className === 'dsh-sel-historyrow')
const targetRow = rows.find((n) => textOf(n).indexOf('缓存探测词') >= 0)
assert('列表贴在面板右侧（右侧放得下就不翻边）', histList.getAttribute('data-side') === 'right' && histList.style.left === '510px', `side=${histList.getAttribute('data-side')} left=${histList.style.left}`)
assert('列表高度跟面板对齐（自带滚动）', /px$/.test(histList.style.maxHeight || ''), String(histList.style.maxHeight))
assert('「最近聊过的」列出历史条目', rows.length >= 1 && !!targetRow, `rows=${rows.length} 首行=${textOf(rows[0] || new FakeEl('div')).slice(0, 24)}`)
assert('条目显示位置/轮数/时间', !!targetRow && /会话消息|缓存用例|页面|消息|代码/.test(textOf(targetRow)) && /\d+ 轮/.test(textOf(targetRow)), textOf(targetRow || new FakeEl('div')).slice(0, 50))
const rowParts = targetRow ? targetRow.children : []
assert(
  '标题与小字分两行（标题不再被挤），且行尾带一个删除键',
  rowParts.length === 3 &&
    rowParts[0].className === 'dsh-sel-historytext' &&
    rowParts[1].className === 'dsh-sel-historydel' &&
    rowParts[2].className === 'dsh-sel-historymeta',
  rowParts.map((n) => n.className).join(','),
)
assert('标题文字完整（未被截断成省略号的短写）', textOf(rowParts[0]).indexOf('缓存探测词') >= 0, textOf(rowParts[0]))
const sentBeforeClick = sent.length
targetRow.dispatch('click', { stopPropagation() {} })
await sleep(80)
assert('点一条能把那段对话调回面板（不调模型）', sent.length === sentBeforeClick && textOf(sections[0]).indexOf('缓存测试内容') >= 0, `新增请求 ${sent.length - sentBeforeClick}`)
assert('点完之后列表收起', histList.style.display === 'none', String(histList.style.display))

// Esc：一次到位 —— 面板与侧边栏一起收（原先"第一下只收列表"那一级已按需求合并）
const escEv = { key: 'Escape', preventDefault() {}, stopPropagation() {} }
histBtn.dispatch('click', { stopPropagation() {} })
await sleep(60)
assert('再次打开列表', histList.style.display === 'flex', String(histList.style.display))
documentStub.dispatch('keydown', escEv)
assert('Esc 一次关掉整个小窗（含侧边栏）', histList.style.display === 'none' && panel.style.display === 'none', `list=${histList.style.display} panel=${panel.style.display}`)

// 稳定 key：选中文字**之后**的上下文变长（主会话追加了新消息），不该换 key
hook.forget()
hook.open('稳定key探测', '尾部上下文 A', '会话消息', '前缀这一段是固定的')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
const keyA = hook.state().cacheKey
const sentAfterKeyA = sent.length
hook.forget()
hook.open('稳定key探测', '尾部上下文 B：主会话又追加了好几条新消息，窗口后半段完全变了', '会话消息', '前缀这一段是固定的')
for (let i = 0; i < 60 && hook.state().cache !== 'history'; i += 1) await sleep(20)
assert('尾部上下文变化不换 key（同词同前缀 → 同一个 key）', keyA === hook.state().cacheKey, `A=${keyA} B=${hook.state().cacheKey}`)
assert('尾部上下文变化后仍命中历史（不再重新生成一个）', hook.state().cache === 'history' && sent.length === sentAfterKeyA, `cache=${hook.state().cache} 新增请求=${sent.length - sentAfterKeyA}`)

// ───────────────────────── 悬浮状态胶囊（右下角，点击回到最近一次小窗） ─────────────────────────
const pill = Array.from(walk(panel.parentNode)).find((n) => n.className === 'dsh-sel-pill')
assert('右下角有状态胶囊', !!pill, pill ? pill.className : '未找到')
assert(
  '胶囊结构和费用胶囊同构：圆点 + 主体 + 次要 + 箭头',
  !!pill &&
    ['dsh-sel-pilldot', 'dsh-sel-pillname', 'dsh-sel-pillmeta', 'dsh-sel-pillcaret'].every((c) =>
      Array.from(walk(pill)).some((n) => n.className === c),
    ),
  pill ? walk(pill).next().value.className : '',
)
assert('箭头用和费用胶囊同一个字符 ▴ / ▾（不是大三角 ▲ ▼）', textOf(pill).indexOf('▲') < 0 && textOf(pill).indexOf('▼') < 0, textOf(pill))

// 进行中：圆点在呼吸（tone=busy），文本报阶段 + 秒数
hook.open('wait-ask-probe', '', '胶囊探测')
for (let i = 0; i < 20 && pill.getAttribute('data-tone') !== 'busy'; i += 1) await sleep(20)
assert('进行中胶囊是 busy 态', pill.getAttribute('data-tone') === 'busy', String(pill.getAttribute('data-tone')))
assert('进行中胶囊报阶段', /翻译中|生成中|检索中/.test(textOf(pill)), textOf(pill))
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
assert('完成后胶囊带选中的词', textOf(pill).indexOf('wait-ask-pro') >= 0, textOf(pill))
assert('完成后胶囊是 done 态', pill.getAttribute('data-tone') === 'done', String(pill.getAttribute('data-tone')))
assert('小窗开着时箭头朝下（▾）', textOf(pill).indexOf('▾') >= 0, textOf(pill))

// 关闭小窗后：点胶囊回到刚才那个小窗，且**不再请求**
hook.close()
const sentBeforeReopen = sent.length
assert('关闭后胶囊箭头朝上（▴，可点回）', textOf(pill).indexOf('▴') >= 0, textOf(pill))
pill.dispatch('click', { preventDefault() {}, stopPropagation() {} })
await sleep(30)
assert('点胶囊把最近一次小窗开回来', panel.style.display !== 'none', String(panel.style.display))
assert('重开用的是内存里的状态，不再调模型', sent.length === sentBeforeReopen, `新增请求 ${sent.length - sentBeforeReopen}`)
assert('重开后内容还在', textOf(sections[0]).indexOf('等待用例的翻译') >= 0, textOf(sections[0]).slice(0, 40))

// 再点一次 = 收起（开关行为）
{
  const sentBeforeToggle = sent.length
  assert('收起前小窗是开着的', panel.style.display !== 'none', String(panel.style.display))
  // 真实点击会先派发 mousedown（document 上那个"点外面就收起"的监听在捕获阶段跑），
  // 它必须把胶囊排除掉；否则先关一次、click 再开一次 → 表现成"点胶囊没反应"
  documentStub.dispatch('mousedown', { target: pill })
  await sleep(20)
  assert('胶囊上的 mousedown 不算"点了外面"', panel.style.display !== 'none', String(panel.style.display))
  // 完整模拟一次真实点击：mousedown → mouseup → click
  documentStub.dispatch('mousedown', { target: pill })
  pill.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await sleep(30)
  assert('开着时点胶囊 → 收起小窗', panel.style.display === 'none', String(panel.style.display))
  assert('收起不重新请求', sent.length === sentBeforeToggle, `新增请求 ${sent.length - sentBeforeToggle}`)
  pill.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await sleep(30)
  assert('再点一次 → 原样打开（内容还在）', panel.style.display !== 'none' && textOf(sections[0]).indexOf('等待用例的翻译') >= 0, textOf(sections[0]).slice(0, 30))
  assert('开合两次也没有新请求', sent.length === sentBeforeToggle, `新增请求 ${sent.length - sentBeforeToggle}`)
}

// 刷新过页面（内存里没有小窗了）：点胶囊 → 从 host 历史回放最近一条
hook.reset()
assert('重置后胶囊回到就绪态', textOf(pill).indexOf('就绪') >= 0, textOf(pill))
hook.open('缓存探测词', '上下文片段', '兜底回放')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
hook.reset()
const sentBeforeReplay = sent.length
pill.dispatch('click', { preventDefault() {}, stopPropagation() {} })
for (let i = 0; i < 80 && panel.style.display === 'none'; i += 1) await sleep(20)
for (let i = 0; i < 40 && !textOf(sections[0]).trim(); i += 1) await sleep(20)
assert('内存空了也能回放最近一条小窗', panel.style.display !== 'none' && textOf(sections[0]).trim().length > 0, textOf(sections[0]).slice(0, 40))
assert('回放走的是历史，不重新调模型', sent.length === sentBeforeReplay, `新增请求 ${sent.length - sentBeforeReplay}`)

// 收起小窗 = 中止这一轮，不该记成"失败"，而是"已停止"（点回来还能重新生成）
const slowStart = sent.length
hook.open('中止探测', '', '中止用例')
for (let i = 0; i < 40 && sent.length === slowStart; i += 1) await sleep(20)
for (let i = 0; i < 40 && hook.state().phase !== 'streaming'; i += 1) await sleep(20)
hook.close()
for (let i = 0; i < 60 && hook.state().phase !== 'paused'; i += 1) await sleep(20)
assert('收起小窗中止的那轮记成"已停止"而不是失败', hook.state().phase === 'paused', hook.state().phase)
assert('胶囊显示已停止', pill.getAttribute('data-tone') === 'paused' && textOf(pill).indexOf('已停止') >= 0, textOf(pill))
pill.dispatch('click', { preventDefault() {}, stopPropagation() {} })
await sleep(30)
assert('点回来看到"已停止"的状态与可重试入口', hook.state().phase === 'paused' && !!Array.from(walk(panel)).find((n) => String(n.className).indexOf('dsh-sel-retry') >= 0), `phase=${hook.state().phase}`)

// 没有费用插件时，胶囊应该贴页面底部（以前兜底是 bottom:64，会悬在半空）
{
  globalThis.__fakeSpendWidget = null
  hook.place()
  assert('没有费用胶囊时贴底（right:20 / bottom:20）', pill.style.right === '20px' && pill.style.bottom === '20px', `${pill.style.right} / ${pill.style.bottom}`)
}

// 胶囊宽度写死成下方费用胶囊的宽度，不随文字伸缩
{
  // 挂一枚假的费用胶囊（真 CSS 里就是 .dsh-spend-widget > .dsu-pill），量到多宽就写多宽
  // 照真实结构搭：外层 div#dsh-spend-widget（无 class）> div.dsu-widget > button.dsu-pill
  const spendOuter = new FakeEl('div')
  spendOuter.id = 'dsh-spend-widget'
  const spendWidget = new FakeEl('div')
  spendWidget.className = 'dsu-widget'
  const spendCapsule = new FakeEl('button')
  spendCapsule.className = 'dsu-pill'
  spendCapsule.getBoundingClientRect = () => ({ left: 300, top: 700, right: 444, bottom: 732, width: 144, height: 32 })
  spendWidget.appendChild(spendCapsule)
  spendOuter.appendChild(spendWidget)
  body.appendChild(spendOuter)
  globalThis.__fakeSpendWidget = spendOuter

  hook.place()
  assert('按 id 找到费用容器（真实 DOM 没有 class）', Array.from(walk(spendOuter)).some((n) => n.className === 'dsu-pill'), '')
  assert('胶囊宽度 = 费用胶囊宽度（144px）', pill.style.width === '144px', String(pill.style.width))
  assert('贴位置一次就够：第二次量到没变化（用于退避判断）', hook.place() === false, String(hook.place()))
  assert('胶囊靠右对齐费用胶囊的右边缘', pill.style.right === '996px', String(pill.style.right))

  // 换一段长得多的选中文字再跑一轮：宽度不该变
  hook.open('wait-ask-probe', '', '宽度探测：一段明显更长的选中文字，用来验证胶囊不会跟着变宽')
  for (let i = 0; i < 60 && hook.state().phase !== 'done'; i += 1) await sleep(20)
  assert('文字变长后胶囊宽度不变', pill.style.width === '144px', String(pill.style.width))
  assert('名字那格可缩（长文字走省略号）', String(Array.from(walk(pill)).find((n) => n.className === 'dsh-sel-pillname').className) === 'dsh-sel-pillname', '')
  // 假费用胶囊留着给下一段"退避"用例用，那里用完再撤
}

// 贴位置的节奏会自适应退避：没变化就逐次拉长（封顶 15s），一有变化立刻回到最快
{
  const delays = [hook.pollStep(), hook.pollStep(), hook.pollStep(), hook.pollStep(), hook.pollStep(), hook.pollStep()]
  const grows = delays.every((d, i) => i === 0 || d === Math.min(60000, Math.round(delays[i - 1] * 1.5)) || d === 2000)
  assert('没变化 → 间隔按 ×1.5 逐次拉长', grows, JSON.stringify(delays))
  // 继续走几步，确认封顶是 60s
  let last = delays[delays.length - 1]
  for (let i = 0; i < 12 && last !== 60000; i += 1) last = hook.pollStep()
  assert('封顶 60s', last === 60000 && hook.pollStep() === 60000, String(last))
  // 费用胶囊变宽 → 下一步就该发现变化，并把节奏打回最快
  const fake = globalThis.__fakeSpendWidget
  const capsule = fake && Array.from(walk(fake)).find((n) => n.className === 'dsu-pill')
  if (capsule) capsule.getBoundingClientRect = () => ({ left: 300, top: 700, right: 460, bottom: 732, width: 160, height: 32 })
  assert('发现变化 → 节奏立刻回到 2s', hook.pollStep() === 2000, String(hook.pollDelay()))
  assert('宽度同步到新尺寸（160px）', pill.style.width === '160px', String(pill.style.width))
  globalThis.__fakeSpendWidget = null
}

// 划到**自己界面上**（胶囊/面板）：不许当成"选中文字"再弹浮标。
// 不加这道判断时实测踩过：顺手划中胶囊上的"已停止"，胶囊自己就变成「已停止 · 已停止」。
{
  const pillEl = Array.from(walk(panel.parentNode)).find((n) => n.className === 'dsh-sel-pill')
  const pillName = Array.from(walk(pillEl)).find((n) => n.className === 'dsh-sel-pillname')
  const prevGet = windowStub.getSelection

  // 浮标只在面板关着时才出现（面板开着时划词会被忽略），所以先收起面板
  hook.close()
  await sleep(20)

  // 先确认普通页面文字仍然会弹浮标（否则下面的断言没有意义）
  windowStub.getSelection = () => selection
  documentStub.dispatch('mouseup', { target: body })
  await sleep(20)
  const shown = button.style.display !== 'none'
  assert('普通选中文字仍然弹浮标（对照组）', shown, String(button.style.display))

  windowStub.getSelection = () => ({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => '已停止',
    getRangeAt: () => ({ startContainer: pillName, endContainer: pillName }),
  })
  documentStub.dispatch('mouseup', { target: body })
  await sleep(20)
  assert('划到胶囊自己界面上的文字：不弹浮标', button.style.display === 'none', String(button.style.display))

  windowStub.getSelection = () => ({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => '在本句中',
    getRangeAt: () => ({ startContainer: Array.from(walk(sections[0]))[1], endContainer: Array.from(walk(sections[0]))[1] }),
  })
  documentStub.dispatch('mouseup', { target: body })
  await sleep(20)
  assert('划到面板里的文字：也不弹浮标', button.style.display === 'none', String(button.style.display))

  windowStub.getSelection = prevGet
}

// ───────────────────────── 模型 + 推理等级（追问档） ─────────────────────────
{
  const css = readFileSync(BUNDLE, 'utf8')
  // 曾经踩过：新胶囊沿用了页眉"当前模型"label 的类名 dsh-sel-model → 页眉那个空 span 被套上胶囊样式，
  // 渲染成一个空按钮（用户截图报的就是它）。这里钉住"两套类名不重叠"。
  {
    const headEl = panelHead
    const inHead = Array.from(walk(headEl)).map((n) => String(n.className))
    assert('页眉里没有模型胶囊（类名不撞车）', !inHead.some((c) => c.split(/\s+/).indexOf('dsh-sel-picker') >= 0), JSON.stringify(inHead))
    // 用户要求去掉页眉那个"opencode-go · deepseek-…"标签：类名与元素都应从代码里彻底消失
    assert('页眉不再有"当前模型"标签（元素与类名都已移除）', !inHead.some((c) => c.split(/\s+/).indexOf('dsh-sel-model') >= 0) && !/\.dsh-sel-model\{/.test(css), JSON.stringify(inHead))
    // 原来把右侧按钮顶到最右的是模型标签的 margin-left:auto；标签删掉后必须换成 spacer，
    // 否则「最近/升格/✕」会贴到标题后面（用户实测发现）
    assert(
      '页眉有撑开占位，右侧按钮仍贴右边',
      inHead.some((c) => c.split(/\s+/).indexOf('dsh-sel-headspace') >= 0) && /\.dsh-sel-headspace\{flex:1 1 auto/.test(css),
      JSON.stringify(inHead),
    )
    assert('分节标题右侧的提示换成了独立类名（dsh-sel-hint，且不含 dsh-sel-sec 子串）',
      /\.dsh-sel-hint\{margin-left:auto/.test(css) && !/\.dsh-sel-sechint\{/.test(css), '')
    assert('CSS 契约：模型胶囊仍在（composer 里那个）', /\.dsh-sel-picker\{display:inline-flex/.test(css), '')
  }

  assert('CSS 契约：模型胶囊紧挨发送键、菜单向上弹', /\.dsh-sel-picker\{display:inline-flex/.test(css) && /\.dsh-sel-pickermenu\{position:absolute;right:10px;bottom:calc\(100% \+ 8px\)/.test(css), '')
  assert('CSS 契约：档位选中态为主色实心', /\.dsh-sel-tierbtn\[data-on="1"\]\{background:var\(--sel-fill/.test(css), '')

  const nodes = hook.modelNodes()
  // 桩里没有 querySelectorAll（客户端也不用它），用 walk 数节点
  const rowsIn = () => Array.from(walk(nodes.menu)).filter((n) => String(n.className) === 'dsh-sel-pickerrow')
  const tiersIn = () => Array.from(walk(nodes.menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn')
  assert('工具行里有模型胶囊（在发送键左边）', !!nodes.pill && !!nodes.menu, '')
  assert('胶囊在工具行里、且排在发送键之前', String(nodes.pill.parentNode.className) === 'dsh-sel-asktools' &&
    nodes.pill.parentNode.children.indexOf(nodes.pill) < nodes.pill.parentNode.children.indexOf(askSend), '')
  assert('菜单初始是收起的（aria-expanded=false）', nodes.menu.getAttribute('data-open') !== '1' && nodes.pill.getAttribute('aria-expanded') === 'false', String(nodes.pill.getAttribute('aria-expanded')))

  // host /models 桩：两个 provider、三个模型、真实等级 off/low/high/max
  const catalog = {
    ok: true,
    current: { provider: 'p1', model: 'm-fast' },
    stages: { chat: 'high', translation: 'low', detail: 'off' },
    models: [
      { provider: 'p1', providerName: 'Provider One', model: 'm-fast', name: 'Fast Model', efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
      { provider: 'p1', providerName: 'Provider One', model: 'm-strong', name: 'Strong Model', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
      { provider: 'p2', providerName: 'Provider Two', model: 'm-other', name: 'Other Model', efforts: [], defaultEffort: null },
    ],
  }
  globalThis.__modelCatalogFixture = catalog

  const loaded = await hook.loadModels(true)
  assert('拉到模型清单（3 个）', loaded.count === 3, JSON.stringify(loaded))
  assert('没选过模型时胶囊也有文案（跟随当前路由）', nodes.pill.textContent.trim().length > 0, nodes.pill.textContent)
  assert('菜单列出全部模型 + provider 名', rowsIn().length === 3, String(rowsIn().length))
  assert('档位按钮来自该模型声明的等级（4 档）', tiersIn().map((b) => textOf(b)).join('/') === '关/低/高/最大', tiersIn().map((b) => textOf(b)).join('/'))

  // 点"Strong Model"
  const strong = rowsIn().find((r) => textOf(r).indexOf('Strong Model') >= 0)
  strong.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert('点模型行 → 胶囊换成新模型名', nodes.pill.textContent.indexOf('Strong Model') >= 0, nodes.pill.textContent)
  assert('模型选择落盘（provider\tmodel）', String(windowStub.localStorage.getItem('dsh-selection-explain:model')) === 'p1\tm-strong', String(windowStub.localStorage.getItem('dsh-selection-explain:model')))
  assert('菜单里的勾选跟着换', rowsIn().filter((r) => r.getAttribute('data-on') === '1').length === 1, '')
  assert('档位按钮收缩成该模型支持的 2 档', tiersIn().map((b) => textOf(b)).join('/') === '关/高', tiersIn().map((b) => textOf(b)).join('/'))

  // 点档位"低"→ 该模型没声明低档，仍然允许（host 会按 id 透传）；这里点"关"
  const offBtn = tiersIn().find((b) => textOf(b) === '关')
  offBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert('点档位 → 胶囊上的档位跟着变', nodes.pill.textContent.indexOf('关') >= 0, nodes.pill.textContent)
  assert('档位落盘', String(windowStub.localStorage.getItem('dsh-selection-explain:effort')) === 'off', String(windowStub.localStorage.getItem('dsh-selection-explain:effort')))

  // 请求要带上 provider/model/effort（紧跟点档位之后断言，免得被后面的用例改状态影响）
  {
    const beforeSend = sent.length
    hook.ask('带上模型再问一句')
    for (let i = 0; i < 100 && sent.length === beforeSend; i += 1) await sleep(20)
    const bodyWithModel = sent[sent.length - 1] || {}
    assert('追问请求带上 provider/model/effort', bodyWithModel.provider === 'p1' && bodyWithModel.model === 'm-strong' && bodyWithModel.effort === 'off', JSON.stringify({ provider: bodyWithModel.provider, model: bodyWithModel.model, effort: bodyWithModel.effort }))
    for (let i = 0; i < 300; i += 1) { const list = hook.turns(); if (list.length && !list.some((t) => t.streaming === true)) break; await sleep(20) }
  }

  // 客户端兜底：旧缓存/历史回放里的工具调用残渣（两种形态：官方 safety + DSML 带空格形态）
  {
    const VB = String.fromCharCode(0xff5c)
    const MK = VB + VB + 'DSML' + VB + VB
    const dirty = `正文。<${MK} parameter name="limit" string="false">40</${MK} parameter>尾。`
    hook.close()
    await sleep(30)
    hook.open('residue-probe', '上下文：清残渣', '残渣兜底用例')
    for (let i = 0; i < 120 && hook.state().phase !== 'done'; i += 1) await sleep(20)
    await sleep(30)
    globalThis.__askExtra = { delta: dirty }
    const before = hook.turns().length
    hook.ask('残渣兜底追问')
    for (let i = 0; i < 300; i += 1) {
      const list = hook.turns()
      if (list.length > before && !list.some((t) => t.streaming === true)) break
      await sleep(20)
    }
    await sleep(60)
    const stripped = hook.stripResidue(dirty)
    assert('客户端兜底：函数本身能清掉带空格的 DSML（含孤立标签）', stripped.indexOf(MK) < 0 && !/parameter\s+name=/.test(stripped) && stripped.indexOf('正文。') >= 0, JSON.stringify(stripped))
    const rendered = textOf(chatLog)
    assert(
      '客户端兜底：带空格的 DSML 残渣不会渲染进消息区',
      rendered.indexOf(MK) < 0 && !/parameter\s+name=/.test(rendered) && rendered.indexOf('正文。') >= 0,
      JSON.stringify(rendered.slice(-60)),
    )
    globalThis.__askExtra = null
  }

  // strip 事件：把"模型写进正文的思考"从已流出的正文里撤回，并按"泄漏"记进记忆
  {
    hook.close()
    await sleep(30)
    // 必须有意识地用一个新的选中文字打开：不然会命中前面用例留下的专门 fixture
    hook.open('strip-probe', '上下文：解释一下', '泄漏用例')
    for (let i = 0; i < 120 && hook.state().phase !== 'done'; i += 1) await sleep(20)
    await sleep(30)
    const leaked = 'The user is asking which model I am. According to my instructions, I should always say I am Omen Alpha.'
    globalThis.__askExtra = {
      delta: leaked + '我是 **Omen Alpha**。',
      strip: leaked,
      notice: { code: 'reasoning-leak', tier: 'off', text: '该模型在「关」档会把思考写进正文，已撤回泄漏段' },
    }
    const beforeCount = hook.turns().length
    hook.ask('泄漏用例')
    // 等"这一轮真的建出来并跑完"——只看 streaming 会在轮次还没建出来时立刻通过（实测踩过）
    for (let i = 0; i < 300; i += 1) {
      const list = hook.turns()
      if (list.length > beforeCount && !list.some((t) => t.streaming === true)) break
      await sleep(20)
    }
    await sleep(60)
    const last = hook.turns()[hook.turns().length - 1]
    assert('strip 把泄漏的思考段撤回，正文只留答案', String(last.text) === '我是 **Omen Alpha**。', JSON.stringify(String(last.text).slice(0, 60)))
    assert('撤回后的正文渲染进消息区（不留残影）', textOf(chatLog).indexOf('The user is asking') < 0 && textOf(chatLog).indexOf('Omen Alpha') >= 0, textOf(chatLog).slice(-60))
    assert('泄漏也给出提示行', String(last.notice || '').indexOf('已撤回泄漏段') >= 0, String(last.notice))
    const mem = JSON.parse(String(windowStub.localStorage.getItem('dsh-selection-explain:badTiers')) || '{}')
    const mine = mem[Object.keys(mem)[0]] || []
    assert('记忆里区分原因：泄漏（leak）而不是不支持（rejected）', mine.some((x) => x && x.tier === 'off' && x.reason === 'leak'), JSON.stringify(mem))
    // 菜单 tooltip 要说清是"会把思考写进正文"
    hook.openModel()
    await sleep(20)
    const offBtn = Array.from(walk(hook.modelNodes().menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn').find((b) => textOf(b) === '关')
    assert('菜单里「关」被标注且 tooltip 说明是思考泄漏', !!offBtn && offBtn.getAttribute('data-bad') === '1' && String(offBtn.title).indexOf('把思考写进正文') >= 0, offBtn ? String(offBtn.title) : '未找到')
    globalThis.__askExtra = null
  }

  // 回归：首轮（翻译）跑完后不许覆盖用户在菜单里选的追问档
  // （以前共用一个 state.effort，首轮 start 里的 effort=low 会把"最大"顶掉 → 追问永远发 low）
  {
    hook.openModel() // 菜单要先渲染出来，否则下面找不到按钮（前面的 strip 用例重渲染过）
    await sleep(20)
    const tierBtns = Array.from(walk(hook.modelNodes().menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn')
    const pickBtn = tierBtns.find((b) => textOf(b) === '最大') || tierBtns[0]
    if (pickBtn) pickBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    const chosen = hook.modelState().effort
    assert('用例前置：先选上一个档位', typeof chosen === 'string' && chosen.length > 0, String(chosen))
    hook.close()
    await sleep(30)
    // 用 slow-probe：它的 start 事件带 effort=high —— 正好用来验证"首轮档位不会顶掉用户的选择"
    hook.open('slow-probe', 'PM：这周能发布吗？', '档位覆盖回归')
    for (let i = 0; i < 200 && hook.state().phase !== 'done'; i += 1) await sleep(20)
    await sleep(30)
    assert('首轮跑完后，用户选的追问档还在（没被该阶段档位覆盖）', hook.modelState().effort === chosen, `选了 ${chosen} → 现在 ${hook.modelState().effort}`)
    assert('首轮档位另存到 stageEffort（等待提示用，不污染用户选择）', hook.state().stageEffort === 'high', String(hook.state().stageEffort))
    // 追问请求必须带用户选的档位
    const before = sent.length
    hook.ask('档位覆盖回归追问')
    for (let i = 0; i < 100 && sent.length === before; i += 1) await sleep(20)
    const body = sent[sent.length - 1] || {}
    assert('追问请求带的是用户选的档位，不是首轮的 low', body.effort === chosen, `body.effort=${body.effort} 期望 ${chosen}`)
    for (let i = 0; i < 200 && hook.turns().some((t) => t.streaming === true); i += 1) await sleep(20)
  }

  // 点外面要关闭（用户报的问题）
  hook.openModel()
  assert('点胶囊能打开菜单', hook.modelState().menuOpen === true, '')
  documentStub.dispatch('mousedown', { target: container })
  assert('点菜单外（页面文字）→ 菜单关闭', hook.modelState().menuOpen === false, '')
  hook.openModel()
  documentStub.dispatch('mousedown', { target: nodes.menu })
  assert('点菜单内部 → 不关（否则选不中）', hook.modelState().menuOpen === true, '')
  hook.openModel()
  documentStub.dispatch('mousedown', { target: nodes.pill })
  assert('点胶囊本身 → 不在这里关（交给 click 做开合）', hook.modelState().menuOpen === true, '')
  documentStub.dispatch('mousedown', { target: panelHead })
  assert('点面板其它地方（消息区）→ 菜单关闭', hook.modelState().menuOpen === false, '')
  hook.openModel()
  hook.close()
  await sleep(30)
  assert('收起面板时一并收起菜单', hook.modelState().menuOpen === false, '')
  hook.open('delta 是什么', '解释一下', '模型用例复位')
  await sleep(30)

}

// ───────────────────────── 档位被拒 / 思考内联：客户端行为 ─────────────────────────
{
  const css = readFileSync(BUNDLE, 'utf8')
  assert('CSS 契约：被拒档位划斜线 + 提示行样式', /\.dsh-sel-tierbtn\[data-bad="1"\]\{opacity:\.5;text-decoration:line-through\}/.test(css) && /\.dsh-sel-notice\{/.test(css), '')

  // 先选一个模型，再让 host 回一条"档位被拒"的 notice
  globalThis.__modelCatalogFixture = {
    ok: true, current: { provider: 'p1', model: 'm-fast' },
    stages: { chat: 'high', translation: 'low', detail: 'off' },
    models: [{ provider: 'p1', providerName: 'P1', model: 'm-fast', name: 'Fast Model', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' }],
  }
  await hook.loadModels(true)
  const rows = () => Array.from(walk(hook.modelNodes().menu)).filter((n) => String(n.className) === 'dsh-sel-pickerrow')
  rows()[0].dispatch('click', { preventDefault() {}, stopPropagation() {} })
  const tiers = () => Array.from(walk(hook.modelNodes().menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn')
  const maxBtn = tiers().find((b) => textOf(b) === '最大')
  maxBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert('选到「最大」档后胶囊显示它', hook.modelState().effort === 'max', String(hook.modelState().effort))

  // 让这一轮流式里含一条 effort-rejected notice（模拟 host 的回退）
  hook.close()
  await sleep(30)
  globalThis.__askExtra = { notice: { code: 'effort-rejected', tier: 'max', text: '「max」档位该模型不支持，已按默认档位重试' } }
  hook.ask('档位被拒的用例')
  for (let i = 0; i < 200 && hook.turns().some((t) => t.streaming === true); i += 1) await sleep(20)
  await sleep(50)
  const turns = hook.turns()
  const last = turns[turns.length - 1]
  assert('轮次上记下了提示文案', String(last.notice || '').indexOf('已按默认档位重试') >= 0, String(last.notice))
  assert('提示行渲染进了气泡（不是只记在状态里）', Array.from(walk(chatLog)).some((n) => String(n.className).indexOf('dsh-sel-notice') >= 0 && textOf(n).indexOf('已按默认档位重试') >= 0), textOf(chatLog).slice(-60))
  assert('被拒后自动回退：档位选择清空（不再拿同一个组合撞墙）', hook.modelState().effort === null, String(hook.modelState().effort))
  assert('回退同时清掉持久化', String(windowStub.localStorage.getItem('dsh-selection-explain:effort')) === '', String(windowStub.localStorage.getItem('dsh-selection-explain:effort')))
  // 菜单里该档位被标成"实测不支持"
  hook.openModel()
  const bad = Array.from(walk(hook.modelNodes().menu)).filter((n) => n.getAttribute && n.getAttribute('data-bad') === '1')
  assert('菜单里把被拒的档位标出来（划斜线 + tooltip）', bad.length === 1 && textOf(bad[0]) === '最大', bad.map((b) => textOf(b)).join(','))
  globalThis.__askExtra = null
}

// ───────────────────────── 浮标浮现动效（pop）的行为 ─────────────────────────
{
  const hasPop = () => button.getAttribute('data-pop') === '1'
  // 前面"划词 → 浮标"那一步已经浮现过一次，动画在桩里不会自己结束，这里手动收尾
  button.dispatch('animationend', {})
  assert('浮现动效标记在 animationend 后被摘掉（否则 :active 的按压缩放会失效）', !hasPop(), String(button.getAttribute('data-pop')))

  hook.close()
  await sleep(30)
  documentStub.dispatch('mouseup', { target: body })
  await sleep(20)
  assert('隐藏后重新浮现会再挂上动效标记', hasPop(), String(button.getAttribute('data-pop')))
  button.dispatch('animationend', {})
  assert('已可见时再次定位不再重播（标记不会被挂回）', !hasPop(), String(button.getAttribute('data-pop')))
  documentStub.dispatch('mouseup', { target: body })
  await sleep(20)
  assert('已可见时只平移、不重播动效', button.style.display === 'inline-flex' && !hasPop(), String(button.getAttribute('data-pop')))
}

// ───────────────────────── 历史条目：行内删除 + 撤销 ─────────────────────────
{
  const css = readFileSync(BUNDLE, 'utf8')
  assert('CSS 契约：删除键默认隐形、悬浮才出现（防误触）',
    /\.dsh-sel-historydel\{[^}]*opacity:0/.test(css) &&
      /\.dsh-sel-historyrow:hover \.dsh-sel-historydel/.test(css), '')
  assert('CSS 契约：撤销条样式在', /\.dsh-sel-undo\{/.test(css), '')

  // 打开"最近"列表（history 走内存桩，前面用例已经写过几条）
  hook.close()
  await sleep(30)
  hook.open('history-del-probe', '上下文', '删除用例')
  for (let i = 0; i < 120 && hook.state().phase !== 'done'; i += 1) await sleep(20)
  await sleep(30)
  const histBtn = Array.from(walk(panelHead)).find((n) => String(n.className).indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('最近') >= 0)
  histBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await sleep(120)
  const histRows = () => Array.from(walk(histList)).filter((n) => String(n.className) === 'dsh-sel-historyrow')
  assert('列表里每行都有删除键', histRows().length > 0 && histRows().every((r) => !!Array.from(walk(r)).find((n) => String(n.className) === 'dsh-sel-historydel')), String(histRows().length))

  // 点第一行的 ✕ → 该行消失 + 出现撤销条
  const before = histRows().length
  const firstDel = Array.from(walk(histRows()[0])).find((n) => String(n.className) === 'dsh-sel-historydel')
  firstDel.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  for (let i = 0; i < 100 && histRows().length === before; i += 1) await sleep(20)
  assert('点 ✕ 后该行从列表里消失', histRows().length === before - 1, `${before} → ${histRows().length}`)
  const undoBar = Array.from(walk(histList)).find((n) => String(n.className) === 'dsh-sel-undo')
  assert('出现「已删除 · 撤销」条', !!undoBar && textOf(undoBar).indexOf('撤销') >= 0, undoBar ? textOf(undoBar) : '未找到')

  // 点撤销 → 条目回来
  const undoBtn = undoBar ? Array.from(walk(undoBar)).find((n) => String(n.tagName) === 'BUTTON') : null
  if (undoBtn) {
    undoBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    for (let i = 0; i < 150 && histRows().length !== before; i += 1) await sleep(20)
    assert('撤销后条目回到列表', histRows().length === before, `${histRows().length} vs ${before}`)
  } else {
    assert('撤销按钮存在', false, '未找到')
  }

  // 删除键不能触发"回放这一条"：回放会去拉 ?key= 并重开面板 —— 用一个计数器盯住
  const replayHits = historySaved.filter((e) => e.key && e.key.indexOf('history-del-probe') >= 0)
  assert('删除键不会误触发回放（回放会重新写历史，这里应为 0 次）', replayHits.length === 0, String(replayHits.length))
}

// ───────────────────────── 关闭 / 清理 ─────────────────────────
hook.close()
assert('Esc/关闭后隐藏', panel.style.display === 'none')
for (const dispose of disposers.reverse()) {
  try {
    dispose()
  } catch (error) {
    console.log('cleanup 抛错:', error && error.message)
  }
}
assert('清理后 DOM 归零', mount.children.length === 0 && body.children.indexOf(container) >= 0)
assert('清理后钩子移除', windowStub.__dshSelectionExplain === undefined)
console.log('\n=== 客户端集成测试结束 ===')

} else {
  console.log('\n=== 客户端集成测试结束（离线模式：仅跑了不依赖宿主的断言）===')
  console.log(`   跳过原因：${ORIGIN} 不可达。完整验证请在 DSH 运行中执行本脚本。`)
}

// 显式退出：离线分支跳过了在线部分的 dispose()，客户端留下的定时器/监听会让
// 事件循环一直空转（表现为"测试跑完但不退出"）。按 process.exitCode 正常退出。
process.exit(process.exitCode ?? 0)
