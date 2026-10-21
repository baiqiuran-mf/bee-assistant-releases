/**
 * v2.5.1063 截图：中栏头部 Signal 原装图标（20×20）实际显示效果
 * 跑法：node --experimental-sqlite test/shot_signal_icon.js
 * 产出：preview/Signal图标_中栏头部.png
 *
 * 说明：直接用真实 public/style.css + public/img/signal.svg 渲染一段中栏头部 HTML，
 *       确认图标尺寸与位置。不需要启动整个后端。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const PORT = 8987;

(async () => {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (e) { console.log('[跳过] 没装 puppeteer'); process.exit(0); }

  // 静态服务：把 ROOT 当根，/style.css 与 /img/signal.svg 都能解析
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = path.join(ROOT, 'public', p);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
    const ext = path.extname(fp);
    const mime = { '.css': 'text/css', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.html': 'text/html' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 520, height: 120, deviceScaleFactor: 2 });
    const HARNESS = `<!doctype html><html><head><base href="http://127.0.0.1:${PORT}/"><link rel="stylesheet" href="/style.css"></head>
<body style="margin:0;padding:30px;background:#fff">
<div id="chat-head"><div class="ch-name">
  <span class="cname">Dio（Signal 客户）</span>
  <span class="ch-signal" title="这个客户来自 Signal，不是 WhatsApp"><img class="ch-signal-ico" src="/img/signal.svg" width="20" height="20" alt="Signal"></span>
</div></div></body></html>`;
    await page.setContent(HARNESS, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));

    fs.mkdirSync(path.join(ROOT, 'preview'), { recursive: true });
    const shot = path.join(ROOT, 'preview', 'Signal图标_中栏头部.png');
    await page.screenshot({ path: shot, clip: { x: 20, y: 20, width: 460, height: 60 } });
    console.log('截图：' + shot);

    const info = await page.evaluate(() => {
      const el = document.querySelector('.ch-signal-ico');
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), src: el.getAttribute('src') };
    });
    console.log('图标实测：' + JSON.stringify(info));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  process.exit(0);
})();
