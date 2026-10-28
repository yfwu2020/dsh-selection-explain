import { clamp } from './dom.js'
import { BRIDGE_MARK, bridgeIntoHtml } from './bridge.js'

/** preview state and operations; dependencies are supplied as live node/callback accessors. */
/** @param {import('./controller-contracts.js').PreviewEnv} env */
export function createPreviewController(env) {

  // —— 侧边栏网页（iframe）划词桥的父侧接线 ——

  /**
   * 我们桥过的帧：frame → 自己建的 blob url（'' = srcdoc 帧，没有 blob 要回收）。
   * 用 Map 而不是数组：既要按帧查自己的 url，也要遍历找回消息来源对应的帧。
   */
  var bridged = new Map()

  /**
   * 帧 → 最后一次收到它的消息的时间戳。
   *
   * 只为一件事：判断"用户此刻是不是就在那个侧边栏网页里"（见 hasFocusEvidence）。
   * 焦点落在不透明源子框架里时，父文档的 `document.hasFocus()` 未必为真，
   * 而桥报上来的每条消息本身就是"用户刚在那儿动过"的证据。
   */
  var frameTouchedAt = new Map()

  /** 总开关：host 的 bridgeSidebarPreview 说关就关（见下面 ping 分支）。 */
  var bridgeOn = true

  /** 扫描节流用的定时器 id。 */
  var bridgeScanId = 0

  var bridgeObserver = null

  function ownedUrl(frame) {
    var url = bridged.get(frame)
    return url === undefined ? '' : url
  }

  /** 消息来源 → 帧（只认我们桥过的帧，别的窗口发来的消息一概不理）。 */
  function frameBySource(source) {
    var found = null
    bridged.forEach(function (url, frame) {
      if (found) return
      try {
        if (frame.contentWindow && frame.contentWindow === source) found = frame
      } catch (error) {
        /* 跨源取 contentWindow 可能抛，忽略 */
      }
    })
    return found
  }

  /** 沙箱补一个 allow-scripts（**绝不补 allow-same-origin**）：桥要跑起来。 */
  function ensureScriptsAllowed(frame) {
    var sandbox = frame.getAttribute('sandbox')
    if (sandbox === null) return // 没有 sandbox 属性 = 同源帧，不归这条路管
    if (!/(^|\s)allow-scripts(\s|$)/.test(sandbox)) {
      frame.setAttribute('sandbox', (sandbox + ' allow-scripts').trim())
    }
  }

  /** 帧内坐标 → 视口坐标；选区滚出帧的可视区就返回 null（免得浮标飘到主会话上）。 */
  function mapFrameRect(frame, reported) {
    if (!reported) return null
    var box
    try {
      box = frame.getBoundingClientRect()
    } catch (error) {
      return null
    }
    if (!box || (!box.width && !box.height)) return null
    var left = box.left + Number(reported.x || 0)
    var top = box.top + Number(reported.y || 0)
    var right = box.left + Number(reported.right || 0)
    var bottom = box.top + Number(reported.bottom || 0)
    if (!(right > left)) right = left + Number(reported.w || 0)
    if (!(bottom > top)) bottom = top + Number(reported.h || 0)
    if (bottom < box.top + 2 || top > box.bottom - 2) return null
    top = clamp(top, box.top, box.bottom)
    bottom = clamp(bottom, box.top, box.bottom)
    left = clamp(left, box.left, box.right)
    right = clamp(right, box.left, box.right)
    return {
      left: left,
      top: top,
      right: right,
      bottom: bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    }
  }

  /** 面板里的位置标签：帧内认出来的（代码块/表格）优先，否则按帧的来源给。 */
  function labelForFrame(frame, frameLabel) {
    if (frameLabel === '代码块' || frameLabel === '表格') return frameLabel
    if (frame.getAttribute('data-html-preview') !== null) return '侧边栏网页'
    // 其他插件的网页（例如「图解」）：用帧自己的 title 当位置标签，比笼统的"网页内容"有用
    var title = String(frame.getAttribute('title') || '')
      .replace(/\s+/g, ' ')
      .trim()
    return title ? title.slice(0, 24) : '网页内容'
  }

  /**
   * 这一帧能不能桥。
   *
   * 只认"文档确实是我们能改写的那两种"：`srcdoc` 或 `blob:` —— 远端站点 iframe 与
   * 路由 URL 的预览器（如 better-sidebar 的 HTML 预览）一概不动，它们的资源改写
   * 与生命周期归它们自己。
   *
   * 沙箱上分两档，因为"补 allow-scripts"是有代价的：
   *   · 宿主自己的 HTML 预览（`data-html-preview`）：内容已由宿主 DOMPurify 清洗成
   *     "无脚本、无外链"，补 allow-scripts 之后真正会跑的只有桥自己，可以补；
   *   · 其他插件的网页（如「图解」的 `blob:` 帧）：**只桥本来就允许脚本的**——
   *     不给别人的沙箱加权限，免得把一份刻意不跑脚本的文档变成会跑脚本。
   */
  function bridgeableFrame(frame) {
    if (!frame || frame.nodeType !== 1 || !frame.isConnected) return false
    if (env.panel.contains(frame)) return false // 我们自己的小窗（含网页答案预览）不桥
    var hasSrcdoc = frame.getAttribute('srcdoc') !== null
    var src = frame.getAttribute('src') || ''
    if (!hasSrcdoc && !/^blob:/i.test(src)) return false
    var sandbox = frame.getAttribute('sandbox')
    if (sandbox === null) return false
    if (frame.getAttribute('data-html-preview') !== null) return true
    return /(^|\s)allow-scripts(\s|$)/.test(sandbox)
  }

  function bridgeFrame(frame) {
    if (!bridgeOn || !bridgeableFrame(frame)) return
    var srcdoc = frame.getAttribute('srcdoc')
    if (srcdoc !== null && srcdoc !== undefined) {
      if (srcdoc.indexOf(BRIDGE_MARK) >= 0) return // 已经桥过（我们自己写回去的那份）
      var next = bridgeIntoHtml(srcdoc)
      if (!next) return
      // 顺序有讲究（Chrome 153 实测）：**先补沙箱、再改 srcdoc，且必须在同一个任务里**。
      // 先改 srcdoc 再补沙箱、或者分两个任务改，帧都不会带着 allow-scripts 重新加载
      // （脚本静默不跑，表现为"注入了但没反应"）。
      ensureScriptsAllowed(frame)
      frame.setAttribute('data-dsh-sel-bridged', '1')
      frame.setAttribute('srcdoc', next)
      bridged.set(frame, '')
      return
    }
    var src = frame.getAttribute('src') || ''
    // 只动 blob:（宿主与「图解」这类插件都是用它装生成页的）。
    // 路由 URL / 远端地址一概不碰：那些的资源改写与生命周期归宿主，插手只会弄坏预览。
    if (!/^blob:/i.test(src)) return
    if (src === ownedUrl(frame)) return // 已经是我们换上去的那份
    fetch(src)
      .then(function (response) {
        // 原 blob 的 MIME **要跟着搬**：blob: 文档没有"父文档编码"可继承，
        // 编码只来自这个 content-type（或页面里的 meta）。「图解」建 blob 时写的是
        // `text/html;charset=utf-8`，我们若退回裸 `text/html`，页面又没写 meta charset 的话，
        // 整页中文会变成乱码（实测过：`鍥捐В椤?`）。
        var type = 'text/html'
        try {
          var header = response.headers && response.headers.get && response.headers.get('content-type')
          if (header) type = header
        } catch (error) {
          /* 取不到就退回 text/html：与原行为一致 */
        }
        return response.text().then(function (text) {
          return { text: text, type: type }
        })
      })
      .then(function (loaded) {
        if (!bridgeOn || !frame.isConnected) return
        var bridgedHtml = bridgeIntoHtml(loaded.text)
        if (!bridgedHtml) return
        var url = URL.createObjectURL(new Blob([bridgedHtml], { type: loaded.type }))
        var previous = ownedUrl(frame)
        bridged.set(frame, url)
        ensureScriptsAllowed(frame)
        frame.setAttribute('data-dsh-sel-bridged', '1')
        frame.setAttribute('src', url)
        if (previous) {
          try {
            URL.revokeObjectURL(previous)
          } catch (error) {
            /* 回收失败不致命 */
          }
        }
      })
      .catch(function () {
        /* 读不到就放着：原预览照常显示，只是这一帧没有划词桥 */
      })
  }

  /** 帧没了（关标签页/切源码视图）就顺手回收我们自己建的 blob，别漏。 */
  function pruneBridged() {
    var dead = []
    bridged.forEach(function (url, frame) {
      if (!frame.isConnected) dead.push(frame)
    })
    for (var i = 0; i < dead.length; i += 1) {
      var url = bridged.get(dead[i])
      if (url) {
        try {
          URL.revokeObjectURL(url)
        } catch (error) {
          /* 回收失败不致命 */
        }
      }
      // 帧没了就不会再有 clear 消息了：把它占着的那条选区一起清掉，
      // 否则 `bridgeActive` 会一直挂着（表现为顶层选区塌掉也不收浮标）。
      // 卡片开着时也不清：帧没了但它占着的选区仍是"这一轮的解读对象"（发送要用），
      // 与下面 clear 分支同一条规则。
      if (env.state.selection && env.state.selection.frame === dead[i]) {
        env.state.bridgeActive = false
        if (!env.vcardState.open) env.state.selection = null
        env.hideButton()
      }
      frameTouchedAt.delete(dead[i])
      bridged.delete(dead[i])
    }
  }

  function scanPreviewFrames() {
    if (!bridgeOn) return
    // 无浏览器测试的桩 DOM 没有 querySelectorAll：桥整体静默跳过
    if (typeof document.querySelectorAll !== 'function') return
    pruneBridged()
    // 扫全部 iframe 再按 bridgeableFrame 过滤：宿主的 HTML 预览、以及别的插件
    // 在侧边栏渲染的生成网页（「图解」那种 blob: 帧）都在这条路上，
    // 不能只看宿主的 data-html-preview 标记。
    var frames = document.querySelectorAll('iframe')
    for (var i = 0; i < frames.length; i += 1) bridgeFrame(frames[i])
  }

  function scheduleBridgeScan() {
    if (bridgeScanId) return
    bridgeScanId = env.later(function () {
      bridgeScanId = 0
      scanPreviewFrames()
    }, 120)
  }
  return {
    get bridgeOn() { return bridgeOn },
    set bridgeOn(value) { bridgeOn = value },
    frameBySource,
    get frameTouchedAt() { return frameTouchedAt },
    set frameTouchedAt(value) { frameTouchedAt = value },
    mapFrameRect,
    labelForFrame,
    get bridgeObserver() { return bridgeObserver },
    set bridgeObserver(value) { bridgeObserver = value },
    scheduleBridgeScan,
    get bridged() { return bridged },
    set bridged(value) { bridged = value },
    scanPreviewFrames,
    get bridgeScanId() { return bridgeScanId },
    set bridgeScanId(value) { bridgeScanId = value },
  }
}
