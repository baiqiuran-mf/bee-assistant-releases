/**
 * v2.6.1118 诊断：真实 server 下量「通用」中栏两栏布局的几何 + 截图。
 * 只读，不改任何生产文件。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

(async () => {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(PUBLIC, p);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 400));

  const geo = await page.evaluate(() => {
    const box = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) };
    };
    return {
      chat: box('#chat'), midTabs: box('.mid-tabs'),
      general: box('.mid-pane[data-mp="general"]'), genWrap: box('.gen-wrap'),
      genChat: box('#gen-chat'), tgcHead: box('.mid-pane[data-mp="general"] .tgc-head'),
      genBody: box('#gen-chat-body'), msgs: box('#msgs'), foot: box('#chat-foot'),
      aside: box('#chat-head'), card: box('#ch-head-slot'),
      tele1Aside: box('.mid-pane[data-mp="tele1"] .tg-conv-aside'),
      tele1Card: box('.mid-pane[data-mp="tele1"] .tv-card'),
    };
  });
  console.log(JSON.stringify(geo, null, 1));

  const outDir = path.join(ROOT, 'preview');
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, 'v1118-通用两栏-整窗.png') });

  // 只截中栏（含左右两栏）
  const clip = geo.general;
  await page.screenshot({ path: path.join(outDir, 'v1118-通用两栏-中栏.png'), clip: { x: clip.left, y: clip.top, width: clip.w, height: clip.h } });

  await browser.close();
  srv.close();
})();
