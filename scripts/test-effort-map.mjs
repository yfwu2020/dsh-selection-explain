/**
 * 四格 → 模型真实档位：映射规则的确定性单测（不碰网络、不依赖宿主）。
 *
 * 为什么要有这一份：设置页那四个格子（关/低/高/最高）是**插件自己的词汇**，而每个模型
 * 声明的档位词汇表各不相同 —— 本机 74 个模型上就数出七种（off>low>high>max、
 * low>high>max、high>max、off>minimal>low>medium>high、off>low>medium>high>xhigh>max、
 * low>medium>high>xhigh、minimal>low>medium>high>xhigh、只有 max、以及一档都不声明）。
 * 映射是**运行时按模型声明现算**的（没有任何按模型写死的表），所以这份用例既锁住
 * "见过的那几种"，也用**随机生成、插件作者没见过的词汇表**验两条不变量：
 *   ① 落点永远是这个模型声明过的档位（否则 dsh-llm 直接抛 UNSUPPORTED_REASONING_EFFORT）；
 *   ② 关 ≤ 低 ≤ 高 ≤ 最高（按声明的先后顺序，声明都是升序）。
 */
import { __internals } from '../lib/index.js'

const { mapEffortToModel, effortMapOf } = __internals

let failed = 0
function assert(name, ok, detail) {
  if (ok) {
    console.log('  ✓ ' + name)
  } else {
    failed += 1
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''))
  }
}

/** 把一个模型声明的 id 列表转成映射函数用的形状（name 就取 id）。 */
const decl = (ids) => ids.map((id) => ({ id, name: id }))
/** 四格一次算完，返回 ['关','低','高','最高'] 的落点。 */
const four = (ids) => {
  const map = effortMapOf(decl(ids))
  return [map.off, map.low, map.high, map.max]
}
const show = (ids) => {
  const r = four(ids)
  return `${ids.join('>')}  →  关=${r[0]} 低=${r[1]} 高=${r[2]} 最高=${r[3]}`
}

console.log('[1] 本机真实词汇表（2026-10-10 从 /models 抓下来的形状）')
const REAL = [
  // 最常见：四档，名字与四个格子一一对应 → 恒等映射
  { ids: ['off', 'low', 'high', 'max'], want: ['off', 'low', 'high', 'max'] },
  // 六档，中间多出 medium / xhigh：仍然落在名为 low / high 的那两档上
  { ids: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], want: ['off', 'low', 'high', 'max'] },
  // 没有 off（deepseek-v4.1-flash 这种）：关落到它最弱的那档
  { ids: ['low', 'high', 'max'], want: ['low', 'high', 'high', 'max'] },
  // 只有两档（deepseek-v4-pro / glm-5.2）：最弱留给关，其余都只能落最强
  { ids: ['high', 'max'], want: ['high', 'max', 'max', 'max'] },
  // 五档且没有 max（glm-5.1 / mimo-*）：最高落到它最强的那档
  { ids: ['off', 'minimal', 'low', 'medium', 'high'], want: ['off', 'low', 'medium', 'high'] },
  // 四档但顶档叫 xhigh（qwen3.8-max/flash）
  { ids: ['off', 'low', 'medium', 'xhigh'], want: ['off', 'low', 'medium', 'xhigh'] },
  // 没有 off 但有 xhigh（grok-4.6/4.7）
  { ids: ['low', 'medium', 'high', 'xhigh'], want: ['low', 'medium', 'high', 'xhigh'] },
  // 最少见的一档（kimi-k3 只有 max）：四格都只能落它
  { ids: ['max'], want: ['max', 'max', 'max', 'max'] },
  // 完全不支持推理（typesafe/jev-latest）：四个格子都空 → 调用方据此不发档位
  { ids: [], want: ['', '', '', ''] },
  // 两档（hy4-preview / kimi-k2.6）：关=off，其余落它唯一的高档
  { ids: ['off', 'high'], want: ['off', 'high', 'high', 'high'] },
]
for (const item of REAL) {
  const got = four(item.ids)
  assert(show(item.ids), JSON.stringify(got) === JSON.stringify(item.want), '期望 ' + JSON.stringify(item.want))
}

