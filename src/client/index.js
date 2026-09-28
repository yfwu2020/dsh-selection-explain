/**
 * @yfwu2020/dsh-selection-explain — 浏览器端（划词解读 UI）。
 *
 * 交互：在页面任意位置选中文字 → 选区末端浮出「解读」按钮 → 点击弹出面板，
 * 面板流式显示两节：① 专业中英翻译 ② 这段文字在当前上下文中的含义详解。
 *
 * 挂载点走官方 shell.overlay 槽（帧级浮层：三栏之外、滚动容器之外、默认
 * click-through，条目自己 opt-in pointer-events）——因此 UI 不会挡住 App。
 * 浮标与面板用 position:fixed 定位到选区坐标，DOM 归 shell.overlay 条目所有。
 *
 * 本文件是 DSH 客户端 bundle 的源文件（ModuleLoader 懒加载 CJS 表格式）：
 * 顶层只注册工厂，真正的副作用（React 组件、DOM/CSS、监听）都在 factory 被
 * materialize 时执行，且整体挂在 ctx.effect / ctx.slots.inject 下——插件停用
 * 或热重载时全部可逆清理。
 *
 * 自检钩子：window.__dshSelectionExplain（仅供调试/自动化验证）。
 */
window.__ModuleLoader__.load({
  id: '@yfwu2020/dsh-selection-explain',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    /** host 路由。 */
    var API = '/selection-explain/api/analyze'
    var PING = '/selection-explain/api/ping'
    var PROMOTE = '/selection-explain/api/promote'
    var HISTORY = '/selection-explain/api/history'
    /** 模型清单（带每个模型支持的推理等级）。 */
    var MODELS = '/selection-explain/api/models'
    /**
     * 语音输入（小窗麦克风）：识别在 host 上做，浏览器只负责录一段规范 WAV 送过去。
     *   · 目录接口说清"能不能录、要录多久、要不要先准备模型"；
     *   · 音频不落盘、不进会话，转写完即丢（客户端的引用里也不会出现音频）。
     */
    var SPEECH_API = '/selection-explain/api/speech'
    var SPEECH_TRANSCRIBE = SPEECH_API + '/transcribe'
    var SPEECH_PREPARE = SPEECH_API + '/prepare'
    /** 兜底限制（host 的 limits 优先；拿不到目录时按这套走）。 */
    var VOICE_FALLBACK_SECONDS = 60
    var VOICE_MAX_BYTES = 4 * 1024 * 1024
    /** 目录缓存时长：同一分钟内反复点麦克风不再重复问 host。 */
    var VOICE_CATALOG_TTL = 60 * 1000
    /**
     * 实时字幕（半句预览 + 停顿定稿）：
     *   · 说话时每 ~1.3s 把"还没定稿的这半句"送去识别一次，结果**整段替换**上一拍的预览；
     *   · 检测到 ~0.6s 静音（一句话说完了）就把这句送去识别并**定稿**，之后不再变。
     * 只在本地识别器上默认开（云端每拍一次都是付费调用）；窗口固定 ≤10 秒，
     * 这样说到第 40 秒也不会变慢（实测 8s 窗口 185ms、40s 整段要 1.1s）。
     */
    var VOICE_PREVIEW_EVERY = 1300
    var VOICE_PREVIEW_WINDOW = 10
    var VOICE_PAUSE_MS = 600
    var VOICE_PAUSE_MIN_MS = 400
    var VOICE_COMMIT_MAX_SECONDS = 25
    /** "有声"的门限（RMS）：低于它算静音，连着 0.6s 就是一句话说完了。 */
    var VOICE_SILENCE_RMS = 0.012
    /** 选区长度上限（与 host 默认值一致，host 还会再校验一次）。 */
    var MAX_SELECTION = 4000
    /** 上下文窗口：选区前后各取多少字符。 */
    var CONTEXT_WINDOW = 1500

    /** key 只取选中文字**之前**这么多字：后缀会随新消息变化，不能进 key。 */
    var KEY_CONTEXT_CHARS = 300
    /**
     * 引用（❝）：小窗开着时，把**小窗里选中的正文**或**主界面上选中的文字**
     * 挂进小窗输入框，发送时作为材料一并发给模型。
     *   · 一次最多几段 —— 每段都会进本轮提问，堆太多等于把问题埋掉；
     *   · 每段字数上限 —— 超了截断（引用整条回答时最长的那种会撞上）。
     */
    var MAX_QUOTES = 4
    var MAX_QUOTE_CHARS = 3000
    /**
     * 引用**选区**的长度上限（比 MAX_QUOTE_CHARS 宽得多）。
     *
     * 划一大段（比如整条回答）时也要让浮标出来 —— 出来之后按 MAX_QUOTE_CHARS 截断并说明；
     * 早先这里直接用 MAX_QUOTE_CHARS 判断，结果是"划长一点就没反应"，
     * 而用户根本不知道为什么（浮标不出现 = 没有任何反馈）。
     */
    var MAX_QUOTE_SELECTION = 20000
    /** 只挂了引用、一个字都没写时，用它当提问（不替用户编复杂问题）。 */
    var QUOTE_ONLY_QUESTION = '就上面引用的文字，说说它在这里是什么意思。'
    /**
     * 引用要**带上下文**：引用文字当时所在的那一组对话 ± 一组（一组 = 一条用户消息 + 它的回答）。
     *   · 会话里的引用（主界面）→ 上下文由 host 从会话记录里取（干净文本、按轮取整），见 QUOTE_CONTEXT_API；
     *   · 小窗里的引用 → 客户端从小窗自己的轮次里取（下面这几个常量管长度）。
     * 客户端这一侧的兜底上下文（局部窗口）在点击引用那一刻采，发送前才去问 host 要会话版。
     */
    var QUOTE_CONTEXT_API = '/selection-explain/api/quote-context'
    /** 小窗上下文：引用所在那一轮前后各取几轮（交替结构下 ≈ 上下各一组）。 */
    var QUOTE_CTX_TURNS = 2
    /** 小窗上下文：单条最多多少字（超了围绕引用截断）。 */
    var QUOTE_CTX_TURN_CHARS = 900
    /** 小窗上下文：整段最多多少字。 */
    var QUOTE_CTX_MAX = 3000
    /** 会话版上下文的等待上限（毫秒）：超了就用客户端那份，不让发送卡住。 */
    var QUOTE_CONTEXT_TIMEOUT = 1500
    /** 面板 z-index 顶部。 */
    var Z_BTN = 2147483000
    var Z_PANEL = 2147483001
    /** 阴影字体栈（与宿主 UI 一致的中文优先栈）。 */
    var FONT =
      '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif'

    // ────────────────────────────── 小工具 ──────────────────────────────

    function el(tag, cls, text) {
      var node = document.createElement(tag)
      if (cls) node.className = cls
      if (text !== undefined && text !== null) node.textContent = text
      return node
    }

    function listen(target, type, handler, capture) {
      target.addEventListener(type, handler, capture === true)
      return function () {
        target.removeEventListener(type, handler, capture === true)
      }
    }

    function clamp(value, min, max) {
      return value < min ? min : value > max ? max : value
    }

    /** 选区是否落在输入框里（那里不该弹按钮，避免干扰输入）。 */
    function insideEditable(node) {
      var element = node && node.nodeType === 1 ? node : node && node.parentElement
      if (!element || !element.closest) return false
      return !!element.closest('input, textarea')
    }

    function formatDuration(ms) {
      return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'
    }

    // ────────────────────────── 录音（语音输入）──────────────────────────
    // 这一节是**纯函数 + 浏览器能力判断**，不碰面板状态：小窗的编排在 apply() 里。
    // 单位换算和 WAV 头必须和 host 的 validateWave 逐字段对上（16kHz / 单声道 / PCM16），
    // 对不上 host 会直接拒收 —— 这是刻意的：宁可明确报"音频格式不对"，
    // 也不要让识别服务按错误的采样率去听一段快放。

    /** 录音时长：0:07（上限 60 秒，所以只有分:秒）。 */
    function formatClock(ms) {
      var seconds = Math.max(0, Math.floor(ms / 1000))
      var mm = Math.floor(seconds / 60)
      var ss = seconds % 60
      return mm + ':' + (ss < 10 ? '0' : '') + ss
    }

    /**
     * Float32 采样（16kHz 单声道）→ 规范的 PCM16 WAV。
     * @param samples 采样（-1..1）
     * @returns Uint8Array（44 字节头 + 数据）
     */
    function encodeWave(samples) {
      var bytes = new Uint8Array(44 + samples.length * 2)
      var view = new DataView(bytes.buffer)
      function ascii(offset, text) {
        for (var i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
      }
      ascii(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      ascii(8, 'WAVE')
      ascii(12, 'fmt ')
      view.setUint32(16, 16, true) // fmt 块长度
      view.setUint16(20, 1, true) // PCM
      view.setUint16(22, 1, true) // 单声道
      view.setUint32(24, 16000, true) // 采样率
      view.setUint32(28, 32000, true) // 字节率
      view.setUint16(32, 2, true) // 块对齐
      view.setUint16(34, 16, true) // 位深
      ascii(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (var i = 0; i < samples.length; i += 1) {
        // 先夹到 [-1,1]：重采样后的浮点偶尔会略微越界，直接乘会绕回成刺耳的爆音
        var value = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i]
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    /** 字节 → base64（分块喂 fromCharCode，几十万采样一次性展开会爆栈）。 */
    function bytesToBase64(bytes) {
      var text = ''
      for (var i = 0; i < bytes.length; i += 8192) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
      }
      return btoa(text)
    }

    /** 这个浏览器能不能录音（不支持时麦克风按钮直接给解释，而不是点了才报错）。 */
    function recordingSupported() {
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices) return false
        if (typeof navigator.mediaDevices.getUserMedia !== 'function') return false
        // 全部走 window.*：浏览器里 window 就是全局对象，测试里也能注入同一套桩
        if (typeof window.MediaRecorder === 'undefined') return false
        return typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined'
      } catch (error) {
        return false
      }
    }

    // ────────────────────────────── 样式 ──────────────────────────────

    var CSS = [
      // 浮现动效：从锚点（右下角 = 贴着选区那侧）弹性放大。
      // 初始 74% + 6px 下移，缓动带过冲；时长 240ms —— 超过 ~300ms 连续划选会显得拖沓。
      '.dsh-sel-btn{transform-origin:100% 100%;position:fixed;display:none;align-items:center;gap:5px;height:28px;padding:0 11px;border:0;border-radius:999px;',
      // 浮标按钮保持**原样**：跟随主题主色（默认蓝 #3b6ef5），不跟面板的青色统一
      'background:var(--dsw-alias-button-primary-fill,#3b6ef5);color:var(--dsw-alias-label-primary-foreground,#fff);',
      'font:500 12px/1 ' + FONT + ';cursor:pointer;white-space:nowrap;user-select:none;',
      'box-shadow:0 6px 20px rgba(0,0,0,.24);transition:transform .1s ease,filter .1s ease}',
      '@keyframes dsh-sel-pop{from{opacity:0;transform:scale(.74) translateY(6px)}to{opacity:1;transform:none}}',
      // 只在"从隐藏到显示"那一次挂上这个类；animationend 后摘掉，
      // 否则 fill:both 会把 transform 钉在 none 上，:active 的按压缩放就永远不生效了
      // 用 data 属性而不是类名：类名不动，外面按 .dsh-sel-btn 找它/量它都不会被影响
      '.dsh-sel-btn[data-pop="1"]{animation:dsh-sel-pop .24s cubic-bezier(.34,1.56,.64,1) both}',
      '.dsh-sel-btn:hover{filter:brightness(1.08)}',
      '.dsh-sel-btn:active{transform:scale(.97)}',
      '.dsh-sel-btn svg{width:13px;height:13px;display:block}',
      // 全局一个主色：**青**（两节同色，和「详解」一致）。
      //   --sel-a1/a2      装饰：边条 / 呼吸点 / 淡底（不承载文字，不需要 AA）
      //   --sel-a*-text    文字：术语、标题、符号、链接（实测 AA 达标）
      //   --sel-fill(-fg)  实心块：浮标按钮 / 发送键 / 结论条标签——块上文字另算一套，
      //                    否则青底配白字只有 3.6（不达标），浅色下换成深青 5.4、深色下反白 7.4
      // 变量挂在浮层容器上 → 浮标与面板共用；深浅由**面板实际底色**决定（data-theme）。
      '.dsh-sel-layer{--sel-a1:#0d9488;--sel-a1-text:#0f766e;--sel-a2:#0d9488;--sel-a2-text:#0f766e;',
      '--sel-fill:#0f766e;--sel-fill-fg:#ffffff;',
      '--sel-a2-soft:color-mix(in srgb,var(--sel-a2) 12%,transparent);--sel-a1-soft:color-mix(in srgb,var(--sel-a1) 10%,transparent)}',
      '.dsh-sel-layer[data-theme=dark]{--sel-a1:#4ecdc4;--sel-a1-text:#6fe3d8;--sel-a2:#4ecdc4;--sel-a2-text:#6fe3d8;',
      '--sel-fill:#4ecdc4;--sel-fill-fg:#052b26;',
      '--sel-a2-soft:color-mix(in srgb,var(--sel-a2) 16%,transparent);--sel-a1-soft:color-mix(in srgb,var(--sel-a1) 16%,transparent)}',
      '.dsh-sel-panel{position:fixed;display:none;flex-direction:column;width:min(540px,calc(100vw - 20px));max-height:min(78vh,720px);',
      '.dsh-sel-panel[data-stage=translation]{width:min(440px,calc(100vw - 20px))}',
      'border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);',
      'border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));box-shadow:0 20px 52px rgba(0,0,0,.3);',
      'font:400 13.5px/1.7 ' + FONT + '}',
      '.dsh-sel-head{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 14px;cursor:grab;user-select:none;',
      'border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.22))}',
      '.dsh-sel-head:active{cursor:grabbing}',
      '.dsh-sel-mark{width:7px;height:7px;border-radius:50%;background:var(--sel-a1,#0d9488);flex:0 0 auto}',
      '.dsh-sel-title{font-weight:600;font-size:12.5px;letter-spacing:.2px}',
      // 分节标题右侧的状态提示（检索中/思考尾巴/档位说明）——靠 margin-left:auto 贴右边
      '.dsh-sel-hint{margin-left:auto;font-size:11px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}',
      '.dsh-sel-icon{flex:0 0 auto;width:24px;height:24px;display:grid;place-items:center;border:0;border-radius:8px;cursor:pointer;white-space:nowrap;',
      'background:transparent;color:inherit;font:inherit;opacity:.7}',
      '.dsh-sel-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.16));opacity:1}',
      // 带文字的动作按钮：宽度自适应，避免文字在小方块里错位
      '.dsh-sel-action{flex:0 0 auto;height:24px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center;gap:3px;',
      'border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));border-radius:8px;cursor:pointer;white-space:nowrap;',
      'background:transparent;color:inherit;font:inherit;font-size:11.5px;line-height:1;opacity:.85}',
      '.dsh-sel-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.16));opacity:1}',
      '.dsh-sel-action:disabled{opacity:.4;cursor:default}',
      // 选中文字quote：左侧强调条 + 略暗底
      // 选中文字条：在滚动区里（跟着消息一起滚），左右边距交给 body 的 padding 所以与内容对齐。
      // 可以自动换行、超过 84px 内部滚动，但**不显示滚动条**。
      // ⚠️ flex:0 0 auto 不能省：滚动区是 flex 列，而 overflow 非 visible 的 flex 项目
      //    自动最小高度是 0 → 内容一多就被压扁，文字直接看不全（实测踩过）。
      '.dsh-sel-quote{margin:0;padding:7px 11px;border-radius:10px;flex:0 0 auto;border-left:3px solid var(--sel-a1,#0d9488);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.11));color:var(--dsw-alias-label-secondary,inherit);',
      'font-size:12.5px;line-height:1.6;box-sizing:border-box;max-width:100%;max-height:84px;',
      'overflow-y:auto;overflow-x:hidden;white-space:pre-wrap;word-break:break-word;scrollbar-width:none}',
      '.dsh-sel-quote::-webkit-scrollbar{width:0;height:0;display:none}',
      // 正文区：两节各自成卡片，层次清楚
      '.dsh-sel-body{overflow:auto;padding:12px 14px 14px;display:flex;flex-direction:column;gap:12px;flex:1 1 auto;',
      'scrollbar-width:thin;scrollbar-color:rgba(140,140,140,.35) transparent}',
      '.dsh-sel-body::-webkit-scrollbar{width:9px;height:9px}',
      '.dsh-sel-body::-webkit-scrollbar-track{background:transparent}',
      '.dsh-sel-body::-webkit-scrollbar-thumb{background:rgba(140,140,140,.3);border-radius:9px;border:2px solid transparent;background-clip:content-box}',
      '.dsh-sel-body:hover::-webkit-scrollbar-thumb{background:rgba(140,140,140,.5);background-clip:content-box}',
      '.dsh-sel-sec{border-radius:12px;padding:11px 13px 12px;display:flex;flex-direction:column;gap:9px;',
      'background:var(--dsw-alias-bg-base,rgba(140,140,140,.06));border:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.2));',
      'border-left-width:3px}',
      '.dsh-sel-sec[data-sec=translation]{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.09));border-left-color:var(--sel-a1)}',
      '.dsh-sel-sec[data-sec=detail]{border-left-color:var(--sel-a2)}',
      '.dsh-sel-sh{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;letter-spacing:.5px}',
      '.dsh-sel-sec[data-sec=translation] .dsh-sel-sh{color:var(--sel-a1-text)}',
      '.dsh-sel-sec[data-sec=detail] .dsh-sel-sh{color:var(--sel-a2-text)}',
      '.dsh-sel-sh i{width:3px;height:13px;border-radius:2px;background:currentColor;display:block}',
      '.dsh-sel-sh b{font-weight:600;font-size:11px;opacity:.6}',
      '.dsh-sel-c{font-size:13.5px;line-height:1.82;word-break:break-word;text-wrap:pretty}',
      '.dsh-sel-c p{margin:0 0 10px}',
      '.dsh-sel-c p:last-child{margin-bottom:0}',
      '.dsh-sel-sub{display:flex;align-items:center;gap:7px;font-weight:700;font-size:13.5px;margin:13px 0 6px;',
      'color:var(--sel-a1-text)}',
      '.dsh-sel-sub::before{content:"";width:3px;height:12px;border-radius:2px;background:currentColor;opacity:.85;flex:0 0 auto}',
      '.dsh-sel-sec[data-sec=detail] .dsh-sel-sub{color:var(--sel-a2-text)}',
      '.dsh-sel-c>*:first-child.dsh-sel-sub{margin-top:0}',
      '.dsh-sel-list{display:flex;flex-direction:column;gap:7px;margin:0 0 10px}',
      '.dsh-sel-list:last-child{margin-bottom:0}',
      '.dsh-sel-list[data-level="1"]{margin-left:16px;gap:5px}',
      '.dsh-sel-list[data-level="2"]{margin-left:32px;gap:4px}',
      '.dsh-sel-item{display:flex;gap:9px;align-items:flex-start}',
      '.dsh-sel-item>span:last-child{flex:1 1 auto}',
      // 符号用本节主色：顶层实心、嵌套淡一档，扫一眼就知道层级
      '.dsh-sel-bullet{flex:0 0 auto;width:14px;text-align:right;font-variant-numeric:tabular-nums;line-height:1.8;',
      'color:var(--sel-a1-text);opacity:.9;font-weight:600;font-size:12px}',
      '.dsh-sel-sec[data-sec=detail] .dsh-sel-bullet{color:var(--sel-a2-text)}',
      '.dsh-sel-list[data-level="1"] .dsh-sel-bullet{opacity:.55;font-weight:400}',
      '.dsh-sel-list[data-level="2"] .dsh-sel-bullet{opacity:.38;font-weight:400}',
      '.dsh-sel-item[data-num="1"] .dsh-sel-bullet{width:22px;opacity:.9}',
      '.dsh-sel-quote-line{margin:0 0 9px;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l3,rgba(140,140,140,.4));',
      'opacity:.85}',
      // 翻译节的结论条：「在本句中：…」是重点，高亮呈现
      '.dsh-sel-callout{margin:6px 0 0;padding:9px 11px;border-radius:10px;border-left:3px solid var(--sel-a1);',
      'background:var(--sel-a1-soft);font-size:13.5px;line-height:1.72;font-weight:500}',
      '.dsh-sel-sec[data-sec=detail] .dsh-sel-callout{border-left-color:var(--sel-a2);background:var(--sel-a2-soft)}',
      '.dsh-sel-callout-tag{display:inline-block;margin-right:6px;padding:1px 7px;border-radius:6px;font-size:11px;font-weight:600;',
      'background:var(--sel-fill,#0f766e);color:var(--sel-fill-fg,#fff);vertical-align:1px}',
      '.dsh-sel-sec[data-sec=detail] .dsh-sel-callout-tag{background:var(--sel-fill,#0f766e);color:var(--sel-fill-fg,#fff)}',
      '.dsh-sel-sec[data-sec=translation] .dsh-sel-quote-line{border-left-width:3px;border-radius:8px;padding:8px 11px;opacity:1;',
      'border-left-color:var(--sel-a1);background:var(--sel-a1-soft);font-weight:500}',
      // 对照表格
      '.dsh-sel-tablewrap{overflow-x:auto;margin:2px 0 10px}',
      '.dsh-sel-table{width:100%;border-collapse:collapse;font-size:12.6px;line-height:1.6}',
      '.dsh-sel-table th,.dsh-sel-table td{border:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.3));padding:5px 9px;text-align:left;vertical-align:top}',
      '.dsh-sel-table th{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.12));font-weight:600;white-space:nowrap}',
      '.dsh-sel-table tbody tr:nth-child(even) td{background:rgba(140,140,140,.05)}',
      '.dsh-sel-hr{border:0;border-top:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.28));margin:11px 0}',
      '.dsh-sel-code{padding:1px 5px;border-radius:5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.18))}',
      // 代码配色：--hl-* 由两套调色板提供（浅色 = GitHub Light / 深色 = One Dark 风格）。
      // 用哪套不看 OS 偏好，而是按**面板实际底色**算亮度后打 data-hl —— 主题跟着 App 走，
      // OS 与 App 主题不一致时也不会出现"深底配深字"。
      '.dsh-sel-pre{--hl-kw:#8250df;--hl-str:#0a7d33;--hl-num:#b45309;--hl-com:#8b8f96;--hl-fn:#0a5bd3;--hl-tag:#c2410c;--hl-attr:#b45309;--hl-op:#6b7280;--hl-var:#b45309;--hl-type:#c2410c}',
      '.dsh-sel-pre[data-hl=dark]{--hl-kw:#c678dd;--hl-str:#98c379;--hl-num:#d19a66;--hl-com:#8b949e;--hl-fn:#61afef;--hl-tag:#e06c75;--hl-attr:#d19a66;--hl-op:#9aa0a6;--hl-var:#d19a66;--hl-type:#e5c07b}',
      '@media (prefers-color-scheme:dark){.dsh-sel-pre:not([data-hl]){--hl-kw:#c678dd;--hl-str:#98c379;--hl-num:#d19a66;--hl-com:#8b949e;--hl-fn:#61afef;--hl-tag:#e06c75;--hl-attr:#d19a66;--hl-op:#9aa0a6;--hl-var:#d19a66;--hl-type:#e5c07b}}',
      '.dsh-hl-com{color:var(--hl-com)}',
      '.dsh-sel-pre-line{display:block;white-space:pre;min-height:1.6em}',
      // 注释行折行：续行从 padding 处开始（= 注释起始列），不会跑到注释左边
      '.dsh-sel-pre-line[data-wrap]{white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dsh-sel-pre-cmt{opacity:.78}',
      '.dsh-hl-str{color:var(--hl-str)}',
      '.dsh-hl-num{color:var(--hl-num)}',
      '.dsh-hl-kw{color:var(--hl-kw);font-weight:600}',
      '.dsh-hl-fn{color:var(--hl-fn)}',
      '.dsh-hl-tag{color:var(--hl-tag)}',
      '.dsh-hl-attr{color:var(--hl-attr)}',
      '.dsh-hl-op{color:var(--hl-op)}',
      '.dsh-hl-var{color:var(--hl-var)}',
      '.dsh-hl-type{color:var(--hl-type)}',
      // 网页预览块：工具栏（预览/代码 + 放大）+ 沙箱 iframe
      // 预览要"无感融入"：不画外框、不占一条白底工具栏，工具栏淡淡的、鼠标移上去才清晰
      '.dsh-sel-preview{margin:2px 0 12px;border:0;border-radius:0;overflow:visible;background:transparent}',
      '.dsh-sel-previewbar{display:flex;align-items:center;gap:6px;padding:0 0 5px;border-bottom:0;',
      'font-size:11px;line-height:1.4;opacity:.38;transition:opacity .15s ease}',
      '.dsh-sel-preview:hover .dsh-sel-previewbar{opacity:1}',
      '.dsh-sel-previewtabs{display:flex;gap:2px;flex:1 1 auto;min-width:0}',
      '.dsh-sel-previewtab{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.55;',
      'padding:2px 8px;border-radius:6px;white-space:nowrap}',
      '.dsh-sel-previewtab[data-on="1"]{opacity:1;font-weight:600;background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.16))}',
      '.dsh-sel-previewzoom{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.55;',
      'padding:2px 7px;border-radius:6px;white-space:nowrap}',
      '.dsh-sel-previewzoom:hover,.dsh-sel-previewtab:hover{opacity:.9;background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.12))}',
      // 高度由页面自己上报（见 adaptPreviewHtml 里注入的 hook），初始 320 只是兜底
      '.dsh-sel-previewframe{display:block;width:100%;height:320px;border:0;border-radius:8px;background:#fff;',
      'transition:height .12s ease}',
      '.dsh-sel-preview[data-view="code"] .dsh-sel-previewframe{border-radius:0}',
      // 「放大」档不再是固定 460，而是"面板里能放多高就多高"（面板本身 max-height:78vh）
      // 默认全量：高度由页面内容决定（下面 JS 按上报值设 inline height），**内部不滚动**
      // 点「还原」→ data-full="0"：回到固定高度（320px，超出交给内部滚动，滚动条已隐藏）
      '.dsh-sel-preview[data-full="0"] .dsh-sel-previewframe{height:320px}',
      '.dsh-sel-preview[data-view="code"] .dsh-sel-previewframe{display:none}',
      '.dsh-sel-preview[data-view="preview"] .dsh-sel-pre{display:none}',
      '.dsh-sel-preview .dsh-sel-pre{margin:0;border-radius:0;max-height:320px;overflow:auto}',
      '.dsh-sel-pre{margin:2px 0 10px;padding:9px 11px;border-radius:9px;overflow-x:auto;white-space:pre;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.4px;line-height:1.6;',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.13));border:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.22))}',
      '.dsh-sel-strong{font-weight:600;color:var(--sel-a1-text)}',
      '.dsh-sel-sec[data-sec=detail] .dsh-sel-strong{color:var(--sel-a2-text)}',
      // 行内代码：淡底 + 主色，和加粗术语区分开
      '.dsh-sel-code{color:var(--sel-a1-text)}',
      '.dsh-sel-sec[data-sec=detail] .dsh-sel-code{color:var(--sel-a2-text)}',
      // 追问小窗：气泡 + 输入行
      // 消息排版对齐主会话：用户消息=右对齐圆角气泡；助手消息=整宽无气泡（就是正文）。
      // 之前两者都是气泡，结果"有网页的气泡"和"普通气泡"宽度不一致，观感也跟主会话不像。
      '.dsh-sel-chatlog{display:flex;flex-direction:column;gap:14px}',
      '.dsh-sel-bubble{max-width:100%;padding:0;border:0;background:transparent;border-radius:0;',
      'font-size:13.6px;line-height:1.72;word-break:break-word}',
      '.dsh-sel-bubble-user{margin-left:auto;max-width:min(82%,520px);padding:9px 15px;border-radius:20px;',
      'background:var(--dsw-specific-bubble,var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.16)));',
      'white-space:pre-wrap;word-break:break-word}',
      '.dsh-sel-bubble-bot{align-self:stretch;white-space:normal}',
      '.dsh-sel-bubble-err{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      // 首轮的展开 CTA：跟随内容流，做成"下一步动作"而不是一条孤零零的横条
      '.dsh-sel-expand{margin:0;width:100%;padding:9px 12px;display:flex;align-items:center;justify-content:center;gap:2px;',
      'border:1px solid color-mix(in srgb,var(--sel-a1,#0d9488) 40%,transparent);',
      'border-radius:11px;cursor:pointer;color:var(--sel-a1-text,#0f766e);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.1));',
      'background:color-mix(in srgb,var(--sel-a1,#0d9488) 9%,transparent);',
      'font:inherit;font-size:13px;line-height:1.4;text-align:left;white-space:nowrap}',
      '.dsh-sel-expand:hover{background:color-mix(in srgb,var(--sel-a1,#0d9488) 16%,transparent)}',
      '.dsh-sel-expand:disabled{opacity:.5;cursor:default}',
      '.dsh-sel-expand small{font-size:11.5px;opacity:.72;font-weight:400}',
      // 输入区：仿主会话 composer —— 两行结构（上面输入，下面一行工具），圆角大一些
      '.dsh-sel-ask{position:relative;display:flex;flex-direction:column;gap:6px;margin:0 12px 12px;padding:10px 10px 8px 14px;',
      'border-radius:22px;border:1px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));',
      'background:var(--dsw-alias-bg-base,transparent)}',
      '.dsh-sel-ask:focus-within{border-color:var(--sel-a1,#0d9488)}',
      // 高度由 JS 跟着内容长（autoGrowAskBox）：textarea 自己只会缩在 rows=1 的高度里，
      // 换行之后下面的字就被裁掉了（语音输入时最明显 —— 字是自己长出来的，用户根本没在敲键盘）。
      // 这里给个上限：过了就内部滚动，面板不会被一段长文顶穿。
      '.dsh-sel-askbox{width:100%;min-height:26px;max-height:132px;overflow-y:hidden;resize:none;padding:4px 0 0;',
      'border:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.5;outline:none}',
      // 引用区（composer 第一行之上）：每段一张小卡片，来源一行小字 + 内容一行（超出省略）+ 右侧 ✕。
      // 卡片是**待发送**的引用，发送后整片清空 —— 它属于"这条消息"，不属于会话。
      '.dsh-sel-quotes{display:none;flex-direction:column;gap:4px;max-height:96px;overflow-y:auto;',
      'scrollbar-width:thin;padding:1px 0 0}',
      '.dsh-sel-quotes[data-show="1"]{display:flex}',
      '.dsh-sel-quotechip{display:flex;align-items:center;gap:7px;padding:4px 4px 4px 8px;border-radius:10px;',
      'border-left:2px solid color-mix(in srgb,var(--sel-a1,#0d9488) 55%,transparent);',
      'background:color-mix(in srgb,var(--sel-a1,#0d9488) 7%,transparent)}',
      '.dsh-sel-quotechip-src{flex:0 0 auto;font-size:10.5px;line-height:1.5;opacity:.66;white-space:nowrap;',
      'max-width:96px;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-sel-quotechip-text{flex:1 1 auto;min-width:0;font-size:12px;line-height:1.5;opacity:.9;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-sel-quotechip-x{flex:0 0 auto;width:18px;height:18px;padding:0;border:0;border-radius:9px;cursor:pointer;',
      'background:transparent;color:var(--dsw-alias-label-secondary,inherit);opacity:.5;font:inherit;font-size:11px;',
      'line-height:1;display:inline-flex;align-items:center;justify-content:center}',
      '.dsh-sel-quotechip-x:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.16))}',
      // 气泡里的引用块（用户消息）：引用在上、问题在下 —— 和发出去给模型的那份顺序一致
      '.dsh-sel-bq{display:flex;flex-direction:column;gap:3px;margin-bottom:6px}',
      '.dsh-sel-bqitem{padding:3px 8px;border-radius:8px;border-left:2px solid color-mix(in srgb,var(--sel-a1,#0d9488) 45%,transparent);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.14));font-size:11.5px;line-height:1.55;',
      'opacity:.82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-sel-bqitem b{font-weight:600;opacity:.75;margin-right:5px}',
      // 「引用整条」：贴在助手气泡末尾，**平时不出现**（正文优先），鼠标移到这条消息上才浮出来。
      // 键盘 Tab 也能到（:focus-visible 同样点亮），触屏上另有浮标那条路。
      '.dsh-sel-bubquote{margin-top:7px;display:inline-flex;align-items:center;gap:4px;padding:2px 9px;',
      'border:1px solid transparent;border-radius:9px;background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:11px;line-height:1.6;',
      'opacity:0;transition:opacity .15s ease}',
      '.dsh-sel-bubble:hover .dsh-sel-bubquote,.dsh-sel-bubquote:focus-visible{opacity:.66}',
      '.dsh-sel-bubquote:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.14))}',
      // 下面那行：左侧网页模式（圆形浅底，和主会话的 + 同款），右侧发送（圆形实心）
      // flex-wrap 是给窄屏兜底的：这一行现在有 4 件东西（输出偏好 / 模型 / 麦克风 / 发送），
      // 窄面板下宁可折成两行，也不能把发送键挤出可视区（挤出去就点不到了）。
      '.dsh-sel-asktools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;row-gap:6px}',
      '.dsh-sel-askspace{flex:1 1 auto}',
      // 页眉里的撑开占位（标题与右侧按钮之间）
      '.dsh-sel-headspace{flex:1 1 auto;min-width:8px}',
      // 按钮统一缩小到 26px（原来 32 偏大）；图标 14px
      '.dsh-sel-iconbtn{flex:0 0 auto;height:26px;min-width:26px;padding:0;border:0;border-radius:13px;cursor:pointer;',
      'display:inline-flex;align-items:center;justify-content:center;gap:4px;background:transparent;',
      'color:var(--dsw-alias-label-secondary,inherit)}',
      '.dsh-sel-iconbtn svg{width:14px;height:14px;display:block;flex:0 0 auto}',
      // 模型 + 推理等级（追问档）：一枚胶囊显示「模型 · 等级」，点开向上弹菜单。
      // 和主会话同构（主会话也是「模型名 等级 ⌄」）；菜单朝上是因为 composer 贴着面板底部。
      '.dsh-sel-picker{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));background:transparent;cursor:pointer;',
      'font:inherit;font-size:11.5px;line-height:1;color:inherit;white-space:nowrap;max-width:190px}',
      '.dsh-sel-picker:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.12))}',
      '.dsh-sel-picker-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-sel-picker-tier{color:var(--sel-a1-text,#0f766e);font-weight:600}',
      '.dsh-sel-picker-caret{font-size:9px;opacity:.6}',
      '.dsh-sel-pickermenu{position:absolute;right:10px;bottom:calc(100% + 8px);width:236px;max-width:calc(100% - 20px);',
      'display:none;flex-direction:column;padding:6px;border-radius:12px;z-index:20;',
      'background:var(--dsw-alias-bg-layer-2,#232427);border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));',
      'box-shadow:0 14px 34px rgba(0,0,0,.35)}',
      '.dsh-sel-pickermenu[data-open="1"]{display:flex}',
      '.dsh-sel-pickergroup{padding:5px 8px 3px;font-size:10.5px;opacity:.6}',
      '.dsh-sel-pickerlist{max-height:168px;overflow:auto;display:flex;flex-direction:column;gap:1px}',
      '.dsh-sel-pickerrow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;',
      'font-size:12px;text-align:left;border:0;background:transparent;color:inherit;font-family:inherit}',
      '.dsh-sel-pickerrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.12))}',
      '.dsh-sel-pickerrow[data-on="1"]{font-weight:600}',
      '.dsh-sel-pickerrow .dsh-sel-pickercheck{width:12px;flex:0 0 auto;color:var(--sel-a1-text,#0f766e);font-weight:700}',
      '.dsh-sel-pickerrow .dsh-sel-pickerprov{margin-left:auto;font-size:10.5px;opacity:.55}',
      '.dsh-sel-pickersplit{height:1px;margin:6px 4px;background:var(--dsw-alias-border-l4,rgba(140,140,140,.22))}',
      '.dsh-sel-tiers{display:flex;gap:6px;padding:4px 6px 6px}',
      '.dsh-sel-tierbtn{flex:1 1 0;height:26px;padding:0;border-radius:9px;cursor:pointer;font:inherit;font-size:11.5px;',
      'border:1px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));background:transparent;color:inherit}',
      '.dsh-sel-tierbtn[data-on="1"]{background:var(--sel-fill,#0f766e);border-color:transparent;color:var(--sel-fill-fg,#fff);font-weight:600}',
      '.dsh-sel-pickerhint{padding:2px 8px 6px;font-size:10.5px;opacity:.55;line-height:1.5}',
      // 实测被上游拒过的档位：划一道斜线，别让用户再撞一次
      '.dsh-sel-tierbtn[data-bad="1"]{opacity:.5;text-decoration:line-through}',
      '.dsh-sel-notice{margin:6px 0 0;padding:6px 10px;border-radius:8px;font-size:11.5px;line-height:1.6;',
      'background:var(--sel-warn-bg,rgba(255,166,87,.12));color:var(--sel-warn-fg,#b45309)}',
      // 输出偏好：文字 + **图标分段**（两格：M↓ / ▭，选中格是一枚滑动的药丸）。
      // 不用滑块形状 —— 滑块的语义是"开/关一个能力"，而这里是"两选一"。
      '.dsh-sel-pref{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;line-height:1;',
      'color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}',
      '.dsh-sel-seg{position:relative;flex:0 0 auto;display:inline-flex;align-items:center;padding:2px;border-radius:13px;',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.14))}',
      '.dsh-sel-segpill{position:absolute;top:2px;left:2px;width:30px;height:22px;border-radius:11px;',
      'background:var(--sel-fill,#0f766e);transition:transform .2s cubic-bezier(.3,1.2,.4,1)}',
      '.dsh-sel-pref[data-on="1"] .dsh-sel-segpill{transform:translateX(30px)}',
      '.dsh-sel-segcell{position:relative;z-index:1;width:30px;height:22px;padding:0;border:0;background:transparent;',
      'cursor:pointer;display:inline-flex;align-items:center;justify-content:center;',
      'color:var(--dsw-alias-label-secondary,inherit);opacity:.72}',
      '.dsh-sel-segcell:hover{opacity:1}',
      '.dsh-sel-segcell[aria-checked="true"]{opacity:1;color:var(--sel-fill-fg,#fff)}',
      '.dsh-sel-segcell:focus-visible{outline:2px solid var(--sel-a1,#0d9488);outline-offset:1px;border-radius:11px}',
      '.dsh-sel-segcell svg{width:13px;height:13px;display:block}',
      '.dsh-sel-asksend{width:26px;background:var(--sel-fill,#0f766e);color:var(--sel-fill-fg,#fff);border-radius:13px}',
      '.dsh-sel-asksend:hover{filter:brightness(1.06)}',
      '.dsh-sel-asksend:disabled{opacity:.35;cursor:default;filter:none}',
      // 生成中：发送键变成"停止"（方形图标，点了打断当前输出）
      '.dsh-sel-asksend[data-mode="stop"]{background:var(--dsw-alias-label-secondary,rgba(120,120,120,.9));opacity:1}',
      '.dsh-sel-asksend[data-mode="stop"]:hover{filter:brightness(1.12)}',
      // ── 语音输入（麦克风）──
      // **和主会话同一套交互**（官方 ui-voice-input）：平时是输入框右边的 🎤；
      // 一旦开始录，工具行整个换成"录音行" ——`✕` | 实时波形 | `■`（识别中则是
      // 「识别中…」+ 呼吸点），发送键原位不动。尺寸按小窗的 composer 收成 26px
      // （主会话是 32px），其余结构、图标语义、波形算法都照抄，两处看起来才是同一个东西。
      '.dsh-sel-mic{transition:background .15s ease,color .15s ease}',
      '@keyframes dsh-sel-spin{to{transform:rotate(360deg)}}',
      '.dsh-sel-mic[data-state="requesting"] svg{animation:dsh-sel-spin .9s linear infinite}',
      '.dsh-sel-mic:disabled{cursor:default;opacity:.35}',
      // 录音行：flex:1 让它吃掉中间那截（主会话也是 waveform flex:1）
      '.dsh-sel-capture{display:none;flex:1 1 auto;min-width:0;align-items:center;gap:8px}',
      '.dsh-sel-capture[data-show="1"]{display:flex}',
      // 圆键：和发送键同尺寸、同圆度；浅底 + hover 变深（主会话的 roundButton 也是这套）
      '.dsh-sel-round{flex:0 0 auto;width:26px;height:26px;padding:0;border:0;border-radius:13px;cursor:pointer;',
      'display:inline-grid;place-items:center;background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.14));',
      'color:var(--dsw-alias-label-secondary,inherit)}',
      '.dsh-sel-round:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(140,140,140,.28));',
      'color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-sel-round:disabled{cursor:default;opacity:.35}',
      '.dsh-sel-round svg{width:14px;height:14px;display:block}',
      // 停止键：图标是实心方块（主会话的 IconStopFill），颜色取主文字色 —— 一眼是"停"
      '.dsh-sel-stop{color:var(--dsw-alias-label-primary,inherit)}',
      // 波形：80 根竖线、中间对齐、静音时是一条虚线（算法与主会话逐行一致，见 paintWave）
      '.dsh-sel-vwave{flex:1 1 auto;min-width:24px;height:24px;display:block;color:var(--dsw-alias-label-secondary,inherit)}',
      // 状态文案（请允许使用麦克风… / 识别中… / 没听清…）：12px 次要色 + 可选呼吸点
      '.dsh-sel-vactivity{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.4;',
      'color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-sel-vdot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--sel-a1,#0d9488);',
      'animation:dsh-sel-pillpulse 1.4s ease-in-out infinite}',
      '.dsh-sel-vactivity[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsh-sel-vactivity[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.dsh-sel-vactslot{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px}',
      '.dsh-sel-vactslot:empty{display:none}',
      // 行内动作（准备模型 / 重新录音）：主会话是同款的 inlineAction
      '.dsh-sel-vact{flex:0 0 auto;height:22px;padding:0 9px;border:1px solid currentColor;border-radius:11px;cursor:pointer;',
      'background:transparent;color:inherit;font:inherit;font-size:11px;line-height:1;opacity:.85;white-space:nowrap}',
      '.dsh-sel-vact:hover{opacity:1}',
      '.dsh-sel-vact:disabled{opacity:.4;cursor:default}',
      '.dsh-sel-askbox:focus{border-color:var(--sel-a1,#0d9488)}',
      // 内容区里的「重新生成」：只在没有可用结果（失败 / 已停止 / 空回答）时出现
      '.dsh-sel-retry{margin-top:8px;border:1px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));background:transparent;',
      'color:var(--sel-a1-text,#0f766e);font:inherit;font-size:12.5px;cursor:pointer;padding:5px 12px;border-radius:9px}',
      '.dsh-sel-retry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.14))}',
      // 等待特效：呼吸点 + 文案 + 实时秒数 + 慢速流光（首字到达前一直显示）
      // 节奏刻意放慢（2.4s 一轮）：快节奏的流光看起来像"闪烁/花屏"，慢下来才是"在跑"
      // 工具调用不落进小窗：查询词/命中字数/链接/耗时都不渲染。
      // 小窗里只允许出现模型消化后的结果，检索过程最多在等待提示里写一句"正在检索资料"。
      '.dsh-sel-link{color:var(--sel-a1-text,#0f766e);text-decoration:underline;word-break:break-all;font-size:12px}',
      '.dsh-sel-c a{color:var(--sel-a1-text,#0f766e)}',
      '.dsh-sel-note{opacity:.6;font-size:12px;line-height:1.6}',
      // 「最近聊过的」：独立浮层卡片，贴在面板侧边（B 方案），不和消息共用滚动区
      '.dsh-sel-history{position:fixed;display:none;flex-direction:column;gap:4px;padding:8px 9px;border-radius:12px;box-sizing:border-box;',
      'overflow:auto;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);',
      'border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));box-shadow:0 14px 36px rgba(0,0,0,.26);',
      'font:400 13px/1.6 ' + FONT + ';pointer-events:auto}',
      '.dsh-sel-historytitle{font-size:11.5px;opacity:.6;margin-bottom:2px}',
      '.dsh-sel-historyempty{font-size:12px;opacity:.5;padding:2px 0}',
      '.dsh-sel-historyrow{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:7px;cursor:pointer}',
      '.dsh-sel-historyrow{position:relative}',
      '.dsh-sel-historyrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.18))}',
      // 删除键：默认隐形，鼠标移到这一行（或键盘聚焦）才出现 —— 不误触、不抢视线
      '.dsh-sel-historydel{position:absolute;top:5px;right:6px;width:20px;height:20px;padding:0;border:0;border-radius:6px;',
      'display:grid;place-items:center;cursor:pointer;opacity:0;transition:opacity .12s ease;',
      'background:var(--dsw-alias-bg-layer-3,rgba(140,140,140,.22));color:inherit;font:inherit;font-size:12px;line-height:1}',
      '.dsh-sel-historyrow:hover .dsh-sel-historydel,.dsh-sel-historydel:focus-visible{opacity:1}',
      '.dsh-sel-historydel:hover{background:var(--sel-warn-bg,rgba(220,80,80,.22));color:var(--sel-warn-fg,#b42318)}',
      '.dsh-sel-historytext{padding-right:22px}', // 给删除键留位置，标题不钻到它下面
      '.dsh-sel-undo{display:flex;align-items:center;gap:8px;margin:4px 6px 2px;padding:6px 8px;border-radius:8px;',
      'background:var(--sel-warn-bg,rgba(255,166,87,.14));color:var(--sel-warn-fg,#b45309);font-size:11.5px;line-height:1.4}',
      '.dsh-sel-undo button{margin-left:auto;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;text-decoration:underline}',
      '.dsh-sel-historytext{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-sel-historymeta{display:flex;align-items:center;gap:6px;font-size:11px;opacity:.5;font-variant-numeric:tabular-nums;min-width:0}',
      '.dsh-sel-historymeta>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-sel-historymeta .dsh-sel-historypin{opacity:.9}',
      // 悬浮状态胶囊：样式对齐右下角那枚费用胶囊（dsh-spend），摆在它上方
      // 逐项对齐 dsh-spend 的 .dsu-pill：同样的 padding / 字号 / 行高 / 边框 / 圆角 / 阴影，
      // 连小三角都用同一个字符 ▴ ▾（以前用 ▲ ▼，比它大一圈、也不一样淡）
      '.dsh-sel-pill{position:fixed;right:20px;bottom:64px;z-index:' + String(Z_BTN) + ';display:flex;align-items:center;gap:8px;',
      'box-sizing:border-box;padding:6px 14px;border-radius:999px;cursor:pointer;user-select:none;max-width:280px;white-space:nowrap;',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#24292f);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));box-shadow:0 4px 16px rgba(0,0,0,.12);',
      'font-family:inherit;font-size:12px;line-height:18px;font-weight:400;transition:box-shadow .15s ease}',
      '.dsh-sel-pill:hover{box-shadow:0 6px 22px rgba(0,0,0,.18)}',
      '.dsh-sel-pill[data-open="1"]{border-color:color-mix(in srgb,var(--sel-a1,#0d9488) 55%,transparent)}',
      '.dsh-sel-pilldot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8c959f)}',
      '.dsh-sel-pill[data-tone=busy] .dsh-sel-pilldot{background:var(--sel-a1,#0d9488);animation:dsh-sel-pillpulse 1.5s ease-in-out infinite}',
      '.dsh-sel-pill[data-tone=done] .dsh-sel-pilldot{background:var(--sel-a1,#0d9488)}',
      '.dsh-sel-pill[data-tone=error] .dsh-sel-pilldot{background:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsh-sel-pill[data-tone=paused] .dsh-sel-pilldot{background:#d97706}',
      '@keyframes dsh-sel-pillpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}',
      // 三段的明暗节奏也照抄：主体加粗、次要信息 --secondary、箭头 --tertiary
      // 宽度由 JS 固定成下面那枚费用胶囊的宽度，所以文字必须自己让位：
      // 名字那格可缩可省略，状态那格和箭头不缩（状态比"选中的是哪个词"更该看见）
      '.dsh-sel-pillname{flex:0 1 auto;min-width:0;font-weight:600;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-sel-pillmeta{flex:0 0 auto;color:var(--dsw-alias-label-secondary,#57606a);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsh-sel-pillcaret{flex:none;color:var(--dsw-alias-label-tertiary,#8c959f)}',
      '.dsh-sel-historypin{flex:0 0 auto;font-size:10.5px;padding:1px 6px;border-radius:6px;opacity:.8;',
      'background:color-mix(in srgb,var(--sel-a1,#0d9488) 16%,transparent)}',
      '.dsh-sel-wait{display:flex;flex-direction:column;gap:10px;padding:2px 0}',
      '.dsh-sel-waitline{display:flex;align-items:center;gap:7px;font-size:12.5px;opacity:.72;letter-spacing:.2px}',
      '.dsh-sel-dots{display:inline-flex;align-items:center;gap:4px}',
      '.dsh-sel-dots i{display:block;width:5px;height:5px;border-radius:50%;background:var(--sel-a1,#0d9488);',
      'animation:dsh-sel-blink 1.6s ease-in-out infinite}',
      '.dsh-sel-dots i:nth-child(2){animation-delay:.22s}',
      '.dsh-sel-dots i:nth-child(3){animation-delay:.44s}',
      '.dsh-sel-waitclock{font-variant-numeric:tabular-nums;opacity:.72;font-size:11.5px}',
      '.dsh-sel-waithint{font-size:11.5px;opacity:.5;margin-top:-3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-sel-sk{height:8px;border-radius:5px;background:linear-gradient(90deg,rgba(140,140,140,.10),rgba(140,140,140,.24),rgba(140,140,140,.10));',
      'background-size:220% 100%;animation:dsh-sel-shim 2.4s ease-in-out infinite}',
      '.dsh-sel-skrow{display:flex;flex-direction:column;gap:7px;padding:1px 0}',
      '@keyframes dsh-sel-shim{0%{background-position:130% 0}100%{background-position:-130% 0}}',
      '@keyframes dsh-sel-blink{0%,100%{opacity:.24;transform:translateY(0)}45%{opacity:.95;transform:translateY(-2px)}}',
      '.dsh-sel-err{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12.5px;white-space:pre-wrap}',
      '@media (prefers-reduced-motion:reduce){.dsh-sel-sk{animation:none}.dsh-sel-dots i{animation:none;opacity:.6}',
      '.dsh-sel-btn{transition:none}.dsh-sel-btn[data-pop="1"]{animation:none}}',
    ].join('')

    // ────────────────────── Markdown 轻渲染（全 DOM，无 innerHTML） ──────────────────────

    /** 行内解析：**加粗** 与 `代码`。 */
    function appendInline(parent, text) {
      // 加粗 / 行内代码 / markdown 链接 / 裸链接
      var re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>"'）】]+)/g
      var last = 0
      var match
      while ((match = re.exec(text)) !== null) {
        if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)))
        var token = match[0]
        if (token.indexOf('**') === 0) {
          parent.appendChild(el('strong', 'dsh-sel-strong', token.slice(2, -2)))
        } else if (token.charAt(0) === '`') {
          parent.appendChild(el('code', 'dsh-sel-code', token.slice(1, -1)))
        } else if (token.charAt(0) === '[') {
          var split = token.lastIndexOf('](')
          var label = token.slice(1, split)
          var href = token.slice(split + 2, -1)
          var link = el('a', 'dsh-sel-link', label)
          link.setAttribute('href', href)
          link.setAttribute('target', '_blank')
          link.setAttribute('rel', 'noopener noreferrer')
          parent.appendChild(link)
        } else {
          var bare = el('a', 'dsh-sel-link', token.replace(/[.,;]+$/, ''))
          bare.setAttribute('href', token.replace(/[.,;]+$/, ''))
          bare.setAttribute('target', '_blank')
          bare.setAttribute('rel', 'noopener noreferrer')
          parent.appendChild(bare)
        }
        last = match.index + token.length
      }
      if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)))
    }

    /**
     * 块级渲染：段落 / 多级无序与有序列表 / 小标题 / 引用 / 分隔线。
     * 列表按缩进分级（每 2 空格一级，最多 2 级），有序项保留原编号并右对齐，
     * 让小标题、要点、正文之间的层次在面板里一眼可辨。
     */
    /**
     * 剥掉「- **<选中文字>**：内容」这种回声前缀。
     * 翻译节里模型常把选中文字本身当成词条再译一遍；当加粗前缀与选中文字一致时，
     * 直接把它去掉、只留内容（避免「选中文字 → 选中文字」的重复）。
     */
    function stripEchoPrefix(text, selected) {
      var target = normalizeSpace(selected || '')
      if (!target) return text
      return String(text || '')
        .split('\n')
        .map(function (line) {
          var match = /^\s*-\s*\*\*(.+?)\*\*\s*[:：]\s*(.*)$/.exec(line)
          if (!match) return line
          var head = normalizeSpace(match[1])
          if (head !== target && head.indexOf(target) !== 0 && target.indexOf(head) !== 0) return line
          if (head.length < 2 || Math.abs(head.length - target.length) > Math.max(4, target.length * 0.4)) return line
          return match[2]
        })
        .join('\n')
    }

    /** 「在本句中：xxx」这类结论行 → 高亮结论条（带标签胶囊）。 */
    var CALLOUT_RE = /^(?:\*\*)?\s*(在(?:本|此)句(?:中|里)?|在(?:本|此)段(?:中|里)?|在上文(?:中)?|小结|总结|结论)\s*[:：]\s*(?:\*\*)?\s*([\s\S]*)$/

    function calloutNode(label, body) {
      var box = el('div', 'dsh-sel-callout')
      box.appendChild(el('span', 'dsh-sel-callout-tag', label))
      var span = el('span')
      appendInline(span, body)
      box.appendChild(span)
      return box
    }

    /** 表格分隔行：|---|:---:|---| */
    function isTableSeparator(line) {
      return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line) && line.indexOf('-') >= 0
    }

    function splitRow(line) {
      var body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
      return body.split('|').map(function (cell) {
        return cell.trim()
      })
    }

    /** 渲染 Markdown 表格；返回消费到的行号（不含）。 */
    function renderTable(parent, lines, start) {
      var head = splitRow(lines[start])
      var rows = []
      var i = start + 2
      while (i < lines.length && lines[i].trim().indexOf('|') >= 0) {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      var wrap = el('div', 'dsh-sel-tablewrap')
      var table = el('table', 'dsh-sel-table')
      var thead = el('thead')
      var headRow = el('tr')
      for (var h = 0; h < head.length; h++) {
        var th = el('th')
        appendInline(th, head[h])
        headRow.appendChild(th)
      }
      thead.appendChild(headRow)
      table.appendChild(thead)
      var tbody = el('tbody')
      for (var r = 0; r < rows.length; r++) {
        var tr = el('tr')
        for (var c = 0; c < head.length; c++) {
          var td = el('td')
          appendInline(td, rows[r][c] === undefined ? '' : rows[r][c])
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      wrap.appendChild(table)
      parent.appendChild(wrap)
      return i
    }

    // ────────────────────── 语法高亮（代码块专用，无第三方依赖） ──────────────────────

    /** 围栏语言标记 → 家族。未知语言退回 auto（按内容猜）。 */
    var HL_FAMILY = {
      js: 'c', javascript: 'c', jsx: 'c', mjs: 'c', cjs: 'c', ts: 'c', typescript: 'c', tsx: 'c',
      java: 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c', c: 'c', cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c',
      cs: 'c', csharp: 'c', php: 'c', swift: 'c', kotlin: 'c', kt: 'c', scala: 'c', dart: 'c', groovy: 'c',
      py: 'py', python: 'py', rb: 'py', ruby: 'py',
      sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellsession: 'sh', powershell: 'sh', ps1: 'sh',
      sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql', plsql: 'sql',
      html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
      css: 'css', scss: 'css', sass: 'css', less: 'css',
      json: 'json', jsonc: 'json', json5: 'json',
      yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml',
      md: 'plain', markdown: 'plain', text: 'plain', txt: 'plain', plain: 'plain', log: 'plain', diff: 'plain',
    }

    /** 各家族的关键字（只用于上色，不求完备）。 */
    var HL_WORDS = {
      c: 'const let var function return if else for while do switch case default break continue new delete typeof instanceof in of class extends super this try catch finally throw await async yield void export import from as static public private protected interface enum implements readonly namespace declare abstract type null undefined true false NaN Infinity get set',
      py: 'def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda yield global nonlocal pass break continue assert del async await match case self print len range',
      sh: 'if then else elif fi for while until do done case esac function return in export local readonly unset shift source alias echo cd exit set sudo npm pnpm yarn npx git docker kubectl curl wget cat grep awk sed head tail chmod mkdir rm cp mv touch find xargs export',
      sql: 'select from where group by having order limit offset insert into values update set delete create alter drop table index view join left right inner outer full on as and or not null is in like between distinct union all exists asc desc primary key foreign references default case when then end',
      json: 'true false null',
      yaml: 'true false null yes no on off',
      css: '',
      html: '',
      plain: '',
    }

    /** 没有语言标记时按内容猜一个家族。 */
    function guessFamily(code) {
      var t = String(code || '')
      if (/^\s*#!/.test(t)) return 'sh'
      if (/<(!doctype|html|div|span|p|a|br|img|script|style|template)\b/i.test(t)) return 'html'
      if (/^\s*[.#@]?[a-zA-Z-]+\s*\{[^}]*:[^}]*;?/m.test(t) && t.indexOf('{') >= 0 && t.indexOf(':') >= 0 && !/=>|function|const |let /.test(t)) return 'css'
      if (/\b(def |import |from |elif |self\b|print\()/.test(t) && /:\s*$/m.test(t)) return 'py'
      if (/\b(select|insert into|update|delete from|create table)\b/i.test(t)) return 'sql'
      if (/^\s*[{[][\s\S]*"[^"]+"\s*:/m.test(t) && !/function|=>|;/.test(t)) return 'json'
      // shell：有 fi/done/esac 收尾，或"命令 + 选项"的行
      if (/\b(fi|done|esac)\b/.test(t) && /^\s*(if|then|elif|else|for|while|do|case|until)\b/m.test(t)) return 'sh'
      if (/^\s*(?:[a-z]+\s+-{1,2}[A-Za-z]|if\s+\[|export\s+\w+=|echo\s)/m.test(t)) return 'sh'
      if (/\b(function|const|let|var|return|class|import|export|async|await)\b|=>/.test(t)) return 'c'
      if (/^-{3}\s*$/m.test(t) && /^\s*[\w-]+:\s/m.test(t)) return 'yaml'
      return 'c'
    }

    /** 行注释起始判断（按家族）。 */
    function commentStartAt(line, i, family) {
      var rest = line.slice(i)
      if (family === 'py' || family === 'sh' || family === 'yaml') return rest.charAt(0) === '#'
      if (family === 'sql') return rest.slice(0, 2) === '--'
      if (family === 'html') return rest.slice(0, 4) === '<!--'
      if (family === 'json') return rest.slice(0, 2) === '//'
      return rest.slice(0, 2) === '//' // c / css 默认
    }

    /**
     * 逐行扫描出 token：com / str / num / kw / fn / type / attr / var / op / plain。
     * 只求"一眼看得懂"，不追求编译器级正确。
     */
    function tokenizeCodeLine(line, family, words, state) {
      var tokens = []
      var i = 0
      function push(cls, text) {
        if (!text) return
        if (cls === 'plain') {
          var last = tokens[tokens.length - 1]
          if (last && last.cls === 'plain') {
            last.text += text
            return
          }
        }
        tokens.push({ cls: cls, text: text })
      }
      function nextChar(skipSpace) {
        var j = i
        if (skipSpace) while (j < line.length && line.charAt(j) === ' ') j += 1
        return line.charAt(j)
      }
      while (i < line.length) {
        if (state.block) {
          var close = line.indexOf('*/', i)
          if (close < 0) {
            push('com', line.slice(i))
            i = line.length
            break
          }
          push('com', line.slice(i, close + 2))
          i = close + 2
          state.block = false
          continue
        }
        var ch = line.charAt(i)
        var start = i
        if (commentStartAt(line, i, family)) {
          push('com', line.slice(i))
          i = line.length
          break
        }
        if ((family === 'c' || family === 'css' || family === 'json') && line.slice(i, i + 2) === '/*') {
          state.block = true
          i += 2
          push('com', '/*')
          continue
        }
        if (family === 'html' && ch === '<') {
          var gt = line.indexOf('>', i)
          if (gt < 0) {
            push('tag', line.slice(i))
            i = line.length
            break
          }
          push('tag', line.slice(i, gt + 1))
          i = gt + 1
          continue
        }
        if (ch === '"' || ch === "'" || (ch === '`' && family !== 'sql')) {
          i += 1
          while (i < line.length) {
            if (line.charAt(i) === '\\') {
              i += 2
              continue
            }
            if (line.charAt(i) === ch) {
              i += 1
              break
            }
            i += 1
          }
          var text2 = line.slice(start, i)
          // JSON 的键：紧跟冒号的字符串单独上色
          push(family === 'json' && line.slice(i).replace(/\s+/, '').charAt(0) === ':' ? 'attr' : 'str', text2)
          continue
        }
        if (ch >= '0' && ch <= '9' && !/[A-Za-z0-9_$]/.test(line.charAt(i - 1) || '')) {
          i += 1
          while (i < line.length && /[0-9a-fA-FxXoO._]/.test(line.charAt(i))) i += 1
          while (i < line.length && /[eE][+-]?[0-9]/.test(line.slice(i, i + 3)) ) i += 2
          push('num', line.slice(start, i))
          continue
        }
        if (ch === '$' && family === 'sh') {
          i += 1
          if (line.charAt(i) === '{') {
            var close2 = line.indexOf('}', i)
            i = close2 < 0 ? line.length : close2 + 1
          } else {
            while (i < line.length && /[A-Za-z0-9_?@*#!$]/.test(line.charAt(i))) i += 1
          }
          push('var', line.slice(start, i))
          continue
        }
        if (/[A-Za-z_$@#]/.test(ch)) {
          i += 1
          while (i < line.length && /[A-Za-z0-9_$-]/.test(line.charAt(i))) i += 1
          var word = line.slice(start, i)
          var bare = word.replace(/^[@#$]/, '')
          var after = nextChar(true)
          var cls = 'plain'
          if (bare && words[bare.toLowerCase()] === 1 && (family !== 'c' || /^[A-Za-z_$]/.test(ch))) cls = 'kw'
          else if (after === '(') cls = 'fn'
          else if (family === 'c' && /^[A-Z]/.test(word) && word.length > 1) cls = 'type'
          else if (family === 'css' && (line.charAt(start - 1) === '.' || line.charAt(start - 1) === '#')) cls = 'type'
          else if (family === 'css' && after === ':') cls = 'attr'
          else if (family === 'json' && line.charAt(i) === '"') cls = 'attr'
          push(cls, word)
          continue
        }
        if (/[{}()[\];,.:=+\-*/%<>!&|^~?]/.test(ch)) {
          i += 1
          push('op', line.slice(start, i))
          continue
        }
        i += 1
        push('plain', line.slice(start, i))
      }
      return tokens
    }

    /**
     * 把一段代码按行高亮成节点（每行一个数组，tokens 为 {cls,text}）。
     * 语言标记认不出来时按内容猜。
     */
    function highlightCode(code, lang) {
      var family = HL_FAMILY[String(lang || '').toLowerCase()] || guessFamily(code)
      var words = {}
      var list = (HL_WORDS[family] || '').split(' ')
      for (var w = 0; w < list.length; w += 1) if (list[w]) words[list[w]] = 1
      var lines = String(code).split('\n')
      var state = { block: false }
      var out = []
      for (var i = 0; i < lines.length; i += 1) out.push({ line: lines[i], tokens: tokenizeCodeLine(lines[i], family, words, state) })
      return { family: family, lines: out }
    }

    /** 解析 rgb()/rgba() → [r,g,b,a]；解析不了返回 null。 */
    function parseColor(value) {
      var m = /rgba?\(([^)]+)\)/.exec(String(value || ''))
      if (!m) return null
      var parts = m[1].split(',').map(function (piece) { return parseFloat(piece) })
      if (parts.length < 3) return null
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]
    }

    /**
     * 算出代码块**实际看到的底色**（逐层向上把半透明背景叠起来），再判深浅。
     * 这样主题怎么实现都不影响：只看最终颜色。
     */
    function isDarkSurface(node) {
      try {
        // 先收集祖先链上的背景层（元素 → 根），再**从最底层往上叠**（画家算法）——
        // 顺序反了的话，元素自己的半透明底色会先叠在"白"上，深色主题也会算成浅色
        var layers = []
        var current = node
        for (var depth = 0; current && depth < 12; depth += 1) {
          var background = parseColor(getComputedStyle(current).backgroundColor)
          if (background && background[3] > 0) layers.push(background)
          current = current.parentElement
        }
        var r = 255
        var g = 255
        var b = 255
        for (var i = layers.length - 1; i >= 0; i -= 1) {
          var a = layers[i][3]
          r = layers[i][0] * a + r * (1 - a)
          g = layers[i][1] * a + g * (1 - a)
          b = layers[i][2] * a + b * (1 - a)
        }
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140
      } catch (error) {
        return false
      }
    }

    /**
     * 高亮结果 → <pre> 内容（注释整体弱化，代码着色）。
     *
     * 每行单独成块：**注释行允许折行**（不横向溢出小窗），代码行保持 `pre` 不折
     * （长代码宁可横向滚动，也不要被折断成看不懂的形状）。
     */
    function paintHighlight(pre, code, lang) {
      pre.setAttribute('data-hl', isDarkSurface(pre) ? 'dark' : 'light')
      var hi = highlightCode(code, lang)
      for (var i = 0; i < hi.lines.length; i += 1) {
        var tokens = hi.lines[i].tokens
        // 整行是否只有注释（空白 + 注释）→ 整行可折行
        var commentOnly = tokens.length > 0
        for (var k = 0; k < tokens.length; k += 1) {
          if (tokens[k].cls !== 'com' && !(tokens[k].cls === 'plain' && !tokens[k].text.trim())) {
            commentOnly = false
            break
          }
        }
        if (commentOnly) {
          var first = 0
          for (var f = 0; f < tokens.length; f += 1) {
            if (tokens[f].cls === 'com') {
              first = f
              break
            }
          }
          pre.appendChild(codeLine(tokens, commentColumn(tokens, first), true))
          continue
        }
        // 代码 + 行尾注释：注释拆成独立的注释行（缩进 = 它在原行的起始列），
        // 这样折行后的续行一定与注释左对齐，而不会跑到代码左边去
        var cut = -1
        for (var c = 0; c < tokens.length; c += 1) {
          if (tokens[c].cls === 'com') {
            cut = c
            break
          }
        }
        if (cut < 0) {
          pre.appendChild(codeLine(tokens, -1, false))
          continue
        }
        pre.appendChild(codeLine(tokens.slice(0, cut), -1, false))
        pre.appendChild(codeLine(tokens.slice(cut), commentColumn(tokens, cut), true))
      }
    }

    /** 一行里第 index 个 token 之前累计的字符数（= 它的起始列，用于注释缩进）。 */
    function commentColumn(tokens, index) {
      var column = 0
      for (var i = 0; i < index && i < tokens.length; i += 1) column += tokens[i].text.length
      return column
    }

    /**
     * 造一个"行块"。
     *
     * indent > 0 表示这是注释行：`padding-left` 把整块右移 indent 个字符宽，
     * `text-indent` 负值再把**首行**拉回原处 —— 于是首行落在注释原本的列上，
     * 而**折行后的续行**从 padding 处开始，正好与注释左对齐（不会跑到注释左边）。
     * indent 上限 12ch：真实代码里注释缩进再深也不该把正文顶出小窗。
     */
    function codeLine(tokens, indent, wrap) {
      var line = el('div', 'dsh-sel-pre-line')
      var pad = indent > 0 ? Math.min(indent, 12) : 0
      // 注释行一律可折行（缩进为 0 的注释也要折），代码行不折
      if (wrap === true || pad > 0) line.setAttribute('data-wrap', '1')
      if (pad > 0) {
        line.style.paddingLeft = pad + 'ch'
        line.style.textIndent = '-' + pad + 'ch'
      }
      for (var t = 0; t < tokens.length; t += 1) {
        var token = tokens[t]
        if (token.cls === 'plain') line.appendChild(document.createTextNode(token.text))
        // 注释额外挂 .dsh-sel-pre-cmt：批注清单里注释整体再压一档
        else line.appendChild(el('span', token.cls === 'com' ? 'dsh-hl-com dsh-sel-pre-cmt' : 'dsh-hl-' + token.cls, token.text))
      }
      return line
    }

    /**
     * 这段围栏内容能不能直接当网页渲染：html/htm/xhtml/svg 标了语言就算；
     * 没标语言时，只有"看起来是一份完整文档"（doctype 或 <html> 且有 </html>）才当网页，
     * 免得把随手写的 `<div>` 片段也塞进 iframe。
     */
    function looksLikeWebPage(lang, code) {
      var l = String(lang || '').toLowerCase()
      if (l === 'html' || l === 'htm' || l === 'xhtml' || l === 'svg') return true
      var text = String(code || '')
      return (/<!doctype\s+html|<html[\s>]/i.test(text) && /<\/html>/i.test(text))
    }

    /**
     * 网页预览块：工具栏（预览 / 代码 / 放大）+ 沙箱 iframe + 源码。
     *
     * 安全：iframe 只给 `allow-scripts`，**刻意不给 `allow-same-origin`**——
     * 于是预览里的脚本跑在不透明源里：能算、能画、能发请求，但读不到本页的
     * DOM / Cookie / localStorage，也不能导航顶层窗口（沙箱不加 allow-top-navigation）。
     */
    /**
     * D：给预览页注入"窄容器自适应"的几条基础规则。
     *
     * 模型给的页面常按 1000~1200px 排版，塞进 445px 只能左右拖——这几条让它自己回流：
     * 图片/表格不超宽、代码块内部滚动、body 不横向溢出。
     * **必须插在 doctype 之后**（插到前面会把文档推进怪异模式，页面会变形）。
     */
    function adaptPreviewHtml(code, previewId) {
      var reset =
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<style data-dsh-preview-reset>' +
        'html,body{max-width:100%;overflow-x:hidden}' +
        'img,svg,video,canvas{max-width:100%;height:auto}' +
        'table{max-width:100%}' +
        'pre{max-width:100%;overflow-x:auto}' +
        // 内置滚动条很碍眼：高度会由页面自己上报（见下面的 hook），所以平时根本不需要它
        'html{scrollbar-width:none}' +
        '::-webkit-scrollbar{width:0;height:0}' +
        '</style>' +
        // 页面把自身高度报给父窗口 → iframe 直接长到内容那么高，框里就不会出现滚动条
        '<scr' + 'ipt data-dsh-preview-hook>' +
        '(function(){var id=' + JSON.stringify(previewId || '') + ';var last=-1;' +
        'function report(){var d=document.documentElement,b=document.body;' +
        'var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0,d?d.offsetHeight:0,b?b.offsetHeight:0);' +
        'if(!h||Math.abs(h-last)<4)return;last=h;' +
        'try{parent.postMessage({__dshPreview:true,id:id,h:h},"*")}catch(e){}}' +
        'report();document.addEventListener("DOMContentLoaded",report);window.addEventListener("load",report);' +
        'setTimeout(report,120);setTimeout(report,600);' +
        'try{new ResizeObserver(report).observe(document.documentElement)}catch(e){}' +
        'window.addEventListener("resize",report);})();' +
        '</scr' + 'ipt>'
      var text = String(code || '')
      var doctype = /^\s*<!doctype[^>]*>/i.exec(text)
      if (doctype) {
        var cut = doctype.index + doctype[0].length
        return text.slice(0, cut) + reset + text.slice(cut)
      }
      var html = /^\s*<html[^>]*>/i.exec(text)
      if (html) {
        var cut2 = html.index + html[0].length
        return text.slice(0, cut2) + reset + text.slice(cut2)
      }
      return reset + text
    }

    /** 预览帧登记表：id → { frame }，用于把"页面上报的高度"对回正确的 iframe。 */
    var previewSeq = 0
    var previewFrames = {}

    function registerPreviewFrame(frame) {
      previewSeq += 1
      var id = 'pv' + previewSeq
      previewFrames[id] = { frame: frame }
      // 每次重绘都会产生新帧，顺手把已经脱离文档的旧帧清掉，避免表无限长大
      for (var key in previewFrames) {
        if (!Object.prototype.hasOwnProperty.call(previewFrames, key)) continue
        var item = previewFrames[key]
        if (item.frame !== frame && item.frame.isConnected === false) delete previewFrames[key]
      }
      return id
    }

    /**
     * 按当前模式给 iframe 定高。
     *
     * - 全量（默认）：高度 = 页面上报的内容高度（内部不滚动，整页跟着消息区滚）；
     * - 还原：清掉 inline 高度，交给 CSS 的固定 320px（超出走内部滚动，滚动条已隐藏）。
     */
    function applyPreviewHeight(frame, wrap) {
      var full = !wrap || wrap.getAttribute('data-full') !== '0'
      var reported = Number(frame.getAttribute('data-preview-h')) || 0
      if (!full) {
        frame.style.height = ''
        return
      }
      if (reported > 0) {
        // 上限只是防病态页面（几万像素）把消息区撑爆
        frame.style.height = Math.min(reported, 6000) + 'px'
      }
    }

    function webPreviewBlock(code) {
      var wrap = el('div', 'dsh-sel-preview')
      wrap.setAttribute('data-view', 'preview')
      // 默认全量展示整页；点「还原」切回固定高度（内部滚动）
      wrap.setAttribute('data-full', '1')

      var bar = el('div', 'dsh-sel-previewbar')
      var tabs = el('div', 'dsh-sel-previewtabs')
      var previewTab = el('button', 'dsh-sel-previewtab', '预览')
      var codeTab = el('button', 'dsh-sel-previewtab', '代码')
      previewTab.type = 'button'
      codeTab.type = 'button'
      tabs.appendChild(previewTab)
      tabs.appendChild(codeTab)
      var zoomBtn = el('button', 'dsh-sel-previewzoom', '⤡ 还原')
      zoomBtn.type = 'button'
      zoomBtn.title = '还原成固定高度（网页内部自己滚动）'
      bar.appendChild(tabs)
      bar.appendChild(zoomBtn)

      var frame = document.createElement('iframe')
      frame.className = 'dsh-sel-previewframe'
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      frame.setAttribute('title', '网页预览')
      var previewId = registerPreviewFrame(frame)
      frame.setAttribute('data-preview-id', previewId)
      frame.setAttribute('srcdoc', adaptPreviewHtml(code, previewId))

      var pre = el('pre', 'dsh-sel-pre')
      var view = el('div', 'dsh-sel-previewbody')
      view.appendChild(frame)
      view.appendChild(pre)
      wrap.appendChild(bar)
      wrap.appendChild(view)

      function syncTabs() {
        var on = wrap.getAttribute('data-view')
        previewTab.setAttribute('data-on', on === 'preview' ? '1' : '0')
        codeTab.setAttribute('data-on', on === 'code' ? '1' : '0')
      }
      function switchTo(next) {
        wrap.setAttribute('data-view', next)
        syncTabs()
      }
      listen(previewTab, 'click', function (event) {
        event.stopPropagation()
        switchTo('preview')
      })
      listen(codeTab, 'click', function (event) {
        event.stopPropagation()
        switchTo('code')
      })
      listen(zoomBtn, 'click', function (event) {
        event.stopPropagation()
        var full = wrap.getAttribute('data-full') !== '0'
        var next = full ? '0' : '1'
        wrap.setAttribute('data-full', next)
        zoomBtn.textContent = next === '1' ? '⤡ 还原' : '⤢ 全量'
        zoomBtn.title =
          next === '1' ? '还原成固定高度（网页内部自己滚动）' : '全量展示整页（跟着消息区一起滚）'
        applyPreviewHeight(frame, wrap)
      })
      syncTabs()
      return { root: wrap, pre: pre, frame: frame }
    }

    function renderRich(parent, text, options) {
      parent.textContent = ''
      var lines = String(text || '').replace(/\r/g, '').split('\n')
      var current = null // { level, node }
      var ordered = false
      var wantCallout = !!(options && options.callout)

      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i]
        var trimmed = raw.trim()
        if (!trimmed) {
          current = null
          continue
        }
        // 围栏代码块：``` 到收尾 ```（格式自由后模型可能给出代码/命令片段）
        if (/^```/.test(trimmed)) {
          current = null
          var fenceLang = trimmed.replace(/^```+/, '').trim().split(/[\s:,]/)[0]
          var codeLines = []
          i += 1
          while (i < lines.length && !/^```/.test(lines[i].trim())) {
            codeLines.push(lines[i])
            i += 1
          }
          var codeText = codeLines.join('\n')
          // 长代码块在流式期间先给纯文本：语法高亮会为每一行造一堆 span（6KB 页面 ≈ 2000+ 个），
          // 每帧重做一遍是卡顿的第二个来源；收尾（settled）那一次再上色。
          var plainWhileStreaming = codeText.length > 1200 && !(options && options.settled === true)
          // 只有"这一轮已经定稿"才渲染预览：流式期间每次重绘都换一份 iframe 会不停重载、闪白，
          // 所以边生成边看源码，回复一结束（settled）立刻变成可交互网页。
          if (options && options.settled === true && looksLikeWebPage(fenceLang, codeText)) {
            var block = webPreviewBlock(codeText)
            parent.appendChild(block.root)
            // 先入 DOM 再上色：主题判定要读祖先链的**实际**底色，游离节点读不到
            paintHighlight(block.pre, codeText, fenceLang)
          } else {
            var pre = el('pre', 'dsh-sel-pre')
            parent.appendChild(pre)
            if (plainWhileStreaming) pre.textContent = codeText
            else paintHighlight(pre, codeText, fenceLang)
          }
          continue
        }
        // 表格：当前行以 | 开头且下一行是分隔行
        if (trimmed.charAt(0) === '|' && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
          current = null
          i = renderTable(parent, lines, i) - 1
          continue
        }
        // 结论条（翻译节的固定结尾；引用行与普通行都识别）
        if (wantCallout) {
          var calloutSource = trimmed.charAt(0) === '>' ? trimmed.replace(/^>\s?/, '') : trimmed
          var callout = CALLOUT_RE.exec(calloutSource)
          if (callout) {
            current = null
            parent.appendChild(calloutNode(callout[1], callout[2]))
            continue
          }
        }
        // 分隔线
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
          current = null
          parent.appendChild(el('hr', 'dsh-sel-hr'))
          continue
        }
        // 引用
        var quote = /^>\s?(.*)$/.exec(trimmed)
        if (quote) {
          current = null
          var quoteLine = el('div', 'dsh-sel-quote-line')
          appendInline(quoteLine, quote[1])
          parent.appendChild(quoteLine)
          continue
        }
        // 列表（含缩进分级、有序编号）
        var bullet = /^(\s*)([-*•+]|\d+[.)])\s+(.*)$/.exec(raw)
        if (bullet) {
          var level = Math.min(2, Math.floor(bullet[1].replace(/\t/g, '  ').length / 2))
          var isNumbered = /^\d/.test(bullet[2])
          if (!current || current.level !== level || ordered !== isNumbered) {
            var listNode = el('div', 'dsh-sel-list')
            listNode.setAttribute('data-level', String(level))
            parent.appendChild(listNode)
            current = { level: level, node: listNode }
            ordered = isNumbered
          }
          var item = el('div', 'dsh-sel-item')
          if (isNumbered) item.setAttribute('data-num', '1')
          item.appendChild(el('span', 'dsh-sel-bullet', isNumbered ? bullet[2] : '•'))
          var body = el('span')
          appendInline(body, bullet[3])
          item.appendChild(body)
          current.node.appendChild(item)
          continue
        }
        current = null
        // 小标题
        var heading = /^#{1,6}\s*(.*)$/.exec(trimmed)
        if (heading) {
          var sub = el('div', 'dsh-sel-sub')
          appendInline(sub, heading[1])
          parent.appendChild(sub)
          continue
        }
        // 段落
        var paragraph = el('p')
        appendInline(paragraph, trimmed)
        parent.appendChild(paragraph)
      }
    }

    /** 按「## 翻译 / ## 详解」把流式文本切两节（容错多种写法，含旧的「语境含义」）。 */
    function splitSections(raw) {
      var result = { translation: '', detail: '', other: '' }
      var re = /^[ \t>]*#{1,6}[ \t]*\**\s*(翻译|译文|translation|解读|注释|代码|详解|语境含义|语境|含义|解释|meaning|detail)\**\s*[:：]?[ \t]*$/gim
      var marks = []
      var match
      while ((match = re.exec(raw)) !== null) {
        marks.push({ start: match.index, end: re.lastIndex, name: sectionName(match[1]) })
      }
      if (marks.length === 0) {
        result.other = raw
        return result
      }
      result.other = raw.slice(0, marks[0].start)
      for (var i = 0; i < marks.length; i++) {
        var stop = i + 1 < marks.length ? marks[i + 1].start : raw.length
        var chunk = raw.slice(marks[i].end, stop)
        result[marks[i].name] += chunk
      }
      return result
    }

    function sectionName(label) {
      var key = label.toLowerCase()
      if (key.indexOf('翻译') >= 0 || key.indexOf('译文') >= 0 || key.indexOf('translat') >= 0) return 'translation'
      if (key.indexOf('解读') >= 0) return 'translation' // 纯中文时首轮标题就是「解读」
      if (key.indexOf('注释') >= 0 || key.indexOf('代码') >= 0) return 'translation' // 代码段首轮标题是「注释」
      if (
        key.indexOf('详解') >= 0 ||
        key.indexOf('语境') >= 0 ||
        key.indexOf('含义') >= 0 ||
        key.indexOf('解释') >= 0 ||
        key.indexOf('meaning') >= 0 ||
        key.indexOf('detail') >= 0
      ) {
        return 'detail'
      }
      return 'other'
    }

    // ────────────────────── 上下文采集 ──────────────────────

    /** 选区所在的语义容器（消息气泡 / 段落 / 代码块…）。 */
    function pickContainer(element) {
      var node = element
      while (node && node !== document.body) {
        var length = (node.innerText || '').length
        if (length >= 120) return node
        node = node.parentElement
      }
      return element || document.body
    }

    /** 容器的人类可读标签。 */
    function describeContainer(element) {
      if (!element || !element.closest) return '页面内容'
      try {
        if (element.closest('pre') || element.closest('code')) return '代码块'
        if (element.closest('table')) return '表格'
        var message = element.closest('[data-message-role],[data-role],[data-testid*="message"],article')
        if (message) {
          var role = message.getAttribute('data-message-role') || message.getAttribute('data-role') || ''
          if (role === 'user') return '对话消息（用户）'
          if (role === 'assistant') return '对话消息（助手）'
          return '对话消息'
        }
      } catch (error) {
        /* closest 在某些孤立节点上会抛错，忽略 */
      }
      return '页面内容'
    }

    /**
     * 采集上下文：容器文本中选区前后各 CONTEXT_WINDOW 字符的窗口，
     * 并用【】标出选中部分（前后文对齐，便于模型判断指代）。
     */
    function collectContext(selection) {
      var fallback = { context: '', label: '页面内容' }
      var range
      try {
        range = selection.getRangeAt(0)
      } catch (error) {
        return fallback
      }
      var startElement = range.startContainer
      startElement = startElement && startElement.nodeType === 1 ? startElement : startElement && startElement.parentElement
      var container = pickContainer(startElement)
      if (!container) return fallback
      var label = describeContainer(container)

      var rawFull = ''
      var offset = 0
      try {
        var fullRange = document.createRange()
        fullRange.selectNodeContents(container)
        rawFull = fullRange.toString()
        var prefix = document.createRange()
        prefix.selectNodeContents(container)
        prefix.setEnd(range.startContainer, range.startOffset)
        offset = prefix.toString().length
      } catch (error) {
        return { context: '', label: label }
      }
      if (!rawFull) return { context: '', label: label }

      var selected = selection.toString()
      var start = clamp(offset - CONTEXT_WINDOW, 0, Math.max(0, rawFull.length - 1))
      var end = clamp(offset + selected.length + CONTEXT_WINDOW, 0, rawFull.length)
      var window = rawFull.slice(start, end)
      var relative = offset - start
      var marked = window
      var probe = window.slice(relative, relative + selected.length)
      if (normalizeSpace(probe) !== normalizeSpace(selected)) {
        var found = rawFull.indexOf(selected)
        if (found >= 0) {
          var s2 = clamp(found - CONTEXT_WINDOW, 0, Math.max(0, rawFull.length - 1))
          var e2 = clamp(found + selected.length + CONTEXT_WINDOW, 0, rawFull.length)
          var w2 = rawFull.slice(s2, e2)
          var r2 = found - s2
          marked = w2.slice(0, r2) + '【' + w2.slice(r2, r2 + selected.length) + '】' + w2.slice(r2 + selected.length)
        } else {
          marked = selected + '\n---\n' + window
        }
      } else {
        marked = window.slice(0, relative) + '【' + probe + '】' + window.slice(relative + selected.length)
      }
      var context = marked.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
      // key 用的上下文：**只取选中文字之前**的一小段。
      // 取前后整段的话，主会话只要在后面追加新消息，同一个词的 key 就变了 ——
      // 结果就是"同一个词找不着上次的小窗，又生成一个"（实测复现过）。
      var keyContext = rawFull
        .slice(Math.max(0, offset - KEY_CONTEXT_CHARS), offset)
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return { context: context, label: label, keyContext: keyContext }
    }

    function normalizeSpace(text) {
      return String(text || '').replace(/\s+/g, ' ').trim()
    }

    // ────────────────────── 侧边栏网页：iframe 划词桥 ──────────────────────

    /**
     * 侧边栏的 HTML 预览是**不透明源**沙箱 iframe（`sandbox="allow-scripts"`，
     * 刻意不给 `allow-same-origin`）：父页面拿不到 contentDocument，
     * 顶层 `window.getSelection()` 永远是空的 —— 划词在那里等于瞎的。
     *
     * 解法只有一个方向：**让帧内自己上报**。下面这段脚本被注入进被预览的文档，
     * 在帧内读选区、就地采集上下文（算法与父页面 `collectContext` 完全一致），
     * 再用 postMessage 报出来；父页面把"帧内坐标 + iframe 的 getBoundingClientRect()"
     * 换算成视口坐标，复用同一套浮标与面板。
     *
     * 安全边界（不能退让）：**不加 `allow-same-origin`**，帧仍是不透明源 ——
     * 预览页照样读不到 GUI 的 DOM / Cookie / localStorage，也照样不能导航顶层窗口。
     * 桥只往外报"选中了什么 + 周围那点文本"，别的什么都不给。
     *
     * 两处细节不能省：
     *   ① 监听挂在 **window** 上、并且用轮询兜底 —— 交互式预览的外层文档是 bootstrap，
     *      它 `document.open()/write()/close()` 会把 document 上的监听全部冲掉，
     *      只有 window 上的监听能活下来（见宿主 ui-sidebar-documentpreview 的 createHtmlDocument）。
     *   ② 报的是**帧内视口坐标**（range.getClientRects 的最后一段），父页面再加偏移。
     */
    function bridgeBody() {
      if (window.__dshSelBridge) return
      window.__dshSelBridge = 1
      var WINDOW_CHARS = 1500
      var KEY_CHARS = 300
      var MAX_SELECTION = 4000
      /** 鼠标按着超过这么久还没等到 mouseup，就当松手落在帧外了（别永久卡住上报）。 */
      var STALE_PRESS_MS = 6000
      /** 轮询连续这么多拍都读不到选区，才认为选区真没了（约 1.5s；瞬时读不到不清）。 */
      var NULL_TICKS_TO_CLEAR = 6
      /** 上一次报出去的选区指纹（文字 + 位置），用来去重。 */
      var last = ''
      /** 鼠标是不是按着（拖拽划词进行中）。 */
      var pressed = false
      var pressedAt = 0
      /** 上一拍轮询看到的指纹：用于"稳定一拍再报"。 */
      var pollKey = ''
      /** 轮询连续读不到选区的拍数。 */
      var nullTicks = 0

      function norm(text) {
        return String(text || '').replace(/\s+/g, ' ').trim()
      }

      function send(kind, sel) {
        try {
          parent.postMessage({ __dshSel: 1, kind: kind, sel: sel || null }, '*')
        } catch (error) {
          /* 顶层被导航走了之类：报不出去就算了，不能因为报错把预览页搞坏 */
        }
      }

      /** 选区所在的语义容器：与父页面 pickContainer 同一套规则（往上找到第一个够长的元素）。 */
      function containerOf(node) {
        var element = node && node.nodeType === 1 ? node : node && node.parentElement
        while (element && element !== document.body) {
          var length = (element.innerText || '').length
          if (length >= 120) return element
          element = element.parentElement
        }
        return element || document.body
      }

      function labelOf(element) {
        try {
          if (element && element.closest && element.closest('pre,code')) return '代码块'
          if (element && element.closest && element.closest('table')) return '表格'
        } catch (error) {
          /* 孤立节点上 closest 会抛，忽略 */
        }
        return ''
      }

      /** 这些标签的文本不算正文（脚本源码 / 样式 / 模板 / 文档头）。 */
      var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1 }

      /**
       * 走 DOM 收集容器的可见文本，并给出 `target`（选区起点）在这段文本里的偏移。
       * 比 `Range.toString()` 多一步：跳过 script/style 等——否则页面里的 JS 源码会混进上下文。
       * target 是元素节点（整段选中的情况）时，取"进入该元素那一刻"的长度作为偏移；
       * 是文本节点时还要加上 `targetOffset`（选区在文本节点内的字符偏移）。
       */
      function collectText(root, target, targetOffset) {
        var text = ''
        var offset = -1
        function walk(node) {
          if (!node) return
          if (node.nodeType === 3) {
            if (node === target) offset = text.length + (targetOffset || 0)
            text += node.nodeValue || ''
            return
          }
          if (node.nodeType !== 1) return
          if (SKIP_TAGS[node.tagName]) return
          if (node === target) offset = text.length
          var kids = node.childNodes || []
          for (var i = 0; i < kids.length; i += 1) walk(kids[i])
        }
        walk(root)
        return { text: text, offset: offset }
      }

      /** 读一次选区：文字 + 上下文窗口 + 帧内坐标；没有有效选区返回 null。 */
      function read() {
        var selection = window.getSelection && window.getSelection()
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
        var text = String(selection.toString() || '')
        if (!text.trim() || text.length > MAX_SELECTION) return null
        var range
        try {
          range = selection.getRangeAt(0)
        } catch (error) {
          return null
        }
        var start = range.startContainer
        var startElement = start && start.nodeType === 1 ? start : start && start.parentElement
        try {
          if (startElement && startElement.closest && startElement.closest('input,textarea')) return null
        } catch (error) {
          /* 输入框判断失败不致命 */
        }
        var container = containerOf(startElement)
        var out = { text: text.trim(), context: '', keyContext: '', label: labelOf(container) }
        try {
          // 容器正文：**走 DOM 取文本**，跳过 script / style / noscript / template / head。
          // 不能用 Range.toString()：它把 <script> 里的源码也算进正文——实测（真浏览器冒烟）
          // 交互式预览里的上下文会带上整段页面 JS，喂给模型纯属噪音。
          var walked = collectText(container, range.startContainer, range.startOffset)
          var rawFull = walked.text
          var offset = walked.offset
          if (offset < 0) {
            // 选区起点不在这个容器里（跨容器选区之类）：退回 Range 的算法，至少别丢上下文
            var prefix = document.createRange()
            prefix.selectNodeContents(container)
            prefix.setEnd(range.startContainer, range.startOffset)
            offset = prefix.toString().length
          }
          var from = Math.max(0, offset - WINDOW_CHARS)
          var to = Math.min(rawFull.length, offset + text.length + WINDOW_CHARS)
          var windowText = rawFull.slice(from, to)
          var relative = offset - from
          var probe = windowText.slice(relative, relative + text.length)
          var marked
          if (norm(probe) === norm(text)) {
            marked = windowText.slice(0, relative) + '【' + probe + '】' + windowText.slice(relative + text.length)
          } else {
            var found = rawFull.indexOf(text)
            if (found >= 0) {
              var f2 = Math.max(0, found - WINDOW_CHARS)
              var t2 = Math.min(rawFull.length, found + text.length + WINDOW_CHARS)
              var w2 = rawFull.slice(f2, t2)
              var r2 = found - f2
              marked = w2.slice(0, r2) + '【' + w2.slice(r2, r2 + text.length) + '】' + w2.slice(r2 + text.length)
            } else {
              marked = text + '\n---\n' + windowText
            }
          }
          out.context = marked
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
          out.keyContext = rawFull
            .slice(Math.max(0, offset - KEY_CHARS), offset)
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        } catch (error) {
          /* 取不到上下文就给空串：父页面照样能开面板，只是少了背景 */
        }
        var rect = null
        try {
          var rects = range.getClientRects()
          rect = rects && rects.length > 0 ? rects[rects.length - 1] : null
        } catch (error) {
          rect = null
        }
        if (!rect) {
          try {
            rect = range.getBoundingClientRect()
          } catch (error) {
            rect = null
          }
        }
        if (!rect || (!rect.width && !rect.height)) return null
        out.rect = {
          x: rect.left,
          y: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          w: rect.width,
          h: rect.height,
        }
        return out
      }

      /** 选区指纹：文字 + 帧内位置（位置变了也要重报，父页面据此挪浮标）。 */
      function fingerprint(now) {
        if (!now) return ''
        return now.text + '\u0000' + now.rect.x + ',' + now.rect.y + ',' + now.rect.bottom + ',' + now.rect.right
      }

      /**
       * 读一次并上报。
       *
       * `allowClear === false` 时**只报选区、不报"选区没了"**：滚动/改尺寸/轮询这些
       * "顺手重报一下位置"的路径不该有清空权 —— 页面重绘、动画、字体回流时
       * `getClientRects()` 会短暂拿不到矩形，一抖就 clear 会把浮标误收掉
       * （用户看到的就是"浮标自己消失了"）。真正的清空信号来自 mouseup / keyup /
       * selectionchange 这些**用户动作**。
       */
      function report(allowClear) {
        var now = read()
        if (!now) {
          if (last && allowClear !== false) {
            last = ''
            send('clear', null)
          }
          return
        }
        var key = fingerprint(now)
        if (key === last) return
        last = key
        send('selection', now)
      }

      /**
       * 轮询兜底（250ms）：只负责"没人通知我们"的情况。
       *
       * 三道闸门都是为了**时机**跟主会话一致（主会话只在 mouseup / keyup 后弹）：
       *   ① 鼠标按着（拖拽划词进行中）一律不报 —— 否则拖到一半浮标就冒出来，还跟着手指跑；
       *   ② 选区还在变（这一拍与上一拍指纹不同）先记账，**稳定一拍**再报；
       *   ③ 连续 NULL_TICKS_TO_CLEAR 拍都读不到选区才认为它真没了 —— 一次瞬时读不到
       *      只当页面在重绘，不清浮标（瞬时误清的表现就是"浮标自己消失"）。
       * 松手落在帧外时不会有 mouseup：超过 STALE_PRESS_MS 就当已经松开，别把上报永久卡死。
       */
      function tick() {
        if (pressed) {
          if (Date.now() - pressedAt < STALE_PRESS_MS) return
          pressed = false
        }
        var now = read()
        if (!now) {
          pollKey = ''
          nullTicks += 1
          if (nullTicks >= NULL_TICKS_TO_CLEAR && last) {
            last = ''
            send('clear', null)
          }
          return
        }
        nullTicks = 0
        var key = fingerprint(now)
        if (key !== pollKey) {
          pollKey = key
          return
        }
        if (key === last) return
        last = key
        send('selection', now)
      }

      window.addEventListener('mousedown', function () {
        pressed = true
        pressedAt = Date.now()
        // 帧内按下 = 用户开始新动作 → 让父页面先把浮标收掉。
        // 主会话那边 document 的 mousedown 就是"点哪都先收起浮标"；帧内的点击父页面收不到，
        // 不补这一条的话：在网页里点一下（取消选区/点别处）浮标会赖着不走。
        send('press', null)
      }, true)
      // 松手才是"划完了"：与主会话一致（那边也是 mouseup 之后才弹浮标）
      window.addEventListener('mouseup', function () {
        pressed = false
        setTimeout(report, 0)
      }, true)
      window.addEventListener('keyup', function () { setTimeout(report, 0) }, true)
      // 焦点离开这一帧（点去别处）＝ 拖拽状态作废，免得 pressed 卡住
      window.addEventListener('blur', function () { pressed = false }, true)
      // 帧内滚动/改尺寸 → 位置变了，重报一次（父页面据此挪浮标）。这两条不许 clear
      window.addEventListener('scroll', function () {
        if (pressed) return
        setTimeout(function () {
          report(false)
        }, 60)
      }, true)
      window.addEventListener('resize', function () {
        if (!pressed) report(false)
      })
      window.addEventListener('message', function (event) {
        var data = event && event.data
        if (!data || data.__dshSel !== 1) return
        if (data.kind === 'ping') {
          send('hello', null)
          report()
        }
        if (data.kind === 'rescan') report()
      })
      try {
        document.addEventListener('selectionchange', function () {
          // 拖拽中不报；键盘扩选（Shift+方向键）没有 mousedown，照旧即时上报
          if (!pressed) report()
        })
      } catch (error) {
        /* 老环境没有 selectionchange：轮询兜着 */
      }
      setInterval(tick, 250)
      setTimeout(report, 60)
    }

    /** 注入标记：既用来认"这份 HTML 已经桥过"，也是 iframe 元素上的记号。 */
    var BRIDGE_MARK = 'data-dsh-sel-bridge'

    /**
     * 把桥脚本插进一份 HTML（返回新串；没有可插的地方 / 已经插过 → null）。
     *
     * 基础预览（srcdoc）那份 HTML 已经过宿主 DOMPurify 清洗：无脚本、无外链，
     * 且带一条 `script-src 'none'` 的 CSP。我们**只放宽这一条**到 'unsafe-inline'
     * （好让桥跑起来），`default-src 'none'` / `connect-src 'none'` / `img-src data:`
     * 等其余限制原样保留 —— 预览页依然联不了网、加载不了外部资源。
     */
    function bridgeIntoHtml(html) {
      var text = String(html || '')
      if (!text || text.indexOf(BRIDGE_MARK) >= 0) return null
      text = text.replace(/script-src\s+'none'/i, "script-src 'unsafe-inline'")
      var tag = '<scr' + 'ipt ' + BRIDGE_MARK + '>(' + String(bridgeBody) + ')();</scr' + 'ipt>'
      return insertIntoHtml(text, tag)
    }

    /**
     * 插入位置按"尽量靠前、但别破坏文档"排序：
     * charset（中文标签不能变乱码）→ head → html → 第一个 script 之前 → doctype 之后 → 最前。
     */
    function insertIntoHtml(html, tag) {
      var anchors = [/<meta[^>]+charset[^>]*>/i, /<head[^>]*>/i, /<html[^>]*>/i]
      for (var i = 0; i < anchors.length; i += 1) {
        var hit = anchors[i].exec(html)
        if (hit) {
          var cut = hit.index + hit[0].length
          return html.slice(0, cut) + tag + html.slice(cut)
        }
      }
      var script = /<script/i.exec(html)
      if (script) return html.slice(0, script.index) + tag + html.slice(script.index)
      var doctype = /^\s*<!doctype[^>]*>/i.exec(html)
      if (doctype) {
        var end = doctype.index + doctype[0].length
        return html.slice(0, end) + tag + html.slice(end)
      }
      return tag + html
    }

    // ────────────────────── 主逻辑 ──────────────────────

    function apply(ctx) {
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
        effort: '',
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
        toolResidue: false,
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
        /** 当前阶段：'translation' | 'detail' | 'chat'。 */
        stage: '',
        /** 追问轮次：[{ role: 'user' | 'assistant', text }]，只活在面板/内存里（临时）。 */
        turns: [],
        /**
         * 待发送的引用：[{ label: '小窗回答' | '主界面选中' …, text }]。
         * 只属于**下一条**提问（发送即清空）；关掉面板不清 —— 回来接着写还看得见。
         */
        quotes: [],
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
      var cache = new Map()


      // —— DOM ——
      var styleEl = el('style')
      styleEl.setAttribute('data-plugin', '@yfwu2020/dsh-selection-explain')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)

      /** 浮层容器：挂在 shell.overlay 条目里，自身 click-through。 */
      var layer = el('div', 'dsh-sel-layer')
      layer.style.pointerEvents = 'none'

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
      var pillDot = el('span', 'dsh-sel-pilldot')
      // 和费用胶囊同构：主体一段（加粗）、次要一段（淡）、箭头一段（更淡）
      var pillName = el('span', 'dsh-sel-pillname', '划词解读')
      var pillMeta = el('span', 'dsh-sel-pillmeta', '· 就绪')
      var pillCaret = el('span', 'dsh-sel-pillcaret', '▴')
      pill.appendChild(pillDot)
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
      var historyButton = el('button', 'dsh-sel-action', '🕘 最近')
      historyButton.type = 'button'
      historyButton.title = '最近聊过的划词（点一条把那段对话调回来）'
      var promoteButton = el('button', 'dsh-sel-action', '↗ 升格')
      promoteButton.type = 'button'
      promoteButton.title = '升格为正式会话（建在同一个项目下，带着这段文字与上面的讨论）'
      var closeButton = iconButton('关闭（Esc）', '✕')
      head.appendChild(historyButton)
      head.appendChild(promoteButton)
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
      var askBox = el('textarea', 'dsh-sel-askbox')
      askBox.rows = 1
      askBox.placeholder = '就这段文字继续追问…（Enter 发送，Shift+Enter 换行）'
      // 网页模式开关：打开后，追问里较复杂的问题默认用网页回答（并注入附带的设计规范）
      // 输出偏好：文字 + 图标分段（两格：M↓ = Markdown / ▭ = 网页，选中格是滑动的药丸）
      var webMode = el('span', 'dsh-sel-pref')
      webMode.appendChild(el('span', 'dsh-sel-preftext', '输出偏好'))
      var prefSeg = el('span', 'dsh-sel-seg')
      prefSeg.setAttribute('role', 'radiogroup')
      prefSeg.setAttribute('aria-label', '输出偏好')
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
      modelMenu.setAttribute('role', 'menu')

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
      var askSpacer = el('span', 'dsh-sel-askspace')
      askTools.appendChild(webMode)
      askTools.appendChild(askSpacer)
      askTools.appendChild(modelPill)
      askTools.appendChild(micButton)
      askTools.appendChild(captureRow)
      askTools.appendChild(askSend)
      askRow.appendChild(askBox)
      askRow.appendChild(askTools)
      askRow.appendChild(modelMenu)
      // 引用区先画一次（空态：data-show="0" 收起），别等第一次 addQuote 才建立初始状态
      renderQuotes()
      // 「重新生成」不再常驻页脚：只在内容区没有可用结果时出现在正文里
      var retryButton = el('button', 'dsh-sel-retry', '重新生成')
      retryButton.type = 'button'
      retryButton.style.display = 'none'
      panel.appendChild(head)
      panel.appendChild(body)
      panel.appendChild(askRow)
      layer.appendChild(panel)
      // 「最近聊过的」是**独立的浮层**（贴面板侧边），不和消息共用一个滚动区
      var historyList = el('div', 'dsh-sel-history')
      historyList.style.display = 'none'
      layer.appendChild(historyList)

      /**
       * 注册进官方 shell.overlay 槽（帧级浮层）。
       * React 组件只负责把 layer 容器挂进浮层；浮标/面板由上面的命令式代码管理，
       * React 不接管它们的子树（容器本身无 children，不会被 diff 清空）。
       */
      /** 开窗后"还没聚焦过输入框"（见 focusComposerOnce）。 */
      var askFocusPending = false
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
                className: 'dsh-sel-mount',
                style: { pointerEvents: 'none' },
                ref: function (node) {
                  if (node && layer.parentNode !== node) node.appendChild(layer)
                },
              })
            })
          })
        } catch (error) {
          // 槽注册失败不应把整页插件装载一起拖垮：降级为仅报错（面板挂在浮层外不可见）
          console.error('[dsh-selection-explain] shell.overlay 槽注册失败：', error)
        }
      } else {
        console.error('[dsh-selection-explain] slots 服务不可用，划词解读 UI 未挂载')
      }

      var panelOpen = false
      var rafPending = false
      /** 流式重绘限速（毫秒）：见 scheduleTurnsRender / schedulePaint。 */
      var STREAM_RENDER_MS = 90
      var turnsRenderPending = false
      var lastTurnsRenderAt = 0
      var timers = []
      /** 贴位置的自适应节奏（见 schedulePillPlacer）。 */
      var PILL_POLL_MIN = 2000
      var PILL_POLL_MAX = 60000
      var pillPollDelay = PILL_POLL_MIN
      var pillPlacerId = 0
      /** 上一次量到的费用胶囊容器 / 正在观察它的 ResizeObserver（浏览器没有这个 API 时为 null）。 */
      var pillHost = null
      var pillWatched = null
      var pillObserver = null
      /** 正在显示的等待特效（每个容器一条；同处同文案复用节点，避免重建打断动画）。 */
      var waitList = []

      function later(fn, ms) {
        var id = setTimeout(fn, ms)
        timers.push(id)
        return id
      }

      // —— 选区 → 浮标 ——

      function scheduleCheck() {
        later(checkSelection, 0)
      }

      /**
       * 选区是不是落在**我们自己的界面**里（胶囊 / 面板 / 历史浮层）。
       *
       * 不加这道判断的话，在主会话里顺手划中胶囊上的文字（比如"已停止"），
       * 就会拿它当选中文字再开一个小窗——实测真踩到过：胶囊上出现「已停止 · 已停止」。
       */
      function insideOwnUI(node) {
        var current = node && node.nodeType === 3 ? node.parentNode : node
        for (var depth = 0; current && depth < 24; depth += 1) {
          var cls = typeof current.className === 'string' ? current.className : ''
          if (cls.indexOf('dsh-sel-') === 0 || cls.indexOf(' dsh-sel-') >= 0) return true
          if (current === layer || current === panel || current === pill) return true
          current = current.parentNode
        }
        return false
      }

      /**
       * 这一段选区是不是**小窗正文**里的（可以引用）。
       *
       * 往上走到小窗的滚动内容区（body）为止：中途碰到输入框 / 按钮 / 引用卡片本身
       * 就不算 —— 那些地方的选区要么是输入（textarea），要么引用了也没意义（"✕"这种按钮文字）。
       * 历史列表、胶囊、模型菜单都在 panel/body 之外，自然被挡掉。
       * 不用 closest()：无浏览器测试的桩 DOM 没有它，而按祖先链走一遍在两边都一样准。
       */
      function insidePanelContent(node) {
        var current = node && node.nodeType === 3 ? node.parentNode : node
        for (var depth = 0; current && depth < 32; depth += 1) {
          if (current === body) return true
          if (current === panel || current === layer || !panel.contains(current)) return false
          var tag = String(current.tagName || '').toUpperCase()
          if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON' || tag === 'IFRAME') return false
          var cls = typeof current.className === 'string' ? current.className : ''
          if (cls.indexOf('dsh-sel-quotes') >= 0) return false
          current = current.parentNode
        }
        return false
      }

      /** 小窗正文里这段选区的来源标签：翻到哪个容器就报哪个（给引用卡片与提示词用）。 */
      function panelSourceLabel(node) {
        var current = node && node.nodeType === 3 ? node.parentNode : node
        for (var depth = 0; current && depth < 32; depth += 1) {
          var cls = typeof current.className === 'string' ? current.className : ''
          if (cls.indexOf('dsh-sel-quote') === 0) return '选中文字'
          if (cls.indexOf('dsh-sel-chatlog') >= 0) return '小窗回答'
          if (cls.indexOf('dsh-sel-sec') >= 0) {
            var sec = current.getAttribute && current.getAttribute('data-sec')
            if (sec === 'detail') return '小窗详解'
            if (sec === 'translation') return '小窗解读'
          }
          if (current === body || current === panel || !current.parentNode) break
          current = current.parentNode
        }
        return '小窗内容'
      }

      /**
       * 小窗开着时的选区检查：这时候浮标是「❝ 引用」而不是「✦ 解读」。
       *
       * 两种来源都认：
       *   ① 小窗正文里的选区（回答 / 两节 / 顶部选中文字条）→ 引用的就是小窗自己的内容；
       *   ② 主界面上的选区 → 引用主界面选中的文字。
       * 帧内（侧边栏网页）那条不在这里 —— 它由桥的 message 送过来，见 offBridgeMessage。
       */
      function checkQuoteSelection() {
        hideButton() // 小窗开着时不提供「解读」：要解读直接在输入框里问
        var selection = window.getSelection()
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          // 帧内那条选区还活着（本文档塌陷只是点浮标造成的）→ 留着浮标
          if (state.bridgeActive && state.selection && state.selection.source === 'iframe') return
          state.quoteSelection = null
          hideQuoteButton()
          return
        }
        var range
        try {
          range = selection.getRangeAt(0)
        } catch (error) {
          return
        }
        var text = String(selection.toString() || '')
        if (!text.trim() || text.length > MAX_QUOTE_SELECTION) {
          state.quoteSelection = null
          hideQuoteButton()
          return
        }
        if (insideEditable(range.startContainer)) {
          state.quoteSelection = null
          hideQuoteButton()
          return
        }
        var inPanel = insidePanelContent(range.startContainer) || insidePanelContent(range.endContainer)
        // 小窗里划词：帧内那条让位（两处同时有选区时以本文档为准）
        state.bridgeActive = false
        if (!inPanel && (insideOwnUI(range.startContainer) || insideOwnUI(range.endContainer))) {
          // 历史列表 / 胶囊 / 工具行的选区：引用没有意义，也不该弹浮标
          state.quoteSelection = null
          hideQuoteButton()
          return
        }
        var label = inPanel ? panelSourceLabel(range.startContainer) : '主界面选中'
        var rects = range.getClientRects()
        var rect = rects && rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect()
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          state.quoteSelection = null
          hideQuoteButton()
          return
        }
        state.quoteSelection = {
          text: text.trim(),
          label: label,
          source: inPanel ? 'panel' : 'document',
          rect: rect,
          // 上下文留到**点引用那一刻**才采（每次 selectionchange 都采太贵）：
          // 这里只记下"在哪一轮上"（小窗）/ 选区本身（主界面，用来采局部窗口）
          turnIndex: inPanel ? turnIndexOfNode(range.startContainer) : -1,
          range: inPanel ? null : safeCloneRange(range),
        }
        showQuoteButton(rect)
      }

      /** 克隆选区（桩环境/老浏览器没有 cloneRange 就返回 null，后面走"取不到上下文"那条路）。 */
      function safeCloneRange(range) {
        try {
          return typeof range.cloneRange === 'function' ? range.cloneRange() : null
        } catch (error) {
          return null
        }
      }

      function checkSelection() {
        if (panelOpen) {
          checkQuoteSelection()
          return
        }
        hideQuoteButton()
        state.quoteSelection = null
        var selection = window.getSelection()
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          // 侧边栏网页里的选区**不在本文档**：点浮标会让本文档的选区塌掉
          // （于是每次点浮标都会先跑到这里），所以只要帧内那条选区还活着就别收浮标。
          // 帧内清空选区时桥会发 clear，那里才是真正的"该收"信号。
          if (state.bridgeActive && state.selection && state.selection.source === 'iframe') return
          hideButton()
          return
        }
        // 本文档里出现了真选区：帧内那条让位（两处同时有选区时以本文档为准）
        state.bridgeActive = false
        // 划到自己界面上（胶囊/面板/历史列表）时什么都不做
        try {
          var ownRange = selection.getRangeAt(0)
          if (insideOwnUI(ownRange.startContainer) || insideOwnUI(ownRange.endContainer)) {
            hideButton()
            return
          }
        } catch (error) {
          /* 老浏览器/桩环境取不到 range 就算了，按老路子走 */
        }
        var text = String(selection.toString() || '')
        if (!text.trim() || text.length > MAX_SELECTION) {
          hideButton()
          return
        }
        var range = selection.getRangeAt(0)
        if (insideEditable(range.startContainer)) {
          hideButton()
          return
        }
        var rects = range.getClientRects()
        var rect = rects && rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect()
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          hideButton()
          return
        }
        state.selection = { text: text.trim(), range: range.cloneRange(), rect: rect, source: 'document' }
        showButton(rect)
      }

      /** 挂/摘浮现动效（用 data 属性驱动动画，不动类名）。 */
      function setButtonPop(on) {
        if (on) button.setAttribute('data-pop', '1')
        else button.removeAttribute('data-pop')
      }

      function showButton(rect) {
        // 浮标也在同一套配色下：它的底色是"页面背景"（浮层自身透明），按它判深浅
        if (!panelOpen) layer.setAttribute('data-theme', isDarkSurface(layer) ? 'dark' : 'light')
        // 只在"浮现"那一次播动效；已经可见时（划选范围被拖动、键盘调整）只平移，避免一直闪
        if (placeFloat(button, rect)) {
          setButtonPop(false)
          void button.offsetWidth // 强制重排，让动画能重播
          setButtonPop(true)
        }
      }

      function hideButton() {
        button.style.display = 'none'
        setButtonPop(false)
      }

      /**
       * 浮标定位（「解读」与「引用」两个浮标共用一套规则）：
       * 贴选区右下角；上面放不下（贴到视口顶）就翻到选区下方；左右夹回视口内。
       * 返回"这次是从隐藏变可见" —— 调用方据此决定要不要播浮现动效。
       */
      function placeFloat(node, rect) {
        var wasHidden = node.style.display !== 'inline-flex'
        node.style.display = 'inline-flex'
        var width = node.offsetWidth || 62
        var height = node.offsetHeight || 28
        var left = clamp(rect.right - width, 8, Math.max(8, window.innerWidth - width - 8))
        var top = rect.top - height - 7
        if (top < 8) top = Math.min(rect.bottom + 7, window.innerHeight - height - 8)
        node.style.left = Math.round(left) + 'px'
        node.style.top = Math.round(top) + 'px'
        return wasHidden
      }

      function setQuotePop(on) {
        if (on) quoteButton.setAttribute('data-pop', '1')
        else quoteButton.removeAttribute('data-pop')
      }

      function showQuoteButton(rect) {
        if (placeFloat(quoteButton, rect)) {
          setQuotePop(false)
          void quoteButton.offsetWidth
          setQuotePop(true)
        }
      }

      function hideQuoteButton() {
        quoteButton.style.display = 'none'
        setQuotePop(false)
      }

      // ────────────────────── 引用（❝）：把别处的文字挂进输入框 ──────────────────────
      //
      // 两个入口，同一份数据（state.quotes）：
      //   ① 划词浮标「❝ 引用」—— 小窗开着时，小窗正文里的选区 或 主界面上的选区；
      //   ② 助手气泡末尾的「❝ 引用整条」（鼠标移上去才出现）—— 整条回答，网页回答先折成 Markdown。
      // 引用只属于**下一条**提问：发送时拼进这条消息，发完清空。

      /** 引用卡片的 id 计数（内容可能重复，DOM 与删除都靠 id 认人）。 */
      var quoteSeq = 0

      /** 卡片/气泡上的来源小字。 */
      function quoteLabelOf(quote) {
        return quote && quote.label ? String(quote.label) : '引用'
      }

      /** 卡片/气泡里的单行摘要（完整文本进 title 与发给模型的那份）。 */
      function quoteBrief(text, max) {
        var one = String(text || '').replace(/\s+/g, ' ').trim()
        return one.length > max ? one.slice(0, max) + '…' : one
      }

      /**
       * 加一段引用。加不进去也给一句状态 —— 点了浮标"什么都没发生"是最难查的那种观感。
       * 同一段划两次不再加（引用区是材料清单，不是记事本）；超过 MAX_QUOTES 段也不再加。
       *
       * `extra` = { context, session }：引用**当时所在**的上下文（见 quoteContextFor），
       * session=true 表示"这段文字来自主界面会话"，发送前会再问 host 要一份按轮取整的干净上下文。
       */
      function addQuote(text, label, extra) {
        var clean = String(text || '').replace(/\u00a0/g, ' ').trim()
        if (!clean) return false
        var truncated = clean.length > MAX_QUOTE_CHARS
        if (truncated) clean = clean.slice(0, MAX_QUOTE_CHARS) + '…'
        for (var i = 0; i < state.quotes.length; i += 1) {
          if (state.quotes[i].text === clean) {
            setStatus('这段已经在引用里了')
            return false
          }
        }
        if (state.quotes.length >= MAX_QUOTES) {
          setStatus('引用最多 ' + MAX_QUOTES + ' 段，先删掉一条再加')
          return false
        }
        quoteSeq += 1
        var context = extra && typeof extra.context === 'string' ? extra.context.trim() : ''
        state.quotes.push({
          id: quoteSeq,
          label: label || '引用',
          text: clean,
          context: context,
          session: !!(extra && extra.session === true),
        })
        renderQuotes()
        refreshAskState()
        // 输入框按阶段本来可能是藏着的（首轮还在跑）：引用一进来就得看得见，顺手聚焦
        askRow.style.display = ''
        try {
          askBox.focus()
        } catch (error) {
          /* 桩环境没有焦点这回事 */
        }
        setStatus(
          '已加入引用（' +
            quoteLabelOf(state.quotes[state.quotes.length - 1]) +
            ' · ' +
            clean.length +
            ' 字' +
            (truncated ? '（原文更长，已截断）' : '') +
            (context ? ' · 带上下文 ' + context.length + ' 字' : '') +
            '）',
        )
        return true
      }

      function removeQuote(id) {
        var next = []
        for (var i = 0; i < state.quotes.length; i += 1) {
          if (state.quotes[i].id !== id) next.push(state.quotes[i])
        }
        state.quotes = next
        renderQuotes()
        refreshAskState()
      }

      /** 清空待发送的引用（换了一段选中文字 / 回放了另一条历史 —— 那些引用已经不属于这段对话）。 */
      function clearQuotes() {
        if (state.quotes.length === 0) return
        state.quotes = []
        renderQuotes()
        refreshAskState()
      }

      /** 重画引用区（空的时候整块收起来，不占版面）。 */
      function renderQuotes() {
        quotesBox.textContent = ''
        quotesBox.setAttribute('data-show', state.quotes.length > 0 ? '1' : '0')
        for (var i = 0; i < state.quotes.length; i += 1) {
          var quote = state.quotes[i]
          var chip = el('div', 'dsh-sel-quotechip')
          chip.setAttribute('data-quote', String(quote.id))
          chip.appendChild(el('span', 'dsh-sel-quotechip-src', '❝ ' + quoteLabelOf(quote)))
          var brief = el('span', 'dsh-sel-quotechip-text', quoteBrief(quote.text, 42))
          brief.title = quote.text
          chip.appendChild(brief)
          var remove = el('button', 'dsh-sel-quotechip-x', '✕')
          remove.type = 'button'
          remove.title = '移除这条引用'
          remove.setAttribute('aria-label', '移除这条引用')
          wireQuoteRemove(remove, quote.id)
          chip.appendChild(remove)
          quotesBox.appendChild(chip)
        }
      }

      /** 卡片上的 ✕（卡片每次重画，监听跟着节点一起走，不需要单独回收）。 */
      function wireQuoteRemove(node, id) {
        listen(node, 'click', function (event) {
          event.stopPropagation()
          removeQuote(id)
        })
      }

      // ── 引用的上下文：引用文字当时所在的那一组对话 ± 一组 ──
      //
      // 两处实现是**故意的重复**（host 的 quoteContextOf 与这里的 markQuoteInText /
      // clampAroundQuote 算法一致）：客户端 bundle 是手写 ModuleLoader 包，不 import host 半，
      // 而且客户端要能在 host 不认（引用来自侧边栏网页 / 文档预览）时自己兜住。

      /** 在文本里找到引用那段并套上【】（直接找不到就按"空白等价"再找一次）。 */
      function markQuoteInText(text, marker) {
        if (!text || !marker) return text
        var at = text.indexOf(marker)
        if (at >= 0) return text.slice(0, at) + '【' + marker + '】' + text.slice(at + marker.length)
        var tokens = String(marker)
          .split(/\s+/)
          .filter(Boolean)
          .map(function (token) {
            return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          })
        if (tokens.length === 0) return text
        try {
          var hit = new RegExp(tokens.join('\\s+')).exec(text)
          if (hit && typeof hit.index === 'number') {
            return text.slice(0, hit.index) + '【' + hit[0] + '】' + text.slice(hit.index + hit[0].length)
          }
        } catch (error) {
          /* 极端输入：不标记，由 composeQuestion 另附原文 */
        }
        return text
      }

      /** 长文本围绕引用截断（引用本身必须留下；找不到引用就从头截）。 */
      function clampAroundQuote(text, marker, max) {
        if (text.length <= max) return text
        var at = marker ? text.indexOf(marker) : -1
        if (at < 0) return text.slice(0, max) + '…（已截断）'
        var half = Math.max(0, Math.floor((max - marker.length) / 2))
        var from = Math.max(0, at - half)
        var to = Math.min(text.length, at + marker.length + half)
        return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '')
      }

      /** 上下文里有没有引用原文（归一化后包含即可：【】是套在外面的，不影响包含关系）。 */
      function contextHasQuote(context, text) {
        var haystack = normalizeSpace(context)
        var needle = normalizeSpace(text)
        return needle.length > 0 && haystack.indexOf(needle) >= 0
      }

      /**
       * 小窗里的引用 → 上下文 = 引用所在那一轮 ± QUOTE_CTX_TURNS 轮。
       *
       * 小窗的轮次就是它自己的对话（用户问 / 助手答），所以这里直接读 `state.turns`：
       * 助手轮先折掉网页回答的 HTML（引用一整页 HTML 源码既长又没用），用户轮用它问的那句话。
       * 选区不在任何一轮里（顶部选中文字条、翻译/详解卡片）→ 退回这次解读的局部上下文。
       */
      function panelQuoteContext(turnIndex, text) {
        if (turnIndex < 0 || turnIndex >= state.turns.length) {
          return String((state.payload && state.payload.context) || '')
        }
        var from = Math.max(0, turnIndex - QUOTE_CTX_TURNS)
        var to = Math.min(state.turns.length - 1, turnIndex + QUOTE_CTX_TURNS)
        var lines = []
        var used = 0
        for (var i = from; i <= to; i += 1) {
          var turn = state.turns[i]
          if (!turn || turn.hidden === true) continue
          var role = turn.role === 'user' ? '用户' : '助手'
          var body = turn.role === 'user' ? String(turn.text || '') : foldForHistory(sanitizeToolResidue(turn.text || ''))
          body = body.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
          if (!body) continue
          if (i === turnIndex) body = markQuoteInText(body, text)
          body = clampAroundQuote(body, text, QUOTE_CTX_TURN_CHARS)
          lines.push(role + '：' + body)
          used += body.length
          if (used >= QUOTE_CTX_MAX) break
        }
        return lines.join('\n')
      }

      /** 选区落在小窗的哪一轮上（往上找带 __turn 的气泡）；不在气泡里返回 -1。 */
      function turnIndexOfNode(node) {
        var current = node && node.nodeType === 3 ? node.parentNode : node
        for (var depth = 0; current && depth < 32; depth += 1) {
          if (current.__turn) {
            var index = state.turns.indexOf(current.__turn)
            if (index >= 0) return index
          }
          if (current === body || !panel.contains(current)) break
          current = current.parentNode
        }
        return -1
      }

      /**
       * 点「❝ 引用」那一刻才采上下文（划选过程中每次 selectionchange 都采太贵）。
       * 会话里的引用（主界面）先用**局部窗口**兜底，发送前再问 host 要按轮取整的干净上下文。
       */
      function quoteContextFor(selection) {
        if (!selection) return { context: '', session: false }
        if (selection.source === 'panel') {
          return { context: panelQuoteContext(selection.turnIndex, selection.text), session: false }
        }
        if (selection.source === 'iframe') {
          // 侧边栏网页：帧内的桥已经把上下文采好了（±1500 字窗口，选中部分用【】标出）
          return { context: String(selection.context || ''), session: false }
        }
        var context = String(selection.context || '')
        if (!context && selection.range) {
          try {
            context = collectContext(rangeSelection(selection.range)).context || ''
          } catch (error) {
            context = ''
          }
        }
        return { context: context, session: true }
      }

      /**
       * 会话里的引用：向 host 要"引用所在那一组对话 ± 一组"（干净文本只有 host 那边有：
       * 工具调用/结果、系统提示、harness 注入在 `transcriptOf` 那套规则里已经滤掉了）。
       * 拿不到（引用不在会话里 / host 不认 / 超时）就保留客户端自己采的那份，不阻塞发送。
       */
      function resolveQuoteContexts(quotes) {
        var jobs = []
        for (var i = 0; i < quotes.length; i += 1) {
          if (quotes[i].session === true) jobs.push(quotes[i])
        }
        var sessionId = currentSessionId()
        if (jobs.length === 0 || !sessionId) return Promise.resolve(quotes)
        return Promise.all(
          jobs.map(function (quote) {
            return fetchQuoteContext(sessionId, quote.text).then(function (context) {
              if (context) quote.context = context
              return quote
            })
          }),
        ).then(function () {
          return quotes
        })
      }

      /** 取一次会话版引用上下文（带超时；失败一律返回空串走兜底）。 */
      function fetchQuoteContext(sessionId, text) {
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        var timer = setTimeout(function () {
          if (controller) {
            try {
              controller.abort()
            } catch (error) {
              /* noop */
            }
          }
        }, QUOTE_CONTEXT_TIMEOUT)
        timers.push(timer)
        return fetch(QUOTE_CONTEXT_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, text: text }),
          ...(controller ? { signal: controller.signal } : {}),
        })
          .then(function (response) {
            return response.ok ? response.json() : null
          })
          .then(function (data) {
            clearTimeout(timer)
            if (data && data.ok === true && data.matched === true && typeof data.context === 'string') return data.context
            return ''
          })
          .catch(function () {
            clearTimeout(timer)
            return ''
          })
      }

      /**
       * 引用 + 提问 → **真正发给模型**的那条消息。
       *
       * 拼在客户端而不是 host：引用本来就是"用户这条消息的一部分"，拼好之后
       * 追问上下文、历史回放、升格全都天然带着它，host 只负责**给上下文**（那条路由）。
       * 没有引用时**原样返回提问** —— 老路径一个字都不变。
       *
       * 每段引用固定给：来源 + 【引用处上下文】（被引用的部分用【】标出）。
       * 上下文里没带上原文时（被截断、或标记失败）再补一段【引用原文】——
       * 绝不让模型去猜"引的是哪句"。
       */
      function composeQuestion(quotes, question) {
        var ask = String(question || '').trim()
        var list = quotes || []
        if (list.length === 0) return ask
        var lines = []
        for (var i = 0; i < list.length; i += 1) {
          var quote = list[i]
          var context = String(quote.context || '').trim()
          lines.push('【引用 ' + (i + 1) + '】（来自' + quoteLabelOf(quote) + '）')
          if (context) {
            lines.push('【引用处上下文】（被引用的部分用【】标出）')
            lines.push(context)
            if (!contextHasQuote(context, quote.text)) {
              lines.push('')
              lines.push('【引用原文】')
              lines.push(quote.text)
            }
          } else {
            lines.push(quote.text)
          }
          lines.push('')
        }
        lines.push('【我的问题】')
        lines.push(ask || QUOTE_ONLY_QUESTION)
        return lines.join('\n')
      }

      /** 某一轮"实际发出去"的文本：用户那轮带引用块，助手轮就是正文。 */
      function sentTextOf(turn) {
        if (!turn) return ''
        if (turn.role === 'user') return turn.sent || turn.text || ''
        return turn.text || ''
      }

      /** 导出给 host 的轮次（历史落盘 / 升格）：用户那轮把引用块一起带走。 */
      function exportTurns() {
        var out = []
        for (var i = 0; i < state.turns.length; i += 1) {
          out.push({ role: state.turns[i].role, text: sentTextOf(state.turns[i]) })
        }
        return out
      }

      // —— 侧边栏网页（iframe）划词桥的父侧接线 ——

      /**
       * 我们桥过的帧：frame → 自己建的 blob url（'' = srcdoc 帧，没有 blob 要回收）。
       * 用 Map 而不是数组：既要按帧查自己的 url，也要遍历找回消息来源对应的帧。
       */
      var bridged = new Map()
      /** 总开关：host 的 bridgeSidebarPreview 说关就关（见下面 ping 分支）。 */
      var bridgeOn = true
      /** 扫描节流用的定时器 id。 */
      var bridgeScanId = 0
      var bridgeObserver = null

      function ownedUrl(frame) {
        var url = bridged.get(frame)
        return url === undefined ? '' : url
      }

      /** 消息来源 → 帧（只认我们桥过的帧，别的窗口发来的消息一概不理）。 */
      function frameBySource(source) {
        var found = null
        bridged.forEach(function (url, frame) {
          if (found) return
          try {
            if (frame.contentWindow && frame.contentWindow === source) found = frame
          } catch (error) {
            /* 跨源取 contentWindow 可能抛，忽略 */
          }
        })
        return found
      }

      /** 沙箱补一个 allow-scripts（**绝不补 allow-same-origin**）：桥要跑起来。 */
      function ensureScriptsAllowed(frame) {
        var sandbox = frame.getAttribute('sandbox')
        if (sandbox === null) return // 没有 sandbox 属性 = 同源帧，不归这条路管
        if (!/(^|\s)allow-scripts(\s|$)/.test(sandbox)) {
          frame.setAttribute('sandbox', (sandbox + ' allow-scripts').trim())
        }
      }

      /** 帧内坐标 → 视口坐标；选区滚出帧的可视区就返回 null（免得浮标飘到主会话上）。 */
      function mapFrameRect(frame, reported) {
        if (!reported) return null
        var box
        try {
          box = frame.getBoundingClientRect()
        } catch (error) {
          return null
        }
        if (!box || (!box.width && !box.height)) return null
        var left = box.left + Number(reported.x || 0)
        var top = box.top + Number(reported.y || 0)
        var right = box.left + Number(reported.right || 0)
        var bottom = box.top + Number(reported.bottom || 0)
        if (!(right > left)) right = left + Number(reported.w || 0)
        if (!(bottom > top)) bottom = top + Number(reported.h || 0)
        if (bottom < box.top + 2 || top > box.bottom - 2) return null
        top = clamp(top, box.top, box.bottom)
        bottom = clamp(bottom, box.top, box.bottom)
        left = clamp(left, box.left, box.right)
        right = clamp(right, box.left, box.right)
        return {
          left: left,
          top: top,
          right: right,
          bottom: bottom,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
        }
      }

      /** 面板里的位置标签：帧内认出来的（代码块/表格）优先，否则按帧的来源给。 */
      function labelForFrame(frame, frameLabel) {
        if (frameLabel === '代码块' || frameLabel === '表格') return frameLabel
        if (frame.getAttribute('data-html-preview') !== null) return '侧边栏网页'
        // 其他插件的网页（例如「图解」）：用帧自己的 title 当位置标签，比笼统的"网页内容"有用
        var title = String(frame.getAttribute('title') || '')
          .replace(/\s+/g, ' ')
          .trim()
        return title ? title.slice(0, 24) : '网页内容'
      }

      /**
       * 这一帧能不能桥。
       *
       * 只认"文档确实是我们能改写的那两种"：`srcdoc` 或 `blob:` —— 远端站点 iframe 与
       * 路由 URL 的预览器（如 better-sidebar 的 HTML 预览）一概不动，它们的资源改写
       * 与生命周期归它们自己。
       *
       * 沙箱上分两档，因为"补 allow-scripts"是有代价的：
       *   · 宿主自己的 HTML 预览（`data-html-preview`）：内容已由宿主 DOMPurify 清洗成
       *     "无脚本、无外链"，补 allow-scripts 之后真正会跑的只有桥自己，可以补；
       *   · 其他插件的网页（如「图解」的 `blob:` 帧）：**只桥本来就允许脚本的**——
       *     不给别人的沙箱加权限，免得把一份刻意不跑脚本的文档变成会跑脚本。
       */
      function bridgeableFrame(frame) {
        if (!frame || frame.nodeType !== 1 || !frame.isConnected) return false
        if (panel.contains(frame)) return false // 我们自己的小窗（含网页答案预览）不桥
        var hasSrcdoc = frame.getAttribute('srcdoc') !== null
        var src = frame.getAttribute('src') || ''
        if (!hasSrcdoc && !/^blob:/i.test(src)) return false
        var sandbox = frame.getAttribute('sandbox')
        if (sandbox === null) return false
        if (frame.getAttribute('data-html-preview') !== null) return true
        return /(^|\s)allow-scripts(\s|$)/.test(sandbox)
      }

      function bridgeFrame(frame) {
        if (!bridgeOn || !bridgeableFrame(frame)) return
        var srcdoc = frame.getAttribute('srcdoc')
        if (srcdoc !== null && srcdoc !== undefined) {
          if (srcdoc.indexOf(BRIDGE_MARK) >= 0) return // 已经桥过（我们自己写回去的那份）
          var next = bridgeIntoHtml(srcdoc)
          if (!next) return
          // 顺序有讲究（Chrome 153 实测）：**先补沙箱、再改 srcdoc，且必须在同一个任务里**。
          // 先改 srcdoc 再补沙箱、或者分两个任务改，帧都不会带着 allow-scripts 重新加载
          // （脚本静默不跑，表现为"注入了但没反应"）。
          ensureScriptsAllowed(frame)
          frame.setAttribute('data-dsh-sel-bridged', '1')
          frame.setAttribute('srcdoc', next)
          bridged.set(frame, '')
          return
        }
        var src = frame.getAttribute('src') || ''
        // 只动 blob:（宿主与「图解」这类插件都是用它装生成页的）。
        // 路由 URL / 远端地址一概不碰：那些的资源改写与生命周期归宿主，插手只会弄坏预览。
        if (!/^blob:/i.test(src)) return
        if (src === ownedUrl(frame)) return // 已经是我们换上去的那份
        fetch(src)
          .then(function (response) {
            // 原 blob 的 MIME **要跟着搬**：blob: 文档没有"父文档编码"可继承，
            // 编码只来自这个 content-type（或页面里的 meta）。「图解」建 blob 时写的是
            // `text/html;charset=utf-8`，我们若退回裸 `text/html`，页面又没写 meta charset 的话，
            // 整页中文会变成乱码（实测过：`鍥捐В椤?`）。
            var type = 'text/html'
            try {
              var header = response.headers && response.headers.get && response.headers.get('content-type')
              if (header) type = header
            } catch (error) {
              /* 取不到就退回 text/html：与原行为一致 */
            }
            return response.text().then(function (text) {
              return { text: text, type: type }
            })
          })
          .then(function (loaded) {
            if (!bridgeOn || !frame.isConnected) return
            var bridgedHtml = bridgeIntoHtml(loaded.text)
            if (!bridgedHtml) return
            var url = URL.createObjectURL(new Blob([bridgedHtml], { type: loaded.type }))
            var previous = ownedUrl(frame)
            bridged.set(frame, url)
            ensureScriptsAllowed(frame)
            frame.setAttribute('data-dsh-sel-bridged', '1')
            frame.setAttribute('src', url)
            if (previous) {
              try {
                URL.revokeObjectURL(previous)
              } catch (error) {
                /* 回收失败不致命 */
              }
            }
          })
          .catch(function () {
            /* 读不到就放着：原预览照常显示，只是这一帧没有划词桥 */
          })
      }

      /** 帧没了（关标签页/切源码视图）就顺手回收我们自己建的 blob，别漏。 */
      function pruneBridged() {
        var dead = []
        bridged.forEach(function (url, frame) {
          if (!frame.isConnected) dead.push(frame)
        })
        for (var i = 0; i < dead.length; i += 1) {
          var url = bridged.get(dead[i])
          if (url) {
            try {
              URL.revokeObjectURL(url)
            } catch (error) {
              /* 回收失败不致命 */
            }
          }
          // 帧没了就不会再有 clear 消息了：把它占着的那条选区一起清掉，
          // 否则 `bridgeActive` 会一直挂着（表现为顶层选区塌掉也不收浮标）。
          if (state.selection && state.selection.frame === dead[i]) {
            state.selection = null
            state.bridgeActive = false
            hideButton()
          }
          bridged.delete(dead[i])
        }
      }

      function scanPreviewFrames() {
        if (!bridgeOn) return
        // 无浏览器测试的桩 DOM 没有 querySelectorAll：桥整体静默跳过
        if (typeof document.querySelectorAll !== 'function') return
        pruneBridged()
        // 扫全部 iframe 再按 bridgeableFrame 过滤：宿主的 HTML 预览、以及别的插件
        // 在侧边栏渲染的生成网页（「图解」那种 blob: 帧）都在这条路上，
        // 不能只看宿主的 data-html-preview 标记。
        var frames = document.querySelectorAll('iframe')
        for (var i = 0; i < frames.length; i += 1) bridgeFrame(frames[i])
      }

      function scheduleBridgeScan() {
        if (bridgeScanId) return
        bridgeScanId = later(function () {
          bridgeScanId = 0
          scanPreviewFrames()
        }, 120)
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
        if (!data || data.__dshSel !== 1) return
        var frame = frameBySource(event.source)
        if (!frame) return
        if (data.kind === 'press') {
          // 帧内按下：与主会话一致——先收浮标。父页面收不到帧内的 mousedown，
          // 少了这一条，在网页里点一下（取消选区、点别处、点另一个网页）浮标就赖着不走。
          if (state.selection && state.selection.source === 'iframe' && state.selection.frame !== frame) {
            // 点的是**另一个**帧：那条选区已经不是用户此刻在看的了，连状态一起清
            state.selection = null
            state.bridgeActive = false
          }
          hideButton()
          hideQuoteButton()
          return
        }
        if (data.kind === 'clear') {
          if (state.selection && state.selection.frame === frame) {
            state.selection = null
            state.bridgeActive = false
            hideButton()
            hideQuoteButton()
          }
          return
        }
        if (data.kind !== 'selection' || !data.sel) return
        if (!frame.isConnected) return
        var text = String(data.sel.text || '')
        if (!text.trim() || text.length > MAX_SELECTION) return
        var rect = mapFrameRect(frame, data.sel.rect)
        if (!rect) {
          // 选区滚出帧的可视区：把浮标收掉（帧内再滚回来会重新报）
          if (state.selection && state.selection.frame === frame) {
            hideButton()
            hideQuoteButton()
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
          label: labelForFrame(frame, data.sel.label),
        }
        state.bridgeActive = true
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
          showQuoteButton(rect)
          return
        }
        showButton(rect)
      })

      // 侧边栏里的预览帧是宿主 React 渲染的：新开标签、切预览/源码、文件变了都会换帧，
      // 所以既要初始扫一遍，也要盯着 DOM（只盯 srcdoc/src 两个属性 + 子节点增删）。
      if (typeof MutationObserver === 'function') {
        bridgeObserver = new MutationObserver(scheduleBridgeScan)
        bridgeObserver.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['srcdoc', 'src'],
        })
      }
      scheduleBridgeScan()

      // —— 面板 ——

      /** 当前会话 id（客户端 sessions 快照；取不到就留空，host 会跳过会话背景）。 */
      function currentSessionId() {
        try {
          var sessions = ctx.get('sessions')
          var store = sessions && sessions.list
          var snapshot = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null
          var id = snapshot && snapshot.current
          return id ? String(id) : ''
        } catch (error) {
          return ''
        }
      }

      /**
       * 缓存 key：选中文字 + 局部上下文片段（空白归一，避免多选/少选一个空格就换 key）。
       * 注意 key 里**不含**会话背景——本地缓存的作用就是"同一个词再点一次立刻回放"。
       */
      function cacheKeyOf(text, context) {
        return normalizeSpace(text) + '\u0000' + normalizeSpace(context)
      }

      /** 缓存里有没有"同一个词、但上下文不同"的旧结果（用来解释这次为什么没命中）。 */
      function hasSameTextElsewhere(text) {
        var prefix = normalizeSpace(text) + '\u0000'
        var keys = cache.keys()
        for (var step = keys.next(); !step.done; step = keys.next()) {
          if (step.value.indexOf(prefix) === 0) return true
        }
        return false
      }

      /**
       * 选中文字是不是**代码**。
       * 先看容器（<pre>/<code> 直接判代码），容器看不出来再按文本特征打分：
       * 行首赋值/调用、花括号分号收尾、缩进块、关键字、运算符、注释行……
       * 阈值刻意偏高——宁可把一段英文当散文，也不要把散文当代码去"逐句注释"。
       */
      function looksLikeCode(text) {
        var t = String(text || '')
        if (!t.trim()) return false
        if (t.indexOf('\n') < 0 && t.trim().length < 24) return false // 单个短词几乎不可能是代码块
        var strong = 0
        if (/^\s*(?:[\w$.]+\s*[=(]|\}|\{|<[a-zA-Z/!])/m.test(t)) strong += 1
        if (/\{\s*$|\}\s*$|;\s*$/m.test(t)) strong += 1
        if (/^\s{2,}\S/m.test(t)) strong += 1
        if (/\b(function|def|class|import|export|const|let|var|return|async|await|public|private|static|interface|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|npm|pnpm|yarn|git|docker|curl)\b/.test(t)) strong += 1
        if (/=>|->|::|!=|===?|\+=|&&|\|\||<\/[a-zA-Z]/.test(t)) strong += 1
        if (/^\s*(#|\/\/|\/\*|\*|--|<!--)/m.test(t)) strong += 1
        var lines = t.split('\n').filter(function (line) { return line.trim() })
        if (strong >= 2) return true
        return lines.length >= 3 && strong >= 1 && /[{};=()]/.test(t)
      }

      /** 'code' | 'text'：代码走「注释」，文本走「翻译 / 解读」。 */
      function selectionKind(text, label) {
        if (label === '代码块') return 'code'
        return looksLikeCode(text) ? 'code' : 'text'
      }

      /**
       * 选中文字里有没有"需要翻译的英文"（拉丁字母组成的词/句）。
       * 决定了第一节的标题：有英文 → 「翻译」，纯中文 → 「解读」（纯汉字不翻译）。
       * 规则要和 host 侧提示词一致：至少两个连续拉丁字母才算。
       */
      function hasEnglishToTranslate(text) {
        return /[A-Za-z]{2,}/.test(String(text || ''))
      }

      function applySectionTitle(kind, text) {
        var title = kind === 'code' ? '注释' : hasEnglishToTranslate(text) ? '翻译' : '解读'
        state.sectionTitle = title
        translationSection.title.textContent = title
        expandButton.title = '当前只给了' + title + '（背景 8 条，首字更快）。点这里加载完整会话背景并生成详解。'
      }

      /** 一次解读请求的载荷（会话 id 让 host 能拉取会话背景）。 */
      function buildPayload(text, context, label, refresh, stage) {
        return {
          text: text,
          context: context,
          label: label,
          title: document.title,
          url: location.href,
          sessionId: currentSessionId(),
          kind: selectionKind(text, label),
          stage: stage === 'detail' ? 'detail' : 'translation',
          ...(refresh ? { refresh: true } : {}),
          // 模型选择对整窗生效（首轮/详解也用它）；effort 只影响追问档，host 侧自己忽略
          ...(state.modelChoice ? { provider: state.modelChoice.provider, model: state.modelChoice.model } : {}),
          ...(state.effort ? { effort: state.effort } : {}),
        }
      }

      function openForSelection(selection) {
        // 侧边栏网页里的选区：父页面读不到那个文档，上下文只能由帧内桥就地采好带过来
        if (selection.source === 'iframe') {
          openPanelWith(selection.text, selection.context || '', selection.label, selection.rect, selection.keyContext)
          return
        }
        var contextInfo = collectContext(selection.range ? rangeSelection(selection.range) : window.getSelection())
        openPanelWith(selection.text, contextInfo.context, contextInfo.label, selection.rect, contextInfo.keyContext)
      }

      /**
       * 打开面板的公共路径：真实选区与自检钩子**共用**这一条，
       * 否则钩子会绕过缓存（缓存行为只能靠人工点选才能验证）。
       */
      function openPanelWith(text, context, label, anchor, keyContext) {
        state.payload = buildPayload(text, context, label)
        state.kind = state.payload.kind
        hideButton()
        showPanel(anchor)
        quote.textContent = text.length > 240 ? text.slice(0, 240) + ' …' : text
        applySectionTitle(state.kind, text)
        // key 用稳定上下文（选中文字**之前**那段）；真正喂模型时仍然用完整上下文
        var cacheKey = cacheKeyOf(text, keyContext === undefined ? context : keyContext)
        var cached = cache.get(cacheKey)
        state.cacheKey = cacheKey
        state.turns = []
        // 换了一段选中文字 = 换了一次对话：上一段攒的引用不该跟过来
        clearQuotes()
        state.parts = (cached && cached.parts) || { translation: '', detail: '' }
        state.stage = ''
        state.raw = ''
        renderTurns()
        if (cached) {
          state.turns = (cached.turns || []).slice()
          state.phase = 'done'
          state.stage = ''
          state.chars = (state.parts.translation || '').length + (state.parts.detail || '').length
          state.error = ''
          state.sharedCache = false
          state.fromCache = true
          state.sameTextHint = false
          state.elapsed = 0
          state.toolBusy = false
          state.cacheState = 'local'
          paint()
          renderTurns()
          return
        }
        // 未命中：如果缓存里躺过"同一个词"，多半是上下文不同——说清楚，别让人以为缓存坏了
        state.sameTextHint = hasSameTextElsewhere(text)
        // 先问 host 有没有这段对话的历史：命中就直接回放，不调模型；没有才发请求
        state.phase = 'loading'
        state.startedAt = Date.now()
        paint()
        restoreFromHistory(cacheKey, function () {
          runRequest(state.payload, cacheKey)
        })
      }
      /** 由 Range 还原一个 selection 形状的对象（collectContext 只用到这两个方法）。 */
      function rangeSelection(range) {
        return {
          rangeCount: 1,
          getRangeAt: function () {
            return range
          },
          toString: function () {
            return range.toString()
          },
        }
      }

      /** 胶囊左侧那截"最近一次划的是什么"（太长就截断）。 */
      function pillSnippet() {
        var text = state.payload && state.payload.text ? String(state.payload.text) : ''
        text = text.replace(/\s+/g, ' ').trim()
        if (!text) return ''
        return text.length > 12 ? text.slice(0, 12) + '…' : text
      }

      /** 胶囊状态：进行中报阶段 + 秒数，其余报结果状态。tone 决定圆点颜色。 */
      function pillStatus() {
        if (state.asking) {
          var askingFor = state.askingStartedAt ? ((Date.now() - state.askingStartedAt) / 1000).toFixed(1) + 's' : ''
          return { tone: 'busy', text: '追问中 ' + askingFor }
        }
        if (state.phase === 'loading' || state.phase === 'streaming') {
          var label = state.toolBusy ? '检索中' : state.stage === 'detail' ? '详解中' : state.chars > 0 ? '生成中' : '翻译中'
          var seconds = state.startedAt ? ((Date.now() - state.startedAt) / 1000).toFixed(1) + 's' : ''
          return { tone: 'busy', text: label + ' ' + seconds }
        }
        if (state.phase === 'error') return { tone: 'error', text: '失败' }
        if (state.phase === 'paused') return { tone: 'paused', text: '已停止' }
        if (state.phase === 'done') {
          var rounds = 0
          for (var i = 0; i < state.turns.length; i += 1) if (state.turns[i].role === 'user') rounds += 1
          return { tone: 'done', text: rounds > 0 ? '完成 · ' + rounds + ' 轮' : '完成' }
        }
        return { tone: 'idle', text: '就绪' }
      }

      /** 画胶囊（只在文本真的变了才写 DOM，避免每帧动布局）。 */
      function paintPill() {
        var status = pillStatus()
        var snippet = pillSnippet()
        var name = snippet || '划词解读'
        var meta = '· ' + status.text
        if (pillName.textContent !== name) pillName.textContent = name
        if (pillMeta.textContent !== meta) pillMeta.textContent = meta
        if (pill.getAttribute('data-tone') !== status.tone) pill.setAttribute('data-tone', status.tone)
        pill.setAttribute('data-open', panelOpen ? '1' : '0')
        // 和费用胶囊一样的小三角：▴ 收起状态可展开，▾ 已展开
        var caret = panelOpen ? '▾' : '▴'
        if (pillCaret.textContent !== caret) pillCaret.textContent = caret
        pill.title = [
          snippet ? '最近一次划词：' + snippet : '还没有划过词',
          status.text,
          panelOpen ? '点击收起小窗' : '点击回到这个小窗',
        ].join('｜')
      }

      /**
       * 找 dsh-spend 那枚费用胶囊的容器。
       *
       * 真实 DOM（0.19.x 实测）：外层 `<div id="dsh-spend-widget">` **没有 class**，
       * 里面才是带 `.dsu-widget` 的那层（position:fixed 的就是它），胶囊本身是 `.dsu-pill`。
       * 之前只按 class `.dsh-spend-widget` 找——真实页面里**永远找不到**，
       * 于是位置退化成兜底值、宽度也固定不了（表现：胶囊随文字伸缩、和费用胶囊差 2px 没对齐）。
       */
      function spendHost() {
        var outer = null
        try {
          if (typeof document.getElementById === 'function') outer = document.getElementById('dsh-spend-widget')
        } catch (error) {
          /* noop */
        }
        if (!outer) outer = document.querySelector('.dsu-widget') || document.querySelector('.dsh-spend-widget')
        if (!outer) return null
        // 真正定位/定宽的是里层那层；外层只是挂载点
        var inner = outer.querySelector ? outer.querySelector('.dsu-widget') : null
        return inner || outer
      }

      /**
       * 把胶囊摆到右下角"费用胶囊"上方。
       * 那个插件不一定装着、也不一定什么时候出现，所以每次都用实测位置，取不到才用兜底偏移。
       */
      function placePill() {
        // 兜底位置：**贴页面底部**（和费用胶囊自己的 right:20/bottom:20 同高）。
        // 以前兜底是 64，等于永远给"下面那枚胶囊"留位置——没装那个插件时就悬在半空（实测被吐槽）。
        var right = 20
        var bottom = 20
        var width = 0
        try {
          var host = spendHost()
          pillHost = host || null
          if (host) {
            var rect = host.getBoundingClientRect()
            if (rect.width > 0 || rect.height > 0) {
              right = Math.max(8, Math.round(window.innerWidth - rect.right))
              // 纵向按整个容器算：费用面板展开时，胶囊要待在面板**上方**而不是压住它
              bottom = Math.max(8, Math.round(window.innerHeight - rect.top + 10))
            }
            // 宽度只认那枚胶囊本身（容器展开成面板时会变宽，不能跟着走）
            var capsule = host.querySelector('.dsu-pill') || host.firstElementChild
            if (capsule) {
              var capsuleRect = capsule.getBoundingClientRect()
              if (capsuleRect.width > 0) {
                right = Math.max(8, Math.round(window.innerWidth - capsuleRect.right))
                width = Math.round(capsuleRect.width)
              }
            }
          }
        } catch (error) {
          /* noop：量不到就留在兜底位置 */
        }
        // 只在真的变了才写 style（每帧无脑赋值会让浏览器反复标脏样式）
        var changed = false
        var wantedRight = right + 'px'
        var wantedBottom = bottom + 'px'
        // 宽度**写死**成费用胶囊的宽度：文字长短不再让它伸缩（长文字自己省略号收尾）
        var wantedWidth = width > 0 ? width + 'px' : ''
        if (pill.style.right !== wantedRight) {
          pill.style.right = wantedRight
          changed = true
        }
        if (pill.style.bottom !== wantedBottom) {
          pill.style.bottom = wantedBottom
          changed = true
        }
        if (pill.style.width !== wantedWidth) {
          pill.style.width = wantedWidth
          changed = true
        }
        return changed
      }

      /**
       * 贴位置的节奏：**自适应退避**。
       *
       * 量一次很便宜（实测 500 次共 2ms ≈ 4µs/次，且 0 次 DOM 写入），但不该永远按固定频率空转：
       * 位置/宽度没变就逐次拉长间隔（2s → 3s → 4.5s … 封顶 60s），一旦发现变化立刻回到 2s。
       * 这样"费用数字在涨、面板在开合"时跟得紧，长时间不动时几乎不占任何东西。
       */
      /**
       * 费用胶囊尺寸一变就立刻重贴（浏览器有 ResizeObserver 就用它，事件驱动、零空转）。
       *
       * 光靠轮询的话，"费用数字变长"要等下一次 tick 才被发现——退避到 15s 时就是最多 15s 的错位。
       * 观察器负责"立刻"，轮询退化成兜底（发现迟到挂载的插件、以及没有 ResizeObserver 的环境）。
       */
      function ensureResizeWatch() {
        if (typeof ResizeObserver !== 'function' || !pillHost || pillHost === pillWatched) return
        if (pillObserver) {
          try {
            pillObserver.disconnect()
          } catch (error) {
            /* noop */
          }
        }
        pillWatched = pillHost
        try {
          pillObserver = new ResizeObserver(function () {
            pillPollDelay = PILL_POLL_MIN
            placePill()
          })
          pillObserver.observe(pillHost)
        } catch (error) {
          pillObserver = null
        }
      }

      function pillPollStep() {
        var changed = placePill()
        ensureResizeWatch()
        pillPollDelay = changed ? PILL_POLL_MIN : Math.min(PILL_POLL_MAX, Math.round(pillPollDelay * 1.5))
        return pillPollDelay
      }

      function schedulePillPlacer() {
        pillPlacerId = setTimeout(function () {
          pillPollStep()
          schedulePillPlacer()
        }, pillPollDelay)
      }

      /**
       * 点胶囊：**开关小窗**。
       * 关着 → 回到"最近一次小窗"的状态（内存里没有了就回放 host 上的最近一条）；
       * 开着 → 收起（再点一次又能原样打开，不会重新请求）。
       */
      function reopenLast() {
        if (panelOpen) {
          // 再点一次 = 收起（和右上角 ✕ 同一条路径：还在飞的请求会被中止并记成「已停止」）
          closePanel()
          return
        }
        var hasLive = !!(
          state.payload &&
          (state.parts.translation ||
            state.parts.detail ||
            state.turns.length > 0 ||
            state.phase === 'error' ||
            state.phase === 'paused' ||
            state.phase === 'loading' ||
            state.phase === 'streaming')
        )
        if (hasLive) {
          // 原位重开：一个字都不重新请求，连进度都是刚才那个
          showPanel(rectOfPill())
          paint()
          renderTurns()
          return
        }
        // 内存里没有：问 host 要最近一条小窗记录（A′ 落盘的历史），回放它
        setStatus('正在取回最近一次小窗…')
        fetch(HISTORY)
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            var entry = data && data.ok === true && data.entries && data.entries[0] ? data.entries[0] : null
            if (!entry) {
              setStatus('还没有可回放的小窗：先选一段文字试试')
              return
            }
            loadHistoryEntry(entry.key, rectOfPill())
          })
          .catch(function () {
            setStatus('取回最近一次小窗失败')
          })
      }

      /** 胶囊的屏幕矩形（当作面板的锚点：面板会落在它上方）。 */
      function rectOfPill() {
        var rect = pill.getBoundingClientRect()
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
      }

      function showPanel(anchor) {
        panelOpen = true
        // 键盘用户开窗即可打字：这一轮的输入框一旦可见就聚焦一次（见 focusComposerOnce）
        askFocusPending = true
        // 小窗一开，浮标就换成「❝ 引用」那一套（解读浮标收掉，引用浮标等新选区）
        hideButton()
        hideQuoteButton()
        state.quoteSelection = null
        panel.style.display = 'flex'
        panel.style.left = '0px'
        panel.style.top = '0px'
        // 面板刚显示出来才量得到 scrollHeight：草稿里原来的几行要立刻撑开
        autoGrowAskBox()
        var width = panel.offsetWidth
        var height = panel.offsetHeight
        var left = anchor ? anchor.left : window.innerWidth / 2 - width / 2
        var top = anchor ? anchor.bottom + 10 : 80
        if (left + width > window.innerWidth - 10) left = window.innerWidth - width - 10
        if (top + height > window.innerHeight - 10) {
          top = anchor ? anchor.top - height - 10 : Math.max(10, window.innerHeight - height - 10)
        }
        panel.style.left = Math.round(Math.max(10, left)) + 'px'
        panel.style.top = Math.round(Math.max(10, top)) + 'px'
        paintPill()
      }

      function closePanel() {
        closeModelMenu()
        panelOpen = false
        panel.style.display = 'none'
        hideHistoryList()
        // 小窗收起来了：引用浮标跟着走（它只在"小窗开着"时有意义）
        hideQuoteButton()
        state.quoteSelection = null
        // 正在录音/识别就到此为止：麦**一定要松开**（不能让标签页一直显示"正在使用麦克风"），
        // 识别出来的文字也没地方放了 —— 连同提示一起静默收掉。
        cancelVoice()
        // 收起小窗不该被记成"失败"：打个标记，让 fail() 走「已停止」而不是「解读失败」
        if (state.request) state.aborted = true
        if (state.request) state.request.abort()
        state.request = null
        paintPill()
      }

      /**
       * 状态提示：**界面上不显示**（页脚那条和后来的浮层都去掉了）。
       * 保留函数是为了语义不丢——最近一条记进 state.lastStatus，自检钩子可读，17 处调用点也不用改。
       */
      function setStatus(text) {
        state.lastStatus = String(text || '')
      }

      /**
       * 面板用"宽版"还是"窄版"：详解已出、或已有对话（含正在追问）时宽版。
       *
       * 单独抽出来是因为追问路径（ask 开始 / finish）不经过 paint()，
       * 不在这里同步的话"翻译出完直接追问"会一直卡在窄面板里，消息区挤成一列。
       */
      /**
       * 「展开详解」什么时候露面：翻译刚出完、还没追问过、也还没展开过。
       * 一旦发过追问（有用户轮次）就收起来——已经在对话里了，再摆一个"展开详解"是多余的。
       */
      function syncExpandCta() {
        var hasDetail = !!(state.parts.detail || state.stage === 'detail')
        var translationReady = state.phase === 'done' && !!state.parts.translation
        var asked = false
        for (var i = 0; i < state.turns.length; i += 1) {
          if (state.turns[i].role === 'user') asked = true
        }
        expandButton.style.display = !hasDetail && translationReady && !asked ? '' : 'none'
        expandButton.disabled = false
        return asked
      }

      function syncPanelStage() {
        var hasDetail = !!(state.parts.detail || state.stage === 'detail')
        var wide = hasDetail || state.turns.length > 0 || state.asking
        panel.setAttribute('data-stage', wide ? 'detail' : 'translation')
        return wide
      }

      /**
       * 页脚进度文案：**只有阶段和秒数**，不含任何工具细节。
       * 检索阶段说"正在检索资料"，其余按流式阶段说话——几十秒的检索总得有个交代，
       * 但"查了什么、命中多少、拿了哪些链接"属于模型的原料，不往小窗里发。
       */
      function progressText() {
        var seconds = ((Date.now() - state.startedAt) / 1000).toFixed(1)
        var what = state.toolBusy ? '正在检索资料…' : state.phase === 'loading' ? '正在分析…' : '生成中…'
        return what + ' ' + seconds + 's'
      }

      function paint() {
        var streaming = state.phase === 'loading' || state.phase === 'streaming'
        var stage = state.stage
        var selected = state.payload && state.payload.text ? state.payload.text : state.selection ? state.selection.text : ''
        var sections = splitSections(visibleRaw())

        // 翻译节：首轮流式期间逐字渲染；已有结果就用结果；一个字都还没有时给等待特效
        var live = stripEchoPrefix(stage === 'detail' ? '' : sections.translation || sections.other, selected)
        var liveDetail = (sections.detail || sections.other || '').trim()
        if (state.parts.translation) {
          renderRich(translationSection.content, stripEchoPrefix(state.parts.translation, selected), { callout: true, settled: true })
        } else if (stage !== 'detail' && live.trim()) {
          renderRich(translationSection.content, live, { callout: true, settled: state.phase === 'done' })
        } else if (stage !== 'detail' && streaming) {
          // 首轮：请求刚发出到第一个字之间（含模型思考期，可能好几秒）必须有动静
          showWaiting(translationSection.content, '正在翻译…', {
            startedAt: state.startedAt,
            effort: state.effort,
            // 创建时 start 事件还没到，state.effort 是空的；用函数实时读，档位才不会显示成兜底值
            effortOf: function () { return state.stageEffort || 'low' },
            thoughtOf: function () { return state.thought },
          })
        } else if (state.phase === 'error') {
          translationSection.content.textContent = ''
        } else if (state.phase === 'done') {
          // 流结束了却一个字都没有：别留空白，明确说一声（否则看起来和"还在加载"一样）
          translationSection.content.textContent = '（这次没有返回内容）'
          translationSection.content.appendChild(retryButton)
          retryButton.style.display = ''
        }

        // 已停止（收起小窗 / 按了停止）：**不管有没有半截内容**都要交代清楚，并把「重新生成」放到下面
        if (state.phase === 'paused') {
          translationSection.content.appendChild(
            el('div', 'dsh-sel-note', '（已停止：这一轮被中断了，上面是已经生成的部分）'),
          )
          translationSection.content.appendChild(retryButton)
          retryButton.style.display = ''
        }

        // 伪造的工具调用被剥掉时，正文下面补一句交代（不是没查，是这轮没工具可用）
        if (state.phase === 'done' && state.toolResidue) {
          var hasNote = false
          for (var ni = 0; ni < translationSection.content.children.length; ni += 1) {
            if (translationSection.content.children[ni].className === 'dsh-sel-note') hasNote = true
          }
          if (!hasNote) {
            translationSection.content.appendChild(
              el('div', 'dsh-sel-note', '（本轮没有可用工具：模型输出的工具调用格式已忽略，以上是它凭已有知识的回答）'),
            )
          }
        }

        // 详解节：只在第二阶段出现（或已缓存过）
        var wantDetail = !!(state.parts.detail || stage === 'detail')
        detailSection.root.style.display = wantDetail ? '' : 'none'
        if (state.parts.detail) {
          renderRich(detailSection.content, state.parts.detail, { callout: true, settled: true })
        } else if (stage === 'detail' && liveDetail) {
          renderRich(detailSection.content, liveDetail, { callout: true, settled: state.phase === 'done' })
        } else if (wantDetail && streaming) {
          showWaiting(detailSection.content, '正在读完整会话背景…', {
            startedAt: state.startedAt,
            effort: state.effort,
            effortOf: function () { return state.stageEffort || 'high' },
            thoughtOf: function () { return state.thought },
          })
        }

        // —— 按阶段重排 ——
        // 只有翻译时：更窄的面板、不显示小节序号（轻量卡片形态）
        var hasDetail = !!(state.parts.detail || stage === 'detail')
        // 追问输入框：**翻译一出来就能问，不必先展开详解**
        var translationReady = state.phase === 'done' && !!state.parts.translation
        var wide = syncPanelStage()
        // 配色按**面板实际底色**选（不看系统偏好）：主题实现方式怎么变都不影响
        layer.setAttribute('data-theme', isDarkSurface(panel) ? 'dark' : 'light')
        panel.setAttribute('data-theme', isDarkSurface(panel) ? 'dark' : 'light')
        askRow.style.display = wide || translationReady || state.quotes.length > 0 ? '' : 'none'
        // 展开 CTA：翻译还在跑（含思考期）时先不出现——那时候该看的是等待特效，
        // 摆在下面只会是个灰着的按钮，反而像"没反应"；发过追问之后也收起（见 syncExpandCta）。
        syncExpandCta()
        closeButton.title = '关闭（Esc）'
        // 「重新生成」是内容区里的临时按钮：正常路径上先收回，避免被上一次追加后留在正文里
        if (state.phase !== 'error' && state.phase !== 'paused' && retryButton.parentNode) {
          retryButton.parentNode.removeChild(retryButton)
        }
        if (state.phase === 'loading' || state.phase === 'streaming') {
          setStatus(progressText())
          retryButton.style.display = 'none'
        } else if (state.phase === 'paused') {
          setStatus('已停止（收起小窗时中止）')
          retryButton.style.display = ''
        } else if (state.phase === 'error') {
          setStatus('')
          translationSection.content.textContent = ''
          detailSection.content.textContent = ''
          var err = el('div', 'dsh-sel-err', '解读失败：' + state.error)
          translationSection.content.appendChild(err)
          translationSection.content.appendChild(retryButton)
          detailSection.root.style.display = 'none'
          retryButton.style.display = ''
        } else if (state.phase === 'done') {
          setStatus(
            '完成 · 耗时 ' +
              formatDuration(state.elapsed) +
              ' · ' +
              state.chars +
              ' 字' +
              (state.fromHistory
                ? ' · 历史回放（上次的对话）'
                : state.fromCache
                  ? ' · 本地缓存（未重新请求）'
                  : state.sharedCache
                    ? ' · 结果缓存（host 回放）'
                    : state.sameTextHint
                      ? ' · 同词但上下文不同，重新生成'
                      : ''),
          )
          retryButton.style.display = ''
        }
        renderTurns()
        // 首轮解读还在流式时不让追问（历史里还没有完整结论）
        refreshAskState()
        paintPill()
        keepInsideViewport()
        focusComposerOnce()
      }

      /**
       * 开窗后**只聚焦一次**输入框（键盘用户不用先 Tab 两下）。
       *
       * 三个克制的地方：
       *   · 等输入框真的可见才聚焦（首轮翻译还在跑时它是藏着的，聚焦藏着的元素没意义）；
       *   · 用户已经在别处打字（主会话输入框、侧边栏…）就**不抢**焦点，并就此作罢；
       *   · preventScroll：别因为聚焦把页面滚一下（划完词页面跳走最难受）。
       */
      function focusComposerOnce() {
        if (!askFocusPending || !panelOpen) return
        if (askRow.style.display === 'none') return
        var active = document.activeElement
        var inside = active && (active === panel || active === askBox || (panel.contains && panel.contains(active)))
        if (active && active !== document.body && !inside) {
          askFocusPending = false // 人家已经在别处打字了，这次开窗就不再抢
          return
        }
        askFocusPending = false
        try {
          askBox.focus({ preventScroll: true })
        } catch (error) {
          try {
            askBox.focus()
          } catch (ignored) {
            /* 桩环境 */
          }
        }
      }

      /** 内容变高后把面板拉回视口内。 */
      function keepInsideViewport() {
        if (!panelOpen) return
        var rect = panel.getBoundingClientRect()
        var width = Math.min(rect.width, window.innerWidth - 12)
        var left = clamp(rect.left, 6, Math.max(6, window.innerWidth - width - 6))
        var top = clamp(rect.top, 6, Math.max(6, window.innerHeight - 64))
        panel.style.left = Math.round(left) + 'px'
        panel.style.top = Math.round(top) + 'px'
      }

      /**
       * 剥掉模型伪造的工具调用残渣。
       *
       * 没有工具可用时，模型会照着自己的习惯把调用"写"成正文（实测见过
       * `<ds_safety_tool_call><tool_name>web_search</tool_name>…` 整段喷出来）。
       * 这里在**渲染时**清理（不改 state.raw，流式期间半截标签也不会丢内容）。
       */
      /**
       * ── 历史折叠 ──────────────────────────────────────────────────────────
       * 追问时历史是"原文逐字带上"，于是整页 HTML（实测 8k 字 ≈ 2,150 tokens）
       * 会在之后**每一轮**重发一次，还占掉 20 条窗口里的位置。
       *
       * 这里把它折叠成**结构化 Markdown**（标题/表格行列/列表/强调/代码都保留，
       * 只丢 <style>、class、内联 style、SVG 路径这些"渲染实现细节"），
       * 实测：8,021 字 → 1,146 字，可见文本覆盖率 100.0%，≈2,150 → ≈860 tokens。
       *
       * 三条边界：
       *   ① 只作用于**发历史**这一步 —— 面板里渲染的、代码视图复制的永远是原文；
       *   ② 折一次就缓存在那一轮（`turn.foldedCache`），之后每轮直接复用，不重折；
       *   ③ **最近一轮保持原样** —— 用户说"把上一页的高亮改成蓝色"时仍能改到版式。
       */
      var FOLD_HISTORY_KEEP_LATEST = true
      var foldCount = 0
      var HTML_VOID_TAGS = {
        area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
        link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1,
      }

      /**
       * 极简 HTML 解析（正则切词 + 栈建树）。
       *
       * 故意**不用 DOMParser**：那样在 Node 单测里只能走降级路径，"测试通过"和"线上行为"就成了两套代码。
       * 自己解析之后，浏览器与单测跑的是同一份实现（代价是对畸形 HTML 的容错不如浏览器，可接受）。
       */
      function parseHtmlLite(html) {
        var root = { tag: '#root', attrs: {}, children: [] }
        var stack = [root]
        var re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g
        var token
        while ((token = re.exec(String(html || ''))) !== null) {
          var chunk = token[0]
          if (chunk.charAt(0) !== '<') {
            stack[stack.length - 1].children.push({ tag: '#text', text: chunk, attrs: {}, children: [] })
            continue
          }
          if (chunk.charAt(1) === '!') continue // 注释 / doctype
          if (chunk.charAt(1) === '/') {
            var closing = chunk.slice(2, -1).replace(/\s+/g, '').toLowerCase()
            for (var i = stack.length - 1; i > 0; i -= 1) {
              if (stack[i].tag === closing) {
                stack.length = i
                break
              }
            }
            continue
          }
          var nameMatch = /^<([a-zA-Z][-a-zA-Z0-9:]*)/.exec(chunk)
          if (!nameMatch) continue
          var tag = nameMatch[1].toLowerCase()
          var node = { tag: tag, attrs: parseHtmlAttrs(chunk), children: [] }
          stack[stack.length - 1].children.push(node)
          if (!/\/>$/.test(chunk) && !HTML_VOID_TAGS[tag]) stack.push(node)
        }
        return root
      }

      function parseHtmlAttrs(chunk) {
        var attrs = {}
        var re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
        var m
        while ((m = re.exec(chunk)) !== null) {
          attrs[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5]
        }
        if (/\shidden(\s|>|\/)/i.test(chunk)) attrs.hidden = ''
        return attrs
      }

      function elementChildren(node) {
        var out = []
        var kids = node.children || []
        for (var i = 0; i < kids.length; i += 1) if (kids[i].tag !== '#text') out.push(kids[i])
        return out
      }

      /** 收集子树里所有指定标签。 */
      function collectByTag(node, tag) {
        var found = []
        var kids = node.children || []
        for (var i = 0; i < kids.length; i += 1) {
          var child = kids[i]
          if (child.tag === '#text') continue
          if (child.tag === tag) found.push(child)
          var deeper = collectByTag(child, tag)
          for (var d = 0; d < deeper.length; d += 1) found.push(deeper[d])
        }
        return found
      }

      /** 原样文本（代码块用：保留换行，不做空白折叠）。 */
      function textOfRaw(node) {
        var text = ''
        var kids = node.children || []
        for (var i = 0; i < kids.length; i += 1) {
          var child = kids[i]
          if (child.tag === '#text') text += String(child.text || '')
          else text += textOfRaw(child)
        }
        return text
      }

      /** 折叠失败时的最后兜底：只去标签留文字。 */
      function stripTagsToText(html) {
        return String(html || '')
          .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|li|tr|h[1-6]|section|blockquote)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      }

      /** 把整页 HTML 折成结构化 Markdown（规则见 docs/fold-lab.html）。 */
      function foldHtmlToMarkdown(html) {
        var root = parseHtmlLite(html)
        var out = []
        var headings = {}
        var tableCount = 0
        var chartCount = 0

        function clean(text) {
          return String(text || '').replace(/\s+/g, ' ').trim()
        }
        function push(line) {
          if (clean(line)) out.push(String(line).replace(/[ \t]+$/, ''))
        }
        function attrsOf(node) {
          return node.attrs || {}
        }
        function isHidden(node) {
          var attrs = attrsOf(node)
          var style = attrs.style || ''
          if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) return true
          return attrs.hidden !== undefined || attrs['aria-hidden'] === 'true'
        }
        function looksHighlighted(node) {
          var attrs = attrsOf(node)
          return (
            /highlight|accent|strong|emph|mark\b|hl\b/i.test(attrs.class || '') ||
            /background(-color)?\s*:\s*(#|rgb|hsl|var)/i.test(attrs.style || '')
          )
        }
        /** 行内内容：保留强调/链接/代码，丢掉标签本身。 */
        function inline(node) {
          var text = ''
          var kids = node.children || []
          for (var i = 0; i < kids.length; i += 1) {
            var child = kids[i]
            if (child.tag === '#text') {
              text += String(child.text || '').replace(/\s+/g, ' ')
              continue
            }
            var tag = child.tag
            if (tag === 'svg' || tag === 'canvas') {
              chartCount += 1
              text += '[图示]'
              continue
            }
            if (tag === 'style' || tag === 'script' || tag === 'noscript' || tag === 'iframe') continue
            var inner = inline(child)
            if (!clean(inner)) continue
            if (tag === 'strong' || tag === 'b') text += '**' + clean(inner) + '**'
            else if (tag === 'em' || tag === 'i') text += '*' + clean(inner) + '*'
            else if (tag === 'code') text += '`' + clean(inner) + '`'
            else if (tag === 'br') text += ' '
            else if (tag === 'a') {
              var href = String(attrsOf(child).href || '').trim()
              text += href && href.length <= 80 && href.charAt(0) !== '#' ? '[' + clean(inner) + '](' + href + ')' : clean(inner)
            } else if (looksHighlighted(child)) text += '**' + clean(inner) + '**'
            else text += inner
          }
          return text
        }
        function textOf(node) {
          return clean(inline(node))
        }
        function walk(parent, depth) {
          var kids = elementChildren(parent)
          for (var i = 0; i < kids.length; i += 1) {
            var node = kids[i]
            var tag = node.tag
            if (tag === 'style' || tag === 'script' || tag === 'noscript' || tag === 'head' || tag === 'meta' ||
                tag === 'link' || tag === 'iframe' || tag === 'template') continue
            if (isHidden(node)) continue
            if (tag === 'svg' || tag === 'canvas') {
              chartCount += 1
              push('[图示]')
              continue
            }
            if (/^h[1-6]$/.test(tag)) {
              var level = Number(tag.charAt(1))
              headings[level] = (headings[level] || 0) + 1
              push(new Array(level + 1).join('#') + ' ' + textOf(node))
              continue
            }
            if (tag === 'p') {
              push(inline(node))
              continue
            }
            if (tag === 'hr') {
              push('---')
              continue
            }
            if (tag === 'ul' || tag === 'ol') {
              var index = 0
              var items = elementChildren(node)
              for (var j = 0; j < items.length; j += 1) {
                if (items[j].tag !== 'li') continue
                index += 1
                var body = textOf(items[j])
                if (body) push(new Array(depth + 1).join('  ') + (tag === 'ol' ? index + '. ' : '- ') + body)
              }
              continue
            }
            if (tag === 'table') {
              tableCount += 1
              var rows = collectByTag(node, 'tr')
              for (var r = 0; r < rows.length; r += 1) {
                var cells = elementChildren(rows[r])
                if (!cells.length) continue
                var parts = []
                for (var c = 0; c < cells.length; c += 1) parts.push(textOf(cells[c]) || '')
                push('| ' + parts.join(' | ') + ' |')
                if (r === 0) {
                  var dashes = []
                  for (var d = 0; d < parts.length; d += 1) dashes.push('---')
                  push('|' + dashes.join('|') + '|')
                }
              }
              continue
            }
            if (tag === 'pre') {
              var code = String(textOfRaw(node) || '').replace(/^\n+/, '').replace(/\s+$/, '')
              var cut = code.length > 400
              push('```\n' + (cut ? code.slice(0, 400) + '\n…(已截断 ' + (code.length - 400) + ' 字)' : code) + '\n```')
              continue
            }
            if (tag === 'blockquote') {
              var quoted = textOf(node)
              if (quoted) push('> ' + quoted)
              continue
            }
            if (tag === 'img') {
              var alt = clean(attrsOf(node).alt)
              if (alt) push('[图片: ' + alt + ']')
              continue
            }
            if (tag === 'figcaption') {
              var caption = textOf(node)
              if (caption) push('（图注：' + caption + '）')
              continue
            }
            if (tag === 'details') {
              var summaryNode = null
              var inner = elementChildren(node)
              for (var si = 0; si < inner.length; si += 1) if (inner[si].tag === 'summary') summaryNode = inner[si]
              push('### ' + (summaryNode ? textOf(summaryNode) : '详情'))
              walk(node, depth + 1)
              continue
            }
            if (/^(div|section|article|main|header|footer|aside|nav|figure|form|label|span|center|body|html|picture|dl|dd|dt)$/.test(tag)) {
              // 容器里的**直接文本**要先收进来：<div>只有一段文字</div> 非常常见，
              // 而 walk() 只遍历元素子节点，漏掉它会丢内容（实测踩过）
              var direct = ''
              var rawKids = node.children || []
              for (var dk = 0; dk < rawKids.length; dk += 1) {
                if (rawKids[dk].tag === '#text') direct += String(rawKids[dk].text || '')
              }
              if (clean(direct)) push(direct)
              walk(node, depth)
              continue
            }
            var rest = textOf(node)
            if (rest) push(rest)
          }
        }
        walk(root, 0)
        var body = out.join('\n')

        // 一行版式摘要：把折叠丢掉的"视觉语义"补回来（明暗/主色/结构规模）
        var raw = String(html || '')
        var colors = raw.match(/#[0-9a-f]{6}/gi) || []
        var primary = '—'
        var best = -1
        for (var ci = 0; ci < colors.length; ci += 1) {
          var hits = raw.split(colors[ci]).length - 1
          if (hits > best) {
            best = hits
            primary = colors[ci].toLowerCase()
          }
        }
        var dark = /background(-color)?\s*:\s*#(0|1)[0-9a-f]{5}|background(-color)?\s*:\s*rgb\(\s*(1?[0-9]|2[0-9])\s*,/i.test(raw)
        var headBits = []
        var levels = Object.keys(headings).sort()
        for (var hi = 0; hi < levels.length; hi += 1) headBits.push(levels[hi] + ' 级 ×' + headings[levels[hi]])
        var highlights = Math.round((body.match(/\*\*/g) || []).length / 2)
        var summary = '（版式摘要：' + (dark ? '深色' : '浅色') + '版；主色 ' + primary +
          (headBits.length ? '；标题 ' + headBits.join('、') : '') +
          (tableCount ? '；对比表 ' + tableCount + ' 张' : '') +
          (chartCount ? '；图示 ' + chartCount + ' 个' : '') +
          (highlights ? '；强调/高亮 ' + highlights + ' 处' : '') + '）'
        return body + '\n\n' + summary
      }

      /**
       * 供**发历史**使用的文本：把 ```html 整页折叠成 Markdown；没有整页 HTML 就原样返回。
       * 折叠失败宁可返回原文 —— 多花 token 也比丢内容强。
       */
      function foldForHistory(text) {
        var src = String(text || '')
        if (src.indexOf('```html') < 0) return src
        foldCount += 1
        function one(whole, code) {
          try {
            return foldHtmlToMarkdown(code)
          } catch (error) {
            return whole
          }
        }
        src = src.replace(/```html[ \t]*\n([\s\S]*?)```/g, one)
        // 还有没闭合的围栏（例如"前情"里被截断的 HTML）：从围栏一直折到结尾
        src = src.replace(/```html[ \t]*\n([\s\S]*)$/, one)
        return src
      }

      /**
       * 取某一轮"发历史"用的文本：折一次缓存一次，之后每轮直接复用（不重折）。
       * streaming 中的那一轮不折也不缓存（历史本来也不含最后两条）。
       */
      function historyTextOf(turn, keepRaw) {
        if (!turn) return ''
        // 用户那轮：发出去的是什么就带回什么（带引用时是拼好的那份，见 composeQuestion）。
        // 引用块必须进历史 —— 否则下一轮模型只看到"上面那段呢？"，而"那段"已经在上下文里消失了。
        if (turn.role === 'user') return sentTextOf(turn)
        if (keepRaw) return turn.text
        if (typeof turn.foldedCache === 'string') return turn.foldedCache
        if (turn.streaming === true) return turn.text
        var folded = foldForHistory(turn.text)
        turn.foldedCache = folded
        return folded
      }

      function sanitizeToolResidue(text) {
        var out = String(text || '')
        out = out.replace(/<ds_safety_tool_call>[\s\S]*?<\/ds_safety_tool_call>\s*/gi, '')
        out = out.replace(/<ds_safety_tool_call>[\s\S]*$/i, '')
        out = out.replace(/<\/?ds_safety_tool_call>\s*/gi, '')
        // DeepSeek 原生 DSML 工具调用（全角竖线 U+FF5C 包起来的 tool_calls/invoke/parameter）。
        // host 侧已经在流里滤过一道，这里兜住"旧缓存 / 历史回放 / 升格"这些不经过 host 的路径。
        // 形态不止一种：marker 与标签名之间**可能有空格**（实测），且可能是逐标签式
        // （只有 <MARK parameter …> 而没有 tool_calls 包裹）——按"标签栈"整段丢掉最稳。
        var dsml = '\uFF5C\uFF5CDSML\uFF5C\uFF5C'
        var tag = new RegExp('</?\\s*' + dsml + '\\s*(?:tool_calls|calls|invoke|parameter)\\b[^>]*>', 'g')
        out = stripTaggedBlocks(out, tag)
        out = stripTaggedBlocks(out, /<\/?\s*ds_safety_tool_call\s*>/gi)
        return out
      }

      /** 按标签栈把"残渣块"整段删掉（未闭合就删到结尾）。 */
      function stripTaggedBlocks(text, tag) {
        var out = ''
        var rest = text
        var depth = 0
        for (;;) {
          tag.lastIndex = 0
          var hit = tag.exec(rest)
          if (!hit) {
            if (depth === 0) out += rest
            break
          }
          if (depth === 0) out += rest.slice(0, hit.index)
          depth = hit[0].charAt(1) === '/' ? Math.max(0, depth - 1) : depth + 1
          rest = rest.slice(hit.index + hit[0].length)
        }
        return out
      }

      /** 当前可见的原文（已去掉伪造的工具调用）。 */
      function visibleRaw() {
        var cleaned = sanitizeToolResidue(state.raw)
        if (cleaned !== state.raw) state.toolResidue = true
        return cleaned
      }

      // ────────────────────── 小窗对话历史（A′） ──────────────────────
      //
      // 不建会话：条目存在插件自己的目录里（host 侧 LRU 20 条）。这里负责三件事：
      //   ① 每轮结束把整段对话写回去（翻译/详解/追问/升格）
      //   ② 打开同一个词时先问 host 要历史，命中就直接回放（不调模型）
      //   ③ 「最近聊过的」列表，点一条把那段对话整个调回来

      /** 把当前状态存成一条历史（整段覆盖）。 */
      function saveHistory(options) {
        var payload = state.payload
        if (!payload || !state.cacheKey) return
        var turns = []
        var exported = exportTurns()
        for (var i = 0; i < state.turns.length; i += 1) {
          var turn = state.turns[i]
          if (turn.hidden === true) continue
          // 落盘的是"实际发出去的那份"（用户那轮带引用块）：回放出来时这轮对话是自洽的
          turns.push(exported[i])
        }
        try {
          fetch(HISTORY, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              key: state.cacheKey,
              text: payload.text,
              context: payload.context,
              label: payload.label,
              parts: state.parts,
              turns: turns,
              toolDigest: state.toolDigest,
              pinned: !!(options && options.pinned),
            }),
          }).catch(function () {
            /* 历史写失败不影响主流程 */
          })
        } catch (error) {
          /* noop */
        }
      }

      /** 用一条历史（或 host 回放结果）恢复面板。 */
      function applyHistoryEntry(entry, source) {
        var parts = entry.parts || {}
        state.parts = { translation: parts.translation || '', detail: parts.detail || '' }
        state.turns = Array.isArray(entry.turns) ? entry.turns.slice() : []
        // 回放的是**另一段**对话：输入框里攒的引用跟着清掉
        clearQuotes()
        state.toolDigest = typeof entry.toolDigest === 'string' ? entry.toolDigest : ''
        state.cacheKey = entry.key
        state.payload = buildPayload(entry.text, entry.context, entry.label)
        state.kind = state.payload.kind
        state.stage = ''
        state.raw = ''
        state.phase = 'done'
        state.error = ''
        state.sharedCache = false
        state.fromCache = source === 'local'
        state.fromHistory = source !== 'local'
        state.elapsed = 0
        state.toolBusy = false
        state.cacheState = source === 'local' ? 'local' : 'history'
        state.chars = (state.parts.translation || '').length + (state.parts.detail || '').length
        quote.textContent = entry.text.length > 240 ? entry.text.slice(0, 240) + ' …' : entry.text
        applySectionTitle(state.kind, entry.text)
        hideHistoryList()
        paint()
        renderTurns()
      }

      /**
       * 打开某个选区时，先问 host 有没有这段对话的历史：
       * **命中就直接回放（不调模型）**，没有才回调发请求。
       * 读历史超时/失败也照样发请求，不能因为历史接口卡住就不干活。
       */
      function restoreFromHistory(cacheKey, onMiss) {
        var settled = false
        function miss() {
          if (settled) return
          settled = true
          if (state.cacheKey === cacheKey && onMiss) onMiss()
        }
        var timer = setTimeout(miss, 1500)
        timers.push(timer)
        try {
          fetch(HISTORY + '?key=' + encodeURIComponent(cacheKey))
            .then(function (response) {
              return response.json()
            })
            .then(function (data) {
              if (settled) return
              // 期间用户换了选区：丢弃
              if (state.cacheKey !== cacheKey || panelOpen !== true) {
                settled = true
                return
              }
              if (data && data.ok === true && data.entry) {
                settled = true
                clearTimeout(timer)
                applyHistoryEntry(data.entry, 'history')
                return
              }
              miss()
            })
            .catch(miss)
        } catch (error) {
          miss()
        }
      }

      /** 「最近聊过的」列表。 */
      function hideHistoryList() {
        historyList.style.display = 'none'
        historyButton.removeAttribute('data-on')
      }

      /**
       * 把列表摆到面板旁边（B 方案）：
       *   ① 优先右侧（面板右边还有 220px 空间）
       *   ② 放不下就翻到左侧
       *   ③ 两侧都放不下（窄屏）→ 覆盖在面板正文上，仍然**不**进消息滚动区
       * 高度跟面板对齐（上限视口高度），自带滚动条。
       */
      function placeHistoryList() {
        var rect = panel.getBoundingClientRect()
        var width = 250
        var gap = 10
        var viewportW = window.innerWidth || 1200
        var viewportH = window.innerHeight || 800
        var left = rect.right + gap
        var side = 'right'
        if (left + width > viewportW - 8) {
          left = rect.left - width - gap
          side = 'left'
        }
        if (left < 8) {
          // 窄屏：覆盖在正文上（左对齐面板、避开头部）
          side = 'overlay'
          left = Math.max(8, rect.left + 8)
          width = Math.max(180, Math.min(rect.width - 16, 320))
        }
        var top = Math.max(8, Math.min(rect.top, viewportH - 120))
        var height = Math.max(160, Math.min(rect.height, viewportH - top - 8))
        if (side === 'overlay') {
          top = rect.top + 46
          height = Math.max(160, Math.min(rect.height - 56, viewportH - top - 8))
        }
        historyList.setAttribute('data-side', side)
        historyList.style.left = Math.round(left) + 'px'
        historyList.style.top = Math.round(top) + 'px'
        historyList.style.width = Math.round(width) + 'px'
        historyList.style.maxHeight = Math.round(height) + 'px'
      }

      function toggleHistoryList() {
        if (historyList.style.display === 'flex') {
          hideHistoryList()
          return
        }
        historyList.style.display = 'flex'
        historyButton.setAttribute('data-on', '1')
        placeHistoryList()
        openHistoryList()
      }

      /** 拉取并渲染历史列表（开关打开时、以及撤销之后都走这里）。 */
      function openHistoryList() {
        historyList.textContent = ''
        historyList.appendChild(el('div', 'dsh-sel-historytitle', '最近聊过的（点一条调回那段对话）'))
        var loading = el('div', 'dsh-sel-historyempty', '读取中…')
        historyList.appendChild(loading)
        fetch(HISTORY)
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            var entries = data && Array.isArray(data.entries) ? data.entries : []
            historyList.textContent = ''
            historyList.appendChild(el('div', 'dsh-sel-historytitle', '最近聊过的（点一条调回那段对话）'))
            if (entries.length === 0) {
              historyList.appendChild(el('div', 'dsh-sel-historyempty', '还没有历史——问过的问题会留在这里'))
              return
            }
            for (var i = 0; i < entries.length; i += 1) {
              historyList.appendChild(historyRow(entries[i]))
            }
          })
          .catch(function () {
            historyList.textContent = ''
            historyList.appendChild(el('div', 'dsh-sel-historyempty', '读不到历史'))
          })
      }

      /** 位置标签压缩：列表里不需要「页面内容」这么长。 */
      function shortLabel(label) {
        var text = String(label || '').replace(/（[^）]*）/g, '')
        if (text === '页面内容') return '页面'
        if (text === '对话消息') return '消息'
        if (text === '代码块') return '代码'
        return text
      }

      function historyRow(item) {
        var row = el('div', 'dsh-sel-historyrow')
        // 标题独占一行（不再被右边的小字挤掉），空标题也给个交代
        var title = String(item.text || '').trim()
        row.appendChild(el('div', 'dsh-sel-historytext', title || '（这次没选中文字）'))
        // 删除键：stopPropagation 很重要 —— 否则点它会被当成"点这一行去回放"
        var del = el('button', 'dsh-sel-historydel', '✕')
        del.type = 'button'
        del.title = '删除这条记录'
        del.setAttribute('aria-label', '删除这条记录')
        listen(del, 'click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          deleteHistoryEntry(item, row)
        })
        row.appendChild(del)
        var meta =
          (item.label ? shortLabel(item.label) + ' · ' : '') +
          (item.turns > 0 ? item.turns + ' 轮 · ' : '') +
          formatWhen(item.at)
        var metaNode = el('div', 'dsh-sel-historymeta')
        metaNode.appendChild(el('span', null, meta))
        if (item.pinned) metaNode.appendChild(el('span', 'dsh-sel-historypin', '已升格'))
        row.appendChild(metaNode)
        listen(row, 'click', function (event) {
          event.stopPropagation()
          loadHistoryEntry(String(item.key))
        })
        return row
      }

      /**
       * 删除一条历史（行内 ✕）。
       * 先打 DELETE 拿回被删条目的快照，再从列表里移除那一行并挂一条"撤销"；
       * 撤销就是把快照 POST 回 /history?restore=1 —— 服务端只存快照，不做复杂的状态回滚。
       */
      function deleteHistoryEntry(item, row) {
        fetch(HISTORY + '?key=' + encodeURIComponent(String(item.key)), { method: 'DELETE' })
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            if (!data || data.ok !== true) {
              setStatus('删除失败')
              return
            }
            if (!data.entry) {
              // 服务端已经没有这条了（比如另一个窗口删过）：把它从界面上拿掉就行
              if (row.parentNode) row.parentNode.removeChild(row)
              return
            }
            var snapshot = data.entry
            if (row.parentNode) row.parentNode.removeChild(row)
            showUndoBar(snapshot)
          })
          .catch(function (error) {
            setStatus('删除失败：' + String((error && error.message) || error))
          })
      }

      /** 底部"已删除 · 撤销"，5 秒后自己消失。 */
      function showUndoBar(snapshot) {
        var existing = null
        for (var i = 0; i < historyList.children.length; i += 1) {
          if (String(historyList.children[i].className).indexOf('dsh-sel-undo') >= 0) existing = historyList.children[i]
        }
        if (existing) historyList.removeChild(existing)
        var bar = el('div', 'dsh-sel-undo')
        bar.appendChild(el('span', null, '已删除「' + String(snapshot.text || '').slice(0, 12) + '…」'))
        var undo = el('button', null, '撤销')
        undo.type = 'button'
        listen(undo, 'click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          fetch(HISTORY + '?restore=1', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entry: snapshot }),
          })
            .then(function (response) {
              return response.json()
            })
            .then(function () {
              setStatus('已恢复')
              openHistoryList()
            })
            .catch(function () {
              setStatus('恢复失败')
            })
        })
        bar.appendChild(undo)
        historyList.appendChild(bar)
        setTimeout(function () {
          if (bar.parentNode) bar.parentNode.removeChild(bar)
        }, 5000)
      }

      function formatWhen(at) {
        if (!at) return ''
        var date = new Date(at)
        var now = new Date()
        var hh = ('0' + String(date.getHours())).slice(-2) + ':' + ('0' + String(date.getMinutes())).slice(-2)
        if (date.toDateString() === now.toDateString()) return hh
        var yesterday = new Date(now.getTime() - 86400000)
        if (date.toDateString() === yesterday.toDateString()) return '昨天 ' + hh
        return date.getMonth() + 1 + '月' + date.getDate() + '日 ' + hh
      }

      /**
       * 取一条历史回放。anchor 省略时：
       *   · 从「最近」列表里点一条 → **面板不挪位置**：列表本来就贴着面板摆，
       *     把面板重新锚到胶囊上会让人眼看着面板"跳到右下角胶囊上方"（实测反馈的 bug）。
       *   · 就绪状态点胶囊回放 → 锚到胶囊上方；否则面板从没被摆过位置，会跑到屏幕左上角。
       *
       * 注意：`applyHistoryEntry` 内部会收起列表，所以"是否从列表进入"必须在调用**之前**判断。
       */
      function loadHistoryEntry(key, anchor) {
        var fromList = historyList.style.display === 'flex'
        fetch(HISTORY + '?key=' + encodeURIComponent(key))
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            if (!data || data.ok !== true || !data.entry) return
            panelOpen = true
            panel.style.display = 'flex'
            applyHistoryEntry(data.entry, 'history')
            // 先画内容再摆位置：showPanel 要量面板高度才能决定放上面还是下面
            if (!fromList) showPanel(anchor || rectOfPill())
            // 内容换了、面板高度可能变 → 列表跟着重摆（列表此时已被 applyHistoryEntry 收起，按需再开）
            if (historyList.style.display === 'flex') placeHistoryList()
          })
          .catch(function () {
            /* noop */
          })
      }

      /** 工具名 → 中文标签（只用于内部摘要，不上界面）。 */
      function toolLabel(name) {
        // 小窗默认用的是 free-search 插件的工具（见 host 侧 toolNames 注释）
        if (name === 'advanced_search') return '联网搜索'
        if (name === 'platform_search') return '站内搜索'
        if (name === 'web_search') return '联网搜索' // 万一配成官方搜索，标签不变
        if (name === 'web_fetch') return '抓取网页'
        return String(name || '工具')
      }

      /** 工具结果 → 追问用的摘要（下一轮不再重查同样的内容）。 */
      function rememberToolDigest(tool) {
        var line =
          '- ' +
          toolLabel(tool.name) +
          '「' +
          String(tool.detail || '').slice(0, 60) +
          '」→ ' +
          (tool.ok === false ? '失败' : tool.chars ? tool.chars + ' 字结果' : '完成') +
          (tool.urls && tool.urls.length > 0 ? '，链接：' + tool.urls.slice(0, 3).join(' ') : '') +
          (tool.preview ? '；摘要：' + String(tool.preview).replace(/\s+/g, ' ').slice(0, 220) : '')
        state.toolDigest = (state.toolDigest ? state.toolDigest + '\n' : '') + line
        if (state.toolDigest.length > 1800) state.toolDigest = state.toolDigest.slice(-1800)
      }

      /**
       * 处理一个 tool 事件（start / done 两段）。
       *
       * 只做两件事，**一个 DOM 节点都不建**：
       *   1. done 时把结果摘要累进 state.toolDigest —— 追问时带给模型，告诉它"已经查过什么，别重查"；
       *   2. 维护 state.toolBusy —— 等待提示里写一句"正在检索资料"，免得几十秒的检索看着像卡死。
       * 查询词、命中字数、预览正文、链接、耗时一律不进小窗：小窗只放模型处理后的结果。
       */
      function applyToolEvent(message) {
        var phase = message.phase === 'done' ? 'done' : 'start'
        var callId = String(message.callId || message.name || 'tool')
        var item = null
        for (var i = 0; i < state.tools.length; i += 1) {
          if (state.tools[i].callId === callId && state.tools[i].phase === 'running' && phase === 'done') {
            item = state.tools[i]
            break
          }
        }
        if (!item) {
          item = { callId: callId, name: message.name, detail: message.detail, phase: 'running' }
          state.tools.push(item)
        }
        item.name = message.name || item.name
        item.detail = message.detail || item.detail
        if (phase === 'done') {
          item.phase = 'done'
          item.ok = message.ok !== false
          item.ms = typeof message.ms === 'number' ? message.ms : 0
          item.chars = typeof message.chars === 'number' ? message.chars : 0
          item.preview = typeof message.preview === 'string' ? message.preview : ''
          item.urls = Array.isArray(message.urls) ? message.urls : []
          rememberToolDigest(item)
        } else {
          item.phase = 'running'
        }
        state.toolBusy = phase !== 'done'
        if (state.toolBusy) setStatus(progressText())
      }

      /**
       * 内容变化前先量一次"现在是不是贴着底"。
       *
       * 之前用 scroll 事件维护 followScroll 开关：程序化 scrollTop 赋值本身也会派发 scroll，
       * 叠上流式追加，很容易算出一次假的"用户往上翻了"，开关一旦翻成 false 就再也不跟了——
       * 表现就是"追问后消息不回到底部"。改成变化前测量，稳。
       */
      function nearBottom() {
        return body.scrollHeight - body.scrollTop - body.clientHeight < 40
      }

      var stickAt = 0
      function stickToBottom() {
        stickAt = Date.now()
        body.scrollTop = body.scrollHeight
      }

      /**
       * 发完消息后**持续**贴底：内容会在之后异步长高——等待特效的思考尾巴、上一轮的预览 iframe
       * 上报新高度、面板从窄版切宽版引起重排……只在 renderTurns 里贴一次是不够的
       * （用户看到的就是"点了发送，消息没跟到最新位置"）。所以生成期间用 ResizeObserver 盯着消息区，
       * 只要"还在跟随"就再贴一次。
       */
      var chatGrowWatch = null
      function ensureChatFollow() {
        if (chatGrowWatch || typeof ResizeObserver !== 'function') return null
        chatGrowWatch = new ResizeObserver(function () {
          if (state.follow) stickToBottom()
        })
        chatGrowWatch.observe(chatLog)
        return function () {
          if (chatGrowWatch) chatGrowWatch.disconnect()
          chatGrowWatch = null
        }
      }

      /** 滚轮/触摸：用户自己滚 = 立刻收回跟随权；滚回底部再交还。 */
      function noteUserScroll(event) {
        var up = event && typeof event.deltaY === 'number' && event.deltaY < 0
        if (up) state.follow = false
        else state.follow = nearBottom()
      }

      /**
       * 普通 scroll（拖动滚动条、键盘、惯性滚动都会走到这里）。
       * 程序化赋值 scrollTop 同样会派发 scroll —— 用 stickAt 时间戳把"自己贴的底"排除，
       * 否则会被误判成"用户往上翻"，开关翻掉后再也不跟（这个坑之前踩过）。
       */
      function noteBodyScroll() {
        if (Date.now() - stickAt < 150) return
        state.follow = nearBottom()
      }

      /** 渲染追问气泡（用户右侧、助手左侧）。
       *  只更新最后一条气泡：全量重建会让滚动容器先塌再长，滚动位置被夹回顶部。 */
      function renderTurns(options) {
        var force = !!(options && options.stick === true)
        // 注意：这里仍用 nearBottom()（不管用户是滚轮还是别的途径离开底部都成立）；
        // state.follow 只服务于下面的 ResizeObserver —— 内容"长高"之后再量 nearBottom 必然是 false，
        // 所以必须有一个"长高之前是否贴底"的记忆。
        var stick = force || nearBottom()
        var visible = []
        for (var i = 0; i < state.turns.length; i++) {
          // 种子轮（前情提要）只发给模型当上下文，不在小窗里再显示一遍
          if (state.turns[i].hidden !== true) visible.push(state.turns[i])
        }
        if (chatLog.children.length !== visible.length) {
          clearWaiting(chatLog)
          chatLog.textContent = ''
          for (var j = 0; j < visible.length; j++) {
            var bubble = bubbleFor(visible[j])
            // 气泡记下自己属于哪一轮：引用时要据此取"这一轮 ± 一轮"的上下文
            bubble.__turn = visible[j]
            chatLog.appendChild(bubble)
          }
          // 刚入列的"待答"气泡：此时才挂进 DOM，可以画等待特效了
          var fresh = visible[visible.length - 1]
          if (fresh && fresh.role === 'assistant' && fresh.asking === true && !fresh.text) {
            showWaiting(chatLog.children[visible.length - 1], '正在回答…', {
              startedAt: fresh.startedAt,
              effort: fresh.effort,
              effortOf: function () { return fresh.effort || 'high' },
              thoughtOf: function () { return fresh.thought },
            })
          }
        } else if (visible.length > 0) {
          var node = chatLog.children[visible.length - 1]
          var turn = visible[visible.length - 1]
          var painted = false
          node.className = 'dsh-sel-bubble ' + (turn.role === 'user' ? 'dsh-sel-bubble-user' : 'dsh-sel-bubble-bot') + (turn.error ? ' dsh-sel-bubble-err' : '')
          if (turn.role === 'user') {
            // 用户气泡可能带引用块：签名包含引用，别每次重绘都白重建一遍
            var usig = (turn.text || '') + '|' + (turn.quotes || []).map(function (item) { return item.text }).join('\u0000')
            if (node.__sig !== usig) {
              node.__sig = usig
              fillUserBubble(node, turn)
            }
          } else if (turn.error) {
            node.textContent = turn.text
          } else if (turn.asking === true && !turn.text) {
            // 追问等待期：和首轮同一套等待特效（呼吸点 + 实时秒数 + 💭 思考尾巴）
            showWaiting(node, '正在回答…', {
              startedAt: turn.startedAt,
              effort: turn.effort,
              effortOf: function () { return turn.effort || 'high' },
              thoughtOf: function () { return turn.thought },
            })
          } else {
            clearWaiting(node)
            // 追问还在流式时先给源码；这一轮真的写完（streaming=false）再渲染成网页
            var sig = (turn.text || '') + '|' + (turn.streaming === true ? '1' : '0') + '|' + (turn.error ? '1' : '0')
            if (node.__sig !== sig) {
              // 内容没变就别重建：重建会把预览 iframe 一起换掉（多建一次 = 白闪一次）
              node.__sig = sig
              renderRich(node, sanitizeToolResidue(turn.text) || '…', { settled: turn.streaming !== true })
            }
            paintNotice(node, turn)
            paintQuoteAll(node, turn)
            painted = true
          }
          if (!painted && turn.role !== 'user') paintNotice(node, turn)
          if (!painted && turn.role !== 'user') paintQuoteAll(node, turn)
        }
        // 可见性必须在这里定：追问路径只调 renderTurns()，不会触发 paint()，
        // 之前把它挪进 paint() 导致"发送后气泡画进了 display:none 的容器里，小窗没反应"
        chatLog.style.display = visible.length > 0 ? 'flex' : 'none'
        if (stick) stickToBottom()
      }

      /** 轮次上的黄色提示行（目前用在"档位被上游拒绝、已自动回退"）。 */
      function paintNotice(node, turn) {
        var existing = null
        for (var i = 0; i < node.children.length; i += 1) {
          if (String(node.children[i].className).indexOf('dsh-sel-notice') >= 0) existing = node.children[i]
        }
        var text = turn && turn.notice ? String(turn.notice) : ''
        if (!text) {
          if (existing) node.removeChild(existing)
          return
        }
        if (!existing) {
          existing = el('p', 'dsh-sel-notice')
          node.appendChild(existing)
        }
        existing.textContent = text
      }

      /**
       * 用户气泡：有引用时**先画引用块、再画问题**（和发给模型的那份顺序一致）。
       * 只写 textContent 的话引用就看不见了 —— 模型答的是"上面那段"，
       * 而"上面那段"在气泡里根本不存在，回头看会一头雾水。
       */
      function fillUserBubble(node, turn) {
        node.textContent = ''
        var quotes = turn.quotes || []
        if (quotes.length > 0) {
          var box = el('div', 'dsh-sel-bq')
          for (var i = 0; i < quotes.length; i += 1) {
            var item = el('div', 'dsh-sel-bqitem')
            item.appendChild(el('b', null, '❝ ' + quoteLabelOf(quotes[i])))
            item.appendChild(document.createTextNode(quoteBrief(quotes[i].text, 60)))
            item.title = quotes[i].text
            box.appendChild(item)
          }
          node.appendChild(box)
        }
        if (turn.text) node.appendChild(el('div', null, turn.text))
      }

      function bubbleFor(turn) {
        var bubble = el('div', 'dsh-sel-bubble ' + (turn.role === 'user' ? 'dsh-sel-bubble-user' : 'dsh-sel-bubble-bot'))
        if (turn.role === 'user') {
          fillUserBubble(bubble, turn)
        } else if (turn.error) {
          bubble.className += ' dsh-sel-bubble-err'
          bubble.textContent = turn.text
        } else {
          renderRich(bubble, sanitizeToolResidue(turn.text) || '…', { settled: turn.streaming !== true })
        }
        if (turn.role !== 'user') {
          paintNotice(bubble, turn)
          paintQuoteAll(bubble, turn)
        }
        return bubble
      }

      /**
       * 助手气泡末尾的「❝ 引用整条」（鼠标移到这条消息上才浮出来）。
       *
       * 每次重画都要补一遍：renderRich() 会先清空气泡，按钮跟着一起没了。
       * 点的时候现读 `source.text`（一轮还在流式时文本一直在长），并折掉网页回答里的 HTML
       * —— 引用一整页 HTML 源码既长又没有提问价值，历史里本来也是折成 Markdown 的。
       */
      function paintQuoteAll(node, turn) {
        var existing = null
        for (var i = 0; i < node.children.length; i += 1) {
          if (String(node.children[i].className).indexOf('dsh-sel-bubquote') >= 0) existing = node.children[i]
        }
        var ready = turn && turn.error !== true && turn.streaming !== true && String(turn.text || '').trim()
        if (!ready) {
          if (existing) node.removeChild(existing)
          return
        }
        if (!existing) {
          existing = el('button', 'dsh-sel-bubquote')
          existing.type = 'button'
          existing.appendChild(el('span', null, '❝ 引用整条'))
          node.appendChild(existing)
        }
        existing.title = '把这一整条回答加进追问的引用'
        existing.__turn = turn
        if (existing.__wired !== true) {
          existing.__wired = true
          listen(existing, 'click', function (event) {
            event.stopPropagation()
            var source = existing.__turn
            if (!source) return
            var body = foldForHistory(sanitizeToolResidue(source.text))
            // 整条引用同样带上下文：这一轮 ± 一轮（小窗里的"一组对话"）
            addQuote(body, '小窗回答', { context: panelQuoteContext(state.turns.indexOf(source), body), session: false })
          })
        }
      }

      /** 把首轮解读结果作为追问的第一条助手上下文（截断，避免过长）。 */
      function seedHistoryFromExplanation() {
        var fallback = splitSections(sanitizeToolResidue(state.raw))
        var translation = (state.parts.translation || fallback.translation || '').trim()
        var detail = (state.parts.detail || fallback.detail || '').trim()
        // 写成"前情提要"而不是"我上一轮的回答"：否则模型会顺着把两节内容再复述一遍
        var seed =
          '（前情：已就这段选中文字给出解读——' +
          (state.sectionTitle || '翻译') +
          '：' +
          translation +
          (detail ? '；详解：' + detail : '') +
          '）'
        return seed.length > 1500 ? seed.slice(0, 1500) + '…' : seed
      }

      /** 发送按钮/输入框的可用状态：空内容或正在生成时不可发。 */
      /** 当前有没有一轮在跑（首轮/详解 或 追问）。 */
      function isGenerating() {
        return state.asking || state.phase === 'loading' || state.phase === 'streaming'
      }

      /**
       * 发送键 = 「发送」还是「停止」：生成中变成方形停止键（点了打断这次输出），
       * 空闲时是上箭头发送键（空输入才禁用）。
       */
      /**
       * 输入框跟着内容长高（到 132px 为止，再高就内部滚动）。
       *
       * textarea 的**高度由 rows 决定**，内容换行它不会自己长 —— 不补这一步，第二行起
       * 下面的字就被裁掉了。语音输入的实时字幕最吃亏：字是边说边自己长出来的，
       * 用户根本没在敲键盘，也就不会想到去拖那个框。
       * 超过上限时把最新那几行滚进视野（实时落字时光标一直在末尾）。
       */
      function autoGrowAskBox() {
        if (!askBox || !askBox.style) return
        var cap = 132
        // 先松开高度再量，否则量到的是上一次的高度（经典递归式变高）
        askBox.style.height = 'auto'
        var content = typeof askBox.scrollHeight === 'number' ? askBox.scrollHeight : 0
        if (content > 0) {
          askBox.style.height = Math.min(content, cap) + 'px'
          askBox.style.overflowY = content > cap ? 'auto' : 'hidden'
        } else {
          // 量不到内容（面板收着 / DOM 桩）：交回 CSS 的 min-height
          askBox.style.height = ''
          askBox.style.overflowY = ''
        }
        try {
          if (content > cap) askBox.scrollTop = askBox.scrollHeight
        } catch (error) {
          /* 桩环境没有 scrollTop 语义 */
        }
        // 长高之后面板可能顶出视口：拉回来（面板没开时它自己会早退）
        keepInsideViewport()
      }

      function refreshAskState() {
        autoGrowAskBox()
        var generating = isGenerating()
        var mode = generating ? 'stop' : 'send'
        if (askSend.getAttribute('data-mode') !== mode) {
          askSend.textContent = ''
          askSend.appendChild(generating ? stopIcon() : sendIcon())
          askSend.setAttribute('data-mode', mode)
          askSend.setAttribute('aria-label', generating ? '停止' : '发送')
          askSend.title = generating ? '停止生成（点一下打断这次输出）' : '发送（Enter）'
        }
        askSend.disabled = generating ? false : !String(askBox.value || '').trim() && state.quotes.length === 0
      }

      /** 停止当前这一轮：追问走自己的 abort；首轮/详解复用"用户中止"那条路径。 */
      function stopCurrent() {
        if (state.askRequest) {
          state.stopped = true
          try {
            state.askRequest.abort()
          } catch (error) {
            /* noop */
          }
          return true
        }
        if (state.request) {
          state.aborted = true // 让 fail() 走"已停止"而不是"解读失败"
          try {
            state.request.abort()
          } catch (error) {
            /* noop */
          }
          state.request = null
          return true
        }
        return false
      }

      /**
       * 发送一个追问（多轮，带历史；走 host 的 chat 模式）。
       *
       * 两段式：先**取引用的上下文**（会话里那几段要问 host 要，见 resolveQuoteContexts），
       * 再真正发。取上下文期间用 state.resolvingQuotes 挡住重复发送 ——
       * 那一刻输入框和引用区都已经清空了，再按一次 Enter 会变成"空发一条"。
       */
      function ask(question) {
        var generating = state.asking || state.phase === 'loading' || state.phase === 'streaming'
        if (generating) {
          // 以前这里是静默 return —— 点了没反应，用户不知道在等什么
          setStatus('还在生成，请稍候…（生成完就能追问）')
          return
        }
        // 这条消息发出去了，正在录的那一段就不再是"下一条提问"了：
        // 收掉它可以避免"发送后麦克风还红着"（用户会以为还在录）。
        // 已经识别出来的文字在输入框里，不受影响。
        if (voice.phase === 'recording' || voice.phase === 'requesting' || voice.phase === 'transcribing') {
          cancelVoice({ note: '已停止录音（这条先发出去）' })
        }
        var asked = String(question || '').trim()
        // 引用先取出来：只挂引用、没写问题也允许发（这时用一句兜底提问）
        var quotes = state.quotes.slice()
        if ((!asked && quotes.length === 0) || !state.payload) return
        if (state.resolvingQuotes) {
          setStatus('正在取引用的上下文…')
          return
        }
        // 引用是"下一条提问"的：立刻清空（提问已经在手上，别让下一轮又带上）
        if (quotes.length > 0) {
          state.quotes = []
          renderQuotes()
          refreshAskState()
        }
        if (quotes.length === 0) {
          sendAsk(asked, quotes)
          return
        }
        state.resolvingQuotes = true
        resolveQuoteContexts(quotes).then(function (resolved) {
          state.resolvingQuotes = false
          sendAsk(asked, resolved)
        })
      }

      /** 真正把这一轮发出去（引用已经带上上下文了）。 */
      function sendAsk(asked, quotes) {
        var payload = state.payload
        if (!payload) return
        // 引用拼进**这一条**消息：发给模型、进历史、升格用的都是拼好的那份
        var sent = composeQuestion(quotes, asked)
        if (state.turns.length === 0 && (state.raw.trim() || state.parts.translation || state.parts.detail)) {
          state.turns.push({ role: 'assistant', text: seedHistoryFromExplanation(), seed: true, hidden: true })
        }
        state.turns.push({ role: 'user', text: asked || QUOTE_ONLY_QUESTION, quotes: quotes, sent: sent })
        // asking 只管"等待特效要不要显示"（首字一到就置 false），
        // streaming 才是"这一轮还没写完"。两者必须分开：以前拿 asking 当定稿判据，
        // 结果是首字一到就认定"定稿了"→ 每个 delta 都重建一个 iframe（实测一条回答建了 24 个），
        // 既看不到源码，最后一帧还因为连续销毁/加载而卡成空白，得关掉小窗重开才渲染。
        var answerTurn = {
          role: 'assistant',
          text: '',
          asking: true,
          streaming: true,
          startedAt: Date.now(),
          thought: '',
          effort: state.chatEffort || 'high',
        }
        state.turns.push(answerTurn)
        state.asking = true
        state.askingStartedAt = Date.now()
        syncPanelStage()
        // 发过追问了：把「展开详解」收起来
        syncExpandCta()
        refreshAskState()
        // 刚发出的问题必须立刻可见（用户主动发的话，跟到底）
        state.follow = true
        ensureChatFollow()
        renderTurns({ stick: true })
        // 之后不再"定时硬贴"：面板切宽版的重排、思考尾巴、预览 iframe 上报高度……
        // 都会让消息区长高，由 ResizeObserver 负责续贴；定时硬贴会在用户翻看上文时把他拽回底部。
        if (state.sessionOpen !== undefined) { /* noop */ }
        var startedAt = Date.now()
        var timer = setInterval(function () {
          paintPill()
          // 追问期间也一样：只报"在检索/在生成"，不报工具细节
          setStatus(
            (state.toolBusy ? '正在检索资料… ' : '追问中… ') + ((Date.now() - startedAt) / 1000).toFixed(1) + 's',
          )
          updateWaitClocks()
        }, 200)
        timers.push(timer)

        var historyTurns = state.turns.slice(0, state.turns.length - 2)
        var history = historyTurns.map(function (turn, index) {
          // 最近一轮保持原样（可能还要"改这一页的版式"），更早的整页 HTML 折叠成 Markdown。
          // 折叠结果缓存在 turn 上：同一轮只折一次，之后每轮直接复用。
          var keepRaw = FOLD_HISTORY_KEEP_LATEST && index === historyTurns.length - 1
          return { role: turn.role, text: historyTextOf(turn, keepRaw) }
        })

        // 这一轮的 abort 句柄：生成中按「停止」会打断它（不是失败，保留已流出的内容）
        state.stopped = false
        var askController = new AbortController()
        state.askRequest = {
          abort: function () {
            try {
              askController.abort()
            } catch (error) {
              /* noop */
            }
          },
        }

        function finish(error) {
          clearInterval(timer)
          state.asking = false
          state.toolBusy = false
          answerTurn.asking = false
          answerTurn.streaming = false
          clearWaiting(chatLog)
          saveHistory()
          syncPanelStage()
          refreshAskState()
          state.askRequest = null
          if (state.stopped) {
            // 用户点了「停止」：不算失败，保留已经流出来的内容
            answerTurn.stopped = true
            state.stopped = false
          } else if (error) {
            answerTurn.error = true
            answerTurn.text = '追问失败：' + error
          }
          renderTurns()
          setStatus(
            answerTurn.stopped
              ? '已停止（你打断了这次输出）'
              : error
                ? ''
                : '追问完成 · 耗时 ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's',
          )
        }

        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: payload.text,
            context: payload.context,
            label: payload.label,
            sessionId: currentSessionId(),
            question: sent,
            history: history,
            ...(state.webAnswer ? { webAnswer: true } : {}),
            ...(state.modelChoice ? { provider: state.modelChoice.provider, model: state.modelChoice.model } : {}),
            ...(state.effort ? { effort: state.effort } : {}),
            ...(state.toolDigest ? { toolDigest: state.toolDigest } : {}),
          }),
          signal: askController.signal,
        })
          .then(function (response) {
            if (!response.ok) {
              return response
                .json()
                .catch(function () {
                  return {}
                })
                .then(function (data) {
                  throw new Error(data && data.error ? data.error : 'HTTP ' + response.status)
                })
            }
            var reader = response.body.getReader()
            var decoder = new TextDecoder()
            var buffer = ''
            function handle(block) {
              var lines = block.split('\n')
              for (var i = 0; i < lines.length; i++) {
                var line = lines[i]
                if (line.indexOf('data:') !== 0) continue
                var json = line.slice(5).trim()
                if (!json) continue
                var message
                try {
                  message = JSON.parse(json)
                } catch (error) {
                  continue
                }
                if (message.type === 'delta') {
                  if (!answerTurn.text.trim()) answerTurn.asking = false
                  answerTurn.text += message.text
                  scheduleTurnsRender()
                } else if (message.type === 'thought') {
                  // 追问也能看到"在想什么"；只改文本，不重绘
                  answerTurn.thought = (answerTurn.thought + message.text).slice(-400)
                } else if (message.type === 'start') {
                  if (message.effort) answerTurn.effort = String(message.effort)
                } else if (message.type === 'drop') {
                  // 同首轮：工具轮里的旁白不算答案，撤回去并挂到思考尾巴上
                  var askDrop = typeof message.chars === 'number' ? message.chars : 0
                  var askDropText = typeof message.text === 'string' ? message.text : ''
                  var askDropped = ''
                  if (askDropText && answerTurn.text.length >= askDropText.length && answerTurn.text.slice(-askDropText.length) === askDropText) {
                    askDropped = askDropText
                    answerTurn.text = answerTurn.text.slice(0, answerTurn.text.length - askDropText.length)
                  } else if (askDrop > 0 && answerTurn.text.length > 0) {
                    askDropped = answerTurn.text.slice(Math.max(0, answerTurn.text.length - askDrop))
                    answerTurn.text = answerTurn.text.slice(0, Math.max(0, answerTurn.text.length - askDrop))
                  }
                  if (askDropped.trim()) answerTurn.thought = (answerTurn.thought + ' ' + askDropped.replace(/\s+/g, ' ')).slice(-400)
                  renderTurns()
                } else if (message.type === 'tool') {
                  // 追问里的检索同样只留状态，不留日志
                  applyToolEvent(message)
                } else if (message.type === 'strip') {
                  // host 判定"这段是模型写进正文的思考"：从已流出的正文里把这段前缀撤掉
                  var stripText = typeof message.text === 'string' ? message.text : ''
                  if (stripText && answerTurn.text.indexOf(stripText) === 0) {
                    answerTurn.text = answerTurn.text.slice(stripText.length)
                    renderTurns()
                  }
                } else if (message.type === 'notice') {
                  // host 发现档位被上游拒绝（400/401/500）会自动去掉档位重试，这里如实告诉用户，
                  // 并把"这个模型不吃这个档位"记下来 —— 下次不再拿同一个组合去撞墙
                  answerTurn.notice = String(message.text || '')
                  if ((message.code === 'effort-rejected' || message.code === 'reasoning-leak') && message.tier) {
                    rememberBadTier(message.tier, message.code === 'reasoning-leak' ? 'leak' : 'rejected')
                    // 回退到默认档：清掉持久化的选择，胶囊随即显示配置里的默认档
                    state.effort = null
                    writeStore(EFFORT_KEY, '')
                    paintModelPill()
                  }
                  scheduleTurnsRender()
                } else if (message.type === 'error') {
                  finish(message.message || '模型返回错误')
                }
              }
            }
            function pump() {
              return reader.read().then(function (result) {
                if (result.done) {
                  if (buffer.trim()) handle(buffer)
                  if (!answerTurn.error) finish(null)
                  return
                }
                buffer += decoder.decode(result.value, { stream: true })
                var index
                while ((index = buffer.indexOf('\n\n')) >= 0) {
                  var block = buffer.slice(0, index)
                  buffer = buffer.slice(index + 2)
                  handle(block)
                }
                return pump()
              })
            }
            return pump()
          })
          .catch(function (error) {
            finish(String((error && error.message) || error))
          })
      }

      /** 等待提示要不要显示"正在检索资料"（默认共用全局的检索开关）。 */
      function toolBusyNow() {
        return !!state.toolBusy
      }

      /**
       * 等待特效：呼吸点 + 文案 + 实时秒数 + 慢速流光条。
       *
       * 用**注册表**而不是单个引用：首轮解读和追问可能同时在跑，各自有自己的起始时间、
       * 推理档位和思考尾巴，不能互相盖。关键仍然是**同处同文案复用节点**——每帧重建会让
       * CSS 动画从 0% 重来，看起来就是"一直在闪"。
       */
      /**
       * 追问流式期间**限速重绘**：整块重建气泡 + 重新语法高亮很贵，
       * 一条 6KB 网页回答按每 delta 重绘会造 **22 万个 DOM 节点**（实测），小窗就是卡在这里。
       * 限到 ~11 次/秒：观感上仍是流式，节点量降一个数量级；收尾那一次照旧立刻重绘。
       */
      function scheduleTurnsRender() {
        if (turnsRenderPending) return
        var wait = Math.max(0, lastTurnsRenderAt + STREAM_RENDER_MS - Date.now())
        turnsRenderPending = true
        later(function () {
          turnsRenderPending = false
          lastTurnsRenderAt = Date.now()
          renderTurns()
        }, wait)
      }

      function showWaiting(container, label, options) {
        var text = label || '正在生成…'
        var opts = options || {}
        var entry = null
        for (var i = 0; i < waitList.length; i += 1) {
          if (waitList[i].host === container) {
            entry = waitList[i]
            break
          }
        }
        if (
          entry &&
          entry.label === text &&
          entry.node &&
          entry.node.parentNode === container &&
          container.children.length === 1
        ) {
          entry.startedAt = opts.startedAt || entry.startedAt
          updateWaitClocks()
          return entry
        }
        container.textContent = ''
        var wrap = el('div', 'dsh-sel-wait')
        var line = el('div', 'dsh-sel-waitline')
        var dots = el('span', 'dsh-sel-dots')
        dots.appendChild(el('i'))
        dots.appendChild(el('i'))
        dots.appendChild(el('i'))
        line.appendChild(dots)
        line.appendChild(el('span', null, text))
        var clock = el('span', 'dsh-sel-waitclock', '')
        line.appendChild(clock)
        wrap.appendChild(line)
        var hint = el('div', 'dsh-sel-waithint', '')
        wrap.appendChild(hint)
        var row = el('div', 'dsh-sel-skrow')
        var widths = ['100%', '66%']
        for (var b = 0; b < widths.length; b += 1) {
          var bar = el('div', 'dsh-sel-sk')
          bar.style.width = widths[b]
          row.appendChild(bar)
        }
        wrap.appendChild(row)
        container.appendChild(wrap)
        if (!entry) {
          entry = { host: container }
          waitList.push(entry)
        }
        entry.node = wrap
        entry.label = text
        entry.clock = clock
        entry.hint = hint
        entry.startedAt = opts.startedAt || Date.now()
        entry.effort = opts.effort || ''
        entry.effortOf = opts.effortOf || null
        entry.thoughtOf = opts.thoughtOf || null
        entry.busyOf = opts.busyOf || toolBusyNow
        updateWaitClocks()
        return entry
      }

      /** 清掉等待节点（可按容器清，也可全清）。节点被别的渲染顶掉时 entry 会被自动回收。 */
      function clearWaiting(container) {
        for (var i = waitList.length - 1; i >= 0; i -= 1) {
          var entry = waitList[i]
          if (container && entry.host !== container) continue
          if (entry.node && entry.node.parentNode) entry.node.parentNode.removeChild(entry.node)
          waitList.splice(i, 1)
        }
      }

      /** 秒数/思考尾巴由 200ms 的 ticker 直接写字（不重建 DOM，动画不中断）。 */
      function updateWaitClocks() {
        for (var i = waitList.length - 1; i >= 0; i -= 1) {
          var entry = waitList[i]
          if (!entry.node || !entry.node.parentNode) {
            // 宽限几拍再回收：新建的节点可能还没挂进 DOM（挂载与渲染是两步）
            entry.missed = (entry.missed || 0) + 1
            if (entry.missed > 3) waitList.splice(i, 1)
            continue
          }
          entry.missed = 0
          var seconds = entry.startedAt ? (Date.now() - entry.startedAt) / 1000 : 0
          if (entry.clock) entry.clock.textContent = seconds >= 0.3 ? seconds.toFixed(1) + 's' : ''
          if (!entry.hint) continue
          var thinking = entry.thoughtOf ? String(entry.thoughtOf() || '') : ''
          thinking = thinking.replace(/\s+/g, ' ').trim()
          if (entry.busyOf && entry.busyOf()) {
            // 检索阶段：只说"在查资料"。查询词/命中/链接都不进小窗（那是模型的原料，不是结果）
            entry.hint.textContent = '🔍 正在检索资料…'
          } else if (thinking) {
            // 看得见它在想什么，就不会以为"没反应"了
            entry.hint.textContent = '💭 ' + thinking.slice(-72)
          } else {
            // 等过 6 秒就说明一句"这是正常的"，否则用户只会觉得卡住了
            var effort = entry.effortOf ? String(entry.effortOf() || '') : entry.effort
            entry.hint.textContent = seconds >= 6 ? '推理档位 ' + (effort || 'high') + '：首字通常 4–8 秒' : ''
          }
        }
      }

      function runRequest(payload, cacheKey, options) {
        state.cacheState = 'miss'
        if (state.request) state.request.abort()
        var controller = new AbortController()
        state.request = {
          abort: function () {
            try {
              controller.abort()
            } catch (error) {
              /* noop */
            }
          },
        }
        state.raw = ''
        state.phase = 'loading'
        state.error = ''
        state.chars = 0
        state.fromCache = false
        state.sharedCache = false
        state.toolBusy = false
        state.aborted = false
        state.stageEffort = ''
        state.thought = ''
        state.tools = []
        state.toolResidue = false
        state.startedAt = Date.now()
        state.elapsed = 0
        paint()

        var ticker = setInterval(function () {
          paintPill()
          if (state.phase === 'loading' || state.phase === 'streaming') {
            setStatus(progressText())
            // 卡片里的等待特效也走秒（只改文本、不重建节点 → 动画不中断）
            updateWaitClocks()
          }
        }, 200)
        timers.push(ticker)

        function stopTicker() {
          clearInterval(ticker)
        }

        function fail(message) {
          if (state.phase === 'done') return
          // 用户收起小窗导致的中止：不算失败，记成"已停止"，重开还能接着看
          state.phase = state.aborted ? 'paused' : 'error'
          state.error = state.aborted ? '' : message
          state.toolBusy = false
          state.elapsed = Date.now() - state.startedAt
          stopTicker()
          state.request = null
          clearWaiting()
          paint()
        }

        function succeed() {
          state.phase = 'done'
          // 按内容归并（stage 只决定"请求哪一节"，不决定结果落到哪个格子）：
          // 模型偶尔会两节都写，或没写标题，这里都要接住
          var parsed = splitSections(visibleRaw())
          var translation = parsed.translation.trim()
          var detail = parsed.detail.trim()
          var loose = parsed.other.trim()
          if (!translation && !detail && loose) {
            if (state.stage === 'detail') detail = loose
            else translation = loose
          }
          if (translation) state.parts.translation = translation
          if (detail) state.parts.detail = detail
          state.elapsed = Date.now() - state.startedAt
          state.chars = state.raw.length
          state.toolBusy = false
          stopTicker()
          state.request = null
          clearWaiting()
          if (cacheKey) cache.set(cacheKey, { parts: { ...state.parts }, turns: state.turns.slice() })
          saveHistory()
          paint()
        }

        /** 本次 read 是否带来会改变画面的内容（思考流不改变画面 → 不触发重绘）。 */
        var dirty = false

        function handleEvent(block) {
          var lines = block.split('\n')
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]
            if (line.indexOf('data:') !== 0) continue
            var json = line.slice(5).trim()
            if (!json) continue
            var message
            try {
              message = JSON.parse(json)
            } catch (error) {
              continue
            }
            if (message.type === 'start') {
              state.model = message.model ? message.provider + ' · ' + message.model : message.provider || ''
              if (message.stage) state.stage = message.stage
              if (message.effort) state.stageEffort = String(message.effort)
              if (message.cached) {
                state.sharedCache = true
                state.cacheState = 'shared'
              }
              if (state.phase === 'loading') state.phase = 'streaming'
              dirty = true
              updateWaitClocks()
            } else if (message.type === 'delta') {
              state.raw += message.text
              state.phase = 'streaming'
              dirty = true
            } else if (message.type === 'thought') {
              // 只留尾巴：等待提示里显示"正在想什么"，不给正文添乱；
              // 刻意不 schedulePaint —— 由 200ms 的 ticker 写字，思考流不会把界面刷爆
              state.thought = (state.thought + message.text).slice(-400)
            } else if (message.type === 'drop') {
              // 这一轮的正文本是"过程旁白"（要调工具之前先念叨的那段）→ 从正文里撤回，
              // 挪到等待提示的思考尾巴上（它确实是模型在想什么，只是不该当答案）
              var dropChars = typeof message.chars === 'number' ? message.chars : 0
              var dropText = typeof message.text === 'string' ? message.text : ''
              var dropped = ''
              // 优先按"精确后缀"撤：host 给的就是这一轮流出来的原文，不依赖字数算得准不准；
              // 对不上（比如客户端缓存过的老会话）再退化成按字数截
              if (dropText && state.raw.length >= dropText.length && state.raw.slice(-dropText.length) === dropText) {
                dropped = dropText
                state.raw = state.raw.slice(0, state.raw.length - dropText.length)
              } else if (dropChars > 0 && state.raw.length > 0) {
                dropped = state.raw.slice(Math.max(0, state.raw.length - dropChars))
                state.raw = state.raw.slice(0, Math.max(0, state.raw.length - dropChars))
              }
              if (dropped.trim()) state.thought = (state.thought + ' ' + dropped.replace(/\s+/g, ' ')).slice(-400)
              dirty = true
            } else if (message.type === 'tool') {
              // 工具事件只更新内部状态（digest + 检索中标记），不落 DOM
              applyToolEvent(message)
              dirty = true
            } else if (message.type === 'error') {
              fail(message.message || '模型返回错误')
            } else if (message.type === 'done') {
              succeed()
            }
          }
        }

        var lastPaintAt = 0

        function schedulePaint() {
          if (rafPending) return
          rafPending = true
          var run = function () {
            requestAnimationFrame(function () {
              rafPending = false
              lastPaintAt = Date.now()
              if (state.phase === 'streaming' || state.phase === 'loading') {
                state.elapsed = Date.now() - state.startedAt
                state.chars = state.raw.length
              }
              paint()
            })
          }
          // 流式期间限速（同 scheduleTurnsRender）：长内容每帧整块重建会把小窗拖卡
          var wait = state.phase === 'streaming' ? Math.max(0, lastPaintAt + STREAM_RENDER_MS - Date.now()) : 0
          if (wait > 0) later(run, wait)
          else run()
        }

        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
          .then(function (response) {
            if (!response.ok) {
              return response
                .json()
                .catch(function () {
                  return {}
                })
                .then(function (data) {
                  throw new Error(data && data.error ? data.error : 'HTTP ' + response.status)
                })
            }
            if (!response.body || !response.body.getReader) {
              return response.text().then(function (text) {
                text.split('\n\n').forEach(handleEvent)
                succeed()
              })
            }
            var reader = response.body.getReader()
            var decoder = new TextDecoder()
            var buffer = ''
            function pump() {
              return reader.read().then(function (result) {
                if (result.done) {
                  if (buffer.trim()) handleEvent(buffer)
                  if (state.phase !== 'done' && state.phase !== 'error') succeed()
                  return
                }
                buffer += decoder.decode(result.value, { stream: true })
                var index
                dirty = false
                while ((index = buffer.indexOf('\n\n')) >= 0) {
                  var block = buffer.slice(0, index)
                  buffer = buffer.slice(index + 2)
                  handleEvent(block)
                }
                // 思考流每秒几百个事件：它只更新 ticker 写的提示行，不该把正文重绘刷爆
                if (dirty) schedulePaint()
                return pump()
              })
            }
            return pump()
          })
          .catch(function (error) {
            if (error && error.name === 'AbortError') {
              // 两种中止要分开：
              //  ① 被"重新生成"顶掉 —— state.request 已经指向新请求，什么都别做，新请求会接管画面；
              //  ② 用户收起小窗 —— state.request 已被 closePanel 清空，记成「已停止」，
              //     这样点胶囊回来还能看到进度并在原地重新生成（以前这里一律 return，
              //     结果收起小窗后状态永远停在 streaming，重开是个永不结束的等待动画）。
              if (state.aborted) fail('中止')
              return
            }
            fail(String((error && error.message) || error))
          })
      }

      /** 把这次解读（选中文字 + 两节结论 + 追问）升格成正式会话，建在来源会话同一个项目下。 */
      function promote() {
        if (state.promoting) return
        var payload = state.payload
        if (!payload) return
        // 用分阶段保存的结果：展开详解后 state.raw 里只有详解那一段，
        // 直接拿 raw 解析会导致翻译丢失（升格出来的会话里翻译变成「未记录」）
        var sections = {
          translation: state.parts.translation || splitSections(sanitizeToolResidue(state.raw)).translation,
          detail: state.parts.detail || splitSections(sanitizeToolResidue(state.raw)).detail,
        }
        state.promoting = true
        promoteButton.disabled = true
        setStatus('正在升格为会话…')
        fetch(PROMOTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: currentSessionId(),
            text: payload.text,
            context: payload.context,
            label: payload.label,
            translation: (sections.translation || '').trim(),
            detail: (sections.detail || '').trim(),
            // 带引用块的轮次：升格出来的会话里，用户当时发的就是拼好的那份
            turns: exportTurns(),
          }),
        })
          .then(function (response) {
            return response.json().then(function (data) {
              if (!response.ok || !data || data.ok !== true) {
                throw new Error((data && data.error) || 'HTTP ' + response.status)
              }
              return data
            })
          })
          .then(function (data) {
            state.promoting = false
            promoteButton.disabled = false
            var newId = String(data.sessionId || '')
            saveHistory({ pinned: true })
            setStatus('已升格为会话：' + newId.slice(0, 18) + '…')
            // 跳到新会话（同项目），并把小窗收起来
            openSession(newId)
            later(function () {
              closePanel()
            }, 120)
          })
          .catch(function (error) {
            state.promoting = false
            promoteButton.disabled = false
            setStatus('升格失败：' + String((error && error.message) || error))
          })
      }

      /** 让前端跳到新会话（GUI 会切成那个会话）。 */
      function openSession(sessionId) {
        if (!sessionId) return
        try {
          var sessions = ctx.get('sessions')
          if (sessions && typeof sessions.open === 'function') {
            sessions.open(sessionId)
            return
          }
          var workspace = ctx.get('uiWorkspace')
          if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
        } catch (error) {
          /* 跳转失败不影响会话已创建的事实 */
        }
      }

      /** 第二阶段：加载完整会话背景（24 条）并生成详解。 */
      function expandDetail() {
        var payload = state.payload
        if (!payload || state.parts.detail) return
        state.stage = 'detail'
        state.raw = ''
        // 不再带 refresh：详解请求也允许命中 host 结果缓存（背景变了 key 自然就变了）；
        // 并且把结果写回本地缓存 —— 以前传 null，导致"同一个词每次展开详解都要重跑一遍"
        state.payload = buildPayload(payload.text, payload.context, payload.label, false, 'detail')
        runRequest(state.payload, state.cacheKey)
      }

      function regenerate() {
        var payload = state.payload
        if (!payload) return
        state.fromCache = false
        // 重新生成：回到第一阶段（仅翻译），并清掉已生成的详解
        state.parts = { translation: '', detail: '' }
        state.stage = 'translation'
        state.payload = buildPayload(payload.text, payload.context, payload.label, true, 'translation')
        runRequest(state.payload, state.cacheKey)
      }

      // —— 事件 ——

      // 动画结束就摘掉动效类：`.dsh-sel-btn-pop` 用了 fill:both，
      // 不摘的话 transform 会一直被动画钉在 none 上，`:active` 的按压缩放就永远不生效
      var offPopEnd = listen(button, 'animationend', function () {
        setButtonPop(false)
      })

      var offQuotePopEnd = listen(quoteButton, 'animationend', function () {
        setQuotePop(false)
      })

      var offMouseUp = listen(document, 'mouseup', function (event) {
        // 面板里的 mouseup **也要走一次检查**：小窗开着时"划小窗正文"正是「引用」的主入口
        // （早先这里对面板直接 return —— 那是"面板里划词一律不管"年代的写法，
        //  结果就是小窗里划词毫无反应，只有气泡末尾的「引用整条」能用）。
        if (button.contains(event.target) || quoteButton.contains(event.target)) return
        scheduleCheck()
      }, true)

      var offKeyUp = listen(document, 'keyup', function (event) {
        if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Meta' || event.key.indexOf('Arrow') === 0) {
          scheduleCheck()
        }
      }, true)

      var offMouseDown = listen(document, 'mousedown', function (event) {
        var target = event.target
        // 模型菜单：点它自己和胶囊之外**任何地方**都收起。
        // 必须放在最前面 —— 下面的 historyButton / pill / panel 分支都会 return，
        // 放在后面就会被短路掉（实测：点了别处菜单不关）。
        if (modelMenu.getAttribute('data-open') === '1' && !modelMenu.contains(target) && !modelPill.contains(target)) {
          closeModelMenu()
        }
        if (historyList.contains(target)) return // 列表内部：行自己处理
        if (historyButton.contains(target)) return // 「最近」开关自己 toggle
        if (button.contains(target)) return // 浮标
        if (quoteButton.contains(target)) return // 引用浮标：点它不能先把自己收掉
        // 状态胶囊：它自己就是开关，点它的 mousedown 不能被当成"点了外面"（否则先关后开，看着像没反应）
        if (pill.contains(target)) return
        // 到这里说明点的不是侧边栏本身：**含面板正文**（消息区/输入框/选中文字）在内，
        // 一律先把侧边栏收回——它是用完就走的导航，不该等你点了"外面"才收。
        hideHistoryList()
        if (panel.contains(target)) return // 面板内的点击只收侧边栏，不关面板
        hideButton()
        hideQuoteButton()
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
        if (selection) openForSelection(selection)
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
        addQuote(selection.text, selection.label, quoteContextFor(selection))
        hideQuoteButton()
      })

      var offScroll = listen(window, 'scroll', function (event) {
        hideButton()
        hideQuoteButton()
        // 页面/面板滚动也收回侧边栏；滚动列表自身不算（它有自己的滚动条）。
        // event.target 不一定是 Node（合成事件可能是 window），contains 会抛，得自己挡一道
        var target = event && event.target
        var insideList = !!(target && target.nodeType && historyList.contains(target))
        if (historyList.style.display === 'flex' && !insideList) hideHistoryList()
      }, true)

      // —— 悬浮状态胶囊：点一下回到最近一次小窗 ——
      // —— 模型 + 推理等级（追问档） ——
      var MODEL_KEY = 'dsh-selection-explain:model' // 存 "provider\tmodel"
      var EFFORT_KEY = 'dsh-selection-explain:effort'
      var TIER_LABEL = { off: '关', low: '低', medium: '中', high: '高', max: '最大' }
      var FALLBACK_TIERS = ['off', 'low', 'high', 'max']
      var modelCatalog = { at: 0, items: [], current: null, stages: null, loading: false, error: '', leakyOff: [] }
      var modelPillClicks = 0

      var BAD_TIER_KEY = 'dsh-selection-explain:badTiers'

      function badTierKeyOf() {
        if (!state.modelChoice) return ''
        return state.modelChoice.provider + '/' + state.modelChoice.model
      }

      /** 记下"这个模型的这个档位被上游拒过"，用来在菜单里标出来。 */
      function rememberBadTier(tier, reason) {
        var key = badTierKeyOf()
        if (!key || !tier) return
        var all = {}
        try {
          all = JSON.parse(readStore(BAD_TIER_KEY, '{}')) || {}
        } catch (error) {
          all = {}
        }
        var list = all[key]
        if (!list || !list.length) list = []
        // 老格式是 ["max"]，新格式是 [{tier, reason}]；两种都认
        var found = false
        for (var i = 0; i < list.length; i += 1) {
          var item = list[i]
          var id = typeof item === 'string' ? item : item && item.tier
          if (id === tier) {
            found = true
            if (typeof item === 'string') list[i] = { tier: tier, reason: reason || 'rejected' }
            else if (reason) item.reason = reason
          }
        }
        if (!found) list.push({ tier: tier, reason: reason || 'rejected' })
        all[key] = list
        writeStore(BAD_TIER_KEY, JSON.stringify(all))
      }

      /** 该模型哪些档位有问题 → { tier: reason }（菜单里标注，reason=rejected 不支持 / leak 会泄漏思考）。 */
      function badTiersOf() {
        var key = badTierKeyOf()
        var out = {}
        if (!key) return out
        try {
          var all = JSON.parse(readStore(BAD_TIER_KEY, '{}')) || {}
          var list = all[key]
          if (!Array.isArray(list)) return out
          for (var i = 0; i < list.length; i += 1) {
            var item = list[i]
            if (typeof item === 'string') out[item] = 'rejected'
            else if (item && item.tier) out[item.tier] = item.reason || 'rejected'
          }
        } catch (error) {
          /* 坏了就当没有 */
        }
        return out
      }

      function readStore(key, fallback) {
        try {
          var value = window.localStorage ? window.localStorage.getItem(key) : null
          return value === null || value === undefined ? fallback : value
        } catch (error) {
          return fallback
        }
      }

      function writeStore(key, value) {
        try {
          if (window.localStorage) window.localStorage.setItem(key, value)
        } catch (error) {
          /* 无痕模式：只当次生效 */
        }
      }

      /** 档位显示名：优先用目录里声明的名字（Off/Low/High/Max），否则退回中文映射。 */
      function tierLabel(id) {
        if (!id) return ''
        var items = modelCatalog.items || []
        for (var i = 0; i < items.length; i += 1) {
          var choice = currentChoiceOf(items[i])
          if (!choice) continue
          var efforts = items[i].efforts || []
          for (var j = 0; j < efforts.length; j += 1) {
            if (efforts[j].id === id) return TIER_LABEL[id] || efforts[j].name || id
          }
        }
        return TIER_LABEL[id] || id
      }

      function currentChoiceOf(item) {
        if (!state.modelChoice || !item) return false
        return item.provider === state.modelChoice.provider && item.model === state.modelChoice.model
      }

      /** 胶囊文案：模型短名 + 当前档位。 */
      function paintModelPill() {
        var name = ''
        var provider = ''
        var items = modelCatalog.items || []
        for (var i = 0; i < items.length; i += 1) {
          if (currentChoiceOf(items[i])) {
            name = items[i].name || items[i].model
            provider = items[i].providerName || items[i].provider
          }
        }
        if (!name && state.modelChoice) name = state.modelChoice.model
        if (!name && modelCatalog.current) {
          name = String(modelCatalog.current.model || '')
          provider = String(modelCatalog.current.provider || '')
        }
        if (!name) name = '模型'
        // 短名：去掉 provider 前缀那种很长的写法（"DeepSeek V4.1 Flash" → 保留原样，只截断）
        modelPillName.textContent = name.length > 22 ? name.slice(0, 21) + '…' : name
        var tier = state.effort || (modelCatalog.stages && modelCatalog.stages.chat) || ''
        modelPillTier.textContent = tier ? '· ' + tierLabel(tier) : ''
        modelPill.title = (provider ? provider + ' · ' : '') + name + (tier ? ' · 推理等级 ' + tierLabel(tier) : '') +
          '（点一下切换模型或追问档位）'
      }

      /** 拉模型清单（60 秒缓存；菜单打开时才拉，不进热路径）。 */
      function loadModelCatalog(force) {
        if (modelCatalog.loading) return Promise.resolve(modelCatalog)
        if (!force && modelCatalog.items.length > 0 && Date.now() - modelCatalog.at < 60000) return Promise.resolve(modelCatalog)
        modelCatalog.loading = true
        return fetch(MODELS + (force ? '?refresh=1' : ''), { headers: { accept: 'application/json' } })
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            modelCatalog.items = Array.isArray(data && data.models) ? data.models : []
            modelCatalog.current = (data && data.current) || null
            modelCatalog.stages = (data && data.stages) || null
            modelCatalog.error = String((data && data.error) || '')
            modelCatalog.leakyOff = Array.isArray(data && data.leakyOff) ? data.leakyOff : []
            modelCatalog.at = Date.now()
            return modelCatalog
          })
          .catch(function (error) {
            modelCatalog.error = String((error && error.message) || error)
            return modelCatalog
          })
          .then(function (result) {
            modelCatalog.loading = false
            return result
          })
      }

      function renderModelMenu() {
        modelMenu.textContent = ''
        var items = modelCatalog.items || []
        var head = el('div', 'dsh-sel-pickergroup', '模型')
        modelMenu.appendChild(head)
        if (modelCatalog.loading) {
          modelMenu.appendChild(el('div', 'dsh-sel-pickerhint', '正在读取可用模型…'))
          return
        }
        if (items.length === 0) {
          modelMenu.appendChild(
            el('div', 'dsh-sel-pickerhint', modelCatalog.error ? '读取失败：' + modelCatalog.error : '没有取到可用模型清单'),
          )
        } else {
          var list = el('div', 'dsh-sel-pickerlist')
          for (var i = 0; i < items.length; i += 1) {
            ;(function (item) {
              var row = el('button', 'dsh-sel-pickerrow')
              row.type = 'button'
              row.setAttribute('role', 'menuitemradio')
              row.setAttribute('data-on', currentChoiceOf(item) ? '1' : '0')
              row.appendChild(el('span', 'dsh-sel-pickercheck', currentChoiceOf(item) ? '✓' : ''))
              row.appendChild(el('span', null, item.name || item.model))
              row.appendChild(el('span', 'dsh-sel-pickerprov', item.providerName || item.provider))
              listen(row, 'click', function (event) {
                event.preventDefault()
                event.stopPropagation()
                state.modelChoice = { provider: item.provider, model: item.model }
                writeStore(MODEL_KEY, item.provider + '\t' + item.model)
                paintModelPill()
                renderModelMenu()
                closeModelMenu()
                setStatus('模型已切到 ' + (item.name || item.model))
              })
              list.appendChild(row)
            })(items[i])
          }
          modelMenu.appendChild(list)
        }
        modelMenu.appendChild(el('div', 'dsh-sel-pickersplit'))
        modelMenu.appendChild(el('div', 'dsh-sel-pickergroup', '推理等级（追问档）'))
        var tiers = el('div', 'dsh-sel-tiers')
        var effortIds = FALLBACK_TIERS
        for (var k = 0; k < items.length; k += 1) {
          if (currentChoiceOf(items[k]) && (items[k].efforts || []).length > 0) {
            effortIds = []
            for (var e = 0; e < items[k].efforts.length; e += 1) effortIds.push(items[k].efforts[e].id)
          }
        }
        var badTiers = badTiersOf()
        // host 在进程内学到的：这个模型"关"档会把思考写进正文
        if (modelCatalog.leakyOff.indexOf((state.modelChoice ? state.modelChoice.provider : '') + '/' + (state.modelChoice ? state.modelChoice.model : '')) >= 0) {
          badTiers = { ...badTiers, off: 'leak' }
        }
        var active = state.effort || (modelCatalog.stages && modelCatalog.stages.chat) || ''
        for (var t = 0; t < effortIds.length; t += 1) {
          ;(function (id) {
            var button = el('button', 'dsh-sel-tierbtn', tierLabel(id))
            button.type = 'button'
            button.setAttribute('data-on', id === active ? '1' : '0')
            if (badTiers[id]) {
              button.setAttribute('data-bad', '1')
              button.title =
                badTiers[id] === 'leak'
                  ? '实测该模型在「' + tierLabel(id) + '」档会把思考写进正文：已自动改用「低」档'
                  : '实测该模型不支持「' + tierLabel(id) + '」档：选它会自动回退到默认档'
            }
            listen(button, 'click', function (event) {
              event.preventDefault()
              event.stopPropagation()
              state.effort = id
              writeStore(EFFORT_KEY, id)
              paintModelPill()
              renderModelMenu()
              setStatus('追问档位：' + tierLabel(id))
            })
            tiers.appendChild(button)
          })(effortIds[t])
        }
        modelMenu.appendChild(tiers)
        modelMenu.appendChild(
          el('div', 'dsh-sel-pickerhint', '模型对整窗生效；推理等级只管追问（首轮翻译仍走低档换速度）。'),
        )
      }

      function closeModelMenu() {
        modelMenu.setAttribute('data-open', '0')
        modelPill.setAttribute('aria-expanded', 'false')
      }

      function openModelMenu() {
        modelMenu.setAttribute('data-open', '1')
        modelPill.setAttribute('aria-expanded', 'true')
        renderModelMenu()
        loadModelCatalog(false).then(function () {
          if (modelMenu.getAttribute('data-open') === '1') {
            renderModelMenu()
            paintModelPill()
          }
        })
      }

      var offModelPill = listen(modelPill, 'click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        modelPillClicks += 1
        if (modelMenu.getAttribute('data-open') === '1') closeModelMenu()
        else openModelMenu()
      })
      var offModelMenu = listen(modelMenu, 'click', function (event) {
        event.stopPropagation() // 菜单内部点击不要触发"点到外面"
      })
      var offModelKeys = listen(modelMenu, 'keydown', function (event) {
        if (event.key === 'Escape') closeModelMenu()
      })

      // —— 网页模式开关 ——
      var WEB_MODE_KEY = 'dsh-selection-explain:webAnswer'
      function readWebMode() {
        try {
          return window.localStorage && window.localStorage.getItem(WEB_MODE_KEY) === '1'
        } catch (error) {
          return false
        }
      }
      function paintWebMode() {
        var on = state.webAnswer === true
        webMode.setAttribute('data-on', on ? '1' : '0')
        // 两格各自报自己的选中态（radiogroup 语义）；药丸靠 data-on 滑过去
        cellMd.setAttribute('aria-checked', on ? 'false' : 'true')
        cellWeb.setAttribute('aria-checked', on ? 'true' : 'false')
        cellMd.title = '输出偏好：Markdown —— 默认用文字回答，必要时仍可用网页'
        cellWeb.title = '输出偏好：网页 —— 复杂问题用 HTML 页面讲清楚，简单问题仍直接文字回答'
      }

      /** 设置档位（点格子 / 快捷键都走这里）。 */
      function setPref(on, focus) {
        state.webAnswer = on === true
        try {
          if (window.localStorage) window.localStorage.setItem(WEB_MODE_KEY, state.webAnswer ? '1' : '0')
        } catch (error) {
          /* 无痕模式等场景：只当次生效 */
        }
        paintWebMode()
        if (focus) (state.webAnswer ? cellWeb : cellMd).focus()
        setStatus(state.webAnswer ? '输出偏好：网页' : '输出偏好：Markdown')
        return state.webAnswer
      }
      state.webAnswer = readWebMode()
      paintWebMode()

      // 模型/档位：从 localStorage 恢复；没存过就跟随"当前路由 + 配置档位"（ping 里就有）
      var storedModel = readStore(MODEL_KEY, '')
      if (storedModel && storedModel.indexOf('\t') > 0) {
        var parts = storedModel.split('\t')
        state.modelChoice = { provider: parts[0], model: parts[1] }
      }
      var storedEffort = readStore(EFFORT_KEY, '')
      if (storedEffort) state.effort = storedEffort
      paintModelPill()
      fetch(PING + (currentSessionId() ? '?sessionId=' + encodeURIComponent(currentSessionId()) : ''), {
        headers: { accept: 'application/json' },
      })
        .then(function (response) {
          return response.json()
        })
        .then(function (data) {
          modelCatalog.current = (data && data.route) || null
          modelCatalog.stages = { chat: (data && data.reasoningEffortByStage && data.reasoningEffortByStage.chat) || '' }
          // 侧边栏网页划词桥的总开关（host 配置 bridgeSidebarPreview，默认开）
          if (data && data.bridgeSidebarPreview === false) bridgeOn = false
          paintModelPill()
          return null
        })
        .catch(function () {
          /* ping 失败不影响使用：胶囊显示默认文案 */
        })
      // 点哪一格就选哪一格（不再"点一下翻转"）——分段控件的标准行为
      var offCellMd = listen(cellMd, 'click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        setPref(false)
      })
      var offCellWeb = listen(cellWeb, 'click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        setPref(true)
      })
      // 键盘：左右方向键在两格间切换（radiogroup 惯例；Enter/Space 由 button 原生支持）
      var offPrefKeys = listen(prefSeg, 'keydown', function (event) {
        var key = event && event.key
        if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
        event.preventDefault()
        setPref(key === 'ArrowRight', true)
      })

      var offPillDown = listen(pill, 'mousedown', function (event) {
        // 拖拽/划词的手势不该被胶囊接走
        event.preventDefault()
        event.stopPropagation()
      })

      var offPillClick = listen(pill, 'click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        reopenLast()
      })

      var offPillKey = listen(pill, 'keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        reopenLast()
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
      placePill()
      ensureResizeWatch()
      schedulePillPlacer()
      paintPill()

      var offResize = listen(window, 'resize', function () {
        hideButton()
        hideQuoteButton()
        // 宽度变了 → 换行位置变了 → 输入框高度要重量（否则会是按旧宽度算出来的高度）
        autoGrowAskBox()
        // 拖窗口变小后，面板本身也要拉回视口内（否则历史列表会跟着算到屏幕外）
        keepInsideViewport()
        if (historyList.style.display === 'flex') placeHistoryList()
        // 窗口尺寸变了：立刻量一次，并把节奏调回最快
        placePill()
        pillPollDelay = PILL_POLL_MIN
      })

      var offKeyDown = listen(document, 'keydown', function (event) {
        if (event.key !== 'Escape' || !panelOpen) return
        // Esc 分两级，和主会话一致：**先退出正在进行的事，再关窗**。
        //   ① 语音进行中（录音行还在）→ 只取消这一次语音（等价于点 ✕），面板留着；
        //   ② 其余情况 → 关掉小窗（一次到位，不受"有没有追问过"限制）。
        // 以前是一律关窗：正在说一句话时按 Esc 想放弃这句话，结果整个小窗没了。
        if (captureRow.getAttribute('data-show') === '1') {
          event.preventDefault()
          event.stopPropagation()
          cancelVoice({ discard: true })
          return
        }
        event.preventDefault()
        event.stopPropagation()
        closePanel()
      }, true)

      var offHistory = listen(historyButton, 'click', function (event) {
        event.stopPropagation()
        toggleHistoryList()
      })

      var offPromote = listen(promoteButton, 'click', function (event) {
        event.stopPropagation()
        promote()
      })

      var offRetry = listen(retryButton, 'click', function (event) {
        event.stopPropagation()
        regenerate()
      })

      var offExpand = listen(expandButton, 'click', function (event) {
        event.stopPropagation()
        expandDetail()
      })

      var offAskKey = listen(askBox, 'keydown', function (event) {
        if (event.key !== 'Enter' || event.shiftKey) return
        // 输入法（中文/日文…）在组合期间按 Enter 是"确认候选词"，不是发送：
        // 这时 askBox.value 往往还是空的，照发会清空输入框 + 发空内容 → 看起来"没反应"
        if (event.isComposing === true || event.keyCode === 229) return
        event.preventDefault()
        event.stopPropagation()
        var question = askBox.value
        // 空输入框照发**只在挂了引用时**成立（引用本身就是用户要送出去的内容）
        if (!question.trim() && state.quotes.length === 0) return
        askBox.value = ''
        refreshAskState()
        ask(question)
      })

      var offAskInput = listen(askBox, 'input', function () {
        refreshAskState()
      })

      var offAskSend = listen(askSend, 'click', function (event) {
        event.stopPropagation()
        if (isGenerating()) {
          stopCurrent()
          return
        }
        var question = askBox.value
        if (!question.trim() && state.quotes.length === 0) return
        askBox.value = ''
        refreshAskState()
        ask(question)
      })

      // ══════════════════════════ 语音输入（麦克风） ══════════════════════════
      //
      // 要解决的问题：追问往往只有一两句话（"这词在这里是不是贬义？"），
      // 但**打字**这件事本身就要把手从鼠标挪到键盘——和"划词"这个动作是矛盾的。
      //
      // **UI 与主会话同一套**（官方 @deepseek-ai/dsh-experimental-client-ui-voice-input）：
      // 平时是输入框右边的 🎤；开始录之后工具行换成录音行 ——`✕` | 实时波形 | `■`，
      // 请求权限/识别中是「呼吸点 + 请允许使用麦克风…/识别中…」，出错是「原因 + 行内动作」。
      // 波形算法（80 根线 / 50ms 采样 / 1+min(1,amp*5)*17 / 右侧最新）逐行照抄，
      // 只有尺寸按小窗的 composer 收成 26px（主会话 32px）——两处看起来才是同一个东西。
      //
      // 识别出来的文字**插进输入框**（不是直接发送：识别有错字，插进去还能改，
      // 也能在同一条里接着说第二段）。录音中切走/收起小窗/这条消息发出去/停用插件
      // 都会立刻松开麦克风（不留下一直亮着的录音标识）。

      /** 状态机：idle → requesting → recording → transcribing →（feedback | idle）→ idle。 */
      var voice = {
        phase: 'idle',
        /**
         * 第几轮。停/取消/关面板都会 +1 —— 晚到的回调据此丢弃自己。
         * 没有它就会出现"明明取消了，过两秒却冒出一段文字"（异步的权限、识别都可能晚到）。
         */
        generation: 0,
        capture: null,
        abort: null,
        ticker: 0,
        waveFrame: 0,
        waveAt: 0,
        startedAt: 0,
        maxSeconds: VOICE_FALLBACK_SECONDS,
        catalog: null,
        catalogAt: 0,
        idleTimer: 0,
        pollTimer: 0,
        lastClock: -1,
        level: 0,
        lastText: '',
        /** feedback 阶段的行内动作（null = 只显示原因，不给按钮）。 */
        action: null,
        /**
         * 实时字幕（半句预览 + 停顿定稿）的运行时状态。
         * text/committed/preview 都是输入框里那一段的一部分，start 是它在 value 里的起点。
         */
        live: {
          active: false,
          disabled: false,
          reason: '',
          separator: '',
          start: -1,
          text: '',
          committed: '',
          preview: '',
          boundary: 0,
          phraseStart: 0,
          inflight: false,
          controller: null,
          timer: 0,
          tickAt: 0,
          startedAt: 0,
          previewFails: 0,
          passes: { preview: 0, commit: 0 },
          rewritten: false,
        },
      }

      /** 录音失败的统一话术（浏览器抛的是 DOMException，用户看不懂）。 */
      var VOICE_ERRORS = {
        unavailable: '当前浏览器不支持录音，请使用支持麦克风的浏览器。',
        permission: '麦克风权限未开启，请在浏览器和系统设置中允许访问。',
        missing: '没有找到麦克风设备。',
        interrupted: '录音中断，请重试。',
        empty: '未识别到语音',
        cancelled: '已取消语音输入。',
      }

      function voiceError(kind, extra) {
        var error = new Error(VOICE_ERRORS[kind] || '录音失败')
        error.voiceKind = kind
        if (extra) error.cause = extra
        return error
      }

      /** 出错信息 → 一句人话。 */
      function voiceMessageOf(error) {
        if (!error) return '未知错误'
        if (error.voiceKind) return VOICE_ERRORS[error.voiceKind] || '录音失败'
        return String(error.message || error)
      }

      /**
       * 状态行文案：
       * @param text 文案
       * @param options { dot: 显示呼吸点, tone: '' | 'warn' | 'error' }
       */
      function setVoiceActivity(text, options) {
        var opts = options || {}
        voiceActivityText.textContent = String(text || '')
        voiceActivity.setAttribute('data-tone', opts.tone || '')
        voiceDot.style.display = opts.dot ? '' : 'none'
      }

      /** 行内动作位：'prepare'（准备模型文字键）/ null（用 🎤 重录）/ 'none'（什么都不要）。 */
      function setVoiceAction(kind) {
        while (voiceActionSlot.firstChild) voiceActionSlot.removeChild(voiceActionSlot.firstChild)
        voice.action = kind || null
        if (kind === 'prepare') {
          var prepareBtn = el('button', 'dsh-sel-vact', '准备模型')
          prepareBtn.type = 'button'
          prepareBtn.title = '在本机下载并准备识别模型（首次要下载，之后一直可用）'
          listen(prepareBtn, 'click', function (event) {
            event.stopPropagation()
            prepareVoice()
          })
          voiceActionSlot.appendChild(prepareBtn)
          return prepareBtn
        }
        if (kind === 'retry') {
          var retryMic = el('button', 'dsh-sel-round')
          retryMic.type = 'button'
          retryMic.setAttribute('aria-label', '重新录音')
          retryMic.title = '重新录音'
          retryMic.appendChild(micIcon())
          listen(retryMic, 'click', function (event) {
            event.stopPropagation()
            startVoice()
          })
          voiceActionSlot.appendChild(retryMic)
          return retryMic
        }
        return null
      }

      /**
       * 出错/提示：录音行里给一句原因 +（有救的）一个动作。`retryable` 为真时给 🎤 重录键。
       * 这是主会话的 feedback 阶段：它就一直停在那儿，直到用户点 ✕（或行内动作）。
       */
      function voiceFeedback(text, tone, action) {
        voice.phase = 'feedback'
        setVoiceActivity(text, { tone: tone || '' })
        setVoiceAction(action)
        paintVoice()
      }

      /** 按状态摆好录音行：idle 显 🎤，其余显录音行（✕ / 波形或文案 / ■ 或行内动作）。 */
      function paintVoice() {
        var phase = voice.phase
        var capturing = phase !== 'idle'
        captureRow.setAttribute('data-show', capturing ? '1' : '0')
        captureRow.style.display = capturing ? 'flex' : 'none'
        // 录音行出现时，工具行左边那三样（输出偏好 / 模型 / 🎤）让位——和主会话一样，
        // 录音时那行只讲一件事：怎么结束、结束之后会得到什么。
        webMode.style.display = capturing ? 'none' : ''
        askSpacer.style.display = capturing ? 'none' : ''
        modelPill.style.display = capturing ? 'none' : ''
        micButton.style.display = capturing ? 'none' : ''
        // 中间那格：录音时是波形，其余是文案；■ 只在录音时出现
        var recording = phase === 'recording'
        waveSvg.style.display = recording ? '' : 'none'
        voiceActivity.style.display = recording ? 'none' : 'flex'
        voiceStop.style.display = recording ? 'inline-grid' : 'none'
        voiceCancel.title = phase === 'feedback' ? '关闭（Esc）' : '取消（Esc）'
        voiceCancel.setAttribute('aria-label', voiceCancel.title)
        // 🎤 触发键的状态：只在"请求权限"时转圈（其余都是普通图标 —— 和主会话一致）
        micButton.setAttribute('data-state', phase === 'requesting' ? 'requesting' : 'idle')
        micButton.setAttribute('aria-pressed', capturing ? 'true' : 'false')
        micButton.title = '语音输入（点一下开始说，再点一下结束并转成文字）'
      }

      /** 识别器：目录里默认那个（没有就第一个）。 */
      function voiceProvider(catalog) {
        if (!catalog || !catalog.providers || !catalog.providers.length) return null
        var id = catalog.selection && catalog.selection.providerId
        for (var i = 0; i < catalog.providers.length; i += 1) {
          if (catalog.providers[i].id === id) return catalog.providers[i]
        }
        return catalog.providers[0]
      }

      /** 目录（有哪些识别器、能不能录、能录多久）：短暂缓存，别每点一次都问一遍 host。 */
      function fetchSpeechCatalog(force) {
        var now = Date.now()
        if (!force && voice.catalog && now - voice.catalogAt < VOICE_CATALOG_TTL) {
          return Promise.resolve(voice.catalog)
        }
        return fetch(SPEECH_API)
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            voice.catalog = data
            voice.catalogAt = Date.now()
            return data
          })
      }

      /**
       * 波形推进一帧（算法照抄主会话的 Waveform）：
       * 新的电平从右边挤进来，整排往左推；静音时每条线只有 2px 高 —— 就是那条虚线。
       * @param level 本帧电平（0 = 不采样，只把尺寸摆正）
       */
      function repaintWave(level) {
        var next = level
        for (var i = 0; i < waveBars.length; i += 1) {
          var bar = waveBars[i]
          var previous = bar.level
          bar.level = next
          next = previous
          var height = 1 + Math.min(1, bar.level * 5) * 17
          bar.node.setAttribute('y1', String(20 - height))
          bar.node.setAttribute('y2', String(20 + height))
        }
      }

      /** 把波形清回静音基线（新一次录音从头开始画；主会话是重建 SVG，效果一样）。 */
      function resetWave() {
        for (var i = 0; i < waveBars.length; i += 1) {
          waveBars[i].level = 0
          waveBars[i].node.setAttribute('y1', '19')
          waveBars[i].node.setAttribute('y2', '21')
        }
      }

      function stopWaveLoop() {
        if (voice.waveFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(voice.waveFrame)
        voice.waveFrame = 0
        voice.waveAt = 0
      }

      /** 录音时的波形循环：50ms 采一次音量（和主会话同一个节拍）。 */
      function startWaveLoop() {
        stopWaveLoop()
        if (typeof requestAnimationFrame !== 'function') return
        var draw = function (now) {
          if (voice.phase !== 'recording') return
          // rAF 会给时间戳，但不是所有环境都给（桩、老实现）——缺了就用当前时间，别让波形卡住
          var at = typeof now === 'number' ? now : Date.now()
          if (at - voice.waveAt >= 50) {
            voice.waveAt = at
            var level = 0
            try {
              level = voice.capture ? voice.capture.level() : 0
            } catch (error) {
              level = 0
            }
            voice.level = level
            repaintWave(level)
          }
          voice.waveFrame = requestAnimationFrame(draw)
        }
        voice.waveFrame = requestAnimationFrame(draw)
      }

      function stopVoiceTicker() {
        if (voice.ticker) clearInterval(voice.ticker)
        voice.ticker = 0
        voice.lastClock = -1
        stopWaveLoop()
      }

      /**
       * 一次录音的全部资源：麦克风流、MediaRecorder、AudioContext、分析器。
       *
       * 这几个东西**必须一起释放**：只停 MediaRecorder 的话，标签页上会一直挂着
       * "正在使用麦克风"的标识（用户会以为在偷听），AudioContext 也会一直占着音频线程。
       */
      function createCapture(onError) {
        var stream = null
        var recorder = null
        var context = null
        var analyser = null
        var samples = new Float32Array(256)
        var chunks = []
        var lifetime = new AbortController()
        var disposal = null
        // ── 采样水龙头（实时字幕用）──
        var tap = null
        var tapGain = null
        /** 16k 采样的分片表（按时序），tapLength 是总采样数。 */
        var tapChunks = []
        var tapLength = 0
        /** 线性重采样的分数位置：跨回调连续，接缝处才不会每 93ms 丢一个点。 */
        var tapPos = 0
        /** 最近一次"有声"的采样位置与墙钟时间（停顿定稿靠它切边界）。 */
        var tapLoudIndex = -1
        var tapLoudAt = 0

        /** 把一块原始采样（context 采样率）重采样到 16k 攒起来，同时判"有声/静音"。 */
        function acceptChunk(input) {
          var rate = context && context.sampleRate ? context.sampleRate : 48000
          var step = rate / 16000
          var out = []
          var pos = tapPos
          while (pos + 1 < input.length) {
            var index = Math.floor(pos)
            var frac = pos - index
            out.push(input[index] * (1 - frac) + input[index + 1] * frac)
            pos += step
          }
          tapPos = pos - input.length
          if (out.length) {
            var piece = Float32Array.from(out)
            tapChunks.push(piece)
            tapLength += piece.length
          }
          var sum = 0
          for (var i = 0; i < input.length; i += 1) sum += input[i] * input[i]
          if (Math.sqrt(sum / input.length) >= VOICE_SILENCE_RMS) {
            tapLoudIndex = tapLength
            tapLoudAt = Date.now()
          }
        }

        /** 取 [from, to) 的 16k 采样（越界自动夹住）。 */
        function readSamples(from, to) {
          var a = Math.max(0, Math.floor(from))
          var b = Math.min(tapLength, Math.ceil(to))
          if (b <= a) return new Float32Array(0)
          var out = new Float32Array(b - a)
          var cursor = 0
          for (var i = 0; i < tapChunks.length; i += 1) {
            var piece = tapChunks[i]
            var end = cursor + piece.length
            if (end > a && cursor < b) {
              var s = Math.max(0, a - cursor)
              var e = Math.min(piece.length, b - cursor)
              out.set(piece.subarray(s, e), cursor + s - a)
            }
            cursor = end
            if (cursor >= b) break
          }
          return out
        }

        function release() {
          try {
            lifetime.abort()
          } catch (error) {
            /* noop */
          }
          if (tap) {
            try {
              tap.onaudioprocess = null
              tap.disconnect()
            } catch (error) {
              /* noop */
            }
          }
          if (tapGain) {
            try {
              tapGain.disconnect()
            } catch (error) {
              /* noop */
            }
          }
          try {
            if (recorder && recorder.state === 'recording') recorder.stop()
          } catch (error) {
            /* noop */
          }
          if (stream) {
            var tracks = stream.getTracks ? stream.getTracks() : []
            for (var i = 0; i < tracks.length; i += 1) {
              try {
                tracks[i].stop()
              } catch (error) {
                /* noop */
              }
            }
          }
          if (context && typeof context.close === 'function') {
            try {
              context.close()
            } catch (error) {
              /* noop */
            }
          }
          return Promise.resolve()
        }

        function dispose() {
          if (!disposal) disposal = release()
          return disposal
        }

        /** decodeAudioData：新浏览器返回 Promise，老 Safari 只认回调 —— 两种都接住。 */
        function decode(buffer) {
          return new Promise(function (resolve, reject) {
            var pending = context.decodeAudioData(buffer, resolve, reject)
            if (pending && typeof pending.then === 'function') pending.then(resolve, reject)
          })
        }

        return {
          /** 拿麦克风并开始录（权限弹窗可能很久，晚到的授权要能作废）。 */
          start: function () {
            var devices = navigator.mediaDevices
            if (!devices || typeof devices.getUserMedia !== 'function' || typeof window.MediaRecorder === 'undefined') {
              return Promise.reject(voiceError('unavailable'))
            }
            return devices
              .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
              .then(
                function (got) {
                  stream = got
                  if (lifetime.signal.aborted) {
                    var granted = got.getTracks ? got.getTracks() : []
                    for (var i = 0; i < granted.length; i += 1) granted[i].stop()
                    throw voiceError('cancelled')
                  }
                  var Ctx = window.AudioContext || window.webkitAudioContext
                  try {
                    context = new Ctx()
                    // 没有用户手势时浏览器会把 AudioContext 挂起：波形要动就得唤醒它
                    if (context.state === 'suspended' && typeof context.resume === 'function') {
                      var resumed = context.resume()
                      if (resumed && typeof resumed.catch === 'function') resumed.catch(function () {})
                    }
                    analyser = context.createAnalyser()
                    analyser.fftSize = samples.length
                    var source = context.createMediaStreamSource(stream)
                    source.connect(analyser)
                    // 原始采样水龙头（只服务于实时字幕）：
                    // MediaRecorder 那条路不变，最终那份规范 WAV 还是它出的；这里多接一路，
                    // 直接把麦克风的采样按 16k 攒起来 —— 切窗口时不用每个 tick 去 decode 整个 blob。
                    // ScriptProcessorNode 已废弃但仍在（实测 Chrome 153 可用）；没有就关掉实时层。
                    try {
                      if (typeof context.createScriptProcessor === 'function') {
                        tap = context.createScriptProcessor(4096, 1, 1)
                        tapGain = context.createGain()
                        tapGain.gain.value = 0 // 静音：别把麦克风回灌到扬声器（会啸叫）
                        tap.onaudioprocess = function (event) {
                          var input = event && event.inputBuffer ? event.inputBuffer.getChannelData(0) : null
                          if (input) acceptChunk(input)
                        }
                        source.connect(tap)
                        tap.connect(tapGain)
                        tapGain.connect(context.destination)
                      }
                    } catch (error) {
                      tap = null
                    }
                    recorder = new window.MediaRecorder(stream)
                    recorder.ondataavailable = function (event) {
                      if (!lifetime.signal.aborted && event.data && event.data.size > 0) chunks.push(event.data)
                    }
                    recorder.onerror = function () {
                      if (lifetime.signal.aborted) return
                      dispose()
                      if (onError) onError(voiceError('interrupted'))
                    }
                    recorder.start()
                    return true
                  } catch (error) {
                    return dispose().then(function () {
                      throw error
                    })
                  }
                },
                function (error) {
                  if (error && error.name === 'NotAllowedError') throw voiceError('permission')
                  if (error && error.name === 'NotFoundError') throw voiceError('missing')
                  throw error
                },
              )
          },

          /** 实时音量（0..1 左右）：只用来驱动波形。 */
          level: function () {
            if (!analyser) return 0
            try {
              analyser.getFloatTimeDomainData(samples)
            } catch (error) {
              return 0
            }
            var sum = 0
            for (var i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
            return Math.sqrt(sum / samples.length)
          },

          /**
           * 结束录音 → 规范 WAV。
           * 重采样交给 OfflineAudioContext（浏览器自带的重采样质量比自己写的线性插值好得多），
           * 采样率固定 16kHz —— host 只收这一种（见 host 的 validateWave）。
           */
          stop: function (maxSeconds) {
            return new Promise(function (resolve, reject) {
              if (!recorder || !context || recorder.state !== 'recording') {
                dispose().then(function () {
                  reject(voiceError('empty'))
                })
                return
              }
              var settled = false
              function giveUp(error) {
                if (settled) return
                settled = true
                dispose().then(function () {
                  reject(error)
                })
              }
              recorder.onstop = function () {
                if (settled) return
                settled = true
                var blob
                try {
                  var tracks = stream && stream.getTracks ? stream.getTracks() : []
                  for (var i = 0; i < tracks.length; i += 1) tracks[i].stop()
                  blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
                  if (!blob.size) throw voiceError('empty')
                } catch (error) {
                  dispose().then(function () {
                    reject(error)
                  })
                  return
                }
                blob
                  .arrayBuffer()
                  .then(function (buffer) {
                    return decode(buffer)
                  })
                  .then(function (decoded) {
                    if (lifetime.signal.aborted) throw voiceError('cancelled')
                    var rate = 16000
                    var seconds = Math.min(decoded.duration || 0, maxSeconds)
                    var frames = Math.max(1, Math.floor(seconds * rate))
                    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext
                    var offline = new Offline(1, frames, rate)
                    var source = offline.createBufferSource()
                    source.buffer = decoded
                    source.connect(offline.destination)
                    source.start()
                    return offline.startRendering()
                  })
                  .then(function (rendered) {
                    return encodeWave(rendered.getChannelData(0))
                  })
                  .then(resolve, function (error) {
                    reject(error)
                  })
              }
              recorder.onerror = function () {
                giveUp(voiceError('empty'))
              }
              try {
                recorder.stop()
              } catch (error) {
                giveUp(error)
              }
            }).then(
              function (bytes) {
                return dispose().then(function () {
                  return bytes
                })
              },
              function (error) {
                return dispose().then(function () {
                  throw error
                })
              },
            )
          },

          dispose: dispose,
          /** 实时字幕的水龙头：没接上（浏览器没有 ScriptProcessor）时为 null。 */
          tap: {
            supported: function () {
              return !!tap
            },
            length: function () {
              return tapLength
            },
            loudIndex: function () {
              return tapLoudIndex
            },
            loudAt: function () {
              return tapLoudAt
            },
            read: readSamples,
            /** 自检/单测用：直接喂一块原始采样（真浏览器里由 onaudioprocess 调）。 */
            accept: acceptChunk,
          },
        }
      }

      /** 录音中的心跳：到点自动收尾 + 记一次电平（波形另有自己的 50ms 循环）。 */
      function startVoiceTicker() {
        stopVoiceTicker()
        voice.ticker = setInterval(function () {
          if (voice.phase !== 'recording') return
          var elapsed = Date.now() - voice.startedAt
          var limit = voice.maxSeconds || VOICE_FALLBACK_SECONDS
          if (elapsed >= limit * 1000) {
            finishVoice()
            return
          }
          voice.lastClock = Math.floor(elapsed / 1000)
        }, 200)
        startWaveLoop()
      }

      /** 识别出来的文字 → 输入框（插在光标处，前后补空格，光标落在末尾，接着还能打字）。 */
      function insertTranscript(text) {
        var current = String(askBox.value || '')
        var start = typeof askBox.selectionStart === 'number' && askBox.selectionStart >= 0 ? askBox.selectionStart : current.length
        var end = typeof askBox.selectionEnd === 'number' && askBox.selectionEnd >= start ? askBox.selectionEnd : start
        var before = current.slice(0, start)
        var after = current.slice(end)
        var prefix = before && !/\s$/.test(before) ? ' ' : ''
        var suffix = after && !/^\s/.test(after) ? ' ' : ''
        askBox.value = before + prefix + text + suffix + after
        var caret = (before + prefix + text).length
        try {
          askBox.setSelectionRange(caret, caret)
        } catch (error) {
          /* 桩环境没有这个方法 */
        }
        try {
          askBox.focus()
        } catch (error) {
          /* noop */
        }
        voice.lastText = text
        refreshAskState()
        return askBox.value
      }

      function failVoice(generation, error) {
        if (generation !== voice.generation) return
        voice.generation += 1
        var capture = voice.capture
        voice.capture = null
        stopVoiceTicker()
        if (capture) capture.dispose()
        // "用户取消"不是错（点了 ✕、收了小窗、插件停用都走这里），不给错误提示
        var kind = error && error.voiceKind
        if (kind === 'cancelled') {
          resetVoiceRow()
          return
        }
        // 没听清 / 中断 / 失败：留在 feedback 里给原因 + 🎤 重录（和主会话一致）
        voiceFeedback(voiceMessageOf(error), kind === 'empty' || kind === 'interrupted' ? 'warn' : 'error', 'retry')
      }

      /** 回到 idle：工具行原样还回去。 */
      function resetVoiceRow() {
        stopVoiceTicker()
        stopLive()
        if (voice.idleTimer) clearTimeout(voice.idleTimer)
        voice.idleTimer = 0
        voice.phase = 'idle'
        voice.action = null
        while (voiceActionSlot.firstChild) voiceActionSlot.removeChild(voiceActionSlot.firstChild)
        setVoiceActivity('', {})
        paintVoice()
      }

      // ── 实时字幕（半句预览 + 停顿定稿）──────────────────────────────────────
      //
      // 说话时字就往输入框里长：每 ~1.3s 把"还没定稿的这半句"送去识别一次，整段替换上一拍
      // 的预览；检测到 ~0.6s 静音（这句说完了）就把这句送去识别并**定稿**，之后不再变。
      // 停止（■）时仍然走原来那条"整段规范 WAV"的路，回来的结果给这一整段收口：
      //   · 整段识别**以已定稿的文字开头**（正常情况）→ 只补后半句，定稿的字一个不动；
      //   · 对不上（整段上下文让引擎改了前面）→ 以整段为准整块替换，并在自检里记一笔。
      // ✕ 取消 = 把这次插进去的文字整块撤掉（对应主会话那个 aria-label「丢弃识别文字」）。
      //
      // 为什么预览用**采样水龙头**而不是 MediaRecorder 的 blob：切窗口只要一段连续采样，
      // 而每个 tick 去 decode 整个 blob 是 O(总时长) 的白活（说到 60 秒就是每秒 decode 60 秒音频）。

      /** 定稿与预览拼起来时的连接处（中文直接接，英文补一个空格）。 */
      function liveJoin(left, right) {
        if (!left) return right
        if (!right) return left
        if (/[\s]$/.test(left) || /^[\s，。；：！？、,.!?;:]/.test(right)) return left + right
        return left + ' ' + right
      }

      /** 光标位置（拿不到就当作末尾）。 */
      function caretIndex() {
        var value = String(askBox.value || '')
        return typeof askBox.selectionStart === 'number' && askBox.selectionStart >= 0
          ? Math.min(askBox.selectionStart, value.length)
          : value.length
      }

      /** 这一段（分隔空格 + 定稿 + 预览）在输入框里该长什么样。 */
      function liveCompose() {
        var live = voice.live
        var body = liveJoin(live.committed, live.preview)
        live.text = body ? live.separator + body : ''
        return live.text
      }

      /**
       * 把这一段落到输入框里（原位替换）。
       * 用户在我们这段**里面**改过字就不抢他的编辑：停掉实时层，以后按"停止后再出字"走。
       */
      function liveWrite() {
        var live = voice.live
        var value = String(askBox.value || '')
        var previous = live.text
        var start = live.start
        if (previous) {
          if (value.indexOf(previous) >= 0) start = value.indexOf(previous)
          else if (start >= 0 && value.slice(start, start + previous.length) === previous) {
            /* 位置没变 */
          } else {
            live.disabled = true
            live.reason = 'edited'
            stopLive()
            return false
          }
        }
        if (start < 0) start = caretIndex()
        var end = previous ? start + previous.length : start
        var caret = typeof askBox.selectionStart === 'number' ? askBox.selectionStart : end
        var next = liveCompose()
        askBox.value = value.slice(0, start) + next + value.slice(end)
        live.start = next ? start : -1
        live.text = next
        var moved = next.length - previous.length
        var nextCaret = caret >= end ? caret + moved : caret
        if (nextCaret < 0) nextCaret = 0
        if (nextCaret > askBox.value.length) nextCaret = askBox.value.length
        try {
          askBox.setSelectionRange(nextCaret, nextCaret)
        } catch (error) {
          /* 桩环境没有这个方法 */
        }
        refreshAskState()
        return true
      }

      /** 从输入框里把我们这段整块撤掉（内容没被改过才撤；改过就留着，不跟用户抢字）。 */
      function liveDiscard() {
        var live = voice.live
        var value = String(askBox.value || '')
        var text = live.text
        var start = live.start
        if (text) {
          if (value.indexOf(text) >= 0) start = value.indexOf(text)
          else if (!(start >= 0 && value.slice(start, start + text.length) === text)) {
            stopLive()
            return false
          }
          if (start >= 0) {
            askBox.value = value.slice(0, start) + value.slice(start + text.length)
            var caret = Math.min(start, askBox.value.length)
            try {
              askBox.setSelectionRange(caret, caret)
            } catch (error) {
              /* noop */
            }
            refreshAskState()
          }
        }
        stopLive()
        // 撤掉之后这一段就不存在了：状态一起清空（否则停止时还会去和一个已经没有的段落对齐）
        live.text = ''
        live.start = -1
        live.committed = ''
        live.preview = ''
        return true
      }

      function stopLive() {
        var live = voice.live
        live.active = false
        live.inflight = false
        if (live.timer) clearInterval(live.timer)
        live.timer = 0
        if (live.controller) {
          try {
            live.controller.abort()
          } catch (error) {
            /* noop */
          }
        }
        live.controller = null
      }

      /** 开实时层（拿不到采样水龙头就不开：功能退回"说完点 ■ 再出字"）。 */
      function startLive(capture) {
        var live = voice.live
        stopLive()
        live.committed = ''
        live.preview = ''
        live.text = ''
        live.start = -1
        live.inflight = false
        live.passes = { preview: 0, commit: 0 }
        live.rewritten = false
        live.disabled = false
        live.reason = ''
        if (!capture || !capture.tap || !capture.tap.supported()) {
          live.disabled = true
          live.reason = 'no-tap'
          return false
        }
        // 云端识别器：每一拍都是一次**付费**调用（1.3 秒一拍 ≈ 46 次/分钟），不做预览。
        // 本机模型不花钱、只占点 CPU，才是实时字幕该待的地方。
        var provider = voiceProvider(voice.catalog)
        if (provider && provider.location === 'cloud') {
          live.disabled = true
          live.reason = 'cloud'
          return false
        }
        // 我们这段文字从**当前光标处**开始长；前面不是空白就补一个分隔空格
        var value = String(askBox.value || '')
        var caret = caretIndex()
        live.separator = caret > 0 && !/\s$/.test(value.slice(0, caret)) ? ' ' : ''
        live.start = -1
        live.boundary = capture.tap.length()
        live.phraseStart = live.boundary
        live.startedAt = Date.now()
        live.tickAt = 0
        live.active = true
        live.timer = setInterval(liveTick, 200)
        return true
      }

      /**
       * 送一段（16k 采样，[from,to)）去识别。
       * **"没听清"不是故障**：停顿那几秒里窗口是纯静音，识别本来就该返回空
       *（曾经把空结果当失败计数，连挂 3 次就把整个实时层关了 —— 表现是"只跟第一句，后面不吐字"）。
       * @returns 识别到的文字（可能是 ''）
       */
      function liveSend(from, to) {
        var live = voice.live
        var capture = voice.capture
        if (!capture || !capture.tap) return Promise.reject(new Error('没有采样水龙头'))
        var samples = capture.tap.read(from, to)
        if (samples.length < 1600) return Promise.reject(new Error('这段太短了'))
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        live.controller = controller
        return fetch(SPEECH_TRANSCRIBE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audioBase64: bytesToBase64(encodeWave(samples)), partial: true }),
          signal: controller ? controller.signal : undefined,
        })
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            if (data && data.ok === true) return String(data.text || '').trim()
            if (data && data.code === 'empty-transcript') return ''
            throw new Error(String((data && data.error) || '识别失败'))
          })
      }

      /** 一句话说完了（静音够久）：把它送去识别并定稿。 */
      function liveCommit(boundary) {
        var live = voice.live
        var from = live.phraseStart
        var to = Math.min(boundary, from + 16000 * VOICE_COMMIT_MAX_SECONDS)
        if (to - from < 1600) return
        live.inflight = true
        live.passes.commit += 1
        liveSend(from, to)
          .then(function (text) {
            if (!live.active) return
            live.previewFails = 0
            if (text) {
              live.committed = liveJoin(live.committed, text)
              live.preview = ''
              liveWrite()
            }
            live.boundary = to
            live.phraseStart = to
          })
          .catch(function () {
            /* 这一句没转出来：不打断录音，等停止时整段再试一次 */
          })
          .then(function () {
            live.inflight = false
            live.controller = null
          })
      }

      /**
       * 半句预览：把"最后 10 秒还没定稿的那半句"送去识别，整段替换上一拍的预览。
       * @returns 这一拍真的发出去了没有（没发就不该吃掉节流窗口 —— 否则录到 0.2 秒时那次空转
       *          会把第一拍预览推到 1.5 秒之后，用户会觉得"怎么半天不出字"）。
       */
      function livePreview() {
        var live = voice.live
        var capture = voice.capture
        if (!capture || !capture.tap) return false
        // 上次定稿之后还没开口（一直是静音）→ 不浪费调用，也别把上一拍预览抹掉
        var loudIndex = capture.tap.loudIndex()
        if (loudIndex < 0 || loudIndex <= live.phraseStart) return false
        var length = capture.tap.length()
        var from = Math.max(live.phraseStart, length - 16000 * VOICE_PREVIEW_WINDOW)
        if (length - from < 16000 * 0.5) return false
        live.inflight = true
        live.passes.preview += 1
        liveSend(from, length)
          .then(function (text) {
            if (!live.active) return
            live.previewFails = 0
            if (text === live.preview) return
            // 这一拍没识别到内容（窗口里正好都是静音）：留着上一拍的预览，别闪没
            if (!text) return
            live.preview = text
            liveWrite()
          })
          .catch(function (error) {
            if (!live.active) return
            // 预览连续失败就不再打扰用户（停止时那条路仍然会出字）；
            // 阈值给宽一点：偶发一次超时不该把实时字幕整个关掉
            if (error && error.name === 'AbortError') return
            live.previewFails = (live.previewFails || 0) + 1
            if (live.previewFails >= 5) {
              live.disabled = true
              live.reason = 'preview-failed'
              stopLive()
            }
          })
          .then(function () {
            live.inflight = false
            live.controller = null
          })
        return true
      }

      /** 实时层的节拍：先看有没有"一句话说完了"，再看要不要刷半句预览。 */
      function liveTick() {
        var live = voice.live
        if (!live.active || live.disabled || voice.phase !== 'recording') return
        var capture = voice.capture
        if (!capture || !capture.tap || !capture.tap.supported()) return
        if (live.inflight) return
        var now = Date.now()
        var length = capture.tap.length()
        var loudIndex = capture.tap.loudIndex()
        var loudAt = capture.tap.loudAt()
        // ① 停顿定稿：最近一次有声已经过去 600ms 以上，且这句够长
        if (loudIndex >= 0 && now - loudAt >= VOICE_PAUSE_MS && now - loudAt < 5000) {
          var boundary = Math.min(length, loudIndex + Math.round(16000 * 0.25))
          if (boundary - live.phraseStart >= (16000 * VOICE_PAUSE_MIN_MS) / 1000) {
            live.pendingReady = true
            liveCommit(boundary)
            return
          }
        }
        // ② 半句预览：每 1.3 秒刷一次（只有真发出去才算用掉这一拍）
        if (now - live.tickAt < VOICE_PREVIEW_EVERY) return
        if (livePreview()) live.tickAt = now
      }

      /**
       * ■ 停止后的收口：整段识别已经拿到 fullText，把它和已经插进去的那段对齐。
       * 正常情况（整段以定稿开头）只补后半句；对不上就整块替换（以整段为准）。
       */
      function liveFinalize(fullText) {
        var live = voice.live
        var committed = live.committed
        var text = String(fullText || '').trim()
        stopLive()
        if (!text) {
          // 整段一个都没识别出来：已经定稿的部分留着（用户看得见），预览丢掉
          live.preview = ''
          liveWrite()
          return live.committed
        }
        var merged = text
        if (committed) {
          var rest = liveTailAfterCommitted(committed, text)
          if (rest === null) {
            live.rewritten = true
            merged = text
          } else {
            merged = liveJoin(committed, rest)
          }
        }
        live.committed = merged
        live.preview = ''
        liveWrite()
        return merged
      }

      /**
       * 整段识别里"已定稿那部分"之后还剩什么。
       * 归一化（去空白与标点）之后比前缀：对得上 → 返回剩余原文；对不上 → null。
       */
      function liveTailAfterCommitted(committed, full) {
        var norm = function (text) {
          var out = []
          for (var i = 0; i < text.length; i += 1) {
            var ch = text[i]
            if (/[\s，。；：！？、,.!?;:'"（）()\[\]【】…—-]/.test(ch)) continue
            out.push({ ch: ch, at: i })
          }
          return out
        }
        var want = norm(committed)
        var got = norm(full)
        if (!want.length || got.length < want.length) return null
        for (var i = 0; i < want.length; i += 1) {
          if (want[i].ch !== got[i].ch) return null
        }
        return full.slice(got[want.length - 1].at + 1).trim()
      }

      /** 开始一段录音（先问 host 要目录：能不能录、最长多久）。 */
      function startVoice() {
        if (!recordingSupported()) {
          voiceFeedback(VOICE_ERRORS.unavailable, 'error', null)
          return
        }
        var generation = ++voice.generation
        voice.phase = 'requesting'
        setVoiceActivity('请允许使用麦克风…', { dot: true })
        setVoiceAction(null)
        paintVoice()
        fetchSpeechCatalog(true)
          .then(function (catalog) {
            if (generation !== voice.generation) return null
            if (!catalog || catalog.available !== true) {
              var provider = voiceProvider(catalog)
              var reason = catalog ? catalog.reason : ''
              var text =
                reason === 'unprepared' || (provider && provider.phase !== 'ready' && provider.phase !== 'standby')
                  ? '语音模型还没准备好' + (provider && provider.name ? '（' + provider.name + '）' : '')
                  : catalog && catalog.error
                    ? catalog.error
                    : '这个部署没有可用的语音识别服务'
              // 有救的（模型没装）给一个「准备模型」按钮：下载在 host 上跑，几百 MB 到 1G，得用户自己点
              voiceFeedback(text, 'warn', provider ? 'prepare' : 'retry')
              return null
            }
            var limits = catalog.limits || {}
            voice.maxSeconds = clamp(Number(limits.maxSeconds) || VOICE_FALLBACK_SECONDS, 5, 600)
            var capture = createCapture(function (error) {
              failVoice(generation, error)
            })
            voice.capture = capture
            return capture.start().then(function () {
              if (generation !== voice.generation) {
                capture.dispose()
                return null
              }
              voice.phase = 'recording'
              voice.startedAt = Date.now()
              resetWave()
              setVoiceActivity('', {})
              paintVoice()
              startVoiceTicker()
              // 实时字幕：说话时字就往输入框里长（拿不到采样水龙头就自动退回"停止后出字"）
              startLive(capture)
              return true
            })
          })
          .catch(function (error) {
            failVoice(generation, error)
          })
      }

      /** 结束录音 → 送去识别 → 文字插进输入框。 */
      function finishVoice() {
        if (voice.phase !== 'recording') return
        var generation = voice.generation
        var capture = voice.capture
        var maxSeconds = voice.maxSeconds || VOICE_FALLBACK_SECONDS
        stopVoiceTicker()
        voice.phase = 'transcribing'
        setVoiceActivity('识别中…', { dot: true })
        setVoiceAction(null)
        paintVoice()
        var abort = typeof AbortController === 'function' ? new AbortController() : null
        voice.abort = abort
        capture
          .stop(maxSeconds)
          .then(function (bytes) {
            if (generation !== voice.generation) return null
            if (!bytes || !bytes.length) throw voiceError('empty')
            if (bytes.length > VOICE_MAX_BYTES) throw new Error('录音超过服务限制，请缩短录音后重试。')
            return fetch(SPEECH_TRANSCRIBE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ audioBase64: bytesToBase64(bytes) }),
              signal: abort ? abort.signal : undefined,
            })
          })
          .then(function (response) {
            if (generation !== voice.generation || !response) return null
            return response.json().then(function (data) {
              if (generation !== voice.generation) return null
              if (!data || data.ok !== true) {
                var error = String((data && data.error) || '识别失败')
                if (data && data.code === 'unprepared') {
                  voiceFeedback(error, 'warn', 'prepare')
                } else if (data && data.code === 'empty-transcript') {
                  voiceFeedback(VOICE_ERRORS.empty, 'warn', 'retry')
                } else {
                  voiceFeedback('语音识别失败：' + error, 'error', 'retry')
                }
                return null
              }
              var text = String(data.text || '').trim()
              var liveHasText = voice.live.active && !!(voice.live.committed || voice.live.preview || voice.live.text)
              if (!text) {
                if (liveHasText) {
                  // 整段没转出来，但实时那几段已经落进输入框了：留着他看得见的那份
                  voice.lastText = liveFinalize('')
                  voice.capture = null
                  voice.abort = null
                  resetVoiceRow()
                  return null
                }
                voiceFeedback(VOICE_ERRORS.empty, 'warn', 'retry')
                return null
              }
              if (liveHasText) {
                // 实时字幕已经在输入框里写了字：用它给整段收口（定稿部分尽量不动）
                voice.lastText = liveFinalize(text)
              } else {
                insertTranscript(text)
              }
              // 插入成功 = **直接回 idle**：文字就摆在上面那行，不必再报一次
              //（主会话也是这样：成功不额外说话，录音行收起、🎤 回位）。
              voice.capture = null
              voice.abort = null
              resetVoiceRow()
              return text
            })
          })
          .catch(function (error) {
            if (generation !== voice.generation) return
            // 用户点了 ✕ / 收起小窗：静默（这不是失败，是他自己不要了）
            if (error && error.name === 'AbortError') return
            var kind = error && error.voiceKind
            if (kind === 'cancelled') return
            if (kind === 'empty') {
              voiceFeedback(VOICE_ERRORS.empty, 'warn', 'retry')
              return
            }
            voiceFeedback('语音识别失败：' + voiceMessageOf(error), 'error', 'retry')
          })
          .then(function () {
            if (generation !== voice.generation) return
            voice.capture = null
            voice.abort = null
          })
      }

      /**
       * 取消当前这一轮（录音或识别）→ 回到 idle。✕ / Esc / 关面板 / 停用插件都走它。
       * 一定会松开麦克风、并且让晚到的回调全部作废（generation + 1）。
       */
      function cancelVoice(options) {
        if (!voice) return
        var opts = typeof options === 'string' ? { note: options } : options || {}
        var capture = voice.capture
        voice.generation += 1
        voice.capture = null
        if (voice.abort) {
          try {
            voice.abort.abort()
          } catch (error) {
            /* noop */
          }
        }
        voice.abort = null
        if (voice.pollTimer) clearTimeout(voice.pollTimer)
        voice.pollTimer = 0
        // 实时字幕：✕ 取消 = 把这次插进输入框的文字整块撤掉（"丢弃识别文字"）；
        // 其它中断（失焦 / 收起小窗 / 这条消息发出去）**留着屏幕上的字**，只是不再更新。
        if (opts.discard) liveDiscard()
        else stopLive()
        if (capture) capture.dispose()
        resetVoiceRow()
        // 少数情况下要交代一句（例如"这条消息先发出去了"）：留在 feedback 里，2 秒后自己回 idle
        if (opts.note) {
          voiceFeedback(opts.note, '', null)
          voice.idleTimer = setTimeout(function () {
            if (voice.phase !== 'feedback') return
            resetVoiceRow()
          }, 2200)
        }
      }

      /** 让 host 去准备识别模型（首次要下载）；下载在 host 上跑，关掉面板也继续。 */
      function prepareVoice() {
        voice.phase = 'transcribing' // 复用"进行中"的形态：✕ + 呼吸点 + 文案
        setVoiceActivity('正在准备语音模型…', { dot: true })
        setVoiceAction(null)
        paintVoice()
        fetch(SPEECH_PREPARE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            if (!data || data.ok !== true) {
              voiceFeedback('准备失败：' + ((data && data.error) || '未知原因'), 'error', 'prepare')
              return
            }
            voice.catalog = data.catalog || null
            voice.catalogAt = 0 // 状态变了，下一次点击重新问 host
            pollPrepare(0)
          })
          .catch(function (error) {
            voiceFeedback('准备失败：' + voiceMessageOf(error), 'error', 'prepare')
          })
      }

      /** 轮询准备进度（下载在 host 上，这里只是播报）。 */
      function pollPrepare(round) {
        if (round > 480) return // 最多看 ~12 分钟，之后交给用户自己再来
        if (voice.pollTimer) clearTimeout(voice.pollTimer)
        voice.pollTimer = setTimeout(function () {
          fetchSpeechCatalog(true)
            .then(function (catalog) {
              if (catalog && catalog.available) {
                voiceFeedback('语音模型已就绪，可以开始说话', '', 'retry')
                return
              }
              var provider = voiceProvider(catalog)
              if (provider && provider.phase === 'failed') {
                voiceFeedback('准备失败：' + (provider.message || '模型下载出错'), 'error', 'prepare')
                return
              }
              var total = provider && provider.totalBytes ? provider.totalBytes : 0
              var done = provider && provider.completedBytes ? provider.completedBytes : 0
              var progress = total > 0 ? '（' + Math.round((done / total) * 100) + '%）' : ''
              setVoiceActivity('正在准备语音模型' + progress + '…（可以先去忙别的，下载在后台继续）', { dot: true })
              voice.phase = 'transcribing'
              paintVoice()
              pollPrepare(round + 1)
            })
            .catch(function () {
              pollPrepare(round + 1)
            })
        }, 1500)
      }

      var offMic = listen(micButton, 'click', function (event) {
        event.stopPropagation()
        startVoice()
      })
      // 切走这个窗口（换到别的 App）就停止录音 —— 主会话也是这么做的：
      // 人已经不在说话了，继续占着麦克风只会录一串环境噪音。识别**不打断**（那时音频已经拿到了）。
      var offVoiceBlur = listen(window, 'blur', function () {
        if (voice.phase === 'recording') cancelVoice()
      })
      var offVoiceCancel = listen(voiceCancel, 'click', function (event) {
        event.stopPropagation()
        // feedback 阶段点 ✕ 只是"关掉这条提示"，其余阶段是取消录音/识别。
        // 录音中按 ✕ = 丢弃这次已经插进输入框的文字（主会话那个 ✕ 也是这个语义）。
        cancelVoice({ discard: true })
      })
      var offVoiceStop = listen(voiceStop, 'click', function (event) {
        event.stopPropagation()
        finishVoice()
      })
      paintVoice()
      // ═════════════════════════ 语音输入（结束） ═════════════════════════

      // 用户自己滚消息区（滚轮/触摸）→ 不再强行把他拉回底部
      var offBodyWheel = listen(body, 'wheel', noteUserScroll)
      var offBodyTouch = listen(body, 'touchmove', noteUserScroll)
      var offBodyScroll = listen(body, 'scroll', noteBodyScroll)

      var offClose = listen(closeButton, 'click', function (event) {
        event.stopPropagation()
        closePanel()
      })

      var offDrag = listen(head, 'mousedown', function (event) {
        if (promoteButton.contains(event.target) || closeButton.contains(event.target)) return
        event.preventDefault()
        var rect = panel.getBoundingClientRect()
        var offsetX = event.clientX - rect.left
        var offsetY = event.clientY - rect.top
        var move = function (moveEvent) {
          panel.style.left = clamp(moveEvent.clientX - offsetX, 4, window.innerWidth - rect.width - 4) + 'px'
          panel.style.top = clamp(moveEvent.clientY - offsetY, 4, window.innerHeight - 40) + 'px'
          if (historyList.style.display === 'flex') placeHistoryList()
        }
        var up = function () {
          window.removeEventListener('mousemove', move, true)
          window.removeEventListener('mouseup', up, true)
        }
        window.addEventListener('mousemove', move, true)
        window.addEventListener('mouseup', up, true)
      })

      // —— 调试钩子（自动化验证用） ——
      window.__dshSelectionExplain = {
        open: function (text, context, label, keyContext) {
          state.selection = { text: text, range: null, rect: null }
          // 和真实划词完全同一条路径（含本地缓存命中）；keyContext 省略时与 context 相同
          openPanelWith(text, context || '', label || '调试', null, keyContext)
          return true
        },
        expand: function () {
          expandDetail()
          return true
        },
        parts: function () {
          return { ...state.parts, stage: state.stage }
        },
        promote: function () {
          promote()
          return true
        },
        ask: function (question) {
          ask(question)
          return true
        },
        turns: function () {
          return state.turns.slice()
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
          return addQuote(text, label || '调试', extra || {})
        },
        /** 自检用：某一段引用要用的上下文（等价于点引用那一刻采到的那份）。 */
        quoteContext: function (source, turnIndex, text) {
          return panelQuoteContext(source === 'panel' ? turnIndex : -1, text || '')
        },
        /** 自检用：引用 + 提问拼出来的那条消息原文（发给模型的就是它）。 */
        compose: function (quotes, question) {
          return composeQuestion(quotes || state.quotes, question)
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
        close: closePanel,
        /**
         * 自检用：语音输入的状态（阶段 / 提示 / 目录 / 最近一次转写）。
         * phase：idle / requesting / recording / transcribing / done
         */
        voice: function () {
          return {
            phase: voice.phase,
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
            action: voice.action || '',
            maxSeconds: voice.maxSeconds || VOICE_FALLBACK_SECONDS,
            level: Number(voice.level.toFixed(3)),
            lastText: voice.lastText,
            /** 波形 80 根线的高度（自检/冒烟用：静音时全是 2px 的基线）。 */
            bars: waveBars.map(function (bar) {
              return Number(bar.node.getAttribute('y2')) - Number(bar.node.getAttribute('y1'))
            }),
            /** 实时字幕：定稿 / 半句预览 / 拍数 / 有没有被整段识别改写过。 */
            live: {
              active: voice.live.active,
              disabled: voice.live.disabled,
              reason: voice.live.reason,
              committed: voice.live.committed,
              preview: voice.live.preview,
              text: voice.live.text,
              passes: { preview: voice.live.passes.preview, commit: voice.live.passes.commit },
              rewritten: voice.live.rewritten,
              boundary: voice.live.boundary,
              phraseStart: voice.live.phraseStart,
              tap: voice.capture && voice.capture.tap && voice.capture.tap.supported()
                ? {
                    length: voice.capture.tap.length(),
                    loudIndex: voice.capture.tap.loudIndex(),
                    loudAt: voice.capture.tap.loudAt(),
                  }
                : null,
            },
            catalog: voice.catalog
              ? {
                  available: voice.catalog.available === true,
                  reason: voice.catalog.reason || '',
                  error: voice.catalog.error || '',
                  providers: (voice.catalog.providers || []).map(function (provider) {
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
          voice.live.tickAt = 0
          liveTick()
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
            refreshAskState()
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
            sections: splitSections(sanitizeToolResidue(state.raw)),
            toolResidue: state.toolResidue,
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
        /** 自检用：残渣清理（供单测直接打表）。 */
        stripResidue: function (text) {
          return sanitizeToolResidue(text)
        },
        /** 自检用：模型/档位当前值 + 已加载的目录规模。 */
        modelState: function () {
          return {
            choice: state.modelChoice,
            effort: state.effort,
            pill: modelPillName.textContent + modelPillTier.textContent,
            menuOpen: modelMenu.getAttribute('data-open') === '1',
            catalog: { count: (modelCatalog.items || []).length, current: modelCatalog.current, stages: modelCatalog.stages, error: modelCatalog.error },
          }
        },
        /** 自检用：模型控件节点（无头环境里页面可能挂了两棵树，用这个拿到真正带监听的那个）。 */
        modelNodes: function () {
          return { pill: modelPill, menu: modelMenu }
        },
        /** 自检用：菜单开合与点击计数。 */
        modelMenuDebug: function () {
          return { clicks: modelPillClicks, open: modelMenu.getAttribute('data-open'), expanded: modelPill.getAttribute('aria-expanded') }
        },
        openModel: function () {
          openModelMenu()
          return modelMenu.getAttribute('data-open')
        },
        /** 自检用：拉一次模型目录（菜单会自己拉，这里给测试用）。 */
        loadModels: function (force) {
          return loadModelCatalog(force === true).then(function (catalog) {
            renderModelMenu()
            paintModelPill()
            return { count: (catalog.items || []).length, current: catalog.current, stages: catalog.stages, error: catalog.error }
          })
        },
        /** 自检用：折叠统计与"即将发出去的历史"。 */
        foldStats: function () {
          return {
            folds: foldCount,
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
          return foldForHistory(text)
        },
        /** 自检用：读/写网页模式开关。 */
        webMode: function () {
          return !!state.webAnswer
        },
        setWebMode: function (on) {
          return setPref(on === true)
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
          return placePill()
        },
        /** 自检用：当前的自适应间隔（毫秒）。 */
        pollDelay: function () {
          return pillPollDelay
        },
        /** 自检用：走一次调度器的单步（贴一次 + 按结果调整节奏），返回新的间隔。 */
        pollStep: function () {
          return pillPollStep()
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
          bridged.forEach(function (url, frame) {
            frames.push({
              connected: frame.isConnected === true,
              own: !!url,
              srcdoc: frame.getAttribute('srcdoc') !== null,
              sandbox: frame.getAttribute('sandbox'),
            })
          })
          return {
            on: bridgeOn,
            frames: frames,
            active: !!state.bridgeActive,
            selection: state.selection && state.selection.source === 'iframe' ? state.selection.text : '',
          }
        },
        /** 自检用：扫一遍预览帧（等价于 DOM 变动后的那次自动扫描）。 */
        bridgeScan: function () {
          scanPreviewFrames()
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
          closePanel()
          state.payload = null
          state.selection = null
          state.bridgeActive = false
          state.parts = { translation: '', detail: '' }
          state.turns = []
          clearQuotes()
          state.raw = ''
          state.phase = 'idle'
          state.error = ''
          state.chars = 0
          state.aborted = false
          state.asking = false
          state.cacheKey = ''
          quote.textContent = ''
          paint()
          renderTurns()
          return true
        },
        ping: function () {
          // 带上会话 id：工具是按会话作用域注册的，不带就看不到 web_search
          var id = currentSessionId()
          var url = PING + (id ? '?sessionId=' + encodeURIComponent(id) : '')
          return fetch(url).then(function (response) {
            return response.json()
          })
        },
      }

      // —— 可逆清理 ——
      ctx.effect(function () {
        if (typeof console !== 'undefined' && console.log) {
          console.log('[dsh-selection-explain] 划词解读已就绪（选中文字试试）')
        }
        return function () {
           offPopEnd()
          offQuotePopEnd()
          offMouseUp()
          offKeyUp()
          offMouseDown()
          offButtonDown()
          offButtonClick()
          offQuoteDown()
          offQuoteClick()
          offScroll()
          offResize()
          offKeyDown()
          offPromote()
          offRetry()
          offExpand()
          offAskKey()
          offAskInput()
          offAskSend()
          // 语音输入：摘掉麦克风监听，并把正在录/正在识别的这一轮彻底作废（松开麦克风）
          offMic()
          offVoiceCancel()
          offVoiceStop()
          offVoiceBlur()
          cancelVoice()
          offClose()
          offDrag()
          offPillDown()
          offPillClick()
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
          if (chatGrowWatch) chatGrowWatch.disconnect()
          if (pillPlacerId) clearTimeout(pillPlacerId)
          if (pillObserver) {
            try {
              pillObserver.disconnect()
            } catch (error) {
              /* noop */
            }
            pillObserver = null
          }
          if (typeof offSlot === 'function') offSlot()
          // 划词桥：摘观察者与消息监听，并把我们自己建的预览 blob 全部回收
          if (bridgeScanId) clearTimeout(bridgeScanId)
          bridgeScanId = 0
          if (bridgeObserver) {
            try {
              bridgeObserver.disconnect()
            } catch (error) {
              /* noop */
            }
            bridgeObserver = null
          }
          bridged.forEach(function (url) {
            if (!url) return
            try {
              URL.revokeObjectURL(url)
            } catch (error) {
              /* noop */
            }
          })
          bridged.clear()
          state.turns = []
          state.quotes = []
          if (state.request) state.request.abort()
          for (var i = 0; i < timers.length; i++) clearTimeout(timers[i])
          cache.clear()
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

    /** 头部小节容器（卡片式；序号 + 标题 + 右侧提示位）。 */
    function buildSection(index, title, key) {
      var root = el('div', 'dsh-sel-sec')
      root.setAttribute('data-sec', key)
      var header = el('div', 'dsh-sel-sh')
      header.appendChild(el('i'))
      var titleNode = el('span', null, title)
      header.appendChild(titleNode)
      var hint = el('span', 'dsh-sel-hint', '')
      header.appendChild(hint)
      var content = el('div', 'dsh-sel-c')
      root.appendChild(header)
      root.appendChild(content)
      return { root: root, content: content, hint: hint, title: titleNode }
    }

    /** 面板头部的小图标按钮。 */
    function iconButton(title, glyph) {
      var node = el('button', 'dsh-sel-icon', glyph)
      node.type = 'button'
      node.title = title
      return node
    }

    /** 浮标上的星形图标。 */
    /** 页面图标（网页模式）。 */
    function pageIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.4')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('aria-hidden', 'true')
      var outer = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      outer.setAttribute('x', '2.4')
      outer.setAttribute('y', '2.4')
      outer.setAttribute('width', '11.2')
      outer.setAttribute('height', '11.2')
      outer.setAttribute('rx', '2.2')
      svg.appendChild(outer)
      var lines = [
        ['M5', '6.2', 'H11'],
        ['M5', '8.6', 'H11'],
        ['M5', '11', 'H8.6'],
      ]
      for (var i = 0; i < lines.length; i += 1) {
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', lines[i].join(' '))
        svg.appendChild(path)
      }
      return svg
    }

    /** Markdown 图标（M↓）。滑块里只有 11px，所以描边加粗到 2.6 才认得出。 */
    function markdownIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('width', '13')
      svg.setAttribute('height', '13')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '2.6')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      var peak = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      peak.setAttribute('d', 'M3.5 17.5V7.5l4.4 5 4.4-5v10')
      svg.appendChild(peak)
      var arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      arrow.setAttribute('d', 'M17.4 7v9.6M14.3 13.6l3.1 3.1 3.1-3.1')
      svg.appendChild(arrow)
      return svg
    }

    /** 网页窗口图标（滑块右档）。 */
    function windowIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('width', '13')
      svg.setAttribute('height', '13')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '2.6')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      var frame = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      frame.setAttribute('x', '3')
      frame.setAttribute('y', '4.5')
      frame.setAttribute('width', '18')
      frame.setAttribute('height', '15')
      frame.setAttribute('rx', '3')
      svg.appendChild(frame)
      var bar = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      bar.setAttribute('d', 'M3 9.6h18')
      svg.appendChild(bar)
      return svg
    }

    /** 地球图标（留作复用；当前控件已改为窗口图标）。 */
    function globeIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '14')
      svg.setAttribute('height', '14')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.3')
      svg.setAttribute('aria-hidden', 'true')
      var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      circle.setAttribute('cx', '8')
      circle.setAttribute('cy', '8')
      circle.setAttribute('r', '5.6')
      svg.appendChild(circle)
      // 经线 + 纬线：一眼看出是"地球/网页"
      var meridian = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      meridian.setAttribute('d', 'M8 2.4c1.9 1.7 2.9 3.6 2.9 5.6S9.9 11.9 8 13.6C6.1 11.9 5.1 10 5.1 8S6.1 4.1 8 2.4z')
      svg.appendChild(meridian)
      var equator = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      equator.setAttribute('d', 'M2.5 8h11')
      svg.appendChild(equator)
      return svg
    }

    /** 停止图标（圆角方块）：生成中发送键变成它。 */
    function stopIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '14')
      svg.setAttribute('height', '14')
      svg.setAttribute('fill', 'currentColor')
      svg.setAttribute('aria-hidden', 'true')
      var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', '4.4')
      rect.setAttribute('y', '4.4')
      rect.setAttribute('width', '7.2')
      rect.setAttribute('height', '7.2')
      rect.setAttribute('rx', '1.8')
      svg.appendChild(rect)
      return svg
    }

    /** 取消图标（✕）：两条斜线，和主会话录音行的取消键同形。 */
    function closeIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.8')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('aria-hidden', 'true')
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6')
      svg.appendChild(path)
      return svg
    }

    /**
     * 麦克风图标：话筒头（圆角矩形）+ 底座弧 + 支架。
     * 用描边而不是实心：录音时这个位置要换成"红色实心停止键"，
     * 平时轻一点，红起来的那一刻对比才够强。
     */
    function micIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '14')
      svg.setAttribute('height', '14')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.5')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('aria-hidden', 'true')
      var cap = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      cap.setAttribute('d', 'M8 1.9a2.1 2.1 0 0 1 2.1 2.1v3.4a2.1 2.1 0 0 1-4.2 0V4A2.1 2.1 0 0 1 8 1.9z')
      svg.appendChild(cap)
      var arc = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      arc.setAttribute('d', 'M3.6 7.2v.5a4.4 4.4 0 0 0 8.8 0v-.5')
      svg.appendChild(arc)
      var stem = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      stem.setAttribute('d', 'M8 12.1v2')
      svg.appendChild(stem)
      return svg
    }

    /** 转圈图标（权限请求中 / 识别中）：CSS 让它转起来。 */
    function spinnerIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '14')
      svg.setAttribute('height', '14')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.7')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('aria-hidden', 'true')
      var arc = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      // 缺一个口的圆：转起来才看得出在动
      arc.setAttribute('d', 'M8 1.8a6.2 6.2 0 1 1-4.4 1.8')
      svg.appendChild(arc)
      return svg
    }

    /** 发送图标（上箭头，和主会话 composer 一致）。 */
    function sendIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.7')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      var shaft = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      shaft.setAttribute('d', 'M8 13.2V3.4')
      svg.appendChild(shaft)
      var head = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      head.setAttribute('d', 'M3.9 7.5 8 3.4l4.1 4.1')
      svg.appendChild(head)
      return svg
    }

    function sparkleIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'currentColor')
      svg.setAttribute('aria-hidden', 'true')
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M8 1.2l1.5 4.1 4.1 1.5-4.1 1.5L8 12.4 6.5 8.3 2.4 6.8l4.1-1.5L8 1.2z')
      svg.appendChild(path)
      return svg
    }

    /**
     * 引用浮标上的图标：两个引号块（❝ 的简化画法）。
     * 用圆 + 左下角甩出的小尾巴拼 —— 13px 下也认得出，不依赖系统有没有那个字形。
     */
    function quoteIcon() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'currentColor')
      svg.setAttribute('aria-hidden', 'true')
      var marks = [
        { cx: 5.4, cy: 6.1, tail: 'M3.9 7.4 2.1 12.2 6.1 10.2z' },
        { cx: 11.6, cy: 6.1, tail: 'M10.1 7.4 8.3 12.2 12.3 10.2z' },
      ]
      for (var i = 0; i < marks.length; i += 1) {
        var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        dot.setAttribute('cx', String(marks[i].cx))
        dot.setAttribute('cy', String(marks[i].cy))
        dot.setAttribute('r', '2.3')
        svg.appendChild(dot)
        var tail = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        tail.setAttribute('d', marks[i].tail)
        svg.appendChild(tail)
      }
      return svg
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },})
