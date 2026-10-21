/**
 * v2.6.1116 · 整窗截图 —— T①②③ 全开 + 顶栏四组 + 配置漂移告警条
 *
 * 关键：用**实机那份** config（BEE_CONFIG 指向 D 盘那份），
 * 否则截出来的是仓库那份=T②/T③ enabled:false，老板看着又以为没修好。
 *
 * 跑法：BEE_CONFIG="D:/蜜蜂采集数据/wa-assistant/config.yaml" \
 *       node --experimental-sqlite test/shot_v1116_full.js
 */

const path = require('path');
const fs = require('fs');
require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8992;
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
  const paths = require('../src/paths');

  const cfg = loadConfig();
  launcher.init(cfg);
  console.log('本脚本读的配置 =', paths.configFile());

  const tgs = (cfg.telegram.accounts || []);
  console.log('TG 三号实况:', JSON.stringify(tgs.map((t) => ({
    id: t.id, label: t.label, enabled: t.enabled !== false, wa: Number(t.waAccount) || 0,
    cdp: t.cdpProfile, port: t.cdpPort,
  }))));

  const wa = (cfg.accounts || []).map((a) => ({ id: a.id, label: a.label, enabled: a.enabled !== false, status: 'online' }));
  const tg = tgs.filter((t) => t.enabled !== false)
    .map((t) => ({ id: Number(t.id), label: t.label, enabled: true, status: 'idle' }));
  const all = wa.concat(tg);

  const calls = [];
  const srv = createServer({
    db, doc, ai, knowledge, cfg, launcher,
    getAccountStates: () => all,
    // 模拟 main.js configDriftCheck 的返回（一致 → 空 diff）
    configDrift: { checked: true, repo: path.join(ROOT, 'config.yaml'), active: paths.configFile(), diff: [] },
    openTelegramAccount: async (id) => { calls.push(id); return { ok: true, id }; },
  }, PORT);
  await new Promise((res, rej) => { srv.server.once('error', rej); srv.server.listen(PORT, '127.0.0.1', res); });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=zh-CN'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 40000 });
  await new Promise((r) => setTimeout(r, 2200));

  const top = await page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim());
    return {
      wa: q('#accounts .acct-name'), tg: q('#tg-accounts .acct-name'), s: q('#launcher-bar .launcher .lname'),
      driftHidden: document.getElementById('config-drift-bar').classList.contains('hidden'),
    };
  });
  console.log('\n顶栏：① 一号~五号', JSON.stringify(top.wa));
  console.log('      ② T 按钮  ', JSON.stringify(top.tg));
  console.log('      ③ S1~S3   ', JSON.stringify(top.s));
  console.log('      漂移告警条 是否隐藏 =', top.driftHidden, '（true=两份一致，不该出现红条）');

  if (top.wa.length !== 5) { console.error('❌ 一号~五号不齐'); process.exit(1); }
  if (top.tg.length !== 3) { console.error('❌ T按钮不是 3 个'); process.exit(1); }
  if (top.s.length !== 3) { console.error('❌ S1~S3 不齐'); process.exit(1); }

  // 图1：整窗（干净，无标注）
  const f1 = path.join(OUT, 'v1116-整窗-顶栏T123全开.png');
  await page.screenshot({ path: f1 });
  console.log('OK → preview/' + path.basename(f1));

  // 图2：点 T② 之后（提示条有字）
  await page.evaluate(() => { const b = [...document.querySelectorAll('#tg-accounts .acct-name')][1]; if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 900));
  const notice = await page.evaluate(() => {
    const t = document.getElementById('toast');
    const r = t.getBoundingClientRect();
    return { text: t.textContent.trim(), visible: r.width > 0 && r.height > 0 };
  });
  console.log('\n点 T② 后提示条:', JSON.stringify(notice), ' 后端收到:', JSON.stringify(calls));
  if (!notice.text) { console.error('❌ 提示条空的'); process.exit(1); }
  const f2 = path.join(OUT, 'v1116-整窗-点T2有反馈.png');
  await page.screenshot({ path: f2 });
  console.log('OK → preview/' + path.basename(f2));

  // 图3：配置漂移告警条演示（故意传一个非空 diff）
  const srv2 = createServer({
    db, doc, ai, knowledge, cfg, launcher,
    getAccountStates: () => all,
    configDrift: {
      checked: true, repo: path.join(ROOT, 'config.yaml'), active: paths.configFile(),
      diff: ['T2 enabled 不一致：仓库 true / 软件读的 false', 'T3 enabled 不一致：仓库 true / 软件读的 false'],
    },
    openTelegramAccount: async (id) => ({ ok: true, id }),
  }, PORT + 1);
  await new Promise((res) => srv2.server.listen(PORT + 1, '127.0.0.1', res));
  const p3 = await browser.newPage();
  await p3.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
  await p3.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  await p3.goto('http://127.0.0.1:' + (PORT + 1) + '/', { waitUntil: 'networkidle2', timeout: 40000 });
  await new Promise((r) => setTimeout(r, 2200));
  const drift = await p3.evaluate(() => {
    const b = document.getElementById('config-drift-bar');
    const t = document.getElementById('cd-txt');
    const d = document.getElementById('cd-detail');
    return { hidden: b.classList.contains('hidden'), txt: t.textContent.trim(), detail: d.textContent.trim(),
             h: Math.round(b.getBoundingClientRect().height) };
  });
  console.log('\n漂移告警条演示:', JSON.stringify(drift, null, 2));
  if (drift.hidden) { console.error('❌ 告警条没出来'); process.exit(1); }
  const f3 = path.join(OUT, 'v1116-整窗-配置对不上时的红条.png');
  await p3.screenshot({ path: f3 });
  console.log('OK → preview/' + path.basename(f3));

  // 图4：顶栏局部放大（四组 + 三号）
  const clip = await page.evaluate(() => {
    const h = document.querySelector('header').getBoundingClientRect();
    return { x: 0, y: Math.max(0, h.y), width: window.innerWidth, height: Math.min(h.height + 12, window.innerHeight) };
  });
  const f4 = path.join(OUT, 'v1116-顶栏局部-四组含T123.png');
  await page.screenshot({ path: f4, clip });
  console.log('OK → preview/' + path.basename(f4));

  await browser.close();
  srv.server.close(); srv2.server.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });