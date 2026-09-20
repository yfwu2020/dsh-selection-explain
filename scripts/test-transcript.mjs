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
import { transcriptOf } from '../lib/index.js'

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

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
