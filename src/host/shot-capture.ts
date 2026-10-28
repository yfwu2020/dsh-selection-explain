/** One capture task's pipeline. Geometry is pure; all machine operations use a typed port. */
import { join } from 'node:path'
import type { ShotPlatform, ShotOptions, ShotPending, ShotRect, DisplayInfo, WinInfo, CropBox } from './shot-types.js'
import { CAPTURE, MAX_MARGIN_PT, SELECT_TIMEOUT_MS } from './shot-types.js'
import { pickDisplay, pickWindow, clampRect, cropBox, friendlyCaptureError } from './shot-geometry.js'

export class ShotCaptureError extends Error {
  constructor(readonly code: string, message: string, readonly startup = false) { super(message) }
}
export interface CaptureResult { shot: ShotPending; note: string }

export async function captureShot(platform: ShotPlatform, options: ShotOptions, dir: string, signal: AbortSignal, knownRect?: ShotRect): Promise<CaptureResult | null> {
  const active = () => signal.throwIfAborted()
  async function checked<T>(promise: Promise<T>): Promise<T> { const value = await promise; active(); return value }
  const ensureTmpDir = async () => { active(); return dir }
  const run = async (command: string, args: string[], timeout?: number) => {
    active()
    const result = await checked(platform.run(command, args, signal, timeout))
    return result.failed ? '' : result.stdout
  }
  const listDisplays = () => checked(platform.listDisplays(signal))
  const listWindows = () => checked(platform.listWindows(signal))
  const probeAvailable = () => checked(platform.probeAvailable(signal))
  const pngSize = (file: string) => checked(platform.pngSize(file))
  const rectFromXattr = (file: string) => checked(platform.rectFromXattr(file, signal))
  // Prefetch belongs to this task, so a late probe cannot contaminate another capture.
  let prefetchedWindows: Promise<WinInfo[]> | undefined = options.scope === 'window' ? listWindows() : undefined
  let prefetchedDisplays: Promise<DisplayInfo[]> | undefined = options.scope !== 'selection' || knownRect ? listDisplays() : undefined
  // These may finish after an interactive cancellation; consume rejections immediately.
  void prefetchedWindows?.catch(() => {})
  void prefetchedDisplays?.catch(() => {})
  interface CapturedDisplay {
    path: string
    size: { w: number; h: number }
    scale: number
  }

  /**
   * 截一整块显示器（`screencapture -D`）。
   *
   * 为什么不用 `-R`：副屏在主屏左边时坐标是负的，`screencapture -R` 直接
   * "could not create image from rect"；屏幕锁定时 `-R` 也会失败，而 `-D` 仍然可用。
   * 所以统一按显示器截，再用 sips 裁到需要的矩形。
   */
  async function captureDisplay(
    display: DisplayInfo,
    options: ShotOptions,
    fileName: string,
  ): Promise<CapturedDisplay | null> {
    const dir = await ensureTmpDir()
    const path = join(dir, fileName)
    const index = display.index > 0 ? display.index : display.main ? 1 : 2
    await run(CAPTURE, ['-x', '-D', String(index), path])
    const size = await pngSize(path)
    if (!size || display.w <= 0 || display.h <= 0) {
      await platform.remove(path)
      return null
    }
    // 截错屏时宽高比通常对不上：宁可退回选区，也不要把红框画到一张不相干的图上
    const expected = display.w / display.h
    const actual = size.w / size.h
    if (Math.abs(actual - expected) > expected * 0.02) {
      await platform.remove(path)
      return null
    }
    return { path, size, scale: size.w / display.w }
  }

  /** 把显示器图按像素矩形裁出来（sips 的 --cropOffset 是 top left）。 */
  async function cropPng(
    source: string,
    box: CropBox,
    size: { w: number; h: number },
    out: string,
  ): Promise<CropBox | null> {
    const { left, top, width, height } = cropBox(box, size)
    await run(
      '/usr/bin/sips',
      ['-c', String(height), String(width), '--cropOffset', String(top), String(left), source, '--out', out],
      20_000,
    )
    const cropped = await pngSize(out)
    return cropped ? { left, top, width: cropped.w, height: cropped.h } : null
  }

  /** 截一块选区本身（没有 region 文件时的兜底 / 自动化测试用）。 */
  async function captureSelectionToFile(
    selection: ShotRect,
    options: ShotOptions,
    fileName: string,
  ): Promise<{ path: string; size: { w: number; h: number }; scale: number } | null> {
    const displays = await (prefetchedDisplays ?? listDisplays())
    prefetchedDisplays = undefined
    const display = pickDisplay(displays, selection)
    if (!display) return null
    const dir = await ensureTmpDir()
    const captured = await captureDisplay(display, options, `display-${options.seq}.png`)
    if (!captured) return null
    const box = {
      left: (selection.x - display.x) * captured.scale,
      top: (selection.y - display.y) * captured.scale,
      width: selection.width * captured.scale,
      height: selection.height * captured.scale,
    }
    const path = join(dir, fileName)
    const crop = await cropPng(captured.path, box, captured.size, path)
    await platform.remove(captured.path)
    if (!crop) return null
    return { path, size: { w: crop.width, h: crop.height }, scale: captured.scale }
  }

  /**
   * 仅选区：框选落下的 region 文件**就是**最终图。
   *
   * 不需要窗口列表、不需要 xattr、不需要第二次截图；客户端也不用画布。
   */
  async function finishSelection(
    regionFile: string,
    selection: ShotRect | null,
    options: ShotOptions,
    note = '',
  ): Promise<CaptureResult> {
    const size = await pngSize(regionFile)
    if (!size) {
      throw new ShotCaptureError('image-missing', '截图已经拍下，但读不到图片文件，请重试')
    }
    const sel = selection || { x: 0, y: 0, width: size.w, height: size.h }
    const scale = sel.width > 0 ? size.w / sel.width : 1
    const shot: ShotPending = {
      id: `shot-${options.seq}`,
      at: Date.now(),
      scope: 'selection',
      mode: options.mode,
      frame: false,
      imagePath: regionFile,
      rect: { x: 0, y: 0, width: size.w, height: size.h },
      windowRect: sel,
      selectionRect: sel,
      scale,
      pad: { x: 0, y: 0 },
      owner: '',
      ready: true,
    }
    return { shot, note }
  }

  /** 回退到「仅选区」：有 region 就用它，没有就现截一块。 */
  async function fallbackSelection(
    selection: ShotRect,
    options: ShotOptions,
    regionFile: string | null,
    note: string,
  ): Promise<CaptureResult> {
    if (regionFile) return finishSelection(regionFile, selection, options, note)
    const captured = await captureSelectionToFile(selection, options, `region-${options.seq}.png`)
    if (captured) return finishSelection(captured.path, selection, options, note)
    throw new ShotCaptureError(note || 'selection-failed', '截图已拍下，但读取图片失败，请重试')
  }

  /** 选区 + 留白：外扩后裁到选区中心所在的那块屏，再从整屏图里裁出来。 */
  async function finishMargin(
    selection: ShotRect,
    options: ShotOptions,
    regionFile: string | null,
    note = '',
  ): Promise<CaptureResult> {
    const margin = Math.max(0, Math.min(MAX_MARGIN_PT, Math.round(options.margin)))
    if (margin <= 0) return fallbackSelection(selection, options, regionFile, note)

    let expanded: ShotRect = {
      x: selection.x - margin,
      y: selection.y - margin,
      width: selection.width + margin * 2,
      height: selection.height + margin * 2,
    }
    const displays = await (prefetchedDisplays ?? listDisplays())
    prefetchedDisplays = undefined
    const display = pickDisplay(displays, selection)
    if (!display) return fallbackSelection(selection, options, regionFile, note || 'no-display')
    expanded = clampRect(expanded, display)
    if (expanded.width < 2 || expanded.height < 2) {
      return fallbackSelection(selection, options, regionFile, note || 'margin-clipped')
    }

    const captured = await captureDisplay(display, options, `display-${options.seq}.png`)
    if (!captured) {
      return fallbackSelection(selection, options, regionFile, note || 'margin-capture-failed')
    }
    const scale = captured.scale
    const dir = await ensureTmpDir()
    const imagePath = join(dir, `shot-${options.seq}.png`)
    const crop = await cropPng(
      captured.path,
      {
        left: (expanded.x - display.x) * scale,
        top: (expanded.y - display.y) * scale,
        width: expanded.width * scale,
        height: expanded.height * scale,
      },
      captured.size,
      imagePath,
    )
    await platform.remove(captured.path)
    if (!crop) {
      return fallbackSelection(selection, options, regionFile, note || 'margin-crop-failed')
    }

    const shot: ShotPending = {
      id: `shot-${options.seq}`,
      at: Date.now(),
      scope: 'margin',
      mode: options.mode,
      frame: true,
      imagePath,
      rect: {
        // 用裁切后的实际像素原点，避免 sips 取整带来的 1px 偏移
        x: Math.round((selection.x - display.x) * scale) - crop.left,
        y: Math.round((selection.y - display.y) * scale) - crop.top,
        width: Math.round(selection.width * scale),
        height: Math.round(selection.height * scale),
      },
      windowRect: expanded,
      selectionRect: selection,
      scale,
      pad: { x: 0, y: 0 },
      owner: '',
      ready: true,
    }
    return { shot, note }
  }

  /** 全屏：选区中心所在的那块显示器整屏截下来。 */
  async function finishScreen(
    selection: ShotRect,
    options: ShotOptions,
    regionFile: string | null,
  ): Promise<CaptureResult> {
    const displays = await (prefetchedDisplays ?? listDisplays())
    prefetchedDisplays = undefined
    const display = pickDisplay(displays, selection)
    if (!display) {
      return finishMargin(selection, options, regionFile, 'no-display')
    }

    const captured = await captureDisplay(display, options, `shot-${options.seq}.png`)
    if (!captured) {
      return finishMargin(selection, options, regionFile, 'screen-capture-failed')
    }
    const scale = captured.scale
    const shot: ShotPending = {
      id: `shot-${options.seq}`,
      at: Date.now(),
      scope: 'screen',
      mode: options.mode,
      frame: true,
      imagePath: captured.path,
      rect: {
        x: Math.round((selection.x - display.x) * scale),
        y: Math.round((selection.y - display.y) * scale),
        width: Math.round(selection.width * scale),
        height: Math.round(selection.height * scale),
      },
      windowRect: { x: display.x, y: display.y, width: display.w, height: display.h },
      selectionRect: selection,
      scale,
      pad: { x: 0, y: 0 },
      owner: '',
      ready: true,
    }
    return { shot, note: '' }
  }

  /** 整窗：找窗口、整窗截图；找不到或探针缺失时退到「选区 + 留白」。 */
  async function finishWindow(
    regionFile: string,
    selection: ShotRect,
    options: ShotOptions,
  ): Promise<CaptureResult> {
    if (!(await probeAvailable())) {
      return finishMargin(selection, options, regionFile, 'probe-missing')
    }

    const wins = await (prefetchedWindows ?? listWindows())
    prefetchedWindows = undefined
    const win = pickWindow(wins, selection)
    if (!win) {
      return finishMargin(selection, options, regionFile, 'no-window')
    }

    const dir = await ensureTmpDir()
    const imagePath = join(dir, `shot-${options.seq}.png`)
    // ⚠️ 不要加 `-o`：文档说它"不截窗口阴影"，实测**反过来** ——
    // 加了是 3840×2224（多 64px 阴影），不加才是 3840×2160（正好窗口的 2 倍）。
    // 阴影上下不对称，按对半分会让红框整体偏（用户实测：向上偏移）。
    await run(CAPTURE, ['-l', String(win.id), '-x', imagePath])
    const size = await pngSize(imagePath)
    if (!size) {
      return finishMargin(selection, options, regionFile, 'window-capture-failed')
    }

    const scale = win.w > 0 ? size.w / win.w : 2
    const windowRect: ShotRect = { x: win.x, y: win.y, width: win.w, height: win.h }
    // 正常情况 size 应当正好等于窗口的倍数（pad=0）；万一系统还是带了阴影，
    // 就按"多出来的两半分"兜底 —— 客户端的 alpha 内容区探测会再校正一次。
    const pad = {
      x: Math.max(0, Math.round((size.w - win.w * scale) / 2)),
      y: Math.max(0, Math.round((size.h - win.h * scale) / 2)),
    }
    const shot: ShotPending = {
      id: `shot-${options.seq}`,
      at: Date.now(),
      scope: 'window',
      mode: options.mode,
      frame: true,
      imagePath,
      rect: {
        x: Math.round(pad.x + (selection.x - windowRect.x) * scale),
        y: Math.round(pad.y + (selection.y - windowRect.y) * scale),
        width: Math.round(selection.width * scale),
        height: Math.round(selection.height * scale),
      },
      windowRect,
      selectionRect: selection,
      scale,
      pad,
      owner: win.owner,
      ready: true,
    }
    return { shot, note: '' }
  }

  /**
   * 用户松手后的分派。
   *
   * 顺序仍然刻意：**先出图，后发事件**。UI 一旦画出来，`screencapture` 就会把它截进去
   * （框、卡片都算页面内容）。仅选区的图在框选时就已经落好了，没有这个顾虑。
   */
  async function finishInteractive(
    regionFile: string,
    options: ShotOptions,
    knownRect?: ShotRect,
  ): Promise<CaptureResult> {
    let selection = knownRect || null
    if (!selection && options.scope !== 'selection') {
      selection = await rectFromXattr(regionFile)
    }
    if (options.scope === 'selection') {
      const rect = selection || (await rectFromXattr(regionFile))
      return finishSelection(regionFile, rect, options)
    }
    if (!selection) {
      return finishSelection(regionFile, null, options, 'no-rect')
    }
    switch (options.scope) {
      case 'margin':
        return finishMargin(selection, options, regionFile)
      case 'screen':
        return finishScreen(selection, options, regionFile)
      case 'window':
      default:
        return finishWindow(regionFile, selection, options)
    }
  }


  active()
  if (knownRect) {
    const captured = await captureSelectionToFile(knownRect, options, `region-${options.seq}.png`)
    if (!captured) throw new ShotCaptureError('capture-failed', '截图已拍下，但读取图片失败，请重试', true)
    return finishInteractive(captured.path, options, knownRect)
  }
  const regionFile = join(dir, `region-${options.seq}.png`)
  const result = await checked(platform.run(CAPTURE, ['-i', '-x', regionFile], signal, SELECT_TIMEOUT_MS))
  if (await checked(platform.fileExists(regionFile))) return finishInteractive(regionFile, options)
  if (result.timedOut || result.signal === 'SIGTERM') throw new ShotCaptureError('timeout', '框选超时，已取消这次截图')
  if (result.code === null && result.failed) throw new ShotCaptureError('spawn-failed', '无法启动系统截图命令（screencapture）')
  if (result.failed || result.stderr.trim()) throw new ShotCaptureError('capture-failed', friendlyCaptureError(result.stderr, result.code))
  return null // Exit 0 without a file is the user's Escape key, not an error.
}
