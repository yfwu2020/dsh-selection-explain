/** Browser scenario serialized into the isolated panel fixture page. */
export async function runLayout(scope) {
    // ── 打开面板（fetch 桩给固定两节内容）──
    scope.hook.open('冒烟探针', '上下文片段 ABC', '冒烟');
    await waitFor(function () { return scope.hook.state().phase === 'done'; }, 4000);
    check('首轮渲染完成', scope.hook.state().phase === 'done', scope.hook.state().phase);
    // ── 面板 / 设置抽屉的真实尺寸 ──
    // 为什么要有这一段：单测的 DOM 桩**没有布局**。这里曾经有条按阶段收窄到 440px 的规则，
    // 因为 CSS 声明块漏了收尾花括号被整条丢弃（属性对、规则不生效，单测照样全绿）；
    // 修好闭合后它又暴露了"追问一下宽度就从 440 跳到 540"的问题 —— 两件事都只有真浏览器量得出来。
    // 现在宽度**不随阶段变**（恒 540），下面同时钉住"首轮就是 540"和"追问之后仍是 540"。
    // ── 录音行不许把发送键顶到下一行（用户报：一开麦 ↑ 就掉到下面单独一行）──
    // 真浏览器量布局：按录音态把 DOM 摆成插件摆的样子（亮出录音行、让位那几样工具），
    // 再量发送键是否还与录音行同处一行。CSS 里那两条 flex-basis:0% + nowrap 就是为它服务的。
    {
        var toolsEl = document.querySelector('.dsh-sel-asktools');
        var captureEl = document.querySelector('.dsh-sel-capture');
        var sendEl = document.querySelector('.dsh-sel-asksend');
        var waveEl = document.querySelector('.dsh-sel-vwave');
        if (toolsEl && captureEl && sendEl) {
            var yielding = ['.dsh-sel-pref', '.dsh-sel-askspace', '.dsh-sel-picker', '.dsh-sel-mic']
                .map(function (sel) { return document.querySelector(sel); })
                .filter(Boolean);
            var restore = yielding.map(function (n) { return [n, n.style.display]; });
            // 必须**窄一点**量：波形那个 svg 的固有宽度是 384px（viewBox 640x40 按 24px 高推出来的），
            // 540px 的面板刚好放得下、量不出问题；用户那个宽度才会露出来。面板本来就可调窄，这是真实场景。
            var panelWide = document.querySelector('.dsh-sel-panel');
            var widthBefore = panelWide ? panelWide.style.width : '';
            if (panelWide)
                panelWide.style.width = '420px';
            toolsEl.setAttribute('data-capturing', '1');
            captureEl.setAttribute('data-show', '1');
            captureEl.style.display = 'flex';
            if (waveEl)
                waveEl.style.display = '';
            yielding.forEach(function (n) { n.style.display = 'none'; });
            var captureRect = captureEl.getBoundingClientRect();
            var sendRect = sendEl.getBoundingClientRect();
            check('录音行出现时发送键仍在同一行（不被顶到下面）', sendRect.height > 0 && sendRect.top < captureRect.bottom && Math.abs(sendRect.top - captureRect.top) <= 8, JSON.stringify({
                capture: [Math.round(captureRect.top), Math.round(captureRect.bottom)],
                send: [Math.round(sendRect.top), Math.round(sendRect.bottom)],
            }));
            restore.forEach(function (pair) { pair[0].style.display = pair[1]; });
            if (panelWide)
                panelWide.style.width = widthBefore;
            captureEl.style.display = 'none';
            captureEl.setAttribute('data-show', '0');
            toolsEl.setAttribute('data-capturing', '0');
            if (waveEl)
                waveEl.style.display = 'none';
        }
        else {
            check('录音行出现时发送键仍在同一行（不被顶到下面）', false, '没找到工具行/录音行/发送键');
        }
    }
    scope.WIDE_WIDTH = 540;
    {
        var panelEl = document.querySelector('.dsh-sel-panel');
        var beforeRect = panelEl.getBoundingClientRect();
        check('首轮阶段宽度就是常规宽度（不再按阶段收窄到 440）', Math.abs(beforeRect.width - scope.WIDE_WIDTH) <= 2, 'stage=' + panelEl.getAttribute('data-stage') + ' width=' + Math.round(beforeRect.width));
        var settingsBtn = Array.prototype.slice.call(panelEl.querySelectorAll('.dsh-sel-action'))
            .filter(function (b) { return b.textContent.indexOf('设置') >= 0; })[0];
        check('头部有「设置」键', !!settingsBtn, settingsBtn ? settingsBtn.textContent : '未找到');
        if (settingsBtn) {
            clickOn(settingsBtn);
            await waitFor(function () { return panelEl.getAttribute('data-settings') === '1'; }, 1200);
            await sleep(60);
            var openRect = panelEl.getBoundingClientRect();
            var sheetEl = panelEl.querySelector('.dsh-sel-sheet');
            var sheetBody = sheetEl && sheetEl.querySelector('.dsh-sel-sheetbody');
            // 抽屉是 inset:0 贴在面板上的：面板多大多小，抽屉就多大多小。
            // 而面板高度是"解读内容有多长"撑出来的 —— 刚开窗时内容很短，
            // 不锁下限的话设置列表只剩十几个像素（实测 17px），等于没法用。
            // 设置窗口是 inset:0 贴在面板上的：**宽度必须与小窗一致**，
            // 开抽屉不该让面板自己"胖一圈"或"瘦一圈"（高度才需要补下限）。
            check('开设置抽屉后：设置窗口宽度与小窗完全一致（不额外加宽）', Math.abs(openRect.width - beforeRect.width) <= 0.5, '抽屉=' + openRect.width.toFixed(1) + ' 小窗=' + beforeRect.width.toFixed(1));
            check('开设置抽屉后：高度有下限（不再被内容长短绑架）', openRect.height >= 500, 'height=' + Math.round(openRect.height) + '（首轮未开抽屉时 ' + Math.round(beforeRect.height) + '）');
            var bodyH = sheetBody ? sheetBody.clientHeight : 0;
            check('设置列表可视高度够用（不是一条缝）', bodyH >= 200, 'sheetBody.clientHeight=' + Math.round(bodyH));
            // 关掉，别影响后面的用例
            var backBtn = sheetEl && sheetEl.querySelector('.dsh-sel-sheetback');
            if (backBtn)
                clickOn(backBtn);
            await waitFor(function () { return panelEl.getAttribute('data-settings') !== '1'; }, 1200);
            await sleep(40);
            var restored = panelEl.getBoundingClientRect();
            check('关掉抽屉后：小窗宽度不变（开合抽屉不动宽度）', Math.abs(restored.width - beforeRect.width) <= 0.5 && Math.abs(restored.width - scope.WIDE_WIDTH) <= 2, 'width=' + Math.round(restored.width));
        }
    }
    // ── 拖动 / 改大小 ──
    // 规则：**尺寸**记住（用户拖角调过的），**位置不记**（每次开窗都按选区重新锚定）。
    function pointerOn(node, type, x, y) {
        node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1 }));
    }
    {
        var panelEl2 = document.querySelector('.dsh-sel-panel');
        var before = scope.hook.panelGeom();
        // ① 拖右下角 → 变宽变高，并且只有尺寸被存下来
        var corner = panelEl2.querySelector('.dsh-sel-grip-corner');
        check('有右下角改大小手柄', !!corner, corner ? corner.className : '未找到');
        if (corner) {
            pointerOn(corner, 'pointerdown', 0, 0);
            pointerOn(window, 'pointermove', 140, 90);
            pointerOn(window, 'pointerup', 140, 90);
            await sleep(60);
            var grown = scope.hook.panelGeom();
            check('拖角能让小窗变大', Math.round(grown.w) > Math.round(before.w) + 100 && Math.round(grown.h) > Math.round(before.h) + 60, 'w ' + Math.round(before.w) + '→' + Math.round(grown.w) + '  h ' + Math.round(before.h) + '→' + Math.round(grown.h));
            check('改过大小会打标记（设置页就不再插手高度）', grown.resized === true, String(grown.resized));
            await sleep(420); // 防抖 300ms
            check('尺寸存到了 host（下次开窗回到这个大小）', !!panelSizeStore && Math.abs(panelSizeStore.w - grown.w) <= 1 && Math.abs(panelSizeStore.h - grown.h) <= 1, JSON.stringify(panelSizeStore));
            check('存档里**没有位置**（载荷只有 w/h）', !!panelSizeStore && panelSizeStore.hadXY === false, JSON.stringify(panelSizeStore));
        }
        // ② 拖标题栏：这次能挪动，但**不该存位置**
        var headEl = panelEl2.querySelector('.dsh-sel-head');
        var posBefore = scope.hook.panelGeom();
        pointerOn(headEl, 'mousedown', posBefore.x + 60, posBefore.y + 12);
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: posBefore.x + 60 + 70, clientY: posBefore.y + 12 + 44 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await sleep(60);
        var moved = scope.hook.panelGeom();
        check('拖标题栏能挪动小窗（本次有效）', Math.abs(moved.x - posBefore.x) > 40 && Math.abs(moved.y - posBefore.y) > 20, 'x ' + Math.round(posBefore.x) + '→' + Math.round(moved.x) + '  y ' + Math.round(posBefore.y) + '→' + Math.round(moved.y));
        await sleep(420);
        check('拖动**不会**把位置存进 host（位置记忆已按要求去掉）', !!panelSizeStore && panelSizeStore.hadXY === false, JSON.stringify(panelSizeStore));
        // ③ 尺寸能读回来（模拟刷新：清掉内联尺寸，再让客户端重读一次）
        panelEl2.style.width = '';
        panelEl2.style.height = '';
        panelEl2.removeAttribute('data-resized');
        scope.hook.loadPanelSize();
        await sleep(80);
        var restored2 = scope.hook.panelGeom();
        // 宽度按存档精确恢复；高度只作为天花板 —— 内容撑不到就自己短着（见 ⑥）
        check('宽度能按存档恢复', Math.abs(restored2.w - panelSizeStore.w) <= 1, 'w=' + Math.round(restored2.w) + ' / 存档 ' + Math.round(panelSizeStore.w));
        check('高度不超过存档的上限', restored2.h <= panelSizeStore.h + 1, 'h=' + Math.round(restored2.h) + ' / 上限 ' + Math.round(panelSizeStore.h));
        // ④ 重新开窗 → 必须重新按选区锚定（这是"位置不记"的核心保证）
        //    先把窗口挪到一个明显偏离锚点的位置，再关掉重开。
        panelEl2.style.left = '7px';
        panelEl2.style.top = '7px';
        scope.hook.close();
        await sleep(40);
        scope.hook.open('重新锚定探测', '上下文片段 ABC', '冒烟');
        await sleep(60);
        var reopened = scope.hook.panelGeom();
        check('重新开窗会重新按选区锚定（位置没被记住）', reopened.x > 20 && reopened.y > 20, 'x=' + Math.round(reopened.x) + ' y=' + Math.round(reopened.y) + '（若被记住应是 7,7）');
        // ⑤ 双击角标 → 恢复默认尺寸
        if (corner) {
            corner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
            await sleep(80);
            var afterReset = scope.hook.panelGeom();
            check('双击角标恢复默认尺寸（清掉存档）', afterReset.resized === false && panelSizeStore === null, 'resized=' + afterReset.resized + ' store=' + JSON.stringify(panelSizeStore));
            await sleep(420);
        }
        // ⑥ 记住的高度只能当**天花板**：新会话内容短时面板必须缩回去，不能留一大片空白。
        //    这条是用户报的回归 —— 高度被当成固定值写上去，新开一个会话（只有一小段翻译）
        //    面板硬撑到上次那么高，下面全是空的。
        panelSizeStore = { w: 620, h: 700, hadXY: false };
        panelEl2.style.width = '';
        panelEl2.style.height = '';
        panelEl2.style.maxHeight = '';
        panelEl2.removeAttribute('data-resized');
        scope.hook.loadPanelSize();
        await sleep(80);
        scope.hook.close();
        await sleep(40);
        scope.hook.open('自适应高度探测', '上下文片段 ABC', '冒烟');
        await sleep(100);
        var fresh = scope.hook.panelGeom();
        var blank = panelEl2.clientHeight - panelEl2.scrollHeight;
        check('新会话高度自适应：面板里没有大片空白', blank <= 4, 'clientHeight=' + panelEl2.clientHeight + ' scrollHeight=' + panelEl2.scrollHeight + ' 空白=' + blank);
        check('存档的高度只当天花板（没被当成固定高度）', fresh.h < 680, 'h=' + Math.round(fresh.h) + '（存档上限 700，若被当固定值用就该是 700）');
        check('宽度仍沿用存档的值（宽度固定、高度自适应）', Math.abs(fresh.w - 620) <= 1, 'w=' + Math.round(fresh.w));
        // ⑦ 双击 = 自适应 = 恢复默认尺寸（同一个动作）：把窗口**拉小**之后再双击，
        //    高度不该还被旧的上限卡着 —— 那是"只清了 width/height、漏了 maxHeight"的症状。
        panelSizeStore = { w: 340, h: 250, hadXY: false };
        panelEl2.style.width = '';
        panelEl2.style.height = '';
        panelEl2.style.maxHeight = '';
        panelEl2.removeAttribute('data-resized');
        scope.hook.loadPanelSize();
        await sleep(80);
        scope.hook.close();
        await sleep(40);
        scope.hook.open('拉小后双击探测', '上下文片段 ABC', '冒烟');
        await sleep(120);
        var shrunk = scope.hook.panelGeom();
        check('存档的小尺寸生效（宽度 340、高度被 250 卡住）', Math.abs(shrunk.w - 340) <= 1, 'w=' + Math.round(shrunk.w) + ' h=' + Math.round(shrunk.h));
        corner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        await sleep(120);
        var back = scope.hook.panelGeom();
        check('双击后宽度回到默认（不再被存档的 340 卡住）', Math.abs(back.w - 340) > 40, 'w ' + Math.round(shrunk.w) + '→' + Math.round(back.w));
        check('双击后高度上限也被清掉（不再被 250 卡住）', panelEl2.style.maxHeight === '' && back.h > 260, 'maxHeight=' + JSON.stringify(panelEl2.style.maxHeight) + ' h=' + Math.round(back.h));
        await sleep(420);
        // ⑦.5 刚拖完角标就双击还原：防抖里那次没落盘的保存**不能**把还原撤销掉。
        //      savePanelSize 在定时器触发时才读当前尺寸 —— 不掐掉的话它 300ms 后会读到
        //      "已还原的默认尺寸"，反过来当成用户选的尺寸存下来，宽度被钉死。
        pointerOn(corner, 'pointerdown', 0, 0);
        pointerOn(window, 'pointermove', 90, 60);
        pointerOn(window, 'pointerup', 90, 60);
        await sleep(40); // 远小于 300ms 防抖：保存还没落盘
        corner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        await sleep(500); // 跨过防抖窗口，看那次保存会不会"复活"
        check('刚拖完就双击还原：待落的保存不会把还原撤销掉', panelSizeStore === null && panelEl2.style.width === '' && panelEl2.getAttribute('data-resized') === null, 'store=' + JSON.stringify(panelSizeStore) + ' inline=' + JSON.stringify(panelEl2.style.width) +
            ' resized=' + panelEl2.getAttribute('data-resized'));
        // ⑧ 恢复默认尺寸**不等于没有上限**：上限从"用户调过的"换回"CSS 默认的" min(78vh,720px)。
        //    清掉的是用户那条自定义上限，不是限制本身。
        {
            var cap = Math.min(window.innerHeight * 0.78, 720);
            var computedMax = getComputedStyle(panelEl2).maxHeight;
            check('恢复默认后高度仍有上限（回到 CSS 默认 min(78vh,720px)）', panelEl2.style.maxHeight === '' && computedMax !== 'none' &&
                Math.abs(parseFloat(computedMax) - cap) <= 2, 'inline=' + JSON.stringify(panelEl2.style.maxHeight) + ' computed=' + computedMax +
                ' 期望=' + Math.round(cap) + 'px');
            // 塞一段超长内容：面板不该被撑破上限，多出来的部分在正文里滚动
            // 塞一段超长内容量一次 —— 量完必须**收拾干净**：这一段动的是真面板，
            // 面板高度会 423 → 634 → 423，滚动位置也会变；不还原就会影响后面那些
            // 依赖坐标的划词用例（跑多次能撞见）。
            var bodyEl = panelEl2.querySelector('.dsh-sel-body');
            var savedScroll = bodyEl.scrollTop;
            var filler = document.createElement('div');
            filler.style.cssText = 'height:3000px;flex:0 0 auto';
            bodyEl.appendChild(filler);
            await sleep(80);
            var tall = panelEl2.getBoundingClientRect().height;
            check('内容超长时面板不越过上限（超出部分内部滚动）', tall <= cap + 2, 'h=' + Math.round(tall) + ' 上限=' + Math.round(cap) + ' body 可滚=' + (bodyEl.scrollHeight > bodyEl.clientHeight));
            filler.remove();
            bodyEl.scrollTop = savedScroll;
            void panelEl2.offsetHeight; // 强制回流，别让后面的用例量到中间态
            await sleep(140);
        }
        // ⑨ 手柄不该有常驻的视觉标识（用户要求去掉右下角那道小斜纹）
        var cornerAfter = getComputedStyle(corner, '::after');
        check('右下角手柄没有常驻标识（不再画小斜纹）', !cornerAfter.content || cornerAfter.content === 'none' || cornerAfter.content === 'normal', 'content=' + cornerAfter.content);
        check('手柄仍在（只是不可见，鼠标移上去光标会变）', getComputedStyle(corner).cursor === 'nwse-resize', 'cursor=' + getComputedStyle(corner).cursor);
        // ⑩ 贴着屏幕边缘时双击恢复默认尺寸 → 面板不能被顶出屏幕
        //    复现：先拉宽到接近满屏并推到右边，再双击角标（宽度会跳回默认 540，位置是旧的）
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        pointerOn(corner, 'pointerdown', 0, 0);
        pointerOn(window, 'pointermove', vw, vh); // 尽量拉大
        pointerOn(window, 'pointerup', vw, vh);
        await sleep(80);
        // 推到右下角
        var big = scope.hook.panelGeom();
        var headEl2 = panelEl2.querySelector('.dsh-sel-head');
        pointerOn(headEl2, 'mousedown', big.x + 60, big.y + 12);
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: vw + 500, clientY: vh + 500 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await sleep(80);
        var beforeReset = scope.hook.panelGeom();
        corner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        await sleep(120);
        var afterDbl = scope.hook.panelGeom();
        check('贴边双击恢复默认尺寸后，面板仍在屏幕内', afterDbl.x >= 0 && afterDbl.y >= 0 &&
            afterDbl.x + afterDbl.w <= vw + 1 && afterDbl.y + afterDbl.h <= vh + 1, 'x=' + Math.round(afterDbl.x) + ' y=' + Math.round(afterDbl.y) +
            ' 右=' + Math.round(afterDbl.x + afterDbl.w) + '/' + vw +
            ' 下=' + Math.round(afterDbl.y + afterDbl.h) + '/' + vh +
            '（双击前 x=' + Math.round(beforeReset.x) + ' w=' + Math.round(beforeReset.w) + '）');
    }
}
