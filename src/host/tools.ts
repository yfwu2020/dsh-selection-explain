import { lookup } from 'node:dns/promises'
import { resolve, sep } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

/** 联网类工具名：用来判断"首选里的联网工具在不在"。 */
const SEARCH_TOOL_NAMES = ['advanced_search', 'platform_search', 'web_search']

/**
 * 决定这一轮给模型哪些工具（纯函数，便于单测）。
 *
 * 规则：
 *   ① 首选清单里**确实存在**的直接放行；
 *   ② 如果首选里的**联网工具一个都不在**（例如没装 free-search 插件），
 *      就把备用清单里存在的补上 —— 否则小窗会变成完全不能联网；
 *   ③ 备用只补"联网"这一类，不会顺手把别的东西带进来。
 */
export function resolveToolNames(preferred: string[], fallback: string[], visible: string[]): string[] {
  const present = new Set(visible)
  const out = preferred.filter((name) => present.has(name))
  const hasSearch = preferred.some((name) => SEARCH_TOOL_NAMES.includes(name) && present.has(name))
  if (!hasSearch) {
    for (const name of fallback) {
      if (name && present.has(name) && !out.includes(name)) out.push(name)
    }
  }
  return out
}

/**
 * 粗略判断"是不是公网地址"，口径与 dsh-web-fetch-http 的 SSRF 防护一致（非 unicast 一律拒绝）。
 *
 * 为什么要这个：本机若跑着 TUN/fake-IP 代理（DNS 服务器是 198.18.0.2 这类），所有域名都会
 * 解析进 198.18.0.0/15 保留段 → web_fetch 每次都秒失败（"resolves to a non-public IP address"），
 * 而那个防护**没有配置开关**。与其让模型白跑一轮，不如探测出来直接不给它这个工具。
 */
function isPublicAddress(address: string): boolean {
  const value = String(address || '').trim()
  if (!value) return false
  if (value.indexOf(':') >= 0) {
    const lower = value.toLowerCase()
    if (lower === '::1' || lower === '::') return false
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return false
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return false
    return true
  }
  const parts = value.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const a = parts[0] as number
  const b = parts[1] as number
  const c = parts[2] as number
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 168 || b === 0)) return false
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18.0.0/15 基准测试段 ← fake-IP 落这里
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

/** 本机能否真正抓取网页（结果缓存 5 分钟，探测失败则不动它）。 */
let fetchProbe: { at: number; usable: boolean; sample: string } = { at: 0, usable: true, sample: '' }

export async function webFetchUsable(): Promise<{ usable: boolean; sample: string }> {
  if (Date.now() - fetchProbe.at < 300_000) return fetchProbe
  try {
    const addresses = await lookup('example.com', { all: true })
    const usable = addresses.length > 0 && addresses.every((entry) => isPublicAddress(entry.address))
    fetchProbe = { at: Date.now(), usable, sample: addresses.map((entry) => entry.address).join(', ') }
  } catch {
    fetchProbe = { at: Date.now(), usable: true, sample: '' }
  }
  return fetchProbe
}

/**
 * 路径是否落在允许的根目录里（root 为空 = 不设限）。
 *
 * 为什么需要它：read/grep/glob 能读**用户有权读的任何文件**（`~/.ssh/id_rsa`、`.env`、
 * `~/.dsh/settings.yaml`……），而划词的触发源（选中文字/上下文/搜索结果）可能是别人写的。
 * 这里只做词法判断（`resolve` 不跟随符号链接），挡住"顺着一段被注入的文字去读项目外的机密"。
 */
