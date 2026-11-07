/**
 * 「升格」离线契约：建会话 → 挂 workspace → 写真实多轮历史（或回退打包一条 prompt）。
 *
 * 这条测试盯的是**私有服务契约**：promote 用 `ctx.get('sessionController')` /
 * `workspaceRegistry` / `sessions` 这些宽松 cast 的接口，DSH 升级后形状变了它不会编译报错，
 * 只会在真实点击时 503 / 静默失败。所以这里用假宿主把两端钉住：
 *   · create 收到的是 workspaceId 或 cwd（二选一，不能同时传）；
 *   · history 在 agent 创建时作为 seed 载入，且通过宿主关系校验；
 *   · 缺少 seed/composition 能力时退回打包 prompt，且带 AbortSignal；
 *   · 缺 text → 400、非 POST → 405、没有 sessionController → 503。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply } from '../../lib/index.js'
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { apply as installSessionInvariant } from '@deepseek-ai/dsh-session/invariant'

const PLUGIN_SOURCE_KIND = 'plugin:@yfwu2020/dsh-selection-explain'
const PROMOTE_PATH = '/selection-explain/api/promote'

/** 一套可复用的假宿主状态：记录所有对外调用，并允许按用例切换行为。 */
function makeState() {
  const state = {
    routes: new Map(),
    disposers: [],
    creates: [],
    seededCreates: [],
    hasSeededCreate: true,
    failSeededCreate: false,
    renames: [],
    prompts: [],
    attached: [],
    live: new Map(),
    nextIds: ['new-1'],
    workspace: null,
    hasController: true,
    failCreate: false,
  }
  const composition = { agentPreset: 'fixture-preset', setup() {} }
  const controller = {
    async composeAgent(preset) {
      assert.equal(preset, undefined)
      return composition
    },
    async create(request) {
      state.creates.push(request)
      if (state.failCreate) return {}
      return { sessionId: state.nextIds.shift() || `new-${state.creates.length}` }
    },
    async rename(request) {
      state.renames.push(request)
    },
    async prompt(request, signal) {
      state.prompts.push({ request, signal })
      assert.ok(signal && typeof signal.aborted === 'boolean', 'prompt 必须收到 AbortSignal')
    },
  }
  const workspace = {
    resolveByPath: async (path) => (state.workspace && state.workspace.path === path ? state.workspace : undefined),
    get: (id) => (state.workspace && state.workspace.id === id ? state.workspace : undefined),
  }
  const llm = { listProviders: () => [], listModels: async () => [], resolveModel: async () => ({}) }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') {
        state.disposers.push(dispose)
        return dispose
      }
      return () => {}
    },
    on() {
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
    llm,
    webServer: {
      register(route) {
        state.routes.set(route.path, route.handler)
        return () => state.routes.delete(route.path)
      },
    },
    get(name) {
      if (name === 'agents') return state.hasSeededCreate ? {
        async create(options) {
          state.seededCreates.push(options)
          if (state.failSeededCreate) throw new Error('seed creation failed')
          const session = Session.create(options.sessionId, options.seed, {
            id: options.sessionId, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), ...options.meta,
          }, options.inheritedEventCount)
          await validateReplay(session)
          state.live.set(options.sessionId, session)
          return { agent: { id: options.sessionId, session }, async dispose() {} }
        },
      } : undefined
      if (name === 'sessionController') return state.hasController ? controller : undefined
      if (name === 'sessions') return { get: (id) => state.live.get(id) }
      if (name === 'sessionQuery') return { readSession: async () => undefined, readSurface: async () => ({ events: [] }) }
      if (name === 'workspaceRegistry') return workspace
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) }
      if (name === 'llm') return llm
      return undefined
    },
  }
  state.ctx = ctx
  state.controller = controller
  state.composition = composition
  return state
}

