/**
 * 编排台「后期维护」页截图 —— 验证 Day7 之后那一页长什么样。
 *
 * 只读渲染：起一个临时服务 + 临时数据目录，不碰真实 data/。
 *
 * 跑法：node --experimental-sqlite tools/shot_day8.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
process.env.BEE_DATA_DIR = path.join(ROOT, '.tmp-shot-day8');

const db = require('../src/db');
const doc = require('../src/customerDoc');
const ai = require('../src/ai');
const knowledge = require('../src/knowledge');
const { createServer } = require('../src/server');
const { loadConfig } = require('../src/main');

(async () => {
  const cfg = loadConfig();
  const srv = createServer({
    db, doc, ai, knowledge, cfg,
    getAccountStates: () => (cfg.accounts || []).map((a) => ({
      id: a.id, label: a.label || `账号${a.id}`, enabled: !!a.enabled,
      status: 'offline', proxy: a.proxy || '',
    })),
    openAccount: async () => ({}),
    prefillChat: async () => ({ ok: true, method: 'prefill' }),
    simulateMessage: () => ({}),
    clearSimulated: () => {},
  }, 0);
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;

  // ⚠️ 看板接口要求客户必须存在（/api/board/:code 先查客户，没有就 404「读不到该客户的话术看板」）
  //    所以先用「手动录入」造一个客户，拿它的编号
  const mk = await fetch(`${base}/api/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ident: '+15418016666', region: '俄勒冈', accountId: 1, body: 'hi' }),
  }).then((r) => r.json());
  const code = (mk.customer && mk.customer.code) || mk.code;
  console.log('造了一个客户：' + code);

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 820 });
  await p.goto(`${base}/board.html?code=${code}`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));

  const outDir = path.join(ROOT, 'preview');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log('起始页签：' + (await p.$eval('#board-page', (e) => e.textContent)));

  // 一路点「下一页」，直到页签变成「后期维护」，最多点 10 次
  for (let i = 0; i < 10; i++) {
    const label = await p.$eval('#board-page', (e) => e.textContent);
    if (/后期维护/.test(label)) break;
    const disabled = await p.$eval('#board-next', (e) => e.disabled);
    if (disabled) { console.log('「下一页」在第 ' + (i + 1) + ' 次点击时已被置灰，翻不动了'); break; }
    await p.click('#board-next');
    await new Promise((r) => setTimeout(r, 260));
  }

  const info = await p.evaluate(() => {
    const label = document.getElementById('board-page').textContent;
    const next = document.getElementById('board-next').disabled;
    const prev = document.getElementById('board-prev').disabled;
    const cards = Array.from(document.querySelectorAll('#board-list > *')).map((e) => e.textContent.trim().slice(0, 40));
    return { label, next, prev, count: cards.length, cards: cards.slice(0, 14) };
  });

  console.log('\n页签：' + info.label);
  console.log('「上一页」置灰：' + info.prev + '   「下一页」置灰：' + info.next);
  console.log('左栏碎片数：' + info.count);
  info.cards.forEach((c, i) => console.log('  ' + (i + 1) + '. ' + c));

  const f = path.join(outDir, '编排台_后期维护页.png');
  await p.screenshot({ path: f });
  console.log('\n✓ ' + f);

  await browser.close();
  try { srv.server.close(); } catch (e) { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
