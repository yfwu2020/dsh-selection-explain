import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { Route } from './types.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { name } from './constants.js'
import { pickNextEffort, effortMapOf } from './effort.js'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'

/** 解析本次调用使用的模型路由。 */
/**
 * 可选模型清单（带每个模型支持的推理等级）。
 *
 * 用 `llm.listProviders()`（同步）→ `llm.listModels(provider)`（异步，可能触发端点发现）→
 * `llm.resolveModel(provider, model)` 拿 `reasoning.efforts`。因为可能慢，这里做 60 秒缓存，
 * 并且**只在 /models 路由里调用**，不进 ping / analyze 的热路径。
 */
export type ModelChoice = {
  provider: string
  providerName: string
  model: string
  name: string
  efforts: Array<{ id: string; name: string }>
  defaultEffort: string | null
  /**
   * 这个模型到底支不支持"思考强度"：
   *   true  = 有推理档位（efforts 非空）
   *   false = 明确不支持（dsh-llm 的 resolveModelInfo 说它没有 reasoning）
   *   null  = 没读到（还没加载 / 这次调用失败）→ 原样发规范档位，被拒时由换档重试兜
   */
  hasReasoning: boolean | null
  /**
   * 规范四格 → 这个模型**真实**的档位 id（'' = 没有可发的档位）。
   * 由 `effortMapOf(model.efforts)` 实时算出，随清单一起下发 —— 设置页据此显示"这四格现在落到哪"。
   */
  effortMap: Record<string, string>
}

