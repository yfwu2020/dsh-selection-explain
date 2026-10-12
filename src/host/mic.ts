import type { ChildProcess } from 'node:child_process'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, mkdirSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { IncomingMessage, ServerResponse } from 'node:http'

// ───────────────────────── 麦克风占用检测 ─────────────────────────
//
// 回答一个问题：**此刻是不是某个输入法正在语音输入？**（豆包输入法、微信输入法……）
//
// 客户端拿它做什么：用户选中一段文字、同时正在用输入法说话时，就在那段文字下方弹一个
// 临时输入框并自动聚焦 —— 输入法"上屏"的文字会直接落进那个框（IME 只认焦点元素，
// 所以我们不需要读它的转写结果），点发送就跳过翻译/详解直接进追问。
//
// 怎么知道的：macOS 14.4 起 CoreAudio 暴露了进程对象列表，逐进程可读
// `kAudioProcessPropertyIsRunningInput` —— 于是"谁在录"是一次精确查询，而不是猜。
// **读这个状态不需要麦克风 TCC 授权**（只有真正录音才需要），这点很关键：插件不该为了
// 一个"指示灯"去要用户的麦克风权限。
//
// 原生探针见 native/mic-probe.c（Node 没有 FFI，所以编个小二进制，构建脚本第 ⑤ 步产出）。
// 这里只负责：懒启动、解析它吐的 JSON 行、缓存最新状态。编不出来 / 非 macOS 时
// available:false —— 客户端据此完全不启用这个特性，不装作在检测。

interface MicProcess {
  pid: number
  bundleId: string
  name: string
}

/** 最新一次探针状态（进程集合变了才更新）。 */
const micState = {
  available: false,
  capturing: false,
  processes: [] as MicProcess[],
  /** 不可用时的原因（not-macos / probe-missing / probe-failed / probe-exited）。 */
  reason: '',
}

let micChild: ChildProcess | null = null

/** 只尝试启动一次：失败就认（避免每个请求都去 spawn 一遍）。 */
let micStarted = false

/** 最近一次有人来问探针的时间（用来判断"没人看了"）。 */
let micLastUse = 0

/** "没人看就停"的检查定时器。 */
let micIdleTimer: NodeJS.Timeout | null = null

/**
 * 没人来问之后，探针还留多久（毫秒）。
 *
 * 为什么不立刻停：页面在"点一下别处"时会瞬间停轮询，立刻杀进程会变成反复 spawn/kill。
 * 留一段空转把这种抖动吸收掉；划词期间页面每 200ms 来问一次，探针自然不会到期。
 *
 * 为什么是 60 秒：让探针"热着"—— 你划词、看两眼、再划下一段，中间往往隔几十秒；
 * 探针还在的话，第二次划词是**零启动开销**（冷启动要 ~80ms 才出第一行）。
 * 代价是没人用之后进程多留一会儿，而它常驻只占 ~0.8% 单核，值。
 * 实际停止发生在超时后的下一次检查，所以真实寿命是 60~65 秒（见 MIC_IDLE_CHECK_MS）。
 */
const MIC_IDLE_MS = Number(process.env.DSH_SEL_MIC_IDLE_MS || 60000)

/** 空转检查的间隔（毫秒）。 */
const MIC_IDLE_CHECK_MS = Number(process.env.DSH_SEL_MIC_CHECK_MS || 5000)

/**
 * 探针的采样间隔（毫秒）—— 决定它多久发现"麦克风被打开了"。
 *
 * 为什么是 125：实测常驻成本极低（250ms → 0.6% 单核，150ms → 0.7%），
 * 而"按 Fn 到卡片弹出"的延迟里它是主要两项之一（另一项是页面轮询）。
 * 调快一倍的代价约 0.1% 单核，换来发现延迟减半 —— 值。
 * 原生探针会把区间夹在 50~5000ms 之间（见 native/mic-probe.c）。
 */
const MIC_WATCH_MS = Number(process.env.DSH_SEL_MIC_WATCH_MS || 125)

/** 探针二进制：随包构建出来的那个（与编译产物 lib/index.js 同级；测试可注入假的）。 */
const MIC_PROBE = fileURLToPath(new URL('../native/mic-probe', import.meta.url))

/** 探针源码：发布包里**一定有它**（`files` 含 native/），二进制则不一定（见下）。 */
const MIC_PROBE_SRC = fileURLToPath(new URL('../../native/mic-probe.c', import.meta.url))

/** 解析结果缓存：'' = 解析过了但没有可用探针（reason 说明为什么）。 */
let micProbeResolved: string | null = null

let micProbeReason = ''

/** 插件自己的数据目录（历史 / 记忆 / 就地编译出来的探针都放这儿）。 */
function pluginDataDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'selection-explain')
}

/**
 * 找到探针二进制 —— 找不到就**现场编一份**。
 *
 * 为什么必须运行时编译：CI 跑在 ubuntu 上，`build.sh` 里的原生探针那一步会被跳过
 * （日志原话："跳过原生探针（非 macOS 或没有 clang）"），于是 npm / Release 装下来的包里
 * **只有 `native/mic-probe.c` 源码、没有 `lib/native/mic-probe`** —— macOS 用户装上就是
 * `probe-missing`，豆包开麦永远不弹卡（2026-10-11 用户在另一台 Mac 上实测到的就是这个）。
 *
 * 顺序：环境变量覆盖（测试用）→ 随包构建的 → 数据目录里按**源码 hash** 缓存的那份
 * （没有就 clang 编一次；源码改了就自然重建）→ 都没有则如实报原因。
 * 编译失败不算致命：其余功能一律不受影响（和"没装识别服务"一个待遇）。
 */
