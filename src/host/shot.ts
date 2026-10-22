/**
 * 截图提问：host 侧管线。
 *
 * 触发方式：**DSH 自己的快捷键**（客户端 `ctx.shortcuts` 注册 ⌘⇧X）打一个 `POST /shot/start`。
 * 所以这里不监听任何东西 —— 没有目录监视、没有系统通知、没有轮询文件。
 *
 * 一次截图的生命周期（按取景范围分流）：
 *   ① `screencapture -i -x <region>`：系统十字准星，用户框完**命令即退出** —— 精确的完成信号；
 *   ② 从这张图的扩展属性里读框的矩形（`kMDItemScreenCaptureGlobalRect`，全局点坐标）；
 *   ③ 按设置里的 `scope` 决定最终发给模型的图：
 *        selection → region 文件本身就是最终图（零额外截图）
 *        margin    → 选区向四周外扩 N pt，裁到选区中心所在的那块屏，再截一次
 *        window    → 查窗口列表，整窗截下来（`screencapture -l`），客户端量内容区校正红框
 *        screen    → 选区中心所在的那块屏整屏截下来
 *   ④ 算出选区在最终图里的相对位置，交给客户端去画红框（画图交给浏览器 canvas，
 *      host 不需要任何图像库）。仅选区不画框，图就是选区。
 *
 * 为什么红色框在客户端画：附件服务最终会把图规范化（长边 2048）。如果 host 先画再压，
 * 框线会跟着被缩放；客户端在**原图**上画、再上传，框线粗细和位置都准。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { readFile, mkdir, rm, stat, chmod, readdir } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendJson, readBody } from './http.js'
import type { Config } from './config.js'

/** 截图二进制（系统自带）。 */
const CAPTURE = '/usr/sbin/screencapture'

/** 交互式框选 + 整窗截图的总超时：用户可能慢慢框，给足 90 秒。 */
const SELECT_TIMEOUT_MS = 90_000

/** 窗口列表探针（随包编译，见 native/window-list.c）。 */
export function resolveWindowProbe(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // lib/host/shot.js → lib/native/window-list
  return join(here, '..', 'native', 'window-list')
}

/** 取景范围，从大到小：全屏 → 整窗 → 选区 + 留白 → 仅选区。 */
export type ShotScope = 'screen' | 'window' | 'margin' | 'selection'
/** 触发时小窗是开着（直接进输入框）还是没开（弹语音卡）。 */
export type ShotMode = 'card' | 'panel'

const SHOT_SCOPES: ShotScope[] = ['screen', 'window', 'margin', 'selection']

/** 超出这个尺寸的选区留白没有意义，且会把截图撑得很大。 */
const MAX_MARGIN_PT = 400

/** 只保留最近几张临时图：客户端取图后就不需要旧文件了，但留几张给重试 / 诊断。 */
const KEEP_SHOTS = 3

export interface ShotRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ShotPending {
  id: string
  at: number
  /** 这次用的取景范围 / 触发模式（客户端据此决定画不画框、走卡片还是附件）。 */
  scope: ShotScope
  mode: ShotMode
  /** 图里要不要画红框（选区之外还有内容时为 true；仅选区恒为 false）。 */
  frame: boolean
  /** 最终图的文件名（落在临时目录，按 shot 序号独立命名）。 */
  imagePath: string
  /** 选区在**这张图里**的位置（像素坐标，可以直接拿去画框）。 */
  rect: ShotRect
  /** 截图覆盖的范围（点）：整窗 / 外扩后的选区 / 整屏；仅选区时就是选区本身。 */
  windowRect: ShotRect
  /** 选区在屏幕上的位置（点）。 */
  selectionRect: ShotRect
  /** 截图像素与点的比例（Retina 一般是 2）。 */
  scale: number
  /** 窗口截图四周的留白（像素）—— `screencapture -l` 会连窗口阴影一起截进来，
   *  内容不是从 (0,0) 开始的，必须把这段留白算进红框位置。 */
  pad: { x: number; y: number }
  /** 所属窗口的名字（调试用）。 */
  owner: string
  /** 整窗截图是否已经做好（`/shot/image` 会等它；客户端拿到事件就能先画框）。 */
  ready: boolean
}