export function isInsideRoot(root: string, target: string): boolean {
  if (!root) return true
  const raw = String(target ?? '').trim()
  if (!raw) return true
  // `~` 一律拒：要么指向家目录（多数情况下在项目外），要么后端根本不展开
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return false
  const base = resolve(root)
  const full = resolve(base, raw)
  return full === base || full.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** 文件类工具：这些工具的参数里有 path，需要过边界检查。 */
export const FS_TOOL_NAMES = ['read', 'grep', 'glob']

/** 工具调用的人类可读描述（给前端状态栏用）。 */
export function describeToolCall(name: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>
  // command 也要认：bash 这类工具没有 query/url，不认的话摘要里只剩「bash」两个字
  const raw =
    record.query ??
    record.queries ??
    record.q ??
    record.url ??
    record.prompt ??
    record.command ??
    record.file_path ??
    record.path ??
    record.pattern
  const query = Array.isArray(raw) ? raw[0] : raw
  return typeof query === 'string' ? query.slice(0, 120) : name
}

/** 从工具结果里抽出：文本长度 / 预览 / 链接（前端只用它拼追问摘要，**不渲染**）。 */
export function digestToolResult(content: ContentBlock[]): { chars: number; preview: string; urls: string[] } {
  const text = content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
  const urls: string[] = []
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []
  for (const raw of matches) {
    const url = raw.replace(/[.,;:)\]}]+$/, '')
    if (!urls.includes(url)) urls.push(url)
    if (urls.length >= 5) break
  }
  return { chars: text.length, preview: text.slice(0, 600), urls }
}

/** 执行一个工具并把结果压成模型可读的内容块（带长度上限）。 */
export async function runTool(
  ctx: Context,
  name: string,
  args: unknown,
  signal: AbortSignal,
  maxChars: number,
  agent: unknown,
): Promise<{ content: ContentBlock[]; isError: boolean }> {
  const registry = ctx.get('tools') as
    | {
        execute?: (input: {
          callId: string
          name: string
          arguments: unknown
          signal: AbortSignal
          agent?: unknown
        }) => Promise<{ isError: boolean; content?: ContentBlock[] }>
      }
    | undefined
  if (typeof registry?.execute !== 'function') {
    return { content: [{ type: 'text', text: '（工具不可用）' }], isError: true }
  }
  try {
    const result = await registry.execute({
      callId: `sel-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      arguments: args,
      signal,
      ...(agent ? { agent } : {}),
    })
    const blocks = Array.isArray(result.content) ? result.content : []
    let used = 0
    const clamped: ContentBlock[] = []
    for (const block of blocks) {
      if (block.type !== 'text') continue
      const remain = maxChars - used
      if (remain <= 0) break
      const text = block.text.length > remain ? `${block.text.slice(0, remain)}
…（已截断）` : block.text
      used += text.length
      clamped.push({ type: 'text', text })
    }
    if (clamped.length === 0) clamped.push({ type: 'text', text: '（工具没有返回文本内容）' })
    return { content: clamped, isError: result.isError === true }
  } catch (error) {
    return { content: [{ type: 'text', text: `工具执行失败：${String((error as Error)?.message ?? error)}` }], isError: true }
  }
}

/**
 * 文件工具这道门：**项目内放行；本次用户亲手附带的文件也放行**。
 *
 * 为什么需要第二张名单：附件的只读副本存在 `~/.dsh/attachments/…`（附件仓），
 * 而 `readRoot` 默认是会话工作目录 —— 两者没有交集。可 dsh-llm 交给模型的
 * 文件句柄文本明确写着"用你的文件工具去读那个路径，需要内容时就读"，
 * 于是模型**必然**去读、**必然**被拒，工具轮就这么被烧光：
 * 实测连续两轮 `emitted=0 / finish=tool-calls`，最后只剩
 * 「工具查询完成了，但模型没有产出正文」那句兜底 —— 附文件等于白附。
 *
 * 为什么不是把 readRoot 调大：那等于给**整段对话**（以及项目外的任意路径）开口子。
 * 这里只放行"这次请求里真的拼进消息的那些文件"（路径由附件服务按内容哈希推出，
 * 名字还有 `ref.name === fileLeafName(ref.name)` 的校验），
 * 所以放开的范围严格等于用户的意图，边界其余部分一字不动。
 *
 * @param root - 会话工作目录（空 = 不限）
 * @param target - 模型请求的路径（原样，未解析）
 * @param attached - 本次附带的文件绝对路径集合（已 `resolve` 过）
 * @returns 是否放行
 */
export function isReadAllowed(root: string, target: string, attached?: ReadonlySet<string>): boolean {
  // 走到这里说明 root 非空、target 也非空（两者有任何一个为空，isInsideRoot 就直接放行了）
  if (isInsideRoot(root, target)) return true
  if (!attached || attached.size === 0) return false
  return attached.has(resolve(String(target).trim()))
}
