/**
 * 小窗历史条目里的「这段对话没有解读」（skipped）往返测试。
 *
 * 为什么单独盯它：回放时面板就是靠这个字段决定画不画「翻译」一节 ——
 * 语音卡那条"跳过翻译与详解、直接追问"的对话，回放时若不带这个标记，
 * 就会顶着一张空的「翻译 /（这次没有返回内容）」卡片（用户实测 2026-10-19）。
 *
 * 三件事：① 存得进、读得回；② 普通解读的条目不会被凭空标上；
 * ③ 落盘之后换一个新实例重新加载仍然在，且**老条目**（没有这个键）按 false 读。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../lib/index.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-history-skip-'))
const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const historyFile = join(home, 'selection-explain', 'history.json')
const routes = new Map()
const llm = {
  listProviders: () => [{ id: 'fixture', name: 'Fixture' }],
  listModels: async () => [{ id: 'fixture', name: 'Fixture' }],
  async *stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const makeCtx = () => ({
  llm,
  get: (name) =>
    name === 'llm'
      ? llm
      : name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) }
        : undefined,
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
})
const boot = () => apply(makeCtx(), {})
boot()
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

const api = (query, body, method) =>
  fetch(origin + '/selection-explain/api/history' + (query || ''), {
    method: method || (body ? 'POST' : 'GET'),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }).then((response) => response.json())
const readEntry = async (key) => (await api('?key=' + encodeURIComponent(key))).entry

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
  const skipKey = 'Release\u0000GitHub'
  const normalKey = 'style\u0000上下文片段'
  const legacyKey = 'legacy\u0000旧条目'

  // ① 语音卡那条路（没有解读）的对话
  await api('', {
    key: skipKey,
    text: 'Release',
    context: 'GitHub',
    label: '页面内容',
    parts: { translation: '', detail: '' },
    turns: [
      { role: 'user', text: '中文含义什么？' },
      { role: 'assistant', text: '这里的 Release 是 GitHub 的「发布」功能。' },
    ],
    skipped: true,
  })
  const skipEntry = await readEntry(skipKey)
  check('跳过解读的对话：skipped 存下来并原样读回（回放据此不画翻译节）', () =>
    assert.equal(skipEntry.skipped, true))
  check('同一条目本身照常完整（回放仍然画得出这段对话）', () => {
    assert.equal(skipEntry.parts.translation, '')
    assert.equal(skipEntry.turns.length, 2)
    assert.equal(skipEntry.text, 'Release')
  })

  // ② 普通解读的对话：不能凭空多出这个标记
  await api('', {
    key: normalKey,
    text: 'style',
    context: '上下文片段',
    label: '页面内容',
    parts: { translation: '样式', detail: '' },
    turns: [],
    skipped: false,
  })
  const normalEntry = await readEntry(normalKey)
  check('普通解读的对话：skipped 是 false（翻译节照常画）', () =>
    assert.equal(normalEntry.skipped, false))

  // ③ 落盘（host 侧 800ms 防抖写文件）
  await sleep(1400)
  const file = JSON.parse(await readFile(historyFile, 'utf8'))
  check('history.json 里留下了 skipped（心跳重启也还在）', () =>
    assert.equal(file.entries.find((entry) => entry.key === skipKey).skipped, true))
  check('普通条目在文件里也是 false', () =>
    assert.equal(file.entries.find((entry) => entry.key === normalKey).skipped, false))

  // ④ 老格式条目（没有这个键）→ **原样保留"没有这个键"**，不许改写成 false，翻译内容一个字都不许动
  file.entries.push({
    key: legacyKey,
    text: 'legacy',
    context: '旧条目',
    label: '页面内容',
    at: Date.now(),
    parts: { translation: '旧翻译', detail: '' },
    turns: [],
    toolDigest: '',
    pinned: false,
  })
  await writeFile(historyFile, JSON.stringify(file))

  boot() // 新实例：强制从磁盘重新加载
  const legacy = await readEntry(legacyKey)
  check('老条目没有这个键 → 读回来仍然没有（三态里的"不知道"不许被抹成 false）', () =>
    assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'skipped'), false))
  check('老条目的翻译内容没被动过', () => assert.equal(legacy.parts.translation, '旧翻译'))
  const skipAfterReload = await readEntry(skipKey)
  check('重启后仍然读得出"这段对话没有解读"', () => assert.equal(skipAfterReload.skipped, true))

  // ⑤ 删除 → 撤销（客户端拿着快照原样写回）：标记跟着回来
  const removed = await api('?key=' + encodeURIComponent(skipKey), null, 'DELETE')
  check('（前提）删除返回了含 skipped 的快照', () => assert.equal(removed.entry.skipped, true))
  await api('?restore=1', { entry: removed.entry })
  const restored = await readEntry(skipKey)
  check('撤销删除：跳过解读的标记跟着快照一起回来', () => assert.equal(restored.skipped, true))

  console.log(`\n=== 小窗历史 skipped 往返测试结束：${checks} 通过 / 0 失败 ===`)
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await sleep(300)
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  await rm(home, { recursive: true, force: true })
}
