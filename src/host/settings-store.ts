import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SETTINGS_KEYS, PERSISTED_SETTING_KEYS, normalizeStoredSettings, normalizeSettingsPatch, buildSettingsPayload } from '../settings.js'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { name } from './constants.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson } from './http.js'

/** Owns settings-store state for one plugin instance. */
export function createSettingsStore(ctx: Context, config: Config) {

  /**
   * 出厂默认值（**不含**用户在设置页改过的部分）。
   *
   * 为什么单独留一份：设置页的「恢复默认」要能把值写回这里，
   * 而"这一项改过没有"也要拿它对比 —— 只有一个 config 的话，改完就再也说不出原值是什么。
   * 注意它取的是 rawConfig（cordis.patch.yml 里的配置），所以 yml 里写过的值也算"默认"：
   * 用户在设置页恢复默认，应该回到 yml 写的那个数，而不是硬编码的出厂数。
   */
  const configDefaults: Record<string, unknown> = { ...config } as unknown as Record<string, unknown>

  /**
   * 设置页写入的覆盖值（**只存改过的键**）。
   *
   * 落盘在插件自己的目录（与 history.json / pill.json 同级），不碰 cordis.patch.yml：
   * 那个文件是**装配清单**，让 UI 去改它既容易写坏结构，也要重启才生效。
   * 这里的内存值即刻生效（下方所有 config.x 都是每次请求现读的），落盘只为跨重启保留。
   */
  let settingsOverrides: Record<string, unknown> = {}

  let settingsLoad: Promise<void> | null = null

  let settingsTimer: ReturnType<typeof setTimeout> | null = null

  const settingsFile = (): string =>
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'selection-explain', 'settings.json')

  /**
   * 把覆盖值套用到 config 上。
   *
   * 只接受 SETTINGS_KEYS 里的键，并且**类型必须与默认值一致** ——
   * 文件是手工可编辑的（也可能被旧版本写坏），不能让它把 boolean 写成字符串，
   * 那会让 `if (config.tools)` 这种判断悄悄变成永真。
   */
  function applyOverrides(patch: Record<string, unknown>): void {
    const target = config as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(patch)) {
      if (!SETTINGS_KEYS.includes(key) && !PERSISTED_SETTING_KEYS.includes(key)) continue
      if (typeof value !== typeof configDefaults[key]) continue
      target[key] = value
    }
  }

  /** 进程内只读一次；并发请求共同等待覆盖值生效。 */
  function loadSettings(): Promise<void> {
    return settingsLoad ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(settingsFile(), 'utf8')) as { values?: unknown }
        const raw = parsed?.values
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const values = normalizeStoredSettings(raw)
          settingsOverrides = values
          applyOverrides(values)
        }
      } catch {
        // 没存过 / 坏了都当作"没改过"：出厂默认本来就是可用状态，没必要因此报错
        settingsOverrides = {}
      }
    })()
  }

  /** 落盘（防抖：拖数字输入框会连发多次，没必要每次都写文件）。 */
  function scheduleSettingsWrite(): void {
    if (settingsTimer) clearTimeout(settingsTimer)
    settingsTimer = setTimeout(() => {
      settingsTimer = null
      void (async () => {
        try {
          await mkdir(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'selection-explain'), { recursive: true })
          await writeFile(settingsFile(), JSON.stringify({ version: 1, values: settingsOverrides }, null, 0), 'utf8')
        } catch (error) {
          ctx.logger?.warn?.(`[${name}] 写入设置失败：${String((error as Error)?.message ?? error)}`)
        }
      })()
    }, 300)
    settingsTimer.unref?.()
  }

  /** 当前生效值（按 spec 的键序取，客户端可以直接对比 defaults 判断改过没有）。 */
  function currentSettings(): Record<string, unknown> {
    const target = config as unknown as Record<string, unknown>
    const values: Record<string, unknown> = {}
    for (const key of SETTINGS_KEYS) values[key] = target[key]
    return values
  }

  /**
   * 设置页的读写口。
   *
   *   GET  → { groups, values, defaults }：spec 一并下发，客户端只负责画
   *   POST → { values: {...} }：归一 → 立刻生效（改内存）→ 防抖落盘
   *   POST { reset: true }    ：清空覆盖，回到 cordis.patch.yml / 出厂默认
   *
   * 为什么不是"写回 cordis.patch.yml"：那是装配清单，
   * 让 UI 去改它既要人肉重启、又可能把 YAML 结构写坏；这里落在插件自己的目录，改完即时生效。
   */
  const handleSettings = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      await loadSettings()
      if (req.method === 'POST') {
        const raw = await readBody(req, 200_000)
        let body: { values?: unknown; reset?: unknown } = {}
        try {
          body = raw ? (JSON.parse(raw) as { values?: unknown; reset?: unknown }) : {}
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        if (body.reset === true) {
          settingsOverrides = {}
          applyOverrides(configDefaults)
          scheduleSettingsWrite()
          sendJson(res, 200, { ok: true, values: currentSettings(), rejected: [] })
          return
        }
        const result = normalizeSettingsPatch(body.values)
        if (Object.keys(result.values).length === 0 && result.rejected.length > 0) {
          sendJson(res, 400, { ok: false, error: '没有可写入的字段', rejected: result.rejected })
          return
        }
        // 合并而不是覆盖：只发一个键的补丁不该把其它改过的项抹掉
        settingsOverrides = { ...settingsOverrides, ...result.values }
        applyOverrides(result.values)
        scheduleSettingsWrite()
        sendJson(res, 200, { ok: true, values: currentSettings(), rejected: result.rejected })
        return
      }
      sendJson(res, 200, { ok: true, ...buildSettingsPayload(currentSettings(), configDefaults) })
    })().catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    })
  }
  return { loadSettings, handleSettings }
}
