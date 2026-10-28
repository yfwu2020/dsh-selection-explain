/** Direct factory contract tests: no real DSH services, model calls, network, or user state. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createAnalyze } from '../../lib/host/analyze.js'
import { CONFIG_DEFAULTS } from '../../lib/config-values.js'
import { shotPromptFor, shotTitlePromptFor } from '../../lib/prompts.js'

const route = { provider: 'fixture', model: 'fixture' }
const base = { text: 'selected', context: 'nearby', sessionId: 'session' }
const image = id => ({ kind: 'image', ref: { attachmentId: 'sha256:' + id, name: id + '.png', width: 120, height: 86 } })
const texts = messages => messages.flatMap(m => m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
const images = messages => messages.flatMap(m => m.content || []).filter(b => b.type === 'image').map(b => b.attachment.attachmentId)
const stop = { type: 'finish', reason: { kind: 'stop' } }
const failure = (message, code) => ({ type: 'finish', reason: { kind: 'error', failure: { message, code } } })
const tool = (name, args = {}) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

function fixture(options = {}) {
  const calls = [], executions = [], operations = [], noOff = [], leaky = [], scopes = []
  const config = { ...CONFIG_DEFAULTS, tools: false, sessionContext: false, resultCacheTtlMs: 0, maxRequestsPerMinute: 600, ...options.config }
  const model = {
    leakyOnOff: new Set(options.leaky || []), noOffRoutes: new Set(options.noOff || []),
    resolveRoute: (override, session, chat) => { operations.push(['route', override, session, chat]); return options.route === null ? null : route },
    loadLeaky: async () => { operations.push(['load-effort']) },
    effortForRoute: (_, effort) => options.effortMap?.[effort] ?? effort,
    nextEffortFor: (_, rejected, tried) => ['low', 'high', 'max', 'off'].find(e => e !== rejected && !tried.has(e)) || '',
    markNoOff: key => noOff.push(key), markLeaky: key => leaky.push(key),
  }
  const sessions = {
    sessionModelOf: async id => { operations.push(['session-model', id]); return route },
    loadSessionBackground: async (id, settings) => { operations.push(['background', id, settings]); return { transcript: '用户：稳定背景', marked: true } },
    resolveSessionCwd: async () => '/project',
  }
  const services = {
    tools: { schemas: scope => { scopes.push(scope); return options.schemas || [] }, execute: async input => { executions.push(input); return { content: [{ type: 'text', text: 'found: https://example.test/source' }] } } },
    agents: { get: () => options.agent, list: () => options.fallbackAgent ? [options.fallbackAgent] : [] },
    attachments: { fileHostPath: ref => '/attachments/' + ref.attachmentId },
  }
  const ctx = {
    get: key => services[key], logger: { warn() {} },
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow: 64000 } }),
      async *stream(input) {
        calls.push(input)
        if (options.stream) { yield* options.stream(input, calls.length); return }
        const script = options.rounds?.[calls.length - 1] || [{ type: 'text-delta', text: '回答。' }, stop]
        for (const chunk of script) yield chunk
      },
    },
  }
  const historyStore = { clampText: (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '', readMessage: async () => null }
  const { handleAnalyze } = createAnalyze(ctx, config, model, sessions, historyStore)
  function request(body = base, init = {}) {
    const req = Readable.from([Buffer.from(init.raw ?? JSON.stringify(body))])
    req.method = init.method || 'POST'
    const res = new EventEmitter()
    res.writableEnded = false
    res.raw = ''
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
    res.write = text => { res.raw += text; init.onWrite?.(text, res); return true }
    res.end = text => { if (text) res.raw += text; res.writableEnded = true; res.emit('close') }
    const pending = handleAnalyze(req, res).then(() => ({ status: res.status, headers: res.headers, raw: res.raw,
      events: res.raw.startsWith('data: ') ? res.raw.split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6))) : [] }))
    init.onResponse?.(res)
    return pending
  }
  return { request, calls, executions, operations, noOff, leaky, scopes, config }
}

test('analyze validates HTTP inputs before model resolution, preserving JSON status and text', async () => {
  for (const [body, init, status, error] of [
    [base, { method: 'GET' }, 405, '只支持 POST'],
    [{ text: '  ' }, {}, 400, '缺少 text（选中文字）'],
    [{ text: '12345' }, {}, 413, '选中文字过长（5 > 4 字符）'],
  ]) {
    const f = fixture({ config: { maxSelectionChars: 4 } })
    const result = await f.request(body, init)
    assert.equal(result.status, status)
    assert.deepEqual(JSON.parse(result.raw), { error })
    assert.equal(f.calls.length, 0)
    assert.equal(f.operations.length, 0)
  }
  const malformed = await fixture().request(base, { raw: '{' })
  assert.equal(malformed.status, 400)
  assert.match(JSON.parse(malformed.raw).error, /^请求体解析失败：/)
  const missingRoute = await fixture({ route: null }).request()
  assert.equal(missingRoute.status, 503)
  const mismatch = await fixture().request({ ...base, question: '继续', historyStart: 2 })
  assert.equal(mismatch.status, 409)
  assert.match(JSON.parse(mismatch.raw).error, /记忆进度/)
})

test('rate limiting and cached SSE replay keep their order and original event fields', async () => {
  const f = fixture({ config: { resultCacheTtlMs: 60000, maxRequestsPerMinute: 2 } })
  const first = await f.request()
  assert.deepEqual(first.events.map(e => e.type), ['start', 'delta', 'done'])
  const cached = await f.request()
  assert.deepEqual(cached.headers, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  assert.deepEqual(cached.events, [
    { type: 'start', ...route, cached: true, context: { chars: 6, label: '', session: null } },
    { type: 'delta', text: '回答。' }, { type: 'done', chars: 3, cached: true },
  ])
  assert.equal(f.calls.length, 1)
  assert.equal((await f.request()).status, 429)
})

test('stage effort defaults, stable background prefix and omitted generation options survive preparation', async () => {
  const f = fixture({ config: { sessionContext: true, translationReasoningEffort: 'off', reasoningEffort: 'high', chatReasoningEffort: 'max' } })
  await f.request({ ...base, effort: 'low', debug: true })
  assert.equal(f.calls[0].reasoningEffort, 'off')
  assert.equal(f.calls[0].sessionId, 'session')
  assert.equal('temperature' in f.calls[0], false)
  assert.equal('maxTokens' in f.calls[0], false)
  assert.ok(texts(f.calls[0].messages.filter(m => m.role === 'user')).indexOf('稳定背景') < texts(f.calls[0].messages.filter(m => m.role === 'user')).indexOf('【选中文字】'))
  await f.request({ ...base, stage: 'detail', effort: 'low' })
  assert.equal(f.calls[1].reasoningEffort, 'low')
  const chat = await f.request({ ...base, question: '追问', effort: 'high' })
  assert.equal(f.calls[2].reasoningEffort, 'high')
  assert.deepEqual(chat.events.map(e => e.type), ['start', 'context-state', 'delta', 'done'])
  assert.deepEqual(f.operations.filter(e => e[0] === 'background').map(e => e[2].maxMessages), [f.config.sessionContextFastMessages, f.config.sessionContextMaxMessages, f.config.sessionContextMaxMessages])
})

test('history attachment recovery precedes effort retry and retains current images', async () => {
  const f = fixture({ rounds: [[failure('attachment not found', 'attachment-not-found')]] })
  const result = await f.request({ ...base, question: '看图', effort: 'off', history: [{ role: 'user', text: '旧图', attachments: [image('old')] }], attachments: [image('current')] })
  assert.deepEqual(result.events.filter(e => e.type === 'notice').map(e => e.code), ['attachments-dropped'])
  assert.deepEqual(f.calls.map(c => c.reasoningEffort), ['off', 'off'])
  assert.deepEqual(images(f.calls[0].messages), ['sha256:old', 'sha256:current'])
  assert.deepEqual(images(f.calls[1].messages), ['sha256:current'])
  assert.ok(result.events.some(e => e.type === 'done'))
})

test('mapped off effort rejection retries with an explicit new tier and records the route', async () => {
  const f = fixture({ effortMap: { off: 'minimal' }, rounds: [[failure('Reasoning is mandatory and cannot be disabled')]] })
  const result = await f.request({ ...base, question: '继续', effort: 'off' })
  assert.deepEqual(f.calls.map(c => c.reasoningEffort), ['minimal', 'low'])
  const notice = result.events.find(e => e.type === 'notice')
  assert.equal(notice.code, 'effort-rejected')
  assert.equal(notice.tier, 'minimal')
  assert.deepEqual(f.noOff, ['fixture/fixture'])
  assert.equal(result.events.some(e => e.type === 'error'), false)
})

test('partial output errors are surfaced without retry, done, or successful cache storage', async () => {
  const f = fixture({ config: { resultCacheTtlMs: 60000 }, rounds: [[{ type: 'text-delta', text: '半句' }, failure('upstream failed', 'failure')]] })
  const result = await f.request()
  assert.deepEqual(result.events.map(e => e.type), ['start', 'delta', 'error'])
  assert.equal(f.calls.length, 1)
  await f.request()
  assert.equal(f.calls.length, 2)
})

test('session fallback scope, narration withdrawal, filesystem boundary and tool result ordering are preserved', async () => {
  const agent = { id: 'fallback' }
  const f = fixture({ fallbackAgent: agent, config: { tools: true, toolNames: 'read', maxToolRounds: 1 },
    schemas: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    rounds: [[{ type: 'text-delta', text: '先看看' }, ...tool('read', { file_path: '/outside/private' })]] })
  const result = await f.request({ ...base, question: '读取文件' })
  assert.equal(result.events[0].toolScope, 'fallback')
  assert.equal(f.scopes[0], agent)
  assert.deepEqual(result.events.map(e => e.type), ['start', 'context-state', 'delta', 'drop', 'tool', 'tool', 'delta', 'done'])
  assert.equal(result.events.find(e => e.type === 'tool' && e.phase === 'done').ok, false)
  assert.equal(f.executions.length, 0)
  assert.ok(f.calls[1].messages.some(m => m.content?.some(b => b.type === 'tool-result')))
  assert.ok(f.calls[1].tools.some(t => t.name === 'read'))
})

test('conclusion retry keeps the original question and uses existing tool results', async () => {
  const f = fixture({ config: { tools: true, toolNames: 'read', maxToolRounds: 1 },
    schemas: [{ name: 'read', description: 'read', parameters: { type: 'object' } }], rounds: [tool('read', { file_path: '/project/a' }), tool('read')] })
  const result = await f.request({ ...base, question: '用户指定的具体问题' })
  assert.deepEqual(result.events.filter(e => e.type === 'notice').map(e => e.code), ['conclusion-retry'])
  assert.match(texts(f.calls[2].messages), /用户指定的具体问题/)
  assert.match(texts(f.calls[2].messages), /found: https:\/\/example.test\/source/)
  assert.equal(f.executions.length, 1)
  assert.equal(result.events.at(-1).conclusion.rounds, 1)
})

test('screenshot title requests keep image-first question prefix and disable tool execution', async () => {
  const f = fixture({ config: { tools: true, toolNames: 'read', maxToolRounds: 2 },
    schemas: [{ name: 'read', description: 'read', parameters: { type: 'object' } }], rounds: [tool('read')] })
  await f.request({ ...base, kind: 'shot', text: '图里是什么', shotScope: 'invalid', titleOnly: true, attachments: [image('shot')] })
  assert.equal(f.calls.length, 1)
  const [, opening, title] = f.calls[0].messages
  assert.deepEqual(opening.content.map(b => b.type), ['image', 'text'])
  assert.equal(opening.content[1].text, '图里是什么')
  assert.equal(title.content[0].text, shotTitlePromptFor('window', true))
  assert.ok(f.calls[0].messages[0].content[0].text.startsWith(shotPromptFor('window', true)))
  assert.equal(f.executions.length, 0)
})

test('client disconnect and timeout abort the same upstream signal and terminate SSE without done', async () => {
  for (const mode of ['disconnect', 'timeout']) {
    let response, sawAbort = false
    const f = fixture({ config: { timeoutMs: mode === 'timeout' ? 5 : 1000 }, stream: async function* (input) {
      if (mode === 'disconnect') response.emit('close')
      await new Promise(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', resolve, { once: true }) })
      sawAbort = input.signal.aborted
      throw Object.assign(Error('aborted'), { name: 'AbortError' })
    } })
    const result = await f.request(base, { onResponse: res => { response = res } })
    assert.equal(sawAbort, true, mode)
    assert.deepEqual(result.events.map(e => e.type), ['start', 'error'])
    assert.equal(result.events[1].message, `调用超时或已取消（${f.config.timeoutMs}ms）`)
  }
})
