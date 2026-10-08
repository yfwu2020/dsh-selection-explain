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
    // style 用**带 display setter** 的对象：真实浏览器里元素被 display:none 之后会失焦
    // （activeElement 回到 body）。桩原来是个裸对象，不模拟这件事 —— 于是"卡片收起后
    // 焦点还挂在它隐藏的 textarea 上"，让后面的"别处正在打字就不抢焦点"守卫误判
    // （实测：自动聚焦规则一直不生效，查了半天才发现是桩不忠实）。
    var displayValue = ''
    this.style = {}
    Object.defineProperty(this.style, 'display', {
      get: function () {
        return displayValue
      },
      set: function (value) {
        displayValue = value
        if (value === 'none' && documentStub && documentStub.activeElement === this) {
          documentStub.activeElement = body
        }
      },
      enumerable: true,
      configurable: true,
    })
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
    // 输入框语义：textarea/input 的 value 与选区。真实 DOM 里给 value 赋值会把光标
    // 挪到末尾、setSelectionRange 能定位 —— 语音输入要验"插在光标处"，桩必须跟着做到。
    this._value = ''
    this.selectionStart = 0
    this.selectionEnd = 0
  }
  get value() {
    return this._value
  }
  set value(next) {
    this._value = next === undefined || next === null ? '' : String(next)
    this.selectionStart = this._value.length
    this.selectionEnd = this._value.length
  }
  setSelectionRange(start, end) {
    this.selectionStart = start
    this.selectionEnd = end === undefined ? start : end
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
    // 临时卡片：给一个**和选区自洽**的矩形（落在选区下方）。
    // 用通用矩形（top:100）的话卡片会跑到选区上方，牵引线走"卡片在上方"那条分支，
    // 断言就量不到真实场景（卡片在下方）——这个坑我踩过一次。
    if (this.className === 'dsh-sel-vcard') {
      return { left: 940, top: 222, right: 1300, bottom: 264, width: 360, height: 42 }
    }
    return { left: 40, top: 100, right: 500, bottom: 400, width: 460, height: 300 }
  }
  /**
   * 真实 DOM：display:none 的元素没有盒子（空列表）——**祖先隐藏也算**。
   * 插件判断"这个输入框是不是还在页面上"靠它（临时语音卡收起时隐藏的是卡片，不是里面的输入框）。
   * ⚠️ 合并进原来那个固定矩形版本：类方法同名会**后者覆盖前者**，留两个的话新写的会被悄悄盖掉（踩过）。
   */
  getClientRects() {
    var node = this
    while (node) {
      if (node.style && node.style.display === 'none') return []
      node = node.parentNode
    }
    return [{ left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }]
  }
  get firstChild() {
    // 真实 DOM 的 firstChild：插件用 while (node.firstChild) 清空子节点，桩必须有
    return this.children.length ? this.children[0] : null
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
// 临时实验：关掉收尾复核
if (typeof windowStub !== 'undefined') windowStub.__DSH_DISABLE_FOCUS_VERIFY = false
const ORIGIN = process.env.SEL_ORIGIN || 'http://127.0.0.1:3080'
const sent = []
const promoted = []
/** A′：小窗历史的内存版存储（测试用）。 */
const historyStore = new Map()
/** 面板尺寸存档（桩）：拖拽/还原用例依赖它造出"上次记住的高度"。 */
let sizeStore = null
const historySaved = []
let historyList = []
const openedSessions = []
/** 引用上下文路由的调用记录（验"什么时候去问 host、带了什么"）。 */
const quoteContextCalls = []
/** 散文样本（固定 fixture，避免依赖真实网络/缓存命中）。 */
const PROSE_PROBE = 'the migration ran long, so we ship Wednesday'

/**
 * 语音输入（麦克风）这一段的假 host：目录 / 转写 / 准备。
 * 真链路由 scripts/test-speech.mjs（WAV 校验 + 真路由）与真浏览器冒烟覆盖；
 * 这里只验客户端编排（状态机 / 提示语 / 插字位置 / 该松麦克风时松掉）。
 */
let speechCatalog = {
  ok: true,
  available: true,
  reason: '',
  error: '',
  providers: [
    {
      id: 'sensevoice-local',
      name: 'SenseVoiceSmall (INT8)',
      location: 'host-local',
      languages: ['auto', 'zh', 'en'],
      downloadSources: ['https://huggingface.co'],
      phase: 'standby',
      step: '',
      completedBytes: 0,
      totalBytes: 0,
      message: '',
    },
  ],
  selection: { providerId: 'sensevoice-local', language: 'auto' },
  limits: { maxSeconds: 60, maxBytes: 4194304 },
}
/** 下一次转写的返回（测试里逐条改成失败 / 空 / 正常）。 */
let speechTranscript = { ok: true, text: '这段是语音转出来的问题', providerId: 'sensevoice-local', seconds: 2.4 }
/** 按顺序取用的返回（实时字幕一次录音要发好几个请求：预览 / 定稿 / 最终整段）。 */
let speechTranscriptQueue = []
/** 粘住的返回：一直返回同一个（模拟"人还在说，每拍预览都该是这句"）。 */
let speechTranscriptRepeat = null
let speechCatalogCalls = 0
let speechPrepareCalls = 0
const speechTranscribeCalls = []

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

/**
 * 麦克风占用桩（语音卡用例用）。
 * 默认 available:false —— 和其它用例一样"这台机器没有这个能力"，谁都不受影响；
 * 语音卡那条用例把它改成"豆包输入法正在录"，走完整条链路。
 */
const micStub = { value: { ok: true, available: false, capturing: false, processes: [], reason: 'stub-default' } }

/**
 * 设置桩：离线跑的时候给客户端一份"读得到"的设置。
 * 默认空对象 = 所有设置都用各自的出厂默认（不写值的键，客户端按默认关处理）。
 * 用例里改 settingsStub.value 之后要调 hook.reloadSettings() ——
 * 客户端只在启动时读一次设置，不重读的话改桩值不会生效。
 */
const settingsStub = { value: {} }

const routeFetch = (input, init) => {
  const url = typeof input === 'string' ? input : ''
  // 麦克风占用：读的是 host 上的 CoreAudio 探针，测试里由 micStub 决定
  // ⚠️ 联机模式（SEL_ORIGIN 指向真宿主）下**不能**用空桩顶掉设置请求：
  // 真实 spec 必须由宿主下发，否则设置页一个分类都画不出来（踩过）。
  // 但用例又需要"临时把某个设置打开" —— 所以联机模式改成**代理**：
  // 先读真宿主的设置拿到真实 spec，只把 values 里被用例覆盖的键换掉。
  if (
    process.env.SEL_ORIGIN &&
    Object.keys(settingsStub.value).length &&
    url.indexOf('/selection-explain/api/settings') >= 0 &&
    !(init && init.method === 'POST')
  ) {
    return fetch(ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })
      .then((response) => response.json())
      .then((payload) =>
        new Response(
          JSON.stringify(
            Object.assign({}, payload, {
              values: Object.assign({}, payload.values, settingsStub.value),
            }),
          ),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
  }
  if (!process.env.SEL_ORIGIN && url.indexOf('/selection-explain/api/settings') >= 0) {
    if (init && init.method === 'POST') {
      try {
        // ⚠️ 这个 API 的 POST body 是 { values: {...} } 包一层的（宿主侧见 handleSettings），
        // 不是扁平对象 —— 按扁平解析会一个键都读不到。
        var posted = JSON.parse(String(init.body || '{}'))
        Object.assign(settingsStub.value, (posted && posted.values) || {})
      } catch (error) {
        /* 桩不校验，校验是宿主的事（见 test-settings-host.mjs） */
      }
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ ok: true, groups: [], values: Object.assign({}, settingsStub.value), defaults: {} }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
  }
  if (url.endsWith('/selection-explain/api/mic')) {
    return Promise.resolve(
      new Response(JSON.stringify(micStub.value), { headers: { 'content-type': 'application/json' } }),
    )
  }
  // blob:（划词桥的交互式预览用例）：从内存表里读回我们自己建的那份文档。
  // content-type 跟着 blob 的 type 走（真实浏览器就是这么给的）——插件要靠它搬 charset。
  if (url.startsWith('blob:')) {
    const blob = blobStore.get(url)
    if (!blob) return Promise.reject(new Error('unknown blob: ' + url))
    return Promise.resolve(new Response(blob, { headers: { 'content-type': blob.type || 'text/html' } }))
  }
  // 模型清单：用 fixture（真实 host 有 41 个模型，跑用例时不该依赖它）
  if (url.indexOf('/selection-explain/api/models') >= 0) {
    const body = globalThis.__modelCatalogFixture || { ok: true, current: null, stages: null, models: [] }
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))
  }
  // 「这一轮用哪个模型」的轻量查询（设置页轮询它做实时刷新）：同样走 fixture，
  // 否则用例会打到真实 host，拿到的模型随本机会话变，断言就不确定了。
  if (url.indexOf('/selection-explain/api/route') >= 0) {
    const chat = url.indexOf('chat=1') >= 0
    const fx = globalThis.__modelCatalogFixture || { current: null }
    const chatFx = globalThis.__chatRouteFixture
    const cur = chat && chatFx ? chatFx : fx.current
    const body = {
      ok: true,
      provider: (cur && cur.provider) || '',
      model: (cur && cur.model) || '',
      chatFollows: !(chat && chatFx),
    }
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))
  }
  // 面板尺寸存档：内存版。以前没有桩 → 打到真实 host，既会改到用户的存档，
  // 也没法造出"上次记住的高度"这个前提（而"拖拽上限被旧天花板卡住"正需要它）。
  if (url.indexOf('/selection-explain/api/panel') >= 0) {
    if (init && init.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'))
      sizeStore = body && body.clear === true ? null : body && body.size ? body.size : sizeStore
      return Promise.resolve(new Response(JSON.stringify({ ok: true, size: sizeStore }), { headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true, size: sizeStore }), { headers: { 'content-type': 'application/json' } }))
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
  // 引用上下文：host 侧"引用所在那一组对话 ± 一组"的那份（fixture —— 取轮算法本身由
  // test-transcript.mjs 覆盖；这里验的是**客户端怎么用它**）。globalThis.__quoteContextFixture
  // 可切成 'miss'（定位不到）/ 'error'（路由失败），用来验兜底路径。
  if (url.indexOf('/selection-explain/api/quote-context') >= 0) {
    let payload = {}
    try {
      payload = JSON.parse(String(init && init.body))
    } catch (error) {
      payload = { parse_error: String(error) }
    }
    quoteContextCalls.push(payload)
    const fixture = globalThis.__quoteContextFixture
    if (fixture === 'error') {
      return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } }))
    }
    if (fixture === 'miss') {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, matched: false, context: '', rounds: 0 }), { headers: { 'content-type': 'application/json' } }))
    }
    const context = [
      '用户：上一句问的是什么？',
      '助手：上一句的回答。',
      `用户：【${payload.text}】`,
      '助手：引用之后的那句回答。',
      '用户：再下一句提问。',
      '助手：再下一句回答。',
    ].join('\n')
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, matched: true, context, rounds: 3, chars: context.length }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  // 语音输入：目录 / 转写 / 准备。三条都用 fixture（真识别见 test-speech.mjs 与真浏览器冒烟）。
  if (url.indexOf('/selection-explain/api/speech') >= 0) {
    if (url.indexOf('/transcribe') >= 0) {
      let payload = null
      try {
        payload = JSON.parse(String(init && init.body))
      } catch (error) {
        payload = { parse_error: String(error) }
      }
      speechTranscribeCalls.push(payload)
      const scripted = speechTranscriptRepeat || (speechTranscriptQueue.length ? speechTranscriptQueue.shift() : speechTranscript)
      return Promise.resolve(new Response(JSON.stringify(scripted), { headers: { 'content-type': 'application/json' } }))
    }
    if (url.indexOf('/prepare') >= 0) {
      speechPrepareCalls += 1
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, providerId: 'sensevoice-local', catalog: speechCatalog }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    speechCatalogCalls += 1
    return Promise.resolve(new Response(JSON.stringify(speechCatalog), { headers: { 'content-type': 'application/json' } }))
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
  // 语音输入那一段的"把面板打开、翻译就绪"夹具（比 stage-probe 多一个 done 阶段）
  if (body && body.text === 'voice-probe') {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n语音用例的翻译\n' })}\n\n`,
      // ⚠️ 临时诊断（定位完随诊断一起删）：模拟宿主在 done 里回传的逐轮诊断
      `data: ${JSON.stringify({
        type: 'done',
        chars: 8,
        rounds: [{ round: 0, wrapUp: false, ms: 1234, raw: 140, emitted: 120, think: 0, residueDropped: 7, finish: 'tool_calls', tools: 1, outTokens: 42 }],
      })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
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
  // 首轮夹具：给"摘要继承用例"用（用未知文本会走真实模型，首轮一直不结束 → 追问被拒）
  if (body && body.text === 'digest-probe' && !body.question) {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n摘要用例的翻译\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: 8 })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 结论轮提示：notice 先到、正文 350ms 后到 —— 用来验"提示在正文到达后消失"（附带的探针）
  if (body && body.question && body.text === 'notice-probe') {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'high' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'notice', code: 'conclusion-retry', text: '查询已完成，正在整理结论…' })}\n\n`))
        await new Promise((r) => setTimeout(r, 350))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '这是结论。' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 5 })}\n\n`))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.text === 'notice-probe' && !body.question) {
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n提示用例的翻译\n' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done' })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
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
        // ⚠️ 临时诊断（定位完随诊断一起删）：追问流的 done 也带上逐轮诊断
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'done',
          chars: 6,
          rounds: [{ round: 1, wrapUp: true, ms: 900, raw: 260, emitted: 240, think: 12, residueDropped: 0, finish: 'stop', tools: 0, outTokens: 233 }],
          conclusion: { tried: true, chars: 17, rounds: 1, error: '', finish: 'length', outTokens: 777 },
        })}\n\n`))
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
    // 追问失败注入（`globalThis.__askFailOnce = true`）：验"报错之后光标回不回到输入框"
    if (globalThis.__askFailOnce) {
      globalThis.__askFailOnce = false
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: 'no adapter registered for provider "p1"' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
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
  // 引用（❝）用例：首轮固定给一句可被引用的正文，详解在同一个小窗里另走 stage=detail
  if (body && body.text === 'quote-probe') {
    const only = body.stage === 'detail' ? '## 详解\n引用用例的详解\n' : '## 翻译\n引用用例的翻译段落（拿来被引用）\n'
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: body.stage === 'detail' ? 'detail' : 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: only })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: only.length })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  // 「等待中的那条不给引用整条」专用：首轮立刻出，追问要等 500ms 才吐第一个字
  if (body && body.text === 'quote-wait-probe' && !body.question) {
    const only = '## 翻译\n等待用例的翻译\n'
    const payload = [
      `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: only })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', chars: only.length })}\n\n`,
    ].join('')
    return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
  }
  if (body && body.question && body.text === 'quote-wait-probe') {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`),
        )
        await new Promise((r) => setTimeout(r, 500))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '等待用例的回答' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 8 })}\n\n`))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  }
  return fetch(typeof input === 'string' && input.startsWith('/') ? ORIGIN + input : input, init)
}
const browserFetch = (input, init) => {
  const out = routeFetch(input, init)
  const signal = init && init.signal
  if (!signal || !out || typeof out.then !== 'function') return out
  return out.then((response) => (response && response.body ? withAbort(response, signal) : response))
}
/**
 * 划词桥的 blob 桩：宿主交互式预览的外层文档就是 `blob:`（见 ui-sidebar-documentpreview
 * 的 HtmlFrame）——桥要 fetch 它、再把注入过脚本的那份重新发成一个 blob 换上去。
 */
