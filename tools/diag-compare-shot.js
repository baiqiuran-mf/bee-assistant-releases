/* 截「通用 vs Tele① 资料卡」同屏对比图（加载真实 style.css，出真实像素） */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-facts-compare.png');

(async () => {
  await app.whenReady();
  const w = new BrowserWindow({
    width: 1230, height: 1180, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const file = 'file:///' + path.join(ROOT, 'public', '.pv-facts.html').replace(/\\/g, '/');
  await w.loadURL(file);
  await new Promise((r) => setTimeout(r, 2500));
  const img = await w.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('[saved] ' + OUT);
  const sz = await w.webContents.executeJavaScript(
    '(function(){return JSON.stringify({w:document.body.scrollWidth,h:document.body.scrollHeight});})()');
  console.log('[size] ' + sz);
  w.destroy();
  app.quit();
})().catch((e) => { console.error('[fail]', e); app.quit(); });
