/**
 * Tele①「对话信息」独立成列 —— 预览截图（🔴 只出图，**不改生产文件**）
 *
 * 老板 2026-10-14 指令（图 QQ20261014-030311.png 红框）：
 *   把「对话信息」放到红框的位置（= 好友对话列 与 客户资料卡 之间那道竖缝），
 *   客户说的在左、我自己的在右；对话翻译成中文，译文用气泡 + 蓝色字体。
 *
 * 本脚本做的事：
 *   1. 起真实服务 + 真实 index.html（和生产一模一样的 DOM）；
 *   2. 注入示例数据（3 个 WA 客户 + 3 个 TG 好友 + 一段真实感对话）；
 *   3. **只在内存里**注入「对话信息列」的 CSS + DOM（生产文件一个字节都没动）；
 *   4. 出整窗截图 preview/Tele①对话信息列-预览.png。
 *
 * 气泡样式**全部复用仓库里已有的类**（不另发明）：
 *   .tg-crow / .tg-bubble  = 原消息气泡（in 左灰 / out 右蓝）
 *   .tg-zh                 = v2.5.1087 的「译」气泡（深蓝 #1f6aa5 加粗 + 浅蓝底边框）
 *
 * 跑法：node --experimental-sqlite test/shot_tele1_chat.js
 */

const path = require('path');
const fs = require('fs');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8993;
const OUT_DIR = path.join(ROOT, 'preview');

// ---- 预览专用：v2.6.1108 起布局已落生产（.tg-chat/.tgc-* 全在 public/style.css），
//      这里不再注入布局 CSS，只往生产的 #tg-chat-body 里画示例对话（api 打到测试库是空的） ----
const PREVIEW_CSS = ``;

