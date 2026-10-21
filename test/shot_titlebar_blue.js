/**
 * 拟改预览：把「系统原生标题栏」（老板红框那一条）刷成蓝色
 *
 * 为什么不用浏览器模拟：
 *   红框 = Windows 原生标题栏（app 图标 + 窗口名 + ─ ▫ ✕），它是操作系统画的，不是 HTML，
 *   浏览器里根本渲染不出来。所以只能用老板的真实截图来"上色"，才能真实反映改后效果。
 *
 * 做法：
 *   1) 扫原图里的红框（纯红像素）→ 求外接矩形
 *   2) 复制一份，把矩形填成蓝色 #2563eb；矩形内偏暗的像素（黑色标题字/按钮）改成白色
 *   3) 上下拼「现状 / 改后」并加标签
 *
 * 跑法：node test/shot_titlebar_blue.js
 * 产物：preview/标题栏-改蓝对比.jpg
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const SRC = process.env.SHOT
  || 'C:/Users/Administrator/.workbuddy/clipboard-images/clipboard-2026-10-13T15-28-46-217Z-94b8481c.jpg';
const OUT = path.join(__dirname, '..', 'preview', '标题栏-改蓝对比.jpg');

const BLUE = [37, 99, 235];      // #2563eb  app 现有主蓝
const BLUE_TXT = [255, 255, 255]; // 蓝底上的文字/按钮改白

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const b64 = fs.readFileSync(SRC).toString('base64');

  const res = await page.evaluate(async (b64, BLUE, BLUE_TXT) => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    const W = img.width, H = img.height;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);

    // ---- 1) 找红框：只在顶部 220 行里找「长横向红线」（避开桌面红色壁纸干扰）----
    const dat = cx.getImageData(0, 0, W, H).data;
    const isRed = (i) => dat[i] > 170 && dat[i + 1] < 95 && dat[i + 2] < 95;
    const SCAN_Y = Math.min(220, H);
    const rowCount = [];
    for (let y = 0; y < SCAN_Y; y++) {
      let c = 0;
      for (let x = 0; x < W; x++) if (isRed((y * W + x) * 4)) c++;
      rowCount.push(c);
    }
    // 长横线阈值：至少 45% 宽度是红
    const lineRows = [];
    for (let y = 0; y < SCAN_Y; y++) if (rowCount[y] > W * 0.45) lineRows.push(y);
    let y0 = lineRows.length ? lineRows[0] : 0;
    let y1 = lineRows.length ? lineRows[lineRows.length - 1] : 0;
    // 该范围内的左右边界
    let x0 = W, x1 = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = 0; x < W; x++) {
        if (isRed((y * W + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      }
    }
    if (x0 > x1) { x0 = 0; x1 = W - 1; }
    const box = { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, lines: lineRows.length };

    // ---- 2) 生成"改后"画布：标题栏原白底 → 蓝，原深色字/按钮 → 白（彩色图标保留）----
    const cv2 = document.createElement('canvas');
    cv2.width = W; cv2.height = H;
    const cx2 = cv2.getContext('2d');
    cx2.drawImage(cv, 0, 0);
    const img2 = cx2.getImageData(0, 0, W, H);
    const d2 = img2.data;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 4;
        const R = d2[i], G = d2[i + 1], B = d2[i + 2];
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        if (mx - mn > 60) continue;                 // 彩色像素（🐝 图标）原样保留
        const lum = 0.299 * R + 0.587 * G + 0.114 * B;
        let t;
        if (lum >= 175) t = 1;                       // 原白底 / 红框线 → 蓝
        else if (lum <= 120) t = 0;                  // 原深色字 / 窗口按钮 → 白
        else t = (lum - 120) / 55;                   // 抗锯齿过渡
        d2[i] = Math.round(BLUE_TXT[0] * (1 - t) + BLUE[0] * t);
        d2[i + 1] = Math.round(BLUE_TXT[1] * (1 - t) + BLUE[1] * t);
        d2[i + 2] = Math.round(BLUE_TXT[2] * (1 - t) + BLUE[2] * t);
      }
    }
    cx2.putImageData(img2, 0, 0);

    // ---- 3) 裁剪成"窗口顶部"一条：标题栏 + 下面那行 HTML 顶栏 ----
    const padL = Math.max(0, x0 - 26);
    const padT = Math.max(0, y0 - 30);
    const cutW = Math.min(W - padL, (x1 - x0 + 1) + 52);
    const cutH = Math.min(H - padT, (y1 - y0 + 1) + 110);
    const S = 2;

    const strip = (src) => {
      const o = document.createElement('canvas');
      o.width = cutW * S; o.height = cutH * S;
      const ox = o.getContext('2d');
      ox.imageSmoothingEnabled = false;
      ox.drawImage(src, padL, padT, cutW, cutH, 0, 0, cutW * S, cutH * S);
      return o.toDataURL('image/jpeg', 0.95);
    };

    return { W, H, box, before: strip(cv), after: strip(cv2) };
  }, b64, BLUE, BLUE_TXT);

  console.log(`原图 ${res.W}x${res.H}；红框外接矩形 x=${res.box.x0}~${res.box.x1} y=${res.box.y0}~${res.box.y1}（宽 ${res.box.w} × 高 ${res.box.h}，检出长横线 ${res.box.lines} 条）`);

  // ---- 4) 拼成对比图 ----
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1500, height: 900, deviceScaleFactor: 2 });
  await page2.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    body{margin:0;background:#eef1f5;font:14px/1.6 system-ui,'Microsoft YaHei',sans-serif;color:#1d2733}
    .hd{background:#1d2733;color:#fff;padding:13px 22px;font-size:17px;font-weight:700}
    .hd small{display:block;font-weight:400;font-size:12px;color:#aab7c6;margin-top:3px}
    .item{padding:14px 22px 8px}
    .lab{font-size:15px;font-weight:700;color:#12365f;margin-bottom:6px}
    .lab .tag{font-size:12px;font-weight:400;color:#6b7b8d;margin-left:8px}
    img{width:100%;display:block;border:1px solid #c3cddb;border-radius:6px;background:#fff}
  </style></head><body>
    <div class="hd">窗口最上方「系统标题栏」改蓝 · 拟改预览（尚未动任何代码）
      <small>红框位置 = Windows 原生标题栏（🐝 蜜蜂信息采集 ＋ ─ ▫ ✕）· 蓝色用现有主蓝 #2563eb</small></div>
    <div class="item"><div class="lab">① 现状<span class="tag">系统标题栏：Windows 默认白底 / 深灰字</span></div>
      <img src="${res.before}"></div>
    <div class="item"><div class="lab">② 改后<span class="tag">标题栏整条 #2563eb 蓝底 · 应用名与 ─ ▫ ✕ 按钮转白字</span></div>
      <img src="${res.after}"></div>
  </body></html>`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 500));
  await page2.screenshot({ path: OUT, fullPage: true });

  console.log(`对比图已生成：${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)} KB）`);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
