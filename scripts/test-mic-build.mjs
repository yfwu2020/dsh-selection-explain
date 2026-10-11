/**
 * 「就地编译探针」：npm / Release 装下来的包里**没有** `lib/native/mic-probe`
 * —— CI 跑在 ubuntu 上，`build.sh` 里那一步会被跳过（日志原话：
 * "跳过原生探针（非 macOS 或没有 clang）"），所以包里只有 `native/mic-probe.c` 源码。
 *
 * 后果（2026-10-11 用户实测）：从 npm 装到别的 Mac 上，豆包开麦永远不弹卡 ——
 * host 直接报 `probe-missing`。修法是第一次有人问麦克风时**用 clang 现场编一份**，
 * 按源码 hash 缓存进数据目录。
 *
 * 这条用例就复现"装包的机器"：把随包的二进制**暂时挪开**、数据目录指向一个全新的
 * DSH_HOME，然后问一次 /mic —— 应该 available:true，而且编出来的二进制真能跑（--once）。
 *
 * 只在 macOS + 有 clang 时有意义；其它平台 SKIP（与真浏览器冒烟同一套约定：跑不了就跳过）。
 *
 * 用法：node scripts/test-mic-build.mjs
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin' || spawnSync('clang', ['--version']).status !== 0) {
  console.log('SKIP  就地编译探针是 macOS 专用（且需要 clang）—— 本机跳过')
  process.exit(0)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const packaged = join(root, 'lib/native/mic-probe')
const stash = packaged + '.probe-build-test'
const home = await mkdtemp(join(tmpdir(), 'dsh-mic-build-'))
// 数据目录与"注入了假探针"那条路都要避开：前者要全新，后者要显式删除（否则测不到编译）
process.env.DSH_HOME = home
delete process.env.DSH_SEL_MIC_PROBE

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

let moved = false
if (existsSync(packaged)) {
  await rename(packaged, stash)
  moved = true
}

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

try {
  // ⚠️ 必须在"挪开二进制"之后才 import：探针路径是在模块求值时算的
  const { apply } = await import('../lib/index.js')
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
  const dataDir = join(home, 'selection-explain')

  check('（前提）装包的样子：随包的二进制不在，只剩源码', !existsSync(packaged) && existsSync(join(root, 'native/mic-probe.c')), '')

  const payload = await (await fetch(`${origin}/selection-explain/api/mic`)).json()
  check(
    '装包的机器上第一次问麦克风 → 就地编出来，状态是 available（不再 probe-missing）',
    payload.ok === true && payload.available === true && payload.reason === '',
    JSON.stringify({ available: payload.available, reason: payload.reason }),
  )

  const files = existsSync(dataDir) ? await readdir(dataDir) : []
  const compiled = files.filter((f) => /^mic-probe-[0-9a-f]{8}$/.test(f))
  check(
    '编出来的探针按源码 hash 缓存进数据目录（源码改了会自然重建）',
    compiled.length === 1,
    JSON.stringify(files),
  )

  if (compiled.length === 1) {
    const run = spawnSync(join(dataDir, compiled[0]), ['--once'], { encoding: 'utf8', timeout: 20_000 })
    let parsed = null
    try {
      parsed = JSON.parse(String(run.stdout || '').trim().split('\n').pop() || 'null')
    } catch {
      /* 保持 null */
    }
    check(
      '编出来的二进制真能跑（--once 输出一行合法 JSON）',
      run.status === 0 && !!parsed && typeof parsed.capturing === 'boolean',
      JSON.stringify({ status: run.status, stdout: String(run.stdout || '').trim().slice(0, 80) }),
    )
  } else {
    check('编出来的二进制真能跑（--once 输出一行合法 JSON）', false, '没有找到编出来的探针')
  }

  server.close()
} finally {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(300)
  if (moved) await rename(stash, packaged)
  await rm(home, { recursive: true, force: true })
}

console.log(`\n探针就地编译：${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
