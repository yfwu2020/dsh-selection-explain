#!/usr/bin/env bash
# dsh-selection-explain 构建脚本
#   ① 探测 DSH 运行时（含 @deepseek-ai/* 包的那层 node_modules）
#   ② 建立 node_modules 链接（类型解析 + 运行时 import 都依赖它）
#   ③ tsc 编译 host 半：src/index.ts → lib/index.js(+ .d.ts)
#   ④ 打包 client 模块，生成 DSH ModuleLoader bundle：lib/client.js
# 用法：bash scripts/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── ① 运行时根：DSH_CHECKOUT → dsh CLI 所在安装 → 常见 checkout → npx 缓存 ──
# 返回「含 @deepseek-ai/dsh-llm 的那层 node_modules」。
probe() {
  local base="${1:-}"
  [ -n "$base" ] || return 1
  # 同时要 dsh-llm 和 cordis：过期链接可能只剩一个 dsh-llm（实测踩过——tsc 报
  # "Cannot find module '@deepseek-ai/cordis'"，构建失败还会**静默跳过 client 拷贝**，测试于是拿旧 lib 跑出假结果）
  if [ -d "$base/@deepseek-ai/dsh-llm" ] && [ -d "$base/@deepseek-ai/cordis" ]; then echo "$base"; return 0; fi
  if [ -d "$base/node_modules/@deepseek-ai/dsh-llm" ] && [ -d "$base/node_modules/@deepseek-ai/cordis" ]; then echo "$base/node_modules"; return 0; fi
  return 1
}

find_runtime() {
  local found=""
  # 0) 项目自己的 node_modules —— CI（GitHub Actions）走这条路：
  #    npm install 会把 peerDependencies（@deepseek-ai/dsh-llm 等）装进来，
  #    没有这一步的话干净环境必然探测失败。
  found="$(probe "$ROOT/node_modules" || true)"
  if [ -n "$found" ]; then echo "$found"; return; fi
  # 1) 显式指定
  if [ -n "${DSH_CHECKOUT:-}" ]; then
    found="$(probe "$DSH_CHECKOUT" || true)"
    if [ -n "$found" ]; then echo "$found"; return; fi
  fi
  # 2) 正在运行的 dsh CLI（PATH 上的 dsh → 真实安装层）
  local cli=""
  cli="$(command -v dsh || true)"
  if [ -n "$cli" ]; then
    local real=""
    real="$(node -e 'const fs=require("fs");try{console.log(fs.realpathSync(process.argv[1]))}catch(e){}' "$cli")"
    if [ -n "$real" ]; then
      # …/node_modules/@deepseek-ai/dsh/lib/bin.js → 逐级向上找
      local dir
      dir="$(dirname "$real")"
      while [ "$dir" != "/" ] && [ -n "$dir" ]; do
        found="$(probe "$dir" || true)"
        if [ -n "$found" ]; then echo "$found"; return; fi
        dir="$(dirname "$dir")"
      done
    fi
  fi
  # 3) 常见 checkout / 缓存
  local candidate
  for candidate in "$HOME/.dsh/dsh-harness" "$HOME/dsh-harness" "$HOME/dsh"; do
    found="$(probe "$candidate" || true)"
    if [ -n "$found" ]; then echo "$found"; return; fi
  done
  for candidate in "$HOME"/.npm/_npx/*/node_modules "$HOME"/.npx/*/node_modules; do
    found="$(probe "$candidate" || true)"
    if [ -n "$found" ]; then echo "$found"; return; fi
  done
  echo ""
}

RUNTIME="$(find_runtime)"
if [ -z "$RUNTIME" ]; then
  echo "build: 找不到 DSH 运行时（设置 DSH_CHECKOUT 指向含 @deepseek-ai/dsh-llm 的目录）" >&2
  exit 1
fi
echo "=== DSH 运行时：$RUNTIME ==="

