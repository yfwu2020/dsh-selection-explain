





export async function run(env) {


  // ────────── 拖拽上限 = 视口高度 − 8，不是"上次关闭小窗之前的高度" ──────────
  // 踩过的坑：开窗时把"记住的高度"写成 max-height 当天花板，而拖拽只写 height、不抬天花板 →
  // 拖大的部分被那条旧天花板直接截掉。取证：maxHeight 仍停在开窗时的那条 300px。
  {
    env.sizeStore = { w: 380, h: 300 } // 造一个很小的"上次记住的高度"
    env.hook.close()
    await env.sleep(40)
    env.hook.open('size-ceiling-probe', '', '尺寸天花板用例')
    for (let i = 0; i < 80 && env.hook.state().phase !== 'done'; i += 1) await env.sleep(20)
    await env.sleep(30)
    // 注：这里**不**断言"开窗时已应用记住的高度" —— loadPanelSize 整页只请求一次，
    // 而它在本次用例跑之前（sizeStore 还是 null 时）就已经标记"问过了"，桩里造不出这个前提。
    // 好在下面的断言本身就能抓住这个 bug：没有修复时拖拽只写 height、不抬 max-height，
    // maxHeight 会停在开窗时的值（或为空），dragH > 300 直接不成立。
    const grip = Array.from(env.walk(env.panel)).find((n) => String(n.className).indexOf('dsh-sel-grip-corner') >= 0)
    env.assert('（前提）找得到右下角拖拽手柄', !!grip, String(grip && grip.className))
    grip.dispatch('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1, preventDefault() {}, stopPropagation() {} })
    env.windowStub.dispatch('pointermove', { clientX: 0, clientY: 800 })
    const dragH = parseInt(env.panel.style.maxHeight, 10)
    env.assert('拖高之后天花板跟着抬高（不再被旧高度卡住）', dragH > 300, String(env.panel.style.maxHeight))
    env.assert('上限是视口高度 − 8', dragH <= 900 - 8, String(env.panel.style.maxHeight))
    env.assert('拖出来的高度当场生效（height 与天花板一致）', env.panel.style.height === env.panel.style.maxHeight, JSON.stringify({ h: env.panel.style.height, max: env.panel.style.maxHeight }))
    env.windowStub.dispatch('pointerup', {})
    await env.sleep(380) // 等防抖存档落盘（走桩，不会写进真实 host）
    grip.dispatch('dblclick', { preventDefault() {}, stopPropagation() {} })
    await env.sleep(40)
    env.assert('双击手柄恢复默认（天花板清空）', env.panel.style.maxHeight === '', JSON.stringify(env.panel.style.maxHeight))
    env.sizeStore = null
  }


  const hook = env.hook
  for (const dispose of env.disposers.splice(0).reverse()) dispose()
  env.assert('卸载后缓存、计时器和预览登记全部释放', Object.values(hook.memory()).every(value => value === 0), JSON.stringify(hook.memory()))
  env.assert('清理后自有根摘除，保留宿主 DOM', env.floatingLayer.parentNode === null && env.mount.children.length === 0 && env.body.children.indexOf(env.container) >= 0)



  env.assert('清理后钩子移除', env.windowStub.__dshSelectionExplain === undefined)

  console.log('\n=== 客户端集成测试结束 ===')
}
