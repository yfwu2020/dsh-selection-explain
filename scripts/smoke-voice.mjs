/**
 * 语音输入的**真浏览器**冒烟测试（headless Chrome + 假麦克风 + 真 SenseVoice）。
 *
 * 为什么非要真浏览器：这条链路上有一大半是**浏览器自己的行为**，DOM 桩测不出来 ——
 *   · getUserMedia 的授权与真实音轨；
 *   · MediaRecorder 产出的容器（Chrome 是 webm/opus）`decodeAudioData` 能不能解；
 *   · `OfflineAudioContext` 的重采样（源采样率/声道由浏览器决定，不是我们能假设的）；
 *   · 我们手写的 WAV 头在**真引擎**里生成的字节，host 的 validateWave 认不认。
 * 桩里这四步全是假的（见 scripts/test-client.mjs 的那一节），只有真引擎说了算。
 *
 * 做法（自包含，不需要 DSH 的登录 token）：
 *   ① 用 `say` + `ffmpeg` 造一段真人语音的规范 WAV（macOS；没有就 SKIP）；
 *   ② 起一个临时 http 服务：页面与 lib/client.js 由它提供，analyze 等路由给本地夹具
 *      （冒烟不烧模型额度），**识别路由转发给真的 DSH host**（真 SenseVoice 转写）；
 *   ③ 起 headless Chrome，用 `--use-file-for-fake-audio-capture` 把那段话当麦克风输入；
 *   ④ 用真的鼠标事件点麦克风 → 说 3.5 秒 → 再点一下 → 断言文字进了输入框。
 *
 * 页面里跑的是**真的 lib/client.js**（不是抄一份代码）：只补一层最小的客户端运行时
 * 桩（ModuleLoader / React.createElement / slots 注册）——面板本身是命令式 DOM，
 * 补完这一层就是完整的真 UI。
 *
 * 用法：node scripts/smoke-voice.mjs
 *      CHROME=/path/to/chrome node scripts/smoke-voice.mjs
 *      SPEECH_WAV=/tmp/v.wav node scripts/smoke-voice.mjs     （用自己的语音样本）
 *      SEL_ORIGIN=http://127.0.0.1:3080 node scripts/smoke-voice.mjs
 *      SMOKE_SHOT=/tmp/v.png node scripts/smoke-voice.mjs     （截图落点）
 * 退出码：全部 PASS（或 SKIP）= 0。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { validateWave } from '../lib/index.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..', 'lib', 'client.js')
const ORIGIN = process.env.SEL_ORIGIN || 'http://127.0.0.1:3080'
const SPEECH_API = '/selection-explain/api/speech'

let failed = 0
const assert = (label, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  for (const item of candidates) if (existsSync(item)) return item
  return ''
}

/** 造一段真人语音的规范 WAV（say → ffmpeg 到 16kHz 单声道 PCM16）。 */
async function ensureSpeechWav(dir) {
  if (process.env.SPEECH_WAV) {
    if (!existsSync(process.env.SPEECH_WAV)) throw new Error('SPEECH_WAV 不存在：' + process.env.SPEECH_WAV)
    return process.env.SPEECH_WAV
  }
  if (process.platform !== 'darwin') throw new Error('非 macOS：请用 SPEECH_WAV 指定一段 16kHz 单声道 WAV')
  const wav = join(dir, 'speech.wav')
  /** 一句短的（≤3 秒）：好让"停顿"在录音里早一点出现。 */
  const say = async (text, out) => {
    const aiff = join(dir, out + '.aiff')
    const one = join(dir, out + '.wav')
    await execFileAsync('/usr/bin/say', ['-v', 'Tingting', '-o', aiff, text], { timeout: 60000 })
    await execFileAsync(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-map_metadata', '-1', one],
      { timeout: 60000 },
    )
    return readFileSync(one)
  }
  // 两句不同的话 + 各自 1.3 秒停顿：Chrome 循环播放这个文件，麦克风里于是周期性地出现**真实停顿**，
  // 冒烟才会走到"停顿定稿"和"定稿之后继续出字"——正是用户报的那条路（只跟第一句、后面不吐字）。
  const first = await say('你好，这是一段语音输入的测试。', 'speech-a')
  const second = await say('帮我解释一下划词解读。', 'speech-b')
  const gap = Buffer.alloc(16000 * 2 * 1.3)
  const pieces = [first.subarray(44), gap, second.subarray(44), gap]
  const body = Buffer.concat(pieces)
  const headerOut = Buffer.from(first.subarray(0, 44))
  headerOut.writeUInt32LE(36 + body.length, 4)
  headerOut.writeUInt32LE(body.length, 40)
  writeFileSync(wav, Buffer.concat([headerOut, body]))
  return wav
}

