/** Browser scenario serialized into the isolated panel fixture page. */
export async function runAttachments(scope) {
    // ⑯ 附件：＋ 在工具行最左、「输出偏好」文字已去掉、上传/失败/发送全链路
    {
        scope.hook.open('附件探针', '上下文片段 ABC', '附件冒烟');
        await waitFor(function () { return scope.hook.state().phase === 'done'; }, 8000);
        var tools = document.querySelector('.dsh-sel-asktools');
        var addBtn = tools && tools.children[0];
        check('工具行最左是 ＋ 附件键（排在最前面，不是挨着麦克风）', !!addBtn && String(addBtn.className).indexOf('dsh-sel-add') >= 0 && tools.children[1] !== addBtn, addBtn ? addBtn.className : '未找到');
        // 十字 = 一条 path 里的两段（竖 + 横）；圆底是 CSS 给的（桩环境量不出背景色）
        var addPaths = addBtn ? Array.from(addBtn.querySelectorAll('path')) : [];
        var addD = addPaths.map(function (p) { return String(p.getAttribute('d')); }).join(' ');
        check('图标是十字（竖 + 横两段，不是回形针的弧线）', addPaths.length === 1 && /M8 3.4v9.2/.test(addD) && /M3.4 8h9.2/.test(addD), addD);
        var prefWrap = document.querySelector('.dsh-sel-pref');
        check('「输出偏好」四个字已从工具行去掉（只剩两格图标）', !!prefWrap && prefWrap.textContent.trim() === '' && !document.querySelector('.dsh-sel-preftext'), prefWrap ? JSON.stringify(prefWrap.textContent) : '未找到');
        check('去掉文字后语义仍在（title 说明这是什么）', !!prefWrap && String(prefWrap.title).indexOf('输出偏好') >= 0, prefWrap ? prefWrap.title : '');
        var attachBox = document.querySelector('.dsh-sel-attach');
        var sendBtn = document.querySelector('.dsh-sel-asksend');
        check('初始没有附件（附件条收着、不占高度）', !!attachBox && attachBox.getAttribute('data-show') === '0' && attachBox.children.length === 0, attachBox ? attachBox.getAttribute('data-show') + '/' + attachBox.children.length : '未找到');
        // 真造三个 File 塞进 <input type=file>（Chrome 支持直接赋 files）
        // 两张图是为了验"多图时左右切换"——一张不够摆出翻页。
        var fileInput = document.querySelector('.dsh-sel-ask input[type=file]');
        check('有隐藏的文件选择器（图片与文件一起选）', !!fileInput && fileInput.multiple === true && !fileInput.getAttribute('accept'), fileInput ? 'multiple=' + fileInput.multiple + ' accept=' + fileInput.getAttribute('accept') : '未找到');
        window.__attachHits = [];
        var dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([37, 80, 68, 70])], '季度报表.pdf', { type: 'application/pdf' }));
        dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], '截图.png', { type: 'image/png' }));
        dt.items.add(new File([new Uint8Array([137, 80, 78, 72])], '第二张.png', { type: 'image/png' }));
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        // 新流程（0.13.0）：选中只进内存（status=local），**点发送才真正上传** ——
        // 叉掉的图不该在附件库留垃圾。所以这里断言"还没传"，上传断言挪到点发送那一刻。
        await waitFor(function () { return attachBox.children.length === 3; }, 3000);
        check('三件附件都上了附件条', attachBox.children.length === 3, String(attachBox.children.length));
        check('附件条展开了', attachBox.getAttribute('data-show') === '1', attachBox.getAttribute('data-show'));
        check('图片是缩略图（里面是 img）、文件是文件卡', attachBox.children[0].className.indexOf('dsh-sel-fcard') >= 0 &&
            attachBox.children[1].className.indexOf('dsh-sel-thumb') >= 0 &&
            attachBox.children[2].className.indexOf('dsh-sel-thumb') >= 0, attachBox.children[0].className + ' / ' + attachBox.children[1].className + ' / ' + attachBox.children[2].className);
        check('选中后先不落盘（三件都还是 local，一个请求都没发）', window.__attachHits.length === 0 &&
            ['0', '1', '2'].every(function (i) { return attachBox.children[i].getAttribute('data-state') === 'local'; }), String(window.__attachHits.length) + ' / ' + ['0', '1', '2'].map(function (i) { return attachBox.children[i].getAttribute('data-state'); }).join(','));
        check('没在传时发送键可点（不必等上传）', sendBtn.disabled === false, String(sendBtn.disabled));
        // 名字/大小在 local 阶段就能看（本地 File 自带，不用等上传）
        check('文件卡显示名字与类型·大小', attachBox.children[0].textContent.indexOf('季度报表.pdf') >= 0 && /PDF/.test(attachBox.children[0].textContent), attachBox.children[0].textContent);
        // ── 图片预览：输入框上方的待发送缩略图，点一下要在**本窗口**里放大 ──
        // 用户报的就是这条：小窗里加的图（还没发的、已经发出去的）都点不开。
        var thumb = attachBox.children[1];
        var thumb2 = attachBox.children[2];
        check('待发送缩略图标成可预览（放大镜光标 + 可 Tab 到）', !!thumb && thumb.getAttribute('data-preview') === '1' && thumb.getAttribute('role') === 'button' && thumb.tabIndex === 0 &&
            !!thumb2 && thumb2.getAttribute('data-preview') === '1', thumb ? thumb.getAttribute('data-preview') + '/' + thumb.getAttribute('role') + '/' + thumb.tabIndex : '未找到');
        thumb.click();
        await waitFor(function () { return document.querySelector('.dsh-sel-lightbox[data-open="1"]') !== null; }, 1500);
        var lightbox = document.querySelector('.dsh-sel-lightbox');
        check('点缩略图打开灯箱（同一扇窗，不是新标签）', !!lightbox && lightbox.getAttribute('data-open') === '1', lightbox ? lightbox.getAttribute('data-open') : '未找到');
        var lightboxImg = lightbox && lightbox.querySelector('.dsh-sel-lightbox-img');
        check('灯箱里是这张图（上传前用本地 blob 先看，不必等传完）', !!lightboxImg && String(lightboxImg.getAttribute('src') || '').indexOf('blob:') === 0, lightboxImg ? String(lightboxImg.getAttribute('src')).slice(0, 40) : '未找到');
        check('灯箱显示文件名与关闭提示', !!lightbox && lightbox.textContent.indexOf('截图.png') >= 0 && lightbox.textContent.indexOf('Esc') >= 0, lightbox ? lightbox.textContent : '');
        var lightboxCount = lightbox.querySelector('.dsh-sel-lightbox-count');
        check('多图时有计数（1 / 2），第一张的「上一张」是灰的', !!lightboxCount && lightboxCount.textContent === '1 / 2' &&
            lightbox.querySelector('.dsh-sel-lightbox-nav[data-dir="prev"]').disabled === true &&
            lightbox.querySelector('.dsh-sel-lightbox-nav[data-dir="next"]').disabled === false, lightboxCount ? lightboxCount.textContent : '未找到');
        // 右侧按钮 → 第二张；本地 blob 地址必须换掉（不是同一张图重画）
        var firstSrc = lightboxImg.getAttribute('src');
        lightbox.querySelector('.dsh-sel-lightbox-nav[data-dir="next"]').click();
        await waitFor(function () { return lightbox.querySelector('.dsh-sel-lightbox-count').textContent === '2 / 2'; }, 1000);
        check('点右箭头切到下一张（名字与 blob 都跟着换）', lightbox.querySelector('.dsh-sel-lightbox-name').textContent === '第二张.png' &&
            lightboxImg.getAttribute('src') !== firstSrc, lightbox.querySelector('.dsh-sel-lightbox-name').textContent + ' / ' + String(lightboxImg.getAttribute('src')).slice(0, 24));
        check('最后一张的「下一张」是灰的、「上一张」可点', lightbox.querySelector('.dsh-sel-lightbox-nav[data-dir="next"]').disabled === true &&
            lightbox.querySelector('.dsh-sel-lightbox-nav[data-dir="prev"]').disabled === false, '');
        // ← 键 → 回到第一张（方向键只在多图时接管）
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        await waitFor(function () { return lightbox.querySelector('.dsh-sel-lightbox-count').textContent === '1 / 2'; }, 1000);
        check('← 键切回上一张', lightbox.querySelector('.dsh-sel-lightbox-name').textContent === '截图.png' &&
            lightboxImg.getAttribute('src') === firstSrc, lightbox.querySelector('.dsh-sel-lightbox-name').textContent);
        lightbox.click(); // 点空白处
        await waitFor(function () {
            var box = document.querySelector('.dsh-sel-lightbox');
            return !box || box.getAttribute('data-open') === '0';
        }, 1500);
        check('点空白处收起灯箱', document.querySelector('.dsh-sel-lightbox').getAttribute('data-open') === '0', document.querySelector('.dsh-sel-lightbox').getAttribute('data-open'));
        // 发送：附件引用必须进这一轮追问的载荷，而且**不带 base64**
        window.__askBodies = [];
        var askBox = document.querySelector('.dsh-sel-askbox');
        askBox.value = '这个报表里哪个季度掉得最多？';
        askBox.dispatchEvent(new Event('input', { bubbles: true }));
        // 拖慢上传，让"上传中"这个中间态可确定性观察
        window.__attachDelay = 120;
        sendBtn.click();
        await waitFor(function () { return window.__attachHits.length > 0; }, 3000);
        check('点发送才开始上传（上传中发送键置灰，不让材料没齐就发出去）', sendBtn.disabled === true, String(sendBtn.disabled));
        await waitFor(function () { return window.__attachHits.length === 3; }, 4000);
        check('每件各发一次请求（逐件上传，失败不牵连别件）', window.__attachHits.length === 3, String(window.__attachHits.length));
        check('请求里带的是 base64（不带 data: 前缀）', window.__attachHits.every(function (hit) { return typeof hit.items[0].data === 'string' && hit.items[0].data.indexOf('data:') !== 0 && hit.items[0].data.length > 0; }), window.__attachHits.map(function (hit) { return String(hit.items[0].data).slice(0, 12); }).join(' | '));
        check('图片那件声明了 mediaType（附件服务要拿它跟字节比对）', window.__attachHits.some(function (hit) { return hit.items[0].kind === 'image' && hit.items[0].mediaType === 'image/png'; }), JSON.stringify(window.__attachHits.map(function (hit) { return hit.items[0].mediaType; })));
        window.__attachDelay = 0;
        await waitFor(function () { return window.__askBodies.length > 0; }, 4000);
        var ask = window.__askBodies[0] || {};
        check('追问载荷带上了三件附件引用', Array.isArray(ask.attachments) && ask.attachments.length === 3 && ask.attachments.every(function (a) { return a.ref && a.ref.attachmentId; }), JSON.stringify(ask.attachments));
        check('载荷里没有 base64（只回传引用）', JSON.stringify(ask.attachments).indexOf('data') < 0 && JSON.stringify(ask).length < 2000, String(JSON.stringify(ask).length));
        check('附件说明拼进了发给模型的那条消息（历史里也看得到带过附件）', String(ask.question).indexOf('【本条消息带了附件】') >= 0 && String(ask.question).indexOf('季度报表.pdf') >= 0, String(ask.question).slice(0, 120));
        await waitFor(function () { return attachBox.children.length === 0; }, 2000);
        check('发送后附件条清空（附件属于这一条消息，不属于会话）', attachBox.children.length === 0 && attachBox.getAttribute('data-show') === '0', String(attachBox.children.length));
        // 气泡里要看得见附件 —— 用户报的就是这条："图片在消息窗口并没有显示"。
        // 注意图片是走**回放路由**取的（本地 object URL 在发送那一刻就释放了）。
        await waitFor(function () { return document.querySelector('.dsh-sel-bqattach') !== null; }, 2000);
        var strip = document.querySelector('.dsh-sel-bqattach');
        check('发出去的消息气泡里有附件条', !!strip && strip.children.length === 3, strip ? String(strip.children.length) : '未找到');
        var bqImg = document.querySelector('.dsh-sel-bqimg');
        // 注意 img.src 拿到的是**绝对** URL（浏览器解析过），所以用 includes 而不是 startsWith
        check('图片渲染成缩略图，且指向回放路由（不是本地 blob —— 那个地址发送时就释放了）', !!bqImg && String(bqImg.getAttribute('src')).includes('/selection-explain/api/attachment') &&
            String(bqImg.getAttribute('src')).includes('kind=image') && String(bqImg.getAttribute('src')).indexOf('blob:') !== 0, bqImg ? String(bqImg.getAttribute('src')).slice(0, 90) : '未找到');
        check('缩略图是懒加载；外层仍是链接（⌘/中键 / 右键还能走新标签）', !!bqImg && bqImg.getAttribute('loading') === 'lazy' && bqImg.parentNode.tagName === 'A' && bqImg.parentNode.target === '_blank', '');
        // 真去取一次字节：naturalWidth > 0 = 图**解码成功**（只看 src 证明不了它真能显示）
        await waitFor(function () { return bqImg && bqImg.complete && bqImg.naturalWidth > 0; }, 3000);
        check('缩略图真的从回放路由取到并解码了（不是破图）', !!bqImg && bqImg.naturalWidth > 0, bqImg ? bqImg.naturalWidth + 'x' + bqImg.naturalHeight : '未找到');
        // 量比例：源图很宽（810x180），被 max-width 压下来时必须**等比** —— 变形了就是 CSS 写错
        var bqRect = bqImg.getBoundingClientRect();
        var naturalRatio = bqImg.naturalWidth / bqImg.naturalHeight;
        var shownRatio = bqRect.width / Math.max(1, bqRect.height);
        check('缩略图等比缩放、没被压变形', Math.abs(shownRatio - naturalRatio) / naturalRatio < 0.06, '显示 ' + Math.round(bqRect.width) + 'x' + Math.round(bqRect.height) + ' (' + shownRatio.toFixed(2) + ':1) vs 原始 ' + naturalRatio.toFixed(2) + ':1');
        check('缩略图高度不超过 180px（不许把气泡撑爆）', bqRect.height <= 181, Math.round(bqRect.height) + 'px');
        // ── 已发出的图片：普通左键同样在本窗口预览（不是新标签）──
        bqImg.click();
        await waitFor(function () { return document.querySelector('.dsh-sel-lightbox[data-open="1"]') !== null; }, 1500);
        var sentLightbox = document.querySelector('.dsh-sel-lightbox');
        var sentLightboxImg = sentLightbox && sentLightbox.querySelector('.dsh-sel-lightbox-img');
        check('点气泡里的图片也打开灯箱', !!sentLightbox && sentLightbox.getAttribute('data-open') === '1', sentLightbox ? sentLightbox.getAttribute('data-open') : '未找到');
        check('灯箱取的是回放路由那张图（不是气泡里的缩略尺寸）', !!sentLightboxImg && String(sentLightboxImg.getAttribute('src')).includes('/selection-explain/api/attachment') &&
            String(sentLightboxImg.getAttribute('src')).includes('kind=image'), sentLightboxImg ? String(sentLightboxImg.getAttribute('src')).slice(0, 90) : '未找到');
        check('灯箱打开时声明为模态浮层（读屏与 Esc 层级都用它）', sentLightbox.getAttribute('aria-modal') === 'true', sentLightbox.getAttribute('aria-modal'));
        // 会话里的两张图也要能左右翻（这轮消息里就有两张）
        var sentCount = sentLightbox.querySelector('.dsh-sel-lightbox-count');
        check('会话里多张图时带翻页计数（1 / 2）', !!sentCount && sentCount.textContent === '1 / 2', sentCount ? sentCount.textContent : '未找到');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        await waitFor(function () { return sentLightbox.querySelector('.dsh-sel-lightbox-count').textContent === '2 / 2'; }, 1000);
        check('→ 键切到会话里的下一张', sentLightbox.querySelector('.dsh-sel-lightbox-count').textContent === '2 / 2', sentLightbox.querySelector('.dsh-sel-lightbox-count').textContent);
        // 到头不循环：再按一次仍是最后一张（不会莫名跳回第一张）
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        await sleep(80);
        check('最后一张再按 → 不循环回第一张', sentLightbox.querySelector('.dsh-sel-lightbox-count').textContent === '2 / 2', sentLightbox.querySelector('.dsh-sel-lightbox-count').textContent);
        // Esc 只退最内层：灯箱关掉，小窗必须还在
        var escLightbox = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.dispatchEvent(escLightbox);
        await waitFor(function () { return document.querySelector('.dsh-sel-lightbox').getAttribute('data-open') === '0'; }, 1500);
        check('Esc 只关灯箱，不会顺手把小窗也关了', document.querySelector('.dsh-sel-lightbox').getAttribute('data-open') === '0' &&
            getComputedStyle(document.querySelector('.dsh-sel-panel')).display !== 'none', 'lightbox=' + document.querySelector('.dsh-sel-lightbox').getAttribute('data-open') +
            ' panel=' + getComputedStyle(document.querySelector('.dsh-sel-panel')).display +
            ' prevented=' + escLightbox.defaultPrevented);
        // 关着的灯箱不能继续以 aria-modal 出现：宿主的 Esc 是"有官方模态就让它先退"，
        // 留一个隐藏的 aria-modal 会让小窗从此关不掉（点 ✕ 之外所有 Esc 都被吞）。
        check('灯箱关掉后不再占着"模态浮层"这个身份', document.querySelector('[role="dialog"][aria-modal="true"]') === null, String(document.querySelector('[role="dialog"][aria-modal="true"]')));
        // 点第二张图 → 应该从第 2 张开始（下标跟着点击的那张走）；✕ 也能关
        var bqImgs = document.querySelectorAll('.dsh-sel-bqimg');
        if (bqImgs[1])
            bqImgs[1].click();
        await waitFor(function () { return document.querySelector('.dsh-sel-lightbox[data-open="1"]') !== null; }, 1500);
        check('点第二张图打开时直接停在第 2 张（不总是从第一张开始）', document.querySelector('.dsh-sel-lightbox-count').textContent === '2 / 2', document.querySelector('.dsh-sel-lightbox-count').textContent);
        document.querySelector('.dsh-sel-lightbox-x').click();
        await waitFor(function () { return document.querySelector('.dsh-sel-lightbox').getAttribute('data-open') === '0'; }, 1500);
        check('右上角 ✕ 也能关掉灯箱', document.querySelector('.dsh-sel-lightbox').getAttribute('data-open') === '0', document.querySelector('.dsh-sel-lightbox').getAttribute('data-open'));
        var bqFile = document.querySelector('.dsh-sel-bqfile');
        check('文件渲染成一张可下载的卡（扩展名 + 名字 + 大小）', !!bqFile && /PDF/.test(bqFile.textContent) && /季度报表.pdf/.test(bqFile.textContent) && /B/.test(bqFile.textContent) && String(bqFile.getAttribute('href')).indexOf('download=1') > 0, bqFile ? bqFile.textContent : '未找到');
        check('气泡正文里不再重复那行「本条消息带了附件」', String(document.querySelector('.dsh-sel-bubble-user').textContent).indexOf('本条消息带了附件') < 0, String(document.querySelector('.dsh-sel-bubble-user').textContent).slice(0, 80));
        // 跨轮次：第二轮必须把**上一轮**的附件引用随历史回传。
        // 这就是"附件持久化"在客户端这一侧的终点 —— 没有这一条，模型下一轮就看不见那张图了。
        await waitFor(function () { return scope.hook.state().asking !== true; }, 4000);
        window.__askBodies = [];
        askBox.value = '那第二列呢？';
        askBox.dispatchEvent(new Event('input', { bubbles: true }));
        sendBtn.click();
        await waitFor(function () { return window.__askBodies.length > 0; }, 3000);
        var secondAsk = window.__askBodies[0] || {};
        var carried = (secondAsk.history || []).filter(function (turn) { return turn.attachments && turn.attachments.length > 0; });
        check('第二轮把上一轮的附件引用带进了历史（跨轮次仍看得见那张图）', carried.length === 1 && carried[0].attachments.length === 3, JSON.stringify(secondAsk.history || []).slice(0, 220));
        check('历史里的附件只有引用、没有 base64', JSON.stringify(secondAsk.history || []).indexOf('data:') < 0 && JSON.stringify(secondAsk.history || []).length < 3000, String(JSON.stringify(secondAsk.history || []).length));
        await waitFor(function () { return scope.hook.state().asking !== true; }, 4000);
        // 失败 → 就地重试。注意新流程：选中不传，失败发生在**点发送**那一刻。
        window.__attachFail = '坏图.bmp';
        var dt2 = new DataTransfer();
        dt2.items.add(new File([new Uint8Array([1, 2, 3])], '坏图.bmp', { type: 'image/bmp' }));
        fileInput.files = dt2.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        check('还没发送时失败件仍是 local（没上传就不会有错）', attachBox.children.length === 1 && attachBox.children[0].getAttribute('data-state') === 'local', attachBox.children[0] ? attachBox.children[0].getAttribute('data-state') : '未找到');
        askBox.value = '这张图里是什么？';
        askBox.dispatchEvent(new Event('input', { bubbles: true }));
        sendBtn.click();
        await waitFor(function () { return attachBox.children.length === 1 && attachBox.children[0].getAttribute('data-state') === 'error'; }, 3000);
        check('被拒的附件标成错误态（不是静默丢掉）', attachBox.children.length === 1 && attachBox.children[0].getAttribute('data-state') === 'error', attachBox.children[0] ? attachBox.children[0].getAttribute('data-state') : '未找到');
        var note = document.querySelector('.dsh-sel-attachnote');
        check('错误原因写在附件条下面（把错误码翻成人话）', !!note && note.getAttribute('data-show') === '1' && /图片格式/.test(note.textContent), note ? note.textContent : '');
        check('错误态有移除键（用户可以删掉这件）', !!attachBox.children[0].querySelector('.dsh-sel-attachx'), '');
        // 重试成功
        window.__attachFail = null;
        var retryBtn = attachBox.children[0].querySelector('.dsh-sel-attachx');
        retryBtn.click();
        await waitFor(function () { return attachBox.children[0].getAttribute('data-state') === 'done'; }, 3000);
        check('点重试后就地成功（不用重新选文件）', attachBox.children[0].getAttribute('data-state') === 'done', attachBox.children[0].getAttribute('data-state'));
        // 移除
        var removeBtn = attachBox.children[0].querySelector('.dsh-sel-attachx');
        removeBtn.click();
        await waitFor(function () { return attachBox.children.length === 0; }, 2000);
        check('点 ✕ 移除该件', attachBox.children.length === 0, String(attachBox.children.length));
        // ── 拖放的路由：拖到小窗上，**不能**同时落进主会话的输入框 ──
        //
        // 主会话的投放监听是 document 级、冒泡阶段，而且**不看 defaultPrevented** ——
        // 所以只 preventDefault 拦不住它。这里在 document 上装一个同样的监听当"主会话"，
        // 看它收不收得到事件。（这一段放在场景最后：它会往附件条里加东西，
        // 放前面会把后面"失败→重试→移除"那几条的状态搅乱。）
        var mainDrops = [];
        var mainEnters = [];
        function mainDropProbe(event) { mainDrops.push(String(event.target.className || event.target.tagName)); }
        function mainEnterProbe(event) { mainEnters.push(String(event.target.className || event.target.tagName)); }
        document.addEventListener('drop', mainDropProbe);
        document.addEventListener('dragenter', mainEnterProbe);
        try {
            function fileDrag() {
                var box = new DataTransfer();
                box.items.add(new File([new Uint8Array([1, 2, 3])], '拖进来的.txt', { type: 'text/plain' }));
                return box;
            }
            var dragOpts = function (transfer) { return { dataTransfer: transfer, bubbles: true, cancelable: true }; };
            var asked = document.querySelector('.dsh-sel-askbox');
            // ① 拖进来（还没松手）：遮罩亮、且主会话不该被点亮
            var transfer = fileDrag();
            asked.dispatchEvent(new DragEvent('dragenter', dragOpts(transfer)));
            asked.dispatchEvent(new DragEvent('dragover', dragOpts(transfer)));
            check('拖到小窗上：小窗自己铺了投放遮罩', document.querySelector('.dsh-sel-panel').getAttribute('data-dropping') === '1', String(document.querySelector('.dsh-sel-panel').getAttribute('data-dropping')));
            check('拖到小窗上：主会话的拖入监听也收不到（全视口遮罩不会在小窗上方点亮）', mainEnters.length === 0, JSON.stringify(mainEnters));
            // ② 松手：文件只进小窗
            var before = attachBox.children.length;
            asked.dispatchEvent(new DragEvent('drop', dragOpts(transfer)));
            await waitFor(function () { return attachBox.children.length > before; }, 2000);
            check('松手：文件进了小窗的附件条', attachBox.children.length === before + 1, String(attachBox.children.length));
            check('松手：document 级（=主会话）的投放监听**收不到** —— 不会同时落进主会话', mainDrops.length === 0, JSON.stringify(mainDrops));
            check('松手后投放遮罩收起', document.querySelector('.dsh-sel-panel').getAttribute('data-dropping') === null, String(document.querySelector('.dsh-sel-panel').getAttribute('data-dropping')));
            // ③ 反向对照：拖到小窗**外面**，主会话照常收到（小窗不是全局拦截器）
            var outside = fileDrag();
            var doc = document.getElementById('doc');
            doc.dispatchEvent(new DragEvent('dragenter', dragOpts(outside)));
            doc.dispatchEvent(new DragEvent('drop', dragOpts(outside)));
            check('拖到小窗外面：主会话照常收到（没有把小窗变成全局拦截器）', mainDrops.length === 1, JSON.stringify(mainDrops));
            // ④ 拖一段**文字**：小窗完全不插手（它没有"接文字"这回事），仍归主会话
            var textDrag = new DataTransfer();
            textDrag.setData('text/plain', '一段被拖动的文字');
            mainDrops.length = 0;
            asked.dispatchEvent(new DragEvent('drop', dragOpts(textDrag)));
            check('拖的是文字（不是文件）时小窗不插手 —— 仍归主会话', mainDrops.length === 1, JSON.stringify(mainDrops));
            // 收尾：把拖进来的那件移掉，别留给下一个场景
            var dragged = attachBox.children[attachBox.children.length - 1];
            var dragRemove = dragged && dragged.querySelector('.dsh-sel-attachx');
            if (dragRemove)
                dragRemove.click();
            await waitFor(function () { return attachBox.children.length === 0; }, 2000);
        }
        finally {
            document.removeEventListener('drop', mainDropProbe);
            document.removeEventListener('dragenter', mainEnterProbe);
        }
        scope.hook.close();
        await sleep(60);
    }
}
