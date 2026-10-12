import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { SessionModel, SessionsLike, SessionQueryLike, BackgroundOptions, SessionBackground } from './types.js'
import { name } from './constants.js'
import { transcriptOf } from './context.js'

/** 可写的 live 会话（只用到 append）。 */
export interface LiveSessionLike {
  append?: (type: string, data: unknown, options?: unknown) => unknown
}

/** Owns sessions state for one plugin instance. */
export function createSessions(ctx: Context, config: Config) {

  /** 会话背景短缓存：同一会话 10 秒内复用（连续划词不重复读日志）。 */
  const backgroundCache = new Map<string, { at: number; events: readonly unknown[] }>()

  /**
   * 「本会话在用哪个模型」的短缓存 —— 只给按秒轮询的 `/route` 用（见 sessionModelOf）。
   *
   * 为什么需要：`readSession` 会把整份日志重放成一个 Session、再逐条深拷贝一遍
   * （本机实测 1.5MB 的会话一次 80~125ms）。跟随状态下**小窗一开着**就要每 2 秒问一次，
   * 不缓存等于每 2 秒在宿主进程里重放一次会话日志。
   *
   * 变更探测用 live 会话的 `seq`（同步、零成本，见 liveSeqOf）：没涨就直接回缓存；
   * 涨了（主会话正在连续对话时每轮都在涨）也至少隔 SESSION_MODEL_MIN_MS 才重读一次，
   * 否则"小窗开着 + 主会话在聊"时每 2 秒照样重放。非 live（磁盘上的旧会话，读不到 seq）按 TTL 兜底。
   */
  const sessionModelCache = new Map<string, { at: number; seq: number | null; value: SessionModel | null }>()

  /** 同一会话正在飞的读取（读可能比轮询间隔还慢，叠起来没意义）。 */
  const sessionModelPending = new Map<string, Promise<SessionModel | null>>()

  /** live 会话两次重读之间的最短间隔（挡住"事件一直在涨"时的连续重放）。 */
  const SESSION_MODEL_MIN_MS = 3_000

  /** 读不到 seq（非 live）时的兜底 TTL。 */
  const SESSION_MODEL_TTL_MS = 10_000

  /**
   * live 会话的事件数（`Session.seq` = 日志长度，每次 append 都会涨）。
   *
   * 这是**零成本**的同步读取：不用读日志、不用重放，就能判断"会话有没有新事件"。
   * 拿不到（会话不在内存里 / 老内核没有 sessions 服务）返回 null，调用方退回 TTL。
   */
  const liveSeqOf = (sessionId: string): number | null => {
    const sessions = ctx.get('sessions') as SessionsLike | undefined
    const seq = sessions?.get?.(sessionId)?.seq
    return typeof seq === 'number' ? seq : null
  }

  /** 读取当前会话的模型界面事件（live 优先；失败/超时一律降级为「无背景」）。 */
  const readSurfaceEvents = async (sessionId: string): Promise<readonly unknown[]> => {
    const cached = backgroundCache.get(sessionId)
    if (cached && Date.now() - cached.at < 10_000) return cached.events
    const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (typeof sessionQuery?.readSurface !== 'function') return []
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))
    try {
      const surface = await Promise.race([sessionQuery.readSurface(sessionId), timeout])
      const events = surface && Array.isArray(surface.events) ? surface.events : []
      backgroundCache.set(sessionId, { at: Date.now(), events })
      if (backgroundCache.size > 8) {
        const oldest = backgroundCache.keys().next().value
        if (oldest !== undefined) backgroundCache.delete(oldest)
      }
      return events
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] 读取会话背景失败（${sessionId}）：${String((error as Error)?.message ?? error)}`)
      return []
    }
  }

  /**
   * 真读一次：拿会话原始事件里的最后一条 `model/selection`。
   *
   * 来源：会话事件流里的 `model/selection`（每条 = 一次"后续请求用这个模型"的选择，
   * 形如 `{ type:'model/selection', data:{ provider, model, reasoningEffort? } }`）。
   * 取**最后一条** = 会话当前在用的那个；一条都没有（新会话）就返回 null，调用方落回全局默认。
   */
  const readSessionModel = async (sessionId: string): Promise<SessionModel | null> => {
    if (!sessionId) return null
    const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (typeof sessionQuery?.readSession !== 'function') return null
    let events: readonly unknown[] = []
    try {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))
      const log = await Promise.race([sessionQuery.readSession(sessionId), timeout])
      events = log && Array.isArray((log as { events?: unknown }).events) ? ((log as { events: readonly unknown[] }).events) : []
    } catch {
      return null
    }
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (!event || typeof event !== 'object') continue
      const typed = event as { type?: unknown; data?: unknown }
      if (typed.type !== 'model/selection') continue
      const data = (typed.data ?? {}) as { provider?: unknown; model?: unknown }
      if (typeof data.provider === 'string' && data.provider && typeof data.model === 'string' && data.model) {
        return { provider: data.provider, model: data.model }
      }
    }
    return null
  }

  /**
   * 记下这次的结论（连同"读到它时的 seq"）：下次轮询就能靠 seq 判断结论还有效没。
   *
   * 顺手也把"用户动作路径"读到的值种进缓存 —— 那是**此刻**那一份，
   * 种进来只会让轮询更少重读、更不容易报旧值。
   */
  const rememberSessionModel = (sessionId: string, seq: number | null, value: SessionModel | null): void => {
    sessionModelCache.set(sessionId, { at: Date.now(), seq, value })
    if (sessionModelCache.size > 8) {
      const oldest = sessionModelCache.keys().next().value
      if (oldest !== undefined) sessionModelCache.delete(oldest)
    }
  }

  /**
   * 读**当前会话**自己的模型选择。
   *
   * `useCache` 只给按秒轮询的 `/route` 打开；用户动作路径（analyze / models / ping）一律直读，
   * 拿到的必须是**此刻**那一份 —— 不能让人刚在主会话里换完模型、划词却按旧模型解析。
   * 直读的结果会顺手种进缓存（见 rememberSessionModel）。
   */
  const sessionModelOf = async (sessionId: string, useCache = false): Promise<SessionModel | null> => {
    if (!sessionId) return null
    if (!useCache) {
      // seq 在读**之前**取：读的过程中若又落了事件，缓存就应当被视为旧值（宁可下次重读）
      const seqNow = liveSeqOf(sessionId)
      const value = await readSessionModel(sessionId)
      rememberSessionModel(sessionId, seqNow, value)
      return value
    }
    const seq = liveSeqOf(sessionId)
    const cached = sessionModelCache.get(sessionId)
    if (cached) {
      // 事件没涨 → 结论不可能变。只对 live 会话成立：`seq` 是同步的，每次 append 都会涨。
      if (seq !== null && cached.seq === seq) return cached.value
      // 涨了也不立刻重读：主会话正在连续对话时事件一直在涨，否则每 2 秒照样重放一次日志。
      const floor = seq === null ? SESSION_MODEL_TTL_MS : SESSION_MODEL_MIN_MS
      if (Date.now() - cached.at < floor) return cached.value
    }
    // 同一会话的轮询叠在一起（读可能比轮询间隔还慢）时共用一个在飞的请求
    const pending = sessionModelPending.get(sessionId)
    if (pending) return pending
    const task = readSessionModel(sessionId)
      .then((value) => {
        rememberSessionModel(sessionId, seq, value)
        return value
      })
      .finally(() => {
        sessionModelPending.delete(sessionId)
      })
    sessionModelPending.set(sessionId, task)
    return task
  }

  /** 组装会话背景文本。 */
  const loadSessionBackground = async (
    sessionId: string,
    options: BackgroundOptions,
  ): Promise<SessionBackground | null> => {
    const events = await readSurfaceEvents(sessionId)
    if (events.length === 0) return null
    const background = transcriptOf(events, options)
    return background.transcript ? background : null
  }

  /** 解析一个会话的工作目录（同项目 = 同 cwd）。 */
  const resolveSessionCwd = async (sessionId: string): Promise<string | undefined> => {
    if (!sessionId) return undefined
    const sessions = ctx.get('sessions') as
      | { get?: (id: string) => { header?: { cwd?: string } } | undefined }
      | undefined
    const live = sessions?.get?.(sessionId)?.header?.cwd
    if (live) return live
    const sessionQuery = ctx.get('sessionQuery') as
      | { readSession?: (id: string) => Promise<{ session?: { cwd?: string } }> }
      | undefined
    try {
      const log = await sessionQuery?.readSession?.(sessionId)
      return log?.session?.cwd
    } catch {
      return undefined
    }
  }
  return { sessionModelOf, loadSessionBackground, resolveSessionCwd, readSurfaceEvents }
}