// ───────────────────────── 前置检查 ─────────────────────────

const chrome = findChrome()
if (!chrome) {
  console.log('SKIP  没找到 Chrome/Chromium（设 CHROME=/path/to/chrome 可指定）')
  process.exit(0)
}

/** 真识别服务在不在？（在就转发真 host，不在就用夹具，只验浏览器侧那半条链路） */
let realSpeech = false
let hostCatalog = null
try {
  const response = await fetch(`${ORIGIN}${SPEECH_API}`)
  hostCatalog = response.ok ? await response.json() : null
  realSpeech = !!(hostCatalog && hostCatalog.available)
} catch (error) {
  hostCatalog = null
}
if (hostCatalog && !hostCatalog.available) {
  console.log(`（host 在跑但没有就绪的识别器：${JSON.stringify(hostCatalog.providers.map((p) => p.id + ':' + p.phase))}）`)
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-voice-smoke-'))
let speechWav = ''
try {
  speechWav = await ensureSpeechWav(workDir)
} catch (error) {
  console.log('SKIP  造不出语音样本（' + String(error.message || error).slice(0, 140) + '）')
  rmSync(workDir, { recursive: true, force: true })
  process.exit(0)
}
console.log(`=== 语音样本：${speechWav}（${readFileSync(speechWav).length} 字节）===`)
console.log(`=== 识别：${realSpeech ? '真 host（' + hostCatalog.providers.map((p) => p.id + ':' + p.phase).join(', ') + '）' : '夹具（host 不可达 / 没有就绪识别器）'} ===`)

// ───────────────────────── 临时服务：页面 + 路由 ─────────────────────────

/** 浏览器真发过来的那段音频（真字节，Node 侧再校验一次格式契约）。 */
let capturedAudio = null

const HARNESS = `<!doctype html>
<html><head><meta charset="utf-8"><title>语音输入冒烟</title>
<style>body{margin:0;height:100vh;background:#eef1f5;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
#mount{position:relative;height:100vh}</style></head>
<body>
<div id="mount"></div>
<script>window.__ModuleLoader__ = { load: function (spec) { window.__spec = spec } }</script>
<script src="/lib/client.js"></script>
<script>
(function () {
  var React = { createElement: function (type, props) { return { type: type, props: props || {}, children: [] } } }
  if (!window.__spec) { window.__harnessError = 'bundle 没有注册 ModuleLoader 工厂'; return }
  var modules = window.__spec.factory(function (name) {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  window.__disposers = []
  var ctx = {
    effect: function (fn) { var d = fn(); if (typeof d === 'function') window.__disposers.push(d); return function () {} },
    on: function () {},
    get: function () { return undefined },
    slots: {
      inject: function (key, cb) { return cb() },
      register: function (options, component) { window.__registration = { options: options, component: component }; return function () {} }
    }
  }
  modules.apply(ctx)
  // 浮层组件 → 真 DOM：只用得到 createElement + ref（面板本身全是命令式 DOM）
  var element = window.__registration.component()
  var node = document.createElement(element.type)
  var props = element.props || {}
  for (var key in props) {
    if (key === 'ref' || key === 'children' || key === 'style') continue
    node[key] = props[key]
  }
  if (props.style) for (var s in props.style) node.style[s] = props.style[s]
  document.getElementById('mount').appendChild(node)
  props.ref(node)
  window.__harnessReady = true
})()
</script>
</body></html>`

const json = (res, body, status = 200) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** 把请求原样转给真 DSH host（识别这条路要的是真模型）。 */
async function proxy(req, res, pathname) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const upstream = await fetch(`${ORIGIN}${pathname}${new URL(req.url, 'http://x').search}`, {
    method: req.method,
    headers: { 'content-type': req.headers['content-type'] || 'application/json' },
    body: req.method === 'POST' ? body : undefined,
  })
  const text = await upstream.text()
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
  res.end(text)
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  void (async () => {
    if (pathname === '/' || pathname === '/harness.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HARNESS)
      return
    }
    if (pathname === '/lib/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(readFileSync(BUNDLE))
      return
    }
    // 小窗开场（analyze）：本地夹具，冒烟不烧模型额度
    if (pathname === '/selection-explain/api/analyze') {
      const sse = [
        `data: ${JSON.stringify({ type: 'start', provider: 'smoke', model: 'smoke', stage: 'translation' })}\n\n`,
        `data: ${JSON.stringify({ type: 'delta', text: '## 翻译\n这次数据迁移耗时超出预期，所以我们周三发布。\n' })}\n\n`,
        `data: ${JSON.stringify({ type: 'done', chars: 12 })}\n\n`,
      ].join('')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse)
      return
    }
    if (pathname === '/selection-explain/api/ping') {
      json(res, { ok: true, plugin: '@yfwu2020/dsh-selection-explain', route: null, reasoningEffortByStage: {}, tools: { enabled: false, offered: [], whitelist: [] } })
      return
    }
    if (pathname === '/selection-explain/api/models') {
      json(res, { ok: true, current: null, stages: null, models: [] })
      return
    }
    if (pathname === '/selection-explain/api/history') {
      json(res, { ok: true, entries: [] })
      return
    }
    if (pathname === '/selection-explain/api/quote-context') {
      json(res, { ok: true, matched: false, context: '', rounds: 0 })
      return
    }
    // 识别：先落一份真字节做格式校验，再转发给真 host（或回夹具）
    if (pathname === `${SPEECH_API}/transcribe`) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      let decoded = null
      try {
        const payload = JSON.parse(body.toString('utf8'))
        decoded = Buffer.from(String(payload.audioBase64 || ''), 'base64')
        capturedAudio = decoded
      } catch (error) {
        capturedAudio = null
      }
      if (!realSpeech) {
        json(res, { ok: true, text: '夹具转写的一段话', providerId: 'fixture', seconds: decoded ? (decoded.length - 44) / 32000 : 0 })
        return
      }
      const upstream = await fetch(`${ORIGIN}${SPEECH_API}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
      res.end(text)
      return
    }
    if (pathname.startsWith(SPEECH_API)) {
      if (realSpeech) {
        await proxy(req, res, pathname)
        return
      }
      json(res, { ok: true, available: true, reason: '', error: '', providers: [{ id: 'fixture', name: 'Fixture', location: 'cloud', languages: ['auto'], downloadSources: [], phase: 'ready' }], selection: { providerId: 'fixture', language: 'auto' }, limits: { maxSeconds: 60, maxBytes: 4194304 } })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found: ' + pathname)
  })().catch((error) => {
    try {
      json(res, { ok: false, error: String((error && error.message) || error) }, 500)
    } catch (ignored) {
      /* 头已经发出去了 */
    }
  })
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const pageUrl = `http://127.0.0.1:${port}/`

/** 极简 CDP 客户端（Node 24 自带 WebSocket，不引依赖）。 */
class Cdp {
  constructor(url) {
    this.seq = 0
    this.pending = new Map()
    this.ws = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')))
    })
    this.ws.addEventListener('message', (event) => {
      let message = null
      try {
        message = JSON.parse(String(event.data))
      } catch (error) {
        return
      }
      if (!message.id || !this.pending.has(message.id)) return
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message || 'CDP 调用失败'))
      else entry.resolve(message.result)
    })
  }
  async send(method, params) {
    await this.ready
    const id = ++this.seq
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }))
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 30000)
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) {
      const details = result.exceptionDetails.exception
      throw new Error('页面里抛错：' + ((details && details.description) || result.exceptionDetails.text))
    }
    return result.result ? result.result.value : undefined
  }
  async waitFor(expression, ms) {
    const started = Date.now()
    for (;;) {
      let value = false
      try {
        value = await this.eval(expression)
      } catch (error) {
        value = false
      }
      if (value) return true
      if (Date.now() - started > ms) return false
      await sleep(150)
    }
  }
  close() {
    try {
      this.ws.close()
    } catch (error) {
      /* noop */
    }
  }
}

