/** Run client integration against the real plugin in an isolated settings/history directory. */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { apply } from '../lib/index.js'

const temp = await mkdtemp(join(tmpdir(), 'dsh-settings-test-'))
const previous = process.env.DSH_HOME
process.env.DSH_HOME = temp
const routes = new Map()
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
  on() { return () => {} }, effect(fn) { return fn() }, logger: {info() {}, warn() {}},
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
    const child = spawn(process.execPath, ['scripts/test-client.mjs'], { stdio: 'inherit', env: {...process.env, SEL_ORIGIN: origin, SEL_SETTINGS_ONLY: '1'} })
    child.on('exit', resolve)
  })
  process.exitCode = result ?? 1
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  // Allow the plugin's debounced writes to complete before removing the fixture.
  await new Promise(resolve => setTimeout(resolve, 500))
  if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  await rm(temp, {recursive: true, force: true})
}
