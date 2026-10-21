/**
 * 客户档案文档测试
 * 验证：第 50 位客户编号、文件名规则、时区与时差、文档头部字段
 * 运行：node --experimental-sqlite test/doc.test.js
 */

const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '..', 'data', 'assistant.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);

const store = require('../src/db');
const doc = require('../src/customerDoc');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
}

// ---- 1. 账号 3 的第 50 位客户 ----
store.upsertAccount.run({ id: 3, label: '三号', phone: '', proxy: '' });
let mike = null;
for (let i = 1; i <= 50; i++) {
  const isMike = i === 50;
  const r = store.getOrCreateCustomer(3, `153468500${String(i).padStart(2, '0')}@s.whatsapp.net`, {
    name: isMike ? 'Mike' : `Client${i}`,
    phone: isMike ? '1534685245' : `153468500${String(i).padStart(2, '0')}`,
  });
  if (isMike) mike = r.customer;
}
check('账号3 第 50 位客户编号', mike.code, '3A00050');

// ---- 2. 补填地区，验证时区与时差 ----
store.updateCustomer.run({
  code: '3A00050', name: 'Mike', region: '旧金山',
  timezone: doc.guessTimezone('旧金山'), stage_day: 2, mood: '有兴趣',
  summary: null, profile_json: null,
});
mike = store.getCustomer.get('3A00050');
check('旧金山 -> 时区推断', mike.timezone, 'America/Los_Angeles');

const diff = doc.timeDiffFromBeijing('America/Los_Angeles');
console.log(`      时差描述：${diff.text}  (hours=${diff.hours})`);
check('旧金山比北京晚（负差值）', diff.hours < 0, JSON.stringify(diff));
check('时差小时数是整数', Number.isInteger(diff.hours), String(diff.hours));

// ---- 3. 文件名规则 ----
const fname = doc.docFileName(mike);
check('文件名 = 名称_地区_编号', fname, 'Mike_旧金山_3A00050.md');

// ---- 4. 写文档 ----
store.saveMessage({
  customerCode: '3A00050', accountId: 3, direction: 'in',
  body: 'Hi, I saw your work on Instagram. Do you paint cats?',
  bodyZh: '你好，我在 Instagram 看到你的作品，你画猫吗？', waMsgId: 'doc-1',
});
store.saveMessage({
  customerCode: '3A00050', accountId: 3, direction: 'out',
  body: 'Yes, cats are my favorite subject.', waMsgId: 'doc-2',
});

const msgs = store.listMessages.all('3A00050');
const file = doc.writeCustomerDoc(mike, msgs);
check('文档已生成', fs.existsSync(file), file);
check('文件名正确', path.basename(file), 'Mike_旧金山_3A00050.md');

const content = fs.readFileSync(file, 'utf8');

// ---- 5. 文档头部必须包含的字段 ----
const required = [
  ['编号', '3A00050'],
  ['姓名', 'Mike'],
  ['地区', '旧金山'],
  ['时间差', diff.text],
  ['电话号码', '1534685245'],
  ['加好友时间', null],
];
for (const [label, value] of required) {
  const line = content.split('\n').find((l) => l.includes(`| ${label} `));
  check(`文档含「${label}」`, !!line, content.slice(0, 400));
  if (value) check(`「${label}」内容正确`, line.includes(value), line);
}

const addFriendLine = content.split('\n').find((l) => l.includes('| 加好友时间'));
check('加好友时间精确到年月日时分', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(addFriendLine || ''), addFriendLine);

check('文档含对话记录', content.includes('对话记录'));
check('对话含中文翻译', content.includes('你画猫吗'));
check('对话区分收发方向', content.includes('] 客户') && content.includes('] 我'));

// ---- 6. 改名后自动重命名 ----
store.updateCustomer.run({
  code: '3A00050', name: 'Mike Zhang', region: '旧金山', timezone: mike.timezone,
  stage_day: 2, mood: '有兴趣', summary: null, profile_json: null,
});
const mike2 = store.getCustomer.get('3A00050');
const file2 = doc.writeCustomerDoc(mike2, msgs);
check('改名后文件重命名', path.basename(file2), 'Mike Zhang_旧金山_3A00050.md');
check('旧文件已不存在', !fs.existsSync(file), file);
check('编号保持不变', mike2.code, '3A00050');

console.log('\n----- 生成的文档预览 -----');
console.log(fs.readFileSync(file2, 'utf8').split('\n').slice(0, 26).join('\n'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
