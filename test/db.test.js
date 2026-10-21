/**
 * 数据库与待处理状态机测试
 * 覆盖：编号分配、客户绑定、收发消息的状态流转、去重、翻译字段、查重、账号表
 * 运行：node --experimental-sqlite test/db.test.js
 */

const fs = require('fs');
const path = require('path');

// 数据隔离：本测试只写临时目录，绝不碰真实 data/assistant.db
const { DIR: DATA_DIR } = require('./_isolate.js');
const DB = path.join(DATA_DIR, 'assistant.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);

const store = require('../src/db');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
}
function eq(name, actual, expected) {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

console.log('--- 数据库 ---');
console.log(`驱动：${store.driver}`);

// ---- 账号表 ----
store.upsertAccount.run({ id: 1, label: '主号', phone: '', proxy: '' });
store.upsertAccount.run({ id: 3, label: '三号', phone: '', proxy: '' });
eq('账号已写入 2 条', store.listAccounts.all().length, 2);

store.upsertAccount.run({ id: 1, label: '主号改', phone: '', proxy: '' });
eq('重复 upsert 不新增行', store.listAccounts.all().length, 2);
eq('upsert 更新了 label', store.listAccounts.all().find((a) => a.id === 1).label, '主号改');

store.setAccountStatus.run('online', new Date().toISOString(), 1);
eq('账号状态可更新', store.listAccounts.all().find((a) => a.id === 1).status, 'online');

// ---- 编号分配与绑定 ----
const jidA = '15346850001@s.whatsapp.net';
const jidB = '15346850002@s.whatsapp.net';

const r1 = store.getOrCreateCustomer(1, jidA, { name: 'Alice', phone: '15346850001' });
check('新客户 isNew=true', r1.isNew === true);
eq('账号1 第一个客户编号', r1.customer.code, '1A00001');

const r2 = store.getOrCreateCustomer(1, jidA, { name: 'Alice' });
check('同一 JID 第二次 isNew=false', r2.isNew === false);
eq('同一 JID 编号不变', r2.customer.code, '1A00001');

const r3 = store.getOrCreateCustomer(1, jidB, { name: 'Bob', phone: '15346850002' });
eq('第二个客户编号递增', r3.customer.code, '1A00002');

const r4 = store.getOrCreateCustomer(3, jidA, { name: 'Alice', phone: '15346850001' });
eq('同手机号跨账号 → 复用同一编号（以手机号为基准）', r4.customer.code, '1A00001');
check('跨账号 isNew=false（同一客户不重复建号）', r4.isNew === false);
eq('编号仍绑在最先建档的那个 JID 上', store.getCustomer.get('1A00001').wa_jid, jidA);

// 账号 3 上的另一位客户（**不同**手机号）→ 正常新开编号，供后面的状态机用例用
const r5 = store.getOrCreateCustomer(3, '15346850003@s.whatsapp.net', { name: 'Carol', phone: '15346850003' });
eq('账号3 的第一个客户编号', r5.customer.code, '3A00001');

const noName = store.getOrCreateCustomer(1, '15346859999@s.whatsapp.net', {});
eq('未传姓名时从 JID 推出电话', noName.customer.phone, '15346859999');

// ---- 待处理状态机 ----
store.saveMessage({ customerCode: '1A00001', accountId: 1, direction: 'in', body: 'Hi there', waMsgId: 'm-1' });
eq('收到消息 → pending=1', store.getCustomer.get('1A00001').pending, 1);

store.saveMessage({ customerCode: '1A00001', accountId: 1, direction: 'out', body: 'Hello!', waMsgId: 'm-2' });
eq('发出消息 → 不再自动清 pending（等用户点「标记已回复」才算处理完）', store.getCustomer.get('1A00001').pending, 1);
eq('发出消息 → 未读清零（回了就算看过了）', store.getCustomer.get('1A00001').unread, 0);

store.saveMessage({ customerCode: '1A00002', accountId: 1, direction: 'in', body: 'How much?', waMsgId: 'm-3' });
eq('另一个客户收到消息 → pending=1', store.getCustomer.get('1A00002').pending, 1);

store.saveMessage({ customerCode: '1A00002', accountId: 1, direction: 'in', body: 'size please', waMsgId: 'm-4', silent: true });
eq('silent 历史同步不改变 pending', store.getCustomer.get('1A00002').pending, 1);

store.markPending('1A00002');
eq('markPending 强制置位', store.getCustomer.get('1A00002').pending, 1);
store.clearPending('1A00002');
eq('clearPending 手动清除（标记已回复）', store.getCustomer.get('1A00002').pending, 0);

check('listPending 只返回待处理', store.listPending.all().every((c) => c.pending === 1));

// ---- 消息去重与翻译 ----
const dup = store.saveMessage({ customerCode: '1A00001', accountId: 1, direction: 'in', body: 'Hi there', waMsgId: 'm-1' });
eq('同一 wa_msg_id 重复入库被忽略', dup.changes, 0);

const before = store.listMessages.all('1A00001').length;
const last = store.listMessages.all('1A00001')[before - 1];
store.setTranslation.run('你好', last.id);
eq('翻译字段写入成功', store.listMessages.all('1A00001')[before - 1].body_zh, '你好');
eq('重复消息没有新增行', store.listMessages.all('1A00001').length, before);

const msgs = store.listMessages.all('1A00001');
check('消息按写入顺序返回', msgs.length >= 2 && msgs[0].id < msgs[1].id);
check('recentMessages 遵守条数', store.recentMessages.all('1A00001', 1).length === 1);
check('消息带方向标记', msgs.some((m) => m.direction === 'in') && msgs.some((m) => m.direction === 'out'));

// ---- 档案更新 ----
const alice = store.getCustomer.get('1A00001');
store.updateCustomer.run({
  code: '1A00001',
  name: 'Alice',
  region: '旧金山',
  timezone: 'America/Los_Angeles',
  stage_day: 2,
  mood: '有兴趣',
  summary: null,
  profile_json: null,
  phone: null,
  created_at: null,
  created_at_source: null,
});
check('档案可写入地区与时区', store.getCustomer.get('1A00001').timezone === 'America/Los_Angeles');

store.updateCustomer.run({
  code: '1A00001', name: null, region: null, timezone: null,
  stage_day: 3, mood: null, summary: null,
  profile_json: JSON.stringify({ pet: 'Milo' }),
  phone: null,
  created_at: null,
  created_at_source: null,
});
const updated = store.getCustomer.get('1A00001');
eq('阶段已更新', updated.stage_day, 3);
eq('COALESCE 保护：姓名未被清空', updated.name, 'Alice');
eq('COALESCE 保护：地区未被清空', updated.region, '旧金山');
eq('档案 JSON 已写入', JSON.parse(updated.profile_json).pet, 'Milo');

// ---- 跨账号查重 ----
// 注：新规则（以手机号为基准）下，同手机号在建档时就被编号库合并了，
//     正常路径不会再产出「同号两码」。这里直接插一条**历史遗留**数据
//     （模拟升级前已建的客户），验证查重函数仍能兜住老数据、给界面出重复提醒。
store.db.prepare(
  `INSERT INTO customers (code, account_id, wa_jid, phone, name, channel, created_at, is_sim)
   VALUES (?,?,?,?,?,?,?,?)`
).run('3A00002', 3, '15346850001@s.whatsapp.net', '15346850001', 'Alice(旧号)', 'whatsapp', new Date().toISOString(), 0);

const dups = store.findPossibleDuplicates('3A00002');
check('同一手机号跨账号能查出来', dups.some((d) => d.code === '1A00001'), JSON.stringify(dups.map((d) => d.code)));
check('查重不含自己', !dups.some((d) => d.code === '3A00002'));
check('不存在客户时查重返回空', store.findPossibleDuplicates('9A99999').length === 0);
check('不存在的客户 getCustomer 返回空', store.getCustomer.get('9A99999') === undefined);

// ---- 建议表 ----
store.insertSuggestion.run({
  customer_code: '1A00001', message_id: 1, model: 'hunyuan:hy3',
  options_json: JSON.stringify([{ tone: 'neutral', text: '好的' }]),
  rationale: '测试', risk_flags: '[]', created_at: new Date().toISOString(),
});
const sug = store.db.prepare('SELECT * FROM suggestions WHERE customer_code=?').all('1A00001');
eq('建议已入库', sug.length, 1);
check('建议选项可反序列化', JSON.parse(sug[0].options_json)[0].text === '好的');

// ---- 消息级「已处理」：新消息左边的红/绿数字 + 顶栏「待处理 N」都靠它 ----
const pendFor = (code) => store.listMessages.all(code)
  .filter((m) => m.direction === 'in' && !Number(m.processed)).length;

const beforePend = pendFor('3A00001');
const beforeAll = store.countUnprocessed();
store.saveMessage({
  customerCode: '3A00001', accountId: 3, direction: 'in',
  body: 'a brand new one', waMsgId: 'proc-test-1', msgTs: new Date().toISOString(), silent: false,
});
eq('新消息 → 该客户未处理 +1', pendFor('3A00001'), beforePend + 1);
eq('新消息 → 全局待处理 +1（每来一条加 1）', store.countUnprocessed(), beforeAll + 1);

store.clearPending('3A00001'); // 相当于点了「✓ 标记已回复」
eq('标记已回复 → 该客户未处理清零', pendFor('3A00001'), 0);
eq('标记已回复 → 全局待处理同步减少', store.countUnprocessed(), beforeAll - beforePend);
check('处理过的消息 processed=1（数字会消失）',
  store.listMessages.all('3A00001').filter((m) => m.direction === 'in').every((m) => Number(m.processed) === 1));

/* ---- 左栏「新消息提醒」排队顺序（2026-09-26 用户规则）----
 *   规则一：先到的一条在最上，后到的往下排（越新的越往下）。
 *   规则二：同一客户再来消息，行位置不动（钉在第一次那条的位置）。
 *   处理完（标记已回复）出队；之后再来消息按新时间重新排队。
 */
const qA = store.getOrCreateCustomer(1, '15346859991@s.whatsapp.net', { name: 'Q甲', phone: '15346859991' }).customer.code;
const qB = store.getOrCreateCustomer(1, '15346859992@s.whatsapp.net', { name: 'Q乙', phone: '15346859992' }).customer.code;
const qC = store.getOrCreateCustomer(1, '15346859993@s.whatsapp.net', { name: 'Q丙', phone: '15346859993' }).customer.code;
const QC = [qA, qB, qC];
const tsAt = (h) => `2026-09-26T0${h}:00:00.000Z`;
const inMsg = (code, body, waId, h) =>
  store.saveMessage({ customerCode: code, accountId: 1, direction: 'in', body, waMsgId: waId, msgTs: tsAt(h), silent: false });
const qOrder = () => store.listCustomers.all().filter((r) => QC.includes(r.code)).map((r) => r.code);

inMsg(qA, 'A1', 'q-1', 1);
inMsg(qB, 'B1', 'q-2', 2);
inMsg(qC, 'C1', 'q-3', 3);
eq('新消息按到达顺序排队：先到的在上（A→B→C）', JSON.stringify(qOrder()), JSON.stringify([qA, qB, qC]));

inMsg(qA, 'A2', 'q-4', 4); // 同一客户又来一条（更晚）
eq('同一客户再来消息 → 位置不动，A 仍在最上', JSON.stringify(qOrder()), JSON.stringify([qA, qB, qC]));
eq('A 的未读数累计为 2（占一格，不拆行）', store.getCustomer.get(qA).unread, 2);

store.clearPending(qA); // 相当于点了「✓ 标记已回复」
eq('处理完 → 出队（不再算新消息提醒）',
  JSON.stringify(store.listCustomers.all().filter((r) => QC.includes(r.code) && (r.unread || 0) > 0).map((r) => r.code)),
  JSON.stringify([qB, qC]));
check('出队后 queue_since 被清空', !store.getCustomer.get(qA).queue_since);

inMsg(qA, 'A3', 'q-5', 5); // 处理完的客户又来消息
eq('处理过的客户再来消息 → 按新时间重新排队，排到最后（越新越往下）',
  JSON.stringify(qOrder()), JSON.stringify([qB, qC, qA]));
check('重新排队后 queue_since 有值', !!store.getCustomer.get(qA).queue_since);

/* =====================================================================
 * 电话号码查重入库（v2.6.1095 老板定调，**关键一步**）
 *
 * 原话：「对于自动获取到电话号码的 + 后面数字的电话号码，一定要直接写到数据库，
 *        这里很关键的一步 —— 先识别电话号码有没有相同的，如果没有相同就存进去。」
 *
 * 回退的 bug：backfillIdentity 的 SQL 只看**本行**空不空（COALESCE(phone, …)），
 *            从来不查全库 → 同一个号能落进 N 个客户档案。
 * ===================================================================== */
console.log('--- 电话号码查重入库（v2.6.1095）---');

// 建三个干净客户，用来验号码唯一性
const DUP = '15550001111';
const d1 = store.getOrCreateCustomer(1, '222333444555666@lid', { name: '号码甲' }).customer;
const d2 = store.getOrCreateCustomer(1, '111222333444555@lid', { name: '号码乙' }).customer;
const d3 = store.getOrCreateCustomer(7, 'tg:777', { channel: 'telegram', name: '号码丙' }).customer;

check('新客户 1 号建档成功', !!d1 && !!d1.code);
check('backfillIdentity 首次写入号码成功', store.backfillIdentity(d1.code, { phone: DUP, phoneSrc: 'telegram' }) === true);
eq('客户 1 已存进号码', store.getCustomer.get(d1.code).phone, DUP);

// 🔴 核心：同号必须被拒
store.backfillIdentity(d2.code, { phone: DUP, phoneSrc: 'telegram' });
eq('同号给客户 2 → 号码**没写进去**（查重拦下）', store.getCustomer.get(d2.code).phone, null);
store.backfillIdentity(d3.code, { phone: DUP, phoneSrc: 'telegram' });
check('同号给客户 3（Telegram 渠道）→ 也没写进去',
  !String(store.getCustomer.get(d3.code).phone || '').trim());

// 重复时姓名/地区仍要补上，不能因为号码被拦就整条卡住
// 姓名已存在，按「只填空不覆盖」不该被改 —— 这条正是要守住的不覆盖语义
store.backfillIdentity(d2.code, { region: 'Texas' });
eq('号码被拦但地区照样补上', store.getCustomer.get(d2.code).region, 'Texas');
eq('已有姓名不被覆盖（只填空不覆盖）', store.getCustomer.get(d2.code).name, '号码乙');
// 换一个**姓名还空着**的客户，验证「号码被拦也照样能补姓名」
const d4 = store.getOrCreateCustomer(4, '888888000111@lid', { name: '' }).customer;
store.backfillIdentity(d4.code, { phone: DUP, name: '丁的真实姓名' });
eq('号码被拦 + 姓名为空 → 姓名照样补上', store.getCustomer.get(d4.code).name, '丁的真实姓名');
check('号码被拦 + 姓名为空 → 号码仍没写进去', !String(store.getCustomer.get(d4.code).phone || '').trim());

// phoneOwnerOf 是对外总闸
eq('phoneOwnerOf 查到占用方', store.phoneOwnerOf(DUP, d2.code), d1.code);
eq('phoneOwnerOf 排除自己', store.phoneOwnerOf(DUP, d1.code), '');
eq('phoneOwnerOf 号码没被占 → 空串', store.phoneOwnerOf('15559999999', d1.code), '');
eq('phoneOwnerOf 空号码 → 空串', store.phoneOwnerOf('', d1.code), '');
eq('phoneOwnerOf 带 + 号与纯数字同号 → 认得出重复', store.phoneOwnerOf('+' + DUP, d2.code), d1.code);

// 号码不重复 → 必须放行（老板要的「没有相同就存进去」）
const free = '15550008888';
eq('不重复的号码查重 → 放行', store.phoneOwnerOf(free, d1.code), '');
check('不重复的号码 → 正常写入', store.backfillIdentity(d2.code, { phone: free, phoneSrc: 'telegram' }) === true);
eq('客户 2 拿到自己的号码', store.getCustomer.get(d2.code).phone, free);
eq('客户 1 的号码没被抢走', store.getCustomer.get(d1.code).phone, DUP);

// 已占的号码位不允许被覆盖
store.backfillIdentity(d1.code, { phone: '15550007777', phoneSrc: 'telegram' });
eq('已有号码不被覆盖（只填空不覆盖）', store.getCustomer.get(d1.code).phone, DUP);

// applyRegrab 这条路也必须过守门（原来完全不查重，是漏网之路）
const dupG = store.getOrCreateCustomer(2, '666777888999000@lid', { name: '号码戊' }).customer;
const regrabDup = store.applyRegrab(dupG.code, { phone: DUP, phoneSrc: 'telegram' });
eq('applyRegrab 遇同号 → action=duplicate', regrabDup.action, 'duplicate');
check('applyRegrab 遇同号 → 号码没写进去', !String(store.getCustomer.get(dupG.code).phone || '').trim());
eq('applyRegrab 报出被谁占用', regrabDup.owner, d1.code);

// applyRegrab 遇不重复的号 → 正常填
const regrabFree = store.applyRegrab(dupG.code, { phone: '15550007777', phoneSrc: 'telegram' });
eq('applyRegrab 遇空号码位 + 不重复 → action=filled', regrabFree.action, 'filled');
eq('applyRegrab 正常写入号码', store.getCustomer.get(dupG.code).phone, '15550007777');

// 人工填的号（manual）任何自动流程都不许动
const m1 = store.getOrCreateCustomer(3, '444555666777888@lid', { name: '号码己' }).customer;
store.backfillIdentity(m1.code, { phone: '15550006666', phoneSrc: 'manual' });
store.backfillIdentity(m1.code, { phone: '15550005555', phoneSrc: 'telegram' });
eq('manual 来源的号码不被自动流程覆盖', store.getCustomer.get(m1.code).phone, '15550006666');

// 最终唯一性体检：**本轮新建的这批客户**里一个号都不能出现两次
//（⚠️ 不能扫全库 —— 测试开头 r1/r4 是「同一个人加两个号」，号码一样是设计如此）
const NEW_CODES = [d1.code, d2.code, d3.code, d4.code, dupG.code, m1.code];
const dupMap = {};
let dupCount = 0;
for (const code of NEW_CODES) {
  const p = String((store.getCustomer.get(code) || {}).phone || '').replace(/\D/g, '');
  if (!p) continue;
  if (dupMap[p]) { dupCount++; console.log(`   重复! ${p} -> ${dupMap[p]} 与 ${code}`); }
  dupMap[p] = code;
}
eq('本轮新建客户里无任何号码重复（0 个重复）', dupCount, 0);

// 拒写记录必须**按客户分别记**，不能是一条全局记录（并发采集时会互相覆盖）
store.backfillIdentity(d2.code, { phone: DUP, phoneSrc: 'telegram' });
const dupRec = store.lastPhoneDuplicate(d2.code);
check('被拒客户能查到自己的拒写记录', !!dupRec && dupRec.code === d2.code, JSON.stringify(dupRec));
eq('拒写记录里带占用方编号', dupRec && dupRec.owner, d1.code);
eq('拒写记录里标明来自哪条路', dupRec && dupRec.via, 'backfillIdentity');
eq('没被拒的客户查不到拒写记录', store.lastPhoneDuplicate(d1.code), null);
eq('乱传一个不存在的编号 → null（不炸）', store.lastPhoneDuplicate('ZZZ99999'), null);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
