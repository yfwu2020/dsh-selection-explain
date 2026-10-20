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
  // 历史模式**一次模型调用都不该发**：历史已写成真实事件，来源写在上下文消息里，
  // 那句"请用一句话确认"只剩代价（白烧调用 + 顶部噪声 + 占掉 agent 的第 1 轮）。
  assert.equal(prompts.length, 0, '历史模式不该发开场 prompt')
  liveEnabled = false
  assert.equal((await promote(payload)).mode, 'packed')
  // 打包回退：这一次 prompt **就是背景本身**，不能少；它也是全程唯一的一次
  assert.equal(prompts.length, 1, '打包模式必须恰好发一次（背景载体）')
  assert.equal(prompts[0].sessionId, 'promoted')
  assert.equal(prompts[0].content[0].text.includes('question'), true)
  assert.equal(prompts[0].content[0].text.includes('【划词解读 · 升格为会话】'), true)

  // ── 附件：升格后那条消息里必须**真的有** image/file block（不能只在正文里说一句）──
  liveEnabled = true
  events.length = 0
  const imageRef = {attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', width: 810, height: 180, bytes: 46019, name: '截图.png'}
  const fileRef = {attachmentId: 'sha256:' + 'b'.repeat(64), name: '报表.pdf', bytes: 9035}
  assert.equal((await promote({
    ...payload,
    turns: [
      {role: 'user', text: '【本条消息带了附件】截图.png（图片）\n这个图片上是什么呀？', attachments: [{kind: 'image', ref: imageRef}]},
      {role: 'assistant', text: '是一只猫。'},
      {role: 'user', text: '【本条消息带了附件】报表.pdf（文件）\n报表里哪季掉得最多？', attachments: [{kind: 'file', ref: fileRef}]},
      {role: 'assistant', text: '第三季度。'},
    ],
  })).mode, 'history')
  const userMessages = events.filter(event => event.type === 'user/message').map(event => event.data)
  const withImage = userMessages[userMessages.length - 2]
  const withFile = userMessages[userMessages.length - 1]
  assert.deepEqual(withImage.content.map(block => block.type), ['image', 'text'], '附件在前、正文在后（与主会话/analyze 同序）')
  assert.equal(withImage.content[0].attachment.attachmentId, imageRef.attachmentId, '引用要原样过去（客户端据此画缩略图）')
  assert.equal(withImage.content[0].attachment.mediaType, 'image/png')
  assert.equal(withImage.content[0].attachment.width, 810)
  assert.equal(withFile.content[0].type, 'file')
  assert.equal(withFile.content[0].attachment.name, '报表.pdf')
  // 小窗那行标记要去掉 —— 附件真在了，留着就是重复且措辞不对
  assert.equal(withImage.content[1].text.includes('本条消息带了附件'), false, '升格文本里不该再有小窗的附件标记')
  assert.equal(withImage.content[1].text, '这个图片上是什么呀？', '只去掉那一行，正文一字不动')
  assert.equal(withFile.content[1].text, '报表里哪季掉得最多？')
  // 助手那条仍是纯文本（附件只属于用户轮）
  const assistantMessages = events.filter(event => event.type === 'assistant/message').map(event => event.data)
  assert.deepEqual(assistantMessages[assistantMessages.length - 1].message.content.map(block => block.type), ['text'])
  // 脏引用（形状不对）要被挡掉，不能写进会话事件
  events.length = 0
  await promote({
    ...payload,
    turns: [{role: 'user', text: 'x', attachments: [{kind: 'video', ref: {attachmentId: 'sha256:z'}}, {kind: 'image', ref: {}}]}],
  })
  const dirty = events.filter(event => event.type === 'user/message').map(event => event.data).pop()
  assert.deepEqual(dirty.content.map(block => block.type), ['text'], '认不出的附件一律不进事件')
  // 没有附件时，事件与从前逐字节一致（回归护栏）
  events.length = 0
  await promote(payload)
  const plain = events.filter(event => event.type === 'user/message').map(event => event.data).pop()
  assert.deepEqual(plain.content, [{type: 'text', text: 'question'}], '没有附件时 content 与从前完全一致')

  events.length = 0
  await promote({ ...payload, turns: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'original-turn-' + i })) })
  const fullHistory = JSON.stringify(events)
  assert.ok(fullHistory.includes('original-turn-0') && fullHistory.includes('original-turn-29'), '升格也应保留超过20条的完整原始对话')
  assert.equal((await promote({})).error, '缺少 text（选中文字）')
  console.log('PASS promotion writes compatible snapshot, turn/step history, attachment blocks and packed fallback')
} finally {server.closeAllConnections(); await new Promise(done => server.close(done))}
