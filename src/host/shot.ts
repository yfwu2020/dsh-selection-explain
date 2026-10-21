/**
 * 截图提问：host 侧管线。
 *
 * 触发方式：**DSH 自己的快捷键**（客户端 `ctx.shortcuts` 注册 ⌘⇧X）打一个 `POST /shot/start`。
 * 所以这里不监听任何东西 —— 没有目录监视、没有系统通知、没有轮询文件。
 *
 * 一次截图的生命周期：
 *   ① `screencapture -i -x <region>`：系统十字准星，用户框完**命令即退出** —— 这就是精确的完成信号；
 *   ② 从这张图的扩展属性里读框的矩形（`kMDItemScreenCaptureGlobalRect`，全局点坐标）；
 *   ③ 查窗口列表，找到"你框的那块属于哪个窗口"，整窗截下来（`screencapture -l <id> -o`）；
 *   ④ 算出选区在**窗口图**里的相对位置，交给客户端去画红框（画图交给浏览器 canvas，
 *      host 不需要任何图像库）。
 *
 * 为什么整窗：用户要的是"模型既看得到细节，也看得到它在哪个界面里"，而且只要**一张图**。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { readFile, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendJson, readBody } from './http.js'

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

export interface ShotRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ShotPending {
  id: string
  at: number
  /** 整窗截图的文件名（落在临时目录，随下一次截图覆盖）。 */
  imagePath: string
  /** 选区在**这张图里**的位置（像素坐标，可以直接拿去画框）。 */
  rect: ShotRect
  /** 窗口在屏幕上的位置（点）。 */
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

let seq = 0
let probeChecked = false

