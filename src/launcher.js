/*
 * 外部应用启动器（v1.5.1017，v2.5.10020 调整）
 * =====================================================================
 * 顶栏那排「S1~S3」按钮的后端：负责把 Signal 桌面端三开真正拉起来 / 关掉 / 汇报红灯黄灯绿灯。
 *
 *   S1~S3  = Signal Desktop（桌面应用），每个实例一个独立 --user-data-dir
 *            （%APPDATA%\Signal_1 … Signal_3），各登一个手机号 —— 真三开。
 *
 *   ⚠️ Telegram 网页版（T1~T3）v2.5.10020 起已【移入主窗口中间栏标签】
 *      （Tele①②③ 三个 app 内 webview），不再由这里拉外部 Chrome。下面的 telegram 启动分支保留为
 *      兼容代码，但默认不再构建 T 启动器。
 *
 * 🔴 铁律（和一号一致）：
 *   · 只管「启动 / 停止 / 状态灯」，不碰任何消息采集（采集下一版做）。
 *   · 客户端只能传白名单 id（s1~s3），绝不允许传任意路径，防命令注入。
 *   · 不写任何外部应用的文件，只读它的进程状态。
 *   · 所有异常都兜住，绝不让 /api/state 因为这个模块挂掉。
 *
 * 状态语义（跟一号的红黄绿对齐）：
 *   green  = 运行中（Signal 且已登录 → 绿）
 *   amber  = 启动中 / 已起进程但还没登录（Signal 起了却没登录 → 黄）
 *   red    = 没启动
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync, execFile } = require('child_process');

/**
 * execFile 的 Promise 版（v2.5.1034 卡顿治理）
 * 🔴 只 resolve、永不 reject：失败返回 null。PowerShell 在 Electron 里被沙箱吞掉是常态，
 *    必须当成"没查到"而不是"抛异常"，否则会打断整条刷新链。
 */
function execFileP(file, args, opts) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, opts, (err, stdout) => {
        if (err) resolve(null);
        else resolve(String(stdout || ''));
      });
    } catch (e) {
      resolve(null);
    }
  });
}

const runtime = require('./runtime');
const signalStatus = require('./signalStatus');
const browserPath = require('./browserPath');
const prewarm = require('./prewarm'); // v2.5.1036：预热互斥闸门（进程扫描独占静默窗口）

/* ---------- 预定义启动器（白名单，写死，不接受客户端任意 id） ---------- */

const SIGNAL_DEFAULT_EXE =
  process.env.SIGNAL_EXE ||
  'C:\\Users\\Administrator\\AppData\\Local\\Programs\\signal-desktop\\Signal.exe';

/**
 * Signal 实例 CDP 调试端口的基数（S1=base+1, S2=base+2, S3=base+3 → 9333/9334/9335）。
 * v2.5.1032：给「跳到聊天」用 —— Signal 是 Electron 应用，带 --remote-debugging-port 启动后
 * 就能用 puppeteer.connect 连进去，在页面上下文里定位并打开指定会话（比模拟键鼠稳得多）。
 * 🔴 端口是我们 spawn 时自己传的，不需要老板手动改 Signal 快捷方式。
 */
const SIGNAL_DEBUG_PORT_BASE = 9332;

function buildLaunchers(cfg) {
  const c = (cfg && cfg.launchers) || {};
  const signalExe = (c.signalExe && String(c.signalExe).trim()) || SIGNAL_DEFAULT_EXE;
  const tgUrl = (c.telegramUrl && String(c.telegramUrl).trim()) || 'https://web.telegram.org';
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

  const list = [];

  // S1~S3：Signal Desktop 三开（v2.5.10020 起由 5 个减为 3 个）
  // v2.5.1032：每个实例分配一个固定 CDP 调试端口（S1→9333 / S2→9334 / S3→9335），
  //   供「跳到聊天」用 puppeteer.connect 连进去定位会话（Signal 是 Electron，吃这个参数）。
  for (let i = 1; i <= 3; i++) {
    const dir = path.join(appData, `Signal_${i}`);
    list.push({
      id: `s${i}`,
      label: `S${i}`,
      kind: 'signal',
      exe: signalExe,
      dir,
      debugPort: SIGNAL_DEBUG_PORT_BASE + i,
    });
  }

  // ⚠️ Telegram（T1~T3）v2.5.10020 起改为主窗口内的 app 内 webview 标签（Tele①②③），
  //    不再由这里拉起外部 Chrome。保留 telegram 启动分支以兼容，但默认不构建 T 启动器。

  return list;
}

let LAUNCHERS = [];
const byId = new Map();

