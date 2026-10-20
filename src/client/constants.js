
/** host 路由。 */
export var API = '/selection-explain/api/analyze'

export var PING = '/selection-explain/api/ping'

export var PROMOTE = '/selection-explain/api/promote'

/** 胶囊拖到别处后的位置（记在 host 上：拖到别处→存，吸附回右下角→清，挂载→读回来）。 */
export var PILL_POS = '/selection-explain/api/pill'

/** 小窗的**尺寸**（改过大小之后记在 host 上，刷新后回到那个大小）。位置不记。 */
export var PANEL_SIZE = '/selection-explain/api/panel'

export var HISTORY = '/selection-explain/api/history'

/** 模型清单（带每个模型支持的推理等级）。 */
export var MODELS = '/selection-explain/api/models'

/**
 * 小窗附件上传：POST { items:[{kind:'image'|'file', name, mediaType, data(base64)}] }
 *   → { ok:true, items:[{kind, ref}] }（ref 是附件服务的持久引用，发送时原样回传给 /analyze）。
 *
 * 为什么一个文件一次请求：失败与重试都落在**那一件**上 —— 一张图被拒不该把同一批里
 * 别的附件一起废掉（主会话那条路是整批同生共死，小窗这里逐个来更适合"就地重试"）。
 */
export var ATTACH = '/selection-explain/api/attach'

/**
 * 把存好的附件读回来显示：GET ?ref=<base64url(JSON)>&kind=image|file[&download=1]
 *
 * 气泡里的缩略图走它 —— 发出去的消息里只有引用，本地 object URL 在发送那一刻就释放了，
 * 历史回放更连 File 都没有。主会话的图片也是从宿主取回来显示的。
 */
export var ATTACHMENT = '/selection-explain/api/attachment'

/** 一次最多带几件（与 host 的 ATTACH_MAX_ITEMS 一致；超了 host 也会拒）。 */
export var ATTACH_MAX_ITEMS = 10

/** 单个文件的字节上限（与 host 的 ATTACH_MAX_ITEM_BYTES 一致）。 */
export var ATTACH_MAX_ITEM_BYTES = 20 * 1024 * 1024

/**
 * 小窗设置：GET 拿 spec + 当前值，POST 写回。
 *
 * spec（分组 / 标题 / 说明 / 边界 / 单位）由 host 下发 —— 客户端**不做业务判断**，
 * 免得 UI 的边界和 host 的 clamp 各写一份、时间久了互相漂（见 src/settings.ts 顶部注释）。
 */
export var SETTINGS = '/selection-explain/api/settings'

/** 极轻的"这一轮用哪个模型"查询：设置页开着时按秒轮询它，让括号里的名字实时跟着变。 */
export var ROUTE = '/selection-explain/api/route'

/**
 * 语音输入（小窗麦克风）：识别在 host 上做，浏览器只负责录一段规范 WAV 送过去。
 *   · 目录接口说清"能不能录、要录多久、要不要先准备模型"；
 *   · 音频不落盘、不进会话，转写完即丢（客户端的引用里也不会出现音频）。
 */
export var SPEECH_API = '/selection-explain/api/speech'

export var SPEECH_TRANSCRIBE = SPEECH_API + '/transcribe'

export var SPEECH_PREPARE = SPEECH_API + '/prepare'

/**
 * 麦克风占用（"输入法正在语音输入"）：host 读 CoreAudio 的进程对象列表，
 * 见 src/index.ts 的 micPresence 与 native/mic-probe.c。
 *   → { ok, available, capturing, processes:[{pid,bundleId,name}], reason }
 * 读它不需要麦克风授权 —— 插件不该为了一个"指示灯"去要用户的麦克风权限。
 */
export var MIC_API = '/selection-explain/api/mic'

/**
 * 认哪些输入法（bundleId 前缀）。豆包输入法。
 * 加新输入法就往这里加一行：特性只对"已知输入法"生效，不去猜别的 App 在录什么。
 */
export var IME_BUNDLES = ['com.bytedance.inputmethod.doubaoime']