/** Owns models state for one plugin instance. */
export function createModels(ctx: Context, config: Config) {

  /** 兜底路由：第一次真实 LLM 调用后捕获。 */
  let captured: Route | null = null

  ctx.on('llm/stream', (options, next) => {
    captured = { provider: options.provider, model: options.model }
    return next()
  })

  let modelCache: { at: number; items: ModelChoice[] } = { at: 0, items: [] }

  /** 哪些 provider/model 在 "关" 档会把思考写进正文（实测过一次就记住，之后自动改用「低」）。 */
  const leakyOnOff = new Set<string>()

  /**
   * 哪些 provider/model **根本不接受 "关" 档**（上游直接 400 invalid_request_error）。
   *
   * 和 leakyOnOff 分开记：那个是"能发但会泄漏"，这个是"发了就报错"。
   * 记下来之后不再发 off，直接改用 low —— 这是"最接近关"的可接受档位。
   * 不记的话每次划词都要先失败一轮再重试：用户看到一次报错闪动 + 多一个来回的时延。
   */
  const noOffRoutes = new Set<string>()

  const leakyFile = (): string => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'selection-explain', 'leaky-off.json')

  let leakyLoaded = false

  /** 载入"关档会泄漏思考"的模型清单（跨重启保留；文件坏了就当空）。 */
  async function loadLeaky(): Promise<void> {
    if (leakyLoaded) return
    leakyLoaded = true
    try {
      const raw = await readFile(leakyFile(), 'utf8')
      const parsed = JSON.parse(raw) as { routes?: unknown; noOff?: unknown }
      let dropped = 0
      const accept = (item: unknown, into: Set<string>): void => {
        if (typeof item !== 'string' || !item) return
        // 落盘文件是**跨重启的经验**，但也可能被测试夹具写脏（实测有 p1/m-strong）：
        // provider 不存在的条目直接丢掉，并顺手把文件写回干净版。
        if (!isRealProvider(item.split('/')[0] ?? '')) {
          dropped += 1
          return
        }
        into.add(item)
      }
      if (Array.isArray(parsed?.routes)) for (const item of parsed.routes) accept(item, leakyOnOff)
      if (Array.isArray(parsed?.noOff)) for (const item of parsed.noOff) accept(item, noOffRoutes)
      if (dropped > 0) saveLeaky()
    } catch {
      /* 没有这个文件是常态 */
    }
  }

  function saveLeaky(): void {
    const body = JSON.stringify({ version: 1, routes: Array.from(leakyOnOff), noOff: Array.from(noOffRoutes) }, null, 0)
    void writeFile(leakyFile(), body, 'utf8').catch((error: unknown) => {
      ctx.logger?.warn?.(`[${name}] 泄漏清单写盘失败：${String((error as Error)?.message ?? error)}`)
    })
  }

  /**
   * 这条 route 的 provider 是不是**这台机器上真有的**。
   *
   * 为什么落盘前要查一下：这两个集合会写进 `~/.dsh/selection-explain/leaky-off.json`，
   * 而请求体里的 provider 是可以伪造的（`resolveRoute` 在清单没加载出来时只做形状校验）。
   * 实测踩过：`test-client.mjs` 的夹具 provider `p1` 被写进了用户真实的落盘文件
   * （`p1/m-strong`、`p1/m-fast`）—— 之后再也没人清掉它。
   * 宁可不记（顶多多撞一次上游，反正有重试），也不要往用户的文件里写不存在的东西。
   */
  function isRealProvider(provider: string): boolean {
    if (!provider) return false
    try {
      const llm = ctx.get('llm') as { listProviders?: () => Array<{ id?: string }> } | undefined
      const list = llm?.listProviders?.() ?? []
      return list.some((item) => String(item?.id ?? '') === provider)
    } catch {
      return false
    }
  }

  /** 记住一个"关档会泄漏"的模型（内存 + 落盘）。 */
  function markLeaky(route: string): void {
    if (leakyOnOff.has(route)) return
    if (!isRealProvider(route.split('/')[0] ?? '')) return
    leakyOnOff.add(route)
    if (leakyLoaded) saveLeaky()
  }

  /** 记住一个"不接受关档"的模型（内存 + 落盘）：下次直接改用 low，不再先撞一次。 */
  function markNoOff(route: string): void {
    if (noOffRoutes.has(route)) return
    if (!isRealProvider(route.split('/')[0] ?? '')) return
    noOffRoutes.add(route)
    if (leakyLoaded) saveLeaky()
  }

  /** 档位阶梯与判据都在模块层（纯函数，可单测）：这里只把清单数据喂给它。 */
  function nextEffortFor(route: string, rejected: string, tried: Set<string>): string {
    const item = modelCache.items.find((entry) => `${entry.provider}/${entry.model}` === route)
    return pickNextEffort(
      (item?.efforts ?? []).map((effort) => effort.id),
      item?.defaultEffort,
      rejected,
      tried,
    )
  }

  /**
   * 规范档位（设置页那四格）→ 这个 route **这次真要发**的档位（'' = 不带 reasoningEffort）。
   *
   * 每次请求都按**当前模型的声明**现算（不缓存映射结果、不落盘）：用户换模型、DSH 升级换
   * adapter 之后立刻跟着变。清单里查不到（还没加载过 / 那次调用失败）就原样发规范值 ——
   * 与改动前一致，被拒时由换档重试兜；同时后台预热一次清单，下一次请求就能映射上。
   * 模型明确不支持推理（hasReasoning === false）时不发档位：发了 dsh-llm 必拒。
   */
  function effortForRoute(route: string, canonical: string): string {
    const item = modelCache.items.find((entry) => `${entry.provider}/${entry.model}` === route)
    if (!item) {
      warmModelCache()
      return canonical
    }
    if (item.hasReasoning === false) return ''
    const mapped = item.effortMap?.[canonical]
    return mapped === undefined || mapped === '' ? canonical : mapped
  }

  /** 清单预热：只在"真要用却还没读到"时拉一次，60 秒内不重复拉（失败也不打转）。 */
  let modelWarmAt = 0

  function warmModelCache(): void {
    if (modelCache.items.length > 0) return
    if (Date.now() - modelWarmAt < MODEL_CACHE_MS) return
    modelWarmAt = Date.now()
    void listModelChoices(false).catch(() => undefined)
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
        // null = 没读到（调用失败 / 拿不到信息）；true/false = 明确支持 / 不支持
        let hasReasoning: boolean | null = null
        try {
          // 两个方法签名不同，各自显式标注，避免联合类型把返回值退化成 any
          type Resolved = { reasoning?: { efforts?: Array<{ id?: string; name?: string }>; defaultEffort?: string } } | null
          let info: Resolved = null
          if (typeof llm.resolveModelInfo === 'function') {
            info = (await llm.resolveModelInfo(provider.id, model.id)) as Resolved
          } else if (typeof llm.resolveModel === 'function') {
            info = (await llm.resolveModel(provider.id, model.id)) as Resolved
          }
          if (info) {
            const list = info.reasoning?.efforts ?? []
            efforts = list
              .filter((item) => typeof item?.id === 'string' && item.id.length > 0)
              .map((item) => ({ id: String(item.id), name: String(item.name ?? item.id) }))
            defaultEffort = typeof info.reasoning?.defaultEffort === 'string' ? info.reasoning.defaultEffort : null
            // 声明了 reasoning 但档位列表为空 → 发任何档位 dsh-llm 都会拒（它自己也不接受空表）
            hasReasoning = efforts.length > 0
          }
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
          hasReasoning,
          effortMap: effortMapOf(efforts),
        })
      }
    }
    if (items.length > 0) modelCache = { at: Date.now(), items }
    return items
  }

  /** 请求里带 provider+model 时优先用它（并按清单校验；清单还没加载出来就只做形状校验）。 */
  const resolveRoute = (
    override?: { provider?: string; model?: string },
    /**
     * **当前会话**自己的模型选择（见 sessionModelOf）。
     *
     * 为什么要有它：会话是各自选模型的（每个 Agent 一份 model-selection），
     * 而 `agentDefaultModel.currentSelection()` 是**全局默认**、与会话无关。
     * 以前只用后者，于是"跟随主会话"其实跟的是"全局默认"——
     * 两个会话用不同模型时，插件对两个会话都用同一个默认模型，跟谁都对不上。
     *
     * 优先级：显式 override（小窗胶囊选的）→ 插件配置（设置页选的）→ **本会话的模型** → 全局默认 → 第一个可用。
     * 会话没记过选择（新会话、或日志里没有 model/selection）时自然落回全局默认，行为与以前一致。
     */
    sessionModel?: { provider?: string; model?: string } | null,
    /**
     * 这一轮是不是**追问**。
     *
     * 三个阶段沿用同一模型；旧 chatProvider/chatModel 仅保留配置兼容，不再参与路由。
     */
    chat?: boolean,
  ): Route | null => {
    if (override?.provider && override?.model) {
      const wanted = { provider: override.provider, model: override.model }
      const known = modelCache.items.some((item) => item.provider === wanted.provider && item.model === wanted.model)
      if (known || modelCache.items.length === 0) return wanted
    }
    if (config.provider && config.model) return { provider: config.provider, model: config.model }
    if (sessionModel?.provider && sessionModel?.model) {
      return { provider: sessionModel.provider, model: sessionModel.model }
    }
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
  return { resolveRoute, loadLeaky, leakyOnOff, noOffRoutes, effortForRoute, nextEffortFor, markNoOff, markLeaky, listModelChoices, get modelCache() { return modelCache }, MODEL_CACHE_MS }
}
