import type { createSettingsStore } from './settings-store.js'
import type { createModels } from './models.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { name } from './constants.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, readBody } from './http.js'
import type { AnalyzeBody } from './types.js'
import { readHistoryAttachments } from './history-attachments.js'
import type { HistoryAttachment } from './history-attachments.js'
import { readContextState } from '../chat-context.js'
import type { ContextState } from '../chat-context.js'

// ───────────────────────── 小窗对话历史（A′） ─────────────────────────
//
// 为什么不建成会话：会话是重型对象（侧栏条目 + 磁盘目录 + 索引），而且当前
// 部署**没有删除会话的接口**——一个高频功能每次划词建一个会话，只会堆积成
// 一堆删不掉的死会话。所以这里把"整段对话"存在插件自己的目录里：
//   · 一个条目 = 一次划词解读（含它自己的全部追问轮次）
//   · 只留最近 `historyMaxEntries` 个条目（LRU），包括已升格的条目
//   · 重划同一个词 → 直接回放，不调模型

interface HistoryTurn {
  role: string
  text: string
  contextExcluded?: boolean
  /**
   * 这一轮带的附件（只有 user 轮会有）：`[{ kind, ref }]`，ref 是附件服务的持久引用。
   *
   * 存它 = 让"第 N 轮还能看见第 1 轮那张图"成为可能。**存的只是引用**
   * （内容哈希 + 名字 + 字节数 + 像素），没有 base64、没有本地路径 ——
   * 与主会话往会话事件里写的是同一套形状，代价是每轮几百字节而不是几 MB。
   * 载荷的大小由 history-attachments.ts 的预算管，这里只负责**如实存下来**。
   */
  attachments?: HistoryAttachment[]
}

/** 落库入参：一律宽松收，内部统一裁剪（来源是浏览器，不能信）。 */
interface HistoryInput {
  key?: unknown
  text?: unknown
  context?: unknown
  label?: unknown
  parts?: { translation?: unknown; detail?: unknown }
  /** 轮次（含每轮的附件引用）：形状由 readTurns 统一收敛，这里一律宽松收。 */
  contextState?: unknown
  turns?: unknown
  toolDigest?: unknown
  pinned?: unknown
  /**
   * 这段对话**压根没有解读**（语音卡那条"跳过翻译与详解、直接追问"的路）。
   *
   * 必须落盘：回放时面板就是靠它决定「翻译」一节画不画。少了它，回放会在
   * 一句"（这次没有返回内容）"的空卡片上重开一段本来就没有翻译的对话 ——
   * 用户实测（2026-10-19）：跳过翻译直接追问的那段对话，再开一次时那张
   * 翻译卡片又冒出来了。注意它不是"翻译返回为空"（那是模型没给内容，
   * 该如实说一声），而是"这一轮从来没请求过解读"。
   */
  skipped?: unknown
  /**
   * 截图提问的会话标题（模型单独起的名字，如「预算逻辑」）。
   *
   * 单独存字段，不再只塞进 `label`：`label` 是"选中文字所在位置"的语义，
   * 截图后续每次 saveHistory 都会把 label 写回「截图」——标题会因此丢。
   */
  title?: unknown
}

interface HistoryEntry {
  key: string
  text: string
  context: string
  label: string
  /** 截图提问的会话标题；只有截图对话才有。 */
  title?: string
  at: number
  parts: { translation: string; detail: string }
  contextState?: ContextState
  turns: HistoryTurn[]
  toolDigest: string
  /** 兼容旧格式的已升格标记，仅用于展示，不影响历史淘汰。 */
  pinned: boolean
  /**
   * 这段对话**没有解读**（见 HistoryInput.skipped）。
   *
   * 三态，别把它降成布尔：`true` = 明确没有解读；`false` = 明确跑过解读；
   * **键不存在** = 老条目，不知道（那时候还没有这个字段）。
   *
   * ⚠️ 以前这里写成必填布尔，读盘时一句 `entry.skipped === true` 就把"不知道"
   * 改写成 `false`，写盘又整份覆盖——未知状态被永久抹掉，客户端再怎么兜也没用
   * （2026-10-19 用户实测：14 条老对话一直顶着空翻译卡片）。
   */
  skipped?: boolean
}

