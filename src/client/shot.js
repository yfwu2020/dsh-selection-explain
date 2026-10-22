/**
 * 截图提问：客户端。
 *
 * 和 host 的分工：
 *   · host 负责**起截图、找窗口、整窗截下来**，并把"选区在图像里的像素位置"算好（shot.ts）；
 *   · 这里负责**画红框、上传、放进界面** —— 画图交给浏览器 canvas，host 不需要图像库。
 *
 * 为什么红框在客户端画：附件服务最终会把图规范化（长边 2048）。如果 host 先画再压，
 * 框线会跟着被缩放；先压后画又会丢位置信息。客户端在**原图**上画、再上传，框线粗细和位置都准。
 */
import { SHOT_PENDING, SHOT_IMAGE, SHOT_START, ATTACH } from './constants.js'

/** 画红框后最长边（附件服务的上限就是 2048，再大也会被压）。 */
export var MAX_ANNOTATED = 2048

/** 红框颜色（用户定的红色实线）与**输出图里的**最小线宽。 */
export var FRAME_COLOR = '#e5484d'
/** 线宽按输出分辨率算，但不低于 3px —— 压到 2048 长边后 2px 太细，
 *  图里本来就有红色元素时模型容易分不清哪个是"框"。 */
export var FRAME_WIDTH_MIN_PX = 3

/** 判定"选区落在窗口内"的容差（像素）。 */
export var SHOT_INSIDE_SLOP = 2

/** 屏幕矩形 → 页面矩形。 */
/**
 * 把"选区（屏幕点）"换算成"页面 CSS px"。
 *
 * 旧算法只用 `window.screenX/screenY`，它等于窗口**外框**左上角，而且完全不管页面缩放 ——
 * 窗口一大、或者页面被缩放过，误差就被放大（用户实测：页面尺寸一变框就飘得很厉害）。
 *
 * 新算法全部用**实测值**：
 *   scale   = 自己窗口宽(点) / outerWidth(CSS px)      ← 缩放多少都算得出
 *   内容原点 = 窗口原点 + (outerHeight - innerHeight) × scale
 * 这些量每次截图现取，与窗口大小 / 缩放 / DPI 无关。
 *
 * 拿不到 selfWindow（host 没认出来）就回退旧算法，不会更差。
 */
export function pageRectFromScreen(rect, selfWindow, metrics) {
  if (!rect) return null
  if (!selfWindow || !metrics) return pageRectOf(rect, metrics)
  var outerW = metrics.outerWidth || 0
  var outerH = metrics.outerHeight || 0
  var innerH = metrics.innerHeight || 0
  if (outerW <= 0 || outerH <= 0) return pageRectOf(rect, metrics)
  var scale = selfWindow.width / outerW
  if (!(scale > 0.2 && scale < 5)) return pageRectOf(rect, metrics)
  var chrome = Math.max(0, outerH - innerH) * scale
  // 合理性检查：标题栏不该超过 80 点（超过说明认错窗口或量到了别的边框）
  if (chrome > 80) chrome = 0
  var originX = selfWindow.x
  var originY = selfWindow.y + chrome
  return asRect({
    left: (rect.x - originX) / scale,
    top: (rect.y - originY) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  })
}

export function pageRectOf(rect, origin) {
  if (!rect) return null
  var sx = origin && typeof origin.screenX === 'number' ? origin.screenX : 0
  var sy = origin && typeof origin.screenY === 'number' ? origin.screenY : 0
  return asRect({
    left: rect.x - sx,
    top: rect.y - sy,
    width: rect.width,
    height: rect.height,
  })
}

/** 补齐成 DOMRect 形状（vcardGeometry 会读 right/bottom）。 */
export function asRect(box) {
  var left = typeof box.left === 'number' ? box.left : 0
  var top = typeof box.top === 'number' ? box.top : 0
  var width = typeof box.width === 'number' ? box.width : 0
  var height = typeof box.height === 'number' ? box.height : 0
  return { left: left, top: top, width: width, height: height, right: left + width, bottom: top + height, x: left, y: top }
}

export function insideViewport(rect, viewport, slop) {
  if (!rect || !viewport) return false
  var pad = typeof slop === 'number' ? slop : SHOT_INSIDE_SLOP
  return (
    rect.left >= -pad &&
    rect.top >= -pad &&
    rect.left + rect.width <= viewport.width + pad &&
    rect.top + rect.height <= viewport.height + pad
  )
}

