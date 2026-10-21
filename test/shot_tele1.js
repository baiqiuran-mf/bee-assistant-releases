/**
 * v2.5.1085 专用截图：Tele① 页签（原生会话列表 + 右侧翻译气泡面板）
 * 跑法：node --experimental-sqlite test/shot_tele1.js
 * 产出：preview/Tele①_地址栏与右面板状态区.png
 *
 * 说明：v2.5.1085 起 Tele① 改为原生 UI（数据来自 MTProto 落库，不再加载 web.telegram.org 网页）。
 *       这张图要看的是**布局**：左侧原生会话列表、右侧对话气泡面板。
 */
const fs = require('fs');
const path = require('path');
require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8982;

const FAKE_ACCOUNTS = [
  { id: 1, label: '一号', status: 'online', enabled: true, proxy: '' },
  { id: 2, label: '二号', status: 'offline', enabled: true, proxy: '' },
];

(async () => {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (e) {
    console.log('[跳过] 没装 puppeteer'); process.exit(0);
  }

  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');

  const cfg = loadConfig();
  const srv = createServer({ db, doc, ai, knowledge, cfg, getAccountStates: () => FAKE_ACCOUNTS }, PORT);
  await new Promise((res, rej) => { srv.server.once('error', rej); srv.server.listen(PORT, '127.0.0.1', res); });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 820 });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 800));

    // 切到 Tele① 页签
    await page.evaluate(() => {
      const t = document.querySelector('.mtab[data-mp="tele1"]');
      if (t) t.click();
    });
    await new Promise((r) => setTimeout(r, 800));

    fs.mkdirSync(path.join(ROOT, 'preview'), { recursive: true });
    const shot = path.join(ROOT, 'preview', 'Tele①_地址栏与右面板状态区.png');
    await page.screenshot({ path: shot });
    console.log('截图：' + shot);

    // 顺带把关键元素的位置量出来（做证据）
    const box = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      return {
        listHead: rect('.tg-list-head'),
        listRefresh: rect('#btn-tg-list-refresh'),
        list: rect('#tg-list'),
        convTitle: rect('#tg-chat-title'),
        convRefresh: rect('#btn-tg-conv-refresh'),
        body: rect('#tg-conv-body'),
      };
    });
    console.log(JSON.stringify(box, null, 2));
  } finally {
    await browser.close();
    await new Promise((r) => srv.server.close(r));
  }
  process.exit(0);
})();
