/**
 * 编号生成器测试
 * 覆盖：起始编号、递增、字母进位、账号隔离、解析与排序、异常输入
 * 运行：node --experimental-sqlite test/ids.test.js
 */

const ids = require('../src/ids');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
}
function eq(name, actual, expected) {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
function throws(name, fn) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  check(name, threw, '没有按预期抛错');
}

console.log('--- 编号生成器 ---');

// 1. 起始编号
eq('无历史时账号1 起始编号', ids.nextCustomerCode(1, null), '1A00001');
eq('无历史时账号5 起始编号', ids.nextCustomerCode(5, null), '5A00001');

// 2. 递增
eq('1A00001 的下一个', ids.nextCustomerCode(1, '1A00001'), '1A00002');
eq('1A00009 → 进位宽度正确', ids.nextCustomerCode(1, '1A00009'), '1A00010');
eq('3A00049 → 第 50 位', ids.nextCustomerCode(3, '3A00049'), '3A00050');

// 3. 字母进位
eq('1A99999 → 进位到 B', ids.nextCustomerCode(1, '1A99999'), '1B00001');
eq('1B00001 正常递增', ids.nextCustomerCode(1, '1B00001'), '1B00002');
eq('2B99999 → 进位到 C', ids.nextCustomerCode(2, '2B99999'), '2C00001');
eq('5Z99999 应该耗尽', (() => { try { return ids.nextCustomerCode(5, '5Z99999'); } catch (e) { return 'EXHAUSTED'; } })(), 'EXHAUSTED');

// 4. 解析
const p = ids.parseCode('3A00050');
check('parseCode 返回非空', !!p);
eq('parseCode 账号', p.account, 3);
eq('parseCode 字母', p.letter, 'A');
eq('parseCode 序号', p.seq, 50);
check('parseCode 拒绝非法值', ids.parseCode('12345') === null);
check('parseCode 拒绝空值', ids.parseCode('') === null);
check('parseCode 拒绝超长序号', ids.parseCode('1A000050') === null);
check('parseCode 大小写不敏感', ids.parseCode('1a00001').seq === 1);

// 5. 补零
eq('formatSeq(1)', ids.formatSeq(1), '00001');
eq('formatSeq(99999)', ids.formatSeq(99999), '99999');
eq('SEQ_MAX 常量', ids.SEQ_MAX, 99999);

// 6. 账号隔离：五个账号各自从 A00001 开始
for (let a = 1; a <= 5; a++) {
  eq(`账号${a} 独立起始`, ids.nextCustomerCode(a, null), `${a}A00001`);
}
check('不同账号编号不串号', ids.nextCustomerCode(1, '1A00005').startsWith('1') && ids.nextCustomerCode(3, '3A00049').startsWith('3'));

// 7. 非法输入
throws('账号号非法应抛错', () => ids.nextCustomerCode(0, null));
throws('账号号非整数应抛错', () => ids.nextCustomerCode(1.5, null));
throws('账号与编号不匹配应抛错', () => ids.nextCustomerCode(2, '1A00001'));
throws('无法解析的历史编号应抛错', () => ids.nextCustomerCode(1, '乱码'));

// 8. 排序（位数固定，字典序即数值序）
check('1A00009 < 1A00010', ids.compareCode('1A00009', '1A00010') < 0);
check('1A99999 < 1B00001', ids.compareCode('1A99999', '1B00001') < 0);
check('1A00001 < 3A00001', ids.compareCode('1A00001', '3A00001') < 0);
check('相同编号返回 0', ids.compareCode('2A00007', '2A00007') === 0);

// 9. 连跑 120 个客户，确认连续分配不重复
const seen = new Set();
let cur = null;
for (let i = 0; i < 120; i++) {
  cur = ids.nextCustomerCode(4, cur);
  seen.add(cur);
}
eq('120 个编号互不重复', seen.size, 120);
check('第 120 个落在 A 段末尾之后仍是 00021', cur === '4A00120', cur);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
