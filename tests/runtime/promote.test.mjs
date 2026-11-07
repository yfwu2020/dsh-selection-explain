/** Real DSH v4 factory/persistence regression; pass the runtime's node_modules directory. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtemp, rm, cp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'

if (!process.argv[2]) throw new Error('Pass the DSH runtime node_modules directory')
const runtimeModules = resolve(process.argv[2])
const runtime = createRequire(join(runtimeModules, 'package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { SessionStore } = await load('dsh-session')
const { AgentRegistry } = await load('dsh-agent')
const { default: Projections } = await load('dsh-session-projection')
const { default: SystemPrompt } = await load('dsh-system-prompt')
const { default: AgentLoop } = await load('dsh-agent-loop')
const { default: Persistence } = await load('dsh-session-persistence-jsonl')
const { LlmError } = await load('dsh-llm')
const model = { provider: 'fixture', model: 'fixture' }
const root = await mkdtemp(join(tmpdir(), 'dsh-promote-runtime-'))

// Load the built plugin against the SAME dependencies as this host. Resolving
// from the checkout would mix the locked v3 LLM factory with a v4 Session.
const pluginRoot = join(root, 'plugin')
await mkdir(pluginRoot)
await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ type: 'module' }))
await cp(new URL('../../lib', import.meta.url), join(pluginRoot, 'lib'), { recursive: true })
await symlink(runtimeModules, join(pluginRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
const { createPromote } = await import(pathToFileURL(join(pluginRoot, 'lib/host/promote.js')).href)
const { resolveConfig } = await import(pathToFileURL(join(pluginRoot, 'lib/host/config.js')).href)

async function boot(prompt = 'First fixture system prompt') {
  const ctx = new Context()
  const fibers = []
  const requests = []
  ctx.provide('llm', {
    async prepareCall() { throw new LlmError('Offline fixture', 'NO_ADAPTER') },
    async *stream(request) {
      requests.push(request)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Fixture answer' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture answer' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  ctx.provide('agentDefaultModel', { currentSelection: () => model })
  ctx.provide('tools', {})
  for (const [plugin, config] of [
    [SessionStore], [AgentRegistry], [Projections], [SystemPrompt],
    [Persistence, { root, compression: 'zstd' }], [AgentLoop, { agents: [], maxParallelToolCalls: 1 }],
  ]) fibers.push(await ctx.plugin(plugin, config))
  // Run the actual step, including prompt reconciliation and durable assistant
  // settlement. Only the external model adapter is replaced by an offline stream.
  ctx.systemPrompt.section({ name: 'fixture-prompt', order: 0, text: prompt, complete: true })
  ctx.provide('sessionController', {
    agents: { composeAgent: async () => ({ setup() {} }) },
    create() { throw new Error('Promotion must create with seed') },
    prompt() { throw new Error('History promotion must not call a model') },
  })
  return { ctx, requests, prompt, async close() { for (const fiber of fibers.splice(0).reverse()) await fiber.dispose() } }
}

let app
function turnsOf(agent) { return agent.session.snapshotEvents().filter(e => e.type === 'turn/start').map(e => e.data.turn) }
function question(id) { return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } }

async function answer(app, agent, id) {
  const before = app.requests.length
  agent.followup(question(id))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const ended = events.filter(e => e.type === 'turn/end').at(-1)
  assert.equal(ended.data.reason.kind, 'completed', JSON.stringify(ended.data.reason))
  assert.equal(app.requests.length, before + 1, 'The follow-up must reach the model fixture')
  const request = app.requests.at(-1)
  const system = request.messages.filter(message => message.role === 'system')
  assert.equal(system.length, app.prompt ? 1 : 0)
  if (app.prompt) assert.equal(system[0].content.map(block => block.text || '').join(''), app.prompt)
  const head = agent.session.eventAt(agent.session.surface.nodes[0])
  assert.equal(head.type, 'system/message', 'Prompt updates must retain the protected first surface node')
  assert.equal(head.data.message.source.kind, 'system-prompt')
  assert.equal(head.data.message.content.map(block => block.text || '').join(''), app.prompt)
  assert.ok(request.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('selected text'))), 'Imported history must survive prompt replacement')
  const answer = events.filter(e => e.type === 'assistant/message').at(-1)
  assert.equal(answer.data.message.content[0].text, 'Fixture answer')
}

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
        await answer(app, agent, 'before-restart')
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
  let handle = await app.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: model })
  assert.deepEqual(turnsOf(handle.agent), [1, 2])
  const hotHandle = await app.ctx.agents.resume({ resumeSessionId: hotSessionId, agentOptions: model })
  assert.deepEqual(turnsOf(hotHandle.agent), [1, 2, 3])
  await answer(app, handle.agent, 'follow-up')
  assert.deepEqual(turnsOf(handle.agent), [1, 2, 3])
  await app.close()

  app = await boot('Changed fixture system prompt')
  handle = await app.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: model })
  await answer(app, handle.agent, 'after-restart')
  assert.deepEqual(turnsOf(handle.agent), [1, 2, 3, 4])
  await app.close()

  // Verify the final completed reply and its prompt replacement are readable too.
  app = await boot('')
  handle = await app.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: model })
  assert.deepEqual(turnsOf(handle.agent), [1, 2, 3, 4])
  await answer(app, handle.agent, 'empty-prompt')
  assert.deepEqual(turnsOf(handle.agent), [1, 2, 3, 4, 5])
  await app.close()
  app = await boot()
  handle = await app.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: model })
  assert.deepEqual(turnsOf(handle.agent), [1, 2, 3, 4, 5])
  await app.close()
  console.log('PASS real DSH runtime: seeded promotion, v4 disk reload, follow-up, second reload and turn continuation')
} finally {
  await app?.close()
  await rm(root, { recursive: true, force: true })
}
