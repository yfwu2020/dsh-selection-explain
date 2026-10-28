/** Pure selection geometry and metadata parsing; no process, file or service state. */
import type { ShotRect, DisplayInfo, WinInfo, ShotScope, ShotMode, ShotOptions, ShotConfig, ImageSize, CropBox } from './shot-types.js'
import { MAX_MARGIN_PT } from './shot-types.js'
const SHOT_SCOPES: ShotScope[] = ['screen', 'window', 'margin', 'selection']
export function intersectArea(a: ShotRect, b: { x: number; y: number; w: number; h: number }): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.w)
  const bottom = Math.min(a.y + a.height, b.y + b.h)
  return Math.max(0, right - left) * Math.max(0, bottom - top)
}

/**
 * 选区中心落在哪块屏。
 *
 * 用中心而不是"交集最大"：选区跨屏时，按中心裁到一块屏才能保证**统一缩放**
 * （混合 DPI 下 `screencapture -R` 跨屏的像素比例不是线性的）。
 */
export function pickDisplay(displays: DisplayInfo[], rect: ShotRect): DisplayInfo | null {
  if (displays.length === 0) return null
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const hits = displays.filter((d) => cx >= d.x && cx <= d.x + d.w && cy >= d.y && cy <= d.y + d.h)
  if (hits.length > 0) return hits[0]
  const sorted = displays.slice().sort((a, b) => intersectArea(rect, b) - intersectArea(rect, a))
  return sorted[0] || displays.find((d) => d.main) || null
}

export function clampRect(rect: ShotRect, box: { x: number; y: number; w: number; h: number }): ShotRect {
  const left = Math.max(rect.x, box.x)
  const top = Math.max(rect.y, box.y)
  const right = Math.min(rect.x + rect.width, box.x + box.w)
  const bottom = Math.min(rect.y + rect.height, box.y + box.h)
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Binary plist arrays refer to objects: duplicate coordinate values share the same object. */
export function parseRectPlist(buf: Buffer): number[] | null {
  if (buf.length < 40 || buf.toString('latin1', 0, 6) !== 'bplist') return null
  const trailer = buf.subarray(buf.length - 32)
  const offsetSize = trailer[6]
  const refSize = trailer[7]
  const numObjects = Number(trailer.readBigUInt64BE(8))
  const topObject = Number(trailer.readBigUInt64BE(16))
  const tableOffset = Number(trailer.readBigUInt64BE(24))
  if (!numObjects || offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) return null
  if (![numObjects, topObject, tableOffset].every(Number.isSafeInteger) || topObject >= numObjects || tableOffset < 8 || tableOffset + numObjects * offsetSize > buf.length - 32) return null

  const readSized = (at: number, size: number): number => {
    let value = 0
    for (let i = 0; i < size; i += 1) value = value * 256 + buf[at + i]
    return value
  }
  const objectAt = (index: number): number => {
    if (index < 0 || index >= numObjects) return -1
    return readSized(tableOffset + index * offsetSize, offsetSize)
  }

  /** 把某个对象解成一个数字（int / real / double）。 */
  const readNumber = (at: number): number | null => {
    if (at < 0 || at >= buf.length) return null
    const marker = buf[at]
    const kind = marker >> 4
    const sizeBits = marker & 0x0f
    if (kind === 0x1) {
      // int
      const size = 1 << sizeBits
      if (size > 8 || at + 1 + size > tableOffset) return null
      let value = 0
      for (let i = 0; i < size; i += 1) value = value * 256 + buf[at + 1 + i]
      return value
    }
    if (kind === 0x2) {
      // real（0x22 float32 / 0x23 float64）
      if (sizeBits === 2 && at + 5 <= tableOffset) return buf.readFloatBE(at + 1)
      if (sizeBits === 3 && at + 9 <= tableOffset) return buf.readDoubleBE(at + 1)
    }
    return null
  }

  const arrayAt = objectAt(topObject)
  if (arrayAt < 8 || arrayAt >= tableOffset) return null
  const marker = buf[arrayAt]
  if (marker >> 4 !== 0xa) return null
  let count = marker & 0x0f
  let refsAt = arrayAt + 1
  if (count === 0x0f) {
    // 长数组：后面跟一个 int 表示数量
    if (refsAt >= tableOffset) return null
    const intMarker = buf[refsAt]
    if (intMarker >> 4 !== 1) return null
    const size = 1 << (intMarker & 0x0f)
    if (size > 8 || refsAt + 1 + size > tableOffset) return null
    let value = 0
    for (let i = 0; i < size; i += 1) value = value * 256 + buf[refsAt + 1 + i]
    count = value
    refsAt += 1 + size
  }
  if (!Number.isSafeInteger(count) || refsAt + count * refSize > tableOffset) return null
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    const ref = readSized(refsAt + i * refSize, refSize)
    const value = readNumber(objectAt(ref))
    if (value === null) return null
    out.push(value)
  }
  return out
}

