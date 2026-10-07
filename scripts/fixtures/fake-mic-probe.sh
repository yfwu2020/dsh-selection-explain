#!/bin/sh
# 假探针（宿主生命周期测试用）：只记两笔 —— 起来了 / 被杀了。
# 真探针要读 CoreAudio，测试里既没必要也跑不稳；这里要验的是**进程什么时候在**。
echo "start $*" >> "$DSH_SEL_FAKE_PROBE_LOG"
echo '{"capturing":false,"processes":[]}'
trap 'echo stop >> "$DSH_SEL_FAKE_PROBE_LOG"; exit 0' TERM
# 注意：POSIX sh 里 trap 要等**当前前台命令**跑完才执行，所以这个等待必须短 ——
# 用 sleep 1 的话，SIGTERM 之后最多要 1 秒才写得出 stop，测试会误判成"没停"。
while true; do sleep 0.1; done
