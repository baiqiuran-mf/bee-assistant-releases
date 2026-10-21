/**
 * 标题栏改蓝 · 验证探针（不参与打包，只在 test/ 下跑）
 *
 * 为什么要它：主程序有 app.requestSingleInstanceLock()（electron/main.js:68），
 * 老板机器上已装的实例正在跑，新起的 dist 实例会被锁住直接退出，拿不到窗口。
 * 而且 --user-data-dir 被 Electron 拒（bad option）、app.getPath('userData') 走
 * Windows Shell API 不认 APPDATA 环境变量 —— 两条例行的绕法都不通。
 *
 * 于是这里用**同一份 Electron（44.4.5）+ 和 electron/main.js 完全一致的窗口配置**
 * 开一扇独立窗口，页面直接引真实的 public/style.css、用真实的 .win-drag 结构。
 * 这样截出来的「原生标题栏是不是蓝的」与真实软件一致，且完全不打扰正在跑的实例。
 *
 * 跑法：test\capture_probe.ps1（内部会调 electron 打开本目录）
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

// ⚠️ 必须与 electron/main.js 里的 TITLEBAR 三值保持一致，改那边就要改这里
const TITLEBAR = {
  height: 34,
  color: '#2563eb',
  symbolColor: '#ffffff',
};

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: '蜜蜂信息采集',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    // ↓↓↓ 与 electron/main.js createWindow() 里的三行一模一样 ↓↓↓
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLEBAR.color,
      symbolColor: TITLEBAR.symbolColor,
      height: TITLEBAR.height,
    },
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // PROBE_URL 用来验「全局设置」这类页面：它的 style.css / settings.js 是绝对路径
  // （href="/style.css"），file:// 下取不到，必须经一个 http 服务再进。
  if (process.env.PROBE_URL) win.loadURL(process.env.PROBE_URL);
  else win.loadFile(path.join(__dirname, 'index.html'));

  // 探针窗口标题跟着页面走，截图时便于分辨
  win.setTitle(process.env.PROBE_TITLE || '蜜蜂信息采集');
});
