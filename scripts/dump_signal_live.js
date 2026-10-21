/*
 * 一次性诊断脚本（只读，2026-10-08）
 * 用途：Signal 一直开着时，直接把本机 Signal 库里的会话、资料、消息原样打印出来。
 * 🔴 只读：不写 Signal 库、不写 assistant.db、不发消息。
 * 用法：node scripts/dump_signal_live.js
 */
const signalStatus = require('../src/signalStatus');
const signalRead = require('../src/signalRead');

function hr(t) { console.log('\n===== ' + t + ' ====='); }

let db;
try {
  db = signalStatus.openDb();
} catch (e) {
  console.error('打不开 Signal 库：', signalStatus.describeOpenError ? signalStatus.describeOpenError(e) : e);
  process.exit(1);
}

try {
  // ---------- 1. 表清单 ----------
  hr('表清单');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  console.log(tables.join(', '));

  // ---------- 2. conversations 字段 ----------
  hr('conversations 字段');
  console.log(db.prepare('PRAGMA table_info(conversations)').all()
    .map(c => `${c.name}:${c.type}`).join('\n'));

  // ---------- 3. messages 字段 ----------
  hr('messages 字段');
  console.log(db.prepare('PRAGMA table_info(messages)').all()
    .map(c => `${c.name}:${c.type}`).join('\n'));

  // ---------- 4. 所有会话（含无消息的） ----------
  hr('全部会话 conversations');
  const convCols = db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
  const want = ['id', 'serviceId', 'groupId', 'name', 'profileName', 'profileFamilyName',
    'profileFullName', 'e164', 'type', 'members', 'active_at', 'profileLastFetchedAt', 'expireTimerVersion'];
  const sel = want.filter(c => convCols.indexOf(c) >= 0);
  const convs = db.prepare(`SELECT ${sel.join(', ')} FROM conversations ORDER BY COALESCE(active_at,0) DESC`).all();
  console.log('会话数 =', convs.length, '| 选中字段 =', sel.join(','));
  for (const c of convs) {
    console.log('  ' + JSON.stringify(c));
  }

  // ---------- 5. 资料类表（好友资料） ----------
  hr('资料 / 联系人相关表');
  for (const t of ['contacts', 'contact_aci', 'profileKeys', 'profileDetails', 'identityKeys',
    'acis', 'groupMembers', 'recipientKeys', 'sessions', 'conversationMembers']) {
    if (tables.indexOf(t) < 0) { console.log(`  (无 ${t} 表)`); continue; }
    let cols = [];
    try { cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); } catch (e) { continue; }
    let n = 0;
    try { n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (e) { n = -1; }
    console.log(`  ${t}  行数=${n}  字段=[${cols.join(',')}]`);
  }

  // ---------- 6. contact / acis 详情（好友名单） ----------
  for (const t of ['contacts', 'acis', 'contact_aci']) {
    if (tables.indexOf(t) < 0) continue;
    hr(`好友名单：${t}`);
    try {
      const rows = db.prepare(`SELECT * FROM ${t} LIMIT 200`).all();
      console.log('行数 =', rows.length);
      for (const r of rows) console.log('  ' + JSON.stringify(r));
    } catch (e) {
      console.log('  读失败：' + e.message);
    }
  }

  // ---------- 7. 走 signalRead 的增量链路 ----------
  hr('signalRead.readNew(0) 增量结果');
  const r = signalRead.readNew(0, 500);
  console.log('ok =', r.ok, '| reason =', r.reason || '-', '| 条数 =', r.items.length, '| 水位 =', r.watermark);
  for (const m of r.items) {
    console.log('  ' + JSON.stringify({
      ts: m.ts, dir: m.direction, name: m.name, phone: m.phone, phoneState: m.phoneState,
      isGroup: m.isGroup, key: m.customerKey, body: m.body.slice(0, 120),
    }));
  }

  // ---------- 8. 原始 messages 按 type 统计 ----------
  hr('messages 按 type 统计');
  console.log(db.prepare('SELECT type, COUNT(*) c FROM messages GROUP BY type ORDER BY c DESC').all()
    .map(r => `  ${r.type} = ${r.c}`).join('\n'));

  // ---------- 9. 最近 20 条原始消息（含被过滤的） ----------
  hr('最近 20 条原始消息');
  const raw = db.prepare(`
    SELECT m.id, m.sent_at, m.type, m.body, m.hasAttachments, m.sourceServiceId,
           m.conversationId, c.serviceId convServiceId, c.name convName,
           c.profileName, c.profileFullName, c.e164, c.type convType
      FROM messages m LEFT JOIN conversations c ON c.id = m.conversationId
     ORDER BY m.sent_at DESC LIMIT 20`).all();
  for (const m of raw) {
    const dt = new Date(Number(m.sent_at)).toLocaleString('zh-CN');
    console.log(`  [${dt}] type=${m.type} conv=${m.convName || m.profileFullName || m.profileName || m.convServiceId} body=${JSON.stringify(String(m.body == null ? '' : m.body).slice(0, 100))}`);
  }
} finally {
  try { db.close(); } catch (e) { /* 只读 */ }
}
