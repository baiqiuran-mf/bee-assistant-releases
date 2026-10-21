/**
 * 图片压缩（2026-10-08）
 *
 * ## 要解决的问题
 * 走「路C」（主动触发 mediaData 解密）能拿到客户发来的**真原图**，
 * 但 WhatsApp 原图动辄 1-3MB，直接塞进气泡：
 *   - 页面要加载几 MB base64，滚动会卡
 *   - 新消息框里一屏能看的信息太少
 * 老板要求：**压到 10KB 左右**再显示在消息框内。
 *
 * ## 本项目的取舍（老板明确指示）
 * **只存压缩小图，不双份保留原图。**
 * 所以 media/ 目录里放的就是气泡里看到的那张，media_path 直接指它。
 *
 *## 为什么用二分搜索而不是一次压到位
 * JPEG 质量与体积不是线性关系（q=80→28KB，q=60→15KB，q=40→9KB），
 * 猜一个质量值命中率很差。二分能在~8 次编码内锁定目标体积，
 * 而且 sharp 走libvips，8 次缩略图编码对一张图也就几十毫秒。
 *
 * ## 硬边界
 * 只做本地图片变换：不发送、不联网、不碰除media/ 以外的目录。
 */

const fs = require('fs');
const path = require('path');
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  // sharp 缺失不能拖垮整个采集 —— 调用方会退回"不压缩直接存"
  console.warn('[img-shrink] sharp 加载失败，压缩功能不可用：', (e && e.message) || e);
}

/** 目标体积（字节）。老板指定「10k 大小左右」。 */
const TARGET_BYTES = 10 * 1024;

/** 长边上限。10KB 撑不起大图，先限边长再压质量。 */
const MAX_EDGE = 320;

/** 🔴 2026-10-16 老板拍板：气泡里图片「固定宽度 = 75px」，高度按原图比例算（不压成正方形）。 */
const TARGET_WIDTH = 75;

/** 最小合法体积。比它更小说明压过头了，画质已经不可用。 */
const MIN_BYTES = 3 * 1024;

/** 质量搜索区间 */
const Q_MAX = 88;
const Q_MIN = 35;

/**
 * 在固定尺寸下，二分搜索质量，把体积逼近 targetBytes。
 *
 * 🔴 上一版有 bug：先用 target=Infinity 试一轮，把 best 锁死在 q=Q_MIN 的
 * 超小图上，后面再怎么抬质量也追不回来 —— 表现为「1.9MB 压成 1.8KB，
 * 明明还有 8KB 预算没用」。现在改成**先探出上下界，再在区间内二分**，
 * 并且统一用「最贴近目标」而不是「第一个达标」作为答案。
 *
 * @param {Buffer} input 原图字节
 * @param {number} target 目标字节
 * @param {number} [edge] 长边上限（默认 MAX_EDGE）。缩小尺寸后二次调用要传。
 * @returns {Promise<{buf:Buffer, bytes:number, quality:number, width:number, height:number, over?:boolean}|null>}
 */
async function encodeAtQuality(input, target, edge) {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) return null;

  // 🔴 2026-10-16 老板拍板：固定宽度 = TARGET_WIDTH(75)，高度按原图比例（不再塞正方形框）。
  //   不超过原宽、不放大（withoutEnlargement）。
  const targetW = Math.min(edge || TARGET_WIDTH, meta.width);
  // 🔴 显式给 width 且 withoutEnlargement=true 时，sharp 会**跳过 resize**
  //   直接把原图吐出来 —— 那 1.9MB 原图就原封不动进了 JPEG 编码，白压。
  //   所以只在确实需要缩小时才走 fit:'inside'，原图小就原样交给 jpeg()。
  const needsResize = targetW < meta.width;
  const base = () => {
    let p = sharp(input).rotate();
    if (needsResize) {
      p = p.resize({ width: targetW, fit: 'inside', withoutEnlargement: true });
    }
    return p.jpeg({
      progressive: false,              // progressive 会大 5-8%
      chromaSubsampling: '4:2:0',      // 4:4:4 同画质下体积翻倍
      mozjpeg: true,
    });
  };

  // ---- 第 1 步：探上界（Q_MAX 一定超目标，否则原图就够小）----
  const hiRes = await base().jpeg({ quality: Q_MAX }).toBuffer({ resolveWithObject: true });
  if (hiRes.data.length <= target) {
    // 原图在最大质量下都不到目标 → 已经是上限，别再压了（保画质）
    return {
      buf: hiRes.data, bytes: hiRes.data.length, quality: Q_MAX,
      width: hiRes.info.width, height: hiRes.info.height,
    };
  }

  // ---- 第 2 步：探下界（Q_MIN 装得下 → 从 Q_MIN 往上找最优）----
  const loRes = await base().jpeg({ quality: Q_MIN }).toBuffer({ resolveWithObject: true });
  if (loRes.data.length > target) {
    // 连最低质量都超 → 这个尺寸根本不可能达标，交给上层缩尺寸
    return {
      buf: loRes.data, bytes: loRes.data.length, quality: Q_MIN,
      width: loRes.info.width, height: loRes.info.height,
      over: true,
    };
  }

  // ---- 第 3 步：在 [Q_MIN, Q_MAX-1] 里二分，找**最贴近目标**的那档 ----
  let lo = Q_MIN;
  let hi = Q_MAX - 1;
  let best = { buf: loRes.data, bytes: loRes.data.length, quality: Q_MIN, width: loRes.info.width, height: loRes.info.height };

  while (lo <= hi) {
    const q = Math.floor((lo + hi) / 2);
    const r = await base().jpeg({ quality: q }).toBuffer({ resolveWithObject: true });
    const cand = { buf: r.data, bytes: r.data.length, quality: q, width: r.info.width, height: r.info.height };

    if (r.data.length <= target) {
      best = cand;                // 装得下 → 记下，继续往高画质探
      lo = q + 1;
    } else {
      hi = q - 1;
    }
  }

  return best;
}

