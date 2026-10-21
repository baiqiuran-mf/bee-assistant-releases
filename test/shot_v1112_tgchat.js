/**
 * v2.6.1112 ·「对话信息」列弹性伸缩 —— 真实渲染截图（只出图，不改生产代码）
 *
 * 老板 2026-10-14 看图反馈（QQ20261014-140415.png）：
 *   ① Tele① 的「对话信息」栏宽度要能缩小到 0；主窗口调整大小会改变这一栏宽度，最小 0 像素
 *   ② 点名 5 个栏目宽度：1=265 / 2=240 / 4=300 / 5=500，3 是弹性（最大化约 1250）
 *   ③ 主窗口缩到 1305~1310 时，3 号栏宽度缩小到 0
 *
 * 做法：起真实服务 + 真实 index.html（加载的是**已改好的**生产 CSS，不是注入的预览样式），
 *       只把客户数据灌进去（测试库里没那么多真实客户，不灌就是空壳没法看），
 *       然后切三档视口宽度各截一张真图，标注栏上**实测像素值**。
 * 注入只涉及数据，样式 100% 走生产 style.css。
 *
 * 跑法：node --experimental-sqlite test/shot_v1112_tgchat.js
 */

const path = require('path');
const fs = require('fs');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8993;
const OUT_DIR = path.join(ROOT, 'preview');