/** 选区中心离哪条窗口边最近。 */
export function nearestEdge(rect, viewport) {
  var cx = rect.left + rect.width / 2
  var cy = rect.top + rect.height / 2
  var d = { left: Math.abs(cx), right: Math.abs(viewport.width - cx), top: Math.abs(cy), bottom: Math.abs(viewport.height - cy) }
  var best = 'left'
  var bestValue = Infinity
  for (var key in d) {
    if (!Object.prototype.hasOwnProperty.call(d, key)) continue
    if (d[key] < bestValue) {
      bestValue = d[key]
      best = key
    }
  }
  return best
}

/** 贴边缩略图的位置（选区落在窗口外时用）。 */
export function chipRectFor(edge, anchorRect, viewport, size) {
  var w = (size && size.width) || 158
  var h = (size && size.height) || 48
  var pad = 12
  var cx = anchorRect.left + anchorRect.width / 2
  var cy = anchorRect.top + anchorRect.height / 2
  var left
  var top
  if (edge === 'left' || edge === 'right') {
    left = edge === 'left' ? pad : viewport.width - w - pad
    top = Math.max(pad, Math.min(cy - h / 2, viewport.height - h - pad))
  } else {
    top = edge === 'top' ? pad : viewport.height - h - pad
    left = Math.max(pad, Math.min(cx - w / 2, viewport.width - w - pad))
  }
  return { left: left, top: top, width: w, height: h }
}

/** 把整窗图 + 红框画成一张 PNG（Blob）。 */
export function annotate(image, rect, scale) {
  var iw = image.naturalWidth || image.width
  var ih = image.naturalHeight || image.height
  // 附件服务最终会把长边压到 2048 —— 我们直接按这个尺寸画，省掉几倍的无用编码。
  var k = iw > MAX_ANNOTATED ? MAX_ANNOTATED / iw : 1
  var canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(iw * k))
  canvas.height = Math.max(1, Math.round(ih * k))
  var g = canvas.getContext('2d')
  g.drawImage(image, 0, 0, canvas.width, canvas.height)
  // 选区同样按比例缩放（rect 是原图像素坐标）
  rect = { x: rect.x * k, y: rect.y * k, width: rect.width * k, height: rect.height * k }
  // 按输出像素排：整窗 2 倍图压到 2048 后，2px 只剩 1 像素多，太容易糊掉
  var line = Math.max(FRAME_WIDTH_MIN_PX, Math.round(3 * (scale || 1) * k))
  g.strokeStyle = FRAME_COLOR
  g.lineWidth = line
  // 一半画在外面会被裁掉，内缩半个线宽让框完整落在图内
  var inset = line / 2
  g.strokeRect(rect.x + inset, rect.y + inset, Math.max(0, rect.width - line), Math.max(0, rect.height - line))
  return new Promise(function (resolve) {
    canvas.toBlob(function (blob) {
      resolve(blob)
    }, 'image/png')
  })
}

/** 诊断：把当前走到哪一步、错在哪报给 host（`/shot/status` 里能看到）。 */
function report(payload) {
  try {
    fetch('/selection-explain/api/shot/hello', { method: 'POST', body: JSON.stringify(payload) }).catch(function () {})
  } catch (error) {
    /* 没有 fetch 的环境跳过 */
  }
}