function resolveMicProbe(): string {
  if (micProbeResolved !== null) return micProbeResolved
  const override = process.env.DSH_SEL_MIC_PROBE
  if (override) {
    micProbeResolved = existsSync(override) ? override : ''
    if (!micProbeResolved) micProbeReason = 'probe-missing'
    return micProbeResolved
  }
  if (existsSync(MIC_PROBE)) {
    micProbeResolved = MIC_PROBE
    return micProbeResolved
  }
  if (!existsSync(MIC_PROBE_SRC)) {
    micProbeResolved = ''
    micProbeReason = 'probe-missing'
    return micProbeResolved
  }
  let tag = 'v1'
  try {
    tag = createHash('sha1').update(readFileSync(MIC_PROBE_SRC)).digest('hex').slice(0, 8)
  } catch {
    /* 读不了源码就按固定名缓存 */
  }
  const built = join(pluginDataDir(), `mic-probe-${tag}`)
  if (existsSync(built)) {
    micProbeResolved = built
    return micProbeResolved
  }
  try {
    mkdirSync(pluginDataDir(), { recursive: true })
    const result = spawnSync(
      'clang',
      ['-O2', '-framework', 'CoreAudio', '-framework', 'CoreFoundation', MIC_PROBE_SRC, '-o', built],
      { timeout: 60_000 },
    )
    if (result.status === 0 && existsSync(built)) {
      try {
        chmodSync(built, 0o755)
      } catch {
        /* 权限位设不上也还能试跑 */
      }
      micProbeResolved = built
      return micProbeResolved
    }
  } catch {
    /* 下面统一给失败原因 */
  }
  micProbeResolved = ''
  micProbeReason = 'probe-build-failed'
  return micProbeResolved
}

/**
 * 懒启动探针（第一次有人来问才 spawn）。
 *
 * 为什么不加载就启动：插件装着的绝大多数时间没人划词，没必要常驻一个每秒读几次
 * CoreAudio 的进程。第一次 GET /mic 时才起。
 * 起过之后**也不是一直留着**：见 armMicIdleCheck —— 没人来问就停，下次再起。
 */
function ensureMicProbe(): void {
  if (micStarted) return
  micStarted = true
  if (process.platform !== 'darwin') {
    micState.reason = 'not-macos'
    return
  }
  const probe = resolveMicProbe()
  if (!probe) {
    micState.reason = micProbeReason || 'probe-missing'
    return
  }
  try {
    const child = spawn(probe, ['--watch', String(MIC_WATCH_MS)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    micChild = child
    micState.available = true
    micState.reason = ''
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        try {
          const parsed = JSON.parse(line) as { capturing?: boolean; processes?: MicProcess[] }
          micState.capturing = !!parsed.capturing
          micState.processes = Array.isArray(parsed.processes) ? parsed.processes : []
        } catch {
          // 半行 / 坏行：丢掉，下一行会覆盖（探针每行都是完整状态）
        }
      })
    }
    child.on('error', () => {
      micChild = null
      micState.available = false
      micState.capturing = false
      micState.processes = []
      micState.reason = 'probe-failed'
    })
    child.on('exit', () => {
      micChild = null
      micState.available = false
      micState.capturing = false
      micState.processes = []
      micState.reason = 'probe-exited'
    })
  } catch {
    micChild = null
    micState.available = false
    micState.reason = 'probe-failed'
  }
}

/**
 * 排一次"没人看就停"的检查（幂等）。
 *
 * 页面的轮询只在"有选区 / 卡片开着"时跑，探针跟着它的节奏走就够了 ——
 * 划词即启动，选区消失后再空转 MIC_IDLE_MS 就停，下次划词再起。
 */
function armMicIdleCheck(): void {
  if (micIdleTimer) return
  micIdleTimer = setInterval(() => {
    if (Date.now() - micLastUse < MIC_IDLE_MS) return
    stopMicProbe()
  }, MIC_IDLE_CHECK_MS)
  if (typeof micIdleTimer.unref === 'function') micIdleTimer.unref()
}

/**
 * 停掉探针（没人看了 / 插件卸载）。**下次有人来问会重新启动**。
 *
 * 注意 available 要跟着回落到 false：探针都停了，再报"正在录"就是过期数据 ——
 * 客户端看到 !available 会停掉轮询（不假装），这正是我们要的。
 */
export function stopMicProbe(): void {
  if (micIdleTimer) {
    clearInterval(micIdleTimer)
    micIdleTimer = null
  }
  // 允许下次重新启动（与"启动失败就认"不同：那是 spawn 失败，不该每个请求都重试）
  micStarted = false
  micState.available = false
  micState.capturing = false
  micState.processes = []
  micState.reason = 'idle'
  const child = micChild
  micChild = null
  if (!child) return
  try {
    child.kill()
  } catch {
    // 已经退了：无所谓
  }
}

/**
 * GET /selection-explain/api/mic
 *   → { ok, available, capturing, processes:[{pid,bundleId,name}], reason }
 *
 * 客户端只关心 `capturing` 和某个进程的 bundleId 是不是目标输入法；
 * 一次把所有占用者给全，是因为"同时在录的还有别的 App"很常见（会议软件、录音工具），
 * 只报第一个会让特性在那种情况下静默失效。
 */
export const handleMic = (req: IncomingMessage, res: ServerResponse): void => {
  // 每次有人来问都续一次命：只要页面在轮询，探针就不会到期
  micLastUse = Date.now()
  ensureMicProbe()
  armMicIdleCheck()
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ ok: true, ...micState }))
}