/**
 * 轮询间隔：只在"有选区"时问（浮标亮着的那几拍）。
 *
 * 200ms：它是"按 Fn → 卡片弹出"延迟里的两项之一（另一项是宿主探针的采样间隔，
 * 见 src/index.ts 的 MIC_WATCH_MS）。原来 400ms 是保守估的，实测本机一次 GET
 * 的开销可忽略，所以调快一倍、把感知延迟压下来。
 * 注意：即使调快，也不能靠"检测到文字再弹框" —— 上屏发生在松手那一刻，
 * 那时才抢焦点就晚了（字会落到别处）；我们要的是"它开麦时就抢"。
 */
export var MIC_POLL_MS = 200

/** 语音卡几何：右缘贴浮标右缘，左缘展开到正文列左边 —— 宽度由这两条边界算出来。 */
/**
 * 卡片宽度：**固定 360**。
 *
 * 原来按"正文列左边 → 选区右缘"算，再夹在 [360, 560] 之间 —— 想法是"让卡片看起来属于
 * 这一段正文"，但实测**经常偏宽**（选区在第一行靠右结束时能顶到 560），读起来笨重。
 * 现在统一 360：右缘仍然钉在选区右缘（和浮标同侧，形变时右缘不动、左缘展开），
 * 宽度不再随选区位置变化。
 */
export var VCARD_W = 360

/**
 * **兜底**：松手之后等文字"静默"多久才认定定稿（毫秒）。
 *
 * 主信号是 compositionend（见 VOICE_SETTLE_COMPOSE_MS），实测豆包的智能整理都走它，
 * 所以这条兜底实际上很少被用到 —— 它管两种情况：
 *   1. 输入法直接改 value、没走合成 API；
 *   2. 整理提交发生在客户端察觉松手之前（轮询有最多一个间隔的滞后，那时 compositionend 已经过去了）。
 *
 * 取 500（用户指定，原为 700）：实测"松手 → 整理提交"是 71/257/328/393/515/600ms，
 * 但那些**都带 compositionend**、走的是主信号，所以兜底提前到 500 不影响它们；
 * 真要担心的是"没有合成信号"的场合 —— 那种情况没有实测数据，500 是个折中。
 */
export var VOICE_SETTLE_MS = 500

/**
 * 收到 compositionend 之后，再等多久才决定（毫秒）。
 *
 * 实测结论（8 次真实录音）：豆包的智能整理**走合成 API 提交** —— 6 次里都有
 * `inputType=insertCompositionText` + `compositionend`。所以它是**准确信号**，
 * 不必再靠"猜静默窗口"。
 *
 * 留这 200ms 是因为可能连着提交两次（标点一次、改词一次）：每收到一次就重新计时。
 * 实测"松手 → 整理提交"= 71 / 257 / 328 / 393 / 515 / 600 ms；整理内容包含补标点、
 * 去重复词、以及**改听错的词**（"设置没法大概的话" → "设置没法打开的话"）——
 * 正因为会改词，绝不能一松手就发送。
 */
export var VOICE_SETTLE_COMPOSE_MS = 200

/** 等定稿的**最长时间**（毫秒）：整理一直不停的话，到点就按当前内容决定，不能无限等。 */
export var VOICE_SETTLE_MAX_MS = 4000

/** 观察文字有没有变的间隔（毫秒）。用轮询而不是 input 事件：智能整理可能是直接改 value，不一定发事件。 */
export var VOICE_SETTLE_POLL_MS = 200

/**
 * 卡片 → 小窗的交接（用户选定的方案：**缩放长出**）。
 *
 * 以前这两步是"瞬切"：卡片 `display:none`、小窗 `display:flex`，中间零过渡；
 * 而且几何本身也换了 —— 卡片 360 宽、**右缘**贴选区右缘，小窗 540 宽、**左缘**贴选区左缘，
 * 所以看起来是"跳"。现在让小窗**从卡片那一格开始**：起手用 transform 把面板压到卡片的矩形上，
 * 260ms 回到自身（曲线与插件既有的"浮标 → 卡片"形变同一族）。
 *
 * 为什么只动 transform（不动 width/left/top）：那四个是布局属性，每帧都会重排整个面板
 * （面板里有富文本、代码块，网页模式下还有 iframe）—— 形变期间会掉帧。transform 只走合成器。
 * 代价是起手那几帧内容被压扁（缩放态），这正是"长出来"这个观感的来源。
 */
export var PANEL_GROW_MS = 260

