/**
 * 浏览器会话：每个 WhatsApp 账号一个独立实例
 *
 * 隔离三件套：
 *   1. 独立 userDataDir（LocalAuth 的 clientId）—— cookie / localStorage 物理隔离
 *   2. 独立代理 IP —— 启动参数 --proxy-server，每号一个出口
 *   3. puppeteer-extra + stealth —— Node 层补丁，消除自动化痕迹（不是浏览器扩展）
 *
 * 另外：时区与语言必须和代理所在地一致，否则代理在美国、时区在上海，一眼假。
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');

let puppeteer;
try {
  const extra = require('puppeteer-extra');
  extra.use(require('puppeteer-extra-plugin-stealth')());
  puppeteer = extra;
} catch (e) {
  console.warn('[session] 未安装 puppeteer-extra，反检测能力会打折扣');
  puppeteer = require('puppeteer');
}

/** 从代理 URL 里剥离账密，Chrome 不接受 URL 内嵌账密（会静默丢弃导致 407） */
function splitProxy(proxyUrl) {
  if (!proxyUrl) return { url: null, auth: null };
  try {
    const u = new URL(proxyUrl);
    const auth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : null;
    u.username = '';
    u.password = '';
    return { url: u.toString().replace('://', '://'), auth };
  } catch (e) {
    return { url: proxyUrl, auth: null };
  }
}

/** 把网址归一化（去掉 #hash 与结尾 /），用来判断"这个网址是否已经开着" */
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    let s = url.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch (e) {
    return String(u || '').replace(/#.*$/, '').replace(/\/$/, '');
  }
}

/**
 * 清掉 Chrome 自己的「会话恢复」痕迹。
 *
 * 为什么必须做：为了让登录态（cookie / localStorage）持久化，我们给每个账号用了固定的
 * userDataDir。但副作用是——Chrome 会把"上次开着的标签页"存在这个目录里，下次启动时
 * 自动把它们再开一遍。于是出现用户反馈的"关掉 3 个标签、重开却变 4 个 / 多出一张 WhatsApp"。
 *
 * 我们想让"恢复标签页"这一件事完全由本软件的快照逻辑（restoreOpenTabs）控制，所以这里把
 * Chrome 自带的恢复文件删掉，让它每次都从干净状态启动。
 * 注意：只删会话文件，**不碰 Cookies / Local Storage**，所以登录态照旧保持。
 */
function clearChromeSessionRestore(dir) {
  const names = ['Session', 'Current Session', 'Last Session', 'Current Tabs', 'Last Tabs', 'Last Cookies', 'Network Action Predictor'];
  for (const n of names) {
    try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* 不存在就跳过 */ }
  }
  try { fs.rmSync(path.join(dir, 'Sessions'), { recursive: true, force: true }); } catch (e) { /* 不存在就跳过 */ }
  // 把"继续上次会话"关掉，双保险（首启时 Default 目录还不存在，第二次起才生效）
  try {
    const pref = path.join(dir, 'Default', 'Preferences');
    if (fs.existsSync(pref)) {
      const obj = JSON.parse(fs.readFileSync(pref, 'utf8'));
      obj.session = obj.session || {};
      obj.session.restore_on_startup = 0; // 0 = 开新标签/空白，不恢复
      obj.restore_on_startup = 0;
      fs.writeFileSync(pref, JSON.stringify(obj));
    }
  } catch (e) { /* Preferences 格式异常就不改，交给上面的删文件兜底 */ }
}

/** 本模块 spawn 出来的所有 Chrome 子进程，退出时统一清理（C 方案不再由 puppeteer 托管浏览器） */
const spawnedChildren = new Set();

/** 账号 → CDP 配置文件名（如 WA-PC01-CDP）。config 里可写 account.cdpProfile 覆盖。 */
function cdpProfileName(account, cfg) {
  if (account && account.cdpProfile) return String(account.cdpProfile);
  const n = String((account && account.id) || 0).padStart(2, '0');
  return `WA-PC${n}-CDP`;
}

