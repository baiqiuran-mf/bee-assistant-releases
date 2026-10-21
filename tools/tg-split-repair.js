/**
 * v2.6.1141 Telegram 误合并数据拆分（老板拍板「拆回来」）
 * 依据：wa_msg_id 前缀（抓取时的 chatKey），不看显示名。
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3-multiple-ciphers');

const DB = 'D:/蜜蜂采集数据/wa-assistant/data/assistant.db';
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const BAK = `${DB}.bak-split-${ts}`;

const db = new Database(DB);
db.pragma('journal_mode = WAL');

// ① 备份
db.exec(`VACUUM INTO '${BAK.replace(/'/g, "''")}'`);
console.log(`✅ 备份完成 → ${BAK}`);
console.log(`   完整性检查 = ${db.pragma('integrity_check', { simple: true })}`);

const before = {
  msg: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
  cus: db.prepare('SELECT COUNT(*) n FROM customers').get().n,
};
console.log(`   拆分前：客户 ${before.cus} / 消息 ${before.msg}`);

// ② 拆分计划：[数字键档案, 名键档案, 留在to的消息前缀, 搬回from的消息前缀, from的新说明]
const PLAN = [
  ['7A00005', '7A00004', '7664570369:', 'Xue:', '拆回（v2.6.1141）：这是老板自己的号'],
  ['7A00002', '7A00001', '8696576132:', 'wanyu lee:', '拆回（v2.6.1141）：同名不同人'],
];

const moveBack = db.prepare('UPDATE messages SET customer_code = ? WHERE customer_code = ? AND wa_msg_id LIKE ?');
const unvoid = db.prepare('UPDATE customers SET voided = 0, void_note = ? WHERE code = ?');

for (const [to, from, keepPre, backPre, note] of PLAN) {
  const cnt = db.prepare('SELECT COUNT(*) n FROM messages WHERE customer_code = ? AND wa_msg_id LIKE ?').get(from, backPre + '%').n;
  const r = moveBack.run(from, to, backPre + '%');
  unvoid.run(note, from);
  console.log(`✅ ${from} ← 从 ${to} 搬回 ${r.changes} 条（前缀 ${backPre}，预期 ${cnt}）`);
}

// ③ 把「自己」标记为排除出客户列表
db.exec(`ALTER TABLE customers ADD COLUMN is_self INTEGER DEFAULT 0`);
const markSelf = db.prepare('UPDATE customers SET is_self = 1, name = ? WHERE code = ?');
markSelf.run('Xue（我自己）', '7A00004');
console.log('✅ 7A00004 标记为 is_self=1（排除出客户列表）');

// ④ 校验条数守恒
const after = {
  msg: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
  cus: db.prepare('SELECT COUNT(*) n FROM customers').get().n,
};
console.log(`   拆分后：客户 ${after.cus} / 消息 ${after.msg}`);
console.log(`   消息数守恒 = ${after.msg === before.msg ? '✅ 一条不多一条不少' : '❌ 不守恒！'}`);

console.log('\n=== 拆分结果逐条核对 ===');
for (const c of ['7A00001', '7A00002', '7A00004', '7A00005']) {
  const cu = db.prepare('SELECT * FROM customers WHERE code=?').get(c);
  const n = db.prepare('SELECT COUNT(*) n FROM messages WHERE customer_code=?').get(c).n;
  const pre = {};
  for (const r of db.prepare('SELECT wa_msg_id FROM messages WHERE customer_code=?').all(c)) {
    const p = r.wa_msg_id.split(':')[0]; pre[p] = (pre[p] || 0) + 1;
  }
  console.log(` ${c} jid=${cu.wa_jid} name=${cu.name} voided=${cu.voided} is_self=${cu.is_self} 消息=${n} ${JSON.stringify(pre)}`);
}

console.log('\n=== 修复后 findDuplicatePairs 复查（应仍为 0 对）===');
const M = require('../src/telegramMerge');
M.ensureVoidColumns(db);
console.log(' 结果 =', M.findDuplicatePairs({ db }, s => console.log('  [log] ' + s)).length, '对');

db.close();
