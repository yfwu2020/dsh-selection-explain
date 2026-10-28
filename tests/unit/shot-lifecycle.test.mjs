import assert from 'node:assert/strict'
import { loadShot, fakePlatform, request, response, json, tick } from './shot-fixtures.mjs'
const shot = await loadShot()
assert.equal(typeof shot.createShotService, 'function', 'screenshot lifecycle must be instance-owned and injectable')
const config = { shotCardScope: 'window', shotPanelScope: 'selection', shotMargin: 48 }

// stop must cancel active capture, flush long-polls, and reject late success.
{
  const fake = fakePlatform()
  const service = shot.createShotService(config, { platform: fake.platform })
  const start = response()
  await service.handleShotStart(request('/shot/start?scope=selection', 'POST'), start)
  assert.equal(json(start).ok, true)
  const poll = response()
  service.handleShotPending(request('/shot/pending'), poll)
  await service.stop()
  assert.equal(fake.commands[0].signal.aborted, true, 'stop aborts the running capture command')
  assert.equal(poll.ended, 1, 'stop releases pending clients immediately')
  assert.equal(json(poll).shot, null)
  fake.interactive.resolve()
  await tick(); await tick()
  assert.equal(service.status().total, 0, 'late child completion cannot publish after stop')
  assert.equal(service.status().capturing, false)
  assert.equal(poll.ended, 1, 'poll responds only once')
  const restart = response()
  await service.handleShotStart(request('/shot/start?scope=selection', 'POST'), restart)
  assert.equal(json(restart).ok, false, 'a disposed service cannot start a new child')
}
// A disconnected poll is detached: stopping never writes to the dead response.
{
  const fake = fakePlatform()
  for (const event of ['aborted', 'close']) {
    const service = shot.createShotService(config, { platform: fake.platform })
    const req = request('/shot/pending'); const res = response()
    service.handleShotPending(req, res)
    if (event === 'aborted') req.emit(event)
    else res.emit(event)
    assert.equal(req.listenerCount('aborted'), 0)
    assert.equal(res.listenerCount('close'), 0)
    await service.stop()
    assert.equal(res.ended, 0, 'disconnected waiter is never replied to')
  }
}
// Capture, reports, files, and cancellation do not leak between two plugin instances.
{
  const fake = fakePlatform()
  const a = shot.createShotService(config, { platform: fake.platform })
  const b = shot.createShotService(config, { platform: fake.platform })
  const startedA = response(); const startedB = response()
  await a.handleShotStart(request('/shot/start?scope=selection', 'POST'), startedA)
  await b.handleShotStart(request('/shot/start?scope=selection', 'POST'), startedB)
  assert.notEqual(fake.commands[0].args.at(-1), fake.commands[1].args.at(-1))
  await a.stop()
  assert.equal(fake.commands[1].signal.aborted, false, 'stopping one instance keeps the other command alive')
  fake.interactive.resolve()
  await tick(); await tick()
  assert.equal(a.status().total, 0)
  assert.equal(b.status().total, 1)
  const pending = response(); b.handleShotPending(request('/shot/pending'), pending)
  const event = json(pending).shot
  assert.equal(event.scope, 'selection'); assert.equal(event.frame, false); assert.equal(event.ready, true)
  const image = response(); await b.handleShotImage(request(`/shot/image?id=${event.id}`), image)
  assert.equal(image.headers['content-type'], 'image/png')
  assert.equal(String(image.body), 'fake png')
  assert.equal(b.status().total, 1, 'taking pending leaves image addressable')
  await b.stop()
}
console.log('PASS shot lifecycle cancellation, late completion, disconnected polls, instance isolation, image lookup')
// Teardown waits for the platform's already-aborted commands before removing files.
{
  const fake = fakePlatform()
  let release
  const drained = new Promise(resolve => { release = resolve })
  fake.platform.settle = () => drained
  const service = shot.createShotService(config, { platform: fake.platform })
  await service.handleShotStart(request('/shot/start?scope=selection', 'POST'), response())
  let stopped = false
  const stopping = service.stop().then(() => { stopped = true })
  await tick()
  assert.equal(stopped, false, 'stop must wait for active command teardown')
  assert.equal(fake.removed.length, 0, 'remove files after active commands have stopped')
  release()
  await stopping
  assert.equal(fake.removed.length, 1)
  fake.interactive.resolve()
  await tick(); await tick()
}
// Cancellation during temporary-directory creation cannot launch a delayed child.
{
  const fake = fakePlatform()
  let release
  fake.platform.createTempDir = () => new Promise(resolve => { release = resolve })
  const service = shot.createShotService(config, { platform: fake.platform })
  const starting = service.handleShotStart(request('/shot/start?scope=selection', 'POST'), response())
  await tick()
  const stopping = service.stop()
  release('/fake/created-after-stop')
  await Promise.all([starting, stopping])
  assert.equal(fake.commands.length, 0)
  assert.ok(fake.removed.includes('/fake/created-after-stop'))
}
// Esc is silent; command failures are one consumable error with the legacy fields.
for (const [result, code] of [
  [{ code: 0, failed: false }, null],
  [{ code: 1, failed: true, stderr: 'not authorized' }, 'capture-failed'],
  [{ code: null, failed: true }, 'spawn-failed'],
  [{ code: null, failed: true, timedOut: true }, 'timeout'],
]) {
  const fake = fakePlatform()
  fake.platform.run = async () => ({ stdout: '', stderr: '', signal: null, timedOut: false, ...result })
  const service = shot.createShotService(config, { platform: fake.platform })
  await service.handleShotStart(request('/shot/start?scope=selection', 'POST'), response())
  await tick()
  const poll = response(); service.handleShotPending(request('/shot/pending'), poll)
  if (code) {
    const event = json(poll)
    assert.equal(event.shot, null); assert.equal(event.error.code, code)
    assert.equal(typeof event.error.at, 'number'); assert.equal(typeof event.error.message, 'string')
    if (code === 'capture-failed') assert.match(event.error.message, /屏幕录制权限/)
  } else { assert.equal(poll.ended, 0, 'Escape leaves no error event'); await service.stop(); assert.equal(json(poll).error, null) }
  await service.stop()
}
console.log('PASS shot teardown drain, delayed setup cancellation, Escape and error contract')
// The explicit-rect developer route reports a successfully started capture even
// when final processing emits an error (the same pending-error contract as interactive capture).
{
  const fake = fakePlatform()
  let reads = 0
  fake.platform.pngSize = async () => ++reads < 3 ? { w: 80, h: 40 } : null
  const service = shot.createShotService(config, { platform: fake.platform })
  const began = response()
  await service.handleShotStart(request('/shot/start?scope=selection&rect=-50,10,40,20', 'POST'), began)
  assert.equal(json(began).ok, true, 'rect capture startup success remains distinct from a finish error')
  const poll = response(); service.handleShotPending(request('/shot/pending'), poll)
  assert.equal(json(poll).error.code, 'image-missing')
  await service.stop()
}
// A file read that finishes after disposal must finish its HTTP response without
// returning the stale screenshot or leaving a connection hanging.
{
  const fake = fakePlatform()
  fake.interactive.resolve()
  const service = shot.createShotService(config, { platform: fake.platform })
  await service.handleShotStart(request('/shot/start?scope=selection', 'POST'), response())
  await tick()
  const poll = response(); service.handleShotPending(request('/shot/pending'), poll)
  const id = json(poll).shot.id
  let release
  fake.platform.readFile = () => new Promise(resolve => { release = resolve })
  const image = response()
  const reading = service.handleShotImage(request(`/shot/image?id=${id}`), image)
  await service.stop()
  release(Buffer.from('stale screenshot'))
  await reading
  assert.equal(image.ended, 1, 'disposal during an image read must finish the response')
  assert.equal(image.statusCode, 404)
  assert.equal(image.body, 'shot-not-found')
}

console.log('PASS shot explicit-rect finish-error compatibility and disposal during image read')

// Escape and the no-rect fallback can finish before speculative window/display probes.
// A completed task must cancel those unused commands before losing its controller.
for (const outcome of ['escape', 'success']) {
  const fake = fakePlatform()
  const signals = []
  const probes = []
  const probe = signal => {
    signals.push(signal)
    const pending = new Promise(resolve => signal.addEventListener('abort', () => resolve([]), { once: true }))
    probes.push(pending)
    return pending
  }
  fake.platform.listWindows = probe
  fake.platform.listDisplays = probe
  fake.platform.settle = () => Promise.all(probes)
  fake.platform.rectFromXattr = async () => null
  if (outcome === 'escape') fake.platform.run = async () => ({ stdout: '', stderr: '', code: 0, signal: null, timedOut: false, failed: false })
  else fake.interactive.resolve()
  const service = shot.createShotService(config, { platform: fake.platform })
  await service.handleShotStart(request('/shot/start?scope=window', 'POST'), response())
  for (let i = 0; i < 20 && service.status().capturing; i++) await tick()
  await tick()
  assert.equal(service.status().capturing, false)
  assert.equal(service.status().total, outcome === 'success' ? 1 : 0)
  assert.equal(signals.length, 2)
  assert.ok(signals.every(signal => signal.aborted), `${outcome} cancels unused speculative probes`)
  await service.stop()
}
console.log('PASS completed screenshot tasks cancel unused window/display probes')
