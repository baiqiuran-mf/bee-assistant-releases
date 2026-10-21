/**
 * 提取间隔（消息兜底重扫）· 纯函数单元测试
 *
 * 不连库、不起服务、不动真实 config.yaml（setScalar 直接吃内存里的字符串）。
 * 跑法：node --experimental-sqlite test/extract_interval.test.js
 */
const { clampExtractInterval, setScalar } = require('../src/configWrite');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + extra : ''}`); }
}

console.log('\n=== 提取间隔 · clampExtractInterval（2~15 秒）===');
check('小于 2 → 回到 2', clampExtractInterval(1) === 2);
check('正好 2 → 2', clampExtractInterval(2) === 2);
check('5 → 5', clampExtractInterval(5) === 5);
check('15 → 15', clampExtractInterval(15) === 15);
check('大于 15 → 回到 15', clampExtractInterval(20) === 15);
check('小数 3.7 → 四舍五入 4', clampExtractInterval(3.7) === 4);
check('非数字 → 回退默认 5', clampExtractInterval('abc') === 5);
check('NaN → 回退默认 5', clampExtractInterval(NaN) === 5);
check('undefined → 回退默认 5', clampExtractInterval(undefined) === 5);
check('显式回退值生效', clampExtractInterval('x', 10) === 10);
check('边界 14 → 14', clampExtractInterval(14) === 14);

console.log('\n=== 提取间隔 · setScalar 写入 app.extractInterval（行内改写、注释不丢）===');
const sample = `app:
  dataDir: ./data
  port: 8787
  # 收到消息后自动翻译
  autoTranslate: true
  # 消息提取间隔（秒）
  extractInterval: 5
`;
const r1 = setScalar(sample, ['app', 'extractInterval'], 12);
check('setScalar 标记已改动', r1.changed === true);
check('写进的是 12', /extractInterval:\s*"?12"?/.test(r1.text), r1.text.split('\n').find((l) => /extractInterval/.test(l)));
check('原有同行注释保留', /消息提取间隔/.test(r1.text), '注释被吃掉了');
check('dataDir 那行注释也还在（没误伤）', /收到消息后自动翻译/.test(r1.text));
check('端口没被改', /port:\s*8787/.test(r1.text));

// 没有这个键时也能补上（插到 app 块末尾）
const missing = `app:
  dataDir: ./data
  port: 8787
`;
const r2 = setScalar(missing, ['app', 'extractInterval'], 8);
check('缺键时自动补一行', r2.changed === true && /extractInterval:\s*"?8"?/.test(r2.text), r2.text);

// 超范围的写值会被 clamp 拦住（这里只验 setScalar 原样写；clamp 在 server 里先调）
const r3 = setScalar(sample, ['app', 'extractInterval'], 99);
check('setScalar 原样写 99（clamp 由调用方负责）', /extractInterval:\s*"?99"?/.test(r3.text), r3.text.split('\n').find((l) => /extractInterval/.test(l)));

const ok = fail === 0;
console.log(`\n[提取间隔测试] ${ok ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
if (!ok) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(ok ? 0 : 1);
