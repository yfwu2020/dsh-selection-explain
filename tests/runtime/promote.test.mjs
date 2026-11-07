/** Real DSH v4 factory/persistence regression; pass the runtime's node_modules directory. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { createPromote } from '../../lib/host/promote.js'
import { resolveConfig } from '../../lib/host/config.js'

if (!process.argv[2]) throw new Error('Pass the DSH runtime node_modules directory')
const runtime = createRequire(join(resolve(process.argv[2]), 'package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { SessionStore } = await load('dsh-session')
const { AgentRegistry } = await load('dsh-agent')
const { default: Projections } = await load('dsh-session-projection')
const { default: SystemPrompt } = await load('dsh-system-prompt')
const { default: AgentLoop } = await load('dsh-agent-loop')
const { default: Persistence } = await load('dsh-session-persistence-jsonl')
const root = await mkdtemp(join(tmpdir(), 'dsh-promote-runtime-'))

async function boot() {
  const ctx = new Context()
  const fibers = []
  ctx.provide('llm', {})
  ctx.provide('tools', {})
  for (const [plugin, config] of [
    [SessionStore], [AgentRegistry], [Projections], [SystemPrompt],
    [Persistence, { root, compression: 'zstd' }], [AgentLoop, { agents: [], maxParallelToolCalls: 1 }],
  ]) fibers.push(await ctx.plugin(plugin, config))
  // Let the real driver allocate/close a turn, stopping before any model request.
  ctx.on('agent/pre-step', () => ({ kind: 'reject' }), { global: true })
  ctx.provide('sessionController', {
    agents: { composeAgent: async () => ({ setup() {} }) },
    create() { throw new Error('Promotion must create with seed') },
    prompt() { throw new Error('History promotion must not call a model') },
  })
  return { ctx, async close() { for (const fiber of fibers.splice(0).reverse()) await fiber.dispose() } }
}

let app
function turnsOf(agent) { return agent.session.snapshotEvents().filter(e => e.type === 'turn/start').map(e => e.data.turn) }
function question(id) { return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } }

try {
  app = await boot()
  const { handlePromote } = createPromote(app.ctx, resolveConfig({}), {
    resolveSessionCwd: async () => root,
  }, { clampText: (value, max) => typeof value === 'string' ? value.slice(0, max) : '' })
  const server = createServer(handlePromote)
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  let sessionId
  let hotSessionId
  try {
    for (const hotFollowup of [false, true]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
        method: 'POST', body: JSON.stringify({
          text: 'selected text', translation: '翻译', detail: '解读',
          turns: [{ role: 'user', text: '追问' }, { role: 'assistant', text: '回答' }],
        }),
      })
      const result = await response.json()
      assert.equal(response.status, 200, result.error)
      assert.equal(result.mode, 'history')
      const agent = app.ctx.agents.get(result.sessionId)
      assert.deepEqual(turnsOf(agent), [1, 2])
      if (hotFollowup) {
        hotSessionId = result.sessionId
        agent.followup(question('before-restart'))
        await agent.whenIdle()
        assert.deepEqual(turnsOf(agent), [1, 2, 3], 'The original agent must continue past the seed')
      } else sessionId = result.sessionId
    }
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
  await app.close()

  // Fresh backend and agent registry: parse the real on-disk v4 log, then resume.
  app = await boot()
  let handle = await app.ctx.agents.resume({ resumeSessionId: sessionId })
  assert.deepEqual(turnsOf(handle.agent), [1, 2])
  const hotHandle = await app.ctx.agents.resume({ resumeSessionId: hotSessionId })
  assert.deepEqual(turnsOf(hotHandle.agent), [1, 2, 3])
  handle.agent.followup(question('follow-up'))
  await handle.agent.whenIdle()
  assert.deepEqual(turnsOf(handle.agent), [1, 2, 3])
  await app.close()

  app = await boot()
  handle = await app.ctx.agents.resume({ resumeSessionId: sessionId })
  handle.agent.followup(question('after-restart'))
  await handle.agent.whenIdle()
  assert.deepEqual(turnsOf(handle.agent), [1, 2, 3, 4])
  await app.close()
  console.log('PASS real DSH runtime: seeded promotion, v4 disk reload, follow-up, second reload and turn continuation')
} finally {
  await app?.close()
  await rm(root, { recursive: true, force: true })
}
