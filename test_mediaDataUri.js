// 实证：从 app.js 抽取真实 mediaDataUri / isBase64Garbage 源码，跑断言。
// 验证「把 base64 乱码解析成图片/视频/语音缩略图」的算法在真数据上正确。
const fs = require('fs');
const src = fs.readFileSync('public/app.js', 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到 ' + name);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}

const isBase64Garbage = eval('(' + extract('isBase64Garbage') + ')');
const mediaDataUri = eval('(' + extract('mediaDataUri') + ')');

// 用任意可见字符凑一段 >200 的 base64 串（不含真实图片，仅验证分支与返回形状）
const b64 = 'A'.repeat(300);
// 真实魔数片段（仅头部即可触发 sniff）
const JFIF = '/9j/' + b64;        // JPEG 图片
const PNG  = 'iVBOR' + b64;       // PNG
const GIF  = 'R0lGOD' + b64;      // GIF
const WEBP = 'UklGR' + b64;       // WebP

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('PASS:', msg); }

// 1) 真·正文（短，非 base64 垃圾）→ 不应渲染
assert(isBase64Garbage('Hello, this is a normal message') === false, '普通正文不触发 base64 渲染');
assert(mediaDataUri({ body: 'Hello, this is a normal message' }) === null, '普通正文返回 null（不当乱码渲染）');

// 2) 图片魔数 → render='image'
assert(mediaDataUri({ body: JFIF }).render === 'image', '/9j/ → image');
assert(mediaDataUri({ body: PNG }).render === 'image', 'iVBOR → image (png)');
assert(mediaDataUri({ body: GIF }).render === 'image', 'R0lGOD → image (gif)');
assert(mediaDataUri({ body: WEBP }).render === 'image', 'UklGR → image (webp)');

// 3) 视频消息但 body 是 JPEG 缩略图（实测真机情况）→ 当图渲染，不是坏 video
const vAsImage = mediaDataUri({ body: JFIF, mediaKind: 'video' });
assert(vAsImage.render === 'image' && vAsImage.uri.startsWith('data:image/jpeg;base64,'), '视频消息 body 是 JPEG → 当缩略图渲染（不硬塞 video/mp4）');

// 4) 真正是视频字节（body 非图片魔数，type=video）→ video
const vReal = mediaDataUri({ body: b64, mediaKind: 'video' });
assert(vReal.render === 'video' && vReal.uri.startsWith('data:video/mp4;base64,'), '视频字节 → video/mp4');

// 5) 语音 → audio/ogg
const a = mediaDataUri({ body: b64, mediaKind: 'ptt' });
assert(a.render === 'audio' && a.uri.startsWith('data:audio/ogg;base64,'), 'ptt → audio/ogg');
const a2 = mediaDataUri({ body: b64, mediaKind: 'audio' });
assert(a2.render === 'audio', 'audio → audio/ogg');

// 6) uri 形状：data:<mime>;base64,<body>
const u = mediaDataUri({ body: JFIF });
assert(/^data:image\/jpeg;base64,\/9j\//.test(u.uri), 'uri 拼成 data:image/jpeg;base64,...');

console.log(process.exitCode ? '\n❌ 有失败用例' : '\n✅ 全部通过');
