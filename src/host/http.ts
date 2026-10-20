import type { ServerResponse, IncomingMessage } from 'node:http'
import { CHAT_REQUEST_BYTES } from '../chat-context.js'

/** 单次请求体上限（字节）。 */
export const BODY_LIMIT = CHAT_REQUEST_BYTES

/**
 * 附件上传的请求体上限（字节）。
 *
 * 比 BODY_LIMIT 大得多：附件是 base64 传的（体积 ×4/3），一张 20 MiB 的图到这里就 ~27 MiB。
 * 单独开一个常量而不是把 BODY_LIMIT 调大 —— 提示词那条路仍然只该有 512 KiB。
 */
export const ATTACH_BODY_LIMIT = 32 * 1024 * 1024

/** 写一条 SSE 事件。 */
export function sse(res: ServerResponse, payload: unknown): void {
  if (res.writableEnded) return
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    /* 客户端已断开 */
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 读取请求体（带长度上限）。 */
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 截断到指定字符数（保留省略标记）。 */
function clampText(raw: unknown, max: number): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text
}
