import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsStore } from '../../lib/host/settings-store.js'
import { resolveConfig } from '../../lib/host/config.js'

test('every concurrent first reader observes persisted settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-settings-load-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'selection-explain'))
    await writeFile(join(home, 'selection-explain', 'settings.json'), JSON.stringify({ values: { tools: false, historyMaxEntries: 7 } }))
    const config = resolveConfig({ tools: true, historyMaxEntries: 20 })
    const store = createSettingsStore({}, config)
    const read = async () => {
      await store.loadSettings()
      return { tools: config.tools, historyMaxEntries: config.historyMaxEntries }
    }
    const observed = await Promise.all([read(), read(), read()])
    for (const values of observed) assert.deepEqual(values, { tools: false, historyMaxEntries: 7 })
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
