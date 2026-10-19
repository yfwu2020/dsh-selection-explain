/** 语音卡 / 开麦引用 的**宿主侧前提**：探针得真的起得来、报得出 available。 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../lib/index.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-mic-probe-'))
const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const routes = new Map()
const llm = {
  listProviders: () => [],
  listModels: async () => [],
  async *stream() {},
}
const ctx = {
  llm,
  get: (name) => (name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({}) } : undefined),
  on() {
    return () => {}
  },
  effect: (fn) => fn(),
  logger: { info() {}, warn() {} },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}
apply(ctx, {})
const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
  if (!handler) {
    res.writeHead(404)
    res.end()
    return
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    console.error(error)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let checks = 0
function check(label, fn) {
  try {
    fn()
    checks += 1
    console.log('PASS ' + label)
  } catch (error) {
    console.error('FAIL ' + label)
    throw error
  }
}

try {
  const ping = await fetch(origin + '/selection-explain/api/mic').then((r) => r.json())
  // 探针是**懒启动**的：第一次来问才 spawn，状态要等它吐第一行（~80ms 冷启动）
  let status = ping
  for (let i = 0; i < 60 && !(status && status.available === true); i += 1) {
    await sleep(100)
    status = await fetch(origin + '/selection-explain/api/mic').then((r) => r.json())
  }

  // 探针是 macOS 专属（读 CoreAudio）。Linux CI 上它按设计就是不启用
  // （reason: 'not-macos'）—— 那不是缺陷，跳过而不是判失败。
  if (process.platform !== 'darwin') {
    check('非 macOS：探针按设计不启用，并如实说明原因（not-macos）', () => {
      assert.equal(status.available, false)
      assert.equal(status.reason, 'not-macos')
    })
    console.log(`\n=== 麦克风探针可用性：${checks} 通过 / 0 失败（非 macOS，跳过可用性断言）===`)
  } else {
    check('宿主侧麦克风探针可用（语音卡与「开麦即引用」的前提）', () =>
      assert.equal(status.available, true, JSON.stringify(status)))
    check('探针报得出完整状态（capturing / processes）', () => {
      assert.equal(typeof status.capturing, 'boolean')
      assert.ok(Array.isArray(status.processes))
    })
    console.log(`\n=== 麦克风探针可用性：${checks} 通过 / 0 失败 ===`)
  }
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await sleep(300)
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  await rm(home, { recursive: true, force: true })
}
