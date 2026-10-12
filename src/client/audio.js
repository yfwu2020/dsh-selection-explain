

/**
 * Float32 采样（16kHz 单声道）→ 规范的 PCM16 WAV。
 * @param samples 采样（-1..1）
 * @returns Uint8Array（44 字节头 + 数据）
 */
export function encodeWave(samples) {
  var bytes = new Uint8Array(44 + samples.length * 2)
  var view = new DataView(bytes.buffer)
  function ascii(offset, text) {
    for (var i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块长度
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, 16000, true) // 采样率
  view.setUint32(28, 32000, true) // 字节率
  view.setUint16(32, 2, true) // 块对齐
  view.setUint16(34, 16, true) // 位深
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (var i = 0; i < samples.length; i += 1) {
    // 先夹到 [-1,1]：重采样后的浮点偶尔会略微越界，直接乘会绕回成刺耳的爆音
    var value = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i]
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return bytes
}

/** 字节 → base64（分块喂 fromCharCode，几十万采样一次性展开会爆栈）。 */
export function bytesToBase64(bytes) {
  var text = ''
  for (var i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
  }
  return btoa(text)
}

/** 这个浏览器能不能录音（不支持时麦克风按钮直接给解释，而不是点了才报错）。 */
export function recordingSupported() {
  try {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return false
    if (typeof navigator.mediaDevices.getUserMedia !== 'function') return false
    // 全部走 window.*：浏览器里 window 就是全局对象，测试里也能注入同一套桩
    if (typeof window.MediaRecorder === 'undefined') return false
    return typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined'
  } catch (error) {
    return false
  }
}