# ── ② 链接 @deepseek-ai / @types（整层 scope 链接，类型与运行时共用） ──
# 两种情况必须区分：
#   · 本机开发：node_modules 里没有这些包，链接到 DSH 运行时（原来唯一的行为）
#   · CI（npm install 过）：peerDependencies / devDependencies 已经装成**真实目录**，
#     此时绝不能动它 —— 否则会把 node_modules/@deepseek-ai 链成它自己（自引用死循环，
#     probe 随后报 "Too many levels of symbolic links"，node_modules 被破坏）。
node -e '
const fs = require("fs")
const path = require("path")
const runtime = process.argv[1]
const root = process.argv[2]
const real = (p) => { try { return fs.realpathSync(p) } catch { return "" } }
for (const name of ["@deepseek-ai", "@types"]) {
  const target = path.join(runtime, name)
  if (!fs.existsSync(target)) continue
  const link = path.join(root, "node_modules", name)
  const linkReal = real(link)
  // 已是真实目录（非符号链接）→ 保留，npm 装的才是权威版本
  if (linkReal && !fs.lstatSync(link).isSymbolicLink()) {
    console.log("kept node_modules/" + name + "（真实目录，不链接）")
    continue
  }
  // 已经指向同一个地方 → 无需重建
  if (linkReal && linkReal === real(target)) {
    console.log("ok node_modules/" + name + "（已指向运行时）")
    continue
  }
  fs.rmSync(link, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")
  console.log("linked node_modules/" + name + " → " + target)
}
' "$RUNTIME" "$ROOT"

# ── ③ 编译 host 半 ──
# tsc 查找顺序：项目自己的 node_modules/.bin（CI 走这条，devDependencies 里已声明）
# → PATH 上的全局 tsc → DSH 运行时里的 tsc。
TSC=""
if [ -x "$ROOT/node_modules/.bin/tsc" ]; then TSC="$ROOT/node_modules/.bin/tsc"; fi
if [ -z "$TSC" ]; then TSC="$(command -v tsc || true)"; fi
if [ -z "$TSC" ] && [ -x "$RUNTIME/.bin/tsc" ]; then TSC="$RUNTIME/.bin/tsc"; fi
if [ -z "$TSC" ]; then
  echo "build: 找不到 tsc —— 在项目里装一个（npm i -D typescript）或设置 DSH_CHECKOUT" >&2
  exit 1
fi
echo "=== tsc $("$TSC" -v) ==="
# 先把上一次编出来的探针**挪到一边**，再删 lib —— 顺序反了就等于"编不出来时净损失"。
# （2026-10-19 实测踩过：rm -rf lib 先跑，旧二进制已经没了，后面再想捡都无从捡起。）
PROBE_OUT="$ROOT/lib/native/mic-probe"
PROBE_SAVED=""
if [ -f "$PROBE_OUT" ]; then
  PROBE_SAVED="$(mktemp -t dsh-sel-micprobe)"
  cp "$PROBE_OUT" "$PROBE_SAVED"
fi
rm -rf "$ROOT/lib"
"$TSC" -p tsconfig.json

# ── ④ client 半 ──
echo "=== client modules → lib/client.js ==="
node scripts/build-client.mjs
node --check lib/client.js

# ── ⑤ 原生探针（macOS 专用）──
# 「检测输入法正在语音输入」靠读 CoreAudio 的进程对象列表（macOS 14.4+），
# Node 没有 FFI，所以编一个小二进制放进 lib/native/，host 需要时 spawn 它
# （见 src/host/mic.ts 的 resolveMicProbe）。
# 编不出来**不算构建失败**：功能降级成 available:false（和"没装识别服务"一个待遇），
# 其余功能一律不受影响；非 macOS 直接跳过。
#
# ⚠️ 这一节曾经只写一句 `clang`，在本机（2026-10-19）直接编不出来：
#    PATH 上的 /usr/bin/clang 解析到 CommandLineTools 的 MacOSX27.0 SDK，
#    那个 SDK 的 .tbd 里有这版 ld 不认识的 `arm64e.x1-macos` 架构 →
#    链接阶段 "tapi error: malformed file"。
#    而上一行的 `rm -rf lib` 已经把这个**原本好好的**二进制删掉了 ——
#    结果语音卡和"开麦即引用"两条功能一起静默失效（用户："语音卡片被你改没了"）。
# 所以：① 多试几套工具链，编出来一个就用；② 编不出来时**把旧的捡回来**，绝不净损失。
#    （旧二进制在 ③ 之前就已经暂存到 $PROBE_SAVED 了。）
mkdir -p "$ROOT/lib/native"

probe_compile() {
  # $@ = 编译器命令与参数（源码与 -o 由这里追加）
  "$@" -O2 -framework CoreAudio -framework CoreFoundation native/mic-probe.c -o "$PROBE_OUT" >/dev/null 2>&1
}

if [ "$(uname -s)" = "Darwin" ] && command -v clang >/dev/null 2>&1; then
  PROBE_OK=""
  # ① Xcode 自带 clang + 它自己的 SDK（本机实测能编的那一套）
  XCODE_CLANG="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"
  XCODE_SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
  if [ -x "$XCODE_CLANG" ] && [ -n "$XCODE_SDK" ] && probe_compile "$XCODE_CLANG" -isysroot "$XCODE_SDK"; then
    PROBE_OK="Xcode clang + $(basename "$XCODE_SDK")"
  # ② PATH 上的 clang（不指定 sysroot）
  elif probe_compile clang; then
    PROBE_OK="clang"
  # ③ xcrun 包一层
  elif probe_compile xcrun clang; then
    PROBE_OK="xcrun clang"
  fi
  if [ -n "$PROBE_OK" ]; then
    echo "=== 原生探针：${PROBE_OUT}（${PROBE_OK}）==="
  elif [ -n "$PROBE_SAVED" ]; then
    # 编不出来：把上一次那个捡回来。它多半仍然可用（源码没改过），
    # 而"没有探针"意味着语音功能整个消失 —— 两害相权，宁可留着旧的。
    cp "$PROBE_SAVED" "$PROBE_OUT"
    chmod +x "$PROBE_OUT" 2>/dev/null || true
    echo "build: 原生探针编译失败 —— 沿用上一次编出来的那份（语音功能不受影响）" >&2
  else
    echo "build: 原生探针编译失败 —— 麦克风占用检测将不可用（语音卡与开麦引用不会启用）" >&2
  fi
else
  echo "build: 跳过原生探针（非 macOS 或没有 clang）—— 麦克风占用检测不可用"
fi
# ── ⑥ 窗口列表探针（截图提问要"带出整窗"）──
# 和 mic-probe 同一套工具链探测；编不出来就让截图功能整体降级。
if [ "$(uname -s)" = "Darwin" ] && command -v clang >/dev/null 2>&1; then
  WL_OUT="$ROOT/lib/native/window-list"
  wl_compile() { "$@" -O2 -framework CoreFoundation -framework CoreGraphics native/window-list.c -o "$WL_OUT" >/dev/null 2>&1; }
  WL_OK=""
  if [ -x "${XCODE_CLANG:-}" ] && [ -n "${XCODE_SDK:-}" ] && wl_compile "$XCODE_CLANG" -isysroot "$XCODE_SDK"; then WL_OK="Xcode clang"
  elif wl_compile clang; then WL_OK="clang"
  elif wl_compile xcrun clang; then WL_OK="xcrun clang"
  fi
  if [ -n "$WL_OK" ]; then
    echo "=== 原生探针：${WL_OUT}（${WL_OK}）==="
  else
    echo "build: 窗口列表探针编译失败 —— 截图提问将不可用（不影响其它功能）" >&2
  fi
fi

if [ -n "$PROBE_SAVED" ]; then rm -f "$PROBE_SAVED"; fi

echo "=== 构建完成 ==="
ls -l lib
