/*
 * 附件诊断（只读，2026-10-08）
 * 用法：node scripts/dump_signal_attach.js
 */
const path = require('path');
const fs = require('fs');
const signalStatus = require('../src/signalStatus');
function hr(t) { console.log('\n===== ' + t + ' ====='); }

const dataDir = path.join(process.env.APPDATA || '', 'Signal');
console.log('Signal 数据目录 =', dataDir, '| 存在 =', fs.existsSync(dataDir));

const db = signalStatus.openDb();
try {
  hr('message_attachments 全部 5 行（关键字段）');
  const rows = db.prepare(`
    SELECT messageId, conversationId, sentAt, attachmentType, contentType, size,
           path, fileName, width, height, digest, localKey, downloadPath,
           thumbnailPath, thumbnailSize, receivedAt, messageType, flags
      FROM message_attachments ORDER BY sentAt DESC`).all();
  for (const r of rows) {
    console.log('  ' + JSON.stringify({
      type: r.attachmentType, msgType: r.messageType, contentType: r.contentType,
      size: r.size, w: r.width, h: r.height, fileName: r.fileName,
      path: r.path, downloadPath: r.downloadPath, thumb: r.thumbnailPath, thumbSize: r.thumbnailSize,
      digest: r.digest, localKey: r.localKey, flags: r.flags,
      sentAt: new Date(Number(r.sentAt)).toLocaleString('zh-CN'),
    }));
  }

  hr('这些附件所属消息的正文');
  for (const r of rows) {
    const m = db.prepare('SELECT id, type, body, hasAttachments, sent_at FROM messages WHERE id = ?').get(r.messageId);
    if (!m) { console.log(`  附件 ${r.messageId} 找不到对应消息`); continue; }
    console.log(`  [${new Date(Number(m.sent_at)).toLocaleString('zh-CN')}] type=${m.type} body=${JSON.stringify(m.body)} attach=${m.hasAttachments} attType=${r.attachmentType}`);
  }

  hr('落盘文件是否存在（按 path / downloadPath / thumbnailPath 三处试）');
  // 🔴 实测目录名是 attachments.noindex（不是 attachments），Signal 8.x 加了 .noindex 后缀
  const roots = [path.join(dataDir, 'attachments.noindex'), path.join(dataDir, 'attachments'), dataDir];
  for (const r of rows) {
    for (const p of [r.path, r.downloadPath, r.thumbnailPath]) {
      if (!p) continue;
      const hits = [];
      for (const root of roots) {
        const full = path.join(root, p);
        if (fs.existsSync(full)) hits.push(`${full} (${fs.statSync(full).size}B)`);
      }
      console.log(`  ${p}  → ${hits.length ? hits.join(' | ') : '三处都找不到'}`);
    }
  }

  hr('attachments.noindex 实际内容（前两层）');
  for (const root of roots) {
    if (!fs.existsSync(root)) { console.log('  不存在：' + root); continue; }
    console.log('  【' + root + '】');
    let cnt = 0;
    for (const d1 of fs.readdirSync(root)) {
      if (cnt++ > 12) { console.log('  ...'); break; }
      const p1 = path.join(root, d1);
      if (!fs.statSync(p1).isDirectory()) { console.log('    文件 ' + d1 + ' size=' + fs.statSync(p1).size); continue; }
      const inner = fs.readdirSync(p1);
      let detail = '';
      for (const f of inner.slice(0, 4)) {
        const pf = path.join(p1, f);
        detail += ` [${f} ${fs.statSync(pf).isDirectory() ? 'dir' : fs.statSync(pf).size + 'B'}]`;
      }
      console.log('    目录 ' + d1 + '/ → ' + inner.length + ' 项:' + detail);
    }
  }
} finally {
  try { db.close(); } catch (e) { /* 只读 */ }
}
