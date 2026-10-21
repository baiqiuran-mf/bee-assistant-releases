/**
 * 主入口
 *
 * 链路：监听新消息 → 入库 → 翻译 → 更新客户档案文档 → 推给界面 → 你本人手动发送。
 *
 * 硬边界：这个文件里没有任何发送相关的调用。要发消息，你自己打开 WhatsApp 打。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const paths = require('./paths');
const crypto = require('crypto');
const configWrite = require('./configWrite');

/* ---------------- 配置 ---------------- */

function loadConfig() {
  const file = paths.configFile(); // 打包后读用户目录那份（程序目录是只读的）
  if (!fs.existsSync(file)) throw new Error('找不到 config.yaml：' + file);
  let yaml;
  try {
    yaml = require('js-yaml');
  } catch (e) {
    yaml = require('./yaml-lite');
  }
  return yaml.load(fs.readFileSync(file, 'utf8')) || {};
}

const cfg = loadConfig();

// 2026-10-13：telegram 段可能整段缺失（老配置 / 新装的）。启动时补默认 3 个账号
// （Tele① 默认启用），并回写 config.yaml，否则 TELEGRAM_ACCS 会空 → 采集循环 early-return、界面"未检测"。
function ensureTelegramConfig() {
  try {
    const p = paths.configFile();
    if (!fs.existsSync(p)) return;
    let text = fs.readFileSync(p, 'utf8');
    const t = (cfg.telegram = cfg.telegram || {});
    if (t.apiId) {
      const r = configWrite.setScalar(text, ['telegram', 'apiId'], t.apiId);
      if (r.changed) text = r.text;
    }
    if (t.apiHash) {
      const r = configWrite.setScalar(text, ['telegram', 'apiHash'], t.apiHash);
      if (r.changed) text = r.text;
    }
    if (!Array.isArray(t.accounts) || !t.accounts.length) {
      const r = configWrite.ensureTelegramAccounts(text, configWrite.defaultTelegramAccounts());
      if (r.changed) {
        text = r.text;
        cfg.telegram.accounts = configWrite.defaultTelegramAccounts();
      }
    }
    fs.writeFileSync(p, text, 'utf8');
  } catch (e) {
    console.warn('ensureTelegramConfig 失败（不影响其他功能）：', e && e.message);
  }
}
ensureTelegramConfig();

/* ---------------- 浏览器插件（网页版 WhatsApp 抓图）连接令牌 ----------------
 * 首次启动生成一把随机令牌，写进 config.yaml 的 app.waWebToken（绝不写死常量）。
 * 软件「⚙ 设置 → 网页插件」里能看到并复制给扩展用；扩展每次 POST 都要带它，
 * 否则服务端返回 401。令牌只用来认证「本机浏览器扩展 → 本机软件」这条 loopback 通道。 */
function ensureWaWebToken() {
  try {
    if (cfg.app && cfg.app.waWebToken) return cfg.app.waWebToken;
    const token = crypto.randomBytes(32).toString('hex');
    const p = paths.configFile();
    const text = fs.readFileSync(p, 'utf8');
    // 🔴 setScalar 返回的是 {text, changed, inserted}，不是字符串——必须取 .text 再写盘，
    //    否则 writeFileSync 收到对象会抛错，令牌只存在内存里 → 软件每次重启令牌都变，
    //    插件里存的旧令牌立刻失效（2026-10-09 修）。
    const r = configWrite.setScalar(text, ['app', 'waWebToken'], token);
    fs.writeFileSync(p, r.text, 'utf8');
    cfg.app = cfg.app || {};
    cfg.app.waWebToken = token;
    console.log('[wa-web] 已生成插件连接令牌并写入 config.yaml');
    return token;
  } catch (e) {
    console.warn('[wa-web] 令牌持久化失败（改用内存令牌，重启失效）：', e.message);
    cfg.app = cfg.app || {};
    if (!cfg.app.waWebToken) cfg.app.waWebToken = crypto.randomBytes(32).toString('hex');
    return cfg.app.waWebToken;
  }
}

const db = require('./db');
const doc = require('./customerDoc');
const ai = require('./ai');
const knowledge = require('./knowledge');
const translator = require('./translator');
const media = require('./media');
const mediaFetch = require('./mediaFetch');
const mediaRaw = require('./mediaRaw');
const shrink = require('./imageShrink');
const wordDoc = require('./wordDoc');
const update = require('./update');
const signalStatus = require('./signalStatus');
const signalRead = require('./signalRead');
const telegramRead = require('./telegramRead');
const telegramMtproto = require('./telegramMtproto'); // v2.5.1053：MTProto 协议层读取（替代 web 爬虫）
const telegramWebView = require('./telegramWebView'); // v2.5.1056：从内置浏览器（Tele① 页签的 webview）读取，不依赖凭证
const telegramChannel = require('./telegramChannel'); // A/B 双通道开关（构建期 BEE_TG_CHANNEL 决定）
const telegramOfficialChannel = require('./telegramOfficialChannel'); // 【A 版专用】MTProto 官方直连
const telegramLogin = require('./telegramLogin');   // v2.5.1054：应用内 Telegram 登录弹窗控制器
const launcher = require('./launcher');
const signalJump = require('./signalJump');   // v2.5.1032：Signal「跳到聊天」CDP 辅助注入
const prewarm = require('./prewarm');         // v2.5.1036：预热总闸 + 互斥闸门（扫描节奏）
const loopBeat = require('./loops');          // v2.5.1039：循环①/②（3 秒节拍 · 老板拍板）
const identity = require('./identity');
const profileScan = require('./profileScan');
const cloud = require('./cloud');
const { pickImTab, selectImTab } = require('./jumpTab'); // v2.5.1061：跳转时检测 IM 标签 + 自动选中
const { setSilence, isSilent } = require('./silence'); // v2.5.1069：跳转真置顶期间 3 秒静默锁
const { createServer } = require('./server');

ai.setAiConfig(cfg.ai || {});
knowledge.setKnowledgeConfig(cfg.knowledge || {});

// 数据根目录由 src/paths.js 统一解析：环境变量 BEE_DATA_DIR > config.app.dataDir > 默认 data/
const DATA_ROOT = paths.DATA_ROOT;
const MEDIA_DIR = paths.mediaDir();

const PORT = Number(cfg.app?.port || 8787);
const HISTORY_CHATS = 30; // 首次登录后同步的对话数
const HISTORY_MSGS = 50;  // 每个对话同步多少条

/* ================================================================
 * 原始消息登记表（2026-10-07 v1.1.0「延时重抓」用）
 *
 * 键：`<accountId>|<waMsgId>`。值：{ msg, client }。
 * 只放内存、不写库 —— 这些对象是活的 whatsapp-web.js Message，
 * 序列化到数据库没有意义（也不可能），重启后靠历史同步重新登记。
 *
 * 上限 300 条：再多也没用，重抓只针对刚到的消息。
 */
const msgRegistry = new Map();
const MSG_REGISTRY_MAX = 300;

function rememberMsg(accountId, waMsgId, msg, client) {
  const key = `${accountId}|${waMsgId}`;
  msgRegistry.set(key, { msg, client: client || null, at: Date.now() });
  if (msgRegistry.size > MSG_REGISTRY_MAX) {
    // Map 保插入序，挨个删最早的
    const drop = msgRegistry.size - MSG_REGISTRY_MAX;
    let n = 0;
    for (const k of msgRegistry.keys()) {
      msgRegistry.delete(k);
      if (++n >= drop) break;
    }
  }
}

function recallMsg(accountId, waMsgId) {
  if (!waMsgId) return null;
  return msgRegistry.get(`${accountId}|${waMsgId}`) || null;
}

/** 当前实际监听的端口（配置那个端口被占用时会自动换一个空闲端口） */
let activePort = PORT;

/**
 * 绑定端口，返回实际监听到的端口号。
 *
 * 端口被占用时（上一次的实例没退干净、或 8787 被别的软件占了）**自动换一个系统分配的空闲端口**，
 * 而不是抛 EADDRINUSE 把整个启动流程打断 —— 桌面窗口必须能打开，端口只是细节。
 *
 * 重要：整个进程里只允许对同一个 server 调用一次 listen。
 * 已经 listen 过的 server 再 listen 会立刻抛 ERR_SERVER_ALREADY_LISTEN，
 * 调用方（electron/main.js）拿到 startCore 返回的 srv 时它【已经在监听】了，不要再 listen。
 */
function listenOn(server, port, allowFallback = true) {
  const bind = (p) => new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(p, '127.0.0.1');
  });
  return bind(port)
    .then(() => server.address().port)
    .catch(async (e) => {
      if (!allowFallback || (e.code !== 'EADDRINUSE' && e.code !== 'EACCES')) throw e;
      console.warn(`端口 ${port} 被占用（${e.code}），自动改用空闲端口`);
      await bind(0);
      return server.address().port;
    });
}

/* ---------------- 账号状态 ---------------- */

const accountStates = new Map();
for (const a of cfg.accounts || []) {
  accountStates.set(a.id, { ...a, status: 'offline' });
  db.upsertAccount.run({ id: a.id, label: a.label || '', phone: a.phone || '', proxy: a.proxy || '' });
}

// 顶栏账号条只返回 WhatsApp 账号（cfg.accounts = 1~5）。
// Signal(6) / Telegram(7/8/9) 不再进顶栏（2026-10-11 老板：顶栏只显示一号~五号；
// Tele①②③ 已并入一号/二号/三号，点对应 WA 号时由 openLinkedTelegram 顺手开它的网页版）。
function getAccountStates() {
  return (cfg.accounts || []).map((a) => accountStates.get(a.id)).filter(Boolean);
}

/* =====================================================================
 * Signal 账号（2026-10-08 v1.5.0 · 真正开始采 Signal 消息）
 *
 * 🔴 为什么占 account_id = 6：
 *   config.yaml 里 accounts 是 1~5（五个 WhatsApp 号），6 号位空着。
 *   而 src/ids.js 的 nextCustomerCode 只接受账号号 1~9、且 CODE_RE 只匹配
 *   **一位数字**（/^([1-9])([A-Z])(\d{5})$/）—— 如果这里填 99，
 *   建客户那一步会直接抛「无法解析已有编号 / 账号号非法」。
 *   改 ids.js 去支持两位数属于动核心编号逻辑，风险不值当。
 *   所以用 6，编号形如 6A00001，一眼能看出是 Signal 客户。
 *
 * 渠道另存 channel='signal'：判"是不是 Signal 客户"以 channel 为准，
 * account_id=6 只是兜底（前端 isSignalCustomer 两个都判）。
 */
const SIGNAL_ACC = { id: 6, label: 'Signal', phone: '', proxy: '' };
accountStates.set(SIGNAL_ACC.id, { ...SIGNAL_ACC, status: 'offline', channel: 'signal' });
db.upsertAccount.run({ id: SIGNAL_ACC.id, label: SIGNAL_ACC.label, phone: '', proxy: '' });
/*
 * 🔴 upsertAccount 只写 id/label/phone/proxy，channel 会落回建表默认值 'whatsapp'。
 *    这里显式补一次 —— 账号表的 channel 也得如实标上，
 *    将来做按渠道过滤（比如"只显示 Signal 的客户"）时才不会把它当 WhatsApp。
 */
try {
  db.db.prepare('UPDATE accounts SET channel=? WHERE id=?').run('signal', SIGNAL_ACC.id);
} catch (e) {
  /* 老库没有 channel 列时忽略：客户表的 channel 已经是对的，判据不依赖它 */
}

/* =====================================================================
 * Telegram 账号（2026-10-11 v2.5.1029 · 网页版抓取，仿 WA 外跑 Chrome）
 *
 * 🔴 占 account_id = 7 / 8 / 9（1~5 是五个 WhatsApp，6 是 Signal）。
 *   同样受 nextCustomerCode 只接受 1~9、CODE_RE 只匹配一位数字的限制，所以走 7/8/9，
 *   编号形如 7A00001 —— 一眼能看出是 Telegram 客户。
 *   渠道另存 channel='telegram'：判「是不是 Telegram 客户」以 channel 为准，account_id 兜底。
 *
 * 配置在 config.yaml 的 telegram.accounts（id/label/enabled/cdpProfile/cdpPort/waAccount）。
 * 每个 Tele 账号通过 waAccount 字段挂到某个 WA 号（Tele①=7→一号=1，Tele②=8→二号=2，Tele③=9→三号=3），
 * 不再单独进顶栏账号条；点对应 WA 号时由 openLinkedTelegram 顺手开它的 web.telegram.org 浏览器。
 * 采集侧（startTelegramWatching）仍按 7/8/9 跑，消息进左栏（∮∯∰ 标记，保留）。
 */
const TELEGRAM_ACCS = (cfg.telegram && Array.isArray(cfg.telegram.accounts))
  ? cfg.telegram.accounts.map((a) => ({
      id: Number(a.id),
      label: a.label || `Tele${a.id}`,
      waAccount: Number(a.waAccount) || 0, // 并入哪个 WA 号（1/2/3）；点该 WA 号时顺手开它的网页版
      enabled: a.enabled !== false,
      proxy: a.proxy || '',
      channel: 'telegram',
      cdpProfile: a.cdpProfile || `TG-PC${(Number(a.id) - 6)}-CDP`,
      cdpPort: a.cdpPort || (9244 + (Number(a.id) - 7)),
    }))
  : [];
for (const tg of TELEGRAM_ACCS) {
  accountStates.set(tg.id, { ...tg, status: 'offline' });
  db.upsertAccount.run({ id: tg.id, label: tg.label, phone: '', proxy: tg.proxy || '' });
  try {
    db.db.prepare('UPDATE accounts SET channel=? WHERE id=?').run('telegram', tg.id);
  } catch (e) { /* 老库无 channel 列时忽略 */ }
}

/* 正在跑的账号（浏览器实例）。界面上点「浏览器」就是查这里：
   没跑就启动，跑了就把那个 Chrome 窗口拉到前台。 */
const runningSessions = new Map();

/* 每个账号"上一次启动失败"的真实报错：界面要显示具体原因，而不是笼统的"异常" */
const startErrors = new Map();

/* 启动锁：把多个账号的浏览器启动串行化。
   原因：多个账号若被快速连点，会瞬间拉起好几个重型 Chrome + WhatsApp 会话，
   极易被机器资源打挂（后面的直接抛异常、界面只报"异常"）。排队后前一个就绪再开下一个，稳。 */
let launchChain = Promise.resolve();
async function withLaunchLock(fn) {
  const prev = launchChain;
  const next = (async () => { try { await prev; } catch (_) { /* 前一个失败不影响下一个 */ } return fn(); })();
  launchChain = next.catch(() => {});
  return next;
}

/* ---------------- 把 Chrome 窗口搬到桌面上 ----------------
 *
 * 背景：config.yaml 里 browser.windowPosition 是 -3000,-3000，故意把 Chrome 挪到屏幕外，
 * 免得一开软件就满屏浏览器。但用户点账号名就是想看它（要扫码），所以必须搬回屏幕里。
 *
 * 2026-09-25 修的两个问题（用户反馈「五号浏览器打开异常，无法自动显示在桌面」）：
 *   1) 五个账号的窗口全被搬到同一个坐标 (60,60) —— 后开的那个被前面几个**完全盖住**，
 *      看起来就像"没打开"。现在按账号号级联错开，并且夹进屏幕工作区，保证不出屏。
 *   2) 原来只试一次、失败就把窗口留在屏幕外，而且只 console.warn。
 *      浏览器刚启动那一瞬间还没有页面（pages 为空），必然失败 → 窗口永远在屏外。
 *      现在最多试 12 次（约 6 秒），并且把失败原因回传给界面，不静默。
 */

/** 桌面可用区域（electron/main.js 用 screen.getPrimaryDisplay().workAreaSize 传进来） */
let screenArea = { width: 1920, height: 1040 };

/** 按账号号算出这个 Chrome 窗口该放哪：级联错开 + 夹进屏幕，保证看得见 */
function windowBoundsFor(slot) {
  const W = 1120;
  const H = 820;
  const s = Math.max(1, Number(slot) || 1);
  const maxLeft = Math.max(0, (screenArea.width || 1920) - W);
  const maxTop = Math.max(0, (screenArea.height || 1040) - H);
  const left = Math.max(0, Math.min(60 + (s - 1) * 46, maxLeft));
  const top = Math.max(0, Math.min(48 + (s - 1) * 38, maxTop));
  return { left, top, width: W, height: H };
}

/**
 * 把这个账号的 Chrome 窗口从屏幕外搬回屏幕里并置顶。
 * @param {object} browser puppeteer 的 Browser
 * @param {number} slot 账号号（1~5），用来越开越往右下错开，避免几个窗口叠在一起
 * @returns {Promise<{ok:boolean, left?:number, top?:number, windowId?:number, error?:string}>}
 */
async function revealBrowser(browser, slot = 1, urlRe = null) {
  if (!browser) return { ok: false, error: '浏览器还没起来' };
  const bounds = windowBoundsFor(slot);
  let lastErr = null;

  for (let i = 0; i < 12; i++) {
    try {
      const pages = await browser.pages();
      if (!pages.length) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      // v2.5.1077：优先挑中目标 IM 标签（按 URL 正则），避免把黑屏/空白标签顶到前台
      // —— 这正是「跳转出现黑屏窗口」的根因：之前挑的是「第一个非空白标签」，
      //    若那个标签是空白/黑屏页，窗口就被搬出来显示黑屏。
      const page = (urlRe && pages.find((p) => urlRe.test(p.url() || '')))
        || pages.find((p) => !/^about:/.test(p.url() || ''))
        || pages[pages.length - 1];
      // 先把目标标签激活到最前，再搬窗口——顺序反了会先露出黑屏标签
      await page.bringToFront().catch(() => {});
      const cdp = await page.target().createCDPSession();
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { ...bounds, windowState: 'normal' },
      });
      await cdp.detach().catch(() => {});
      return { ok: true, ...bounds, windowId };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { ok: false, error: (lastErr && lastErr.message) || '浏览器一直没给出可操作的窗口' };
}

/** 把"窗口搬回桌面"的结果说成人话，失败时明确告诉用户怎么办 */
function revealFailed(accountId, rv) {
  notice(
    `账号${accountId} 的浏览器窗口没能自动搬到桌面（${rv.error}）—— 在屏幕下面的任务栏里点一下 Chrome 就能看到它`,
    'warn',
  );
}

/** 点某个 WA 号时，顺手把它挂的 Telegram 网页版（config.yaml telegram.waAccount 指向本号）也开起来。
 *  2026-10-11 老板：Tele①②③ 已并入一号/二号/三号，点一号就同时开 WhatsApp + Telegram 网页版。
 *  不阻塞 WA 本身的返回：失败只记日志，不影响 WA 窗口。 */
async function openLinkedTelegram(waId) {
  const linked = TELEGRAM_ACCS.find((t) => t.waAccount === waId && t.enabled);
  if (!linked) return;
  const wb = await waBrowserFor(linked);
  telegramRead.openOrFocus(linked, cfg, wb).catch((e) =>
    console.warn(`[账号${waId}] 关联 Telegram ${linked.id} 打开失败：${(e && e.message) || e}`));
}

