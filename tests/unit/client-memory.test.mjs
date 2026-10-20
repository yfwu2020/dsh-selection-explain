import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createResultCache, createTimerScope } from '../../src/client/memory.js'
import { createPanelController } from '../../src/client/panel.js'

test('result cache evicts least recently read entries and keeps snapshots independent', () => {
  const cache = createResultCache(2, 10000)
  const value = { parts: { translation: 'first' }, turns: [] }
  cache.set('first', value)
  value.parts.translation = 'changed outside cache'
  cache.set('second', { parts: { translation: 'second' } })
  assert.equal(cache.get('first').parts.translation, 'first')
  cache.set('third', { parts: { translation: 'third' } })
  assert.equal(cache.get('second'), undefined)
  assert.deepEqual([...cache.keys()], ['first', 'third'])
  const read = cache.get('first')
  read.parts.translation = 'changed after reading'
  assert.equal(cache.get('first').parts.translation, 'first')
})

test('large results and replacements cannot bypass the cache text budget', () => {
  const cache = createResultCache(20, 500)
  for (let i = 0; i < 1000; i++) cache.set('key-' + i, { text: 'x'.repeat(100) })
  assert.ok(cache.size <= 2)
  assert.ok(cache.textBytes <= 500)
  cache.set('key-999', { text: 'x'.repeat(1000) })
  assert.equal(cache.get('key-999'), undefined, 'oversized replacement must not leave stale data')
  assert.ok(cache.get('key-998'))
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.textBytes, 0)
  cache.dispose()
  cache.set('late-response', { text: 'must not survive unload' })
  assert.equal(cache.size, 0)
})

test('completed and cancelled timers leave no retained timer records', async () => {
  const scope = createTimerScope()
  let calls = 0
  for (let i = 0; i < 1000; i++) scope.later(() => { calls++ }, 0)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls, 1000)
  assert.equal(scope.size, 0)
  const timer = scope.interval(() => { calls++ }, 1000)
  assert.equal(scope.size, 1)
  scope.clear(timer)
  assert.equal(scope.size, 0)
  scope.later(() => { calls++ }, 1000)
  scope.dispose()
  scope.later(() => { calls++ }, 0)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls, 1000)
  assert.equal(scope.size, 0)
})

test('closing panels releases cancelled animation timer records', () => {
  const timerScope = createTimerScope()
  const env = {
    timerScope, state: {}, panel: { style: {} },
    translationSection: { content: {} }, detailSection: { content: {} },
    closeModelMenu() {}, closeSettings() {}, hideHistoryList() {}, hideQuoteButton() {},
    cancelVoice() {}, clearWaiting() {}, clearRenderedTurns() {}, paintPill() {}, syncRouteWatch() {},
  }
  try {
    const panel = createPanelController(env)
    for (let i = 0; i < 100; i++) {
      env.panelGrowTimer = timerScope.later(() => {}, 1000)
      panel.closePanel()
    }
    assert.equal(timerScope.size, 0)
  } finally { timerScope.dispose() }
})
