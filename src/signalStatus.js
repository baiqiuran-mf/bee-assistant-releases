/*
 * Signal Desktop 状态检测（只读，2026-10-08）
 * =====================================================================
 * 用途只有一个：告诉界面「Signal 现在能不能用」——
 *   绿灯 = 已启动 + 已登录（库能解开、且有真实会话）
 *   红灯 = 没启动 / 装了没登录 / 出问题
 *
 * 🔴 本模块**只读**Signal 的一切：不写库、不写 Signal 目录、不发任何消息。
 *
 * ---- 判断链路（三步，全在本机实测过）----
 *  ① 进程：`tasklist` 查 Signal.exe 在不在。
 *     🔴 坑：PowerShell 的 Get-Process 在沙箱里查不到（会静默返回空），
 *        但 `tasklist` 从 Node 里 execFileSync 正常。四条 Signal.exe 就是这么查到的。
 *  ② 解密：Local State → safeStorage(DPAPI) → masterKey
 *     → config.json 的 v10 → AES-256-GCM → SQLCipher key。
 *     🔴 用 Electron 的 safeStorage，**不依赖外部 Python**（探针里那版靠
 *        spawn python，Electron 里不可靠：沙箱 EBUSY + 用户机器不一定装 Python）。
 *  ③ 登录态：能打开库，且 conversations 里有**非官方**会话。
 *     官方 Signal 号 serviceId 是 11111111…-4111-8111-…，它一直在，
 *     不能拿它当"已登录"的判据（否则装完没登录也会报绿灯）。
 *
 * ---- 性能 ----
 * 开库实测 3ms。界面 3 秒轮询一次完全够用；另加 5 秒缓存，
 * 避免 /api/state 频繁被别处调用时重复解密。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');
const dpapi = require('./dpapi');
/*
 * 🔴 v2.5.1037：原来这里还 require('./prewarm')（互斥闸门）。
 *    闸门是给「定时刷新之间互相让路」用的；Signal 状态检测这条预热整条删掉后，
 *    本文件已经没有定时任务了，也就不需要问闸门 —— 一并去掉。
 *    （闸门本身还在用：进程扫描 / Signal 采集 / Word 重建 / 开 Telegram 仍靠它错峰。）
 */

/**
 * execFile 的 Promise 版（v2.5.1034 卡顿治理）
 * 🔴 只 resolve、永不 reject：失败返回 null，绝不让「tasklist 查不到」这种
 *    在 Electron 里很常见的情况把异步链打断（旧同步版就是靠 try/catch 兜的）。
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

/* 官方 Signal 号的 serviceId：装完就有，不代表登录
   🔴 2026-10-08 更正：原来写的 11111111-2222-3333-4444-555555555555 是**编的**，
      本机实测真值是 11111111-1111-4111-8111-111111111111。
      之前绿灯判断没出错，是因为 probeLoggedIn 里还带了 `type !== 'official'` 兜底。
      现在填真值，并保留那个兜底（双保险）。*/
const OFFICIAL_SERVICE_IDS = new Set([
  '11111111-1111-4111-8111-111111111111',
]);

const SIG_DIR = path.join(process.env.APPDATA || '', 'Signal');
const DB_PATH = path.join(SIG_DIR, 'sql', 'db.sqlite');
const CFG_PATH = path.join(SIG_DIR, 'config.json');
const LOCAL_STATE = path.join(SIG_DIR, 'Local State');

/**
 * 任意 Signal 数据目录 → 该目录下的 DB / config / Local State 路径。
 * 多开时用：每个实例的数据目录不同（%APPDATA%\Signal_1 …），但解密链路完全一致。
 *
 * 🔴 Signal 多实例的真实布局：
 *    launcher 启动时会把 APPDATA/LOCALAPPDATA 指到 dir，而 Signal 自己还会再 append 一个 'Signal'，
 *    所以数据真正落在 dir\Signal。但万一某版本直接把 --user-data-dir 当 userData（落在 dir），
 *    这里两种都兼容：优先 dir\Signal，其次 dir。
 */
