/* 只读诊断：起静态服务加载真 settings.html / style.css / settings.js，
 * 把提示条显示出来，截「保存」那一行，用于确认老板 2026-10-18 指定的新位置。
 * 不改产品代码、不写数据库。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PORT = 8799;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

(async () => {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/settings.html';
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '（截图预览：无后端）' }));
      return;
    }
    const file = path.join(PUB, p.replace(/^\/+/, ''));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nf'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 740, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/settings.html`, { waitUntil: 'networkidle0' });

  await page.evaluate(() => {
    const h = document.getElementById('ai-hint');
    if (h) h.textContent = '8 个 AI 全部就绪。改完记得保存。';
    if (typeof showNotice === 'function') {
      showNotice('ok', '混元 Hy3（腾讯 TokenHub）连接正常（5446ms）', 600000);
    }
  });
  await new Promise((r) => setTimeout(r, 500));

  await page.screenshot({ path: path.join(ROOT, '.tmp-settings-full.png') });

  const box = await page.evaluate(() => {
    const f = document.querySelector('#sec-ai .ai-foot');
    if (!f) return null;
    const r = f.getBoundingClientRect();
    const t = document.getElementById('ai-toast');
    const tr = t ? t.getBoundingClientRect() : null;
    return { x: r.x, y: r.y, w: r.width, h: r.height, toast: tr ? { x: tr.x, w: tr.width } : null };
  });
  console.log('footer box:', JSON.stringify(box));
  if (box) {
    const x = Math.max(0, box.x - 8);
    const y = Math.max(0, box.y - 10);
    await page.screenshot({
      path: path.join(ROOT, '.tmp-settings-foot.png'),
      clip: { x, y, width: Math.min(1000 - x, box.w + 16), height: box.h + 20 },
    });
  }

  await browser.close();
  srv.close();
  console.log('done');
})().catch((e) => { console.error('ERR', (e && e.message) || e); process.exit(1); });
