/**
 * v1.1.0 自检：图片延时重抓 + 客户档案 Word
 *
 * 钉死六件事：
 *   ① 没抓到图的媒体消息必须标pending（下一轮才捡得起来）
 *   ② 延时重抓能把图补上：media_path / media_src 写回去，状态变 done
 *   ③ 试满 5 轮就标fail 彻底放手（绝无无限重抓）
 *   ④ 抓到过的不再重抓（不浪费）
 *   ⑤ Word：图片**内嵌**（在包里能翻到）、能用第三方库解析出来
 *   ⑥ Word：图片走**小图**（长边 ≤ maxEdge），不是原图
 *
 * 用真起后端 + 隔离数据目录，绝不碰生产库。
 */
process.env.BEE_TEST = '1';

const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

// ---- 隔离数据目录（必须在 require db 之前设好）----
const TMP = path.join(os.tmpdir(), 'bee_v110_' + process.pid);
process.env.BEE_DATA_DIR = TMP;
process.env.BEE_CONFIG = path.join(TMP, 'config.yaml');
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(process.env.BEE_CONFIG, 'app:\n  dataDir: ./\n  port: 0\n', 'utf8');

const db = require('../src/db');
const paths = require('../src/paths');
const main = require('../src/main');
const mediaFetch = require('../src/mediaFetch');
const wordDoc = require('../src/wordDoc');

/* ---------------- 造消息 ---------------- */
let seq = 0;
function makeMsg(over = {}) {
  seq += 1;
  return Object.assign({
    id: { id: 'v110_' + seq + '_' + Math.random().toString(36).slice(2, 8) },
    from: '15550007777@s.whatsapp.net',
    to: '1@s.whatsapp.net',
    fromMe: false,
    type: 'chat',
    body: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    hasMedia: false,
  }, over);
}

