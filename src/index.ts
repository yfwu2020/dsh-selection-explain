/**
 * @yfwu2020/dsh-selection-explain — host half（划词解读）。
 *
 * 为浏览器端的「划词解读」提供两个同源 HTTP 路由：
 *   POST /selection-explain/api/analyze   选中文字 + 上下文 → SSE 流式返回
 *                                         「专业中英翻译」与「语境含义详解」
 *   GET  /selection-explain/api/ping      健康检查：当前模型路由 + 限制（弹窗页脚用）
 *
 * 模型路由默认取 agentDefaultModel.currentSelection()（用户在设置里选的默认模型）；
 * 调用过一次真实 LLM 后，也会从 llm/stream 事件里捕获路由作为兜底。
 * 流式 text-delta 直接透传，前端边收边渲染，首字延迟 ≈ 模型首 token 时间。
 */
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { BlockAssembler, createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
// 提示词与写作规则（纯文本常量）单独成模块：本文件是 2400+ 行的 host 全量逻辑，
// 提示词放这里既难找也容易误改。组装逻辑仍在下方（按 stage / kind 选一套）。
import {
  CHAT_SYSTEM_PROMPT,
  CODE_PROMPT,
  DETAIL_PROMPT,
  PROMPT_HEAD,
  TRANSLATION_PROMPT,
  TWO_LAYER_RULE,
} from './prompts.js'

/** 插件名（= package.json name，客户端 bundle 的模块 id 也是它）。 */
export const name = '@yfwu2020/dsh-selection-explain'

/** 路由注册与模型调用所需的服务。 */
export const inject = ['webServer', 'llm']

/** 路由前缀。 */
const API_PREFIX = '/selection-explain/api'

/** 单次请求体上限（字节）。 */
const BODY_LIMIT = 512 * 1024

/** 插件配置。 */
export interface Config {
  /** 固定 provider 路由；留空 = 跟随默认模型。 */
  provider: string
  /** 固定 model id；留空 = 跟随默认模型。 */
  model: string
  /** 推理档位（off / low / high / max）；留空 = 适配器默认。 */
  reasoningEffort: string
  translationReasoningEffort: string
  historyMaxEntries: number
  /** 采样温度。 */
  temperature: number
  /** 输出上限。 */
  maxTokens: number
  /** 单次调用超时（毫秒）。 */
  timeoutMs: number
  /** 选中文字长度上限（字符）。 */
  maxSelectionChars: number
  /** 上下文长度上限（字符）。 */
  maxContextChars: number
  /** 每分钟最大请求数（本地限流，防止误触发刷爆额度）。 */
  maxRequestsPerMinute: number
  /** 是否注入当前会话的对话背景（判断指代与前提的关键）。 */
  sessionContext: boolean
  /** 会话背景最多保留多少条消息（从最新往前取）；第二阶段（详解）用这个值。 */
  sessionContextMaxMessages: number
  /** 第一阶段（仅翻译）用的背景条数：更少 → 首字更快；点「展开详解」时才用上面那个上限。 */
  sessionContextFastMessages: number
  /** 会话背景字符上限；0 = 不限（默认），只按消息条数取窗口。 */
  sessionContextMaxChars: number
  /** 共享结果缓存 TTL（毫秒）：同会话+同选中+同局部片段+同背景时直接回放；0 = 关闭。 */
  resultCacheTtlMs: number
  /** 是否允许解读过程调用工具（联网搜索等）。 */
  tools: boolean
  /** 允许调用的工具名（逗号分隔）；默认只放联网搜索与抓取。 */
  toolNames: string
  fallbackToolNames: string
  /** 最多几轮工具调用。 */
  maxToolRounds: number
  /** 单个工具结果注入模型前的字符上限。 */
  toolResultMaxChars: number
  /** 文件类工具（read/grep/glob）的读取边界：'' = 会话工作目录，'*' = 不限制，其他 = 该目录 */
  toolReadRoot: string
  /** 追问（对话小窗）用的推理档位：通常比首次解读轻，响应更快。 */
  chatReasoningEffort: string
}

/** 配置 schema（缺省值即推荐值）。 */
export const Config = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default('high'),
  /** 首轮「翻译」单独一档：这一轮只挑英文片段做翻译，不需要深度推理，默认压低换首字速度。 */
  translationReasoningEffort: z.string().default('low'),
  /**
   * 小窗对话历史（A′）：把整段对话落到插件自己的目录，重划同一个词直接回放。
   * 0 = 关闭历史。只留最近 N 个「划词条目」（每个条目内含它自己的全部追问轮次）。
   */
  historyMaxEntries: z.number().min(0).max(500).default(20),
  /** 采样温度。**默认 -1 = 不传**（交给供应商默认，与主会话一致）。0~2 之间才真的传。 */
  temperature: z.number().min(-1).max(2).default(-1),
  /**
   * 单次调用的输出上限（tokens）。**默认 0 = 不限制** —— 不传这个参数，交给模型/供应商自己的上限。
   *
   * 为什么不默认给个数：这是**每次调用**的上限，联网检索后的答案经常要 2~4k tokens，
   * 之前默认 1200 会让回答"悄悄截断在句子中间"（实测）；而给死一个更大的数也一样会在别的场景截断。
   * 想限制（控成本/控时延）就填正数，仍然生效。
   */
  maxTokens: z.number().min(0).max(32000).default(0),
  timeoutMs: z.number().min(5000).max(600000).default(300000),
  maxSelectionChars: z.number().min(20).max(20000).default(4000),
  maxContextChars: z.number().min(200).max(60000).default(12000),
  maxRequestsPerMinute: z.number().min(1).max(600).default(40),
  sessionContext: z.boolean().default(true),
  sessionContextMaxMessages: z.number().min(1).max(200).default(24),
  sessionContextFastMessages: z.number().min(1).max(200).default(8),
  sessionContextMaxChars: z.number().min(0).max(2000000).default(0),
  resultCacheTtlMs: z.number().min(0).max(86400000).default(600000),
  tools: z.boolean().default(true),
  /**
   * 工具白名单（逗号分隔）。
   *
   * 默认改用 **free-search 插件**的工具（`advanced_search` / `platform_search`），不再用 `web_search`：
   * 会话里的 `web_search` 是官方 DeepSeek 搜索（复用 @deepseek-ai/dsh-tool-web 的 schema），
   * 而新装的 dsh-free-search 只注册了 advanced_search / platform_search / free_search_test ——
   * 引擎更多（ddg/bing/searxng/anysearch/exa/tavily/keenable/firecrawl/parallel…）、失败自动换引擎、
   * 还支持时间过滤与平台搜索。
   */
  toolNames: z.string().default('advanced_search,platform_search,read,grep,glob'),
  /**
   * **备用**工具清单：只在"首选里的联网工具一个都不在"时才补进来。
   *
   * 场景：没装 free-search 插件（或它没注册工具）时，会话里通常仍有官方 `web_search`；
   * 不补的话小窗会变成完全不能联网。装了 free-search 就完全用不到这一项。
   */
  fallbackToolNames: z.string().default('web_search'),
  maxToolRounds: z.number().min(0).max(8).default(2),
  toolResultMaxChars: z.number().min(200).max(20000).default(3000),
  toolReadRoot: z.string().default(''),
  chatReasoningEffort: z.string().default('high'),
})

/** 联网类工具名：用来判断"首选里的联网工具在不在"。 */
const SEARCH_TOOL_NAMES = ['advanced_search', 'platform_search', 'web_search']

/**
 * 决定这一轮给模型哪些工具（纯函数，便于单测）。
 *
 * 规则：
 *   ① 首选清单里**确实存在**的直接放行；
 *   ② 如果首选里的**联网工具一个都不在**（例如没装 free-search 插件），
 *      就把备用清单里存在的补上 —— 否则小窗会变成完全不能联网；
 *   ③ 备用只补"联网"这一类，不会顺手把别的东西带进来。
 */
function resolveToolNames(preferred: string[], fallback: string[], visible: string[]): string[] {
  const present = new Set(visible)
  const out = preferred.filter((name) => present.has(name))
  const hasSearch = preferred.some((name) => SEARCH_TOOL_NAMES.includes(name) && present.has(name))
  if (!hasSearch) {
    for (const name of fallback) {
      if (name && present.has(name) && !out.includes(name)) out.push(name)
    }
  }
  return out
}

/** 一次请求的入参。 */
interface AnalyzeBody {
  text?: unknown
  context?: unknown
  label?: unknown
  title?: unknown
  url?: unknown
  /** 当前会话 id（客户端从 ctx.sessions.list 快照取），用于拉取会话背景。 */
  sessionId?: unknown
  /** 「重新生成」用：为 true 时跳过共享结果缓存。 */
  refresh?: unknown
  /** 两阶段：'translation'（首轮，仅翻译 + 8 条背景）| 'detail'（按需，详解 + 完整背景）。 */
  stage?: unknown
  /** 'code' | 'text'：选中文字是不是代码（代码走「注释」提示词：代码块 + 逐句注释 + 小结）。 */
  kind?: unknown
  /** 本会话已用过的工具结果摘要（追问时带上，避免重复联网）。 */
  toolDigest?: unknown
  /** 小窗对话历史（A′）：整段对话的持久化条目。 */
  key?: unknown
  parts?: unknown
  pinned?: unknown
  /** 单次请求的推理档位覆盖（off / low / high / max）；不传用插件配置。 */
  effort?: unknown
  /** 小窗的「模型」控件：显式指定 provider + model（按清单校验，缺省跟随会话默认）。 */
  provider?: unknown
  model?: unknown
  /** 网页模式（小窗里的开关）：复杂问题默认用网页回答，并注入设计规范。 */
  webAnswer?: unknown
  /** 追问模式下用户这一轮的问题。 */
  question?: unknown
  /** 追问模式下的历史轮次：[{ role: 'user' | 'assistant', text }]。 */
  history?: unknown
  /** 升格为正式会话时的入参。 */
  translation?: unknown
  detail?: unknown
  turns?: unknown
  /** 诊断开关：为 true 时把实际发给模型的提示词回传在 SSE 的 start 事件里（客户端不传）。 */
  debug?: unknown
}

/** 会话背景读取结果。 */
interface SessionBackground {
  /** 已格式化的对话记录（时间顺序，最后一条最新）。 */
  transcript: string
  /** 是否在记录里标出了选中文字所在的消息。 */
  marked: boolean
}

/** 会话背景读取入参。 */
interface BackgroundOptions {
  maxMessages: number
  maxChars: number
  /** 用于在记录里定位选中位置（归一化后做包含匹配）。 */
  marker: string
}

