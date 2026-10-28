/** Browser scenario serialized into the isolated panel fixture page. */
export async function runKeyboard(scope) {
    // 可选截图模式（?shot=1）：把两个**终态**摆出来（展开=圆点 / 收球=星芒），
    // 真实大小各一份 + 几何各一份放大，给人工核对，也给以后换图标留一张回归图。
    // 用克隆而不是改原胶囊：克隆同样吃到那套 CSS（选择器都是 .dsh-sel-pill[data-ball="1"] …）。
    if (location.search.indexOf('shot=1') >= 0) {
        freezeMotion();
        if (scope.panelIsOpen())
            scope.hook.close();
        await sleep(200);
        scope.hook.pillIdle();
        await sleep(400);
        var src = scope.hook.pill();
        var stage = document.createElement('div');
        stage.setAttribute('id', 'shotstage');
        stage.setAttribute('style', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483600;background:#f4f6f8;' +
            'display:flex;flex-direction:column;gap:22px;align-items:center;justify-content:center;color:#57606a;' +
            'font:12px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif');
        var row1 = document.createElement('div');
        row1.setAttribute('style', 'display:flex;gap:26px;align-items:center');
        /**
         * 造一格：clone 是胶囊的克隆；ball 决定它摆成球还是展开；scale 是放大倍数；
         * dotOnly 时把球态画布里的 d 换成"圆点"那条 —— 用来单独看圆点的几何。
         * 盒子尺寸按**放大后的视觉尺寸**给（球 32×scale），克隆的布局盒仍是被 scale 前的尺寸，
         * 所以放大后的图形会对称溢出布局盒、正好落在盒子里。
         */
        function cell(ball, dotOnly, scale, label) {
            var wrap = document.createElement('div');
            wrap.setAttribute('style', 'display:flex;flex-direction:column;align-items:center;gap:9px');
            var boxW = ball ? Math.round(48 * scale) + 24 : 232;
            var boxH = ball ? Math.round(48 * scale) + 24 : 92;
            var box = document.createElement('div');
            box.setAttribute('style', 'display:flex;align-items:center;justify-content:center;' +
                'width:' + boxW + 'px;height:' + boxH + 'px;background:#fff;border-radius:14px;' +
                'box-shadow:0 6px 20px rgba(0,0,0,.10)');
            var clone = src.cloneNode(true);
            clone.style.position = 'static';
            clone.style.right = 'auto';
            clone.style.bottom = 'auto';
            clone.style.transition = 'none';
            clone.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
            if (ball)
                clone.setAttribute('data-ball', '1');
            else
                clone.removeAttribute('data-ball');
            clone.setAttribute('data-ready', '1');
            var starClone = clone.querySelector('.dsh-sel-pillstar');
            if (starClone) {
                starClone.setAttribute('d', ball && !dotOnly
                    ? window.__dshSelectionExplain.pillStarD()
                    : window.__dshSelectionExplain.pillStarDotD());
            }
            box.appendChild(clone);
            wrap.appendChild(box);
            var cap = document.createElement('div');
            cap.setAttribute('style', 'max-width:240px;text-align:center;line-height:1.6');
            cap.textContent = label;
            wrap.appendChild(cap);
            return wrap;
        }
        row1.appendChild(cell(false, false, 1, '展开态（真实大小）：球心里是 8px 圆点'));
        row1.appendChild(cell(true, false, 1, '收球态（真实大小）：8px 圆点长成星芒 16.8px'));
        row1.appendChild(cell(true, true, 4, '圆点 8px（4×）—— 32 边形，半径恒 4'));
        row1.appendChild(cell(true, false, 4, '星芒 16.8px（4×）—— 与「✦ 解读」那颗星逐点同形'));
        stage.appendChild(row1);
        // 下行：形变逐帧（直接用 hook.pillStarAt(p) 画真实轨迹）——
        // 这一条就是"中间帧形状不对"的可视回归图：曾经用 CSS 的 d 过渡做线性插值，
        // 25%~38% 那几帧会是一个正菱形（谷跟着尖一起动），在这里一眼就能看出来。
        var row2 = document.createElement('div');
        row2.setAttribute('style', 'display:flex;gap:9px;align-items:flex-end');
        for (var fi = 0; fi <= 8; fi += 1) {
            var fp = fi / 8;
            var fcell = document.createElement('div');
            fcell.setAttribute('style', 'display:flex;flex-direction:column;align-items:center;gap:5px');
            var fclone = src.cloneNode(true);
            fclone.style.position = 'static';
            fclone.style.right = 'auto';
            fclone.style.bottom = 'auto';
            fclone.style.transition = 'none';
            fclone.setAttribute('data-ball', '1');
            fclone.setAttribute('data-ready', '1');
            var fstar = fclone.querySelector('.dsh-sel-pillstar');
            if (fstar) {
                fstar.setAttribute('d', window.__dshSelectionExplain.pillStarAt(fp));
                fstar.style.transform = 'rotate(' + Math.round(8 * (1 - fp) * 100) / 100 + 'deg)';
            }
            fcell.appendChild(fclone);
            var fcap = document.createElement('div');
            fcap.setAttribute('style', 'font-size:10px;color:#8c959f');
            fcap.textContent = Math.round(fp * 100) + '%';
            fcell.appendChild(fcap);
            row2.appendChild(fcell);
        }
        stage.appendChild(row2);
        document.body.appendChild(stage);
        await sleep(400);
    }
}
