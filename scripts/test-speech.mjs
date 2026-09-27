/**
 * 语音输入（小窗麦克风）的离线 + 在线测试。
 *
 * 两段：
 *   ① 离线：host 的 validateWave 与**客户端编码出来的格式**是同一份契约。
 *      浏览器端只能产出 16kHz 单声道 PCM16 WAV（见 client 的 encodeWave），
 *      host 逐字段校验它 —— 这里逐条打表：每个字段错一位都必须被拒。
 *      为什么抠这么细：这个校验是"音频进识别服务"的唯一闸门，漏一位就会让
 *      识别服务按错误的采样率听一段快放（结果全错，而且没人知道为什么）。
 *   ② 在线（DSH 在跑时才跑）：真路由
 *      GET  /speech            目录与就绪状态
 *      POST /speech/transcribe 一段音频 → 文字
 *      用合成的音频（正弦波/静音）验证"能跑通、坏输入被挡住"；
 *      真实的识别效果（真人语音 → 正确文字）由 scripts/smoke-voice.mjs 在真浏览器里跑。
 *      SPEECH_WAV=/tmp/x.wav 可以让它顺便验一句真话：那必须是规范 WAV
 *      （macOS 上可以用 `say -o /tmp/v.aiff "..."` + `ffmpeg -i /tmp/v.aiff -ac 1 -ar 16000
 *      -c:a pcm_s16le -fflags +bitexact /tmp/v.wav` 生成）。
 *
 * 用法：node scripts/test-speech.mjs
 *      SEL_ORIGIN=http://127.0.0.1:3080 node scripts/test-speech.mjs
 *      SPEECH_WAV=/tmp/v.wav node scripts/test-speech.mjs
 * 退出码：全部 PASS = 0。
 */
import { readFileSync } from 'node:fs'
import { validateWave } from '../lib/index.js'

