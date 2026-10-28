import { createPanelPage } from './panel-page.mjs'
/**
 * 小窗面板的**真浏览器**冒烟测试（无头 Chrome）。
 *
 * 为什么需要它：`test-client.mjs` 用的是手搓 DOM 桩，桩上"什么都对"但真实浏览器里
 * 连着踩过三次（都是它测不出来的那类问题）：
 *   ① `mouseup` 对面板内的目标直接 return —— 小窗里划词毫无反应（桩里 target 用的是 document.body）；
 *   ② 引用浮标的 z-index 比面板低 —— 浮标画在面板**底下**，看不见也点不着（桩里不跑层叠）；
 *   ③ 翻译 / 详解两节里划词取不到（桩里没覆盖"节"这条路径）。
 * 所以这里用真 DOM、真选区、真 MouseEvent、真层叠（`elementFromPoint`）跑一遍主要交互。
 *
 * 用法：node tests/browser/panel.test.mjs [lib/client.js 路径]
 *       CHROME=/path/to/chrome node tests/browser/panel.test.mjs
 * 退出码：全部 PASS = 0；找不到 Chrome 打印 SKIP 后退出 0（与 smoke-bridge 一致）。
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BUNDLE = process.argv[2] || resolve(ROOT, 'lib', 'client.js')

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

const chrome = findChrome()
if (!chrome) {
  if (process.env.REQUIRE_BROWSER === '1') throw new Error('Chrome/Chromium is required for the browser suite')
  console.log('SKIP  没找到 Chrome/Chromium（设 CHROME=/path/to/chrome 可指定）')
  process.exit(0)
}

const PAGE = createPanelPage()

const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
    res.end(readFileSync(BUNDLE))
    return
  }
  // 回放路由：<img src> 是**浏览器自己**发起的资源请求，走不到 window.fetch 的桩，
  // 所以必须在真服务器上有一条。用真 PNG 回，缩略图才画得出来（假字节 = 破图）。
  if (url === '/selection-explain/api/attachment') {
    // 回放路由按引用里的文件名给不同的真图：多图预览截图里才看得出"确实换了张图"。
    var refName = ''
    try {
      var raw = new URL(req.url, 'http://x').searchParams.get('ref') || ''
      refName = JSON.parse(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).name || ''
    } catch (error) {
      refName = ''
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    res.end(readFileSync(resolve(ROOT, 'assets', refName === '第二张.png' ? 'translation.png' : 'voice.png')))
    return
  }
  // ?shot=attach 用的真图片：缩略图要能画出东西，截出来才可核对
  if (url === '/thumb.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(readFileSync(resolve(ROOT, 'assets', 'voice.png')))
    return
  }
  // 第二张用一张别的真图：多图预览截图里能看出"确实换了一张"，不是同一张重画
  if (url === '/thumb2.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(readFileSync(resolve(ROOT, 'assets', 'translation.png')))
    return
  }
  if (url === '/' || url === '/smoke.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port

function parseDump(dump) {
  const matched = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dump || '')
  if (!matched) return null
  const text = matched[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

let results = null
let dump = ''
try {
  for (let attempt = 1; attempt <= 2 && !results; attempt += 1) {
    const out = await new Promise((done) => {
      execFile(
        chrome,
        [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--window-size=1200,900',
          '--virtual-time-budget=25000',
          '--dump-dom',
          `http://127.0.0.1:${port}/smoke.html`,
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90000 },
        (error, stdout) => done(stdout || ''),
      )
    })
    dump = out
    results = parseDump(dump)
  }

  // 截图（可选，失败不影响判定）：把两个终态并排拍一张 —— 换图标时人工核对用。
  // 走同一个页面，加 ?shot=1 让页面在跑完检查后把"展开态 / 收球态"克隆出来并排摆好。
  try {
    const shotDir = resolve(ROOT, 'docs')
    if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true })
    const shotPath = resolve(shotDir, 'pill-star-states.png')
    await new Promise((done) => {
      execFile(
        chrome,
        [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--window-size=1180,560',
          '--virtual-time-budget=20000',
          `--screenshot=${shotPath}`,
          `http://127.0.0.1:${port}/smoke.html?shot=1`,
        ],
        { encoding: 'utf8', timeout: 90000 },
        () => done(),
      )
    })
    console.log(`=== 截图（圆点 / 星芒 两个终态）：${shotPath} ===`)
  } catch (error) {
    console.log('（截图跳过：' + ((error && error.message) || String(error)) + '）')
  }

  // 截图（可选）：小窗 composer 带附件时的**真样子**（不是设计稿）。
  // ?shot=attach 会让页面开窗 + 挂两件附件（一张真图 + 一个文件）后停住。
  try {
    const shotDir = resolve(ROOT, 'docs')
    if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true })
    const shotPath = resolve(shotDir, 'attach-composer-real.png')
    await new Promise((done) => {
      execFile(
        chrome,
        [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--window-size=760,560',
          '--virtual-time-budget=25000',
          `--screenshot=${shotPath}`,
          `http://127.0.0.1:${port}/smoke.html?shot=attach`,
        ],
        { encoding: 'utf8', timeout: 90000 },
        () => done(),
      )
    })
    console.log(`=== 截图（小窗 composer 带附件 · 真实渲染）：${shotPath} ===`)
  } catch (error) {
    console.log('（附件截图跳过：' + ((error && error.message) || String(error)) + '）')
  }

  // 截图（可选）：发出去的那条消息 —— 气泡里的缩略图与文件卡
  try {
    const shotPath = resolve(ROOT, 'docs', 'attach-bubble-real.png')
    await new Promise((done) => {
      execFile(
        chrome,
        ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=760,620', '--virtual-time-budget=25000', `--screenshot=${shotPath}`, `http://127.0.0.1:${port}/smoke.html?shot=bubble`],
        { encoding: 'utf8', timeout: 90000 },
        () => done(),
      )
    })
    console.log(`=== 截图（消息气泡里的附件 · 真实渲染）：${shotPath} ===`)
  } catch (error) {
    console.log('（气泡截图跳过：' + ((error && error.message) || String(error)) + '）')
  }

  // 截图（可选）：图片预览灯箱（点气泡里的缩略图之后）
  try {
    const shotPath = resolve(ROOT, 'docs', 'attach-preview-real.png')
    await new Promise((done) => {
      execFile(
        chrome,
        ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=900,680', '--virtual-time-budget=25000', `--screenshot=${shotPath}`, `http://127.0.0.1:${port}/smoke.html?shot=preview`],
        { encoding: 'utf8', timeout: 90000 },
        () => done(),
      )
    })
    console.log(`=== 截图（图片预览灯箱 · 真实渲染）：${shotPath} ===`)
  } catch (error) {
    console.log('（预览截图跳过：' + ((error && error.message) || String(error)) + '）')
  }

  // 截图（可选）：拖放遮罩（拖文件到小窗上时铺的那一层）
  try {
    const shotPath = resolve(ROOT, 'docs', 'attach-drop-real.png')
    await new Promise((done) => {
      execFile(
        chrome,
        [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--window-size=760,560',
          '--virtual-time-budget=25000',
          `--screenshot=${shotPath}`,
          `http://127.0.0.1:${port}/smoke.html?shot=drop`,
        ],
        { encoding: 'utf8', timeout: 90000 },
        () => done(),
      )
    })
    console.log(`=== 截图（拖放遮罩 · 真实渲染）：${shotPath} ===`)
  } catch (error) {
    console.log('（遮罩截图跳过：' + ((error && error.message) || String(error)) + '）')
  }
} finally {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  server.close()
}

let failed = 0
if (!results) {
  // 与 voice / bridge 冒烟同一套规矩：**Chrome 根本没跑起来**（容器缺 dbus/显示、
  // 或有别的浏览器占着）不是面板的错，按 SKIP 处理；真跑起来了却没有结果仍然判失败。
  if (!dump.trim() && process.env.REQUIRE_BROWSER !== '1' && process.env.SEL_ONLINE !== '1') {
    console.log('SKIP  Chrome 没起来（没拿到任何页面输出）—— 面板冒烟本次不跑')
    process.exit(0)
  }
  console.log('FAIL  浏览器里没拿到结果（<pre id="out">）')
  console.log(dump.slice(0, 400))
  failed += 1
} else {
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.extra ? ' — ' + item.extra : ''}`)
    if (!item.ok) failed += 1
  }
}
console.log(`\n=== 小窗面板冒烟结束：${results ? results.length - failed : 0} 通过 / ${failed} 失败 ===`)
process.exit(failed === 0 ? 0 : 1)
