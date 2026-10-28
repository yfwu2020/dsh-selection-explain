import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveNativeProbe } from '../../lib/host/native-probe.js'

test('a source-only installation builds and reuses its own hash-addressed probe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-probe-'))
  try {
    const sourcePath = join(dir, 'window-list.c')
    await writeFile(sourcePath, 'source-v1')
    let builds = 0
    const options = { name: 'window-list', sourcePath, packagedPath: join(dir, 'missing'), cacheDir: join(dir, 'cache'), frameworks: ['CoreGraphics'],
      compile: async (_source, target) => { builds++; await writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); return true } }
    const first = await resolveNativeProbe(options)
    await access(first)
    assert.match(first, /window-list-[0-9a-f]{12}$/)
    assert.equal(await resolveNativeProbe(options), first)
    assert.equal(builds, 1)
    await writeFile(sourcePath, 'source-v2')
    assert.notEqual(await resolveNativeProbe(options), first)
    assert.equal(builds, 2)
    await writeFile(options.packagedPath, 'packaged')
    assert.equal(await resolveNativeProbe(options), options.packagedPath)
    assert.equal(builds, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('missing source or failed compiler cannot become a usable cached probe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-probe-'))
  try {
    const options = { name: 'window-list', sourcePath: join(dir, 'source.c'), packagedPath: join(dir, 'missing'), cacheDir: join(dir, 'cache'), frameworks: [], compile: async () => false }
    assert.equal(await resolveNativeProbe(options), '')
    await writeFile(options.sourcePath, 'source')
    assert.equal(await resolveNativeProbe(options), '')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
