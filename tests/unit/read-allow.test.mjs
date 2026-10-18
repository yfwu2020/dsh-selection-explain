/**
 * 文件工具的"访客名单"：项目内放行、本次附带的文件也放行、其余照旧拒。
 *
 * 这条测的不是功能，是**边界**：放开的地方必须刚好等于"用户亲手附上的那几个文件"，
 * 多一格都是把 `isInsideRoot` 那套防注入的姿态拆掉一块。
 */
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { isInsideRoot, isReadAllowed } from '../../lib/host/tools.js'

const project = '/work/project'
const attachStore = '/home/u/.dsh/attachments/v1/files'
const attachedFile = join(attachStore, 'f5', 'f52cd4ba', '让你下乡采风.txt')
const otherAttached = join(attachStore, 'a2', 'a23a062b', '别的东西.pdf')
const attached = new Set([resolve(attachedFile), resolve(otherAttached)])

let failed = 0
function check(label, ok, detail) {
  if (ok) console.log(`  ✓ ${label}`)
  else { failed += 1; console.log(`  ✗ ${label} — ${detail}`) }
}

// ── 前提：不加名单时，附件路径就是被拒的（这正是用户撞到的那个 bug）──
check('（前提）附件路径在项目外，裸边界判定拒绝', isInsideRoot(project, attachedFile) === false)
check('（前提）不带名单时，附件路径也读不了', isReadAllowed(project, attachedFile) === false, String(isReadAllowed(project, attachedFile)))

// ── 名单里的文件：放行 ──
check('本次附带的文件：放行', isReadAllowed(project, attachedFile, attached) === true)
check('同一次附带的第二个文件也放行', isReadAllowed(project, otherAttached, attached) === true)

// ── 项目内照旧放行 ──
check('项目内的文件仍然放行', isReadAllowed(project, join(project, 'src', 'index.ts'), attached) === true)
check('项目根本身放行', isReadAllowed(project, project, attached) === true)
check('相对路径按项目根解析后放行', isReadAllowed(project, 'src/client/index.js', attached) === true)

// ── 名单**外面**的一律照旧拒（放开范围必须刚好等于名单）──
check('附件仓里**别的**文件仍拒（名单不是"整个附件仓"）',
  isReadAllowed(project, join(attachStore, 'ff', 'ffff', '别人的秘密.txt'), attached) === false)
check('附件仓的父目录仍拒', isReadAllowed(project, '/home/u/.dsh/attachments/v1', attached) === false)
check('家目录仍拒', isReadAllowed(project, '/home/u/.ssh/id_rsa', attached) === false)
check('系统文件仍拒', isReadAllowed(project, '/etc/passwd', attached) === false)
check('~ 开头仍拒（这条判断在 isInsideRoot 里，别被名单绕过）',
  isReadAllowed(project, '~/secret.txt', attached) === false)
check('项目外的兄弟目录仍拒', isReadAllowed(project, '/work/other/file.ts', attached) === false)
check('路径穿越仍拒', isReadAllowed(project, '/work/project/../secret.txt', attached) === false)

// ── 用 .. 假装成名单里的文件也不行（名单是按 resolve 后的绝对路径比对的）──
check('用相对路径绕到附件仓（不在名单里）仍拒',
  isReadAllowed(project, attachStore + '/ff/ffff/x.txt', attached) === false)

// ── 空名单 / 空路径 / 不限根 ──
check('空名单 = 行为与从前完全一致', isReadAllowed(project, attachedFile, new Set()) === false)
check('不给名单参数也不炸', isReadAllowed(project, attachedFile) === false)
// 空路径在 isInsideRoot 里是**故意放行**的（"没给 path 就走默认工作目录"，与 guard.test.mjs 一致）
// —— 别让它被名单那套逻辑改成拒绝，那会变成另一个回归。
check('空路径照旧放行（与 isInsideRoot 的既有行为一致）', isReadAllowed(project, '', attached) === true)
check('root 为空 = 不限：名单无关紧要', isReadAllowed('', '/anywhere/at/all.txt', attached) === true)

process.exit(failed === 0 ? 0 : 1)
