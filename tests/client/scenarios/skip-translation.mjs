/**
 * 「跳过翻译、直接追问」那条路的**回放**回归。
 *
 * 用户实测（2026-10-19）：语音卡那条路（选中文字 + 输入法语音 → 直接追问）当场是不画翻译节的，
 * 可同一段对话下次再开出来（重新划同一个词 / 点「最近」）时，那张「翻译 /（这次没有返回内容）」
 * 的空卡片又冒出来了。
 *
 * 根因：翻译节的显隐只读 `state.skipInterpretation` 这一个**内存标记** ——
 * 语音卡那条路开窗时把它置为 true，但历史条目里没有记"这段对话没有解读"，
 * 回放（applyHistoryEntry）时标记落回 false，paint() 就照常画了一个空翻译节。
 *
 * 这一节盯三件事：
 *   ① 语音卡那条路当场不画翻译节，且落盘时记下 skipped: true；
 *   ② 回放同一条目仍然不画（这就是用户报的那张卡片）；
 *   ③ 反向：回放一段**有**解读的对话时翻译节照常画 —— 标记不能被上一段带过来。
 */
export async function run(env) {

  const find = (cls) =>
    Array.from(env.walk(env.floatingLayer)).find(
      (n) => n.className === cls || (n.getAttribute && n.getAttribute('class') === cls),
    )
  const secOf = (key) => env.sections.find((node) => node.getAttribute('data-sec') === key)
  const translationDisplay = () => String(secOf('translation') && secOf('translation').style.display)

  /** 等一个条件成立（返回是否成立）；不成立时靠断言把事实说清楚。 */
  const waitFor = async (label, ok, tries = 120) => {
    for (let i = 0; i < tries; i += 1) {
      if (ok()) return true
      await env.sleep(50)
    }
    return ok()
  }

  const IME = [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }]
  const recording = { ok: true, available: true, capturing: true, processes: IME, reason: '' }
  const stopped = { ok: true, available: true, capturing: false, processes: [], reason: '' }

  env.windowStub.getSelection = () => env.selection
  env.settingsStub.value = { voiceCancelOnSilence: false, voiceAutoSend: false }
  env.hook.reloadSettings()
  env.hook.close()
  await env.sleep(40)
  env.documentStub.activeElement = env.body

  // ── ① 语音卡直接追问：这段对话没有解读 ──
  // 弹卡有个抑制标记（同一段录音里只弹一次），它只在"浮标亮着、且探针报没人在录"那一拍复位。
  // 所以先带着**没在录**的探针亮出浮标跑一拍，再开麦 —— 否则会撞上上一节用例留下的抑制。
  env.micStub.value = stopped
  env.documentStub.dispatch('mouseup', { target: env.body })
  await env.sleep(340)
  env.micStub.value = recording
  await env.sleep(400)
  if (env.hook.voiceCard().open !== true) env.hook.voiceCardOpen()
  await env.sleep(60)
  const box = find('dsh-sel-vcard-box')
  const sendBtn = find('dsh-sel-vcard-send')
  env.assert('（前提）语音卡弹出来了', env.hook.voiceCard().open === true, JSON.stringify(env.hook.voiceCard()))
  if (box) {
    box.value = '中文含义什么？'
    box.dispatch('input', { target: box, preventDefault() {}, stopPropagation() {} })
  }
  const savedBefore = env.historySaved.length
  env.documentStub.activeElement = box
  if (sendBtn) sendBtn.dispatch('click', { target: sendBtn, preventDefault() {}, stopPropagation() {} })
  await env.sleep(160)

  env.assert(
    '跳过翻译直接追问：那一刻翻译节整节不画（不是"画个空节、里面写这次没有返回内容"）',
    translationDisplay() === 'none',
    'display=' + JSON.stringify(translationDisplay()) + ' 节文本=' + JSON.stringify(env.textOf(secOf('translation')).slice(0, 40)),
  )

  const landed = await waitFor('这轮追问落盘', () => env.historySaved.length > savedBefore)
  env.assert('（前提）这轮追问结束并写进历史', landed, '新增条目=' + String(env.historySaved.length - savedBefore))
  const skipEntry = env.historySaved[env.historySaved.length - 1]
  env.assert(
    '历史条目记下了"这段对话没有解读"（skipped: true）',
    !!skipEntry && skipEntry.skipped === true,
    JSON.stringify(skipEntry && { skipped: skipEntry.skipped, parts: skipEntry.parts, turns: (skipEntry.turns || []).length }),
  )
  env.assert(
    '跳过解读的对话：这一轮结束时翻译节仍然不画',
    translationDisplay() === 'none',
    'display=' + JSON.stringify(translationDisplay()),
  )

  // ── ② 回放同一条目（清本地缓存 → 走 host 历史）：卡片不能又冒出来 ──
  const skipKey = String((skipEntry && skipEntry.key) || '')
  const skipParts = skipKey.split('\u0000')
  env.hook.close()
  await env.sleep(30)
  env.hook.forget()
  env.documentStub.activeElement = env.body
  env.hook.open(skipParts[0], skipParts[1], (skipEntry && skipEntry.label) || '页面内容', skipParts[1])
  const replayed = await waitFor('历史回放生效', () => env.hook.state().cache === 'history')
  await env.sleep(80)
  env.assert(
    '（前提）走的是历史回放（不是重新请求）',
    replayed && env.hook.state().cache === 'history',
    JSON.stringify({ cache: env.hook.state().cache, phase: env.hook.state().phase }),
  )
  env.assert(
    '回放"跳过翻译直接追问"的对话：翻译节仍然整节不画（用户报的就是这张卡片又冒出来）',
    translationDisplay() === 'none',
    'display=' + JSON.stringify(translationDisplay()) + ' 节文本=' + JSON.stringify(env.textOf(secOf('translation')).slice(0, 40)),
  )
  env.assert(
    '（对照）这段对话本身照常还原（不是整段被藏掉了）',
    env.hook.turns().filter((turn) => turn.hidden !== true).length > 0,
    '可见轮次=' + String(env.hook.turns().filter((turn) => turn.hidden !== true).length),
  )
  env.assert(
    '（对照）追问输入框照常可用（这段对话要继续问得下去）',
    env.askRow.style.display !== 'none',
    'display=' + JSON.stringify(env.askRow.style.display),
  )

  // ── ②b 老条目（没有 skipped 这个键）也要兜住 ──
  //    用户磁盘里现存的那些"跳过翻译直接追问"的对话就是这个形状（skipped 是修复时才加的），
  //    不兜的话它们回放时照样会顶出一张空翻译卡片。
  {
    const legacyKey = 'skip-fix-legacy\u0000历史里的旧上下文'
    await env.browserFetch('/selection-explain/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: legacyKey,
        text: 'skip-fix-legacy',
        context: '历史里的旧上下文',
        label: '页面内容',
        parts: { translation: '', detail: '' },
        turns: [
          { role: 'user', text: '中文含义什么？' },
          { role: 'assistant', text: '这是老对话里的回答。' },
        ],
      }),
    })
    env.hook.close()
    await env.sleep(30)
    env.hook.forget()
    env.documentStub.activeElement = env.body
    env.hook.open('skip-fix-legacy', '历史里的旧上下文', '页面内容', '历史里的旧上下文')
    await waitFor('老条目回放生效', () => env.hook.state().cache === 'history')
    await env.sleep(80)
    env.assert(
      '老条目（没有 skipped 键）：没有解读 + 已经有追问 → 翻译节也不画（用户现存的历史就是这个形状）',
      translationDisplay() === 'none',
      'display=' + JSON.stringify(translationDisplay()) + ' 节文本=' + JSON.stringify(env.textOf(secOf('translation')).slice(0, 40)),
    )
    env.assert(
      '（对照）老条目里的对话照常画出来',
      env.hook.turns().filter((turn) => turn.hidden !== true).length === 2,
      '可见轮次=' + String(env.hook.turns().filter((turn) => turn.hidden !== true).length),
    )

    // 同一条兜底规则的另半边：老条目**有**翻译时，翻译节必须照旧画
    const legacyWithText = 'skip-fix-legacy-with-translation\u0000旧上下文'
    await env.browserFetch('/selection-explain/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: legacyWithText,
        text: 'skip-fix-legacy-with-translation',
        context: '旧上下文',
        label: '页面内容',
        parts: { translation: '旧对话的翻译', detail: '' },
        turns: [
          { role: 'user', text: '再解释一下' },
          { role: 'assistant', text: '这是回答。' },
        ],
      }),
    })
    env.hook.close()
    await env.sleep(30)
    env.hook.forget()
    env.documentStub.activeElement = env.body
    env.hook.open('skip-fix-legacy-with-translation', '旧上下文', '页面内容', '旧上下文')
    await waitFor('老条目（带翻译）回放生效', () => env.hook.state().cache === 'history')
    await env.sleep(80)
    env.assert(
      '老条目（没有 skipped 键）但有翻译：翻译节照常画（兜底规则不看错对象）',
      translationDisplay() !== 'none',
      'display=' + JSON.stringify(translationDisplay()) + ' 翻译=' + JSON.stringify((env.hook.parts().translation || '').slice(0, 20)),
    )

    // 已经被写坏的条目：skipped 显式 false，但翻译/详解全空、且已有追问。
    // 用户磁盘上那 14 条就是这个形状（旧版本读盘时把"缺失"抹成了 false）。
    // 这条必须靠 paint() 的**内容兜底**兜住，不能只靠 skipped 标记。
    const poisonedKey = 'skip-fix-poisoned\u0000被写坏的老上下文'
    await env.browserFetch('/selection-explain/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: poisonedKey,
        text: 'skip-fix-poisoned',
        context: '被写坏的老上下文',
        label: '页面内容',
        parts: { translation: '', detail: '' },
        turns: [
          { role: 'user', text: '中文含义什么？' },
          { role: 'assistant', text: '这是被写坏那条老对话的回答。' },
        ],
        skipped: false,
      }),
    })
    env.hook.close()
    await env.sleep(30)
    env.hook.forget()
    env.documentStub.activeElement = env.body
    env.hook.open('skip-fix-poisoned', '被写坏的老上下文', '页面内容', '被写坏的老上下文')
    await waitFor('被写坏条目回放生效', () => env.hook.state().cache === 'history')
    await env.sleep(80)
    env.assert(
      '被写成 skipped:false 的老条目（翻译空 + 有追问）也不画翻译节 —— 用户磁盘上那 14 条就靠这条兜',
      translationDisplay() === 'none',
      'display=' + JSON.stringify(translationDisplay()) + ' 节文本=' + JSON.stringify(env.textOf(secOf('translation')).slice(0, 40)),
    )
  }

  // ── ③ 反向：回放一段**有**解读的对话，翻译节必须照常画 ──
  //    （标记若按"上一次开窗"残留，这一段的翻译会被整节藏掉）
  env.hook.close()
  await env.sleep(30)
  env.hook.forget()
  env.documentStub.activeElement = env.body
  const normalBefore = env.historySaved.length
  env.hook.open('skip-fix-normal-probe', '普通解读的上下文片段', '页面内容')
  const translated = await waitFor(
    '普通解读出结果',
    () => env.hook.state().phase === 'done' && !!env.hook.parts().translation,
  )
  env.assert('（前提）普通解读那条路拿到了翻译', translated, JSON.stringify(env.hook.parts()))
  const normalLanded = await waitFor('普通解读落盘', () => env.historySaved.length > normalBefore)
  const normalEntry = env.historySaved[env.historySaved.length - 1]
  env.assert(
    '（前提）普通解读的条目没有被标成 skipped',
    normalLanded && !!normalEntry && normalEntry.skipped !== true,
    JSON.stringify(normalEntry && { skipped: normalEntry.skipped, parts: normalEntry.parts }),
  )

  const normalKey = String((normalEntry && normalEntry.key) || '')
  const normalParts = normalKey.split('\u0000')
  env.hook.close()
  await env.sleep(30)
  env.hook.forget()
  env.documentStub.activeElement = env.body
  env.hook.open(normalParts[0], normalParts[1], (normalEntry && normalEntry.label) || '页面内容', normalParts[1])
  await waitFor('普通条目回放生效', () => env.hook.state().cache === 'history')
  await env.sleep(80)
  env.assert(
    '反向：回放一段有解读的对话，翻译节照常画出来（"没有解读"的标记不会被上一段带过来）',
    translationDisplay() !== 'none' && !!env.hook.parts().translation,
    'display=' + JSON.stringify(translationDisplay()) + ' 翻译字数=' + String((env.hook.parts().translation || '').length),
  )

  // 收尾：麦克风 / 设置 / 面板都还原，别影响后面的用例
  env.micStub.value = stopped
  env.settingsStub.value = {}
  env.hook.reloadSettings()
  env.hook.close()
  await env.sleep(30)
}
