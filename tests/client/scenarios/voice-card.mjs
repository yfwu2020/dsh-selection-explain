





export async function run(env) {

  // ───────────────────────── 语音卡：选中文字 + 输入法正在语音输入 ─────────────────────────
  // 这条链路的关键是"我们不读输入法的转写结果"：输入法上屏只认焦点元素，
  // 所以只要在它开麦时把焦点拿到自己的输入框上，说的话就会自己落进来。
  {
    // 也认 setAttribute('class') —— SVG 元素的 className 是只读对象，插件只能用 setAttribute
    const find = (cls) =>
      Array.from(env.walk(env.floatingLayer)).find(
        (n) => n.className === cls || (n.getAttribute && n.getAttribute('class') === cls),
      )

    env.hook.close()
    await env.sleep(20)

    // host 报：豆包输入法正在采集麦克风
    env.micStub.value = {
      ok: true,
      available: true,
      capturing: true,
      processes: [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }],
      reason: '',
    }
    // 同一行里如果有行内元素（<code>/粗体），getClientRects() 会给多个矩形且底边不等高 ——
    // 必须归并成一条，否则会"划两层"、渐隐还会出现在行中间（用户实测的两个问题，同一根因）。
    // 注意：插件在 checkSelection 时就把 range **存下来了**，所以补丁必须打在捕获之前；
    // 而且桩的 getRangeAt() 每次返回新对象（createRange()），所以补丁要打在 createRange 上。
    const realCreateRange = env.documentStub.createRange.bind(env.documentStub)
    // 起点所在的"块"：底边 110 —— 落在下面那段大选区（100..200）**中间**。
    // 老代码只按这个块算，卡片就会压在剩下的选中文字上（用户报的"大段文字时卡片遮住文字"）。
    const blockEl = {
      nodeType: 1,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 40, top: 100, right: 500, bottom: 110, width: 460, height: 10 }),
    }
    const realGCS = env.windowStub.getComputedStyle
    env.windowStub.getComputedStyle = (el) =>
      el === blockEl
        ? { display: 'block', backgroundColor: 'rgba(0,0,0,0)' }
        : realGCS
          ? realGCS(el)
          : { display: '', backgroundColor: 'rgba(0,0,0,0)' }
    env.documentStub.createRange = () => {
      const r = realCreateRange()
      r.startContainer = blockEl
      // 真实浏览器实测的形状（选区跨整段时）：一个**块级盒子**（h=53，盖住两行）
      // + 每行两个片段（行内 code 会给出外盒/内盒）。
      // 块盒不丢掉的话会把两行吞成一组 → 只有一条下划线（用户报的"有些行没有划线"）。
      r.getClientRects = () => [
        { left: 20, top: 100, right: 580, bottom: 153, width: 560, height: 53 },
        { left: 20, top: 102, right: 187, bottom: 123, width: 167, height: 21 },
        { left: 187, top: 105, right: 346, bottom: 122, width: 159, height: 17 },
        { left: 20, top: 128, right: 83, bottom: 149, width: 63, height: 21 },
        { left: 83, top: 128, right: 533, bottom: 149, width: 450, height: 21 },
      ]
      // 选区本体很大（跨到 200），起点块只到 110
      // 选区右缘故意放到很靠右（innerWidth 1440）：老规则"正文列左边→选区右缘"会算出 560，
      // 现在统一 360 —— 这条断言就是为了钉住"不再随选区位置变宽"。
      r.getBoundingClientRect = () => ({ left: 40, top: 100, right: 1300, bottom: 200, width: 1260, height: 100 })
      return r
    }

    // 造一次真选区（走 mouseup 那条路）：浮标一出现就开始看麦克风
    env.windowStub.getSelection = () => env.selection
    env.documentStub.dispatch('mouseup', { target: env.body })
    await env.sleep(250)

    const opened = env.hook.voiceCard()
    env.assert('检测到输入法开麦 → 语音卡自己弹出来', opened.open === true, JSON.stringify(opened))
    env.assert('卡片处于"在听"状态（竖条呼吸）', opened.voiced === true, JSON.stringify(opened))
    env.assert(
      '大段选区：卡片按**整个选区**的底边落位（不压在选中的文字上）',
      !!opened.geometry && opened.geometry.top === '222px',
      'top=' + String(opened.geometry && opened.geometry.top) + '（按起点块算会是 132px，正好压在选区里）',
    )
    env.assert(
      '卡片宽度固定 360（不随选区位置变宽；老规则在这里会给出 560）',
      !!opened.geometry && opened.geometry.width === '360px',
      JSON.stringify(opened.geometry),
    )

    const box = find('dsh-sel-vcard-box')
    const sendBtn = find('dsh-sel-vcard-send')
    env.assert('卡片里有输入框（IME 上屏要落在它身上）', !!box && !!sendBtn, String(!!box) + '/' + String(!!sendBtn))
    // 「在听」指示器 = 卡片左缘那根 3px 竖条（B1 + 动1，用户选定）
    const vbar = find('dsh-sel-vbar')
    const cardNode = find('dsh-sel-vcard')
    env.assert(
      '卡片里有那根「在听」竖条，且是卡片的第一个子元素（正文排在它右边）',
      !!vbar && !!cardNode && !!cardNode.children && cardNode.children[0] === vbar,
      vbar ? '竖条存在；是第一个子元素=' + String(!!cardNode && cardNode.children[0] === vbar) : '没找到竖条',
    )
    // 选中提示（下划线 + 牵引线）：**只在卡片打开后才画** —— 选中/浮标阶段不画（那时原生底纹还在）
    const uline = find('dsh-sel-uline')
    const thread = find('dsh-sel-thread')
    env.assert(
      '卡片打开后画了下划线（按选区逐行矩形）',
      !!uline && /px$/.test(String(uline.style.width)),
      uline ? String(uline.style.width) : 'none',
    )
    env.assert(
      '下划线是两端渐隐的（U3）',
      !!uline && /linear-gradient/.test(String(uline.style.background)),
      uline ? String(uline.style.background).slice(0, 46) : 'none',
    )
    // （旧的"圆点 display:block"断言删了：圆点现在是 SVG 子元素，没有自己的 display，
    //   由下面的 cx/cy 断言覆盖 —— 那才是它真正要表达的东西。）
    const threadPath = find('dsh-sel-threadpath')
    const threadDot = find('dsh-sel-threaddot')
    const d = threadPath ? String(threadPath.getAttribute('d')) : ''
    env.assert(
      '牵引线是 **SVG 贝塞尔**（path 里有 C 曲线段，不再是直线）',
      !!threadPath && d.indexOf('C') > 0,
      d ? d.slice(0, 64) : 'none',
    )
    env.assert(
      '牵引线终点 = **算出来的最终位置** + 4px（222+4=226：一开始就瞄准最终位置，不跟随形变、也不指到解读按钮上）',
      / 964 226$/.test(d),
      'd 的结尾=' + JSON.stringify(d.slice(-14)),
    )
    env.assert(
      '牵引线起点有锚点圆（cx/cy 落在选区末行中点）',
      !!threadDot && String(threadDot.getAttribute('cx')) === '276.5' && String(threadDot.getAttribute('cy')) === '151',
      threadDot ? 'cx=' + String(threadDot.getAttribute('cx')) + ' cy=' + String(threadDot.getAttribute('cy')) : 'none',
    )

    const merged = Array.from(env.walk(env.floatingLayer)).filter((n) => n.className === 'dsh-sel-uline')
    env.assert(
      '块级盒子被丢掉，两行各有一条下划线（不再整段只剩一条）',
      merged.length === 2,
      '下划线条数=' + merged.length + '（应为 2；不丢块盒会是 1）',
    )
    env.assert(
      '第一行：归并成一条（20..346），取最低底边 123+3',
      !!merged[0] && merged[0].style.width === '326px' && merged[0].style.top === '126px',
      merged[0] ? String(merged[0].style.width) + ' / top=' + String(merged[0].style.top) : 'none',
    )
    env.assert(
      '第二行也有自己的下划线（20..533）',
      !!merged[1] && merged[1].style.width === '513px' && merged[1].style.top === '152px',
      merged[1] ? String(merged[1].style.width) + ' / top=' + String(merged[1].style.top) : 'none',
    )

    env.documentStub.createRange = realCreateRange
    env.windowStub.getComputedStyle = realGCS

    // 焦点：桩 DOM 的 focus() 是空实现，这里换成可观测的再重开一次
    let focused = false
    if (box) box.focus = () => { focused = true }
    env.hook.voiceCardClose()
    env.hook.voiceCardOpen()
    env.assert('打开卡片时把焦点抢到输入框（上屏只认焦点元素）', focused === true, String(focused))

    // 形变期间正文宽度被钉在终值（否则每帧重新折行 → 卡顿）；结束后必须解开，
    // 否则之后打字时正文宽度不会再跟着卡片走
    await env.sleep(520)
    env.assert(
      '形变结束后解开正文宽度（回到 flex 布局）',
      !box.style.width && !box.style.flex,
      'width=' + String(box.style.width) + ' flex=' + String(box.style.flex),
    )

    // 开麦结束、一个字都没说 —— 先验**关掉**这两个收尾开关时的老行为：
    // 卡片**不退出**（用户可以接着手动打字），只是不再显示"在听"。
    // ⚠️ 这两个开关的出厂默认是**开**（2026-10-09 用户指定），所以这里必须显式设成 false；
    //    打开后的两条收尾在文件末尾单独验。
    env.settingsStub.value = { voiceCancelOnSilence: false, voiceAutoSend: false }
    env.hook.reloadSettings()
    await env.sleep(120)
    env.micStub.value = { ok: true, available: true, capturing: false, processes: [], reason: '' }
    await env.sleep(520)
    const silent = env.hook.voiceCard()
    env.assert('（关掉时）开麦结束但一个字都没说：卡片留着不退出', silent.open === true, JSON.stringify(silent))
    env.assert('此时不再显示「在听」（麦克风已经松开了）', silent.voiced === false, JSON.stringify(silent))
    // 恢复"正在录"：后面几步按原样继续
    env.micStub.value = {
      ok: true,
      available: true,
      capturing: true,
      processes: [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }],
      reason: '',
    }
    await env.sleep(520)

    // 说话：文字落进输入框（输入法上屏走的就是这条路）
    if (box) {
      box.value = '这是在推迟还是提前？'
      box.dispatch('input', { target: box, preventDefault() {}, stopPropagation() {} })
    }
    const filled = env.hook.voiceCard()
    env.assert('有字之后才摆出发送键', filled.hasText === true, JSON.stringify(filled))

    // 发送：跳过翻译与详解，直接进追问
    const beforeSend = env.hook.state()
    // 焦点探针：小窗自己的规则 —— **一轮输出结束（成功或失败）后**把光标交回输入框。
    // 注意这不是"从临时卡进小窗"的特例：划词解读、打开历史都走同一条规则。
    let askFocused = 0
    const realAskFocus = env.askBox.focus
    env.askBox.focus = () => {
      askFocused += 1
    }
    // 交接动画（方案二「缩放长出」）的观测点：必须在点发送**之前**挂上 ——
    // 插件会在 showPanel 里连续写两次 style.transform（先摆起点、再设 none），
    // 桩 DOM 没有布局，量不出真实矩形，但"起点是不是把面板压到卡片那一格"可以从写入值上直接验。
    const panelEl = find('dsh-sel-panel')
    const growWrites = []
    let panelTransformNow = panelEl.style.transform
    Object.defineProperty(panelEl.style, 'transform', {
      configurable: true,
      get: () => panelTransformNow,
      set: (value) => { growWrites.push(value); panelTransformNow = value },
    })
    // 发送那一刻焦点确实在卡片输入框里（真实状态）——正是它让"开窗聚焦"那次让了路
    env.documentStub.activeElement = box
    if (sendBtn) sendBtn.dispatch('click', { target: sendBtn, preventDefault() {}, stopPropagation() {} })
    await env.sleep(80)
    const afterSend = env.hook.state()
    env.assert('发送后卡片收起', env.hook.voiceCard().open === false, JSON.stringify(env.hook.voiceCard()))
    // 卡片矩形是桩给的 940,222,360×42；面板是通用矩形 40,100,460×300
    //   → 起点 translate(900,122) scale(360/460, 42/300)
    const growStart = 'translate(900.0px,122.0px) scale(0.7826,0.1400)'
    env.assert(
      '交接起点：把面板压到卡片那一格（translate + scale，原点左上），终点回到 none',
      growWrites.indexOf(growStart) >= 0 &&
        growWrites.indexOf(growStart) === growWrites.length - 2 &&
        growWrites[growWrites.length - 1] === 'none' &&
        panelEl.style.transformOrigin === '0 0',
      JSON.stringify({ writes: growWrites, origin: panelEl.style.transformOrigin }),
    )
    env.assert(
      '交接只动 transform，260ms 同一族曲线（不动 width/left/top —— 那是布局属性，会掉帧）',
      String(panelEl.style.transition) === 'transform 260ms cubic-bezier(.2,.8,.2,1)',
      String(panelEl.style.transition),
    )

    // 卡片隐藏后浏览器会把焦点收回 body —— 桩里不会（它不模拟"隐藏即失焦"），
    // 所以这里持续保持这个**忠实状态**：否则焦点会一直挂在已隐藏的卡片输入框上，
    // 后面的礼貌守卫就会误判成"人家正在别处打字"（实测就是这么卡的）。
    for (let i = 0; i < 60 && env.hook.state().phase !== 'done'; i += 1) {
      env.documentStub.activeElement = env.body
      await env.sleep(60)
    }
    env.assert('（前提）这一轮输出已经结束', env.hook.state().phase === 'done', String(env.hook.state().phase))
    // 别再往 body 上还原了：聚焦是在这一轮结束那一刻发生的，紧接着断言才对得上
    //（之前循环退出后还还原一次，把自己刚要验的焦点冲掉了 —— 实测就是这么红的）
    await env.sleep(260)
    env.assert(
      '小窗规则：一轮输出结束后，光标自动回到小窗输入框（可以直接继续追问）',
      // 只断言"规则触发了"：桩里的 activeElement 会被好几个角色来回改（临时卡片的输入框也在抢），
      // 断言它等于 askBox 会很脆、也未必反映真实浏览器。真正的插入符在无头 Chrome 里画不出来
      // （无头不渲染 caret），所以这一层只能验到"规则执行了"，插入符靠真机确认。
      askFocused > 0,
      'focus 次数=' + String(askFocused) + ' 卡在=' + String(env.hook.focusBail()),
    )
    env.askBox.focus = realAskFocus
    // 还原焦点：不还原的话它会一直停在别处，后面用例开卡片会被"别处正在打字"那条守卫挡掉
    env.documentStub.activeElement = env.body
    // 交接动画必须**自己收尾**：把内联的 transform / transition / transformOrigin 清干净。
    // 留着的话下一次开窗量几何会量到半截 transform（拖拽改大小、设置抽屉都会跟着歪）。
    await env.sleep(460) // 260ms 动画 + 140ms 兜底（桩里没有 transitionend，走的就是兜底那条）
    env.assert(
      '交接收尾：内联 transform / transition / transformOrigin 全部清掉',
      !panelEl.style.transform && !panelEl.style.transition && !panelEl.style.transformOrigin,
      JSON.stringify({ tf: panelEl.style.transform, tr: panelEl.style.transition, og: panelEl.style.transformOrigin }),
    )

    // 追问失败也要把光标交回输入框 —— 这条路原来漏了规则（用户实测："报错之后输入框没有光标"）
    {
      let focusAfterAskError = 0
      const realAskFocus2 = env.askBox.focus
      env.askBox.focus = () => {
        focusAfterAskError += 1
      }
      globalThis.__askFailOnce = true
      const sentBeforeAsk = env.sent.length
      env.hook.ask('这条追问会失败')
      await env.sleep(200)
      // 追问的问答在 chat log 里（不在翻译正文 panelBody 里），所以整个面板一起找
      for (let i = 0; i < 50 && !!globalThis.__askFailOnce; i += 1) await env.sleep(60)
      // 前置条件用**可证明的事实**：请求发出去了、而且被桩的失败注入接走了。
      //（不查"面板里有没有『追问失败』这行字"：桩里那行渲染文本用 textOf 够不到，
      //  查它会得到一个恒假的断言 —— 那是测试环境的事，不是产品行为。）
      env.assert(
        '（前提）追问请求发了，且这次被桩按失败处理',
        env.sent.length - sentBeforeAsk > 0 && !globalThis.__askFailOnce,
        '请求数=' + String(env.sent.length - sentBeforeAsk) + ' 失败注入已消费=' + String(!globalThis.__askFailOnce),
      )
      env.assert(
        '追问失败后，光标也回到小窗输入框（这条路原来漏了"一轮结束就交回光标"的规则）',
        focusAfterAskError > 0,
        'focus 次数=' + String(focusAfterAskError),
      )
      env.askBox.focus = realAskFocus2
      env.documentStub.activeElement = env.body
    }
    env.assert('跳过解读：翻译一节是空的（没请求 /analyze）', !afterSend.translation, JSON.stringify(beforeSend) + ' → ' + JSON.stringify(afterSend))
    env.assert('直接进了追问：面板开着', env.panel.style.display !== 'none', String(env.panel.style.display))

    // Esc 收卡片（还没发出去时）
    env.micStub.value = { ok: true, available: true, capturing: true, processes: [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }], reason: '' }
    env.hook.close()
    await env.sleep(20)
    env.documentStub.dispatch('mouseup', { target: env.body })
    await env.sleep(250)
    const reopened = env.hook.voiceCard()
    if (reopened.open) {
      env.documentStub.dispatch('keydown', { key: 'Escape', target: env.body, preventDefault() {}, stopPropagation() {} })
      await env.sleep(20)
      env.assert('Esc 收起语音卡', env.hook.voiceCard().open === false, JSON.stringify(env.hook.voiceCard()))
      // 取消后**不还回**「✦ 解读」浮标（用户要求：取消就是取消，别再冒出来问"要不要解读"）
      env.assert(
        '取消后不还回「✦ 解读」浮标',
        env.button.style.display === 'none',
        '浮标 display=' + String(env.button.style.display),
      )
      // 取消时播"老式电视机关机"（A 方案）：卡片先留在画面上塌缩，动画结束才真正隐藏
      const closingState = env.hook.voiceCard()
      const cardEl = find('dsh-sel-vcard')
      const crtLine = find('dsh-sel-crtline')
      env.assert('取消时先播关机动画（卡片还在画面上）', closingState.closing === true, JSON.stringify(closingState))
      env.assert(
        '关机动画挂在卡片上（data-off=a）',
        !!cardEl && cardEl.getAttribute('data-off') === 'a',
        cardEl ? String(cardEl.getAttribute('data-off')) : 'no card',
      )
      env.assert(
        '亮线拆成 5 段 + 2 个火花，宽度跟着卡片、颜色按明暗给',
        !!crtLine &&
          crtLine.style.width === '360px' &&
          !!crtLine.style.color &&
          !!crtLine.children &&
          crtLine.children.length === 7,
        crtLine
          ? crtLine.style.width + ' / ' + String(crtLine.style.color) + ' / 子元素 ' + String(crtLine.children.length)
          : 'no line',
      )
      // 桩环境没有 animationend，走 640ms 兜底
      await env.sleep(780)
      const closed = env.hook.voiceCard()
      env.assert(
        '关机动画结束后卡片才真正隐藏',
        closed.closing === false && !!cardEl && cardEl.style.display === 'none' && !cardEl.getAttribute('data-off'),
        JSON.stringify(closed) + ' / display=' + (cardEl ? String(cardEl.style.display) : '?'),
      )
      env.assert('亮线也一并收掉', !!crtLine && !crtLine.getAttribute('data-off'), crtLine ? String(crtLine.getAttribute('data-off')) : 'no line')
      env.assert(
        '卡片收起后选中提示一并清掉',
        !find('dsh-sel-uline') && !!thread && thread.style.display === 'none',
        '下划线=' + String(!!find('dsh-sel-uline')) + ' 牵引线 display=' + (thread ? String(thread.style.display) : '?'),
      )
    } else {
      env.assert('Esc 收起语音卡', false, '卡片没能再次打开：' + JSON.stringify(reopened))
    }

    // ── 两个语音收尾开关（设置页「界面 · 语音输入」，**默认都开**）──
    // 关掉时的行为（"卡片留着"）上面已经验过；这里验打开后的两条收尾。
    // 关键：松手**不是**决定时刻 —— 输入法在松手后还会做一次智能整理（改写输入框内容），
    // 所以两个动作都要等文字定稿（连续 VOICE_SETTLE_MS=500ms 没变化）才发生。
    {
      const IME = [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }]
      const recording = { ok: true, available: true, capturing: true, processes: IME, reason: '' }
      const stopped = { ok: true, available: true, capturing: false, processes: [], reason: '' }

      // ① 「空录音时收起」：松手后不立刻收，等定稿才收（而且走取消路径）
      env.settingsStub.value = { voiceCancelOnSilence: true, voiceAutoSend: false }
      env.hook.reloadSettings()
      await env.sleep(320)
      env.hook.close()
      env.micStub.value = recording
      await env.sleep(420)
      env.hook.voiceCardOpen()
      if (box) {
        box.value = ''
        box.dispatch('input', { target: box, preventDefault() {}, stopPropagation() {} })
      }
      await env.sleep(80)
      env.micStub.value = stopped
      await env.sleep(300)
      env.assert(
        '松手后**不会立刻**取消（要等文字定稿：输入法松手后还会智能整理）',
        env.hook.voiceCard().open === true,
        JSON.stringify(env.hook.voiceCard()),
      )
      // 开着「空录音时收起」时，这段"等定稿"的窗口里框里显示「正在关闭…」：
      // 卡片马上要被收掉，写"直接打字也行…"是句假话（用户明确要求取消时不要显示任何文字）
      env.assert(
        '（开着「空录音时收起」）空框里如实显示「正在关闭…」（不是"直接打字也行…"那种假邀请）',
        !!box && String(box.placeholder) === '正在关闭…' && String(box.value) === '',
        JSON.stringify({ placeholder: box ? String(box.placeholder) : '(无卡片)', value: box ? String(box.value) : '' }),
      )
      await env.sleep(900)
      const cardSilent = find('dsh-sel-vcard')
      env.assert('定稿后才取消（空录音）', env.hook.voiceCard().open === false, JSON.stringify(env.hook.voiceCard()))
      env.assert(
        '空录音收起走的是**取消**路径（关机动画 data-off=a，不是无声消失）',
        !!cardSilent && cardSilent.getAttribute('data-off') === 'a',
        cardSilent ? String(cardSilent.getAttribute('data-off')) : 'no card',
      )

      // ② 「说完直接发送」：松手后等定稿才发；期间模拟豆包的智能整理改写输入框
      env.settingsStub.value = { voiceCancelOnSilence: false, voiceAutoSend: true }
      env.hook.reloadSettings()
      await env.sleep(320)
      await env.sleep(800) // 等上一条关机动画彻底收尾
      env.hook.close()
      await env.sleep(20)
      env.micStub.value = recording
      await env.sleep(420)
      env.hook.voiceCardOpen()
      if (box) {
        box.value = '这是 在推迟 还是提前' // 整理之前：有空格、没标点
        box.dispatch('input', { target: box, preventDefault() {}, stopPropagation() {} })
      }
      await env.sleep(80)
      const sentBefore = env.sent.length
      env.micStub.value = stopped
      await env.sleep(300)
      env.assert(
        '松手后**不会立刻**发送（要等文字定稿）',
        env.hook.voiceCard().open === true && env.sent.length === sentBefore,
        JSON.stringify(env.hook.voiceCard()) + ' / sent=' + String(env.sent.length - sentBefore),
      )
      // 模拟智能整理：松手之后才改写输入框，而且是**直接改 value、不派发 input**（真实情况就是这样）
      const cleaned = '这是在推迟还是提前，release notes 要不要一起改。'
      if (box) box.value = cleaned
      await env.sleep(300)
      env.assert(
        '整理过程中仍然不发（每改一次就重新计时）',
        env.hook.voiceCard().open === true && env.sent.length === sentBefore,
        JSON.stringify(env.hook.voiceCard()) + ' / sent=' + String(env.sent.length - sentBefore),
      )
      // 主信号：输入法的智能整理**走合成 API 提交**（实测 8 次录音里 6 次都有）
      if (box) box.dispatch('compositionend', { data: cleaned })
      await env.sleep(260)
      env.assert(
        '收到 compositionend 后**短窗口内**就决定（260ms 就发了 —— 兜底的 700ms 静默还没到）',
        env.hook.voiceCard().open === false,
        JSON.stringify(env.hook.voiceCard()),
      )
      env.assert(
        '发出去的是**整理之后**的文字（不是松手那一刻的草稿）',
        // 问题在 question 字段（text 是选中的原文）
        env.sent.slice(sentBefore).some((b) => b && (b.question === cleaned || b.text === cleaned)),
        JSON.stringify(env.sent.slice(sentBefore).map((b) => b && b.question)),
      )

      // ③ 出厂默认就是开：桩里**不写这两个键**时，空录音同样等定稿后收起。
      // 这一条挡住"设置还没加载完 / 读失败就退回关"的回归 —— 那会和 host 侧 Config 的缺省值不一致。
      env.settingsStub.value = {}
      env.hook.reloadSettings()
      await env.sleep(320)
      await env.sleep(800) // 等上一条发送彻底收尾
      env.hook.close()
      await env.sleep(20)
      env.micStub.value = recording
      await env.sleep(420)
      env.hook.voiceCardOpen()
      if (box) {
        box.value = ''
        box.dispatch('input', { target: box, preventDefault() {}, stopPropagation() {} })
      }
      await env.sleep(80)
      env.micStub.value = stopped
      await env.sleep(900)
      env.assert(
        '默认（桩里不写这两个键）也是开：空录音照样等定稿后收起',
        env.hook.voiceCard().open === false,
        JSON.stringify(env.hook.voiceCard()),
      )

      // 关掉「空录音时收起」（卡会留着）→ 才给"直接打字也行…"那句邀请
      env.settingsStub.value = { voiceCancelOnSilence: false, voiceAutoSend: false }
      env.hook.reloadSettings()
      await env.sleep(320)
      env.hook.close()
      await env.sleep(20)
      env.micStub.value = recording
      // 走真实路径把卡开出来（与上面几段同一套：选区还在 → mouseup → 浮标 → 这一拍轮询发现开麦）
      env.documentStub.dispatch('mouseup', { target: env.body })
      await env.sleep(320)
      if (box) {
        box.value = ''
        box.dispatch('input', { target: box, preventDefault() {}, stopPropagation() {} })
      }
      await env.sleep(80)
      env.micStub.value = stopped
      await env.sleep(400)
      env.assert(
        '（关掉「空录音时收起」）卡片要留着，这时才显示"直接打字也行…"',
        env.hook.voiceCard().open === true && !!box && String(box.placeholder).indexOf('直接打字') >= 0,
        JSON.stringify({ open: env.hook.voiceCard().open, placeholder: box ? String(box.placeholder) : '(无)' }),
      )
      // Esc 取消：那一瞬间空框里就该是空的（不留占位）
      env.documentStub.dispatch('keydown', { key: 'Escape', target: env.body, preventDefault() {}, stopPropagation() {} })
      await env.sleep(20)
      env.assert(
        'Esc 取消录音：那一刻空框就换成「正在关闭…」（不等动画结束）',
        !!box && String(box.placeholder) === '正在关闭…' && String(box.value) === '',
        JSON.stringify({ placeholder: box ? String(box.placeholder) : '(无)', value: box ? String(box.value) : '' }),
      )
      await env.sleep(800) // 等关机动画收尾

      // 收尾：设置清回默认，别影响后面的用例
      env.settingsStub.value = {}
      env.hook.reloadSettings()
      await env.sleep(300)
    }

    // ── ⑨ 小窗开着时开麦 = 点一下「❝ 引用」（2026-10-09 定的行为）──
    //   ① 只在引用浮标亮着时才问麦克风；② 开麦 → 引用挂进来 + 光标进小窗输入框；
    //   ③ **不弹语音卡**（卡片是"面板没开、字没处落"的产物）；④ 同一次录音只处理一次；
    //   ⑤ 别处正在打字 → 不加引用、也不抢焦点。
    {
      const recording2 = {
        ok: true,
        available: true,
        capturing: true,
        processes: [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }],
        reason: '',
      }
      const stopped2 = { ok: true, available: true, capturing: false, processes: [], reason: '' }
      // 选区桩本段自带：上面两族的 selectText / selectOn 都是块内作用域，这里够不着。
      // textEl 是模块级的（划词那一段就在用它），所以直接搭在它上面。
      const quoteRect9 = { left: 40, top: 620, right: 320, bottom: 640, width: 280, height: 20 }
      const selectDoc = (text) => {
        const range = {
          startContainer: env.textEl,
          endContainer: env.textEl,
          cloneRange: () => range,
          getClientRects: () => [quoteRect9],
          getBoundingClientRect: () => quoteRect9,
        }
        env.windowStub.getSelection = () => ({
          isCollapsed: false,
          rangeCount: 1,
          toString: () => text,
          getRangeAt: () => range,
        })
      }
      const priorSelection = env.windowStub.getSelection
      env.micStub.value = stopped2
      env.hook.close()
      await env.sleep(40)
      env.hook.open('voice-quote-probe', '开麦引用的上下文片段', '开麦引用')
      for (let i = 0; i < 120 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
      env.assert('（前提）开麦引用用例的首轮出完', env.hook.state().phase === 'done', env.hook.state().phase)
      env.assert('（前提）引用区是空的', env.hook.quotes().length === 0, JSON.stringify(env.hook.quotes().map((q) => q.text)))

      const focusHits = { count: 0 }
      const realAskFocus3 = env.askBox.focus
      env.askBox.focus = () => {
        focusHits.count += 1
      }

      // ① 没有引用浮标 → 不问麦克风（探针只在被问时活着）
      const hitsIdle = env.micStub.hits
      await env.sleep(520)
      env.assert('没有引用浮标时**不**轮询麦克风（省掉常驻探针）', env.micStub.hits === hitsIdle, `${hitsIdle} → ${env.micStub.hits}`)

      // ② 浮标亮着 → 开始问
      selectDoc('这半句是要被引用的')
      env.documentStub.dispatch('mouseup', { target: env.textEl })
      await env.sleep(30)
      env.assert('（前提）引用浮标亮着', env.hook.quoteState().visible === true, JSON.stringify(env.hook.quoteState()))
      const hitsFloat = env.micStub.hits
      await env.sleep(520)
      env.assert('引用浮标亮着时才问麦克风', env.micStub.hits > hitsFloat, `${hitsFloat} → ${env.micStub.hits}`)

      // ③ 开麦 → 引用挂进来 + 光标进小窗输入框 + 不弹语音卡
      env.micStub.value = recording2
      await env.sleep(320)
      const autoQuotes = env.hook.quotes()
      env.assert(
        '开麦 → 选中的那段自动挂进引用（= 点一下引用浮标）',
        autoQuotes.length === 1 && autoQuotes[0].text === '这半句是要被引用的' && autoQuotes[0].label === '主界面选中',
        JSON.stringify(autoQuotes),
      )
      env.assert('开麦 → 引用浮标自己收了（"已经进去了"的信号）', env.hook.quoteState().visible === false, JSON.stringify(env.hook.quoteState()))
      env.assert('开麦 → 光标进了小窗输入框（输入法上屏的字落在这儿）', focusHits.count > 0, 'focus 次数=' + focusHits.count)
      env.assert('开麦 → **不**弹语音卡（面板开着时字直接落进小窗）', env.hook.voiceCard().open === false, JSON.stringify(env.hook.voiceCard()))
      env.assert('开麦 → 状态里交代了这次引用', /已加入引用/.test(String(env.hook.state().status)), String(env.hook.state().status))

      // ④ 同一次录音里只处理一次（200ms 一拍，不抑制会反复加 / 反复抢焦点）
      const focusAfterAuto = focusHits.count
      await env.sleep(340)
      env.assert(
        '同一次录音只处理一次（不反复加引用、不反复抢焦点）',
        env.hook.quotes().length === 1 && focusHits.count === focusAfterAuto,
        `引用=${env.hook.quotes().length} focus=${focusAfterAuto}→${focusHits.count}`,
      )

      // ⑤ 别处正在打字 → 不抢（守卫与语音卡那条完全一致）
      env.micStub.value = stopped2
      await env.sleep(320) // 这一轮结束：抑制复位
      const otherBox = env.documentStub.createElement('textarea')
      env.documentStub.activeElement = otherBox
      selectDoc('别处打字时不该被抢')
      env.documentStub.dispatch('mouseup', { target: env.textEl })
      await env.sleep(30)
      env.assert('（前提）浮标又亮了', env.hook.quoteState().visible === true, JSON.stringify(env.hook.quoteState()))
      const focusBeforeGuard = focusHits.count
      env.micStub.value = recording2
      await env.sleep(320)
      env.assert('别处正在打字：不加引用', env.hook.quotes().length === 1, JSON.stringify(env.hook.quotes().map((q) => q.text)))
      env.assert(
        '别处正在打字：不抢焦点（人家的听写不能被拽进小窗）',
        focusHits.count === focusBeforeGuard,
        `focus=${focusBeforeGuard}→${focusHits.count}`,
      )

      // ⑥ 自动引用**做过一次之后**，机制还得活着（不能因为抑制标记没复位就"下次不响应了"）
      //    这一步专门挡那条回归：交接后浮标收起 → 轮询停 → 若复位只挂在"轮到没在录"那一拍上，
      //    标记会一直 true，下一次开麦什么都不发生（实测就是这么静默失效的）。
      env.micStub.value = stopped2
      env.documentStub.activeElement = env.body
      selectDoc('第二次开麦也要能自动引用')
      env.documentStub.dispatch('mouseup', { target: env.textEl })
      await env.sleep(30)
      env.assert('（前提）浮标第三次亮起', env.hook.quoteState().visible === true, JSON.stringify(env.hook.quoteState()))
      const focusBeforeSecond = focusHits.count
      env.micStub.value = recording2
      await env.sleep(340)
      const second = env.hook.quotes()
      env.assert(
        '上一次自动引用之后，下一次开麦照样生效（抑制标记跟着轮询复位）',
        second.length === 2 && second[1].text === '第二次开麦也要能自动引用' && focusHits.count > focusBeforeSecond,
        JSON.stringify({ quotes: second.map((q) => q.text), focus: `${focusBeforeSecond}→${focusHits.count}` }),
      )

      // ⑦ **一口气说不停**时换一段引用也要能生效：麦克风一直没松（探针一直报"在录"），
      //    这时若"这次录音处理过没有"的标记只在"轮到没在录"那一拍才复位，就永远没机会复位 ——
      //    下一次划词纵有浮标也毫无反应。这条用例专门盯那个死锁（撤掉 stopMicWatch 里的复位就会红）。
      // ⚠️ 这里**不能**断言"浮标亮着"：麦克风本来就开着，浮标一亮就会被这一拍立刻收走
      //    （动作比断言快 —— 实测就是"前提"红、主断言绿）。直接看结果。
      const hitsBeforeThird = env.micStub.hits
      selectDoc('一直说不停时换的这段引用')
      env.documentStub.dispatch('mouseup', { target: env.textEl })
      await env.sleep(360)
      env.assert('（前提）换选区后轮询确实又跑起来了', env.micStub.hits > hitsBeforeThird, `${hitsBeforeThird} → ${env.micStub.hits}`)
      const third = env.hook.quotes()
      env.assert(
        '麦克风一直没松、这时换一段引用：照样自动挂进来（不靠"没在录"那一拍复位）',
        third.length === 3 && third[2].text === '一直说不停时换的这段引用',
        JSON.stringify({ quotes: third.map((q) => q.text), mic: env.micStub.value.capturing }),
      )

      // 收尾：焦点 / 麦克风 / 选区 / 面板都还原，别影响后面的用例
      env.askBox.focus = realAskFocus3
      env.micStub.value = stopped2
      env.documentStub.activeElement = env.body
      env.windowStub.getSelection = priorSelection
      env.hook.close()
      await env.sleep(40)
    }

    // ── ⑩ 侧边栏网页里的选区也能弹卡（不透明源 iframe：父页面**没有**那段 Range）──
    //   撤掉修复就会红的地方：
    //     ① `openVCard` 原来第一句就是 `!state.selection.range → return`，帧内选区永远弹不出卡；
    //     ② 几何原来只认 Range，桥给的锚点矩形用不上；
    //     ③ 卡片一抢焦点，帧内选区就塌（输入法上屏要的正是焦点）→ 桥报 clear；
    //        若照旧清掉 state.selection，"发送"和"说完了没有"两条都会断（轮询也会停）；
    //     ④ 发送时不能读顶层 DOM（读不到那个帧），要用桥采好的上下文；
    //     ⑤ 帧内按下（父页面收不到那个 mousedown）也要收卡。
    {
      const priorQuerySelectorAll = env.documentStub.querySelectorAll
      const frame = new env.FakeEl('iframe')
      frame.setAttribute('data-html-preview', 'true')
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('srcdoc', '<!doctype html><html><body><p>网页里的正文</p></body></html>')
      frame.isConnected = true
      const frameWindow = { name: 'voice-card-sidebar-frame' }
      frame.contentWindow = frameWindow
      env.documentStub.querySelectorAll = (selector) => (selector === 'iframe' ? [frame] : [])
      env.hook.bridgeScan()
      env.assert('（前提）这一帧被桥上（不然下面那条消息不会被认）', frame.getAttribute('data-dsh-sel-bridged') === '1', String(frame.getAttribute('data-dsh-sel-bridged')))

      const IME3 = [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }]
      const recording3 = { ok: true, available: true, capturing: true, processes: IME3, reason: '' }
      const stopped3 = { ok: true, available: true, capturing: false, processes: [], reason: '' }
      env.hook.close()
      await env.sleep(20)
      env.documentStub.activeElement = env.body
      env.micStub.value = recording3
      env.windowStub.dispatch('message', {
        source: frameWindow,
        data: {
          __dshSel: 1,
          kind: 'selection',
          sel: {
            text: '网页里选中的这段',
            context: '前文【网页里选中的这段】后文',
            keyContext: '前文',
            label: '',
            // 帧内坐标（帧自己的 getBoundingClientRect 是桩的 40/100）→ 视口 50/120..160/138
            rect: { x: 10, y: 20, right: 120, bottom: 38, w: 110, h: 18 },
          },
        },
      })
      env.assert('（前提）浮标出现在网页选区处', env.button.style.display === 'inline-flex', String(env.button.style.display))
      await env.sleep(300)
      const frameCard = env.hook.voiceCard()
      env.assert('侧边栏网页里的选区也能弹卡（不再被 range 守卫挡掉）', frameCard.open === true, JSON.stringify(frameCard))
      env.assert(
        '卡片按桥给的锚点矩形定位（帧偏移 40/100 + 帧内坐标 → 左 8 / 上 160）',
        !!frameCard.geometry && frameCard.geometry.left === '8px' && frameCard.geometry.top === '160px',
        JSON.stringify(frameCard.geometry),
      )
      // 帧内那条：逐行矩形拿不到（父页面碰不到那个 Range），所以**只画牵引线、不画下划线** ——
      // 画下划线会与帧内可能还在的原生底纹"划两层"。
      const frameThread = find('dsh-sel-thread')
      const framePath = find('dsh-sel-threadpath')
      env.assert('帧内选区不画下划线（那需要逐行矩形，而且有"划两层"的风险）', !find('dsh-sel-uline'), String(!!find('dsh-sel-uline')))
      env.assert(
        '但牵引线留着：从锚点矩形竖直指向卡片（M105 140 = 选区末行中点）',
        !!frameThread && frameThread.style.display === 'block' && !!framePath && String(framePath.getAttribute('d')).indexOf('M105 140') === 0,
        framePath ? String(framePath.getAttribute('d')).slice(0, 40) : 'no path',
      )

      // 抢焦点 → 帧内选区塌掉 → 桥报 clear：**卡片开着时不能清选区**
      env.windowStub.dispatch('message', { source: frameWindow, data: { __dshSel: 1, kind: 'clear' } })
      env.assert(
        '卡片开着时帧内报 clear：卡片不关、选区不清（发送与轮询都还要用）',
        env.hook.voiceCard().open === true && env.hook.selection() !== null,
        JSON.stringify({ card: env.hook.voiceCard().open, sel: env.hook.selection() }),
      )
      env.assert('麦克风轮询还在（靠它判断"说完了没有"）', env.hook.voiceCard().watching === true, JSON.stringify(env.hook.voiceCard()))

      // 帧内重报（滚动 / 挪选区）：跟着挪卡片，不要又冒出浮标
      env.windowStub.dispatch('message', {
        source: frameWindow,
        data: { __dshSel: 1, kind: 'selection', sel: { text: '网页里选中的这段', context: '前文【网页里选中的这段】后文', keyContext: '前文', label: '', rect: { x: 10, y: 60, right: 120, bottom: 78, w: 110, h: 18 } } },
      })
      const moved = env.hook.voiceCard()
      env.assert(
        '帧内重报：卡片跟着挪（锚点 120→160 → top 160→200），浮标不冒出来',
        moved.open === true && !!moved.geometry && moved.geometry.top === '200px' && env.button.style.display === 'none',
        JSON.stringify({ top: moved.geometry && moved.geometry.top, pill: env.button.style.display }),
      )

      // 说话 → 发送：上下文用桥采好的那份
      if (box) {
        box.value = '这段在说什么？'
        box.dispatch('input', { target: box, preventDefault() {}, stopPropagation() {} })
      }
      env.hook.voiceCardSend()
      await env.sleep(60)
      const framePayload = env.hook.payload()
      env.assert(
        '发送后用桥采好的上下文（顶层 DOM 里根本没有这段文字）',
        !!framePayload && framePayload.context === '前文【网页里选中的这段】后文',
        framePayload && framePayload.context,
      )
      env.assert(
        '发送后卡片收起、面板开着',
        env.hook.voiceCard().open === false && env.panel.style.display !== 'none',
        JSON.stringify({ card: env.hook.voiceCard().open, panel: env.panel.style.display }),
      )

      // 帧内按一下 = 收卡（父页面收不到那个 mousedown，只能靠桥的 press）
      env.hook.close()
      await env.sleep(20)
      env.windowStub.dispatch('message', {
        source: frameWindow,
        data: { __dshSel: 1, kind: 'selection', sel: { text: '第二段网页文字', context: '【第二段网页文字】', keyContext: '', label: '', rect: { x: 10, y: 20, right: 120, bottom: 38, w: 110, h: 18 } } },
      })
      await env.sleep(300)
      env.assert('（前提）卡片又弹出来了', env.hook.voiceCard().open === true, JSON.stringify(env.hook.voiceCard()))
      env.windowStub.dispatch('message', { source: frameWindow, data: { __dshSel: 1, kind: 'press' } })
      const afterPress = env.hook.voiceCard()
      env.assert('帧内按下：卡片收掉（并播关机动画）', afterPress.open === false && afterPress.closing === true, JSON.stringify(afterPress))
      await env.sleep(800) // 桩里没有 animationend，走 640ms 兜底

      // 收尾：选区清掉、帧从扫描里摘掉、麦克风复位
      env.windowStub.dispatch('message', { source: frameWindow, data: { __dshSel: 1, kind: 'clear' } })
      env.assert('卡片收起后帧内的 clear 照旧生效（选区状态收干净）', env.hook.selection() === null, JSON.stringify(env.hook.selection()))
      frame.isConnected = false
      env.micStub.value = stopped3
      env.documentStub.activeElement = env.body
      env.documentStub.querySelectorAll = priorQuerySelectorAll
      env.hook.close()
      await env.sleep(40)
    }

    env.micStub.value = { ok: true, available: false, capturing: false, processes: [], reason: 'stub-default' }
    env.hook.close()
    await env.sleep(20)
  }
}