function tmpDir(): string {
  return join(tmpdir(), 'dsh-selection-explain')
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

/** 探针在不在（编不出来就整体降级，不影响其它功能）。 */
async function probeAvailable(): Promise<boolean> {
  if (probeChecked) return state.available
  probeChecked = true
  if (!shotSupported()) {
    state.reason = 'not-macos'
    return false
  }
  const probe = resolveWindowProbe()
  const ok = await stat(probe).then((s) => s.size > 0).catch(() => false)
  state.available = ok
  state.reason = ok ? 'ok' : 'probe-missing'
  return ok
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

/** 读截图文件自带的矩形（全局点）。raw plist 里就是 4 个 double，按 0x23 标记抠出来。 */
async function rectFromXattr(file: string): Promise<ShotRect | null> {
  const hex = (await run('/usr/bin/xattr', ['-px', 'com.apple.metadata:kMDItemScreenCaptureGlobalRect', file]))
    .replace(/\s+/g, '')
  if (!hex || hex.length % 2 !== 0) return null
  let buf: Buffer
  try {
    buf = Buffer.from(hex, 'hex')
  } catch {
    return null
  }
  const nums: number[] = []
  for (let i = 0; i + 8 < buf.length; i += 1) {
    if ((buf[i] & 0xf0) === 0x20 && (buf[i] & 0x0f) === 3) {
      nums.push(buf.readDoubleBE(i + 1))
      i += 8
    }
  }
  if (nums.length < 4) return null
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

/** 收尾：从区域图推出整窗图与相对位置，塞进 pending 并叫醒客户端。 */
async function finish(regionFile: string): Promise<void> {
  const rect = await rectFromXattr(regionFile)
  if (!rect) {
    state.lastError = 'no-rect'
    state.capturing = false
    return
  }
  const wins = await listWindows()
  const win = pickWindow(wins, rect)
  const dir = tmpDir()
  const imagePath = join(dir, 'window.png')

  let windowRect: ShotRect = rect
  let scale = 1
  let owner = ''
  let pad = { x: 0, y: 0 }
  let imgW = 0
  let imgH = 0

  if (win) {
    // 整窗截图（-o 不要阴影：要的是窗口内容，红框才能和窗口坐标一一对应）
    await run(CAPTURE, ['-l', String(win.id), '-x', '-o', imagePath])
    const size = await pngSize(imagePath)
    const expectW = Math.round(win.w * 2)
    const expectH = Math.round(win.h * 2)
    const matched = size && Math.abs(size.w - expectW) <= 4 && Math.abs(size.h - expectH) <= 4
    if (size) {
      // `screencapture -l` 会把窗口阴影一起截进来（-o 也不一定去得干净）：
      // 尺寸比窗口大出来的那一圈，就是阴影留白 —— 必须算进去，否则红框整体偏移。
      scale = size.w / win.w
      windowRect = { x: win.x, y: win.y, width: win.w, height: win.h }
      owner = win.owner
      imgW = size.w
      imgH = size.h
      pad = {
        x: Math.max(0, Math.round((size.w - win.w * scale) / 2)),
        y: Math.max(0, Math.round((size.h - win.h * scale) / 2)),
      }
      if (!matched) state.lastError = `shadow-pad ${pad.x},${pad.y}`
    }
  }

  if (!owner) {
    // 没找到窗口：退化成"选区本身"这张图（不假装有上下文）
    await run('/bin/cp', [regionFile, imagePath])
    const size = await pngSize(imagePath)
    scale = size && rect.width > 0 ? size.w / rect.width : 2
    windowRect = rect
    imgW = size ? size.w : 0
    imgH = size ? size.h : 0
    pad = { x: 0, y: 0 }
    state.lastError = state.lastError || 'no-window'
  }

  seq += 1
  state.total += 1
  state.pending = {
    id: `shot-${seq}`,
    at: Date.now(),
    imagePath,
    // 选区在**图像像素**里的位置：客户端拿到就能直接 strokeRect
    rect: {
      x: Math.round(pad.x + (rect.x - windowRect.x) * scale),
      y: Math.round(pad.y + (rect.y - windowRect.y) * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    },
    pad,
    windowRect,
    selectionRect: rect,
    scale,
    owner,
  }
  state.lastShot = state.pending
  state.capturing = false
  while (waiters.length > 0) {
    const fn = waiters.shift()
    if (fn) fn(state.pending)
  }
}

/** 起一次交互式框选。 */
async function startInteractive(): Promise<boolean> {
  if (!(await probeAvailable())) return false
  if (state.capturing) return false
  state.capturing = true
  const dir = tmpDir()
  await mkdir(dir, { recursive: true })
  const regionFile = join(dir, 'region.png')
  await rm(regionFile, { force: true }).catch(() => {})

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
      .then((s) => (s.size > 0 ? finish(regionFile) : Promise.resolve()))
      .then(() => {
        state.capturing = false
      })
      .catch(() => {
        state.capturing = false
      })
  })
  return true
}

/** 开发/自动化用：跳过交互式框选，直接按给定矩形截一块再走同一条收尾流程。 */
async function startWithRect(rect: ShotRect): Promise<boolean> {
  if (!(await probeAvailable())) return false
  if (state.capturing) return false
  state.capturing = true
  const dir = tmpDir()
  await mkdir(dir, { recursive: true })
  const regionFile = join(dir, 'region.png')
  await rm(regionFile, { force: true }).catch(() => {})
  await run(CAPTURE, [
    '-x',
    '-R',
    `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
    regionFile,
  ])
  await finish(regionFile)
  state.capturing = false
  return true
}

/** `POST /api/shot/start` —— 开始一次截图（可带 `?rect=x,y,w,h` 供测试）。 */
export async function handleShotStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const rectParam = url.searchParams.get('rect')
  try {
    await readBody(req, 64 * 1024).catch(() => '')
  } catch {
    /* 没有 body 也无所谓 */
  }
  if (!(await probeAvailable())) {
    sendJson(res, 200, { ok: false, reason: state.reason })
    return
  }
  if (state.capturing) {
    sendJson(res, 200, { ok: false, reason: 'busy' })
    return
  }
  if (rectParam) {
    const n = rectParam.split(',').map(Number)
    if (n.length === 4 && n.every(Number.isFinite)) {
      const started = await startWithRect({ x: n[0], y: n[1], width: n[2], height: n[3] })
      sendJson(res, 200, { ok: started, test: true })
      return
    }
  }
  const started = await startInteractive()
  sendJson(res, 200, { ok: started })
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

/** `GET /api/shot/image?id=` —— 把整窗图按字节回给客户端（不进 JSON，避免几 MB 的 base64）。 */
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

export function shotStatus(): { available: boolean; reason: string; capturing: boolean; total: number; lastError: string } {
  return {
    available: state.available,
    reason: state.reason,
    capturing: state.capturing,
    total: state.total,
    lastError: state.lastError,
  }
}

/** `GET /api/shot/status` —— 调试/自检。 */
export async function handleShotStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  await probeAvailable()
  sendJson(res, 200, { ok: true, status: shotStatus() })
}