/** 界面上点某账号的「浏览器」按钮（或账号名）：没开就开，开了就拉到前台 */
async function openAccount(accountId) {
  const id = Number(accountId);
  const acc = (cfg.accounts || []).find((a) => a.id === id);
  if (!acc) return { ok: false, error: `没有账号 ${id}` };

  // 点 WA 号时，顺手把这个号挂的 Telegram 网页版也开起来（2026-10-11 老板：一号不只开 WhatsApp，还要开 Telegram 网页版）
  openLinkedTelegram(id);

  // 先看这个账号的浏览器是不是还活着：用户手动关掉 Chrome 窗口后，进程已经死了，
  // 但 runningSessions 里还留着一条带"死" browser 的记录。这种不能再去 reveal 一个
  // 已断开的浏览器（会 12 次重试全失败、看起来像"点没反应"），要先清掉旧记录重新拉起。
  const existing = runningSessions.get(id);
  const browserAlive =
    existing && existing.browser &&
    typeof existing.browser.isConnected === 'function' &&
    existing.browser.isConnected();
  if (existing && browserAlive) {
    const rv = await revealBrowser(existing.browser, id);
    if (!rv.ok) revealFailed(id, rv);
    return {
      ok: true,
      action: 'focused',
      id,
      revealed: rv.ok,
      window: rv.ok ? { left: rv.left, top: rv.top } : null,
      revealError: rv.ok ? null : rv.error,
    };
  }
  if (existing && !browserAlive) {
    console.warn(`[账号${id}] 上次的浏览器已被关闭，这次重新拉起`);
    runningSessions.delete(id);
  }

  if (!acc.enabled) {
    notice(`账号${id} 在 config.yaml 里是关闭的（enabled: false），这次先临时跑起来；重启软件又会回到关闭`, 'warn');
  }

  const s = await startSession(acc);
  // 启动失败要说清楚（以前这里会"假成功"地返回 ok:true，用户点五号看到的就像没反应）；
  // 现在把 createSession 抛出的真实错误透传给界面，方便定位，而不是笼统报"异常"
  if (!s) {
    const errMsg = lastStartError(id) || `账号${id} 浏览器启动失败（可能是这个号没装 Chrome / 被别的进程占着 / 网络或代理不通）`;
    notice(`账号${id} 的浏览器没能启动起来 —— ${errMsg}`, 'error');
    return {
      ok: false,
      error: errMsg,
    };
  }

  // 浏览器窗口默认在屏幕外，先搬回屏幕里（按账号号错开），用户才能扫码
  const rv = await revealBrowser(s.browser, id);
  if (!rv.ok) revealFailed(id, rv);

  let status = accountStates.get(id)?.status || 'offline';
  // 启动是异步的（浏览器要几十秒才起来），等它把状态亮出来
  for (let i = 0; i < 24 && status === 'offline'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    status = accountStates.get(id)?.status || 'offline';
  }
  return {
    ok: true,
    action: 'started',
    id,
    status,
    revealed: rv.ok,
    window: rv.ok ? { left: rv.left, top: rv.top } : null,
    revealError: rv.ok ? null : rv.error,
  };
}

/** 启动失败时的真实报错（带具体原因，界面能直接显示） */
function lastStartError(id) {
  return startErrors.get(Number(id)) || null;
}

/** 找到可操作的 WhatsApp 网页版标签页：优先该账号自己的浏览器，其次任意已开着的账号。
 *  （以前只认 accountId 那一个会话，客户归属的号没在跑就直接失败、退回剪贴板 ——
 *   用户 2026-09-28 的要求是「能送到最前面那个 WhatsApp 对话里就行」，所以这里放宽。） */
async function findWhatsappPage(accountId) {
  const id = Number(accountId);
  const cands = [];
  if (runningSessions && runningSessions.get) {
    const own = runningSessions.get(id);
    if (own && own.browser) cands.push([id, own.browser]);
    for (const [aid, s] of runningSessions) {
      if (aid !== id && s && s.browser) cands.push([aid, s.browser]);
    }
  }
  for (const [aid, browser] of cands) {
    try {
      const pages = await browser.pages();
      const hit = pages.find((p) => /web\.whatsapp\.com/.test(p.url() || ''));
      if (hit) return { page: hit, account: aid, browser };
    } catch (e) { /* 这个号取不到页面就换下一个 */ }
  }
  return null;
}

/**
 * 「📞 抓取」：去**活着的 WhatsApp 网页**里，把这位客户「资料」上的号码全捞一遍。
 *
 * 🔴 老板 2026-10-07 纠正过：抓取的对象是**聊天对象的资料**（联系人卡上那个号），
 *    不是聊天对话正文里的数字。第一版扫的是 messages 表里的正文，方向就错了。
 *
 * 硬边界：只读。不写档案、不发消息、不点保存联系人；只开会话（号码渲染在头部）。
 *
 * @param {string} code 客户编号
 * @returns {Promise<object>} 见 profileScan.summarize 的返回结构
 */
async function grabProfilePhone(code) {
  const c = db.getCustomer.get(String(code || '').trim());
  if (!c) return { ok: false, reason: '客户不存在', code, fields: [], total: 0, okCount: 0 };

  const jid = String(c.wa_jid || '');
  const found = await findWhatsappPage(c.account_id);
  if (!found) {
    // 浏览器没开 —— 这不是失败，是"现在没法看资料"，要说清楚该怎么做的。
    return {
      ok: false,
      reason: 'no-session',
      hint: '没找到正在运行的 WhatsApp 窗口。请先在主界面点一下账号名把它启动起来（会弹出 Chrome 窗口），再点「📞 抓取」。',
      code, jid, fields: [], total: 0, okCount: 0,
    };
  }

  const probe = await profileScan.probeProfile(found.page, jid);
  const sum = profileScan.summarize(probe.fields, c);

  return {
    ...sum,
    ok: probe.ok,
    reason: probe.reason || '',
    hint: probe.ok ? '' : '读取资料时出错，可点「重新抓取」再试一次。',
    code, jid,
    account: found.account,
    isLid: !!(probe.meta && probe.meta.isLid),
    contactFound: !!(probe.meta && probe.meta.contactFound),
    errors: probe.errors || [],
  };
}

/** 输入框里是否已经是我们刚放进的那句话（用来判断预填到底成没成） */
async function inputHasText(page, text) {  try {
    const head = String(text || '').slice(0, 12);
    if (!head) return false;
    return await page.evaluate((h) => {
      const boxes = Array.from(document.querySelectorAll('div[contenteditable="true"]'));
      return boxes.some((b) => (b.innerText || '').indexOf(h) >= 0);
    }, head);
  } catch (e) { return false; }
}

/** 兜底：把文字直接塞进「当前最前面那个对话」的输入框（不按回车，红线）
 *  先整段清空再插入，避免"点一次发送、框里出现两遍相同内容"（execCommand('selectAll') 在
 *  部分 Chromium 版本不一定能选中，导致 insertText 变成追加而不是替换）。 */
async function typeIntoInput(page, text) {
  try {
    return await page.evaluate((t) => {
      const box = document.querySelector('div[contenteditable="true"][data-tab="10"]')
        || document.querySelector('footer div[contenteditable="true"]')
        || document.querySelector('div[contenteditable="true"]');
      if (!box) return false;
      box.focus();
      // 整段清空：selectAll + delete 比直接改 textContent 更不容易被 React 回滚
      try { document.execCommand('selectAll'); } catch (e) { /* ignore */ }
      try { document.execCommand('delete'); } catch (e) { /* ignore */ }
      let ok = false;
      try { ok = document.execCommand('insertText', false, t); } catch (e) { ok = false; }
      box.dispatchEvent(new InputEvent('input', { bubbles: true, data: t }));
      // 校验：框里内容应当正好等于要填的（或至少包含）
      const cur = (box.innerText || '').trim();
      return ok || cur === t || cur.includes(t);
    }, String(text || ''));
  } catch (e) { return false; }
}

/**
 * 不刷新地切换到指定会话（用 WhatsApp 网页版内部的 Store，没有整页导航 / 没有重载）。
 * 这是解决"发信息会自动刷新网页"的关键：老的写法用 page.goto('/send?phone=…')，
 * 那是一次完整的 SPA 导航，页面会整页重载（用户看到的就是"刷新了一圈"）。
 * 这里改成在已经加载好的页面里直接把对应聊天置顶，完全不重载。
 * 取不到（极少见的内部 API 变动）就返回 false，交给 typeIntoInput 退回到"当前会话里填"。
 * @returns {Promise<boolean>}
 */
/**
 * 不刷新地切换到指定会话（WhatsApp 网页版内部 Store）。
 * 改为多方法 + await，并退化到左侧搜索框兜底；失败必须返回真实 reason，绝不再静默 false。
 * @returns {Promise<{ok:boolean, method?:string, reason?:string, error?:string}>}
 */
async function openChatByJid(page, jid, fallbackText) {
  const w = String(jid || '');
  if (!w) return { ok: false, reason: 'empty-jid' };
  try {
    const r = await page.evaluate(async (wid) => {
      const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
      const want = digits(wid);
      const Store = window.Store || (window.WWebJS && window.WWebJS.Store);
      if (!Store || !Store.Chat) return { ok: false, reason: 'no-store' };

      const cands = [wid, wid.replace(/@c\.us$/, '@s.whatsapp.net'), wid.replace(/@s\.whatsapp\.net$/, '@c.us')];
      let chat = null;
      for (const id of cands) {
        try { chat = Store.Chat.get(id); } catch (e) { chat = null; }
        if (chat) break;
      }
      // 退一步：扫一遍会话列表按**号码**对。
      // 必要性：@lid 客户存下来的可能是真号码，而会话的 id 是那串 @lid，
      // 直接 Store.Chat.get('447726795080@c.us') 是找不到的（用户 2026-09-29 报的"发不到置顶窗口"）。
      if (!chat && want) {
        let list = [];
        try {
          list = typeof Store.Chat.getModelsArray === 'function'
            ? Store.Chat.getModelsArray()
            : (typeof Store.Chat.models === 'object' ? Object.values(Store.Chat.models) : []);
        } catch (e) { list = []; }
        for (const c of list) {
          const idStr = (c && c.id && (c.id._serialized || c.id.user)) || '';
          const ct = (c && c.contact) || {};
          const ph = ct.phoneNumber
            ? (ct.phoneNumber._serialized || ct.phoneNumber.user || '')
            : (ct.number || '');
          if ((idStr && digits(idStr) === want) || (ph && digits(ph) === want)) { chat = c; break; }
        }
      }
      if (!chat) return { ok: false, reason: 'chat-not-found' };

      // 方法1：chat.open()（老版本）
      try { if (typeof chat.open === 'function') { await chat.open(); return { ok: true, method: 'open' }; } } catch (e) { /* 换下一种 */ }
      // 方法2：Cmd.openChatByWid（新版本 MD）
      try { if (Store.Cmd && typeof Store.Cmd.openChatByWid === 'function') { await Store.Cmd.openChatByWid(wid, undefined, true); return { ok: true, method: 'openChatByWid' }; } } catch (e) { /* 换下一种 */ }
      // 方法3：Cmd.openChatFromParent
      try { if (Store.Cmd && typeof Store.Cmd.openChatFromParent === 'function') { await Store.Cmd.openChatFromParent(wid, true); return { ok: true, method: 'openChatFromParent' }; } } catch (e) { /* 都失败 */ }
      return { ok: false, reason: 'open-failed' };
    }, w);
    if (r && r.ok) return r;
    // Store 方式失败 → 退化到搜索框（不依赖内部 Store，按号码/姓名定位）
    const bySearch = await openChatBySearch(page, w, fallbackText);
    if (bySearch && bySearch.ok) return bySearch;
    // 把 Store 方式的真实原因带回去（优先），方便排查
    return r || { ok: false, reason: 'unknown' };
  } catch (e) {
    return { ok: false, reason: 'eval-error', error: e && e.message };
  }
}

/**
 * 兜底：用 WhatsApp 网页左侧搜索框按号码/姓名定位会话（不依赖内部 Store）。
 * best-effort：搜索框选择器随版本变，命中就开，命中不了就返回 ok:false 并带原因。
 * @returns {Promise<{ok:boolean, method?:string, reason?:string, error?:string}>}
 */
async function openChatBySearch(page, jid, fallbackText) {
  const digitsOf = String(jid || '').replace(/\D/g, '');
  const text = String(fallbackText || '').replace(/\D/g, '') || digitsOf;
  if (!text) return { ok: false, reason: 'no-search-term' };
  try {
    return await page.evaluate(async (q) => {
      const box = document.querySelector('#side div[contenteditable="true"]')
        || document.querySelector('div[contenteditable="true"][data-tab="3"]')
        || document.querySelector('#side input[type="text"]');
      if (!box) return { ok: false, reason: 'no-search-box' };
      box.focus();
      try { document.execCommand('selectAll'); } catch (e) {}
      try { document.execCommand('delete'); } catch (e) {}
      try { document.execCommand('insertText', false, q); } catch (e) {}
      box.dispatchEvent(new InputEvent('input', { bubbles: true, data: q }));
      await new Promise((r) => setTimeout(r, 600));
      // 回车打开搜索结果里的第一个会话
      const fire = (key) => box.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'Enter' ? 'Enter' : key, keyCode: key === 'Enter' ? 13 : 0, bubbles: true }));
      fire('Enter');
      await new Promise((r) => setTimeout(r, 500));
      return { ok: true, method: 'search' };
    }, text);
  } catch (e) {
    return { ok: false, reason: 'search-error', error: e && e.message };
  }
}

/**
 * 把一句话放进 WhatsApp 网页版的输入框（**永不按回车**，守住"不自动发送"红线）。
 *
 * 关键改动（2026-09-29）：**不再用 page.goto('/send?phone=…') 整页导航**——
 * 那会让 WhatsApp 网页版整页重载，用户看到的就是"发个信息网页就刷新了"，而且重载瞬间
 * 正在聊的会话被打断、连名字/电话都抓不到。现在改成：
 *  ① 有电话 → 在已加载的页面里用内部 Store 把该客户的会话置顶（零刷新），再填入输入框；
 *  ② 置顶不成 / 没电话 → 直接把文字塞进**当前最前面的会话**（置顶那个聊天），同样零刷新。
 * 两条都不成才返回 ok:false，前端会退回"复制到剪贴板"。
 *
 * @returns {Promise<{ok:boolean, method:string, reason?:string, account?:number}>}
 */
async function prefillChat(accountId, phone, text) {
  const found = await findWhatsappPage(accountId);
  if (!found) return { ok: false, method: 'none', reason: 'no-session' };
  return prefillIntoPage(found.page, phone, text, found.account);
}

/**
 * 只跟一个页面打交道的部分（抽出来是为了能不连真浏览器就测：测试里传一个假 page 即可）。
 * @param {object} page puppeteer 的 Page
 * @param {string} phone 客户电话（可空）
 * @param {string} text 要填进去的英文
 * @param {number} [account] 用到了哪个账号的窗口（仅用于回传）
 */
async function prefillIntoPage(page, phone, text, account) {
  if (!page) return { ok: false, method: 'none', reason: 'no-page' };
  try {
    await page.bringToFront().catch(() => {});   // 窗口拉到最前面，用户回车就能发
  } catch (e) { /* 拉不动不影响后面 */ }

  const e164 = String(phone || '').replace(/\D/g, '');
  if (e164) {
    // 零刷新地把该客户会话置顶（失败也不报错，退回到"当前会话里填"，前端会提示核对）
    const opened = await openChatByJid(page, `${e164}@c.us`);
    await new Promise((r) => setTimeout(r, 400));
    if (await typeIntoInput(page, text)) {
      // prefill = 精确定位到这位客户的会话；typed = 没定位到，塞进了当前会话（注意别发错人）
      return { ok: true, method: (opened && opened.ok) ? 'prefill' : 'typed', account };
    }
    return { ok: false, method: 'none', reason: '没找到 WhatsApp 输入框（可能还没登录 / 该会话还没加载）' };
  }

  // 没给电话（比如话术编排台发到"当前置顶的聊天"）：直接填进当前最前面的会话
  if (await typeIntoInput(page, text)) {
    return { ok: true, method: 'typed-no-phone', account };
  }
  return { ok: false, method: 'none', reason: '没找到 WhatsApp 输入框（可能还没登录）' };
}

/* ---------------- 跳转到真实聊天窗口 ---------------- */

/**
 * v2.5.1071：把目标 OS 窗口**真正切换**到前台（等同 Alt-Tab / 点任务栏）——不是"强置顶 2 秒再放手"，
 * 切换后窗口停在前台，直到用户自己操作。同时开「软件静默 3 秒」锁，期间后台循环不抢焦点。
 *
 * 三种定位方式（互斥，按优先级）：
 *   - opts.pid      精确按进程 PID（最稳，WhatsApp/Telegram 的 Chrome 进程）
 *   - opts.procName 按进程名（Signal 桌面端 = "Signal"）
 *   - opts.title    按窗口标题子串（兜底）
 *
 * settop.exe 的 stdout（含 hwnd / 是否最小化 / setfg 是否成功 / 切换前后前台窗口）会追加写进
 * userData/settop_debug.log，真机若仍异常，把该日志发回即可定位（不再盲改）。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
const { resolveSettopPath, buildArgs } = require('./settop');

function _logSettop(out) {
  try {
    const app = require('electron').app;
    const dir = (app && app.getPath) ? app.getPath('userData') : (process.env.APPDATA || '.');
    const fs = require('fs');
    fs.appendFileSync(require('path').join(dir, 'settop_debug.log'),
      '[' + new Date().toISOString() + '] ' + String(out).trim() + '\n');
  } catch (e) { /* 日志写入失败不影响主流程 */ }
}

async function forceTopmost(opts = {}) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not-win32' };
  const args = buildArgs(opts);
  if (!args) return { ok: false, reason: 'no-target' };

  const exe = resolveSettopPath();
  if (!fs.existsSync(exe)) {
    console.warn('[forceTopmost] 找不到 settop.exe：', exe);
    return { ok: false, reason: 'no-exe' };
  }
  // 先开静默锁：覆盖切换瞬间 + 后 3 秒，后台循环这期间不偷焦点
  setSilence(opts.silenceMs || 3000);
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    const cp = execFile(exe, args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      if (stdout) _logSettop('OUT ' + stdout);
      if (stderr) _logSettop('ERR ' + stderr);
      if (err && err.killed) console.warn('[forceTopmost] 超时已被杀掉（异常）');
      if (err) _logSettop('FAIL ' + (err.message || 'spawn-failed'));
      resolve({ ok: !err, reason: err ? (err.message || 'spawn-failed') : undefined });
    });
    // 保险：万一超时回调没触发也别卡死
    cp.on('error', () => resolve({ ok: false, reason: 'spawn-error' }));
  });
}

