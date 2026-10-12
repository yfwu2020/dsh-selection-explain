

/**
 * 设置页那四个格子（**规范档位**）。
 *
 * 它们不是发给模型的 id，而是一份"意图词汇"：关（尽量不思考）/ 低 / 高 / 最高。
 * 各 adapter 的档位词汇表并不统一 —— 本机 74 个模型上就数出七种：
 *   off>low>high>max ／ low>high>max ／ high>max ／ off>minimal>low>medium>high ／
 *   off>low>medium>high>xhigh>max ／ low>medium>high>xhigh ／ minimal>low>medium>high>xhigh ／
 *   max（只有一档）／ 一档都不声明（不支持推理）。
 * 落到哪个真实档位由 `mapEffortToModel` 算（纯函数，有单测）。
 */
const EFFORT_CANONICAL = ['off', 'low', 'high', 'max']

/**
 * 档位名 → "思考深度"刻度（认 id，也认显示名；比较前会去掉空格/下划线/连字符并转小写）。
 *
 * 刻度只用来**比较深浅**，绝对数值没有意义。锚点取最常见的五档：off 0 / low 2 /
 * medium 4 / high 6 / max 8，其余名字插在它们之间（minimal 在 off 与 low 之间、
 * xhigh 在 high 与 max 之间）。认不出的名字不在这张表里 —— 由 `rankEfforts` 按位置插值。
 */
const EFFORT_RANK: Record<string, number> = {
  off: 0, none: 0, disabled: 0, no: 0, nocontext: 0,
  minimal: 1, minimum: 1, least: 1, tiny: 1,
  low: 2, light: 2,
  mid: 3, moderate: 3,
  medium: 4,
  high: 6,
  xhigh: 7, veryhigh: 7,
  max: 8, maximum: 8, highest: 8,
  ultra: 9, extreme: 9,
}

/** 归一化档位名：'X-High' / 'very high' / 'x_high' 都算一个东西。 */
function normEffortName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

/**
 * 每个声明档位的刻度：认得的名字用表，不认识的按**位置**在已知邻居之间线性插值
 * （两头都没有已知锚点时按序号平铺到 0..8）。最后钳成不递减 —— 各 adapter 的声明都是升序，
 * 插值不该把这个顺序弄反。
 */
function rankEfforts(declared: Array<{ id: string; name?: string }>): number[] {
  const known = declared.map((item) => {
    const byId = EFFORT_RANK[normEffortName(item.id)]
    if (byId !== undefined) return byId
    const byName = EFFORT_RANK[normEffortName(item.name)]
    return byName === undefined ? null : byName
  })
  const n = declared.length
  const ranks: number[] = []
  for (let i = 0; i < n; i += 1) {
    const hit = known[i]
    if (hit !== null && hit !== undefined) {
      ranks.push(hit)
      continue
    }
    let left = -1
    for (let l = i - 1; l >= 0; l -= 1) {
      if (known[l] !== null && known[l] !== undefined) {
        left = l
        break
      }
    }
    let right = -1
    for (let r = i + 1; r < n; r += 1) {
      if (known[r] !== null && known[r] !== undefined) {
        right = r
        break
      }
    }
    const leftRank = left >= 0 ? (known[left] as number) : null
    const rightRank = right >= 0 ? (known[right] as number) : null
    if (leftRank !== null && rightRank !== null) {
      ranks.push(leftRank + ((rightRank - leftRank) * (i - left)) / (right - left))
    } else if (leftRank !== null) {
      ranks.push(leftRank + (i - left))
    } else if (rightRank !== null) {
      ranks.push(rightRank - (right - i))
    } else {
      ranks.push(n > 1 ? (8 * i) / (n - 1) : 0)
    }
  }
  for (let i = 1; i < n; i += 1) {
    if (ranks[i]! < ranks[i - 1]!) ranks[i] = ranks[i - 1]!
  }
  return ranks
}

