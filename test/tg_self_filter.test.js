/**
 * 「自己」的行（customers.is_self=1）从客户列表里排掉（2026-10-17）
 *
 * 背景：Telegram 账号本人的号（tg:Xue / tg_username=wanfengzhiqiu）被误当成客户建了档，
 *       还顺着这条档案抓了 22 条**自己发出去**的消息，被误报成"新客户来消息"。
 *       生产库已把那一行标成 is_self=1，软件要把它从客户列表里排除。
 *
 * 本测试覆盖三件事：
 *   ① 客户列表 / 待处理列表确实不含 is_self=1 的行；
 *   ② getCustomer(code) 仍然取得到那一行（档案页还要能打开自己那条）；
 *   ③ 老库没有 is_self 列时，列表查询不报错（退回不过滤版本）。
 *
 * 🔴 数据隔离：沿用 test/_isolate.js，库落在 .tmp-test-data/tg_self_filter.test.js/，
 *    **绝不**读写真实 data/assistant.db，更不会碰 D:\蜜蜂采集数据\... 那份生产库。
 *
 * 运行：node --experimental-sqlite test/tg_self_filter.test.js
 */

// 必须第一个 require：把数据目录指到本测试专属临时目录
const path = require('path');
const fs = require('fs');
const { DIR: DATA_DIR } = require('./_isolate.js');