/** 账号 → CDP 调试端口。config 可写 account.cdpPort 或 browser.cdpBasePort 覆盖。 */
function cdpPort(account, cfg) {
  if (account && account.cdpPort) return Number(account.cdpPort);
  const base = (cfg && cfg.browser && cfg.browser.cdpBasePort) ? Number(cfg.browser.cdpBasePort) : 9222;
  return base + (Number((account && account.id) || 1) - 1);
}

function killChrome(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch (e) { /* 已退出 */ }
  try { spawnedChildren.delete(child); } catch (e) {}
}

/** 退出时统一杀掉所有由本模块拉起的 Chrome 子进程（C 方案必须，否则留孤儿进程） */
function shutdownAll() {
  for (const child of spawnedChildren) killChrome(child);
  spawnedChildren.clear();
  // v2.5.1074：连同本地中转代理一起关掉，避免留下孤儿监听端口
  try { require('./proxyRelay').closeAll().catch(() => {}); } catch (e) {}
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.setTimeout(1000, () => req.destroy(new Error('timeout')));
  });
}

/** 轮询 Chrome 调试端口，直到 /json/version 返回 200（最多 timeoutMs） */
async function waitForDebugger(port, timeoutMs = 20000) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await httpGet(url) === 200) return; } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Chrome 调试端口 ${port} 在 ${timeoutMs}ms 内未就绪（Chrome 可能没起来，或该端口被占用）`);
}

/** 把「账号 → CDP 端点」写进 data 目录的 cdp-profiles.json，方便外部脚本直连 */
function writeCdpRegistry(account, profile, port) {
  try {
    const base = require('./runtime').dataBase();
    const file = path.join(base, 'cdp-profiles.json');
    let reg = {};
    try { reg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
    reg[String(account.id)] = {
      label: account.label || '',
      profile,
      port,
      debuggerUrl: `http://127.0.0.1:${port}`,
    };
    fs.writeFileSync(file, JSON.stringify(reg, null, 2));
  } catch (e) { /* 注册表写失败不影响主流程 */ }
}