export function createShotController(env) {
  // 实例世代：热重载后可能同时存在多个实例（旧的没被彻底收掉），
  // 它们都在长轮询 /shot/pending —— 谁抢到谁处理。旧实例的 layer 往往已经
  // 脱离文档，结果就是"卡片画进了看不见的节点"（时好时坏的那种）。
  // 所以：只有**最新**那一代允许轮询，老的自己停手。
  var host = (env.window || (typeof window !== 'undefined' ? window : null)) || {}
  var myEpoch = 0
  try {
    host.__dshSelShotEpoch = (host.__dshSelShotEpoch || 0) + 1
    myEpoch = host.__dshSelShotEpoch
  } catch (error) {
    myEpoch = 1
  }

  function superseded() {
    try {
      return host.__dshSelShotEpoch !== myEpoch
    } catch (error) {
      return false
    }
  }

  var timer = 0
  var busy = false
  var lastId = ''
  var current = null
  var frameEl = null
  var chipEl = null
  var chipImg = null
  /** 缩略图的 objectURL：换图/清理时要 revoke，否则 Blob 一直留着。 */
  var chipUrl = ''

  function doc() {
    return env.document
  }

  function viewport() {
    var win = env.window || window
    return { width: (win && win.innerWidth) || 1200, height: (win && win.innerHeight) || 800 }
  }

  function origin() {
    var win = env.window || window
    return { screenX: win && win.screenX ? win.screenX : 0, screenY: win && win.screenY ? win.screenY : 0 }
  }

  function ensureFrame() {
    if (frameEl) return frameEl
    var d = doc()
    frameEl = d.createElement('div')
    frameEl.className = 'dsh-sel-shotframe'
    frameEl.setAttribute('data-show', '0')
    var tag = d.createElement('span')
    tag.className = 'dsh-sel-shotframe-tag'
    tag.textContent = '已选中的区域'
    frameEl.appendChild(tag)
    env.layer.appendChild(frameEl)
    return frameEl
  }

  function ensureChip() {
    if (chipEl) return chipEl
    var d = doc()
    chipEl = d.createElement('div')
    chipEl.className = 'dsh-sel-shotchip'
    chipEl.setAttribute('data-show', '0')
    chipImg = d.createElement('img')
    chipImg.alt = '截图'
    chipEl.appendChild(chipImg)
    var tx = d.createElement('span')
    tx.className = 'dsh-sel-shotchip-tx'
    var b = d.createElement('b')
    b.textContent = '整窗 + 红框'
    var meta = d.createElement('span')
    meta.className = 'dsh-sel-shotchip-meta'
    tx.appendChild(b)
    tx.appendChild(meta)
    chipEl.appendChild(tx)
    env.layer.appendChild(chipEl)
    return chipEl
  }

  function hideMarkers() {
    if (frameEl) frameEl.setAttribute('data-show', '0')
    if (chipEl) chipEl.setAttribute('data-show', '0')
  }

  /**
   * 收干净：框、缩略图、卡片、选区状态。ESC 与点空白都走它。
   */
  function clearAll() {
    hideMarkers()
    if (chipUrl) {
      URL.revokeObjectURL(chipUrl)
      chipUrl = ''
    }
    if (chipImg) chipImg.removeAttribute('src')
    current = null
    if (env.state.selection && env.state.selection.source === 'shot') env.state.selection = null
    if (env.vcardOpen && env.vcardOpen() && env.closeVCard) env.closeVCard()
  }

  var cancelBound = false
  function bindCancel() {
    if (cancelBound) return
    var d = doc()
    if (!d || !d.addEventListener) return
    cancelBound = true
    var showing = function () {
      return !!current || (frameEl && frameEl.getAttribute('data-show') === '1') || (chipEl && chipEl.getAttribute('data-show') === '1')
    }
    d.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && showing()) clearAll()
    }, true)
    d.addEventListener('pointerdown', function (event) {
      if (!showing()) return
      var target = event.target
      var card = env.vcardElement && env.vcardElement()
      if (card && target && card.contains && card.contains(target)) return
      if (chipEl && target && chipEl.contains && chipEl.contains(target)) return
      clearAll()
    }, true)
  }

  /** 起一次截图（host 弹系统十字准星）。 */
  function startCapture() {
    // 起新截图前先把上一张的框/卡片收掉：
    // 这些是我们自己的页面内容，不收拾的话会被 `screencapture -l` 截进新图里。
    clearAll()
    // 带上页面几何：host 靠它认出"DSH 自己的窗口"，再配合它把选区精确换算成 CSS px
    var win = env.window || window
    var q =
      '?sx=' + Math.round(win.screenX || 0) +
      '&sy=' + Math.round(win.screenY || 0) +
      '&ow=' + Math.round(win.outerWidth || 0) +
      '&oh=' + Math.round(win.outerHeight || 0) +
      '&iw=' + Math.round(win.innerWidth || 0) +
      '&ih=' + Math.round(win.innerHeight || 0)
    fetch(SHOT_START + q, { method: 'POST', body: '' }).catch(function () {})
  }

  /**
   * 处理一次结果：画红框 → 上传 → 放进界面。
   */
  /**
   * 处理一次截图结果。
   *
   * ⚠️ 顺序是刻意的：**先出框和卡片，再画图上传**。
   * 那张整窗图是 3840×2224（850 万像素），浏览器编码 PNG 要一两秒 —— 如果等它做完再开卡，
   * 用户会看到 2-3 秒空窗，期间随便点一下就触发"点空白取消"，表现就是"时好时坏"。
   * 所以：几何算完立刻开卡（0 延迟），红框图在后台画、后台传，发送那一刻再等它。
   */
  async function handle(shot) {
    if (!shot || shot.id === lastId) return
    lastId = shot.id
    var t0 = Date.now()
    current = { shot: shot, file: null, blob: null, ref: null, refReady: null, uploading: null, t0: t0 }
    var step = 'geometry'
    try {
      // ── ① 立刻：算位置 → 画框/缩略图 → 开卡 ──
      // layer 可能被 slot 重渲染摘掉（见 index.js 的 ensureLayer）：这里先挂回去，
      // 否则框和卡片会 append 到一个不在文档里的节点上 —— 什么都不显示。
      if (env.ensureLayer) env.ensureLayer()
      var win = env.window || window
      var metrics = {
        screenX: win.screenX || 0,
        screenY: win.screenY || 0,
        outerWidth: win.outerWidth || 0,
        outerHeight: win.outerHeight || 0,
        innerWidth: win.innerWidth || 0,
        innerHeight: win.innerHeight || 0,
      }
      var page = pageRectFromScreen(shot.selectionRect, shot.selfWindow, metrics)
      report({ stage: 'geometry', self: shot.selfWindow, metrics: metrics, page: page ? [Math.round(page.left), Math.round(page.top), Math.round(page.width), Math.round(page.height)] : null })
      var view = viewport()
      var inside = !!(page && insideViewport(page, view))
      var anchor
      if (inside) {
        var frame = ensureFrame()
        frame.style.left = Math.round(page.left) + 'px'
        frame.style.top = Math.round(page.top) + 'px'
        frame.style.width = Math.round(page.width) + 'px'
        frame.style.height = Math.round(page.height) + 'px'
        frame.setAttribute('data-show', '1')
        if (chipEl) chipEl.setAttribute('data-show', '0')
        anchor = page
      } else {
        var chip = ensureChip()
        var edge = nearestEdge(page || { left: 0, top: 0, width: 0, height: 0 }, view)
        var box = chipRectFor(edge, page || { left: 0, top: 0, width: 0, height: 0 }, view)
        chip.style.left = Math.round(box.left) + 'px'
        chip.style.top = Math.round(box.top) + 'px'
        var meta = chip.querySelector('.dsh-sel-shotchip-meta')
        if (meta) meta.textContent = Math.round(shot.selectionRect.width) + ' × ' + Math.round(shot.selectionRect.height)
        chip.setAttribute('data-show', '1')
        if (frameEl) frameEl.setAttribute('data-show', '0')
        anchor = asRect(box)
      }

      // ── ② 后台：画红框 + 上传，并把 promise 挂在 current 上（发送时 await）──
      var md0 = Date.now()
      step = 'annotate'
      current.refReady = loadImage(SHOT_IMAGE + '?id=' + encodeURIComponent(shot.id))
        .then(function (img) {
          return annotate(img, shot.rect, shot.scale)
        })
        .then(function (blob) {
          if (!blob) return null
          current.blob = blob
          current.file = new File([blob], '截图.png', { type: 'image/png' })
          if (chipImg) {
            // 换图前把上一张的 objectURL 收掉，否则每截一次就多留一个 Blob 在内存里
            if (chipUrl) URL.revokeObjectURL(chipUrl)
            chipUrl = URL.createObjectURL(blob)
            chipImg.src = chipUrl
          }
          report({ stage: 'bg-done', ms: Date.now() - md0 })
          return null
        })
        .catch(function (error) {
          report({ stage: 'bg-fail', ms: Date.now() - md0, error: String((error && error.message) || error) })
          return null
        })

      // ── ③ 小窗开着：图直接进输入框（后台等图做好再塞）──
      if (env.panelOpen) {
        var ready = current.refReady
        if (ready) ready.then(function () {
          if (current.file) env.addFiles([current.file])
          if (env.focusAskBox) env.focusAskBox()
        })
        report({ stage: 'done', branch: 'panel', ms: Date.now() - t0 })
        return
      }

      // ── ④ 没开：开语音卡（不等图）──
      env.state.selection = {
        source: 'shot',
        text: '',
        label: '截图',
        context: '',
        keyContext: '',
        range: null,
        rect: anchor,
        shot: current,
        ref: null,
      }
      step = 'openVCard'
      env.openVCard()
      var opened = !env.vcardOpen || env.vcardOpen()
      report({ stage: 'done', branch: inside ? 'frame' : 'chip', opened: opened, ms: Date.now() - t0 })
      setTimeout(function () {
        try {
          var card = env.vcardElement && env.vcardElement()
          var cinfo = null
          if (card) {
            var cr = card.getBoundingClientRect()
            var cs = getComputedStyle(card)
            cinfo = { rect: [Math.round(cr.left), Math.round(cr.top), Math.round(cr.width), Math.round(cr.height)], display: cs.display, opacity: cs.opacity, z: cs.zIndex }
          }
          var layerEl = env.layer
          report({
            stage: 'probe',
            open: env.vcardOpen ? !!env.vcardOpen() : null,
            card: cinfo,
            layer: layerEl ? { connected: !!layerEl.isConnected, parent: layerEl.parentNode ? (layerEl.parentNode.className || layerEl.parentNode.nodeName) : null } : null,
            frame: frameEl ? { show: frameEl.getAttribute('data-show'), connected: !!frameEl.isConnected } : null,
            vp: [window.innerWidth, window.innerHeight],
          })
        } catch (error) {
          report({ stage: 'probe', error: String((error && error.message) || error) })
        }
      }, 500)
      if (!opened) {
        hideMarkers()
        env.state.selection = null
        current = null
      }
    } catch (error) {
      report({ stage: step, error: String((error && error.stack) || (error && error.message) || error) })
    }
  }

  /** 把画好红框的图上传到附件服务，拿到持久引用（发送时用）。 */
  function uploadAnnotated(blob) {
    return new Promise(function (resolve) {
      var reader = new FileReader()
      reader.onload = function () {
        var data = String(reader.result || '')
        var base64 = data.indexOf(',') >= 0 ? data.slice(data.indexOf(',') + 1) : data
        fetch(ATTACH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: [{ kind: 'image', name: '截图.png', mediaType: 'image/png', data: base64 }] }),
        })
          .then(function (r) {
            return r.ok ? r.json() : null
          })
          .then(function (json) {
            var item = json && json.items && json.items[0]
            resolve(item && item.ref ? item.ref : null)
          })
          .catch(function () {
            resolve(null)
          })
      }
      reader.onerror = function () {
        resolve(null)
      }
      reader.readAsDataURL(blob)
    })
  }

  /**
   * 载入一张图，失败重试几次。
   * host 那边整窗截图是后台做的（先发事件、后出图），所以这里偶尔会 404 一拍。
   */
  function loadImage(src, attempt) {
    var tries = attempt || 0
    return new Promise(function (resolve, reject) {
      var img = new Image()
      img.onload = function () {
        resolve(img)
      }
      img.onerror = function (error) {
        if (tries >= 8) {
          reject(error)
          return
        }
        setTimeout(function () {
          loadImage(src, tries + 1).then(resolve, reject)
        }, 120)
      }
      img.src = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'r=' + tries
    })
  }

  async function poll() {
    if (busy) return
    busy = true
    try {
      var res = await fetch(SHOT_PENDING, { cache: 'no-store' })
      if (res.ok) {
        var data = await res.json()
        if (data && data.shot) await handle(data.shot)
      }
    } catch (error) {
      /* host 没起来 / 路由没注册：静默，下一拍再来 */
    } finally {
      busy = false
    }
  }

  function loop() {
    if (superseded()) return
    timer = setTimeout(function () {
      timer = 0
      if (superseded()) return
      var d = doc()
      if (d && d.visibilityState === 'hidden') return loop()
      poll().then(loop, loop)
    }, 30)
  }

  return {
    start: function () {
      bindCancel()
      if (timer) return
      loop()
    },
    stop: function () {
      if (timer) clearTimeout(timer)
      timer = 0
    },
    /** 快捷键按下时调用。 */
    capture: startCapture,
    clear: clearAll,
    clearMarkers: hideMarkers,
    /** 发送时用：当前这张已经画好红框的图（File 与持久引用）。 */
    takeFile: function () {
      return current ? current.file : null
    },
    /**
     * 发送时用：等后台把红框图画好，**此刻才上传**并返回持久引用。
     *
     * 为什么不在截完就传：附件库（~/.dsh/attachments）是内容寻址、**只增不删**，
     * 没有 GC。用户按了 Esc / 点空白取消时，我们不该往里面塞一张永远不会被用到的图。
     */
    takeRefAsync: function () {
      var here = current
      if (!here) return Promise.resolve(null)
      if (here.ref) return Promise.resolve(here.ref)
      if (here.uploading) return here.uploading
      if (!here.refReady) return Promise.resolve(null)
      here.uploading = here.refReady.then(function () {
        if (here.ref) return here.ref
        if (!here.blob) return null
        return uploadAnnotated(here.blob).then(function (ref) {
          here.ref = ref
          here.blob = null
          report({ stage: 'uploaded', ref: !!ref })
          return ref
        })
      })
      return here.uploading
    },
    takeRef: function () {
      return current ? current.ref : null
    },
    state: function () {
      return {
        polling: !!timer,
        lastId: lastId,
        hasFile: !!(current && current.file),
        frame: frameEl ? frameEl.getAttribute('data-show') === '1' : false,
        chip: chipEl ? chipEl.getAttribute('data-show') === '1' : false,
      }
    },
  }
}
