/**
 * v2.6.1113 · Tele② 标签页 + 顶栏 T①/T② 按钮 + 采集数据日志 —— 真实渲染截图
 *
 * 老板 2026-10-14 17:31/17:38 报的两件事：
 *   ① 顶栏「T①」「T②」按钮不见了，反而自动重复开浏览器
 *   ② Tele① 里红框位置（④资料卡下方）要放「Telegram 采集数据」日志，
 *      「哪怕没有采集到都需要展示在这里，当成日志」
 *   ③ 架构变更：T 不再并入一号/二号/三号，独立开 T①/T②；Tele① 登 T①、Tele② 登 T②
 *
 * 做法：起真实服务 + 真实 index.html（加载**已改好**的生产 CSS/JS），只灌客户数据，
 *      截三张真图：Tele①（日志区）/ Tele②（新页签）/ 顶栏（T 按钮）。
 * 跑法：node --experimental-sqlite test/shot_v1113_tele2.js
 */

const path = require('path');
const fs = require('fs');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8995;
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

  // 灌数据（样式 100% 走生产，只灌客户与日志内容）
  const feed = async (page) => {
    await page.evaluate(() => {
      try { window.paintCustomers = function () {}; } catch (e) {}
      try { window.refreshTgStatus = async function () {}; } catch (e) {}
      try { window.renderTgStatus = function () {}; } catch (e) {}
      try { window.refreshToday = async function () {}; } catch (e) {}
      try { window.onTelegramMessageLive = function () {}; } catch (e) {}

      const rows = (pane, acc) => {
        const list = document.getElementById('tgf-list' + (pane === 'tele2' ? '-t2' : ''));
        if (!list) return;
        const data = acc === '8'
          ? [['X', 'Xue Wong', '刚刚', '我想要一幅我家的猫', 1], ['R', 'Richard Bennett', '10:02', 'The painting looks great!', 0],
             ['Y', 'Yuki Tanaka', '昨天', '请教一下价格', 2], ['Z', 'Zoe Miller', '周一', 'Thank you so much', 0]]
          : [['E', 'Elieen Lin', '10:14', '你好', 2], ['V', 'Vanessa', '09:02', 'The portrait looks amazing!', 0],
             ['X', 'Xue', '0:15', '请问可以加急吗', 1], ['R', 'Richard Bennett', '昨天', 'Happy holidays!', 0],
             ['L', 'L. Sherry', '昨天', 'Thank you so much', 0], ['W', 'Li WaiChu', '周一', '下一幅什么时候能动工？', 3]];
        list.innerHTML = data.map(([i, n, t, p, u]) => `<div class="tgf-row">
          <span class="tg-ava">${i}</span><i class="tgf-dot"></i>
          <div class="tgf-meta"><div class="tgf-top"><span class="tgf-name">${n}</span><span class="tgf-time">${t}</span></div>
          <div class="tgf-prev">${p}</div></div>${u ? `<span class="tgf-unread">${u}</span>` : ''}</div>`).join('');
      };
      rows('tele1', '7');
      rows('tele2', '8');

      // 采集数据日志：模拟真实内容（含「没采到」和「失败」两类，证明分色与占位都work）
      const logs = {
        'tg-log-body-tele1': [
          ['info', 'T①', '采集器启动中…（独立 Chrome 正在打开）'],
          ['ok', 'T①', '采集器已连接 web.telegram.org'],
          ['ok', 'T①', 'Elieen Lin · 采到 手机号 +185256188141 / 用户名 @ElieenLin09'],
          ['ok', 'T①', '采到消息 · Vanessa：「The portrait looks amazing!」'],
          ['miss', 'T①', 'L. Sherry · 未获取到手机号 / 用户名（该客户可能没授权或没聊过）'],
          ['err', 'T①', '7A00007 · 资料读取失败：接口超时'],
        ],
        'tg-log-body-t2': [
          ['info', 'T②', '等待老板在顶栏点 T② 按钮登录'],
          ['miss', 'T②', 'Xue Wong · 未获取到手机号 / 用户名（该客户可能没授权或没聊过）'],
          ['miss', 'T②', 'Yuki Tanaka · 未获取到手机号 / 用户名（该客户可能没授权或没聊过）'],
        ],
      };
      for (const [id, lines] of Object.entries(logs)) {
        const b = document.getElementById(id);
        if (!b) continue;
        b.innerHTML = lines.map(([k, who, tx], i) => {
          const mm = String(10 + Math.floor(i / 3)).padStart(2, '0');
          const ss = String((i * 17) % 60).padStart(2, '0');
          return `<div class="tg-log-line ${k}"><span class="ts">10:${mm}:${ss}</span><span class="who">${who}</span>${tx}</div>`;
        }).join('');
      }

      // 资料卡
      const prof = (suffix, acc, name, phone, user) => {
        const b = document.getElementById('tg-profile-body' + suffix);
        if (!b) return;
        b.innerHTML = `
          <div class="tv-head" style="display:flex;align-items:center;gap:8px;">
            <span class="tg-ava" style="width:34px;height:34px;font-size:15px;">${name.charAt(0)}</span>
            <span style="display:flex;flex-direction:column;min-width:0;">
              <span><span class="code">${acc}A00038</span><span class="cname">${name}</span></span>
              <span style="font-size:11px;color:#2e9e5b;font-weight:600;">● 在线</span></span></div>
          <div class="tv-ln"><b class="tv-f-joined">加入时间</b><span class="tv-val">10-13 20:19</span></div>
          <div class="tv-ln"><i class="tv-star">★</i><i class="tv-sub-joined">认识</i><span class="tv-day-num">第 2 天</span><i class="tv-star">★</i><b class="tv-fact-day">Day 2</b></div>
          <div class="tv-ln sep"><b style="color:#1f6aa5;">手机号</b><span class="tv-val" style="font-weight:700;">${phone}</span></div>
          <div class="tv-ln"><b style="color:#1f6aa5;">Username</b><span class="tv-val">${user}</span></div>
          <div class="tv-ln sep"><b class="tv-f-region">地区</b><span class="chip chip-region">美国</span></div>`;
      };
      prof('', '7', 'Elieen Lin', '+185256188141', '@ElieenLin09');
      prof('-t2', '8', 'Xue Wong', '未获取到', '未获取到');

      const st1 = document.getElementById('tg-status');
      if (st1) { st1.className = 'tg-status ok'; st1.textContent = '已登录 · Telegram 采集中（外部 Chrome）'; }
      const st2 = document.getElementById('tg-status-t2');
      if (st2) { st2.className = 'tg-status warn'; st2.textContent = '未登录 · 点顶栏 T② 按钮打开浏览器登录'; }

      // 对话信息列（Tele① 才有真消息）
      const cb = document.getElementById('tg-chat-body');
      if (cb) {
        cb.innerHTML = `
          <div class="tgc-day">今天</div>
          <div class="tg-crow in"><span class="tg-bubble">Hello! I want a portrait of my cat.</span></div>
          <div class="tg-crow in"><span class="tg-zh">你好！我想给我家猫画一幅肖像。</span></div>
          <div class="tg-crow out"><span class="tg-bubble">当然可以～你家猫多大了？</span></div>`;
      }
      const cb2 = document.getElementById('tg-chat-body-t2');
      if (cb2) {
        cb2.innerHTML = '<div class="tv-empty">点一个好友，这里列他这段对话的原话 + 中文</div>';
      }
      const sub = document.getElementById('tg-chat-sub');
      if (sub) sub.textContent = 'Elieen Lin · 7A00038';

      // 顶栏 T 按钮（真实渲染 renderTgAccounts 的形态）
      const tg = document.getElementById('tg-accounts');
      if (tg) {
        tg.innerHTML = `
          <div class="acct tg-acct online"><span class="led ok"></span>
            <button class="acct-name" title="启动 / 唤起 T① 的 Telegram 浏览器">T①</button></div>
          <div class="acct tg-acct offline"><span class="led err"></span>
            <button class="acct-name" title="启动 / 唤起 T② 的 Telegram 浏览器">T②</button></div>`;
      }
    });
  };

  const shots = [
    { key: '1-Tele①-采集数据日志', mp: 'tele1', w: 1440, h: 900,
      title: 'Tele① · 红框位置 = 「Telegram 采集数据」日志（采到 / 没采到 / 失败 四色都写）' },
    { key: '2-Tele②-新增页签', mp: 'tele2', w: 1440, h: 900,
      title: 'Tele② · 新增页签，功能与 Tele① 一致，数据来自 T② 账号（8 段编号）' },
  ];

  for (const s of shots) {
    const page = await browser.newPage();
    await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      try { localStorage.clear(); } catch (e) {}
    });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 40000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate((mp) => {
      const t = document.querySelector('.mtab[data-mp="' + mp + '"]');
      if (t) t.click();
    }, s.mp);
    await new Promise((r) => setTimeout(r, 500));
    await feed(page);
    await new Promise((r) => setTimeout(r, 400));

    // 量一下日志区实际大小（证明它真撑满了）
    const m = await page.evaluate((mp) => {
      const log = document.querySelector('.mid-pane[data-mp="' + mp + '"] .tg-log');
      const aside = document.querySelector('.mid-pane[data-mp="' + mp + '"] .tg-conv-aside');
      return {
        log: log ? Math.round(log.getBoundingClientRect().width) + '×' + Math.round(log.getBoundingClientRect().height) : 'null',
        aside: aside ? Math.round(aside.getBoundingClientRect().width) + '×' + Math.round(aside.getBoundingClientRect().height) : 'null',
        lines: document.querySelectorAll('.mid-pane[data-mp="' + mp + '"] .tg-log-line').length,
      };
    }, s.mp);
    console.log('  ' + s.key + ': 日志区 ' + m.log + ' （资料卡 ' + m.aside + '，日志行数 ' + m.lines + '）');

    await page.evaluate((t) => {
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:6px;background:rgba(15,23,42,.94);color:#fff;font-size:13px;font-weight:700;padding:6px 16px;border-radius:16px;z-index:100000;white-space:nowrap;';
      bar.textContent = t;
      document.body.appendChild(bar);
      // 圈出采集数据日志区（老板图里的红框位置）
      const log = document.querySelector('.tg-log');
      if (log) {
        const r = log.getBoundingClientRect();
        const b = document.createElement('div');
        b.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #e03131;border-radius:6px;pointer-events:none;z-index:99999;`;
        document.body.appendChild(b);
        const lb = document.createElement('div');
        lb.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y + r.height + 6}px;background:#e03131;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;z-index:100000;`;
        lb.textContent = '▲ 指令①：Telegram 采集数据（绿=采到 / 灰=没采到 / 红=失败）';
        document.body.appendChild(lb);
      }
      // 圈出顶栏 T 按钮
      const tg = document.getElementById('tg-accounts');
      if (tg) {
        const r = tg.getBoundingClientRect();
        const b = document.createElement('div');
        b.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #0284c7;border-radius:6px;pointer-events:none;z-index:99999;`;
        document.body.appendChild(b);
        const lb = document.createElement('div');
        lb.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y + r.height + 6}px;background:#0284c7;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;z-index:100000;`;
        lb.textContent = '▲ 新增顶栏 T①/T② 按钮';
        document.body.appendChild(lb);
      }
    }, s.title);
    await new Promise((r) => setTimeout(r, 300));

    const f = path.join(OUT_DIR, 'v1113-' + s.key + '.png');
    await page.screenshot({ path: f });
    console.log('OK → preview/' + path.basename(f));
    await page.close();
  }

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });