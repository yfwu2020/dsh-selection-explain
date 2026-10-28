import { respondAnalyze, PY_SNIPPET, CODE_SNIPPET, PROSE_PROBE } from './analyze.mjs'

/** Host protocol fixtures; each factory owns fresh mutable state. */
export function createApiFixture({ blobStore }) {
  const ORIGIN = process.env.SEL_ORIGIN
  if (!ORIGIN) throw new Error('Run through tests/integration/client.test.mjs to create an isolated host')

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


  /** Let AbortSignal cancel a synthetic SSE response just like browser fetch. */
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
    const fixture = respondAnalyze(body)
    if (fixture) return fixture
    return fetch(typeof input === 'string' && input.startsWith('/') ? ORIGIN + input : input, init)
  }

  const browserFetch = (input, init) => {
    const out = routeFetch(input, init)
    const signal = init && init.signal
    if (!signal || !out || typeof out.then !== 'function') return out
    return out.then((response) => (response && response.body ? withAbort(response, signal) : response))
  }


  return {
    get ORIGIN() { return ORIGIN },
    get browserFetch() { return browserFetch },
    get openedSessions() { return openedSessions },
    get sent() { return sent },
    get promoted() { return promoted },
    get CODE_SNIPPET() { return CODE_SNIPPET },
    get PY_SNIPPET() { return PY_SNIPPET },
    get PROSE_PROBE() { return PROSE_PROBE },
    get historySaved() { return historySaved },
    get quoteContextCalls() { return quoteContextCalls },
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
    get micStub() { return micStub },
    get settingsStub() { return settingsStub },
    get sizeStore() { return sizeStore },
    set sizeStore(value) { sizeStore = value },
  }
}
