/**
 * 小窗历史附件的预算与重建测试。
 *
 * 这段逻辑决定"第 N 轮还能不能看见第 1 轮那张图"，而且**错了也不报错**：
 * 图没回带，模型就只是"不知道"，界面上一切正常。所以每一条都必须钉住。
 */
import assert from 'node:assert/strict'
import {
  historyContentBlocks,
  omittedFileText,
  omittedImageText,
  readAttachmentRef,
  readHistoryAttachments,
} from '../../lib/host/history-attachments.js'

/** 造一个图片引用：bytes 可控，用来验字节预算。 */
function imageRef(id, bytes, name) {
  return { kind: 'image', ref: { attachmentId: `sha256:${id}`, mediaType: 'image/png', bytes, width: 800, height: 600, ...(name ? { name } : {}) } }
}
function fileRef(id, name) {
  return { kind: 'file', ref: { attachmentId: `sha256:${id}`, name: name, bytes: 1234 } }
}
const blocksOf = (content) => content.map((b) => b.type)
const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')

// ───────────────── 形状收敛：只认白名单字段 ─────────────────

assert.deepEqual(readAttachmentRef({ attachmentId: 'sha256:aa', name: 'x.png', bytes: 10, width: 4, height: 3, mediaType: 'image/png' }), {
  attachmentId: 'sha256:aa',
  name: 'x.png',
  bytes: 10,
  width: 4,
  height: 3,
  mediaType: 'image/png',
})
assert.equal(readAttachmentRef({ attachmentId: '' }), null, '空 id 不算引用')
assert.equal(readAttachmentRef({ name: 'x.png' }), null, '没有 attachmentId 就不是引用')
assert.equal(readAttachmentRef('sha256:aa'), null, '字符串不是引用')
// 多余字段一律丢掉（历史文件可以被手改，不能让脏字段进请求体）
assert.deepEqual(Object.keys(readAttachmentRef({ attachmentId: 'sha256:aa', evil: 'x', path: '/etc/passwd' })), ['attachmentId'])
assert.equal(readHistoryAttachments([{ kind: 'video', ref: { attachmentId: 'sha256:aa' } }]).length, 0, 'kind 不认识就丢')
assert.equal(readHistoryAttachments('nope').length, 0)
// 历史引用不能因模型恢复材料而挤掉原上传项；上传入口另行限制10件。
const many = readHistoryAttachments(Array.from({ length: 14 }, (_, i) => imageRef(String(i), 1)))
assert.equal(many.length, 14)
assert.equal(many[0].ref.attachmentId, 'sha256:0', '持久引用全部保留')

// Context capacity is planned before block reconstruction. No rolling image/file eviction.
{
  const turns = Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: `t${i}`,
    attachments: [imageRef(`i${i}`, 5 * 1024 * 1024), fileRef(`f${i}`, 'same-name.pdf')] }))
  const first = historyContentBlocks(turns)
  const later = historyContentBlocks([...turns, { role: 'user', text: 'new', attachments: [imageRef('new', 1000)] }])
  assert.equal(first.keptImages, 12)
  assert.equal(first.keptFiles, 12)
  assert.equal(first.omittedImages + first.omittedFiles, 0)
  assert.deepEqual(later.blocks.slice(0, 12), first.blocks, 'new attachments must not rewrite old occurrences')
  assert.equal(historyContentBlocks(turns, [imageRef('current', 1000)]).keptImages, 13)
}

// ───────────────── 顺序与退化：没有附件时逐字节等于从前 ─────────────────

{
  // 没有附件的历史 → 每轮就是**一个** text 块，和加附件之前完全一样
  const plan = historyContentBlocks([{ role: 'user', text: '问题' }, { role: 'assistant', text: '回答' }])
  assert.deepEqual(plan.blocks, [[{ type: 'text', text: '问题' }], [{ type: 'text', text: '回答' }]])
  assert.equal(plan.keptImages + plan.omittedImages + plan.keptFiles + plan.omittedFiles, 0)
}

