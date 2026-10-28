import { releasePreviewFrames, renderRich } from './render.js'
import { el, listen } from './dom.js'

/** Windowed transcript reconciliation preserves mounted previews and scroll position. */
export function createHistoryTranscriptController(env, bubbles, scroll) {
  var { bubbleFor, fillUserBubble, paintNotice, paintQuoteAll } = bubbles
  var { nearBottom, stickToBottom } = scroll
  var turnWindowSize = 40
  var turnWindowKey = null
  var renderedTurns = []

  function clearRenderedTurns() {
    env.clearWaiting(env.chatLog)
    releasePreviewFrames(env.chatLog)
    env.chatLog.textContent = ''
    renderedTurns = []
    turnWindowSize = 40
    turnWindowKey = null
  }

  /** 渲染追问气泡（用户右侧、助手左侧）。
   *  只更新最后一条气泡：全量重建会让滚动容器先塌再长，滚动位置被夹回顶部。 */
  function renderTurns(options) {
    if (!env.panelOpen) { clearRenderedTurns(); return }
    var force = !!(options && options.stick === true)
    // 注意：这里仍用 nearBottom()（不管用户是滚轮还是别的途径离开底部都成立）；
    // state.follow 只服务于下面的 ResizeObserver —— 内容"长高"之后再量 nearBottom 必然是 false，
    // 所以必须有一个"长高之前是否贴底"的记忆。
    var stick = !(options && options.preservePosition) && (force || nearBottom())
    var visible = []
    for (var i = 0; i < env.state.turns.length; i++) {
      // 种子轮（前情提要）只发给模型当上下文，不在小窗里再显示一遍
      if (env.state.turns[i].hidden !== true) visible.push(env.state.turns[i])
    }
    if (turnWindowKey !== env.state.cacheKey) {
      turnWindowKey = env.state.cacheKey
      turnWindowSize = 40
    }
    var earlier = Math.max(0, visible.length - turnWindowSize)
    visible = visible.slice(earlier)
    var sameWindow = renderedTurns.length === visible.length && visible.every(function (turn, index) {
      return renderedTurns[index] === turn
    })
    var prependCount = visible.length - renderedTurns.length
    var canPrepend = options && options.prepend && renderedTurns.length > 0 && prependCount > 0 && renderedTurns.every(function (turn, index) {
      return visible[prependCount + index] === turn
    })
    if (canPrepend) {
      // Keep existing bubbles mounted: rebuilding would reload their iframes and reset
      // measured preview heights, moving the reader even when scrollTop is adjusted.
      var moreButton = env.chatLog.children[0]
      var firstBubble = env.chatLog.children[1]
      if (earlier > 0) moreButton.textContent = '显示更早的消息（还有 ' + earlier + ' 条）'
      else env.chatLog.removeChild(moreButton)
      for (var p = 0; p < prependCount; p++) {
        var prepended = bubbleFor(visible[p])
        prepended.__turn = visible[p]
        env.chatLog.insertBefore(prepended, firstBubble)
      }
      renderedTurns = visible.slice()
    } else if (!sameWindow || env.chatLog.children.length !== visible.length + (earlier > 0 ? 1 : 0)) {
      env.clearWaiting(env.chatLog)
      releasePreviewFrames(env.chatLog)
      env.chatLog.textContent = ''
      if (earlier > 0) {
        var more = el('button', 'dsh-sel-expand', '显示更早的消息（还有 ' + earlier + ' 条）')
        more.type = 'button'
        more.setAttribute('data-history-more', '1')
        listen(more, 'click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          var top = env.body.scrollTop
          var height = env.body.scrollHeight
          turnWindowSize += 40
          renderTurns({ preservePosition: true, prepend: true })
          env.body.scrollTop = top + Math.max(0, env.body.scrollHeight - height)
          env.state.follow = false
        })
        env.chatLog.appendChild(more)
      }
      for (var j = 0; j < visible.length; j++) {
        var bubble = bubbleFor(visible[j])
        // 气泡记下自己属于哪一轮：引用时要据此取"这一轮 ± 一轮"的上下文
        bubble.__turn = visible[j]
        env.chatLog.appendChild(bubble)
      }
      renderedTurns = visible.slice()
      // 刚入列的"待答"气泡：此时才挂进 DOM，可以画等待特效了
      var fresh = visible[visible.length - 1]
      if (fresh && fresh.role === 'assistant' && fresh.asking === true && !fresh.text) {
        env.showWaiting(env.chatLog.children[env.chatLog.children.length - 1], '正在回答…', {
          startedAt: fresh.startedAt,
          effort: fresh.effort,
          effortOf: function () { return fresh.effort || 'high' },
          thoughtOf: function () { return fresh.thought },
        })
      }
    } else if (visible.length > 0) {
      var node = env.chatLog.children[env.chatLog.children.length - 1]
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

  return { clearRenderedTurns, renderTurns }
}