function init(cfg) {
  LAUNCHERS = buildLaunchers(cfg);
  byId.clear();
  for (const l of LAUNCHERS) byId.set(l.id, l);
  /*
   * 🔴 v2.5.1036（老板拍板）：这里【绝不】预热扫进程。
   *   软件刚起来、用户还没点「启动」，扫出来也全是"没启动"，
   *   白白在登录那几秒抢主线程（PowerShell 一次 1 秒多）。
   *   扫描从用户点「启动」那一刻才开始 —— 见 markUserStarted()。
   */
}

/** 返回所有 Signal 类型启动器的数据目录（绝对路径），供 Signal 采集轮询逐个实例读库 */
function signalDirs() {
  return LAUNCHERS.filter((l) => l.kind === 'signal').map((l) => l.dir);
}

/* ---------- 进程扫描（按 --user-data-dir 精确区分实例） ---------- */

/**
 * 用 PowerShell 的 Get-CimInstance 拿指定进程名的所有命令行。
 * 🔴 为什么不用 tasklist：tasklist 拿不到完整命令行（含 --user-data-dir 参数），
 *    而我们要靠 user-data-dir 把「Signal_1」和「Signal_2」两个进程区分开。
 *    dpapi.js 已经证明在真实 Electron 主进程里 execFileSync('powershell.exe') 可用，
 *    所以这里直接用，不绕 shell。
 * @returns {string[]|null} 命令行数组；null = 查不到（区别于「查到了，确实没跑」）
 */
function scanCommandLines(procName) {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${procName}'" | Select-Object -ExpandProperty CommandLine`,
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    );
    return String(out || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    return null;
  }
}

/**
 * 异步版进程扫描（v2.5.1034 卡顿治理的主角）
 * 🔴 原来这里是同步 execFileSync，单次约 1.1 秒 × 3 个进程名 = 3.3 秒**卡死主线程**；
 *    现在改成异步后两重优化同时生效：
 *      ① 不阻塞：PowerShell 在跑的时候，界面和所有接口照常响应；
 *      ② 并行：Signal.exe / chrome.exe / msedge.exe 三个一起查（Promise.all），
 *         墙钟时间从 3.3 秒降到 ~1.1 秒。
 */
async function scanCommandLinesAsync(procName) {
  const out = await execFileP(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='${procName}'" | Select-Object -ExpandProperty CommandLine`,
    ],
    { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 },
  );
  if (out === null) return null;
  return String(out || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 某一行命令行里是否含某个 user-data-dir 标记（大小写/反斜杠归一） */
function cmdHasDir(cmdLine, dir) {
  if (!cmdLine) return false;
  const want = `--user-data-dir=` + dir.replace(/\//g, '\\').toLowerCase();
  return cmdLine.toLowerCase().includes(want);
}

/* ---- 进程扫描结果缓存（v2.5.1034 卡顿治理）----
 * 🔴 铁律同 signalStatus：**同步路径只读缓存，绝不起 PowerShell。**
 *    _runningMap 由 refreshRunning()（异步）和后台定时器维护。
 */
let _runningMap = new Map();
let _runningAt = 0;
let _runningInflight = null;

/**
 * 真正去扫进程（异步 + 三个进程名并行）。
 * 🔴 这是本文件唯一会起 PowerShell 的地方，且是异步的 —— 期间主线程照常服务请求。
 */
async function refreshRunning() {
  // 同一时刻只跑一次扫描，重复调用复用同一个 Promise
  if (_runningInflight) return _runningInflight;

  _runningInflight = (async () => {
    try {
      // Signal.exe / chrome.exe / msedge.exe 并行扫，互不影响
      const [sigLines, chromeLines, edgeLines] = await Promise.all([
        scanCommandLinesAsync('Signal.exe'),
        scanCommandLinesAsync('chrome.exe'),
        // Edge 也是 Chromium，Telegram 网页版可用，且不会弹 CfT 提示，所以也要认
        scanCommandLinesAsync('msedge.exe'),
      ]);
      const running = new Map();
      for (const l of LAUNCHERS) {
        let hit = false;
        if (l.kind === 'signal') {
          if (sigLines) hit = sigLines.some((c) => cmdHasDir(c, l.dir));
        } else {
          // Telegram 窗口可能是 chrome.exe（本机 Chrome）或 msedge.exe（本机 Edge）
          if (chromeLines) hit = hit || chromeLines.some((c) => cmdHasDir(c, l.dir));
          if (edgeLines) hit = hit || edgeLines.some((c) => cmdHasDir(c, l.dir));
        }
        running.set(l.id, hit);
      }
      _runningMap = running;
      _runningAt = Date.now();
    } catch (e) {
      // 扫失败就保留上一次结果，绝不清空成"全没跑"（那会让所有灯瞬间变红）
    }
    return _runningMap;
  })();

  try {
    return await _runningInflight;
  } finally {
    _runningInflight = null;
  }
}

/**
 * 同步读取「每个启动器 id → 是否正在跑」。
 * 🔴 只读缓存，**永不阻塞**。缓存由 refreshRunning() / 后台定时器维护。
 */
function scanRunning() {
  return _runningMap;
}

/* ---------- 启动 / 停止 ---------- */

// 我们 spawn 出来的子进程句柄（用来精确杀掉自己拉的进程）
const children = new Map();
// 最近一次「点启动」的时间戳：用来在进程还没冒出来之前先显示黄灯（启动中）
const startedAt = new Map();
// v2.6.1120：正在「等本地代理中转就绪」的实例 id。用户若在这期间点了停止，就从这里摘掉 → 放弃这次启动。
const pendingStarts = new Set();

function killChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try { child.kill('SIGTERM'); } catch (e) { /* 已退出 */ }
  try {
    execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], {
      windowsHide: true, stdio: 'ignore', timeout: 5000,
    });
  } catch (e) { /* 进程可能已自己退了 */ }
}

