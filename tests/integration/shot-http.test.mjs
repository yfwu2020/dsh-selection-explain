/** Offline HTTP contract: synthetic image bytes only; never launches macOS capture or DSH. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { loadShot, fakePlatform, tick } from '../unit/shot-fixtures.mjs'
const { createShotService } = await loadShot()
const config = { shotCardScope: 'window', shotPanelScope: 'selection', shotMargin: 48 }
const fake = fakePlatform()
const sizes = new Map()
fake.platform.listWindows = async () => [{ id: 7, x: -60, y: 0, w: 100, h: 60, layer: 0, owner: 'Synthetic app' }]
fake.platform.pngSize = async path => sizes.get(path) ?? null
fake.platform.run = async (command, args, signal) => {
  assert.equal(signal.aborted, false, 'no new platform command after stop')
  fake.commands.push({ command, args, signal })
  const path = args.at(-1)
  const size = args.includes('-i') ? { w: 80, h: 40 }
    : args.includes('-D') ? { w: 400, h: 200 }
      : args.includes('-l') ? { w: 200, h: 120 }
        : { w: Number(args[2]), h: Number(args[1]) }
  sizes.set(path, size)
  fake.files.set(path, Buffer.from(`synthetic ${size.w}x${size.h}`))
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, failed: false }
}
const service = createShotService(config, { platform: fake.platform })
const handlers = Object.fromEntries(['Start', 'Pending', 'Image', 'Status', 'Hello'].map(name => [name.toLowerCase(), service[`handleShot${name}`]]))
const server = createServer((req, res) => {
  const handler = handlers[new URL(req.url, 'http://x').pathname.split('/').at(-1)]
  Promise.resolve(handler?.(req, res)).catch(error => { res.statusCode = 500; res.end(error.stack) })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const get = async path => (await fetch(origin + path)).json()
const start = async suffix => (await fetch(origin + '/shot/start' + suffix, { method: 'POST' })).json()
try {
  assert.deepEqual(await get('/shot/start'), { ok: false, reason: 'method-not-allowed' })
  for (const [scope, expected, bounds] of [
    ['selection', { x: 0, y: 0, width: 80, height: 40 }, { x: -50, y: 10, width: 40, height: 20 }],
    ['margin', { x: 96, y: 20, width: 80, height: 40 }, { x: -98, y: 0, width: 136, height: 78 }],
    ['screen', { x: 100, y: 20, width: 80, height: 40 }, { x: -100, y: 0, width: 200, height: 100 }],
    ['window', { x: 20, y: 20, width: 80, height: 40 }, { x: -60, y: 0, width: 100, height: 60 }],
  ]) {
    const began = await start(`?scope=${scope}&mode=panel`)
    assert.deepEqual(began, { ok: true, mode: 'panel', scope, margin: 48 })
    const pending = await get('/shot/pending')
    assert.equal(pending.ok, true); assert.equal(pending.error, null)
    assert.equal(pending.shot.scope, scope); assert.equal(pending.shot.mode, 'panel')
    assert.equal(pending.shot.frame, scope !== 'selection'); assert.equal(pending.shot.ready, true)
    assert.deepEqual(pending.shot.rect, expected); assert.deepEqual(pending.shot.windowRect, bounds)
    assert.equal(pending.shot.scale, 2)
    const image = await fetch(origin + `/shot/image?id=${pending.shot.id}`)
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png')
    assert.match(await image.text(), /^synthetic /)
    const status = await get('/shot/status')
    assert.equal(status.lastShot.id, pending.shot.id)
    assert.deepEqual(status.lastShot.rect, expected)
  }
  const rect = await start('?mode=panel&rect=-50,10,40,20')
  assert.deepEqual(rect, { ok: true, test: true, mode: 'panel', scope: 'selection', margin: 48 })
  assert.equal((await get('/shot/pending')).shot.scale, 2)
  await fetch(origin + '/shot/hello', { method: 'POST', body: JSON.stringify({ stage: 'geometry', test: 1 }) })
  const hello = await get('/shot/status')
  assert.deepEqual(hello.clientHello, { stage: 'geometry', test: 1 })
  assert.deepEqual(hello.clientReports.geometry, hello.clientHello)
  // Missing display keeps the valid region as fallback and preserves diagnostic data.
  fake.platform.listDisplays = async () => []
  await start('?scope=screen')
  const fallback = await get('/shot/pending')
  assert.equal(fallback.shot.scope, 'selection'); assert.equal(fallback.shot.frame, false)
  assert.equal(fallback.status.lastError, 'no-display')
  // An empty poll is released by disposal immediately rather than waiting 25 seconds.
  const waiting = fetch(origin + '/shot/pending').then(res => res.json())
  await tick(); await tick()
  await service.stop()
  assert.deepEqual((await waiting).shot, null)
  assert.equal((await get('/shot/status')).status.reason, 'stopped')
  assert.equal((await fetch(origin + '/shot/image?id=shot-1')).status, 404)
  assert.deepEqual(await start(''), { ok: false, reason: 'stopped' })
  assert.ok(fake.removed.includes('/fake/shot-1'))
} finally {
  await service.stop()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
console.log('PASS shot HTTP all scopes, Retina geometry, synthetic rect, fallback, telemetry, image and stop')
