/**
 * /route 的会话级短缓存。
 *
 * 为什么单测它：跟随状态下**小窗一开着**客户端就每 2 秒问一次 /route，
 * 而 host 侧解析"本会话在用哪个模型"要 readSession —— 那会把整份日志重放成 Session、
 * 再逐条深拷贝一遍（本机实测 1.5MB 会话一次 80~125ms）。不缓存等于每 2 秒重放一次日志。
 *
 * 验的是三条：
 *   ① 事件没涨（live 会话的 seq 不变）→ 不重读，直接回缓存；
 *   ② seq 涨了但离上次重读太近 → 先扛住（防"主会话在连续对话时每拍重放"）；
 *   ③ 用户动作路径（/models、/ping、analyze）不吃缓存 —— 必须是此刻那一份。
 *
 * 用法：node scripts/test-route-cache.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-route-cache-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

/** 会话自己记的模型选择（每次"主会话换模型"都改它 + 让 seq 涨一格）。 */
let selection = { provider: 'p1', model: 'm-fast' }
/** live 会话的事件数（Session.seq = 日志长度，append 一次涨一格）。 */
let liveSeq = 12
/** readSession 被真正调用了几次 —— 缓存命中就该一次都不涨。 */
let reads = 0

const services = {
  llm: { listProviders: () => [{ id: 'p1', models: [{ id: 'm-fast' }] }] },
  agentDefaultModel: { currentSelection: () => ({ provider: 'p9', model: 'm-global' }) },
  sessions: { get: () => ({ header: { cwd: '/fixture' }, seq: liveSeq }) },
  sessionQuery: {
    readSurface: async () => ({ events: [] }),
    readSession: async () => {
      reads += 1
      return {
        events: [
          { type: 'user/message', data: {} },
          { type: 'model/selection', data: { provider: 'p1', model: 'm-old' } },
          { type: 'assistant/message', data: {} },
          { type: 'model/selection', data: selection },
        ],
      }
    },
  },
}

const routes = new Map()
const ctx = {
  llm: services.llm,
  get: (name) => services[name],
  on: () => () => {},
  effect: (fn) => fn(),
  logger: { info() {}, warn() {} },
  webServer: { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
}
apply(ctx, {})

const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
  if (!handler) { res.writeHead(404); res.end(); return }
  Promise.resolve(handler(req, res)).catch((error) => {
    console.error(error)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port

let passed = 0
let failed = 0
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${label}${detail ? ' — ' + detail : ''}`) }
  else { failed += 1; console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}
const route = async () => (await fetch(`${origin}/selection-explain/api/route?sessionId=session-1`)).json()
const models = async () => (await fetch(`${origin}/selection-explain/api/models?sessionId=session-1`)).json()

try {
  // ① 第一次：真读一次
  const first = await route()
  check('第一次 /route 真读会话，拿到本会话的模型',
    first.ok === true && first.model === 'm-fast' && reads === 1,
    `model=${first.model} reads=${reads}`)

  // ① 事件没涨（seq 不变）→ 命中缓存，一次都不重读
  const second = await route()
  const third = await route()
  check('事件没涨时不重读会话日志（seq 没变 → 结论不可能变）',
    second.model === 'm-fast' && third.model === 'm-fast' && reads === 1,
    `reads=${reads}`)

  // ② seq 涨了，但离上次重读太近 → 先扛住（挡住"主会话连续对话时每 2 秒重放一次"）
  selection = { provider: 'p1', model: 'm-strong' }
  liveSeq += 1
  const throttled = await route()
  check('seq 刚涨、距上次重读不足下限时不重读（防重放风暴）',
    throttled.model === 'm-fast' && reads === 1,
    `model=${throttled.model} reads=${reads}`)

  // ② 过了下限 → 重读，跟上新模型
  await new Promise((resolve) => setTimeout(resolve, 3200))
  const caught = await route()
  check('过了最短间隔后重读并跟上新模型',
    caught.model === 'm-strong' && reads === 2,
    `model=${caught.model} reads=${reads}`)

  // ③ 用户动作路径不吃缓存：/models 每次都直读（刚换完模型划词不能按旧模型解析）
  selection = { provider: 'p2', model: 'm-other' }
  liveSeq += 1
  const beforeModels = reads
  await models()
  await models()
  check('/models（用户动作路径）每次都直读，不走缓存',
    reads === beforeModels + 2,
    `reads=${beforeModels} → ${reads}`)

  // ③ 直读顺手把结论种进缓存（seq 对得上）→ 紧接着的轮询不必再读一遍
  const seeded = await route()
  check('直读种进缓存后，轮询不再重复读（seq 对得上就是同一个结论）',
    seeded.model === 'm-other' && reads === beforeModels + 2,
    `model=${seeded.model} reads=${reads}`)
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
}

console.log(`=== /route 缓存测试结束：${passed} 通过 / ${failed} 失败 ===`)
if (failed > 0) process.exitCode = 1
