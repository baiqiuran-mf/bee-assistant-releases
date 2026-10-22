/**
 * 更新进度窗（v2.7.1241 新增）
 *
 * 问题：2.7.1231 及之前，点「检查更新」→ 下载 → 安装时，主进程只把「正在安装」
 * 状态显示了 0.3 秒就 quitAndInstall 退出，NSIS 又以静默方式（/S）安装，整个安装
 * 阶段**没有任何可见窗口**，用户以为软件卡死。
 *
 * 这里单独起一扇无边框、置顶、跳过任务栏的窗口（样式与启动窗一致：蜜蜂机器人 +
 * 三色圆点 + 绿色渐变条），把更新过程实时画出来：
 *   - downloading：确定百分比进度条（来自 electron-updater 的 download-progress）
 *   - installing / downloaded：走马灯不确定进度条 + 「更新版本中，请稍等…」
 *
 * 与业务零耦合：只接收 src/update.js 通过 onState 推过来的状态对象，不碰任何
 * 采集 / 数据库逻辑。窗口由主进程创建（只有主进程能 new BrowserWindow）。
 *
 * 触发在 electron/main.js：updaterMod.onState(...) → UpdateCover.show / push / hide。
 */

const { BrowserWindow } = require('electron');
const path = require('path');

let coverWin = null;
let visible = false;
let lastState = null;

function createCover() {
  if (coverWin && !coverWin.isDestroyed()) return coverWin;

  coverWin = new BrowserWindow({
    width: 800,
    height: 550,
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
  coverWin.removeMenu();
  visible = true;

  const win = coverWin;
  // 页面加载完再补推一次最新状态，避免早到的状态丢在加载之前
  win.webContents.once('did-finish-load', () => { if (lastState) push(lastState); });
  win.on('closed', () => { coverWin = null; visible = false; lastState = null; });

  win.loadFile(path.join(__dirname, '..', 'public', 'update-cover.html'));
  return win;
}

/** 把一条状态推给更新窗（纯展示，失败只吞掉，绝不拖累更新） */
function push(s) {
  if (!coverWin || coverWin.isDestroyed()) return;
  lastState = s;
  const js = 'window.__upd(' + JSON.stringify(s || {}) + ');';
  coverWin.webContents.executeJavaScript(js).catch(() => {});
}

/** 显示窗口并把首条状态推过去 */
function show(s) {
  const w = createCover();
  if (w) push(s);
}

/** 关闭窗口（进入 latest / error / cancelled 等终态时调用） */
function hide() {
  visible = false;
  if (coverWin && !coverWin.isDestroyed()) {
    try { coverWin.close(); } catch (e) { /* 正在退出就无所谓 */ }
    coverWin = null;
  }
}

function isVisible() {
  return visible && coverWin && !coverWin.isDestroyed();
}

module.exports = { show, hide, push, isVisible };