/**
 * 精确按 user-data-dir 杀进程（Signal.exe / chrome.exe 各自独立处理）。
 * 🔴 关键：杀的时候用 CommandLine 里携带的 --user-data-dir 去匹配，绝不止杀「所有 Signal/chrome」，
 *    否则会把别的实例（Signal_2…Signal_5 或一号的 WhatsApp Chrome）一起误杀。
 *    匹配串把反斜杠转义给 PowerShell 的 -like 用。
 */
function killByDirPrecise(launcher) {
  // Telegram 窗口可能是 chrome.exe 或 msedge.exe，两种都杀
  const procNames = launcher.kind === 'signal' ? ['Signal.exe'] : ['chrome.exe', 'msedge.exe'];
  const like = `*--user-data-dir=*${launcher.dir.replace(/\\/g, '\\\\')}*`;
  let ok = true;
  for (const procName of procNames) {
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `$ps = Get-CimInstance Win32_Process -Filter "Name='${procName}'"; ` +
          `$ps | Where-Object { $_.CommandLine -like '${like}' } | ` +
          `ForEach-Object { taskkill.exe /T /F /PID $($_.ProcessId) }`,
        ],
        { encoding: 'utf8', timeout: 8000, windowsHide: true },
      );
    } catch (e) {
      ok = false;
    }
  }
  return ok;
}

