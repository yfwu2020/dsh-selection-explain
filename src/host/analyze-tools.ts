import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PreparedAnalyzeRequest } from './analyze-request.js'
import type { AnalyzeDependencies } from './analyze-types.js'
import { MATERIAL_TOOL } from './chat-materials.js'
import { name } from './constants.js'
import { sessionIdOf } from './context.js'
import { FS_TOOL_NAMES, resolveToolNames, webFetchUsable } from './tools.js'

export interface AnalyzeToolPlan {
  agent: unknown
  agentScope: string
  sessionId: string
  toolSchemas: ToolSchema[]
  toolFallbackUsed: boolean
  fetchBlockedSample: string
  wantsFsTools: boolean
  readRoot: string
}

/** Resolve session scope, allowed tools, fetch availability and filesystem boundary. */
export async function planAnalyzeTools(deps: AnalyzeDependencies, request: PreparedAnalyzeRequest): Promise<AnalyzeToolPlan> {
  const { ctx, config, sessions } = deps
  const { body, isChat, history } = request
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

  if (isChat && config.tools && config.maxToolRounds > 0 && (history.rawHistory.length > 0 || history.catalog.length > 0 || history.contextState.through > 0)) {
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


  return { agent, agentScope, sessionId, toolSchemas, toolFallbackUsed, fetchBlockedSample, wantsFsTools, readRoot }
}
