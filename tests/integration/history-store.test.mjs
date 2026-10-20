import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoryStore } from '../../lib/host/history-store.js'
import { resolveConfig } from '../../lib/host/config.js'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const snapshot = (key, at, extra = {}) => ({
  key, text: key, context: '', label: '', at,
  parts: { translation: '', detail: '' }, turns: [], toolDigest: '', pinned: false,
  ...extra,
})

async function fixture(t, entries = [], options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-history-store-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dir = join(home, 'selection-explain')
  const file = join(dir, 'history.json')
  await mkdir(dir)
  await writeFile(file, JSON.stringify({ version: 1, entries }))
  const config = resolveConfig({ historyMaxEntries: 4, ...options })
  const ctx = { logger: { info() {}, warn() {} } }
  const boot = () => createHistoryStore(ctx, config, { loadLeaky: async () => {} }, { loadSettings: async () => {} })
  let store = boot()
  const server = createServer((req, res) => store.handleHistory(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    // Let the store's debounced writer finish before removing its data directory.
    await sleep(1000)
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  })
  const origin = 'http://127.0.0.1:' + server.address().port
  return {
    async api(body, query = '', method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(origin + '/' + query, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, ...await response.json() }
    },
    async restartAfterSave(key) {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        try {
          const saved = JSON.parse(await readFile(file, 'utf8'))
          if (saved.entries.some(entry => entry.key === key)) {
            store = boot()
            return
          }
        } catch {}
        await sleep(20)
      }
      assert.fail('history was not persisted')
    },
  }
}

test('after restart, eviction removes the oldest entry even when it was promoted', async t => {
  const { api } = await fixture(t, [
    snapshot('newest', 3), snapshot('middle', 2), snapshot('oldest', 1),
    snapshot('pinned', 0, { pinned: true }),
  ])
  assert.equal((await api({ key: 'added', text: 'added' })).status, 200)
  assert.deepEqual((await api()).entries.map(entry => entry.key), ['added', 'newest', 'middle', 'oldest'])
})

test('loading old promoted history applies the configured capacity immediately', async t => {
  const { api } = await fixture(t, [
    snapshot('newest', 3, { pinned: true }), snapshot('middle', 2, { pinned: true }),
    snapshot('oldest', 1, { pinned: true }),
  ], { historyMaxEntries: 2 })
  assert.deepEqual((await api()).entries.map(entry => entry.key), ['newest', 'middle'])
})

test('new promoted entries cannot exceed the configured capacity', async t => {
  const { api } = await fixture(t, [], { historyMaxEntries: 2 })
  for (const key of ['first', 'second', 'third']) {
    assert.equal((await api({ key, text: key, pinned: true })).status, 200)
  }
  assert.deepEqual((await api()).entries.map(entry => entry.key).sort(), ['second', 'third'])
})

test('zero capacity stops new saving without clearing existing promoted history', async t => {
  const { api } = await fixture(t, [snapshot('existing', 1, { pinned: true })], { historyMaxEntries: 0 })
  await api({ key: 'new', text: 'new', pinned: true })
  assert.deepEqual((await api()).entries.map(entry => entry.key), ['existing'])
})

test('all messages and attachments survive saving and restarting a long conversation', async t => {
  const { api, restartAfterSave } = await fixture(t)
  const turns = Array.from({ length: 64 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'message-' + i }))
  turns[62].attachments = [{ kind: 'file', ref: { attachmentId: 'sha256:' + 'a'.repeat(64), name: 'notes.txt', bytes: 1 } }]
  assert.equal((await api({ key: 'long', text: 'long', turns, skipped: true })).status, 200)
  assert.deepEqual((await api(undefined, '?key=long')).entry.turns, turns)
  await restartAfterSave('long')
  const restored = (await api(undefined, '?key=long')).entry
  assert.deepEqual(restored.turns, turns)
  assert.equal(restored.skipped, true)
})

test('invalid restore snapshots return 400 without damaging existing history', async t => {
  const { api } = await fixture(t, [snapshot('existing', 1)])
  for (const entry of [null, [], { key: 'invalid' }, snapshot('bad-turns', 2, { turns: {} }), snapshot('bad-parts', 2, { parts: null })]) {
    assert.equal((await api({ entry }, '?restore=1')).status, 400)
    const list = await api()
    assert.equal(list.status, 200)
    assert.deepEqual(list.entries.map(item => item.key), ['existing'])
  }
})

test('restore normalizes fields and preserves the original timestamp, pin and skipped state', async t => {
  const { api } = await fixture(t)
  const entry = snapshot('restored', 123, {
    pinned: true, skipped: true, text: 'x'.repeat(20001),
    unexpected: 'discard me',
    turns: [{ role: 'user', text: 'hello', unexpected: 'discard me' }],
  })
  assert.equal((await api({ entry }, '?restore=1')).status, 200)
  const saved = (await api(undefined, '?key=restored')).entry
  assert.equal(saved.at, 123)
  assert.equal(saved.pinned, true)
  assert.equal(saved.skipped, true)
  assert.equal(saved.text.length, 20000)
  assert.equal(Object.hasOwn(saved, 'unexpected'), false)
  assert.deepEqual(saved.turns, [{ role: 'user', text: 'hello' }])
})

test('restoring an old snapshot respects capacity and original age', async t => {
  const { api } = await fixture(t, [snapshot('newer', 3), snapshot('older', 2)], { historyMaxEntries: 2 })
  assert.equal((await api({ entry: snapshot('restored-oldest', 1, { pinned: true }) }, '?restore=1')).status, 200)
  assert.deepEqual((await api()).entries.map(entry => entry.key), ['newer', 'older'])
})
