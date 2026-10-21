/* 在本地起一个静态服务（只服务 public/），用 http:// 加载真 index.html + 真 app.js + 真 style.css，
 * 这样验证的是**真运行环境**（file:// 下绝对路径取不到 /app.js，老坑）。
 * 🔴 只读、只服务 public/ 目录，验证完就关。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, '.tmp-wa1-verify.png');
const PORT = 8799;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

(async () => {
  await app.whenReady();

  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(PUB, p.replace(/^\/+/, ''));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  console.log('[server] http://127.0.0.1:' + PORT);

  const w = new BrowserWindow({
    width: 1400, height: 900, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await w.loadURL(`http://127.0.0.1:${PORT}/index.html`);
  await new Promise((r) => setTimeout(r, 3500));

  // app.js 跑了吗？先探这个，再切页签
  const r1 = await w.webContents.executeJavaScript(`(function(){
    return JSON.stringify({
      hasSwitchMidTab: (typeof switchMidTab === 'function'),
      hasBindWa1: (typeof bindWa1Buttons === 'function'),
      hasInitWaAddr: (typeof initWaAddrBar === 'function'),
      hasIsWaCustomer: (typeof isWhatsappCustomer === 'function'),
      hasWaActive: (typeof wa1ActiveCode !== 'undefined'),
      styleSheets: document.styleSheets.length,
      rules: (function(){try{return document.styleSheets[0].cssRules.length}catch(e){return -1}})(),
      dayColor: (function(){var e=document.querySelector('.tv-day-num');return e?getComputedStyle(e).color:'';})(),
      teleRulesStillThere: !!document.querySelector('#tg-webview')
    });
  })()`);
  console.log('[boot] ' + r1);

  // 切到 WA①
  const r2 = await w.webContents.executeJavaScript(`(function(){
    try { switchMidTab('wa1'); } catch (e) { return JSON.stringify({err:String(e&&e.message)}); }
    var pane = document.querySelector('.mid-pane[data-mp="wa1"]');
    var aside = pane && pane.querySelector('.tg-conv-aside');
    return JSON.stringify({
      waTabOn: !!document.querySelector('.mtab[data-mp="wa1"]').classList.contains('on'),
      waPaneShown: !!(pane && !pane.classList.contains('hidden')),
      telePaneHidden: document.querySelector('.mid-pane[data-mp="tele1"]').classList.contains('hidden'),
      generalPaneHidden: document.querySelector('.mid-pane[data-mp="general"]').classList.contains('hidden'),
      asideWidthPx: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
      webviewSrc: (document.querySelector('#wa1-webview')||{getAttribute:function(){return null}}).getAttribute('src'),
      btnCount: document.querySelectorAll('.mid-pane[data-mp="wa1"] .tv-actions .tv-btn').length
    });
  })()`);
  console.log('[switch] ' + r2);

  // 登录浮层是软件本来的设计，会挡住整页。截图前把它隐藏（只在诊断窗口里做，不改产品代码），
  // 顺便把左栏/右栏填上真实形状的数据，好让老板看清 WA① 整页长什么样。
  await w.webContents.executeJavaScript(`(function(){
    var kill = [];
    document.querySelectorAll('div').forEach(function(d){
      var cs = getComputedStyle(d);
      if ((cs.position === 'fixed') && d.offsetWidth > 300 && d.offsetHeight > 200 && d.innerHTML.indexOf('登录并加载') >= 0) kill.push(d);
    });
    kill.forEach(function(d){ d.style.display = 'none'; });
    var b = document.body;
    b.classList.add('win-max');
    return JSON.stringify({ killed: kill.length });
  })()`).then((s) => console.log('[hide-boot] ' + s));

  await new Promise((r3) => setTimeout(r3, 2500));
  const img = await w.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('[saved] ' + OUT);

  w.destroy();
  srv.close();
  app.quit();
})().catch((e) => { console.error('[fail]', e && e.message); app.quit(); });