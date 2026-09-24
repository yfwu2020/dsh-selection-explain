/**
 * 提示词契约测试 —— 保护提示词里的**关键约束**不被静默删除。
 *
 * 为什么需要它：提示词是产品行为的主要来源（两节结构、结论条、音标规则、来源判断、
 * 网页模式要求…），但它们只是字符串常量，改动时**没有类型检查也没有编译错误**。
 * 以前唯一的"验证"是手工看 PROMPTS.md，而那份快照会过期。这里把关键约束写成断言：
 * 谁误删了，CI 直接红。
 *
 * 读取方式：优先直接 import src/prompts.ts（Node ≥ 22.14 的类型剥离支持直接加载 .ts，
 * 与 GitHub Actions 的 Node 22.14 一致，无需编译步骤）；如果运行环境的 Node 太旧、
 * 不支持类型剥离，则回退到"读源码文本 + 解析数组字面量"，保证测试在任何 Node 上都能跑。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPTS_TS = resolve(HERE, '..', 'src', 'prompts.ts')

const NAMES = [
  'PROMPT_HEAD',
  'TWO_LAYER_RULE',
  'TRANSLATION_PROMPT',
  'CODE_PROMPT',
  'DETAIL_PROMPT',
  'CHAT_SYSTEM_PROMPT',
]

/** 回退方案：从源码文本里解析 `export const X = [ '...', ... ].join('\n')`。 */
function loadFromSource() {
  const src = readFileSync(PROMPTS_TS, 'utf8')
  const out = {}
  for (const name of NAMES) {
    const re = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]\\.join\\('\\\\n'\\)`)
    const m = src.match(re)
    if (!m) throw new Error(`回退解析失败：找不到 ${name}`)
    const body = m[1]
    // 元素既可能是字符串字面量，也可能是别的常量（片段复用），后者需要展开
    const parts = []
    const reElem = /'((?:[^'\\]|\\.)*)'|([A-Z_]+)/g
    let em
    while ((em = reElem.exec(body)) !== null) {
      if (em[1] !== undefined) parts.push(em[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'))
      else parts.push(out[em[2]] ?? '')
    }
    out[name] = parts.join('\n')
  }
  return out
}

let P
let loader = 'import src/prompts.ts（Node 类型剥离）'
try {
  P = await import(PROMPTS_TS)
} catch (error) {
  loader = `源码文本解析回退（类型剥离不可用：${error && error.message}）`
  P = loadFromSource()
}
const { CHAT_SYSTEM_PROMPT, CODE_PROMPT, DETAIL_PROMPT, PROMPT_HEAD, TRANSLATION_PROMPT, TWO_LAYER_RULE } = P
console.log(`提示词来源：${loader}\n`)

let failed = 0
let passed = 0
const assert = (label, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)
  if (ok) passed += 1
  else failed += 1
}
const has = (text, ...needles) => needles.every((n) => text.includes(n))

// ───────────────────────── 公共前言 ─────────────────────────
assert('人设：跨领域解读专家（含领域判断要求）', has(PROMPT_HEAD, '跨领域', '先判断【选中文字】实际属于哪个领域'))
assert('人设：领域判断是内部动作，不许写出来', has(PROMPT_HEAD, '不要把判断过程写出来'))
assert('人设：说明用户消息的形态（会话背景 + 选中文字）', has(PROMPT_HEAD, '【会话背景】', '【选中文字】'))

// ───────────────────────── 翻译 / 解读（首轮）─────────────────────────
assert('翻译提示词拼进了公共前言', TRANSLATION_PROMPT.startsWith(PROMPT_HEAD))
assert(
  '翻译：只输出一个章节（不许前言结语）',
  has(TRANSLATION_PROMPT, '本轮只输出一个章节', '不要输出其它章节', '不要前言与结语'),
)
assert(
  '结构契约：含英文 → 标题 `## 翻译`',
  has(TRANSLATION_PROMPT, '## 翻译'),
  '客户端按此标题切分渲染，改标题会同时破坏渲染',
)
assert(
  '结构契约：全中文 → 标题 `## 解读`',
  has(TRANSLATION_PROMPT, '## 解读'),
)
assert(
  '结论条：固定写成引用行「在本句中：」',
  has(TRANSLATION_PROMPT, '> 在本句中：'),
  '面板据此渲染成高亮结论条，格式不能丢',
)
assert(
  '音标规则：单词要标 IPA，且拿不准宁可不标',
  has(TRANSLATION_PROMPT, '音标', 'IPA') && /拿不准就不写|宁可不标/.test(TRANSLATION_PROMPT),
)
assert(
  '词义规则：词性与义项缩进两个空格作为子项',
  has(TRANSLATION_PROMPT, '缩进两个空格'),
)
assert(
  '语言自适应：按"有没有需要翻译的英文"分情形，只出一种',
  has(TRANSLATION_PROMPT, '有没有需要翻译的英文') && has(TRANSLATION_PROMPT, '情形一', '情形二'),
)