export var PANEL_GROW_EASE = 'cubic-bezier(.2,.8,.2,1)'

/** 正文最多 4 行（约 93px），再多内部滚动并停在最新一行（与追问框同一套）。 */
export var VCARD_TEXT_MAX = 96

/**
 * 卡片高度 = 正文高度 + 这个（border-box 下的纵向内边距 8+8 与边框 1+1）。
 * 单行卡因此是 24 + 18 = 42px —— 而不是漏掉 box-sizing 时渲染出来的 70px。
 */
export var VCARD_PAD_Y = 18

/**
 * "这一帧刚被动过"算多久以内有效（毫秒）。
 *
 * 只给侧边栏网页那条路用：焦点落在**不透明源子框架**里时，父文档的 `document.hasFocus()`
 * 是否返回 true 由浏览器实现决定（跨引擎没有统一答案，headless 里也验不出来），
 * 所以对帧内选区改用"这一帧刚刚报过动作（划词 / 按下）"当焦点证据 ——
 * 桥报上来的那一刻，用户确实正在那个网页里操作。窗口取 5 秒：麦克风探针 125ms +
 * 页面轮询 200ms，开麦检测最慢也就几百毫秒后才用到它。
 */
export var FRAME_FOCUS_EVIDENCE_MS = 5000

/** 兜底限制（host 的 limits 优先；拿不到目录时按这套走）。 */
export var VOICE_FALLBACK_SECONDS = 60

export var VOICE_MAX_BYTES = 4 * 1024 * 1024

/** 目录缓存时长：同一分钟内反复点麦克风不再重复问 host。 */
export var VOICE_CATALOG_TTL = 60 * 1000

/**
 * 实时字幕（半句预览 + 停顿定稿）：
 *   · 说话时每 ~1.3s 把"还没定稿的这半句"送去识别一次，结果**整段替换**上一拍的预览；
 *   · 检测到 ~0.6s 静音（一句话说完了）就把这句送去识别并**定稿**，之后不再变。
 * 只在本地识别器上默认开（云端每拍一次都是付费调用）；窗口固定 ≤10 秒，
 * 这样说到第 40 秒也不会变慢（实测 8s 窗口 185ms、40s 整段要 1.1s）。
 */
export var VOICE_PREVIEW_EVERY = 1300

export var VOICE_PREVIEW_WINDOW = 10

export var VOICE_PAUSE_MS = 600

export var VOICE_PAUSE_MIN_MS = 400

export var VOICE_COMMIT_MAX_SECONDS = 25

/** "有声"的门限（RMS）：低于它算静音，连着 0.6s 就是一句话说完了。 */
export var VOICE_SILENCE_RMS = 0.012

/** 上下文窗口：选区前后各取多少字符。 */
export var CONTEXT_WINDOW = 1500

/** key 只取选中文字**之前**这么多字：后缀会随新消息变化，不能进 key。 */
export var KEY_CONTEXT_CHARS = 300

/**
 * 引用（❝）：小窗开着时，把**小窗里选中的正文**或**主界面上选中的文字**
 * 挂进小窗输入框，发送时作为材料一并发给模型。
 *   · 一次最多几段 —— 每段都会进本轮提问，堆太多等于把问题埋掉；
 *   · 引用原文不截断；实际发送受整轮上下文容量预算约束。
 */
export var MAX_QUOTES = 4

/** 浮标允许的选区长度；加入引用后保留完整原文，不另行截尾。 */
export var MAX_QUOTE_SELECTION = 20000

/** 只挂了引用、一个字都没写时，用它当提问（不替用户编复杂问题）。 */
export var QUOTE_ONLY_QUESTION = '就上面引用的文字，说说它在这里是什么意思。'

/**
 * 引用的上下文：**只带模型看不到的东西**。
 *   · 小窗自己的正文（回答 / 两节 / 顶部原文条）→ **不带**：那几轮对话本来就会随 history
 *     进模型，出处靠标签说清（「小窗第 2 轮回答」「小窗「翻译」节」）；
 *   · 主界面（会话）→ 由 host 从会话记录里取"引用所在那一组对话 ± 一组"（干净文本、按轮取整），
 *     见 QUOTE_CONTEXT_API；客户端先用局部窗口兜底，发送前才去问 host；
 *   · 侧边栏网页 → 帧内桥采的局部窗口。
 */
