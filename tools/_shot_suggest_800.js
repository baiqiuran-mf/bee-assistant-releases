/* 只读诊断：在 800×800 下渲染真 suggest.html / style.css，注入示例建议，
 * 确认改成 800×800 固定窗口后排版正常。不改产品代码。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PORT = 8800;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

(async () => {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/suggest.html';
    if (p.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    const file = path.join(PUB, p.replace(/^\/+/, ''));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 800, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/suggest.html`, { waitUntil: 'networkidle0' });

  await page.evaluate(() => {
    const src = document.getElementById('suggest-src');
    if (src) src.innerHTML = '<b>客户说：</b>Thank you, that\'s sweet of you to say. Made my day a little brighter 😊';
    const wrap = document.getElementById('suggest-groups');
    if (!wrap) return;
    const opt = (angle, text) => `<div class="opt"><div class="angle">${angle}</div><div class="text">${text}</div><div class="acts"><button class="adopt">采纳</button><button class="noad">不采纳</button><button class="tr">翻译</button></div></div>`;
    const group = (msg, opts) => `<div class="sgroup"><div class="sg-head">客户说：${msg}</div><div class="sg-opts">${opts}</div></div>`;
    wrap.innerHTML =
      group('Thank you, that\'s sweet of you to say. Made my day a little brighter.',
        opt('共情', '看到你这句，我心里也暖了一下。能让你的一天亮一点点，这画就没白画。') +
        opt('故事', '我画土豆的时候也是这样，腿短短的，一扭一扭走过来，笑一下就够我乐半天。') +
        opt('轻推进', '我这两天正准备下一张的草稿，等你有空，我拍两张给你看看感觉。')) +
      group('I\'d love something with my dog, maybe a big canvas?',
        opt('共情', '能给陪你这么多年的它画一张，我懂这个心情。') +
        opt('故事', '我上次接的一张大幅，客户挂客厅，说每天进门都像它在等门。') +
        opt('轻推进', '大尺寸的选择有几种，我把尺寸和大概排期整理一下发你。')) +
      '<div class="again"><button id="suggest-again" class="ghost">都不行，换一批</button></div>';
  });
  await new Promise((r) => setTimeout(r, 400));

  await page.screenshot({ path: path.join(ROOT, '.tmp-suggest-800.png') });
  console.log('done 800x800');
  await browser.close();
  srv.close();
})().catch((e) => { console.error('ERR', (e && e.message) || e); process.exit(1); });