function startLauncher(id) {
  const l = byId.get(id);
  if (!l) return { ok: false, error: `未知启动器 ${id}` };

  // 已经是绿的（我们拉的或外部已起）→ 不重复拉
  if (isRunningNow(l)) {
    return { ok: true, action: 'already', running: true };
  }

  if (l.kind === 'signal') {
    if (!fs.existsSync(l.exe)) {
      return { ok: false, error: `找不到 Signal 程序：${l.exe}` };
    }
    try {
      // 🔴 Signal 是 Electron 应用，不吃 --user-data-dir（不会真的把数据写到那个目录）。
      //    要让 S1~S5 每个实例数据独立，必须靠「改 APPDATA/LOCALAPPDATA 环境变量」
      //    把它真正的 userData 指到各自目录。Signal 的 userData = <APPDATA>\Signal，
      //    所以这里把两份环境变量都指到 l.dir，数据就落在 l.dir\Signal
      //    （与 signalStatus.pathsFor 的探测路径一致）。
      //    --user-data-dir 仍带上，仅用于进程扫描时按命令行精确区分实例。
      const env = Object.assign({}, process.env, { APPDATA: l.dir, LOCALAPPDATA: l.dir });
      /*
       * v2.5.1032：加 CDP 调试端口，供「跳到聊天」连进来定位会话。
       *   --remote-debugging-port  Signal 是 Electron，吃这个参数（与 signal-bot 等开源方案同路子）
       *   --remote-allow-origins=* Chrome 111+ 起对 DevTools WebSocket 做 Origin 校验，
       *                            不加这个 puppeteer.connect 会被 403 拒掉
       * ⚠️ 端口被占用时 Electron 会自己换一个端口，所以连不上属正常，jumpToChat 会降级处理。
       */
      const args = [`--user-data-dir=${l.dir}`];
      if (l.debugPort) args.push(`--remote-debugging-port=${l.debugPort}`);
      args.push('--remote-allow-origins=*');

      /** 真正 spawn（把 env 完整带进去，供「已就绪」与「稍后就绪」两条路径复用） */
      const doSpawn = (finalEnv) => {
        const child = spawn(l.exe, args, {
          stdio: 'ignore',
          windowsHide: false,
          env: finalEnv,
        });
        child.on('error', (e) => console.error(`[launcher] ${id} 启动失败：`, e.message));
        child.on('exit', (code) => { if (children.get(id) === child) children.delete(id); });
        children.set(id, child);
        startedAt.set(id, Date.now());
        markUserStarted(); // 🔴 v2.5.1036：从这一刻起才开始扫进程（之前一次都不扫）
        return { ok: true, action: 'started', running: true };
      };

      /*
       * ★ v2.6.1120：Signal 的代理也改走「本机 gost 无密码中转」★
       *   旧代码注入的是 proxies.envFor(l.id)，那个串**完全不带账密** → 带认证的代理必然连不上；
       *   而带账密的串又不能直接给 Signal（Chromium 内核不支持代理账密，账密会被静默丢弃）。
       *   现在注入 http://127.0.0.1:<port>（本机、无密码），账密只由 gost 拿去连上游。
       *
       * ⚠️ 本函数是**同步**的（调用方 `const r = startLauncher(id)` 直接当对象用），不能 await。
       *    所以中继靠「提前预热」：软件启动时 + 老板保存代理配置后，都会跑一次
       *    webviewProxy.warmUpAll() 把已启用实例的 gost 起好。这里用 peek() 同步取即可。
       *    万一真没预热上，就在后台等它就绪再拉（Signal 自己启动也要好几秒，感知不到这点延迟）。
       */
      let rec = null;
      try { rec = require('./proxyRelay').peek(l.id); } catch (e) { /* 忽略 */ }
      if (rec) {
        env.HTTPS_PROXY = rec.localUrl;
        env.HTTP_PROXY = rec.localUrl;
        return doSpawn(env);
      }

      // 中继还没就绪：只有该实例确实启用了代理才值得等；否则直接拉（直连）
      let proxyEnabled = false;
      try {
        const e2 = require('./proxies').get(l.id);
        proxyEnabled = !!(e2 && e2.enabled);
      } catch (e) { /* 代理模块不可用就按直连处理 */ }

      if (proxyEnabled) {
        pendingStarts.add(id);
        require('./proxyRelay').getRelay(l.id).then((r2) => {
          if (!pendingStarts.has(id)) return; // 期间用户点了「停止」→ 放弃这次启动，不留孤儿进程
          pendingStarts.delete(id);
          const env2 = Object.assign({}, env);
          if (r2) {
            env2.HTTPS_PROXY = r2.localUrl;
            env2.HTTP_PROXY = r2.localUrl;
          } else {
            console.warn(`[launcher] ${id} 本地中转起不来 → Signal 走直连（绝不注入带账密的代理串）`);
          }
          doSpawn(env2);
        }).catch(() => {
          if (!pendingStarts.has(id)) return;
          pendingStarts.delete(id);
          console.warn(`[launcher] ${id} 等待本地中转时出错 → Signal 走直连`);
          doSpawn(env);
        });
        return { ok: true, action: 'starting', running: true };
      }

      return doSpawn(env);
    } catch (e) {
      return { ok: false, error: 'Signal 启动出错：' + (e.message || e) };
    }
  }

  // telegram：拉一个独立浏览器窗口，打开 web.telegram.org。
  // 🔴 用「标准版」浏览器（系统 Chrome / Edge），不用 Puppeteer 自带的 Chrome for Testing，
  //    否则会弹 "Chrome for Testing ... is only for automated testing" 的提示。
  const chrome = browserPath.resolveStandardExecutable({});
  if (!chrome) {
    return { ok: false, error: '找不到浏览器：请在 config.yaml 的 browser.executablePath 指定，或安装 Chrome/Edge' };
  }
  try {
    // 清掉上次的锁文件，避免 "user data directory is already in use"
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(l.dir, lock)); } catch (e) {}
    }
    try { fs.mkdirSync(l.dir, { recursive: true }); } catch (e) {}

    const args = [
      l.url,
      `--user-data-dir=${l.dir}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${l.port}`,
      '--lang=en-US',
      '--window-size=1280,860',
      // 🔴 故意不给 window-position：Telegram 窗口要落在屏幕里给用户用，
      //    不像 WhatsApp 那样藏到 -3000,-3000 屏幕外。
    ];
    const child = spawn(chrome, args, { stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => console.error(`[launcher] ${id} 启动失败：`, e.message));
    child.on('exit', (code) => { if (children.get(id) === child) children.delete(id); });
    children.set(id, child);
    startedAt.set(id, Date.now());
    markUserStarted(); // 🔴 v2.5.1036：同上，Telegram 窗口也是点了才扫
    return { ok: true, action: 'started', running: true };
  } catch (e) {
    return { ok: false, error: 'Telegram 启动出错：' + (e.message || e) };
  }
}

function stopLauncher(id) {
  const l = byId.get(id);
  if (!l) return { ok: false, error: `未知启动器 ${id}` };

  // v2.6.1120：若这个实例还在「等本地代理中转就绪」的阶段，先摘掉 → 放弃那次延迟启动，避免留孤儿进程
  pendingStarts.delete(id);

  // 先杀我们自己拉的进程
  const child = children.get(id);
  if (child) {
    killChild(child);
    children.delete(id);
  }
  // 再兜底：外部拉起来的（或我们拉了但句柄丢了）也按 user-data-dir 精确杀
  killByDirPrecise(l);

  startedAt.delete(id);
  markUserStopped(); // 🔴 v2.5.1036：停止后给一小段观察期，让灯及时变红
  return { ok: true, action: 'stopped', running: false };
}

