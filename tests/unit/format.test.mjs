/** Validate the messages actually written by promotion, including turn coordinates. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPromote } from '../../lib/host/promote.js'
import { resolveConfig } from '../../lib/host/config.js'

const events = [], prompts = [], created = [], attached = []
let liveEnabled = true
const services = {
  sessions: {get: () => liveEnabled ? {append: (type, data, options) => events.push({type, data, options})} : undefined},
  workspaceRegistry: {resolveByPath: async () => ({id: 'workspace'}), get: () => ({sessionIds: [], attachSession: async id => attached.push(id)})},
  sessionController: {create: async options => {created.push(options); return {sessionId: 'promoted'}}, rename: async () => {}, prompt: async request => prompts.push(request)},
}
const {handlePromote} = createPromote({get: name => services[name]}, resolveConfig({}), {resolveSessionCwd: async () => '/fixture/project'}, {clampText: (value, max) => typeof value === 'string' ? value.slice(0, max) : ''})
const server = createServer((req, res) => {Promise.resolve(handlePromote(req, res)).catch(error => {res.writeHead(500); res.end(String(error))})})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port
const payload = {text: 'selected text', context: 'surrounding text', label: 'Source', sessionId: 'source', translation: 'translation', detail: 'detail', turns: [{role: 'user', text: 'question'}, {role: 'assistant', text: 'answer'}]}
const promote = body => fetch(origin, {method: 'POST', body: JSON.stringify(body)}).then(res => res.json())
try {
  assert.equal((await promote(payload)).mode, 'history')
  assert.deepEqual(created[0], {workspaceId: 'workspace'})
  assert.deepEqual(attached, ['promoted'])
  assert.deepEqual(events.map(event => event.type), ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
  const context = events.find(event => event.type === 'user/message').data
  assert.equal(context.source.kind, 'plugin:@yfwu2020/dsh-selection-explain')
  assert.equal(context.source.form, 'snapshot')
  assert.equal(context.source.sections[0].text, 'selected text')
  assert.equal(context.content[0].text.includes('surrounding text'), true)
  assert.equal(events[0].data.turn, 1001)
  assert.equal(events[5].data.reason.kind, 'completed')
  assert.equal(events[8].data.source.kind, 'user')
  assert.equal(events[9].data.message.content[0].text, 'answer')
  assert.equal(prompts[0].sessionId, 'promoted')
  liveEnabled = false
  assert.equal((await promote(payload)).mode, 'packed')
  assert.equal(prompts[1].content[0].text.includes('question'), true)
  assert.equal((await promote({})).error, '缺少 text（选中文字）')
  console.log('PASS promotion writes compatible snapshot, turn/step history and packed fallback')
} finally {server.closeAllConnections(); await new Promise(done => server.close(done))}