export function contains(win: WinInfo, rect: ShotRect): boolean {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return cx >= win.x && cx <= win.x + win.w && cy >= win.y && cy <= win.y + win.h
}

export function area(win: WinInfo): number {
  return win.w * win.h
}

/**
 * 选"你框的那块属于哪个窗口"。
 *
 * 规则：layer 0（普通应用窗口）里，**包含选区中心**的那些，取面积最小的 ——
 * 这样点在一个大窗口里的小对话框上，裁的是对话框而不是整个背景窗口。
 */
export function pickWindow(wins: WinInfo[], rect: ShotRect): WinInfo | null {
  const candidates = wins
    .filter((w) => w.layer === 0 && contains(w, rect))
    .sort((a, b) => area(a) - area(b))
  return candidates[0] || null
}

export function friendlyCaptureError(stderr: string, code: number | null): string {
  const text = stderr.toLowerCase()
  if (text.includes('not authorized') || text.includes('permission') || text.includes('could not create image')) {
    return '没有屏幕录制权限：请在 系统设置 → 隐私与安全性 → 屏幕录制 中允许 DSH，然后重试'
  }
  const tail = stderr.trim().replace(/\s+/g, ' ').slice(0, 160)
  return `系统截图失败（退出码 ${code ?? '未知'}）${tail ? `：${tail}` : ''}`
}

export function resolveOptions(
  config: ShotConfig,
  mode: ShotMode,
  url: URL,
): Omit<ShotOptions, 'seq'> {
  const override = url.searchParams.get('scope')
  const stored = mode === 'panel' ? config.shotPanelScope : config.shotCardScope
  const raw = override && SHOT_SCOPES.includes(override as ShotScope) ? override : stored
  const scope = SHOT_SCOPES.includes(raw as ShotScope) ? (raw as ShotScope) : mode === 'panel' ? 'selection' : 'window'
  const marginParam = url.searchParams.get('margin')
  const marginValue = marginParam === null ? NaN : Number(marginParam)
  const fallback = Number.isFinite(config.shotMargin) ? config.shotMargin : 48
  const margin = Number.isFinite(marginValue)
    ? Math.max(0, Math.min(MAX_MARGIN_PT, Math.round(marginValue)))
    : Math.max(0, Math.min(MAX_MARGIN_PT, Math.round(fallback)))
  return { mode, scope, margin }
}

export function parseRectXattr(hex: string): ShotRect | null {
  const raw = hex.replace(/\s+/g, '')
  if (!raw || raw.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(raw)) return null
  const nums = parseRectPlist(Buffer.from(raw, 'hex'))
  if (!nums || nums.length < 4) return null
  const [x, y, width, height] = nums
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null
}
export function parsePngSize(buf: Buffer): ImageSize | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
  return w > 0 && h > 0 ? { w, h } : null
}
export function cropBox(box: CropBox, size: ImageSize): CropBox {
  const left = Math.max(0, Math.min(size.w - 1, Math.round(box.left)))
  const top = Math.max(0, Math.min(size.h - 1, Math.round(box.top)))
  return { left, top, width: Math.max(1, Math.min(size.w - left, Math.round(box.width))), height: Math.max(1, Math.min(size.h - top, Math.round(box.height))) }
}
