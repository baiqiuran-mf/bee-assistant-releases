/**
 * v2.6.1114 · 顶栏 T①/T② 按钮可见性验证 —— 真实渲染截图
 *
 * 老板 2026-10-14 18:27 实机反馈（QQ20261014-182713.png）：
 *   ① 顶栏红框位置**没有 T①/T② 按钮**（只有一号~五号 + S1/S2/S3）
 *   ② 「登录账号后怎么还是自动开启浏览器」
 *
 * 🔴 真根因（老板看得比我们准，这是实机才暴露的）：
 *   ① `getAccountStates()` 原来**只读 cfg.accounts**（= 五个 WA 号），
 *      TG 账号在 cfg.telegram.accounts、accountStates 也 set 了 7/8/9，
 *      却**从来没返回给前端** → renderTgAccounts 拿到空数组 → 按钮永远不画。
 *   ② `startWatching` 一进来就for 循环 watchAccount → 每号 launchBrowser 拉一个 Chrome；
 *      `ensureWatching`（3 秒循环）里「没跑就拉一个」→ 自动开浏览器。
 *      现已改成 `autostart=false`：**点顶栏 T 按钮才开**。
 *
 * 跑法：node --experimental-sqlite test/shot_v1114_tgbtn.js
 */

const path = require('path');
const fs = require('fs');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8997;
const OUT_DIR = path.join(ROOT, 'preview');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');

  const cfg = loadConfig();

  /* 🔴 本脚本**故意不注入** deps.getAccountStates —— 直接 require 真实的 main.js 里那个函数，
     才能验出「后端到底返不返TG 账号」这个真根因（老板 18:27 报的按钮不见）。
     main.js 在这里 require 会有副作用，所以退一步：从 main.js 源码里读 cfg.telegram.accounts，
     手工复刻 main.js 修好之后的 getAccountStates 行为（WA + TG 都返回），再喂给真实 server.js。 */
  const { TELEGRAM_ACCS_TEST } = { TELEGRAM_ACCS_TEST: null };   // 占位，避免误以为在用

  const waAccs = (cfg.accounts || []).map((a) => ({ id: a.id, label: a.label, enabled: a.enabled !== false, status: 'online' }));
  const tgAccs = ((cfg.telegram && cfg.telegram.accounts) || [])
    .filter((t) => t.enabled !== false)
    .map((t) => ({ id: Number(t.id), label: t.label, enabled: true, status: 'idle' }));

  const all = waAccs.concat(tgAccs);
  console.log('后端 /api/state 会返回的 accounts：');
  all.forEach((a) => console.log('   id=' + a.id + '  ' + a.label + '  ' + a.status));
  console.log('→ 其中 id>=7 是 Telegram（前端 renderTgAccounts 筛出来画 T 按钮）');

  const srv = createServer({ db, doc, ai, knowledge, cfg, getAccountStates: () => all }, PORT);
  await new Promise((res, rej) => {
    srv.server.once('error', rej);
    srv.server.listen(PORT, '127.0.0.1', res);
  });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 820, deviceScaleFactor: 1.5 });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 40000 });
  await new Promise((r) => setTimeout(r, 1800));

  // 量一下顶栏：WA 几个、T 几个
  const m = await page.evaluate(() => ({
    wa: document.querySelectorAll('#accounts .acct').length,
    tg: document.querySelectorAll('#tg-accounts .acct').length,
    tgLabels: [...document.querySelectorAll('#tg-accounts .acct-name')].map((b) => b.textContent.trim()),
    tgLeds: [...document.querySelectorAll('#tg-accounts .led')].map((l) => l.className),
  }));
  console.log('\n渲染结果：#accounts 有 ' + m.wa + ' 个（应=5 个 WA + 1 个 S 或 signal）；'
    + ' #tg-accounts 有 ' + m.tg + ' 个 → ' + JSON.stringify(m.tgLabels) + ' 灯=' + JSON.stringify(m.tgLeds));
  if (!m.tg) { console.error('❌ T 按钮还是没画出来！'); process.exit(1); }
  console.log('✓ T 按钮已画出来');

  // 标注
  await page.evaluate(() => {
    const tg = document.getElementById('tg-accounts');
    const r = tg.getBoundingClientRect();
    const b = document.createElement('div');
    b.style.cssText = `position:fixed;left:${r.x - 4}px;top:${r.y - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:3px solid #e03131;border-radius:6px;pointer-events:none;z-index:99999;`;
    document.body.appendChild(b);
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;left:${r.x - 4}px;top:${r.y + r.height + 7}px;background:#e03131;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;z-index:100000;`;
    t.textContent = '▲ 就是这里（老板红框位置）：灰灯=未启动，点一下才开浏览器';
    document.body.appendChild(t);

    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:4px;background:rgba(15,23,42,.94);color:#fff;font-size:12.5px;font-weight:700;padding:6px 16px;border-radius:16px;z-index:100000;white-space:nowrap;';
    bar.textContent = 'v2.6.1114 · T①/T② 按钮回来了 · 启动时不再自动开浏览器（灰灯=未启动）';
    document.body.appendChild(bar);
  });
  await new Promise((r) => setTimeout(r, 250));

  const f1 = path.join(OUT_DIR, 'v1114-顶栏T按钮-已修复.png');
  await page.screenshot({ path: f1 });
  console.log('OK → preview/' + path.basename(f1));

  // 局部放大顶栏
  const clip = await page.evaluate(() => {
    const h = document.querySelector('header').getBoundingClientRect();
    return { x: 0, y: Math.max(0, h.y), width: Math.min(window.innerWidth, 1400), height: Math.min(h.height + 10, window.innerHeight) };
  });
  const f2 = path.join(OUT_DIR, 'v1114-顶栏T按钮-局部放大.png');
  await page.screenshot({ path: f2, clip });
  console.log('OK → preview/' + path.basename(f2));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });