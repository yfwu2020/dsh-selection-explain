

// ────────────────────────────── 小工具 ──────────────────────────────

/**
 * @template {keyof HTMLElementTagNameMap} T
 * @param {T} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[T]}
 */
export function el(tag, cls, text) {
  var node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined && text !== null) node.textContent = text
  return node
}

export function listen(target, type, handler, capture) {
  target.addEventListener(type, handler, capture === true)
  return function () {
    target.removeEventListener(type, handler, capture === true)
  }
}

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

/**
 * 选区是不是"指着一段已经不在文档里的文字"。
 *
 * 这是"选中的文字被删掉"的第二种形态，跟塌陷（`isCollapsed`）**不是**一回事：
 * 节点被整个摘掉时（流式回答重渲染 / 消息被替换 / 内容区刷新），Firefox 里选区并不塌陷 ——
 * `isCollapsed` 仍是 false、`toString()` 还吐得出那段旧文字，可那段文字屏幕上已经没有了。
 * 只认塌陷的话浮标会赖着不走，点下去解读的是一段**不存在的文字**。
 *
 * 取不到 `isConnected`（老环境 / 无浏览器测试的桩 DOM）时一律当"还在"：
 * 宁可多留一会儿，也不误收一个正常选区。
 */
export function selectionDetached(range) {
  var node = range && range.startContainer
  return !!node && node.isConnected === false
}

/** 选区是否落在输入框里（那里不该弹按钮，避免干扰输入）。 */
export function insideEditable(node) {
  var element = node && node.nodeType === 1 ? node : node && node.parentElement
  if (!element || !element.closest) return false
  return !!element.closest('input, textarea')
}

export function formatDuration(ms) {
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'
}

// ────────────────────────── 录音（语音输入）──────────────────────────
// 这一节是**纯函数 + 浏览器能力判断**，不碰面板状态：小窗的编排在 apply() 里。
// 单位换算和 WAV 头必须和 host 的 validateWave 逐字段对上（16kHz / 单声道 / PCM16），
// 对不上 host 会直接拒收 —— 这是刻意的：宁可明确报"音频格式不对"，
// 也不要让识别服务按错误的采样率去听一段快放。

/** 录音时长：0:07（上限 60 秒，所以只有分:秒）。 */
export function formatClock(ms) {
  var seconds = Math.max(0, Math.floor(ms / 1000))
  var mm = Math.floor(seconds / 60)
  var ss = seconds % 60
  return mm + ':' + (ss < 10 ? '0' : '') + ss
}
