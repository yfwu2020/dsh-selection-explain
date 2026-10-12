/** Public DSH plugin entry; implementation lives in host/. */
export { name, inject, PLUGIN_SOURCE_KIND } from './host/constants.js'
export { Config } from './host/config.js'
export { apply } from './host/plugin.js'
export { validateWave } from './host/speech.js'
export { isInsideRoot } from './host/tools.js'
export { transcriptOf, quoteContextOf } from './host/context.js'
export type { QuoteContext, QuoteContextOptions } from './host/context.js'
export type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { createThinkFilter, splitLeakedReasoning, looksLikeLeakedReasoning } from './host/filters.js'
import { resolveToolNames } from './host/tools.js'
import { looksLikeUnsupportedTier, looksLikeReasoningRequired, pickNextEffort, mapEffortToModel, effortMapOf } from './host/effort.js'
export const __internals = {
  createThinkFilter,
  splitLeakedReasoning,
  looksLikeLeakedReasoning,
  resolveToolNames,
  looksLikeUnsupportedTier,
  looksLikeReasoningRequired,
  pickNextEffort,
  mapEffortToModel,
  effortMapOf,
}
