import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ServerResponse } from 'node:http'
import { estimateTextTokens } from '../chat-context.js'
import { shotTitlePromptFor } from '../prompts.js'
import type { AnalyzePrompt } from './analyze-prompt.js'
import type { PreparedAnalyzeRequest } from './analyze-request.js'
import type { AnalyzeToolPlan } from './analyze-tools.js'
import type { AnalyzeDependencies } from './analyze-types.js'
import { estimateRequestTokens, planChatContext } from './chat-context.js'
import { materialIndex } from './chat-materials.js'
import { sse } from './http.js'

export interface AnalyzeMessages {
  memoryMessages: Message[]
  baseMessage: Message
  questionContent: ContentBlock[]
  openingMessages: Message[]
  checkedMessages: (messages: Message[]) => Message[]
}

/** Compact chat memory if necessary, then construct the initial multimodal messages. */
export async function prepareAnalyzeMessages(deps: AnalyzeDependencies, request: PreparedAnalyzeRequest, tools: AnalyzeToolPlan, prompt: AnalyzePrompt, res: ServerResponse, controller: AbortController): Promise<AnalyzeMessages | null> {
  const { ctx } = deps
  const { body, isChat, capacity, initialExplanation, userText, question, route, historyStart, isShotMode, titleOnly, shotScope, shotFrame, history } = request
  const { currentAttachments, rawHistory, catalog, historySource } = history
  const { systemPrompt, sentEffort, isShot } = prompt
  const { toolSchemas } = tools
  history.contextEstimate = 0
  if (isChat && capacity) {
    try {
      const fixedTokens = 256 + estimateTextTokens(systemPrompt + userText + initialExplanation + question)
        + estimateTextTokens(JSON.stringify(toolSchemas))
        + estimateTextTokens(materialIndex(catalog, historyStart + rawHistory.length))
        + estimateTextTokens(typeof body.toolDigest === 'string' ? body.toolDigest.slice(0, 2000) : '')
        + currentAttachments.reduce((n, a) => n + capacity.attachmentPrice(a), 0)
      const planned = await planChatContext(ctx, route, capacity, { state: history.contextState, history: rawHistory, fixedTokens, signal: controller.signal, effort: sentEffort })
      history.contextState = planned.state
      history.selectedHistory = planned.history
      history.contextEstimate = planned.estimatedTokens
      sse(res, {
        type: 'context-state', state: history.contextState,
        budget: capacity.budget, estimatedTokens: history.contextEstimate, modelWindow: capacity.modelWindow,
        compacted: planned.compacted, retainedMessages: history.selectedHistory.length
      })
    } catch (error) {
      sse(res, { type: 'error', code: 'context-rejected', message: String((error as Error)?.message || error) })
      return null
    }
  }
  const memoryMessages: Message[] = isChat ? [
    ...(initialExplanation ? [createAssistantMessage({ source: historySource, content: [{ type: 'text', text: initialExplanation }] })] : []),
    ...(history.contextState.summary ? [createUserMessage({
      source: { kind: 'user' }, content: [{
        type: 'text',
        text: '【较早对话摘要，可能遗漏细节】\n' + history.contextState.summary + '\n' + materialIndex(catalog, history.contextState.through)
      }]
    })] : []),
  ] : []
  function checkedMessages(messages: Message[]): Message[] {
    if (capacity && estimateRequestTokens(messages, capacity, toolSchemas) > capacity.budget) {
      throw Object.assign(new Error('本轮材料与工具结果超过上下文容量，请缩小问题或引用范围'), { code: 'context-capacity' })
    }
    return messages
  }
  // ⚠️ 截图模式：图必须**在这一条消息里**。
  // 原先只有 isChat(追问) 才拼 openingMessages，截图走的是 baseMessage 纯文本那条 ——
  // 结果图根本没进请求，模型只会说"我没收到截图"（实测踩到）。
  const shotImageBlocks: ContentBlock[] = isShotMode
    ? currentAttachments.map((item) =>
      item.kind === 'image'
        ? ({ type: 'image', attachment: item.ref as never } as ContentBlock)
        : ({ type: 'file', attachment: item.ref as never } as ContentBlock),
    )
    : []
  const baseMessage = createUserMessage({
    source: { kind: 'user' },
    content:
      shotImageBlocks.length > 0
        ? [...shotImageBlocks, { type: 'text', text: userText }]
        : [{ type: 'text', text: userText }],
  })
  // 上一轮查过的东西一并带上：否则追问会反复重查同样的内容（一次工具往返 20~34s）
  const toolDigest = typeof body.toolDigest === 'string' ? body.toolDigest.trim().slice(0, 2000) : ''
  // 顺序很重要：把"已经查到的结果"放**前面**、问题放**最后**。
  // 反过来的话，模型最后读到的是原始检索结果，容易"整理资料"而不是回答问题
  //（实测：问新闻却把上一次的检索结果当成要总结的对象）。
  const questionText = toolDigest
    ? `【本会话已经查到的结果】（同一会话里查过的，不要重复查同样的内容；只在与本轮问题相关时才用）\n${toolDigest}\n\n【用户这一轮的问题】\n${question}`
    : question
  // 附件排在正文**前面**：模型先拿到材料（图片 / 文件句柄），再读到这一轮的问题。
  // 没有附件时 content 与从前逐字节一致（一个元素、纯文本），既有行为一点不变。
  const currentBlocks: ContentBlock[] = currentAttachments.map((item) =>
    item.kind === 'image' ? { type: 'image', attachment: item.ref as never } : { type: 'file', attachment: item.ref as never },
  )
  const questionContent: ContentBlock[] =
    currentBlocks.length > 0 ? [...currentBlocks, { type: 'text', text: questionText }] : [{ type: 'text', text: questionText }]
  let openingMessages: Message[] = isChat
    ? [
      ...memoryMessages,
      ...history.buildHistoryMessages(),
      // 截图首轮：图 + 问题已经放进 baseMessage（只需要一份，避免图片和问题各发两遍）；
      // 追问不走截图模式，当前问题仍然放在这里。
      ...(isShot ? [] : [createUserMessage({ source: { kind: 'user' }, content: questionContent })]),
    ]
    : []
  if (titleOnly) {
    // 截图：base 那条消息里已经带了图 + 提问，这里只多一句"只输出标题"
    openingMessages = [
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: shotTitlePromptFor(shotScope, shotFrame) }] }),
    ]
  }

  return { memoryMessages, baseMessage, questionContent, openingMessages, checkedMessages }
}
