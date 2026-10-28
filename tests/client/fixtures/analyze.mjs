/** Deterministic SSE responses used by the client interaction scenarios. */
export const PROSE_PROBE = 'the migration ran long, so we ship Wednesday'
export const PY_SNIPPET = ['def add(a, b):', '    # 这里是可以相加的数字', '    return a + b'].join('\n')


  /** 代码选区用例：真实的代码形状（会被 looksLikeCode 判成 code）。 */
export const CODE_SNIPPET = [
    'const MAX = 4000',
    'function clampText(text) {',
    '  return text.length > MAX ? text.slice(0, MAX) : text;',
    '}',
  ].join('\n')


  /** 渲染专项测试的固定模型输出（不经过真实 LLM，保证断言稳定）。 */
  const RENDER_FIXTURE = [
    '## 翻译',
    '- **slipped** /slɪpt/ 英 /slɪpt/ 美',
    '  - **v.** 滑落；滑倒（过去式）',
    '  - **adj.** 被延误的',
    '- **slipped**：滑落；滑倒',
    '- **slip**（动词）：滑倒；滑落',
    '  - 嵌套项：被延误、被错过',
    '1. 有序第一项',
    '2. 有序第二项',
    '',
    '### 小标题',
    '正文段落，含 **加粗** 与 `code`。',
    '',
    '> 在本句中：（期限）被错过、被推迟',
    '',
    '## 详解',
    '- **关键词**：在上下文里的具体所指（详见 [官方文档](https://example.com/docs)）',
    '| 说法 | 在此处的含义 |',
    '| --- | --- |',
    '| the migration | 发布前那次数据迁移 |',
    '| ran long | 耗时超出预期 |',
    '',
    '```',
    'npm run build',
    '```',
  ].join('\n')


  /**
   * 让 AbortSignal 真的生效：真实 fetch 被 abort 时会取消 body 流，
   * 而这里的手搓 Response 不会——不补这一层，"收起小窗 = 中止这一轮"就测不出来
   * （客户端的 read() 永远不 reject，请求会一路跑完）。
   */

