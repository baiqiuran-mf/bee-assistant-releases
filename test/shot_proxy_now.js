/**
 * 截图：全局设置 → 「代理」页的真实全貌（现状诊断用，2026-10-14）
 *
 * 目的：老板问「全局设置里代理的 WA① 代理」，需要用真图确认这一行到底存不存在。
 *   脚本会把**真实**的 proxies.json 灌进页面（隔离数据目录读不到真实值），
 *   这样截出来的就是老板实机上该看到的样子。
 *
 * 跑法：node test/shot_proxy_now.js
 * 产物：preview/代理页-现状.png（整页）
 */
const fs = require('fs');
const path = require('path');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8991;
const REAL_JSON = 'D:\\蜜蜂采集数据\\wa-assistant\\data\\proxies.json';

(async () => {
  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');

  const cfg = loadConfig();
  const srv = createServer(
    { db, doc, ai, knowledge, cfg, getAccountStates: () => [] },
    PORT
  );
  await new Promise((res, rej) => {
    srv.server.once('error', rej);
    srv.server.listen(PORT, '127.0.0.1', res);
  });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const outDir = path.join(ROOT, 'preview');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1320, height: 1000, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${PORT}/settings.html`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 800));

    const tab = await page.$('.set-tab[data-tab="proxy"]');
    if (tab) await tab.click();
    await new Promise((r) => setTimeout(r, 800));

    // 把真实 proxies.json 灌进页面，截出老板实机该看到的样子
    let real = null;
    try { real = JSON.parse(fs.readFileSync(REAL_JSON, 'utf8')); } catch (e) { /* 读不到就用页面默认 */ }
    if (real) {
      await page.evaluate((data) => { if (typeof renderProxyRows === 'function') renderProxyRows(data); }, real);
      await new Promise((r) => setTimeout(r, 300));
    }

    // 顺便把「页面上出现了哪些行」打印出来当文字证据
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('#proxy-body .px-row')].map((r) => ({
        key: r.dataset.key,
        name: (r.querySelector('.px-name') || {}).textContent,
        kind: (r.querySelector('.px-kind') || {}).textContent,
        on: !!(r.querySelector('[data-f="enabled"]') || {}).checked,
      }))
    );
    console.log('代理页当前的行：');
    rows.forEach((r) => console.log(`  [${r.key}] ${r.name} — ${r.kind} — 启用=${r.on}`));

    const sec = await page.$('#sec-proxy');
    if (sec) {
      await sec.screenshot({ path: path.join(outDir, '代理页-现状.png') });
      console.log('\n→ preview/代理页-现状.png');
    }
  } finally {
    await browser.close();
    srv.server.close();
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