/** ctx.sessionQuery 的宽松视图（只用到 readSurface）。 */
interface SessionQueryLike {
  readSurface?: (sessionId: string) => Promise<{ events?: readonly unknown[] }>
}

/** 解析出的模型路由。 */
interface Route {
  provider: string
  model: string
}

/** 写一条 SSE 事件。 */
function sse(res: ServerResponse, payload: unknown): void {
  if (res.writableEnded) return
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    /* 客户端已断开 */
  }
}

/** 返回一个 JSON 响应。 */
/**
 * 把模型**内联在正文里**的思考块拆出来。
 *
 * 为什么要它：有的模型（实测 opencode-go 上的 minimax-m3 偶发）不走 reasoning 通道，
 * 而是把整段思考当正文吐出来，形如 `<think>The user wants…</think>`——
 * 不处理的话，用户看到的"答案"就是一大段思考（实测报过"输出错乱、把思考也输出了"）。
 *
 * 流式难点是标签可能被切成两块（"...<thi" + "nk>..."），所以没找到标签时**留一小截尾巴**再输出。
 */
const THINK_TAGS = 'think|thinking|reasoning|analysis|scratchpad'
const THINK_OPEN = new RegExp(`<(${THINK_TAGS})\\s*>`, 'i')
const THINK_CLOSE = new RegExp(`</(${THINK_TAGS})\\s*>`, 'i')
const THINK_TAIL = 24

function createThinkFilter(): { push: (text: string) => { text: string; think: string }; flush: () => { text: string; think: string } } {
  let buffer = ''
  let inside = false
  const drain = (final: boolean): { text: string; think: string } => {
    let text = ''
    let think = ''
    for (;;) {
      if (inside) {
        const close = THINK_CLOSE.exec(buffer)
        if (!close) {
          if (final) {
            think += buffer
            buffer = ''
          } else if (buffer.length > THINK_TAIL) {
            think += buffer.slice(0, buffer.length - THINK_TAIL)
            buffer = buffer.slice(-THINK_TAIL)
          }
          break
        }
        think += buffer.slice(0, close.index)
        buffer = buffer.slice(close.index + close[0].length)
        inside = false
        continue
      }
      const open = THINK_OPEN.exec(buffer)
      if (!open) {
        if (final) {
          text += buffer
          buffer = ''
        } else if (buffer.length > THINK_TAIL) {
          text += buffer.slice(0, buffer.length - THINK_TAIL)
          buffer = buffer.slice(-THINK_TAIL)
        }
        break
      }
      text += buffer.slice(0, open.index)
      buffer = buffer.slice(open.index + open[0].length)
      inside = true
    }
    return { text, think }
  }
  return {
    push: (chunk: string) => {
      buffer += chunk
      return drain(false)
    },
    flush: () => drain(true),
  }
}

/**
 * 检测"思考被写进正文"的泄漏段。
 *
 * 实测 omen-alpha 在 `off` 档（上游 none）时不走 reasoning 通道，把整段英文推理当正文吐出来：
 * 「The user is asking which model I am. According to my instructions…我是 Omen Alpha。」
 * —— 这种文本**不带任何标签**，靠 `<think>` 过滤器抓不到，只能按"开头是自我盘算"来认。
 *
 * 保守三条件，缺一不裁（宁可留着，也不误删正文）：
 *   ① 逐句扫描，从开头起连续命中"元推理"句式；
 *   ② 命中段以英文为主（≥80% ASCII 字母）；
 *   ③ 剩下的正文里有中文（说明真正的答案是中文，被裁的不是答案）。
 */
const META_SENTENCE =
  /^\s*(?:The user|The question|The request|The person|According to (?:my|the)|Based on (?:my|the)|Per (?:my|the)|My (?:instructions|system prompt|guidelines)|I (?:should|must|need|will|am asked|always|usually|will just)|So I|Thus I|Therefore I|Instructed to|Now I (?:have|need|know|see)|Let me (?:verify|check|think|see|confirm)|I have (?:the|a|enough)|First,? I|OK,? (?:I|let)|用户(?:问|要求)的?是|根据(?:我的)?(?:指令|系统提示)|我应该|我需要|按照(?:我的)?(?:指令|系统提示))/i

/**
 * 宽松判据：开头是**英文盘算**、后面才是**中文答案**。
 * 只用来"记住这个模型在关档会泄漏"（下次自动抬档），**不用来裁剪** ——
 * 裁错了会误删正文，而记错了只是下次少一个档位可选，代价不对称。
 */
function looksLikeLeakedReasoning(text: string): boolean {
  const body = String(text || '')
  if (body.length < 40) return false
  const cut = body.search(/[\u4e00-\u9fff]/)
  if (cut < 30) return false
  const head = body.slice(0, cut)
  const tail = body.slice(cut)
  if (!/[\u4e00-\u9fff]/.test(tail)) return false
  const letters = head.replace(/[^A-Za-z]/g, '').length
  return letters / head.length >= 0.5
}

function splitLeakedReasoning(text: string): { prefix: string; rest: string } {
  const body = String(text || '')
  if (body.length < 40) return { prefix: '', rest: body }
  // 注意：不能用 split(/(?<=[.。!！?？])\s*/) —— 它会把句末空白吃掉，
  // 于是拼回来的 prefix 与真正流出去的正文差一个空格，客户端 indexOf 匹配不上（实测踩过）。
  // 这里保留分隔符本身，保证 parts.join('') === body。
  const parts = body.match(/[^.。!！?？]*[.。!！?？]\s*|[^.。!！?？]+$/g) ?? [body]
  // 从句首开始，连续吃"不含中文的句子"作为泄漏段。
  // 为什么不是"必须命中元推理句式"：实测泄漏段里会夹着 "Previously I said something incorrect … — that was wrong."
  // 这种自述句，逐句匹配元句式会在这里断掉、只裁掉前半段。结构判据（英文盘算 + 中文答案）更稳。
  // 但仍然要求：整段里**至少有一句**命中元推理句式，避免把"英文开头的正常回答"误裁。
  let index = 0
  let ascii = 0
  let metaHit = false
  while (index < parts.length && !/[\u4e00-\u9fff]/.test(parts[index])) {
    if (META_SENTENCE.test(parts[index])) metaHit = true
    ascii += (parts[index].match(/[A-Za-z]/g) || []).length
    index += 1
  }
  if (index === 0 || !metaHit) return { prefix: '', rest: body }
  const head = parts.slice(0, index).join('')
  const tail = parts.slice(index).join('')
  if (!tail.trim()) return { prefix: '', rest: body } // 整篇都是盘算：不裁（可能是模型只说了这些）
  const letters = head.replace(/[^A-Za-z]/g, '').length
  if (head.length > 0 && letters / head.length < 0.5) return { prefix: '', rest: body }
  if (!/[\u4e00-\u9fff]/.test(tail)) return { prefix: '', rest: body }
  return { prefix: head, rest: tail }
}

/**
 * 正文里不该出现的"工具调用残渣"。
 *
 * 收尾轮**不带工具**（为了逼模型给结论），模型这时会把"还想再 read 一下"当正文吐出来，
 * 而且用的可能是两种格式之一：
 *   ① 官方 safety 包装：`<ds_safety_tool_call>…</ds_safety_tool_call>`（客户端以前只认这个）
 *   ② DeepSeek 原生 DSML：全角竖线包起来的 `tool_calls / invoke / parameter` 块（实测漏过正文）
 *
 * 这里在**流里**就把它滤掉：客户端连 delta 都收不到，存盘/升格的内容也是干净的。
 * （客户端那份 sanitizeToolResidue 留作兜底：旧缓存、历史回放这些路径不经过 host。）
 */
/** 全角竖线（U+FF5C）×2 + DSML + ×2：DSML 标记本身，用它拼正则避免源码里出现字面量。 */
const DSML_MARK = '\uFF5C\uFF5CDSML\uFF5C\uFF5C'

/**
 * "残渣标签"的两种形态。
 *
 * DSML 这边**不能只认 `tool_calls`**：实测模型吐出来的是**逐标签式**的，而且 marker 与标签名之间
 * **有一个空格** —— `<MARK parameter name="limit" string="false">40</MARK parameter>`、
 * `<MARK invoke name="read">…</MARK invoke>`、`<MARK calls>…</MARK calls>`。
 * 我第一版只匹配 `<\uFF5CDSML\uFF5Ctool_calls>`（无空格）→ 一个都没命中，残渣照漏（实测 4 轮漏 3 轮）。
 */
const DSML_TAG = new RegExp(`<\\/?\\s*${DSML_MARK}\\s*(?:tool_calls|calls|invoke|parameter)\\b[^>]*>`, 'g')
const SAFETY_TAG = /<\/?\s*ds_safety_tool_call\s*>/gi

/**
 * 把正文里的"工具调用残渣"整段丢掉。
 *
 * 为什么必须在流里做：收尾轮不带工具（为了逼模型给结论），模型会把"还想再调一次工具"当正文吐出来，
 * 客户端现有的 sanitizeToolResidue 只认官方 safety 包装，不认 DSML —— 用户看到的就是一段乱码标记。
 *
 * 算法：**按标签栈计数**。遇到开标签 depth+1、闭标签 depth-1；depth>0 期间的一切（含嵌套标签与参数值）
 * 全部丢弃；流在 depth>0 时结束 → 剩下的整段丢掉。这样三种实测形态（整块/缺包裹/单个标签）都能盖住。
 */