// 三档视口宽度：最大化 / ③ 刚好归 0 / 再收窄让 ⑤ 降级
const SHOTS = [
  { key: 'A', w: 2560, h: 900, label: '最大化 2560 → ③≈1253（弹性吃满）' },
  { key: 'B', w: 1307, h: 900, label: '主窗口收到 1307 → ③ 归 0' },
  { key: 'C', w: 1180, h: 880, label: '再收到 1180 → ⑤ 自动降到 400 一档' },
  { key: 'E', w: 1140, h: 860, label: '收到 1140 → ⑤ 降到 280~340 一档' },
  { key: 'F', w: 1050, h: 820, label: '收到 1050（<1118）→ ⑤ 自动收成 14px 窄条' },
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

  const out = [];

  for (const shot of SHOTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: shot.w, height: shot.h, deviceScaleFactor: 1 });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 40000 });
    await new Promise((r) => setTimeout(r, 1500));

    // 切到 Tele① 页签（真实点击，走生产的 switchMidTab）
    await page.evaluate(() => {
      const tab = document.querySelector('.mtab[data-mp="tele1"]');
      if (tab) tab.click();
    });
    await new Promise((r) => setTimeout(r, 600));

    // 只灌数据（样式一律走生产 style.css），并停掉会重画界面的定时刷新
    await page.evaluate(() => {
      try { window.paintCustomers = function () {}; } catch (e) {}
      try { window.refreshTgStatus = async function () {}; } catch (e) {}
      try { window.renderTgStatus = function () {}; } catch (e) {}
      try { window.refreshToday = async function () {}; } catch (e) {}

      const tbList = document.getElementById('tb-list');
      if (tbList) {
        tbList.innerHTML = `
          <div class="tb-badge-wrap"><span class="tb-badge-num">2</span><span class="tb-badge-ini">V</span></div>
          <div class="tb-badge-wrap"><span class="tb-badge-num">1</span><span class="tb-badge-ini">M</span></div>`;
      }
      const listBody = document.getElementById('list-body');
      if (listBody) {
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

      // ② 好友对话列：走生产 DOM（index.html 里本来就有 #tg-friends），只填数据
      const tgfList = document.getElementById('tgf-list');
      if (tgfList) {
        const friends = [
          ['E', 'Elieen Lin', '10:14', '你好', 2, true],
          ['V', 'Vanessa', '09:02', 'The portrait looks amazing!', 0, true],
          ['X', 'Xue', '0:15', '请问可以加急吗', 1, false],
          ['R', 'Richard Bennett', '昨天', 'Happy holidays, Sherry!', 0, true],
          ['L', 'L. Sherry', '昨天', 'Thank you so much', 0, false],
          ['W', 'Li WaiChu', '周一', '下一幅什么时候能动工？', 3, false],
        ];
        tgfList.innerHTML = friends.map(([ini, name, time, preview, unread, online]) => `
          <div class="tgf-row">
            <span class="tg-ava">${ini}</span>${online ? '<i class="tgf-dot" title="在线"></i>' : ''}
            <div class="tgf-meta">
              <div class="tgf-top"><span class="tgf-name">${name}</span><span class="tgf-time">${time}</span></div>
              <div class="tgf-prev">${preview}</div>
            </div>
            ${unread ? `<span class="tgf-unread">${unread}</span>` : ''}
          </div>`).join('');
      }

      // ③ 对话信息列：走生产 .tg-chat / .tgc-body（真实样式，不用注入）
      const sub = document.getElementById('tg-chat-sub');
      if (sub) sub.textContent = 'Elieen Lin · 今天 10:14';
      const body = document.getElementById('tg-chat-body');
      if (body) {
        body.innerHTML = `
          <div class="tgc-day">今天</div>
          <div class="tg-crow in"><span class="tg-bubble">Hello! I want a portrait of my cat.</span></div>
          <div class="tg-crow in"><span class="tg-zh">你好！我想给我家猫画一幅肖像。</span></div>
          <div class="tg-crow out"><span class="tg-bubble">当然可以～你家猫多大了？</span></div>
          <div class="tgc-day">昨天</div>
          <div class="tg-crow in"><span class="tg-bubble">She is 3 years old, a British Shorthair.</span></div>
          <div class="tg-crow in"><span class="tg-zh">她三岁了，是一只英短。</span></div>`;
      }

      // ④ 资料卡
      const prof = document.getElementById('tg-profile-body');
      if (prof) {
        prof.innerHTML = `
          <div class="tv-head" style="display:flex;align-items:center;gap:8px;">
            <span class="tg-ava" style="width:34px;height:34px;font-size:15px;">E</span>
            <span style="display:flex;flex-direction:column;min-width:0;">
              <span><span class="code">7A00038</span><span class="name-label">名称:</span><span class="cname">Elieen Lin</span></span>
              <span style="font-size:11px;color:#2e9e5b;font-weight:600;">● 在线</span>
            </span>
          </div>
          <div class="tv-ln"><b class="tv-f-joined">加入时间</b><span class="tv-val">10-13 2019</span></div>
          <div class="tv-ln"><i class="tv-star">★</i><i class="tv-sub-joined">认识</i><span class="tv-day-num">第 1 天</span><i class="tv-star">★</i><b class="tv-fact-day">Day 1</b></div>
          <div class="tv-ln sep"><b style="color:#1f6aa5;">手机号</b><span class="tv-val" style="font-weight:700;">+1 415 555 0132</span></div>
          <div class="tv-ln"><b style="color:#1f6aa5;">Username</b><span class="tv-val">@elieen_lin</span></div>
          <div class="tv-ln"><b style="color:#2e9e5b;">在线状态</b><span class="tv-val">在线 · 刚刚</span></div>
          <div class="tv-ln sep"><b class="tv-f-region">地区</b><span class="chip chip-region">美国</span></div>
          <div class="tv-ln"><b class="tv-f-loc">客户当地时间</b><span class="tv-val">10-13 21:14</span></div>`;
      }
      const st = document.getElementById('tg-status');
      if (st) { st.className = 'tg-status ok'; st.textContent = '已登录 · Telegram 采集中（外部 Chrome）'; }
    });

    await new Promise((r) => setTimeout(r, 400));

    // 实测各栏像素宽度 —— 这是给老板的硬证据，不是估算
    const measured = await page.evaluate(() => {
      const w = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().width) : null;
      };
      return {
        list: w('#list'),
        chat: w('#chat'),
        panel: w('#panel'),
        friends: w('#tg-friends'),
        tgchat: w('#tg-chat'),
        aside: w('.mid-pane[data-mp="tele1"] .tg-conv-aside'),
        mainCols: getComputedStyle(document.querySelector('main')).gridTemplateColumns,
      };
    });
    out.push({ shot, measured });
    console.log('  ' + shot.key + ' (' + shot.w + 'px):',
      '①', measured.list, '②', measured.friends, '③', measured.tgchat, '④', measured.aside, '⑤', measured.panel,
      '| grid:', measured.mainCols);

    // 标注层：把实测像素值画在栏上（纯截图内，不进生产）
    await page.evaluate((info) => {
      const ann = document.createElement('div');
      ann.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;';
      document.body.appendChild(ann);

      const paint = (sel, color, title, val, opts) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const b = document.createElement('div');
        b.style.cssText = `position:fixed;left:${r.x - 2}px;top:${r.y - 2}px;width:${Math.max(r.width, 2) + 4}px;height:${r.height + 4}px;border:3px solid ${color};border-radius:5px;`;
        ann.appendChild(b);
        const t = document.createElement('div');
        const ty = (opts && opts.top) ? r.y + 6 : r.y - 24;
        t.style.cssText = `position:fixed;left:${Math.max(0, r.x)}px;top:${ty}px;background:${color};color:#fff;font-size:12px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;`;
        t.textContent = title + ' ' + val;
        ann.appendChild(t);
        return r;
      };

      const m = info.m;
      paint('#list', '#16a34a', '① 左栏', m.list + 'px', { top: true });
      paint('#tg-friends', '#2563eb', '② 好友对话', m.friends + 'px', { top: true });
      // ③ 太窄时标签横排放右边，免得压住内容
      const rc = paint('#tg-chat', '#ea580c', '③ 对话信息', m.tgchat + 'px', { top: m.tgchat < 160 });
      if (m.tgchat < 160) {
        const el = document.querySelector('#tg-chat');
        const r = el.getBoundingClientRect();
        const old = ann.lastChild;
        if (old) { old.style.left = (r.x + 26) + 'px'; old.style.top = (r.y + 8) + 'px'; }
      }
      paint('.mid-pane[data-mp="tele1"] .tg-conv-aside', '#7c3aed', '④ 资料卡', m.aside + 'px', { top: true });
      paint('#panel', '#be185d', '⑤ 右栏', m.panel + 'px', { top: true });

      // 🔴 右栏「自动开关」按钮 —— 老板指定的 400px 那一带，用蓝框圈出来
      const pab = document.querySelector('#panel-auto-toggle');
      if (pab) {
        const r = pab.getBoundingClientRect();
        const b = document.createElement('div');
        b.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #0d9488;border-radius:5px;`;
        ann.appendChild(b);
        const t = document.createElement('div');
        t.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y + r.height + 6}px;background:#0d9488;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;`;
        t.textContent = '▼ ⑤「自动」开关（Alt+P 立即收起）';
        ann.appendChild(t);
      }

      // 顶部横幅：这档窗口的说明 + 手动开关按钮提示
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:6px;background:rgba(17,17,17,.92);color:#fff;font-size:13px;font-weight:700;padding:6px 16px;border-radius:16px;z-index:100000;white-space:nowrap;';
      bar.textContent = info.label + '　|　实测 ①' + m.list + ' ②' + m.friends + ' ③' + m.tgchat + ' ④' + m.aside + ' ⑤' + m.panel;
      ann.appendChild(bar);

      // 圈出手动开关按钮
      const tg = document.querySelector('#tg-chat-toggle');
      if (tg) {
        const r = tg.getBoundingClientRect();
        const b = document.createElement('div');
        b.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #dc2626;border-radius:5px;`;
        ann.appendChild(b);
        const t = document.createElement('div');
        t.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y + r.height + 6}px;background:#dc2626;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;`;
        t.textContent = '▲ 手动开关（Alt+D）';
        ann.appendChild(t);
      }
    }, { label: shot.label, m: measured });

    await new Promise((r) => setTimeout(r, 300));

    const f1 = path.join(OUT_DIR, 'v1112-对话信息伸缩-' + shot.key + '-' + shot.w + 'px.png');
    await page.screenshot({ path: f1 });
    out[out.length - 1].file = f1;

    await page.close();
  }

  // ---- 第 4 张：最大化 + 手动开关「收起」态（证明 ③ 能手动归零，且按钮会变蓝）----
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1900, height: 820, deviceScaleFactor: 1 });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 40000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => {
      const tab = document.querySelector('.mtab[data-mp="tele1"]');
      if (tab) tab.click();
    });
    await new Promise((r) => setTimeout(r, 600));
    // 走**生产**的 toggleTgChat()，证明真按钮点得动
    const after = await page.evaluate(() => {
      const btn = document.getElementById('tg-chat-toggle');
      const before = Math.round(document.querySelector('#tg-chat').getBoundingClientRect().width);
      if (btn) btn.click();// 真实 click → 触发 initMidTabs 里绑的 onclick
      const wrap = document.querySelector('.mid-pane[data-mp="tele1"] .tele-wrap');
      const after = Math.round(document.querySelector('#tg-chat').getBoundingClientRect().width);
      return { before, after, off: wrap ? wrap.classList.contains('tgchat-off') : null };
    });
    console.log('  D (1900px 手动收起):③ ' + after.before + 'px → ' + after.after + 'px  tgchat-off=' + after.off);
    await page.evaluate(() => {
      const ann = document.createElement('div');
      ann.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;';
      document.body.appendChild(ann);
      const tg = document.querySelector('#tg-chat-toggle');
      if (tg) {
        const r = tg.getBoundingClientRect();
        const b = document.createElement('div');
        b.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #dc2626;border-radius:5px;`;
        ann.appendChild(b);
        const t = document.createElement('div');
        t.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y + r.height + 6}px;background:#dc2626;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;`;
        t.textContent = '▲ 点这个（或 Alt+D）再点一次就展开';
        ann.appendChild(t);
      }
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:6px;background:rgba(220,38,38,.94);color:#fff;font-size:13px;font-weight:700;padding:6px 16px;border-radius:16px;z-index:100000;white-space:nowrap;';
      bar.textContent = '手动收起态 · 窗口 1900 很宽，但 ③ 照样能手动归零（与窗口宽度互不干扰）';
      ann.appendChild(bar);
    });
    await new Promise((r) => setTimeout(r, 300));
    const f = path.join(OUT_DIR, 'v1112-对话信息伸缩-D-手动收起态.png');
    await page.screenshot({ path: f });
    console.log('OK → preview/' + path.basename(f));
    await page.close();
  }

  // ---- 第 7 张：1050 窗口 + 把「自动」开关关掉 → 证明开关是真的、关了⑤ 就不动 ----
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1050, height: 820, deviceScaleFactor: 1 });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 40000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => {
      const t = document.querySelector('.mtab[data-mp="tele1"]');
      if (t) t.click();
    });
    await new Promise((r) => setTimeout(r, 500));
    // 走生产按钮：点一下「⇥ 自动」→ 关掉
    const r2 = await page.evaluate(() => {
      const before = Math.round(document.querySelector('#panel').getBoundingClientRect().width);
      const btn = document.getElementById('panel-auto-toggle');
      if (btn) btn.click();
      return { before, after: Math.round(document.querySelector('#panel').getBoundingClientRect().width),
               txt: btn ? btn.textContent : '', auto: document.body.classList.contains('panel-auto') };
    });
    console.log('  G (1050px 自动已关): ⑤ ' + r2.before + 'px → ' + r2.after + 'px  按钮="' + r2.txt + '"  panel-auto=' + r2.auto);
    await page.evaluate(() => {
      const ann = document.createElement('div');
      ann.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;';
      document.body.appendChild(ann);
      const p = document.querySelector('#panel');
      const pr = p.getBoundingClientRect();
      const b = document.createElement('div');
      b.style.cssText = `position:fixed;left:${pr.x - 2}px;top:${pr.y - 2}px;width:${pr.width + 4}px;height:${pr.height + 4}px;border:3px solid #be185d;border-radius:5px;`;
      ann.appendChild(b);
      const btn = document.querySelector('#panel-auto-toggle');
      if (btn) {
        const r = btn.getBoundingClientRect();
        const b2 = document.createElement('div');
        b2.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #0d9488;border-radius:5px;`;
        ann.appendChild(b2);
        const t = document.createElement('div');
        t.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y + r.height + 6}px;background:#0d9488;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;`;
        t.textContent = '▼ 已关成「定宽」· 1050px 窗口下 ⑤ 仍守 500px';
        ann.appendChild(t);
      }
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:6px;background:rgba(13,148,136,.95);color:#fff;font-size:13px;font-weight:700;padding:6px 16px;border-radius:16px;z-index:100000;white-space:nowrap;';
      bar.textContent = '「自动」开关关掉后：窗口 1050px，⑤ 依然守 500px 不动 —— 开关是真开关';
      ann.appendChild(bar);
    });
    await new Promise((r) => setTimeout(r, 300));
    const f = path.join(OUT_DIR, 'v1112-对话信息伸缩-G-自动已关-定宽500.png');
    await page.screenshot({ path: f });
    console.log('OK → preview/' + path.basename(f));
    await page.close();
  }

  // ---- 第 8、9 张：同一个窗口下「点自动 → 收 80」「再点自动 → 弹回 400」----
  for (const step of [
    { tag: 'H-点自动收缩进去', clickTimes: 1, want: 'thin', title: '点了「自动」→ 右栏收缩到 80px 固定宽度' },
    { tag: 'I-再点自动弹出来', clickTimes: 2, want: 'mid', title: '再点「自动」→ 右栏弹回来（400px）' },
  ]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 840, deviceScaleFactor: 1 });
    // 🔴 必须先清 localStorage：上一轮截图点过按钮，'panel.width' 会留在盘上，
    // 导致这一轮「点1 次」的起点不是 open，测出来全是错的。
    await page.evaluateOnNewDocument(() => {
      try { localStorage.removeItem('panel.width'); localStorage.removeItem('tg.chatHidden'); } catch (e) {}
    });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 40000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => {
      const t = document.querySelector('.mtab[data-mp="tele1"]');
      if (t) t.click();
      // 灌数据（样式一律走生产）
      try { window.paintCustomers = function () {}; } catch (e) {}
      try { window.refreshTgStatus = async function () {}; } catch (e) {}
      try { window.renderTgStatus = function () {}; } catch (e) {}
      try { window.refreshToday = async function () {}; } catch (e) {}
      const tgf = document.getElementById('tgf-list');
      if (tgf) {
        tgf.innerHTML = [['E', 'Elieen Lin', '10:14', '你好', 2], ['V', 'Vanessa', '09:02', 'The portrait looks amazing!', 0],
          ['X', 'Xue', '0:15', '请问可以加急吗', 1], ['R', 'Richard Bennett', '昨天', 'Happy holidays!', 0]]
          .map(([i, n, tm, pv, un]) => `<div class="tgf-row"><span class="tg-ava">${i}</span>
            <div class="tgf-meta"><div class="tgf-top"><span class="tgf-name">${n}</span><span class="tgf-time">${tm}</span></div>
            <div class="tgf-prev">${pv}</div></div>${un ? `<span class="tgf-unread">${un}</span>` : ''}</div>`).join('');
      }
      const pb = document.getElementById('tg-profile-body');
      if (pb) pb.innerHTML = `
        <div class="tv-head" style="display:flex;align-items:center;gap:8px;">
          <span class="tg-ava" style="width:34px;height:34px;font-size:15px;">E</span>
          <span style="display:flex;flex-direction:column;min-width:0;">
            <span><span class="code">7A00038</span><span class="cname">Elieen Lin</span></span>
            <span style="font-size:11px;color:#2e9e5b;font-weight:600;">● 在线</span></span></div>
        <div class="tv-ln"><b class="tv-f-joined">加入时间</b><span class="tv-val">10-13 2019</span></div>
        <div class="tv-ln"><b style="color:#1f6aa5;">手机号</b><span class="tv-val" style="font-weight:700;">+1 415 555 0132</span></div>
        <div class="tv-ln"><b style="color:#1f6aa5;">Username</b><span class="tv-val">@elieen_lin</span></div>
        <div class="tv-ln sep"><b class="tv-f-region">地区</b><span class="chip chip-region">美国</span></div>`;
      const st = document.getElementById('tg-status');
      if (st) { st.className = 'tg-status ok'; st.textContent = '已登录 · Telegram 采集中（外部 Chrome）'; }
    });
    await new Promise((r) => setTimeout(r, 400));

    // 走**生产按钮**点N 次
    const rr = await page.evaluate((times) => {
      const btn = document.getElementById('panel-auto-toggle');
      const out = [];
      for (let k = 0; k < times; k++) {
        btn.click();
        out.push({ w: Math.round(document.querySelector('#panel').getBoundingClientRect().width),
                   st: [...document.body.classList].filter((c) => /^panel-/.test(c))[0] });
      }
      return out;
    }, step.clickTimes);
    const last = rr[rr.length - 1];
    console.log('  ' + step.tag + ' (' + step.clickTimes + ' 次点击):⑤=' + last.w + 'px  body.' + last.st
      + '　期望=' + step.want + (last.st === 'panel-' + step.want ? '✓' : '✗ 不符！'));

    await page.evaluate((info) => {
      const ann = document.createElement('div');
      ann.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;';
      document.body.appendChild(ann);
      const p = document.querySelector('#panel');
      const pr = p.getBoundingClientRect();
      const b = document.createElement('div');
      b.style.cssText = `position:fixed;left:${pr.x - 2}px;top:${pr.y - 2}px;width:${pr.width + 4}px;height:${pr.height + 4}px;border:3px solid #be185d;border-radius:5px;`;
      ann.appendChild(b);
      const t0 = document.createElement('div');
      t0.style.cssText = `position:fixed;left:${pr.x}px;top:${pr.y - 24}px;background:#be185d;color:#fff;font-size:12px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;`;
      t0.textContent = '⑤ 右栏 ' + Math.round(pr.width) + 'px';
      ann.appendChild(t0);
      const btn = document.querySelector('#panel-auto-toggle');
      if (btn && pr.width > 120) {
        const r = btn.getBoundingClientRect();
        const b2 = document.createElement('div');
        b2.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #0d9488;border-radius:5px;`;
        ann.appendChild(b2);
        const t = document.createElement('div');
        t.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y + r.height + 6}px;background:#0d9488;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;`;
        t.textContent = '▼「自动」按钮（Alt+P）';
        ann.appendChild(t);
      }
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:6px;background:rgba(15,23,42,.94);color:#fff;font-size:13px;font-weight:700;padding:6px 16px;border-radius:16px;z-index:100000;white-space:nowrap;';
      bar.textContent = info;
      ann.appendChild(bar);
    }, step.title);
    await new Promise((r) => setTimeout(r, 250));
    const f = path.join(OUT_DIR, 'v1112-右栏自动开关-' + step.tag + '.png');
    await page.screenshot({ path: f });
    console.log('OK → preview/' + path.basename(f));
    await page.close();
  }

  await browser.close();
  console.log('\nOK →');
  out.forEach((o) => console.log('   preview/' + path.basename(o.file) +'　③=' + o.measured.tgchat + 'px'));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });