/*
 * 最终确认：明文边界怎么切（只读，2026-10-08）
 * 已确认：布局 = [16B IV][AES-256-CBC 密文][MAC]，AES key = localKey[0:32]，不用去 padding。
 * 待定：解密后尾部有冗余字节，用什么规则切出干净图片。
 *   假设1：直接按 DB 的 size 截断
 *   假设2：扫到最后一个 ffd9(EOI) 就切
 *   假设3：扫到 ffd9 后再看是否连续
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const signalStatus = require('../src/signalStatus');

const attRoot = path.join(process.env.APPDATA || '', 'Signal', 'attachments.noindex');
const db = signalStatus.openDb();
const OUT = 'E:/WorkBuddy-Projects/wa-assistant/preview/signal_decrypt';
fs.mkdirSync(OUT, { recursive: true });

function dec(key, iv, ct) {
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** 返回最后一个 ffd9 的结束位置（找不到返回 -1） */
function lastEoiEnd(buf) {
  for (let i = buf.length - 2; i >= 1; i--) {
    if (buf[i - 1] === 0xFF && buf[i] === 0xD9) return i + 1;
  }
  return -1;
}

(async () => {
  const targets = [];
  const a1 = db.prepare('SELECT path, localKey, contentType, size FROM message_attachments WHERE messageType = ? ORDER BY sentAt DESC LIMIT 2').all('story');
  for (const a of a1) targets.push({ label: '故事图' + a.size, file: path.join(attRoot, a.path), key: a.localKey, dbsize: a.size });
  for (const c of db.prepare('SELECT profileFullName, json FROM conversations WHERE json LIKE ?').all('%profileAvatar%')) {
    let j; try { j = JSON.parse(c.json); } catch (e) { continue; }
    const av = j.profileAvatar;
    if (av && av.path && av.localKey && av.path.indexOf('images/') !== 0) {
      targets.push({ label: '头像' + c.profileFullName, file: path.join(attRoot, av.path), key: av.localKey, dbsize: av.size });
    }
  }

  for (const t of targets) {
    if (!fs.existsSync(t.file)) { console.log('不存在 ' + t.file); continue; }
    const buf = fs.readFileSync(t.file);
    const K = Buffer.from(t.key, 'base64');
    const plain = dec(K.slice(0, 32), buf.slice(0, 16), buf.slice(16, buf.length - 32));

    const bySize = plain.slice(0, t.dbsize);
    const eoiEnd = lastEoiEnd(plain);
    const byEoi = eoiEnd > 0 ? plain.slice(0, eoiEnd) : null;

    console.log(`\n===== ${t.label} =====`);
    console.log(`  解密明文 ${plain.length}B | DB size ${t.dbsize}B | 末个EOI结束于 ${eoiEnd}`);
    console.log(`  按 size 截断 → 尾 ${bySize.slice(-2).toString('hex')}  差 ${plain.length - t.dbsize}B`);
    if (byEoi) console.log(`  按 EOI  截断 → 长度 ${byEoi.length}B  尾 ${byEoi.slice(-2).toString('hex')}`);

    for (const [name, cand] of [['按size', bySize], ['按EOI', byEoi]]) {
      if (!cand) continue;
      try {
        const m = await sharp(cand).metadata();
        // 再做一次真实像素解码，确认没有截断错误
        const { data, info } = await sharp(cand).resize(64, 64).raw().toBuffer({ resolveWithObject: true });
        let sum = 0; for (const b of data) sum += b;
        console.log(`    ✅ ${name}: ${m.width}x${m.height} ${m.format} | 缩略解码成功 ${info.width}x${info.height} 像素和=${sum}`);
      } catch (e) {
        console.log(`    ❌ ${name}: ${e.message.split('\n')[0].slice(0, 70)}`);
      }
    }

    // 最终采用 EOI 规则落盘（尾标记完整最安全），命名带尺寸便于识别
    if (byEoi) {
      const m0 = await sharp(byEoi).metadata().catch(() => null);
      const f = path.join(OUT, `${t.label}_${m0 ? m0.width + 'x' + m0.height : 'x'}.jpg`);
      fs.writeFileSync(f, byEoi);
      console.log('    → 已存 ' + f);
    }
  }
  db.close();
})();
