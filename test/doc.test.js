/**
 * 客户档案文档测试
 * 验证：第 50 位客户编号、文件名规则、时区与时差、文档头部字段
 * 运行：node --experimental-sqlite test/doc.test.js
 */

const fs = require('fs');
const path = require('path');

// 数据隔离：本测试只写临时目录，绝不碰真实 data/
const { DIR: DATA_DIR } = require('./_isolate.js');
const DB = path.join(DATA_DIR, 'assistant.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);

const store = require('../src/db');
const doc = require('../src/customerDoc');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
}
// 注意：check 的第三个参数是「失败时显示的提示」，不是期望值。
// 要比较具体的值必须用 eq，否则写成 check('x', actual, expected) 会因为 cond 恒为真而假通过。
function eq(name, actual, expected) {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
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
eq('账号3 第 50 位客户编号', mike.code, '3A00050');

// ---- 2. 补填地区，验证时区与时差 ----
store.updateCustomer.run({
  code: '3A00050', name: 'Mike', region: '旧金山',
  timezone: doc.guessTimezone('旧金山'), stage_day: 2, mood: '有兴趣',
  summary: null, profile_json: null, phone: '1534685245',
  // 命名参数必须写全：better-sqlite3 / node:sqlite 缺一个就抛
  // "Missing named parameter"（这个测试就是这么坏掉很久的）
  created_at: null, created_at_source: null,
});
mike = store.getCustomer.get('3A00050');
eq('旧金山 -> 时区推断', mike.timezone, 'America/Los_Angeles');

const diff = doc.timeDiffFromBeijing('America/Los_Angeles');
console.log(`      时差描述：${diff.text}  (hours=${diff.hours})`);
check('旧金山比北京晚（负差值）', diff.hours < 0, JSON.stringify(diff));
check('时差小时数是整数', Number.isInteger(diff.hours), String(diff.hours));

// ---- 3. 文件名规则 ----
const fname = doc.docFileName(mike);
eq('文件名 = 编号_名称_电话', fname, '3A00050_Mike_1534685245.md');

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
eq('文件名正确', path.basename(file), '3A00050_Mike_1534685245.md');

const content = fs.readFileSync(file, 'utf8');

// ---- 5. 文档头部必须包含的字段 ----
const required = [
  ['编号', '3A00050'],
  ['姓名', 'Mike'],
  ['地区', '旧金山'],
  ['时间差', diff.text],
  ['电话号码', '1534685245'],
  ['加入时间', null],
];
// 表头里可能有 **加粗**，比对前先抹掉
const plain = content.replace(/\*\*/g, '');
for (const [label, value] of required) {
  const line = plain.split('\n').find((l) => l.includes(`| ${label} `));
  check(`文档含「${label}」`, !!line, content.slice(0, 400));
  if (value) check(`「${label}」内容正确`, line.includes(value), line);
}

const joinedLine = plain.split('\n').find((l) => l.includes('| 加入时间'));
check('加入时间精确到年月日时分', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(joinedLine || ''), joinedLine);
check('加入时间标注来源', content.includes('加入时间来源'), '');
// 2026-09-30 用户要求：档案 md 里不再记录任何 Day（阶段 / 认识第几天）
check('档案 md 不含「认识第 N 天」', !/认识第 \d+ 天/.test(content), joinedLine);
check('档案 md 不含「当前阶段 / Day N」', !/当前阶段/.test(content) && !/Day \d/.test(content), '');

check('文档含对话记录', content.includes('对话记录'));
check('对话含中文翻译', content.includes('你画猫吗'));
check('对话区分收发方向', content.includes('] 客户') && content.includes('] 我'));

// ---- 6. 改名后自动重命名 ----
store.updateCustomer.run({
  code: '3A00050', name: 'Mike Zhang', region: '旧金山', timezone: mike.timezone,
  stage_day: 2, mood: '有兴趣', summary: null, profile_json: null, phone: '1534685245',
  created_at: null, created_at_source: null,
});
const mike2 = store.getCustomer.get('3A00050');
const file2 = doc.writeCustomerDoc(mike2, msgs);
eq('改名后文件重命名', path.basename(file2), '3A00050_Mike Zhang_1534685245.md');
check('旧文件已不存在', !fs.existsSync(file), file);
check('编号保持不变', mike2.code, '3A00050');

// ---- 7. 补充校验：文件名清洗与文档其余字段 ----
eq('文件名里的非法字符被清理', doc.docFileName({ code: '3A00050', name: 'A/B:C*D?', region: '旧"金山' }), '3A00050_ABCD_未知电话.md');
eq('缺名称与电话时有兜底文件名', doc.docFileName({ code: '1A00001' }), '1A00001_未命名_未知电话.md');
const content2 = fs.readFileSync(file2, 'utf8');
check('文档含时区行', content2.includes('| 时区 | America/Los_Angeles |'), content2.slice(0, 300));
check('文档含所属账号行', /\|\s*所属 WhatsApp 账号\s*\|\s*3 号\s*\|/.test(content2));
check('文档只含极简 6 字段档案（已废弃的「## 客户档案」富文本段不再生成）',
  !content2.includes('## 客户档案') && content2.includes('| 电话号码 |'), content2.slice(0, 300));
check('文档含编号永不变更说明', content2.includes('永不变更'));
check('未填地区时给出提示而不是崩', doc.timeDiffFromBeijing(null).text.includes('地区未填'));

// ---- 8. 时区改成「填数字」（2026-09-30 用户要求）----
// 档案弹窗里的「时区」栏现在填的是「和北京差几小时」：比北京晚填负数、快填正数。
// 三种写法在档案 md 里都要说人话，不能出现「（时区识别失败）」。
console.log('\n----- 时区三态（手填数字 / 留空 / 老数据 IANA）-----');
const tzBase = store.getCustomer.get('3A00050');
eq('手填 -12 被认成"与北京的小时差"', doc.tzManualHours('-12'), -12);
eq('±号写法也认', doc.tzManualHours('+3'), 3);
eq('半点时区认（印度 -2.5）', doc.tzManualHours('-2.5'), -2.5);
eq('IANA 时区名不会被当成数字', doc.tzManualHours('America/New_York'), null);
eq('空值不会被当成数字', doc.tzManualHours(''), null);

const handMd = doc.renderDoc({ ...tzBase, region: 'Boston', timezone: '-12' }, []);
check('手填时差写进「时间差」：比北京晚 12 小时',
  /当地时间比北京时间晚 12 小时/.test(handMd), handMd.split('\n').find((l) => l.includes('| 时间差')));
check('手填时差不出现「时区识别失败」', !handMd.includes('时区识别失败'), '');
check('手填时差在「时区」行标明是手填（并附按地区推测的名字）',
  /\| 时区 \| 手填时差 -12 小时/.test(handMd) && /America\/New_York/.test(handMd),
  handMd.split('\n').find((l) => l.includes('| 时区')));

const autoMd = doc.renderDoc({ ...tzBase, region: 'Boston', timezone: '' }, []);
check('留空 → 按地区自动算时差（波士顿 = 纽约时区）',
  /当地时间比北京时间晚/.test(autoMd) && autoMd.includes('America/New_York'),
  autoMd.split('\n').find((l) => l.includes('| 时区')));

const legacyMd = doc.renderDoc({ ...tzBase, region: 'Boston', timezone: 'America/New_York' }, []);
check('老数据的 IANA 时区照旧能算',
  /当地时间比北京时间晚/.test(legacyMd) && legacyMd.includes('| 时区 | America/New_York |'),
  legacyMd.split('\n').find((l) => l.includes('| 时区')));

const zeroMd = doc.renderDoc({ ...tzBase, region: '', timezone: '0' }, []);
check('填 0 → 与北京时间相同（当地 UTC+8）',
  /与北京时间相同/.test(zeroMd) && /UTC\+8/.test(zeroMd),
  zeroMd.split('\n').find((l) => l.includes('| 时间差')));

console.log('\n----- 生成的文档预览 -----');
console.log(fs.readFileSync(file2, 'utf8').split('\n').slice(0, 26).join('\n'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
