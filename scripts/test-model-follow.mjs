/** Model following regressions: execute the client functions against real HTTP responses. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { test } from 'node:test'

const source = readFileSync(resolve(process.argv[2] || 'src/client/index.js'), 'utf8')

// Extract executable functions, never assert on their spelling or implementation.
function functionSource(name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, 'Missing client function: ' + name)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1)
    else if (ch === "'" || ch === '"' || ch === '`') {
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === '\\') i += 1
        else if (source[i] === ch) break
      }
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
    } else if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1
    }
  }
  throw new Error('Unclosed function: ' + name)
}

function currentSession(services) {
  return new Function('ctx', functionSource('currentSessionId') + '; return currentSessionId()')({
    get: (name) => services[name],
  })
}

test('reads the current session from the modern DSH session binding, not catalog.current', () => {
  assert.equal(currentSession({
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'session-a', props: { sessionId: 'session-a' } }) } } },
    sessions: { list: { getSnapshot: () => ({ ids: ['session-a'], byId: {}, phase: 'ready', projectionsBySession: {} }) } },
  }), 'session-a')
})

test('an absent modern binding cannot revive a stale legacy current session', () => {
  assert.equal(currentSession({
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: undefined, props: { sessionId: undefined } }) } } },
    sessions: { list: { getSnapshot: () => ({ current: 'stale-session' }) } },
  }), '')
})

test('supports older DSH runtimes without the session binding service', () => {
  assert.equal(currentSession({ sessions: { list: { getSnapshot: () => ({ current: 'legacy-session' }) } } }), 'legacy-session')
})

const server = createServer((req, res) => {
  const id = new URL(req.url, 'http://localhost').searchParams.get('sessionId')
  const send = () => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, current: { provider: 'provider', model: id }, models: [{ provider: 'provider', model: id }] }))
  }
  // A finishes after B, reproducing a switch while A's catalog is loading.
  setTimeout(send, id === 'session-a' ? 40 : 0)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port

function catalogClient(currentId) {
  return new Function('MODELS', 'fetch', 'currentSessionId', 'panelOrCurrentSessionId', `
    var modelCatalog = { at: 0, items: [], current: null, stages: null, loading: false, pending: null, error: '', leakyOff: [], sessionId: null }
    var modelCatalogRequestSeq = 0
    ${functionSource('loadModelCatalog')}
    return { load: loadModelCatalog, snapshot: () => modelCatalog }
  `)(origin + '/models', fetch, () => currentId, () => currentId)
}

try {
  await test('catalog requests use the panel session even after navigation to another session', async () => {
    const client = catalogClient('session-b')
    const result = await client.load(true, 'session-a')
    assert.equal(result.current.model, 'session-a')
    assert.equal(result.sessionId, 'session-a')
  })

  await test('concurrent catalogs for different sessions cannot share or overwrite each other', async () => {
    const client = catalogClient('session-a')
    const a = client.load(true, 'session-a')
    const b = client.load(true, 'session-b')
    const [resultA, resultB] = await Promise.all([a, b])
    assert.equal(resultA.current.model, 'session-a')
    assert.equal(resultB.current.model, 'session-b')
    assert.equal(client.snapshot().current.model, 'session-b')
    const cachedB = await client.load(false, 'session-b')
    assert.equal(cachedB.current.model, 'session-b')
  })
} finally {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}

await test('legacy follow-up model cannot override the model used by first and second rounds', async () => {
  const ts = await import('typescript')
  const host = readFileSync(resolve('src/index.ts'), 'utf8')
  const start = host.indexOf('  const resolveRoute = (')
  const end = host.indexOf('  /** 分钟级限流。 */', start)
  const js = ts.default.transpileModule(host.slice(start, end), { compilerOptions: { target: ts.default.ScriptTarget.ES2022 } }).outputText
  const config = { provider: 'shared', model: 'chosen', chatProvider: 'legacy', chatModel: 'wrong' }
  const route = new Function('config', 'modelCache', 'ctx', 'captured', js + '; return resolveRoute')(config, { items: [] }, { get: () => null }, null)
  assert.deepEqual(route(undefined, null, false), { provider: 'shared', model: 'chosen' })
  assert.deepEqual(route(undefined, null, true), { provider: 'shared', model: 'chosen' })
  config.provider = ''; config.model = ''
  assert.deepEqual(route(undefined, { provider: 'session', model: 'current' }, true), { provider: 'session', model: 'current' })
})

