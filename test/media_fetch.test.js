/**
 * 图片抓取回归自检（2026-10-07）
 *
 * 钉死三件事：
 *   ① 裸base64（**没有 data: 前缀**）必须能抓成图片 —— 生产库第19 条就是这个形态，
 *      旧版正则硬要求 data: 前缀，整张图被漏掉。
 *   ② 真人打的字/ 订单号 / tracking id **绝不能**被当成图片（magic 字节闸）。
 *   ③ 贴纸和图片要分得开（media_type 入库），贴纸不再被当成图片。
 *
 * 用真起后端 + 隔离数据目录，绝不碰生产库。
 */
process.env.BEE_TEST = '1';

const fs = require('fs');
const path = require('path');

// 🔴 2026-10-07 补：隔离数据目录。
// 这个文件历史上只设了 BEE_TEST 却没设 BEE_DATA_DIR，直接用生产库跑，
// 于是每次跑都在真 data/assistant.db 里留下 x开头的假 wa_msg_id 和
// 1A00022 假客户（连同 media/ 里的假图），害得老板以为「客户发图显示不出来」。
const { DIR } = require('./_isolate.js');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

// ---- 真图样本 ----
// ① 1x1 PNG（带 data: 前缀的老形态）
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// ② 真实那张 75×100 JPEG 的 base64（从生产库第 19 条原样导出，**没有 data: 前缀**）。
//    这是本测试最核心的样本 —— 旧版正则硬要求 data: 前缀，整张图被漏掉。
//    tools/_cache_probe/real_b64.txt 由tools/probe_msg_image.js 从生产库导出。
const REAL_JPEG_B64 = fs.readFileSync(
  path.join(__dirname, '..', 'tools', '_cache_probe', 'real_b64.txt'), 'utf8',
).trim();

const main = require('../src/main');
const db = require('../src/db');
const paths = require('../src/paths');

function makeMsg(over) {
  return Object.assign({
    id: { id: 'x' + Math.random().toString(36).slice(2, 9) },
    from: '15550009999@s.whatsapp.net',
    to: '1@s.whatsapp.net',
    fromMe: false,
    type: 'chat',
    timestamp: Math.floor(Date.now() / 1000),
    hasMedia: false,
  }, over);
}

async function send(body, type, extra) {
  const msg = makeMsg(Object.assign({ body, type: type || 'chat' }, extra || {}));
  await main.handleMessage({ id: 1 }, msg, { client: null });
  const c = db.listCustomers.all().find((x) => x.wa_jid === msg.from);
  if (!c) return null;
  const rows = db.listMessages.all(c.code);
  return rows[rows.length - 1];
}

