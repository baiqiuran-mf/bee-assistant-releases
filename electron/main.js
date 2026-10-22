/**
 * 蜜蜂信息采集 · Windows 桌面应用入口（Electron）
 *
 * 这是【桌面应用软件】，不是网页：
 *   - 双击生成的 .exe（或 `electron .`）会开一个【原生桌面窗口】，不是浏览器、不用输网址。
 *   - 采集 / 翻译 / 建议 / 档案 全部跑在你本地电脑，数据存在本地 data/ 目录，不在云端。
 *
 * 启动：
 *   electron .             正常开桌面窗口用软件
 *   BEE_TEST=1 electron .  测试模式：不开窗口，跑一遍内置自检后退出（桌面软件测试用）
 */
const { app, BrowserWindow, dialog, ipcMain, globalShortcut, screen, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* 🔴 v2.6.1106 · 启动自检日志 —— 必须抢在下面 require('sharp') 之前启用。
 *
 *   背景：2026-10-14 老板把 2.6.1100 发到别的电脑安装，双击就闪退；本机却一切正常，
 *   排查时最大的障碍是「根本不知道它死在哪一步」，只能靠猜。
 *   有了这份日志，对方把文件发回来，就能一眼看到最后一行停在哪。
 *
 *   为什么必须比 sharp 早：sharp / better-sqlite3 这类**原生模块**加载失败时，
 *   进程可能直接消失（连错误框都来不及弹），日志再晚一步就什么都记不到。
 *   全程同步写也是同一个道理 —— 异步写在闪退时会随进程一起丢。
 *   细节见 src/bootLog.js 文件头。 */
const bootLog = require('../src/bootLog');
const Splash = require('./splash'); // v2.6.1198：启动进度条窗
let _pkgVer = '未知';
try { _pkgVer = require('../package.json').version || '未知'; } catch (e) { /* 版本读不到不影响启动 */ }
bootLog.init({ 应用版本: _pkgVer, 打包: (typeof app !== 'undefined' && app.isPackaged) ? '是（安装版）' : '否（开发模式）' });
bootLog.installCrashHooks();   // 未捕获异常 / 未处理 Promise 拒绝 → 先落盘再退出
bootLog.step('进程启动', 'pid=' + process.pid + '，参数=' + JSON.stringify(process.argv.slice(1)));
// 在终端明说日志落在哪：万一别的电脑闪退，让对方把这个文件发回来就能一眼定位
if (bootLog.logPath()) console.log('[启动日志] ' + bootLog.logPath());

const sharp = require('sharp');
bootLog.step('原生模块 sharp 加载完成');
const ai = require('../src/ai');
bootLog.step('AI 模块加载完成');

// 🔴 v2.7.1241：更新进度窗 —— 下载/安装时弹独立窗口，避免「卡死」错觉
const UpdateCover = require('./updateCover');
const updaterMod = require('../src/update');
updaterMod.onState((s) => {
  if (!s || !s.state) return;
  if (s.state === 'downloading' || s.state === 'installing') {
    UpdateCover.show(s);
  } else if (s.state === 'downloaded') {
    // 下载完成：若窗口已在（下载阶段弹出的），保持显示；否则也弹出来过渡到安装
    if (UpdateCover.isVisible()) UpdateCover.push(s);
    else UpdateCover.show(s);
  } else {
    // latest / error / cancelled / checking → 收起窗口
    UpdateCover.hide();
  }
});

// 兜底：某些环境（如无法初始化 GUI 子系统的沙箱）下 Electron 内置模块未注册，
// require('electron') 会退化为 npm 包路径字符串，此时 app 为 undefined。优雅退出并提示。
if (typeof app === 'undefined') {
  bootLog.fail('Electron 内置模块未加载', new Error('require("electron") 没拿到对象，当前环境无法初始化桌面窗口'));
  console.error('[蜜蜂信息采集] Electron 内置模块未加载（当前环境无法初始化桌面窗口）。请在你本机的 Windows 上运行 `npm start`。');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');

/* 🔴 关闭同步（共享翻译记忆）：主进程跑同步，渲染进程只负责显示浮层。
   这几个变量跨函数共享。 */
let mainWin = null;
let tmSyncDone = false;
let closeConfirmed = false;   // 🔴 2.6.1133：用户是否已点「确定关闭」。点 X 先弹确认框，确认后才进入「备份+退出」序列
let _tmCloud = null;

const runtime = require('../src/runtime');
const firstRun = require('../src/firstRun');
// 🔴 v2.6.1097：WA① 内置浏览器的「浏览器身份」（UA）统一设置 —— 见文件头注释。
//    内核不动（仍是内置 Chromium 152），只把浏览器身份字符串换成标准 Chrome，
//    解决刚才那次"渲染进程里事后 setAttribute 无效"的根因。
const webIdentity = require('../src/webIdentity');
const ids = require('../src/ids');

function loadConfig() {
  // 打包后读「用户可写目录」里那份；开发模式就是项目根的 config.yaml
  const file = require('../src/paths').configFile();
  if (!fs.existsSync(file)) throw new Error('找不到 config.yaml：' + file);
  let yaml;
  try { yaml = require('js-yaml'); } catch (e) { yaml = require('../src/yaml-lite'); }
  return yaml.load(fs.readFileSync(file, 'utf8')) || {};
}

/**
 * 第一次跑打包版时，把 config.yaml 和知识库铺到用户可写目录。
 * 为什么要这一步：安装到 Program Files 之后程序目录是只读的，
 * 「AI 设置」要回写 config.yaml、知识库你要改、登录态要存 —— 全都得放在外面。
 * 开发模式（electron .）一个字都不动。
 */
function bootstrapUserSpace() {
  const home = runtime.homeDir();
  if (!home) return null;
  let rep;
  try {
    rep = firstRun.prepareUserSpace(home, runtime.RESOURCE_ROOT);
  } catch (e) {
    console.error('[蜜蜂信息采集] 准备用户目录失败：', e && (e.stack || e.message));
    return null;
  }
  const cfgState = rep.config === 'created' ? '已生成一份新配置'
    : rep.config === 'exists' ? '用已有配置'
      : '没找到自带配置模板';
  console.log(`用户数据目录：${home}（${cfgState}；知识库 ${rep.knowledge.length ? '补了 ' + rep.knowledge.length + ' 个文件' : '齐全'}）`);
  return rep;
}

/** 只允许一个实例：再双击一次图标，把已经开着的窗口拎到前面，而不是起第二个内核抢同一个端口 */
const singleLock = typeof app.requestSingleInstanceLock === 'function' ? app.requestSingleInstanceLock() : true;
if (!singleLock) {
  // 已经有一个实例在跑，直接退出（那边会通过 second-instance 把窗口弹到前台）
  app.quit();
} else {
  if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
    try { app.setAppUserModelId('com.beeassistant.app'); } catch (e) { /* 不影响主流程 */ }
  }
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    const w = wins && wins[0];
    if (w) {
      if (w.isMinimized && w.isMinimized()) w.restore();
      if (w.show) w.show();
      if (w.focus) w.focus();
    }
  });
  app.whenReady().then(async () => {
    bootLog.step('Electron 就绪');
    try {
      let userData = '读不到';
      try { userData = app.getPath('userData'); } catch (e) { /* 少数环境取不到，不致命 */ }
      bootLog.logEnv({
        Electron: process.versions.electron,
        Chrome: process.versions.chrome,
        '用户数据目录': userData,
        '程序所在目录': __dirname,
      });
    } catch (e) { bootLog.warn('记录运行环境失败', e); }
    bootstrapUserSpace(); // 必须在 loadConfig / 起服务之前：配置文件的落点靠它决定
    bootLog.step('用户数据目录准备完成');
    // 🔴 v2.6.1097：在**开任何窗口之前**，先给 WA①~⑤ 各内置浏览器分区钉好浏览器身份。
    //    🔴 v2.6.1134：复刻成 5 个内置浏览器（persist:wa6 ~ persist:wa10），每个分区都要钉一次纯 Chrome UA。
    //    必须抢在 webview 建 guest 之前 —— WA 的 <webview> 是静态写在 index.html 里的，
    //    窗口一加载、元素一挂进 DOM，guest 的 UA 就定死了，那时再改就晚了（这就是 1096 没生效的原因）。
    for (const inst of ids.WA_EMBEDDED) {
      try {
        const r = webIdentity.applyChromeIdentity(inst.partition);
        console.log(r.ok
          ? `[${inst.label}] 浏览器身份已钉：${r.partition} → ${r.effective}${r.headers ? '（并已挂逐请求兜底）' : ''}`
          : `[${inst.label}] 浏览器身份未钉（${r.error || '未知原因'}）`);
      } catch (e) {
        console.error(`[${inst.label}] 钉浏览器身份失败：`, (e && e.message) || e);
      }
    }
    // 🔴 v2.6.1120：同样必须在**开窗口之前**，把「全局设置 → 代理」里的配置真正下发下去。
    //    ① applyAll()：给有 webview 分区的实例（WA① → persist:wa6）setProxy。
    //       内部会先拉起本机 gost 无密码中转（约百毫秒），拿到 127.0.0.1:port 再设给内核 ——
    //       之所以必须 await，是因为 webview 一挂进 DOM 就会去连，代理得先就位。
    //    ② 预热其余实例（Tele①②③ / S1~S3）的中转：外部 Chrome 与 Signal 那两条路要用
    //       （Signal 的启动函数是同步的，只能 peek，必须提前起好），不必等，后台跑即可。
    try {
      const wp = require('../src/webviewProxy');
      const results = await wp.applyAll();
      const applied = results.filter((r) => r.applied).map((r) => r.key);
      console.log(applied.length
        ? `[代理] webview 已应用代理：${applied.join(' / ')}`
        : '[代理] webview 无启用代理（直连）');
      wp.warmUpAll()
        .then((keys) => { if (keys.length) console.log(`[代理] 已预热本地中转：${keys.join(' / ')}`); })
        .catch((e) => console.warn('[代理] 预热本地中转失败：', (e && e.message) || e));
    } catch (e) {
      console.error('[代理] 启动时下发 webview 代理失败：', (e && e.message) || e);
    }
    if (process.env.BEE_TEST === '1') {
      try { await selfTest(); } catch (e) { console.error('[DESKTOP TEST] 异常:', e); process.exit(1); }
      return;
    }
    bootLog.step('准备启动桌面内核（startDesktop）');
    await startDesktop();
    bootLog.step('桌面内核启动完成，主窗口已交出来');
  }).catch((e) => {
    bootLog.fail('主流程异常', e);
    console.error('[蜜蜂信息采集] 主流程异常：', e);
    try {
      const lp = bootLog.logPath();
      dialog.showErrorBox('蜜蜂信息采集 · 启动失败',
        String((e && (e.stack || e.message)) || e) + (lp ? '\n\n启动日志：' + lp : ''));
    } catch (e2) {}
    process.exit(1);
  });
}

