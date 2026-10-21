/*
 * Signal 状态灯 · 定位放大截图
 * 目的：在真实的顶栏位置上截一张放大的图，方便肉眼确认灯的样式对不对
 *（整行截图太窄，1280 宽里灯只有几十像素，看不清细节）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const SHOT = path.join(ROOT, 'preview');
const PORT = 39923;

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
  redlogin: { state: 'red', reason: 'Signal 在跑，但库里只有官方 Signal 号，还没登录自己的号', running: true },
};

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url).split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    if (p === '/index.html') {
      let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      html = html.replace(/__BUILD__/g, String(Date.now()));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    const f = path.join(ROOT, 'public', path.basename(p));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    const mime = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' }[path.extname(f)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  // 🔴 deviceScaleFactor 用 1（不是 1.5）—— 元素级截图在 1.5 下会截出空白
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });

  await page.evaluateOnNewDocument((accounts, states) => {
    window.fetch = function (input) {
      const u = String(input);
      const reply = (obj) => Promise.resolve(new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (u.includes('/api/state')) {
        return reply({ accounts, pending: 0, pendingMsgs: 0, unread: 0, aiReady: false, ai: {}, aiReason: '',
          signal: states[window.__sig] || states.green });
      }
      if (u.includes('/api/signal/status')) return reply(Object.assign({ ok: true }, states.green));
      if (u.includes('/api/cloud')) return reply({ ok: true, configured: false });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, ACCOUNTS, STATES);

  await page.evaluateOnNewDocument((s) => { window.states_map = s; }, STATES);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));

  // 截「账号条 + Signal 灯」这一段，并把 CSS 放大 3 倍方便肉眼看清
  for (const [key, name] of [['green', '绿灯已启动'], ['red', '红灯未启动'], ['redlogin', '红灯在跑没登录']]) {
    // 直接调真源码里的 renderSignalLamp（它是全局函数，实测能拿到）
    await page.evaluate((k) => { window.__sig = k; renderSignalLamp(states_map[k]); }, key);
    await new Promise((r) => setTimeout(r, 200));
    // 截取「顶栏两行」这一块（第一行品牌 + 第二行账号条+灯），高度太小看不清
    const hdr = await page.$('header');
    if (!hdr) { console.log('没找到 header'); break; }
    const p = path.join(SHOT, `Signal灯定位_${name}.png`);
    await hdr.screenshot({ path: p });
    const t = await page.evaluate(() => ({
      title: document.getElementById('signal-lamp').title,
      txt: document.querySelector('#signal-lamp .sig-txt').textContent,
      cls: document.getElementById('signal-lamp').className,
    }));
    console.log(`${name}: class="${t.cls}" 文字="${t.txt}"`);
    console.log(`  title=${JSON.stringify(t.title)}`);
    console.log(`  → ${path.basename(p)}`);
  }

  // 三个状态并排一张，方便对比
  await page.evaluate((css) => {
    const d = document.createElement('div');
    d.id = 'lamp-compare';
    d.style.cssText = 'position:fixed;left:12px;top:90px;z-index:99999;background:#fff;'
      + 'padding:14px;border:1px solid #ddd;border-radius:8px;display:flex;gap:14px;'
      + 'font:12px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.12)';
    const items = [
      ['green', '绿灯 = 已启动并登录'],
      ['red', '红灯 = 没启动'],
      ['unknown', '灰灯 = 还在检测'],
    ];
    d.innerHTML = items.map(([k, cap]) =>
      `<div style="text-align:center">
         <div class="signal-lamp ${k}" id="cmp-${k}" style="cursor:default">
           <span class="sig-led"></span><span class="sig-txt">Signal</span>
         </div>
         <div style="color:#8a9099;margin-top:6px">${cap}</div>
       </div>`).join('');
    document.body.appendChild(d);
  });
  await new Promise((r) => setTimeout(r, 200));
  const cmp = await page.$('#lamp-compare');
  const cp = path.join(SHOT, 'Signal灯_三态对比.png');
  await cmp.screenshot({ path: cp });
  console.log('\n三态对比 → ' + path.basename(cp));

  await browser.close();
  srv.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
