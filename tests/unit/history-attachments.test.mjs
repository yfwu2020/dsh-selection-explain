/**
 * 小窗历史附件的预算与重建测试。
 *
 * 这段逻辑决定"第 N 轮还能不能看见第 1 轮那张图"，而且**错了也不报错**：
 * 图没回带，模型就只是"不知道"，界面上一切正常。所以每一条都必须钉住。
 */
import assert from 'node:assert/strict'
import {
  HISTORY_FILE_MAX,
  HISTORY_IMAGE_BYTES,
  HISTORY_IMAGE_MAX,
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
// 单轮条数上限：**保留最后几件**（用户最后加的最要紧）
const many = readHistoryAttachments(Array.from({ length: 14 }, (_, i) => imageRef(String(i), 1)))
assert.equal(many.length, 10)
assert.equal(many[0].ref.attachmentId, 'sha256:4', '超限时丢最早的那几件')

// ───────────────── 预算：从最近往前数，新图优先 ─────────────────

{
  // 三轮各一张图，预算 2 张 → 最老那张降级
  const plan = historyContentBlocks([{ role: 'user', text: 'A', attachments: [imageRef('a', 1000, 'A.png')] }, { role: 'assistant', text: '答' }, { role: 'user', text: 'B', attachments: [imageRef('b', 1000, 'B.png')] }, { role: 'assistant', text: '答2' }, { role: 'user', text: 'C', attachments: [imageRef('c', 1000, 'C.png')] }])
  assert.equal(plan.keptImages, HISTORY_IMAGE_MAX)
  assert.equal(plan.omittedImages, 1)
  assert.deepEqual(blocksOf(plan.blocks[0]), ['text', 'text'], '最老那张被降级成文字')
  assert.match(textOf(plan.blocks[0]), /图片已省略/, '降级文案要说清是"省略"而不是"没附图"')
  assert.match(textOf(plan.blocks[0]), /A\.png/, '降级文案要点名是哪张')
  assert.deepEqual(blocksOf(plan.blocks[2]), ['image', 'text'], '最新那张仍然是真图片')
  assert.equal(plan.blocks[4][0].type, 'image')
}

{
  // 字节预算：单张就超 → 全部降级（张数还够也不行）
  const huge = HISTORY_IMAGE_BYTES + 1
  const plan = historyContentBlocks([{ role: 'user', text: 'A', attachments: [imageRef('a', huge)] }])
  assert.equal(plan.keptImages, 0)
  assert.equal(plan.omittedImages, 1)
}

{
  // 两张各占一半 → 第二张（更老的）因字节超限被挤掉
  const half = Math.floor(HISTORY_IMAGE_BYTES / 2)
  const plan = historyContentBlocks([
    { role: 'user', text: '老', attachments: [imageRef('old', half + 10)] },
    { role: 'user', text: '新', attachments: [imageRef('new', half)] },
  ])
  assert.equal(plan.keptImages, 1, '只剩一张')
  assert.equal(plan.omittedImages, 1)
  assert.equal(plan.blocks[0][0].type, 'text', '老的那张降级')
  assert.equal(plan.blocks[1][0].type, 'image', '新的那张回带')
}

{
  // 当前这一轮也吃额度：否则"历史 2 张 + 本轮 1 张"会逐轮往上叠
  const current = [imageRef('cur', 1000)]
  const plan = historyContentBlocks(
    [{ role: 'user', text: 'A', attachments: [imageRef('a', 1000)] }, { role: 'user', text: 'B', attachments: [imageRef('b', 1000)] }],
    current,
  )
  assert.equal(plan.keptImages, HISTORY_IMAGE_MAX, '含当前轮共 2 张')
  assert.equal(plan.blocks[0][0].type, 'text', '历史里最老那张让位给当前轮')
  assert.equal(plan.blocks[1][0].type, 'image')
}

// ───────────────── 文件：不吃图片预算，但限条数 ─────────────────

{
  const turns = Array.from({ length: HISTORY_FILE_MAX + 2 }, (_, i) => ({ role: 'user', text: `t${i}`, attachments: [fileRef(`f${i}`, `f${i}.pdf`)] }))
  const plan = historyContentBlocks(turns)
  assert.equal(plan.keptFiles, HISTORY_FILE_MAX)
  assert.equal(plan.omittedFiles, 2)
  assert.equal(plan.blocks[0][0].type, 'text', '最早的文件降级成文字')
  assert.match(textOf(plan.blocks[0]), /不再重复给出它的只读路径/, '文件降级要说清"要内容就让用户重发"')
  assert.equal(plan.blocks[turns.length - 1][0].type, 'file', '最新的文件仍是真引用（模型能按路径读）')
}

{
  // 图片额度被占满不影响文件：两者是两套额度
  const plan = historyContentBlocks([
    { role: 'user', text: 'A', attachments: [imageRef('a', 1000), fileRef('f', '报表.pdf')] },
    { role: 'user', text: 'B', attachments: [imageRef('b', 1000)] },
    { role: 'user', text: 'C', attachments: [imageRef('c', 1000)] },
  ])
  assert.equal(plan.keptFiles, 1, '文件不受图片预算影响')
  assert.equal(plan.keptImages, 2)
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
  assert.match(text, /重新附上/, '要给出路，不能只说"没有"')
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
