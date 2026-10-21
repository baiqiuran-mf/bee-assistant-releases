// PNG 像素抽查：验证预览截图里标注色真的出现了（防交白板）
const fs = require('fs');
const zlib = require('zlib');

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8, W = 0, H = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') { W = buf.readUInt32BE(off + 8); H = buf.readUInt32BE(off + 12); ct = buf[off + 17]; }
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 3 ? 1 : 0;
  if (!ch) throw new Error('colortype ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * ch;
  const out = Buffer.alloc(H * stride);
  let rp = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const bb = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + bb) & 255;
      else if (f === 3) v = (v + ((a + bb) >> 1)) & 255;
      else if (f === 4) {
        const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? pb : c)) & 255;
      }
      cur[x] = v;
    }
  }
  return { W, H, ch, data: out };
}

function countHits(file, targets) {
  const img = decodePNG(file);
  const hits = {};
  for (const k in targets) hits[k] = 0;
  for (let i = 0; i < img.W * img.H; i++) {
    const r = img.data[i * img.ch], g = img.data[i * img.ch + 1], b = img.data[i * img.ch + 2];
    for (const k in targets) {
      const [tr, tg, tb, tol] = targets[k];
      if (Math.abs(r - tr) <= tol && Math.abs(g - tg) <= tol && Math.abs(b - tb) <= tol) { hits[k]++; break; }
    }
  }
  return { total: img.W * img.H, hits };
}

const T = {
  annRed: [224, 49, 49, 12],      // 红框标注 ①
  annBlue: [31, 106, 165, 12],    // 蓝框标注 ②（手机号块）
  avatarBlue: [37, 99, 235, 12],  // 头像蓝 / 标题栏蓝
  annGreen: [46, 158, 91, 12],    // 绿标 ③（左栏 T 取消）
  dividerPurple: [167, 149, 222, 12], // 好友列紫色竖分隔线
};

for (const f of ['preview/Tele①软件版-布局确认-全窗.png', 'preview/Tele①软件版-布局确认-局部.png']) {
  const r = countHits(f, T);
  console.log(f.split(/[\\/]/).pop());
  for (const k in r.hits) console.log('   ' + k.padEnd(15) + r.hits[k] + ' px');
}
