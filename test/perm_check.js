/**
 * 界面权限自检（v2.6.1106）
 *
 * 老板 2026-10-14 三条要求里的第 2、3 条：
 *   2) WA①~⑤ 标签对所有人生效、功能同管理员（2026-10-17 起不再分权限）；页签内网页不再强制空白
 *   3) 全局设置里「AI 提示词 / AI 设置 / 模拟新消息 / Telegram / 代理 / 截图设置」仍只管理员可见
 *
 * 这个脚本用**真实浏览器**把四种身份各跑一遍，断言界面到底藏没藏对：
 *   · WA①~⑤  → 所有人可见（2026-10-17 起不再分权限，含非管理员 / 未登录）
 *   · 设置页 6 个页签 → 仅管理员可见；未登录 / user / editor 都看不到
 *   · admin 管理员   → 设置页全放出来
 *
 * 跑法：node --experimental-sqlite test/perm_check.js
 * 退出码 0 = 全绿；非 0 = 有断言没过。
 */

const path = require('path');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8988;

/** 设置窗里这 6 个页签只对管理员开放；这 2 个谁都能看 */
const ADMIN_TABS = ['ai', 'prompts', 'sim', 'telegram', 'proxy', 'screenshot'];
const OPEN_TABS = ['cloud', 'update'];

let pass = 0;
let fail = 0;

function ok(cond, label, detail) {
  if (cond) { pass += 1; console.log('  ✅ ' + label + (detail ? '  →  ' + detail : '')); }
  else { fail += 1; console.log('  ❌ ' + label + (detail ? '  →  ' + detail : '')); }
}

function mockStatus(kind) {
  const base = { configured: true, online: true, operator: null, loggedIn: false };
  if (kind === 'user') return Object.assign(base, { loggedIn: true, operator: { id: 1, code: 'mj005', name: '会员', role: 'user' } });
  if (kind === 'editor') return Object.assign(base, { loggedIn: true, operator: { id: 2, code: 'editor1', name: '二级', role: 'editor' } });
  if (kind === 'admin') return Object.assign(base, { loggedIn: true, operator: { id: 3, code: 'admin', name: '管理员', role: 'admin' } });
  return base; // 未登录
}

/** 在浏览器里量一个元素是不是真的看不见（offsetParent 为 null = 藏住了） */
const VISIBLE_FN = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return { exists: false, visible: false, src: null };
  const r = el.getBoundingClientRect();
  return {
    exists: true,
    visible: !!(el.offsetParent || (r.width > 0 && r.height > 0)),
    src: el.getAttribute ? el.getAttribute('src') : null,
    cls: el.className || '',
  };
};

(async () => {
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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  async function openWith(page, kind, urlPath) {
    // 🔴 关键：本脚本自己也是 puppeteer 跑的，会被 perm.js 的「自动化豁免」放过，
    //    那就什么都测不到了。所以这里抢在页面脚本之前把权限检查**强制打开**，
    //    这样才能量到真实会员 / 真实管理员看到的样子。
    await page.evaluateOnNewDocument(() => {
      try { localStorage.setItem('bee.perm', 'on'); } catch (e) { /* 存不进去就算了 */ }
    });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      try {
        if (req.url().includes('/api/cloud/status')) {
          return req.respond({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify(mockStatus(kind)),
          });
        }
        req.continue();
      } catch (e) { /* 请求已处理完，忽略 */ }
    });
    await page.goto(`http://127.0.0.1:${PORT}${urlPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 900));
  }

  try {
    for (const kind of ['未登录', 'user', 'editor', 'admin']) {
      const shouldSee = kind === 'admin';
      console.log('\n=== 身份：' + kind + '（预期：受限界面' + (shouldSee ? '看得见' : '看不见') + '）===');

      // ---------- 主窗口：WA①（2026-10-17 起对所有人生效，不再分权限） ----------
      {
        const page = await browser.newPage();
        await page.setViewport({ width: 1320, height: 900 });
        await openWith(page, kind, '/index.html');
        const btn = await page.evaluate(VISIBLE_FN, '.mtab[data-mp="wa1"]');
        const pane = await page.evaluate(VISIBLE_FN, '.mid-pane[data-mp="wa1"]');
        const wv = await page.evaluate(VISIBLE_FN, '#wa1-webview');
        const gen = await page.evaluate(VISIBLE_FN, '.mtab[data-mp="general"]');

        // 🔴 2026-10-17 老板拍板：WA①~⑤ 对所有人生效（含非管理员），功能同管理员。
        //    不论身份，WA① 页签按钮、面板都可见；webview 不再被强制清空。
        const waShouldSee = true;
        ok(btn.exists, 'WA① 页签按钮还在 DOM 里（功能保留，没删）');
        ok(btn.visible === waShouldSee, 'WA① 页签按钮所有身份都可见',
          '实际 visible=' + btn.visible);
        ok(pane.visible === waShouldSee, 'WA① 面板所有身份都可见',
          '实际 visible=' + pane.visible);
        ok(String(wv.src || '') !== 'about:blank', 'WA① 网页未被强制清空（所有人都能加载）',
          'src=' + wv.src);
        ok(gen.visible, '「通用」页签始终可见（没被误伤）');
        await page.close();
      }

      // ---------- 设置窗：6 个页签 ----------
      {
        const page = await browser.newPage();
        await page.setViewport({ width: 1320, height: 900 });
        await openWith(page, kind, '/settings.html');
        for (const t of ADMIN_TABS) {
          const r = await page.evaluate(VISIBLE_FN, `.set-tab[data-tab="${t}"]`);
          const sec = await page.evaluate(VISIBLE_FN, `#sec-${t}`);
          ok(r.visible === shouldSee && sec.visible === shouldSee,
            '页签「' + t + '」' + (shouldSee ? '可见' : '已隐藏'),
            '按钮 visible=' + r.visible + '，内容区 visible=' + sec.visible);
        }
        for (const t of OPEN_TABS) {
          const r = await page.evaluate(VISIBLE_FN, `.set-tab[data-tab="${t}"]`);
          ok(r.visible, '页签「' + t + '」所有人可见（没被误伤）');
        }
        if (!shouldSee) {
          const onTab = await page.evaluate(() => {
            const el = document.querySelector('.set-tab.on');
            return el ? el.dataset.tab : null;
          });
          ok(onTab && OPEN_TABS.indexOf(onTab) >= 0,
            '当前停在开放页签（没卡在被藏的页上）', '当前 tab=' + onTab);
        }
        await page.close();
      }
    }

    // ---------- perm.js 自身可达性 ----------
    console.log('\n=== 文件可达性 ===');
    {
      const page = await browser.newPage();
      const resp = await page.goto(`http://127.0.0.1:${PORT}/perm.js`, { waitUntil: 'domcontentloaded' });
      ok(resp && resp.status() === 200, 'perm.js 能被浏览器拿到', 'HTTP ' + (resp && resp.status()));
      const has = await page.evaluate(async () => {
        const t = await (await fetch('/perm.js')).text();
        return t.includes('ADMIN_ROLE') && t.includes("'admin'");
      });
      ok(has, 'perm.js 内容完整（含 admin 判定）');
      await page.close();
    }
  } finally {
    await browser.close();
    try { srv.server.close(); } catch (e) { /* 关不掉就算了 */ }
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自检脚本异常：', e);
  process.exit(1);
});