async function boot(state) {
  apply(state.ctx, {})
  const server = createServer((req, res) => {
    const handler = state.routes.get(new URL(req.url, 'http://x').pathname)
    if (!handler) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String((error && error.message) || error) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const dispose of state.disposers.splice(0).reverse()) await dispose()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function post(origin, body) {
  const response = await fetch(origin + PROMOTE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

// Use the host's relational validator, so an invalid turn sequence cannot pass
// merely because the HTTP fixture recorded the expected event names.
async function validateReplay(session) {
  await installSessionInvariant({ invariants: {
    register(_name, install) {
      install({ sessions: { list: () => [session] }, on() {} }, message => { throw new Error(message) })
    },
  } })
}

const liveSession = (state, id, cwd) => {
  const events = []
  state.live.set(id, {
    header: cwd ? { cwd } : undefined,
    seq: 1,
    append(type, data, options) {
      events.push({ type, data, options })
    },
  })
  return events
}

// ───────────────── ① history 模式：建会话、挂 workspace、写真实多轮历史 ─────────────────
{
  const state = makeState()
  state.workspace = { id: 'ws-1', path: '/tmp/project', sessionIds: [], attachSession: async (id) => state.attached.push(id) }
  state.live.set('src-1', { header: { cwd: '/tmp/project' }, seq: 7 })
  const oldEvents = liveSession(state, 'new-1', '/tmp/project')
  const app = await boot(state)
  try {
    const result = await post(app.origin, {
      text: 'the migration ran long',
      sessionId: 'src-1',
      label: '对话消息（助手）',
      context: 'PM: 这周能发布吗？ Dev: the migration ran long, so we ship Wednesday.',
      translation: '迁移跑得久，所以我们周三发布。',
      detail: '指迁移耗时超出预期，需要留回滚窗口。',
      turns: [
        { role: 'user', text: '为什么是周三？' },
        { role: 'assistant', text: '因为迁移超时，需要留出回滚窗口。' },
      ],
    })
    assert.equal(result.status, 200, result.body.error)
    assert.deepEqual(state.creates, [], '历史必须随 agent 创建传入，不能先建空会话再 append')
    const newId = result.body.sessionId
    assert.match(newId, /^session-[0-9a-f-]{36}$/)
    assert.deepEqual(result.body, {
      ok: true,
      sessionId: newId,
      cwd: '/tmp/project',
      workspaceId: 'ws-1',
      mode: 'history',
    })
    assert.deepEqual(oldEvents, [], '不得事后向已有 live 会话写历史')
    assert.equal(state.seededCreates.length, 1)
    const options = state.seededCreates[0]
    assert.deepEqual(options.meta, { cwd: '/tmp/project', isSeeded: true, agentPreset: 'fixture-preset' })
    assert.deepEqual(options.agentOptions, { provider: 'fixture', model: 'fixture' })
    assert.equal(options.setup, state.composition.setup)
    assert.equal(options.inheritedEventCount, options.seed.length)
    assert.deepEqual(options.seed.map(e => e.seq), Array.from({ length: options.seed.length }, (_, i) => i))
    const events = options.seed.map(({ surfaceOp, ...event }) => ({ ...event, options: surfaceOp ? { surfaceOp } : undefined }))
    const session = state.live.get(newId)
    assert.equal(session.eventAt(options.seed.length).type, 'session/end-seed')
    // Cold reconstruction before any follow-up and after a new completed turn.
    await validateReplay(Session.fromRestore(newId, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header, session.inheritedEventCount, 'detached'))
    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
    session.append('user/message', { id: 'follow-up', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续讨论' }] }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 3, step: 1 })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await validateReplay(Session.fromRestore(newId, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header, session.inheritedEventCount, 'detached'))
    assert.equal(state.renames.length, 1)
    assert.equal(state.renames[0].sessionId, newId)
    assert.match(state.renames[0].title, /^划词解读：the migration ran long/)
    assert.deepEqual(state.attached, [newId], '新会话要显式挂到 workspace')
    assert.equal(state.prompts.length, 0, 'history 模式不再发开场 prompt')

    assert.deepEqual(
      events.map((event) => event.type),
      [
        'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
        'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
      ],
      '两轮都必须带 turn/step 骨架（否则客户端不显示成历史对话）',
    )
    const contextUser = events[2]
    assert.equal(contextUser.data.source.kind, PLUGIN_SOURCE_KIND, '上下文消息要用插件自有 source kind')
    assert.match(contextUser.data.content[0].text, /选中文字：the migration ran long/)
    assert.match(contextUser.data.content[0].text, /所在位置：对话消息（助手）/)
    const contextAssistant = events[3]
    assert.match(contextAssistant.data.message.content[0].text, /翻译/)
    assert.match(contextAssistant.data.message.content[0].text, /详解/)

    const question = events[8]
    assert.equal(question.data.source.kind, 'user')
    assert.equal(question.data.content[0].text, '为什么是周三？')
    const answer = events[9]
    assert.equal(answer.data.message.content[0].text, '因为迁移超时，需要留出回滚窗口。')
    assert.ok(
      events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message').every((event) => event.options && event.options.surfaceOp === 'append'),
      '消息事件都要 surfaceOp=append（骨架事件不需要）',
    )
  } finally {
    await app.close()
  }
}

// ───────────────── ② 没有 seeded agent 创建能力 → 回退成一条打包 prompt ─────────────────
{
  const state = makeState()
  state.hasSeededCreate = false
  state.live.set('src-2', { header: { cwd: '/tmp/project' }, seq: 1 })
  const app = await boot(state)
  try {
    const result = await post(app.origin, { text: 'hello world', sessionId: 'src-2' })
    assert.equal(result.status, 200, result.body.error)
    assert.equal(result.body.mode, 'packed')
    assert.equal(result.body.workspaceId, null)
    assert.equal(result.body.cwd, '/tmp/project')
    assert.deepEqual(state.creates, [{ cwd: '/tmp/project' }], '没有 workspace 时只传 cwd')
    assert.equal(state.prompts.length, 1)
    const { request, signal } = state.prompts[0]
    assert.match(request.requestId, /^sel-promote-/)
    assert.equal(request.sessionId, 'new-1')
    assert.equal(request.mode, 'queue')
    assert.equal(signal.aborted, false)
    assert.match(request.content[0].text, /■ 选中文字\nhello world/)
    assert.match(request.content[0].text, /以上是背景/)
  } finally {
    await app.close()
  }
}

// ───────────────── ③ 参数与部署校验：400 / 405 / 503 ─────────────────
{
  const state = makeState()
  const app = await boot(state)
  try {
    const missing = await post(app.origin, { text: '   ' })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /缺少 text/)

    const notPost = await fetch(app.origin + PROMOTE_PATH)
    assert.equal(notPost.status, 405)
    assert.equal((await notPost.json()).error, '只支持 POST')
  } finally {
    await app.close()
  }
}

{
  const state = makeState()
  state.hasController = false
  const app = await boot(state)
  try {
    const result = await post(app.origin, { text: 'x' })
    assert.equal(result.status, 503)
    assert.match(result.body.error, /sessionController/)
  } finally {
    await app.close()
  }
}

// ───────────────── ④ 建会话失败（拿不到 sessionId）→ 500，不继续写历史 ─────────────────
{
  const state = makeState()
  state.hasSeededCreate = false
  state.failCreate = true
  const app = await boot(state)
  try {
    const result = await post(app.origin, { text: 'x' })
    assert.equal(result.status, 500)
    assert.match(result.body.error, /创建会话失败/)
    assert.equal(state.prompts.length, 0)
  } finally {
    await app.close()
  }
}

// Failed seeded construction must never retry through a potentially corrupt live append.
{
  const state = makeState()
  state.live.set('failure-source', { header: { cwd: '/tmp/project' } })
  state.failSeededCreate = true
  const app = await boot(state)
  try {
    const result = await post(app.origin, { text: 'x', sessionId: 'failure-source' })
    assert.equal(result.status, 500)
    assert.match(result.body.error, /seed creation failed/)
    assert.equal(state.creates.length, 0)
    assert.equal(state.prompts.length, 0)
  } finally { await app.close() }
}

// Newer hosts keep the composer on the controller's internal agent helper.
{
  const state = makeState()
  state.live.set('nested-source', { header: { cwd: '/tmp/nested-project' } })
  state.controller.agents = { composeAgent: state.controller.composeAgent }
  delete state.controller.composeAgent
  const app = await boot(state)
  try {
    const result = await post(app.origin, { text: 'nested composer', sessionId: 'nested-source' })
    assert.equal(result.status, 200, result.body.error)
    assert.equal(result.body.mode, 'history')
    assert.equal(state.seededCreates[0].setup, state.composition.setup)
    assert.equal(state.seededCreates[0].meta.cwd, '/tmp/nested-project')
  } finally { await app.close() }
}

// Missing composition must use the host's normal creation, even with live access.
{
  const state = makeState()
  delete state.controller.composeAgent
  const events = liveSession(state, 'new-1')
  const app = await boot(state)
  try {
    const result = await post(app.origin, { text: 'legacy host' })
    assert.equal(result.status, 200, result.body.error)
    assert.equal(result.body.mode, 'packed')
    assert.deepEqual(state.creates, [{}])
    assert.deepEqual(events, [])
    assert.equal(state.seededCreates.length, 0)
    assert.equal(state.prompts.length, 1)
  } finally { await app.close() }
}

// Without a source cwd, only normal creation knows the host's default workspace.
{
  const state = makeState()
  const app = await boot(state)
  try {
    const result = await post(app.origin, { text: 'no bound source session' })
    assert.equal(result.status, 200, result.body.error)
    assert.equal(result.body.mode, 'packed', '不得创建没有 cwd、侧栏不可见且无法恢复的 seed 会话')
    assert.deepEqual(state.creates, [{}])
    assert.equal(state.seededCreates.length, 0)
    assert.equal(state.prompts.length, 1)
  } finally { await app.close() }
}

console.log('PASS promote: history seeding, workspace attach, packed fallback, 400/405/503, create failure')
