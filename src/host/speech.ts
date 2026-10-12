import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, readBody } from './http.js'

// ────────────────────────────── 语音输入（小窗麦克风） ──────────────────────────────
//
// 小窗的追问输入框加一个麦克风：录一段话 → 转成文字**插进输入框**（不是直接发送，
// 识别错了还能改）。转写这条链路在 host 这一侧收口：
//
//   GET  ${API_PREFIX}/speech            识别服务目录 + 就绪状态（客户端据此决定麦克风能不能点）
//   POST ${API_PREFIX}/speech/transcribe 一段 16kHz 单声道 PCM16 WAV（base64）→ 文字
//   POST ${API_PREFIX}/speech/prepare    显式准备本地识别模型（首次要下载，必须用户点头）
//
// 为什么不让浏览器自己去连识别服务：音频、provider 选择、模型路径全部留在 host，
// 客户端只拿到"一段话的文字"；而且**音频不落盘、不进会话**（转写完即丢）。
// 识别服务（@deepseek-ai/dsh-experimental-speech-to-text）是实验性的、可以不装：
// 拿不到该服务就整条链路优雅降级（目录接口回 available:false，麦克风点了只给一句解释）。

/** 单次录音时长上限（秒）：到了就自动收尾去识别，不让用户对着麦克风发呆。 */
const SPEECH_MAX_SECONDS = 60

/** 单条音频的字节上限（≈ 2 分钟 16kHz 单声道 PCM16）；与识别服务默认的 4MB 对齐。 */
const SPEECH_MAX_BYTES = 4 * 1024 * 1024

/** 识别请求体上限：base64 会膨胀 4/3，再留点余量给 JSON 外壳。 */
const SPEECH_BODY_LIMIT = Math.ceil(SPEECH_MAX_BYTES / 3) * 4 + 4096

/** 单次识别的等待上限（毫秒）：真机上 60 秒音频几秒内就回来了，这是兜底。 */
const SPEECH_TIMEOUT_MS = 120_000

/** 识别器的就绪状态（只声明我们用到的字段——服务是实验性的，形状可能变）。 */
interface SpeechPreparationView {
  phase: string
  step?: string
  resource?: string
  completedBytes?: number
  totalBytes?: number
  message?: string
  steps?: ReadonlyArray<{ kind: string; status: string }>
}

/** 一个可选的识别器（本机 SenseVoice / 云端）。 */
interface SpeechProviderView {
  id: string
  name: string
  location: string
  languages: readonly string[]
  downloadSources?: readonly string[]
  preparation?: SpeechPreparationView
}

/** ctx.speechToText 的宽松视图（只用到这几个方法）。 */
interface SpeechToTextLike {
  snapshot: () => {
    providers: readonly SpeechProviderView[]
    selection: { providerId: string; language: string }
  }
  resolve: (request: { audio: Uint8Array; providerId?: string; language?: string }) => unknown
  transcribe: (
    spec: unknown,
    signal: AbortSignal,
  ) => Promise<{ text?: unknown; audioSeconds?: unknown; inferenceSeconds?: unknown }>
  prepare: (id: string, options?: { downloadSource?: string }) => void
}

/**
 * 校验客户端送上来的音频是不是**规范**的 16kHz 单声道 PCM16 WAV。
 *
 * 为什么抠得这么死：这个格式是浏览器端编码器（MediaRecorder → decodeAudioData →
 * OfflineAudioContext 重采样 → 手写 WAV 头）唯一会产出的形状。逐字段对齐之后，
 * "音频不对"就只剩两种可能——客户端版本对不上、或者有人手工构造了这个请求。
 * 光看二进制长度不算数：头里写的采样率/声道/位深必须是那一套，否则识别服务会按
 * 错误的采样率解释这段音频（听起来像快放/慢放），识别结果自然全错。
 *
 * @param audio 完整音频字节
 * @param maxSeconds 允许的最长时长
 * @returns 时长（秒）
 */
export function validateWave(audio: Buffer, maxSeconds: number): number {
  if (
    audio.length < 46 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 12) !== 'WAVE' ||
    audio.toString('ascii', 12, 16) !== 'fmt ' ||
    audio.readUInt32LE(16) !== 16 ||
    audio.readUInt16LE(20) !== 1 || // PCM
    audio.readUInt16LE(22) !== 1 || // 单声道
    audio.readUInt32LE(24) !== 16000 || // 16kHz
    audio.readUInt32LE(28) !== 32000 || // 字节率 = 16000 × 1ch × 2B
    audio.readUInt16LE(32) !== 2 || // 块对齐
    audio.readUInt16LE(34) !== 16 || // 16 bit
    audio.toString('ascii', 36, 40) !== 'data' ||
    audio.readUInt32LE(4) !== audio.length - 8 ||
    audio.readUInt32LE(40) !== audio.length - 44 ||
    (audio.length - 44) % 2 !== 0
  ) {
    throw new Error('音频格式不是 16kHz 单声道 PCM16 WAV')
  }
  const seconds = (audio.length - 44) / 32000
  if (seconds <= 0) throw new Error('录音是空的')
  if (seconds > maxSeconds) throw new Error(`录音超过 ${maxSeconds} 秒`)
  return seconds
}

