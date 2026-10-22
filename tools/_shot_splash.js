/* 只读预览：在 800×550 下渲染新版启动窗（public/splash.html），注入真实启动步骤后截图。
 * 不改产品代码，只产出 preview/_splash_*.png 供老板确认。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'preview');
const PORT = 8811;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
};

const STEPS = [
  '准备启动后端内核（src/main.startCore —— 数据库 / 采集模块都在这里加载）',
  '清理历史空消息与假号码',
  '校验知识库与 AI 配置',
  '生成浏览器插件连接令牌',
  '创建本地 HTTP 服务',
  '启动图片延时重抓',
  '启动器预热（Signal S1~S3）',
  '加载 Telegram 登录/登出控制器',
  '后端内核已就绪',
];

(async () => {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/splash.html';
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
  await page.setViewport({ width: 800, height: 550, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/splash.html`, { waitUntil: 'networkidle0' });

  // 逐条推步骤（模拟真实启动节奏）
  for (const s of STEPS) {
    await page.evaluate((label) => window.__addStep(label), s);
    await new Promise((r) => setTimeout(r, 120));
  }
  // 再等一会儿，让时间曲线把进度条推到「等待主窗口加载」的真实位置
  await new Promise((r) => setTimeout(r, 2600));
  await page.screenshot({ path: path.join(OUT, '_splash_mid.png') });
  const mid = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const app = document.querySelector('#app');
    return {
      pct: document.getElementById('pct').textContent,
      bar: document.getElementById('bar').style.width,
      rows: document.querySelectorAll('#list .step').length,
      body: { sw: document.body.scrollWidth, sh: document.body.scrollHeight, cw: document.body.clientWidth, ch: document.body.clientHeight },
      app: app ? { sw: app.scrollWidth, sh: app.scrollHeight } : null,
      img: r('.art img'),
      list: r('#list'),
      done: r('#done'),
      lastRow: r('#list .step:last-child'),
    };
  });

  // 收尾态
  await page.evaluate(() => window.__done());
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: path.join(OUT, '_splash_done.png') });
  const done = await page.evaluate(() => ({
    pct: document.getElementById('pct').textContent,
    state: document.getElementById('state').textContent,
  }));

  console.log('mid =', JSON.stringify(mid), 'done =', JSON.stringify(done));
  await browser.close();
  srv.close();
})();