/** 后端内核：直接复用 src/main.js 的 startCore，
 *  保证桌面端、浏览器版、测试跑的是同一份代码。
 *  之前这里自己搭了一套只有 HTTP、WhatsApp 回调全是空函数的"假后端"，
 *  结果扫码登录后界面毫无反应——现在是同一套逻辑。 */
let backend = null;

/** 起服务：不指定端口时让系统挑一个空闲的（测试用，免得跟正在跑的软件抢 8787） */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port || 0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/* ============ 系统标题栏改蓝（v2.6.1101 · 老板 2026-10-13 拍板方案 1）============
 * 只作用在「主窗口」和「全局设置窗」这两扇 —— 它们是本软件里仅有的两扇
 * 用系统原生标题栏的窗口（其余 boardWin / phoneWin / suggestWin / translateWin /
 * settings 浮窗等都是 frame:false 自绘，老板明确说「其他不用」）。
 *
 * 做法：titleBarStyle:'hidden' 把系统那条白标题栏收起来、让网页顶到窗口最上方，
 *       再用 titleBarOverlay 把原生 ─ ▫ ✕ 三个按钮叠回网页上，并染成蓝底白字。
 *       好处：最大化动画 / 双击最大化 / 窗口吸附 / 拖拽缩放这些原生能力全保留，
 *       不用像 frame:false 那样自己实现一套（回归风险高）。
 *       标题文字不再由系统画，改由页面顶部的 .win-drag 自绘（见 style.css 同名块）。
 */
const TITLEBAR = {
  height: 34,          // 与 style.css 里 .win-drag 的 height 必须一致
  color: '#2563eb',    // 蓝底，沿用 app 现有主蓝 --accent
  symbolColor: '#ffffff', // ─ ▫ ✕ 三个按钮的符号色（蓝底上用白）
};

