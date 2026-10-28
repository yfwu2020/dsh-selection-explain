import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanShotTitle, createHistoryTextController, displayTextOf, foldHtmlToMarkdown, readSseText } from '../../src/client/history-text.js'

test('HTML history folding preserves structure and layout clues without executing markup', () => {
  const folded = foldHtmlToMarkdown('<html><head><script>ignored()</script></head><body style="background:#112233"><h1>Title</h1><p>Hello <strong>world</strong>.</p><div hidden>secret</div><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre> a\n b </pre><svg></svg></body></html>')
  assert.equal(folded, '# Title\nHello **world**.\n| A | B |\n|---|---|\n| 1 | 2 |\n```\n a\n b\n```\n[图示]\n\n（版式摘要：深色版；主色 #112233；标题 1 级 ×1；对比表 1 张；图示 1 个；强调/高亮 1 处）')
})

test('fold counters remain controller local, count a call once, and fold unfinished fences', () => {
  const first = createHistoryTextController()
  const other = createHistoryTextController()
  assert.equal(first.foldForHistory('plain original'), 'plain original')
  assert.equal(first.foldCount, 0)
  const source = 'before\n```html\n<p>First</p>\n```\nafter\n```html\n<h2>Second</h2>'
  const folded = first.foldForHistory(source)
  assert.match(folded, /^before\nFirst/)
  assert.match(folded, /after\n## Second/)
  assert.equal(first.foldCount, 1)
  assert.equal(other.foldCount, 0)
  first.foldCount = 8
  first.foldForHistory('```html\n<p>Third</p>\n```')
  assert.equal(first.foldCount, 9)
  assert.match(source, /<h2>Second<\/h2>$/)
})

test('attachment display removes only its leading model anchor and preserves source text', () => {
  const original = '【本条消息带了附件】image.png\nQuestion\n【本条消息带了附件】quoted material'
  const turn = { text: original, attachments: [{ kind: 'image' }] }
  assert.equal(displayTextOf(turn), 'Question\n【本条消息带了附件】quoted material')
  assert.equal(turn.text, original)
  assert.equal(displayTextOf({ text: original }), original)
})

test('screenshot titles ignore thought streams and retain the established cleanup limits', () => {
  const raw = ['data: {"type":"thought","delta":"reasoning"}', 'data: invalid', 'data: {"type":"delta","delta":"标题：预算"}', 'data: {"type":"delta","text":"逻辑。"}', 'data: [DONE]'].join('\n')
  assert.equal(cleanShotTitle(readSseText(raw)), '预算逻辑')
  assert.equal(cleanShotTitle('「A  B」'), 'A B')
  assert.equal(cleanShotTitle('a'.repeat(30)), 'a'.repeat(24))
})
