import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolve } from 'node:path'
import { estimateTextTokens } from '../chat-context.js'
import { MATERIAL_TOOL, restoreMaterial } from './chat-materials.js'
import { sse } from './http.js'
import { describeToolCall, digestToolResult, FS_TOOL_NAMES, isReadAllowed, runTool } from './tools.js'

import type { AnalyzeExecutionContext, AnalyzeStreamState } from './analyze-execution-types.js'

/** Execute one round of allowed calls and admit restored materials into subsequent messages. */
export async function executeAnalyzeTools(env: AnalyzeExecutionContext, state: AnalyzeStreamState, blocks: ContentBlock[], calls: ContentBlock[], round: number) {
  const { deps, request, tools, res, controller } = env
  const { ctx, config, historyStore } = deps
  const { body, route, history, capacity } = request
  const { agent, toolSchemas, readRoot } = tools
  state.toolMessages.push(
    createAssistantMessage({
      content: blocks,
      source: { provider: route.provider, model: route.model },
    }),
  )
  const restoredBlocks: ContentBlock[] = []
  state.toolContextTokens += estimateTextTokens(JSON.stringify(blocks))
  for (const call of calls) {
    if (call.type !== 'tool-call') continue
    state.toolCalls += 1
    let parsed: unknown = {}
    try {
      parsed = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      parsed = {}
    }
    const label2 = describeToolCall(call.name, parsed)
    const callId = String(call.id ?? `round${String(round)}-${String(state.toolCalls)}`)
    sse(res, { type: 'tool', phase: 'start', callId, name: call.name, detail: label2, round })
    const startedAt = Date.now()
    // 参数名有讲究：read/write/edit 用 file_path，grep/glob 用 path。
    // 只认 path 的话 read 的 file_path 会是 undefined → 边界检查被静默绕过（实测踩过）。
    const rawPath = (parsed as { file_path?: unknown; path?: unknown })?.file_path ?? (parsed as { path?: unknown })?.path
    const wantPath = typeof rawPath === 'string' ? rawPath : ''
    let restored: Awaited<ReturnType<typeof restoreMaterial>> | undefined
    if (call.name === MATERIAL_TOOL.name && toolSchemas.some(schema => schema.name === call.name)) {
      restored = await restoreMaterial(ctx, history.catalog, parsed, {
        through: history.contextState.through, key: typeof body.key === 'string' ? body.key : '',
        maxChars: config.toolResultMaxChars, readMessage: historyStore.readMessage
      })
      if (restored.restored && capacity && capacity.attachmentPrice(restored.restored) + history.contextEstimate + state.toolContextTokens > capacity.budget * 0.95) {
        restored = { content: [{ type: 'text', text: '这份材料超过本轮剩余容量，请减少本轮材料后重新查看。' }], isError: true }
      }
    }
    const execution = restored || (
      !toolSchemas.some((schema) => schema.name === call.name)
        ? { content: [{ type: 'text' as const, text: `（调用已拒绝：${call.name} 不在本次允许的工具中）` }], isError: true }
        : FS_TOOL_NAMES.includes(call.name) && !isReadAllowed(readRoot, wantPath, history.attachedPaths)
          ? {
            content: [
              {
                type: 'text' as const,
                text: `（越界已拒绝：文件类工具只能访问当前项目目录${readRoot ? `（${readRoot}）` : ''}，以及用户本次附带的文件；请求的路径是 ${wantPath || '(未给)'}）`,
              },
            ],
            isError: true,
          }
          : await runTool(ctx, call.name, parsed, controller.signal, config.toolResultMaxChars, agent))
    state.toolContextTokens += estimateTextTokens(JSON.stringify(execution.content))
    if (restored?.restored) {
      const item = restored.restored
      restoredBlocks.push(item.kind === 'image' ? { type: 'image', attachment: item.ref as never } : { type: 'file', attachment: item.ref as never })
      if (capacity) state.toolContextTokens += capacity.attachmentPrice(item)
      if (item.kind === 'file') {
        const store = ctx.get('attachments') as { fileHostPath?: (ref: unknown) => string | undefined } | undefined
        const path = store?.fileHostPath?.(item.ref)
        if (path) history.attachedPaths.add(resolve(path))
      }
      sse(res, { type: 'material-restored', attachment: item })
    }
    // 结果也回传：小窗里能看见"查了什么、命中什么、链接是什么"，否则工具是个黑盒
    const digest = digestToolResult(execution.content)
    sse(res, {
      type: 'tool',
      phase: 'done',
      callId,
      name: call.name,
      detail: label2,
      round,
      ok: !execution.isError,
      ms: Date.now() - startedAt,
      chars: digest.chars,
      preview: digest.preview,
      urls: digest.urls,
    })
    state.toolMessages.push(createToolResultMessage({ callId: call.id, content: execution.content, isError: execution.isError }))
    // 结论轮要用：把"查了什么 + 拿到了什么"写成纯文本，避免重放工具调用链
    state.toolDigestLines.push(`· ${call.name}（${label2 || '查询'}）：${digest.preview}`)
  }
  state.recoveredMaterialBlocks.push(...restoredBlocks)
  if (restoredBlocks.length > 0) state.toolMessages.push(createUserMessage({ source: { kind: 'user' }, content: restoredBlocks }))

}
