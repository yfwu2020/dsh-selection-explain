/** Run the actual document Esc handler with isolated focus and panel state. No host/API access. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
const start = source.indexOf('      var offKeyDown = listen(document,')
const end = source.indexOf('\n\n      var offSettingsOpen', start)
assert.ok(start >= 0 && end > start)
const ask = {}, historyInput = {}, outside = {}, expandedChat = { closest: selector => selector.startsWith('[data-dsh-floating-chat]') ? {} : null }, compactChat = { closest: () => null }, nativeMenu = { closest: selector => selector.startsWith('[role=') ? {} : null }
let handler, fullView = true, calls = [], activeWindow = null, chatExpanded = true, hostModalOpen = false
const context = vm.createContext({
  panelOpen: true, settingsOpen: false,
  panel: { contains: node => node === ask },
  historyList: { contains: node => node === historyInput },
  document: { querySelector: selector => selector === '[role="dialog"][aria-modal="true"]'
    ? hostModalOpen ? {} : null
    : selector === '[data-dsh-full-view]' && fullView
    ? { getAttribute: () => activeWindow }
    : selector.startsWith('[data-dsh-floating-chat]') && chatExpanded ? {} : null },
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
function reset() { calls = []; activeWindow = null; chatExpanded = true; hostModalOpen = false; context.panelOpen = true; context.settingsOpen = false; context.settingsByKey = {}; context.captureRow.getAttribute = () => '0' }
for (const mode of [true, false]) {
  for (const target of [ask, historyInput, outside, expandedChat]) {
    reset(); fullView = mode; hostModalOpen = true; activeWindow = 'explanation'
    escape(target)
    assert.deepEqual(calls, [], '官方模态设置浮层优先消费 Esc，不受视图模式、焦点或最后操作窗口影响')
    assert.equal(context.panelOpen, true)
  }
}
reset(); fullView = true; hostModalOpen = true; context.settingsOpen = true; escape(ask)
assert.deepEqual(calls, [], '官方设置打开时不关闭插件设置抽屉')
assert.equal(context.settingsOpen, true)
reset(); hostModalOpen = true; context.captureRow.getAttribute = () => '1'; escape(ask)
assert.deepEqual(calls, [], '官方设置打开时不取消插件录音')
hostModalOpen = false; escape(ask)
assert.deepEqual(calls, ['prevent', 'stop', 'voice'], '官方设置退出后，下一次 Esc 恢复插件的内层退出顺序')
reset(); activeWindow = 'chat'; escape(ask)
assert.deepEqual(calls, [], '最后点击聊天后，即使键盘仍在解读输入框，也让聊天先退出')
reset(); activeWindow = 'explanation'; escape(expandedChat)
assert.equal(context.panelOpen, false, '最后点击解读消息后，即使键盘仍在聊天，也先退解读')
reset(); activeWindow = 'none'; escape(expandedChat)
assert.equal(context.panelOpen, false, '点击两窗外后不使用旧键盘焦点，优先退解读')
reset(); activeWindow = 'chat'; chatExpanded = false; escape(compactChat)
assert.equal(context.panelOpen, false, '已收起的聊天不占下一次退出顺序')
reset()
escape(outside)
assert.equal(context.panelOpen, false, '焦点在两窗之外时优先关闭解读')
reset(); escape(expandedChat)
assert.deepEqual(calls, [], '展开聊天的 Esc 交给聊天，不关闭解读')
assert.equal(context.panelOpen, true)
reset(); escape(compactChat)
assert.equal(context.panelOpen, false, '聊天收起后焦点留在紧凑条，再按 Esc 仍能关闭解读')
reset(); escape(nativeMenu)
assert.deepEqual(calls, [], '原生菜单先处理自身 Esc，不连带关闭解读')
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

// 语音卡另有一个更早注册的 capture 监听，也必须给官方浮层让出 Esc。
const panelHandler = handler
const voiceStart = source.indexOf('      var offVoiceEscape = listen(document,')
const voiceEnd = source.indexOf('\n      }, true)', voiceStart) + '\n      }, true)'.length
assert.ok(voiceStart >= 0 && voiceEnd > voiceStart)
context.vcardState = { open: true, suppress: false }
context.closeVCard = () => { calls.push('vcard'); context.vcardState.open = false }
new vm.Script(source.slice(voiceStart, voiceEnd)).runInContext(context)
const voiceHandler = handler
handler = panelHandler
reset(); hostModalOpen = true
voiceHandler({ key: 'Escape', preventDefault() { calls.push('prevent') }, stopPropagation() { calls.push('stop') } })
assert.deepEqual(calls, [], '官方设置打开时，语音卡不抢先消费 Esc')
assert.equal(context.vcardState.open, true)
hostModalOpen = false
voiceHandler({ key: 'Escape', preventDefault() { calls.push('prevent') }, stopPropagation() { calls.push('stop') } })
assert.deepEqual(calls, ['prevent', 'stop', 'vcard'], '官方设置退出后，Esc 可以关闭语音卡')
console.log('PASS focused Esc: host modals, independent windows, IME, nested settings, voice, history and split-mode behavior')