/** 只截面板本体（2x）——README 的演示图要的是小窗，不是整页。 */
async function shotPanel(cdp, file) {
  const rect = await cdp.eval(`(() => {
    const node = document.querySelector('.dsh-sel-panel')
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { x: box.left, y: box.top, width: box.width, height: box.height }
  })()`)
  if (!rect || !rect.width) return ''
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, rect.x - 6), y: Math.max(0, rect.y - 6), width: rect.width + 12, height: rect.height + 12, scale: 2 },
  })
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  return file
}

/** 点一下某个元素的正中间（真鼠标事件 = 用户手势）。 */
async function clickSelector(cdp, selector) {
  const rect = await cdp.eval(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, w: box.width, h: box.height, top: box.top, left: box.left }
  })()`)
  if (!rect || !rect.w) return null
  const params = { x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...params })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params })
  return rect
}

// ───────────────────────── 起 headless Chrome ─────────────────────────

const debugPort = 9200 + Math.floor(Math.random() * 300)
const profile = join(workDir, 'profile')
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    // 读 --use-file-for-fake-audio-capture 那个文件会走沙箱里的文件读取，headless 下会失败
    // （Chrome 自己提示 "Try disabling the sandbox with --no-sandbox"）：
    // 不听劝的话假麦克风一直是**静音**，表现就是"录音成功但识别空"。
    // 这里只跑本地临时页面 + 一次性 profile，没有沙箱需求。
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--window-size=1280,900',
    // 假麦克风：授权自动通过，输入来自上面那段真语音（Chrome 会循环播放）
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${speechWav}`,
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)
let chromeLog = ''
child.stderr.on('data', (chunk) => {
  chromeLog += String(chunk)
})

