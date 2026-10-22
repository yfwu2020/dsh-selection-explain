/** Shared defaults and boundaries; no host or browser dependencies. */
/** 插件配置。 */
export interface Config {
  /** 固定 provider 路由；留空 = 跟随主会话（用户在 DSH 里选的默认模型）。 */
  provider: string
  /** 固定 model id；留空 = 跟随主会话。 */
  model: string
  /**
   * **追问**单独用的 provider；留空 = 跟首轮/次轮同一个（默认如此）。
   *
   * 为什么要能单独设：首轮/次轮要的是"读懂上下文"，追问往往是"快速问一句"，
   * 两者对模型的要求不同（一个要准、一个要快）。
   */
  chatProvider: string
  /** **追问**单独用的 model id；留空 = 跟首轮/次轮同一个。 */
  chatModel: string
  /** **次轮详解**的推理档位（off / low / high / max）；留空 = 适配器默认。 */
  reasoningEffort: string
  /** **首轮**（翻译 / 解读 / 注释）的推理档位。 */
  translationReasoningEffort: string
  /** 小窗模型输入预算（估算 tokens），另受模型容量约束。 */
  chatContextTokens: number
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
  /**
   * 引用（❝）上下文：引用文字所在的那一组对话 ± 几组（一组 = 用户消息 + 它的助手回复）。
   * 默认 1 = 上下各一组（需求：至少带上引用所在那一组与上下各一组）。
   */
  quoteContextRounds: number
  /** 引用上下文里单条消息的字数上限（超了**围绕引用**截断，不裁掉引用本身）。 */
  quoteContextMaxCharsPerTurn: number
  /** 引用上下文整段的字数上限（超了丢最早的几组）。 */
  quoteContextMaxChars: number
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
  /** 追问（对话小窗）用的推理档位：通常比次轮详解轻，响应更快。 */
  chatReasoningEffort: string
  /**
   * 侧边栏 HTML 预览里的划词桥（默认开）。
   *
   * 侧边栏的预览是不透明源沙箱 iframe，父页面读不到里面的选区 —— 只有往被预览的
   * 文档里注入一段桥脚本才能划词。代价：预览帧要多一个 `allow-scripts`
   * （仍然**没有** `allow-same-origin`，预览页读不到 GUI 数据），基础预览那份
   * 已清洗过的 HTML 的 CSP 会从 `script-src 'none'` 放宽到 `'unsafe-inline'`。
   * 关掉 = 侧边栏网页里不弹「解读」按钮。
   */
  bridgeSidebarPreview: boolean
  /** 是否显示右下角悬浮胶囊（最近一次划词的状态入口）。 */
  pillEnabled: boolean
  /**
   * 静置多久把胶囊收成小球（毫秒）。
   *
   * 只在**没装费用胶囊**时生效 —— 有费用胶囊时两者并排，收球会让它们错位。
   * 默认 10 秒：短于这个数会显得"刚看一眼就没了"，长了又失去"收起来不挡视线"的意义。
   */
  pillIdleMs: number
  /**
   * 开麦结束、**一个字都没说**时，直接收起临时输入框。
   *
   * 默认开（2026-10-09 用户指定）：等于替用户按了 Esc（带关机动画）。
   * 关掉则回到"卡片留着" —— 一个字没说时可以接着手动打字。
   *
   * 注意"结束"不是"松手那一瞬间"：输入法在松手后还会做一次**智能整理**（改写输入框内容），
   * 所以真正动作要等到文字定稿（见客户端的 VOICE_SETTLE_MS）。否则会取消掉马上就要落进来的整理结果。
   */
  voiceCancelOnSilence: boolean
  /**
   * 开麦结束、**已经说出文字**时，直接发送（跳过手动点发送键）。
   *
   * 默认开（2026-10-09 用户指定）：等于替用户点了发送键。
   * 关掉则回到"先看一眼再点" —— 发送会开小窗、开始一次真实请求，不可逆。
   *
   * 同样要等文字定稿：松手那一刻输入法还没整理完，立刻发送发出去的是没整理的草稿。
   */
  voiceAutoSend: boolean
  /**
   * 截图取景范围：小窗**未打开**（截图后弹语音卡问问题）时用哪一档。
   *
   * `screen` 全屏（选区中心所在的那块屏）｜`window` 整窗｜`margin` 选区 + 留白｜`selection` 仅选区。
   * 默认 `window`：问"这是什么/它在哪"时需要窗口上下文。
   */
  shotCardScope: string
  /**
   * 截图取景范围：小窗**已打开**（截图直接进输入框附件）时用哪一档。
   *
   * 默认 `selection`：用户已经框得很准，贴进去的就是那块。
   */
  shotPanelScope: string
  /**
   * 「选区 + 留白」向四周外扩的逻辑像素（pt）。
   *
   * 两套模式共用一个值。Retina 下 48pt = 96 物理像素；按 pt 而不是物理像素，
   * 换一块屏观感才一致。外扩会裁到选区中心所在的那块显示器边界内。
   */
  shotMargin: number
}

export const CONFIG_DEFAULTS: Readonly<Config> = Object.freeze({
    provider: '',
    model: '',
    chatProvider: '',
    chatModel: '',
    reasoningEffort: 'high',
    translationReasoningEffort: 'off',
    chatContextTokens: 32768,
    historyMaxEntries: 20,
    temperature: -1,
    maxTokens: 0,
    timeoutMs: 300000,
    maxSelectionChars: 4000,
    maxContextChars: 12000,
    maxRequestsPerMinute: 40,
    sessionContext: true,
    sessionContextMaxMessages: 24,
    sessionContextFastMessages: 8,
    sessionContextMaxChars: 0,
    quoteContextRounds: 1,
    quoteContextMaxCharsPerTurn: 2000,
    quoteContextMaxChars: 6000,
    resultCacheTtlMs: 600000,
    tools: true,
    toolNames: 'advanced_search,platform_search,read,grep,glob',
    fallbackToolNames: 'web_search',
    maxToolRounds: 2,
    toolResultMaxChars: 3000,
    toolReadRoot: '',
    chatReasoningEffort: 'high',
    bridgeSidebarPreview: true,
    pillEnabled: true,
    pillIdleMs: 10000,
    voiceCancelOnSilence: true,
    voiceAutoSend: true,
    shotCardScope: 'window',
    shotPanelScope: 'selection',
    shotMargin: 48,
  })

export const CONFIG_LIMITS = {
  chatContextTokens: { min: 4096, max: 262144 },
  historyMaxEntries: { min: 0, max: 500 },
  temperature: { min: -1, max: 2 },
  maxTokens: { min: 0, max: 32000 },
  timeoutMs: { min: 5000, max: 600000 },
  maxSelectionChars: { min: 20, max: 20000 },
  maxContextChars: { min: 200, max: 60000 },
  maxRequestsPerMinute: { min: 1, max: 600 },
  sessionContextMaxMessages: { min: 1, max: 200 },
  sessionContextFastMessages: { min: 1, max: 200 },
  sessionContextMaxChars: { min: 0, max: 2000000 },
  quoteContextRounds: { min: 0, max: 10 },
  quoteContextMaxCharsPerTurn: { min: 200, max: 20000 },
  quoteContextMaxChars: { min: 400, max: 100000 },
  resultCacheTtlMs: { min: 0, max: 86400000 },
  maxToolRounds: { min: 0, max: 8 },
  toolResultMaxChars: { min: 200, max: 20000 },
  pillIdleMs: { min: 2000, max: 600000 },
  shotMargin: { min: 0, max: 400 },
} as const
