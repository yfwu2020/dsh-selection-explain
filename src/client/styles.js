import { FONT, Z_BTN, PILL_BALL_SIZE, PILL_MORPH } from './constants.js'

// ────────────────────────────── 样式 ──────────────────────────────

export var CSS = [
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
  // 图标：13px 画布 + **左移 1px**。
  // 为什么要有这个负外边距：画布是 16×16、图形墨迹只占中间 ~11px，左右各留 ~2px 空白，
  // 而右边「解读 / 引用」两个字的墨迹几乎没有右边距（0.4~1.2px）—— 按盒子居中的话，
  // 视觉上左边比右边宽 ~1.7px，整组看着偏右（实测墨迹中心偏 +0.88px）。
  // 负外边距把"墨迹"而不是"画布"摆正；用 1px 而不是精确的 0.87px：两个浮标的文字
  // 边距不同（「解读」0.4 / 「引用」1.2），取整后两枚浮标的偏差都在 0.5px 内。
  '.dsh-sel-btn svg{width:13px;height:13px;display:block;margin-left:-1px}',
  // 全局一个主色：**青**（两节同色，和「详解」一致）。
  //   --sel-a1/a2      装饰：边条 / 呼吸点 / 淡底（不承载文字，不需要 AA）
  //   --sel-a*-text    文字：术语、标题、符号、链接（实测 AA 达标）
  //   --sel-fill(-fg)  实心块：浮标按钮 / 发送键 / 结论条标签——块上文字另算一套，
  //                    否则青底配白字只有 3.6（不达标），浅色下换成深青 5.4、深色下反白 7.4
  // 变量挂在浮层容器上 → 浮标与面板共用；深浅由**面板实际底色**决定（data-theme）。
  '.dsh-sel-layer{position:fixed;inset:0;z-index:70;pointer-events:none;--sel-a1:#0d9488;--sel-a1-text:#0f766e;--sel-a2:#0d9488;--sel-a2-text:#0f766e;',
  '--sel-fill:#0f766e;--sel-fill-fg:#ffffff;',
  '--sel-a2-soft:color-mix(in srgb,var(--sel-a2) 12%,transparent);--sel-a1-soft:color-mix(in srgb,var(--sel-a1) 10%,transparent)}',
  // DSH 桌面将 body>:not(#root) 设为 no-drag；全屏透明根会因此屏蔽整个窗口拖拽。
  // important 只用于根的拖拽属性，覆盖宿主带 #root 的选择器；空白与装饰保持中性。
  '.dsh-sel-layer{-webkit-app-region:initial!important}',
  '.dsh-sel-layer>:is(.dsh-sel-btn,.dsh-sel-panel,.dsh-sel-pill,.dsh-sel-history,.dsh-sel-vcard){-webkit-app-region:no-drag}',
  '.dsh-sel-layer[data-full-view] .dsh-sel-pill{display:none!important}',
  '.dsh-sel-layer[data-theme=dark]{--sel-a1:#4ecdc4;--sel-a1-text:#6fe3d8;--sel-a2:#4ecdc4;--sel-a2-text:#6fe3d8;',
  '--sel-fill:#4ecdc4;--sel-fill-fg:#052b26;',
  '--sel-a2-soft:color-mix(in srgb,var(--sel-a2) 16%,transparent);--sel-a1-soft:color-mix(in srgb,var(--sel-a1) 16%,transparent)}',
  // ⚠️ 声明块必须在**同一段字符串里收尾**。
  // 以前这里是 `...max-height:...;` 后面直接接了一条完整规则 `[data-stage=translation]{...}`，
  // `.dsh-sel-panel{` 的 `}` 于是永远没出现 —— 那条阶段规则被当成块内的**非法声明**整条丢弃，
  // "首轮收窄到 440" 从来没生效过（实测计算宽度一直是 540）。后面几段的 border-radius /
  // overflow 之所以没事，是因为 CSS 出错恢复会跳过坏声明继续往下读。
  // 单测只断言了 data-stage 这个**属性**，而桩 DOM 没有布局，所以一直没暴露。
  // box-sizing:border-box 是**必须**的：拖角改大小时我们把 getBoundingClientRect()（含边框）
  // 的宽高写回 style.width/height，而它们默认按 content-box 解释 —— 差一个边框宽（1px），
  // 于是"存进去 → 读回来"每来一轮就胖 1px，拖几次就明显走形（实测 584 存进去、读回来 586）。
  '.dsh-sel-panel{position:fixed;display:none;flex-direction:column;box-sizing:border-box;width:min(540px,calc(100vw - 20px));max-height:min(78vh,720px);',
  'border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);',
  'border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));box-shadow:0 20px 52px rgba(0,0,0,.3);',
  'font:400 13.5px/1.7 ' + FONT + '}',
  // 这里曾经有一条 `.dsh-sel-panel[data-stage=translation]{width:440px}`：
  // "首轮只出翻译时收窄一点"。它因为上面那个漏掉的 `}` 一直是死代码，修好闭合之后才真正生效，
  // 一生效就暴露了问题 —— 宽度会**在追问那一刻从 440 跳到 540**（见 syncPanelStage 的判定），
  // 用户看到同一个窗口自己变宽，问"怎么有追问和没追问的宽度不一样"。
  // 决定：**统一成 540，宽度不随阶段变**。少一档就没这档子事，也没有"什么时候会跳"的心智负担。
  // （data-stage 本身保留 —— 它还决定追问输入框显不显示，见 renderPanel。）
  // 设置抽屉开着时只补**高度**下限，**不动宽度**。
  //
  // 抽屉是 inset:0 贴在面板上的：面板多宽，抽屉就多宽 —— 这是要的（设置窗口与小窗等宽，
  // 开抽屉时小窗不该"胖一圈"）。但高度不能不管：面板高度是由"解读内容有多长"撑出来的，
  // 刚开窗（只出了翻译）时面板才 ~115px 高，设置列表只剩 17px 可视高度（实测）。
  // 所以只给 min-height；宽度交给面板自己的规则（首轮 440 / 其余 540），抽屉自动跟随。
  // min-height 用 min() 与 max-height 同源，视口矮时两者相等，不会顶出屏幕。
  // 只在**用户没自己改过尺寸**时才补这个下限：他拉过大小就按他的来（min-height 会压过 inline height）
  '.dsh-sel-panel[data-settings="1"]:not([data-resized="1"]){min-height:min(560px,78vh)}',
  // 改大小手柄：右下角一个角标 + 右边/下边各一条（细，不抢视线；hover/拖动时才明显）
  // z-index 比设置抽屉(6)高 —— 但抽屉开着时整体隐藏（见下面的规则）：
  // 抽屉页脚右侧就是「关闭」按钮，角标压上去会误点。
  '.dsh-sel-grip{position:absolute;z-index:7;background:transparent;touch-action:none}',
  '.dsh-sel-grip-corner{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}',
  '.dsh-sel-grip-r{right:0;top:12px;bottom:16px;width:6px;cursor:ew-resize}',
  '.dsh-sel-grip-b{left:12px;right:16px;bottom:0;height:6px;cursor:ns-resize}',
  // 手柄**不画任何常驻标识**：以前角上有一道小斜纹（两条 1.5px 边框拼的直角），
  // 在浅色面板上看着像多出来的一笔，用户明确要求去掉。
  // 保留 hover 时边缘的高亮（只在鼠标移上去时出现，不占视觉）——
  // 加上 cursor: nwse-resize / ew-resize / ns-resize，可发现性还在。
  // 抽屉开着时收起手柄（页脚右侧是「关闭」按钮，别让角标压上去）
  '.dsh-sel-panel[data-settings="1"] .dsh-sel-grip{display:none}',
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
  // 统一图标（头部 / 工具行）：尺寸由 SVG 的 width/height 属性给，这里只钉住显示方式
  '.dsh-sel-ic{display:block;flex:none}',
  // 带文字的图标键里的图标：和文字之间留一点呼吸，别贴在一起
  '.dsh-sel-action .dsh-sel-ic{margin-right:1px}',
  '.dsh-sel-icon .dsh-sel-ic{margin:0}',
  // 选中文字quote：左侧强调条 + 略暗底
  // 选中文字条：在滚动区里（跟着消息一起滚），左右边距交给 body 的 padding 所以与内容对齐。
  // 可以自动换行、超过 84px 内部滚动，但**不显示滚动条**。
  // ⚠️ flex:0 0 auto 不能省：滚动区是 flex 列，而 overflow 非 visible 的 flex 项目
  //    自动最小高度是 0 → 内容一多就被压扁，文字直接看不全（实测踩过）。
  // 顶部那行是"生成的标题"时：两行封顶，超出用省略号（而不是出现滚动条）
  '.dsh-sel-quote[data-title="1"]{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;',
  'overflow:hidden;white-space:normal;max-height:none}',
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
  // ── 附件（composer 第一行，和引用同栏）──
  // 引用是竖着排的卡片（有出处 + 一段文字），附件是横着一排的缩略图 —— 两种形状，
  // 所以是**两条独立的条**、共用 ask 的第一行区域，而不是把附件塞进引用卡片里。
  // 横向溢出就滚动（附件最多 10 件，小窗宽度装不下是常态），滚动条藏起来不占高度。
  '.dsh-sel-attach{display:none;flex-direction:row;align-items:center;gap:6px;overflow-x:auto;overflow-y:hidden;',
  'scrollbar-width:none;padding:1px 0 0}',
  '.dsh-sel-attach[data-show="1"]{display:flex}',
  '.dsh-sel-attach::-webkit-scrollbar{width:0;height:0;display:none}',
  // 40px 见方：比主会话的 64px 小一圈（小窗的 composer 整体是收着的：按钮 26、输入 13px）
  '.dsh-sel-thumb{position:relative;flex:0 0 auto;width:40px;height:40px;border-radius:9px;overflow:hidden;',
  'border:1px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.14));',
  'display:grid;place-items:center;color:var(--dsw-alias-label-secondary,inherit)}',
  '.dsh-sel-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
  '.dsh-sel-thumb svg{width:15px;height:15px;opacity:.55}',
  '.dsh-sel-thumb[data-state="error"]{border-color:color-mix(in srgb,var(--sel-bad,#e5534b) 70%,transparent)}',
  '.dsh-sel-thumb[data-state="error"] svg{opacity:.9;color:var(--sel-bad,#e5534b)}',
  // 转圈 + 不定态进度条：fetch 拿不到上传进度，所以**不假装知道百分比**
  // （主会话在"首次报告字节之前"用的也是不定态）
  '.dsh-sel-attachspin{position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.42)}',
  '.dsh-sel-attachspin svg{width:16px;height:16px;opacity:1;color:var(--sel-a1,#0d9488);animation:dsh-sel-spin .9s linear infinite}',
  '.dsh-sel-attachbar{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(140,140,140,.35);overflow:hidden}',
  '.dsh-sel-attachbar i{display:block;height:100%;width:38%;background:var(--sel-a1,#0d9488);animation:dsh-sel-indeterminate 1.1s ease-in-out infinite}',
  '@keyframes dsh-sel-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}',
  // 移除：缩略图/文件卡右上角。**常驻可见**（触摸设备上没有 hover，藏起来就删不掉了）
  // 兜底色必须是**中性灰 + 白字**：主题变量缺席时（非 DSH 宿主 / 测试页）
  // 原来的 `bg-layer-2 → #3a3f46` 配 `label-primary → CanvasText`（浅色方案下是黑）
  // 会画成"深底黑叉"，实拍就是一坨看不出是什么的黑点。
  '.dsh-sel-attachx{position:absolute;top:-5px;right:-5px;width:15px;height:15px;padding:0;border-radius:50%;',
  'border:1px solid var(--dsw-alias-bg-layer-1,Canvas);background:var(--dsw-alias-bg-layer-2,rgba(120,120,120,.92));',
  'color:var(--dsw-alias-label-primary,#fff);font:inherit;font-size:9px;line-height:1;cursor:pointer;',
  'display:grid;place-items:center;opacity:.85}',
  '.dsh-sel-attachx:hover{opacity:1}',
  // 文件卡：和缩略图同高（40px），名字一行、扩展名 + 字节数一行小字
  '.dsh-sel-fcard{position:relative;display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;height:40px;',
  'padding:0 7px 0 6px;border-radius:9px;border:1px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));',
  'background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.1));font-size:11.5px;line-height:1.35}',
  '.dsh-sel-fcard[data-state="error"]{border-color:color-mix(in srgb,var(--sel-bad,#e5534b) 70%,transparent)}',
  '.dsh-sel-fico{flex:0 0 auto;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;',
  'background:linear-gradient(160deg,#3f6ee0,#7aa2ff);color:#fff}',
  '.dsh-sel-fico svg{width:13px;height:13px;opacity:1}',
  '.dsh-sel-fname{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-sel-fmeta{font-size:10.5px;opacity:.6;letter-spacing:.3px;white-space:nowrap}',
  '.dsh-sel-fretry{flex:0 0 auto;height:16px;padding:0 6px;border-radius:8px;cursor:pointer;font:inherit;font-size:10.5px;',
  'line-height:14px;color:var(--sel-bad,#e5534b);border:1px solid color-mix(in srgb,var(--sel-bad,#e5534b) 50%,transparent);',
  'background:transparent}',
  '.dsh-sel-fretry:hover{background:color-mix(in srgb,var(--sel-bad,#e5534b) 12%,transparent)}',
  // 附件出错时的说明行（贴在附件条下面，一行小字）
  '.dsh-sel-attachnote{display:none;margin:0;padding:0 2px;font-size:11px;line-height:1.6;color:var(--sel-warn-fg,#b45309)}',
  '.dsh-sel-attachnote[data-show="1"]{display:block}',
  // ＋ 入口：圆形浅底（和主会话 composer 的 ＋ 同款），放在工具行**最左**
  '.dsh-sel-add{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.14));color:var(--dsw-alias-label-primary,CanvasText)}',
  '.dsh-sel-add:hover{background:var(--dsw-alias-interactive-bg-active,rgba(140,140,140,.22))}',
  '.dsh-sel-add[data-busy="1"]{opacity:.6}',
  // 拖放遮罩：铺满面板（面板本身 overflow:hidden，所以内缩 6px 的圆角块正好贴住内容区）
  '.dsh-sel-drop{position:absolute;inset:6px;z-index:9;display:none;flex-direction:column;align-items:center;',
  'justify-content:center;gap:9px;border:2px dashed var(--sel-a1,#0d9488);border-radius:13px;',
  'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,Canvas) 88%,transparent);pointer-events:none}',
  '.dsh-sel-panel[data-dropping="1"] .dsh-sel-drop{display:flex}',
  '.dsh-sel-drop-art{width:52px;height:52px;border-radius:14px;display:grid;place-items:center;',
  'background:var(--sel-a1-soft);color:var(--sel-a1,#0d9488)}',
  '.dsh-sel-drop-art svg{width:25px;height:25px}',
  '.dsh-sel-drop-title{font-size:14px;font-weight:600}',
  '.dsh-sel-drop-hint{font-size:11.5px;opacity:.7}',
  // 气泡里的引用块（用户消息）：引用在上、问题在下 —— 和发出去给模型的那份顺序一致
  '.dsh-sel-bq{display:flex;flex-direction:column;gap:3px;margin-bottom:6px}',
  '.dsh-sel-bqitem{padding:3px 8px;border-radius:8px;border-left:2px solid color-mix(in srgb,var(--sel-a1,#0d9488) 45%,transparent);',
  'background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.14));font-size:11.5px;line-height:1.55;',
  'opacity:.82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-sel-bqitem b{font-weight:600;opacity:.75;margin-right:5px}',
  // 气泡里的附件：图片是缩略图（点开原图），文件是一张卡（点一下下载）。
  // 和输入框上面那条 rail 是**同一个东西的两个阶段**（发送前 / 发送后），
  // 所以尺寸、圆角、配色都对齐：缩略图 40px、文件卡同高。
  '.dsh-sel-bqattach{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:6px}',
  // ⚠️ flex:0 0 auto 会让这个盒子的宽度由**图片自己**撑出来，于是图片上的 max-width:100%
  // 变成"相对于自己"（循环引用）→ 一张 810px 宽的图会照原样渲染并溢出气泡（实测量到 810x180）。
  // 必须允许它收缩（flex:0 1 auto + min-width:0），百分比才有一个确定的参照。
  '.dsh-sel-bqimgwrap{flex:0 1 auto;min-width:0;max-width:100%;display:block;border-radius:9px;overflow:hidden;line-height:0;',
  'border:1px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35))}',
  // 上限 180px 高、最宽占满气泡：小窗本来就窄，缩略图不能把气泡撑爆
  '.dsh-sel-bqimg{display:block;max-width:100%;max-height:180px;width:auto;height:auto;border-radius:8px;cursor:zoom-in}',
  '.dsh-sel-bqimgfail{display:inline-block;padding:5px 9px;border-radius:8px;font-size:11.5px;opacity:.7;',
  'background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.14))}',
  '.dsh-sel-bqfile{display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:5px 9px;border-radius:9px;',
  'text-decoration:none;color:inherit;cursor:pointer;font-size:11.5px;line-height:1.35;',
  'border:1px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));',
  'background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.1))}',
  '.dsh-sel-bqfile:hover{border-color:color-mix(in srgb,var(--sel-a1,#0d9488) 45%,transparent)}',
  '.dsh-sel-bqfileext{flex:0 0 auto;font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:0 5px;',
  'border-radius:5px;line-height:15px;background:var(--sel-fill,#0f766e);color:var(--sel-fill-fg,#fff)}',
  '.dsh-sel-bqfilename{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}',
  '.dsh-sel-bqfilemeta{flex:0 0 auto;font-size:10.5px;opacity:.6}',

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
  // 录音行出现时**不许换行**：发送键必须留在同一行
  //（用户报：一开麦，↑ 就被顶到下面单独一行去了）
  '.dsh-sel-asktools[data-capturing="1"]{flex-wrap:nowrap}',
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
  // 名字占掉剩下的宽度、挤不下就省略号 —— 保证一行里塞得下 勾 + 名字 + 「跟随」小标 + provider
  '.dsh-sel-pickerrow .dsh-sel-pickername{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-sel-pickerrow .dsh-sel-pickerfollow{flex:0 0 auto;font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;font-weight:600;opacity:.85;',
  'background:color-mix(in srgb,var(--sel-a1,#0d9488) 16%,transparent)}',
  '.dsh-sel-pickerrow .dsh-sel-pickerprov{flex:0 0 auto;margin-left:auto;font-size:10.5px;opacity:.55}',
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
  // flex-basis 必须给 **0%**（不是 auto）：行内换行的判定用的是**收缩前**的假设宽度，
  // 而波形那个 svg 的固有宽度约 300px —— 给 auto 时"这一行放不下"会被判成真，发送键于是
  // 掉到下一行。给 0% 之后两者按可用宽度分；min-width:0 + 波形的 min-width:24px 保证
  // 录音行照旧撑满、也不会塌成 0。
  '.dsh-sel-capture{display:none;flex:1 1 0%;min-width:0;align-items:center;gap:8px}',
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
  '.dsh-sel-vwave{flex:1 1 0%;min-width:24px;height:24px;display:block;color:var(--dsw-alias-label-secondary,inherit)}',
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
  '.dsh-sel-historysub{font-size:10.5px;line-height:1.4;opacity:.62;margin-top:1px;}',
  '.dsh-sel-historymeta{display:flex;align-items:center;gap:6px;font-size:11px;opacity:.5;font-variant-numeric:tabular-nums;min-width:0}',
  '.dsh-sel-historymeta>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-sel-historymeta .dsh-sel-historypin{opacity:.9}',
  // 悬浮状态胶囊：样式对齐右下角那枚费用胶囊（dsh-spend），摆在它上方
  // 逐项对齐 dsh-spend 的 .dsu-pill：同样的 padding / 字号 / 行高 / 边框 / 圆角 / 阴影，
  // 连小三角都用同一个字符 ▴ ▾（以前用 ▲ ▼，比它大一圈、也不一样淡）
  // max-width 280 是"跟随费用胶囊"那条路的封顶（和 .dsu-pill 同值，并排时才能同宽）；
  // **没有**费用胶囊可跟随时，placePill() 会用内联样式收到 PILL_FALLBACK_MAX（200）。
  // 过渡（收球 / 拖动吸附 / 跟随位置变化）挂在 [data-ready="1"] 上：插件挂载那一下是先贴好
  // 位置再开过渡的，否则会从 CSS 默认的 bottom:64 一路滑到实测位置。
  //
  // 收球 / 展开**共用这一条**（时长 + 曲线），而且曲线是**时间对称**的：
  //   cubic-bezier(.5,0,.5,1) 的控制点关于中心对称 → p(t) = 1 - p(1-t)，
  //   也就是"把收球的动画倒过来放"恰好等于展开（用户要的对称性）。
  // 之前用 easeOutQuint(.22,1,.36,1)：前后半程不镜像，收快放慢，两个方向看着是两回事。
  // 所有会变的属性都必须挂同一条（时长/曲线一致），否则中间某一帧的宽度由**另一条曲线**决定，
  // 对称性就破了 —— 这也是下面 min-width / padding / gap / 文字 max-width 都要一起过渡的原因。
  '.dsh-sel-pill{position:fixed;right:20px;bottom:64px;z-index:' + String(Z_BTN) + ';display:flex;align-items:center;gap:8px;',
  // height 钉死 32：收球时 padding 要归零，若高度由 padding 撑，展开那一下会先被压扁再长回来
  // （实测的"不流畅"之一）。min-width 给数值 0，好让"球→胶囊"能从 32 平滑过渡回 0。
  'box-sizing:border-box;height:' + String(PILL_BALL_SIZE) + 'px;min-width:0;padding:6px 14px;border-radius:999px;cursor:pointer;user-select:none;max-width:280px;white-space:nowrap;',
  'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#24292f);',
  'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));box-shadow:0 4px 16px rgba(0,0,0,.12);',
  'font-family:inherit;font-size:12px;line-height:18px;font-weight:400}',
  '.dsh-sel-pill[data-ready="1"]{transition:box-shadow .15s ease,width ' + PILL_MORPH + ',',
  'max-width ' + PILL_MORPH + ',min-width ' + PILL_MORPH + ',padding ' + PILL_MORPH + ',gap ' + PILL_MORPH + ',',
  'left ' + PILL_MORPH + ',top ' + PILL_MORPH + ',right ' + PILL_MORPH + ',bottom ' + PILL_MORPH + '}',
  // 鼠标正按着拖：位置每帧都在变，有过渡就"黏手"
  '.dsh-sel-pill[data-drag="1"]{transition:none;cursor:grabbing}',
  // 收成小球：只改**能过渡的属性** —— 宽度由内联 max-width/min-width 收到 32（见 placePill），
  // 这里把 padding/gap 归零。刻意不用 justify-content:center 让圆点居中：那是离散属性、
  // 一翻就跳（圆点会瞬移），改用圆点自己的 margin-left（可过渡）把它挪到圆的中心。
  '.dsh-sel-pill[data-ball="1"]{padding:0;gap:0}',
  // 三段文字（名字 / 状态 / 箭头）收起来：max-width 过渡 + 淡出，而不是 display:none（那个没法过渡）。
  // ⚠️ 基础态必须给一个**数值** max-width（320px，比任何内容都宽 = 等于不限制）：
  //    否则它是从 none 过渡到 0，而 none 不可插值 —— 文字会瞬间塌掉。
  //    实测（真时间轴逐帧采样宽度）：漏了这句时整枚胶囊 60ms 就缩完了，看着像啪一下拍扁，
  //    而不是收进去。
  // overflow:hidden 常驻（不收球时也留着）：它是离散属性，若只在球态给，展开第一帧文字会先溢出来。
  '.dsh-sel-pill .dsh-sel-pillname,.dsh-sel-pill .dsh-sel-pillmeta,.dsh-sel-pill .dsh-sel-pillcaret{max-width:320px;overflow:hidden;transition:opacity ' + PILL_MORPH + ',max-width ' + PILL_MORPH + '}',
  '.dsh-sel-pill[data-ball="1"] .dsh-sel-pillname,.dsh-sel-pill[data-ball="1"] .dsh-sel-pillmeta,.dsh-sel-pill[data-ball="1"] .dsh-sel-pillcaret{max-width:0;opacity:0;pointer-events:none}',
  '.dsh-sel-pill:hover{box-shadow:0 6px 22px rgba(0,0,0,.18)}',
  '.dsh-sel-pill[data-open="1"]{border-color:color-mix(in srgb,var(--sel-a1,#0d9488) 55%,transparent)}',
  // 球心里的图形：一枚 32×32 的 SVG 画布，两侧 -12px 负边距把**布局占位**压成 8px ——
  // 和原来那枚 8px 圆点占位完全相同，所以胶囊的排版与宽度一个像素都不用改；
  // 而画布本身是 32px，于是 viewBox 的 1 单位 = 1px，设计稿上的数字可以照抄。
  '.dsh-sel-pillicon{flex:none;width:32px;height:32px;margin:0 -12px;display:block;overflow:visible;transition:margin ' + PILL_MORPH + '}',
  '.dsh-sel-pillstar{fill:var(--dsw-alias-label-tertiary,#8c959f)}',
  // 图形本身不做 CSS 过渡：两条静态 path 之间 CSS 只能线性插值（中途会出现正菱形），
  // 所以路径由 animatePillStar 按 p 现算（见那里的注释）。
  // path 的坐标中心是 (0,0)。百分比原点在 SVG 中却算成 (16px,16px)，
  // 旋转 -8° 会把圆点墨迹推到画布右上方；必须绕路径真正的中心转。
  '.dsh-sel-pillstar{transform-origin:0 0}',
  // 球态：画布在 32px 的圆里居中 —— 内宽 32-2(边框)=30，两侧各 -1px 负边距正好摆正（中心 16）
  '.dsh-sel-pill[data-ball="1"] .dsh-sel-pillicon{margin:0 -1px}',
  // 状态色照旧，只是从圆点的 background 挪到星的 fill；
  // "进行中"的呼吸动画挂在画布上（transform 绕自身中心缩放，和原来的圆点脉冲同一条 keyframes）
  '.dsh-sel-pill[data-tone=busy] .dsh-sel-pillstar{fill:var(--sel-a1,#0d9488)}',
  '.dsh-sel-pill[data-tone=busy] .dsh-sel-pillicon{animation:dsh-sel-pillpulse 1.5s ease-in-out infinite}',
  '.dsh-sel-pill[data-tone=done] .dsh-sel-pillstar{fill:var(--sel-a1,#0d9488)}',
  '.dsh-sel-pill[data-tone=error] .dsh-sel-pillstar{fill:var(--dsw-alias-state-error-primary,#e5484d)}',
  '.dsh-sel-pill[data-tone=paused] .dsh-sel-pillstar{fill:#d97706}',
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
  // ────────────────────── 设置页（抽屉） ──────────────────────
  // 一个抽屉，不另开窗口：小窗本身就是窄容器，再弹一个浮窗只会互相打架。
  // 从面板右侧滑入、盖住正文，面板尺寸一个像素都不变。
  '.dsh-sel-sheet{position:absolute;top:0;left:0;right:0;bottom:0;z-index:6;display:flex;flex-direction:column;',
  'background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);',
  // ⚠️ 值必须带引号：[data-open=1] 是**非法选择器**（CSS 标识符不能以数字开头），
  //    浏览器会整条丢弃 —— 表现为"属性明明设了、抽屉却纹丝不动"（实测踩过）。
  'transform:translateX(100%);opacity:0;pointer-events:none;box-shadow:-14px 0 30px rgba(0,0,0,.16);',
  'transition:transform .34s cubic-bezier(.22,.8,.3,1),opacity .22s ease}',
  '.dsh-sel-sheet[data-open="1"]{transform:translateX(0);opacity:1;pointer-events:auto}',
  // 抽屉后面压一层薄纱：不遮死正文（用户还得看得出上下文），只把层次分开
  '.dsh-sel-scrim{position:absolute;top:0;left:0;right:0;bottom:0;z-index:5;background:rgba(0,0,0,.06);',
  'opacity:0;pointer-events:none;transition:opacity .28s ease}',
  '.dsh-sel-scrim[data-open="1"]{opacity:1}',
  '.dsh-sel-layer[data-theme=dark] .dsh-sel-scrim{background:rgba(0,0,0,.32)}',
  '@media (prefers-reduced-motion:reduce){.dsh-sel-sheet{transition:opacity .16s ease;transform:none}',
  '.dsh-sel-scrim{transition:none}}',
  '.dsh-sel-sheethead{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 12px;flex:0 0 auto;',
  'border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.22))}',
  '.dsh-sel-sheetback{flex:0 0 auto;width:24px;height:24px;display:grid;place-items:center;border:0;border-radius:8px;',
  'cursor:pointer;background:transparent;color:inherit;opacity:.75;padding:0}',
  '.dsh-sel-sheetback:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.16));opacity:1}',
  '.dsh-sel-sheettitle{font-weight:600;font-size:12.5px;letter-spacing:.2px}',
  '.dsh-sel-sheetscope{margin-left:auto;font-size:11px;opacity:.5;padding-right:4px;white-space:nowrap}',
  // 左栏分类 + 右栏内容
  '.dsh-sel-sheetmain{flex:1 1 auto;display:flex;min-height:0}',
  '.dsh-sel-rail{flex:0 0 96px;border-right:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.22));',
  'padding:8px 6px;display:flex;flex-direction:column;gap:2px;overflow:auto}',
  '.dsh-sel-railbtn{border:0;background:transparent;text-align:left;padding:6px 8px;border-radius:8px;cursor:pointer;',
  'font:inherit;font-size:12px;color:inherit;opacity:.72;white-space:nowrap}',
  '.dsh-sel-railbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.12));opacity:1}',
  '.dsh-sel-railbtn[aria-current="true"]{background:var(--sel-a1-soft,rgba(13,148,136,.12));color:var(--sel-a1-text,#0f766e);',
  'font-weight:600;opacity:1}',
  '.dsh-sel-sheetbody{flex:1 1 auto;overflow:auto;padding:2px 12px 14px;min-width:0;',
  'scrollbar-width:thin;scrollbar-color:rgba(140,140,140,.35) transparent}',
  '.dsh-sel-sheetbody::-webkit-scrollbar{width:9px;height:9px}',
  '.dsh-sel-sheetbody::-webkit-scrollbar-thumb{background:rgba(140,140,140,.3);border-radius:9px;border:2px solid transparent;background-clip:content-box}',
  '.dsh-sel-grp{padding:12px 0 4px;border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.16))}',
  '.dsh-sel-grp:last-child{border-bottom:0;padding-bottom:0}',
  '.dsh-sel-grph{font-size:11px;font-weight:600;opacity:.5;letter-spacing:.4px;margin-bottom:8px}',
  '.dsh-sel-ssection+.dsh-sel-ssection{margin-top:16px;padding-top:16px;border-top:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.16))}',
  '.dsh-sel-ssectionh{font-size:14px;font-weight:600;line-height:1.5;margin:0 0 6px}',
  '.dsh-sel-ssectionhint,.dsh-sel-ssectionnote{font-size:11.5px;opacity:.6;line-height:1.7;margin:3px 0 8px}',
  '.dsh-sel-ssectionnote{margin:8px 0 0}',
  '.dsh-sel-ssection>.dsh-sel-srow+.dsh-sel-srow{border-top:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.16))}',
  '.dsh-sel-srow[data-disabled="1"]{opacity:.5}',
  '.dsh-sel-srow input:disabled,.dsh-sel-srow button:disabled{cursor:default}',
  '.dsh-sel-sheet textarea.dsh-sel-stext{resize:vertical;line-height:1.6}',

  '.dsh-sel-srow{display:flex;align-items:flex-start;gap:14px;padding:8px 0}',
  '.dsh-sel-srowlab{flex:1 1 auto;min-width:0}',
  '.dsh-sel-srowt{font-size:13px;line-height:1.5}',
  '.dsh-sel-srowd{font-size:11.5px;opacity:.55;line-height:1.6;margin-top:3px;max-width:46ch}',
  '.dsh-sel-srowctl{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding-top:2px;min-width:0}',
  // 宽输入框（provider / model / 工具清单）所在行：说明在上、输入框独占一行。
  // 抽屉是嵌在小窗里的窄容器，视口再宽也帮不上忙，所以按"行里有没有宽输入框"来判。
  '.dsh-sel-srow[data-wide="1"]{flex-wrap:wrap}',
  '.dsh-sel-srow[data-wide="1"] .dsh-sel-srowlab{flex:1 1 100%}',
  '.dsh-sel-srow[data-wide="1"] .dsh-sel-srowctl{flex:1 1 100%;padding-top:6px}',
  '.dsh-sel-srow[data-wide="1"] .dsh-sel-stext{width:100%;max-width:none}',
  '.dsh-sel-srow[data-wide="1"] .dsh-sel-spick{width:100%;max-width:none}',
  // 控件：开关（38×22，触屏也点得住）
  '.dsh-sel-sws{flex:none;width:38px;height:22px;border-radius:11px;position:relative;cursor:pointer;padding:0;',
  'border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));background:var(--dsw-alias-bg-layer-2,rgba(140,140,140,.12));',
  'transition:background .18s ease}',
  '.dsh-sel-sws:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
  'background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px rgba(0,0,0,.28);',
  'transition:transform .2s cubic-bezier(.34,1.4,.64,1)}',
  '.dsh-sel-sws[aria-checked="true"]{background:var(--sel-fill,#0f766e);border-color:var(--sel-fill,#0f766e)}',
  '.dsh-sel-sws[aria-checked="true"]:after{transform:translateX(16px);background:var(--sel-fill-fg,#fff)}',
  // 控件：数字 / 文本
  '.dsh-sel-snum{width:74px;border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));border-radius:8px;',
  'padding:5px 8px;background:transparent;color:inherit;font:inherit;font-size:12.5px;text-align:right;',
  'font-variant-numeric:tabular-nums;box-sizing:border-box}',
  '.dsh-sel-stext{width:170px;border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));border-radius:8px;',
  'padding:5px 8px;background:transparent;color:inherit;font:inherit;font-size:12px;box-sizing:border-box}',
  '.dsh-sel-snum:focus-visible,.dsh-sel-stext:focus-visible,.dsh-sel-sws:focus-visible,.dsh-sel-segcell:focus-visible,',
  '.dsh-sel-sheetback:focus-visible,.dsh-sel-railbtn:focus-visible,.dsh-sel-sbtn:focus-visible,',
  '.dsh-sel-action:focus-visible,.dsh-sel-icon:focus-visible{outline:2px solid var(--sel-a1,#0d9488);outline-offset:2px}',
  '.dsh-sel-sunit{font-size:11.5px;opacity:.5;white-space:nowrap}',
  // 模型选择：**自绘下拉**，不用原生 <select>。
  // 原生 select 的弹出层由浏览器画，42 个模型时会顶出可视区且拿不到滚动条（用户报的）。
  // 自绘的列表自己带 max-height + overflow:auto，滚动条是确定的；样式也和 composer 那枚模型菜单一致。
  '.dsh-sel-spick{width:100%;display:flex;align-items:center;gap:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));',
  'border-radius:8px;padding:5px 8px;background:transparent;color:inherit;font:inherit;font-size:12.5px;',
  'box-sizing:border-box;cursor:pointer;text-align:left}',
  '.dsh-sel-spick:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.12))}',
  '.dsh-sel-spickname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-sel-spickcaret{flex:none;font-size:9px;opacity:.6}',
  // 菜单挂在**抽屉**上（不是行里）：行的祖先链上有 overflow:auto 的滚动区，浮层会被它裁掉
  '.dsh-sel-spickmenu{position:absolute;z-index:30;display:none;flex-direction:column;padding:6px;border-radius:12px;',
  'box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,#232427);',
  'border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));box-shadow:0 14px 34px rgba(0,0,0,.35)}',
  '.dsh-sel-spickmenu[data-open="1"]{display:flex}',
  '.dsh-sel-spickgroup{padding:2px 8px 5px;font-size:10.5px;opacity:.6;flex:none}',
  // 列表自己滚：max-height 由 JS 按"抽屉底部还剩多少"给，这里只兜底
  '.dsh-sel-spicklist{flex:1 1 auto;min-height:0;max-height:260px;overflow-y:auto;overflow-x:hidden;',
  'display:flex;flex-direction:column;gap:1px;scrollbar-width:thin;scrollbar-color:rgba(140,140,140,.45) transparent}',
  '.dsh-sel-spicklist::-webkit-scrollbar{width:9px}',
  '.dsh-sel-spicklist::-webkit-scrollbar-thumb{background:rgba(140,140,140,.4);border-radius:9px;border:2px solid transparent;background-clip:content-box}',
  '.dsh-sel-spickrow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;',
  'font:inherit;font-size:12px;text-align:left;border:0;background:transparent;color:inherit;flex:none}',
  '.dsh-sel-spickrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.12))}',
  '.dsh-sel-spickrow[data-on="1"]{font-weight:600}',
  '.dsh-sel-spickcheck{width:12px;flex:0 0 auto;color:var(--sel-a1-text,#0f766e);font-weight:700}',
  '.dsh-sel-spickrowname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-sel-spickprov{flex:none;font-size:10.5px;opacity:.55;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-sel-spickempty{padding:8px;font-size:11.5px;opacity:.55}',
  // 控件：分段（档位）
  '.dsh-sel-sheet .dsh-sel-seg{display:inline-flex;background:var(--dsw-alias-bg-layer-2,rgba(140,140,140,.1));',
  'border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.3));border-radius:9px;padding:2px;position:relative}',
  '.dsh-sel-sheet .dsh-sel-segcell{border:0;background:transparent;cursor:pointer;font:inherit;font-size:11.5px;width:auto;height:26px;min-width:34px;padding:4px 9px;',
  'border-radius:7px;color:inherit;position:relative;z-index:1;white-space:nowrap;opacity:.8}',
  '.dsh-sel-sheet .dsh-sel-segcell[aria-checked="true"]{color:var(--sel-fill-fg,#fff);font-weight:600;opacity:1}',
  '.dsh-sel-sheet .dsh-sel-segpill{position:absolute;top:2px;bottom:2px;height:auto;border-radius:7px;background:var(--sel-fill,#0f766e);z-index:0;',
  'transition:left .22s cubic-bezier(.34,1.3,.64,1),width .22s cubic-bezier(.34,1.3,.64,1)}',
  // 底部动作栏：常驻；不脏时写"改动会自动保存"，脏了才报数
  '.dsh-sel-sheetfoot{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 12px;',
  'border-top:.5px solid var(--dsw-alias-border-l4,rgba(140,140,140,.22));background:var(--dsw-alias-bg-layer-2,rgba(140,140,140,.05))}',
  '.dsh-sel-sfootnote{font-size:11.5px;opacity:.55;margin-right:auto;display:flex;align-items:center;gap:6px}',
  '.dsh-sel-sfootnote i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#e5484d);display:none}',
  '.dsh-sel-sfootnote[data-dirty="1"]{opacity:.9}',
  '.dsh-sel-sfootnote[data-dirty="1"] i{display:block}',
  '.dsh-sel-sbtn{border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));border-radius:8px;padding:5px 11px;',
  'background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}',
  '.dsh-sel-sbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.12))}',
  '.dsh-sel-sbtn:disabled{opacity:.4;cursor:default}',
  '.dsh-sel-sbtn[data-danger="1"]{color:var(--dsw-alias-state-error-primary,#e5484d);',
  'border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 45%,transparent)}',
  '.dsh-sel-sempty{font-size:12px;opacity:.55;padding:14px 2px}',
  // ── 语音卡：选中文字 + 输入法正在语音输入时，就地弹出的临时输入框 ──
  // 它由浮标**形变**而来（同一格 → 下移展开），所以几何全部由 JS 给，这里只管长相。
  // box-sizing 必须显式写：插件是按组件设的（panel/history/pill 各自写），没有全局重置。
  // 漏了它时 style.height 只是"内容高"，加上内边距与边框真实高度会多出 24px ——
  // 单行卡于是渲染成 70px（用户报的"heard 阶段框太大"就是这个）。
  '.dsh-sel-vcard{position:fixed;z-index:2147483000;display:none;align-items:stretch;gap:11px;',
  'box-sizing:border-box;padding:8px 12px 8px 13px;background:var(--dsw-alias-bg-base,#fff);color:inherit;',
  'border:1px solid var(--dsw-alias-border-l2,rgba(140,140,140,.28));border-radius:20px;',
  'box-shadow:0 10px 28px rgba(0,0,0,.18);overflow:hidden;',
  'transition:width .3s cubic-bezier(.2,.8,.2,1),height .3s cubic-bezier(.2,.8,.2,1),',
  'left .3s cubic-bezier(.2,.8,.2,1),top .32s cubic-bezier(.2,.8,.2,1),',
  'border-radius .3s cubic-bezier(.2,.8,.2,1),border-color .2s ease}',
  // 「在听」= 卡片左缘那根 3px 竖条（B1）+ 高度呼吸（动1）。
  // 当年否掉竖条的理由是"太像输入光标"—— 但那次是**通高 + 紧贴文字**；
  // 现在保留同一形态，靠"伸缩"把它从"光标"读成"电平在动"（用户选定 B1+动1）。
  // 描边仍然泛青（静态的"这一段在用"），但**光晕呼吸撤掉**：指示器只留一个，别两个一起动。
  // 竖条在非"在听"时压暗到 .35（录音结束后不再假装在听，且不隐藏 —— 隐藏会让正文跳一下）。
  '.dsh-sel-vcard[data-voiced="1"]{border-color:var(--sel-a2)}',
  '.dsh-sel-vbar{flex:0 0 3px;width:3px;align-self:stretch;border-radius:3px;',
  'background:var(--sel-a1);margin-right:9px;opacity:.35}',
  '.dsh-sel-vcard[data-voiced="1"] .dsh-sel-vbar{opacity:1;',
  'animation:dsh-sel-vbar-pulse 1.05s ease-in-out infinite}',
  '@keyframes dsh-sel-vbar-pulse{50%{transform:scaleY(.55)}}',
  // 正文右侧留 40px 给发送键（它是绝对定位的，不参与行高 —— 否则 30px 的按钮会把
  // 单行卡片顶到 52px，用户看到的就是"临时框太高"）
  '.dsh-sel-vcard-box{flex:1;min-width:0;align-self:center;display:block;margin:0;',
  // min-height:0 是防御：宿主 App 的样式表若给 textarea 设了 min-height（我们管不到别人的全局规则），
  // 高度就会由它说了算 —— 单行卡会因此变高
  'box-sizing:border-box;min-height:0;padding:0 40px 0 0;border:0;outline:0;background:transparent;color:inherit;',
  'resize:none;overflow-y:hidden;font:400 15.5px/1.5 ' + FONT + ';max-height:96px}',
  '.dsh-sel-vcard-box::placeholder{color:var(--dsw-alias-label-tertiary,rgba(140,140,140,.9))}',
  // 尺寸≈一行行高（23.25px）：单行卡里它和文字同一条中线；多行时贴底=跟着最后一行走。
  // 比一行高太多（比如 30px）会让它在单行卡里"看起来掉到文字下面去了"。
  '.dsh-sel-vcard-send{position:absolute;right:12px;bottom:8px;width:26px;height:26px;border:0;',
  'border-radius:50%;background:var(--sel-a1);color:#fff;font:400 14px/1 ' + FONT + ';',
  'cursor:pointer;opacity:0;pointer-events:none;transition:opacity .16s ease}',
  // 还什么都没说时不摆出发送键（先只显示"正在听…"）
  '.dsh-sel-vcard[data-text="1"] .dsh-sel-vcard-send{opacity:1;pointer-events:auto}',
  // ── 选中提示：下划线 + 从选区牵引到卡片的虚线（E 方案）──────────────
  // 抢焦点会让原生选区底纹消失，所以用这两样接手"指认这段文字"。
  // 两者都在我们自己的层里，**不碰选区 / 焦点语义**，对输入法上屏零影响。
  // 颜色直接用 --sel-a1 —— 它本来就按明暗换（浅色 #0d9488 / 深色 #4ecdc4）。
  '.dsh-sel-umark{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;',
  'z-index:2147482998;transition:opacity .14s ease}',
  '.dsh-sel-uline{position:fixed;height:2px;border-radius:1px;pointer-events:none}',
  // 牵引线是 **SVG 贝塞尔**（原来是一根 2px 竖条 → 控制点和端点同 x，退化成直线，
  // 用户一眼看出"这不是贝塞尔"）。现在两端各给一个反向的横向控制量，做出可见的 S 形。
  // ── 截图提问：选框（选区落在窗口内时）/ 贴边缩略图（落在窗口外时）──
  '.dsh-sel-shotframe{position:fixed;z-index:2147482997;display:none;pointer-events:none;',
  'border:2px solid var(--sel-a1,#0d9488);border-radius:3px;',
  'box-shadow:0 0 0 1px rgba(255,255,255,.85),0 0 0 4px color-mix(in srgb,var(--sel-a1,#0d9488) 14%,transparent)}',
  '.dsh-sel-shotframe[data-show="1"]{display:block}',
  '.dsh-sel-shotframe-tag{position:absolute;left:-2px;bottom:-19px;padding:1px 6px;border-radius:5px;',
  'background:var(--sel-fill,#0f766e);color:var(--sel-fill-fg,#fff);font-size:10px;line-height:1.6;white-space:nowrap}',
  '.dsh-sel-shotchip{position:fixed;z-index:2147482997;display:none;align-items:center;gap:7px;box-sizing:border-box;',
  'padding:5px 9px 5px 5px;border-radius:11px;background:var(--dsw-alias-bg-base,#fff);',
  'border:.5px solid var(--dsw-alias-border-l3,rgba(140,140,140,.35));box-shadow:0 8px 22px rgba(0,0,0,.24)}',
  '.dsh-sel-shotchip[data-show="1"]{display:flex}',
  '.dsh-sel-shotchip img{display:block;width:56px;height:32px;object-fit:cover;border-radius:6px;',
  'border:1.5px solid #e5484d;flex:0 0 auto;background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,140,.14))}',
  '.dsh-sel-shotchip-tx{display:flex;flex-direction:column;font-size:10.5px;line-height:1.35;white-space:nowrap;',
  'color:var(--dsw-alias-label-secondary,rgba(90,90,90,.9))}',
  '.dsh-sel-shotchip-tx b{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
  '.dsh-sel-thread{position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;',
  'z-index:2147482998;overflow:visible;display:none;opacity:0;transition:opacity .14s ease}',
  '.dsh-sel-thread path{fill:none;stroke-width:1.6;stroke-dasharray:4 4;',
  'animation:dsh-sel-thread-flow 1.1s linear infinite}',
  // 出现时"向卡片生长"：用 clip 从上往下揭开（display:none → block 时动画自动重放，
  // 不需要 JS 去重置；连续开关卡片也不会第二次不动）
  '.dsh-sel-thread[data-grow="1"]{animation:dsh-sel-thread-grow .26s ease-out}',
  '@keyframes dsh-sel-thread-grow{from{clip-path:inset(0 0 100% 0)}to{clip-path:inset(0 0 0 0)}}',
  // 虚线朝卡片流动：SVG 直接动 stroke-dashoffset（比动 background-position 更省、也更准）
  '@keyframes dsh-sel-thread-flow{to{stroke-dashoffset:-16}}',
  // ── 消失：老式电视机关机（A 方案）────────────────────────────────
  // 卡片塌成一条线，亮线再横缩成一个点；最后一段做成"像素故障"：
  // 亮线拆成 5 段，各自闪、各自抖、各自死；**收缩原点统一在整条线的中心**
  // （百分比是相对每段自己的宽度算的，所以外圈是 200% / -200% 这种值），
  // 于是"往中间收"和"错位露缝"同时发生 —— 那点电子损坏就是这么来的。
  // 为什么不用 mask 做虚线：mask-image 不是可动画属性，写在关键帧里会被忽略。
  // 亮线是**独立元素**，不是卡片的 box-shadow —— 后者会跟着 transform 一起被压扁。
  // 颜色由 JS 按明暗挂到容器上（浅色底白线看不见，只差 ~15/255），子元素用 currentColor 继承。
  '.dsh-sel-crtline{position:fixed;height:3px;pointer-events:none;z-index:2147483001;opacity:0}',
  '.dsh-sel-crtseg,.dsh-sel-crtspark{position:absolute;background:currentColor;border-radius:1px}',
  '.dsh-sel-crtseg{top:0;height:100%;width:20%}',
  '.dsh-sel-crtspark{top:-1px;width:3px;height:5px;opacity:0}',
  '.dsh-sel-vcard[data-off="a"]{transform-origin:50% 50%;animation:dsh-sel-crt-card-a 460ms cubic-bezier(.3,0,.2,1) forwards}',
  '.dsh-sel-crtline[data-off="a"]{animation:dsh-sel-crt-line-a 460ms cubic-bezier(.35,0,.25,1) forwards}',
  '.dsh-sel-crtline[data-off="a"] .dsh-sel-crtseg{animation:dsh-sel-crt-seg-a 460ms cubic-bezier(.4,0,.3,1) forwards}',
  '.dsh-sel-crtline[data-off="a"] .dsh-sel-crtspark{animation:dsh-sel-crt-spark-a 460ms linear forwards}',
  '.dsh-sel-crtline[data-off="a"] .dsh-sel-crtseg:nth-child(1){left:0%;transform-origin:200% 50%;animation-delay:-16ms}',
  '.dsh-sel-crtline[data-off="a"] .dsh-sel-crtseg:nth-child(2){left:20%;transform-origin:100% 50%;animation-delay:-38ms}',
  '.dsh-sel-crtline[data-off="a"] .dsh-sel-crtseg:nth-child(3){left:40%;transform-origin:0% 50%;animation-delay:-4ms}',
  '.dsh-sel-crtline[data-off="a"] .dsh-sel-crtseg:nth-child(4){left:60%;transform-origin:-100% 50%;animation-delay:-30ms}',
  '.dsh-sel-crtline[data-off="a"] .dsh-sel-crtseg:nth-child(5){left:80%;transform-origin:-200% 50%;animation-delay:-22ms}',
  '.dsh-sel-crtline[data-off="a"] .dsh-sel-crtspark:nth-child(6){left:31%;animation-delay:-46ms}',
  '.dsh-sel-crtline[data-off="a"] .dsh-sel-crtspark:nth-child(7){left:67%;animation-delay:-12ms}',
  // opacity 必须在前面显式写 1：只在 100% 写 0 的话，CSS 会从 0% 起就线性插值，
  // 整段塌缩都在同时淡出（实测 160ms 时 opacity 已经掉到 0.365），
  // 而显像管是"一直亮着、最后一下才没"。
  '@keyframes dsh-sel-crt-card-a{',
  '0%{transform:scale(1,1);filter:brightness(1);opacity:1}',
  '38%{transform:scale(1,1.06);filter:brightness(1.35);opacity:1}',
  '62%{transform:scale(1,.055);filter:brightness(2.2);opacity:1}',
  '88%{opacity:1}',
  '100%{transform:scale(.5,.05);filter:brightness(2.4);opacity:0}}',
  '@keyframes dsh-sel-crt-line-a{',
  '0%,52%{opacity:0}',
  '60%{opacity:1}',
  '96%{opacity:1}',
  '100%{opacity:0}}',
  // 每段：一边往中心收，一边闪断（opacity 阶梯）+ 上下抖 1px
  '@keyframes dsh-sel-crt-seg-a{',
  '0%,58%{transform:scaleX(1) translateY(0);opacity:1}',
  '64%{transform:scaleX(.94) translateY(1px);opacity:1}',
  '70%{transform:scaleX(.78) translateY(-1px);opacity:.3}',
  '74%{transform:scaleX(.66) translateY(0);opacity:1}',
  '80%{transform:scaleX(.44) translateY(1px);opacity:.15}',
  '84%{transform:scaleX(.34) translateY(0);opacity:1}',
  '90%{transform:scaleX(.16) translateY(-1px);opacity:.5}',
  '96%{transform:scaleX(.06) translateY(0);opacity:1}',
  '100%{transform:scaleX(0) translateY(0);opacity:0}}',
  // 火花：段子死掉之后还在原位闪两下的残留像素
  '@keyframes dsh-sel-crt-spark-a{',
  '0%,74%{opacity:0}',
  '78%{opacity:1}',
  '82%{opacity:0}',
  '88%{opacity:.9}',
  '94%{opacity:0}',
  '100%{opacity:0}}',
  '@media (prefers-reduced-motion:reduce){',
  '.dsh-sel-vcard{transition:none}.dsh-sel-vcard[data-voiced="1"] .dsh-sel-vbar{animation:none}',
  '.dsh-sel-vcard[data-off="a"],.dsh-sel-crtline[data-off="a"],',
  '.dsh-sel-crtline[data-off="a"] .dsh-sel-crtseg,.dsh-sel-crtline[data-off="a"] .dsh-sel-crtspark{',
  'animation:none!important;opacity:0}',
  '.dsh-sel-thread{animation:none}}',
].join('')
