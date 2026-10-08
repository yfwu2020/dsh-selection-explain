/**
 * 划词解读 · 设置面板的**单一事实来源**。
 *
 * 为什么单独成模块：
 *   · 小窗设置页要渲染 20+ 个字段，字段的标题 / 说明 / 单位 / 边界**必须**与 host 的
 *     校验规则是同一份数据 —— 分两处写迟早会漂（UI 说 1~600，host 却按 1~200 截断）。
 *     所以 GET /settings 直接把这份 spec 发给客户端，客户端只负责画，不做业务判断。
 *   · 纯数据 + 纯函数，不 import cordis / node，单测可以直接跑（见 scripts/test-settings.mjs）。
 *
 * 分组是**导航结构**，不是装饰：20+ 项平铺会淹没用户，按"用户想去哪类事"分 6 组。
 */

/** 字段控件类型。 */
export type SettingKind = 'switch' | 'number' | 'text' | 'seg' | 'model'

/** 一个设置项的声明。 */
export interface SettingSpec {
  /** 对应 Config 的字段名（也是 POST body 里的键）。 */
  key: string
  kind: SettingKind
  /** 行标题。 */
  label: string
  /** 一行说明：说清"改了会怎样"，包括代价。 */
  hint: string
  /** 关闭此开关时禁用当前字段，但保留其配置值。 */
  enabledBy?: string
  /** number 的单位（显示在输入框右侧）。 */
  unit?: string
  /** number 的边界（与 host 侧 clamp 用同一组值）。 */
  min?: number
  max?: number
  /** number 的步进。 */
  step?: number
  /** seg 的候选项。 */
  options?: string[]
  /** 留空时的语义说明（text 用，放进 placeholder）。 */
  placeholder?: string
  /**
   * **复合字段**：一个控件写多个 Config 字段（当前只有模型选择 —— 一个下拉同时定 provider 与 model）。
   * 有它就说明 `key` 是个**虚拟键**、本身不写进配置，真正写的是这里列出的字段。
   */
  keys?: string[]
  /**
   * 显示单位与配置单位的**倍率**：显示值 = 配置值 / scale。
   *
   * 配置里时间一律是毫秒（schema 与 yml 的历史值都是毫秒，不动它），
   * 但界面上"秒"更好读（用户提的要求）。所以 min/max 仍然按**配置单位**声明，
   * 由客户端换算出显示用的边界 —— 边界的唯一事实来源始终是 Config schema。
   */
  scale?: number
}

/** 一个分组。 */
export interface SettingGroup {
  id: string
  /** 左栏分类名。 */
  label: string
  items: SettingSpec[]
  sections: Array<{ label: string; keys: string[]; hint?: string; note?: string }>
}

/**
 * 分组顺序 = 左栏从上到下的顺序。
 * 「模型」放第一：27 项里唯一大多数人有理由改的一类。
 */
