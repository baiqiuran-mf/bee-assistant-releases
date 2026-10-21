/**
 * 客户档案 Word 文档生成（2026-10-07 v1.1.0）
 *
 * ## 干什么
 * 每小时把每个客户的档案**全量重建成一份 .docx**，图片**内嵌**进文档。
 *
 * ## 为什么是「全量重建」而不是「追加」（老板选的方案 A）
 * 追加要处理去重、错位、改版式后新旧样式不一致 —— bug 面很大。
 * 全量重建只有一个真相来源，永远不会不一致；客户量才几十个，一秒内跑完。
 *
 * ## 为什么图片是「小图」（老板明确要求：不能用原图，word 文档会比较小）
 * WhatsApp 原图动辄 1~3 MB，一个客户十几张图 → 文档几十 MB，发都发不动。
 * 所以默认把宽度压到固定 `THUMB_W`（默认 100px），高度按原图比例算（不压成正方形）。
 *
 *🔴 关键：**不引入任何新依赖**。
 *   .docx 本质是个 zip + 一组 XML，这里面手写了：
 *     · crc32 + store 模式 zip 打包（不压缩，够用且实现简单）
 *     · document.xml（正文 + 插图指令）
 *     · document.xml.rels（图片关系）
 *     · media/xxx.png（图片本体）
 *   已经用python-docx 独立解析验证过：能正确读出 inline_shapes。
 *
 * ## 缩图怎么做的（不依赖 sharp /canvas）
 * 有Electron 时走Chromium 的 canvas 缩放；没有就**原样嵌入**（不缩）。
 * 这样在命令行 / 测试环境里也能生成出合法文档。
 *
 * ## 硬边界
 * 只读数据库和本地文件、只写data/word/ 目录；没有任何发送能力。
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const paths = require('./paths');
const media = require('./media');
const prewarm = require('./prewarm'); // v2.5.1036：每小时重建要给进程扫描让路

/* ================================================================
 * 一、极简 zip（store 模式，不压缩）
 * ================================================================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 把若干 { name, data } 打成一个 zip。
 * @param {Array<{name:string,data:Buffer}>} files
 * @returns {Buffer}
 */
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);

    // 本地文件头
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0x0800, 6);    // flags: UTF-8 文件名
    lh.writeUInt16LE(0, 8);         // method: store
    lh.writeUInt16LE(0, 10);        // time
    lh.writeUInt16LE(0x21, 12);     // date（固定值，保证同样输入产出同样字节）
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, name, data);

    // 中央目录项
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);        // version made by
    ch.writeUInt16LE(20, 6);        // version needed
    ch.writeUInt16LE(0x0800, 8);    // flags: UTF-8 文件名
    ch.writeUInt16LE(0, 10);        // method: store
    ch.writeUInt16LE(0, 12);        // time
    ch.writeUInt16LE(0x21, 14);     // date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(0, 38);        // external attrs
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

/* ================================================================
 * 二、图片尺寸 & 缩图
 * ================================================================ */

