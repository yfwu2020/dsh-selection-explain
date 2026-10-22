import { handlePanelEscape, handleVoiceCardEscape } from './keyboard.js'
import { el, listen, selectionDetached, clamp } from './dom.js'
import { CSS } from './styles.js'
import { Z_BTN, Z_PANEL, PILL_STAR_DOT_D, preferences, PING, PILL_MORPH_MS, PILL_STAR_D, VOICE_FALLBACK_SECONDS, PILL_BALL_SIZE, PILL_SNAP_RADIUS } from './constants.js'
import { sparkleIcon, quoteIcon, actionButton, headerHistoryIcon, headerPromoteIcon, headerSettingsIcon, iconButton, headerCloseIcon, buildSection, markdownIcon, windowIcon, sendIcon, micIcon, closeIcon, stopIcon, backIcon, plusIcon, docIcon } from './icons.js'
import React from 'react'
import { previewFrames, applyPreviewHeight, splitSections } from './render.js'
import { recordingSupported } from './audio.js'

import { createSettingsController } from './settings.js'
import { createSelectionController } from './selection.js'
import { createVoiceCardController } from './voice-card.js'
import { createQuotesController } from './quotes.js'
import { createAttachController } from './attach.js'
import { createLightboxController } from './lightbox.js'
import { createShotController } from './shot.js'
import { createPreviewController } from './preview.js'
import { createPanelController } from './panel.js'
import { createPillController } from './pill.js'
import { createHistoryController } from './history.js'
import { createConversationController } from './conversation.js'
import { createModelsController } from './models.js'
import { createVoiceController } from './voice.js'
import { createResultCache, createTimerScope } from './memory.js'

