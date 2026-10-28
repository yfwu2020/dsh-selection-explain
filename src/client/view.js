import { el } from './dom.js'
import { CSS } from './styles.js'
import { Z_BTN, Z_PANEL, PILL_STAR_DOT_D } from './constants.js'
import { sparkleIcon, quoteIcon, actionButton, headerHistoryIcon, headerPromoteIcon, headerSettingsIcon, iconButton, headerCloseIcon, buildSection, markdownIcon, windowIcon, sendIcon, micIcon, closeIcon, stopIcon, backIcon, plusIcon } from './icons.js'

/** Creates UI nodes only; controllers own behavior and lifecycle. */
export function createClientView() {
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

  return { settingsSheet, modelMenu, settingsNote, settingsNoteText, settingsRail, settingsBody, pill, panel, settingsScrim, settingsButton, layer, body, translationSection, detailSection, button, quoteButton, askRow, quotesBox, expandButton, quote, retryButton, closeButton, askBox, pillName, pillMeta, pillCaret, pillStar, historyButton, chatLog, askSend, promoteButton, attachBox, attachNote, attachInput, modelPillName, modelPillTier, modelPill, webMode, cellMd, cellWeb, voiceActivityText, voiceActivity, voiceDot, voiceActionSlot, captureRow, askTools, askSpacer, micButton, waveSvg, voiceStop, voiceCancel, waveBars, prefSeg, settingsBack, settingsClose, settingsReset, addButton, head, gripCorner, gripRight, gripBottom, styleEl }
}
