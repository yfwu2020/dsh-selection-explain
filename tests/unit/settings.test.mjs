/**
 * 设置模块契约测试。
 *
 * 保护三件事：
 *   ① spec 与 Config **不漂**：设置页能改的键，必须个个都是 Config 里真实存在的字段，
 *      且不能漏掉任何一个可改字段 —— 漏了就是"设置页里找不到这一项"，属于静默丢功能。
 *   ② 归一函数的边界行为：clamp / 拒未知键 / 拒错类型 / seg 白名单 / text 去空白与超长。
 *   ③ 分组结构可用：id 唯一、每项都有 label 与 hint（设置页的说明栏全靠它）。
 *
 * 读取方式与 test-prompt.mjs 一致：Node ≥ 22.14 直接 import src/settings.ts（类型剥离）；
 * 旧的 Node 就退化成"读源码文本 + 解析"，保证任何环境都能跑。
 */
import { Config } from '../../lib/host/config.js'
import { CONFIG_DEFAULTS } from '../../lib/config-values.js'
import { SETTINGS_GROUPS, SETTINGS_KEYS, SETTINGS_VIRTUAL_KEYS, SETTINGS_ITEMS, normalizeSettingsPatch, normalizeStoredSettings, buildSettingsPayload } from '../../lib/settings.js'

let failed = 0
function assert(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  → ${detail}`}`)
  }
}

// ───────────────────────── ① spec ↔ Config 不漂 ─────────────────────────
console.log('\n[1] spec 与 host Config 对齐')

const ifaceKeys = Object.keys(CONFIG_DEFAULTS)
const schemaKeys = Object.keys(Config.dict)

// ① -a 每个**可写**键都必须是真实的 Config 字段
//      （虚拟键如 modelChoice 不出现在 SETTINGS_KEYS 里，它已被展开成 provider + model）
{
  const missing = SETTINGS_KEYS.filter((key) => ifaceKeys && !ifaceKeys.includes(key))
  assert(
    '设置页可写的每个键都是 Config 的真实字段（没有拼错的）',
    missing.length === 0,
    missing.length ? `Config 里没有：${missing.join(', ')}` : `${SETTINGS_KEYS.length} 个键全部命中`,
  )
  // 反过来：每个 spec 条目的 key 也必须"有名有姓"——要么是真实字段，要么声明了 keys
  const loose = SETTINGS_ITEMS.filter(
    (item) => ifaceKeys && !ifaceKeys.includes(item.key) && !Array.isArray(item.keys),
  ).map((item) => item.key)
  assert(
    'spec 里没有"既不认识、也没说明覆盖谁"的字段',
    loose.length === 0,
    loose.length ? `来路不明：${loose.join(', ')}` : '全部有出处',
  )
}

// ① -b Config 里每个字段都要在设置页露面（漏了就等于"改不了"）
{
  const hidden = ['chatProvider', 'chatModel', 'maxTokens', 'temperature', 'resultCacheTtlMs']
  const missing = (ifaceKeys ?? []).filter((key) => !SETTINGS_KEYS.includes(key) && !hidden.includes(key))
  assert(
    '可见配置均可修改，明确移除的兼容字段不展示',
    missing.length === 0,
    missing.length ? `设置页缺：${missing.join(', ')}` : `${(ifaceKeys ?? []).length} 个字段全部覆盖`,
  )
}

// ① -c interface 与 schema 必须同集合（漂了就是"类型说有、实际不生效"）
{
  const onlyIface = (ifaceKeys ?? []).filter((key) => schemaKeys && !schemaKeys.includes(key))
  const onlySchema = (schemaKeys ?? []).filter((key) => ifaceKeys && !ifaceKeys.includes(key))
  assert(
    'Config 的 interface 与 z.object schema 字段一致',
    onlyIface.length === 0 && onlySchema.length === 0,
    `仅 interface：${onlyIface.join(', ') || '无'}｜仅 schema：${onlySchema.join(', ') || '无'}`,
  )
}

