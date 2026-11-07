import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { HistoryAttachment } from './history-attachments.js'
import { PLUGIN_SOURCE_KIND } from './constants.js'

export interface PromoteTurn {
  role: 'user' | 'assistant'
  text: string
  attachments: HistoryAttachment[]
}

/** The durable event envelope accepted by the host's seeded agent factory. */
export interface PromoteSeedEvent {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: 'append'
}

/**
 * 去掉小窗正文里那行 `【本条消息带了附件】…`。
 *
 * 那行是**小窗**的说法（历史里给模型看的锚点）。升格时附件是**真带过来**的，
 * 再留着它，主会话里就会同时出现"一行字说带了附件"和"附件本身"，
 * 而且措辞（"本条消息"）在主会话语境下也不通顺。
 *
 * 只在**确实带上了附件**时才去（`hasAttachments`）：没有附件时那行是唯一的信息，不能抹。
 */
function attachmentMarkerStripped(text: string, hasAttachments: boolean): string {
  if (!hasAttachments) return text
  return text.replace(/^【本条消息带了附件】[^\n]*\n?/, '')
}

/** Build balanced, contiguous history before the host constructs its agent. */
export function buildPromoteSeed({ text, label, contextText, translation, detail, sourceSessionId, turns }: {
  text: string
  label: string
  contextText: string
  translation: string
  detail: string
  sourceSessionId: string
  turns: PromoteTurn[]
}): PromoteSeedEvent[] {
  const events: PromoteSeedEvent[] = []
  const time = Date.now()
  const stamp = time.toString(36)
  const append = (type: string, data: unknown, options?: { surfaceOp: 'append' }): void => {
    events.push({ type, seq: events.length, time, data, ...options })
  }
  /**
   * 一轮升格后的**内容块**：附件在前、正文在后。
   *
   * 顺序与主会话、与 /analyze 完全一致（先给材料，再读问题）——
   * 形状也是主会话真实使用的那一种（`{type:'image', attachment:{…}}`），
   * 所以升格后客户端能画出缩略图、模型也能真的看到图。
   */
  const contentOfTurn = (turn: { text: string; attachments: HistoryAttachment[] }): ContentBlock[] => {
    const blocks: ContentBlock[] = []
    for (const item of turn.attachments) {
      blocks.push(
        item.kind === 'image'
          ? { type: 'image', attachment: item.ref as never }
          : { type: 'file', attachment: item.ref as never },
      )
    }
    blocks.push({ type: 'text', text: attachmentMarkerStripped(turn.text, turn.attachments.length > 0) })
    return blocks
  }

  let turnNo = 0
  const appendTurn = (userEvent: Record<string, unknown> | null, assistantText: string): void => {
    turnNo += 1
    const turn = turnNo
    append('turn/start', { turn })
    append('step/start', { turn, step: 1 })
    if (userEvent) append('user/message', userEvent, { surfaceOp: 'append' })
    append(
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
    append('step/end', { turn, step: 1 })
    append('turn/end', { turn, reason: { kind: 'completed' } })
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
          content: contentOfTurn(turn),
        },
        turns[i + 1] && turns[i + 1]?.role === 'assistant' ? (turns[i + 1]?.text ?? '') : '（未记录）',
      )
      i += 1 // 助手回答已随本轮写入
    } else {
      // 落单的助手消息（历史里没有对应提问）：单独成一轮
      appendTurn(null, turn.text)
    }
  }
  return events
}
