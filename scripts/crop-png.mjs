/**
 * 裁掉截图四周的空白（仅用 Node 内置 zlib 解码/编码 PNG，不依赖 imagemagick）。
 *
 * 用途：README 的演示图需要紧凑。Chrome `--screenshot` 只能给固定窗口尺寸，
 * 面板比窗口矮时底部会留下大片背景色 —— 这里把纯背景的边缘裁掉。
 *
 * 用法：node scripts/crop-png.mjs <in.png> <out.png> [边距px]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'

const [, , inPath, outPath, padArg] = process.argv
if (!inPath || !outPath) {
  console.error('用法: node scripts/crop-png.mjs <in.png> <out.png> [边距px]')
  process.exit(1)
}
const PAD = Number(padArg ?? 0)

// ── 读 PNG（假定 Chrome 输出的 8bit RGB/RGBA 非隔行）──
const buf = readFileSync(inPath)
if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
let pos = 8
let width = 0
let height = 0
let bitDepth = 0
let colorType = 0
const idat = []
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos)
  const type = buf.toString('ascii', pos + 4, pos + 8)
  const data = buf.subarray(pos + 8, pos + 8 + len)
  if (type === 'IHDR') {
    width = data.readUInt32BE(0)
    height = data.readUInt32BE(4)
    bitDepth = data[8]
    colorType = data[9]
    if (data[12] !== 0) throw new Error('不支持隔行 PNG')
  } else if (type === 'IDAT') idat.push(data)
  else if (type === 'IEND') break
  pos += 12 + len
}
if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
  throw new Error(`不支持的 PNG 格式：bitDepth=${bitDepth} colorType=${colorType}`)
}
const bpp = colorType === 6 ? 4 : 3
const raw = inflateSync(Buffer.concat(idat))

// ── 反滤波 ──
const stride = width * bpp
const img = Buffer.alloc(height * stride)
for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)]
  const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
  const prev = y > 0 ? img.subarray((y - 1) * stride, y * stride) : null
  const cur = img.subarray(y * stride, (y + 1) * stride)
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0
    const b = prev ? prev[x] : 0
    const c = prev && x >= bpp ? prev[x - bpp] : 0
    let v = line[x]
    if (filter === 1) v += a
    else if (filter === 2) v += b
    else if (filter === 3) v += (a + b) >> 1
    else if (filter === 4) {
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    cur[x] = v & 0xff
  }
}

// ── 找内容边界：以左上角像素为背景色 ──
const bg = [img[0], img[1], img[2]]
const isBg = (x, y) => {
  const o = y * stride + x * bpp
  return (
    Math.abs(img[o] - bg[0]) <= 3 && Math.abs(img[o + 1] - bg[1]) <= 3 && Math.abs(img[o + 2] - bg[2]) <= 3
  )
}
let top = 0
let bottom = height - 1
let left = 0
let right = width - 1
outer: for (; top < height; top++) for (let x = 0; x < width; x++) if (!isBg(x, top)) break outer
outer2: for (; bottom > top; bottom--) for (let x = 0; x < width; x++) if (!isBg(x, bottom)) break outer2
outer3: for (; left < width; left++) for (let y = top; y <= bottom; y++) if (!isBg(left, y)) break outer3
outer4: for (; right > left; right--) for (let y = top; y <= bottom; y++) if (!isBg(right, y)) break outer4

top = Math.max(0, top - PAD)
left = Math.max(0, left - PAD)
bottom = Math.min(height - 1, bottom + PAD)
right = Math.min(width - 1, right + PAD)
const w = right - left + 1
const h = bottom - top + 1

// ── 重新编码（每行用 filter 0）──
const outStride = w * bpp
const rawOut = Buffer.alloc(h * (outStride + 1))
for (let y = 0; y < h; y++) {
  rawOut[y * (outStride + 1)] = 0
  img.copy(rawOut, y * (outStride + 1) + 1, (top + y) * stride + left * bpp, (top + y) * stride + left * bpp + outStride)
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}
let table = null
function crc32(b) {
  if (!table) {
    table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(w, 0)
ihdr.writeUInt32BE(h, 4)
ihdr[8] = 8
ihdr[9] = colorType
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(rawOut, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync(outPath, png)
console.log(`✓ ${outPath}  ${width}x${height} → ${w}x${h}`)
