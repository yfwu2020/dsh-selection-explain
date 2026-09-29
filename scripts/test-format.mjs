/**
 * 会话格式契约：**写出去的那几个 shape 必须是当前内核认的**。
 *
 * 为什么单独一个文件：升格（`↗ 升格`）是往会话日志里**写**事件，写完由内核按
 * 会话格式做准入校验 —— 校验发生在**真实内核跑起来的那一刻**，不在构建期，
 * 所以离线测试全绿也照样能在用户机器上炸。v0.7.0 就是这么坏的：
 *
 *   `source: { kind: 'plugin', plugin: name }` 是会话格式 v3 的写法；
 *   v4 起该包装已退役，准入直接抛
 *     format v4 message requires a producer-owned source kind
 *   表现：升格请求返回 `ok: true`（只写进了内存里的会话面）→ 随后那轮 opener
 *   「本轮运行失败」→ 整个 artifact 一个字都没落盘，新会话只剩表头。
 *
 * 这里钉住两件**离线可判**的事实（都是当初真正踩坏的）：
 *   ① 上下文消息的 source.kind 是生产者自有的（`plugin:<插件名>`：非空、非裸 'plugin'），
 *      且真的被用在 `form: 'snapshot'` 的上下文消息上（不是写了个没人用的常量）；
 *   ② 构建产物里不再出现退役的 plugin 包装，以及升格那套 turn/step 骨架还在
 *      （骨架丢了消息就没有坐标，客户端不会把它显示成历史对话）。
 *
 * 跑法：node scripts/test-format.mjs（已挂进 npm test）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PLUGIN_SOURCE_KIND, name } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = readFileSync(resolve(HERE, '..', 'lib', 'index.js'), 'utf8')

let pass = 0
let fail = 0
const assert = (label, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ───────────────────────── ① 来源归属（v4 准入的那条线） ─────────────────────────
assert(
  '来源归属：上下文消息的 kind 与「插件名」一致（plugin:<插件名>）',
  PLUGIN_SOURCE_KIND === `plugin:${name}`,
  JSON.stringify({ PLUGIN_SOURCE_KIND, name }),
)
assert(
  '来源归属：kind 是生产者自有的（非空、非裸 plugin）',
  typeof PLUGIN_SOURCE_KIND === 'string' && PLUGIN_SOURCE_KIND.length > 'plugin:'.length && PLUGIN_SOURCE_KIND !== 'plugin',
  JSON.stringify(PLUGIN_SOURCE_KIND),
)
assert(
  '来源归属：第三方插件带 `plugin:` 命名空间（与内核 v3→v4 迁移的写法一致）',
  PLUGIN_SOURCE_KIND.startsWith('plugin:'),
  JSON.stringify(PLUGIN_SOURCE_KIND),
)

// ───────────────────────── ② 真的用上了（不是写了没人用的常量） ─────────────────────────
const used = BUNDLE.indexOf('kind: PLUGIN_SOURCE_KIND')
assert('使用点：源码里真的以 PLUGIN_SOURCE_KIND 作为 kind 写出消息', used >= 0, used >= 0 ? `偏移 ${used}` : '构建产物里找不到')
{
  // 同一个 source 字面量里：kind 之后要跟着 snapshot 呈现（客户端据此折叠成「上下文」行）
  const window = used >= 0 ? BUNDLE.slice(used, used + 240) : ''
  assert('使用点：同一条 source 带 `form: \'snapshot\'`（客户端才折叠成上下文行）', /form:\s*'snapshot'/.test(window), window ? JSON.stringify(window.slice(0, 80)) : '')
  assert('使用点：同一条 source 带 sections（snapshot 的命名分节，模型读的就是这些字）', /sections:\s*\[/.test(window), '')
}

// ───────────────────────── ③ 退役写法不再出现 ─────────────────────────
{
  // v3 的 plugin 包装：kind:'plugin' 后面紧跟一个 plugin 字段。
  // 注意这是**文本级**断言（连注释里都别写出那个形状）—— 宁可误报，也别漏报：
  // 这正是本次回归的形态，写进注释里也会把将来的人带沟里。
  const retired = /kind:\s*(["'])plugin\1\s*,\s*plugin\s*:/.exec(BUNDLE)
  assert(
    '退役写法：构建产物里没有 kind: plugin + plugin 字段的包装（v4 会当场拒掉）',
    retired === null,
    retired ? `offset ${retired.index}：${JSON.stringify(retired[0])}` : '',
  )
}

// ───────────────────────── ④ 升格那套 turn/step 骨架还在 ─────────────────────────
{
  // 客户端按 turn/step 事件给消息定位；少一个，历史消息就没有坐标、不显示成对话
  const skeleton = ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end']
  const missing = skeleton.filter((type) => !BUNDLE.includes(`'${type}'`))
  assert('升格骨架：turn/step 六个事件都还写着', missing.length === 0, missing.length ? `缺：${missing.join(', ')}` : '')
  assert('升格骨架：turn/end 带 reason（否则那轮不算收尾）', /reason:\s*\{\s*kind:\s*'completed'/.test(BUNDLE), '')
  assert('升格骨架：历史轮号从 1000 起（避开真实第一轮的号段）', /turnNo\s*=\s*1000/.test(BUNDLE), '')
}

console.log(`\n=== 会话格式契约测试结束：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
