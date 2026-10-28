import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHistoryScrollController } from '../../src/client/history-scroll.js'

test('scroll following yields to upward input and ignores its own scroll events briefly', () => {
  const oldNow = Date.now
  let now = 1000
  Date.now = () => now
  const env = { body: { scrollHeight: 400, scrollTop: 290, clientHeight: 100 }, state: { follow: true } }
  try {
    const scroll = createHistoryScrollController(env)
    scroll.noteUserScroll({ deltaY: -1 })
    assert.equal(env.state.follow, false)
    scroll.noteUserScroll({ deltaY: 1 })
    assert.equal(env.state.follow, true)
    scroll.stickToBottom()
    env.body.scrollTop = 0
    scroll.noteBodyScroll()
    assert.equal(env.state.follow, true)
    now += 150
    scroll.noteBodyScroll()
    assert.equal(env.state.follow, false)
  } finally { Date.now = oldNow }
})

test('resize observers use live state and disconnect/reset their public observer references', () => {
  const previous = globalThis.ResizeObserver
  const previousWindow = globalThis.window
  const observers = []
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(node) { this.target = node }
    disconnect() { this.disconnected = true }
  }
  globalThis.window = { innerHeight: 800 }
  let clamped = 0
  const env = { state: { follow: true }, body: { scrollHeight: 400, scrollTop: 0 }, panel: {}, chatLog: {}, panelOpen: true, panelInteracting: false, panelLayoutRect: () => ({ bottom: 810 }), clampPanelPosition: () => clamped++ }
  try {
    const scroll = createHistoryScrollController(env)
    const stopChat = scroll.ensureChatFollow()
    const stopPanel = scroll.ensurePanelInsideViewport()
    assert.equal(scroll.ensureChatFollow(), null)
    assert.equal(scroll.ensurePanelInsideViewport(), null)
    assert.equal(observers[0].target, env.chatLog)
    assert.equal(observers[1].target, env.panel)
    observers[0].callback()
    assert.equal(env.body.scrollTop, 400)
    env.state = { follow: false }
    env.body.scrollTop = 10
    observers[0].callback()
    assert.equal(env.body.scrollTop, 10)
    observers[1].callback()
    assert.equal(clamped, 1)
    env.panelInteracting = true
    observers[1].callback()
    assert.equal(clamped, 1)
    stopChat(); stopPanel()
    assert.equal(scroll.chatGrowWatch, null)
    assert.equal(scroll.panelGrowWatch, null)
    assert.ok(observers.every(observer => observer.disconnected))
    const legacyObserver = { disconnect() {} }
    scroll.chatGrowWatch = legacyObserver
    scroll.panelGrowWatch = legacyObserver
    assert.equal(scroll.chatGrowWatch, legacyObserver)
    assert.equal(scroll.panelGrowWatch, legacyObserver)
  } finally { globalThis.ResizeObserver = previous; globalThis.window = previousWindow }
})
