/**
 * v2.6.1118 真截图：① 通用标签档案卡（新竖排一栏）② Tele① 档案卡（旧版）③ 按钮文案「对话提档」
 * 走真实 createServer + puppeteer，整窗截，脚本自带硬断言。
 */
const path = require('path');
const fs = require('fs');
const { DIR } = require('./_isolate.js');
const ROOT = path.join(__dirname, '..');
const PORT = 8989;
const OUT = path.join(ROOT, 'preview');

const FAKE_ACCOUNTS = [
  { id: 1, label: '一号', status: 'online', enabled: true, proxy: '' },
  { id: 2, label: '二号', status: 'online', enabled: true, proxy: '' },
  { id: 7, label: 'Tele①', status: 'online', enabled: true, proxy: '' },
  { id: 8, label: 'Tele②', status: 'online', enabled: true, proxy: '' },
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

  // ── 通用标签：渲染新档案卡 ──
  const r1 = await page.evaluate(() => {
    renderChatHead({
      code: '1A00001', name: 'Richard Bennett', created_at: new Date(Date.now() - 86400000 * 2).toISOString(),
      timezone: 'America/New_York', region: '纽约', stage_day: 1,
    }, {});
    const card = document.querySelector('#chat-head .tv-card');
    const lines = [...document.querySelectorAll('#chat-head .tv-ln')].map((x) => x.textContent.replace(/\s+/g, ' ').trim());
    const btns = [...document.querySelectorAll('#chat-head .tv-actions button')].map((b) => b.textContent.trim());
    return {
      hasCard: !!card,
      cardH: card ? Math.round(card.getBoundingClientRect().height) : 0,
      lines, btns,
      headText: (document.querySelector('#chat-head')?.textContent || '').replace(/\s+/g, ' ').trim(),
    };
  });

  await page.screenshot({ path: path.join(OUT, 'v1118-通用档案卡-整窗.png') });
  // 只截档案卡那块，放大看得清
  const cardBox = await page.evaluate(() => {
    const el = document.querySelector('#chat-head .tv-card');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x) - 8, y: Math.round(b.y) - 8, width: Math.round(b.width) + 16, height: Math.round(b.height) + 16 };
  });
  if (cardBox) await page.screenshot({ path: path.join(OUT, 'v1118-通用档案卡-局部放大.png'), clip: cardBox });

  // ── Tele①：旧档案卡，用来对照 ──
  const r2 = await page.evaluate(() => {
    switchMidTab('tele1');
    renderTgProfile({
      code: '730007', name: 'Richard Bennett', created_at: new Date(Date.now() - 86400000 * 2).toISOString(),
      timezone: 'America/New_York', region: '纽约',
    }, '', 'tele1');
    const card = document.querySelector('#tg-profile');
    const lines = [...document.querySelectorAll('#tg-profile .tv-ln')].map((x) => x.textContent.replace(/\s+/g, ' ').trim());
    const btns = [...document.querySelectorAll('#tg-profile .tv-actions button')].map((b) => b.textContent.trim());
    return { hasCard: !!card, lines, btns };
  });
  const teleBox = await page.evaluate(() => {
    const el = document.querySelector('#tg-profile');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    if (b.width <= 0) return null;
    return { x: Math.round(b.x) - 8, y: Math.round(b.y) - 8, width: Math.round(b.width) + 16, height: Math.round(b.height) + 16 };
  });
  if (teleBox) await page.screenshot({ path: path.join(OUT, 'v1118-Tele档案卡-对照.png'), clip: teleBox });

  // ── 硬断言 ──
  const errs = [];
  if (!r1.hasCard) errs.push('通用档案卡没渲染出来');
  if (r1.lines.length < 4) errs.push('竖排行数不足 4（实际 ' + r1.lines.length + '）');
  if (!/加入时间/.test(r1.lines[0])) errs.push('第一行不是「加入时间」');
  if (!r1.lines.some((x) => /认识第 \d+ 天/.test(x))) errs.push('缺「认识第 N 天」');
  if (!r1.lines.some((x) => /地区/.test(x))) errs.push('缺「地区」');
  if (!r1.lines.some((x) => /客户当地时间/.test(x))) errs.push('缺「客户当地时间」');
  const want = ['↗ 跳到聊天', '客户档案', '对话提档'];
  if (JSON.stringify(r1.btns) !== JSON.stringify(want)) errs.push('按钮不对：' + JSON.stringify(r1.btns));
  if (r2.btns && r2.btns.length && !r2.btns.some((b) => b === '对话提档')) errs.push('Tele 侧按钮没改名：' + JSON.stringify(r2.btns));

  console.log('=== 通用档案卡（改后）===');
  console.log('  高度 =', r1.cardH, 'px');
  r1.lines.forEach((l, i) => console.log('  行' + (i + 1) + ' [' + l + ']'));
  console.log('  按钮 =', JSON.stringify(r1.btns));
  console.log('');
  console.log('=== Tele① 档案卡（对照，本版没动它）===');
  (r2.lines || []).forEach((l, i) => console.log('  行' + (i + 1) + ' [' + l + ']'));
  console.log('  按钮 =', JSON.stringify(r2.btns));
  console.log('');
  console.log(errs.length === 0 ? '✅ 全部断言通过' : '❌ ' + errs.length + ' 项不通过：\n   - ' + errs.join('\n   - '));

  await browser.close();
  srv.server.close();
  process.exit(errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('[ERR]', (e && e.message) || e); process.exit(1); });