export const SETTINGS_GROUPS: SettingGroup[] = [
  {
    id: 'model', label: '模型',
    sections: [
      {"label": "模型", "keys": ["modelChoice"]},
      {"label": "思考强度", "keys": ["translationReasoningEffort", "reasoningEffort", "chatReasoningEffort"], "note": "关闭思考仍会生成回答。"},
    ],
    items: [
      {"key": "modelChoice", "kind": "model", "label": "模型", "hint": "", "keys": ["provider", "model"]},
      {"key": "translationReasoningEffort", "kind": "seg", "label": "首轮", "hint": "翻译 / 解读 / 注释", "options": ["off", "low", "high", "max"]},
      {"key": "reasoningEffort", "kind": "seg", "label": "次轮", "hint": "点击「展开详解」", "options": ["off", "low", "high", "max"]},
      {"key": "chatReasoningEffort", "kind": "seg", "label": "追问", "hint": "在小窗中继续提问", "options": ["off", "low", "high", "max"]},
    ],
  },
  {
    id: 'read', label: '解读',
    sections: [
      {"label": "文本范围", "keys": ["maxSelectionChars", "maxContextChars"]},
      {"label": "频率与时限", "keys": ["maxRequestsPerMinute", "timeoutMs"]},
    ],
    items: [
      {"key": "maxSelectionChars", "kind": "number", "label": "选中文字上限", "hint": "超出此长度时，不进行解读。", "unit": "字符", "min": 20, "max": 20000, "step": 1},
      {"key": "maxContextChars", "kind": "number", "label": "局部前后文上限", "hint": "不含会话背景，超出部分截断。", "unit": "字符", "min": 200, "max": 60000, "step": 1},
      {"key": "maxRequestsPerMinute", "kind": "number", "label": "每分钟请求上限", "hint": "所有阶段合计，超限需稍后重试。", "unit": "次", "min": 1, "max": 600, "step": 1},
      {"key": "timeoutMs", "kind": "number", "label": "生成时限", "hint": "含检索耗时，超时后停止生成。", "unit": "秒", "min": 5000, "max": 600000, "step": 1000, "scale": 1000},
    ],
  },
  {
    id: 'ctx', label: '背景',
    sections: [
      {"label": "解读", "keys": ["sessionContext", "sessionContextFastMessages", "sessionContextMaxMessages", "sessionContextMaxChars"]},
      {"label": "引用", "keys": ["quoteContextRounds", "quoteContextMaxCharsPerTurn", "quoteContextMaxChars"], "hint": "将引用所在轮及其上下文随提问一起发给模型。", "note": "一轮包含一次提问及其回答。"},
    ],
    items: [
      {"key": "sessionContext", "kind": "switch", "label": "附带会话消息", "hint": "将选中文字所在消息及之前的消息一并发给模型。"},
      {"key": "sessionContextFastMessages", "kind": "number", "label": "首轮上下文消息数", "hint": "每条提问或回答计一条。", "unit": "条", "min": 1, "max": 200, "step": 1, "enabledBy": "sessionContext"},
      {"key": "sessionContextMaxMessages", "kind": "number", "label": "次轮与追问上下文消息数", "hint": "", "unit": "条", "min": 1, "max": 200, "step": 1, "enabledBy": "sessionContext"},
      {"key": "sessionContextMaxChars", "kind": "number", "label": "上下文总字符上限", "hint": "0 为不限；超出时优先保留近期消息。", "unit": "字符", "min": 0, "max": 2000000, "step": 1000, "enabledBy": "sessionContext"},
      {"key": "quoteContextRounds", "kind": "number", "label": "上下文轮数", "hint": "引用前后各取指定轮数；0 仅取所在轮。", "unit": "轮", "min": 0, "max": 10, "step": 1},
      {"key": "quoteContextMaxCharsPerTurn", "kind": "number", "label": "单条消息字符上限", "hint": "长消息优先保留引用附近内容。", "unit": "字符", "min": 200, "max": 20000, "step": 100},
      {"key": "quoteContextMaxChars", "kind": "number", "label": "上下文总字符上限", "hint": "超出时减少上下文，保留引用所在消息。", "unit": "字符", "min": 400, "max": 100000, "step": 100},
    ],
  },
  {
    id: 'tools', label: '联网',
    sections: [
      {"label": "工具调用", "keys": ["tools", "maxToolRounds", "toolResultMaxChars"]},
      {"label": "工具范围", "keys": ["toolNames", "fallbackToolNames", "toolReadRoot"]},
    ],
    items: [
      {"key": "tools", "kind": "switch", "label": "允许调用工具", "hint": "模型可按需调用下方指定的工具。"},
      {"key": "maxToolRounds", "kind": "number", "label": "调用轮数", "hint": "0 为不调用工具；同一轮可调用多个工具。", "unit": "轮", "min": 0, "max": 8, "step": 1, "enabledBy": "tools"},
      {"key": "toolResultMaxChars", "kind": "number", "label": "单次结果字符上限", "hint": "工具返回的文本超出时截断。", "unit": "字符", "min": 200, "max": 20000, "step": 100, "enabledBy": "tools"},
      {"key": "toolNames", "kind": "text", "label": "允许的工具", "hint": "工具名以逗号分隔。", "placeholder": "advanced_search,platform_search,read,grep,glob", "enabledBy": "tools"},
      {"key": "fallbackToolNames", "kind": "text", "label": "备用搜索工具", "hint": "找不到允许列表中的搜索工具时补充。", "placeholder": "web_search", "enabledBy": "tools"},
      {"key": "toolReadRoot", "kind": "text", "label": "文件读取目录", "hint": "留空取会话工作目录；* 为不限。", "placeholder": "会话工作目录", "enabledBy": "tools"},
    ],
  },
  {
    id: 'ui', label: '界面',
    sections: [
      {"label": "划词入口", "keys": ["bridgeSidebarPreview"]},
      {"label": "悬浮入口", "keys": ["pillEnabled", "pillIdleMs"], "note": "费用胶囊显示时保持展开。"},
      {"label": "语音输入", "keys": ["voiceCancelOnSilence", "voiceAutoSend"], "note": "松手（麦克风关闭）那一刻生效。"},
    ],
    items: [
      {"key": "bridgeSidebarPreview", "kind": "switch", "label": "侧边栏网页划词", "hint": "选中文字后显示「解读」按钮。"},
      {"key": "pillEnabled", "kind": "switch", "label": "显示状态胶囊", "hint": "显示最近一次解读状态，点击打开或收起小窗。"},
      {"key": "pillIdleMs", "kind": "number", "label": "自动收起时间", "hint": "空闲达到此时长后缩成小球。", "unit": "秒", "min": 2000, "max": 600000, "step": 1000, "scale": 1000, "enabledBy": "pillEnabled"},
      {"key": "voiceCancelOnSilence", "kind": "switch", "label": "空录音时收起", "hint": "开麦结束、一个字都没说时收起卡片（等于替你按了 Esc）。会先等输入法的智能整理提交（实测约 0.1–0.6 秒）。默认关：卡片留着，可以接着手动打字。"},
      {"key": "voiceAutoSend", "kind": "switch", "label": "说完直接发送", "hint": "开麦结束、已经说出文字时自动发送（等于替你点了发送键）。会先等输入法的智能整理提交完再发（实测会补标点、去重复词，甚至改听错的词）。默认关：发送不可逆，先看一眼再点。"},
    ],
  },
  {
    id: 'data', label: '数据',
    sections: [
      {"label": "历史记录", "keys": ["historyMaxEntries"], "note": "0 为不保存，已有对话保留。超出时移除最久未更新的对话，已升格的保留。"},
    ],
    items: [
      {"key": "historyMaxEntries", "kind": "number", "label": "保留最近对话数量", "hint": "每条包含所选文字、模型回答及后续追问。", "unit": "条", "min": 0, "max": 500, "step": 1},
    ],
  },
]

