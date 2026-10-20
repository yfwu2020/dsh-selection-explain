import { MAX_QUOTES, QUOTE_CONTEXT_TIMEOUT, QUOTE_CONTEXT_API, QUOTE_ONLY_QUESTION } from './constants.js'
import { el, listen } from './dom.js'
import { normalizeSpace, collectContext } from './context.js'

/** quotes state and operations; dependencies are supplied as live node/callback accessors. */
export function createQuotesController(env) {

  // ────────────────────── 引用（❝）：把别处的文字挂进输入框 ──────────────────────
  //
  // 两个入口，同一份数据（state.quotes）：
  //   ① 划词浮标「❝ 引用」—— 小窗开着时，小窗正文里的选区 或 主界面上的选区；
  //   ② 助手气泡末尾的「❝ 引用整条」（鼠标移上去才出现）—— 整条回答，网页回答先折成 Markdown。
  // 引用只属于**下一条**提问：发送时拼进这条消息，发完清空。

  /** 引用卡片的 id 计数（内容可能重复，DOM 与删除都靠 id 认人）。 */
  var quoteSeq = 0

  /** 卡片/气泡上的来源小字。 */
  function quoteLabelOf(quote) {
    return quote && quote.label ? String(quote.label) : '引用'
  }

  /** 卡片/气泡里的单行摘要（完整文本进 title 与发给模型的那份）。 */
  function quoteBrief(text, max) {
    var one = String(text || '').replace(/\s+/g, ' ').trim()
    return one.length > max ? one.slice(0, max) + '…' : one
  }

  /**
   * 加一段引用。加不进去也给一句状态 —— 点了浮标"什么都没发生"是最难查的那种观感。
   * 同一段划两次不再加（引用区是材料清单，不是记事本）；超过 MAX_QUOTES 段也不再加。
   *
   * `extra` = { context, session }：引用**当时所在**的上下文（见 quoteContextFor），
   * session=true 表示"这段文字来自主界面会话"，加入引用时立即向host取得一次按轮取整的干净上下文快照。
   */
  function addQuote(text, label, extra) {
    var clean = String(text || '').replace(/\u00a0/g, ' ').trim()
    if (!clean) return false
    for (var i = 0; i < env.state.quotes.length; i += 1) {
      if (env.state.quotes[i].text === clean) {
        env.setStatus('这段已经在引用里了')
        return false
      }
    }
    if (env.state.quotes.length >= MAX_QUOTES) {
      env.setStatus('引用最多 ' + MAX_QUOTES + ' 段，先删掉一条再加')
      return false
    }
    quoteSeq += 1
    var context = extra && typeof extra.context === 'string' ? extra.context.trim() : ''
    var quote = {
      id: quoteSeq,
      label: label || '引用',
      text: clean,
      context: context,
      session: !!(extra && extra.session === true),
      sessionId: extra && extra.sessionId || env.currentSessionId(),
      contextJob: null,
    }
    env.state.quotes.push(quote)
    if (quote.session && quote.sessionId) {
      quote.contextJob = fetchQuoteContext(quote.sessionId, quote.text).then(function (context) {
        if (context) quote.context = context
      })
    }
    renderQuotes()
    env.refreshAskState()
    // 输入框按阶段本来可能是藏着的（首轮还在跑）：引用一进来就得看得见，顺手聚焦。
    // 聚焦走**同一个** focusAskBox（preventScroll）：这里是用户主动点引用，
    // 与"开窗自动聚焦"是两回事，不需要走 askFocusPending 那套"别抢人家打字"的判定。
    env.askRow.style.display = ''
    if (env.composerVisible()) env.focusAskBox()
    env.setStatus(
      '已加入引用（' +
        quoteLabelOf(env.state.quotes[env.state.quotes.length - 1]) +
        ' · ' +
        clean.length +
        ' 字' +
        (context ? ' · 带上下文 ' + context.length + ' 字' : '') +
        '）',
    )
    return true
  }

  function removeQuote(id) {
    var next = []
    for (var i = 0; i < env.state.quotes.length; i += 1) {
      if (env.state.quotes[i].id !== id) next.push(env.state.quotes[i])
    }
    env.state.quotes = next
    renderQuotes()
    env.refreshAskState()
  }

  /** 清空待发送的引用（换了一段选中文字 / 回放了另一条历史 —— 那些引用已经不属于这段对话）。 */
  function clearQuotes() {
    if (env.state.quotes.length === 0) return
    env.state.quotes = []
    renderQuotes()
    env.refreshAskState()
  }

  /** 重画引用区（空的时候整块收起来，不占版面）。 */
  function renderQuotes() {
    env.quotesBox.textContent = ''
    env.quotesBox.setAttribute('data-show', env.state.quotes.length > 0 ? '1' : '0')
    for (var i = 0; i < env.state.quotes.length; i += 1) {
      var quote = env.state.quotes[i]
      var chip = el('div', 'dsh-sel-quotechip')
      chip.setAttribute('data-quote', String(quote.id))
      chip.appendChild(el('span', 'dsh-sel-quotechip-src', '❝ ' + quoteLabelOf(quote)))
      var brief = el('span', 'dsh-sel-quotechip-text', quoteBrief(quote.text, 42))
      brief.title = quote.text
      chip.appendChild(brief)
      var remove = el('button', 'dsh-sel-quotechip-x', '✕')
      remove.type = 'button'
      remove.title = '移除这条引用'
      remove.setAttribute('aria-label', '移除这条引用')
      wireQuoteRemove(remove, quote.id)
      chip.appendChild(remove)
      env.quotesBox.appendChild(chip)
    }
  }

  /** 卡片上的 ✕（卡片每次重画，监听跟着节点一起走，不需要单独回收）。 */
  function wireQuoteRemove(node, id) {
    listen(node, 'click', function (event) {
      event.stopPropagation()
      removeQuote(id)
    })
  }

  // ── 引用的上下文：只有"模型看不到的东西"才需要带 ──
  //
  //   · 小窗自己的正文（回答 / 两节 / 顶部原文条）：**不带上下文** —— 小窗这几轮对话
  //     本来就会随 history 进模型，再贴一遍是重复；出处交给标签说清
  //     （「小窗第 2 轮回答」「小窗「翻译」节」）。
  //   · 主界面（会话）：带上"引用所在那一组对话 ± 一组"（host 从会话记录里取干净文本）。
  //   · 侧边栏网页：带上帧内桥采的局部窗口。
  // 后两条都是模型看不到的材料，所以必须带。

  /** 上下文里有没有引用原文（归一化后包含即可：【】是套在外面的，不影响包含关系）。 */
  function contextHasQuote(context, text) {
    var haystack = normalizeSpace(context)
    var needle = normalizeSpace(text)
    return needle.length > 0 && haystack.indexOf(needle) >= 0
  }

  /** 选区落在小窗的哪一轮上（往上找带 __turn 的气泡）；不在气泡里返回 -1。 */
  function turnIndexOfNode(node) {
    var current = node && node.nodeType === 3 ? node.parentNode : node
    for (var depth = 0; current && depth < 32; depth += 1) {
      if (current.__turn) {
        var index = env.state.turns.indexOf(current.__turn)
        if (index >= 0) return index
      }
      if (current === env.body || !env.panel.contains(current)) break
      current = current.parentNode
    }
    return -1
  }

  /**
   * 点「❝ 引用」那一刻才采上下文（划选过程中每次 selectionchange 都采太贵）。
   * 会话里的引用（主界面）先用**局部窗口**兜底，加入引用时向host取一次按轮取整的干净上下文快照。
   */
  function quoteContextFor(selection) {
    if (!selection) return { context: '', session: false }
    if (selection.source === 'panel') {
      var index = selection.turnIndex
      var through = env.state.contextState && env.state.contextState.through || 0
      var visibleBefore = env.state.turns.slice(0, index).filter(function (t) { return !t.hidden }).length
      if (index >= 0 && visibleBefore < through) {
        var pieces = env.state.turns.slice(Math.max(0, index - 1), index + 2).filter(function (t) { return !t.hidden }).map(function (t) {
          var text = t.role === 'assistant' ? env.foldForHistory(t.text || '') : sentTextOf(t)
          var at = text.indexOf(selection.text)
          var start = at >= 0 ? Math.max(0, at - 500) : 0
          return (t.role === 'user' ? '用户：' : '助手：') + text.slice(start, start + Math.max(1500, selection.text.length + 500))
        })
        return { context: pieces.join('\n'), session: false }
      }
      return { context: '', session: false }
    }
    if (selection.source === 'iframe') {
      // 侧边栏网页：帧内的桥已经把上下文采好了（±1500 字窗口，选中部分用【】标出）
      return { context: String(selection.context || ''), session: false }
    }
    var context = String(selection.context || '')
    if (!context && selection.range) {
      try {
        context = collectContext(env.rangeSelection(selection.range)).context || ''
      } catch (error) {
        context = ''
      }
    }
    return { context: context, session: true }
  }

  /**
   * 会话里的引用：向 host 要"引用所在那一组对话 ± 一组"（干净文本只有 host 那边有：
   * 工具调用/结果、系统提示、harness 注入在 `transcriptOf` 那套规则里已经滤掉了）。
   * 拿不到（引用不在会话里 / host 不认 / 超时）就保留客户端自己采的那份，不阻塞发送。
   */
  function resolveQuoteContexts(quotes) {
    var jobs = []
    for (var i = 0; i < quotes.length; i += 1) {
      if (quotes[i].session === true) jobs.push(quotes[i])
    }
    if (jobs.length === 0) return Promise.resolve(quotes)
    return Promise.all(jobs.map(function (quote) {
      return quote.contextJob || Promise.resolve()
    })).then(function () { return quotes })
  }

  /** 取一次会话版引用上下文（带超时；失败一律返回空串走兜底）。 */
  function fetchQuoteContext(sessionId, text) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null
    var timer = env.timerScope.later(function () {
      if (controller) {
        try {
          controller.abort()
        } catch (error) {
          /* noop */
        }
      }
    }, QUOTE_CONTEXT_TIMEOUT)
    return fetch(QUOTE_CONTEXT_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, text: text }),
      ...(controller ? { signal: controller.signal } : {}),
    })
      .then(function (response) {
        return response.ok ? response.json() : null
      })
      .then(function (data) {
        env.timerScope.clear(timer)
        if (data && data.ok === true && data.matched === true && typeof data.context === 'string') return data.context
        return ''
      })
      .catch(function () {
        env.timerScope.clear(timer)
        return ''
      })
  }

  /**
   * 引用 + 提问 → **真正发给模型**的那条消息。
   *
   * 拼在客户端而不是 host：引用本来就是"用户这条消息的一部分"，拼好之后
   * 追问上下文、历史回放、升格全都天然带着它，host 只负责**给上下文**（那条路由）。
   * 没有引用时**原样返回提问** —— 老路径一个字都不变。
   *
   * 每段引用固定给：来源 + 【引用处上下文】（被引用的部分用【】标出）。
   * 上下文里没带上原文时（被截断、或标记失败）再补一段【引用原文】——
   * 绝不让模型去猜"引的是哪句"。
   */
  function composeQuestion(quotes, question) {
    var ask = String(question || '').trim()
    var list = quotes || []
    if (list.length === 0) return ask
    var lines = []
    for (var i = 0; i < list.length; i += 1) {
      var quote = list[i]
      var context = String(quote.context || '').trim()
      lines.push('【引用 ' + (i + 1) + '】（来自' + quoteLabelOf(quote) + '）')
      if (context) {
        lines.push('【引用处上下文】（被引用的部分用【】标出）')
        lines.push(context)
        if (!contextHasQuote(context, quote.text)) {
          lines.push('')
          lines.push('【引用原文】')
          lines.push(quote.text)
        }
      } else {
        lines.push(quote.text)
      }
      lines.push('')
    }
    lines.push('【我的问题】')
    lines.push(ask || QUOTE_ONLY_QUESTION)
    return lines.join('\n')
  }

  /** 某一轮"实际发出去"的文本：用户那轮带引用块，助手轮就是正文。 */
  function sentTextOf(turn) {
    if (!turn) return ''
    if (turn.role === 'user') return turn.sent || turn.text || ''
    return turn.text || ''
  }

  /** 导出给 host 的轮次（历史落盘 / 升格）：用户那轮把引用块一起带走。 */
  function exportTurns() {
    var out = []
    for (var i = 0; i < env.state.turns.length; i += 1) {
      var turn = env.state.turns[i]
      // 附件引用随轮次一起落盘（只有 user 轮会有）。存的是引用不是字节，
      // 所以历史文件不会因为一张截图胖几 MB —— 见 host 的 history-attachments.ts。
      out.push({
        role: turn.role,
        text: sentTextOf(turn),
        ...(turn.contextExcluded === true ? { contextExcluded: true } : {}),
        ...(turn.attachments && turn.attachments.length > 0 ? { attachments: turn.attachments } : {}),
      })
    }
    return out
  }
  return {
    renderQuotes,
    addQuote,
    quoteContextFor,
    composeQuestion,
    clearQuotes,
    turnIndexOfNode,
    sentTextOf,
    exportTurns,
    quoteLabelOf,
    quoteBrief,
    resolveQuoteContexts,
  }
}
