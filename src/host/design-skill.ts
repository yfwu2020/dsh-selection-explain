import { fileURLToPath } from 'node:url'
import { stat, readFile } from 'node:fs/promises'

/**
 * 「网页模式」的设计规范：从插件自带的 `skills/web-design/SKILL.md` 读（按 mtime 缓存）。
 *
 * 做成文件而不是写死在代码里：改规范不用重新构建，用户也能自己替换成喜欢的版本。
 * 读不到就退回一段精简规则（宁可少讲，也不能让请求挂掉）。
 */
let designSkillCache: { at: number; path: string; text: string } = { at: 0, path: '', text: '' }

const DESIGN_SKILL_FALLBACK = [
  '单列、宽度 100%、不要横向滚动；不引外部资源；一套主题（别深浅混用）。',
  '主标题 20–22px、正文 14px、行高 1.6–1.75；一个主色 + 中性灰阶。',
  '只在内容真是序列时才编号；避免"什么内容都套同一张圆角卡片"这类模板感。',
].join('\n')

/** 模块级读文件失败时的告警（host 侧 logger 在 apply 里拿不到，走 console）。 */
function ctxLoggerWarn(message: string): void {
  try {
    console.warn(`[dsh-selection-explain] ${message}`)
  } catch {
    /* noop */
  }
}

export async function loadDesignSkill(): Promise<string> {
  const path = fileURLToPath(new URL('../../skills/web-design/SKILL.md', import.meta.url))
  try {
    const info = await stat(path)
    if (designSkillCache.path === path && designSkillCache.at === info.mtimeMs && designSkillCache.text) {
      return designSkillCache.text
    }
    const raw = await readFile(path, 'utf8')
    // 去掉 frontmatter，只把规则喂给模型
    const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim()
    designSkillCache = { at: info.mtimeMs, path, text: body }
    return body
  } catch (error) {
    ctxLoggerWarn(`读取设计规范失败（${path}）：${String((error as Error)?.message ?? error)}`)
    return DESIGN_SKILL_FALLBACK
  }
}
