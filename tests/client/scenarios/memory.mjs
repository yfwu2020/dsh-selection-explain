export async function run(env) {
  const text = 'memory-window-probe'
  const context = 'memory-window-context'
  const turns = Array.from({ length: 100 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: 'memory-message-' + i,
  }))
  turns[99].text = '```html\n<!doctype html><html><body>recent preview</body></html>\n```'
  await env.browserFetch('/selection-explain/api/history', {
    method: 'POST',
    body: JSON.stringify({ key: text + '\u0000' + context, text, context, label: '内存测试',
      parts: { translation: 'kept translation', detail: '' }, turns }),
  })
  env.hook.forget()
  env.hook.open(text, context, '内存测试')
  for (let i = 0; i < 80 && env.hook.turns().length !== 100; i++) await env.sleep(20)
  const bubbles = () => Array.from(env.chatLog.children).filter(node => String(node.className).includes('dsh-sel-bubble'))
  env.assert('长对话首次仅渲染最近 40 条气泡', bubbles().length === 40, String(bubbles().length))
  env.assert('渲染窗口不截断完整对话数据', env.hook.turns().length === 100, String(env.hook.turns().length))
  env.assert('初始窗口包含最近消息、不渲染最早消息', !env.textOf(env.chatLog).includes('memory-message-0') && env.textOf(env.chatLog).includes('memory-message-98'))
  const more = Array.from(env.chatLog.children).find(node => node.getAttribute('data-history-more') === '1')
  env.assert('更早的消息仍可按需展开', !!more)
  if (more) more.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  env.assert('展开后增加 40 条气泡且完整数据不变', bubbles().length === 80 && env.hook.turns().length === 100, String(bubbles().length))
  const before = env.sent.length
  env.hook.close()
  env.assert('收起后释放消息气泡和预览节点', env.chatLog.children.length === 0 && env.hook.memory().previewFrames === 0)
  env.assert('收起后仍保留对话文字', env.hook.turns().length === 100)
  env.hook.pill().dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await env.sleep(30)
  env.assert('重开从文字恢复最近气泡，无须重新调用模型', bubbles().length === 40 && env.sent.length === before, String(bubbles().length))
  const quoted = '长引用'.repeat(1500) + '必须保留的末尾'
  env.hook.quote(quoted, '原文快照')
  env.assert('超过3000字符的引用保留完整原文', env.hook.quotes().at(-1).text === quoted)
  env.assert('发给模型的引用包含原文末尾', env.hook.compose(null, '核对原文').includes('必须保留的末尾'))
  env.hook.close()
}
