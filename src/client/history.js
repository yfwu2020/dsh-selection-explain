import { readContextState } from '../chat-context.js'
import { isDarkSurface, splitSections } from './render.js'
import { HISTORY } from './constants.js'
import { el, listen } from './dom.js'
import { createHistoryTextController } from './history-text.js'
import { createShotTitleController } from './history-shot-title.js'
import { createHistoryScrollController } from './history-scroll.js'
import { createHistoryBubbleController } from './history-bubbles.js'
import { createHistoryTranscriptController } from './history-transcript.js'

/** History persistence and navigation; dependencies remain live accessors. */
/** @param {import('./controller-contracts.js').HistoryEnv} env */
export function createHistoryController(env) {
  var text = createHistoryTextController()
  var { foldForHistory } = text
  var scroll = createHistoryScrollController(env)
  var { noteUserScroll, noteBodyScroll, ensurePanelInsideViewport,
    ensureChatFollow, ensurePanelInsideViewportNow } = scroll
  var bubbles = createHistoryBubbleController(env, foldForHistory)
  var { clearRenderedTurns, renderTurns } = createHistoryTranscriptController(env, bubbles, scroll)
  var shotTitles = createShotTitleController(env, openHistoryList)

  /**
   * 当前面板底色是深还是浅（'dark' | 'light'）。
   *
   * 用途：网页输出时告诉 host 该按哪套配色生成页面 —— 深色 Harness 里给一张白底页面很刺眼。
   * 判据优先用面板自己的 `data-theme`（painter 已经按实际底色设过），
   * 没有就现算一次 `isDarkSurface`，再不行按浅色兜底。
   */
  function currentSurfaceTheme() {
    try {
      // ① 先读 **DSH 自己的信号**：`body[data-ds-dark-theme]`。
      //    这是 DSH 把"当前配色方案"投影到 document 的结果 —— 用户选的是
      //    「浅色 / 深色 / 跟随系统」哪一档都无所谓，这里拿到的都是**最终结论**。
      // 踩过的坑：一开始只看面板的合成底色（isDarkSurface）—— 面板底色取自 DSH 变量、
      // 自身与祖先的 background-color 往往是透明的，于是被算成浅色。
      // 用户实测：外观设为"跟随系统（暗）"时，生成的网页却是亮色。
      var bodyEl = document.body
      if (bodyEl && bodyEl.getAttribute && bodyEl.getAttribute('data-ds-dark-theme') !== null) return 'dark'
      // ② html 的 color-scheme：DSH 同时用它驱动原生控件，浅/深都会写上
      var rootEl = document.documentElement
      if (rootEl) {
        var scheme = ''
        try {
          scheme = String((window.getComputedStyle(rootEl) || {}).colorScheme || '')
        } catch (error) {
          scheme = ''
        }
        if (!scheme && rootEl.style) scheme = String(rootEl.style.colorScheme || '')
        if (scheme.indexOf('dark') >= 0) return 'dark'
        if (scheme.indexOf('light') >= 0) return 'light'
      }
      // ③ 面板自己的 data-theme（painter 设过）
      var attr = env.panel && env.panel.getAttribute ? env.panel.getAttribute('data-theme') : ''
      if (attr === 'dark' || attr === 'light') return attr
      // ④ 合成底色兜底（可能误判，所以放在后面）
      if (isDarkSurface(env.panel)) return 'dark'
      // ⑤ 最后才问系统偏好（"跟随系统"且上面都读不到时的兜底）
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
      return 'light'
    } catch (error) {
      return 'light'
    }
  }

  /** 当前可见的原文。
   *
   * 以前这里会剥掉"伪造的工具调用"文本（DSML / ds_safety_tool_call），
   * 现在**不再做任何文本清洗** —— 照主会话的做法：工具每轮都在请求里，
   * 模型走协议层表达调用，正文里根本不该出现这种标记。
   * 清洗留在那儿只会再吃一次正文（未闭合就删到结尾）。 */
  function visibleRaw() {
    return env.state.raw
  }

  // ────────────────────── 小窗对话历史（A′） ──────────────────────
  //
  // 不建会话：条目存在插件自己的目录里（host 侧 LRU 20 条）。这里负责三件事：
  //   ① 每轮结束把整段对话写回去（翻译/详解/追问/升格）
  //   ② 打开同一个词时先问 host 要历史，命中就直接回放（不调模型）
  //   ③ 「最近聊过的」列表，点一条把那段对话整个调回来

  /** 把当前状态存成一条历史（整段覆盖）。 */
  var historySaveSequence = 0

  function saveHistory(options) {
    var payload = env.state.payload
    if (!payload || !env.state.cacheKey) return

    var turns = []
    var exported = env.exportTurns()
    for (var i = 0; i < env.state.turns.length; i += 1) {
      var turn = env.state.turns[i]
      if (turn.hidden === true) continue
      // 落盘的是"实际发出去的那份"（用户那轮带引用块）：回放出来时这轮对话是自洽的
      turns.push(exported[i])
    }
    var owner = env.state.turns
    var ownerKey = env.state.cacheKey
    var sequence = ++historySaveSequence
    function noteSaved(error) {
      if (sequence !== historySaveSequence || env.state.turns !== owner || env.state.cacheKey !== ownerKey) return
      var last = owner[owner.length - 1]
      if (!last || last.role !== 'assistant') return
      if (error) {
        last.notice = '历史记录保存失败，当前原文仍在小窗中；刷新或退出前请先复制重要内容。'
        last.noticeCode = 'history-save-failed'
      } else if (last.noticeCode === 'history-save-failed') {
        last.notice = ''; last.noticeCode = ''
      } else return
      renderTurns()
    }
    var savedBody = {
      key: env.state.cacheKey,
      text: payload.text,
      context: payload.context,
      // 截图有标题时写进 label（旧列表/旧客户端也能显示）；标题本体另存 title
      label: payload.kind === 'shot' && String(env.state.shotTitle || '').trim()
        ? '截图 · ' + String(env.state.shotTitle).trim()
        : payload.label,
      ...(payload.kind === 'shot' && String(env.state.shotTitle || '').trim()
        ? { title: String(env.state.shotTitle).trim() }
        : {}),
      parts: env.state.parts,
      turns: turns,
      toolDigest: env.state.toolDigest,
      contextState: env.state.contextState || null,
      pinned: !!(options && options.pinned),
      // 这段对话有没有解读，必须跟着条目落盘：回放时靠它决定画不画「翻译」一节。
      // 不落盘的话，语音卡那条"跳过翻译与详解、直接追问"的对话下次开出来，
      // 会顶着一张空翻译卡片（"这次没有返回内容"）——用户实测。
      skipped: env.state.skipInterpretation === true,
      // 截图取景范围：标题那次请求要带上同样的 scope，才能得到同一个 SHOT_PROMPT 口径
      ...(payload.kind === 'shot' && env.state.shotScope
        ? { shotScope: env.state.shotScope, shotFrame: env.state.shotFrame !== false }
        : {}),
    }
    try {
      fetch(HISTORY, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(savedBody),
      })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then(function (result) {
          var failed = !result || result.ok !== true
          noteSaved(failed)
          // 截图提问：落盘成功后再去要一次标题（后台，不阻塞、不影响对话状态）。
          // 已经有标题 / 同一段对话正在请求时不再重复问 —— 否则每次追问都可能重起一次标题。
          if (!failed && payload.kind === 'shot') shotTitles.maybeRequest(savedBody, payload.sessionId)
        })
        .catch(function () {
          noteSaved(true)
        })
    } catch (error) {
      noteSaved(true)
    }
  }

  /** 用一条历史（或 host 回放结果）恢复面板。 */
  function applyHistoryEntry(entry, source) {
    var parts = entry.parts || {}
    env.state.parts = { translation: parts.translation || '', detail: parts.detail || '' }
    // 「这段对话有没有解读」跟着条目走：没有解读的对话（语音卡"跳过翻译与详解、直接追问"）
    // 回放时也不画翻译节 —— 否则回放会画出一张空的「翻译 /（这次没有返回内容）」卡片，
    // 而那正是用户否掉的东西。反过来也重要：回放一段**有**解读的对话时必须把标记清掉，
    // 否则上一段跳过解读的对话留下的标记会把这一段的翻译整节藏掉。
    //
    // 老条目（skipped 这个键是后来才加的）没有键时按内容兜一次：既没有翻译、也没有详解，
    // 却已经有追问轮次 —— 这段对话本来就没有解读。只在键**缺失**时兜：
    // 显式 false 的含义是"跑过解读、结果为空"，那是另一回事。
    //
    // ⚠️ 但"缺失"这条路实际走不到：旧版宿主读盘时把缺失写成了 false（已修）。
    // 所以被写坏的那批显式 false 条目，是靠 paint() 里的**内容兜底**兜住的
    // （见 panel.js：一节正文都没有 + 已有追问 → 整节不画）。这里保持语义精确：
    // 只有 true 和"缺失"能推出"跳过解读"，false 不推。
    var replayTurns = Array.isArray(entry.turns) ? entry.turns : []
    var hasAskTurn = false
    for (var step = 0; step < replayTurns.length; step += 1) {
      if (replayTurns[step] && replayTurns[step].role === 'user') {
        hasAskTurn = true
        break
      }
    }
    var noInterpretation = !String(parts.translation || '').trim() && !String(parts.detail || '').trim()
    env.state.skipInterpretation =
      entry.skipped === true || (entry.skipped === undefined && noInterpretation && hasAskTurn)
    env.state.contextState = readContextState(entry.contextState)
    if (env.state.contextState && typeof env.state.contextState.sessionId === 'string') env.panelSessionId = env.state.contextState.sessionId
    env.state.turns = Array.isArray(entry.turns) ? entry.turns.slice() : []
    // 回放的是**另一段**对话：输入框里攒的引用跟着清掉
    env.clearQuotes()
    env.state.toolDigest = typeof entry.toolDigest === 'string' ? entry.toolDigest : ''
    env.state.cacheKey = entry.key
    env.state.payload = env.buildPayload(entry.text, entry.context, entry.label)
    env.state.kind = env.state.payload.kind
    env.state.stage = ''
    env.state.raw = ''
    env.state.phase = 'done'
    env.state.error = ''
    // 打开历史/命中缓存也是"已完成"状态 → 光标交回输入框
    env.askFocusAfterTurn()
    env.state.sharedCache = false
    env.state.fromCache = source === 'local'
    env.state.fromHistory = source !== 'local'
    env.state.elapsed = 0
    env.state.toolBusy = false
    env.state.cacheState = source === 'local' ? 'local' : 'history'
    env.state.chars = (env.state.parts.translation || '').length + (env.state.parts.detail || '').length
    // 截图标题要跟着条目一起回放：老条目没存 title，就从 label（「截图 · 标题」）兜底解析
    var replayTitle = typeof entry.title === 'string' ? entry.title.trim() : ''
    if (!replayTitle) {
      var titleMatch = /^截图 · (.+)$/.exec(String(entry.label || ''))
      if (titleMatch) replayTitle = titleMatch[1]
    }
    env.state.shotTitle = replayTitle
    if (replayTitle) {
      if (env.applyShotTitle) env.applyShotTitle(replayTitle)
      else {
        env.quote.textContent = replayTitle
        env.quote.setAttribute('data-title', '1')
      }
    } else {
      env.quote.textContent = entry.text.length > 240 ? entry.text.slice(0, 240) + ' …' : entry.text
      env.quote.removeAttribute('data-title')
    }
    env.applySectionTitle(env.state.kind, entry.text)
    hideHistoryList()
    env.paint()
    // 胶囊左侧也要跟着回放：有标题显示标题，没标题显示这段原文
    if (env.paintPill) env.paintPill()
    renderTurns()
  }

  /**
   * 打开某个选区时，先问 host 有没有这段对话的历史：
   * **命中就直接回放（不调模型）**，没有才回调发请求。
   * 读历史超时/失败也照样发请求，不能因为历史接口卡住就不干活。
   */
  function restoreFromHistory(cacheKey, onMiss) {
    var settled = false
    function miss() {
      if (settled) return
      settled = true
      if (env.state.cacheKey === cacheKey && onMiss) onMiss()
    }
    var timer = env.timerScope.later(miss, 1500)
    try {
      fetch(HISTORY + '?key=' + encodeURIComponent(cacheKey))
        .then(function (response) {
          return response.json()
        })
        .then(function (data) {
          if (settled) return
          // 期间用户换了选区：丢弃
          if (env.state.cacheKey !== cacheKey || env.panelOpen !== true) {
            settled = true
            return
          }
          if (data && data.ok === true && data.entry) {
            settled = true
            env.timerScope.clear(timer)
            applyHistoryEntry(data.entry, 'history')
            return
          }
          miss()
        })
        .catch(miss)
    } catch (error) {
      miss()
    }
  }

  /** 「最近聊过的」列表。 */
  function hideHistoryList() {
    env.historyList.style.display = 'none'
    env.historyButton.removeAttribute('data-on')
  }

  /**
   * 把列表摆到面板旁边（B 方案）：
   *   ① 优先右侧（面板右边还有 220px 空间）
   *   ② 放不下就翻到左侧
   *   ③ 两侧都放不下（窄屏）→ 覆盖在面板正文上，仍然**不**进消息滚动区
   * 高度跟面板对齐（上限视口高度），自带滚动条。
   */
  function placeHistoryList() {
    var rect = env.panelLayoutRect()
    var width = 250
    var gap = 10
    var viewportW = window.innerWidth || 1200
    var viewportH = window.innerHeight || 800
    var left = rect.right + gap
    var side = 'right'
    if (left + width > viewportW - 8) {
      left = rect.left - width - gap
      side = 'left'
    }
    if (left < 8) {
      // 窄屏：覆盖在正文上（左对齐面板、避开头部）
      side = 'overlay'
      left = Math.max(8, rect.left + 8)
      width = Math.max(180, Math.min(rect.width - 16, 320))
    }
    var top = Math.max(8, Math.min(rect.top, viewportH - 120))
    var height = Math.max(160, Math.min(rect.height, viewportH - top - 8))
    if (side === 'overlay') {
      top = rect.top + 46
      height = Math.max(160, Math.min(rect.height - 56, viewportH - top - 8))
    }
    env.historyList.setAttribute('data-side', side)
    env.historyList.style.left = Math.round(left) + 'px'
    env.historyList.style.top = Math.round(top) + 'px'
    env.historyList.style.width = Math.round(width) + 'px'
    env.historyList.style.maxHeight = Math.round(height) + 'px'
  }

  function toggleHistoryList() {
    if (env.historyList.style.display === 'flex') {
      hideHistoryList()
      return
    }
    env.historyList.style.display = 'flex'
    env.historyButton.setAttribute('data-on', '1')
    placeHistoryList()
    openHistoryList()
  }

  /** 拉取并渲染历史列表（开关打开时、以及撤销之后都走这里）。 */
  function openHistoryList() {
    env.historyList.textContent = ''
    env.historyList.appendChild(el('div', 'dsh-sel-historytitle', '最近聊过的（点一条调回那段对话）'))
    var loading = el('div', 'dsh-sel-historyempty', '读取中…')
    env.historyList.appendChild(loading)
    fetch(HISTORY)
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        var entries = data && Array.isArray(data.entries) ? data.entries : []
        env.historyList.textContent = ''
        env.historyList.appendChild(el('div', 'dsh-sel-historytitle', '最近聊过的（点一条调回那段对话）'))
        if (entries.length === 0) {
          env.historyList.appendChild(el('div', 'dsh-sel-historyempty', '还没有历史——问过的问题会留在这里'))
          return
        }
        for (var i = 0; i < entries.length; i += 1) {
          env.historyList.appendChild(historyRow(entries[i]))
        }
      })
      .catch(function () {
        env.historyList.textContent = ''
        env.historyList.appendChild(el('div', 'dsh-sel-historyempty', '读不到历史'))
      })
  }

  /** 位置标签压缩：列表里不需要「页面内容」这么长。 */
  function shortLabel(label) {
    var text = String(label || '').replace(/（[^）]*）/g, '')
    if (text === '页面内容') return '页面'
    if (text === '对话消息') return '消息'
    if (text === '代码块') return '代码'
    return text
  }

  function historyRow(item) {
    var row = el('div', 'dsh-sel-historyrow')
    // 标题独占一行（不再被右边的小字挤掉），空标题也给个交代
    // 截图条目：优先用 title 字段；老条目只有 label「截图 · 预算逻辑」时从 label 解析
    var shotTitle = typeof item.title === 'string' ? item.title.trim() : ''
    var shotMatch = /^截图 · (.+)$/.exec(String(item.label || ''))
    var isShot = !!shotTitle || !!shotMatch
    var main = shotTitle || (shotMatch ? shotMatch[1] : String(item.text || '').trim())
    // 只留标题 + 元信息（轮数/时间）；问题那行不要 —— 用户嫌太啰嗦
    row.appendChild(el('div', 'dsh-sel-historytext', main || '（这次没选中文字）'))
    // 删除键：stopPropagation 很重要 —— 否则点它会被当成"点这一行去回放"
    var del = el('button', 'dsh-sel-historydel', '✕')
    del.type = 'button'
    del.title = '删除这条记录'
    del.setAttribute('aria-label', '删除这条记录')
    listen(del, 'click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      deleteHistoryEntry(item, row)
    })
    row.appendChild(del)
    // 截图条目的标题已经在主行了，元信息里只留"截图"两个字，
    // 否则会显示成「截图 · 人的后脑勺背影 · 1 轮」，标题重复一遍
    var metaLabel = isShot ? '截图' : shortLabel(item.label)
    var meta =
      (metaLabel ? metaLabel + ' · ' : '') +
      (item.turns > 0 ? item.turns + ' 轮 · ' : '') +
      formatWhen(item.at)
    var metaNode = el('div', 'dsh-sel-historymeta')
    metaNode.appendChild(el('span', null, meta))
    if (item.pinned) metaNode.appendChild(el('span', 'dsh-sel-historypin', '已升格'))
    row.appendChild(metaNode)
    listen(row, 'click', function (event) {
      event.stopPropagation()
      loadHistoryEntry(String(item.key))
    })
    return row
  }

  /**
   * 删除一条历史（行内 ✕）。
   * 先打 DELETE 拿回被删条目的快照，再从列表里移除那一行并挂一条"撤销"；
   * 撤销就是把快照 POST 回 /history?restore=1 —— 服务端只存快照，不做复杂的状态回滚。
   */
  function deleteHistoryEntry(item, row) {
    fetch(HISTORY + '?key=' + encodeURIComponent(String(item.key)), { method: 'DELETE' })
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        if (!data || data.ok !== true) {
          env.setStatus('删除失败')
          return
        }
        if (!data.entry) {
          // 服务端已经没有这条了（比如另一个窗口删过）：把它从界面上拿掉就行
          if (row.parentNode) row.parentNode.removeChild(row)
          return
        }
        var snapshot = data.entry
        if (row.parentNode) row.parentNode.removeChild(row)
        showUndoBar(snapshot)
      })
      .catch(function (error) {
        env.setStatus('删除失败：' + String((error && error.message) || error))
      })
  }

  /** 底部"已删除 · 撤销"，5 秒后自己消失。 */
  function showUndoBar(snapshot) {
    var existing = null
    for (var i = 0; i < env.historyList.children.length; i += 1) {
      if (String(env.historyList.children[i].className).indexOf('dsh-sel-undo') >= 0) existing = env.historyList.children[i]
    }
    if (existing) env.historyList.removeChild(existing)
    var bar = el('div', 'dsh-sel-undo')
    bar.appendChild(el('span', null, '已删除「' + String(snapshot.text || '').slice(0, 12) + '…」'))
    var undo = el('button', null, '撤销')
    undo.type = 'button'
    listen(undo, 'click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      fetch(HISTORY + '?restore=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entry: snapshot }),
      })
        .then(function (response) {
          return response.json()
        })
        .then(function () {
          env.setStatus('已恢复')
          openHistoryList()
        })
        .catch(function () {
          env.setStatus('恢复失败')
        })
    })
    bar.appendChild(undo)
    env.historyList.appendChild(bar)
    env.timerScope.later(function () {
      if (bar.parentNode) bar.parentNode.removeChild(bar)
    }, 5000)
  }

  function formatWhen(at) {
    if (!at) return ''
    var date = new Date(at)
    var now = new Date()
    var hh = ('0' + String(date.getHours())).slice(-2) + ':' + ('0' + String(date.getMinutes())).slice(-2)
    if (date.toDateString() === now.toDateString()) return hh
    var yesterday = new Date(now.getTime() - 86400000)
    if (date.toDateString() === yesterday.toDateString()) return '昨天 ' + hh
    return date.getMonth() + 1 + '月' + date.getDate() + '日 ' + hh
  }

  /**
   * 取一条历史回放。anchor 省略时：
   *   · 从「最近」列表里点一条 → **面板不挪位置**：列表本来就贴着面板摆，
   *     把面板重新锚到胶囊上会让人眼看着面板"跳到右下角胶囊上方"（实测反馈的 bug）。
   *   · 就绪状态点胶囊回放 → 锚到胶囊上方；否则面板从没被摆过位置，会跑到屏幕左上角。
   *
   * 注意：`applyHistoryEntry` 内部会收起列表，所以"是否从列表进入"必须在调用**之前**判断。
   */
  function loadHistoryEntry(key, anchor) {
    var fromList = env.historyList.style.display === 'flex'
    fetch(HISTORY + '?key=' + encodeURIComponent(key))
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        if (!data || data.ok !== true || !data.entry) return
        env.panelOpen = true
        env.panel.style.display = 'flex'
        applyHistoryEntry(data.entry, 'history')
        // 先画内容再摆位置：showPanel 要量面板高度才能决定放上面还是下面
        if (!fromList) env.showPanel(anchor || env.rectOfPill())
        // 从列表进入时**不走 showPanel**（面板不挪位置）—— 轮询与跟随值这里自己补上
        else { env.refreshFollowRoute(); env.syncRouteWatch(); env.warmModelCatalog() }
        // 内容换了、面板高度可能变 → 列表跟着重摆（列表此时已被 applyHistoryEntry 收起，按需再开）
        if (env.historyList.style.display === 'flex') placeHistoryList()
      })
      .catch(function () {
        /* noop */
      })
  }

  /**
   * 撤掉"进行中"类提示：`conclusion-retry`（"查询已完成，正在整理结论…"）是**过程状态** ——
   * 正文一开始到达、或者本轮结束，它就该消失。
   *
   * 踩过的坑：这条提示写进 answerTurn.notice 之后，**全代码没有任何地方清掉它** ——
   * 回答早就写完了，黄条还挂在气泡上（用户截图报的现象）。
   * 其余 notice（effort-clamped / effort-rejected / reasoning-leak）是"这条回答发生了什么"的
   * 说明，属于该留下的信息，不在这里清。
   */
  function clearTransientNotice(turn) {
    if (!turn) return false
    var code = String(turn.noticeCode || '')
    // conclusion-retry：进行中状态，正文到了就撤；
    // upstream-retry：上游偶发错误（host 已换档重试），重试成功时正文会到、失败时走 error，
    //   两种情况都不该把这句一直挂在回答上面。
    // effort-rejected / reasoning-leak 是"这个模型这一档有问题"的结论性说明，留着。
    if (code !== 'conclusion-retry' && code !== 'upstream-retry') return false
    turn.notice = ''
    turn.noticeCode = ''
    return true
  }

  /** 工具名 → 中文标签（只用于内部摘要，不上界面）。 */
  function toolLabel(name) {
    // 小窗默认用的是 free-search 插件的工具（见 host 侧 toolNames 注释）
    if (name === 'advanced_search') return '联网搜索'
    if (name === 'platform_search') return '站内搜索'
    if (name === 'web_search') return '联网搜索' // 万一配成官方搜索，标签不变
    if (name === 'web_fetch') return '抓取网页'
    return String(name || '工具')
  }

  /** 工具结果 → 追问用的摘要（下一轮不再重查同样的内容）。 */
  function rememberToolDigest(tool) {
    var line =
      '- ' +
      toolLabel(tool.name) +
      '「' +
      String(tool.detail || '').slice(0, 60) +
      '」→ ' +
      (tool.ok === false ? '失败' : tool.chars ? tool.chars + ' 字结果' : '完成') +
      (tool.urls && tool.urls.length > 0 ? '，链接：' + tool.urls.slice(0, 3).join(' ') : '') +
      (tool.preview ? '；摘要：' + String(tool.preview).replace(/\s+/g, ' ').slice(0, 220) : '')
    env.state.toolDigest = (env.state.toolDigest ? env.state.toolDigest + '\n' : '') + line
    if (env.state.toolDigest.length > 1800) env.state.toolDigest = env.state.toolDigest.slice(-1800)
  }

  /**
   * 处理一个 tool 事件（start / done 两段）。
   *
   * 只做两件事，**一个 DOM 节点都不建**：
   *   1. done 时把结果摘要累进 state.toolDigest —— 追问时带给模型，告诉它"已经查过什么，别重查"；
   *   2. 维护 state.toolBusy —— 等待提示里写一句"正在检索资料"，免得几十秒的检索看着像卡死。
   * 查询词、命中字数、预览正文、链接、耗时一律不进小窗：小窗只放模型处理后的结果。
   */
  function applyToolEvent(message) {
    var phase = message.phase === 'done' ? 'done' : 'start'
    var callId = String(message.callId || message.name || 'tool')
    var item = null
    for (var i = 0; i < env.state.tools.length; i += 1) {
      if (env.state.tools[i].callId === callId && env.state.tools[i].phase === 'running' && phase === 'done') {
        item = env.state.tools[i]
        break
      }
    }
    if (!item) {
      item = { callId: callId, name: message.name, detail: message.detail, phase: 'running' }
      env.state.tools.push(item)
    }
    item.name = message.name || item.name
    item.detail = message.detail || item.detail
    if (phase === 'done') {
      item.phase = 'done'
      item.ok = message.ok !== false
      item.ms = typeof message.ms === 'number' ? message.ms : 0
      item.chars = typeof message.chars === 'number' ? message.chars : 0
      item.preview = typeof message.preview === 'string' ? message.preview : ''
      item.urls = Array.isArray(message.urls) ? message.urls : []
      rememberToolDigest(item)
    } else {
      item.phase = 'running'
    }
    env.state.toolBusy = phase !== 'done'
    if (env.state.toolBusy) env.setStatus(env.progressText())
  }

  /** 把首轮解读结果作为追问的第一条助手上下文（截断，避免过长）。 */
  function seedHistoryFromExplanation() {
    var fallback = splitSections(env.state.raw)
    var translation = (env.state.parts.translation || fallback.translation || '').trim()
    var detail = (env.state.parts.detail || fallback.detail || '').trim()
    // 写成"前情提要"而不是"我上一轮的回答"：否则模型会顺着把两节内容再复述一遍
    var seed =
      '（前情：已就这段选中文字给出解读——' +
      (env.state.sectionTitle || '翻译') +
      '：' +
      translation +
      (detail ? '；详解：' + detail : '') +
      '）'
    return seed.length > 1500 ? seed.slice(0, 1500) + '…' : seed
  }
  return {
    clearRenderedTurns,
    hideHistoryList,
    placeHistoryList,
    toggleHistoryList,
    noteUserScroll,
    noteBodyScroll,
    ensurePanelInsideViewport,
    get foldCount() { return text.foldCount },
    set foldCount(value) { text.foldCount = value },
    foldForHistory,
    renderTurns,
    get chatGrowWatch() { return scroll.chatGrowWatch },
    set chatGrowWatch(value) { scroll.chatGrowWatch = value },
    get panelGrowWatch() { return scroll.panelGrowWatch },
    set panelGrowWatch(value) { scroll.panelGrowWatch = value },
    currentSurfaceTheme,
    restoreFromHistory,
    visibleRaw,
    loadHistoryEntry,
    seedHistoryFromExplanation,
    ensureChatFollow,
    clearTransientNotice,
    saveHistory,
    applyToolEvent,
    ensurePanelInsideViewportNow,
  }
}
