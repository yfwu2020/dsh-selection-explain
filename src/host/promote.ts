import type { createHistoryStore } from './history-store.js'
import type { createSessions } from './sessions.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, readBody, BODY_LIMIT } from './http.js'
import type { AnalyzeBody } from './types.js'
import { sessionIdOf } from './context.js'
import { name, PLUGIN_SOURCE_KIND } from './constants.js'
import type { LiveSessionLike } from './sessions.js'

/** Owns promote state for one plugin instance. */
export function createPromote(ctx: Context, config: Config, sessions: ReturnType<typeof createSessions>, historyStore: ReturnType<typeof createHistoryStore>) {

  /**
   * 把划词解读小窗「升格」成正式会话（建在来源会话同一个项目下）：
   *   ① 建会话 → ② 注入上下文消息（选中文字/所在位置/上下文片段，生产者自有 kind 的 context 消息）
   *   → ③ 把首轮解读写成助手消息 → ④ 把追问逐轮写成真实的 user/assistant 历史消息
   *   → ⑤ 送一条短开场消息让 agent 接手（这样整段历史才会落盘）。
   * 这样新会话里看到的就是一段真实的多轮对话，而不是一大坨打包文本。
   * live 会话对象拿不到时，退回「打包成一条消息」的老路径，保证升格不会整体失败。
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
      // 注意：session.create 的 workspaceId 与 cwd 互斥（同时传会报
      // "session.create accepts workspaceId or cwd, not both"）——有 workspace 就只传它
      const created = await controller.create(workspaceId ? { workspaceId } : cwd ? { cwd } : {})
      const newSessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
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

      const label = historyStore.clampText(body.label, 80) || '页面内容'
      const contextText = historyStore.clampText(body.context, config.maxContextChars) || '（未记录）'
      const translation = historyStore.clampText(body.translation, 8000)
      const detail = historyStore.clampText(body.detail, 12000)
      const turns = (Array.isArray(body.turns) ? body.turns : [])
        .slice(-20)
        .map((turn) => turn as { role?: unknown; text?: unknown; seed?: unknown })
        .filter((turn) => turn.seed !== true && typeof turn.text === 'string' && turn.text.trim().length > 0)
        .map((turn) => ({ role: turn.role === 'assistant' ? 'assistant' : 'user', text: (turn.text as string).trim() }))

      const live = (ctx.get('sessions') as { get?: (id: string) => LiveSessionLike | undefined } | undefined)?.get?.(
        newSessionId,
      )
      let seeded = false
      if (live && typeof live.append === 'function') {
        const stamp = Date.now().toString(36)
        /**
         * 把一轮写进日志：turn/start → step/start → 消息 → step/end → turn/end。
         * ⚠️ 必须带这层骨架：客户端会话视图是按 turn/step 事件给消息定位的，
         * 裸写 user/message、assistant/message 会因为拿不到坐标而不显示成历史对话。
         */
        // 轮号从 1000 起：客户端按「轮号」分组（Map<number>），而新建会话里 agent 的第一轮
        // 一定从 1 开始（phase.turn 初始为 0），所以历史轮必须避开低位号段，
        // 否则历史的 turn 1 会和真实的 turn 1 并成同一组、看起来"历史没进去"。
        // 同时这也是 resume 语义安全的：resume 时 phase.turn = lastTurn + 1 = 1000+N+1，仍不与历史重号。
        let turnNo = 1000
        const appendTurn = (userEvent: Record<string, unknown> | null, assistantText: string): void => {
          turnNo += 1
          const turn = turnNo
          live.append?.('turn/start', { turn })
          live.append?.('step/start', { turn, step: 1 })
          if (userEvent) live.append?.('user/message', userEvent, { surfaceOp: 'append' })
          live.append?.(
            'assistant/message',
            {
              turn,
              step: 1,
              stream: [],
              message: {
                id: `sel-a-${stamp}-${turn}`,
                role: 'assistant',
                source: { kind: 'model', provider: 'dsh-selection-explain', model: '划词解读小窗' },
                content: [{ type: 'text', text: assistantText }],
              },
            },
            { surfaceOp: 'append' },
          )
          live.append?.('step/end', { turn, step: 1 })
          live.append?.('turn/end', { turn, reason: { kind: 'completed' } })
        }

        // 第 1 轮：上下文消息（生产者自有的 source.kind + snapshot 呈现）+ 首轮解读
        // ⚠️ kind 必须是 PLUGIN_SOURCE_KIND（`plugin:<插件名>`）：会话格式 v4 起不再
        // 接受退役的 `plugin` 包装（`kind: 'plugin'` 加一个 `plugin` 字段），否则整场升格
        // 会死在 "format v4 message requires a producer-owned source kind" 上（见文件头常量注释）。
        const contextBody = [
          `选中文字：${text}`,
          `所在位置：${label}`,
          `来源：划词解读小窗${sourceSessionId ? `（来源会话 ${sourceSessionId}）` : ''}`,
          '',
          '选中处的上下文片段：',
          contextText,
        ].join('\n')
        const explanation = ['翻译', translation || '（未记录）', '', '详解', detail || '（未记录）'].join('\n')
        appendTurn(
          {
            id: `sel-ctx-${stamp}`,
            role: 'user',
            source: {
              kind: PLUGIN_SOURCE_KIND,
              form: 'snapshot',
              sections: [
                { name: '划词解读 · 选中文字', text },
                { name: '划词解读 · 所在位置', text: label },
                { name: '划词解读 · 上下文片段', text: contextText },
              ],
            },
            content: [{ type: 'text', text: contextBody }],
          },
          explanation,
        )
        // 后续轮：小窗里的追问逐轮写成真实问答
        for (let i = 0; i < turns.length; i += 1) {
          const turn = turns[i]
          if (!turn) continue
          if (turn.role === 'user') {
            appendTurn(
              {
                id: `sel-u-${stamp}-${i}`,
                role: 'user',
                source: { kind: 'user' },
                content: [{ type: 'text', text: turn.text }],
              },
              turns[i + 1] && turns[i + 1]?.role === 'assistant' ? (turns[i + 1]?.text ?? '') : '（未记录）',
            )
            i += 1 // 助手回答已随本轮写入
          } else {
            // 落单的助手消息（历史里没有对应提问）：单独成一轮
            appendTurn(null, turn.text)
          }
        }
        seeded = true
      }

      // ⑤ 开场消息：让 agent 接手（也是整段历史落盘的触发点）
      const opener = seeded
        ? '（本会话由划词解读小窗升格而来，以上是这段文字的上下文与我们的讨论）请用一句话确认，然后等我继续提问。'
        : [
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
