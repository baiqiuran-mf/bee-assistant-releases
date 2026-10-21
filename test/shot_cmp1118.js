/**
 * v2.6.1118 排版对比：真实渲染「通用」档案卡 与「Tele①」档案卡，拼成一张对比大图。
 * 让老板一眼看出两边差在哪（尤其是宽度）。
 */
const path = require('path');
const fs = require('fs');
const { DIR } = require('./_isolate.js');
const ROOT = path.join(__dirname, '..');
const PORT = 8990;
const OUT = path.join(ROOT, 'preview');

const FAKE_ACCOUNTS = [
  { id: 1, label: '一号', status: 'online', enabled: true, proxy: '' },
  { id: 7, label: 'Tele①', status: 'online', enabled: true, proxy: '' },
];

(async () => {
  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');
  const cfg = loadConfig();
  const srv = createServer({ db, doc, ai, knowledge, cfg, getAccountStates: () => FAKE_ACCOUNTS }, PORT);
  await new Promise((res, rej) => { srv.server.once('error', rej); srv.server.listen(PORT, '127.0.0.1', res); });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('typeof renderChatHead === "function"', { timeout: 20000 });

  // ① 通用档案卡
  const g = await page.evaluate(() => {
    switchMidTab('general');
    renderChatHead({
      code: '1A00001', name: 'Richard Bennett', created_at: new Date(Date.now() - 86400000 * 2).toISOString(),
      timezone: 'America/New_York', region: '纽约',
    }, {});
    const el = document.querySelector('#chat-head .tv-card');
    const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y),
             text: el.textContent.replace(/\s+/g, ' ').trim() };
  });
  const gb = await page.evaluate(() => {
    const b = document.querySelector('#chat-head .tv-card').getBoundingClientRect();
    return { x: Math.round(b.x) - 6, y: Math.round(b.y) - 6, width: Math.round(b.width) + 12, height: Math.round(b.height) + 12 };
  });
  await page.screenshot({ path: path.join(OUT, '_cmp-general.png'), clip: gb });

  // ② Tele① 档案卡（真实切到 Tele① 页签）
  const t = await page.evaluate(() => {
    switchMidTab('tele1');
    renderTgProfile({
      code: '730007', name: 'Richard Bennett', created_at: new Date(Date.now() - 86400000 * 2).toISOString(),
      timezone: 'America/New_York', region: '纽约',
    }, '', 'tele1');
    const el = document.querySelector('#tg-profile');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height),
             text: el.textContent.replace(/\s+/g, ' ').trim() };
  });
  let tb = null;
  if (t) {
    tb = await page.evaluate(() => {
      const b = document.querySelector('#tg-profile').getBoundingClientRect();
      return { x: Math.round(b.x) - 6, y: Math.round(b.y) - 6, width: Math.round(b.width) + 12, height: Math.round(b.height) + 12 };
    });
    await page.screenshot({ path: path.join(OUT, '_cmp-tele.png'), clip: tb });
  }

  console.log('通用档案卡 = ' + g.w + ' x ' + g.h + ' px');
  console.log('  ' + g.text);
  console.log('');
  if (t) {
    console.log('Tele① 档案卡 = ' + t.w + ' x ' + t.h + ' px');
    console.log('  ' + t.text);
  } else {
    console.log('Tele① 档案卡没渲染出来');
  }
  if (t) console.log('\n宽度差 = ' + (g.w - t.w) + ' px（通用宽 ' + g.w + ' / Tele 窄 ' + t.w + '）');

  await browser.close();
  srv.server.close();
  process.exit(0);
})().catch((e) => { console.error('[ERR]', (e && e.message) || e); process.exit(1); });