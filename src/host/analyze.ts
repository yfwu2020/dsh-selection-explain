import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { executeAnalyze } from './analyze-execution.js'
import { prepareAnalyzeMessages } from './analyze-messages.js'
import { startAnalyzeOutput } from './analyze-output.js'
import { prepareAnalyzePrompt } from './analyze-prompt.js'
import { prepareAnalyzeRequest } from './analyze-request.js'
import { planAnalyzeTools } from './analyze-tools.js'
import type { Config } from './config.js'
import { name } from './constants.js'
import { sessionIdOf } from './context.js'
import type { createHistoryStore } from './history-store.js'
import { sse } from './http.js'
import type { createModels } from './models.js'
import type { createSessions } from './sessions.js'

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

  const deps = { ctx, config, models, sessions, historyStore }

  const handleAnalyze = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const request = await prepareAnalyzeRequest(req, res, deps, allow)
    if (!request) return
    const { body, route, effort, background, text, context, label, isChat } = request
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

    const tools = await planAnalyzeTools(deps, request)
    const prompt = await prepareAnalyzePrompt(deps, request, tools, res)
    startAnalyzeOutput(res, request, tools, prompt)
    const messages = await prepareAnalyzeMessages(deps, request, tools, prompt, res, controller)
    if (!messages) {
      finished = true
      clearTimeout(timer)
      res.end()
      return
    }
    const executionState = { upstreamStarted: false }
    try {
      const answer = await executeAnalyze({ deps, request, tools, prompt, messages, res, controller, executionState, clientClosedEarly: () => clientClosedEarly })
      if (useResultCache && answer && answer.length > 0) {
        resultCache.set(cacheKey, { at: Date.now(), text: answer })
        if (resultCache.size > 200) {
          const oldest = resultCache.keys().next().value
          if (oldest !== undefined) resultCache.delete(oldest)
        }
      }
    } catch (error) {
      const err = error as Error
      const aborted = err?.name === 'AbortError'
      sse(res, {
        type: 'error',
        ...(!executionState.upstreamStarted && (err as { code?: string })?.code === 'context-capacity' ? { code: 'context-rejected' } : {}),
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
