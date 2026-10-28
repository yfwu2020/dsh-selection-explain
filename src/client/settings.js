import { el, listen } from './dom.js'
import { ROUTE, createPreferences, SETTINGS } from './constants.js'

/** settings state and operations; dependencies are supplied as live node/callback accessors. */
/** @param {import('./controller-contracts.js').SettingsEnv} env */
export function createSettingsController(env) {
  var preferences = env.preferences || createPreferences()

  /**
   * 设置页状态。
   *
   * 刻意**不查 DOM**（不用 querySelectorAll / innerHTML）：插件通篇是"拿住节点引用"的写法，
   * 而且单测的 DOM 桩也没有这两个接口。分组、行、分段格的节点都存下来，重绘时直接按引用操作。
   *
   *   spec      —— host 下发的字段声明（客户端不硬编码任何字段与边界）
   *   saved     —— host 已落盘的值（算"改了几项"、也是「恢复默认」后的对照）
   *   live      —— 控件上的当前值
   *   byKey     —— key → 控件条目，保存时按 key 取值
   */
  var settingsOpen = false

  var settingsSpec = null

  var settingsSaved = {}

  var settingsLive = {}

  var settingsByKey = {}

  var settingsRailButtons = []

  var settingsPanes = []

  var settingsSegs = []

  /**
   * 四个格子的文案（关/低/高/最高）。
   *
   * 它是**插件的固定词汇**，与模型无关；落到模型的哪个真实档位由 host 按该模型的声明
   * 实时算（`/models` 每个模型带一份 `effortMap`，见 host 的 mapEffortToModel）。
   */
  var SLOT_LABEL = {
    off: '关', low: '低', high: '高', max: '最高',
    // 截图取景范围（与推理档位共用 seg 标签表；值互不重叠）
    screen: '全屏', window: '整窗', margin: '选区+留白', selection: '仅选区',
  }

  var SLOT_ORDER = ['off', 'low', 'high', 'max']

  /** 设置页里那几行"四格 → 当前模型真实档位"的提示节点（跟着模型实时变）。 */
  var settingsEffortHints = []

  /** 自绘下拉的菜单节点（挂在抽屉上，重渲染时要一起清掉，否则会叠出第二份浮层）。 */
  var settingsMenus = []

  var settingsFetching = false

  var settingsSaveTimer = 0

  var settingsSaveSeq = 0

  var settingsSaving = false

  var settingsSaveRequest = null

  var settingsResetting = false

  /** 清空一个节点的子元素（替代 innerHTML=''，两者在桩里都没有）。 */
  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  /**
   * 造一个 <option>（原生 select 用；设置页已改成自绘下拉，这里留给别处复用）。
   */
  function modelOption(value, label) {
    var option = el('option', null, label)
    option.value = value
    return option
  }

  /**
   * 一个模型下拉行"选中了什么"。
   *
   * 每个模型行管**两个**配置字段（spec.keys，如 ['provider','model'] 或 ['chatProvider','chatModel']）。
   * 两个都有才算选定；否则这一行就是"跟随"状态。
   */
  function pairOf(entry) {
    var keys = entry.spec.keys || []
    var provider = settingsLive[keys[0]]
    var model = settingsLive[keys[1]]
    if (!provider || !model) return null
    return { provider: String(provider), model: String(model) }
  }

  /** 一行"跟随"时该写什么字（两行语义不同：首轮/次轮跟主会话，追问跟首轮/次轮）。 */
  function followLabelOf(entry) {
    return '跟随主会话'
  }

  /**
   * 下拉按钮上的文字。
   *
   *   · 选定过 → 显示模型名（确定无疑）
   *   · 没选定 → 「跟随…（当前：X）」—— X 是本行**实际会用**的那个模型：
   *     首轮/次轮行取 /route，追问行取 /route?chat=1。两个会话用不同模型时各报各的。
   */
  function paintModelPick(entry) {
    if (!entry.label) return
    var pair = pairOf(entry)
    if (pair) {
      entry.label.textContent = modelLabel(pair.provider, pair.model, entry.catalog)
      return
    }
    var base = followLabelOf(entry)
    var route = entry.route
    entry.label.textContent = route && route.provider && route.model
      ? base + '（当前：' + modelLabel(route.provider, route.model, entry.catalog) + '）'
      : base
  }

  /** 关掉所有模型下拉（同一时刻只允许开一个）。 */
  function closeModelPicks() {
    Object.keys(settingsByKey).forEach(function (key) {
      var entry = settingsByKey[key]
      if (entry && entry.menu) {
        entry.menu.setAttribute('data-open', '0')
        if (entry.button) entry.button.setAttribute('aria-expanded', 'false')
      }
    })
  }

  /**
   * 取"这一行现在实际会用哪个模型"（轻量端点，可高频轮询）。
   *
   * 用 /route 而不是 /models：后者要列 provider 与全部模型（42 个 + 端点发现），
   * 按秒轮询太重。这里只做一次会话模型解析。
   */
  function fetchRoute(sessionId, isChat) {
    var query = []
    if (sessionId) query.push('sessionId=' + encodeURIComponent(sessionId))
    if (isChat) query.push('chat=1')
    return fetch(ROUTE + (query.length ? '?' + query.join('&') : ''), { headers: { accept: 'application/json' } })
      .then(function (response) { return response.json() })
      .then(function (data) {
        if (!data || data.ok === false) return null
        return { provider: String(data.provider || ''), model: String(data.model || '') }
      })
      .catch(function () { return null })
  }

  /**
   * 把"跟随主会话"解析出来的路由贴到界面上。
   *
   * 跟随态有两个地方显示它，**两处都要贴**：
   *   · 抽屉里那一行的「跟随主会话（当前：…）」
   *   · **输入框那枚模型胶囊**（跟随态它显示的就是这个值）
   * 分开贴是有原因的：以前胶囊的更新写在抽屉那行的 `if (!item.entry) return` 之后 ——
   * 设置没渲染出来（/settings 失败）时胶囊就永远不跟着变；这里各管各的。
   */
  function applyFollowRoute(route) {
    if (!route || !route.provider || !route.model) return
    // 选了具体模型时胶囊显示的是那个模型，不显示"跟随（当前：…）"
    if (!env.state.modelChoice) {
      var before = env.modelCatalog.current
      if (!before || before.provider !== route.provider || before.model !== route.model) {
        env.modelCatalog.current = route
        env.paintModelPill()
      }
    }
    var entry = settingsByKey.modelChoice
    if (!entry) return
    var old = entry.route
    if (old && old.provider === route.provider && old.model === route.model) return
    entry.route = route
    paintModelPick(entry)
  }

  /**
   * 刷新一个模型行：清单（带缓存）+ 本行当前值（每次都新取）→ 画按钮、必要时重建列表。
   *
   * `forceRoute` 为真时连清单也强制重取（开抽屉那一次用）。
   */
  function refreshModelRow(entry, forceRoute) {
    if (!entry) return
    var isChat = false
    var sessionId = env.panelSessionId || env.currentSessionId()
    env.loadModelCatalog(!!forceRoute, sessionId).then(function (catalog) {
      // **快照**，不是直接拿 modelCatalog 那个单例：
      // 另一行稍后会带着自己的会话再拉一次，那会把单例上的字段改掉。
      entry.catalog = {
        current: catalog.current,
        items: catalog.items,
        sessionId: sessionId,
        error: catalog.error,
      }
      if (entry.filledSession !== sessionId) {
        entry.filledSession = sessionId
        entry.filled = false
        entry.rows = []
      }
      if (forceRoute) entry.filled = false
      fillModelMenu(entry, entry.catalog)
      paintModelPick(entry)
      paintEffortMapHint()
    })
    fetchRoute(sessionId, isChat).then(applyFollowRoute)
  }

  /** 按清单把下拉列表填好（清单是异步来的，可能晚于渲染）。 */
  function fillModelMenu(entry, catalog) {
    if (!entry.menu || entry.filled) return
    entry.filled = true
    var list = entry.list
    clearNode(list)
    entry.rows = []
    var items = (catalog && catalog.items) || []
    if (items.length === 0) {
      list.appendChild(el('div', 'dsh-sel-spickempty',
        catalog && catalog.error ? '读取失败：' + catalog.error : '没有取到可用模型清单'))
      return
    }
    // 第一项永远是"跟随"：它不是一个模型，而是"清空这一行的两个字段"
    list.appendChild(modelPickRow(entry, null))
    for (var i = 0; i < items.length; i += 1) list.appendChild(modelPickRow(entry, items[i]))
  }

  /** 一行模型（item 为 null = 「跟随…」）。 */
  function modelPickRow(entry, item) {
    var row = el('button', 'dsh-sel-spickrow')
    row.type = 'button'
    row.setAttribute('role', 'option')
    var pair = pairOf(entry)
    var on = item
      ? !!pair && pair.provider === item.provider && pair.model === item.model
      : !pair
    row.setAttribute('data-on', on ? '1' : '0')
    row.setAttribute('aria-selected', on ? 'true' : 'false')
    row.appendChild(el('span', 'dsh-sel-spickcheck', on ? '✓' : ''))
    row.appendChild(el('span', 'dsh-sel-spickrowname', item ? String(item.name || item.model) : followLabelOf(entry)))
    if (item) row.appendChild(el('span', 'dsh-sel-spickprov', String(item.providerName || item.provider || '')))
    listen(row, 'click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      var keys = entry.spec.keys || []
      if (item) {
        settingsLive[keys[0]] = String(item.provider || '')
        settingsLive[keys[1]] = String(item.model || '')
      } else {
        settingsLive[keys[0]] = ''
        settingsLive[keys[1]] = ''
      }
      repaintModelMenu(entry)
      paintModelPick(entry)
      closeModelPicks()
      syncComposerModel()
      renderSettingsNote('')
      scheduleSettingsSave()
    })
    if (item) entry.rows.push(item)
    return row
  }

  /** 就地重画这一行列表的勾选（不重建节点，省得丢焦点/滚动位置）。 */
  function repaintModelMenu(entry) {
    if (!entry.list) return
    var pair = pairOf(entry)
    var rows = entry.list.children
    for (var i = 0; i < rows.length; i += 1) {
      var item = i === 0 ? null : (entry.rows[i - 1] || null)
      var on = item
        ? !!pair && pair.provider === item.provider && pair.model === item.model
        : !pair
      rows[i].setAttribute('data-on', on ? '1' : '0')
      rows[i].setAttribute('aria-selected', on ? 'true' : 'false')
      var check = rows[i].firstChild
      if (check) check.textContent = on ? '✓' : ''
    }
  }

  /**
   * 开 / 关模型下拉。
   *
   * 菜单挂在**抽屉**上而不是行里：行的祖先链上有 `overflow:auto` 的滚动区，
   * 浮层放在行里会被那个滚动区裁掉（这正是"看不到滚动条"的一种成因）。
   * 位置按按钮的实测矩形算，高度按"抽屉底部还剩多少"给 —— 于是列表一定滚得动。
   */
  function toggleModelMenu(entry) {
    if (!entry.menu) return
    var wasOpen = entry.menu.getAttribute('data-open') === '1'
    closeModelPicks()
    if (wasOpen) return
    var sheetRect = env.settingsSheet.getBoundingClientRect()
    var btnRect = entry.button.getBoundingClientRect()
    var left = btnRect.left - sheetRect.left
    var width = btnRect.width
    entry.menu.style.left = String(Math.max(6, left)) + 'px'
    entry.menu.style.width = String(Math.max(140, width)) + 'px'
    // 优先向下弹；下方放不下（窗口矮 / 行贴着底）就翻到按钮**上方** ——
    // 否则浮层会被面板的 overflow:hidden 切掉一截，看起来又像"没有滚动条"。
    var roomBelow = sheetRect.bottom - btnRect.bottom - 18
    if (roomBelow >= 140) {
      entry.menu.style.top = String(btnRect.bottom - sheetRect.top + 6) + 'px'
      entry.menu.style.bottom = ''
      entry.menu.style.maxHeight = String(roomBelow) + 'px'
    } else {
      var roomAbove = btnRect.top - sheetRect.top - 18
      entry.menu.style.top = ''
      entry.menu.style.bottom = String(sheetRect.bottom - btnRect.top + 6) + 'px'
      entry.menu.style.maxHeight = String(Math.max(140, roomAbove)) + 'px'
    }
    entry.menu.setAttribute('data-open', '1')
    entry.button.setAttribute('aria-expanded', 'true')
  }

  /**
   * 模型在下拉里的显示名。
   *
   * 优先用 host 给的人类可读名（`name`），没有就退回 `provider / model` ——
   * 清单里 42 个模型跨好几个 provider，只写模型名会分不清同名项。
   */
  function modelLabel(provider, model, catalog) {
    var items = (catalog && catalog.items) || env.modelCatalog.items || []
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].provider === provider && items[i].model === model) {
        var name = String(items[i].name || items[i].model || '')
        var pname = String(items[i].providerName || provider || '')
        return items[i].providerName && items[i].providerName !== name ? pname + ' · ' + name : name
      }
    }
    return (provider ? provider + ' / ' : '') + model
  }

  /**
   * 设置页那行"四格 → 当前模型的真实档位"。
   *
   * 映射是 **host 按模型声明实时算的**：`/models` 里每个模型带一份 `effortMap`
   * （见 host 的 mapEffortToModel —— 它只吃"这个模型自己声明的档位列表"，
   * 名字认不出就按位置插值，所以任何用户换任何模型都有落点）。
   * 客户端只负责显示，插件里**没有**任何按模型写死的表；换模型 / 换会话立刻跟着变。
   */
  /** 模型自己给这个档位的名字（清单里没有就用 id）——「思考强度」那行映射提示专用。 */
  function modelTierNameOf(item, id) {
    var efforts = (item && item.efforts) || []
    for (var i = 0; i < efforts.length; i += 1) {
      if (efforts[i].id === id) return String(efforts[i].name || efforts[i].id)
    }
    return String(id)
  }

  /**
   * 改「追问」的思考强度 —— **唯一**的写入口（设置页那一行与小窗那个控件共用）。
   *
   * 两处读写的是**同一个值**：host 配置 `chatReasoningEffort`（四个格子之一）。
   * 于是不存在"两边各写各的"，也不需要任何反向映射 —— 一边改，另一边重画一次就同步了。
   * `state.effort` 只是这个值的**内存镜像**（发请求时随 body.effort 带上，免得存盘还没回来
   * 就发了请求；列表读到 `stages.chat` 之前也靠它兜底）。
   */
  function setChatSlot(slot) {
    settingsLive.chatReasoningEffort = slot
    env.state.effort = slot
    var entry = settingsByKey.chatReasoningEffort
    if (entry) {
      setControlValue('chatReasoningEffort', slot)
      paintSegPill(entry)
    }
    if (env.modelMenu.getAttribute('data-open') === '1') env.renderModelMenu()
    renderSettingsNote('')
    scheduleSettingsSave()
  }

  /** 当前「追问」档位：内存镜像 → 配置 → /models 报的配置值（都是四个格子之一）。 */
  function chatSlot() {
    return env.state.effort || settingsLive.chatReasoningEffort || (env.modelCatalog.stages && env.modelCatalog.stages.chat) || ''
  }

  function paintEffortMapHint() {
    if (!settingsEffortHints.length) return
    var choice = env.state.modelChoice
    if (!choice && env.modelCatalog.current && env.modelCatalog.current.provider && env.modelCatalog.current.model) {
      choice = { provider: String(env.modelCatalog.current.provider), model: String(env.modelCatalog.current.model) }
    }
    var item = choice ? env.catalogItemOf(choice.provider, choice.model) : null
    var text = ''
    if (!item) {
      text = env.modelCatalog.error
        ? '读不到模型清单（' + env.modelCatalog.error + '）：暂时按原档位发送，被拒时自动换档'
        : '正在读取该模型的档位…'
    } else if (item.hasReasoning === false) {
      text = '该模型不支持思考强度：这四个格子对它不生效（不会发送档位）'
    } else if (item.effortMap && item.effortMap[SLOT_ORDER[0]]) {
      var parts = []
      for (var i = 0; i < SLOT_ORDER.length; i += 1) {
        var slot = SLOT_ORDER[i]
        var actual = item.effortMap[slot]
        // 右边用**模型自己的档位名**（Off/Low/Xhigh…），不要换成我们的「低/高」——
        // 否则"关 → 低"这种看着像恒等映射，实际落到的是模型的 low 档
        parts.push(SLOT_LABEL[slot] + ' → ' + (actual ? modelTierNameOf(item, actual) : '—'))
      }
      text = '当前模型：' + parts.join(' · ')
    } else {
      text = '暂未读到该模型声明的档位：先按原档位发送，被拒时自动换档重试'
    }
    for (var h = 0; h < settingsEffortHints.length; h += 1) settingsEffortHints[h].textContent = text
  }

  function settingsDirtyCount() {
    var n = 0
    Object.keys(settingsLive).forEach(function (key) {
      if (settingsSaved[key] !== settingsLive[key]) n += 1
    })
    return n
  }

  function renderSettingsNote(state) {
    var n = settingsDirtyCount()
    env.settingsNote.setAttribute('data-dirty', state === 'error' || n > 0 ? '1' : '0')
    if (state === 'saving') env.settingsNoteText.textContent = '保存中…'
    else if (state === 'error') env.settingsNoteText.textContent = '保存失败，改动未生效'
    else if (n > 0) env.settingsNoteText.textContent = '未保存 · ' + String(n) + ' 项'
    else env.settingsNoteText.textContent = '改动会自动保存'
  }

  /**
   * 把服务端返回的一组值铺到**所有**控件上（保存成功、恢复默认都走它）。
   *
   * 为什么不能只按返回的键逐个 setControlValue：模型行的条目 key 是虚拟的
   * （modelChoice），而服务端返回的是它底下的 provider/model ——
   * 按后者查条目**查不到**，于是"恢复默认"之后模型下拉纹丝不动（用户报的问题）。
   * 所以这里先整体更新 settingsLive/settingsSaved，再按**条目**重画一遍。
   */
  function applyServerValues(values, sent) {
    Object.keys(values || {}).forEach(function (key) {
      settingsSaved[key] = values[key]
      if (!sent || settingsLive[key] === sent[key]) settingsLive[key] = values[key]
    })
    Object.keys(settingsByKey).forEach(function (key) {
      var entry = settingsByKey[key]
      if (!entry) return
      if (entry.spec.kind === 'model') {
        paintModelPick(entry)
        repaintModelMenu(entry)
      } else {
        setControlValue(key, settingsLive[key])
      }
    })
    updateSettingDependencies()
    syncComposerModel()
    // 「追问」档位的内存镜像跟着配置走（四个格子之一；列表读到 stages.chat 之前也靠它兜底）
    env.state.effort = settingsLive.chatReasoningEffort || ''
    applySelectionLimit(settingsLive)
    if (!env.state.modelChoice) refreshModelRow(settingsByKey.modelChoice, true)
    env.bridgeOn = settingsLive.bridgeSidebarPreview !== false
    if (env.bridgeOn) env.scheduleBridgeScan()
  }

  function applySelectionLimit(values) {
    var max = Number(values && values.maxSelectionChars)
    if (isFinite(max) && max > 0) preferences.maxSelectionChars = max
  }

  function syncComposerModel() {
    var provider = settingsLive.provider
    var model = settingsLive.model
    env.state.modelChoice = provider && model ? { provider: String(provider), model: String(model) } : null
    env.paintModelPill()
  }

  function chooseSharedModel(choice) {
    settingsLive.provider = choice ? String(choice.provider || '') : ''
    settingsLive.model = choice ? String(choice.model || '') : ''
    syncComposerModel()
    var entry = settingsByKey.modelChoice
    if (entry) { paintModelPick(entry); repaintModelMenu(entry) }
    paintEffortMapHint()
    loadSettings(false)
    renderSettingsNote('')
    scheduleSettingsSave()
  }

  function updateSettingDependencies() {
    Object.keys(settingsByKey).forEach(function (key) {
      var entry = settingsByKey[key]
      var disabled = !!entry.spec.enabledBy && settingsLive[entry.spec.enabledBy] === false
      if (entry.row) entry.row.setAttribute('data-disabled', disabled ? '1' : '0')
      if (entry.input) entry.input.disabled = disabled
    })
  }

  /** 把一个值写进控件（首渲染与「恢复默认」共用）。 */
  function setControlValue(key, value) {
    var entry = settingsByKey[key]
    if (!entry) return
    if (entry.spec.kind === 'switch') {
      entry.input.setAttribute('aria-checked', value === true ? 'true' : 'false')
      return
    }
    if (entry.spec.kind === 'seg') {
      entry.seg.setAttribute('data-value', value === undefined || value === null ? '' : String(value))
      paintSegPill(entry)
      return
    }
    if (entry.spec.kind === 'model') {
      // 按钮文字与列表勾选都跟着 settingsLive 走
      paintModelPick(entry)
      repaintModelMenu(entry)
      return
    }
    // 配置单位 → 显示单位（时间统一按秒显示，见 SettingSpec.scale）
    var shown = value
    var scale = entry.spec.scale || 1
    if (scale !== 1 && typeof value === 'number' && isFinite(value)) shown = value / scale
    entry.input.value = shown === undefined || shown === null ? '' : String(shown)
  }

  /**
   * 分段控件的滑块：量当前选中格的位置再摆。
   *
   * 格子是**隐藏时量不到宽度**的（display:none 的父节点里 offsetWidth 是 0），
   * 所以切页之后要重摆一次（见 showSettingsTab）。
   */
  function paintSegPill(entry) {
    if (!entry.seg || !entry.pill) return
    var value = entry.seg.getAttribute('data-value')
    var on = null
    for (var i = 0; i < entry.cells.length; i += 1) {
      var picked = entry.cells[i].getAttribute('data-value') === value
      entry.cells[i].setAttribute('aria-checked', picked ? 'true' : 'false')
      if (picked) on = entry.cells[i]
    }
    // 值不在四格里（小窗选了模型自己的 medium/xhigh 这种）：一个格子都不点亮、
    // 滑块也收起来 —— 留着上一次的位置会假装它还选中着
    if (!on) {
      entry.pill.style.display = 'none'
      return
    }
    entry.pill.style.display = ''
    entry.pill.style.left = String(on.offsetLeft) + 'px'
    entry.pill.style.width = String(on.offsetWidth) + 'px'
  }

  /** 一行设置（按 spec.kind 造对应控件）。 */
  function buildSettingRow(spec) {
    var row = el('div', 'dsh-sel-srow')
    var lab = el('div', 'dsh-sel-srowlab')
    lab.appendChild(el('div', 'dsh-sel-srowt', spec.label))
    if (spec.hint) lab.appendChild(el('div', 'dsh-sel-srowd', spec.hint))
    if (spec.kind === 'model') lab.style.display = 'none'
    var ctl = el('div', 'dsh-sel-srowctl')
    row.appendChild(lab)
    row.appendChild(ctl)

    if (spec.kind === 'model') {
      // 模型选择：一个下拉同时定 provider + model（见 settings.ts 的 keys）。
      // 直接列 host 已有的模型清单 —— 用户不必记住 provider id 与 model id 怎么拼。
      row.setAttribute('data-wide', '1')
      var pick = el('button', 'dsh-sel-spick')
      pick.type = 'button'
      pick.setAttribute('aria-label', spec.label)
      pick.setAttribute('aria-haspopup', 'listbox')
      pick.setAttribute('aria-expanded', 'false')
      var pickName = el('span', 'dsh-sel-spickname', '跟随主会话')
      pick.appendChild(pickName)
      pick.appendChild(el('span', 'dsh-sel-spickcaret', '▾'))
      // 菜单挂到**抽屉**上（不是行里）：行在 overflow:auto 的滚动区里，浮层会被裁掉
      var pickMenu = el('div', 'dsh-sel-spickmenu')
      pickMenu.setAttribute('data-open', '0')
      pickMenu.setAttribute('role', 'listbox')
      pickMenu.setAttribute('aria-label', spec.label)
      var pickList = el('div', 'dsh-sel-spicklist')
      pickMenu.appendChild(el('div', 'dsh-sel-spickgroup', '模型'))
      pickMenu.appendChild(pickList)
      env.settingsSheet.appendChild(pickMenu)
      settingsMenus.push(pickMenu)
      var entryModel = {
        spec: spec, row: row, button: pick, label: pickName,
        list: pickList, menu: pickMenu, filled: false, catalog: null, rows: [],
      }
      listen(pick, 'click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        toggleModelMenu(entryModel)
      })
      ctl.appendChild(pick)
      settingsByKey[spec.key] = entryModel
      // 拉清单 + 取本行当前值，并按**本小窗所属会话**画按钮文字。
      // 开抽屉时还会再跑一遍（见 openSettings），轮询也会持续刷新。
      refreshModelRow(entryModel, false)
      return row
    }

    if (spec.kind === 'switch') {
      var sw = el('button', 'dsh-sel-sws')
      sw.type = 'button'
      sw.setAttribute('role', 'switch')
      sw.setAttribute('aria-label', spec.label)
      sw.setAttribute('aria-checked', 'false')
      listen(sw, 'click', function () {
        var on = sw.getAttribute('aria-checked') === 'true'
        sw.setAttribute('aria-checked', on ? 'false' : 'true')
        settingsLive[spec.key] = !on
        updateSettingDependencies()
        renderSettingsNote('')
        scheduleSettingsSave()
      })
      ctl.appendChild(sw)
      settingsByKey[spec.key] = { spec: spec, row: row, input: sw }
      return row
    }

    if (spec.kind === 'seg') {
      var seg = el('span', 'dsh-sel-seg')
      seg.setAttribute('role', 'radiogroup')
      seg.setAttribute('aria-label', spec.label)
      seg.setAttribute('data-value', '')
      var pill = el('span', 'dsh-sel-segpill')
      seg.appendChild(pill)
      var entry = { spec: spec, row: row, seg: seg, pill: pill, cells: [] }
      var options = spec.options || []
      options.forEach(function (option) {
        var cell = el('button', 'dsh-sel-segcell', SLOT_LABEL[option] || option)
        cell.type = 'button'
        cell.setAttribute('role', 'radio')
        cell.setAttribute('data-value', option)
        cell.setAttribute('aria-checked', 'false')
        listen(cell, 'click', function () {
          seg.setAttribute('data-value', option)
          paintSegPill(entry)
          settingsLive[spec.key] = option
          // 与小窗那个控件共用同一个写入口（同一份数据：配置里的 chatReasoningEffort）
          if (spec.key === 'chatReasoningEffort') { setChatSlot(option); env.paintModelPill() }
          renderSettingsNote('')
          scheduleSettingsSave()
        })
        seg.appendChild(cell)
        entry.cells.push(cell)
      })
      ctl.appendChild(seg)
      settingsByKey[spec.key] = entry
      settingsSegs.push(entry)
      return row
    }

    var input = el(spec.key === 'toolNames' ? 'textarea' : 'input', spec.kind === 'number' ? 'dsh-sel-snum' : 'dsh-sel-stext')
    if (spec.key === 'toolNames') input.setAttribute('rows', '2')
    var numScale = spec.scale || 1
    if (spec.kind === 'number') {
      input.setAttribute('type', 'number')
      // 边界按**显示单位**给（配置里是毫秒，界面按秒），换算只在这一处做
      if (spec.min !== undefined) input.setAttribute('min', String(spec.min / numScale))
      if (spec.max !== undefined) input.setAttribute('max', String(spec.max / numScale))
      if (spec.step !== undefined) input.setAttribute('step', String(spec.step / numScale))
    } else {
      input.setAttribute('type', 'text')
      // 宽文本行必须让输入框独占一行，否则值会被裁掉（抽屉是嵌在小窗里的窄容器）
      row.setAttribute('data-wide', '1')
      if (spec.placeholder) input.setAttribute('placeholder', spec.placeholder)
    }
    input.setAttribute('aria-label', spec.label)
    listen(input, 'input', function () {
      if (spec.kind === 'number') {
        // 空串（用户正在清空重打）先记成 undefined，别把 NaN 送去 host
        var text = String(input.value || '').trim()
        // 显示单位 → 配置单位（秒 → 毫秒）；取整避免 5.000000000001 这种浮点尾巴
        settingsLive[spec.key] = text === '' ? undefined
          : (numScale === 1 ? Number(text) : Math.round(Number(text) * numScale))
      } else {
        settingsLive[spec.key] = input.value
      }
      renderSettingsNote('')
      scheduleSettingsSave()
    })
    // 数字框失焦时把值夹回边界再回显：否则界面上留着用户敲的越界数，
    // 而真正生效的是 host 夹过的值，两边对不上（用户会以为没保存成功）
    listen(input, 'blur', function () {
      if (spec.kind !== 'number') return
      var text = String(input.value || '').trim()
      if (text === '') return
      var num = Number(text)
      if (!isFinite(num)) return
      var min = spec.min === undefined ? -Infinity : spec.min / numScale
      var max = spec.max === undefined ? Infinity : spec.max / numScale
      var fixed = Math.min(max, Math.max(min, num))
      input.value = String(fixed)
      settingsLive[spec.key] = numScale === 1 ? fixed : Math.round(fixed * numScale)
      renderSettingsNote('')
      scheduleSettingsSave()
    })
    ctl.appendChild(input)
    if (spec.unit) ctl.appendChild(el('span', 'dsh-sel-sunit', spec.unit))
    settingsByKey[spec.key] = { spec: spec, row: row, input: input }
    return row
  }

  /** 按 spec 画整页（拿到 spec 后调用一次）。 */
  function renderSettings(spec, values) {
    settingsSpec = spec
    settingsByKey = {}
    settingsRailButtons = []
    settingsPanes = []
    settingsSegs = []
    settingsEffortHints = []
    for (var m = 0; m < settingsMenus.length; m += 1) {
      if (settingsMenus[m].parentNode) settingsMenus[m].parentNode.removeChild(settingsMenus[m])
    }
    settingsMenus = []
    clearNode(env.settingsRail)
    clearNode(env.settingsBody)
    var groups = spec.groups || []
    groups.forEach(function (group, index) {
      var railBtn = el('button', 'dsh-sel-railbtn', group.label)
      railBtn.type = 'button'
      railBtn.setAttribute('role', 'tab')
      railBtn.setAttribute('data-tab', group.id)
      railBtn.setAttribute('aria-current', index === 0 ? 'true' : 'false')
      listen(railBtn, 'click', function () { showSettingsTab(group.id) })
      env.settingsRail.appendChild(railBtn)
      settingsRailButtons.push({ id: group.id, node: railBtn })

      var section = el('section', 'dsh-sel-grp')
      section.setAttribute('data-pane', group.id)
      var parts = group.sections || [{ label: group.label, keys: group.items.map(function (item) { return item.key }) }]
      parts.forEach(function (part) {
        var block = el('section', 'dsh-sel-ssection')
        block.appendChild(el('h3', 'dsh-sel-ssectionh', part.label))
        if (part.hint) block.appendChild(el('p', 'dsh-sel-ssectionhint', part.hint))
        part.keys.forEach(function (key) {
          var item = group.items.find(function (candidate) { return candidate.key === key })
          if (item) block.appendChild(buildSettingRow(item))
        })
        if (part.note) block.appendChild(el('p', 'dsh-sel-ssectionnote', part.note))
        // 「思考强度」那一节多一行：这四个格子**现在**落到当前模型的哪些档位上。
        // 映射由 host 按模型声明实时算（换模型 / DSH 升级换 adapter 都会跟着变）。
        if (part.keys.indexOf('chatReasoningEffort') >= 0) {
          var effortHint = el('p', 'dsh-sel-ssectionnote dsh-sel-effortmap', '')
          effortHint.setAttribute('data-effortmap', '1')
          block.appendChild(effortHint)
          settingsEffortHints.push(effortHint)
        }
        section.appendChild(block)
      })
      env.settingsBody.appendChild(section)
      settingsPanes.push({ id: group.id, node: section })
    })
    Object.keys(values || {}).forEach(function (key) {
      setControlValue(key, values[key])
    })
    updateSettingDependencies()
    syncComposerModel()
    applySelectionLimit(values)
    paintEffortMapHint()
    showSettingsTab(groups.length ? groups[0].id : '')
  }

  function showSettingsTab(id) {
    var i
    for (i = 0; i < settingsRailButtons.length; i += 1) {
      settingsRailButtons[i].node.setAttribute('aria-current', settingsRailButtons[i].id === id ? 'true' : 'false')
    }
    for (i = 0; i < settingsPanes.length; i += 1) {
      settingsPanes[i].node.style.display = settingsPanes[i].id === id ? '' : 'none'
    }
    env.settingsBody.scrollTop = 0
    closeModelPicks() // 切分类时把模型下拉收掉（浮层挂在抽屉上，不跟着分类走）
    // 隐藏时量不到 offsetWidth，切页后重摆一次滑块（否则滑块停在 0 宽）
    for (i = 0; i < settingsSegs.length; i += 1) {
      if (settingsSegs[i].seg.offsetParent !== null) paintSegPill(settingsSegs[i])
    }
  }

  /** 拉一次 spec + 当前值。失败就在正文里给出说明（重开抽屉即可重试）。 */
  function loadSettings(force) {
    if (settingsFetching) return
    if (settingsSpec && !force) return
    settingsFetching = true
    fetch(SETTINGS, { headers: { accept: 'application/json' } })
      .then(function (response) { return response.json() })
      .then(function (payload) {
        settingsFetching = false
        if (!payload || payload.ok === false || !payload.groups) {
          throw new Error((payload && payload.error) || '设置读取失败')
        }
        var pending = settingsSpec ? {} : Object.assign({}, settingsLive)
        settingsSaved = Object.assign({}, payload.values || {})
        settingsLive = Object.assign({}, payload.values || {}, pending)
        renderSettings({ groups: payload.groups }, settingsLive)
        renderSettingsNote('')
        if (settingsDirtyCount() > 0) scheduleSettingsSave()
      })
      .catch(function (error) {
        settingsFetching = false
        clearNode(env.settingsBody)
        env.settingsBody.appendChild(el('div', 'dsh-sel-sempty',
          '设置读取失败：' + String((error && error.message) || error) + '（点「关闭」后重开可重试）'))
      })
  }

  /**
   * 保存（防抖 400ms）。
   *
   * 只发改过的键：补丁越小，越不容易和"另一个窗口同时改了别的项"撞车
   * （host 侧是**合并**而不是覆盖，两者配合才不会互相抹掉）。
   */
  function scheduleSettingsSave() {
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
    settingsSaveTimer = setTimeout(function () {
      settingsSaveTimer = 0
      flushSettingsSave()
    }, 400)
  }

  function flushSettingsSave() {
    if (settingsSaving || settingsResetting || !settingsSpec) return settingsSaveRequest
    var patch = {}
    Object.keys(settingsLive).forEach(function (key) {
      var value = settingsLive[key]
      if (value === undefined) return
      if (settingsSaved[key] === value) return
      patch[key] = value
    })
    if (Object.keys(patch).length === 0) {
      renderSettingsNote('')
      return
    }
    var seq = ++settingsSaveSeq
    var sent = Object.assign({}, settingsLive)
    var accepted = false
    settingsSaving = true
    renderSettingsNote('saving')
    settingsSaveRequest = fetch(SETTINGS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: patch }),
    })
      .then(function (response) { return response.json() })
      .then(function (payload) {
        if (seq !== settingsSaveSeq) return // 有更新的保存在路上，别用旧结果覆盖
        if (!payload || payload.ok === false) throw new Error((payload && payload.error) || '保存失败')
        // 以 host 归一后的值为准（clamp 过的数字要和界面显示一致）
        applyServerValues(payload.values, sent)
        // 胶囊偏好立刻生效（不等下次刷新）—— 设置页承诺"即时生效"
        if (Object.prototype.hasOwnProperty.call(patch, 'pillEnabled') ||
            Object.prototype.hasOwnProperty.call(patch, 'pillIdleMs')) {
          applyPillPrefs({ enabled: settingsLive.pillEnabled, idleMs: settingsLive.pillIdleMs })
        }
        if (Array.isArray(payload.rejected) && payload.rejected.length > 0) {
          // 有字段被拒：只提示、不回滚 —— 同一批里其它字段已经生效了
          env.settingsNote.setAttribute('data-dirty', '1')
          env.settingsNoteText.textContent = '有 ' + String(payload.rejected.length) + ' 项未接受'
          return
        }
        accepted = true
        renderSettingsNote('')
      })
      .catch(function () {
        if (seq !== settingsSaveSeq) return
        renderSettingsNote('error')
      })
      .finally(function () {
        settingsSaving = false
        if (accepted && !settingsResetting && settingsDirtyCount() > 0 && settingsSaveSeq === seq) scheduleSettingsSave()
      })
    return settingsSaveRequest
  }

  /**
   * 把胶囊的两个偏好落到界面上。
   *
   * ping（启动时）与设置保存后**都走这里** —— 设置页写着"即时生效"，
   * 如果只在启动时读一次，用户关掉胶囊后要刷新页面才见效，那就是假承诺。
   */
  function applyPillPrefs(prefs) {
    if (!prefs) return
    var idle = Number(prefs.idleMs)
    if (isFinite(idle) && idle >= 2000) preferences.pillIdleMs = idle
    if (prefs.enabled === false) {
      env.pillHidden = true
      env.pill.style.display = 'none'
    } else if (prefs.enabled === true) {
      env.pillHidden = false
      env.pill.style.display = ''
      env.placePill()
    }
    if (env.pillHidden) {
      if (env.pillIdleId) clearTimeout(env.pillIdleId)
      env.pillIdleId = 0
    } else {
      env.schedulePillIdle()
    }
  }

  /** 轮询句柄（抽屉和小窗都收了必须清掉，不然会一直打接口）。 */
  var routeWatchTimer = 0

  /** 轮询间隔：够快看得出"实时"，又不至于把接口打爆（这条接口只做一次会话解析，很轻）。 */
  var ROUTE_WATCH_MS = 2000

  /**
   * 盯着"当前会话在用的模型"。
   *
   * 主会话里随时可以换模型，而插件这边**没有**可订阅的变更事件（模型选择是会话侧的），
   * 所以只能轮询那条轻量 /route：值一变就把「跟随主会话（当前：…）」和输入框那枚胶囊改掉。
   *
   * **小窗开着就要盯，不只是抽屉开着**：跟随态下输入框那枚胶囊报的就是这个值 ——
   * 以前只在抽屉开着时轮询，于是"小窗开着、主会话换了模型"要等下一次开/关设置页才更新
   * （用户报的"没有及时刷新"）。抽屉和小窗都收起来即停。
   */
  function startRouteWatch() {
    stopRouteWatch()
    routeWatchTimer = setInterval(function () {
      if (!settingsOpen && !env.panelOpen) { stopRouteWatch(); return }
      // 选了具体模型：胶囊与括号显示的都不是"跟随"的值，不必再问
      if (env.state.modelChoice) return
      fetchRoute(env.panelSessionId || env.currentSessionId(), false).then(applyFollowRoute)
    }, ROUTE_WATCH_MS)
  }

  function stopRouteWatch() {
    if (routeWatchTimer) {
      clearInterval(routeWatchTimer)
      routeWatchTimer = 0
    }
  }

  /** 抽屉或小窗还开着就继续轮询；两个都收了才停（开着时重复调用不重启计时）。 */
  function syncRouteWatch() {
    if (!settingsOpen && !env.panelOpen) { stopRouteWatch(); return }
    if (routeWatchTimer) return
    startRouteWatch()
  }

  /** 先对齐一次"跟随"的值（开窗/开抽屉那一刻，不等第一拍轮询）。 */
  function refreshFollowRoute() {
    if (env.state.modelChoice) return
    fetchRoute(env.panelSessionId || env.currentSessionId(), false).then(applyFollowRoute)
  }

  function openSettings() {
    if (settingsOpen) return
    settingsOpen = true
    // 抽屉贴着面板（inset:0），所以给面板一个合适的尺寸下限 —— 否则内容短时抽屉被压成一条
    env.panel.setAttribute('data-settings', '1')
    env.settingsSheet.setAttribute('data-open', '1')
    env.settingsScrim.setAttribute('data-open', '1')
    env.settingsButton.setAttribute('aria-pressed', 'true')
    loadSettings(false)
    settingsSegs.forEach(function (entry) { paintSegPill(entry) })
    // 每次开抽屉都重取一次模型（强制，绕过缓存）：
    // 会话换了、或主会话中途换了模型，括号里的名字都要跟着变。
    refreshModelRow(settingsByKey.modelChoice, true)
    syncRouteWatch()
  }

  function closeSettings() {
    if (!settingsOpen) return
    settingsOpen = false
    env.panel.removeAttribute('data-settings')
    closeModelPicks()
    env.settingsSheet.setAttribute('data-open', '0')
    env.settingsScrim.setAttribute('data-open', '0')
    env.settingsButton.setAttribute('aria-pressed', 'false')
    // 关抽屉前把还没落盘的改动补发一次，别让"关掉就走"丢掉刚改的值
    if (settingsSaveTimer) {
      clearTimeout(settingsSaveTimer)
      settingsSaveTimer = 0
      flushSettingsSave()
    }
    // 小窗还开着就继续盯（跟随态下输入框那枚胶囊还指着会话的模型）
    syncRouteWatch()
  }

  function resetSettings() {
    if (settingsResetting) return
    settingsResetting = true
    if (settingsSaveTimer) { clearTimeout(settingsSaveTimer); settingsSaveTimer = 0 }
    var sent
    renderSettingsNote('saving')
    // 等正在保存的请求结束再恢复，避免晚到的保存把默认值覆盖掉。
    Promise.resolve(settingsSaveRequest).then(function () {
      sent = Object.assign({}, settingsLive)
      return fetch(SETTINGS, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      })
    }).then(function (response) { return response.json() })
      .then(function (payload) {
        if (!payload || payload.ok === false) throw new Error('恢复默认失败')
        applyServerValues(payload.values, sent)
        env.state.effort = settingsLive.chatReasoningEffort || ''
        applyPillPrefs({ enabled: settingsLive.pillEnabled, idleMs: settingsLive.pillIdleMs })
        env.bridgeOn = settingsLive.bridgeSidebarPreview !== false
        if (env.bridgeOn) env.scheduleBridgeScan()
        refreshModelRow(settingsByKey.modelChoice, true)
        env.paintModelPill()
        renderSettingsNote('')
      })
      .catch(function () { renderSettingsNote('error') })
      .finally(function () {
        settingsResetting = false
        if (settingsDirtyCount() > 0 && env.settingsNoteText.textContent !== '保存失败，改动未生效') scheduleSettingsSave()
      })
  }
  return {
    loadSettings,
    get settingsSpec() { return settingsSpec },
    set settingsSpec(value) { settingsSpec = value },
    applySelectionLimit,
    applyPillPrefs,
    get settingsOpen() { return settingsOpen },
    set settingsOpen(value) { settingsOpen = value },
    get settingsByKey() { return settingsByKey },
    set settingsByKey(value) { settingsByKey = value },
    closeModelPicks,
    closeSettings,
    openSettings,
    resetSettings,
    get settingsLive() { return settingsLive },
    set settingsLive(value) { settingsLive = value },
    refreshFollowRoute,
    syncRouteWatch,
    paintEffortMapHint,
    chooseSharedModel,
    chatSlot,
    get SLOT_ORDER() { return SLOT_ORDER },
    set SLOT_ORDER(value) { SLOT_ORDER = value },
    get SLOT_LABEL() { return SLOT_LABEL },
    set SLOT_LABEL(value) { SLOT_LABEL = value },
    setChatSlot,
  }
}
