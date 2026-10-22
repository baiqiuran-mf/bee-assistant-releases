/* 只读自检：用真实 public/update-cover.html 验证窗口渲染（不打包、不联网）。 */
const path = require('path');
const puppeteer = require('puppeteer');

const HTML = 'file://' + path.join(__dirname, '..', 'public', 'update-cover.html');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(HTML, { waitUntil: 'networkidle0' });

  const snap = async () => page.evaluate(() => ({
    title: document.getElementById('title').textContent,
    sub: document.getElementById('sub').textContent,
    left: document.getElementById('left').textContent,
    pct: document.getElementById('pct').textContent,
    note: document.getElementById('note').textContent.trim().replace(/\s+/g, ' '),
    isInstall: document.body.classList.contains('install'),
    barW: document.getElementById('bar').style.width,
    imgW: (document.querySelector('.art img') || {}).naturalWidth || 0,
  }));

  const install0 = await snap();

  await page.evaluate(() => window.__upd({ state: 'downloading', percent: 35, version: 'v2.7.1231' }));
  const dl = await snap();

  await page.evaluate(() => window.__upd({ state: 'downloading', percent: 100, version: 'v2.7.1231' }));
  const dl100 = await snap();

  await page.evaluate(() => window.__upd({ state: 'downloaded' }));
  const dlDone = await snap();

  await browser.close();

  const pass = {
    noJsError: errs.length === 0,
    robotLoaded: install0.imgW > 0,
    installTitle: install0.title === '正在安装更新',
    installSub: install0.sub === '更新版本中，请稍等…',
    installMode: install0.isInstall === true,
    installPct: install0.pct === '请勿关闭软件',
    dlTitle: dl.title === '正在下载更新',
    dlSubHasVer: dl.sub.indexOf('v2.7.1231') >= 0,
    dlPct: dl.pct === '35%' && dl.barW === '35%',
    dl100Pct: dl100.pct === '100%' && dl100.barW === '100%',
    dlDoneMode: dlDone.isInstall === true && dlDone.title === '下载完成',
  };

  console.log('snapshots:', JSON.stringify({ install0, dl, dl100, dlDone }, null, 2));
  console.log('errors:', JSON.stringify(errs));
  let ok = true;
  for (const [k, v] of Object.entries(pass)) { console.log((v ? 'PASS' : 'FAIL') + ' ' + k); if (!v) ok = false; }
  console.log(ok ? '\n[UPDATE COVER] ALL PASS' : '\n[UPDATE COVER] HAS FAILURE');
  process.exit(ok ? 0 : 1);
})();
