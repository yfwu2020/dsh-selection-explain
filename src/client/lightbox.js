/**
 * 小窗图片预览（灯箱）：点缩略图 → 在当前窗口里把图放到最大，多张图可左右切换。
 *
 * 为什么不在新标签里打开原图：DSH 桌面是一扇固定窗口，`<a target="_blank">` 在壳里
 * 要么被拦、要么把用户丢进浏览器 —— 回来时小窗、滚动位置和这轮对话都已经不是刚才那份了。
 * 用户要的是"点一下看清楚这张图"，不是离开对话。所以预览就在同一扇窗里：
 * 盖一层暗色背景，图按 contain 放到最大；一组图里用 ← / → 或两侧按钮翻，
 * Esc / 点空白 / 点 ✕ 关闭。
 *
 * 谁在调：输入框上方的待发送缩略图（attach.js）和已发出气泡里的图片（history.js）——
 * 同一件东西的两个阶段（发送前 / 发送后），共用这一个入口，两边的体感才一致。
 * 两边都在**点开的那一刻**把同组图一起传进来：输入框上方是整条附件条，
 * 会话里是当前消息区里的全部图片（按从上到下的阅读顺序）。
 *
 * 这一层挂在 **layer 上（不是面板里）**：面板最宽只有 540px，把一张截图塞进去预览，
 * 尺寸还不如直接在气泡里看；灯箱要的是整个窗口的空间。层级高于面板与语音卡，
 * 打开期间点不到下面的东西 —— 和"模态"的直觉一致。
 */
import { el, listen } from './dom.js'
import { closeIcon } from './icons.js'

var SVG_NS = 'http://www.w3.org/2000/svg'

