/**
 * 小窗历史里的附件：**持久化的引用**怎么进模型请求，以及图片预算怎么降级。
 *
 * 为什么要单独一个模块：这段逻辑全是**纯函数**（形状收敛 / 预算规划 / 内容块重建），
 * 它决定了"第 N 轮还能不能看见第 1 轮那张图"，是最容易写错、又最难人工发现的地方 ——
 * 单独放出来才测得动（见 tests/unit/history-attachments.test.mjs）。
 *
 * ── 三条设计约束 ──
 *
 * ① **只回传引用，不回传字节**。历史里存的是 `/api/attach` 给的持久引用
 *    （`{attachmentId:'sha256:…', name, bytes, mediaType, width, height}`），
 *    和主会话往会话事件里写的是同一套形状。字节只在附件服务里存一份。
 *
 * ② **图片有预算，超了退化成一行文字**。小窗直接调 `ctx.llm.stream()`，不走 agent loop，
 *    所以吃不到 `dsh-compaction-image-offload`（它挂在 `agent/request-error` 这个
 *    agent-loop 才派发的 waterfall 上）。历史里的图要是不管，每多问一轮就重发一遍，
 *    token 会一路涨上去 —— 所以这里自己卡预算：**从最近往前数**，新图优先，
 *    超出的老图换成一行为模型可读的说明（照 dsh-llm 那句 offloaded 措辞的风格写，
 *    模型在别处见过同款说法）。
 *
 * ③ **文件不占图片预算**。文件本来就不进请求体：dsh-llm 会把它投影成
 *    "名字 + 字节数 + 只读路径"一行文字，模型需要时用文件工具按路径去读。
 *    这行的成本很低，而且"能读回来"正是持久化它的全部意义 —— 所以文件只要限个条数就行。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 历史里最多回带几张**图片**（当前这一轮的附件也算在这个额度里）。 */
export const HISTORY_IMAGE_MAX = 2

/** 历史回带图片的总字节上限（规范化后的字节，取自引用里的 bytes）。 */
export const HISTORY_IMAGE_BYTES = 4 * 1024 * 1024

/** 历史里最多回带几个**文件**引用（每个只投影成一行路径文字）。 */
export const HISTORY_FILE_MAX = 8

/** 单轮最多认几件附件（客户端被改坏、或有人手写请求时的护栏）。 */
export const HISTORY_ATTACHMENTS_PER_TURN_MAX = 10

/** 附件引用里我们**只**认这几个字段 —— 其余一律丢掉。 */
export interface AttachmentRefLike {
  attachmentId: string
  name?: string
  bytes?: number
  mediaType?: string
  width?: number
  height?: number
}

/** 历史里的一条附件（与 /api/attach 回给客户端、客户端又回传的形状一致）。 */
export interface HistoryAttachment {
  kind: 'image' | 'file'
  ref: AttachmentRefLike
}

/** 预算规划的结果：每轮一份内容块 + 几个计数（计数只用于上报/诊断）。 */
export interface HistoryContentPlan {
  blocks: ContentBlock[][]
  /**
   * **这次请求真的进了消息**的附件（按轮次先后，含被降级掉的？不含 —— 只列真进去了的）。
   *
   * 它存在的唯一理由是给文件工具发一张"访客名单"：模型只该读得到它**看得见**的文件，
   * 而"看得见"这件事的唯一定义就是"这次请求里真的拼进了内容块"。
   * 所以名单不另算一套口径，直接用这份（口径一致，不会漂）。
   */
  kept: HistoryAttachment[]
  keptImages: number
  omittedImages: number
  keptFiles: number
  omittedFiles: number
}

/** 取一个短哈希用于给人看的说明（和 dsh-llm 的 8 位一致）。 */
function digestOf(ref: AttachmentRefLike): string {
  const raw = String(ref.attachmentId)
  return raw.startsWith('sha256:') ? raw.slice('sha256:'.length, 'sha256:'.length + 8) : raw.slice(0, 8)
}

/**
 * 收敛一个附件引用：**必须**是带 `attachmentId` 字符串的对象。
 *
 * 只挑白名单字段是有意的：`body.history` 从浏览器来，指向哪里都不该让请求体跟着它走。
 */
