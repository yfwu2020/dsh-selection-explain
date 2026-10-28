/** Pure history text transformations; never mutate stored turn text. */
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
export function foldHtmlToMarkdown(html) {
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

/** 从 SSE 文本里拼出全部正文。 */
export function readSseText(raw) {
  var out = []
  var lines = String(raw || '').split('\n')
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i].trim()
    if (line.indexOf('data:') !== 0) continue
    var chunk = line.slice(5).trim()
    if (!chunk || chunk === '[DONE]') continue
    try {
      var obj = JSON.parse(chunk)
      // ⚠️ 只取正文事件：`thought` 是模型的推理流（会混进"让我看看…"这类话），
      // 拿它当标题就是一整段解释（实测踩到：标题变成了 60 字的说明）。
      if (obj.type === 'thought') continue
      if (typeof obj.delta === 'string') out.push(obj.delta)
      else if (obj.type === 'delta' && typeof obj.text === 'string') out.push(obj.text)
    } catch (error) {
      /* 跳过非 JSON 行 */
    }
  }
  return out.join('')
}

/** 标题清洗：去引号/标点/前缀，压平空白，最长 24 字。 */
export function cleanShotTitle(raw) {
  var title = String(raw || '').trim()
  title = title.replace(/^标题[:：]\s*/, '')
  title = title.replace(/^["'「『【]+|["'」』】]+$/g, '')
  title = title.replace(/[。！？.!?,，、:：;；…]+$/g, '')
  title = title.replace(/\s+/g, ' ').trim()
  if (!title) return ''
  // 不在数据层截断（放不下由界面用省略号处理）；这里只防一个离谱超长的回答
  return title.length > 24 ? title.slice(0, 24) : title
}

/**
 * 气泡里显示的正文。
 *
 * 回放出来的轮次，`text` 是**发出去的那份**（含 `【本条消息带了附件】…` 一行）——
 * 那一行是给模型看的历史锚点，界面上已经有缩略图了，再显示一遍就是重复。
 * 所以有附件时把这一行去掉（只去开头那一行，正文别的一字不动）。
 */
export function displayTextOf(turn) {
  var text = turn.text || ''
  if (!text) return ''
  if (!turn.attachments || turn.attachments.length === 0) return text
  return text.replace(/^【本条消息带了附件】[^\n]*\n?/, '')
}

/** Keep the observable fold counter scoped to one history controller. */
export function createHistoryTextController() {
  var foldCount = 0
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

  return {
    foldForHistory,
    get foldCount() { return foldCount },
    set foldCount(value) { foldCount = value },
  }
}
