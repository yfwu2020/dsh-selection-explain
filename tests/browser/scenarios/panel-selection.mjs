/** Browser scenario serialized into the isolated panel fixture page. */
export async function runSelection(scope) {
    // ① 翻译节
    var picked1 = await scope.quoteOnce('翻译节划词', function () {
        return { node: scope.sectionContent('translation'), needle: '迁移跑得比预期久' };
    });
    var transTitle = document.querySelector('.dsh-sel-sec[data-sec="translation"] .dsh-sel-sh span');
    var transTitleText = transTitle ? transTitle.textContent : '';
    check('翻译节的来源写明是哪一节（用该节自己的标题）', !!picked1 && !!transTitleText && picked1.label === '小窗「' + transTitleText + '」节', picked1 && picked1.label + ' vs ' + transTitleText);
    // ② 结论条（.dsh-sel-callout，也在翻译节里）
    await scope.quoteOnce('结论条划词', function () {
        return { node: document.querySelector('.dsh-sel-callout'), needle: '进度延迟' };
    });
    // ③ 展开详解 → 详解节
    scope.hook.expand();
    await waitFor(function () { return (scope.hook.parts().detail || '').length > 0 && scope.hook.state().phase === 'done'; }, 4000);
    check('详解节渲染出来了', !!scope.sectionContent('detail'), '');
    var picked3 = await scope.quoteOnce('详解节划词', function () {
        return { node: scope.sectionContent('detail'), needle: '也可以被划词引用' };
    });
    check('详解节的来源写明是哪一节', !!picked3 && picked3.label.indexOf('详解') >= 0, picked3 && picked3.label);
    // ④ 跨节选择：从翻译节拖到详解节
    {
        var from = scope.sectionContent('translation');
        var to = scope.sectionContent('detail');
        var texts = [];
        var walker = document.createTreeWalker(from, NodeFilter.SHOW_TEXT, null);
        var node;
        while ((node = walker.nextNode()))
            if (node.nodeValue.trim())
                texts.push(node);
        if (texts.length && to.firstChild) {
            // 与 quoteOnce 同一套重试（合成选区 vs 面板渲染的竞态）
            var shown = false;
            for (var attempt2 = 0; attempt2 < 3 && !shown; attempt2 += 1) {
                if (attempt2 > 0)
                    await scope.settlePanel();
                var fromNow = scope.sectionContent('translation');
                var toNow = scope.sectionContent('detail');
                var textsNow = [];
                var walker2 = document.createTreeWalker(fromNow, NodeFilter.SHOW_TEXT, null);
                var nodeNow;
                while ((nodeNow = walker2.nextNode()))
                    if (nodeNow.nodeValue.trim())
                        textsNow.push(nodeNow);
                if (!textsNow.length || !toNow.firstChild)
                    break;
                var range = document.createRange();
                range.setStart(textsNow[0], 0);
                var endNode = toNow.firstChild.nodeType === 3 ? toNow.firstChild : toNow;
                range.setEnd(endNode, Math.min(4, (endNode.nodeValue || '').length));
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                mouseUpOn(toNow);
                shown = await waitFor(function () { return scope.hook.quoteState().visible === true; }, 1500);
            }
            check('跨节选择：也浮出「❝ 引用」', shown === true, JSON.stringify(scope.hook.quoteState()));
            if (shown) {
                clickOn(scope.quoteBtn);
                await sleep(40);
                check('跨节选择：进了引用区', scope.chipCount() === 1, JSON.stringify(scope.hook.quotes().map(function (q) { return q.text.length; })));
                scope.dropQuotes();
                await sleep(30);
            }
        }
        else {
            check('跨节选择：也浮出「❝ 引用」', false, '没找到可跨的文本节点');
        }
    }
    // ⑤ 面板**滚动之后**再划词（长内容 + 滚动是真实常态）
    {
        var body = document.querySelector('.dsh-sel-body');
        body.scrollTop = Math.min(120, Math.max(0, body.scrollHeight - body.clientHeight));
        await sleep(30);
        var picked5 = await scope.quoteOnce('滚动后划翻译节', function () {
            return { node: scope.sectionContent('translation'), needle: '迁移跑得比预期久' };
        });
        check('滚动之后划词照常能用', !!picked5, '');
    }
    // ⑥ 代码注释节（「## 注释」+ <pre>，划词落在 pre 里）
    {
        scope.hook.close();
        scope.hook.open('function add(a, b) { return a + b }', 'const x = 1', '代码块');
        await waitFor(function () { return scope.hook.state().phase === 'done'; }, 4000);
        var header = document.querySelector('.dsh-sel-sec[data-sec="translation"] .dsh-sel-sh');
        check('代码用例切到「注释」节', !!header && header.textContent.indexOf('注释') >= 0, header ? header.textContent : '未找到');
        await scope.quoteOnce('代码块里划词', function () {
            return { node: document.querySelector('.dsh-sel-pre'), needle: 'const x' };
        });
    }
    // ⑦ 对话气泡（不带上下文，但要写清出处）
    {
        scope.hook.close();
        scope.hook.open('冒烟探针', '上下文片段 ABC', '冒烟');
        await waitFor(function () { return scope.hook.state().phase === 'done'; }, 4000);
        var widthBeforeAsk = Math.round(document.querySelector('.dsh-sel-panel').getBoundingClientRect().width);
        scope.hook.ask('冒烟追问');
        // ask() 是异步的（要先取引用上下文 / 传附件才入队）：提问刚发出那一刻 asking 还是 false，
        // 只等 asking===false 会立刻返回、气泡还没画出来。等回答真的落到气泡里再量宽度。
        await waitFor(function () {
            var list = document.querySelectorAll('.dsh-sel-chatlog .dsh-sel-bubble-bot');
            var last = list[list.length - 1];
            return scope.hook.state().asking === false && !!last && last.textContent.indexOf('冒烟用例') >= 0;
        }, 4000);
        var widthAfterAsk = Math.round(document.querySelector('.dsh-sel-panel').getBoundingClientRect().width);
        check('追问前后宽度不变（不再从 440 跳到 540）', widthBeforeAsk === widthAfterAsk && Math.abs(widthAfterAsk - scope.WIDE_WIDTH) <= 2, '追问前 ' + widthBeforeAsk + 'px → 追问后 ' + widthAfterAsk + 'px');
        var bubbles = document.querySelectorAll('.dsh-sel-chatlog .dsh-sel-bubble-bot');
        var bot = bubbles[bubbles.length - 1];
        check('追问气泡渲染出来了', !!bot && bot.textContent.indexOf('冒烟用例') >= 0, bot ? bot.textContent.slice(0, 24) : '未找到');
        var picked7 = await scope.quoteOnce('对话气泡划词', function () { return { node: bot, needle: '冒烟用例' }; });
        check('对话引用写清了出处（第 N 轮 + 角色）', !!picked7 && /第 [0-9]+ 轮/.test(picked7.label), picked7 && picked7.label);
        check('对话引用不带上下文（小窗对话本来就在历史里）', !!picked7 && !picked7.context, picked7 && JSON.stringify(picked7.context));
        var all = bot.querySelector('.dsh-sel-bubquote');
        check('气泡末尾有「引用整条」', !!all, '');
        if (all) {
            clickOn(all);
            await sleep(40);
            var quoted = scope.hook.quotes();
            var last = quoted.length ? quoted[quoted.length - 1] : null;
            check('「引用整条」也不带上下文', !!last && !last.context, last && JSON.stringify(last.context));
            check('「引用整条」也写清出处', !!last && /第 [0-9]+ 轮/.test(last.label), last && last.label);
            scope.dropQuotes();
            await sleep(30);
        }
    }
    // ⑧ 主界面划词（小窗开着）→ 会话里的引用（带 host 上下文）
    {
        var docp = document.getElementById('docp');
        var picked8 = await scope.quoteOnce('主界面划词', function () { return { node: docp, needle: 'the migration ran long' }; });
        check('主界面引用标成会话里的', !!picked8 && picked8.session === true, picked8 && String(picked8.session));
    }
    // ⑨ 点「✦ 解读」后立刻收掉本文档选区（用户报的：小窗亮起时旧选区又触发「❝ 引用」浮标）
    {
        scope.hook.close();
        await sleep(80);
        var planBtn = document.querySelector('.dsh-sel-btn:not(.dsh-sel-quotebtn)');
        var docp2 = document.getElementById('docp');
        selectIn(docp2, 'the migration ran long');
        mouseUpOn(docp2);
        var planShown = await waitFor(function () {
            return planBtn && planBtn.style.display !== 'none' && planBtn.getBoundingClientRect().width > 0;
        }, 1500);
        check('主界面划词：浮出「✦ 解读」', planShown === true, planBtn ? planBtn.style.display : '未找到按钮');
        if (planShown) {
            realClick(planBtn);
            // ⚠️ 这里**同步**检查，一下都不 await：开窗自动聚焦那一下是异步的（要等输入框可见），
            //    所以"选区这会儿已经没了"只可能是我们自己在点的时候清的 —— 它骗不过这一条。
            var live = window.getSelection();
            check('点「解读」后选区立刻收掉（同步检查，不等聚焦那一下）', !!live && (live.rangeCount === 0 || live.isCollapsed === true), live ? 'rangeCount=' + live.rangeCount + ' collapsed=' + live.isCollapsed : 'null');
            check('选区记录也一并作废（不再拿它当"当前选区"）', scope.hook.selection() === null, JSON.stringify(scope.hook.selection()));
            await sleep(120);
            check('旧选区没有让「❝ 引用」浮标复活', !onTop(scope.quoteBtn), String(scope.quoteBtn.style.display));
            // 用户报症状的那一步：小窗亮着时在输入框里按方向键（keyup 会触发一次选区检查）
            var askBox = document.querySelector('.dsh-sel-askbox');
            if (askBox) {
                askBox.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
                await sleep(120);
                check('开窗后按方向键也不再冒出引用浮标', !onTop(scope.quoteBtn), String(scope.quoteBtn.style.display));
            }
            scope.hook.close();
            await sleep(60);
        }
    }
    // ⑨-b 选中的文字被删掉 → 浮标跟着消失（用户报的：文字没了，浮标还赖在屏幕上）
    {
        scope.hook.close();
        await sleep(80);
        var planBtn2 = document.querySelector('.dsh-sel-btn:not(.dsh-sel-quotebtn)');
        var docp3 = document.getElementById('docp');
        selectIn(docp3, 'the migration ran long');
        mouseUpOn(docp3);
        var lit = await waitFor(function () {
            return planBtn2 && planBtn2.style.display !== 'none' && planBtn2.getBoundingClientRect().width > 0;
        }, 1500);
        check('（准备）主界面划词浮出「✦ 解读」', lit === true, planBtn2 ? planBtn2.style.display : '未找到按钮');
        // ① 选区塌陷（Backspace / Delete / 打字覆盖 / 剪切走的都是这条）：浏览器会发 selectionchange
        window.getSelection().removeAllRanges();
        var gone = await waitFor(function () { return planBtn2.style.display === 'none'; }, 800);
        check('选中的文字被删掉（选区塌陷）→ 浮标消失', gone === true, planBtn2 ? planBtn2.style.display : '未找到按钮');
        // ② 选中的节点被整个换掉（流式回答重渲染就是这条）：那段文字没了，浮标也不该留着。
        //    ⚠️ 先确认浮标**真的收掉了**再往下走：不然 ① 漏掉时浮标一直亮着，
        //      下面的"再次亮着"会白捡一个 PASS（这条用例就测不出东西了）。
        var settled = await waitFor(function () { return planBtn2.style.display === 'none'; }, 800);
        check('（准备 ②）① 之后浮标确实是收着的', settled === true, planBtn2 ? planBtn2.style.display : '未找到按钮');
        selectIn(docp3, 'the migration ran long');
        mouseUpOn(docp3);
        var lit2 = await waitFor(function () {
            return planBtn2 && planBtn2.style.display !== 'none' && planBtn2.getBoundingClientRect().width > 0;
        }, 1500);
        check('（准备 ②）浮标再次亮着', lit2 === true, planBtn2 ? planBtn2.style.display : '未找到按钮');
        docp3.textContent = '（这段文字已经被换掉了）';
        var gone2 = await waitFor(function () { return planBtn2.style.display === 'none'; }, 800);
        check('选中的节点被摘掉（文字被换掉）→ 浮标也消失', gone2 === true, planBtn2 ? planBtn2.style.display : '未找到按钮');
        docp3.textContent = 'Dev: the migration ran long, so we ship Wednesday.';
        await sleep(30);
    }
    // ⑩ 浮标图标的**墨迹**要在画布里居中（用户报的："✦ 和 解读 好像没对齐，也没在按钮里居中"）
    //    为什么量 getBBox 而不是截图：浮动按钮是 align-items:center 的 flex，居中的是**画布盒子**，
    //    图形在画布里偏一点，图标就整体偏一点 —— 老星形路径 y 占 1.2~12.4（中心 6.8，不是 8），
    //    于是比右边「解读」两个字高 1.1px（8x 截图量出来的）。文字墨迹没法用 DOM 量，
    //    但"图标墨迹居中"这一条就足以拦住这类回归。
    {
        var icons = [
            ['解读浮标 ✦ 图标', document.querySelector('.dsh-sel-btn:not(.dsh-sel-quotebtn) svg')],
            ['引用浮标 ❝ 图标', scope.quoteBtn.querySelector('svg')],
        ];
        for (var k = 0; k < icons.length; k += 1) {
            var svg = icons[k][1];
            // 浮标这会儿多半是隐藏的（display:none）—— 隐藏元素的 getBBox() 一律返回 0，
            // 所以量之前先临时摆出来，量完还原（不改它此刻的真实状态）。
            var btn = svg ? svg.closest('.dsh-sel-btn') : null;
            var prev = btn ? btn.style.display : '';
            if (btn)
                btn.style.display = 'inline-flex';
            var box = svg ? svg.getBBox() : null;
            if (btn)
                btn.style.display = prev;
            var cx = box ? box.x + box.width / 2 : 0;
            var cy = box ? box.y + box.height / 2 : 0;
            check(icons[k][0] + '墨迹在 16×16 画布里居中', !!box && Math.abs(cx - 8) <= 0.25 && Math.abs(cy - 8) <= 0.25, box ? 'cx=' + cx.toFixed(2) + ' cy=' + cy.toFixed(2) : '未找到 svg');
        }
    }
}
