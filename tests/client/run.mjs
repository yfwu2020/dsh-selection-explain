import { createClientFixture } from './setup.mjs'
import { CLIENT_SCENARIOS } from './scenario-list.mjs'

const name = process.env.SEL_CLIENT_SCENARIO
if (!CLIENT_SCENARIOS.includes(name)) throw new Error('Select one client scenario: ' + CLIENT_SCENARIOS.join(', '))
const { run } = await import('./scenarios/' + name + '.mjs')
const env = await createClientFixture()
try {
  if (!env.HOST_UP) throw new Error('Client integration requires its isolated host fixture')
  for (let i = 0; i < 150 && !['done', 'error'].includes(env.hook.state().phase); i++) await env.sleep(20)
  console.log('[client:scenario] ' + name)
  await run(env)
} finally {
  for (const dispose of env.disposers.splice(0).reverse()) dispose()
}
process.exit(process.exitCode ?? 0)