export function apply(ctx) {

  /** 当前面板状态。 */
  var state = {
    /** 最近一次有效选区：{ text, range, rect }。 */
    selection: null,
    /** 当前请求：{ abort }。 */
    request: null,
    /** 原始流式文本。 */
    raw: '',
    /** 'idle' | 'loading' | 'streaming' | 'done' | 'error'。 */
    phase: 'idle',
    /**
     * 当前选区是不是来自**侧边栏网页里的桥**（iframe 帧内上报）。
     * 为 true 时顶层选区塌掉不算"选区没了"——那种塌陷是我们点浮标造成的。
     */
    bridgeActive: false,
    /** 计时与统计。 */
    startedAt: 0,
    elapsed: 0,
    chars: 0,
    error: '',
    model: '',
    /** host 回传的推理档位（等待超过 6 秒时写进等待提示）。 */
    /** 模型思考过程的最新尾巴（只用于等待提示，不进正文）。 */
    thought: '',
    /** 第一节标题：'翻译' | '解读' | '注释'。 */
    sectionTitle: '翻译',
    /** 'code' | 'text'：选中文字是代码还是文本。 */
    kind: 'text',
    /** 本轮用过的工具（只做内部摘要，**不渲染**）。 */
    tools: [],
    /** 工具结果摘要：追问时带给模型，避免重复联网。 */
    toolDigest: '',
    /** 有工具正在跑（等待提示说"正在检索资料"，不显示是哪个工具、查了什么）。 */
    toolBusy: false,
    /** 模型输出了伪造的工具调用格式（已被剥掉）。 */
    /** 这次内容是"从历史回放"出来的（不是本次请求）。 */
    fromHistory: false,
    /** 当前选区的本地缓存 key。 */
    cacheKey: '',
    /** 'local' | 'shared' | 'miss'：命中情况（状态栏与自检钩子都会报）。 */
    cacheState: 'miss',
    /** 没命中、但缓存里有过"同一个词"（上下文不同）——状态栏据此解释。 */
    sameTextHint: false,
    /** 最近一次请求载荷（重新生成复用）。 */
    payload: null,
    /** 已生成的两节内容（分阶段产出）。 */
    parts: { translation: '', detail: '' },
    /**
     * 这段对话**没有解读**（语音卡那条"跳过翻译与详解、直接追问"的路）：
     * 翻译节整节不画，追问输入框直接可见。
     *
     * 语义单位是"一段对话"而不是"一次开窗"：落盘时写进历史条目的 skipped，
     * 回放/缓存命中时按它复原（否则同一个词再开一次，空翻译卡片又冒出来 —— 用户实测）。
     */
    skipInterpretation: false,
    /** 当前阶段：'translation' | 'detail' | 'chat'。 */
    stage: '',
    /** 追问轮次：[{ role: 'user' | 'assistant', text }]，只活在面板/内存里（临时）。 */
    turns: [],
    /**
     * 待发送的引用：[{ label: '小窗回答' | '主界面选中' …, text }]。
     * 只属于**下一条**提问（发送即清空）；关掉面板不清 —— 回来接着写还看得见。
     */
    quotes: [],
    /**
     * 待发送的附件：[{ id, kind:'image'|'file', name, size, mediaType, file, url, status, ref, error }]。
     * 和引用同一条规矩 —— 只属于**下一条**追问，发送即清空；
     * 区别是上传状态挂在每一项上（逐件上传、逐件重试，见 attach.js）。
     */
    attachments: [],
    /** 附件条下面那行提示（"文件夹不支持""一次最多 10 件"之类），空串就不显示。 */
    attachNote: '',
    /** 最近一次"可以引用"的选区：[{ text, label, rect, source }]（浮标据此显示）。 */
    quoteSelection: null,
    /** 正在取引用的会话上下文（这期间再按 Enter 不能空发一条）。 */
    resolvingQuotes: false,
    /** 最近一条状态文本（界面上不显示，只给自检用）。 */
    lastStatus: '',
    /** 是不是"跟着最新消息走"（发完消息自动置真；用户自己往上滚就交回给他）。 */
    follow: false,
    /** 追问的进行中请求（用于"停止"）。 */
    askRequest: null,
    /** 这一轮是不是被用户按"停止"打断的。 */
    stopped: false,
    /** 小窗的模型选择（null = 跟随会话默认）。 */
    modelChoice: null,
    /** 用户在模型菜单里选的**追问档**推理等级（null = 用配置默认）。只有菜单会写它。 */
    effort: null,
    /**
     * host 回报的"本次请求实际用的档位"，只用于等待提示显示。
     * 必须和上面的 effort 分开：以前共用一个字段，首轮（翻译，固定 low）跑完就把用户选的档位覆盖成 low，
     * 追问于是永远发 low —— 表现为"推理等级的设置没起作用"。
     */
    stageEffort: '',
    /**
     * 首轮/详解期间 host 发的 notice（换档重试、上游偶发错误…）。
     * 以前首轮那条 SSE 处理器**没有 notice 分支**，host 说的话全被丢掉 ——
     * 用户只看到"卡了十几秒"，不知道插件正在换档重试。
     */
    notice: '',
    /** 网页模式（小窗开关）：复杂问题默认用网页回答。 */
    webAnswer: false,
    /** 追问是否正在流式返回。 */
    asking: false,
    /** 这一轮追问的开始时刻（胶囊显示秒数用）。 */
    askingStartedAt: 0,
    /** 是不是"用户收起小窗"导致的中止（是的话不记成失败，记成已停止）。 */
    aborted: false,
    /** 升格请求进行中。 */
    promoting: false,
  }

  /** 结果缓存：同选区+上下文第二次点开即秒回。 */
  var cache = createResultCache()
  var timerScope = createTimerScope()

  // —— DOM ——
  var styleEl = el('style')

  styleEl.setAttribute('data-plugin', '@yfwu2020/dsh-selection-explain')

  styleEl.textContent = CSS

  document.head.appendChild(styleEl)

  /** 自有浮层根：位于 body，公共父层的堆叠上下文不影响它。 */
  var layer = el('div', 'dsh-sel-layer')

  layer.style.pointerEvents = 'none'

  layer.setAttribute('data-dsh-floating-owner', 'explanation')

  var button = el('button', 'dsh-sel-btn')

  button.type = 'button'

  button.title = '解读选中文字（翻译 + 详解）'

  button.style.zIndex = String(Z_BTN)

  button.style.pointerEvents = 'auto'

  button.appendChild(sparkleIcon())

  button.appendChild(el('span', null, '解读'))

  layer.appendChild(button)

  /**
   * 引用浮标（`❝ 引用`）：**小窗开着**的时候才有它 —— 这时候用户划词多半是想
   * 接着问，而不是再开一个小窗（再开一个的入口是先把当前小窗收起来）。
   * 两种来源共用它：
   *   · 小窗自己正文里的选区（回答 / 翻译 / 详解 / 顶部选中文字条）；
   *   · 小窗开着时主界面上的选区（含侧边栏网页里那条由桥报上来的）。
   * 点一下 → 挂进小窗输入框的引用区，不打断输入。
   */
  var quoteButton = el('button', 'dsh-sel-btn dsh-sel-quotebtn')

  quoteButton.type = 'button'

  quoteButton.title = '引用到小窗输入框（作为下一句提问的材料）'

  // **必须比面板高**：小窗里划词时，浮标是画在面板上面的那层（同一个浮层里的兄弟节点，
  // 谁 z-index 大谁在上）。用 Z_BTN 的话浮标会被面板整个盖住 —— 看不见也点不着。
  quoteButton.style.zIndex = String(Z_PANEL + 1)

  quoteButton.style.pointerEvents = 'auto'

  quoteButton.appendChild(quoteIcon())

  quoteButton.appendChild(el('span', null, '引用'))

  layer.appendChild(quoteButton)

  /**
   * 悬浮状态胶囊：显示"最近一次划词现在处于什么状态"，点一下回到那个小窗。
   * 位置由 placePill() 动态贴到右下角费用胶囊（dsh-spend）上方；老版本没装那个插件时用兜底位置。
   */
  var pill = el('div', 'dsh-sel-pill')

  pill.setAttribute('role', 'button')

  pill.setAttribute('tabindex', '0')

  pill.style.pointerEvents = 'auto'

  // 球心里的图形：一枚 32×32 的 SVG（viewBox -16..16，1 单位 = 1px），里面只有一条 path。
  // 展开态它画成 8px 圆点（PILL_STAR_DOT_D），收球时把 d 换成星芒（PILL_STAR_D）——
  // 两条 path 命令结构一致，Chrome 对 d 插值，于是"圆点长成星芒"是一条连续形变。
  var pillIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')

  pillIcon.setAttribute('class', 'dsh-sel-pillicon')

  pillIcon.setAttribute('viewBox', '-16 -16 32 32')

  pillIcon.setAttribute('aria-hidden', 'true')

  pillIcon.setAttribute('focusable', 'false')

  var pillStar = document.createElementNS('http://www.w3.org/2000/svg', 'path')

  pillStar.setAttribute('class', 'dsh-sel-pillstar')

  pillStar.setAttribute('d', PILL_STAR_DOT_D)

  pillIcon.appendChild(pillStar)

  // 和费用胶囊同构：主体一段（加粗）、次要一段（淡）、箭头一段（更淡）
  var pillName = el('span', 'dsh-sel-pillname', '划词解读')

  var pillMeta = el('span', 'dsh-sel-pillmeta', '· 就绪')

  var pillCaret = el('span', 'dsh-sel-pillcaret', '▴')

  pill.appendChild(pillIcon)

  pill.appendChild(pillName)

  pill.appendChild(pillMeta)

  pill.appendChild(pillCaret)

  layer.appendChild(pill)

  var panel = el('div', 'dsh-sel-panel')

  panel.style.zIndex = String(Z_PANEL)

  panel.style.pointerEvents = 'auto'

  panel.setAttribute('role', 'dialog')

  panel.setAttribute('aria-label', '划词解读')

  var head = el('div', 'dsh-sel-head')

  head.appendChild(el('span', 'dsh-sel-mark'))

  head.appendChild(el('span', 'dsh-sel-title', '划词解读'))

  // 撑开用：把右侧三个按钮（最近/升格/✕）顶到最右。
  // 以前这一步是"模型名标签"的 margin-left:auto 兼任的，标签一删按钮就贴到标题后面了。
  head.appendChild(el('span', 'dsh-sel-headspace'))

  var historyButton = actionButton('最近聊过的划词（点一条把那段对话调回来）', '最近', headerHistoryIcon)

  var promoteButton = actionButton('升格为正式会话（建在同一个项目下，带着这段文字与上面的讨论）', '升格', headerPromoteIcon)

  // 设置：与「最近 / 升格」**同款**（同边框、同高、同圆角、同 hover），图标 + 文字。
  // 用户要求"图标旁加上设置两字" —— 一排文字键，视觉上才是同一套东西。
  var settingsButton = actionButton('设置（模型 / 解读 / 背景 / 联网 / 界面 / 数据）', '设置', headerSettingsIcon)

  settingsButton.setAttribute('aria-haspopup', 'dialog')

  settingsButton.setAttribute('aria-pressed', 'false')

  var closeButton = iconButton('关闭（Esc）', headerCloseIcon)

  head.appendChild(historyButton)

  head.appendChild(promoteButton)

  head.appendChild(settingsButton)

  head.appendChild(closeButton)

  var quote = el('div', 'dsh-sel-quote')

  var body = el('div', 'dsh-sel-body')

  // 选中文字条是滚动区的**第一项**：必须在两节/对话区之前 append，
  // 否则它会排到消息下面去（实测踩过：append 的时机比 appendChild 的目标更重要）
  body.appendChild(quote)

  var expandButton = el('button', 'dsh-sel-expand')

  expandButton.type = 'button'

  expandButton.title = '当前只给了翻译（背景 8 条，首字更快）。点这里加载完整会话背景并生成详解。'

  expandButton.appendChild(el('span', null, '↓ 展开详解'))

  var translationSection = buildSection('1', '翻译', 'translation')

  var detailSection = buildSection('2', '详解', 'detail')

  body.appendChild(translationSection.root)

  body.appendChild(detailSection.root)

  body.appendChild(expandButton)

  var chatLog = el('div', 'dsh-sel-chatlog')

  body.appendChild(chatLog)

  var askRow = el('div', 'dsh-sel-ask')

  // 引用区是 composer 的**第一行**：挂在输入框上面（发送时随提问一起带走、发完清空）。
  // 顺序很重要 —— 先 append 到 askRow 再 append 输入框，否则会排到工具行下面去。
  var quotesBox = el('div', 'dsh-sel-quotes')

  askRow.appendChild(quotesBox)

  // 附件条：和引用**同一条区域**（输入框上方），但它是横着一排缩略图，
  // 而引用是竖着排的卡片 —— 两种形状，所以是两条独立的条。
  // 排在引用**下面**：引用是"从正文里挑出来的材料"，附件是"从外面带进来的"，越靠近输入框越像"这条消息的"。
  var attachBox = el('div', 'dsh-sel-attach')

  askRow.appendChild(attachBox)

  // 附件出错 / 被拒时的一行说明（正常时整条收起来，不占高度）
  var attachNote = el('p', 'dsh-sel-attachnote')

  askRow.appendChild(attachNote)

  // 系统文件选择器：图片和文件**一起选**（不分成两个键），所以 accept 留空。
  // 放在面板里而不是临时 createElement：免得每次点 ＋ 都新建一个节点。
  var attachInput = el('input')

  attachInput.type = 'file'
  attachInput.multiple = true
  attachInput.style.display = 'none'
  attachInput.setAttribute('aria-hidden', 'true')
  attachInput.tabIndex = -1

  askRow.appendChild(attachInput)

  var askBox = el('textarea', 'dsh-sel-askbox')

  askBox.rows = 1

  askBox.placeholder = '就这段文字继续追问…（Enter 发送，Shift+Enter 换行）'

  // 网页模式开关：打开后，追问里较复杂的问题默认用网页回答（并注入附带的设计规范）
  // 输出偏好：**只有两格图标**（M↓ = Markdown / ▭ = 网页，选中格是滑动的药丸）。
  //
  // 2026-10-18：去掉了原来前面那行「输出偏好」文字。理由是工具行**位置**已经把这排东西
  // 分好类了 —— 左边是"给这条消息加材料"（＋ / 输出偏好），右边是"怎么发出去"
  // （模型 / 麦克风 / 发送）。省下的宽度实测约 53px，比新加的 ＋（约 34px）还多，
  // 于是窄面板下反而更不容易折行（详见 docs/attach-chosen-lab.html 的实测数字）。
  // 代价是这两格图标自己没字了，语义改由 title + aria-label 承担（下面两处都要写上）。
  var webMode = el('span', 'dsh-sel-pref')

  webMode.title = '输出偏好：Markdown（默认文字回答）/ 网页（复杂问题生成 HTML 页面）'

  var prefSeg = el('span', 'dsh-sel-seg')

  prefSeg.setAttribute('role', 'radiogroup')

  prefSeg.setAttribute('aria-label', '输出偏好：Markdown 或网页')

  var prefPill = el('span', 'dsh-sel-segpill')

  var cellMd = el('button', 'dsh-sel-segcell')

  cellMd.type = 'button'

  cellMd.setAttribute('role', 'radio')

  cellMd.setAttribute('aria-label', 'Markdown：普通段落，最省时间')

  cellMd.appendChild(markdownIcon())

  var cellWeb = el('button', 'dsh-sel-segcell')

  cellWeb.type = 'button'

  cellWeb.setAttribute('role', 'radio')

  cellWeb.setAttribute('aria-label', '网页：复杂问题生成一个 HTML 页面')

  cellWeb.appendChild(windowIcon())

  prefSeg.appendChild(prefPill)

  prefSeg.appendChild(cellMd)

  prefSeg.appendChild(cellWeb)

  webMode.appendChild(prefSeg)

  var askSend = el('button', 'dsh-sel-iconbtn dsh-sel-asksend')

  askSend.type = 'button'

  askSend.setAttribute('aria-label', '发送')

  askSend.appendChild(sendIcon())

  // 语音输入：麦克风贴在发送键左边（和主会话 composer 的位置一致）。
  // 平时就是这枚图标；一旦开始录，工具行整个换成下面的"录音行"（与主会话同一套）。
  var micButton = el('button', 'dsh-sel-iconbtn dsh-sel-mic')

  micButton.type = 'button'

  micButton.setAttribute('data-state', 'idle')

  micButton.setAttribute('aria-label', '语音输入')

  micButton.title = '语音输入（点一下开始说，再点一下结束并转成文字）'

  micButton.appendChild(micIcon())

  // 模型 + 推理等级（追问档）：胶囊在发送键左边，菜单向上弹
  var modelPill = el('button', 'dsh-sel-picker')

  modelPill.type = 'button'

  modelPill.setAttribute('aria-haspopup', 'menu')

  modelPill.setAttribute('aria-expanded', 'false')

  var modelPillName = el('span', 'dsh-sel-picker-name', '模型')

  var modelPillTier = el('span', 'dsh-sel-picker-tier', '')

  modelPill.appendChild(modelPillName)

  modelPill.appendChild(modelPillTier)

  modelPill.appendChild(el('span', 'dsh-sel-picker-caret', '▼'))

  var modelMenu = el('div', 'dsh-sel-pickermenu')

  // role 随开合同步：DSH 按 [role="menu"] 判定弹层，不检查 CSS 可见性。

  // ── 录音行（与主会话 ui-voice-input 同一套结构）──
  //   [✕ 取消] [实时波形 / 状态文案] [■ 停止 或 行内动作] …… [↑ 发送（原位不动）]
  // 录音时是「✕ + 波形 + ■」；请求权限与识别中是「✕ + 呼吸点 + 请允许使用麦克风…/识别中…」；
  // 出错是「✕ + 原因 + 行内动作（准备模型 / 重新录音）」。
  var captureRow = el('div', 'dsh-sel-capture')

  captureRow.setAttribute('data-show', '0')

  var voiceCancel = el('button', 'dsh-sel-round')

  voiceCancel.type = 'button'

  voiceCancel.setAttribute('aria-label', '取消')

  voiceCancel.title = '取消（Esc）'

  voiceCancel.appendChild(closeIcon())

  // 波形：80 根竖线，静音时是一条虚线（算法照抄主会话的 Waveform）
  var waveSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')

  waveSvg.setAttribute('class', 'dsh-sel-vwave')

  waveSvg.setAttribute('viewBox', '0 0 640 40')

  waveSvg.setAttribute('preserveAspectRatio', 'none')

  waveSvg.setAttribute('role', 'img')

  waveSvg.setAttribute('aria-label', '正在录音…')

  var waveBars = []

  for (var waveIndex = 0; waveIndex < 80; waveIndex += 1) {
    var waveBar = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    waveBar.setAttribute('x1', String(waveIndex * 8 + 4))
    waveBar.setAttribute('x2', String(waveIndex * 8 + 4))
    waveBar.setAttribute('y1', '19')
    waveBar.setAttribute('y2', '21')
    waveBar.setAttribute('stroke', 'currentColor')
    waveBar.setAttribute('stroke-width', '3')
    waveBar.setAttribute('stroke-linecap', 'round')
    waveBar.setAttribute('opacity', String(0.25 + waveIndex / 120))
    waveSvg.appendChild(waveBar)
    // 最新的电平在最右边：和主会话一样从右往左推
    waveBars.unshift({ node: waveBar, level: 0 })
  }

  var voiceActivity = el('span', 'dsh-sel-vactivity')

  voiceActivity.setAttribute('role', 'status')

  var voiceDot = el('span', 'dsh-sel-vdot')

  var voiceActivityText = el('span', null, '')

  voiceActivity.appendChild(voiceDot)

  voiceActivity.appendChild(voiceActivityText)

  var voiceStop = el('button', 'dsh-sel-round dsh-sel-stop')

  voiceStop.type = 'button'

  voiceStop.setAttribute('aria-label', '停止并识别')

  voiceStop.title = '停止并识别'

  voiceStop.appendChild(stopIcon())

  // 行内动作位：按状态放「准备模型」文字键或「重新录音」🎤圆键（主会话同款 inlineAction）
  var voiceActionSlot = el('span', 'dsh-sel-vactslot')

  captureRow.appendChild(voiceCancel)

  captureRow.appendChild(waveSvg)

  captureRow.appendChild(voiceActivity)

  captureRow.appendChild(voiceActionSlot)

  captureRow.appendChild(voiceStop)

  var askTools = el('div', 'dsh-sel-asktools')

  // ＋：附件入口，放工具行**最左**（圆形浅底，和主会话 composer 的 ＋ 同款）。
  // 为什么在最左而不是挨着麦克风：左侧是"给这条消息加材料"（＋ / 输出偏好），
  // 右侧是"怎么发出去"（模型 / 麦克风 / 发送）—— 两件事分开摆，位置本身就是分类。
  var addButton = el('button', 'dsh-sel-iconbtn dsh-sel-add')

  addButton.type = 'button'
  addButton.setAttribute('aria-label', '添加图片或文件')
  addButton.title = '添加图片或文件（也可以直接粘贴或拖进来）'
  addButton.appendChild(plusIcon())

  var askSpacer = el('span', 'dsh-sel-askspace')

  askTools.appendChild(addButton)

  askTools.appendChild(webMode)

  askTools.appendChild(askSpacer)

  askTools.appendChild(modelPill)

  askTools.appendChild(micButton)

  askTools.appendChild(captureRow)

  askTools.appendChild(askSend)

  askRow.appendChild(askBox)

  askRow.appendChild(askTools)

  askRow.appendChild(modelMenu)

  // 「重新生成」不再常驻页脚：只在内容区没有可用结果时出现在正文里
  var retryButton = el('button', 'dsh-sel-retry', '重新生成')

  retryButton.type = 'button'

  retryButton.style.display = 'none'

  // ══════════════════ 设置页（抽屉） ══════════════════
  // 挂在面板**内部**：面板是 position:fixed（也算定位祖先）且 overflow:hidden，
  // 于是"从右侧滑入"的那一帧会被圆角裁掉，不会溢出到面板外面去。
  var settingsScrim = el('div', 'dsh-sel-scrim')

  settingsScrim.setAttribute('data-open', '0')

  var settingsSheet = el('div', 'dsh-sel-sheet')

  settingsSheet.setAttribute('data-open', '0')

  settingsSheet.setAttribute('role', 'dialog')

  settingsSheet.setAttribute('aria-label', '划词解读设置')

  var settingsHead = el('div', 'dsh-sel-sheethead')

  var settingsBack = el('button', 'dsh-sel-sheetback')

  settingsBack.type = 'button'

  settingsBack.title = '返回（Esc）'

  settingsBack.setAttribute('aria-label', '返回')

  settingsBack.appendChild(backIcon())

  settingsHead.appendChild(settingsBack)

  settingsHead.appendChild(el('span', 'dsh-sel-sheettitle', '设置'))

  settingsHead.appendChild(el('span', 'dsh-sel-sheetscope', '仅本插件 · 即时生效'))

  var settingsMain = el('div', 'dsh-sel-sheetmain')

  var settingsRail = el('div', 'dsh-sel-rail')

  settingsRail.setAttribute('role', 'tablist')

  settingsRail.setAttribute('aria-orientation', 'vertical')

  var settingsBody = el('div', 'dsh-sel-sheetbody')

  settingsMain.appendChild(settingsRail)

  settingsMain.appendChild(settingsBody)

  var settingsFoot = el('div', 'dsh-sel-sheetfoot')

  var settingsNote = el('span', 'dsh-sel-sfootnote')

  settingsNote.setAttribute('data-dirty', '0')

  settingsNote.appendChild(el('i'))

  var settingsNoteText = el('span', null, '改动会自动保存')

  settingsNote.appendChild(settingsNoteText)

  var settingsReset = el('button', 'dsh-sel-sbtn', '恢复默认')

  settingsReset.type = 'button'

  settingsReset.title = '把所有设置写回 cordis.patch.yml / 出厂默认'

  var settingsClose = el('button', 'dsh-sel-sbtn', '关闭')

  settingsClose.type = 'button'

  settingsFoot.appendChild(settingsNote)

  settingsFoot.appendChild(settingsReset)

  settingsFoot.appendChild(settingsClose)

  settingsSheet.appendChild(settingsHead)

  settingsSheet.appendChild(settingsMain)

  settingsSheet.appendChild(settingsFoot)

  // ── 改大小手柄（右下角 + 右边缘 + 下边缘）──
  // 小窗的尺寸/位置都由这里驱动；拖完记在 host 上（见 savePanelBox）。
  var gripCorner = el('div', 'dsh-sel-grip dsh-sel-grip-corner')

  var gripRight = el('div', 'dsh-sel-grip dsh-sel-grip-r')

  var gripBottom = el('div', 'dsh-sel-grip dsh-sel-grip-b')

  gripCorner.title = '拖动改大小（双击恢复默认）'

  panel.appendChild(gripCorner)

  panel.appendChild(gripRight)

  panel.appendChild(gripBottom)

  panel.appendChild(settingsScrim)

  panel.appendChild(settingsSheet)

  panel.appendChild(head)

  panel.appendChild(body)

  panel.appendChild(askRow)

  // 拖放遮罩：铺在面板上（面板是 overflow:hidden 的定位祖先，遮罩的圆角正好贴住内容区）。
  // 它只是**状态展示**，不接收指针事件（pointer-events:none）—— 事件全由面板自己接，
  // 否则遮罩一出现就把 drop 事件的落点换成了它自己。
  var dropMask = el('div', 'dsh-sel-drop')

  dropMask.setAttribute('aria-hidden', 'true')

  var dropArt = el('div', 'dsh-sel-drop-art')

  dropArt.appendChild(plusIcon())

  dropMask.appendChild(dropArt)

  dropMask.appendChild(el('div', 'dsh-sel-drop-title', '松开即添加为这条追问的附件'))

  dropMask.appendChild(el('div', 'dsh-sel-drop-hint', '图片直接给模型看 · 文件存成只读路径按需读取'))

  panel.appendChild(dropMask)

  layer.appendChild(panel)
  var settingsController = createSettingsController({
    get state() { return state },
    get modelCatalog() { return modelsController.modelCatalog },
    get paintModelPill() { return modelsController.paintModelPill },
    get panelSessionId() { return panelSessionId },
    get currentSessionId() { return panelController.currentSessionId },
    get loadModelCatalog() { return modelsController.loadModelCatalog },
    get settingsSheet() { return settingsSheet },
    get modelMenu() { return modelMenu },
    get renderModelMenu() { return modelsController.renderModelMenu },
    get catalogItemOf() { return modelsController.catalogItemOf },
    get settingsNote() { return settingsNote },
    get settingsNoteText() { return settingsNoteText },
    get bridgeOn() { return previewController.bridgeOn },
    set bridgeOn(value) { previewController.bridgeOn = value },
    get scheduleBridgeScan() { return previewController.scheduleBridgeScan },
    get settingsRail() { return settingsRail },
    get settingsBody() { return settingsBody },
    get pillHidden() { return pillHidden },
    set pillHidden(value) { pillHidden = value },
    get pill() { return pill },
    get placePill() { return pillController.placePill },
    get pillIdleId() { return pillIdleId },
    set pillIdleId(value) { pillIdleId = value },
    get schedulePillIdle() { return pillController.schedulePillIdle },
    get panelOpen() { return panelOpen },
    get panel() { return panel },
    get settingsScrim() { return settingsScrim },
    get settingsButton() { return settingsButton },
  })
  var selectionController = createSelectionController({
    get later() { return later },
    get layer() { return layer },
    get panel() { return panel },
    get pill() { return pill },
    get body() { return body },
    get state() { return state },
    get translationSection() { return translationSection },
    get detailSection() { return detailSection },
    get hideQuoteButton() { return voiceCardController.hideQuoteButton },
    get turnIndexOfNode() { return quotesController.turnIndexOfNode },
    get panelOpen() { return panelOpen },
    get button() { return button },
    get currentSurfaceTheme() { return historyController.currentSurfaceTheme },
    get startMicWatch() { return voiceCardController.startMicWatch },
    get vcardState() { return voiceCardController.vcardState },
    get stopMicWatch() { return voiceCardController.stopMicWatch },
    get quoteButton() { return quoteButton },
  })
  var voiceCardController = createVoiceCardController({
    get shotRefAsync() { return shotController.takeRefAsync },
    get clearShotMarkers() { return shotController.clearMarkers },
    get layer() { return layer },
    get later() { return later },
    get panelOpen() { return panelOpen },
    get state() { return state },
    get isTypingTarget() { return panelController.isTypingTarget },
    get button() { return button },
    get hideButton() { return selectionController.hideButton },
    get settingsLive() { return settingsController.settingsLive },
    get rangeSelection() { return panelController.rangeSelection },
    get openPanelWith() { return panelController.openPanelWith },
    get clearDocSelection() { return panelController.clearDocSelection },
    get frameTouchedAt() { return previewController.frameTouchedAt },
    get timerScope() { return timerScope },
    get voice() { return voiceController.voice },
    get addQuote() { return quotesController.addQuote },
    get quoteContextFor() { return quotesController.quoteContextFor },
    get composerVisible() { return panelController.composerVisible },
    get focusAskBox() { return panelController.focusAskBox },
    get quoteButton() { return quoteButton },
    get setQuotePop() { return selectionController.setQuotePop },
  })
  var quotesController = createQuotesController({
    get foldForHistory() { return historyController.foldForHistory },
    get state() { return state },
    get setStatus() { return panelController.setStatus },
    get refreshAskState() { return conversationController.refreshAskState },
    get askRow() { return askRow },
    get composerVisible() { return panelController.composerVisible },
    get focusAskBox() { return panelController.focusAskBox },
    get quotesBox() { return quotesBox },
    get body() { return body },
    get panel() { return panel },
    get rangeSelection() { return panelController.rangeSelection },
    get currentSessionId() { return panelController.currentSessionId },
    get timerScope() { return timerScope },
  })
  var previewController = createPreviewController({
    get panel() { return panel },
    get state() { return state },
    get vcardState() { return voiceCardController.vcardState },
    get hideButton() { return selectionController.hideButton },
    get later() { return later },
  })
  /**
   * 图片预览（灯箱）：输入框上方的待发送缩略图与已发出气泡里的图片共用这一个入口。
   * 挂在 layer 上、铺满整窗 —— 面板只有 540px 宽，塞回面板里预览等于没放大。
   */
  var lightboxController = createLightboxController({
    get layer() { return layer },
  })
  var panelController = createPanelController({
    get timerScope() { return timerScope },
    get panelSessionId() { return panelSessionId },
    set panelSessionId(value) { panelSessionId = value },
    get ctx() { return ctx },
    get cache() { return cache },
    get state() { return state },
    get translationSection() { return translationSection },
    get expandButton() { return expandButton },
    get hideButton() { return selectionController.hideButton },
    get quote() { return quote },
    get clearQuotes() { return quotesController.clearQuotes },
    get clearAttachments() { return attachController.clear },
    get renderTurns() { return historyController.renderTurns },
    get clearRenderedTurns() { return historyController.clearRenderedTurns },
    get clearWaiting() { return conversationController.clearWaiting },
    get sendAsk() { return conversationController.sendAsk },
    get restoreFromHistory() { return historyController.restoreFromHistory },
    get runRequest() { return conversationController.runRequest },
    get vcardHandoff() { return voiceCardController.vcardHandoff },
    set vcardHandoff(value) { voiceCardController.vcardHandoff = value },
    get panel() { return panel },
    get historyList() { return historyList },
    get placeHistoryList() { return historyController.placeHistoryList },
    get panelOpen() { return panelOpen },
    set panelOpen(value) { panelOpen = value },
    get autoGrowAskBox() { return conversationController.autoGrowAskBox },
    get askFocusPending() { return askFocusPending },
    set askFocusPending(value) { askFocusPending = value },
    get hideQuoteButton() { return voiceCardController.hideQuoteButton },
    get paintPill() { return pillController.paintPill },
    get refreshFollowRoute() { return settingsController.refreshFollowRoute },
    get syncRouteWatch() { return settingsController.syncRouteWatch },
    get warmModelCatalog() { return modelsController.warmModelCatalog },
    get prefersReducedMotion() { return voiceCardController.prefersReducedMotion },
    get panelGrowTimer() { return voiceCardController.panelGrowTimer },
    set panelGrowTimer(value) { voiceCardController.panelGrowTimer = value },
    get panelGrowHandler() { return voiceCardController.panelGrowHandler },
    set panelGrowHandler(value) { voiceCardController.panelGrowHandler = value },
    get later() { return later },
    get closeModelMenu() { return modelsController.closeModelMenu },
    get closeSettings() { return settingsController.closeSettings },
    get closeLightbox() { return lightboxController.close },
    get hideHistoryList() { return historyController.hideHistoryList },
    get cancelVoice() { return voiceController.cancelVoice },
    get visibleRaw() { return historyController.visibleRaw },
    get showWaiting() { return conversationController.showWaiting },
    get retryButton() { return retryButton },
    get detailSection() { return detailSection },
    get currentSurfaceTheme() { return historyController.currentSurfaceTheme },
    get layer() { return layer },
    get askRow() { return askRow },
    get closeButton() { return closeButton },
    get refreshAskState() { return conversationController.refreshAskState },
    get focusBail() { return focusBail },
    set focusBail(value) { focusBail = value },
    get askBox() { return askBox },
    get insidePanelContent() { return selectionController.insidePanelContent },
  })
  var pillController = createPillController({
    get state() { return state },
    get pillName() { return pillName },
    get pillMeta() { return pillMeta },
    get pill() { return pill },
    get panelOpen() { return panelOpen },
    get pillCaret() { return pillCaret },
    get pillHost() { return pillHost },
    set pillHost(value) { pillHost = value },
    get pillFreeRight() { return pillFreeRight },
    set pillFreeRight(value) { pillFreeRight = value },
    get pillDock() { return pillDock },
    set pillDock(value) { pillDock = value },
    get pillHidden() { return pillHidden },
    get pillAnchorWidth() { return pillAnchorWidth },
    set pillAnchorWidth(value) { pillAnchorWidth = value },
    get pillBall() { return pillBall },
    set pillBall(value) { pillBall = value },
    get pillSnapUntil() { return pillSnapUntil },
    set pillSnapUntil(value) { pillSnapUntil = value },
    get pillHover() { return pillHover },
    get pillDrag() { return pillDrag },
    set pillDrag(value) { pillDrag = value },
    get pillStar() { return pillStar },
    get pillIdleId() { return pillIdleId },
    set pillIdleId(value) { pillIdleId = value },
    get pillDragMoved() { return pillDragMoved },
    set pillDragMoved(value) { pillDragMoved = value },
    get later() { return later },
    get pillWatched() { return pillWatched },
    set pillWatched(value) { pillWatched = value },
    get pillObserver() { return pillObserver },
    set pillObserver(value) { pillObserver = value },
    get pillPollDelay() { return pillPollDelay },
    set pillPollDelay(value) { pillPollDelay = value },
    get PILL_POLL_MIN() { return PILL_POLL_MIN },
    get PILL_POLL_MAX() { return PILL_POLL_MAX },
    get pillPlacerId() { return pillPlacerId },
    set pillPlacerId(value) { pillPlacerId = value },
    get closePanel() { return panelController.closePanel },
    get showPanel() { return panelController.showPanel },
    get paint() { return panelController.paint },
    get renderTurns() { return historyController.renderTurns },
    get setStatus() { return panelController.setStatus },
    get loadHistoryEntry() { return historyController.loadHistoryEntry },
  })
  var historyController = createHistoryController({
    set panelSessionId(value) { panelSessionId = value },
    get applyShotTitle() { return panelController.applyShotTitle },
    get sentTextOf() { return quotesController.sentTextOf },
    get panel() { return panel },
    get previewImage() { return lightboxController.open },
    get state() { return state },
    get exportTurns() { return quotesController.exportTurns },
    get clearQuotes() { return quotesController.clearQuotes },
    get buildPayload() { return panelController.buildPayload },
    get askFocusAfterTurn() { return panelController.askFocusAfterTurn },
    get quote() { return quote },
    get applySectionTitle() { return panelController.applySectionTitle },
    get paint() { return panelController.paint },
    get timerScope() { return timerScope },
    get panelOpen() { return panelOpen },
    set panelOpen(value) { panelOpen = value },
    get historyList() { return historyList },
    get historyButton() { return historyButton },
    get panelLayoutRect() { return panelController.panelLayoutRect },
    get setStatus() { return panelController.setStatus },
    get showPanel() { return panelController.showPanel },
    get rectOfPill() { return pillController.rectOfPill },
    get refreshFollowRoute() { return settingsController.refreshFollowRoute },
    get syncRouteWatch() { return settingsController.syncRouteWatch },
    get warmModelCatalog() { return modelsController.warmModelCatalog },
    get progressText() { return panelController.progressText },
    get body() { return body },
    get chatLog() { return chatLog },
    get panelInteracting() { return panelController.panelInteracting },
    get clampPanelPosition() { return panelController.clampPanelPosition },
    get clearWaiting() { return conversationController.clearWaiting },
    get showWaiting() { return conversationController.showWaiting },
    get quoteLabelOf() { return quotesController.quoteLabelOf },
    get quoteBrief() { return quotesController.quoteBrief },
    get addQuote() { return quotesController.addQuote },
    get turnLabelOf() { return selectionController.turnLabelOf },
  })
  var conversationController = createConversationController({
    get state() { return state },
    get askBox() { return askBox },
    get keepInsideViewport() { return panelController.keepInsideViewport },
    get askSend() { return askSend },
    get setStatus() { return panelController.setStatus },
    get voice() { return voiceController.voice },
    get cancelVoice() { return voiceController.cancelVoice },
    get renderQuotes() { return quotesController.renderQuotes },
    get resolveQuoteContexts() { return quotesController.resolveQuoteContexts },
    get composeQuestion() { return quotesController.composeQuestion },
    get attachmentsPayload() { return attachController.payload },
    get attachmentsBusy() { return attachController.busy },
    get attachmentsDescribe() { return attachController.describe },
    get clearAttachments() { return attachController.clear },
    get seedHistoryFromExplanation() { return historyController.seedHistoryFromExplanation },
    get syncPanelStage() { return panelController.syncPanelStage },
    get syncExpandCta() { return panelController.syncExpandCta },
    get ensureChatFollow() { return historyController.ensureChatFollow },
    get renderTurns() { return historyController.renderTurns },
    get paintPill() { return pillController.paintPill },
    get timerScope() { return timerScope },
    get clearTransientNotice() { return historyController.clearTransientNotice },
    get chatLog() { return chatLog },
    get saveHistory() { return historyController.saveHistory },
    get askFocusAfterTurn() { return panelController.askFocusAfterTurn },
    get panelOrCurrentSessionId() { return panelController.panelOrCurrentSessionId },
    get currentSurfaceTheme() { return historyController.currentSurfaceTheme },
    get applyToolEvent() { return historyController.applyToolEvent },
    get rememberBadTier() { return modelsController.rememberBadTier },
    get paintModelPill() { return modelsController.paintModelPill },
    get turnsRenderPending() { return turnsRenderPending },
    set turnsRenderPending(value) { turnsRenderPending = value },
    get lastTurnsRenderAt() { return lastTurnsRenderAt },
    set lastTurnsRenderAt(value) { lastTurnsRenderAt = value },
    get STREAM_RENDER_MS() { return STREAM_RENDER_MS },
    get later() { return later },
    get waitList() { return waitList },
    get paint() { return panelController.paint },
    get progressText() { return panelController.progressText },
    get visibleRaw() { return historyController.visibleRaw },
    get cache() { return cache },
    get rafPending() { return rafPending },
    set rafPending(value) { rafPending = value },
    get ensurePanelInsideViewportNow() { return historyController.ensurePanelInsideViewportNow },
    get promoteButton() { return promoteButton },
    get exportTurns() { return quotesController.exportTurns },
    get closePanel() { return panelController.closePanel },
    get ctx() { return ctx },
    get buildPayload() { return panelController.buildPayload },
  })
  var attachController = createAttachController({
    get state() { return state },
    get panel() { return panel },
    get attachBox() { return attachBox },
    get attachNote() { return attachNote },
    get attachInput() { return attachInput },
    get previewImage() { return lightboxController.open },
    get setStatus() { return panelController.setStatus },
    get refreshAskState() { return conversationController.refreshAskState },
  })
  /**
   * 截图提问：⌘⇧X 起一次截图，host 截好后这里画红框、上传、放进输入框或卡片。
   */
  var shotController = createShotController({
    get document() { return document },
    get window() { return typeof window !== 'undefined' ? window : null },
    get layer() { return layer },
    get state() { return state },
    get panelOpen() { return panelOpen },
    get addFiles() { return attachController.addFiles },
    get attachEnsureUploaded() { return attachController.ensureUploaded },
    get focusAskBox() { return panelController.focusAskBox },
    get openVCard() { return voiceCardController.openVCard },
    get vcardOpen() { return function () { return voiceCardController.vcardState.open } },
    get vcardElement() { return function () { return voiceCardController.vcard } },
    get closeVCard() { return voiceCardController.closeVCard },
    get ensureLayer() { return ensureLayer },
  })
  var modelsController = createModelsController({
    get state() { return state },
    get modelPillName() { return modelPillName },
    get modelPillTier() { return modelPillTier },
    get modelPill() { return modelPill },
    get paintEffortMapHint() { return settingsController.paintEffortMapHint },
    get panelSessionId() { return panelSessionId },
    get currentSessionId() { return panelController.currentSessionId },
    get panelOrCurrentSessionId() { return panelController.panelOrCurrentSessionId },
    get modelMenu() { return modelMenu },
    get chooseSharedModel() { return settingsController.chooseSharedModel },
    get setStatus() { return panelController.setStatus },
    get chatSlot() { return settingsController.chatSlot },
    get SLOT_ORDER() { return settingsController.SLOT_ORDER },
    get SLOT_LABEL() { return settingsController.SLOT_LABEL },
    get setChatSlot() { return settingsController.setChatSlot },
    get webMode() { return webMode },
    get cellMd() { return cellMd },
    get cellWeb() { return cellWeb },
  })
  var voiceController = createVoiceController({
    get voiceActivityText() { return voiceActivityText },
    get voiceActivity() { return voiceActivity },
    get voiceDot() { return voiceDot },
    get voiceActionSlot() { return voiceActionSlot },
    get captureRow() { return captureRow },
    get askTools() { return askTools },
    get webMode() { return webMode },
    get askSpacer() { return askSpacer },
    get modelPill() { return modelPill },
    get micButton() { return micButton },
    get waveSvg() { return waveSvg },
    get voiceStop() { return voiceStop },
    get voiceCancel() { return voiceCancel },
    get waveBars() { return waveBars },
    get focusAskBox() { return panelController.focusAskBox },
    get askBox() { return askBox },
    get refreshAskState() { return conversationController.refreshAskState },
  })
  quotesController.renderQuotes()

  // 「最近聊过的」是**独立的浮层**（贴面板侧边），不和消息共用一个滚动区
  var historyList = el('div', 'dsh-sel-history')

  historyList.style.display = 'none'

  layer.appendChild(historyList)

  /**
   * 官方槽仅保留不可见的生命周期锚点；界面根由本插件挂到 body。
   * 稳定 ref 避免 React 重渲染时摘挂根节点、丢失输入焦点。
   */
  function syncFullViewLayer() {
    var fullView = !!document.querySelector('[data-dsh-full-view]')
    if (fullView !== layer.hasAttribute('data-full-view')) {
      if (fullView) layer.setAttribute('data-full-view', '')
      else layer.removeAttribute('data-full-view')
    }
  }

  /**
   * 确保浮层还挂在 document.body 上。
   *
   * 为什么要这个：layer 是靠 slot(`shell.overlay`) 挂上去的，而 slot 重渲染时
   * 会把它的子节点（包括我们的 layer）一起摘掉，ref 回调却不会因此再触发一次。
   * 结果就是：框、卡片全都 append 进一个**已经脱离文档**的节点 —— 表现是
   * "按了快捷键什么都没出现"，而且 getBoundingClientRect 全是 0（实测踩到）。
   * 显示任何浮层之前调一下，代价是一次 parentNode 比较。
   */
  function ensureLayer() {
    if (typeof document === 'undefined' || !document.body) return
    if (layer.parentNode !== document.body) document.body.appendChild(layer)
  }

  function mountFloatingLayer(node) {
    if (node) {
      if (layer.parentNode !== document.body) document.body.appendChild(layer)
      syncFullViewLayer()
    } else if (layer.parentNode) layer.parentNode.removeChild(layer)
  }

  var fullViewObserver = null

  if (typeof MutationObserver === 'function') {
    fullViewObserver = new MutationObserver(syncFullViewLayer)
    fullViewObserver.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['data-dsh-full-view']})
  }

  /** 开窗后"还没聚焦过输入框"（见 focusComposerOnce）。 */
  var askFocusPending = false

  /** 调试：最后一次"没聚焦"卡在哪一步（-1 表示聚焦成功）。 */
  /** 调试：最后一次"没聚焦"卡在哪一步（成功时是 'ok'）。自动聚焦这类问题很难从外部看出来。 */
  var focusBail = ''

  var offSlot = null

  if (ctx.slots && typeof ctx.slots.inject === 'function') {
    try {
      offSlot = ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: '@yfwu2020/dsh-selection-explain',
          order: 20,
          label: function () {
            return '划词解读'
          },
        }, function SelectionExplainLayer() {
          return React.createElement('div', {
            className: 'dsh-sel-anchor',
            style: { display: 'none', pointerEvents: 'none' },
            ref: mountFloatingLayer,
          })
        })
      })
    } catch (error) {
      // 槽注册失败仅报错，自有界面根保持未挂载，不影响其他插件。
      console.error('[dsh-selection-explain] shell.overlay 槽注册失败：', error)
    }
  } else {
    console.error('[dsh-selection-explain] slots 服务不可用，划词解读 UI 未挂载')
  }

  var panelOpen = false

  /**
   * **本小窗所属的会话**（划词那一刻所在的那个）。
   *
   * 不能直接用 currentSessionId()：那是"当前正在看的会话"，用户切走之后它立刻变了。
   * 小窗的模型、背景、升格都该按**它自己那个会话**算 ——
   * 否则切到别的会话再打开设置，括号里会报成另一个会话的模型（用户报的问题）。
   */
  var panelSessionId = ''

  var rafPending = false

  /** 流式重绘限速（毫秒）：见 scheduleTurnsRender / schedulePaint。 */
  var STREAM_RENDER_MS = 90

  var turnsRenderPending = false

  var lastTurnsRenderAt = 0

  /** 贴位置的自适应节奏（见 schedulePillPlacer）。 */
  var PILL_POLL_MIN = 2000

  var PILL_POLL_MAX = 60000

  var pillPollDelay = PILL_POLL_MIN

  /**
   * 胶囊的拖动 / 吸附 / 收球状态（几何参数 PILL_* 在文件上方，CSS 也要用）。
   *
   *   · pillDock：'anchor' = 贴费用胶囊（量不到就贴右下角，由 placePill 管）；
   *               'free'   = 用户拖到别处了 —— 位置归用户，轮询不许再动它。
   *   · pillFreeRight：自由摆放时记的是**右边缘**（收球/展开都以右侧为锚点：
   *     胶囊向左展开、向右收成球，右边缘一个像素都不动 —— 用户要的就是这个）。
   *     记中心是不行的：收球时右边缘会往左跑，球看起来"飘"了一下。
   *   · pillAnchorWidth：本次量到的费用胶囊宽度（0 = 没量到）—— 决定"跟随"还是"兜底"，
   *     也是"能不能收球"的前提（用户定的：只有没有费用胶囊时才收成小球）。
   */
  /** 胶囊总开关：host 的 pillEnabled 说关就关（见下面 ping 分支）。 */
  var pillHidden = false

  var pillDock = 'anchor'

  var pillFreeRight = null

  var pillBall = false

  var pillHover = false

  var pillDrag = null

  /** 刚拖完的那一下 click 要吞掉（拖动不该顺手开关小窗）。 */
  var pillDragMoved = false

  /** 静置计时器 id（0 = 没有）。用裸 setTimeout：它每帧都可能被重置，塞进 timers 数组会一直长。 */
  var pillIdleId = 0

  /**
   * 吸附滑行窗口的截止时刻（见 settlePillDrop / placePill）：
   * 这段时间内位置按 left/top 维持（能过渡），之后再交还给 right/bottom 的稳态定位。
   */
  var pillSnapUntil = 0

  var pillAnchorWidth = 0

  var pillPlacerId = 0

  /** 上一次量到的费用胶囊容器 / 正在观察它的 ResizeObserver（浏览器没有这个 API 时为 null）。 */
  var pillHost = null

  var pillWatched = null

  var pillObserver = null

  /** 正在显示的等待特效（每个容器一条；同处同文案复用节点，避免重建打断动画）。 */
  var waitList = []

  function later(fn, ms) {
    return timerScope.later(fn, ms)
  }

  /**
   * 帧内桥报过来的选区：换算坐标 → 复用同一套浮标与面板。
   *
   * 只认"我们桥过的帧"发来的消息（`frameBySource`）。
   * 小窗开着时它走**引用**那条路（划侧边栏网页里的文字，同样能挂进输入框）；
   * 小窗关着时才是「✦ 解读」（要划新词开新窗，先按 Esc 收起当前这扇）。
   */
  var offBridgeMessage = listen(window, 'message', function (event) {
    var data = event && event.data
    if (!previewController.bridgeOn || !data || data.__dshSel !== 1) return
    var frame = previewController.frameBySource(event.source)
    if (!frame) return
    // 这条消息本身就是"用户此刻正在那个网页里"的证据（见 hasFocusEvidence）
    previewController.frameTouchedAt.set(frame, Date.now())
    if (data.kind === 'press') {
      // 帧内按下：与主会话一致——先收浮标。父页面收不到帧内的 mousedown，
      // 少了这一条，在网页里点一下（取消选区、点别处、点另一个网页）浮标就赖着不走。
      if (state.selection && state.selection.source === 'iframe' && state.selection.frame !== frame) {
        // 点的是**另一个**帧：那条选区已经不是用户此刻在看的了，连状态一起清
        state.selection = null
        state.bridgeActive = false
      }
      selectionController.hideButton()
      voiceCardController.hideQuoteButton()
      // 卡片开着时同理要收卡片（与主会话"点别处就收卡"同一条规则：那边靠 document 上的
      // mousedown，帧内的点击父页面收不到）。suppress 也要置上，否则下一拍轮询发现
      // "还在录"会把卡片又弹回来 —— Esc 那条路同样是这么处理的。
      if (voiceCardController.vcardState.open && state.selection && state.selection.frame === frame) {
        voiceCardController.vcardState.suppress = true
        voiceCardController.closeVCard(true)
      }
      return
    }
    if (data.kind === 'clear') {
      if (state.selection && state.selection.frame === frame) {
        state.bridgeActive = false
        // ⚠️ 卡片开着时**不清选区**：抢焦点必然让帧内选区塌掉（输入法上屏要的正是焦点），
        // 桥于是报 clear —— 但用户选的那段文字仍然是这一轮的解读对象（发送时要用它，
        // 麦克风轮询也要靠 state.selection 判断"说完了没有"）。
        // 本文档那条路是一致的：顶层选区被抢焦点搞塌时也只收浮标，不清 state.selection。
        if (!voiceCardController.vcardState.open) state.selection = null
        selectionController.hideButton()
        voiceCardController.hideQuoteButton()
      }
      return
    }
    if (data.kind !== 'selection' || !data.sel) return
    if (!frame.isConnected) return
    var text = String(data.sel.text || '')
    if (!text.trim() || text.length > preferences.maxSelectionChars) return
    var rect = previewController.mapFrameRect(frame, data.sel.rect)
    if (!rect) {
      // 选区滚出帧的可视区：把浮标收掉（帧内再滚回来会重新报）
      if (state.selection && state.selection.frame === frame) {
        selectionController.hideButton()
        voiceCardController.hideQuoteButton()
      }
      return
    }
    state.selection = {
      text: text.trim(),
      /** 'document'（顶层选区，缺省）| 'iframe'（侧边栏网页，上下文由帧内桥给）。 */
      source: 'iframe',
      frame: frame,
      rect: rect,
      frameRect: data.sel.rect,
      context: String(data.sel.context || ''),
      keyContext: String(data.sel.keyContext || ''),
      label: previewController.labelForFrame(frame, data.sel.label),
    }
    state.bridgeActive = true
    // 卡片开着时，帧内的重报（滚动 / 改尺寸 / 挪选区）只是"那段文字动了"：
    // 跟着挪卡片与锚点，**不要**再浮出浮标（浮标与卡片是互斥的两态）。
    if (voiceCardController.vcardState.open) {
      if (state.selection.frame === frame) {
        voiceCardController.vcardState.anchorRect = rect
        voiceCardController.repositionVCard()
        return
      }
      // 另一帧报了新选区：这张卡已经不是用户在看的东西了，收掉再按新选区走
      voiceCardController.closeVCard(true)
    }
    if (panelOpen) {
      // 小窗开着：帧内这条选区也只是"一段可以引用的文字"（上下文由帧内的桥给）
      state.quoteSelection = {
        text: text.trim(),
        label: state.selection.label || '侧边栏网页',
        source: 'iframe',
        rect: rect,
        context: String(state.selection.context || ''),
        turnIndex: -1,
      }
      selectionController.showQuoteButton(rect)
      return
    }
    selectionController.showButton(rect)
  })

  // 侧边栏里的预览帧是宿主 React 渲染的：新开标签、切预览/源码、文件变了都会换帧，
  // 所以既要初始扫一遍，也要盯着 DOM（只盯 srcdoc/src 两个属性 + 子节点增删）。
  if (typeof MutationObserver === 'function') {
    previewController.bridgeObserver = new MutationObserver(previewController.scheduleBridgeScan)
    previewController.bridgeObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['srcdoc', 'src'],
    })
  }

  previewController.scheduleBridgeScan()

  // —— 事件 ——

  // 动画结束就摘掉动效类：`.dsh-sel-btn-pop` 用了 fill:both，
  // 不摘的话 transform 会一直被动画钉在 none 上，`:active` 的按压缩放就永远不生效
  var offPopEnd = listen(button, 'animationend', function () {
    selectionController.setButtonPop(false)
  })

  var offQuotePopEnd = listen(quoteButton, 'animationend', function () {
    selectionController.setQuotePop(false)
  })

  /**
   * 鼠标是不是按着（拖拽划词进行中）—— 记的是"按下那一刻"。
   *
   * 为什么记时刻而不是记一个布尔：松手落在浏览器窗口外时**不会补发 mouseup**，
   * 布尔一旦卡在 true，`selectionchange` 就被永久忽略 —— 浮标从此再也不会自己收了。
   * 超过 SELECT_PRESS_STALE_MS 就当已经松开（帧内那条桥用的是同一个兜底，见 bridgeBody）。
   *
   * 拖拽期间一律不查选区：时机要和"松手才弹浮标"一致，否则拖到一半浮标就冒出来，
   * 还跟着手指跑。
   */
  var SELECT_PRESS_STALE_MS = 6000

  var selectPressedAt = 0

  function selectPressing() {
    return selectPressedAt > 0 && Date.now() - selectPressedAt < SELECT_PRESS_STALE_MS
  }

  var offMouseUp = listen(document, 'mouseup', function (event) {
    selectPressedAt = 0
    // 面板里的 mouseup **也要走一次检查**：小窗开着时"划小窗正文"正是「引用」的主入口
    // （早先这里对面板直接 return —— 那是"面板里划词一律不管"年代的写法，
    //  结果就是小窗里划词毫无反应，只有气泡末尾的「引用整条」能用）。
    if (button.contains(event.target) || quoteButton.contains(event.target)) return
    selectionController.scheduleCheck()
  }, true)

  var offKeyUp = listen(document, 'keyup', function (event) {
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Meta' || event.key.indexOf('Arrow') === 0) {
      selectionController.scheduleCheck()
    }
  }, true)

  /**
   * 选中的文字**没了** → 浮标跟着消失。
   *
   * 为什么非要有这一条：浮标只在 mouseup 和少数几个键的 keyup 之后被检查，
   * 而"把选中的字删掉"这两种动作都不在那条路径上 ——
   *   · Backspace / Delete / 直接打字覆盖 / 剪切 / 撤回（⌘Z）；
   *   · 内容刷新把选中的节点整个换掉（流式回答重渲染、消息重画）。
   * 于是浮标赖在屏幕上不走，点下去还会解读一段**屏幕上已经不存在**的文字（用户报的正是这个）。
   *
   * `selectionchange` 是浏览器对"选区变了"最权威的信号（塌陷 / 被删 / 被程序改动都会发），
   * 用它兜住所有非鼠标路径；节点被摘掉但选区没塌陷那种（Firefox）另有 selectionDetached 判死。
   */
  var offSelectionChange = listen(document, 'selectionchange', function () {
    if (selectPressing()) return
    selectionController.scheduleCheck()
  }, true)

  /**
   * Esc 收语音卡。
   *
   * 用 capture 抢在最前面：卡片是当下最内层的东西，Esc 该先退它
   * （小窗那套 Esc 是"从最内层往外退"，这里是同一条规则往外多包一层）。
   * 已经说出来的字**丢掉**：卡还没发出去，取消就是取消；要留着就先点发送。
   */
  var offVoiceEscape = listen(document, 'keydown', function (event) { handleVoiceCardEscape(event, { document: document, vcardState: voiceCardController.vcardState, closeVCard: voiceCardController.closeVCard }) }, true)

  /**
   * 浮标亮着的时候，隔几拍确认一次"那段文字还在不在"。
   *
   * 为什么光有事件还不够：**Chrome 把选中的节点整个摘掉时会悄悄把选区塌陷，却不发
   * `selectionchange`**（真浏览器实测：替换 textContent 后 `rangeCount` 仍是 1、
   * `isCollapsed` 变成 true，而事件计数一个都不涨）。流式回答重渲染 / 消息重画走的正是这条路 ——
   * 只靠事件的话，浮标会一直亮着，点下去解读的是一段屏幕上已经没有的文字。
   *
   * 代价是可控的：**只在浮标可见的那几拍里干活**（它不可见时这一拍立刻返回，
   * 连选区都不读），而且只有发现选区没了/锚点被摘掉时才去排一次检查 ——
   * 正常亮着的那几拍不做任何 DOM 写。
   */
  var FLOAT_WATCH_MS = 400

  function watchFloatLiveness() {
    // 拖拽划词进行中不查：浮标要等松手才出现（与 mouseup 那条路径同一套时机）
    if (selectPressing()) return
    if (button.style.display !== 'inline-flex' && quoteButton.style.display !== 'inline-flex') return
    var selection = window.getSelection && window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      // 帧内那条选区**不在本文档**：点浮标会让本文档的选区塌掉，别把它误当成"文字没了"
      if (state.bridgeActive && state.selection && state.selection.source === 'iframe') return
      selectionController.scheduleCheck()
      return
    }
    var range = null
    try {
      range = selection.getRangeAt(0)
    } catch (error) {
      return
    }
    // 选区没塌陷、锚点却被摘掉了（Firefox 的行为）：也当"文字没了"
    if (selectionDetached(range)) selectionController.scheduleCheck()
  }

  var floatWatchId = setInterval(watchFloatLiveness, FLOAT_WATCH_MS)

  var offMouseDown = listen(document, 'mousedown', function (event) {
    selectPressedAt = Date.now()
    var target = event.target
    // 模型菜单：点它自己和胶囊之外**任何地方**都收起。
    // 必须放在最前面 —— 下面的 historyButton / pill / panel 分支都会 return，
    // 放在后面就会被短路掉（实测：点了别处菜单不关）。
    if (modelMenu.getAttribute('data-open') === '1' && !modelMenu.contains(target) && !modelPill.contains(target)) {
      modelsController.closeModelMenu()
    }
    if (historyList.contains(target)) return // 列表内部：行自己处理
    if (historyButton.contains(target)) return // 「最近」开关自己 toggle
    if (button.contains(target)) return // 浮标
    if (quoteButton.contains(target)) return // 引用浮标：点它不能先把自己收掉
    // 状态胶囊：它自己就是开关，点它的 mousedown 不能被当成"点了外面"（否则先关后开，看着像没反应）
    if (pill.contains(target)) return
    // 到这里说明点的不是侧边栏本身：**含面板正文**（消息区/输入框/选中文字）在内，
    // 一律先把侧边栏收回——它是用完就走的导航，不该等你点了"外面"才收。
    historyController.hideHistoryList()
    if (panel.contains(target)) return // 面板内的点击只收侧边栏，不关面板
    selectionController.hideButton()
    voiceCardController.hideQuoteButton()
    // 点面板外**不关小窗**（无论有没有追问过）：答案留在原地，只有 ✕ / Esc / 胶囊能收。
    // 曾经的规则是"没追问过才关"，但那会让用户在读第一屏翻译时被误关（点一下别处就没了）。
  }, true)

  // 让按钮吞掉 mousedown：点击时不破坏选区高亮
  var offButtonDown = listen(button, 'mousedown', function (event) {
    event.preventDefault()
    event.stopPropagation()
  })

  var offButtonClick = listen(button, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    var selection = state.selection
    if (selection) panelController.openForSelection(selection)
  })

  // 引用浮标：吞掉 mousedown（点了不能把选区打散、也不能让面板失焦），
  // 点一下 = 把这段文字挂进输入框的引用区，然后自己收起来（"已经进去了"的信号）
  var offQuoteDown = listen(quoteButton, 'mousedown', function (event) {
    event.preventDefault()
    event.stopPropagation()
  })

  var offQuoteClick = listen(quoteButton, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    var selection = state.quoteSelection
    if (!selection) return
    // 上下文在这里才采：引用**当时**在哪一段对话里，是这条引用最有用的信息
    quotesController.addQuote(selection.text, selection.label, quotesController.quoteContextFor(selection))
    voiceCardController.hideQuoteButton()
  })

  var offScroll = listen(window, 'scroll', function (event) {
    selectionController.hideButton()
    voiceCardController.hideQuoteButton()
    // 页面/面板滚动也收回侧边栏；滚动列表自身不算（它有自己的滚动条）。
    // event.target 不一定是 Node（合成事件可能是 window），contains 会抛，得自己挡一道
    var target = event && event.target
    var insideList = !!(target && target.nodeType && historyList.contains(target))
    if (historyList.style.display === 'flex' && !insideList) historyController.hideHistoryList()
  }, true)

  var offModelPill = listen(modelPill, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    modelsController.modelPillClicks += 1
    if (modelMenu.getAttribute('data-open') === '1') modelsController.closeModelMenu()
    else modelsController.openModelMenu()
  })

  var offModelMenu = listen(modelMenu, 'click', function (event) {
    event.stopPropagation() // 菜单内部点击不要触发"点到外面"
  })

  var offModelKeys = listen(modelMenu, 'keydown', function (event) {
    if (event.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]')) modelsController.closeModelMenu()
  })

  state.webAnswer = modelsController.readWebMode()

  modelsController.paintWebMode()

  // 模型/档位：从 localStorage 恢复；没存过就跟随"当前路由 + 配置档位"（ping 里就有）
  // 从 host 的统一设置恢复模型，不读取旧浏览器模型覆盖。
  settingsController.loadSettings(false)

  // 「追问」档位不再有浏览器本地覆盖：设置页那一行、小窗那四个格子、发出去的请求
  // 读的都是同一份配置（chatReasoningEffort，加载完由 applyServerValues 同步进 state.effort）
  modelsController.paintModelPill()

  fetch(PING + (panelController.currentSessionId() ? '?sessionId=' + encodeURIComponent(panelController.currentSessionId()) : ''), {
    headers: { accept: 'application/json' },
  })
    .then(function (response) {
      return response.json()
    })
    .then(function (data) {
      modelsController.modelCatalog.current = (data && data.route) || null
      modelsController.modelCatalog.stages = { chat: (data && data.reasoningEffortByStage && data.reasoningEffortByStage.chat) || '' }
      if (!settingsController.settingsSpec && data && data.limits) settingsController.applySelectionLimit(data.limits)
      // 侧边栏网页划词桥的总开关（host 配置 bridgeSidebarPreview，默认开）
      if (data && data.bridgeSidebarPreview === false) previewController.bridgeOn = false
      // 悬浮胶囊的两个偏好跟着 ping 一起下发（省得为它单开一次请求）。
      // 拿不到就保持默认（显示 + 10 秒收球）—— ping 失败不该让胶囊消失。
      if (data && data.pill) settingsController.applyPillPrefs(data.pill)
      modelsController.paintModelPill()
      return null
    })
    .catch(function () {
      /* ping 失败不影响使用：胶囊显示默认文案 */
    })

  // 点哪一格就选哪一格（不再"点一下翻转"）——分段控件的标准行为
  var offCellMd = listen(cellMd, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    modelsController.setPref(false)
  })

  var offCellWeb = listen(cellWeb, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    modelsController.setPref(true)
  })

  // 键盘：左右方向键在两格间切换（radiogroup 惯例；Enter/Space 由 button 原生支持）
  var offPrefKeys = listen(prefSeg, 'keydown', function (event) {
    var key = event && event.key
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
    event.preventDefault()
    modelsController.setPref(key === 'ArrowRight', true)
  })

  var offPillDown = listen(pill, 'mousedown', function (event) {
    // 拖拽/划词的手势不该被胶囊接走
    event.preventDefault()
    event.stopPropagation()
    pillController.beginPillDrag(event)
  })

  var offPillClick = listen(pill, 'click', function (event) {
    event.preventDefault()
    event.stopPropagation()
    // 刚拖完的那一下不算点击（否则拖到别处会顺手把抽屉开开关关）
    if (pillDragMoved) {
      pillDragMoved = false
      return
    }
    pillController.reopenLast()
    pillController.notePillActivity()
  })

  // 鼠标停在上面就不收球（要"点得到"，不是"藏起来"）；离开时重新开始静置计时
  var offPillEnter = listen(pill, 'mouseenter', function () {
    pillHover = true
    pillController.notePillActivity()
  })

  var offPillLeave = listen(pill, 'mouseleave', function () {
    pillHover = false
    pillController.notePillActivity()
  })

  var offPillKey = listen(pill, 'keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    pillController.reopenLast()
    pillController.notePillActivity()
  })

  /**
   * 预览页把自身高度报过来（见 adaptPreviewHtml 注入的 hook）→ 直接长到内容那么高，
   * 框里就不会出现那条碍眼的滚动条；超过上限才回落成内部滚动（上限跟着面板可视高度走）。
   */
  var offPreviewHeight = listen(window, 'message', function (event) {
    var data = event && event.data
    // 用真值判断而不是 `!== true`：注入端发过 1（数字），严格相等会把自家消息挡掉（实测踩过）
    if (!data || !data.__dshPreview) return
    var item = previewFrames[String(data.id || '')]
    if (!item || !item.frame) return
    var frame = item.frame
    try {
      // 只认这一帧发来的（消息可以被任意页面伪造，来源必须对得上）
      if (frame.contentWindow && event.source !== frame.contentWindow) return
    } catch (error) {
      return
    }
    var reported = Math.max(140, Number(data.h) || 0)
    if (!reported) return
    var current = Number(frame.getAttribute('data-preview-h')) || 0
    if (Math.abs(reported - current) < 4) return
    frame.setAttribute('data-preview-h', String(reported))
    // 全量模式：直接长到内容高度（内部不滚动）；还原模式：清掉 inline 高度，用 CSS 的 320px
    applyPreviewHeight(frame, frame.parentNode && frame.parentNode.parentNode)
  })

  // 费用胶囊的位置/尺寸会变（展开、缩放、数字变长、插件迟到挂载）→ 自适应频率地贴上去
  pillController.loadPillPos()
   // 先问一句上次拖到哪儿（异步，回来再摆）
  panelController.loadPanelSize()
   // 小窗的尺寸也问一句（拖角改过之后才有的值；位置不记）
  pillController.placePill()

  pillController.ensureResizeWatch()

  pillController.schedulePillPlacer()

  pillController.paintPill()

  // 过渡要等"第一帧已经贴好位置"之后再打开：否则挂载那一下会从 CSS 默认的 bottom:64
  // 一路滑到实测位置（右下角看着像自己飞过去）
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function () {
      pill.setAttribute('data-ready', '1')
    })
  } else {
    pill.setAttribute('data-ready', '1')
  }

  var offResize = listen(window, 'resize', function () {
    selectionController.hideButton()
    voiceCardController.hideQuoteButton()
    // 宽度变了 → 换行位置变了 → 输入框高度要重量（否则会是按旧宽度算出来的高度）
    conversationController.autoGrowAskBox()
    // 拖窗口变小后，面板本身也要拉回视口内（否则历史列表会跟着算到屏幕外）
    panelController.keepInsideViewport()
    if (historyList.style.display === 'flex') historyController.placeHistoryList()
    // 窗口尺寸变了：立刻量一次，并把节奏调回最快
    pillController.placePill()
    pillPollDelay = PILL_POLL_MIN
  })

  var offKeyDown = listen(document, 'keydown', function (event) { handlePanelEscape(event, { document: document, panelOpen: panelOpen, panel: panel, historyList: historyList, captureRow: captureRow, settingsOpen: settingsController.settingsOpen, settingsByKey: settingsController.settingsByKey, closeModelPicks: settingsController.closeModelPicks, closeSettings: settingsController.closeSettings, cancelVoice: voiceController.cancelVoice, closePanel: panelController.closePanel }) }, true)

  var offSettingsOpen = listen(settingsButton, 'click', function (event) {
    event.stopPropagation()
    if (settingsController.settingsOpen) settingsController.closeSettings()
    else settingsController.openSettings()
  })

  var offSettingsBack = listen(settingsBack, 'click', function (event) {
    event.stopPropagation()
    settingsController.closeSettings()
  })

  var offSettingsClose = listen(settingsClose, 'click', function (event) {
    event.stopPropagation()
    settingsController.closeSettings()
  })

  var offSettingsReset = listen(settingsReset, 'click', function (event) {
    event.stopPropagation()
    settingsController.resetSettings()
  })

  // 抽屉里不该触发起拖面板 / 划词：整个抽屉吞掉 mousedown 的冒泡
  var offSettingsStop = listen(settingsSheet, 'mousedown', function (event) {
    event.stopPropagation()
  })

  // 点抽屉里的空白处（正文 / 分类栏）把模型下拉收掉 —— 点菜单内部不会走到这里（行自己 stopPropagation）
  var offSettingsPickAway = listen(settingsSheet, 'click', function () {
    settingsController.closeModelPicks()
  })

  var offSettingsScrim = listen(settingsScrim, 'click', function (event) {
    event.stopPropagation()
    settingsController.closeSettings()
  })

  var offHistory = listen(historyButton, 'click', function (event) {
    event.stopPropagation()
    historyController.toggleHistoryList()
  })

  var offPromote = listen(promoteButton, 'click', function (event) {
    event.stopPropagation()
    conversationController.promote()
  })

  var offRetry = listen(retryButton, 'click', function (event) {
    event.stopPropagation()
    conversationController.regenerate()
  })

  var offExpand = listen(expandButton, 'click', function (event) {
    event.stopPropagation()
    conversationController.expandDetail()
  })

  var offAskKey = listen(askBox, 'keydown', function (event) {
    if (event.key !== 'Enter' || event.shiftKey) return
    // 输入法（中文/日文…）在组合期间按 Enter 是"确认候选词"，不是发送：
    // 这时 askBox.value 往往还是空的，照发会清空输入框 + 发空内容 → 看起来"没反应"
    if (event.isComposing === true || event.keyCode === 229) return
    event.preventDefault()
    event.stopPropagation()
    var question = askBox.value
    // 空输入框照发**只在挂了引用或附件时**成立（引用/附件本身就是用户要送出去的内容）
    if (!question.trim() && state.quotes.length === 0 && state.attachments.length === 0) return
    // 清空交给 ask()：它收下才清（生成中被拒时保留你打的字）
    conversationController.ask(question)
  })

  var offAskInput = listen(askBox, 'input', function () {
    conversationController.refreshAskState()
  })

  var offAskSend = listen(askSend, 'click', function (event) {
    event.stopPropagation()
    if (conversationController.isGenerating()) {
      conversationController.stopCurrent()
      return
    }
    var question = askBox.value
    if (!question.trim() && state.quotes.length === 0 && state.attachments.length === 0) return
    // 清空交给 ask()：它收下才清
    conversationController.ask(question)
  })

  // ── 附件：三个入口（＋ / 粘贴 / 拖放）──
  var offAttachPick = listen(attachInput, 'change', function () {
    attachController.addFiles(attachInput.files || [])
    // 清掉 value：同一个文件连选两次也要能触发 change（不清的话第二次选它毫无反应）
    attachInput.value = ''
  })

  var offAttachButton = listen(addButton, 'click', function (event) {
    event.stopPropagation()
    attachController.pick()
  })

  // 粘贴挂在**面板**上而不是输入框上：截图之后很多人不会先把光标点进输入框。
  // 纯文本粘贴不受影响（handlePaste 只在剪贴板里真有文件时才拦）。
  var offAttachPaste = listen(panel, 'paste', function (event) {
    attachController.handlePaste(event)
  })

  attachController.wireDrop()

  var offMic = listen(micButton, 'click', function (event) {
    event.stopPropagation()
    voiceController.startVoice()
  })

  // 切走这个窗口（换到别的 App）就停止录音 —— 主会话也是这么做的：
  // 人已经不在说话了，继续占着麦克风只会录一串环境噪音。识别**不打断**（那时音频已经拿到了）。
  var offVoiceBlur = listen(window, 'blur', function () {
    if (voiceController.voice.phase === 'recording') voiceController.cancelVoice()
  })

  var offVoiceCancel = listen(voiceCancel, 'click', function (event) {
    event.stopPropagation()
    // feedback 阶段点 ✕ 只是"关掉这条提示"，其余阶段是取消这次录音/识别。
    // 取消**不删字**：已经说出来的（含半句预览）一律留在输入框里。
    voiceController.cancelVoice()
  })

  var offVoiceStop = listen(voiceStop, 'click', function (event) {
    event.stopPropagation()
    voiceController.finishVoice()
  })

  voiceController.paintVoice()

  // ═════════════════════════ 语音输入（结束） ═════════════════════════

  // 用户自己滚消息区（滚轮/触摸）→ 不再强行把他拉回底部
  var offBodyWheel = listen(body, 'wheel', historyController.noteUserScroll)

  var offBodyTouch = listen(body, 'touchmove', historyController.noteUserScroll)

  var offBodyScroll = listen(body, 'scroll', historyController.noteBodyScroll)

  var offClose = listen(closeButton, 'click', function (event) {
    event.stopPropagation()
    panelController.closePanel()
  })

  var offDrag = listen(head, 'mousedown', function (event) {
    if (promoteButton.contains(event.target) || closeButton.contains(event.target)) return
    if (settingsButton.contains(event.target) || historyButton.contains(event.target)) return
    event.preventDefault()
    var rect = panelController.panelLayoutRect()
    var offsetX = event.clientX - rect.left
    var offsetY = event.clientY - rect.top
    panelController.panelInteracting = true
    var move = function (moveEvent) {
      panel.style.left = clamp(moveEvent.clientX - offsetX, 4, window.innerWidth - rect.width - 4) + 'px'
      panel.style.top = clamp(moveEvent.clientY - offsetY, 4, window.innerHeight - 40) + 'px'
      if (historyList.style.display === 'flex') historyController.placeHistoryList()
    }
    var up = function () {
      window.removeEventListener('mousemove', move, true)
      window.removeEventListener('mouseup', up, true)
      panelController.panelInteracting = false
      // **不存位置**：拖动只对这一次有效；下次开窗仍按选区重新锚定。
    }
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mouseup', up, true)
  })

  historyController.ensurePanelInsideViewport()

  panelController.bindResizeGrip(gripCorner, 'se')

  panelController.bindResizeGrip(gripRight, 'e')

  panelController.bindResizeGrip(gripBottom, 's')

  // 窗口变小：把**尺寸**夹回可视区（位置不归这里管 —— 它由 showPanel 的锚定决定）
  var offPanelResize = listen(window, 'resize', function () {
    if (!panelController.panelSize || panelController.panelInteracting) return
    var next = panelController.clampPanelSize({ w: panelController.panelSize.w, h: panelController.panelSize.h })
    if (next.w === panelController.panelSize.w && next.h === panelController.panelSize.h) return
    panelController.panelSize = next
    panelController.applyPanelSizeOnOpen()
    panelController.clampPanelPosition()
    panelController.savePanelSize()
  })

  // —— 调试钩子（自动化验证用） ——
  window.__dshSelectionExplain = {
    /** 截图提问的状态（调试/自动化）。 */
    shot: function () {
      return shotController.state()
    },
    /** 手动起一次截图（等同按 ⌘⇧X）。 */
    shotStart: function () {
      shotController.capture()
      return true
    },
    /**
     * 语音卡（选中文字 + 输入法正在语音输入 → 就地追问）的状态。
     * 给自动化验证用：能不能弹、有没有焦点、几何对不对，全在这里读。
     */
    voiceCard: function () {
      return {
        open: voiceCardController.vcardState.open,
        closing: voiceCardController.vcardState.closing,
        watching: !!voiceCardController.vcardState.timer,
        /** 正在等文字定稿（松手后输入法还会智能整理）；settleFor = 距上次文字变化多久（毫秒）。 */
        settling: !!voiceCardController.vcardState.settleTimer,
        settleFor: voiceCardController.vcardState.settleStableAt ? Date.now() - voiceCardController.vcardState.settleStableAt : -1,
        voiced: !!(voiceCardController.vcard && voiceCardController.vcard.getAttribute('data-voiced') === '1'),
        hasText: !!(voiceCardController.vcard && voiceCardController.vcard.getAttribute('data-text') === '1'),
        text: voiceCardController.vcardBox ? voiceCardController.vcardBox.value : '',
        focused: !!(voiceCardController.vcardBox && document.activeElement === voiceCardController.vcardBox),
        geometry: voiceCardController.vcard
          ? {
              left: voiceCardController.vcard.style.left,
              top: voiceCardController.vcard.style.top,
              width: voiceCardController.vcard.style.width,
              height: voiceCardController.vcard.style.height,
            }
          : null,
      }
    },
    /** 手工把卡打开/收起/发送（测试与调试用；正常路径由麦克风轮询驱动）。 */
    /** 调试：最后一次自动聚焦卡在哪一步。 */
    focusBail: function () {
      return focusBail
    },
    /** 重新拉一次设置（测试用：设置只在启动时读一次，桩里改完值要能刷新）。 */
    reloadSettings: function () {
      settingsController.loadSettings(true)
      return Object.assign({}, settingsController.settingsLive)
    },
    voiceCardOpen: function () {
      voiceCardController.openVCard()
      return window.__dshSelectionExplain.voiceCard()
    },
    voiceCardClose: function () {
      voiceCardController.closeVCard()
      return window.__dshSelectionExplain.voiceCard()
    },
    voiceCardSend: function (text) {
      if (voiceCardController.vcardBox && text !== undefined) {
        voiceCardController.vcardBox.value = String(text)
        voiceCardController.syncVCardText()
      }
      voiceCardController.sendVCard()
      return true
    },
    /** 重新读一次 host 上的小窗尺寸（测试用；正常路径只在挂载时读一次）。 */
    loadPanelSize: function () {
      panelController.panelSizeAsked = false
      panelController.loadPanelSize()
      return true
    },
    /** 当前小窗几何（测试用：直接读渲染值，不经过变量）。 */
    panelGeom: function () {
      var rect = panelController.panelLayoutRect()
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height, resized: panel.getAttribute('data-resized') === '1' }
    },
    /** 重新读一次 host 上的胶囊位置（测试用；正常路径只在挂载时读一次）。 */
    loadPillPos: function () {
      pillController.pillPosAsked = false
      pillController.pillUserPlaced = false // 测试要确定性地验"读回来"这条路径
      pillController.loadPillPos()
      return true
    },
    /** 球心图形在进度 p 处的 path（p 可略越界）—— 测试按它核对整条形变轨迹。 */
    pillStarAt: function (p) {
      return pillController.pillStarPathAt(p)
    },
    /** 当前进度与目标（测试核对收/放确实把图形推向了正确的一端）。 */
    pillStarProgress: function () {
      return pillController.pillStarP
    },
    pillStarTarget: function () {
      return pillController.pillStarTargetP
    },
    /** 形变动画被起跑了几次 + 目标序列（诊断用：一直重新起跑就永远到不了终点）。 */
    pillStarStarts: function () {
      return pillController.pillStarStarts
    },
    pillStarLog: function () {
      return pillController.pillStarLog
    },
    /** 直接跑一次形变动画（与胶囊状态解耦）：测试用它确定性地验"计时器在推进"。 */
    pillStarAnimate: function (to) {
      pillController.animatePillStar(to ? 1 : 0)
      return true
    },
    /** 同步画到某个进度（几何断言/截图用，绕开计时器与异步活动）。 */
    pillStarTo: function (p) {
      if (pillController.pillStarTimer) {
        clearTimeout(pillController.pillStarTimer)
        pillController.pillStarTimer = 0
      }
      pillController.pillStarTargetP = p
      pillController.paintPillStar(p)
      return true
    },
    pillStarEaseAt: function (x) {
      return pillController.pillStarEase(x)
    },
    /** JS 那条时长（毫秒）—— 测试核对它与 CSS 那条 .28s 是否同拍。 */
    pillMorphMs: function () {
      return PILL_MORPH_MS
    },
    /** 球心里那两条 path（圆点态 / 星芒态）—— 自检与截图模式用它，避免在测试里抄一遍几何。 */
    pillStarD: function () {
      return PILL_STAR_D
    },
    pillStarDotD: function () {
      return PILL_STAR_DOT_D
    },
    open: function (text, context, label, keyContext) {
      state.selection = { text: text, range: null, rect: null }
      // 和真实划词完全同一条路径（含本地缓存命中）；keyContext 省略时与 context 相同
      panelController.openPanelWith(text, context || '', label || '调试', null, keyContext)
      return true
    },
    expand: function () {
      conversationController.expandDetail()
      return true
    },
    parts: function () {
      return { ...state.parts, stage: state.stage }
    },
    promote: function () {
      conversationController.promote()
      return true
    },
    ask: function (question) {
      conversationController.ask(question)
      return true
    },
    turns: function () {
      return state.turns.slice()
    },
    memory: function () {
      return { cacheEntries: cache.size, cacheTextBytes: cache.textBytes,
        timers: timerScope.size, previewFrames: Object.keys(previewFrames).length }
    },
    /** 自检用：当前待发送的引用（引用区里那几张卡片）。 */
    quotes: function () {
      return state.quotes.map(function (quote) {
        return {
          id: quote.id,
          label: quote.label,
          text: quote.text,
          context: quote.context || '',
          contextChars: (quote.context || '').length,
          session: quote.session === true,
        }
      })
    },
    /** 自检用：手工加一段引用（等价于点了「❝ 引用」/「引用整条」）。 */
    quote: function (text, label, extra) {
      return quotesController.addQuote(text, label || '调试', extra || {})
    },
    /** 自检用：某个节点上的选区会被标成什么出处（等价于点引用那一刻算出来的那个）。 */
    quoteLabel: function (node) {
      return node ? selectionController.panelSourceLabel(node) : '（需要传节点）'
    },
    /** 自检用：引用 + 提问拼出来的那条消息原文（发给模型的就是它）。 */
    compose: function (quotes, question) {
      return quotesController.composeQuestion(quotes || state.quotes, question)
    },
    /** 自检用：引用浮标与最近一次可引用选区的状态。 */
    quoteState: function () {
      return {
        visible: quoteButton.style.display === 'inline-flex',
        selection: state.quoteSelection
          ? {
              text: state.quoteSelection.text,
              label: state.quoteSelection.label,
              source: state.quoteSelection.source,
              turnIndex: state.quoteSelection.turnIndex === undefined ? -1 : state.quoteSelection.turnIndex,
              hasRange: !!state.quoteSelection.range,
            }
          : null,
        panelOpen: panelOpen,
        resolving: state.resolvingQuotes === true,
      }
    },
    /** 自检用：引用浮标的节点（无头环境里页面可能挂了两棵树，用这个拿真正带监听的那个）。 */
    quoteNode: function () {
      return quoteButton
    },
    close: panelController.closePanel,
    /**
     * 自检用：语音输入的状态（阶段 / 提示 / 目录 / 最近一次转写）。
     * phase：idle / requesting / recording / transcribing / done
     */
    voice: function () {
      return {
        phase: voiceController.voice.phase,
        supported: recordingSupported(),
        /** 录音行出来了没有（出来了 = 工具行换成了 ✕ / 波形 / ■ 那一套）。 */
        capture: captureRow.getAttribute('data-show') === '1',
        /** 状态文案（请允许使用麦克风… / 识别中… / 出错原因）。 */
        activity: voiceActivityText.textContent,
        activityTone: voiceActivity.getAttribute('data-tone') || '',
        dot: voiceDot.style.display !== 'none',
        waveform: waveSvg.style.display !== 'none',
        stop: voiceStop.style.display !== 'none',
        /** 行内动作：'prepare'（准备模型）/ 'retry'（🎤 重录）/ ''。 */
        action: voiceController.voice.action || '',
        maxSeconds: voiceController.voice.maxSeconds || VOICE_FALLBACK_SECONDS,
        level: Number(voiceController.voice.level.toFixed(3)),
        lastText: voiceController.voice.lastText,
        /** 波形 80 根线的高度（自检/冒烟用：静音时全是 2px 的基线）。 */
        bars: waveBars.map(function (bar) {
          return Number(bar.node.getAttribute('y2')) - Number(bar.node.getAttribute('y1'))
        }),
        /** 实时字幕：定稿 / 半句预览 / 拍数 / 有没有被整段识别改写过。 */
        live: {
          active: voiceController.voice.live.active,
          disabled: voiceController.voice.live.disabled,
          reason: voiceController.voice.live.reason,
          committed: voiceController.voice.live.committed,
          preview: voiceController.voice.live.preview,
          text: voiceController.voice.live.text,
          passes: { preview: voiceController.voice.live.passes.preview, commit: voiceController.voice.live.passes.commit },
          rewritten: voiceController.voice.live.rewritten,
          boundary: voiceController.voice.live.boundary,
          phraseStart: voiceController.voice.live.phraseStart,
          tap: voiceController.voice.capture && voiceController.voice.capture.tap && voiceController.voice.capture.tap.supported()
            ? {
                length: voiceController.voice.capture.tap.length(),
                loudIndex: voiceController.voice.capture.tap.loudIndex(),
                loudAt: voiceController.voice.capture.tap.loudAt(),
              }
            : null,
        },
        catalog: voiceController.voice.catalog
          ? {
              available: voiceController.voice.catalog.available === true,
              reason: voiceController.voice.catalog.reason || '',
              error: voiceController.voice.catalog.error || '',
              providers: (voiceController.voice.catalog.providers || []).map(function (provider) {
                return { id: provider.id, name: provider.name, phase: provider.phase }
              }),
            }
          : null,
      }
    },
    /** 自检用：麦克风按钮节点（无头环境里页面可能挂了两棵树，用这个拿真正带监听的那个）。 */
    voiceNode: function () {
      return micButton
    },
    /** 自检用：手动催一拍实时字幕（测试里不用干等 1.3s 的节流）。 */
    voiceTick: function () {
      voiceController.voice.live.tickAt = 0
      voiceController.liveTick()
      return true
    },
    /** 自检用：录音行的各部件（✕ / 波形 / 状态 / 动作位 / ■）。 */
    voiceNodes: function () {
      return {
        row: captureRow,
        cancel: voiceCancel,
        wave: waveSvg,
        activity: voiceActivity,
        action: voiceActionSlot,
        stop: voiceStop,
      }
    },
    /** 自检用：读/写追问输入框（验证"转写文字插进输入框"）。 */
    askValue: function (text) {
      if (text !== undefined) {
        askBox.value = String(text)
        conversationController.refreshAskState()
      }
      return askBox.value
    },
    /** 自检用：清掉本地缓存，模拟"刷新页面后重开"（验证历史回放路径）。 */
    forget: function () {
      cache.clear()
      return true
    },
    state: function () {
      return {
        phase: state.phase,
        cache: state.cacheState,
        cacheKey: state.cacheKey.slice(0, 24),
        sameTextSeen: state.sameTextHint,
        chars: state.chars,
        /** host 回报的本次请求实际档位（等待提示用）；和用户选的 effort 是两码事 */
        stageEffort: state.stageEffort,
        raw: state.raw,
        model: state.model,
        sections: splitSections(state.raw),
        tools: state.tools.length,
        toolBusy: state.toolBusy,
        toolDigest: state.toolDigest,
        /** 自检用：有没有在飞的请求 / 是不是"收起小窗中止"的那一轮。 */
        thought: state.thought,
        status: state.lastStatus,
        follow: state.follow,
        hasRequest: !!state.request,
        aborted: !!state.aborted,
        asking: !!state.asking,
      }
    },
    panel: function () {
      return panel
    },
    pill: function () {
      return pill
    },
    /** 自检用：模型/档位当前值 + 已加载的目录规模。 */
    modelState: function () {
      return {
        choice: state.modelChoice,
        effort: state.effort,
        pill: modelPillName.textContent + modelPillTier.textContent,
        menuOpen: modelMenu.getAttribute('data-open') === '1',
        catalog: { count: (modelsController.modelCatalog.items || []).length, current: modelsController.modelCatalog.current, stages: modelsController.modelCatalog.stages, error: modelsController.modelCatalog.error },
      }
    },
    /** 自检用：模型控件节点（无头环境里页面可能挂了两棵树，用这个拿到真正带监听的那个）。 */
    modelNodes: function () {
      return { pill: modelPill, menu: modelMenu }
    },
    /** 自检用：菜单开合与点击计数。 */
    modelMenuDebug: function () {
      return { clicks: modelsController.modelPillClicks, open: modelMenu.getAttribute('data-open'), expanded: modelPill.getAttribute('aria-expanded') }
    },
    openModel: function () {
      modelsController.openModelMenu()
      return modelMenu.getAttribute('data-open')
    },
    /** 自检用：拉一次模型目录（菜单会自己拉，这里给测试用）。 */
    loadModels: function (force) {
      return modelsController.loadModelCatalog(force === true).then(function (catalog) {
        modelsController.renderModelMenu()
        modelsController.paintModelPill()
        return { count: (catalog.items || []).length, current: catalog.current, stages: catalog.stages, error: catalog.error }
      })
    },
    /** 自检用：折叠统计与"即将发出去的历史"。 */
    foldStats: function () {
      return {
        folds: historyController.foldCount,
        turns: state.turns.map(function (turn) {
          return {
            role: turn.role,
            chars: String(turn.text || '').length,
            folded: typeof turn.foldedCache === 'string' ? turn.foldedCache.length : null,
          }
        }),
      }
    },
    /** 自检用：手工折一段文本（验证折叠函数本身）。 */
    foldText: function (text) {
      return historyController.foldForHistory(text)
    },
    /** 自检用：读/写网页模式开关。 */
    webMode: function () {
      return !!state.webAnswer
    },
    setWebMode: function (on) {
      return modelsController.setPref(on === true)
    },
    /** 自检用：当前档位的 aria 状态（两格各自的 aria-checked）。 */
    prefCells: function () {
      return {
        markdown: cellMd.getAttribute('aria-checked') === 'true',
        web: cellWeb.getAttribute('aria-checked') === 'true',
        pillShift: webMode.getAttribute('data-on') === '1',
      }
    },
    /** 自检用：手动触发一次"贴到费用胶囊上"，并报出这次有没有真的变。 */
    place: function () {
      return pillController.placePill()
    },
    /**
     * 自检用：胶囊的停靠 / 拖动 / 收球状态。
     * 拖动、吸附、收球那几条断言都读它（真浏览器里跑，量的是真布局）。
     */
    pillState: function () {
      var rect = pill.getBoundingClientRect()
      return {
        dock: pillDock,
        ball: pillBall,
        hover: pillHover,
        dragging: !!pillDrag,
        ready: pill.getAttribute('data-ready') === '1',
        anchorWidth: pillAnchorWidth,
        freeRight: pillFreeRight ? { right: Math.round(pillFreeRight.right), y: Math.round(pillFreeRight.y) } : null,
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          right: Math.round(window.innerWidth - rect.right),
          bottom: Math.round(window.innerHeight - rect.bottom),
        },
        style: {
          left: pill.style.left,
          top: pill.style.top,
          right: pill.style.right,
          bottom: pill.style.bottom,
          width: pill.style.width,
          maxWidth: pill.style.maxWidth,
        },
        ballSize: PILL_BALL_SIZE,
        idleMs: preferences.pillIdleMs,
        snapRadius: PILL_SNAP_RADIUS,
      }
    },
    /**
     * 自检用：立刻跑一次"静置该不该收球"（测试里等不起 PILL_BALL_IDLE_MS 那 10 秒）。
     * 返回 true = 这次真的收成球了。
     */
    pillIdle: function () {
      if (pillIdleId) {
        clearTimeout(pillIdleId)
        pillIdleId = 0
      }
      if (!pillController.pillCanBall()) return false
      pillController.collapsePill()
      return true
    },
    /** 自检用：当前的自适应间隔（毫秒）。 */
    pollDelay: function () {
      return pillPollDelay
    },
    /** 自检用：走一次调度器的单步（贴一次 + 按结果调整节奏），返回新的间隔。 */
    pollStep: function () {
      return pillController.pillPollStep()
    },
    /** 自检用：有没有用上 ResizeObserver（浏览器里有，Node 测试环境里没有）。 */
    resizing: function () {
      return !!pillObserver
    },
    /**
     * 自检用：侧边栏网页划词桥的状态。
     * frames 里的每一项对应一个"桥过的预览帧"；own=true 表示那一帧的文档
     * 是我们自己重发过的 blob（交互式预览走这条）。
     */
    bridge: function () {
      var frames = []
      previewController.bridged.forEach(function (url, frame) {
        frames.push({
          connected: frame.isConnected === true,
          own: !!url,
          srcdoc: frame.getAttribute('srcdoc') !== null,
          sandbox: frame.getAttribute('sandbox'),
        })
      })
      return {
        on: previewController.bridgeOn,
        frames: frames,
        active: !!state.bridgeActive,
        selection: state.selection && state.selection.source === 'iframe' ? state.selection.text : '',
      }
    },
    /** 自检用：扫一遍预览帧（等价于 DOM 变动后的那次自动扫描）。 */
    bridgeScan: function () {
      previewController.scanPreviewFrames()
      return window.__dshSelectionExplain.bridge()
    },
    /** 自检用：当前选区的来源与标签（source=iframe 表示来自侧边栏网页里的桥）。 */
    selection: function () {
      if (!state.selection) return null
      return {
        text: state.selection.text,
        source: state.selection.source || 'document',
        label: state.selection.label || '',
        context: state.selection.context || '',
        keyContext: state.selection.keyContext || '',
      }
    },
    /** 自检用：最近一次请求载荷的关键字段（标签 / 上下文 / 选中文字）。 */
    payload: function () {
      if (!state.payload) return null
      return {
        text: state.payload.text,
        label: state.payload.label,
        context: state.payload.context,
        kind: state.payload.kind,
        stage: state.payload.stage,
      }
    },
    /** 模拟"刷新页面后"：内存里那段小窗没了，只剩 host 上的历史。 */
    reset: function () {
      panelController.closePanel()
      state.payload = null
      state.selection = null
      state.bridgeActive = false
      state.parts = { translation: '', detail: '' }
      state.contextState = null
      state.turns = []
      quotesController.clearQuotes()
      state.raw = ''
      state.phase = 'idle'
      state.error = ''
      state.chars = 0
      state.aborted = false
      state.asking = false
      state.cacheKey = ''
      quote.textContent = ''
      panelController.paint()
      historyController.renderTurns()
      return true
    },
    ping: function () {
      // 带上会话 id：工具是按会话作用域注册的，不带就看不到 web_search
      var id = panelController.currentSessionId()
      var url = PING + (id ? '?sessionId=' + encodeURIComponent(id) : '')
      return fetch(url).then(function (response) {
        return response.json()
      })
    },
  }

  /**
   * 全局错误采集（诊断用，只上报不改变任何行为）。
   *
   * 为什么需要：页面里的报错只能靠开发者工具看，而"点某个按钮没反应"这类问题
   * 只能靠猜。这里把 window 的 error / unhandledrejection 报给 host
   * （/shot/status 的 clientError 字段），一眼就能看到真实堆栈。
   */
  ctx.effect(function () {
    if (typeof window === 'undefined' || !window.addEventListener) return function () {}
    function send(payload) {
      try {
        fetch('/selection-explain/api/shot/hello', {
          method: 'POST',
          body: JSON.stringify(Object.assign({ at: Date.now() }, payload)),
        }).catch(function () {})
      } catch (error) {
        /* ignore */
      }
    }
    function onError(event) {
      var err = event && (event.error || event)
      send({
        stage: 'window-error',
        message: String((err && err.message) || event.message || ''),
        stack: String((err && err.stack) || '').slice(0, 2000),
        source: String((event && event.filename) || ''),
        line: event && event.lineno,
      })
    }
    function onRejection(event) {
      var reason = event && event.reason
      send({
        stage: 'unhandled-rejection',
        message: String((reason && reason.message) || reason || ''),
        stack: String((reason && reason.stack) || '').slice(0, 2000),
      })
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return function () {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, 'selection-explain: error reporter')

  // —— 截图提问的快捷键（DSH 自己的快捷键服务；只在窗口有焦点时响应）——
  // 默认 ⌘⇧X。注册时 DSH 会做冲突校验，用户也能在设置里改键。
  // ⚠️ 必须走 inject 声明（见文件末尾 `inject`）：cordis 的服务按插件隔离，
  // 没声明就用 ctx.get('shortcuts') 取到的是 undefined（实测踩过）。
  var shortcutsService = ctx.shortcuts
  var shortcutReport = { loaded: true, shortcuts: !!shortcutsService, registered: false, error: '' }
  function reportShortcut() {
    try {
      fetch('/selection-explain/api/shot/hello', { method: 'POST', body: JSON.stringify(shortcutReport) }).catch(function () {})
    } catch (error) {
      /* 没有 fetch 的环境跳过 */
    }
  }
  reportShortcut()
  if (shortcutsService && typeof shortcutsService.register === 'function') {
    ctx.effect(function () {
      try {
        var off = shortcutsService.register({
        id: 'selection-explain.screenshot',
        label: function () {
          return '截图提问'
        },
        // ⚠️ 必须给数组：设置页渲染列表时会 `[...row.aliases]`，
        // 留成 undefined 会直接抛 TypeError，整个快捷键弹窗打不开（实测踩到）。
        aliases: [],
        // 键位是**物理键 + 修饰键**的结构（不是 "Mod+Shift+X" 这种字符串）：
        // code 必须是 KeyA-Z / Digit0-9 / F1-24 这类物理 code，modifiers 是 meta/control/alt/shift/primary
        // （primary 在 macOS 上是 ⌘、Windows 上是 Ctrl）。
        defaults: {
          'desktop:macos': { code: 'KeyX', modifiers: ['meta', 'shift'] },
          'web:macos': { code: 'KeyX', modifiers: ['meta', 'shift'] },
          'desktop:windows': { code: 'KeyX', modifiers: ['primary', 'shift'] },
          'web:windows': { code: 'KeyX', modifiers: ['primary', 'shift'] },
        },
        resolve: function () {
          return {
            status: 'handled',
            run: function () {
              shotController.capture()
            },
          }
        },
        })
        shortcutReport.registered = true
        reportShortcut()
        return off
      } catch (error) {
        shortcutReport.error = String((error && error.message) || error)
        reportShortcut()
        return function () {}
      }
    }, 'selection-explain: screenshot shortcut')
    // 长轮询一直挂着等结果（host 那边框选完成才会回）
    shotController.start()
  }

  // —— 可逆清理 ——
  ctx.effect(function () {
    if (typeof console !== 'undefined' && console.log) {
      console.log('[dsh-selection-explain] 划词解读已就绪（选中文字试试）')
    }
    return function () {
      panelOpen = false
      timerScope.dispose()
      cache.dispose()
      voiceCardController.closeVCard(false)
      lightboxController.dispose()
      attachController.clear()
      shotController.stop()
      shotController.clearMarkers()
      panelController.releaseRenderedContent()
      if (state.askRequest) state.askRequest.abort()
      offPopEnd()
      offQuotePopEnd()
      offMouseUp()
      offKeyUp()
      offSelectionChange()
      offVoiceEscape()
      if (floatWatchId) clearInterval(floatWatchId)
      offMouseDown()
      offButtonDown()
      offButtonClick()
      offQuoteDown()
      offQuoteClick()
      offScroll()
      offResize()
      offKeyDown()
      offPromote()
      // 设置抽屉：摘掉它自己那几条监听（抽屉 DOM 随面板一起销毁）
      offSettingsOpen()
      offSettingsBack()
      offSettingsClose()
      offSettingsReset()
      offSettingsStop()
      offSettingsPickAway()
      offSettingsScrim()
      offRetry()
      offExpand()
      offAskKey()
      offAskInput()
      offAskSend()
      offAttachPick()
      offAttachButton()
      offAttachPaste()
      // 语音输入：摘掉麦克风监听，并把正在录/正在识别的这一轮彻底作废（松开麦克风）
      offMic()
      offVoiceCancel()
      offVoiceStop()
      offVoiceBlur()
      voiceController.cancelVoice()
      offClose()
      offDrag()
      offPanelResize()
      offPillDown()
      offPillClick()
      offPillEnter()
      offPillLeave()
      offPillKey()
      offPreviewHeight()
      offBridgeMessage()
      offCellMd()
      offCellWeb()
      offPrefKeys()
      offModelPill()
      offModelMenu()
      offModelKeys()
      offBodyWheel()
      offBodyTouch()
      offBodyScroll()
      if (historyController.chatGrowWatch) historyController.chatGrowWatch.disconnect()
      if (historyController.panelGrowWatch) {
        historyController.panelGrowWatch.disconnect()
        historyController.panelGrowWatch = null
      }
      if (pillPlacerId) clearTimeout(pillPlacerId)
      if (pillObserver) {
        try {
          pillObserver.disconnect()
        } catch (error) {
          /* noop */
        }
        pillObserver = null
      }
      if (fullViewObserver) fullViewObserver.disconnect()
      if (typeof offSlot === 'function') offSlot()
      // 划词桥：摘观察者与消息监听，并把我们自己建的预览 blob 全部回收
      if (previewController.bridgeScanId) clearTimeout(previewController.bridgeScanId)
      previewController.bridgeScanId = 0
      if (previewController.bridgeObserver) {
        try {
          previewController.bridgeObserver.disconnect()
        } catch (error) {
          /* noop */
        }
        previewController.bridgeObserver = null
      }
      previewController.bridged.forEach(function (url) {
        if (!url) return
        try {
          URL.revokeObjectURL(url)
        } catch (error) {
          /* noop */
        }
      })
      previewController.bridged.clear()
      previewController.frameTouchedAt.clear()
      state.turns = []
      state.quotes = []
      state.selection = null
      state.quoteSelection = null
      state.payload = null
      state.parts = { translation: '', detail: '' }
      state.raw = ''
      if (state.request) state.request.abort()
      // 胶囊的原生计时器不在 timerScope 中，单独清理。
      if (pillIdleId) clearTimeout(pillIdleId)
      if (pillController.pillStarTimer) clearTimeout(pillController.pillStarTimer)
      if (layer.parentNode) layer.parentNode.removeChild(layer)
      if (button.parentNode) button.parentNode.removeChild(button)
      if (quoteButton.parentNode) quoteButton.parentNode.removeChild(quoteButton)
      if (panel.parentNode) panel.parentNode.removeChild(panel)
      if (pill.parentNode) pill.parentNode.removeChild(pill)
      if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      try {
        delete window.__dshSelectionExplain
      } catch (error) {
        window.__dshSelectionExplain = undefined
      }
    }
  }, '@yfwu2020/dsh-selection-explain: 划词解读 UI')
}
export const inject = ['slots', 'shortcuts']
