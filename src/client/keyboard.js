export function handleVoiceCardEscape(event, env) {
    if (event.key !== 'Escape' || !env.vcardState.open || event.defaultPrevented) return
    if (env.document.querySelector('[role="dialog"][aria-modal="true"]')) return
    event.preventDefault()
    event.stopPropagation()
    env.vcardState.suppress = true
    env.closeVCard(true)
  }

export function handlePanelEscape(event, env) {
    if (event.key !== 'Escape' || !env.panelOpen || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    // 官方模态浮层的 Esc 在冒泡阶段处理；capture 不消费，先让官方设置等浮层退出。
    // 插件面板和设置抽屉是非模态 dialog，不带 aria-modal，不会命中这里。
    if (env.document.querySelector('[role="dialog"][aria-modal="true"]')) return
    // 完整视图记录最后点击/操作的小窗；不能只看可能停在另一窗的键盘焦点。
    var fullViewFrame = env.document.querySelector('[data-dsh-full-view]')
    if (fullViewFrame) {
      var escapeTarget = event.target
      var canFindEscapeOwner = escapeTarget && typeof escapeTarget.closest === 'function'
      var expandedChatSelector = '[data-dsh-floating-chat]:not([data-dsh-chat-minimized]):not([data-dsh-chat-hidden])'
      var activeFloatingWindow = fullViewFrame.getAttribute('data-dsh-active-floating-window')
      if (activeFloatingWindow === 'chat' && env.document.querySelector(expandedChatSelector)) return
      // 与旧版完整视图共存时仍保留原来的键盘焦点判断。
      if (activeFloatingWindow === null && canFindEscapeOwner && escapeTarget.closest(expandedChatSelector)) return
      // 宿主菜单可能挂在聊天外；让它先消费 Esc，不连带关闭解读。
      if (!env.panel.contains(escapeTarget) && !env.historyList.contains(escapeTarget) && canFindEscapeOwner && escapeTarget.closest('[role="menu"], [role="listbox"], [data-trigger-menu]')) return
    }
    // Esc 分三级：**从最内层往外退**，一次只退一层（用户按一次不该连关两层）。
    //   ① 设置抽屉开着 → 只收抽屉，小窗留着（用户多半只是改完想接着看解读）；
    //   ② 语音进行中（录音行还在）→ 只取消这一次语音（等价于点 ✕，已经说出来的字留着）；
    //   ③ 其余情况 → 关掉小窗（一次到位，不受"有没有追问过"限制）。
    // 以前是一律关窗：正在说一句话时按 Esc 想放弃这句话，结果整个小窗没了。
    if (env.settingsOpen) {
      event.preventDefault()
      event.stopPropagation()
      // 抽屉里还开着模型下拉时，Esc 先收下拉 —— 一次只退最内层
      var anyPickOpen = Object.keys(env.settingsByKey).some(function (key) {
        var entry = env.settingsByKey[key]
        return !!(entry && entry.menu && entry.menu.getAttribute('data-open') === '1')
      })
      if (anyPickOpen) env.closeModelPicks()
      else env.closeSettings()
      return
    }
    if (env.captureRow.getAttribute('data-show') === '1') {
      event.preventDefault()
      event.stopPropagation()
      env.cancelVoice()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    env.closePanel()
  }
