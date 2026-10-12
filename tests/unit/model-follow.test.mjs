/** Exercise real controllers and host model selection without parsing source text. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createPanelController } from '../../src/client/panel.js'
import { createModelsController } from '../../src/client/models.js'
import { createSettingsController } from '../../src/client/settings.js'
import { createModels } from '../../lib/host/models.js'
import { resolveConfig } from '../../lib/host/config.js'

const waitFor = async predicate => {
  const end = Date.now() + 2500
  while (!predicate() && Date.now() < end) await new Promise(done => setTimeout(done, 10))
  assert.ok(predicate(), 'controller operation should settle')
}
const currentSession = services => createPanelController({ctx: {get: name => services[name]}}).currentSessionId()
test('reads the current session from the modern binding', () => {
  assert.equal(currentSession({uiSession: {adapter: {current: {getSnapshot: () => ({key: 'session-a', props: {sessionId: 'session-a'}})}}}}), 'session-a')
})
test('an absent modern binding cannot revive a stale legacy session', () => {
  assert.equal(currentSession({uiSession: {adapter: {current: {getSnapshot: () => ({key: undefined, props: {sessionId: undefined}})}}}, sessions: {list: {getSnapshot: () => ({current: 'stale'})}}}), '')
})
test('supports the legacy session binding', () => {
  assert.equal(currentSession({sessions: {list: {getSnapshot: () => ({current: 'legacy'})}}}), 'legacy')
})
const originalFetch = globalThis.fetch
const server = createServer((req, res) => {
  const id = new URL(req.url, 'http://localhost').searchParams.get('sessionId')
  setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ok: true, current: {provider: 'provider', model: id}, models: [{provider: 'provider', model: id}]})) }, id === 'session-a' ? 40 : 0)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port
try {
  globalThis.fetch = (url, init) => originalFetch(origin + url, init)
  await test('catalog queries retain the panel session after navigation', async () => {
    const client = createModelsController({panelOrCurrentSessionId: () => 'session-b'})
    const result = await client.loadModelCatalog(true, 'session-a')
    assert.equal(result.current.model, 'session-a')
    assert.equal(result.sessionId, 'session-a')
  })
  await test('a slow catalog cannot overwrite a newer session catalog', async () => {
    const client = createModelsController({panelOrCurrentSessionId: () => 'session-a'})
    const [a, b] = await Promise.all([client.loadModelCatalog(true, 'session-a'), client.loadModelCatalog(true, 'session-b')])
    assert.equal(a.current.model, 'session-a')
    assert.equal(b.current.model, 'session-b')
    assert.equal(client.modelCatalog.current.model, 'session-b')
    assert.equal((await client.loadModelCatalog(false, 'session-b')).current.model, 'session-b')
  })
} finally {
  globalThis.fetch = originalFetch
  server.closeAllConnections()
  await new Promise(done => server.close(done))
}
await test('legacy follow-up overrides cannot change the shared model', () => {
  const config = resolveConfig({provider: 'shared', model: 'chosen', chatProvider: 'legacy', chatModel: 'wrong'})
  const ctx = {get: () => undefined, on: () => () => {}}
  const models = createModels(ctx, config)
  assert.deepEqual(models.resolveRoute(undefined, null, true), {provider: 'shared', model: 'chosen'})
  config.provider = ''; config.model = ''
  assert.deepEqual(models.resolveRoute(undefined, {provider: 'session', model: 'current'}, true), {provider: 'session', model: 'current'})
})
await test('first and second round payloads use the selected model', () => {
  const oldDocument = globalThis.document, oldLocation = globalThis.location
  globalThis.document = {title: 'test'}; globalThis.location = {href: 'http://local'}
  try {
    const client = createPanelController({state: {modelChoice: {provider: 'shared', model: 'chosen'}, effort: 'max'}, panelSessionId: 'session'})
    for (const stage of ['translation', 'detail']) {
      const body = client.buildPayload('text', 'context', 'label', false, stage)
      assert.equal(body.provider, 'shared'); assert.equal(body.model, 'chosen'); assert.equal(body.effort, undefined)
    }
  } finally { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation }
})
function settingsClient(send) {
  globalThis.fetch = send
  const state = {}, note = {textContent: ''}
  const client = createSettingsController({state, settingsNote: {setAttribute() {}}, settingsNoteText: note,
    modelCatalog: {items: [], error: ''}, catalogItemOf() {}, paintModelPill() {}, scheduleBridgeScan() {}, schedulePillIdle() {}, pill: {style: {}}, placePill() {}})
  client.settingsSpec = {}; client.settingsLive = {provider: 'p', model: 'old'}
  return {edit: model => client.chooseSharedModel({provider: 'p', model}), reset: client.resetSettings,
    snapshot: () => ({live: {...client.settingsLive}, choice: state.modelChoice, note: note.textContent})}
}
try {
  await test('a slow save preserves and subsequently saves a newer choice', async () => {
    let finish; const requests = []
    const client = settingsClient((url, init) => { const body = JSON.parse(init.body); requests.push(body); return new Promise(done => { finish = done }) })
    client.edit('first'); await waitFor(() => requests.length === 1)
    const firstFinish = finish
    client.edit('second'); firstFinish({json: async () => ({ok: true, values: {provider: 'p', model: 'first'}})})
    await waitFor(() => requests.length === 2)
    assert.equal(client.snapshot().live.model, 'second'); assert.equal(client.snapshot().choice.model, 'second')
    assert.equal(requests[1].values.model, 'second')
    finish({json: async () => ({ok: true, values: {provider: 'p', model: 'second'}})})
    await waitFor(() => client.snapshot().note === '改动会自动保存')
  })
  for (const [input, normalized] of [['changed', 'changed'], [' padded ', 'padded']]) {
    await test(`reset waits for an active save and clears ${input}`, async () => {
      let finish; const requests = []
      const client = settingsClient((url, init) => {
        const body = JSON.parse(init.body); requests.push(body)
        return body.reset ? Promise.resolve({json: async () => ({ok: true, values: {provider: '', model: ''}})}) : new Promise(done => {finish = done})
      })
      client.edit(input); await waitFor(() => requests.length === 1); client.reset()
      await Promise.resolve(); assert.equal(requests.length, 1)
      finish({json: async () => ({ok: true, values: {provider: 'p', model: normalized}})})
      await waitFor(() => requests.length === 2 && client.snapshot().live.model === '')
      assert.equal(requests[1].reset, true); assert.equal(client.snapshot().choice, null)
      await new Promise(done => setTimeout(done, 450)); assert.equal(requests.length, 2)
    })
  }
} finally {globalThis.fetch = originalFetch}
