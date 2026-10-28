import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ContextState } from '../chat-context.js'
import { contextSource, EMPTY_DIGEST, readContextState } from '../chat-context.js'
import type { ShotPromptScope } from '../prompts.js'
import { AnalyzeHistory } from './analyze-history.js'
import type { AnalyzeDependencies } from './analyze-types.js'
import { fitBackground, resolveChatCapacity } from './chat-context.js'
import { sessionIdOf } from './context.js'
import { BODY_LIMIT, readBody, sendJson } from './http.js'
import type { AnalyzeBody, Route, SessionBackground } from './types.js'

export interface PreparedAnalyzeRequest {
  body: AnalyzeBody
  text: string
  context: string
  label: string
  route: Route
  initialExplanation: string
  historyStart: number
  capacity: Awaited<ReturnType<typeof resolveChatCapacity>> | null
  background: SessionBackground | null
  isShotMode: boolean
  shotScope: ShotPromptScope
  shotFrame: boolean
  titleOnly: boolean
  userText: string
  effort: string
  question: string
  isChat: boolean
  history: AnalyzeHistory
}

/** Validate, resolve route/background, and normalize request inputs before SSE starts. */
export async function prepareAnalyzeRequest(req: IncomingMessage, res: ServerResponse, deps: AnalyzeDependencies, allow: () => boolean): Promise<PreparedAnalyzeRequest | null> {
  const { ctx, config, models, sessions, historyStore } = deps
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '只支持 POST' })
    return null
  }
  let body: AnalyzeBody
  try {
    body = JSON.parse(await readBody(req, BODY_LIMIT)) as AnalyzeBody
  } catch (error) {
    sendJson(res, 400, { error: `请求体解析失败：${String((error as Error)?.message ?? error)}` })
    return null
  }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (text.length === 0) {
    sendJson(res, 400, { error: '缺少 text（选中文字）' })
    return null
  }
  if (text.length > config.maxSelectionChars) {
    sendJson(res, 413, { error: `选中文字过长（${text.length} > ${config.maxSelectionChars} 字符）` })
    return null
  }
  if (!allow()) {
    sendJson(res, 429, { error: `请求过于频繁（上限 ${config.maxRequestsPerMinute}/分钟）` })
    return null
  }
  const override =
    typeof body.provider === 'string' && typeof body.model === 'string' && body.provider && body.model
      ? { provider: body.provider, model: body.model }
      : undefined
  // 名字避开下面的 isChat（那里判的是"提示词用追问那套"，此处判的是"模型用追问那个"）
  const isChatRound = typeof body.question === 'string' && body.question.trim().length > 0
  const route = models.resolveRoute(override, await sessions.sessionModelOf(sessionIdOf(body)), isChatRound)
  if (!route) {
    sendJson(res, 503, { error: '尚未确定模型路由：请先在设置里选择默认模型后重试' })
    return null
  }

  const context = historyStore.clampText(body.context, config.maxContextChars)
  const label = historyStore.clampText(body.label, 80)
  // 页面标题/地址不写进提示词：模型会把它当成「选中文字里的英文」去翻译（实测把标题 DSH 译了一遍）

  const initialExplanation = typeof body.initialExplanation === 'string' ? body.initialExplanation : ''
  const source = contextSource(sessionIdOf(body), text, typeof body.context === 'string' ? body.context : '', initialExplanation)
  const restoredState = readContextState(body.contextState)
  const historyStart = Number.isSafeInteger(body.historyStart) && Number(body.historyStart) >= 0 ? Number(body.historyStart) : 0
  if (isChatRound && historyStart > 0 && (!restoredState || restoredState.source !== source || restoredState.through !== historyStart)) {
    sendJson(res, 409, { error: '对话记忆进度与当前来源不一致，请重新打开这段历史后重试' })
    return null
  }
  let contextState: ContextState = restoredState && restoredState.source === source && restoredState.through === historyStart
    ? { ...restoredState, sessionId: sessionIdOf(body) } : { version: 1, sessionId: sessionIdOf(body), source, through: 0, digest: EMPTY_DIGEST, summary: '', background: null }
  const capacity = isChatRound ? await resolveChatCapacity(ctx, config, route) : null

  // 会话背景：从 sessionQuery 读取当前会话的模型界面（live 优先，含持久化会话）
  let background: SessionBackground | null = null
  if (config.sessionContext) {
    const sessionId = sessionIdOf(body)
    if (isChatRound && restoredState && restoredState.source === source) background = contextState.background
    else if (sessionId) {
      // 背景预算按阶段：首轮只要翻译（8 条够定指代）；详解与追问都是深度交互，吃满 24 条
      const stage = typeof body.stage === 'string' ? body.stage : ''
      const wantsFull = stage === 'detail' || typeof body.question === 'string'
      background = await sessions.loadSessionBackground(sessionId, {
        maxMessages: wantsFull ? config.sessionContextMaxMessages : config.sessionContextFastMessages,
        maxChars: config.sessionContextMaxChars,
        marker: text,
      })
    }
  }

  if (isChatRound && capacity && !restoredState) background = fitBackground(background, Math.max(128, capacity.budget * 0.2))
  if (isChatRound) contextState = { ...contextState, background }

  // 顺序即缓存策略：前缀必须“只增不变”才能复用 ——
  //   ① 会话背景（同一会话内基本不变）→ ② 固定说明 → ③ 动态尾部（选中文字/局部片段）
  // 反过来写（动态在前、背景在后）会让缓存前缀在“选中文字”处就断掉：
  // 实测同会话换一处选中，命中量从 5760 tokens 掉到 640~768。
  const stablePrefix: string[] = []
  if (background && background.transcript) {
    stablePrefix.push(
      `【会话背景】（按时间顺序；${background.marked ? '最后一条即选中文字所在的消息，已用 ▶ 标出，其后的对话未包含' : '未能定位选中位置，取的是最近的对话'}）`,
      background.transcript,
      '',
      '上面是会话背景；下面是需要你解读的【选中文字】及其上下文。',
      '',
    )
  }
  const isShotMode = body.kind === 'shot'
  /**
   * 截图取景范围：决定提示词口径（有没有红框、图是不是只有选区）。
   * 老客户端不带时按"整窗 + 红框"兜底；非法值也退到整窗，避免把提示词写坏。
   */
  const shotScope: ShotPromptScope =
    body.shotScope === 'screen' || body.shotScope === 'window' || body.shotScope === 'margin' || body.shotScope === 'selection'
      ? body.shotScope
      : 'window'
  const shotFrame = body.shotFrame !== false
  /**
   * 取标题（截图提问的第二次调用）。
   *
   * 关键：**前缀必须与回答那次逐字节一致**（同样的 system、同样的图、同样的提问），
   * 这样图那部分能命中前缀缓存；只在最后追加一句"只输出标题"。
   * 并且工具轮次强制为 0 —— 这次不该去调工具。
   */
  const titleOnly = isShotMode && body.titleOnly === true
  // 截图提问：**没有选中文字**，这轮的文字就是用户说的那句话，正文不该套"选中文字"模板
  const userText = isShotMode
    ? text
    : [
      ...stablePrefix,
      '【选中文字】',
      text,
      '',
      `【所在位置】${label || '页面内容'}`,
      '',
      '【选中处的上下文片段】（选中部分用【】标出）',
      context || '（未能取到上下文片段，请仅根据选中文字与会话背景作答）',
    ].join('\n')

  const effort = typeof body.effort === 'string' && body.effort.length > 0 ? body.effort : config.reasoningEffort
  // 追问模式：客户端带 question 时，就是「就这段选中文字继续聊」
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  const isChat = question.length > 0
  // 这一轮的附件（追问）：/api/attach 存好之后的持久引用。形状在这里**收敛一次**，
  // 历史那条路用的也是同一个收敛器（见 history-attachments.ts）。

  const history = new AnalyzeHistory(body, isChat, historyStart, route, contextState)
  return {
    body, text, context, label, route, initialExplanation, historyStart, capacity, background,
    isShotMode, shotScope, shotFrame, titleOnly, userText, effort, question, isChat, history
  }
}
