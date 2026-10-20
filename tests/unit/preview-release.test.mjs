import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewFrames, registerPreviewFrame, releasePreviewFrames } from '../../src/client/render.js'

test('clearing a rendered subtree releases only its registered preview frames', () => {
  const owned = { isConnected: true }
  const other = { isConnected: true }
  const ownId = registerPreviewFrame(owned)
  const otherId = registerPreviewFrame(other)
  releasePreviewFrames({ contains: frame => frame === owned })
  assert.equal(previewFrames[ownId], undefined)
  assert.equal(previewFrames[otherId].frame, other)
  releasePreviewFrames({ contains: () => true })
  assert.equal(Object.keys(previewFrames).length, 0)
})