/** Owns speech state for one plugin instance. */
export function createSpeech(ctx: Context, config: Config) {

  /** ctx.speechToText：装了就给，没装/被停用给 undefined（麦克风据此优雅降级）。 */
  const speechService = (): SpeechToTextLike | undefined => {
    try {
      const service = ctx.get('speechToText') as SpeechToTextLike | undefined
      return service && typeof service.transcribe === 'function' ? service : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 语音目录：有哪些识别器、各自什么状态、默认选谁、这次能录多久。
   *
   * 客户端据此决定麦克风的形态：能用 / 要先把模型准备好 / 这个部署根本没有识别服务。
   * 不认识的状态一律当成"不能录"（宁可让用户看到一句解释，也不要录完才发现转不了）。
   */
  const speechCatalog = (): Record<string, unknown> => {
    const service = speechService()
    const limits = { maxSeconds: SPEECH_MAX_SECONDS, maxBytes: SPEECH_MAX_BYTES }
    if (!service) {
      return {
        ok: true,
        available: false,
        reason: 'missing',
        error: '这个 DSH 没有启用语音识别服务（缺 @deepseek-ai/dsh-experimental-speech-to-text）',
        providers: [],
        selection: null,
        limits,
      }
    }
    let snapshot: ReturnType<SpeechToTextLike['snapshot']>
    try {
      snapshot = service.snapshot()
    } catch (error) {
      return {
        ok: true,
        available: false,
        reason: 'error',
        error: String((error as Error)?.message ?? error),
        providers: [],
        selection: null,
        limits,
      }
    }
    const providers = (snapshot?.providers ?? []).map((provider) => {
      const preparation = provider.preparation ?? { phase: 'ready' }
      return {
        id: String(provider.id),
        name: String(provider.name ?? provider.id),
        location: String(provider.location ?? ''),
        languages: Array.isArray(provider.languages) ? provider.languages.map(String) : [],
        // 下载源：本地模型已经装好时是空数组（没有可选项），装了才有得选
        downloadSources: Array.isArray(provider.downloadSources) ? provider.downloadSources.map(String) : [],
        phase: String(preparation.phase ?? 'unprepared'),
        step: preparation.step ? String(preparation.step) : '',
        // 下载进度（只在 downloading 时有意义）：客户端显示"还要下多少"
        completedBytes: typeof preparation.completedBytes === 'number' ? preparation.completedBytes : 0,
        totalBytes: typeof preparation.totalBytes === 'number' ? preparation.totalBytes : 0,
        message: preparation.message ? String(preparation.message) : '',
      }
    })
    const selection = snapshot?.selection
      ? { providerId: String(snapshot.selection.providerId), language: String(snapshot.selection.language) }
      : null
    // 能录 = 至少有一个识别器已经就绪（standby 也算：本机模型在磁盘上，用到才唤醒）
    const usable = providers.filter((provider) => provider.phase === 'ready' || provider.phase === 'standby')
    return {
      ok: true,
      available: usable.length > 0,
      reason: usable.length > 0 ? '' : providers.length > 0 ? 'unprepared' : 'empty',
      error: '',
      providers,
      selection,
      limits,
    }
  }

  const handleSpeech = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: '只支持 GET' })
      return
    }
    sendJson(res, 200, speechCatalog())
  }

  /**
   * 显式准备识别模型（首次要下 1G 左右的模型，所以**只有用户点了才做**，不自动触发）。
   * 只是把任务交给识别服务，进度走目录接口轮询（下载在 host 上跑，关掉页面也继续）。
   */
  const handleSpeechPrepare = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const service = speechService()
      if (!service) {
        sendJson(res, 200, { ok: false, error: '这个 DSH 没有启用语音识别服务' })
        return
      }
      let body: { providerId?: unknown; downloadSource?: unknown } = {}
      try {
        const raw = await readBody(req, 20_000)
        body = raw ? (JSON.parse(raw) as { providerId?: unknown; downloadSource?: unknown }) : {}
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      const catalog = speechCatalog()
      const wanted = typeof body.providerId === 'string' && body.providerId ? body.providerId : ''
      const providers = (catalog.providers as Array<{ id: string; phase: string }>) ?? []
      const target = wanted || (providers.find((item) => item.phase !== 'ready' && item.phase !== 'standby')?.id ?? providers[0]?.id ?? '')
      if (!target) {
        sendJson(res, 200, { ok: false, error: '没有可用的识别器' })
        return
      }
      try {
        const source = typeof body.downloadSource === 'string' && body.downloadSource ? body.downloadSource : undefined
        service.prepare(target, source === undefined ? undefined : { downloadSource: source })
      } catch (error) {
        // 已经在准备中 / 下载源不认 / 服务生命周期已结束：都不算致命，把状态回给客户端自己看
        sendJson(res, 200, { ok: false, error: String((error as Error)?.message ?? error), catalog: speechCatalog() })
        return
      }
      sendJson(res, 200, { ok: true, providerId: target, catalog: speechCatalog() })
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    })
  }

  /**
   * 转写一段录音。
   *
   * 输入是浏览器端编码好的规范 WAV（base64），输出就是一段文字——**不落盘、不进会话**，
   * 也不给模型看（用户要的是"把我说的变成字"，不是"让模型处理我的录音"）。
   * 识别失败一律回 200 + { ok:false, code }：这是"这一句话没听清"，
   * 不是 HTTP 层面的错误，客户端按 code 给不同的话术（换 HTTP 状态码反而会被
   * 各种中间层改写或吞掉，用户看到的就只剩"请求失败"）。
   */
  const handleSpeechTranscribe = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const service = speechService()
      if (!service) {
        sendJson(res, 200, {
          ok: false,
          code: 'missing',
          error: '这个 DSH 没有启用语音识别服务（缺 @deepseek-ai/dsh-experimental-speech-to-text）',
        })
        return
      }
      let body: { audioBase64?: unknown; language?: unknown; providerId?: unknown } = {}
      try {
        const raw = await readBody(req, SPEECH_BODY_LIMIT)
        body = raw ? (JSON.parse(raw) as typeof body) : {}
      } catch (error) {
        sendJson(res, 200, { ok: false, code: 'transport', error: String((error as Error)?.message ?? error) })
        return
      }
      const encoded = typeof body.audioBase64 === 'string' ? body.audioBase64 : ''
      if (!encoded) {
        sendJson(res, 200, { ok: false, code: 'audio', error: '没有收到音频' })
        return
      }
      let audio: Buffer
      let seconds = 0
      try {
        if (encoded.length > Math.ceil(SPEECH_MAX_BYTES / 3) * 4) throw new Error('录音太大了')
        audio = Buffer.from(encoded, 'base64')
        // 规范 base64：随手传一段别的东西进来会在这一步被挡掉（解出来对不上原文）
        if (audio.toString('base64') !== encoded) throw new Error('音频不是合法 base64')
        if (audio.length > SPEECH_MAX_BYTES) throw new Error('录音太大了')
        seconds = validateWave(audio, SPEECH_MAX_SECONDS)
      } catch (error) {
        sendJson(res, 200, { ok: false, code: 'audio', error: String((error as Error)?.message ?? error) })
        return
      }

      const catalog = speechCatalog()
      const providers = (catalog.providers as Array<{ id: string; phase: string; name: string }>) ?? []
      // 这个部署默认用的语言（识别服务里配的，auto = 自动判断）；请求里带了就以请求为准
      const catalogLanguage = String((catalog.selection as { language?: string } | null)?.language ?? '')
      const wanted = typeof body.providerId === 'string' && body.providerId ? body.providerId : ''
      const picked =
        providers.find((item) => item.id === wanted) ??
        providers.find((item) => item.phase === 'ready' || item.phase === 'standby') ??
        providers[0]
      if (!picked) {
        sendJson(res, 200, { ok: false, code: 'empty', error: '没有可用的识别器' })
        return
      }
      if (picked.phase !== 'ready' && picked.phase !== 'standby') {
        sendJson(res, 200, {
          ok: false,
          code: 'unprepared',
          providerId: picked.id,
          phase: picked.phase,
          error: `识别模型还没准备好（${picked.name}：${picked.phase}）`,
          catalog,
        })
        return
      }

      // 客户端断开 / 用户取消 → 立刻掐掉识别（本机模型在跑推理，不能让它白跑）
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('识别超时')), SPEECH_TIMEOUT_MS)
      const onClose = (): void => controller.abort(new Error('客户端已断开'))
      req.on('close', onClose)
      const startedAt = Date.now()
      try {
        const language = typeof body.language === 'string' && body.language ? body.language : undefined
        const spec = service.resolve({
          audio,
          ...(wanted ? { providerId: wanted } : {}),
          ...(language === undefined ? {} : { language }),
        })
        const transcript = await service.transcribe(spec, controller.signal)
        const text = String(transcript?.text ?? '').trim()
        if (!text) {
          sendJson(res, 200, { ok: false, code: 'empty-transcript', error: '没听清（这段录音里没有识别到内容）' })
          return
        }
        sendJson(res, 200, {
          ok: true,
          text,
          providerId: picked.id,
          providerName: picked.name,
          language: language ?? catalogLanguage,
          seconds,
          elapsedMs: Date.now() - startedAt,
        })
      } catch (error) {
        const message = String((error as Error)?.message ?? error)
        const aborted = (error as Error)?.name === 'AbortError' || controller.signal.aborted
        // 超时/断开与"识别失败"分开报：前者是这一句没转成，后者是识别服务本身有问题
        sendJson(res, 200, {
          ok: false,
          code: aborted ? 'aborted' : 'failed',
          error: aborted ? `这次识别被打断了（${message}）` : message,
        })
      } finally {
        clearTimeout(timer)
        req.off('close', onClose)
      }
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    })
  }
  return { handleSpeech, handleSpeechTranscribe, handleSpeechPrepare }
}
