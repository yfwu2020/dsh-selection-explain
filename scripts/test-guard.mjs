/**
 * 文件工具边界（isInsideRoot）离线测试。
 *
 * 为什么要有这条测试：read/grep/glob 能读用户有权读的**任何**文件，
 * 而划词的触发源（选中文字/上下文/搜索结果）可能是别人写的。
 * 边界判断一旦写错（比如前缀匹配写成 `startsWith(root)`），
 * `/Users/me/project-evil` 就会被误判成在 `/Users/me/project` 之内。
 *
 * 用法：node scripts/test-guard.mjs
 */
import { isInsideRoot } from '../lib/index.js'

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — 期望 ${String(expected)}，实际 ${String(actual)}`)
}

const ROOT = '/Users/me/project'

// 不限（root 为空）：一切都放行
check('root 为空时放行相对路径', isInsideRoot('', 'a.txt'), true)
check('root 为空时放行绝对路径', isInsideRoot('', '/etc/hosts'), true)

// 项目内
check('项目内的相对路径', isInsideRoot(ROOT, 'src/index.ts'), true)
check('项目内的绝对路径', isInsideRoot(ROOT, '/Users/me/project/src/a.ts'), true)
check('项目根目录本身', isInsideRoot(ROOT, '/Users/me/project'), true)
check('带 .. 但仍在项目内', isInsideRoot(ROOT, 'src/../README.md'), true)

// 项目外
check('父目录', isInsideRoot(ROOT, '../secrets.txt'), false)
check('绝对路径指向项目外', isInsideRoot(ROOT, '/etc/hosts'), false)
check('家目录', isInsideRoot(ROOT, '/Users/me/.ssh/id_rsa'), false)
check('~ 开头一律拒', isInsideRoot(ROOT, '~/.dsh/settings.yaml'), false)
check('单独一个 ~', isInsideRoot(ROOT, '~'), false)
// 前缀陷阱：同名兄弟目录不能算"在项目内"
check('前缀相同的兄弟目录不算项目内', isInsideRoot(ROOT, '/Users/me/project-evil/x'), false)
check('前缀相同的兄弟文件不算项目内', isInsideRoot(ROOT, '/Users/me/project.bak'), false)

// 没给路径（grep/glob 的 path 是可选的，默认 = 会话工作目录）→ 放行
check('未给 path 时放行（走默认工作目录）', isInsideRoot(ROOT, ''), true)

console.log(`\n=== 边界测试结束：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
