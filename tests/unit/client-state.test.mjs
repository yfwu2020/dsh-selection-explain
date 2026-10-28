import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClientState } from '../../src/client/state.js'
import { createPreferences } from '../../src/client/constants.js'

test('each UI lifecycle owns its draft, messages and live preferences', () => {
  const first = createClientState(), second = createClientState()
  first.turns.push({ role: 'user', text: 'only in the first panel' })
  first.quotes.push({ text: 'first draft' })
  first.attachments.push({ name: 'first.png' })
  first.phase = 'loading'
  assert.deepEqual(second.turns, [])
  assert.deepEqual(second.quotes, [])
  assert.deepEqual(second.attachments, [])
  assert.equal(second.phase, 'idle')
  const prefs = createPreferences(), otherPrefs = createPreferences()
  prefs.pillIdleMs = 2000
  assert.equal(otherPrefs.pillIdleMs, 10000)
  assert.equal(otherPrefs.maxSelectionChars, 4000)
})
