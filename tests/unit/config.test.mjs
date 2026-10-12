import assert from 'node:assert/strict'
import { resolveConfig, Config } from '../../lib/host/config.js'
import { SETTINGS_ITEMS, normalizeSettingsPatch } from '../../lib/settings.js'
// Changing a shared numeric range must affect both UI metadata and normalization.
const shared = await import('../../lib/config-values.js').catch(() => null)
assert.ok(shared, 'shared configuration definitions must be buildable without importing the plugin entry')
const { CONFIG_DEFAULTS, CONFIG_LIMITS } = shared
assert.equal(resolveConfig({}).maxSelectionChars, 4000)
assert.equal(resolveConfig({ provider: 'p1', historyMaxEntries: 0 }).historyMaxEntries, 0)
assert.equal(resolveConfig({ provider: null }).provider, '')
assert.equal(Config({}).timeoutMs, 300000)
assert.deepEqual(resolveConfig({}), CONFIG_DEFAULTS)
for (const spec of SETTINGS_ITEMS.filter(item => item.kind === 'number')) {
  assert.equal(spec.min, CONFIG_LIMITS[spec.key].min)
  assert.equal(spec.max, CONFIG_LIMITS[spec.key].max)
  assert.equal(normalizeSettingsPatch({ [spec.key]: Number.MAX_SAFE_INTEGER }).values[spec.key], spec.max)
}
console.log('PASS shared configuration defaults and numeric boundaries')
