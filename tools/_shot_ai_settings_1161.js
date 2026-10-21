/* 只读诊断（2026-10-18）：起静态服务 + 用真实 src/ai.js 目录 + 生产 config 渲染
 * 真实 settings.html，截「AI 设置」页，核对：
 *   ① 采纳后翻成英文 / 手动自由翻译 下拉里有「阿里百炼 Bailian（DashScope）」
 *   ② 回复建议 = AstrBot
 *   ③ 气泡翻译模型 下拉只有 7 家
 *   ④ 服务商区出现「硅基流动 OCR」卡片
 * 不写库、不改配置、不启动 Electron。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PORT = 8811;
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
snap.bubbleTranslateModel = 'tikhub';
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
    const out = { tasks: {}, bubble: [], providers: [] };
    for (const s of document.querySelectorAll('select.ai-task-pick')) {
      out.tasks[s.dataset.task] = {
        value: s.value,
        options: [...s.options].map((o) => o.textContent.trim()),
      };
    }
    const b = document.getElementById('ai-bubble-model');
    if (b) out.bubble = [...b.options].map((o) => o.textContent.trim());
    for (const h of document.querySelectorAll('.ai-sec-head')) out.providers.push(h.textContent.replace(/\s+/g, ' ').trim());
    return out;
  });
  console.log('TASK_SELECTS=' + JSON.stringify(info.tasks, null, 2));
  console.log('BUBBLE_OPTIONS=' + JSON.stringify(info.bubble, null, 2));
  console.log('PROVIDER_HEADS=' + JSON.stringify(info.providers, null, 2));

  await page.screenshot({ path: path.join(ROOT, 'preview', 'verify_1161_ai_top.png') });

  await page.evaluate(() => {
    const h = document.querySelector('.ai-tasks');
    if (h) h.scrollIntoView({ block: 'start' });
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(ROOT, 'preview', 'verify_1161_ai_tasks.png') });

  const ocr = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.ai-sec')];
    const hit = nodes.find((n) => /硅基流动 OCR/.test(n.textContent || ''));
    if (!hit) return null;
    hit.scrollIntoView({ block: 'center' });
    return true;
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(ROOT, 'preview', 'verify_1161_ai_ocr.png') });
  console.log('OCR_CARD=' + !!ocr);

  await browser.close();
  srv.close();
})().catch((e) => { console.error('FAIL', e && e.message); process.exit(1); });