(async () => {
  const MEDIA = paths.mediaDir();
  console.log('媒体目录:', MEDIA);

  // ================= ① 裸 base64（无 data: 前缀）必须抓到 =================
  console.log(`\n[1] 裸 base64（生产库第19条原样导出，无 data: 前缀，${REAL_JPEG_B64.length} 字符）`);
  {
    const row = await send(REAL_JPEG_B64, 'image');
    ok(!!row, '消息入库了');
    ok(!!row.media_path, `media_path 有值（${row.media_path ? path.basename(row.media_path) : '空'}）`);
    ok(row.media_src === 'base64', `media_src = ${row.media_src}（期望 base64）`);
    if (row.media_path) {
      ok(fs.existsSync(row.media_path), '文件真的落在磁盘上');
      const buf = fs.readFileSync(row.media_path);
      ok(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff, `magic = ${buf.slice(0, 4).toString('hex')}（期望 ffd8ff..）`);
      ok(buf.length === 5274, `文件大小 ${buf.length} 字节（期望 5274，和原始一字节不差）`);
      // 界面上显示的就是这张图 —— 尺寸得对
      let i = 2; let dim = '';
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const mk = buf[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
          dim = `${buf.readUInt16BE(i + 7)}x${buf.readUInt16BE(i + 5)}`; break;
        }
        const seg = buf.readUInt16BE(i + 2);
        if (!seg || seg < 2) break;
        i += 2 + seg;
      }
      ok(dim === '75x100', `图片尺寸 ${dim}（期望 75x100，和你看到的那张一致）`);
      ok(/\.jpg$/.test(row.media_path), '扩展名 .jpg（magic 反推出来的，不是猜的）');
    }
    ok(row.body === '[图片]', `正文是占位符不是乱码（实际：${JSON.stringify(row.body)}）`);
    ok(String(row.body || '').indexOf('/9j/4AAQ') < 0, 'base64 原文没留在正文里');
  }

  // ================= ② 带 data: 前缀的老路不能退化 =================
  console.log('\n[2] 带 data: 前缀（v1.0.10 已支持的形态）');
  {
    const row = await send('data:image/png;base64,' + PNG_1PX, 'image');
    ok(row.media_src === 'base64', `media_src = ${row.media_src}`);
    ok(!!row.media_path, `media_path 有值（${row.media_path ? path.basename(row.media_path) : '空'}）`);
    if (row.media_path) ok(/\.png$/.test(row.media_path), '扩展名 .png');
  }

  // ================= ③ 真人文字绝不能被当成图片 =================
  console.log('\n[3] 真人文字 / 订单号 / tracking（magic 闸）');
  {
    const cases = [
      ['orderAB1234567890XYZ', '纯字母数字订单号'],
      ['1234567890123456789012345', '25位纯数字（像 base64 但不是图）'],
      ['TRACKING1234567890123', '物流单号'],
      ['hello how are you today', '带空格的普通句子'],
      ['zzzzzzzzzzzzzzzzzzzzzzzz', '全 z（解出来是垃圾字节）'],
      ['44445555666677778888', '全4/6/7/8（解出来不是图）'],
    ];
    for (const [body, label] of cases) {
      const row = await send(body, 'chat');
      const got = !!row.media_path;
      ok(!got, `${label} 没被误当成图片（media_path=${got ? '有！' : '空'}）`);
      ok(row.body === body, `${label} 正文原样保留`);
    }
  }

  // ================= ④ 贴纸 vs 图片要分得开 =================
  console.log('\n[4] 贴纸 / 图片 的真实身份要分开记');
  {
    const st = await send('data:image/png;base64,' + PNG_1PX, 'sticker');
    ok(st.media_type === 'sticker', `贴纸的 media_type = ${JSON.stringify(st.media_type)}（期望 sticker，不会被当成 image）`);

    const im = await send('data:image/png;base64,' + PNG_1PX, 'image');
    ok(im.media_type === 'image', `图片的 media_type = ${JSON.stringify(im.media_type)}`);
  }

  // ================= ⑤ 没抓到时仍要留占位、不留空白 =================
  console.log('\n[5] 抓不到时也不能静默');
  {
    // ⚠️ 必须用「纯图片消息」（正文为空）：客户如果连着一句真话一起发，
    //   那句话是有效内容，必须原样保留 —— 不能为了放占位符把人家的话吃掉。
    const row = await send('', 'image');
    ok(row.body === '[图片]', `正文占位符正确（${JSON.stringify(row.body)}）`);
    ok(row.media_src === 'none', `media_src = ${row.media_src}（期望 none，界面据此显示"没能抓下来"）`);
    ok(!row.media_path, 'media_path 为空');
    ok(row.media_type === 'image', `media_type 仍记下真实身份 = ${row.media_type}`);

    // 反过来：真话必须保住
    const withText = await send('给我看看那张图', 'image');
    ok(withText.body === '给我看看那张图', `带文字的图片消息，文字原样保留（${JSON.stringify(withText.body)}）`);
  }

  console.log(`\n=== ${fail === 0 ? '通过' : '失败'}：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('崩溃：', e); process.exit(1); });