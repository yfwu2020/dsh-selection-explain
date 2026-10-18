/**
 * 小窗附件：把浏览器选中的图片 / 文件存成 DSH 的**持久附件**，回一个可回传的引用。
 *
 * 为什么要单开一条路由，而不是把 base64 塞进 /analyze：
 *   ① 一张截图 base64 之后几 MB，而 /analyze 的请求体上限是 512 KiB（http.ts 的 BODY_LIMIT）——
 *      那是给提示词用的，不该为一个附件通道放宽；
 *   ② 上传要能**逐个失败、逐个重试**（一张图被拒不该把整条消息连同别的附件一起废掉），
 *      独立路由 + 每个文件一次请求，错误就自然落在那个文件头上；
 *   ③ 进度与状态（转圈 / 失败 / 重试）在客户端本来就是逐项的。
 *
 * 存进去之后 /analyze 只带引用（`{kind, ref}`），拼成 `ImageBlock` / `FileBlock`：
 *   · 图片 → 模型直接看（不支持视觉的模型由 dsh-llm 换成一行文字占位，不会报错）；
 *   · 文件 → dsh-llm 自动投影成"文件名 + 字节数 + 只读路径"的一行，模型需要时用文件工具读。
 * 这两条投影都在 dsh-llm 里，插件这边只负责把引用放进 content。
 *
 * 服务是从 `ctx.get('attachments')` 拿的（`@deepseek-ai/dsh-attachment` 的 AttachmentStore）。
 * 这里**不 import 那个包**，只按结构化类型用它 —— 和本插件读 `sessionQuery` / `agents` / `tools`
 * 是同一套办法：插件与内核的版本范围是分开演的，少一个编译期依赖就少一处版本耦合。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { sendJson, readBody, ATTACH_BODY_LIMIT } from './http.js'
import { readAttachmentRef } from './history-attachments.js'

/** 单次请求最多带几件（和主会话的观感一致：一次拖一堆也别失控）。 */
export const ATTACH_MAX_ITEMS = 10

/** 回放附件时允许直接内联展示的图片类型（其余一律当下载处理）。 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 单个文件的原始字节上限。图片另有服务自己的限额（默认 20 MiB），这里只做粗筛。 */
export const ATTACH_MAX_ITEM_BYTES = 20 * 1024 * 1024

/**
 * `ctx.attachments` 的宽松视图 —— 只写用得到的三个方法。
 *
 * 方法名与 `@deepseek-ai/dsh-attachment` 的 AttachmentStore 一致（v0.2.x）：
 *   · saveImages：成批校验 + 规范化 + 落盘，返回与输入同序的引用（图片）；
 *   · admitEncodedFile：校验 canonical base64 后**原样**落盘（任意文件，无类型/大小白名单）；
 *   · isAttachmentError：按稳定错误码判定"这是附件层的失败"。
 */
export interface AttachmentsLike {
  saveImages?: (
    inputs: ReadonlyArray<{ data: Uint8Array; mediaType: string; name?: string }>,
  ) => Promise<readonly unknown[]>
  admitEncodedFile?: (input: { data: string; name?: string }) => Promise<unknown>
  isAttachmentError?: (error: unknown) => boolean
  /** 归一化图片在宿主文件系统里的绝对路径（无效引用会抛 AttachmentError）。 */
  imageHostPath?: (ref: unknown) => string | undefined
  /** 逐字节文件在宿主文件系统里的绝对路径（无效引用会抛 AttachmentError）。 */
  fileHostPath?: (ref: unknown) => string | undefined
}

/** 客户端提交的一件附件（data 为 canonical base64，不带 data: 前缀）。 */
interface AttachInput {
  kind: 'image' | 'file'
  name: string
  mediaType: string
  data: string
}

/**
 * 附件层的错误码 → 人话。
 *
 * 为什么要翻：这些码是给适配器用的（`UNSUPPORTED_IMAGE_TYPE` 之类），
 * 直接甩到小窗里用户看不懂；而"哪张图为什么被拒"恰恰是他要照着改的。
 */
const ATTACH_ERROR_TEXT: Record<string, string> = {
  TOO_MANY_IMAGES: '一次带的图片太多了',
  IMAGES_TOO_LARGE: '这几张图加起来太大了',
  UNSUPPORTED_IMAGE_TYPE: '不是受支持的图片格式（PNG / JPEG / WebP / GIF）',
  IMAGE_TOO_LARGE: '图片太大了',
  IMAGE_TOO_MANY_PIXELS: '图片像素太多',
  IMAGE_DIMENSION_TOO_LARGE: '图片单边尺寸超限',
  IMAGE_TYPE_MISMATCH: '文件内容与它声明的图片类型不符',
  INVALID_IMAGE: '这个图片文件损坏或格式不对',
  INVALID_IMAGE_BASE64: '图片数据在上传途中损坏了',
  INVALID_FILE_BASE64: '文件数据在上传途中损坏了',
  ATTACHMENT_FILES_UNSUPPORTED: '本机没有启用文件附件存储',
  ATTACHMENT_WRITE_FAILED: '附件写入失败',
  ATTACHMENT_CORRUPT: '附件写入后校验不通过',
}

