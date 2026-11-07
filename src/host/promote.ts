import type { createHistoryStore } from './history-store.js'
import type { createSessions } from './sessions.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, readBody, BODY_LIMIT } from './http.js'
import type { AnalyzeBody } from './types.js'
import { sessionIdOf } from './context.js'
import { name } from './constants.js'
import { randomUUID } from 'node:crypto'
import { buildPromoteSeed } from './promote-seed.js'
import type { PromoteSeedEvent } from './promote-seed.js'
import { readHistoryAttachments } from './history-attachments.js'

interface AgentComposition {
  agentPreset?: string
  setup: unknown
}
interface AgentComposer {
  composeAgent?: (preset: undefined) => Promise<AgentComposition>
}
interface SeededAgents {
  create?: (options: {
    sessionId: string
    seed: PromoteSeedEvent[]
    inheritedEventCount: number
    meta: { isSeeded: true; cwd?: string; agentPreset?: string }
    agentOptions?: { provider: string; model: string }
    setup: unknown
  }) => Promise<unknown>
}

/** Owns promote state for one plugin instance. */
export function createPromote(ctx: Context, config: Config, sessions: ReturnType<typeof createSessions>, historyStore: ReturnType<typeof createHistoryStore>) {

  /**
   * 把划词解读小窗「升格」成正式会话（建在来源会话同一个项目下）：
   * 先构造真实多轮历史，再作为 seed 创建 agent；内核从历史初始化下一轮编号。
   * 不支持 seed 或无法复用宿主的 agent 配置时，退回打包 prompt。
   */
  const handlePromote = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
    if (!text) {
      sendJson(res, 400, { error: '缺少 text（选中文字）' })
      return
    }
    const controller = ctx.get('sessionController') as
      | {
          composeAgent?: AgentComposer['composeAgent']
          agents?: AgentComposer
          create?: (request: { workspaceId?: string; cwd?: string; agentPreset?: string }) => Promise<{ sessionId?: string }>
          rename?: (request: { sessionId: string; title: string }) => Promise<unknown>
          prompt?: (
            request: {
              requestId: string
              sessionId: string
              mode: 'queue' | 'steer'
              content: Array<{ type: 'text'; text: string }>
            },
            signal: AbortSignal,
          ) => Promise<unknown>
        }
      | undefined
    if (typeof controller?.create !== 'function' || typeof controller?.prompt !== 'function') {
      sendJson(res, 503, { error: '当前部署不支持创建会话（sessionController 不可用）' })
      return
    }
    const sourceSessionId = sessionIdOf(body)
    const cwd = await sessions.resolveSessionCwd(sourceSessionId)
    // 会话在侧栏里的「项目分组」= workspace 的 sessionIds（按 canonical cwd 索引）。
    // 只传 cwd 不够：还要带上 workspaceId，并在建好后把它挂到该 workspace 上（双保险）。
    const registry = ctx.get('workspaceRegistry') as
      | {
          resolveByPath?: (path: string) => Promise<{ id?: string } | undefined>
          get?: (id: string) => { sessionIds?: readonly string[]; attachSession?: (sessionId: string) => Promise<void> } | undefined
        }
      | undefined
    let workspaceId: string | undefined
    if (cwd) {
      try {
        const workspace = await registry?.resolveByPath?.(cwd)
        if (typeof workspace?.id === 'string') workspaceId = workspace.id
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] 解析 workspace 失败（${cwd}）：${String((error as Error)?.message ?? error)}`)
      }
    }
    try {
      const label = historyStore.clampText(body.label, 80) || '页面内容'
      const contextText = historyStore.clampText(body.context, config.maxContextChars) || '（未记录）'
      const translation = historyStore.clampText(body.translation, 8000)
      const detail = historyStore.clampText(body.detail, 12000)
      const turns = (Array.isArray(body.turns) ? body.turns : [])
        .map((turn) => turn as { role?: unknown; text?: unknown; seed?: unknown; attachments?: unknown })
        .filter((turn) => turn.seed !== true && typeof turn.text === 'string' && turn.text.trim().length > 0)
        .map((turn) => ({
          role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          text: (turn.text as string).trim(),
          // 附件（图片/文件）随轮次一起带过来 —— 走的是和 /analyze、历史落盘**同一个收敛器**。
          // 客户端本来就在发它们（exportTurns 带 attachments），是这里以前只认 role/text 把它们丢了，
          // 于是升格出来的会话「声称带了附件、却看不到图」。
          attachments: readHistoryAttachments(turn.attachments),
        }))

      const agents = ctx.get('agents') as SeededAgents | undefined
      // The composer moved under controller.agents in newer hosts. Preserve its
      // preset mounting and model-selection setup, as the host's fork path does.
      const composer = typeof controller.composeAgent === 'function' ? controller : controller.agents
      // Without cwd only normal creation can supply the host's default workspace.
      // A cwd-less seeded session is omitted from the sidebar and cannot be resumed.
      const seeded = !!cwd && typeof agents?.create === 'function' && typeof composer?.composeAgent === 'function'
      let newSessionId: string
      if (seeded) {
        const composition = await composer!.composeAgent!(undefined)
        const seed = buildPromoteSeed({ text, label, contextText, translation, detail, sourceSessionId, turns })
        newSessionId = `session-${randomUUID()}`
        const selection = (ctx.get('agentDefaultModel') as {
          currentSelection?: () => { provider: string; model: string }
        } | undefined)?.currentSelection?.()
        await agents!.create!({
          sessionId: newSessionId,
          seed,
          inheritedEventCount: seed.length,
          meta: {
            isSeeded: true,
            ...(cwd ? { cwd } : {}),
            ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}),
          },
          ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
          setup: composition.setup,
        })
      } else {
        // session.create accepts workspaceId or cwd, never both.
        const created = await controller.create(workspaceId ? { workspaceId } : cwd ? { cwd } : {})
        newSessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
      }
      if (!newSessionId) {
        sendJson(res, 500, { error: '创建会话失败：未返回会话 id' })
        return
      }
      // 兜底：若 cwd 索引还没把它算进该 workspace，显式 attach 一次
      if (workspaceId) {
        try {
          const workspace = registry?.get?.(workspaceId)
          if (workspace && !(workspace.sessionIds ?? []).includes(newSessionId)) {
            await workspace.attachSession?.(newSessionId)
          }
        } catch (error) {
          ctx.logger?.warn?.(`[${name}] 挂载会话到 workspace 失败：${String((error as Error)?.message ?? error)}`)
        }
      }
      const title = `划词解读：${text.replace(/\s+/g, ' ').slice(0, 24)}`
      try {
        await controller.rename?.({ sessionId: newSessionId, title })
      } catch {
        /* 标题失败不影响升格 */
      }

      // A host without seeded creation gets a normal prompt carrying the
      // background. Never inject execution events into an already-created agent.
      if (!seeded) {
        const opener = [
            '【划词解读 · 升格为会话】',
            '下面这段文字来自一次划词解读小窗；上下文、结论与小窗里的追问一并附上，作为本次会话的既有背景。',
            '',
            '■ 选中文字',
            text,
            '',
            '■ 所在位置',
            label,
            '',
            '■ 选中处的上下文片段',
            contextText,
            '',
            '■ 解读 · 翻译',
            translation || '（未记录）',
            '',
            '■ 解读 · 详解',
            detail || '（未记录）',
            ...(turns.length > 0 ? ['', '■ 小窗里的追问', ...turns.map((t) => `${t.role === 'assistant' ? '答' : '我问'}：${t.text}`)] : []),
            '',
            '以上是背景，请把它作为本次会话的既有上下文；先不需要展开，等我继续提问。',
          ].join('\n')
        const promoteController = new AbortController()
        await controller.prompt(
          {
            requestId: `sel-promote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId: newSessionId,
            mode: 'queue',
            content: [{ type: 'text', text: opener }],
          },
          promoteController.signal,
        )
      }
      sendJson(res, 200, {
        ok: true,
        sessionId: newSessionId,
        cwd: cwd ?? null,
        workspaceId: workspaceId ?? null,
        mode: seeded ? 'history' : 'packed',
      })
    } catch (error) {
      sendJson(res, 500, { error: `升格失败：${String((error as Error)?.message ?? error)}` })
    }
  }
  return { handlePromote }
}
