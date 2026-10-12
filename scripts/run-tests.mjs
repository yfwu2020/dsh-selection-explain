/** Run independent test processes in order, preserving their exit status. */
import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const suite = process.argv[2] || 'all'
const suites = suite === 'all' ? ['unit', 'integration', 'browser'] : [suite]
if (!suites.every(name => ['unit', 'integration', 'browser', 'online'].includes(name))) {
  throw new Error(`Unknown test suite: ${suite}`)
}
for (const name of suites) {
  const files = name === 'online'
    ? ['tests/unit/speech.test.mjs', 'tests/browser/voice.test.mjs']
    : (await readdir(resolve(root, 'tests', name))).filter(file => file.endsWith('.test.mjs')).sort().map(file => `tests/${name}/${file}`)
  for (const file of files) {
    console.log(`\n[test:${name}] ${file}`)
    const status = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [resolve(root, file)], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, SEL_ONLINE: name === 'online' ? '1' : '0' },
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => done(signal ? 1 : code ?? 1))
    })
    if (status !== 0) process.exit(status)
  }
}