function createResidueFilter(): { push: (text: string) => string; flush: () => string; dropped: () => number } {
  const HOLD = 32 // 标签可能被切开，没命中时留一小截尾巴再输出
  let buffer = ''
  let depth = 0
  let droppedChars = 0
  const scan = (text: string): RegExpExecArray | null => {
    DSML_TAG.lastIndex = 0
    const dsml = DSML_TAG.exec(text)
    SAFETY_TAG.lastIndex = 0
    const safety = SAFETY_TAG.exec(text)
    if (dsml && safety) return dsml.index <= safety.index ? dsml : safety
    return dsml ?? safety
  }
  /**
   * 该留多长的尾巴：除了固定 32 字，还要**精确扣住"半个标签"**。
   * 踩过的坑：DSML 标签本身有 40+ 字（`<MARK parameter name="include" string="true">`），
   * 只留 32 字时标签被切在中间 → 前半截被当正文发出去，后半截又不成标签 → 残渣漏进正文（实测漏过）。
   * 判据：末尾最后一个 '<' 之后没有 '>'，就认为它是未完成的标签，从那个 '<' 起全部扣住。
   */
  const holdOf = (text: string): number => {
    const lastLt = text.lastIndexOf('<')
    if (lastLt >= 0 && text.indexOf('>', lastLt) < 0) return Math.max(HOLD, text.length - lastLt)
    return HOLD
  }
  const drain = (final: boolean): string => {
    let out = ''
    for (;;) {
      const hit = scan(buffer)
      if (!hit) {
        const hold = holdOf(buffer)
        if (depth > 0) {
          // 在残渣块内部：丢掉，只留足以认出闭合标签的尾巴
          if (final) buffer = ''
          else buffer = buffer.length > hold ? buffer.slice(-hold) : buffer
          break
        }
        if (final) {
          out += buffer
          buffer = ''
        } else if (buffer.length > hold) {
          out += buffer.slice(0, buffer.length - hold)
          buffer = buffer.slice(-hold)
        }
        break
      }
      if (depth === 0) out += buffer.slice(0, hit.index)
      const closing = hit[0].charAt(1) === '/'
      if (!closing) droppedChars += hit[0].length
      depth = closing ? Math.max(0, depth - 1) : depth + 1
      buffer = buffer.slice(hit.index + hit[0].length)
    }
    return out
  }
  return {
    push: (text: string) => {
      buffer += text
      return drain(false)
    },
    flush: () => {
      const out = drain(true)
      depth = 0 // 本轮结束就把状态归零：未闭合的残渣块不许影响下一轮
      buffer = ''
      return out
    },
    /** 本轮被丢掉了多少字（用来判断"末尾残渣被删掉后句子没写完"）。 */
    dropped: () => droppedChars,
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 读取请求体（带长度上限）。 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 截断到指定字符数（保留省略标记）。 */
function clampText(raw: unknown, max: number): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text
}

/**
 * 「网页模式」的设计规范：从插件自带的 `skills/web-design/SKILL.md` 读（按 mtime 缓存）。
 *
 * 做成文件而不是写死在代码里：改规范不用重新构建，用户也能自己替换成喜欢的版本。
 * 读不到就退回一段精简规则（宁可少讲，也不能让请求挂掉）。
 */
let designSkillCache: { at: number; path: string; text: string } = { at: 0, path: '', text: '' }
const DESIGN_SKILL_FALLBACK = [
  '单列、宽度 100%、不要横向滚动；不引外部资源；一套主题（别深浅混用）。',
  '主标题 20–22px、正文 14px、行高 1.6–1.75；一个主色 + 中性灰阶。',
  '只在内容真是序列时才编号；避免"什么内容都套同一张圆角卡片"这类模板感。',
].join('\n')
/** 模块级读文件失败时的告警（host 侧 logger 在 apply 里拿不到，走 console）。 */
function ctxLoggerWarn(message: string): void {
  try {
    console.warn(`[dsh-selection-explain] ${message}`)
  } catch {
    /* noop */
  }
}

async function loadDesignSkill(): Promise<string> {
  const path = fileURLToPath(new URL('../skills/web-design/SKILL.md', import.meta.url))
  try {
    const info = await stat(path)
    if (designSkillCache.path === path && designSkillCache.at === info.mtimeMs && designSkillCache.text) {
      return designSkillCache.text
    }
    const raw = await readFile(path, 'utf8')
    // 去掉 frontmatter，只把规则喂给模型
    const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim()
    designSkillCache = { at: info.mtimeMs, path, text: body }
    return body
  } catch (error) {
    ctxLoggerWarn(`读取设计规范失败（${path}）：${String((error as Error)?.message ?? error)}`)
    return DESIGN_SKILL_FALLBACK
  }
}

/**
 * 粗略判断"是不是公网地址"，口径与 dsh-web-fetch-http 的 SSRF 防护一致（非 unicast 一律拒绝）。
 *
 * 为什么要这个：本机若跑着 TUN/fake-IP 代理（DNS 服务器是 198.18.0.2 这类），所有域名都会
 * 解析进 198.18.0.0/15 保留段 → web_fetch 每次都秒失败（"resolves to a non-public IP address"），
 * 而那个防护**没有配置开关**。与其让模型白跑一轮，不如探测出来直接不给它这个工具。
 */
function isPublicAddress(address: string): boolean {
  const value = String(address || '').trim()
  if (!value) return false
  if (value.indexOf(':') >= 0) {
    const lower = value.toLowerCase()
    if (lower === '::1' || lower === '::') return false
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return false
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return false
    return true
  }
  const parts = value.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const a = parts[0] as number
  const b = parts[1] as number
  const c = parts[2] as number
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 168 || b === 0)) return false
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18.0.0/15 基准测试段 ← fake-IP 落这里
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

/** 本机能否真正抓取网页（结果缓存 5 分钟，探测失败则不动它）。 */
let fetchProbe: { at: number; usable: boolean; sample: string } = { at: 0, usable: true, sample: '' }
async function webFetchUsable(): Promise<{ usable: boolean; sample: string }> {
  if (Date.now() - fetchProbe.at < 300_000) return fetchProbe
  try {
    const addresses = await lookup('example.com', { all: true })
    const usable = addresses.length > 0 && addresses.every((entry) => isPublicAddress(entry.address))
    fetchProbe = { at: Date.now(), usable, sample: addresses.map((entry) => entry.address).join(', ') }
  } catch {
    fetchProbe = { at: Date.now(), usable: true, sample: '' }
  }
  return fetchProbe
}

/**
 * 路径是否落在允许的根目录里（root 为空 = 不设限）。
 *
 * 为什么需要它：read/grep/glob 能读**用户有权读的任何文件**（`~/.ssh/id_rsa`、`.env`、
 * `~/.dsh/settings.yaml`……），而划词的触发源（选中文字/上下文/搜索结果）可能是别人写的。
 * 这里只做词法判断（`resolve` 不跟随符号链接），挡住"顺着一段被注入的文字去读项目外的机密"。
 */
export function isInsideRoot(root: string, target: string): boolean {
  if (!root) return true
  const raw = String(target ?? '').trim()
  if (!raw) return true
  // `~` 一律拒：要么指向家目录（多数情况下在项目外），要么后端根本不展开
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return false
  const base = resolve(root)
  const full = resolve(base, raw)
  return full === base || full.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** 文件类工具：这些工具的参数里有 path，需要过边界检查。 */
const FS_TOOL_NAMES = ['read', 'grep', 'glob']

/** 工具调用的人类可读描述（给前端状态栏用）。 */
function describeToolCall(name: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>
  // command 也要认：bash 这类工具没有 query/url，不认的话摘要里只剩「bash」两个字
  const raw =
    record.query ??
    record.queries ??
    record.q ??
    record.url ??
    record.prompt ??
    record.command ??
    record.file_path ??
    record.path ??
    record.pattern
  const query = Array.isArray(raw) ? raw[0] : raw
  return typeof query === 'string' ? query.slice(0, 120) : name
}

/** 从工具结果里抽出：文本长度 / 预览 / 链接（前端只用它拼追问摘要，**不渲染**）。 */
function digestToolResult(content: ContentBlock[]): { chars: number; preview: string; urls: string[] } {
  const text = content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
  const urls: string[] = []
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []
  for (const raw of matches) {
    const url = raw.replace(/[.,;:)\]}]+$/, '')
    if (!urls.includes(url)) urls.push(url)
    if (urls.length >= 5) break
  }
  return { chars: text.length, preview: text.slice(0, 600), urls }
}

