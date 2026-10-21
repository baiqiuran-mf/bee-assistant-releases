/**
 * mediaRaw（B 路 + C 路）逻辑测试
 * 跑法：node scripts/test_media_raw.js
 *
 * ⚠️ 用假的 client / pupPage 模拟，**不启动浏览器、不碰生产库**。
 * 真实环境的 pupPage.evaluate 在这里被替换成可控的假实现，
 * 用来验证：字段传递对不对、异常吞不吞、有没有该退不退。
 */

const assert = require('assert');
const mediaRaw = require('../src/mediaRaw');
const shrink = require('../src/imageShrink');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'bee_mediaraw_test');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`✅ ${name}`); pass++; })
    .catch((e) => { console.log(`❌ ${name}\n   ${e.message}`); fail++; });
}

/** 造一个假的 client：evaluate 按 fn 里的行为返回预设结果 */
function fakeClient(handler) {
  return { pupPage: { evaluate: handler } };
}

(async () => {
  console.log('=== mediaRaw 逻辑测试 ===');
  console.log('');

  await check('client 缺失时 refetchFullMessage 返回 null（不抛）', async () => {
    const r = await mediaRaw.refetchFullMessage(null, 'abc');
    assert.strictEqual(r, null);
  });

  await check('client 缺失时 fetchRawImage 返回 null（不抛）', async () => {
    const r = await mediaRaw.fetchRawImage(null, 'abc', 'C1', TMP, 'image');
    assert.strictEqual(r, null);
  });

  await check('页面脚本抛异常时被吞成 null', async () => {
    const bad = fakeClient(() => { throw new Error('page crashed'); });
    const r = await mediaRaw.refetchFullMessage(bad, 'abc');
    assert.strictEqual(r, null);
  });

  await check('msgId 为空时返回 null', async () => {
    const r = await mediaRaw.refetchFullMessage(fakeClient(() => ({})), '');
    assert.strictEqual(r, null);
  });

  await check('路B：拿到的对象字段齐全（含 directPath/mediaKey/mediaStage）', async () => {
    const full = {
      id: 'x@c.us_1', type: 'image', directPath: '/v/t62',
      encFilehash: 'eh', filehash: 'fh', mediaKey: 'mk', mediaKeyTimestamp: 123,
      mimetype: 'image/jpeg', filename: 'f.jpg', size: 999,
      mediaStage: 'RESOLVED', body: null,
    };
    // 模拟页面脚本：直接返回 full
    const c = fakeClient(async () => full);
    const r = await mediaRaw.refetchFullMessage(c, 'x@c.us_1');
    assert.ok(r, '应该拿到对象');
    assert.strictEqual(r.directPath, '/v/t62');
    assert.strictEqual(r.mediaKey, 'mk');
    assert.strictEqual(r.mediaStage, 'RESOLVED');
  });

  await check('路B：directPath 缺失 → fetchRawImage 返回 null（交下一轮）', async () => {
    const c = fakeClient(async () => ({ id: 'x', type: 'image', directPath: null }));
    const r = await mediaRaw.fetchRawImage(c, 'x', 'C1', TMP, 'image');
    assert.strictEqual(r, null);
  });

  await check('路C：媒体过期(REUPLOADING) → 返回 null 且不写文件', async () => {
    const before = fs.readdirSync(TMP).length;
    const c = fakeClient(async (fn, arg) => {
      if (typeof arg === 'object' && arg.id) {
        return { id: arg.id, type: 'image', directPath: '/v/t62', mediaKey: 'mk' };
      }
      return { expired: true };
    });
    // 第一次 evaluate 取 full，第二次取 dl
    let call = 0;
    const c2 = {
      pupPage: {
        evaluate: async (fn, arg) => {
          call++;
          if (call === 1) return { id: 'x', type: 'image', directPath: '/v/t62', mediaKey: 'mk' };
          return { expired: true };
        },
      },
    };
    const r = await mediaRaw.fetchRawImage(c2, 'x', 'C1', TMP, 'image');
    assert.strictEqual(r, null);
    assert.strictEqual(fs.readdirSync(TMP).length, before, '不该写出文件');
  });

  await check('路C：图片走压缩，产物 <= 10KB', async () => {
    // 造一张 1.9MB 的高细节大图当"客户发来的原图"
    const sharp = require('sharp');
    const W = 1200, H = 1600;
    const noise = Buffer.alloc(W * H * 3);
    let s = 1234567;
    for (let i = 0; i < noise.length; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      noise[i] = s & 0xff;
    }
    const bigJpg = await sharp(noise, { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 95 }).toBuffer();
    assert.ok(bigJpg.length > 500 * 1024, '样本原图应该 >500KB');

    const b64 = bigJpg.toString('base64');
    let call = 0;
    const c = {
      pupPage: {
        evaluate: async (fn, arg) => {
          call++;
          if (call === 1) {
            return { id: 'x', type: 'image', directPath: '/v/t62', mediaKey: 'mk', mediaStage: 'FETCHING' };
          }
          return { data: b64, mimetype: 'image/jpeg', filename: 'p.jpg' };
        },
      },
    };
    const r = await mediaRaw.fetchRawImage(c, 'x', 'C1', TMP, 'image');
    assert.ok(r, '应该拿到图');
    assert.strictEqual(r.src, 'download');
    assert.ok(fs.existsSync(r.path), '文件应该落盘');
    const outSize = fs.statSync(r.path).size;
    assert.ok(outSize <= shrink.TARGET_BYTES, `压缩后 ${outSize} 应 <= ${shrink.TARGET_BYTES}`);
    console.log(`   （原图 ${bigJpg.length} B → 压缩 ${outSize} B）`);
  });

  await check('非图片类型（video）不走压缩，原样落盘', async () => {
    const smallBuf = Buffer.alloc(50000, 7); // 假视频字节
    const b64 = smallBuf.toString('base64');
    let call = 0;
    const c = {
      pupPage: {
        evaluate: async (fn, arg) => {
          call++;
          if (call === 1) return { id: 'v', type: 'video', directPath: '/v/t62', mediaKey: 'mk' };
          return { data: b64, mimetype: 'video/mp4' };
        },
      },
    };
    const r = await mediaRaw.fetchRawImage(c, 'v', 'C1', TMP, 'video');
    assert.ok(r, '应该拿到文件');
    assert.strictEqual(fs.statSync(r.path).size, 50000, '视频不该被压缩');
    assert.ok(r.path.endsWith('.mp4'), '视频应保持 mp4');
  });

  await check('C 路返回空 data → 返回 null，不写坏文件', async () => {
    let call = 0;
    const c = {
      pupPage: {
        evaluate: async () => {
          call++;
          if (call === 1) return { id: 'x', type: 'image', directPath: '/v/t62', mediaKey: 'mk' };
          return { data: '', mimetype: 'image/jpeg' };
        },
      },
    };
    const r = await mediaRaw.fetchRawImage(c, 'x', 'C1', TMP, 'image');
    assert.strictEqual(r, null);
  });

  await check('C 路返回 error 对象 → 返回 null', async () => {
    let call = 0;
    const c = {
      pupPage: {
        evaluate: async () => {
          call++;
          if (call === 1) return { id: 'x', type: 'image', directPath: '/v/t62', mediaKey: 'mk' };
          return { error: 'boom' };
        },
      },
    };
    const r = await mediaRaw.fetchRawImage(c, 'x', 'C1', TMP, 'image');
    assert.strictEqual(r, null);
  });

  console.log('');
  console.log(`通过 ${pass} / ${pass + fail}`);
  if (fail > 0) process.exitCode = 1;
})();
