/** Screenshot HTTP boundary. Each plugin application owns one service and its disposal. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson } from './http.js'
import { createMacShotPlatform } from './shot-platform.js'
import { createShotTasks } from './shot-service.js'
import { resolveOptions } from './shot-geometry.js'
import { DEFAULT_SHOT_CONFIG } from './shot-types.js'
import type { ShotConfig, ShotMode, ShotPlatform } from './shot-types.js'
export type { ShotScope, ShotMode, ShotRect, ShotPending, ShotError } from './shot-types.js'
export { resolveWindowProbe, shotSupported } from './shot-platform.js'

export function createShotService(config: ShotConfig = DEFAULT_SHOT_CONFIG, dependencies: { platform?: ShotPlatform } = {}) {
  const platform = dependencies.platform ?? createMacShotPlatform()
  const tasks = createShotTasks(platform)
  let clientHello: unknown = null
  const clientReports: Record<string, unknown> = {}

  async function handleShotStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, reason: 'method-not-allowed' }); return }
    tasks.clearError()
    const url = new URL(req.url || '/', 'http://localhost')
    const mode: ShotMode = url.searchParams.get('mode') === 'panel' ? 'panel' : 'card'
    await readBody(req, 64 * 1024).catch(() => '')
    if (!tasks.ensureAvailable()) { sendJson(res, 200, { ok: false, reason: tasks.status().reason }); return }
    if (tasks.status().capturing) { sendJson(res, 200, { ok: false, reason: 'busy' }); return }
    const options = resolveOptions(config, mode, url)
    const n = url.searchParams.get('rect')?.split(',').map(Number)
    const rect = n?.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0
      ? { x: n[0], y: n[1], width: n[2], height: n[3] } : undefined
    const started = await tasks.start(options, rect)
    sendJson(res, 200, {
      ok: started, ...(rect ? { test: true } : {}), mode, scope: options.scope, margin: options.margin,
      ...(started ? {} : { reason: tasks.status().lastError || 'start-failed' }),
    })
  }

  function handleShotPending(req: IncomingMessage, res: ServerResponse): void {
    const reply = () => sendJson(res, 200, { ok: true, ...tasks.takePending(), status: tasks.status() })
    if (tasks.hasPending() || tasks.signal.aborted) { reply(); return }
    let finished = false
    let unsubscribe: (() => void) | undefined
    const clear = () => {
      clearTimeout(timer)
      unsubscribe?.()
      req.removeListener('aborted', disconnect)
      res.removeListener('close', disconnect)
    }
    const done = () => { if (finished) return; finished = true; clear(); reply() }
    const disconnect = () => { if (finished) return; finished = true; clear() }
    const timer = setTimeout(done, 25_000)
    timer.unref()
    req.once('aborted', disconnect)
    // IncomingMessage.close also occurs for a normally completed GET body. Response.close
    // identifies the socket/response lifetime without prematurely removing every long-poll.
    res.once('close', disconnect)
    unsubscribe = tasks.subscribe(done)
  }

  async function handleShotImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = new URL(req.url || '/', 'http://localhost').searchParams.get('id') || ''
    const shot = tasks.findShot(id)
    if (!shot) { res.statusCode = 404; res.end('shot-not-found'); return }
    if (!shot.ready) { res.statusCode = 404; res.end('not-ready'); return }
    try {
      const buf = await platform.readFile(shot.imagePath)
      if (res.destroyed) return
      if (tasks.signal.aborted) { res.statusCode = 404; res.end('shot-not-found'); return }
      res.statusCode = 200
      res.setHeader('content-type', 'image/png')
      res.setHeader('cache-control', 'no-store')
      res.end(buf)
    } catch { if (!res.destroyed) { res.statusCode = tasks.signal.aborted ? 404 : 500; res.end(tasks.signal.aborted ? 'shot-not-found' : 'read-failed') } }
  }

  async function handleShotHello(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readBody(req, Number.MAX_SAFE_INTEGER)
      if (!tasks.signal.aborted) {
        clientHello = JSON.parse(body || 'null')
        const stage = (clientHello as { stage?: string } | null)?.stage
        if (stage) clientReports[stage] = clientHello
      }
    } catch { if (!tasks.signal.aborted) clientHello = { parseError: true } }
    if (!res.destroyed) sendJson(res, 200, { ok: true })
  }

  async function handleShotStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    tasks.ensureAvailable()
    const probe = await platform.probeAvailable(tasks.signal)
    const last = tasks.lastShot()
    sendJson(res, 200, {
      ok: true, status: tasks.status(), windowProbe: probe, clientHello, clientReports,
      lastShot: last ? {
        id: last.id, scope: last.scope, mode: last.mode, frame: last.frame, ready: last.ready,
        ageMs: Date.now() - last.at, owner: last.owner, rect: last.rect, pad: last.pad,
        scale: last.scale, selectionRect: last.selectionRect, windowRect: last.windowRect,
      } : null,
    })
  }
  return {
    handleShotStart, handleShotPending, handleShotImage, handleShotHello, handleShotStatus,
    status: tasks.status,
    async stop() { clientHello = null; for (const stage of Object.keys(clientReports)) delete clientReports[stage]; await tasks.stop() },
  }
}
