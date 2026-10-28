import assert from 'node:assert/strict'
import { loadShot } from './shot-fixtures.mjs'
const { parseRectPlist, parseRectXattr, parsePngSize, pickDisplay, pickWindow, clampRect, cropBox, resolveOptions, friendlyCaptureError } = await loadShot('shot-geometry')

// Binary plist references can repeat: x/w and y/h are deduplicated by macOS.
function rectPlist(values, refs = [0, 1, 0, 1]) {
  const objects = values.map(value => { const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(value, 1); return b })
  objects.push(Buffer.from([0xa0 + refs.length, ...refs]))
  const offsets = []; let offset = 8
  for (const object of objects) { offsets.push(offset); offset += object.length }
  const trailer = Buffer.alloc(32); trailer[6] = 1; trailer[7] = 1
  trailer.writeBigUInt64BE(BigInt(objects.length), 8); trailer.writeBigUInt64BE(BigInt(objects.length - 1), 16); trailer.writeBigUInt64BE(BigInt(offset), 24)
  return Buffer.concat([Buffer.from('bplist00'), ...objects, Buffer.from(offsets), trailer])
}
const plist = rectPlist([300, 200])
assert.deepEqual(parseRectPlist(plist), [300, 200, 300, 200])
assert.deepEqual(parseRectXattr(plist.toString('hex').match(/.{1,16}/g).join('\n')), { x: 300, y: 200, width: 300, height: 200 })
assert.equal(parseRectXattr('GG'), null)
assert.equal(parseRectXattr(rectPlist([0, -2]).toString('hex')), null)
for (let i = 0; i < plist.length; i++) assert.doesNotThrow(() => parseRectPlist(plist.subarray(0, i)))
const bad = Buffer.from(plist); bad[8] = 0x23; bad[bad.length - 33] = 255
assert.equal(parseRectPlist(bad), null)
const negative = rectPlist([-120, 15, 40, 20], [0, 1, 2, 3])
assert.deepEqual(parseRectPlist(negative), [-120, 15, 40, 20])

const left = { id: 1, x: -200, y: 0, w: 200, h: 100, index: 2, main: false }
const main = { id: 2, x: 0, y: 0, w: 200, h: 200, index: 1, main: true }
assert.equal(pickDisplay([left, main], { x: -180, y: 5, width: 100, height: 20 }), left)
assert.equal(pickDisplay([], { x: 0, y: 0, width: 1, height: 1 }), null)
assert.deepEqual(clampRect({ x: -220, y: -10, width: 80, height: 60 }, left), { x: -200, y: 0, width: 60, height: 50 })
assert.deepEqual(cropBox({ left: -0.4, top: 5.7, width: 999, height: 9.2 }, { w: 100, h: 10 }), { left: 0, top: 6, width: 100, height: 4 })
const background = { id: 1, x: 0, y: 0, w: 200, h: 100, layer: 0, owner: 'app' }
const dialog = { ...background, id: 2, x: 40, y: 20, w: 60, h: 40 }
assert.equal(pickWindow([background, { ...dialog, id: 3, layer: 1 }, dialog], { x: 50, y: 30, width: 10, height: 10 }), dialog)
const config = { shotCardScope: 'window', shotPanelScope: 'selection', shotMargin: 48 }
assert.deepEqual(resolveOptions(config, 'panel', new URL('http://x/')), { mode: 'panel', scope: 'selection', margin: 48 })
assert.deepEqual(resolveOptions(config, 'card', new URL('http://x/?scope=margin&margin=999')), { mode: 'card', scope: 'margin', margin: 400 })
assert.deepEqual(resolveOptions(config, 'card', new URL('http://x/?scope=invalid&margin=bad')), { mode: 'card', scope: 'window', margin: 48 })
assert.match(friendlyCaptureError('not authorized', 1), /屏幕录制权限/)
assert.match(friendlyCaptureError('unexpected failure', 3), /退出码 3/)
const png = Buffer.alloc(24); png.set([0x89, 0x50, 0x4e, 0x47]); png.writeUInt32BE(800, 16); png.writeUInt32BE(400, 20)
assert.deepEqual(parsePngSize(png), { w: 800, h: 400 })
assert.equal(parsePngSize(Buffer.alloc(24)), null)
console.log('PASS shot pure metadata parsing, negative display coordinates, cropping, window selection, scope options')
