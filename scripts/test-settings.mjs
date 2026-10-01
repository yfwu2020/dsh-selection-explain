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
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SETTINGS_TS = resolve(ROOT, 'src', 'settings.ts')
const INDEX_TS = resolve(ROOT, 'src', 'index.ts')

let SETTINGS_GROUPS
let SETTINGS_KEYS
let SETTINGS_VIRTUAL_KEYS
let SETTINGS_ITEMS
let normalizeSettingsPatch
let normalizeStoredSettings
let buildSettingsPayload

try {
  const mod = await import(SETTINGS_TS)
  SETTINGS_GROUPS = mod.SETTINGS_GROUPS
  SETTINGS_KEYS = mod.SETTINGS_KEYS
  SETTINGS_VIRTUAL_KEYS = mod.SETTINGS_VIRTUAL_KEYS
  SETTINGS_ITEMS = mod.SETTINGS_ITEMS
  normalizeSettingsPatch = mod.normalizeSettingsPatch
  normalizeStoredSettings = mod.normalizeStoredSettings
  buildSettingsPayload = mod.buildSettingsPayload
} catch {
  console.error('✗ 无法加载 src/settings.ts（需要 Node ≥ 22.14 的类型剥离）')
  process.exit(1)
}

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

const indexSrc = readFileSync(INDEX_TS, 'utf8')

/** 从 index.ts 里抠出 `export interface Config { ... }` 的字段名。 */
function configInterfaceKeys(src) {
  const start = src.indexOf('export interface Config {')
  if (start < 0) return null
  // 从 { 开始配对花括号，避免被字段里的对象类型提前截断
  let i = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) { end = j; break }
    }
  }
  if (end < 0) return null
  const body = src.slice(i + 1, end)
  // 顶层字段：`name: type`（跳过注释行、跳过嵌套行——嵌套的缩进更深）
  const keys = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '')
    const m = /^\s{2}([A-Za-z_$][\w$]*)\s*:\s*(.+)$/.exec(line)
    if (!m) continue
    keys.push(m[1])
  }
  return keys
}

/** 从 index.ts 里抠出 `export const Config = z.object({ ... })` 的键。 */
function configSchemaKeys(src) {
  const at = src.indexOf('export const Config = z.object({')
  if (at < 0) return null
  let i = src.indexOf('{', at)
  let depth = 0
  let end = -1
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) { end = j; break }
    }
  }
  if (end < 0) return null
  const body = src.slice(i + 1, end)
  const keys = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '')
    const m = /^\s{2}([A-Za-z_$][\w$]*)\s*:/.exec(line)
    if (!m) continue
    // z.xxx() 这种才是字段；`/** ... */` 与嵌套对象跳过（嵌套行缩进更深）
    if (!/z\.[A-Za-z]/.test(line)) continue
    keys.push(m[1])
  }
  return keys
}

const ifaceKeys = configInterfaceKeys(indexSrc)
const schemaKeys = configSchemaKeys(indexSrc)

assert('能解析出 Config interface 的字段', Array.isArray(ifaceKeys) && ifaceKeys.length > 0, ifaceKeys ? `${ifaceKeys.length} 个` : '解析失败')
assert('能解析出 Config schema 的字段', Array.isArray(schemaKeys) && schemaKeys.length > 0, schemaKeys ? `${schemaKeys.length} 个` : '解析失败')

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

// ───────────────────────── ④ 会话级模型解析（host 源码契约） ─────────────────────────
// 用户报的问题：括号里显示的模型跟所在会话对不上。
// 根因：插件解析路由时只取 agentDefaultModel.currentSelection()（**全局默认**），
//       而会话是各自选模型的 —— 两个会话用不同模型时，插件对两个都用同一个默认值。
// 修法：从会话原始事件里读最后一条 model/selection，按会话解析。
console.log('\n[4] 会话级模型解析')
{
  assert('resolveRoute 接受「本会话的模型」参数',
    /const resolveRoute = \([\s\S]{0,900}?sessionModel\?/.test(indexSrc),
    'resolveRoute 签名里没有 sessionModel')
  assert('会话模型的优先级在插件配置之后、全局默认之前',
    /config\.provider && config\.model\) return[\s\S]{0,400}?sessionModel\?\.provider[\s\S]{0,400}?currentSelection/.test(indexSrc),
    '优先级顺序不对（应为 配置 → 会话 → 全局默认）')
  assert('从会话原始事件里读 model/selection（不是消息表面）',
    /readSession/.test(indexSrc) && /typed\.type !== 'model\/selection'/.test(indexSrc),
    '没有从原始事件里取 model/selection')
  assert('/models 与 /ping 都按 sessionId 解析',
    /resolveRoute\(undefined, await sessionModelOf\(modelsSessionId\)\)/.test(indexSrc) &&
    /resolveRoute\(undefined, await sessionModelOf\(pingSessionId\)\)/.test(indexSrc),
    '/models 或 /ping 没接会话')
  assert('analyze 按请求体的 sessionId 解析',
    /resolveRoute\(override, await sessionModelOf\(sessionIdOf\(body\)\), isChatRound\)/.test(indexSrc),
    'analyze 没接会话')
  assert('旧追问配置不能覆盖统一模型', !/if \(chat && config\.chatProvider/.test(indexSrc))

}

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
