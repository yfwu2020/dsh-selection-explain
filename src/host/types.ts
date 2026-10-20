

/** 一次请求的入参。 */
export interface AnalyzeBody {
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
  /** 小窗历史：这段对话**没有解读**（"跳过翻译与详解、直接追问"那条路）；回放时据此不画「翻译」一节。 */
  skipped?: unknown
  /** 单次请求的推理档位覆盖（off / low / high / max）；不传用插件配置。 */
  effort?: unknown
  /** 小窗的「模型」控件：显式指定 provider + model（按清单校验，缺省跟随会话默认）。 */
  provider?: unknown
  model?: unknown
  /** 网页模式（小窗里的开关）：复杂问题默认用网页回答，并注入设计规范。 */
  webAnswer?: unknown
  /** 客户端上报的当前深浅（'dark' | 'light'）：网页输出按它选配色。 */
  theme?: unknown
  /** 追问模式下用户这一轮的问题。 */
  question?: unknown
  /** 追问模式下的历史轮次：[{ role: 'user' | 'assistant', text }]。 */
  history?: unknown
  historyStart?: unknown
  contextState?: unknown
  materials?: unknown
  initialExplanation?: unknown
  /**
   * 这一轮追问带的附件：[{ kind: 'image' | 'file', ref }]，ref 是 /api/attach 存好之后的持久引用。
   * 图片 → ImageBlock（模型直接看）；文件 → FileBlock（dsh-llm 投影成"名字 + 字节数 + 只读路径"一行）。
   */
  attachments?: unknown
  /** 升格为正式会话时的入参。 */
  translation?: unknown
  detail?: unknown
  turns?: unknown
  /** 诊断开关：为 true 时把实际发给模型的提示词回传在 SSE 的 start 事件里（客户端不传）。 */
  debug?: unknown
}

/** 会话背景读取结果。 */
export interface SessionBackground {
  /** 已格式化的对话记录（时间顺序，最后一条最新）。 */
  transcript: string
  /** 是否在记录里标出了选中文字所在的消息。 */
  marked: boolean
}

/** 会话背景读取入参。 */
export interface BackgroundOptions {
  maxMessages: number
  maxChars: number
  /** 用于在记录里定位选中位置（归一化后做包含匹配）。 */
  marker: string
}

/**
 * ctx.sessionQuery 的宽松视图。
 *
 *   · readSurface —— 会话的**消息表面**（对话背景用）。
 *   · readSession —— **原始事件**（带 data）。读会话模型必须走它：
 *     `model/selection` 在文档里写明是 log-only，"never enters derived model history"，
 *     所以它**不会**出现在 readSurface 的 surface 里（实测：用它读到的永远是空）。
 */
export interface SessionQueryLike {
  readSurface?: (sessionId: string) => Promise<{ events?: readonly unknown[] }>
  readSession?: (sessionId: string) => Promise<{ events?: readonly unknown[] }>
}

/**
 * ctx.sessions 的宽松视图 —— 只用来做"会话有没有新事件"的零成本探测。
 *
 * `seq` 是 Session 上的 getter（= 日志长度，每次 append 都会涨），同步读、不碰日志；
 * 拿它跟上次解析时记下的值一比，就知道"结论有没有可能变"（见 liveSeqOf）。
 */
export interface SessionsLike {
  get?: (sessionId: string) => { seq?: number } | undefined
}

/** 解析出的模型路由。 */
export interface Route {
  provider: string
  model: string
}

/** 会话自己记的模型选择（与 Route 同形，单独取名是为了在注释里说清"来源不同"）。 */
export type SessionModel = Route
