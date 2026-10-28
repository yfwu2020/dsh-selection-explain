import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { EFFORT_LABEL, looksLikeReasoningRequired, looksLikeUnsupportedTier } from './effort.js'
import { looksLikeLeakedReasoning, splitLeakedReasoning } from './filters.js'
import { looksLikeAttachmentFailure } from './history-attachments.js'
import { sse } from './http.js'

import { concludeAnalyze } from './analyze-conclusion.js'
import type { AnalyzeExecutionContext, AnalyzeStreamState } from './analyze-execution-types.js'
import { finishAnalyzeOutput } from './analyze-output.js'
import { streamAnalyzeRound } from './analyze-round.js'
import { executeAnalyzeTools } from './analyze-tool-execution.js'

/** Coordinate rounds and retries. History attachment recovery always precedes effort retries. */
export async function executeAnalyze(env: AnalyzeExecutionContext): Promise<string | null> {
  const { deps, request, tools, prompt, messages, res } = env
  const { ctx, config, models } = deps
  const { isChat, titleOnly, history } = request
  const { toolSchemas } = tools
  const { sentEffort, offSlotEffort, routeKey, isShot } = prompt
  const { memoryMessages, questionContent } = messages
  const { clientClosedEarly } = env
  const state: AnalyzeStreamState = {
    chars: 0, errored: false, usage: null, answer: '', toolMessages: [], recoveredMaterialBlocks: [],
    toolContextTokens: 0, toolCalls: 0, errorMessage: '', toolDigestLines: [], roundDiag: [],
    conclusionInfo: { tried: false, chars: 0, rounds: 0, error: '' },
  }
  const toolRounds = config.maxToolRounds
  // 档位被上游拒绝时（400/401/500）重试一次：清单里声明的档位是**建议值**，
  // 实测很多模型并不接受 max（qwen3.7-max 直接 400、minimax-m2.7/gpt-5.6-luna 500）。
  //
  // 以前这里限定了 `isChat && bodyEffort.length > 0` —— 只有追问、且客户端显式传了档位才重试。
  // 于是**首轮**（档位来自配置、默认 off）撞上不吃 off 的模型时无人兜底，整个划词解读全挂。
  // 现在按"这一轮实际在发显式档位"判，三种轮次一视同仁。
  //
  // 2026-10-09 改：重试**不再"去掉档位"**，而是换一个没试过的档（见 nextEffortFor）。
  // 老代码对非 off 档的重试是 `roundEffort = ''`（省略 reasoning），
  // 而省略对"必须开推理"的端点就是关掉推理 —— 实测 20 次重试 0 次成功。
  // 同时给两次机会：上游偶发失败约一半，两次能把成功率抬到 ~90%（代价是多一次往返）。
  const EFFORT_RETRY_LIMIT = 2
  // 重试与"泄漏检查"都看**真正发出去**的那个档位（sentEffort，映射之后的值）：
  // 规范档位是"关"、但这个模型的关档叫 none/minimal 时，检查的必须是发出去的那个。
  let effortRetries = sentEffort.length > 0 ? EFFORT_RETRY_LIMIT : 0
  const triedEfforts = new Set<string>(sentEffort ? [sentEffort] : [])
  const firstSentEffort = sentEffort
  let roundEffort = sentEffort
  const effectiveToolRounds = titleOnly ? 0 : toolRounds
  for (let round = 0; round <= effectiveToolRounds; round += 1) {
    const wrapUp = round === effectiveToolRounds
    const { assembler, roundText } = await streamAnalyzeRound(env, state, round, wrapUp, roundEffort)
    if (state.errored) {
      // 附件读不回来（对象仓里的字节被清理/损坏）：把**历史**里的附件全降级成文字再试一次。
      // 这是持久化带来的新故障面 —— 引用的寿命超过了那一轮，字节却不一定还在。
      //
      // ⚠️ 必须排在**换档重试前面**：换档是冲着"上游不认这个推理档"去的，
      // 对"附件读不到"毫无意义 —— 排后面的话会先白烧两次模型调用（实测事件序列就是
      // upstream-retry → upstream-retry → attachments-dropped），还会把档位无谓地换掉。
      if (roundText.length === 0 && history.historyHadAttachments && !history.historyDropped && looksLikeAttachmentFailure(state.errorMessage, state.errorCode)) {
        history.historyDropped = true
        history.historyImages = { kept: 0, omitted: 0, files: 0 }
        messages.openingMessages = [
          ...memoryMessages,
          ...history.buildHistoryMessages(),
          ...(isShot ? [] : [createUserMessage({ source: { kind: 'user' }, content: questionContent })]),
        ]
        // 历史附件被丢掉了 → 名单跟着缩小（只放"还看得见的"那些）
        history.attachedPaths = history.collectAttachedPaths(ctx)
        state.errored = false
        sse(res, {
          type: 'notice',
          code: 'attachments-dropped',
          text: '历史里的附件已经读不回来了（可能被清理过），这一轮先不带上它，其余照常',
        })
        round -= 1
        continue
      }
      // 一个字都没吐出来 → 可以安全重试**同一轮**（保守：已经吐出正文的失败不重试，
      // 免得把半截答案丢掉）。重试换一个没试过的档位，而不是把档位去掉。
      if (roundText.length === 0 && effortRetries > 0) {
        const rejected = roundEffort
        const next = models.nextEffortFor(routeKey, rejected, triedEfforts)
        if (next) {
          effortRetries -= 1
          triedEfforts.add(next)
          // 只有"我们发的这个档位确实不被接受"才值得记成事实：
          //   · 发的是关档 + 上游说"必须开推理" → 这个 route 不吃关档，记下来；
          //   · 发的是开着的档（low/high/max）+ 上游还在说"推理不能关" → **这句不是冲我们来的**
          //     （我们没关它），是上游偶发抽风（实测同档位 5/8 成功）。这种情况不记、不诊断，
          //     只如实说"上游返回了错误，已换档重试"。
          // "必须开推理"这句只有在我们发的是**「关」那一格对应的真实档位**时才算数
          // （模型没有 off、关档落在 minimal/low 上时，字符串比较会漏判）
          const rejectedOffSlot = rejected === offSlotEffort
          const tierIssue = rejectedOffSlot
            ? looksLikeReasoningRequired(state.errorMessage)
            : looksLikeUnsupportedTier(state.errorMessage)
          if (rejectedOffSlot && tierIssue) models.markNoOff(routeKey)
          roundEffort = next
          state.errored = false
          sse(res, {
            type: 'notice',
            code: tierIssue ? 'effort-rejected' : 'upstream-retry',
            ...(tierIssue ? { tier: rejected } : {}),
            text: tierIssue
              ? rejectedOffSlot
                ? `该模型不接受「关」档，已自动改用「${EFFORT_LABEL[next] ?? next}」档（以后不再尝试关档）`
                : `「${EFFORT_LABEL[rejected] ?? rejected}」档该模型不支持，已改用「${EFFORT_LABEL[next] ?? next}」档重试`
              : '上游这次返回了错误，已自动重试',
          })
          round -= 1
          continue
        }
      }
      sse(res, { type: 'error', message: state.errorMessage, code: state.errorCode })
      break
    }
    const blocks: ContentBlock[] = assembler.blocks()
    const calls = blocks.filter((block) => block.type === 'tool-call')
    if (calls.length === 0) {
      // 最终答案到手：如果发出去的是「关」那一格对应的真实档位，检查有没有把思考写进正文
      if (isChat && firstSentEffort === offSlotEffort) {
        const split = splitLeakedReasoning(state.answer)
        if (split.prefix) {
          models.markLeaky(routeKey)
          state.answer = split.rest
          state.chars = state.answer.length
          sse(res, { type: 'strip', text: split.prefix })
          sse(res, {
            type: 'notice',
            code: 'reasoning-leak',
            // 报**真实档位**（模型可能没有 off，叫 none/minimal）：客户端据此标对那个档位按钮
            tier: firstSentEffort,
            text: '该模型在「关」档会把思考写进正文，已撤回泄漏段；以后这一档会自动改用「低」',
          })
        } else if (looksLikeLeakedReasoning(state.answer)) {
          // 句式没认准（模型每次换说法）→ 这次不裁（怕误删正文），但记住它，下次自动抬档
          models.markLeaky(routeKey)
          sse(res, {
            type: 'notice',
            code: 'reasoning-leak',
            tier: firstSentEffort,
            text: '这个模型在「关」档会把思考写进正文；这一档以后自动改用「低」',
          })
        }
      }
      break
    }
    // 既然这一轮要调工具，它刚才流出来的正文就是"过程旁白"，不是答案：
    // 让前端把这部分撤回去（顺带当成思考尾巴显示），免得"我怎么想的"混进小窗正文。
    // 实测踩过：追问"搜索今天的新闻"时，模型在工具轮里先吐了一段英文盘算
    // （I have sources with dates… Maybe I should do one more search…），
    // 然后才给中文结论，这段英文被当正文渲染进了消息框。
    if (roundText.length > 0) {
      state.answer = state.answer.slice(0, Math.max(0, state.answer.length - roundText.length))
      sse(res, { type: 'drop', chars: roundText.length, text: roundText.slice(-2000), round })
    }
    // 有的模型不带工具定义也会返回调用；执行端同样遵守开关和轮数上限。
    if (wrapUp || toolSchemas.length === 0) break
    // 执行工具→把结果回灌，再让模型继续（上限 maxToolRounds 轮）
    await executeAnalyzeTools(env, state, blocks, calls, round)
  }
  if (!state.errored && state.answer.trim().length === 0 && state.toolCalls > 0 && triedEfforts.size === 1) {
    await concludeAnalyze(env, state, roundEffort)
  }
  finishAnalyzeOutput(res, state, clientClosedEarly)

  return state.errored ? null : state.answer
}
