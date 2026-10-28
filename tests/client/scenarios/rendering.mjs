

import { readFileSync } from 'node:fs'



export async function run(env) {

  env.hook.close()

  env.assert('页脚不再有档位开关', !Array.from(env.walk(env.panel)).some((n) => /深入|快速/.test(env.textOf(n)) && n.className === 'dsh-sel-more'))

  {
    const quoteEl = Array.from(env.walk(env.panel)).find((n) => n.className === 'dsh-sel-quote')
    const bodyEl = Array.from(env.walk(env.panel)).find((n) => n.className === 'dsh-sel-body')
    env.assert('选中文字条在滚动区里（跟着消息一起滚，不再钉在顶部）', !!quoteEl && !!bodyEl && quoteEl.parentNode === bodyEl, quoteEl ? String(quoteEl.parentNode && quoteEl.parentNode.className) : '未找到')
    env.assert('选中文字条是滚动区的第一项（在最顶端，不在消息后面）', !!bodyEl && bodyEl.children[0] === quoteEl, bodyEl ? bodyEl.children.map((n) => n.className).join(' > ') : '')
    // CSS 契约（桩环境不跑样式，直接查产物里的规则文本）
    const cssText = readFileSync(env.BUNDLE, 'utf8')
    env.assert('选中文字条不被 flex 压扁（flex:0 0 auto）', /\.dsh-sel-quote\{[^']*flex:0 0 auto/.test(cssText), '')
    env.assert('选中文字条可自动换行 + 上限内滚动', /\.dsh-sel-quote\{[\s\S]{0,900}?white-space:pre-wrap/.test(cssText) && /\.dsh-sel-quote\{[\s\S]{0,900}?max-height:84px/.test(cssText), '')
    env.assert('选中文字条不显示滚动条', /\.dsh-sel-quote::-webkit-scrollbar/.test(cssText) && /display:none/.test(cssText) && /\.dsh-sel-quote\{[\s\S]{0,900}?scrollbar-width:none/.test(cssText), '')
  }


  // ───────────────────────── 工具调用：只进上下文，不进小窗 ─────────────────────────
  // 明确要求：小窗里只允许出现"模型处理后的结果"。工具日志（卡片、查询词、命中字数、
  // 预览原文、链接、耗时）一律不渲染——它们只是模型的原料。
  env.hook.open('tool-probe', '', '工具测试')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.assert(
    '页脚不再报"用过 N 次工具"',
    !/用过/.test(env.textOf(env.panel)),
    env.textOf(env.panel).match(/完成[^重]{0,50}/)?.[0] || env.textOf(env.panel).slice(0, 60),
  )

  env.assert('小窗里没有工具卡片容器', !Array.from(env.walk(env.panel)).some((n) => n.className === 'dsh-sel-toollog'), 'dsh-sel-toollog')


  const toolText = env.textOf(env.panel)

  env.assert('面板里没有工具卡片节点', !Array.from(env.walk(env.panel)).some((n) => /^dsh-sel-tool/.test(n.className)), '')

  env.assert('查询词不进小窗', toolText.indexOf('MCP 协议') < 0, toolText.slice(0, 80))

  env.assert('命中字数/耗时不进小窗', !/420 字/.test(toolText) && !/1\.8s/.test(toolText), '')

  env.assert('工具结果预览不进小窗', toolText.indexOf('Model Context Protocol') < 0 && toolText.indexOf('modelcontextprotocol.io') < 0, '')

  env.assert('工具名不进小窗', toolText.indexOf('联网搜索') < 0 && toolText.indexOf('web_search') < 0, '')

  env.assert('内部仍记录工具调用（供自检与上下文）', env.hook.state().tools === 1, String(env.hook.state().tools))

  env.assert('工具摘要仍生成（追问时带给模型）', /联网搜索/.test(env.hook.state().toolDigest) && /MCP/.test(env.hook.state().toolDigest), env.hook.state().toolDigest.slice(0, 60))


  env.hook.ask('那它和 LSP 有什么关系？')

  for (let i = 0; i < 80 && env.textOf(env.chatLog).indexOf('这是对追问的回答') < 0; i += 1) await env.sleep(20)

  const digPayload = env.sent[env.sent.length - 1]

  env.assert('追问请求带上 toolDigest', typeof digPayload.toolDigest === 'string' && digPayload.toolDigest.indexOf('MCP') >= 0, String(digPayload.toolDigest || '').slice(0, 60))


  // 检索**正在进行**时：只有一句"正在检索资料"，查询词/预览/链接仍然一个字都不出现
  env.hook.open('tool-live-probe', '', '检索中')

  let busySeen = false

  let busyHint = ''

  let busyText = ''

  for (let i = 0; i < 60 && env.hook.state().phase !== 'done'; i += 1) {
    await env.sleep(20)
    if (env.hook.state().toolBusy) {
      busySeen = true
      busyText = env.textOf(env.panel)
      const hint = Array.from(env.walk(env.panel)).find((n) => n.className === 'dsh-sel-waithint')
      if (hint && env.textOf(hint).indexOf('正在检索资料') >= 0) busyHint = env.textOf(hint)
    }
  }

  env.assert('检索期间有"正在检索资料"提示', busySeen && busyHint.indexOf('正在检索资料') >= 0, `busy=${busySeen} hint=${busyHint}`)

  env.assert('检索期间也不显示查询词', busyText.indexOf('检索中的查询词') < 0, busyText.slice(0, 80))

  env.assert('检索期间也不显示结果链接', busyText.indexOf('secret-source') < 0, '')

  env.assert('检索结束后清掉检索标记', env.hook.state().toolBusy === false, String(env.hook.state().toolBusy))

  env.assert('检索完成后正文照常显示', env.textOf(env.sections[0]).indexOf('模型消化后的结论') >= 0, env.textOf(env.sections[0]).slice(0, 60))


  // 等待提示里的"推理档位"必须是**这次真正用的档位**：
  // 等待节点是在 start 事件之前建的，那里只能实时读，不能用创建时的兜底值。
  env.hook.open('effort-hint-probe', '', '档位提示')

  let effortHint = ''

  for (let i = 0; i < 70 && env.hook.state().phase !== 'done'; i += 1) {
    await env.sleep(200)
    const hint = Array.from(env.walk(env.panel)).find((n) => n.className === 'dsh-sel-waithint')
    if (hint && /推理档位/.test(env.textOf(hint))) { effortHint = env.textOf(hint); break }
  }

  env.assert('等待提示显示本次实际推理档位', /推理档位 max/.test(effortHint), effortHint || '未出现档位提示')

  for (let i = 0; i < 40 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(100)


  // ───────────────────────── 工具轮里的"过程旁白"不许当正文 ─────────────────────────
  env.hook.open('narrate-probe', '', '旁白探测')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  {
    const answer = String(env.hook.parts().translation || '')
    env.assert(
      '工具轮里的旁白被撤回（不进答案正文，一个字都不留）',
      answer.indexOf('I have') < 0 && answer.indexOf('Maybe I should search') < 0,
      answer.slice(0, 80),
    )
    env.assert('撤回后正式结论照常显示', answer.indexOf('这是撤回旁白之后的正式结论') >= 0, answer.slice(0, 80))
    env.assert(
      '旁白转成了思考尾巴（还能看到它在想什么）',
      String(env.hook.state().thought || '').indexOf('Maybe I should search') >= 0,
      String(env.hook.state().thought || '').slice(0, 60),
    )
    env.assert(
      '结束后等待节点被清掉（旁白不会留在界面上）',
      !Array.from(env.walk(env.sections[0])).some((n) => n.className === 'dsh-sel-waithint'),
      Array.from(env.walk(env.sections[0])).filter((n) => n.className === 'dsh-sel-waithint').map((n) => env.textOf(n)).join('|'),
    )
  }

  // text 对不上时退化成按字数撤（兜底路径）
  env.hook.open('narrate-fallback-probe', '', '兜底探测')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  {
    const answer = String(env.hook.parts().translation || '')
    env.assert(
      'drop 的 text 对不上时按字数兜底撤回（一个字都不剩）',
      answer.indexOf('NARRATION') < 0 && answer.indexOf('兜底撤回后的结论') >= 0,
      JSON.stringify(answer.slice(0, 60)),
    )
  }


  // 追问里同样要撤（askBox/chatLog 在这一节已就绪）
  await env.sleep(20)

  env.hook.ask('旁白追问')

  for (let i = 0; i < 80 && env.textOf(env.chatLog).indexOf('这是追问的正式回答') < 0; i += 1) await env.sleep(20)

  {
    const bubbleText = env.textOf(env.chatLog)
    env.assert('追问气泡里也撤掉了旁白', bubbleText.indexOf('Let me think') < 0, bubbleText.slice(-120))
    env.assert('追问的正式回答保留', bubbleText.indexOf('这是追问的正式回答') >= 0, bubbleText.slice(-120))
  }


  // ───────────────────────── AI 回复里的网页：定稿后实时渲染成 iframe ─────────────────────────
  env.hook.open('html-probe', '', '网页预览')

  await env.sleep(150)

  {
    const during = Array.from(env.walk(env.sections[0])).filter((n) => n.className === 'dsh-sel-preview')
    env.assert('流式期间只给源码、不建 iframe（避免每帧重载闪白）', during.length === 0, `preview=${during.length}`)
  }

  for (let i = 0; i < 120 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  {
    const blocks = Array.from(env.walk(env.sections[0])).filter((n) => n.className === 'dsh-sel-preview')
    env.assert('定稿后渲染出网页预览块', blocks.length === 1, `preview=${blocks.length}`)
    const block = blocks[0]
    const frame = block ? Array.from(env.walk(block)).find((n) => n.className === 'dsh-sel-previewframe') : null
    const srcdoc = frame ? String(frame.getAttribute('srcdoc') || '') : ''
    env.assert('预览用沙箱 iframe 装 HTML（srcdoc 带原文）', srcdoc.indexOf('<h1>Hello 预览</h1>') >= 0, srcdoc.slice(0, 60))
    env.assert('沙箱只给 allow-scripts、不给 allow-same-origin', frame && String(frame.getAttribute('sandbox')).indexOf('allow-scripts') >= 0 && String(frame.getAttribute('sandbox')).indexOf('allow-same-origin') < 0, frame ? String(frame.getAttribute('sandbox')) : '无')
    env.assert('同一块里也保留源码（可切到代码视图）', !!block && Array.from(env.walk(block)).some((n) => n.className === 'dsh-sel-pre'), '')
    env.assert('js 代码块不会被当成网页', Array.from(env.walk(env.sections[0])).filter((n) => n.className === 'dsh-sel-preview').length === 1 && env.textOf(env.sections[0]).indexOf('const a = 1') >= 0, '')
    env.assert('未标语言的 <div> 片段不会被当成网页', !Array.from(env.walk(env.sections[0])).some((n) => n.className === 'dsh-sel-previewframe' && String(n.getAttribute('srcdoc') || '').indexOf('只是片段') >= 0), '')
    env.assert('D：注入了窄容器自适应样式（viewport + reset）', srcdoc.indexOf('data-dsh-preview-reset') >= 0 && srcdoc.indexOf('width=device-width') >= 0, srcdoc.slice(0, 90))
    env.assert('注入点在 doctype 之后（不把文档推进怪异模式）', /^\s*<!DOCTYPE html>/i.test(srcdoc) && srcdoc.indexOf('data-dsh-preview-reset') > srcdoc.indexOf('<!DOCTYPE'), srcdoc.slice(0, 40))
    env.assert('注入了"上报自身高度"的 hook（消灭框内滚动条的前提）', srcdoc.indexOf('data-dsh-preview-hook') >= 0 && srcdoc.indexOf('__dshPreview') >= 0, '')
    env.assert('内置滚动条被隐藏（高度自适应后本来也不需要）', srcdoc.indexOf('::-webkit-scrollbar') >= 0 && srcdoc.indexOf('scrollbar-width:none') >= 0, '')
    env.assert('预览帧带 id（用于把上报的高度对回来）', !!frame && /^pv\d+$/.test(String(frame.getAttribute('data-preview-id'))), frame ? String(frame.getAttribute('data-preview-id')) : '无')
    // 交互：预览/代码切换 + 放大
    const tabs = Array.from(env.walk(block)).filter((n) => n.className === 'dsh-sel-previewtab')
    env.assert('默认停在预览视图', block.getAttribute('data-view') === 'preview' && tabs[0].getAttribute('data-on') === '1', `${block.getAttribute('data-view')} on=${tabs[0] && tabs[0].getAttribute('data-on')}`)
    tabs[1].dispatch('click', { stopPropagation() {} })
    env.assert('点「代码」切到源码视图', block.getAttribute('data-view') === 'code' && tabs[1].getAttribute('data-on') === '1', String(block.getAttribute('data-view')))
    tabs[0].dispatch('click', { stopPropagation() {} })
    const zoomBtn = Array.from(env.walk(block)).find((n) => n.className === 'dsh-sel-previewzoom')
    env.assert('默认是"全量展示"（整页铺在消息区，内部不滚）', block.getAttribute('data-full') === '1' && env.textOf(zoomBtn) === '⤡ 还原', `${block.getAttribute('data-full')} / ${env.textOf(zoomBtn)}`)
    zoomBtn.dispatch('click', { stopPropagation() {} })
    env.assert('点「还原」切回固定高度档', block.getAttribute('data-full') === '0' && env.textOf(zoomBtn) === '⤢ 全量', `${block.getAttribute('data-full')} / ${env.textOf(zoomBtn)}`)
    const cssFull = readFileSync(env.BUNDLE, 'utf8')
    env.assert('固定高度档是 320px（超出走内部滚动）', /\.dsh-sel-preview\[data-full="0"\] \.dsh-sel-previewframe\{height:320px\}/.test(cssFull), '')
    env.assert('旧的 data-zoom 高度档已移除', !/data-zoom/.test(cssFull), '')
  }


  // ───────────────────────── 历史折叠（整页 HTML 只发 Markdown） ─────────────────────────
  {
    // ① 折叠函数本身：没有整页 HTML → 原样（快路径）
    const plain = '## 翻译\n就是一段普通文字回答。'
    env.assert('没有整页 HTML 的轮次原样返回（快路径，零成本）', env.hook.foldText(plain) === plain, '')
    // ② 有整页 HTML → 折叠：标签/样式消失、结构留下
    const html = '<!doctype html><html><head><style>.card{color:#12a594;background:#111}</style></head><body>'
      + '<h1>标题一</h1><p>正文 <strong>重点</strong>。</p>'
      + '<table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>'
      + '<ul><li>要点甲</li><li>要点乙</li></ul><svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'
      + '<div class="card" style="color:red">带 class 的一段</div></body></html>'
    const folded = env.hook.foldText('看这个：\n\n```html\n' + html + '\n```\n')
    env.assert('折叠后不再有标签/样式/class', !/<[a-z]/i.test(folded) && folded.indexOf('style=') < 0 && folded.indexOf('class=') < 0, folded.slice(0, 80))
    env.assert('标题层级保留（# 标题一）', folded.indexOf('# 标题一') >= 0, '')
    env.assert('强调保留（**重点**）', folded.indexOf('**重点**') >= 0, '')
    env.assert('表格行列保留（两行 + 分隔行）', (folded.match(/^\|.*\|$/gm) || []).length === 3, JSON.stringify(folded.match(/^\|.*\|$/gm)))
    env.assert('列表逐项保留', folded.indexOf('- 要点甲') >= 0 && folded.indexOf('- 要点乙') >= 0, '')
    env.assert('SVG 折成 [图示]（图形丢了、位置留下）', folded.indexOf('[图示]') >= 0, '')
    env.assert('附了一行版式摘要（主色/标题/表格/图示）', /版式摘要/.test(folded) && folded.indexOf('#12a594') >= 0, folded.slice(-90))
    env.assert('正文文字一个不丢', ['正文', '带 class 的一段', '列A', '1'].every((w) => folded.indexOf(w) >= 0), '')
    // ③ 缓存：同一轮只折一次
    const before = env.hook.foldStats().folds
    const again = env.hook.foldText('```html\n' + html + '\n```')
    env.assert('foldText 每次都折（无缓存时）', env.hook.foldStats().folds === before + 1, String(env.hook.foldStats().folds))
  }


  {
    // Sending new turns must not rewrite an older webpage into a different representation.
    const page = '```html\n<!doctype html><html><body>稳定的原始页面</body></html>\n```'
    const n0 = env.sent.length
    globalThis.__askExtra = { delta: page }
    env.hook.ask('网页版')
    for (let i = 0; i < 200 && (env.sent.length === n0 || env.hook.turns().some(t => t.streaming)); i++) await env.sleep(20)
    globalThis.__askExtra = null
    env.hook.ask('再问一句')
    for (let i = 0; i < 200 && (env.sent.length === n0 + 1 || env.hook.turns().some(t => t.streaming)); i++) await env.sleep(20)
    const hist = env.sent.at(-1).history
    env.assert('模型历史保留网页原始代码', hist.some(t => t.role === 'assistant' && t.text === page))
    env.hook.ask('第三轮')
    for (let i = 0; i < 200 && (env.sent.length === n0 + 2 || env.hook.turns().some(t => t.streaming)); i++) await env.sleep(20)
    const later = env.sent.at(-1).history
    env.assert('追加新问答不会改写此前发送的历史前缀', JSON.stringify(later.slice(0, hist.length)) === JSON.stringify(hist))
  }



  // ───────────────────────── 网页模式开关（复杂问题默认用网页回答） ─────────────────────────
  {
    const webBtn = Array.from(env.walk(env.panel)).find((n) => String(n.className).indexOf('dsh-sel-pref') >= 0)
    const prefSeg = webBtn && Array.from(env.walk(webBtn)).find((n) => String(n.className) === 'dsh-sel-seg')
    const cells = prefSeg ? Array.from(env.walk(prefSeg)).filter((n) => String(n.className) === 'dsh-sel-segcell') : []
    const cellIcon = (cell) => (cell ? Array.from(env.walk(cell)).find((n) => n.tagName === 'SVG') : null)
    // 2026-10-18：前面那行「输出偏好」文字去掉了（省下的宽度留给左侧的 ＋ 附件键）。
    // 语义不能跟着一起丢 —— 断言改成"文字没有了，但 title / aria-label 说清楚了"。
    env.assert(
      '追问行里有「输出偏好」控件（已无文字标签，语义落在 title 上）',
      !!webBtn && env.textOf(webBtn).trim() === '' && String(webBtn.title || '').indexOf('输出偏好') >= 0,
      webBtn ? `${JSON.stringify(env.textOf(webBtn))} / ${webBtn.title}` : '未找到',
    )
    env.assert('去掉文字后仍留 aria-label（读屏可达）', !!prefSeg && String(prefSeg.getAttribute('aria-label') || '').indexOf('输出偏好') >= 0, prefSeg ? String(prefSeg.getAttribute('aria-label')) : '')
    env.assert('它是 radiogroup（两格各自 aria-checked）', !!prefSeg && prefSeg.getAttribute('role') === 'radiogroup' && cells.length === 2 && cells.every((c) => c.getAttribute('role') === 'radio'), prefSeg ? `${prefSeg.getAttribute('role')} / cells=${cells.length}` : '')
    env.assert('左格是 Markdown 图标（M↓ 两峰 + 箭头，13px）', !!cellIcon(cells[0]) && Array.from(env.walk(cells[0])).filter((n) => n.tagName === 'PATH').length === 2 && cellIcon(cells[0]).getAttribute('width') === '13', String(cellIcon(cells[0]) && cellIcon(cells[0]).getAttribute('width')))
    env.assert('右格是网页窗口图标（矩形 + 顶栏）', !!cellIcon(cells[1]) && Array.from(env.walk(cells[1])).some((n) => n.tagName === 'RECT') && Array.from(env.walk(cells[1])).some((n) => n.tagName === 'PATH'), '')
    env.assert('两格都没文字（纯图标）', cells.every((c) => env.textOf(c).trim() === ''), cells.map((c) => JSON.stringify(env.textOf(c))).join(' '))
    env.assert('默认停在 Markdown（左格选中、药丸在左）', env.hook.prefCells().markdown === true && env.hook.prefCells().web === false && webBtn.getAttribute('data-on') === '0', JSON.stringify(env.hook.prefCells()))
    env.assert('控件在输入框内部的工具行里（仿主会话两行结构）', !!webBtn && String(webBtn.parentNode.className) === 'dsh-sel-asktools' && String(webBtn.parentNode.parentNode.className).indexOf('dsh-sel-ask') >= 0, webBtn ? `${webBtn.parentNode.className} < ${webBtn.parentNode.parentNode.className}` : '')
    const sendBtn = Array.from(env.walk(env.panel)).find((n) => String(n.className).indexOf('dsh-sel-asksend') >= 0)
    env.assert('发送也是符号化的（图标 + aria-label，无文字）', !!sendBtn && env.textOf(sendBtn).trim() === '' && sendBtn.getAttribute('aria-label') === '发送', sendBtn ? `${JSON.stringify(env.textOf(sendBtn))} / ${sendBtn.getAttribute('aria-label')}` : '')
    env.assert('图标带显式宽高（不会退回 SVG 默认的 300×150）', !!sendBtn && String(Array.from(env.walk(sendBtn))[0].getAttribute('width')) === '16' && String(Array.from(env.walk(sendBtn))[0].getAttribute('height')) === '16', '')
    // CSS 契约：圆形按钮、不能被旧的 padding 规则挤扁
    const composerCss = readFileSync(env.BUNDLE, 'utf8')
    env.assert('按钮边距归零、尺寸缩小到 26px', /\.dsh-sel-iconbtn\{[^']*height:26px/.test(composerCss) && /\.dsh-sel-iconbtn\{[^']*padding:0/.test(composerCss), '')
    // 输出偏好分段的 CSS 契约（桩环境不跑样式）
    env.assert('两格各 30×22、图标 13px', /\.dsh-sel-segcell\{[^']*width:30px;height:22px/.test(composerCss) && /\.dsh-sel-segcell svg\{width:13px/.test(composerCss), '')
    env.assert('药丸 30×22 且靠 data-on 平移 30px', /\.dsh-sel-segpill\{[^']*width:30px;height:22px/.test(composerCss) && /\.dsh-sel-pref\[data-on="1"\] \.dsh-sel-segpill\{transform:translateX\(30px\)\}/.test(composerCss), '')
    env.assert('药丸位移有回弹过渡', /\.dsh-sel-segpill\{[\s\S]{0,400}?cubic-bezier\(\.3,1\.2,\.4,1\)/.test(composerCss), '')
    env.assert('选中格的图标变白（有 aria-checked 样式）', /\.dsh-sel-segcell\[aria-checked="true"\]/.test(composerCss), '')
    env.assert('旧滑块/胶囊样式已清掉', !/\.dsh-sel-preftrack\{/.test(composerCss) && !/\.dsh-sel-prefknob\{/.test(composerCss) && !/\.dsh-sel-webmode\{/.test(composerCss), '')
    env.assert('生成中发送键变方形"停止"（有独立样式）', /\.dsh-sel-asksend\[data-mode="stop"\]/.test(composerCss), '')
    env.assert('没有残留的 .dsh-sel-asksend{padding:0 14px} 旧规则', !/\.dsh-sel-asksend\{[^']*padding:0 14px/.test(composerCss), '')
    env.assert('输入区是两行结构（工具行 + 撑开占位）', /\.dsh-sel-asktools\{display:flex/.test(composerCss) && /\.dsh-sel-askspace\{flex:1 1 auto\}/.test(composerCss), '')
    env.assert('底部那条页脚已经没有了', !Array.from(env.walk(env.panel)).some((n) => String(n.className).indexOf('dsh-sel-foot') >= 0), '')
    env.assert('短提示浮层也没有了（界面上不显示状态）', !Array.from(env.walk(env.panel)).some((n) => String(n.className).indexOf('dsh-sel-toast') >= 0), '')
    env.assert('状态仍有记录（自检可读，不渲染）', typeof env.hook.state().status === 'string', typeof env.hook.state().status)
    // 点右格 → 切到网页；药丸跟着滑
    cells[1].dispatch('click', { preventDefault() {}, stopPropagation() {} })
    env.assert('点右格就滑到右档（并落盘到 localStorage）', env.hook.webMode() === true && webBtn.getAttribute('data-on') === '1' && env.windowStub.localStorage.getItem('dsh-selection-explain:webAnswer') === '1', String(env.windowStub.localStorage.getItem('dsh-selection-explain:webAnswer')))
    env.assert('两格 aria-checked 互换', env.hook.prefCells().web === true && env.hook.prefCells().markdown === false, JSON.stringify(env.hook.prefCells()))
    env.assert('两格各有自己的说明（title）', /网页/.test(String(cells[1].title)) && /Markdown/.test(String(cells[0].title)), `${cells[0].title} | ${cells[1].title}`)
    // 点左格 → 切回 Markdown
    cells[0].dispatch('click', { preventDefault() {}, stopPropagation() {} })
    env.assert('点左格切回 Markdown', env.hook.webMode() === false && webBtn.getAttribute('data-on') === '0', String(webBtn.getAttribute('data-on')))
    // 键盘：右方向键切到网页
    prefSeg.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} })
    env.assert('方向键也能换档（radiogroup 惯例）', env.hook.webMode() === true, String(env.hook.webMode()))
    // 开着的时候追问：请求要带 webAnswer: true，host 据此注入设计规范
    // 等这一轮真的结束（用它自己的 streaming 标记），否则下一轮 ask 会被"还在生成"挡掉
    const waitIdle = async () => {
      for (let i = 0; i < 200 && env.hook.turns().some((t) => t.streaming === true); i += 1) await env.sleep(20)
      await env.sleep(40)
    }
    const beforeWeb = env.sent.length
    env.hook.ask('复杂问题：三种方式对比')
    for (let i = 0; i < 80 && env.sent.length === beforeWeb; i += 1) await env.sleep(20)
    const webPayload = env.sent[env.sent.length - 1] || {}
    env.assert('开启后追问请求带 webAnswer: true', webPayload.webAnswer === true, JSON.stringify({ webAnswer: webPayload.webAnswer, q: webPayload.question }))
    // 网页输出还得带上当前深浅：深色 Harness 里给一张白底页面会很刺眼（host 据此注入配色规范）
    env.assert('网页输出带上当前主题（dark/light）', webPayload.theme === 'dark' || webPayload.theme === 'light', JSON.stringify(webPayload.theme))
    await waitIdle()

    // 主题检测必须优先读 **DSH 自己的信号**（body[data-ds-dark-theme]），而不是面板的合成底色。
    // 踩过的坑：外观设成"跟随系统（暗）"时，面板底色取自 DSH 变量、自身透明 → 被算成浅色
    // → 生成的网页是亮色（用户实测报的）。DSH 不管用户选哪一档，都会把最终配色投影到这个属性上。
    {
      env.body.setAttribute('data-ds-dark-theme', '')
      const beforeDark = env.sent.length
      env.hook.ask('深色下再来一次：三种方式对比')
      for (let i = 0; i < 80 && env.sent.length === beforeDark; i += 1) await env.sleep(20)
      const darkPayload = env.sent[env.sent.length - 1] || {}
      env.assert('跟随系统的深色下，网页输出带 theme: dark', darkPayload.theme === 'dark', JSON.stringify(darkPayload.theme))
      env.body.removeAttribute('data-ds-dark-theme')
      await waitIdle()
    }
    env.hook.setWebMode(false)
    const beforePlain = env.sent.length
    env.hook.ask('简单问题')
    for (let i = 0; i < 80 && env.sent.length === beforePlain; i += 1) await env.sleep(20)
    env.assert('关掉后不带 webAnswer（走普通文字回答）', (env.sent[env.sent.length - 1] || {}).webAnswer === undefined, JSON.stringify((env.sent[env.sent.length - 1] || {}).webAnswer))
    await waitIdle()
  }


  // 分块流式：流式期间只给源码、跑完只建 1 个 iframe（回归：曾经每个 delta 建一个，一条回答建了 24 个，
  // 结果流式期间看不到源码，最后一帧还因为反复销毁/加载卡成空白，得关掉小窗重开才渲染）
  {
    let framesCreated = 0
    const origCreate = env.documentStub.createElement
    // 只统计"这条回答的" iframe：按 srcdoc 内容认（页面同时还有翻译节的预览块，
    // 早先按"创建次数"统计被它污染，误判成流式期间也建了 iframe）
    env.documentStub.createElement = (tag) => {
      const node = origCreate(tag)
      if (String(tag).toLowerCase() === 'iframe') {
        const origSet = node.setAttribute.bind(node)
        node.setAttribute = (key, value) => {
          if (key === 'srcdoc' && String(value).indexOf('分块渲染') >= 0) framesCreated += 1
          return origSet(key, value)
        }
      }
      return node
    }
    const currentBubble = () => env.chatLog.children[env.chatLog.children.length - 1]
    const framesInChat = () => Array.from(env.walk(currentBubble())).filter((n) => n.className === 'dsh-sel-previewframe').length
    const codeInChat = () => Array.from(env.walk(currentBubble())).filter((n) => n.className === 'dsh-sel-pre').length
    const stillStreaming = () => env.hook.turns().some((t) => t.streaming === true)

    framesCreated = 0 // 只统计这一条回答
    env.hook.ask('分块网页追问')
    for (let i = 0; i < 60 && codeInChat() === 0; i += 1) await env.sleep(10)
    env.assert(
      '流式期间显示源码、不建 iframe',
      framesCreated === 0 && framesInChat() === 0 && codeInChat() > 0,
      `frames=${framesCreated} code=${codeInChat()}`,
    )

    // 等这一轮真的结束（用它自己的 streaming 标记，别跟流式赛跑）
    for (let i = 0; i < 200 && (stillStreaming() || !/分块渲染/.test(env.textOf(env.chatLog))); i += 1) await env.sleep(20)
    await env.sleep(80)
    env.assert('这一轮已收尾（没有残留的流式标记）', !stillStreaming(), JSON.stringify(env.hook.turns().map((t) => t.streaming)))
    env.assert('跑完只建 1 个 iframe（不是每个 delta 一个）', framesCreated === 1, `frames=${framesCreated}`)
    {
      // 消息排版对齐主会话：助手消息整宽无气泡（所以"有网页的"和"普通"宽度天然一致），用户消息才是右对齐气泡
      const bubbles = Array.from(env.walk(env.chatLog)).filter((n) => String(n.className).indexOf('dsh-sel-bubble ') >= 0)
      const bots = bubbles.filter((n) => /dsh-sel-bubble-bot/.test(String(n.className)))
      const users = bubbles.filter((n) => /dsh-sel-bubble-user/.test(String(n.className)))
      env.assert('助手消息不再用气泡样式（整宽，和主会话一致）', bots.length >= 1 && users.length >= 1, JSON.stringify(bubbles.map((n) => n.className)))
    }
    const frames = Array.from(env.walk(currentBubble())).filter((n) => n.className === 'dsh-sel-previewframe')
    env.assert(
      '最终 iframe 装的是完整 HTML',
      frames.length === 1 && String(frames[0].getAttribute('srcdoc')).indexOf('分块渲染') >= 0,
      frames.length ? String(frames[0].getAttribute('srcdoc')).slice(0, 50) : '无',
    )
    env.documentStub.createElement = origCreate
  }


  // 预览页上报高度 → iframe 直接长到内容那么高（框内不再有滚动条）
  {
    const frame = Array.from(env.walk(env.chatLog)).find((n) => n.className === 'dsh-sel-previewframe')
    const id = frame ? String(frame.getAttribute('data-preview-id')) : ''
    env.assert('分块用例的预览帧也带 id', /^pv\d+$/.test(id), id || '无')
    if (frame && id) {
      frame.contentWindow = { __tag: 'me' }
      env.windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 999 }, source: { __tag: 'other' } })
      env.assert('不认来源不符的高度上报', !frame.style.height, String(frame.style.height))
      env.windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 480 }, source: frame.contentWindow })
      env.assert('页面自己多高，预览就多高', frame.style.height === '480px', String(frame.style.height))
      // 注入端曾经发的是数字 1，监听端写成 `!== true` 会把自家消息挡掉（实测踩过）→ 这里两种都要认
      env.windowStub.dispatch('message', { data: { __dshPreview: 1, id: id, h: 500 }, source: frame.contentWindow })
      env.assert('标记为 1（数字）也认（不再依赖严格相等）', frame.style.height === '500px', String(frame.style.height))
      env.windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 498 }, source: frame.contentWindow })
      env.assert('高度抖动小于 4px 不折腾（避免反复回流）', frame.style.height === '500px', String(frame.style.height))
      env.windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 540 }, source: frame.contentWindow })
      env.assert('真变高了就跟着长', frame.style.height === '540px', String(frame.style.height))
      // 全量模式：长到内容高度（不再夹在面板可视高度里——"整页铺开"就是这个意思）
      env.windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 2400 }, source: frame.contentWindow })
      env.assert('全量模式：iframe 直接长到整页高度（内部不滚）', frame.style.height === '2400px', String(frame.style.height))
      // 病态页面兜底：几万像素不至于把消息区撑爆
      env.windowStub.dispatch('message', { data: { __dshPreview: true, id: id, h: 40000 }, source: frame.contentWindow })
      env.assert('病态高度有兜底上限（6000px）', frame.style.height === '6000px', String(frame.style.height))
      // 点「还原」→ 固定高度：清掉 inline 高度，交给 CSS 的 320px
      const blockWrap = Array.from(env.walk(env.chatLog)).find((n) => String(n.className).indexOf('dsh-sel-preview') >= 0)
      const restoreBtn = Array.from(env.walk(blockWrap)).find((n) => String(n.className).indexOf('dsh-sel-previewzoom') >= 0)
      restoreBtn.dispatch('click', { stopPropagation() {} })
      env.assert('点「还原」后 inline 高度清空（回到固定的 320px 内部滚动）', frame.style.height === '' && blockWrap.getAttribute('data-full') === '0', `${JSON.stringify(frame.style.height)} / ${blockWrap.getAttribute('data-full')}`)
      restoreBtn.dispatch('click', { stopPropagation() {} })
      env.assert('再点「全量」又按上报高度铺开', frame.style.height === '6000px' && blockWrap.getAttribute('data-full') === '1', `${frame.style.height} / ${blockWrap.getAttribute('data-full')}`)
    }
  }


  // ───────────────────────── 生成中：发送键变「停止」，点一下打断 ─────────────────────────
  {
    const sendBtn = Array.from(env.walk(env.panel)).find((n) => String(n.className).indexOf('dsh-sel-asksend') >= 0)
    // 首轮（慢速 fixture）：流式期间按钮应变成 stop
    // 注意：用独一无二的 text，否则会把"中止探测"的缓存/历史污染掉，后面的用例会直接命中缓存
    env.hook.open('停止键专用探测词', '', '停止用例')
    for (let i = 0; i < 60 && env.hook.state().phase !== 'streaming'; i += 1) await env.sleep(20)
    env.assert('生成中发送键变成「停止」（方形图标 + data-mode=stop）', sendBtn.getAttribute('data-mode') === 'stop' && sendBtn.getAttribute('aria-label') === '停止' && !!Array.from(env.walk(sendBtn)).find((n) => n.tagName === 'RECT'), `${sendBtn.getAttribute('data-mode')} / ${sendBtn.getAttribute('aria-label')}`)
    sendBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    for (let i = 0; i < 60 && env.hook.state().phase !== 'paused'; i += 1) await env.sleep(20)
    env.assert('点「停止」打断首轮：记成已停止而不是失败', env.hook.state().phase === 'paused', env.hook.state().phase)
    env.assert('停止后按钮恢复成「发送」', sendBtn.getAttribute('data-mode') === 'send' && sendBtn.getAttribute('aria-label') === '发送', String(sendBtn.getAttribute('data-mode')))
    env.assert('停止后正文里有交代 + 重新生成入口', env.textOf(env.panel).indexOf('已停止') >= 0 && !!Array.from(env.walk(env.panel)).find((n) => String(n.className).indexOf('dsh-sel-retry') >= 0), '')

    // 追问（慢速 fixture）：同样能打断，且保留已经流出来的内容
    const beforeAskStop = env.sent.length
    env.hook.ask('慢速追问')
    for (let i = 0; i < 80 && env.sent.length === beforeAskStop; i += 1) await env.sleep(20)
    for (let i = 0; i < 80 && env.textOf(env.chatLog).indexOf('第一段') < 0; i += 1) await env.sleep(20)
    env.assert('追问生成中也是「停止」键', sendBtn.getAttribute('data-mode') === 'stop', String(sendBtn.getAttribute('data-mode')))
    sendBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    await env.sleep(120)
    const stoppedTurn = env.hook.turns()[env.hook.turns().length - 1]
    env.assert('点停止打断追问：标记 stopped、不是 error', stoppedTurn && stoppedTurn.stopped === true && !stoppedTurn.error, JSON.stringify({ stopped: stoppedTurn && stoppedTurn.stopped, error: stoppedTurn && stoppedTurn.error }))
    env.assert('已流出的内容保留下来了', String(stoppedTurn && stoppedTurn.text).indexOf('第一段') >= 0, String(stoppedTurn && stoppedTurn.text).slice(0, 30))
    env.assert('追问停止也有记录（自检可读）', /已停止/.test(String(env.hook.state().status || '')), String(env.hook.state().status))
  }


  // ────────────── 正文不再做文本层清洗（照主会话的做法） ──────────────
  //
  // 以前这里断言"<ds_safety_tool_call> 被剥掉"。现在**故意不清洗**了：
  // 主会话从不摘工具，模型走协议层表达工具调用，正文里根本不会有这种标记；
  // 而留一道清洗，在标记"未闭合"时会把正文尾巴一起吃掉（实测：收尾轮 raw=726 → emitted=0）。
  // 所以这条用例改成锁住"原样显示"，防止以后又有人把清洗加回来。
  env.hook.open('fake-tool-probe', '', '伪造调用')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.assert('正文原样保留：客户端不再做文本层清洗', String(env.hook.state().raw).indexOf('ds_safety_tool_call') >= 0, String(env.hook.state().raw).slice(0, 60))

  env.assert('正文其余内容保留（不做手术就不会误伤）', env.textOf(env.sections[0]).indexOf('没有工具时的回答') >= 0, env.textOf(env.sections[0]).slice(0, 80))


  // ───────────────────────── 追问小窗（临时多轮对话） ─────────────────────────
  const askBox = Array.from(env.walk(env.panel)).find((n) => n.className === 'dsh-sel-askbox')

  const askSend = Array.from(env.walk(env.panel)).find((n) => String(n.className).indexOf('dsh-sel-asksend') >= 0)

  env.assert('面板有追问输入框与发送按钮', !!askBox && !!askSend, askBox ? askBox.placeholder.slice(0, 18) : '未找到')


  // 输入法组合态按 Enter 不能发送（中文输入"确认候选词"不是发送）
  askBox.value = '输入法组合中的半成品'

  const beforeIme = env.sent.length

  askBox.dispatch('keydown', { key: 'Enter', isComposing: true, keyCode: 229, preventDefault() {}, stopPropagation() {} })

  await new Promise((r) => setTimeout(r, 30))

  env.assert('输入法组合态按 Enter 不发送、也不清空输入框', env.sent.length === beforeIme && askBox.value.length > 0, `sent=${env.sent.length - beforeIme} value=${askBox.value}`)

  askBox.value = ''


  // 空内容按 Enter 不发送
  const beforeEmpty = env.sent.length

  askBox.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })

  await new Promise((r) => setTimeout(r, 30))

  env.assert('空内容按 Enter 不发送', env.sent.length === beforeEmpty, `sent=${env.sent.length - beforeEmpty}`)


  // 本场景独立设置档位，不能依赖设置场景留下的内存状态。
  env.hook.openModel()
  await new Promise((r) => setTimeout(r, 30))
  const highEffort = Array.from(env.walk(env.hook.modelNodes().menu)).find((n) => n.getAttribute('data-slot') === 'high')
  env.assert('追问前可独立选择高思考档位', !!highEffort)
  highEffort.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 30))

  const beforeAsk = env.sent.length

  env.hook.ask('为什么不让每个插件自己适配？')

  for (let i = 0; i < 80 && env.hook.state().phase === 'done' && env.sent.length === beforeAsk; i += 1) {
    await new Promise((r) => setTimeout(r, 20))
  }

  for (let i = 0; i < 80; i += 1) {
    const turns = env.hook.turns()
    if (turns.length >= 2 && turns[turns.length - 1].text && turns[turns.length - 1].text.indexOf('这是对追问的回答') >= 0) break
    await new Promise((r) => setTimeout(r, 20))
  }

  const turns = env.hook.turns()

  env.assert('追问后出现「用户 + 助手」两条气泡', turns.length >= 2 && turns[turns.length - 2].role === 'user' && turns[turns.length - 1].role === 'assistant', JSON.stringify(turns.map((t) => t.role)))

  env.assert('助手气泡渲染了回答内容', env.textOf(env.chatLog).indexOf('这是对追问的回答') >= 0, env.textOf(env.chatLog).slice(0, 60))

  env.assert('追问气泡容器可见（不能画进隐藏容器）', env.chatLog.style.display === 'flex', 'display=' + env.chatLog.style.display)

  const visibleBubbles = Array.from(env.walk(env.chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble') >= 0)

  env.assert(
    '小窗只显示「我的问题 + 回答」两条气泡，不重复翻译/详解',
    visibleBubbles.length === 2 &&
      env.textOf(visibleBubbles[0]).indexOf('为什么不让每个插件自己适配？') >= 0 &&
      env.textOf(env.chatLog).indexOf('前情：已就这段选中文字给出解读') < 0,
    visibleBubbles.map((n) => env.textOf(n).slice(0, 18)).join(' | '),
  )

  const askPayload = env.sent[env.sent.length - 1]

  env.assert(
    '解读前情作为固定背景单独发给模型',
    typeof askPayload.initialExplanation === 'string' && askPayload.initialExplanation.includes('前情'),
    JSON.stringify((askPayload.history || []).map((t) => t.role)),
  )

  env.assert('追问请求带 question 与 history', !!askPayload.question && Array.isArray(askPayload.history) && !!askPayload.initialExplanation, JSON.stringify({ q: askPayload.question, h: askPayload.history && askPayload.history.length }))

  env.assert('追问携带当前思考强度，不强制刷新缓存', askPayload.refresh === undefined && askPayload.effort === 'high', JSON.stringify({refresh: askPayload.refresh, effort: askPayload.effort}))

  env.assert('追问成功后输入框状态刷新（空内容时发送键禁用）', askSend.disabled === true, 'disabled=' + askSend.disabled)


  // 再追问一次：历史里应带上上一轮
  env.hook.ask('那我们自己实现划算吗？')

  for (let i = 0; i < 100; i += 1) {
    const list = env.hook.turns()
    if (list.length >= 4 && list[list.length - 1].text && list[list.length - 1].text.indexOf('划算吗') >= 0) break
    await new Promise((r) => setTimeout(r, 20))
  }

  const secondPayload = env.sent[env.sent.length - 1]

  env.assert('第二轮追问的历史含上一轮问答', (secondPayload.history || []).length === 2 && secondPayload.history[0].role === 'user' && secondPayload.history[1].role === 'assistant', JSON.stringify((secondPayload.history || []).map((t) => t.role)))


  // ───────────────────────── 旧标题兼容（## 语境含义 → 详解节） ─────────────────────────
  env.hook.open('legacy-heading-probe', '', '兼容测试')

  for (let i = 0; i < 60 && env.hook.state().phase !== 'done'; i += 1) {
    await new Promise((r) => setTimeout(r, 20))
  }

  const legacyState = env.hook.state()

  env.assert(
    '旧标题「## 语境含义」仍切到详解节',
    (legacyState.sections.detail || '').indexOf('旧标题下的解释') >= 0 && (legacyState.sections.translation || '').indexOf('旧标题兼容') >= 0,
    JSON.stringify(legacyState.sections).slice(0, 120),
  )


  // ───────────────────────── 首轮等待特效 + CTA 时机（回归） ─────────────────────────
  // 痛点：请求发出到第一个字之间（模型思考期可能好几秒）面板一片空白，
  // 而底部那时已经躺着一个灰着的「展开详解」，看起来像"卡住了"。
  env.hook.open('slow-probe', '', '等待特效')

  const waitAtLoading = env.classesIn(env.panel, 'dsh-sel-wait')

  env.assert(
    '请求刚发出（还没收到任何字节）就有等待特效',
    waitAtLoading.length >= 1 && env.textOf(waitAtLoading[0]).indexOf('正在翻译') >= 0,
    waitAtLoading.length ? JSON.stringify(env.textOf(waitAtLoading[0]).slice(0, 24)) : '未找到等待节点',
  )

  env.assert('等待特效是动态的（呼吸点 + 流光骨架条）', env.classesIn(env.panel, 'dsh-sel-dots').length >= 1 && env.classesIn(env.panel, 'dsh-sel-sk').length >= 2, `dots=${env.classesIn(env.panel, 'dsh-sel-dots').length} sk=${env.classesIn(env.panel, 'dsh-sel-sk').length}`)

  env.assert('首轮翻译还没出字时，展开 CTA 不显示', env.expandBtn.style.display === 'none', 'display=' + JSON.stringify(env.expandBtn.style.display))

  env.assert('等待特效里预留了秒数与提示位（不重建节点也能更新）', env.classesIn(env.panel, 'dsh-sel-waitclock').length === 1 && env.classesIn(env.panel, 'dsh-sel-waithint').length === 1)

  const waitNodeA = env.classesIn(env.panel, 'dsh-sel-wait')[0]

  await env.sleep(330)

  env.assert('收到 start（模型思考期）等待特效仍在，不空窗', env.classesIn(env.panel, 'dsh-sel-wait').length >= 1 && env.hook.state().phase === 'streaming', `phase=${env.hook.state().phase}`)

  const waitNodeB = env.classesIn(env.panel, 'dsh-sel-wait')[0]

  // 关键回归：中间来过一次重绘（空 delta），等待节点必须是同一个——每帧重建会让 CSS 动画
  // 从 0% 重头开始，视觉上就是"一直在闪"
  env.assert('重绘不会重建等待节点（动画不被打断成闪烁）', !!waitNodeA && waitNodeA === waitNodeB, waitNodeA === waitNodeB ? '同一节点' : '被重建了')

  let clockText = ''

  for (let i = 0; i < 20; i += 1) {
    clockText = env.textOf(env.classesIn(env.panel, 'dsh-sel-waitclock')[0] || new env.FakeEl('span'))
    if (/^\d+\.\ds$/.test(clockText.trim())) break
    await env.sleep(40)
  }

  env.assert('等待特效里在走秒（≥0.3s 才显示）', /^\d+\.\ds$/.test(clockText.trim()), JSON.stringify(clockText))

  const hintText = env.textOf(env.classesIn(env.panel, 'dsh-sel-waithint')[0] || new env.FakeEl('div'))

  env.assert('等待里能看到模型在想什么（thought 事件）', hintText.indexOf('先判断这段英文') >= 0, JSON.stringify(hintText))

  await env.sleep(600)

  const waitAfterDone = env.classesIn(env.panel, 'dsh-sel-wait')

  env.assert('翻译出完后等待特效消失', waitAfterDone.length === 0 && env.hook.state().phase === 'done', `phase=${env.hook.state().phase} wait=${waitAfterDone.length}`)

  env.assert('翻译出完后展开 CTA 才出现（不再灰着等人）', env.expandBtn.style.display !== 'none', 'display=' + JSON.stringify(env.expandBtn.style.display))


  // ───────────────────────── 第一节标题：有英文 → 翻译 / 纯中文 → 解读 ─────────────────────────
  const sectionTitles = () => Array.from(env.walk(env.panel)).filter((n) => n.className === 'dsh-sel-sh').map((n) => env.textOf(n).trim())

  env.hook.open('slipped', '', '英文标题')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.assert('选中文字含英文 → 第一节标题是「翻译」', sectionTitles()[0] === '翻译', JSON.stringify(sectionTitles()))

  env.hook.open('中文标题探测', '', '中文标题')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.assert('选中文字全是中文 → 第一节标题改叫「解读」', sectionTitles()[0] === '解读', JSON.stringify(sectionTitles()))

  env.assert('纯中文时模型写 `## 解读` 也进第一节（不被丢进 other）', env.textOf(env.sections[0]).indexOf('把临时窗口变成正式会话') >= 0, env.textOf(env.sections[0]).slice(0, 40))

  env.assert('纯中文解读内容渲染完整（含结论行）', env.textOf(env.sections[0]).indexOf('在本句中') >= 0)

  env.hook.open('the migration ran long', '', '英文标题2')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.assert('再换成英文选区，标题又变回「翻译」', sectionTitles()[0] === '翻译', JSON.stringify(sectionTitles()))


  // ───────────────────────── 追问滚动：贴底跟随 / 翻上去不拽回 ─────────────────────────
  const panelBody = Array.from(env.walk(env.panel)).find((n) => n.className === 'dsh-sel-body')

  env.assert('找到面板滚动容器', !!panelBody, panelBody ? panelBody.className : '未找到')

  panelBody.scrollHeight = 1200

  panelBody.clientHeight = 400

  panelBody.scrollTop = 800
   // 800 + 400 = 1200：贴着底
  env.hook.open('slow-ask-probe', '', '滚动用例')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  panelBody.scrollHeight = 1200

  panelBody.clientHeight = 400

  panelBody.scrollTop = 800

  env.hook.ask('滚动测试')

  await env.sleep(10)

  env.assert('追问发送后立刻回到底部（问题可见）', panelBody.scrollTop === panelBody.scrollHeight, `scrollTop=${panelBody.scrollTop} scrollHeight=${panelBody.scrollHeight}`)

  await env.sleep(90)

  env.assert('回答流式期间持续贴底', panelBody.scrollTop === panelBody.scrollHeight, `scrollTop=${panelBody.scrollTop} scrollHeight=${panelBody.scrollHeight}`)


  // 发完之后内容还会异步长高（思考尾巴 / 预览 iframe 上报新高度 / 面板切宽版重排）——
  // 只在 renderTurns 里贴一次不够，这正是"点了发送消息没跟到最新位置"的成因
  {
    env.assert('发送后进入"跟随最新消息"状态', env.hook.state().follow === true, String(env.hook.state().follow))
    panelBody.scrollHeight = 2000
    for (const ro of env.resizeObservers) ro.fire()
    env.assert('内容异步长高后自动再贴底（ResizeObserver）', panelBody.scrollTop === 2000, `scrollTop=${panelBody.scrollTop}`)
    // 用户自己往上滚 → 收回跟随，不再被拉回底部
    panelBody.dispatch('wheel', { deltaY: -120 })
    env.assert('用户往上滚后放弃跟随', env.hook.state().follow === false, String(env.hook.state().follow))
    panelBody.scrollHeight = 2600
    for (const ro of env.resizeObservers) ro.fire()
    env.assert('放弃跟随后内容再长也不抢滚动条', panelBody.scrollTop === 2000, `scrollTop=${panelBody.scrollTop}`)
    // 滚回底部 → 重新跟随
    panelBody.scrollTop = panelBody.scrollHeight
    panelBody.dispatch('wheel', { deltaY: 120 })
    env.assert('滚回底部后重新跟随', env.hook.state().follow === true, String(env.hook.state().follow))
  }

  panelBody.scrollTop = 100
   // 模拟用户往上翻去看前面的内容
  await env.sleep(140)

  env.assert('用户往上翻之后不再被拽回底部', panelBody.scrollTop === 100, `scrollTop=${panelBody.scrollTop}`)

  env.assert('翻上去期间回答仍在继续渲染', env.textOf(env.chatLog).indexOf('第三段回答') >= 0 || env.textOf(env.chatLog).indexOf('第二段回答') >= 0, env.textOf(env.chatLog).slice(0, 40))


  // ───────────────────────── 关闭策略：点面板外永不关闭；✕ / Esc / 胶囊可关 ─────────────────────────
  env.hook.open('slow-ask-probe', '', '关闭策略-未追问')

  await env.sleep(80)

  env.documentStub.dispatch('mousedown', { target: new env.FakeEl('div') })

  env.assert('没追问时点面板外也不关闭（答案不能被误关掉）', env.panel.style.display === 'flex', 'display=' + env.panel.style.display)


  env.hook.open('slow-probe', '', '关闭策略')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.hook.ask('这个改动会不会影响缓存前缀？')

  for (let i = 0; i < 100; i += 1) {
    const list = env.hook.turns()
    if (list.length >= 2 && list[list.length - 1].text) break
    await env.sleep(20)
  }

  env.assert('关闭策略用例已产生对话内容', env.hook.turns().length >= 2, JSON.stringify(env.hook.turns().map((t) => t.role)))

  env.histBtn.dispatch('click', { stopPropagation() {} })

  await env.sleep(60)

  env.documentStub.dispatch('mousedown', { target: env.histList })

  env.assert('点列表内部不算"点外面"（面板不关）', env.panel.style.display === 'flex', 'display=' + env.panel.style.display)

  env.assert('点列表内部侧边栏也不收', env.histList.style.display === 'flex', 'display=' + env.histList.style.display)

  // 点别处：侧边栏收回，但"追问过"的面板照旧留着
  env.documentStub.dispatch('mousedown', { target: new env.FakeEl('div') })

  env.assert('点别处侧边栏收回', env.histList.style.display === 'none', 'display=' + env.histList.style.display)

  env.assert('侧边栏收回不影响面板本身', env.panel.style.display === 'flex', 'display=' + env.panel.style.display)

  // 点面板正文（消息区）也要收回侧边栏
  env.histBtn.dispatch('click', { stopPropagation() {} })

  await env.sleep(60)

  env.assert('（前置）侧边栏已打开', env.histList.style.display === 'flex', 'display=' + env.histList.style.display)

  env.documentStub.dispatch('mousedown', { target: env.chatLog })

  env.assert('点小窗消息区域收回侧边栏', env.histList.style.display === 'none', 'display=' + env.histList.style.display)

  env.assert('点消息区域不关面板', env.panel.style.display === 'flex', 'display=' + env.panel.style.display)

  env.histBtn.dispatch('click', { stopPropagation() {} })

  await env.sleep(60)

  env.documentStub.dispatch('mousedown', { target: askBox })

  env.assert('点输入框也收回侧边栏', env.histList.style.display === 'none', 'display=' + env.histList.style.display)

  env.histBtn.dispatch('click', { stopPropagation() {} })

  await env.sleep(60)

  env.assert('「最近」按钮能再次打开（开关没被收回逻辑破坏）', env.histList.style.display === 'flex', 'display=' + env.histList.style.display)

  // 页面滚动也收回；滚动列表自身不收（此刻列表是开着的）
  env.windowStub._listeners.get('scroll')[0]({ target: env.histList })

  env.assert('滚动列表自身不会把它收掉', env.histList.style.display === 'flex', 'display=' + env.histList.style.display)

  env.windowStub._listeners.get('scroll')[0]({ target: env.body })

  env.assert('页面滚动会收回侧边栏', env.histList.style.display === 'none', 'display=' + env.histList.style.display)

  env.histBtn.dispatch('click', { stopPropagation() {} })

  env.documentStub.dispatch('mousedown', { target: new env.FakeEl('div') })

  env.assert('追问后点面板外不关闭', env.panel.style.display === 'flex', 'display=' + env.panel.style.display)

  env.assert('面板外点击/滚动不会打断正在渲染的对话', env.textOf(env.chatLog).indexOf('这是对追问的回答') >= 0)

  env.assert('追问后点面板外仍然不关闭（对照：上面连点了两次）', env.panel.style.display === 'flex', 'display=' + env.panel.style.display)

  // Esc：任何时候都能关（这一版把"追问后不许 Esc"的限制去掉了）
  env.documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })

  env.assert('追问后 Esc 也能关闭（不受"有没有追问过"限制）', env.panel.style.display === 'none', 'display=' + env.panel.style.display)

  // ✕ 仍然能关（换一个场景再验一次）
  env.hook.open('slow-probe', '', '关闭策略-✕')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  const closeBtn = Array.from(env.walk(env.panelHead)).find((n) => n.className === 'dsh-sel-icon')

  closeBtn.dispatch('click', { stopPropagation() {} })

  env.assert('点右上角 ✕ 仍然能关闭', env.panel.style.display === 'none', 'display=' + env.panel.style.display)


  // ───────────────────────── 选中代码：逐句注释 + 代码块 + 小结 ─────────────────────────
  env.hook.open(env.CODE_SNIPPET, 'DSH 插件的文本截断逻辑', '代码')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  const codePayload = env.sent[env.sent.length - 1]

  env.assert('代码选区在载荷里标成 kind=code', codePayload.kind === 'code' && codePayload.text === env.CODE_SNIPPET, JSON.stringify({ kind: codePayload.kind }))

  env.assert('代码选区的第一节标题是「注释」', sectionTitles()[0] === '注释', JSON.stringify(sectionTitles()))

  const codeBlocks = env.classesIn(env.sections[0], 'dsh-sel-pre')

  env.assert('代码用代码块渲染（pre 节点）', codeBlocks.length === 1, `pre=${codeBlocks.length}`)

  env.assert('代码块里是原样代码', env.textOf(codeBlocks[0]).indexOf('function clampText(text)') >= 0 && env.textOf(codeBlocks[0]).indexOf('const MAX = 4000') >= 0, env.textOf(codeBlocks[0]).slice(0, 60))

  env.assert('注释与代码在同一个代码块里（块外没有逐句注释列表）', env.classesIn(env.sections[0], 'dsh-sel-item').length === 0, `items=${env.classesIn(env.sections[0], 'dsh-sel-item').length}`)

  const preText = env.textOf(codeBlocks[0])

  env.assert('注释贴着对应语句、顺序一致', /定义文本长度上限[\s\S]*const MAX = 4000[\s\S]*声明一个把文本截断到上限的函数[\s\S]*function clampText/.test(preText), preText.slice(0, 80))

  const cmtSpans = env.classesIn(codeBlocks[0], 'dsh-sel-pre-cmt')

  env.assert('注释行被标成注释（弱化显示）', cmtSpans.length === 3 && env.textOf(cmtSpans[0]).trim() === '// 定义文本长度上限', `cmt=${cmtSpans.length}`)

  env.assert('代码行没有被当成注释', !cmtSpans.some((n) => env.textOf(n).indexOf('const MAX = 4000') >= 0), cmtSpans.map((n) => env.textOf(n).trim()).join(' | '))

  const codeCallouts = env.classesIn(env.sections[0], 'dsh-sel-callout')

  env.assert('最后的总结渲染成结论条（小结）', codeCallouts.length === 1 && env.textOf(codeCallouts[0]).indexOf('小结') >= 0 && env.textOf(codeCallouts[0]).indexOf('按 4000 字截断') >= 0, env.textOf(codeCallouts[0]).slice(0, 50))

  // 语法高亮：关键字/数字/函数名/注释各自上色
  const hl = (root, cls) => env.classesIn(root, cls).map((n) => env.textOf(n))

  env.assert('关键字上色', hl(codeBlocks[0], 'dsh-hl-kw').join(',') === 'const,function,return', hl(codeBlocks[0], 'dsh-hl-kw').join(','))

  env.assert('数字上色', hl(codeBlocks[0], 'dsh-hl-num').indexOf('4000') >= 0, hl(codeBlocks[0], 'dsh-hl-num').join(','))

  env.assert('函数名上色', hl(codeBlocks[0], 'dsh-hl-fn').indexOf('clampText') >= 0 && hl(codeBlocks[0], 'dsh-hl-fn').indexOf('slice') >= 0, hl(codeBlocks[0], 'dsh-hl-fn').join(','))

  env.assert('行尾注释也上色', hl(codeBlocks[0], 'dsh-hl-com').length === 3, hl(codeBlocks[0], 'dsh-hl-com').join(' | '))

  // 折行：注释行整行可折（不顶出小窗），代码行不折（长代码宁可横向滚动）
  const preLines = codeBlocks[0].children.filter((n) => n.className === 'dsh-sel-pre-line')

  env.assert('代码块逐行成块', preLines.length === 7, `lines=${preLines.length}`)

  const wrapLines = preLines.filter((n) => n.getAttribute('data-wrap') === '1')

  env.assert('注释行可折行、代码行不折', wrapLines.length === 3 && wrapLines.every((n) => env.textOf(n).trim().indexOf('//') === 0), `wrap=${wrapLines.length}`)

  env.assert('代码行没有被标成可折行', !preLines.some((n) => n.getAttribute('data-wrap') === '1' && env.textOf(n).indexOf('const MAX') >= 0), preLines.map((n) => n.getAttribute('data-wrap') || '-').join(','))

  // 折行缩进：续行必须从注释起始列开始（padding-left 与 text-indent 等值反向）
  const indented = preLines.filter((n) => n.style.paddingLeft)

  env.assert('注释行的续行有悬挂缩进（padding 与负 text-indent 等值）', indented.length === 1 && indented[0].style.paddingLeft === '2ch' && indented[0].style.textIndent === '-2ch', indented.map((n) => n.style.paddingLeft + '/' + n.style.textIndent).join(','))

  // 行尾注释：拆成独立注释行，缩进 = 它在原行的起始列（这里第 8 列）
  const trailing = ['const a = 1 // 尾注', 'def b():  # 尾注']

  env.hook.open('尾注探测', '', '尾注')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  const trailLines = env.classesIn(env.sections[0], 'dsh-sel-pre-line')

  env.assert('行尾注释被拆成独立注释行', trailLines.length === 2 && env.textOf(trailLines[0]).trim() === 'const a = 1' && env.textOf(trailLines[1]).trim() === '// 尾注', trailLines.map((n) => JSON.stringify(env.textOf(n))).join(' , '))

  env.assert('行尾注释的缩进等于它原来的起始列', trailLines[1].style.paddingLeft === '12ch' && trailLines[1].style.textIndent === '-12ch', trailLines[1].style.paddingLeft + '/' + trailLines[1].style.textIndent)

  env.assert('代码块带主题标记（按底色选调色板）', codeBlocks[0].getAttribute('data-hl') === 'light' || codeBlocks[0].getAttribute('data-hl') === 'dark', String(codeBlocks[0].getAttribute('data-hl')))

  // 语言标记生效：python 的 # 是注释、def/return 是关键字
  env.hook.open(env.PY_SNIPPET, '上下文', '代码')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  const pyBlock = env.classesIn(env.sections[0], 'dsh-sel-pre')[0]

  env.assert('python 语言标记生效：# 行是注释', hl(pyBlock, 'dsh-hl-com').some((t) => t.indexOf('# 两数相加') >= 0), hl(pyBlock, 'dsh-hl-com').join(' | '))

  env.assert('python 关键字上色', hl(pyBlock, 'dsh-hl-kw').indexOf('def') >= 0 && hl(pyBlock, 'dsh-hl-kw').indexOf('return') >= 0, hl(pyBlock, 'dsh-hl-kw').join(','))

  env.assert('python 代码未被当成 javascript 注释规则', pyBlock.textContent.indexOf('def add(a, b):') >= 0, pyBlock.textContent.slice(0, 40))


  // 散文不能被误判成代码
  env.hook.open(env.PROSE_PROBE, '', '非代码')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.assert('普通文本仍标 kind=text（不误判成代码）', env.sent[env.sent.length - 1].kind === 'text' && env.sent[env.sent.length - 1].text === env.PROSE_PROBE, JSON.stringify({ kind: env.sent[env.sent.length - 1].kind }))

  env.assert('普通文本标题不受影响', sectionTitles()[0] === '翻译', JSON.stringify(sectionTitles()))


  // ───────────────────────── 追问也要有等待特效（和首轮同一套） ─────────────────────────
  env.hook.open('wait-ask-probe', '', '追问等待')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.hook.ask('这个要等多久？')

  await env.sleep(40)

  const askBubbles = () => Array.from(env.walk(env.chatLog)).filter((n) => n.className.indexOf('dsh-sel-bubble-bot') >= 0)

  let waitInBubble = env.classesIn(askBubbles()[askBubbles().length - 1], 'dsh-sel-wait')

  env.assert('追问等待期：助手气泡里出现等待特效', waitInBubble.length === 1 && env.textOf(waitInBubble[0]).indexOf('正在回答') >= 0, waitInBubble.length ? JSON.stringify(env.textOf(waitInBubble[0]).slice(0, 20)) : '未找到')

  env.assert('追问等待特效是动态的（呼吸点 + 流光条）', env.classesIn(waitInBubble[0] || new env.FakeEl('div'), 'dsh-sel-dots').length === 1 && env.classesIn(waitInBubble[0] || new env.FakeEl('div'), 'dsh-sel-sk').length >= 1, '')

  const askWaitNode = waitInBubble[0]

  let askClock = ''

  for (let i = 0; i < 14; i += 1) {
    const nodes = env.classesIn(askBubbles()[askBubbles().length - 1], 'dsh-sel-waitclock')
    askClock = nodes.length ? env.textOf(nodes[0]) : ''
    if (/^\d+\.\ds$/.test(askClock.trim())) break
    await env.sleep(40)
  }

  env.assert('追问等待期在走秒', /^\d+\.\ds$/.test(askClock.trim()), JSON.stringify(askClock))

  env.assert('追问等待期不重建节点（动画不被打断）', env.classesIn(askBubbles()[askBubbles().length - 1], 'dsh-sel-wait')[0] === askWaitNode, '')

  await env.sleep(400)

  const botBubbles = askBubbles()

  env.assert('首个字到达后等待特效换成正文', env.classesIn(botBubbles[botBubbles.length - 1], 'dsh-sel-wait').length === 0 && env.textOf(botBubbles[botBubbles.length - 1]).indexOf('等到了回答') >= 0, JSON.stringify(env.textOf(botBubbles[botBubbles.length - 1]).slice(0, 24)))

  // ───────────────────────── 本地缓存：同一个词再点一次必须秒回 ─────────────────────────
  env.hook.open('缓存探测词', '上下文片段 A', '缓存用例')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.assert('首次打开发出请求并落到本地缓存', env.hook.state().cache === 'miss' && env.textOf(env.sections[0]).indexOf('缓存测试内容') >= 0, `cache=${env.hook.state().cache}`)

  const sentAfterFirst = env.sent.length

  const t0open = Date.now()

  env.hook.open('缓存探测词', '上下文片段 A', '缓存用例')

  const openMs = Date.now() - t0open

  env.assert('同词同处再打开：不发请求（本地缓存命中）', env.sent.length === sentAfterFirst, `新增请求 ${env.sent.length - sentAfterFirst}`)

  env.assert('命中时同步渲染（不用等）', env.hook.state().phase === 'done' && env.textOf(env.sections[0]).indexOf('缓存测试内容') >= 0, `phase=${env.hook.state().phase} openMs=${openMs}`)

  env.assert('本地缓存标记仍在（自检可读）', /本地缓存/.test(String(env.hook.state().status || '')) && env.hook.state().cache === 'local', `${env.hook.state().cache} / ${env.hook.state().status}`)

  env.assert('自检钩子报出命中情况', env.hook.state().cache === 'local', String(env.hook.state().cache))

  const sentBeforeSpace = env.sent.length

  env.hook.open('缓存探测词 ', '上下文片段 A  ', '缓存用例')

  env.assert('多选一个空格也算命中（key 做了空白归一）', env.sent.length === sentBeforeSpace, `新增请求 ${env.sent.length - sentBeforeSpace}`)

  // 展开详解：结果要写回同一个 key（以前传 null，点一次跑一次）
  // 先切回原始选区文本（上一步的 hook.open 带了尾空格，会打到 live fixture 之外）
  env.hook.open('缓存探测词', '上下文片段 A', '缓存用例')

  env.hook.expand()

  for (let i = 0; i < 80 && !(env.hook.parts().detail || '').trim(); i += 1) await env.sleep(20)

  env.assert('展开详解产出内容', (env.hook.parts().detail || '').indexOf('详解内容') >= 0, JSON.stringify(env.hook.parts().detail))

  const sentAfterDetail = env.sent.length

  env.hook.open('缓存探测词', '上下文片段 A', '缓存用例')

  env.assert('展开后再打开：连详解一起命中，不发请求', env.sent.length === sentAfterDetail, `新增请求 ${env.sent.length - sentAfterDetail}`)

  env.assert('缓存里带着详解（两节都回来）', env.textOf(env.sections[1]).indexOf('详解内容') >= 0 && env.sections[1].style.display !== 'none', `detail=${env.textOf(env.sections[1]).slice(0, 20)} display=${env.sections[1].style.display}`)

  env.assert('两节都有时展开 CTA 隐藏', env.expandBtn.style.display === 'none', `display=${env.expandBtn.style.display}`)


  // 同词不同上下文：命中不了要说明白，而不是让用户以为缓存坏了
  const sentBeforeOther = env.sent.length

  env.hook.open('缓存探测词', '完全不同的上下文片段 B', '缓存用例')

  for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)

  env.assert('同词不同上下文会重新请求（缓存按上下文区分）', env.sent.length > sentBeforeOther, `新增请求 ${env.sent.length - sentBeforeOther}`)

  env.assert('"同词但上下文不同"仍有记录', /同词但上下文不同/.test(String(env.hook.state().status || '')) && env.hook.state().sameTextSeen === true, `${env.hook.state().sameTextSeen} / ${env.hook.state().status}`)

  env.assert('自检钩子报出 sameTextSeen', env.hook.state().sameTextSeen === true, String(env.hook.state().sameTextSeen))
}
