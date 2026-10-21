/*
 * Signal 状态灯 · 真实渲染截图（puppeteer headless）
 * 目的：肉眼确认这盏灯在真界面里长什么样 —— 绿灯/红灯/灰灯三态 + 悬停提示。
 * 输出：preview/Signal灯_绿灯.png / _红灯.png / _灰灯.png / _悬停提示.png
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SHOT = path.join(ROOT, 'preview');
const PORT = process.env.BEE_TEST_PORT || 39921;

const ACCOUNTS = [
  { id: 1, label: '主号', enabled: true, status: 'offline' },
  { id: 2, label: '二号', enabled: true, status: 'offline' },
  { id: 3, label: '三号', enabled: true, status: 'offline' },
  { id: 4, label: '四号', enabled: true, status: 'offline' },
  { id: 5, label: '五号', enabled: true, status: 'offline' },
];

const STATES = {
  green: { state: 'green', reason: 'Signal 已启动并登录（3 个会话 / 9 条消息）', running: true, loggedIn: true, conversations: 3, messages: 9 },
  red: { state: 'red', reason: 'Signal 没启动 —— 打开它并保持登录，软件才能读到新消息', running: false, loggedIn: false },
  unknown: null,
};

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });

  /*
   * 🔴 必须起真 HTTP 服务，不能用 file://
   *    index.html 里资源全是绝对路径（`/style.css?v=__BUILD__`），
   *    file:// 下解析不到 → 整页无样式，截出来是裸 HTML，看不出任何效果。
   *    （第一版就踩了这个，截出来连圆点都没有，还以为 CSS 写错了。）
   */
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url).split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    // 模拟 server.js 的构建戳替换
    if (p === '/index.html') {
      let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      html = html.replace(/__BUILD__/g, String(Date.now()));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    const f = path.join(ROOT, 'public', path.basename(p));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(f);
    const mime = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  console.log('静态服务已起：http://127.0.0.1:' + PORT + '/\n');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.5 });

  const origFetch = await page.evaluateOnNewDocument(() => { window.__of = window.fetch; });

  await page.evaluateOnNewDocument((port, accounts, states) => {
    window.fetch = function (input, init) {
      const u = String(input);
      const reply = (obj) => Promise.resolve(new Response(JSON.stringify(obj), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
      if (u.includes('/api/state')) {
        return reply({
          accounts, pending: 0, pendingMsgs: 0, unread: 0,
          aiReady: false, ai: {}, aiReason: '',
          signal: window.__sigState === undefined ? states.green : states[window.__sigState],
        });
      }
      if (u.includes('/api/signal/status')) return reply(Object.assign({ ok: true }, states.red));
      if (u.includes('/api/cloud')) return reply({ ok: true, configured: false });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, PORT, ACCOUNTS, STATES);

  await page.goto(`http://127.0.0.1:${PORT}/`, {
    waitUntil: 'networkidle0',
  });
  await new Promise((r) => setTimeout(r, 900));

  const box = async (name) => {
    const el = await page.$('#signal-lamp');
    if (!el) { console.log('❌ 没找到 #signal-lamp'); return; }
    await el.screenshot({ path: path.join(SHOT, `Signal灯_${name}.png`) });
    console.log('  截图 Signal灯_' + name + '.png');
  };
  const headBox = async (name) => {
    const el = await page.$('.head-bottom');
    if (el) { await el.screenshot({ path: path.join(SHOT, `Signal灯_${name}.png`) }); console.log('  截图 Signal灯_' + name + '.png（整行）'); }
  };

  console.log('=== 绿灯（已启动并登录）===');
  await box('绿灯');
  await headBox('绿灯整行');

  console.log('=== 红灯（没启动）===');
  await page.evaluate(() => { window.__sigState = 'red'; });
  await page.evaluate(() => { window.fetch('/api/state'); });
  await new Promise((r) => setTimeout(r, 300));
  await box('红灯');
  await headBox('红灯整行');

  console.log('=== 灰灯（还没测出来）===');
  await page.evaluate(() => { window.__sigState = 'unknown'; });
  await page.evaluate(() => { window.fetch('/api/state'); });
  await new Promise((r) => setTimeout(r, 300));
  await box('灰灯');

  console.log('=== 悬停提示（绿灯）===');
  await page.evaluate(() => { window.__sigState = 'green'; });
  await page.evaluate(() => { window.fetch('/api/state'); });
  await new Promise((r) => setTimeout(r, 300));
  const tip = await page.evaluate(() => document.getElementById('signal-lamp').title);
  console.log('  title = ' + JSON.stringify(tip));
  await headBox('悬停提示');

  console.log('\n全界面截图：');
  await page.screenshot({ path: path.join(SHOT, 'Signal灯_全界面.png') });

  await browser.close();
  srv.close();
  console.log('完成，图在 ' + SHOT);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
