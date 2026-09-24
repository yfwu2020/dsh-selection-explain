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
    /** 选区长度上限（与 host 默认值一致，host 还会再校验一次）。 */
    var MAX_SELECTION = 4000
    /** 上下文窗口：选区前后各取多少字符。 */
    var CONTEXT_WINDOW = 1500

    /** key 只取选中文字**之前**这么多字：后缀会随新消息变化，不能进 key。 */
    var KEY_CONTEXT_CHARS = 300
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
      '.dsh-sel-askbox{width:100%;min-height:26px;max-height:96px;overflow-y:auto;resize:none;padding:4px 0 0;',
      'border:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.5;outline:none}',
      // 下面那行：左侧网页模式（圆形浅底，和主会话的 + 同款），右侧发送（圆形实心）
      '.dsh-sel-asktools{display:flex;align-items:center;gap:8px}',
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
      // 页脚整条删掉了：状态改成**浮在输入框上方的短提示**，2.6 秒后自己淡出（不占版面）
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

      var askTools = el('div', 'dsh-sel-asktools')
      askTools.appendChild(webMode)
      askTools.appendChild(el('span', 'dsh-sel-askspace'))
      askTools.appendChild(modelPill)
      askTools.appendChild(askSend)
      askRow.appendChild(askBox)
      askRow.appendChild(askTools)
      askRow.appendChild(modelMenu)
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

      function checkSelection() {
        if (panelOpen) return
        var selection = window.getSelection()
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          hideButton()
          return
        }
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
        state.selection = { text: text.trim(), range: range.cloneRange(), rect: rect }
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
        var wasHidden = button.style.display !== 'inline-flex'
        button.style.display = 'inline-flex'
        var width = button.offsetWidth || 62
        var height = button.offsetHeight || 28
        var left = clamp(rect.right - width, 8, Math.max(8, window.innerWidth - width - 8))
        var top = rect.top - height - 7
        if (top < 8) top = Math.min(rect.bottom + 7, window.innerHeight - height - 8)
        button.style.left = Math.round(left) + 'px'
        button.style.top = Math.round(top) + 'px'
        // 只在"浮现"那一次播动效；已经可见时（划选范围被拖动、键盘调整）只平移，避免一直闪
        if (wasHidden) {
          setButtonPop(false)
          void button.offsetWidth // 强制重排，让动画能重播
          setButtonPop(true)
        }
      }

      function hideButton() {
        button.style.display = 'none'
        setButtonPop(false)
      }

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
        panel.style.display = 'flex'
        panel.style.left = '0px'
        panel.style.top = '0px'
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
        askRow.style.display = wide || translationReady ? '' : 'none'
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
        for (var i = 0; i < state.turns.length; i += 1) {
          var turn = state.turns[i]
          if (turn.hidden === true) continue
          turns.push({ role: turn.role, text: turn.text || '' })
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
          for (var j = 0; j < visible.length; j++) chatLog.appendChild(bubbleFor(visible[j]))
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
          if (turn.role === 'user' || turn.error) {
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
            painted = true
          }
          if (!painted && turn.role !== 'user') paintNotice(node, turn)
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

      function bubbleFor(turn) {
        var bubble = el('div', 'dsh-sel-bubble ' + (turn.role === 'user' ? 'dsh-sel-bubble-user' : 'dsh-sel-bubble-bot'))
        if (turn.role === 'user') {
          bubble.textContent = turn.text
        } else if (turn.error) {
          bubble.className += ' dsh-sel-bubble-err'
          bubble.textContent = turn.text
        } else {
          renderRich(bubble, sanitizeToolResidue(turn.text) || '…', { settled: turn.streaming !== true })
        }
        if (turn.role !== 'user') paintNotice(bubble, turn)
        return bubble
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
      function refreshAskState() {
        var generating = isGenerating()
        var mode = generating ? 'stop' : 'send'
        if (askSend.getAttribute('data-mode') !== mode) {
          askSend.textContent = ''
          askSend.appendChild(generating ? stopIcon() : sendIcon())
          askSend.setAttribute('data-mode', mode)
          askSend.setAttribute('aria-label', generating ? '停止' : '发送')
          askSend.title = generating ? '停止生成（点一下打断这次输出）' : '发送（Enter）'
        }
        askSend.disabled = generating ? false : !String(askBox.value || '').trim()
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

      /** 发送一个追问（多轮，带历史；走 host 的 chat 模式）。 */
      function ask(question) {
        var generating = state.asking || state.phase === 'loading' || state.phase === 'streaming'
        if (generating) {
          // 以前这里是静默 return —— 点了没反应，用户不知道在等什么
          setStatus('还在生成，请稍候…（生成完就能追问）')
          return
        }
        if (!question.trim() || !state.payload) return
        var payload = state.payload
        if (state.turns.length === 0 && (state.raw.trim() || state.parts.translation || state.parts.detail)) {
          state.turns.push({ role: 'assistant', text: seedHistoryFromExplanation(), seed: true, hidden: true })
        }
        state.turns.push({ role: 'user', text: question })
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
            question: question,
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
            turns: state.turns,
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

      var offMouseUp = listen(document, 'mouseup', function (event) {
        if (panel.contains(event.target) || button.contains(event.target)) return
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
        // 状态胶囊：它自己就是开关，点它的 mousedown 不能被当成"点了外面"（否则先关后开，看着像没反应）
        if (pill.contains(target)) return
        // 到这里说明点的不是侧边栏本身：**含面板正文**（消息区/输入框/选中文字）在内，
        // 一律先把侧边栏收回——它是用完就走的导航，不该等你点了"外面"才收。
        hideHistoryList()
        if (panel.contains(target)) return // 面板内的点击只收侧边栏，不关面板
        hideButton()
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

      var offScroll = listen(window, 'scroll', function (event) {
        hideButton()
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
        // 拖窗口变小后，面板本身也要拉回视口内（否则历史列表会跟着算到屏幕外）
        keepInsideViewport()
        if (historyList.style.display === 'flex') placeHistoryList()
        // 窗口尺寸变了：立刻量一次，并把节奏调回最快
        placePill()
        pillPollDelay = PILL_POLL_MIN
      })

      var offKeyDown = listen(document, 'keydown', function (event) {
        // Esc：**任何时候、一次到位**关掉小窗（不受"有没有追问过"限制）。
        // closePanel() 内部会顺带收起模型菜单与「最近」侧边栏，所以不再需要"第一下只收侧边栏"那一级。
        if (event.key === 'Escape' && panelOpen) {
          event.preventDefault()
          event.stopPropagation()
          closePanel()
        }
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
        if (!question.trim()) return
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
        if (!question.trim()) return
        askBox.value = ''
        refreshAskState()
        ask(question)
      })

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
        close: closePanel,
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
        /** 模拟"刷新页面后"：内存里那段小窗没了，只剩 host 上的历史。 */
        reset: function () {
          closePanel()
          state.payload = null
          state.selection = null
          state.parts = { translation: '', detail: '' }
          state.turns = []
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
          offMouseUp()
          offKeyUp()
          offMouseDown()
          offButtonDown()
          offButtonClick()
          offScroll()
          offResize()
          offKeyDown()
          offPromote()
          offRetry()
          offExpand()
          offAskKey()
          offAskInput()
          offAskSend()
          offClose()
          offDrag()
          offPillDown()
          offPillClick()
          offPillKey()
          offPreviewHeight()
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
          state.turns = []
          if (state.request) state.request.abort()
          for (var i = 0; i < timers.length; i++) clearTimeout(timers[i])
          cache.clear()
          if (layer.parentNode) layer.parentNode.removeChild(layer)
          if (button.parentNode) button.parentNode.removeChild(button)
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

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