/** 从任意异常里取出稳定错误码（AttachmentError 的 code）。 */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

/** 把附件层的失败翻译成一句给用户看的话。 */
export function explainAttachError(error: unknown): { code: string; message: string } {
  const code = codeOf(error)
  const known = code ? ATTACH_ERROR_TEXT[code] : ''
  if (known) return { code, message: known }
  const raw = error instanceof Error ? error.message : String(error)
  return { code: code || 'ATTACHMENT_FAILED', message: raw }
}

/**
 * 严格解 base64。
 *
 * 必须是 **canonical** 形式：`Buffer.from(x, 'base64')` 对畸形输入是"尽量解"，
 * 解完再编码回去跟原文比对才能确认没有静默丢字节。附件服务自己也这么查，
 * 这里先查一遍是为了在**动到磁盘之前**就把坏包挡掉。
 */
export function decodeBase64(data: string): Uint8Array | null {
  if (data.length === 0) return new Uint8Array(0)
  const buffer = Buffer.from(data, 'base64')
  return buffer.toString('base64') === data ? new Uint8Array(buffer) : null
}

/** 把请求体里的一项收敛成内部形状；形状不对返回 null。 */
export function readAttachInput(raw: unknown): AttachInput | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const kind = item.kind === 'image' ? 'image' : item.kind === 'file' ? 'file' : ''
  if (!kind) return null
  if (typeof item.data !== 'string') return null
  const name = typeof item.name === 'string' ? item.name.trim().slice(0, 180) : ''
  const mediaType = typeof item.mediaType === 'string' ? item.mediaType.trim().slice(0, 120) : ''
  return {
    kind,
    // 图片必须带 mediaType（服务要拿它跟字节比对）；文件不需要，给个兜底免得下游拿到空串
    name: name || (kind === 'image' ? '粘贴的图片' : '未命名文件'),
    mediaType: mediaType || 'application/octet-stream',
    data: item.data,
  }
}