const cleanup = () => {
  try {
    child.kill('SIGKILL')
  } catch (error) {
    /* noop */
  }
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    server.close()
  } catch (error) {
    /* noop */
  }
  try {
    rmSync(profile, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  } catch (error) {
    /* noop */
  }
}
process.on('exit', cleanup)

let version = null
for (let i = 0; i < 100; i += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
    if (response.ok) {
      version = await response.json()
      break
    }
  } catch (error) {
    /* 还没起来 */
  }
  await sleep(200)
}
if (!version) {
  console.log('SKIP  Chrome 没起来（DevTools 端口没响应）：' + chromeLog.slice(0, 300))
  cleanup()
  process.exit(0)
}
console.log(`=== Chrome：${version.Browser} ===`)

const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
const target = list.find((item) => item.type === 'page')
const cdp = new Cdp(target.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: pageUrl })

// ───────────────────────── 驱动真页面 ─────────────────────────

const harnessReady = await cdp.waitFor('!!(window.__harnessReady || window.__harnessError)', 20000)
const harnessError = await cdp.eval('window.__harnessError || ""')
assert('页面里跑起来了真的 lib/client.js（最小运行时桩）', harnessReady && !harnessError, harnessError || pageUrl)
if (!harnessReady || harnessError) {
  console.log('（Chrome 日志尾部：' + chromeLog.slice(-300) + '）')
  cdp.close()
  cleanup()
  process.exit(1)
}

