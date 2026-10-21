/**
 * 拟改预览（不改任何 app 代码）：全局设置「提示条」显示全部长文本
 *
 * 背景（老板 2026-10-13 看图 QQ20261013-223252.png）：
 *   「测试代理」的结果提示被 .set-toast 的 max-width:60% + text-overflow:ellipsis
 *   截断成一行省略号（红色方框里末尾是 …），老板要求**显示全部**。
 *
 * 做法：用 puppeteer 载入真实 settings.html，只在**本次渲染**里注入「拟改 CSS」
 *       （page.addStyleTag），再把那条真实的长提示词调出来截图。
 *       —— 一个字都没写进 app，纯粹给老板看「改完长这样」。
 *
 * 跑法：node --experimental-sqlite test/shot_notice_mockup.js
 * 产物：preview/提示条-现状.png（截断）
 *       preview/提示条-改后.png（全部显示）
 */

const fs = require('fs');
const path = require('path');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8984;

// 与 settings.js:1313 完全一致的那条长提示（值照老板截图）
const LONG_MSG = 'tg1 代理通了：代理IP 198.87.177.142（US · California · Los Angeles）；'
  + '与直连 198.87.177.142（US · California · Los Angeles）相同，可能该实例没走代理或代理本身不换 IP';

// 拟改 CSS：把提示条从「单行省略」改成「浮在页签条下方、按内容折行、全文可见」
const PROPOSED_CSS = `
.set-tabs { position: relative; }
.set-toast {
  max-width: none;
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  position: absolute;
  right: 12px;
  top: calc(100% + 8px);
  width: max-content;
  max-width: min(760px, 94vw);
  line-height: 1.55;
  z-index: 60;
  box-shadow: 0 6px 18px rgba(15,20,30,.18);
}
`;

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

  const outDir = path.join(ROOT, 'preview');
  fs.mkdirSync(outDir, { recursive: true });

  const shotTop = async (page, file) => {
    await new Promise((r) => setTimeout(r, 350));
    const clip = await page.evaluate(() => {
      const head = document.querySelector('.set-head');
      const tabs = document.querySelector('.set-tabs');
      const toast = document.getElementById('set-toast');
      const top = head.getBoundingClientRect().top;
      const tb = tabs.getBoundingClientRect();
      let bottom = tb.bottom;
      if (toast && toast.className.indexOf('show') >= 0) {
        bottom = Math.max(bottom, toast.getBoundingClientRect().bottom);
      }
      return { x: 0, y: Math.max(0, top - 6), width: document.documentElement.clientWidth, height: (bottom - top) + 14 };
    });
    await page.screenshot({ path: path.join(outDir, file), clip });
  };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1320, height: 900, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${PORT}/settings.html`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1200));

    // ① 现状（截断）
    await shotTop(page, '提示条-现状.png').catch(() => {});
    await page.evaluate((t) => {
      if (typeof showNotice === 'function') showNotice('warn', t, 60000);
    }, LONG_MSG);
    await shotTop(page, '提示条-现状.png');

    // ② 拟改（注入 CSS 后再弹一次）
    await page.addStyleTag({ content: PROPOSED_CSS });
    await page.evaluate((t) => {
      if (typeof showNotice === 'function') showNotice('warn', t, 60000);
    }, LONG_MSG);
    await shotTop(page, '提示条-改后.png');

    console.log('预览已生成：');
    console.log('  preview/提示条-现状.png（当前：被 … 截断）');
    console.log('  preview/提示条-改后.png（拟改：全文折行显示，浮在页签条下方）');
  } finally {
    await browser.close();
    srv.server.close();
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
