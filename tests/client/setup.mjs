import { encodeWave, bytesToBase64 } from '../../src/client/audio.js'
import { formatClock } from '../../src/client/dom.js'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function createClientFixture() {


  const HERE = dirname(fileURLToPath(import.meta.url))

  const BUNDLE = process.argv[2] || resolve(HERE, '..', '..', 'lib', 'client.js')


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
    insertBefore(child, reference) {
      if (reference == null) return this.appendChild(child)
      if (child === reference) return child
      if (!this.children.includes(reference)) throw new Error('Reference node is not a child')
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      this.children.splice(this.children.indexOf(reference), 0, child)
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
    hasAttribute(key) {
      return this.getAttribute(key) !== null
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
   * 真链路由 tests/unit/speech.test.mjs（WAV 校验 + 真路由）与真浏览器冒烟覆盖；
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
  const micStub = {
    value: { ok: true, available: false, capturing: false, processes: [], reason: 'stub-default' },
    /** 被问了几次（"只在引用浮标亮着时轮询"这条要数它，见 ⑨）。 */
    hits: 0,
  }


  /**
   * 设置桩：离线跑的时候给客户端一份"读得到"的设置。
   * 默认空对象 = 所有设置都用各自的出厂默认（不写值的键，客户端按默认处理；
   * 语音那两个收尾开关的出厂默认是**开**，所以下面「卡片留着」那段要先显式设成 false）。
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
      micStub.hits += 1
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
      // 截图链路的 /api/shot/* 是新增的客户端↔host 握手指令（hello/start/pending/image），
      // 不属于「提问载荷」契约；不排除的话它会顶掉 sent[0]，把后面按 sent[0] 写的断言全带偏。
      if (url.indexOf('/api/shot/') < 0) sent.push(body)
    }
    // 语音输入那一段的"把面板打开、翻译就绪"夹具（比 stage-probe 多一个 done 阶段）
    if (body && body.text === 'voice-probe') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n语音用例的翻译\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 8 })}

  `,
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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}

  `))
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
    // 通用追问桩。注意排除 quote-wait-probe：它有自己的 500ms 慢速夹具（在下面），
    // 放在通配之前会把那个夹具整个遮掉，「流式中不给引用整条」那条用例就永远抓不到流式态。
    if (body && body.question && body.text !== 'quote-wait-probe') {
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
      if (extra.rejectContext) return Promise.resolve(new Response(`data: ${JSON.stringify({ type: 'error', code: 'context-rejected', message: '当前引用超过容量' })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
      // noticeGapMs：在 notice 与正文之间留一段空档。
      // 验"过程提示在正文到达前看得见"必须有观察窗口 —— 一口气发完的话，
      // 提示会在同一批 SSE 里被 delta 立刻撤掉，轮询根本抓不到。
      if (extra.noticeGapMs) {
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`),
            )
            if (extra.notice) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'notice', ...extra.notice })}\n\n`))
            }
            await new Promise((r) => setTimeout(r, extra.noticeGapMs))
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: extra.delta || '这是对追问的回答：' + body.question })}\n\n`),
            )
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 12, toolCalls: 0 })}\n\n`))
            controller.close()
          },
        })
        return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
      }
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`,
        ...(extra.contextState ? [`data: ${JSON.stringify({ type: 'context-state', state: extra.contextState })}\n\n`] : []),
        ...(extra.materialRestored ? [`data: ${JSON.stringify({ type: 'material-restored', attachment: extra.materialRestored })}\n\n`] : []),
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
    if (body && ['中止探测', '停止键专用探测词'].includes(body.text)) {
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

  const floatingLayer = body.children.find((c) => c.className === 'dsh-sel-layer')

  assert('界面挂在 body 自有根，不提升公共槽', !!floatingLayer && floatingLayer.parentNode === body && mount.children.length === 0)

  assert('自有根声明公开的小窗归属', floatingLayer && floatingLayer.getAttribute('data-dsh-floating-owner') === 'explanation')

  assert('重渲染使用稳定挂载 ref', registration.component().props.ref === element.props.ref)


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

  const button = floatingLayer.children.find((c) => c.className === 'dsh-sel-btn')

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
    const quoteBtn = Array.from(walk(floatingLayer)).find((n) => String(n.className).indexOf('dsh-sel-quotebtn') >= 0)
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

  const panel = floatingLayer.children.find((c) => c.className === 'dsh-sel-panel')

  // 面板内的固定引用点（后续断言共用）
  const sections = Array.from(walk(panel)).filter((node) => node.className.indexOf('dsh-sel-sec') >= 0)

  const panelHead = Array.from(walk(panel)).find((node) => node.className === 'dsh-sel-head')

  const histBtn = Array.from(walk(panelHead)).find((n) => n.className.indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('最近') >= 0)

  const histList = floatingLayer.children.find((n) => n.className === 'dsh-sel-history')

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
    const quoteBtnNode = Array.from(walk(floatingLayer)).find((n) => String(n.className).indexOf('dsh-sel-quotebtn') >= 0)
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
  return {
    get HOST_UP() { return HOST_UP },
    get ORIGIN() { return ORIGIN },
    get hook() { return hook },
    get assert() { return assert },
    get sent() { return sent },
    get detailCard() { return detailCard },
    get expandBtn() { return expandBtn },
    get textOf() { return textOf },
    get sections() { return sections },
    get panel() { return panel },
    get walk() { return walk },
    get askRow() { return askRow },
    get sleep() { return sleep },
    get chatLog() { return chatLog },
    get panelHead() { return panelHead },
    get outline() { return outline },
    get selection() { return selection },
    get documentStub() { return documentStub },
    get body() { return body },
    get button() { return button },
    get FakeEl() { return FakeEl },
    get windowStub() { return windowStub },
    get promoted() { return promoted },
    get openedSessions() { return openedSessions },
    get BUNDLE() { return BUNDLE },
    get resizeObservers() { return resizeObservers },
    get histBtn() { return histBtn },
    get histList() { return histList },
    get CODE_SNIPPET() { return CODE_SNIPPET },
    get PY_SNIPPET() { return PY_SNIPPET },
    get PROSE_PROBE() { return PROSE_PROBE },
    get historySaved() { return historySaved },
    get container() { return container },
    get browserFetch() { return browserFetch },
    get blobStore() { return blobStore },
    get textEl() { return textEl },
    get quoteContextCalls() { return quoteContextCalls },
    get navigatorStub() { return navigatorStub },
    get speechTranscribeCalls() { return speechTranscribeCalls },
    get speechTranscript() { return speechTranscript },
    set speechTranscript(value) { speechTranscript = value },
    get speechCatalog() { return speechCatalog },
    set speechCatalog(value) { speechCatalog = value },
    get speechPrepareCalls() { return speechPrepareCalls },
    set speechPrepareCalls(value) { speechPrepareCalls = value },
    get speechTranscriptQueue() { return speechTranscriptQueue },
    set speechTranscriptQueue(value) { speechTranscriptQueue = value },
    get speechTranscriptRepeat() { return speechTranscriptRepeat },
    set speechTranscriptRepeat(value) { speechTranscriptRepeat = value },
    get floatingLayer() { return floatingLayer },
    get micStub() { return micStub },
    get settingsStub() { return settingsStub },
    get disposers() { return disposers },
    get sizeStore() { return sizeStore },
    set sizeStore(value) { sizeStore = value },
    get mount() { return mount },
  }
}