/** 从 PNG 的 IHDR 读宽高（只认自己的 magic，不看扩展名） */
function pngSize(buf) {
  if (buf.length < 24) return null;
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** 从 JPEG 的 SOFn 段读宽高 */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF15，排除 DHT(c4)/JPG(c8)/DAC(cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** GIF 宽高（logical screen descriptor） */
function gifSize(buf) {
  if (buf.length < 10) return null;
  if (buf.toString('latin1', 0, 3) !== 'GIF') return null;
  return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
}

/** 统一读尺寸：按 magic 字节判断，认不出返回 null */
function imageSize(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return pngSize(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
  if (buf.toString('latin1', 0, 3) === 'GIF') return gifSize(buf);
  return null;
}

/** 真实类型 → 扩展名/Content-Type。**只认 magic**，不信扩展名 */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpeg', mime: 'image/jpeg' };
  }
  if (buf.toString('latin1', 0, 3) === 'GIF') return { ext: 'gif', mime: 'image/gif' };
  // WEBP：RIFF....WEBP
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return { ext: 'bmp', mime: 'image/bmp' };
  return null;
}

/**
 * 视频占位图（无缩略图时兜底图标）：base64 PNG，PIL 生成（圆角黑底 + 白圆红三角 + 「视频」二字）。
 * 直接内联成常量，生产环境不依赖任何外部文件。
 */
const VIDEO_PLACEHOLDER_B64 = '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';

/** 安全读文件（占位图兜底用，读不到返回 null） */
function safeRead(p) {
  try { return fs.readFileSync(p); } catch (e) { return null; }
}

/**
 * 视频消息抽预览图：
 *  - body 里的 JPEG 缩略图优先（WhatsApp 视频消息的 body 通常带一张缩略图字节）
 *  - 没落盘原图、也没缩略图字节 → 返回占位图标标记（buildCustomerWord 用 VIDEO_PLACEHOLDER_B64 顶上）
 */
function videoThumbOf(m) {
  if (whatOf(m) !== '视频') return null;
  if (m.media_path && sniffImage(safeRead(m.media_path))) return { src: 'file', val: m.media_path };
  if (bodyIsImage(m.body)) return { src: 'b64', val: String(m.body) };
  return { src: 'videoplaceholder' };
}

/**
 * 缩小图片（老板要求「用小图，word 文档会比较小」）
 *
 * 走 puppeteer 的 Chromium canvas 缩放 —— 项目里已经有 puppeteer，不用加新依赖。
 * 拿不到浏览器就返回 null，调用方原样嵌入（宁可大一点也不 fail）。
 *
 * 🔴 v2.6.1170：由「长边 ≤ 720」改成「固定宽 widthPx（默认 100），高按原图比例」。
 *    比目标窄的图不放大（避免把小图拉糊）。
 *
 * @param {Buffer} buf 原图
 * @param {string} mime 原图 mime
 * @param {number} widthPx 目标宽度（px），高度按原图比例算
 * @returns {Promise<{data:Buffer, mime:string, w:number, h:number}|null>}
 */
let _shrinkBrowser = null;
async function shrinkImage(buf, mime, widthPx) {
  if (typeof widthPx !== 'number' || widthPx <= 0) return null;
  const size = imageSize(buf);
  if (!size) return null;
  // 本来就比目标窄 → 不放大（宁可糊一点也不要把小图拉大）
  if (size.w <= widthPx) {
    return { data: buf, mime, w: size.w, h: size.h };
  }
  let browser = _shrinkBrowser;
  if (!browser || !browser.isConnected || !browser.isConnected()) {
    let puppeteer;
    try { puppeteer = require('puppeteer'); } catch (e) { return null; }
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
      _shrinkBrowser = browser;
    } catch (e) {
      return null;
    }
  }
  try {
    const page = await browser.newPage();
    const b64 = buf.toString('base64');
    const out = await page.evaluate(async (dataUrl, targetW) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const w = targetW;
      const h = Math.max(1, Math.round(img.height * (targetW / img.width)));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      // 白底：JPEG 没有 alpha，直接铺白免得透明区变黑
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      // 一律出 JPEG：兼容性最好、体积最小
      return { dataUrl: c.toDataURL('image/jpeg', 0.82), w, h };
    }, `data:${mime};base64,${b64}`, widthPx);
    await page.close();
    if (!out || !out.dataUrl) return null;
    const raw = String(out.dataUrl).split(',')[1] || '';
    return { data: Buffer.from(raw, 'base64'), mime: 'image/jpeg', w: out.w, h: out.h };
  } catch (e) {
    return null;
  }
}

/** 关掉缩图用的浏览器（测试/退出时调） */
async function closeShrinker() {
  const b = _shrinkBrowser;
  _shrinkBrowser = null;
  if (b) { try { await b.close(); } catch (e) { /* ignore */ } }
}

/* ================================================================
 * 三、docx 组装
 * ================================================================ */

const EMU_PER_PX = 9525;
/** Word A4 正文可用宽度 ≈ 6.0 英寸 = 576px @96dpi，留一点余量 */
const MAX_W = 560;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 不允许的控制字符，直接剔掉（否则 Word 会报文档损坏）
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function p(text, opt = {}) {
  const rpr = opt.bold ? '<w:rPr><w:b/></w:rPr>'
    : opt.italic ? '<w:rPr><w:i/></w:rPr>'
      : opt.small ? '<w:rPr><w:sz w:val="18"/></w:rPr>' : '';
  const ppr = opt.align ? `<w:pPr><w:jc w:val="${opt.align}"/></w:pPr>` : '';
  return `<w:p>${ppr}<w:r>${rpr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function h(level, text) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>`
    + `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function picturePara({ rid, cx, cy, alt, caption }) {
  const did = 1000 + Math.floor(Math.random() * 100000);
  const img = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>`
    + `<wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:docPr id="${did}" name="Picture ${did}" descr="${esc(alt || '')}"/>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
    + `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:nvPicPr><pic:cNvPr id="${did}" name="img${did}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  if (!caption) return img;
  return img + p(caption, { align: 'center', italic: true, small: true });
}