interface ShotState {
  available: boolean
  reason: string
  /** 正在等用户框选。 */
  capturing: boolean
  /** 最近一次结果（客户端取走即清）。 */
  pending: ShotPending | null
  /** 最近一次结果的**副本**：图像端点在 pending 被取走之后仍要能按 id 找到图。 */
  lastShot: ShotPending | null
  /** 上一次失败原因（调试）。 */
  lastError: string
  /** 累计成功次数（调试）。 */
  total: number
}

const state: ShotState = {
  available: false,
  reason: 'idle',
  capturing: false,
  pending: null,
  lastShot: null,
  lastError: '',
  total: 0,
}

/** 长轮询的等待者。 */
const waiters: Array<(shot: ShotPending | null) => void> = []

/** 每次截图递增；临时文件名与事件 id 都用它，避免第二张图覆盖第一张。 */
let seq = 0

/** 窗口列表探针是否可用（懒探测一次）。截图范围不依赖它时不会被它拦住。 */
let probeChecked = false
let probeReady = false

/** 框选期间预热的窗口列表 / 显示器列表：松手时就不用再等这几十毫秒。 */
let prefetchedWindows: WinInfo[] | null = null
let prefetchedDisplays: DisplayInfo[] | null = null

function tmpDir(): string {
  return join(tmpdir(), 'dsh-selection-explain')
}

/** 临时目录只给当前用户读写：截图里可能有敏感内容。 */
async function ensureTmpDir(): Promise<string> {
  const dir = tmpDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
  return dir
}

function run(cmd: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''))
    })
  })
}

/** 平台是否受支持（目前只做 macOS：整窗截图与矩形都依赖它）。 */
export function shotSupported(): boolean {
  return platform() === 'darwin'
}

/** 平台可用性（不影响窗口探针的结论）。 */
function ensureCaptureAvailable(): boolean {
  const ok = shotSupported()
  state.available = ok
  state.reason = ok ? 'ok' : 'not-macos'
  return ok
}

/** 探针在不在（编不出来就只在「整窗」这一档降级，不影响选区/留白/全屏）。 */
async function probeAvailable(): Promise<boolean> {
  if (probeChecked) return probeReady
  probeChecked = true
  if (!shotSupported()) {
    probeReady = false
    return false
  }
  const probe = resolveWindowProbe()
  probeReady = await stat(probe).then((s) => s.size > 0).catch(() => false)
  return probeReady
}

interface WinInfo {
  id: number
  x: number
  y: number
  w: number
  h: number
  layer: number
  owner: string
}

interface DisplayInfo {
  id: number
  x: number
  y: number
  w: number
  h: number
  /** `screencapture -D` 的编号（1 = 主显示器）。 */
  index: number
  main: boolean
}

