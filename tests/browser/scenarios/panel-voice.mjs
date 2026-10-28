/** Browser scenario serialized into the isolated panel fixture page. */
export async function runVoice(scope) {
    // ⑫ 卡片 → 小窗的交接（方案二「缩放长出」）：真浏览器里量真矩形 + 真过渡。
    //    桩 DOM 里只能验"写进去的 transform 字符串"，这里补上"浏览器真的从那一格长出来"。
    {
        scope.hook.close();
        await sleep(60);
        var docp4 = document.getElementById('docp');
        selectIn(docp4, 'the migration ran long');
        mouseUpOn(docp4);
        // 让 host 报"豆包在录"：插件轮询到就把卡片弹出来（这是真实的触发路径）
        micState = { ok: true, available: true, capturing: true, processes: [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }], reason: '' };
        var cardEl = await waitFor(function () {
            var el = document.querySelector('.dsh-sel-vcard');
            return el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0 ? el : null;
        }, 2500);
        check('（准备）输入法开麦 → 语音卡自己弹出来', !!cardEl, cardEl ? '' : '没等到卡片');
        if (cardEl) {
            check('语音卡自身禁止原生窗口拖拽', getComputedStyle(cardEl).webkitAppRegion === 'no-drag', getComputedStyle(cardEl).webkitAppRegion);
            var marks = Array.from(document.querySelectorAll('.dsh-sel-umark,.dsh-sel-thread'));
            check('全屏选中提示不阻止原生窗口拖拽', marks.length > 0 && marks.every(function (node) { return getComputedStyle(node).webkitAppRegion === 'none'; }), marks.map(function (node) { return node.className.baseVal || node.className; }).join(', '));
            var vbox = cardEl.querySelector('.dsh-sel-vcard-box');
            var vsend = cardEl.querySelector('.dsh-sel-vcard-send');
            vbox.value = '这是 在推迟 还是提前';
            vbox.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(60);
            var cardRect = cardEl.getBoundingClientRect();
            var panelEl4 = document.querySelector('.dsh-sel-panel');
            // ⚠️ 不能用"点完下一帧读计算值"来抓起点：这个冒烟页跑在 --virtual-time-budget 下，
            //    虚拟时钟会往前跳，rAF 回来时过渡可能已经跑完了（实测读到 matrix=none）。
            //    改成**记录 style 属性的每一次写入**（MutationObserver 的 attributeOldValue 给的是
            //    写之前的值）—— 于是"起点把面板压到卡片那一格"这件事与时钟无关，直接可读可验。
            var reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
            var styleWrites = [];
            var mo = new MutationObserver(function (records) {
                for (var i = 0; i < records.length; i += 1)
                    styleWrites.push(records[i].oldValue || '');
            });
            mo.observe(panelEl4, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
            clickOn(vsend);
            // 期望值必须在**同一个任务里**读完：插件也是在这次点击里量的几何
            // （openPanelWith 内层跑完、内容已换新 → 量高度；随后流式回答才会把面板撑高）。
            // 面板的 offset* 是布局值，不受正在跑的 transform 影响。
            var expW = panelEl4.offsetWidth;
            var expH = panelEl4.offsetHeight;
            var expLeft = panelEl4.offsetLeft;
            var expTop = panelEl4.offsetTop;
            await sleep(150);
            mo.disconnect();
            var startStyle = null;
            for (var wi = 0; wi < styleWrites.length; wi += 1) {
                if (styleWrites[wi].indexOf('transform: translate(') >= 0)
                    startStyle = styleWrites[wi];
            }
            // ⚠️ 页面脚本是**模板字符串**里的：正则里的 d / ( 会被模板字面量吃掉反斜杠
            //    （写成 [d.] 到了页面里变成 [d.]，永远匹配不上 —— 实测就是这么红的）。
            //    所以这里只用不带反斜杠的字符类 [0-9.] 取数，并且从 transform 那一段开始取，
            //    免得把 z-index / left / top 上的数字也吃进来。
            var seg = startStyle ? startStyle.slice(startStyle.indexOf('transform: translate(')) : '';
            var nums = seg.match(/-?[0-9.]+/g) || [];
            var m = nums.length >= 4 ? [seg.slice(0, 60), nums[0], nums[1], nums[2], nums[3]] : null;
            // 期望值：面板的**布局**值（offset*，不受动画影响）与卡片矩形的比值/差值
            var sx = cardRect.width / expW;
            var sy = cardRect.height / expH;
            var dx = cardRect.left - expLeft;
            var dy = cardRect.top - expTop;
            check('交接动画遵守系统减少动效偏好', reducedMotion ? !startStyle && !panelEl4.style.transition : !!startStyle, 'reducedMotion=' + reducedMotion + '; style 写入次数=' + styleWrites.length);
            if (!reducedMotion) {
                check('交接起点：面板被压到卡片那一格（缩放 + 位移，量的是真矩形）', !!m && Math.abs(Number(m[3]) - sx) < 0.01 && Math.abs(Number(m[4]) - sy) < 0.01 &&
                    Math.abs(Number(m[1]) - dx) < 1 && Math.abs(Number(m[2]) - dy) < 1, m ? '起点=' + m[0] + ' 期望≈translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')'
                    : '没观察到起点写入；style 写入次数=' + styleWrites.length);
                check('交接期间 transform-origin 在左上角（否则缩放会把面板甩出去）', !!startStyle && startStyle.indexOf('transform-origin: 0px 0px') >= 0, startStyle ? startStyle.slice(0, 120) : '（没抓到）');
                var sawTransition = styleWrites.some(function (v) { return v.indexOf('transition: transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1)') >= 0; });
                check('交接只动 transform、260ms 同一族曲线（不动 width/left/top）', sawTransition || String(panelEl4.style.transition).indexOf('transform 260ms') === 0, '写入=' + JSON.stringify(styleWrites.map(function (v) { return (v.match(/transition:[^;]*/) || [''])[0]; }).filter(Boolean).slice(0, 2)));
            }
            await sleep(520);
            var settledMatrix = getComputedStyle(panelEl4).transform;
            check('交接结束：回到恒等（无 transform）', settledMatrix === 'none' || settledMatrix === 'matrix(1, 0, 0, 1, 0, 0)', String(settledMatrix));
            check('交接收尾：内联 transform / transition / transformOrigin 清干净', !panelEl4.style.transform && !panelEl4.style.transition && !panelEl4.style.transformOrigin, JSON.stringify({ tf: panelEl4.style.transform, tr: panelEl4.style.transition, og: panelEl4.style.transformOrigin }));
            // 收尾：麦克风"松开"，别影响后面的用例
            micState = { ok: true, available: true, capturing: false, processes: [], reason: '' };
            await sleep(80);
            scope.hook.close();
            await sleep(40);
        }
    }
    // ⑬ 小窗开着时开麦 = 点一下「❝ 引用」（2026-10-09 定的行为）。
    //    真浏览器里验的是**接线**：引用浮标亮着才轮到轮询、开麦后引用真的进了引用区、
    //    焦点真的落到小窗输入框（IME 上屏要往那儿落）、而且**不弹语音卡**。
    {
        var recording = { ok: true, available: true, capturing: true, processes: [{ pid: 513, bundleId: 'com.bytedance.inputmethod.doubaoime', name: 'DoubaoIme' }], reason: '' };
        var notRecording = { ok: true, available: true, capturing: false, processes: [], reason: '' };
        micState = notRecording;
        scope.hook.close();
        await sleep(60);
        scope.hook.open('引用开麦用例', '开麦引用的上下文片段', '引用开麦');
        await waitFor(function () { return scope.hook.state().phase === 'done'; }, 3000);
        scope.quoteBtn = document.querySelector('.dsh-sel-quotebtn');
        var quotesBox = document.querySelector('.dsh-sel-quotes');
        var vcardEl = document.querySelector('.dsh-sel-vcard');
        var askEl = document.querySelector('.dsh-sel-askbox');
        // ① 没有引用浮标时不轮询（用户定的：探针只跟着浮标活）
        var hitsIdle = window.__micHits || 0;
        await sleep(500);
        check('没有引用浮标时不轮询麦克风', (window.__micHits || 0) === hitsIdle, hitsIdle + ' → ' + (window.__micHits || 0));
        // ② 主界面划词 → 引用浮标亮 → 开始问
        var docp5 = document.getElementById('docp');
        selectIn(docp5, 'the migration ran long');
        mouseUpOn(docp5);
        var lit = await waitFor(function () {
            return scope.quoteBtn && scope.quoteBtn.style.display !== 'none' && getComputedStyle(scope.quoteBtn).display !== 'none';
        }, 1500);
        check('（前提）引用浮标亮着', lit === true, scope.quoteBtn ? getComputedStyle(scope.quoteBtn).display : '未找到浮标');
        var hitsFloat = window.__micHits || 0;
        await sleep(500);
        check('引用浮标亮着时才问麦克风', (window.__micHits || 0) > hitsFloat, hitsFloat + ' → ' + (window.__micHits || 0));
        // ③ 开麦 → 引用挂进来 + 焦点进小窗输入框 + 不弹语音卡
        var quotesBefore = (scope.hook.quotes() || []).length;
        micState = recording;
        var quoted = await waitFor(function () { return (scope.hook.quotes() || []).length > quotesBefore; }, 2000);
        var got = scope.hook.quotes() || [];
        check('开麦 → 选中的那段自动挂进引用', quoted === true && /migration ran long/.test(got[got.length - 1].text), JSON.stringify(got.map(function (q) { return q.text; })));
        check('开麦 → 光标进了小窗输入框（输入法上屏的字落在这儿）', document.activeElement === askEl, document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : 'null');
        check('开麦 → **不**弹语音卡（面板开着时字直接落进小窗）', !vcardEl || getComputedStyle(vcardEl).display === 'none', vcardEl ? getComputedStyle(vcardEl).display : '没有卡片元素');
        await sleep(120);
        check('开麦 → 引用浮标自己收了', scope.quoteBtn.style.display === 'none' || getComputedStyle(scope.quoteBtn).display === 'none', scope.quoteBtn.style.display);
        check('开麦 → 引用区真的画出来了', quotesBox && quotesBox.getAttribute('data-show') === '1', quotesBox ? quotesBox.getAttribute('data-show') : '未找到引用区');
        // ④ 别处正在打字 → 不加引用、不抢焦点（守卫，与语音卡那条完全一致）
        micState = notRecording;
        await sleep(400);
        var otherEl = document.getElementById('other');
        otherEl.focus();
        var docp6 = document.getElementById('docp');
        selectIn(docp6, 'the migration ran long');
        mouseUpOn(docp6);
        await waitFor(function () { return scope.quoteBtn && scope.quoteBtn.style.display !== 'none'; }, 1200);
        var quotesGuard = (scope.hook.quotes() || []).length;
        micState = recording;
        await sleep(600);
        check('别处正在打字：不加引用', (scope.hook.quotes() || []).length === quotesGuard, JSON.stringify((scope.hook.quotes() || []).map(function (q) { return q.text; })));
        check('别处正在打字：不抢焦点（人家的听写不能被拽进小窗）', document.activeElement === otherEl, document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : 'null');
        // 收尾
        micState = notRecording;
        if (otherEl)
            otherEl.blur();
        scope.hook.close();
        await sleep(60);
    }
}