/** spec 里的全部条目（含虚拟键）。 */
export const SETTINGS_ITEMS: SettingSpec[] = SETTINGS_GROUPS.flatMap((group) => group.items)

/** key → spec 的索引（渲染与校验按 key 找规则）。 */
export const SETTINGS_BY_KEY: Map<string, SettingSpec> = new Map(
  SETTINGS_ITEMS.map((item) => [item.key, item] as const),
)

/**
 * 真正会写进配置的字段全集。
 *
 * 与「spec 的 key 集合」**不是一回事**：模型下拉的 key 是虚拟的 `modelChoice`，
 * 它写的是 `provider` + `model` 两个真实字段（见 SettingSpec.keys）。
 * 校验、应用覆盖、组装当前值，全都用这一份。
 */
export const SETTINGS_KEYS: string[] = SETTINGS_ITEMS.flatMap((item) => item.keys ?? [item.key])

/** 只读的虚拟键（客户端可以渲染，但不能直接 POST 写它）。 */
export const SETTINGS_VIRTUAL_KEYS: string[] = SETTINGS_ITEMS
  .filter((item) => Array.isArray(item.keys))
  .map((item) => item.key)

/**
 * **配置键** → 声明它的 spec（复合字段按 keys 展开）。
 *
 * 校验走这一份而不是 SETTINGS_BY_KEY：POST 上来的是配置键（`provider` / `model`），
 * 而 spec 里那条的 key 是虚拟的 `modelChoice` —— 只有展开过才找得到规则。
 */
export const SETTINGS_WRITABLE_BY_KEY: Map<string, SettingSpec> = new Map(
  SETTINGS_ITEMS.flatMap((item) =>
    (item.keys ?? [item.key]).map((key) => [key, item] as const),
  ),
)

/** 校验结果：通过则 values 是**只含合法键**的补丁。 */
export interface NormalizeResult {
  ok: boolean
  /** 被接受的键值对（已按 spec 归一）。 */
  values: Record<string, unknown>
  /** 被拒绝的键及原因（给客户端提示用，不阻断其它键）。 */
  rejected: Array<{ key: string; reason: string }>
}