// ───────────────────────── 代码注释（首轮）─────────────────────────
assert('代码提示词拼进了公共前言', CODE_PROMPT.startsWith(PROMPT_HEAD))
assert('结构契约：代码模式标题 `## 注释`', has(CODE_PROMPT, '## 注释'))
assert(
  '代码模式：原代码逐字不变、注释插在语句前',
  has(CODE_PROMPT, '原代码') && /逐字不变|原样/.test(CODE_PROMPT),
)

// ───────────────────────── 详解（第二阶段）─────────────────────────
assert('详解提示词拼进了公共前言', DETAIL_PROMPT.startsWith(PROMPT_HEAD))
assert(
  '详解：只输出 `## 详解` 一节',
  has(DETAIL_PROMPT, '## 详解', '不要输出「## 翻译」或其它章节'),
)
assert(
  '详解：要求先判断这段文字的来源（真实内容 vs 示例/测试/引用）',
  has(DETAIL_PROMPT, '真实对话/正文', '示例', '测试用例', '演示输出', '引用别人的话'),
  '早期缺这条时，示例句会被当成真实陈述解释',
)
assert('详解：单词仍带音标', has(DETAIL_PROMPT, '音标', 'IPA'))

// ───────────────────────── 追问（小窗对话）─────────────────────────
assert(
  '追问：不要求两节结构，问什么答什么',
  has(CHAT_SYSTEM_PROMPT, '用户问什么就答什么', '不必把话题拉回选中文字'),
)
assert(
  '追问：不许重复前情已给的翻译/详解',
  has(CHAT_SYSTEM_PROMPT, '不用重复', '一句话带过'),
)
assert(
  '追问：网页模式要给完整单文件 HTML（内联样式与脚本）',
  has(CHAT_SYSTEM_PROMPT, '完整的单文件 HTML', '```html', '样式和脚本都内联'),
  '小窗会当场渲染成可交互页面，只给片段就渲染不出来',
)

// ───────────────────────── 卫生检查（防低级事故）─────────────────────────
const ALL = [PROMPT_HEAD, TRANSLATION_PROMPT, CODE_PROMPT, DETAIL_PROMPT, CHAT_SYSTEM_PROMPT].join('\n')
assert(
  '没有未替换的占位符（{{…}} / ${…} / TODO）',
  !/\{\{[^}]*\}\}|\$\{[^}]*\}|TODO/.test(ALL),
)
assert(
  '没有残留的调试口吻（console.log / debugger）',
  !/console\.log|debugger/.test(ALL),
)
assert(
  '提示词不是空串（防止整体被清空）',
  ALL.length > 2000,
  `总长 ${ALL.length}`,
)

// ───────────────────────── 已知问题（回归守卫）─────────────────────────
// TWO_LAYER_RULE 是「专业 + 说人话、别套模板」的写作规则，设计文档里把它当作刻意设计。
// 但自 2026-09 起它**从未被任何提示词数组引用**（只定义、不使用），即这条规则
// 实际上没有被注入给模型。这里先把它固化成断言：一旦有人接上引用，这个断言会失败，
// 提醒同时更新本测试与文档；反之如果它继续悬空，也永远看得见。
{
  const wired = [TRANSLATION_PROMPT, CODE_PROMPT, DETAIL_PROMPT, CHAT_SYSTEM_PROMPT].some((p) =>
    p.includes(TWO_LAYER_RULE),
  )
  assert(
    '已知问题：TWO_LAYER_RULE 目前未被任何提示词引用（悬空常量）',
    !wired,
    wired
      ? '已被引用 —— 说明这条规则接上了，请把本断言改成"必须被引用"并同步文档'
      : `规则全文 ${TWO_LAYER_RULE.length} 字，仅定义未使用`,
  )
}

console.log(`\n=== 提示词契约测试结束：${passed} 通过 / ${failed} 失败 ===`)
if (failed > 0) process.exitCode = 1
process.exit(process.exitCode ?? 0)
