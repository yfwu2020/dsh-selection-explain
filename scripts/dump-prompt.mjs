/**
 * 打印一次划词解读实际发给模型的提示词（system + user）与各段尺寸。
 *
 * 用法：
 *   node scripts/dump-prompt.mjs <sessionId> "<选中文字>" ["<上下文片段>"]
 *   node scripts/dump-prompt.mjs --no-session "<选中文字>"      # 不带会话背景
 *   node scripts/dump-prompt.mjs --all                          # 一次打出五种模式的系统提示词
 *   node scripts/dump-prompt.mjs --no-session "x" --stage=detail --kind=code --question="为什么？" 
 *   SEL_ORIGIN=http://127.0.0.1:3080 node scripts/dump-prompt.mjs ...
 *
 * 原理：host 支持诊断开关 debug:true —— SSE 的 start 事件里会带上 system / user 原文。
 */
const args = process.argv.slice(2)
const ORIGIN = process.env.SEL_ORIGIN || 'http://127.0.0.1:3080'

const noSession = args[0] === '--no-session'
const sessionId = noSession ? '' : args[0] || ''
const text = (noSession ? args[1] : args[1]) || 'the migration ran long'
const context =
  (noSession ? args[2] : args[2]) || 'PM：这周能发布吗？\nDev：【the migration ran long】，得顺延到周三。\nPM：那就周三，先冻结功能。'

const FULL = args.includes('--full') // --full：等完整回答，附带打印 token 用量与缓存命中
const STAGE = (args.find((a) => a.startsWith('--stage=')) || '').slice('--stage='.length)
const KIND = (args.find((a) => a.startsWith('--kind=')) || '').slice('--kind='.length)
const QUESTION = (args.find((a) => a.startsWith('--question=')) || '').slice('--question='.length)
const WEB = args.includes('--web') // --web：按"网页模式"发（host 会注入设计规范）

/** 发一次请求，只取 start 事件里的 system / user（debug:true 才有）。 */
async function fetchPrompt(payload) {
  const response = await fetch(`${ORIGIN}/selection-explain/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '对话消息', ...(sessionId ? { sessionId } : {}), debug: true, ...payload }),
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const line = block.trim()
      if (!line.startsWith('data:')) continue
      let message
      try {
        message = JSON.parse(line.slice(5).trim())
      } catch {
        continue
      }
      if (message.type === 'start') {
        // 关掉流：我们只要提示词，不要它生成完（省时省钱）
        try {
          await reader.cancel()
        } catch (error) {
          /* noop */
        }
        return message
      }
    }
  }
  return null
}

// --all：把四种模式（翻译/解读、代码注释、详解、追问）的系统提示词一次性打出来
if (args.includes('--all')) {
  const modes = [
    { title: '① 翻译（选中含英文）', payload: { text: 'the migration ran long', context, stage: 'translation' } },
    { title: '② 解读（选中纯中文）', payload: { text: '先对齐一下，我们再闭环', context: '评审会上他说"先对齐一下，我们再闭环"。', stage: 'translation' } },
    { title: '③ 注释（选中代码）', payload: { text: 'const a = 1\nfunction f() { return a }', context: '代码片段。', kind: 'code', stage: 'translation' } },
    { title: '④ 详解（点展开详解）', payload: { text: 'the migration ran long', context, stage: 'detail' } },
    { title: '⑤ 追问（小窗对话）', payload: { text: 'the migration ran long', context, question: '为什么会这样？', history: [{ role: 'assistant', text: '## 翻译\n迁移跑久了。' }] } },
    { title: '⑥ 追问 + 网页模式（注入 skills/web-design/SKILL.md）', payload: { text: 'the migration ran long', context, question: '为什么？给我一页对比', webAnswer: true, history: [{ role: 'assistant', text: '## 翻译\n迁移跑久了。' }] } },
  ]
  for (const mode of modes) {
    const start = await fetchPrompt(mode.payload)
    console.log(`\n${'='.repeat(78)}\n### ${mode.title}\n${'='.repeat(78)}`)
    if (!start) {
      console.log('(没拿到 start 事件)')
      continue
    }
    console.log(`[system ${start.debug?.sizes?.system ?? '?'} 字 / user ${start.debug?.sizes?.user ?? '?'} 字]  tools=${JSON.stringify(start.tools || [])} effort=${start.effort}`)
    console.log('\n----- SYSTEM -----\n' + (start.debug?.system || '(未返回)'))
    console.log('\n----- USER（第一段的开头）-----\n' + String(start.debug?.user || '').slice(0, 600))
  }
  process.exit(0)
}

const response = await fetch(`${ORIGIN}/selection-explain/api/analyze`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    text,
    context,
    label: '对话消息',
    ...(sessionId ? { sessionId } : {}),
    ...(STAGE ? { stage: STAGE } : {}),
    ...(KIND ? { kind: KIND } : {}),
    ...(QUESTION ? { question: QUESTION, history: [{ role: 'assistant', text: '（上一轮）' }] } : {}),
    ...(WEB ? { webAnswer: true } : {}),
    debug: true,
  }),
})

const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
let printed = false
while (!printed) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  let index
  while ((index = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, index)
    buffer = buffer.slice(index + 2)
    const line = block.trim()
    if (!line.startsWith('data:')) continue
    let message
    try {
      message = JSON.parse(line.slice(5).trim())
    } catch {
      continue
    }
    if (message.type !== 'start') continue
    const sizes = message.debug?.sizes || {}
    console.log('=== 尺寸（字符）===')
    console.log(`system ${sizes.system} | user ${sizes.user} | 局部片段 ${message.context.chars} | 会话背景 ${message.context.session ? message.context.session.chars : 0}${message.context.session ? '（标记命中=' + message.context.session.marked + '）' : ''}`)
    console.log('\n=== SYSTEM ===\n' + (message.debug?.system || '(未返回)'))
    console.log('\n=== USER（实际注入的上下文）===\n' + (message.debug?.user || '(未返回)'))
    printed = true
    if (!FULL) break
  }
  if (FULL) {
    const line = buffer.trim()
    void line
  }
}
reader.cancel().catch(() => {})
if (!printed) console.error('未取到 start 事件（服务是否在跑？地址：' + ORIGIN + '）')
