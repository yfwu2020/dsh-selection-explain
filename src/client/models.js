import { MODELS } from './constants.js'
import { el, listen } from './dom.js'

/** models state and operations; dependencies are supplied as live node/callback accessors. */
export function createModelsController(env) {

  // —— 悬浮状态胶囊：点一下回到最近一次小窗 ——
  // —— 模型 + 推理等级（追问档） ——
  var MODEL_KEY = 'dsh-selection-explain:model'
   // 存 "provider\tmodel"
  /** 四个格子的中文名（设置页与小窗共用一套词；`medium` 只在标注模型自己的档位时出现）。 */
  var TIER_LABEL = { off: '关', low: '低', medium: '中', high: '高', max: '最高' }

  /**
   * 模型清单缓存。
   *
   * `pending` 是**正在飞的那次请求**：并发调用必须共享它。
   * 以前 loading=true 时直接 `Promise.resolve(modelCatalog)` 把**当前还空着的**缓存返回，
   * 于是"菜单刚打开、设置页也来要清单"这种并发场景下，后到的那个拿到 0 个模型
   * （实测：设置页的模型下拉空着，只有一行「跟随主会话」）。
   */
  var modelCatalog = { at: 0, items: [], current: null, stages: null, loading: false, pending: null, error: '', leakyOff: [], sessionId: null }

  var modelCatalogRequestSeq = 0

  var modelPillClicks = 0

  var BAD_TIER_KEY = 'dsh-selection-explain:badTiers'

  function badTierKeyOf() {
    if (!env.state.modelChoice) return ''
    return env.state.modelChoice.provider + '/' + env.state.modelChoice.model
  }

  /** 记下"这个模型的这个档位被上游拒过"，用来在菜单里标出来。 */
  function rememberBadTier(tier, reason) {
    var key = badTierKeyOf()
    if (!key || !tier) return
    var all = {}
    try {
      all = JSON.parse(readStore(BAD_TIER_KEY, '{}')) || {}
    } catch (error) {
      all = {}
    }
    var list = all[key]
    if (!list || !list.length) list = []
    // 老格式是 ["max"]，新格式是 [{tier, reason}]；两种都认
    var found = false
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i]
      var id = typeof item === 'string' ? item : item && item.tier
      if (id === tier) {
        found = true
        if (typeof item === 'string') list[i] = { tier: tier, reason: reason || 'rejected' }
        else if (reason) item.reason = reason
      }
    }
    if (!found) list.push({ tier: tier, reason: reason || 'rejected' })
    all[key] = list
    writeStore(BAD_TIER_KEY, JSON.stringify(all))
  }

  /** 该模型哪些档位有问题 → { tier: reason }（菜单里标注，reason=rejected 不支持 / leak 会泄漏思考）。 */
  function badTiersOf() {
    var key = badTierKeyOf()
    var out = {}
    if (!key) return out
    try {
      var all = JSON.parse(readStore(BAD_TIER_KEY, '{}')) || {}
      var list = all[key]
      if (!Array.isArray(list)) return out
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i]
        if (typeof item === 'string') out[item] = 'rejected'
        else if (item && item.tier) out[item.tier] = item.reason || 'rejected'
      }
    } catch (error) {
      /* 坏了就当没有 */
    }
    return out
  }

  function readStore(key, fallback) {
    try {
      var value = window.localStorage ? window.localStorage.getItem(key) : null
      return value === null || value === undefined ? fallback : value
    } catch (error) {
      return fallback
    }
  }

  function writeStore(key, value) {
    try {
      if (window.localStorage) window.localStorage.setItem(key, value)
    } catch (error) {
      /* 无痕模式：只当次生效 */
    }
  }

  /** 档位显示名：优先用目录里声明的名字（Off/Low/High/Max），否则退回中文映射。 */
  function tierLabel(id) {
    if (!id) return ''
    // 按**当前在用**那个模型声明的档位取名（跟随态也算，见 effectiveItem）
    var item = effectiveItem()
    var efforts = (item && item.efforts) || []
    for (var j = 0; j < efforts.length; j += 1) {
      if (efforts[j].id === id) return TIER_LABEL[id] || efforts[j].name || id
    }
    return TIER_LABEL[id] || id
  }

  /**
   * 清单里按 **provider + model 两个键**找那一项。
   *
   * 两个键缺一不可：同一个 model id 在多个 provider 下是**不同模型、不同名字** ——
   * 实测 `deepseek-flash` 在 opencode-go 叫「DeepSeek Flash」、在 deepseek-official /
   * deepseek-account 叫「DeepSeek-V41-Flash」。只按 model 查会张冠李戴。
   */
  function catalogItemOf(provider, model) {
    var items = modelCatalog.items || []
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].provider === provider && items[i].model === model) return items[i]
    }
    return null
  }

  /**
   * 现在**实际在用**的那个模型：显式选过就是那个；没选过（跟随主会话）就是会话解析出来的
   * `modelCatalog.current`。
   *
   * 菜单里"哪一行打勾""档位按钮列哪几档""哪个模型关档会泄漏"都该按它算 ——
   * 这几处以前只认 `state.modelChoice`，跟随态于是**一行都不打勾**（用户报的
   * "模型列表上没有标示当前正在使用的模型"）。
   */
  function effectiveChoice() {
    if (env.state.modelChoice) return env.state.modelChoice
    if (modelCatalog.current && modelCatalog.current.provider && modelCatalog.current.model) {
      return { provider: String(modelCatalog.current.provider), model: String(modelCatalog.current.model) }
    }
    return null
  }

  /** 清单里当前在用的那一项（显式选的 / 跟随会话的）；清单里没有就返回 null。 */
  function effectiveItem() {
    var choice = effectiveChoice()
    return choice ? catalogItemOf(choice.provider, choice.model) : null
  }

  /** 胶囊文案：模型短名 + 当前档位。 */
  function paintModelPill() {
    var name = ''
    var provider = ''
    // 用户选定的那个模型：按 provider + model 换成清单里的显示名
    var chosen = env.state.modelChoice ? catalogItemOf(env.state.modelChoice.provider, env.state.modelChoice.model) : null
    if (chosen) {
      name = chosen.name || chosen.model
      provider = chosen.providerName || chosen.provider
    }
    if (!name && env.state.modelChoice) name = env.state.modelChoice.model
    // 跟随主会话：`current` 报的是 { provider, model } 两个 id，同样要换成显示名 ——
    // 直接显示裸 id 就会是 "deepseek-flash"，而主会话里那个模型叫「DeepSeek-V41-Flash」
    // （用户报的）。清单没加载出来时只能先显示 id，加载完会重画（见 warmModelCatalog）。
    if (!name && modelCatalog.current) {
      var followed = catalogItemOf(modelCatalog.current.provider, modelCatalog.current.model)
      name = (followed && (followed.name || followed.model)) || String(modelCatalog.current.model || '')
      provider = (followed && (followed.providerName || followed.provider)) || String(modelCatalog.current.provider || '')
    }
    if (!name) name = '模型'
    // 短名：去掉 provider 前缀那种很长的写法（"DeepSeek V4.1 Flash" → 保留原样，只截断）
    env.modelPillName.textContent = name.length > 22 ? name.slice(0, 21) + '…' : name
    var tier = env.state.effort || (modelCatalog.stages && modelCatalog.stages.chat) || ''
    env.modelPillTier.textContent = tier ? '· ' + tierLabel(tier) : ''
    env.modelPill.title = (provider ? provider + ' · ' : '') + name + (tier ? ' · 推理等级 ' + tierLabel(tier) : '') +
      '（模型与追问思考强度）'
    // 胶囊是"当前模型"的**唯一**统一落点：换模型的所有路径最后都会走到这里
    //（设置抽屉的模型下拉、小窗的模型菜单、跟随主会话时主界面换模型…），
    // 设置页那行"四格 → 真实档位"也在这里跟着重画 —— 早先只在 chooseSharedModel 里画，
    // 于是"从抽屉的下拉里换模型"那行纹丝不动（用户报的正是这个）。
    env.paintEffortMapHint()
  }

  /**
   * 顺手把模型清单拉起来（60 秒缓存）。
   *
   * 胶囊上的模型名要按 provider + model 从清单里换（见 paintModelPill）—— 清单没加载时
   * 只能显示裸 id（"deepseek-flash"），跟主会话里那个名字对不上。
   * 以前只有"打开模型菜单 / 开设置抽屉"才会拉清单，所以正常用下来胶囊一直是裸 id。
   */
  function warmModelCatalog() {
    loadModelCatalog(false, env.panelSessionId || env.currentSessionId()).then(function () { paintModelPill() })
  }

  /**
   * 拉模型清单（60 秒缓存）。
   *
   * 调用点：打开模型菜单 / 开设置抽屉（强制）/ **开窗（warmModelCatalog，为了胶囊上的显示名）**。
   * 不进 ping / analyze 那种每轮都走的热路径。
   */
  function loadModelCatalog(force, sessionId) {
    // 会话换了就得重取：`current` 是**按会话**解析的，沿用上一个会话的缓存
    // 会让「跟随主会话（当前：…）」报出别的会话在用的模型。
    // sessionId 由调用方给（小窗用它自己所属的会话，不是"当前正在看"的那个）。
    var sessionNow = sessionId === undefined ? env.panelOrCurrentSessionId() : sessionId
    var sameSession = modelCatalog.sessionId === sessionNow
    // 只复用同一会话的请求；A 的响应不能冒充刚切到的 B。
    if (sameSession && modelCatalog.loading && modelCatalog.pending) return modelCatalog.pending
    if (sameSession && !force && modelCatalog.items.length > 0 && Date.now() - modelCatalog.at < 60000) return Promise.resolve(modelCatalog)
    var requestSeq = ++modelCatalogRequestSeq
    if (!sameSession) {
      force = true
      modelCatalog.current = null
      modelCatalog.items = []
      modelCatalog.at = 0
    }
    modelCatalog.sessionId = sessionNow
    modelCatalog.loading = true
    // 带 sessionId：`current` 要按**当前会话**解析（否则括号里报的是全局默认，跟会话对不上）
    var modelQuery = []
    if (force) modelQuery.push('refresh=1')
    if (sessionNow) modelQuery.push('sessionId=' + encodeURIComponent(sessionNow))
    modelCatalog.pending = fetch(MODELS + (modelQuery.length ? '?' + modelQuery.join('&') : ''), { headers: { accept: 'application/json' } })
      .then(function (response) {
        return response.json()
      })
      .then(function (data) {
        return {
          sessionId: sessionNow,
          items: Array.isArray(data && data.models) ? data.models : [],
          current: (data && data.current) || null,
          stages: (data && data.stages) || null,
          error: String((data && data.error) || ''),
          leakyOff: Array.isArray(data && data.leakyOff) ? data.leakyOff : [],
          at: Date.now(), loading: false, pending: null,
        }
      })
      .catch(function (error) {
        return { sessionId: sessionNow, at: 0, items: [], current: null, stages: null,
          error: String((error && error.message) || error), leakyOff: [], loading: false, pending: null }
      })
      .then(function (result) {
        // 调用者得到自己的快照；较早的请求不得覆盖较新的会话缓存。
        if (requestSeq === modelCatalogRequestSeq) modelCatalog = result
        return result
      })
    return modelCatalog.pending
  }

  function renderModelMenu() {
    env.modelMenu.textContent = ''
    var items = modelCatalog.items || []
    var head = el('div', 'dsh-sel-pickergroup', '模型')
    env.modelMenu.appendChild(head)
    if (modelCatalog.loading) {
      env.modelMenu.appendChild(el('div', 'dsh-sel-pickerhint', '正在读取可用模型…'))
      return
    }
    if (items.length === 0) {
      env.modelMenu.appendChild(
        el('div', 'dsh-sel-pickerhint', modelCatalog.error ? '读取失败：' + modelCatalog.error : '没有取到可用模型清单'),
      )
    } else {
      var list = el('div', 'dsh-sel-pickerlist')
      // 打勾的是**当前在用**那个：显式选过就是它，跟随主会话时就是会话在用的那个
      var inUse = effectiveChoice()
      for (var i = 0; i < items.length; i += 1) {
        ;(function (item) {
          var on = !!inUse && item.provider === inUse.provider && item.model === inUse.model
          var row = el('button', 'dsh-sel-pickerrow')
          row.type = 'button'
          row.setAttribute('role', 'menuitemradio')
          row.setAttribute('data-on', on ? '1' : '0')
          row.title = (item.name || item.model) + ' · ' + (item.providerName || item.provider)
          row.appendChild(el('span', 'dsh-sel-pickercheck', on ? '✓' : ''))
          // 名字自己带省略号：一行里要塞下 勾 + 名字 + 「跟随」小标 + provider，
          // 长名字（"DeepSeek V4.1 Flash"）挤不下时**收窄名字**，别让整行折成两行。
          row.appendChild(el('span', 'dsh-sel-pickername', item.name || item.model))
          // 跟随态补一枚「跟随」小标：这个勾不是你选过，而是主会话正在用它 ——
          // 否则一个没点过的模型打着勾，会让人以为是自己选的。
          if (on && !env.state.modelChoice) {
            row.appendChild(el('span', 'dsh-sel-pickerfollow', '跟随'))
            row.title = '跟随主会话：主会话正在用这个模型 · ' + (item.providerName || item.provider)
          }
          row.appendChild(el('span', 'dsh-sel-pickerprov', item.providerName || item.provider))
          listen(row, 'click', function (event) {
            event.preventDefault()
            event.stopPropagation()
            env.chooseSharedModel({ provider: item.provider, model: item.model })
            paintModelPill()
            renderModelMenu()
            closeModelMenu()
            env.setStatus('模型已切到 ' + (item.name || item.model))
          })
          list.appendChild(row)
        })(items[i])
      }
      env.modelMenu.appendChild(list)
    }
    env.modelMenu.appendChild(el('div', 'dsh-sel-pickersplit'))
    env.modelMenu.appendChild(el('div', 'dsh-sel-pickergroup', '推理等级（追问档）'))
    var tiers = el('div', 'dsh-sel-tiers')
    /**
     * 档位按钮 = 与设置页**同一套四个格子**（关/低/高/最高）。
     *
     * 以前这里列的是"该模型自己声明的档位"（可能是 minimal/medium/xhigh 这种），于是
     * 两边词汇不同、还要把模型档位反向折回格子；现在两边同词同源：这里的选中值就是
     * 配置里的 `chatReasoningEffort`，改一边另一边跟着变，没有任何映射。
     * 格子落到模型哪个真实档位由 host 算（见设置页那行"当前模型：关 → …"）。
     */
    var tierItem = effectiveItem()
    var tierMap = (tierItem && tierItem.effortMap) || null
    var badTiers = badTiersOf()
    // host 在进程内学到的：这个模型"关"档会把思考写进正文
    var leaky = effectiveChoice()
    if (leaky && modelCatalog.leakyOff.indexOf(leaky.provider + '/' + leaky.model) >= 0) {
      badTiers = { ...badTiers, off: 'leak' }
    }
    var activeSlot = env.chatSlot()
    for (var t = 0; t < env.SLOT_ORDER.length; t += 1) {
      ;(function (slot) {
        // 这一格的落点（模型真实档位）：用来把"实测被拒/会泄漏"的标注对上来
        var target = (tierMap && tierMap[slot]) || slot
        var bad = badTiers[slot] || (target !== slot ? badTiers[target] : '')
        var button = el('button', 'dsh-sel-tierbtn', env.SLOT_LABEL[slot])
        button.type = 'button'
        button.setAttribute('data-on', slot === activeSlot ? '1' : '0')
        button.setAttribute('data-slot', slot)
        if (bad) {
          button.setAttribute('data-bad', '1')
          button.title =
            bad === 'leak'
              ? '实测该模型在这一档会把思考写进正文：已自动改用「低」档'
              : '实测该模型不支持这一档：选它会自动回退到默认档'
        }
        if (target !== slot) button.title = (button.title ? button.title + ' · ' : '') + '该模型发 ' + target
        listen(button, 'click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          // 唯一写入口：写的就是设置页那一行读的那个值
          env.setChatSlot(slot)
          paintModelPill()
          renderModelMenu()
          env.setStatus('追问档位：' + env.SLOT_LABEL[slot] + (target !== slot ? '（该模型发 ' + target + '）' : ''))
        })
        tiers.appendChild(button)
      })(env.SLOT_ORDER[t])
    }
    env.modelMenu.appendChild(tiers)
    env.modelMenu.appendChild(
      el('div', 'dsh-sel-pickerhint', '思考强度仅影响追问。'),
    )
  }

  function closeModelMenu() {
    env.modelMenu.setAttribute('data-open', '0')
    env.modelMenu.removeAttribute('role')
    env.modelPill.setAttribute('aria-expanded', 'false')
  }

  function openModelMenu() {
    env.modelMenu.setAttribute('data-open', '1')
    env.modelMenu.setAttribute('role', 'menu')
    env.modelPill.setAttribute('aria-expanded', 'true')
    renderModelMenu()
    loadModelCatalog(false).then(function () {
      if (env.modelMenu.getAttribute('data-open') === '1') {
        renderModelMenu()
        paintModelPill()
      }
    })
  }

  // —— 网页模式开关 ——
  var WEB_MODE_KEY = 'dsh-selection-explain:webAnswer'

  function readWebMode() {
    try {
      return window.localStorage && window.localStorage.getItem(WEB_MODE_KEY) === '1'
    } catch (error) {
      return false
    }
  }

  function paintWebMode() {
    var on = env.state.webAnswer === true
    env.webMode.setAttribute('data-on', on ? '1' : '0')
    // 两格各自报自己的选中态（radiogroup 语义）；药丸靠 data-on 滑过去
    env.cellMd.setAttribute('aria-checked', on ? 'false' : 'true')
    env.cellWeb.setAttribute('aria-checked', on ? 'true' : 'false')
    env.cellMd.title = '输出偏好：Markdown —— 默认用文字回答，必要时仍可用网页'
    env.cellWeb.title = '输出偏好：网页 —— 复杂问题用 HTML 页面讲清楚，简单问题仍直接文字回答'
  }

  /** 设置档位（点格子 / 快捷键都走这里）。 */
  function setPref(on, focus) {
    env.state.webAnswer = on === true
    try {
      if (window.localStorage) window.localStorage.setItem(WEB_MODE_KEY, env.state.webAnswer ? '1' : '0')
    } catch (error) {
      /* 无痕模式等场景：只当次生效 */
    }
    paintWebMode()
    if (focus) (env.state.webAnswer ? env.cellWeb : env.cellMd).focus()
    env.setStatus(env.state.webAnswer ? '输出偏好：网页' : '输出偏好：Markdown')
    return env.state.webAnswer
  }
  return {
    closeModelMenu,
    get modelPillClicks() { return modelPillClicks },
    set modelPillClicks(value) { modelPillClicks = value },
    openModelMenu,
    readWebMode,
    paintWebMode,
    paintModelPill,
    get modelCatalog() { return modelCatalog },
    set modelCatalog(value) { modelCatalog = value },
    setPref,
    loadModelCatalog,
    renderModelMenu,
    catalogItemOf,
    warmModelCatalog,
    rememberBadTier,
  }
}
