/**
 * v2.6.1184 回归测试：WA①~⑤ 右栏「对话信息」里的媒体消息必须**直接出缩略图**。
 *
 * 老板实测（2026-10-21 截图）：红框里每条只显示「🖼 图片（base64 临时）· 看大图」一行文字，
 * 没有缩略图。DB 实证 body 是完整有效 JPEG（ffd8…ffd9），所以数据没问题，纯渲染层漏了 <img>。
 *
 * 本测试做两件事：
 *   A. 静态断言 public/app.js 里 renderConvInfo 的媒体分支确实生成了 <img class="conv-thumb" src="data:…">，
 *      且旧的「只给文字链接」文案 / 会隐藏图片的 onerror 已彻底移除。
 *   B. 动态验证：从生产库取真实媒体消息的 body，按 mediaDataUri 规则拼 data URI，
 *      用 sharp 解码，必须得到有效 JPEG 且宽高 > 0（证明浏览器 <img> 一定能渲染）。
 *
 * 只读运行：DB 以 readOnly 打开，绝不写。
 * 用法：node --experimental-sqlite test_conv_media_render.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = __dirname;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

(async () => {
  console.log('=== A. 静态断言：app.js 媒体渲染分支 ===');
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

  ok('renderConvInfo 每条消息生成 <img class="conv-thumb">',
    /class="conv-thumb" src="\$\{esc\(uri\.uri\)\}"/.test(appJs));

  ok('视频缩略图带「🎬 视频」角标',
    /conv-thumb-badge/.test(appJs) && /🎬 视频/.test(appJs));

  ok('旧的「🖼 图片（base64 临时）· 看大图」纯文字渲染已删除（注释里的说明不算）',
    !/🖼 图片（base64 临时）/.test(appJs));

  ok('不再用 onerror 把图片 display:none 隐藏（改为加 conv-thumb-bad 占位）',
    !/onerror="this\.style\.display='none'"/.test(appJs) && /conv-thumb-bad/.test(appJs));

  ok('语音 ptt 失败时给出「已收到这条语音」明确信号',
    /已收到这条语音/.test(appJs));

  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  ok('style.css 给 .tv-msg .conv-thumb 定了宽度（否则 img 按原图尺寸撑爆）',
    /\.tv-msg \.conv-thumb \{[^}]*width:\s*120px/.test(css));
  ok('style.css 有 .conv-thumb-bad 条纹占位',
    /\.conv-thumb-bad \{[^}]*repeating-linear-gradient/.test(css));

  console.log('\n=== B. 动态验证：真实 DB 媒体 body → data URI → JPEG ===');
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) {
    console.log('  SKIP  node:sqlite 不可用（需 --experimental-sqlite）');
  }
  if (DatabaseSync) {
    const dbPath = 'D:/蜜蜂采集数据/wa-assistant/data/assistant.db';
    if (!fs.existsSync(dbPath)) {
      console.log('  SKIP  生产库不在本机：' + dbPath);
    } else {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare(
          "SELECT id, body, media_type FROM messages WHERE lower(media_type) IN ('image','video','ptt') AND length(body) > 200 ORDER BY id DESC LIMIT 6"
        ).all();
        ok('库里能取到带 body 的媒体消息', rows.length > 0, 'rows=' + rows.length);
        for (const r of rows) {
          const body = String(r.body || '');
          let mime = 'image/jpeg';
          if (body.startsWith('iVBOR')) mime = 'image/png';
          else if (body.startsWith('R0lGOD')) mime = 'image/gif';
          else if (body.startsWith('UklGR')) mime = 'image/webp';
          const uri = 'data:' + mime + ';base64,' + body;
          const buf = Buffer.from(uri.split(',')[1], 'base64');
          let meta = null;
          try { meta = await sharp(buf).metadata(); } catch (_) { meta = null; }
          ok(`消息 #${r.id} (${r.media_type}) data URI 可解码为图片 ${meta ? meta.width + 'x' + meta.height : '解码失败'}`,
            !!meta && meta.width > 0 && meta.height > 0);
        }
      } finally { db.close(); }
    }
  }

  console.log('\n===== 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(fail ? 1 : 0);
})();