export function readAttachmentRef(raw: unknown): AttachmentRefLike | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const attachmentId = typeof item.attachmentId === 'string' ? item.attachmentId : ''
  if (!attachmentId) return null
  const ref: AttachmentRefLike = { attachmentId }
  // ⚠️ 名字必须**原样**保留（只做长度兜底，且上限要 ≥ 附件服务的 255）：
  // 服务读文件时会校验 `ref.name === fileLeafName(ref.name)`，
  // 我们要是把它截短了，那个引用反而“校验不通过”读不回来（长文件名实测会踩）。
  if (typeof item.name === 'string' && item.name) ref.name = item.name.slice(0, 255)
  if (typeof item.bytes === 'number' && Number.isFinite(item.bytes) && item.bytes >= 0) ref.bytes = item.bytes
  if (typeof item.mediaType === 'string' && item.mediaType) ref.mediaType = item.mediaType.slice(0, 120)
  if (typeof item.width === 'number' && Number.isFinite(item.width) && item.width > 0) ref.width = item.width
  if (typeof item.height === 'number' && Number.isFinite(item.height) && item.height > 0) ref.height = item.height
  return ref
}

/** 收敛一条附件：形状不对、或 kind 不认识就整条丢掉。 */
export function readHistoryAttachment(raw: unknown): HistoryAttachment | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as { kind?: unknown; ref?: unknown }
  if (item.kind !== 'image' && item.kind !== 'file') return null
  const ref = readAttachmentRef(item.ref)
  if (!ref) return null
  return { kind: item.kind, ref }
}

/**
 * 收敛一轮的附件列表（带单轮条数上限）。
 *
 * 上限是**从后往前**保留的：客户端是按下标顺序 push 的，用户最后加的那件最要紧。
 */
export function readHistoryAttachments(raw: unknown): HistoryAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: HistoryAttachment[] = []
  for (const item of raw) {
    const parsed = readHistoryAttachment(item)
    if (parsed) out.push(parsed)
  }
  return out.length > HISTORY_ATTACHMENTS_PER_TURN_MAX ? out.slice(-HISTORY_ATTACHMENTS_PER_TURN_MAX) : out
}

/**
 * 图片被预算挤掉时，模型看到的那行文字。
 *
 * 措辞照着 dsh-llm 的 `offloadedImageText` 写（identity + "ask the user to attach it again"），
 * 这样模型在别处见过同款说法 —— 它知道这是"图被省略了"，而不是"用户没附图"。
 */
export function omittedImageText(ref: AttachmentRefLike): string {
  const identity = ref.name === undefined ? String(ref.attachmentId) : `"${ref.name}" (${ref.attachmentId})`
  const size = ref.bytes === undefined ? '' : `, ${ref.bytes} bytes`
  const pixels = ref.width === undefined || ref.height === undefined ? '' : `, ${ref.width}x${ref.height}px`
  return `[图片已省略以适配请求的图片预算：${identity} (sha256:${digestOf(ref)}${pixels}${size})。原图不再随本轮请求发送；如果还需要看图上的内容，请让用户重新附上这一张。]`
}

/** 文件引用被条数上限挤掉时的那行文字。 */
export function omittedFileText(ref: AttachmentRefLike): string {
  const name = ref.name === undefined ? String(ref.attachmentId) : ref.name
  return `[文件「${name}」较早，本轮不再重复给出它的只读路径；如果还需要它的内容，请让用户重新附上这个文件。]`
}

/**
 * 把客户端传来的历史轮次重建成**每轮一份内容块**，并按预算决定图片是回带还是降级。
 *
 * @param turns - 客户端给的历史（`[{role, text, attachments?}]`），顺序 = 从旧到新。
 * @param current - **当前这一轮**的附件；它已经占了额度（用户刚附上的图必须发出去，
 *                  但总张数仍要封顶，否则"历史 2 张 + 本轮 1 张"会逐轮往上叠）。
 * @returns 与 `turns` 等长（下标对齐）的内容块，外加几个计数。
 *
 * 返回 `[]` 表示"这一轮没有可进模型的内容"（既没文字也没附件）—— 调用方据此跳过它，
 * 与从前的 `if (!text) continue` 等价。
 */
export function historyContentBlocks(turns: readonly unknown[], current: readonly HistoryAttachment[] = []): HistoryContentPlan {
  const parsed = turns.map((turn) => {
    const item = (turn ?? {}) as { text?: unknown; attachments?: unknown }
    return {
      text: typeof item.text === 'string' ? item.text : '',
      attachments: readHistoryAttachments(item.attachments),
    }
  })

  // ── 预算：从**最近往前**数，新图优先 ──
  const currentImages = current.filter((item) => item.kind === 'image')
  let keptImages = 0
  let usedBytes = 0
  for (const item of currentImages) {
    keptImages += 1
    usedBytes += typeof item.ref.bytes === 'number' ? item.ref.bytes : 0
  }
  let keptFiles = current.filter((item) => item.kind === 'file').length
  // 下标对：`轮次下标:附件下标` —— 决定某一处是回带还是降级
  const kept = new Set<string>()
  let omittedImages = 0
  let omittedFiles = 0
  for (let turnIndex = parsed.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const attachments = parsed[turnIndex].attachments
    for (let itemIndex = attachments.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = attachments[itemIndex]
      if (item.kind === 'file') {
        if (keptFiles >= HISTORY_FILE_MAX) {
          omittedFiles += 1
          continue
        }
        keptFiles += 1
        kept.add(`${turnIndex}:${itemIndex}`)
        continue
      }
      const size = typeof item.ref.bytes === 'number' ? item.ref.bytes : 0
      if (keptImages >= HISTORY_IMAGE_MAX || usedBytes + size > HISTORY_IMAGE_BYTES) {
        omittedImages += 1
        continue
      }
      keptImages += 1
      usedBytes += size
      kept.add(`${turnIndex}:${itemIndex}`)
    }
  }

  // ── 重建：附件排在正文**前面**（和当前这一轮一致：先给材料，再读问题）──
  const keptList: HistoryAttachment[] = []
  const blocks = parsed.map((turn, turnIndex) => {
    const out: ContentBlock[] = []
    for (let itemIndex = 0; itemIndex < turn.attachments.length; itemIndex += 1) {
      const item = turn.attachments[itemIndex]
      if (kept.has(`${turnIndex}:${itemIndex}`)) {
        keptList.push(item)
        out.push(item.kind === 'image' ? { type: 'image', attachment: item.ref as never } : { type: 'file', attachment: item.ref as never })
      } else {
        out.push({ type: 'text', text: item.kind === 'image' ? omittedImageText(item.ref) : omittedFileText(item.ref) })
      }
    }
    if (turn.text) out.push({ type: 'text', text: turn.text })
    return out
  })

  return { blocks, kept: keptList, keptImages, omittedImages, keptFiles, omittedFiles }
}

/**
 * 这个失败像不像"附件读不回来了"。
 *
 * 为什么需要：引用一旦落进历史，它的寿命就**超过**了那一轮 —— 而对象仓里的字节
 * 并不会跟着历史一起管理（附件服务不自动删除，但用户可能手动清理）。
 * 那时每一轮都会撞 `Attachment object is missing.`，整个小窗等于废了。
 * 判据取宽一点（码前缀 + 关键措辞），因为这条错误是**穿过** llm 适配器上来的，
 * 码可能已经被包成 UNKNOWN，只剩措辞还认得出来。
 */
export function looksLikeAttachmentFailure(message: unknown, code?: unknown): boolean {
  const codeText = typeof code === 'string' ? code.toUpperCase() : ''
  if (codeText.startsWith('ATTACHMENT') || codeText === 'IMAGE_OFFLOAD_REQUIRED') return true
  const text = typeof message === 'string' ? message.toLowerCase() : ''
  if (!text) return false
  if (text.includes('attachment') && /(missing|corrupt|unreadable|not found|no such)/.test(text)) return true
  if (/image (omitted|too (large|many))/.test(text)) return true
  return false
}