/** 进程此刻在不在（我们拉的句柄 + 全局扫描双重确认） */
function isRunningNow(l) {
  const child = children.get(l.id);
  if (child && child.exitCode === null && !child.killed) return true;
  // 缓存还是空的（刚启动、扫描还没回来）→ 顺手催一次，但本次按"不知道"处理
  if (!_runningAt) refreshRunning().catch(() => {});
  const running = scanRunning();
  return !!running.get(l.id);
}

/* ---------- 状态聚合（v2.5.1034 卡顿治理：请求路径只读缓存，后台异步刷新）----------
 *
 * 🔴🔴 卡顿根因复盘（这次修的就是它）：
 *   旧版缓存 5 秒，而前端每 10 秒轮询一次 /api/state → **缓存必然已过期** →
 *   每次轮询都现场同步扫进程（3 次 PowerShell，3.3 秒），主线程整段卡死。
 *   表现就是：启动卡一下、输入密码卡一下、点登录卡一下（请求撞上扫描要排队）。
 *
 * 新版四件事：
 *   ① 扫描改异步（execFile）+ 三个进程名并行 → 3.3 秒降到 ~1.1 秒，且期间不阻塞；
 *   ② 缓存 30 秒，且**即使过期也先返回旧值**，异步后台补 —— 请求路径永不等待；
 *   ③ 后台定时刷新，保证前端轮询到的是热数据；
 *   ④ v2.5.1036：**刷新的节奏按老板定的来** —— 用户没点「启动」一次都不刷；
 *      点了「启动」进观察期（2 秒一次，就为快点绿灯），全绿后退回稳定期（611 秒一次），
 *      每次扫描独占「前 3 秒 + 后 1 秒」静默窗口，别的预热一律让路。
 *      具体见下面「扫描节奏」那一节。
 */

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 30000;

function computeStates() {
  const running = scanRunning();
  const now = Date.now();
  const out = [];

  for (const l of LAUNCHERS) {
    const isUp = running.get(l.id) ||
      (() => { const c = children.get(l.id); return c && c.exitCode === null && !c.killed; })();

    let status = 'red';
    let title = l.kind === 'signal'
      ? `${l.label}：Signal 未启动`
      : `${l.label}：Telegram 窗口未打开`;

    if (isUp) {
      /*
       * 🔴 v2.5.1037（老板拍板）：Signal 这一支原来还要再往下调一次
       *    signalStatus.detectCached()，去确认「进程起来了、但是不是已登录」——
       *    那一步要解 Signal 的 DPAPI 主密钥（跑 PowerShell，实测约 1.8 秒），
       *    而且每次刷新三个实例各来一遍。
       *
       *    老板现在都是自己开 Signal 窗口，不需要软件替他盯着登录态，
       *    于是那条「检测 Signal 登录」的预热整条删掉，这里随之简化：
       *
       *      绿灯 = 进程在跑（你自己开的窗口在那儿）
       *      红灯 = 进程没了
       *
       *    登录态不再由这盏灯负责 —— 真到了读消息那一步，
       *    Signal 采集（第 3 条）自己开库，读不出来它自己会报。
       */
      status = 'green';
      title = l.kind === 'signal'
        ? `${l.label}：Signal 已启动`
        : `${l.label}：Telegram 窗口已打开（web.telegram.org）`;
    } else if (startedAt.has(l.id) && now - startedAt.get(l.id) < 5000) {
      // 刚点了启动，进程还没冒出来 → 先给黄灯「启动中」
      status = 'amber';
      title = `${l.label}：正在启动…`;
    }

    out.push({ id: l.id, label: l.label, kind: l.kind, status, title });
  }
  return out;
}

/* 同一时刻只跑一次刷新，重复调用复用同一个 Promise */
let _statesInflight = null;

/** 缓存还没建立时先给的占位（黄灯=进行中，不是"没启动"的红灯） */
function placeholderStates() {
  return LAUNCHERS.map((l) => ({
    id: l.id, label: l.label, kind: l.kind, status: 'amber', title: `${l.label}：状态检测中…`,
  }));
}

/**
 * 真正干活的状态刷新（异步）。
 * 🔴 唯一会触发进程扫描的入口；扫描期间主线程照常服务所有请求。
 */
function refreshNow() {
  if (_statesInflight) return _statesInflight;

  _statesInflight = (async () => {
    await refreshRunning();
    let out;
    try {
      out = computeStates();
    } catch (e) {
      // 兜底：万一部分探测出错，其余照常返回
      out = LAUNCHERS.map((l) => ({ id: l.id, label: l.label, kind: l.kind, status: 'red', title: `${l.label}：状态检测出错` }));
    }
    _cache = out;
    _cacheAt = Date.now();
    return out;
  })();

  return _statesInflight.finally(() => { _statesInflight = null; });
}

