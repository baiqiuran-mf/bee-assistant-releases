/**
 * v2.5.1069：静默锁单测
 * 跑法：node test/silence.test.js
 *
 * 覆盖：setSilence / isSilent / remaining / _reset，以及「取较大值不缩短」的重叠语义。
 */
const { setSilence, isSilent, remaining, _reset } = require('../src/silence');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}

_reset();
console.log('\n=== silence 基础 ===');
check('初始不在静默期', isSilent() === false);
check('初始 remaining=0', remaining() === 0);

setSilence(3000);
check('setSilence(3000) 后处于静默期', isSilent() === true);
check('remaining > 0', remaining() > 0);
check('remaining <= 3000', remaining() <= 3000);

_reset();
check('reset 后不在静默期', isSilent() === false);
check('reset 后 remaining=0', remaining() === 0);

console.log('\n=== silence 边界 ===');
setSilence(0);
check('setSilence(0) 不产生静默', isSilent() === false);
setSilence(-100);
check('setSilence(负数) 不产生静默', isSilent() === false);

console.log('\n=== silence 重叠取较大值（不缩短）===');
setSilence(2000);
const r1 = remaining();
setSilence(100); // 更短，不应把静默期从 2000 缩到 100
const r2 = remaining();
check('后一次更短的静默不缩短已有静默期', r2 >= r1 - 50, `r1=${r1} r2=${r2}`);
_reset();

console.log(`\n========== 静默锁：${pass} 通过 / ${fail} 失败 ==========`);
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
