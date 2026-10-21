/* 截「WA① 三方案」真渲染图：加载真实 public/style.css，出真实像素。
 *🔴 capturePage 只截可视区域，三块太长 → 逐块把窗口滚到该块再截，各存一张。 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUTS = [
  { name: '.tmp-wa1-1.png', label: '方案一 内置浏览器' },
  { name: '.tmp-wa1-2.png', label: '方案二 读库会话列表' },
  { name: '.tmp-wa1-3.png', label: '方案三 账号启动器' },
];

(async () => {
  await app.whenReady();
  const w = new BrowserWindow({
    width: 1130, height: 760, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const file = 'file:///' + path.join(ROOT, 'public', '.pv-wa1.html').replace(/\\/g, '/');
  await w.loadURL(file);
  await new Promise((r) => setTimeout(r, 3000));

  const probe = await w.webContents.executeJavaScript(`(function(){
    var el = document.querySelector('.tv-day-num');
    var star = document.querySelector('.tv-star');
    return JSON.stringify({
      sheets: document.styleSheets.length,
      rules: (function(){try{return document.styleSheets[0].cssRules.length}catch(e){return -1}})(),
      dayColor: el ? getComputedStyle(el).color : '',
      starColor: star ? getComputedStyle(star).color : '',
      blocks: document.querySelectorAll('.pv-blk').length,
      totalH: document.body.scrollHeight
    });
  })()`);
  console.log('[probe] ' + probe);

  for (let i = 0; i < OUTS.length; i++) {
    const y = await w.webContents.executeJavaScript(
      `(function(){ var e=document.querySelectorAll('.pv-blk')[${i}]; e.scrollIntoView({block:'start'}); return window.scrollY; })()`);
    await new Promise((r) => setTimeout(r, 900));
    const img = await w.webContents.capturePage();
    const out = path.join(ROOT, OUTS[i].name);
    fs.writeFileSync(out, img.toPNG());
    console.log(`[saved ${i + 1}] ${OUTS[i].label}  scrollY=${y}  ${out}`);
  }

  w.destroy();
  app.quit();
})().catch((e) => { console.error('[fail]', e); app.quit(); });