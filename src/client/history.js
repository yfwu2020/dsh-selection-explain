import { isDarkSurface, renderRich, splitSections } from './render.js'
import { HISTORY } from './constants.js'
import { el, listen } from './dom.js'
import { attachmentUrl, formatBytes, extensionOf } from './attach.js'

/** history state and operations; dependencies are supplied as live node/callback accessors. */
export function createHistoryController(env) {

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
    if (turn.role === 'user') return env.sentTextOf(turn)
    if (keepRaw) return turn.text
    if (typeof turn.foldedCache === 'string') return turn.foldedCache
    if (turn.streaming === true) return turn.text
    var folded = foldForHistory(turn.text)
    turn.foldedCache = folded
    return folded
  }

  /**
   * 当前面板底色是深还是浅（'dark' | 'light'）。
   *
   * 用途：网页输出时告诉 host 该按哪套配色生成页面 —— 深色 Harness 里给一张白底页面很刺眼。
   * 判据优先用面板自己的 `data-theme`（painter 已经按实际底色设过），
   * 没有就现算一次 `isDarkSurface`，再不行按浅色兜底。
   */
  function currentSurfaceTheme() {
    try {
      // ① 先读 **DSH 自己的信号**：`body[data-ds-dark-theme]`。
      //    这是 DSH 把"当前配色方案"投影到 document 的结果 —— 用户选的是
      //    「浅色 / 深色 / 跟随系统」哪一档都无所谓，这里拿到的都是**最终结论**。
      // 踩过的坑：一开始只看面板的合成底色（isDarkSurface）—— 面板底色取自 DSH 变量、
      // 自身与祖先的 background-color 往往是透明的，于是被算成浅色。
      // 用户实测：外观设为"跟随系统（暗）"时，生成的网页却是亮色。
      var bodyEl = document.body
      if (bodyEl && bodyEl.getAttribute && bodyEl.getAttribute('data-ds-dark-theme') !== null) return 'dark'
      // ② html 的 color-scheme：DSH 同时用它驱动原生控件，浅/深都会写上
      var rootEl = document.documentElement
      if (rootEl) {
        var scheme = ''
        try {
          scheme = String((window.getComputedStyle(rootEl) || {}).colorScheme || '')
        } catch (error) {
          scheme = ''
        }
        if (!scheme && rootEl.style) scheme = String(rootEl.style.colorScheme || '')
        if (scheme.indexOf('dark') >= 0) return 'dark'
        if (scheme.indexOf('light') >= 0) return 'light'
      }
      // ③ 面板自己的 data-theme（painter 设过）
      var attr = env.panel && env.panel.getAttribute ? env.panel.getAttribute('data-theme') : ''
      if (attr === 'dark' || attr === 'light') return attr
      // ④ 合成底色兜底（可能误判，所以放在后面）
      if (isDarkSurface(env.panel)) return 'dark'
      // ⑤ 最后才问系统偏好（"跟随系统"且上面都读不到时的兜底）
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
      return 'light'
    } catch (error) {
      return 'light'
    }
  }

  /** 当前可见的原文。
   *
   * 以前这里会剥掉"伪造的工具调用"文本（DSML / ds_safety_tool_call），
   * 现在**不再做任何文本清洗** —— 照主会话的做法：工具每轮都在请求里，
   * 模型走协议层表达调用，正文里根本不该出现这种标记。
   * 清洗留在那儿只会再吃一次正文（未闭合就删到结尾）。 */
  function visibleRaw() {
    return env.state.raw
  }

  // ────────────────────── 小窗对话历史（A′） ──────────────────────
  //
  // 不建会话：条目存在插件自己的目录里（host 侧 LRU 20 条）。这里负责三件事：
  //   ① 每轮结束把整段对话写回去（翻译/详解/追问/升格）
  //   ② 打开同一个词时先问 host 要历史，命中就直接回放（不调模型）
  //   ③ 「最近聊过的」列表，点一条把那段对话整个调回来

  /** 把当前状态存成一条历史（整段覆盖）。 */
  function saveHistory(options) {
    var payload = env.state.payload
    if (!payload || !env.state.cacheKey) return
    var turns = []
    var exported = env.exportTurns()
    for (var i = 0; i < env.state.turns.length; i += 1) {
      var turn = env.state.turns[i]
      if (turn.hidden === true) continue
      // 落盘的是"实际发出去的那份"（用户那轮带引用块）：回放出来时这轮对话是自洽的
      turns.push(exported[i])
    }
    try {
      fetch(HISTORY, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: env.state.cacheKey,
          text: payload.text,
          context: payload.context,
          label: payload.label,
          parts: env.state.parts,
          turns: turns,
          toolDigest: env.state.toolDigest,
          pinned: !!(options && options.pinned),
          // 这段对话有没有解读，必须跟着条目落盘：回放时靠它决定画不画「翻译」一节。
          // 不落盘的话，语音卡那条"跳过翻译与详解、直接追问"的对话下次开出来，
          // 会顶着一张空翻译卡片（"这次没有返回内容"）——用户实测。
          skipped: env.state.skipInterpretation === true,
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
    env.state.parts = { translation: parts.translation || '', detail: parts.detail || '' }
    // 「这段对话有没有解读」跟着条目走：没有解读的对话（语音卡"跳过翻译与详解、直接追问"）
    // 回放时也不画翻译节 —— 否则回放会画出一张空的「翻译 /（这次没有返回内容）」卡片，
    // 而那正是用户否掉的东西。反过来也重要：回放一段**有**解读的对话时必须把标记清掉，
    // 否则上一段跳过解读的对话留下的标记会把这一段的翻译整节藏掉。
    //
    // 老条目（skipped 这个键是后来才加的）没有键时按内容兜一次：既没有翻译、也没有详解，
    // 却已经有追问轮次 —— 这段对话本来就没有解读。只在键**缺失**时兜：
    // 显式 false 的含义是"跑过解读、结果为空"，那是另一回事。
    //
    // ⚠️ 但"缺失"这条路实际走不到：旧版宿主读盘时把缺失写成了 false（已修）。
    // 所以被写坏的那批显式 false 条目，是靠 paint() 里的**内容兜底**兜住的
    // （见 panel.js：一节正文都没有 + 已有追问 → 整节不画）。这里保持语义精确：
    // 只有 true 和"缺失"能推出"跳过解读"，false 不推。
    var replayTurns = Array.isArray(entry.turns) ? entry.turns : []
    var hasAskTurn = false
    for (var step = 0; step < replayTurns.length; step += 1) {
      if (replayTurns[step] && replayTurns[step].role === 'user') {
        hasAskTurn = true
        break
      }
    }
    var noInterpretation = !String(parts.translation || '').trim() && !String(parts.detail || '').trim()
    env.state.skipInterpretation =
      entry.skipped === true || (entry.skipped === undefined && noInterpretation && hasAskTurn)
    env.state.turns = Array.isArray(entry.turns) ? entry.turns.slice() : []
    // 回放的是**另一段**对话：输入框里攒的引用跟着清掉
    env.clearQuotes()
    env.state.toolDigest = typeof entry.toolDigest === 'string' ? entry.toolDigest : ''
    env.state.cacheKey = entry.key
    env.state.payload = env.buildPayload(entry.text, entry.context, entry.label)
    env.state.kind = env.state.payload.kind
    env.state.stage = ''
    env.state.raw = ''
    env.state.phase = 'done'
    env.state.error = ''
    // 打开历史/命中缓存也是"已完成"状态 → 光标交回输入框
    env.askFocusAfterTurn()
    env.state.sharedCache = false
    env.state.fromCache = source === 'local'
    env.state.fromHistory = source !== 'local'
    env.state.elapsed = 0
    env.state.toolBusy = false
    env.state.cacheState = source === 'local' ? 'local' : 'history'
    env.state.chars = (env.state.parts.translation || '').length + (env.state.parts.detail || '').length
    env.quote.textContent = entry.text.length > 240 ? entry.text.slice(0, 240) + ' …' : entry.text
    env.applySectionTitle(env.state.kind, entry.text)
    hideHistoryList()
    env.paint()
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
      if (env.state.cacheKey === cacheKey && onMiss) onMiss()
    }
    var timer = setTimeout(miss, 1500)
    env.timers.push(timer)
    try {
      fetch(HISTORY + '?key=' + encodeURIComponent(cacheKey))
        .then(function (response) {
          return response.json()
        })
        .then(function (data) {
          if (settled) return
          // 期间用户换了选区：丢弃
          if (env.state.cacheKey !== cacheKey || env.panelOpen !== true) {
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
    env.historyList.style.display = 'none'
    env.historyButton.removeAttribute('data-on')
  }

  /**
   * 把列表摆到面板旁边（B 方案）：
   *   ① 优先右侧（面板右边还有 220px 空间）
   *   ② 放不下就翻到左侧
   *   ③ 两侧都放不下（窄屏）→ 覆盖在面板正文上，仍然**不**进消息滚动区
   * 高度跟面板对齐（上限视口高度），自带滚动条。
   */
  function placeHistoryList() {
    var rect = env.panelLayoutRect()
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
    env.historyList.setAttribute('data-side', side)
    env.historyList.style.left = Math.round(left) + 'px'
    env.historyList.style.top = Math.round(top) + 'px'
    env.historyList.style.width = Math.round(width) + 'px'
    env.historyList.style.maxHeight = Math.round(height) + 'px'
  }

  function toggleHistoryList() {
    if (env.historyList.style.display === 'flex') {
      hideHistoryList()
      return
    }
    env.historyList.style.display = 'flex'
    env.historyButton.setAttribute('data-on', '1')
    placeHistoryList()
    openHistoryList()
  }

  /** 拉取并渲染历史列表（开关打开时、以及撤销之后都走这里）。 */
  function openHistoryList() {
    env.historyList.textContent = ''
    env.historyList.appendChild(el('div', 'dsh-sel-historytitle', '最近聊过的（点一条调回那段对话）'))
    var loading = el('div', 'dsh-sel-historyempty', '读取中…')
    env.historyList.appendChild(loading)
    fetch(HISTORY)
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        var entries = data && Array.isArray(data.entries) ? data.entries : []
        env.historyList.textContent = ''
        env.historyList.appendChild(el('div', 'dsh-sel-historytitle', '最近聊过的（点一条调回那段对话）'))
        if (entries.length === 0) {
          env.historyList.appendChild(el('div', 'dsh-sel-historyempty', '还没有历史——问过的问题会留在这里'))
          return
        }
        for (var i = 0; i < entries.length; i += 1) {
          env.historyList.appendChild(historyRow(entries[i]))
        }
      })
      .catch(function () {
        env.historyList.textContent = ''
        env.historyList.appendChild(el('div', 'dsh-sel-historyempty', '读不到历史'))
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
          env.setStatus('删除失败')
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
        env.setStatus('删除失败：' + String((error && error.message) || error))
      })
  }

  /** 底部"已删除 · 撤销"，5 秒后自己消失。 */
  function showUndoBar(snapshot) {
    var existing = null
    for (var i = 0; i < env.historyList.children.length; i += 1) {
      if (String(env.historyList.children[i].className).indexOf('dsh-sel-undo') >= 0) existing = env.historyList.children[i]
    }
    if (existing) env.historyList.removeChild(existing)
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
          env.setStatus('已恢复')
          openHistoryList()
        })
        .catch(function () {
          env.setStatus('恢复失败')
        })
    })
    bar.appendChild(undo)
    env.historyList.appendChild(bar)
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
    var fromList = env.historyList.style.display === 'flex'
    fetch(HISTORY + '?key=' + encodeURIComponent(key))
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        if (!data || data.ok !== true || !data.entry) return
        env.panelOpen = true
        env.panel.style.display = 'flex'
        applyHistoryEntry(data.entry, 'history')
        // 先画内容再摆位置：showPanel 要量面板高度才能决定放上面还是下面
        if (!fromList) env.showPanel(anchor || env.rectOfPill())
        // 从列表进入时**不走 showPanel**（面板不挪位置）—— 轮询与跟随值这里自己补上
        else { env.refreshFollowRoute(); env.syncRouteWatch(); env.warmModelCatalog() }
        // 内容换了、面板高度可能变 → 列表跟着重摆（列表此时已被 applyHistoryEntry 收起，按需再开）
        if (env.historyList.style.display === 'flex') placeHistoryList()
      })
      .catch(function () {
        /* noop */
      })
  }

  /**
   * 撤掉"进行中"类提示：`conclusion-retry`（"查询已完成，正在整理结论…"）是**过程状态** ——
   * 正文一开始到达、或者本轮结束，它就该消失。
   *
   * 踩过的坑：这条提示写进 answerTurn.notice 之后，**全代码没有任何地方清掉它** ——
   * 回答早就写完了，黄条还挂在气泡上（用户截图报的现象）。
   * 其余 notice（effort-clamped / effort-rejected / reasoning-leak）是"这条回答发生了什么"的
   * 说明，属于该留下的信息，不在这里清。
   */
  function clearTransientNotice(turn) {
    if (!turn) return false
    var code = String(turn.noticeCode || '')
    // conclusion-retry：进行中状态，正文到了就撤；
    // upstream-retry：上游偶发错误（host 已换档重试），重试成功时正文会到、失败时走 error，
    //   两种情况都不该把这句一直挂在回答上面。
    // effort-rejected / reasoning-leak 是"这个模型这一档有问题"的结论性说明，留着。
    if (code !== 'conclusion-retry' && code !== 'upstream-retry') return false
    turn.notice = ''
    turn.noticeCode = ''
    return true
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
    env.state.toolDigest = (env.state.toolDigest ? env.state.toolDigest + '\n' : '') + line
    if (env.state.toolDigest.length > 1800) env.state.toolDigest = env.state.toolDigest.slice(-1800)
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
    for (var i = 0; i < env.state.tools.length; i += 1) {
      if (env.state.tools[i].callId === callId && env.state.tools[i].phase === 'running' && phase === 'done') {
        item = env.state.tools[i]
        break
      }
    }
    if (!item) {
      item = { callId: callId, name: message.name, detail: message.detail, phase: 'running' }
      env.state.tools.push(item)
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
    env.state.toolBusy = phase !== 'done'
    if (env.state.toolBusy) env.setStatus(env.progressText())
  }

  /**
   * 内容变化前先量一次"现在是不是贴着底"。
   *
   * 之前用 scroll 事件维护 followScroll 开关：程序化 scrollTop 赋值本身也会派发 scroll，
   * 叠上流式追加，很容易算出一次假的"用户往上翻了"，开关一旦翻成 false 就再也不跟了——
   * 表现就是"追问后消息不回到底部"。改成变化前测量，稳。
   */
  function nearBottom() {
    return env.body.scrollHeight - env.body.scrollTop - env.body.clientHeight < 40
  }

  var stickAt = 0

  function stickToBottom() {
    stickAt = Date.now()
    env.body.scrollTop = env.body.scrollHeight
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
      if (env.state.follow) stickToBottom()
    })
    chatGrowWatch.observe(env.chatLog)
    return function () {
      if (chatGrowWatch) chatGrowWatch.disconnect()
      chatGrowWatch = null
    }
  }

  /**
   * 面板被内容顶出屏幕 → 收回可视区。
   *
   * 为什么需要：开窗时"放得下吗"是按**当时**的高度算的（那会儿往往只有一行翻译在流），
   * 之后正文长高（上限 78vh 或 720px），面板从固定的 top 往下长 —— 而它是 position:fixed、
   * 页面不滚，被顶出视口的那部分（通常是回复框）就点不到了（实测能挂出去 287px）。
   *
   * 用面板**自己**的 ResizeObserver：只在尺寸变化时触发（内容长高、拖拽、阶段切换都算），
   * 而挪位置（left/top）不改变尺寸 → 不存在"写回自身"的循环。
   * 每帧只多一次 getBoundingClientRect，且只在真的溢出时才写样式。
   */
  var panelGrowWatch = null

  /**
   * 复核一次：面板被顶出视口就收回来（只在真的溢出时才写样式）。
   *
   * 两条入口都会调它：
   *   · paint() —— 流式/内容变化时的**主力**（渲染本来就节流在 90ms，一次 rect 读约 0.02ms）；
   *   · 面板自己的 ResizeObserver —— 兜住不经过 paint 的尺寸变化（阶段切换、composer 长高）。
   *
   * ⚠️ 曾经只挂 ResizeObserver，实测**不生效**：内容长高时面板往往已经顶到 max-height，
   * 伸长的是内部滚动区 —— 面板尺寸不变，观察器根本不触发（冒烟用例里探针显示 open:false、
   * 且灌内容后零唤醒）。所以主力必须是绘制路径上的复核。
   */
  function ensurePanelInsideViewportNow() {
    if (!env.panelOpen || env.panelInteracting) return
    var rect = env.panelLayoutRect()
    if (rect.bottom <= window.innerHeight - 4) return
    env.clampPanelPosition()
  }

  function ensurePanelInsideViewport() {
    if (panelGrowWatch || typeof ResizeObserver !== 'function') return null
    panelGrowWatch = new ResizeObserver(function () {
      ensurePanelInsideViewportNow()
    })
    panelGrowWatch.observe(env.panel)
    return function () {
      if (panelGrowWatch) {
        panelGrowWatch.disconnect()
        panelGrowWatch = null
      }
    }
  }

  /** 滚轮/触摸：用户自己滚 = 立刻收回跟随权；滚回底部再交还。 */
  function noteUserScroll(event) {
    var up = event && typeof event.deltaY === 'number' && event.deltaY < 0
    if (up) env.state.follow = false
    else env.state.follow = nearBottom()
  }

  /**
   * 普通 scroll（拖动滚动条、键盘、惯性滚动都会走到这里）。
   * 程序化赋值 scrollTop 同样会派发 scroll —— 用 stickAt 时间戳把"自己贴的底"排除，
   * 否则会被误判成"用户往上翻"，开关翻掉后再也不跟（这个坑之前踩过）。
   */
  function noteBodyScroll() {
    if (Date.now() - stickAt < 150) return
    env.state.follow = nearBottom()
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
    for (var i = 0; i < env.state.turns.length; i++) {
      // 种子轮（前情提要）只发给模型当上下文，不在小窗里再显示一遍
      if (env.state.turns[i].hidden !== true) visible.push(env.state.turns[i])
    }
    if (env.chatLog.children.length !== visible.length) {
      env.clearWaiting(env.chatLog)
      env.chatLog.textContent = ''
      for (var j = 0; j < visible.length; j++) {
        var bubble = bubbleFor(visible[j])
        // 气泡记下自己属于哪一轮：引用时要据此取"这一轮 ± 一轮"的上下文
        bubble.__turn = visible[j]
        env.chatLog.appendChild(bubble)
      }
      // 刚入列的"待答"气泡：此时才挂进 DOM，可以画等待特效了
      var fresh = visible[visible.length - 1]
      if (fresh && fresh.role === 'assistant' && fresh.asking === true && !fresh.text) {
        env.showWaiting(env.chatLog.children[visible.length - 1], '正在回答…', {
          startedAt: fresh.startedAt,
          effort: fresh.effort,
          effortOf: function () { return fresh.effort || 'high' },
          thoughtOf: function () { return fresh.thought },
        })
      }
    } else if (visible.length > 0) {
      var node = env.chatLog.children[visible.length - 1]
      var turn = visible[visible.length - 1]
      var painted = false
      node.className = 'dsh-sel-bubble ' + (turn.role === 'user' ? 'dsh-sel-bubble-user' : 'dsh-sel-bubble-bot') + (turn.error ? ' dsh-sel-bubble-err' : '')
      if (turn.role === 'user') {
        // 用户气泡可能带引用块：签名包含引用，别每次重绘都白重建一遍
        var usig =
          (turn.text || '') +
          '|' +
          (turn.quotes || []).map(function (item) { return item.text }).join('\u0000') +
          '|' +
          (turn.attachments || []).map(function (item) { return (item.kind || '') + ':' + String((item.ref && item.ref.attachmentId) || '') }).join(',')
        if (node.__sig !== usig) {
          node.__sig = usig
          fillUserBubble(node, turn)
        }
      } else if (turn.error) {
        node.textContent = turn.text
      } else if (turn.asking === true && !turn.text) {
        // 追问等待期：和首轮同一套等待特效（呼吸点 + 实时秒数 + 💭 思考尾巴）
        env.showWaiting(node, '正在回答…', {
          startedAt: turn.startedAt,
          effort: turn.effort,
          effortOf: function () { return turn.effort || 'high' },
          thoughtOf: function () { return turn.thought },
        })
      } else {
        env.clearWaiting(node)
        // 追问还在流式时先给源码；这一轮真的写完（streaming=false）再渲染成网页
        var sig = (turn.text || '') + '|' + (turn.streaming === true ? '1' : '0') + '|' + (turn.error ? '1' : '0')
        if (node.__sig !== sig) {
          // 内容没变就别重建：重建会把预览 iframe 一起换掉（多建一次 = 白闪一次）
          node.__sig = sig
          renderRich(node, turn.text || '…', { settled: turn.streaming !== true })
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
    env.chatLog.style.display = visible.length > 0 ? 'flex' : 'none'
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
    // 附件排在引用**后面**（引用是"从正文里挑的材料"，附件是"从外面带进来的"），
    // 两者都在正文之前 —— 和发给模型的那份顺序一致。
    var attachments = turn.attachments || []
    if (attachments.length > 0) {
      node.appendChild(attachmentStrip(attachments))
    }
    if (quotes.length > 0) {
      var box = el('div', 'dsh-sel-bq')
      for (var i = 0; i < quotes.length; i += 1) {
        var item = el('div', 'dsh-sel-bqitem')
        item.appendChild(el('b', null, '❝ ' + env.quoteLabelOf(quotes[i])))
        item.appendChild(document.createTextNode(env.quoteBrief(quotes[i].text, 60)))
        item.title = quotes[i].text
        box.appendChild(item)
      }
      node.appendChild(box)
    }
    var display = displayTextOf(turn)
    if (display) node.appendChild(el('div', null, display))
  }

  /**
   * 附件条：图片是缩略图（点开看原图），文件是一张卡（点一下下载）。
   *
   * 图片用 `<img src=回放路由>`：发出去的消息里只留了引用，本地 object URL 在发送时就释放了，
   * 历史回放时更是连 File 都没有 —— 只能回宿主取一次。加载失败（引用失效/被清理）
   * 就地换成一行说明，不留一个破图。
   */
  function attachmentStrip(attachments) {
    var strip = el('div', 'dsh-sel-bqattach')
    for (var i = 0; i < attachments.length; i += 1) {
      var item = attachments[i] || {}
      var ref = item.ref || {}
      if (item.kind === 'image') {
        strip.appendChild(attachmentImage(ref))
      } else {
        strip.appendChild(attachmentFile(ref))
      }
    }
    return strip
  }

  function attachmentImage(ref) {
    var link = document.createElement('a')
    link.className = 'dsh-sel-bqimgwrap'
    link.href = attachmentUrl('image', ref)
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    link.title = '点击查看原图' + (ref.name ? '：' + ref.name : '')
    var img = document.createElement('img')
    img.className = 'dsh-sel-bqimg'
    img.src = link.href
    img.alt = ref.name || '图片'
    img.loading = 'lazy'
    img.addEventListener('error', function () {
      // 引用失效（对象仓被清理）时不留破图
      var box = el('span', 'dsh-sel-bqimgfail', '图片已不在附件仓里')
      if (link.parentNode) link.parentNode.replaceChild(box, link)
    })
    link.appendChild(img)
    return link
  }

  function attachmentFile(ref) {
    var link = document.createElement('a')
    link.className = 'dsh-sel-bqfile'
    link.href = attachmentUrl('file', ref, true)
    link.rel = 'noreferrer noopener'
    link.title = '下载：' + (ref.name || '文件')
    link.appendChild(el('span', 'dsh-sel-bqfileext', ref.name ? extensionOf(ref.name) : 'FILE'))
    link.appendChild(el('span', 'dsh-sel-bqfilename', ref.name || '文件'))
    if (typeof ref.bytes === 'number') link.appendChild(el('span', 'dsh-sel-bqfilemeta', formatBytes(ref.bytes)))
    return link
  }

  /**
   * 气泡里显示的正文。
   *
   * 回放出来的轮次，`text` 是**发出去的那份**（含 `【本条消息带了附件】…` 一行）——
   * 那一行是给模型看的历史锚点，界面上已经有缩略图了，再显示一遍就是重复。
   * 所以有附件时把这一行去掉（只去开头那一行，正文别的一字不动）。
   */
  function displayTextOf(turn) {
    var text = turn.text || ''
    if (!text) return ''
    if (!turn.attachments || turn.attachments.length === 0) return text
    return text.replace(/^【本条消息带了附件】[^\n]*\n?/, '')
  }

  function bubbleFor(turn) {
    var bubble = el('div', 'dsh-sel-bubble ' + (turn.role === 'user' ? 'dsh-sel-bubble-user' : 'dsh-sel-bubble-bot'))
    if (turn.role === 'user') {
      fillUserBubble(bubble, turn)
    } else if (turn.error) {
      bubble.className += ' dsh-sel-bubble-err'
      bubble.textContent = turn.text
    } else {
      renderRich(bubble, turn.text || '…', { settled: turn.streaming !== true })
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
        var body = foldForHistory(source.text)
        // 整条引用同样不带上下文：出处写进标签（「小窗第 N 轮回答」），对话本身在历史里
        env.addQuote(body, env.turnLabelOf(source), { context: '', session: false })
      })
    }
  }

  /** 把首轮解读结果作为追问的第一条助手上下文（截断，避免过长）。 */
  function seedHistoryFromExplanation() {
    var fallback = splitSections(env.state.raw)
    var translation = (env.state.parts.translation || fallback.translation || '').trim()
    var detail = (env.state.parts.detail || fallback.detail || '').trim()
    // 写成"前情提要"而不是"我上一轮的回答"：否则模型会顺着把两节内容再复述一遍
    var seed =
      '（前情：已就这段选中文字给出解读——' +
      (env.state.sectionTitle || '翻译') +
      '：' +
      translation +
      (detail ? '；详解：' + detail : '') +
      '）'
    return seed.length > 1500 ? seed.slice(0, 1500) + '…' : seed
  }
  return {
    hideHistoryList,
    placeHistoryList,
    toggleHistoryList,
    noteUserScroll,
    noteBodyScroll,
    ensurePanelInsideViewport,
    get foldCount() { return foldCount },
    set foldCount(value) { foldCount = value },
    foldForHistory,
    renderTurns,
    get chatGrowWatch() { return chatGrowWatch },
    set chatGrowWatch(value) { chatGrowWatch = value },
    get panelGrowWatch() { return panelGrowWatch },
    set panelGrowWatch(value) { panelGrowWatch = value },
    currentSurfaceTheme,
    restoreFromHistory,
    visibleRaw,
    loadHistoryEntry,
    seedHistoryFromExplanation,
    ensureChatFollow,
    get FOLD_HISTORY_KEEP_LATEST() { return FOLD_HISTORY_KEEP_LATEST },
    set FOLD_HISTORY_KEEP_LATEST(value) { FOLD_HISTORY_KEEP_LATEST = value },
    historyTextOf,
    clearTransientNotice,
    saveHistory,
    applyToolEvent,
    ensurePanelInsideViewportNow,
  }
}
