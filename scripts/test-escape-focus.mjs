/** Run the actual document Esc handler with isolated focus and panel state. No host/API access. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
const start = source.indexOf('      var offKeyDown = listen(document,')
const end = source.indexOf('\n\n      var offSettingsOpen', start)
assert.ok(start >= 0 && end > start)
const ask = {}, historyInput = {}, outside = {}
let handler, fullView = true, calls = []
const context = vm.createContext({
  panelOpen: true, settingsOpen: false,
  panel: { contains: node => node === ask },
  historyList: { contains: node => node === historyInput },
  document: { querySelector: selector => selector === '[data-dsh-full-view]' && fullView ? {} : null },
  listen(target, type, callback, capture) { assert.equal(type, 'keydown'); assert.equal(capture, true); handler = callback },
  captureRow: { getAttribute: () => '0' }, settingsByKey: {},
  closeModelPicks() { calls.push('menu') },
  closeSettings() { calls.push('settings'); context.settingsOpen = false },
  cancelVoice() { calls.push('voice') },
  closePanel() { calls.push('panel'); context.panelOpen = false },
})
new vm.Script(source.slice(start, end)).runInContext(context)
function escape(target, extra = {}) {
  const event = { key: 'Escape', target, ...extra, preventDefault() { calls.push('prevent') }, stopPropagation() { calls.push('stop') } }
  handler(event)
}
function reset() { calls = []; context.panelOpen = true; context.settingsOpen = false; context.settingsByKey = {}; context.captureRow.getAttribute = () => '0' }
escape(outside)
assert.deepEqual(calls, [], '完整视图中其他窗口的 Esc 不关闭解读、不拦截事件')
assert.equal(context.panelOpen, true)
for (const extra of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
  reset(); escape(ask, extra); assert.deepEqual(calls, [], '输入法或已处理的 Esc 不关闭解读')
}
reset(); context.settingsOpen = true; context.settingsByKey = { model: { menu: { getAttribute: () => '1' } } }; escape(ask)
assert.deepEqual(calls, ['prevent', 'stop', 'menu'])
assert.equal(context.panelOpen, true)
reset(); context.settingsOpen = true; escape(ask)
assert.deepEqual(calls, ['prevent', 'stop', 'settings'])
assert.equal(context.panelOpen, true)
reset(); context.captureRow.getAttribute = () => '1'; escape(ask)
assert.deepEqual(calls, ['prevent', 'stop', 'voice'])
assert.equal(context.panelOpen, true)
for (const target of [ask, historyInput]) {
  reset(); escape(target); assert.deepEqual(calls, ['prevent', 'stop', 'panel']); assert.equal(context.panelOpen, false)
}
reset(); fullView = false; escape(outside)
assert.equal(context.panelOpen, false, '普通分栏保留解读原来的全局 Esc 行为')
console.log('PASS focused Esc: independent windows, IME, nested settings, voice, history and split-mode behavior')
