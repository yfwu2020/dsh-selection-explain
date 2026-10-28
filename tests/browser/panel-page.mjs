import { readFileSync } from 'node:fs'
import { runStartup } from './scenarios/panel-startup.mjs'
import { runLayout } from './scenarios/panel-layout.mjs'
import { runSelection } from './scenarios/panel-selection.mjs'
import { runPill } from './scenarios/panel-pill.mjs'
import { runKeyboard } from './scenarios/panel-keyboard.mjs'
import { runModels } from './scenarios/panel-models.mjs'
import { runVoice } from './scenarios/panel-voice.mjs'
import { runAttachments } from './scenarios/panel-attachments.mjs'
import { runMemory } from './scenarios/panel-memory.mjs'

export function createPanelPage() {
  const html = readFileSync(new URL('./fixtures/panel.html', import.meta.url), 'utf8')
  const scenarios = [runStartup, runLayout, runSelection, runPill, runKeyboard, runModels, runVoice, runAttachments, runMemory]
  return html.replace('/*__PANEL_SCENARIOS__*/', () => scenarios.map(fn => fn.toString()).join('\n'))
}
