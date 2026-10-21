/**
 * v2.6.1118 真图：通用中栏两栏布局（左=对话信息，右=客户资料卡）
 * 只读脚本：不改任何生产文件。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

(async () => {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(PUBLIC, p);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
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
  await new Promise((r) => setTimeout(r, 500));

  // 塞一个假客户 + 几条消息，看真实排版（先藏掉登录浮层，它会盖住整个界面）
  await page.evaluate(() => {
    const bl = document.getElementById('boot-login');
    if (bl) bl.style.display = 'none';
    /* ⚠️ 测试环境（puppeteer → navigator.webdriver=true）会走 perm.js 的豁免分支，
       applyMidTabs(false) 把 WA① 那页签的 .hidden 也摘了，于是「通用」和 WA①
       两个 pane 同时占高、互相挤（生产环境不会这样：非管理员藏 WA①，管理员也只有
       当前页签可见）。截图前手动只留当前页签，量出来的才是真实观感。 */
    document.querySelectorAll('.mid-pane').forEach((s) => s.classList.add('hidden'));
    document.querySelector('.mid-pane[data-mp="general"]').classList.remove('hidden');
    const joined = new Date(Date.now() - 2 * 86400000).toISOString();
    const c = {
      code: '1A00001', name: 'Emma Wilson', joined_at: joined, created_at: joined,
      timezone: 'America/New_York', region: 'Oregon', stage_day: 3, channel: 'whatsapp',
    };
    const sub = document.getElementById('gen-chat-sub');
    if (sub) sub.textContent = `${c.name} · ${c.region} · 加入 ${joined.slice(5, 10)}`;
    renderChatHead(c, { autoTimezone: c.timezone }, { noBackfill: true });

    const msgs = document.getElementById('msgs');
    msgs.innerHTML = `
      <div class="bubble in"><div class="bub-main"><div class="bub-text">Hi Wanqiu! I found your page and I really love the pet portrait style. Do you paint from photos?</div></div></div>
      <div class="bubble out"><div class="bub-main"><div class="bub-text">Hi Emma! Yes, I paint from photos. Which pet are you thinking about?</div></div></div>
      <div class="bubble in"><div class="bub-main"><div class="bub-text">My golden retriever, he just turned 3. I have about 4 photos of him.</div></div></div>
      <div class="bubble in"><div class="bub-main"><div class="bub-text">Also — would a 30x40cm canvas work for a wall above the sofa?</div></div></div>`;
    msgs.scrollTop = msgs.scrollHeight;
  });
  await new Promise((r) => setTimeout(r, 300));

  const outDir = path.join(ROOT, 'preview');
  fs.mkdirSync(outDir, { recursive: true });

  const geo = await page.evaluate(() => {
    const b = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
    return {
      general: b('.mid-pane[data-mp="general"]'),
      genChat: b('#gen-chat'),
      aside: b('#chat-head'),
      card: b('#ch-head-slot'),
      tele1Card: null,
    };
  });
  console.log(JSON.stringify(geo, null, 1));

  await page.screenshot({ path: path.join(outDir, 'v1118-通用两栏-整窗.png') });
  await page.screenshot({ path: path.join(outDir, 'v1118-通用两栏-中栏.png'), clip: geo.general });

  // 切到 Tele① 对照
  await page.evaluate(() => {
    document.querySelectorAll('.mid-pane').forEach((s) => s.classList.add('hidden'));
    document.querySelector('.mid-pane[data-mp="tele1"]').classList.remove('hidden');
  });
  await new Promise((r) => setTimeout(r, 300));
  const tele = await page.evaluate(() => {
    const el = document.querySelector('.mid-pane[data-mp="tele1"]');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  await page.screenshot({ path: path.join(outDir, 'v1118-Tele①对照.png'), clip: tele });

  await browser.close();
  srv.close();
  console.log('截图已出：preview/v1118-通用两栏-整窗.png / -中栏.png / v1118-Tele①对照.png');
})();
