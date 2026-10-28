/** Browser scenario serialized into the isolated panel fixture page. */
export async function runModels(scope) {
    // ⑮ 模型菜单：跟随态也要给"当前在用"那个打勾（真浏览器里量几何 —— 桩里量不出换行/溢出）
    {
        scope.hook.open('模型菜单勾选', '', '菜单冒烟');
        await waitFor(function () { return scope.hook.state().phase === 'done'; }, 8000);
        await scope.hook.loadModels(true);
        var modelNodes = scope.hook.modelNodes();
        // DSH 按属性判定弹层，不检查 CSS 可见性（Issue #1）。
        var modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"]';
        function modelMenuOwnsShortcuts() {
            return Array.from(document.querySelectorAll(modalSelector)).includes(modelNodes.menu);
        }
        function checkModelMenuClosed(reason) {
            check(reason + '：模型菜单不再占用 DSH 快捷键', !modelMenuOwnsShortcuts() && modelNodes.menu.getAttribute('data-open') !== '1' &&
                modelNodes.pill.getAttribute('aria-expanded') === 'false');
        }
        checkModelMenuClosed('初始收起');
        // 官方 useModalLayer 在 document 冒泡阶段处理 Esc；插件 capture 必须让行。
        function checkHostEscapeFirst(target, label) {
            var hostSettings = document.createElement('div');
            hostSettings.setAttribute('role', 'dialog');
            hostSettings.setAttribute('aria-modal', 'true');
            hostSettings.setAttribute('data-shortcut-modal', 'settings');
            var hostInput = document.createElement('input');
            hostSettings.appendChild(hostInput);
            document.body.appendChild(hostSettings);
            function dismissHost(event) {
                if (event.key !== 'Escape' || event.defaultPrevented)
                    return;
                event.preventDefault();
                hostSettings.remove();
            }
            document.addEventListener('keydown', dismissHost);
            try {
                var event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
                (target || hostInput).dispatchEvent(event);
                check(label + '：Esc 到达官方浮层并只关闭官方设置', event.defaultPrevented && !hostSettings.isConnected && scope.panel.style.display === 'flex');
            }
            finally {
                document.removeEventListener('keydown', dismissHost);
                hostSettings.remove();
            }
        }
        var escapeModeFrame = document.createElement('div');
        escapeModeFrame.setAttribute('data-dsh-full-view', '');
        escapeModeFrame.setAttribute('data-dsh-active-floating-window', 'explanation');
        for (var fullViewMode of [false, true]) {
            if (fullViewMode)
                document.body.appendChild(escapeModeFrame);
            var modeLabel = fullViewMode ? '完整视图' : '普通分栏';
            checkHostEscapeFirst(null, modeLabel + '／焦点在官方设置');
            checkHostEscapeFirst(document.querySelector('.dsh-sel-askbox'), modeLabel + '／焦点仍在解读输入框');
        }
        escapeModeFrame.remove();
        scope.hook.openModel();
        await sleep(120);
        check('模型菜单展开时占用 DSH 快捷键', modelMenuOwnsShortcuts() && modelNodes.pill.getAttribute('aria-expanded') === 'true');
        var menu = scope.hook.modelNodes().menu;
        var rows = Array.prototype.slice.call(menu.querySelectorAll('.dsh-sel-pickerrow'));
        check('模型菜单列出 3 个模型（含同名 id 的另一 provider）', rows.length === 3, String(rows.length));
        var onRows = rows.filter(function (r) { return r.getAttribute('data-on') === '1'; });
        check('跟随态：只有当前在用的那一行打勾', onRows.length === 1 && onRows[0].textContent.indexOf('DeepSeek V4.1 Flash') >= 0, onRows.map(function (r) { return r.textContent; }).join(' | ') || '没有任何一行打勾');
        var badge = onRows[0] && onRows[0].querySelector('.dsh-sel-pickerfollow');
        check('跟随态那一行有「跟随」小标，且小标在菜单里可见（没被挤出边界）', !!badge && badge.offsetWidth > 0 && badge.getBoundingClientRect().right <= menu.getBoundingClientRect().right + 1, badge ? Math.round(badge.getBoundingClientRect().left) + '→' + Math.round(badge.getBoundingClientRect().right) + '（菜单右边界 ' + Math.round(menu.getBoundingClientRect().right) + '）' : '没有小标');
        var nameSpan = onRows[0] && onRows[0].querySelector('.dsh-sel-pickername');
        check('名字带省略号、不撑破一行（真实布局下 scrollWidth 不超）', !!nameSpan && nameSpan.scrollWidth >= nameSpan.clientWidth && onRows[0].scrollWidth <= onRows[0].clientWidth + 1, nameSpan ? nameSpan.clientWidth + ' 可见 / ' + nameSpan.scrollWidth + ' 全长；行 ' + onRows[0].clientWidth + '/' + onRows[0].scrollWidth : '没有名字节点');
        // 长名字那行（没打勾、没小标）也不该被撑破
        var longRow = rows.filter(function (r) { return r.textContent.indexOf('Strong Model With A Very Long') >= 0; })[0];
        check('超长名字那一行同样不横向溢出（靠省略号收窄）', !!longRow && longRow.scrollWidth <= longRow.clientWidth + 1, longRow ? longRow.clientWidth + '/' + longRow.scrollWidth : '没找到那一行');
        var rowBox = onRows[0] ? onRows[0].getBoundingClientRect() : null;
        check('打勾那一行仍是单行（高度不超过 30px，没折成两行）', !!rowBox && rowBox.height <= 30, rowBox ? Math.round(rowBox.height) + 'px' : '没找到那一行');
        checkHostEscapeFirst(modelNodes.menu, '模型菜单仍展开');
        check('官方设置关闭时保留插件模型菜单', modelNodes.menu.getAttribute('data-open') === '1');
        clickOn(modelNodes.pill);
        checkModelMenuClosed('再次点击胶囊');
        scope.hook.openModel();
        modelNodes.menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        checkModelMenuClosed('按 Esc');
        scope.hook.openModel();
        document.getElementById('docp').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        checkModelMenuClosed('点击菜单外部');
        scope.hook.openModel();
        clickOn(modelNodes.menu.querySelector('.dsh-sel-pickerrow'));
        checkModelMenuClosed('选择模型');
        scope.hook.openModel();
        scope.hook.close(); // 关窗会顺手收起模型菜单
        checkModelMenuClosed('关闭解读面板');
        await sleep(30);
    }
    // 内容把面板撑出视口 → 必须自动收回（回复框不能被顶到屏幕外）
    //
    // 真实场景：开窗那一刻"放得下吗"是按当时的高度算的（常常只有一行翻译在流），
    // 之后正文长到 max-height，面板从固定的 top 往下挂 —— 它是 position:fixed、页面不滚，
    // 顶出去那截（回复框）就点不到了。
    //
    // ⚠️ 复核挂在**绘制之后**（内容这时才在 DOM 里）。所以这里灌完内容要再走一次真实绘制，
    // 不能用 askValue 那类只改状态、不重绘的钩子（踩过：断言量到的一直是注入前的旧位置）。
    {
        scope.hook.open('溢出探测', '上下文片段', '冒烟');
        await sleep(140);
        var panelEl3 = document.querySelector('.dsh-sel-panel');
        var bodyEl3 = panelEl3.querySelector('.dsh-sel-body');
        var filler = document.createElement('div');
        filler.style.height = Math.round(window.innerHeight * 0.9) + 'px';
        filler.style.flex = '0 0 auto';
        bodyEl3.appendChild(filler);
        // 再开一次 = 走一遍真实的 showPanel + paint（内容已经在 DOM 里，复核这帧就能看见）
        scope.hook.open('溢出探测', '上下文片段', '冒烟');
        await sleep(180);
        var overRect = panelEl3.getBoundingClientRect();
        check('内容把面板撑出视口时自动收回可视区（回复框不会被顶到屏幕外）', overRect.bottom <= window.innerHeight - 2, 'bottom=' + Math.round(overRect.bottom) + ' vh=' + window.innerHeight);
        filler.remove();
        scope.hook.open('溢出探测', '上下文片段', '冒烟');
        await sleep(80);
        scope.hook.close();
        await sleep(40);
    }
}