/** v2.5.1070：从 puppeteer.connect 出来的 browser 拿不到 process()（连的不是自己生的），
 *  但 session.js 把真实 Chrome 子进程挂在 browser.__chromeChild 上。两者都试，
 *  拿到真实 pid 才能用 --pid 精准置顶（尤其 Telegram 跑在 WA 的 Chrome 里、窗口标题是 WhatsApp）。 */
function getBrowserPid(browser) {
  try {
    const p = browser && browser.process && browser.process();
    if (p && p.pid) return p.pid;
  } catch (e) { /* connect 出来的 browser 没有 process，忽略 */ }
  try {
    const c = browser && browser.__chromeChild;
    if (c && c.pid) return c.pid;
  } catch (e) { /* 没挂 __chromeChild 就忽略 */ }
  return null;
}

/** v2.5.1069：Signal 桌面端当前是否在跑（含老板手动开的，无调试端口也算） */
function isSignalRunning() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "if (Get-Process -Name Signal -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }"],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    return String(out).includes('yes');
  } catch (e) {
    return false;
  }
}

/**
 * v2.5.1069：②软件拉起 Signal —— 若 Signal 一个实例都没跑，逐个 startLauncher 拉起 S1~S3，
 * 等窗口起来（最多 ~6 秒）再返回。已在跑则直接返回。
 * 注意：这只在用户**显式点「跳到聊天」**时触发，绝不进任何自动扫描/预热逻辑。
 */
async function ensureSignalLaunched() {
  if (isSignalRunning()) return { launched: false, already: true };
  const ids = (typeof launcher.signalLauncherIds === 'function') ? launcher.signalLauncherIds() : [];
  for (const id of ids) {
    try { launcher.startLauncher(id); } catch (e) { console.warn(`[ensureSignalLaunched] ${id} 拉起失败：`, e.message); }
  }
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (isSignalRunning()) break;
  }
  return { launched: true };
}

/**
 * 跳到某个客户在对应 IM 里的真实聊天窗口（2026-10-11 用户需求：左栏看到新消息、
 * 点进对话后，一键跳到 WhatsApp / Telegram 里那个客户的聊天上）。
 *
 * 渠道判定以 account_id 为准（1~5=WhatsApp，6=Signal，7~9=Telegram）：
 *   - WhatsApp：复用现成的 openChatByJid —— 在已加载的网页里把该客户会话置顶（零刷新），
 *     比 page.goto('/send?phone=…') 整页重载稳得多，也不会打断正在聊的会话。
 *   - Telegram：telegramRead.openOrFocus 拿到页面 → 在搜索框输入客户名 → 点第一个结果。
 *     （Telegram 严格只读，这里只"看/定位"，绝不发消息。）
 *   - Signal：桌面端没有可编程定位到具体聊天的接口，本版不支持，返回明确 reason。
 *
 * @returns {Promise<{ok:boolean, method?:string, reason?:string, account?:number, hint?:string}>}
 */
async function jumpToChat(code) {
  const c = db.getCustomer.get(String(code || '').trim());
  if (!c) return { ok: false, reason: 'no-customer' };
  const account = Number(c.account_id);

  // ---- WhatsApp 1~5 ----
  if (account >= 1 && account <= 5) {
    const found = await findWhatsappPage(account);
    if (!found || !found.page) {
      return { ok: false, reason: 'no-wa-session', account,
        hint: '没找到正在运行的 WhatsApp 窗口，请先点一下顶栏对应账号把它启动起来。' };
    }
    // v2.5.1072：在 Electron 仍是前台时就把 IM 窗口切到最前。
    // 关键：selectImTab 内部的 bringToFront 会把 Chrome 变成前台进程，之后 spawn 的子进程
    // 就不再是"前台进程的子进程"，Windows 前台锁会挡掉 SetForegroundWindow → 之前"闪一下消失"的根因。
    // 原生 settop.exe（C 编译，启动 <10ms）此刻 spawn，作为前台进程的子进程，SetForegroundWindow 被放行。
    try {
      const pid = getBrowserPid(found.browser);
      // v2.5.1082：① 必须 await —— 否则 spawn 后立刻跑 selectImTab 的 bringToFront 会先把 Chrome 变前台，
      //    Windows 前台锁挡掉 settop 的 SetForegroundWindow → 窗口没真置顶（时灵时不灵）。
      // ② 只用 pid 精准锁定那个 Chrome 进程，去掉 title:'WhatsApp' 硬过滤：跳转此刻 IM 标签往往还没激活，
      //    窗口标题不含 WhatsApp，会被 settop 判"找不到窗口"反而一个都不顶。标签正确性交给 selectImTab。
      await forceTopmost(pid ? { pid } : { procName: 'chrome' });
    } catch (e) { /* 置顶失败不影响定位 */ }
    // 老板 2026-10-12：知道窗口→激活窗口→检测 WhatsApp 标签→自动选中该标签→再搜索。
    found.page = await selectImTab(found.browser, found.page, /web\.whatsapp\.com/, found.account, revealBrowser);
    const res = await openChatByJid(found.page, c.wa_jid, c.phone || c.name);
    if (res && res.ok) {
      return { ok: true, method: 'whatsapp-' + (res.method || 'store'), account };
    }
    // 失败也要把真实原因带回去，前端不再只显示"跳转失败"
    return {
      ok: false,
      reason: 'whatsapp-' + (res && res.reason ? res.reason : 'open-failed'),
      account,
      hint: 'WhatsApp 没能自动定位到该会话（' + (res && res.reason ? res.reason : 'open-failed') +
        '）。可以手动在左侧搜一下这个客户的号码/名字点开，或确认该 WhatsApp 窗口已登录且不是停在"端到端加密"页。',
    };
  }

  // ---- Telegram 7~9 ----
  if (account >= 7 && account <= 9) {
    const acc = TELEGRAM_ACCS.find((t) => t.id === account);
    if (!acc) return { ok: false, reason: 'no-tg-account', account };
    let r;
    try {
      r = await telegramRead.openOrFocus(acc, cfg, await waBrowserFor(acc));
    } catch (e) {
      return { ok: false, reason: 'tg-open-failed', account, error: e && e.message };
    }
    if (!r || !r.page) {
      return { ok: false, reason: 'no-tg-window', account,
        hint: '没找到 Telegram 窗口，请先点顶栏对应账号把它启动起来并登录。' };
    }
    // v2.5.1072：同 WhatsApp —— 在 Electron 仍是前台时先切窗口，避免之后 bringToFront 把 Chrome 变前台导致前台锁挡掉。
    try {
      const pid = getBrowserPid(r.browser);
      // v2.5.1082：同 WhatsApp —— await + 只用 pid 精准锁定 Chrome 进程，去掉 title 硬过滤
      // （Telegram 网页跑在关联 WA 号的 Chrome 里，标签未激活时标题不含 WhatsApp，会漏顶）。
      await forceTopmost(pid ? { pid } : { procName: 'chrome' });
    } catch (e) { /* 置顶失败不影响定位 */ }
    // 老板 2026-10-12：Telegram 跳转模仿 WhatsApp 那条 —— 激活窗口 + 自动选中 Telegram 标签 → 再定位搜索
    r.page = await selectImTab(r.browser, r.page, /web\.telegram\.org|telegram\.org/, acc.id, revealBrowser);

    /* ① 优先：有 @username → 走官方深链 web.telegram.org/k/#@username
       （v2.5.1032）SPA 内改 hash 即可路由过去，不整页刷新、不丢登录态；
       用户名唯一，绝不会像按显示名搜索那样重名点错。 */
    const uname = String(c.tg_username || '').trim();
    if (uname) {
      let ok = false;
      try { ok = await jumpTelegramByUsername(r.page, uname); } catch (e) { ok = false; }
      if (ok) return { ok: true, method: 'telegram-deeplink', account };
      // 深链没落上去（对方改名/注销等）→ 继续走搜索框兜底
    }

    // ② 兜底：搜索框按显示名搜（没抓到 username 的老客户走这条）
    const name = String(c.wa_jid || '').replace(/^tg:/, '') || c.name || '';
    let jumped = false;
    try { jumped = await jumpTelegramChat(r.page, name); } catch (e) { jumped = false; }
    /* 老板 2026-10-11 要求：跳不到具体对话没关系，**能跳到那个消息窗口/标签位置也可以** ——
       窗口已经拉到最前了，这本身就该算成功（按钮点了必须有可见反馈），
       只是用 located:false 标注「没定位到对话」，前端据此换一句诚实的文案。 */
    return {
      ok: true,
      located: jumped,
      method: jumped ? 'telegram-search' : 'telegram-window',
      account,
      hint: jumped ? undefined : `已切到 Telegram 窗口，但没自动定位到「${name}」的对话，请手动点开。`,
    };
  }

  /* ---- Signal 6：CDP 辅助注入为主，sgnl:// 深链兜底（v2.5.1032）----
     老板要求："Signal 是桌面版，以前做软件辅助/游戏辅助的路子，高级工程师应该不难" —— 确实能做：
     Signal Desktop 是 Electron 应用，吃 `--remote-debugging-port`，而 S1~S3 本来就是我们
     launcher.js spawn 起来的，所以端口是我们自己传的（v2.5.1032 起启动参数已带端口）。
     定位依据用显示名（Signal 的 e164 电话实测是 null，见 signalRead.js 表结构注释）。 */
  if (account === 6) {
    const serviceId = String(c.wa_jid || '').replace(/^sig:/, '');
    const ident = { name: c.name || '', serviceId };

    // ②（老板 2026-10-12）：软件拉起 Signal —— 若 Signal 一个实例都没跑，先逐个 startLauncher 拉起 S1~S3 再继续。
    //   ⚠️ 只在用户显式点「跳到聊天」时触发，绝不进任何自动扫描/预热逻辑。
    await ensureSignalLaunched();

    // v2.5.1082：① await —— 先让 settop 把 Signal 窗口真置顶，再走 CDP bringToFront（锦上添花）。
    // ② 去掉 title:'Signal' 硬过滤，只用 procName:'Signal' 锁定进程顶主窗；
    //    启动期临时窗已无标题过滤需求（v2.5.1072 已用 --wait 轮询等主窗建好），避免漏顶。
    try { await forceTopmost({ procName: 'Signal', wait: 6000 }); } catch (e) { /* 不影响定位 */ }

    // ① 逐个试 S1~S3 的调试端口，连上就在 Signal 里搜索并打开会话
    const ports = (typeof launcher.signalDebugPorts === 'function' && launcher.signalDebugPorts()) || [];
    let lastReason = '';
    let result = null;
    for (const port of ports) {
      const r = await signalJump.jumpViaCdp(port, ident);
      if (r && r.ok) { result = { ok: true, located: true, method: 'signal-cdp', account, port }; break; }
      lastReason = (r && r.reason) || '';
      // 没装 puppeteer / 压根没关键字 → 换端口也没用，别白跑
      if (lastReason === 'no-puppeteer' || lastReason === 'no-keyword') break;
      /* 老板 2026-10-11 要求：跳不到对话就跳到窗口。
         只要 CDP 连上了，Signal 窗口就已经被 bringToFront 拉到最前 —— 这本身就算成功，
         只是没定位到对话（located:false）。只有"压根连不上"才继续试下一个端口。 */
      if (lastReason && lastReason !== 'cdp-connect-failed' && lastReason !== 'no-signal-page') {
        result = { ok: true, located: false, method: 'signal-window', account, port,
          hint: '已切到 Signal 窗口，但没自动定位到该客户的对话，请手动点开。' };
        break;
      }
    }

    // ② 兜底：只有真拿到电话号码才拼得出 sgnl:// 深链
    //    （Signal 的 e164 实测常为 null，所以这条多数走不到，但留着以防某些客户有号）
    if (!result) {
      const e164 = String(c.phone || '').replace(/[^\d+]/g, '');
      if (e164) {
        try {
          const url = `sgnl://signal.me/#p/${e164.startsWith('+') ? e164 : '+' + e164}`;
          // 用 explorer.exe 打开自定义协议（纯 Node，不依赖 electron，测试环境也能跑）
          require('child_process').execFile('explorer.exe', [url], { windowsHide: true });
          result = { ok: true, method: 'signal-deeplink', account,
            hint: '已用 Signal 深链唤起；能否直接落到该会话取决于 Signal 版本（部分版本会停在会话列表）。' };
        } catch (e) { /* 唤起失败就落到下面的失败提示 */ }
      }
    }

    /* ③ 最后兜底：所有端口都连不上（Signal 多半是老板手动开的、没带调试端口）
          —— 仍尽力把 Signal 窗口真置顶到最前（已在上面 ensureSignalLaunched 之后立刻切过窗口），
          至少"跳到窗口"这一步能成（老板认可的最低要求）。 */
    if (!result) {
      result = { ok: true, located: false, method: 'signal-window-fallback', account,
        hint: '已切到 Signal 窗口，但没法自动定位到该客户的对话（Signal 不是用 S1~S3 按钮启动的，拿不到调试端口）。用 S1~S3 按钮重启一次 Signal，就能自动定位到对话。' };
    }

    return result;
  }
  return { ok: false, reason: 'unknown-account', account };
}

/**
 * 用 Telegram 官方深链跳到某个 @username 的对话（v2.5.1032）
 *   做法：在页面里把 location.hash 改成 `#@username`。Telegram Web K 是 SPA，
 *   改 hash 会走它自己的路由打开该对话 —— 不会整页刷新（也就不丢登录态），比搜索框精准。
 * @param {object} page puppeteer 页面
 * @param {string} username 不含 @ 的用户名
 * @returns {Promise<boolean>} 是否真的落到了该对话
 */
async function jumpTelegramByUsername(page, username) {
  const u = String(username || '').replace(/^@/, '').trim();
  if (!page || !u) return false;
  try {
    const set = await page.evaluate((name) => {
      try { location.hash = '#@' + name; return true; } catch (e) { return false; }
    }, u);
    if (!set) return false;
    // 等 SPA 路由生效
    await new Promise((r) => setTimeout(r, 1500));
    // 校验：hash 没被重置（Telegram 找不到这个人时会把 hash 弹回去）就算成功
    const now = await page.evaluate(() => String(location.hash || '')).catch(() => '');
    return now === `#@${u}`;
  } catch (e) {
    return false;
  }
}

/**
 * 在已打开的 Telegram 网页里，用搜索框定位到指定名字的对话（best-effort）。
 * 选择器写成候选数组，任何一个失效都不崩（与 telegramRead 的轮询器同思路）。
 * @returns {Promise<boolean>}
 */
async function jumpTelegramChat(page, name) {
  if (!page || !name) return false;
  try {
    return await page.evaluate(async (nm) => {
      const q = (sels) => { for (const s of sels) { try { const e = document.querySelector(s); if (e) return e; } catch (e) {} } return null; };
      const all = (sels) => { for (const s of sels) { try { const e = Array.from(document.querySelectorAll(s)); if (e.length) return e; } catch (e) {} } return []; };
      const search = q([
        '.search-group input', 'input.im_search', '#column-center .composer_input',
        'input[placeholder*="Search"]', 'input[placeholder*="搜索"]', '.sidebar .search input', '.SearchInput input',
      ]);
      if (!search) return false;
      search.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(search, nm);
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const items = all([
        '.search-results .chat-item', '.search-results .ListItem', '.chatlist .chat-item',
        '.dialogs .chat', '.chat-list .chat',
      ]);
      if (items.length) { items[0].click(); return true; }
      // 退一步：直接点聊天列表里第一个
      const first = q(['.chat-list .chat', '.dialogs .dialog', '.sidebar .ListItem']);
      if (first) { first.click(); return true; }
      return false;
    }, name);
  } catch (e) {
    return false;
  }
}

/* ---------------- 通知 ---------------- */

let notifier = null;
try {
  notifier = require('node-notifier');
} catch (e) {
  notifier = null; // 可选依赖，装不上就只用界面红点
}

function notify(title, message) {
  if (cfg.app?.desktopNotify === false) return;
  if (notifier) {
    try {
      notifier.notify({ title, message, timeout: 6 });
      return;
    } catch (e) {
      /* 落到下面的兜底 */
    }
  }
  console.log(`\n[通知] ${title}：${message}`);
  process.stdout.write(String.fromCharCode(7)); // 终端响一声
}

/* ---------------- 消息处理 ---------------- */

/** 老字段，1.34 版的 Message 上已经没有了，只留着兼容更老/更新的 wwjs */
function safeName(msg) {
  return msg.notifyName || msg.pushName || '';
}

/**
 * whatsapp-web.js 的消息类型 → 我们显示的占位文字。
 *
 * 2026-10-07 加：以前只有 msg.hasMedia 为真才给占位，而 hasMedia 在
 * whatsapp-web.js 里是 Boolean(data.directPath) —— 图片刚发出/上传中 directPath
 * 还没到，hasMedia 就是 false，那条图片消息会被当成"什么都没有"直接不入库，
 * 客户发来的图凭空消失。加这张表后，**看 type 就给占位，不依赖 hasMedia**。
 */
const MEDIA_TYPES = {
  image: '[图片]',
  video: '[视频]',
  sticker: '[贴纸]',
  document: '[文件]',
  audio: '[语音]',
  ptt: '[语音]',
};

/**
 * 这条消息该显示成什么文字（2026-09-28 加）
 *
 * 以前只要没文字就存成空字符串，界面上就多出一个空气泡；撤回提示、加密提示、
 * 通话记录、表情回应这些更是被当成"消息"提了出来。现在：
 *   有文字 → 用文字（图片带说明文字时，body 就是那段说明）
 *   有附件 → 按类型给个占位（[图片]/[语音]/[视频]/[文件]/[贴纸]…）
 *   有位置/名片/投票 → 给对应占位
 *   真的什么都没有 → 返回空串，**调用方直接不入库**（空消息不该出现在任何地方）
 *
 * 2026-10-07 加：过滤「假正文」——图片/视频/语音消息的正文有时是一整串
 * `data:image/jpeg;base64,iVBORw0KGgo...`。根因在 whatsapp-web.js：
 *   Message.js:55  this.body = this.hasMedia ? (data.caption || '') : data.body
 *   Message.js:49  this.hasMedia = Boolean(data.directPath)
 * 图片刚发出 / 正在上传时 directPath 还没到 → hasMedia=false → body 落到
 * WhatsApp Web 内部的 data.body，而那对媒体消息就是 base64 数据 URI。
 * 结果：系统通知和页面提示弹出一屏乱码，而且这串垃圾还会被写进数据库当正文。
 * 这里一律当"没正文"处理，走下面的附件占位分支。
 */