await cdp.eval(`window.__dshSelectionExplain.open('the migration ran long, so we ship Wednesday', '', '语音冒烟')`)
const panelDone = await cdp.waitFor(`window.__dshSelectionExplain.state().phase === 'done'`, 15000)
assert('小窗打开、翻译就绪（analyze 走本地夹具）', panelDone, await cdp.eval('window.__dshSelectionExplain.state().phase'))

const composerVisible = await cdp.waitFor(
  `(() => { const row = document.querySelector('.dsh-sel-ask'); if (!row || row.style.display === 'none') return false; const mic = document.querySelector('.dsh-sel-mic'); return !!mic && mic.getBoundingClientRect().width > 0 })()`,
  8000,
)
assert('composer 与麦克风按钮可见（真的能点到）', composerVisible, String(composerVisible))
if (!composerVisible) {
  cdp.close()
  cleanup()
  process.exit(1)
}

const micBox = await clickSelector(cdp, '.dsh-sel-mic')
assert('用鼠标点到了麦克风（真事件，算用户手势）', !!micBox, micBox ? `${Math.round(micBox.w)}x${Math.round(micBox.h)}` : '找不到按钮')

const recording = await cdp.waitFor(`window.__dshSelectionExplain.voice().phase === 'recording'`, 10000)
const voiceWhileRecording = await cdp.eval('window.__dshSelectionExplain.voice()')
assert('真浏览器里进入录音态（授权 + MediaRecorder 都成）', recording, JSON.stringify(voiceWhileRecording))
if (!recording) {
  console.log('（录音没起来：' + JSON.stringify(voiceWhileRecording) + '）')
  cdp.close()
  cleanup()
  process.exit(1)
}

await sleep(1200)
// 实时字幕：**还在录**的时候输入框里就该有字了（半句预览，真识别）
const previewArrived = await cdp.waitFor(
  `(() => { const box = document.querySelector('.dsh-sel-askbox'); const v = window.__dshSelectionExplain.voice(); return !!box && box.value.trim().length > 0 && v.live.passes.preview >= 1 })()`,
  6000,
)
const liveState = await cdp.eval(
  `(() => { const box = document.querySelector('.dsh-sel-askbox'); const v = window.__dshSelectionExplain.voice(); return { value: box ? box.value : '', live: v.live } })()`,
)
assert('半句预览在录到 1-2 秒时就出字（不是等停止）', previewArrived, JSON.stringify(liveState).slice(0, 200))
assert(
  '录音中就已经有字了（半句预览：真 SenseVoice 边说边转）',
  liveState.value.trim().length > 0 && liveState.live.passes.preview >= 1,
  JSON.stringify(liveState).slice(0, 220),
)
assert(
  '预览文字就是输入框里那段（没有被追加重影）',
  liveState.value.trim() === String(liveState.live.preview || '').trim(),
  JSON.stringify({ value: liveState.value, preview: liveState.live.preview }).slice(0, 200),
)

// 输入框自适应拉伸：真浏览器里量一次（多行要撑开、超长要内部滚动并停在最新一行）
const layout = await cdp.eval(`(() => {
  const box = document.querySelector('.dsh-sel-askbox')
  const NL = String.fromCharCode(10) // 换行符：这段代码写在 Node 的模板字符串里，反斜杠转义会被提前吃掉
  const read = () => {
    const style = getComputedStyle(box)
    return {
      clientHeight: box.clientHeight,
      scrollHeight: box.scrollHeight,
      height: box.style.height,
      overflowY: style.overflowY,
      atBottom: box.scrollTop + box.clientHeight >= box.scrollHeight - 2,
    }
  }
  const saved = box.value
  box.value = ['第一行', '第二行', '第三行', '第四行'].join(NL)
  box.dispatchEvent(new Event('input', { bubbles: true }))
  const grown = read()
  box.value = Array.from({ length: 40 }, (_, i) => '第 ' + (i + 1) + ' 行').join(NL)
  box.dispatchEvent(new Event('input', { bubbles: true }))
  const capped = read()
  box.value = saved
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return { grown, capped, restored: read() }
})()`)
assert(
  '真浏览器：四行草稿把输入框撑开、下面的字没被裁掉',
  layout.grown.clientHeight >= 70 && layout.grown.clientHeight > 30 && layout.grown.scrollHeight <= layout.grown.clientHeight + 2,
  JSON.stringify(layout.grown),
)
assert(
  '真浏览器：超过上限（132px）改成内部滚动，并且停在最新一行',
  // 132px 是内容上限，加上 padding-top 4px = 136；超过就内部滚动，并且停在最新一行
  layout.capped.clientHeight <= 140 && layout.capped.scrollHeight > layout.capped.clientHeight && layout.capped.overflowY === 'auto' && layout.capped.atBottom === true,
  JSON.stringify(layout.capped),
)
assert('真浏览器：恢复成短草稿后又缩回去（不会一直占着高度）', layout.restored.clientHeight <= 40, JSON.stringify(layout.restored))