// ───────────────────────── ② 分组结构 ─────────────────────────
console.log('\n[2] 分组结构')
{
  const ids = SETTINGS_GROUPS.map((g) => g.id)
  assert('分组 id 唯一', new Set(ids).size === ids.length, ids.join(', '))

  const allItems = SETTINGS_ITEMS
  const keys = allItems.map((i) => i.key)
  assert('字段 key 全局唯一（没有在两个分组里重复出现）', new Set(keys).size === keys.length,
    keys.filter((k, idx) => keys.indexOf(k) !== idx).join(', ') || '无重复')

  assert('每项都有非空 label', allItems.every((i) => typeof i.label === 'string' && i.label.length > 0))
  assert('说明为字符串，允许省略重复说明', allItems.every((i) => typeof i.hint === 'string'))
  assert('设置只保留一个模型选择', allItems.filter(i => i.kind === 'model').length === 1)
  assert('移除输出上限、温度、缓存与独立追问模型', !allItems.some(i => ['maxTokens', 'temperature', 'resultCacheTtlMs', 'chatModelChoice'].includes(i.key)))
  for (const group of SETTINGS_GROUPS) {
    const visible = (group.sections || []).flatMap(section => section.keys)
    assert(group.label + ' 的页内分组覆盖每个字段一次', visible.length === group.items.length && new Set(visible).size === visible.length && group.items.every(i => visible.includes(i.key)))
    assert(group.label + ' 的禁用依赖指向开关', group.items.every(i => !i.enabledBy || group.items.some(parent => parent.key === i.enabledBy && parent.kind === 'switch')))
  }
  assert('每组都有非空 label', SETTINGS_GROUPS.every((g) => typeof g.label === 'string' && g.label.length > 0))
  {
    const expanded = allItems.flatMap((i) => i.keys ?? [i.key])
    assert(
      'SETTINGS_KEYS = 各条目展开（虚拟键展开成它覆盖的真实字段）',
      SETTINGS_KEYS.length === expanded.length && SETTINGS_KEYS.every((k) => expanded.includes(k)),
      `${SETTINGS_KEYS.length} vs ${expanded.length}`,
    )
  }

  const segs = allItems.filter((i) => i.kind === 'seg')
  assert('每个 seg 都有 options', segs.every((i) => Array.isArray(i.options) && i.options.length > 0),
    segs.filter((i) => !(i.options || []).length).map((i) => i.key).join(', ') || '无')

  const nums = allItems.filter((i) => i.kind === 'number')
  assert('每个 number 都有 min/max 且 min < max',
    nums.every((i) => typeof i.min === 'number' && typeof i.max === 'number' && i.min < i.max),
    nums.filter((i) => !(i.min < i.max)).map((i) => i.key).join(', ') || '无')
}

// ───────────────────────── ③ 归一函数 ─────────────────────────
console.log('\n[3] normalizeSettingsPatch')

