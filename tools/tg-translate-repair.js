/**
 * v2.6.1141 翻译修复：清被 MAX_AUTO_TRIES 永久拉黑的计数 + 清污染的翻译记忆
 * 依据：translation_memory 真实列 = id/src_norm/src_text/body_zh/provider/hits/src_len
 */
const Database = require('better-sqlite3-multiple-ciphers');
const DB = 'D:/蜜蜂采集数据/wa-assistant/data/assistant.db';
const db = new Database(DB);
db.pragma('journal_mode = WAL');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
db.exec(`VACUUM INTO '${(DB + '.bak-tgtr-' + ts).replace(/'/g, "''")}'`);
console.log('✅ 已备份 →', DB + '.bak-tgtr-' + ts);

const norm = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const beforeMsg = db.prepare('SELECT COUNT(*) n FROM messages').get().n;

console.log('\n=== 污染记忆逐条 ===');
const all = db.prepare('SELECT id, src_norm, body_zh FROM translation_memory').all();
const junk = all.filter(r =>
  norm(r.src_norm) === norm(r.body_zh) ||
  /无法处理这个请求|抱歉，我?不能|抱歉，我?无法|as an ai/i.test(String(r.body_zh || '')));
for (const r of junk) console.log(`  id=${r.id} src=${JSON.stringify(r.src_norm).slice(0, 36)} → zh=${JSON.stringify(r.body_zh).slice(0, 36)}`);
console.log(` → 污染 ${junk.length} 行 / 共 ${all.length} 行`);

const d1 = db.prepare(`UPDATE messages SET translate_state='pending', translate_tries=0
   WHERE translate_state='failed' OR translate_tries>=2`).run();
console.log(`\n✅ 重置 ${d1.changes} 条消息 → pending / tries=0`);
for (const r of junk) db.prepare('DELETE FROM translation_memory WHERE id=?').run(r.id);
console.log(`✅ 删除 ${junk.length} 行污染记忆`);

console.log('\n=== 复查 ===');
console.log(' 仍 failed 或 tries>=2：', db.prepare(`SELECT COUNT(*) n FROM messages WHERE translate_state='failed' OR translate_tries>=2`).get().n);
console.log(' 记忆表剩余：', db.prepare('SELECT COUNT(*) n FROM translation_memory').get().n, '行');
const afterMsg = db.prepare('SELECT COUNT(*) n FROM messages').get().n;
console.log(` 消息数守恒：${beforeMsg} → ${afterMsg} ${beforeMsg === afterMsg ? '✅' : '❌'}`);
console.log(' 待翻消息数（translate_state 为空或 pending）：',
  db.prepare(`SELECT COUNT(*) n FROM messages WHERE IFNULL(body,'')!='' AND IFNULL(body_zh,'')=''`).get().n);
console.log(' 完整性检查 =', db.pragma('integrity_check', { simple: true }));
db.close();
