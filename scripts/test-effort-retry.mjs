/**
 * 档位重试策略的确定性单测（不碰网络、不依赖宿主）。
 *
 * 为什么必须有这一份：这套逻辑的输入是**上游错误的文案**，而它曾经把
 * 「偶发上游 400」误判成「这个档位不被支持」，连锁出三个错：
 *   ① 给用户一句错诊断（「该档位不支持」）；
 *   ② 把这次偶发失败**永久记进** leaky-off.json（以后再也不发这个档）；
 *   ③ 客户端清掉用户选的档位。
 * 2026-10-09 实测（活宿主 /analyze，交错发送排除时间漂移）：
 *   opencode-go/step-5-preview-free：effort=low 成功 5/8、effort=high 成功 5/8
 *   —— **同一档位时好时坏，档位不是变量**；对照 longcat-2.5-preview-free 6/6 成功。
 * 所以下面第一条断言就是那个回归闸门。
 *
 * 另一条被锁住的事实：老代码重试时把档位**整个去掉**（省略 reasoning），
 * 实测 20 次重试 0 次成功 —— 对"必须开推理"的端点，省略等于把推理关掉。
 * 新策略永远给一个显式档位（pickNextEffort 不会返回空，除非真的没档可换）。
 */
import { __internals } from '../lib/index.js'

const { looksLikeUnsupportedTier, looksLikeReasoningRequired, pickNextEffort } = __internals

let failed = 0
function assert(name, ok, detail) {
  if (ok) {
    console.log('  ✓ ' + name)
  } else {
    failed += 1
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''))
  }
}

// ── ① 那条真实的上游文案 ──
const STEP5_FLAKY =
  '400: {"type":"server_error","message":"Upstream request failed: [400] Reasoning is mandatory for this endpoint and cannot be disabled."}'

console.log('[1] 偶发上游错误不能被当成"档位不支持"')
assert('step-5 那句原文 → 不是"档位无效"', looksLikeUnsupportedTier(STEP5_FLAKY) === false)
assert('step-5 那句原文 → 是"必须开推理"（只在发关档时才算数）', looksLikeReasoningRequired(STEP5_FLAKY) === true)
assert(
  '同一句在发 high 时不该被当成档位问题（我们没关推理）',
  // 调用方的判据：rejected !== 'off' 时用 looksLikeUnsupportedTier
  looksLikeUnsupportedTier(STEP5_FLAKY) === false,
)

console.log('\n[2] 真正"档位不被支持"的措辞要认得出来')
for (const text of [
  'provider "opencode-go" model "x" does not support reasoning effort "max"',
  'invalid reasoning effort: max',
  'unsupported reasoning_effort value',
  '该模型不支持 reasoning 档位',
  'thinking 参数无效',
  'Unrecognized effort "medium"',
]) {
  assert('认得：' + text.slice(0, 42), looksLikeUnsupportedTier(text) === true)
}

console.log('\n[3] 无关错误不要误判成档位问题')
for (const text of [
  'Upstream request failed: [500] internal error',
  'network timeout',
  '401 unauthorized: invalid api key',
  'Rate limit exceeded',
  '模型调用失败',
]) {
  assert('不误判：' + text.slice(0, 34), looksLikeUnsupportedTier(text) === false)
}

console.log('\n[4] 换档：永远给显式档位，且不重复发同一个档')
const DECLARED = ['off', 'low', 'high', 'max']
assert('off 被拒 → 低（最接近关的可接受档）', pickNextEffort(DECLARED, null, 'off', new Set(['off'])) === 'low')
assert('low 被拒 → 高', pickNextEffort(DECLARED, null, 'low', new Set(['low'])) === 'high')
assert('high 被拒 → 最大', pickNextEffort(DECLARED, null, 'high', new Set(['high'])) === 'max')
assert(
  'max 被拒 → 退到高（**不是**退回关：off 恰恰最容易被拒）',
  pickNextEffort(DECLARED, null, 'max', new Set(['max'])) === 'high',
)
assert(
  '模型声明的 defaultEffort 优先',
  pickNextEffort(DECLARED, 'medium', 'high', new Set(['high'])) === 'medium',
)
assert(
  'defaultEffort 就是被拒的那个 → 继续沿阶梯找',
  pickNextEffort(DECLARED, 'high', 'high', new Set(['high'])) === 'max',
)
assert(
  '没档位可换时返回空串（调用方据此不重试，而不是省略档位）',
  pickNextEffort(['high'], null, 'high', new Set(['high'])) === '',
)
assert(
  '不会发模型没声明的档（只声明 off/low 时不去发 high）',
  pickNextEffort(['off', 'low'], null, 'low', new Set(['low'])) === 'off',
)
assert(
  '连着重试两次：两次都不重复（off → low → high）',
  (() => {
    const tried = new Set(['off'])
    const a = pickNextEffort(DECLARED, null, 'off', tried)
    tried.add(a)
    const b = pickNextEffort(DECLARED, null, a, tried)
    return a === 'low' && b === 'high'
  })(),
)
assert(
  '清单还没加载（declared 空）时也能换：走完整阶梯',
  pickNextEffort([], null, 'low', new Set(['low'])) === 'high',
)

console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
