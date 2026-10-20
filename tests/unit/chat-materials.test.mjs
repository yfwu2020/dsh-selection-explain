import assert from 'node:assert/strict'
import { test } from 'node:test'
import { restoreMaterial } from '../../lib/host/chat-materials.js'
import { readHistoryAttachments } from '../../lib/host/history-attachments.js'

test('material listing includes saved attachments even before the first compaction', async () => {
  const catalog = [{ kind: 'image', ref: { attachmentId: 'sha256:failed-input-image', name: 'still-saved.png' }, turn: 0 }]
  const result = await restoreMaterial({ get() {} }, catalog, {}, { through: 0, key: 'key', maxChars: 1000, readMessage: async () => null })
  assert.ok(result.content[0].text.includes('sha256:failed-input-image'))
})

test('restoring extra materials cannot discard the original ten upload references', () => {
  const refs = Array.from({ length: 11 }, (_, i) => ({ kind: 'file', ref: { attachmentId: 'sha256:file-' + i, name: i + '.txt' } }))
  const saved = readHistoryAttachments(refs)
  assert.equal(saved.length, 11)
  assert.equal(saved[0].ref.attachmentId, 'sha256:file-0')
})
