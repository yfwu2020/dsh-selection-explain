/**
 * 小窗附件的两侧测试：
 *   ① host 路由（lib/host/attach.js）—— 真起一个 http server，用桩附件服务跑通全部拒绝路径；
 *   ② 客户端纯函数（src/client/attach.js）—— 字节格式化、扩展名、文件夹识别。
 *
 * 为什么值得钉：这条路由的**分支全是拒绝路径**（形状不对 / 超件数 / base64 不 canonical /
 * 服务没挂载 / 服务自己报错）。这些分支平时一次都不会走到，等真走到时（用户拖进来一个
 * 25 MB 的 psd、或者本机没装 attachment 后端）恰恰是最需要"说人话"的时候。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createAttach, decodeBase64, explainAttachError, readAttachInput } from '../../lib/host/attach.js'
import { formatBytes, extensionOf, looksLikeDirectory } from '../../src/client/attach.js'

// ───────────────────────── ① 客户端纯函数 ─────────────────────────

assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytes(900), '900 B')
assert.equal(formatBytes(2048), '2.0 KB')
assert.equal(formatBytes(2.5 * 1024 * 1024), '2.5 MB')
assert.equal(formatBytes(undefined), '0 B', '没给字节数时不能吐 NaN')
assert.equal(extensionOf('季度报表.pdf'), 'PDF')
assert.equal(extensionOf('截图.PNG'), 'PNG')
assert.equal(extensionOf('没有扩展名'), 'FILE')
assert.equal(extensionOf(''), 'FILE')
assert.equal(looksLikeDirectory({ name: '照片', size: 0, type: '' }), true, '拖进来的文件夹：0 字节、无类型、无扩展名')
assert.equal(looksLikeDirectory({ name: 'a.md', size: 0, type: '' }), false, '空文件有扩展名 → 是文件不是文件夹')

// ───────────────────────── ② host 路由 ─────────────────────────

const saved = { images: [], files: [] }
let failWith = null
const store = {
  saveImages: async (inputs) => {
    if (failWith) throw failWith
    saved.images.push(inputs)
    return inputs.map((input, index) => ({
      attachmentId: `sha256:${String(index).padStart(64, '0')}`,
      mediaType: input.mediaType,
      width: 100,
      height: 50,
      bytes: input.data.byteLength,
      ...(input.name === undefined ? {} : { name: input.name }),
    }))
  },
  admitEncodedFile: async (input) => {
    if (failWith) throw failWith
    saved.files.push(input)
    return { attachmentId: 'sha256:' + 'f'.repeat(64), name: input.name, bytes: 3 }
  },
  isAttachmentError: (error) => typeof error?.code === 'string',
}

let storeMounted = true
const ctx = { get: (name) => (name === 'attachments' && storeMounted ? store : undefined) }
const { handleAttach } = createAttach(ctx)
const server = createServer((req, res) => {
  Promise.resolve(handleAttach(req, res)).catch((error) => {
    res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port
const post = (body) =>
  fetch(origin, { method: 'POST', body: JSON.stringify(body) }).then(async (res) => ({ status: res.status, body: await res.json() }))

// PNG 头 + 一点点数据；base64 必须是 canonical（服务自己也这么查）
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const pngB64 = pngBytes.toString('base64')
const fileB64 = Buffer.from('hello').toString('base64')

try {
  // 图片：解出来的字节必须和原文一模一样（多一个字节都算上传通道坏了）
  const image = await post({ items: [{ kind: 'image', name: '截图.png', mediaType: 'image/png', data: pngB64 }] })
  assert.equal(image.status, 200)
  assert.equal(image.body.ok, true)
  assert.equal(image.body.items.length, 1)
  assert.equal(image.body.items[0].kind, 'image')
  assert.match(image.body.items[0].ref.attachmentId, /^sha256:/)
  assert.equal(saved.images.length, 1)
  assert.equal(saved.images[0][0].mediaType, 'image/png')
  assert.equal(saved.images[0][0].name, '截图.png')
  assert.deepEqual(Array.from(saved.images[0][0].data), Array.from(pngBytes), 'base64 往返必须逐字节一致')

  // 文件：走 admitEncodedFile，原样 base64 传下去（服务自己再验一次）
  const file = await post({ items: [{ kind: 'file', name: '说明.txt', data: fileB64 }] })
  assert.equal(file.status, 200)
  assert.equal(file.body.items[0].kind, 'file')
  assert.equal(saved.files.length, 1)
  assert.equal(saved.files[0].name, '说明.txt')
  assert.equal(saved.files[0].data, fileB64)

  // 一次多件：顺序必须与输入一致（客户端按序渲染）
  const many = await post({
    items: [
      { kind: 'file', name: 'a.bin', data: fileB64 },
      { kind: 'image', name: 'b.png', mediaType: 'image/png', data: pngB64 },
    ],
  })
  assert.deepEqual(many.body.items.map((item) => item.kind), ['file', 'image'])

  // 空批次
  const empty = await post({ items: [] })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.code, 'NO_ITEMS')

  // 超件数
  const tooMany = await post({ items: Array.from({ length: 11 }, () => ({ kind: 'file', name: 'x', data: fileB64 })) })
  assert.equal(tooMany.status, 400)
  assert.equal(tooMany.body.code, 'TOO_MANY_ITEMS')

  // 形状不对：kind 不认识
  const badKind = await post({ items: [{ kind: 'video', name: 'v', data: fileB64 }] })
  assert.equal(badKind.status, 400)
  assert.equal(badKind.body.code, 'BAD_ITEM')

  // 形状不对：没有 data
  const noData = await post({ items: [{ kind: 'file', name: 'x' }] })
  assert.equal(noData.status, 400)
  assert.equal(noData.body.code, 'BAD_ITEM')

  // 非 canonical base64（带换行）→ 必须被挡在"动磁盘之前"
  const badB64 = await post({ items: [{ kind: 'image', name: 'x.png', mediaType: 'image/png', data: 'iVBORw0KGgo\n' }] })
  assert.equal(badB64.status, 400)
  assert.equal(badB64.body.code, 'INVALID_IMAGE_BASE64')

  // 服务自己报错（图片格式不支持）→ 400 + 中文文案
  failWith = Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED_IMAGE_TYPE' })
  const refused = await post({ items: [{ kind: 'image', name: 'x.bmp', mediaType: 'image/bmp', data: pngB64 }] })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.code, 'UNSUPPORTED_IMAGE_TYPE')
  assert.match(refused.body.error, /图片格式/, '错误码要翻成人话')
  assert.equal(refused.body.name, 'x.bmp', '要告诉用户是哪一件被拒了')
  failWith = null

  // 本机没挂载附件服务 → 503（不是 400，用户没做错什么）
  storeMounted = false
  const unavailable = await post({ items: [{ kind: 'file', name: 'x', data: fileB64 }] })
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.body.code, 'ATTACHMENT_UNAVAILABLE')
  storeMounted = true

  // GET 不受理
  const got = await fetch(origin).then((res) => res.status)
  assert.equal(got, 405)
} finally {
  await new Promise((done) => server.close(done))
}

// 纯函数：解 base64 的严格性
assert.deepEqual(Array.from(decodeBase64(pngB64)), Array.from(pngBytes))
assert.equal(decodeBase64('AAAA\n'), null, '带换行的不是 canonical')
assert.deepEqual(Array.from(decodeBase64('')), [], '空串是合法的 0 字节（空文件）')

// 纯函数：形状收敛
assert.deepEqual(readAttachInput({ kind: 'file', data: 'AA==' }), {
  kind: 'file',
  name: '未命名文件',
  mediaType: 'application/octet-stream',
  data: 'AA==',
})
assert.equal(readAttachInput({ kind: 'file' }), null, '没有 data 就不是一件附件')
assert.equal(readAttachInput(null), null)

// 纯函数：错误翻译
assert.equal(explainAttachError(Object.assign(new Error('x'), { code: 'IMAGE_TOO_LARGE' })).message, '图片太大了')
assert.equal(explainAttachError(new Error('别的原因')).code, 'ATTACHMENT_FAILED', '没有码时给一个稳定的兜底码')

console.log('=== 附件测试结束：全部通过 ===')