{
  // 附件排在正文**前面**：先给材料，再读问题
  const plan = historyContentBlocks([{ role: 'user', text: '这个报表呢？', attachments: [fileRef('f', '报表.pdf')] }])
  assert.deepEqual(blocksOf(plan.blocks[0]), ['file', 'text'])
  assert.equal(plan.blocks[0][1].text, '这个报表呢？')
}

{
  // 既没文字也没附件 → 空块（调用方据此跳过这一轮，等价于从前的 if (!text) continue）
  assert.deepEqual(historyContentBlocks([{ role: 'user', text: '' }]).blocks, [[]])
  assert.deepEqual(historyContentBlocks([{ role: 'user' }]).blocks, [[]])
  // 有附件、没文字 → 不能丢（附件本身就是内容）
  const only = historyContentBlocks([{ role: 'user', text: '', attachments: [imageRef('a', 10)] }])
  assert.deepEqual(blocksOf(only.blocks[0]), ['image'])
}

// ───────────────── 降级文案：模型要认得出这是"省略" ─────────────────

{
  const text = omittedImageText({ attachmentId: 'sha256:' + 'a'.repeat(64), name: '截图.png', bytes: 46019, width: 810, height: 180 })
  assert.match(text, /图片已省略/)
  assert.match(text, /"截图\.png"/)
  assert.match(text, /810x180px/)
  assert.match(text, /46019 bytes/)
  assert.match(text, /sha256:aaaaaaaa/, '给短哈希，模型/日志里能对上是哪一张')
  assert.match(text, /重新读取原图/, '要给出路，不能只说"没有"')
  assert.match(omittedFileText({ attachmentId: 'sha256:bb', name: '报表.pdf' }), /报表\.pdf/)
}

console.log('=== 历史附件预算测试结束：全部通过 ===')

// ───────────────── 往返：存得下、读得回（含脏引用被拒） ─────────────────
//
// 这一节是**真起一个 http server 走路由**，不是直接调内部函数：
// "存进去读不回"正是加字段时最容易犯、又最难发现的错（两处 map 各写一遍就会漂）。

