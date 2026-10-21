import type { createHistoryStore } from './history-store.js'
import type { createSessions } from './sessions.js'
import type { createModels } from './models.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, readBody, BODY_LIMIT, sse } from './http.js'
import type { AnalyzeBody, SessionBackground } from './types.js'
import { sessionIdOf } from './context.js'
import type { Message, ToolSchema, ContentBlock } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createUserMessage, ReasoningEffortId, BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { name } from './constants.js'
import { resolveToolNames, webFetchUsable, FS_TOOL_NAMES, describeToolCall, isReadAllowed, runTool, digestToolResult } from './tools.js'
import { CHAT_SYSTEM_PROMPT, DETAIL_PROMPT, CODE_PROMPT, TRANSLATION_PROMPT, SHOT_PROMPT, SHOT_TITLE_PROMPT } from '../prompts.js'
import { loadDesignSkill } from './design-skill.js'
import { systemMessageOf } from './messages.js'
import { createThinkFilter, splitLeakedReasoning, looksLikeLeakedReasoning } from './filters.js'
import { resolve } from 'node:path'
import { looksLikeReasoningRequired, looksLikeUnsupportedTier, EFFORT_LABEL } from './effort.js'
import { historyContentBlocks, looksLikeAttachmentFailure, readHistoryAttachments } from './history-attachments.js'
import type { HistoryContentPlan } from './history-attachments.js'
import { contextSource, EMPTY_DIGEST, estimateTextTokens, readContextState } from '../chat-context.js'
import type { ChatTurn, ContextState } from '../chat-context.js'
import { resolveChatCapacity, fitBackground, planChatContext, estimateRequestTokens } from './chat-context.js'
import { readMaterialCatalog, materialIndex, MATERIAL_TOOL, restoreMaterial } from './chat-materials.js'