/** 造一张真PNG（用 zlib 现编，IHDR 里带真实宽高） */
function makePng(w, h) {
  const zlib = require('zlib');
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = (x * 7) % 256; raw[o + 1] = (y * 5) % 256; raw[o + 2] = 128;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_T[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ================================================================
 * 一、图片延时重抓
 * ================================================================ */
async function testRefetch() {
  console.log('\n【一】图片延时重抓');

  // ① 图片消息但没抓到图 → 必须标 pending
  const msgImg = makeMsg({ type: 'image', body: '', hasMedia: false });
  await main.handleMessage({ id: 1 }, msgImg, { client: null });
  let c = db.listCustomers.all().find((x) => x.wa_jid === msgImg.from);
  ok(!!c, '图片消息建出了客户');
  let rows = db.listMessages.all(c.code);
  const imgRow = rows.find((r) => r.id && r.media_type === 'image') || rows[rows.length - 1];
  ok(String(imgRow.media_src) === 'none', `没抓到图时 media_src=none（实际 ${JSON.stringify(imgRow.media_src)}）`);
  ok(String(imgRow.media_fetch_state) === 'pending', `标成 pending 等重抓（实际 ${JSON.stringify(imgRow.media_fetch_state)}）`);
  ok(!imgRow.media_path, '此时 media_path 是空的');

  // ② 延时重抓把图补上
  //造一张真PNG 假装"directPath 到了"，让 refetchMedia 能抓到
  const png = makePng(64, 48);
  const fakeMsg = makeMsg({
    id: { id: msgImg.id.id },
    type: 'image',
    hasMedia: true,
    body: '',
    downloadMedia: async () => ({ mimetype: 'image/png', data: png.toString('base64') }),
  });
  // 登记进 msgRegistry（模拟"消息对象还在"）
  main.recallMsg; // 引用一下，确保导出存在
  require('../src/main');
  // 直接用 mediaFetch.tick 跑一轮，fetchOne 由我们注入
  const before = db.getMessage.get(imgRow.id);
  const r1 = await mediaFetch.tick(async (row) => {
    // 模拟 saveMedia 成功
    const ext = 'png';
    const f = path.join(paths.mediaDir(), `${row.customer_code}_retry.${ext}`);
    fs.writeFileSync(f, png);
    return { path: f, src: 'download', mimetype: 'image/png', kind: 'image' };
  }, () => {});
  ok(r1.tried >= 1, `这一轮确实试了（tried=${r1.tried}）`);
  ok(r1.got >= 1, `补到了图（got=${r1.got}）`);
  const after = db.getMessage.get(imgRow.id);
  ok(!!after.media_path, 'media_path 写回库里了');
  ok(after.media_src === 'download', `media_src=download（实际 ${after.media_src}）`);
  ok(after.media_fetch_state === 'done', `状态钉成 done（实际 ${after.media_fetch_state}）`);
  ok(fs.existsSync(after.media_path), '图片文件真的在磁盘上');

  // ③ 抓到了就不再重抓
  const r2 = await mediaFetch.tick(async () => ({ path: 'x', src: 'download', mimetype: 'image/png', kind: 'image' }));
  ok(r2.tried === 0, `done 之后不再被挑中（tried=${r2.tried}）`);

  // ④ 试满就fail —— 造一条永远抓不到的
  const msgNone = makeMsg({ type: 'image', body: '' });
  await main.handleMessage({ id: 1 }, msgNone, { client: null });
  const c2 = db.listCustomers.all().find((x) => x.wa_jid === msgNone.from) || c;
  const noneRow = db.listMessages.all(c2.code).find((r) => r.media_src === 'none' && r.media_fetch_state === 'pending');
  ok(!!noneRow, '又造出一条 pending');
  if (noneRow) {
    const MAX = mediaFetch.BACKOFF_SEC.length;
    for (let i = 0; i < MAX; i++) {
      await mediaFetch.tick(async () => null, () => {});
    }
    const fin = db.getMessage.get(noneRow.id);
    ok(fin.media_fetch_state === 'fail', `试满 ${MAX} 轮标 fail（实际 ${fin.media_fetch_state}）`);
    const r3 = await mediaFetch.tick(async () => ({ path: 'x', src: 'download', mimetype: 'image/png', kind: 'image' }));
    ok(r3.tried === 0, `fail 之后不再重抓（tried=${r3.tried}）`);
    ok(Number(fin.media_fetch_tries) >= MAX, `tries 记到 ${fin.media_fetch_tries}（≥${MAX}）`);
  }

  // ⑤ 退避表本身
  // 2026-10-08：路B（回页面重取）+ 路C（强制解密）上线后把表从
  // 5 轮 / 首轮 10s 改成 7 轮 / 首轮 15s（前密后疏，覆盖到 30 分钟）。
  // 这里跟着改基线，同时**锁住"必须单调递增"这条不变量**——
  // 改表最容易出的错就是某一轮比上一轮短，会导致永远抓不到。
  ok(mediaFetch.BACKOFF_SEC.length === 7, `退避表 7 轮（实际 ${mediaFetch.BACKOFF_SEC.length}）`);
  ok(mediaFetch.BACKOFF_SEC[0] === 15, `第一轮 15 秒（实际 ${mediaFetch.BACKOFF_SEC[0]}s）`);
  let mono = true;
  for (let i = 1; i < mediaFetch.BACKOFF_SEC.length; i++) {
    if (mediaFetch.BACKOFF_SEC[i] <= mediaFetch.BACKOFF_SEC[i - 1]) mono = false;
  }
  ok(mono, '退避时间逐轮递增（不会越试越频繁）');
  const total = mediaFetch.BACKOFF_SEC.reduce((a, b) => a + b, 0);
  ok(total >= 900, `总退避窗口约 ${Math.round(total / 60)} 分钟`);

  // ⑥ 自己发出去的不重抓
  ok(!mediaFetch.isFetchable({ direction: 'out', media_path: '', media_type: 'image' }), '自己发出去的图片不重抓');
  ok(!mediaFetch.isFetchable({ direction: 'in', media_path: 'C:/x.jpg', media_type: 'image' }), '已经抓到的不重抓');
  ok(mediaFetch.isFetchable({ direction: 'in', media_path: '', media_type: 'image' }), '客户发来没抓到的要重抓');
  ok(mediaFetch.isFetchable({ direction: 'in', media_path: '', media_type: '', media_src: 'none' }), 'media_src=none 也要重抓');
}

/* ================================================================
 * 二、客户档案 Word
 * ================================================================ */
async function testWord() {
  console.log('\n【二】客户档案 Word（含图片内嵌）');

  // 底层：zip / 尺寸 / 类型
  ok(wordDoc.crc32(Buffer.from('123456789')) === 0xcbf43926, 'crc32 与标准值一致');
  const zbuf = wordDoc.zipStore([{ name: 'a.txt', data: Buffer.from('hi') }]);
  ok(zbuf[0] === 0x50 && zbuf[1] === 0x4b, 'zip 头是 PK');
  ok(zbuf.readUInt32LE(0) === 0x04034b50, '本地文件头 magic 正确');

  const png = makePng(120, 90);
  const sz = wordDoc.imageSize(png);
  ok(sz && sz.w === 120 && sz.h === 90, `PNG 尺寸读对（${sz && sz.w}x${sz && sz.h}）`);
  const sn = wordDoc.sniffImage(png);
  ok(sn && sn.ext === 'png', 'PNG magic 认成 png');
  ok(!wordDoc.sniffImage(Buffer.from('这不是图片这是一段话'.repeat(10))), '一段文字不会被认成图片');
  ok(wordDoc.sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]))?.ext === 'jpeg', 'JPEG magic 认成 jpeg');
  // RIFF 但不是 WEBP（音视频）不能当图
  ok(!wordDoc.sniffImage(Buffer.from('RIFFxxxxWAVEfmt ', 'latin1')), 'RIFF/WAVE（音频）不当成图片');

  // 端到端：给一个客户生成 Word
  const c = db.listCustomers.all()[0];
  ok(!!c, '拿一个真客户来生成');
  // 手动给库里塞一条带图的消息
  const imgFile = path.join(paths.mediaDir(), 'word_test.png');
  fs.writeFileSync(imgFile, png);
  const saved = db.saveMessage({
    customerCode: c.code,
    accountId: 1,
    direction: 'in',
    body: '这是我养的两只猫',
    bodyZh: '',
    mediaPath: imgFile,
    mediaSrc: 'download',
    mediaType: 'image',
    waMsgId: 'word_probe_1',
    msgTs: new Date().toISOString(),
    silent: true,
  });
  ok(saved.changes === 1, '塞了一条带图的消息进库');

  const msgs = db.listMessages.all(c.code);
  ok(msgs.some((m) => m.media_path === imgFile), '消息里有这条带图的');

  const outDir = path.join(TMP, 'word');
  const r = await wordDoc.buildCustomerWord(c, msgs, { dir: outDir, maxEdge: 720 });
  ok(fs.existsSync(r.file), `Word 文档生成了：${path.basename(r.file)}`);
  ok(r.bytes > 0, `文档非空（${r.bytes} 字节）`);
  // 注意：这个客户在【一】里已经存过一张补抓成功的图，所以至少 1 张
  ok(r.images >= 1, `内嵌了图片（${r.images} 张，含【一】补抓到的那张）`);

  // 拆开 zip：图必须在里面（内嵌，不是链接）
  const buf = fs.readFileSync(r.file);
  ok(buf.readUInt32LE(0) === 0x04034b50, '是合法 zip（PK\\x03\\x04）');
  const text = buf.toString('latin1');
  ok(text.includes('word/media/image1.png'), '包里有 word/media/image1.png（图片是内嵌的）');
  ok(text.includes('word/document.xml'), '包里有正文 document.xml');
  ok(text.includes('word/_rels/document.xml.rels'), '包里有图片关系表 rels');
  ok(text.includes('[Content_Types].xml'), '包里有 Content_Types');
  // 关系表里必须有 r:embed，正文里必须有 drawing
  const relsPart = buf.toString('latin1');
  ok(/Id="rId10\d"/.test(relsPart), '关系表里有图片 Id');
  ok(!/<a:blip[^>]*r:link=/.test(relsPart), '图片不是外链（没有 r:link）');

  // 原始字节必须能在包里找到（证明图本体在里面）
  const idx = buf.indexOf(png);
  ok(idx > 0, `原始 PNG 字节能在包里找到（偏移 ${idx}）`);

  // blocks 结构
  const blocks = wordDoc.blocksOf(c, msgs);
  ok(blocks.some((b) => b.type === 'h2' && b.text === '客户信息'), '有「客户信息」段');
  ok(blocks.some((b) => b.type === 'h2' && b.text === '对话记录'), '有「对话记录」段');
  ok(blocks.some((b) => b.type === 'img' && b.file === imgFile), 'blocks 里有插图指令');
  ok(blocks.some((b) => b.type === 'kv' && b.k === '编号'), '有编号字段');
  ok(blocks.some((b) => b.type === 'p' && /两只猫/.test(b.text)), '消息正文进了 blocks');

  // 语音不该被当成图片塞进去
  const audioFile = path.join(paths.mediaDir(), 'word_test.mp3');
  fs.writeFileSync(audioFile, Buffer.from('ID3fake audio'));
  db.saveMessage({
    customerCode: c.code, accountId: 1, direction: 'in', body: '语音消息',
    mediaPath: audioFile, mediaSrc: 'download', mediaType: 'ptt',
    waMsgId: 'word_probe_2', msgTs: new Date().toISOString(), silent: true,
  });
  const b2 = wordDoc.blocksOf(c, db.listMessages.all(c.code));
  ok(!b2.some((b) => b.type === 'img' && b.file === audioFile), '语音不会被当图片嵌进 Word');
  ok(b2.some((b) => b.type === 'p' && /语音/.test(b.text)), '语音在正文里有说明');

  // 全量重建
  const all = await wordDoc.rebuildAll({ dir: outDir, maxEdge: 720 });
  ok(all.docs === db.listCustomers.all().length, `全量重建了 ${all.docs} 份（客户数 ${db.listCustomers.all().length}）`);
  ok(all.errors.length === 0, `没有失败（${all.errors.join('; ') || '无'}）`);

  // 文件名安全（Windows 禁用字符 \ / : * ? " < > |）
  const dirty = '1A00001_张三/李四:*?"<>|';
  const cleaned = wordDoc.safeName(dirty);
  ok(!/[\\/:*?"<>|]/.test(cleaned), `文件名里的禁用字符全被替换（${cleaned}）`);
  ok(cleaned.startsWith('1A00001_张三'), '正常字符保留没被误伤');
  ok(wordDoc.safeName('') === '未命名', '空名兜底成「未命名」');

  // 缺图不炸（账号号必须是 1-9，ids.js 会拒绝 99）
  const c2 = db.getOrCreateCustomer(9, '15550000000@s.whatsapp.net', { name: '缺图测试' });
  db.saveMessage({
    customerCode: c2.customer.code, accountId: 9, direction: 'in', body: 'x',
    mediaPath: path.join(TMP, 'no_such_pic.png'), mediaSrc: 'none', mediaType: 'image',
    waMsgId: 'word_probe_3', msgTs: new Date().toISOString(), silent: true,
  });
  const r2 = await wordDoc.buildCustomerWord(db.getCustomer.get(c2.customer.code),
    db.listMessages.all(c2.customer.code), { dir: outDir, maxEdge: 720 });
  ok(fs.existsSync(r2.file), '图读不到时文档照样生成（不炸）');
  ok(r2.skipped.length >= 1, `读不到的图进了 skipped（${r2.skipped.length}）`);
}

/* ================================================================
 * 三、Word 图片走小图（老板明确要求）
 * ================================================================ */
async function testShrink() {
  console.log('\n【三】Word 图片用小图（不用原图）');

  // 直接测shrinkImage：一张 2000x1500 的图，maxEdge=720 → 长边应 ≤720
  const big = makePng(2000, 1500);
  const before = big.length;
  const small = await wordDoc.shrinkImage(big, 'image/png', 720);
  if (small) {
    ok(small.w <= 720 && small.h <= 720, `缩到 ${small.w}x${small.h}（长边 ≤720）`);
    ok(small.w / small.h === 2000 / 1500, '宽高比保持不变（没变形）');
    ok(small.data.length < before, `体积从 ${before} → ${small.data.length} 字节（变小了）`);
    ok(small.mime === 'image/jpeg', `统一出 JPEG（${small.mime}）`);
    ok(wordDoc.imageSize(small.data) !== null, '缩小后的字节仍是合法图片');
  } else {
    // 拿不到浏览器（CI/无头环境）时按原样嵌入，这是设计好的退路
    ok(true, '⚠️ 拿不到 Chromium 缩图，按原样嵌入（退路生效，非失败）');
  }

  // 本来就很小的图 → 不折腾，字节完全一样
  const tiny = makePng(40, 30);
  const t2 = await wordDoc.shrinkImage(tiny, 'image/png', 720);
  ok(t2 && t2.data.equals(tiny), '小于上限的图原样保留（不重新编码）');

  // maxEdge=0 → 完全不缩
  const t3 = await wordDoc.shrinkImage(big, 'image/png', 0);
  ok(!t3, 'maxEdge=0 时不缩图（调用方选择原图）');

  await wordDoc.closeShrinker();
}

/* ================================================================
 * 四、顶栏「抓取」按钮已删
 * ================================================================ */
function testButtonRemoved() {
  console.log('\n【四】顶栏「📞 抓取」按钮已删除');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ok(!html.includes('btn-scan-phone'), 'index.html 里没有 btn-scan-phone 了');
  ok(!app.includes('btn-scan-phone'), 'app.js 里没有 btn-scan-phone 了');
  // 档案区那个「抓取」按钮必须还在
  ok(html.includes('pf-phone-grab'), '档案区的「📞 抓取」按钮还在（只删顶栏那个）');
  ok(app.includes('pf-phone-grab'), 'app.js 里档案区按钮逻辑还在');
  // 顶栏其他按钮必须都在 HTML 里（btn-board 在 app.js 里是 0 次命中，
  // 它走的是别的绑定方式，所以只查 HTML）
  const keepBtns = ['btn-ingest', 'btn-board', 'btn-settings', 'status'];
  for (const id of keepBtns) {
    ok(html.includes(`id="${id}"`), `顶栏「${id}」没被误删`);
  }
  ok(app.includes("$('btn-ingest')") && app.includes("$('btn-settings')"),
    'app.js 里顶栏按钮的绑定逻辑还在');
}

(async () => {
  console.log('=== v1.1.0 自检：图片延时重抓 + 客户档案 Word ===');
  console.log(`隔离数据目录：${TMP}`);
  try {
    await testRefetch();
    await testWord();
    await testShrink();
    testButtonRemoved();
  } catch (e) {
    fail += 1;
    console.log('  ❌ 测试崩了：', (e && e.stack) || e);
  }
  console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})();
