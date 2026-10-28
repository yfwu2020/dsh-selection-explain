import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHistoryTranscriptController } from '../../src/client/history-transcript.js'
import { previewFrames } from '../../src/client/render.js'

class Node {
  constructor() { this.children = []; this.style = {}; this.events = {}; this.parentNode = null }
  set textContent(value) { this.text = value; for (const child of this.children) child.parentNode = null; this.children = [] }
  get textContent() { return this.text }
  setAttribute(name, value) { this[name] = value }
  addEventListener(type, handler) { this.events[type] = handler }
  appendChild(child) { this.children.push(child); child.parentNode = this }
  insertBefore(child, anchor) { this.children.splice(this.children.indexOf(anchor), 0, child); child.parentNode = this }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null }
  contains(child) { return this.children.some(node => node === child || node.contains(child)) }
}

test('showing earlier turns preserves mounted preview nodes and reader position, then cleans up on close', () => {
  const previousDocument = globalThis.document
  globalThis.document = { createElement: () => new Node() }
  const chatLog = new Node()
  const turns = [{ role: 'assistant', text: 'hidden seed', hidden: true }, ...Array.from({ length: 81 }, (_, index) => ({ role: 'user', text: String(index) }))]
  const env = { state: { turns, cacheKey: 'first', follow: true }, panelOpen: true, chatLog, body: { scrollTop: 25, get scrollHeight() { return chatLog.children.length * 20 } }, clearWaiting() {} }
  const bubbles = { bubbleFor(turn) { const node = new Node(); node.textContent = turn.text; return node }, fillUserBubble() {}, paintNotice() {}, paintQuoteAll() {} }
  let sticks = 0
  const transcript = createHistoryTranscriptController(env, bubbles, { nearBottom: () => false, stickToBottom: () => sticks++ })
  try {
    transcript.renderTurns()
    assert.equal(chatLog.children.length, 41)
    assert.equal(chatLog.children[1].__turn, turns[42])
    const preserved = chatLog.children[1]
    const frame = new Node()
    preserved.appendChild(frame)
    previewFrames['history-transcript-test'] = { frame }
    chatLog.children[0].events.click({ preventDefault() {}, stopPropagation() {} })
    assert.equal(chatLog.children.length, 81)
    assert.equal(chatLog.children[41], preserved)
    assert.equal(env.body.scrollTop, 825)
    assert.equal(env.state.follow, false)
    assert.equal(sticks, 0)
    assert.equal(previewFrames['history-transcript-test'].frame, frame)
    chatLog.children[0].events.click({ preventDefault() {}, stopPropagation() {} })
    assert.equal(chatLog.children.length, 81)
    assert.equal(chatLog.children[41], preserved)
    assert.equal(chatLog.children[0].__turn, turns[1])
    transcript.renderTurns({ stick: true })
    assert.equal(sticks, 1)
    env.panelOpen = false
    transcript.renderTurns()
    assert.equal(chatLog.children.length, 0)
    assert.equal(previewFrames['history-transcript-test'], undefined)
    env.panelOpen = true
    env.state = { turns: turns.slice(), cacheKey: 'second' }
    transcript.renderTurns()
    assert.equal(chatLog.children.length, 41)
  } finally { globalThis.document = previousDocument; delete previewFrames['history-transcript-test'] }
})
