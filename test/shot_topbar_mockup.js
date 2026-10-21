/**
 * 拟改预览（不改任何 app 代码）：把「界面最上方 UI（顶栏）」改成蓝色
 *
 * 背景（老板 2026-10-13 看图 QQ20261013-225832.png，红框+红箭头指向界面最上方那一行）：
 *   老板要求把界面最上方的顶栏 UI 设成蓝色。
 *
 * 做法：与 test/shot_notice_mockup.js 同款 —— puppeteer 载入**真实 index.html**，
 *      只在本次渲染里注入「拟改 CSS」（page.addStyleTag），截顶栏区域。一个字都没写进 app。
 *
 * 两套方案各截一张，给老板挑：
 *   A：只有最上面那行（品牌行 .head-top）变蓝 —— 更贴合红框范围
 *   B：整个顶栏（品牌行 + 账号条 .head-bottom）都变蓝 —— 更像一整条蓝色 header
 *
 * 跑法：node --experimental-sqlite test/shot_topbar_mockup.js
 * 产物：preview/顶栏-现状.png / 顶栏-蓝A.png / 顶栏-蓝B.png
 */
const fs = require('fs');
const path = require('path');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8985;

// 蓝色（顶栏底色，取 app 现有主蓝 --accent #2563eb 的深一档，更稳）
const BLUE = '#2563eb';
const BLUE_DARK = '#1e4fb8';
const BLUE_VER = '#ffd9a8';

// 方案 A：只把品牌行 .head-top 变蓝（顶到 header 三边）
const CSS_A = `
header { padding: 0; gap: 0; }
.head-top {
  background: ${BLUE};
  padding: 10px 16px;
  color: #fff;
}
.head-top .brand { color: #fff; }
.head-top .ver { color: ${BLUE_VER}; }
.head-top .build { color: rgba(255,255,255,.72); }
.head-top .ghost { color: #fff; border-color: rgba(255,255,255,.55); background: rgba(255,255,255,.12); }
.head-top .ghost:hover { background: rgba(255,255,255,.22); }
.head-top #status.green { color: #8dffb8; }
.head-top #status.red { color: #ff9a9a; }
.head-bottom { padding: 10px 16px; }
`;

// 方案 B：整个顶栏（两行）都变蓝
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

// 给空账号条塞演示数据（隔离数据下没有真实账号），让顶栏长得和老板截图一致
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
  const b = document.getElementById('build'); if (b) b.textContent = '构建戳 20261013-2309';
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

  const outDir = path.join(ROOT, 'preview');
  fs.mkdirSync(outDir, { recursive: true });

  const shotHeader = async (page, file) => {
    await new Promise((r) => setTimeout(r, 400));
    const clip = await page.evaluate(() => {
      const h = document.querySelector('header');
      const r = h.getBoundingClientRect();
      return { x: 0, y: 0, width: document.documentElement.clientWidth, height: Math.ceil(r.bottom) + 26 };
    });
    await page.screenshot({ path: path.join(outDir, file), clip });
  };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 900, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1000));
    await page.evaluate(SAMPLE_TOP);
    await shotHeader(page, '顶栏-现状.png');

    await page.addStyleTag({ content: CSS_A });
    await page.evaluate(SAMPLE_TOP);
    await shotHeader(page, '顶栏-蓝A.png');

    // 换页重来，避免 A 的 style 叠加影响 B
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1360, height: 900, deviceScaleFactor: 2 });
    await page2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1000));
    await page2.addStyleTag({ content: CSS_B });
    await page2.evaluate(SAMPLE_TOP);
    await shotHeader(page2, '顶栏-蓝B.png');

    console.log('预览已生成：preview/顶栏-现状.png · 顶栏-蓝A.png · 顶栏-蓝B.png');
  } finally {
    await browser.close();
    srv.server.close();
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
