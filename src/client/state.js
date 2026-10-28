/** A fresh domain state for each mounted plugin lifecycle. */
export function createClientState() {
  /** 当前面板状态。 */
  return {
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

}

/** Lifecycle-local panel coordination flags. */
export function createPanelRuntime() {
  return { askFocusPending: false, focusBail: '', panelOpen: false, panelSessionId: '' }
}

/** Interaction state belongs to one pill, never the module cache. */
export function createPillState() {
  return {
    pillPollDelay: 2000,
    pillHidden: false,
    pillDock: 'anchor',
    pillFreeRight: null,
    pillBall: false,
    pillHover: false,
    pillDrag: null,
    pillDragMoved: false,
    pillIdleId: 0,
    pillSnapUntil: 0,
    pillAnchorWidth: 0,
    pillPlacerId: 0,
    pillHost: null,
    pillWatched: null,
    pillObserver: null,
  }
}
