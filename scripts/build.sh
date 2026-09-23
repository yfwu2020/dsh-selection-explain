#!/usr/bin/env bash
# dsh-selection-explain 构建脚本
#   ① 探测 DSH 运行时（含 @deepseek-ai/* 包的那层 node_modules）
#   ② 建立 node_modules 链接（类型解析 + 运行时 import 都依赖它）
#   ③ tsc 编译 host 半：src/index.ts → lib/index.js(+ .d.ts)
#   ④ 校验并拷贝 client 半：src/client/index.js → lib/client.js
#        （客户端是手写的 ModuleLoader bundle，无需打包器）
# 用法：bash scripts/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── ① 运行时根：DSH_CHECKOUT → dsh CLI 所在安装 → 常见 checkout → npx 缓存 ──
# 返回「含 @deepseek-ai/dsh-llm 的那层 node_modules」。
probe() {
  local base="${1:-}"
  [ -n "$base" ] || return 1
  if [ -d "$base/@deepseek-ai/dsh-llm" ]; then echo "$base"; return 0; fi
  if [ -d "$base/node_modules/@deepseek-ai/dsh-llm" ]; then echo "$base/node_modules"; return 0; fi
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
"$TSC" -p tsconfig.json

# ── ④ client 半 ──
echo "=== client bundle：src/client/index.js → lib/client.js ==="
node --check src/client/index.js
mkdir -p lib
cp src/client/index.js lib/client.js

echo "=== 构建完成 ==="
ls -l lib