{
  const r = normalizeSettingsPatch({ maxSelectionChars: 999999 })
  assert('number 超上限被 clamp', r.values.maxSelectionChars === 20000, String(r.values.maxSelectionChars))

  const r2 = normalizeSettingsPatch({ maxSelectionChars: 1 })
  assert('number 低于下限被 clamp', r2.values.maxSelectionChars === 20, String(r2.values.maxSelectionChars))

  const r3 = normalizeSettingsPatch({ nope: 1 })
  assert('未知键被拒（不能往配置里塞任意字段）',
    r3.rejected.length === 1 && r3.rejected[0].key === 'nope' && Object.keys(r3.values).length === 0)

  const r4 = normalizeSettingsPatch({ tools: 'true' })
  assert('switch 只接受真布尔（字符串不猜）', r4.rejected.length === 1 && r4.values.tools === undefined)

  const r5 = normalizeSettingsPatch({ reasoningEffort: 'max' })
  assert('seg 接受白名单内的值', r5.values.reasoningEffort === 'max')

  const r6 = normalizeSettingsPatch({ reasoningEffort: 'ultra' })
  assert('seg 拒绝白名单外的值', r6.rejected.length === 1 && r6.values.reasoningEffort === undefined)

  const r7 = normalizeSettingsPatch({ toolNames: '  advanced_search, platform_search  ' })
  assert('text 去掉首尾空白', r7.values.toolNames === 'advanced_search, platform_search', JSON.stringify(r7.values.toolNames))

  const r8 = normalizeSettingsPatch({ toolNames: 'x'.repeat(3000) })
  assert('text 超长被拒', r8.rejected.length === 1 && r8.values.toolNames === undefined)

  // 虚拟键（模型下拉）不能直接写：它必须展开成 provider + model 再提交，
  // 否则会悄悄落进一个并不存在的配置字段
  const rv = normalizeSettingsPatch({ modelChoice: 'opencode-go/deepseek-v4.1-flash' })
  assert('虚拟键 modelChoice 被拒（要求分别提交 provider/model）',
    rv.rejected.length === 1 && rv.values.modelChoice === undefined && rv.values.provider === undefined,
    JSON.stringify(rv.rejected))

  // 模型下拉实际提交的两个键都要能过
  const rm = normalizeSettingsPatch({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert('模型下拉展开成 provider + model 后可写入',
    rm.values.provider === 'opencode-go' && rm.values.model === 'deepseek-v4.1-flash' && rm.rejected.length === 0,
    JSON.stringify(rm.values))

  const r9 = normalizeSettingsPatch({ tools: false, pillIdleMs: 500 })
  assert('一次多个键各自独立处理（坏的拒、好的留）',
    r9.values.tools === false && r9.values.pillIdleMs === 2000 && r9.rejected.length === 0,
    JSON.stringify(r9.values))

  const r10 = normalizeSettingsPatch(null)
  assert('非对象输入被拒且不抛异常', r10.ok === false && Object.keys(r10.values).length === 0, JSON.stringify(r10.rejected))

  const r11 = normalizeSettingsPatch({ temperature: -1, chatModel: 'old', resultCacheTtlMs: 200 })
  assert('隐藏的兼容配置不再允许设置页写入', r11.rejected.length === 3)
}

// ───────────────────────── ④ 截图取景 ─────────────────────────
console.log('\n[4] 截图取景设置')
{
  assert('默认：弹卡片=整窗、进输入框=仅选区、留白 48',
    CONFIG_DEFAULTS.shotCardScope === 'window' && CONFIG_DEFAULTS.shotPanelScope === 'selection' && CONFIG_DEFAULTS.shotMargin === 48,
    JSON.stringify({ card: CONFIG_DEFAULTS.shotCardScope, panel: CONFIG_DEFAULTS.shotPanelScope, margin: CONFIG_DEFAULTS.shotMargin }))

  const specs = new Map(SETTINGS_ITEMS.map((item) => [item.key, item]))
  assert('两种模式都有四档 range 选项',
    ['shotCardScope', 'shotPanelScope'].every((key) => {
      const spec = specs.get(key)
      return spec && spec.kind === 'seg' && JSON.stringify(spec.options) === JSON.stringify(['screen', 'window', 'margin', 'selection'])
    }))

  const good = normalizeSettingsPatch({ shotCardScope: 'selection', shotPanelScope: 'margin', shotMargin: 64 })
  assert('合法取景值直接通过',
    good.rejected.length === 0 && good.values.shotCardScope === 'selection' && good.values.shotPanelScope === 'margin' && good.values.shotMargin === 64,
    JSON.stringify(good))

  const bad = normalizeSettingsPatch({ shotCardScope: 'fullscreen' })
  assert('未知取景档位被拒', bad.rejected.length === 1 && bad.values.shotCardScope === undefined)

  assert('留白被 clamp 到 0–400',
    normalizeSettingsPatch({ shotMargin: -10 }).values.shotMargin === 0 &&
      normalizeSettingsPatch({ shotMargin: 9999 }).values.shotMargin === 400)
}

// Session route behavior is covered by test-route-cache and test-model-follow.

// ───────────────────────── ⑤ payload ─────────────────────────
console.log('\n[5] buildSettingsPayload')
{
  const values = { tools: true }
  const defaults = { tools: true, provider: '' }
  const p = buildSettingsPayload(values, defaults)
  assert('payload 带上 groups（客户端据此渲染，不做业务判断）', Array.isArray(p.groups) && p.groups.length === SETTINGS_GROUPS.length)
  assert('payload 带上 values 与 defaults', p.values === values && p.defaults === defaults)
}

assert('旧配置的隐藏数值继续保留，独立追问模型不再加载', JSON.stringify(normalizeStoredSettings({ maxTokens: 1200, temperature: 0.3, resultCacheTtlMs: 600, chatProvider: 'old', chatModel: 'old', provider: 'new', model: 'shared' })) === JSON.stringify({ provider: 'new', model: 'shared', maxTokens: 1200, temperature: 0.3, resultCacheTtlMs: 600 }))
console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