/** 一次附件上传的入口（路由 handler）。 */
export function createAttach(ctx: Context) {
  const storeOf = (): AttachmentsLike | undefined => ctx.get('attachments') as AttachmentsLike | undefined

  /** 存一件；返回它在该服务里的持久引用。 */
  async function saveOne(store: AttachmentsLike, item: AttachInput): Promise<unknown> {
    if (item.kind === 'image') {
      if (typeof store.saveImages !== 'function') throw Object.assign(new Error('本机没有启用图片附件'), { code: 'ATTACHMENT_FILES_UNSUPPORTED' })
      const bytes = decodeBase64(item.data)
      if (bytes === null) throw Object.assign(new Error('图片数据不是合法的 base64'), { code: 'INVALID_IMAGE_BASE64' })
      const refs = await store.saveImages([{ data: bytes, mediaType: item.mediaType, name: item.name }])
      const ref = refs?.[0]
      if (!ref) throw Object.assign(new Error('图片没有拿到引用'), { code: 'ATTACHMENT_WRITE_FAILED' })
      return ref
    }
    if (typeof store.admitEncodedFile !== 'function') {
      throw Object.assign(new Error('本机没有启用文件附件存储'), { code: 'ATTACHMENT_FILES_UNSUPPORTED' })
    }
    // 文件走服务自己的入口：它内部再查一次 canonical base64（空文件是合法的 0 字节）
    return await store.admitEncodedFile({ data: item.data, name: item.name })
  }

  const handleAttach = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let body: { items?: unknown } = {}
      try {
        const raw = await readBody(req, ATTACH_BODY_LIMIT)
        body = raw ? (JSON.parse(raw) as { items?: unknown }) : {}
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'BAD_BODY', error: `请求体读取失败：${String((error as Error)?.message ?? error)}` })
        return
      }
      const rawItems = Array.isArray(body.items) ? body.items : []
      if (rawItems.length === 0) {
        sendJson(res, 400, { ok: false, code: 'NO_ITEMS', error: '没有要上传的内容' })
        return
      }
      if (rawItems.length > ATTACH_MAX_ITEMS) {
        sendJson(res, 400, { ok: false, code: 'TOO_MANY_ITEMS', error: `一次最多带 ${ATTACH_MAX_ITEMS} 件附件` })
        return
      }
      const store = storeOf()
      if (!store) {
        sendJson(res, 503, { ok: false, code: 'ATTACHMENT_UNAVAILABLE', error: '这台机器没有启用附件服务（ctx.attachments 不可用）' })
        return
      }
      const items: Array<{ kind: string; ref: unknown }> = []
      for (const rawItem of rawItems) {
        const item = readAttachInput(rawItem)
        if (!item) {
          sendJson(res, 400, { ok: false, code: 'BAD_ITEM', error: '附件参数不完整（需要 kind / name / data）' })
          return
        }
        // base64 长度 ≈ 原始字节 × 4/3；粗筛一下再解，免得先分配一大块内存
        if ((item.data.length * 3) / 4 > ATTACH_MAX_ITEM_BYTES) {
          sendJson(res, 413, { ok: false, code: 'ITEM_TOO_LARGE', error: `「${item.name}」超过单件上限（${Math.round(ATTACH_MAX_ITEM_BYTES / 1024 / 1024)} MB）` })
          return
        }
        try {
          items.push({ kind: item.kind, ref: await saveOne(store, item) })
        } catch (error) {
          const explained = explainAttachError(error)
          const status = store.isAttachmentError?.(error) === true || explained.code !== 'ATTACHMENT_FAILED' ? 400 : 500
          sendJson(res, status, { ok: false, code: explained.code, error: explained.message, name: item.name })
          return
        }
      }
      sendJson(res, 200, { ok: true, items })
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: 'ATTACHMENT_FAILED', error: String((error as Error)?.message ?? error) })
    })
  }

  /**
   * 把存好的附件**读回来**给界面用。
   *
   * `GET /selection-explanation/api/attachment?ref=<base64url(JSON)>&kind=image|file`
   *
   * 为什么需要：用户发出去的那条消息里，附件只留了一个**引用**（气泡里要画缩略图），
   * 而客户端在发送那一刻就把本地 object URL 释放了 —— 历史回放时更是连 File 都没有了。
   * 所以图片必须能从宿主再取一次。主会话的图片也是这么显示的（它走自己的鉴权路由）。
   *
   * 安全性：路径**不由客户端给**，而是把引用交给附件服务，由它按内容哈希推导
   * （`ensureReference` 只认 `sha256:<64位hex>`；文件那条还会校验
   * `ref.name === fileLeafName(ref.name)`，所以 `../` 之类的名字一律被拒）。
   * 另外响应只允许白名单里的图片类型，且带 `nosniff` —— 免得有人把非图片标成 image/* 让浏览器去嗅探。
   */
  const handleAttachment = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: '只支持 GET' })
        return
      }
      let params: URLSearchParams
      try {
        params = new URL(req.url ?? '/', 'http://localhost').searchParams
      } catch {
        sendJson(res, 400, { ok: false, error: '请求地址解析失败' })
        return
      }
      const encoded = params.get('ref') ?? ''
      let ref: ReturnType<typeof readAttachmentRef> = null
      try {
        const json = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
        ref = readAttachmentRef(JSON.parse(json))
      } catch {
        ref = null
      }
      if (!ref) {
        sendJson(res, 400, { ok: false, error: '附件引用不完整' })
        return
      }
      const store = storeOf()
      if (!store) {
        sendJson(res, 503, { ok: false, error: '这台机器没有启用附件服务' })
        return
      }
      const kind = params.get('kind') === 'file' ? 'file' : params.get('kind') === 'image' ? 'image' : ref.mediaType ? 'image' : 'file'
      const download = params.get('download') === '1'
      try {
        const hostPath =
          kind === 'image'
            ? typeof store.imageHostPath === 'function'
              ? store.imageHostPath(ref)
              : undefined
            : typeof store.fileHostPath === 'function'
              ? store.fileHostPath(ref)
              : undefined
        if (!hostPath) {
          sendJson(res, 501, { ok: false, error: '当前附件后端不提供文件系统路径，无法回放' })
          return
        }
        const bytes = await readFile(hostPath)
        // 图片类型走白名单（客户端可以改 query，但不能改服务的归一化结果）；
        // 其他一律 octet-stream + attachment，绝不让浏览器当页面渲染
        const imageType = kind === 'image' && IMAGE_TYPES.has(String(ref.mediaType)) ? String(ref.mediaType) : ''
        const headers: Record<string, string> = {
          'content-type': imageType || 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          // 内容寻址 = 永不变，可以放心长缓存（同一张图反复显示不再回源）
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        }
        if (!imageType || download) {
          headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(ref.name || 'attachment')}`
        }
        res.writeHead(200, headers)
        if (req.method === 'HEAD') res.end()
        else res.end(bytes)
      } catch (error) {
        // 不把内部路径回给调用方：ENOENT 的原文里带着 DSH_HOME 下的绝对路径，
        // 而引用是客户端给的 —— 没必要让它知道我在这台机器上把附件放在哪儿。
        const code = (error as { code?: unknown })?.code
        if (code === 'ENOENT') {
          sendJson(res, 404, { ok: false, code: 'ATTACHMENT_MISSING', error: '这个附件已经不在附件仓里了（可能被清理过）' })
          return
        }
        const explained = explainAttachError(error)
        sendJson(res, 404, { ok: false, code: explained.code, error: explained.message })
      }
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: 'ATTACHMENT_FAILED', error: String((error as Error)?.message ?? error) })
    })
  }

  return { handleAttach, handleAttachment }
}
