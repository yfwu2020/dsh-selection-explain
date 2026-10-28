import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { createHistoryStore } from './history-store.js'
import type { createModels } from './models.js'
import type { createSessions } from './sessions.js'

/** Instance-owned services; request state lives in PreparedAnalyzeRequest and AnalyzeHistory. */
export interface AnalyzeDependencies {
  ctx: Context
  config: Config
  models: ReturnType<typeof createModels>
  sessions: ReturnType<typeof createSessions>
  historyStore: ReturnType<typeof createHistoryStore>
}
