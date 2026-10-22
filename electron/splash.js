/**
 * 启动进度条窗（v2.6.1198 首版 · v2.7.1221 修）
 *
 * 软件双击后，startCore 里有一堆前期重活（数据库 / 采集模块 / HTTP 服务 / 图片重抓 /
 * 启动器预热 / 云端握手…），在此之前主窗口还没出来，用户只看到一片空白 → 觉得"卡"。
 *
 * 这里单独起一扇无边框、置顶、跳过任务栏的启动窗，把 bootLog.step() 的每一步实时画成
 * 进度条 + 阶段清单。主窗口加载完成后调用 done() 收尾并关闭本窗，露出主界面。
 *
 * 与业务零耦合：只接收字符串标签，不碰任何采集/数据库逻辑。
 *
 * 🔴 v2.7.1221 两个坑（老板 2026-10-22 报「进度条 100% 了却进不去登录」）：
 *   ① 进度算法在 splash.html 里：旧版按步数线性加，第 8 步就顶到 100%，而实启动有十几步，
 *      后面还要等云端握手 + 主窗口加载 —— 已改成按真实耗时权重 + 完成前封顶 92%。
 *   ② 本文件旧版靠 webContents.once('did-finish-load') 补发早期步骤，但这个事件在本机
 *      Electron 上并不可靠（实测前 5 步全被丢掉，进度条实际起点比该有的低）。
 *      现在改成「先攒队列 + 轮询 typeof window.__addStep」再补发，保证一步不丢。
 */

const { BrowserWindow } = require('electron');
const path = require('path');

let splashWin = null;
let ready = false;
let pending = [];   // 页面还没就绪时，先把步骤攒着，就绪后按原顺序补发

/** 把一条标签转成页面里的调用语句（标签含中文/引号/括号，必须 JSON 序列化） */
function callFor(label) {
  return `window.__addStep(${JSON.stringify(String(label || ''))});`;
}

/** 往页面里跑一段脚本：启动窗纯展示，任何失败都只吞掉，绝不拖累启动 */
function run(js) {
  if (!splashWin || splashWin.isDestroyed()) return;
  splashWin.webContents.executeJavaScript(js).catch(() => {});
}

/** 把攒下的步骤一次性按顺序补发 */
function flush() {
  if (!pending.length) return;
  const buf = pending;
  pending = [];
  run(buf.map(callFor).join(''));
}

/**
 * 轮询页面里的 __addStep 是否已可用（不等 did-finish-load 那个不可靠事件）。
 * 最多探 50 次 × 100ms = 5 秒；真探不出来也照样放行，绝不让进度条卡住启动。
 */
function probe(win, tries) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript("typeof window.__addStep === 'function'")
    .then((ok) => {
      if (ok) { ready = true; flush(); return; }
      if (tries < 50) setTimeout(() => probe(win, tries + 1), 100);
      else { ready = true; flush(); }
    })
    .catch(() => {
      if (tries < 50) setTimeout(() => probe(win, tries + 1), 100);
      else ready = true;
    });
}

function createSplash() {
  if (splashWin && !splashWin.isDestroyed()) return splashWin;

  splashWin = new BrowserWindow({
    // v2.7.1221：老板 2026-10-22 定 800×550（原 460×360 太小，塞不下机器人 + 步骤清单）
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
  splashWin.removeMenu();

  ready = false;
  pending = [];
  const win = splashWin;
  const file = path.join(__dirname, '..', 'public', 'splash.html');
  win.loadFile(file);

  probe(win, 0);
  win.on('closed', () => { splashWin = null; ready = false; pending = []; });

  return win;
}

// 把一行步骤推给启动窗
function addStep(label) {
  if (!splashWin || splashWin.isDestroyed()) return;
  const text = String(label || '');
  if (!text) return;
  if (!ready) { pending.push(text); return; }
  run(callFor(text));
}

/**
 * 收尾：显示 100% + 「正在进入登录」，650ms 后关窗。
 * 没就绪时最多等 1.5 秒（把攒下的步骤一起补上再收尾），绝不把主窗口堵在这里。
 */
function done() {
  if (!splashWin || splashWin.isDestroyed()) return;
  const w = splashWin;
  const finish = () => {
    const tail = pending.map(callFor).join('') + 'window.__done();';
    pending = [];
    w.webContents.executeJavaScript(tail).catch(() => {});
    setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 650);
  };
  if (ready) { finish(); return; }
  let waited = 0;
  const iv = setInterval(() => {
    waited += 100;
    if (ready || waited >= 1500) { clearInterval(iv); finish(); }
  }, 100);
}

module.exports = { createSplash, addStep, done };
