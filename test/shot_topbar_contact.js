/**
 * 顶栏改蓝 · 对比拼图（不改任何 app 代码）
 *
 * 为什么单独有这个脚本：
 *   上一版只截了顶栏那条（2720x242，又宽又扁），在聊天里缩成一小条看不清，老板说"没看到截图样式"。
 *   这里改成「三张上下拼一张 + 每张带文字标签」，比例正常，一眼能看清。
 *
 * 做法：puppeteer 载入真实 index.html，只在本次渲染注入拟改 CSS（page.addStyleTag），
 *      截顶栏 + 下方一点内容，最后拼成一张带标签的对比图。app 代码一个字没动。
 *
 * 跑法：node --experimental-sqlite test/shot_topbar_contact.js
 * 产物：preview/顶栏-改蓝对比.png
 */
const fs = require('fs');
const path = require('path');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8986;

const BLUE = '#2563eb';
const BLUE_DARK = '#1e4fb8';
const BLUE_VER = '#ffd9a8';

// 方案 A：只把最上面那行（品牌行 .head-top）变蓝
const CSS_A = `
header { padding: 0; gap: 0; }
.head-top { background: ${BLUE}; padding: 10px 16px; color: #fff; }
.head-top .brand { color: #fff; }
.head-top .ver { color: ${BLUE_VER}; }
.head-top .build { color: rgba(255,255,255,.72); }
.head-top .ghost { color: #fff; border-color: rgba(255,255,255,.55); background: rgba(255,255,255,.12); }
.head-top .ghost:hover { background: rgba(255,255,255,.22); }
.head-top #status.green { color: #8dffb8; }
.head-top #status.red { color: #ff9a9a; }
.head-bottom { padding: 10px 16px; }
`;

// 方案 B：整个顶栏（品牌行 + 账号条）都变蓝
const CSS_B = `
header { background: ${BLUE}; border-bottom-color: ${BLUE_DARK}; }
header .brand, header .brand span { color: #fff; }
header .ver { color: ${BLUE_VER}; }
header .build { color: rgba(255,255,255,.72); }
header .ghost { color: #fff; border-color: rgba(255,255,255,.55); background: rgba(255,255,255,.12); }
header .ghost:hover { background: rgba(255,255,255,.22); }
header .acct, header .launcher { background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.55); }
header .acct-name, header .launcher-name, header .launcher button { color: #fff; }
header .led.green { background: #8dffb8; }
header .led.red { background: #ff9a9a; }
header .led.amber { background: #ffd479; }
header #status.green { color: #8dffb8; }
header #status.red { color: #ff9a9a; }
`;

// 隔离数据下没有真实账号，塞演示数据让顶栏和老板截图一致
const SAMPLE_TOP = `
(function () {
  const accts = document.getElementById('accounts');
  if (accts && !accts.querySelector('.acct')) {
    const names = ['一号', '二号', '三号', '四号', '五号'];
    accts.innerHTML = names.map((n, i) =>
      '<div class="acct online"><span class="led ' + (i === 4 ? 'red' : 'green') + '"></span>' +
      '<button class="acct-name">' + n + '</button></div>').join('');
  }
  const lb = document.getElementById('launcher-bar');
  if (lb && !lb.querySelector('.launcher')) {
    lb.innerHTML = ['S1', 'S2', 'S3'].map((n, i) =>
      '<span class="launcher"><span class="led ' + (i === 2 ? 'red' : 'green') + '"></span>' +
      '<button class="launcher-name">' + n + '</button></span>').join('');
  }
  const ver = document.getElementById('ver'); if (ver) ver.textContent = 'v2.6.1100';
  const b = document.getElementById('build'); if (b) b.textContent = '构建戳 20261013-2317';
})();
`;

(async () => {
  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');

  const cfg = loadConfig();
  const srv = createServer({ db, doc, ai, knowledge, cfg, getAccountStates: () => [] }, PORT);
  await new Promise((res, rej) => { srv.server.once('error', rej); srv.server.listen(PORT, '127.0.0.1', res); });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    // 1) 载入真实页面三次（现状 / A / B），各截「顶栏 + 下方一点内容」
    const strips = [];
    const cases = [
      { label: '① 现状（现在这样，白底）', note: 'header 整条 #ffffff，一行品牌 + 一行账号条', css: '' },
      { label: '② 方案 A：只最上面那行变蓝', note: '.head-top 品牌行 #2563eb，下面账号条保持白底', css: CSS_A },
      { label: '③ 方案 B：整条顶栏都变蓝', note: '品牌行 + 账号条全是 #2563eb，一整条蓝 header', css: CSS_B },
    ];

    for (const c of cases) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1360, height: 900, deviceScaleFactor: 2 });
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
      await new Promise((r) => setTimeout(r, 900));
      if (c.css) await page.addStyleTag({ content: c.css });
      await page.evaluate(SAMPLE_TOP);
      await new Promise((r) => setTimeout(r, 400));

      const clip = await page.evaluate(() => {
        const h = document.querySelector('header');
        const r = h.getBoundingClientRect();
        return { x: 0, y: 0, width: 1360, height: Math.ceil(r.bottom) + 56 };
      });
      const buf = await page.screenshot({ clip, encoding: 'base64' });
      strips.push({ ...c, b64: buf, cssH: clip.height });
      await page.close();
    }

    // 2) 拼成一张「带标签的对比图」，比例正常，聊天里一眼看得清
    const page3 = await browser.newPage();
    await page3.setViewport({ width: 1360, height: 1000, deviceScaleFactor: 2 });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #eef1f5; font: 14px/1.6 system-ui, 'Microsoft YaHei', sans-serif; color: #1d2733; }
      .hd { background: #1d2733; color: #fff; padding: 14px 22px; font-size: 17px; font-weight: 700; }
      .hd small { display: block; font-weight: 400; font-size: 12px; color: #aab7c6; margin-top: 3px; }
      .item { padding: 14px 22px 6px; }
      .lab { font-size: 15px; font-weight: 700; color: #12365f; margin-bottom: 3px; }
      .note { font-size: 12px; color: #6b7b8d; margin-bottom: 7px; }
      img { width: 100%; display: block; border: 1px solid #c3cddb; border-radius: 6px; background: #fff; }
    </style></head><body>
      <div class="hd">顶栏改蓝 · 三选一预览（拟改，尚未落任何代码）
        <small>蓝色用 app 现有主蓝 #2563eb · 三张都是真实界面渲染，只在渲染时临时套了 CSS</small></div>
      ${strips.map((s) => `<div class="item">
          <div class="lab">${s.label}</div>
          <div class="note">${s.note}</div>
          <img src="data:image/png;base64,${s.b64}">
        </div>`).join('')}
    </body></html>`;
    await page3.setContent(html, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 600));
    const out = path.join(ROOT, 'preview', '顶栏-改蓝对比.png');
    await page3.screenshot({ path: out, fullPage: true });

    const sz = fs.statSync(out).size;
    console.log(`[顶栏对比] 已生成：${out}  (${(sz / 1024).toFixed(0)} KB)`);
    console.log(`[顶栏对比] 单条截图高度：${strips.map((s) => s.cssH).join(' / ')} CSS px`);
  } finally {
    await browser.close();
    srv.server.close();
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