async function launchBrowser(account, cfg, sessionDir) {
  // v2.5.10020：优先用「代理」页里给这个实例单独配的代理；没配就退回 accounts[].proxy
  // 🔴 v2.6.1120 两处修正：
  //   ① key 推导错了。旧代码 `'wa' + account.id` → Tele①(id=7) 算成 `wa7`（tg1 配置从来接不上）、
  //      一号(id=1) 算成 `wa1`（误撞 WA① 内置浏览器的配置）。现改用 proxies.keyForAccount()：
  //      TG 采集账号按 cdpProfile(TG-PCn-CDP) → tg1~tg3；WA 外部 Chrome（一号~五号）返回 null，
  //      继续走 config.yaml 的 account.proxy，与 WA① 内置浏览器彻底隔开。
  //   ② 「只有 socks 带账密才中转」是错的。Chromium 的 `--proxy-server` 与 `proxyRules`
  //      **都不认 `user:pass@`**（账密被静默丢弃），所以 http/https 带账密也照样连不上。
  //      现改为：只要「代理」页给这个实例启用了代理，**一律先起本地 gost 无密码中转**，
  //      Chrome 只看到 127.0.0.1:port；中转起不来就退回 account.proxy / 直连，绝不把带账密的串给内核。
  let proxyUrl = account.proxy;
  try {
    const proxies = require('./proxies');
    const proxyRelay = require('./proxyRelay');
    const key = proxies.keyForAccount(account);
    if (key && proxies.get(key) && proxies.get(key).enabled) {
      let rec = null;
      try {
        rec = await proxyRelay.getRelay(key);
      } catch (e) {
        console.warn(`[session] ${key} 本地中转出错：${e && (e.message || e)}`);
      }
      if (rec) {
        proxyUrl = rec.localUrl;
      } else {
        console.warn(`[session] ${key} 本地中转不可用 → 退回 account.proxy / 直连（绝不把带账密的上游串给 Chromium）`);
        proxyUrl = account.proxy;
      }
    }
  } catch (e) { /* 代理模块不可用就忽略，走 account.proxy */ }
  const { url, auth } = splitProxy(proxyUrl);

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled', // 关键：去掉自动化标记
    '--no-first-run',                  // 跳过首次运行向导，避免弹"欢迎"页
    '--no-default-browser-check',     // 不弹"设为默认浏览器"
    `--lang=${account.locale || 'en-US'}`,
    `--accept-lang=${account.locale || 'en-US'},en`,
    `--timezone=${account.timezone || 'America/Chicago'}`,
    '--window-size=1280,860',
  ];

  if (url) args.push(`--proxy-server=${url}`);
  if (cfg.browser?.windowPosition) args.push(`--window-position=${cfg.browser.windowPosition}`);

  // C 方案（2026-10-09）：每个账号独立 Chrome 进程 + 独立 user-data-dir（WA-PCnn-CDP）。
  // 之前方案B 是把 profile 塞在 sessions/chrome-acc-{id}；现在直接落到 data/WA-PCnn-CDP，
  // 与用户建的文件夹一致，且每个号 --remote-debugging-port 独立，外部可 CDP 直连。
  const profileName = cdpProfileName(account, cfg);
  const port = cdpPort(account, cfg);
  const userDataDir = path.join(require('./runtime').dataBase(), profileName);
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (e) {}
  // 清掉上次异常退出可能残留的锁文件，避免 "user data directory is already in use"
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(userDataDir, lock)); } catch (e) {}
  }
  // 清掉 Chrome 自带的"会话恢复"痕迹：否则固定 userDataDir 会让它每次自动重开上次标签页，
  // 和我们自己的快照恢复叠在一起就变成"重复标签页"。cookie / 登录态不在这里清，照旧保留。
  clearChromeSessionRestore(userDataDir);

  // Chrome 可执行文件：config 写死 → browserPath 兜底链（本机 Chrome/Edge → Puppeteer 缓存）
  // 🔴 v2.5.1064：改用 resolveStandardExecutable，让 WhatsApp 也优先用系统标准版浏览器，
  //    避免拉起 Puppeteer 自带的 Chrome for Testing（v146）弹 "Chrome for Testing ... is only
  //    for automated testing" 提示。Telegram 早就这么干了（见 launcher.js），WA 之前漏了。
  //    登录态在软件自己的 WA-PCnn-CDP userDataDir 里，换二进制不丢登录。
  const chromePath = cfg.browser?.executablePath
    ? cfg.browser.executablePath
    : require('./browserPath').resolveStandardExecutable({});
  if (!chromePath) {
    throw new Error('找不到 Chrome 可执行文件：请在 config.yaml 的 browser.executablePath 指定，或安装 Chrome/Edge');
  }

  // 在 args 里加上 CDP 调试端口与绑定地址（其余启动参数沿用上面的 args）
  args.push(`--remote-debugging-port=${port}`);
  args.push('--remote-debugging-address=127.0.0.1'); // 只绑本地，不暴露到局域网
  args.push(`--user-data-dir=${userDataDir}`);
  if (cfg.browser?.headless === true) args.push('--headless=new');

  // 外部拉起 Chrome（自己管的子进程），再用 puppeteer.connect 接上
  console.log(`[session] 外部拉起 Chrome（${profileName}）：port=${port} userDataDir=${userDataDir}`);
  const child = spawn(chromePath, args, { stdio: 'ignore' });
  child.on('error', (e) => console.error(`[session] Chrome 启动失败（${profileName}）：`, e.message));
  child.on('exit', (code) => console.warn(`[session] Chrome 退出（${profileName}）：code=${code}`));
  spawnedChildren.add(child);

  await waitForDebugger(port);

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null, // 保留 --window-size，不被 puppeteer 改 viewport
  });
  // 挂上子进程引用，断开时主动杀掉，避免孤儿进程
  browser.__chromeChild = child;
  browser.on('disconnected', () => killChrome(child));

  writeCdpRegistry(account, profileName, port);

  // 代理需要账密时，对每个新开的页面做认证
  if (auth) {
    const attach = async (target) => {
      if (target.type() !== 'page') return;
      const page = await target.page().catch(() => null);
      if (page && !page.__authed) {
        page.__authed = true;
        await page.authenticate(auth).catch(() => {});
      }
    };
    browser.on('targetcreated', attach);
    for (const p of await browser.pages()) await p.authenticate(auth).catch(() => {});
  }

  return browser;
}

