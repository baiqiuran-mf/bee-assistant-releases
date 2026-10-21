/**
 * 截图：全局设置窗的「AI 设置」与「代理」两页（puppeteer 真实渲染）
 *
 * 用途：v2.6.1098 老板要求把「代理行」和「AI 服务商卡片」改成一行放齐，
 *       改完要拿真实截图给老板看，不能只靠代码。
 *
 * 跑法：node --experimental-sqlite test/shot_settings.js
 * 产物：preview/设置-AI设置.png（第一个服务商卡片）
 *       preview/设置-代理.png（代理页第一行）
 */

const fs = require('fs');
const path = require('path');

require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8983;

(async () => {
  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');

  const cfg = loadConfig();
  const srv = createServer(
    { db, doc, ai, knowledge, cfg, getAccountStates: () => [] },
    PORT
  );
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

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1320, height: 900, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${PORT}/settings.html`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1200));

    // ① AI 设置：截第一个「有 .ai-fields」的服务商卡片（前两张，证明模型都同款）
    const cards = await page.$$('#ai-body .ai-sec');
    const provCards = [];
    for (const c of cards) {
      const has = await c.evaluate((el) => !!el.querySelector('.ai-fields'));
      if (has) provCards.push(c);
    }
    if (provCards.length) {
      // 用「标题行 + 前两张卡片」的裁剪框，一次看全
      // 先把「二、N 个服务商」那一条滚到视口顶部，再按视口坐标裁剪（否则裁剪框落在视口外 → 截出空白）
      await page.evaluate(() => {
        const heads = [...document.querySelectorAll('#ai-body .ai-prov-head')];
        const head = heads.find((h) => /服务商/.test(h.textContent)) || heads[heads.length - 1];
        if (head) head.scrollIntoView({ block: 'start' });
      });
      await new Promise((r) => setTimeout(r, 300));
      const clip = await page.evaluate(() => {
        const heads = [...document.querySelectorAll('#ai-body .ai-prov-head')];
        // 「二、N 个服务商：填地址和 key」那一条（不是「一、抽客户档案用哪个 AI」）
        const head = heads.find((h) => /服务商/.test(h.textContent)) || heads[heads.length - 1];
        const all = [...document.querySelectorAll('#ai-body .ai-sec')].filter((s) => s.querySelector('.ai-fields'));
        const a = head ? head.getBoundingClientRect() : all[0].getBoundingClientRect();
        const b = (all[1] || all[0]).getBoundingClientRect();
        const x = Math.min(a.left, b.left) - 4;
        const y = a.top - 4;
        return {
          x: Math.max(0, x),
          y: Math.max(0, y),
          width: Math.max(a.right, b.right) - x + 8,
          height: b.bottom - y + 8,
        };
      });
      await page.screenshot({ path: path.join(outDir, '设置-AI设置.png'), clip });
    }

    // ② 代理：点「🔌 代理」页签，截第一行
    const tab = await page.$('.set-tab[data-tab="proxy"]');
    if (tab) await tab.click();
    await new Promise((r) => setTimeout(r, 900));
    const pxRow = await page.$('#proxy-body .px-row');
    if (pxRow) {
      const box = await pxRow.boundingBox();
      await page.screenshot({
        path: path.join(outDir, '设置-代理.png'),
        clip: {
          x: Math.max(0, box.x - 4),
          y: Math.max(0, box.y - 4),
          width: box.width + 8,
          height: box.height + 8,
        },
      });
    }

    console.log('截图完成：');
    console.log('  preview/设置-AI设置.png（服务商卡片：三字段一行 + 测试连接并入申请行）');
    console.log('  preview/设置-代理.png（代理行：一行放齐）');
  } finally {
    await browser.close();
    srv.server.close();
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
