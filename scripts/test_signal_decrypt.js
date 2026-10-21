/*
 * Signal 附件/头像解密验证（只读，2026-10-08）
 * 目的：确认 attachments.noindex 里的文件能否用 DB 里的 localKey 解出明文图片。
 *
 * ---- 文件布局（Signal Desktop Attachment.encryptedBytes，本机实测通过）----
 *   [0  ..16)  IV
 *   [16 ..48)  HMAC-SHA256(密文全部)
 *   [48 ..end) AES-256-CBC 密文
 *   localKey = base64(64 字节) = 前 32 字节 macKey + 后 32 字节 aesKey
 * ⚠️ 第一版我把 IV 漏了（前 32 当 MAC），MAC 全对不上 —— 布局不是 [MAC][密文]。
 *
 * 只写解密结果到 E:\WorkBuddy-Projects\wa-assistant\preview\signal_decrypt\，不碰 Signal 目录。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const signalStatus = require('../src/signalStatus');

const OUT = 'E:/WorkBuddy-Projects/wa-assistant/preview/signal_decrypt';
fs.mkdirSync(OUT, { recursive: true });

const IV_LEN = 16;
const MAC_LEN = 32;

function tryDecrypt(buf, keyB64, label, outName) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 64) return { ok: false, why: `key 长度 ${key.length} ≠ 64` };
  const macKey = key.slice(0, 32);
  const aesKey = key.slice(32, 64);

  if (buf.length < IV_LEN + MAC_LEN) return { ok: false, why: '文件太短' };
  const iv = buf.slice(0, IV_LEN);
  const mac = buf.slice(IV_LEN, IV_LEN + MAC_LEN);
  const cipher = buf.slice(IV_LEN + MAC_LEN);

  // 1) 校验 HMAC
  const calcMac = crypto.createHmac('sha256', macKey).update(cipher).digest();
  const macOk = crypto.timingSafeEqual(mac, calcMac);

  // 2) AES-256-CBC，去 PKCS#7 padding
  let plain = null, decErr = '';
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    d.setAutoPadding(false);
    const raw = Buffer.concat([d.update(cipher), d.final()]);
    const pad = raw[raw.length - 1];
    if (pad >= 1 && pad <= 16 && raw.slice(raw.length - pad).every(b => b === pad)) {
      plain = raw.slice(0, raw.length - pad);
    } else {
      plain = raw;
      decErr = `padding 异常(pad=${pad})`;
    }
  } catch (e) { decErr = e.message; }

  const isJpeg = plain && plain[0] === 0xFF && plain[1] === 0xD8;
  const isPng = plain && plain[0] === 0x89 && plain.slice(1, 4).toString() === 'PNG';
  let saved = '';
  if (plain && (isJpeg || isPng)) {
    const ext = isPng ? 'png' : 'jpg';
    const f = path.join(OUT, outName.replace(/\.jpg$/, '.' + ext));
    fs.writeFileSync(f, plain);
    saved = f + ` (${plain.length}B)`;
  }
  return {
    label, macOk, decErr, plainLen: plain ? plain.length : 0,
    head: plain ? plain.slice(0, 12).toString('hex') : '-',
    isJpeg, isPng, saved,
  };
}

const dataDir = path.join(process.env.APPDATA || '', 'Signal');
const attRoot = path.join(dataDir, 'attachments.noindex');
const db = signalStatus.openDb();

try {
  console.log('\n===== 附件解密验证 =====');
  const atts = db.prepare(`SELECT messageId, contentType, size, path, localKey, thumbnailPath, thumbnailLocalKey, messageType
                             FROM message_attachments ORDER BY sentAt DESC LIMIT 2`).all();
  for (const a of atts) {
    const f = path.join(attRoot, a.path);
    if (!fs.existsSync(f)) { console.log(`  原图不存在 ${a.path}`); continue; }
    const r = tryDecrypt(fs.readFileSync(f), a.localKey, `附件(${a.contentType}, ${a.size}B, msgType=${a.messageType})`, 'att_' + path.basename(a.path).slice(0, 12) + '.jpg');
    console.log('  ' + JSON.stringify(r));
    if (a.thumbnailPath) {
      const tf = path.join(attRoot, a.thumbnailPath);
      if (fs.existsSync(tf) && a.thumbnailLocalKey) {
        const r2 = tryDecrypt(fs.readFileSync(tf), a.thumbnailLocalKey, `缩略图(${a.thumbnailSize}B)`, 'thumb_' + path.basename(a.path).slice(0, 12) + '.jpg');
        console.log('  ' + JSON.stringify(r2));
      }
    }
  }

  console.log('\n===== 头像解密验证 =====');
  const convs = db.prepare('SELECT profileName, profileFullName, json FROM conversations WHERE serviceId <> ?').all(signalRead_OFFICIAL());
  function signalRead_OFFICIAL() { return '11111111-1111-4111-8111-111111111111'; }
  for (const c of convs) {
    let j; try { j = JSON.parse(c.json); } catch (e) { continue; }
    const av = j.profileAvatar;
    if (!av || !av.path || !av.localKey) { console.log(`  ${c.profileFullName} 无头像`); continue; }
    const f = path.join(attRoot, av.path);
    if (!fs.existsSync(f)) { console.log(`  ${c.profileFullName} 头像文件不存在 ${av.path}`); continue; }
    const r = tryDecrypt(fs.readFileSync(f), av.localKey, `头像 ${c.profileFullName} (${av.size}B)`, 'avatar_' + (c.profileFullName || 'x').replace(/\W+/g, '_') + '.jpg');
    console.log('  ' + JSON.stringify(r));
  }
} finally {
  try { db.close(); } catch (e) { /* 只读 */ }
}
