





export async function run(env) {


  // ───────────────────────── 侧边栏网页（iframe）划词桥 ─────────────────────────
  // 侧边栏 HTML 预览是不透明源沙箱 iframe：父页面读不到里面的选区，
  // 所以桥由帧内主动上报。这一段验的是**父侧接线**：注入、来源校验、坐标换算、
  // 上下文与标签走通、帧内清空选区后收浮标。
  let bridgeOwnedBlob = ''

  {
    // 上一段（历史列表）是开着面板测的；划词桥按老规矩"面板开着时不另开一个"，
    // 先收起来，否则下面每条消息都会被 panelOpen 挡掉（那就测了个寂寞）。
    env.hook.close()
    const beforeBridge = env.hook.selection()

    /** 宿主基础预览（BasicHtmlFrame）：DOMPurify 清洗 + script-src 'none'，srcdoc + sandbox=""。 */
    const SANITIZED =
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
      "script-src 'none'; style-src 'unsafe-inline'\"><style>body{color:red}</style></head>" +
      '<body><p>the migration ran long, so we ship Wednesday</p></body></html>'
    const frame = new env.FakeEl('iframe')
    frame.setAttribute('data-html-preview', 'true')
    frame.setAttribute('sandbox', '')
    frame.setAttribute('srcdoc', SANITIZED)
    frame.isConnected = true
    const frameWindow = { name: 'sidebar-frame' }
    frame.contentWindow = frameWindow

    env.documentStub.querySelectorAll = (selector) => (selector === 'iframe' ? [frame] : [])
    const scanned = env.hook.bridgeScan()
    env.assert('扫到侧边栏预览帧并桥上', scanned.frames.length === 1 && scanned.frames[0].srcdoc === true, JSON.stringify(scanned.frames))

    const injected = frame.getAttribute('srcdoc')
    env.assert('桥脚本注入了 srcdoc（内容没被替换掉）', injected.indexOf('data-dsh-sel-bridge') > 0 && injected.indexOf('the migration ran long, so we ship Wednesday') > 0)
    env.assert('基础预览的 CSP 只放宽 script-src', /script-src 'unsafe-inline'/.test(injected) && /default-src 'none'/.test(injected))
    env.assert('沙箱补 allow-scripts，但不给 allow-same-origin', frame.getAttribute('sandbox') === 'allow-scripts', String(frame.getAttribute('sandbox')))

    // 陌生窗口发来的同款消息一律不理（消息可以被任意页面伪造，来源必须对得上）
    env.windowStub.dispatch('message', { source: { name: 'attacker' }, data: { __dshSel: 1, kind: 'selection', sel: { text: '伪造', context: '', rect: { x: 0, y: 0, right: 10, bottom: 10, w: 10, h: 10 } } } })
    const afterForged = env.hook.selection()
    env.assert(
      '陌生来源的消息被忽略（选区没被改写）',
      (beforeBridge === null && afterForged === null) || (!!afterForged && afterForged.text === beforeBridge.text && afterForged.source === beforeBridge.source),
      JSON.stringify(afterForged),
    )
    env.assert('陌生来源的消息不会点亮 bridge()', env.hook.bridge().active === false)

    // 帧内报来一条选区：帧内视口坐标 + iframe 自身的 getBoundingClientRect（桩：left 40 / top 100）
    env.windowStub.dispatch('message', {
      source: frameWindow,
      data: {
        __dshSel: 1,
        kind: 'selection',
        sel: {
          text: 'the migration ran long',
          context: 'PM: 这周能发布吗？ Dev: 【the migration ran long】, so we ship Wednesday.',
          keyContext: 'PM: 这周能发布吗？ Dev:',
          label: '',
          rect: { x: 10, y: 20, right: 120, bottom: 38, w: 110, h: 18 },
        },
      },
    })
    const bridgeSelection = env.hook.selection()
    env.assert('帧内选区让浮标出现在「帧偏移 + 帧内坐标」处', env.button.style.display === 'inline-flex' && env.button.style.left === '98px' && env.button.style.top === '85px', env.button.style.left + '/' + env.button.style.top)
    env.assert('选区记成 iframe 来源', !!bridgeSelection && bridgeSelection.source === 'iframe' && bridgeSelection.text === 'the migration ran long', JSON.stringify(bridgeSelection))
    env.assert('标签按帧来源给（侧边栏网页）', bridgeSelection.label === '侧边栏网页', bridgeSelection.label)
    env.assert('上下文由帧内带来（含【】标记）', bridgeSelection.context.indexOf('【the migration ran long】') > 0, bridgeSelection.context)
    env.assert('bridge() 报 active', env.hook.bridge().active === true)

    // 交互式预览：外层是宿主 bootstrap（blob: + document.write），桥要换一份带脚本的 blob 上去
    const BOOTSTRAP =
      '<!doctype html><meta charset="utf-8"><script>(()=>{document.open();document.write("<p>the migration ran long, so we ship Wednesday</p>");document.close()})()</scr' + 'ipt>'
    const originalBlob = URL.createObjectURL(new Blob([BOOTSTRAP], { type: 'text/html;charset=utf-8' }))
    const blobFrame = new env.FakeEl('iframe')
    blobFrame.setAttribute('data-html-preview', 'true')
    blobFrame.setAttribute('sandbox', 'allow-scripts')
    blobFrame.setAttribute('src', originalBlob)
    blobFrame.isConnected = true
    const blobWindow = { name: 'sidebar-blob-frame' }
    blobFrame.contentWindow = blobWindow
    env.documentStub.querySelectorAll = (selector) => (selector === 'iframe' ? [frame, blobFrame] : [])
    env.hook.bridgeScan()
    await env.sleep(20) // fetch(blob) → 注入 → 换 src 是异步的
    bridgeOwnedBlob = blobFrame.getAttribute('src')
    env.assert('交互式预览：src 换成我们重发的那份 blob', bridgeOwnedBlob !== originalBlob && bridgeOwnedBlob.startsWith('blob:'), bridgeOwnedBlob)
    env.assert('交互式预览：换上去的文档里有桥脚本', String(await (await env.browserFetch(bridgeOwnedBlob)).text()).indexOf('data-dsh-sel-bridge') > 0)
    env.assert(
      '交互式预览：重发时把原 blob 的 content-type 搬过来（charset 不能丢，否则整页乱码）',
      (env.blobStore.get(bridgeOwnedBlob) || {}).type === 'text/html;charset=utf-8',
      String((env.blobStore.get(bridgeOwnedBlob) || {}).type),
    )
    env.assert('交互式预览：宿主原来那份 blob 不归我们动（它自己回收）', env.blobStore.has(originalBlob))
    env.assert('交互式预览：我们自己那份 blob 登记在册（清理时回收）', env.hook.bridge().frames.some((item) => item.own === true))

    // 帧内清空选区 → 收浮标（顶层选区不会塌，所以只能靠这条消息）
    env.windowStub.dispatch('message', { source: frameWindow, data: { __dshSel: 1, kind: 'clear' } })
    env.assert('帧内清空选区后收浮标', env.button.style.display === 'none' && env.hook.bridge().active === false)

    // ── 消失时机：帧内的"按下"也要收浮标（父页面收不到帧里的 mousedown）──
    env.windowStub.dispatch('message', {
      source: frameWindow,
      data: {
        __dshSel: 1,
        kind: 'selection',
        sel: { text: '按住前那一段', context: '【按住前那一段】', keyContext: '', label: '', rect: { x: 4, y: 6, right: 40, bottom: 24, w: 36, h: 18 } },
      },
    })
    env.assert('（准备）选区先让浮标亮着', env.button.style.display === 'inline-flex')
    env.windowStub.dispatch('message', { source: frameWindow, data: { __dshSel: 1, kind: 'press' } })
    env.assert('帧内按下：浮标立刻收起', env.button.style.display === 'none')
    env.assert('帧内按下：这条选区本身还留着（松手后可能还要用）', env.hook.selection() !== null && env.hook.selection().source === 'iframe', JSON.stringify(env.hook.selection()))

    // 按下的若是**另一个**网页：那条选区已经不是用户在看的东西了，状态一起清
    env.windowStub.dispatch('message', {
      source: frameWindow,
      data: {
        __dshSel: 1,
        kind: 'selection',
        sel: { text: '另一个帧的词', context: '【另一个帧的词】', keyContext: '', label: '', rect: { x: 4, y: 6, right: 40, bottom: 24, w: 36, h: 18 } },
      },
    })
    env.windowStub.dispatch('message', { source: blobWindow, data: { __dshSel: 1, kind: 'press' } })
    env.assert('在另一个网页里按下：浮标收起且旧选区状态清掉', env.button.style.display === 'none' && env.hook.selection() === null && env.hook.bridge().active === false)

    // 交互式预览那一帧报来的选区 → 点浮标 → 面板用的就是桥给的上下文
    env.windowStub.dispatch('message', {
      source: blobWindow,
      data: {
        __dshSel: 1,
        kind: 'selection',
        sel: {
          text: 'slipped',
          context: 'the deadline 【slipped】 to Wednesday',
          keyContext: 'the deadline',
          label: '代码块',
          rect: { x: 8, y: 12, right: 60, bottom: 30, w: 52, h: 18 },
        },
      },
    })
    env.assert('第二帧的选区也能认（多标签页）', env.button.style.display === 'inline-flex' && env.hook.selection().text === 'slipped', JSON.stringify(env.hook.selection()))
    env.assert('帧内给的标签优先（代码块）', env.hook.selection().label === '代码块', env.hook.selection().label)
    env.button.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    const bridgePayload = env.hook.payload()
    env.assert('点浮标后面板用桥给的上下文（不读顶层 DOM）', !!bridgePayload && bridgePayload.context === 'the deadline 【slipped】 to Wednesday', bridgePayload && bridgePayload.context)
    env.assert('面板标签也是桥给的', bridgePayload.label === '代码块', bridgePayload && bridgePayload.label)
    env.hook.close()

    // ── 别的插件在侧边栏渲染的生成网页（「图解」那种：blob: + allow-scripts，没有宿主标记）──
    const visualFrame = new env.FakeEl('iframe')
    visualFrame.setAttribute('class', 'dsv-frame')
    visualFrame.setAttribute('title', '图解')
    visualFrame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups')
    visualFrame.setAttribute('src', URL.createObjectURL(new Blob(['<!doctype html><html><head><meta charset="utf-8"></head><body><p>图解页</p></body></html>'], { type: 'text/html' })))
    visualFrame.isConnected = true
    const visualWindow = { name: 'reply-visual-frame' }
    visualFrame.contentWindow = visualWindow

    // 反面用例：不该被动的帧
    const opaqueFrame = new env.FakeEl('iframe') // 没有 allow-scripts 的第三方帧：不给它加权限
    opaqueFrame.setAttribute('sandbox', '')
    opaqueFrame.setAttribute('srcdoc', '<!doctype html><p>别人的沙箱</p>')
    opaqueFrame.isConnected = true
    const remoteFrame = new env.FakeEl('iframe') // 远端站点：没有任何注入手段
    remoteFrame.setAttribute('sandbox', 'allow-scripts')
    remoteFrame.setAttribute('src', 'https://example.com/')
    remoteFrame.isConnected = true
    const ownFrame = new env.FakeEl('iframe') // 我们自己小窗里的网页答案预览
    ownFrame.setAttribute('data-preview-id', 'pv1')
    ownFrame.setAttribute('sandbox', 'allow-scripts')
    ownFrame.setAttribute('srcdoc', '<!doctype html><p>生成的网页</p>')
    ownFrame.isConnected = true
    env.panel.appendChild(ownFrame)

    env.documentStub.querySelectorAll = (selector) =>
      selector === 'iframe' ? [frame, blobFrame, visualFrame, opaqueFrame, remoteFrame, ownFrame] : []
    env.hook.bridgeScan()
    await env.sleep(20) // visualFrame 的 blob 分支也是异步的
    const bridgedNow = env.hook.bridge().frames
    env.assert(
      '「图解」那种 blob 帧也被桥上（不只认宿主标记）',
      bridgedNow.length === 3 && visualFrame.getAttribute('data-dsh-sel-bridged') === '1',
      JSON.stringify(bridgedNow),
    )
    env.assert('第三方没有 allow-scripts 的沙箱帧不动它（不给别人加权限）', opaqueFrame.getAttribute('data-dsh-sel-bridged') === null && opaqueFrame.getAttribute('sandbox') === '')
    env.assert('远端站点 iframe 不动它', remoteFrame.getAttribute('data-dsh-sel-bridged') === null)
    env.assert('我们小窗里的网页答案预览不桥（面板开着也不会用它）', ownFrame.getAttribute('data-dsh-sel-bridged') === null)
    env.assert('「图解」帧的 src 换成了我们重发的那份', visualFrame.getAttribute('src').indexOf('blob:') === 0 && visualFrame.getAttribute('src') !== null)

    env.windowStub.dispatch('message', {
      source: visualWindow,
      data: {
        __dshSel: 1,
        kind: 'selection',
        sel: { text: '图解里的词', context: '【图解里的词】的上下文', keyContext: '', label: '', rect: { x: 5, y: 6, right: 40, bottom: 22, w: 35, h: 16 } },
      },
    })
    const visualSelection = env.hook.selection()
    env.assert('「图解」帧的选区也认', !!visualSelection && visualSelection.text === '图解里的词', JSON.stringify(visualSelection))
    env.assert('位置标签取帧自己的 title（图解）', visualSelection.label === '图解', visualSelection.label)
    env.hook.close()
  }


  // ───────────────────────── 引用（❝）：小窗里的内容 / 主界面选中的文字 → 输入框 ─────────────────────────
  // 两个入口共用一份清单（state.quotes），发送时拼进这一条消息：
  //   ① 小窗开着时划小窗里的正文 → 「❝ 引用」；
  //   ② 小窗开着时划主界面（含侧边栏网页）上的文字 → 同一个浮标；
  //   ③ 助手气泡末尾的「引用整条」。
  {
    const quoteRect = { left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }
    /** 造一条"本文档里的选区"：起点落在指定的节点上（祖先链就是插件要判定的东西）。 */
    const selectText = (node, text) => {
      const range = {
        startContainer: node,
        endContainer: node,
        cloneRange: () => range,
        getClientRects: () => [quoteRect],
        getBoundingClientRect: () => quoteRect,
      }
      env.windowStub.getSelection = () => ({
        isCollapsed: false,
        rangeCount: 1,
        toString: () => text,
        getRangeAt: () => range,
      })
    }
    const restoreGetSelection = env.windowStub.getSelection
    const quoteButton = env.hook.quoteNode()
    const quotesBox = Array.from(env.walk(env.panel)).find((n) => n.className === 'dsh-sel-quotes')
    env.assert('输入框上方有引用区（默认收起）', !!quotesBox && quotesBox.getAttribute('data-show') === '0', quotesBox ? quotesBox.getAttribute('data-show') : '未找到')

    // 本段自带前提：重开一个小窗（独一无二的选中文字，不吃缓存/历史）
    env.hook.close()
    env.hook.open('quote-probe', '引用用例的上下文片段', '引用测试')
    for (let i = 0; i < 120 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
    env.assert('（前提）引用用例的首轮出完', env.hook.state().phase === 'done', env.hook.state().phase)

    // ① 小窗里选中的正文（翻译节）
    // ⚠️ mouseup 的 target 必须是**面板里的节点**（真实浏览器就是这样上报的）：
    //    早先 mouseup 对面板内的目标直接 return，小窗里划词毫无反应 —— 用 document.body
    //    当 target 的写法测不出来（实测踩过：只有「引用整条」能用）。
    let sectionP
    for (let i = 0; i < 100 && !sectionP; i += 1) {
      sectionP = Array.from(env.walk(env.sections.find(node => node.getAttribute('data-sec') === 'translation'))).find(node => node.tagName === 'P' && env.textOf(node).includes('引用用例的翻译段落'))
      if (!sectionP) await env.sleep(20)
    }
    env.assert('引用前等待翻译段落实际渲染', !!sectionP)
    selectText(sectionP, '引用用例的翻译段落')
    env.documentStub.dispatch('mouseup', { target: sectionP })
    await env.sleep(30)
    const inPanel = env.hook.quoteState()
    env.assert('小窗里划词：浮出「❝ 引用」', inPanel.visible === true, JSON.stringify({ ...inPanel, nodeText: env.textOf(sectionP), ancestors: sectionP && sectionP.parentNode && sectionP.parentNode.className }))
    env.assert(
      '来源写到"哪一节"（用该节自己的标题）',
      !!inPanel.selection && inPanel.selection.label === '小窗「翻译」节' && inPanel.selection.source === 'panel',
      JSON.stringify(inPanel.selection),
    )
    env.assert('小窗开着时不弹「✦ 解读」（要解读直接在输入框里问）', env.button.style.display === 'none', String(env.button.style.display))

    quoteButton.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    await env.sleep(10)
    let quotes = env.hook.quotes()
    env.assert('点一下 → 引用区多了一张卡片', quotes.length === 1 && quotes[0].text === '引用用例的翻译段落' && quotes[0].label === '小窗「翻译」节', JSON.stringify(quotes))
    env.assert('卡片画进输入框上方（来源 + 摘要）', quotesBox.getAttribute('data-show') === '1' && env.textOf(quotesBox).indexOf('小窗「翻译」节') >= 0 && env.textOf(quotesBox).indexOf('引用用例的翻译段落') >= 0, env.textOf(quotesBox))
    env.assert('加完引用浮标自己收起来（"已经进去了"的信号）', quoteButton.style.display === 'none', String(quoteButton.style.display))
    env.assert('只挂引用、没写问题时发送键可用', env.askSend.disabled === false, 'disabled=' + env.askSend.disabled)
    env.assert(
      '小窗里的引用**不带上下文**（小窗这几轮对话本来就会随历史进模型）',
      !!quotes[0] && quotes[0].context === '' && quotes[0].session === false,
      JSON.stringify({ context: quotes[0] && quotes[0].context, session: quotes[0] && quotes[0].session }),
    )
    env.assert(
      '引用浮标画在面板**之上**（小窗里划词才看得见、点得着）',
      Number(quoteButton.style.zIndex) > Number(env.panel.style.zIndex),
      `quote=${quoteButton.style.zIndex} panel=${env.panel.style.zIndex}`,
    )

    // 划一大段（超过单段引用上限）也必须有反应：浮标照出，加进去时截断并说明
    {
      selectText(sectionP, '长'.repeat(4200))
      env.documentStub.dispatch('mouseup', { target: sectionP })
      await env.sleep(30)
      env.assert('超长选区照样浮出引用浮标（"划长一点就没反应"是坑）', env.hook.quoteState().visible === true, JSON.stringify(env.hook.quoteState()))
      quoteButton.dispatch('click', { preventDefault() {}, stopPropagation() {} })
      await env.sleep(10)
      const longQuote = env.hook.quotes().pop()
      env.assert(
        '超长引用保留完整选区，不静默截断',
        !!longQuote && longQuote.text.length === 4200 && env.hook.state().status.indexOf('已截断') < 0,
        `${longQuote && longQuote.text.length} · ${env.hook.state().status}`,
      )
      const chipList = Array.from(env.walk(quotesBox)).filter((n) => n.className === 'dsh-sel-quotechip-x')
      // 前面若已失败（引用没挂上），这里就没有 chip —— 别让它把整个脚本打断
      const lastChip = chipList[chipList.length - 1]
      if (lastChip) lastChip.dispatch('click', { stopPropagation() {} })
      await env.sleep(5)
      env.assert('删掉超长那条后回到 1 条', env.hook.quotes().length === 1, JSON.stringify(env.hook.quotes().map((q) => q.text.length)))
      // 把浮标状态也归零：不然下面那次"再点一次"的点击会把这段长文又加回来
      //（浮标虽然收起来了，但 state.quoteSelection 还留着上一次的选区）
      env.windowStub.getSelection = () => ({ isCollapsed: true, rangeCount: 0, toString: () => '' })
      env.documentStub.dispatch('mouseup', { target: sectionP })
      await env.sleep(20)
    }

    const clicksBefore = env.hook.quoteState().visible
    quoteButton.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    env.assert('浮标收起后再点它不会重复加', env.hook.quotes().length === 1 && clicksBefore === false, JSON.stringify(env.hook.quotes().map((q) => q.text)))

    // 同一段再加一次：不加，但要有交代（点了"没反应"是最难查的观感）
    env.assert(
      '重复的引用不再加，并说明原因',
      env.hook.quote('引用用例的翻译段落', '小窗回答') === false && env.hook.state().status.indexOf('已经在引用里') >= 0,
      env.hook.state().status,
    )

    // 上限：最多 4 段
    env.hook.quote('第二段引用', '小窗详解')
    env.hook.quote('第三段引用', '侧边栏网页')
    env.hook.quote('第四段引用', '调试')
    env.assert('四段引用都在', env.hook.quotes().length === 4, JSON.stringify(env.hook.quotes().map((q) => q.text)))
    env.assert(
      '第五段被挡下并说明原因',
      env.hook.quote('第五段引用', '调试') === false && env.hook.state().status.indexOf('最多 4 段') >= 0,
      env.hook.state().status,
    )

    // 卡片上的 ✕
    const chipXs = Array.from(env.walk(quotesBox)).filter((n) => n.className === 'dsh-sel-quotechip-x')
    env.assert('每张卡片都有 ✕', chipXs.length === 4, String(chipXs.length))
    chipXs[0].dispatch('click', { stopPropagation() {} })
    await env.sleep(5)
    env.assert(
      '点 ✕ 能精确删掉那一条',
      env.hook.quotes().length === 3 && !env.hook.quotes().some((q) => q.text === '引用用例的翻译段落'),
      JSON.stringify(env.hook.quotes().map((q) => q.text)),
    )

    // ② 小窗开着时，主界面上的选区也走同一个浮标
    selectText(env.textEl, '主界面上的这一段')
    env.documentStub.dispatch('mouseup', { target: env.textEl })
    await env.sleep(30)
    const onDoc = env.hook.quoteState()
    env.assert('小窗开着时主界面划词：同样浮出「❝ 引用」', onDoc.visible === true, JSON.stringify(onDoc))
    env.assert('来源标成「主界面选中」', !!onDoc.selection && onDoc.selection.label === '主界面选中' && onDoc.selection.source === 'document', JSON.stringify(onDoc.selection))
    quoteButton.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    await env.sleep(10)
    quotes = env.hook.quotes()
    env.assert(
      '主界面选中的文字挂进了同一份清单',
      quotes.length === 4 && quotes[3].text === '主界面上的这一段' && quotes[3].label === '主界面选中',
      JSON.stringify(quotes.map((q) => q.label)),
    )
    env.assert(
      '主界面的引用标成"会话里的"（发送前会问 host 要按轮取整的上下文）',
      quotes[3].session === true,
      JSON.stringify({ session: quotes[3].session, context: quotes[3].context.slice(0, 30) }),
    )

    // ③ 发送：引用拼进这一条消息（气泡里也要看得见），会话里的引用先补上下文
    const callsBefore = env.quoteContextCalls.length
    const beforeSend = env.sent.length
    env.askBox.value = '这几段有什么关系？'
    env.askSend.dispatch('click', { stopPropagation() {} })
    for (let i = 0; i < 120 && env.sent.length === beforeSend; i += 1) await env.sleep(20)
    const quotePayload = env.sent[env.sent.length - 1] || {}
    env.assert(
      '载荷里的 question 就是拼好的那份（引用在前、问题在后）',
      String(quotePayload.question).indexOf('【引用 1】（来自小窗详解）') === 0 && /【我的问题】\n这几段有什么关系？$/.test(String(quotePayload.question)),
      String(quotePayload.question).replace(/\n/g, '⏎').slice(0, 120),
    )
    env.assert(
      '每段引用各带来源，按加入顺序编号',
      /【引用 2】（来自侧边栏网页）/.test(String(quotePayload.question)) &&
        /【引用 4】（来自主界面选中）/.test(String(quotePayload.question)) &&
        String(quotePayload.question).indexOf('第五段引用') < 0,
      String(quotePayload.question).replace(/\n/g, '⏎'),
    )
    env.assert(
      '引用时已获取会话快照，发送不重新获取',
      env.quoteContextCalls.length === callsBefore && callsBefore > 0 &&
        env.quoteContextCalls[env.quoteContextCalls.length - 1].text === '主界面上的这一段' &&
        env.quoteContextCalls[env.quoteContextCalls.length - 1].sessionId === 'session-stub-1',
      JSON.stringify(env.quoteContextCalls.slice(-1)),
    )
    env.assert(
      '拼好的消息里带上【引用处上下文】，被引用的部分用【】标出',
      String(quotePayload.question).indexOf('【引用处上下文】（被引用的部分用【】标出）') > 0 &&
        String(quotePayload.question).indexOf('用户：【主界面上的这一段】') > 0 &&
        String(quotePayload.question).indexOf('助手：引用之后的那句回答。') > 0,
      String(quotePayload.question).replace(/\n/g, '⏎').slice(-160),
    )
    env.assert(
      '没有上下文的引用照旧只给原文（不硬造一段空上下文）',
      /【引用 1】（来自小窗详解）\n第二段引用\n/.test(String(quotePayload.question)),
      String(quotePayload.question).replace(/\n/g, '⏎').slice(0, 80),
    )
    env.assert(
      '引用用完即清（不会跟着下一轮又发一遍）',
      env.hook.quotes().length === 0 && quotesBox.getAttribute('data-show') === '0',
      JSON.stringify(env.hook.quotes()),
    )
    const quoteTurn = env.hook.turns().filter((t) => t.role === 'user').pop()
    env.assert(
      '轮次里同时留着「问了什么」和「带了哪些引用」',
      quoteTurn.text === '这几段有什么关系？' && (quoteTurn.quotes || []).length === 4 && quoteTurn.sent === quotePayload.question,
      JSON.stringify({ text: quoteTurn.text, quotes: (quoteTurn.quotes || []).length }),
    )
    env.assert(
      '用户气泡里画出了引用块（引用在上、问题在下）',
      env.textOf(env.chatLog).indexOf('❝ 小窗详解') >= 0 && env.textOf(env.chatLog).indexOf('这几段有什么关系？') >= 0,
      env.textOf(env.chatLog).slice(-90),
    )
    env.assert(
      '气泡里的引用是摘要（长引用不撑破气泡，完整文本进 title）',
      Array.from(env.walk(env.chatLog)).some((n) => n.className === 'dsh-sel-bqitem' && n.title === '第二段引用'),
      Array.from(env.walk(env.chatLog)).filter((n) => n.className === 'dsh-sel-bqitem').map((n) => n.title).join('|'),
    )

    // ④ 带引用的那一轮要以"拼好的样子"进历史给模型（否则下一轮模型不知道"这几段"指什么）
    for (let i = 0; i < 120 && env.hook.state().asking !== false; i += 1) await env.sleep(20)
    const beforeSecond = env.sent.length
    env.hook.ask('那第三段呢？')
    for (let i = 0; i < 120 && env.sent.length === beforeSecond; i += 1) await env.sleep(20)
    const secondPayload = env.sent[env.sent.length - 1] || {}
    const carried = (secondPayload.history || []).find((t) => t.role === 'user' && String(t.text).indexOf('【引用 1】') >= 0)
    env.assert(
      '带引用的那一轮原样进历史（引用块不能丢）',
      !!carried && String(carried.text).indexOf('【我的问题】') > 0,
      carried ? String(carried.text).replace(/\n/g, '⏎').slice(0, 60) : JSON.stringify((secondPayload.history || []).map((t) => t.role)),
    )

    // ④b 小窗里的对话引用：**不带上下文**，但要说清出自哪一轮（对话本身会随历史进模型）
    for (let i = 0; i < 120 && env.hook.state().asking !== false; i += 1) await env.sleep(20)
    {
      const bubbles = Array.from(env.walk(env.chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble-bot') >= 0)
      const target = bubbles[bubbles.length - 1]
      const node = Array.from(env.walk(target)).find((n) => n.tagName === 'P') || target
      selectText(node, '这是对追问的回答')
      env.documentStub.dispatch('mouseup', { target: node })
      await env.sleep(30)
      const state = env.hook.quoteState()
      env.assert('小窗气泡里划词：认得出在哪一轮上', state.selection && state.selection.turnIndex >= 0, JSON.stringify(state.selection))
      quoteButton.dispatch('click', { preventDefault() {}, stopPropagation() {} })
      await env.sleep(10)
      const panelQuote = env.hook.quotes().pop()
      env.assert(
        '对话引用的出处 = 「小窗第 N 轮回答」',
        !!panelQuote && /^小窗第 [0-9]+ 轮回答$/.test(panelQuote.label),
        panelQuote && panelQuote.label,
      )
      env.assert(
        '对话引用不带上下文（小窗对话本来就在历史里，重复贴没意义）',
        !!panelQuote && panelQuote.context === '' && panelQuote.session === false,
        JSON.stringify(panelQuote && { context: panelQuote.context, session: panelQuote.session }),
      )
      const composed = env.hook.compose()
      env.assert(
        '拼进消息时只写出处、不贴【引用处上下文】',
        composed.indexOf('【引用处上下文】') < 0 &&
          composed.indexOf('【引用原文】') < 0 &&
          composed.indexOf('【引用 1】（来自小窗第') === 0,
        composed.replace(/\n/g, '⏎').slice(0, 160),
      )
      // 这一段不发了，清掉，别影响后面的用例
      const lastChip = Array.from(env.walk(quotesBox)).filter((n) => n.className === 'dsh-sel-quotechip-x').pop()
      if (lastChip) lastChip.dispatch('click', { stopPropagation() {} })
      await env.sleep(5)
    }

    // ④c host 不认（引用不在会话里 / 路由失败）→ 用客户端自己采的那份上下文，照发不误
    for (let i = 0; i < 120 && env.hook.state().asking !== false; i += 1) await env.sleep(20)
    {
      globalThis.__quoteContextFixture = 'miss'
      env.hook.quote('回退探测的一段', '主界面选中', { context: '客户端兜底的上下文：用户：【回退探测的一段】', session: true })
      const beforeFallback = env.sent.length
      env.hook.ask('回退探测：这段呢？')
      for (let i = 0; i < 120 && env.sent.length === beforeFallback; i += 1) await env.sleep(20)
      const fallbackPayload = env.sent[env.sent.length - 1] || {}
      env.assert(
        'host 定位不到时用客户端兜底的上下文（发送不被卡住）',
        String(fallbackPayload.question).indexOf('用户：【回退探测的一段】') > 0,
        String(fallbackPayload.question).replace(/\n/g, '⏎').slice(0, 120),
      )
      globalThis.__quoteContextFixture = undefined
    }

    // ⑤ 只挂引用、没写问题：也允许发（兜底一句人话，绝不空发）
    for (let i = 0; i < 120 && env.hook.state().asking !== false; i += 1) await env.sleep(20)
    env.hook.quote('只带引用的一段', '主界面选中')
    env.askBox.value = ''
    const beforeOnly = env.sent.length
    env.askBox.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
    for (let i = 0; i < 120 && env.sent.length === beforeOnly; i += 1) await env.sleep(20)
    const onlyPayload = env.sent[env.sent.length - 1] || {}
    env.assert('空输入框 + 有引用时按 Enter 能发出去', env.sent.length === beforeOnly + 1, `sent=${env.sent.length - beforeOnly}`)
    env.assert(
      '兜底提问只有一句，引用块照旧在前',
      String(onlyPayload.question).indexOf('【我的问题】\n就上面引用的文字，说说它在这里是什么意思。') > 0,
      String(onlyPayload.question).replace(/\n/g, '⏎').slice(-60),
    )
    const onlyTurn = env.hook.turns().filter((t) => t.role === 'user').pop()
    env.assert('气泡里显示的就是那句兜底提问', onlyTurn.text === '就上面引用的文字，说说它在这里是什么意思。', onlyTurn.text)

    // ⑥ 助手气泡末尾的「引用整条」（平时隐身，鼠标移上去才浮出来）
    for (let i = 0; i < 120 && env.hook.state().asking !== false; i += 1) await env.sleep(20)
    const botBubbles = Array.from(env.walk(env.chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble-bot') >= 0)
    const lastBot = botBubbles[botBubbles.length - 1]
    const quoteAllBtn = Array.from(env.walk(lastBot)).find((n) => String(n.className).indexOf('dsh-sel-bubquote') >= 0)
    env.assert('助手气泡末尾有「引用整条」', !!quoteAllBtn && env.textOf(quoteAllBtn).indexOf('引用整条') >= 0, quoteAllBtn ? env.textOf(quoteAllBtn) : '未找到')
    quoteAllBtn.dispatch('click', { stopPropagation() {} })
    await env.sleep(10)
    const allQuotes = env.hook.quotes()
    const lastBotTurn = env.hook.turns().filter((t) => t.role === 'assistant' && t.streaming !== true).pop()
    env.assert(
      '点一下 → 整条回答进了引用',
      allQuotes.length === 1 && /^小窗第 [0-9]+ 轮回答$/.test(allQuotes[0].label) && allQuotes[0].text.indexOf('这是对追问的回答') >= 0,
      JSON.stringify(allQuotes.map((q) => q.label + ':' + q.text.slice(0, 16))),
    )
    env.assert('引用的是这一轮的原文（卡片上才是摘要）', allQuotes[0].text === lastBotTurn.text, `${allQuotes[0].text.length} vs ${String(lastBotTurn.text).length}`)
    env.assert(
      '「引用整条」也不带上下文（出处靠标签）',
      allQuotes[0].context === '' && allQuotes[0].session === false,
      JSON.stringify({ context: allQuotes[0].context, session: allQuotes[0].session }),
    )

    // ⑥b 等待/流式中的那条不给「引用整条」：内容是半截的，引用它没有意义（定稿后才出现）
    {
      env.hook.open('quote-wait-probe', '', '等待用例')
      for (let i = 0; i < 120 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
      env.hook.ask('等待用例的问题')
      let sawStreaming = false
      for (let i = 0; i < 60; i += 1) {
        if (env.hook.turns().some((t) => t.streaming === true)) {
          sawStreaming = true
          break
        }
        await env.sleep(10)
      }
      const waiting = Array.from(env.walk(env.chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble-bot') >= 0).pop()
      env.assert(
        '等待/流式中的那条不给「引用整条」',
        sawStreaming &&
          !!waiting &&
          !Array.from(env.walk(waiting)).some((n) => String(n.className).indexOf('dsh-sel-bubquote') >= 0),
        `${sawStreaming ? 'streaming' : '未抓到流式态'} · ${waiting ? env.textOf(waiting).slice(0, 20) : '未找到'}`,
      )
      for (let i = 0; i < 160 && env.hook.state().asking !== false; i += 1) await env.sleep(20)
      const settled = Array.from(env.walk(env.chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble-bot') >= 0).pop()
      env.assert(
        '定稿之后「引用整条」才出现',
        !!settled && Array.from(env.walk(settled)).some((n) => String(n.className).indexOf('dsh-sel-bubquote') >= 0),
        settled ? env.textOf(settled).slice(0, 20) : '未找到',
      )
    }

    // ⑦ 小窗收起来：浮标回到「✦ 解读」（引用只在开着小窗时有意义）
    env.hook.close()
    selectText(env.textEl, '主界面上的另一次选中')
    env.documentStub.dispatch('mouseup', { target: env.textEl })
    await env.sleep(30)
    env.assert(
      '小窗收起后：浮标回到「✦ 解读」，引用浮标不再出现',
      quoteButton.style.display === 'none' && env.button.style.display === 'inline-flex',
      `quote=${quoteButton.style.display} read=${env.button.style.display}`,
    )

    // ⑧ 换一段选中文字 = 换一次对话：上一段攒的引用不该跟过来
    env.hook.open('slipped', '', '换选区')
    await env.sleep(30)
    env.assert(
      '换选区后引用清单清空',
      env.hook.quotes().length === 0 && quotesBox.getAttribute('data-show') === '0',
      JSON.stringify(env.hook.quotes()),
    )

    env.windowStub.getSelection = restoreGetSelection
    env.hook.close()
  }
  for (const dispose of env.disposers.splice(0).reverse()) dispose()
  env.assert('清理后划词桥自己建的预览 blob 被回收', bridgeOwnedBlob !== '' && !env.blobStore.has(bridgeOwnedBlob), bridgeOwnedBlob)
}
