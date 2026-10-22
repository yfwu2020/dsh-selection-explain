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
  /** 整窗截图是否已经做好（`/shot/image` 会等它；客户端拿到事件就能先画框）。 */
  ready: boolean
  /** 客户端带来的页面几何（null = 客户端没带，说明它还是旧版）。 */
  hint?: WindowHint | null
  /**
   * **DSH 自己那个窗口**的矩形（屏幕点）。
   * 客户端用它把"选区屏幕坐标"精确换算成页面的 CSS px：
   *   scale = selfWindow.width / window.outerWidth
   *   内容原点 = selfWindow 原点 + (outer-inner) 换算出的标题栏
   * 拿不到就是 null（客户端回退到旧算法）。
   */
  selfWindow: { x: number; y: number; width: number; height: number } | null
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
/** 框选期间预热的窗口列表：松手时就不用再等这 74ms。 */
let prefetchedWindows: WinInfo[] | null = null

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

/**
 * 收尾：**先截图，后出 UI**。
 *
 * ⚠️ 顺序不能反：UI 一旦画出来，`screencapture -l` 就会把它截进图里（框、卡片都算页面内容）。
 * 所以松手后先把整窗图拿到（~250ms），再发事件让客户端画东西。
 *
 * 时间线（实测）：
 *   xattr 读矩形 19ms → 整窗截图 223ms → 算 pad → 发事件（客户端 0 延迟出框）
 * 窗口列表（74ms）在**框选期间**就预热好了，不占这段。
 */
async function finish(regionFile: string, hint: WindowHint | null = null): Promise<void> {
  const rect = await rectFromXattr(regionFile)
  if (!rect) {
    state.lastError = 'no-rect'
    state.capturing = false
    return
  }

  seq += 1
  state.total += 1
  const dir = tmpDir()
  const imagePath = join(dir, 'window.png')

  let windowRect = rect
  let scale = 2
  let owner = ''
  let pad = { x: 0, y: 0 }

  try {
    const wins = prefetchedWindows || (await listWindows())
    const win = pickWindow(wins, rect)
    if (win) {
      // ⚠️ 不要加 `-o`：文档说它"不截窗口阴影"，实测**反过来** ——
      // 加了是 3840×2224（多 64px 阴影），不加才是 3840×2160（正好窗口的 2 倍）。
      // 阴影上下不对称，按对半分会让红框整体偏（用户实测：向上偏移）。
      await run(CAPTURE, ['-l', String(win.id), '-x', imagePath])
      const size = await pngSize(imagePath)
      if (size) {
        scale = size.w / win.w
        windowRect = { x: win.x, y: win.y, width: win.w, height: win.h }
        owner = win.owner
        // 正常情况 size 应当正好等于窗口的倍数（pad=0）；万一系统还是带了阴影，
        // 就按"多出来的两半分"兜底 —— 但优先保证不触发这条。
        pad = {
          x: Math.max(0, Math.round((size.w - win.w * scale) / 2)),
          y: Math.max(0, Math.round((size.h - win.h * scale) / 2)),
        }
      }
    }
    if (!owner) {
      // 没找到窗口：退化成"选区本身"那张图（不假装有上下文）
      await run('/bin/cp', [regionFile, imagePath])
      const size = await pngSize(imagePath)
      scale = size && rect.width > 0 ? size.w / rect.width : 2
      windowRect = rect
      pad = { x: 0, y: 0 }
      state.lastError = 'no-window'
    }
  } catch (error) {
    state.lastError = `finish-failed: ${String((error as Error)?.message ?? error)}`
  }

  const selfWindow = pickSelfWindow(prefetchedWindows || (await listWindows()), hint)
  const shot: ShotPending = {
    id: `shot-${seq}`,
    at: Date.now(),
    imagePath,
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
    ready: true,
    selfWindow,
    hint,
  }
  state.pending = shot
  state.lastShot = shot
  state.capturing = false
  while (waiters.length > 0) {
    const fn = waiters.shift()
    if (fn) fn(shot)
  }
}

