/* 只读预览：渲染「更新中」窗口的两种状态（下载 / 安装），产出 PNG 供老板确认。
 * 不改产品代码，只产 preview/_update_*.png。 */
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const HTML = 'file://' + path.join(ROOT, 'preview', '_update_mock.html');
const OUT = path.join(ROOT, 'preview');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 550, deviceScaleFactor: 2 });
  await page.goto(HTML, { waitUntil: 'networkidle0' });

  // 安装态
  await page.evaluate(() => window.__setMode('install'));
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, '_update_install.png') });

  // 下载态（35%）
  await page.evaluate(() => window.__setMode('download', 35));
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, '_update_download.png') });

  await browser.close();
  console.log('OK ->', path.join(OUT, '_update_install.png'), path.join(OUT, '_update_download.png'));
})();