/**
 * 给 /api/state 用的同步读取。
 * 🔴 **永不阻塞**：有缓存就立即给（哪怕略旧），过期了后台异步补；
 *    从没算过就先给占位，同样后台补。界面最多晚 1~2 秒看到，但全程不卡。
 */
function launcherStates(force) {
  const now = Date.now();
  /*
   * 🔴 v2.5.1036（老板拍板）：用户没点过「启动」→ 一次都不扫，直接给"未启动"红灯。
   *   这既守住了「登录前不许有任何动作」，也守住了「没开就别一直扫」。
   */
  if (!_armed) {
    if (!_cache) { _cache = computeStates(); _cacheAt = Date.now(); }
    return _cache;
  }
  if (_cache) {
    // 闸门关着（进程扫描正占着静默窗口）→ 本次只读缓存，绝不催一次扫描
    if (force || (now - _cacheAt >= CACHE_MS && !prewarm.blocked())) {
      refreshNow().catch(() => {});
    }
    return _cache;
  }
  refreshNow().catch(() => {});
  return placeholderStates();
}

/* ====================================================================
 * 扫描节奏（v2.5.1036 · 老板拍板）
 *
 * 老板定的规矩，翻译成代码就三条：
 *
 *   ① 软件刚开、你没点「启动」之前 → **一次都不扫**。
 *      那时候 S1/S2/S3 根本没有进程，扫了也白发呆。
 *
 *   ② 你点了「启动」→ 进【观察期】：每 2 秒扫一次，就为了快点把灯点亮。
 *      被启动的实例一旦**全绿**（起来且已登录）→ 立刻退回稳定期（这才是"不用一直扫"）。
 *      一直起不来（exe 路径不对之类）→ 60 秒后放弃，最长也不超过 3 分钟。
 *
 *   ③ 稳定期：每 611 秒扫一次，每次扫描独占一个静默窗口：
 *
 *      ├────────── 约 606 秒：别的预热照常各跑各的 ──────────┤ 前3秒静默 │ 扫描 │ 后1秒静默 │
 *      0s                                                608s       611s   ~612.1s    613.1s
 *                                                                    ↑ 两次扫描间隔正好 611 秒
 *
 *      静默窗口里，Signal 消息采集 / 客户档案 Word 重建 / 开 Telegram 窗口
 *      全跳过本轮（闸开了再补），绝不跟进程扫描挤在同一秒。
 *      （v2.5.1037：「Signal 登录检测」那条预热已整条删除，不在让路名单里了。）
 *
 * 🔴 注意：观察期是「用户主动点了启动」才有的短窗口（≤3 分钟），
 *    那几秒要的是"立刻看到灯变绿"，所以不套静默窗口。
 * ===================================================================== */

/** 稳定期：两次进程扫描之间的间隔（611 秒 ≈ 10 分 11 秒） */
const SCAN_PERIOD_MS = 611000;
/** 扫描【前】先静默 3 秒：这 3 秒里别的预热全停，把机器让给扫描 */
const SCAN_LEAD_MS = 3000;
/** 扫描【后】再压 1 秒：扫完喘口气，别的预热才能重新排队 */
const SCAN_TAIL_MS = 1000;
/** 观察期（刚点「启动」那阵）：2 秒扫一次 */
const OBSERVE_MS = 2000;
/** 观察期最长 3 分钟，到点自动退回稳定期（防 Signal 起不来时无限快扫） */
const OBSERVE_MAX_MS = 180000;
/** 观察期内如果一个进程都没起来，60 秒后放弃（多半是 exe 路径不对） */
const OBSERVE_GIVEUP_MS = 60000;

/** 用户有没有点过「启动」—— 没点过就一次都不扫 */
let _armed = false;
/** 观察期截止时间戳（0 = 不在观察期） */
let _observeUntil = 0;
/** 最近一次点「启动」的时间（用来判断是不是白等） */
let _lastStartAt = 0;
/** 排障 / 自检用 */
let _scanCount = 0;
let _lastScanAt = 0;
let _lastScanCostMs = 0;
/** 扫描定时器（自调度 setTimeout —— 间隔要动态算，不能用固定 interval） */
let _bgTimer = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 被启动过、还没被停止的实例 id（只有这些灯才算数） */
function startedIds() {
  return LAUNCHERS.filter((l) => startedAt.has(l.id)).map((l) => l.id);
}

/** 被启动过的实例是不是【全绿】了（绿 = 进程在跑 + Signal 已登录） */
function allStartedGreen() {
  const ids = startedIds();
  if (!ids.length) return true;
  const st = computeStates();
  return ids.every((id) => ((st.find((s) => s.id === id) || {}).status === 'green'));
}