/** 执行一个工具并把结果压成模型可读的内容块（带长度上限）。 */
async function runTool(
  ctx: Context,
  name: string,
  args: unknown,
  signal: AbortSignal,
  maxChars: number,
  agent: unknown,
): Promise<{ content: ContentBlock[]; isError: boolean }> {
  const registry = ctx.get('tools') as
    | {
        execute?: (input: {
          callId: string
          name: string
          arguments: unknown
          signal: AbortSignal
          agent?: unknown
        }) => Promise<{ isError: boolean; content?: ContentBlock[] }>
      }
    | undefined
  if (typeof registry?.execute !== 'function') {
    return { content: [{ type: 'text', text: '（工具不可用）' }], isError: true }
  }
  try {
    const result = await registry.execute({
      callId: `sel-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      arguments: args,
      signal,
      ...(agent ? { agent } : {}),
    })
    const blocks = Array.isArray(result.content) ? result.content : []
    let used = 0
    const clamped: ContentBlock[] = []
    for (const block of blocks) {
      if (block.type !== 'text') continue
      const remain = maxChars - used
      if (remain <= 0) break
      const text = block.text.length > remain ? `${block.text.slice(0, remain)}
…（已截断）` : block.text
      used += text.length
      clamped.push({ type: 'text', text })
    }
    if (clamped.length === 0) clamped.push({ type: 'text', text: '（工具没有返回文本内容）' })
    return { content: clamped, isError: result.isError === true }
  } catch (error) {
    return { content: [{ type: 'text', text: `工具执行失败：${String((error as Error)?.message ?? error)}` }], isError: true }
  }
}

/** 请求里带的会话 id（空串 = 客户端没取到）。 */
function sessionIdOf(body: AnalyzeBody): string {
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

/** 注册路由、解析模型路由、转发 LLM 流。 */
export function apply(ctx: Context, rawConfig: Config): void {
  const config: Config = {
    provider: rawConfig?.provider ?? '',
    model: rawConfig?.model ?? '',
    reasoningEffort: rawConfig?.reasoningEffort ?? 'high',
    translationReasoningEffort: rawConfig?.translationReasoningEffort ?? 'low',
    historyMaxEntries: rawConfig?.historyMaxEntries ?? 20,
    temperature: rawConfig?.temperature ?? -1,
    maxTokens: rawConfig?.maxTokens ?? 0,
    timeoutMs: rawConfig?.timeoutMs ?? 300000,
    maxSelectionChars: rawConfig?.maxSelectionChars ?? 4000,
    maxContextChars: rawConfig?.maxContextChars ?? 12000,
    maxRequestsPerMinute: rawConfig?.maxRequestsPerMinute ?? 40,
    sessionContext: rawConfig?.sessionContext ?? true,
    sessionContextMaxMessages: rawConfig?.sessionContextMaxMessages ?? 24,
    sessionContextFastMessages: rawConfig?.sessionContextFastMessages ?? 8,
    sessionContextMaxChars: rawConfig?.sessionContextMaxChars ?? 0,
    resultCacheTtlMs: rawConfig?.resultCacheTtlMs ?? 600000,
    tools: rawConfig?.tools ?? true,
    toolNames: rawConfig?.toolNames ?? 'advanced_search,platform_search,read,grep,glob',
    fallbackToolNames: rawConfig?.fallbackToolNames ?? 'web_search',
    maxToolRounds: rawConfig?.maxToolRounds ?? 2,
    toolResultMaxChars: rawConfig?.toolResultMaxChars ?? 3000,
    toolReadRoot: rawConfig?.toolReadRoot ?? '',
    chatReasoningEffort: rawConfig?.chatReasoningEffort ?? 'high',
  }

  /** 兜底路由：第一次真实 LLM 调用后捕获。 */
  let captured: Route | null = null
  ctx.on('llm/stream', (options, next) => {
    captured = { provider: options.provider, model: options.model }
    return next()
  })

  /** 解析本次调用使用的模型路由。 */
  /**
   * 可选模型清单（带每个模型支持的推理等级）。
   *
   * 用 `llm.listProviders()`（同步）→ `llm.listModels(provider)`（异步，可能触发端点发现）→
   * `llm.resolveModel(provider, model)` 拿 `reasoning.efforts`。因为可能慢，这里做 60 秒缓存，
   * 并且**只在 /models 路由里调用**，不进 ping / analyze 的热路径。
   */
  type ModelChoice = {
    provider: string
    providerName: string
    model: string
    name: string
    efforts: Array<{ id: string; name: string }>
    defaultEffort: string | null
  }
  let modelCache: { at: number; items: ModelChoice[] } = { at: 0, items: [] }
  /** 哪些 provider/model 在 "关" 档会把思考写进正文（实测过一次就记住，之后自动改用「低」）。 */
  const leakyOnOff = new Set<string>()
  const leakyFile = (): string => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'selection-explain', 'leaky-off.json')
  let leakyLoaded = false

  /** 载入"关档会泄漏思考"的模型清单（跨重启保留；文件坏了就当空）。 */
  async function loadLeaky(): Promise<void> {
    if (leakyLoaded) return
    leakyLoaded = true
    try {
      const raw = await readFile(leakyFile(), 'utf8')
      const parsed = JSON.parse(raw) as { routes?: unknown }
      if (Array.isArray(parsed?.routes)) {
        for (const item of parsed.routes) if (typeof item === 'string' && item) leakyOnOff.add(item)
      }
    } catch {
      /* 没有这个文件是常态 */
    }
  }

  function saveLeaky(): void {
    const body = JSON.stringify({ version: 1, routes: Array.from(leakyOnOff) }, null, 0)
    void writeFile(leakyFile(), body, 'utf8').catch((error: unknown) => {
      ctx.logger?.warn?.(`[${name}] 泄漏清单写盘失败：${String((error as Error)?.message ?? error)}`)
    })
  }

  /** 记住一个"关档会泄漏"的模型（内存 + 落盘）。 */
  function markLeaky(route: string): void {
    if (leakyOnOff.has(route)) return
    leakyOnOff.add(route)
    if (leakyLoaded) saveLeaky()
  }
  const MODEL_CACHE_MS = 60_000

  async function listModelChoices(force = false): Promise<ModelChoice[]> {
    if (!force && modelCache.items.length > 0 && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.items
    const llm = ctx.get('llm') as
      | {
          listProviders?: () => Array<{ id?: string; name?: string }>
          listModels?: (provider: string) => Promise<Array<{ id?: string; name?: string }>>
          /** 服务上的公开方法叫 resolveModelInfo；resolveModel 是 adapter 侧的（实测踩过：调错名字 → efforts 永远为空） */
          resolveModelInfo?: (
            provider: string,
            model: string,
            signal?: AbortSignal,
          ) => Promise<{ reasoning?: { efforts?: Array<{ id?: string; name?: string }>; defaultEffort?: string } } | null>
          resolveModel?: (
            provider: string,
            model: string,
          ) => Promise<{ reasoning?: { efforts?: Array<{ id?: string; name?: string }>; defaultEffort?: string } } | null>
        }
      | undefined
    const items: ModelChoice[] = []
    const providers = llm?.listProviders?.() ?? []
    for (const provider of providers) {
      if (!provider?.id || typeof llm?.listModels !== 'function') continue
      let models: Array<{ id?: string; name?: string }> = []
      try {
        models = (await llm.listModels(provider.id)) ?? []
      } catch {
        models = []
      }
      for (const model of models) {
        if (!model?.id) continue
        let efforts: Array<{ id: string; name: string }> = []
        let defaultEffort: string | null = null
        try {
          // 两个方法签名不同，各自显式标注，避免联合类型把返回值退化成 any
          type Resolved = { reasoning?: { efforts?: Array<{ id?: string; name?: string }>; defaultEffort?: string } } | null
          let info: Resolved = null
          if (typeof llm.resolveModelInfo === 'function') {
            info = (await llm.resolveModelInfo(provider.id, model.id)) as Resolved
          } else if (typeof llm.resolveModel === 'function') {
            info = (await llm.resolveModel(provider.id, model.id)) as Resolved
          }
          const list = info?.reasoning?.efforts ?? []
          efforts = list
            .filter((item) => typeof item?.id === 'string' && item.id.length > 0)
            .map((item) => ({ id: String(item.id), name: String(item.name ?? item.id) }))
          defaultEffort = typeof info?.reasoning?.defaultEffort === 'string' ? info.reasoning.defaultEffort : null
        } catch {
          efforts = []
        }
        items.push({
          provider: provider.id,
          providerName: String(provider.name ?? provider.id),
          model: model.id,
          name: String(model.name ?? model.id),
          efforts,
          defaultEffort,
        })
      }
    }
    if (items.length > 0) modelCache = { at: Date.now(), items }
    return items
  }

  /** 请求里带 provider+model 时优先用它（并按清单校验；清单还没加载出来就只做形状校验）。 */
  const resolveRoute = (override?: { provider?: string; model?: string }): Route | null => {
    if (override?.provider && override?.model) {
      const wanted = { provider: override.provider, model: override.model }
      const known = modelCache.items.some((item) => item.provider === wanted.provider && item.model === wanted.model)
      if (known || modelCache.items.length === 0) return wanted
    }
    if (config.provider && config.model) return { provider: config.provider, model: config.model }
    const service = ctx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined
    const selection = service?.currentSelection?.()
    if (selection?.provider && selection?.model) {
      return { provider: selection.provider, model: selection.model }
    }
    const llm = ctx.get('llm') as
      | { listProviders?: () => Array<{ id?: string; models?: Array<{ id?: string }> }> }
      | undefined
    const first = llm?.listProviders?.()?.find((item) => (item.models?.length ?? 0) > 0)
    if (first?.id && first.models?.[0]?.id) return { provider: first.id, model: first.models[0].id }
    return captured
  }

  /** 分钟级限流。 */
  const hits: number[] = []
  const allow = (): boolean => {
    const now = Date.now()
    while (hits.length > 0 && now - hits[0] > 60_000) hits.shift()
    if (hits.length >= config.maxRequestsPerMinute) return false
    hits.push(now)
    return true
  }

  /**
   * 共享结果缓存（进程级，跨标签页/刷新可用）：
   * 同会话 + 同选中文字 + 同局部片段 + 同会话背景 → 直接回放上次结果，不再调用模型。
   */
  const resultCache = new Map<string, { at: number; text: string }>()
  const resultKeyOf = (provider: string, model: string, sessionId: string, backgroundText: string, text: string, context: string): string =>
    createHash('sha1').update([provider, model, sessionId, backgroundText, text, context].join('\u0000')).digest('hex')

  /** 会话背景短缓存：同一会话 10 秒内复用（连续划词不重复读日志）。 */
  const backgroundCache = new Map<string, { at: number; events: readonly unknown[] }>()

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

  // ───────────────────────── 小窗对话历史（A′） ─────────────────────────
  //
  // 为什么不建成会话：会话是重型对象（侧栏条目 + 磁盘目录 + 索引），而且当前
  // 部署**没有删除会话的接口**——一个高频功能每次划词建一个会话，只会堆积成
  // 一堆删不掉的死会话。所以这里把"整段对话"存在插件自己的目录里：
  //   · 一个条目 = 一次划词解读（含它自己的全部追问轮次）
  //   · 只留最近 `historyMaxEntries` 个条目（LRU），升格过的不参与淘汰
  //   · 重划同一个词 → 直接回放，不调模型

  interface HistoryTurn {
    role: string
    text: string
  }
  /** 落库入参：一律宽松收，内部统一裁剪（来源是浏览器，不能信）。 */
  interface HistoryInput {
    key?: unknown
    text?: unknown
    context?: unknown
    label?: unknown
    parts?: { translation?: unknown; detail?: unknown }
    turns?: { role?: unknown; text?: unknown }[]
    toolDigest?: unknown
    pinned?: unknown
  }
  interface HistoryEntry {
    key: string
    text: string
    context: string
    label: string
    at: number
    parts: { translation: string; detail: string }
    turns: HistoryTurn[]
    toolDigest: string
    pinned: boolean
  }

  const history = new Map<string, HistoryEntry>()
  let historyLoaded = false
  let historyTimer: ReturnType<typeof setTimeout> | null = null

  const historyFile = (): string =>
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'selection-explain', 'history.json')

  const clampText = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

  async function loadHistory(): Promise<void> {
    if (historyLoaded) return
    historyLoaded = true
    try {
      await loadLeaky()
      const raw = await readFile(historyFile(), 'utf8')
      const parsed = JSON.parse(raw) as { entries?: unknown }
      const list = Array.isArray(parsed?.entries) ? parsed.entries : []
      for (const item of list) {
        const entry = item as Partial<HistoryEntry>
        if (typeof entry?.key !== 'string' || entry.key.length === 0) continue
        history.set(entry.key, {
          key: entry.key,
          text: clampText(entry.text, 4000),
          context: clampText(entry.context, 20000),
          label: clampText(entry.label, 60),
          at: typeof entry.at === 'number' ? entry.at : Date.now(),
          parts: {
            translation: clampText(entry.parts?.translation, 20000),
            detail: clampText(entry.parts?.detail, 20000),
          },
          turns: Array.isArray(entry.turns)
            ? entry.turns.slice(0, 60).map((turn) => ({
                role: turn?.role === 'assistant' ? 'assistant' : 'user',
                text: clampText(turn?.text, 20000),
              }))
            : [],
          toolDigest: clampText(entry.toolDigest, 2000),
          pinned: entry.pinned === true,
        })
      }
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
          await mkdir(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'selection-explain'), { recursive: true })
          await writeFile(historyFile(), JSON.stringify({ version: 1, entries }, null, 0), 'utf8')
        } catch (error) {
          ctx.logger?.warn?.(`[${name}] 写入小窗历史失败：${String((error as Error)?.message ?? error)}`)
        }
      })()
    }, 800)
    historyTimer.unref?.()
  }

  /** 存一条对话（整段覆盖），并按 LRU 淘汰超出上限的条目（升格过的不淘汰）。 */
  function saveHistoryEntry(input: HistoryInput): number {
    if (config.historyMaxEntries <= 0) return history.size
    const key = clampText(input.key, 200)
    if (!key) return history.size
    const previous = history.get(key)
    const entry: HistoryEntry = {
      key,
      text: clampText(input.text, 4000),
      context: clampText(input.context, 20000),
      label: clampText(input.label, 60),
      at: Date.now(),
      parts: {
        translation: clampText(input.parts?.translation, 20000),
        detail: clampText(input.parts?.detail, 20000),
      },
      turns: Array.isArray(input.turns)
        ? input.turns.slice(0, 60).map((turn) => ({
            role: turn?.role === 'assistant' ? 'assistant' : 'user',
            text: clampText(turn?.text, 20000),
          }))
        : [],
      toolDigest: clampText(input.toolDigest, 2000),
      pinned: input.pinned === true || previous?.pinned === true,
    }
    history.delete(key)
    history.set(key, entry)
    // LRU：超出上限时丢最久没用过的（Map 的插入顺序就是使用顺序）
    while (history.size > config.historyMaxEntries) {
      let victim: string | undefined
      for (const candidate of history.keys()) {
        const item = history.get(candidate)
        if (item && !item.pinned) {
          victim = candidate
          break
        }
      }
      if (victim === undefined) break
      history.delete(victim)
    }
    scheduleHistoryWrite()
    return history.size
  }

  const historyMeta = (entry: HistoryEntry): Record<string, unknown> => ({
    key: entry.key,
    text: entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text,
    label: entry.label,
    at: entry.at,
    turns: entry.turns.filter((turn) => turn.role === 'user').length,
    hasDetail: entry.parts.detail.length > 0,
    pinned: entry.pinned,
  })

  const handleHistory = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      await loadHistory()
      if (config.historyMaxEntries <= 0) {
        sendJson(res, 200, { ok: true, entries: [] })
        return
      }
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
        const entry = (body as { entry?: HistoryEntry }).entry
        if (!entry || typeof entry.key !== 'string' || !entry.key) {
          sendJson(res, 400, { ok: false, error: '缺少 entry' })
          return
        }
        history.delete(entry.key)
        history.set(entry.key, entry)
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
          turns: (Array.isArray(body?.turns) ? body.turns : []) as { role?: unknown; text?: unknown }[],
          toolDigest: typeof body?.toolDigest === 'string' ? body.toolDigest : '',
          pinned: body?.pinned === true,
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

  /** GET /models：给「模型」菜单用（带每个模型支持的推理等级；60 秒缓存）。 */
  async function handleModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await loadLeaky() // 不 await 的话，这条路由在读"关档会泄漏"的清单时文件还没载入（实测报空）
    const url = new URL(req.url ?? '/', 'http://localhost')
    const force = url.searchParams.get('refresh') === '1'
    let items: ModelChoice[] = []
    let error = ''
    try {
      items = await listModelChoices(force)
    } catch (thrown) {
      error = String((thrown as Error)?.message ?? thrown)
    }
    const current = resolveRoute()
    sendJson(res, 200, {
      ok: true,
      current,
      cached: Date.now() - modelCache.at < MODEL_CACHE_MS,
      ...(error ? { error } : {}),
      models: items,
      // 进程内学到的"关档会把思考写进正文"的模型（客户端据此在菜单里标注；重启后由客户端本地记忆兜着）
      leakyOff: Array.from(leakyOnOff),
      // 前端按 provider+model 匹配"当前档"
      stages: {
        chat: config.chatReasoningEffort || config.reasoningEffort,
        translation: config.translationReasoningEffort || config.reasoningEffort,
        detail: config.reasoningEffort,
      },
    })
  }

  const handlePing = (req: IncomingMessage, res: ServerResponse): void => {
    const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
    // 可以带 ?sessionId=xxx：工具是**按会话作用域**注册的，不带 id 只能看到全局视图（里面没有 web_search）
    let pingSessionId = ''
    try {
      pingSessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? ''
    } catch {
      /* 解析不了就当没带 */
    }
    // 小窗能调哪些工具：白名单是配置，实际放行还要看本机能不能抓网页（见下）。
    // 用 async 包一层：探测 DNS 是异步的，出错也要给出结构化响应（和 history 路由同一写法）。
    void (async () => {
      const whitelist = config.toolNames
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
      const agents = ctx.get('agents') as { get?: (id: string) => unknown; list?: () => unknown[] } | undefined
      // 复刻 handleAnalyze 的作用域回退：本会话 agent 取不到就用任一活跃 agent
      let pingAgent = pingSessionId ? agents?.get?.(pingSessionId) : undefined
      let pingScope = pingAgent ? 'session' : ''
      if (!pingAgent) {
        pingAgent = agents?.list?.()?.[0]
        pingScope = pingAgent ? 'fallback' : 'global'
      }
      let visible: string[] = []
      let visibleError = ''
      let toolInfo: Array<{ name: string; desc: string }> = []
      let toolNames: string[] = []
      let sessionToolCount = 0
      try {
        // 必须带着 registry 调（`const f = registry.schemas; f(...)` 会把 this 丢掉 → 拿到空表）
        const registry = ctx.get('tools') as { schemas?: (scope?: unknown) => ToolSchema[] } | undefined
        const all = registry?.schemas?.(pingAgent) ?? []
        sessionToolCount = all.length
        visible = all.map((schema) => schema.name).filter((toolName) => whitelist.includes(toolName))
        // 诊断用：会话里这几个工具到底是哪个插件提供的（描述前 70 字能认出来）
        toolInfo = all.map((schema) => ({
          name: schema.name,
          desc: String(schema.description ?? '').replace(/\s+/g, ' ').slice(0, 70),
        }))
        toolNames = all.map((schema) => schema.name)
      } catch (error) {
        visibleError = String((error as Error)?.message ?? error)
      }
      // 本机抓不了网页时 web_fetch 会被摘掉（探针缓存 5 分钟，这里复用同一个）
      let fetchBlocked = ''
      if (whitelist.includes('web_fetch')) {
        const probe = await webFetchUsable()
        if (!probe.usable) fetchBlocked = probe.sample
      }
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        route: resolveRoute(),
        reasoningEffort: config.reasoningEffort,
        modelsRoute: `${API_PREFIX}/models`,
        history: { maxEntries: config.historyMaxEntries, file: historyFile() },
        // 三档分开报：一眼看出"首轮为什么快、详解为什么慢"
        reasoningEffortByStage: {
          translation: config.translationReasoningEffort,
          detail: config.reasoningEffort,
          chat: config.chatReasoningEffort,
        },
        // 小窗能用哪些工具：whitelist=配置允许，offered=这一轮真会交给模型的
        tools: {
          enabled: config.tools && config.maxToolRounds > 0,
          whitelist,
          offered: visible.filter((toolName) => !(toolName === 'web_fetch' && fetchBlocked)),
          // 文件类工具的读取边界：'' = 会话工作目录，'*' = 不限制
          readRoot: config.toolReadRoot === '*' ? '(不限)' : config.toolReadRoot || '(会话工作目录)',
          visible: visibleError ? '读取工具表失败：' + visibleError : visible.length,
          // 备用联网工具是否启用（没装 free-search 时会补上 web_search）
          fallback: config.fallbackToolNames,
          preferredSearchPresent: visible.includes('advanced_search') || visible.includes('platform_search'),
          toolInfo,
          toolNames,
          // 这个会话一共能看到多少工具（放行的是白名单里那几个，其余一律不可用）
          sessionTools: sessionToolCount,
          scope: pingScope,
          maxRounds: config.maxToolRounds,
          fetchBlocked,
        },
        sessionContext: config.sessionContext && typeof sessionQuery?.readSurface === 'function',
        limits: {
          maxSelectionChars: config.maxSelectionChars,
          maxContextChars: config.maxContextChars,
          sessionContextMaxMessages: config.sessionContextMaxMessages,
          sessionContextFastMessages: config.sessionContextFastMessages,
          sessionContextMaxChars: config.sessionContextMaxChars,
        },
      })
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    })
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

  /** 可写的 live 会话（只用到 append）。 */
  interface LiveSessionLike {
    append?: (type: string, data: unknown, options?: unknown) => unknown
  }

  /**
   * 把划词解读小窗「升格」成正式会话（建在来源会话同一个项目下）：
   *   ① 建会话 → ② 注入上下文消息（选中文字/所在位置/上下文片段，plugin 来源的 context 消息）
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
    const cwd = await resolveSessionCwd(sourceSessionId)
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

      const label = clampText(body.label, 80) || '页面内容'
      const contextText = clampText(body.context, config.maxContextChars) || '（未记录）'
      const translation = clampText(body.translation, 8000)
      const detail = clampText(body.detail, 12000)
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

        // 第 1 轮：上下文消息（plugin 来源 + snapshot 呈现）+ 首轮解读
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
              kind: 'plugin',
              plugin: name,
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

  const handleAnalyze = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
    if (text.length === 0) {
      sendJson(res, 400, { error: '缺少 text（选中文字）' })
      return
    }
    if (text.length > config.maxSelectionChars) {
      sendJson(res, 413, { error: `选中文字过长（${text.length} > ${config.maxSelectionChars} 字符）` })
      return
    }
    if (!allow()) {
      sendJson(res, 429, { error: `请求过于频繁（上限 ${config.maxRequestsPerMinute}/分钟）` })
      return
    }
    const override =
      typeof body.provider === 'string' && typeof body.model === 'string' && body.provider && body.model
        ? { provider: body.provider, model: body.model }
        : undefined
    const route = resolveRoute(override)
    if (!route) {
      sendJson(res, 503, { error: '尚未确定模型路由：请先在设置里选择默认模型后重试' })
      return
    }

    const context = clampText(body.context, config.maxContextChars)
    const label = clampText(body.label, 80)
    // 页面标题/地址不写进提示词：模型会把它当成「选中文字里的英文」去翻译（实测把标题 DSH 译了一遍）

    // 会话背景：从 sessionQuery 读取当前会话的模型界面（live 优先，含持久化会话）
    let background: SessionBackground | null = null
    if (config.sessionContext) {
      const sessionId = sessionIdOf(body)
      if (sessionId) {
        // 背景预算按阶段：首轮只要翻译（8 条够定指代）；详解与追问都是深度交互，吃满 24 条
        const stage = typeof body.stage === 'string' ? body.stage : ''
        const wantsFull = stage === 'detail' || typeof body.question === 'string'
        background = await loadSessionBackground(sessionId, {
          maxMessages: wantsFull ? config.sessionContextMaxMessages : config.sessionContextFastMessages,
          maxChars: config.sessionContextMaxChars,
          marker: text,
        })
      }
    }

    // 顺序即缓存策略：前缀必须“只增不变”才能复用 ——
    //   ① 会话背景（同一会话内基本不变）→ ② 固定说明 → ③ 动态尾部（选中文字/局部片段）
    // 反过来写（动态在前、背景在后）会让缓存前缀在“选中文字”处就断掉：
    // 实测同会话换一处选中，命中量从 5760 tokens 掉到 640~768。
    const stablePrefix: string[] = []
    if (background && background.transcript) {
      stablePrefix.push(
        `【会话背景】（按时间顺序；${background.marked ? '最后一条即选中文字所在的消息，已用 ▶ 标出，其后的对话未包含' : '未能定位选中位置，取的是最近的对话'}）`,
        background.transcript,
        '',
        '上面是会话背景；下面是需要你解读的【选中文字】及其上下文。',
        '',
      )
    }
    const userText = [
      ...stablePrefix,
      '【选中文字】',
      text,
      '',
      `【所在位置】${label || '页面内容'}`,
      '',
      '【选中处的上下文片段】（选中部分用【】标出）',
      context || '（未能取到上下文片段，请仅根据选中文字与会话背景作答）',
    ].join('\n')

    const effort = typeof body.effort === 'string' && body.effort.length > 0 ? body.effort : config.reasoningEffort
    // 追问模式：客户端带 question 时，就是「就这段选中文字继续聊」
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    const isChat = question.length > 0
    const historyMessages: Message[] = []
    if (isChat) {
      const rawHistory = Array.isArray(body.history) ? body.history : []
      for (const turn of rawHistory.slice(-20)) {
        const item = turn as { role?: unknown; text?: unknown }
        const text = typeof item.text === 'string' ? item.text : ''
        if (!text) continue
        if (item.role === 'assistant') {
          historyMessages.push(createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: route.provider, model: route.model } }))
        } else {
          historyMessages.push(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
        }
      }
    }

    const cacheKey = resultKeyOf(
      route.provider,
      route.model,
      sessionIdOf(body) + '|' + effort + '|' + (typeof body.stage === 'string' ? body.stage : 'translation'),
      background?.transcript ?? '',
      text,
      context,
    )
    const useResultCache = !isChat && config.resultCacheTtlMs > 0 && body.refresh !== true
    const cached = useResultCache ? resultCache.get(cacheKey) : undefined
    if (cached && Date.now() - cached.at < config.resultCacheTtlMs) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      sse(res, {
        type: 'start',
        provider: route.provider,
        model: route.model,
        cached: true,
        context: { chars: context.length, label, session: background ? { chars: background.transcript.length, marked: background.marked } : null },
      })
      sse(res, { type: 'delta', text: cached.text })
      sse(res, { type: 'done', chars: cached.text.length, cached: true })
      res.end()
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const controller = new AbortController()
    let finished = false
    /** 诊断：客户端（浏览器/探针）在流还没结束时就把连接关了 —— 会让上游被 abort，表现为"输出到一半停了"。 */
    let clientClosedEarly = false
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    res.on('close', () => {
      if (!finished) {
        clientClosedEarly = true
        ctx.logger?.warn?.(`[${name}] 客户端提前断开（流未结束）：已中止上游，避免继续消耗 token`)
        controller.abort()
      }
    })

    // 可用工具（白名单，默认只有联网搜索/抓取）：交给模型自己决定要不要用。
    // 注意工具是「按会话作用域」注册的（全局视图里看不到 web_search 等），
    // 所以要拿该会话的 agent 当 scope 去查，并把同一个 agent 传给 execute。
    const agents = ctx.get('agents') as { get?: (id: string) => unknown; list?: () => unknown[] } | undefined
    const sessionId = sessionIdOf(body)
    let agent = sessionId ? agents?.get?.(sessionId) : undefined
    let agentScope = agent ? 'session' : ''
    if (!agent) {
      // 回退：本会话还没起 agent（刚开的新会话／agent 已释放）时，用任一活跃 agent 当作用域。
      // 不这么做的话，session-scoped 的 web_search/web_fetch 在全局视图里根本不可见 →
      // 工具静默为空，模型还会把工具调用当正文吐出来（实测见过 <ds_safety_tool_call>）。
      const live = agents?.list?.() ?? []
      if (live.length > 0) {
        agent = live[0]
        agentScope = 'fallback'
      }
    }
    const toolSchemas: ToolSchema[] = []
    /** 诊断：这一轮是不是走了"备用联网工具"（首选联网工具一个都不在）。 */
    let toolFallbackUsed = false
    if (config.tools && config.maxToolRounds > 0) {
      const registry = ctx.get('tools') as { schemas?: (scope?: unknown) => ToolSchema[] } | undefined
      const split = (value: string): string[] =>
        value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
      let visible: ToolSchema[] = []
      try {
        visible = registry?.schemas?.(agent) ?? []
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] 读取工具表失败：${String((error as Error)?.message ?? error)}`)
      }
      const allowed = resolveToolNames(
        split(config.toolNames),
        split(config.fallbackToolNames),
        visible.map((schema) => schema.name),
      )
      toolFallbackUsed = !allowed.includes('advanced_search') && !allowed.includes('platform_search')
      for (const schema of visible) {
        if (allowed.includes(schema.name)) toolSchemas.push(schema)
      }
    }

    // 本机抓不了网页（fake-IP 代理 / SSRF 防护）时，把 web_fetch 摘掉：
    // 否则模型每次都要白跑一轮（5~15s）才拿到"resolves to a non-public IP address"。
    let fetchBlockedSample = ''
    if (toolSchemas.some((schema) => schema.name === 'web_fetch')) {
      const probe = await webFetchUsable()
      if (!probe.usable) {
        fetchBlockedSample = probe.sample
        for (let i = toolSchemas.length - 1; i >= 0; i -= 1) {
          if (toolSchemas[i]?.name === 'web_fetch') toolSchemas.splice(i, 1)
        }
        ctx.logger?.warn?.(`[${name}] 网页抓取不可用（域名解析到 ${probe.sample}，属保留地址段），已从工具表移除 web_fetch`)
      }
    }

    // 文件类工具的边界：默认只允许会话工作目录；'*' = 不限制；配置了具体目录就用它。
    // 拿不到工作目录时**不设限**（否则新会话里 read 直接全废），但会打日志说明。
    const wantsFsTools = toolSchemas.some((schema) => FS_TOOL_NAMES.includes(schema.name))
    let readRoot = ''
    if (wantsFsTools) {
      if (config.toolReadRoot === '*') {
        readRoot = ''
      } else {
        readRoot = config.toolReadRoot || (await resolveSessionCwd(sessionIdOf(body))) || ''
        if (!readRoot) ctx.logger?.warn?.(`[${name}] 拿不到会话工作目录，文件工具本次不设边界`)
      }
    }

    const stage = typeof body.stage === 'string' ? body.stage : ''
    // 选中文字是代码：首轮走「注释」提示词（代码块 + 逐句注释 + 小结）
    const isCode = body.kind === 'code'
    const basePrompt = isChat
      ? CHAT_SYSTEM_PROMPT
      : stage === 'detail'
        ? DETAIL_PROMPT
        : isCode
          ? CODE_PROMPT
          : TRANSLATION_PROMPT
    // 一个工具都没有时明确禁止伪造调用（模型会照着自己的习惯吐 <ds_safety_tool_call> 之类的格式）
    // 正文里不许写"盘算过程"（模型在工具轮里很容易把"I should search again…"这类写进正文）
    const narrateRule =
      '\n\n【正文只写结论】不要把思考、盘算、自查过程写进正文（"我还得再搜一次""先看看拿到的标题""让我确认一下"这类一律不写）；需要工具就直接调用，调用前后都不要解说。'
    // 输出偏好（小窗开关）：左档 Markdown / 右档 网页。
    // 关档也要明确说"用 Markdown"——否则标签写着 Markdown、行为却可能自己给整页 HTML，开关就名不副实。
    let webRule = ''
    if (isChat && body.webAnswer !== true) {
      webRule =
        '\n\n【输出偏好：Markdown】用户把输出偏好设为 Markdown：默认用普通文字/Markdown 回答' +
        '（标题、列表、表格、代码块都可以）。' +
        '**这不禁止 HTML**——如果这个问题用一页 HTML 明显讲得更清楚，照样可以用网页回答；' +
        '只是不要单纯为了"好看"就把简单问题做成页面。'
    }
    if (isChat && body.webAnswer === true) {
      const skill = await loadDesignSkill()
      webRule =
        '\n\n【输出偏好：网页】这不是"一律用网页"，而是**网页优先**：\n' +
        '- **复杂问题**（需要对比、流程、层级、图表，或者文字答案会长到不好读）→ 直接给完整的单文件 HTML' +
        '（放进 ```html 代码块），**页面本身就是答案**，不要再用文字复述一遍；\n' +
        '- **简单问题**（一两段话能说清、不需要并列或图示）→ **仍然直接用文字回答**。' +
        '不要为了用网页而用网页，也不要把简单问题包装成页面。\n' +
        '拿不准时按"能不能用一小段话讲清"来判断：能，就文字。\n' +
        '用网页时，页面会渲染在大约 **500px 宽**的小窗里，按下面的设计规范做：\n\n' +
        skill
    }
    const fileRule = wantsFsTools
      ? `\n\n【文件访问】你可以用 read/grep/glob 查看当前项目里的文件（范围：${readRoot || '不限'}）。超出该范围的路径会被拒绝；引用文件内容时只取必要的一两行，不要整段粘贴。`
      : ''
    const fetchRule = fetchBlockedSample
      ? `\n\n【抓取网页不可用】本机域名解析到保留地址段（${fetchBlockedSample}），网页抓取会被安全策略拒绝：只做联网搜索，**不要尝试抓取具体网址**（省掉一次注定失败的往返）。`
      : ''
    const systemPrompt =
      (toolSchemas.length > 0
        ? basePrompt
        : `${basePrompt}\n\n【本轮没有可用工具】不要输出任何工具调用格式（如 <ds_safety_tool_call>、tool_calls、JSON 形式的调用），也不要声称你查过；需要实时/外部信息时直接说明你无法联网或无法读取，只基于已知信息作答。`) +
      narrateRule +
      webRule +
      fileRule +
      fetchRule
    // 三档分开：翻译（默认 low，只要快）／详解（默认 reasoningEffort=high，要深）／追问（chatReasoningEffort=high，要准）
    // 三档分开：翻译（默认 low，只要快）／详解（默认 reasoningEffort=high，要深）／追问（默认 chatReasoningEffort=high）
    // 但**追问档**允许请求覆盖（小窗的「推理等级（追问档）」控件靠这条生效）：
    // 首轮/详解仍按各自的配置走 —— 首轮故意用低档换速度，不该被追问档的设置带跑。
    await loadLeaky()
    let bodyEffort = typeof body.effort === 'string' && body.effort.length > 0 ? body.effort : ''
    // 这个模型在"关"档会把思考写进正文（实测过）：别再发 none，直接抬到 low —— 既没泄漏，也不慢
    const routeKey = `${route.provider}/${route.model}`
    if (isChat && bodyEffort === 'off' && leakyOnOff.has(routeKey)) {
      bodyEffort = 'low'
      sse(res, {
        type: 'notice',
        code: 'effort-clamped',
        tier: 'off',
        text: '该模型在「关」档会把思考写进正文，已自动改用「低」档',
      })
    }
    const requestEffort = isChat
      ? bodyEffort || config.chatReasoningEffort || effort
      : stage === 'detail'
        ? effort
        : config.translationReasoningEffort || effort

    sse(res, {
      type: 'start',
      provider: route.provider,
      model: route.model,
      mode: isChat ? 'chat' : stage === 'detail' ? 'detail' : isCode ? 'code' : 'translation',
      stage: stage === 'detail' ? 'detail' : 'translation',
      backgroundMessages: background ? background.transcript.split('\n').filter((line) => /^\s*(▶\s*)?(用户|助手)：/.test(line)).length : 0,
      effort: requestEffort,
      tools: toolSchemas.map((schema) => schema.name),
      toolScope: agentScope,
      ...(toolFallbackUsed ? { toolFallbackUsed: true } : {}),
      ...(wantsFsTools ? { readRoot: readRoot || '(不限)' } : {}),
      ...(fetchBlockedSample ? { fetchBlocked: fetchBlockedSample } : {}),
      context: {
        chars: context.length,
        label,
        session: background
          ? {
              chars: background.transcript.length,
              marked: background.marked,
              // 背景短哈希：用于核对「前缀是否真的没变」（缓存命中的前提）
              hash: createHash('sha1').update(background.transcript).digest('hex').slice(0, 10),
            }
          : null,
      },
      ...(body.debug === true
        ? { debug: { system: systemPrompt, user: userText, sizes: { system: systemPrompt.length, user: userText.length } } }
        : {}),
    })
    let chars = 0
    const baseMessage = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: userText }],
    })
    // 上一轮查过的东西一并带上：否则追问会反复重查同样的内容（一次工具往返 20~34s）
    const toolDigest = typeof body.toolDigest === 'string' ? body.toolDigest.trim().slice(0, 2000) : ''
    const questionText = toolDigest
      ? `${question}\n\n【本会话已经查到的结果】（同一会话里查过的，不要重复查同样的内容）\n${toolDigest}`
      : question
    const openingMessages: Message[] = isChat
      ? [...historyMessages, createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: questionText }] })]
      : []
    try {
      let errored = false
      let usage: unknown = null
      let answer = ''
      const toolMessages: Message[] = []
      let toolCalls = 0
      // 允许的工具轮 + 1 个**收尾轮**：收尾轮不带任何工具。
      // 不加这一轮的话，模型每轮都调工具时循环直接结束，正文是空的——
      // 用户看到的就是"转了半天，但没有任何回答"。
      let errorMessage = ''
      let errorCode: string | undefined
      const toolDigestLines: string[] = []
      /** 被残渣过滤器丢掉的字数：末尾那些"模型顺手又调了一次工具"的标记会让正文停在半句上。 */
      let residueDropped = 0
      /**
       * 逐轮诊断（放进 done 事件）：原始字数 / 过滤后字数 / 思考字数 / 残渣丢弃 / finish 原因 / 输出 tokens。
       * 用来回答"到底是模型没吐、还是被我们的过滤器吃掉了、还是上游掐流"——不靠猜。
       */
      const roundDiag: Array<Record<string, unknown>> = []
      let conclusionInfo: { tried: boolean; chars: number; rounds: number; error: string } = {
        tried: false,
        chars: 0,
        rounds: 0,
        error: '',
      }
      const toolRounds = config.maxToolRounds + 1
      // 档位被上游拒绝时（400/401/500）去掉档位重试一次：清单里声明的档位是**建议值**，
      // 实测很多模型并不接受 max（qwen3.7-max 直接 400、minimax-m2.7/gpt-5.6-luna 500）。
      const canRetryEffort = isChat && bodyEffort.length > 0
      let effortRetried = false
      let roundEffort = requestEffort
      for (let round = 0; round <= toolRounds; round += 1) {
        const roundStartedAt = Date.now()
        const wrapUp = round === toolRounds
        const stream = ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          // 带上会话 id：主会话 agent loop 一直传它，适配器会据此设置上游的会话头。
          // 插件以前没传，结果是所有小窗请求共用静态会话头 —— 而中继是按会话跟踪的（实测长回答被掐）。
          ...(sessionId ? { sessionId: sessionId as never } : {}),
          system: undefined,
          messages: [
            createSystemMessage(
              wrapUp
                ? `${systemPrompt}\n\n【收尾】工具轮次已用完：直接基于已经拿到的信息给出结论，不要再请求工具，也不要复述查询过程。` +
                    '正文里不要出现任何工具调用格式（包括 DeepSeek 的 DSML 写法，如 invoke/parameter 标记）——那些会被当作乱码展示给用户。'
                : systemPrompt,
              name,
            ),
            ...(round === 0 ? [baseMessage, ...openingMessages] : [baseMessage, ...openingMessages, ...toolMessages]),
          ],
          ...(!wrapUp && toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
          ...(config.temperature >= 0 ? { temperature: config.temperature } : {}),
          ...(config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}),
          ...(roundEffort ? { reasoningEffort: ReasoningEffortId(roundEffort) } : {}),
          signal: controller.signal,
        })
        const assembler = new BlockAssembler()
        // 本轮吐出的正文字数：这一轮如果最后是要调工具，那这些字其实是"过程旁白"
        // （"我还得再搜一次""先看看拿到的标题"这类），要被撤回，不能当成答案留在小窗里
        let roundText = ''
        // 有的模型把思考内联在正文里（<think>…</think>）：拆出来走 thought，别当答案
        // 每轮一个过滤器：未闭合的残渣块只在本轮内作废。
        // 共用一个的话，某一轮吐了未闭合的 DSML（实测收尾轮很常见）会让 depth 一直 >0，
        // 后面所有轮次的正文都被吞掉 —— 表现就是"只完成了工具查询，没有产出正文"（用户截图报的）。
        const think = createThinkFilter()
        const residue = createResidueFilter()
        let roundRaw = 0
        let roundEmitted = 0
        let roundThink = 0
        let roundFinish = ''
        /** 诊断用：本轮最后若干分片的类型与大小（看上游是发了 finish 还是直接断流）。 */
        const tailChunks: string[] = []
        const emit = (part: { text: string; think: string }): void => {
          if (part.think) {
            roundThink += part.think.length
            sse(res, { type: 'thought', text: part.think })
          }
          // 残渣过滤放在 think 之后：先分出思考，再把正文里的工具调用标记丢掉
          const text = part.text ? residue.push(part.text) : ''
          if (text) {
            roundEmitted += text.length
            chars += text.length
            answer += text
            roundText += text
            sse(res, { type: 'delta', text: text })
          }
        }
        for await (const chunk of stream) {
          assembler.push(chunk)
          if (body.debug === true) {
            const size = chunk.type === 'text-delta' ? chunk.text.length : 0
            tailChunks.push(`${chunk.type}:${size}`)
            if (tailChunks.length > 14) tailChunks.shift()
          }
          if (chunk.type === 'text-delta') {
            roundRaw += chunk.text.length
            emit(think.push(chunk.text))
          } else if (chunk.type === 'reasoning-delta') {
            // 思考过程也透传：首字前那几秒如果只有转圈，用户会以为卡死了。
            // 客户端只留尾部一小段当"正在想什么"的提示，不进正文。
            sse(res, { type: 'thought', text: chunk.text })
          } else if (chunk.type === 'usage') {
            usage = chunk.usage
          } else if (chunk.type === 'finish') {
            roundFinish = String(chunk.reason.kind)
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
              errored = true
              // 先只记下来：如果接下来要"去掉档位重试"，这条错误就不该发给用户
              // （否则客户端先渲染一条失败提示，重试的正文就贴在失败提示后面了）
              errorMessage =
                chunk.reason.failure?.message ?? `模型调用${chunk.reason.kind === 'aborted' ? '被中断' : '失败'}`
              errorCode = chunk.reason.failure?.code
            }
          }
        }
        emit(think.flush())
        // 注意：residue.flush() 吐出的正文**不能再走 emit()** —— emit 会把它再喂回同一个过滤器，
        // 于是 HOLD=32 又扣住尾巴，而本轮到此结束 → 最后 32 字永远不会发出去（实测 raw−emitted 恒为 32）。
        {
          const tailText = residue.flush()
          if (tailText) {
            chars += tailText.length
            answer += tailText
            roundText += tailText
            roundEmitted += tailText.length
            sse(res, { type: 'delta', text: tailText })
          }
        }
        residueDropped += residue.dropped()
        roundDiag.push({
          round,
          wrapUp,
          ms: Date.now() - roundStartedAt,
          raw: roundRaw,
          emitted: roundEmitted,
          think: roundThink,
          residueDropped: residue.dropped(),
          finish: roundFinish || '(none)',
          tools: assembler.blocks().filter((block) => block.type === 'tool-call').length,
          ...(body.debug === true ? { tailChunks } : {}),
          outTokens: (usage as { outputTokens?: number } | null)?.outputTokens,
        })
        if (errored) {
          // 一个字都没吐出来 + 是显式档位导致的失败 → 去掉档位重试**同一轮**
          // （保守：已经吐出正文的失败不重试，避免把半截答案丢掉）
          if (canRetryEffort && !effortRetried && roundText.length === 0) {
            effortRetried = true
            roundEffort = ''
            errored = false
            sse(res, {
              type: 'notice',
              code: 'effort-rejected',
              tier: bodyEffort,
              text: `「${bodyEffort}」档位该模型不支持，已按默认档位重试`,
            })
            round -= 1
            continue
          }
          sse(res, { type: 'error', message: errorMessage, code: errorCode })
          break
        }
        const blocks: ContentBlock[] = assembler.blocks()
        const calls = blocks.filter((block) => block.type === 'tool-call')
        if (calls.length === 0) {
          // 最终答案到手：如果用的是 "关" 档，检查有没有把思考写进正文
          if (isChat && requestEffort === 'off') {
            const split = splitLeakedReasoning(answer)
            if (split.prefix) {
              markLeaky(routeKey)
              answer = split.rest
              chars = answer.length
              sse(res, { type: 'strip', text: split.prefix })
              sse(res, {
                type: 'notice',
                code: 'reasoning-leak',
                tier: 'off',
                text: '该模型在「关」档会把思考写进正文，已撤回泄漏段；以后这一档会自动改用「低」',
              })
            } else if (looksLikeLeakedReasoning(answer)) {
              // 句式没认准（模型每次换说法）→ 这次不裁（怕误删正文），但记住它，下次自动抬档
              markLeaky(routeKey)
              sse(res, {
                type: 'notice',
                code: 'reasoning-leak',
                tier: 'off',
                text: '这个模型在「关」档会把思考写进正文；这一档以后自动改用「低」',
              })
            }
          }
          break
        }
        // 既然这一轮要调工具，它刚才流出来的正文就是"过程旁白"，不是答案：
        // 让前端把这部分撤回去（顺带当成思考尾巴显示），免得"我怎么想的"混进小窗正文。
        // 实测踩过：追问"搜索今天的新闻"时，模型在工具轮里先吐了一段英文盘算
        // （I have sources with dates… Maybe I should do one more search…），
        // 然后才给中文结论，这段英文被当正文渲染进了消息框。
        if (roundText.length > 0) {
          answer = answer.slice(0, Math.max(0, answer.length - roundText.length))
          sse(res, { type: 'drop', chars: roundText.length, text: roundText.slice(-2000), round })
        }
        // 执行工具→把结果回灌，再让模型继续（上限 maxToolRounds 轮）
        toolMessages.push(
          createAssistantMessage({
            content: blocks,
            source: { provider: route.provider, model: route.model },
          }),
        )
        for (const call of calls) {
          if (call.type !== 'tool-call') continue
          toolCalls += 1
          let parsed: unknown = {}
          try {
            parsed = call.arguments ? JSON.parse(call.arguments) : {}
          } catch {
            parsed = {}
          }
          const label2 = describeToolCall(call.name, parsed)
          const callId = String(call.id ?? `round${String(round)}-${String(toolCalls)}`)
          sse(res, { type: 'tool', phase: 'start', callId, name: call.name, detail: label2, round })
          const startedAt = Date.now()
          // 参数名有讲究：read/write/edit 用 file_path，grep/glob 用 path。
          // 只认 path 的话 read 的 file_path 会是 undefined → 边界检查被静默绕过（实测踩过）。
          const rawPath = (parsed as { file_path?: unknown; path?: unknown })?.file_path ?? (parsed as { path?: unknown })?.path
          const wantPath = typeof rawPath === 'string' ? rawPath : ''
          const execution =
            FS_TOOL_NAMES.includes(call.name) && !isInsideRoot(readRoot, wantPath)
              ? {
                  content: [
                    {
                      type: 'text' as const,
                      text: `（越界已拒绝：文件类工具只能访问当前项目目录${readRoot ? `（${readRoot}）` : ''}，请求的路径是 ${wantPath || '(未给)'}）`,
                    },
                  ],
                  isError: true,
                }
              : await runTool(ctx, call.name, parsed, controller.signal, config.toolResultMaxChars, agent)
          // 结果也回传：小窗里能看见"查了什么、命中什么、链接是什么"，否则工具是个黑盒
          const digest = digestToolResult(execution.content)
          sse(res, {
            type: 'tool',
            phase: 'done',
            callId,
            name: call.name,
            detail: label2,
            round,
            ok: !execution.isError,
            ms: Date.now() - startedAt,
            chars: digest.chars,
            preview: digest.preview,
            urls: digest.urls,
          })
          toolMessages.push(createToolResultMessage({ callId: call.id, content: execution.content, isError: execution.isError }))
          // 结论轮要用：把"查了什么 + 拿到了什么"写成纯文本，避免重放工具调用链
          toolDigestLines.push(`· ${call.name}（${label2 || '查询'}）：${digest.preview}`)
        }
      }
      if (!errored && answer.trim().length === 0 && toolCalls > 0 && !effortRetried) {
        // 收尾轮常常"只吐一段工具调用、不写正文"（实测「今天的新闻」一个字都没有）。
        // 这里自己补结论轮：**不重放工具调用链**，而是把结果写成一段自包含的提示 ——
        // 重放消息链的方式实测也不稳（模型面对 tool-call 历史仍可能继续吐工具调用）。
        conclusionInfo.tried = true
        sse(res, { type: 'notice', code: 'conclusion-retry', text: '查询已完成，正在整理结论…' })
        const conclusionUser = [
          userText,
          '',
          '【已经查到的资料】',
          ...toolDigestLines.slice(0, 12),
          '',
          '请**直接输出**给用户的最终答案：结论先行、必要处带来源链接。',
          '不要再请求工具，不要输出任何工具调用格式，也不要写"我先看看""让我核对一下"这类过程。',
        ].join('\n')
        // 先按当前档位试一次；空则用「关」档再试（有的模型在这一档更"直接给答案"）
        for (const attemptEffort of [roundEffort, 'off']) {
          if (answer.trim().length > 0) break
          conclusionInfo.rounds += 1
          try {
            const resume = ctx.llm.stream({
              provider: route.provider,
              model: route.model,
              ...(sessionId ? { sessionId: sessionId as never } : {}),
              system: undefined,
              messages: [
                createSystemMessage(systemPrompt, name),
                createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: conclusionUser }] }),
              ],
              ...(config.temperature >= 0 ? { temperature: config.temperature } : {}),
              ...(config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}),
              ...(attemptEffort ? { reasoningEffort: ReasoningEffortId(attemptEffort) } : {}),
              signal: controller.signal,
            })
            const thinkAgain = createThinkFilter()
            const residueAgain = createResidueFilter()
            for await (const chunk of resume) {
              if (chunk.type === 'text-delta') {
                const part = thinkAgain.push(chunk.text)
                if (part.think) sse(res, { type: 'thought', text: part.think })
                const text = part.text ? residueAgain.push(part.text) : ''
                if (text) {
                  chars += text.length
                  answer += text
                  conclusionInfo.chars += text.length
                  sse(res, { type: 'delta', text: text })
                }
              } else if (chunk.type === 'usage') {
                usage = chunk.usage
              } else if (chunk.type === 'finish') {
                if (chunk.reason.kind === 'error') {
                  conclusionInfo.error = chunk.reason.failure?.message ?? '模型调用失败'
                }
              }
            }
            for (const tail of [thinkAgain.flush()]) if (tail.think) sse(res, { type: 'thought', text: tail.think })
            const tailText = residueAgain.flush()
            if (tailText) {
              chars += tailText.length
              answer += tailText
              conclusionInfo.chars += tailText.length
              sse(res, { type: 'delta', text: tailText })
            }
            residueDropped += residueAgain.dropped()
            // 结论轮也可能把"英文核对过程"写进正文：一律按泄漏裁一次
            const leaked = splitLeakedReasoning(answer)
            if (leaked.prefix) {
              answer = leaked.rest
              chars = answer.length
              sse(res, { type: 'strip', text: leaked.prefix })
              sse(res, { type: 'notice', code: 'reasoning-leak', text: '已去掉模型写进正文的核对过程' })
            }
          } catch (error) {
            conclusionInfo.error = String((error as Error)?.message ?? error)
            ctx.logger?.warn?.(`[${name}] 结论轮失败：${conclusionInfo.error}`)
          }
        }
      }
      if (!errored && answer.trim().length === 0) {
        // 兜底：连结论轮都没吐字时，至少给一句话（否则面板空白，看起来像"没返回结果"）
        const note =
          toolCalls > 0
            ? '（工具查询完成了，但模型没有产出正文。可以再追问一句"直接说结论"，我按已查到的结果回答。）'
            : '（模型这次没有返回内容，可以点「重新生成」再试一次。）'
        answer = note
        chars += note.length
        sse(res, { type: 'delta', text: note })
      }
      if (!errored) {
        sse(res, {
          type: 'done',
          chars,
          usage,
          toolCalls,
          // 诊断用：结论轮/续写各试了几次、拿到多少字、失败原因
          ...(conclusionInfo.tried ? { conclusion: conclusionInfo } : {}),
          ...(roundDiag.length > 0 ? { rounds: roundDiag } : {}),
          clientClosedEarly,
        })
        if (useResultCache && answer.length > 0) {
          resultCache.set(cacheKey, { at: Date.now(), text: answer })
          if (resultCache.size > 200) {
            const oldest = resultCache.keys().next().value
            if (oldest !== undefined) resultCache.delete(oldest)
          }
        }
      }
    } catch (error) {
      const err = error as Error
      const aborted = err?.name === 'AbortError'
      sse(res, {
        type: 'error',
        message: aborted ? `调用超时或已取消（${config.timeoutMs}ms）` : String(err?.message ?? err),
      })
    } finally {
      finished = true
      clearTimeout(timer)
      res.end()
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/analyze`, handler: handleAnalyze }),
    `${name}: analyze route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/ping`, handler: handlePing }),
    `${name}: ping route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/history`, handler: handleHistory }),
    `${name}: history route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/models`, handler: handleModels }),
    `${name}: models route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/promote`, handler: handlePromote }),
    `${name}: promote route`,
  )

  ctx.logger?.info?.(`[${name}] 划词解读路由就绪：${API_PREFIX}/analyze`)
}

/** 类型引用（供声明文件 re-export，避免仅用于类型增强的 import 被判为未使用）。 */
export type { WebServer }

/**
 * 纯函数内部件，仅供单测直接调用（Cordis 只用 default export，多这几个具名导出没有副作用）。
 * 这三个都是"流式文本手术刀"，靠真实请求验证会被模型的随机发挥带偏，必须能确定性单测。
 */
export const __internals = {
  createThinkFilter,
  createResidueFilter,
  splitLeakedReasoning,
  looksLikeLeakedReasoning,
  resolveToolNames,
}