async function listWindows(): Promise<WinInfo[]> {
  const raw = await run(resolveWindowProbe(), [])
  if (!raw.trim()) return []
  try {
    const arr = JSON.parse(raw) as WinInfo[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 活跃显示器的全局矩形（点）与像素尺寸。 */
async function listDisplays(): Promise<DisplayInfo[]> {
  const raw = await run(resolveWindowProbe(), ['--displays'])
  if (!raw.trim()) return []
  try {
    const arr = JSON.parse(raw) as Array<Partial<DisplayInfo>>
    return Array.isArray(arr)
      ? arr
          .filter((item) => Number.isFinite(item?.x) && Number.isFinite(item?.y) && Number.isFinite(item?.w) && Number.isFinite(item?.h))
          .map((item) => ({
            id: Number(item.id) || 0,
            x: Number(item.x),
            y: Number(item.y),
            w: Number(item.w),
            h: Number(item.h),
            index: Number(item.index) || 0,
            main: item.main === true || Number(item.main) === 1,
          }))
      : []
  } catch {
    return []
  }
}

function intersectArea(a: ShotRect, b: { x: number; y: number; w: number; h: number }): number {
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
function pickDisplay(displays: DisplayInfo[], rect: ShotRect): DisplayInfo | null {
  if (displays.length === 0) return null
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const hits = displays.filter((d) => cx >= d.x && cx <= d.x + d.w && cy >= d.y && cy <= d.y + d.h)
  if (hits.length > 0) return hits[0]
  const sorted = displays.slice().sort((a, b) => intersectArea(rect, b) - intersectArea(rect, a))
  return sorted[0] || displays.find((d) => d.main) || null
}

function clampRect(rect: ShotRect, box: { x: number; y: number; w: number; h: number }): ShotRect {
  const left = Math.max(rect.x, box.x)
  const top = Math.max(rect.y, box.y)
  const right = Math.min(rect.x + rect.width, box.x + box.w)
  const bottom = Math.min(rect.y + rect.height, box.y + box.h)
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/**
 * 读截图文件自带的矩形（全局点），`kMDItemScreenCaptureGlobalRect`。
 *
 * ⚠️ 这是 **binary plist**，不能"按顺序读 4 个 double"：
 * plist 会**去重相同的值** —— 比如一次 300×200 的框选，x=300、w=300、y=200、h=200，
 * 库里只存两个 double，数组的四个引用指向它们；按顺序读就会读到 [300,200] 然后跑偏。
 * （实测：正因为这个，有些框准、有些框飘，取决于四个数有没有重复。）
 *
 * 所以这里按 plist 结构解：trailer → 偏移表 → 对象表 → 数组引用 → 每个值。
 */
function parseRectPlist(buf: Buffer): number[] | null {
  if (buf.length < 40 || buf.toString('latin1', 0, 6) !== 'bplist') return null
  const trailer = buf.subarray(buf.length - 32)
  const offsetSize = trailer[6]
  const refSize = trailer[7]
  const numObjects = Number(trailer.readBigUInt64BE(8))
  const topObject = Number(trailer.readBigUInt64BE(16))
  const tableOffset = Number(trailer.readBigUInt64BE(24))
  if (!numObjects || offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) return null
  if (tableOffset + numObjects * offsetSize > buf.length) return null

  const readSized = (at: number, size: number): number => {
    let value = 0
    for (let i = 0; i < size; i += 1) value = value * 256 + buf[at + i]
    return value
  }
  const objectAt = (index: number): number => {
    if (index >= numObjects) return -1
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
      if (size > 8) return null
      let value = 0
      for (let i = 0; i < size; i += 1) value = value * 256 + buf[at + 1 + i]
      return value
    }
    if (kind === 0x2) {
      // real（0x22 float32 / 0x23 float64）
      if (sizeBits === 2) return buf.readFloatBE(at + 1)
      if (sizeBits === 3) return buf.readDoubleBE(at + 1)
    }
    return null
  }

  const arrayAt = objectAt(topObject)
  if (arrayAt < 0) return null
  const marker = buf[arrayAt]
  if (marker >> 4 !== 0xa) return null
  let count = marker & 0x0f
  let refsAt = arrayAt + 1
  if (count === 0x0f) {
    // 长数组：后面跟一个 int 表示数量
    const intMarker = buf[refsAt]
    const size = 1 << (intMarker & 0x0f)
    let value = 0
    for (let i = 0; i < size; i += 1) value = value * 256 + buf[refsAt + 1 + i]
    count = value
    refsAt += 1 + size
  }
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    const ref = readSized(refsAt + i * refSize, refSize)
    const value = readNumber(objectAt(ref))
    if (value === null) return null
    out.push(value)
  }
  return out
}

/** 从截图文件的扩展属性里读矩形（点）。 */
async function rectFromXattr(file: string): Promise<ShotRect | null> {
  const hex = (
    await run('/usr/bin/xattr', ['-px', 'com.apple.metadata:kMDItemScreenCaptureGlobalRect', file])
  ).replace(/\s+/g, '')
  if (!hex || hex.length % 2 !== 0) return null
  let buf: Buffer
  try {
    buf = Buffer.from(hex, 'hex')
  } catch {
    return null
  }
  const nums = parseRectPlist(buf)
  if (!nums || nums.length < 4) return null
  const [x, y, w, h] = nums
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null
  return { x, y, width: w, height: h }
}

/** 一张图的像素尺寸（不引图像库：读 PNG 的 IHDR 就够）。 */
async function pngSize(file: string): Promise<{ w: number; h: number } | null> {
  try {
    const buf = await readFile(file)
    if (buf.length < 24) return null
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    if (!isPng) return null
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  } catch {
    return null
  }
}

function contains(win: WinInfo, rect: ShotRect): boolean {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return cx >= win.x && cx <= win.x + win.w && cy >= win.y && cy <= win.y + win.h
}

function area(win: WinInfo): number {
  return win.w * win.h
}

/**
 * 选"你框的那块属于哪个窗口"。
 *
 * 规则：layer 0（普通应用窗口）里，**包含选区中心**的那些，取面积最小的 ——
 * 这样点在一个大窗口里的小对话框上，裁的是对话框而不是整个背景窗口。
 */
function pickWindow(wins: WinInfo[], rect: ShotRect): WinInfo | null {
  const candidates = wins
    .filter((w) => w.layer === 0 && contains(w, rect))
    .sort((a, b) => area(a) - area(b))
  return candidates[0] || null
}

interface CropBox {
  left: number
  top: number
  width: number
  height: number
}

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
    await rm(path, { force: true }).catch(() => {})
    return null
  }
  // 截错屏时宽高比通常对不上：宁可退回选区，也不要把红框画到一张不相干的图上
  const expected = display.w / display.h
  const actual = size.w / size.h
  if (Math.abs(actual - expected) > expected * 0.02) {
    await rm(path, { force: true }).catch(() => {})
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
  const left = Math.max(0, Math.min(size.w - 1, Math.round(box.left)))
  const top = Math.max(0, Math.min(size.h - 1, Math.round(box.top)))
  const width = Math.max(1, Math.min(size.w - left, Math.round(box.width)))
  const height = Math.max(1, Math.min(size.h - top, Math.round(box.height)))
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
  const displays = prefetchedDisplays || (await listDisplays())
  prefetchedDisplays = null
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
  await rm(captured.path, { force: true }).catch(() => {})
  if (!crop) return null
  return { path, size: { w: crop.width, h: crop.height }, scale: captured.scale }
}

async function publish(shot: ShotPending, shotSeq: number, note = ''): Promise<void> {
  state.total += 1
  state.lastError = note
  state.pending = shot
  state.lastShot = shot
  state.capturing = false
  while (waiters.length > 0) {
    const fn = waiters.shift()
    if (fn) fn(shot)
  }
  // 旧图已经没用了：客户端取图后就不再回头，保留最近几张只为重试与诊断
  void pruneShots(shotSeq)
}

/** 删除 seq 之前的旧临时图（只删本插件自己的命名，不动目录里的其它东西）。 */
async function pruneShots(currentSeq: number): Promise<void> {
  try {
    const dir = tmpDir()
    const names = await readdir(dir)
    for (const name of names) {
      const match = /^(?:region|shot|display)-(\d+)\.png$/.exec(name)
      if (!match) continue
      if (Number(match[1]) <= currentSeq - KEEP_SHOTS) {
        await rm(join(dir, name), { force: true }).catch(() => {})
      }
    }
  } catch {
    /* 清不掉不影响功能 */
  }
}

interface ShotOptions {
  seq: number
  mode: ShotMode
  scope: ShotScope
  margin: number
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
): Promise<void> {
  const size = await pngSize(regionFile)
  if (!size) {
    state.lastError = 'image-missing'
    state.capturing = false
    return
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
  await publish(shot, options.seq, note)
}

/** 回退到「仅选区」：有 region 就用它，没有就现截一块。 */
async function fallbackSelection(
  selection: ShotRect,
  options: ShotOptions,
  regionFile: string | null,
  note: string,
): Promise<void> {
  if (regionFile) return finishSelection(regionFile, selection, options, note)
  const captured = await captureSelectionToFile(selection, options, `region-${options.seq}.png`)
  if (captured) return finishSelection(captured.path, selection, options, note)
  state.lastError = note || 'selection-failed'
  state.capturing = false
}

/** 选区 + 留白：外扩后裁到选区中心所在的那块屏，再从整屏图里裁出来。 */
async function finishMargin(
  selection: ShotRect,
  options: ShotOptions,
  regionFile: string | null,
  note = '',
): Promise<void> {
  const margin = Math.max(0, Math.min(MAX_MARGIN_PT, Math.round(options.margin)))
  if (margin <= 0) return fallbackSelection(selection, options, regionFile, note)

  let expanded: ShotRect = {
    x: selection.x - margin,
    y: selection.y - margin,
    width: selection.width + margin * 2,
    height: selection.height + margin * 2,
  }
  const displays = prefetchedDisplays || (await listDisplays())
  prefetchedDisplays = null
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
  await rm(captured.path, { force: true }).catch(() => {})
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
  await publish(shot, options.seq, note)
}

/** 全屏：选区中心所在的那块显示器整屏截下来。 */
async function finishScreen(
  selection: ShotRect,
  options: ShotOptions,
  regionFile: string | null,
): Promise<void> {
  const displays = prefetchedDisplays || (await listDisplays())
  prefetchedDisplays = null
  const display = pickDisplay(displays, selection)
  if (!display) {
    state.lastError = 'no-display'
    return finishMargin(selection, options, regionFile, 'no-display')
  }

  const captured = await captureDisplay(display, options, `shot-${options.seq}.png`)
  if (!captured) {
    state.lastError = 'screen-capture-failed'
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
  await publish(shot, options.seq)
}

/** 整窗：找窗口、整窗截图；找不到或探针缺失时退到「选区 + 留白」。 */
async function finishWindow(
  regionFile: string,
  selection: ShotRect,
  options: ShotOptions,
): Promise<void> {
  if (!(await probeAvailable())) {
    state.lastError = 'probe-missing'
    return finishMargin(selection, options, regionFile, 'probe-missing')
  }

  const wins = prefetchedWindows || (await listWindows())
  prefetchedWindows = null
  const win = pickWindow(wins, selection)
  if (!win) {
    state.lastError = 'no-window'
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
    state.lastError = 'window-capture-failed'
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
  await publish(shot, options.seq)
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
): Promise<void> {
  let selection = knownRect || null
  if (!selection && options.scope !== 'selection') {
    selection = await rectFromXattr(regionFile)
  }
  if (options.scope === 'selection') {
    const rect = selection || (await rectFromXattr(regionFile))
    return finishSelection(regionFile, rect, options)
  }
  if (!selection) {
    state.lastError = 'no-rect'
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

/** 起一次交互式框选。 */
async function startInteractive(options: Omit<ShotOptions, 'seq'>): Promise<boolean> {
  if (!ensureCaptureAvailable()) return false
  if (state.capturing) return false
  state.capturing = true
  const shotSeq = ++seq
  const opts: ShotOptions = { ...options, seq: shotSeq }
  let dir: string
  try {
    dir = await ensureTmpDir()
  } catch (error) {
    state.lastError = `tmp-failed: ${String((error as Error)?.message ?? error)}`
    state.capturing = false
    return false
  }
  const regionFile = join(dir, `region-${shotSeq}.png`)
  await rm(regionFile, { force: true }).catch(() => {})

  // 和框选并行：用户拖框那一两秒里，窗口 / 显示器列表早就拿好了
  prefetchedWindows = null
  prefetchedDisplays = null
  if (opts.scope === 'window') {
    void listWindows()
      .then((wins) => {
        prefetchedWindows = wins
      })
      .catch(() => {})
  }
  if (opts.scope !== 'selection') {
    void listDisplays()
      .then((displays) => {
        prefetchedDisplays = displays
      })
      .catch(() => {})
  }

  const child = spawn(CAPTURE, ['-i', '-x', regionFile], { stdio: 'ignore' })
  const timer = setTimeout(() => {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }, SELECT_TIMEOUT_MS)

  child.on('error', () => {
    clearTimeout(timer)
    state.capturing = false
    state.lastError = 'spawn-failed'
  })
  child.on('close', () => {
    clearTimeout(timer)
    // 退出码非 0 / 没有文件 = 用户按了 Esc 取消
    void stat(regionFile)
      .then((s) => (s.size > 0 ? finishInteractive(regionFile, opts) : Promise.resolve()))
      .then(() => {
        state.capturing = false
        prefetchedWindows = null
        prefetchedDisplays = null
      })
      .catch(() => {
        state.capturing = false
      })
  })
  return true
}

/** 开发/自动化用：跳过交互式框选，直接按给定矩形截一块再走同一条收尾流程。 */
async function startWithRect(rect: ShotRect, options: Omit<ShotOptions, 'seq'>): Promise<boolean> {
  if (!ensureCaptureAvailable()) return false
  if (state.capturing) return false
  state.capturing = true
  const shotSeq = ++seq
  const opts: ShotOptions = { ...options, seq: shotSeq }
  // 自动化路径也用"整屏 + 裁切"，与真实框选走出同一套坐标：不再依赖 `-R`
  const captured = await captureSelectionToFile(rect, opts, `region-${shotSeq}.png`)
  if (!captured) {
    state.capturing = false
    state.lastError = 'capture-failed'
    return false
  }
  await finishInteractive(captured.path, opts, rect)
  state.capturing = false
  return true
}

const DEFAULT_SHOT_CONFIG: Pick<Config, 'shotCardScope' | 'shotPanelScope' | 'shotMargin'> = {
  shotCardScope: 'window',
  shotPanelScope: 'selection',
  shotMargin: 48,
}

function resolveOptions(
  config: Pick<Config, 'shotCardScope' | 'shotPanelScope' | 'shotMargin'>,
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

/** `POST /api/shot/start` —— 开始一次截图（可带 `?rect=x,y,w,h&scope=…` 供测试）。 */
export async function handleShotStart(
  req: IncomingMessage,
  res: ServerResponse,
  config: Pick<Config, 'shotCardScope' | 'shotPanelScope' | 'shotMargin'> = DEFAULT_SHOT_CONFIG,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
    return
  }
  const url = new URL(req.url || '/', 'http://localhost')
  const rectParam = url.searchParams.get('rect')
  const mode: ShotMode = url.searchParams.get('mode') === 'panel' ? 'panel' : 'card'
  try {
    await readBody(req, 64 * 1024).catch(() => '')
  } catch {
    /* 没有 body 也无所谓 */
  }
  if (!ensureCaptureAvailable()) {
    sendJson(res, 200, { ok: false, reason: state.reason })
    return
  }
  if (state.capturing) {
    sendJson(res, 200, { ok: false, reason: 'busy' })
    return
  }
  const options = resolveOptions(config, mode, url)
  if (rectParam) {
    const n = rectParam.split(',').map(Number)
    if (n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0) {
      const started = await startWithRect({ x: n[0], y: n[1], width: n[2], height: n[3] }, options)
      sendJson(res, 200, { ok: started, test: true, mode, scope: options.scope, margin: options.margin })
      return
    }
  }
  const started = await startInteractive(options)
  sendJson(res, 200, { ok: started, mode, scope: options.scope, margin: options.margin })
}

/** `GET /api/shot/pending` —— 长轮询，等下一次截图结果（最多 25 秒）。 */
export function handleShotPending(_req: IncomingMessage, res: ServerResponse): void {
  const take = () => {
    const shot = state.pending
    state.pending = null
    return shot
  }
  if (state.pending) {
    sendJson(res, 200, { ok: true, shot: take(), status: shotStatus() })
    return
  }
  const timer = setTimeout(() => {
    const i = waiters.indexOf(done)
    if (i >= 0) waiters.splice(i, 1)
    sendJson(res, 200, { ok: true, shot: null, status: shotStatus() })
  }, 25_000)
  const done = () => {
    clearTimeout(timer)
    sendJson(res, 200, { ok: true, shot: take(), status: shotStatus() })
  }
  waiters.push(done)
}

/** `GET /api/shot/image?id=` —— 把图按字节回给客户端（不进 JSON，避免几 MB 的 base64）。 */
export async function handleShotImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const id = url.searchParams.get('id') || ''
  const shot =
    state.pending && state.pending.id === id
      ? state.pending
      : state.lastShot && state.lastShot.id === id
        ? state.lastShot
        : null
  if (!shot) {
    res.statusCode = 404
    res.end('shot-not-found')
    return
  }
  // 图已经落盘（ready 恒为 true）；保留这段等待是为了兼容"先发事件、后出图"的未来实现
  const deadline = Date.now() + 4000
  while (!shot.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!shot.ready) {
    res.statusCode = 404
    res.end('not-ready')
    return
  }
  try {
    const buf = await readFile(shot.imagePath)
    res.statusCode = 200
    res.setHeader('content-type', 'image/png')
    res.setHeader('cache-control', 'no-store')
    res.end(buf)
  } catch {
    res.statusCode = 500
    res.end('read-failed')
  }
}

/** 客户端加载时回报的自检结果（开发期用，只存内存）。 */
export let clientHello: unknown = null
/** 按 stage 保留最近一次上报：'geometry' 这种关键诊断不会被后面的 'uploaded' 覆盖。 */
export const clientReports: Record<string, unknown> = {}

export function handleShotHello(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    try {
      clientHello = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      const stage = (clientHello as { stage?: string } | null)?.stage
      if (stage) clientReports[stage] = clientHello
    } catch {
      clientHello = { parseError: true }
    }
    sendJson(res, 200, { ok: true })
  })
}

export function shotStatus(): { available: boolean; reason: string; capturing: boolean; total: number; lastError: string } {
  return {
    available: state.available,
    reason: state.reason,
    capturing: state.capturing,
    total: state.total,
    lastError: state.lastError,
  }
}

/** 插件卸载 / 热重载：把临时目录清掉（截图是临时的，没有留着的理由）。 */
export async function stopShot(): Promise<void> {
  try {
    await rm(tmpDir(), { recursive: true, force: true })
  } catch {
    /* 清不掉也不影响功能 */
  }
}

/** `GET /api/shot/status` —— 调试/自检。 */
export async function handleShotStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureCaptureAvailable()
  const probe = await probeAvailable()
  const last = state.lastShot
  sendJson(res, 200, {
    ok: true,
    status: shotStatus(),
    windowProbe: probe,
    clientHello,
    clientReports,
    // 只读观察点：不清 pending，用来量"事件发出 → 图做好"这一段
    lastShot: last
      ? {
          id: last.id,
          scope: last.scope,
          mode: last.mode,
          frame: last.frame,
          ready: last.ready,
          ageMs: Date.now() - last.at,
          owner: last.owner,
          rect: last.rect,
          pad: last.pad,
          scale: last.scale,
          selectionRect: last.selectionRect,
          windowRect: last.windowRect,
        }
      : null,
  })
}
