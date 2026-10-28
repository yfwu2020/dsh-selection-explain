/** Instance-owned task, event, and file lifetime; deliberately independent of HTTP. */
import { captureShot, ShotCaptureError } from './shot-capture.js'
import type { ShotError, ShotOptions, ShotPending, ShotPlatform, ShotRect, ShotStatus } from './shot-types.js'

export function createShotTasks(platform: ShotPlatform) {
  const state: ShotStatus = { available: false, reason: 'idle', capturing: false, total: 0, lastError: '' }
  let pending: ShotPending | null = null
  let pendingError: ShotError | null = null
  let lastShot: ShotPending | null = null
  let sequence = 0
  let stopped = false
  let tempDir: Promise<string> | undefined
  let stopPromise: Promise<void> | undefined
  const lifetime = new AbortController()
  const waiters = new Set<() => void>()
  let active: { controller: AbortController; sequence: number } | undefined

  const notify = () => { const callbacks = [...waiters]; waiters.clear(); for (const callback of callbacks) callback() }
  const ensureAvailable = () => {
    state.available = !stopped && platform.supported()
    state.reason = stopped ? 'stopped' : state.available ? 'ok' : 'not-macos'
    return state.available
  }
  const status = (): ShotStatus => ({ ...state })
  const clean = async (dir: string) => { await platform.remove(dir, true).catch(() => {}) }

  async function start(options: Omit<ShotOptions, 'seq'>, rect?: ShotRect): Promise<boolean> {
    if (!ensureAvailable() || state.capturing) return false
    state.capturing = true
    const task = { controller: new AbortController(), sequence: ++sequence }
    active = task
    const current = () => !stopped && active === task && !task.controller.signal.aborted
    let dir: string
    try {
      tempDir ??= platform.createTempDir()
      dir = await tempDir
      if (!current()) { await clean(dir); return false }
    } catch (error) {
      tempDir = undefined
      if (current()) { state.lastError = `${rect ? 'start-failed' : 'tmp-failed'}: ${String((error as Error)?.message ?? error)}`; state.capturing = false; active = undefined }
      return false
    }
    const work = captureShot(platform, { ...options, seq: task.sequence }, dir, task.controller.signal, rect)
      .then(async result => {
        if (!current()) return false
        if (result) {
          state.total++
          state.lastError = result.note
          pending = lastShot = result.shot
          pendingError = null
          state.capturing = false
          notify()
          await platform.prune(dir, task.sequence).catch(() => {})
        }
        return !!result
      })
      .catch((error: unknown) => {
        if (!current()) return false
        const code = error instanceof ShotCaptureError ? error.code : rect ? 'start-failed' : 'finish-failed'
        const message = error instanceof ShotCaptureError ? error.message : `截图已拍下，但处理失败：${String((error as Error)?.message ?? error)}`
        state.lastError = rect && !(error instanceof ShotCaptureError) ? `start-failed: ${String((error as Error)?.message ?? error)}` : code
        const finishError = error instanceof ShotCaptureError && !error.startup
        if (!rect || finishError) {
          pendingError = { code, message, at: Date.now() }
          state.capturing = false
          notify()
        }
        // The rect route historically reports startup success when finishing emits an error.
        return !!rect && finishError
      })
      .finally(async () => {
        // Selection may finish before speculative window/display probes. Cancel
        // those commands while this task still owns their cancellation signal.
        task.controller.abort()
        if (active === task) { active = undefined; state.capturing = false }
        // An injected/uncooperative operation can resolve after disposal. Remove any late files too.
        if (stopped) await clean(dir)
      })
    if (rect) return work
    void work
    return true
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise
    stopped = true
    lifetime.abort()
    active?.controller.abort()
    active = undefined
    state.capturing = false
    state.available = false
    state.reason = 'stopped'
    pending = lastShot = null
    pendingError = null
    notify()
    stopPromise = (async () => {
      await platform.settle?.().catch(() => {})
      if (tempDir) await tempDir.then(clean).catch(() => {})
    })()
    return stopPromise
  }

  return {
    start, stop, status, ensureAvailable,
    signal: lifetime.signal,
    clearError() { pendingError = null },
    hasPending() { return !!pending || !!pendingError },
    takePending() { const result = { shot: pending, error: pendingError }; pending = null; pendingError = null; return result },
    findShot(id: string) { return pending?.id === id ? pending : lastShot?.id === id ? lastShot : null },
    lastShot() { return lastShot },
    subscribe(callback: () => void) { waiters.add(callback); return () => { waiters.delete(callback) } },
  }
}