/** 被启动过的实例里，有没有至少一个进程真的起来了（判断是不是白等） */
function anyStartedRunning() {
  const ids = startedIds();
  if (!ids.length) return true;
  const m = scanRunning();
  return ids.some((id) => {
    if (m.get(id)) return true;
    const c = children.get(id);
    return !!(c && c.exitCode === null && !c.killed);
  });
}

/** 点了「启动」→ 进观察期，1.5 秒后扫第一次（就为了让灯快点绿） */
function markUserStarted() {
  _armed = true;
  _lastStartAt = Date.now();
  _observeUntil = Date.now() + OBSERVE_MAX_MS;
  if (_bgTimer) scheduleScan(1500); // 只挪下一次扫描的时间，不重复起定时器
}

/** 点了「停止」→ 也给 30 秒观察期，好让灯及时变红 */
function markUserStopped() {
  if (!_armed) return;
  _observeUntil = Date.now() + 30000;
  if (_bgTimer) scheduleScan(1500);
}

/**
 * 安排下一次扫描。
 * 🔴 定时器 unref：绝不阻止进程退出。
 */
function scheduleScan(delayMs) {
  if (_bgTimer) clearTimeout(_bgTimer);
  _bgTimer = setTimeout(() => { scanCycle().catch(() => {}); }, Math.max(200, Number(delayMs) || 1000));
  if (_bgTimer && typeof _bgTimer.unref === 'function') _bgTimer.unref();
}

/** 跑一次真扫描（刷进程表 + 重算三盏灯），顺手记个账给自检看 */
async function scanOnce() {
  const t0 = Date.now();
  await refreshNow();
  _scanCount += 1;
  _lastScanAt = Date.now();
  _lastScanCostMs = _lastScanAt - t0;
  return _lastScanCostMs;
}

/**
 * 一轮扫描周期。跑完自己排下一轮，间隔动态算，保证「扫描 → 扫描」正好 611 秒。
 */
async function scanCycle() {
  try {
    // ① 用户一次都没点过「启动」→ 这次不扫，611 秒后再看
    if (!_armed) {
      scheduleScan(SCAN_PERIOD_MS);
      return;
    }

    // ② 观察期：只管快扫，就为了早点看到绿灯
    if (Date.now() < _observeUntil) {
      await scanOnce();
      if (allStartedGreen()) {
        // 全绿了 = 起来且已登录 → 立刻退回稳定期（这才是老板要的"不用一直扫"）
        _observeUntil = 0;
      } else if (!anyStartedRunning() && Date.now() - _lastStartAt > OBSERVE_GIVEUP_MS) {
        // 一个进程都没起来，多半是 exe 路径不对 —— 别在这儿空转
        _observeUntil = 0;
      }
      scheduleScan(OBSERVE_MS);
      return;
    }

    // ③ 稳定期：静默 3 秒 → 扫描 → 再静默 1 秒 → 排下一轮
    const cycleStart = Date.now();
    prewarm.hold(SCAN_LEAD_MS, 'launcher-scan'); // 前 3 秒：别的预热全停
    await sleep(SCAN_LEAD_MS);
    await scanOnce();
    prewarm.hold(SCAN_TAIL_MS, 'launcher-scan'); // 扫完再压 1 秒
    scheduleScan(Math.max(1000, SCAN_PERIOD_MS - (Date.now() - cycleStart)));
  } catch (e) {
    // 兜底：扫描链断了也不能把后台停死
    scheduleScan(SCAN_PERIOD_MS);
  }
}

/**
 * 启动后台扫描（由 startBackgroundServices 在「登录 + 同步完成」后调用）。
 *
 * 🔴 跟旧版最大的区别：**进来先不扫**。
 *    旧版 tick() 一进来就扫 —— 用户还没点「启动」就先跑一轮 PowerShell，
 *    那一秒多的开销正好落在登录之后、界面刚出来的节骨眼上。
 *    现在只有用户真的点过启动（_armed）才扫，否则直接给"未启动"红灯。
 */
function startBackgroundRefresh() {
  stopBackgroundRefresh();
  if (_armed) scanOnce().catch(() => {});
  else { _cache = computeStates(); _cacheAt = Date.now(); }
  scheduleScan(SCAN_PERIOD_MS - SCAN_LEAD_MS);
}

function stopBackgroundRefresh() {
  if (_bgTimer) { clearTimeout(_bgTimer); _bgTimer = null; }
}

/**
 * 只读缓存：S1~S3 里有没有【任意一个】已经亮绿灯。
 *
 * 🔴 v2.5.1039（老板图里的循环1 停止条件）：「S1 S2 S3 随便启动一个，
 *    随便一个启动绿灯后，循环1 停止」—— 判据是"任意一个"，不是"三个全绿"。
 *
 * 🔴 这里是【只读缓存】，绝不催扫描：
 *    循环1/循环2 每 3 秒问一次，如果每问一次就顺手 refreshNow() 一轮，
 *    那就等于把「611 秒扫一次」偷偷改成「3 秒扫一次」了（PowerShell 会被打爆）。
 *    灯本身由观察期（点了启动后每 2 秒一轮）刷新，所以绿灯最多 2 秒内就能被这里看到。
 */
