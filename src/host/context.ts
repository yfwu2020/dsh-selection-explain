import type { AnalyzeBody, BackgroundOptions, SessionBackground } from './types.js'

/** 请求里带的会话 id（空串 = 客户端没取到）。 */
export function sessionIdOf(body: AnalyzeBody): string {
  return typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
}

/** 空白归一化（用于在会话记录里定位选中文字）。 */
function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 从消息 content 里取纯文本（只取 text 块；工具调用/结果不进来，避免噪音挤占预算）。 */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join('\n').trim()
}

/** 会话背景里的一条对话。 */
interface TranscriptEntry {
  role: string
  text: string
  marked: boolean
}

/**
 * 把会话的当前模型界面整理成「会话背景」文本。
 *
 * 只保留**真实对话**：用户真正发的话（source.kind === 'user'）与助手回复的正文。
 * 三类内容一律剔除，否则会把有效窗口挤没（实测：430 条 surface 事件里绝大多数是
 * 工具调用/结果，且 harness 注入的 system-reminder 单条可达 1.2 万字）：
 *   - tool/result 与纯工具调用的助手步骤（无正文）
 *   - system/message（系统提示词）
 *   - source.kind !== 'user' 的用户角色消息（运行环境快照、skill 目录等 harness 注入）
 */
export function transcriptOf(events: readonly unknown[], options: BackgroundOptions): SessionBackground {
  const entries: TranscriptEntry[] = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const typed = event as { type?: unknown; data?: unknown }
    const data = (typed.data ?? {}) as {
      message?: { content?: unknown }
      content?: unknown
      source?: { kind?: unknown }
    }
    let role = ''
    let content: unknown
    if (typed.type === 'user/message') {
      if (data.source && data.source.kind !== 'user') continue // harness 注入的上下文
      role = '用户'
      content = data.content
    } else if (typed.type === 'assistant/message') {
      role = '助手'
      content = data.message?.content
    } else {
      continue
    }
    const text = messageText(content)
    if (!text) continue
    entries.push({ role, text, marked: false })
  }

  const needle = normalizeSpace(options.marker)
  let marked = false
  if (needle.length >= 2) {
    for (const entry of entries) {
      if (normalizeSpace(entry.text).includes(needle)) {
        entry.marked = true
        marked = true
      }
    }
  }

  // 窗口 = 选中文字所在的那条消息 **向上** 数 maxMessages 条（含它自己），
  // 之后的对话不进背景；找不到选中位置时退回「最近 maxMessages 条」。
  // 默认不截断（maxChars = 0）：消息整条进背景，不做单条/总量裁剪。
  let anchorIndex = -1
  if (marked) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]?.marked) {
        anchorIndex = i
        break
      }
    }
  }
  const endIndex = anchorIndex >= 0 ? anchorIndex : entries.length - 1
  const startIndex = Math.max(0, endIndex - options.maxMessages + 1)
  const picked: TranscriptEntry[] = entries.slice(startIndex, endIndex + 1).map((entry) => ({ ...entry }))

  // 可选总量上限（配置里显式设 >0 时才生效）：超了就丢更早的消息
  if (options.maxChars > 0) {
    let used = picked.reduce((sum, entry) => sum + entry.text.length, 0)
    while (picked.length > 1 && used > options.maxChars) {
      const dropped = picked.shift()
      used -= dropped ? dropped.text.length : 0
    }
    for (const entry of picked) {
      if (entry.text.length > options.maxChars) entry.text = `${entry.text.slice(0, options.maxChars)}…`
    }
  }

  if (picked.length === 0) return { transcript: '', marked: false }
  const omitted = Math.max(0, entries.length - picked.length)
  if (omitted > 0) picked.unshift({ role: '提示', text: `（选中位置之前还有 ${omitted} 条更早的消息，未包含）`, marked: false })

  const transcript = picked.map((entry) => `${entry.marked ? '▶ ' : '  '}${entry.role}：${entry.text}`).join('\n')
  return { transcript, marked: picked.some((entry) => entry.marked) }
}

/** 引用上下文的结果。 */
export interface QuoteContext {
  /** 「用户：…／助手：…」逐行拼好的上下文（引用部分用【】标出）；没命中时为空串。 */
  transcript: string
  /** 引用文字是否在会话里定位到了（没定位到 → 客户端退回自己的局部上下文）。 */
  matched: boolean
  /** 带进来的对话组数（一组 = 一条用户消息 + 它的助手回复）。 */
  rounds: number
}

/** 引用上下文的窗口与长度（默认值：上下各一组、单条 2000 字、总共 6000 字）。 */
export interface QuoteContextOptions {
  /** 引用前后各取几组对话（默认 1）。 */
  roundsAround?: number
  /** 单条消息的字数上限（超出时**围绕引用**截断，别把引用本身裁掉）。 */
  maxCharsPerTurn?: number
  /** 整段上下文的字数上限（超出时丢最早的那几组）。 */
  maxChars?: number
}

