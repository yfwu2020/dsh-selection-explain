import { BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { name } from './constants.js'
import { createThinkFilter } from './filters.js'
import { sse } from './http.js'
import { systemMessageOf } from './messages.js'

import type { AnalyzeExecutionContext, AnalyzeStreamState } from './analyze-execution-types.js'

/** Stream and filter one upstream round, preserving chunk and diagnostic event order. */
export async function streamAnalyzeRound(env: AnalyzeExecutionContext, state: AnalyzeStreamState, round: number, wrapUp: boolean, roundEffort: string) {
  const { deps, request, tools, prompt, messages, res, controller, executionState } = env
  const { ctx, config } = deps
  const { body, route } = request
  const { sessionId, toolSchemas } = tools
  const { systemPrompt } = prompt
  const { checkedMessages, baseMessage, openingMessages } = messages
  const roundStartedAt = Date.now()
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    // 带上会话 id：主会话 agent loop 一直传它，适配器会据此设置上游的会话头。
    // 插件以前没传，结果是所有小窗请求共用静态会话头 —— 而中继是按会话跟踪的（实测长回答被掐）。
    ...(sessionId ? { sessionId: sessionId as never } : {}),
    system: undefined,
    messages: checkedMessages([
      // 第二参数（组装这段提示词的插件名）：**新老版本签名不一样，两边都得能编译**——
      //   · npm 上按 peer 范围 `>=0.1.5-rc <2` 解析到的是 0.1.5-rc.3：`(text, plugin)` 两个必填
      //     （CI 就是拿这份类型做构建校验的，少传就 TS2554）；
      //   · 本机 / 新版运行时（0.1.7-rc.x）：只剩 `(text)`，多传的参数会被忽略。
      // 所以统一走 systemMessageOf 这个宽松别名（见文件下方的定义），两边都调得动。
      systemMessageOf(
        wrapUp
          ? `${systemPrompt}\n\n【收尾】工具轮次已用完：直接基于已经拿到的信息给出结论，不要再请求工具，也不要复述查询过程。` +
          '正文里不要出现任何工具调用格式（包括 DeepSeek 的 DSML 写法，如 invoke/parameter 标记）——那些会被当作乱码展示给用户。'
          : systemPrompt,
        name,
      ),
      ...(round === 0 ? [baseMessage, ...openingMessages] : [baseMessage, ...openingMessages, ...state.toolMessages]),
    ]),
    // 工具**每轮都在请求里**（照主会话的做法）：收尾轮以前故意不带工具"逼结论"，
    // 结果模型退到文本层、把工具调用标记写进正文（实测 wrapUp 轮 raw=726 → emitted=0）。
    // 主会话从不摘工具，模型也就从不写这种标记 —— 这里与它保持一致。
    ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
    ...(config.temperature >= 0 ? { temperature: config.temperature } : {}),
    ...(config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}),
    ...(roundEffort ? { reasoningEffort: ReasoningEffortId(roundEffort) } : {}),
    signal: controller.signal,
  })
  executionState.upstreamStarted = true
  const assembler = new BlockAssembler()
  // 本轮吐出的正文字数：这一轮如果最后是要调工具，那这些字其实是"过程旁白"
  // （"我还得再搜一次""先看看拿到的标题"这类），要被撤回，不能当成答案留在小窗里
  let roundText = ''
  // 有的模型把思考内联在正文里（<think>…</think>）：拆出来走 thought，别当答案
  // 每轮一个过滤器：未闭合的残渣块只在本轮内作废。
  // 共用一个的话，某一轮吐了未闭合的 DSML（实测收尾轮很常见）会让 depth 一直 >0，
  // 后面所有轮次的正文都被吞掉 —— 表现就是"只完成了工具查询，没有产出正文"（用户截图报的）。
  const think = createThinkFilter()
  let roundRaw = 0
  let roundEmitted = 0
  let roundThink = 0
  let roundFinish = ''
  /** 诊断用：本轮最后若干分片的类型与大小（看上游是发了 finish 还是直接断流）。 */
  const tailChunks: string[] = []
  const emit = (part: { text: string; think: string }): void => {
    if (part.think) {
      roundThink += part.think.length
      sse(res, { type: 'thought', text: part.think })
    }
    // 残渣过滤放在 think 之后：先分出思考，再把正文里的工具调用标记丢掉
    const text = part.text
    if (text) {
      roundEmitted += text.length
      state.chars += text.length
      state.answer += text
      roundText += text
      sse(res, { type: 'delta', text: text })
    }
  }
  for await (const chunk of stream) {
    assembler.push(chunk)
    if (body.debug === true) {
      const size = chunk.type === 'text-delta' ? chunk.text.length : 0
      tailChunks.push(`${chunk.type}:${size}`)
      if (tailChunks.length > 14) tailChunks.shift()
    }
    if (chunk.type === 'text-delta') {
      roundRaw += chunk.text.length
      emit(think.push(chunk.text))
    } else if (chunk.type === 'reasoning-delta') {
      // 思考过程也透传：首字前那几秒如果只有转圈，用户会以为卡死了。
      // 客户端只留尾部一小段当"正在想什么"的提示，不进正文。
      sse(res, { type: 'thought', text: chunk.text })
    } else if (chunk.type === 'usage') {
      state.usage = chunk.usage
    } else if (chunk.type === 'finish') {
      roundFinish = String(chunk.reason.kind)
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        state.errored = true
        // 先只记下来：如果接下来要"换档重试"，这条错误就不该发给用户
        // （否则客户端先渲染一条失败提示，重试的正文就贴在失败提示后面了）
        state.errorMessage =
          chunk.reason.failure?.message ?? `模型调用${chunk.reason.kind === 'aborted' ? '被中断' : '失败'}`
        state.errorCode = chunk.reason.failure?.code
      }
    }
  }
  emit(think.flush())
  state.roundDiag.push({
    round,
    wrapUp,
    ms: Date.now() - roundStartedAt,
    raw: roundRaw,
    emitted: roundEmitted,
    think: roundThink,
    finish: roundFinish || '(none)',
    tools: assembler.blocks().filter((block) => block.type === 'tool-call').length,
    ...(body.debug === true ? { tailChunks } : {}),
    outTokens: (state.usage as { outputTokens?: number } | null)?.outputTokens,
  })

  return { assembler, roundText }
}
