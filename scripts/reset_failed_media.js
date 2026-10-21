/**
 * 把「补抓失败(fail)且 media_path 为空」的历史图片消息重置回 pending，
 * 让它们重新走一遍 路B+C / mediaFetch 补抓。
 *
 * 为什么要重置：
 *   2026-10-09 查明根因是 messages.wa_msg_id 存了裸哈希(msg.id.id)，
 *   而补抓的路B 要靠**完整 id**(msg.id._serialized)回页面 Msg.get(id) 捞对象。
 *   存了裸哈希 → 页面捞不到 → 老记录全部 fail 且 tries 用尽(5/7次)，永不再试。
 *   修复后需要把这些记录重置，让它们用正确逻辑再试一次。
 *
 * 🔴 安全：只重置「direction='in' 且 media_path 为空 且 media_fetch_state='fail'」，
 *    绝不碰已有图的、绝不碰已成功的、绝不删除任何消息。
 *
 * 用法：
 *   node scripts/reset_failed_media.js                 # 干跑，只报告不改
 *   node scripts/reset_failed_media.js --apply         # 真改
 *   node scripts/reset_failed_media.js --apply --db "路径"   # 指定库
 */
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbArg = args.includes('--db') ? args[args.indexOf('--db') + 1] : null;

function resolveDb() {
  if (dbArg) return path.resolve(dbArg);
  // 安装版数据目录（老板实际在用的）
  const appdata = process.env.APPDATA;
  const candidates = [
    appdata && path.join(appdata, 'wa-assistant', 'data', 'assistant.db'),
    path.resolve(__dirname, '..', 'data', 'assistant.db'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (require('node:fs').existsSync(c)) return c;
  }
  throw new Error('找不到 assistant.db，请用 --db 指定路径');
}

const dbPath = resolveDb();
const db = new DatabaseSync(dbPath);
console.log('数据库: ' + dbPath);
console.log(APPLY ? '模式: 真改(--apply)' : '模式: 干跑(加 --apply 才真改)');
console.log('');

const rows = db.prepare(`
  SELECT id, customer_code, direction, media_type, media_fetch_state, media_fetch_tries, wa_msg_id
  FROM messages
  WHERE media_fetch_state = 'fail'
    AND direction = 'in'
    AND TRIM(COALESCE(media_path, '')) = ''
  ORDER BY id DESC
`).all();

console.log('待重置 ' + rows.length + ' 条：');
for (const r of rows) {
  console.log(`  id=${r.id} 客户=${r.customer_code} 类型=${r.media_type || '(未知)'} ` +
    `已试=${r.media_fetch_tries}次 id=${r.wa_msg_id || '(空)'}`);
}

if (!rows.length) {
  console.log('\n没有需要重置的记录。');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n这是干跑。加 --apply 才会真正重置。');
  console.log('提醒：重置后仍需**保持 WhatsApp 浏览器窗口开启**，软件才会回页面重取真图。');
  process.exit(0);
}

const upd = db.prepare(`
  UPDATE messages
  SET media_fetch_state = 'pending', media_fetch_tries = 0
  WHERE id = ?
`);
let n = 0;
for (const r of rows) {
  upd.run(r.id);
  n++;
}
console.log(`\n已重置 ${n} 条为 pending（tries归零）。`);
console.log('下一步：启动软件并保持 WhatsApp 浏览器窗口开启，等待补抓。');
console.log('查进度：node scripts/check_media_status.js');