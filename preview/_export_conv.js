const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB = 'D:/蜜蜂采集数据/wa-assistant/data/assistant.db';
const OUT = path.join(__dirname, 'preview', '_conv');
fs.mkdirSync(OUT, { recursive: true });

const db = new DatabaseSync(DB, { readOnly: true });

function isGarbage(s) { const t = String(s || '').trim(); return t.startsWith('data:') || (t.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(t)); }

// 媒体消息（真实 base64 → 存成 jpg，按 1185 规则渲染）
const media = db.prepare(
  "SELECT id, body, media_type FROM messages WHERE lower(media_type) IN ('image','video') AND length(body)>500 ORDER BY id DESC LIMIT 4"
).all();
const mediaOut = [];
media.forEach((m, i) => {
  const buf = Buffer.from(String(m.body || ''), 'base64');
  const f = path.join(OUT, 'm' + i + '.jpg');
  fs.writeFileSync(f, buf);
  mediaOut.push({ type: m.media_type, file: 'm' + i + '.jpg' });
});

// 文字消息（in / out 各取真实样本，带译文）
function txt(dir, n) {
  const rows = db.prepare(
    `SELECT id, body, body_zh FROM messages WHERE direction='${dir}' AND (media_type IS NULL OR media_type='') AND length(body)>0 AND length(body)<200 AND body_zh IS NOT NULL ORDER BY id DESC LIMIT ${n}`
  ).all();
  return rows
    .filter(r => !isGarbage(r.body))
    .map(r => ({ id: r.id, en: String(r.body || ''), zh: String(r.body_zh || '') }));
}
const inTxt = txt('in', 2);
const outTxt = txt('out', 2);

// 语音（ptt 失败 → 信号，无图）
const ptt = db.prepare("SELECT id FROM messages WHERE lower(media_type)='ptt' ORDER BY id DESC LIMIT 1").get();

const data = { media: mediaOut, inTxt, outTxt, ptt: ptt ? ptt.id : null };
fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(data, null, 2));
console.log(JSON.stringify({
  media: mediaOut.map(m => m.type),
  inTxt: inTxt.map(t => t.en.slice(0, 30)),
  outTxt: outTxt.map(t => t.en.slice(0, 30)),
  pttId: data.ptt,
}, null, 2));
db.close();
