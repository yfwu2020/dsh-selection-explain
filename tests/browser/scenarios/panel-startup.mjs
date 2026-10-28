/** Browser scenario serialized into the isolated panel fixture page. */
export async function runStartup(scope) {
    var mount = document.getElementById('mount');
    scope.hook = null;
    try {
        var modules = captured.factory(function (name) { return name === 'react' ? React : {}; });
        modules.apply(ctx);
        check('插件装载（槽注册 + apply）', !!registration && registration.options.id === '@yfwu2020/dsh-selection-explain', registration && registration.options.id);
        registration.component().props.ref(mount);
        scope.hook = window.__dshSelectionExplain;
        check('解读自有浮层已挂载', !!document.querySelector('.dsh-sel-layer'), '');
        var ownedLayer = document.querySelector('.dsh-sel-layer');
        check('解读使用 body 自有根，公开归属且空白穿透', ownedLayer.parentNode === document.body && ownedLayer.getAttribute('data-dsh-floating-owner') === 'explanation' && getComputedStyle(ownedLayer).pointerEvents === 'none', '');
        check('桌面标题栏仍是原生窗口拖拽区域', getComputedStyle(document.getElementById('desktop-drag-probe')).webkitAppRegion === 'drag', '');
        check('全屏浮层不把桌面标题栏排除出原生拖拽区域', getComputedStyle(ownedLayer).webkitAppRegion === 'none', getComputedStyle(ownedLayer).webkitAppRegion);
        check('标题栏的鼠标命中仍穿透插件空白', document.elementFromPoint(500, 10) === document.getElementById('desktop-drag-probe'), '');
        var desktopControls = Array.from(ownedLayer.querySelectorAll('.dsh-sel-btn,.dsh-sel-panel,.dsh-sel-pill,.dsh-sel-history'));
        check('插件交互区域仍禁止原生窗口拖拽', desktopControls.every(function (node) { return getComputedStyle(node).webkitAppRegion === 'no-drag'; }), desktopControls.map(function (node) { return node.className + ':' + getComputedStyle(node).webkitAppRegion; }).join(', '));
        check('解读独立根越过完整视图工作面板', Number(getComputedStyle(ownedLayer).zIndex) > 60, getComputedStyle(ownedLayer).zIndex);
        var modeFrame = document.createElement('div');
        document.body.appendChild(modeFrame);
        modeFrame.setAttribute('data-dsh-full-view', '');
        await sleep(40);
        check('解读自身响应完整视图并隐藏胶囊', getComputedStyle(document.querySelector('.dsh-sel-pill')).display === 'none', '');
        modeFrame.removeAttribute('data-dsh-full-view');
        await sleep(40);
        check('返回分栏由解读自身恢复胶囊', getComputedStyle(document.querySelector('.dsh-sel-pill')).display !== 'none', '');
        modeFrame.remove();
    }
    catch (error) {
        check('插件装载（槽注册 + apply）', false, error && error.message);
        finish();
        return true;
    }
    scope.panel = document.querySelector('.dsh-sel-panel');
    scope.quoteBtn = scope.hook.quoteNode();
    var quotesBox = document.querySelector('.dsh-sel-quotes');
    scope.chipCount = function chipCount() { return scope.hook.quotes().length; };
    scope.dropQuotes = function dropQuotes() {
        var xs = quotesBox.querySelectorAll('.dsh-sel-quotechip-x');
        for (var i = xs.length - 1; i >= 0; i -= 1)
            clickOn(xs[i]);
    };
    scope.settlePanel =
    /** 等面板"安顿下来"（开窗自动聚焦那一下会清掉选区，等它过去再划）。 */
    async function settlePanel() {
        var box = document.querySelector(".dsh-sel-askbox");
        await waitFor(function () { return box && document.activeElement === box; }, 800);
        await sleep(30);
    };
    scope.quoteOnce =
    /** 划一段 → 点引用 → 返回那一段引用（并清场）。find() 返回 { node, needle }。 */
    async function quoteOnce(label, find) {
        await scope.settlePanel();
        var target = find();
        if (!target || !target.node) {
            check(label + '：找到目标节点', false, '未找到');
            return null;
        }
        var range = selectIn(target.node, target.needle);
        check(label + '：能建出真选区', !!range, range ? range.toString().slice(0, 24) : '未找到目标文字');
        if (!range)
            return null;
        // ⚠️ 合成选区 vs 面板渲染有竞态：面板晚一步重绘会把刚选中的节点换掉，插件据此判定
        // "那段文字没了"并收起浮标（这是对的），用例于是偶发红 —— 真浏览器冒烟在 CI 与本机
        // 都复现过（改动前的基线同样 192/2）。所以这里**重试合成选区**（最多 3 次，每次都重新
        // 取节点、重建 range），而不是放宽断言。
        var shown = false;
        for (var attempt = 0; attempt < 3 && !shown; attempt += 1) {
            if (attempt > 0) {
                await scope.settlePanel();
                var fresh = find();
                if (!fresh || !fresh.node)
                    break;
                target = fresh;
                range = selectIn(target.node, target.needle);
                if (!range)
                    break;
            }
            mouseUpOn(target.node);
            shown = await waitFor(function () { return scope.hook.quoteState().visible === true; }, 1500);
        }
        check(label + '：浮出「❝ 引用」', shown === true, JSON.stringify(scope.hook.quoteState()));
        if (!shown)
            return null;
        check(label + '：浮标在最上层（不被面板盖住）', onTop(scope.quoteBtn), '');
        clickOn(scope.quoteBtn);
        await sleep(40);
        var quotes = scope.hook.quotes();
        var picked = quotes.length ? quotes[quotes.length - 1] : null;
        check(label + '：进了引用区', scope.chipCount() === 1 && !!picked, JSON.stringify(quotes.map(function (q) { return q.label + ':' + q.text.slice(0, 12); })));
        scope.dropQuotes();
        await sleep(30);
        return picked;
    };
    scope.sectionContent = function sectionContent(key) {
        return document.querySelector('.dsh-sel-sec[data-sec="' + key + '"] .dsh-sel-c');
    };
}
