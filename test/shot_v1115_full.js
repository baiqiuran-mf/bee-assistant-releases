/**
 * v2.6.1115 · 整窗截图（老板 18:56 要求：「一定要把整个软件都截出来，
 *   要不然我会认为缺少了什么」）
 *
 * 本版验证两件事：
 *   ① T② 点击修复 —— showNotice(level, text) 参数顺序原来传反了，
 *      导致提示框 text=undefined 永远空白 ⇒ 老板看着像"点了没反应"
 *   ② 顶栏四组齐全：一号~五号 / T①T② / S1~S2~S3 / 设置 一屏看全
 *
 * 跑法：node --experimental-sqlite test/shot_v1115_full.js
 */

const path = require('path');
const fs = require('fs');
require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8993;
const OUT = path.join(ROOT, 'preview');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const launcher = require('../src/launcher');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');
  const cfg = loadConfig();

  //🔴 必须在取 state 之前 init（生产由 src/main.js:2867 做），否则 S1~S3 返空
  launcher.init(cfg);

  const wa = (cfg.accounts || []).map((a) => ({ id: a.id, label: a.label, enabled: a.enabled !== false, status: 'online' }));
  const tg = ((cfg.telegram && cfg.telegram.accounts) || [])
    .filter((t) => t.enabled !== false)
    .map((t) => ({ id: Number(t.id), label: t.label, enabled: true, status: 'idle' }));
  const all = wa.concat(tg);

  // 用假 open：不真开浏览器（截图要的是界面反馈，不是弹窗）
  const calls = [];
  const srv = createServer({
    db, doc, ai, knowledge, cfg,
    launcher,
    getAccountStates: () => all,
    openTelegramAccount: async (id) => {
      calls.push(id);
      return { ok: true, id, label: 'Tele' + (id - 6) };
    },
  }, PORT);
  await new Promise((res, rej) => { srv.server.once('error', rej); srv.server.listen(PORT, '127.0.0.1', res); });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=zh-CN'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 40000 });
  await new Promise((r) => setTimeout(r, 2200));

  // 核验顶栏四组都在
  const top = await page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim());
    return {
      wa: q('#accounts .acct-name'),
      tg: q('#tg-accounts .acct-name'),
      s: q('#launcher-bar .launcher .lname'),
      idleStyled: [...document.querySelectorAll('#tg-accounts .acct')].map((e) => e.className),
    };
  });
  console.log('顶栏四组：');
  console.log('  ① 一号~五号 =', JSON.stringify(top.wa));
  console.log('  ② T 按钮  =', JSON.stringify(top.tg), top.idleStyled);
  console.log('  ③ S1~S3   =', JSON.stringify(top.s));
  if (top.wa.length !== 5) console.error('❌ 一号~五号不齐');
  if (top.tg.length < 1) console.error('❌ T 按钮没画出来');
  if (top.s.length !== 3) console.error('❌ S1~S3 不齐');

  // 图1：整窗（未点）
  const f1 = path.join(OUT, 'v1115-整窗-顶栏四组齐全.png');
  await page.screenshot({ path: f1 });
  console.log('OK → preview/' + path.basename(f1));

  // 图2：点 T② 之后的整窗 —— 核心验证：提示条这次必须有字
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#tg-accounts .acct-name')][1];
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 900));

  const notice = await page.evaluate(() => {
    const t = document.getElementById('toast');
    if (!t) return { found: false };
    const r = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    return { found: true, text: t.textContent.trim(), cls: t.className,
             w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
             visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
             opacity: cs.opacity };
  });
  console.log('\n===点完 T② 后的提示条 ===');
  console.log(JSON.stringify(notice, null, 2));
  console.log('后端收到：', JSON.stringify(calls));
  if (!notice.text) { console.error('❌ 提示条还是空的 —— 修复没生效！'); process.exit(1); }
  console.log('✅ 提示条有文字了（这就是修好的证据）');

  const f2 = path.join(OUT, 'v1115-整窗-点T②后有反馈.png');
  await page.screenshot({ path: f2 });
  console.log('OK → preview/' + path.basename(f2));

  // 图3：顶栏局部放大（四组一起看）
  await page.evaluate(() => {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:50%;background:rgba(15,23,42,.94);color:#fff;font-size:13px;font-weight:700;padding:9px 20px;border-radius:10px;z-index:100000;white-space:nowrap;';
    bar.textContent = 'v2.6.1115：点 T② 现在有明确提示了（提示条在窗口顶部黄色横条）';
    document.body.appendChild(bar);
  });
  const clip = await page.evaluate(() => {
    const h = document.querySelector('header').getBoundingClientRect();
    return { x: 0, y: Math.max(0, h.y), width: window.innerWidth, height: Math.min(h.height + 12, window.innerHeight) };
  });
  const f3 = path.join(OUT, 'v1115-顶栏局部-四组齐全.png');
  await page.screenshot({ path: f3, clip });
  console.log('OK → preview/' + path.basename(f3));

  await browser.close();
  srv.server.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });