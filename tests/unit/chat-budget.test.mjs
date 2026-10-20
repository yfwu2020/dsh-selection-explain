import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planChatContext, estimateRequestTokens } from '../../lib/host/chat-context.js'

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