/** Owns analyze state for one plugin instance. */
export function createAnalyze(ctx: Context, config: Config, models: ReturnType<typeof createModels>, sessions: ReturnType<typeof createSessions>, historyStore: ReturnType<typeof createHistoryStore>) {

  /** 分钟级限流。 */
  const hits: number[] = []

  const allow = (): boolean => {
    const now = Date.now()
    while (hits.length > 0 && now - hits[0] > 60_000) hits.shift()
    if (hits.length >= config.maxRequestsPerMinute) return false
    hits.push(now)
    return true
  }

  /**
   * 共享结果缓存（进程级，跨标签页/刷新可用）：
   * 同会话 + 同选中文字 + 同局部片段 + 同会话背景 → 直接回放上次结果，不再调用模型。
   */
  const resultCache = new Map<string, { at: number; text: string }>()

  const resultKeyOf = (provider: string, model: string, sessionId: string, backgroundText: string, text: string, context: string): string =>
    createHash('sha1').update([provider, model, sessionId, backgroundText, text, context].join('\u0000')).digest('hex')

  const handleAnalyze = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '只支持 POST' })
      return
    }
    let body: AnalyzeBody
    try {
      body = JSON.parse(await readBody(req, BODY_LIMIT)) as AnalyzeBody
    } catch (error) {
      sendJson(res, 400, { error: `请求体解析失败：${String((error as Error)?.message ?? error)}` })
      return
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text.length === 0) {
      sendJson(res, 400, { error: '缺少 text（选中文字）' })
      return
    }
    if (text.length > config.maxSelectionChars) {
      sendJson(res, 413, { error: `选中文字过长（${text.length} > ${config.maxSelectionChars} 字符）` })
      return
    }
    if (!allow()) {
      sendJson(res, 429, { error: `请求过于频繁（上限 ${config.maxRequestsPerMinute}/分钟）` })
      return
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
      return
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
      return
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
    const currentAttachments = readHistoryAttachments(body.attachments)
    const rawHistory: ChatTurn[] = (Array.isArray(body.history) ? body.history : []).map(raw => {
      const item = (raw || {}) as { role?: unknown; text?: unknown; attachments?: unknown }
      const attachments = readHistoryAttachments(item.attachments)
      return { role: item.role === 'assistant' ? 'assistant' : 'user', text: typeof item.text === 'string' ? item.text : '',
        ...(attachments.length ? { attachments } : {}) }
    })
    let selectedHistory = rawHistory
    const catalog = readMaterialCatalog([...(Array.isArray(body.materials) ? body.materials : []),
      ...rawHistory.flatMap((t, i) => (t.attachments || []).map(a => ({ ...a, turn: historyStart + i }))),
      ...currentAttachments.map(a => ({ ...a, turn: historyStart + rawHistory.length }))])
    // 预算规划的结果（图片几张回带、几张降级），只用于上报与诊断
    let historyImages = { kept: 0, omitted: 0, files: 0 }
    // 历史里有没有真带过附件：决定"附件读不回来"时值不值得降级重试一次
    let historyHadAttachments = false
    // 引用失效后的降级开关（置真 = 历史附件全部换成文字）
    let historyDropped = false

    // 闭包里的 TS 收窄到不了：把 route 的两字段先取成常量（route 在更早处已经非空校验过）
    const historySource = { provider: route.provider, model: route.model }

    /**
     * 历史规划（纯计算）：预算、降级、以及**这次请求真的进了消息的那些附件**。
     * 每次都要能重算 —— 引用失效时会降级再跑一遍（见下面 errored 分支里的那一跳）。
     */
    function planHistory(): HistoryContentPlan {
      if (!isChat) return { blocks: [], kept: [], keptImages: 0, omittedImages: 0, keptFiles: 0, omittedFiles: 0 }
      const window = selectedHistory
      const turns = historyDropped
        ? window.map((turn) => {
            const item = (turn ?? {}) as { role?: unknown; text?: unknown }
            return { role: item.role, text: item.text }
          })
        : window
      const plan = historyContentBlocks(turns, currentAttachments)
      historyImages = { kept: plan.keptImages, omitted: plan.omittedImages, files: plan.keptFiles + plan.omittedFiles }
      return plan
    }

    /** 重建历史消息。 */
    function buildHistoryMessages(): Message[] {
      const out: Message[] = []
      if (!isChat) return out
      const window = selectedHistory
      const plan = planHistory()
      window.forEach((turn, index) => {
        const item = turn as { role?: unknown; attachments?: unknown }
        if (!historyDropped && Array.isArray(item.attachments) && item.attachments.length > 0) historyHadAttachments = true
        const content = plan.blocks[index] ?? []
        if (content.length === 0) return
        if (item.role === 'assistant') {
          out.push(createAssistantMessage({ content, source: historySource }))
        } else {
          out.push(createUserMessage({ source: { kind: 'user' }, content }))
        }
      })
      return out
    }

    /**
     * 文件工具的**访客名单**：这次请求里"模型真的看得见"的文件，在磁盘上的绝对路径。
     *
     * 组成 = 本轮的附件 + 历史里真的拼进消息的那部分（`plan.kept`）。
     * 不另算一套口径：**模型看得见的，才读得到**。
     *
     * 路径由附件服务按内容哈希推出（不碰磁盘，纯路径计算，所以每次请求重算没有成本）；
     * 引用不合法就当场丢掉 —— 它本来也读不出来，让门禁拒掉即可。
     */
    function collectAttachedPaths(): Set<string> {
      const paths = new Set<string>()
      const store = ctx.get('attachments') as { fileHostPath?: (ref: unknown) => string | undefined } | undefined
      if (!store || typeof store.fileHostPath !== 'function') return paths
      const refs = []
      for (const item of currentAttachments) if (item.kind === 'file') refs.push(item.ref)
      for (const item of catalog) if (item.kind === 'file') refs.push(item.ref)
      for (const ref of refs) {
        try {
          const hostPath = store.fileHostPath(ref)
          if (hostPath) paths.add(resolve(hostPath))
        } catch {
          /* 引用不合法：当它不存在（读的时候自然会被门禁拒） */
        }
      }
      return paths
    }

    const cacheKey = resultKeyOf(
      route.provider,
      route.model,
      sessionIdOf(body) + '|' + effort + '|' + (typeof body.stage === 'string' ? body.stage : 'translation'),
      background?.transcript ?? '',
      text,
      context,
    )
    const useResultCache = !isChat && config.resultCacheTtlMs > 0 && body.refresh !== true
    const cached = useResultCache ? resultCache.get(cacheKey) : undefined
    if (cached && Date.now() - cached.at < config.resultCacheTtlMs) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      sse(res, {
        type: 'start',
        provider: route.provider,
        model: route.model,
        cached: true,
        context: { chars: context.length, label, session: background ? { chars: background.transcript.length, marked: background.marked } : null },
      })
      sse(res, { type: 'delta', text: cached.text })
      sse(res, { type: 'done', chars: cached.text.length, cached: true })
      res.end()
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const controller = new AbortController()
    let finished = false
    /** 诊断：客户端（浏览器/探针）在流还没结束时就把连接关了 —— 会让上游被 abort，表现为"输出到一半停了"。 */
    let clientClosedEarly = false
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    res.on('close', () => {
      if (!finished) {
        clientClosedEarly = true
        ctx.logger?.warn?.(`[${name}] 客户端提前断开（流未结束）：已中止上游，避免继续消耗 token`)
        controller.abort()
      }
    })

    // 可用工具（白名单，默认只有联网搜索/抓取）：交给模型自己决定要不要用。
    // 注意工具是「按会话作用域」注册的（全局视图里看不到 web_search 等），
    // 所以要拿该会话的 agent 当 scope 去查，并把同一个 agent 传给 execute。
    const agents = ctx.get('agents') as { get?: (id: string) => unknown; list?: () => unknown[] } | undefined
    const sessionId = sessionIdOf(body)
    let agent = sessionId ? agents?.get?.(sessionId) : undefined
    let agentScope = agent ? 'session' : ''
    if (!agent) {
      // 回退：本会话还没起 agent（刚开的新会话／agent 已释放）时，用任一活跃 agent 当作用域。
      // 不这么做的话，session-scoped 的 web_search/web_fetch 在全局视图里根本不可见 →
      // 工具静默为空，模型还会把工具调用当正文吐出来（实测见过 <ds_safety_tool_call>）。
      const live = agents?.list?.() ?? []
      if (live.length > 0) {
        agent = live[0]
        agentScope = 'fallback'
      }
    }
    const toolSchemas: ToolSchema[] = []
    /** 诊断：这一轮是不是走了"备用联网工具"（首选联网工具一个都不在）。 */
    let toolFallbackUsed = false
    if (config.tools && config.maxToolRounds > 0) {
      const registry = ctx.get('tools') as { schemas?: (scope?: unknown) => ToolSchema[] } | undefined
      const split = (value: string): string[] =>
        value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
      let visible: ToolSchema[] = []
      try {
        visible = registry?.schemas?.(agent) ?? []
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] 读取工具表失败：${String((error as Error)?.message ?? error)}`)
      }
      const allowed = resolveToolNames(
        split(config.toolNames),
        split(config.fallbackToolNames),
        visible.map((schema) => schema.name),
      )
      toolFallbackUsed = !allowed.includes('advanced_search') && !allowed.includes('platform_search')
      for (const schema of visible) {
        if (allowed.includes(schema.name)) toolSchemas.push(schema)
      }
    }

    // 本机抓不了网页（fake-IP 代理 / SSRF 防护）时，把 web_fetch 摘掉：
    // 否则模型每次都要白跑一轮（5~15s）才拿到"resolves to a non-public IP address"。
    let fetchBlockedSample = ''
    if (toolSchemas.some((schema) => schema.name === 'web_fetch')) {
      const probe = await webFetchUsable()
      if (!probe.usable) {
        fetchBlockedSample = probe.sample
        for (let i = toolSchemas.length - 1; i >= 0; i -= 1) {
          if (toolSchemas[i]?.name === 'web_fetch') toolSchemas.splice(i, 1)
        }
        ctx.logger?.warn?.(`[${name}] 网页抓取不可用（域名解析到 ${probe.sample}，属保留地址段），已从工具表移除 web_fetch`)
      }
    }

    if (isChat && config.tools && config.maxToolRounds > 0 && (rawHistory.length > 0 || catalog.length > 0 || contextState.through > 0)) {
      toolSchemas.push(MATERIAL_TOOL)
    }

    // 文件类工具的边界：默认只允许会话工作目录；'*' = 不限制；配置了具体目录就用它。
    // 拿不到工作目录时**不设限**（否则新会话里 read 直接全废），但会打日志说明。
    const wantsFsTools = toolSchemas.some((schema) => FS_TOOL_NAMES.includes(schema.name))
    let readRoot = ''
    if (wantsFsTools) {
      if (config.toolReadRoot === '*') {
        readRoot = ''
      } else {
        readRoot = config.toolReadRoot || (await sessions.resolveSessionCwd(sessionIdOf(body))) || ''
        if (!readRoot) ctx.logger?.warn?.(`[${name}] 拿不到会话工作目录，文件工具本次不设边界`)
      }
    }

    const stage = typeof body.stage === 'string' ? body.stage : ''
    // 选中文字是代码：首轮走「注释」提示词（代码块 + 逐句注释 + 小结）
    const isCode = body.kind === 'code'
    // 截图提问是**独立模式**：没有选中文字，只有一张图 + 一个问题，不能用"追问"那套提示词
    const isShot = body.kind === 'shot'
    const basePrompt = isShot
      ? SHOT_PROMPT
      : isChat
      ? CHAT_SYSTEM_PROMPT
      : stage === 'detail'
        ? DETAIL_PROMPT
        : isCode
          ? CODE_PROMPT
          : TRANSLATION_PROMPT
    // 一个工具都没有时明确禁止伪造调用（模型会照着自己的习惯吐 <ds_safety_tool_call> 之类的格式）
    // 正文里不许写"盘算过程"（模型在工具轮里很容易把"I should search again…"这类写进正文）
    const narrateRule =
      '\n\n【正文只写结论】不要把思考、盘算、自查过程写进正文（"我还得再搜一次""先看看拿到的标题""让我确认一下"这类一律不写）；需要工具就直接调用，调用前后都不要解说。'
    // 输出偏好（小窗开关）：左档 Markdown / 右档 网页。
    // 关档也要明确说"用 Markdown"——否则标签写着 Markdown、行为却可能自己给整页 HTML，开关就名不副实。
    let webRule = ''
    if (isChat && body.webAnswer !== true) {
      webRule =
        '\n\n【输出偏好：Markdown】用户把输出偏好设为 Markdown：默认用普通文字/Markdown 回答' +
        '（标题、列表、表格、代码块都可以）。' +
        '**这不禁止 HTML**——如果这个问题用一页 HTML 明显讲得更清楚，照样可以用网页回答；' +
        '只是不要单纯为了"好看"就把简单问题做成页面。'
    }
    if (isChat && body.webAnswer === true) {
      const skill = await loadDesignSkill()
      webRule =
        '\n\n【输出偏好：网页】这不是"一律用网页"，而是**网页优先**：\n' +
        '- **复杂问题**（需要对比、流程、层级、图表，或者文字答案会长到不好读）→ 直接给完整的单文件 HTML' +
        '（放进 ```html 代码块），**页面本身就是答案**，不要再用文字复述一遍；\n' +
        '- **简单问题**（一两段话能说清、不需要并列或图示）→ **仍然直接用文字回答**。' +
        '不要为了用网页而用网页，也不要把简单问题包装成页面。\n' +
        '拿不准时按"能不能用一小段话讲清"来判断：能，就文字。\n' +
        '用网页时，页面会渲染在大约 **500px 宽**的小窗里，按下面的设计规范做：\n\n' +
        skill +
        (body.theme === 'dark'
          ? '\n\n【配色：跟随宿主，当前是深色】宿主界面此刻是**深色模式**，页面必须是深色：' +
            '背景用 #16181c~#1f2126 一档，正文 #e6e6e6，次级文字 #a1a1aa，分隔线 rgba(255,255,255,.12)，' +
            '卡片底色比页面底再亮一档。**不要白底黑字**，也不要只写 prefers-color-scheme（宿主的深浅由用户设置决定，与系统不一定一致）。\n'
          : '\n\n【配色：跟随宿主，当前是浅色】宿主界面此刻是**浅色模式**，页面必须是浅色：' +
            '背景用 #ffffff~#f7f7f8 一档，正文 #171717，次级文字 #6b7280，分隔线 rgba(0,0,0,.10)，' +
            '卡片底色与页面底拉开一档。**不要深色底**，也不要只写 prefers-color-scheme（宿主的深浅由用户设置决定，与系统不一定一致）。\n')
    }
    // 访客名单要在**拼系统提示词之前**算好：提示词里要告诉模型"你附的那几个文件也在可读范围里"。
    //
    // ⚠️ 措辞很要紧。原来写的是「范围：项目目录。超出该范围的路径会被拒绝」，再追加一句
    // "附带的文件也能读" —— 实测模型会**逮住前半句直接放弃**：它一次 read 都不试，
    // 就回"这个文件我读不了，它在附件仓，而我的工具被限制在项目目录"。
    // 所以改成**先把可读范围说全**（项目 + 本次附带的文件），再说"除此之外会被拒"。
    let attachedPaths = collectAttachedPaths()
    const fileRule = wantsFsTools
      ? `\n\n【文件访问】你可以用read/grep/glob读取当前项目（${readRoot || '不限'}）和本小窗已提供的文件附件。附件路径以经过验证的文件引用或selection_material返回为准。需要旧文件时先用selection_material取回路径，再按问题读取必要部分；上传成功不等于格式可解析，不能读取时明确说明。除此之外的路径会被拒绝。`
      : ''
    const fetchRule = fetchBlockedSample
      ? `\n\n【抓取网页不可用】本机域名解析到保留地址段（${fetchBlockedSample}），网页抓取会被安全策略拒绝：只做联网搜索，**不要尝试抓取具体网址**（省掉一次注定失败的往返）。`
      : ''
    const systemPrompt =
      (toolSchemas.length > 0
        ? basePrompt
        : `${basePrompt}\n\n【本轮没有可用工具】不要输出任何工具调用格式（如 <ds_safety_tool_call>、tool_calls、JSON 形式的调用），也不要声称你查过；需要实时/外部信息时直接说明你无法联网或无法读取，只基于已知信息作答。`) +
      narrateRule +
      webRule +
      fileRule +
      fetchRule
    // 三档分开：翻译（默认 low，只要快）／详解（默认 reasoningEffort=high，要深）／追问（chatReasoningEffort=high，要准）
    // 三档分开：翻译（默认 low，只要快）／详解（默认 reasoningEffort=high，要深）／追问（默认 chatReasoningEffort=high）
    // 但**追问档**允许请求覆盖（小窗的「推理等级（追问档）」控件靠这条生效）：
    // 首轮/详解仍按各自的配置走 —— 首轮故意用低档换速度，不该被追问档的设置带跑。
    await models.loadLeaky()
    let bodyEffort = typeof body.effort === 'string' && body.effort.length > 0 ? body.effort : ''
    // 这个模型在"关"档会把思考写进正文（实测过）：别再发 none，直接抬到 low —— 既没泄漏，也不慢
    const routeKey = `${route.provider}/${route.model}`
    if (isChat && bodyEffort === 'off' && models.leakyOnOff.has(routeKey)) {
      bodyEffort = 'low'
      sse(res, {
        type: 'notice',
        code: 'effort-clamped',
        tier: 'off',
        text: '该模型在「关」档会把思考写进正文，已自动改用「低」档',
      })
    }
    let requestEffort = isChat
      ? bodyEffort || config.chatReasoningEffort || effort
      : stage === 'detail'
        ? effort
        : config.translationReasoningEffort || effort
    // 已知这个模型不接受"关"档（之前撞过一次并记下来了）：直接换 low，不再先失败一轮。
    // 首轮默认就是 off，所以这条对"默认配置 + 不吃 off 的模型"是必经之路。
    if (requestEffort === 'off' && models.noOffRoutes.has(routeKey)) requestEffort = 'low'
    // 规范四格 → 这个模型真实声明的档位（每次请求现算；'' = 这个模型不支持推理，干脆不带档位）。
    // 注意：leaky / noOff 两条守卫仍在**规范档位**这一层判断（它们记的是"关档"的语义），
    // 映射放在最后一步。
    const sentEffort = models.effortForRoute(routeKey, requestEffort)
    // 「关」这一格在这个模型上到底是哪个真实档位：重试判定与泄漏检查都要按**真实档位**比
    // （模型可能没有 off，或叫 none/minimal —— 那就不能拿字符串 'off' 去比）
    const offSlotEffort = requestEffort === 'off' ? sentEffort : models.effortForRoute(routeKey, 'off')

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
    let chars = 0
    let contextEstimate = 0
    if (isChat && capacity) {
      try {
        const fixedTokens = 256 + estimateTextTokens(systemPrompt + userText + initialExplanation + question)
          + estimateTextTokens(JSON.stringify(toolSchemas))
          + estimateTextTokens(materialIndex(catalog, historyStart + rawHistory.length))
          + estimateTextTokens(typeof body.toolDigest === 'string' ? body.toolDigest.slice(0, 2000) : '')
          + currentAttachments.reduce((n, a) => n + capacity.attachmentPrice(a), 0)
        const planned = await planChatContext(ctx, route, capacity, { state: contextState, history: rawHistory, fixedTokens, signal: controller.signal, effort: sentEffort })
        contextState = planned.state
        selectedHistory = planned.history
        contextEstimate = planned.estimatedTokens
        sse(res, { type: 'context-state', state: contextState,
          budget: capacity.budget, estimatedTokens: contextEstimate, modelWindow: capacity.modelWindow,
          compacted: planned.compacted, retainedMessages: selectedHistory.length })
      } catch (error) {
        sse(res, { type: 'error', code: 'context-rejected', message: String((error as Error)?.message || error) })
        finished = true
        clearTimeout(timer)
        res.end()
        return
      }
    }
    const memoryMessages: Message[] = isChat ? [
      ...(initialExplanation ? [createAssistantMessage({ source: historySource, content: [{ type: 'text', text: initialExplanation }] })] : []),
      ...(contextState.summary ? [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
        text: '【较早对话摘要，可能遗漏细节】\n' + contextState.summary + '\n' + materialIndex(catalog, contextState.through) }] })] : []),
    ] : []
    let upstreamStarted = false
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
      ? [...memoryMessages, ...buildHistoryMessages(), createUserMessage({ source: { kind: 'user' }, content: questionContent })]
      : []
    if (titleOnly) {
      // 截图：base 那条消息里已经带了图 + 提问，这里只多一句"只输出标题"
      openingMessages = [
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: SHOT_TITLE_PROMPT }] }),
      ]
    }
    try {
      let errored = false
      let usage: unknown = null
      let answer = ''
      const toolMessages: Message[] = []
      const recoveredMaterialBlocks: ContentBlock[] = []
      let toolContextTokens = 0
      let toolCalls = 0
      // 允许的工具轮 + 1 个**收尾轮**：收尾轮不带任何工具。
      // 不加这一轮的话，模型每轮都调工具时循环直接结束，正文是空的——
      // 用户看到的就是"转了半天，但没有任何回答"。
      let errorMessage = ''
      let errorCode: string | undefined
      const toolDigestLines: string[] = []
      /** 被残渣过滤器丢掉的字数：末尾那些"模型顺手又调了一次工具"的标记会让正文停在半句上。 */
      /**
       * 逐轮诊断（放进 done 事件）：原始字数 / 过滤后字数 / 思考字数 / 残渣丢弃 / finish 原因 / 输出 tokens。
       * 用来回答"到底是模型没吐、还是被我们的过滤器吃掉了、还是上游掐流"——不靠猜。
       */
      const roundDiag: Array<Record<string, unknown>> = []
      let conclusionInfo: { tried: boolean; chars: number; rounds: number; error: string } = {
        tried: false,
        chars: 0,
        rounds: 0,
        error: '',
      }
      const toolRounds = config.maxToolRounds
      // 档位被上游拒绝时（400/401/500）重试一次：清单里声明的档位是**建议值**，
      // 实测很多模型并不接受 max（qwen3.7-max 直接 400、minimax-m2.7/gpt-5.6-luna 500）。
      //
      // 以前这里限定了 `isChat && bodyEffort.length > 0` —— 只有追问、且客户端显式传了档位才重试。
      // 于是**首轮**（档位来自配置、默认 off）撞上不吃 off 的模型时无人兜底，整个划词解读全挂。
      // 现在按"这一轮实际在发显式档位"判，三种轮次一视同仁。
      //
      // 2026-10-09 改：重试**不再"去掉档位"**，而是换一个没试过的档（见 nextEffortFor）。
      // 老代码对非 off 档的重试是 `roundEffort = ''`（省略 reasoning），
      // 而省略对"必须开推理"的端点就是关掉推理 —— 实测 20 次重试 0 次成功。
      // 同时给两次机会：上游偶发失败约一半，两次能把成功率抬到 ~90%（代价是多一次往返）。
      const EFFORT_RETRY_LIMIT = 2
      // 重试与"泄漏检查"都看**真正发出去**的那个档位（sentEffort，映射之后的值）：
      // 规范档位是"关"、但这个模型的关档叫 none/minimal 时，检查的必须是发出去的那个。
      let effortRetries = sentEffort.length > 0 ? EFFORT_RETRY_LIMIT : 0
      const triedEfforts = new Set<string>(sentEffort ? [sentEffort] : [])
      const firstSentEffort = sentEffort
      let roundEffort = sentEffort
      const effectiveToolRounds = titleOnly ? 0 : toolRounds
      for (let round = 0; round <= effectiveToolRounds; round += 1) {
        const roundStartedAt = Date.now()
        const wrapUp = round === effectiveToolRounds
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
            ...(round === 0 ? [baseMessage, ...openingMessages] : [baseMessage, ...openingMessages, ...toolMessages]),
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
        upstreamStarted = true
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
            chars += text.length
            answer += text
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
            usage = chunk.usage
          } else if (chunk.type === 'finish') {
            roundFinish = String(chunk.reason.kind)
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
              errored = true
              // 先只记下来：如果接下来要"换档重试"，这条错误就不该发给用户
              // （否则客户端先渲染一条失败提示，重试的正文就贴在失败提示后面了）
              errorMessage =
                chunk.reason.failure?.message ?? `模型调用${chunk.reason.kind === 'aborted' ? '被中断' : '失败'}`
              errorCode = chunk.reason.failure?.code
            }
          }
        }
        emit(think.flush())
        roundDiag.push({
          round,
          wrapUp,
          ms: Date.now() - roundStartedAt,
          raw: roundRaw,
          emitted: roundEmitted,
          think: roundThink,
          finish: roundFinish || '(none)',
          tools: assembler.blocks().filter((block) => block.type === 'tool-call').length,
          ...(body.debug === true ? { tailChunks } : {}),
          outTokens: (usage as { outputTokens?: number } | null)?.outputTokens,
        })
        if (errored) {
          // 附件读不回来（对象仓里的字节被清理/损坏）：把**历史**里的附件全降级成文字再试一次。
          // 这是持久化带来的新故障面 —— 引用的寿命超过了那一轮，字节却不一定还在。
          //
          // ⚠️ 必须排在**换档重试前面**：换档是冲着"上游不认这个推理档"去的，
          // 对"附件读不到"毫无意义 —— 排后面的话会先白烧两次模型调用（实测事件序列就是
          // upstream-retry → upstream-retry → attachments-dropped），还会把档位无谓地换掉。
          if (roundText.length === 0 && historyHadAttachments && !historyDropped && looksLikeAttachmentFailure(errorMessage, errorCode)) {
            historyDropped = true
            historyImages = { kept: 0, omitted: 0, files: 0 }
            openingMessages = [...memoryMessages, ...buildHistoryMessages(), createUserMessage({ source: { kind: 'user' }, content: questionContent })]
            // 历史附件被丢掉了 → 名单跟着缩小（只放"还看得见的"那些）
            attachedPaths = collectAttachedPaths()
            errored = false
            sse(res, {
              type: 'notice',
              code: 'attachments-dropped',
              text: '历史里的附件已经读不回来了（可能被清理过），这一轮先不带上它，其余照常',
            })
            round -= 1
            continue
          }
          // 一个字都没吐出来 → 可以安全重试**同一轮**（保守：已经吐出正文的失败不重试，
          // 免得把半截答案丢掉）。重试换一个没试过的档位，而不是把档位去掉。
          if (roundText.length === 0 && effortRetries > 0) {
            const rejected = roundEffort
            const next = models.nextEffortFor(routeKey, rejected, triedEfforts)
            if (next) {
              effortRetries -= 1
              triedEfforts.add(next)
              // 只有"我们发的这个档位确实不被接受"才值得记成事实：
              //   · 发的是关档 + 上游说"必须开推理" → 这个 route 不吃关档，记下来；
              //   · 发的是开着的档（low/high/max）+ 上游还在说"推理不能关" → **这句不是冲我们来的**
              //     （我们没关它），是上游偶发抽风（实测同档位 5/8 成功）。这种情况不记、不诊断，
              //     只如实说"上游返回了错误，已换档重试"。
              // "必须开推理"这句只有在我们发的是**「关」那一格对应的真实档位**时才算数
              // （模型没有 off、关档落在 minimal/low 上时，字符串比较会漏判）
              const rejectedOffSlot = rejected === offSlotEffort
              const tierIssue = rejectedOffSlot
                ? looksLikeReasoningRequired(errorMessage)
                : looksLikeUnsupportedTier(errorMessage)
              if (rejectedOffSlot && tierIssue) models.markNoOff(routeKey)
              requestEffort = next
              roundEffort = next
              errored = false
              sse(res, {
                type: 'notice',
                code: tierIssue ? 'effort-rejected' : 'upstream-retry',
                ...(tierIssue ? { tier: rejected } : {}),
                text: tierIssue
                  ? rejectedOffSlot
                    ? `该模型不接受「关」档，已自动改用「${EFFORT_LABEL[next] ?? next}」档（以后不再尝试关档）`
                    : `「${EFFORT_LABEL[rejected] ?? rejected}」档该模型不支持，已改用「${EFFORT_LABEL[next] ?? next}」档重试`
                  : '上游这次返回了错误，已自动重试',
              })
              round -= 1
              continue
            }
          }
          sse(res, { type: 'error', message: errorMessage, code: errorCode })
          break
        }
        const blocks: ContentBlock[] = assembler.blocks()
        const calls = blocks.filter((block) => block.type === 'tool-call')
        if (calls.length === 0) {
          // 最终答案到手：如果发出去的是「关」那一格对应的真实档位，检查有没有把思考写进正文
          if (isChat && firstSentEffort === offSlotEffort) {
            const split = splitLeakedReasoning(answer)
            if (split.prefix) {
              models.markLeaky(routeKey)
              answer = split.rest
              chars = answer.length
              sse(res, { type: 'strip', text: split.prefix })
              sse(res, {
                type: 'notice',
                code: 'reasoning-leak',
                // 报**真实档位**（模型可能没有 off，叫 none/minimal）：客户端据此标对那个档位按钮
                tier: firstSentEffort,
                text: '该模型在「关」档会把思考写进正文，已撤回泄漏段；以后这一档会自动改用「低」',
              })
            } else if (looksLikeLeakedReasoning(answer)) {
              // 句式没认准（模型每次换说法）→ 这次不裁（怕误删正文），但记住它，下次自动抬档
              models.markLeaky(routeKey)
              sse(res, {
                type: 'notice',
                code: 'reasoning-leak',
                tier: firstSentEffort,
                text: '这个模型在「关」档会把思考写进正文；这一档以后自动改用「低」',
              })
            }
          }
          break
        }
        // 既然这一轮要调工具，它刚才流出来的正文就是"过程旁白"，不是答案：
        // 让前端把这部分撤回去（顺带当成思考尾巴显示），免得"我怎么想的"混进小窗正文。
        // 实测踩过：追问"搜索今天的新闻"时，模型在工具轮里先吐了一段英文盘算
        // （I have sources with dates… Maybe I should do one more search…），
        // 然后才给中文结论，这段英文被当正文渲染进了消息框。
        if (roundText.length > 0) {
          answer = answer.slice(0, Math.max(0, answer.length - roundText.length))
          sse(res, { type: 'drop', chars: roundText.length, text: roundText.slice(-2000), round })
        }
        // 有的模型不带工具定义也会返回调用；执行端同样遵守开关和轮数上限。
        if (wrapUp || toolSchemas.length === 0) break
        // 执行工具→把结果回灌，再让模型继续（上限 maxToolRounds 轮）
        toolMessages.push(
          createAssistantMessage({
            content: blocks,
            source: { provider: route.provider, model: route.model },
          }),
        )
        const restoredBlocks: ContentBlock[] = []
        toolContextTokens += estimateTextTokens(JSON.stringify(blocks))
        for (const call of calls) {
          if (call.type !== 'tool-call') continue
          toolCalls += 1
          let parsed: unknown = {}
          try {
            parsed = call.arguments ? JSON.parse(call.arguments) : {}
          } catch {
            parsed = {}
          }
          const label2 = describeToolCall(call.name, parsed)
          const callId = String(call.id ?? `round${String(round)}-${String(toolCalls)}`)
          sse(res, { type: 'tool', phase: 'start', callId, name: call.name, detail: label2, round })
          const startedAt = Date.now()
          // 参数名有讲究：read/write/edit 用 file_path，grep/glob 用 path。
          // 只认 path 的话 read 的 file_path 会是 undefined → 边界检查被静默绕过（实测踩过）。
          const rawPath = (parsed as { file_path?: unknown; path?: unknown })?.file_path ?? (parsed as { path?: unknown })?.path
          const wantPath = typeof rawPath === 'string' ? rawPath : ''
          let restored: Awaited<ReturnType<typeof restoreMaterial>> | undefined
          if (call.name === MATERIAL_TOOL.name && toolSchemas.some(schema => schema.name === call.name)) {
            restored = await restoreMaterial(ctx, catalog, parsed, { through: contextState.through, key: typeof body.key === 'string' ? body.key : '',
              maxChars: config.toolResultMaxChars, readMessage: historyStore.readMessage })
            if (restored.restored && capacity && capacity.attachmentPrice(restored.restored) + contextEstimate + toolContextTokens > capacity.budget * 0.95) {
              restored = { content: [{ type: 'text', text: '这份材料超过本轮剩余容量，请减少本轮材料后重新查看。' }], isError: true }
            }
          }
          const execution = restored || (
            !toolSchemas.some((schema) => schema.name === call.name)
              ? { content: [{ type: 'text' as const, text: `（调用已拒绝：${call.name} 不在本次允许的工具中）` }], isError: true }
              : FS_TOOL_NAMES.includes(call.name) && !isReadAllowed(readRoot, wantPath, attachedPaths)
              ? {
                  content: [
                    {
                      type: 'text' as const,
                      text: `（越界已拒绝：文件类工具只能访问当前项目目录${readRoot ? `（${readRoot}）` : ''}，以及用户本次附带的文件；请求的路径是 ${wantPath || '(未给)'}）`,
                    },
                  ],
                  isError: true,
                }
              : await runTool(ctx, call.name, parsed, controller.signal, config.toolResultMaxChars, agent))
          toolContextTokens += estimateTextTokens(JSON.stringify(execution.content))
          if (restored?.restored) {
            const item = restored.restored
            restoredBlocks.push(item.kind === 'image' ? { type: 'image', attachment: item.ref as never } : { type: 'file', attachment: item.ref as never })
            if (capacity) toolContextTokens += capacity.attachmentPrice(item)
            if (item.kind === 'file') {
              const store = ctx.get('attachments') as { fileHostPath?: (ref: unknown) => string | undefined } | undefined
              const path = store?.fileHostPath?.(item.ref)
              if (path) attachedPaths.add(resolve(path))
            }
            sse(res, { type: 'material-restored', attachment: item })
          }
          // 结果也回传：小窗里能看见"查了什么、命中什么、链接是什么"，否则工具是个黑盒
          const digest = digestToolResult(execution.content)
          sse(res, {
            type: 'tool',
            phase: 'done',
            callId,
            name: call.name,
            detail: label2,
            round,
            ok: !execution.isError,
            ms: Date.now() - startedAt,
            chars: digest.chars,
            preview: digest.preview,
            urls: digest.urls,
          })
          toolMessages.push(createToolResultMessage({ callId: call.id, content: execution.content, isError: execution.isError }))
          // 结论轮要用：把"查了什么 + 拿到了什么"写成纯文本，避免重放工具调用链
          toolDigestLines.push(`· ${call.name}（${label2 || '查询'}）：${digest.preview}`)
        }
        recoveredMaterialBlocks.push(...restoredBlocks)
        if (restoredBlocks.length > 0) toolMessages.push(createUserMessage({ source: { kind: 'user' }, content: restoredBlocks }))
      }
      if (!errored && answer.trim().length === 0 && toolCalls > 0 && triedEfforts.size === 1) {
        // 收尾轮常常"只吐一段工具调用、不写正文"（实测「今天的新闻」一个字都没有）。
        // 这里自己补结论轮：**不重放工具调用链**，而是把结果写成一段自包含的提示 ——
        // 重放消息链的方式实测也不稳（模型面对 tool-call 历史仍可能继续吐工具调用）。
        conclusionInfo.tried = true
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
          ...toolDigestLines.slice(0, 12),
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
          if (answer.trim().length > 0) break
          conclusionInfo.rounds += 1
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
                createUserMessage({ source: { kind: 'user' }, content: [...recoveredMaterialBlocks, { type: 'text', text: conclusionUser }] }),
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
                  chars += text.length
                  answer += text
                  conclusionInfo.chars += text.length
                  sse(res, { type: 'delta', text: text })
                }
              } else if (chunk.type === 'usage') {
                usage = chunk.usage
              } else if (chunk.type === 'finish') {
                if (chunk.reason.kind === 'error') {
                  conclusionInfo.error = chunk.reason.failure?.message ?? '模型调用失败'
                }
              }
            }
            const tail = thinkAgain.flush()
            if (tail.think) sse(res, { type: 'thought', text: tail.think })
            if (tail.text) {
              chars += tail.text.length; answer += tail.text; conclusionInfo.chars += tail.text.length
              sse(res, { type: 'delta', text: tail.text })
            }
            // 结论轮也可能把"英文核对过程"写进正文：一律按泄漏裁一次
            const leaked = splitLeakedReasoning(answer)
            if (leaked.prefix) {
              answer = leaked.rest
              chars = answer.length
              sse(res, { type: 'strip', text: leaked.prefix })
              sse(res, { type: 'notice', code: 'reasoning-leak', text: '已去掉模型写进正文的核对过程' })
            }
          } catch (error) {
            if ((error as { code?: string })?.code === 'context-capacity') throw error
            conclusionInfo.error = String((error as Error)?.message ?? error)
            ctx.logger?.warn?.(`[${name}] 结论轮失败：${conclusionInfo.error}`)
          }
        }
      }
      if (!errored && answer.trim().length === 0) {
        // 兜底：连结论轮都没吐字时，至少给一句话（否则面板空白，看起来像"没返回结果"）
        const note =
          toolCalls > 0
            ? '（工具查询完成了，但模型没有产出正文。可以再追问一句"直接说结论"，我按已查到的结果回答。）'
            : '（模型这次没有返回内容，可以点「重新生成」再试一次。）'
        answer = note
        chars += note.length
        sse(res, { type: 'delta', text: note })
      }
      if (!errored) {
        sse(res, {
          type: 'done',
          chars,
          usage,
          toolCalls,
          // 诊断用：结论轮/续写各试了几次、拿到多少字、失败原因
          ...(conclusionInfo.tried ? { conclusion: conclusionInfo } : {}),
          ...(roundDiag.length > 0 ? { rounds: roundDiag } : {}),
          clientClosedEarly,
        })
        if (useResultCache && answer.length > 0) {
          resultCache.set(cacheKey, { at: Date.now(), text: answer })
          if (resultCache.size > 200) {
            const oldest = resultCache.keys().next().value
            if (oldest !== undefined) resultCache.delete(oldest)
          }
        }
      }
    } catch (error) {
      const err = error as Error
      const aborted = err?.name === 'AbortError'
      sse(res, {
        type: 'error',
        ...(!upstreamStarted && (err as { code?: string })?.code === 'context-capacity' ? { code: 'context-rejected' } : {}),
        message: aborted ? `调用超时或已取消（${config.timeoutMs}ms）` : String(err?.message ?? err),
      })
    } finally {
      finished = true
      clearTimeout(timer)
      res.end()
    }
  }
  return { handleAnalyze }
}
