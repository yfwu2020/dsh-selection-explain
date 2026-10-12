import { el, listen } from './dom.js'
import { normalizeSpace } from './context.js'

// ────────────────────── Markdown 轻渲染（全 DOM，无 innerHTML） ──────────────────────

/** 行内解析：**加粗** 与 `代码`。 */
export function appendInline(parent, text) {
  // 加粗 / 行内代码 / markdown 链接 / 裸链接
  var re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>"'）】]+)/g
  var last = 0
  var match
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)))
    var token = match[0]
    if (token.indexOf('**') === 0) {
      parent.appendChild(el('strong', 'dsh-sel-strong', token.slice(2, -2)))
    } else if (token.charAt(0) === '`') {
      parent.appendChild(el('code', 'dsh-sel-code', token.slice(1, -1)))
    } else if (token.charAt(0) === '[') {
      var split = token.lastIndexOf('](')
      var label = token.slice(1, split)
      var href = token.slice(split + 2, -1)
      var link = el('a', 'dsh-sel-link', label)
      link.setAttribute('href', href)
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
      parent.appendChild(link)
    } else {
      var bare = el('a', 'dsh-sel-link', token.replace(/[.,;]+$/, ''))
      bare.setAttribute('href', token.replace(/[.,;]+$/, ''))
      bare.setAttribute('target', '_blank')
      bare.setAttribute('rel', 'noopener noreferrer')
      parent.appendChild(bare)
    }
    last = match.index + token.length
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)))
}

/**
 * 块级渲染：段落 / 多级无序与有序列表 / 小标题 / 引用 / 分隔线。
 * 列表按缩进分级（每 2 空格一级，最多 2 级），有序项保留原编号并右对齐，
 * 让小标题、要点、正文之间的层次在面板里一眼可辨。
 */
/**
 * 剥掉「- **<选中文字>**：内容」这种回声前缀。
 * 翻译节里模型常把选中文字本身当成词条再译一遍；当加粗前缀与选中文字一致时，
 * 直接把它去掉、只留内容（避免「选中文字 → 选中文字」的重复）。
 */
export function stripEchoPrefix(text, selected) {
  var target = normalizeSpace(selected || '')
  if (!target) return text
  return String(text || '')
    .split('\n')
    .map(function (line) {
      var match = /^\s*-\s*\*\*(.+?)\*\*\s*[:：]\s*(.*)$/.exec(line)
      if (!match) return line
      var head = normalizeSpace(match[1])
      if (head !== target && head.indexOf(target) !== 0 && target.indexOf(head) !== 0) return line
      if (head.length < 2 || Math.abs(head.length - target.length) > Math.max(4, target.length * 0.4)) return line
      return match[2]
    })
    .join('\n')
}

/** 「在本句中：xxx」这类结论行 → 高亮结论条（带标签胶囊）。 */
export var CALLOUT_RE = /^(?:\*\*)?\s*(在(?:本|此)句(?:中|里)?|在(?:本|此)段(?:中|里)?|在上文(?:中)?|小结|总结|结论)\s*[:：]\s*(?:\*\*)?\s*([\s\S]*)$/

export function calloutNode(label, body) {
  var box = el('div', 'dsh-sel-callout')
  box.appendChild(el('span', 'dsh-sel-callout-tag', label))
  var span = el('span')
  appendInline(span, body)
  box.appendChild(span)
  return box
}

/** 表格分隔行：|---|:---:|---| */
export function isTableSeparator(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line) && line.indexOf('-') >= 0
}

export function splitRow(line) {
  var body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return body.split('|').map(function (cell) {
    return cell.trim()
  })
}

