/** Browser scenario serialized into the isolated panel fixture page. */
export async function runPill(scope) {
    // ⑪ 胶囊宽度：**有**费用胶囊就跟随它，**没有**就收到 PILL_FALLBACK_MAX = 200px（用户定的规则）
    //    这条只有真浏览器能量：要真布局（getBoundingClientRect）、真 CSS（max-width 生效），
    //    还要能挂一个假的 dsh-spend 挂载点。
    {
        var pillNode = scope.hook.pill();
        var pillName = pillNode.querySelector('.dsh-sel-pillname');
        var pillMeta = pillNode.querySelector('.dsh-sel-pillmeta');
        var savedName = pillName.textContent;
        var savedMeta = pillMeta.textContent;
        // 先确认"动画是声明过的"（冻住之后就量不出来了）：收球/吸附靠 max-width / padding / gap / 位置的过渡
        var pillTrans = getComputedStyle(pillNode).transitionProperty;
        check('胶囊声明了过渡（收球/吸附是动画，不是跳变）', /max-width/.test(pillTrans) && /padding/.test(pillTrans) && /left/.test(pillTrans), pillTrans);
        check('过渡只在"第一帧已经贴好位置"之后才打开（data-ready）', scope.hook.pillState().ready === true, String(scope.hook.pillState().ready));
        // 收 / 放**严格互逆**的结构前提：所有会变的属性共用同一条时长 + 同一条曲线，
        // 而且那条曲线必须时间对称（x1+x2=1 且 y1+y2=1 → 把动画倒过来放就是另一个方向）。
        // 之前用 easeOutQuint(.22,1,.36,1)：.22+.36≠1，两个方向前后半程不镜像 —— 用户报的"不对称"就是它。
        var durList = splitCssList(getComputedStyle(pillNode).transitionDuration);
        var easeList = splitCssList(getComputedStyle(pillNode).transitionTimingFunction);
        var morphDur = durList.slice(1); // 第 0 条是 box-shadow 的 .15s，不属于形变
        var morphEase = easeList.slice(1);
        check('收/放所有属性共用一条时长', morphDur.length > 0 && morphDur.every(function (x) { return x === morphDur[0]; }), durList.join(' | '));
        check('收/放所有属性共用一条曲线', morphEase.length > 0 && morphEase.every(function (x) { return x === morphEase[0]; }), easeList.join(' | '));
        // 不用正则：这段代码在模板字符串里，( 这种转义会被吃掉（踩过）
        var easeText = morphEase[0] || '';
        var easeAt = easeText.indexOf('cubic-bezier(');
        var easeArgs = easeAt >= 0
            ? easeText.slice(easeAt + 'cubic-bezier('.length, -1).split(',').map(function (x) { return Number(x.trim()); })
            : [];
        check('曲线时间对称（x1+x2=1 且 y1+y2=1 → 倒放即另一个方向）', easeArgs.length === 4 && Math.abs(easeArgs[0] + easeArgs[2] - 1) < 1e-6 && Math.abs(easeArgs[1] + easeArgs[3] - 1) < 1e-6, easeText + ' → ' + JSON.stringify(easeArgs));
        var nameDur = splitCssList(getComputedStyle(pillName).transitionDuration)[0];
        var starEl = pillNode.querySelector('.dsh-sel-pillstar');
        var starTrans = getComputedStyle(starEl);
        check('文字那格的时长和胶囊一致（不一致 → 中间帧宽度由另一条曲线决定）', nameDur === morphDur[0], nameDur + ' vs ' + morphDur[0]);
        // ── 球心图形的形变轨迹（这一组是重点：光看两端点会漏掉中间帧的形状） ──
        // 曾经踩过的坑：用 CSS 的 transition:d 在两条静态 path 之间插值 —— CSS 只能线性插值，
        // 于是中途会经过一个正菱形（谷跟着尖一起动），读起来像方块；而且尖在 160ms 就停住、
        // 胶囊还要走到 280ms，"配合"就散了。所以现在路径由 JS 按 p 现算（两段 smoothstep）。
        check('球心图形不走 CSS 的 d 过渡（线性插值会经过正菱形）', starTrans.transitionProperty.trim() !== 'd', starTrans.transitionProperty.trim() || '(无过渡)');
        var radiiAt = function (p) {
            // 不写正则：模板字符串里反斜杠会被吃掉。按 M/L 切段再取两个数。
            var parts = String(scope.hook.pillStarAt(p)).split('L');
            parts[0] = parts[0].charAt(0) === 'M' ? parts[0].slice(1) : parts[0];
            return parts.map(function (seg) {
                var z = seg.indexOf('Z');
                if (z >= 0)
                    seg = seg.slice(0, z);
                var xy = seg.split(' ');
                return Math.sqrt(parseFloat(xy[0]) * parseFloat(xy[0]) + parseFloat(xy[1]) * parseFloat(xy[1]));
            });
        };
        var r0 = radiiAt(0);
        var r25 = radiiAt(0.25);
        var r50 = radiiAt(0.5);
        var r80 = radiiAt(0.8);
        var r100 = radiiAt(1);
        check('p=0：32 个顶点同半径 4.00（8px 圆点）', r0.length === 32 && r0.every(function (r) { return Math.abs(r - 4) < 0.02; }), r0.length + ' 顶点，半径 ' + r0[0].toFixed(3));
        check('p=0.25：谷仍停在 4.00（"两段"的签名 —— 线性插值会把它拉到 3.80，那就是菱形相）', Math.abs(r25[4] - 4) < 0.02, '谷 ' + r25[4].toFixed(3));
        check('p=0.25：尖已经在长（> 4 但远未到顶，尖先长）', r25[0] > 4.3 && r25[0] < r100[0] - 0.5, '尖 ' + r25[0].toFixed(3) + '（顶 ' + r100[0].toFixed(2) + '）');
        check('p=0.5：尖接近满长（≥ 顶-0.6），身刚开始收（谷仍 > 3.6）', r50[0] >= r100[0] - 0.6 && r50[4] > 3.6, '尖 ' + r50[0].toFixed(2) + ' / 谷 ' + r50[4].toFixed(2));
        // 同一个 p 下，从尖到谷的半径必须单调递减（尖 > 11.25° > 22.5° > 33.75° > 谷），
        // 且左右对称 —— 这就是"不出现波浪边"的可测形式。
        var sectorOk = function (r) {
            var k;
            for (k = 0; k < 4; k += 1)
                if (r[k] < r[k + 1] - 0.02)
                    return false;
            for (k = 1; k < 16; k += 1)
                if (Math.abs(r[k] - r[32 - k]) > 0.02)
                    return false;
            return true;
        };
        check('同一进度下：尖→谷单调递减且左右对称（没有波浪边）', sectorOk(r25) && sectorOk(r50) && sectorOk(radiiAt(0.8)), JSON.stringify(r50.map(function (r) { return Number(r.toFixed(2)); }).slice(0, 5)));
        // 形状空间的过冲：尖在 p≈0.8 处冲过终点一点，到 p=1 精确回到终点
        check('尖有轻微过冲（p=0.8 处高出终点一点，再收回）', r80[0] > r100[0] + 0.05, 'p=.8 尖 ' + r80[0].toFixed(3) + ' / p=1 尖 ' + r100[0].toFixed(3));
        check('p=1 的路径与客户端常量逐字相同（和「✦ 解读」那颗星同一条几何）', scope.hook.pillStarAt(1) === scope.hook.pillStarD(), scope.hook.pillStarAt(1) === scope.hook.pillStarD() ? '逐字一致' : '不一致');
        check('p=0 的路径与客户端常量逐字相同（展开态就是那枚 8px 圆点）', scope.hook.pillStarAt(0) === scope.hook.pillStarDotD(), scope.hook.pillStarAt(0) === scope.hook.pillStarDotD() ? '逐字一致' : '不一致');
        // 曲线：时间对称（倒放即另一个方向）+ 轻微蓄势/过冲（不直来直去）
        var xs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
        var ys = xs.map(function (x) { return scope.hook.pillStarEaseAt(x); });
        var symOk = xs.every(function (x) { return Math.abs(scope.hook.pillStarEaseAt(x) + scope.hook.pillStarEaseAt(1 - x) - 1) < 1e-6; });
        check('球心图形的曲线时间对称（收/放互为倒放）', symOk, ys.map(function (y) { return y.toFixed(3); }).join(' '));
        // 曲线本身要"干净"（单调 S，不能是波浪）：过冲放在形状空间，不放在时间轴上
        var monotone = true;
        for (var mi = 1; mi < xs.length; mi += 1)
            if (scope.hook.pillStarEaseAt(xs[mi]) <= scope.hook.pillStarEaseAt(xs[mi - 1]))
                monotone = false;
        check('时间轴上的曲线是干净单调的 S（过冲不放在这里 —— 对称曲线的过冲必成波浪）', monotone && ys[0] > 0 && ys[ys.length - 1] < 1, ys.map(function (y) { return y.toFixed(3); }).join(' '));
        check('JS 那条时长与 CSS 那条同拍（280ms ↔ .28s）', scope.hook.pillMorphMs() === 280 && morphDur[0] === '0.28s', scope.hook.pillMorphMs() + 'ms vs ' + morphDur[0]);
        freezeMotion();
        // 最坏内容（选中文字 12 字 + 最长状态）：自然宽度 301px，最容易被上限拦到
        pillName.textContent = '迁移作业耗时超出了原计划…';
        pillMeta.textContent = '· 追问中 12.3s';
        // ① 没有费用胶囊 → 兜底上限 200
        scope.hook.place();
        check('没有费用胶囊：上限收到 200px', pillNode.style.maxWidth === '200px', pillNode.style.maxWidth || '(空 = 回落 CSS 280)');
        check('没有费用胶囊：不写死宽度（内容自适应）', pillNode.style.width === '', pillNode.style.width || '(空)');
        var cappedWidth = Math.round(pillNode.getBoundingClientRect().width);
        check('没有费用胶囊：最坏内容也真的被拦在 200px', cappedWidth === 200, cappedWidth + 'px');
        check('没有费用胶囊：拦到上限后选中文字走省略号（不撑破）', pillName.scrollWidth > pillName.clientWidth, pillName.clientWidth + 'px 可见 / ' + pillName.scrollWidth + 'px 全长');
        // ② 挂一个假的费用胶囊（宽 240）→ 跟随它的实测宽度，并清掉兜底上限
        var fakeSpend = document.createElement('div');
        fakeSpend.id = 'dsh-spend-widget';
        fakeSpend.innerHTML = '<div class="dsu-widget" style="position:fixed;right:20px;bottom:20px">'
            + '<div class="dsu-pill" style="box-sizing:border-box;width:240px;height:32px"></div></div>';
        document.body.appendChild(fakeSpend);
        scope.hook.place();
        check('有费用胶囊：宽度写死成它的实测宽度', pillNode.style.width === '240px', pillNode.style.width || '(空)');
        check('有费用胶囊：清掉兜底上限（回到 CSS 280，和它同宽）', pillNode.style.maxWidth === '', pillNode.style.maxWidth || '(空)');
        // ⚠️ 宽度现在有过渡（.32s）：改完立刻量会量到**起点**，得等它走完
        await sleep(420);
        var followedWidth = Math.round(pillNode.getBoundingClientRect().width);
        check('有费用胶囊：最坏内容跟着它到 240px（上限确实放开了）', followedWidth === 240, followedWidth + 'px');
        // ③ 费用胶囊消失 → 立刻回到兜底
        fakeSpend.remove();
        scope.hook.place();
        check('费用胶囊消失后又回到 200px 兜底', pillNode.style.maxWidth === '200px' && pillNode.style.width === '', pillNode.style.maxWidth + ' / ' + (pillNode.style.width || '宽=空'));
        // ⚠️ 这里必须把"最坏内容"重新写一遍再量：paintPill() 会在异步里把文案换回**真实内容**
        //    （真实内容自然宽 184px < 200，于是量到 184 而不是 200）—— 这条断言想验的是
        //    "上限回到 200"，不是"内容恰好 301px"，写回最坏内容才与内容变化解耦（否则偶发红）。
        pillName.textContent = '迁移作业耗时超出了原计划…';
        pillMeta.textContent = '· 追问中 12.3s';
        await sleep(420);
        check('回到兜底后宽度也收回来了', Math.round(pillNode.getBoundingClientRect().width) === 200, Math.round(pillNode.getBoundingClientRect().width) + 'px');
        // 还原内容（后面的断言不受影响）
        pillName.textContent = savedName;
        pillMeta.textContent = savedMeta;
        scope.hook.place();
    }
    // ⑫ 胶囊可以拖：拖到别处就留在那儿；拖回右下角附近自动吸附回去；拖完那一下不算点击。
    //    全用真鼠标事件（mousedown 打在胶囊上，mousemove/mouseup 打在 window —— 和面板拖动同一套）。
    //    过渡已在 ⑪ 冻住（见 freezeMotion），所以每一步都能**同步**断言，不用等动画。
    {
        var pillEl = scope.hook.pill();
        var panelOpen = function () {
            return scope.hook.quoteState().panelOpen === true;
        };
        function fire(type, x, y, onWindow) {
            var event = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 });
            if (onWindow)
                window.dispatchEvent(event);
            else
                pillEl.dispatchEvent(event);
        }
        function dragTo(x, y) {
            var rect = pillEl.getBoundingClientRect();
            fire('mousedown', Math.round(rect.left) + 20, Math.round(rect.top) + 10, false);
            fire('mousemove', x, y, true);
            fire('mousemove', x + 4, y + 2, true); // 第二下：确保"位移超过阈值"这条判定走完
            fire('mouseup', x + 4, y + 2, true);
        }
        /** 拖到右下角那一带（吸附区）—— 用视口右下角算，和"贴角位置"差得不多，必落在吸附半径里。 */
        function dragToCorner() {
            dragTo(Math.round(window.innerWidth - 30), Math.round(window.innerHeight - 30));
        }
        scope.hook.place();
        var home = scope.hook.pillState();
        check('起始：贴着右下角（dock=anchor，right/bottom=20）', home.dock === 'anchor' && home.rect.right === 20 && home.rect.bottom === 20, home.dock + ' ' + home.rect.right + '/' + home.rect.bottom);
        // ① 拖到屏幕中间 → 留在那儿（自由摆放）
        var midX = Math.round(window.innerWidth / 2);
        var midY = Math.round(window.innerHeight / 2);
        dragTo(midX, midY);
        var free = scope.hook.pillState();
        check('拖到屏幕中间：位置跟着走了（dock=free）', free.dock === 'free', free.dock);
        check('拖到屏幕中间：落在松手的地方（±40px）', Math.abs(free.rect.left + 20 - midX) < 40 && Math.abs(free.rect.top + 10 - midY) < 40, free.rect.left + ',' + free.rect.top);
        // 自由摆放时，贴角轮询不许把它拽回去
        scope.hook.place();
        var stillFree = scope.hook.pillState();
        check('自由摆放时轮询不把它拽回去', stillFree.dock === 'free' && Math.abs(stillFree.rect.left - free.rect.left) <= 2, stillFree.dock + ' ' + stillFree.rect.left);
        // ② 拖回右下角附近 → 自动吸附回贴角位置（没有费用胶囊就是 20/20）
        dragToCorner();
        var snapped = scope.hook.pillState();
        check('拖回右下角附近：自动吸附（dock=anchor）', snapped.dock === 'anchor', snapped.dock);
        check('吸附回右下角 20/20', snapped.rect.right === 20 && snapped.rect.bottom === 20, snapped.rect.right + '/' + snapped.rect.bottom);
        // ③ 拖完浏览器会补一个 click —— 不能被当成"点了一下"（否则会顺手开关小窗）
        if (panelOpen())
            scope.hook.close();
        dragTo(midX, midY);
        fire('click', midX, midY, false); // 模拟浏览器在拖完之后补的那一下
        check('拖完那一下不算点击（小窗没被打开）', panelOpen() === false, String(panelOpen()));
        check('拖完那一下也不算"点开"（胶囊还在自由摆放位）', scope.hook.pillState().dock === 'free', scope.hook.pillState().dock);
        // ④ 有费用胶囊时：拖到右下角附近 → 吸附到"跟随它的位置"（在那枚胶囊上方、同宽）
        var fakeSpend2 = document.createElement('div');
        fakeSpend2.id = 'dsh-spend-widget';
        fakeSpend2.innerHTML = '<div class="dsu-widget" style="position:fixed;right:20px;bottom:20px">'
            + '<div class="dsu-pill" style="box-sizing:border-box;width:240px;height:32px"></div></div>';
        document.body.appendChild(fakeSpend2);
        scope.hook.place();
        dragToCorner();
        var withSpend = scope.hook.pillState();
        check('有费用胶囊时拖到右下角：吸附到跟随它的位置', withSpend.dock === 'anchor' && withSpend.rect.right === 20, withSpend.dock + ' right=' + withSpend.rect.right);
        check('吸附后宽度是跟随它的 240px', withSpend.rect.width === 240, withSpend.rect.width + 'px');
        check('吸附位置在费用胶囊**上方**（不压住它）', withSpend.rect.bottom >= 42, 'bottom=' + withSpend.rect.bottom);
        // 再拖走 → 留在那儿；再拖回 → 又吸附回去
        dragTo(midX, midY);
        check('有费用胶囊时也能拖走（dock=free）', scope.hook.pillState().dock === 'free', scope.hook.pillState().dock);
        dragToCorner();
        var backHome = scope.hook.pillState();
        check('再拖回右下角：又吸附回去', backHome.dock === 'anchor' && backHome.rect.right === 20, backHome.dock + ' right=' + backHome.rect.right);
        fakeSpend2.remove();
        scope.hook.place();
        // ⑤ 没动的那一下仍然是"点击"（拖动不能把点击吃掉）
        if (panelOpen())
            scope.hook.close();
        var clickRect = pillEl.getBoundingClientRect();
        fire('mousedown', Math.round(clickRect.left) + 20, Math.round(clickRect.top) + 10, false);
        fire('mouseup', Math.round(clickRect.left) + 20, Math.round(clickRect.top) + 10, true);
        fire('click', Math.round(clickRect.left) + 20, Math.round(clickRect.top) + 10, false);
        await sleep(160);
        check('没位移的那一下照旧是点击（小窗打开了）', panelOpen() === true, String(panelOpen()));
        scope.hook.close();
        // 关小窗会让面板尺寸变 0 → 面板那个 ResizeObserver 会补一次 placePanel→paintPill（= 一次"活动"）。
        // 生产上无所谓（只是把静置计时重新拨满），测试里得先把这拍异步排掉，否则会和下面的收球抢时序。
        await sleep(200);
    }
    // ⑬ 静置收球：**没有费用胶囊**时收成小球；有费用胶囊 / 小窗开着 / 鼠标停着都不收。
    //    过渡已冻住，所以"收成 32×32"是同步可断言的；"到底有没有过渡"在 ⑪ 用 computed style 断言过。
    {
        var pillBall = scope.hook.pill();
        scope.panelIsOpen = function () {
            return scope.hook.quoteState().panelOpen === true;
        };
        if (scope.panelIsOpen())
            scope.hook.close();
        await sleep(200);
        var before = scope.hook.pillState();
        check('收球前是展开的胶囊', before.ball === false && before.rect.width > 100, before.rect.width + 'px');
        var anchoredRightBefore = window.innerWidth - before.rect.right;
        var idleCollapsed = scope.hook.pillIdle();
        var balled = scope.hook.pillState();
        check('没有费用胶囊 → 静置收球', idleCollapsed === true && balled.ball === true, JSON.stringify(balled.style));
        check('收成小球：32×32 的圆', balled.rect.width === balled.ballSize && balled.rect.height === balled.ballSize, balled.rect.width + '×' + balled.rect.height);
        check('小球仍然贴着右下角（位置没跑）', balled.rect.right === 20 && balled.rect.bottom === 20, balled.rect.right + '/' + balled.rect.bottom);
        check('锚定态收球：以胶囊自己的右边缘为锚（右边缘不动，往左收成球）', Math.abs((window.innerWidth - balled.rect.right) - anchoredRightBefore) <= 1, '右边缘 ' + anchoredRightBefore.toFixed(1) + ' → ' + (window.innerWidth - balled.rect.right).toFixed(1));
        // ── 球心里的星芒：收球时 d 换成星、展开时换回圆点，几何都得对得上 ──
        //    球心图形是 JS 按时间推进的（胶囊那条是 CSS 过渡，被 freezeMotion 冻成瞬时），
        //    所以分三件事验：① 目标对不对（同步）② 计时器真的在推进（短等几拍）③ 终态几何（同步画到终点再量）。
        //    ⚠️ 不能靠"等 280ms 再看"：这段时间里任何一次活动（比如首轮解读流式结束后的 paintPill）
        //       都会按设计把球展开回胶囊，等出来的就不是球态了。
        var starCanvas = pillBall.querySelector('.dsh-sel-pillicon');
        var starPath = pillBall.querySelector('.dsh-sel-pillstar');
        var starWant = scope.hook.pillStarD();
        var dotWant = scope.hook.pillStarDotD();
        check('收球时球心图形的目标是"星芒"（1）', scope.hook.pillStarTarget() === 1, String(scope.hook.pillStarTarget()));
        // "计时器真的在推进"用解耦的钩子验（不依赖胶囊此刻是不是球态 ——
        //  首轮解读收尾时 paintPill→notePillActivity 会按设计把球展开，和这条无关）
        scope.hook.pillStarAnimate(0);
        var pAtStart = scope.hook.pillStarProgress();
        scope.hook.pillStarAnimate(1);
        var grew = false;
        for (var tick = 0; tick < 12 && !grew; tick += 1) {
            await sleep(24);
            if (scope.hook.pillStarProgress() > pAtStart + 0.05)
                grew = true;
        }
        check('球心图形的动画真的在推进（计时器在跑，不是画一帧就停）', grew, pAtStart.toFixed(3) + ' → ' + scope.hook.pillStarProgress().toFixed(3));
        // 球态的画布居中：这是 CSS 那边的事（margin 过渡），冻住运动后是瞬时终值，可以同步量。
        // ⚠️ 先显式确保还在球态：上面的等待里任何一次活动都会按设计把球展开。
        if (scope.hook.pillState().ball !== true) {
            scope.hook.pillIdle();
            await sleep(80);
        }
        check('（前置）此刻确实是球态，下面量的是球心几何', scope.hook.pillState().ball === true, String(scope.hook.pillState().ball));
        var ballRect = pillBall.getBoundingClientRect();
        var canvasRect = starCanvas.getBoundingClientRect();
        check('星芒在球里居中（图形中心 = 球的中心，±0.6px）', Math.abs(canvasRect.left + canvasRect.width / 2 - (ballRect.left + ballRect.width / 2)) <= 0.6, '画布中心 ' + (canvasRect.left + canvasRect.width / 2).toFixed(1) + ' vs 球中心 ' + (ballRect.left + ballRect.width / 2).toFixed(1));
        check('球态画布用 -1px 负边距摆正（内宽 32-2 边框 = 30）', getComputedStyle(starCanvas).marginLeft === '-1px', getComputedStyle(starCanvas).marginLeft);
        // 同步画到终点，再量终态几何（不受计时器与异步活动影响）
        scope.hook.pillStarTo(1);
        var starD = starPath.getAttribute('d');
        var starBox = starPath.getBBox();
        check('收球终态：d 与客户端那条常量逐字相同', starD === starWant, starD === starWant ? '32 顶点一致' : starD.slice(0, 18) + '… ≠ ' + starWant.slice(0, 18));
        var pillFontSize = parseFloat(getComputedStyle(pillBall).fontSize);
        check('星芒和胶囊里的文字一样高（墨迹 ≈ 字号，±0.8px）', Math.abs(starBox.height - pillFontSize) <= 1.0 && Math.abs(starBox.width - starBox.height) < 0.15, '星芒 ' + starBox.width.toFixed(2) + '×' + starBox.height.toFixed(2) + ' vs 字号 ' + pillFontSize + 'px');
        check('星芒的内外半径比 = .3788（和「✦ 解读」浮标那颗星同一条几何，只是缩小了）+ 顶点数 32', Math.abs(r100[0] / r100[4] - 1 / 0.3788) < 0.05 && r100.length === 32, '尖 ' + r100[0].toFixed(2) + ' / 谷 ' + r100[4].toFixed(2) + ' = ' + (r100[0] / r100[4]).toFixed(3) + '（应为 2.640）');
        // 鼠标一放上去就展开（若已被异步活动展开过，先收回球态，好让 mouseenter 真的走一次展开）
        if (scope.hook.pillState().ball !== true) {
            scope.hook.pillIdle();
            await sleep(80);
        }
        pillBall.dispatchEvent(new MouseEvent('mouseenter', { view: window }));
        var expanded = scope.hook.pillState();
        check('鼠标移上去：小球展开回胶囊', expanded.ball === false && expanded.rect.width > 100, expanded.rect.width + 'px');
        check('锚定态展开：右边缘同样不动（往右长回去）', Math.abs((window.innerWidth - expanded.rect.right) - anchoredRightBefore) <= 1, '右边缘 ' + anchoredRightBefore.toFixed(1) + ' → ' + (window.innerWidth - expanded.rect.right).toFixed(1));
        // 展开态：图形回到 8px 圆点，且画布**布局占位**仍是 8px（两侧 -12px）——
        // 这样胶囊的排版与宽度和以前那枚 8px 圆点完全一样，不会因为换了个 SVG 就把胶囊撑宽。
        check('展开时球心图形的目标是"圆点"（0）', scope.hook.pillStarTarget() === 0, String(scope.hook.pillStarTarget()));
        // 真实悬停路径：展开会重置静置计时，不能因此取消球心图形的动画。
        pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }));
        if (scope.hook.pillState().ball !== true)
            scope.hook.pillIdle();
        scope.hook.pillStarTo(1);
        pillBall.dispatchEvent(new MouseEvent('mouseenter', { view: window }));
        await sleep(350);
        check('悬停展开后星芒自行回到圆点', scope.hook.pillState().ball === false && scope.hook.pillStarProgress() === 0 && starPath.getAttribute('d') === dotWant, 'ball=' + scope.hook.pillState().ball + ' progress=' + scope.hook.pillStarProgress());
        scope.hook.pillStarTo(0); // 同步画回圆点，量终态
        var dotD = pillBall.querySelector('.dsh-sel-pillstar').getAttribute('d');
        var dotBox = pillBall.querySelector('.dsh-sel-pillstar').getBBox();
        var iconCanvas = pillBall.querySelector('.dsh-sel-pillicon');
        var iconStyle = getComputedStyle(iconCanvas);
        var pillRectForDot = pillBall.getBoundingClientRect();
        var canvasForDot = iconCanvas.getBoundingClientRect();
        var dotRect = starPath.getBoundingClientRect();
        var dotCx = dotRect.left + dotRect.width / 2;
        var dotCy = dotRect.top + dotRect.height / 2;
        var canvasCx = canvasForDot.left + canvasForDot.width / 2;
        var pillCy = pillRectForDot.top + pillRectForDot.height / 2;
        check('展开后圆点墨迹居中：横向在 SVG 画布中心，纵向在胶囊中心', Math.abs(dotCx - canvasCx) < 0.25 && Math.abs(dotCy - pillCy) < 0.25, '偏移 x=' + (dotCx - canvasCx).toFixed(2) + ' y=' + (dotCy - pillCy).toFixed(2));
        check('展开后回到圆点态：d 与客户端那条常量**逐字相同**', dotD === dotWant, dotD === dotWant ? '32 顶点一致' : dotD.slice(0, 14) + '… ≠ ' + dotWant.slice(0, 14));
        // 这条是补覆盖：上面用 pillStarTo(0) 同步画到终点，验的是"终点长什么样"，
        // 但"展开这条动画**自己**会不会走到终点"没验过 —— 用户报的"展开后没恢复成圆点"正是这里。
        scope.hook.pillStarAnimate(1);
        await sleep(60);
        scope.hook.pillStarAnimate(0);
        var settled = false;
        for (var settleTick = 0; settleTick < 24 && !settled; settleTick += 1) {
            await sleep(24);
            if (scope.hook.pillStarProgress() === 0)
                settled = true;
        }
        check('展开动画自己会走到圆点（不是停在星芒上）', settled, 'progress=' + scope.hook.pillStarProgress());
        // 用户报的"展开后没恢复成圆点"，根因是**打断**：来回打断时每一段都跑满 280ms，
        // 于是图形永远追不上目标（实测序列 10101010、进度卡在 0.158）。
        // 这里用高频交替打断复现它，然后断言"停手之后能很快落到目标上"。
        // （比"等悬停那一下走完"稳：冒烟跑在虚拟时钟下，10 秒静置会瞬间到期、球态随时可能翻。）
        scope.hook.pillStarAnimate(0);
        for (var ham = 0; ham < 8; ham += 1) {
            scope.hook.pillStarAnimate(1);
            await sleep(16);
            scope.hook.pillStarAnimate(0);
            await sleep(16);
        }
        var settleTicks = -1;
        for (var st = 0; st < 40 && settleTicks < 0; st += 1) {
            await sleep(24);
            if (scope.hook.pillStarProgress() === 0)
                settleTicks = st + 1;
        }
        check('来回打断之后图形仍会落到目标上，且很快（不再卡在半路）', settleTicks > 0 && settleTicks <= 6, '停手后第 ' + settleTicks + ' 拍到位（每拍 24ms）· progress=' + scope.hook.pillStarProgress() + ' · 起跑=' + scope.hook.pillStarStarts());
        pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }));
        check('圆点态墨迹 8×8（和以前那枚 8px 圆点一致）', Math.abs(dotBox.width - 8) < 0.1 && Math.abs(dotBox.height - 8) < 0.1, dotBox.width.toFixed(2) + '×' + dotBox.height.toFixed(2));
        check('展开态画布布局占位 = 8px（两侧 -12px 负边距）', iconStyle.marginLeft === '-12px' && iconStyle.marginRight === '-12px', iconStyle.marginLeft + '/' + iconStyle.marginRight);
        check('展开态画布本身仍是 32px（1 单位 = 1px，几何数字照抄设计稿）', iconStyle.width === '32px' && iconStyle.height === '32px', iconStyle.width + '×' + iconStyle.height);
        check('展开后还是贴右下角', expanded.rect.right === 20 && expanded.rect.bottom === 20, expanded.rect.right + '/' + expanded.rect.bottom);
        // 鼠标离开 → 又能收
        pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }));
        check('鼠标离开后静置又能收球', scope.hook.pillIdle() === true && scope.hook.pillState().ball === true, String(scope.hook.pillState().ball));
        // 鼠标停在上面时不许收（"点得到"优先于"藏起来"）
        pillBall.dispatchEvent(new MouseEvent('mouseenter', { view: window }));
        check('鼠标停在小球上时不收球', scope.hook.pillIdle() === false && scope.hook.pillState().ball === false, String(scope.hook.pillState().ball));
        pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }));
        // 自由摆放时收球/展开都以**右边缘**为锚（往左收成球、往右展开回原样，右边缘一个像素都不动）
        // 这条只有真浏览器能验：要真布局量矩形、真过渡（这里已冻住 → 量到的是终值）。
        {
            var homeRect = scope.hook.pillState().rect;
            scope.hook.pillIdle(); // 先收起来（锚定态）
            var anchored = scope.hook.pillState();
            var midX2 = Math.round(window.innerWidth / 2);
            var midY2 = Math.round(window.innerHeight / 2);
            pillBall.dispatchEvent(new MouseEvent('mouseenter', { view: window })); // 展开再拖（拖的是展开态）
            pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }));
            var r0 = pillBall.getBoundingClientRect();
            var fireOn = function (type, x, y, onWindow) {
                var event = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 });
                if (onWindow)
                    window.dispatchEvent(event);
                else
                    pillBall.dispatchEvent(event);
            };
            fireOn('mousedown', Math.round(r0.left) + 20, Math.round(r0.top) + 10, false);
            fireOn('mousemove', midX2, midY2, true);
            fireOn('mousemove', midX2 + 4, midY2 + 2, true);
            fireOn('mouseup', midX2 + 4, midY2 + 2, true);
            var wideFree = scope.hook.pillState();
            check('自由摆放（拖到中间）', wideFree.dock === 'free' && wideFree.rect.width > 100, wideFree.dock + ' ' + wideFree.rect.width);
            check('自由摆放使用固定的 CSS right 定位，使过渡每一帧都能守住右边缘', wideFree.style.left === 'auto' && wideFree.style.right !== 'auto' && wideFree.style.right !== '', 'left=' + wideFree.style.left + ' right=' + wideFree.style.right);
            var rightBefore = wideFree.rect.right;
            scope.hook.pillIdle();
            var ballFree = scope.hook.pillState();
            check('自由摆放时收球：右边缘不动（±1px，往左收成球）', ballFree.ball === true && Math.abs(ballFree.rect.right - rightBefore) <= 1, '右边缘 ' + rightBefore.toFixed(1) + ' → ' + ballFree.rect.right.toFixed(1));
            var geoRightBefore = window.innerWidth - rightBefore;
            var geoRightBall = window.innerWidth - ballFree.rect.right;
            check('自由摆放时收球：球确实贴到了右边缘（球右边 = 原胶囊右边，球宽 32）', Math.abs(geoRightBall - geoRightBefore) <= 1 && ballFree.rect.width === ballFree.ballSize, '几何右边 ' + geoRightBefore.toFixed(1) + ' → ' + geoRightBall.toFixed(1) + '，球宽 ' + ballFree.rect.width);
            pillBall.dispatchEvent(new MouseEvent('mouseenter', { view: window }));
            var wideAgain = scope.hook.pillState();
            check('自由摆放时展开：右边缘也不动（±1px）', wideAgain.ball === false && Math.abs(wideAgain.rect.right - rightBefore) <= 1, '右边缘 ' + rightBefore.toFixed(1) + ' → ' + wideAgain.rect.right.toFixed(1));
            await sleep(30); // 存档是异步 POST
            check('拖到别处后把位置存到了 host 上（右边缘 + 垂直中心）', pillPosStore && Math.abs(pillPosStore.right - (window.innerWidth - wideFree.rect.right)) <= 2, JSON.stringify(pillPosStore) + ' vs 几何右边 ' + (window.innerWidth - wideFree.rect.right).toFixed(1));
            // 读回来：预置一个位置，调钩子，胶囊应当切成自由摆放并摆到那儿（右边缘为锚）
            pillPosStore = { right: 300, y: 220 };
            scope.hook.loadPillPos();
            await sleep(60);
            var restored = scope.hook.pillState();
            check('重挂载读回 host 上的位置：切成自由摆放并摆回去（右边缘 = 存档）', restored.dock === 'free' && Math.abs(window.innerWidth - restored.rect.right - 300) <= 2, 'dock=' + restored.dock + ' 几何右边 ' + (window.innerWidth - restored.rect.right).toFixed(1) + '（存档 300）');
            // 再拖回中间，接着跑下面的"收球右边缘不动"
            pillPosStore = null;
            scope.hook.loadPillPos();
            await sleep(0);
            pillBall.dispatchEvent(new MouseEvent('mouseleave', { view: window }));
            // 拖回右下角，后面的断言接着用锚定态
            var frozenStyle = document.getElementById('freeze-motion');
            fireOn('mousedown', Math.round(pillBall.getBoundingClientRect().left) + 20, Math.round(pillBall.getBoundingClientRect().top) + 10, false);
            fireOn('mousemove', Math.round(window.innerWidth - 30), Math.round(window.innerHeight - 30), true);
            frozenStyle.remove(); // 拖动中 data-drag 会关过渡，此时解除全局冻结，不会让胶囊跳
            fireOn('mouseup', Math.round(window.innerWidth - 30), Math.round(window.innerHeight - 30), true);
            var snapAnimated = pillBall.getAnimations().some(function (animation) { return animation.transitionProperty === 'left'; });
            check('自由摆放从 CSS right 切回吸附时仍有滑行动画', snapAnimated, String(snapAnimated));
            document.head.appendChild(frozenStyle);
            check('拖回右下角后又吸附（回到 anchor）', scope.hook.pillState().dock === 'anchor', JSON.stringify(scope.hook.pillState()));
            await sleep(30);
            check('吸附回右下角后清掉 host 上的存档（那是默认位置，不用记）', pillPosStore === null, JSON.stringify(pillPosStore));
            check('锚定位置和最初一致', Math.abs(scope.hook.pillState().rect.left - homeRect.left) <= 2, scope.hook.pillState().rect.left + ' vs ' + homeRect.left);
            void anchored;
        }
        // 有费用胶囊时不收球（收球的前提是"没有可跟随的胶囊"）
        var fakeSpend3 = document.createElement('div');
        fakeSpend3.id = 'dsh-spend-widget';
        fakeSpend3.innerHTML = '<div class="dsu-widget" style="position:fixed;right:20px;bottom:20px">'
            + '<div class="dsu-pill" style="box-sizing:border-box;width:240px;height:32px"></div></div>';
        document.body.appendChild(fakeSpend3);
        scope.hook.place();
        check('有费用胶囊时静置也不收球', scope.hook.pillIdle() === false, String(scope.hook.pillState().ball));
        check('有费用胶囊时保持展开', scope.hook.pillState().ball === false, String(scope.hook.pillState().ball));
        // 收着球时费用胶囊出现 → 立刻展开（球没有存在的意义了）
        fakeSpend3.remove();
        scope.hook.place();
        check('静置收球后费用胶囊出现 → 立刻展开', scope.hook.pillIdle() === true && scope.hook.pillState().ball === true, String(scope.hook.pillState().ball));
        document.body.appendChild(fakeSpend3);
        scope.hook.place();
        check('费用胶囊一出现，小球立刻展开', scope.hook.pillState().ball === false && scope.hook.pillState().rect.width === 240, scope.hook.pillState().ball + ' ' + scope.hook.pillState().rect.width);
        fakeSpend3.remove();
        scope.hook.place();
        // 小窗开着时不收球（"小窗活动"也是活动）
        scope.hook.open('收球冒烟：小窗开着', '上下文', '冒烟');
        await sleep(200);
        check('小窗开着时不收球', scope.hook.pillIdle() === false, String(scope.hook.pillState().ball));
        scope.hook.close();
        await sleep(200);
        check('小窗关掉后又能收球', scope.hook.pillIdle() === true && scope.hook.pillState().ball === true, String(scope.hook.pillState().ball));
        // 收着球也能点开（小球仍然是个按钮）
        var ballRect = pillBall.getBoundingClientRect();
        var bx = Math.round(ballRect.left) + 16;
        var by = Math.round(ballRect.top) + 16;
        pillBall.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: bx, clientY: by, button: 0 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: bx, clientY: by, button: 0 }));
        pillBall.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: bx, clientY: by }));
        await sleep(200);
        check('小球状态点一下照样打开小窗', scope.panelIsOpen() === true, String(scope.panelIsOpen()));
        scope.hook.close();
        await sleep(120);
    }
}
