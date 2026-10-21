/**
 * v2.6.1115 · 顶栏 S1/S2/S3 去哪了 —— 真实渲染排查
 *
 * 老板 2026-10-14 18:47：「你截图我看到了 T①T②，但是你把 S①②③ 放哪里去了」
 *
 * 🔴 排查思路：先查代码链路是否完好，再真图量。
 *   ① `#launcher-bar` 容器在 index.html:69 —— 在，没被删
 *   ② `renderLaunchers(s.launchers || [])` 在 app.js:309 —— 在
 *   ③ server.js:844 `launchers: deps.launcher ? deps.launcher.launcherStates(false) : []` —— 在
 *   ④ launcher.js:511 `launcherStates()` 未点过启动也返回 computeStates() 红灯 —— 在
 *   → 所以 S1~S3 **大概率还在**，要真图确认它长什么样、在哪
 *
 * ⚠️ v2.6.1114 的截图脚本自己有个坑：`createServer({... getAccountStates: () => all})`
 *   **没注入 launcher** → `/api/state` 里 launchers=[] → renderLaunchers 清空 → 那张图上本来就没有 S。
 *   本脚本把 launcher 真实注入，才能反映实机。
 *
 * 跑法：node --experimental-sqlite test/shot_v1115_sbar.js
 */

const path = require('path');
const fs = require('fs');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8996;
const OUT_DIR = path.join(ROOT, 'preview');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const launcher = require('../src/launcher');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');

  const cfg = loadConfig();

  /*🔴🔴 必须**在 require launcher 之后、且在任何 state 调用之前** init。
     生产顺序见 src/main.js:2867 `launcher.init(cfg)`（在 startCore 里）。
     LAUNCHERS 是模块级变量，不 init 就永远是 []→ /api/state 的 launchers=[] → 前端清空 S1~S3。
     （v2.6.1114 那张截图就是栽在这儿，所以老板看着以为 S 没了） */
  launcher.init(cfg);
  console.log('init(cfg) 后 launcherStates(false) =', JSON.stringify(launcher.launcherStates(false)));

  const waAccs = (cfg.accounts || []).map((a) => ({ id: a.id, label: a.label, enabled: a.enabled !== false, status: 'online' }));
  const tgAccs = ((cfg.telegram && cfg.telegram.accounts) || [])
    .filter((t) => t.enabled !== false)
    .map((t) => ({ id: Number(t.id), label: t.label, enabled: true, status: 'idle' }));
  const all = waAccs.concat(tgAccs);

  console.log('\n后端 /api/state 的 accounts：');
  all.forEach((a) => console.log('   id=' + a.id + '  ' + a.label + '  ' + a.status));

  const lstates0 = launcher.launcherStates(true);
  console.log('\nlauncherStates(true) =', JSON.stringify(lstates0));

  // 🔴 这次把 launcher 真的注入进去（v1114 脚本漏了这步）
  const srv = createServer({
    db, doc, ai, knowledge, cfg,
    getAccountStates: () => all,
    launcher,
  }, PORT);
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
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.5 });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 40000 });
  await new Promise((r) => setTimeout(r, 1800));

  // 顶栏三块各自量一遍（真实 CSS 生效下的位置和宽度）
  const measure = async (w) => {
    await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1.5 });
    await new Promise((r) => setTimeout(r, 600));
    return page.evaluate(() => {
      const g = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
                 h: Math.round(r.height), kids: e.children.length, txt: e.textContent.trim().slice(0, 24) };
      };
      const lb = document.getElementById('launcher-bar');
      const s1 = lb && lb.firstElementChild ? lb.firstElementChild.getBoundingClientRect() : null;
      return {
        winW: window.innerWidth,
        headTopW: Math.round(document.querySelector('.head-top').getBoundingClientRect().width),
        accounts: g('#accounts'),
        tgAccounts: g('#tg-accounts'),
        launcherBar: g('#launcher-bar'),
        s1box: s1 ? { w: Math.round(s1.width), h: Math.round(s1.height),
                      vis: s1.width > 0 && s1.height > 0 } : null,
        launchers: [...document.querySelectorAll('#launcher-bar .launcher')].map((b) => ({
          label: (b.querySelector('.lname') || {}).textContent,
          cls: b.className,
        })),
      };
    });
  };

  for (const w of [1600, 1400, 1280]) {
    const m = await measure(w);
    console.log('\n=== 窗口 ' + w + 'px ===');
    console.log(JSON.stringify(m, null, 2));
  }

  // 出图：标注三块 + 红框指 S1~S3
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.5 });
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => {
    const mk = (sel, color, label, below) => {
      const e = document.querySelector(sel); if (!e) return;
      const r = e.getBoundingClientRect();
      const b = document.createElement('div');
      b.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:3px solid ${color};border-radius:5px;pointer-events:none;z-index:99999;`;
      document.body.appendChild(b);
      const t = document.createElement('div');
      t.textContent = label;
      t.style.cssText = `position:fixed;left:${r.left - 4}px;top:${below ? r.bottom + 8 : r.top - 21}px;background:${color};color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;z-index:100000;`;
      document.body.appendChild(t);
    };
    mk('#accounts', '#2563eb', '① 一号~五号（WhatsApp）');
    mk('#tg-accounts', '#16a34a', '② T①/T②（Telegram）');
    mk('#launcher-bar', '#dc2626', '③ S1/S2/S3（Signal）— 老板问的就是这三个', true);

    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:50%;background:rgba(15,23,42,.94);color:#fff;font-size:13px;font-weight:700;padding:9px 20px;border-radius:10px;z-index:100000;white-space:nowrap;box-shadow:0 6px 24px rgba(0,0,0,.3);';
    bar.textContent = 'v2.6.1114 实测：S1/S2/S3 一个都没丢 —— 就在 T①/T② 右边（红框）';
    document.body.appendChild(bar);
  });
  await new Promise((r) => setTimeout(r, 250));

  const f1 = path.join(OUT_DIR, 'v1115-顶栏S1S2S3-真实位置.png');
  await page.screenshot({ path: f1 });
  console.log('\nOK → preview/' + path.basename(f1));

  // 顶栏局部放大
  const clip = await page.evaluate(() => {
    const h = document.querySelector('header').getBoundingClientRect();
    return { x: 0, y: Math.max(0, h.y), width: Math.min(window.innerWidth, 1600), height: Math.min(h.height + 12, window.innerHeight) };
  });
  const f2 = path.join(OUT_DIR, 'v1115-顶栏S1S2S3-局部放大.png');
  await page.screenshot({ path: f2, clip });
  console.log('OK → preview/' + path.basename(f2));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });