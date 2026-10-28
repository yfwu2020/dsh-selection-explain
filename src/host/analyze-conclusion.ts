import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { name } from './constants.js'
import { createThinkFilter, splitLeakedReasoning } from './filters.js'
import { sse } from './http.js'
import { systemMessageOf } from './messages.js'

import type { AnalyzeExecutionContext, AnalyzeStreamState } from './analyze-execution-types.js'

/** Recover a final answer from tool digests when normal rounds produced no body text. */
export async function concludeAnalyze(env: AnalyzeExecutionContext, state: AnalyzeStreamState, roundEffort: string) {
  const { deps, request, tools, prompt, messages, res, controller } = env
  const { ctx, config, models } = deps
  const { route, question } = request
  const { sessionId, toolSchemas } = tools
  const { systemPrompt, routeKey } = prompt
  const { checkedMessages, baseMessage, openingMessages } = messages
  // 收尾轮常常"只吐一段工具调用、不写正文"（实测「今天的新闻」一个字都没有）。
  // 这里自己补结论轮：**不重放工具调用链**，而是把结果写成一段自包含的提示 ——
  // 重放消息链的方式实测也不稳（模型面对 tool-call 历史仍可能继续吐工具调用）。
  state.conclusionInfo.tried = true
  sse(res, { type: 'notice', code: 'conclusion-retry', text: '查询已完成，正在整理结论…' })
  const conclusionUser = [
    '【补充结论】',
    // ⚠️ **必须带上用户这一轮问的是什么**：这一段是最终正文的来源，而它以前只有
    // 「选区块 + 检索资料 + 请给出最终答案」—— 模型看不到问题，就只能顺着选中文字写。
    // 实测症状：问"搜索今天的AI新闻。"，正文却在解释选区那个词（如 diagLog / exit）。
    // 特别是收尾轮也带上工具之后（照主会话的做法），正文**每次都**由这里产出，
    // 缺了问题就等于每次都答非所问。
    question ? `【用户这一轮的问题】（这就是你要回答的对象）\n${question}` : '',
    '',
    '【已经查到的资料】',
    ...state.toolDigestLines.slice(0, 12),
    '',
    '请**直接回答上面那条「用户这一轮的问题」**：结论先行、必要处带来源链接。',
    '不要复述选中文字，也不要解释它是什么 —— 除非问题问的就是它。',
    '不要再请求工具，不要输出任何工具调用格式，也不要写"我先看看""让我核对一下"这类过程。',
  ].join('\n')
  // 先按当前档位试一次；空则**换一个档位**再试（同一档重发没意义）。
  // 以前这里写死 `'off'`：对"必须开推理"的端点（noOffRoutes 里的那些）等于注定失败一轮 ——
  // 用户看到的"工具查询完成了，但模型没有产出正文"就常有它一份。
  const conclusionEfforts = [
    roundEffort,
    models.nextEffortFor(routeKey, roundEffort, new Set(roundEffort ? [roundEffort] : [])),
  ].filter((id) => id.length > 0)
  for (const attemptEffort of conclusionEfforts) {
    if (state.answer.trim().length > 0) break
    state.conclusionInfo.rounds += 1
    try {
      const resume = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        ...(sessionId ? { sessionId: sessionId as never } : {}),
        system: undefined,
        // 工具**依然带着**（照主会话：任何一轮都不摘工具）。
        // 以前这一轮不带工具，模型要调工具时只能退回文本层 —— 那正是正文里出现
        // DSML / ds_safety_tool_call 标记的唯一来源。带上之后它走协议层，正文就是正文。
        ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
        messages: checkedMessages([
          systemMessageOf(systemPrompt, name),
          baseMessage, ...openingMessages,
          createUserMessage({ source: { kind: 'user' }, content: [...state.recoveredMaterialBlocks, { type: 'text', text: conclusionUser }] }),
        ]),
        ...(config.temperature >= 0 ? { temperature: config.temperature } : {}),
        ...(config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}),
        ...(attemptEffort ? { reasoningEffort: ReasoningEffortId(attemptEffort) } : {}),
        signal: controller.signal,
      })
      const thinkAgain = createThinkFilter()
      for await (const chunk of resume) {
        if (chunk.type === 'text-delta') {
          const part = thinkAgain.push(chunk.text)
          if (part.think) sse(res, { type: 'thought', text: part.think })
          const text = part.text
          if (text) {
            state.chars += text.length
            state.answer += text
            state.conclusionInfo.chars += text.length
            sse(res, { type: 'delta', text: text })
          }
        } else if (chunk.type === 'usage') {
          state.usage = chunk.usage
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error') {
            state.conclusionInfo.error = chunk.reason.failure?.message ?? '模型调用失败'
          }
        }
      }
      const tail = thinkAgain.flush()
      if (tail.think) sse(res, { type: 'thought', text: tail.think })
      if (tail.text) {
        state.chars += tail.text.length; state.answer += tail.text; state.conclusionInfo.chars += tail.text.length
        sse(res, { type: 'delta', text: tail.text })
      }
      // 结论轮也可能把"英文核对过程"写进正文：一律按泄漏裁一次
      const leaked = splitLeakedReasoning(state.answer)
      if (leaked.prefix) {
        state.answer = leaked.rest
        state.chars = state.answer.length
        sse(res, { type: 'strip', text: leaked.prefix })
        sse(res, { type: 'notice', code: 'reasoning-leak', text: '已去掉模型写进正文的核对过程' })
      }
    } catch (error) {
      if ((error as { code?: string })?.code === 'context-capacity') throw error
      state.conclusionInfo.error = String((error as Error)?.message ?? error)
      ctx.logger?.warn?.(`[${name}] 结论轮失败：${state.conclusionInfo.error}`)
    }
  }

}
