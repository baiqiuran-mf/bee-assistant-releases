/**
 * v2.6.1115 · 真浏览器点T② 按钮 —— 看请求有没有发出去
 *
 * 老板 18:56：「T② 和 T③ 按钮没有反应」
 * 后端已实测 T①/T② 都 HTTP 200（浏览器真起来了）⇒ 断点只可能在
 *   ① 前端onclick 没绑上  ② 请求没发出  ③ 请求发出但界面毫无反馈（老板看不出开没开）
 *
 * 这个脚本在真浏览器里真点一下T②，抓网络请求 + 抓 showNotice 有没有出内容。
 * 跑法：node --experimental-sqlite test/probe_v1115_tgclick.js
 */

const path = require('path');
require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8994;
const OUT = path.join(ROOT, 'preview');

(async () => {
  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');
  const telegramRead = require('../src/telegramRead');
  const cfg = loadConfig();

  const tgAccs = (cfg.telegram && cfg.telegram.accounts) || [];
  const all = (cfg.accounts || []).map((a) => ({ id: a.id, label: a.label, enabled: a.enabled !== false, status: 'online' }))
    .concat(tgAccs.filter((t) => t.enabled !== false).map((t) => ({ id: Number(t.id), label: t.label, enabled: true, status: 'idle' })));

  // 用假openTelegramAccount：**不真开浏览器**（我们要看的是前端有没有发请求、有没有反馈）
  const calls = [];
  const srv = createServer({
    db, doc, ai, knowledge, cfg,
    getAccountStates: () => all,
    openTelegramAccount: async (id) => {
      calls.push(id);
      console.log(`   [后端收到] openTelegramAccount(${id})`);
      return { ok: true, id, label: 'Tele' + (id - 6) };
    },
  }, PORT);
  await new Promise((res, rej) => { srv.server.once('error', rej); srv.server.listen(PORT, '127.0.0.1', res); });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=zh-CN'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });

  const reqs = [];
  page.on('request', (r) => { if (r.url().includes('/api/telegram/account/')) reqs.push(r.method() + ' ' + r.url().replace(/^https?:\/\/[^/]+/, '')); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('   [页面报错]', m.text().slice(0, 160)); });

  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 40000 });
  await new Promise((r) => setTimeout(r, 2000));

  const before = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#tg-accounts .acct-name')];
    return {
      count: btns.length,
      labels: btns.map((b) => b.textContent.trim()),
      ids: btns.map((b) => b.dataset.id),
      hasOnclick: btns.map((b) => typeof b.onclick),
      rects: btns.map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; }),
      pointerEvents: btns.map((b) => getComputedStyle(b).pointerEvents),
      covered: btns.map((b) => { const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return el ? (el.tagName + '.' + (el.className || '')).slice(0, 60) : null; }),
    };
  });
  console.log('=== ① T 按钮初始状态 ===');
  console.log(JSON.stringify(before, null, 2));

  console.log('\n=== ② 真点第2 个（T②）===');
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#tg-accounts .acct-name')];
    const b = btns[1];
    if (!b) return { ok: false, why: '没有第2 个按钮' };
    b.click();
    return { ok: true, label: b.textContent.trim(), id: b.dataset.id };
  });
  console.log('   点击:', JSON.stringify(clicked));
  await new Promise((r) => setTimeout(r, 1500));

  const after = await page.evaluate(() => {
    const n = document.querySelector('#toast, .toast, #notice, .notice, .showNotice');
    const all = [];
    document.querySelectorAll('body *').forEach((e) => {
      const cs = getComputedStyle(e);
      if ((cs.position === 'fixed') && e.textContent.trim() && e.offsetHeight > 0 && e.offsetWidth > 0) {
        all.push({ tag: e.tagName, id: e.id, cls: (e.className || '').toString().slice(0, 40), txt: e.textContent.trim().slice(0, 60) });
      }
    });
    return { visibleFixed: all.slice(0, 12), toastText: n ? n.textContent.trim().slice(0, 80) : null };
  });
  console.log('\n=== ③ 点击后：后端收到的调用 ===', JSON.stringify(calls));
  console.log('=== ④ 前端发出的请求 ===', JSON.stringify(reqs));
  console.log('=== ⑤ 点击后页面上可见的浮层提示（=老板能不能看见反馈）===');
  console.log(JSON.stringify(after, null, 2));

  // showNotice 的实现到底写到哪
  const appSrc = require('fs').readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const i = appSrc.indexOf('function showNotice');
  console.log('\n=== ⑥ showNotice 实现 ===');
  console.log(appSrc.slice(i, i + 620));

  await browser.close();
  srv.server.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });