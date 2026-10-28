import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadShot } from './shot-fixtures.mjs'
const mod = await loadShot('shot-platform').catch(() => ({}))
assert.equal(typeof mod.createCommandRunner, 'function', 'platform commands need an injectable cancellation boundary')
function fakeChild() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.kills = []
  child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true }
  return child
}
{
  const child = fakeChild(); const runner = mod.createCommandRunner(() => child)
  const abort = new AbortController()
  const result = runner('capture', [], abort.signal, 10000)
  abort.abort()
  assert.equal((await result).signal, 'SIGTERM')
  assert.deepEqual(child.kills, ['SIGTERM'])
  assert.equal(abort.signal.onabort, null)
}
{
  let launches = 0
  const runner = mod.createCommandRunner(() => { launches++; return fakeChild() })
  const abort = new AbortController(); abort.abort()
  const result = await runner('capture', [], abort.signal)
  assert.equal(launches, 0, 'aborted task must never launch another command')
  assert.equal(result.failed, true)
}
{
  const child = fakeChild(); const runner = mod.createCommandRunner(() => child)
  const result = runner('capture', [], new AbortController().signal, 1)
  const keepAlive = setTimeout(() => {}, 100)
  assert.equal((await result).timedOut, true)
  clearTimeout(keepAlive)
  assert.deepEqual(child.kills, ['SIGTERM'])
}
{
  const child = fakeChild(); const runner = mod.createCommandRunner(() => child)
  const result = runner('missing-command', [], new AbortController().signal)
  child.emit('error', new Error('ENOENT'))
  child.emit('close', -2, null)
  const failed = await result
  assert.equal(failed.failed, true)
  assert.equal(failed.code, null, 'a post-error close cannot turn spawn failure into a normal command exit')
}
{
  const child = fakeChild()
  child.kill = signal => { child.kills.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal)); return true }
  const runner = mod.createCommandRunner(() => child)
  const abort = new AbortController()
  const result = runner('stubborn-command', [], abort.signal)
  const keepAlive = setTimeout(() => {}, 1000)
  abort.abort()
  assert.equal((await result).signal, 'SIGKILL')
  clearTimeout(keepAlive)
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
}

console.log('PASS shot platform cancellation, timeout, spawn failure, TERM to KILL escalation')
