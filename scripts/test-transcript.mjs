/**
 * 会话背景窗口的离线测试（不依赖运行中的 host）。
 *
 * 覆盖：
 *   · 窗口锚定「选中文字所在的消息」，向上最多 maxMessages 条（含锚点），其后的对话不进去
 *   · 默认不做任何字数截断（长消息整条保留）
 *   · 工具结果 / 系统提示 / harness 注入的 user 消息全部剔除
 *   · 定位不到选中位置时退回最近 maxMessages 条
 *
 * 用法：node scripts/test-transcript.mjs   （先 npm run build）
 */
import { quoteContextOf, transcriptOf } from '../lib/index.js'

let failed = 0
const assert = (label, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed += 1
}

const userEvent = (text, kind = 'user') => ({
  type: 'user/message',
  data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] },
})
const assistantEvent = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const toolEvent = () => ({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 't' }] } } })
const systemEvent = (text) => ({ type: 'system/message', data: { message: { content: [{ type: 'text', text }] } } })

const LONG = '很长的助手答复'.repeat(300) // 2100 字，用于验证「不截断」

// 30 轮对话：用户 U01..U30 / 助手 A01..A30（零填充避免子串误命中），夹杂工具与系统消息
const events = [systemEvent('系统提示词'.repeat(500)), userEvent('被 harness 注入的上下文', 'plugin')]
for (let i = 1; i <= 30; i += 1) {
  events.push(userEvent(`U${String(i).padStart(2, '0')}`))
  events.push(toolEvent())
  events.push(assistantEvent(i === 25 ? `${LONG} A25` : `A${String(i).padStart(2, '0')}`))
  events.push(toolEvent())
}

// ── 1) 命中 U25：窗口 = 从 U25 向上数 24 条（A13..U25），其后的对话不进背景
const hit = transcriptOf(events, { maxMessages: 24, maxChars: 0, marker: 'U25' })
const lines = hit.transcript.split('\n').filter((line) => /^\s*(▶\s*)?(用户|助手)：/.test(line))
assert('窗口条数 = 24（含锚点）', lines.length === 24, `实际 ${lines.length}`)
assert('首条是 A13（自锚点向上满 24 条）', lines[0].includes('助手：A13'), lines[0])
assert('末条是选中所在的 U25，且带 ▶', lines[lines.length - 1].includes('▶') && lines[lines.length - 1].includes('用户：U25'), lines[lines.length - 1].slice(0, 30))
assert('锚点命中标记正确', hit.marked === true)
assert('锚点之后的对话不进背景', hit.transcript.indexOf('A26') < 0 && hit.transcript.indexOf('U26') < 0 && hit.transcript.indexOf('U30') < 0)
assert('提示行说明前面还有更早消息', hit.transcript.includes('未包含'))

// ── 1b) 锚点稍后（U26）时，锚点之前的长消息整条保留（默认不截断）
const later = transcriptOf(events, { maxMessages: 24, maxChars: 0, marker: 'U26' })
assert('长消息未被截断', later.transcript.includes(LONG), `背景共 ${later.transcript.length} 字`)

// ── 2) 剔除噪音：工具/系统/注入消息不出现
assert('工具结果被剔除', hit.transcript.indexOf('工具：') < 0)
assert('系统提示词被剔除', hit.transcript.indexOf('系统提示') < 0)
assert('harness 注入的上下文被剔除', hit.transcript.indexOf('被 harness 注入') < 0)

// ── 3) 定位不到：退回最近 24 条，且不带锚点
const miss = transcriptOf(events, { maxMessages: 24, maxChars: 0, marker: '这段文字不在任何消息里' })
const missLines = miss.transcript.split('\n').filter((line) => /^\s*(▶\s*)?(用户|助手)：/.test(line))
assert('未命中时退回最近 24 条', missLines.length === 24 && missLines[missLines.length - 1].includes('A30'), `末条=${missLines[missLines.length - 1]}`)
assert('未命中时不标锚点', miss.marked === false)

// ── 4) 早期消息：锚点靠近开头时窗口自然变短
const early = transcriptOf(events, { maxMessages: 24, maxChars: 0, marker: 'U02' })
const earlyLines = early.transcript.split('\n').filter((line) => /^\s*(▶\s*)?(用户|助手)：/.test(line))
assert(
  '锚点靠开头时窗口自然缩短（U01 / A01 / U02）',
  earlyLines.length === 3 && earlyLines[0].includes('U01'),
  `实际 ${earlyLines.length} 条`,
)

