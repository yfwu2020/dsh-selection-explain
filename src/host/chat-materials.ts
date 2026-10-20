import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { access } from 'node:fs/promises'
import { readHistoryAttachments } from './history-attachments.js'
import type { ChatMaterial, MaterialRef } from '../chat-context.js'

export function readMaterialCatalog(raw: unknown): ChatMaterial[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ChatMaterial[] = []
  for (const item of raw) {
    const turn = Number.isSafeInteger(item?.turn) && item.turn >= 0 ? item.turn : 0
    for (const a of readHistoryAttachments([item])) {
      const key = a.kind + ':' + a.ref.attachmentId
      if (!seen.has(key)) { seen.add(key); out.push({ ...a, turn }) }
    }
  }
  return out
}

export const MATERIAL_TOOL: ToolSchema = {
  name: 'selection_material', description: '重新取得本小窗已保存的材料。attachmentId：恢复旧图供视觉查看，或取得旧文件只读路径后用read读取；message：读取已压缩的原始消息（从1开始），offset/length按字符对消息或索引分页。参数为空列出材料。摘要不是原文，涉及精确措辞或图片细节时应重新读取。不能读取未列出的附件或任意路径。',
  parameters: { type: 'object', properties: { attachmentId: { type: 'string' }, message: { type: 'integer', minimum: 1 },
    offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1 } } },
}

export function materialIndex(catalog: ChatMaterial[], through: number, all = false): string {
  const archived = all ? catalog : catalog.filter(a => a.turn < through)
  if (!archived.length && !through) return ''
  return ['【原始材料索引】', through > 0 ? `消息#1 至 #${through} 已压缩；需核对原文时用 selection_material 按消息编号读取。` : '以下为本小窗已保存的附件。',
    ...archived.map(a => `${a.kind === 'image' ? '图片' : '文件'} ${a.ref.name || '(未命名)'} | ${a.ref.attachmentId} | 消息#${a.turn + 1}`),
    '原文件仍在附件库；摘要不代表本轮已提供原图或文件正文。'].join('\n')
}

export async function restoreMaterial(ctx: Context, catalog: ChatMaterial[], parsed: unknown, options: {
  through: number; key: string; maxChars: number; readMessage: (key: string, index: number) => Promise<string | null>;
}): Promise<{ content: ContentBlock[]; isError: boolean; restored?: MaterialRef }> {
  const p = (parsed || {}) as { attachmentId?: unknown; message?: unknown; offset?: unknown; length?: unknown }
  try {
    if (typeof p.attachmentId === 'string') {
      const item = catalog.find(a => a.ref.attachmentId === p.attachmentId)
      if (!item) throw Error('该附件不在本小窗的材料索引中')
      const store = ctx.get('attachments') as { imageHostPath?: (ref: unknown) => string | undefined; fileHostPath?: (ref: unknown) => string | undefined } | undefined
      const path = item.kind === 'image' ? store?.imageHostPath?.(item.ref) : store?.fileHostPath?.(item.ref)
      if (!path) throw Error('宿主未提供此附件的读取能力')
      await access(path)
      return { content: [{ type: 'text', text: item.kind === 'image' ? `已重新提供图片 ${item.ref.name || item.ref.attachmentId}，请根据原图作答。` : `文件 ${item.ref.name || item.ref.attachmentId} 的只读路径：${path}。按问题用read读取必要部分；如格式不受支持请明确说明。` }],
        restored: { kind: item.kind, ref: item.ref }, isError: false }
    }
    if (Number.isSafeInteger(p.message) && Number(p.message) >= 1 && Number(p.message) <= options.through) {
      const text = await options.readMessage(options.key, Number(p.message) - 1)
      if (text === null) throw Error('原始消息已不在保存的历史中，请引用需要查看的原文')
      const offset = Number.isSafeInteger(p.offset) && Number(p.offset) >= 0 ? Number(p.offset) : 0
      const length = Math.max(1, Math.min(options.maxChars, Number.isSafeInteger(p.length) ? Number(p.length) : options.maxChars))
      return { content: [{ type: 'text', text: `【原始消息#${p.message}，字符${offset}—${Math.min(text.length, offset + length)}／${text.length}】\n${text.slice(offset, offset + length)}` }], isError: false }
    }
    const index = materialIndex(catalog, options.through, true) || '没有已保存的材料。'
    const offset = Number.isSafeInteger(p.offset) && Number(p.offset) >= 0 ? Number(p.offset) : 0
    return { content: [{ type: 'text', text: `【材料索引 字符${offset}—${Math.min(index.length, offset + options.maxChars)}／${index.length}】\n` + index.slice(offset, offset + options.maxChars) }], isError: false }
  } catch (error) {
    return { content: [{ type: 'text', text: `材料读取失败：${String((error as Error)?.message || error)}。如附件已被清理，请用户补传；不要猜测材料内容。` }], isError: true }
  }
}
