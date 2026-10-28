import { API_PREFIX, name } from './constants.js'
import { handleMic, stopMicProbe } from './mic.js'

import { resolveConfig } from './config.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { createSpeech } from './speech.js'
import { createSettingsStore } from './settings-store.js'
import { createModels } from './models.js'
import { createAnalyze } from './analyze.js'
import { createSessions } from './sessions.js'
import { createHistoryStore } from './history-store.js'
import { createRoutes } from './routes.js'
import { createPromote } from './promote.js'
import { createAttach } from './attach.js'
import { createShotService } from './shot.js'

export function apply(ctx: Context, rawConfig: Config): void {
  const config = resolveConfig(rawConfig)
  const speech = createSpeech(ctx, config)
  const settingsStore = createSettingsStore(ctx, config)
  const models = createModels(ctx, config)
  const sessions = createSessions(ctx, config)
  const historyStore = createHistoryStore(ctx, config, models, settingsStore)
  const routes = createRoutes(ctx, config, historyStore, sessions, models, settingsStore)
  const promote = createPromote(ctx, config, sessions, historyStore)
  const analyze = createAnalyze(ctx, config, models, sessions, historyStore)
  const attach = createAttach(ctx)
  const shot = createShotService(config)

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/attach`, handler: attach.handleAttach }),
    `${name}: attach route`,
  )

  // 把存好的附件读回来给界面显示（气泡里的缩略图 / 文件卡；历史回放也要用）
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/attachment`, handler: attach.handleAttachment }),
    `${name}: attachment playback route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/analyze`, handler: analyze.handleAnalyze }),
    `${name}: analyze route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/settings`, handler: settingsStore.handleSettings }),
    `${name}: settings route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/route`, handler: routes.handleRoute }),
    `${name}: route route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/ping`, handler: routes.handlePing }),
    `${name}: ping route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/history`, handler: historyStore.handleHistory }),
    `${name}: history route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/panel`, handler: historyStore.handlePanelSize }),
    `${name}: panel box route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/pill`, handler: historyStore.handlePillPos }),
    `${name}: pill position route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/mic`, handler: handleMic }),
    `${name}: mic presence route`,
  )

  // 探针是懒启动的（第一次有人问才起），但**卸载时要收干净**：
  // 否则插件热重载几次就会留下一串没人管的 mic-probe 进程。
  ctx.effect(
    () => () => stopMicProbe(),
    `${name}: mic probe process`,
  )

  // ── 截图提问（DSH 快捷键触发）──
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}/shot/start`,
        handler: shot.handleShotStart,
      }),
    `${name}: shot start route`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}/shot/pending`,
        handler: shot.handleShotPending,
      }),
    `${name}: shot pending route`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}/shot/image`,
        handler: shot.handleShotImage,
      }),
    `${name}: shot image route`,
  )

  // 卸载时取消截图命令、释放长轮询并删除本实例的临时图
  ctx.effect(() => () => shot.stop(), `${name}: shot temp cleanup`)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}/shot/hello`,
        handler: shot.handleShotHello,
      }),
    `${name}: shot hello route`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}/shot/status`,
        handler: shot.handleShotStatus,
      }),
    `${name}: shot status route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/models`, handler: routes.handleModels }),
    `${name}: models route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/promote`, handler: promote.handlePromote }),
    `${name}: promote route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/quote-context`, handler: routes.handleQuoteContext }),
    `${name}: quote-context route`,
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/speech`, handler: speech.handleSpeech }),
    `${name}: speech catalog route`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/speech/transcribe`, handler: speech.handleSpeechTranscribe }),
    `${name}: speech transcribe route`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/speech/prepare`, handler: speech.handleSpeechPrepare }),
    `${name}: speech prepare route`,
  )

  ctx.logger?.info?.(`[${name}] 划词解读路由就绪：${API_PREFIX}/analyze`)
}
