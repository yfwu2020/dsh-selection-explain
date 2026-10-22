import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { apply } from '../../lib/index.js'
import { contextSource, historyDigest } from '../../lib/chat-context.js'

async function fixture(config = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-context-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  await mkdir(join(home, 'objects'))
  const routes = new Map(), calls = [], executions = []
  let transcript = '固定的最初背景', retrieval = null, failSummary = false, forceConclusion = false, summaryFinish = 'stop'
  const llm = {
    listProviders: () => [{ id: 'fixture', name: 'Fixture' }], listModels: async () => [],
    resolveModelInfo: async () => ({ context: { contextWindow: 64000 }, defaultMaxTokens: 4000 }),
    imageRequestPricing: () => ({ priceImages: images => images.map(() => ({ visualTokens: 300, text: '' })) }),
    async *stream(options) {
      calls.push(options)
      const system = textOf(options.messages.filter(m => m.role === 'system'))
      if (system.includes('上下文压缩器')) {
        if (failSummary) { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'summary unavailable' } } }; return }
        yield { type: 'text-delta', text: '用户要求：始终保留甲方案的命名；尚未确认乙方案。历史图像细节需重新读取。' }
      } else if (forceConclusion && !textOf(options.messages).includes('【补充结论】')) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'material-1', name: 'selection_material', arguments: JSON.stringify(retrieval) } }
      } else if (!textOf(options.messages).includes('【补充结论】') && retrieval && !options.messages.some(m => m.role === 'tool' || m.content?.some(b => b.type === 'tool-result'))) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'material-1', name: 'selection_material', arguments: JSON.stringify(retrieval) } }
      } else yield { type: 'text-delta', text: '完整回答。' }
      if (system.includes('上下文压缩器') && summaryFinish === 'missing') return
      yield { type: 'finish', reason: { kind: system.includes('上下文压缩器') ? summaryFinish : retrieval ? 'tool-calls' : 'stop' } }
    },
  }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    sessionQuery: { readSurface: async () => ({ events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: transcript }] } }] }), readSession: async () => ({ events: [] }) },
    attachments: { fileHostPath: ref => { if (!String(ref.attachmentId).startsWith('sha256:')) throw Error('bad ref'); return join(home, 'objects', ref.attachmentId.slice(7)) },
      imageHostPath: ref => { if (!String(ref.attachmentId).startsWith('sha256:')) throw Error('bad ref'); return join(home, 'objects', ref.attachmentId.slice(7)) } },
    tools: { schemas: () => [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }],
      execute: async input => { executions.push(input); return { content: [{ type: 'text', text: 'file content' }], isError: false } } },
    sessions: { get: () => ({ header: { cwd: '/fixture/project' } }) } }
  const disposers = []
  const ctx = { llm, get: key => services[key], on() { return () => {} }, effect(fn) { const off = fn(); if (typeof off === 'function') disposers.push(off); return off },
    logger: { info() {}, warn() {} }, webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } } }
  apply(ctx, { maxRequestsPerMinute: 600, ...config })
  const server = createServer((req, res) => { Promise.resolve(routes.get(new URL(req.url, 'http://localhost').pathname)?.(req, res)).catch(e => { if (!res.headersSent) res.writeHead(500); res.end(String(e)) }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  async function request(path, body) { const r = await fetch('http://127.0.0.1:' + server.address().port + '/selection-explain/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const raw = await r.text(); return { status: r.status, raw, events: raw.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))) } }
  return { calls, executions, request, summaryFinish: value => { summaryFinish = value }, forceConclusion: () => { forceConclusion = true }, asset: async id => writeFile(join(home, 'objects', id), 'stored material'), setTranscript: t => { transcript = t }, retrieve: r => { retrieval = r }, failSummary: () => { failSummary = true },
    close: async () => { disposers.reverse().forEach(fn => fn()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => setTimeout(resolve, 1000)); if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; await rm(home, { recursive: true, force: true }) } }
}
function blockText(blocks) { return (blocks || []).flatMap(b => b.type === 'text' ? [b.text] : b.type === 'tool-result' ? blockText(b.content) : []) }
function textOf(messages) { return messages.flatMap(m => blockText(m.content)).join('\n') }
const base = { text: 'selected', context: 'context', sessionId: 'session', question: '继续讨论', historyStart: 0 }
const turns = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '消息' + i }))
const image = id => ({ kind: 'image', ref: { attachmentId: 'sha256:' + id, name: id + '.png', bytes: 5 * 1024 * 1024, width: 800, height: 600 } })

test('HTTP chat retains thirty short messages and every admitted historical image', async () => {
  const f = await fixture({ tools: false })
  try {
    const history = turns(30)
    history[0].attachments = [image('a'), image('b'), image('c')]
    const r = await f.request('analyze', { ...base, history, attachments: [image('d')] })
    assert.equal(r.status, 200)
    const call = f.calls.at(-1)
    assert.ok(textOf(call.messages).includes('消息0'))
    assert.equal(call.messages.flatMap(m => m.content || []).filter(b => b.type === 'image').length, 4)
    const state = r.events.find(e => e.type === 'context-state')?.state
    assert.equal(state.through, 0)
    f.setTranscript('后来变化的主会话背景')
    const next = await f.request('analyze', { ...base, history, contextState: state })
    assert.ok(textOf(f.calls.at(-1).messages).includes('固定的最初背景'))
    assert.ok(!textOf(f.calls.at(-1).messages).includes('后来变化的主会话背景'))
    assert.ok(next.events.some(e => e.type === 'done'))
  } finally { await f.close() }
})

test('HTTP compaction advances only after success and reuses the checkpoint without another summary call', async () => {
  const f = await fixture({ tools: false, chatContextTokens: 4096 })
  try {
    const history = turns(30).map(t => ({ ...t, text: t.text + '文'.repeat(130) }))
    const r = await f.request('analyze', { ...base, history })
    const state = r.events.find(e => e.type === 'context-state')?.state
    assert.ok(state?.through > 0, r.raw)
    assert.equal(history[state.through].role, 'user')
    assert.ok(textOf(f.calls.at(-1).messages).includes('甲方案'))
    const summaries = f.calls.filter(c => textOf(c.messages.filter(m => m.role === 'system')).includes('上下文压缩器')).length
    assert.ok(f.calls.filter(c => textOf(c.messages.filter(m => m.role === 'system')).includes('上下文压缩器')).every(c => c.sessionId === 'session'), '摘要调用应沿用原会话绑定')
    await f.request('analyze', { ...base, contextState: state, historyStart: state.through, history: history.slice(state.through) })
    assert.equal(f.calls.filter(c => textOf(c.messages.filter(m => m.role === 'system')).includes('上下文压缩器')).length, summaries)
  } finally { await f.close() }
})

test('summary failure is explicit and never advances the durable context checkpoint', async () => {
  const f = await fixture({ tools: false, chatContextTokens: 4096 })
  try {
    f.failSummary()
    const r = await f.request('analyze', { ...base, history: turns(30).map(t => ({ ...t, text: '文'.repeat(160) })) })
    assert.ok(r.events.some(e => e.type === 'error' && /压缩/.test(e.message)), r.raw)
    assert.ok(!r.events.some(e => e.type === 'context-state' && e.state.through > 0))
  } finally { await f.close() }
})

test('compressed old images can be restored from the attachment library without a new upload', async () => {
  const f = await fixture({ chatContextTokens: 4096, toolNames: 'read' })
  try {
    await f.asset('old')
    const history = turns(30).map(t => ({ ...t, text: t.text + '文'.repeat(100) }))
    history[0].attachments = [image('old')]
    const catalog = [{ ...image('old'), turn: 0 }]
    const first = await f.request('analyze', { ...base, history, materials: catalog })
    const state = first.events.find(e => e.type === 'context-state')?.state
    assert.ok(state?.through > 0, first.raw)
    f.retrieve({ attachmentId: 'sha256:old' })
    const r = await f.request('analyze', { ...base, key: 'saved', question: '第一张图左下角是什么', historyStart: state.through,
      history: history.slice(state.through), contextState: state, materials: catalog })
    assert.ok(r.events.some(e => e.type === 'material-restored' && e.attachment.ref.attachmentId === 'sha256:old'), r.raw)
    const imageBlocks = f.calls.at(-1).messages.flatMap(m => m.content || []).filter(b => b.type === 'image')
    assert.ok(imageBlocks.some(b => b.attachment.attachmentId === 'sha256:old'))
  } finally { await f.close() }
})

test('archived file references survive the former eight-file boundary and unknown IDs are refused', async () => {
  const f = await fixture({ toolNames: 'read' })
  try {
    await f.asset('file0')
    const catalog = Array.from({ length: 12 }, (_, i) => ({ kind: 'file', ref: { attachmentId: 'sha256:file' + i, name: 'same-name.pdf' }, turn: i }))
    const state = { version: 1, source: contextSource('session', 'selected', 'context', ''), through: 24, digest: '12345678', summary: '讨论过十二个文件版本。', background: null }
    f.retrieve({ attachmentId: 'sha256:file0' })
    const r = await f.request('analyze', { ...base, history: turns(2), historyStart: 24, contextState: state, materials: catalog })
    assert.ok(r.events.some(e => e.type === 'material-restored' && e.attachment.ref.attachmentId === 'sha256:file0'), r.raw)
    assert.ok(textOf(f.calls.at(-1).messages).includes('只读路径'))
    f.retrieve({ attachmentId: '/etc/passwd' })
    const refused = await f.request('analyze', { ...base, history: turns(2), materials: catalog })
    assert.ok(!refused.events.some(e => e.type === 'material-restored'))
    assert.ok(textOf(f.calls.at(-1).messages).includes('不在本小窗'))
  } finally { await f.close() }
})

test('saved original messages remain untruncated and can be paged after context compression', async () => {
  const f = await fixture({ toolNames: 'read', toolResultMaxChars: 500 })
  try {
    const original = '原'.repeat(21000) + '必须能找回的原文末尾'
    const history = [{ role: 'user', text: original }, ...turns(3)]
    const state = { version: 1, source: contextSource('session', 'selected', 'context', ''), through: 4, digest: historyDigest(history), summary: '较早原文已压缩，仍可按消息编号恢复。', background: null }
    await f.request('history', { key: 'raw-source', text: 'selected', context: 'context', parts: {}, turns: history, contextState: state })
    f.retrieve({ message: 1, offset: 20990, length: 100 })
    const r = await f.request('analyze', { ...base, key: 'raw-source', history: [], historyStart: 4, contextState: state })
    assert.ok(r.events.some(e => e.type === 'done'), r.raw)
    assert.ok(textOf(f.calls.at(-1).messages).includes('必须能找回的原文末尾'))
  } finally { await f.close() }
})

test('final conclusion fallback keeps restored images, current images and the earlier summary', async () => {
  const f = await fixture({ chatContextTokens: 8192, toolNames: 'read' })
  try {
    await f.asset('old')
    const state = { version: 1, source: contextSource('session', 'selected', 'context', ''), through: 2, digest: '12345678', summary: '用户限定：只比较左下角，不比较颜色。', background: null }
    f.retrieve({ attachmentId: 'sha256:old' })
    f.forceConclusion()
    const r = await f.request('analyze', { ...base, question: '旧图左下角和新图一样吗', contextState: state, historyStart: 2,
      history: [], materials: [{ ...image('old'), turn: 0 }], attachments: [image('new')] })
    const final = f.calls.at(-1)
    const ids = final.messages.flatMap(m => m.content || []).filter(b => b.type === 'image').map(b => b.attachment.attachmentId)
    assert.ok(ids.includes('sha256:old') && ids.includes('sha256:new'), JSON.stringify({ ids, events: r.events }))
    assert.ok(textOf(final.messages).includes('只比较左下角'))
    assert.ok(r.events.some(e => e.type === 'done' && e.conclusion?.tried), r.raw)
    assert.ok(r.events.some(e => e.type === 'delta' && e.text.includes('完整回答')), r.raw)
  } finally { await f.close() }
})


for (const reason of ['max-tokens', 'missing']) test(`an incomplete summary (${reason}) cannot advance the checkpoint`, async () => {
  const f = await fixture({ tools: false, chatContextTokens: 4096 })
  try {
    f.summaryFinish(reason)
    const r = await f.request('analyze', { ...base, history: turns(30).map(t => ({ ...t, text: '文'.repeat(160) })) })
    assert.ok(r.events.some(e => e.type === 'error' && /压缩/.test(e.message)), r.raw)
    assert.ok(!r.events.some(e => e.type === 'context-state' && e.state.through > 0))
  } finally { await f.close() }
})
