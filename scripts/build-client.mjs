import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.js'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  external: ['react'],
  target: 'es2023',
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}})' },
  sourcemap: 'external',
})