/** 在文本里找到引用文字并套上【】（直接找不到就按"空白等价"再找一次）。 */
function markQuoteInText(text: string, marker: string): string {
  if (!text || !marker) return text
  const at = text.indexOf(marker)
  if (at >= 0) return `${text.slice(0, at)}【${marker}】${text.slice(at + marker.length)}`
  // 归一化后匹配：把引用按空白切开，逐段允许任意空白（选中文字常与消息原文差在换行/缩进）
  const tokens = marker.split(/\s+/).filter(Boolean).map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (tokens.length === 0) return text
  try {
    const hit = new RegExp(tokens.join('\\s+')).exec(text)
    if (hit && typeof hit.index === 'number') {
      return `${text.slice(0, hit.index)}【${hit[0]}】${text.slice(hit.index + hit[0].length)}`
    }
  } catch {
    /* 正则构造失败（极端输入）：不标记，客户端会把原文另起一段补上 */
  }
  return text
}

/** 围绕引用截断长消息（引用本身必须留下；找不到引用就从头截）。 */
function clampAroundQuote(text: string, marker: string, max: number): string {
  if (text.length <= max) return text
  const at = marker ? text.indexOf(marker) : -1
  if (at < 0) return `${text.slice(0, max)}…（已截断）`
  const half = Math.max(0, Math.floor((max - marker.length) / 2))
  const from = Math.max(0, at - half)
  const to = Math.min(text.length, at + marker.length + half)
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

/**
 * **引用上下文**：引用文字所在的那一组对话 ± N 组（一组 = 一条用户消息 + 它的助手回复）。
 *
 * 与 `transcriptOf`（解读用的会话背景）的区别，两条都是为引用量身定的：
 *   ① 窗口是**锚点两侧** —— 引用常常是"上面那句"和"下面那句"的对照，只有上文不够；
 *   ② 按**轮**取整 —— 上下各至少一整组（用户消息 + AI 回复），不会切在半个回合上。
 * 噪音过滤与 `transcriptOf` 完全一致（工具调用/结果、系统提示、harness 注入一律不进）。
 */
export function quoteContextOf(
  events: readonly unknown[],
  marker: string,
  options: QuoteContextOptions = {},
): QuoteContext {
  const roundsAround = Math.max(0, options.roundsAround ?? 1)
  const maxCharsPerTurn = Math.max(200, options.maxCharsPerTurn ?? 2000)
  const maxChars = Math.max(400, options.maxChars ?? 6000)

  const entries: TranscriptEntry[] = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const typed = event as { type?: unknown; data?: unknown }
    const data = (typed.data ?? {}) as {
      message?: { content?: unknown }
      content?: unknown
      source?: { kind?: unknown }
    }
    let role = ''
    let content: unknown
    if (typed.type === 'user/message') {
      if (data.source && data.source.kind !== 'user') continue
      role = '用户'
      content = data.content
    } else if (typed.type === 'assistant/message') {
      role = '助手'
      content = data.message?.content
    } else {
      continue
    }
    const text = messageText(content)
    if (!text) continue
    entries.push({ role, text, marked: false })
  }
  if (entries.length === 0) return { transcript: '', matched: false, rounds: 0 }

  const needle = normalizeSpace(marker)
  let anchor = -1
  if (needle.length >= 2) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (normalizeSpace(entries[i]?.text ?? '').includes(needle)) {
        anchor = i
        break
      }
    }
  }
  if (anchor < 0) return { transcript: '', matched: false, rounds: 0 }

  // 按"轮"分组：一条用户消息开一轮（它之前的助手消息归上一轮）
  const roundOf: number[] = []
  let round = -1
  for (const entry of entries) {
    if (entry.role === '用户' || round < 0) round += 1
    roundOf.push(round)
  }
  const anchorRound = roundOf[anchor] ?? 0
  const fromRound = Math.max(0, anchorRound - roundsAround)
  const toRound = Math.min(round, anchorRound + roundsAround)

  const picked: TranscriptEntry[] = []
  for (let i = 0; i < entries.length; i += 1) {
    const r = roundOf[i] ?? 0
    if (r < fromRound || r > toRound) continue
    const entry = entries[i] as TranscriptEntry
    const isAnchor = i === anchor
    const raw = isAnchor ? markQuoteInText(entry.text, marker) : entry.text
    picked.push({
      role: entry.role,
      text: clampAroundQuote(raw, marker, maxCharsPerTurn),
      marked: isAnchor,
    })
  }

  // 总量上限：超了先丢最早的几组，再丢引用之后的几组（**引用所在那条永远保留**）
  let used = picked.reduce((sum, entry) => sum + entry.text.length, 0)
  let droppedBefore = 0
  let droppedAfter = 0
  while (picked.length > 1 && used > maxChars && picked[0] && !picked[0].marked) {
    const first = picked.shift()
    droppedBefore += 1
    used -= first ? first.text.length : 0
  }
  while (picked.length > 1 && used > maxChars && picked[picked.length - 1] && !picked[picked.length - 1]?.marked) {
    const last = picked.pop()
    droppedAfter += 1
    used -= last ? last.text.length : 0
  }
  if (droppedBefore > 0) picked.unshift({ role: '提示', text: `（引用之前还有 ${droppedBefore} 条消息，未包含）`, marked: false })
  if (droppedAfter > 0) picked.push({ role: '提示', text: `（引用之后还有 ${droppedAfter} 条消息，未包含）`, marked: false })

  const transcript = picked.map((entry) => `${entry.role}：${entry.text}`).join('\n')
  return { transcript, matched: true, rounds: toRound - fromRound + 1 }
}