// ── 5) 显式设了总量上限时才裁剪
const capped = transcriptOf(events, { maxMessages: 24, maxChars: 200, marker: 'U25' })
assert('显式上限生效（配置 >0 时）', capped.transcript.length < 2000, `${capped.transcript.length} 字`)

// ───────────────────────── 引用上下文（quoteContextOf）─────────────────────────
// 与解读用的会话背景不同：窗口是**锚点两侧**、按"轮"取整（上下各至少一整组）。
{
  const lines = (text) => text.split('\n').filter((line) => /^(用户|助手|提示)：/.test(line))
  const quoted = quoteContextOf(events, 'U10', {})
  const picked = lines(quoted.transcript)
  assert('引用上下文：命中并报出组数', quoted.matched === true && quoted.rounds === 3, JSON.stringify({ matched: quoted.matched, rounds: quoted.rounds }))
  assert(
    '引用上下文：锚点所在那一组 + 上下各一组（U09/A09 · U10/A10 · U11/A11）',
    picked.length === 6 &&
      picked[0].includes('用户：U09') &&
      picked[1].includes('助手：A09') &&
      picked[2].includes('用户：【U10】') &&
      picked[3].includes('助手：A10') &&
      picked[4].includes('用户：U11') &&
      picked[5].includes('助手：A11'),
    picked.map((line) => line.slice(0, 14)).join(' | '),
  )
  assert('引用上下文：被引用的部分用【】标出', quoted.transcript.includes('用户：【U10】'), quoted.transcript.split('\n')[2])

  // 引用落在助手回复里（常见：引用 AI 的某句话）→ 同样带上下各一组
  const inAnswer = quoteContextOf(events, 'A10', {})
  const answerLines = lines(inAnswer.transcript)
  assert(
    '引用在助手回复里：一样是上下一整组',
    inAnswer.matched === true && answerLines.length === 6 && inAnswer.transcript.includes('助手：【A10】'),
    answerLines.map((line) => line.slice(0, 14)).join(' | '),
  )

  // 引用跨行/空白不一致（选中文字与消息原文差在换行、缩进）也要标得出来
  const wrapped = [
    userEvent('第一句\n第二句 在这里\n第三句'),
    assistantEvent('A1'),
    userEvent('U2'),
    assistantEvent('A2'),
  ]
  const spread = quoteContextOf(wrapped, '第一句 第二句 在这里', {})
  assert('引用跨行时按"空白等价"标记', spread.matched === true && spread.transcript.includes('【第一句\n第二句 在这里】'), spread.transcript.replace(/\n/g, '⏎').slice(0, 60))

  // 定位不到：不猜、返回空（客户端会退回自己的局部上下文）
  const nowhere = quoteContextOf(events, '这段文字不在会话里', {})
  assert('引用定位不到时返回 matched:false 且不带上下文', nowhere.matched === false && nowhere.transcript === '', JSON.stringify(nowhere))

  // 长消息：**围绕引用**截断，引用本身不能被裁掉
  const longTurn = [userEvent(`${'前'.repeat(3000)}引用的这句${'后'.repeat(3000)}`), assistantEvent('A1')]
  const clamped = quoteContextOf(longTurn, '引用的这句', { maxCharsPerTurn: 400, maxChars: 6000 })
  assert(
    '长消息围绕引用截断（引用仍在，前后留边）',
    clamped.transcript.includes('【引用的这句】') && clamped.transcript.length < 700 && clamped.transcript.includes('…'),
    `${clamped.transcript.length} 字`,
  )

  // 总上限：超了丢最早的那几组，引用所在那条一定留下
  const many = []
  for (let i = 1; i <= 9; i += 1) {
    many.push(userEvent(`Q${i} ${'x'.repeat(400)}`))
    many.push(assistantEvent(`R${i} ${'y'.repeat(400)}`))
  }
  const budget = quoteContextOf(many, 'Q5', { roundsAround: 3, maxChars: 1200 })
  assert(
    '总上限生效：引用所在那条保留，更早的被丢掉并留提示',
    budget.transcript.includes('【Q5】') && budget.transcript.includes('未包含') && budget.transcript.length < 2200,
    `${budget.transcript.length} 字`,
  )

  // 噪音过滤与解读背景一致
  assert(
    '引用上下文同样剔除工具/系统/harness 注入',
    quoted.transcript.indexOf('工具') < 0 && quoted.transcript.indexOf('系统提示') < 0 && quoted.transcript.indexOf('被 harness 注入') < 0,
    '',
  )
}

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