/**
 * 把一张图压到目标体积（默认 10KB）以内。
 *
 * ⚠️ 压不到目标时返回**当前最小的那张**，绝不返回 null 让调用方以为失败了——
 * 画质略差但能显示，比不显示强。
 *
 * @param {Buffer} input 原图字节
 * @param {object} opts { target, maxEdge }
 * @returns {Promise<{buf:Buffer, bytes:number, quality:number, width:number, height:number, hit:boolean}|null>}
 *          null = 这压根不是一张能解码的图（不是 sharp 的问题）
 */
async function shrinkToTarget(input, opts = {}) {
  if (!sharp) return null;
  if (!Buffer.isBuffer(input) || input.length < 32) return null;

  const target = Math.max(MIN_BYTES, opts.target || TARGET_BYTES);
  const maxEdge = opts.maxEdge || MAX_EDGE;

  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch (e) {
    return null;                       // 不是合法图片
  }
  if (!meta.width || !meta.height) return null;

  // 🔴 2026-10-16 老板拍板：图片「固定宽度 = 75」。已经 ≤75px 宽、且体积就小于目标，
  //   直接原样返回（不重编码），界面看到的就和原图一字节不差（生产库第19 条就是这形态）。
  if (input.length <= target && meta.width <= TARGET_WIDTH) {
    return { buf: input, bytes: input.length, quality: 0, width: meta.width, height: meta.height, hit: true };
  }

  // ---- 先在这个尺寸上找最优质量 ----
  const r = await encodeAtQuality(input, target);
  if (r && !r.over) return { ...r, hit: true };

  // ---- 连最低质量都装不下 → 缩尺寸再来一轮 ----
  let edge = Math.min(maxEdge, TARGET_WIDTH);
  let fallback = r&& !r.over ? r : null;   // 记住体积最小的那张，实在不行就用它

  for (let i = 0; i < 5; i++) {
    edge = Math.round(edge * 0.78);
    if (edge < 80) break;              // 再小就认不出是什么了
    if (edge >= Math.max(meta.width, meta.height)) continue;   // 缩过头了，原图本来就比它小

    const pipe = sharp(input).rotate();
    if (edge < Math.max(meta.width, meta.height)) {
      pipe.resize({ width: edge, fit: 'inside', withoutEnlargement: true });
    }
    const small = await pipe
      .jpeg({
        quality: Q_MAX,
        progressive: false,
        chromaSubsampling: '4:2:0',
        mozjpeg: true,
      })
      .toBuffer({ resolveWithObject: true });

    if (small.data.length <= target) {
      // 这个尺寸装得下了 → 在这个尺寸上再二分一次拿最优质量
      const best = await encodeAtQuality(input, target, edge);
      return { ...best, hit: true };
    }
    if (!fallback || small.data.length < fallback.bytes) {
      fallback = {
        buf: small.data, bytes: small.data.length, quality: Q_MIN,
        width: small.info.width, height: small.info.height,
      };
    }
  }

  // 缩到 80px 还装不下（几乎不可能）→ 返回当前最小的那张，别返回 null
  return fallback
    ? { ...fallback, hit: false }
    : { buf: r.buf, bytes: r.bytes, quality: r.quality, width: r.width, height: r.height, hit: false };
}

/**
 * 落盘：压缩 → 写文件。返回给saveMedia 用的结果。
 *
 * 🔴 默认存 .jpg（气泡里最通用）；但 PNG 原样保留 .png —— 透明图转 JPG 会丢透明通道，
 *   小图标/截图 PNG 硬转 JPG 反而变大变糊（2026-10-16 收口 media_fetch 第 3 条红）。
 *
 * @param {Buffer} input 原图字节
 * @param {string} outPath 目标文件路径（扩展名按实际格式定 .jpg / .png）
 * @param {object} opts { target, maxEdge }
 * @returns {Promise<{path:string, bytes:number, quality:number, width:number, height:number, mimetype:string}|null>}
 */
async function shrinkToFile(input, outPath, opts = {}) {
  const r = await shrinkToTarget(input, opts);
  if (!r) return null;
  // 🔴 按 magic 字节判格式：PNG 不强行转 JPG。客户真实照片是 JPEG → 仍存 .jpg。
  const isPng = input[0] === 0x89 && input[1] === 0x50 && input[2] === 0x4e && input[3] === 0x47;
  const ext = isPng ? 'png' : 'jpg';
  const finalPath = outPath.replace(/\.(jpe?g|png|webp|bmp|gif|tiff?|heic)$/i, '.' + ext);
  fs.writeFileSync(finalPath, r.buf);
  return {
    path: finalPath,
    bytes: r.bytes,
    quality: r.quality,
    width: r.width,
    height: r.height,
    hit: r.hit,
    mimetype: isPng ? 'image/png' : 'image/jpeg',
  };
}

module.exports = {
  TARGET_BYTES,
  MAX_EDGE,
  shrinkToTarget,
  shrinkToFile,
  available: () => !!sharp,
};
