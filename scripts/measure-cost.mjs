/**
 * 「在小窗里问简单问题，比在主会话里问省吗？」—— 一次算完。
 *
 * 两边分别怎么量：
 *   · **小窗这一侧**：真发一次请求，拿 SSE `done` 事件里的 `usage`（真实计费口径）；
 *     跑 chat 追问两遍（冷 / 热缓存）与「不带会话背景」对照，隔离固定开销与背景开销。
 *   · **主会话这一侧**：不猜 —— 读 ~/.dsh/storages/dsh-spend-scan-cache.json，
 *     那是每个会话每一步的真实 inputTokens / cacheReadTokens / outputTokens：
 *     首步 input = 固定前缀（系统提示词 + 全部工具 schema + 运行时快照），
 *     按轮次聚合就能得到「一次一问一答」的真实开销分布。
 *
 * 折算口径（"等效未缓存输入 token"，所有 token 归一到 miss 单价）：
 *   cost = miss + cacheRead × 0.1 + output × 1.5
 *   0.1 = 主流缓存命中价（DeepSeek 系 miss:hit = 10:1）；1.5 = 输出单价 / 输入 miss 单价。
 *   价格表换了就改这两个常数；结论对这俩数不敏感的方向会在输出里标注。
 *
 * 用法：
 *   node scripts/measure-cost.mjs                 # 用小窗历史里最近一次会话当背景
 *   node scripts/measure-cost.mjs <sessionId>     # 指定主会话 id（拿它的对话当小窗背景）
 *   SEL_ORIGIN=http://127.0.0.1:3080 node scripts/measure-cost.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = process.env.SEL_ORIGIN || 'http://127.0.0.1:3080'
const SPEND_CACHE = join(homedir(), '.dsh', 'storages', 'dsh-spend-scan-cache.json')
const CACHE_READ_RATIO = 0.1
const OUTPUT_RATIO = 1.5

const sessionId = process.argv[2] || ''
/** 折算：把 (miss, cacheRead, output) 归一到「等效未缓存输入 token」。 */
const cost = (miss, cacheRead, out) => miss + cacheRead * CACHE_READ_RATIO + out * OUTPUT_RATIO
const fmt = (n) => Math.round(n).toLocaleString('en-US')
/** 分位数（p 取 0~1）；中位数就是 p=0.5。 */
const pct = (list, p) => {
  if (list.length === 0) return 0
  const sorted = [...list].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[at]
}
const med = (list) => pct(list, 0.5)

/* ───────────────────────── 主会话：真实用量统计 ───────────────────────── */

function mainSessionStats() {
  let cache
  try {
    cache = JSON.parse(readFileSync(SPEND_CACHE, 'utf8'))
  } catch (error) {
    return { error: `读不到用量缓存（${SPEND_CACHE}）：${String(error?.message ?? error)}` }
  }
  const prefixes = []
  const turns = new Map()
  for (const [key, value] of Object.entries(cache)) {
    const samples = value?.samples ?? []
    if (samples.length === 0) continue
    const first = samples.reduce((a, b) => ((a?.turn ?? 0) <= (b?.turn ?? 0) ? a : b))
    if (first?.inputTokens) prefixes.push(first.inputTokens)
    for (const sample of samples) {
      const id = `${key}#${sample.turn}`
      const turn = turns.get(id) ?? { steps: 0, miss: 0, cacheRead: 0, out: 0 }
      turn.steps += 1
      turn.miss += sample.inputTokens ?? 0
      turn.cacheRead += sample.cacheReadTokens ?? 0
      turn.out += sample.outputTokens ?? 0
      turns.set(id, turn)
    }
  }
  const all = [...turns.values()]
  const bucket = (max) => all.filter((t) => t.steps <= max)
  const summarize = (list) => ({
    n: list.length,
    steps: med(list.map((t) => t.steps)),
    miss: med(list.map((t) => t.miss)),
    cacheRead: med(list.map((t) => t.cacheRead)),
    out: med(list.map((t) => t.out)),
    costP25: pct(list.map((t) => cost(t.miss, t.cacheRead, t.out)), 0.25),
    cost: med(list.map((t) => cost(t.miss, t.cacheRead, t.out))),
  })
  return {
    sessions: prefixes.length,
    turns: all.length,
    prefix: med(prefixes),
    prefixP25: med([...prefixes].sort((a, b) => a - b).slice(0, Math.max(1, prefixes.length >> 2))),
    one: summarize(bucket(1)),
    two: summarize(bucket(2)),
    six: summarize(bucket(6)),
    all: summarize(all),
  }
}

/* ───────────────────────── 小窗：实测一次请求 ───────────────────────── */

const CONTEXT =
  'PM：这周能发布吗？\nDev：【the migration ran long】，得顺延到周三。\nPM：那就周三，先冻结功能。\n' +
  'Dev：迁移脚本在预发环境跑了 47 分钟，主要是 users 表的索引重建。\n'.repeat(6)

const HISTORY = [
  { role: 'user', text: 'the migration ran long' },
  {
    role: 'assistant',
    text: '## 翻译\n- **migration** /maɪˈɡreɪʃn/\n  - **n.** 迁移；移居\n- **ran long**：跑得久了。\n\n> 在本句中：迁移脚本耗时超出预期。',
  },
]