export function createLightboxController(env) {
  var root = null
  var stage = null
  var img = null
  var nameEl = null
  var failEl = null
  var closeBtn = null
  var prevBtn = null
  var nextBtn = null
  var countEl = null
  var hintEl = null
  var built = false
  var open = false
  /** 当前这组图：[{ src, name }]，顺序 = 调用方给的阅读顺序。 */
  var gallery = []
  /** 正在看第几张（0 基）。 */
  var index = 0
  /** 打开前焦点落在哪 —— 关掉时还回去（键盘用户不要被丢回页面顶部）。 */
  var lastFocus = null

  /** 元素是不是 node 自己或它的后代（桩 DOM / 合成事件里 target 可能很奇怪）。 */
  function within(node, element) {
    if (!node || !element) return false
    if (node === element) return true
    if (typeof element.contains !== 'function') return false
    try {
      return element.contains(/** @type {Node} */ (node))
    } catch (error) {
      return false
    }
  }

  /** 两侧的翻页箭头。内联画，不引图标模块 —— 只有这一个方向，没必要多一层依赖。 */
  function chevron(dir) {
    var svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.9')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    var path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', dir === 'prev' ? 'M10 3.5L5.5 8l4.5 4.5' : 'M6 3.5L10.5 8 6 12.5')
    svg.appendChild(path)
    return svg
  }

  function navButton(dir) {
    var button = el('button', 'dsh-sel-lightbox-nav')
    button.type = 'button'
    button.setAttribute('data-dir', dir)
    var label = dir === 'prev' ? '上一张图片（←）' : '下一张图片（→）'
    button.title = label
    button.setAttribute('aria-label', label)
    button.appendChild(chevron(dir))
    listen(button, 'click', function () {
      step(dir === 'prev' ? -1 : 1)
    })
    return button
  }

  function build() {
    if (built) return
    built = true
    root = el('div', 'dsh-sel-lightbox')
    root.setAttribute('data-open', '0')
    root.setAttribute('data-error', '0')
    root.setAttribute('data-gallery', '0')
    root.setAttribute('role', 'dialog')
    // aria-modal **只在打开时挂上**：宿主与插件自己都按 `[role="dialog"][aria-modal="true"]`
    // 判断"有没有官方模态浮层"。关着（display:none）的灯箱若一直带着它，会让面板以后的 Esc
    // 全部被让给一个不存在的浮层 —— 小窗就再也关不掉了。
    root.setAttribute('aria-label', '图片预览')

    var bar = el('div', 'dsh-sel-lightbox-bar')
    nameEl = el('span', 'dsh-sel-lightbox-name')
    countEl = el('span', 'dsh-sel-lightbox-count')
    closeBtn = el('button', 'dsh-sel-lightbox-x')
    closeBtn.type = 'button'
    closeBtn.title = '关闭预览（Esc）'
    closeBtn.setAttribute('aria-label', '关闭图片预览')
    closeBtn.appendChild(closeIcon())
    listen(closeBtn, 'click', function () {
      close()
    })
    bar.appendChild(nameEl)
    bar.appendChild(countEl)
    bar.appendChild(closeBtn)

    stage = el('div', 'dsh-sel-lightbox-stage')
    img = document.createElement('img')
    img.className = 'dsh-sel-lightbox-img'
    img.alt = ''
    img.decoding = 'async'
    img.draggable = false
    // 回放路由偶尔会 404（引用被清理 / 附件仓换过地方）：
    // 与其留一个破图图标，不如写清楚"这张图打不开了"。
    img.addEventListener('error', function () {
      if (!open) return
      root.setAttribute('data-error', '1')
      failEl.textContent = '这张图打不开了（附件可能已被清理）'
    })
    stage.appendChild(img)
    failEl = el('p', 'dsh-sel-lightbox-fail')

    prevBtn = navButton('prev')
    nextBtn = navButton('next')
    hintEl = el('p', 'dsh-sel-lightbox-hint')

    root.appendChild(bar)
    root.appendChild(stage)
    root.appendChild(failEl)
    root.appendChild(prevBtn)
    root.appendChild(nextBtn)
    root.appendChild(hintEl)

    // 关闭：✕ / 点图片以外的任何地方。
    // 点图片本身**不**关：刚放大就想细看，误触一下又缩回去最烦人。
    // 顶栏与翻页键也不关（✕ 自己有监听）—— 否则点翻页会先把自己关掉。
    listen(root, 'click', function (event) {
      if (!open) return
      var target = event.target
      if (target === img) return
      if (within(target, bar) || within(target, prevBtn) || within(target, nextBtn)) return
      close()
    })

    // 灯箱是模态的：Tab 别把焦点送到被盖住的面板/正文里。
    // 可聚焦的只有 ✕ 与两个翻页键，Tab 就在这三者之间转。
    listen(root, 'keydown', function (event) {
      if (!open || event.key !== 'Tab') return
      var order = [prevBtn, nextBtn, closeBtn].filter(function (button) {
        return !button.disabled
      })
      var current = order.indexOf(document.activeElement)
      var next = event.shiftKey ? current - 1 : current + 1
      if (next < 0) next = order.length - 1
      if (next >= order.length) next = 0
      event.preventDefault()
      if (order[next] && typeof order[next].focus === 'function') order[next].focus()
    })

    env.layer.appendChild(root)
  }

  /** 把当前这张画出来（也负责单图/多图的可见性、计数与按钮禁用态）。 */
  function paintImage() {
    var item = gallery[index] || { src: '', name: '图片' }
    var many = gallery.length > 1
    root.setAttribute('data-error', '0')
    root.setAttribute('data-gallery', many ? '1' : '0')
    failEl.textContent = ''
    nameEl.textContent = item.name || '图片'
    img.alt = nameEl.textContent
    img.src = item.src
    countEl.textContent = many ? index + 1 + ' / ' + gallery.length : ''
    prevBtn.disabled = !many || index === 0
    nextBtn.disabled = !many || index === gallery.length - 1
    hintEl.textContent = many ? '← / → 切换 · Esc 或点击空白处关闭' : 'Esc 或点击空白处关闭'
    root.setAttribute('aria-label', '图片预览' + (many ? '（' + (index + 1) + ' / ' + gallery.length + '）' : ''))
  }

  /** 翻一张；到头就停住（不循环 —— 停住比"从最后一张跳回第一张"更不容易迷路）。 */
  function step(delta) {
    if (!open || gallery.length < 2) return
    var next = index + delta
    if (next < 0 || next >= gallery.length) return
    index = next
    paintImage()
  }

  /** 收集并校验调用方给的那组图；空项/坏项直接跳过。 */
  function normalize(items, fallback) {
    var list = []
    if (items && items.length) {
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i] || {}
        if (!item.src) continue
        list.push({ src: String(item.src), name: item.name ? String(item.name) : '图片' })
      }
    }
    if (list.length === 0 && fallback && fallback.src) {
      list.push({ src: String(fallback.src), name: fallback.name ? String(fallback.name) : '图片' })
    }
    return list
  }

  function openImage(options) {
    build()
    var given = options && Array.isArray(options.images) ? options.images : null
    var list = normalize(given, options)
    if (list.length === 0) return
    var start = options && typeof options.index === 'number' ? Math.floor(options.index) : 0
    if (!(start >= 0 && start < list.length)) start = 0
    gallery = list
    index = start
    lastFocus = document.activeElement
    open = true
    root.setAttribute('data-open', '1')
    root.setAttribute('aria-modal', 'true')
    paintImage()
    // 焦点落在关闭键上：Esc 之外，Tab / Enter 也能立刻退出，不把键盘用户困在灯箱里。
    if (typeof closeBtn.focus === 'function') closeBtn.focus()
  }

  function close() {
    if (!open || !built) return
    open = false
    gallery = []
    index = 0
    root.setAttribute('data-open', '0')
    root.setAttribute('data-error', '0')
    root.setAttribute('data-gallery', '0')
    root.removeAttribute('aria-modal')
    // 立刻断掉 src：否则关掉后这张大图还挂在内存里（尤其是回放路由的整图）。
    img.removeAttribute('src')
    img.alt = ''
    countEl.textContent = ''
    prevBtn.disabled = true
    nextBtn.disabled = true
    var back = lastFocus
    lastFocus = null
    if (back && back.isConnected !== false && typeof back.focus === 'function') {
      try {
        back.focus()
      } catch (error) {
        /* 焦点回不去不致命：目标可能已经跟着消息重绘被换掉了 */
      }
    }
  }

  /** 是不是有**别人的**模态浮层盖在灯箱上面（官方设置之类）。 */
  function foreignModalOpen() {
    var modals = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
    for (var i = 0; i < modals.length; i += 1) if (modals[i] !== root) return true
    return false
  }

  /**
   * Esc 只退**最内层**：灯箱开着时先收灯箱，不能顺手把小窗也关了；
   * ← / → 在同一层里翻图（只在这组图多于一张时接管，单图时把方向键留给页面）。
   *
   * 用 capture 且注册在面板的 Esc 之前（controllers 的创建顺序），再 `defaultPrevented`
   * 让后面的处理器自动放行 —— 和语音卡是同一套规则，只是这一层更靠里。
   */
  var offKey = listen(document, 'keydown', function (event) {
    if (!open) return
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (gallery.length < 2 || foreignModalOpen()) return
      event.preventDefault()
      event.stopPropagation()
      step(event.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (event.key !== 'Escape') return
    // 官方设置等模态浮层的 Esc 归它自己：它在灯箱之上，先让它退。
    // （我们自己也是 aria-modal；按节点排除，别把自己当成"别人的浮层"。）
    if (foreignModalOpen()) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }, true)

  return {
    open: openImage,
    close,
    get isOpen() {
      return open
    },
    /** 卸载时摘掉 document 上的监听（灯箱 DOM 随 layer 一起销毁）。 */
    dispose: function () {
      close()
      offKey()
    },
  }
}