/**
 * 把一个客户端补丁归一成"可直接写进配置"的对象。
 *
 * 规则：
 *   · 不认识的 key 一律拒绝（不能靠 POST 往配置里塞任意字段）；
 *   · number 做 clamp（超界不报错，夹到边界 —— 用户拖滑块时不该看到红色报错）；
 *   · seg 只接受 options 里的值；
 *   · switch 只接受真正的布尔（字符串 'true' 之类的也别猜，直接拒）；
 *   · text 去掉首尾空白，长到离谱的直接拒（防止把配置文件写爆）。
 *
 * 有意**不抛异常**：一个键写错不该让整次保存失败。
 */
export function normalizeSettingsPatch(input: unknown): NormalizeResult {
  const values: Record<string, unknown> = {}
  const rejected: Array<{ key: string; reason: string }> = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, values, rejected: [{ key: '', reason: '请求体不是对象' }] }
  }
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const spec = SETTINGS_WRITABLE_BY_KEY.get(key)
    if (!spec) {
      // 虚拟键（如 modelChoice）不直接写配置：客户端要把它展开成 provider + model 再发上来。
      // 单独认一下是为了给一句能照着做的错误，而不是笼统的"未知设置项"。
      const virtual = SETTINGS_BY_KEY.get(key)
      rejected.push({
        key,
        reason: virtual && Array.isArray(virtual.keys)
          ? `该字段由 ${virtual.keys.join(' + ')} 组成，请分别提交`
          : '未知的设置项',
      })
      continue
    }
    // 复合字段的子键一律按文本校验：目前唯一的复合字段是模型选择，
    // provider 与 model 都是字符串（新增复合字段时在这里补类型判断）。
    if (Array.isArray(spec.keys)) {
      if (typeof raw !== 'string') {
        rejected.push({ key, reason: '需要字符串' })
        continue
      }
      if (raw.trim().length > 500) {
        rejected.push({ key, reason: '太长（上限 500 字符）' })
        continue
      }
      values[key] = raw.trim()
      continue
    }
    if (spec.kind === 'switch') {
      if (typeof raw !== 'boolean') {
        rejected.push({ key, reason: '需要布尔值' })
        continue
      }
      values[key] = raw
      continue
    }
    if (spec.kind === 'number') {
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(num)) {
        rejected.push({ key, reason: '需要数字' })
        continue
      }
      const min = spec.min ?? -Infinity
      const max = spec.max ?? Infinity
      values[key] = Math.min(max, Math.max(min, num))
      continue
    }
    if (spec.kind === 'seg') {
      if (typeof raw !== 'string' || !(spec.options ?? []).includes(raw)) {
        rejected.push({ key, reason: `可选：${(spec.options ?? []).join(' / ')}` })
        continue
      }
      values[key] = raw
      continue
    }
    // text
    if (typeof raw !== 'string') {
      rejected.push({ key, reason: '需要字符串' })
      continue
    }
    const text = raw.trim()
    if (text.length > 2000) {
      rejected.push({ key, reason: '太长（上限 2000 字符）' })
      continue
    }
    values[key] = text
  }
  return { ok: rejected.length === 0, values, rejected }
}

/** 设置页需要的完整载荷。 */
export interface SettingsPayload {
  groups: SettingGroup[]
  /** 当前生效值。 */
  values: Record<string, unknown>
  /** 出厂默认值（「恢复默认」和"是否改过"的判断都靠它）。 */
  defaults: Record<string, unknown>
}

/** 组装 GET /settings 的响应体。 */
export function buildSettingsPayload(
  values: Record<string, unknown>,
  defaults: Record<string, unknown>,
): SettingsPayload {
  return { groups: SETTINGS_GROUPS, values, defaults }
}

/** 旧设置文件的底层配置继续生效，但不再暴露为设置控件或接受 UI 写入。 */
export const PERSISTED_SETTING_KEYS = ['maxTokens', 'temperature', 'resultCacheTtlMs']
export function normalizeStoredSettings(input: unknown): Record<string, unknown> {
  const values = normalizeSettingsPatch(input).values
  if (!input || typeof input !== 'object' || Array.isArray(input)) return values
  const raw = input as Record<string, unknown>
  const bounds: Record<string, [number, number]> = { maxTokens: [0, 32000], temperature: [-1, 2], resultCacheTtlMs: [0, 86400000] }
  for (const key of PERSISTED_SETTING_KEYS) {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const [min, max] = bounds[key]!
    values[key] = Math.min(max, Math.max(min, value))
  }
  // chatProvider/chatModel 已退役，不迁入统一的 provider/model。
  return values
}