// 录音中留一张图：录音行（✕ / 波形 / ■）+ 输入框里跟着长出来的字（README 的演示图就是它）
try {
  const file = await shotPanel(cdp, process.env.SMOKE_SHOT_RECORDING || join(tmpdir(), 'dsh-voice-smoke-recording.png'))
  if (file) console.log(`=== 截图（录音中）：${file} ===`)
} catch (error) {
  /* 截图失败不影响断言 */
}
const midVoice = await cdp.eval('window.__dshSelectionExplain.voice()')
assert('录音中：工具行换成了录音行（✕ | 波形 | ■，与主会话同构）', midVoice.capture === true && midVoice.waveform === true && midVoice.stop === true, JSON.stringify({ capture: midVoice.capture, waveform: midVoice.waveform, stop: midVoice.stop }))
assert('录音中不显示秒数文案（主会话也是只看波形）', midVoice.activity === '', JSON.stringify(midVoice.activity))
assert('麦克风电平真的在动（假麦克风里放的是那段真语音）', midVoice.level > 0, String(midVoice.level))
assert(
  '波形真的在跳（80 根线里有明显高于 2px 基线的）',
  Array.isArray(midVoice.bars) && midVoice.bars.length === 80 && Math.max.apply(null, midVoice.bars) > 4,
  midVoice.bars ? `max=${Math.max.apply(null, midVoice.bars).toFixed(1)}` : 'no bars',
)

// 录音态下的窄窗口：✕ / 波形 / ■ / 发送键 都得在可视区里（多一个按钮最容易挤爆的就是这一行）
try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 760, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
  const narrowRecording = await cdp.eval(`(() => {
    const tools = document.querySelector('.dsh-sel-asktools')
    const row = document.querySelector('.dsh-sel-capture')
    const send = document.querySelector('.dsh-sel-asksend')
    const panel = document.querySelector('.dsh-sel-panel')
    if (!tools || !row || !send || !panel) return null
    const box = (node) => node.getBoundingClientRect()
    const panelBox = box(panel)
    const sendBox = box(send)
    return {
      overflow: tools.scrollWidth - tools.clientWidth,
      sendInPanel: sendBox.right <= panelBox.right + 1 && sendBox.bottom <= panelBox.bottom + 1,
      rowInPanel: box(row).right <= panelBox.right + 1,
    }
  })()`)
  assert('380px 录音态：录音行与发送键都在面板里、不横向溢出', !!narrowRecording && narrowRecording.overflow <= 1 && narrowRecording.sendInPanel && narrowRecording.rowInPanel, JSON.stringify(narrowRecording))
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await sleep(150)
} catch (error) {
  console.log('（录音态窄窗口检查跳过：' + String(error.message || error).slice(0, 120) + '）')
}
await sleep(4000)

