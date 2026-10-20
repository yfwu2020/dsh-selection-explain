import { createClientFixture } from './setup.mjs'
import { run as settings } from './scenarios/settings.mjs'
import { run as rendering } from './scenarios/rendering.mjs'
import { run as history_models } from './scenarios/history-models.mjs'
import { run as preview_quotes } from './scenarios/preview-quotes.mjs'
import { run as voice } from './scenarios/voice.mjs'
import { run as voice_card } from './scenarios/voice-card.mjs'
import { run as skip_translation } from './scenarios/skip-translation.mjs'
import { run as cleanup } from './scenarios/cleanup.mjs'
import { run as context } from './scenarios/context.mjs'
import { run as memory } from './scenarios/memory.mjs'
const env = await createClientFixture()
if (!env.HOST_UP) throw new Error("Client integration requires the isolated fixture or an explicit SEL_ORIGIN")
if (process.env.SEL_CLIENT_SCENARIO === 'memory' || process.env.SEL_CLIENT_SCENARIO === 'context') {
  try { await (process.env.SEL_CLIENT_SCENARIO === 'context' ? context : memory)(env) } finally { for (const dispose of env.disposers.reverse()) dispose() }
  process.exit(process.exitCode ?? 0)
}
await settings(env)
await rendering(env)
await history_models(env)
await preview_quotes(env)
await voice(env)
await voice_card(env)
await skip_translation(env)
await context(env)
await memory(env)
await cleanup(env)
process.exit(process.exitCode ?? 0)
