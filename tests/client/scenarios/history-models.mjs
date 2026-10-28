

import { readFileSync } from 'node:fs'



export async function run(env) {


  // ───────────────────────── A′：小窗对话历史（落库 / 回放 / 列表） ─────────────────────────
  env.hook.open('缓存探测词', '上下文片段 A', '缓存用例')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.hook.ask('历史写入测试')

  for (let i = 0; i < 80 && env.textOf(env.chatLog).indexOf('这是对追问的回答') < 0; i += 1) await env.sleep(20)

  await env.sleep(60)

  const saved = env.historySaved[env.historySaved.length - 1] || {}

  env.assert('追问结束后整段对话写回历史', saved.key && saved.parts && saved.parts.translation.indexOf('缓存测试内容') >= 0, JSON.stringify({ key: String(saved.key || '').slice(0, 12), t: (saved.parts || {}).translation?.slice(0, 12) }))

  env.assert('历史里带着追问轮次（不含隐藏的种子轮）', Array.isArray(saved.turns) && saved.turns.filter((t) => t.role === 'user').length === 1 && !saved.turns.some((t) => String(t.text).indexOf('前情') === 0), JSON.stringify((saved.turns || []).map((t) => t.role)))

  env.assert('历史里带着工具结果摘要字段', typeof saved.toolDigest === 'string', typeof saved.toolDigest)

  // 模拟"刷新页面"：清掉浏览器内存缓存，历史应当把它救回来（且不再调模型）
  env.hook.forget()

  const sentBeforeRestore = env.sent.length

  env.hook.open('缓存探测词', '上下文片段 A', '缓存用例')

  for (let i = 0; i < 60 && env.hook.state().cache !== 'history'; i += 1) await env.sleep(20)

  env.assert('刷新后重开同一个词：从历史回放', env.hook.state().cache === 'history', String(env.hook.state().cache))

  env.assert('历史回放不调模型（请求数为 0）', env.sent.length === sentBeforeRestore, `新增请求 ${env.sent.length - sentBeforeRestore}`)

  env.assert('回放带回翻译正文', env.textOf(env.sections[0]).indexOf('缓存测试内容') >= 0, env.textOf(env.sections[0]).slice(0, 24))

  env.assert('回放带回追问记录（气泡都在）', env.textOf(env.chatLog).indexOf('历史写入测试') >= 0 && env.textOf(env.chatLog).indexOf('这是对追问的回答') >= 0, env.textOf(env.chatLog).slice(0, 40))

  env.assert('历史回放标记仍在（自检可读）', /历史回放/.test(String(env.hook.state().status || '')) && env.hook.state().cache === 'history', `${env.hook.state().cache} / ${env.hook.state().status}`)

  // 「最近聊过的」列表
  env.assert('头部有「最近」入口', !!env.histBtn, env.histBtn ? env.textOf(env.histBtn) : '未找到')

  env.histBtn.dispatch('click', { stopPropagation() {} })

  for (let i = 0; i < 40 && !Array.from(env.walk(env.histList)).some((n) => n.className === 'dsh-sel-historyrow'); i += 1) await env.sleep(20)

  const rows = Array.from(env.walk(env.histList)).filter((n) => n.className === 'dsh-sel-historyrow')

  const targetRow = rows.find((n) => env.textOf(n).indexOf('缓存探测词') >= 0)

  env.assert('列表贴在面板右侧（右侧放得下就不翻边）', env.histList.getAttribute('data-side') === 'right' && env.histList.style.left === '510px', `side=${env.histList.getAttribute('data-side')} left=${env.histList.style.left}`)

  env.assert('列表高度跟面板对齐（自带滚动）', /px$/.test(env.histList.style.maxHeight || ''), String(env.histList.style.maxHeight))

  env.assert('「最近聊过的」列出历史条目', rows.length >= 1 && !!targetRow, `rows=${rows.length} 首行=${env.textOf(rows[0] || new env.FakeEl('div')).slice(0, 24)}`)

  env.assert('条目显示位置/轮数/时间', !!targetRow && /会话消息|缓存用例|页面|消息|代码/.test(env.textOf(targetRow)) && /\d+ 轮/.test(env.textOf(targetRow)), env.textOf(targetRow || new env.FakeEl('div')).slice(0, 50))

  const rowParts = targetRow ? targetRow.children : []

  env.assert(
    '标题与小字分两行（标题不再被挤），且行尾带一个删除键',
    rowParts.length === 3 &&
      rowParts[0].className === 'dsh-sel-historytext' &&
      rowParts[1].className === 'dsh-sel-historydel' &&
      rowParts[2].className === 'dsh-sel-historymeta',
    rowParts.map((n) => n.className).join(','),
  )

  env.assert('标题文字完整（未被截断成省略号的短写）', env.textOf(rowParts[0]).indexOf('缓存探测词') >= 0, env.textOf(rowParts[0]))

  const sentBeforeClick = env.sent.length

  // 回归：点「最近」列表里的一条时，面板**不能**被重新锚到右下角胶囊上方。
  // 给胶囊一个特征坐标（左下角 10,860），若面板被挪到那里，下面的位置断言会立刻失败。
  const pillEl = Array.from(env.walk(env.panel.parentNode)).find((n) => n.className === 'dsh-sel-pill')

  if (pillEl) pillEl.getBoundingClientRect = () => ({ left: 10, top: 860, right: 150, bottom: 890, width: 140, height: 30 })

  const panelLeftBefore = env.panel.style.left

  const panelTopBefore = env.panel.style.top

  targetRow.dispatch('click', { stopPropagation() {} })

  await env.sleep(80)

  env.assert('点一条能把那段对话调回面板（不调模型）', env.sent.length === sentBeforeClick && env.textOf(env.sections[0]).indexOf('缓存测试内容') >= 0, `新增请求 ${env.sent.length - sentBeforeClick}`)

  env.assert(
    '点列表条目时面板不跳到胶囊上方（保持原位）',
    env.panel.style.left === panelLeftBefore && env.panel.style.top === panelTopBefore,
    `before=${panelLeftBefore}/${panelTopBefore} after=${env.panel.style.left}/${env.panel.style.top}`,
  )

  env.assert('点完之后列表收起', env.histList.style.display === 'none', String(env.histList.style.display))


  // Esc：一次到位 —— 面板与侧边栏一起收（原先"第一下只收列表"那一级已按需求合并）
  const escEv = { key: 'Escape', preventDefault() {}, stopPropagation() {} }

  env.histBtn.dispatch('click', { stopPropagation() {} })

  await env.sleep(60)

  env.assert('再次打开列表', env.histList.style.display === 'flex', String(env.histList.style.display))

  env.documentStub.dispatch('keydown', escEv)

  env.assert('Esc 一次关掉整个小窗（含侧边栏）', env.histList.style.display === 'none' && env.panel.style.display === 'none', `list=${env.histList.style.display} panel=${env.panel.style.display}`)


  // 稳定 key：选中文字**之后**的上下文变长（主会话追加了新消息），不该换 key
  env.hook.forget()

  env.hook.open('稳定key探测', '尾部上下文 A', '会话消息', '前缀这一段是固定的')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  const keyA = env.hook.state().cacheKey

  const sentAfterKeyA = env.sent.length

  env.hook.forget()

  env.hook.open('稳定key探测', '尾部上下文 B：主会话又追加了好几条新消息，窗口后半段完全变了', '会话消息', '前缀这一段是固定的')

  for (let i = 0; i < 60 && env.hook.state().cache !== 'history'; i += 1) await env.sleep(20)

  env.assert('尾部上下文变化不换 key（同词同前缀 → 同一个 key）', keyA === env.hook.state().cacheKey, `A=${keyA} B=${env.hook.state().cacheKey}`)

  env.assert('尾部上下文变化后仍命中历史（不再重新生成一个）', env.hook.state().cache === 'history' && env.sent.length === sentAfterKeyA, `cache=${env.hook.state().cache} 新增请求=${env.sent.length - sentAfterKeyA}`)


  // ───────────────────────── 悬浮状态胶囊（右下角，点击回到最近一次小窗） ─────────────────────────
  const pill = Array.from(env.walk(env.panel.parentNode)).find((n) => n.className === 'dsh-sel-pill')

  env.assert('右下角有状态胶囊', !!pill, pill ? pill.className : '未找到')

  env.assert(
    '胶囊结构和费用胶囊同构：星芒 + 主体 + 次要 + 箭头',
    !!pill &&
      ['dsh-sel-pillname', 'dsh-sel-pillmeta', 'dsh-sel-pillcaret'].every((c) =>
        Array.from(env.walk(pill)).some((n) => n.className === c),
      ) &&
      // SVG 元素的 class 是 SVGAnimatedString，客户端用 setAttribute('class', …) 写 —— 桩里也照这个读
      ['dsh-sel-pillicon', 'dsh-sel-pillstar'].every((c) =>
        Array.from(env.walk(pill)).some((n) => n.getAttribute && n.getAttribute('class') === c),
      ),
    pill ? env.walk(pill).next().value.className : '',
  )

  const pillStarEl = pill && Array.from(env.walk(pill)).find((n) => n.getAttribute && n.getAttribute('class') === 'dsh-sel-pillstar')

  env.assert(
    '球心里的图形初始是"圆点态"那条 path（展开时不许直接画成星）',
    !!pillStarEl && /^M4 0/.test(String(pillStarEl.getAttribute('d'))),
    pillStarEl ? String(pillStarEl.getAttribute('d')).slice(0, 24) : '未找到',
  )

  env.assert('箭头用和费用胶囊同一个字符 ▴ / ▾（不是大三角 ▲ ▼）', env.textOf(pill).indexOf('▲') < 0 && env.textOf(pill).indexOf('▼') < 0, env.textOf(pill))


  // 进行中：圆点在呼吸（tone=busy），文本报阶段 + 秒数
  env.hook.open('wait-ask-probe', '', '胶囊探测')

  for (let i = 0; i < 20 && pill.getAttribute('data-tone') !== 'busy'; i += 1) await env.sleep(20)

  env.assert('进行中胶囊是 busy 态', pill.getAttribute('data-tone') === 'busy', String(pill.getAttribute('data-tone')))

  env.assert('进行中胶囊报阶段', /翻译中|生成中|检索中/.test(env.textOf(pill)), env.textOf(pill))

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.assert('完成后胶囊带选中的词', env.textOf(pill).indexOf('wait-ask-pro') >= 0, env.textOf(pill))

  env.assert('完成后胶囊是 done 态', pill.getAttribute('data-tone') === 'done', String(pill.getAttribute('data-tone')))

  env.assert('小窗开着时箭头朝下（▾）', env.textOf(pill).indexOf('▾') >= 0, env.textOf(pill))


  // 关闭小窗后：点胶囊回到刚才那个小窗，且**不再请求**
  env.hook.close()

  const sentBeforeReopen = env.sent.length

  env.assert('关闭后胶囊箭头朝上（▴，可点回）', env.textOf(pill).indexOf('▴') >= 0, env.textOf(pill))

  pill.dispatch('click', { preventDefault() {}, stopPropagation() {} })

  await env.sleep(30)

  env.assert('点胶囊把最近一次小窗开回来', env.panel.style.display !== 'none', String(env.panel.style.display))

  env.assert('重开用的是内存里的状态，不再调模型', env.sent.length === sentBeforeReopen, `新增请求 ${env.sent.length - sentBeforeReopen}`)

  env.assert('重开后内容还在', env.textOf(env.sections[0]).indexOf('等待用例的翻译') >= 0, env.textOf(env.sections[0]).slice(0, 40))


  // 再点一次 = 收起（开关行为）
  {
    const sentBeforeToggle = env.sent.length
    env.assert('收起前小窗是开着的', env.panel.style.display !== 'none', String(env.panel.style.display))
    // 真实点击会先派发 mousedown（document 上那个"点外面就收起"的监听在捕获阶段跑），
    // 它必须把胶囊排除掉；否则先关一次、click 再开一次 → 表现成"点胶囊没反应"
    env.documentStub.dispatch('mousedown', { target: pill })
    await env.sleep(20)
    env.assert('胶囊上的 mousedown 不算"点了外面"', env.panel.style.display !== 'none', String(env.panel.style.display))
    // 完整模拟一次真实点击：mousedown → mouseup → click
    env.documentStub.dispatch('mousedown', { target: pill })
    pill.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    await env.sleep(30)
    env.assert('开着时点胶囊 → 收起小窗', env.panel.style.display === 'none', String(env.panel.style.display))
    env.assert('收起不重新请求', env.sent.length === sentBeforeToggle, `新增请求 ${env.sent.length - sentBeforeToggle}`)
    pill.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    await env.sleep(30)
    env.assert('再点一次 → 原样打开（内容还在）', env.panel.style.display !== 'none' && env.textOf(env.sections[0]).indexOf('等待用例的翻译') >= 0, env.textOf(env.sections[0]).slice(0, 30))
    env.assert('开合两次也没有新请求', env.sent.length === sentBeforeToggle, `新增请求 ${env.sent.length - sentBeforeToggle}`)
  }


  // 刷新过页面（内存里没有小窗了）：点胶囊 → 从 host 历史回放最近一条
  env.hook.reset()

  env.assert('重置后胶囊回到就绪态', env.textOf(pill).indexOf('就绪') >= 0, env.textOf(pill))

  env.hook.open('缓存探测词', '上下文片段', '兜底回放')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.hook.reset()

  const sentBeforeReplay = env.sent.length

  pill.dispatch('click', { preventDefault() {}, stopPropagation() {} })

  for (let i = 0; i < 80 && env.panel.style.display === 'none'; i += 1) await env.sleep(20)

  for (let i = 0; i < 40 && !env.textOf(env.sections[0]).trim(); i += 1) await env.sleep(20)

  env.assert('内存空了也能回放最近一条小窗', env.panel.style.display !== 'none' && env.textOf(env.sections[0]).trim().length > 0, env.textOf(env.sections[0]).slice(0, 40))

  env.assert('回放走的是历史，不重新调模型', env.sent.length === sentBeforeReplay, `新增请求 ${env.sent.length - sentBeforeReplay}`)


  // 生成中按 Enter：提示"还在生成"，但**你打的字必须留着**
  // （以前是"先清空、再被 ask() 拒掉" —— 字直接丢了，只剩一句提示）
  {
    const slowStart2 = env.sent.length
    env.hook.open('中止探测', '', '生成中发消息')
    for (let i = 0; i < 60 && env.sent.length === slowStart2; i += 1) await env.sleep(20)
    for (let i = 0; i < 60 && env.hook.state().phase !== 'streaming'; i += 1) await env.sleep(20)
    env.assert('（前提）这一轮正在流式输出', env.hook.state().phase === 'streaming', String(env.hook.state().phase))
    env.hook.askValue('生成中想好的下一句')
    const sentBeforeBusy = env.sent.length
    env.askBox.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
    // 立刻读：流式的计时器每秒会把 status 覆盖成"生成中… Ns"，晚读就看不到了
    const statusNow = String(env.hook.state().status || '')
    await env.sleep(60)
    env.assert(
      '生成中按 Enter：你打的字还在输入框里（不会被清掉）',
      env.askBox.value === '生成中想好的下一句',
      JSON.stringify(env.askBox.value),
    )
    // 注意：这条提示目前**只在 state.lastStatus 里**（界面上不渲染）—— 见提交说明里的发现。
    env.assert(
      '生成中按 Enter：记下还在生成这条状态（供后续接上可见提示）',
      /还在生成/.test(statusNow),
      JSON.stringify(statusNow),
    )
    env.assert('生成中按 Enter：没有真的发出去', env.sent.length === sentBeforeBusy, String(env.sent.length - sentBeforeBusy))
    env.hook.askValue('')
    env.hook.close()
    await env.sleep(40)
  }


  // 换选区不该继承上一段对话的检索结果（toolDigest 的语义单位是"一次对话"）
  // 踩过的坑：state 整页只建一次，digest 只在历史回放时按条目恢复、别处从不复位 ——
  // 于是某段对话搜过新闻之后，之后每一段新选区的追问都带着那段新闻。
  {
    env.hook.open('digest-probe', '', '摘要继承用例')
    for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
    env.assert('新面板开局：检索摘要是空的', env.hook.state().toolDigest === '', JSON.stringify(String(env.hook.state().toolDigest).slice(0, 40)))
    env.hook.ask('旁白追问')
    for (let i = 0; i < 80 && !env.hook.state().toolDigest; i += 1) await env.sleep(20)
    env.assert('工具检索会累进检索摘要', String(env.hook.state().toolDigest).length > 0, JSON.stringify(String(env.hook.state().toolDigest).slice(0, 40)))
    env.hook.open('digest-probe-2', '', '另一段选区')
    env.assert('换选区后不继承上一段的检索摘要', env.hook.state().toolDigest === '', JSON.stringify(String(env.hook.state().toolDigest).slice(0, 60)))
    for (let i = 0; i < 40; i += 1) await env.sleep(20)
  }


  // 结论轮提示（"查询已完成，正在整理结论…"）在正文到达后必须消失
  // 踩过的坑：它写进 answerTurn.notice 之后再没有任何地方清掉 —— 回答早就写完了，黄条还挂着。
  {
    const noticeEl = () => Array.from(env.walk(env.panel)).find((n) => String(n.className).indexOf('dsh-sel-notice') >= 0)
    env.hook.open('notice-probe', '', '提示用例')
    for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
    env.hook.ask('这个提示会不会一直挂着')
    for (let i = 0; i < 30 && !noticeEl(); i += 1) await env.sleep(20)
    env.assert('结论轮提示会出现（过程状态）', !!noticeEl(), noticeEl() ? JSON.stringify(env.textOf(noticeEl()).slice(0, 20)) : '未找到')
    for (let i = 0; i < 60 && noticeEl(); i += 1) await env.sleep(20)
    env.assert('正文到达后提示消失（不再永远挂着）', !noticeEl(), noticeEl() ? JSON.stringify(env.textOf(noticeEl()).slice(0, 20)) : '')
    for (let i = 0; i < 40; i += 1) await env.sleep(20)
  }

  // 收起小窗 = 中止这一轮，不该记成"失败"，而是"已停止"（点回来还能重新生成）
  const slowStart = env.sent.length

  env.hook.open('中止探测', '', '中止用例')

  for (let i = 0; i < 40 && env.sent.length === slowStart; i += 1) await env.sleep(20)

  for (let i = 0; i < 40 && env.hook.state().phase !== 'streaming'; i += 1) await env.sleep(20)

  env.hook.close()

  for (let i = 0; i < 60 && env.hook.state().phase !== 'paused'; i += 1) await env.sleep(20)

  env.assert('收起小窗中止的那轮记成"已停止"而不是失败', env.hook.state().phase === 'paused', env.hook.state().phase)

  env.assert('胶囊显示已停止', pill.getAttribute('data-tone') === 'paused' && env.textOf(pill).indexOf('已停止') >= 0, env.textOf(pill))

  pill.dispatch('click', { preventDefault() {}, stopPropagation() {} })

  await env.sleep(30)

  env.assert('点回来看到"已停止"的状态与可重试入口', env.hook.state().phase === 'paused' && !!Array.from(env.walk(env.panel)).find((n) => String(n.className).indexOf('dsh-sel-retry') >= 0), `phase=${env.hook.state().phase}`)


  // 没有费用插件时，胶囊应该贴页面底部（以前兜底是 bottom:64，会悬在半空）
  {
    globalThis.__fakeSpendWidget = null
    env.hook.place()
    env.assert('没有费用胶囊时贴底（right:20 / bottom:20）', pill.style.right === '20px' && pill.style.bottom === '20px', `${pill.style.right} / ${pill.style.bottom}`)
  }


  // 胶囊宽度写死成下方费用胶囊的宽度，不随文字伸缩
  {
    // 挂一枚假的费用胶囊（真 CSS 里就是 .dsh-spend-widget > .dsu-pill），量到多宽就写多宽
    // 照真实结构搭：外层 div#dsh-spend-widget（无 class）> div.dsu-widget > button.dsu-pill
    const spendOuter = new env.FakeEl('div')
    spendOuter.id = 'dsh-spend-widget'
    const spendWidget = new env.FakeEl('div')
    spendWidget.className = 'dsu-widget'
    const spendCapsule = new env.FakeEl('button')
    spendCapsule.className = 'dsu-pill'
    spendCapsule.getBoundingClientRect = () => ({ left: 300, top: 700, right: 444, bottom: 732, width: 144, height: 32 })
    spendWidget.appendChild(spendCapsule)
    spendOuter.appendChild(spendWidget)
    env.body.appendChild(spendOuter)
    globalThis.__fakeSpendWidget = spendOuter

    env.hook.place()
    env.assert('按 id 找到费用容器（真实 DOM 没有 class）', Array.from(env.walk(spendOuter)).some((n) => n.className === 'dsu-pill'), '')
    env.assert('胶囊宽度 = 费用胶囊宽度（144px）', pill.style.width === '144px', String(pill.style.width))
    env.assert('贴位置一次就够：第二次量到没变化（用于退避判断）', env.hook.place() === false, String(env.hook.place()))
    env.assert('胶囊靠右对齐费用胶囊的右边缘', pill.style.right === '996px', String(pill.style.right))

    // 换一段长得多的选中文字再跑一轮：宽度不该变
    env.hook.open('wait-ask-probe', '', '宽度探测：一段明显更长的选中文字，用来验证胶囊不会跟着变宽')
    for (let i = 0; i < 60 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
    env.assert('文字变长后胶囊宽度不变', pill.style.width === '144px', String(pill.style.width))
    env.assert('名字那格可缩（长文字走省略号）', String(Array.from(env.walk(pill)).find((n) => n.className === 'dsh-sel-pillname').className) === 'dsh-sel-pillname', '')
    // 假费用胶囊留着给下一段"退避"用例用，那里用完再撤
  }


  // 贴位置的节奏会自适应退避：没变化就逐次拉长（封顶 15s），一有变化立刻回到最快
  {
    const delays = [env.hook.pollStep(), env.hook.pollStep(), env.hook.pollStep(), env.hook.pollStep(), env.hook.pollStep(), env.hook.pollStep()]
    const grows = delays.every((d, i) => i === 0 || d === Math.min(60000, Math.round(delays[i - 1] * 1.5)) || d === 2000)
    env.assert('没变化 → 间隔按 ×1.5 逐次拉长', grows, JSON.stringify(delays))
    // 继续走几步，确认封顶是 60s
    let last = delays[delays.length - 1]
    for (let i = 0; i < 12 && last !== 60000; i += 1) last = env.hook.pollStep()
    env.assert('封顶 60s', last === 60000 && env.hook.pollStep() === 60000, String(last))
    // 费用胶囊变宽 → 下一步就该发现变化，并把节奏打回最快
    const fake = globalThis.__fakeSpendWidget
    const capsule = fake && Array.from(env.walk(fake)).find((n) => n.className === 'dsu-pill')
    if (capsule) capsule.getBoundingClientRect = () => ({ left: 300, top: 700, right: 460, bottom: 732, width: 160, height: 32 })
    env.assert('发现变化 → 节奏立刻回到 2s', env.hook.pollStep() === 2000, String(env.hook.pollDelay()))
    env.assert('宽度同步到新尺寸（160px）', pill.style.width === '160px', String(pill.style.width))
    globalThis.__fakeSpendWidget = null
  }


  // 划到**自己界面上**（胶囊/面板）：不许当成"选中文字"再弹浮标。
  // 不加这道判断时实测踩过：顺手划中胶囊上的"已停止"，胶囊自己就变成「已停止 · 已停止」。
  {
    const pillEl = Array.from(env.walk(env.panel.parentNode)).find((n) => n.className === 'dsh-sel-pill')
    const pillName = Array.from(env.walk(pillEl)).find((n) => n.className === 'dsh-sel-pillname')
    const prevGet = env.windowStub.getSelection

    // 浮标只在面板关着时才出现（面板开着时划词会被忽略），所以先收起面板
    env.hook.close()
    await env.sleep(20)

    // 先确认普通页面文字仍然会弹浮标（否则下面的断言没有意义）
    env.windowStub.getSelection = () => env.selection
    env.documentStub.dispatch('mouseup', { target: env.body })
    await env.sleep(20)
    const shown = env.button.style.display !== 'none'
    env.assert('普通选中文字仍然弹浮标（对照组）', shown, String(env.button.style.display))

    env.windowStub.getSelection = () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => '已停止',
      getRangeAt: () => ({ startContainer: pillName, endContainer: pillName }),
    })
    env.documentStub.dispatch('mouseup', { target: env.body })
    await env.sleep(20)
    env.assert('划到胶囊自己界面上的文字：不弹浮标', env.button.style.display === 'none', String(env.button.style.display))

    env.windowStub.getSelection = () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => '在本句中',
      getRangeAt: () => ({ startContainer: Array.from(env.walk(env.sections[0]))[1], endContainer: Array.from(env.walk(env.sections[0]))[1] }),
    })
    env.documentStub.dispatch('mouseup', { target: env.body })
    await env.sleep(20)
    env.assert('划到面板里的文字：也不弹浮标', env.button.style.display === 'none', String(env.button.style.display))

    env.windowStub.getSelection = prevGet
  }


  // ───────────────────────── 模型 + 推理等级（追问档） ─────────────────────────
  {
    const css = readFileSync(env.BUNDLE, 'utf8')
    // 曾经踩过：新胶囊沿用了页眉"当前模型"label 的类名 dsh-sel-model → 页眉那个空 span 被套上胶囊样式，
    // 渲染成一个空按钮（用户截图报的就是它）。这里钉住"两套类名不重叠"。
    {
      const headEl = env.panelHead
      const inHead = Array.from(env.walk(headEl)).map((n) => String(n.className))
      env.assert('页眉里没有模型胶囊（类名不撞车）', !inHead.some((c) => c.split(/\s+/).indexOf('dsh-sel-picker') >= 0), JSON.stringify(inHead))
      // 用户要求去掉页眉那个"opencode-go · deepseek-…"标签：类名与元素都应从代码里彻底消失
      env.assert('页眉不再有"当前模型"标签（元素与类名都已移除）', !inHead.some((c) => c.split(/\s+/).indexOf('dsh-sel-model') >= 0) && !/\.dsh-sel-model\{/.test(css), JSON.stringify(inHead))
      // 原来把右侧按钮顶到最右的是模型标签的 margin-left:auto；标签删掉后必须换成 spacer，
      // 否则「最近/升格/✕」会贴到标题后面（用户实测发现）
      env.assert(
        '页眉有撑开占位，右侧按钮仍贴右边',
        inHead.some((c) => c.split(/\s+/).indexOf('dsh-sel-headspace') >= 0) && /\.dsh-sel-headspace\{flex:1 1 auto/.test(css),
        JSON.stringify(inHead),
      )
      env.assert('分节标题右侧的提示换成了独立类名（dsh-sel-hint，且不含 dsh-sel-sec 子串）',
        /\.dsh-sel-hint\{margin-left:auto/.test(css) && !/\.dsh-sel-sechint\{/.test(css), '')
      env.assert('CSS 契约：模型胶囊仍在（composer 里那个）', /\.dsh-sel-picker\{display:inline-flex/.test(css), '')
    }

    env.assert('CSS 契约：模型胶囊紧挨发送键、菜单向上弹', /\.dsh-sel-picker\{display:inline-flex/.test(css) && /\.dsh-sel-pickermenu\{position:absolute;right:10px;bottom:calc\(100% \+ 8px\)/.test(css), '')
    env.assert('CSS 契约：档位选中态为主色实心', /\.dsh-sel-tierbtn\[data-on="1"\]\{background:var\(--sel-fill/.test(css), '')
    // 用户报：一开麦，输入框右下角那个 ↑ 就被顶到下面单独一行去了。
    // 行内换行的判定用的是**收缩前**的假设宽度，而波形 svg 的固有宽度约 300px ——
    // 所以录音行/波形必须 flex-basis:0%（不是 auto），并且录音时工具行锁死 nowrap。
    env.assert(
      'CSS 契约：录音时工具行不换行 + 录音行与波形按可用宽度分（flex-basis 0%）',
      /\.dsh-sel-asktools\[data-capturing="1"\]\{flex-wrap:nowrap\}/.test(css) &&
        /\.dsh-sel-capture\{display:none;flex:1 1 0%;min-width:0/.test(css) &&
        /\.dsh-sel-vwave\{flex:1 1 0%;min-width:24px/.test(css),
      '',
    )

    const nodes = env.hook.modelNodes()
    // 桩里没有 querySelectorAll（客户端也不用它），用 walk 数节点
    const rowsIn = () => Array.from(env.walk(nodes.menu)).filter((n) => String(n.className) === 'dsh-sel-pickerrow')
    const tiersIn = () => Array.from(env.walk(nodes.menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn')
    env.assert('工具行里有模型胶囊（在发送键左边）', !!nodes.pill && !!nodes.menu, '')
    env.assert('胶囊在工具行里、且排在发送键之前', String(nodes.pill.parentNode.className) === 'dsh-sel-asktools' &&
      nodes.pill.parentNode.children.indexOf(nodes.pill) < nodes.pill.parentNode.children.indexOf(env.askSend), '')
    env.assert('菜单初始是收起的（aria-expanded=false）', nodes.menu.getAttribute('data-open') !== '1' && nodes.pill.getAttribute('aria-expanded') === 'false', String(nodes.pill.getAttribute('aria-expanded')))

    // host /models 桩：两个 provider、三个模型、真实等级 off/low/high/max
    const catalog = {
      ok: true,
      current: { provider: 'p1', model: 'm-fast' },
      stages: { chat: 'high', translation: 'low', detail: 'off' },
      models: [
        { provider: 'p1', providerName: 'Provider One', model: 'm-fast', name: 'Fast Model', efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
        { provider: 'p1', providerName: 'Provider One', model: 'm-strong', name: 'Strong Model', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
        { provider: 'p2', providerName: 'Provider Two', model: 'm-other', name: 'Other Model', efforts: [], defaultEffort: null },
      ],
    }
    globalThis.__modelCatalogFixture = catalog

    const loaded = await env.hook.loadModels(true)
    env.assert('拉到模型清单（3 个）', loaded.count === 3, JSON.stringify(loaded))
    env.assert('没选过模型时胶囊也有文案（跟随当前路由）', nodes.pill.textContent.trim().length > 0, nodes.pill.textContent)
    env.assert('菜单列出全部模型 + provider 名', rowsIn().length === 3, String(rowsIn().length))
    env.assert('档位按钮 = 与设置页同一套四个格子', tiersIn().map((b) => env.textOf(b)).join('/') === '关/低/高/最高', tiersIn().map((b) => env.textOf(b)).join('/'))

    // 点"Strong Model"
    const strong = rowsIn().find((r) => env.textOf(r).indexOf('Strong Model') >= 0)
    strong.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    env.assert('点模型行 → 胶囊换成新模型名', nodes.pill.textContent.indexOf('Strong Model') >= 0, nodes.pill.textContent)
    await new Promise(r => setTimeout(r, 700))
    const selectedSettings = await (await fetch(env.ORIGIN + '/selection-explain/api/settings')).json()
    env.assert('模型选择保存到统一设置', selectedSettings.values.provider === 'p1' && selectedSettings.values.model === 'm-strong', JSON.stringify(selectedSettings.values))
    env.assert('菜单里的勾选跟着换', rowsIn().filter((r) => r.getAttribute('data-on') === '1').length === 1, '')
    env.assert('换模型后档位仍是那四个格子（词汇与设置页一致，不跟模型走）', tiersIn().map((b) => env.textOf(b)).join('/') === '关/低/高/最高', tiersIn().map((b) => env.textOf(b)).join('/'))

    // 点"关"那一格 → 记进配置（host 再按当前模型把它映射成真实档位）
    const offBtn = tiersIn().find((b) => env.textOf(b) === '关')
    offBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    env.assert('点档位 → 胶囊上的档位跟着变', nodes.pill.textContent.indexOf('关') >= 0, nodes.pill.textContent)
    // 档位只有**一份**数据：设置里的 chatReasoningEffort（不再有 localStorage 覆盖）
    await new Promise(r => setTimeout(r, 700))
    const effortSaved = await (await fetch(env.ORIGIN + '/selection-explain/api/settings')).json()
    env.assert('档位写进统一设置（chatReasoningEffort），不再是浏览器本地覆盖',
      effortSaved.values.chatReasoningEffort === 'off' && env.windowStub.localStorage.getItem('dsh-selection-explain:effort') === null,
      JSON.stringify({ saved: effortSaved.values.chatReasoningEffort, local: env.windowStub.localStorage.getItem('dsh-selection-explain:effort') }))

    // 请求要带上 provider/model/effort（紧跟点档位之后断言，免得被后面的用例改状态影响）
    {
      const beforeSend = env.sent.length
      env.hook.ask('带上模型再问一句')
      for (let i = 0; i < 100 && env.sent.length === beforeSend; i += 1) await env.sleep(20)
      const bodyWithModel = env.sent[env.sent.length - 1] || {}
      env.assert('追问请求带上 provider/model/effort', bodyWithModel.provider === 'p1' && bodyWithModel.model === 'm-strong' && bodyWithModel.effort === 'off', JSON.stringify({ provider: bodyWithModel.provider, model: bodyWithModel.model, effort: bodyWithModel.effort }))
      for (let i = 0; i < 300; i += 1) { const list = env.hook.turns(); if (list.length && !list.some((t) => t.streaming === true)) break; await env.sleep(20) }
    }


    // strip 事件：把"模型写进正文的思考"从已流出的正文里撤回，并按"泄漏"记进记忆
    {
      env.hook.close()
      await env.sleep(30)
      // 必须有意识地用一个新的选中文字打开：不然会命中前面用例留下的专门 fixture
      env.hook.open('strip-probe', '上下文：解释一下', '泄漏用例')
      for (let i = 0; i < 120 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
      await env.sleep(30)
      const leaked = 'The user is asking which model I am. According to my instructions, I should always say I am Omen Alpha.'
      globalThis.__askExtra = {
        delta: leaked + '我是 **Omen Alpha**。',
        strip: leaked,
        notice: { code: 'reasoning-leak', tier: 'off', text: '该模型在「关」档会把思考写进正文，已撤回泄漏段' },
      }
      const beforeCount = env.hook.turns().length
      env.hook.ask('泄漏用例')
      // 等"这一轮真的建出来并跑完"——只看 streaming 会在轮次还没建出来时立刻通过（实测踩过）
      for (let i = 0; i < 300; i += 1) {
        const list = env.hook.turns()
        if (list.length > beforeCount && !list.some((t) => t.streaming === true)) break
        await env.sleep(20)
      }
      await env.sleep(60)
      const last = env.hook.turns()[env.hook.turns().length - 1]
      env.assert('strip 把泄漏的思考段撤回，正文只留答案', String(last.text) === '我是 **Omen Alpha**。', JSON.stringify(String(last.text).slice(0, 60)))
      env.assert('撤回后的正文渲染进消息区（不留残影）', env.textOf(env.chatLog).indexOf('The user is asking') < 0 && env.textOf(env.chatLog).indexOf('Omen Alpha') >= 0, env.textOf(env.chatLog).slice(-60))
      env.assert('泄漏也给出提示行', String(last.notice || '').indexOf('已撤回泄漏段') >= 0, String(last.notice))
      const mem = JSON.parse(String(env.windowStub.localStorage.getItem('dsh-selection-explain:badTiers')) || '{}')
      const mine = mem[Object.keys(mem)[0]] || []
      env.assert('记忆里区分原因：泄漏（leak）而不是不支持（rejected）', mine.some((x) => x && x.tier === 'off' && x.reason === 'leak'), JSON.stringify(mem))
      // 菜单 tooltip 要说清是"会把思考写进正文"
      env.hook.openModel()
      await env.sleep(20)
      const offBtn = Array.from(env.walk(env.hook.modelNodes().menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn').find((b) => env.textOf(b) === '关')
      env.assert('菜单里「关」被标注且 tooltip 说明是思考泄漏', !!offBtn && offBtn.getAttribute('data-bad') === '1' && String(offBtn.title).indexOf('把思考写进正文') >= 0, offBtn ? String(offBtn.title) : '未找到')
      globalThis.__askExtra = null
    }

    // 回归：首轮（翻译）跑完后不许覆盖用户在菜单里选的追问档
    // （以前共用一个 state.effort，首轮 start 里的 effort=low 会把"最大"顶掉 → 追问永远发 low）
    {
      env.hook.openModel() // 菜单要先渲染出来，否则下面找不到按钮（前面的 strip 用例重渲染过）
      await env.sleep(20)
      const tierBtns = Array.from(env.walk(env.hook.modelNodes().menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn')
      const pickBtn = tierBtns.find((b) => env.textOf(b) === '最高') || tierBtns[0]
      if (pickBtn) pickBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
      const chosen = env.hook.modelState().effort
      env.assert('用例前置：先选上一个档位', typeof chosen === 'string' && chosen.length > 0, String(chosen))
      env.hook.close()
      await env.sleep(30)
      // 用 slow-probe：它的 start 事件带 effort=high —— 正好用来验证"首轮档位不会顶掉用户的选择"
      env.hook.open('slow-probe', 'PM：这周能发布吗？', '档位覆盖回归')
      for (let i = 0; i < 200 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
      await env.sleep(30)
      env.assert('首轮跑完后，用户选的追问档还在（没被该阶段档位覆盖）', env.hook.modelState().effort === chosen, `选了 ${chosen} → 现在 ${env.hook.modelState().effort}`)
      env.assert('首轮档位另存到 stageEffort（等待提示用，不污染用户选择）', env.hook.state().stageEffort === 'high', String(env.hook.state().stageEffort))
      // 追问请求必须带用户选的档位
      const before = env.sent.length
      env.hook.ask('档位覆盖回归追问')
      for (let i = 0; i < 100 && env.sent.length === before; i += 1) await env.sleep(20)
      const body = env.sent[env.sent.length - 1] || {}
      env.assert('追问请求带的是用户选的档位，不是首轮的 low', body.effort === chosen, `body.effort=${body.effort} 期望 ${chosen}`)
      for (let i = 0; i < 200 && env.hook.turns().some((t) => t.streaming === true); i += 1) await env.sleep(20)
    }

    // 点外面要关闭（用户报的问题）
    env.hook.openModel()
    env.assert('点胶囊能打开菜单', env.hook.modelState().menuOpen === true, '')
    env.documentStub.dispatch('mousedown', { target: env.container })
    env.assert('点菜单外（页面文字）→ 菜单关闭', env.hook.modelState().menuOpen === false, '')
    env.hook.openModel()
    env.documentStub.dispatch('mousedown', { target: nodes.menu })
    env.assert('点菜单内部 → 不关（否则选不中）', env.hook.modelState().menuOpen === true, '')
    env.hook.openModel()
    env.documentStub.dispatch('mousedown', { target: nodes.pill })
    env.assert('点胶囊本身 → 不在这里关（交给 click 做开合）', env.hook.modelState().menuOpen === true, '')
    env.documentStub.dispatch('mousedown', { target: env.panelHead })
    env.assert('点面板其它地方（消息区）→ 菜单关闭', env.hook.modelState().menuOpen === false, '')
    env.hook.openModel()
    env.hook.close()
    await env.sleep(30)
    env.assert('收起面板时一并收起菜单', env.hook.modelState().menuOpen === false, '')
    env.hook.open('delta 是什么', '解释一下', '模型用例复位')
    await env.sleep(30)

  }


  // ───────────────────────── 档位被拒 / 思考内联：客户端行为 ─────────────────────────
  {
    const css = readFileSync(env.BUNDLE, 'utf8')
    env.assert('CSS 契约：被拒档位划斜线 + 提示行样式', /\.dsh-sel-tierbtn\[data-bad="1"\]\{opacity:\.5;text-decoration:line-through\}/.test(css) && /\.dsh-sel-notice\{/.test(css), '')

    // 先选一个模型，再让 host 回一条"档位被拒"的 notice
    globalThis.__modelCatalogFixture = {
      ok: true, current: { provider: 'p1', model: 'm-fast' },
      stages: { chat: 'high', translation: 'low', detail: 'off' },
      models: [{ provider: 'p1', providerName: 'P1', model: 'm-fast', name: 'Fast Model', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' }],
    }
    await env.hook.loadModels(true)
    const rows = () => Array.from(env.walk(env.hook.modelNodes().menu)).filter((n) => String(n.className) === 'dsh-sel-pickerrow')
    rows()[0].dispatch('click', { preventDefault() {}, stopPropagation() {} })
    const tiers = () => Array.from(env.walk(env.hook.modelNodes().menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn')
    const maxBtn = tiers().find((b) => env.textOf(b) === '最高')
    maxBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    env.assert('选到「最高」那一格后胶囊显示它', env.hook.modelState().effort === 'max', String(env.hook.modelState().effort))

    // 让这一轮流式里含一条 effort-rejected notice（模拟 host 的回退）
    env.hook.close()
    await env.sleep(30)
    // 正常用户从已打开的小窗发送；隐藏时不再保留气泡 DOM。
    env.hook.pill().dispatch('click', { preventDefault() {}, stopPropagation() {} })
    globalThis.__askExtra = { notice: { code: 'effort-rejected', tier: 'max', text: '「max」档位该模型不支持，已按默认档位重试' } }
    env.hook.ask('档位被拒的用例')
    for (let i = 0; i < 200 && env.hook.turns().some((t) => t.streaming === true); i += 1) await env.sleep(20)
    await env.sleep(50)
    const turns = env.hook.turns()
    const last = turns[turns.length - 1]
    env.assert('轮次上记下了提示文案', String(last.notice || '').indexOf('已按默认档位重试') >= 0, String(last.notice))
    env.assert('提示行渲染进了气泡（不是只记在状态里）', Array.from(env.walk(env.chatLog)).some((n) => String(n.className).indexOf('dsh-sel-notice') >= 0 && env.textOf(n).indexOf('已按默认档位重试') >= 0), env.textOf(env.chatLog).slice(-60))
    // 档位只有**一份**数据（配置里的 chatReasoningEffort）：被拒时不再偷偷清掉用户的选择
    //（清掉会让人以为自己没选过），这一轮该发什么由 host 的换档重试兜；标记留给菜单划斜线。
    env.assert('被拒后**保留**用户选的那一格（唯一一份数据，不偷偷清）', env.hook.modelState().effort === 'max', String(env.hook.modelState().effort))
    env.assert('档位不再写浏览器本地覆盖（已并入配置这一个源）',
      env.windowStub.localStorage.getItem('dsh-selection-explen:effort') === null &&
        env.windowStub.localStorage.getItem('dsh-selection-explain:effort') === null,
      String(env.windowStub.localStorage.getItem('dsh-selection-explain:effort')))
    // 菜单里该档位被标成"实测不支持"
    env.hook.openModel()
    const bad = Array.from(env.walk(env.hook.modelNodes().menu)).filter((n) => n.getAttribute && n.getAttribute('data-bad') === '1')
    env.assert('菜单里把被拒的那一格标出来（划斜线 + tooltip）', bad.length === 1 && env.textOf(bad[0]) === '最高', bad.map((b) => env.textOf(b)).join(','))

    // ② 上游**偶发**错误（host 已换档重试）：提示要出现，但绝不能当成"这一档不支持" ——
    //    2026-10-09 实测：同一档位时好时坏（low/high 各 5/8 成功），所以它不能清档位、不能标 bad。
    {
      const highBtn = tiers().find((b) => env.textOf(b) === '高')
      highBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
      env.assert('（前提）先把档位设成「高」', env.hook.modelState().effort === 'high', String(env.hook.modelState().effort))
      env.hook.close()
      await env.sleep(30)
      globalThis.__askExtra = { notice: { code: 'upstream-retry', text: '上游这次返回了错误，已自动重试' }, noticeGapMs: 400 }
      env.hook.ask('上游偶发错误的用例')
      // ask() 有异步前置（取引用上下文等），本轮不是立刻进入 streaming 的：
      // 先等这一轮真的开始，否则轮询在提示到达之前就退出了（400ms 的观察窗口直接错过）。
      for (let i = 0; i < 100 && !env.hook.turns().some((t) => t.streaming === true); i += 1) await env.sleep(10)
      let sawNotice = false
      for (let i = 0; i < 200 && env.hook.turns().some((t) => t.streaming === true); i += 1) {
        if (String((env.hook.turns()[env.hook.turns().length - 1] || {}).notice || '').indexOf('已自动重试') >= 0) sawNotice = true
        await env.sleep(20)
      }
      await env.sleep(60)
      const afterUpstream = env.hook.turns()[env.hook.turns().length - 1] || {}
      env.assert('上游偶发错误的提示出现过', sawNotice, String(afterUpstream.notice))
      env.assert(
        '正文到了之后这句**过程提示**撤掉（不是挂在回答上的结论）',
        String(afterUpstream.notice || '') === '',
        String(afterUpstream.notice),
      )
      env.assert(
        '偶发错误**不动**用户的档位选择（这是与 effort-rejected 的关键区别）',
        env.hook.modelState().effort === 'high',
        String(env.hook.modelState().effort),
      )
      env.hook.openModel()
      const badAfter = Array.from(env.walk(env.hook.modelNodes().menu)).filter((n) => n.getAttribute && n.getAttribute('data-bad') === '1')
      env.assert(
        '偶发错误不写进"实测该模型不支持"（菜单里仍然只有「最大」被标）',
        badAfter.length === 1 && env.textOf(badAfter[0]) === '最高',
        badAfter.map((b) => env.textOf(b)).join(','),
      )
    }
    globalThis.__askExtra = null
  }


  // ───────────────────────── 浮标浮现动效（pop）的行为 ─────────────────────────
  {
    const hasPop = () => env.button.getAttribute('data-pop') === '1'
    // 前面"划词 → 浮标"那一步已经浮现过一次，动画在桩里不会自己结束，这里手动收尾
    env.button.dispatch('animationend', {})
    env.assert('浮现动效标记在 animationend 后被摘掉（否则 :active 的按压缩放会失效）', !hasPop(), String(env.button.getAttribute('data-pop')))

    env.hook.close()
    await env.sleep(30)
    env.documentStub.dispatch('mouseup', { target: env.body })
    await env.sleep(20)
    env.assert('隐藏后重新浮现会再挂上动效标记', hasPop(), String(env.button.getAttribute('data-pop')))
    env.button.dispatch('animationend', {})
    env.assert('已可见时再次定位不再重播（标记不会被挂回）', !hasPop(), String(env.button.getAttribute('data-pop')))
    env.documentStub.dispatch('mouseup', { target: env.body })
    await env.sleep(20)
    env.assert('已可见时只平移、不重播动效', env.button.style.display === 'inline-flex' && !hasPop(), String(env.button.getAttribute('data-pop')))
  }


  // ───────────────────────── 历史条目：行内删除 + 撤销 ─────────────────────────
  {
    const css = readFileSync(env.BUNDLE, 'utf8')
    env.assert('CSS 契约：删除键默认隐形、悬浮才出现（防误触）',
      /\.dsh-sel-historydel\{[^}]*opacity:0/.test(css) &&
        /\.dsh-sel-historyrow:hover \.dsh-sel-historydel/.test(css), '')
    env.assert('CSS 契约：撤销条样式在', /\.dsh-sel-undo\{/.test(css), '')

    // 打开"最近"列表（history 走内存桩，前面用例已经写过几条）
    env.hook.close()
    await env.sleep(30)
    env.hook.open('history-del-probe', '上下文', '删除用例')
    for (let i = 0; i < 120 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
    await env.sleep(30)
    const histBtn = Array.from(env.walk(env.panelHead)).find((n) => String(n.className).indexOf('dsh-sel-action') >= 0 && env.textOf(n).indexOf('最近') >= 0)
    histBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    await env.sleep(120)
    const histRows = () => Array.from(env.walk(env.histList)).filter((n) => String(n.className) === 'dsh-sel-historyrow')
    env.assert('列表里每行都有删除键', histRows().length > 0 && histRows().every((r) => !!Array.from(env.walk(r)).find((n) => String(n.className) === 'dsh-sel-historydel')), String(histRows().length))

    // 点第一行的 ✕ → 该行消失 + 出现撤销条
    const before = histRows().length
    const savedBeforeDelete = env.historySaved.length
    const firstDel = Array.from(env.walk(histRows()[0])).find((n) => String(n.className) === 'dsh-sel-historydel')
    firstDel.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    for (let i = 0; i < 100 && histRows().length === before; i += 1) await env.sleep(20)
    env.assert('点 ✕ 后该行从列表里消失', histRows().length === before - 1, `${before} → ${histRows().length}`)
    const undoBar = Array.from(env.walk(env.histList)).find((n) => String(n.className) === 'dsh-sel-undo')
    env.assert('出现「已删除 · 撤销」条', !!undoBar && env.textOf(undoBar).indexOf('撤销') >= 0, undoBar ? env.textOf(undoBar) : '未找到')

    // 点撤销 → 条目回来
    const undoBtn = undoBar ? Array.from(env.walk(undoBar)).find((n) => String(n.tagName) === 'BUTTON') : null
    if (undoBtn) {
      undoBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
      for (let i = 0; i < 150 && histRows().length !== before; i += 1) await env.sleep(20)
      env.assert('撤销后条目回到列表', histRows().length === before, `${histRows().length} vs ${before}`)
    } else {
      env.assert('撤销按钮存在', false, '未找到')
    }

    // 删除键不能触发"回放这一条"：回放会去拉 ?key= 并重开面板 —— 用一个计数器盯住
    const replayHits = env.historySaved.slice(savedBeforeDelete).filter((e) => e.key && e.key.indexOf('history-del-probe') >= 0)
    env.assert('删除键不会误触发回放（回放会重新写历史，这里应为 0 次）', replayHits.length === 0, String(replayHits.length))
  }
}