await test('first and second rounds use the same selected model without borrowing follow-up effort', () => {
  const payload = new Function('state', 'document', 'location', 'panelOrCurrentSessionId', 'selectionKind', functionSource('buildPayload') + '; return buildPayload')(
    { modelChoice: { provider: 'shared', model: 'chosen' }, effort: 'max' }, { title: 'test' }, { href: 'http://local' }, () => 'session', () => 'text')
  for (const stage of ['translation', 'detail']) {
    const body = payload('text', 'context', 'label', false, stage)
    assert.equal(body.provider, 'shared')
    assert.equal(body.model, 'chosen')
    assert.equal(body.effort, undefined)
  }
})

function settingsClient(send) {
  return new Function('fetch', `
    var SETTINGS = '/settings', settingsSpec = {}, settingsSaving = false, settingsResetting = false,
        settingsSaveRequest = null, settingsSaveSeq = 0, settingsSaveTimer = 0,
        settingsLive = {provider: 'p', model: 'old'}, settingsSaved = {provider: 'p', model: 'old'},
        settingsByKey = {}, state = {}, bridgeOn = true, EFFORT_KEY = 'effort', scheduled = 0, MAX_SELECTION = 4000;
    var settingsNoteText = {textContent: ''}, settingsNote = {setAttribute: function(){}};
    function renderSettingsNote(note) { settingsNoteText.textContent = note === 'error' ? '保存失败，改动未生效' : note }
    function settingsDirtyCount() { return Object.keys(settingsLive).filter(k => settingsLive[k] !== settingsSaved[k]).length }
    function scheduleSettingsSave() { scheduled++ }
    function paintModelPick(){} function repaintModelMenu(){} function setControlValue(){}
    function updateSettingDependencies(){} function syncComposerModel(){ state.modelChoice = settingsLive.model ? {provider: settingsLive.provider, model: settingsLive.model} : null }
    function refreshModelRow(){} function paintModelPill(){} function writeStore(){} function applyPillPrefs(){} function scheduleBridgeScan(){}
    ${functionSource('applySelectionLimit')}
    ${functionSource('applyServerValues')}
    ${functionSource('flushSettingsSave')}
    ${functionSource('resetSettings')}
    return { edit(model) { settingsLive.model = model }, save: flushSettingsSave, reset: resetSettings,
      snapshot() { return {live: {...settingsLive}, saved: {...settingsSaved}, scheduled, resetting: settingsResetting, choice: state.modelChoice} } }
  `)(send)
}

await test('a slow save preserves a newer model choice and schedules its save', async () => {
  let finish
  const client = settingsClient(() => new Promise(resolve => { finish = resolve }))
  client.edit('first')
  const pending = client.save()
  client.edit('second')
  finish({json: async () => ({ok: true, values: {provider: 'p', model: 'first'}})})
  await pending
  assert.equal(client.snapshot().live.model, 'second')
  assert.equal(client.snapshot().saved.model, 'first')
  assert.equal(client.snapshot().choice.model, 'second')
  assert.equal(client.snapshot().scheduled, 1)
})

await test('reset waits for an active save before clearing the shared model', async () => {
  let finish; const requests = []
  const client = settingsClient((url, init) => {
    const body = JSON.parse(init.body); requests.push(body)
    if (!body.reset) return new Promise(resolve => { finish = resolve })
    return Promise.resolve({json: async () => ({ok: true, values: {provider: '', model: '', chatReasoningEffort: 'high'}})})
  })
  client.edit('changed'); const pending = client.save(); client.reset()
  await Promise.resolve()
  assert.equal(requests.length, 1)
  finish({json: async () => ({ok: true, values: {provider: 'p', model: 'changed'}})})
  await pending
  for (let i = 0; i < 20 && client.snapshot().resetting; i++) await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(requests.length, 2)
  assert.equal(requests[1].reset, true)
  assert.equal(client.snapshot().live.model, '')
  assert.equal(client.snapshot().choice, null)
})

await test('reset also clears a value normalized by the in-flight save', async () => {
  let finish
  const client = settingsClient((url, init) => JSON.parse(init.body).reset
    ? Promise.resolve({json: async () => ({ok: true, values: {provider: '', model: ''}})})
    : new Promise(resolve => { finish = resolve }))
  client.edit(' padded '); const pending = client.save(); client.reset()
  finish({json: async () => ({ok: true, values: {provider: 'p', model: 'padded'}})})
  await pending
  for (let i = 0; i < 20 && client.snapshot().resetting; i++) await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(client.snapshot().live.model, '')
  assert.equal(client.snapshot().scheduled, 0)
})
