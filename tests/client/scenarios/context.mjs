import { contextSource, historyDigest } from '../../../lib/chat-context.js'

export async function run(env) {
  const text = 'context-state-probe', context = 'stable context'
  const turns = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'original-message-' + i }))
  const image = { kind: 'image', ref: { attachmentId: 'sha256:context-image', name: 'old.png', bytes: 1000 } }
  turns[0].attachments = [image]
  await env.browserFetch('/selection-explain/api/history', { method: 'POST', body: JSON.stringify({ key: text + '\u0000' + context,
    text, context, parts: { translation: 'translation', detail: '' }, turns }) })
  env.hook.forget()
  env.hook.open(text, context, 'Context')
  for (let i = 0; i < 80 && env.hook.turns().length !== 40; i++) await env.sleep(20)
  // ask() 是异步的（要先等附件上传/引用解析，然后才 push question/answer 两条轮次），
  // 所以"问完立刻就是 streaming"不成立：先等这一轮真的开始，再等它结束。
  // 只等"没有 streaming"会在开头 0ms 就退出，把下一条提问撞进"还在生成"的拒绝分支。
  const waitAsk = async () => {
    for (let i = 0; i < 100 && !env.hook.turns().some(t => t.streaming); i++) await env.sleep(10)
    for (let i = 0; i < 150 && (env.hook.turns().some(t => t.streaming) || env.hook.state().asking); i++) await env.sleep(20)
  }
  env.hook.ask('保持完整历史')
  await waitAsk()
  const first = env.sent.at(-1)
  env.assert('客户端不再截取最近20条，完整发送未压缩原文', first.history.length === 40 && first.history[0].text === 'original-message-0')
  const state = { version: 1, sessionId: first.sessionId, source: contextSource(first.sessionId, first.text.trim(), first.context, first.initialExplanation),
    through: 20, digest: historyDigest(first.history.slice(0, 20)), summary: '已确认使用甲方案；旧图片按引用读取。', background: null }
  globalThis.__askExtra = { contextState: state, materialRestored: image }
  env.hook.ask('查看早期图片')
  await waitAsk()
  globalThis.__askExtra = null
  env.assert('取回的旧图片跟随本轮用户消息保存', env.hook.turns().at(-2).attachments?.some(a => a.ref.attachmentId === image.ref.attachmentId))
  let saved
  for (let i = 0; i < 80; i++) {
    const result = await env.browserFetch('/selection-explain/api/history?key=' + encodeURIComponent(text + '\u0000' + context))
    saved = (await result.json()).entry
    if (saved?.contextState?.through === 20) break
    await env.sleep(20)
  }
  env.assert('压缩进度与完整原文一起落盘', saved?.contextState?.through === 20 && saved.turns[0].text === 'original-message-0')
  env.hook.close()
  env.hook.forget()
  globalThis.__sessionStubId = 'different-main-session'
  env.hook.open(text, context, 'Context')
  for (let i = 0; i < 80 && env.hook.turns().length !== 44; i++) await env.sleep(20)
  env.hook.ask('重开后继续')
  await waitAsk()
  const next = env.sent.at(-1)
  env.assert('重开后只整理和发送压缩边界以后的原文', next.historyStart === 20 && next.history.length === 24 && next.history[0].text === 'original-message-20', JSON.stringify({start:next.historyStart,length:next.history.length}))
  env.assert('跨主会话重开仍绑定原会话，不更换冻结背景', next.sessionId === first.sessionId, String(next.sessionId))
  globalThis.__sessionStubId = null
  env.assert('重开后沿用同一份摘要和完整附件索引', next.contextState?.summary === state.summary && next.materials.some(a => a.ref.attachmentId === image.ref.attachmentId))
  const oversized = '超量原文'.repeat(1500)
  globalThis.__askExtra = { rejectContext: true }
  env.hook.ask(oversized)
  await waitAsk()
  globalThis.__askExtra = null
  env.assert('被拒绝的超量提问仍保留在界面原文中', env.hook.turns().at(-2).text === oversized && env.hook.turns().at(-2).contextExcluded === true)
  env.hook.ask('改为一个短问题')
  await waitAsk()
  const recovered = env.sent.at(-1)
  env.assert('容量拒绝后可继续聊天，后续请求不重复携带超量原文', recovered.history.every(t => !t.text.includes(oversized)) && recovered.question === '改为一个短问题')
  const transportOversized = '传输限制'.repeat(60000)
  const beforeTransport = env.sent.length
  env.hook.ask(transportOversized)
  await waitAsk()
  env.assert('超过请求体护栏的原文在本地明确拒绝并保留，不发送失控请求', env.sent.length === beforeTransport && env.hook.turns().at(-2).text === transportOversized && env.hook.turns().at(-2).contextExcluded === true)
  env.hook.ask('大请求之后仍能继续')
  await waitAsk()
  env.assert('请求体拒绝不会锁住下一轮短问题', env.sent.at(-1).question === '大请求之后仍能继续' && env.sent.at(-1).history.every(t => !t.text.includes(transportOversized)))
  env.hook.close()
}
