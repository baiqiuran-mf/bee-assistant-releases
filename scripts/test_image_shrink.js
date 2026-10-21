/**
 * imageShrink 压缩效果验证
 * 跑法：node scripts/test_image_shrink.js
 * ⚠️ 只用合成样本，不碰生产库、不碰 data/media/
 */
const sharp = require('sharp');
const shrink = require('../src/imageShrink');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'bee_shrink_test');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

/** 造一张高细节的"手机大图"，比纯色块更接近真实照片（纯色块压到 10KB 太容易了） */
async function makeBigPhoto(w, h, seed) {
  const noise = Buffer.alloc(w * h * 3);
  let x = seed >>> 0;
  for (let i = 0; i < noise.length; i++) {
    // xorshift 伪随机：噪声大 → JPEG 难压 → 才测得出真实上限
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    noise[i] = x & 0xff;
  }
  return sharp(noise, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

(async () => {
  console.log('sharp 可用:', shrink.available());
  console.log('目标体积:', shrink.TARGET_BYTES, 'bytes');
  console.log('');

  const cases = [
    { name: '手机竖拍大图 1200x1600', w: 1200, h: 1600, seed: 12345 },
    { name: '方形大图 2000x2000', w: 2000, h: 2000, seed: 999 },
    { name: '横图 1600x1200', w: 1600, h: 1200, seed: 424242 },
    { name: '小图 400x300', w: 400, h: 300, seed: 7 },
    { name: '极小图 100x100', w: 100, h: 100, seed: 8 },
  ];

  let pass = 0;
  let fail = 0;

  for (const c of cases) {
    const raw = await makeBigPhoto(c.w, c.h, c.seed);
    const out = path.join(TMP, `${c.w}x${c.h}.jpg`);
    const t = Date.now();
    const r = await shrink.shrinkToFile(raw, out);
    const ms = Date.now() - t;
    const ok = r && r.bytes <= shrink.TARGET_BYTES;
    if (ok) pass++; else fail++;
    console.log(
      `${ok ? '✅' : '❌'} ${c.name.padEnd(22)} 原图 ${String(raw.length).padStart(8)} B` +
      ` -> ${String(r ? r.bytes : 0).padStart(6)} B` +
      `  q=${r ? r.quality : '-'}  ${r ? r.width + 'x' + r.height : ''}` +
      `  ${ms}ms  命中=${r ? r.hit : 'N/A'}`
    );
  }

  console.log('');
  console.log(`通过 ${pass} / ${pass + fail}`);

  // --- 对照组：纯色块（最好压）和真图（最难压） ---
  console.log('');
  console.log('--- 对照：纯色块应该远小于 10KB ---');
  const flat = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg({ quality: 95 }).toBuffer();
  const rFlat = await shrink.shrinkToFile(flat, path.join(TMP, 'flat.jpg'));
  console.log(`  纯色块原图 ${flat.length} B -> ${rFlat.bytes} B (q=${rFlat.quality})  越小说明格式越省`);

  console.log('');
  console.log(`样本目录: ${TMP}`);
  if (fail > 0) {
    console.log('⚠️ 有样本压不到目标内，检查 MAX_EDGE / MIN_BYTES');
    process.exitCode = 1;
  }
})();
