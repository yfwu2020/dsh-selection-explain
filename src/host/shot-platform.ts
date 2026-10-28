/** macOS commands, native helper recovery, and private temporary files. */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { access, chmod, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveNativeProbe } from './native-probe.js'
import { parsePngSize, parseRectXattr } from './shot-geometry.js'
import type { CommandResult, CommandRunner, DisplayInfo, ShotPlatform, WinInfo } from './shot-types.js'

export type SpawnCommand = (command: string, args: string[], options: { stdio: ['ignore', 'pipe', 'pipe']; env?: NodeJS.ProcessEnv }) => ChildProcess
const unref = (timer: NodeJS.Timeout) => timer.unref()

/** Every external command, including helper compilation, observes the service's abort signal. */
export function createCommandRunner(launch: SpawnCommand = spawn): CommandRunner {
  return (command, args, signal, timeout = 10_000, env) => new Promise(resolve => {
    const result: CommandResult = { stdout: '', stderr: '', code: null, signal: null, timedOut: false, failed: false }
    if (signal.aborted) { resolve({ ...result, failed: true }); return }
    let child: ChildProcess
    try { child = launch(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env }) }
    catch { resolve({ ...result, failed: true }); return }
    let settled = false
    let escalation: NodeJS.Timeout | undefined
    let fallback: NodeJS.Timeout | undefined
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(escalation)
      clearTimeout(fallback)
      signal.removeEventListener('abort', abort)
      resolve({ ...result })
    }
    const terminate = () => {
      if (settled || escalation) return
      result.failed = true
      try { child.kill('SIGTERM') } catch { /* Already gone. */ }
      if (settled) return
      escalation = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* Already gone. */ }
        if (settled) return
        fallback = setTimeout(finish, 250)
        unref(fallback)
      }, 250)
      unref(escalation)
    }
    const abort = () => terminate()
    const timer = setTimeout(() => { result.timedOut = true; terminate() }, timeout)
    unref(timer)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', chunk => {
      if (settled) return
      if (result.stdout.length + String(chunk).length > 8 * 1024 * 1024) terminate()
      else result.stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => { if (!settled && result.stderr.length < 4000) result.stderr += String(chunk).slice(0, 4000 - result.stderr.length) })
    child.once('error', () => { result.failed = true; finish() })
    child.once('close', (code, exitSignal) => {
      if (settled) return
      result.code = code
      result.signal = exitSignal
      result.failed ||= code !== 0 || !!exitSignal
      finish()
    })
    // Also cover an abort delivered synchronously by an injected launcher.
    if (signal.aborted) abort()
  })
}

export function shotSupported(): boolean { return platform() === 'darwin' }
export function resolveWindowProbe(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'window-list')
}

export function createMacShotPlatform(execute: CommandRunner = createCommandRunner()): ShotPlatform {
  const commands = new Set<Promise<CommandResult>>()
  const run: CommandRunner = (...args) => {
    const pending = execute(...args)
    commands.add(pending)
    void pending.then(() => commands.delete(pending), () => commands.delete(pending))
    return pending
  }
  let windowProbePath = ''
  let checked = false
  let probing: Promise<boolean> | undefined
  const fileExists = (path: string) => stat(path).then(info => info.isFile() && info.size > 0).catch(() => false)
  const probeAvailable = (signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted || !shotSupported()) return Promise.resolve(false)
    if (checked) return Promise.resolve(!!windowProbePath)
    if (probing) return probing
    probing = resolveNativeProbe({
      name: 'window-list',
      packagedPath: resolveWindowProbe(),
      sourcePath: fileURLToPath(new URL('../../native/window-list.c', import.meta.url)),
      cacheDir: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'selection-explain'),
      frameworks: ['CoreFoundation', 'CoreGraphics'],
      compile: async (source, output, frameworks) => {
        const flags = ['-O2', ...frameworks.flatMap(name => ['-framework', name]), source, '-o', output]
        const xcode = '/Applications/Xcode.app/Contents/Developer'
        const compiler = join(xcode, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang')
        try {
          await access(compiler)
          const env = { ...process.env, DEVELOPER_DIR: xcode }
          const sdk = await run('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], signal, 15000, env)
          if (!sdk.failed && sdk.stdout.trim()) {
            const built = await run(compiler, ['-isysroot', sdk.stdout.trim(), ...flags], signal, 60000, env)
            if (!built.failed && await fileExists(output) && !signal.aborted) return true
          }
        } catch { /* Xcode is optional. */ }
        for (const [command, args] of [['clang', flags], ['xcrun', ['clang', ...flags]]] as const) {
          if (signal.aborted) return false
          if (!(await run(command, [...args], signal, 60000)).failed && await fileExists(output) && !signal.aborted) return true
        }
        return false
      },
    }).then(path => {
      if (signal.aborted) return false
      windowProbePath = path
      checked = true
      return !!path
    }).finally(() => { probing = undefined })
    return probing
  }
  const probeJson = async (args: string[], signal: AbortSignal): Promise<unknown[]> => {
    if (!await probeAvailable(signal) || signal.aborted) return []
    const result = await run(windowProbePath, args, signal)
    if (result.failed || signal.aborted) return []
    try { const items: unknown = JSON.parse(result.stdout); return Array.isArray(items) ? items : [] } catch { return [] }
  }
  const pngSize = async (path: string) => { try { return parsePngSize(await readFile(path)) } catch { return null } }
  return {
    supported: shotSupported, probeAvailable, run, fileExists, readFile, pngSize,
    async settle() {
      await probing?.catch(() => {})
      while (commands.size) await Promise.allSettled([...commands])
    },
    async createTempDir() {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-selection-explain-'))
      await chmod(dir, 0o700)
      return dir
    },
    async remove(path, recursive = false) { await rm(path, { recursive, force: true }).catch(() => {}) },
    async prune(dir, seq) {
      const names = await readdir(dir).catch(() => [])
      await Promise.all(names.filter(name => {
        const match = /^(?:region|shot|display)-(\d+)\.png$/.exec(name)
        return match && Number(match[1]) <= seq - 3
      }).map(name => rm(join(dir, name), { force: true }).catch(() => {})))
    },
    async rectFromXattr(path, signal) {
      const result = await run('/usr/bin/xattr', ['-px', 'com.apple.metadata:kMDItemScreenCaptureGlobalRect', path], signal)
      return result.failed || signal.aborted ? null : parseRectXattr(result.stdout)
    },
    async listWindows(signal) {
      return (await probeJson([], signal)).filter((item): item is WinInfo => {
        const w = item as WinInfo | null
        return !!w && [w.id, w.x, w.y, w.w, w.h, w.layer].every(Number.isFinite) && w.w > 0 && w.h > 0 && typeof w.owner === 'string'
      })
    },
    async listDisplays(signal) {
      return (await probeJson(['--displays'], signal)).filter((item): item is Partial<DisplayInfo> => {
        const d = item as Partial<DisplayInfo> | null
        return !!d && [d.x, d.y, d.w, d.h].every(Number.isFinite) && Number(d.w) > 0 && Number(d.h) > 0
      }).map(d => ({ id: Number(d.id) || 0, x: Number(d.x), y: Number(d.y), w: Number(d.w), h: Number(d.h), index: Number(d.index) || 0, main: d.main === true || Number(d.main) === 1 }))
    },
  }
}