function messageText(msg) {
  const raw = String(msg.body || '').trim();
  // 二进制数据 URI（data:image/...;base64,xxxx）不是人写的字 → 当没有正文。
  // 第二条判据：超长（>2000）**且不含空格**—— 真人写的长文一定有空格，
  // 而 base64 / 二进制乱码一个空格都没有。这样不会误伤客户粘来的长文。
  //
  // 🔴 2026-10-07 21:30 补一条更准的判据：**这��消息是媒体类型**（type=image/sticker…）
  //   时，正文只要长得像 base64 就一律不算正文 —— 不看长度。
  //   为什么：旧判据要 >2000 字符才拦，可一张被 WhatsApp 压过的小图
  //   （实测 75×100 的 JPEG）base64 只有 **381 字符** → 从闸门底下钻过去，
  //   结果整串base64 被当成正文显示在界面上（库里第 19 条就是这样）。
  //   现在只要 type 是媒体，pickBase64Image 又确认过是真图，就绝不留base64 原文。
  const t = String(msg.type || '');
  const isMediaMsg = msg.hasMedia || MEDIA_TYPES[t];
  const bareB64 = raw.length >= 40 && raw.length <= 12 * 1024 * 1024
    && /^[A-Za-z0-9+/=]+$/.test(raw)
    && (() => {           // 真的是 base64 编码出来的图片字节吗
      try { return !!sniffImageType(Buffer.from(raw, 'base64')); } catch (e) { return false; }
    })();
  const body = (/^data:[\w./+-]+;base64,/i.test(raw)
    || (isMediaMsg && bareB64)
    || (raw.length > 2000 && !raw.includes(' '))) ? '' : raw;
  if (body) return body;

  // 附件占位：type 说了算，**不再依赖 hasMedia**。
  // 以前只在 msg.hasMedia 为真时才给占位，而 hasMedia=Boolean(data.directPath)
  // 在图片刚发出/上传中时是假的 → 那条图片消息会被当成"什么都没有"直接不入库，
  // 客户发来的图就这么凭空消失（2026-10-07 修）。
  if (msg.hasMedia || MEDIA_TYPES[t]) {
    if (t === 'ptt' || t === 'audio') return '[语音]';
    if (t === 'image') return '[图片]';
    if (t === 'video') return '[视频]';
    if (t === 'sticker') return '[贴纸]';
    if (t === 'document') return '[文件]';
    if (msg.hasMedia) return '[图片/附件]';
    return MEDIA_TYPES[t];
  }

  if (msg.location || t === 'location') return '[位置]';
  if (t === 'vcard' || t === 'multi_vcard' || (msg.vCards && msg.vCards.length)) return '[名片]';
  if (t === 'poll' || t === 'poll_creation') return '[投票]';
  return ''; // 撤回提示 / 加密提示 / 通话记录 / 表情回应 …… 一律不采
}

/**
 * 从消息正文里捞 base64 图片（2026-10-07 加，方案 A）
 *
 * 🔴 这批图以前一张都没存下来过 —— 根因链条（实测取证）：
 *   1) whatsapp-web.js `Message.js:49``this.hasMedia = Boolean(data.directPath)`
 *      —— directPath 是媒体的服务器地址，Store 里没加载过就是 undefined；
 *   2) `Message.js:514``downloadMedia() { if (!this.hasMedia) return undefined }`
 *      —— 库自己第一行就把门关了；
 *   3) 我们 `saveMedia` 第 1 行又写了一遍 `if (!msg.hasMedia) return null`。
 *   三道门叠起来 → 库里 media_path 全空、data/media/ 0 个文件。
 *
 * 💡 但讽刺的是：hasMedia=false 时，图片数据落在**另一个字段**里 ——
 *    `Message.js:55`  ``this.body = this.hasMedia ? caption : data.body``
 *    而 WhatsApp Web 内部对媒体消息的 data.body 就是一整串
 *    `data:image/jpeg;base64,iVBORw0KGgo...`（上一轮当成"乱码"拦掉的那个）。
 *    也就是说**数据其实到手了，只是被当成了正文文字**。这里把它捡回来。
 *
 * 🔴 2026-10-07 21:10 补：生产库第19 条消息证明**还有第二种形态**——
 *    整串裸base64，**没有 data:image/...;base64, 前缀**：
 *      `/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAA...`
 *    7032 字符 → 解码 5274 字节 → magic `ffd8ffe0` → 真实 75×100 JPEG。
 *    旧版正则硬要求 data: 前缀 → 这一整张图被漏掉，界面上只出现一串乱码。
 *    所以现在是**两条路都认**，mimetype 靠 magic 字节反推（下面 sniffImageType）。
 *
 * @returns {{base64:string, mimetype:string}|null}
 */
function pickBase64Image(msg) {
  const body = String((msg && msg.body) || '');
  if (!body) return null;

  // ---- 路①：带 data:image/xxx;base64, 前缀（常规形态）----
  // ⚠️ 捕获组只有两个：m[1]=纯 mimetype、m[2]=纯 base64 串。
  //    千万别把 mimetype 写成 `(...)` 包在 data URI 里 —— 那会让 m[1] 变成
  //    整个 "image/png;base64,iVBOR..." 串，EXT_BY_MIME 查不到 → 一律认不出。
  //    （这个坑我踩过一次：真图被当假图拒掉，是验证时才发现的。）
  const withPrefix = body.match(/data:(image\/(?:jpeg|jpg|png|gif|webp|bmp));base64,([A-Za-z0-9+/=\s]{40,})/i);
  if (withPrefix) {
    const data = withPrefix[2].replace(/\s+/g, ''); // WhatsApp 给的 base64 常带换行
    // 🔴 下限只挡"空壳"（40 个字符 ≈ 30 字节）。不要拿它当质量闸——
    //    实测 1x1 像素的 PNG 才 92 字符、真实小表情包也就 100 出头，
    //    下限设 100 会把真图误杀。真正的质量闸是 saveMedia 里的 magic 字节校验。
    if (data.length >= 40) {
      const mime = withPrefix[1].toLowerCase().replace('image/jpg', 'image/jpeg');
      return { base64: data, mimetype: mime };
    }
  }

  // ---- 路②：裸 base64（没有 data: 前缀）----
  // 判据不是"像 base64"，而是**解出来的头几个字节是真图片 magic**——
  // 这样才敢要。真人打的一串纯字母数字（"hello"、订单号、tracking id）
  // 解出来是垃圾字节，magic 一定不匹配 → 绝不会被当成图。
  //
  // 上限 8MBbase64（约 6MB 图）：手机拍的大图可能到几 MB，但再大就不是聊天图了。
  const bare = body.replace(/\s+/g, '');
  if (bare.length < 40 || bare.length > 12 * 1024 * 1024) return null;
  // 必须整串都是 base64 字符（允许结尾几个 = 填充）。真人写的句子里有空格标点，
  // 前面已经去过空白了，这里再卡一次字符集。
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(bare)) return null;
  let buf;
  try { buf = Buffer.from(bare, 'base64'); } catch (e) { return null; }
  // Buffer.from 对非法字符是**静默跳过**的，所以解完必须验字节数：
  // 长度掉太多说明这串根本不是合法 base64。
  if (buf.length < 30 || buf.length < bare.length * 0.7) return null;
  const mime = sniffImageType(buf);
  if (!mime) return null;
  return { base64: bare, mimetype: mime };
}

/**
 * 按magic 字节（文件头）判断图片类型，不认扩展名。
 * 这是唯一可信的判据 —— 扩展名和 MIME 都可能骗人，字节不会。
 *
 * @returns {string|null} mimetype，认不出返回 null
 */
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(0, 3).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

/** 消息类型 → 占位文字（和 messageText 共用一张表，避免两处各写一份） */
const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'audio/webm': 'webm', 'audio/aac': 'aac', 'audio/mp4a-latm': 'm4a',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/webm': 'webm',
};

/**
 * 保存客户发来的媒体。
 *
 * 2026-10-07 改（方案 A：就地救 base64）：
 *   原来第一行 `if (!msg.hasMedia) return null` 把绝大多数图片在这里就挡掉了。
 *   现在改成**两条路都试**：
 *     路① hasMedia=true  → 走官方 downloadMedia()（真原图，永久有效）
 *     路② hasMedia=false → 从 body 里把 base64 捞出来解码存（当天就能看到图）
 *   两条都拿不到才返回 null，界面上显示占位符，不会留空白气泡。
 *
 * @returns {{path:string, src:'download'|'base64', mimetype:string}|null}
 */
/**
 * 🔴 真图优先模式（2026-10-08 老板实测 base64 缩略图只有 75×100 看不清，已恢复全链路）：
 *   - 跑路① downloadMedia（官方下载真图）
 *   - 跑路B+C（回页面重取 + 强制解密真图）
 *   - 跑 mediaFetch 后台补抓
 *   图片按规矩压到 ~10KB 再存。
 *   若只想看 base64 缩略图（不拿真图），把这里改成 true 即可。
 */
const BASE64_ONLY_MODE = false;

async function saveMedia(msg, customerCode) {
  const msgType = String((msg && msg.type) || '').toLowerCase();
  // 🔴 真实的媒体身份（image / sticker / video / audio / document / ptt）。
  //以前这一步就把类型丢了，界面只能靠扩展名猜 → 贴纸（webp）被当成图片。
  const msgKind = msgType || '';
  // 捞一次就够，别在 looksMedia 和下面各调一遍（base64 串可能有几百 KB）
  const b64 = pickBase64Image(msg);
  const looksMedia = msg.hasMedia || MEDIA_TYPES[msgType] || !!b64;

  // ---- 路①：官方下载（最理想，真原图，永久有效）----
  // 🔴 方案2：跳过路①，只用 base64
  if (msg.hasMedia && !BASE64_ONLY_MODE) {
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) {
        const mime = String(media.mimetype || 'image/jpeg').split(';')[0].toLowerCase();
        const rawBuf = Buffer.from(media.data, 'base64');
        // 🔴 2026-10-08：图片/贴纸按老板规矩压到 ~10KB 再存（原图 1~3MB 不进库）。
        //   sharp 不可用 / 不是图片时退回「原样存」（行为和以前一致，不丢消息）。
        const isImageMedia = mime.startsWith('image/');
        if (isImageMedia && shrink.available()) {
          const outPath = path.join(MEDIA_DIR, `${customerCode}_${Date.now()}.jpg`);
          const small = await shrink.shrinkToFile(rawBuf, outPath);
          if (small && small.path) {
            console.log(`[media] 路① 原图 ${rawBuf.length} B → 压缩 ${small.bytes} B (q=${small.quality} ${small.width}x${small.height})`);
            return { path: small.path, src: 'download', mimetype: 'image/jpeg', kind: msgKind || 'image' };
          }
          // 压失败（解码异常/非图）→ 落到下面原样存
        }
        // 非图片 / sharp 不可用 / 压缩失败：原样存（老行为，绝不丢消息）
        const ext = EXT_BY_MIME[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '');
        const file = path.join(MEDIA_DIR, `${customerCode}_${Date.now()}.${ext}`);
        fs.writeFileSync(file, rawBuf);
        return { path: file, src: 'download', mimetype: mime, kind: msgKind || (mime.startsWith('image/') ? 'image' : '') };
      }
    } catch (e) {
      console.warn('[media] 官方下载失败，改试 base64：', e.message);
    }
  }

  // ---- 路②：救 base64（hasMedia=false 时数据其实在 body 里）----
  if (b64) {
    try {
      const buf = Buffer.from(b64.base64, 'base64');
      // base64 解出来可能还是垃圾（那串东西有时候是占位符），验一下是不是真图
      // ⚠️ 判据是**magic 字节**，不是长度。之前加了条 `buf.length > 200`，
      //    结果 1x1 像素的 PNG（实测 70 字节）被误杀 —— 客户发的表情包、
      //    小图都有可能被挡。最小合法 PNG 是 67 字节，30 已经足够宽松。
      //    2026-10-07：改用 sniffImageType，顺带把「官方的 RIFF 当webp」这个错修掉
      //    （旧判据 buf.slice(0,4)==='RIFF' 就放行，音频/视频的 RIFF 也会被当成图存下来）。
      if (!sniffImageType(buf)) {
        console.warn('[media] base64 解出来不是图片，丢弃（', buf.length, '字节）');
        return looksMedia ? { path: null, src: 'none', mimetype: b64.mimetype } : null;
      }
      // 方案2：base64 缩略图原样存，不压缩（保留 75×100 原貌；要压图把 !BASE64_ONLY_MODE 加回条件）
      if (shrink.available() && !BASE64_ONLY_MODE) {
        const outPath = path.join(MEDIA_DIR, `${customerCode}_${Date.now()}.jpg`);
        const small = await shrink.shrinkToFile(buf, outPath);
        if (small && small.path) {
          console.log(`[media] 路② 原图 ${buf.length} B → 压缩 ${small.bytes} B (q=${small.quality} ${small.width}x${small.height})`);
          return { path: small.path, src: 'base64', mimetype: 'image/jpeg', kind: msgKind || 'image' };
        }
      }
      const ext = EXT_BY_MIME[b64.mimetype] || 'jpg';
      const file = path.join(MEDIA_DIR, `${customerCode}_${Date.now()}.${ext}`);
      fs.writeFileSync(file, buf);
      return { path: file, src: 'base64', mimetype: b64.mimetype, kind: msgKind || 'image' };
    } catch (e) {
      console.warn('[media] base64 保存失败：', e.message);
    }
  }

  // 两条路都没拿到：告诉调用方"这是条媒体消息但没图"，界面显示占位符
  // 🔴 2026-10-07：kind 一路带上真实的 msg.type。
  //以前消息类型在 saveMedia 这一步就被丢掉了，只剩一个媒体文件路径，
  //而 media.kindOf() 是按**扩展名**判类型的 → 贴纸（webp）会被当成图片显示。
  // 现在把真实身份带出去，界面才能区分「图片 / 贴纸 / 视频 / 语音」。
  const realKind = msgKind || '';
  if (looksMedia) return { path: null, src: 'none', mimetype: '', kind: realKind };
  return null;
}

/**
 * 处理一条消息（入库 → 【立刻推界面】 → 后台翻译 → 更新档案 → 推送）
 *
 * 顺序很关键（2026-09-24 改）：
 *   以前是「先 await 翻译，翻完才通知界面」。AI 慢的时候（几秒~十几秒），
 *   消息早就到库了，界面却静悄悄——用户以为软件没收到。
 *   现在先广播 new_message（界面立刻出现，右栏标「⟳ 等待翻译中…」），
 *   翻译丢后台跑，翻完再广播 translated 把等待提示撤掉。
 *
 * @param {object} account 账号配置
 * @param {object} msg whatsapp-web.js 的 Message
 * @param {boolean} silent true 表示历史同步，只入库不打扰
 */
/**
 * 浏览器插件（网页版 WhatsApp 抓图）入库入口。
 * 插件只会在用户自己登录的 WhatsApp 网页版里，把「客户发来的图片」POST 过来
 * （自己发的消息插件不抓）。这里复用现有落库链路：匹配/建客户 → 存图 → 写消息 → 广播。
 * @param {object} p { accountId, sender:{lid?,name?}, image:'data:...;base64,...'|raw base64, mime?, caption?, ts? }
 */
