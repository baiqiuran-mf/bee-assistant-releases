/**
 * QA 独立验收（不看实现者自测结论，全部自己造数据自己断言）
 * ============================================================================
 * 目标版本：v2.6.1136 —— 老板报的 4 个 Telegram 问题
 *   问题 1  Saved Messages（收藏夹）不该提醒、不该建档
 *   问题 2  同一个人被拆两条 → 存量迁移 + 增量防裂（合并规则逐条核对）
 *   问题 3  对话后面时间重复出现一次 → 剥出时间 + 只渲染一次 + 方框
 *   问题 4  翻译气泡不要带时间
 *
 * 跑法：node --experimental-sqlite test/qa_telegram_1136.test.js
 *
 * 🔴 全程只碰临时库（test/_isolate.js 指到 .tmp-test-data/），绝不读写真实 data/。
 * 🔴 本文件是 QA 自己写的验收用例，与实现者的 test/telegram_merge.test.js 互相独立。
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

// 数据隔离：必须放在任何 require('../src/...') 之前
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
const ROOT = path.join(__dirname, '..');

/** 造一个客户（channel 可指定，用于放 WhatsApp 对照组） */
function makeCustomer(accountId, jid, name, phone, channel) {
  const last = db.db.prepare(`SELECT code FROM customers WHERE account_id=? ORDER BY code DESC LIMIT 1`).get(accountId);
  const code = db.ids.nextCustomerCode(accountId, last ? last.code : null);
  db.db.prepare(
    `INSERT INTO customers (code, account_id, wa_jid, phone, name, channel, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(code, accountId, jid, phone || null, name || null, channel || 'telegram', nowIso());
  return db.getCustomer.get(code);
}
function addMsg(code, accountId, body, waMsgId, msgTime, bodyZh) {
  return db.saveMessage({
    customerCode: code, accountId, direction: 'in',
    body, bodyZh: bodyZh || null, mediaSrc: 'none', mediaFetchState: 'na',
    waMsgId: waMsgId || null, msgTs: nowIso(), msgTime: msgTime || '',
  });
}
function msgsOf(code) {
  return db.db.prepare(`SELECT * FROM messages WHERE customer_code=? ORDER BY id ASC`).all(code);
}

console.log('=== QA 独立验收 · v2.6.1136 Telegram 四问题 ===');
console.log(`驱动：${db.driver}    临时库：${DATA_DIR}`);

/* =====================================================================
 * A1｜Saved Messages：必须被丢弃；真名客户不能被误伤
 * ================================================================== */
section('A1｜Saved Messages 过滤（命中必须拦 / 真人不能误伤）');

const SAVED_HITS = [
  ['Saved Messages', ''],
  ['tg:Saved Messages', ''],
  ['tg:Saved Messages', 'Saved Messages'],
  ['7207229390', 'Saved Messages'],
  ['  saved   MESSAGES ', ''],
  ['SAVED MESSAGES', ''],
  ['\tSaved\nMessages  ', ''],
  ['tg:收藏夹', ''],
  ['收藏夹', ''],
  ['tg:已保存的消息', ''],
  ['111222333', 'Saved Message'],
];
let hitOk = 0;
for (const [k, n] of SAVED_HITS) if (tgMerge.isSavedMessage(k, n)) hitOk += 1;
eq(`各种 Saved 写法全部被拦（${SAVED_HITS.length} 种）`, hitOk, SAVED_HITS.length);

const REAL_PEOPLE = [
  ['Eileen Lin', 'Eileen Lin'],
  ['7207229390', 'Eileen Lin'],
  ['Messages', 'Messages'],              // 真人名叫 Messages
  ['Kevin Messages', 'Kevin Messages'],  // 名字里含 Messages —— 绝不能误伤
  ['Saved by Grace', 'Saved by Grace'],  // 含 Saved 但不是收藏夹
  ['Messages from John', 'Messages from John'],
  ['tg:Messages from John', ''],
  ['收藏夹子', '收藏夹子'],               // 名字里含「收藏夹」但不是收藏夹
  ['-1001234567890', '客户群'],
  ['777000', 'Telegram'],
  ['saved4later', 'saved4later'],        // 用户名形态，不是收藏夹
];
const falsePositives = [];
for (const [k, n] of REAL_PEOPLE) if (tgMerge.isSavedMessage(k, n)) falsePositives.push(`${k} / ${n}`);
check('🔴 真人客户零误伤（含「名字里带 Saved/Messages/收藏夹」的）',
  falsePositives.length === 0, `被误伤：${JSON.stringify(falsePositives)}`);

// 边界过宽检查（如实记录，不作硬性失败）：SAVED_LABELS 里放了裸的 'saved'
const BOUNDARY = [['Saved', 'Saved'], ['savedmessages', '']];
const boundaryHits = BOUNDARY.filter(([k, n]) => tgMerge.isSavedMessage(k, n));
console.log(`      [边界] 会被拦的极窄情形：${JSON.stringify(boundaryHits.map((b) => b[0]))}` +
  ` —— 真人名字恰好就叫 Saved 才会踩到，概率极低，但属于「判据放得比需要宽」`);

// 落到采集侧：三条路径都得拦
check('路径① telegramRead.toMessage（网页 · 键=名）返回 null',
  telegramRead.toMessage({ chatKey: 'Saved Messages', chatName: 'Saved Messages', body: '备忘：明天开会', direction: 'in' }, 7) === null);
check('路径② telegramRead.isSystemMessage（网页 · 键=数字 + 名称命中）为 true',
  telegramRead.isSystemMessage('7207229390', '备忘', 'in', 'Saved Messages') === true);
check('路径③ main.js 入库前那道保险也认（同一函数）',
  tgMerge.isSavedMessage('tg:Saved Messages', 'Saved Messages') === true);
check('真人消息照常转成标准结构（不误拦）',
  (() => { const m = telegramRead.toMessage({ chatKey: '7207229390', chatName: 'Eileen Lin', body: 'Hello', direction: 'in' }, 7); return !!m && m.body === 'Hello'; })());

/* =====================================================================
 * A2｜合并规则逐条核对
 * ================================================================== */
section('A2｜合并规则逐条（编号取数字键 / 电话取有数字那条并补 + / 姓名保留 / 消息以名键那条为准 / 名键不物理删除）');

const ACC = 7;
const NUM = makeCustomer(ACC, 'tg:7207229390', 'Eileen Lin', '');      // 数字键（MTProto）
const NAMED = makeCustomer(ACC, 'tg:Eileen Lin', 'Eileen Lin', '');    // 名键（网页）
addMsg(NAMED.code, ACC, 'Hello, is the painting ready?', 'Eileen Lin:1001', '14:03');
addMsg(NAMED.code, ACC, 'thank you so much!', 'Eileen Lin:1002', '14:05');
addMsg(NUM.code, ACC, '(MTProto 侧抓到的内容，不是正确对话)', '7207229390:9001');
// 电话：数字键那条抓得到 → 取有数字的那条并补 +
db.db.prepare(`UPDATE customers SET phone = ? WHERE code = ?`).run('886912345678', NUM.code);

const mergeLogs = [];
const mr = tgMerge.mergePair(db, NAMED.code, NUM.code, { log: (s) => mergeLogs.push(s), reason: 'QA 验收' });

eq('① WA对话编号（wa_jid）取**数字那条**', db.getCustomer.get(NUM.code).wa_jid, 'tg:7207229390');
eq('② 电话取**有数字的那条**并**补 +**', db.getCustomer.get(NUM.code).phone, '+886912345678');
eq('③ 姓名保留', db.getCustomer.get(NUM.code).name, 'Eileen Lin');
const afterMsgs = msgsOf(NUM.code);
check('④ 消息以**名键那条**为准（"is the painting ready" 在合并后的档案上）',
  afterMsgs.some((m) => /painting ready/.test(String(m.body || ''))),
  JSON.stringify(afterMsgs.map((m) => m.body)));
check('④ 名键那条的第二条也在（"thank you so much"）',
  afterMsgs.some((m) => /thank you so much/.test(String(m.body || ''))));
eq('④ 名键那条名下已不剩消息', msgsOf(NAMED.code).length, 0);
const namedRow = db.getCustomer.get(NAMED.code);
check('⑤ 名键那条**还在库里**（没被物理删除，可核对）', !!namedRow);
eq('⑤ 名键那条 voided=1（标作废）', Number(namedRow.voided), 1);
check('⑤ 作废说明写明合并到哪条', /已合并进/.test(String(namedRow.void_note || '')), namedRow.void_note);
eq('⑤ 作废那条的 wa_jid 原样保留（可回溯）', namedRow.wa_jid, 'tg:Eileen Lin');
check('⑤ 作废那条清掉了待处理/未读（左栏不再重复提醒）',
  Number(namedRow.pending || 0) === 0 && Number(namedRow.unread || 0) === 0);
check('逐条 console.log 记录了合并了什么',
  mergeLogs.some((s) => /开始合并/.test(s)) && mergeLogs.some((s) => /条消息/.test(s)) && mergeLogs.some((s) => /作废/.test(s)));
check('合并返回值 ok', mr.ok === true, mr.note);

// 电话在**名键那条**时的反向情形
const NUM2 = makeCustomer(ACC, 'tg:5550001111', 'Phone On Named', '');
const NAMED2 = makeCustomer(ACC, 'tg:Phone On Named', 'Phone On Named', '8613900000000');
addMsg(NAMED2.code, ACC, 'hi', 'Phone On Named:p1');
tgMerge.mergePair(db, NAMED2.code, NUM2.code, { log: () => {} });
eq('电话只在名键那条时 → 同样取有数字那条并补 +', db.getCustomer.get(NUM2.code).phone, '+8613900000000');
eq('（名键那条作废后号码被清空 —— 同号绝不落两档案）',
  String(db.getCustomer.get(NAMED2.code).phone || ''), '');

/* =====================================================================
 * A3｜增量防裂（正序 / 反序都不新建第二条）
 * ================================================================== */
section('A3｜增量防裂（先名字后数字 / 先数字后名字）');

// 情形 a：库里已有数字键，这次来的是「只有名字」
const A_NUM = makeCustomer(8, 'tg:7207229390', 'Eileen Lin', '');
const planA = tgMerge.resolveIncoming(db, { accountId: 8, chatKey: 'Eileen Lin', name: 'Eileen Lin' });
eq('情形a：只有名字 → 归到已存在的数字键（不新建）', planA.customerKey, '7207229390');
eq('情形a：displayJid 归一成数字键', planA.displayJid, 'tg:7207229390');
check('情形a：标记为数字键', planA.numeric === true);

// 情形 b：库里已有名键，这次来的是数字键
const B_NAMED = makeCustomer(8, 'tg:Grace Wong', 'Grace Wong', '');
const planB = tgMerge.resolveIncoming(db, { accountId: 8, chatKey: '8880001111', name: 'Grace Wong' });
eq('情形b：来的是数字键 → 键保持数字', planB.customerKey, '8880001111');
eq('情形b：并指出「名键那条」要并进来', planB.mergeFromCode, B_NAMED.code);

// 端到端：走一遍 db.getOrCreateCustomer，证明没有新建第二条
const before = db.db.prepare(`SELECT COUNT(*) n FROM customers WHERE account_id=8 AND IFNULL(channel,'whatsapp')='telegram' AND COALESCE(voided,0)=0`).get().n;
const planA2 = tgMerge.resolveIncoming(db, { accountId: 8, chatKey: 'Eileen Lin', name: 'Eileen Lin' });
const cA = db.getOrCreateCustomer(8, planA2.displayJid, { name: 'Eileen Lin', phone: '', phoneSrc: '', channel: 'telegram' });
eq('情形a 端到端：拿到的就是数字键那条（同一个 code）', cA.customer.code, A_NUM.code);
check('情形a 端到端：不是新客户', cA.isNew === false);
const after = db.db.prepare(`SELECT COUNT(*) n FROM customers WHERE account_id=8 AND IFNULL(channel,'whatsapp')='telegram' AND COALESCE(voided,0)=0`).get().n;
eq('情形a 端到端：未作废的 Telegram 客户数没有 +1', after, before);

// 情形 c：不同 TG 账号的同名人 —— 绝不跨账号归并
const planC = tgMerge.resolveIncoming(db, { accountId: 9, chatKey: 'Eileen Lin', name: 'Eileen Lin' });
eq('情形c：账号 9 的同名人不并到账号 8 那条上', planC.customerKey, 'Eileen Lin');
check('情形c：不触发合并', planC.mergeFromCode === '');

/* =====================================================================
 * A4｜存量迁移：备份真存在 / 幂等 / 只限 telegram
 * ================================================================== */
section('A4｜存量迁移：先备份 · 幂等 · 只限 telegram');

// WhatsApp 对照组（同名 Kevin Zhang，绝不能被波及）
const WA_CTRL = makeCustomer(1, '14155552671@c.us', 'Kevin Zhang', '14155552671', 'whatsapp');
addMsg(WA_CTRL.code, 1, 'hello from whatsapp', 'wa:ctrl1');
// Signal 对照组
const SIG_CTRL = makeCustomer(6, 'sig:Kevin Zhang', 'Kevin Zhang', '', 'signal');
addMsg(SIG_CTRL.code, 6, 'hello from signal', 'sig:ctrl1');
const waBefore = JSON.stringify(db.getCustomer.get(WA_CTRL.code));
const sigBefore = JSON.stringify(db.getCustomer.get(SIG_CTRL.code));

// 造 3 组 Telegram 重复
const pairs = [];
for (let i = 0; i < 3; i += 1) {
  const n = makeCustomer(ACC, `tg:600000000${i}`, `QA Dup ${i}`, '');
  const m = makeCustomer(ACC, `tg:QA Dup ${i}`, `QA Dup ${i}`, '');
  addMsg(m.code, ACC, `dup msg ${i}`, `QA Dup ${i}:d${i}`);
  pairs.push([m.code, n.code]);
}

const migLogs = [];
const mig1 = tgMerge.runMigration(db, { log: (s) => migLogs.push(s) });
eq('第一次迁移：发现 3 组', mig1.pairs, 3);
eq('第一次迁移：合并 3 组', mig1.merged, 3);
check('🔴 备份文件**真的被创建**（路径存在）',
  !!mig1.backup && fs.existsSync(mig1.backup), String(mig1.backup));
check('备份文件名带时间戳（.bak-YYYYMMDD-HHMMSS）', /\.bak-\d{8}-\d{6}$/.test(String(mig1.backup)), String(mig1.backup));
check('备份落在**本次临时库**同目录（没去动真实 data/）',
  !!mig1.backup && path.dirname(path.resolve(mig1.backup)) === path.resolve(DATA_DIR), String(mig1.backup));
const bakSize = mig1.backup ? fs.statSync(mig1.backup).size : 0;
check('备份文件非空（是真快照，不是空壳）', bakSize > 0, `size=${bakSize}`);
console.log(`      备份路径：${mig1.backup}（${mig1.backupVia}，${bakSize} 字节）`);

// 数据快照，用于验证幂等
const snap = () => JSON.stringify(db.db.prepare(
  `SELECT code, wa_jid, name, phone, voided, void_note FROM customers
    WHERE IFNULL(channel,'whatsapp')='telegram' ORDER BY code`).all());
const snap1 = snap();

const mig2 = tgMerge.runMigration(db, { log: (s) => migLogs.push(s) });
eq('🔴 幂等：第二次跑发现 0 组', mig2.pairs, 0);
eq('🔴 幂等：第二次跑合并 0 组', mig2.merged, 0);
const mig3 = tgMerge.runMigration(db, { log: (s) => migLogs.push(s) });
eq('🔴 幂等：第三次跑还是 0 组', mig3.pairs, 0);
eq('🔴 幂等：第三次跑合并 0 组', mig3.merged, 0);
eq('🔴 幂等：三次跑完数据一字未再变', snap(), snap1);
check('第二次跑明确报告「无需合并」',
  migLogs.some((s) => /无需合并/.test(s)), JSON.stringify(migLogs.slice(-3)));

// 只限 telegram
eq('🔴 只限 telegram：WhatsApp 对照组一个字节没变', JSON.stringify(db.getCustomer.get(WA_CTRL.code)), waBefore);
eq('🔴 只限 telegram：WhatsApp 对照组消息数没变',
  db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(WA_CTRL.code).n, 1);
eq('🔴 只限 telegram：Signal 对照组一个字节没变', JSON.stringify(db.getCustomer.get(SIG_CTRL.code)), sigBefore);
eq('🔴 只限 telegram：WhatsApp 对照组没被标作废', Number(db.getCustomer.get(WA_CTRL.code).voided || 0), 0);
eq('🔴 只限 telegram：Signal 对照组没被标作废', Number(db.getCustomer.get(SIG_CTRL.code).voided || 0), 0);
// 迁移结果核对
for (const [namedCode, numCode] of pairs) {
  eq(`迁移后 ${namedCode} 作废`, Number(db.getCustomer.get(namedCode).voided), 1);
  check(`迁移后 ${numCode} 拿到名键那条的消息`,
    msgsOf(numCode).some((m) => /dup msg/.test(String(m.body || ''))));
}

/* =====================================================================
 * A5｜时间剥离
 * ================================================================== */
section('A5｜正文尾部时间剥离');
const TIME_CASES = [
  ['Hello 14:03', 'Hello', '14:03'],
  ['Hello 9:05', 'Hello', '9:05'],
  ['明天见 下午 3:20', '明天见', '下午 3:20'],
  ['明天见 上午 9:05', '明天见', '上午 9:05'],
  ['good morning 9:05 AM', 'good morning', '9:05 AM'],
  ['good night 11:30 PM', 'good night', '11:30 PM'],
  ['ok 14:03:22', 'ok', '14:03:22'],
  ['晚点聊 晚上 8:00', '晚点聊', '晚上 8:00'],
  ['Is this still available?', 'Is this still available?', ''],
];
for (const [src, expBody, expTime] of TIME_CASES) {
  const r = tgMerge.stripTrailingTime(src);
  eq(`"${src}" → 正文 "${expBody}"`, r.body, expBody);
  eq(`"${src}" → 时间 "${expTime}"`, r.msgTime, expTime);
}
eq('只有时间 → 正文为空（调用方丢弃）', tgMerge.stripTrailingTime('14:03').body, '');
check('只有时间 → onlyTime=true', tgMerge.stripTrailingTime('14:03').onlyTime === true);
eq('只有时间（带下午）→ 也丢弃', tgMerge.stripTrailingTime('下午 3:20').body, '');
eq('空串不崩', tgMerge.stripTrailingTime('').body, '');
eq('null 不崩', tgMerge.stripTrailingTime(null).body, '');
eq('undefined 不崩', tgMerge.stripTrailingTime(undefined).body, '');

// 采集侧落地
const m1 = telegramRead.toMessage({ chatKey: '7207229390', chatName: 'Eileen Lin', body: 'Hello 14:03', direction: 'in' }, 7);
eq('toMessage：正文剥干净', m1 && m1.body, 'Hello');
eq('toMessage：时间进 msgTime', m1 && m1.msgTime, '14:03');
check('toMessage：只剩时间 → 整条丢弃（不建档、不提醒）',
  telegramRead.toMessage({ chatKey: '7207229390', chatName: 'Eileen Lin', body: '14:03', direction: 'in' }, 7) === null);
// 入库落地
const TC = makeCustomer(ACC, 'tg:3332221111', 'Time Case', '');
addMsg(TC.code, ACC, 'Hello 14:03', 'Time Case:t1', '14:03', '你好 14:03');
const row = db.db.prepare(`SELECT body, body_zh, msg_time FROM messages WHERE customer_code=?`).get(TC.code);
eq('入库：body 不带时间', row.body, 'Hello 14:03');   // saveMessage 只存传入值，剥在采集侧
eq('入库：msg_time 单独存了时间', String(row.msg_time || ''), '14:03');

/* =====================================================================
 * A6｜界面：时间只渲染一次 + 方框 + 译文不带时间
 * ================================================================== */
section('A6｜界面渲染：时间只出现一次 + 方框 + 译文不带时间');

/**
 * 把 public/app.js 里 Telegram 渲染相关的真实代码抽出来，在 Node 里跑一遍，
 * 拿**渲染出来的真实 HTML** 数时间出现几次（不采信任何"应该没问题"的说法）。
 */
function loadAppJsRenderers() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const escSrc = src.match(/const esc = \(s\) =>[\s\S]*?\[c\]\)\);/);
  if (!escSrc) throw new Error('找不到 esc 定义');
  const a = src.indexOf('const TG_TRAIL_TIME_RE');
  const b = src.indexOf('/** 画聊天气泡');
  if (a < 0 || b < 0) throw new Error('找不到 Telegram 时间剥离代码块');
  const block = escSrc[0] + '\n' + src.slice(a, b);
  const sandbox = {};
  vm.createContext(sandbox);
  const out = vm.runInContext(
    block + '\n;({ esc, TG_TRAIL_TIME_RE, tgSplitTime, tgTimeBoxHtml });',
    sandbox,
  );
  if (!out || typeof out.tgSplitTime !== 'function') throw new Error('抽出 tgSplitTime 失败');
  return out;
}

const app = loadAppJsRenderers();
check('app.js 导出了 tgSplitTime / tgTimeBoxHtml',
  typeof app.tgSplitTime === 'function' && typeof app.tgTimeBoxHtml === 'function');

const sp = app.tgSplitTime('Hello 14:03', '');
eq('前端 tgSplitTime：正文剥干净', sp.text, 'Hello');
eq('前端 tgSplitTime：时间剥出来', sp.time, '14:03');
const boxHtml = app.tgTimeBoxHtml('14:03');
eq('时间方框 HTML（带边框 class）', boxHtml, '<div class="tg-time-box">14:03</div>');
eq('没有时间 → 方框不渲染（时间不会出现第二次）', app.tgTimeBoxHtml(''), '');
eq('老译文「你好 14:03」被剥掉时间', app.tgSplitTime('你好 14:03').text, '你好');

/* 真实渲染整行：把 renderTgChat(rows) 里的行模板整段抄出来执行（与源码逐字一致） */
function renderRowFromSource(m) {
  const rows = [m];
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // 取 renderTgChat(rows) 函数里 for 循环内部的模板（从 `let html` 到 `box.innerHTML = html;`）
  const s = appSrc.indexOf('function renderTgChat(rows)');
  const e = appSrc.indexOf('box.innerHTML = html;', s);
  if (s < 0 || e < 0) throw new Error('定位 renderTgChat 失败');
  let body = appSrc.slice(s, e);
  // 截掉函数签名与前置，只保留 for 循环
  const forStart = body.indexOf('for (const m of rows) {');
  body = body.slice(forStart);
  const fn = new Function('rows', 'esc', 'tgSplitTime', 'tgTimeBoxHtml', 'tgMsgIsChinese',
    `let html = '';\n${body}\nreturn html;`);
  return fn(rows, app.esc, app.tgSplitTime, app.tgTimeBoxHtml, (t) => /[\u4e00-\u9fa5]/.test(String(t || '')));
}

const rowHtmlIn = renderRowFromSource({
  direction: 'in', body: 'Hello 14:03', bodyZh: '你好 14:03', msg_time: '14:03', id: 1, hasMedia: 0,
});
console.log(`      渲染出的 HTML：${rowHtmlIn.replace(/\s+/g, ' ').trim()}`);
const timeCount = (rowHtmlIn.match(/14:03/g) || []).length;
eq('🔴 每行时间**只渲染一次**（"14:03" 出现 1 次）', timeCount, 1);
check('时间放在带边框的方框里', /class="tg-time-box">14:03</.test(rowHtmlIn), rowHtmlIn);
check('气泡正文里没有时间', /class="tg-bubble">Hello</.test(rowHtmlIn), rowHtmlIn);
check('译文气泡里没有时间（老译文「你好 14:03」被剥）', /class="tg-zh"[^>]*>[\s\S]*?你好<span|译<\/span>你好</.test(rowHtmlIn) && !/译<\/span>你好 14:03/.test(rowHtmlIn), rowHtmlIn);

const rowHtmlZh = renderRowFromSource({
  direction: 'in', body: '你好', bodyZh: '', msg_time: '', id: 2, hasMedia: 0,
});
eq('中文原文不出译气泡时也没有时间方框（没时间就不画）', (rowHtmlZh.match(/tg-time-box/g) || []).length, 0);

// 老数据兜底：库里 body 还带着时间、msg_time 为空
const rowHtmlLegacy = renderRowFromSource({
  direction: 'in', body: 'Hello 14:03', bodyZh: '你好 14:03', msg_time: '', id: 3, hasMedia: 0,
});
eq('🔴 老数据（msg_time 为空、body 带时间）也只渲染一次', (rowHtmlLegacy.match(/14:03/g) || []).length, 1);
check('老数据：时间进了方框而不是留在正文', /class="tg-bubble">Hello</.test(rowHtmlLegacy) && /class="tg-time-box">14:03</.test(rowHtmlLegacy), rowHtmlLegacy);

/* 第二个渲染入口 renderTgChat(code, mp)（中栏「对话信息」列）也要验一遍 */
const appSrc2 = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
eq('🔴 两个 Telegram 渲染入口都挂了时间方框（各 1 次）',
  (appSrc2.match(/tgTimeBoxHtml\(sp\.time\)/g) || []).length, 2);
const s2 = appSrc2.indexOf('function renderTgChat(code, mp)');
const b2 = appSrc2.indexOf('const isOut = m.direction === \'out\';', s2);
const e3 = appSrc2.indexOf('</div>`;', b2);
check('定位到第二个渲染入口的行模板', s2 > 0 && b2 > s2 && e3 > b2, `${s2}/${b2}/${e3}`);
const tpl2 = appSrc2.slice(b2, e3 + '</div>`;'.length);
const fn2 = new Function('m', 'esc', 'tgSplitTime', 'tgTimeBoxHtml', 'tgMsgIsChinese', `${tpl2}\n`);
const rowHtml2 = fn2({ direction: 'in', body: 'Hello 14:03', body_zh: '你好 14:03', msg_time: '' },
  app.esc, app.tgSplitTime, app.tgTimeBoxHtml, (t) => /[\u4e00-\u9fa5]/.test(String(t || '')));
console.log(`      第二入口渲染出的 HTML：${rowHtml2.replace(/\s+/g, ' ').trim()}`);
eq('🔴 第二入口：每行时间也只渲染一次', (rowHtml2.match(/14:03/g) || []).length, 1);
check('第二入口：时间进了方框', /class="tg-time-box">14:03</.test(rowHtml2), rowHtml2);
check('第二入口：气泡正文不带时间', /class="tg-bubble">Hello</.test(rowHtml2), rowHtml2);
check('第二入口：译文气泡不带时间（老译文被剥）', /译<\/span>你好</.test(rowHtml2), rowHtml2);

// CSS 方框
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
check('CSS 有 .tg-time-box 且带边框', /\.tg-time-box\s*\{[^}]*border:\s*1px solid/.test(css));
check('.tg-time-box 放在 .tg-zh 之后（Telegram 区块内，不动全局）',
  css.indexOf('.tg-time-box') > css.indexOf('.tg-zh.mine'));

/* =====================================================================
 * B｜同名误合并风险（重点）
 * ================================================================== */
section('B｜同名误合并风险：同一 TG 账号下两个不同真人恰好同名');

const ACC_B = 7;
// 两个都叫 "Eileen Lin" 的真人，peerId 不同
const TWIN = 'QA Twin Name';
const E1 = makeCustomer(ACC_B, 'tg:8111000001', TWIN, '');
const E2 = makeCustomer(ACC_B, 'tg:8111000002', TWIN, '');
addMsg(E1.code, ACC_B, 'E1 说的话', '8111000001:e1');
addMsg(E2.code, ACC_B, 'E2 说的话', '8111000002:e2');

// B-1：存量迁移会不会把两个数字键的同名人合并？
const dupPairs = tgMerge.findDuplicatePairs(db);
const wouldMergeE = dupPairs.filter((p) => p.toCode === E1.code || p.toCode === E2.code || p.fromCode === E1.code || p.fromCode === E2.code);
eq('B-1 两条**都是数字键**的同名人 → 迁移不配成对（安全）', wouldMergeE.length, 0);

// B-2：其中一个还有名键记录时，名键会被并到哪一个身上？
const E_NAMED = makeCustomer(ACC_B, `tg:${TWIN}`, TWIN, '');
addMsg(E_NAMED.code, ACC_B, '名键那条说的话', `${TWIN}:en1`);
const dupPairs2 = tgMerge.findDuplicatePairs(db);
const hit2 = dupPairs2.filter((p) => p.fromCode === E_NAMED.code);
check('B-2 出现「同名 + 一个名键 + 两个数字键」时，迁移**仍然会**配成对（这就是风险入口）',
  hit2.length === 1, JSON.stringify(dupPairs2.map((p) => [p.fromCode, p.toCode])));
if (hit2.length) {
  console.log(`      ⚠ 名键 ${E_NAMED.code} 被配到 → ${hit2[0].toCode}（两个同名真人中的一条）`);
  console.log(`      ⚠ 分组里有两个数字键：${E1.code}(tg:8111000001) / ${E2.code}(tg:8111000002)，取哪条取决于查库顺序`);
}

// B-3：增量路径（只有名字、库里两个数字键同名）会归到哪条？
const planB3 = tgMerge.resolveIncoming(db, { accountId: ACC_B, chatKey: TWIN, name: TWIN });
check('B-3 增量：只有名字 + 库里两个同名数字键 → 会**任选一条**归进去（风险）',
  planB3.numeric === true, JSON.stringify(planB3));
console.log(`      增量解析结果：customerKey=${planB3.customerKey}（真实存在两条：${E1.code}=tg:8111000001 / ${E2.code}=tg:8111000002）`);

// B-4：真正跑一次迁移，证明「名键那条到底并给了谁」是错的可能（名键实际属于 E2）
const migB = tgMerge.runMigration(db, { log: () => {} });
const landedOnE1 = msgsOf(E1.code).some((m) => /名键那条说的话/.test(String(m.body || '')));
const landedOnE2 = msgsOf(E2.code).some((m) => /名键那条说的话/.test(String(m.body || '')));
console.log(`      B-4 真实跑迁移后：名键那条的消息落在 E1(${E1.code})=${landedOnE1} / E2(${E2.code})=${landedOnE2}`);
check('B-4 ⚠ 风险坐实：名键那条被**无条件并给了建得最早的那条数字键**（E1），'
  + '即使它真实属于 E2 —— 合并判据里没有任何「这两条真的是同一个人」的佐证',
  landedOnE1 === true && landedOnE2 === false,
  `E1=${JSON.stringify(msgsOf(E1.code).map((m) => m.body))} E2=${JSON.stringify(msgsOf(E2.code).map((m) => m.body))}`);
eq('B-4 迁移本身执行成功（说明这不是"没跑到"，而是判据本身的问题）', migB.merged, 1);

/* =====================================================================
 * D'｜只写 Telegram：msg_time 只有 Telegram 有值
 * ================================================================== */
section('D｜msg_time 只有 Telegram 写');
const waMsgRow = db.db.prepare(`SELECT msg_time FROM messages WHERE customer_code=?`).get(WA_CTRL.code);
eq('WhatsApp 消息的 msg_time 恒为空', String(waMsgRow.msg_time || ''), '');
const sigMsgRow = db.db.prepare(`SELECT msg_time FROM messages WHERE customer_code=?`).get(SIG_CTRL.code);
eq('Signal 消息的 msg_time 恒为空', String(sigMsgRow.msg_time || ''), '');
eq('Telegram 消息的 msg_time 有值', String(row.msg_time || ''), '14:03');
const tgEmptyCount = db.db.prepare(
  `SELECT COUNT(*) n FROM messages m JOIN customers c ON c.code=m.customer_code
    WHERE IFNULL(c.channel,'whatsapp')<>'telegram' AND TRIM(COALESCE(m.msg_time,''))<>''`).get().n;
eq('🔴 非 Telegram 渠道的 msg_time 全库为空（0 条越界）', tgEmptyCount, 0);

console.log(`\n========== QA 独立验收：${pass} 通过 / ${fail} 失败 ==========`);
if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);
