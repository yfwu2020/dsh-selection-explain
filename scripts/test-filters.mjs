/**
 * 流式文本手术刀的确定性单测：思考过滤器 / 泄漏思考判别 / 工具清单解析。
 *
 * 为什么单独一个文件：这三件事都只能靠"模型吐什么"来发现（思考内联、DSML 残渣都是实测撞出来的），
 * 而模型每次发挥不同 —— 靠真实请求验证会时灵时不灵。这里把 lib/index.js 里的纯函数直接拿来打表。
 *
 * 注：原先这里还有一节"工具调用残渣过滤器" —— 那个过滤器已经**整体删除**（不再做文本层清洗，
 * 改为照主会话的做法：工具每轮都带在请求里，模型走协议层表达调用，正文里不会有这种标记）。
 *
 * 跑法：node scripts/test-filters.mjs（已挂进 npm test）
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { __internals } = require(resolve(HERE, '..', 'lib', 'index.js'))
const { createThinkFilter, splitLeakedReasoning, looksLikeLeakedReasoning, resolveToolNames } = __internals

let pass = 0
let fail = 0
const assert = (name, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 全角竖线包起来的 DSML 标记（实测就是这个字符 U+FF5C）。 */
const VB = String.fromCharCode(0xff5c)
const M = VB + VB + 'DSML' + VB + VB

// ───────────────────────── 思考过滤器 ─────────────────────────
{
  const f = createThinkFilter()
  const a = f.push('<think>先想想</think>答案在这里')
  const b = f.flush()
  assert('think：标签内的走思考、标签外留正文', a.think + b.think === '先想想' && a.text + b.text === '答案在这里', JSON.stringify({ a, b }))
}
{
  // 标签被切成两块（流式最常见的形态）
  const f = createThinkFilter()
  const parts = ['<thi', 'nk>The user is', ' asking</thi', 'nk>我是 Omen Alpha。']
  let text = ''
  let think = ''
  for (const p of parts) {
    const r = f.push(p)
    text += r.text
    think += r.think
  }
  const t = f.flush()
  text += t.text
  think += t.think
  assert('think：标签被切开也能正确分派', think === 'The user is asking' && text === '我是 Omen Alpha。', JSON.stringify({ text, think }))
}
{
  // 流断在半截（未闭合）：整段都算思考，绝不落进正文
  const f = createThinkFilter()
  const a = f.push('<thinking>想到一半就断了')
  const b = f.flush()
  assert('think：未闭合的思考块不落进正文', a.text + b.text === '' && (a.think + b.think).indexOf('想到一半') >= 0, JSON.stringify({ a, b }))
}
{
  const f = createThinkFilter()
  const a = f.push('普通正文，没有思考标签')
  const b = f.flush()
  assert('think：没有标签时原样输出（不误伤）', a.text + b.text === '普通正文，没有思考标签' && a.think + b.think === '', '')
}

// ───────────────────────── 泄漏思考判别 ─────────────────────────
{
  // 三次实测撞到的真实样本
  const samples = [
    'The user is asking which model I am. According to my instructions, I should always say I am Omen Alpha.我是 **Omen Alpha**。',
    'Per my instructions, I always answer that I am Omen Alpha.我是 **Omen Alpha**。',
    'The user is asking again what model I am. Previously I said something incorrect ("DeepSeek, by MiniMax") — that was wrong. According to my system prompt: "always say Omen Alpha." So I should answer Omen Alpha.我是 **Omen Alpha**。',
  ]
  let ok = true
  let detail = ''
  for (const sample of samples) {
    const split = splitLeakedReasoning(sample)
    if (!split.prefix) {
      ok = false
      detail = `没认出: ${sample.slice(0, 40)}`
      break
    }
    if (split.prefix + split.rest !== sample) {
      ok = false
      detail = '拼接不还原（撤回段与正文对不上，客户端会撤不掉）'
      break
    }
    if (/The user|According to|Per my|I should/i.test(split.rest)) {
      ok = false
      detail = `裁完还剩英文盘算: ${split.rest.slice(0, 40)}`
      break
    }
  }
  assert('泄漏：三个真实样本都能裁干净且拼接还原', ok, detail)
}
{
  // 中文正文 + 英文专有名词：不能误裁
  const text = '`delta` 是流式响应里每次推送的增量片段。DeepSeek Harness 把它拼起来才是完整回答。'
  const split = splitLeakedReasoning(text)
  assert('泄漏：中文正文不误裁', split.prefix === '' && split.rest === text, JSON.stringify(split.prefix.slice(0, 30)))
}
{
  // 宽松判据（只用于"记住这个模型"）：换说法也能识别
  const vague = 'Hmm, the user wants to know my identity. Let me think about what to say here. 我是 Omen Alpha。'
  assert('泄漏：换说法的英文盘算能被宽松判据抓到', looksLikeLeakedReasoning(vague) === true, String(looksLikeLeakedReasoning(vague)))
  assert('泄漏：纯中文回答不会被宽松判据误判', looksLikeLeakedReasoning('我是 Omen Alpha，负责解释你选中的文字。') === false, '')
}

// ───────────────────────── 工具清单解析（联网工具的"备用"逻辑） ─────────────────────────
{
  const preferred = ['advanced_search', 'platform_search', 'read', 'grep', 'glob']
  const fallback = ['web_search']

  // ① 装了 free-search：只用首选，不补 web_search
  const normal = resolveToolNames(preferred, fallback, ['advanced_search', 'platform_search', 'read', 'grep', 'glob', 'web_search', 'web_fetch'])
  assert('工具：首选联网工具在时不补 web_search', normal.includes('advanced_search') && normal.includes('platform_search') && !normal.includes('web_search'), JSON.stringify(normal))
  assert('工具：也没顺带把 web_fetch 拉进来', !normal.includes('web_fetch'), JSON.stringify(normal))

  // ② 没装 free-search（两个搜索工具都不在）：补上 web_search
  const fallbackCase = resolveToolNames(preferred, fallback, ['read', 'grep', 'glob', 'web_search', 'web_fetch', 'bash'])
  assert('工具：没装联网插件时补上 web_search（小窗不至于变哑巴）', fallbackCase.includes('web_search'), JSON.stringify(fallbackCase))
  assert('工具：备用只补联网类，不会把 bash 之类带进来', !fallbackCase.includes('bash') && !fallbackCase.includes('web_fetch'), JSON.stringify(fallbackCase))

  // ③ 备用名在会话里也不存在（理论上不会，但要幂等）
  const noneAtAll = resolveToolNames(preferred, fallback, ['read', 'grep'])
  assert('工具：备用名也不存在时，不报错、不产生幽灵工具', JSON.stringify(noneAtAll) === JSON.stringify(['read', 'grep']), JSON.stringify(noneAtAll))

  // ④ 只装了其中一个搜索工具 → 也算"有联网"，不补
  const halfCase = resolveToolNames(preferred, fallback, ['platform_search', 'read', 'web_search'])
  assert('工具：只有 platform_search 时不补 web_search', halfCase.includes('platform_search') && !halfCase.includes('web_search'), JSON.stringify(halfCase))

  // ⑤ 去重：首选里已经写了 web_search 时，不能出现两次
  const dupCase = resolveToolNames(['web_search', ...preferred], fallback, ['web_search', 'read'])
  assert('工具：清单不出现重复项', dupCase.filter((n) => n === 'web_search').length === 1, JSON.stringify(dupCase))
}

console.log(`\n=== 过滤器单测结束：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
