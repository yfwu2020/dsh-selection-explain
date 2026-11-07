/** Browser scenario serialized into the isolated panel fixture page. */
export async function runCloseStream(scope) {
    try {
        var hook = scope.hook;
        hook.close();
        await sleep(80);
        // 这一轮的 SSE 改成"一件一件吐"：才能确定性地在流中间关窗
        window.__analyzeDelay = 80;
        window.__analyzeSlow = true;
        window.__analyzeSignals = [];
        hook.forget();
        hook.open('关窗不打断：后台继续把话说完', '上下文', '冒烟');
        var streaming = await waitFor(function () { return hook.state().phase === 'streaming'; }, 4000);
        check('关窗前已经在流式输出', streaming, hook.state().phase);
        var signal = window.__analyzeSignals[window.__analyzeSignals.length - 1];
        hook.close();
        await sleep(40);
        check('收起小窗不 abort 在飞的请求', signal && signal.aborted === false, signal ? String(signal.aborted) : '没有拿到 signal');
        check('收起小窗不算「已停止」', hook.state().aborted === false, hook.state().aborted);
        check('收起后请求句柄还在（后台继续跑）', hook.state().hasRequest === true, hook.state().hasRequest);
        var done = await waitFor(function () { return hook.state().phase === 'done'; }, 6000);
        check('收起后这一轮照常跑完', done, hook.state().phase);
        check('跑完的正文没有丢', hook.state().raw.indexOf('迁移跑得比预期久') >= 0, hook.state().raw.length);
        // 重开：和用户一样点胶囊
        hook.pill().click();
        var reopened = await waitFor(function () { return scope.panelIsOpen(); }, 1500);
        await sleep(60);
        var text = (document.querySelector('.dsh-sel-panel') || {}).textContent || '';
        check('点胶囊重开能读到完整回答', reopened && text.indexOf('迁移跑得比预期久') >= 0, text.length);
    }
    finally {
        window.__analyzeSlow = false;
    }
}
