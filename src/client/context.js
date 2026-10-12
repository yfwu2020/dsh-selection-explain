import { clamp } from './dom.js'
import { CONTEXT_WINDOW, KEY_CONTEXT_CHARS } from './constants.js'

// ────────────────────── 上下文采集 ──────────────────────

/** 选区所在的语义容器（消息气泡 / 段落 / 代码块…）。 */
export function pickContainer(element) {
  var node = element
  while (node && node !== document.body) {
    var length = (node.innerText || '').length
    if (length >= 120) return node
    node = node.parentElement
  }
  return element || document.body
}

/** 容器的人类可读标签。 */
export function describeContainer(element) {
  if (!element || !element.closest) return '页面内容'
  try {
    if (element.closest('pre') || element.closest('code')) return '代码块'
    if (element.closest('table')) return '表格'
    var message = element.closest('[data-message-role],[data-role],[data-testid*="message"],article')
    if (message) {
      var role = message.getAttribute('data-message-role') || message.getAttribute('data-role') || ''
      if (role === 'user') return '对话消息（用户）'
      if (role === 'assistant') return '对话消息（助手）'
      return '对话消息'
    }
  } catch (error) {
    /* closest 在某些孤立节点上会抛错，忽略 */
  }
  return '页面内容'
}

/**
 * 采集上下文：容器文本中选区前后各 CONTEXT_WINDOW 字符的窗口，
 * 并用【】标出选中部分（前后文对齐，便于模型判断指代）。
 */
export function collectContext(selection) {
  var fallback = { context: '', label: '页面内容' }
  var range
  try {
    range = selection.getRangeAt(0)
  } catch (error) {
    return fallback
  }
  var startElement = range.startContainer
  startElement = startElement && startElement.nodeType === 1 ? startElement : startElement && startElement.parentElement
  var container = pickContainer(startElement)
  if (!container) return fallback
  var label = describeContainer(container)

  var rawFull = ''
  var offset = 0
  try {
    var fullRange = document.createRange()
    fullRange.selectNodeContents(container)
    rawFull = fullRange.toString()
    var prefix = document.createRange()
    prefix.selectNodeContents(container)
    prefix.setEnd(range.startContainer, range.startOffset)
    offset = prefix.toString().length
  } catch (error) {
    return { context: '', label: label }
  }
  if (!rawFull) return { context: '', label: label }

  var selected = selection.toString()
  var start = clamp(offset - CONTEXT_WINDOW, 0, Math.max(0, rawFull.length - 1))
  var end = clamp(offset + selected.length + CONTEXT_WINDOW, 0, rawFull.length)
  var window = rawFull.slice(start, end)
  var relative = offset - start
  var marked = window
  var probe = window.slice(relative, relative + selected.length)
  if (normalizeSpace(probe) !== normalizeSpace(selected)) {
    var found = rawFull.indexOf(selected)
    if (found >= 0) {
      var s2 = clamp(found - CONTEXT_WINDOW, 0, Math.max(0, rawFull.length - 1))
      var e2 = clamp(found + selected.length + CONTEXT_WINDOW, 0, rawFull.length)
      var w2 = rawFull.slice(s2, e2)
      var r2 = found - s2
      marked = w2.slice(0, r2) + '【' + w2.slice(r2, r2 + selected.length) + '】' + w2.slice(r2 + selected.length)
    } else {
      marked = selected + '\n---\n' + window
    }
  } else {
    marked = window.slice(0, relative) + '【' + probe + '】' + window.slice(relative + selected.length)
  }
  var context = marked.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  // key 用的上下文：**只取选中文字之前**的一小段。
  // 取前后整段的话，主会话只要在后面追加新消息，同一个词的 key 就变了 ——
  // 结果就是"同一个词找不着上次的小窗，又生成一个"（实测复现过）。
  var keyContext = rawFull
    .slice(Math.max(0, offset - KEY_CONTEXT_CHARS), offset)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { context: context, label: label, keyContext: keyContext }
}

export function normalizeSpace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}