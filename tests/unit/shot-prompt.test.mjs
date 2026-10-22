/**
 * 截图提示词契约测试。
 *
 * 保护三件事：
 *   ① 只有"图里真有红框"的档位才说红框；仅选区/无框时不能让模型去找不存在的框。
 *   ② 留白档要说明"框外那一圈是特意保留的"，全屏档要说明"整块屏幕"。
 *   ③ 标题提示词与回答提示词口径一致，避免标题让模型"概括红框"而正文说没有框。
 */
import { SHOT_PROMPT, SHOT_TITLE_PROMPT, shotPromptFor, shotTitlePromptFor } from '../../lib/prompts.js'

let failed = 0
function assert(label, ok, detail) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  → ${detail}`}`)
  }
}

console.log('[1] 仅选区')
{
  const prompt = shotPromptFor('selection', false)
  const title = shotTitlePromptFor('selection', false)
  assert('明说这张图就是选区本身', prompt.includes('这张图**就是**他框选的那块区域本身'))
  assert('整段提示词完全不提“红框”', !prompt.includes('红框'))
  assert('标题也不提“红框”', !title.includes('红框'))
  assert('指代改成“图里的…”，不再说“框里的…”', prompt.includes('需要提及时说"图里的…"') && !prompt.includes('需要提及时说"框里的…"'))
  assert('标题改说“这张图里的对象”', title.includes('这张图里的对象'))
}

console.log('\n[2] 选区 + 留白')
{
  const prompt = shotPromptFor('margin', true)
  const title = shotTitlePromptFor('margin', true)
  assert('说明红框内是选区、框外是周边内容', prompt.includes('红色实线框内是选区') && prompt.includes('框外那一圈'))
  assert('标题仍以红框为焦点', title.includes('红框圈出的那个对象'))
}

console.log('\n[3] 全屏 / 整窗')
{
  assert('全屏说明是整块屏幕', shotPromptFor('screen', true).includes('整块屏幕'))
  assert('整窗沿用窗口口径', shotPromptFor('window', true).includes('红框周围的界面是上下文'))
  assert('默认 SHOT_PROMPT = 整窗 + 红框', SHOT_PROMPT === shotPromptFor('window', true))
  assert('默认 SHOT_TITLE_PROMPT = 整窗 + 红框', SHOT_TITLE_PROMPT === shotTitlePromptFor('window', true))
}

console.log('\n[4] 通用约束')
{
  const all = ['selection', 'margin', 'screen', 'window'].flatMap((scope) => [
    shotPromptFor(scope, scope !== 'selection'),
    shotTitlePromptFor(scope, scope !== 'selection'),
  ])
  const answers = ['selection', 'margin', 'screen', 'window'].map((scope) => shotPromptFor(scope, scope !== 'selection'))
  assert('没有未替换的占位符', all.every((text) => !/\{\{|\$\{|TODO/.test(text)))
  assert('都要求直接回答问题、不套翻译格式', answers.every((text) => text.includes('直接回答问题本身')))
  assert('看不清就说不清（避免猜图）', answers.every((text) => text.includes('看不清就说看不清')))
}

console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