// ---- 预览专用对话数据 ----
const CONV = [
  { dir: 'in', body: 'Hello', zh: '你好' },
  { dir: 'in', body: 'I saw your pet portraits on Instagram — they are beautiful!', zh: '我在 Instagram 上看到你画的宠物肖像，太美了！' },
  { dir: 'out', body: 'Thank you so much! So glad to meet you 😊 Do you want a portrait of your fur baby?', zh: '谢谢你！很高兴认识你 😊 是想给家里的毛孩子画一幅吗？' },
  { dir: 'in', body: 'Yes! I want a portrait of my dog, what is the price range?', zh: '是的！我想给我家狗狗画一幅，大概什么价位？' },
  { dir: 'out', body: 'Depends on size and detail: 8×10in (up to two pets) is $260, 12×16in is $420, shipping included.', zh: '看尺寸和细节：8×10 英寸（两只以内）260 美金，12×16 英寸 420 美金，都含运费。' },
  { dir: 'in', body: 'That sounds great. Can you finish it before Christmas?', zh: '听起来不错，圣诞节前能画完吗？' },
  { dir: 'out', body: 'We still have plenty of time before Christmas! Send me some photos of your dog and I will sketch the composition first.', zh: '来得及的，现在排期还很宽。你把狗狗的照片发我，我先看看构图。' },
  { dir: 'in', body: 'Perfect, sending photos now. Thank you so much!', zh: '太好了，我这就发照片，非常感谢！' },
  { dir: 'in', body: '你好，请问也可以画猫咪吗？', zh: '' },
  { dir: 'out', body: '当然可以呀 😊 把猫咪的照片发我看看？', zh: '' },
];

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
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.25 });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));

  const widths = await page.evaluate((css, conv) => {
    // 停掉会重画的定时刷新，免得把注入的数据冲掉
    try { window.refreshCustomers = async function () {}; } catch (e) {}
    try { window.refreshToday = async function () {}; } catch (e) {}
    try { window.startTgTranslateLoop = function () {}; } catch (e) {}

    // 隐藏启动登录浮层，露出主窗口
    const boot = document.getElementById('boot-login');
    if (boot) boot.style.display = 'none';

    // 示例客户：WA（左栏）+ Telegram（Tele① 好友列）
    state.customers = [
      { code: '1A00012', name: 'Vanessa', account_id: 1, channel: 'whatsapp', unread: 2, pending: 1, last_body_zh: '你好！画一幅我家狗狗的像要多少钱？', region: '美国', created_at: '2026-10-09' },
      { code: '3B00007', name: 'Mike', account_id: 3, channel: 'whatsapp', unread: 0, pending: 0, last_body_zh: 'The painting arrived today, love it!', region: '加拿大', created_at: '2026-10-01' },
      { code: '5A00021', name: 'Emma', account_id: 5, channel: 'whatsapp', unread: 1, pending: 1, last_body_zh: 'Can you do two pets in one canvas?', region: '英国', created_at: '2026-10-11' },
      { code: '7A00038', name: 'Elieen Lin', account_id: 7, channel: 'telegram', unread: 2, pending: 1, last_body_zh: '太好了，我这就发照片，非常感谢！', last_body: 'Perfect, sending photos now. Thank you so much!', region: '美国', created_at: '2026-10-11', phone: '14155550132', tg_username: 'elieen_lin', online: '在线 · 最后上线 刚刚' },
      { code: '7A00039', name: 'Vanessa', account_id: 7, channel: 'telegram', unread: 0, pending: 0, last_body_zh: 'The portrait looks amazing!', last_body: 'The portrait looks amazing!', region: '美国', created_at: '2026-10-02' },
      { code: '7A00040', name: 'Xue', account_id: 8, channel: 'telegram', unread: 1, pending: 1, last_body_zh: '请问可以加急吗', last_body: 'Can you expedite?', region: '中国', created_at: '2026-09-28' },
    ];

    if (typeof paintCustomers === 'function') paintCustomers();
    if (typeof renderTgFriends === 'function') renderTgFriends();
    if (typeof switchMidTab === 'function') switchMidTab('tele1');

    // 选中第一个 Telegram 好友 → 资料卡
    tgActiveCode = '7A00038';
    if (typeof renderTgProfile === 'function') {
      renderTgProfile({
        code: '7A00038', name: 'Elieen Lin', channel: 'telegram',
        created_at: '2026-10-11', region: '美国', timezone: 'America/New_York',
        phone: '14155550132', tg_username: 'elieen_lin', online: '在线 · 最后上线 刚刚',
      });
    }
    if (typeof renderTgFriends === 'function') renderTgFriends();

    // 采集状态
    const st = document.getElementById('tg-status');
    if (st) { st.className = 'tg-status ok'; st.textContent = '✅ 已登录 · Telegram 采集中（官方推送）'; }

    // 左栏今日消息
    const tb = document.getElementById('tb-list');
    if (tb) {
      tb.innerHTML = `
        <div class="tb-badge-wrap" title="Vanessa：今天 2 条新消息"><span class="tb-badge-num">2</span><span class="tb-badge-ini">V</span></div>
        <div class="tb-badge-wrap" title="Emma：今天 1 条新消息"><span class="tb-badge-num">1</span><span class="tb-badge-ini">E</span></div>`;
    }

    // ---- 预览注入（v2.6.1108 起直接画进生产容器 #tg-chat-body，不再另造第二列）----
    if (css) {
      const style = document.createElement('style');
      style.id = 'preview-chat-col';
      style.textContent = css;
      document.head.appendChild(style);
    }

    const wrap = document.querySelector('.mid-pane[data-mp="tele1"] .tele-wrap');
    const chatBody = wrap && wrap.querySelector('#tg-chat-body');
    const chatSub = wrap && wrap.querySelector('#tg-chat-sub');
    if (chatBody) {
      if (chatSub) chatSub.textContent = 'Elieen Lin · 7A00038';
      chatBody.innerHTML =
        '<div class="tgc-day">2026-10-13</div>'
        + conv.map((m) => {
            const isOut = m.dir === 'out';
            const zh = m.zh ? '<div class="tg-zh"><span class="tg-zh-tag">译</span>' + m.zh + '</div>' : '';
            return '<div class="tg-crow ' + (isOut ? 'out' : 'in') + '">'
              + '<div class="tg-bubble">' + m.body + '</div>' + zh + '</div>';
          }).join('');
      chatBody.scrollTop = chatBody.scrollHeight;
    }

    // 量一下三列实际宽度，写进日志
    const g = (s) => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().width) : -1; };
    return {
      pane: g('.mid-pane[data-mp="tele1"] .tele-wrap'),
      friends: g('.mid-pane[data-mp="tele1"] .tg-friends'),
      chat: g('#tg-chat'),
      aside: g('.mid-pane[data-mp="tele1"] .tg-conv-aside'),
    };
  }, PREVIEW_CSS, CONV);

  await new Promise((r) => setTimeout(r, 500));

  const out = path.join(OUT_DIR, 'Tele①对话信息列-预览.png');
  await page.screenshot({ path: out });

  await browser.close();
  console.log('列宽(px):', JSON.stringify(widths));
  console.log('OK → preview/Tele①对话信息列-预览.png');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