function anySignalGreenCached() {
  try {
    if (!_cache) return false;
    return _cache.some((s) => s.kind === 'signal' && s.status === 'green');
  } catch (e) {
    return false;
  }
}

/**
 * 循环2 起点对齐（v2.5.1039 · 老板图里的循环2 / 循环3）：
 *   「循环2 跑起来，跑到 611 秒后停下，扫进程 S1 2 3 预热，等待 1 秒，继续循环2」
 *
 * 所以 611 秒这个计时从【循环2 起来那一刻】（S1~S3 任一绿灯）开始算，
 * 不是在登录那一刻算。绿灯一到就调这里：
 *   · 立刻结束观察期（灯已经绿了，不需要再 2 秒一快扫）；
 *   · 第一枪排到 611 - 3 = 608 秒后（前面留 3 秒静默，扫完再压 1 秒，随后按 611 秒循环）。
 *
 * @returns {{ok:boolean, armed:boolean, firstScanInMs:number, periodMs:number}}
 */
function beginStableRhythm() {
  _observeUntil = 0;
  const firstScanInMs = Math.max(1000, SCAN_PERIOD_MS - SCAN_LEAD_MS);
  if (_armed) scheduleScan(firstScanInMs);
  return { ok: true, armed: _armed, firstScanInMs: _armed ? firstScanInMs : 0, periodMs: SCAN_PERIOD_MS };
}

/** 扫描节奏体检（日志 / 自检用）：现在哪个阶段、下次扫描还有多久 */
function scanStatus() {
  return {
    armed: _armed,                          // 用户点过「启动」了吗
    observing: Date.now() < _observeUntil,  // 是不是在观察期
    observeLeftMs: Math.max(0, _observeUntil - Date.now()),
    periodMs: SCAN_PERIOD_MS,
    leadMs: SCAN_LEAD_MS,
    tailMs: SCAN_TAIL_MS,
    scans: _scanCount,
    lastScanAt: _lastScanAt,
    lastScanCostMs: _lastScanCostMs,
    gate: prewarm.status(),
  };
}

module.exports = {
  init,
  signalDirs,
  /**
   * v2.5.1032：返回 Signal 实例可用的 CDP 调试端口（S1~S3）。
   * 供「跳到聊天」用 puppeteer.connect 连进对应 Signal 实例定位会话。
   * @returns {number[]} 例如 [9333, 9334, 9335]；没初始化过返回空数组
   */
  signalDebugPorts() {
    return LAUNCHERS.filter((l) => l.kind === 'signal' && l.debugPort).map((l) => l.debugPort);
  },
  /**
   * v2.5.1069：返回所有 kind==='signal' 的启动器 id（S1~S3）。
   * 供「跳到聊天」②（软件拉起 Signal）：若 Signal 一个都没跑，就逐个 startLauncher 拉起。
   * @returns {string[]} 例如 ['S1','S2','S3']
   */
  signalLauncherIds() {
    return LAUNCHERS.filter((l) => l.kind === 'signal').map((l) => l.id);
  },
  startLauncher,
  stopLauncher,
  launcherStates,
  /** v2.5.1034：异步刷新（供 /api/launcher 之类需要"立刻重查"的入口 await） */
  refreshNow,
  refreshRunning,
  /** v2.5.1036：后台扫描（节奏见 scanCycle 说明：观察期 2 秒、稳定期 611 秒） */
  startBackgroundRefresh,
  stopBackgroundRefresh,
  /** v2.5.1036：扫描节奏体检（现在哪个阶段 / 扫过几次 / 闸门状态） */
  scanStatus,
  /**
   * v2.5.1039：循环1 的停止条件 —— S1~S3 里任意一个绿灯（只读缓存，绝不催扫描）
   */
  anySignalGreenCached,
  /**
   * v2.5.1039：循环2 起点对齐 —— 611 秒计时从循环2 起来那一刻归零
   */
  beginStableRhythm,
  // 测试/调试用
  _scanRunning: scanRunning,
  /** v2.5.1036：测试里模拟"用户点了启动"（真实路径是 startLauncher 内部调） */
  _markUserStarted: markUserStarted,
  _markUserStopped: markUserStopped,
  _resetCache() {
    _armed = false; _observeUntil = 0; _lastStartAt = 0;
    _scanCount = 0; _lastScanAt = 0; _lastScanCostMs = 0;
    _cache = null; _cacheAt = 0;
    _runningMap = new Map(); _runningAt = 0;
    _runningInflight = null; _statesInflight = null;
    children.clear(); startedAt.clear();
    stopBackgroundRefresh();
    signalStatus._resetCache();
  },
};
