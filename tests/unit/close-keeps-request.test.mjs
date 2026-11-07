import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTimerScope } from '../../src/client/memory.js'
import { createPanelController } from '../../src/client/panel.js'

function fakeRequest() {
  return {
    aborted: false,
    abort() {
      this.aborted = true
    },
  }
}

function panelEnv(state) {
  return {
    timerScope: createTimerScope(),
    state,
    panel: { style: {} },
    translationSection: { content: {} },
    detailSection: { content: {} },
    closeModelMenu() {},
    closeSettings() {},
    hideHistoryList() {},
    hideQuoteButton() {},
    cancelVoice() {},
    clearWaiting() {},
    clearRenderedTurns() {},
    paintPill() {},
    syncRouteWatch() {},
  }
}

test('closing the panel keeps the in-flight requests alive', () => {
  const request = fakeRequest()
  const ask = fakeRequest()
  const state = {
    request,
    askRequest: ask,
    payload: { text: 'locked in the closing panel' },
    turns: [],
    parts: { translation: '', detail: '' },
    phase: 'streaming',
  }
  const env = panelEnv(state)
  try {
    const panel = createPanelController(env)
    panel.closePanel()
    assert.equal(request.aborted, false, '收起小窗不能 abort 首轮/详解那一枪')
    assert.equal(ask.aborted, false, '收起小窗不能 abort 追问那一枪')
    assert.equal(state.request, request, '在飞的请求句柄必须留着，重开才能接着看')
    assert.equal(state.askRequest, ask)
    assert.notEqual(state.aborted, true, '收起不是用户点「停止」')
    assert.notEqual(state.stopped, true)
  } finally {
    env.timerScope.dispose()
  }
})

test('closing after a cancel keeps the already-cancelled handles untouched', () => {
  const state = { request: null, askRequest: null, payload: { text: 'x' }, turns: [] }
  const env = panelEnv(state)
  try {
    const panel = createPanelController(env)
    panel.closePanel()
    panel.closePanel()
    assert.equal(state.request, null, '重复收起不该凭空造出/清掉请求句柄')
    assert.equal(state.askRequest, null)
  } finally {
    env.timerScope.dispose()
  }
})