/** 起一次交互式框选。 */
async function startInteractive(hint: WindowHint | null): Promise<boolean> {
  if (!(await probeAvailable())) return false
  if (state.capturing) return false
  state.capturing = true
  const dir = tmpDir()
  await mkdir(dir, { recursive: true })
  const regionFile = join(dir, 'region.png')
  await rm(regionFile, { force: true }).catch(() => {})

  // 和框选并行：用户拖框那一两秒里，窗口列表早就拿好了
  prefetchedWindows = null
  void listWindows()
    .then((wins) => {
      prefetchedWindows = wins
    })
    .catch(() => {})

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
async function startWithRect(rect: ShotRect, hint: WindowHint | null): Promise<boolean> {
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
  await finish(regionFile, hint)
  state.capturing = false
  return true
}

/** 客户端带来的页面几何提示（用来认领"我们自己的窗口"）。 */
export interface WindowHint {
  screenX: number
  screenY: number
  outerWidth: number
  outerHeight: number
  innerWidth: number
  innerHeight: number
}

function readHint(url: URL): WindowHint | null {
  const num = (key: string): number => Number(url.searchParams.get(key))
  const hint: WindowHint = {
    screenX: num('sx'),
    screenY: num('sy'),
    outerWidth: num('ow'),
    outerHeight: num('oh'),
    innerWidth: num('iw'),
    innerHeight: num('ih'),
  }
  const ok = [hint.screenX, hint.screenY, hint.outerWidth, hint.outerHeight, hint.innerWidth, hint.innerHeight].every(
    (n) => Number.isFinite(n),
  )
  return ok && hint.outerWidth > 0 ? hint : null
}

/**
 * 从窗口列表里认出"DSH 自己的窗口"。
 *
 * 判据：包含客户端的屏幕左上角（screenX/Y 就在自己窗口内），且宽度最接近它的 outerWidth。
 * 认不出来就返回 null —— 客户端会回退到旧算法，不会更差。
 */
function pickSelfWindow(wins: WinInfo[], hint: WindowHint | null): ShotRect | null {
  if (!hint) return null
  const cx = hint.screenX + 2
  const cy = hint.screenY + 2
  const candidates = wins
    .filter((w) => w.layer === 0 && cx >= w.x && cx <= w.x + w.w && cy >= w.y && cy <= w.y + w.h)
    .sort((a, b) => Math.abs(a.w - hint.outerWidth) - Math.abs(b.w - hint.outerWidth))
  const best = candidates[0]
  if (!best) return null
  // 宽度差太多说明认错了（比如窗口被系统加了边框）
  if (Math.abs(best.w - hint.outerWidth) > Math.max(40, hint.outerWidth * 0.1)) return null
  return { x: best.x, y: best.y, width: best.w, height: best.h }
}

/** `POST /api/shot/start` —— 开始一次截图（可带 `?rect=x,y,w,h` 供测试）。 */
export async function handleShotStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const hint = readHint(url)
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
      const started = await startWithRect({ x: n[0], y: n[1], width: n[2], height: n[3] }, hint)
      sendJson(res, 200, { ok: started, test: true })
      return
    }
  }
  const started = await startInteractive(hint)
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
  // 整窗截图是后台做的：这里最多等 4 秒，还没好就 404 让客户端重试
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
  await probeAvailable()
  const last = state.lastShot
  sendJson(res, 200, {
    ok: true,
    status: shotStatus(),
    clientHello,
    clientReports,
    // 只读观察点：不清 pending，用来量"事件发出 → 整窗图做好"这一段
    lastShot: last
      ? { id: last.id, ready: last.ready, ageMs: Date.now() - last.at, owner: last.owner, rect: last.rect, pad: last.pad, scale: last.scale, selectionRect: last.selectionRect, selfWindow: last.selfWindow, hint: last.hint }
      : null,
  })
}