async function ingestExtensionImage(p = {}) {
  const accountId = Number(p.accountId) || 1;
  const sender = p.sender || {};
  const lid = typeof sender.lid === 'string' ? sender.lid.trim() : '';
  const name = typeof sender.name === 'string' ? sender.name.trim() : '';

  // 决定这个客户在库里的 jid：优先用插件给的 @lid / @c.us 真实标识；
  // 只有昵称时，用昵称稳定哈希当 jid（同名 → 同客户，不会每次新建）。
  let jid;
  if (/@(c\.us|s\.whatsapp\.net|lid|g\.us|broadcast)$/i.test(lid)) jid = lid;
  else if (name) jid = 'ext:' + crypto.createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 16);
  else return { ok: false, error: 'sender 缺少 lid 或 name' };

  // 解码图片（支持 data URI 或裸 base64）
  let b64 = typeof p.image === 'string' ? p.image : '';
  let mime = typeof p.mime === 'string' ? p.mime.toLowerCase() : '';
  const dm = b64.match(/^data:([\w./+-]+);base64,/i);
  if (dm) { if (!mime) mime = dm[1].replace('image/jpg', 'image/jpeg'); b64 = b64.slice(b64.indexOf(',') + 1).replace(/\s+/g, ''); }
  if (!b64) return { ok: false, error: 'image 为空' };
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { return { ok: false, error: 'image 不是合法 base64' }; }
  const realMime = sniffImageType(buf);
  if (!realMime) return { ok: false, error: '不是图片数据（magic 字节不匹配）' };
  mime = realMime;

  // 匹配/建客户（复用现有逻辑，@lid 客户会按 @lid 归并）
  const { customer, isNew } = db.getOrCreateCustomer(accountId, jid, { name: name || '', phone: '', phoneSrc: '', region: '' });

  // 落盘到媒体目录（沿用 handleMessage 的命名风格：code_ts_rand.ext）
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' })[mime] || 'jpg';
  const ts = Number(p.ts) || Math.floor(Date.now() / 1000);
  const fname = `${customer.code}_${ts}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const full = path.join(MEDIA_DIR, fname);
  fs.writeFileSync(full, buf);

  const caption = (typeof p.caption === 'string' && p.caption.trim()) ? p.caption.trim() : '[图片]';
  const saved = db.saveMessage({
    customerCode: customer.code,
    accountId,
    direction: 'in',
    body: caption,
    mediaPath: full,
    mediaSrc: 'extension',
    mediaType: 'image',
waMsgId: `ext_${ts}_${crypto.randomBytes(6).toString('hex')}`,
    msgTs: new Date(ts * 1000).toISOString(),
    silent: false,
  });
  if (!saved.changes) return { ok: true, code: customer.code, msgId: saved.id, isNew, duplicate: true };

  const fresh = db.getCustomer.get(customer.code);
  broadcastSafe('new_message', {
    code: customer.code, isNew, account: accountId, direction: 'in',
    msgId: saved.id, body: caption, bodyZh: '', translating: false,
    mediaPath: full, mediaKind: 'image', mediaType: 'image', mediaSrc: 'extension',
    mediaWaiting: true, unread: fresh?.unread || 0, name: fresh?.name || '', ts: fresh?.last_msg_at,
  });
  // AI 看图写中文说明（复用现有 media.describeLater）
  try {
    if (media.canProcess('image')) {
      media.describeLater(saved.id, customer.code, full, (r) => {
        if (r && r.mediaZh) {
          const c3 = db.getCustomer.get(customer.code);
          if (c3) doc.writeCustomerDoc(c3, db.listMessages.all(customer.code));
        }
        broadcastSafe('translated', { code: r && r.code, msgId: r && r.msgId, bodyZh: '', mediaZh: r && r.mediaZh, kind: r && r.kind, error: r && r.error });
      });
    }
  } catch (e) { /* 不影响主流程 */ }
  broadcastSafe('pending', { code: customer.code, pending: fresh?.pending, unread: fresh?.unread || 0 });
  return { ok: true, code: customer.code, msgId: saved.id, isNew, mediaPath: full };
}

async function handleMessage(account, msg, opts = {}) {
  const silent = opts.silent === true;
  const direction = msg.fromMe ? 'out' : 'in';
  // 自己发出去的消息，对象是 msg.to；收到的是 msg.from
  const jid = msg.fromMe ? (msg.to || msg.from) : msg.from;
  if (!jid || jid === 'status@broadcast') return null;

  // 空消息（撤回提示 / 加密提示 / 通话记录 / 表情回应……）**不入库、不显示**。
  // 放在建客户之前：不然一个"对方撤回了一条消息"就能凭空造出一个客户。
  const text = messageText(msg);
  if (!text) {
    console.log(`[跳过空消息] ${jid} · ${msg.type || '未知类型'}`);
    return null;
  }

  // 身份（名字 + 电话）：走 src/identity.js —— 1.34 版的 Message 上已经没有 notifyName，
  // 只能问 Contact 要；@lid 会话的号码也必须问 Contact 才拿得到。
  // jid 显式传进去：自己发出的消息要用 msg.to（否则全部落到自己身上，缓存会撞车认错人）。
  const ident = await identity.resolve(msg, { client: opts.client, jid });

  const { customer, isNew } = db.getOrCreateCustomer(account.id, jid, {
    name: ident.name || safeName(msg),
    phone: ident.phone || '',
    // 号码来源标记（2026-10-07）：e164/jid/contact/text —— 判"要不要重抓对比"用
    phoneSrc: ident.phoneSrc || '',
    // 抓到的号码反查出的国家（国际区号→国家），写进地区，方便按国别跟进油画客户
    region: ident.country || '',
    // 「模拟新消息」造出来的客户标一下，方便一键清空时只删它们（真实客户一条不碰）
    isSim: opts.sim === true || msg.__sim === true,
  });

  // 老客户建号时没抓到名字/电话，这次抓到了就补上（只填空、不覆盖）
  if (!isNew) {
    if (db.backfillIdentity(customer.code, ident)) {
      broadcastSafe('identity', { code: customer.code, name: ident.name, phone: ident.phone });
    }
    /*
     * 重抓对比（2026-10-07 老板要求："号码为空就抓取；号码没有 + 就重新提取，跟原来对比"）。
     * 因为加号在取号链路里已被剥掉（见 identity.js SRC_RANK 注释），
     * 实际判据是**来源强度**：只有弱来源（text / 空）才值得再抓一次。
     * 对比结果分四种：填上 / 只升级来源标记 / 号码冲突（不覆盖，提示人工判断）/ 不动。
     */
    if (direction === 'in' && opts.client && !opts.noRegrab) {
      try {
        const c0 = db.getCustomer.get(customer.code);
        const curSrc = String(c0?.phone_src || '');
        const curPhone = String(c0?.phone || '').trim();
        const weak = !curPhone || curSrc === 'text' || curSrc === '';
        // 已有强来源（e164/contact/jid）就别折腾了，别去打扰正在用的浏览器
        if (weak) {
          const again = await identity.resolve(msg, {
            client: opts.client, jid, force: true, scrapeDom: false,
          });
          if (again.phone) {
            const r = db.applyRegrab(customer.code, again);
            if (r.action === 'conflict') {
              console.warn(`[${customer.code}] 号码冲突：库里 ${r.oldPhone}，重抓得到 ${r.newPhone} —— 已保留原号，请人工确认`);
              broadcastSafe('phoneConflict', { code: customer.code, oldPhone: r.oldPhone, newPhone: r.newPhone });
            } else if (r.action === 'filled' || r.action === 'upgraded') {
              broadcastSafe('identity', { code: customer.code, name: again.name, phone: r.newPhone });
            }
          }
        }
      } catch (e) {
        /* 重抓失败绝不影响主流程（消息已经入库了） */
      }
    }
  }

  /*
   * 取图。2026-10-08 起是**两级**：
   *   第一级 saveMedia() —— 拿事件对象直接试（快，命中就命中）
   *   第二级 路B+C —— 事件对象残缺（hasMedia 误判 false）时，回页面重取完整对象
   *     + 强制解密 + 压到约 10KB。这是唯一能拿到真原图的路径。
   *
   * 为什么第二级要同步等它跑完：新消息气泡是用户第一眼看到的东西，
   * 当场拿不到就得先显示占位符再等几秒，体验上像"消息坏了"。
   * 页面不在线时mediaRaw 会秒退（返回 null），不会卡住。
   */
  let mediaSaved = silent ? null : await saveMedia(msg, customer.code);

  // 🔴 没拿到真图、且确实是条媒体消息 → 立刻试路B+C
  const looksMediaMsg = !!msg.hasMedia || !!MEDIA_TYPES[String(msg.type || '').toLowerCase()];
  if (!silent && direction === 'in' && (!mediaSaved || mediaSaved.src === 'none') && looksMediaMsg && !BASE64_ONLY_MODE) {
    // 🔴 诊断日志（2026-10-09）：先记录这张图用的是「完整 _serialized」还是「裸哈希」id ——
    //    这是路B 能不能在页面 Msg.get(id) 捞到完整对象的关键前提（裸哈希必捞不到）。
    const rawId = msg.id?._serialized || msg.id?.id || null;
    const idKind = msg.id?._serialized ? '完整_serialized' : (msg.id?.id ? '裸哈希' : '空');
    console.log(`[media][诊断] 进入 B+C | id类型=${idKind} type=${msg.type} from=${msg.from || ''}`);
    try {
      const raw = await mediaRaw.fetchRawImage(
        opts.client || clientOf(account.id),
        // 🔴 2026-10-09：必须传**完整** id（_serialized）。
        //    这里原来传 msg.id.id（裸哈希）→ 页面 Msg.get(hash) 捞不到 → 实时路B+C 必然失败。
        rawId,
        customer.code,
        MEDIA_DIR,
        String(msg.type || 'image'),
      );
      if (raw && raw.path) {
        console.log(`[media][诊断] B+C 成功 | src=${raw.src} kind=${raw.kind} → ${raw.path}`);
        mediaSaved = { path: raw.path, src: raw.src, mimetype: raw.mimetype, kind: raw.kind };
      } else {
        console.log(`[media][诊断] B+C 未产出文件 | raw=${raw ? JSON.stringify(raw) : 'null'}`);
      }
    } catch (e) {
      /* 拿不到就还是占位符，后面 mediaFetch 会继续重试 */
      console.warn('[media] B+C 即时抓取失败：', (e && e.message) || e);
    }
  }

  const mediaPath = mediaSaved ? mediaSaved.path : null;
  /*
   * 🔴 mediaType 优先用 msg.type 这个「真实身份」，没有才退回按扩展名猜。
   *   原因：贴纸存下来就是 .webp，而 webp 在 IMAGE_EXT 里 → 贴纸会被当成图片。
   *   media.kindOf() 保留着当兜底（老数据 media_type 为空时还能正常显示）。
   */
  const mediaType = (mediaSaved && mediaSaved.kind) || media.kindOf(mediaPath) || '';
  // 只有真图/真语音才排AI 看图；贴纸/视频不排（省 token，也避免看贴纸浪费）
  const aiKind = media.kindOf(mediaPath);
  const mediaPending = !silent && direction === 'in' && !!mediaPath && media.canProcess(aiKind);
  /*
   * 媒体来源（2026-10-07）：download = 官方下载的真原图（永久有效）；
   * base64 = 从消息正文里救出来的（当天就能看到，但消息刷新后可能失效）；
   * none = 是媒体消息但没拿到图→ 界面显示占位符，不留空白气泡。
   */
  const mediaSrc = mediaSaved ? mediaSaved.src : '';

  /*
   * ==== 2026-10-07 v1.1.0：登记原始 msg，供「延时重抓」回来看 ====
   *
   * 为什么需要登记：directPath 没到时saveMedia 拿不到图，只能记成none。
   * 几秒后directPath 到了，我们要**拿回同一个 msg 对象**再抓一次 ——
   * 而 msg 对象此刻已经从事件循环里消失了，不登记就没法重抓。
   *
   * 键用「账号 + waMsgId」：waMsgId 才是 WhatsApp 侧的稳定唯一标识，
   * 用数据库主键 id 会在历史同步重复入库时对不上。
   * 只留最近 300 条（内存态，够用；重启后靠历史同步重新登记）。
   */
  // 🔴 2026-10-09：登记键必须和入库用的 waMsgId **完全一致**，
  //    否则 recallMsg 查不到（存的是完整 id，登记却存裸哈希 → 永远miss）。
  //    统一用 _serialized（完整 id）。
  const fullMsgId = msg.id?._serialized || msg.id?.id || null;
  if (!silent && direction === 'in' && fullMsgId) {
    rememberMsg(account.id, fullMsgId, msg, opts.client);
  }

  const saved = db.saveMessage({
    customerCode: customer.code,
    accountId: account.id,
    direction,
    body: text,
    mediaPath,
    mediaSrc,
    mediaType,
    // 🔴 2026-10-09 必须存**完整**消息 id（形如 `false_15551234567@c.us_ABC123`），
    //    不能存msg.id.id —— 那是裸哈希（如 3A4B19FD344E51BE654E）。
    //    原因：补抓图片的路B 要拿这个 id 回页面 `Msg.get(id)` 重新捞完整对象
    //    （官方 downloadMedia 自己用的也是 msg.id._serialized，见 whatsapp-web.js
    //    Message.js:367）。存了裸哈希 → 页面捞不到 → 补抓必然失败。
    //    生产库实测：客户发来的图 media_fetch_state='fail'、重试 7 次全灭，就是这个原因。
    waMsgId: msg.id?._serialized || msg.id?.id || null,
    msgTs: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : new Date().toISOString(),
    silent,
  });

  if (!saved.changes) return customer; // 已存在，跳过重复处理

  const fresh = db.getCustomer.get(customer.code);

  // 要不要翻：只翻客户发来的（红线 + 省一半成本），本来就是中文的不翻
  const needsTr = !silent
    && direction === 'in'
    && !!msg.body
    && translator.needsTranslation(msg.body)
    && ai.isReady('translate');

  if (!silent && direction === 'in') {
    // 🔴 一律用 text（已过滤 base64 的干净正文），别用 msg.body。
    //    图片消息的 msg.body 是整串 data:image/...;base64，切前 40/80 个字符
    //    出来还是一屏乱码 —— 系统通知和页面提示会直接弹出「data:image/png;ba…」。
    console.log(`[${customer.code}] ${fresh?.name || ''}：${text.slice(0, 60)}`);
    notify(`${fresh?.name || '新消息'} · ${customer.code}`, text.slice(0, 80));
    notice(`新消息 · ${fresh?.name || customer.code}：${text.slice(0, 40)}`, 'info');

    // 先推！bodyZh 这里一定是空的——翻译结果稍后由 translated 事件补
    broadcastSafe('new_message', {
      code: customer.code,
      isNew,
      account: account.id,
      direction,
      msgId: saved.id,
      body: text,
      bodyZh: '',
      translating: needsTr,
      mediaPath: mediaPath || '',
      mediaKind: mediaType || '',
      // 真实媒体身份（image/sticker/video/audio）：贴纸不再被当成图片显示
      mediaType: mediaType || '',
      // 2026-10-07 加：是"官方下载的真图"还是"从正文里救出来的临时图"
      mediaSrc: mediaSrc || '',
      mediaWaiting: mediaPending,
      unread: fresh?.unread || 0,
      name: fresh?.name || '',
      ts: fresh?.last_msg_at,
    });
  }

  // 我在 WhatsApp 里回给客户的话：也要当场推进界面（用户 2026-09-26 要求，重要）
  //   为什么必须推：回复一出现，底部「✓ 标记已回复」才会亮；不推的话，
  //   用户得先点开这个客户才看得到"我刚回了什么"，按钮也不会亮。
  //   注意：这条不弹系统通知、不改未读（那是"客户发来"才做的事）。
  if (!silent && direction === 'out') {
    console.log(`[${customer.code}] 我 → ${text.slice(0, 60)}`);
    broadcastSafe('out_message', {
      code: customer.code,
      account: account.id,
      direction: 'out',
      msgId: saved.id,
      body: text,
      mediaPath: mediaPath || '',
      // 2026-10-07 加：不带 mediaKind，我发出去的图片在界面上就只有一行文件名、没有缩略图
      mediaKind: mediaType || '',
      // 真实媒体身份（image/sticker/video/audio）：贴纸不再被当成图片显示
      mediaType: mediaType || '',
      mediaSrc: mediaSrc || '',
      name: fresh?.name || '',
      pending: fresh?.pending || 0,
      unread: fresh?.unread || 0,
      ts: fresh?.last_msg_at,
    });
  }

  // 翻译丢后台：不 await，界面不用等它
  if (needsTr) {
    translator.translateLater(saved.id, customer.code, msg.body, (r) => {
      broadcastSafe('translated', r);
      // 译文也要进客户档案文档，所以翻完重写一次
      if (r.bodyZh) {
        const c2 = db.getCustomer.get(customer.code);
        if (c2) doc.writeCustomerDoc(c2, db.listMessages.all(customer.code));
      }
    });
  }

  // 客户发来的图片 / 语音也丢后台：AI 看完听完写出中文说明，再补到界面上
  // （图片走 ⑤ 看图，语音走 ⑥ 听录音；视频还没接）
  if (mediaPending) {
    media.describeLater(saved.id, customer.code, mediaPath, (r) => {
      if (r.mediaZh) {
        const c3 = db.getCustomer.get(customer.code);
        if (c3) doc.writeCustomerDoc(c3, db.listMessages.all(customer.code));
      }
      broadcastSafe('translated', { code: r.code, msgId: r.msgId, bodyZh: '', mediaZh: r.mediaZh, kind: r.kind, error: r.error });
    });
  }

  if (fresh) doc.writeCustomerDoc(fresh, db.listMessages.all(customer.code));

  // 有媒体没抓到 → 唤醒延时重抓（第一轮 10 秒后）
  if (!silent && direction === 'in' && !mediaPath) {
    mediaFetch.notify();
  }

  broadcastSafe('pending', {
    code: customer.code,
    pending: db.getCustomer.get(customer.code)?.pending,
    unread: db.getCustomer.get(customer.code)?.unread || 0,
  });
  return customer;
}

/* ================================================================
 * 图片延时重抓（2026-10-07 v1.1.0）
 *
 * 场景：客户刚发来图片，directPath 还没到 → 第一次没抓到（media_src='none'）。
 * 几秒后directPath 到了，我们拿回同一个 msg 对象再抓一次。
 *
 * 🔴 和「已读」完全无关：全项目没有 sendSeen / markRead，
 *   抓图只依赖 directPath 和消息正文，不需要为了看图去点已读。
 * ================================================================ */

/**
 * 真正去抓一条消息的图。
 *
 * 2026-10-08 重写：接入路B + 路C。生产库实测 `download` 路 **0 成功**，
 * 16 张图全是 base64 里的占位图（12 张 70 字节 1×1 PNG + 4 张 5KB 缩略图）。
 *
 * 现在按顺序试，每步成功就返回：
 *   ① 路B+C（mediaRaw）：拿 msgId **回页面重新取完整对象** → 强制解密 → 压到约 10KB
 *      ← 新增，这是唯一能拿到真原图的路径
 *   ② 官方 downloadMedia()（对事件对象有效时）
 *   ③ 兜底：从消息正文里再捞一次 base64（可能是占位图，但聊胜于无）
 *
 * @param {object} row messages 那一行（需要 account_id / wa_msg_id / customer_code / media_type）
 * @returns {Promise<{path:string,src:string,mimetype:string,kind:string}|null>}
 */
async function refetchMedia(row) {
  const rec = recallMsg(row.account_id, row.wa_msg_id);

  // ---- ① 路B+C：回页面取完整对象 → 强制解密 → 压缩落盘 ----
  // 🔴 即使 msgRegistry 里没有登记也要试：路B 靠的是 msgId 回页面捞，
  //    不依赖内存里那个对象。所以这一步放在最前面、不被 rec 挡住。
  const kindOfRow = String(row.media_type || 'image').toLowerCase();
  try {
    const raw = await mediaRaw.fetchRawImage(
      rec && rec.client ? rec.client : clientOf(row.account_id),
      row.wa_msg_id,
      row.customer_code,
      MEDIA_DIR,
      kindOfRow,
    );
    if (raw && raw.path) {
      console.log(`[media-fetch] 第 ${row.id} 条走通 B+C：${raw.src} ${raw.path}`);
      return raw;
    }
  } catch (e) {
    console.warn(`[media-fetch] 第 ${row.id} 条 B+C 失败：`, (e && e.message) || e);
  }

  if (!rec || !rec.msg) {
    /*
     * 登记里没有 —— 有两种情况：
     *   ① 程序重启后，历史同步还没把这条消息重新登记
     *   ② 这条太老，早被挤出 300 条上限
     * 两种都别硬抓（抓不到就是抓不到），老实记账让下一轮再试。
     * 历史同步那批会重新走 handleMessage → 重新登记，所以等得起。
     */
    return null;
  }
  return saveMedia(rec.msg, row.customer_code);
}

/**
 * 按 accountId 找运行中的 whatsapp-web.js client。
 * 路B 需要 `client.pupPage` 回页面执行脚本，
 * 而 msgRegistry 可能已经把带 client 的那条挤掉了 → 这里兜底查会话表。
 *
 * @param {string} accountId
 * @returns {object|null} whatsapp-web.js client
 */
function clientOf(accountId) {
  if (!accountId) return null;
  const own = runningSessions.get(accountId);
  if (!own) return null;
  // runningSessions 存的是 session 对象（{ session/browser/... }），
  // client 就是我们要的那个，字段名就叫 client。
  return own.client || own.session || null;
}

/**
 * 补抓到图之后：更新界面 + 排 AI 看图 + 重写客户档案。
 *
 * 界面这边复用现有的 'translated' 事件（它本来就带 mediaZh/mediaPath 刷新逻辑），
 * 另加一个 mediaFetched 事件让前端把占位符换成真图。
 */
function onMediaFetched({ code, row, saved }) {
  if (!row) return;
  const kind = saved.kind || media.kindOf(saved.path) || '';
  // 只有真图/真语音才排 AI 看图（贴纸/视频不排，省 token）
  if (media.canProcess(kind)) {
    media.describeLater(row.id, code, saved.path, (r) => {
      if (r.mediaZh) {
        const c = db.getCustomer.get(code);
        if (c) doc.writeCustomerDoc(c, db.listMessages.all(code));
      }
      broadcastSafe('translated', {
        code, msgId: r.msgId, bodyZh: '', mediaZh: r.mediaZh, kind: r.kind, error: r.error,
      });
    });
  }
  broadcastSafe('mediaFetched', {
    code,
    msgId: row.id,
    mediaPath: saved.path,
    mediaType: kind,
    mediaSrc: saved.src,
  });
  // 档案里的附件汇总要跟着更新
  const c = db.getCustomer.get(code);
  if (c) doc.writeCustomerDoc(c, db.listMessages.all(code));
}

/** 启动延时重抓（startCore 里调；单测不调，避免真的挂定时器） */
function startMediaFetch() {
  // 🔴 方案2 模式：不启动后台补抓（补抓会拿真图替换缩略图，违背「只显示缩略图」）
  if (BASE64_ONLY_MODE) {
    console.log('[media-fetch] 方案2 模式：后台补抓已关闭（BASE64_ONLY_MODE=true）');
    return;
  }
  mediaFetch.start(refetchMedia, onMediaFetched, { reset: false });
}

/**
 * 启动每小时 Word 重建（v1.1.0，方案 A：全量重建 + 图片内嵌 + 小图）
 *
 * 🔴 老板明确要求：Word 里的图**用小图不用原图**，文档才不会太大。
 *   maxEdge 默认 720px（长边），实际输出统一是 JPEG q0.82。
 */
function startWordHourly(opt = {}) {
  return wordDoc.startHourly(Object.assign({
    maxEdge: 720,
    onDone: (r) => {
      // 生成完广播一下，界面想显示"档案 Word 已更新"可以用
      try { broadcastSafe('wordUpdated', r); } catch (e) { /* ignore */ }
    },
  }, opt || {}));
}

/* ---------------- 模拟新消息（测试用，2026-09-25） ----------------
 *
 * 为什么要这个：真连 WhatsApp 要扫码、要等几十秒、还得有人隔着时差配合发消息，
 * 自己想测一遍"翻译→建议→档案"整条链路非常费劲。
 *
 * 关键做法：**不 mock 内部逻辑**，而是造一个和 whatsapp-web.js 的 Message
 * 同形状的假对象（from / to / fromMe / body / id / timestamp / notifyName…），
 * 直接喂给真正的 handleMessage()。所以走的是和真实消息**完全同一条链路**：
 *   入库 → 分配客户编号 → 立刻广播 new_message → 后台翻译 → 写客户档案 → 广播 pending
 * 你在界面上看到的效果，和真客户发来消息时一模一样。
 *
 * 红线不变：这条假消息不会发给任何人（软件本来就没有发送能力），
 * 只是往你自己的本地库里写一条记录。点「清空模拟数据」就能全部删掉。
 */

let simSeq = 0;

async function simulateMessage(opt = {}) {
  const accounts = cfg.accounts || [];
  const accountId = Number(opt.accountId) || (accounts[0] && accounts[0].id) || 1;
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) {
    return { ok: false, error: `没有账号 ${accountId}（config.yaml 里只有 ${accounts.map((a) => a.id).join(' / ')} 号）` };
  }

  const body = String(opt.body == null ? '' : opt.body).trim();
  if (!body) return { ok: false, error: '消息内容不能是空的' };

  const direction = opt.direction === 'out' ? 'out' : 'in';
  const name = String(opt.name || '').trim() || `模拟客户${accountId}号`;
  simSeq += 1;
  // 没给电话就自动编一个不会被真实号码撞上的（+1999 开头）
  const phone = String(opt.phone || '').trim()
    || `+1999${String(accountId).padStart(2, '0')}${String(simSeq).padStart(4, '0')}`;
  const jid = `${phone.replace(/[^\d+]/g, '')}@c.us`;

  const fake = {
    id: { id: `sim-${Date.now()}-${simSeq}`, _serialized: `sim-${Date.now()}-${simSeq}` },
    from: direction === 'out' ? 'me@c.us' : jid,
    to: direction === 'out' ? jid : 'me@c.us',
    fromMe: direction === 'out',
    body,
    hasMedia: false,
    isStatus: false,
    timestamp: Math.floor(Date.now() / 1000),
    notifyName: name,
    pushName: name,
    __sim: true,
    getContact: async () => ({ name, pushname: name, number: phone, isMyContact: false }),
    getChat: async () => ({ id: { _serialized: jid }, isGroup: false, name }),
    downloadMedia: async () => null,
  };

  const customer = await handleMessage(acc, fake, { sim: true });
  if (!customer) return { ok: false, error: '消息没能入库（JID 无效？）' };

  return {
    ok: true,
    simulated: true,
    accountId,
    direction,
    name,
    phone,
    jid,
    code: customer.code,
  };
}

async function clearSimulated() {
  const before = db.countSimulated();
  const r = db.clearSimulated();
  // 清完刷一下界面：左栏 / 待处理 / 今日统计都跟着变
  broadcastSafe('synced', { account: 0, count: r.messages });
  broadcastSafe('pending', { code: '*', pending: db.countUnprocessed(), unread: db.totalUnread() });
  return { ok: true, removed: before, ...r };
}

/* ---------------- 历史同步 ---------------- */

async function syncHistory(account, client) {
  console.log(`[账号${account.id}] 开始同步最近 ${HISTORY_CHATS} 个对话×${HISTORY_MSGS} 条（不翻译、不置为待办）`);
  let chats = [];
  try {
    chats = await client.getChats();
  } catch (e) {
    console.warn(`[账号${account.id}] 获取对话列表失败：${e.message}`);
    return;
  }

  let count = 0;
  const t0 = Date.now();
  for (const chat of chats.slice(0, HISTORY_CHATS)) {
    if (chat.isGroup) continue;
    try {
      const msgs = await chat.fetchMessages({ limit: HISTORY_MSGS });
      for (const m of msgs.reverse()) {
        await handleMessage(account, m, { silent: true, client });
        count++;
      }
    } catch (e) {
      // 单个对话失败不影响整体
    }
    if ((count % 100) < HISTORY_MSGS) {
      notice(`账号${account.id} 正在同步历史对话… 已入库 ${count} 条`, 'info');
    }
  }
  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  console.log(`[账号${account.id}] 历史同步完成，入库 ${count} 条（${secs}s）`);
  notice(`账号${account.id} 历史同步完成，入库 ${count} 条`, 'ok');
  broadcastSafe('synced', { account: account.id, count });
}

/* ---------------- 启动 ---------------- */

let broadcast = () => {};
function broadcastSafe(type, payload) {
  try {
    broadcast(type, payload);
  } catch (e) {
    /* 服务还没起来时忽略 */
  }
}

/** 往界面顶上弹一条提示。以前登录/同步都是静默的，用户以为软件坏了 */
function notice(text, level = 'info') {
  console.log(`[提示] ${text}`);
  broadcastSafe('notice', { text, level });
}

/* =====================================================================
 * Signal 消息入库（2026-10-08 v1.5.0）
 *
 * 🔴 这一段是「Signal 收到新消息但左栏没反应」的真正解法。
 *    上一版只做了状态灯（告诉界面能不能用），采集模块根本没写，
 *    所以 Signal 的消息从来没进过数据库。
 *
 * 走的是和 WhatsApp **完全相同**的后半段链路：
 *   getOrCreateCustomer → saveMessage →广播 new_message/out_message → 翻译
 * 所以左栏分栏、中栏气泡、翻译、AI 建议全部直接复用，界面上不用为 Signal 另写一套。
 *
 * 与 WhatsApp 侧刻意不同的地方（都是被现实逼出来的，不是偷懒）：
 *   ① 不查号码：WhatsApp 那边要开浏览器抓资料卡，Signal 这边 e164 字段直接可读，
 *      实测这家客户是 null（对方没存号码），所以电话允许留空，只记 phoneState。
 *   ② 不重抓：同上，没有可抓的地方，反复调只会白费力气。
 *   ③ 不处理媒体：图片/语音的解密链路还没做（Signal 附件是 AES-CBC+HMAC，
 *      和 WhatsApp 的 base64 直读完全不同）。现在先只入文字，
 *      附件消息留占位，绝不假装"抓到了"。
 */

/**
 * 处理一条 Signal 消息。
 * @param {object} m signalRead.toMessage() 产出的统一结构
 */
function handleSignalMessage(m) {
  const { customer, isNew } = db.getOrCreateCustomer(
    SIGNAL_ACC.id,
    m.displayJid,
    {
      name: m.name || '',
      phone: m.phone || '',
      // 🔴 Signal 的号码来源就是 conversations.e164 字段本身，
      //    强度等同 WhatsApp 的 e164，标记清楚，别让后面"要不要重抓"的逻辑误判。
      phoneSrc: m.phone ? 'e164' : '',
      channel: 'signal',
    },
  );

  if (!customer) return null;

  // 老客户这次抓到名字/电话了就补上（只填空、不覆盖）
  if (!isNew && (m.name || m.phone)) {
    const patched = db.backfillIdentity(customer.code, { name: m.name, phone: m.phone });
    if (patched) broadcastSafe('identity', { code: customer.code, name: m.name, phone: m.phone });
  }

  const saved = db.saveMessage({
    customerCode: customer.code,
    accountId: SIGNAL_ACC.id,
    direction: m.direction,
    body: m.body,
    /*
     * 🔴 附件：Signal 的图片/语音还没接解密链路。
     *    mediaPath 留空 → saveMessage 会把 incoming 标成 media_fetch_state='pending'，
     *    界面上显示成"有张图"的占位，而不是留一个空白气泡。
     *    🔴 绝不能在这里假装抓到 —— 编一个假路径，界面上会显示一张永远打不开的图。
     */
    mediaPath: '',
    mediaSrc: 'none',
    mediaType: m.hasAttachment && !m.body.trim() ? 'image' : '',
    /*
     * 🔴 'na' = 不适用：Signal 附件（AES-CBC+HMAC 加密）还没接解密链路。
     *    写 'na' 而不是留空/pending，是因为：
     *    pending 会被图片延时重抓捞走，然后拿 WhatsApp 浏览器去处理一个
     *    wa_jid='sig:xxx' 的客户 —— 那个客户根本不在任何 WhatsApp 会话里，
     *    必然抓不到，只会白烧重试预算 + 刷一堆假失败日志。
     *    附件解密做完后，这里改成 pending 即可（listPendingMedia 已排除 signal，
     *    到时要同步放开那个条件）。
     */
    mediaFetchState: 'na',
    // 用 Signal 的消息 UUID：全局唯一，INSERT OR IGNORE 天然幂等，
    // 重复采集 / 重启后重捞都不会产生重复行或重复提醒。
    waMsgId: m.msgId,
    msgTs: m.ts,
  });

  if (!saved.changes) return customer; // 已在库里（重启后重捞历史），静默跳过

  const fresh = db.getCustomer.get(customer.code);

  // 只翻客户发来的（红线 + 省一半成本），本来就是中文的不翻
  const needsTr = m.direction === 'in'
    && !!m.body
    && translator.needsTranslation(m.body)
    && ai.isReady('translate');

  if (m.direction === 'in') {
    console.log(`[${customer.code}] ${fresh?.name || ''}(Signal)：${m.body.slice(0, 60)}`);
    notify(`${fresh?.name || 'Signal 新消息'} · ${customer.code}`, m.body.slice(0, 80));
    notice(`Signal 新消息 · ${fresh?.name || customer.code}：${m.body.slice(0, 40)}`, 'info');

    // 先推！bodyZh 一定是空的 —— 翻译结果稍后由 translated 事件补
    broadcastSafe('new_message', {
      code: customer.code,
      isNew,
      account: SIGNAL_ACC.id,
      channel: 'signal',
      direction: m.direction,
      msgId: saved.id,
      body: m.body,
      bodyZh: '',
      translating: needsTr,
      mediaPath: '',
      mediaKind: m.hasAttachment && !m.body.trim() ? 'image' : '',
      mediaType: m.hasAttachment && !m.body.trim() ? 'image' : '',
      mediaSrc: 'none',
      mediaWaiting: false,
      unread: fresh?.unread || 0,
      name: fresh?.name || '',
      ts: fresh?.last_msg_at,
    });
  } else {
    console.log(`[${customer.code}] 我 → (Signal) ${m.body.slice(0, 60)}`);
    broadcastSafe('out_message', {
      code: customer.code,
      account: SIGNAL_ACC.id,
      channel: 'signal',
      direction: 'out',
      msgId: saved.id,
      body: m.body,
      mediaPath: '',
      mediaKind: '',
      mediaType: '',
      mediaSrc: 'none',
      name: fresh?.name || '',
      pending: fresh?.pending || 0,
      unread: fresh?.unread || 0,
      ts: fresh?.last_msg_at,
    });
  }

  // 翻译丢后台：不await，界面不用等
  if (needsTr) {
    translator.translateLater(saved.id, customer.code, m.body, (r) => {
      broadcastSafe('translated', r);
      if (r.bodyZh) {
        const c2 = db.getCustomer.get(customer.code);
        if (c2) doc.writeCustomerDoc(c2, db.listMessages.all(customer.code));
      }
    });
  }

  return customer;
}

/**
 * 处理一条 Telegram 消息（仿 handleSignalMessage）。
 * @param {object} m telegramRead.toMessage() 产出的统一结构
 *
 * 与 WhatsApp / Signal 同构：getOrCreateCustomer → saveMessage → 广播 new_message/out_message
 * → 翻译。左栏分栏、中栏气泡、翻译、AI 建议全部直接复用，界面上不用为 Telegram 另写一套。
 *
 * 与 WhatsApp 刻意不同的地方（被现实逼出来的，不是偷懒）：
 *   ① 不查号码：Telegram 网页版 DOM 里拿不到对方手机号（隐私），电话允许留空，只记 phoneState='pending'。
 *   ② 不处理媒体：Telegram 网页版媒体（图/文件）的解密链路还没做；现在先只入文字，
 *      附件消息留占位（mediaSrc='none'），绝不假装"抓到了"。
 */
function handleTelegramMessage(m) {
  const acc = TELEGRAM_ACCS.find((a) => a.id === m.accountId) || { id: 7 };
  const accountId = acc.id;

  const { customer, isNew } = db.getOrCreateCustomer(
    accountId,
    m.displayJid,
    {
      name: m.name || '',
      phone: '',
      // Telegram 网页版拿不到号码，来源强度等同"没有"，绝不触发 WA 那套"要不要重抓对比"
      phoneSrc: '',
      channel: 'telegram',
    },
  );

  if (!customer) return null;

  // 老客户这次抓到名字了就补上（只填空、不覆盖）
  if (!isNew && m.name) {
    const patched = db.backfillIdentity(customer.code, { name: m.name, phone: '' });
    if (patched) broadcastSafe('identity', { code: customer.code, name: m.name, phone: '' });
  }

  // v2.5.1032：抓到 @username 就存下来（只填空、不覆盖）—— 这是「跳到聊天」走官方深链的依据。
  // 有新客户也有老客户两种情形：新客户刚建完也要写，所以放在这里统一处理。
  if (m.username) db.saveTgUsername(customer.code, m.username);

  const saved = db.saveMessage({
    customerCode: customer.code,
    accountId,
    direction: m.direction,
    body: m.body,
    mediaPath: '',
    mediaSrc: 'none',
    mediaType: m.hasAttachment && !m.body.trim() ? 'image' : '',
    mediaFetchState: 'na', // 同 Signal：附件解密未接，写 'na' 别让它被 WhatsApp 重抓链路捞走
    // 用 chatKey + msgId 拼成全局唯一键：同一消息重复采集/重捞不会重复入库
    waMsgId: `${m.customerKey}:${m.msgId}`,
    msgTs: m.ts,
  });

  if (!saved.changes) return customer; // 已在库里（重复采集），静默跳过

  const fresh = db.getCustomer.get(customer.code);

  // 只翻客户发来的（红线 + 省成本），本来就是中文的不翻
  const needsTr = m.direction === 'in'
    && !!m.body
    && translator.needsTranslation(m.body)
    && ai.isReady('translate');

  if (m.direction === 'in') {
    console.log(`[${customer.code}] ${fresh?.name || ''}(Telegram)：${m.body.slice(0, 60)}`);
    notify(`${fresh?.name || 'Telegram 新消息'} · ${customer.code}`, m.body.slice(0, 80));
    notice(`Telegram 新消息 · ${fresh?.name || customer.code}：${m.body.slice(0, 40)}`, 'info');

    broadcastSafe('new_message', {
      code: customer.code,
      isNew,
      account: accountId,
      channel: 'telegram',
      direction: m.direction,
      msgId: saved.id,
      body: m.body,
      bodyZh: '',
      translating: needsTr,
      mediaPath: '',
      mediaKind: m.hasAttachment && !m.body.trim() ? 'image' : '',
      mediaType: m.hasAttachment && !m.body.trim() ? 'image' : '',
      mediaSrc: 'none',
      mediaWaiting: false,
      unread: fresh?.unread || 0,
      name: fresh?.name || '',
      ts: fresh?.last_msg_at,
    });
  } else {
    console.log(`[${customer.code}] 我 → (Telegram) ${m.body.slice(0, 60)}`);
    broadcastSafe('out_message', {
      code: customer.code,
      account: accountId,
      channel: 'telegram',
      direction: 'out',
      msgId: saved.id,
      body: m.body,
      mediaPath: '',
      mediaKind: '',
      mediaType: '',
      mediaSrc: 'none',
      name: fresh?.name || '',
      pending: fresh?.pending || 0,
      unread: fresh?.unread || 0,
      ts: fresh?.last_msg_at,
    });
  }

  if (needsTr) {
    translator.translateLater(saved.id, customer.code, m.body, (r) => {
      broadcastSafe('translated', r);
      if (r.bodyZh) {
        const c2 = db.getCustomer.get(customer.code);
        if (c2) doc.writeCustomerDoc(c2, db.listMessages.all(customer.code));
      }
    });
  }

  return customer;
}

/**起Signal 轮询。任何异常都不能挡软件启动。 */
function startSignalPolling() {
  // 🔴 多实例：从启动器拿 S1~S5 各自的独立数据目录，逐个实例轮询。
  //    拿不到（启动器没初始化）就退回只轮询默认 Signal，向后兼容。
  let dirs = null;
  try {
    if (launcher && typeof launcher.signalDirs === 'function') {
      const d = launcher.signalDirs();
      if (d && d.length) dirs = d;
    }
  } catch (e) {
    dirs = null;
  }
  const poller = signalRead.startPolling({
    dirs,
    /*
     * 🔴 v2.5.1036：本轮要不要真的去读 Signal 加密库。
     *    总闸没开 → 不动；进程扫描正占着「前 3 秒 + 后 1 秒」静默窗口 → 跳过本轮。
     *    水位不动，闸开了下一轮从老水位继续读，只是晚几秒，不丢消息。
     */
    shouldRun: () => prewarm.ready() && !prewarm.blocked(),
    onMessages(batch) {
      for (const m of batch) {
        // 🔴 一条失败不能连累后面那条：否则一条坏数据会让这批全部卡住不落库
        try {
          handleSignalMessage(m);
        } catch (e) {
          console.warn(`[signal] 单条消息处理失败（不影响其余）：${(e && e.message) || e}`);
        }
      }
      broadcastSafe('pending', { code: '*', pending: db.countUnprocessed(), unread: db.totalUnread() });
    },
    onState(st) {
      if (st && st.ok === false) {
        console.warn(`[signal] 采集读不到：${st.reason}`);
      }
    },
  });
  return poller;
}

/**
 * Telegram 采集回调（v2.5.1039 抽出来，循环①/循环② 共用同一套）。
 * 每个启用的 Tele 账号拉起一个独立 Chrome 开 web.telegram.org，注入脚本读消息，
 * 经 handleTelegramMessage 走和 WA / Signal 完全一样的写库 / 翻译 / 广播链路。
 */
function telegramHooks() {
  return {
    onMessages(batch) {
      // 🔴 v2.5.1036：循环③ 进程扫描正占着静默窗口 → 本轮让路（闸开了下一轮再读，不丢消息）
      if (prewarm.blocked()) return;
      for (const m of batch) {
        // 🔴 一条失败不能连累后面那条：否则一条坏数据会让这批全部卡住不落库
        try {
          handleTelegramMessage(m);
        } catch (e) {
          console.warn(`[telegram] 单条消息处理失败（不影响其余）：${(e && e.message) || e}`);
        }
        // v2.5.1085：把收到的消息实时广播给前端（Tele① 应用版原生界面即时刷新）
        if (m && m.accountId >= 7) broadcastSafe('telegram_message', m);
      }
      broadcastSafe('pending', { code: '*', pending: db.countUnprocessed(), unread: db.totalUnread() });
    },
    onState(st) {
      // 把采集器报上来的账号状态同步进 accountStates，顶栏账号条的灯才准
      if (st && st.id != null) {
        const prev = accountStates.get(st.id);
        if (prev) accountStates.set(st.id, { ...prev, status: st.status });
      }
      if (!st || st.id == null) return;
      const teleNo = st.id >= 7 ? st.id - 6 : st.id;
      const label = `Telegram（${teleNo}号）`;
      let text = '';
      let level = 'info';
      if (st.status === 'login_required') {
        text = `${label}：需要登录（点左栏「去登录」按钮，在软件里填手机号 + 验证码即可）`;
        level = 'warn';
      } else if (st.status === 'selector_issue') {
        text = `${label}：窗口已打开，但读不到消息（Telegram 网页可能改版，选择器失效，需要修）`;
        level = 'error';
      } else if (st.status === 'collecting') {
        // 🔴 v2.5.1052：把「聊天列表扫到多少项 / 几个未读 / 本轮读到几条」摆到状态条上，
        //   让「到底扫没扫到」一眼可见（不再只有一句"收集中"，出问题看不出卡在哪一环）
        const parts = [];
        if (typeof st.chats === 'number') parts.push(`列表 ${st.chats} 项`);
        if (typeof st.unread === 'number') parts.push(`未读 ${st.unread} 个`);
        if (typeof st.read === 'number') parts.push(`本轮读到 ${st.read} 条`);
        text = `${label}：收集中${parts.length ? `（${parts.join('，')}）` : ''}`;
        level = 'ok';
      } else if (st.status === 'starting') {
        text = `${label}：启动中…`;
        level = 'info';
      } else {
        return;
      }
      // 前端左栏状态条常驻显示，让「到底收没收到」一目了然（不再静默失败）
      broadcastSafe('telegram_status', {
        id: st.id, label, status: st.status, read: st.read || 0,
        chats: st.chats || 0, unread: st.unread || 0, text, level,
      });
      if (level === 'warn') notice(text, 'warn');
      else if (level === 'error') notice(text, 'error');
    },
  };
}

/**
 * 启动 Telegram 网页版采集（一次性、幂等）。
 *
 * 🔴 v2.5.1039：老板图里循环①/循环② 都要做「Telegram 开 Chrome 预热」，
 *    所以真正的启动动作收敛成一个幂等的 ensureWatching ——
 *    已经在跑的账号不动，掉了的才补，绝不会重复拉起第二个 Chrome。
 *    本函数保留给「手动/外部一次性打开」用；循环那边走 startBackgroundServices 里的节拍器。
 */
/**
 * 取 Telegram 标签所在、且已连接的浏览器实例。
 * 优先级：
 *   1) 配置里关联的 WA 号浏览器（runningSessions[waAccount]）
 *   2) 兜底：扫描所有已起会话，找带 web.telegram.org 标签的浏览器
 *      —— 即便 waAccount 配错、或 TG 标签开在别的 WA 号窗口里，也能接上
 * 都没找到返回 null。
 */
async function waBrowserFor(tgAccount) {
  if (!tgAccount) return null;
  const waId = Number(tgAccount.waAccount);
  if (waId) {
    const s = runningSessions.get(waId);
    if (s && s.browser && typeof s.browser.isConnected === 'function' && s.browser.isConnected()) {
      try {
        const pages = await s.browser.pages();
        if (pages.some((p) => (p.url() || '').includes('web.telegram.org'))) {
          console.log(`[telegram] 关联 WA${waId} 浏览器已起且含 Telegram 标签，直接复用`);
          return s.browser;
        }
      } catch (e) {}
      // 浏览器在但还没开 TG 标签也先返回，getOrOpenTgPage 会负责新开
      console.log(`[telegram] 关联 WA${waId} 浏览器已起（尚未发现 TG 标签），复用并新开`);
      return s.browser;
    }
  }
  // 兜底扫描
  for (const [, s] of runningSessions) {
    if (s && s.browser && typeof s.browser.isConnected === 'function' && s.browser.isConnected()) {
      try {
        const pages = await s.browser.pages();
        if (pages.some((p) => (p.url() || '').includes('web.telegram.org'))) {
          console.log(`[telegram] 兜底扫描：在另一个 WA 会话里发现 Telegram 标签，复用其浏览器`);
          return s.browser;
        }
      } catch (e) {}
    }
  }
  return null;
}

/**
 * Telegram 账号的代理存在数据库 accounts.proxy（用户在「代理」页设的，浏览器靠它上 Telegram）。
 * teleproto 是 Node 直连，不会自动用浏览器的 --proxy-server，必须把同一串代理喂给它，否则连不上。
 * 这里把 db 里的代理并到账号对象上，再传给 telegramMtproto（config 里的 telegram.proxy 兜底）。
 */
function enrichTgProxy(accounts) {
  let dbProxy = {};
  try {
    for (const r of db.listAccounts().all()) dbProxy[r.id] = r.proxy;
  } catch (e) { /* db 没就绪就忽略，退回 config 代理 */ }
  const tgProxy = (cfg && cfg.telegram && cfg.telegram.proxy) || '';
  return accounts.map((a) => ({ ...a, proxy: a.proxy || dbProxy[a.id] || tgProxy || '' }));
}

function startTelegramWatching() {
  const enabled = enrichTgProxy(TELEGRAM_ACCS.filter((a) => a.enabled));
  if (!enabled.length) {
    console.log('没有启用任何 Telegram 账号：在 config.yaml 的 telegram.accounts 里把 enabled 改成 true');
    return null;
  }

  const hasCred = !!(cfg && cfg.telegram && cfg.telegram.apiId && cfg.telegram.apiHash);

  /* 🔴 A / B 双通道（老板拍板「两份代码彻底分开」，构建期由 BEE_TG_CHANNEL 决定）：
   *   A 版 = MTProto 官方直连。必须配 api_id / api_hash；缺凭证就明确报错，
   *          绝不偷偷退回网页版（否则两个版本行为一样，等于没分开）。
   *   B 版 = 已登录的 Telegram 网页（Tele① 内置浏览器），不需要任何凭证。 */
  if (telegramChannel.IS_A) {
    if (!hasCred) {
      const msg = telegramChannel.CRED_HINT;
      console.log('[A 版] ' + msg);
      broadcastSafe('telegram_mtproto', { error: msg, channel: 'A' });
      return { ensure: () => Promise.resolve([]) };
    }
    /* A 版：官方 MTProto 直连采集，不启动 webview 读取。 */
    telegramOfficialChannel.startWatching({
      accounts: enabled, cfg, hooks: telegramHooks(), dataDir: DATA_ROOT,
    })
      .then((r) => {
        if (r && r.ok && r.opened.length) {
          console.log(`A 版 Telegram MTProto 官方直连已拉起（账号 ${r.opened.join('、')}）`);
        } else if (r && !r.ok) {
          console.warn('A 版 Telegram 启动失败：' + ((r && r.error) || '未知原因'));
        }
      })
      .catch((e) => console.warn('A 版 Telegram 采集启动失败：', e && e.message));
    return {
      ensure: () => telegramOfficialChannel.startWatching({
        accounts: enabled, cfg, hooks: telegramHooks(), dataDir: DATA_ROOT,
      }),
    };
  }

  /* B 版：只走内置浏览器（Tele①）webview 读取，不需要 api_id / api_hash。 */
  {
    const tgwHooks = {
      onMessages: telegramHooks().onMessages,       // 复用同一条入库链路（含 prewarm 让路闸门）
      onState: (st) => broadcastSafe('telegram_webview', st),
    };
    telegramWebView.start(tgwHooks);
    console.log('B 版：Telegram 走内置浏览器（Tele①）读取（免凭证）');
    return { ensure: () => telegramWebView.start(tgwHooks) };
  }
}

/**
 * 登录后补一次身份（2026-09-28 加）
 *
 * 老版本抓不到名字/电话（见 src/identity.js 的说明），库里躺着一批"无名氏"。
 * 账号一上线就按 JID 把这些人挨个问一遍 WhatsApp，把姓名/电话补上。
 * 只补空的、绝不覆盖用户自己填过的；问不到就跳过，下次登录再试。
 */
async function backfillIdentities(account, client) {
  if (!client) return 0;
  let rows = [];
  try {
    rows = db.listMissingIdentity.all(account.id, 200);
  } catch (e) {
    return 0;
  }
  if (!rows.length) return 0;

  let n = 0;
  for (const c of rows) {
    try {
      // 只给它 JID：resolve 会拿它去问 client.getContactById（force = 不走缓存）；
      // 再带上这位客户最近几条来信的正文 —— LID 会话查不到真号码时，
      // 客户自己打出来的号码是最后一条路（2026-09-29 加，见 identity.phoneFromText）。
      let text = '';
      try {
        text = db.recentInboundText(c.code, 5);
      } catch (e) {
        text = '';
      }
      const info = await identity.resolve(
        { from: c.wa_jid, body: text },
        { client, jid: c.wa_jid, force: true, timeoutMs: 8000, text, scrapeDom: false },
      );
      if (!info.name && !info.phone) continue;
      if (db.backfillIdentity(c.code, info)) {
        n++;
        broadcastSafe('identity', { code: c.code, name: info.name, phone: info.phone });
      }
    } catch (e) {
      /* 单个问不到不影响其它 */
    }
  }
  if (n) notice(`账号${account.id}：补上了 ${n} 位客户的姓名 / 电话`, 'ok');
  return n;
}

async function startSession(account) {
  let session;
  try {
    session = require('./session');
  } catch (e) {
    console.warn(`[账号${account.id}] 未能加载 session.js：${e.message}`);
    startErrors.set(account.id, `未能加载 session.js：${e.message}`);
    return null;
  }

  try {
    // 用启动锁把"拉起浏览器"这一步串行化，避免并发重型会话把资源打挂
    const s = await withLaunchLock(() => session.createSession(account, cfg, {
      onQR: async (acc, qr) => {
        accountStates.get(acc.id).status = 'waiting_qr';
        // 界面上不再显示二维码（主窗口只管三栏工作区）。
        // 扫码在 Chrome 窗口里进行：用户点该账号右边的「浏览器」，窗口会被搬到屏幕里并置顶。
        broadcastSafe('qr', { account: acc.id, needScan: true, status: '待扫码' });
        notice(`账号${acc.id} 需要扫码登录 —— 在它的 Chrome 窗口里扫`, 'warn');
        try {
          const qrterm = require('qrcode-terminal');
          console.log(`\n[账号${acc.id}] 请用 WhatsApp 扫描下面的二维码：`);
          qrterm.generate(qr, { small: true });
        } catch (e) {
          console.log(`[账号${acc.id}] 二维码：${qr}`);
        }
      },
      onReady: async (acc, client) => {
        accountStates.get(acc.id).status = 'online';
        db.setAccountStatus.run('online', new Date().toISOString(), acc.id);
        broadcastSafe('account', { id: acc.id, status: 'online' });
        notice(`账号${acc.id} 已登录 WhatsApp，正在同步最近对话…`, 'ok');
        try {
          await syncHistory(acc, client);
        } catch (e) {
          console.error(`[账号${acc.id}] 同步失败：`, e.message);
          notice(`账号${acc.id} 同步失败：${e.message}`, 'error');
        }
        // 补身份：库里缺姓名/电话的老客户，趁浏览器在线挨个问一遍
        try {
          await backfillIdentities(acc, client);
        } catch (e) {
          console.warn(`[账号${acc.id}] 补身份失败：`, e.message);
        }
      },
      onMessage: async (acc, client, msg) => {
        try {
          // client 传进去：identity 拿不到联系人时还能退到 client.getContactById
          await handleMessage(acc, msg, { client });
        } catch (e) {
          console.error(`[账号${acc.id}] 处理消息出错：`, e.message);
        }
      },
      onDisconnected: (acc) => {
        accountStates.get(acc.id).status = 'offline';
        db.setAccountStatus.run('offline', new Date().toISOString(), acc.id);
        broadcastSafe('account', { id: acc.id, status: 'offline' });
      },
      onError: (acc, err) => {
        console.error(`[账号${acc.id}] 错误：`, err?.message || err);
      },
    }));
    runningSessions.set(account.id, s);
    // Chrome 窗口被用户关掉时，puppeteer 的 Browser 会触发 disconnected：
    // 主动清掉 runningSessions 记录 + 把状态灯变红，这样再点账号名能干净地重新拉起，
    // 而不是去 reveal 一个已经死了的浏览器。否则会出现"关了就再也打不开"的现象。
    try {
      s.browser.on('disconnected', () => {
        console.warn(`[账号${account.id}] 浏览器窗口被关闭，会话失效`);
        runningSessions.delete(account.id);
        const st = accountStates.get(account.id);
        if (st) st.status = 'offline';
        broadcastSafe('account', { id: account.id, status: 'offline' });
      });
    } catch (e) { /* 个别 puppeteer 版本拿不到 event emitter，忽略即可 */ }
    return s;
  } catch (e) {
    const msg = (e && (e.message || e.stack)) || String(e);
    console.error(`[账号${account.id}] 启动失败：${msg}`);
    accountStates.get(account.id).status = 'error';
    runningSessions.delete(account.id);
    startErrors.set(account.id, (e && e.message) || String(e));
    return null;
  }
}

/**
 * 启动整个内核：本地 HTTP 服务 + WhatsApp 采集。
 * Electron 桌面版（electron/main.js）和命令行版都调这一个函数，
 * 保证"桌面应用跑的逻辑"和"浏览器跑的逻辑"是同一份。
 *
 * @param {object} opt {startWhatsApp:boolean}
 * @returns {Promise<{srv:object, PORT:number, broadcast:Function, notice:Function, handleMessage:Function}>}
 */

/** 启动参数副本（供延后的 startBackgroundServices 使用） */
let startOpt = {};
/** 后台服务是否已拉起（幂等：重复调用不会把定时器/浏览器起两份） */
let bgServicesStarted = false;
/** 循环①/② 的 3 秒节拍器（v2.5.1039），供自检 / 排障查看状态 */
let bgLoops = null;

async function startCore(opt = {}) {
  // 记住启动参数：原来开机立刻跑的那些后台重活（Word 每小时重建等）
  // 现在要等登录 + 同步完成后才起，得把选项留到那时候用。
  startOpt = Object.assign({}, opt);
  console.log('蜜蜂信息采集 · 启动中（第一版：WhatsApp 新消息采集）');
  console.log(`数据库：${DATA_ROOT}${path.sep}assistant.db（驱动：${db.driver}）`);

  // 桌面版（electron/main.js）会用 screen.getPrimaryDisplay().workAreaSize 把屏幕可用区域传进来，
  // 用来算每个账号的 Chrome 窗口放哪 —— 级联错开、并保证不出屏（2026-09-25 "五号窗口看不见"）
  if (opt.screenArea && opt.screenArea.width) {
    screenArea = { width: Number(opt.screenArea.width), height: Number(opt.screenArea.height) };
    console.log(`屏幕可用区域：${screenArea.width}×${screenArea.height}（各账号浏览器窗口会错开摆放）`);
  }

  const missing = knowledge.alwaysFiles().filter((f) => !fs.existsSync(path.join(knowledge.knowledgeDir(), f)));
  if (missing.length) console.warn(`知识库缺少文件：${missing.join('、')}`);

  // 启动时清一次历史遗留的「空消息」（撤回提示 / 加密提示 / 通话记录 / 表情回应）。
  // 新消息已经在入库前拦掉了，这一句只负责把老数据里已经存进去的清干净。
  try {
    const purged = db.purgeEmptyMessages();
    if (purged) console.log(`已清理 ${purged} 条空消息（没有文字也没有附件的那种）`);
  } catch (e) {
    console.warn('清理空消息失败：', e.message);
  }

  // 再把被当成电话存进去的 LID 清掉（老版本的坑，详见 db.clearLidPhones 的说明）。
  // 清完留空，账号登录后 backfillIdentities 会去问出真号码。
  try {
    const fixed = db.clearLidPhones();
    if (fixed) console.log(`已清掉 ${fixed} 个假号码（把 WhatsApp 的 LID 隐私 ID 当电话存进去的那批）`);
  } catch (e) {
    console.warn('清理假号码失败：', e.message);
  }

  for (const taskName of ['translate', 'suggest']) {
    if (!ai.isReady(taskName)) {
      console.warn(`AI「${taskName}」未配置：${ai.notConfiguredReason(taskName)}　—— 消息照常入库，只是不翻译/不出建议`);
    }
  }

  // 浏览器插件（网页版 WhatsApp 抓图）连接令牌：启动即生成/读取，确保插件能连上
  ensureWaWebToken();

  // 应用内 Telegram 登录弹窗控制器（v2.5.1054）：把 teleproto 交互式登录与前端分步输入对接。
  // onState 把登录进度广播给前端弹窗；onAdopt 在登录成功后把客户端交给 telegramMtproto 接管。
  const tgLogin = telegramLogin.createController({
    cfg,
    dataDir: DATA_ROOT,
    onState: (st) => broadcastSafe('telegram_login', st),
    onAdopt: async (acc, client) => {
      try {
        // 🔴 A 版走官方直连通道；B 版不接管（网页版采集不需要 MTProto 客户端）
        if (telegramChannel.IS_A) {
          await telegramMtproto.adoptLoggedInClient(acc, cfg, telegramHooks(), DATA_ROOT, client);
        }
      } catch (e) {
        console.warn(`[tg-login] 接管客户端失败：${(e && e.message) || e}`);
        broadcastSafe('telegram_login', { accountId: acc.id, status: 'error', step: 'adopt', message: (e && e.message) || String(e) });
      }
    },
  });

  const httpServer = createServer(
    { db, doc, ai, knowledge, cfg, getAccountStates, openAccount, prefillChat, jumpToChat, simulateMessage, clearSimulated, grabProfilePhone, update, signalStatus, launcher, ingestExtensionImage, startBackgroundServices, telegramLogin: tgLogin, telegramWebView },
    PORT,
  );
  broadcast = httpServer.broadcast;

  /*
   * 图片延时重抓（v1.1.0）：启动了就挂上，历史上没抓到图的会补一轮。
   * reset:false —— 'fail' 的不复活（试满 5 轮就彻底放手），
   * 只把还pending 的捡起来。任何异常都不能挡软件启动。
   */
  try {
    startMediaFetch();
  } catch (e) {
    console.warn('图片延时重抓启动失败（不影响其他功能）：', e.message);
  }

  /*
   * 启动器预热（v1.5.1017）：把 S1~S3 的配置从 config.yaml 读出来建表。
   * 🔴 失败也不影响主流程：launcher 内部所有异常都兜住，界面只是没灯而已。
   */
  try {
    launcher.init(cfg);
    console.log('启动器配置就绪（S1~S3 Signal 三开）');
  } catch (e) {
    console.warn('启动器初始化失败（不影响其他功能）：', e.message);
  }

  /*
   * 🔴🔴 启动顺序铁律（v2.5.1035 · 老板拍板）
   *
   * 软件打开后，在【登录成功 + 数据同步走完进度条】之前，**不允许有任何后台动作**：
   *   · 不许扫进程（S1~S3 状态灯）
   *   · 不许检测 Signal（那盏灯）
   *   · 不许读 Signal 本地库抓消息
   *   · 不许替用户打开 Telegram 网页版 ← 旧版 3.5 秒就偷偷开了，最严重
   *   · 不许重建客户档案 Word
   * 这些都是 I/O 重活（PowerShell / 开浏览器 / 全量读库），抢在登录前面
   * 就会拖慢输入密码和点登录。
   *
   * 现在它们统一挪进 startBackgroundServices()，由前端走完真实同步进度条后
   * 调 POST /api/boot/services 才拉起来。这里只留一句占位说明。
   *
   * （v2.5.1034 的卡顿治理仍然有效且必要：那些活本身依旧改成异步 +
   *   后台定时刷新缓存，请求路径只读缓存永不起进程。本版是把它们再往后挪。）
   */
  // （客户档案 Word 每小时重建也一并挪进 startBackgroundServices，见上方铁律说明）

  /* ---------- 云端（v1.0.1）：读配置 → 自动心跳 + 同步主数据 ----------
   * 配过云端就自动登录态恢复；没配就完全走本地（跟以前一样）。
   * 任何失败都只打日志，绝不挡软件启动。 */
  try {
    cloud.onEvent((type, data) => {
      if (type === 'kicked') {
        console.warn('云端：本编号已被踢下线，编排台退回本地模式');
        try { broadcast('cloud', { event: 'kicked' }); broadcast('data_changed', {}); } catch (e) { /* ignore */ }
      } else if (type === 'evicted') {
        try { broadcast('cloud', { event: 'evicted', by: (data && data.by) || '' }); } catch (e) { /* ignore */ }
      }
    });
    const cst = await cloud.boot();
    if (cst && cst.configured && cst.loggedIn) {
      console.log(`云端已连接：${cst.base}（编号 ${cst.operator ? cst.operator.code : '?'}，主数据 ${cst.master.fragments} 个碎片）`);
    } else if (cst && cst.configured) {
      console.warn('云端已配置但未登录：编排台暂时用本地数据（在「全局设置 → 云端」里登录）');
    }
  } catch (e) {
    console.warn('云端初始化失败（不影响本地使用）：', e.message);
  }

  // 整个进程只在这里 listen 一次（见 listenOn 的说明）。
  const wantPort = opt.port != null ? Number(opt.port) : PORT;
  activePort = await listenOn(httpServer.server, wantPort, opt.portFallback !== false);
  console.log(`界面已启动：http://127.0.0.1:${activePort}`);

  const enabled = (cfg.accounts || []).filter((a) => a.enabled);
  if (!enabled.length) {
    console.warn('没有启用任何账号：把 config.yaml 里某个账号的 enabled 改成 true');
  } else if (opt.startWhatsApp !== false) {
    if (opt.deferWhatsApp) {
      // 桌面版要的是"窗口先出现，再慢慢连 WhatsApp"。
      // 浏览器启动要几秒到几十秒（下载 WhatsApp Web、走代理），
      // 以前这里是 await，窗口得等浏览器起来才开 —— 看起来就像"软件卡住不动"。
      // 现在放后台跑，连上/扫码都通过 notice 事件往界面报。
      startAllSessions(enabled).catch((e) => console.error('启动账号会话出错：', e.message));
    } else {
      await startAllSessions(enabled);
    }
  } else {
    // 桌面版默认走这里：**不自动开浏览器**。
    // 用户不想一启动就冒出 Chrome 窗口（而且走代理时要等几十秒），
    // 需要哪个账号就点它右边那个「浏览器」按钮，按需启动。
    console.log('未自动连接 WhatsApp：需要哪个账号，点界面上它右边的「浏览器」按钮');
  }

  return { srv: httpServer.server, PORT: activePort, broadcast, notice, handleMessage, openAccount, prefillChat, simulateMessage, clearSimulated, ai, db, doc, media, startExtractLoop };
}

