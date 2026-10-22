// 只读渲染：把标签方案预览图截成 PNG（人设对话 & GPT对话两个状态）
// 用法：node tools/_shot_tabs_proposal.js
const path = require('path');
const puppeteer = require('puppeteer');

(async () => {
  const htmlPath = path.join(__dirname, '..', 'preview', '_tabs_proposal.html');
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-device-scale-factor=1.5'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.5 });
    const shots = [
      { url: fileUrl + '?a#persona', out: 'preview/_tabs_persona.png' },
      { url: fileUrl + '?b#gpt', out: 'preview/_tabs_gpt.png' },
    ];
    for (const s of shots) {
      await page.goto(s.url, { waitUntil: 'load' });
      await new Promise((r) => setTimeout(r, 400));
      const out = path.join(__dirname, '..', s.out);
      await page.screenshot({ path: out, fullPage: false });
      console.log('saved ->', out);
    }
    // 再单独放大截一张标签栏近景，方便看宽度/配色
    await page.goto(fileUrl + '?c#persona', { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 300));
    const tabs = await page.$('#tabs');
    if (tabs) {
      const out = path.join(__dirname, '..', 'preview', '_tabs_bar.png');
      await tabs.screenshot({ path: out });
      console.log('saved ->', out);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('SHOT FAILED:', e && e.stack || e); process.exit(1); });
