import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

export async function loadShot(entry = 'shot') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shot-test-'))
  const file = join(dir, `${entry}.mjs`)
  await build({ entryPoints: [`src/host/${entry}.ts`], outfile: file, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  try { return await import(pathToFileURL(file).href) }
  finally { await rm(dir, { recursive: true, force: true }) }
}
export const tick = () => new Promise(resolve => setImmediate(resolve))
export const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
export function request(url = '/', method = 'GET') {
  const req = new EventEmitter()
  req.url = url
  req.method = method
  req[Symbol.asyncIterator] = async function* () {}
  queueMicrotask(() => req.emit('end'))
  return req
}
export function response() {
  const res = new EventEmitter()
  res.headers = {}
  res.ended = 0
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers) }
  res.setHeader = (key, value) => { res.headers[key] = value }
  res.end = value => { res.body = value; res.ended++; res.writableEnded = true }
  return res
}
export const json = res => JSON.parse(String(res.body))
export function fakePlatform() {
  const files = new Map()
  const commands = []
  const removed = []
  let serial = 0
  const interactive = deferred()
  const displays = [{ id: 1, x: -100, y: 0, w: 200, h: 100, main: true, index: 1 }]
  const platform = {
    supported: () => true,
    probeAvailable: async () => true,
    createTempDir: async () => `/fake/shot-${++serial}`,
    remove: async path => { removed.push(path); files.delete(path) },
    prune: async () => {},
    readFile: async path => { if (!files.has(path)) throw Error('missing'); return files.get(path) },
    fileExists: async path => files.has(path),
    pngSize: async path => files.has(path) ? { w: 80, h: 40 } : null,
    rectFromXattr: async () => ({ x: -50, y: 10, width: 40, height: 20 }),
    listWindows: async () => [],
    listDisplays: async () => displays,
    run: async (cmd, args, signal) => {
      commands.push({ cmd, args, signal })
      if (args.includes('-i')) {
        await interactive.promise
        files.set(args.at(-1), Buffer.from('fake png'))
      } else files.set(args.at(-1), Buffer.from('fake png'))
      return { stdout: '', stderr: '', code: 0, signal: null, timedOut: false, failed: false }
    },
  }
  return { platform, commands, files, removed, interactive }
}
