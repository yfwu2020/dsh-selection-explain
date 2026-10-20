import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQuotesController } from '../../src/client/quotes.js'

test('quoting a compressed internal message restores its surrounding original text', () => {
  const quote = createQuotesController({ state: { turns: [
    { role: 'user', text: '此前前提：必须使用甲方案。需要引用的关键句。后续约束不可忘。' },
    { role: 'assistant', text: '已确认甲方案' }, { role: 'user', text: '近期问题' },
  ], contextState: { through: 2 } }, foldForHistory: t => t })
  const snapshot = quote.quoteContextFor({ source: 'panel', turnIndex: 0, text: '需要引用的关键句' })
  assert.ok(snapshot.context.includes('必须使用甲方案'))
  assert.ok(snapshot.context.includes('后续约束不可忘'))
  assert.ok(snapshot.context.includes('已确认甲方案'))
  assert.equal(quote.quoteContextFor({ source: 'panel', turnIndex: 2, text: '近期问题' }).context, '')
})