// 回归（用户报过：只跟第一句、后面不吐字）：样本里带停顿，所以到这里应该已经**定稿过至少一次**，
// 而定稿之后实时层必须继续跟着出字 —— 这正是当时挂掉的地方（"没听清"被当成失败计数）。
const afterPause = await cdp.eval(
  `(() => { const box = document.querySelector('.dsh-sel-askbox'); const v = window.__dshSelectionExplain.voice(); return { value: box ? box.value : '', live: v.live } })()`,
)
assert('真浏览器里走到"停顿定稿"（样本里两句之间停了 1.3 秒）', afterPause.live.passes.commit >= 1 && afterPause.live.committed.length > 0, JSON.stringify(afterPause.live).slice(0, 220))
assert(
  '定稿之后照样继续出字（停顿那几拍"没听清"不能把实时层关掉）',
  afterPause.live.disabled === false && afterPause.live.reason === '',
  JSON.stringify({ disabled: afterPause.live.disabled, reason: afterPause.live.reason, value: afterPause.value }).slice(0, 200),
)
assert(
  '输入框里两句都在：第一句定稿 + 第二句半句预览（用户报的 bug 就是这里断的）',
  /你好|语音|测试/.test(afterPause.value) && /帮我|解释|划词|画词/.test(afterPause.value),
  JSON.stringify(afterPause.value),
)

// 结束录音按的是录音行里的 ■（不再是 🎤 —— 录音中 🎤 让位给录音行，和主会话一样）
const stopBox = await clickSelector(cdp, '.dsh-sel-stop')
assert('用鼠标点到了录音行的 ■（停止并识别）', !!stopBox, stopBox ? `${Math.round(stopBox.w)}x${Math.round(stopBox.h)}` : '找不到停止键')
await cdp.waitFor(`window.__dshSelectionExplain.voice().phase !== 'recording'`, 8000)

// 注意：输入框里**早就有字了**（实时预览），所以这里要等的是"整段识别收口完成"
const finalized = await cdp.waitFor(
  `(() => { const v = window.__dshSelectionExplain.voice(); return v.capture === false && v.phase === 'idle' })()`,
  40000,
)
const finalState = await cdp.eval(
  `(() => { const box = document.querySelector('.dsh-sel-askbox'); return { value: box ? box.value : '', voice: window.__dshSelectionExplain.voice() } })()`,
)
assert('停止后整段识别收口（录音行收起、实时层停机）', finalized, JSON.stringify(finalState.voice).slice(0, 160))
assert('识别出来的文字插进了追问输入框', finalState.value.trim().length > 0, JSON.stringify(finalState.value))
assert('识别完成后录音行收起、🎤 回来（和主会话一致：成功不另报一句）', finalState.voice.capture === false && finalState.voice.phase === 'idle', JSON.stringify({ capture: finalState.voice.capture, phase: finalState.voice.phase }))
assert('停止后实时层关掉（不再刷新那段文字）', finalState.voice.live.active === false, JSON.stringify(finalState.voice.live).slice(0, 120))
assert('没有报错（activity 不是错误色、也不是失败文案）', finalState.voice.activityTone !== 'error' && !/失败|未识别/.test(finalState.voice.activity), `${finalState.voice.activityTone} ${finalState.voice.activity}`)

// 浏览器真发过来的那段音频：格式必须和 host 的契约一致（这是桩测不出来的那一环）
assert('服务端拿到了浏览器录的音频', !!capturedAudio && capturedAudio.length > 44, capturedAudio ? String(capturedAudio.length) + ' 字节' : '没有')
if (capturedAudio) {
  let seconds = 0
  let formatError = ''
  try {
    seconds = validateWave(capturedAudio, 60)
  } catch (error) {
    formatError = String(error.message || error)
  }
  assert('浏览器产出的 WAV 通过 host 的逐字段校验（16kHz/单声道/PCM16）', formatError === '', formatError || `${seconds.toFixed(2)} 秒`)
  assert('录了 2.5 秒以上（不是点两下就结束的空录音）', seconds >= 2.5, `${seconds.toFixed(2)} 秒`)
}