/* =====================================================================
 * 后台重活统一入口（v2.5.1035 · 老板拍板的启动顺序铁律）
 *
 * 原来这些东西都在 startCore 里「开机就跑」，用户还没登录就在那儿
 * 扫进程、解 Signal 密钥、甚至替用户把 Telegram 网页版打开 —— 直接拖慢
 * 输入密码和点登录。
 *
 * 现在全部挪到这里，由前端走完真实同步进度条后调 POST /api/boot/services
 * 才拉起来。顺序仍是异步的、互不阻塞（沿用 v2.5.1034 的治理成果）。
 *
 * 🔴 幂等：重复调用不会把定时器 / 浏览器起两份。
 * 🔴 任何一项失败都不许影响其余项 —— 各自 try/catch。
 * ===================================================================== */
function startBackgroundServices() {
  if (bgServicesStarted) return { ok: true, already: true, started: [] };
  bgServicesStarted = true;
  const started = [];

  /*
   * 🔴🔴 开总闸（v2.5.1036）：**这一句之前，所有预热都不许动。**
   *    prewarm.arm() 之前，扫进程 / 解 Signal 密钥 / 读 Signal 库 / 开 Telegram /
   *    Word 重建的定时器要么还没起，要么起了也每轮问 gate() 被闸住跳过。
   *    （v2.5.1037：起跑清单里已经没有「Signal 登录检测」这一项了，老板不需要。）
   *    这样即使哪条路径漏了一道，闸门还能兜住。
   */
  prewarm.arm();

  /*
   * ① 状态灯：只扫进程（异步后台刷新，请求路径只读缓存）
   *    🔴 v2.5.1036：节奏按老板定的来 —— 没点「启动」一次都不扫（见 launcher.scanCycle）
   *    🔴🔴 v2.5.1037（老板拍板）：原来这里还有一句
   *        `signalStatus.startBackgroundRefresh(launcher.signalDirs(), 15000)`
   *        —— 每 15 秒自动解一次 Signal 的 DPAPI 主密钥、探一次登录态，
   *        只为了点亮顶栏那盏 Signal 灯。老板现在都是自己开 Signal 窗口，
   *        用不上这个，于是**整条预热删掉**（signalStatus 里的定时器已一并清除）。
   *
   *    连带影响（已处理）：launcher 算 S1~S3 灯时原本也会调一次登录探测，
   *    现在改成「进程在跑 = 绿灯」，不再碰密钥。Signal 采集不受影响。
   */
  try {
    launcher.startBackgroundRefresh();
    started.push('status-refresh');
    console.log('进程扫描已启动（登录同步完成后才起；S1~S3 未启动时零扫描；不再检测 Signal 登录态）');
  } catch (e) {
    console.warn('进程扫描启动失败（不影响其他功能）：', e.message);
  }

  // ====================================================================
  // 三个循环（v2.5.1039 · 老板拍板，照他桌面那张图逐条实现）
  //
  //   循环①：登录 + 同步走完 → 立刻起，每 3 秒一轮：Telegram 开 Chrome 预热
  //          （开前先等 ③ 的静默窗口让出来）
  //          →「S1 S2 S3 随便启动一个，随便一个启动绿灯后，循环① 停止」
  //
  //   循环②：循环① 停后接着起（串行），每 3 秒一轮：
  //          Signal 消息采集 + Telegram 开 Chrome 预热
  //          →「跑起来，跑到 611 秒后停下，扫进程，等待 1 秒，继续循环②」
  //            （"停下 / 继续"由 ③ 的闸门实现：扫描独占前 3 秒 + 后 1 秒，
  //              循环这几拍整轮跳过，闸一开下一拍自动接上）
  //          → 起来的这一刻把 611 秒计时归零（beginStableRhythm），
  //            因为这 611 秒是从"循环② 跑起来"那一刻算的。
  //
  //   循环③：进程扫描（上面已起计时器）：没点「启动」→ 零扫描；
  //          点了 → 观察期 2 秒一次（就为了早点看到绿灯）；
  //          任意一个绿灯后 → 从循环② 起点算，611 秒一轮，独占「前 3 秒 + 后 1 秒」。
  //
  //   ⑤ 客户档案 Word 每小时重建：不属于这三个循环 —— 循环② 起来后延迟 3 秒起，
  //      照样给 ③ 让路；万一一直没绿灯（老板没开 S 窗口），60 秒兜底起，不能因为
  //      没开 Signal 就不重建档案。
  // ====================================================================

  let wordScheduled = false;
  const scheduleWord = () => {
    if (wordScheduled) return;
    wordScheduled = true;
    setTimeout(() => {
      if (startOpt.wordHourly === false) return;
      try {
        startWordHourly();
        started.push('word-hourly');
        console.log(`⑤ 客户档案 Word：每小时自动重建到${wordDoc.wordDir()}`);
      } catch (e) {
        console.warn('⑤ Word 每小时重建启动失败（不影响其他功能）：', e.message);
      }
    }, 3000); // 🔴 循环② 起来后延迟 3 秒
  };

  /** 循环② 里那一项：Signal 消息采集（循环① 期间绝不碰 Signal 加密库） */
  let sigStarted = false;
  const doStartSignal = async () => {
    if (sigStarted) return;
    sigStarted = true; // 先置位防重入
    try {
      await signalStatus.prewarmKeys([...launcher.signalDirs(), undefined]);
    } catch (e) { /* 预热失败不影响采集，采集会自己再解一次（只慢第一轮） */ }
    try {
      startSignalPolling();
      started.push('signal-poll');
      console.log('循环② Signal 消息采集已启动（S1~S3 任一绿灯后，每 3 秒只读本地库）');
    } catch (e) {
      console.warn('循环② Signal 采集启动失败（不影响其他功能）：', e.message);
    }
    scheduleWord();
  };

  /** 循环① / 循环② 每 3 秒一轮要干的活：Telegram 开 Chrome 预热（幂等，掉了才补） */
  const enabledTg = enrichTgProxy(TELEGRAM_ACCS.filter((a) => a.enabled));
  const ensureTelegram = async () => {
    // v2.5.1069：跳转真置顶的 3 秒静默锁内，不开会偷焦点的窗口（避免把刚置顶的窗口压下去）
    if (isSilent()) { console.log('[ensureTelegram] 静默期中，跳过本轮开窗'); return; }
    // 老板图上那句「开前等静默窗口」：撞上 ③ 正在扫描就先等它过去
    try { await prewarm.waitUntilFree(30000); } catch (e) { /* 等超时也照开，不卡死 */ }
    if (!enabledTg.length) return;
    // 🔴 A 版预热 MTProto 官方直连；B 版预热内置浏览器读取（两者都不碰浏览器窗口）
    if (telegramChannel.IS_A) {
      const r = await telegramOfficialChannel.startWatching({
        accounts: enabledTg, cfg, hooks: telegramHooks(), dataDir: DATA_ROOT,
      });
      if (r && r.ok && r.opened.length) {
        console.log(`A 版预热：MTProto 官方直连已拉起账号 ${r.opened.join('、')}`);
      }
    } else {
      console.log('B 版预热：内置浏览器（Tele①）读取已在运行（免凭证）');
    }
  };

  const loops = loopBeat.createLoops({
    intervalMs: loopBeat.BEAT_MS, // 3 秒一轮
    ensureTelegram,
    startSignal: () => { doStartSignal(); },
    anyGreen: () => launcher.anySignalGreenCached(),
    onStableRhythm: () => {
      const r = launcher.beginStableRhythm();
      console.log(`循环② 起点：611 秒计时归零（第一枪排在 ${Math.round((r.firstScanInMs || 0) / 1000)} 秒后，此后每 611 秒一轮）`);
    },
    log: (m) => console.log('[循环]', m),
  });
  loops.start();
  started.push('loop1', 'loop2');
  bgLoops = loops;

  // v2.5.1085：已配凭证时走 MTProto（startTelegramWatching 内部据此不再启动内置浏览器 webview）。
  // 没配 api_id/api_hash 时仍会退回内置浏览器读取（不依赖凭证）。
  try {
    startTelegramWatching();
    started.push('telegram');
    console.log('Telegram 采集已启动（凭证已配走 MTProto，新消息将进入左栏）');
  } catch (e) {
    console.warn('Telegram 读取启动失败（不影响其他功能）：', e.message);
  }

  // 兜底：一直没绿灯（老板没开 S 窗口）也不能不重建客户档案 Word
  setTimeout(() => {
    if (!wordScheduled) {
      console.log('⑤ 兜底：还没等到 S1~S3 绿灯（循环② 未起），先按 60 秒兜底把 Word 每小时重建起上');
      scheduleWord();
    }
  }, 60000);

  return { ok: true, started, loops: loops.state() };
}