/**
 * 生成一份 docx。
 * @param {object} o
 * @param {string} o.title文档标题
 * @param {Array} o.blocks [{type:'h1'|'h2'|'p'|'kv'|'img', ...}]
 * @param {Map<string,Buffer>} o.media 媒体文件名 → 字节（已缩好）
 * @returns {Buffer}
 */
function buildDocx({ title, blocks, mediaFiles }) {
  const body = [];
  body.push(h(1, title));
  const rels = [{ id: 'rId1', type: 'styles', target: 'styles.xml' }];
  const files = [];
  let seq = 0;

  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'h1') body.push(h(1, b.text));
    else if (b.type === 'h2') body.push(h(2, b.text));
    else if (b.type === 'kv') body.push(p(`${b.k}：${b.v}`, { bold: false }));
    else if (b.type === 'kvb') body.push(p(`${b.k}：${b.v}`, { bold: true }));
    else if (b.type === 'p') body.push(p(b.text, b.opts || {}));
    else if (b.type === 'img') {
      const entry = mediaFiles.get(b.key);
      if (!entry) continue; // 图读不到就跳过，绝不塞空占位
      seq += 1;
      const name = `image${seq}.${entry.ext}`;
      const rid = `rId${100 + seq}`;
      rels.push({ id: rid, type: 'image', target: `media/${name}` });
      files.push({ name: `word/media/${name}`, data: entry.data });
      let w = entry.w;
      let hgt = entry.h;
      if (w > MAX_W) { hgt = Math.round(hgt * MAX_W / w); w = MAX_W; }
      body.push(picturePara({
        rid, cx: w * EMU_PER_PX, cy: hgt * EMU_PER_PX,
        alt: b.caption || '', caption: b.caption || '',
      }));
    }
  }

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
    + ` xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`
    + ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`
    + ` xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<w:body>${body.join('')}`
    + `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>`
    + `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>`
    + `</w:sectPr></w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Default Extension="png" ContentType="image/png"/>`
    + `<Default Extension="jpeg" ContentType="image/jpeg"/>`
    + `<Default Extension="jpg" ContentType="image/jpeg"/>`
    + `<Default Extension="gif" ContentType="image/gif"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
    + `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
    + `</Relationships>`;

  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + rels.map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${r.type}" Target="${r.target}"/>`).join('')
    + `</Relationships>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:docDefaults><w:rPrDefault><w:rPr>`
    + `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/>`
    + `<w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>`
    + `<w:pPr><w:spacing w:after="80" w:line="288" w:lineRule="auto"/></w:pPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>`
    + `<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>`
    + `<w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>`
    + `<w:pPr><w:spacing w:before="180" w:after="80"/></w:pPr>`
    + `<w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>`
    + `</w:styles>`;

  files.push({ name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') });
  files.push({ name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') });
  files.push({ name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') });
  files.push({ name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf8') });
  files.push({ name: 'word/styles.xml', data: Buffer.from(stylesXml, 'utf8') });

  return zipStore(files);
}

/* ================================================================
 * 四、把一个客户的消息编成 blocks
 * ================================================================ */

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function whatOf(m) {
  const t = String(m.media_type || '');
  if (t === 'sticker') return '贴纸';
  if (t === 'video') return '视频';
  if (t === 'audio' || t === 'ptt') return '语音';
  if (t === 'document') return '文件';
  return '图片';
}

/** 一条 base64 是不是图片（看 magic，不看扩展名；兼容 data: 前缀） */
function bodyIsImage(b) {
  const s = String(b || '').replace(/^data:[^;]+;base64,/, '');
  return /^\/9j\/|iVBOR|R0lGOD|UklGR/.test(s.slice(0, 12));
}

/** 从一条消息里抽出该嵌的图（只认真图；语音/视频/文件不塞）
 *  - media_path 在磁盘 → 用文件
 *  - 没落盘但 body 是完整 base64 图片（如 WA 没抓到原图、只存了缩略图字节）→ 直接用 body 嵌
 *    这样文档里的图和右栏面板用的是同一串字节，不用为文档额外去抓原图。
 */
function picOf(m) {
  const w = whatOf(m);
  if (w !== '图片') return null;
  if (m.media_path) return { src: 'file', val: m.media_path };
  if (bodyIsImage(m.body)) return { src: 'b64', val: String(m.body) };
  return null;
}

/**
 * 编一个客户的 blocks。
 * 顺序 = 消息时间顺序，每条：谁说的 → 原文 → 中文 → 媒体 → 中文说明
 */
function blocksOf(customer, messages) {
  const b = [];
  b.push({ type: 'h2', text: '客户信息' });
  const rows = [
    ['编号', customer.code || ''],
    ['姓名', customer.name || ''],
    ['电话', customer.phone || '（未填写）'],
    ['地区', customer.region || '（未填写）'],
    ['时区', customer.timezone_label || customer.tz_offset || '（未识别）'],
    ['加入时间', fmtTime(customer.joined_at)],
    ['所属账号', String(customer.account_id || '')],
    ['消息条数', String(messages.length)],
  ];
  for (const [k, v] of rows) b.push({ type: 'kv', k, v: v || '（空）' });

  b.push({ type: 'h2', text: '对话记录' });
  if (!messages.length) {
    b.push({ type: 'p', text: '（暂无消息）' });
    return b;
  }
  let imgSeq = 0;
  for (const m of messages) {
    const who = m.direction === 'out' ? '我' : (customer.name || '客户');
    const t = fmtTime(m.msg_ts || m.created_at);
    b.push({ type: 'p', text: `【${who}】${t ? ' ' + t : ''}`, opts: { bold: true, small: true } });
    // 🔴 媒体消息的 body 是 base64 图片/视频字节（或 null），body_zh 是 AI 把 base64 当英文翻出来的废话
    //    （库里实测存着「我这边好像收到的是乱码…」「只有一张图片的数据」这类话）。
    //    绝不能当正文塞进文档 —— 否则文档里出现一墙 base64 + 好几段"乱码"文案。
    //    只有"真不是媒体的消息"或"媒体消息但 body 确实是人话"（客户在图上配的字）才显示正文。
    const isMedia = !!(m.media_path || (m.media_type && /^(image|sticker|video|audio|ptt|document)$/.test(m.media_type)) || (m.media_fetch_state && m.media_fetch_state !== ''));
    const bodyIsText = !isMedia || !bodyIsImage(m.body);
    if (bodyIsText && m.body) b.push({ type: 'p', text: m.body });
    if (!isMedia && m.body_zh) b.push({ type: 'p', text: `中文：${m.body_zh}` });
    const pic = picOf(m);
    if (pic) {
      imgSeq += 1;
      // 图片下方加一行小字说明：谁发的 · 什么时候发的，让文档里的图有上下文
      const cap = `（${who}${t ? ' · ' + t : ''}）`;
      b.push({ type: 'img', key: 'img' + imgSeq, src: pic.src, file: pic.src === 'file' ? pic.val : null, b64: pic.src === 'b64' ? pic.val : null, caption: cap });
    }
    // 视频：能抽到缩略图就嵌缩略图（比空白占位清楚），没有就嵌带「视频」字样的占位图标
    if (whatOf(m) === '视频') {
      const vt = videoThumbOf(m);
      imgSeq += 1;
      const cap = `（视频 · ${who}${t ? ' · ' + t : ''}）`;
      b.push({ type: 'img', key: 'img' + imgSeq, src: vt.src, file: vt.src === 'file' ? vt.val : null, b64: vt.src === 'b64' ? vt.val : null, caption: cap });
    }
    if (m.media_zh) b.push({ type: 'p', text: `${whatOf(m)}内容：${m.media_zh}` });
    else if (m.media_path && !pic) b.push({ type: 'p', text: `（${whatOf(m)}：${path.basename(m.media_path)}）`, opts: { small: true } });
    else if (m.media_src === 'none') b.push({ type: 'p', text: '（图片当时没抓到，延时重抓也没成功）', opts: { small: true } });
  }
  return b;
}

/* ================================================================
 * 五、对外接口
 * ================================================================ */

/** Word 文档输出目录 */
function wordDir() {
  return paths.ensure(path.join(paths.DATA_ROOT, 'word'));
}

/** 文件名里不能有 Windows 禁用字符 */
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

/**
 * 🔴 v2.6.1194 老板拍板：Telegram 的 Word 档命名**与 WA 系列不一样** ——
 *   「客户的档案 md 数据命名为 编号 + ID + 电话 + 名称，找不到ID和电话可以 编号 + 名称。
 *    这个也要建立 word 档案。也是一个小时一次，关闭时候也会自动建 word 档。」
 *
 *   ID 段取 customers.tg_username（= 档案弹窗里那个 Username 字段，如 EileenLin09），
 *   **去掉 @ 前缀**（与 src/customerDoc.js 的 docFileName 保持一致，两边同一个口径）。
 *
 * 🔴 WA / Signal 分支**一个字都没改**（仍是 `{code}_{name}`）—— 那个渠道共用同一套命名。
 *
 * ⚠️ 本文件的 safeName 是把非法字符**换成 `_`**（customerDoc.js 是删除），
 *   两边风格本来就不同；所以这里逐段各自过一遍 safeName，
 *   绝不把整串拼好再过一次（那样段与段之间的分隔符也会被影响）。
 *
 * 「每小时一次 + 关闭时补建」沿用现有机制（startHourly / electron/main.js runCloseSequence），
 * 本次**不新建任何定时器**。
 */
function wordBaseName(customer) {
  const code = safeName(customer.code);
  const name = safeName(customer.name || '客户');

  // ---- 🔴 Telegram 专属分支（新增）----
  if (String(customer.channel || '') === 'telegram') {
    // ⚠️ 先在**原始值**上判空，再过 safeName —— safeName 对空串会返回 '未命名'，
    //   要是拿它的返回值去判空，就永远判不出「没有」，四段格式会退化成占位符版本。
    const rawId = String(customer.tg_username || '').replace(/^@/, '').trim();
    const rawPhone = String(customer.phone || '').replace(/[^\d+]/g, '');
    // ID 与电话都没有 → 退成「编号_名称」（与 md 那边的规则一致）
    if (!rawId && !rawPhone) return `${code}_${name}`;
    return `${code}_${rawId ? safeName(rawId) : '无ID'}_${rawPhone ? safeName(rawPhone) : '未知电话'}_${name}`;
  }

  // ---- WA / Signal：以下为改动前原样，一行未动 ----
  return `${customer.code}_${customer.name || '客户'}`;
}

/**
 * 给一个客户生成 Word 文档。
 *
 * @param {object} customer customers 一行
 * @param {Array} messages 该客户的 messages
 * @param {object} opt { thumbWidth=100 缩图固定宽（px），高按原图比例；dir 输出目录；name 文件名（不含扩展名）}
 * @returns {Promise<{file:string, bytes:number, images:number, skipped:string[]}>}
 */
async function buildCustomerWord(customer, messages, opt = {}) {
  const thumbWidth = Number(opt.thumbWidth == null ? (opt.maxEdge == null ? 100 : opt.maxEdge) : opt.thumbWidth);
  const dir = opt.dir || wordDir();
  const blocks = blocksOf(customer, messages);

  // 收集要嵌的图 → 缩图 → 放进mediaFiles
  const mediaFiles = new Map();
  const skipped = [];
  const wanted = blocks.filter((b) => b.type === 'img');
  for (const b of wanted) {
    if (mediaFiles.has(b.key)) continue;
    let buf = null;
    if (b.src === 'videoplaceholder') {
      buf = Buffer.from(VIDEO_PLACEHOLDER_B64, 'base64');
    } else if (b.src === 'b64') {
      try { buf = Buffer.from(String(b.b64).replace(/^data:[^;]+;base64,/, ''), 'base64'); } catch (e) { buf = null; }
      if (!buf) { skipped.push('(b64)'); continue; }
    } else {
      try {
        if (!fs.existsSync(b.file)) { skipped.push(b.file); continue; }
        buf = fs.readFileSync(b.file);
      } catch (e) { skipped.push(b.file); continue; }
    }
    const sn = sniffImage(buf);
    if (!sn) { skipped.push(b.src === 'b64' ? '(b64)' : b.file); continue; } // 不是图片（别把语音塞进去）
    const small = await shrinkImage(buf, sn.mime, thumbWidth);
    const data = small ? small.data : buf;
    const size = (small && { w: small.w, h: small.h }) || imageSize(buf);
    if (!size) { skipped.push(b.src === 'b64' ? '(b64)' : b.file); continue; }
    mediaFiles.set(b.key, { data, ext: (small ? small.mime : sn.mime).split('/')[1], w: size.w, h: size.h });
  }

  const title = `${customer.name || '未命名'} · ${customer.code}`;
  const docx = buildDocx({ title, blocks, mediaFiles });
  const name = safeName(opt.name || wordBaseName(customer));
  const file = path.join(dir, `${name}.docx`);
  fs.mkdirSync(dir, { recursive: true });
  // 先写临时文件再改名：Word 正在打开时不会读到写了一半的文档
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, docx);
  try { fs.renameSync(tmp, file); } catch (e) {
    fs.writeFileSync(file, docx);
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
  }
  return { file, bytes: docx.length, images: mediaFiles.size, skipped };
}

/**
 * 全量重建所有客户的 Word 文档（方案 A）。
 *
 * @param {object} opt { maxEdge, dir, codes 只重建这几个（默认全部）, onEach }
 * @returns {Promise<{docs:number, images:number, errors:string[], files:string[]}>}
 */
async function rebuildAll(opt = {}) {
  const list = opt.codes && opt.codes.length
    ? opt.codes.map((c) => db.getCustomer.get(c)).filter(Boolean)
    : db.listCustomers.all();
  const out = { docs: 0, images: 0, errors: [], files: [] };
  for (const c of list) {
    try {
      const msgs = db.listMessages.all(c.code);
      const r = await buildCustomerWord(c, msgs, opt);
      out.docs += 1;
      out.images += r.images;
      out.files.push(r.file);
      if (opt.onEach) opt.onEach(r);
    } catch (e) {
      out.errors.push(`${c.code}: ${(e && e.message) || e}`);
      console.warn(`[word] ${c.code} 生成失败：`, (e && e.message) || e);
    }
  }
  return out;
}

/* ================================================================
 * 六、每小时自动重建
 * ================================================================ */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 每小时
let hourTimer = null;
let lastRun = null;

/**
 * 启动每小时重建。
 * @param {object} opt { intervalMs, maxEdge, onDone }
 */
function startHourly(opt = {}) {
  stopHourly();
  const every = Math.max(60 * 1000, Number(opt.intervalMs) || DEFAULT_INTERVAL_MS);
  const tickOnce = async () => {
    try {
      /*
       * 🔴 v2.5.1036（老板拍板）：撞上进程扫描的静默窗口 → 本轮让路，闸开了再补。
       *    Word 是备份用的，晚几分钟完全无妨；但跟进程扫描挤在一起就会两边都慢。
       *    总闸没开（还没登录 / 同步没走完）也一样不动。
       */
      const g = prewarm.gate();
      if (g.skip) {
        const t = setTimeout(tickOnce, Math.max(3000, g.retryInMs + 1000));
        if (t.unref) t.unref();
        return;
      }
      const r = await rebuildAll(opt);
      lastRun = { at: new Date().toISOString(), ...r };
      console.log(`[word] 每小时重建完成：${r.docs} 份文档，${r.images} 张图`
        + (r.errors.length ? `，${r.errors.length} 份失败` : ''));
      if (opt.onDone) opt.onDone(lastRun);
    } catch (e) {
      console.warn('[word] 每小时重建出错：', (e && e.message) || e);
    }
  };
  hourTimer = setInterval(tickOnce, every);
  if (hourTimer.unref) hourTimer.unref();
  // 启动后先等10 分钟再跑第一轮（别和启动抢资源），之后每小时一次
  const first = setTimeout(tickOnce, 10 * 60 * 1000);
  if (first.unref) first.unref();
  return { stop: stopHourly, firstRunIn: 10 * 60 * 1000 };
}

function stopHourly() {
  if (hourTimer) { clearInterval(hourTimer); hourTimer = null; }
}

module.exports = {
  // 生成
  buildCustomerWord, rebuildAll, blocksOf, safeName, wordDir, wordBaseName,
  // 定时
  startHourly, stopHourly, DEFAULT_INTERVAL_MS,
  get lastRun() { return lastRun; },
  // 底层（单测直接测）
  zipStore, crc32, imageSize, pngSize, jpegSize, gifSize, sniffImage,
  shrinkImage, closeShrinker, buildDocx, MAX_W, EMU_PER_PX,
};
