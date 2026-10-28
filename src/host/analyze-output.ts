import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { AnalyzeStreamState } from './analyze-execution-types.js'
import type { AnalyzePrompt } from './analyze-prompt.js'
import type { PreparedAnalyzeRequest } from './analyze-request.js'
import type { AnalyzeToolPlan } from './analyze-tools.js'
import { sse } from './http.js'

export function startAnalyzeOutput(res: ServerResponse, request: PreparedAnalyzeRequest, tools: AnalyzeToolPlan, prompt: AnalyzePrompt): void {
  const { body, route, isChat, background, context, label, userText } = request
  const { historyImages, currentAttachments } = request.history
  const { toolSchemas, agentScope, toolFallbackUsed, wantsFsTools, readRoot, fetchBlockedSample } = tools
  const { stage, isCode, systemPrompt, sentEffort } = prompt
  sse(res, {
    type: 'start',
    provider: route.provider,
    model: route.model,
    mode: isChat ? 'chat' : stage === 'detail' ? 'detail' : isCode ? 'code' : 'translation',
    stage: stage === 'detail' ? 'detail' : 'translation',
    backgroundMessages: background ? background.transcript.split('\n').filter((line) => /^\s*(▶\s*)?(用户|助手)：/.test(line)).length : 0,
    effort: sentEffort,
    tools: toolSchemas.map((schema) => schema.name),
    toolScope: agentScope,
    // 这一轮请求里附件的情况：本轮带了几件、历史里回带/省略了几张。
    // **一件都没有时不带这个字段**（保持 start 事件与从前逐字节一致）。
    // 注意条件要算上"历史里回带的"—— 只看本轮附件的话，
    // "第二问靠历史里的图回答"这种最该被看见的情况反而不上报。
    ...(currentAttachments.length > 0 || historyImages.kept > 0 || historyImages.omitted > 0 || historyImages.files > 0
      ? { attachments: { ...historyImages, current: currentAttachments.length } }
      : {}),
    ...(toolFallbackUsed ? { toolFallbackUsed: true } : {}),
    ...(wantsFsTools ? { readRoot: readRoot || '(不限)' } : {}),
    ...(fetchBlockedSample ? { fetchBlocked: fetchBlockedSample } : {}),
    context: {
      chars: context.length,
      label,
      session: background
        ? {
          chars: background.transcript.length,
          marked: background.marked,
          // 背景短哈希：用于核对「前缀是否真的没变」（缓存命中的前提）
          hash: createHash('sha1').update(background.transcript).digest('hex').slice(0, 10),
        }
        : null,
    },
    ...(body.debug === true
      ? { debug: { system: systemPrompt, user: userText, sizes: { system: systemPrompt.length, user: userText.length } } }
      : {}),
  })
}

/** Emit the existing empty-answer fallback and terminal diagnostics. */
export function finishAnalyzeOutput(res: ServerResponse, state: AnalyzeStreamState, clientClosedEarly: () => boolean): void {
  if (!state.errored && state.answer.trim().length === 0) {
    // 兜底：连结论轮都没吐字时，至少给一句话（否则面板空白，看起来像"没返回结果"）
    const note =
      state.toolCalls > 0
        ? '（工具查询完成了，但模型没有产出正文。可以再追问一句"直接说结论"，我按已查到的结果回答。）'
        : '（模型这次没有返回内容，可以点「重新生成」再试一次。）'
    state.answer = note
    state.chars += note.length
    sse(res, { type: 'delta', text: note })
  }
  if (!state.errored) {
    sse(res, {
      type: 'done',
      chars: state.chars,
      usage: state.usage,
      toolCalls: state.toolCalls,
      // 诊断用：结论轮/续写各试了几次、拿到多少字、失败原因
      ...(state.conclusionInfo.tried ? { conclusion: state.conclusionInfo } : {}),
      ...(state.roundDiag.length > 0 ? { rounds: state.roundDiag } : {}),
      clientClosedEarly: clientClosedEarly(),
    })
  }
}
