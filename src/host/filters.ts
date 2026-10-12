

/** 返回一个 JSON 响应。 */
/**
 * 把模型**内联在正文里**的思考块拆出来。
 *
 * 为什么要它：有的模型（实测 opencode-go 上的 minimax-m3 偶发）不走 reasoning 通道，
 * 而是把整段思考当正文吐出来，形如 `<think>The user wants…</think>`——
 * 不处理的话，用户看到的"答案"就是一大段思考（实测报过"输出错乱、把思考也输出了"）。
 *
 * 流式难点是标签可能被切成两块（"...<thi" + "nk>..."），所以没找到标签时**留一小截尾巴**再输出。
 */
const THINK_TAGS = 'think|thinking|reasoning|analysis|scratchpad'

const THINK_OPEN = new RegExp(`<(${THINK_TAGS})\\s*>`, 'i')

const THINK_CLOSE = new RegExp(`</(${THINK_TAGS})\\s*>`, 'i')

const THINK_TAIL = 24

export function createThinkFilter(): { push: (text: string) => { text: string; think: string }; flush: () => { text: string; think: string } } {
  let buffer = ''
  let inside = false
  const drain = (final: boolean): { text: string; think: string } => {
    let text = ''
    let think = ''
    for (;;) {
      if (inside) {
        const close = THINK_CLOSE.exec(buffer)
        if (!close) {
          if (final) {
            think += buffer
            buffer = ''
          } else if (buffer.length > THINK_TAIL) {
            think += buffer.slice(0, buffer.length - THINK_TAIL)
            buffer = buffer.slice(-THINK_TAIL)
          }
          break
        }
        think += buffer.slice(0, close.index)
        buffer = buffer.slice(close.index + close[0].length)
        inside = false
        continue
      }
      const open = THINK_OPEN.exec(buffer)
      if (!open) {
        if (final) {
          text += buffer
          buffer = ''
        } else if (buffer.length > THINK_TAIL) {
          text += buffer.slice(0, buffer.length - THINK_TAIL)
          buffer = buffer.slice(-THINK_TAIL)
        }
        break
      }
      text += buffer.slice(0, open.index)
      buffer = buffer.slice(open.index + open[0].length)
      inside = true
    }
    return { text, think }
  }
  return {
    push: (chunk: string) => {
      buffer += chunk
      return drain(false)
    },
    flush: () => drain(true),
  }
}

/**
 * 检测"思考被写进正文"的泄漏段。
 *
 * 实测 omen-alpha 在 `off` 档（上游 none）时不走 reasoning 通道，把整段英文推理当正文吐出来：
 * 「The user is asking which model I am. According to my instructions…我是 Omen Alpha。」
 * —— 这种文本**不带任何标签**，靠 `<think>` 过滤器抓不到，只能按"开头是自我盘算"来认。
 *
 * 保守三条件，缺一不裁（宁可留着，也不误删正文）：
 *   ① 逐句扫描，从开头起连续命中"元推理"句式；
 *   ② 命中段以英文为主（≥80% ASCII 字母）；
 *   ③ 剩下的正文里有中文（说明真正的答案是中文，被裁的不是答案）。
 */
const META_SENTENCE =
  /^\s*(?:The user|The question|The request|The person|According to (?:my|the)|Based on (?:my|the)|Per (?:my|the)|My (?:instructions|system prompt|guidelines)|I (?:should|must|need|will|am asked|always|usually|will just)|So I|Thus I|Therefore I|Instructed to|Now I (?:have|need|know|see)|Let me (?:verify|check|think|see|confirm)|I have (?:the|a|enough)|First,? I|OK,? (?:I|let)|用户(?:问|要求)的?是|根据(?:我的)?(?:指令|系统提示)|我应该|我需要|按照(?:我的)?(?:指令|系统提示))/i

/**
 * 宽松判据：开头是**英文盘算**、后面才是**中文答案**。
 * 只用来"记住这个模型在关档会泄漏"（下次自动抬档），**不用来裁剪** ——
 * 裁错了会误删正文，而记错了只是下次少一个档位可选，代价不对称。
 */
export function looksLikeLeakedReasoning(text: string): boolean {
  const body = String(text || '')
  if (body.length < 40) return false
  const cut = body.search(/[\u4e00-\u9fff]/)
  if (cut < 30) return false
  const head = body.slice(0, cut)
  const tail = body.slice(cut)
  if (!/[\u4e00-\u9fff]/.test(tail)) return false
  const letters = head.replace(/[^A-Za-z]/g, '').length
  return letters / head.length >= 0.5
}

export function splitLeakedReasoning(text: string): { prefix: string; rest: string } {
  const body = String(text || '')
  if (body.length < 40) return { prefix: '', rest: body }
  // 注意：不能用 split(/(?<=[.。!！?？])\s*/) —— 它会把句末空白吃掉，
  // 于是拼回来的 prefix 与真正流出去的正文差一个空格，客户端 indexOf 匹配不上（实测踩过）。
  // 这里保留分隔符本身，保证 parts.join('') === body。
  const parts = body.match(/[^.。!！?？]*[.。!！?？]\s*|[^.。!！?？]+$/g) ?? [body]
  // 从句首开始，连续吃"不含中文的句子"作为泄漏段。
  // 为什么不是"必须命中元推理句式"：实测泄漏段里会夹着 "Previously I said something incorrect … — that was wrong."
  // 这种自述句，逐句匹配元句式会在这里断掉、只裁掉前半段。结构判据（英文盘算 + 中文答案）更稳。
  // 但仍然要求：整段里**至少有一句**命中元推理句式，避免把"英文开头的正常回答"误裁。
  let index = 0
  let ascii = 0
  let metaHit = false
  while (index < parts.length && !/[\u4e00-\u9fff]/.test(parts[index])) {
    if (META_SENTENCE.test(parts[index])) metaHit = true
    ascii += (parts[index].match(/[A-Za-z]/g) || []).length
    index += 1
  }
  if (index === 0 || !metaHit) return { prefix: '', rest: body }
  const head = parts.slice(0, index).join('')
  const tail = parts.slice(index).join('')
  if (!tail.trim()) return { prefix: '', rest: body } // 整篇都是盘算：不裁（可能是模型只说了这些）
  const letters = head.replace(/[^A-Za-z]/g, '').length
  if (head.length > 0 && letters / head.length < 0.5) return { prefix: '', rest: body }
  if (!/[\u4e00-\u9fff]/.test(tail)) return { prefix: '', rest: body }
  return { prefix: head, rest: tail }
}