{
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createServer } = await import('node:http')
  const { createHistoryStore } = await import('../../lib/host/history-store.js')
  const { resolveConfig } = await import('../../lib/host/config.js')

  const home = mkdtempSync(join(tmpdir(), 'sel-hist-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const history = createHistoryStore(
    { logger: { info() {}, warn() {} }, get: () => undefined },
    resolveConfig({}),
    { loadLeaky: async () => {} },
    { loadSettings: async () => {} },
  )
  const server = createServer((req, res) => {
    Promise.resolve(history.handleHistory(req, res)).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = 'http://127.0.0.1:' + server.address().port
  const ref = { attachmentId: 'sha256:' + 'c'.repeat(64), mediaType: 'image/png', width: 810, height: 180, bytes: 46019, name: '截图.png' }
  try {
    // 存一条：一轮带图 + 一轮带文件
    const saved = await fetch(origin + '/selection-explain/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'k1',
        text: '选中文字',
        context: 'ctx',
        label: '测试',
        parts: { translation: 't', detail: 'd' },
        turns: [
          { role: 'user', text: '这张图里有什么？', attachments: [{ kind: 'image', ref }] },
          { role: 'assistant', text: '回答' },
          { role: 'user', text: '那个文件呢？', attachments: [{ kind: 'file', ref: { attachmentId: 'sha256:' + 'd'.repeat(64), name: '报表.pdf', bytes: 9035 } }] },
        ],
        pinned: false,
      }),
    }).then((r) => r.json())
    assert.equal(saved.ok, true)

    // 读回来：附件必须还在
    const got = await fetch(origin + '/selection-explain/api/history?key=k1').then((r) => r.json())
    assert.equal(got.entry.turns.length, 3)
    assert.equal(got.entry.turns[0].attachments[0].kind, 'image')
    assert.equal(got.entry.turns[0].attachments[0].ref.attachmentId, ref.attachmentId, '引用要逐字段活着回来')
    assert.equal(got.entry.turns[0].attachments[0].ref.name, '截图.png')
    assert.equal(got.entry.turns[0].attachments[0].ref.width, 810)
    assert.equal(got.entry.turns[1].attachments, undefined, '没有附件的那轮不该凭空多出字段')
    assert.equal(got.entry.turns[2].attachments[0].kind, 'file')

    // 落盘体积：只存引用 → 一条历史是几百字节，不是几 MB
    // （写盘是 800ms 防抖的，等一下再读文件）
    await new Promise((done) => setTimeout(done, 1000))
    const raw = readFileSync(join(home, 'selection-explain', 'history.json'), 'utf8')
    assert.equal(raw.includes('data:image'), false, '不能把 base64 写进历史')
    assert.equal(/[A-Za-z0-9+/]{400,}/.test(raw), false, '历史文件里不该出现大段 base64')
    const entryBytes = Buffer.byteLength(JSON.stringify(got.entry))
    assert.ok(entryBytes < 2000, `带两件附件的条目应该仍然很小，实测 ${entryBytes}B`)

    // 手改过的历史：脏引用必须在**读**的时候就被挡住（不能带进模型请求）。
    // 必须换一个**新实例**：同一个实例的 loadHistory 一旦跑过就锁死了（historyLoaded）。
    const file = join(home, 'selection-explain', 'history.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    parsed.entries[0].turns[0].attachments = [
      { kind: 'image', ref: { attachmentId: 'sha256:' + 'e'.repeat(64), path: '/etc/passwd', evil: 1 } },
      { kind: 'video', ref: { attachmentId: 'sha256:no' } },
      { kind: 'image', ref: { nothing: true } },
    ]
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify(parsed), 'utf8')
    const fresh = createHistoryStore(
      { logger: { info() {}, warn() {} }, get: () => undefined },
      resolveConfig({}),
      { loadLeaky: async () => {} },
      { loadSettings: async () => {} },
    )
    const server2 = createServer((req, res) => {
      Promise.resolve(fresh.handleHistory(req, res)).catch(() => {
        res.writeHead(500)
        res.end('{}')
      })
    })
    await new Promise((done) => server2.listen(0, '127.0.0.1', done))
    try {
      const reloaded = await fetch('http://127.0.0.1:' + server2.address().port + '/selection-explain/api/history?key=k1').then((r) => r.json())
      const kept = reloaded.entry.turns[0].attachments
      assert.equal(kept.length, 1, '只活下来那条合法的')
      assert.deepEqual(Object.keys(kept[0].ref), ['attachmentId'], '多余字段（path/evil）在读的时候就被剥掉')
      assert.equal(kept[0].ref.path, undefined, '本地路径绝不能进模型请求')
    } finally {
      await new Promise((done) => server2.close(done))
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await new Promise((done) => server.close(done))
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('=== 历史附件往返测试结束：全部通过 ===')

// ───────────────── 引用失效的识别（降级重试的判据） ─────────────────
{
  const { looksLikeAttachmentFailure } = await import('../../lib/host/history-attachments.js')
  // 实测撞到的那一条（码被包成 UNKNOWN，只剩措辞认得出）
  assert.equal(looksLikeAttachmentFailure('Attachment object is missing.', 'UNKNOWN'), true)
  assert.equal(looksLikeAttachmentFailure('attachment is corrupt'), true)
  assert.equal(looksLikeAttachmentFailure('', 'ATTACHMENT_CORRUPT'), true)
  assert.equal(looksLikeAttachmentFailure('x', 'IMAGE_OFFLOAD_REQUIRED'), true)
  // 不能误伤：普通上游错误必须照旧走"换档重试"那条路
  assert.equal(looksLikeAttachmentFailure('The model requires reasoning to be enabled.', 'INVALID_REQUEST'), false)
  assert.equal(looksLikeAttachmentFailure('rate limited', 'RATE_LIMIT'), false)
  assert.equal(looksLikeAttachmentFailure(undefined, undefined), false)
  assert.equal(looksLikeAttachmentFailure('attachment', ''), false, '只说 attachment 不算 —— 会误伤提示词里的同词')
}
console.log('=== 引用失效识别测试结束：全部通过 ===')
