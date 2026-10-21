/**
 * Tele①「软件版」布局预览（v2.6.1107 方案预览 · 只出图，不改生产代码）
 *
 * 老板 2026-10-14 02:15 截图（QQ20261014-021536.png）要求：
 *   ① 红框位置（Tele① 页签内左端）放「软件版好友对话选择」
 *   ② 主窗口最左栏的 T 消息取消（Telegram 客户不再进左栏）
 *   ③ 好友资料（MTProto getUserProfile）加进客户资料卡，手机号前面带 +
 *
 * 做法：起真实服务 + 真实 index.html，把三处改动**临时注入**页面后截图。
 * 注入只在内存里，刷新即没，仓库/生产文件一个字节不动。
 *
 * 跑法：node --experimental-sqlite test/shot_tele1_soft.js
 */

const path = require('path');
const fs = require('fs');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8991;
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
  await new Promise((r) => setTimeout(r, 1500)); // 等 app 初始化完

  // 切到 Tele① 页签
  await page.evaluate(() => {
    const tab = document.querySelector('.mtab[data-mp="tele1"]');
    if (tab) tab.click();
  });
  await new Promise((r) => setTimeout(r, 500));

  // ---- 注入三处预览改动（内存里，不落盘）----
  await page.evaluate(() => {
    // 兜底：把会重画界面的几个定时刷新先停掉，免得把注入的东西冲掉
    try { window.paintCustomers = function () {}; } catch (e) {}
    try { window.refreshTgStatus = async function () {}; } catch (e) {}
    try { window.renderTgStatus = function () {}; } catch (e) {}
    try { window.refreshToday = async function () {}; } catch (e) {}

    /* ========== 预览样式（只在截图里，不进生产）========== */
    const style = document.createElement('style');
    style.textContent = `
      /* 好友对话选择列：竖分隔线用紫（界面铁律：紫=竖分隔与容器框） */
      #tg-friends{flex:0 0 300px;min-width:0;display:flex;flex-direction:column;background:#fff;border-right:1px solid #a795de;}
      .tgf-head{flex:0 0 auto;padding:9px 12px;font-weight:700;font-size:13px;border-bottom:1px solid #63bd93;color:#1c1c1c;background:#f6f8f7;}
      .tgf-list{flex:1 1 auto;min-height:0;overflow-y:auto;}
      .tgf-row{position:relative;display:flex;align-items:center;gap:9px;padding:9px 10px;border-bottom:1px solid #ecb27c;cursor:pointer;background:#fff;}
      .tgf-row.on{background:#eef4ff;box-shadow:inset 3px 0 0 #2563eb;}
      .tgf-ava{flex:0 0 auto;width:36px;height:36px;border-radius:50%;background:#2563eb;color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;}
      .tgf-dot{position:absolute;left:38px;top:36px;width:11px;height:11px;border-radius:50%;background:#2e9e5b;border:2px solid #fff;}
      .tgf-meta{flex:1 1 auto;min-width:0;}
      .tgf-top{display:flex;justify-content:space-between;gap:6px;}
      .tgf-name{font-weight:600;font-size:13px;color:#1c1c1c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .tgf-time{flex:0 0 auto;font-size:11px;color:#9aa0a6;}
      .tgf-prev{font-size:12px;color:#6b7075;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;}
      .tgf-unread{flex:0 0 auto;min-width:19px;height:19px;border-radius:10px;background:#e03131;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px;}
      .tgf-foot{flex:0 0 auto;padding:7px 12px;font-size:11px;color:#8a8f98;border-top:1px solid #ecb27c;background:#fbfbfb;}
      /* 左栏行兜底（复用 .cust 真样式，只补账号圈列） */
      .row-dot{color:#e03131;font-weight:700;}
    `;
    document.head.appendChild(style);

    /* ========== ① 左栏：T 消息取消后的样子（只剩 WhatsApp） ========== */
    const tbList = document.getElementById('tb-list');
    if (tbList) {
      tbList.innerHTML = `
        <div class="tb-badge-wrap" title="Vanessa：今天 2 条新消息"><span class="tb-badge-num">2</span><span class="tb-badge-ini">V</span></div>
        <div class="tb-badge-wrap" title="Mike：今天 1 条新消息"><span class="tb-badge-num">1</span><span class="tb-badge-ini">M</span></div>`;
    }
    const listBody = document.getElementById('list-body');
    if (listBody) {
      // 只留 WA 客户行（账号圈 ① ③ ⑤）—— T 客户（∮）不再出现在左栏
      const row = (circ, code, name, unread, preview, tags) => `
        <div class="cust ${unread ? 'has-unread' : ''}">
          <span class="row-dot" style="font-size:15px;line-height:1;width:22px;text-align:center;">${circ}</span>
          <div class="meta">
            <div class="top"><span class="code">${code}</span><span class="name">${name}</span>${unread ? `<span class="unread">${unread}</span>` : ''}</div>
            <div class="preview">${preview}</div>
            <div class="tags">${tags}</div>
          </div>
        </div>`;
      listBody.innerHTML =
        row('①', '1A00012', 'Vanessa', 2, '你好！画一幅我家狗狗的像要多少钱？', '美国 · Day 4') +
        row('③', '3B00007', 'Mike', 0, 'The painting arrived today, love it!', '加拿大 · Day 9') +
        row('⑤', '5A00021', 'Emma', 1, 'Can you do two pets in one canvas?', '英国 · Day 2');
    }

    /* ========== ② Tele① 左端：软件版好友对话选择 ========== */
    const wrap = document.querySelector('.mid-pane[data-mp="tele1"] .tele-wrap');
    if (wrap && !document.getElementById('tg-friends')) {
      const fr = document.createElement('div');
      fr.id = 'tg-friends';
      fr.innerHTML = `
        <div class="tgf-head">Telegram · 好友对话</div>
        <div class="tgf-list">
          ${[
            ['E', 'Elieen Lin', '10:14', '你好', 2, true, true, '+1 415 555 0132'],
            ['V', 'Vanessa', '09:02', 'The portrait looks amazing!', 0, false, true, ''],
            ['X', 'Xue', '0:15', '请问可以加急吗', 1, false, false, ''],
            ['R', 'Richard Bennett', '昨天', 'Happy holidays, Sherry!', 0, false, true, ''],
            ['L', 'L. Sherry', '昨天', 'Thank you so much 🙏', 0, false, false, ''],
            ['W', 'Li WaiChu', '周一', '下一幅什么时候能动工？', 3, false, false, ''],
          ].map(([ini, name, time, preview, unread, on, online]) => `
          <div class="tgf-row ${on ? 'on' : ''}">
            <span class="tgf-ava">${ini}</span>${online ? '<i class="tgf-dot" title="在线"></i>' : ''}
            <div class="tgf-meta">
              <div class="tgf-top"><span class="tgf-name">${name}</span><span class="tgf-time">${time}</span></div>
              <div class="tgf-prev">${preview}</div>
            </div>
            ${unread ? `<span class="tgf-unread">${unread}</span>` : ''}
          </div>`).join('')}
        </div>
        <div class="tgf-foot">点一个好友 → 右边出他的资料卡和对话</div>`;
      wrap.insertBefore(fr, wrap.firstChild);
    }

    /* ========== ③ 客户资料卡：加「好友资料（官方通道）」块，手机号带 + ========== */
    const prof = document.getElementById('tg-profile-body');
    if (prof) {
      prof.innerHTML = `
        <div class="tv-head" style="display:flex;align-items:center;gap:8px;">
          <span class="tgf-ava" style="width:34px;height:34px;font-size:15px;">E</span>
          <span style="display:flex;flex-direction:column;min-width:0;">
            <span><span class="code">7A00038</span><span class="name-label">名称:</span><span class="cname">Elieen Lin</span></span>
            <span style="font-size:11px;color:#2e9e5b;font-weight:600;">● 在线</span>
          </span>
        </div>
        <div class="tv-ln"><b class="tv-f-joined">加入时间</b><span class="tv-val">10-13 2019</span></div>
        <div class="tv-ln"><i class="tv-star">★</i><i class="tv-sub-joined">认识</i><span class="tv-day-num">第 1 天</span><i class="tv-star">★</i><b class="tv-fact-day">Day 1</b></div>
        <div class="tv-ln sep"><b style="color:#1f6aa5;">手机号</b><span class="tv-val" style="font-weight:700;">+1 415 555 0132</span></div>
        <div class="tv-ln"><b style="color:#1f6aa5;">Username</b><span class="tv-val">@elieen_lin</span></div>
        <div class="tv-ln"><b style="color:#2e9e5b;">在线状态</b><span class="tv-val">在线 · 最后上线 刚刚</span></div>
        <div class="tv-ln sep"><b class="tv-f-region">地区</b><span class="chip chip-region">美国</span></div>
        <div class="tv-ln"><b class="tv-f-loc">客户当地时间</b><span class="tv-val">10-13 21:14</span></div>
        <div class="tv-ln"><b style="color:#a795de;">来源</b><span class="tv-val">Telegram 官方通道（MTProto）</span></div>`;
    }

    // 状态条 + 对话信息
    const st = document.getElementById('tg-status');
    if (st) { st.className = 'tg-status ok'; st.textContent = '✅ 已登录 · Telegram 采集中（官方推送）'; }
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

    /* ========== ④ 预览标注（红 / 蓝 / 绿）========== */
    const ann = document.createElement('div');
    ann.id = 'shot-ann';
    ann.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;';
    document.body.appendChild(ann);

    function box(sel, color, label, dy) {
      const el = document.querySelector(sel);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const b = document.createElement('div');
      b.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid ${color};border-radius:6px;`;
      ann.appendChild(b);
      const t = document.createElement('div');
      t.style.cssText = `position:fixed;left:${r.x}px;top:${r.y + (dy == null ? -26 : dy)}px;background:${color};color:#fff;font-size:13px;font-weight:700;padding:3px 10px;border-radius:4px;white-space:nowrap;`;
      t.textContent = label;
      ann.appendChild(t);
    }
    // 上面两个标签会和顶栏重叠 → 标签放框内顶部
    function boxIn(sel, color, label) {
      const el = document.querySelector(sel);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const b = document.createElement('div');
      b.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid ${color};border-radius:6px;`;
      ann.appendChild(b);
      const t = document.createElement('div');
      t.style.cssText = `position:fixed;left:${r.x + 6}px;top:${r.y + 6}px;background:${color};color:#fff;font-size:13px;font-weight:700;padding:3px 10px;border-radius:4px;white-space:nowrap;`;
      t.textContent = label;
      ann.appendChild(t);
    }
    boxIn('#tg-friends', '#e03131', '① 新增：软件版好友对话选择（放红框位置）');
    // 蓝框圈资料卡的好友资料块（手机号那几行）
    const prof2 = document.getElementById('tg-profile-body');
    if (prof2) {
      const r = prof2.getBoundingClientRect();
      const b = document.createElement('div');
      b.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #1f6aa5;border-radius:6px;`;
      ann.appendChild(b);
      const t = document.createElement('div');
      t.style.cssText = `position:fixed;left:${r.x + 6}px;top:${r.y + r.height - 30}px;background:#1f6aa5;color:#fff;font-size:13px;font-weight:700;padding:3px 10px;border-radius:4px;white-space:nowrap;`;
      t.textContent = '② 客户卡加好友资料 · 手机号带 +';
      ann.appendChild(t);
    }
    // 绿标：左栏 T 消息取消
    const lb = document.getElementById('list-body');
    if (lb) {
      const r = lb.getBoundingClientRect();
      const t = document.createElement('div');
      t.style.cssText = `position:fixed;left:${r.x + 4}px;top:${r.y + 4}px;background:#2e9e5b;color:#fff;font-size:13px;font-weight:700;padding:3px 10px;border-radius:4px;`;
      t.textContent = '③ 左栏 T 消息已取消（只剩 WA）';
      ann.appendChild(t);
    }
  });
  await new Promise((r) => setTimeout(r, 400));

  await page.screenshot({ path: path.join(OUT_DIR, 'Tele①软件版-布局确认-全窗.png') });

  // 局部放大：Tele① 页签区域
  const rect = await page.evaluate(() => {
    const el = document.querySelector('.mid-pane[data-mp="tele1"]');
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x - 2), y: Math.max(0, r.y - 2), width: r.width + 4, height: Math.min(r.height + 4, 880 - r.y) };
  });
  await page.screenshot({ path: path.join(OUT_DIR, 'Tele①软件版-布局确认-局部.png'), clip: rect });

  await browser.close();
  console.log('OK → preview/Tele①软件版-布局确认-全窗.png');
  console.log('OK → preview/Tele①软件版-布局确认-局部.png');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