function createWindow(PORT) {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    title: '蜜蜂信息采集',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true, // 桌面应用观感：隐藏菜单条
    // 系统标题栏改蓝：收起原生白条，用蓝底白字叠层把 ─ ▫ ✕ 叠回网页上（见上方 TITLEBAR 注释）
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: TITLEBAR.color, symbolColor: TITLEBAR.symbolColor, height: TITLEBAR.height },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // v2.5.10020：主窗口里嵌了 WA①~⑤ / Tele①②③ 的 app 内 webview，必须开这个开关
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // 开窗口前先把 Electron 存下来的 HTTP 缓存清掉。
  // 它默认会把 app.js / style.css 存进 %APPDATA%\wa-assistant\Cache，
  // 于是「改了界面、重开窗口还是旧的」。这里主动清一次，保证第一眼就是最新的。
  try {
    win.webContents.session.clearCache();
  } catch (e) { /* 清不掉也没关系，服务端已禁用缓存 */ }

  // F5 / Ctrl+R / Ctrl+Shift+R = 忽略缓存强制刷新。
  // 万一你还是怀疑看到旧界面，直接按 F5 就能拉最新的一份，不用关窗口重开。
  if (win.webContents && typeof win.webContents.on === 'function') {
    win.webContents.on('before-input-event', (event, input) => {
      const isRefresh = input.key === 'F5'
        || ((input.key === 'r' || input.key === 'R') && (input.control || input.meta));
      if (!isRefresh || input.type !== 'keyDown') return;
      event.preventDefault();
      win.webContents.reloadIgnoringCache();
    });
  }

  // 🔴 v2.6.1106：把「界面那一层」（渲染进程）的崩溃和加载失败都记进启动日志。
  //    这类问题的表现常常就是「窗口一闪就没」或「开出来一片白」，以前完全没有线索可查。
  bootLog.step('准备加载主窗口页面', `http://127.0.0.1:${PORT}/`);
  if (typeof win.webContents.on === 'function') {
    win.webContents.on('render-process-gone', (_e, details) => {
      bootLog.fail('界面进程（渲染进程）崩了',
        new Error('原因=' + (details && details.reason) + '，退出码=' + (details && details.exitCode)));
    });
    win.webContents.on('crashed', () => {
      bootLog.fail('界面进程崩溃（crashed 事件）', new Error('webContents 报告渲染进程崩溃'));
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      bootLog.fail('页面加载失败', new Error(url + ' → ' + desc + '（错误码 ' + code + '）'));
    });
  }

  win.loadURL(`http://127.0.0.1:${PORT}/`);

  // 2026-10-09：窗口最大化状态 → 通知渲染进程，用于把右栏宽度从 450px 切到 500px。
  const pushWinState = () => {
    try { win.webContents.send('win:state', win.isMaximized() ? 'maximized' : 'normal'); } catch (e) { /* 窗未就绪忽略 */ }
  };
  win.on('maximize', () => pushWinState());
  win.on('unmaximize', () => pushWinState());
  win.webContents.on('did-finish-load', () => {
    pushWinState();
    // 走到这一行 = 界面已经真的出来了。以后再出问题，就不属于「启动闪退」那一类了。
    bootLog.step('主窗口页面加载完成，界面已交给用户');
    // 🔴 v2.6.1198：启动进度条收尾 + 加载完自动落到「编号 + 密码」登录界面
    Splash.done();
    try {
      const cloudMod = require('../src/cloud');
      if (cloudMod && typeof cloudMod.isLoggedIn === 'function' && !cloudMod.isLoggedIn()) {
        // splash 关闭后再弹云端登录（设置 → ☁ 云端），避免抢在进度条上面
        setTimeout(() => { try { openSettingsWindow('cloud'); } catch (e) { /* 登入窗开不了不影响主流程 */ } }, 750);
      }
    } catch (e) { /* 云端模块读不到不影响主流程 */ }
  });
  return win;
}

/* ============ 每日话术编排台 · 独立浮窗 ============
 * 它是一扇真正的系统窗口（无边框、可缩放、可最小化），能拖到屏幕任意位置，
 * 不受主窗口边界限制 —— 这就是「窗口可以移动、不局限在主窗口内」的实现方式。
 * 里面加载 public/board.html?code=客户编号，与主界面共用同一份 board.js / style.css。 */
let boardWin = null;
let backendBase = null; // 例：http://127.0.0.1:8787

function boardUrl(code) {
  return `${backendBase}/board.html` + (code ? `?code=${encodeURIComponent(code)}` : '');
}

function openBoardWindow(code) {
  if (!backendBase) return false;
  const url = boardUrl(code);
  if (boardWin && !boardWin.isDestroyed()) {
    boardWin.loadURL(url);
    if (boardWin.isMinimized()) boardWin.restore();
    boardWin.show();
    boardWin.focus();
    return true;
  }
  boardWin = new BrowserWindow({
    width: 884, height: 900, minWidth: 884, minHeight: 600,
    title: '每日话术编排台',
    frame: false,              // 无边框：标题栏由页面自绘（淡蓝那条），整条可拖动
    alwaysOnTop: true,         // 🔴 老板 2026-10-15：编排台浮窗始终置顶，切到 WhatsApp 也不被盖住
    resizable: true,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 浮窗不需要任何桌面能力，因此不挂 preload，保持最小权限
    },
  });
  try { boardWin.webContents.session.clearCache(); } catch (e) { /* ignore */ }
  boardWin.loadURL(url);
  boardWin.on('closed', () => { boardWin = null; });
  return true;
}

function syncBoardWindow(code) {
  // 浮窗开着才跟着换客户，没开就不打扰用户
  if (boardWin && !boardWin.isDestroyed()) {
    boardWin.loadURL(boardUrl(code));
    return true;
  }
  return false;
}

ipcMain.handle('board:open', (e, code) => openBoardWindow(code));
ipcMain.handle('board:sync', (e, code) => syncBoardWindow(code));
ipcMain.handle('board:close', () => {
  if (boardWin && !boardWin.isDestroyed()) boardWin.close();
  return true;
});

/* ============ 「📞 抓取电话」独立窗口（2026-10-07） ============
 * 顶栏「📞 抓取」按钮点开：把这个客户整段历史对话里**所有**像电话号码的字符
 * 全部列出来（带 + 的、带区号的、裸号、连疑似订单号/日期的都不放过），
 * 每条都写清「为什么像 / 为什么不像」，由老板自己判断。
 *
 * 🔴 只读窗口：加载 phone.html，页面只调 GET /api/phone/scan，不写任何数据。
 * 仿编排台的做法：真正的系统窗口、无边框、可拖到主窗口外任意位置。
 */
let phoneWin = null;

function phoneUrl(code) {
  return `${backendBase}/phone.html` + (code ? `?code=${encodeURIComponent(code)}` : '');
}

function openPhoneWindow(code, name) {
  if (!backendBase) return false;
  const url = phoneUrl(code);
  if (phoneWin && !phoneWin.isDestroyed()) {
    phoneWin.loadURL(url);
    if (phoneWin.isMinimized()) phoneWin.restore();
    phoneWin.show();
    phoneWin.focus();
  } else {
    phoneWin = new BrowserWindow({
      width: 720, height: 640, minWidth: 420, minHeight: 320,
      title: '抓取电话',
      frame: false,              // 无边框：标题栏由页面自绘（淡蓝那条），整条可拖动
      resizable: true,
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // 只读页面，不挂 preload —— 但页面想用 beePhone 通道收客户名，
        // 所以这里挂一个最小 preload（只暴露 open/close/onData，不给任何文件能力）。
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    try { phoneWin.webContents.session.clearCache(); } catch (e) { /* ignore */ }
    phoneWin.on('closed', () => { phoneWin = null; });
    phoneWin.loadURL(url);
  }
  // 客户名跟着送过去（窗口标题栏那行显示用），晚一点发也没关系
  if (name) setTimeout(() => sendPhoneData({ code, name }), 350);
  return true;
}

function sendPhoneData(d) {
  if (phoneWin && !phoneWin.isDestroyed()) {
    try { phoneWin.webContents.send('phone:data', d); } catch (e) { /* ignore */ }
  }
}

ipcMain.handle('phone:open', (e, code, name) => openPhoneWindow(code, name));
ipcMain.handle('phone:close', () => {
  if (phoneWin && !phoneWin.isDestroyed()) phoneWin.close();
  return true;
});

/* ============ 「全局设置」独立窗口（2026-09-30） ============
 * 用户要求：顶栏只留一个「⚙ 设置」图标，点它弹出这扇窗（标题「全局设置」），
 * 把原来挤在顶栏的 AI 设置 / AI 提示词 / 模拟新消息 三块整块搬进来，功能不变。
 * 和编排台一样是一扇真正的系统窗口，可以挪到主窗口外面、两个并排看。
 * v2.6.1101 之前：用系统自带的标题栏（和主窗口一致），所以 frame 不关；页面里只有一条页签。
 * v2.6.1101 起：系统那条白标题栏收起，改由页面顶部的 .win-drag 自绘蓝条（和主窗口同款），
 *   原生 ─ ▫ ✕ 三个按钮靠 titleBarOverlay 叠回网页上，窗口照样能拖能最大化。
 */
let settingsWin = null;

/**
 * @param {string} [tab] 想直接落到哪个页签（v1.0.1：云端提示条点「登录」要跳到 cloud 页）
 */
function openSettingsWindow(tab) {
  if (!backendBase) return false;
  const url = `${backendBase}/settings.html${tab ? '#' + encodeURIComponent(tab) : ''}`;
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    // 已经开着就让它自己跳页签（两扇窗都是同一个后端，靠 hash 传话最简单）
    try {
      if (tab) settingsWin.webContents.executeJavaScript(
        `try{location.hash=${JSON.stringify('#' + tab)};if(typeof switchTab==='function')switchTab(${JSON.stringify(tab)});}catch(e){}`);
    } catch (e) { /* ignore */ }
    return true;
  }
  settingsWin = new BrowserWindow({
    width: 1000, height: 800, minWidth: 720, minHeight: 520,
    title: '全局设置',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    // 和主窗口同款：系统标题栏改蓝（原生 ─ ▫ ✕ 保留，只是底色和符号色变了）
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: TITLEBAR.color, symbolColor: TITLEBAR.symbolColor, height: TITLEBAR.height },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 这扇窗不需要任何桌面能力（关闭直接用 window.close()），不挂 preload，保持最小权限
    },
  });
  try { settingsWin.webContents.session.clearCache(); } catch (e) { /* ignore */ }
  settingsWin.loadURL(url);
  settingsWin.on('closed', () => { settingsWin = null; });
  return true;
}

