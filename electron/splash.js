/**
 * 启动进度条（v2.6.1198）
 *
 * 软件双击后，startCore 里有一堆前期重活（数据库 / 采集模块 / HTTP 服务 / 图片重抓 /
 * 启动器预热 / Telegram 模块…），在此之前主窗口还没出来，用户只看到一片空白 → 觉得"卡"。
 *
 * 这里单独起一扇无边框、置顶、跳过任务栏的启动窗，把 bootLog.step() 的每一步实时画成
 * 进度条 + 阶段清单。主窗口加载完成后调用 done() 收尾并关闭本窗，露出主界面。
 *
 * 与业务零耦合：只接收字符串标签，不碰任何采集/数据库逻辑。
 */

const { BrowserWindow } = require('electron');
const path = require('path');

let splashWin = null;
let ready = false;

function createSplash() {
  if (splashWin && !splashWin.isDestroyed()) return splashWin;

  splashWin = new BrowserWindow({
    width: 460,
    height: 360,
    frame: false,
    resizable: false,
    movable: false,
    center: true,
    backgroundColor: '#ffffff',
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  splashWin.removeMenu();

  ready = false;
  const file = path.join(__dirname, '..', 'public', 'splash.html');
  splashWin.loadFile(file);

  splashWin.once('did-finish-load', () => { ready = true; });
  splashWin.on('closed', () => { splashWin = null; ready = false; });

  // 最保险：万一 loadFile 因为某种原因迟迟不触发 did-finish-load，也强行标记为就绪
  setTimeout(() => { ready = true; }, 1500);

  return splashWin;
}

// 把一行步骤推给启动窗（标签里可能含中文/引号，用 JSON 序列化保证安全）
function addStep(label) {
  if (!splashWin || splashWin.isDestroyed()) return;
  const js = `window.__addStep(${JSON.stringify(label || '')})`;
  if (!ready) {
    splashWin.webContents.once('did-finish-load', () => {
      splashWin.webContents.executeJavaScript(js).catch(() => {});
    });
    return;
  }
  splashWin.webContents.executeJavaScript(js).catch(() => {});
}

function done() {
  if (!splashWin || splashWin.isDestroyed()) return;
  const w = splashWin;
  const finish = () => {
    w.webContents.executeJavaScript('window.__done()').catch(() => {});
    setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 650);
  };
  if (!ready) {
    w.webContents.once('did-finish-load', finish);
  } else {
    finish();
  }
}

module.exports = { createSplash, addStep, done };
