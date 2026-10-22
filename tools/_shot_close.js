/* 只读预览：渲染关闭软件的「数据保存中」浮层（public/style.css 的真实样式），
 * 注入一段真实进度后截图，供老板确认「实际进度」的观感。不改产品代码。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'preview');
const PORT = 8823;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

(async () => {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    // 预览页在 preview/ 下，静态资源（style.css）在 public/ 下，分别映射
    if (p === '/' || p === '') p = '/preview.html';
    if (p === '/preview.html') {
      const f = path.join(ROOT, 'preview', '_close_overlay_preview.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(f));
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
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/preview.html`, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(OUT, '_close_overlay_mid.png') });

  // 收尾态：100%
  await page.evaluate(() => {
    document.getElementById('tm-sync-fill').style.width = '100%';
    document.getElementById('tm-sync-pct').textContent = '100%';
    document.getElementById('tm-sync-status').textContent = '客户档案已生成（67 份，12 张图片）';
  });
  await page.screenshot({ path: path.join(OUT, '_close_overlay_done.png') });
  console.log('close overlay shots saved');
  await browser.close();
  srv.close();
})();
