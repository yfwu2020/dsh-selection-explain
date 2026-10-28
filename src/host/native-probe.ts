import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export interface NativeProbeOptions {
  name: string
  sourcePath: string
  packagedPath: string
  cacheDir: string
  frameworks: string[]
  compile?: (source: string, output: string, frameworks: string[]) => Promise<boolean>
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(value => value.isFile() && value.size > 0).catch(() => false)
}

/** A source-only npm package can recover its native helper without modifying the package. */
export async function resolveNativeProbe(options: NativeProbeOptions): Promise<string> {
  if (await exists(options.packagedPath)) return options.packagedPath
  let source: Buffer
  try { source = await readFile(options.sourcePath) } catch { return '' }
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12)
  const output = join(options.cacheDir, `${options.name}-${hash}`)
  if (await exists(output)) return output
  const temporary = `${output}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    await mkdir(options.cacheDir, { recursive: true, mode: 0o700 })
    const compile = options.compile ?? compileNativeProbe
    if (!await compile(options.sourcePath, temporary, options.frameworks) || !await exists(temporary)) return ''
    await chmod(temporary, 0o755)
    await rename(temporary, output)
    return output
  } catch { return '' }
  finally { await rm(temporary, { force: true }).catch(() => {}) }
}

/** Prefer a matching Xcode compiler/SDK pair, then the command-line tools. */
async function compileNativeProbe(source: string, output: string, frameworks: string[]): Promise<boolean> {
  const flags = ['-O2', ...frameworks.flatMap(name => ['-framework', name]), source, '-o', output]
  const xcode = '/Applications/Xcode.app/Contents/Developer'
  const compiler = join(xcode, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang')
  const attempts: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
  try {
    await access(compiler)
    const env = { ...process.env, DEVELOPER_DIR: xcode }
    const sdk = (await execute('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { env, timeout: 15000 })).stdout.trim()
    attempts.push({ command: compiler, args: ['-isysroot', sdk, ...flags], env })
  } catch { /* Xcode is optional. */ }
  attempts.push({ command: 'clang', args: flags }, { command: 'xcrun', args: ['clang', ...flags] })
  for (const attempt of attempts) {
    try {
      await execute(attempt.command, attempt.args, { timeout: 60000, env: attempt.env })
      if (await exists(output)) return true
    } catch { /* Try the next installed toolchain. */ }
  }
  return false
}