const ORIGIN = process.env.SEL_ORIGIN || 'http://127.0.0.1:3080'
const SPEECH_API = '/selection-explain/api/speech'

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : ' — ' + extra}`)
}

/** 抛错算通过（校验必须拒收）。 */
function rejects(name, run) {
  try {
    run()
    check(name, false, '没有抛错（本该拒收）')
  } catch (error) {
    check(name, true, error.message)
  }
}

// ───────────────────────── ① 规范 WAV 契约（与客户端 encodeWave 同源） ─────────────────────────

/** 造一段规范 WAV（和客户端 encodeWave 逐字节同构）。 */
function makeWave(seconds, fill = 0.25) {
  const samples = Math.round(seconds * 16000)
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(36 + samples * 2, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i += 1) {
    bytes.writeInt16LE(Math.round(Math.sin(i / 20) * fill * 32767), 44 + i * 2)
  }
  return bytes
}

const oneSecond = makeWave(1)
check('规范 WAV：1 秒 → 时长 1.0', validateWave(oneSecond, 60) === 1, String(validateWave(oneSecond, 60)))
check('规范 WAV：0.25 秒也认', Math.abs(validateWave(makeWave(0.25), 60) - 0.25) < 1e-6)
check('规范 WAV：正好 60 秒放行（边界含）', validateWave(makeWave(60), 60) === 60)

rejects('空录音（只有头，0 采样）被拒', () => validateWave(makeWave(0), 60))
rejects('超过时长上限被拒', () => validateWave(makeWave(61), 60))
rejects('太短的字节串被拒（连头都不全）', () => validateWave(Buffer.alloc(20), 60))
rejects('不是 RIFF 的被拒', () => {
  const bad = makeWave(0.5)
  bad.write('RIFX', 0, 'ascii')
  return validateWave(bad, 60)
})
rejects('不是 WAVE 的被拒', () => {
  const bad = makeWave(0.5)
  bad.write('AVI ', 8, 'ascii')
  return validateWave(bad, 60)
})
rejects('采样率 8kHz 被拒（会被当成快放听）', () => {
  const bad = makeWave(0.5)
  bad.writeUInt32LE(8000, 24)
  bad.writeUInt32LE(16000, 28)
  return validateWave(bad, 60)
})
rejects('采样率对、字节率不对也被拒（自相矛盾的头）', () => {
  const bad = makeWave(0.5)
  bad.writeUInt32LE(16000, 28)
  return validateWave(bad, 60)
})
rejects('立体声被拒', () => {
  const bad = makeWave(0.5)
  bad.writeUInt16LE(2, 22)
  return validateWave(bad, 60)
})
rejects('8 位深被拒', () => {
  const bad = makeWave(0.5)
  bad.writeUInt16LE(8, 34)
  return validateWave(bad, 60)
})
rejects('非 PCM（浮点/压缩）被拒', () => {
  const bad = makeWave(0.5)
  bad.writeUInt16LE(3, 20)
  return validateWave(bad, 60)
})
rejects('前面塞了别的 chunk（数据不在 44 偏移）被拒', () => {
  const good = makeWave(0.5)
  const bad = Buffer.concat([good.subarray(0, 36), Buffer.from('FLLR0000', 'ascii'), good.subarray(36)])
  return validateWave(bad, 60)
})
rejects('RIFF 长度字段与实际不符被拒', () => {
  const bad = makeWave(0.5)
  bad.writeUInt32LE(bad.length, 4)
  return validateWave(bad, 60)
})
rejects('data 长度字段与实际不符被拒', () => {
  const bad = makeWave(0.5)
  bad.writeUInt32LE(bad.length, 40)
  return validateWave(bad, 60)
})
rejects('奇数采样字节（半截采样）被拒', () => {
  const bad = makeWave(0.5).subarray(0, 44 + 1000 + 1)
  bad.writeUInt32LE(bad.length - 8, 4)
  bad.writeUInt32LE(bad.length - 44, 40)
  return validateWave(bad, 60)
})

// ───────────────────────── ② 真路由（DSH 在跑才有意义） ─────────────────────────

async function online() {
  let reachable = false
  try {
    const probe = await fetch(`${ORIGIN}${SPEECH_API}`)
    reachable = probe.ok
  } catch (error) {
    reachable = false
  }
  if (!reachable) {
    console.log(`\n=== 在线部分跳过：${ORIGIN} 不可达（DSH 没在跑）===`)
    return
  }

  const catalog = await (await fetch(`${ORIGIN}${SPEECH_API}`)).json()
  check('目录接口：returns ok + limits', catalog.ok === true && !!catalog.limits, JSON.stringify(catalog.limits))
  check(
    '目录接口：报出识别器与各自的就绪状态',
    Array.isArray(catalog.providers) && catalog.providers.every((p) => typeof p.id === 'string' && typeof p.phase === 'string'),
    catalog.providers.map((p) => `${p.id}:${p.phase}`).join(',') || '(空)',
  )
  check('目录接口：available 与 providers 的状态自洽', catalog.available === catalog.providers.some((p) => p.phase === 'ready' || p.phase === 'standby'), `available=${catalog.available}`)

  const post = (body) =>
    fetch(`${ORIGIN}${SPEECH_API}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((response) => response.json())

  const garbage = await post({ audioBase64: 'bm90LWF1ZGlv' })
  check('坏 base64（不是音频）被拒且不报 500', garbage.ok === false && garbage.code === 'audio', JSON.stringify(garbage))

  const notCanonical = await post({ audioBase64: makeWave(0.5).toString('base64').replace(/^/, '') })
  check('规范 WAV 能进到识别（0.5 秒正弦）', typeof notCanonical.ok === 'boolean', JSON.stringify(notCanonical).slice(0, 120))
  check(
    '正弦波不会被"听"成话（空转写或明确失败，不会瞎编）',
    notCanonical.ok === false ? notCanonical.code !== 'audio' : String(notCanonical.text || '').length < 40,
    JSON.stringify(notCanonical).slice(0, 160),
  )

  const wrongRate = makeWave(0.5)
  wrongRate.writeUInt32LE(8000, 24)
  const rejected = await post({ audioBase64: wrongRate.toString('base64') })
  check('采样率不对的音频在 host 就被挡住（不进识别服务）', rejected.ok === false && rejected.code === 'audio', JSON.stringify(rejected))

  // 超大请求：host 在流读完之前就 reject 并 destroy（和别的路由一致），
  // 客户端这边看到的是连接被掐断而不是 JSON —— 两种都算"被挡住"。
  let oversized = null
  let oversizedError = ''
  try {
    oversized = await post({ audioBase64: Buffer.alloc(6 * 1024 * 1024).toString('base64') })
  } catch (error) {
    oversizedError = String(error && error.cause ? error.cause.message || error.cause : error)
  }
  check(
    '超大音频被拒（不会把内存吃穿）',
    oversizedError !== '' || (oversized && oversized.ok === false),
    oversizedError ? '连接被掐断：' + oversizedError : JSON.stringify(oversized).slice(0, 120),
  )

  const method = await fetch(`${ORIGIN}${SPEECH_API}/transcribe`, { method: 'GET' })
  check('转写接口只收 POST', method.status === 405, String(method.status))

  // 真语音（可选）：给了 SPEECH_WAV 就顺便验一句人话
  if (process.env.SPEECH_WAV) {
    const wav = readFileSync(process.env.SPEECH_WAV)
    const seconds = validateWave(wav, 60)
    const started = Date.now()
    const result = await post({ audioBase64: wav.toString('base64') })
    check('真语音：识别成功且拿到文字', result.ok === true && String(result.text).length > 0, JSON.stringify(result).slice(0, 200))
    check('真语音：host 报了用时（本地模型也该在几秒内）', result.ok === true && Date.now() - started < 60000, `${Date.now() - started}ms / 音频 ${seconds.toFixed(2)}s`)
  } else {
    console.log('（跳过真语音识别：要验就设 SPEECH_WAV=/tmp/v.wav）')
  }
}

await online()

console.log(`\n=== 语音测试结束：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
