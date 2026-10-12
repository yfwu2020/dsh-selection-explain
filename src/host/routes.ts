import type { createSettingsStore } from './settings-store.js'
import type { createModels } from './models.js'
import type { createSessions } from './sessions.js'
import type { createHistoryStore } from './history-store.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, readBody } from './http.js'
import { quoteContextOf } from './context.js'
import type { ModelChoice } from './models.js'
import type { SessionQueryLike } from './types.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { webFetchUsable } from './tools.js'
import { name, API_PREFIX } from './constants.js'

/** Owns routes state for one plugin instance. */
export function createRoutes(ctx: Context, config: Config, historyStore: ReturnType<typeof createHistoryStore>, sessions: ReturnType<typeof createSessions>, models: ReturnType<typeof createModels>, settingsStore: ReturnType<typeof createSettingsStore>) {

  /**
   * 引用上下文：客户端点了「❝ 引用」之后，拿引用文字来换它所在的那一组对话 ± 一组。
   *
   * 为什么走 host 而不是客户端读 DOM：会话正文的**干净文本**只有 host 这边有
   * （`readSurface` 的事件流里工具调用/结果、系统提示、harness 注入全都被 `transcriptOf`
   * 那套规则滤掉过）。客户端 DOM 里读到的会是"渲染后的样子"——思考块、工具卡片、
   * 按钮文案全混在里面。定位不到（引用来自侧边栏网页/文档预览）就返回 matched:false，
   * 客户端退回它自己采的局部上下文。
   */
  const handleQuoteContext = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const raw = await readBody(req, 200_000)
      let body: { sessionId?: unknown; text?: unknown } = {}
      try {
        body = raw ? (JSON.parse(raw) as { sessionId?: unknown; text?: unknown }) : {}
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      const text = historyStore.clampText(body.text, config.maxSelectionChars)
      if (!sessionId || !text.trim()) {
        sendJson(res, 200, { ok: true, matched: false, context: '', rounds: 0 })
        return
      }
      const events = await sessions.readSurfaceEvents(sessionId)
      const context = quoteContextOf(events, text, {
        roundsAround: config.quoteContextRounds,
        maxCharsPerTurn: config.quoteContextMaxCharsPerTurn,
        maxChars: config.quoteContextMaxChars,
      })
      sendJson(res, 200, {
        ok: true,
        matched: context.matched,
        context: context.transcript,
        rounds: context.rounds,
        chars: context.transcript.length,
      })
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    })
  }

  /** GET /models：给「模型」菜单用（带每个模型支持的推理等级；60 秒缓存）。 */
  async function handleModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await models.loadLeaky() // 不 await 的话，这条路由在读"关档会泄漏"的清单时文件还没载入（实测报空）
    const url = new URL(req.url ?? '/', 'http://localhost')
    const force = url.searchParams.get('refresh') === '1'
    let items: ModelChoice[] = []
    let error = ''
    try {
      items = await models.listModelChoices(force)
    } catch (thrown) {
      error = String((thrown as Error)?.message ?? thrown)
    }
    // 会话级：设置页的「跟随主会话」要显示**当前会话**在用的模型
    let modelsSessionId = ''
    try {
      modelsSessionId = url.searchParams.get('sessionId') ?? ''
    } catch {
      /* 解析不了就当没带 */
    }
    const current = models.resolveRoute(undefined, await sessions.sessionModelOf(modelsSessionId))
    sendJson(res, 200, {
      ok: true,
      current,
      cached: Date.now() - models.modelCache.at < models.MODEL_CACHE_MS,
      ...(error ? { error } : {}),
      models: items,
      // 进程内学到的"关档会把思考写进正文"的模型（客户端据此在菜单里标注；重启后由客户端本地记忆兜着）
      leakyOff: Array.from(models.leakyOnOff),
      // 前端按 provider+model 匹配"当前档"
      stages: {
        chat: config.chatReasoningEffort || config.reasoningEffort,
        translation: config.translationReasoningEffort || config.reasoningEffort,
        detail: config.reasoningEffort,
      },
    })
  }

  /**
   * 极轻的"这一轮会用哪个模型"查询。
   *
   *   GET /selection-explain/api/route?sessionId=…[&chat=1]
   *
   * 为什么单开一条：设置页要**实时**显示当前会话在用的模型，
   * 而 /models 会去列 provider 与模型（42 个，还要端点发现）、/ping 要枚举工具表并探 DNS ——
   * 两者都不适合按秒轮询。这条只做一次会话模型解析 + 一次 resolveRoute。
   *
   * 也是唯一走 `sessionModelOf(…, true)`（短缓存）的地方：客户端在小窗开着时每 2 秒问一次，
   * 不能每拍都重放一次会话日志（见 sessionModelCache 的注释）。
   */
  const handleRoute = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      await settingsStore.loadSettings()
      let sessionId = ''
      let chat = false
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        sessionId = url.searchParams.get('sessionId') ?? ''
        chat = url.searchParams.get('chat') === '1'
      } catch {
        /* 解析不了就当没带 */
      }
      const route = models.resolveRoute(undefined, await sessions.sessionModelOf(sessionId, true), chat)
      sendJson(res, 200, {
        ok: true,
        provider: route?.provider ?? '',
        model: route?.model ?? '',
        // 是不是"跟首轮/次轮同一个"：客户端据此把追问下拉显示成「跟随首轮 / 次轮」
        chatFollows: true,
      })
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    })
  }

  const handlePing = (req: IncomingMessage, res: ServerResponse): void => {
    const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
    // 可以带 ?sessionId=xxx：工具是**按会话作用域**注册的，不带 id 只能看到全局视图（里面没有 web_search）
    let pingSessionId = ''
    try {
      pingSessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? ''
    } catch {
      /* 解析不了就当没带 */
    }
    // 小窗能调哪些工具：白名单是配置，实际放行还要看本机能不能抓网页（见下）。
    // 用 async 包一层：探测 DNS 是异步的，出错也要给出结构化响应（和 history 路由同一写法）。
    void (async () => {
      // 先把用户改过的设置套上：下面报的每一条都必须是**当前生效**的值
      await settingsStore.loadSettings()
      const whitelist = config.toolNames
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
      const agents = ctx.get('agents') as { get?: (id: string) => unknown; list?: () => unknown[] } | undefined
      // 复刻 handleAnalyze 的作用域回退：本会话 agent 取不到就用任一活跃 agent
      let pingAgent = pingSessionId ? agents?.get?.(pingSessionId) : undefined
      let pingScope = pingAgent ? 'session' : ''
      if (!pingAgent) {
        pingAgent = agents?.list?.()?.[0]
        pingScope = pingAgent ? 'fallback' : 'global'
      }
      let visible: string[] = []
      let visibleError = ''
      let toolInfo: Array<{ name: string; desc: string }> = []
      let toolNames: string[] = []
      let sessionToolCount = 0
      try {
        // 必须带着 registry 调（`const f = registry.schemas; f(...)` 会把 this 丢掉 → 拿到空表）
        const registry = ctx.get('tools') as { schemas?: (scope?: unknown) => ToolSchema[] } | undefined
        const all = registry?.schemas?.(pingAgent) ?? []
        sessionToolCount = all.length
        visible = all.map((schema) => schema.name).filter((toolName) => whitelist.includes(toolName))
        // 诊断用：会话里这几个工具到底是哪个插件提供的（描述前 70 字能认出来）
        toolInfo = all.map((schema) => ({
          name: schema.name,
          desc: String(schema.description ?? '').replace(/\s+/g, ' ').slice(0, 70),
        }))
        toolNames = all.map((schema) => schema.name)
      } catch (error) {
        visibleError = String((error as Error)?.message ?? error)
      }
      // 本机抓不了网页时 web_fetch 会被摘掉（探针缓存 5 分钟，这里复用同一个）
      let fetchBlocked = ''
      if (whitelist.includes('web_fetch')) {
        const probe = await webFetchUsable()
        if (!probe.usable) fetchBlocked = probe.sample
      }
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        route: models.resolveRoute(undefined, await sessions.sessionModelOf(pingSessionId)),
        reasoningEffort: config.reasoningEffort,
        modelsRoute: `${API_PREFIX}/models`,
        history: { maxEntries: config.historyMaxEntries, file: historyStore.historyFile() },
        // 三档分开报：一眼看出"首轮为什么快、详解为什么慢"
        reasoningEffortByStage: {
          translation: config.translationReasoningEffort,
          detail: config.reasoningEffort,
          chat: config.chatReasoningEffort,
        },
        // 小窗能用哪些工具：whitelist=配置允许，offered=这一轮真会交给模型的
        tools: {
          enabled: config.tools && config.maxToolRounds > 0,
          whitelist,
          offered: visible.filter((toolName) => !(toolName === 'web_fetch' && fetchBlocked)),
          // 文件类工具的读取边界：'' = 会话工作目录，'*' = 不限制
          readRoot: config.toolReadRoot === '*' ? '(不限)' : config.toolReadRoot || '(会话工作目录)',
          visible: visibleError ? '读取工具表失败：' + visibleError : visible.length,
          // 备用联网工具是否启用（没装 free-search 时会补上 web_search）
          fallback: config.fallbackToolNames,
          preferredSearchPresent: visible.includes('advanced_search') || visible.includes('platform_search'),
          toolInfo,
          toolNames,
          // 这个会话一共能看到多少工具（放行的是白名单里那几个，其余一律不可用）
          sessionTools: sessionToolCount,
          scope: pingScope,
          maxRounds: config.maxToolRounds,
          fetchBlocked,
        },
        sessionContext: config.sessionContext && typeof sessionQuery?.readSurface === 'function',
        // 侧边栏 HTML 预览里的划词桥开关：客户端据此决定要不要往预览帧注入桥脚本
        bridgeSidebarPreview: config.bridgeSidebarPreview,
        // 悬浮胶囊的两个偏好：跟着 ping 一起下发，省得客户端为它单开一次请求
        pill: { enabled: config.pillEnabled, idleMs: config.pillIdleMs },
        limits: {
          maxSelectionChars: config.maxSelectionChars,
          maxContextChars: config.maxContextChars,
          sessionContextMaxMessages: config.sessionContextMaxMessages,
          sessionContextFastMessages: config.sessionContextFastMessages,
          sessionContextMaxChars: config.sessionContextMaxChars,
          quoteContextRounds: config.quoteContextRounds,
          quoteContextMaxChars: config.quoteContextMaxChars,
        },
      })
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    })
  }
  return { handleRoute, handlePing, handleModels, handleQuoteContext }
}