if (realSpeech) {
  assert(
    '真 SenseVoice 转写的是那句真话（不是空串/乱码）',
    /语音|测试|你好|划词|画词|输入/.test(finalState.value),
    JSON.stringify(finalState.value),
  )
  console.log(`    识别结果：${JSON.stringify(finalState.value)}`)
} else {
  assert('夹具模式下也走完了"插进输入框"这一步', finalState.value.length > 0, JSON.stringify(finalState.value))
  console.log('    （没连真识别服务：只验了浏览器侧链路与音频格式）')
}

// 窄窗口兜底：composer 工具行多了麦克风之后，窄面板下不能把发送键挤出去
try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 760, deviceScaleFactor: 1, mobile: false })
  await sleep(200)
  const narrow = await cdp.eval(`(() => {
    const tools = document.querySelector('.dsh-sel-asktools')
    const send = document.querySelector('.dsh-sel-asksend')
    const mic = document.querySelector('.dsh-sel-mic')
    if (!tools || !send || !mic) return null
    const row = tools.getBoundingClientRect()
    const sendBox = send.getBoundingClientRect()
    const micBox = mic.getBoundingClientRect()
    return {
      overflow: tools.scrollWidth - tools.clientWidth,
      sendInside: sendBox.right <= row.right + 1 && sendBox.left >= row.left - 1,
      bothInPanel: sendBox.bottom <= document.querySelector('.dsh-sel-panel').getBoundingClientRect().bottom + 1,
      micVisible: micBox.width > 0 && micBox.height > 0,
    }
  })()`)
  assert(
    '380px 窄窗口下：工具行不横向溢出、发送键与麦克风都还在可视区内',
    !!narrow && narrow.overflow <= 1 && narrow.sendInside && narrow.bothInPanel && narrow.micVisible,
    JSON.stringify(narrow),
  )
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await sleep(150)
} catch (error) {
  console.log('（窄窗口检查跳过：' + String(error.message || error).slice(0, 120) + '）')
}

try {
  const shotPath = await shotPanel(cdp, process.env.SMOKE_SHOT || join(tmpdir(), 'dsh-voice-smoke.png'))
  if (shotPath) console.log(`=== 截图（已插入）：${shotPath} ===`)
} catch (error) {
  console.log('（截图失败：' + String(error.message || error).slice(0, 120) + '）')
}

// ── Esc 两级 + 开窗聚焦（真按键、真焦点）─────────────────────────────
async function pressEscape() {
  const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

await cdp.eval(`window.__dshSelectionExplain.open('voice-probe', '', 'Esc 冒烟')`)
await cdp.waitFor(`window.__dshSelectionExplain.state().phase === 'done'`, 15000)
const focused = await cdp.waitFor(`document.activeElement && document.activeElement.className.indexOf('dsh-sel-askbox') >= 0`, 5000)
assert('开窗后输入框自动获得焦点（键盘用户直接就能打字）', focused, await cdp.eval('String(document.activeElement && document.activeElement.className)'))

await clickSelector(cdp, '.dsh-sel-mic')
await cdp.waitFor(`window.__dshSelectionExplain.voice().phase === 'recording'`, 10000)
await pressEscape()
await sleep(400)
const afterEsc = await cdp.eval(`(() => { const v = window.__dshSelectionExplain.voice(); return { phase: v.phase, capture: v.capture, open: window.__dshSelectionExplain.quoteState().panelOpen, display: getComputedStyle(document.querySelector('.dsh-sel-panel')).display } })()`)
assert('录音中按 Esc：只取消录音，面板留着（不再顺手关窗）', afterEsc.phase === 'idle' && afterEsc.capture === false && afterEsc.open === true && afterEsc.display !== 'none', JSON.stringify(afterEsc))

await pressEscape()
await sleep(300)
const afterEsc2 = await cdp.eval(`window.__dshSelectionExplain.quoteState().panelOpen`)
assert('不录音时再按 Esc：这才关窗（两级 Esc 的第二级）', afterEsc2 === false, String(afterEsc2))

cdp.close()
cleanup()

console.log(`\n=== 语音输入浏览器冒烟：${failed === 0 ? '全部通过' : failed + ' 项失败'} ===`)
process.exit(failed === 0 ? 0 : 1)