ipcMain.handle('settings:open', (_e, tab) => openSettingsWindow(tab));

/* ============ 建议 / 翻译 · 独立浮窗（可拖到主窗口外） ============ */

let suggestWin = null;
let translateWin = null;

function openFloatingWindow(kind, url) {
  const existing = kind === 'suggest' ? suggestWin : translateWin;
  if (existing && !existing.isDestroyed()) {
    existing.loadURL(url);
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  // 老板 2026-10-18：建议回复浮窗默认 800×800，但可自由拖边框缩放 + 可最大化（标题栏 □ 或双击标题）；
  // 翻译浮窗保持原 460×620 可缩放。
  const isSuggest = kind === 'suggest';
  const win = new BrowserWindow({
    width: isSuggest ? 800 : 460,
    height: isSuggest ? 800 : 620,
    minWidth: isSuggest ? 560 : 360,
    minHeight: isSuggest ? 420 : 360,
    title: kind === 'suggest' ? '建议' : '翻译',
    frame: false,
    resizable: true,
    maximizable: isSuggest,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 关键：浮窗也要 preload，才能拿到 beeSuggest / beeTranslate / beeBoard 桥，
      // 这样建议浮窗里的「翻译」才能反过来打开翻译浮窗，且窗口可拖出主窗口。
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  try { win.webContents.session.clearCache(); } catch (e) { /* ignore */ }
  win.loadURL(url);
  win.on('closed', () => { if (kind === 'suggest') suggestWin = null; else translateWin = null; });
  if (kind === 'suggest') suggestWin = win; else translateWin = win;
  return win;
}

ipcMain.handle('suggest:open', (e, sug) => {
  if (!backendBase) return false;
  const win = openFloatingWindow('suggest', `${backendBase}/suggest.html`);
  if (win) win.webContents.once('did-finish-load', () => {
    try { win.webContents.send('suggest:data', sug); } catch (e) { /* 还没准备好就忽略 */ }
  });
  return true;
});
ipcMain.handle('suggest:close', () => {
  if (suggestWin && !suggestWin.isDestroyed()) suggestWin.close();
  return true;
});
// 老板 2026-10-18 方案A：点「翻译」把建议窗口在现有宽度上再加 700（右侧滑出翻译栏），关翻译栏缩回原宽。
// 最大化状态下由系统管大小，这里不动；宽高限定在屏幕可视范围内。
ipcMain.handle('suggest:resize', (_e, w, h) => {
  if (suggestWin && !suggestWin.isDestroyed()) {
    if (suggestWin.isMaximized()) return true;
    try {
      const area = screen.getPrimaryDisplay().workAreaSize;
      const nw = Math.min(Math.max(Number(w) || 800, 560), area.width - 20);
      const nh = Math.min(Math.max(Number(h) || 800, 420), area.height - 20);
      suggestWin.setBounds({ width: nw, height: nh });
    } catch (e) { /* ignore */ }
  }
  return true;
});

// 老板 2026-10-18：窗口已弹、AI 还没回来时，把「真实建议数据」推过去替换骨架（不重载页面）
ipcMain.handle('suggest:push', (_e, sug) => {
  if (suggestWin && !suggestWin.isDestroyed()) {
    try { suggestWin.webContents.send('suggest:data', sug); } catch (e) { /* ignore */ }
    if (suggestWin.isMinimized()) suggestWin.restore();
    suggestWin.show();
    return true;
  }
  return false;
});

// 老板 2026-10-18：标题栏 □ 按钮 / 双击标题 → 最大化或还原
ipcMain.handle('suggest:toggle-max', () => {
  if (!suggestWin || suggestWin.isDestroyed()) return 'unknown';
  try {
    if (suggestWin.isMaximized()) { suggestWin.unmaximize(); return 'normal'; }
    suggestWin.maximize();
    return 'max';
  } catch (e) { return 'unknown'; }
});

ipcMain.handle('translate:open', (e, payload) => {
  if (!backendBase) return false;
  const win = openFloatingWindow('translate', `${backendBase}/translate.html`);
  if (win) win.webContents.once('did-finish-load', () => {
    try { win.webContents.send('translate:data', payload); } catch (e) { /* ignore */ }
  });
  return true;
});
ipcMain.handle('translate:close', () => {
  if (translateWin && !translateWin.isDestroyed()) translateWin.close();
  return true;
});

/* ============ 截图 + 截图翻译（v2.5.1065） ============
 * 快捷键（默认 Ctrl+Alt+Z，可在「全局设置 → 截图设置」改）触发：
 *   1) 开一扇全屏半透明遮罩（shotselect.html），渲染进程用 desktopCapturer 抓整屏；
 *   2) 用户在遮罩上拖拽选区（位置 + 尺寸），Enter 确认 / Esc 取消；
 *   3) 主进程按选区用 sharp 裁剪，开一扇 900×30 工具条（shotpopup.html：翻译 / 保存图片）；
 *   4) 「翻译」→ 视觉 AI 把图里外文翻成中文，弹独立的翻译窗口（shotresult.html）；
 *      「保存图片」→ 按设置里的路径落盘。
 * 全程可配置：是否启用、快捷键、保存路径、是否启用 AI 翻译、翻译用哪家 AI、目标语言。 */

let shotOverlayWin = null;
let shotPopupWin = null;
let shotResultWin = null;
let shotHotkey = 'Ctrl+Alt+Z';

function dataUrlToBuffer(d) {
  const m = /^data:image\/\w+;base64,(.*)$/.exec(String(d || ''));
  return m ? Buffer.from(m[1], 'base64') : null;
}

async function fetchScreenshotCfg() {
  if (!backendBase) return {};
  try {
    const r = await fetch(backendBase + '/api/screenshot/config');
    const j = await r.json();
    return (j && j.config) || {};
  } catch (e) { return {}; }
}

function startScreenshotFlow() {
  if (shotOverlayWin && !shotOverlayWin.isDestroyed()) return; // 已在截图中
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = disp.bounds;
  shotOverlayWin = new BrowserWindow({
    x, y, width, height,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  try { shotOverlayWin.webContents.session.clearCache(); } catch (e) { /* ignore */ }
  shotOverlayWin.loadURL(`${backendBase}/shotselect.html`);
  shotOverlayWin.on('closed', () => { shotOverlayWin = null; });
}

function openShotPopup(croppedDataUrl) {
  if (shotPopupWin && !shotPopupWin.isDestroyed()) { shotPopupWin.close(); shotPopupWin = null; }
  shotPopupWin = new BrowserWindow({
    width: 900, height: 30,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    backgroundColor: '#1f2230',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  try { shotPopupWin.webContents.session.clearCache(); } catch (e) { /* ignore */ }
  shotPopupWin.once('did-finish-load', () => {
    try { shotPopupWin.webContents.send('shot:popup-data', { imageDataUrl: croppedDataUrl }); } catch (e) { /* ignore */ }
  });
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const px = Math.round(disp.bounds.x + (disp.bounds.width - 900) / 2);
  const py = Math.round(disp.bounds.y + disp.bounds.height * 0.33);
  try { shotPopupWin.setPosition(px, py); } catch (e) { /* ignore */ }
  shotPopupWin.loadURL(`${backendBase}/shotpopup.html`);
  shotPopupWin.on('closed', () => { shotPopupWin = null; });
}

function openShotResult(imageDataUrl, text) {
  if (shotResultWin && !shotResultWin.isDestroyed()) { shotResultWin.close(); shotResultWin = null; }
  shotResultWin = new BrowserWindow({
    width: 460, height: 560, minWidth: 320, minHeight: 320,
    title: '截图翻译',
    frame: false,
    resizable: true,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  try { shotResultWin.webContents.session.clearCache(); } catch (e) { /* ignore */ }
  shotResultWin.once('did-finish-load', () => {
    try { shotResultWin.webContents.send('shot:result-data', { imageDataUrl, text }); } catch (e) { /* ignore */ }
  });
  shotResultWin.loadURL(`${backendBase}/shotresult.html`);
  shotResultWin.on('closed', () => { shotResultWin = null; });
}

// 截图遮罩已在【隐藏时】抓完图，现在可以显示了（避免把自己拍进截图）
ipcMain.handle('shot:ready', () => {
  if (shotOverlayWin && !shotOverlayWin.isDestroyed()) shotOverlayWin.show();
  return true;
});

// 主进程兜底抓屏：preload 的 desktopCapturer 取不到时，主进程用 electron 的 desktopCapturer 抓一次再回传
ipcMain.handle('shot:capture-main', async () => {
  try {
    const { desktopCapturer } = require('electron');
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = disp.scaleFactor || 1;
    const tW = Math.round(disp.size.width * scale);
    const tH = Math.round(disp.size.height * scale);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: tW, height: tH } });
    const src = sources.find((s) => String(s.display_id) === String(disp.id))
      || sources.find((s) => String(s.id).startsWith('screen'))
      || sources[0];
    if (!src) return { ok: false, error: '主进程也取不到屏幕源' };
    return { ok: true, dataUrl: src.thumbnail.toDataURL(), width: tW, height: tH, dpr: scale, screenX: disp.bounds.x, screenY: disp.bounds.y };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 屏幕几何信息（preload 拿不到 screen 模块，由主进程提供：光标所在屏坐标 / 尺寸 / dpr）
ipcMain.handle('shot:display-geometry', () => {
  try {
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return {
      displayId: disp.id,
      screenX: disp.bounds.x,
      screenY: disp.bounds.y,
      width: disp.size.width,
      height: disp.size.height,
      dpr: disp.scaleFactor || 1,
    };
  } catch (e) {
    return { displayId: 0, screenX: 0, screenY: 0, width: 1920, height: 1080, dpr: 1 };
  }
});

ipcMain.handle('shot:cancel', () => {
  if (shotOverlayWin && !shotOverlayWin.isDestroyed()) shotOverlayWin.close();
  shotOverlayWin = null;
  return true;
});

ipcMain.handle('shot:confirm', async (e, payload) => {
  try {
    if (!payload || !payload.dataUrl) return { ok: false, error: '没有截图数据' };
    const buf = dataUrlToBuffer(payload.dataUrl);
    if (!buf) return { ok: false, error: '截图数据损坏' };
    const s = payload.selImg || null;
    let outBuf;
    if (s && s.w > 0 && s.h > 0) {
      outBuf = await sharp(buf)
        .extract({ left: Math.max(0, Math.round(s.x)), top: Math.max(0, Math.round(s.y)), width: Math.max(1, Math.round(s.w)), height: Math.max(1, Math.round(s.h)) })
        .png()
        .toBuffer();
    } else {
      outBuf = await sharp(buf).png().toBuffer();
    }
    const croppedDataUrl = 'data:image/png;base64,' + outBuf.toString('base64');
    if (shotOverlayWin && !shotOverlayWin.isDestroyed()) shotOverlayWin.close();
    shotOverlayWin = null;
    openShotPopup(croppedDataUrl);
    return { ok: true };
  } catch (err) {
    if (shotOverlayWin && !shotOverlayWin.isDestroyed()) shotOverlayWin.close();
    shotOverlayWin = null;
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('shot:translate', async (e, payload) => {
  try {
    const dataUrl = payload && payload.imageDataUrl;
    if (!dataUrl) return { ok: false, error: '没有可翻译的截图' };
    const cfg = await fetchScreenshotCfg();
    if (cfg.enableAiTranslate === false) return { ok: false, error: '已在「全局设置 → 截图设置」里关掉 AI 翻译' };
    const buf = dataUrlToBuffer(dataUrl);
    if (!buf) return { ok: false, error: '截图数据损坏' };
    const tmp = path.join(os.tmpdir(), `bee-shot-${Date.now()}.png`);
    fs.writeFileSync(tmp, buf);
    const providerName = (cfg.providerName && cfg.providerName !== 'vision') ? cfg.providerName : null;
    const hint = `这是一张截图，里面很可能有外文（英文等）。请把它逐行翻成${cfg.targetLang || '中文'}，保留原来的排版和换行，只输出译文，不要加解释。`;
    const text = await ai.describeImage(tmp, hint, providerName);
    const translated = text && text.trim()
      ? text.trim()
      : '（翻译失败：视觉 AI 未配置或返回为空。请到「全局设置 → 截图设置」确认翻译用 AI 已填好接入地址和 key，并点「测试连接」）';
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    openShotResult(dataUrl, translated);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('shot:save', async (e, payload) => {
  try {
    const dataUrl = payload && payload.imageDataUrl;
    if (!dataUrl) return { ok: false, error: '没有可保存的截图' };
    const cfg = await fetchScreenshotCfg();
    const saveDir = (cfg.savePath && String(cfg.savePath).trim())
      ? String(cfg.savePath).trim()
      : path.join(path.dirname(require('../src/paths').configFile()), 'screenshots');
    fs.mkdirSync(saveDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(saveDir, `screenshot-${ts}.png`);
    fs.writeFileSync(filePath, dataUrlToBuffer(dataUrl));
    try { new Notification({ title: '截图已保存', body: filePath }).show(); } catch (e) { /* 某些环境通知不可用 */ }
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('shot:close-popup', () => {
  if (shotPopupWin && !shotPopupWin.isDestroyed()) shotPopupWin.close();
  shotPopupWin = null;
  return true;
});

ipcMain.handle('shot:close-result', () => {
  if (shotResultWin && !shotResultWin.isDestroyed()) shotResultWin.close();
  shotResultWin = null;
  return true;
});

function logShot(msg) {
  try {
    const paths = require('../src/paths');
    const dir = (paths && paths.DATA_ROOT) || require('os').tmpdir();
    require('fs').mkdirSync(dir, { recursive: true });
    require('fs').appendFileSync(require('path').join(dir, 'screenshot-hotkey.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) { /* 日志记录失败不能影响主流程 */ }
}

function applyShotHotkey(hk, enabled) {
  const want = hk || 'Ctrl+Alt+Z';
  try { if (shotHotkey && shotHotkey !== want) globalShortcut.unregister(shotHotkey); } catch (e) { /* ignore */ }
  try { globalShortcut.unregister(want); } catch (e) { /* ignore */ }
  shotHotkey = want;
  if (enabled !== false) {
    const ok = globalShortcut.register(want, startScreenshotFlow);
    logShot(`快捷键注册 ${want} -> ${ok ? '成功' : '失败'}`);
    if (!ok) console.warn('[截图] 快捷键注册失败：', want);
  } else {
    logShot(`快捷键 ${want} 按配置禁用，未注册`);
  }
}

function registerScreenshotHotkey() {
  if (backendBase) {
    fetch(backendBase + '/api/screenshot/config')
      .then((r) => r.json())
      .then((j) => { const c = (j && j.config) || {}; applyShotHotkey(c.hotkey, c.enabled); })
      .catch(() => applyShotHotkey('Ctrl+Alt+Z', true));
  } else {
    applyShotHotkey('Ctrl+Alt+Z', true);
  }
}

// 设置页改了快捷键 → 重注册（不用重启）
ipcMain.handle('shot:set-hotkey', (e, { enabled, hotkey }) => {
  applyShotHotkey(hotkey, enabled);
  return { ok: true, hotkey: shotHotkey };
});

app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ } });

/** 正常模式：开桌面窗口 */
async function startDesktop() {
  try {
    // 🔴 v2.6.1198：启动进度条窗 —— 先把 splash 起出来，再订阅 bootLog 的每一步，
    // 这样 startCore 里的重活（数据库 / 采集模块 / HTTP 服务 …）都能实时画成进度条，
    // 不再是一片空白让人觉得"卡"。
    Splash.createSplash();
    bootLog.onStep((label) => Splash.addStep(label));

    // startCore 内部已经把 HTTP 服务 listen 好了，返回的 srv 是【正在监听】的 server。
    // 这里绝对不能再 listen 一次 —— 再 listen 会立刻抛
    // ERR_SERVER_ALREADY_LISTEN，把 startDesktop 打断，窗口就永远打不开
    // （终端只留下一个 UnhandledPromiseRejectionWarning，看起来就是"软件卡住不动"）。
    //
    // startWhatsApp:false —— 启动时**不自动打开浏览器、不自动连 WhatsApp**。
    // 需求：双击图标先干净地看到工作区；要收哪个账号的消息，就点它右边的「浏览器」，
    // 按需启动（Chrome 窗口会被搬到屏幕里并置顶，在那里扫码登录）。
    bootLog.step('准备启动后端内核（src/main.startCore —— 数据库 / 采集模块都在这里加载）');
    backend = await require('../src/main').startCore({ startWhatsApp: false });
    bootLog.step('后端内核已就绪', '监听端口 ' + backend.PORT);
    backendBase = `http://127.0.0.1:${backend.PORT}`;
    // 注册截图全局快捷键（Ctrl+Alt+Z，可在「全局设置 → 截图设置」改）
    registerScreenshotHotkey();
    // 把界面构建戳打到终端：窗口顶栏那行小字应该和这里一致。
    // 不一致 = 窗口加载的还是旧文件（按 F5 强制刷新）。
    let stamp = '';
    try { stamp = require('../src/server').buildStamp(); } catch (e) { /* 拿不到就算了 */ }
    console.log(`蜜蜂信息采集 · 桌面窗口已打开（后端 http://127.0.0.1:${backend.PORT}）`);
    if (stamp) console.log(`界面版本 ${stamp}（界面文件：${path.join(ROOT, 'public')}）—— 窗口顶栏那行小字应与它一致`);
    // 启动「兜底重扫」循环：实时监听是主路径，这个按 extractInterval 定时再核对一次最近对话，
    // 防止 WhatsApp 网页版实时推送偶尔漏掉的消息（handleMessage 自带去重，重扫安全）。
    if (typeof backend.startExtractLoop === 'function') backend.startExtractLoop();
    mainWin = createWindow(backend.PORT);
    bootLog.step('主窗口已创建', '页面地址 ' + backendBase);
    // 🔴 2.6.1133 启动即尝试补传上次「离线未备份」的翻译记忆（若已登录且在线就推上去并清空记录）
    recoverPendingBackups().catch(() => {});
    try {
      const cloudMod = require('../src/cloud');
      if (cloudMod && typeof cloudMod.onEvent === 'function') {
        cloudMod.onEvent((type) => { if (type === 'login') recoverPendingBackups().catch(() => {}); });
      }
    } catch (e) { /* 监听失败不影响主流程 */ }
    // v2.6.1100：启动后把「代理」页里配的 WA① / Tele① 代理真正应用到各自 webview 的分区 session，
    // 否则浏览器永远走直连、出口 IP 不变（之前 /api/proxy/relay 是死代码，从没被调用）。
    try {
      require('../src/webviewProxy').applyAll().then((rs) => {
        console.log('[webviewProxy] 启动应用结果：', JSON.stringify(rs));
      }).catch((e) => console.warn('[webviewProxy] 启动应用失败：', e && (e.message || e)));
    } catch (e) { console.warn('[webviewProxy] 加载失败：', e && (e.message || e)); }
    // 主窗口关了就顺手关掉话术编排台浮窗 / 全局设置窗口，避免留下孤零零的窗口
    mainWin.on('closed', () => {
      if (boardWin && !boardWin.isDestroyed()) boardWin.close();
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    });
    // 用户点 X 关主窗口：先拦住，弹「确定关闭？」确认框。
    // 只有用户点「确定关闭」后（closeConfirmed=true），才进入「备份+进度条→退出」序列；
    // 点「取消」则留在软件，窗口不动。
    mainWin.on('close', (e) => {
      if (closeConfirmed) return;            // 已确认 → 放行，交给 runCloseSequence 的 app.exit() 收尾
      e.preventDefault();                    // 拦住默认关闭
      if (mainWin && !mainWin.isDestroyed()) {
        try { mainWin.webContents.send('close:confirm-show'); } catch (e2) {}
      }
    });

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(backend.PORT); });
  } catch (e) {
    bootLog.fail('startDesktop 启动失败', e);
    console.error('[蜜蜂信息采集] 启动失败：', e);
    try {
      const lp = bootLog.logPath();
      dialog.showErrorBox('蜜蜂信息采集 · 启动失败',
        `桌面窗口没能打开。\n\n${(e && (e.stack || e.message)) || e}` + (lp ? `\n\n启动日志：${lp}` : ''));
    } catch (e2) { /* 连弹窗都起不来时忽略 */ }
    process.exit(1);
  }
}

/** 测试模式：不开窗口，注入假 AI，跑核心接口自检后退出 */
async function selfTest() {
  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');

  const cfg = loadConfig();

  const b = {
    ai,
    srv: createServer({ db, doc, ai, knowledge, cfg, getAccountStates: () => [] }, 0),
    PORT: 0,
  };
  // 假 AI：让建议/翻译在没填 key 时也能跑通整条逻辑（验证的是“桌面应用功能”，不是真模型）
  ai.translate = async (t) => `（译）${t}`;
  ai.translateReply = async (text, ctx, opt) => {
    const n = Math.max(2, Math.min(3, Number(opt?.count) || 2));
    const pool = [
      { text: `[EN] ${text}`, note: '美式口语版' },
      { text: `[EN2] ${text}`, note: '朋友闲聊版' },
      { text: `[EN3] ${text}`, note: '更自然版' },
    ];
    return { versions: pool.slice(0, n), tip: '示例建议：现在还是朋友阶段，别急着提画。' };
  };
  ai.extractProfile = async () => ({ 宠物主角: { 名字: 'Buddy', 品种: '农场猫' }, 阶段: 'Day 2' });
  ai.suggest = async () => ({
    options: [
      { angle: '宠物', text: '示例建议一：聊聊他的农场猫' },
      { angle: '生活', text: '示例建议二：说说你也会做饭' },
      { angle: '艺术', text: '示例建议三：提一下你帮师姐画画' },
    ],
    rationale: '示例', day: { day: 2 },
  });
  ai.describeImage = async () => null;
  ai.transcribe = async () => null;
  ai.isReady = () => true;
  ai.notConfiguredReason = () => null;

  b.PORT = await listen(b.srv.server);
  const base = `http://127.0.0.1:${b.PORT}`;
  const api = async (p, opts = {}) => {
    const res = await fetch(base + p, opts);
    const txt = await res.text();
    let body; try { body = JSON.parse(txt); } catch { body = txt; }
    return { status: res.status, body };
  };

  let pass = 0, fail = 0; const fails = [];
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; fails.push(name + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 120) : '')); console.log('  ✗ ' + name); }
  };

  console.log('\n[桌面自检] 启动桌面后端并逐接口验证…');
  let r = await api('/api/state');
  check('GET /api/state', r.status === 200 && Array.isArray(r.body.accounts), r.body);

  const ident = '+15418019999';
  r = await api('/api/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ident, region: '俄勒冈', accountId: 1, body: '苹果熟了，农场猫很可爱' }) });
  check('POST /api/manual 手动录入', r.status === 200 && r.body.ok, r.body);
  const code = r.body.customer?.code || r.body.code;
  check('录入后拿到客户编号', !!code, r.body);

  r = await api(`/api/customer/${code}`, {}); check('GET /api/customer/:code', r.status === 200 && r.body.customer, r.body);
  r = await api(`/api/customer/${code}/suggest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('POST /api/customer/:code/suggest 出3条', r.status === 200 && Array.isArray(r.body.options) && r.body.options.length === 3, r.body);
  const sid = r.body.suggestionId;

  r = await api('/api/suggestion/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suggestionId: sid, index: 0, day: 2, scene: '农场猫', text: r.body.options[0].text }) });
  check('POST /api/suggestion/adopt 采纳', r.status === 200 && r.body.ok, r.body);

  r = await api(`/api/customer/${code}/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ region: '俄勒冈', phone: '+15419000088' }) });
  check('POST /api/customer/:code/profile 保存档案', r.status === 200 && r.body.ok, r.body);

  r = await api(`/api/customer/${code}/extract`, { method: 'POST' });
  check('POST /api/customer/:code/extract 抽取档案', r.status === 200 && r.body.ok, r.body);

  r = await api('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '农场猫很可爱', code, provider: 'deepseek', count: 3 }) });
  check('POST /api/translate 翻译(2-3版)', r.status === 200 && r.body.ok && Array.isArray(r.body.versions) && r.body.versions.length >= 2, r.body);

  r = await api('/api/learned', {}); check('GET /api/learned 话术库', r.status === 200 && r.body.ok, r.body);

  r = await api('/api/suggestion/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suggestionId: sid, index: -1, day: 2, scene: '农场猫', reason: '换思路' }) });
  check('POST /api/suggestion/reject 换思路重出', r.status === 200 && Array.isArray(r.body.options) && r.body.options.length === 3, r.body);

  console.log(`\n[DESKTOP TEST] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
  if (fail) console.log('[DESKTOP TEST] 失败项:\n - ' + fails.join('\n - '));
  try { b.srv.server.close(); } catch (e) {}  // b.srv 现在是 http.Server 本身
  process.exit(fail === 0 ? 0 : 1);
}

// 兜底：任何没被 catch 住的异常都要打在终端里，不让窗口"默默打不开"
process.on('unhandledRejection', (e) => {
  console.error('[蜜蜂信息采集] 未处理的异步异常：', (e && (e.stack || e.message)) || e);
});
process.on('uncaughtException', (e) => {
  console.error('[蜜蜂信息采集] 未捕获异常：', (e && (e.stack || e)) || e);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// C 方案：每个账号的 Chrome 是我们自己 spawn 的子进程，Electron 退出时不会自动回收，
// 必须显式杀掉，否则会留下一堆孤儿 Chrome 进程（关软件后任务管理器里一堆 chrome.exe）。
// 🔴 v2.6.1127 关闭时同步共享翻译记忆：拦截 before-quit → 先把本地字典与后台对账 → 才真退出。
//   同步在主进程跑（db/cloud 都在主进程），渲染进程只负责显示浮层。
function shutdownSessions() {
  try {
    const sessionMod = require('../src/session');
    if (sessionMod && typeof sessionMod.shutdownAll === 'function') sessionMod.shutdownAll();
  } catch (e) { /* 退出阶段尽量干净，忽略 */ }
}

function getTmCloud() {
  if (!_tmCloud) _tmCloud = require('../src/tmCloud');
  return _tmCloud;
}

/* 🔴 2.6.1155 关闭序列：点「确定关闭」后由 IPC 触发，不再走 app.quit→before-quit。
   流程：亮进度条 → 主进程跑 wordDoc.rebuildAll（补充 / 新建每个客户的 .docx 档案）→
         逐客户推送进度 → 100% 后真正退出。
   说明：关闭不再做云端同步（翻译记忆已改单向「后台→本地」，本地录入已取消，关闭同步已 disable，
        见 src/tmCloud.js / src/translationMemory.js）。关闭只负责把本地客户档案 .docx 生成完整，
        「处理完才关闭」（老板 2026-10-18 拍板）。 */
async function runCloseSequence() {
  const win = mainWin;

  // 进度条浮层先亮起来（老板：点确定就启动进度条）
  if (win && !win.isDestroyed()) { try { win.webContents.send('tm:sync-start'); } catch (e) {} }

  // 取 wordDoc：优先用 startCore 返回的同一实例（backend.wordDoc），避免二次开 DB / 锁库
  let wd = (backend && backend.wordDoc) || null;
  if (!wd) { try { wd = require('../src/wordDoc'); } catch (e) { wd = null; } }
  if (!wd || typeof wd.rebuildAll !== 'function') {
    finishClose(win, '客户档案生成模块不可用，直接关闭', false);
    return;
  }

  // 统计客户总数用于进度（db 为单例，require 拿到的是已打开的同一实例）
  let total = 0;
  try {
    const db = require('../src/db');
    const all = (db.listCustomers && db.listCustomers.all) ? db.listCustomers.all() : [];
    total = Array.isArray(all) ? all.length : 0;
  } catch (e) { total = 0; }

  const send = (info) => { if (win && !win.isDestroyed()) { try { win.webContents.send('tm:sync-progress', info); } catch (e) {} } };

  let done = 0;
  try {
    const r = await wd.rebuildAll({
      onEach: () => {
        done += 1;
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
        send({ phase: 'docx', current: done, total, status: '正在生成客户档案（' + done + ' / ' + total + '）', pct });
      },
    });
    send({ phase: 'done', status: '客户档案已生成（' + r.docs + ' 份，' + r.images + ' 张图片）', pct: 100 });
    finishClose(win, '客户档案已生成（' + r.docs + ' 份）', false);
  } catch (e) {
    send({ phase: 'done', status: '客户档案生成出错，仍正常关闭', pct: 100 });
    finishClose(win, '客户档案生成出错，已关闭', false);
  }
}

async function finishClose(win, statusText, wrotePending) {
  tmSyncDone = true;
  const notify = (phase, status) => {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('tm:sync-progress', { phase, status, pct: 100 }); } catch (e) {}
  };

  // ① 先显示档案生成结果（成功/失败），覆盖之前的「正在生成…」，pct 拉满。
  // 🔴 注意：这里**只更新进度，不收浮层** —— 浮层要一直显示到真正退出那一刻。
  notify(wrotePending ? 'gaveUp' : 'done', statusText);
  // 让这条最终结论停留一下，别被紧接着的「同步」文案一秒盖掉
  await new Promise((r) => setTimeout(r, 700));

  // ② 退出前把话术编排台的任务进度（board/<编号>.sent.json）全量推回后台。
  //   进度本机先存、改动时也会防抖同步（scriptBoard.scheduleProgressFlush）；
  //   这里在「确定关闭」的标准退出序列里再兜底一次，确保关闭软件时一定同步到后台数据库。
  //   失败/超时都不阻断退出（最多等 8s）。
  //   ⚠️ 这段期间界面必须写清楚在同步，不能停在「已生成」上装作完成。
  notify('done', '正在同步任务进度到后台…');
  try {
    const sb = require('../src/scriptBoard');
    if (sb && typeof sb.syncAllProgressToCloud === 'function') {
      const sync = sb.syncAllProgressToCloud();
      const timeout = new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
      await Promise.race([sync, timeout]).catch(() => {});
    }
  } catch (e) { /* 进度同步失败不阻断退出 */ }
  notify('done', '同步完成，正在退出…');

  // ③ 🔴 2026-10-23 修「进度条没了窗口还在」：
  //   旧版在函数开头就发了 tm:sync-end（收浮层），于是浮层早早就没了，但 app.exit 还卡在
  //   上面那段云端同步（最多 8s）+ 下面的 1.6s 延迟里 → 窗口空挂好几秒。
  //   现在把「收浮层」挪到真正退出这一刻：浮层持续显示（100% + 当前状态）直到进程结束，
  //   做到「完全完成后才关闭」。收浮层与 app.exit 同一时刻发生，不会有空窗期。
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('tm:sync-end'); } catch (e) {}
  }
  // 让用户看清「正在退出」，再真正退出
  setTimeout(() => {
    try { shutdownSessions(); } catch (e) {}
    app.exit();
  }, 1600);
}

function forceClose(win) {
  if (win && !win.isDestroyed()) { try { win.webContents.send('tm:sync-end'); } catch (e) {} }
  shutdownSessions();
  app.exit();
}

/* 🔴 2.6.1133 记录「上次关闭没备份」到本地 JSON（支持多条；重开补传后清空）。 */
function writePendingBackup(reason) {
  try {
    const fs = require('fs');
    const path = require('path');
    const DATA_DIR = require('../src/paths').DATA_ROOT;
    const file = path.join(DATA_DIR, 'pending_backup.json');
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
    arr.push({ ts: Date.now(), reason: reason || '' });
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    console.log('[pending_backup] 已记录离线未备份，待重开补传；当前共 ' + arr.length + ' 条');
  } catch (e) { console.warn('[pending_backup] 写入失败：', e && (e.message || e)); }
}

/* 🔴 2.6.1133 重开时补传上次「离线未备份」的翻译记忆：在线就推上去并清空记录，仍离线则留待下次。 */
async function recoverPendingBackups() {
  try {
    const fs = require('fs');
    const path = require('path');
    const DATA_DIR = require('../src/paths').DATA_ROOT;
    const file = path.join(DATA_DIR, 'pending_backup.json');
    if (!fs.existsSync(file)) return;
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) { return; }
    if (!Array.isArray(arr) || !arr.length) return;
    const cloud = require('../src/cloud');
    if (!cloud.isLoggedIn()) { console.log('[pending_backup] 本次未登录，保留 ' + arr.length + ' 条待补传'); return; }
    let online = false;
    try { await cloud.request('POST', '/api/auth/heartbeat', {}, { timeout: 5000 }); online = true; } catch (e) { online = false; }
    if (!online) { console.log('[pending_backup] 仍离线，保留 ' + arr.length + ' 条待补传'); return; }
    const tm = getTmCloud();
    const r = await tm.syncOnClose({ retries: 3, overallTimeoutMs: 15000 });
    if (r && r.disabled) {
      // 翻译记忆已改单向同步，关闭不再做云端同步，历史离线记录无意义，直接清空
      try { fs.unlinkSync(file); } catch (e) {}
      console.log('[pending_backup] 翻译记忆已改为单向同步，清空历史离线记录（共 ' + arr.length + ' 条）');
      return;
    }
    if (r && (r.ok || r.skipped)) {
      try { fs.unlinkSync(file); } catch (e) {}
      console.log('[pending_backup] 补传完成，已清空 ' + arr.length + ' 条记录');
    } else {
      console.log('[pending_backup] 补传未成功，保留记录待下次');
    }
  } catch (e) { console.warn('[pending_backup] 恢复异常：', e && (e.message || e)); }
}

/* 关闭确认框：渲染进程回「确定 / 取消」。
   取消 → 留在软件（复位 closeConfirmed）；确定 → 进入「备份+进度条→退出」序列。 */
ipcMain.handle('close:confirm-result', async (_e, ok) => {
  if (!ok) { closeConfirmed = false; return { confirmed: false }; }
  closeConfirmed = true;
  runCloseSequence();
  return { confirmed: true };
});

app.on('before-quit', () => { shutdownSessions(); });   // 🔴 2.6.1133：正常退出路径已走 app.exit()，这里只兜底清理会话
