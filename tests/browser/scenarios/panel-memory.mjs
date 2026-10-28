/** Browser scenario serialized into the isolated panel fixture page. */
export async function runMemory(scope) {
    // Long conversations keep their data while rendering a bounded, expandable window.
    {
        fixture.history = { key: 'browser-memory' + String.fromCharCode(0) + 'context', text: 'browser-memory', context: 'context', label: 'Memory',
            parts: { translation: 'kept translation', detail: '' },
            turns: Array.from({ length: 100 }, function (_, i) { return { role: i % 2 ? 'assistant' : 'user', text: 'browser-memory-' + i }; }) };
        fixture.history.turns[99].text = String.fromCharCode(96).repeat(3) + 'html' + String.fromCharCode(10) + '<!doctype html><html><body style="margin:0"><div style="height:2200px">memory preview</div></body></html>' + String.fromCharCode(10) + String.fromCharCode(96).repeat(3);
        scope.hook.forget();
        scope.hook.open('browser-memory', 'context', 'Memory');
        await waitFor(function () { return scope.hook.turns().length === 100; }, 3000);
        var memoryLog = document.querySelector('.dsh-sel-chatlog');
        check('长对话只渲染最近 40 条，完整对话仍有 100 条', memoryLog.querySelectorAll('.dsh-sel-bubble').length === 40 && scope.hook.turns().length === 100);
        var moreHistory = memoryLog.querySelector('[data-history-more]');
        var tallPreview = memoryLog.querySelector('iframe');
        // Chrome's virtual clock does not wait for scripts in a sandboxed iframe.
        // Exercise the real height-message handler with an already measured tall page.
        window.dispatchEvent(new MessageEvent('message', { source: tallPreview.contentWindow,
            data: { __dshPreview: true, id: tallPreview.getAttribute('data-preview-id'), h: 2200 } }));
        var firstVisible = memoryLog.querySelector('.dsh-sel-bubble');
        var scrollBody = document.querySelector('.dsh-sel-body');
        scrollBody.scrollTop = firstVisible.offsetTop;
        var anchorTop = firstVisible.getBoundingClientRect().top;
        moreHistory.click();
        var anchorAfter = Array.from(memoryLog.querySelectorAll('.dsh-sel-bubble')).find(function (node) { return node.textContent.indexOf('browser-memory-60') >= 0; });
        check('展开旧消息增加到 80 条并保持原消息阅读位置', memoryLog.querySelectorAll('.dsh-sel-bubble').length === 80 && Math.abs(anchorAfter.getBoundingClientRect().top - anchorTop) < 4);
        check('当前网页回答仍可预览', memoryLog.querySelectorAll('iframe').length === 1);
        check('展开旧消息保留已加载的网页帧和高度', memoryLog.querySelector('iframe') === tallPreview && parseFloat(tallPreview.style.height) >= 2200, JSON.stringify({ same: memoryLog.querySelector('iframe') === tallPreview, height: tallPreview.style.height }));
        scope.hook.close();
        check('关闭小窗释放网页帧和气泡，保留完整文字', scope.panel.querySelectorAll('iframe').length === 0 && memoryLog.children.length === 0 && scope.hook.turns().length === 100 && scope.hook.memory().previewFrames === 0);
        scope.hook.pill().click();
        await sleep(30);
        check('重开小窗恢复最近气泡及网页预览', memoryLog.querySelectorAll('.dsh-sel-bubble').length === 40 && memoryLog.querySelectorAll('iframe').length === 1);
        scope.hook.close();
        fixture.history = null;
    }
    // 可选截图模式（?shot=attach）：把"小窗 composer 带附件"的**真实渲染**摆出来。
    // 用服务端的一张真 PNG（/thumb.png）当被选中的图片 —— 假字节画不出缩略图，
    // 截出来会是一张破图，那就没法核对了。
    if (location.search.indexOf('shot=attach') >= 0 || location.search.indexOf('shot=drop') >= 0 || location.search.indexOf('shot=bubble') >= 0 || location.search.indexOf('shot=preview') >= 0) {
        freezeMotion();
        if (scope.panelIsOpen())
            scope.hook.close();
        await sleep(150);
        scope.hook.open('小窗支持添加图片或文件', '上下文片段 ABC', '截图');
        await waitFor(function () { return scope.hook.state().phase === 'done'; }, 8000);
        var shotInput = document.querySelector('.dsh-sel-ask input[type=file]');
        var shotBox = document.querySelector('.dsh-sel-attach');
        window.__attachFail = null;
        var pngBytes = new Uint8Array(await (await fetch('/thumb.png')).arrayBuffer());
        var png2Bytes = new Uint8Array(await (await fetch('/thumb2.png')).arrayBuffer());
        var shotDt = new DataTransfer();
        shotDt.items.add(new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])], '季度报表.pdf', { type: 'application/pdf' }));
        shotDt.items.add(new File([pngBytes], '截图.png', { type: 'image/png' }));
        shotDt.items.add(new File([png2Bytes], '第二张.png', { type: 'image/png' }));
        shotDt.items.add(new File([new Uint8Array([123, 34, 97, 34, 58, 49, 125])], 'config.json', { type: 'application/json' }));
        shotInput.files = shotDt.files;
        shotInput.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(function () {
            return shotBox.children.length === 4 && Array.prototype.every.call(shotBox.children, function (c) { return c.getAttribute('data-state') === 'done'; });
        }, 6000);
        document.querySelector('.dsh-sel-askbox').value = '这个报表里哪个季度掉得最多？';
        // 让面板落在窗口里、别贴着边缘（截图好看一点，也不影响任何判定）
        var shotPanel = document.querySelector('.dsh-sel-panel');
        if (shotPanel) {
            shotPanel.style.left = '24px';
            shotPanel.style.top = '18px';
        }
        // ?shot=bubble / ?shot=drop / ?shot=preview 都先发一条带附件的消息，好让气泡里有东西可看
        if (location.search.indexOf('shot=bubble') >= 0 || location.search.indexOf('shot=preview') >= 0) {
            var shotAsk = document.querySelector('.dsh-sel-askbox');
            shotAsk.value = '这个图片上是什么呀？';
            shotAsk.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('.dsh-sel-asksend').click();
            await waitFor(function () { return document.querySelector('.dsh-sel-bqimg') !== null; }, 8000);
            await sleep(400);
        }
        // ?shot=preview：把灯箱打开 —— 这是"点一下预览"那张真实渲染。
        // 点第二张：截图里能看到计数 2 / 2 与两侧翻页键（第一张时"上一张"是灰的，信息少一半）。
        if (location.search.indexOf('shot=preview') >= 0) {
            var shotBqImgs = document.querySelectorAll('.dsh-sel-bqimg');
            var shotBqImg = shotBqImgs[1] || shotBqImgs[0];
            if (shotBqImg)
                shotBqImg.click();
            await waitFor(function () { return document.querySelector('.dsh-sel-lightbox[data-open="1"]') !== null; }, 3000);
            await sleep(400);
        }
        // ?shot=drop：额外把拖放遮罩点亮（那层只有拖拽时才出现，不摆出来就永远没被看过）
        if (location.search.indexOf('shot=drop') >= 0 && shotPanel)
            shotPanel.setAttribute('data-dropping', '1');
        await sleep(300);
    }
    if (location.search.indexOf('shot=') < 0) {
        scope.hook.open('unload-memory-probe', '', 'Memory');
        await waitFor(function () { return scope.hook.state().phase === 'done'; }, 3000);
        var unloadInput = document.querySelector('.dsh-sel-ask input[type=file]');
        var unloadData = new DataTransfer();
        unloadData.items.add(new File([await (await fetch('/thumb.png')).arrayBuffer()], 'draft.png', { type: 'image/png' }));
        unloadInput.files = unloadData.files;
        unloadInput.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(function () { return document.querySelector('.dsh-sel-attach [data-state=done]'); }, 3000);
        var draftImage = document.querySelector('.dsh-sel-attach img');
        var draftUrl = draftImage && draftImage.src;
        var revoked = [];
        var originalRevoke = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = function (url) { revoked.push(url); originalRevoke(url); };
        disposers.reverse().forEach(function (dispose) { dispose(); });
        check('卸载时回收未发送附件的本地图片 URL', !!draftUrl && revoked.indexOf(draftUrl) >= 0);
        check('卸载后缓存、计时器和网页帧登记清空', Object.values(scope.hook.memory()).every(function (value) { return value === 0; }));
        URL.revokeObjectURL = originalRevoke;
    }
    finish();
}
