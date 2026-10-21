/*
 * 精确定位 MAC 长度 / padding 规则（只读，2026-10-08）
 * 已确认：布局 = [16B IV][AES-CBC 密文][MAC]，AES key = localKey[0:32]
 * 待定：MAC 到底多长（16/32？）、密文要不要去 padding。
 * 判据：解出的明文末尾必须出现 JPEG EOI 标记 ffd9。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const signalStatus = require('../src/signalStatus');

const attRoot = path.join(process.env.APPDATA || '', 'Signal', 'attachments.noindex');
const db = signalStatus.openDb();

function dec(key, iv, ct, autoPad) {
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
    d.setAutoPadding(!!autoPad);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch (e) { return null; }
}

const targets = [];
const a1 = db.prepare('SELECT path, localKey, contentType, size FROM message_attachments WHERE messageType = ? ORDER BY sentAt DESC LIMIT 1').get('story');
if (a1) targets.push({ label: '故事图', file: path.join(attRoot, a1.path), key: a1.localKey, dbsize: a1.size });
for (const c of db.prepare('SELECT profileFullName, json FROM conversations WHERE json LIKE ?').all('%profileAvatar%')) {
  let j; try { j = JSON.parse(c.json); } catch (e) { continue; }
  const av = j.profileAvatar;
  if (av && av.path && av.localKey && av.path.indexOf('images/') !== 0) {
    targets.push({ label: '头像 ' + c.profileFullName, file: path.join(attRoot, av.path), key: av.localKey, dbsize: av.size });
  }
}

const OUT = 'E:/WorkBuddy-Projects/wa-assistant/preview/signal_decrypt';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  for (const t of targets) {
    if (!fs.existsSync(t.file)) { console.log('文件不存在 ' + t.file); continue; }
    const buf = fs.readFileSync(t.file);
    const N = buf.length;
    const K = Buffer.from(t.key, 'base64');
    const aes = K.slice(0, 32);
    const mac = K.slice(32, 64);
    const iv = buf.slice(0, 16);
    console.log(`\n===== ${t.label} =====`);
    console.log(`  文件 ${N}B | DB 标称明文 ${t.dbsize}B | 差 ${N - 48 - t.dbsize}B`);

    for (const macLen of [32, 16, 0, 48]) {
      const ct = buf.slice(16, N - macLen);
      if (ct.length <= 0 || ct.length % 16 !== 0) { console.log(`  macLen=${macLen} 跳过（密文长度 ${ct.length} 不是 16 的倍数）`); continue; }
      for (const autoPad of [false, true]) {
        const out = dec(aes, iv, ct, autoPad);
        if (!out) { console.log(`  macLen=${macLen} autoPad=${autoPad} 解密失败`); continue; }
        const hasEoi = out.slice(-2).toString('hex') === 'ffd9';
        // 找 EOI 在尾部 40 字节内的位置
        let eoiAt = -1;
        for (let i = out.length - 2; i >= Math.max(0, out.length - 40); i -= 2) {
          if (out[i] === 0xFF && out[i + 1] === 0xD9) { eoiAt = i; break; }
        }
        let macOk = null;
        if (macLen === 32) {
          macOk = crypto.timingSafeEqual(buf.slice(N - 32), crypto.createHmac('sha256', mac).update(ct).digest());
        }
        let valid = '';
        try { const m = await sharp(out).metadata(); valid = `sharp可读 ${m.width}x${m.height} ${m.format}`; }
        catch (e) { valid = 'sharp读失败: ' + e.message.split('\n')[0].slice(0, 60); }
        const tag = hasEoi && eoiAt === out.length - 2 ? '✅尾标记正确' : (eoiAt >= 0 ? `EOI在尾部+${out.length - eoiAt - 2}` : '无EOI');
        console.log(`  macLen=${macLen} autoPad=${autoPad} → 明文 ${out.length}B 尾=${out.slice(-2).toString('hex')} MAC=${macOk} ${tag} | ${valid}`);
        if (hasEoi && eoiAt === out.length - 2) {
          const f = path.join(OUT, t.label.replace(/[^\w一-龥]+/g, '_') + '.jpg');
          fs.writeFileSync(f, out);
          console.log('    ✅ 完整可用，已存 ' + f);
        }
      }
    }
  }
  db.close();
})();