// 恢复 / 记录「用户手动开的其他标签页」：关掉浏览器再重开时，像普通浏览器一样把用户自己开的网页也带回来。
// 不含 WhatsApp（它由 wwebjs 接管）；也不走 Chrome 的 --restore-last-session（否则会多出一个旧 WhatsApp 标签页与 wwebjs 冲突）。
// 恢复的是 URL 级快照，登录态靠 userDataDir 里的 cookie 保持，和普通浏览器的「恢复标签页」一致；未提交的表单救不回（进程级状态无法持久化）。
async function restoreOpenTabs(browser, tabsFile) {
  let urls = [];
  try { urls = JSON.parse(fs.readFileSync(tabsFile, 'utf8')); } catch (e) { return; }
  if (!Array.isArray(urls) || !urls.length) return;

  // 先拿到浏览器当前已经开着的页面（含 Chrome 万一恢复出来的、或 wwebjs 的 WhatsApp），
  // 去重比对——已经开着的网址绝不重复开，杜绝"重复标签页"。
  const opened = new Set();
  try {
    for (const p of await browser.pages()) {
      const u = (p.url() || '').trim();
      if (u) opened.add(normalizeUrl(u));
    }
  } catch (e) { /* 取不到就当没开过，照常尝试打开 */ }

  for (const u of urls) {
    if (!u || u.includes('web.whatsapp.com') || u.startsWith('about:') ||
        u.startsWith('chrome://') || u.startsWith('chrome-extension://')) continue;
    const key = normalizeUrl(u);
    if (opened.has(key)) continue; // 已经开着，不要重复开
    try {
      const p = await browser.newPage();
      await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      opened.add(key); // 标记已开，后续同网址也不会再开
    } catch (e) { /* 单个标签页打开失败不影响其他 */ }
  }
}

function startTabPersistence(browser, tabsFile) {
  let timer = null;
  const persist = async () => {
    try {
      if (!browser.isConnected()) return; // 关窗时不更新，保留关窗前最后一次快照
      const pages = await browser.pages();
      const urls = pages.map(p => { try { return p.url(); } catch (e) { return ''; } })
        .filter(u => u && !u.includes('web.whatsapp.com') &&
          !u.startsWith('about:') && !u.startsWith('chrome://') &&
          !u.startsWith('chrome-extension://'));
      fs.writeFileSync(tabsFile, JSON.stringify(urls));
    } catch (e) {}
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(persist, 800); };
  browser.on('targetcreated', schedule);
  browser.on('targetdestroyed', schedule);
  const iv = setInterval(() => { if (browser.isConnected()) persist(); }, 5000);
  browser.on('disconnected', () => { if (timer) clearTimeout(timer); clearInterval(iv); });
}

// Chrome 各版本 / 各 profile 给的「空白新标签页」URL 形态不一样。只判 about:blank 会漏掉真家伙。
//🔴 v2.6.1117（老板实机截图指认）：Chrome 155 真实给的是 chrome://new-tab-page/（带连字符），
//    老代码只认 'about:blank' 与 ''，所以每个号开出来都多一张 New Tab 标签页（老板图里红框那张）。
//    这里把三种形态一次补齐：new-tab-page / newtab / 空串。about:blank 仍保留（无头/命令行启动常见）。
const BLANK_PAGE_URLS = new Set([
  '',
  'about:blank',
  'about:blank#blocked',
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'chrome://new-tab-page-third-party/',
  'chrome-search://local-ntp/most-visited',
]);

/** 这一页是不是「空白新标签页」（Chrome 启动自带那张，用户不想看到的那张）。 */
function isBlankPage(page) {
  let u = '';
  try { u = (page.url() || '').trim().toLowerCase(); } catch (e) { return false; }
  if (BLANK_PAGE_URLS.has(u)) return true;
  // 新版偶尔带查询串/哈希（如 chrome://new-tab-page/?foo），前缀命中也算
  return u.startsWith('chrome://new-tab-page') || u.startsWith('chrome://newtab');
}

