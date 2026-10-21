/**
 * v2.6.1111 预览截图（🔴 只出图，**生产文件一个字节都不改**）
 *
 * 老板 2026-10-14 14:04 指令：
 *   ① 右栏红框位置（话术库下方那块空白）放「Telegram 采集数据」日志栏 ——
 *      采到了什么就列什么，**没采到也要明确写出来**，当成日志。
 *   ② 左栏列表点选 → 自动跳「通用」页签；Tele① 好友列点选 → 与左栏互斥，
 *      两边的"当前客户"是同一个 → 话术编排台跟着走（属数据流改动，另出架构图）
 *   ③ T 收不到消息的根因排查（不在本脚本范围）
 *
 * 跑法：node --experimental-sqlite test/shot_v1111_preview.js
 * 产物：preview/v1111-A-右栏Telegram采集日志.png
 *       preview/v1111-B-左栏点选跳通用.png
 */

const fs = require('fs');
const path = require('path');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8995;
const OUT = path.join(ROOT, 'preview');

/** 预览用的采集日志（真实字段口径：code / 姓名 / 号码 / username / 在线 / 消息） */
const LOG_ROWS = [
  { t: '14:04:12', k: 'ok', s: '已登录 Telegram 官方直连（账号 7 · @wanfengzhiqiu · 16058384634）' },
  { t: '14:04:13', k: 'ok', s: '开始采集：本机 4 个会话 / 6 位客户，逐条记录采集结果' },
  { t: '14:04:14', k: 'info', s: '客户 7A00001 Eileen Lin ｜ 手机 14155550132 ｜ @elieen_lin ｜ 在线' },
  { t: '14:04:14', k: 'info', s: '客户 7A00002 Xue ｜ 手机 未采到（对方隐私设置不公开） ｜ @Lsherry3 ｜ 最近在线' },
  { t: '14:04:15', k: 'info', s: '客户 7A00003 Richard Bennett ｜ 手机 未采到（对方隐私设置不公开） ｜ @Richarddedicatedaccount' },
  { t: '14:04:15', k: 'warn', s: '资料未采到：客户 7A00004 / 7A00005 的 username 与手机号均为空 —— 已记日志，稍后重试' },
  { t: '14:05:02', k: 'ok', s: '新消息 Eileen Lin：Hello  （已入库 messages #781，待翻译）' },
  { t: '14:05:03', k: 'ok', s: '新消息 Richard Bennett：Can you finish it before Christmas?  （已入库 #782）' },
  { t: '14:06:00', k: 'info', s: '本小时小结：收到 2 条 / 采到手机号 1 个 / 未采到 2 个 / 无新消息时段 1 段' },
  { t: '14:07:30', k: 'warn', s: '本轮未采到任何新消息（0 条）—— 采集链路正常，只是对方没发' },
];

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
    t.style.cssText = 'position:fixed;left:' + Math.max(2, cx) + 'px;top:' + Math.max(2, cy - h / 2 - 30) +
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
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 780, deviceScaleFactor: 1.4 });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));

    /* ---------- ① 右栏底部：Telegram 采集数据日志栏（内存注入，生产未动） ---------- */
    await page.evaluate((rows, annotateFn) => {
      new Function(annotateFn)();
      try { window.refreshToday = async function () {}; } catch (e) {}
      const boot = document.getElementById('boot-login');
      if (boot) boot.style.display = 'none';
      if (typeof renderAccounts === 'function') {
        renderAccounts([1, 2, 3, 4, 5].map((n) => ({ id: 'acct' + n, label: ['一号', '二号', '三号', '四号', '五号'][n - 1], status: 'online' })));
      }
      if (typeof renderLaunchers === 'function') {
        renderLaunchers([1, 2, 3].map((n) => ({ id: 's' + n, label: 'S' + n, kind: 'signal', status: 'red', title: 'Signal ' + n })));
      }

      const st = document.createElement('style');
      st.id = 'preview-tglog';
      st.textContent = `
        .tg-log{flex:0 0 auto;display:flex;flex-direction:column;min-height:0;max-height:38%;
          margin:0;border-top:2px solid var(--ln-purple);background:#fff;}
        .tgl-head{flex:0 0 auto;display:flex;align-items:baseline;gap:8px;padding:8px 12px;
          background:#f6f8f7;border-bottom:1px solid var(--ln-green);}
        .tgl-title{font:700 13px/1.6 system-ui,"Microsoft YaHei";color:var(--text);}
        .tgl-sub{font:12px/1.6 system-ui,"Microsoft YaHei";color:#6b7683;margin-left:auto;}
        .tgl-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px 12px 12px;}
        .tgl-row{display:flex;gap:7px;align-items:flex-start;padding:3px 0;
          font:12px/1.75 system-ui,"Microsoft YaHei";border-bottom:1px dashed #eef1f4;}
        .tgl-time{flex:0 0 auto;color:#98a2ad;font-variant-numeric:tabular-nums;}
        .tgl-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;margin-top:7px;}
        .tgl-s{flex:1 1 auto;color:var(--text);word-break:break-word;}
        .tgl-row.ok .tgl-dot{background:#2f9e63;}
        .tgl-row.info .tgl-dot{background:#1f6aa5;}
        .tgl-row.warn .tgl-dot{background:#e08b23;}
        .tgl-row.warn .tgl-s{color:#a35f00;}
      `;
      document.head.appendChild(st);

      const panel = document.getElementById('panel');
      const box = document.createElement('div');
      box.className = 'card tg-log';
      box.id = 'tg-log';
      box.innerHTML = '<div class="tgl-head"><span class="tgl-title">Telegram 采集数据</span>'
        + '<span class="tgl-sub">账号 7 · 已登录 · 日志 24 条</span></div>'
        + '<div class="tgl-body" id="tgl-body">'
        + rows.map((r) => '<div class="tgl-row ' + r.k + '"><span class="tgl-time">' + r.t + '</span>'
          + '<span class="tgl-dot"></span><span class="tgl-s">' + r.s + '</span></div>').join('')
        + '</div>';
      if (panel) panel.appendChild(box);
    }, LOG_ROWS, ANNOTATE_FN);

    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate(() => { window.__box('#tg-log', '← 新增「Telegram 采集数据」日志栏（红框位置）', '#e02020'); });
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: path.join(OUT, 'v1111-A-右栏Telegram采集日志.png') });

    /* ---------- ② 左栏点选 → 中栏自动跳「通用」（行为改动，出「改后」示意） ---------- */
    await page.evaluate(() => {
      document.querySelectorAll('body > div').forEach((d) => { if (d.style.zIndex && d.id !== 'tg-log') d.remove(); });
      /* 左栏列表：造 3 个客户（含 1 个 Telegram 客户），演示"点哪条都是同一个当前客户" */
      state.customers = [
        { code: '6A00001', name: 'Lin WanQiu', account_id: 6, channel: 'signal', unread: 1, pending: 1, last_body_zh: '你好', created_at: '2026-10-13' },
        { code: '6A00003', name: 'L Sherry', account_id: 6, channel: 'signal', unread: 1, pending: 1, last_body_zh: 'hollo', created_at: '2026-10-13' },
        { code: '7A00001', name: 'Eileen Lin', account_id: 7, channel: 'telegram', unread: 2, pending: 2, last_body_zh: '你好', created_at: '2026-10-11' },
      ];
      if (typeof paintCustomers === 'function') paintCustomers();
      /* 高亮第二条（模拟"点选了左栏某条"） */
      const rows = document.querySelectorAll('.cust');
      if (rows[1]) rows[1].classList.add('active');
      /* 中栏切到「通用」= 改造后的行为 */
      if (typeof switchMidTab === 'function') switchMidTab('general');
      const ch = document.getElementById('chat-head');
      if (ch) ch.textContent = 'L Sherry' + '  · 点选左栏任意一条（含 T 客户）→ 自动跳到「通用」';
    });
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate((annotateFn) => {
      new Function(annotateFn)();
      window.__box('.cust.active', '① 点左栏任意一条（含 T 客户）都选中它', '#e02020');
      window.__box('.mid-tabs', '② 中栏自动跳到「通用」页签', '#1f8f4e');
    }, ANNOTATE_FN);
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: path.join(OUT, 'v1111-B-左栏点选跳通用.png') });

    console.log('OK → preview/v1111-A-右栏Telegram采集日志.png');
    console.log('OK → preview/v1111-B-左栏点选跳通用.png');
  } finally {
    await browser.close();
    srv.server.close();
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
