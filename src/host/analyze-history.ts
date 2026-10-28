import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolve } from 'node:path'
import type { ChatMaterial, ChatTurn, ContextState } from '../chat-context.js'
import { readMaterialCatalog } from './chat-materials.js'
import type { HistoryContentPlan } from './history-attachments.js'
import { historyContentBlocks, readHistoryAttachments } from './history-attachments.js'
import type { AnalyzeBody, Route } from './types.js'

/** Mutable history and attachment admission state shared by context planning and retries. */
export class AnalyzeHistory {
  readonly currentAttachments: ReturnType<typeof readHistoryAttachments>
  readonly rawHistory: ChatTurn[]
  selectedHistory: ChatTurn[]
  readonly catalog: ChatMaterial[]
  readonly historySource: Route
  historyImages = { kept: 0, omitted: 0, files: 0 }
  historyHadAttachments = false
  historyDropped = false
  attachedPaths = new Set<string>()
  contextEstimate = 0

  constructor(body: AnalyzeBody, readonly isChat: boolean, historyStart: number, route: Route, public contextState: ContextState) {
    this.currentAttachments = readHistoryAttachments(body.attachments)
    this.rawHistory = (Array.isArray(body.history) ? body.history : []).map(raw => {
      const item = (raw || {}) as { role?: unknown; text?: unknown; attachments?: unknown }
      const attachments = readHistoryAttachments(item.attachments)
      return {
        role: item.role === 'assistant' ? 'assistant' : 'user', text: typeof item.text === 'string' ? item.text : '',
        ...(attachments.length ? { attachments } : {})
      }
    })
    this.selectedHistory = this.rawHistory
    this.catalog = readMaterialCatalog([...(Array.isArray(body.materials) ? body.materials : []),
      ...this.rawHistory.flatMap((t, i) => (t.attachments || []).map(a => ({ ...a, turn: historyStart + i }))),
      ...this.currentAttachments.map(a => ({ ...a, turn: historyStart + this.rawHistory.length }))])
    this.historySource = { provider: route.provider, model: route.model }
  }

  /**
   * 历史规划（纯计算）：预算、降级、以及**这次请求真的进了消息的那些附件**。
   * 每次都要能重算 —— 引用失效时会降级再跑一遍（见下面 errored 分支里的那一跳）。
   */
  planHistory(): HistoryContentPlan {
    if (!this.isChat) return { blocks: [], kept: [], keptImages: 0, omittedImages: 0, keptFiles: 0, omittedFiles: 0 }
    const window = this.selectedHistory
    const turns = this.historyDropped
      ? window.map((turn) => {
        const item = (turn ?? {}) as { role?: unknown; text?: unknown }
        return { role: item.role, text: item.text }
      })
      : window
    const plan = historyContentBlocks(turns, this.currentAttachments)
    this.historyImages = { kept: plan.keptImages, omitted: plan.omittedImages, files: plan.keptFiles + plan.omittedFiles }
    return plan
  }

  /** 重建历史消息。 */
  buildHistoryMessages(): Message[] {
    const out: Message[] = []
    if (!this.isChat) return out
    const window = this.selectedHistory
    const plan = this.planHistory()
    window.forEach((turn, index) => {
      const item = turn as { role?: unknown; attachments?: unknown }
      if (!this.historyDropped && Array.isArray(item.attachments) && item.attachments.length > 0) this.historyHadAttachments = true
      const content = plan.blocks[index] ?? []
      if (content.length === 0) return
      if (item.role === 'assistant') {
        out.push(createAssistantMessage({ content, source: this.historySource }))
      } else {
        out.push(createUserMessage({ source: { kind: 'user' }, content }))
      }
    })
    return out
  }

  /**
   * 文件工具的访客名单：本轮附件与本小窗保存的文件材料目录。
   * 材料目录中的旧文件可由 selection_material 恢复；不接纳任意外部路径。
   *
   * 路径由附件服务按内容哈希推出（不碰磁盘，纯路径计算，所以每次请求重算没有成本）；
   * 引用不合法就当场丢掉 —— 它本来也读不出来，让门禁拒掉即可。
   */
  collectAttachedPaths(ctx: Context): Set<string> {
    const paths = new Set<string>()
    const store = ctx.get('attachments') as { fileHostPath?: (ref: unknown) => string | undefined } | undefined
    if (!store || typeof store.fileHostPath !== 'function') return paths
    const refs = []
    for (const item of this.currentAttachments) if (item.kind === 'file') refs.push(item.ref)
    for (const item of this.catalog) if (item.kind === 'file') refs.push(item.ref)
    for (const ref of refs) {
      try {
        const hostPath = store.fileHostPath(ref)
        if (hostPath) paths.add(resolve(hostPath))
      } catch {
        /* 引用不合法：当它不存在（读的时候自然会被门禁拒） */
      }
    }
    return paths
  }
}
