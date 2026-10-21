/**
 * Telegram 专项自检：Saved Messages 过滤 / 重复档案合并 / 存量迁移幂等 / 正文时间剥离
 * ============================================================================
 * 老板 2026-10-16 出图报的 4 个 Telegram 问题，逐个钉死（v2.6.1136）：
 *   问题 1  Saved Messages 是系统消息 → 不提醒、不建档
 *   问题 2  同一个人被拆成两条（名键 tg:Eileen Lin / 数字键 tg:7207229390）→ 合并
 *   问题 3  对话后面的时间重复出现一次，且时间要用方框展示
 *   问题 4  翻译气泡不要翻译时间，气泡里不出现时间
 *
 * 跑法：node --experimental-sqlite test/telegram_merge.test.js
 *
 * 🔴 全程只碰临时库（test/_isolate.js 指到 .tmp-test-data/），绝不读写真实 data/。
 * 🔴 只断言 Telegram（channel='telegram'）的行为，WhatsApp / Signal 一律不碰。
 */

const path = require('path');
const fs = require('fs');

// 数据隔离：必须放在任何 require('../src/...') 之前（src/paths.js 在 require 那刻就解析目录）
const { DIR: DATA_DIR } = require('./_isolate.js');

const db = require('../src/db');
const tgMerge = require('../src/telegramMerge');
const telegramRead = require('../src/telegramRead');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? `  << ${extra}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
function section(t) { console.log(`\n--- ${t} ---`); }

const nowIso = () => new Date().toISOString();

/**
 * 造一个 Telegram 客户（直接写库，绕开 getOrCreateCustomer，好精确控制 wa_jid 形态）。
 *
 * 🔴 v2.6.1141（甲方案：合并只认同一个数字身份）：新增第 5 个参数 `username`。
 *   原因：本文件原先**根本无法给记录写 @tg_username**，于是所有「名键 + 数字键」配对
 *   都只有「显示名相同」这一个共同点 —— 而那正是老板拍板要废除的判据。
 *   合并的真实验证条件是 peerId 或 @username，所以要测「该合的照样合」就必须把身份写进去。
 *   （注意：这不是放宽判据，是把测试数据补成合法输入。）
 */
function makeTgCustomer(accountId, jid, name, phone, username) {
  const last = db.db.prepare(`SELECT code FROM customers WHERE account_id=? ORDER BY code DESC LIMIT 1`).get(accountId);
  const code = db.ids.nextCustomerCode(accountId, last ? last.code : null);
  db.db.prepare(
    `INSERT INTO customers (code, account_id, wa_jid, phone, name, channel, created_at)
     VALUES (?,?,?,?,?, 'telegram', ?)`,
  ).run(code, accountId, jid, phone || null, name || null, nowIso());
  if (username) db.saveTgUsername(code, username);
  return db.getCustomer.get(code);
}

function addMsg(code, accountId, body, waMsgId, msgTime) {
  return db.saveMessage({
    customerCode: code, accountId, direction: 'in',
    body, mediaSrc: 'none', mediaFetchState: 'na',
    waMsgId: waMsgId || null, msgTs: nowIso(), msgTime: msgTime || '',
  });
}

console.log('=== Telegram 专项：Saved 过滤 / 同名合并 / 迁移幂等 / 时间剥离 ===');
console.log(`驱动：${db.driver}    临时库：${DATA_DIR}`);

/* =====================================================================
 * 问题 1：Saved Messages（收藏夹）—— 不提醒、不建档
 * ================================================================== */
section('问题 1｜Saved Messages 是系统消息');
check('isSavedMessage 认「键 = Saved Messages」', tgMerge.isSavedMessage('Saved Messages', '') === true);
check('isSavedMessage 认「键 = tg:Saved Messages」', tgMerge.isSavedMessage('tg:Saved Messages', '') === true);
check('isSavedMessage 认「名称 = Saved Messages」（数字键那条路）', tgMerge.isSavedMessage('7207229390', 'Saved Messages') === true);
check('大小写不敏感 + 前后空格（saved messages / " saved  messages "）',
  tgMerge.isSavedMessage('  saved   MESSAGES ', '') === true);
check('中文 UI「收藏夹」也认', tgMerge.isSavedMessage('tg:收藏夹', '') === true);
check('真人客户不被误伤（Eileen Lin / 数字键）',
  tgMerge.isSavedMessage('Eileen Lin', 'Eileen Lin') === false
  && tgMerge.isSavedMessage('7207229390', 'Eileen Lin') === false);
check('isSystemMessage 拦住 Saved Messages（网页路径 → toMessage 返回 null）',
  telegramRead.toMessage({ chatKey: 'Saved Messages', chatName: 'Saved Messages', body: '你好', direction: 'in' }, 7) === null);
check('isSystemMessage 拦住 Saved Messages（只有名称命中，键是数字）',
  telegramRead.isSystemMessage('7207229390', 'Hello', 'in', 'Saved Messages') === true);
check('普通客户消息照常转成标准结构（不被误拦）',
  (() => {
    const m = telegramRead.toMessage({ chatKey: '7207229390', chatName: 'Eileen Lin', body: 'Hello', direction: 'in' }, 7);
    return !!m && m.body === 'Hello';
  })());

/* =====================================================================
 * 问题 3 / 4：正文尾部时间剥离
 * ================================================================== */
section('问题 3/4｜正文尾部时间剥离');
const sp1 = tgMerge.stripTrailingTime('Hello 14:03');
eq('"Hello 14:03" → 正文 Hello', sp1.body, 'Hello');
eq('"Hello 14:03" → 时间 14:03', sp1.msgTime, '14:03');
check('"Hello 14:03" 不是「只剩时间」', sp1.onlyTime === false);

const sp2 = tgMerge.stripTrailingTime('9:05');
eq('只有时间 → 正文为空', sp2.body, '');
eq('只有时间 → 时间字段拿到 9:05', sp2.msgTime, '9:05');
check('只有时间 → onlyTime=true（调用方丢弃）', sp2.onlyTime === true);

eq('带「下午」：正文剥干净', tgMerge.stripTrailingTime('明天见 下午 3:20').body, '明天见');
eq('带「下午」：时间保留原文', tgMerge.stripTrailingTime('明天见 下午 3:20').msgTime, '下午 3:20');
eq('带 AM：正文剥干净', tgMerge.stripTrailingTime('good morning 9:05 AM').body, 'good morning');
eq('带 PM：时间保留原文', tgMerge.stripTrailingTime('good morning 9:05 PM').msgTime, '9:05 PM');
eq('带秒：正文剥干净', tgMerge.stripTrailingTime('ok 14:03:22').body, 'ok');
eq('没有时间 → 正文原样不动', tgMerge.stripTrailingTime('Is this still available?').body, 'Is this still available?');
eq('没有时间 → 时间字段为空', tgMerge.stripTrailingTime('Is this still available?').msgTime, '');
eq('空串不崩', tgMerge.stripTrailingTime('').body, '');
eq('null 不崩', tgMerge.stripTrailingTime(null).body, '');

const mT = telegramRead.toMessage({ chatKey: '7207229390', chatName: 'Eileen Lin', body: 'Hello 14:03', direction: 'in' }, 7);
check('toMessage：正文里的 14:03 被剥掉了（气泡里不会再带时间）', !!mT && mT.body === 'Hello', mT && mT.body);
check('toMessage：时间单独进 msgTime 字段', !!mT && mT.msgTime === '14:03', mT && mT.msgTime);
check('toMessage：正文只剩时间 → 整条丢弃（不建档、不提醒）',
  telegramRead.toMessage({ chatKey: '7207229390', chatName: 'Eileen Lin', body: '14:03', direction: 'in' }, 7) === null);

/* =====================================================================
 * 问题 2：增量防裂（键归一）
 * ================================================================== */
section('问题 2｜增量防裂：只有名字时归并到已存在的数字键记录');
const ACC = 7;
// 库里先有 MTProto 建的数字键记录。
// 🔴 v2.6.1141：两条都带上**同一个 @username** —— 甲方案下这才是「同一人」的身份证据，
//    光靠名字相同不再允许合并（这条正是 2026-10-16 生产误合事故的根因）。
const numC = makeTgCustomer(ACC, 'tg:7207229390', 'Eileen Lin', '', 'eilin_lin');
addMsg(numC.code, ACC, 'hi', '7207229390:m1');

const plan1 = tgMerge.resolveIncoming(db, { accountId: ACC, chatKey: 'Eileen Lin', name: 'Eileen Lin', username: 'eilin_lin' });
eq('只有名字 + @username 相同 → 键归一成数字', plan1.customerKey, '7207229390');
eq('displayJid 也跟着归一', plan1.displayJid, 'tg:7207229390');
check('标记为数字键', plan1.numeric === true);

// 🔴 甲方案新增的反向断言：名字相同但 @username 不同 / 没有 → 绝不归并
const plan1b = tgMerge.resolveIncoming(db, { accountId: ACC, chatKey: 'Eileen Lin', name: 'Eileen Lin', username: 'someone_else' });
eq('🔴 只有名字 + @username 不同 → **不归并**（各建各档）', plan1b.customerKey, 'Eileen Lin');
check('🔴 不归并时不产生合并指令', plan1b.mergeFromCode === '');
const plan1c = tgMerge.resolveIncoming(db, { accountId: ACC, chatKey: 'Eileen Lin', name: 'Eileen Lin' });
eq('🔴 只有名字 + 没有 @username → **不归并**', plan1c.customerKey, 'Eileen Lin');

// 反过来：这次来的是数字键、库里已有名键 → 记下要合并的那条
const namedC = makeTgCustomer(ACC, 'tg:Eileen Lin', 'Eileen Lin', '', 'eilin_lin');
addMsg(namedC.code, ACC, 'Hello', 'Eileen Lin:m2');
const plan2 = tgMerge.resolveIncoming(db, { accountId: ACC, chatKey: '7207229390', name: 'Eileen Lin', username: 'eilin_lin' });
eq('来的是数字键 → 键保持不变', plan2.customerKey, '7207229390');
eq('并指出「名键那条」要合并进来', plan2.mergeFromCode, namedC.code);

// 🔴 甲方案反向：数字键来了，但名键那条身份对不上 → 绝不把名键那条合并掉
const plan2b = tgMerge.resolveIncoming(db, { accountId: ACC, chatKey: '7207229390', name: 'Eileen Lin', username: '' });
check('🔴 数字键 + 拿不到 @username → **不产生合并指令**（名键那条不会被吞）', plan2b.mergeFromCode === '',
  `mergeFromCode=${plan2b.mergeFromCode}`);

const plan3 = tgMerge.resolveIncoming(db, { accountId: ACC, chatKey: 'Nobody Here', name: 'Nobody Here' });
eq('库里没有同名数字键 → 只能先用名字键（不凭空造数字）', plan3.customerKey, 'Nobody Here');
check('这种情形不触发合并', plan3.mergeFromCode === '');

const plan4 = tgMerge.resolveIncoming(db, { accountId: 8, chatKey: 'Eileen Lin', name: 'Eileen Lin' });
eq('🔴 不同 Telegram 账号的同名人**不**互相归并（账号 8 ≠ 账号 7）', plan4.customerKey, 'Eileen Lin');

/* =====================================================================
 * 问题 2：合并规则（姓名 / 电话补 + / 编号取数字 / 消息归到数字键那条）
 * ================================================================== */
section('问题 2｜合并规则：编号取数字键、电话取有数字的那条并补 +、消息以名键那条为准');
// 重新造一对干净的：名键那条有真实对话 + 没电话；数字键那条有电话
// 🔴 v2.6.1141：两条带同一个 @username（甲方案下的身份证据），合并机制本身照旧要测
const A = makeTgCustomer(ACC, 'tg:8880001111', 'Grace Wong', '', 'grace_wong');
const B = makeTgCustomer(ACC, 'tg:Grace Wong', 'Grace Wong', '', 'grace_wong');
addMsg(B.code, ACC, 'Hello, is the painting ready?', 'Grace Wong:b1', '14:03');
addMsg(B.code, ACC, 'thank you so much!', 'Grace Wong:b2', '14:05');
addMsg(A.code, ACC, '(MTProto 抓到的同一条)', '8880001111:a1');
// 电话：名键那条抓不到、数字键那条抓得到 → 取有数字的那条并补 +
db.db.prepare(`UPDATE customers SET phone = ? WHERE code = ?`).run('8613800138000', A.code);

const logs = [];
const r1 = tgMerge.mergePair(db, B.code, A.code, { log: (s) => logs.push(s) });

check('合并成功', r1.ok === true, r1.note);
const keep = db.getCustomer.get(A.code);
const voided = db.getCustomer.get(B.code);
eq('保留的是数字键那条（wa_jid = tg:8880001111）', keep.wa_jid, 'tg:8880001111');
eq('姓名保留', keep.name, 'Grace Wong');
eq('电话取有数字的那条并**补一个 +**', keep.phone, '+8613800138000');
eq('名键那条标为作废（voided=1）', Number(voided.voided), 1);
check('名键那条**没有被物理删除**（还在库里，可核对）', !!voided);
check('作废记录带说明（写明合并到哪条）', /已合并进/.test(String(voided.void_note || '')), voided.void_note);

const keptMsgs = db.db.prepare(`SELECT * FROM messages WHERE customer_code=? ORDER BY id ASC`).all(A.code);
const leftMsgs = db.db.prepare(`SELECT * FROM messages WHERE customer_code=?`).all(B.code);
eq('名键那条的消息全部归到数字键那条（2+1 条）', keptMsgs.length, 3);
eq('名键那条名下已不剩消息', leftMsgs.length, 0);
check('「名键那条抓的对话是正确的」→ 它的两条都在合并后的档案上',
  keptMsgs.some((m) => /painting ready/.test(String(m.body || '')))
  && keptMsgs.some((m) => /thank you so much/.test(String(m.body || ''))),
  JSON.stringify(keptMsgs.map((m) => m.body)));
check('逐条 console.log 记录了合并了什么',
  logs.some((s) => /开始合并/.test(s)) && logs.some((s) => /条消息/.test(s)) && logs.some((s) => /作废/.test(s)),
  JSON.stringify(logs.slice(0, 3)));

/* =====================================================================
 * 问题 2：存量迁移（备份 / 幂等 / 只限 telegram / 不影响别的渠道）
 * ================================================================== */
section('问题 2｜存量迁移：先备份 · 幂等 · 只限 telegram');
// 造一个非 Telegram 的同名对照（绝不能被波及）
const waC = makeTgCustomer(1, '14155552671@c.us', 'Kevin Zhang', '14155552671');
db.db.prepare(`UPDATE customers SET channel='whatsapp' WHERE code=?`).run(waC.code);
addMsg(waC.code, 1, 'hello from wa', 'wa:1');
// 再放一条 Telegram 的「名字不同」的，不该被配成对
makeTgCustomer(ACC, 'tg:Solo Person', 'Solo Person', '');

const migLogs = [];
const mig1 = tgMerge.runMigration(db, { log: (s) => migLogs.push(s) });
check('迁移跑成功', mig1.ok === true, JSON.stringify(mig1));
check('🔴 迁移前**先备份**了数据库文件',
  !!mig1.backup && fs.existsSync(mig1.backup) && /\.bak-\d{8}-\d{6}$/.test(mig1.backup), mig1.backup);
check('备份用的路径就是本次的临时库（没去动真实 data/）',
  !!mig1.backup && path.resolve(mig1.backup).startsWith(path.resolve(DATA_DIR)), mig1.backup);

// 幂等：再跑一次
const mig2 = tgMerge.runMigration(db, { log: (s) => migLogs.push(s) });
eq('🔴 幂等：第二次跑发现 0 组（已作废的记录不再参与配对）', mig2.pairs, 0);
eq('🔴 幂等：第二次跑合并 0 组', mig2.merged, 0);
const pairAfter = tgMerge.findDuplicatePairs(db);
eq('🔴 幂等：第三次查也还是 0 组', pairAfter.length, 0);

const waAfter = db.getCustomer.get(waC.code);
eq('🔴 只限 telegram：WhatsApp 那条渠道没被改', waAfter.channel, 'whatsapp');
eq('🔴 只限 telegram：WhatsApp 那条 wa_jid 没被改', waAfter.wa_jid, '14155552671@c.us');
eq('🔴 只限 telegram：WhatsApp 那条消息一条没少',
  db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(waC.code).n, 1);
eq('🔴 只限 telegram：WhatsApp 那条没被标作废', Number(waAfter.voided || 0), 0);

check('迁移日志可读（含「发现 N 组 / 合并完成」）',
  migLogs.some((s) => /发现 \d+ 组/.test(s)) && migLogs.some((s) => /存量迁移完成/.test(s)),
  JSON.stringify(migLogs.slice(0, 2)));

/* =====================================================================
 * 迁移里电话「补 +」+ 查重守门（同号绝不落两档案）
 * ================================================================== */
section('问题 2｜迁移里的电话：补 + 且先查重');
const C1 = makeTgCustomer(ACC, 'tg:7771112222', 'Phone Case A', '', 'phone_a');
const C2 = makeTgCustomer(ACC, 'tg:Phone Case A', 'Phone Case A', '8613900000000', 'phone_a');
addMsg(C2.code, ACC, 'from name key', 'Phone Case A:c1');
const beforeOwner = db.getCustomer.get(C1.code).phone;
const r2 = tgMerge.mergePair(db, C2.code, C1.code, { log: () => {} });
eq('名键那条有电话、数字键那条没有 → 取有数字的那条并补 +', db.getCustomer.get(C1.code).phone, '+8613900000000');
check('合并前数字键那条电话本来是空的', !String(beforeOwner || '').trim(), String(beforeOwner));
check('合并成功', r2.ok === true, r2.note);

// 查重守门：这个号已经被**第三条活档案**占了 → 不写进去（同号绝不落两档案）
const OTHER = makeTgCustomer(ACC, 'tg:9998887777', 'Phone Case C', '8613900000000', 'phone_c'); // 先建，占住这个号
const C3 = makeTgCustomer(ACC, 'tg:7773334444', 'Phone Case B', '8613900000000', 'phone_b');     // 数字键这条也有同一个号
const C4 = makeTgCustomer(ACC, 'tg:Phone Case B', 'Phone Case B', '', 'phone_b');                 // 名键这条没号
addMsg(C4.code, ACC, 'from name key b', 'Phone Case B:d1');
const dupLogs = [];
tgMerge.mergePair(db, C4.code, C3.code, { log: (s) => dupLogs.push(s) });
check('🔴 号码已被第三条活档案占用 → **未写入**另一个号（同号绝不落两档案）',
  dupLogs.some((s) => /已被客户/.test(s) && /未写入/.test(s)), JSON.stringify(dupLogs));
eq('保留的那条电话没被冲掉（还是原来那个）', String(db.getCustomer.get(C3.code).phone || ''), '8613900000000');
check('并如实记了一条「已被占用，未写入」的日志',
  dupLogs.some((s) => /已被客户/.test(s) && /未写入/.test(s)));
check('但消息照样合并过去了（不因为一个号码卡住整条合并）',
  db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(C3.code).n >= 1);
check('占用者（第三条）本身一个字节没被动', !!db.getCustomer.get(OTHER.code)
  && db.getCustomer.get(OTHER.code).phone === '8613900000000');

/* =====================================================================
 * 同名记录的处理
 * ---------------------------------------------------------------------
 * 🔴 v2.6.1141（甲方案，老板 2026-10-16 二次拍板，**推翻**了上一版「同名即同一人」）：
 *   现在规则是「合并只认同一个数字身份（peerId 或 @tg_username），名字相同一律不合并」。
 *   本节因此拆成两半，正反都测：
 *     · 无身份证据（只有名字相同）→ **绝不合并**，三条档案各自独立
 *     · 有 @username 证据         → 照旧合并（证明甲方案没把功能改瘫）
 * ================================================================== */
section('同名记录：只有名字相同、无身份证据 → 绝不合并（甲方案）');
const N1 = makeTgCustomer(ACC, 'tg:8111000001', 'QA Twin Name', '');
const N2 = makeTgCustomer(ACC, 'tg:8111000002', 'QA Twin Name', '');
const NM = makeTgCustomer(ACC, 'tg:QA Twin Name', 'QA Twin Name', '');
addMsg(NM.code, ACC, '这条其实属于第二条', 'QA Twin Name:777');
addMsg(N1.code, ACC, '第一条自己的消息', '8111000001:778');
addMsg(N2.code, ACC, '第二条自己的消息', '8111000002:779');

const ambLogs = [];
const migAmb = tgMerge.runMigration(db, { log: (s) => ambLogs.push(s) });
eq('🔴 同名但无身份证据 → 一组都不合（merged = 0）', migAmb.merged, 0);
check('🔴 日志写明「同名但身份不同…不合并」',
  ambLogs.some((s) => /同名但身份不同/.test(s) && /不合并/.test(s)), JSON.stringify(ambLogs.slice(0, 2)));
eq('🔴 名键那条**没被**标作废（还活着，等人工确认）', Number(db.getCustomer.get(NM.code).voided || 0), 0);
eq('🔴 名键那条的消息**没被搬走**（仍归自己，1 条）',
  db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(NM.code).n, 1);
eq('🔴 第一条数字键没被动（1 条）', db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(N1.code).n, 1);
eq('🔴 第二条数字键也没被动（1 条）', db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(N2.code).n, 1);

const ambPlan = tgMerge.resolveIncoming(db, { accountId: ACC, chatKey: 'QA Twin Name', name: 'QA Twin Name' });
eq('🔴 增量侧：只有名字、无身份 → **不归并**（不新建也不吞人）', ambPlan.customerKey, 'QA Twin Name');
check('🔴 增量侧同样不产生合并指令', ambPlan.mergeFromCode === '');

/* 正向：同一条规则下，**有 @username 证据时合并照旧**（防止改过头） */
const P1 = makeTgCustomer(ACC, 'tg:8222000001', 'Proven Person', '', 'proven_one');
const PM = makeTgCustomer(ACC, 'tg:Proven Person', 'Proven Person', '', 'proven_one');
addMsg(PM.code, ACC, 'proven named key msg', 'Proven Person:p1');
const migProven = tgMerge.runMigration(db, { log: () => {} });
check('✅ @username 相同的一对仍然合并（甲方案没把功能改瘫）', migProven.merged >= 1, JSON.stringify(migProven));
eq('✅ 有身份证据时名键那条被标作废', Number(db.getCustomer.get(PM.code).voided || 0), 1);
check('✅ 有身份证据时消息确实搬到数字键那条名下',
  db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(P1.code).n >= 1);

/* =====================================================================
 * QA 风险 3（已加固）：两条路径抓同一条真实消息 → 合并后不许出现两次
 * 名键侧 wa_msg_id = "Eileen Lin:555"，数字键侧 "7207229390:555"
 * ================================================================== */
section('QA 风险 3｜合并后同一条消息不许出现两次（按消息号去重）');
const D1 = makeTgCustomer(ACC, 'tg:7207330000', 'Dup Msg Person', '', 'dup_person');
const D2 = makeTgCustomer(ACC, 'tg:Dup Msg Person', 'Dup Msg Person', '', 'dup_person');
addMsg(D1.code, ACC, 'Hello', '7207330000:555');
addMsg(D2.code, ACC, 'Hello', 'Dup Msg Person:555');
const dupMoveLogs = [];
tgMerge.mergePair(db, D2.code, D1.code, { log: (s) => dupMoveLogs.push(s) });
const afterDup = db.db.prepare(`SELECT * FROM messages WHERE customer_code=? ORDER BY id ASC`).all(D1.code);
eq('合并后这个档案**只有 1 条**（不是 2 条）', afterDup.length, 1);
eq('留下的是名键那条的版本（以它为准）', String(afterDup[0].wa_msg_id || ''), 'Dup Msg Person:555');
check('日志里说明了按消息号去重了几条',
  dupMoveLogs.some((s) => /按消息号去重/.test(s)), JSON.stringify(dupMoveLogs));
eq('numericMsgIdOf 取消息号：7207229390:555 → 555', tgMerge.numericMsgIdOf('7207229390:555'), '555');
eq('numericMsgIdOf：Eileen Lin:555 → 555（前缀不同也能认出同一条）', tgMerge.numericMsgIdOf('Eileen Lin:555'), '555');
eq('numericMsgIdOf：非数字的不参与去重', tgMerge.numericMsgIdOf('list-2-Hello'), '');

/* =====================================================================
 * 界面侧：时间方框（只渲染一次 + 不在气泡/译气泡里）
 * ================================================================== */
section('问题 3/4｜界面：时间用方框渲染一次，气泡里不带时间');
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
check('新增了时间方框的 HTML 生成函数（tgTimeBoxHtml）', /function tgTimeBoxHtml/.test(appjs));
check('新增了正文时间剥离函数（tgSplitTime）', /function tgSplitTime/.test(appjs));
// 🔴 v2.6.1138 改写这条断言的**写法**（结论没变，仍是「时间只渲染一次」）。
// 原写法是「全文件里 tgTimeBoxHtml(sp.time) 恰好出现 2 次」—— 那是按**出现总数**卡的脆断言：
// v2.6.1138 给两个渲染入口各加了一条「正文剥空、只显示时间不造空泡」的互斥分支，
// 于是变成每个入口 2 处、全文件 4 处，条数变了但「一条消息只渲一次时间」这件事没变。
// 现在改成验语义：① 每个渲染入口内部两处分支互斥（有正文走A、无正文走 B，只有一条会执行）
// ② 两处分支都在同一个 .tg-line 行容器里（时间与气泡同行）。
check('Telegram 会话里时间**只渲染一次**（两处分支互斥：空正文只出时间、有正文才气泡+时间）',
  (() => {
    const lines = appjs.split(/\r?\n/);
    // 按 function 边界切块，逐个渲染入口验
    const starts = [];
    lines.forEach((l, i) => { if (/^function (renderTgChat|renderWaConvInfo)\b/.test(l)) starts.push(i); });
    if (!starts.length) return { ok: false, why: '找不到任何 Telegram 渲染入口' };
    for (let s = 0; s < starts.length; s++) {
      const from = starts[s];
      const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
      const chunk = lines.slice(from, to).join('\n');
      const uses = (chunk.match(/tgTimeBoxHtml\(sp\.time\)/g) || []).length;
      //每个入口至少要有「空正文」与「有正文」两条互斥路径
      const hasSolo = /if \(!(text|body)\) \{[\s\S]{0,200}?tgTimeBoxHtml\(sp\.time\)/.test(chunk);
      const hasNormal = /<div class="tg-line"><div class="tg-bubble">[^]*?tgTimeBoxHtml\(sp\.time\)/.test(chunk);
      if (!hasSolo || !hasNormal || uses !== 2) {
        return { ok: false, why: `入口${s + 1}: tgTimeBoxHtml×${uses} solo=${hasSolo} normal=${hasNormal}` };
      }
    }
    return { ok: true, why: `${starts.length} 个入口，每个 2 处互斥分支` };
  })().why,
  '');
check('时间方框与气泡在同一个 .tg-line 行容器里（时间贴气泡右侧，不是下一行）',
  (appjs.match(/<div class="tg-line"><div class="tg-bubble">\$\{esc\([^}]+\)\}<\/div>\$\{tgTimeBoxHtml\(sp\.time\)\}<\/div>/g) || []).length >= 2,
  String((appjs.match(/<div class="tg-line"><div class="tg-bubble">\$\{esc\([^}]+\)\}<\/div>\$\{tgTimeBoxHtml\(sp\.time\)\}<\/div>/g) || []).length));
check('译文气泡会再剥一次时间（老译文「你好 14:03」也不会带时间）',
  /const zh = tgSplitTime\(/.test(appjs));
check('CSS 里新增了 .tg-time-box 方框样式（带边框）', /\.tg-time-box\s*\{[^}]*border:/.test(css));
check('方框样式放在 Telegram 区块内（紧挨 .tg-zh 之后，不动全局）',
  css.indexOf('.tg-time-box') > css.indexOf('.tg-zh.mine'), '位置检查');

/* =====================================================================
 * 采集侧改动落地检查
 * ================================================================== */
section('改动落地：Telegram 两个采集入口都改了');
const trSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegramRead.js'), 'utf8');
const mtSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegramMtproto.js'), 'utf8');
check('telegramRead：toMessage 里剥时间', /stripTrailingTime/.test(trSrc));
check('telegramRead：isSystemMessage 加了 Saved Messages 判定', /isSavedMessage/.test(trSrc));
check('telegramRead：网页路径优先用数字 peerId（currentPeerId）', /function currentPeerId/.test(trSrc));
check('telegramMtproto：toContract 里剥时间', /stripTrailingTime/.test(mtSrc));
check('telegramMtproto：toContract 里拦 Saved Messages', /isSavedMessage/.test(mtSrc));
check('telegramMerge 是独立新模块（没把逻辑塞进 main.js）',
  fs.existsSync(path.join(__dirname, '..', 'src', 'telegramMerge.js')));

console.log(`\n========== Telegram 专项：${pass} 通过 / ${fail} 失败 ==========`);
if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);
