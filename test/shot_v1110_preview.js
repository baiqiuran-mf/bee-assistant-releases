/**
 * v2.6.1110 三条改动 —— 预览截图（🔴 只出图，**生产文件一个字节都不改**）
 *
 * 老板 2026-10-14 指令：
 *   ① 全局设置里「AI 设置」取消隐藏（所有人可见）
 *   ② Tele① 的「对话信息」栏宽度可缩小到 0（主窗口窗口化变小 → 该栏随之变窄，最小 0）
 *   ③ 顶栏红框位置加 2 个按钮「T①」「T②」（打开 Telegram 网页版登录账号）
 *
 * 本脚本做三件事，全部只在**内存里**注入，跑完生产文件仍然原样：
 *   A. 主窗口顶栏：把 T①/T② 两个按钮插进 .head-bottom（S1~S3 之后），红框标注
 *   B. Tele① 面板：先出「正常三列」，再把窗口缩窄 + 注入 min-width:0，出「对话信息列缩到极小」
 *   C. 设置窗：先出「现状（AI 设置被藏）」，再模拟「去掉 'ai' 后（AI 设置出现）」
 *
 * 跑法：node --experimental-sqlite test/shot_v1110_preview.js
 * 产物：preview/v1110-A-顶栏按钮.png
 *       preview/v1110-B1-对话信息列-正常.png
 *       preview/v1110-B2-对话信息列-缩至0.png
 *       preview/v1110-C1-设置页签-现状.png
 *       preview/v1110-C2-设置页签-AI设置取消隐藏.png
 */

const fs = require('fs');
const path = require('path');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8994;
const OUT = path.join(ROOT, 'preview');

// 预览对话数据（与 shot_tele1_chat.js 同一份口径）
const CONV = [
  { dir: 'in', body: 'Hello', zh: '你好' },
  { dir: 'in', body: 'I saw your pet portraits on Instagram — they are beautiful!', zh: '我在 Instagram 上看到你画的宠物肖像，太美了！' },
  { dir: 'out', body: 'Thank you so much! So glad to meet you 😊 Do you want a portrait of your fur baby?', zh: '谢谢你！很高兴认识你 😊 是想给家里的毛孩子画一幅吗？' },
  { dir: 'in', body: 'Yes! I want a portrait of my dog, what is the price range?', zh: '是的！我想给我家狗狗画一幅，大概什么价位？' },
  { dir: 'out', body: 'Depends on size and detail: 8×10in is $260, 12×16in is $420, shipping included.', zh: '看尺寸和细节：8×10 英寸 260 美金，12×16 英寸 420 美金，都含运费。' },
  { dir: 'in', body: 'That sounds great. Can you finish it before Christmas?', zh: '听起来不错，圣诞节前能画完吗？' },
];

