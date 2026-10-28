/** Run client integration against the real plugin in an isolated settings/history directory. */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { apply } from '../../lib/index.js'
import { CLIENT_SCENARIOS } from '../client/scenario-list.mjs'
import { fileURLToPath } from 'node:url'

// Keep both the host and UI lifecycle independent; earlier scenarios cannot seed later ones.
if (!process.env.SEL_CLIENT_SCENARIO) {
  for (const name of CLIENT_SCENARIOS) {
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        stdio: 'inherit', env: { ...process.env, SEL_CLIENT_SCENARIO: name },
      })
      child.once('error', reject)
      child.once('exit', code => resolve(code ?? 1))
    })
    if (status !== 0) process.exit(status)
  }
  process.exit(0)
}
if (!CLIENT_SCENARIOS.includes(process.env.SEL_CLIENT_SCENARIO)) throw new Error('Unknown client scenario')

const temp = await mkdtemp(join(tmpdir(), 'dsh-settings-test-'))
const previous = process.env.DSH_HOME
process.env.DSH_HOME = temp
const routes = new Map()
const disposers = []
const llm = {
  listProviders: () => [{ id: 'fixture', name: 'Fixture' }],
  listModels: async () => [{ id: 'fixture', name: 'Fixture' }],
  async *stream() {
    yield { type: 'text-delta', text: '这是测试模型的回答：所选文字表达了当前上下文中的意思。\n\n具体含义可结合前后文理解。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const ctx = {
  llm,
  get: name => name === 'llm' ? llm : name === 'agentDefaultModel' ? {currentSelection: () => ({provider: 'fixture', model: 'fixture'})} : undefined,
  on() { return () => {} },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
  logger: {info() {}, warn() {}},
  webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
}
apply(ctx, {})
const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
  if (!handler) { res.writeHead(404); res.end(); return }
  Promise.resolve(handler(req, res)).catch(error => { console.error(error); if (!res.headersSent) res.writeHead(500); res.end() })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const origin = 'http://127.0.0.1:' + server.address().port
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, ['tests/client/run.mjs'], { stdio: 'inherit', env: {...process.env, SEL_ORIGIN: origin} })
    child.on('exit', resolve)
  })
  process.exitCode = result ?? 1
} finally {
  for (const dispose of disposers.reverse()) await dispose()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  // Allow the plugin's debounced writes to complete before removing the fixture.
  await new Promise(resolve => setTimeout(resolve, 1000))
  if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  await rm(temp, {recursive: true, force: true})
}