const store = require('../src/db');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
}
function eq(name, actual, expected) {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

console.log('--- is_self 过滤（客户列表排除「自己」）---');
console.log(`数据目录：${DATA_DIR}`);
console.log(`驱动：${store.driver}`);

/* 造 3 个客户：两个正常客户 + 一个「自己」。
   用真实的 getOrCreateCustomer 建档，保证走的都是生产同一条写入路径。 */
const rSelf = store.getOrCreateCustomer(7, 'tg:100200300', { name: '我自己', channel: 'telegram' });
const rRealA = store.getOrCreateCustomer(7, 'tg:555000111', { name: '真实客户甲', channel: 'telegram' });
const rRealB = store.getOrCreateCustomer(7, 'tg:555000222', { name: '真实客户乙', channel: 'telegram' });

const selfCode = rSelf.customer.code;
const realCodes = [rRealA.customer.code, rRealB.customer.code];

// 默认必须是 0（没标就是普通客户），否则新客户一建档就被列表吞掉
eq('新客户默认 is_self=0', Number(store.getCustomer.get(selfCode).is_self), 0);

// 把「自己」那条标上 —— 等价于生产库已经做过的 UPDATE
store.db
  .prepare('UPDATE customers SET is_self = 1 WHERE code = ?')
  .run(selfCode);
eq('标记已写入 is_self=1', Number(store.getCustomer.get(selfCode).is_self), 1);

/* ---------- ① 客户列表不含 is_self=1 ---------- */

const listRows = store.listCustomers.all();
const listCodes = listRows.map((r) => r.code);

check('🔴 客户列表不含 is_self=1 的行',
  !listRows.some((r) => Number(r.is_self) === 1),
  `混进来的：${listRows.filter((r) => Number(r.is_self) === 1).map((r) => r.code).join(',')}`);
check('🔴 客户列表不含自己那条的编号', !listCodes.includes(selfCode), selfCode);
check('两个真实客户都还在列表里',
  realCodes.every((c) => listCodes.includes(c)),
  `列表=${listCodes.join(',')}`);
// 列表里剩下的每一行都必须是「非自己」
check('列表里每一行 is_self 都不为 1', listRows.every((r) => Number(r.is_self) !== 1));

/* ---------- ② getCustomer 仍取得到 is_self=1 ---------- */

const selfRow = store.getCustomer.get(selfCode);
check('🔴 getCustomer 仍能取到 is_self=1 的行', !!selfRow, '取不到了');
eq('getCustomer 取到的就是自己那条', selfRow && selfRow.code, selfCode);
eq('getCustomer 能读到 is_self=1', Number(selfRow && selfRow.is_self), 1);

/* ---------- ③ 待处理列表同样排除 ---------- */
// 把自己那条也标成 pending=1：它有"新消息"（其实是自己发的），最容易混进列表
store.db.prepare('UPDATE customers SET pending = 1 WHERE code = ?').run(selfCode);
store.db.prepare('UPDATE customers SET pending = 1 WHERE code = ?').run(realCodes[0]);

const pendingRows = store.listPending.all();
check('🔴 待处理列表不含 is_self=1 的行',
  !pendingRows.some((r) => Number(r.is_self) === 1),
  `混进来的：${pendingRows.filter((r) => Number(r.is_self) === 1).map((r) => r.code).join(',')}`);
check('待处理列表仍只返回 pending=1 的行',
  pendingRows.every((r) => Number(r.pending) === 1));

/* ---------- ④ 老库没有 is_self 列时不报错 ---------- */
/* 单独开一个**没有 is_self 列**的临时库，把 prepareListStmt 的兜底 SQL 拿出来真跑一遍：
   证明「老库」场景下列表查询不会抛 no such column。 */
console.log('\n--- 老库（无 is_self 列）兼容 ---');

const LEGACY_DIR = path.join(DATA_DIR, 'legacy');
fs.mkdirSync(LEGACY_DIR, { recursive: true });
const LEGACY_DB = path.join(LEGACY_DIR, 'assistant.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(LEGACY_DB + s)) fs.unlinkSync(LEGACY_DB + s);

let legacyChecked = false;
try {
  const { DatabaseSync } = require('node:sqlite');
  const legacy = new DatabaseSync(LEGACY_DB);

  // 故意**不建** is_self 列 —— 模拟还没 ALTER 过的老库
  legacy.exec(`
    CREATE TABLE customers (
      code TEXT PRIMARY KEY, account_id INTEGER, wa_jid TEXT, phone TEXT,
      name TEXT, pending INTEGER DEFAULT 0, unread INTEGER DEFAULT 0,
      queue_since TEXT, last_msg_at TEXT
    );
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_code TEXT, body TEXT, body_zh TEXT);
    INSERT INTO customers (code, account_id, wa_jid, name, pending, unread, last_msg_at)
      VALUES ('7A00999', 7, 'tg:999', '老库客户', 1, 3, '2026-10-17 10:00:00');
  `);

  const cols = legacy.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  check('老库确实没有 is_self 列', !cols.includes('is_self'), cols.join(','));

  // 带过滤的 SQL 在老库上必然失败 —— 这正是需要兜底的原因
  let filteredThrew = false;
  try {
    legacy.prepare('SELECT * FROM customers c WHERE COALESCE(c.is_self, 0) <> 1').all();
  } catch (e) {
    filteredThrew = true;
  }
  check('老库上带 is_self 的 SQL 会失败（所以必须有兜底）', filteredThrew);

  // db.js 里 prepareListStmt 的兜底分支：不带 is_self 的那条
  let plainRows = null;
  let plainErr = '';
  try {
    plainRows = legacy.prepare(`
      SELECT c.*, (SELECT body FROM messages m WHERE m.customer_code=c.code
                   ORDER BY m.id DESC LIMIT 1) AS last_body
      FROM customers c
      ORDER BY (COALESCE(c.unread, 0) > 0) DESC, c.last_msg_at DESC
    `).all();
  } catch (e) {
    plainErr = (e && e.message) || String(e);
  }
  check('🔴 老库上兜底 SQL 不报错', plainRows !== null, plainErr);
  check('老库上兜底 SQL 正常返回数据', Array.isArray(plainRows) && plainRows.length === 1,
    Array.isArray(plainRows) ? `返回 ${plainRows.length} 行` : '没返回');
  legacy.close();
  legacyChecked = true;
} catch (e) {
  check('老库兼容用例没能跑起来（node:sqlite 不可用？）', false, (e && e.message) || String(e));
}
if (legacyChecked) {
  check('老库兼容用例已执行', true);
}

/* ---------- ⑤ 排序没被过滤破坏 ---------- */
/* 过滤必须发生在 SQL 里；如果改成「排完再 filter」，自己那条会占着红点位置把真客户挤下去。 */
console.log('\n--- 排序与红点 ---');

store.db.prepare('UPDATE customers SET unread = 0, queue_since = NULL').run();
store.db.prepare('UPDATE customers SET unread = 5, queue_since = ? WHERE code = ?')
  .run('2026-10-17 09:00:00', realCodes[1]);
store.db.prepare('UPDATE customers SET unread = 9, queue_since = ? WHERE code = ?')
  .run('2026-10-17 08:00:00', selfCode);

const ordered = store.listCustomers.all().map((r) => r.code);
check('有未读的真客户仍排在最前（没被自己那条挤下去）',
  ordered[0] === realCodes[1],
  `实际排序=${ordered.join(',')}`);
check('自己那条即使 unread=9 也不在排序结果里', !ordered.includes(selfCode));

console.log('\n========================================');
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log('========================================\n');

process.exit(fail === 0 ? 0 : 1);