function pathsFor(dir) {
  // 🔴 dir 省略（默认 Signal 实例）时，回退到模块级默认常量，
  //    千万别把 undefined 直接塞进 path.join —— 会抛 "path must be of type string"。
  if (!dir) return { SIG_DIR, DB_PATH, CFG_PATH, LOCAL_STATE };
  const candidates = [path.join(dir, 'Signal'), dir];
  let base = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'sql'))) { base = c; break; }
    if (fs.existsSync(path.join(c, 'config.json'))) { base = c; break; }
    if (fs.existsSync(path.join(c, 'Local State'))) { base = c; break; }
  }
  // 目录都还没建（实例刚起 / 还没登录）→ 按 dir\Signal 估算，便于给出"未初始化"提示
  if (!base) base = candidates[0];
  return {
    SIG_DIR: base,
    DB_PATH: path.join(base, 'sql', 'db.sqlite'),
    CFG_PATH: path.join(base, 'config.json'),
    LOCAL_STATE: path.join(base, 'Local State'),
  };
}

/* ---------- 状态取值 ----------
 * green  绿灯：已启动 + 已登录
 * red    红灯：其余一切（未启动 / 未登录 / 出错）
 * 单独留一个 unknown 只在前端"还没查过"时占位，不从后端发出去。
 */
const S = {
  GREEN: 'green',
  RED: 'red',
};

function result(state, reason, extra) {
  return Object.assign({ state, reason, running: false, loggedIn: false }, extra || {});
}

/* =====================================================================
 * ① 进程检测
 * ===================================================================== */

/**
 * Signal.exe 在不在。
 *
 * 🔴🔴 这里踩过一个很坑的坑：用 execFileSync('tasklist') 在**普通 node 里能查到**，
 *    但在 **Electron 主进程里 execFileSync 被沙箱/安全策略吞掉**，异常被 catch 成
 *    false → **明明开着 Signal 却报「没启动」的红灯**。本机实测：tasklist 有 4 个
 *    Signal.exe，而 Electron 里 isRunning()  返回 false。
 *
 *    所以改成两条腿走路：
 *      ① 先试 tasklist（最快，1~3ms）
 *      ② 失败/异常 → 退回「读 Windows 的进程列表」——
 *         用 `wmic` 不行（会被程序黑名单拦），改用 PowerShell 的
 *         Get-CimInstance 同样不稳。
 *         最终兜底：**看 Signal 的库文件在最近几分钟内有没有被写过**。
 *         Signal 在跑就会写 db.sqlite / attachments.noindex；
 *         完全没启动时这些文件的 mtime 会停在很久以前。
 *         这个判据不需要任何外部进程，符合「只读」铁律。
 */

let _runningCache = { value: null, at: 0 };

function tasklistSaysRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Signal.exe', '/NH'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return /Signal\.exe/i.test(out || '');
  } catch (e) {
    return null;          // null = 查不到（区别于「查到了，确实没跑」）
  }
}

