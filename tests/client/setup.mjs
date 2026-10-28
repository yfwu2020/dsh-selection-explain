import { createDomFixture } from './fixtures/dom.mjs'
import { createApiFixture } from './fixtures/api.mjs'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function createClientFixture() {


  const HERE = dirname(fileURLToPath(import.meta.url))

  const BUNDLE = process.argv[2] || resolve(HERE, '..', '..', 'lib', 'client.js')


  // ───────────────────────── 最小 DOM ─────────────────────────
  const { ResizeObserverStub, windowStub, documentStub, navigatorStub, FakeEl, body, textOf, resizeObservers, walk } = createDomFixture()

  // ───────────────────────── 载入 bundle ─────────────────────────
  const source = readFileSync(BUNDLE, 'utf8')

  globalThis.ResizeObserver = ResizeObserverStub

  // 临时实验：关掉收尾复核
  if (typeof windowStub !== 'undefined') windowStub.__DSH_DISABLE_FOCUS_VERIFY = false

  const blobStore = new Map()
  const api = createApiFixture({ blobStore })

  let blobSeq = 0

  URL.createObjectURL = (blob) => {
    blobSeq += 1
    const url = `blob:stub/${blobSeq}`
    blobStore.set(url, blob)
    return url
  }

  URL.revokeObjectURL = (url) => {
    blobStore.delete(url)
  }

  new Function('window', 'document', 'location', 'navigator', 'requestAnimationFrame', 'fetch', source)(
    windowStub,
    documentStub,
    { href: api.ORIGIN + '/' },
    navigatorStub,
    (cb) => setTimeout(cb, 0),
    api.browserFetch,
  )

  const captured = globalThis.__captured


  /** 把 DOM 桩打成缩进大纲，便于人眼核对层次。 */
  function outline(node, depth) {
    if (!node || depth > 5) return ''
    const indent = '  '.repeat(depth)
    const cls = node.className ? '.' + node.className.split(' ').join('.') : ''
    const level = node.getAttribute && node.getAttribute('data-level') !== null ? `[level=${node.getAttribute('data-level')}]` : ''
    const num = node.getAttribute && node.getAttribute('data-num') ? '[num]' : ''
    const own = (node._text || '').trim()
    let out = `${indent}${node.tagName.toLowerCase()}${cls}${level}${num}${own ? '  ' + own.slice(0, 70) : ''}\n`
    for (const child of node.children || []) out += outline(child, depth + 1)
    return out
  }


  const assert = (label, ok, extra) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)
    if (!ok) process.exitCode = 1
  }


  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  assert('bundle 注册 ModuleLoader 工厂', !!captured && typeof captured.factory === 'function', captured && captured.id)


  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  }

  const modules = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })

  assert("导出 apply / inject(['slots'])", typeof modules.apply === 'function' && Array.isArray(modules.inject) && modules.inject[0] === 'slots')


  // ───────────────────────── 假 ctx + 槽注册 ─────────────────────────
  const disposers = []

  let registration = null

  const ctx = {
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    on() {},
    get(name) {
      if (name === 'uiSession') {
        return { adapter: { current: { getSnapshot: () => ({
          key: globalThis.__sessionStubId || 'session-stub-1',
          props: { sessionId: globalThis.__sessionStubId || 'session-stub-1' },
        }) } } }
      }
      if (name === 'sessions') {
        return {
          list: { getSnapshot: () => ({ ids: ['session-stub-1'], byId: {}, phase: 'ready', projectionsBySession: {} }) },
          open: (id) => {
            api.openedSessions.push(String(id))
          },
        }
      }
      return undefined
    },
    slots: {
      inject(key, callback) {
        assert('注册到 shell.overlay 槽', key === 'shell.overlay', key)
        const d = callback()
        if (typeof d === 'function') disposers.push(d)
        return d
      },
      register(options, component) {
        registration = { options, component }
        return () => {}
      },
    },
  }

  modules.apply(ctx)

  assert('槽注册带 id/order', !!registration && registration.options.id === '@yfwu2020/dsh-selection-explain' && registration.options.order === 20, JSON.stringify(registration && registration.options))


  // React 渲染 → ref 挂载 layer
  const mount = new FakeEl('div')

  const element = registration.component()

  assert('浮层组件返回 React 元素', !!element && element.type === 'div')

  element.props.ref(mount)

  const floatingLayer = body.children.find((c) => c.className === 'dsh-sel-layer')

  assert('界面挂在 body 自有根，不提升公共槽', !!floatingLayer && floatingLayer.parentNode === body && mount.children.length === 0)

  assert('自有根声明公开的小窗归属', floatingLayer && floatingLayer.getAttribute('data-dsh-floating-owner') === 'explanation')

  assert('重渲染使用稳定挂载 ref', registration.component().props.ref === element.props.ref)


  // ───────────────────────── 划词 → 浮标 ─────────────────────────
  const container = new FakeEl('div')

  const textEl = new FakeEl('span')

  textEl._text = 'Dev: the migration ran long, so we ship Wednesday. PM: fine, freeze features.'

  container.appendChild(textEl)

  body.appendChild(container)

  /** 选区桩：记下 removeAllRanges 有没有被调用（点「解读」后要把本文档选区收掉）。 */
  const clearedSelections = { count: 0 }

  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => 'the migration ran long',
    getRangeAt: () => documentStub.createRange(),
    removeAllRanges() {
      clearedSelections.count += 1
    },
  }

  windowStub.getSelection = () => selection

  documentStub.dispatch('mouseup', { target: body })

  await new Promise((r) => setTimeout(r, 20))

  const button = floatingLayer.children.find((c) => c.className === 'dsh-sel-btn')

  assert('选中文字后浮标出现', !!button && button.style.display === 'inline-flex', button && `left=${button.style.left} top=${button.style.top}`)

  // 浮现动效：只在"隐藏 → 显示"那一次挂动效类；已可见时只平移；animationend 后自动摘掉
  {
    const css = readFileSync(BUNDLE, 'utf8')
    assert('CSS 契约：有 pop 关键帧（74% → 100%）', /@keyframes dsh-sel-pop\{from\{opacity:0;transform:scale\(\.74\) translateY\(6px\)\}to\{opacity:1;transform:none\}\}/.test(css), '')
    assert('CSS 契约：动效 240ms + 带过冲的缓动', /\.dsh-sel-btn\[data-pop="1"\]\{animation:dsh-sel-pop \.24s cubic-bezier\(\.34,1\.56,\.64,1\) both\}/.test(css), '')
    assert('CSS 契约：缩放原点是锚点（右下角）', /\.dsh-sel-btn\{transform-origin:100% 100%/.test(css), '')
    assert('CSS 契约：reduced-motion 下关掉 pop', /@media \(prefers-reduced-motion:reduce\)\{[\s\S]{0,400}?\.dsh-sel-btn\[data-pop="1"\]\{animation:none\}/.test(css), '')

  }


  // ───────────────────────── 选中的文字被删掉 → 浮标必须消失 ─────────────────────────
  // 用户报的：划词浮标出来之后，把那段文字删了（Backspace / 打字覆盖 / 内容刷新把节点换掉），
  // 浮标还赖在屏幕上不走，点下去解读的是一段**屏幕上已经不存在**的文字。
  {
    const rect = { left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }
    /** 造一段"落在 node 上"的选区（锚点就是 node —— isConnected 那条判定要用它）。 */
    const selectOn = (node, text) => {
      const range = {
        startContainer: node,
        endContainer: node,
        cloneRange: () => range,
        getClientRects: () => [rect],
        getBoundingClientRect: () => rect,
      }
      windowStub.getSelection = () => ({
        isCollapsed: false,
        rangeCount: 1,
        toString: () => text,
        getRangeAt: () => range,
      })
    }

    // ① 拖拽划词进行中（鼠标按着）：不弹浮标 —— 时机要和"松手才弹"一致
    selectOn(textEl, 'the migration ran long')
    documentStub.dispatch('mousedown', { target: container })
    documentStub.dispatch('selectionchange', {})
    await sleep(20)
    assert('拖拽中（鼠标按着）不弹浮标', button.style.display === 'none', String(button.style.display))
    documentStub.dispatch('mouseup', { target: container })
    await sleep(20)
    assert('松手后照常弹浮标', button.style.display === 'inline-flex', String(button.style.display))

    // ② 选区塌陷（Backspace / Delete / 打字覆盖 / 剪切走的都是这条）：浏览器发 selectionchange
    windowStub.getSelection = () => ({ isCollapsed: true, rangeCount: 0, toString: () => '' })
    documentStub.dispatch('selectionchange', {})
    await sleep(20)
    assert('选中的文字被删掉（选区塌陷）→ 浮标消失', button.style.display === 'none', String(button.style.display))

    // ③ 选区**没塌陷**、锚点节点却已经被摘掉（Firefox 的行为）：靠 isConnected 判死
    selectOn(textEl, 'the migration ran long')
    documentStub.dispatch('mouseup', { target: container })
    await sleep(20)
    assert('（准备）浮标重新亮着', button.style.display === 'inline-flex', String(button.style.display))
    textEl.isConnected = false
    documentStub.dispatch('selectionchange', {})
    await sleep(20)
    assert('选中的节点被摘掉（选区没塌陷）→ 浮标也消失', button.style.display === 'none', String(button.style.display))
    delete textEl.isConnected

    // 还原成开头那段选区：后面的用例还要点这个浮标开小窗
    windowStub.getSelection = () => selection
    documentStub.dispatch('mouseup', { target: body })
    await sleep(20)
    assert('（还原）浮标回到可见', button.style.display === 'inline-flex', String(button.style.display))
  }


  // 引用（❝）的**离线**契约：浮标进了浮层、CSS 规则齐全（真实交互在宿主可达时另有一段）
  {
    const css = readFileSync(BUNDLE, 'utf8')
    const quoteBtn = Array.from(walk(floatingLayer)).find((n) => String(n.className).indexOf('dsh-sel-quotebtn') >= 0)
    assert('浮层里有「❝ 引用」浮标，且默认藏着', !!quoteBtn && quoteBtn.style.display === 'none' && textOf(quoteBtn).indexOf('引用') >= 0, quoteBtn ? textOf(quoteBtn) : '未找到')
    assert('CSS 契约：引用区默认收起、data-show 控制显隐', /\.dsh-sel-quotes\{display:none;flex-direction:column/.test(css) && /\.dsh-sel-quotes\[data-show="1"\]\{display:flex\}/.test(css), '')
    assert('CSS 契约：引用卡片三段（来源 / 摘要 / 删除）', /\.dsh-sel-quotechip-src\{/.test(css) && /\.dsh-sel-quotechip-text\{/.test(css) && /\.dsh-sel-quotechip-x\{/.test(css), '')
    assert('CSS 契约：气泡里的引用块单行省略（长引用不撑破气泡）', /\.dsh-sel-bqitem\{[\s\S]{0,420}?text-overflow:ellipsis;white-space:nowrap\}/.test(css), '')
    assert('CSS 契约：「引用整条」平时隐身，鼠标移到这条消息上才出现', /\.dsh-sel-bubquote\{[\s\S]{0,520}?opacity:0;transition:opacity/.test(css) && /\.dsh-sel-bubble:hover \.dsh-sel-bubquote,\.dsh-sel-bubquote:focus-visible\{opacity:\.66\}/.test(css), '')
  }



  // ───────────────────────── 点击 → 弹窗 + 真实 host 流 ─────────────────────────
  // ⚠️ 开场先清一次设置覆盖。
  // 这套用例后面会把 provider/model 写成夹具里的假 provider（p1），而它落在**真实 host** 上；
  // 万一上一次跑崩在中途（没走到收尾的 reset），残留的 p1 会让接下来的真实解读全部 503 ——
  // 表现为"流式渲染失败"一大片，看起来像插件坏了，其实是脏状态。
  // 所以清理要放在**最前面**（收尾那次仍然保留，正常路径下不留痕迹）。
  try {
    await fetch(api.ORIGIN + '/selection-explain/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    })
  } catch (error) {
    /* host 不可达时后面本来就会跳过在线断言 */
  }


  button.dispatch('click', { preventDefault() {}, stopPropagation() {} })

  const panel = floatingLayer.children.find((c) => c.className === 'dsh-sel-panel')

  // 面板内的固定引用点（后续断言共用）
  const sections = Array.from(walk(panel)).filter((node) => node.className.indexOf('dsh-sel-sec') >= 0)

  const panelHead = Array.from(walk(panel)).find((node) => node.className === 'dsh-sel-head')

  const histBtn = Array.from(walk(panelHead)).find((n) => n.className.indexOf('dsh-sel-action') >= 0 && textOf(n).indexOf('最近') >= 0)

  const histList = floatingLayer.children.find((n) => n.className === 'dsh-sel-history')

  assert('「最近聊过的」是独立浮层，不在消息滚动区里（B 方案）', !!histList && histList.parentNode.className === 'dsh-sel-layer' && !panel.contains(histList), histList ? histList.parentNode.className : '未找到')

  const detailCard = sections.find((node) => node.getAttribute('data-sec') === 'detail')

  const expandBtn = Array.from(walk(panel)).find((node) => node.className === 'dsh-sel-expand')

  const chatLog = Array.from(walk(panel)).find((node) => node.className === 'dsh-sel-chatlog')

  const askRow = Array.from(walk(panel)).find((node) => node.className === 'dsh-sel-ask')

  assert('弹窗打开', !!panel && panel.style.display === 'flex')

  assert('弹窗显示选中文字', !!panel && textOf(panel).indexOf('the migration ran long') >= 0)

  // 点完「解读」立刻把本文档选区收掉：留着它，小窗开着时按个方向键又会冒出一个「❝ 引用」，
  // 指的是刚才解读的那段文字（解读要的文字与上下文在 mouseup 那刻就抓好了，见 openForSelection）
  assert('点「解读」后本文档选区被收掉', clearedSelections.count >= 1, `removeAllRanges 调用 ${clearedSelections.count} 次`)

  {
    const quoteBtnNode = Array.from(walk(floatingLayer)).find((n) => String(n.className).indexOf('dsh-sel-quotebtn') >= 0)
    assert(
      '点「解读」后引用浮标不出现（旧选区不该复活它）',
      !quoteBtnNode || quoteBtnNode.style.display === 'none',
      quoteBtnNode ? String(quoteBtnNode.style.display) : '浮标节点还没建出来（= 没显示）',
    )
  }


  const hook = windowStub.__dshSelectionExplain

  assert('自检钩子可用', !!hook && typeof hook.state === 'function')


  // ── 宿主可达性探测 ──
  // 本脚本的一部分断言是**真实 host 集成测试**（连 ORIGIN 上的 /ping 与 SSE /analyze）。
  // 本地开发时 host 在跑，这些断言全跑；CI（GitHub Actions）里没有宿主，
  // 此时**跳过**在线断言并打印说明，而不是抛 ECONNREFUSED 崩掉整条发布流水线。
  let HOST_UP = false

  let ping = null

  try {
    ping = await hook.ping()
    HOST_UP = !!(ping && ping.ok === true)
  } catch (error) {
    HOST_UP = false
  }

  if (HOST_UP) {
    assert('host ping 可达', !!ping && ping.ok === true, JSON.stringify(ping && ping.route))
    assert('请求载荷携带当前会话 id', api.sent.length > 0 && api.sent[0].sessionId === 'session-stub-1', JSON.stringify(api.sent[0] && { sessionId: api.sent[0].sessionId, label: api.sent[0].label }))
    assert('载荷不带 effort（推理档位固定在 host 配置）', api.sent[0] && api.sent[0].effort === undefined, String(api.sent[0] && api.sent[0].effort))
    assert(
      '三档档位都能从 /ping 读到',
      !!ping && !!ping.reasoningEffortByStage && typeof ping.reasoningEffortByStage.translation === 'string' && typeof ping.reasoningEffortByStage.detail === 'string' && typeof ping.reasoningEffortByStage.chat === 'string',
      JSON.stringify(ping && ping.reasoningEffortByStage),
    )
  } else {
    console.log(`SKIP  host 不可达（${api.ORIGIN}）—— 跳过在线断言（/ping 可达性、SSE 流式渲染、面板交互）`)
    console.log('SKIP  本地开发想跑全量：先启动 DSH（默认 http://127.0.0.1:3080）再执行本脚本')
  }
  return {
    get classesIn() { return (root, cls) => Array.from(walk(root)).filter(node => String(node.className).split(/\s+/).includes(cls)) },
    get askBox() { return Array.from(walk(askRow)).find(node => node.className === 'dsh-sel-askbox') },
    get askSend() { return Array.from(walk(askRow)).find(node => String(node.className).split(/\s+/).includes('dsh-sel-asksend')) },
    get HOST_UP() { return HOST_UP },
    get ORIGIN() { return api.ORIGIN },
    get hook() { return hook },
    get assert() { return assert },
    get sent() { return api.sent },
    get detailCard() { return detailCard },
    get expandBtn() { return expandBtn },
    get textOf() { return textOf },
    get sections() { return sections },
    get panel() { return panel },
    get walk() { return walk },
    get askRow() { return askRow },
    get sleep() { return sleep },
    get chatLog() { return chatLog },
    get panelHead() { return panelHead },
    get outline() { return outline },
    get selection() { return selection },
    get documentStub() { return documentStub },
    get body() { return body },
    get button() { return button },
    get FakeEl() { return FakeEl },
    get windowStub() { return windowStub },
    get promoted() { return api.promoted },
    get openedSessions() { return api.openedSessions },
    get BUNDLE() { return BUNDLE },
    get resizeObservers() { return resizeObservers },
    get histBtn() { return histBtn },
    get histList() { return histList },
    get CODE_SNIPPET() { return api.CODE_SNIPPET },
    get PY_SNIPPET() { return api.PY_SNIPPET },
    get PROSE_PROBE() { return api.PROSE_PROBE },
    get historySaved() { return api.historySaved },
    get container() { return container },
    get browserFetch() { return api.browserFetch },
    get blobStore() { return blobStore },
    get textEl() { return textEl },
    get quoteContextCalls() { return api.quoteContextCalls },
    get navigatorStub() { return navigatorStub },
    get speechTranscribeCalls() { return api.speechTranscribeCalls },
    get speechTranscript() { return api.speechTranscript },
    set speechTranscript(value) { api.speechTranscript = value },
    get speechCatalog() { return api.speechCatalog },
    set speechCatalog(value) { api.speechCatalog = value },
    get speechPrepareCalls() { return api.speechPrepareCalls },
    set speechPrepareCalls(value) { api.speechPrepareCalls = value },
    get speechTranscriptQueue() { return api.speechTranscriptQueue },
    set speechTranscriptQueue(value) { api.speechTranscriptQueue = value },
    get speechTranscriptRepeat() { return api.speechTranscriptRepeat },
    set speechTranscriptRepeat(value) { api.speechTranscriptRepeat = value },
    get floatingLayer() { return floatingLayer },
    get micStub() { return api.micStub },
    get settingsStub() { return api.settingsStub },
    get disposers() { return disposers },
    get sizeStore() { return api.sizeStore },
    set sizeStore(value) { api.sizeStore = value },
    get mount() { return mount },
  }
}
