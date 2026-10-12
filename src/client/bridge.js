

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
export function bridgeBody() {
  if (window.__dshSelBridge) return
  window.__dshSelBridge = 1
  var WINDOW_CHARS = 1500
  var KEY_CHARS = 300
  // 帧内只守设置允许的最高边界；父页面按当前设置决定是否显示入口。
  var MAX_SELECTION = 20000
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
    var startElement = /** @type {Element | null} */ (start && start.nodeType === 1 ? start : start && start.parentElement)
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
export var BRIDGE_MARK = 'data-dsh-sel-bridge'

/**
 * 把桥脚本插进一份 HTML（返回新串；没有可插的地方 / 已经插过 → null）。
 *
 * 基础预览（srcdoc）那份 HTML 已经过宿主 DOMPurify 清洗：无脚本、无外链，
 * 且带一条 `script-src 'none'` 的 CSP。我们**只放宽这一条**到 'unsafe-inline'
 * （好让桥跑起来），`default-src 'none'` / `connect-src 'none'` / `img-src data:`
 * 等其余限制原样保留 —— 预览页依然联不了网、加载不了外部资源。
 */
export function bridgeIntoHtml(html) {
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
export function insertIntoHtml(html, tag) {
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