/** 渲染 Markdown 表格；返回消费到的行号（不含）。 */
export function renderTable(parent, lines, start) {
  var head = splitRow(lines[start])
  var rows = []
  var i = start + 2
  while (i < lines.length && lines[i].trim().indexOf('|') >= 0) {
    rows.push(splitRow(lines[i]))
    i += 1
  }
  var wrap = el('div', 'dsh-sel-tablewrap')
  var table = el('table', 'dsh-sel-table')
  var thead = el('thead')
  var headRow = el('tr')
  for (var h = 0; h < head.length; h++) {
    var th = el('th')
    appendInline(th, head[h])
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)
  var tbody = el('tbody')
  for (var r = 0; r < rows.length; r++) {
    var tr = el('tr')
    for (var c = 0; c < head.length; c++) {
      var td = el('td')
      appendInline(td, rows[r][c] === undefined ? '' : rows[r][c])
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  wrap.appendChild(table)
  parent.appendChild(wrap)
  return i
}

// ────────────────────── 语法高亮（代码块专用，无第三方依赖） ──────────────────────

/** 围栏语言标记 → 家族。未知语言退回 auto（按内容猜）。 */
export var HL_FAMILY = {
  js: 'c', javascript: 'c', jsx: 'c', mjs: 'c', cjs: 'c', ts: 'c', typescript: 'c', tsx: 'c',
  java: 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c', c: 'c', cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c',
  cs: 'c', csharp: 'c', php: 'c', swift: 'c', kotlin: 'c', kt: 'c', scala: 'c', dart: 'c', groovy: 'c',
  py: 'py', python: 'py', rb: 'py', ruby: 'py',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellsession: 'sh', powershell: 'sh', ps1: 'sh',
  sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql', plsql: 'sql',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  json: 'json', jsonc: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml',
  md: 'plain', markdown: 'plain', text: 'plain', txt: 'plain', plain: 'plain', log: 'plain', diff: 'plain',
}

/** 各家族的关键字（只用于上色，不求完备）。 */
export var HL_WORDS = {
  c: 'const let var function return if else for while do switch case default break continue new delete typeof instanceof in of class extends super this try catch finally throw await async yield void export import from as static public private protected interface enum implements readonly namespace declare abstract type null undefined true false NaN Infinity get set',
  py: 'def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda yield global nonlocal pass break continue assert del async await match case self print len range',
  sh: 'if then else elif fi for while until do done case esac function return in export local readonly unset shift source alias echo cd exit set sudo npm pnpm yarn npx git docker kubectl curl wget cat grep awk sed head tail chmod mkdir rm cp mv touch find xargs export',
  sql: 'select from where group by having order limit offset insert into values update set delete create alter drop table index view join left right inner outer full on as and or not null is in like between distinct union all exists asc desc primary key foreign references default case when then end',
  json: 'true false null',
  yaml: 'true false null yes no on off',
  css: '',
  html: '',
  plain: '',
}

/** 没有语言标记时按内容猜一个家族。 */
export function guessFamily(code) {
  var t = String(code || '')
  if (/^\s*#!/.test(t)) return 'sh'
  if (/<(!doctype|html|div|span|p|a|br|img|script|style|template)\b/i.test(t)) return 'html'
  if (/^\s*[.#@]?[a-zA-Z-]+\s*\{[^}]*:[^}]*;?/m.test(t) && t.indexOf('{') >= 0 && t.indexOf(':') >= 0 && !/=>|function|const |let /.test(t)) return 'css'
  if (/\b(def |import |from |elif |self\b|print\()/.test(t) && /:\s*$/m.test(t)) return 'py'
  if (/\b(select|insert into|update|delete from|create table)\b/i.test(t)) return 'sql'
  if (/^\s*[{[][\s\S]*"[^"]+"\s*:/m.test(t) && !/function|=>|;/.test(t)) return 'json'
  // shell：有 fi/done/esac 收尾，或"命令 + 选项"的行
  if (/\b(fi|done|esac)\b/.test(t) && /^\s*(if|then|elif|else|for|while|do|case|until)\b/m.test(t)) return 'sh'
  if (/^\s*(?:[a-z]+\s+-{1,2}[A-Za-z]|if\s+\[|export\s+\w+=|echo\s)/m.test(t)) return 'sh'
  if (/\b(function|const|let|var|return|class|import|export|async|await)\b|=>/.test(t)) return 'c'
  if (/^-{3}\s*$/m.test(t) && /^\s*[\w-]+:\s/m.test(t)) return 'yaml'
  return 'c'
}

/** 行注释起始判断（按家族）。 */
export function commentStartAt(line, i, family) {
  var rest = line.slice(i)
  if (family === 'py' || family === 'sh' || family === 'yaml') return rest.charAt(0) === '#'
  if (family === 'sql') return rest.slice(0, 2) === '--'
  if (family === 'html') return rest.slice(0, 4) === '<!--'
  if (family === 'json') return rest.slice(0, 2) === '//'
  return rest.slice(0, 2) === '//' // c / css 默认
}

/**
 * 逐行扫描出 token：com / str / num / kw / fn / type / attr / var / op / plain。
 * 只求"一眼看得懂"，不追求编译器级正确。
 */
export function tokenizeCodeLine(line, family, words, state) {
  var tokens = []
  var i = 0
  function push(cls, text) {
    if (!text) return
    if (cls === 'plain') {
      var last = tokens[tokens.length - 1]
      if (last && last.cls === 'plain') {
        last.text += text
        return
      }
    }
    tokens.push({ cls: cls, text: text })
  }
  function nextChar(skipSpace) {
    var j = i
    if (skipSpace) while (j < line.length && line.charAt(j) === ' ') j += 1
    return line.charAt(j)
  }
  while (i < line.length) {
    if (state.block) {
      var close = line.indexOf('*/', i)
      if (close < 0) {
        push('com', line.slice(i))
        i = line.length
        break
      }
      push('com', line.slice(i, close + 2))
      i = close + 2
      state.block = false
      continue
    }
    var ch = line.charAt(i)
    var start = i
    if (commentStartAt(line, i, family)) {
      push('com', line.slice(i))
      i = line.length
      break
    }
    if ((family === 'c' || family === 'css' || family === 'json') && line.slice(i, i + 2) === '/*') {
      state.block = true
      i += 2
      push('com', '/*')
      continue
    }
    if (family === 'html' && ch === '<') {
      var gt = line.indexOf('>', i)
      if (gt < 0) {
        push('tag', line.slice(i))
        i = line.length
        break
      }
      push('tag', line.slice(i, gt + 1))
      i = gt + 1
      continue
    }
    if (ch === '"' || ch === "'" || (ch === '`' && family !== 'sql')) {
      i += 1
      while (i < line.length) {
        if (line.charAt(i) === '\\') {
          i += 2
          continue
        }
        if (line.charAt(i) === ch) {
          i += 1
          break
        }
        i += 1
      }
      var text2 = line.slice(start, i)
      // JSON 的键：紧跟冒号的字符串单独上色
      push(family === 'json' && line.slice(i).replace(/\s+/, '').charAt(0) === ':' ? 'attr' : 'str', text2)
      continue
    }
    if (ch >= '0' && ch <= '9' && !/[A-Za-z0-9_$]/.test(line.charAt(i - 1) || '')) {
      i += 1
      while (i < line.length && /[0-9a-fA-FxXoO._]/.test(line.charAt(i))) i += 1
      while (i < line.length && /[eE][+-]?[0-9]/.test(line.slice(i, i + 3)) ) i += 2
      push('num', line.slice(start, i))
      continue
    }
    if (ch === '$' && family === 'sh') {
      i += 1
      if (line.charAt(i) === '{') {
        var close2 = line.indexOf('}', i)
        i = close2 < 0 ? line.length : close2 + 1
      } else {
        while (i < line.length && /[A-Za-z0-9_?@*#!$]/.test(line.charAt(i))) i += 1
      }
      push('var', line.slice(start, i))
      continue
    }
    if (/[A-Za-z_$@#]/.test(ch)) {
      i += 1
      while (i < line.length && /[A-Za-z0-9_$-]/.test(line.charAt(i))) i += 1
      var word = line.slice(start, i)
      var bare = word.replace(/^[@#$]/, '')
      var after = nextChar(true)
      var cls = 'plain'
      if (bare && words[bare.toLowerCase()] === 1 && (family !== 'c' || /^[A-Za-z_$]/.test(ch))) cls = 'kw'
      else if (after === '(') cls = 'fn'
      else if (family === 'c' && /^[A-Z]/.test(word) && word.length > 1) cls = 'type'
      else if (family === 'css' && (line.charAt(start - 1) === '.' || line.charAt(start - 1) === '#')) cls = 'type'
      else if (family === 'css' && after === ':') cls = 'attr'
      else if (family === 'json' && line.charAt(i) === '"') cls = 'attr'
      push(cls, word)
      continue
    }
    if (/[{}()[\];,.:=+\-*/%<>!&|^~?]/.test(ch)) {
      i += 1
      push('op', line.slice(start, i))
      continue
    }
    i += 1
    push('plain', line.slice(start, i))
  }
  return tokens
}

/**
 * 把一段代码按行高亮成节点（每行一个数组，tokens 为 {cls,text}）。
 * 语言标记认不出来时按内容猜。
 */
export function highlightCode(code, lang) {
  var family = HL_FAMILY[String(lang || '').toLowerCase()] || guessFamily(code)
  var words = {}
  var list = (HL_WORDS[family] || '').split(' ')
  for (var w = 0; w < list.length; w += 1) if (list[w]) words[list[w]] = 1
  var lines = String(code).split('\n')
  var state = { block: false }
  var out = []
  for (var i = 0; i < lines.length; i += 1) out.push({ line: lines[i], tokens: tokenizeCodeLine(lines[i], family, words, state) })
  return { family: family, lines: out }
}

/** 解析 rgb()/rgba() → [r,g,b,a]；解析不了返回 null。 */
export function parseColor(value) {
  var m = /rgba?\(([^)]+)\)/.exec(String(value || ''))
  if (!m) return null
  var parts = m[1].split(',').map(function (piece) { return parseFloat(piece) })
  if (parts.length < 3) return null
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]
}

/**
 * 算出代码块**实际看到的底色**（逐层向上把半透明背景叠起来），再判深浅。
 * 这样主题怎么实现都不影响：只看最终颜色。
 */
export function isDarkSurface(node) {
  try {
    // 先收集祖先链上的背景层（元素 → 根），再**从最底层往上叠**（画家算法）——
    // 顺序反了的话，元素自己的半透明底色会先叠在"白"上，深色主题也会算成浅色
    var layers = []
    var current = node
    for (var depth = 0; current && depth < 12; depth += 1) {
      var background = parseColor(getComputedStyle(current).backgroundColor)
      if (background && background[3] > 0) layers.push(background)
      current = current.parentElement
    }
    var r = 255
    var g = 255
    var b = 255
    for (var i = layers.length - 1; i >= 0; i -= 1) {
      var a = layers[i][3]
      r = layers[i][0] * a + r * (1 - a)
      g = layers[i][1] * a + g * (1 - a)
      b = layers[i][2] * a + b * (1 - a)
    }
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140
  } catch (error) {
    return false
  }
}

/**
 * 高亮结果 → <pre> 内容（注释整体弱化，代码着色）。
 *
 * 每行单独成块：**注释行允许折行**（不横向溢出小窗），代码行保持 `pre` 不折
 * （长代码宁可横向滚动，也不要被折断成看不懂的形状）。
 */
export function paintHighlight(pre, code, lang) {
  pre.setAttribute('data-hl', isDarkSurface(pre) ? 'dark' : 'light')
  var hi = highlightCode(code, lang)
  for (var i = 0; i < hi.lines.length; i += 1) {
    var tokens = hi.lines[i].tokens
    // 整行是否只有注释（空白 + 注释）→ 整行可折行
    var commentOnly = tokens.length > 0
    for (var k = 0; k < tokens.length; k += 1) {
      if (tokens[k].cls !== 'com' && !(tokens[k].cls === 'plain' && !tokens[k].text.trim())) {
        commentOnly = false
        break
      }
    }
    if (commentOnly) {
      var first = 0
      for (var f = 0; f < tokens.length; f += 1) {
        if (tokens[f].cls === 'com') {
          first = f
          break
        }
      }
      pre.appendChild(codeLine(tokens, commentColumn(tokens, first), true))
      continue
    }
    // 代码 + 行尾注释：注释拆成独立的注释行（缩进 = 它在原行的起始列），
    // 这样折行后的续行一定与注释左对齐，而不会跑到代码左边去
    var cut = -1
    for (var c = 0; c < tokens.length; c += 1) {
      if (tokens[c].cls === 'com') {
        cut = c
        break
      }
    }
    if (cut < 0) {
      pre.appendChild(codeLine(tokens, -1, false))
      continue
    }
    pre.appendChild(codeLine(tokens.slice(0, cut), -1, false))
    pre.appendChild(codeLine(tokens.slice(cut), commentColumn(tokens, cut), true))
  }
}

/** 一行里第 index 个 token 之前累计的字符数（= 它的起始列，用于注释缩进）。 */
export function commentColumn(tokens, index) {
  var column = 0
  for (var i = 0; i < index && i < tokens.length; i += 1) column += tokens[i].text.length
  return column
}

/**
 * 造一个"行块"。
 *
 * indent > 0 表示这是注释行：`padding-left` 把整块右移 indent 个字符宽，
 * `text-indent` 负值再把**首行**拉回原处 —— 于是首行落在注释原本的列上，
 * 而**折行后的续行**从 padding 处开始，正好与注释左对齐（不会跑到注释左边）。
 * indent 上限 12ch：真实代码里注释缩进再深也不该把正文顶出小窗。
 */
export function codeLine(tokens, indent, wrap) {
  var line = el('div', 'dsh-sel-pre-line')
  var pad = indent > 0 ? Math.min(indent, 12) : 0
  // 注释行一律可折行（缩进为 0 的注释也要折），代码行不折
  if (wrap === true || pad > 0) line.setAttribute('data-wrap', '1')
  if (pad > 0) {
    line.style.paddingLeft = pad + 'ch'
    line.style.textIndent = '-' + pad + 'ch'
  }
  for (var t = 0; t < tokens.length; t += 1) {
    var token = tokens[t]
    if (token.cls === 'plain') line.appendChild(document.createTextNode(token.text))
    // 注释额外挂 .dsh-sel-pre-cmt：批注清单里注释整体再压一档
    else line.appendChild(el('span', token.cls === 'com' ? 'dsh-hl-com dsh-sel-pre-cmt' : 'dsh-hl-' + token.cls, token.text))
  }
  return line
}

/**
 * 这段围栏内容能不能直接当网页渲染：html/htm/xhtml/svg 标了语言就算；
 * 没标语言时，只有"看起来是一份完整文档"（doctype 或 <html> 且有 </html>）才当网页，
 * 免得把随手写的 `<div>` 片段也塞进 iframe。
 */
export function looksLikeWebPage(lang, code) {
  var l = String(lang || '').toLowerCase()
  if (l === 'html' || l === 'htm' || l === 'xhtml' || l === 'svg') return true
  var text = String(code || '')
  return (/<!doctype\s+html|<html[\s>]/i.test(text) && /<\/html>/i.test(text))
}

/**
 * 网页预览块：工具栏（预览 / 代码 / 放大）+ 沙箱 iframe + 源码。
 *
 * 安全：iframe 只给 `allow-scripts`，**刻意不给 `allow-same-origin`**——
 * 于是预览里的脚本跑在不透明源里：能算、能画、能发请求，但读不到本页的
 * DOM / Cookie / localStorage，也不能导航顶层窗口（沙箱不加 allow-top-navigation）。
 */
/**
 * D：给预览页注入"窄容器自适应"的几条基础规则。
 *
 * 模型给的页面常按 1000~1200px 排版，塞进 445px 只能左右拖——这几条让它自己回流：
 * 图片/表格不超宽、代码块内部滚动、body 不横向溢出。
 * **必须插在 doctype 之后**（插到前面会把文档推进怪异模式，页面会变形）。
 */
export function adaptPreviewHtml(code, previewId) {
  var reset =
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style data-dsh-preview-reset>' +
    'html,body{max-width:100%;overflow-x:hidden}' +
    'img,svg,video,canvas{max-width:100%;height:auto}' +
    'table{max-width:100%}' +
    'pre{max-width:100%;overflow-x:auto}' +
    // 内置滚动条很碍眼：高度会由页面自己上报（见下面的 hook），所以平时根本不需要它
    'html{scrollbar-width:none}' +
    '::-webkit-scrollbar{width:0;height:0}' +
    '</style>' +
    // 页面把自身高度报给父窗口 → iframe 直接长到内容那么高，框里就不会出现滚动条
    '<scr' + 'ipt data-dsh-preview-hook>' +
    '(function(){var id=' + JSON.stringify(previewId || '') + ';var last=-1;' +
    'function report(){var d=document.documentElement,b=document.body;' +
    'var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0,d?d.offsetHeight:0,b?b.offsetHeight:0);' +
    'if(!h||Math.abs(h-last)<4)return;last=h;' +
    'try{parent.postMessage({__dshPreview:true,id:id,h:h},"*")}catch(e){}}' +
    'report();document.addEventListener("DOMContentLoaded",report);window.addEventListener("load",report);' +
    'setTimeout(report,120);setTimeout(report,600);' +
    'try{new ResizeObserver(report).observe(document.documentElement)}catch(e){}' +
    'window.addEventListener("resize",report);})();' +
    '</scr' + 'ipt>'
  var text = String(code || '')
  var doctype = /^\s*<!doctype[^>]*>/i.exec(text)
  if (doctype) {
    var cut = doctype.index + doctype[0].length
    return text.slice(0, cut) + reset + text.slice(cut)
  }
  var html = /^\s*<html[^>]*>/i.exec(text)
  if (html) {
    var cut2 = html.index + html[0].length
    return text.slice(0, cut2) + reset + text.slice(cut2)
  }
  return reset + text
}

/** 预览帧登记表：id → { frame }，用于把"页面上报的高度"对回正确的 iframe。 */
export var previewSeq = 0

export var previewFrames = {}

export function registerPreviewFrame(frame) {
  previewSeq += 1
  var id = 'pv' + previewSeq
  previewFrames[id] = { frame: frame }
  // 每次重绘都会产生新帧，顺手把已经脱离文档的旧帧清掉，避免表无限长大
  for (var key in previewFrames) {
    if (!Object.prototype.hasOwnProperty.call(previewFrames, key)) continue
    var item = previewFrames[key]
    if (item.frame !== frame && item.frame.isConnected === false) delete previewFrames[key]
  }
  return id
}

/**
 * 按当前模式给 iframe 定高。
 *
 * - 全量（默认）：高度 = 页面上报的内容高度（内部不滚动，整页跟着消息区滚）；
 * - 还原：清掉 inline 高度，交给 CSS 的固定 320px（超出走内部滚动，滚动条已隐藏）。
 */
export function applyPreviewHeight(frame, wrap) {
  var full = !wrap || wrap.getAttribute('data-full') !== '0'
  var reported = Number(frame.getAttribute('data-preview-h')) || 0
  if (!full) {
    frame.style.height = ''
    return
  }
  if (reported > 0) {
    // 上限只是防病态页面（几万像素）把消息区撑爆
    frame.style.height = Math.min(reported, 6000) + 'px'
  }
}

export function webPreviewBlock(code) {
  var wrap = el('div', 'dsh-sel-preview')
  wrap.setAttribute('data-view', 'preview')
  // 默认全量展示整页；点「还原」切回固定高度（内部滚动）
  wrap.setAttribute('data-full', '1')

  var bar = el('div', 'dsh-sel-previewbar')
  var tabs = el('div', 'dsh-sel-previewtabs')
  var previewTab = el('button', 'dsh-sel-previewtab', '预览')
  var codeTab = el('button', 'dsh-sel-previewtab', '代码')
  previewTab.type = 'button'
  codeTab.type = 'button'
  tabs.appendChild(previewTab)
  tabs.appendChild(codeTab)
  var zoomBtn = el('button', 'dsh-sel-previewzoom', '⤡ 还原')
  zoomBtn.type = 'button'
  zoomBtn.title = '还原成固定高度（网页内部自己滚动）'
  bar.appendChild(tabs)
  bar.appendChild(zoomBtn)

  var frame = document.createElement('iframe')
  frame.className = 'dsh-sel-previewframe'
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.setAttribute('title', '网页预览')
  var previewId = registerPreviewFrame(frame)
  frame.setAttribute('data-preview-id', previewId)
  frame.setAttribute('srcdoc', adaptPreviewHtml(code, previewId))

  var pre = el('pre', 'dsh-sel-pre')
  var view = el('div', 'dsh-sel-previewbody')
  view.appendChild(frame)
  view.appendChild(pre)
  wrap.appendChild(bar)
  wrap.appendChild(view)

  function syncTabs() {
    var on = wrap.getAttribute('data-view')
    previewTab.setAttribute('data-on', on === 'preview' ? '1' : '0')
    codeTab.setAttribute('data-on', on === 'code' ? '1' : '0')
  }
  function switchTo(next) {
    wrap.setAttribute('data-view', next)
    syncTabs()
  }
  listen(previewTab, 'click', function (event) {
    event.stopPropagation()
    switchTo('preview')
  })
  listen(codeTab, 'click', function (event) {
    event.stopPropagation()
    switchTo('code')
  })
  listen(zoomBtn, 'click', function (event) {
    event.stopPropagation()
    var full = wrap.getAttribute('data-full') !== '0'
    var next = full ? '0' : '1'
    wrap.setAttribute('data-full', next)
    zoomBtn.textContent = next === '1' ? '⤡ 还原' : '⤢ 全量'
    zoomBtn.title =
      next === '1' ? '还原成固定高度（网页内部自己滚动）' : '全量展示整页（跟着消息区一起滚）'
    applyPreviewHeight(frame, wrap)
  })
  syncTabs()
  return { root: wrap, pre: pre, frame: frame }
}

export function renderRich(parent, text, options) {
  parent.textContent = ''
  var lines = String(text || '').replace(/\r/g, '').split('\n')
  var current = null // { level, node }
  var ordered = false
  var wantCallout = !!(options && options.callout)

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i]
    var trimmed = raw.trim()
    if (!trimmed) {
      current = null
      continue
    }
    // 围栏代码块：``` 到收尾 ```（格式自由后模型可能给出代码/命令片段）
    if (/^```/.test(trimmed)) {
      current = null
      var fenceLang = trimmed.replace(/^```+/, '').trim().split(/[\s:,]/)[0]
      var codeLines = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i])
        i += 1
      }
      var codeText = codeLines.join('\n')
      // 长代码块在流式期间先给纯文本：语法高亮会为每一行造一堆 span（6KB 页面 ≈ 2000+ 个），
      // 每帧重做一遍是卡顿的第二个来源；收尾（settled）那一次再上色。
      var plainWhileStreaming = codeText.length > 1200 && !(options && options.settled === true)
      // 只有"这一轮已经定稿"才渲染预览：流式期间每次重绘都换一份 iframe 会不停重载、闪白，
      // 所以边生成边看源码，回复一结束（settled）立刻变成可交互网页。
      if (options && options.settled === true && looksLikeWebPage(fenceLang, codeText)) {
        var block = webPreviewBlock(codeText)
        parent.appendChild(block.root)
        // 先入 DOM 再上色：主题判定要读祖先链的**实际**底色，游离节点读不到
        paintHighlight(block.pre, codeText, fenceLang)
      } else {
        var pre = el('pre', 'dsh-sel-pre')
        parent.appendChild(pre)
        if (plainWhileStreaming) pre.textContent = codeText
        else paintHighlight(pre, codeText, fenceLang)
      }
      continue
    }
    // 表格：当前行以 | 开头且下一行是分隔行
    if (trimmed.charAt(0) === '|' && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      current = null
      i = renderTable(parent, lines, i) - 1
      continue
    }
    // 结论条（翻译节的固定结尾；引用行与普通行都识别）
    if (wantCallout) {
      var calloutSource = trimmed.charAt(0) === '>' ? trimmed.replace(/^>\s?/, '') : trimmed
      var callout = CALLOUT_RE.exec(calloutSource)
      if (callout) {
        current = null
        parent.appendChild(calloutNode(callout[1], callout[2]))
        continue
      }
    }
    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      current = null
      parent.appendChild(el('hr', 'dsh-sel-hr'))
      continue
    }
    // 引用
    var quote = /^>\s?(.*)$/.exec(trimmed)
    if (quote) {
      current = null
      var quoteLine = el('div', 'dsh-sel-quote-line')
      appendInline(quoteLine, quote[1])
      parent.appendChild(quoteLine)
      continue
    }
    // 列表（含缩进分级、有序编号）
    var bullet = /^(\s*)([-*•+]|\d+[.)])\s+(.*)$/.exec(raw)
    if (bullet) {
      var level = Math.min(2, Math.floor(bullet[1].replace(/\t/g, '  ').length / 2))
      var isNumbered = /^\d/.test(bullet[2])
      if (!current || current.level !== level || ordered !== isNumbered) {
        var listNode = el('div', 'dsh-sel-list')
        listNode.setAttribute('data-level', String(level))
        parent.appendChild(listNode)
        current = { level: level, node: listNode }
        ordered = isNumbered
      }
      var item = el('div', 'dsh-sel-item')
      if (isNumbered) item.setAttribute('data-num', '1')
      item.appendChild(el('span', 'dsh-sel-bullet', isNumbered ? bullet[2] : '•'))
      var body = el('span')
      appendInline(body, bullet[3])
      item.appendChild(body)
      current.node.appendChild(item)
      continue
    }
    current = null
    // 小标题
    var heading = /^#{1,6}\s*(.*)$/.exec(trimmed)
    if (heading) {
      var sub = el('div', 'dsh-sel-sub')
      appendInline(sub, heading[1])
      parent.appendChild(sub)
      continue
    }
    // 段落
    var paragraph = el('p')
    appendInline(paragraph, trimmed)
    parent.appendChild(paragraph)
  }
}

/** 按「## 翻译 / ## 详解」把流式文本切两节（容错多种写法，含旧的「语境含义」）。 */
export function splitSections(raw) {
  var result = { translation: '', detail: '', other: '' }
  var re = /^[ \t>]*#{1,6}[ \t]*\**\s*(翻译|译文|translation|解读|注释|代码|详解|语境含义|语境|含义|解释|meaning|detail)\**\s*[:：]?[ \t]*$/gim
  var marks = []
  var match
  while ((match = re.exec(raw)) !== null) {
    marks.push({ start: match.index, end: re.lastIndex, name: sectionName(match[1]) })
  }
  if (marks.length === 0) {
    result.other = raw
    return result
  }
  result.other = raw.slice(0, marks[0].start)
  for (var i = 0; i < marks.length; i++) {
    var stop = i + 1 < marks.length ? marks[i + 1].start : raw.length
    var chunk = raw.slice(marks[i].end, stop)
    result[marks[i].name] += chunk
  }
  return result
}

export function sectionName(label) {
  var key = label.toLowerCase()
  if (key.indexOf('翻译') >= 0 || key.indexOf('译文') >= 0 || key.indexOf('translat') >= 0) return 'translation'
  if (key.indexOf('解读') >= 0) return 'translation' // 纯中文时首轮标题就是「解读」
  if (key.indexOf('注释') >= 0 || key.indexOf('代码') >= 0) return 'translation' // 代码段首轮标题是「注释」
  if (
    key.indexOf('详解') >= 0 ||
    key.indexOf('语境') >= 0 ||
    key.indexOf('含义') >= 0 ||
    key.indexOf('解释') >= 0 ||
    key.indexOf('meaning') >= 0 ||
    key.indexOf('detail') >= 0
  ) {
    return 'detail'
  }
  return 'other'
}