/** 异步版 tasklist（v2.5.1034）：同样的判据，但**不占住 Node 主线程**。 */
async function tasklistSaysRunningAsync() {
  const out = await execFileP('tasklist', ['/FI', 'IMAGENAME eq Signal.exe', '/NH'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (out === null) return null;
  return /Signal\.exe/i.test(out || '');
}

/**
 * 兜底判据：Signal 数据目录最近有没有活动。
 * @param {string} [dir] 数据目录（省略=默认 %APPDATA%\Signal）
 * @returns {boolean|null} true=有活动 false=完全没有 null=判断不了
 */
function filesSuggestRunning(dir) {
  // 🔴 多实例：真实数据目录在 dir\Signal（见 pathsFor），必须用解析后的 SIG_DIR 来判断活动
  const base = dir ? pathsFor(dir).SIG_DIR : SIG_DIR;
  try {
    const now = Date.now();
    const cands = [
      path.join(base, 'sql', 'db.sqlite'),
      path.join(base, 'sql', 'db.sqlite-wal'),
      path.join(base, 'attachments.noindex'),
      path.join(base, 'Preferences'),
      path.join(base, 'DIPS'),
    ];
    let newest = 0;
    for (const p of cands) {
      try {
        const st = fs.statSync(p);
        const t = Math.max(st.mtimeMs, st.ctimeMs);
        if (t > newest) newest = t;
      } catch (e) { /* 不存在就跳过 */ }
    }
    if (!newest) return null;             // 一个都读不到 → 判断不了
    // 10 分钟内有活动 = 认为在跑（Signal 会定期写库/更新 DIPS）
    return now - newest < 10 * 60 * 1000;
  } catch (e) {
    return null;
  }
}

/** 3 秒缓存：/api/state 会被频繁调，别每次都起进程 */
function isRunning(force, dir) {
  const now = Date.now();
  if (!force && _runningCache.value !== null && now - _runningCache.at < 3000) {
    return _runningCache.value;
  }

  let val = tasklistSaysRunning();
  if (val === null || val === false) {
    // tasklist 查不到（Electron 沙箱）或确实没跑 → 用文件活动兜底
    const fb = filesSuggestRunning(dir);
    if (fb === true) val = true;
    else if (val === null) val = false;   // 两条路都指认没跑，才报没跑
  }

  _runningCache = { value: val, at: now };
  return val;
}

/** 异步版：与 isRunning 共用 _runningCache，绝不重复起 tasklist。 */
async function isRunningAsync(force, dir) {
  const now = Date.now();
  if (!force && _runningCache.value !== null && now - _runningCache.at < 3000) {
    return _runningCache.value;
  }

  let val = await tasklistSaysRunningAsync();
  if (val === null || val === false) {
    const fb = filesSuggestRunning(dir);
    if (fb === true) val = true;
    else if (val === null) val = false;
  }

  _runningCache = { value: val, at: Date.now() };
  return val;
}

/** 给界面看的一句话（说明判据来源，便于排查「为什么说没启动」） */
function runningEvidence() {
  const t = tasklistSaysRunning();
  const f = filesSuggestRunning();
  return { tasklist: t, fileActivity: f };
}

/* =====================================================================
 * ② 密钥链路
 * ===================================================================== */

/**
 * 32 字节 masterKey。
 *
 * 🔴 这里**不用** Electron 的 safeStorage（实测解不了Signal 的 blob，
 *    详见 src/dpapi.js 顶部的四条路线对照）。走 dpapi.js 的
 *    PowerShell 内联 C# + CryptUnprotectData，实测 hex 与 Python 版逐字节一致。
 */
function getMasterKey(dir) {
  return dpapi.getMasterKey(dir ? pathsFor(dir).LOCAL_STATE : LOCAL_STATE);
}

/**
 * 跑通 masterKey + config.json → 64 字符 SQLCipher key。
 * 🔴 解出来的 64 字节**本身就是 64 个 ASCII hex 字符**，不是 32 字节二进制。
 *    千万别再 .toString('hex') —— 会变成 128 字符，直接 SQLITE_NOTADB。
 *    （这个坑我踩过一次，19 组参数全失败，根因就是这里。）
 */
function getSqlCipherKey(dir) {
  const p = pathsFor(dir);
  if (!fs.existsSync(p.CFG_PATH)) throw new Error('NO_CONFIG');
  return deriveSqlCipherKey(getMasterKey(dir), p.CFG_PATH);
}

/** 异步版：masterKey 走 getMasterKeyAsync（PowerShell 不阻塞主线程），其余完全一致。 */
async function getSqlCipherKeyAsync(dir) {
  const p = pathsFor(dir);
  if (!fs.existsSync(p.CFG_PATH)) throw new Error('NO_CONFIG');
  return deriveSqlCipherKey(await dpapi.getMasterKeyAsync(p.LOCAL_STATE), p.CFG_PATH);
}

/** masterKey + config.json → 64 字符 SQLCipher key（同步/异步版共用这一段纯 CPU 逻辑） */
function deriveSqlCipherKey(masterKey, cfgPath) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!cfg.encryptedKey) throw new Error('NO_CONFIG_KEY');
  const raw = Buffer.from(cfg.encryptedKey, 'hex');

  const ver = raw.subarray(0, 3).toString();
  if (ver !== 'v10' && ver !== 'v11') throw new Error('BAD_VERSION:' + ver);

  // v10: 前 3 字节版本 + 12 字节 nonce + 密文 + 16 字节 tag
  const nonce = raw.subarray(3, 15);
  const tag = raw.subarray(-16);
  const ct = raw.subarray(15, -16);

  const d = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
  d.setAuthTag(tag);
  const key = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  if (key.length !== 64) throw new Error('BAD_KEY_LEN:' + key.length);
  return key;
}

