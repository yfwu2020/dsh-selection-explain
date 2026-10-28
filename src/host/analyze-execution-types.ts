import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { ServerResponse } from 'node:http'
import type { AnalyzeMessages } from './analyze-messages.js'
import type { AnalyzePrompt } from './analyze-prompt.js'
import type { PreparedAnalyzeRequest } from './analyze-request.js'
import type { AnalyzeToolPlan } from './analyze-tools.js'
import type { AnalyzeDependencies } from './analyze-types.js'

/** Stable request resources shared by round, tool and conclusion execution. */
export interface AnalyzeExecutionContext {
  deps: AnalyzeDependencies
  request: PreparedAnalyzeRequest
  tools: AnalyzeToolPlan
  prompt: AnalyzePrompt
  messages: AnalyzeMessages
  res: ServerResponse
  controller: AbortController
  executionState: { upstreamStarted: boolean }
  clientClosedEarly: () => boolean
}

export interface AnalyzeRoundDiagnostics {
  round: number
  wrapUp: boolean
  ms: number
  raw: number
  emitted: number
  think: number
  finish: string
  tools: number
  tailChunks?: string[]
  outTokens?: number
}

/** Explicit cross-round state; helpers update the same streamed answer and tool history. */
export interface AnalyzeStreamState {
  chars: number
  errored: boolean
  usage: unknown
  answer: string
  toolMessages: Message[]
  recoveredMaterialBlocks: ContentBlock[]
  toolContextTokens: number
  toolCalls: number
  errorMessage: string
  errorCode?: string
  toolDigestLines: string[]
  roundDiag: AnalyzeRoundDiagnostics[]
  conclusionInfo: { tried: boolean; chars: number; rounds: number; error: string }
}
