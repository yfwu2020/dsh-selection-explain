import z from '@deepseek-ai/schemastery'
import { CONFIG_DEFAULTS, CONFIG_LIMITS } from '../config-values.js'
import type { Config as PluginConfig } from '../config-values.js'
export type Config = PluginConfig

/** 配置 schema（缺省值即推荐值）。 */
export const Config = z.object({
  provider: z.string().default(CONFIG_DEFAULTS.provider),
  model: z.string().default(CONFIG_DEFAULTS.model),
  chatProvider: z.string().default(CONFIG_DEFAULTS.chatProvider),
  chatModel: z.string().default(CONFIG_DEFAULTS.chatModel),
  reasoningEffort: z.string().default(CONFIG_DEFAULTS.reasoningEffort),
  /** 首轮单独一档：默认关闭思考，优先快速给出翻译、解读或注释。 */
  translationReasoningEffort: z.string().default(CONFIG_DEFAULTS.translationReasoningEffort),
  /**
   * 小窗对话历史（A′）：把整段对话落到插件自己的目录，重划同一个词直接回放。
   * 0 = 关闭历史。只留最近 N 个「划词条目」（每个条目内含它自己的全部追问轮次）。
   */
  historyMaxEntries: z.number().min(CONFIG_LIMITS.historyMaxEntries.min).max(CONFIG_LIMITS.historyMaxEntries.max).default(CONFIG_DEFAULTS.historyMaxEntries),
  /** 采样温度。**默认 -1 = 不传**（交给供应商默认，与主会话一致）。0~2 之间才真的传。 */
  temperature: z.number().min(CONFIG_LIMITS.temperature.min).max(CONFIG_LIMITS.temperature.max).default(CONFIG_DEFAULTS.temperature),
  /**
   * 单次调用的输出上限（tokens）。**默认 0 = 不限制** —— 不传这个参数，交给模型/供应商自己的上限。
   *
   * 为什么不默认给个数：这是**每次调用**的上限，联网检索后的答案经常要 2~4k tokens，
   * 之前默认 1200 会让回答"悄悄截断在句子中间"（实测）；而给死一个更大的数也一样会在别的场景截断。
   * 想限制（控成本/控时延）就填正数，仍然生效。
   */
  maxTokens: z.number().min(CONFIG_LIMITS.maxTokens.min).max(CONFIG_LIMITS.maxTokens.max).default(CONFIG_DEFAULTS.maxTokens),
  timeoutMs: z.number().min(CONFIG_LIMITS.timeoutMs.min).max(CONFIG_LIMITS.timeoutMs.max).default(CONFIG_DEFAULTS.timeoutMs),
  maxSelectionChars: z.number().min(CONFIG_LIMITS.maxSelectionChars.min).max(CONFIG_LIMITS.maxSelectionChars.max).default(CONFIG_DEFAULTS.maxSelectionChars),
  maxContextChars: z.number().min(CONFIG_LIMITS.maxContextChars.min).max(CONFIG_LIMITS.maxContextChars.max).default(CONFIG_DEFAULTS.maxContextChars),
  maxRequestsPerMinute: z.number().min(CONFIG_LIMITS.maxRequestsPerMinute.min).max(CONFIG_LIMITS.maxRequestsPerMinute.max).default(CONFIG_DEFAULTS.maxRequestsPerMinute),
  sessionContext: z.boolean().default(CONFIG_DEFAULTS.sessionContext),
  sessionContextMaxMessages: z.number().min(CONFIG_LIMITS.sessionContextMaxMessages.min).max(CONFIG_LIMITS.sessionContextMaxMessages.max).default(CONFIG_DEFAULTS.sessionContextMaxMessages),
  sessionContextFastMessages: z.number().min(CONFIG_LIMITS.sessionContextFastMessages.min).max(CONFIG_LIMITS.sessionContextFastMessages.max).default(CONFIG_DEFAULTS.sessionContextFastMessages),
  sessionContextMaxChars: z.number().min(CONFIG_LIMITS.sessionContextMaxChars.min).max(CONFIG_LIMITS.sessionContextMaxChars.max).default(CONFIG_DEFAULTS.sessionContextMaxChars),
  quoteContextRounds: z.number().min(CONFIG_LIMITS.quoteContextRounds.min).max(CONFIG_LIMITS.quoteContextRounds.max).default(CONFIG_DEFAULTS.quoteContextRounds),
  quoteContextMaxCharsPerTurn: z.number().min(CONFIG_LIMITS.quoteContextMaxCharsPerTurn.min).max(CONFIG_LIMITS.quoteContextMaxCharsPerTurn.max).default(CONFIG_DEFAULTS.quoteContextMaxCharsPerTurn),
  quoteContextMaxChars: z.number().min(CONFIG_LIMITS.quoteContextMaxChars.min).max(CONFIG_LIMITS.quoteContextMaxChars.max).default(CONFIG_DEFAULTS.quoteContextMaxChars),
  resultCacheTtlMs: z.number().min(CONFIG_LIMITS.resultCacheTtlMs.min).max(CONFIG_LIMITS.resultCacheTtlMs.max).default(CONFIG_DEFAULTS.resultCacheTtlMs),
  tools: z.boolean().default(CONFIG_DEFAULTS.tools),
  /**
   * 工具白名单（逗号分隔）。
   *
   * 默认改用 **free-search 插件**的工具（`advanced_search` / `platform_search`），不再用 `web_search`：
   * 会话里的 `web_search` 是官方 DeepSeek 搜索（复用 @deepseek-ai/dsh-tool-web 的 schema），
   * 而新装的 dsh-free-search 只注册了 advanced_search / platform_search / free_search_test ——
   * 引擎更多（ddg/bing/searxng/anysearch/exa/tavily/keenable/firecrawl/parallel…）、失败自动换引擎、
   * 还支持时间过滤与平台搜索。
   */
  toolNames: z.string().default(CONFIG_DEFAULTS.toolNames),
  /**
   * **备用**工具清单：只在"首选里的联网工具一个都不在"时才补进来。
   *
   * 场景：没装 free-search 插件（或它没注册工具）时，会话里通常仍有官方 `web_search`；
   * 不补的话小窗会变成完全不能联网。装了 free-search 就完全用不到这一项。
   */
  fallbackToolNames: z.string().default(CONFIG_DEFAULTS.fallbackToolNames),
  maxToolRounds: z.number().min(CONFIG_LIMITS.maxToolRounds.min).max(CONFIG_LIMITS.maxToolRounds.max).default(CONFIG_DEFAULTS.maxToolRounds),
  toolResultMaxChars: z.number().min(CONFIG_LIMITS.toolResultMaxChars.min).max(CONFIG_LIMITS.toolResultMaxChars.max).default(CONFIG_DEFAULTS.toolResultMaxChars),
  toolReadRoot: z.string().default(CONFIG_DEFAULTS.toolReadRoot),
  chatReasoningEffort: z.string().default(CONFIG_DEFAULTS.chatReasoningEffort),
  /**
   * 侧边栏 HTML 预览里的划词桥。关掉就不往预览帧里注入桥脚本，
   * 侧边栏网页里选中文字不会再弹「解读」。
   */
  bridgeSidebarPreview: z.boolean().default(CONFIG_DEFAULTS.bridgeSidebarPreview),
  /** 悬浮胶囊开关（小窗设置页可改）。 */
  pillEnabled: z.boolean().default(CONFIG_DEFAULTS.pillEnabled),
  /** 静置收球时长（毫秒）——默认 10 秒，见 Config 注释。 */
  pillIdleMs: z.number().min(CONFIG_LIMITS.pillIdleMs.min).max(CONFIG_LIMITS.pillIdleMs.max).default(CONFIG_DEFAULTS.pillIdleMs),
  /** 空录音是否收起卡片（默认开，见 Config 注释）。 */
  voiceCancelOnSilence: z.boolean().default(CONFIG_DEFAULTS.voiceCancelOnSilence),
  /** 有字是否自动发送（默认开，见 Config 注释）。 */
  voiceAutoSend: z.boolean().default(CONFIG_DEFAULTS.voiceAutoSend),
})

/** Preserve nullish-default semantics without duplicating the defaults. */
export function resolveConfig(rawConfig: Partial<Config> = {}): Config {
  return Object.fromEntries(Object.entries(CONFIG_DEFAULTS).map(([key, fallback]) => [
    key, rawConfig?.[key as keyof Config] ?? fallback,
  ])) as unknown as Config
}