/** 在页面里画一个红框 + 标题（截图前用，position:fixed 对齐视口坐标） */
const ANNOTATE_FN = `
window.__box = function (sel, label, color) {
  var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el) return;
  var r = el.getBoundingClientRect();
  var w = Math.max(26, r.width + 12), h = Math.max(26, r.height + 12);
  var cx = r.left + r.width / 2 - w / 2, cy = r.top + r.height / 2 - h / 2;
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:' + cx + 'px;top:' + cy + 'px;width:' + w + 'px;height:' + h + 'px;border:3px solid ' + color +
    ';border-radius:6px;z-index:99999;pointer-events:none';
  document.body.appendChild(box);
  if (label) {
    var t = document.createElement('div');
    t.textContent = label;
    t.style.cssText = 'position:fixed;left:' + Math.max(2, cx) + 'px;top:' + Math.max(2, cy - h / 2 - 32) +
      'px;background:' + color + ';color:#fff;font:600 12px/1.6 system-ui,"Microsoft YaHei";padding:2px 9px;' +
      'border-radius:4px;z-index:100000;pointer-events:none;white-space:nowrap';
    document.body.appendChild(t);
  }
}
`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

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

  try {
    /* ============================ A + B：主窗口 ============================ */
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.25 });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));

    await page.evaluate((conv, annotateFn) => {
      /* eslint-disable no-new-func */
      new Function(annotateFn)();
      try { window.refreshCustomers = async function () {}; } catch (e) {}
      try { window.refreshToday = async function () {}; } catch (e) {}
      try { window.startTgTranslateLoop = function () {}; } catch (e) {}
      const boot = document.getElementById('boot-login');
      if (boot) boot.style.display = 'none';

      /* 顶栏账号条：一号~五号 */
      if (typeof renderAccounts === 'function') {
        renderAccounts([1, 2, 3, 4, 5].map((n) => ({
          id: 'acct' + n, label: ['一号', '二号', '三号', '四号', '五号'][n - 1], status: 'online',
        })));
      }
      /* Signal 启动器 S1~S3 */
      if (typeof renderLaunchers === 'function') {
        renderLaunchers([1, 2, 3].map((n) => ({ id: 's' + n, label: 'S' + n, kind: 'signal', status: 'red', title: 'Signal ' + n })));
      }

      /* ③ 预览：把 T①/T② 插到 S1~S3 之后（生产将落在这） */
      const st = document.createElement('style');
      st.id = 'preview-tgopen';
      st.textContent =
        '.tgOpenBar{display:flex;align-items:center;gap:6px;margin-left:6px;padding-left:8px;border-left:1px solid var(--ln-purple);}'
        + '.tg-open{display:flex;align-items:center;gap:5px;margin:0;padding:3px 11px;border:1px solid var(--line);'
        + 'border-radius:6px;background:#fff;font:600 12px/1.6 system-ui,"Microsoft YaHei";color:var(--text);cursor:pointer;}'
        + '.tg-open:hover{background:#eef1f4;}'
        + '.tg-open .lamp{display:inline-block;width:8px;height:8px;border-radius:50%;background:#e35d5d;}';
      document.head.appendChild(st);

      const barDiv = document.createElement('span');
      barDiv.className = 'tgOpenBar';
      barDiv.innerHTML = '<button class="tg-open" data-tg="1"><span class="lamp"></span>T①</button>'
        + '<button class="tg-open" data-tg="2"><span class="lamp"></span>T②</button>';
      const lb = document.getElementById('launcher-bar');
      if (lb) lb.parentNode.insertBefore(barDiv, lb.nextSibling);
    }, CONV, ANNOTATE_FN);

    await new Promise((r) => setTimeout(r, 400));

    /* 图 A：整窗（红框圈住新按钮） */
    await page.evaluate(() => { window.__box('.tgOpenBar', '← 新增 T① / T②：点开 Telegram 网页版登录', '#e02020'); });
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(OUT, 'v1110-A-顶栏按钮.png') });

    /* 图 B1：切到 Tele①，正常三列 */
    const w1 = await page.evaluate((conv) => {
      state.customers = [
        { code: '1A00012', name: 'Vanessa', account_id: 1, channel: 'whatsapp', unread: 2, pending: 1, last_body_zh: '你好！画一幅我家狗狗的像要多少钱？', region: '美国', created_at: '2026-10-09' },
        { code: '3B00007', name: 'Mike', account_id: 3, channel: 'whatsapp', unread: 0, pending: 0, last_body_zh: 'The painting arrived today, love it!', region: '加拿大', created_at: '2026-10-01' },
        { code: '5A00021', name: 'Emma', account_id: 5, channel: 'whatsapp', unread: 1, pending: 1, last_body_zh: 'Can you do two pets in one canvas?', region: '英国', created_at: '2026-10-11' },
        { code: '7A00038', name: 'Elieen Lin', account_id: 7, channel: 'telegram', unread: 2, pending: 1, last_body_zh: '太好了，我这就发照片，非常感谢！', last_body: 'Perfect, sending photos now. Thank you so much!', region: '美国', created_at: '2026-10-11', phone: '14155550132', tg_username: 'elieen_lin', online: '在线 · 最后上线 刚刚' },
        { code: '7A00040', name: 'Xue', account_id: 8, channel: 'telegram', unread: 1, pending: 1, last_body_zh: '请问可以加急吗', last_body: 'Can you expedite?', region: '中国', created_at: '2026-09-28' },
      ];
      if (typeof paintCustomers === 'function') paintCustomers();
      if (typeof switchMidTab === 'function') switchMidTab('tele1');
      window.tgActiveCode = '7A00038';
      if (typeof renderTgFriends === 'function') renderTgFriends();
      if (typeof renderTgProfile === 'function') {
        renderTgProfile({
          code: '7A00038', name: 'Elieen Lin', channel: 'telegram', created_at: '2026-10-11',
          region: '美国', timezone: 'America/New_York', phone: '14155550132',
          tg_username: 'elieen_lin', online: '在线 · 最后上线 刚刚',
        });
      }
      const st = document.getElementById('tg-status');
      if (st) { st.className = 'tg-status ok'; st.textContent = '✅ 已登录 · Telegram 采集中（官方推送）'; }
      const body = document.querySelector('#tg-chat-body');
      if (body) {
        body.innerHTML = '<div class="tgc-day">2026-10-13</div>' + conv.map((m) => {
          const out = m.dir === 'out';
          const zh = m.zh ? '<div class="tg-zh"><span class="tg-zh-tag">译</span>' + m.zh + '</div>' : '';
          return '<div class="tg-crow ' + (out ? 'out' : 'in') + '"><div class="tg-bubble">' + m.body + '</div>' + zh + '</div>';
        }).join('');
      }
      const sub = document.getElementById('tg-chat-sub');
      if (sub) sub.textContent = 'Elieen Lin · 7A00038';
      const g = (s) => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().width) : -1; };
      return { pane: g('.mid-pane[data-mp="tele1"] .tele-wrap'), friends: g('.mid-pane[data-mp="tele1"] .tg-friends'), chat: g('#tg-chat'), aside: g('.mid-pane[data-mp="tele1"] .tg-conv-aside') };
    }, CONV);
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(OUT, 'v1110-B1-对话信息列-正常.png') });

    /* 图 B2：模拟「窗口化变小」+ 注入将要落地的 min-width:0 → 对话信息列缩到极小 */
    await page.evaluate(() => {
      const st = document.createElement('style');
      st.id = 'propose-minw0';
      st.textContent = '#tg-chat{min-width:0 !important;}';
      document.head.appendChild(st);
    });
    await page.setViewport({ width: 900, height: 760, deviceScaleFactor: 1.25 });
    await new Promise((r) => setTimeout(r, 600));
    const w2 = await page.evaluate(() => {
      /* 重新钉住 Tele① 页签（改视口后可能被重画），保证截到的就是 Tele① */
      if (typeof switchMidTab === 'function') switchMidTab('tele1');
      if (typeof renderTgFriends === 'function') renderTgFriends();
      const g = (s) => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().width) : -1; };
      /* 清掉图 A 的红色标注，免干扰 */
      document.querySelectorAll('body > div').forEach((d) => { if (d.style.zIndex) d.remove(); });
      return { pane: g('.mid-pane[data-mp="tele1"] .tele-wrap'), friends: g('.mid-pane[data-mp="tele1"] .tg-friends'), chat: g('#tg-chat'), aside: g('.mid-pane[data-mp="tele1"] .tg-conv-aside'), vp: window.innerWidth };
    });
    await page.evaluate(() => { window.__box('#tg-chat', '对话信息列可一路缩到 0（窗口越小越窄）', '#e02020'); });
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(OUT, 'v1110-B2-对话信息列-缩至0.png') });

    console.log('列宽 B1(正常 1600):', JSON.stringify(w1));
    console.log('列宽 B2(窗口 900 + min-width:0):', JSON.stringify(w2));

    /* ============================ C：设置窗 ============================ */
    const sp = await browser.newPage();
    await sp.setViewport({ width: 1320, height: 340, deviceScaleFactor: 2 });
    await sp.goto('http://127.0.0.1:' + PORT + '/settings.html', { waitUntil: 'networkidle2' });
    /* 强制走权限判定（自动化默认被豁免，这里显式打开判定） */
    await sp.evaluate(() => { try { localStorage.setItem('bee.perm', 'on'); } catch (e) {} });
    await sp.reload({ waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1000));

    const tabBox = await sp.evaluate(() => {
      const el = document.querySelector('.set-tabs');
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: r.width + 16, height: r.height + 16 };
    });
    /* C1：现状（RULES.setTabs 仍含 'ai' → AI 设置被藏） */
    await sp.screenshot({ path: path.join(OUT, 'v1110-C1-设置页签-现状.png'), clip: tabBox });
    const before = await sp.evaluate(() => {
      const t = document.querySelector('.set-tab[data-tab="ai"]');
      return { hasAiTab: !!t, hidden: !!(t && t.classList.contains('hidden')) };
    });

    /* C2：模拟「RULES.setTabs 去掉 'ai'」→ AI 设置出现 */
    await sp.evaluate((annotateFn) => {
      new Function(annotateFn)();
      try {
        const t = document.querySelector('.set-tab[data-tab="ai"]');
        const sec = document.getElementById('sec-ai');
        if (t) t.classList.remove('hidden');
        if (sec) sec.classList.remove('hidden');
      } catch (e) {}
      window.__box('.set-tab[data-tab="ai"]', 'AI 设置：改为所有人可见', '#1f8f4e');
    }, ANNOTATE_FN);
    await new Promise((r) => setTimeout(r, 300));
    await sp.screenshot({ path: path.join(OUT, 'v1110-C2-设置页签-AI设置取消隐藏.png'), clip: tabBox });

    console.log('设置页签 C1 现状:', JSON.stringify(before));
    console.log('OK → preview/v1110-A-顶栏按钮.png');
    console.log('OK → preview/v1110-B1-对话信息列-正常.png');
    console.log('OK → preview/v1110-B2-对话信息列-缩至0.png');
    console.log('OK → preview/v1110-C1-设置页签-现状.png');
    console.log('OK → preview/v1110-C2-设置页签-AI设置取消隐藏.png');
  } finally {
    await browser.close();
    srv.server.close();
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
