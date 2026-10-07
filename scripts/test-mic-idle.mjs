/**
 * 麦克风探针的生命周期：划词即启动 → 没人看就停 → 再划词再启动。
 *
 * 为什么单测它：探针是个常驻原生进程（每秒读 4 次 CoreAudio），原来一旦启动就留到插件卸载 ——
 * 而插件装着的绝大多数时间没人划词，等于白跑。现在跟着页面的轮询走：
 * 页面只在"有选区 / 卡片开着"时轮询，探针也就只在那时活着。
 *
 * 验三条：
 *   ① 有人来问才起（之前一直没人问 → 不起）；
 *   ② 一直有人问 → **不会**停（划词期间不能抖）；
 *   ③ 没人问满 MIC_IDLE_MS → 停，且状态回落 available=false（不假装还在听）；
 *   ④ 停了之后再来问 → 能重新起（micStarted 必须复位，否则第二次永远起不来）。
 *
 * 用法：node scripts/test-mic-idle.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'dsh-mic-idle-'))
const logPath = join(dir, 'probe.log')
// ⚠️ 环境变量必须在 **import 之前** 设好：宿主那几个常量是在模块求值时读的，
// 而 ESM 的 import 会被提升到测试体之前 —— 直接 import 的话，这里的赋值就晚了。
process.env.DSH_SEL_FAKE_PROBE_LOG = logPath
process.env.DSH_SEL_MIC_PROBE = fileURLToPath(new URL('./fixtures/fake-mic-probe.sh', import.meta.url))
process.env.DSH_SEL_MIC_IDLE_MS = '150'
process.env.DSH_SEL_MIC_CHECK_MS = '40'
const { apply } = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logText = async () => {
  try {
    return await readFile(logPath, 'utf8')
  } catch {
    return ''
  }
}
const starts = async () => ((await logText()).match(/start/g) || []).length
const stops = async () => ((await logText()).match(/stop/g) || []).length

const routes = new Map()
const disposers = []
const ctx = {
  llm: { listProviders: () => [] },
  get: () => undefined,
  on: () => () => {},
  effect: (fn) => {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  logger: { info() {}, warn() {} },
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

let passed = 0
let failed = 0
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`)
  }
}

try {
  apply(ctx, {})
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (!handler) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const ask = async () => (await fetch(`${origin}/selection-explain/api/mic`)).json()

  // ① 没人问的时候，探针不该存在
  await sleep(120)
  check('没人来问 → 探针不启动', (await starts()) === 0, 'start 次数=' + (await starts()))

  // ② 有人问 → 起
  const first = await ask()
  await sleep(120)
  check(
    '第一次来问 → 探针启动，且状态是 available',
    first.ok === true && first.available === true && (await starts()) === 1,
    `available=${first.available} start=${await starts()}`,
  )

  // ③ 一直有人问 → 不停（划词期间不能抖）
  for (let i = 0; i < 5; i += 1) {
    await ask()
    await sleep(40)
  }
  check('持续有人问 → 探针不重启也不停', (await starts()) === 1 && (await stops()) === 0, `start=${await starts()} stop=${await stops()}`)

  // ④ 没人问满 IDLE → 停
  await sleep(600)
  check('没人问满 MIC_IDLE_MS → 探针停掉', (await stops()) === 1, 'stop 次数=' + (await stops()))

  // ⑤ 再来问 → 能重新起（micStarted 必须被复位，否则第二次永远起不来）
  const again = await ask()
  await sleep(160)
  check(
    '再划词 → 探针重新启动',
    again.available === true && (await starts()) === 2,
    `available=${again.available} start 次数=${await starts()}`,
  )

  server.close()
} finally {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(400)
  const after = await stops()
  check('插件卸载 → 探针被停掉', after >= 1, 'stop 次数=' + after)
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n麦克风探针生命周期：${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
