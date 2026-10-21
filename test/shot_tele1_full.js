/**
 * Tele①「软件版」整窗截图（v2.6.1107 生产代码）
 *
 * 与之前的预览脚本（shot_tele1_soft.js）不同：
 *   - 布局 CSS / HTML 已经落进生产文件（public/index.html + style.css + app.js），这里 **不再注入任何布局样式**；
 *   - 只注入**示例数据**（几个 WhatsApp 客户 + 几个 Telegram 好友），让整窗看起来是"已在使用"的状态；
 *   - 不带红/蓝/绿标注框，是一张干净的整窗截图。
 *
 * 跑法：node --experimental-sqlite test/shot_tele1_full.js
 */

const path = require('path');
const fs = require('fs');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8992;
const OUT_DIR = path.join(ROOT, 'preview');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');

  const cfg = loadConfig();
  const srv = createServer({ db, doc, ai, knowledge, cfg, getAccountStates: () => [] }, PORT);
  await new Promise((res, rej) => {
    srv.server.once('error', rej);
    srv.server.listen(PORT, '127.0.0.1', res);
  });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 880, deviceScaleFactor: 1.5 });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));

  // ---- 注入示例数据（只填数据，不碰布局）----
  await page.evaluate(() => {
    // 停掉会重画的定时刷新，免得把注入的数据冲掉
    try { window.refreshCustomers = async function () {}; } catch (e) {}
    try { window.refreshToday = async function () {}; } catch (e) {}
    try { window.startTgTranslateLoop = function () {}; } catch (e) {}

    // 隐藏启动登录浮层，露出主窗口
    const boot = document.getElementById('boot-login');
    if (boot) boot.style.display = 'none';

    // 示例客户：WhatsApp（左栏）+ Telegram（Tele① 好友列）
    state.customers = [
      { code: '1A00012', name: 'Vanessa', account_id: 1, channel: 'whatsapp', unread: 2, pending: 1, last_body_zh: '你好！画一幅我家狗狗的像要多少钱？', region: '美国', created_at: '2026-10-09' },
      { code: '3B00007', name: 'Mike', account_id: 3, channel: 'whatsapp', unread: 0, pending: 0, last_body_zh: 'The painting arrived today, love it!', region: '加拿大', created_at: '2026-10-01' },
      { code: '5A00021', name: 'Emma', account_id: 5, channel: 'whatsapp', unread: 1, pending: 1, last_body_zh: 'Can you do two pets in one canvas?', region: '英国', created_at: '2026-10-11' },
      { code: '7A00038', name: 'Elieen Lin', account_id: 7, channel: 'telegram', unread: 2, pending: 1, last_body_zh: '你好', last_body: 'Hello', region: '美国', created_at: '2026-10-11', phone: '14155550132', tg_username: 'elieen_lin', online: '在线 · 最后上线 刚刚' },
      { code: '7A00039', name: 'Vanessa', account_id: 7, channel: 'telegram', unread: 0, pending: 0, last_body_zh: 'The portrait looks amazing!', last_body: 'The portrait looks amazing!', region: '美国', created_at: '2020-03-02' },
      { code: '7A00040', name: 'Xue', account_id: 8, channel: 'telegram', unread: 1, pending: 1, last_body_zh: '请问可以加急吗', last_body: 'Can you expedite?', region: '中国', created_at: '2021-06-10' },
    ];

    // 左栏只列 WA（Telegram 已取消，改走 Tele① 好友列）
    if (typeof paintCustomers === 'function') paintCustomers();
    if (typeof renderTgFriends === 'function') renderTgFriends();

    // 切到 Tele① 页签（好友列已经在里面）
    if (typeof switchMidTab === 'function') switchMidTab('tele1');

    // 选中第一个 Telegram 好友，渲染资料卡（含好友资料块 + 手机号带 +）
    tgActiveCode = '7A00038';
    if (typeof renderTgProfile === 'function') {
      renderTgProfile({
        code: '7A00038', name: 'Elieen Lin', channel: 'telegram',
        created_at: '2026-10-11', region: '美国', timezone: 'America/New_York',
        phone: '14155550132', tg_username: 'elieen_lin', online: '在线 · 最后上线 刚刚',
      });
    }
    if (typeof renderTgFriends === 'function') renderTgFriends(); // 刷新高亮

    // 采集状态提示
    const st = document.getElementById('tg-status');
    if (st) { st.className = 'tg-status ok'; st.textContent = '✅ 已登录 · Telegram 采集中（官方推送）'; }

    // 对话信息
    const conv = document.getElementById('tg-convinfo-body');
    if (conv) {
      conv.innerHTML = `
        <div style="padding:6px 2px;border-bottom:1px solid #eee;">
          <div style="color:#1f6aa5;font-weight:600;font-size:12px;">你好</div>
          <div style="color:#8a8f98;font-size:11px;">Hello</div>
        </div>
        <div style="padding:6px 2px;">
          <div style="color:#1f6aa5;font-weight:600;font-size:12px;">我想给猫画一幅肖像，大概什么价位？</div>
          <div style="color:#8a8f98;font-size:11px;">I want a portrait of my cat, what is the price range?</div>
        </div>`;
    }

    // 左侧今日消息收件箱（只留 WA 圈，干净一点）
    const tb = document.getElementById('tb-list');
    if (tb) {
      tb.innerHTML = `
        <div class="tb-badge-wrap" title="Vanessa：今天 2 条新消息"><span class="tb-badge-num">2</span><span class="tb-badge-ini">V</span></div>
        <div class="tb-badge-wrap" title="Emma：今天 1 条新消息"><span class="tb-badge-num">1</span><span class="tb-badge-ini">E</span></div>`;
    }
  });
  await new Promise((r) => setTimeout(r, 500));

  await page.screenshot({ path: path.join(OUT_DIR, 'Tele①软件版-整窗截图-v2.6.1107.png') });

  await browser.close();
  console.log('OK → preview/Tele①软件版-整窗截图-v2.6.1107.png');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
