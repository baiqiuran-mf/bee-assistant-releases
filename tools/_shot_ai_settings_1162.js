/* 只读诊断（2026-10-18）：起静态服务 + 真实 src/ai.js 目录 + 生产 config 渲染
 * 真实 settings.html，核对 2.6.1162 两处删除：
 *   ① 气泡翻译模型 下拉已删「跟随全局翻译 / Agnes / AstrBot」，只剩 5 家
 *   ② 「一套配好」整行（#ai-default）已从界面移除
 * 不写库、不改配置、不启动 Electron。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PORT = 8812;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const CFG_FILE = 'D:/蜜蜂采集数据/wa-assistant/config.yaml';
const ai = require('../src/ai.js');
const cfg = yaml.load(fs.readFileSync(CFG_FILE, 'utf8')) || {};
ai.setAiConfig(cfg.ai || {});

const snap = ai.providerSnapshot((k) => (k ? '••••' + String(k).slice(-4) : ''));
snap.catalog = ai.catalog();
snap.bubbleTranslateModel = 'tikhub'; // 生产实际值
snap.translationMemoryModel = 'deepseek';
snap.extractInterval = 2;
snap.file = 'D:\\蜜蜂采集数据\\wa-assistant\\config.yaml';
snap.aiReady = true;
snap.aiReason = '';

(async () => {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/settings.html';
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(p === '/api/ai/config' ? snap : { ok: true }));
      return;
    }
    const file = path.join(PUB, p.replace(/^\/+/, ''));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nf'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1000, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/settings.html`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 900));

  const info = await page.evaluate(() => {
    const b = document.getElementById('ai-bubble-model');
    const body = document.body.innerText || '';
    const sug = document.querySelector('select.ai-task-pick[data-task="suggest"]');
    return {
      bubbleOptions: b ? [...b.options].map((o) => o.textContent.trim()) : null,
      bubbleValue: b ? b.value : null,
      bubbleCount: b ? b.options.length : 0,
      hasDefaultSelect: !!document.getElementById('ai-default'),
      hasYiTaoText: body.includes('一套配好'),
      hasFollowGlobalOption: b ? [...b.options].some((o) => /跟随全局翻译/.test(o.textContent)) : null,
      hasAgnesOption: b ? [...b.options].some((o) => /Agnes/i.test(o.textContent)) : null,
      hasAstrBotOption: b ? [...b.options].some((o) => /AstrBot/i.test(o.textContent)) : null,
      suggestValue: sug ? sug.value : null,
      suggestText: sug ? sug.options[sug.selectedIndex]?.textContent.trim() : null,
    };
  });
  console.log('VERIFY_1162=' + JSON.stringify(info, null, 2));

  // 截「气泡翻译模型」区块
  await page.evaluate(() => {
    const h = document.querySelector('.ai-bubble-model');
    if (h) h.scrollIntoView({ block: 'center' });
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(ROOT, 'preview', 'verify_1162_bubble.png') });

  // 截「几个 AI 分别干什么」区块（确认没有一套配好那行）
  await page.evaluate(() => {
    const h = document.querySelector('.ai-tasks');
    if (h) h.scrollIntoView({ block: 'start' });
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(ROOT, 'preview', 'verify_1162_tasks.png') });

  await browser.close();
  srv.close();
})().catch((e) => { console.error('FAIL', e && e.message); process.exit(1); });
