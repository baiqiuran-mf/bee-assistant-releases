/**
 * v2.5.1069：settop.exe 路径解析 + 参数构造单测
 * 跑法：node test/settop.test.js
 *
 * 重点：确保「开发态能找到 bin/settop.exe」「参数构造与三种定位方式一一对应」，
 * 这是真置顶功能能跑起来的前提（路径错 → forceTopmost 直接 no-exe）。
 */
const fs = require('fs');
const { resolveSettopPath, buildArgs } = require('../src/settop');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}

console.log('\n=== buildArgs（参数构造）===');
check('pid → --pid', JSON.stringify(buildArgs({ pid: 1234 })) === JSON.stringify(['--pid', '1234']), JSON.stringify(buildArgs({ pid: 1234 })));
check('procName → --proc', JSON.stringify(buildArgs({ procName: 'Signal' })) === JSON.stringify(['--proc', 'Signal']));
check('title → --title', JSON.stringify(buildArgs({ title: 'WhatsApp' })) === JSON.stringify(['--title', 'WhatsApp']));
check('自定义 wait 生效', JSON.stringify(buildArgs({ pid: 1, wait: 500 })) === JSON.stringify(['--pid', '1', '--wait', '500']));
check('无目标 → null', buildArgs({}) === null);
check('只有 wait 无目标 → null', buildArgs({ wait: 1000 }) === null);

console.log('\n=== buildArgs（v2.5.1080 可组合扩展）===');
check('pid + title 可组合', JSON.stringify(buildArgs({ pid: 99, title: 'WhatsApp' })) === JSON.stringify(['--pid', '99', '--title', 'WhatsApp']));
check('procName + title 可组合', JSON.stringify(buildArgs({ procName: 'Signal', title: 'Signal' })) === JSON.stringify(['--proc', 'Signal', '--title', 'Signal']));
check('title 数组 → 多个 --title', JSON.stringify(buildArgs({ title: ['WhatsApp', 'Telegram'] })) === JSON.stringify(['--title', 'WhatsApp', '--title', 'Telegram']));
check('pid+title+wait 顺序正确', JSON.stringify(buildArgs({ pid: 7, title: 'WhatsApp', wait: 200 })) === JSON.stringify(['--pid', '7', '--title', 'WhatsApp', '--wait', '200']));
check('只有 wait 仍 → null', buildArgs({ title: '', wait: 1000 }) === null);

console.log('\n=== resolveSettopPath（路径解析）===');
const p = resolveSettopPath();
console.log('  解析到：' + p);
check('路径以 bin/settop.exe 结尾', /[\\/]bin[\\/]settop\.exe$/.test(p), p);
check('该路径真实存在', fs.existsSync(p), p);

console.log(`\n========== settop 路径/参数：${pass} 通过 / ${fail} 失败 ==========`);
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