/** Owns history-store state for one plugin instance. */
export function createHistoryStore(ctx: Context, config: Config, models: ReturnType<typeof createModels>, settingsStore: ReturnType<typeof createSettingsStore>) {

  // Bind this instance once: a pending write must not follow later environment changes.
  const dataDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'selection-explain')

  const history = new Map<string, HistoryEntry>()

  let historyLoaded = false

  let historyTimer: ReturnType<typeof setTimeout> | null = null

  const historyFile = (): string =>
    join(dataDir, 'history.json')

  /**
   * 悬浮胶囊"拖到别处"后的位置（用户要求记住，存 host 上 —— 不用 localStorage）。
   * 只记自由摆放的**右边缘 + 垂直中心**：收球/展开都以右边缘为锚（client 半的 applyFreePill 用 CSS right 钉住）。
   * 吸附回右下角（anchor）时会清掉 —— 那是默认位置，不需要记。
   */
  const pillPosFile = (): string =>
    join(dataDir, 'pill.json')

  let pillPos: { right: number; y: number } | null = null

  let pillPosLoaded = false

  let pillPosTimer: ReturnType<typeof setTimeout> | null = null

  /** 位置校验：只接受有限数值，并夹到一个"任何屏幕都放得下"的量级。 */
  function normalizePillPos(input: unknown): { right: number; y: number } | null {
    const value = input as { right?: unknown; y?: unknown } | null | undefined
    const right = typeof value?.right === 'number' && Number.isFinite(value.right) ? value.right : NaN
    const y = typeof value?.y === 'number' && Number.isFinite(value.y) ? value.y : NaN
    if (!Number.isFinite(right) || !Number.isFinite(y)) return null
    const clamp = (n: number): number => Math.round(Math.min(40000, Math.max(-40000, n)))
    return { right: clamp(right), y: clamp(y) }
  }

  async function loadPillPos(): Promise<void> {
    if (pillPosLoaded) return
    pillPosLoaded = true
    try {
      const parsed = JSON.parse(await readFile(pillPosFile(), 'utf8')) as { position?: unknown }
      pillPos = normalizePillPos(parsed?.position)
    } catch {
      pillPos = null // 没存过 / 坏了都当作"没记过"
    }
  }

  function schedulePillPosWrite(): void {
    if (pillPosTimer) clearTimeout(pillPosTimer)
    pillPosTimer = setTimeout(() => {
      pillPosTimer = null
      void (async () => {
        try {
          await mkdir(dataDir, { recursive: true })
          await writeFile(pillPosFile(), JSON.stringify({ version: 1, position: pillPos }, null, 0), 'utf8')
        } catch (error) {
          ctx.logger?.warn?.(`[${name}] 写入胶囊位置失败：${String((error as Error)?.message ?? error)}`)
        }
      })()
    }, 300)
    pillPosTimer.unref?.()
  }

  /**
   * 小窗的**尺寸**（拖角改过大小之后记下来）。
   *
   * 只记尺寸，**不记位置**：小窗每次开窗都由 client 按选区重新锚定
   * （落在选区下方，放不下就翻到上方，再夹进视口）—— 那套锚定逻辑是既有的设计，
   * 位置一旦被"记住"就等于架空了它，开窗不再跟着划词的地方走。
   * 尺寸则是用户明确调过的东西，值得跨开窗保留。
   */
  const panelSizeFile = (): string =>
    join(dataDir, 'panel.json')

  let panelSize: { w: number; h: number } | null = null

  let panelSizeLoaded = false

  let panelSizeTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 尺寸校验：两个数都得是有限值，并夹到一个合理的区间。
   *
   * client 那边已经有 min/max 了，但文件是手工可编辑的（也可能被旧版本写坏），
   * 不能让一个 5px 宽的小窗把界面弄成没法用。
   */
  function normalizePanelSize(input: unknown): { w: number; h: number } | null {
    const value = input as { w?: unknown; h?: unknown } | null | undefined
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
    const w = num(value?.w)
    const h = num(value?.h)
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null
    const clamp = (n: number, lo: number, hi: number): number => Math.round(Math.min(hi, Math.max(lo, n)))
    return { w: clamp(w, 280, 4000), h: clamp(h, 200, 4000) }
  }

  async function loadPanelSize(): Promise<void> {
    if (panelSizeLoaded) return
    panelSizeLoaded = true
    try {
      const parsed = JSON.parse(await readFile(panelSizeFile(), 'utf8')) as { size?: unknown }
      panelSize = normalizePanelSize(parsed?.size)
    } catch {
      panelSize = null // 没存过 / 坏了都当作"没调过"
    }
  }

  function schedulePanelSizeWrite(): void {
    if (panelSizeTimer) clearTimeout(panelSizeTimer)
    panelSizeTimer = setTimeout(() => {
      panelSizeTimer = null
      void (async () => {
        try {
          await mkdir(dataDir, { recursive: true })
          await writeFile(panelSizeFile(), JSON.stringify({ version: 1, size: panelSize }, null, 0), 'utf8')
        } catch (error) {
          ctx.logger?.warn?.(`[${name}] 写入小窗尺寸失败：${String((error as Error)?.message ?? error)}`)
        }
      })()
    }, 300)
    panelSizeTimer.unref?.()
  }

  /**
   * 小窗尺寸：GET 读回来（挂载时恢复）、POST 存（{w,h}）或清（{clear:true}，回到默认尺寸）。
   */
  const handlePanelSize = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      await loadPanelSize()
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, size: panelSize })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
        return
      }
      const raw = await readBody(req, 4_000)
      let body: { size?: unknown; clear?: unknown } = {}
      try {
        body = raw ? (JSON.parse(raw) as { size?: unknown; clear?: unknown }) : {}
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      if (body.clear === true) {
        panelSize = null
        schedulePanelSizeWrite()
        sendJson(res, 200, { ok: true, size: null })
        return
      }
      const next = normalizePanelSize(body.size ?? body)
      if (!next) {
        sendJson(res, 400, { ok: false, error: 'size 需要 { w, h } 两个有限数值' })
        return
      }
      panelSize = next
      schedulePanelSizeWrite()
      sendJson(res, 200, { ok: true, size: panelSize })
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    })
  }

  /**
   * 胶囊位置：GET 读回来（挂载时恢复）、POST 存（{right,y}）或清（{clear:true}，吸附回右下角时调）。
   */
  const handlePillPos = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      await loadPillPos()
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, position: pillPos })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
        return
      }
      const raw = await readBody(req, 4_000)
      let body: { position?: unknown; clear?: unknown } = {}
      try {
        body = raw ? (JSON.parse(raw) as { position?: unknown; clear?: unknown }) : {}
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      if (body.clear === true) {
        pillPos = null
        schedulePillPosWrite()
        sendJson(res, 200, { ok: true, position: null })
        return
      }
      const next = normalizePillPos(body.position ?? body)
      if (!next) {
        sendJson(res, 400, { ok: false, error: 'position 需要 { right, y } 两个有限数值' })
        return
      }
      pillPos = next
      schedulePillPosWrite()
      sendJson(res, 200, { ok: true, position: pillPos })
    })()
  }

  const clampText = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

  /**
   * 收敛全部已接收的轮次：只留 role / text / attachments，不按条数丢弃对话。
   *
   * 载入与保存**共用同一份**（以前是两段一模一样的 map，加字段时最容易只改一处 ——
   * 那会变成"存得下、读不回"这种极难发现的错）。
   */
  const readTurns = (raw: unknown): HistoryTurn[] => {
    if (!Array.isArray(raw)) return []
    return raw.map((turn) => {
      const item = (turn ?? {}) as { role?: unknown; text?: unknown; attachments?: unknown; contextExcluded?: unknown }
      // 附件走和 analyze 同一个字段白名单；上传数量由上传入口限制，
      // 于是"历史文件被手改过"也不会把脏东西带进模型请求
      const attachments = readHistoryAttachments(item.attachments)
      return {
        role: item.role === 'assistant' ? 'assistant' : 'user',
        text: typeof item.text === 'string' ? item.text : '',
        ...(item.contextExcluded === true ? { contextExcluded: true } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      }
    })
  }

  /** 保存、读盘和撤销删除共用字段白名单与长度限制。 */
  function normalizeHistoryEntry(input: HistoryInput, key: string, at: number): HistoryEntry {
    return {
      key,
      text: clampText(input.text, 20000),
      context: clampText(input.context, 20000),
      label: clampText(input.label, 60),
      at,
      parts: {
        translation: clampText(input.parts?.translation, 20000),
        detail: clampText(input.parts?.detail, 20000),
      },
      turns: readTurns(input.turns),
      ...(readContextState(input.contextState) ? { contextState: readContextState(input.contextState)! } : {}),
      toolDigest: clampText(input.toolDigest, 2000),
      pinned: input.pinned === true,
      // 缺少 skipped 的旧条目继续保持未知状态。
      ...(typeof input.skipped === 'boolean' ? { skipped: input.skipped } : {}),
      // 标题单独存；旧条目没有这个字段时保持缺失（回放时再从 label 兜底解析）
      ...(typeof input.title === 'string' && input.title.trim() ? { title: clampText(input.title, 60) } : {}),
    }
  }

  /** 恢复只接受完整快照；校验通过后仍须归一化，不能直接信任客户端字段。 */
  function readSnapshot(raw: unknown): HistoryEntry | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const entry = raw as Partial<HistoryEntry>
    if (typeof entry.key !== 'string' || !entry.key || entry.key.length > 200
      || typeof entry.text !== 'string' || typeof entry.context !== 'string'
      || typeof entry.label !== 'string' || typeof entry.toolDigest !== 'string'
      || typeof entry.at !== 'number' || !Number.isFinite(entry.at)
      || typeof entry.pinned !== 'boolean' || !Array.isArray(entry.turns)
      || typeof entry.parts?.translation !== 'string' || typeof entry.parts?.detail !== 'string') return null
    return normalizeHistoryEntry(entry, entry.key, entry.at)
  }

  async function loadHistory(): Promise<void> {
    if (historyLoaded) return
    historyLoaded = true
    try {
      await models.loadLeaky()
      const raw = await readFile(historyFile(), 'utf8')
      const parsed = JSON.parse(raw) as { entries?: unknown }
      const list = Array.isArray(parsed?.entries) ? parsed.entries : []
      for (const item of list) {
        const entry = item as Partial<HistoryEntry>
        if (typeof entry?.key !== 'string' || entry.key.length === 0) continue
        history.set(entry.key, normalizeHistoryEntry(entry, entry.key,
          typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : Date.now()))
      }
      const loadedSize = history.size
      trimHistory()
      if (history.size !== loadedSize) scheduleHistoryWrite()
      ctx.logger?.info?.(`[${name}] 小窗历史已载入 ${String(history.size)} 条（${historyFile()}）`)
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code !== 'ENOENT') {
        ctx.logger?.warn?.(`[${name}] 读取小窗历史失败：${String((error as Error)?.message ?? error)}`)
      }
    }
  }

  function scheduleHistoryWrite(): void {
    if (historyTimer) clearTimeout(historyTimer)
    historyTimer = setTimeout(() => {
      historyTimer = null
      const entries = [...history.values()].sort((a, b) => b.at - a.at)
      void (async () => {
        try {
          await mkdir(dataDir, { recursive: true })
          await writeFile(historyFile(), JSON.stringify({ version: 1, entries }, null, 0), 'utf8')
        } catch (error) {
          ctx.logger?.warn?.(`[${name}] 写入小窗历史失败：${String((error as Error)?.message ?? error)}`)
        }
      })()
    }, 800)
    historyTimer.unref?.()
  }

  /** 存一条对话（整段覆盖），所有条目统一按更新时间淘汰。 */
  function saveHistoryEntry(input: HistoryInput): number {
    if (config.historyMaxEntries <= 0) return history.size
    const key = clampText(input.key, 200)
    if (!key) return history.size
    const previous = history.get(key)
    const entry = normalizeHistoryEntry(input, key, Date.now())
    entry.pinned ||= previous?.pinned === true
    if (typeof input.skipped !== 'boolean' && typeof previous?.skipped === 'boolean') {
      entry.skipped = previous.skipped
    }
    // 标题已经生成过、而这次保存没带（旧客户端/追问快照）：保留原值，别把标题抹掉
    if (typeof input.title !== 'string' && typeof previous?.title === 'string') {
      entry.title = previous.title
    }
    history.delete(key)
    history.set(key, entry)
    trimHistory()
    scheduleHistoryWrite()
    return history.size
  }

  function trimHistory(): void {
    // 0 只关闭新历史保存，已有条目和撤销删除仍保留。
    if (config.historyMaxEntries <= 0) return
    while (history.size > config.historyMaxEntries) {
      let victim: string | undefined
      let oldestAt = Infinity
      // 磁盘和恢复快照的插入顺序不代表年龄，始终按时间淘汰。
      for (const [candidate, item] of history) {
        if (item.at < oldestAt) {
          victim = candidate
          oldestAt = item.at
        }
      }
      if (victim === undefined) break
      history.delete(victim)
    }
  }

  const historyMeta = (entry: HistoryEntry): Record<string, unknown> => ({
    key: entry.key,
    text: entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text,
    label: entry.label,
    // 截图标题：列表 / 回放顶部都优先用它
    title: entry.title ?? '',
    at: entry.at,
    turns: entry.turns.filter((turn) => turn.role === 'user').length,
    hasDetail: entry.parts.detail.length > 0,
    pinned: entry.pinned,
  })

  const handleHistory = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      await settingsStore.loadSettings()
      await loadHistory()
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'DELETE') {
        // 删除一条（?key=）或清空（?all=1）。
        // 返回被删条目的**快照**，客户端据此做"撤销"（撤销就是把它原样 POST 回来）。
        const all = url.searchParams.get('all') === '1'
        if (all) {
          const removed = Array.from(history.values())
          history.clear()
          scheduleHistoryWrite()
          sendJson(res, 200, { ok: true, removed: removed.length, entries: removed.map(historyMeta) })
          return
        }
        const key = url.searchParams.get('key') ?? ''
        if (!key) {
          sendJson(res, 400, { ok: false, error: '缺少 key' })
          return
        }
        const entry = history.get(key)
        if (!entry) {
          sendJson(res, 200, { ok: true, removed: 0, entry: null })
          return
        }
        history.delete(key)
        scheduleHistoryWrite()
        sendJson(res, 200, { ok: true, removed: 1, entry })
        return
      }
      if (req.method === 'POST' && url.searchParams.get('restore') === '1') {
        // 撤销删除：把客户端手里的快照原样写回（含 at/pinned，恢复原来的位置与标记）
        const raw = await readBody(req, 2_000_000)
        let body: AnalyzeBody = {}
        try {
          body = raw ? (JSON.parse(raw) as AnalyzeBody) : {}
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const entry = readSnapshot((body as { entry?: unknown } | null)?.entry)
        if (!entry) {
          sendJson(res, 400, { ok: false, error: 'entry 不是完整的历史快照' })
          return
        }
        history.delete(entry.key)
        history.set(entry.key, entry)
        trimHistory()
        scheduleHistoryWrite()
        sendJson(res, 200, { ok: true, size: history.size })
        return
      }
      if (req.method === 'POST') {
        const raw = await readBody(req, 2_000_000)
        let body: AnalyzeBody = {}
        try {
          body = raw ? (JSON.parse(raw) as AnalyzeBody) : {}
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const size = saveHistoryEntry({
          key: typeof body?.key === 'string' ? body.key : '',
          text: typeof body?.text === 'string' ? body.text : '',
          context: typeof body?.context === 'string' ? body.context : '',
          label: typeof body?.label === 'string' ? body.label : '',
          parts: (body?.parts ?? {}) as { translation?: unknown; detail?: unknown },
          turns: body?.turns,
          contextState: body?.contextState,
          toolDigest: typeof body?.toolDigest === 'string' ? body.toolDigest : '',
          // 截图标题：独立字段；客户端没带时保持缺失，由 saveHistoryEntry 继承旧值
          ...(typeof body?.title === 'string' ? { title: body.title } : {}),
          pinned: body?.pinned === true,
          // 只在客户端**明确上报** true/false 时才带着走；没报就是"不知道"，
          // 不能在这里用 `=== true` 把它压成 false（那正是把三态压成两态的那一步）。
          ...(body?.skipped === true || body?.skipped === false ? { skipped: body.skipped } : {}),
        })
        sendJson(res, 200, { ok: true, size })
        return
      }
      const key = url.searchParams.get('key')
      if (key) {
        const entry = history.get(key)
        sendJson(res, 200, { ok: true, entry: entry ?? null })
        return
      }
      const entries = [...history.values()].sort((a, b) => b.at - a.at).map(historyMeta)
      sendJson(res, 200, { ok: true, entries })
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    })
  }
  async function readMessage(key: string, index: number): Promise<string | null> {
    await loadHistory()
    return history.get(key)?.turns[index]?.text ?? null
  }
  return { clampText, historyFile, handleHistory, handlePanelSize, handlePillPos, readMessage }
}