console.log('\n[2] 没见过的词汇表也要落位（别的 adapter 可能叫 a/b/c、tier1…、或数字）')
const ALIEN = [
  { ids: ['a', 'b', 'c', 'd'], want: ['a', 'b', 'c', 'd'] },
  { ids: ['tier1', 'tier2', 'tier3', 'tier4', 'tier5'], want: ['tier1', 'tier2', 'tier4', 'tier5'] },
  { ids: ['1', '2', '3'], want: ['1', '2', '2', '3'] },
  { ids: ['x', 'y'], want: ['x', 'y', 'y', 'y'] },
  // 半认半不认：'low' 认得出深度，其余按位置插值
  { ids: ['stage0', 'low', 'stage2', 'stage3'], want: ['stage0', 'low', 'stage2', 'stage3'] },
]
for (const item of ALIEN) {
  const got = four(item.ids)
  assert(show(item.ids), JSON.stringify(got) === JSON.stringify(item.want), '期望 ' + JSON.stringify(item.want))
}

console.log('\n[3] 两条不变量：落点必须已声明；关 ≤ 低 ≤ 高 ≤ 最高（按声明顺序）')
/** 造一批"升序"的词汇表：长度 1..7，名字在几套风格之间轮换（含插件作者没见过的）。 */
const NAMERS = [
  (i) => ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'][i] ?? `known${i}`,
  (i) => ['none', 'minimal', 'light', 'mid', 'high', 'max', 'highest'][i] ?? `style${i}`,
  (i) => `tier${i + 1}`,
  (i) => String.fromCharCode(97 + i), // a, b, c…
  (i) => `档位${i + 1}`,
  (i) => `stage${i * 2}`,
]
let cases = 0
let bad = 0
for (let n = 1; n <= 7; n += 1) {
  for (let style = 0; style < NAMERS.length; style += 1) {
    const ids = []
    for (let i = 0; i < n; i += 1) ids.push(NAMERS[style](i))
    const got = four(ids)
    cases += 1
    // ① 每个落点都必须是这个模型声明过的 id
    for (const value of got) {
      if (!ids.includes(value)) {
        bad += 1
        console.log('  ✗ 未声明的落点：' + show(ids) + ' 里出现了 ' + JSON.stringify(value))
        break
      }
    }
    // ② 单调：按下标比较（声明都是升序）
    const order = got.map((value) => ids.indexOf(value))
    const monotone = order.every((value, index) => index === 0 || order[index - 1] <= value)
    if (!monotone) {
      bad += 1
      console.log('  ✗ 非单调：' + show(ids) + ' 下标=' + JSON.stringify(order))
    }
    // ③ 两端钉死：关 = 最弱、最高 = 最强（列表升序 = 下标顺序）
    if (got[0] !== ids[0] || got[3] !== ids[n - 1]) {
      bad += 1
      console.log('  ✗ 两端没钉住：' + show(ids))
    }
  }
}
assert(`${cases} 组合成词汇表全部满足不变量`, bad === 0, `${bad} 组有问题`)

console.log('\n[4] 显式值、大小写与连字符都认（adapter 的显示名可能写成 "X-High" / "Very High"）')
assert("显示名 'X-High' 认成最高档之下的那一档", mapEffortToModel([{ id: 'a', name: 'Low' }, { id: 'b', name: 'X-High' }], 'max') === 'b')
assert("id 大写 'OFF' 也算关", mapEffortToModel([{ id: 'OFF', name: 'Off' }, { id: 'HIGH', name: 'High' }], 'off') === 'OFF')
assert('没见过的规范值按"关"处理（不会越界）', mapEffortToModel(decl(['off', 'low', 'high']), 'something-else') === 'off')

console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