/** 发一次小窗请求，只取 start 元信息与 done 的 usage。 */
async function ask(payload, withSession) {
  const response = await fetch(`${ORIGIN}/selection-explain/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'the migration ran long',
      context: CONTEXT,
      label: '对话消息',
      debug: true,
      ...(withSession && sessionId ? { sessionId } : {}),
      ...payload,
    }),
  })
  if (!response.ok) return { error: `HTTP ${response.status} ${(await response.text().catch(() => '')).slice(0, 120)}` }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let start = null
  let done = null
  const startedAt = Date.now()
  let firstDelta = null
  for (;;) {
    const { done: eof, value } = await reader.read()
    if (eof) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const line = block.trim()
      if (!line.startsWith('data:')) continue
      let message
      try {
        message = JSON.parse(line.slice(5).trim())
      } catch {
        continue
      }
      if (message.type === 'start') start = message
      else if (message.type === 'delta' && firstDelta === null) firstDelta = Date.now() - startedAt
      else if (message.type === 'done') done = message
    }
  }
  return { start, done, ms: Date.now() - startedAt, firstDelta }
}

const QUESTION = { question: '这句里 run long 是什么用法？', history: HISTORY }

async function smallWindowStats() {
  const rows = []
  const cold = await ask(QUESTION, true)
  if (cold.error) return { error: cold.error }
  const warm = await ask(QUESTION, true)
  const bare = await ask(QUESTION, false)
  for (const [label, run] of [
    ['第 1 跑', cold],
    ['再跑一次（前缀命中缓存）', warm],
    ['不带会话背景', bare],
  ]) {
    const usage = run.done?.usage ?? {}
    const miss = usage.inputTokens ?? 0
    const cacheRead = usage.cacheReadTokens ?? 0
    const out = usage.outputTokens ?? 0
    rows.push({
      label,
      prompt: miss + cacheRead,
      miss,
      cacheRead,
      out,
      cost: cost(miss, cacheRead, out),
      rounds: run.done?.rounds?.length ?? 1,
      toolCalls: run.done?.toolCalls ?? 0,
      system: run.start?.debug?.sizes?.system ?? 0,
      user: run.start?.debug?.sizes?.user ?? 0,
      background: run.start?.context?.session?.chars ?? 0,
      backgroundMessages: run.start?.backgroundMessages ?? 0,
      tools: run.start?.tools ?? [],
      ms: run.ms,
      firstDelta: run.firstDelta,
    })
  }
  return { rows, model: cold.start?.model, effort: cold.start?.effort }
}

/* ───────────────────────────── 输出对照 ───────────────────────────── */

const main = mainSessionStats()
const small = await smallWindowStats()

console.log('='.repeat(78))
console.log('主会话（真实用量：%d 个会话 / %d 轮）', main.sessions ?? 0, main.turns ?? 0)
console.log('='.repeat(78))
if (main.error) console.log('  ' + main.error)
else {
  console.log(`固定前缀（首步 input，= 系统提示词 + 全部工具 schema + 运行时快照）：中位 ${fmt(main.prefix)} tokens`)
  const line = (name, s) =>
    console.log(
      `  ${name.padEnd(16)} n=${String(s.n).padStart(3)}  步数中位 ${String(s.steps).padStart(4)}  ` +
        `miss ${fmt(s.miss).padStart(8)}  cacheRead ${fmt(s.cacheRead).padStart(9)}  output ${fmt(s.out).padStart(6)}` +
        `  → 等效 token p25 ${fmt(s.costP25).padStart(9)} / 中位 ${fmt(s.cost).padStart(9)}`,
    )
  line('1 步轮次', main.one)
  line('≤2 步轮次', main.two)
  line('≤6 步轮次', main.six)
  line('全部轮次', main.all)
}

console.log()
console.log('='.repeat(78))
console.log('小窗（实测：同一句简单提问，%s / %s）', small.model ?? '?', small.effort ?? '?')
console.log('='.repeat(78))
if (small.error) console.log('  ' + small.error)
else {
  for (const r of small.rows) {
    console.log(
      `  ${r.label}：prompt ${fmt(r.prompt)} tokens（miss ${fmt(r.miss)} + cacheRead ${fmt(r.cacheRead)}）` +
        ` + output ${fmt(r.out)} → ≈ ${fmt(r.cost)} 等效 token`,
    )
    console.log(
      `      system ${r.system} 字 / user ${r.user} 字 / 背景 ${r.background} 字（${r.backgroundMessages} 条真实对话）` +
        ` / ${r.rounds} 轮 / ${r.toolCalls} 次工具调用 / 首字 ${r.firstDelta}ms / 全程 ${(r.ms / 1000).toFixed(1)}s`,
    )
  }
  const best = Math.min(...small.rows.map((r) => r.cost))
  const worst = Math.max(...small.rows.map((r) => r.cost))
  if (!main.error) {
    console.log()
    console.log('= 对照（等效未缓存输入 token，越小越省；主会话一侧给 p25~中位）')
    const rows = [
      ['主会话 1 步（最省的一问）', main.one.costP25, main.one.cost],
      ['主会话 ≤2 步', main.two.costP25, main.two.cost],
      ['主会话 ≤6 步', main.six.costP25, main.six.cost],
      ['主会话中位轮次', main.all.costP25, main.all.cost],
    ]
    for (const [name, low, high] of rows) {
      console.log(
        `  ${name.padEnd(26)} ${fmt(low).padStart(8)} ~ ${fmt(high).padStart(8)}` +
          `   小窗省 ${(low / worst).toFixed(1)} ~ ${(high / best).toFixed(1)}×`,
      )
    }
    console.log(`  ${'小窗（实测上下界）'.padEnd(26)} ${fmt(best).padStart(8)} ~ ${fmt(worst).padStart(8)}`)
  }
}
console.log()
console.log(`折算口径：miss + cacheRead×${CACHE_READ_RATIO} + output×${OUTPUT_RATIO}（改脚本顶部两个常数即可换价格表）`)