const blobStore = new Map()
let blobSeq = 0
URL.createObjectURL = (blob) => {
  blobSeq += 1
  const url = `blob:stub/${blobSeq}`
  blobStore.set(url, blob)
  return url
}
URL.revokeObjectURL = (url) => {
  blobStore.delete(url)
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
    if (name === 'uiSession') {
      return { adapter: { current: { getSnapshot: () => ({
        key: globalThis.__sessionStubId || 'session-stub-1',
        props: { sessionId: globalThis.__sessionStubId || 'session-stub-1' },
      }) } } }
    }
    if (name === 'sessions') {
      return {
        list: { getSnapshot: () => ({ ids: ['session-stub-1'], byId: {}, phase: 'ready', projectionsBySession: {} }) },
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
/** 选区桩：记下 removeAllRanges 有没有被调用（点「解读」后要把本文档选区收掉）。 */
const clearedSelections = { count: 0 }
const selection = {
  isCollapsed: false,
  rangeCount: 1,
  toString: () => 'the migration ran long',
  getRangeAt: () => documentStub.createRange(),
  removeAllRanges() {
    clearedSelections.count += 1
  },
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

// ───────────────────────── 选中的文字被删掉 → 浮标必须消失 ─────────────────────────
// 用户报的：划词浮标出来之后，把那段文字删了（Backspace / 打字覆盖 / 内容刷新把节点换掉），
// 浮标还赖在屏幕上不走，点下去解读的是一段**屏幕上已经不存在**的文字。
{
  const rect = { left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }
  /** 造一段"落在 node 上"的选区（锚点就是 node —— isConnected 那条判定要用它）。 */
  const selectOn = (node, text) => {
    const range = {
      startContainer: node,
      endContainer: node,
      cloneRange: () => range,
      getClientRects: () => [rect],
      getBoundingClientRect: () => rect,
    }
    windowStub.getSelection = () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => text,
      getRangeAt: () => range,
    })
  }

  // ① 拖拽划词进行中（鼠标按着）：不弹浮标 —— 时机要和"松手才弹"一致
  selectOn(textEl, 'the migration ran long')
  documentStub.dispatch('mousedown', { target: container })
  documentStub.dispatch('selectionchange', {})
  await sleep(20)
  assert('拖拽中（鼠标按着）不弹浮标', button.style.display === 'none', String(button.style.display))
  documentStub.dispatch('mouseup', { target: container })
  await sleep(20)
  assert('松手后照常弹浮标', button.style.display === 'inline-flex', String(button.style.display))

  // ② 选区塌陷（Backspace / Delete / 打字覆盖 / 剪切走的都是这条）：浏览器发 selectionchange
  windowStub.getSelection = () => ({ isCollapsed: true, rangeCount: 0, toString: () => '' })
  documentStub.dispatch('selectionchange', {})
  await sleep(20)
  assert('选中的文字被删掉（选区塌陷）→ 浮标消失', button.style.display === 'none', String(button.style.display))

  // ③ 选区**没塌陷**、锚点节点却已经被摘掉（Firefox 的行为）：靠 isConnected 判死
  selectOn(textEl, 'the migration ran long')
  documentStub.dispatch('mouseup', { target: container })
  await sleep(20)
  assert('（准备）浮标重新亮着', button.style.display === 'inline-flex', String(button.style.display))
  textEl.isConnected = false
  documentStub.dispatch('selectionchange', {})
  await sleep(20)
  assert('选中的节点被摘掉（选区没塌陷）→ 浮标也消失', button.style.display === 'none', String(button.style.display))
  delete textEl.isConnected

  // 还原成开头那段选区：后面的用例还要点这个浮标开小窗
  windowStub.getSelection = () => selection
  documentStub.dispatch('mouseup', { target: body })
  await sleep(20)
  assert('（还原）浮标回到可见', button.style.display === 'inline-flex', String(button.style.display))
}

// 引用（❝）的**离线**契约：浮标进了浮层、CSS 规则齐全（真实交互在宿主可达时另有一段）
{
  const css = readFileSync(BUNDLE, 'utf8')
  const quoteBtn = Array.from(walk(mount)).find((n) => String(n.className).indexOf('dsh-sel-quotebtn') >= 0)
  assert('浮层里有「❝ 引用」浮标，且默认藏着', !!quoteBtn && quoteBtn.style.display === 'none' && textOf(quoteBtn).indexOf('引用') >= 0, quoteBtn ? textOf(quoteBtn) : '未找到')
  assert('CSS 契约：引用区默认收起、data-show 控制显隐', /\.dsh-sel-quotes\{display:none;flex-direction:column/.test(css) && /\.dsh-sel-quotes\[data-show="1"\]\{display:flex\}/.test(css), '')
  assert('CSS 契约：引用卡片三段（来源 / 摘要 / 删除）', /\.dsh-sel-quotechip-src\{/.test(css) && /\.dsh-sel-quotechip-text\{/.test(css) && /\.dsh-sel-quotechip-x\{/.test(css), '')
  assert('CSS 契约：气泡里的引用块单行省略（长引用不撑破气泡）', /\.dsh-sel-bqitem\{[\s\S]{0,420}?text-overflow:ellipsis;white-space:nowrap\}/.test(css), '')
  assert('CSS 契约：「引用整条」平时隐身，鼠标移到这条消息上才出现', /\.dsh-sel-bubquote\{[\s\S]{0,520}?opacity:0;transition:opacity/.test(css) && /\.dsh-sel-bubble:hover \.dsh-sel-bubquote,\.dsh-sel-bubquote:focus-visible\{opacity:\.66\}/.test(css), '')
}


// ───────────────────────── 点击 → 弹窗 + 真实 host 流 ─────────────────────────
// ⚠️ 开场先清一次设置覆盖。
// 这套用例后面会把 provider/model 写成夹具里的假 provider（p1），而它落在**真实 host** 上；
// 万一上一次跑崩在中途（没走到收尾的 reset），残留的 p1 会让接下来的真实解读全部 503 ——
// 表现为"流式渲染失败"一大片，看起来像插件坏了，其实是脏状态。
// 所以清理要放在**最前面**（收尾那次仍然保留，正常路径下不留痕迹）。
try {
  await fetch(ORIGIN + '/selection-explain/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  })
} catch (error) {
  /* host 不可达时后面本来就会跳过在线断言 */
}

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
// 点完「解读」立刻把本文档选区收掉：留着它，小窗开着时按个方向键又会冒出一个「❝ 引用」，
// 指的是刚才解读的那段文字（解读要的文字与上下文在 mouseup 那刻就抓好了，见 openForSelection）
assert('点「解读」后本文档选区被收掉', clearedSelections.count >= 1, `removeAllRanges 调用 ${clearedSelections.count} 次`)
{
  const quoteBtnNode = Array.from(walk(mount)).find((n) => String(n.className).indexOf('dsh-sel-quotebtn') >= 0)
  assert(
    '点「解读」后引用浮标不出现（旧选区不该复活它）',
    !quoteBtnNode || quoteBtnNode.style.display === 'none',
    quoteBtnNode ? String(quoteBtnNode.style.display) : '浮标节点还没建出来（= 没显示）',
  )
}

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
  {
    // 源码契约（桩 DOM 里没有真实焦点，只能用源码钉住）：
    // 开窗那一下的自动聚焦会把选区清掉 —— 小窗里正划着词（准备点引用）时必须让位，
    // 否则就是"划好了词，一松手浮标没出现"（实测：开窗后首轮刚出完那一帧正好撞上）。
    const clientSrc = readFileSync(resolve(HERE, '..', 'src', 'client', 'index.js'), 'utf8')
    assert(
      '开窗自动聚焦会让位给"小窗里正在划的词"',
      /function hasPanelSelection\(\)/.test(clientSrc) && /if \(hasPanelSelection\(\)\) \{/.test(clientSrc),
      'src/client/index.js',
    )
  }
  assert(
    '追问档位默认 high，首轮默认 off',
    /chatReasoningEffort: z\.string\(\)\.default\('high'\)/.test(hostSrc) &&
      /chatReasoningEffort: rawConfig\?\.chatReasoningEffort \?\? 'high'/.test(hostSrc) &&
      /translationReasoningEffort: z\.string\(\)\.default\('off'\)/.test(hostSrc),
    'src/index.ts',
  )
}

// ── 以下全部是真实 host 集成断言（SSE 流式渲染 / 面板交互 / 历史 / 清理）──
// CI 里没有宿主，跳过；本地开发有宿主时全跑。
//
// ⚠️⚠️ 这一节会**改真实配置**：模型选择用例会写 provider/model，还会点「恢复默认」。
// 对着"用户正在用的插件"跑，副作用会留下来 —— 实测事故：联机测试把 provider/model 写成了
// 夹具的 p1/m-fast，用户此后每次请求都失败（no adapter registered for provider "p1"）。
// 所以这里先快照整份设置，本节结束时（见文件后面的 settingsSnapshot 还原）按快照写回。
// 要跑"绝不留副作用"的设置用例，用 test-settings-host.mjs（隔离 DSH_HOME + 新加载宿主）。
if (HOST_UP) {

const settingsSnapshot = await (
  await fetch(ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })
).json()
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
assert('首轮面板标为 translation 阶段（决定追问框显示，不决定宽度）', panel.getAttribute('data-stage') === 'translation', String(panel.getAttribute('data-stage')))
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
  assert('一旦有对话，面板切到 detail 阶段', panel.getAttribute('data-stage') === 'detail', String(panel.getAttribute('data-stage')))
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
assert('展开后面板切到 detail 阶段', panel.getAttribute('data-stage') === 'detail', String(panel.getAttribute('data-stage')))
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
  '右上角是「最近 + 升格 + 设置 + 关闭」四个，没有复制按钮',
  !Array.from(walk(panelHead)).some((n) => textOf(n).indexOf('复制') >= 0) &&
    Array.from(walk(panelHead)).filter((n) => n.className === 'dsh-sel-icon').length === 1 &&
    // 文字动作键：最近 / 升格 / 设置 —— 三个同款（设置键也带文字，不再是一枚裸图标）
    Array.from(walk(panelHead)).filter((n) => n.className.indexOf('dsh-sel-action') >= 0).length === 3 &&
    Array.from(walk(panelHead)).some((n) => n.className.indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('最近') >= 0) &&
    Array.from(walk(panelHead)).some((n) => n.className.indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('设置') >= 0),
  Array.from(walk(panelHead)).map((n) => n.className + ':' + textOf(n).slice(0, 6)).join(' | '),
)
const promoteBtn = Array.from(walk(panelHead)).find((n) => n.className.indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('升格') >= 0)
assert(
  '升格按钮是自适应宽度的文字按钮（不再挤进 24px 方块）',
  !!promoteBtn && textOf(promoteBtn).indexOf('升格') >= 0,
  promoteBtn ? promoteBtn.className + '｜' + textOf(promoteBtn) : '未找到',
)

// ───────────────────────── 设置（小窗设置抽屉） ─────────────────────────
// 设计约束（用户明确要求）：设置键与「最近 / 升格」**同款** —— 带边框的文字键、图标 + 文字，
// 而不是一枚孤零零的裸图标。图标本身走统一 SVG 规范（16 画布 / 14px / stroke 1.5）。
const settingsBtn = Array.from(walk(panelHead)).find(
  (n) => n.className.indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('设置') >= 0,
)
assert(
  '头部有「设置」文字键（不是裸图标）',
  !!settingsBtn && settingsBtn.className.indexOf('dsh-sel-action') >= 0,
  settingsBtn ? settingsBtn.className + '｜' + textOf(settingsBtn) : '未找到',
)
assert(
  '「设置」键的图标与「最近 / 升格」同款（都是 14px 的 SVG，不是 Unicode 字形）',
  !!settingsBtn && !!Array.from(walk(settingsBtn)).find((n) => n.tagName === 'SVG' && n.attrs.width === '14'),
  settingsBtn ? Array.from(walk(settingsBtn)).map((n) => n.tagName + '/' + (n.attrs.width || '')).join(',') : '未找到',
)
// 头部每个图标都得走同一套画布：viewBox 16×16、stroke-width 1.5、linecap round。
// 混用 Unicode 字形（🕘 ↗ ✕）时这组属性根本不存在 —— 这条断言就是防它回潮。
{
  const headIcons = []
  for (const btn of walk(panelHead)) {
    if (btn.tagName !== 'SVG') continue
    headIcons.push(btn)
  }
  const uniform = headIcons.length >= 4 && headIcons.every((svg) =>
    svg.attrs.viewBox === '0 0 16 16' && svg.attrs['stroke-width'] === '1.5' &&
    svg.attrs['stroke-linecap'] === 'round' && svg.attrs.width === '14')
  assert(
    '头部所有图标同规范（viewBox 16×16 / 14px / stroke 1.5 / round）',
    uniform,
    headIcons.map((s) => `${s.attrs.width}px,vb=${s.attrs.viewBox},sw=${s.attrs['stroke-width']}`).join(' | ') || '没有 SVG 图标',
  )
}

const settingsSheet = Array.from(walk(panel)).find((n) => n.className === 'dsh-sel-sheet')
assert('抽屉默认是收起的（data-open=0）', !!settingsSheet && settingsSheet.getAttribute('data-open') === '0',
  settingsSheet ? String(settingsSheet.getAttribute('data-open')) : '未找到抽屉')

// 模型下拉的清单来自 harness 的 /models 桩：默认是**空**的（免得跑用例依赖真实 host），
// 所以这里先装一份夹具，再开抽屉 —— 否则下拉里只有一行「跟随主会话」。
globalThis.__modelCatalogFixture = {
  ok: true,
  // current = **当前会话**在用的模型（host 按 sessionId 解析出来给客户端）
  current: { provider: 'p1', model: 'm-fast' },
  stages: { chat: 'high', translation: 'low', detail: 'off' },
  models: [
    { provider: 'p1', providerName: 'Provider One', model: 'm-fast', name: 'Fast Model', efforts: [], defaultEffort: 'high' },
    { provider: 'p1', providerName: 'Provider One', model: 'm-strong', name: 'Strong Model', efforts: [], defaultEffort: 'high' },
    { provider: 'p2', providerName: 'Provider Two', model: 'm-other', name: 'Other Model', efforts: [], defaultEffort: null },
  ],
}
// 这套用例打的是**真实 host** 的 /settings，会真的落盘。先清一次覆盖，
// 保证不管上一次跑成什么样（哪怕中途崩了），这次都从默认值开始 —— 用例要能独立重跑。
await fetch(ORIGIN + '/selection-explain/api/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ reset: true }),
})

// 点一下：抽屉打开 + 去 host 拉 spec/当前值
settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
await new Promise((r) => setTimeout(r, 30))
assert('点「设置」把抽屉打开', settingsSheet.getAttribute('data-open') === '1',
  String(settingsSheet.getAttribute('data-open')))

// 等 host 把 spec 拉回来（真实请求，给足时间）
for (let i = 0; i < 60 && !Array.from(walk(settingsSheet)).some((n) => n.className === 'dsh-sel-railbtn'); i += 1) {
  await new Promise((r) => setTimeout(r, 25))
}
const settingsRail = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-rail')
const railButtons = settingsRail ? Array.from(walk(settingsRail)).filter((n) => n.className === 'dsh-sel-railbtn') : []
assert(
  '抽屉里按 host 下发的 spec 画出 6 个分类（模型/解读/背景/联网/界面/数据）',
  railButtons.length === 6 && railButtons.some((b) => textOf(b).indexOf('模型') >= 0),
  railButtons.map((b) => textOf(b)).join(' / ') || '一个都没有',
)
const settingsRows = Array.from(walk(settingsSheet)).filter((n) => n.className === 'dsh-sel-srow')
assert(
  '分类设置均呈现，移除的控件不再出现',
  settingsRows.length >= 20 && !settingsRows.some(r => /输出上限|采样温度|缓存有效期|追问模型/.test(textOf(r))),
  `rows=${settingsRows.length}`,
)

// 切分类：只有当前分类的 pane 可见（其余 display:none）
{
  const toolsTab = railButtons.find((b) => textOf(b).indexOf('联网') >= 0)
  toolsTab.dispatch('click', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 10))
  const panes = Array.from(walk(settingsSheet)).filter((n) => n.className === 'dsh-sel-grp')
  const visible = panes.filter((p) => p.style.display !== 'none')
  assert(
    '点分类只切出这一类（其余收起）',
    visible.length === 1 && visible[0].getAttribute('data-pane') === 'tools',
    panes.map((p) => p.getAttribute('data-pane') + ':' + (p.style.display === 'none' ? 'off' : 'on')).join(' | '),
  )
}

// 改一项开关 → 底部动作栏报"未保存"（不弹 toast、不打断）
{
  const sw = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sws')
  const note = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sfootnote')
  assert('开关与底部状态栏都在', !!sw && !!note, sw ? 'ok' : '没有开关')
  const before = sw.getAttribute('aria-checked')
  sw.dispatch('click', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 10))
  assert(
    '改一项后立刻标脏（底部报未保存）',
    sw.getAttribute('aria-checked') !== before && note.getAttribute('data-dirty') === '1' &&
      /未保存/.test(textOf(note)),
    `checked=${before}→${sw.getAttribute('aria-checked')} dirty=${note.getAttribute('data-dirty')} "${textOf(note)}"`,
  )
  const settingInput = label => Array.from(walk(settingsSheet)).find(n => n.getAttribute('aria-label') === label)
  assert('关闭会话消息开关后，三个上下文输入框禁用',
    ['首轮上下文消息数', '次轮与追问上下文消息数', '上下文总字符上限'].every(label => settingInput(label)?.disabled === true))
  assert('解读的会话消息开关不影响引用轮数', settingInput('上下文轮数')?.disabled !== true)
  // 防抖 400ms 后才真的落盘；这里等它发完并回填，避免污染后面用例的状态
  await new Promise((r) => setTimeout(r, 700))
  assert('保存完成后底部回到"改动会自动保存"', /改动会自动保存/.test(textOf(note)), `"${textOf(note)}"`)
  // 改回原值（用户环境不该被测试改掉）
  sw.dispatch('click', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 700))
  assert('重新开启后，上下文输入框恢复可改', settingInput('首轮上下文消息数')?.disabled === false)
}

// 模型：一个下拉同时定 provider + model（不再让用户自己拼两个 id）
{
  railButtons.find((b) => textOf(b).indexOf('模型') >= 0).dispatch('click', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 10))
  const pick = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spick')
  assert('模型是自绘下拉的按钮（不是原生 <select>）', !!pick && !Array.from(walk(settingsSheet)).some((n) => n.tagName === 'SELECT'),
    pick ? 'button' : '未找到')

  // 清单是异步拉的，等它填进来
  for (let i = 0; i < 80 && Array.from(walk(settingsSheet)).filter((n) => n.className === 'dsh-sel-spickrow').length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 25))
  }
  // 列表默认藏着，点按钮才弹出来
  const menu = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spickmenu')
  assert('下拉菜单默认收起（data-open=0）', !!menu && menu.getAttribute('data-open') === '0',
    menu ? String(menu.getAttribute('data-open')) : '未找到菜单')
  pick.dispatch('click', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 10))
  assert('点按钮把下拉弹出来', menu.getAttribute('data-open') === '1', String(menu.getAttribute('data-open')))

  // 三个推理档位按**实际发生顺序**命名：首轮（翻译/解读/注释）→ 次轮详解 → 追问。
  // 顺序本身是信息（用户是照着"小窗先出什么、再出什么"理解这三档的），别改成字母序或历史序。
  {
    const modelPane = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-grp' && n.getAttribute('data-pane') === 'model')
    const labels = Array.from(walk(modelPane))
      .filter((n) => n.className === 'dsh-sel-srowt')
      .map((n) => textOf(n))
    const first = labels.findIndex((t) => t.indexOf('首轮') >= 0)
    const second = labels.findIndex((t) => t.indexOf('次轮') >= 0)
    const chat = labels.findIndex((t) => t === '追问')
    assert('推理三档按「首轮 → 次轮 → 追问」排列',
      first >= 0 && second > first && chat > second,
      labels.join(' / '))
    assert('首轮说明包含翻译、解读与注释', textOf(modelPane).includes('翻译 / 解读 / 注释'), textOf(modelPane))
    assert('次轮说明对应展开详解', textOf(modelPane).includes('点击「展开详解」'), textOf(modelPane))
  }

  // 默认项写「跟随主会话（当前：…）」：括号里必须是**当前会话**在用的那个模型。
  // host 侧 resolveRoute 现在是会话级的（读会话事件流里的 model/selection），
  // 所以两个会话用不同模型时各自看到的也不同 —— 报的就是自己那一个。
  assert('默认项写明「跟随主会话」并带出当前会话的模型',
    textOf(pick).indexOf('跟随主会话') >= 0 && textOf(pick).indexOf('当前') >= 0,
    textOf(pick))
  assert('括号里的模型来自会话级 /models（夹具的 current，不是全局猜测）',
    textOf(pick).indexOf('Fast Model') >= 0,
    textOf(pick))

  const rows = Array.from(walk(settingsSheet)).filter((n) => n.className === 'dsh-sel-spickrow')
  assert('下拉里列出了模型清单 + 一个「跟随主会话」', rows.length >= 4 &&
    textOf(rows[0]).indexOf('跟随主会话') >= 0, `rows=${rows.length} first="${rows[0] ? textOf(rows[0]) : ''}"`)

  // 用户报的 bug：42 个模型时下拉没有滚动条。
  // 关键就是列表自己有 max-height + overflow:auto —— 断言这条 CSS 契约，防止被改回"整页顶出去"。
  const cssSrc = readFileSync(resolve(HERE, '..', 'src', 'client', 'index.js'), 'utf8')
  assert('下拉列表自带 max-height + overflow（滚动条是确定的）',
    /\.dsh-sel-spicklist\{[^}]*max-height:\d+px/.test(cssSrc) && /\.dsh-sel-spicklist\{[^}]*overflow-y:auto/.test(cssSrc),
    '.dsh-sel-spicklist 缺少 max-height 或 overflow-y:auto')
  assert('下拉菜单挂在抽屉上（不是行里，避开滚动区的裁剪）',
    !!menu && menu.parentNode === settingsSheet,
    menu ? (menu.parentNode ? menu.parentNode.className : '无父节点') : '未找到')

  // 选一个模型 → 应该同时写 provider 与 model 两个键
  const target = rows.find((r) => textOf(r).indexOf('Fast Model') >= 0)
  target.dispatch('click', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 900))
  const after = await (await fetch(ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
  assert('选一个模型 = 同时写入 provider 与 model',
    after.values.provider === 'p1' && after.values.model === 'm-fast',
    `provider=${after.values.provider} model=${after.values.model}`)
  assert('选完下拉自动收起', menu.getAttribute('data-open') === '0', String(menu.getAttribute('data-open')))
  assert('选中的那一行打勾', target.getAttribute('data-on') === '1', String(target.getAttribute('data-on')))

  // 两处模型选择共用一份持久配置。
  {
    const picks = Array.from(walk(settingsSheet)).filter(n => n.className === 'dsh-sel-spick')
    assert('设置页只保留一个模型选择', picks.length === 1, String(picks.length))
    assert('设置选择立即更新输入框模型', hook.modelState().choice?.model === 'm-fast', JSON.stringify(hook.modelState().choice))
    await hook.loadModels(true)
    const composerRows = () => Array.from(walk(hook.modelNodes().menu)).filter(n => n.className === 'dsh-sel-pickerrow')
    composerRows().find(r => textOf(r).includes('Strong Model')).dispatch('click', { preventDefault() {}, stopPropagation() {} })
    assert('输入框选择立即更新设置模型', textOf(pick).includes('Strong Model'), textOf(pick))
    await new Promise(r => setTimeout(r, 900))
    const shared = await (await fetch(ORIGIN + '/selection-explain/api/settings')).json()
    assert('输入框选择持久保存到统一模型', shared.values.provider === 'p1' && shared.values.model === 'm-strong', JSON.stringify(shared.values))

  }

  // 恢复默认：所有参数**立刻**回到默认并显示出来（含两行模型下拉）。
  // 这里专挑"复合键"踩过的坑：模型行的条目 key 是虚拟的，服务端返回的却是 provider/model，
  // 早先按返回键逐个查条目会查不到 —— 于是恢复默认后模型下拉纹丝不动。
  {
    // 先改几项，制造"非默认"状态
    const pick0 = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spick')
    pick0.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 20))
    const rows0 = Array.from(walk(settingsSheet)).filter((n) => n.className === 'dsh-sel-spickrow')
    rows0.find((r) => textOf(r).indexOf('Fast Model') >= 0).dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 900))
    assert('（前提）已改成一个具体模型', textOf(pick0).indexOf('Fast Model') >= 0, textOf(pick0))

    const resetBtn = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sbtn' && textOf(n).indexOf('恢复默认') >= 0)
    resetBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 900))

    const afterReset = await (await fetch(ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
    assert('恢复默认：服务端全部回到默认',
      afterReset.values.provider === '' && afterReset.values.model === '' && hook.modelState().choice === null,
      `provider=${afterReset.values.provider} chatProvider=${afterReset.values.chatProvider}`)
    // 只看"是不是回到了跟随态"：括号里出现 Fast Model 是正常的 ——
    // 那正是本会话当前在用的模型（夹具的 current），跟随态就该把它报出来。
    assert('恢复默认：模型下拉**立刻**显示回「跟随」（不是停在刚才选的）',
      textOf(pick0).indexOf('跟随主会话') >= 0,
      textOf(pick0))
    // 数字/开关也要回到默认：随便挑一个数字输入框比对
    const ttlRow = Array.from(walk(settingsSheet)).find((r) =>
      r.className === 'dsh-sel-srow' && !!Array.from(walk(r)).find((n) => n.attrs && n.attrs['aria-label'] === '生成时限'))
    const ttlInput = ttlRow ? Array.from(walk(ttlRow)).find((n) => n.className === 'dsh-sel-snum') : null
    assert('恢复默认：数字项也回到默认值（600 秒）',
      !!ttlInput && String(ttlInput.value) === String(afterReset.values.timeoutMs / 1000),
      ttlInput ? `${ttlInput.value} vs ${afterReset.values.timeoutMs / 1000}` : '未找到')
  }

  // 真·实时：抽屉**开着不动**，主会话换了模型 → 括号里的名字自己跟着变。
  // （这条是用户报的"还是没有实现"的核心：以前只在开抽屉那一下取一次。）
  {
    const pickEl = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spick')
    const before = textOf(pickEl)
    const fixture = globalThis.__modelCatalogFixture
    globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p1', model: 'm-strong' } }
    // 轮询间隔 2000ms，给够两拍
    for (let i = 0; i < 120 && textOf(pickEl).indexOf('Strong Model') < 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert('抽屉开着不动，主会话换模型后括号自己跟着变（轮询生效）',
      textOf(pickEl).indexOf('Strong Model') >= 0 && textOf(pickEl) !== before,
      `之前"${before}" → 现在"${textOf(pickEl)}"`)
    globalThis.__modelCatalogFixture = fixture
    for (let i = 0; i < 120 && textOf(pickEl).indexOf('Fast Model') < 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  // 实时性：小窗属于**划词那一刻的会话**，且每次开抽屉都要重取模型。
  // 否则切到别的会话 / 主会话中途换模型之后，括号里还停在第一次渲染的那个（用户报的问题）。
  {
    const src = readFileSync(resolve(HERE, '..', 'src', 'client', 'index.js'), 'utf8')
    assert('小窗记住"划词那一刻的会话"（不跟着 currentSessionId 乱跑）',
      /var panelSessionId = ''/.test(src) && /panelSessionId = currentSessionId\(\)/.test(src),
      '没有 panelSessionId 或其捕获点')
    assert('开抽屉时强制重取模型（绕过 60 秒缓存）',
      /refreshModelRow\(settingsByKey\.modelChoice, true\)/.test(src) &&
      /loadModelCatalog\(!!forceRoute, sessionId\)/.test(src),
      'openSettings 没有触发强制刷新')
    // 实时性：主会话随时能换模型，插件这边没有可订阅的事件 —— **小窗或抽屉任意一个开着**
    // 就轮询那条轻量 /route（跟随态下输入框那枚胶囊报的就是这个值）
    assert('小窗/抽屉开着时轮询 /route（实时跟着会话模型变）',
      /function startRouteWatch/.test(src) && /ROUTE_WATCH_MS = \d+/.test(src) &&
      /if \(!settingsOpen && !panelOpen\) \{ stopRouteWatch\(\); return \}/.test(src),
      '没有轮询或没有按"小窗+抽屉"判停')
    assert('两处都收了才停轮询（不空转打接口）',
      /function syncRouteWatch\(\)/.test(src) &&
      /if \(!settingsOpen && !panelOpen\) \{ stopRouteWatch\(\); return \}/.test(src) &&
      !/settingsOpen = false\n        stopRouteWatch\(\)/.test(src),
      'closeSettings 仍无条件停表（小窗开着时胶囊就不跟了）')
    assert('跟随值的更新是独立的一处（抽屉那行没渲染出来也不影响胶囊）',
      /function applyFollowRoute\(route\)/.test(src) && /fetchRoute\([^)]*\)\.then\(applyFollowRoute\)/.test(src),
      '胶囊的更新仍绑在抽屉那一行上')
    assert('按本小窗所属会话取清单，且快照 current（不共享单例）',
      /panelSessionId \|\| currentSessionId\(\)/.test(src) && /current: catalog\.current/.test(src),
      '会话来源或快照写法不对')
    // 显示与实际必须同一个会话：解读/追问/升格三处请求也要用面板所属会话，
    // 否则"括号里显示 A 的模型、实际按 B 解析"，又变成报错。
    const requestSites = (src.match(/sessionId: panelOrCurrentSessionId\(\)/g) || []).length
    assert('解读 / 追问 / 升格三处请求都按面板所属会话发',
      requestSites === 3, `找到 ${requestSites} 处（应为 3）`)
  }

  // 选回「跟随主会话」，别动用户环境
  pick.dispatch('click', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 10))
  rows[0].dispatch('click', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 900))
  const restored = await (await fetch(ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
  assert('选回「跟随主会话」把 provider/model 都清空',
    restored.values.provider === '' && restored.values.model === '',
    `provider=${restored.values.provider} model=${restored.values.model}`)
}

  // 行为验证（用户报的"没有实时更新"）：换掉会话的模型 → 重开抽屉 → 括号里必须跟着变。
  {
    // pick 是上一个块里的 const，出了块就没了 —— 这里重新按类名取一次
    const pickEl = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spick')
    const backBtn = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sheetback')
    const labelBefore = textOf(pickEl)
    // 主会话把模型换成另一个（夹具的 current 就是"本会话在用的模型"）
    const fixture = globalThis.__modelCatalogFixture
    globalThis.__modelCatalogFixture = {
      ...fixture,
      current: { provider: 'p2', model: 'm-other' },
    }
    backBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 20))
    settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    for (let i = 0; i < 80 && textOf(pickEl).indexOf('Other Model') < 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert('重开抽屉后括号里的模型跟着会话变（不是停在第一次渲染）',
      textOf(pickEl).indexOf('Other Model') >= 0 && textOf(pickEl) !== labelBefore,
      `之前"${labelBefore}" → 现在"${textOf(pickEl)}"`)
    globalThis.__modelCatalogFixture = fixture // 还原，别影响后面的用例
    backBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 20))
    settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    for (let i = 0; i < 80 && textOf(pickEl).indexOf('Fast Model') < 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  // 用户报的"输入框那枚模型胶囊没有及时刷新"：抽屉**关着**、小窗开着时也要跟。
  // 跟随态下胶囊报的就是"本会话在用的模型"，而以前只在抽屉开着时轮询 ——
  // 于是"小窗开着、主会话换了模型"要等下一次开/关设置页才更新。
  {
    const backBtn = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sheetback')
    backBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 20))
    assert('（前提）抽屉收起、小窗还开着、模型是跟随态',
      settingsSheet.getAttribute('data-open') === '0' && panel.style.display === 'flex' && hook.modelState().choice === null,
      `sheet=${settingsSheet.getAttribute('data-open')} panel=${panel.style.display} choice=${JSON.stringify(hook.modelState().choice)}`)

    const fixture = globalThis.__modelCatalogFixture
    globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p1', model: 'm-fast' } }
    // 跟随态显示的是清单里的**显示名**（p1/m-fast → Fast Model），不是裸 id
    for (let i = 0; i < 120 && hook.modelState().pill.indexOf('Fast Model') < 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert('抽屉关着：胶囊报出跟随的模型（开窗即对齐，不等第一拍轮询）',
      hook.modelState().pill.indexOf('Fast Model') >= 0,
      `pill="${hook.modelState().pill}"`)

    // 主会话换模型 —— 一次设置页都不用碰
    globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p2', model: 'm-other' } }
    for (let i = 0; i < 120 && hook.modelState().pill.indexOf('Other Model') < 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert('小窗开着、抽屉关着：主会话换模型后胶囊自己跟着变（轮询生效）',
      hook.modelState().pill.indexOf('Other Model') >= 0,
      `pill="${hook.modelState().pill}"`)

    // 小窗收起来 → 轮询停：夹具再换值，胶囊不该跟着动（不空转打接口）
    hook.close()
    await new Promise((r) => setTimeout(r, 20))
    globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p1', model: 'm-fast' } }
    await new Promise((r) => setTimeout(r, 2600))
    assert('小窗与抽屉都收了：轮询停下（值不再跟着变）',
      hook.modelState().pill.indexOf('Other Model') >= 0,
      `pill="${hook.modelState().pill}"`)
    globalThis.__modelCatalogFixture = fixture
  }

  // 用户报的"为什么显示 deepseek-flash"：同一个 model id 在**多个 provider** 下名字不同
  // （实测 deepseek-flash 在 opencode-go 叫「DeepSeek Flash」、在 deepseek-official 叫
  //  「DeepSeek-V41-Flash」）—— 跟随态必须按 provider + model 两个键换成显示名：
  // 既不能显示裸 id，也不能取到别的 provider 的名字。
  // 这条同时验"开窗顺手拉清单"：切到另一个会话（清单缓存按会话隔离）后只开窗、不碰模型菜单，
  // 胶囊也该自己变成显示名。
  {
    const fixture = globalThis.__modelCatalogFixture
    globalThis.__modelCatalogFixture = {
      ok: true,
      current: { provider: 'p2', model: 'shared-id' },
      stages: { chat: 'high' },
      models: [
        { provider: 'p1', providerName: 'P1', model: 'shared-id', name: 'P1 的那个名字', efforts: [], defaultEffort: null },
        { provider: 'p2', providerName: 'DeepSeek', model: 'shared-id', name: 'DeepSeek-V41-Flash', efforts: [], defaultEffort: null },
      ],
    }
    // 换个会话：清单缓存按会话隔离，这样开窗那一下必须真去拉一次（而不是复用旧缓存）
    globalThis.__sessionStubId = 'session-stub-2'
    hook.open('同名模型探测', '', '同名模型')
    for (let i = 0; i < 120 && hook.modelState().pill.indexOf('DeepSeek-V41-Flash') < 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert('跟随态显示清单里的显示名，不再是裸 id',
      hook.modelState().pill.indexOf('DeepSeek-V41-Flash') >= 0 && hook.modelState().pill.indexOf('shared-id') < 0,
      `pill="${hook.modelState().pill}"`)
    assert('同一个 model id 不会取到别的 provider 的名字（按 provider + model 查）',
      hook.modelState().pill.indexOf('P1 的那个名字') < 0,
      `pill="${hook.modelState().pill}"`)
    assert('胶囊 tooltip 带上 provider（同名 id 靠它区分）',
      String(hook.modelNodes().pill.title || '').indexOf('DeepSeek') >= 0,
      `title="${hook.modelNodes().pill.title}"`)
    globalThis.__sessionStubId = 'session-stub-1'
    globalThis.__modelCatalogFixture = fixture
    hook.close()
    await new Promise((r) => setTimeout(r, 30))
  }


// 保存后的设置必须影响入口、状态胶囊和实际选区处理，而不只改变显示值。
{
  const inputFor = label => Array.from(walk(settingsSheet)).find(n => n.getAttribute('aria-label') === label)
  const setNumber = async (label, value) => {
    const input = inputFor(label)
    input.value = String(value)
    input.dispatch('input', { stopPropagation() {}, preventDefault() {} })
    await new Promise(r => setTimeout(r, 700))
  }
  const clickSwitch = async label => {
    inputFor(label).dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise(r => setTimeout(r, 700))
  }
  await setNumber('选中文字上限', 6000)
  hook.close()
  const originalText = selection.toString
  selection.toString = () => '长'.repeat(4500)
  documentStub.dispatch('mouseup', { target: body })
  await new Promise(r => setTimeout(r, 20))
  assert('选中文字上限调到 6000 后，4500 字选区能显示解读入口', button.style.display === 'inline-flex')
  await setNumber('选中文字上限', 20)
  selection.toString = () => '长'.repeat(21)
  documentStub.dispatch('mouseup', { target: body })
  await new Promise(r => setTimeout(r, 20))
  assert('选中文字上限调到 20 后，21 字选区不显示入口', button.style.display === 'none')
  await setNumber('选中文字上限', 4000)
  selection.toString = originalText

  const frame = new FakeEl('iframe')
  frame.setAttribute('data-html-preview', 'true'); frame.setAttribute('sandbox', ''); frame.setAttribute('srcdoc', '<p>入口测试</p>')
  frame.isConnected = true; frame.contentWindow = {name:'settings-bridge-test'}
  const oldQuery = documentStub.querySelectorAll
  documentStub.querySelectorAll = selector => selector === 'iframe' ? [frame] : []
  hook.bridgeScan(); hook.reset()
  const reportSelection = () => windowStub.dispatch('message', {source:frame.contentWindow,data:{__dshSel:1,kind:'selection',sel:{text:'入口测试',context:'',rect:{x:10,y:20,right:100,bottom:38,w:90,h:18}}}})
  await clickSwitch('侧边栏网页划词'); reportSelection()
  assert('关闭侧边栏划词后，已有桥发来的选区也不打开入口', hook.bridge().on === false && hook.selection() === null)
  await clickSwitch('侧边栏网页划词'); reportSelection()
  assert('重新开启侧边栏划词后，帧内选区恢复入口', hook.bridge().on === true && hook.selection()?.source === 'iframe' && button.style.display === 'inline-flex')
  frame.isConnected = false; documentStub.querySelectorAll = oldQuery; hook.reset()

  await clickSwitch('显示状态胶囊')
  assert('关闭状态胶囊保存后实际隐藏', hook.pill().style.display === 'none')
  await clickSwitch('显示状态胶囊')
  assert('开启状态胶囊保存后恢复显示', hook.pill().style.display !== 'none')
  const actualSetTimeout = globalThis.setTimeout
  const scheduledDelays = []
  globalThis.setTimeout = (fn, delay, ...args) => {
    scheduledDelays.push(delay)
    return actualSetTimeout(fn, delay, ...args)
  }
  try { await setNumber('自动收起时间', 5) }
  finally { globalThis.setTimeout = actualSetTimeout }
  assert('自动收起时间实际更新胶囊计时偏好', hook.pillState().idleMs === 5000)
  assert('修改自动收起时间后，已有计时立即按新时长重新安排', scheduledDelays.includes(5000))
  await setNumber('自动收起时间', 10)
  hook.open('settings-return', '', '设置验证')
  await new Promise(r=>setTimeout(r,80))
  settingsBtn.dispatch('click', {stopPropagation(){},preventDefault(){}})
  await new Promise(r=>setTimeout(r,20))
}

// 时间字段按「秒」显示：配置里仍是毫秒（scale 只管显示）
{
  railButtons.find((b) => textOf(b).indexOf('数据') >= 0).dispatch('click', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 10))
  const units = Array.from(walk(settingsSheet))
    .filter((n) => n.className === 'dsh-sel-sunit')
    .map((n) => textOf(n))
  assert('时间字段的单位是「秒」而不是「毫秒」',
    units.filter((u) => u === '秒').length >= 2 && units.indexOf('毫秒') < 0,
    units.join(' / '))

  // 生成时限按秒显示，host 仍存毫秒
  const cacheSpec = await (await fetch(ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
  const rowInput = (key) => {
    const rowEl = Array.from(walk(settingsSheet)).find((r) =>
      r.className === 'dsh-sel-srow' && !!Array.from(walk(r)).find((n) => n.attrs && n.attrs['aria-label'] === key))
    return rowEl ? Array.from(walk(rowEl)).find((n) => n.className === 'dsh-sel-snum') : null
  }
  const cacheInput = rowInput('生成时限')
  assert('生成时限的毫秒 → 秒换算正确',
    !!cacheInput && String(cacheInput.value) === String(cacheSpec.values.timeoutMs / 1000),
    cacheInput ? `${cacheInput.value} vs ${cacheSpec.values.timeoutMs / 1000}` : '未找到输入框')

  // 在界面里改成 120 秒 → 配置里应存 120000 毫秒
  cacheInput.value = '120'
  cacheInput.dispatch('input', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 900))
  const saved = await (await fetch(ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
  assert('界面填 120 秒 = 配置存 120000 毫秒',
    saved.values.timeoutMs === 120000, String(saved.values.timeoutMs))
  // 还原（改回 600 秒）
  cacheInput.value = '300'
  cacheInput.dispatch('input', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 900))
}

// 收尾：这套断言打的是**真实 host** 的 /settings，会真的落盘到
// ${DSH_HOME:-~/.dsh}/selection-explain/settings.json。跑完必须清掉覆盖，
// 否则跑一次测试就在用户环境里留下一份 settings.json（值等于默认，但仍是脏状态）。
{
  const resetRes = await fetch(ORIGIN + '/selection-explain/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  })
  const resetBody = await resetRes.json().catch(() => null)
  assert('测试收尾：清掉设置覆盖，不留 settings.json 残留',
    !!resetBody && resetBody.ok === true && resetBody.values.historyMaxEntries === 20,
    JSON.stringify(resetBody && { ok: resetBody.ok, history: resetBody.values && resetBody.values.historyMaxEntries }))
}

// Esc 只退一层：先收抽屉，小窗留着
{
  const before = panel.style.display
  documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 10))
  assert(
    'Esc 先收抽屉、不关小窗（一次只退一层）',
    settingsSheet.getAttribute('data-open') === '0' && panel.style.display === before,
    `sheet=${settingsSheet.getAttribute('data-open')} panel=${panel.style.display}`,
  )
}

// 用户报的"模型列表上没有标示当前正在使用的模型"：跟随态（没选过具体模型）下，输入框那枚
// 模型菜单里**会话正在用的那个**也要打勾 —— 以前只认"自己选过的"，跟随态一行都不勾。
// 放在这里是因为：再往后的用例只在"本机 DSH 跑在 3080"时才执行，而 test-settings-host.mjs
// 会在下面那个 exit 处收工 —— 放这儿才进得了 `npm test`。
{
  const fixture = globalThis.__modelCatalogFixture
  globalThis.__modelCatalogFixture = {
    ok: true,
    current: { provider: 'p1', model: 'm-fast' },
    stages: { chat: 'high' },
    models: [
      { provider: 'p1', providerName: 'P1', model: 'm-fast', name: 'Fast Model', efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
      { provider: 'p1', providerName: 'P1', model: 'm-strong', name: 'Strong Model', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
      { provider: 'p2', providerName: 'P2', model: 'm-other', name: 'Other Model', efforts: [], defaultEffort: null },
    ],
  }
  hook.open('菜单勾选探测', '', '菜单勾选')
  await new Promise((r) => setTimeout(r, 30))
  await hook.loadModels(true)
  const menu = hook.modelNodes().menu
  const rowsIn = () => Array.from(walk(menu)).filter((n) => String(n.className) === 'dsh-sel-pickerrow')
  const tiersIn = () => Array.from(walk(menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn')
  assert('（前提）跟随态：没选过具体模型', hook.modelState().choice === null, JSON.stringify(hook.modelState().choice))
  const on = rowsIn().filter((r) => r.getAttribute('data-on') === '1')
  assert('跟随态：清单里当前在用的模型也打勾（不再是"一行都不勾"）',
    on.length === 1 && textOf(on[0]).indexOf('Fast Model') >= 0,
    on.map((r) => textOf(r)).join(' | ') || '没有任何一行打勾')
  assert('跟随态那一行带「跟随」小标（这个勾来自主会话，不是自己选的）',
    !!on[0] && !!Array.from(walk(on[0])).find((n) => String(n.className) === 'dsh-sel-pickerfollow' && textOf(n) === '跟随'),
    on[0] ? Array.from(walk(on[0])).map((n) => String(n.className) + ':' + textOf(n)).join(', ') : '未找到')
  assert('跟随态：档位按钮列的是**在用模型**声明的档位（m-fast 四档）',
    tiersIn().map((b) => textOf(b)).join('/') === '关/低/高/最大', tiersIn().map((b) => textOf(b)).join('/'))

  // 选一个具体模型：勾挪到那一行、「跟随」小标消失、档位收缩成它声明的那几档
  const strong = rowsIn().find((r) => textOf(r).indexOf('Strong Model') >= 0)
  strong.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 30))
  const on2 = rowsIn().filter((r) => r.getAttribute('data-on') === '1')
  assert('选过之后：勾挪到选中的那一行',
    on2.length === 1 && textOf(on2[0]).indexOf('Strong Model') >= 0,
    on2.map((r) => textOf(r)).join(' | '))
  assert('选过之后：「跟随」小标消失（这个勾是你自己选的）',
    !Array.from(walk(menu)).some((n) => String(n.className) === 'dsh-sel-pickerfollow'), '')
  assert('选过之后：档位收缩成该模型声明的 2 档',
    tiersIn().map((b) => textOf(b)).join('/') === '关/高', tiersIn().map((b) => textOf(b)).join('/'))

  // 还原：走抽屉里那颗「恢复默认」（客户端自己的路径，state 与 host 都回到跟随态）
  await new Promise((r) => setTimeout(r, 700))
  const resetBtn = Array.from(walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sbtn' && textOf(n).indexOf('恢复默认') >= 0)
  resetBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
  await new Promise((r) => setTimeout(r, 900))
  const back = await (await fetch(ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
  assert('（还原）恢复默认：host 与客户端都回到跟随态',
    back.values.provider === '' && back.values.model === '' && hook.modelState().choice === null,
    JSON.stringify({ provider: back.values.provider, model: back.values.model, choice: hook.modelState().choice }))
  globalThis.__modelCatalogFixture = fixture
  hook.close()
  await new Promise((r) => setTimeout(r, 30))
}

// ⚠️ 这一段必须跑在**新加载**的宿主上（test-settings-host.mjs 用隔离目录新加载一份）。
// 直接对着“正在跑的插件”跑会失败 —— 那是上一次启动时加载的旧代码，
// 除非用户重载过插件。
if (process.env.SEL_SETTINGS_ONLY === '1') {
  // 新增的两个语音收尾开关（界面 · 语音输入）：必须在 spec 里、默认关、且只收布尔值。
  // 尽量只读：唯一的写操作是"true → 再写回 false"，写完回到默认，不留副作用。
  {
    const payload = await (await fetch(ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
    const items = (payload.groups || []).reduce((acc, g) => acc.concat(g.items || []), [])
    const cancelItem = items.find((i) => i.key === 'voiceCancelOnSilence')
    const sendItem = items.find((i) => i.key === 'voiceAutoSend')
    assert(
      '语音收尾的两个开关都在设置 spec 里（kind=switch，挂在界面组）',
      !!cancelItem && !!sendItem && cancelItem.kind === 'switch' && sendItem.kind === 'switch',
      JSON.stringify({ cancel: !!cancelItem, send: !!sendItem, kinds: [cancelItem && cancelItem.kind, sendItem && sendItem.kind] }),
    )
    assert(
      '两个语音开关**默认都是关**',
      payload.defaults.voiceCancelOnSilence === false && payload.defaults.voiceAutoSend === false,
      JSON.stringify({ cancel: payload.defaults.voiceCancelOnSilence, send: payload.defaults.voiceAutoSend }),
    )
    const bad = await (await fetch(ORIGIN + '/selection-explain/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { voiceAutoSend: 'yes' } }),
    })).json()
    assert(
      '语音开关只接受布尔值（字符串被拒，且不写进配置）',
      bad.ok === false && (bad.rejected || []).some((r) => r.key === 'voiceAutoSend'),
      JSON.stringify(bad).slice(0, 140),
    )
    await fetch(ORIGIN + '/selection-explain/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { voiceAutoSend: true, voiceCancelOnSilence: true } }),
    })
    const on = await (await fetch(ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
    assert(
      '两个语音开关能写回并读回',
      on.values.voiceAutoSend === true && on.values.voiceCancelOnSilence === true,
      JSON.stringify({ send: on.values.voiceAutoSend, cancel: on.values.voiceCancelOnSilence }),
    )
    // 写回默认，不留副作用
    await fetch(ORIGIN + '/selection-explain/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { voiceAutoSend: false, voiceCancelOnSilence: false } }),
    })
  }
}

if (process.env.SEL_SETTINGS_ONLY === '1') {
  console.log('=== 设置与模型集成测试结束（真实 host，临时数据目录）===')
  process.exit(process.exitCode ?? 0)
}
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
  // 网页输出还得带上当前深浅：深色 Harness 里给一张白底页面会很刺眼（host 据此注入配色规范）
  assert('网页输出带上当前主题（dark/light）', webPayload.theme === 'dark' || webPayload.theme === 'light', JSON.stringify(webPayload.theme))
  await waitIdle()

  // 主题检测必须优先读 **DSH 自己的信号**（body[data-ds-dark-theme]），而不是面板的合成底色。
  // 踩过的坑：外观设成"跟随系统（暗）"时，面板底色取自 DSH 变量、自身透明 → 被算成浅色
  // → 生成的网页是亮色（用户实测报的）。DSH 不管用户选哪一档，都会把最终配色投影到这个属性上。
  {
    body.setAttribute('data-ds-dark-theme', '')
    const beforeDark = sent.length
    hook.ask('深色下再来一次：三种方式对比')
    for (let i = 0; i < 80 && sent.length === beforeDark; i += 1) await sleep(20)
    const darkPayload = sent[sent.length - 1] || {}
    assert('跟随系统的深色下，网页输出带 theme: dark', darkPayload.theme === 'dark', JSON.stringify(darkPayload.theme))
    body.removeAttribute('data-ds-dark-theme')
    await waitIdle()
  }
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

// ────────────── 正文不再做文本层清洗（照主会话的做法） ──────────────
//
// 以前这里断言"<ds_safety_tool_call> 被剥掉"。现在**故意不清洗**了：
// 主会话从不摘工具，模型走协议层表达工具调用，正文里根本不会有这种标记；
// 而留一道清洗，在标记"未闭合"时会把正文尾巴一起吃掉（实测：收尾轮 raw=726 → emitted=0）。
// 所以这条用例改成锁住"原样显示"，防止以后又有人把清洗加回来。
hook.open('fake-tool-probe', '', '伪造调用')
for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
assert('正文原样保留：客户端不再做文本层清洗', String(hook.state().raw).indexOf('ds_safety_tool_call') >= 0, String(hook.state().raw).slice(0, 60))
assert('正文其余内容保留（不做手术就不会误伤）', textOf(sections[0]).indexOf('没有工具时的回答') >= 0, textOf(sections[0]).slice(0, 80))

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

// ⚠️ 临时诊断的断言（定位完随诊断一起删）：**追问**这条流也要留下逐轮诊断。
// 背景：追问的 SSE 原来没有 done 分支（靠流结束触发 finish），诊断在这里全丢 ——
// 而"25% 的回答结尾是半个句子"恰恰发生在追问上。
{
  for (let i = 0; i < 60 && !(hook.state().diagLog || []).some((d) => d.question); i += 1) await sleep(20)
  const dgAsk = (hook.state().diagLog || []).filter((d) => d.question).pop()
  assert(
    '追问流也记下逐轮诊断（带当轮问题）',
    !!dgAsk && dgAsk.question === '这个要等多久？' && dgAsk.rounds.length === 1 && dgAsk.rounds[0].finish === 'stop',
    JSON.stringify(dgAsk && { q: dgAsk.question, tail: dgAsk.answerTail, rounds: dgAsk.rounds }),
  )
  assert(
    '诊断记下了回答结尾（判断"是不是半个句子"靠它）',
    !!dgAsk && typeof dgAsk.answerTail === 'string' && dgAsk.answerTail.indexOf('等到了回答') >= 0,
    JSON.stringify(dgAsk && dgAsk.answerTail),
  )
  assert(
    '诊断记下结论轮的结束原因（正文真正的来源，也是截断的嫌疑地）',
    !!dgAsk && dgAsk.conclusion && dgAsk.conclusion.finish === 'length' && dgAsk.conclusion.chars === 17,
    JSON.stringify(dgAsk && dgAsk.conclusion),
  )
  assert(
    '诊断带上交叉验证字段（客户端实际字数 vs 宿主的 chars）',
    !!dgAsk && dgAsk.answerLen === '等到了回答。'.length && dgAsk.chars === 6,
    JSON.stringify(dgAsk && { answerLen: dgAsk.answerLen, chars: dgAsk.chars }),
  )
}

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
// 回归：点「最近」列表里的一条时，面板**不能**被重新锚到右下角胶囊上方。
// 给胶囊一个特征坐标（左下角 10,860），若面板被挪到那里，下面的位置断言会立刻失败。
const pillEl = Array.from(walk(panel.parentNode)).find((n) => n.className === 'dsh-sel-pill')
if (pillEl) pillEl.getBoundingClientRect = () => ({ left: 10, top: 860, right: 150, bottom: 890, width: 140, height: 30 })
const panelLeftBefore = panel.style.left
const panelTopBefore = panel.style.top
targetRow.dispatch('click', { stopPropagation() {} })
await sleep(80)
assert('点一条能把那段对话调回面板（不调模型）', sent.length === sentBeforeClick && textOf(sections[0]).indexOf('缓存测试内容') >= 0, `新增请求 ${sent.length - sentBeforeClick}`)
assert(
  '点列表条目时面板不跳到胶囊上方（保持原位）',
  panel.style.left === panelLeftBefore && panel.style.top === panelTopBefore,
  `before=${panelLeftBefore}/${panelTopBefore} after=${panel.style.left}/${panel.style.top}`,
)
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
  '胶囊结构和费用胶囊同构：星芒 + 主体 + 次要 + 箭头',
  !!pill &&
    ['dsh-sel-pillname', 'dsh-sel-pillmeta', 'dsh-sel-pillcaret'].every((c) =>
      Array.from(walk(pill)).some((n) => n.className === c),
    ) &&
    // SVG 元素的 class 是 SVGAnimatedString，客户端用 setAttribute('class', …) 写 —— 桩里也照这个读
    ['dsh-sel-pillicon', 'dsh-sel-pillstar'].every((c) =>
      Array.from(walk(pill)).some((n) => n.getAttribute && n.getAttribute('class') === c),
    ),
  pill ? walk(pill).next().value.className : '',
)
const pillStarEl = pill && Array.from(walk(pill)).find((n) => n.getAttribute && n.getAttribute('class') === 'dsh-sel-pillstar')
assert(
  '球心里的图形初始是"圆点态"那条 path（展开时不许直接画成星）',
  !!pillStarEl && /^M4 0/.test(String(pillStarEl.getAttribute('d'))),
  pillStarEl ? String(pillStarEl.getAttribute('d')).slice(0, 24) : '未找到',
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

// 生成中按 Enter：提示"还在生成"，但**你打的字必须留着**
// （以前是"先清空、再被 ask() 拒掉" —— 字直接丢了，只剩一句提示）
{
  const slowStart2 = sent.length
  hook.open('中止探测', '', '生成中发消息')
  for (let i = 0; i < 60 && sent.length === slowStart2; i += 1) await sleep(20)
  for (let i = 0; i < 60 && hook.state().phase !== 'streaming'; i += 1) await sleep(20)
  assert('（前提）这一轮正在流式输出', hook.state().phase === 'streaming', String(hook.state().phase))
  hook.askValue('生成中想好的下一句')
  const sentBeforeBusy = sent.length
  askBox.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
  // 立刻读：流式的计时器每秒会把 status 覆盖成"生成中… Ns"，晚读就看不到了
  const statusNow = String(hook.state().status || '')
  await sleep(60)
  assert(
    '生成中按 Enter：你打的字还在输入框里（不会被清掉）',
    askBox.value === '生成中想好的下一句',
    JSON.stringify(askBox.value),
  )
  // 注意：这条提示目前**只在 state.lastStatus 里**（界面上不渲染）—— 见提交说明里的发现。
  assert(
    '生成中按 Enter：记下还在生成这条状态（供后续接上可见提示）',
    /还在生成/.test(statusNow),
    JSON.stringify(statusNow),
  )
  assert('生成中按 Enter：没有真的发出去', sent.length === sentBeforeBusy, String(sent.length - sentBeforeBusy))
  hook.askValue('')
  hook.close()
  await sleep(40)
}

// 换选区不该继承上一段对话的检索结果（toolDigest 的语义单位是"一次对话"）
// 踩过的坑：state 整页只建一次，digest 只在历史回放时按条目恢复、别处从不复位 ——
// 于是某段对话搜过新闻之后，之后每一段新选区的追问都带着那段新闻。
{
  hook.open('digest-probe', '', '摘要继承用例')
  for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
  assert('新面板开局：检索摘要是空的', hook.state().toolDigest === '', JSON.stringify(String(hook.state().toolDigest).slice(0, 40)))
  hook.ask('旁白追问')
  for (let i = 0; i < 80 && !hook.state().toolDigest; i += 1) await sleep(20)
  assert('工具检索会累进检索摘要', String(hook.state().toolDigest).length > 0, JSON.stringify(String(hook.state().toolDigest).slice(0, 40)))
  hook.open('digest-probe-2', '', '另一段选区')
  assert('换选区后不继承上一段的检索摘要', hook.state().toolDigest === '', JSON.stringify(String(hook.state().toolDigest).slice(0, 60)))
  for (let i = 0; i < 40; i += 1) await sleep(20)
}

// 结论轮提示（"查询已完成，正在整理结论…"）在正文到达后必须消失
// 踩过的坑：它写进 answerTurn.notice 之后再没有任何地方清掉 —— 回答早就写完了，黄条还挂着。
{
  const noticeEl = () => Array.from(walk(panel)).find((n) => String(n.className).indexOf('dsh-sel-notice') >= 0)
  hook.open('notice-probe', '', '提示用例')
  for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
  hook.ask('这个提示会不会一直挂着')
  for (let i = 0; i < 30 && !noticeEl(); i += 1) await sleep(20)
  assert('结论轮提示会出现（过程状态）', !!noticeEl(), noticeEl() ? JSON.stringify(textOf(noticeEl()).slice(0, 20)) : '未找到')
  for (let i = 0; i < 60 && noticeEl(); i += 1) await sleep(20)
  assert('正文到达后提示消失（不再永远挂着）', !noticeEl(), noticeEl() ? JSON.stringify(textOf(noticeEl()).slice(0, 20)) : '')
  for (let i = 0; i < 40; i += 1) await sleep(20)
}

// ⚠️ 临时诊断的用例（定位完随诊断一起删）：宿主在 done 里回传的逐轮诊断必须留下来。
// 背景：历史里 25% 的助手回答结尾是半个句子，而"掐在哪一环"以前无从判断 ——
// 宿主早就发了这些字段（residueDropped / finish / tools / outTokens），客户端却扔了。
{
  const diagBefore = (hook.state().diagLog || []).length
  hook.open('voice-probe', '', '诊断用例')
  for (let i = 0; i < 100 && (hook.state().diagLog || []).length === diagBefore; i += 1) await sleep(20)
  const diagAll = hook.state().diagLog || []
  const dg = diagAll[diagAll.length - 1]
  assert(
    '逐轮诊断被留下来（查"半个句子"的现场）',
    !!dg && Array.isArray(dg.rounds) && dg.rounds.length === 1 && dg.rounds[0].residueDropped === 7,
    JSON.stringify(dg && dg.rounds),
  )
  assert(
    '诊断里带 finish / tools / outTokens（判掐断类型靠它们）',
    !!dg && Array.isArray(dg.rounds) && dg.rounds.length === 1 && dg.rounds[0].finish === 'tool_calls' && dg.rounds[0].tools === 1 && dg.rounds[0].outTokens === 42,
    JSON.stringify(dg && dg.rounds && dg.rounds[0]),
  )
  hook.close()
  await sleep(40)
}

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
  await new Promise(r => setTimeout(r, 700))
  const selectedSettings = await (await fetch(ORIGIN + '/selection-explain/api/settings')).json()
  assert('模型选择保存到统一设置', selectedSettings.values.provider === 'p1' && selectedSettings.values.model === 'm-strong', JSON.stringify(selectedSettings.values))
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

// ───────────────────────── 侧边栏网页（iframe）划词桥 ─────────────────────────
// 侧边栏 HTML 预览是不透明源沙箱 iframe：父页面读不到里面的选区，
// 所以桥由帧内主动上报。这一段验的是**父侧接线**：注入、来源校验、坐标换算、
// 上下文与标签走通、帧内清空选区后收浮标。
let bridgeOwnedBlob = ''
{
  // 上一段（历史列表）是开着面板测的；划词桥按老规矩"面板开着时不另开一个"，
  // 先收起来，否则下面每条消息都会被 panelOpen 挡掉（那就测了个寂寞）。
  hook.close()
  const beforeBridge = hook.selection()

  /** 宿主基础预览（BasicHtmlFrame）：DOMPurify 清洗 + script-src 'none'，srcdoc + sandbox=""。 */
  const SANITIZED =
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    "script-src 'none'; style-src 'unsafe-inline'\"><style>body{color:red}</style></head>" +
    '<body><p>the migration ran long, so we ship Wednesday</p></body></html>'
  const frame = new FakeEl('iframe')
  frame.setAttribute('data-html-preview', 'true')
  frame.setAttribute('sandbox', '')
  frame.setAttribute('srcdoc', SANITIZED)
  frame.isConnected = true
  const frameWindow = { name: 'sidebar-frame' }
  frame.contentWindow = frameWindow

  documentStub.querySelectorAll = (selector) => (selector === 'iframe' ? [frame] : [])
  const scanned = hook.bridgeScan()
  assert('扫到侧边栏预览帧并桥上', scanned.frames.length === 1 && scanned.frames[0].srcdoc === true, JSON.stringify(scanned.frames))

  const injected = frame.getAttribute('srcdoc')
  assert('桥脚本注入了 srcdoc（内容没被替换掉）', injected.indexOf('data-dsh-sel-bridge') > 0 && injected.indexOf('the migration ran long, so we ship Wednesday') > 0)
  assert('基础预览的 CSP 只放宽 script-src', /script-src 'unsafe-inline'/.test(injected) && /default-src 'none'/.test(injected))
  assert('沙箱补 allow-scripts，但不给 allow-same-origin', frame.getAttribute('sandbox') === 'allow-scripts', String(frame.getAttribute('sandbox')))

  // 陌生窗口发来的同款消息一律不理（消息可以被任意页面伪造，来源必须对得上）
  windowStub.dispatch('message', { source: { name: 'attacker' }, data: { __dshSel: 1, kind: 'selection', sel: { text: '伪造', context: '', rect: { x: 0, y: 0, right: 10, bottom: 10, w: 10, h: 10 } } } })
  const afterForged = hook.selection()
  assert(
    '陌生来源的消息被忽略（选区没被改写）',
    (beforeBridge === null && afterForged === null) || (!!afterForged && afterForged.text === beforeBridge.text && afterForged.source === beforeBridge.source),
    JSON.stringify(afterForged),
  )
  assert('陌生来源的消息不会点亮 bridge()', hook.bridge().active === false)

  // 帧内报来一条选区：帧内视口坐标 + iframe 自身的 getBoundingClientRect（桩：left 40 / top 100）
  windowStub.dispatch('message', {
    source: frameWindow,
    data: {
      __dshSel: 1,
      kind: 'selection',
      sel: {
        text: 'the migration ran long',
        context: 'PM: 这周能发布吗？ Dev: 【the migration ran long】, so we ship Wednesday.',
        keyContext: 'PM: 这周能发布吗？ Dev:',
        label: '',
        rect: { x: 10, y: 20, right: 120, bottom: 38, w: 110, h: 18 },
      },
    },
  })
  const bridgeSelection = hook.selection()
  assert('帧内选区让浮标出现在「帧偏移 + 帧内坐标」处', button.style.display === 'inline-flex' && button.style.left === '98px' && button.style.top === '85px', button.style.left + '/' + button.style.top)
  assert('选区记成 iframe 来源', !!bridgeSelection && bridgeSelection.source === 'iframe' && bridgeSelection.text === 'the migration ran long', JSON.stringify(bridgeSelection))
  assert('标签按帧来源给（侧边栏网页）', bridgeSelection.label === '侧边栏网页', bridgeSelection.label)
  assert('上下文由帧内带来（含【】标记）', bridgeSelection.context.indexOf('【the migration ran long】') > 0, bridgeSelection.context)
  assert('bridge() 报 active', hook.bridge().active === true)

  // 交互式预览：外层是宿主 bootstrap（blob: + document.write），桥要换一份带脚本的 blob 上去
  const BOOTSTRAP =
    '<!doctype html><meta charset="utf-8"><script>(()=>{document.open();document.write("<p>the migration ran long, so we ship Wednesday</p>");document.close()})()</scr' + 'ipt>'
  const originalBlob = URL.createObjectURL(new Blob([BOOTSTRAP], { type: 'text/html;charset=utf-8' }))
  const blobFrame = new FakeEl('iframe')
  blobFrame.setAttribute('data-html-preview', 'true')
  blobFrame.setAttribute('sandbox', 'allow-scripts')
  blobFrame.setAttribute('src', originalBlob)
  blobFrame.isConnected = true
  const blobWindow = { name: 'sidebar-blob-frame' }
  blobFrame.contentWindow = blobWindow
  documentStub.querySelectorAll = (selector) => (selector === 'iframe' ? [frame, blobFrame] : [])
  hook.bridgeScan()
  await sleep(20) // fetch(blob) → 注入 → 换 src 是异步的
  bridgeOwnedBlob = blobFrame.getAttribute('src')
  assert('交互式预览：src 换成我们重发的那份 blob', bridgeOwnedBlob !== originalBlob && bridgeOwnedBlob.startsWith('blob:'), bridgeOwnedBlob)
  assert('交互式预览：换上去的文档里有桥脚本', String(await (await browserFetch(bridgeOwnedBlob)).text()).indexOf('data-dsh-sel-bridge') > 0)
  assert(
    '交互式预览：重发时把原 blob 的 content-type 搬过来（charset 不能丢，否则整页乱码）',
    (blobStore.get(bridgeOwnedBlob) || {}).type === 'text/html;charset=utf-8',
    String((blobStore.get(bridgeOwnedBlob) || {}).type),
  )
  assert('交互式预览：宿主原来那份 blob 不归我们动（它自己回收）', blobStore.has(originalBlob))
  assert('交互式预览：我们自己那份 blob 登记在册（清理时回收）', hook.bridge().frames.some((item) => item.own === true))

  // 帧内清空选区 → 收浮标（顶层选区不会塌，所以只能靠这条消息）
  windowStub.dispatch('message', { source: frameWindow, data: { __dshSel: 1, kind: 'clear' } })
  assert('帧内清空选区后收浮标', button.style.display === 'none' && hook.bridge().active === false)

  // ── 消失时机：帧内的"按下"也要收浮标（父页面收不到帧里的 mousedown）──
  windowStub.dispatch('message', {
    source: frameWindow,
    data: {
      __dshSel: 1,
      kind: 'selection',
      sel: { text: '按住前那一段', context: '【按住前那一段】', keyContext: '', label: '', rect: { x: 4, y: 6, right: 40, bottom: 24, w: 36, h: 18 } },
    },
  })
  assert('（准备）选区先让浮标亮着', button.style.display === 'inline-flex')
  windowStub.dispatch('message', { source: frameWindow, data: { __dshSel: 1, kind: 'press' } })
  assert('帧内按下：浮标立刻收起', button.style.display === 'none')
  assert('帧内按下：这条选区本身还留着（松手后可能还要用）', hook.selection() !== null && hook.selection().source === 'iframe', JSON.stringify(hook.selection()))

  // 按下的若是**另一个**网页：那条选区已经不是用户在看的东西了，状态一起清
  windowStub.dispatch('message', {
    source: frameWindow,
    data: {
      __dshSel: 1,
      kind: 'selection',
      sel: { text: '另一个帧的词', context: '【另一个帧的词】', keyContext: '', label: '', rect: { x: 4, y: 6, right: 40, bottom: 24, w: 36, h: 18 } },
    },
  })
  windowStub.dispatch('message', { source: blobWindow, data: { __dshSel: 1, kind: 'press' } })
  assert('在另一个网页里按下：浮标收起且旧选区状态清掉', button.style.display === 'none' && hook.selection() === null && hook.bridge().active === false)

  // 交互式预览那一帧报来的选区 → 点浮标 → 面板用的就是桥给的上下文
  windowStub.dispatch('message', {
    source: blobWindow,
    data: {
      __dshSel: 1,
      kind: 'selection',
      sel: {
        text: 'slipped',
        context: 'the deadline 【slipped】 to Wednesday',
        keyContext: 'the deadline',
        label: '代码块',
        rect: { x: 8, y: 12, right: 60, bottom: 30, w: 52, h: 18 },
      },
    },
  })
  assert('第二帧的选区也能认（多标签页）', button.style.display === 'inline-flex' && hook.selection().text === 'slipped', JSON.stringify(hook.selection()))
  assert('帧内给的标签优先（代码块）', hook.selection().label === '代码块', hook.selection().label)
  button.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  const bridgePayload = hook.payload()
  assert('点浮标后面板用桥给的上下文（不读顶层 DOM）', !!bridgePayload && bridgePayload.context === 'the deadline 【slipped】 to Wednesday', bridgePayload && bridgePayload.context)
  assert('面板标签也是桥给的', bridgePayload.label === '代码块', bridgePayload && bridgePayload.label)
  hook.close()

  // ── 别的插件在侧边栏渲染的生成网页（「图解」那种：blob: + allow-scripts，没有宿主标记）──
  const visualFrame = new FakeEl('iframe')
  visualFrame.setAttribute('class', 'dsv-frame')
  visualFrame.setAttribute('title', '图解')
  visualFrame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups')
  visualFrame.setAttribute('src', URL.createObjectURL(new Blob(['<!doctype html><html><head><meta charset="utf-8"></head><body><p>图解页</p></body></html>'], { type: 'text/html' })))
  visualFrame.isConnected = true
  const visualWindow = { name: 'reply-visual-frame' }
  visualFrame.contentWindow = visualWindow

  // 反面用例：不该被动的帧
  const opaqueFrame = new FakeEl('iframe') // 没有 allow-scripts 的第三方帧：不给它加权限
  opaqueFrame.setAttribute('sandbox', '')
  opaqueFrame.setAttribute('srcdoc', '<!doctype html><p>别人的沙箱</p>')
  opaqueFrame.isConnected = true
  const remoteFrame = new FakeEl('iframe') // 远端站点：没有任何注入手段
  remoteFrame.setAttribute('sandbox', 'allow-scripts')
  remoteFrame.setAttribute('src', 'https://example.com/')
  remoteFrame.isConnected = true
  const ownFrame = new FakeEl('iframe') // 我们自己小窗里的网页答案预览
  ownFrame.setAttribute('data-preview-id', 'pv1')
  ownFrame.setAttribute('sandbox', 'allow-scripts')
  ownFrame.setAttribute('srcdoc', '<!doctype html><p>生成的网页</p>')
  ownFrame.isConnected = true
  panel.appendChild(ownFrame)

  documentStub.querySelectorAll = (selector) =>
    selector === 'iframe' ? [frame, blobFrame, visualFrame, opaqueFrame, remoteFrame, ownFrame] : []
  hook.bridgeScan()
  await sleep(20) // visualFrame 的 blob 分支也是异步的
  const bridgedNow = hook.bridge().frames
  assert(
    '「图解」那种 blob 帧也被桥上（不只认宿主标记）',
    bridgedNow.length === 3 && visualFrame.getAttribute('data-dsh-sel-bridged') === '1',
    JSON.stringify(bridgedNow),
  )
  assert('第三方没有 allow-scripts 的沙箱帧不动它（不给别人加权限）', opaqueFrame.getAttribute('data-dsh-sel-bridged') === null && opaqueFrame.getAttribute('sandbox') === '')
  assert('远端站点 iframe 不动它', remoteFrame.getAttribute('data-dsh-sel-bridged') === null)
  assert('我们小窗里的网页答案预览不桥（面板开着也不会用它）', ownFrame.getAttribute('data-dsh-sel-bridged') === null)
  assert('「图解」帧的 src 换成了我们重发的那份', visualFrame.getAttribute('src').indexOf('blob:') === 0 && visualFrame.getAttribute('src') !== null)

  windowStub.dispatch('message', {
    source: visualWindow,
    data: {
      __dshSel: 1,
      kind: 'selection',
      sel: { text: '图解里的词', context: '【图解里的词】的上下文', keyContext: '', label: '', rect: { x: 5, y: 6, right: 40, bottom: 22, w: 35, h: 16 } },
    },
  })
  const visualSelection = hook.selection()
  assert('「图解」帧的选区也认', !!visualSelection && visualSelection.text === '图解里的词', JSON.stringify(visualSelection))
  assert('位置标签取帧自己的 title（图解）', visualSelection.label === '图解', visualSelection.label)
  hook.close()
}

// ───────────────────────── 引用（❝）：小窗里的内容 / 主界面选中的文字 → 输入框 ─────────────────────────
// 两个入口共用一份清单（state.quotes），发送时拼进这一条消息：
//   ① 小窗开着时划小窗里的正文 → 「❝ 引用」；
//   ② 小窗开着时划主界面（含侧边栏网页）上的文字 → 同一个浮标；
//   ③ 助手气泡末尾的「引用整条」。
{
  const quoteRect = { left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }
  /** 造一条"本文档里的选区"：起点落在指定的节点上（祖先链就是插件要判定的东西）。 */
  const selectText = (node, text) => {
    const range = {
      startContainer: node,
      endContainer: node,
      cloneRange: () => range,
      getClientRects: () => [quoteRect],
      getBoundingClientRect: () => quoteRect,
    }
    windowStub.getSelection = () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => text,
      getRangeAt: () => range,
    })
  }
  const restoreGetSelection = windowStub.getSelection
  const quoteButton = hook.quoteNode()
  const quotesBox = Array.from(walk(panel)).find((n) => n.className === 'dsh-sel-quotes')
  assert('输入框上方有引用区（默认收起）', !!quotesBox && quotesBox.getAttribute('data-show') === '0', quotesBox ? quotesBox.getAttribute('data-show') : '未找到')

  // 本段自带前提：重开一个小窗（独一无二的选中文字，不吃缓存/历史）
  hook.close()
  hook.open('quote-probe', '引用用例的上下文片段', '引用测试')
  for (let i = 0; i < 120 && hook.state().phase !== 'done'; i += 1) await sleep(20)
  assert('（前提）引用用例的首轮出完', hook.state().phase === 'done', hook.state().phase)

  // ① 小窗里选中的正文（翻译节）
  // ⚠️ mouseup 的 target 必须是**面板里的节点**（真实浏览器就是这样上报的）：
  //    早先 mouseup 对面板内的目标直接 return，小窗里划词毫无反应 —— 用 document.body
  //    当 target 的写法测不出来（实测踩过：只有「引用整条」能用）。
  const sectionP = Array.from(walk(panel)).find((n) => n.tagName === 'P')
  selectText(sectionP, '引用用例的翻译段落')
  documentStub.dispatch('mouseup', { target: sectionP })
  await sleep(30)
  const inPanel = hook.quoteState()
  assert('小窗里划词：浮出「❝ 引用」', inPanel.visible === true, JSON.stringify(inPanel))
  assert(
    '来源写到"哪一节"（用该节自己的标题）',
    !!inPanel.selection && inPanel.selection.label === '小窗「翻译」节' && inPanel.selection.source === 'panel',
    JSON.stringify(inPanel.selection),
  )
  assert('小窗开着时不弹「✦ 解读」（要解读直接在输入框里问）', button.style.display === 'none', String(button.style.display))

  quoteButton.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await sleep(10)
  let quotes = hook.quotes()
  assert('点一下 → 引用区多了一张卡片', quotes.length === 1 && quotes[0].text === '引用用例的翻译段落' && quotes[0].label === '小窗「翻译」节', JSON.stringify(quotes))
  assert('卡片画进输入框上方（来源 + 摘要）', quotesBox.getAttribute('data-show') === '1' && textOf(quotesBox).indexOf('小窗「翻译」节') >= 0 && textOf(quotesBox).indexOf('引用用例的翻译段落') >= 0, textOf(quotesBox))
  assert('加完引用浮标自己收起来（"已经进去了"的信号）', quoteButton.style.display === 'none', String(quoteButton.style.display))
  assert('只挂引用、没写问题时发送键可用', askSend.disabled === false, 'disabled=' + askSend.disabled)
  assert(
    '小窗里的引用**不带上下文**（小窗这几轮对话本来就会随历史进模型）',
    !!quotes[0] && quotes[0].context === '' && quotes[0].session === false,
    JSON.stringify({ context: quotes[0] && quotes[0].context, session: quotes[0] && quotes[0].session }),
  )
  assert(
    '引用浮标画在面板**之上**（小窗里划词才看得见、点得着）',
    Number(quoteButton.style.zIndex) > Number(panel.style.zIndex),
    `quote=${quoteButton.style.zIndex} panel=${panel.style.zIndex}`,
  )

  // 划一大段（超过单段引用上限）也必须有反应：浮标照出，加进去时截断并说明
  {
    selectText(sectionP, '长'.repeat(4200))
    documentStub.dispatch('mouseup', { target: sectionP })
    await sleep(30)
    assert('超长选区照样浮出引用浮标（"划长一点就没反应"是坑）', hook.quoteState().visible === true, JSON.stringify(hook.quoteState()))
    quoteButton.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    await sleep(10)
    const longQuote = hook.quotes().pop()
    assert(
      '超长引用按单段上限截断，并在状态里说明',
      !!longQuote && longQuote.text.length >= 3000 && longQuote.text.length <= 3001 && hook.state().status.indexOf('已截断') > 0,
      `${longQuote && longQuote.text.length} · ${hook.state().status}`,
    )
    const chipList = Array.from(walk(quotesBox)).filter((n) => n.className === 'dsh-sel-quotechip-x')
    // 前面若已失败（引用没挂上），这里就没有 chip —— 别让它把整个脚本打断
    const lastChip = chipList[chipList.length - 1]
    if (lastChip) lastChip.dispatch('click', { stopPropagation() {} })
    await sleep(5)
    assert('删掉超长那条后回到 1 条', hook.quotes().length === 1, JSON.stringify(hook.quotes().map((q) => q.text.length)))
    // 把浮标状态也归零：不然下面那次"再点一次"的点击会把这段长文又加回来
    //（浮标虽然收起来了，但 state.quoteSelection 还留着上一次的选区）
    windowStub.getSelection = () => ({ isCollapsed: true, rangeCount: 0, toString: () => '' })
    documentStub.dispatch('mouseup', { target: sectionP })
    await sleep(20)
  }

  const clicksBefore = hook.quoteState().visible
  quoteButton.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert('浮标收起后再点它不会重复加', hook.quotes().length === 1 && clicksBefore === false, JSON.stringify(hook.quotes().map((q) => q.text)))

  // 同一段再加一次：不加，但要有交代（点了"没反应"是最难查的观感）
  assert(
    '重复的引用不再加，并说明原因',
    hook.quote('引用用例的翻译段落', '小窗回答') === false && hook.state().status.indexOf('已经在引用里') >= 0,
    hook.state().status,
  )

  // 上限：最多 4 段
  hook.quote('第二段引用', '小窗详解')
  hook.quote('第三段引用', '侧边栏网页')
  hook.quote('第四段引用', '调试')
  assert('四段引用都在', hook.quotes().length === 4, JSON.stringify(hook.quotes().map((q) => q.text)))
  assert(
    '第五段被挡下并说明原因',
    hook.quote('第五段引用', '调试') === false && hook.state().status.indexOf('最多 4 段') >= 0,
    hook.state().status,
  )

  // 卡片上的 ✕
  const chipXs = Array.from(walk(quotesBox)).filter((n) => n.className === 'dsh-sel-quotechip-x')
  assert('每张卡片都有 ✕', chipXs.length === 4, String(chipXs.length))
  chipXs[0].dispatch('click', { stopPropagation() {} })
  await sleep(5)
  assert(
    '点 ✕ 能精确删掉那一条',
    hook.quotes().length === 3 && !hook.quotes().some((q) => q.text === '引用用例的翻译段落'),
    JSON.stringify(hook.quotes().map((q) => q.text)),
  )

  // ② 小窗开着时，主界面上的选区也走同一个浮标
  selectText(textEl, '主界面上的这一段')
  documentStub.dispatch('mouseup', { target: textEl })
  await sleep(30)
  const onDoc = hook.quoteState()
  assert('小窗开着时主界面划词：同样浮出「❝ 引用」', onDoc.visible === true, JSON.stringify(onDoc))
  assert('来源标成「主界面选中」', !!onDoc.selection && onDoc.selection.label === '主界面选中' && onDoc.selection.source === 'document', JSON.stringify(onDoc.selection))
  quoteButton.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await sleep(10)
  quotes = hook.quotes()
  assert(
    '主界面选中的文字挂进了同一份清单',
    quotes.length === 4 && quotes[3].text === '主界面上的这一段' && quotes[3].label === '主界面选中',
    JSON.stringify(quotes.map((q) => q.label)),
  )
  assert(
    '主界面的引用标成"会话里的"（发送前会问 host 要按轮取整的上下文）',
    quotes[3].session === true,
    JSON.stringify({ session: quotes[3].session, context: quotes[3].context.slice(0, 30) }),
  )

  // ③ 发送：引用拼进这一条消息（气泡里也要看得见），会话里的引用先补上下文
  const callsBefore = quoteContextCalls.length
  const beforeSend = sent.length
  askBox.value = '这几段有什么关系？'
  askSend.dispatch('click', { stopPropagation() {} })
  for (let i = 0; i < 120 && sent.length === beforeSend; i += 1) await sleep(20)
  const quotePayload = sent[sent.length - 1] || {}
  assert(
    '载荷里的 question 就是拼好的那份（引用在前、问题在后）',
    String(quotePayload.question).indexOf('【引用 1】（来自小窗详解）') === 0 && /【我的问题】\n这几段有什么关系？$/.test(String(quotePayload.question)),
    String(quotePayload.question).replace(/\n/g, '⏎').slice(0, 120),
  )
  assert(
    '每段引用各带来源，按加入顺序编号',
    /【引用 2】（来自侧边栏网页）/.test(String(quotePayload.question)) &&
      /【引用 4】（来自主界面选中）/.test(String(quotePayload.question)) &&
      String(quotePayload.question).indexOf('第五段引用') < 0,
    String(quotePayload.question).replace(/\n/g, '⏎'),
  )
  assert(
    '只给会话里的引用问 host（小窗里的那几段自己就有上下文，不多打一次请求）',
    quoteContextCalls.length === callsBefore + 1 &&
      quoteContextCalls[quoteContextCalls.length - 1].text === '主界面上的这一段' &&
      quoteContextCalls[quoteContextCalls.length - 1].sessionId === 'session-stub-1',
    JSON.stringify(quoteContextCalls.slice(callsBefore)),
  )
  assert(
    '拼好的消息里带上【引用处上下文】，被引用的部分用【】标出',
    String(quotePayload.question).indexOf('【引用处上下文】（被引用的部分用【】标出）') > 0 &&
      String(quotePayload.question).indexOf('用户：【主界面上的这一段】') > 0 &&
      String(quotePayload.question).indexOf('助手：引用之后的那句回答。') > 0,
    String(quotePayload.question).replace(/\n/g, '⏎').slice(-160),
  )
  assert(
    '没有上下文的引用照旧只给原文（不硬造一段空上下文）',
    /【引用 1】（来自小窗详解）\n第二段引用\n/.test(String(quotePayload.question)),
    String(quotePayload.question).replace(/\n/g, '⏎').slice(0, 80),
  )
  assert(
    '引用用完即清（不会跟着下一轮又发一遍）',
    hook.quotes().length === 0 && quotesBox.getAttribute('data-show') === '0',
    JSON.stringify(hook.quotes()),
  )
  const quoteTurn = hook.turns().filter((t) => t.role === 'user').pop()
  assert(
    '轮次里同时留着「问了什么」和「带了哪些引用」',
    quoteTurn.text === '这几段有什么关系？' && (quoteTurn.quotes || []).length === 4 && quoteTurn.sent === quotePayload.question,
    JSON.stringify({ text: quoteTurn.text, quotes: (quoteTurn.quotes || []).length }),
  )
  assert(
    '用户气泡里画出了引用块（引用在上、问题在下）',
    textOf(chatLog).indexOf('❝ 小窗详解') >= 0 && textOf(chatLog).indexOf('这几段有什么关系？') >= 0,
    textOf(chatLog).slice(-90),
  )
  assert(
    '气泡里的引用是摘要（长引用不撑破气泡，完整文本进 title）',
    Array.from(walk(chatLog)).some((n) => n.className === 'dsh-sel-bqitem' && n.title === '第二段引用'),
    Array.from(walk(chatLog)).filter((n) => n.className === 'dsh-sel-bqitem').map((n) => n.title).join('|'),
  )

  // ④ 带引用的那一轮要以"拼好的样子"进历史给模型（否则下一轮模型不知道"这几段"指什么）
  for (let i = 0; i < 120 && hook.state().asking !== false; i += 1) await sleep(20)
  const beforeSecond = sent.length
  hook.ask('那第三段呢？')
  for (let i = 0; i < 120 && sent.length === beforeSecond; i += 1) await sleep(20)
  const secondPayload = sent[sent.length - 1] || {}
  const carried = (secondPayload.history || []).find((t) => t.role === 'user' && String(t.text).indexOf('【引用 1】') >= 0)
  assert(
    '带引用的那一轮原样进历史（引用块不能丢）',
    !!carried && String(carried.text).indexOf('【我的问题】') > 0,
    carried ? String(carried.text).replace(/\n/g, '⏎').slice(0, 60) : JSON.stringify((secondPayload.history || []).map((t) => t.role)),
  )

  // ④b 小窗里的对话引用：**不带上下文**，但要说清出自哪一轮（对话本身会随历史进模型）
  for (let i = 0; i < 120 && hook.state().asking !== false; i += 1) await sleep(20)
  {
    const bubbles = Array.from(walk(chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble-bot') >= 0)
    const target = bubbles[bubbles.length - 1]
    const node = Array.from(walk(target)).find((n) => n.tagName === 'P') || target
    selectText(node, '这是对追问的回答')
    documentStub.dispatch('mouseup', { target: node })
    await sleep(30)
    const state = hook.quoteState()
    assert('小窗气泡里划词：认得出在哪一轮上', state.selection && state.selection.turnIndex >= 0, JSON.stringify(state.selection))
    quoteButton.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    await sleep(10)
    const panelQuote = hook.quotes().pop()
    assert(
      '对话引用的出处 = 「小窗第 N 轮回答」',
      !!panelQuote && /^小窗第 [0-9]+ 轮回答$/.test(panelQuote.label),
      panelQuote && panelQuote.label,
    )
    assert(
      '对话引用不带上下文（小窗对话本来就在历史里，重复贴没意义）',
      !!panelQuote && panelQuote.context === '' && panelQuote.session === false,
      JSON.stringify(panelQuote && { context: panelQuote.context, session: panelQuote.session }),
    )
    const composed = hook.compose()
    assert(
      '拼进消息时只写出处、不贴【引用处上下文】',
      composed.indexOf('【引用处上下文】') < 0 &&
        composed.indexOf('【引用原文】') < 0 &&
        composed.indexOf('【引用 1】（来自小窗第') === 0,
      composed.replace(/\n/g, '⏎').slice(0, 160),
    )
    // 这一段不发了，清掉，别影响后面的用例
    const lastChip = Array.from(walk(quotesBox)).filter((n) => n.className === 'dsh-sel-quotechip-x').pop()
    if (lastChip) lastChip.dispatch('click', { stopPropagation() {} })
    await sleep(5)
  }

  // ④c host 不认（引用不在会话里 / 路由失败）→ 用客户端自己采的那份上下文，照发不误
  for (let i = 0; i < 120 && hook.state().asking !== false; i += 1) await sleep(20)
  {
    globalThis.__quoteContextFixture = 'miss'
    hook.quote('回退探测的一段', '主界面选中', { context: '客户端兜底的上下文：用户：【回退探测的一段】', session: true })
    const beforeFallback = sent.length
    hook.ask('回退探测：这段呢？')
    for (let i = 0; i < 120 && sent.length === beforeFallback; i += 1) await sleep(20)
    const fallbackPayload = sent[sent.length - 1] || {}
    assert(
      'host 定位不到时用客户端兜底的上下文（发送不被卡住）',
      String(fallbackPayload.question).indexOf('用户：【回退探测的一段】') > 0,
      String(fallbackPayload.question).replace(/\n/g, '⏎').slice(0, 120),
    )
    globalThis.__quoteContextFixture = undefined
  }

  // ⑤ 只挂引用、没写问题：也允许发（兜底一句人话，绝不空发）
  for (let i = 0; i < 120 && hook.state().asking !== false; i += 1) await sleep(20)
  hook.quote('只带引用的一段', '主界面选中')
  askBox.value = ''
  const beforeOnly = sent.length
  askBox.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
  for (let i = 0; i < 120 && sent.length === beforeOnly; i += 1) await sleep(20)
  const onlyPayload = sent[sent.length - 1] || {}
  assert('空输入框 + 有引用时按 Enter 能发出去', sent.length === beforeOnly + 1, `sent=${sent.length - beforeOnly}`)
  assert(
    '兜底提问只有一句，引用块照旧在前',
    String(onlyPayload.question).indexOf('【我的问题】\n就上面引用的文字，说说它在这里是什么意思。') > 0,
    String(onlyPayload.question).replace(/\n/g, '⏎').slice(-60),
  )
  const onlyTurn = hook.turns().filter((t) => t.role === 'user').pop()
  assert('气泡里显示的就是那句兜底提问', onlyTurn.text === '就上面引用的文字，说说它在这里是什么意思。', onlyTurn.text)

  // ⑥ 助手气泡末尾的「引用整条」（平时隐身，鼠标移上去才浮出来）
  for (let i = 0; i < 120 && hook.state().asking !== false; i += 1) await sleep(20)
  const botBubbles = Array.from(walk(chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble-bot') >= 0)
  const lastBot = botBubbles[botBubbles.length - 1]
  const quoteAllBtn = Array.from(walk(lastBot)).find((n) => String(n.className).indexOf('dsh-sel-bubquote') >= 0)
  assert('助手气泡末尾有「引用整条」', !!quoteAllBtn && textOf(quoteAllBtn).indexOf('引用整条') >= 0, quoteAllBtn ? textOf(quoteAllBtn) : '未找到')
  quoteAllBtn.dispatch('click', { stopPropagation() {} })
  await sleep(10)
  const allQuotes = hook.quotes()
  const lastBotTurn = hook.turns().filter((t) => t.role === 'assistant' && t.streaming !== true).pop()
  assert(
    '点一下 → 整条回答进了引用',
    allQuotes.length === 1 && /^小窗第 [0-9]+ 轮回答$/.test(allQuotes[0].label) && allQuotes[0].text.indexOf('这是对追问的回答') >= 0,
    JSON.stringify(allQuotes.map((q) => q.label + ':' + q.text.slice(0, 16))),
  )
  assert('引用的是这一轮的原文（卡片上才是摘要）', allQuotes[0].text === lastBotTurn.text, `${allQuotes[0].text.length} vs ${String(lastBotTurn.text).length}`)
  assert(
    '「引用整条」也不带上下文（出处靠标签）',
    allQuotes[0].context === '' && allQuotes[0].session === false,
    JSON.stringify({ context: allQuotes[0].context, session: allQuotes[0].session }),
  )

  // ⑥b 等待/流式中的那条不给「引用整条」：内容是半截的，引用它没有意义（定稿后才出现）
  {
    hook.open('quote-wait-probe', '', '等待用例')
    for (let i = 0; i < 120 && hook.state().phase !== 'done'; i += 1) await sleep(20)
    hook.ask('等待用例的问题')
    let sawStreaming = false
    for (let i = 0; i < 60; i += 1) {
      if (hook.turns().some((t) => t.streaming === true)) {
        sawStreaming = true
        break
      }
      await sleep(10)
    }
    const waiting = Array.from(walk(chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble-bot') >= 0).pop()
    assert(
      '等待/流式中的那条不给「引用整条」',
      sawStreaming &&
        !!waiting &&
        !Array.from(walk(waiting)).some((n) => String(n.className).indexOf('dsh-sel-bubquote') >= 0),
      `${sawStreaming ? 'streaming' : '未抓到流式态'} · ${waiting ? textOf(waiting).slice(0, 20) : '未找到'}`,
    )
    for (let i = 0; i < 160 && hook.state().asking !== false; i += 1) await sleep(20)
    const settled = Array.from(walk(chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble-bot') >= 0).pop()
    assert(
      '定稿之后「引用整条」才出现',
      !!settled && Array.from(walk(settled)).some((n) => String(n.className).indexOf('dsh-sel-bubquote') >= 0),
      settled ? textOf(settled).slice(0, 20) : '未找到',
    )
  }

  // ⑦ 小窗收起来：浮标回到「✦ 解读」（引用只在开着小窗时有意义）
  hook.close()
  selectText(textEl, '主界面上的另一次选中')
  documentStub.dispatch('mouseup', { target: textEl })
  await sleep(30)
  assert(
    '小窗收起后：浮标回到「✦ 解读」，引用浮标不再出现',
    quoteButton.style.display === 'none' && button.style.display === 'inline-flex',
    `quote=${quoteButton.style.display} read=${button.style.display}`,
  )

  // ⑧ 换一段选中文字 = 换一次对话：上一段攒的引用不该跟过来
  hook.open('slipped', '', '换选区')
  await sleep(30)
  assert(
    '换选区后引用清单清空',
    hook.quotes().length === 0 && quotesBox.getAttribute('data-show') === '0',
    JSON.stringify(hook.quotes()),
  )

  windowStub.getSelection = restoreGetSelection
  hook.close()
}

// ═════════════════════ 语音输入（麦克风 → 文字 → 输入框） ═════════════════════
//
// UI 与主会话 ui-voice-input 同一套：平时是输入框右边的 🎤，开始录之后工具行换成
// 录音行 ——`✕` | 实时波形 | `■`；请求权限/识别中是「呼吸点 + 文案」；出错是「文案 + 行内动作」。
// 桩里验四件事：
//   ① 状态机与录音行的形态（哪一格在、哪一格不在，工具行左边三样有没有让位）；
//   ② 波形真的在动（80 根线、静音基线、有声变高、从右往左推）；
//   ③ 文字**插进输入框**（追加在光标处，不覆盖用户已经写了一半的话）；
//   ④ 该松麦克风的时候一定要松（取消 / 失焦 / 收起小窗 / 这条消息发出去）。
//
// 真实识别（真模型 + 真音频）不在这里：见 scripts/test-speech.mjs 与 scripts/smoke-voice.mjs。
function waitVoice(predicate, ms = 1500) {
  const started = Date.now()
  const step = async () => {
    if (predicate()) return true
    if (Date.now() - started > ms) return !!predicate()
    await sleep(10)
    return step()
  }
  return step()
}

/** 从 bundle 源码里抠一个具名函数（与 test-bridge.mjs 同一套配平逻辑）。 */
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

{
  // ── 浏览器音频桩 ──────────────────────────────────────────────
  const micCalls = []
  const micTracks = []
  let micDenied = false
  let micDeferred = null
  const makeTrack = () => {
    const track = {
      stopped: false,
      stop() {
        this.stopped = true
      },
    }
    micTracks.push(track)
    return track
  }
  const makeStream = () => {
    const track = makeTrack()
    return { getTracks: () => [track] }
  }
  navigatorStub.mediaDevices = {
    getUserMedia(constraints) {
      micCalls.push(constraints)
      if (micDenied) {
        const error = new Error('Permission denied')
        error.name = 'NotAllowedError'
        return Promise.reject(error)
      }
      if (micDeferred) {
        const pending = micDeferred
        micDeferred = null
        return pending.promise.then(() => makeStream())
      }
      return Promise.resolve(makeStream())
    },
  }
  /**
   * 电平序列：头几拍是静音（刚点下麦克风还没开口），之后逐次抬高。
   * 这样既能看到"静音 = 2px 基线"，也能看到"新电平从右边进来"（恒定电平看不出推进）。
   */
  let levelStep = 0
  const nextLevel = () => {
    levelStep += 1
    if (levelStep <= 3) return 0
    return Math.min(0.06 + (levelStep - 3) * 0.012, 0.5)
  }
  class MediaRecorderStub {
    constructor(stream) {
      this.stream = stream
      this.state = 'recording'
      this.mimeType = 'audio/webm;codecs=opus'
      MediaRecorderStub.last = this
    }
    start() {
      this.state = 'recording'
    }
    stop() {
      this.state = 'inactive'
      const chunk = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'audio/webm' })
      if (this.ondataavailable) this.ondataavailable({ data: chunk })
      if (this.onstop) this.onstop()
    }
  }
  class AudioContextStub {
    constructor() {
      this.state = 'running'
      this.closed = false
      /** 真实浏览器里通常是 44100/48000：实时字幕的线性重采样要按这个走 */
      this.sampleRate = 48000
      this.processors = []
      AudioContextStub.instances.push(this)
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} }
    }
    createScriptProcessor(size) {
      const node = { size, onaudioprocess: null, connect() {}, disconnect() {} }
      this.processors.push(node)
      return node
    }
    createAnalyser() {
      return {
        fftSize: 256,
        getFloatTimeDomainData(array) {
          const level = nextLevel()
          for (let i = 0; i < array.length; i += 1) array[i] = level
        },
      }
    }
    createMediaStreamSource() {
      return { connect() {} }
    }
    decodeAudioData(_buffer, ok) {
      // 2 秒的"解码结果"：下游只关心 duration 与重采样
      if (ok) ok({ duration: 2, sampleRate: 48000, numberOfChannels: 2 })
      return Promise.resolve({ duration: 2, sampleRate: 48000, numberOfChannels: 2 })
    }
    close() {
      this.closed = true
      return Promise.resolve()
    }
  }
  AudioContextStub.instances = []
  class OfflineAudioContextStub {
    constructor(channels, frames, rate) {
      this.frames = frames
      this.sampleRate = rate
      OfflineAudioContextStub.last = this
    }
    createBufferSource() {
      return { buffer: null, connect() {}, start() {} }
    }
    startRendering() {
      const data = new Float32Array(this.frames)
      for (let i = 0; i < data.length; i += 1) data[i] = Math.sin(i / 20) * 0.5
      return Promise.resolve({ getChannelData: () => data, duration: this.frames / this.sampleRate })
    }
  }
  windowStub.MediaRecorder = MediaRecorderStub
  windowStub.AudioContext = AudioContextStub
  windowStub.OfflineAudioContext = OfflineAudioContextStub

  // ── 面板：打开到"翻译就绪、composer 可见" ──────────────────────
  hook.open('voice-probe', '', '语音输入')
  await waitVoice(() => hook.state().phase === 'done')
  const askRowNode = Array.from(walk(panel)).find((n) => String(n.className).split(/\s+/).includes('dsh-sel-ask'))
  assert('语音用例：composer 已可见', !!askRowNode && askRowNode.style.display !== 'none', askRowNode && askRowNode.style.display)

  const micButton = hook.voiceNode()
  const nodes = hook.voiceNodes()
  const webModeNode = Array.from(walk(panel)).find((n) => String(n.className).split(/\s+/).includes('dsh-sel-pref'))
  const modelPillNode = Array.from(walk(panel)).find((n) => String(n.className).split(/\s+/).includes('dsh-sel-picker'))
  const micNode = Array.from(walk(panel)).find((n) => String(n.className).split(/\s+/).includes('dsh-sel-mic'))
  const toolsRow = micNode && micNode.parentNode
  assert('composer 里有麦克风按钮（和发送键同属工具行）', !!micNode && !!nodes.row, String(!!micNode))
  assert(
    '麦克风在发送键左边（贴 composer 主操作区）',
    !!toolsRow && toolsRow.children.indexOf(micNode) < toolsRow.children.indexOf(askSend),
    toolsRow ? `${toolsRow.children.indexOf(micNode)} < ${toolsRow.children.indexOf(askSend)}` : 'no row',
  )
  assert(
    '初始：录音行没出来、🎤 可见、状态文案是空的',
    hook.voice().phase === 'idle' && hook.voice().capture === false && nodes.row.style.display === 'none' && hook.voice().activity === '',
    JSON.stringify(hook.voice()).slice(0, 120),
  )
  assert('自检钩子能看到"这个环境支持录音"', hook.voice().supported === true, String(hook.voice().supported))

  // ── ① 点一下：请求权限 → 录音（工具行换成录音行）────────────────
  const waveBarsCount = nodes.wave.children.length
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'requesting')
  assert('点 🎤 → 请求权限：录音行出来（和主会话一样，工具行整行换掉）', hook.voice().capture === true, String(hook.voice().capture))
  assert('请求权限时：文案 + 呼吸点，波形与 ■ 都不出现', hook.voice().activity.indexOf('请允许使用麦克风') >= 0 && hook.voice().dot === true && hook.voice().waveform === false && hook.voice().stop === false, hook.voice().activity)
  assert(
    '录音行出来时，输出偏好 / 模型 / 🎤 让位（一行只讲一件事）',
    webModeNode.style.display === 'none' && modelPillNode.style.display === 'none' && micButton.style.display === 'none',
    `${webModeNode.style.display} / ${modelPillNode.style.display} / ${micButton.style.display}`,
  )
  assert('录音行是 ✕ 打头（取消在左边）', nodes.row.children[0] === nodes.cancel, String(nodes.row.children.indexOf(nodes.cancel)))
  assert('波形是 80 根线（和主会话同一个形状）', waveBarsCount === 80, String(waveBarsCount))

  await waitVoice(() => hook.voice().phase === 'recording')
  assert('拿到麦克风 → 进入录音态', hook.voice().phase === 'recording', hook.voice().phase)
  assert('录音时：波形出现、状态文案收起、■ 出现（✕ | 波形 | ■）', hook.voice().waveform === true && hook.voice().stop === true && nodes.activity.style.display === 'none', JSON.stringify({ wave: hook.voice().waveform, stop: hook.voice().stop }))
  assert('只向浏览器要了麦克风（不要摄像头）', micCalls.length === 1 && micCalls[0].video === false, JSON.stringify(micCalls[0]))
  assert(
    '静音时波形是一条虚线（没收到声音的格子都是 2px 基线）',
    hook.voice().bars.filter((height) => height === 2).length >= 70,
    JSON.stringify(hook.voice().bars.slice(0, 6)),
  )

  await sleep(320)
  const bars = hook.voice().bars
  assert('有声之后波形变高（1+min(1,amp*5)*17）', Math.max.apply(null, bars) > 3, String(Math.max.apply(null, bars)))
  assert(
    '新的电平从右边进来、整排往左推（最右边最高）',
    bars[0] > bars[bars.length - 1],
    `${bars[0]} vs ${bars[bars.length - 1]}`,
  )
  assert('录音中不显示秒数文案（主会话也是只看波形）', hook.voice().activity === '', JSON.stringify(hook.voice().activity))

  // ── ② 点 ■ 结束：识别 → 文字插进输入框 ─────────────────────────
  const firstTrack = micTracks[micTracks.length - 1]
  nodes.stop.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'transcribing')
  assert('点 ■ → 识别中：文案 + 呼吸点，波形与 ■ 收起', hook.voice().activity.indexOf('识别中') >= 0 && hook.voice().dot === true && hook.voice().waveform === false && hook.voice().stop === false, hook.voice().activity)
  assert('录音结束 → 松开麦克风（音轨停掉）', firstTrack.stopped === true)
  await waitVoice(() => hook.voice().lastText !== '')
  assert('录音结束后 AudioContext 关掉（不留音频线程）', AudioContextStub.instances.every((ctx) => ctx.closed === true), String(AudioContextStub.instances.length))
  assert('重采样成 16kHz（host 只收这一种）', OfflineAudioContextStub.last && OfflineAudioContextStub.last.sampleRate === 16000, String(OfflineAudioContextStub.last && OfflineAudioContextStub.last.sampleRate))
  assert('识别请求发到了 host（带 base64 音频、不带文件路径之类）', speechTranscribeCalls.length === 1 && typeof speechTranscribeCalls[0].audioBase64 === 'string', Object.keys(speechTranscribeCalls[0] || {}).join(','))
  assert('识别出来的文字进了输入框', askBox.value.indexOf('这段是语音转出来的问题') >= 0, askBox.value)
  assert('插入后光标在末尾（接着就能改 / 接着说）', askBox.selectionStart === askBox.value.length, `${askBox.selectionStart}/${askBox.value.length}`)
  assert('插入后发送键可点', askSend.disabled === false, String(askSend.disabled))
  await waitVoice(() => hook.voice().phase === 'idle')
  assert('成功之后立刻回 idle：录音行收起、🎤 回来、不留多余提示（和主会话一致）', hook.voice().phase === 'idle' && hook.voice().capture === false && micButton.style.display === '' && hook.voice().activity === '', JSON.stringify({ phase: hook.voice().phase, activity: hook.voice().activity }))

  // ── ③ 追加而不是覆盖：用户已经写了一半时接着说 ────────────────
  hook.askValue('先写的一句')
  speechTranscript = { ok: true, text: '后面补的一句' }
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'recording')
  nodes.stop.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().lastText === '后面补的一句')
  assert('已有内容时是追加（中间补一个空格）', askBox.value === '先写的一句 后面补的一句', askBox.value)
  await waitVoice(() => hook.voice().phase === 'idle')
  hook.askValue('')

  // ── ④ 失败路径：权限被拒 → feedback + 🎤 重录 ──────────────────
  micDenied = true
  const tracksBeforeDenied = micTracks.length
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'feedback')
  assert('权限被拒：录音行里给原因（不是 DOMException 原文）', hook.voice().activity.indexOf('麦克风权限未开启') >= 0 && hook.voice().activityTone === 'error', `${hook.voice().activityTone} ${hook.voice().activity}`)
  assert('权限被拒时一个音轨都没拿到', micTracks.length === tracksBeforeDenied, `${micTracks.length} vs ${tracksBeforeDenied}`)
  assert('失败时给「重新录音」🎤（主会话同款行内动作）', hook.voice().action === 'retry' && nodes.action.children.length === 1, `${hook.voice().action} / ${nodes.action.children.length}`)
  micDenied = false

  // ── ⑤ ✕ 关掉这条提示（feedback → idle，工具行还回去）──────────
  nodes.cancel.dispatch('click', { stopPropagation() {} })
  await sleep(20)
  assert('点 ✕ 关掉提示：回 idle、工具行还原（输出偏好 / 模型 / 🎤 都回来）', hook.voice().phase === 'idle' && hook.voice().capture === false && webModeNode.style.display === '' && modelPillNode.style.display === '' && micButton.style.display === '', `${hook.voice().phase} ${webModeNode.style.display}`)

  // ── ⑥ 模型没准备好 → 「准备模型」行内动作 ───────────────────────
  const goodCatalog = speechCatalog
  speechCatalog = {
    ...goodCatalog,
    available: false,
    reason: 'unprepared',
    providers: [{ ...goodCatalog.providers[0], phase: 'unprepared' }],
  }
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().action === 'prepare')
  assert('模型没准备：说清 + 给「准备模型」按钮', hook.voice().activity.indexOf('语音模型还没准备好') >= 0 && hook.voice().activityTone === 'warn', `${hook.voice().activityTone} ${hook.voice().activity}`)
  assert('没准备好时不进录音态（不在没模型时占着麦克风）', hook.voice().phase === 'feedback' && micTracks.length === tracksBeforeDenied, hook.voice().phase)
  const prepareBtn = nodes.action.children[0]
  assert('提示里的按钮确实画出来了', !!prepareBtn && prepareBtn.textContent === '准备模型', prepareBtn ? prepareBtn.textContent : 'none')
  speechCatalog = { ...goodCatalog, available: true, providers: [{ ...goodCatalog.providers[0], phase: 'ready' }] }
  prepareBtn.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => speechPrepareCalls > 0)
  assert('点「准备模型」→ 通知 host 去准备（下载在 host 上跑）', speechPrepareCalls === 1, String(speechPrepareCalls))
  assert('准备中：复用"进行中"形态（文案 + 呼吸点）', hook.voice().activity.indexOf('正在准备语音模型') >= 0 && hook.voice().dot === true, hook.voice().activity)
  await waitVoice(() => hook.voice().activity.indexOf('已就绪') >= 0, 3000)
  assert('准备完成后提示"可以开始说话"（行内动作换成 🎤）', hook.voice().activity.indexOf('已就绪') >= 0 && hook.voice().action === 'retry', `${hook.voice().action} ${hook.voice().activity}`)
  speechCatalog = goodCatalog
  nodes.cancel.dispatch('click', { stopPropagation() {} })
  await sleep(20)

  // ── ⑦ 失败路径：识别失败 / 没听清 ──────────────────────────────
  speechTranscript = { ok: false, code: 'failed', error: '识别服务挂了' }
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'recording')
  nodes.stop.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'feedback')
  assert('识别失败：原样说清原因', hook.voice().activityTone === 'error' && hook.voice().activity.indexOf('识别服务挂了') >= 0, hook.voice().activity)
  assert('识别失败不会往输入框里塞东西', askBox.value === '', JSON.stringify(askBox.value))

  speechTranscript = { ok: false, code: 'empty-transcript', error: '没听清（这段录音里没有识别到内容）' }
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'recording')
  nodes.stop.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().activity.indexOf('未识别到语音') >= 0)
  assert('没听清：给主会话那句「未识别到语音」+ 可重录', hook.voice().activity === '未识别到语音' && hook.voice().activityTone === 'warn' && hook.voice().action === 'retry', `${hook.voice().activityTone} ${hook.voice().activity}`)

  // 识别中点 ✕ = 取消（不能有文字冒出来）
  speechTranscript = { ok: true, text: '这段不该被插进去' }
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'recording')
  nodes.stop.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'transcribing')
  nodes.cancel.dispatch('click', { stopPropagation() {} })
  await sleep(80)
  assert('识别中点 ✕ = 取消（回 idle）', hook.voice().phase === 'idle' && hook.voice().capture === false, hook.voice().phase)
  assert('取消之后晚到的结果不会插进输入框', askBox.value.indexOf('这段不该被插进去') < 0, JSON.stringify(askBox.value))

  // ── ⑧ 权限还没回来就取消：晚到的授权不能变成"在录音" ────────────
  micDeferred = Promise.withResolvers()
  speechTranscript = { ok: true, text: '不该出现的第二段' }
  const beforeCancelCalls = micCalls.length
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => micCalls.length === beforeCancelCalls + 1)
  assert('点了麦克风之后到授权回来之前是「请求中」', hook.voice().phase === 'requesting', `${hook.voice().phase} calls=${micCalls.length}`)
  nodes.cancel.dispatch('click', { stopPropagation() {} })
  assert('请求中点 ✕ = 取消（回 idle）', hook.voice().phase === 'idle' && hook.voice().capture === false, hook.voice().phase)
  const tracksBeforeLate = micTracks.length
  micDeferred && micDeferred.resolve()
  await sleep(80)
  assert(
    '取消后晚到的授权不会偷偷开录（也不留下音轨）',
    hook.voice().phase === 'idle' && micTracks.length === tracksBeforeLate,
    `${hook.voice().phase} tracks=${micTracks.length - tracksBeforeLate}`,
  )

  // ── ⑨ 这条消息发出去了：正在录的那段收掉 ───────────────────────
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'recording')
  const sendTrack = micTracks[micTracks.length - 1]
  hook.ask('边录边说的问题')
  await sleep(60)
  assert('发送消息时正在录的那段被收掉（音轨停掉）', sendTrack.stopped === true, String(sendTrack.stopped))
  assert('并说明为什么停（不是悄悄停）', hook.voice().activity.indexOf('已停止录音') >= 0, hook.voice().activity)
  await waitVoice(() => hook.voice().phase === 'idle', 3000)
  assert('这句交代过两秒自己收起（不占着录音行）', hook.voice().capture === false, String(hook.voice().capture))

  // ── ⑩ 切走窗口（blur）= 停止录音，识别不打断 ───────────────────
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'recording')
  const blurTrack = micTracks[micTracks.length - 1]
  windowStub.dispatch('blur', {})
  await sleep(30)
  assert('窗口失焦：录音取消、麦克风松开（主会话同款）', blurTrack.stopped === true && hook.voice().phase === 'idle', `${blurTrack.stopped} ${hook.voice().phase}`)

  // ── ⑪ 收起小窗 = 立刻松麦克风 ─────────────────────────────────
  micButton.dispatch('click', { stopPropagation() {} })
  await waitVoice(() => hook.voice().phase === 'recording')
  const openTrack = micTracks[micTracks.length - 1]
  hook.close()
  await sleep(30)
  assert('收起小窗：音轨停掉、状态回 idle', openTrack.stopped === true && hook.voice().phase === 'idle', `${openTrack.stopped} ${hook.voice().phase}`)
  assert('收起小窗：录音行一起收掉（不留半句"正在录音"）', hook.voice().capture === false && hook.voice().activity === '', JSON.stringify({ capture: hook.voice().capture, activity: hook.voice().activity }))

  // ══════════ ⑬ 实时字幕：半句预览 + 停顿定稿（采样水龙头驱动）══════════
  // 真浏览器里 onaudioprocess 会自己喂采样；桩里由测试直接喂（同一段代码路径）。
  const feedTap = (node, seconds, amplitude) => {
    const frames = Math.round(seconds * 48000)
    const chunk = new Float32Array(frames)
    for (let i = 0; i < frames; i += 1) chunk[i] = amplitude
    node.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } })
  }

  {
    const before = askBox.value
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
    const tap = context.processors[context.processors.length - 1]
    assert('录音时接上了采样水龙头（实时字幕的前提）', !!tap && hook.voice().live.active === true && hook.voice().live.disabled === false, JSON.stringify(hook.voice().live).slice(0, 120))

    // 说 1.2 秒（响）→ 第一拍半句预览
    speechTranscriptQueue = [{ ok: true, text: '这半句还在说' }]
    feedTap(tap, 1.2, 0.3)
    await waitVoice(() => hook.voice().live.passes.preview >= 1, 2000)
    await waitVoice(() => hook.voice().live.preview !== '', 2000)
    assert('说话时字就往输入框里长（半句预览）', hook.voice().live.preview === '这半句还在说' && askBox.value.indexOf('这半句还在说') >= 0, `${hook.voice().live.preview} / ${JSON.stringify(askBox.value)}`)
    assert('预览是插在原来那段文字后面，不是另起一段', askBox.value.startsWith(before), JSON.stringify(askBox.value))

    // 静音 0.9 秒 → 这句说完了：定稿
    speechTranscriptQueue = [{ ok: true, text: '这句定稿了' }]
    feedTap(tap, 0.9, 0)
    await waitVoice(() => hook.voice().live.passes.commit >= 1, 2500)
    await waitVoice(() => hook.voice().live.committed !== '', 2500)
    assert('停顿 0.6 秒以上 → 这句定稿（预览换成定稿）', hook.voice().live.committed === '这句定稿了' && hook.voice().live.preview === '', JSON.stringify({ committed: hook.voice().live.committed, preview: hook.voice().live.preview }))
    assert('定稿的文字留在输入框里', askBox.value.indexOf('这句定稿了') >= 0, JSON.stringify(askBox.value))

    // 还在说（持续有声，不产生停顿）→ 第二句以"半句预览"接在定稿后面
    hook.voiceTick()
    speechTranscriptRepeat = { ok: true, text: '下一句也在跟' }
    const keepTalking = setInterval(() => feedTap(tap, 0.2, 0.3), 120)
    await waitVoice(() => hook.voice().live.preview === '下一句也在跟', 4000)
    assert('定稿不丢、新的半句接在后面', hook.voice().live.committed === '这句定稿了' && hook.voice().live.preview === '下一句也在跟', JSON.stringify({ committed: hook.voice().live.committed, preview: hook.voice().live.preview }))
    clearInterval(keepTalking)
    speechTranscriptRepeat = null
    assert('输入框里是「定稿 + 空格 + 预览」', askBox.value.indexOf('这句定稿了 下一句也在跟') >= 0, JSON.stringify(askBox.value))

    // ■ 停止：整段识别以定稿开头 → 只补后半句，定稿的字一个不动
    speechTranscriptQueue = [{ ok: true, text: '这句定稿了 下一句也在跟，而且整段还多说了几个字' }]
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'idle', 3000)
    assert(
      '停止时以整段为准收口：定稿部分原样保留，只把后面补全',
      askBox.value.indexOf('这句定稿了 下一句也在跟，而且整段还多说了几个字') >= 0 && hook.voice().live.rewritten === false,
      JSON.stringify(askBox.value),
    )
    assert('停止后实时层关掉（不再刷新）', hook.voice().live.active === false, String(hook.voice().live.active))
  }

  // ── ⑭ 整段识别"对不上"时：以整段为准整块替换（并记一笔）──────────
  {
    hook.askValue('')
    speechTranscriptQueue = [{ ok: true, text: '实时那段' }, { ok: true, text: '实时定稿的那句' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
    const tap = context.processors[context.processors.length - 1]
    feedTap(tap, 1.2, 0.3)
    await waitVoice(() => hook.voice().live.passes.preview >= 1, 2000)
    feedTap(tap, 0.9, 0)
    await waitVoice(() => hook.voice().live.committed !== '', 3000)
    assert('（前置）这一句已经定稿', hook.voice().live.committed === '实时定稿的那句', JSON.stringify(hook.voice().live.committed))
    speechTranscriptQueue = [{ ok: true, text: '整段识别给的是完全不同的句子' }]
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'idle', 3000)
    assert('整段与实时对不上时：整块替换，并以自检记一笔', askBox.value === '整段识别给的是完全不同的句子' && hook.voice().live.rewritten === true, JSON.stringify({ value: askBox.value, rewritten: hook.voice().live.rewritten }))
  }

  // ── ⑮ ✕ 取消 = 只停，已经说出来的字留着（用户明确要的语义）──────────
  {
    hook.askValue('手写的一句')
    speechTranscriptQueue = [{ ok: true, text: '取消之后这句要留着' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
    const tap = context.processors[context.processors.length - 1]
    feedTap(tap, 1.2, 0.3)
    await waitVoice(() => hook.voice().live.preview === '取消之后这句要留着', 3000)
    await waitVoice(() => hook.voice().live.passes.preview >= 1, 500)
    assert('取消前：预览已经在输入框里', askBox.value.indexOf('取消之后这句要留着') >= 0, JSON.stringify(askBox.value))
    const track = micTracks[micTracks.length - 1]
    nodes.cancel.dispatch('click', { stopPropagation() {} })
    await sleep(40)
    assert('✕ 取消 = 停录、松开麦克风', hook.voice().phase === 'idle' && hook.voice().capture === false && track.stopped === true, JSON.stringify({ phase: hook.voice().phase, stopped: track.stopped }))
    assert('✕ 取消 = 已经说出来的字**留着**（连着手写那句一起）', askBox.value === '手写的一句 取消之后这句要留着', JSON.stringify(askBox.value))
    assert('取消后实时层关掉（不再更新那段文字）', hook.voice().live.active === false, JSON.stringify({ active: hook.voice().live.active }))
  }

  // ── ⑯ 失焦 / 收起小窗：录音停下，屏幕上的字留着 ─────────────────
  {
    hook.askValue('')
    speechTranscriptQueue = [{ ok: true, text: '切走也别丢字' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
    const tap = context.processors[context.processors.length - 1]
    feedTap(tap, 1.2, 0.3)
    await waitVoice(() => hook.voice().live.preview === '切走也别丢字', 3000)
    windowStub.dispatch('blur', {})
    await sleep(40)
    assert('失焦停录，但已经写进输入框的字留着', hook.voice().phase === 'idle' && askBox.value.indexOf('切走也别丢字') >= 0, JSON.stringify({ phase: hook.voice().phase, value: askBox.value }))
    hook.askValue('')
  }

  // ── ⑰ 用户在实时那段里改字 → 实时层让位（不跟用户抢）────────────
  {
    speechTranscriptQueue = [{ ok: true, text: '我是预览' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
    const tap = context.processors[context.processors.length - 1]
    feedTap(tap, 1.2, 0.3)
    await waitVoice(() => hook.voice().live.preview === '我是预览' && askBox.value.indexOf('我是预览') >= 0, 3000)
    askBox.value = askBox.value.replace('我是预览', '我改成别的了')
    askBox.dispatch('input', {})
    feedTap(tap, 1.2, 0.3)
    hook.voiceTick()
    await sleep(300)
    assert('用户改了实时那段 → 实时层让位（不改他的字）', hook.voice().live.disabled === true && hook.voice().live.reason === 'edited' && askBox.value.indexOf('我改成别的了') >= 0, JSON.stringify({ reason: hook.voice().live.reason, value: askBox.value }))
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'idle', 3000)
    assert('让位之后停止仍然出最终文字（退回普通插入）', askBox.value.indexOf('我是预览'.slice(0, 0)) >= 0 && askBox.value.indexOf('我改成别的了') >= 0, JSON.stringify(askBox.value))
    hook.askValue('')
  }

  // ── ⑱ 没有采样水龙头（老浏览器）：功能自动退回"停止后出字" ───────
  {
    const realScriptProcessor = AudioContextStub.prototype.createScriptProcessor
    AudioContextStub.prototype.createScriptProcessor = undefined
    speechTranscriptQueue = [{ ok: true, text: '没有水龙头也能出字' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    assert('拿不到水龙头：实时层自己关掉（不报错、不空转）', hook.voice().live.active === false && hook.voice().live.disabled === true && hook.voice().live.reason === 'no-tap', JSON.stringify(hook.voice().live).slice(0, 120))
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'idle', 3000)
    assert('停止后照样把整段文字插进输入框（老行为不变）', askBox.value.indexOf('没有水龙头也能出字') >= 0, JSON.stringify(askBox.value))
    AudioContextStub.prototype.createScriptProcessor = realScriptProcessor
    hook.askValue('')
  }

  // ── ⑲ 云端识别器：不做实时预览（每拍一次付费调用），停止后照常出字 ──
  {
    const hostCatalogFixture = speechCatalog
    speechCatalog = { ...hostCatalogFixture, providers: [{ ...hostCatalogFixture.providers[0], location: 'cloud' }] }
    speechTranscriptQueue = [{ ok: true, text: '云端也能出字，只是没有预览' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    assert('云端识别器：实时层不开（reason=cloud）', hook.voice().live.active === false && hook.voice().live.disabled === true && hook.voice().live.reason === 'cloud', JSON.stringify(hook.voice().live).slice(0, 120))
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'idle', 3000)
    assert('云端：停止后照常把文字插进输入框（退化成"说完再出字"）', askBox.value.indexOf('云端也能出字，只是没有预览') >= 0, JSON.stringify(askBox.value))
    speechCatalog = hostCatalogFixture
    hook.askValue('')
  }

  // ── ⑳ 回归：停顿那几拍"没听清"不能把实时层关掉（用户报的 bug）──────
  // 症状："实时预览只跟第一句，后面就不吐字了"。
  // 原因：停顿里的预览窗口是纯静音 → 识别返回空转写（没听清）→ 被当成"失败"计数，
  //       连挂 3 次就把整个实时层 disable 了。
  {
    hook.askValue('')
    speechTranscriptQueue = [{ ok: true, text: '第一句' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
    const tap = context.processors[context.processors.length - 1]
    feedTap(tap, 1.2, 0.3)
    await waitVoice(() => hook.voice().live.preview === '第一句', 3000)

    // 连续 5 拍都返回"没听清"（对应停顿里那些纯静音窗口）
    speechTranscriptRepeat = { ok: false, code: 'empty-transcript', error: '没听清（这段录音里没有识别到内容）' }
    for (let i = 0; i < 5; i += 1) {
      feedTap(tap, 0.2, 0.3)
      hook.voiceTick()
      await sleep(150)
    }
    assert('空转写不算失败：连来 5 拍"没听清"也不关实时层', hook.voice().live.active === true && hook.voice().live.disabled === false, JSON.stringify({ active: hook.voice().live.active, disabled: hook.voice().live.disabled, reason: hook.voice().live.reason }))
    assert('空结果也不会把上一拍的预览抹掉（不闪没）', hook.voice().live.preview === '第一句' && askBox.value.indexOf('第一句') >= 0, JSON.stringify({ preview: hook.voice().live.preview, value: askBox.value }))

    // 后面的话照样跟着出字（正面用例）
    speechTranscriptRepeat = { ok: true, text: '第二句照样跟' }
    feedTap(tap, 1.2, 0.3)
    await waitVoice(() => hook.voice().live.preview === '第二句照样跟', 3000)
    // 预览本来就是"这一拍窗口的识别结果"，新文本会替换旧的；而且它随时可能被"停顿定稿"接手
    //（这里喂完就停手，600ms 后确实会定稿）。这条回归要的是：**实时层还活着、新的话确实进了输入框**。
    assert(
      '同一段录音里，后面的话照样跟着出字（实时层没死）',
      askBox.value.indexOf('第二句照样跟') >= 0 && hook.voice().live.disabled === false && hook.voice().live.reason === '',
      JSON.stringify({ preview: hook.voice().live.preview, committed: hook.voice().live.committed, value: askBox.value, reason: hook.voice().live.reason }),
    )
    speechTranscriptRepeat = null
    nodes.cancel.dispatch('click', { stopPropagation() {} })
    await sleep(30)
    hook.askValue('')
  }

  // ── ㉑ 真故障连续 5 次才让位；静音窗口根本不发请求 ────────────────
  {
    speechTranscriptQueue = [{ ok: true, text: '先定稿一句' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
    const tap = context.processors[context.processors.length - 1]
    feedTap(tap, 1.2, 0.3)
    await waitVoice(() => hook.voice().live.passes.preview >= 1, 3000)

    // 定稿之后一直是静音：窗口里没有新语音 → 一次调用都不该发
    speechTranscriptQueue = [{ ok: true, text: '定稿的那句' }]
    feedTap(tap, 0.9, 0)
    await waitVoice(() => hook.voice().live.committed !== '', 3000)
    const callsBefore = speechTranscribeCalls.length
    feedTap(tap, 1.0, 0)
    hook.voiceTick()
    await sleep(250)
    hook.voiceTick()
    await sleep(250)
    assert('定稿后一直静音：不再浪费识别调用（也避免把预览刷没）', speechTranscribeCalls.length === callsBefore && hook.voice().live.disabled === false, `${speechTranscribeCalls.length} vs ${callsBefore}`)

    // 真故障（不是"没听清"）：连续 5 次才让位
    speechTranscriptRepeat = { ok: false, code: 'failed', error: '识别服务挂了' }
    for (let i = 0; i < 6; i += 1) {
      feedTap(tap, 0.25, 0.3)
      hook.voiceTick()
      await sleep(180)
    }
    assert('真故障连续 5 次才让位（不让偶发一次超时把字幕关掉）', hook.voice().live.disabled === true && hook.voice().live.reason === 'preview-failed', JSON.stringify({ disabled: hook.voice().live.disabled, reason: hook.voice().live.reason }))
    speechTranscriptRepeat = null
    speechTranscriptQueue = [{ ok: true, text: '让位之后停止照样出字' }]
    nodes.stop.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'idle', 3000)
    assert('让位之后停止仍然出字（整段那条路不受影响）', askBox.value.indexOf('让位之后停止照样出字') >= 0, JSON.stringify(askBox.value))
    hook.askValue('')
  }

  // ── ㉒ 输入框自适应拉伸（用户报：换行后下面的字看不见）────────────────
  // 桩里的 scrollHeight 是可控的：直接改它再触发一次刷新，就是"内容变高了"。
  {
    const box = askBox
    const originalScrollHeight = Object.getOwnPropertyDescriptor(box, 'scrollHeight')
    box.value = ''
    // 一行：高度=内容高度（和 CSS 的 min-height 一致），且不该出现滚动条
    box.scrollHeight = 26
    hook.askValue('一行')
    assert('输入框：一行内容时高度就是内容高（不出滚动条）', box.style.height === '26px' && box.style.overflowY === 'hidden', JSON.stringify({ height: box.style.height, overflow: box.style.overflowY }))
    box.scrollHeight = 78
    hook.askValue('第一行\n第二行\n第三行')
    assert('输入框：多行了就自己长高（高度=内容高）', box.style.height === '78px' && box.style.overflowY === 'hidden', JSON.stringify({ height: box.style.height, overflow: box.style.overflowY }))

    box.scrollHeight = 400
    hook.askValue('很多行'.repeat(80))
    assert('输入框：到上限（132px）就停住、改成内部滚动', box.style.height === '132px' && box.style.overflowY === 'auto', JSON.stringify({ height: box.style.height, overflow: box.style.overflowY }))
    assert('输入框：超过上限时自动滚到最新一行（语音输入一直在末尾加字）', box.scrollTop === 400, String(box.scrollTop))

    // 语音输入落字 → 也会走同一条自适应（liveWrite → refreshAskState）
    box.scrollHeight = 104
    hook.askValue('')
    speechTranscriptQueue = [{ ok: true, text: '这一句会比较长，长到换行以后还能看得见' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
    const tap = context.processors[context.processors.length - 1]
    feedTap(tap, 1.2, 0.3)
    box.scrollHeight = 104
    await waitVoice(() => hook.voice().live.preview !== '', 3000)
    assert('语音输入落字时输入框同样跟着长高', box.style.height === '104px', JSON.stringify({ height: box.style.height, value: box.value }))
    nodes.cancel.dispatch('click', { stopPropagation() {} })
    await sleep(30)

    // 恢复桩的 scrollHeight 语义（后面的用例还要用）
    box.scrollHeight = 0
    if (originalScrollHeight) Object.defineProperty(box, 'scrollHeight', originalScrollHeight)
    hook.askValue('')
  }

  // ── ㉓ Esc 分两级：先取消语音，再关窗（+ 开窗聚焦输入框）────────────
  {
    // 开窗 → 输入框可见后自动聚焦一次（假 DOM 里 focus 是空实现，这里换成探针）
    let focused = 0
    const realFocus = askBox.focus
    askBox.focus = () => {
      focused += 1
    }
    hook.open('voice-probe', '', 'Esc 语义')
    await waitVoice(() => hook.state().phase === 'done', 3000)
    assert('开窗后自动聚焦输入框（键盘用户不用先 Tab）', focused === 1, String(focused))

    // ① 语音进行中按 Esc：只取消这一次语音，面板留着
    speechTranscriptQueue = [{ ok: true, text: '按 Esc 之前已经在框里的字' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
    const tap = context.processors[context.processors.length - 1]
    feedTap(tap, 1.2, 0.3)
    await waitVoice(() => hook.voice().live.preview !== '', 3000)
    const track = micTracks[micTracks.length - 1]
    documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
    await sleep(40)
    assert('语音中按 Esc：录音取消、麦克风松开', hook.voice().phase === 'idle' && track.stopped === true && hook.voice().capture === false, JSON.stringify({ phase: hook.voice().phase, stopped: track.stopped }))
    assert('语音中按 Esc：面板**留着**（不再顺手关掉整个小窗）', hook.quoteState().panelOpen === true && panel.style.display === 'flex', String(hook.quoteState().panelOpen))
    assert('语音中按 Esc：已经说出来的字留着（取消只停，不删字）', askBox.value.indexOf('按 Esc 之前已经在框里的字') >= 0, JSON.stringify(askBox.value))

    // ② 不录音时再按 Esc：这次才关窗
    documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
    await sleep(40)
    assert('不录音时按 Esc：关窗（两级 Esc 的第二级）', hook.quoteState().panelOpen === false && panel.style.display === 'none', String(hook.quoteState().panelOpen))

    // ③ 提示行还在（feedback）时按 Esc：先收起提示，面板不关
    micDenied = true
    hook.open('voice-probe', '', 'Esc 语义')
    await waitVoice(() => hook.state().phase === 'done', 3000)
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'feedback')
    documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
    await sleep(40)
    assert('失败提示还在时按 Esc：收起提示、面板留着', hook.voice().phase === 'idle' && hook.quoteState().panelOpen === true, JSON.stringify({ phase: hook.voice().phase, open: hook.quoteState().panelOpen }))
    micDenied = false
    documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
    await sleep(40)
    assert('提示收掉之后再按 Esc 才关窗', hook.quoteState().panelOpen === false, String(hook.quoteState().panelOpen))
    askBox.focus = realFocus
    hook.askValue('')
  }

  // ── ㉔ 开窗聚焦的两种情形 + 录音时光标跟着预览走 ────────────────
  {
    let focused = 0
    const realFocus = askBox.focus
    askBox.focus = () => {
      focused += 1
    }
    const realActive = documentStub.activeElement

    // ① 焦点在浮标上 —— 这就是真实点开小窗时的情形（Chrome 点 <button> 会把焦点给它）
    hook.close()
    documentStub.activeElement = new FakeEl('button')
    hook.open('voice-probe', '', '聚焦')
    await waitVoice(() => hook.state().phase === 'done', 3000)
    assert('开窗聚焦：焦点在浮标按钮上时也要把光标交给输入框（真实路径）', focused === 1, String(focused))

    // ② 人家正在别处（主会话输入框）打字 → 不抢
    hook.close()
    focused = 0
    documentStub.activeElement = new FakeEl('textarea')
    hook.open('voice-probe', '', '聚焦')
    await waitVoice(() => hook.state().phase === 'done', 3000)
    assert('开窗聚焦：别人正在别处打字就不抢（那才是真的别打扰）', focused === 0, String(focused))

    // ③ 录音一开始就把光标交给输入框；预览落字后光标停在最新文字后面
    hook.close()
    documentStub.activeElement = realActive
    focused = 0
    hook.askValue('')
    speechTranscriptQueue = [{ ok: true, text: '第一拍预览' }]
    micButton.dispatch('click', { stopPropagation() {} })
    await waitVoice(() => hook.voice().phase === 'recording')
    assert('录音开始就把光标交给输入框（不聚焦就看不见光标跳）', focused >= 1, String(focused))
    const context = AudioContextStub.instances[AudioContextStub.instances.length - 1]
    const tap = context.processors[context.processors.length - 1]
    feedTap(tap, 1.2, 0.3)
    await waitVoice(() => hook.voice().live.preview === '第一拍预览', 3000)
    assert('预览落字后：光标停在最新文字末尾（会在那里跳）', askBox.selectionStart === askBox.value.length && askBox.value.length > 0, `${askBox.selectionStart}/${askBox.value.length}`)

    // ④ 预览换成更长的一句 → 光标跟着新末尾走
    speechTranscriptRepeat = { ok: true, text: '第二拍预览更长一些' }
    feedTap(tap, 1.2, 0.3)
    hook.voiceTick()
    await waitVoice(() => hook.voice().live.preview === '第二拍预览更长一些', 3000)
    assert('预览整段替换时：光标跟到新末尾（不会留在旧位置）', askBox.selectionStart === askBox.value.length, `${askBox.selectionStart}/${askBox.value.length}`)

    // ⑤ 用户自己把光标挪走 → 不再跟着挪（不抢他的位置）
    speechTranscriptRepeat = { ok: true, text: '第三拍再长一点的预览文字' }
    askBox.setSelectionRange(0, 0)
    feedTap(tap, 1.2, 0.3)
    hook.voiceTick()
    await sleep(250)
    assert('用户自己挪了光标之后就不再跟着挪（不跟他抢位置）', askBox.selectionStart === 0, String(askBox.selectionStart))

    speechTranscriptRepeat = null
    nodes.cancel.dispatch('click', { stopPropagation() {} })
    await sleep(40)
    askBox.focus = realFocus
    documentStub.activeElement = realActive
    hook.askValue('')
  }

  // ── ⑫ 音频格式：和 host 的 validateWave 同源（纯函数打表）────────
  const helpers = new Function(
    [
      sliceFunction(source, 'encodeWave'),
      sliceFunction(source, 'bytesToBase64'),
      sliceFunction(source, 'formatClock'),
      'return { encodeWave: encodeWave, bytesToBase64: bytesToBase64, formatClock: formatClock }',
    ].join('\n'),
  )()
  const samples = new Float32Array(16000) // 1 秒
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 12) * 0.7
  const wave = helpers.encodeWave(samples)
  const view = new DataView(wave.buffer)
  const ascii = (start, end) => Buffer.from(wave.slice(start, end)).toString('ascii')
  assert('WAV 头：RIFF/WAVE/fmt', ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE' && ascii(12, 16) === 'fmt ', ascii(0, 16))
  assert(
    'WAV 头：16kHz / 单声道 / PCM16（host 逐字段校验的就是这几个）',
    view.getUint32(24, true) === 16000 && view.getUint16(22, true) === 1 && view.getUint16(34, true) === 16 && view.getUint16(20, true) === 1,
    `${view.getUint32(24, true)}Hz ch=${view.getUint16(22, true)} bit=${view.getUint16(34, true)}`,
  )
  assert('WAV 头：长度字段自洽（RIFF / data 都算对）', view.getUint32(4, true) === wave.length - 8 && view.getUint32(40, true) === wave.length - 44, `${view.getUint32(4, true)} / ${view.getUint32(40, true)}`)
  assert('WAV：1 秒 = 44 字节头 + 32000 字节数据', wave.length === 44 + 32000, String(wave.length))
  assert('base64 是可解回来的（host 会校验"规范 base64"）', Buffer.from(helpers.bytesToBase64(wave), 'base64').equals(Buffer.from(wave)), 'round-trip')
  const clipped = helpers.encodeWave(new Float32Array([2, -2, 0]))
  // 16 位小端、有符号：+32767 = ff 7f，-32768 = 00 80（不夹的话 2*32767 会绕成负数）
  assert(
    '采样越界会被夹住（±2 不该绕回成爆音）',
    clipped[44] === 0xff && clipped[45] === 0x7f && clipped[46] === 0x00 && clipped[47] === 0x80,
    `${clipped[44]},${clipped[45]},${clipped[46]},${clipped[47]}`,
  )
  assert('录音秒数显示成 0:07 这种', helpers.formatClock(7500) === '0:07' && helpers.formatClock(60000) === '1:00', helpers.formatClock(7500))

  hook.close()
}

// ───────────────────────── 关闭 / 清理 ─────────────────────────
hook.close()
assert('Esc/关闭后隐藏', panel.style.display === 'none')
// ───────────────────────── 语音卡：选中文字 + 输入法正在语音输入 ─────────────────────────
// 这条链路的关键是"我们不读输入法的转写结果"：输入法上屏只认焦点元素，
// 所以只要在它开麦时把焦点拿到自己的输入框上，说的话就会自己落进来。
{
  // 也认 setAttribute('class') —— SVG 元素的 className 是只读对象，插件只能用 setAttribute
  const find = (cls) =>
    Array.from(walk(mount)).find(
      (n) => n.className === cls || (n.getAttribute && n.getAttribute('class') === cls),
    )

  hook.close()
  await sleep(20)

  // host 报：豆包输入法正在采集麦克风
  micStub.value = {
    ok: true,
    available: true,
    capturing: true,
    processes: [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }],
    reason: '',
  }
  // 同一行里如果有行内元素（<code>/粗体），getClientRects() 会给多个矩形且底边不等高 ——
  // 必须归并成一条，否则会"划两层"、渐隐还会出现在行中间（用户实测的两个问题，同一根因）。
  // 注意：插件在 checkSelection 时就把 range **存下来了**，所以补丁必须打在捕获之前；
  // 而且桩的 getRangeAt() 每次返回新对象（createRange()），所以补丁要打在 createRange 上。
  const realCreateRange = documentStub.createRange.bind(documentStub)
  // 起点所在的"块"：底边 110 —— 落在下面那段大选区（100..200）**中间**。
  // 老代码只按这个块算，卡片就会压在剩下的选中文字上（用户报的"大段文字时卡片遮住文字"）。
  const blockEl = {
    nodeType: 1,
    parentElement: null,
    getBoundingClientRect: () => ({ left: 40, top: 100, right: 500, bottom: 110, width: 460, height: 10 }),
  }
  const realGCS = windowStub.getComputedStyle
  windowStub.getComputedStyle = (el) =>
    el === blockEl
      ? { display: 'block', backgroundColor: 'rgba(0,0,0,0)' }
      : realGCS
        ? realGCS(el)
        : { display: '', backgroundColor: 'rgba(0,0,0,0)' }
  documentStub.createRange = () => {
    const r = realCreateRange()
    r.startContainer = blockEl
    // 真实浏览器实测的形状（选区跨整段时）：一个**块级盒子**（h=53，盖住两行）
    // + 每行两个片段（行内 code 会给出外盒/内盒）。
    // 块盒不丢掉的话会把两行吞成一组 → 只有一条下划线（用户报的"有些行没有划线"）。
    r.getClientRects = () => [
      { left: 20, top: 100, right: 580, bottom: 153, width: 560, height: 53 },
      { left: 20, top: 102, right: 187, bottom: 123, width: 167, height: 21 },
      { left: 187, top: 105, right: 346, bottom: 122, width: 159, height: 17 },
      { left: 20, top: 128, right: 83, bottom: 149, width: 63, height: 21 },
      { left: 83, top: 128, right: 533, bottom: 149, width: 450, height: 21 },
    ]
    // 选区本体很大（跨到 200），起点块只到 110
    // 选区右缘故意放到很靠右（innerWidth 1440）：老规则"正文列左边→选区右缘"会算出 560，
    // 现在统一 360 —— 这条断言就是为了钉住"不再随选区位置变宽"。
    r.getBoundingClientRect = () => ({ left: 40, top: 100, right: 1300, bottom: 200, width: 1260, height: 100 })
    return r
  }

  // 造一次真选区（走 mouseup 那条路）：浮标一出现就开始看麦克风
  windowStub.getSelection = () => selection
  documentStub.dispatch('mouseup', { target: body })
  await sleep(250)

  const opened = hook.voiceCard()
  assert('检测到输入法开麦 → 语音卡自己弹出来', opened.open === true, JSON.stringify(opened))
  assert('卡片处于"在听"状态（竖条呼吸）', opened.voiced === true, JSON.stringify(opened))
  assert(
    '大段选区：卡片按**整个选区**的底边落位（不压在选中的文字上）',
    !!opened.geometry && opened.geometry.top === '222px',
    'top=' + String(opened.geometry && opened.geometry.top) + '（按起点块算会是 132px，正好压在选区里）',
  )
  assert(
    '卡片宽度固定 360（不随选区位置变宽；老规则在这里会给出 560）',
    !!opened.geometry && opened.geometry.width === '360px',
    JSON.stringify(opened.geometry),
  )

  const box = find('dsh-sel-vcard-box')
  const sendBtn = find('dsh-sel-vcard-send')
  assert('卡片里有输入框（IME 上屏要落在它身上）', !!box && !!sendBtn, String(!!box) + '/' + String(!!sendBtn))
  // 「在听」指示器 = 卡片左缘那根 3px 竖条（B1 + 动1，用户选定）
  const vbar = find('dsh-sel-vbar')
  const cardNode = find('dsh-sel-vcard')
  assert(
    '卡片里有那根「在听」竖条，且是卡片的第一个子元素（正文排在它右边）',
    !!vbar && !!cardNode && !!cardNode.children && cardNode.children[0] === vbar,
    vbar ? '竖条存在；是第一个子元素=' + String(!!cardNode && cardNode.children[0] === vbar) : '没找到竖条',
  )
  // 选中提示（下划线 + 牵引线）：**只在卡片打开后才画** —— 选中/浮标阶段不画（那时原生底纹还在）
  const uline = find('dsh-sel-uline')
  const thread = find('dsh-sel-thread')
  assert(
    '卡片打开后画了下划线（按选区逐行矩形）',
    !!uline && /px$/.test(String(uline.style.width)),
    uline ? String(uline.style.width) : 'none',
  )
  assert(
    '下划线是两端渐隐的（U3）',
    !!uline && /linear-gradient/.test(String(uline.style.background)),
    uline ? String(uline.style.background).slice(0, 46) : 'none',
  )
  // （旧的"圆点 display:block"断言删了：圆点现在是 SVG 子元素，没有自己的 display，
  //   由下面的 cx/cy 断言覆盖 —— 那才是它真正要表达的东西。）
  const threadPath = find('dsh-sel-threadpath')
  const threadDot = find('dsh-sel-threaddot')
  const d = threadPath ? String(threadPath.getAttribute('d')) : ''
  assert(
    '牵引线是 **SVG 贝塞尔**（path 里有 C 曲线段，不再是直线）',
    !!threadPath && d.indexOf('C') > 0,
    d ? d.slice(0, 64) : 'none',
  )
  assert(
    '牵引线终点 = **算出来的最终位置** + 4px（222+4=226：一开始就瞄准最终位置，不跟随形变、也不指到解读按钮上）',
    / 964 226$/.test(d),
    'd 的结尾=' + JSON.stringify(d.slice(-14)),
  )
  assert(
    '牵引线起点有锚点圆（cx/cy 落在选区末行中点）',
    !!threadDot && String(threadDot.getAttribute('cx')) === '276.5' && String(threadDot.getAttribute('cy')) === '151',
    threadDot ? 'cx=' + String(threadDot.getAttribute('cx')) + ' cy=' + String(threadDot.getAttribute('cy')) : 'none',
  )

  const merged = Array.from(walk(mount)).filter((n) => n.className === 'dsh-sel-uline')
  assert(
    '块级盒子被丢掉，两行各有一条下划线（不再整段只剩一条）',
    merged.length === 2,
    '下划线条数=' + merged.length + '（应为 2；不丢块盒会是 1）',
  )
  assert(
    '第一行：归并成一条（20..346），取最低底边 123+3',
    !!merged[0] && merged[0].style.width === '326px' && merged[0].style.top === '126px',
    merged[0] ? String(merged[0].style.width) + ' / top=' + String(merged[0].style.top) : 'none',
  )
  assert(
    '第二行也有自己的下划线（20..533）',
    !!merged[1] && merged[1].style.width === '513px' && merged[1].style.top === '152px',
    merged[1] ? String(merged[1].style.width) + ' / top=' + String(merged[1].style.top) : 'none',
  )

  documentStub.createRange = realCreateRange
  windowStub.getComputedStyle = realGCS

  // 焦点：桩 DOM 的 focus() 是空实现，这里换成可观测的再重开一次
  let focused = false
  if (box) box.focus = () => { focused = true }
  hook.voiceCardClose()
  hook.voiceCardOpen()
  assert('打开卡片时把焦点抢到输入框（上屏只认焦点元素）', focused === true, String(focused))

  // 形变期间正文宽度被钉在终值（否则每帧重新折行 → 卡顿）；结束后必须解开，
  // 否则之后打字时正文宽度不会再跟着卡片走
  await sleep(520)
  assert(
    '形变结束后解开正文宽度（回到 flex 布局）',
    !box.style.width && !box.style.flex,
    'width=' + String(box.style.width) + ' flex=' + String(box.style.flex),
  )

  // 开麦结束、一个字都没说：卡片**不退出**（用户可以接着手动打字），只是不再显示"在听"
  micStub.value = { ok: true, available: true, capturing: false, processes: [], reason: '' }
  await sleep(520)
  const silent = hook.voiceCard()
  assert('开麦结束但一个字都没说：卡片留着不退出', silent.open === true, JSON.stringify(silent))
  assert('此时不再显示「在听」（麦克风已经松开了）', silent.voiced === false, JSON.stringify(silent))
  // 恢复"正在录"：后面几步按原样继续
  micStub.value = {
    ok: true,
    available: true,
    capturing: true,
    processes: [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }],
    reason: '',
  }
  await sleep(520)

  // 说话：文字落进输入框（输入法上屏走的就是这条路）
  if (box) {
    box.value = '这是在推迟还是提前？'
    box.dispatch('input', { target: box, preventDefault() {}, stopPropagation() {} })
  }
  const filled = hook.voiceCard()
  assert('有字之后才摆出发送键', filled.hasText === true, JSON.stringify(filled))

  // 发送：跳过翻译与详解，直接进追问
  const beforeSend = hook.state()
  // 焦点探针：小窗自己的规则 —— **一轮输出结束（成功或失败）后**把光标交回输入框。
  // 注意这不是"从临时卡进小窗"的特例：划词解读、打开历史都走同一条规则。
  let askFocused = 0
  const realAskFocus = askBox.focus
  askBox.focus = () => {
    askFocused += 1
  }
  // 发送那一刻焦点确实在卡片输入框里（真实状态）——正是它让"开窗聚焦"那次让了路
  documentStub.activeElement = box
  if (sendBtn) sendBtn.dispatch('click', { target: sendBtn, preventDefault() {}, stopPropagation() {} })
  await sleep(80)
  const afterSend = hook.state()
  assert('发送后卡片收起', hook.voiceCard().open === false, JSON.stringify(hook.voiceCard()))
  // 卡片隐藏后浏览器会把焦点收回 body —— 桩里不会（它不模拟"隐藏即失焦"），
  // 所以这里持续保持这个**忠实状态**：否则焦点会一直挂在已隐藏的卡片输入框上，
  // 后面的礼貌守卫就会误判成"人家正在别处打字"（实测就是这么卡的）。
  for (let i = 0; i < 60 && hook.state().phase !== 'done'; i += 1) {
    documentStub.activeElement = body
    await sleep(60)
  }
  assert('（前提）这一轮输出已经结束', hook.state().phase === 'done', String(hook.state().phase))
  // 别再往 body 上还原了：聚焦是在这一轮结束那一刻发生的，紧接着断言才对得上
  //（之前循环退出后还还原一次，把自己刚要验的焦点冲掉了 —— 实测就是这么红的）
  await sleep(260)
  assert(
    '小窗规则：一轮输出结束后，光标自动回到小窗输入框（可以直接继续追问）',
    // 只断言"规则触发了"：桩里的 activeElement 会被好几个角色来回改（临时卡片的输入框也在抢），
    // 断言它等于 askBox 会很脆、也未必反映真实浏览器。真正的插入符在无头 Chrome 里画不出来
    // （无头不渲染 caret），所以这一层只能验到"规则执行了"，插入符靠真机确认。
    askFocused > 0,
    'focus 次数=' + String(askFocused) + ' 卡在=' + String(hook.focusBail()),
  )
  askBox.focus = realAskFocus
  // 还原焦点：不还原的话它会一直停在别处，后面用例开卡片会被"别处正在打字"那条守卫挡掉
  documentStub.activeElement = body

  // 追问失败也要把光标交回输入框 —— 这条路原来漏了规则（用户实测："报错之后输入框没有光标"）
  {
    let focusAfterAskError = 0
    const realAskFocus2 = askBox.focus
    askBox.focus = () => {
      focusAfterAskError += 1
    }
    globalThis.__askFailOnce = true
    const sentBeforeAsk = sent.length
    hook.ask('这条追问会失败')
    await sleep(200)
    // 追问的问答在 chat log 里（不在翻译正文 panelBody 里），所以整个面板一起找
    for (let i = 0; i < 50 && !!globalThis.__askFailOnce; i += 1) await sleep(60)
    // 前置条件用**可证明的事实**：请求发出去了、而且被桩的失败注入接走了。
    //（不查"面板里有没有『追问失败』这行字"：桩里那行渲染文本用 textOf 够不到，
    //  查它会得到一个恒假的断言 —— 那是测试环境的事，不是产品行为。）
    assert(
      '（前提）追问请求发了，且这次被桩按失败处理',
      sent.length - sentBeforeAsk > 0 && !globalThis.__askFailOnce,
      '请求数=' + String(sent.length - sentBeforeAsk) + ' 失败注入已消费=' + String(!globalThis.__askFailOnce),
    )
    assert(
      '追问失败后，光标也回到小窗输入框（这条路原来漏了"一轮结束就交回光标"的规则）',
      focusAfterAskError > 0,
      'focus 次数=' + String(focusAfterAskError),
    )
    askBox.focus = realAskFocus2
    documentStub.activeElement = body
  }
  assert('跳过解读：翻译一节是空的（没请求 /analyze）', !afterSend.translation, JSON.stringify(beforeSend) + ' → ' + JSON.stringify(afterSend))
  assert('直接进了追问：面板开着', panel.style.display !== 'none', String(panel.style.display))

  // Esc 收卡片（还没发出去时）
  micStub.value = { ok: true, available: true, capturing: true, processes: [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }], reason: '' }
  hook.close()
  await sleep(20)
  documentStub.dispatch('mouseup', { target: body })
  await sleep(250)
  const reopened = hook.voiceCard()
  if (reopened.open) {
    documentStub.dispatch('keydown', { key: 'Escape', target: body, preventDefault() {}, stopPropagation() {} })
    await sleep(20)
    assert('Esc 收起语音卡', hook.voiceCard().open === false, JSON.stringify(hook.voiceCard()))
    // 取消后**不还回**「✦ 解读」浮标（用户要求：取消就是取消，别再冒出来问"要不要解读"）
    assert(
      '取消后不还回「✦ 解读」浮标',
      button.style.display === 'none',
      '浮标 display=' + String(button.style.display),
    )
    // 取消时播"老式电视机关机"（A 方案）：卡片先留在画面上塌缩，动画结束才真正隐藏
    const closingState = hook.voiceCard()
    const cardEl = find('dsh-sel-vcard')
    const crtLine = find('dsh-sel-crtline')
    assert('取消时先播关机动画（卡片还在画面上）', closingState.closing === true, JSON.stringify(closingState))
    assert(
      '关机动画挂在卡片上（data-off=a）',
      !!cardEl && cardEl.getAttribute('data-off') === 'a',
      cardEl ? String(cardEl.getAttribute('data-off')) : 'no card',
    )
    assert(
      '亮线拆成 5 段 + 2 个火花，宽度跟着卡片、颜色按明暗给',
      !!crtLine &&
        crtLine.style.width === '360px' &&
        !!crtLine.style.color &&
        !!crtLine.children &&
        crtLine.children.length === 7,
      crtLine
        ? crtLine.style.width + ' / ' + String(crtLine.style.color) + ' / 子元素 ' + String(crtLine.children.length)
        : 'no line',
    )
    // 桩环境没有 animationend，走 640ms 兜底
    await sleep(780)
    const closed = hook.voiceCard()
    assert(
      '关机动画结束后卡片才真正隐藏',
      closed.closing === false && !!cardEl && cardEl.style.display === 'none' && !cardEl.getAttribute('data-off'),
      JSON.stringify(closed) + ' / display=' + (cardEl ? String(cardEl.style.display) : '?'),
    )
    assert('亮线也一并收掉', !!crtLine && !crtLine.getAttribute('data-off'), crtLine ? String(crtLine.getAttribute('data-off')) : 'no line')
    assert(
      '卡片收起后选中提示一并清掉',
      !find('dsh-sel-uline') && !!thread && thread.style.display === 'none',
      '下划线=' + String(!!find('dsh-sel-uline')) + ' 牵引线 display=' + (thread ? String(thread.style.display) : '?'),
    )
  } else {
    assert('Esc 收起语音卡', false, '卡片没能再次打开：' + JSON.stringify(reopened))
  }

  // ── 两个新开关（设置页「界面 · 语音输入」，默认都关）──
  // 默认关时的行为（"卡片留着"）上面已经验过；这里验打开后的两条收尾。
  // 关键：松手**不是**决定时刻 —— 输入法在松手后还会做一次智能整理（改写输入框内容），
  // 所以两个动作都要等文字定稿（连续 VOICE_SETTLE_MS=700ms 没变化）才发生。
  {
    const IME = [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }]
    const recording = { ok: true, available: true, capturing: true, processes: IME, reason: '' }
    const stopped = { ok: true, available: true, capturing: false, processes: [], reason: '' }

    // ① 「空录音时收起」：松手后不立刻收，等定稿才收（而且走取消路径）
    settingsStub.value = { voiceCancelOnSilence: true }
    hook.reloadSettings()
    await sleep(320)
    hook.close()
    micStub.value = recording
    await sleep(420)
    hook.voiceCardOpen()
    if (box) {
      box.value = ''
      box.dispatch('input', { target: box, preventDefault() {}, stopPropagation() {} })
    }
    await sleep(80)
    micStub.value = stopped
    await sleep(300)
    assert(
      '松手后**不会立刻**取消（要等文字定稿：输入法松手后还会智能整理）',
      hook.voiceCard().open === true,
      JSON.stringify(hook.voiceCard()),
    )
    await sleep(900)
    const cardSilent = find('dsh-sel-vcard')
    assert('定稿后才取消（空录音）', hook.voiceCard().open === false, JSON.stringify(hook.voiceCard()))
    assert(
      '空录音收起走的是**取消**路径（关机动画 data-off=a，不是无声消失）',
      !!cardSilent && cardSilent.getAttribute('data-off') === 'a',
      cardSilent ? String(cardSilent.getAttribute('data-off')) : 'no card',
    )

    // ② 「说完直接发送」：松手后等定稿才发；期间模拟豆包的智能整理改写输入框
    settingsStub.value = { voiceAutoSend: true }
    hook.reloadSettings()
    await sleep(320)
    await sleep(800) // 等上一条关机动画彻底收尾
    hook.close()
    await sleep(20)
    micStub.value = recording
    await sleep(420)
    hook.voiceCardOpen()
    if (box) {
      box.value = '这是 在推迟 还是提前' // 整理之前：有空格、没标点
      box.dispatch('input', { target: box, preventDefault() {}, stopPropagation() {} })
    }
    await sleep(80)
    const sentBefore = sent.length
    micStub.value = stopped
    await sleep(300)
    assert(
      '松手后**不会立刻**发送（要等文字定稿）',
      hook.voiceCard().open === true && sent.length === sentBefore,
      JSON.stringify(hook.voiceCard()) + ' / sent=' + String(sent.length - sentBefore),
    )
    // 模拟智能整理：松手之后才改写输入框，而且是**直接改 value、不派发 input**（真实情况就是这样）
    const cleaned = '这是在推迟还是提前，release notes 要不要一起改。'
    if (box) box.value = cleaned
    await sleep(300)
    assert(
      '整理过程中仍然不发（每改一次就重新计时）',
      hook.voiceCard().open === true && sent.length === sentBefore,
      JSON.stringify(hook.voiceCard()) + ' / sent=' + String(sent.length - sentBefore),
    )
    // 主信号：输入法的智能整理**走合成 API 提交**（实测 8 次录音里 6 次都有）
    if (box) box.dispatch('compositionend', { data: cleaned })
    await sleep(260)
    assert(
      '收到 compositionend 后**短窗口内**就决定（260ms 就发了 —— 兜底的 700ms 静默还没到）',
      hook.voiceCard().open === false,
      JSON.stringify(hook.voiceCard()),
    )
    assert(
      '发出去的是**整理之后**的文字（不是松手那一刻的草稿）',
      // 问题在 question 字段（text 是选中的原文）
      sent.slice(sentBefore).some((b) => b && (b.question === cleaned || b.text === cleaned)),
      JSON.stringify(sent.slice(sentBefore).map((b) => b && b.question)),
    )

    // 收尾：设置清回默认，别影响后面的用例
    settingsStub.value = {}
    hook.reloadSettings()
    await sleep(300)
  }

  micStub.value = { ok: true, available: false, capturing: false, processes: [], reason: 'stub-default' }
  hook.close()
  await sleep(20)
}

for (const dispose of disposers.reverse()) {
  try {
    dispose()
  } catch (error) {
    console.log('cleanup 抛错:', error && error.message)
  }
}
// ────────── 拖拽上限 = 视口高度 − 8，不是"上次关闭小窗之前的高度" ──────────
// 踩过的坑：开窗时把"记住的高度"写成 max-height 当天花板，而拖拽只写 height、不抬天花板 →
// 拖大的部分被那条旧天花板直接截掉。取证：maxHeight 仍停在开窗时的那条 300px。
{
  sizeStore = { w: 380, h: 300 } // 造一个很小的"上次记住的高度"
  hook.close()
  await sleep(40)
  hook.open('size-ceiling-probe', '', '尺寸天花板用例')
  for (let i = 0; i < 80 && hook.state().phase !== 'done'; i += 1) await sleep(20)
  await sleep(30)
  // 注：这里**不**断言"开窗时已应用记住的高度" —— loadPanelSize 整页只请求一次，
  // 而它在本次用例跑之前（sizeStore 还是 null 时）就已经标记"问过了"，桩里造不出这个前提。
  // 好在下面的断言本身就能抓住这个 bug：没有修复时拖拽只写 height、不抬 max-height，
  // maxHeight 会停在开窗时的值（或为空），dragH > 300 直接不成立。
  const grip = Array.from(walk(panel)).find((n) => String(n.className).indexOf('dsh-sel-grip-corner') >= 0)
  assert('（前提）找得到右下角拖拽手柄', !!grip, String(grip && grip.className))
  grip.dispatch('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1, preventDefault() {}, stopPropagation() {} })
  windowStub.dispatch('pointermove', { clientX: 0, clientY: 800 })
  const dragH = parseInt(panel.style.maxHeight, 10)
  assert('拖高之后天花板跟着抬高（不再被旧高度卡住）', dragH > 300, String(panel.style.maxHeight))
  assert('上限是视口高度 − 8', dragH <= 900 - 8, String(panel.style.maxHeight))
  assert('拖出来的高度当场生效（height 与天花板一致）', panel.style.height === panel.style.maxHeight, JSON.stringify({ h: panel.style.height, max: panel.style.maxHeight }))
  windowStub.dispatch('pointerup', {})
  await sleep(380) // 等防抖存档落盘（走桩，不会写进真实 host）
  grip.dispatch('dblclick', { preventDefault() {}, stopPropagation() {} })
  await sleep(40)
  assert('双击手柄恢复默认（天花板清空）', panel.style.maxHeight === '', JSON.stringify(panel.style.maxHeight))
  sizeStore = null
}

// ⚠️ 放在**最后**：这一节前面/中间还有别的用例会写模型设置，早了会被覆盖掉。
// 还原真实配置：这一段跑在"用户正在用的插件"上时，把进本节之前的快照写回去。
// 隔离宿主（test-settings-host.mjs）下也无害 —— 那份宿主本来就是一次性的。
{
  const values = (settingsSnapshot && settingsSnapshot.values) || {}
  // 只发有值的、且不是虚拟键的（虚拟键会被宿主拒掉，返回 rejected 里，无害但还是别发）
  const restore = {}
  Object.keys(values).forEach((key) => {
    if (key === 'modelChoice') return
    if (values[key] === undefined || values[key] === null) return
    restore[key] = values[key]
  })
  if (Object.keys(restore).length) {
    await fetch(ORIGIN + '/selection-explain/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: restore }),
    })
  }
}

assert('清理后 DOM 归零', mount.children.length === 0 && body.children.indexOf(container) >= 0)
assert('清理后划词桥自己建的预览 blob 被回收', bridgeOwnedBlob !== '' && !blobStore.has(bridgeOwnedBlob), bridgeOwnedBlob)
assert('清理后钩子移除', windowStub.__dshSelectionExplain === undefined)
console.log('\n=== 客户端集成测试结束 ===')

} else {
  console.log('\n=== 客户端集成测试结束（离线模式：仅跑了不依赖宿主的断言）===')
  console.log(`   跳过原因：${ORIGIN} 不可达。完整验证请在 DSH 运行中执行本脚本。`)
}

// 显式退出：离线分支跳过了在线部分的 dispose()，客户端留下的定时器/监听会让
// 事件循环一直空转（表现为"测试跑完但不退出"）。按 process.exitCode 正常退出。
process.exit(process.exitCode ?? 0)
