import { HISTORY, API } from './constants.js'
import { cleanShotTitle, readSseText } from './history-text.js'

/** Background screenshot titles own only their pending request key. */
export function createShotTitleController(env, refreshHistoryList) {
  var shotTitlePendingKey = ''

  function maybeRequest(saved, sessionId) {
    if (String(env.state.shotTitle || '').trim() || shotTitlePendingKey === saved.key) return
    shotTitlePendingKey = saved.key
    requestShotTitle(saved, sessionId)
  }

  /**
   * 截图提问：回答结束后**单独要一次标题**。
   *
   * 为什么不塞在回答里：模型经常不照格式走（实测），而且会把标题混进正文。
   * 单独问一句它反而稳 —— 而且这条请求的前缀与回答那次完全一致
   * （同 system、同图、同提问，只在最后追加一句"只输出标题"），图能命中前缀缓存。
   *
   * 安全约定：
   *   · 不碰 state.turns / cacheKey / DOM —— 你后面的提问完全不受影响；
   *   · 拿到标题后先读最新历史，只改 title / label 后写回，保留后续轮次；
   *   · 当前面板已换到另一段对话时，不把旧标题挂到新对话上。
   */
  function requestShotTitle(saved, sessionId, attempt) {
    var tries = attempt || 0
    var userTurn = null
    var list = saved.turns || []
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].role === 'user' && list[i].attachments && list[i].attachments.length > 0) {
        userTurn = list[i]
        break
      }
    }
    if (!userTurn) return
    var savedKey = saved.key
    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: saved.text,
        kind: 'shot',
        titleOnly: true,
        label: '截图',
        attachments: userTurn.attachments,
        // 与回答那次同一个取景口径：标题是最好的"红框/仅选区"措辞，换口径会问错东西
        ...(saved.shotScope ? { shotScope: saved.shotScope, shotFrame: saved.shotFrame !== false } : {}),
        // ⚠️ 必须带 sessionId：不带会被上游 400 拒绝（MissingSessionID），
        // 而 `env.panelSessionId` 在历史模块里并不存在 —— 用的是保存时那份 payload 里的。
        ...(sessionId ? { sessionId } : {}),
        // ⚠️ 必须带上面板当前用的模型：不带的话 host 会退回"会话默认模型"，
        // 那个路由可能不支持图片 → 上游报错 → 正文为空 → 标题永远写不回去（实测踩到）。
        ...(env.state.modelChoice
          ? { provider: env.state.modelChoice.provider, model: env.state.modelChoice.model }
          : {}),
      }),
    })
      .then(function (response) {
        return response.ok ? response.text() : ''
      })
      .then(function (raw) {
        var title = cleanShotTitle(readSseText(raw))
        if (!title) throw new Error('empty-title')
        if (shotTitlePendingKey === savedKey) shotTitlePendingKey = ''
        // 先把标题挂到当前面板（即使随后写历史失败，用户也能立刻看到）；
        // 再异步写回历史，供重开 / 最近列表使用。
        if (env.state.cacheKey === savedKey && env.applyShotTitle) env.applyShotTitle(title)
        writeShotTitle(savedKey, title)
      })
      .catch(function () {
        // 上游偶发失败（空正文 / 400 / 断流）：隔 2 秒重试一次，之后放弃
        if (tries >= 1) {
          if (shotTitlePendingKey === savedKey) shotTitlePendingKey = ''
          return
        }
        setTimeout(function () {
          requestShotTitle(saved, sessionId, tries + 1)
        }, 2000)
      })
  }

  /**
   * 把标题写回历史。
   *
   * ⚠️ 不能拿"保存时的旧快照"去覆盖：历史条目是**整条一起存**的（标题 + 整段对话），
   * 覆盖时如果有人在这几秒里又问了一句，旧快照会把那一句一起抹掉。
   * 所以先**读最新的那条**，只改 title/label，再存回去 —— 对话一个不少，标题也更新了。
   */
  function writeShotTitle(key, title) {
    fetch(HISTORY + '?key=' + encodeURIComponent(key))
      .then(function (response) {
        return response.ok ? response.json() : null
      })
      .then(function (data) {
        var entry = data && data.entry
        if (!entry) return
        return fetch(HISTORY, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // title 是权威字段；label 继续写成「截图 · 标题」兼容旧列表/旧版本
          body: JSON.stringify(Object.assign({}, entry, { title: title, label: '截图 · ' + title })),
        })
      })
      .then(function (response) {
        if (!response || !response.ok) return
        // 列表正开着就刷新一下，让新标题立刻可见
        if (env.historyList && env.historyList.style.display === 'flex') refreshHistoryList()
      })
      .catch(function () {
        /* 写不进去就算了：面板已显示标题，下一次保存会把 title 一起带上 */
      })
  }

  return { maybeRequest }
}