export var QUOTE_CONTEXT_API = '/selection-explain/api/quote-context'

/** 会话版上下文的等待上限（毫秒）：超了就用客户端那份，不让发送卡住。 */


/** 会话版上下文的等待上限（毫秒）：超了就用客户端那份，不让发送卡住。 */
export var QUOTE_CONTEXT_TIMEOUT = 1500

/** 面板 z-index 顶部。 */
export var Z_BTN = 2147483000

export var Z_PANEL = 2147483001

/** 阴影字体栈（与宿主 UI 一致的中文优先栈）。 */
export var FONT =
  '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif'

// —— 悬浮状态胶囊的几何/手感参数（CSS 与 placePill 都要用，所以放这一层） ——
/**
 * **兜底**最大宽度：只有"量不到费用胶囊"时才生效（见 placePill）。
 *
 * 有费用胶囊时宽度写死成它的实测宽度 —— 两者共用 CSS 里那条 `max-width:280px`，
 * 所以并排时同宽同位置；而单独一枚浮在右下角时 280 显得"横着一条"（旁边什么都没有，
 * 分量感全在这条胶囊上），收到 200。取值依据（真浏览器 8x 截图 + 量墨迹）：
 *   · 短内容「划词解读 · 就绪」自然宽度 146.6px → 不受影响；
 *   · 英文选中「the migratio… · 完成 · 3 轮」214px → 会截一点；
 *   · 最坏组合「12 字中文 + · 追问中 12.3s」名字那格还剩 ~54px ≈ 3 个字。
 * 状态格 `flex:0 0 auto` 永不缩 —— 宽度不够时只牺牲选中文字（省略号收尾）。
 */
export var PILL_FALLBACK_MAX = 200

/** 收成小球后的直径（px）。收球 = 把 max-width 收到它（能过渡，所以收/放都是动画）。 */
export var PILL_BALL_SIZE = 32

/** 松手时离"贴角位置"多近就吸附回去（px，按左上角比）。 */
export var PILL_SNAP_RADIUS = 96

/** 位移超过多少像素才算"拖"而不是"点"（px，曼哈顿距离）。 */
export var PILL_DRAG_SLOP = 4

/**
 * 收球 / 展开那条过渡（时长 + 曲线），CSS 里多处引用。
 *
 * 曲线选 `cubic-bezier(.5,0,.5,1)` 是因为它**时间对称**：控制点关于中心对称，
 * 于是 p(t) = 1 - p(1-t) —— 把收球的动画倒过来放，恰好就是展开的动画。
 * 用户报的收放不对称就是这么来的：之前用 easeOutQuint，前后半程不镜像，
 * 收是「快起慢收」、放也是「快起慢收」，两个方向看着像两件事。
 * 时长给 .34s：所有会变的属性共用它（任何一条不一致，中间帧的宽度就由另一条曲线决定，对称性就破了）。
 */
export var PILL_MORPH = '.28s cubic-bezier(.4,0,.6,1)'

/**
 * 收球后球心里的星芒 —— 与「✦ 解读」浮标那颗星**逐点同形**。
 *
 * 按钮里那颗星是 16 画布上的八边形：外半径 5.6、内半径 2.1213（内外比 .3788）、四条边是直线
 * （path `M8 2.4l1.5 4.1 4.1 1.5-4.1 1.5L8 13.6 6.5 9.5 2.4 8l4.1-1.5L8 2.4z`）。
 * 球里的尺寸：外半径 6.0 → 墨迹 12.0px —— 和胶囊里文字（字号 12px）同高（用户要求）。
 * （原来按 1.5 倍放大到 16.8px，在 32px 球里显得比文字壮太多。）
 *
 * 形变方式：把"圆点"和"星"都看成 **32 边形**逐顶点插值 ——
 *   · PILL_STAR_DOT_D：32 个顶点同半径 4 → 8px 圆点（8px 下与正圆无差，最大偏差 0.02px）
 *   · PILL_STAR_D：32 个顶点正好落在星边界上（尖与谷仍是精确顶点）→ 与按钮那条 path 逐点相同
 * 两条 path 命令结构一致（M + 31×L + Z），所以 Chrome 能对 `d` 做插值。
 * 于是"圆点长成星芒"是**同一个形状在长**，而不是"淡出一个、淡入另一个"（那样中间帧会掉分量）。
 *
 * ⚠️ 别改成"八个顶点一起插值"：数学上更短，但中间帧会经过一个**正菱形**（谷还没收、边是直的），
 *    读起来像"方块"，和圆点/星芒都不是一路。必须取样到 32 个顶点（星那条边上的取样点精确落在线段上）。
 * 顶点由 `node scripts/gen-star-path.mjs` 生成，可重跑核对。
 */
