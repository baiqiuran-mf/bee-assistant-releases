/**
 * 一次性诊断：把生产库里第 19 条消息（当时以base64 原文形式入库的那条）还原成图片。
 * 🔴 只读库，只写 tools/_cache_probe/。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB = path.join(process.env.APPDATA, 'wa-assistant', 'data', 'assistant.db');
const out = path.join(__dirname, '_cache_probe');
fs.mkdirSync(out, { recursive: true });

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare("SELECT id, direction, body FROM messages WHERE body LIKE '%9j/4AAQ%' OR body LIKE '%iVBORw0KGgo%' OR body LIKE '%R0lGOD%'").all();

console.log('库里以 base64 原文存着的消息:', rows.length);
for (const r of rows) {
  const b64 = String(r.body || '').replace(/\s/g, '');
  const buf = Buffer.from(b64, 'base64');
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf.slice(0, 4).toString('hex') === '89504e47';
  const ext = isJpeg ? 'jpg' : isPng ? 'png' : 'bin';
  // JPEG 宽高
  let dim = '';
  if (isJpeg) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        dim = `${buf.readUInt16BE(i + 7)}×${buf.readUInt16BE(i + 5)}`;
        break;
      }
      const seg = buf.readUInt16BE(i + 2);
      if (!seg || seg < 2) break;
      i += 2 + seg;
    }
  }
  const file = path.join(out, `msg${r.id}_${r.direction}_${(buf.length / 1024).toFixed(0)}KB.${ext}`);
  fs.writeFileSync(file, buf);
  console.log(`  id=${r.id} ${r.direction} ${(buf.length / 1024).toFixed(1)}KB magic=${buf.slice(0, 4).toString('hex')} ${dim} → ${path.basename(file)}`);
}