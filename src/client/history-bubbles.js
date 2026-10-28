import { renderRich } from './render.js'
import { el, listen } from './dom.js'
import { attachmentUrl, formatBytes, extensionOf } from './attach.js'
import { displayTextOf } from './history-text.js'

/** Bubble, attachment and quote controls retain the current transcript DOM. */
export function createHistoryBubbleController(env, foldForHistory) {
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

  /**
   * 当前消息区里的图片组（按 DOM 顺序 = 从上到下的阅读顺序）。
   *
   * 预览时左右翻的就是这一组：用户看到的是"会话里有这些图"，不是"这条消息里有这些图"。
   * 只算真正渲染出来的缩略图 —— 引用失效被换成说明文字的那些已经不在列表里了。
   * 返回 { images, index }；index 是点击的这一张在该组里的位置。
   */
  function bubbleGallery(anchor) {
    var log = env.chatLog
    var links = log && typeof log.querySelectorAll === 'function' ? log.querySelectorAll('.dsh-sel-bqimgwrap') : []
    var images = []
    var index = 0
    for (var i = 0; i < links.length; i += 1) {
      var wrap = links[i]
      var thumb = wrap.querySelector ? wrap.querySelector('img') : null
      var src = String(wrap.getAttribute('href') || (thumb && thumb.getAttribute('src')) || '')
      if (!src) continue
      if (wrap === anchor) index = images.length
      images.push({ src: src, name: (thumb && thumb.alt) || '图片' })
    }
    if (images.length === 0 && anchor) images.push({ src: anchor.href, name: '图片' })
    return { images: images, index: index }
  }

  function attachmentImage(ref) {
    var link = document.createElement('a')
    link.className = 'dsh-sel-bqimgwrap'
    link.href = attachmentUrl('image', ref)
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    link.title = '点击预览' + (ref.name ? '：' + ref.name : '')
    // 普通左键 → 在当前窗口里开灯箱；⌘/Ctrl/Shift/中键仍按链接语义走（新标签）。
    // 桌面壳里 target=_blank 常常打不开新标签（或把用户带离这轮对话），
    // 所以"看清楚这张图"这条主动作不能依赖它。
    // 同一次预览带上**当前消息区里所有图片**，← / → 就能接着翻。
    listen(link, 'click', function (event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (typeof env.previewImage !== 'function') return
      event.preventDefault()
      env.previewImage(bubbleGallery(link))
    })
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

  return { bubbleFor, fillUserBubble, paintNotice, paintQuoteAll }
}
