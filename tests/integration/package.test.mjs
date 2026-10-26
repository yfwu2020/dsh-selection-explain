/** Load the packed artifact, not the checkout, to catch missing runtime resources. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dir = await mkdtemp(join(tmpdir(), 'dsh-package-test-'))
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: root, encoding: 'utf8' }))
  const paths = pack.files.map(file => file.path)
  assert.equal(paths.some(path => /^(src|scripts|tests|assets|docs)\//.test(path)), false)
  execFileSync('tar', ['-xf', join(dir, pack.filename), '-C', dir])
  const pkg = join(dir, 'package')
  // Peers are supplied by DSH in production; provide only that host boundary here.
  await symlink(join(root, 'node_modules'), join(pkg, 'node_modules'), 'dir')
  for (const path of ['lib/index.js', 'lib/types/index.d.ts', 'lib/client.js', 'cordis.patch.yml', 'native/mic-probe.c', 'skills/web-design/SKILL.md']) await access(join(pkg, path))
  const entry = await import(pathToFileURL(join(pkg, 'lib/index.js')).href)
  assert.equal(entry.name, '@yfwu2020/dsh-selection-explain')
  assert.equal(typeof entry.apply, 'function')
  const { loadDesignSkill } = await import(pathToFileURL(join(pkg, 'lib/host/design-skill.js')).href)
  assert.equal((await loadDesignSkill()).includes('页面本身就是回答'), true)
  let registered
  const code = await readFile(join(pkg, 'lib/client.js'), 'utf8')
  const window = { __ModuleLoader__: { load(spec) { registered = spec } } }
  new Function('window', code)(window)
  assert.equal(registered.id, entry.name)
  const client = registered.factory(id => { assert.equal(id, 'react'); return {createElement() {}} })
  assert.equal(typeof client.apply, 'function')
  // shortcuts 是 ⌘⇧X 截图提问引入的（987a584）：客户端要 register 全局快捷键，
  // 而 cordis 的服务按插件隔离 —— 不在这里声明 inject，ctx.get('shortcuts') 就是 undefined。
  assert.deepEqual(client.inject, ['slots', 'shortcuts'])
  console.log(`PASS packed entry, lazy client and runtime resources (${pack.size} bytes)`)
} finally { await rm(dir, { recursive: true, force: true }) }
