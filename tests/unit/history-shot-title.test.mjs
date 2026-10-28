import assert from 'node:assert/strict'
import { test } from 'node:test'
import { API, HISTORY } from '../../src/client/constants.js'
import { createShotTitleController } from '../../src/client/history-shot-title.js'

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const titleResponse = { ok: true, text: async () => 'data: {"type":"delta","text":"标题：预算逻辑。"}\n\n' }
const savedEntry = () => ({ key: 'shot-key', text: 'question', turns: [{ role: 'user', attachments: [{ kind: 'image', ref: { attachmentId: 'shot' } }] }], shotScope: 'region', shotFrame: false })

test('pending title requests deduplicate and preserve the latest history entry at writeback', async () => {
  const oldFetch = globalThis.fetch
  let resolveTitle
  const calls = []
  const titles = []
  let refreshed = 0
  const saved = savedEntry()
  const latest = { ...saved, turns: [...saved.turns, { role: 'assistant', text: 'newer answer' }, { role: 'user', text: 'newer question' }], pinned: true }
  const env = { state: { cacheKey: saved.key, modelChoice: { provider: 'provider', model: 'vision' } }, historyList: { style: { display: 'flex' } }, applyShotTitle: title => titles.push(title) }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: options?.body && JSON.parse(options.body) })
    if (url === API) return new Promise(resolve => { resolveTitle = resolve })
    if (url.startsWith(HISTORY + '?')) return { ok: true, json: async () => ({ entry: latest }) }
    return { ok: true }
  }
  try {
    const controller = createShotTitleController(env, () => refreshed++)
    controller.maybeRequest(saved, 'session')
    controller.maybeRequest(saved, 'session')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body, { text: 'question', kind: 'shot', titleOnly: true, label: '截图', attachments: saved.turns[0].attachments, shotScope: 'region', shotFrame: false, sessionId: 'session', provider: 'provider', model: 'vision' })
    resolveTitle(titleResponse)
    await flush()
    assert.deepEqual(titles, ['预算逻辑'])
    assert.equal(refreshed, 1)
    assert.deepEqual(calls.at(-1).body, { ...latest, title: '预算逻辑', label: '截图 · 预算逻辑' })
    assert.equal(saved.turns.length, 1)
  } finally { globalThis.fetch = oldFetch }
})

test('title completion reads the live conversation before updating the panel', async () => {
  const oldFetch = globalThis.fetch
  let resolveTitle
  const titles = []
  const writes = []
  const saved = savedEntry()
  const env = { state: { cacheKey: saved.key }, applyShotTitle: title => titles.push(title) }
  globalThis.fetch = async (url, options) => {
    if (url === API) return new Promise(resolve => { resolveTitle = resolve })
    if (url.startsWith(HISTORY + '?')) return { ok: true, json: async () => ({ entry: saved }) }
    writes.push(JSON.parse(options.body)); return { ok: true }
  }
  try {
    createShotTitleController(env, () => {}).maybeRequest(saved)
    env.state = { cacheKey: 'another-conversation' }
    resolveTitle(titleResponse)
    await flush()
    assert.deepEqual(titles, [])
    assert.equal(writes[0].key, saved.key)
    assert.equal(writes[0].title, '预算逻辑')
  } finally { globalThis.fetch = oldFetch }
})

test('title failure retries once after the established delay and then allows another request', async () => {
  const oldFetch = globalThis.fetch
  const oldTimeout = globalThis.setTimeout
  const timers = []
  let requests = 0
  globalThis.fetch = async () => { requests++; return { ok: false } }
  globalThis.setTimeout = (callback, delay) => { timers.push({ callback, delay }) }
  try {
    const controller = createShotTitleController({ state: {} }, () => {})
    controller.maybeRequest(savedEntry())
    await flush()
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 2000)
    timers[0].callback()
    await flush()
    assert.equal(requests, 2)
    assert.equal(timers.length, 1)
    controller.maybeRequest(savedEntry())
    await flush()
    assert.equal(requests, 3)
  } finally { globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimeout }
})