/** 依次拉起所有启用的账号（多账号错开几秒，避免同时抢资源） */
async function startAllSessions(accounts) {
  for (const acc of accounts) {
    await startSession(acc);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/* ---------------- 兜底重扫（提取间隔） ----------------
 *
 * 主路径是「实时监听」：whatsapp-web.js 收到消息立刻回调 onMessage，秒到，不是定时轮询。
 * 这个循环是一个【兜底重扫】：万一实时推送偶尔漏了（断线瞬间、WhatsApp Web 抽风），
 * 每隔 extractInterval 秒主动核对一次最近对话，把漏掉的捞回来。
 *
 * 为什么不会重复：handleMessage 自带去重——消息已在库里就直接 return，不重复翻译、不重复弹通知。
 * 所以重扫是安全的。间隔短=更不容易漏但更费资源；长=更省但偶发漏收的窗口更长。默认 5 秒。
 *
 * 注意：只在真实的桌面软件里跑（electron/main.js 调 startExtractLoop），测试环境不启动，
 * 免得一个 setTimeout 把测试进程挂着。 */

let extractTimer = null;
let lastExtractTs = Math.floor(Date.now() / 1000);

function extractIntervalMs() {
  const n = (cfg.app && Number(cfg.app.extractInterval)) || 5;
  return Math.min(15, Math.max(2, n)) * 1000;
}

function scheduleExtract() {
  if (extractTimer) clearTimeout(extractTimer);
  extractTimer = setTimeout(extractTick, extractIntervalMs());
}

async function extractTick() {
  try {
    const since = lastExtractTs - 2; // 留 2 秒重叠，边界不漏
    for (const [id, s] of runningSessions) {
      if (accountStates.get(id)?.status !== 'online') continue;
      const client = s && s.client;
      const acc = (cfg.accounts || []).find((a) => a.id === id);
      if (!client || !acc) continue;
      let chats = [];
      try { chats = await client.getChats(); } catch (e) { continue; }
      for (const chat of chats) {
        if (chat.isGroup) continue;
        try {
          const msgs = await chat.fetchMessages({ limit: 5 });
          for (const m of msgs.reverse()) {
            if (m.timestamp && Number(m.timestamp) <= since) continue; // 只处理上次重扫之后的
            await handleMessage(acc, m, { silent: false, client });
          }
        } catch (e) { /* 单个对话失败不影响其它 */ }
      }
    }
  } catch (e) {
    console.warn('[extract] 兜底重扫出错（下个周期再试）：', e.message);
  } finally {
    lastExtractTs = Math.floor(Date.now() / 1000);
    scheduleExtract();
  }
}

/** 真实桌面软件入口启动它；测试环境直接 return，绝不挂进程 */
function startExtractLoop() {
  if (process.env.BEE_TEST) return;
  if (extractTimer) return; // 已经起过了，不重复
  lastExtractTs = Math.floor(Date.now() / 1000);
  scheduleExtract();
}

if (require.main === module) {
  startCore()
    .then((core) => {
      core.startExtractLoop();
      process.on('SIGINT', () => {
        console.log('\n正在退出…');
        try { if (session.shutdownAll) session.shutdownAll(); } catch (e) {}
        process.exit(0);
      });
    })
    .catch((e) => {
      console.error('启动失败：', e);
      process.exit(1);
    });
}

module.exports = {
  main: startCore, startCore, handleMessage, loadConfig, getAccountStates,
  // v2.5.1035：后台重活延后到「登录 + 同步完成」之后才拉起（启动顺序铁律）
  startBackgroundServices,
  // v2.5.1039：循环①/② 节拍器状态（自检 / 排障用）
  loopsState: () => (bgLoops ? bgLoops.state() : null),
  openAccount, prefillChat, prefillIntoPage, simulateMessage, clearSimulated,
  grabProfilePhone,
  windowBoundsFor, notify, startExtractLoop,
  messageText, identity, // 空消息判定 / 客户身份抓取（单测直接测这两个）
  // 2026-10-07 v1.1.0：图片延时重抓（单测要能直接跑一轮，不挂定时器）
  mediaFetch, refetchMedia, onMediaFetched, recallMsg, saveMedia, startMediaFetch,
  // 2026-10-07 v1.1.0：客户档案 Word（每小时全量重建 + 图片内嵌小图）
  wordDoc, startWordHourly,
  // 2026-10-08 v1.5.0：Signal 采集
  //🔴 handleSignalMessage / startSignalPolling 必须能单独拿到跑测试 ——
  //   它要连 Signal 的加密库，测试里没法通过界面触发，只能直接调。
  //   startSignalPolling 会挂定时器，所以测试只用 handleSignalMessage（纯函数式的入一条）。
  signalRead, handleSignalMessage, startSignalPolling,
  // 2026-10-11 v2.5.1028：Telegram 网页版采集（仿 WA 外跑 Chrome）
  // 🔴 handleTelegramMessage / telegramRead 必须能单独拿到跑测试 ——
  //   它要连用户真实登录的 web.telegram.org，测试里没法通过界面触发，只能直接调 handleTelegramMessage 入一条。
  telegramRead, handleTelegramMessage, startTelegramWatching,
  // v2.5.1056：内置浏览器读取（Tele① 页签的 webview），不依赖 api_id / api_hash
  telegramWebView,
  // 2026-10-09 v1.5.1017：启动器（S1~S5 Signal 五开 / T1~T3 Telegram 三开）
  launcher,
};
