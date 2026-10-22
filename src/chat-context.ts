/** Browser/host context protocol. Contains no service or filesystem dependencies. */
export interface MaterialRef {
  kind: 'image' | 'file'
  ref: { attachmentId: string; name?: string; bytes?: number; width?: number; height?: number; mediaType?: string }
}
export interface ChatTurn {
  role: string
  text: string
  sent?: string
  hidden?: boolean
  contextExcluded?: boolean
  attachments?: MaterialRef[]
}
export interface ContextState {
  version: 1
  sessionId?: string
  source: string
  through: number
  digest: string
  summary: string
  background: { transcript: string; marked: boolean } | null
}
export interface ChatMaterial extends MaterialRef { turn: number }
export const CHAT_REQUEST_BYTES = 512 * 1024
export const EMPTY_DIGEST = '811c9dc5'

export function readContextState(raw: unknown): ContextState | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as ContextState
  if (s.version !== 1 || !Number.isSafeInteger(s.through) || s.through < 0
    || !/^[a-f0-9]{8}$/.test(s.source) || !/^[a-f0-9]{8}$/.test(s.digest)
    || typeof s.summary !== 'string' || s.summary.length > 12000
    || (s.through > 0 && !s.summary.trim())) return null
  if (s.background !== null && (!s.background || typeof s.background.transcript !== 'string'
    || s.background.transcript.length > 200000 || typeof s.background.marked !== 'boolean')) return null
  if (s.sessionId !== undefined && (typeof s.sessionId !== 'string' || s.sessionId.length > 500)) return null
  return { version: 1, ...(typeof s.sessionId === 'string' ? { sessionId: s.sessionId } : {}), source: s.source, through: s.through, digest: s.digest, summary: s.summary,
    background: s.background ? { transcript: s.background.transcript, marked: s.background.marked } : null }
}

function modelTurn(turn: ChatTurn): ChatTurn {
  if (turn.contextExcluded) return { role: turn.role === 'assistant' ? 'assistant' : 'user',
    text: turn.role === 'assistant' ? '（该轮未生成回答。）' : '（该提问未提交给模型，原始内容仍保存在界面历史中；需要时请重新引用必要部分。）' }
  return { role: turn.role === 'assistant' ? 'assistant' : 'user', text: turn.sent || turn.text || '',
    ...(turn.attachments?.length ? { attachments: turn.attachments } : {}) }
}

/** Rolling consistency fingerprint, not an authorization credential. */
export function historyDigest(turns: readonly ChatTurn[], initial = EMPTY_DIGEST): string {
  let hash = Number.parseInt(initial, 16) >>> 0
  for (const raw of turns) {
    const t = modelTurn(raw)
    const text = JSON.stringify([t.role, t.text, (t.attachments || []).map(a => [a.kind, a.ref.attachmentId])]) + '\n'
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function contextSource(session: string, text: string, context: string, initial: string): string {
  return historyDigest([{ role: 'user', text: JSON.stringify([session, text, context, initial]) }])
}

/** Validate once, then serialize only the original, uncompressed suffix. */
export function prepareChatHistory(turns: readonly ChatTurn[], rawState: unknown) {
  const visible = turns.filter(t => !t.hidden)
  let state = readContextState(rawState)
  if (state && (state.through > visible.length || historyDigest(visible.slice(0, state.through)) !== state.digest)) state = null
  const start = state?.through || 0
  const materials: ChatMaterial[] = []
  const seen = new Set<string>()
  visible.forEach((turn, index) => {
    for (const item of turn.attachments || []) {
      const key = item.kind + ':' + item.ref.attachmentId
      if (!seen.has(key)) { seen.add(key); materials.push({ kind: item.kind, ref: item.ref, turn: index }) }
    }
  })
  return { history: visible.slice(start).map(modelTurn), historyStart: start, contextState: state, materials }
}

/** Conservative estimate: ASCII ~3 chars/token; other UTF-16 units ~1 token. */
export function estimateTextTokens(text: string): number {
  let ascii = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) <= 127) ascii++
  return Math.ceil(ascii / 3) + text.length - ascii
}

export function contextBudget(configured: number, window?: number, output = 8192, tools = 2048): number {
  if (!window || !Number.isFinite(window) || window <= 0) return configured
  return Math.floor(Math.min(configured, window * 0.8, window - output - tools))
}

/** Prefer retaining the latest pair; pressure may allow summarizing all complete pairs. */
export function chooseCompactionEnd(turns: readonly ChatTurn[], target: number, price: (t: ChatTurn) => number, preserveLatestPair = true): number {
  let remaining = turns.reduce((n, t) => n + price(t), 0)
  const end = preserveLatestPair ? turns.length - 2 : turns.length
  for (let i = 0; i < end; i++) {
    remaining -= price(turns[i])
    const boundary = i + 1 < turns.length ? turns[i + 1].role === 'user' : turns[i].role === 'assistant'
    if (boundary && remaining <= target) return i + 1
  }
  return -1
}