/**
 * 规范四格 → 当前模型**真实声明**的档位（返回 '' 表示这个模型没有可发的档位）。
 *
 * 规则一条到底（对 `off>low>high>max` 这类 4 档模型恰好是恒等映射）：
 *   · 关   → 声明里**最弱**的那档（模型没有 off 这类档时，就是它"能关到"的最小思考）
 *   · 最高 → 声明里**最强**的那档
 *   · 低/高 → 在整条刻度上取 1/3、2/3 处**最近的档**；候选**排除两端**（最弱那档留给「关」、
 *     最强那档留给「最高」，四个格子于是各有落点），并保证 关 ≤ 低 ≤ 高 ≤ 最高 单调；
 *     同样近时「低」取更浅的、「高」取更深的 —— 低要省、高要深。
 *
 * ⚠️ 这里**没有**任何按模型写死的表：输入只有"这个模型自己声明的档位列表"。
 * 名字认得出来（off/low/high/max、minimal、xhigh…）就用名字的深度刻度；认不出来
 * （别的 adapter 可能叫 a/b/c、tier1/tier2，或者干脆是数字）就按**它在声明里的位置**插值 ——
 * 所以任何用户换任何模型都能落位，插件作者没见过那个模型也能映射。
 * 为什么不让「低/高」也去抢最弱那档：那两个格子表达的是"开着思考、但别太深"，
 * 落到"关"那一档等于**把用户要的思考关掉**；只有「关」该动那一档。
 * 只有一档可发时（如 kimi-k3 只有 max），四格都落到它 —— 模型没有别的选择。
 *
 * 返回 '' 表示"这个模型没有可发的档位"（声明为空），调用方据此**不带** reasoningEffort。
 */
export function mapEffortToModel(declared: Array<{ id: string; name?: string }>, canonical: string): string {
  const list = (declared ?? []).filter((item) => item && typeof item.id === 'string' && item.id.length > 0)
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]!.id
  const slot = EFFORT_CANONICAL.includes(canonical) ? canonical : 'off'
  const ranks = rankEfforts(list)
  // 两端：按刻度取最浅/最深；同样深时**以声明顺序为准**（声明在前的那档更弱、在后的更强）。
  // 不能只按下标取首尾：adapter 万一声明得不严格升序，按下标就选错了；也不能只按刻度取最大，
  // 那样 `…>max>ultra` 这种"更强但刻度相同"的档会被 max 抢走。
  let weakest = 0
  let strongest = 0
  for (let i = 1; i < list.length; i += 1) {
    if (ranks[i]! < ranks[weakest]!) weakest = i
    if (ranks[i]! >= ranks[strongest]!) strongest = i
  }
  if (slot === 'max') return list[strongest]!.id
  if (slot !== 'low' && slot !== 'high') return list[weakest]!.id
  const pool: number[] = []
  for (let i = 0; i < list.length; i += 1) {
    if (i !== weakest && i !== strongest) pool.push(i)
  }
  // 中间两档没人可选时（只有"最弱 + 最强"两档）：都落到最强 —— 最弱那档留给「关」
  if (pool.length === 0) return list[strongest]!.id
  const span = ranks[strongest]! - ranks[weakest]!
  const target = ranks[weakest]! + span * (slot === 'low' ? 1 / 3 : 2 / 3)
  const preferDeeper = slot === 'high'
  let best = pool[0]!
  let bestDistance = Math.abs(ranks[best]! - target)
  for (const index of pool) {
    const distance = Math.abs(ranks[index]! - target)
    const closer = distance < bestDistance
    const tie = distance === bestDistance
    if (closer || (tie && (preferDeeper ? ranks[index]! > ranks[best]! : ranks[index]! < ranks[best]!))) {
      best = index
      bestDistance = distance
    }
  }
  return list[best]!.id
}

/**
 * 一个模型的四格映射（设置页给用户看的就是它；请求时也走这份算）。
 * 返回空串的格子表示"没有可发的档位"（模型不支持推理时四个格子都是空串）。
 */
export function effortMapOf(declared: Array<{ id: string; name?: string }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const slot of EFFORT_CANONICAL) out[slot] = mapEffortToModel(declared, slot)
  return out
}

/**
 * 清单里查不到这个模型时的兜底阶梯。
 * 只列**最常见**的四档（与客户端 `FALLBACK_TIERS` 同一份）：多出来的 `medium` 很多模型
 * 并不声明，而 dsh-llm 对"声明里没有的档"是**直接抛错**（不 clamp）—— 兜底时不该去撞它。
 */
const EFFORT_LADDER_FALLBACK = ['off', 'low', 'high', 'max']

