import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
const bundled = await build({ entryPoints: ['src/client/history.js'], bundle: true, platform: 'node', format: 'esm', write: false })
const { createHistoryController } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))

test('failed full-history persistence is visible without deleting the current original text', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 413 })
  const answer = { role: 'assistant', text: '完整原始回答' }
  const env = { state: { payload: { text: 'selected', context: 'ctx' }, cacheKey: 'key', parts: {}, turns: [answer] },
    exportTurns: () => [{ role: 'assistant', text: answer.text }], clearWaiting() {}, chatLog: { textContent: '' }, panelOpen: false }
  try {
    createHistoryController(env).saveHistory()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(answer.notice || '', /历史.*保存失败/)
    assert.equal(answer.text, '完整原始回答')
  } finally { globalThis.fetch = previousFetch }
})