// puppeteer 启动浏览器时会自带一张空白新标签页（page 0），它会一直挂在浏览器里、
// 被用户当成"多出来的一张标签页"。这里在 wwebjs 接管前把它关掉，让重开后的标签页列表干干净净。
// 🔴 keepPage：TG侧我们自己 newPage()出来的那张要留着（它已经 goto 到 Telegram），不能被当成空白页误关。
async function closeStrayPages(browser, keepPage) {
  try {
    const pages = await browser.pages();
    for (const p of pages) {
      if (keepPage && (p === keepPage)) continue;
      if (!isBlankPage(p)) continue;
      await p.close().catch(() => {});
    }
  } catch (e) { /* 不影响主流程 */ }
}

// wwebjs 接管浏览器时会新开一张页面放 WhatsApp（Client.js:450 的 browser.newPage()），
// 如果用户此前手动开的 WhatsApp 被恢复、或残留了多张，这里只保留最后一张、关掉其余，
// 彻底杜绝"重开后出现两个 WhatsApp 标签页"的情况。
async function dedupeWhatsApp(browser) {
  try {
    const pages = await browser.pages();
    const wa = pages.filter(p => (p.url() || '').includes('web.whatsapp.com'));
    if (wa.length > 1) {
      for (let i = 0; i < wa.length - 1; i++) await wa[i].close().catch(() => {});
    }
  } catch (e) { /* 不影响主流程 */ }
}

/**
 * 启动一个账号
 * @param {object} account config.yaml 里的账号配置
 * @param {object} cfg 全局配置
 * @param {object} handlers { onQR, onReady, onMessage, onDisconnected, onError }
 */
async function createSession(account, cfg, handlers = {}) {
  // 会话目录：Config 里写成绝对路径就按绝对路径走；否则相对「用户数据目录」
  // （开发=项目根，打包=可写目录 —— 不能落在只读的程序安装目录里）
  const base = require('./runtime').dataBase();
  const sessionDir = path.resolve(base, cfg.browser?.sessionDir || './sessions');
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const browser = await launchBrowser(account, cfg, sessionDir);

  // 先恢复用户上次手动开的其他标签页（基于本软件自己的去重快照；已开着的网址不会再开），
  // 之后运行期持续记录用户新开/关闭的标签页，关窗时保留最后一次快照
  const tabsFile = path.join(sessionDir, 'tabs-acc-' + account.id + '.json');
  await restoreOpenTabs(browser, tabsFile);
  startTabPersistence(browser, tabsFile);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `acc-${account.id}`, dataPath: sessionDir }),
    puppeteer: { browserWSEndpoint: browser.wsEndpoint() },
    // 历史消息同步：首次登录时能拉到更早的对话
    restartOnAuthFail: true,
  });

  client.on('qr', (qr) => {
    console.log(`[账号${account.id}] 需要扫码登录`);
    handlers.onQR?.(account, qr);
  });

  client.on('ready', () => {
    console.log(`[账号${account.id}] 就绪`);
    handlers.onReady?.(account, client);
  });

  client.on('authenticated', () => console.log(`[账号${account.id}] 认证成功`));
  client.on('auth_failure', (m) => console.error(`[账号${account.id}] 认证失败：${m}`));
  client.on('disconnected', (r) => {
    console.warn(`[账号${account.id}] 断开：${r}`);
    handlers.onDisconnected?.(account, r);
  });

  // message_create 覆盖双向消息（含自己发出的），这样才能自动判断"已回复"
  client.on('message_create', (msg) => {
    handlers.onMessage?.(account, client, msg);
  });

  client.on('error', (err) => handlers.onError?.(account, err));

  await client.initialize();
  // 收掉启动自带的空白 about:blank（此时 WhatsApp 已开，浏览器不会因"0 个页面"自动退出）；
  // 再兜底确保 WhatsApp 只有一张，杜绝"重开出现两个 WhatsApp 标签页"。
  await closeStrayPages(browser);
  await dedupeWhatsApp(browser);
  return { client, browser };
}

module.exports = { createSession, launchBrowser, splitProxy, shutdownAll, cdpProfileName, cdpPort, closeStrayPages, isBlankPage };