/**
 * 收放时长（毫秒）—— 必须与 PILL_MORPH 里的 .28s 一致：CSS 管胶囊、JS 管球心图形，
 * 两者同拍才是"同一件事"。见 animatePillStar。
 */
export var PILL_MORPH_MS = 280

/** 形变采样点数（圆与星都按 32 边形逐顶点插值）。 */
export var PILL_STAR_SAMPLES = 32

/** 尖/身两段的交界：尖先抽出来（0→.62），身再收成星（.38→1），重叠 .24 段保证无速度断点。 */
export var PILL_STAR_TIP_END = 0.62

export var PILL_STAR_BODY_START = 0.38

/**
 * 球心图形那条曲线（时间对称：.45+.55=1、0+1=1 → 倒放即另一个方向）。
 * 比胶囊那条 (.4,0,.6,1) 略收一点，于是两层不是同一个节拍：胶囊滑、图形落定得干脆些。
 * ⚠️ 试过给曲线加"过冲"（y 越出 [0,1]）——**不行**：时间对称的 cubic-bezier 只要 y1+y2=1，
 *    曲线就必是"上-下-上"的波浪（实测 (.4,1.12,.6,-.12) 在 0.25 处已经 0.40、0.75 处才 0.60），
 *    看着是一顿一顿的。过冲要放在**形状空间**里（PILL_STAR_POP），时间轴上始终是干净的 S。
 */
export var PILL_STAR_EASE = [0.45, 0, 0.55, 1]

/**
 * 形状空间的过冲：尖长到位后再"冲出去一点点"再收回（0.075 = 尖最多到 8.73，落定回 8.4）。
 * 包络在 p=.55 起、p=.8 附近到顶、p=1 归零 —— 两端为 0 所以不影响端点。
 * 它是 p 的函数，所以收/放仍然严格互为倒放。
 */
export var PILL_STAR_POP = 0.075

/** 微转（度）：圆点态 -8°、星芒态 0°；过冲时会略过 0 再落定。圆点旋转不变，所以起手看不出来。 */
export var PILL_STAR_TWIST = 8

export var PILL_STAR_DOT_D = 'M4 0L3.92 0.78L3.7 1.53L3.33 2.22L2.83 2.83L2.22 3.33L1.53 3.7L0.78 3.92L0 4L-0.78 3.92L-1.53 3.7L-2.22 3.33L-2.83 2.83L-3.33 2.22L-3.7 1.53L-3.92 0.78L-4 0L-3.92 -0.78L-3.7 -1.53L-3.33 -2.22L-2.83 -2.83L-2.22 -3.33L-1.53 -3.7L-0.78 -3.92L0 -4L0.78 -3.92L1.53 -3.7L2.22 -3.33L2.83 -2.83L3.33 -2.22L3.7 -1.53L3.92 -0.78Z'

export var PILL_STAR_D = 'M6 0L3.89 0.77L2.81 1.17L2.12 1.42L1.61 1.61L1.42 2.12L1.17 2.81L0.77 3.89L0 6L-0.77 3.89L-1.17 2.81L-1.42 2.12L-1.61 1.61L-2.12 1.42L-2.81 1.17L-3.89 0.77L-6 0L-3.89 -0.77L-2.81 -1.17L-2.12 -1.42L-1.61 -1.61L-1.42 -2.12L-1.17 -2.81L-0.77 -3.89L0 -6L0.77 -3.89L1.17 -2.81L1.42 -2.12L1.61 -1.61L2.12 -1.42L2.81 -1.17L3.89 -0.77Z'

/** 吸附滑行的时长（毫秒）：比过渡时长多一点，走完就把定位交还给 right/bottom。 */
export var PILL_SNAP_MS = 360
export const preferences = { maxSelectionChars: 4000, pillIdleMs: 10000 }
