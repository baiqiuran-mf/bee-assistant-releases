/*
 * 第二层诊断（只读，2026-10-08）：好友资料到底存在哪、有多丰富
 * 用法：node scripts/dump_signal_profile.js
 */
const signalStatus = require('../src/signalStatus');
function hr(t) { console.log('\n===== ' + t + ' ====='); }
function keysOf(o, prefix, out, depth) {
  if (depth > 3 || o == null) return;
  if (Array.isArray(o)) { o.slice(0, 2).forEach((v, i) => keysOf(v, `${prefix}[${i}]`, out, depth + 1)); return; }
  if (typeof o !== 'object') { out.push(`${prefix} = ${JSON.stringify(o)}`); return; }
  for (const k of Object.keys(o)) {
    const v = o[k];
    const p = `${prefix}.${k}`;
    if (v && typeof v === 'object') keysOf(v, p, out, depth + 1);
    else out.push(`${p} = ${JSON.stringify(v)}`);
  }
}

const db = signalStatus.openDb();
try {
  hr('conversations.json 展开（每个会话）');
  const rows = db.prepare('SELECT id, serviceId, type, name, profileName, profileFullName, e164, json FROM conversations').all();
  for (const r of rows) {
    console.log(`\n--- 会话 ${r.profileFullName || r.name || r.serviceId} (${r.type}) ---`);
    if (!r.json) { console.log('  json 为空'); continue; }
    let j; try { j = JSON.parse(r.json); } catch (e) { console.log('  json 解析失败'); continue; }
    const out = []; keysOf(j, 'json', out, 0);
    console.log(out.map(s => '  ' + s).join('\n'));
  }

  hr('items 表里的 contact / profile 记录');
  const items = db.prepare("SELECT id, json FROM items WHERE json LIKE '%contact%' OR json LIKE '%profile%' LIMIT 30").all();
  console.log('命中 =', items.length);
  for (const it of items) {
    let j; try { j = JSON.parse(it.json); } catch (e) { continue; }
    const out = []; keysOf(j, 'item', out, 0);
    console.log('  ' + out.filter(s => !/attachment|body|text|quote/i.test(s)).join('\n  '));
    console.log('  ---');
  }

  hr('identityKeys（3 行，看有没有资料线索）');
  for (const r of db.prepare('SELECT * FROM identityKeys').all()) {
    let j; try { j = JSON.parse(r.json); } catch (e) { j = r.json; }
    console.log('  ' + JSON.stringify(j).slice(0, 400));
  }

  hr('message_attachments 字段与行数');
  console.log('  ' + db.prepare('PRAGMA table_info(message_attachments)').all().map(c => `${c.name}:${c.type}`).join('\n  '));
  console.log('  行数 = ' + db.prepare('SELECT COUNT(*) c FROM message_attachments').get().c);

  hr('sessions（谁和我有加密会话 = 好友线索）');
  for (const r of db.prepare('SELECT id, ourServiceId, serviceId, conversationId FROM sessions').all()) {
    console.log('  ' + JSON.stringify(r));
  }

  hr('本机 Signal 自己的 ACI（对照用）');
  try {
    const ac = db.prepare("SELECT id, json FROM items WHERE json LIKE '%aci%' OR json LIKE '%me%' LIMIT 10").all();
    for (const r of ac) console.log('  ' + String(r.json).slice(0, 300));
  } catch (e) { console.log('  ' + e.message); }
} finally {
  try { db.close(); } catch (e) { /* 只读 */ }
}
