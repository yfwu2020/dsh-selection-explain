import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyDigest, prepareChatHistory, readContextState, estimateTextTokens, contextBudget, chooseCompactionEnd } from '../../lib/chat-context.js'

const turns = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message-${i}` }))
const image = id => ({ kind: 'image', ref: { attachmentId: 'sha256:' + id, name: id + '.png', bytes: 5 * 1024 * 1024 } })
const checkpoint = (n = 20) => ({ version: 1, source: '12345678', through: n, digest: historyDigest(turns.slice(0, n)), summary: '用户要求保留原有命名；已确认使用甲方案。', background: null })

test('short conversations over twenty messages keep their complete model history', () => {
  const result = prepareChatHistory(turns, null)
  assert.equal(result.history.length, 30)
  assert.equal(result.history[0].text, 'message-0')
  assert.equal(result.historyStart, 0)
})

test('restored checkpoints send only the unchanged original tail and reject edited prefixes', () => {
  const state = checkpoint()
  const result = prepareChatHistory(turns, JSON.parse(JSON.stringify(state)))
  assert.equal(result.historyStart, 20)
  assert.equal(result.history.length, 10)
  assert.equal(result.history[0].text, 'message-20')
  const edited = structuredClone(turns)
  edited[0].text = '用户修改了早期要求'
  assert.equal(prepareChatHistory(edited, state).historyStart, 0)
  assert.equal(prepareChatHistory(turns.slice(0, 10), state).historyStart, 0)
})

test('hidden interpretation seeds do not change checkpoint offsets on reopening', () => {
  const original = [{ role: 'assistant', text: '前情', hidden: true }, ...turns]
  assert.equal(prepareChatHistory(original, checkpoint()).historyStart, 20)
  assert.deepEqual(prepareChatHistory(original, checkpoint()).history, prepareChatHistory(turns, checkpoint()).history)
})

test('HTML and attachment occurrences stay identical as later questions are appended', () => {
  const page = '```html\n<html><body>unchanged source</body></html>\n```'
  const history = [{ role: 'user', text: '看图', attachments: [image('a'), image('b'), image('c')] }, { role: 'assistant', text: page }]
  const first = prepareChatHistory(history, null)
  const later = prepareChatHistory([...history, { role: 'user', text: '再问', attachments: [image('d')] }], null)
  assert.deepEqual(later.history.slice(0, 2), first.history)
  assert.equal(first.history[1].text, page)
  assert.equal(later.materials.length, 4)
})

test('material catalog retains old files and distinguishes same-name versions', () => {
  const attachments = Array.from({ length: 12 }, (_, i) => ({ kind: 'file', ref: { attachmentId: 'sha256:' + i, name: 'report.pdf' } }))
  const history = attachments.map(a => ({ role: 'user', text: '附件', attachments: [a] }))
  history.push({ role: 'user', text: '重用', attachments: [attachments[0]] })
  assert.equal(prepareChatHistory(history, null).materials.length, 12)
})

test('capacity reserves answer space and compacts at complete question-answer boundaries', () => {
  assert.equal(contextBudget(32768, 16000, 4000, 2000), 10000)
  assert.equal(contextBudget(32768, undefined, 8192, 2000), 32768)
  const pairs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '汉'.repeat(100) }))
  const cut = chooseCompactionEnd(pairs, 500, t => estimateTextTokens(t.text) + 10)
  assert.equal(cut, 6)
  assert.equal(pairs[cut].role, 'user')
  assert.equal(chooseCompactionEnd(pairs.slice(-2), 100, t => estimateTextTokens(t.text) + 10), -1)
})

test('malformed or oversized checkpoint state cannot silently skip history', () => {
  for (const state of [null, {}, { ...checkpoint(), through: -1 }, { ...checkpoint(), through: 0.5 }, { ...checkpoint(), summary: 'x'.repeat(12001) }]) {
    assert.equal(readContextState(state), null)
  }
  assert.ok(readContextState(checkpoint()))
})


test('a rejected oversized input stays in UI data but cannot poison later model history', () => {
  const original = '超'.repeat(6000)
  const records = [{ role: 'user', text: original, contextExcluded: true }, { role: 'assistant', text: '容量不足', contextExcluded: true },
    { role: 'user', text: '改为简单问题' }]
  const result = prepareChatHistory(records, null)
  assert.equal(records[0].text, original)
  assert.ok(result.history[0].text.length < 200)
  assert.ok(result.history.reduce((n, t) => n + estimateTextTokens(t.text), 0) < 4096)
})
