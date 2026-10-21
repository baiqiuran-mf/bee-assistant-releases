/*
 * 解密格式穷举（只读，2026-10-08）
 * 目的：不再猜 Signal 附件的字节布局，用「解出来必须是 JPEG/PNG 文件头」当唯一判据，
 *       把所有合理布局 × key 顺序全试一遍。
 * 同时交叉核对 messages.json 里 attachment 自带的 localKey 是否和表里一致。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const signalStatus = require('../src/signalStatus');

const dataDir = path.join(process.env.APPDATA || '', 'Signal');
const attRoot = path.join(dataDir, 'attachments.noindex');
const db = signalStatus.openDb();

/* ---------- 1. 交叉核对 key ---------- */
console.log('===== messages.json 里的 attachment key（与表列对照）=====');
const mrows = db.prepare("SELECT id, type, json FROM messages WHERE hasAttachments = 1 LIMIT 2").all();
for (const m of mrows) {
  let j; try { j = JSON.parse(m.json); } catch (e) { console.log('  json 解析失败'); continue; }
  const atts = (j && j.attachments) || [];
  console.log(`  message type=${m.type} json.attachments 数量=${atts.length}`);
  for (const a of atts.slice(0, 2)) {
    console.log('    json.localKey = ' + a.localKey);
    const row = db.prepare('SELECT localKey, thumbnailLocalKey, path, size FROM message_attachments WHERE messageId = ? AND path = ?').get(m.id, a.path || '');
    if (row) {
      console.log('    表.localKey     = ' + row.localKey);
      console.log('    两者一致 = ' + (row.localKey === a.localKey));
    } else {
      console.log('    表里按此 path 没找到行');
    }
  }
}

/* ---------- 2. 布局穷举 ---------- */
function looksLikeImage(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (b[0] === 0x89 && b.slice(1, 4).toString() === 'PNG') return 'png';
  if (b.slice(0, 3).toString() === 'GIF') return 'gif';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

function aesCbc(key, iv, ct) {
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([d.update(ct), d.final()]); // 自动去 padding
  } catch (e) { return null; }
}
function aesCbcRaw(key, iv, ct) {
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch (e) { return null; }
}

const ZERO_IV = Buffer.alloc(16, 0);

/** 枚举所有布局；返回命中的那个 */
function brute(buf, keyB64) {
  const K = Buffer.from(keyB64, 'base64');
  if (K.length !== 64) return { err: 'key 长度 ' + K.length };
  const orders = [
    { name: 'mac=K[0:32] aes=K[32:64]', mac: K.slice(0, 32), aes: K.slice(32, 64) },
    { name: 'aes=K[0:32] mac=K[32:64]', mac: K.slice(32, 64), aes: K.slice(0, 32) },
  ];
  const N = buf.length;
  const layouts = [
    { name: 'A mac头32 iv=0 ct=rest', mac: buf.slice(0, 32), iv: ZERO_IV, ct: buf.slice(32) },
    { name: 'B iv头16 mac头32 ct=rest', mac: buf.slice(16, 48), iv: buf.slice(0, 16), ct: buf.slice(48) },
    { name: 'C mac尾32 iv=0 ct=前段', mac: buf.slice(N - 32), iv: ZERO_IV, ct: buf.slice(0, N - 32) },
    { name: 'D iv头16 mac尾32 ct=中段', mac: buf.slice(N - 32), iv: buf.slice(0, 16), ct: buf.slice(16, N - 32) },
    { name: 'E 全文件即密文 iv=0', mac: null, iv: ZERO_IV, ct: buf },
    { name: 'F 全文件即密文 iv=头16', mac: null, iv: buf.slice(0, 16), ct: buf.slice(16) },
    { name: 'G ct=去头48 iv=0', mac: null, iv: ZERO_IV, ct: buf.slice(48) },
  ];

  for (const o of orders) {
    for (const L of layouts) {
      for (const raw of [false, true]) {
        const out = raw ? aesCbcRaw(o.aes, L.iv, L.ct) : aesCbc(o.aes, L.iv, L.ct);
        if (!out) continue;
        const kind = looksLikeImage(out);
        if (kind) {
          return { hit: true, kind, layout: L.name, order: o.name, raw, len: out.length, data: out,
                   macOk: L.mac ? crypto.timingSafeEqual(L.mac, crypto.createHmac('sha256', o.mac).update(L.ct).digest()) : null };
        }
      }
    }
  }
  return { hit: false };
}

console.log('\n===== 布局穷举 =====');
const targets = [];
const a1 = db.prepare('SELECT path, localKey, contentType, size FROM message_attachments WHERE messageType = ? LIMIT 1').get('story');
if (a1) targets.push({ label: '故事图片附件 ' + a1.contentType + ' ' + a1.size + 'B', file: path.join(attRoot, a1.path), key: a1.localKey });
for (const c of db.prepare('SELECT profileFullName, json FROM conversations WHERE json LIKE ?').all('%profileAvatar%')) {
  let j; try { j = JSON.parse(c.json); } catch (e) { continue; }
  const av = j.profileAvatar;
  if (av && av.path && av.localKey && av.path.indexOf('images/') !== 0) {
    targets.push({ label: '头像 ' + c.profileFullName + ' ' + av.size + 'B', file: path.join(attRoot, av.path), key: av.localKey });
  }
}

for (const t of targets) {
  if (!fs.existsSync(t.file)) { console.log('  文件不存在：' + t.file); continue; }
  const buf = fs.readFileSync(t.file);
  const r = brute(buf, t.key);
  if (r.hit) {
    console.log(`  ✅ 命中 ${t.label}`);
    console.log(`     布局=${r.layout} | key顺序=${r.order} | 自动去padding=${!r.raw} | 明文=${r.len}B | MAC校验=${r.macOk}`);
    const outDir = 'E:/WorkBuddy-Projects/wa-assistant/preview/signal_decrypt';
    fs.mkdirSync(outDir, { recursive: true });
    const ext = r.kind === 'jpeg' ? 'jpg' : r.kind;
    const safe = t.label.replace(/[^\w一-龥]+/g, '_').slice(0, 30);
    const f = path.join(outDir, `${safe}.${ext}`);
    fs.writeFileSync(f, r.data);
    console.log('     已保存 ' + f);
  } else {
    console.log(`  ❌ ${t.label}（${buf.length}B）：7 种布局 × 2 种 key 顺序全不匹配`);
  }
}
db.close();