export function respondAnalyze(body) {
    // 语音输入那一段的"把面板打开、翻译就绪"夹具（比 stage-probe 多一个 done 阶段）
    if (body && body.text === 'voice-probe') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n语音用例的翻译\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 8 })}

  `,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'stage-probe') {
      const only = body.stage === 'detail' ? '## 详解\nSTAGE-DETAIL' : '## 翻译\nSTAGE-TRANSLATION'
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: body.stage || 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: only })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: only.length })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 慢速流：start 立刻回，250ms 一个空 delta（触发重绘）、450ms 才吐内容
    // —— 用来验证"思考期不空窗"+"等待节点不被重绘打断"+"等待里走秒"
    if (body && body.text === 'slow-probe' && !body.question) {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation', effort: 'high' })}\n\n`),
          )
          await new Promise((r) => setTimeout(r, 250))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thought', text: '先判断这段英文在句子里的角色……' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '' })}\n\n`))
          await new Promise((r) => setTimeout(r, 650))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n慢速翻译结果\n' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 8 })}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 首轮夹具：给"摘要继承用例"用（用未知文本会走真实模型，首轮一直不结束 → 追问被拒）
    if (body && body.text === 'digest-probe' && !body.question) {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n摘要用例的翻译\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 8 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 结论轮提示：notice 先到、正文 350ms 后到 —— 用来验"提示在正文到达后消失"（附带的探针）
    if (body && body.question && body.text === 'notice-probe') {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'high' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'notice', code: 'conclusion-retry', text: '查询已完成，正在整理结论…' })}\n\n`))
          await new Promise((r) => setTimeout(r, 350))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '这是结论。' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 5 })}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'notice-probe' && !body.question) {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n提示用例的翻译\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done' })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 分三段、每段隔 60ms 的追问流：用来验证滚动跟随（贴底→跟随 / 翻上去→不拽回）
    // 追问等待特效用例：首字前静默 450ms，用来观察气泡里的等待动画与走秒
    if (body && body.question && body.text === 'wait-ask-probe') {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`))
          await new Promise((r) => setTimeout(r, 450))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '等到了回答。' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}

  `))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'wait-ask-probe' && !body.question) {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n等待用例的翻译\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done' })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.question && body.text === 'slow-ask-probe') {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`),
          )
          for (const piece of ['第一段回答。', '第二段回答。', '第三段回答。']) {
            await new Promise((r) => setTimeout(r, 60))
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: piece })}\n\n`))
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'slow-ask-probe' && !body.question) {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n滚动用例的翻译\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 8 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 分块流式的网页回答：一次 delta 一小段（真实模型就是这样，之前一次给完的用例盖不住）
    if (body && body.question === '分块网页追问') {
      const encoder = new TextEncoder()
      const page = '<!DOCTYPE html>\n<html><body><h1>分块渲染</h1><p>这段 HTML 被切成 6 段吐出来。</p></body></html>'
      const stream = new ReadableStream({
        async start(controller) {
          const send = (o) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`))
          send({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'high' })
          send({ type: 'delta', text: '给你一个页面：\n\n```html\n' })
          await new Promise((r) => setTimeout(r, 150))
          const step = Math.ceil(page.length / 5)
          for (let i = 0; i < page.length; i += step) {
            send({ type: 'delta', text: page.slice(i, i + step) })
            await new Promise((r) => setTimeout(r, 150))
          }
          send({ type: 'delta', text: '\n```\n' })
          send({ type: 'done', chars: page.length })
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 慢速追问：分三段、每段 700ms，留出"按停止"的窗口
    if (body && body.question === '慢速追问') {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          const send = (o) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`))
          send({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'high' })
          send({ type: 'delta', text: '第一段回答。' })
          await new Promise((r) => setTimeout(r, 700))
          send({ type: 'delta', text: '第二段回答。' })
          await new Promise((r) => setTimeout(r, 700))
          send({ type: 'delta', text: '第三段回答。' })
          send({ type: 'done', chars: 15 })
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 追问里的"过程旁白"：先吐英文盘算 → 调工具 → drop 撤回 → 再给中文结论
    if (body && body.question === '旁白追问') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'high', tools: ['web_search'] })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: 'Let me think about it and search again. ' })}\n\n`,
        `data: ${JSON.stringify({ type: 'tool', phase: 'start', callId: 'n2', name: 'web_search', detail: '今日新闻' })}\n\n`,
        `data: ${JSON.stringify({ type: 'tool', phase: 'done', callId: 'n2', name: 'web_search', detail: '今日新闻', ok: true, ms: 500, chars: 300, preview: 'x', urls: [] })}\n\n`,
        `data: ${JSON.stringify({ type: 'drop', chars: 37, text: 'Let me think about it and search again.' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '这是追问的正式回答。' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 10, toolCalls: 1 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 通用追问桩。注意排除 quote-wait-probe：它有自己的 500ms 慢速夹具（在下面），
    // 放在通配之前会把那个夹具整个遮掉，「流式中不给引用整条」那条用例就永远抓不到流式态。
    if (body && body.question && body.text !== 'quote-wait-probe') {
      // 追问失败注入（`globalThis.__askFailOnce = true`）：验"报错之后光标回不回到输入框"
      if (globalThis.__askFailOnce) {
        globalThis.__askFailOnce = false
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: 'no adapter registered for provider "p1"' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      const extra = globalThis.__askExtra || {}
      if (extra.rejectContext) return Promise.resolve(new Response(`data: ${JSON.stringify({ type: 'error', code: 'context-rejected', message: '当前引用超过容量' })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
      // noticeGapMs：在 notice 与正文之间留一段空档。
      // 验"过程提示在正文到达前看得见"必须有观察窗口 —— 一口气发完的话，
      // 提示会在同一批 SSE 里被 delta 立刻撤掉，轮询根本抓不到。
      if (extra.noticeGapMs) {
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`),
            )
            if (extra.notice) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'notice', ...extra.notice })}\n\n`))
            }
            await new Promise((r) => setTimeout(r, extra.noticeGapMs))
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: extra.delta || '这是对追问的回答：' + body.question })}\n\n`),
            )
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 12, toolCalls: 0 })}\n\n`))
            controller.close()
          },
        })
        return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
      }
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`,
        ...(extra.contextState ? [`data: ${JSON.stringify({ type: 'context-state', state: extra.contextState })}\n\n`] : []),
        ...(extra.materialRestored ? [`data: ${JSON.stringify({ type: 'material-restored', attachment: extra.materialRestored })}\n\n`] : []),
        ...(extra.notice && !extra.strip ? [`data: ${JSON.stringify({ type: 'notice', ...extra.notice })}\n\n`] : []),
        `data: ${JSON.stringify({ type: 'delta', text: extra.delta || '这是对追问的回答：' + body.question })}\n\n`,
        ...(extra.strip ? [`data: ${JSON.stringify({ type: 'strip', text: extra.strip })}\n\n`] : []),
        ...(extra.notice && extra.strip ? [`data: ${JSON.stringify({ type: 'notice', ...extra.notice })}\n\n`] : []),
        `data: ${JSON.stringify({ type: 'done', chars: 12, toolCalls: 0 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 工具正在跑的那段时间（流式）：用来验证"等待提示说在检索，但不泄露查询词/链接"
    // 中止用例：首字很快到，但整轮要 2.5s——留出"收起小窗"的窗口
    if (body && ['中止探测', '停止键专用探测词'].includes(body.text)) {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n中止用例的开头\n' })}\n\n`))
          await new Promise((r) => setTimeout(r, 2500))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 10 })}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 「发过追问后 CTA 收起 / 换选区后 CTA 复位」专用：首轮只给翻译，stage=detail 时给详解
    if (body && body.text === 'cta-reset-probe') {
      const only = body.stage === 'detail' ? '## 详解\nCTA 复位用例的详解\n' : '## 翻译\nCTA 复位用例的翻译\n'
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: body.stage === 'detail' ? 'detail' : 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: only })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: only.length })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 网页预览用例：先流一半（此时不该有 iframe），再补齐收尾
    if (body && body.text === 'html-probe') {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n给你一个页面：\n\n```html\n<!DOCTYPE html>\n<html><body><h1>Hello 预览</h1></body></html>\n' })}\n\n`))
          await new Promise((r) => setTimeout(r, 400))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '```\n\n```js\nconst a = 1\n```\n\n```\n<div>只是片段</div>\n```\n' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 120 })}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'tool-live-probe') {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', tools: ['web_search'] })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool', phase: 'start', callId: 'L1', name: 'web_search', detail: '检索中的查询词' })}\n\n`))
          await new Promise((r) => setTimeout(r, 500))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool', phase: 'done', callId: 'L1', name: 'web_search', detail: '检索中的查询词', ok: true, ms: 520, chars: 999, preview: '检索结果原文预览', urls: ['https://example.com/secret-source'] })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '## 解读\n模型消化后的结论\n' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 10, toolCalls: 1 })}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 档位提示用例：start 报了 effort=max，然后静默 6s+（没有思考流）→ 提示行必须写 max
    if (body && body.text === 'effort-hint-probe') {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', effort: 'max', stage: 'translation' })}\n\n`))
          // 提示行是"等过 6 秒"才写的，静默必须明显长于 6s，否则 done 会把它抢掉
          await new Promise((r) => setTimeout(r, 8500))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n档位提示用例\n' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 10 })}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 工具轮里的"过程旁白"：先流一段英文盘算 → 调工具 → 发 drop 撤回 → 再给中文结论
    if (body && body.text === 'narrate-probe') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', tools: ['web_search'] })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: 'I have sources but no content. Maybe I should search once more. ' })}\n\n`,
        `data: ${JSON.stringify({ type: 'tool', phase: 'start', callId: 'n1', name: 'web_search', detail: '今日新闻' })}\n\n`,
        `data: ${JSON.stringify({ type: 'tool', phase: 'done', callId: 'n1', name: 'web_search', detail: '今日新闻', ok: true, ms: 900, chars: 500, preview: '标题列表', urls: [] })}\n\n`,
        `data: ${JSON.stringify({ type: 'drop', chars: 64, text: 'I have sources but no content. Maybe I should search once more. ' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n这是撤回旁白之后的正式结论。\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 20, toolCalls: 1 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // drop 的 text 和真正流出去的对不上（老缓存/异常）时，必须退化成按字数撤
    if (body && body.text === 'narrate-fallback-probe') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', tools: ['web_search'] })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: 'NARRATION-A NARRATION-B ' })}\n\n`,
        `data: ${JSON.stringify({ type: 'tool', phase: 'start', callId: 'n3', name: 'web_search', detail: 'x' })}\n\n`,
        `data: ${JSON.stringify({ type: 'tool', phase: 'done', callId: 'n3', name: 'web_search', detail: 'x', ok: true, ms: 10, chars: 1, preview: '', urls: [] })}\n\n`,
        `data: ${JSON.stringify({ type: 'drop', chars: 24, text: '（对不上的文本）' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n兜底撤回后的结论。\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 12, toolCalls: 1 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'tool-probe') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', tools: ['web_search', 'web_fetch'] })}\n\n`,
        `data: ${JSON.stringify({ type: 'tool', phase: 'start', callId: 'c1', name: 'web_search', detail: 'MCP 协议' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n工具测试\n\n## 详解\n先查再答\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'tool', phase: 'done', callId: 'c1', name: 'web_search', detail: 'MCP 协议', ok: true, ms: 1800, chars: 420, preview: 'MCP（Model Context Protocol）是…', urls: ['https://modelcontextprotocol.io/docs', 'https://example.com/mcp'] })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 18, toolCalls: 1 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 没有工具可用时，模型会把调用写成正文（实测）——客户端必须剥掉
    if (body && body.text === 'fake-tool-probe') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', tools: [] })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '<ds_safety_tool_call>\n<tool_name>web_search</tool_name>\n<parameters>\n<query>DSH 插件</query>\n</parameters>\n</ds_safety_tool_call>\n\n## 翻译\n没有工具时的回答\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 30 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === '尾注探测') {
      const out = ['```js', 'const a = 1 // 尾注', '```'].join('\n')
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: out })}\n\n`,
        `data: ${JSON.stringify({ type: 'done' })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === '稳定key探测') {
      const out = '## 解读\n稳定 key 用例内容\n'
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: out })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: out.length })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === PROSE_PROBE) {
      const out = '## 翻译\n- **the migration ran long**：这次迁移耗时超出预期\n'
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: out })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: out.length })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === PY_SNIPPET) {
      const out = ['## 注释', '```python', '# 两数相加', 'def add(a, b):', '    return a + b', '```', '', '> 小结：返回两数之和。'].join('\n')
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation', mode: 'code' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: out })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: out.length })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === CODE_SNIPPET) {
      const out = [
        '## 注释',
        '```js',
        '// 定义文本长度上限',
        'const MAX = 4000',
        '// 声明一个把文本截断到上限的函数',
        'function clampText(text) {',
        '  // 超限就截断，否则原样返回',
        '  return text.length > MAX ? text.slice(0, MAX) : text;',
        '}',
        '```',
        '',
        '> 小结：把输入文本按 4000 字截断后再返回。',
      ].join('\n')
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation', mode: 'code' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: out })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: out.length })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === '缓存探测词') {
      const only = body.stage === 'detail' ? '## 详解\n详解内容（缓存用例）\n' : '## 解读\n缓存测试内容\n'
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: body.stage || 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: only })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: only.length })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === '中文标题探测') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 解读\n就是"把临时窗口变成正式会话"。\n\n> 在本句中：指把这次解读搬进一个正式会话。\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 30 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'legacy-heading-probe') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n旧标题兼容\n\n## 语境含义\n旧标题下的解释\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done' })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'residue-probe' && !body.question) {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation', effort: 'high' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n残渣用例的翻译\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 12 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'strip-probe' && !body.question) {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation', effort: 'high' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n泄漏用例的翻译\n\n## 语境含义\n泄漏用例的解释\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 30 })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'shared-cache-probe') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'opencode-go', model: 'deepseek-v4.1-flash', cached: true })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n来自共享缓存\n\n## 语境含义\n直接回放\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 24, cached: true })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.text === 'slipped') {
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture-model' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: RENDER_FIXTURE })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: RENDER_FIXTURE.length })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 引用（❝）用例：首轮固定给一句可被引用的正文，详解在同一个小窗里另走 stage=detail
    if (body && body.text === 'quote-probe') {
      const only = body.stage === 'detail' ? '## 详解\n引用用例的详解\n' : '## 翻译\n引用用例的翻译段落（拿来被引用）\n'
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: body.stage === 'detail' ? 'detail' : 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: only })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: only.length })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    // 「等待中的那条不给引用整条」专用：首轮立刻出，追问要等 500ms 才吐第一个字
    if (body && body.text === 'quote-wait-probe' && !body.question) {
      const only = '## 翻译\n等待用例的翻译\n'
      const payload = [
        `data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: only })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: only.length })}\n\n`,
      ].join('')
      return Promise.resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }))
    }
    if (body && body.question && body.text === 'quote-wait-probe') {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'start', provider: 'fixture', model: 'fixture', mode: 'chat', effort: 'low' })}\n\n`),
          )
          await new Promise((r) => setTimeout(r, 500))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '等待用例的回答' })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', chars: 8 })}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
  return null
}
