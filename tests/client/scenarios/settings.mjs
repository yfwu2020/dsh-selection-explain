





export async function run(env) {


  const settingsSnapshot = await (
    await fetch(env.ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })
  ).json()

  const deadline = Date.now() + 90000

  while (Date.now() < deadline) {
    const state = env.hook.state()
    if (state.phase === 'done' || state.phase === 'error') break
    await new Promise((r) => setTimeout(r, 400))
  }

  const final = env.hook.state()

  const stage1 = env.hook.parts()

  env.assert('流式渲染完成（无错误）', final.phase === 'done', `phase=${final.phase} chars=${final.chars}`)

  env.assert('首轮只产出翻译节', (stage1.translation || '').trim().length > 0 && !(stage1.detail || '').trim(), JSON.stringify({ stage: stage1.stage, t: stage1.translation.length, d: stage1.detail.length }))

  env.assert('首轮请求带 stage=translation', env.sent[0] && env.sent[0].stage === 'translation', String(env.sent[0] && env.sent[0].stage))

  env.assert('首轮不显示详解卡片', !!env.detailCard && env.detailCard.style.display === 'none', env.detailCard ? env.detailCard.style.display : '未找到')

  env.assert(
    '底部有「展开详解」按钮且不带说明行',
    !!env.expandBtn && env.textOf(env.expandBtn).trim() === '↓ 展开详解',
    env.expandBtn ? JSON.stringify(env.textOf(env.expandBtn)) : '未找到',
  )


  // 只有翻译时的轻量形态：窄面板 / 无序号 / CTA 在内容流里（但**可以越过详解直接追问**）
  const translateCard = env.sections.find((node) => node.getAttribute('data-sec') === 'translation')

  env.assert('首轮面板标为 translation 阶段（决定追问框显示，不决定宽度）', env.panel.getAttribute('data-stage') === 'translation', String(env.panel.getAttribute('data-stage')))

  env.assert(
    '两节标题都不带序号（①② 已去掉）',
    !Array.from(env.walk(env.panel)).some((n) => n.tagName === 'B' && /^[①②12]$/.test(env.textOf(n))),
    Array.from(env.walk(env.panel)).filter((n) => n.tagName === 'B').map((n) => env.textOf(n)).join(','),
  )

  env.assert('翻译出完就能追问（不必先展开详解）', !!env.askRow && env.askRow.style.display !== 'none', env.askRow ? env.askRow.style.display : '未找到')

  env.assert(
    '展开 CTA 在正文内容流里（详解卡片之后）',
    !!env.expandBtn && env.expandBtn.parentNode === env.detailCard.parentNode,
    env.expandBtn && env.expandBtn.parentNode ? env.expandBtn.parentNode.className : '未找到',
  )


  // 越过详解直接追问：翻译刚出来就能问，不必先点「展开详解」
  {
    const before = env.sent.length
    env.hook.ask('不展开详解，直接问一句')
    for (let i = 0; i < 80 && env.sent.length === before; i += 1) await env.sleep(20)
    const payload = env.sent[env.sent.length - 1] || {}
    env.assert('越过详解也能发出追问', payload.question === '不展开详解，直接问一句', JSON.stringify({ q: payload.question, stage: payload.stage }))
    const seed = String(payload.initialExplanation || '')
    env.assert('前情只带翻译：不留空的「详解：」', seed.indexOf('前情') >= 0 && seed.indexOf('详解：') < 0, seed.slice(0, 70))
    for (let i = 0; i < 80 && env.textOf(env.chatLog).indexOf('这是对追问的回答') < 0; i += 1) await env.sleep(20)
    env.assert('回答渲染进小窗消息区', env.textOf(env.chatLog).indexOf('这是对追问的回答') >= 0, env.textOf(env.chatLog).slice(0, 60))
    env.assert('一旦有对话，面板切到 detail 阶段', env.panel.getAttribute('data-stage') === 'detail', String(env.panel.getAttribute('data-stage')))
    env.assert('发过追问后「展开详解」自动收起', env.expandBtn.style.display === 'none', String(env.expandBtn.style.display))

    // 换一段新的选中文字：状态重置，CTA 该回来（后面的"点展开"流程从这里接着走）。
    // 用英文 fixture（标题才是「翻译」，后面的"两节标题"断言才对得上），且它首轮只出翻译、不出详解。
    env.hook.open('cta-reset-probe', '', 'CTA 复位')
    for (let i = 0; i < 120 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
    env.assert('新选区里 CTA 回来', env.expandBtn.style.display !== 'none', String(env.expandBtn.style.display))
    env.assert('新选区把追问记录清空', env.hook.turns().filter((t) => t.role === 'user').length === 0, JSON.stringify(env.hook.turns().map((t) => t.role)))
  }


  // 点击展开：第二阶段（完整上下文 + 详解）
  const beforeExpand = env.sent.length

  env.expandBtn.dispatch('click', { stopPropagation() {} })

  for (let i = 0; i < 200; i += 1) {
    const parts = env.hook.parts()
    if ((parts.detail || '').trim().length > 0) break
    await new Promise((r) => setTimeout(r, 100))
  }

  const stage2 = env.hook.parts()

  const expandPayload = env.sent[env.sent.length - 1]

  env.assert(
    '展开请求带 stage=detail，且不再强制 refresh（详解也能命中缓存）',
    expandPayload.stage === 'detail' && expandPayload.refresh === undefined,
    JSON.stringify({ stage: expandPayload.stage, refresh: expandPayload.refresh, sent: env.sent.length - beforeExpand }),
  )

  // 偶发失败过：只等"有内容"会在流还没收尾时抢跑，这里等到阶段真正结束再断言
  for (let i = 0; i < 100 && !(env.hook.parts().detail || '').trim(); i += 1) await env.sleep(50)

  for (let i = 0; i < 100 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(50)

  env.assert('第二阶段产出详解', (env.hook.parts().detail || '').trim().length > 0, (env.hook.parts().detail || '').trim().slice(0, 60).replace(/\n/g, ' '))

  env.assert('展开后按钮隐藏、详解卡片出现', env.expandBtn.style.display === 'none' && env.detailCard.style.display !== 'none', `btn=${env.expandBtn.style.display} card=${env.detailCard.style.display}`)

  env.assert('展开后面板切到 detail 阶段', env.panel.getAttribute('data-stage') === 'detail', String(env.panel.getAttribute('data-stage')))

  env.assert(
    '展开后标题仍不带序号',
    !Array.from(env.walk(env.panel)).some((n) => n.tagName === 'B' && /^[①②12]$/.test(env.textOf(n))),
  )

  env.assert('展开后出现追问输入框', !!env.askRow && env.askRow.style.display !== 'none', env.askRow ? env.askRow.style.display : '未找到')

  env.assert('DOM 渲染出两节标题', env.textOf(env.panel).indexOf('翻译') >= 0 && env.textOf(env.panel).indexOf('详解') >= 0)

  env.assert(
    '页眉不再显示模型名（模型只在 composer 的胶囊里）',
    !Array.from(env.walk(env.panelHead)).some((n) => /fixture/.test(env.textOf(n))),
    Array.from(env.walk(env.panelHead)).map((n) => env.textOf(n)).join('|').slice(0, 60),
  )

  env.assert('耗时信息仍有记录（不再上界面，自检可读）', /耗时/.test(String(env.hook.state().status || '')), String(env.hook.state().status))


  // ───────────────────────── 渲染层次（固定输出，离线可验） ─────────────────────────
  env.hook.open('slipped', '', '渲染测试')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) {
    await new Promise((r) => setTimeout(r, 25))
  }

  const translationContent = env.sections[0] && Array.from(env.walk(env.sections[0])).find((n) => n.className === 'dsh-sel-c')

  const detailContent = env.sections[1] && Array.from(env.walk(env.sections[1])).find((n) => n.className === 'dsh-sel-c')


  function classesIn(root, cls) {
    return Array.from(env.walk(root)).filter((node) => node.className.split(' ').indexOf(cls) >= 0)
  }

  const flatLists = classesIn(translationContent, 'dsh-sel-list')

  const levels = flatLists.map((node) => node.getAttribute('data-level'))

  const orderedItems = classesIn(translationContent, 'dsh-sel-item').filter((n) => n.getAttribute('data-num') === '1')

  env.assert('两节各自成卡片（data-sec 标记）', env.sections.length === 2 && env.sections[0].getAttribute('data-sec') === 'translation' && env.sections[1].getAttribute('data-sec') === 'detail')

  env.assert(
    '列表按缩进分级（顶层 + 嵌套各成表，编号切换另起表）',
    levels[0] === '0' && levels.indexOf('1') >= 0,
    '数据级别=' + levels.join(','),
  )

  env.assert('有序列表保留编号', orderedItems.length === 2 && env.textOf(orderedItems[0]).indexOf('1.') === 0, orderedItems.map((n) => env.textOf(n).slice(0, 12)).join(' | '))

  env.assert('小标题走独立子标题节点', classesIn(translationContent, 'dsh-sel-sub').some((n) => env.textOf(n).indexOf('小标题') >= 0))

  env.assert('加粗与行内代码分别成节点', classesIn(translationContent, 'dsh-sel-strong').length >= 2 && classesIn(translationContent, 'dsh-sel-code').length === 1)

  {
    const rendered = Array.from(translationContent.children)
    const echoLine = rendered.find((n) => env.textOf(n) === '滑落；滑倒')
    env.assert(
      '译文回声前缀被剥掉（行首的「- **选中文字**：」被去掉，只留内容）',
      !!echoLine && echoLine.tagName === 'P' && !rendered.some((n) => env.textOf(n) === 'slipped'),
      echoLine ? echoLine.tagName + '：' + env.textOf(echoLine) : rendered.slice(0, 3).map((n) => env.textOf(n)).join(' | '),
    )
    // 带音标的那一行是"词头 + 音标"，词头要留着（否则只剩一串斜杠）
    const ipaLine = rendered.find((n) => env.textOf(n).indexOf('/slɪpt/') >= 0)
    const ipaText = ipaLine ? env.textOf(ipaLine) : ''
    env.assert(
      '带音标的词头行不被剥（词头在前、音标在后，都留着）',
      !!ipaLine && ipaText.indexOf('slipped') >= 0 && ipaText.indexOf('/slɪpt/') > ipaText.indexOf('slipped'),
      ipaText || '未找到音标行',
    )
  }

  const pres = classesIn(detailContent, 'dsh-sel-pre')

  env.assert(
    '围栏代码块渲染（保留原始缩进、不走行内解析）',
    pres.length === 1 && env.textOf(pres[0]).indexOf('npm run build') >= 0,
    pres.length ? JSON.stringify(env.textOf(pres[0])) : '未找到 pre',
  )

  const callouts = classesIn(translationContent, 'dsh-sel-callout')

  {
    // 词头是父项（level 0），词性义项是缩进子项（level 1）——
    // 用户看到的"单词本身和词性一个层级"就是这个层次没拉开
    const lists = classesIn(translationContent, 'dsh-sel-list')
    const levelOf = (list) => list.getAttribute('data-level')
    const itemsAt = (lvl) => lists.filter((n) => levelOf(n) === String(lvl)).flatMap((n) => Array.from(n.children).map((c) => env.textOf(c)))
    const top = itemsAt(0)
    const sub = itemsAt(1)
    env.assert('词头在父级（level 0）', top.some((t) => t.indexOf('slipped') >= 0 && t.indexOf('/slɪpt/') > 0), JSON.stringify(top.slice(0, 3)))
    const hasPos = (t) => /^•?\s*(v\.|adj\.|n\.|adv\.|prep\.|conj\.|pron\.)/.test(t)
    env.assert(
      '词性义项缩进成子级（level 1），父级里没有裸词性行',
      sub.filter(hasPos).length >= 2 && !top.some(hasPos),
      JSON.stringify({ 子级词性行: sub.filter(hasPos).slice(0, 3), 父级: top.slice(0, 3) }),
    )
  }

  env.assert(
    '单词条目带音标：词头加粗、音标原文原样渲染',
    env.textOf(translationContent).indexOf('/slɪpt/') >= 0 && classesIn(translationContent, 'dsh-sel-strong').length > 0,
    env.textOf(translationContent).slice(0, 90),
  )

  env.assert(
    '翻译节结论条高亮渲染（标签胶囊 + 正文）',
    callouts.length === 1 && env.textOf(callouts[0]).indexOf('在本句中') === 0 && env.textOf(callouts[0]).indexOf('被推迟') > 0,
    callouts.length ? env.textOf(callouts[0]).slice(0, 40) : '未找到结论条',
  )

  // 链接：markdown 链接渲染成可点的 a[href]
  const answerLinks = classesIn(detailContent, 'dsh-sel-link')

  env.assert('正文里的 markdown 链接渲染成可点链接', answerLinks.length === 1 && answerLinks[0].getAttribute('href') === 'https://example.com/docs' && env.textOf(answerLinks[0]) === '官方文档', answerLinks.map((n) => env.textOf(n) + '→' + n.getAttribute('href')).join(','))

  env.assert('链接带 target=_blank 与 noopener', answerLinks[0].getAttribute('target') === '_blank' && /noopener/.test(answerLinks[0].getAttribute('rel') || ''), answerLinks[0].getAttribute('rel'))

  const tables = classesIn(detailContent, 'dsh-sel-table')

  const headerCells = tables.length ? classesIn(tables[0], 'dsh-sel-table') : []

  const ths = tables.length ? Array.from(env.walk(tables[0])).filter((n) => n.tagName === 'TH') : []

  const tds = tables.length ? Array.from(env.walk(tables[0])).filter((n) => n.tagName === 'TD') : []

  env.assert(
    '对照表格渲染（表头 2 列 + 2 行数据）',
    tables.length === 1 && tables[0].tagName === 'TABLE' && ths.length === 2 && tds.length === 4,
    `table=${tables.length} th=${ths.length} td=${tds.length}`,
  )

  console.log('\n--- 渲染结构：翻译节 ---')

  console.log(env.outline(translationContent, 0).slice(0, 1200))

  console.log('--- 渲染结构：详解节 ---')

  console.log(env.outline(detailContent, 0).slice(0, 900))


  // ───────────────────────── 共享缓存命中（host 回放） ─────────────────────────
  env.hook.open('shared-cache-probe', '', '缓存测试')

  for (let i = 0; i < 60 && env.hook.state().phase !== 'done'; i += 1) {
    await new Promise((r) => setTimeout(r, 20))
  }

  env.assert(
    '共享缓存命中时状态栏标注「共享缓存」',
    /共享缓存/.test(env.textOf(env.panel)) && env.textOf(env.panel).indexOf('来自共享缓存') >= 0,
    env.textOf(env.panel).match(/完成[^重]{0,40}/)?.[0] || env.textOf(env.panel).slice(0, 40),
  )


  env.assert(
    '右上角是「最近 + 升格 + 设置 + 关闭」四个，没有复制按钮',
    !Array.from(env.walk(env.panelHead)).some((n) => env.textOf(n).indexOf('复制') >= 0) &&
      Array.from(env.walk(env.panelHead)).filter((n) => n.className === 'dsh-sel-icon').length === 1 &&
      // 文字动作键：最近 / 升格 / 设置 —— 三个同款（设置键也带文字，不再是一枚裸图标）
      Array.from(env.walk(env.panelHead)).filter((n) => n.className.indexOf('dsh-sel-action') >= 0).length === 3 &&
      Array.from(env.walk(env.panelHead)).some((n) => n.className.indexOf('dsh-sel-action') >= 0 && env.textOf(n).indexOf('最近') >= 0) &&
      Array.from(env.walk(env.panelHead)).some((n) => n.className.indexOf('dsh-sel-action') >= 0 && env.textOf(n).indexOf('设置') >= 0),
    Array.from(env.walk(env.panelHead)).map((n) => n.className + ':' + env.textOf(n).slice(0, 6)).join(' | '),
  )

  const promoteBtn = Array.from(env.walk(env.panelHead)).find((n) => n.className.indexOf('dsh-sel-action') >= 0 && env.textOf(n).indexOf('升格') >= 0)

  env.assert(
    '升格按钮是自适应宽度的文字按钮（不再挤进 24px 方块）',
    !!promoteBtn && env.textOf(promoteBtn).indexOf('升格') >= 0,
    promoteBtn ? promoteBtn.className + '｜' + env.textOf(promoteBtn) : '未找到',
  )


  // ───────────────────────── 设置（小窗设置抽屉） ─────────────────────────
  // 设计约束（用户明确要求）：设置键与「最近 / 升格」**同款** —— 带边框的文字键、图标 + 文字，
  // 而不是一枚孤零零的裸图标。图标本身走统一 SVG 规范（16 画布 / 14px / stroke 1.5）。
  const settingsBtn = Array.from(env.walk(env.panelHead)).find(
    (n) => n.className.indexOf('dsh-sel-action') >= 0 && env.textOf(n).indexOf('设置') >= 0,
  )

  env.assert(
    '头部有「设置」文字键（不是裸图标）',
    !!settingsBtn && settingsBtn.className.indexOf('dsh-sel-action') >= 0,
    settingsBtn ? settingsBtn.className + '｜' + env.textOf(settingsBtn) : '未找到',
  )

  env.assert(
    '「设置」键的图标与「最近 / 升格」同款（都是 14px 的 SVG，不是 Unicode 字形）',
    !!settingsBtn && !!Array.from(env.walk(settingsBtn)).find((n) => n.tagName === 'SVG' && n.attrs.width === '14'),
    settingsBtn ? Array.from(env.walk(settingsBtn)).map((n) => n.tagName + '/' + (n.attrs.width || '')).join(',') : '未找到',
  )

  // 头部每个图标都得走同一套画布：viewBox 16×16、stroke-width 1.5、linecap round。
  // 混用 Unicode 字形（🕘 ↗ ✕）时这组属性根本不存在 —— 这条断言就是防它回潮。
  {
    const headIcons = []
    for (const btn of env.walk(env.panelHead)) {
      if (btn.tagName !== 'SVG') continue
      headIcons.push(btn)
    }
    const uniform = headIcons.length >= 4 && headIcons.every((svg) =>
      svg.attrs.viewBox === '0 0 16 16' && svg.attrs['stroke-width'] === '1.5' &&
      svg.attrs['stroke-linecap'] === 'round' && svg.attrs.width === '14')
    env.assert(
      '头部所有图标同规范（viewBox 16×16 / 14px / stroke 1.5 / round）',
      uniform,
      headIcons.map((s) => `${s.attrs.width}px,vb=${s.attrs.viewBox},sw=${s.attrs['stroke-width']}`).join(' | ') || '没有 SVG 图标',
    )
  }


  const settingsSheet = Array.from(env.walk(env.panel)).find((n) => n.className === 'dsh-sel-sheet')

  env.assert('抽屉默认是收起的（data-open=0）', !!settingsSheet && settingsSheet.getAttribute('data-open') === '0',
    settingsSheet ? String(settingsSheet.getAttribute('data-open')) : '未找到抽屉')


  // 模型下拉的清单来自 harness 的 /models 桩：默认是**空**的（免得跑用例依赖真实 host），
  // 所以这里先装一份夹具，再开抽屉 —— 否则下拉里只有一行「跟随主会话」。
  globalThis.__modelCatalogFixture = {
    ok: true,
    // current = **当前会话**在用的模型（host 按 sessionId 解析出来给客户端）
    current: { provider: 'p1', model: 'm-fast' },
    stages: { chat: 'high', translation: 'low', detail: 'off' },
    models: [
      { provider: 'p1', providerName: 'Provider One', model: 'm-fast', name: 'Fast Model', efforts: [], defaultEffort: 'high' },
      { provider: 'p1', providerName: 'Provider One', model: 'm-strong', name: 'Strong Model', efforts: [], defaultEffort: 'high' },
      { provider: 'p2', providerName: 'Provider Two', model: 'm-other', name: 'Other Model', efforts: [], defaultEffort: null },
    ],
  }

  // 这套用例打的是**真实 host** 的 /settings，会真的落盘。先清一次覆盖，
  // 保证不管上一次跑成什么样（哪怕中途崩了），这次都从默认值开始 —— 用例要能独立重跑。
  await fetch(env.ORIGIN + '/selection-explain/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  })


  // 点一下：抽屉打开 + 去 host 拉 spec/当前值
  settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })

  await new Promise((r) => setTimeout(r, 30))

  env.assert('点「设置」把抽屉打开', settingsSheet.getAttribute('data-open') === '1',
    String(settingsSheet.getAttribute('data-open')))


  // 等 host 把 spec 拉回来（真实请求，给足时间）
  for (let i = 0; i < 60 && !Array.from(env.walk(settingsSheet)).some((n) => n.className === 'dsh-sel-railbtn'); i += 1) {
    await new Promise((r) => setTimeout(r, 25))
  }

  const settingsRail = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-rail')

  const railButtons = settingsRail ? Array.from(env.walk(settingsRail)).filter((n) => n.className === 'dsh-sel-railbtn') : []

  env.assert(
    '抽屉里按 host 下发的 spec 画出 7 个分类（模型/解读/背景/联网/界面/截图/数据）',
    railButtons.length === 7 && railButtons.some((b) => env.textOf(b).indexOf('模型') >= 0) && railButtons.some((b) => env.textOf(b).indexOf('截图') >= 0),
    railButtons.map((b) => env.textOf(b)).join(' / ') || '一个都没有',
  )

  const settingsRows = Array.from(env.walk(settingsSheet)).filter((n) => n.className === 'dsh-sel-srow')

  env.assert(
    '分类设置均呈现，移除的控件不再出现',
    settingsRows.length >= 20 && !settingsRows.some(r => /输出上限|采样温度|缓存有效期|追问模型/.test(env.textOf(r))),
    `rows=${settingsRows.length}`,
  )


  // 切分类：只有当前分类的 pane 可见（其余 display:none）
  {
    const toolsTab = railButtons.find((b) => env.textOf(b).indexOf('联网') >= 0)
    toolsTab.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 10))
    const panes = Array.from(env.walk(settingsSheet)).filter((n) => n.className === 'dsh-sel-grp')
    const visible = panes.filter((p) => p.style.display !== 'none')
    env.assert(
      '点分类只切出这一类（其余收起）',
      visible.length === 1 && visible[0].getAttribute('data-pane') === 'tools',
      panes.map((p) => p.getAttribute('data-pane') + ':' + (p.style.display === 'none' ? 'off' : 'on')).join(' | '),
    )
  }


  // 改一项开关 → 底部动作栏报"未保存"（不弹 toast、不打断）
  {
    const sw = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sws')
    const note = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sfootnote')
    env.assert('开关与底部状态栏都在', !!sw && !!note, sw ? 'ok' : '没有开关')
    const before = sw.getAttribute('aria-checked')
    sw.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 10))
    env.assert(
      '改一项后立刻标脏（底部报未保存）',
      sw.getAttribute('aria-checked') !== before && note.getAttribute('data-dirty') === '1' &&
        /未保存/.test(env.textOf(note)),
      `checked=${before}→${sw.getAttribute('aria-checked')} dirty=${note.getAttribute('data-dirty')} "${env.textOf(note)}"`,
    )
    const settingInput = label => Array.from(env.walk(settingsSheet)).find(n => n.getAttribute('aria-label') === label)
    env.assert('关闭会话消息开关后，三个上下文输入框禁用',
      ['首轮上下文消息数', '次轮与追问上下文消息数', '上下文总字符上限'].every(label => settingInput(label)?.disabled === true))
    env.assert('解读的会话消息开关不影响引用轮数', settingInput('上下文轮数')?.disabled !== true)
    // 防抖 400ms 后才真的落盘；这里等它发完并回填，避免污染后面用例的状态
    await new Promise((r) => setTimeout(r, 700))
    env.assert('保存完成后底部回到"改动会自动保存"', /改动会自动保存/.test(env.textOf(note)), `"${env.textOf(note)}"`)
    // 改回原值（用户环境不该被测试改掉）
    sw.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 700))
    env.assert('重新开启后，上下文输入框恢复可改', settingInput('首轮上下文消息数')?.disabled === false)
  }


  // 模型：一个下拉同时定 provider + model（不再让用户自己拼两个 id）
  {
    railButtons.find((b) => env.textOf(b).indexOf('模型') >= 0).dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 10))
    const pick = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spick')
    env.assert('模型是自绘下拉的按钮（不是原生 <select>）', !!pick && !Array.from(env.walk(settingsSheet)).some((n) => n.tagName === 'SELECT'),
      pick ? 'button' : '未找到')

    // 清单是异步拉的，等它填进来
    for (let i = 0; i < 80 && Array.from(env.walk(settingsSheet)).filter((n) => n.className === 'dsh-sel-spickrow').length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
    // 列表默认藏着，点按钮才弹出来
    const menu = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spickmenu')
    env.assert('下拉菜单默认收起（data-open=0）', !!menu && menu.getAttribute('data-open') === '0',
      menu ? String(menu.getAttribute('data-open')) : '未找到菜单')
    pick.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 10))
    env.assert('点按钮把下拉弹出来', menu.getAttribute('data-open') === '1', String(menu.getAttribute('data-open')))

    // 三个推理档位按**实际发生顺序**命名：首轮（翻译/解读/注释）→ 次轮详解 → 追问。
    // 顺序本身是信息（用户是照着"小窗先出什么、再出什么"理解这三档的），别改成字母序或历史序。
    {
      const modelPane = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-grp' && n.getAttribute('data-pane') === 'model')
      const labels = Array.from(env.walk(modelPane))
        .filter((n) => n.className === 'dsh-sel-srowt')
        .map((n) => env.textOf(n))
      const first = labels.findIndex((t) => t.indexOf('首轮') >= 0)
      const second = labels.findIndex((t) => t.indexOf('次轮') >= 0)
      const chat = labels.findIndex((t) => t === '追问')
      env.assert('推理三档按「首轮 → 次轮 → 追问」排列',
        first >= 0 && second > first && chat > second,
        labels.join(' / '))
      env.assert('首轮说明包含翻译、解读与注释', env.textOf(modelPane).includes('翻译 / 解读 / 注释'), env.textOf(modelPane))
      env.assert('次轮说明对应展开详解', env.textOf(modelPane).includes('点击「展开详解」'), env.textOf(modelPane))
    }

    // 默认项写「跟随主会话（当前：…）」：括号里必须是**当前会话**在用的那个模型。
    // host 侧 resolveRoute 现在是会话级的（读会话事件流里的 model/selection），
    // 所以两个会话用不同模型时各自看到的也不同 —— 报的就是自己那一个。
    env.assert('默认项写明「跟随主会话」并带出当前会话的模型',
      env.textOf(pick).indexOf('跟随主会话') >= 0 && env.textOf(pick).indexOf('当前') >= 0,
      env.textOf(pick))
    env.assert('括号里的模型来自会话级 /models（夹具的 current，不是全局猜测）',
      env.textOf(pick).indexOf('Fast Model') >= 0,
      env.textOf(pick))

    const rows = Array.from(env.walk(settingsSheet)).filter((n) => n.className === 'dsh-sel-spickrow')
    env.assert('下拉里列出了模型清单 + 一个「跟随主会话」', rows.length >= 4 &&
      env.textOf(rows[0]).indexOf('跟随主会话') >= 0, `rows=${rows.length} first="${rows[0] ? env.textOf(rows[0]) : ''}"`)
    env.assert('下拉菜单挂在抽屉上（不是行里，避开滚动区的裁剪）',
      !!menu && menu.parentNode === settingsSheet,
      menu ? (menu.parentNode ? menu.parentNode.className : '无父节点') : '未找到')

    // 选一个模型 → 应该同时写 provider 与 model 两个键
    const target = rows.find((r) => env.textOf(r).indexOf('Fast Model') >= 0)
    target.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 900))
    const after = await (await fetch(env.ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
    env.assert('选一个模型 = 同时写入 provider 与 model',
      after.values.provider === 'p1' && after.values.model === 'm-fast',
      `provider=${after.values.provider} model=${after.values.model}`)
    env.assert('选完下拉自动收起', menu.getAttribute('data-open') === '0', String(menu.getAttribute('data-open')))
    env.assert('选中的那一行打勾', target.getAttribute('data-on') === '1', String(target.getAttribute('data-on')))

    // 两处模型选择共用一份持久配置。
    {
      const picks = Array.from(env.walk(settingsSheet)).filter(n => n.className === 'dsh-sel-spick')
      env.assert('设置页只保留一个模型选择', picks.length === 1, String(picks.length))
      env.assert('设置选择立即更新输入框模型', env.hook.modelState().choice?.model === 'm-fast', JSON.stringify(env.hook.modelState().choice))
      await env.hook.loadModels(true)
      const composerRows = () => Array.from(env.walk(env.hook.modelNodes().menu)).filter(n => n.className === 'dsh-sel-pickerrow')
      composerRows().find(r => env.textOf(r).includes('Strong Model')).dispatch('click', { preventDefault() {}, stopPropagation() {} })
      env.assert('输入框选择立即更新设置模型', env.textOf(pick).includes('Strong Model'), env.textOf(pick))
      await new Promise(r => setTimeout(r, 900))
      const shared = await (await fetch(env.ORIGIN + '/selection-explain/api/settings')).json()
      env.assert('输入框选择持久保存到统一模型', shared.values.provider === 'p1' && shared.values.model === 'm-strong', JSON.stringify(shared.values))

    }

    // 恢复默认：所有参数**立刻**回到默认并显示出来（含两行模型下拉）。
    // 这里专挑"复合键"踩过的坑：模型行的条目 key 是虚拟的，服务端返回的却是 provider/model，
    // 早先按返回键逐个查条目会查不到 —— 于是恢复默认后模型下拉纹丝不动。
    {
      // 先改几项，制造"非默认"状态
      const pick0 = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spick')
      pick0.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 20))
      const rows0 = Array.from(env.walk(settingsSheet)).filter((n) => n.className === 'dsh-sel-spickrow')
      rows0.find((r) => env.textOf(r).indexOf('Fast Model') >= 0).dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 900))
      env.assert('（前提）已改成一个具体模型', env.textOf(pick0).indexOf('Fast Model') >= 0, env.textOf(pick0))

      const resetBtn = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sbtn' && env.textOf(n).indexOf('恢复默认') >= 0)
      resetBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 900))

      const afterReset = await (await fetch(env.ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
      env.assert('恢复默认：服务端全部回到默认',
        afterReset.values.provider === '' && afterReset.values.model === '' && env.hook.modelState().choice === null,
        `provider=${afterReset.values.provider} chatProvider=${afterReset.values.chatProvider}`)
      // 只看"是不是回到了跟随态"：括号里出现 Fast Model 是正常的 ——
      // 那正是本会话当前在用的模型（夹具的 current），跟随态就该把它报出来。
      env.assert('恢复默认：模型下拉**立刻**显示回「跟随」（不是停在刚才选的）',
        env.textOf(pick0).indexOf('跟随主会话') >= 0,
        env.textOf(pick0))
      // 数字/开关也要回到默认：随便挑一个数字输入框比对
      const ttlRow = Array.from(env.walk(settingsSheet)).find((r) =>
        r.className === 'dsh-sel-srow' && !!Array.from(env.walk(r)).find((n) => n.attrs && n.attrs['aria-label'] === '生成时限'))
      const ttlInput = ttlRow ? Array.from(env.walk(ttlRow)).find((n) => n.className === 'dsh-sel-snum') : null
      env.assert('恢复默认：数字项也回到默认值（600 秒）',
        !!ttlInput && String(ttlInput.value) === String(afterReset.values.timeoutMs / 1000),
        ttlInput ? `${ttlInput.value} vs ${afterReset.values.timeoutMs / 1000}` : '未找到')
    }

    // 真·实时：抽屉**开着不动**，主会话换了模型 → 括号里的名字自己跟着变。
    // （这条是用户报的"还是没有实现"的核心：以前只在开抽屉那一下取一次。）
    {
      const pickEl = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spick')
      const before = env.textOf(pickEl)
      const fixture = globalThis.__modelCatalogFixture
      globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p1', model: 'm-strong' } }
      // 轮询间隔 2000ms，给够两拍
      for (let i = 0; i < 120 && env.textOf(pickEl).indexOf('Strong Model') < 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50))
      }
      env.assert('抽屉开着不动，主会话换模型后括号自己跟着变（轮询生效）',
        env.textOf(pickEl).indexOf('Strong Model') >= 0 && env.textOf(pickEl) !== before,
        `之前"${before}" → 现在"${env.textOf(pickEl)}"`)
      globalThis.__modelCatalogFixture = fixture
      for (let i = 0; i < 120 && env.textOf(pickEl).indexOf('Fast Model') < 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    // 选回「跟随主会话」，别动用户环境
    pick.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 10))
    rows[0].dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 900))
    const restored = await (await fetch(env.ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
    env.assert('选回「跟随主会话」把 provider/model 都清空',
      restored.values.provider === '' && restored.values.model === '',
      `provider=${restored.values.provider} model=${restored.values.model}`)
  }


    // 行为验证（用户报的"没有实时更新"）：换掉会话的模型 → 重开抽屉 → 括号里必须跟着变。
    {
      // pick 是上一个块里的 const，出了块就没了 —— 这里重新按类名取一次
      const pickEl = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spick')
      const backBtn = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sheetback')
      const labelBefore = env.textOf(pickEl)
      // 主会话把模型换成另一个（夹具的 current 就是"本会话在用的模型"）
      const fixture = globalThis.__modelCatalogFixture
      globalThis.__modelCatalogFixture = {
        ...fixture,
        current: { provider: 'p2', model: 'm-other' },
      }
      backBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 20))
      settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      for (let i = 0; i < 80 && env.textOf(pickEl).indexOf('Other Model') < 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25))
      }
      env.assert('重开抽屉后括号里的模型跟着会话变（不是停在第一次渲染）',
        env.textOf(pickEl).indexOf('Other Model') >= 0 && env.textOf(pickEl) !== labelBefore,
        `之前"${labelBefore}" → 现在"${env.textOf(pickEl)}"`)
      globalThis.__modelCatalogFixture = fixture // 还原，别影响后面的用例
      backBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 20))
      settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      for (let i = 0; i < 80 && env.textOf(pickEl).indexOf('Fast Model') < 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25))
      }
    }


    // 用户报的"输入框那枚模型胶囊没有及时刷新"：抽屉**关着**、小窗开着时也要跟。
    // 跟随态下胶囊报的就是"本会话在用的模型"，而以前只在抽屉开着时轮询 ——
    // 于是"小窗开着、主会话换了模型"要等下一次开/关设置页才更新。
    {
      const backBtn = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sheetback')
      backBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 20))
      env.assert('（前提）抽屉收起、小窗还开着、模型是跟随态',
        settingsSheet.getAttribute('data-open') === '0' && env.panel.style.display === 'flex' && env.hook.modelState().choice === null,
        `sheet=${settingsSheet.getAttribute('data-open')} panel=${env.panel.style.display} choice=${JSON.stringify(env.hook.modelState().choice)}`)

      const fixture = globalThis.__modelCatalogFixture
      globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p1', model: 'm-fast' } }
      // 跟随态显示的是清单里的**显示名**（p1/m-fast → Fast Model），不是裸 id
      for (let i = 0; i < 120 && env.hook.modelState().pill.indexOf('Fast Model') < 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50))
      }
      env.assert('抽屉关着：胶囊报出跟随的模型（开窗即对齐，不等第一拍轮询）',
        env.hook.modelState().pill.indexOf('Fast Model') >= 0,
        `pill="${env.hook.modelState().pill}"`)

      // 主会话换模型 —— 一次设置页都不用碰
      globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p2', model: 'm-other' } }
      for (let i = 0; i < 120 && env.hook.modelState().pill.indexOf('Other Model') < 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50))
      }
      env.assert('小窗开着、抽屉关着：主会话换模型后胶囊自己跟着变（轮询生效）',
        env.hook.modelState().pill.indexOf('Other Model') >= 0,
        `pill="${env.hook.modelState().pill}"`)

      // 小窗收起来 → 轮询停：夹具再换值，胶囊不该跟着动（不空转打接口）
      env.hook.close()
      await new Promise((r) => setTimeout(r, 20))
      globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p1', model: 'm-fast' } }
      await new Promise((r) => setTimeout(r, 2600))
      env.assert('小窗与抽屉都收了：轮询停下（值不再跟着变）',
        env.hook.modelState().pill.indexOf('Other Model') >= 0,
        `pill="${env.hook.modelState().pill}"`)
      globalThis.__modelCatalogFixture = fixture
    }


    // 用户报的"为什么显示 deepseek-flash"：同一个 model id 在**多个 provider** 下名字不同
    // （实测 deepseek-flash 在 opencode-go 叫「DeepSeek Flash」、在 deepseek-official 叫
    //  「DeepSeek-V41-Flash」）—— 跟随态必须按 provider + model 两个键换成显示名：
    // 既不能显示裸 id，也不能取到别的 provider 的名字。
    // 这条同时验"开窗顺手拉清单"：切到另一个会话（清单缓存按会话隔离）后只开窗、不碰模型菜单，
    // 胶囊也该自己变成显示名。
    {
      const fixture = globalThis.__modelCatalogFixture
      globalThis.__modelCatalogFixture = {
        ok: true,
        current: { provider: 'p2', model: 'shared-id' },
        stages: { chat: 'high' },
        models: [
          { provider: 'p1', providerName: 'P1', model: 'shared-id', name: 'P1 的那个名字', efforts: [], defaultEffort: null },
          { provider: 'p2', providerName: 'DeepSeek', model: 'shared-id', name: 'DeepSeek-V41-Flash', efforts: [], defaultEffort: null },
        ],
      }
      // 换个会话：清单缓存按会话隔离，这样开窗那一下必须真去拉一次（而不是复用旧缓存）
      globalThis.__sessionStubId = 'session-stub-2'
      env.hook.open('同名模型探测', '', '同名模型')
      for (let i = 0; i < 120 && env.hook.modelState().pill.indexOf('DeepSeek-V41-Flash') < 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50))
      }
      env.assert('跟随态显示清单里的显示名，不再是裸 id',
        env.hook.modelState().pill.indexOf('DeepSeek-V41-Flash') >= 0 && env.hook.modelState().pill.indexOf('shared-id') < 0,
        `pill="${env.hook.modelState().pill}"`)
      env.assert('同一个 model id 不会取到别的 provider 的名字（按 provider + model 查）',
        env.hook.modelState().pill.indexOf('P1 的那个名字') < 0,
        `pill="${env.hook.modelState().pill}"`)
      env.assert('胶囊 tooltip 带上 provider（同名 id 靠它区分）',
        String(env.hook.modelNodes().pill.title || '').indexOf('DeepSeek') >= 0,
        `title="${env.hook.modelNodes().pill.title}"`)
      globalThis.__sessionStubId = 'session-stub-1'
      globalThis.__modelCatalogFixture = fixture
      env.hook.close()
      await new Promise((r) => setTimeout(r, 30))
    }



  // 保存后的设置必须影响入口、状态胶囊和实际选区处理，而不只改变显示值。
  {
    const inputFor = label => Array.from(env.walk(settingsSheet)).find(n => n.getAttribute('aria-label') === label)
    const setNumber = async (label, value) => {
      const input = inputFor(label)
      input.value = String(value)
      input.dispatch('input', { stopPropagation() {}, preventDefault() {} })
      await new Promise(r => setTimeout(r, 700))
    }
    const clickSwitch = async label => {
      inputFor(label).dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise(r => setTimeout(r, 700))
    }
    await setNumber('选中文字上限', 6000)
    env.hook.close()
    const originalText = env.selection.toString
    env.selection.toString = () => '长'.repeat(4500)
    env.documentStub.dispatch('mouseup', { target: env.body })
    await new Promise(r => setTimeout(r, 20))
    env.assert('选中文字上限调到 6000 后，4500 字选区能显示解读入口', env.button.style.display === 'inline-flex')
    await setNumber('选中文字上限', 20)
    env.selection.toString = () => '长'.repeat(21)
    env.documentStub.dispatch('mouseup', { target: env.body })
    await new Promise(r => setTimeout(r, 20))
    env.assert('选中文字上限调到 20 后，21 字选区不显示入口', env.button.style.display === 'none')
    await setNumber('选中文字上限', 4000)
    env.selection.toString = originalText

    const frame = new env.FakeEl('iframe')
    frame.setAttribute('data-html-preview', 'true'); frame.setAttribute('sandbox', ''); frame.setAttribute('srcdoc', '<p>入口测试</p>')
    frame.isConnected = true; frame.contentWindow = {name:'settings-bridge-test'}
    const oldQuery = env.documentStub.querySelectorAll
    env.documentStub.querySelectorAll = selector => selector === 'iframe' ? [frame] : []
    env.hook.bridgeScan(); env.hook.reset()
    const reportSelection = () => env.windowStub.dispatch('message', {source:frame.contentWindow,data:{__dshSel:1,kind:'selection',sel:{text:'入口测试',context:'',rect:{x:10,y:20,right:100,bottom:38,w:90,h:18}}}})
    await clickSwitch('侧边栏网页划词'); reportSelection()
    env.assert('关闭侧边栏划词后，已有桥发来的选区也不打开入口', env.hook.bridge().on === false && env.hook.selection() === null)
    await clickSwitch('侧边栏网页划词'); reportSelection()
    env.assert('重新开启侧边栏划词后，帧内选区恢复入口', env.hook.bridge().on === true && env.hook.selection()?.source === 'iframe' && env.button.style.display === 'inline-flex')
    frame.isConnected = false; env.documentStub.querySelectorAll = oldQuery; env.hook.reset()

    await clickSwitch('显示状态胶囊')
    env.assert('关闭状态胶囊保存后实际隐藏', env.hook.pill().style.display === 'none')
    await clickSwitch('显示状态胶囊')
    env.assert('开启状态胶囊保存后恢复显示', env.hook.pill().style.display !== 'none')
    const actualSetTimeout = globalThis.setTimeout
    const scheduledDelays = []
    globalThis.setTimeout = (fn, delay, ...args) => {
      scheduledDelays.push(delay)
      return actualSetTimeout(fn, delay, ...args)
    }
    try { await setNumber('自动收起时间', 5) }
    finally { globalThis.setTimeout = actualSetTimeout }
    env.assert('自动收起时间实际更新胶囊计时偏好', env.hook.pillState().idleMs === 5000)
    env.assert('修改自动收起时间后，已有计时立即按新时长重新安排', scheduledDelays.includes(5000))
    await setNumber('自动收起时间', 10)
    env.hook.open('settings-return', '', '设置验证')
    await new Promise(r=>setTimeout(r,80))
    settingsBtn.dispatch('click', {stopPropagation(){},preventDefault(){}})
    await new Promise(r=>setTimeout(r,20))
  }


  // 时间字段按「秒」显示：配置里仍是毫秒（scale 只管显示）
  {
    railButtons.find((b) => env.textOf(b).indexOf('数据') >= 0).dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 10))
    const units = Array.from(env.walk(settingsSheet))
      .filter((n) => n.className === 'dsh-sel-sunit')
      .map((n) => env.textOf(n))
    env.assert('时间字段的单位是「秒」而不是「毫秒」',
      units.filter((u) => u === '秒').length >= 2 && units.indexOf('毫秒') < 0,
      units.join(' / '))

    // 生成时限按秒显示，host 仍存毫秒
    const cacheSpec = await (await fetch(env.ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
    const rowInput = (key) => {
      const rowEl = Array.from(env.walk(settingsSheet)).find((r) =>
        r.className === 'dsh-sel-srow' && !!Array.from(env.walk(r)).find((n) => n.attrs && n.attrs['aria-label'] === key))
      return rowEl ? Array.from(env.walk(rowEl)).find((n) => n.className === 'dsh-sel-snum') : null
    }
    const cacheInput = rowInput('生成时限')
    env.assert('生成时限的毫秒 → 秒换算正确',
      !!cacheInput && String(cacheInput.value) === String(cacheSpec.values.timeoutMs / 1000),
      cacheInput ? `${cacheInput.value} vs ${cacheSpec.values.timeoutMs / 1000}` : '未找到输入框')

    // 在界面里改成 120 秒 → 配置里应存 120000 毫秒
    cacheInput.value = '120'
    cacheInput.dispatch('input', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 900))
    const saved = await (await fetch(env.ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
    env.assert('界面填 120 秒 = 配置存 120000 毫秒',
      saved.values.timeoutMs === 120000, String(saved.values.timeoutMs))
    // 还原（改回 600 秒）
    cacheInput.value = '300'
    cacheInput.dispatch('input', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 900))
  }


  // 收尾：这套断言打的是**真实 host** 的 /settings，会真的落盘到
  // ${DSH_HOME:-~/.dsh}/selection-explain/settings.json。跑完必须清掉覆盖，
  // 否则跑一次测试就在用户环境里留下一份 settings.json（值等于默认，但仍是脏状态）。
  {
    const resetRes = await fetch(env.ORIGIN + '/selection-explain/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    })
    const resetBody = await resetRes.json().catch(() => null)
    env.assert('测试收尾：清掉设置覆盖，不留 settings.json 残留',
      !!resetBody && resetBody.ok === true && resetBody.values.historyMaxEntries === 20,
      JSON.stringify(resetBody && { ok: resetBody.ok, history: resetBody.values && resetBody.values.historyMaxEntries }))
  }


  // Esc 只退一层：先收抽屉，小窗留着
  {
    const before = env.panel.style.display
    env.documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 10))
    env.assert(
      'Esc 先收抽屉、不关小窗（一次只退一层）',
      settingsSheet.getAttribute('data-open') === '0' && env.panel.style.display === before,
      `sheet=${settingsSheet.getAttribute('data-open')} panel=${env.panel.style.display}`,
    )
  }


  // 用户报的"模型列表上没有标示当前正在使用的模型"：跟随态（没选过具体模型）下，输入框那枚
  // 模型菜单里**会话正在用的那个**也要打勾 —— 以前只认"自己选过的"，跟随态一行都不勾。
  // 放在这里是因为：再往后的用例只在"本机 DSH 跑在 3080"时才执行，而 test-settings-host.mjs
  // 会在下面那个 exit 处收工 —— 放这儿才进得了 `npm test`。
  {
    const fixture = globalThis.__modelCatalogFixture
    globalThis.__modelCatalogFixture = {
      ok: true,
      current: { provider: 'p1', model: 'm-fast' },
      stages: { chat: 'high' },
      models: [
        { provider: 'p1', providerName: 'P1', model: 'm-fast', name: 'Fast Model', efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
        { provider: 'p1', providerName: 'P1', model: 'm-strong', name: 'Strong Model', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
        { provider: 'p2', providerName: 'P2', model: 'm-other', name: 'Other Model', efforts: [], defaultEffort: null },
      ],
    }
    env.hook.open('菜单勾选探测', '', '菜单勾选')
    await new Promise((r) => setTimeout(r, 30))
    await env.hook.loadModels(true)
    const menu = env.hook.modelNodes().menu
    const rowsIn = () => Array.from(env.walk(menu)).filter((n) => String(n.className) === 'dsh-sel-pickerrow')
    const tiersIn = () => Array.from(env.walk(menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn')
    env.assert('（前提）跟随态：没选过具体模型', env.hook.modelState().choice === null, JSON.stringify(env.hook.modelState().choice))
    const on = rowsIn().filter((r) => r.getAttribute('data-on') === '1')
    env.assert('跟随态：清单里当前在用的模型也打勾（不再是"一行都不勾"）',
      on.length === 1 && env.textOf(on[0]).indexOf('Fast Model') >= 0,
      on.map((r) => env.textOf(r)).join(' | ') || '没有任何一行打勾')
    env.assert('跟随态那一行带「跟随」小标（这个勾来自主会话，不是自己选的）',
      !!on[0] && !!Array.from(env.walk(on[0])).find((n) => String(n.className) === 'dsh-sel-pickerfollow' && env.textOf(n) === '跟随'),
      on[0] ? Array.from(env.walk(on[0])).map((n) => String(n.className) + ':' + env.textOf(n)).join(', ') : '未找到')
    env.assert('档位按钮 = 与设置页同一套四个格子（关/低/高/最高，与模型无关）',
      tiersIn().map((b) => env.textOf(b)).join('/') === '关/低/高/最高', tiersIn().map((b) => env.textOf(b)).join('/'))

    // 选一个具体模型：勾挪到那一行、「跟随」小标消失、档位收缩成它声明的那几档
    const strong = rowsIn().find((r) => env.textOf(r).indexOf('Strong Model') >= 0)
    strong.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 30))
    const on2 = rowsIn().filter((r) => r.getAttribute('data-on') === '1')
    env.assert('选过之后：勾挪到选中的那一行',
      on2.length === 1 && env.textOf(on2[0]).indexOf('Strong Model') >= 0,
      on2.map((r) => env.textOf(r)).join(' | '))
    env.assert('选过之后：「跟随」小标消失（这个勾是你自己选的）',
      !Array.from(env.walk(menu)).some((n) => String(n.className) === 'dsh-sel-pickerfollow'), '')
    env.assert('选过之后：档位仍是那四个格子（换模型不改词汇，只改它落到哪个档）',
      tiersIn().map((b) => env.textOf(b)).join('/') === '关/低/高/最高', tiersIn().map((b) => env.textOf(b)).join('/'))

    // 还原：走抽屉里那颗「恢复默认」（客户端自己的路径，state 与 host 都回到跟随态）
    await new Promise((r) => setTimeout(r, 700))
    const resetBtn = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sbtn' && env.textOf(n).indexOf('恢复默认') >= 0)
    resetBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 900))
    const back = await (await fetch(env.ORIGIN + '/selection-explain/api/settings', { headers: { accept: 'application/json' } })).json()
    env.assert('（还原）恢复默认：host 与客户端都回到跟随态',
      back.values.provider === '' && back.values.model === '' && env.hook.modelState().choice === null,
      JSON.stringify({ provider: back.values.provider, model: back.values.model, choice: env.hook.modelState().choice }))
    globalThis.__modelCatalogFixture = fixture
    env.hook.close()
    await new Promise((r) => setTimeout(r, 30))
  }


  // ── 设置页「思考强度」：四个格子不变，下面那行**跟着当前模型**说清落到哪一档 ──
  //   映射由 host 按模型声明实时算（`/models` 每个模型带 `effortMap`）；这里验客户端把它显示对了、
  //   换模型会跟着变、模型不支持推理时说清"这一组不生效"。
  {
    const fixture = globalThis.__modelCatalogFixture
    const weird = {
      provider: 'p2', providerName: 'Provider Two', model: 'm-weird', name: 'Weird Model',
      // 词汇表长得不一样：没有 off、顶档叫 xhigh（本机 grok-4.6 就是这种）
      efforts: [
        { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' }, { id: 'xhigh', name: 'Xhigh' },
      ],
      defaultEffort: null, hasReasoning: true,
      effortMap: { off: 'low', low: 'medium', high: 'high', max: 'xhigh' },
    }
    const plain = {
      provider: 'p2', providerName: 'Provider Two', model: 'm-plain', name: 'Plain Model',
      efforts: [], defaultEffort: null, hasReasoning: false, effortMap: {},
    }
    globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p2', model: 'm-weird' }, models: [...fixture.models, weird, plain] }

    // 开抽屉（每次都强制重取清单）→ 那行提示应当报出这个模型的落点
    settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    const hintNode = () => Array.from(env.walk(settingsSheet)).find((n) => n.getAttribute && n.getAttribute('data-effortmap') === '1')
    for (let i = 0; i < 40 && (!hintNode() || hintNode().textContent.indexOf('xhigh') < 0); i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    // 拿小写比：右边是**模型自己的档位名**（Off/Low/Xhigh…），大小写不保证
    const hintText = String((hintNode() || {}).textContent || '')
    const hintLower = hintText.toLowerCase()
    env.assert(
      '四格还在（关/低/高/最高 四个格子没变），下面多一行实时映射',
      !!hintNode() && String(hintNode().className).indexOf('dsh-sel-effortmap') >= 0,
      hintText,
    )
    env.assert(
      '映射说的是**当前模型**的真实档位（关→low · 低→medium · 高→high · 最高→xhigh）',
      hintLower.indexOf('关 → low') >= 0 && hintLower.indexOf('低 → medium') >= 0 &&
        hintLower.indexOf('高 → high') >= 0 && hintLower.indexOf('最高 → xhigh') >= 0,
      hintText,
    )
    env.assert('四格本身一个不多一个不少（没有被模型带跑）', (hintText.match(/→/g) || []).length === 4, hintText)

    // **从抽屉自己的模型下拉里换模型**（用户报的那条路径：原来只有胶囊跟着变，这行不动）
    {
      const pick = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-spick')
      pick.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 30))
      const plainRow = Array.from(env.walk(settingsSheet))
        .filter((n) => n.className === 'dsh-sel-spickrow')
        .find((r) => env.textOf(r).indexOf('Plain Model') >= 0)
      env.assert('（前提）下拉里能找到另一个模型', !!plainRow, env.textOf(pick))
      plainRow.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      for (let i = 0; i < 60 && String((hintNode() || {}).textContent || '').indexOf('不支持思考强度') < 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50))
      }
      env.assert(
        '从设置页的模型下拉换模型：那行映射立刻跟着换（不再只有胶囊变）',
        String((hintNode() || {}).textContent || '').indexOf('不支持思考强度') >= 0,
        String((hintNode() || {}).textContent || ''),
      )
      // 走客户端自己的「恢复默认」把模型写回跟随态（别把真实配置留在具体模型上）
      const resetBtn = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sbtn' && env.textOf(n).indexOf('恢复默认') >= 0)
      resetBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 900))
    }

    // 换成"明确不支持推理"的模型 → 说清这一组不生效（而不是假装能选）
    globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p2', model: 'm-plain' }, models: [...fixture.models, weird, plain] }
    const backBtn2 = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sheetback')
    backBtn2.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 20))
    settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    for (let i = 0; i < 40 && String((hintNode() || {}).textContent || '').indexOf('不支持思考强度') < 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    env.assert(
      '模型不支持推理时：这行如实说"不生效（不会发送档位）"',
      String((hintNode() || {}).textContent || '').indexOf('不支持思考强度') >= 0,
      String((hintNode() || {}).textContent || ''),
    )

    // 两边**同词同源**：小窗那个档位控件与设置页「思考强度 · 追问」都是同一套四个格子，
    //   读写同一个配置值（chatReasoningEffort），于是不需要任何反向映射
    {
      env.hook.openModel()
      await new Promise((r) => setTimeout(r, 30))
      const tierBtns = () => Array.from(env.walk(env.hook.modelNodes().menu)).filter((n) => String(n.className) === 'dsh-sel-tierbtn')
      env.assert(
        '小窗的档位按钮 = 设置页那四个格子（关/低/高/最高）',
        tierBtns().map((b) => env.textOf(b)).join('/') === '关/低/高/最高',
        tierBtns().map((b) => env.textOf(b)).join('/'),
      )
      env.assert('每个格子带自己的 slot 记号（不是模型档位 id）',
        tierBtns().map((b) => b.getAttribute('data-slot')).join('/') === 'off/low/high/max',
        tierBtns().map((b) => b.getAttribute('data-slot')).join('/'))

      // 小窗里点「高」→ 设置页那一行同一格 + 内存里就是同一个值
      const highBtn = tierBtns().find((b) => env.textOf(b) === '高')
      highBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
      await new Promise((r) => setTimeout(r, 30))
      env.assert('（前提）小窗记下了这一格', env.hook.modelState().effort === 'high', String(env.hook.modelState().effort))
      settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 60))
      const segOf = () => Array.from(env.walk(settingsSheet)).find(
        (n) => String(n.className) === 'dsh-sel-seg' && n.attrs && n.attrs['aria-label'] === '追问',
      )
      env.assert(
        '小窗点「高」→ 设置页那一行也是「高」（同一份数据，不需要映射）',
        !!segOf() && segOf().getAttribute('data-value') === 'high',
        segOf() ? String(segOf().getAttribute('data-value')) : '(未找到)',
      )

      // 反向：设置页点「低」→ 小窗那四个格子（菜单开着时）也跟着换
      const segCells = Array.from(env.walk(segOf())).filter((n) => String(n.className) === 'dsh-sel-segcell')
      const lowCell = segCells.find((c) => c.getAttribute('data-value') === 'low')
      lowCell.dispatch('click', { preventDefault() {}, stopPropagation() {} })
      await new Promise((r) => setTimeout(r, 30))
      env.assert('设置页点「低」→ 小窗也是同一格', env.hook.modelState().effort === 'low', String(env.hook.modelState().effort))
      env.assert(
        '小窗菜单里的选中态跟着换（不必重开菜单）',
        Array.from(env.walk(env.hook.modelNodes().menu))
          .filter((n) => String(n.className) === 'dsh-sel-tierbtn' && n.getAttribute('data-on') === '1')
          .map((b) => env.textOf(b))
          .join('/') === '低',
        Array.from(env.walk(env.hook.modelNodes().menu)).filter((n) => n.getAttribute && n.getAttribute('data-on') === '1').map((b) => env.textOf(b)).join('/'),
      )

      // 词汇很怪的模型也一样只列四个格子 —— 这正是"不需要反向映射"的证明
      globalThis.__modelCatalogFixture = { ...fixture, current: { provider: 'p2', model: 'm-weird' }, models: [...fixture.models, weird, plain] }
      const backToPanel = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sheetback')
      backToPanel.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 20))
      settingsBtn.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 80))
      env.hook.openModel()
      await new Promise((r) => setTimeout(r, 30))
      env.assert(
        '模型声明 minimal/xhigh 这种怪档位时，小窗仍然只列四个格子（不再出现 Xhigh/Medium）',
        tierBtns().map((b) => env.textOf(b)).join('/') === '关/低/高/最高' &&
          !tierBtns().some((b) => String(b.title).indexOf('Xhigh') >= 0 && !String(b.title).indexOf('该模型发')),
        tierBtns().map((b) => env.textOf(b) + (b.title ? '(' + String(b.title) + ')' : '')).join(' / '),
      )

      // 收尾：恢复默认（写回跟随态）、收起抽屉与面板
      const resetBtn2 = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sbtn' && env.textOf(n).indexOf('恢复默认') >= 0)
      resetBtn2.dispatch('click', { stopPropagation() {}, preventDefault() {} })
      await new Promise((r) => setTimeout(r, 900))
      env.hook.close()
      await new Promise((r) => setTimeout(r, 30))
    }

    // 收尾：抽屉还原、夹具还原（别影响后面的用例）
    const backBtn3 = Array.from(env.walk(settingsSheet)).find((n) => n.className === 'dsh-sel-sheetback')
    backBtn3.dispatch('click', { stopPropagation() {}, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 20))
    globalThis.__modelCatalogFixture = fixture
  }

  // ───────────────────────── 升格为正式会话 ─────────────────────────
  // 先走一遍两阶段（翻译 → 展开详解），确保升格时取的是两个阶段的结果而不是最后一段流
  env.hook.open('stage-probe', '', '分阶段')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await new Promise((r) => setTimeout(r, 20))

  env.hook.expand()

  for (let i = 0; i < 80 && !(env.hook.parts().detail || '').trim(); i += 1) await new Promise((r) => setTimeout(r, 20))

  env.assert(
    '两阶段各自的结果都留存（raw 只会有最后一段）',
    (env.hook.parts().translation || '').indexOf('STAGE-TRANSLATION') >= 0 && (env.hook.parts().detail || '').indexOf('STAGE-DETAIL') >= 0,
    JSON.stringify(env.hook.parts()),
  )


  const promoteButton = Array.from(env.walk(env.panelHead)).find((n) => n.className.indexOf('dsh-sel-action') >= 0 && env.textOf(n).indexOf('升格') >= 0)

  promoteButton.dispatch('click', { stopPropagation() {} })
  for (let i = 0; i < 60 && env.promoted.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 20))
  }

  for (let i = 0; i < 60 && env.openedSessions.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 20))
  }

  const promotePayload = env.promoted[0] || {}

  env.assert(
    '升格请求带上两节结论（分阶段取，翻译不丢）',
    !!promotePayload.text &&
      (promotePayload.translation || '').indexOf('STAGE-TRANSLATION') >= 0 &&
      (promotePayload.detail || '').indexOf('STAGE-DETAIL') >= 0 &&
      Array.isArray(promotePayload.turns),
    JSON.stringify({ t: (promotePayload.translation || '').slice(0, 20), d: (promotePayload.detail || '').slice(0, 20) }),
  )

  env.assert('升格请求剔除种子轮次（seed 不入正式会话）', !(promotePayload.turns || []).some((t) => t.seed === true))

  env.assert('升格后跳到新会话', env.openedSessions[0] === 'session-promoted-1', JSON.stringify(env.openedSessions))

  env.assert('升格结果仍有记录（自检可读）', /已升格/.test(String(env.hook.state().status || '')), String(env.hook.state().status))

  for (let i = 0; i < 60 && env.panel.style.display !== 'none'; i += 1) {
    await new Promise((r) => setTimeout(r, 20))
  }

  env.assert('升格后小窗自动关闭', env.panel.style.display === 'none', 'display=' + env.panel.style.display)


}
