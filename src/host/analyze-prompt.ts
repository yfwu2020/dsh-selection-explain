import type { ServerResponse } from 'node:http'
import { CHAT_SYSTEM_PROMPT, CODE_PROMPT, DETAIL_PROMPT, TRANSLATION_PROMPT, shotPromptFor } from '../prompts.js'
import type { PreparedAnalyzeRequest } from './analyze-request.js'
import type { AnalyzeToolPlan } from './analyze-tools.js'
import type { AnalyzeDependencies } from './analyze-types.js'
import { loadDesignSkill } from './design-skill.js'
import { sse } from './http.js'

export interface AnalyzePrompt {
  stage: string
  isCode: boolean
  isShot: boolean
  systemPrompt: string
  sentEffort: string
  offSlotEffort: string
  routeKey: string
}

/** Assemble the exact prompt prefix and map the requested effort to the selected model. */
export async function prepareAnalyzePrompt(deps: AnalyzeDependencies, request: PreparedAnalyzeRequest, tools: AnalyzeToolPlan, res: ServerResponse): Promise<AnalyzePrompt> {
  const { ctx, config, models } = deps
  const { body, isChat, shotScope, shotFrame, effort, route, history } = request
  const { toolSchemas, wantsFsTools, readRoot, fetchBlockedSample } = tools
  const stage = typeof body.stage === 'string' ? body.stage : ''
  // 选中文字是代码：首轮走「注释」提示词（代码块 + 逐句注释 + 小结）
  const isCode = body.kind === 'code'
  // 截图提问是**独立模式**：没有选中文字，只有一张图 + 一个问题，不能用"追问"那套提示词
  const isShot = body.kind === 'shot'
  const basePrompt = isShot
    ? shotPromptFor(shotScope, shotFrame)
    : isChat
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
      skill +
      (body.theme === 'dark'
        ? '\n\n【配色：跟随宿主，当前是深色】宿主界面此刻是**深色模式**，页面必须是深色：' +
        '背景用 #16181c~#1f2126 一档，正文 #e6e6e6，次级文字 #a1a1aa，分隔线 rgba(255,255,255,.12)，' +
        '卡片底色比页面底再亮一档。**不要白底黑字**，也不要只写 prefers-color-scheme（宿主的深浅由用户设置决定，与系统不一定一致）。\n'
        : '\n\n【配色：跟随宿主，当前是浅色】宿主界面此刻是**浅色模式**，页面必须是浅色：' +
        '背景用 #ffffff~#f7f7f8 一档，正文 #171717，次级文字 #6b7280，分隔线 rgba(0,0,0,.10)，' +
        '卡片底色与页面底拉开一档。**不要深色底**，也不要只写 prefers-color-scheme（宿主的深浅由用户设置决定，与系统不一定一致）。\n')
  }
  // 访客名单要在**拼系统提示词之前**算好：提示词里要告诉模型"你附的那几个文件也在可读范围里"。
  //
  // ⚠️ 措辞很要紧。原来写的是「范围：项目目录。超出该范围的路径会被拒绝」，再追加一句
  // "附带的文件也能读" —— 实测模型会**逮住前半句直接放弃**：它一次 read 都不试，
  // 就回"这个文件我读不了，它在附件仓，而我的工具被限制在项目目录"。
  // 所以改成**先把可读范围说全**（项目 + 本次附带的文件），再说"除此之外会被拒"。
  history.attachedPaths = history.collectAttachedPaths(ctx)
  const fileRule = wantsFsTools
    ? `\n\n【文件访问】你可以用read/grep/glob读取当前项目（${readRoot || '不限'}）和本小窗已提供的文件附件。附件路径以经过验证的文件引用或selection_material返回为准。需要旧文件时先用selection_material取回路径，再按问题读取必要部分；上传成功不等于格式可解析，不能读取时明确说明。除此之外的路径会被拒绝。`
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
  await models.loadLeaky()
  let bodyEffort = typeof body.effort === 'string' && body.effort.length > 0 ? body.effort : ''
  // 这个模型在"关"档会把思考写进正文（实测过）：别再发 none，直接抬到 low —— 既没泄漏，也不慢
  const routeKey = `${route.provider}/${route.model}`
  if (isChat && bodyEffort === 'off' && models.leakyOnOff.has(routeKey)) {
    bodyEffort = 'low'
    sse(res, {
      type: 'notice',
      code: 'effort-clamped',
      tier: 'off',
      text: '该模型在「关」档会把思考写进正文，已自动改用「低」档',
    })
  }
  let requestEffort = isChat
    ? bodyEffort || config.chatReasoningEffort || effort
    : stage === 'detail'
      ? effort
      : config.translationReasoningEffort || effort
  // 已知这个模型不接受"关"档（之前撞过一次并记下来了）：直接换 low，不再先失败一轮。
  // 首轮默认就是 off，所以这条对"默认配置 + 不吃 off 的模型"是必经之路。
  if (requestEffort === 'off' && models.noOffRoutes.has(routeKey)) requestEffort = 'low'
  // 规范四格 → 这个模型真实声明的档位（每次请求现算；'' = 这个模型不支持推理，干脆不带档位）。
  // 注意：leaky / noOff 两条守卫仍在**规范档位**这一层判断（它们记的是"关档"的语义），
  // 映射放在最后一步。
  const sentEffort = models.effortForRoute(routeKey, requestEffort)
  // 「关」这一格在这个模型上到底是哪个真实档位：重试判定与泄漏检查都要按**真实档位**比
  // （模型可能没有 off，或叫 none/minimal —— 那就不能拿字符串 'off' 去比）
  const offSlotEffort = requestEffort === 'off' ? sentEffort : models.effortForRoute(routeKey, 'off')

  return { stage, isCode, isShot, systemPrompt, sentEffort, offSlotEffort, routeKey }
}