/** 档位的中文名（notice 文案用，与客户端 TIER_LABEL 一致）。 */
export const EFFORT_LABEL: Record<string, string> = { off: '关', low: '低', medium: '中', high: '高', max: '最大' }

/**
 * 这条上游错误是不是"**我们发的这个档位**不被接受"。
 *
 * ⚠️ 判据必须窄。免费/预览端点的上游会**偶发**返回
 * `Reasoning is mandatory for this endpoint and cannot be disabled.` ——
 * 2026-10-09 实测（`opencode-go/step-5-preview-free`，交错发送排除时间漂移）：
 *   · effort=low 成功 5/8；effort=high 成功 5/8 —— **同一档位时好时坏，档位不是变量**；
 *   · 对照模型 `longcat-2.5-preview-free` 6/6 成功（连 off 都收）。
 * 所以只认"明确说这个档位无效"的措辞；"必须开推理"另有一条判据
 * （见 looksLikeReasoningRequired，只在**我们发的是关档**时才算数）。
 * 把偶发失败当成"档位不支持"会连锁出三个错：给用户一句错诊断、把失败永久记进
 * noOffRoutes（以后再也不发这个档）、清掉用户选的档位。
 */
export function looksLikeUnsupportedTier(message: string): boolean {
  const tier = '(?:reasoning|effort|thinking|推理|思考|档位?)'
  const bad = '(?:unsupported|not\\s+support|invalid|unrecognized|不支持|无效|不认识)'
  return (
    new RegExp(`${bad}[^。\\n]{0,24}${tier}`, 'i').test(message) ||
    new RegExp(`${tier}[^。\\n]{0,24}${bad}`, 'i').test(message)
  )
}

/** 上游要求"必须开推理"——只有在**我们这次把推理关掉**（发的 off）时，这句才是冲我们来的。 */
export function looksLikeReasoningRequired(message: string): boolean {
  return (
    /(?:reasoning|thinking|推理|思考)/i.test(message) &&
    /(?:mandatory|required|must|cannot\s+be\s+disabled|必须|不能(?:被)?关闭|不可关闭)/i.test(message)
  )
}

/**
 * 换一个"没试过的"档位（重试用）。
 *
 * 为什么**绝不能省略档位**（老代码就是省略）：省略 = 请求里不带 reasoning，
 * 对"必须开推理"的端点等于把推理关掉 —— 实测 20 次这样的重试 **0 次成功**，
 * 而同一档位首发成功率约 60%。省略比"发一个可能不被接受的档"更糟。
 *
 * 顺序：模型自己声明的 defaultEffort → 沿档位阶梯往上走一格（离"关"越远越安全）。
 * 返回空串表示"没档位可换了"，调用方就不重试。
 */
export function pickNextEffort(
  declared: string[],
  defaultEffort: string | null | undefined,
  rejected: string,
  tried: Set<string>,
): string {
  const usable = (id: string | null | undefined): id is string => !!id && id !== rejected && !tried.has(id)
  if (usable(defaultEffort)) return defaultEffort
  // 用**模型自己的声明顺序**（各 adapter 都是从最省到最深），"往上走一格"才落在它真实的下一档上。
  // 老写法是"我方五档阶梯 ∩ 声明"，看不见 minimal / xhigh / none 这类 id —— 而按刻度映射之后，
  // 被拒的那个很可能正是这类 id（indexOf 得到 -1 → 退回最弱的那档，方向正好反了）。
  const order = declared.length > 0 ? declared : EFFORT_LADDER_FALLBACK
  const start = order.indexOf(rejected)
  // ① 先往上走：离「关」越远越安全（不吃 off 的模型通常都吃更高的档）
  for (let i = (start < 0 ? 0 : start + 1); i < order.length; i += 1) {
    const id = order[i]
    if (usable(id)) return id
  }
  // ② 再按"通常最稳"的顺序退（模型拒的是 max 时往上没得走，该退到 high，而不是退回 off ——
  //    off 恰恰是最容易被拒的那一档）
  for (const id of ['high', 'medium', 'low', 'max', 'off']) {
    if (order.includes(id) && usable(id)) return id
  }
  // ③ 兜底：声明里剩下的
  for (const id of order) if (usable(id)) return id
  return ''
}
