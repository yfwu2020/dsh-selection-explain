import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planChatContext, estimateRequestTokens, resolveChatCapacity } from '../../lib/host/chat-context.js'
import { resolveConfig } from '../../lib/host/config.js'
import { SETTINGS_ITEMS } from '../../lib/settings.js'

const state = { version: 1, source: '12345678', through: 0, digest: '811c9dc5', summary: '', background: null }
test('a request already within the safety threshold is accepted even when most input is current material', async () => {
  const result = await planChatContext({}, { provider: 'fixture', model: 'fixture' }, { budget: 4096, price: () => 0 },
    { state, history: [], fixedTokens: 3200, signal: new AbortController().signal, effort: '' })
  assert.equal(result.compacted, false)
  assert.equal(result.estimatedTokens, 3200)
})

test('assembled request pricing includes nested tool images and restored material occurrences', () => {
  const capacity = { attachmentPrice: () => 1000 }
  const plain = [{ content: [{ type: 'text', text: 'answer' }] }]
  const withImage = [{ content: [{ type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: 'image' } }] }] }]
  assert.ok(estimateRequestTokens(withImage, capacity, []) >= estimateRequestTokens(plain, capacity, []) + 990)
})

test('the default budget admits a large input on a million-token model', async () => {
  const capacity = await resolveChatCapacity({ llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1000000 }, defaultMaxTokens: 8192 }) } },
    resolveConfig({}), { provider: 'fixture', model: 'fixture' })
  assert.equal(capacity.budget, 200000)
  const result = await planChatContext({}, { provider: 'fixture', model: 'fixture' }, capacity,
    { state, history: [], fixedTokens: 100000, signal: new AbortController().signal, effort: '' })
  assert.equal(result.compacted, false)
})

test('fallback image pricing does not charge a thumbnail as a full-size image', async () => {
  const capacity = await resolveChatCapacity({ llm: {} }, resolveConfig({}), { provider: 'fixture', model: 'fixture' })
  const thumbnail = capacity.attachmentPrice({ kind: 'image', ref: { attachmentId: 'tiny', width: 120, height: 86 } })
  const regular = capacity.attachmentPrice({ kind: 'image', ref: { attachmentId: 'regular', width: 1024, height: 1024 } })
  assert.ok(thumbnail <= 1024)
  assert.ok(regular >= 4096)
})

test('the settings input accepts exactly two hundred thousand tokens', () => {
  const field = SETTINGS_ITEMS.find(item => item.key === 'chatContextTokens')
  assert.ok(Number.isInteger((200000 - field.min) / field.step), 'the requested value must satisfy the number input step')
})