/** 拿 SQLCipher driver（同步/异步开库共用） */
function driver() {
  try {
    // eslint-disable-next-line global-require
    return require('better-sqlite3-multiple-ciphers');
  } catch (e) {
    throw new Error('NO_DRIVER');
  }
}

/** 用已解出的 64 字符 key 打开只读库（同步/异步开库共用） */
function attach(Database, p, key) {
  const db = new Database(p.DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("cipher='sqlcipher'");
  db.pragma('legacy=4');
  db.pragma(`key="x'${key}'"`);   // 🔴 少一个 x' 就 SQLITE_NOTADB
  db.pragma('query_only = ON');
  return db;
}

/** 只读打开 Signal 库（dir 省略=默认 %APPDATA%\Signal） */
function openDb(dir) {
  const Database = driver();
  const p = pathsFor(dir);
  return attach(Database, p, getSqlCipherKey(dir));
}

/**
 * 异步版开库（v2.5.1034）：只有「取密钥」那一步是异步（DPAPI 走 PowerShell 不阻塞主线程），
 * better-sqlite3 本身是同步 API、开库实测 3ms，留在主线程无妨。
 */
async function openDbAsync(dir) {
  const Database = driver();
  const p = pathsFor(dir);
  return attach(Database, p, await getSqlCipherKeyAsync(dir));
}

/* =====================================================================
 * ③ 登录态
 * ===================================================================== */

/**
 * 库能不能打开 + 有没有真实会话。
 * 官方号（11111111…）不算数 —— 它在装完时就有。
 */
function probeLoggedIn(dir) {
  const p = pathsFor(dir);
  if (!fs.existsSync(p.DB_PATH)) return { loggedIn: false, conversations: 0, reason: '库还没生成（Signal 可能还没启动过）' };

  let db;
  try {
    db = openDb(dir);
  } catch (e) {
    return { loggedIn: false, conversations: 0, reason: describeOpenError(e) };
  }
  return probeWithDb(db);
}

/** 异步版：开库那一步异步（DPAPI 不阻塞主线程），查询逻辑与同步版完全一致。 */
async function probeLoggedInAsync(dir) {
  const p = pathsFor(dir);
  if (!fs.existsSync(p.DB_PATH)) return { loggedIn: false, conversations: 0, reason: '库还没生成（Signal 可能还没启动过）' };

  let db;
  try {
    db = await openDbAsync(dir);
  } catch (e) {
    return { loggedIn: false, conversations: 0, reason: describeOpenError(e) };
  }
  return probeWithDb(db);
}

/** 拿着已打开的库查「有没有真实会话」（同步/异步共用） */
function probeWithDb(db) {
  try {
    const rows = db
      .prepare('SELECT serviceId, profileName, e164, type FROM conversations')
      .all();
    const real = rows.filter((r) => !OFFICIAL_SERVICE_IDS.has(r.serviceId) && r.type !== 'official');
    const msgs = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    return {
      loggedIn: real.length > 0,
      conversations: real.length,
      messages: Number(msgs) || 0,
      reason: real.length > 0 ? '' : '库里只有官方 Signal 号，还没登录自己的号',
    };
  } catch (e) {
    return { loggedIn: false, conversations: 0, reason: '读库失败：' + (e.message || e) };
  } finally {
    try { db.close(); } catch (e) { /* 关不掉也无所谓，只读 */ }
  }
}

function describeOpenError(e) {
  const m = String(e && e.message || e);
  if (m === 'NO_DRIVER') return '缺少 SQLCipher 驱动，解不开加密库';
  if (m === 'NO_POWERSHELL') return '调不动 PowerShell，解不开 DPAPI 密钥';
  if (m === 'NOT_WINDOWS') return 'Signal 数据读取只支持 Windows';
  if (m.startsWith('NO_LOCAL_STATE')) return '找不到 Signal 的 Local State（可能没装）';
  if (m.startsWith('NO_ENCRYPTED')) return 'Local State 里没有加密密钥字段';
  if (m.startsWith('NO_CONFIG')) return '找不到 Signal 的 config.json';
  if (m.startsWith('BAD_VERSION')) return `加密版本不认识（${m}）`;
  if (m.startsWith('BAD_KEY')) return '解出的密钥不对（可能换过 Windows 账号）';
  if (m.startsWith('BAD_MASTER')) return 'masterKey 长度异常';
  if (m.startsWith('DPAPI')) return 'DPAPI 解密失败（换过 Windows 账号？）';
  if (/SQLITE_NOTADB|not a database/i.test(m)) return '密钥对不上这个库';
  return '打不开 Signal 库：' + m;
}

/* =====================================================================
 * 对外：一次完整检测
 * ===================================================================== */

/**
 * @returns {{state:'green'|'red', reason:string, running:boolean, loggedIn:boolean,
 *            conversations?:number, messages?:number, dbPath:string}}
 */
function detect(force, dir) {
  const p = pathsFor(dir);
  const dbPath = p.DB_PATH;
  const label = dir ? path.basename(dir) : 'Signal';

  // 目录都没有 → 没装（默认实例） / 还没初始化（多开实例，首次启动需在弹窗用手机扫码登录）
  if (!fs.existsSync(p.SIG_DIR)) {
    const reason = dir
      ? '还没初始化（首次启动请在弹出的窗口里用手机扫码登录）'
      : `没装 ${label}（找不到 ${p.SIG_DIR}）`;
    return result(S.RED, reason, { dbPath });
  }

  // 🔴 force 要透传给 isRunning：不然 detect(force=true) 里用的是 3 秒前的旧进程缓存，
  //    会出现「强制重查」和「不重查」结果一样的情况（本机实测就是这样）。
  const running = isRunning(!!force, dir);
  if (!running) {
    return result(S.RED, 'Signal 没启动 —— 打开它并保持登录，软件才能读到新消息', { dbPath });
  }

  const probe = probeLoggedIn(dir);
  if (!probe.loggedIn) {
    return result(S.RED, `Signal 在跑，但${probe.reason || '还没登录'}`, {
      running: true, dbPath,
    });
  }

  return {
    state: S.GREEN,
    reason: `Signal 已启动并登录（${probe.conversations} 个会话 / ${probe.messages} 条消息）`,
    running: true,
    loggedIn: true,
    conversations: probe.conversations,
    messages: probe.messages,
    dbPath,
  };
}

/**
 * 异步版完整检测（v2.5.1034 卡顿治理的主角）
 * 🔴 与 detect() 判定逻辑逐条一致，区别只在两处耗时操作不再同步阻塞：
 *      · tasklist 查进程 → execFile 异步
 *      · DPAPI 取密钥   → PowerShell 异步（这一步实测 1.8 秒，是卡顿大头）
 */
async function detectAsync(force, dir) {
  const p = pathsFor(dir);
  const dbPath = p.DB_PATH;
  const label = dir ? path.basename(dir) : 'Signal';

  if (!fs.existsSync(p.SIG_DIR)) {
    const reason = dir
      ? '还没初始化（首次启动请在弹出的窗口里用手机扫码登录）'
      : `没装 ${label}（找不到 ${p.SIG_DIR}）`;
    return result(S.RED, reason, { dbPath });
  }

  const running = await isRunningAsync(!!force, dir);
  if (!running) {
    return result(S.RED, 'Signal 没启动 —— 打开它并保持登录，软件才能读到新消息', { dbPath });
  }

  const probe = await probeLoggedInAsync(dir);
  if (!probe.loggedIn) {
    return result(S.RED, `Signal 在跑，但${probe.reason || '还没登录'}`, { running: true, dbPath });
  }

  return {
    state: S.GREEN,
    reason: `Signal 已启动并登录（${probe.conversations} 个会话 / ${probe.messages} 条消息）`,
    running: true,
    loggedIn: true,
    conversations: probe.conversations,
    messages: probe.messages,
    dbPath,
  };
}

/* ---- 缓存层（v2.5.1034 卡顿治理重写）----
 * 🔴🔴 铁律：**请求路径（detectCached）只读缓存，绝不起进程、绝不解密。**
 *     真正耗时的工作全部交给 refreshNow()（异步）和后台定时器。
 *
 * 为什么原来是 5 秒不够：前端每 10 秒轮询一次 /api/state，5 秒缓存必然已过期
 * → 每次轮询都现场跑一次 tasklist + DPAPI（同步阻塞主线程，实测 1.8~3.3 秒）
 * → 启动/输入密码/点登录撞上就是"卡一下"。现在缓存 30 秒 + 后台定时刷新，
 *     主线程永远不用等 PowerShell。
 *
 * 🔴 多实例（Signal_1…Signal_3）各自独立缓存：绝不把一个实例的结果喂给另一个实例。
 */
let _cache = null;
let _cacheAt = 0;
const _cacheByDir = new Map();
const CACHE_MS = 30000;

/*
 * 🔴 v2.5.1037：原来这里有个 BG_REFRESH_MS = 15000（每 15 秒后台刷一次登录态），
 *    连同 startBackgroundRefresh / tickRefresh / scheduleRefresh 一整套定时器，
 *    **已经按老板要求整条删除**。改由「谁需要谁显式调 refreshNow()」。
 */

function readCache(dir) {
  if (dir) return _cacheByDir.get(dir) || null;
  return _cache ? { val: _cache, at: _cacheAt } : null;
}

function writeCache(dir, val) {
  const at = Date.now();
  if (dir) _cacheByDir.set(dir, { val, at });
  else { _cache = val; _cacheAt = at; }
}

/* 同一个实例正在查 → 复用同一个 Promise，绝不重复起 PowerShell */
const _inflight = new Map();

/**
 * 真正干活的异步刷新。
 * 🔴 这是唯一会起 tasklist / PowerShell 的入口，且全程异步 —— 期间主线程照常服务所有请求。
 * @param {boolean} force 忽略进程缓存（不影响本层的 30 秒结果缓存语义）
 * @param {string} [dir] Signal 数据目录；省略=默认实例
 * @returns {Promise<object>} 检测结果
 */
function refreshNow(force, dir) {
  const key = dir || '__default__';
  const running = _inflight.get(key);
  if (running) return running;

  const task = (async () => {
    let out;
    try {
      out = await detectAsync(!!force, dir);
    } catch (e) {
      // 🔴 detectAsync 内部已兜住大部分错；这里兜最后一层，绝不让检测把刷新链搞挂
      out = result(S.RED, '检测出错：' + ((e && e.message) || e));
    }
    writeCache(dir, out);
    return out;
  })();

  _inflight.set(key, task);
  return task.finally(() => { _inflight.delete(key); });
}

/**
 * 给接口用的同步读取 —— **纯只读缓存，绝不起进程、绝不解密。**
 *
 * 🔴🔴 v2.5.1037（老板拍板）：「检测 Signal 有没有开、有没有登录」这条预热
 *     **整条删掉了**，连带下面两样一起没了：
 *       · 每 15 秒自动刷一次的后台定时器（原 startBackgroundRefresh）；
 *       · 「缓存过期就顺手补一次」的隐式触发（旧 detectCached 会催 refreshNow）。
 *
 *     为什么删：老板现在都是自己开 Signal 窗口，不需要软件替他盯着那盏灯。
 *     而这条预热恰恰是启动卡顿的大头之一 —— 解 DPAPI 主密钥要跑 PowerShell，
 *     实测 1.8 秒，还是定时反复跑。
 *
 * 现在的行为：查过就有值（返回那份缓存）；从没查过 → 回一个「未检测」占位，
 *     **绝不因为一次接口调用就去起 PowerShell / 开 SQLCipher 库**。
 *
 * 想真查一次？走显式入口 refreshNow()（手动刷新按钮 / Signal 采集开库时自己调），
 *     采集链路不受任何影响。
 *
 * 🔴 参数 force 保留只为兼容老调用方，现在不再触发任何后台动作。
 */
function detectCached(force, dir) {
  const hit = readCache(dir);
  if (hit) return hit.val;
  return result(S.RED, '未检测（Signal 状态灯预热已停用，改由采集模块按需读库）', {
    idle: true,
    detecting: false,
  });
}

/**
 * 异步预热某个实例的 DPAPI 主密钥（v2.5.1034 卡顿治理）
 *
 * 🔴 为什么必须预热：Signal **采集**用的是 openDb()（better-sqlite3 只能同步调用），
 *    里面取密钥是同步链路。密钥若还没解出来，采集第一轮就会在主线程里
 *    同步跑 1.8 秒 PowerShell —— 那是又一处"启动卡顿"。
 *    先在启动阶段异步解好塞进共享缓存（与 getMasterKeyAsync 同一份 _masterCache），
 *    之后采集开库直接命中缓存，毫秒级。
 *
 * @param {string} [dir] Signal 数据目录；省略=默认实例
 * @returns {Promise<boolean>} 是否成功（失败不影响调用方，采集会自己再兜一次）
 */
async function prewarmKey(dir) {
  try {
    const p = pathsFor(dir);
    await dpapi.getMasterKeyAsync(p.LOCAL_STATE);
    return true;
  } catch (e) {
    return false;
  }
}

/** 批量预热（各实例并行，互不等待） */
async function prewarmKeys(dirs = []) {
  const list = Array.isArray(dirs) ? dirs : [];
  await Promise.all(list.map((d) => prewarmKey(d)));
}

module.exports = {
  detect,
  detectAsync,
  detectCached,
  refreshNow,
  prewarmKey,
  prewarmKeys,
  isRunning,
  isRunningAsync,
  runningEvidence,
  tasklistSaysRunning,
  tasklistSaysRunningAsync,
  filesSuggestRunning,
  getMasterKey,
  getSqlCipherKey,
  getSqlCipherKeyAsync,
  openDb,
  openDbAsync,
  probeLoggedIn,
  probeLoggedInAsync,
  pathsFor,
  paths: { SIG_DIR, DB_PATH, CFG_PATH, LOCAL_STATE },
  _resetCache() {
    _cache = null; _cacheAt = 0;
    _cacheByDir.clear();
    _inflight.clear();
    _runningCache = { value: null, at: 0 };
    dpapi._clearCache();
  },
};
