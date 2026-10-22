/**
 * 云端（wa-cloud）客户端 · 蜜蜂信息采集 v1.0.1
 *
 * 干什么：
 *   1) 用「编号 + 密码」登录云端，心跳保活 —— 一个编号只能一处在线（互斥）；
 *   2) 把云端【主数据】同步到本地（本地只读缓存，软件绝不回写主数据）；
 *   3) 编排台的增删改 → 写进【自己编号的仓库】（云端只存差异，不动主数据）；
 *   4) 保存客户档案前，先查这个电话号码有没有被别的编号登记过。
 *
 * 铁律（老板要求）：
 *   · 后台数据（主数据）不会被软件修改 —— 本模块对主数据只有 GET；
 *   · 每个编号有自己唯一的仓库，默认后台数据不会进编号仓库；
 *   · 断网/没配云端时，软件照常用本地那份（离线兜底，不能因为云挂了就用不了）。
 *
 * 说明：这里用 Node 内置 fetch（Electron 44 = Node 24，原生就有），不引第三方 HTTP 库。
 */

const fs = require('fs');
const path = require('path');
const { DATA_ROOT, configFile } = require('./paths');

/* 云端地址固定为线上部署地址（老板 2026-10-01 要求：写死、不可改，
   软件统一从这里拉数据；默认值就是这个，界面上显示为「已固定」，用户改不了）。 */
const CLOUD_BASE_URL = 'https://mingfengxx.weilisi0813.workers.dev';

/* ------------------------------- 存储位置 ------------------------------- */

const CLOUD_DIR = path.join(DATA_ROOT, 'cloud');
const SESSION_FILE = path.join(CLOUD_DIR, 'session.json');
const MASTER_FILE = path.join(CLOUD_DIR, 'master.json');
const SYNC_FILE = path.join(CLOUD_DIR, 'sync.json');

function ensureDir() {
  if (!fs.existsSync(CLOUD_DIR)) fs.mkdirSync(CLOUD_DIR, { recursive: true });
}

function readJsonSafe(file, dflt) {
  try {
    if (!fs.existsSync(file)) return dflt;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return dflt; }
}

function writeJson(file, obj) {
  try {
    ensureDir();
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { /* 写不了就算了，内存里还有 */ }
}

/* ------------------------------- 内存状态 ------------------------------- */

const state = {
  base: '',            // 云端地址
  token: '',           // 登录令牌
  operator: null,      // { id, code, name, role }
  device: '',          // 本机标识
  heartbeatMs: 60000,
  lastSyncAt: 0,       // 上次同步主数据的时间
  lastError: '',
  online: false,       // 最近一次心跳是否成功
  timer: null,
  listeners: new Set(),
};

/* ------------------------------- 基础请求 ------------------------------- */

function baseOf() {
  return String(state.base || '').replace(/\/+$/, '');
}

function deviceId() {
  if (state.device) return state.device;
  // 设备标识：主机名 + 平台。云端只拿它来提示"被谁占着"，不用于安全。
  const os = require('os');
  let host = 'PC';
  try { host = (os.hostname() || 'PC').slice(0, 40); } catch (e) { /* ignore */ }
  state.device = host;
  return state.device;
}

async function request(method, p, body, opts) {
  const o = opts || {};
  const base = baseOf();
  if (!base) throw new Error('还没配置云端地址');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeout || 15000);
  try {
    const res = await fetch(base + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!j) throw new Error('云端返回异常（HTTP ' + res.status + '）');
    if (!j.ok) {
      const err = new Error(j.error || '云端操作失败');
      err.status = res.status;
      err.busy = !!j.busy;
      err.payload = j;
      throw err;
    }
    return j;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- 事件通知 ------------------------------- */

function onEvent(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }
function emit(type, data) {
  for (const fn of state.listeners) {
    try { fn(type, data); } catch (e) { /* 单个监听器出错不影响别人 */ }
  }
}

/* ------------------------------- 配置读写 ------------------------------- */

/** 从 config.yaml 读 cloud 段（读不到返回空对象）。 */
function readCloudConfig() {
  try {
    const f = configFile();
    if (!fs.existsSync(f)) return {};
    let yaml;
    try { yaml = require('js-yaml'); } catch (e) { yaml = require('./yaml-lite'); }
    const cfg = yaml.load(fs.readFileSync(f, 'utf8')) || {};
    return (cfg.cloud && typeof cfg.cloud === 'object') ? cfg.cloud : {};
  } catch (e) { return {}; }
}

/**
 * 启动时把云端的地址/编号读进内存（token 走 session.json，不进 config.yaml）。
 * @returns {boolean} 是否配置过云端
 */
function loadConfig() {
  // 云端地址固定为线上部署地址（写死，不读 config.yaml 的 cloud.baseUrl，避免被改坏）。
  // 只在还没设过时兜底填它（刚启动的进程 base 为空）；已经在用的会话保持原地址，不强行覆盖。
  if (!state.base) state.base = CLOUD_BASE_URL;
  const saved = readJsonSafe(SESSION_FILE, null);
  // 地址已固定，不存在「换地址让老令牌作废」的情况；只要本地存过令牌就恢复。
  if (saved && saved.token) {
    state.token = saved.token;
    state.operator = saved.operator || null;
    state.heartbeatMs = saved.heartbeatMs || 60000;
    if (saved.device) state.device = saved.device;
  } else {
    state.token = '';
    state.operator = null;
  }
  return !!(state.base && state.token);
}

function saveSession() {
  writeJson(SESSION_FILE, {
    base: state.base,
    token: state.token,
    operator: state.operator,
    device: state.device,
    heartbeatMs: state.heartbeatMs,
  });
}

/* ------------------------------- 登录 / 退出 ------------------------------- */

/**
 * 登录云端。
 * @param {{baseUrl:string, code:string, password:string}} opt
 * @throws 编号被别人占用时 err.busy = true，err.message 里带「已经被 XX 的用户添加」那种提示
 */
async function login(opt) {
  const base = String(opt.baseUrl || CLOUD_BASE_URL).trim().replace(/\/+$/, '');
  if (!base) throw new Error('云端地址未配置');
  state.base = base;
  state.token = '';                 // 换地址先清旧令牌
  const dev = opt.device || deviceId();
  state.device = dev;

  const j = await request('POST', '/api/auth/login', {
    code: String(opt.code || '').trim(),
    password: String(opt.password || ''),
    device: dev,
    app: 'desktop',
  });

  state.token = j.token;
  state.operator = j.operator || null;
  state.heartbeatMs = j.heartbeatMs || 60000;
  state.lastError = '';
  state.online = true;
  saveSession();
  emit('login', { operator: state.operator });
  startHeartbeat();
  return { operator: state.operator, heartbeatMs: state.heartbeatMs };
}

async function logout(silent) {
  stopHeartbeat();
  if (state.token && !silent) {
    try { await request('POST', '/api/auth/logout', {}, { timeout: 5000 }); } catch (e) { /* 退不了就算了 */ }
  }
  state.token = '';
  state.operator = null;
  state.online = false;
  writeJson(SESSION_FILE, {});
  emit('logout', {});
}

/* ------------------------------- 心跳（互斥保活） ------------------------------- */

function startHeartbeat() {
  stopHeartbeat();
  const ms = Math.max(15000, state.heartbeatMs || 60000);
  state.timer = setInterval(() => { heartbeat().catch(() => { /* 网络抖动忽略 */ }); }, ms);
  if (state.timer.unref) state.timer.unref();
}

function stopHeartbeat() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

async function heartbeat() {
  if (!state.token) return { alive: false };
  try {
    const j = await request('POST', '/api/auth/heartbeat', {}, { timeout: 10000 });
    state.online = true;
    state.lastError = '';
    if (j.evicted) {
      // 被别处顶掉了（正常情况下互斥不会发生，留个兜底）
      emit('evicted', { by: j.by || '' });
    }
    return { alive: !!j.alive, evicted: !!j.evicted };
  } catch (e) {
    state.online = false;
    state.lastError = e.message || '心跳失败';
    if (e.status === 401) {
      // 令牌失效（管理员踢下线 / 会话过期）
      state.token = '';
      state.operator = null;
      writeJson(SESSION_FILE, {});
      emit('kicked', {});
    }
    return { alive: false, error: state.lastError };
  }
}

/* ------------------------------- 主数据同步 ------------------------------- */

/** 当前登录的会员编号（没登录返回空串）—— 决定读/写哪份本地副本 */
function myCode() {
  return (state.operator && state.operator.code) || '';
}

/**
 * 本地副本文档：按会员编号分开存（v2.5.1035）。
 *
 * 🔴 为什么必须分开：以前所有会员共用一份 master.json，A 会员登录后
 *    B 会员再登，读到的会是 A 的数据 —— 数据串号。
 *    现在 mj005 存 master-mj005.json、mj006 存 master-mj006.json，各读各的。
 *
 * @param {string} code 会员编号（mj005 这种）
 */
function masterPath(code) {
  const safe = String(code || '').trim().replace(/[^A-Za-z0-9_.-]/g, '');
  return safe ? path.join(CLOUD_DIR, `master-${safe}.json`) : MASTER_FILE;
}

/**
 * 按身份 key 去重合并：**本地已有的跳过**，只把云端新的补进来。
 *
 * 老板原话：「数据和云端出来的一些话题或者常用对话相同的，记得跳过加入进软件」
 *
 * key 取优先级：id → name →（都没有）整条内容序列化。
 * 同 key 时保留本地那份（本地可能被会员自己改过，不能被云端覆盖回去）。
 *
 * @returns {{list:Array, added:number, skipped:number}}
 */
function mergeUnique(localList, cloudList) {
  const seen = new Map();
  const keyOf = (it) => {
    if (!it || typeof it !== 'object') return '';
    if (it.id != null && String(it.id) !== '') return 'id:' + String(it.id);
    if (it.name != null && String(it.name) !== '') return 'name:' + String(it.name);
    return 'raw:' + JSON.stringify(it);
  };
  for (const it of Array.isArray(localList) ? localList : []) {
    const k = keyOf(it);
    if (k) seen.set(k, it);
  }
  let added = 0;
  let skipped = 0;
  for (const it of Array.isArray(cloudList) ? cloudList : []) {
    const k = keyOf(it);
    if (!k) continue;
    if (seen.has(k)) { skipped += 1; continue; }   // 已经有了 → 跳过，不重复加
    seen.set(k, it);
    added += 1;
  }
  return { list: Array.from(seen.values()), added, skipped };
}

/**
 * 从云端拉主数据，**合并去重后**写入本地副本。
 *
 * 🔴 本地副本的意义（老板 2026-10-11 讲清楚的）：
 *    第一次登录从云端拉；以后再打开直接读本地那份，**不再联网拉云端**。
 *
 * @param {string} code 会员编号（决定写哪个本地文件、以及贡献给谁）
 */
async function syncMaster(code) {
  const j = await request('GET', '/api/master');
  const file = masterPath(code);
  // 跟本地已有副本合并：重复的跳过（不会被重复加进来，也不会丢会员自己的改动）
  const old = readJsonSafe(file, { fragments: [], replies: [] });
  const f = mergeUnique(old.fragments, j.fragments || []);
  const r = mergeUnique(old.replies, j.replies || []);
  const data = {
    fragments: f.list,
    replies: r.list,          // 常用话术主数据（没登录过老版本时为空数组）
    syncedAt: j.syncedAt || new Date().toISOString(),
    ownerCode: String(code || ''),
  };
  writeJson(file, data);
  state.lastSyncAt = Date.now();
  emit('master', {
    count: data.fragments.length,
    replies: data.replies.length,
    added: f.added + r.added,
    skipped: f.skipped + r.skipped,
  });
  return Object.assign({}, data, {
    source: 'cloud',
    added: { fragments: f.added, replies: r.added },
    skipped: { fragments: f.skipped, replies: r.skipped },
  });
}

/**
 * 本地副本的主数据（第二次起直接读这份，不联网）。
 * @param {string} code 会员编号
 */
function cachedMaster(code) {
  const file = masterPath(code);
  const fallback = { fragments: [], replies: [], syncedAt: null };
  // 老版本只有单一 master.json：没有编号对应文件时，回落过去，平滑过渡不丢数据
  if (!String(code || '').trim() && !fs.existsSync(file)) {
    return readJsonSafe(MASTER_FILE, fallback);
  }
  return readJsonSafe(file, fallback);
}

/** 本地副本是否存在、属于谁 —— 前端用它决定"要不要再去云端拉一次" */
function localMasterInfo(code) {
  const file = masterPath(code);
  if (!String(code || '').trim()) {
    const legacy = readJsonSafe(MASTER_FILE, null);
    return { exists: !!legacy, ownerCode: '', syncedAt: (legacy && legacy.syncedAt) || null };
  }
  const d = readJsonSafe(file, null);
  return {
    exists: !!d,
    ownerCode: (d && d.ownerCode) || '',
    syncedAt: (d && d.syncedAt) || null,
    fragments: (d && d.fragments && d.fragments.length) || 0,
    replies: (d && d.replies && d.replies.length) || 0,
  };
}

/* ------------------------------- 常用话术库 ------------------------------- */
/*
 * 老板 2026-10-02：常用回复话术库（场景 → 三种情绪回复，中英）。
 * 铁律：主数据只有后台能改；软件里的增删改都进「自己编号的仓库」（/api/replies/...）。
 * ⚠️ 和话题碎片不同：话术库【跟编号走、全局一份】，不区分客户。
 */

/** 取合并后的整份话术库（主数据 + 我这个编号的增量）。 */
async function getReplies() {
  const j = await request('GET', '/api/replies');
  return j.replies || { scenes: [] };
}

async function addReplyScene(name, id) {
  const body = { name: String(name || '').trim() || '新场景' };
  // 本机先定好的 id 要带过去：不然后面改名 / 加回复时云端对不上号
  if (id) body.id = id;
  return request('POST', '/api/replies/scene', body);
}
async function updateReplyScene(id, name) {
  return request('PUT', `/api/replies/scene/${encodeURIComponent(id)}`, { name });
}
async function deleteReplyScene(id) {
  return request('DELETE', `/api/replies/scene/${encodeURIComponent(id)}`);
}
async function addReplyText(rid, body) {
  return request('POST', `/api/replies/scene/${encodeURIComponent(rid)}/text`, body || {});
}
async function updateReplyText(id, body) {
  return request('PUT', `/api/replies/text/${encodeURIComponent(id)}`, body || {});
}
async function deleteReplyText(id, rid) {
  const q = rid ? `?rid=${encodeURIComponent(rid)}` : '';
  return request('DELETE', `/api/replies/text/${encodeURIComponent(id)}${q}`);
}

/* ------------------------------- 同步开关与冷却 ------------------------------- */
/*
 * 老板 2026-10-01 第 3 条：
 *   · 设置里要有一个「同步话题」按钮 + 一个「启动时同步」勾选框；
 *   · 勾上 → 启动时同步一次，**同步完自动取消勾选**，下次启动就不再拉网络数据；
 *   · 不勾 → 每次启动都不同步；
 *   · 「同步话题」按钮点一次后 5 分钟内不能再点（防止反复拉、白烧流量）。
 *
 * 文件：<数据目录>/cloud/sync.json —— 纯本地偏好，不进云端、不参与互斥。
 */

const MANUAL_COOLDOWN_MS = 5 * 60 * 1000;

function readSyncPref() {
  const d = readJsonSafe(SYNC_FILE, null);
  if (!d) {
    // 第一次装软件：默认勾上 —— 「软件第一次启动会同步数据库内容」
    return { autoSync: true, lastManualAt: 0, firstTime: true, firstLaunchAt: 0 };
  }
  return {
    autoSync: !!d.autoSync,
    lastManualAt: Number(d.lastManualAt) || 0,
    firstTime: false,
    firstLaunchAt: Number(d.firstLaunchAt) || 0,
  };
}

function writeSyncPref(p) {
  writeJson(SYNC_FILE, {
    autoSync: !!p.autoSync,
    lastManualAt: Number(p.lastManualAt) || 0,
    firstLaunchAt: Number(p.firstLaunchAt) || 0,
  });
}

/** 勾 / 取消「启动时同步」。取消勾选（首次同步完）时记一下第一次启动时间。 */
function setAutoSync(on) {
  const p = readSyncPref();
  p.autoSync = !!on;
  if (!on && !p.firstLaunchAt) p.firstLaunchAt = Date.now();
  writeSyncPref(p);
  emit('sync_pref', { autoSync: p.autoSync });
  return { autoSync: p.autoSync };
}

/** 「同步话题」还剩多少毫秒才能再点（0 = 现在就能点）。 */
function cooldownLeft() {
  const left = readSyncPref().lastManualAt + MANUAL_COOLDOWN_MS - Date.now();
  return left > 0 ? left : 0;
}

/**
 * 手动点「同步话题」：把云端的话术碎片 + 对话同步到本地。
 * @returns {{ok:boolean, cooldownLeft:number, fragments?:number}}
 *   ok=false 且 cooldownLeft>0 → 刚同步过，还在冷却里（界面按钮要置灰）
 */
async function manualSync() {
  if (!state.token) throw new Error('还没登录云端编号');
  const left = cooldownLeft();
  if (left > 0) return { ok: false, cooldownLeft: left };
  const data = await syncMaster(myCode());
  const p = readSyncPref();
  p.lastManualAt = Date.now();
  writeSyncPref(p);
  return {
    ok: true,
    fragments: (data.fragments || []).length,
    syncedAt: data.syncedAt,
    cooldownLeft: MANUAL_COOLDOWN_MS,
  };
}

/* ------------------------------- 编号仓库 ------------------------------- */

/** 取某客户的合并看板（主数据 + 我这个编号的差异）。 */
async function getBoard(customerCode) {
  const j = await request('GET', `/api/board/${encodeURIComponent(customerCode)}`);
  return j.board;
}

/** 取会员通用内容（跨客户一致，customer_code = '*'）—— 登录/同步成功后拉取并合并到本地 _master.json。 */
async function pullMyBoard() {
  const j = await request('GET', '/api/board/mine');
  return j.board;
}

async function addFragment(customerCode, body) {
  return request('POST', `/api/board/${encodeURIComponent(customerCode)}/fragment`, body);
}
async function updateFragment(customerCode, fid, body) {
  return request('PUT', `/api/board/${encodeURIComponent(customerCode)}/fragment/${encodeURIComponent(fid)}`, body);
}
async function deleteFragment(customerCode, fid) {
  return request('DELETE', `/api/board/${encodeURIComponent(customerCode)}/fragment/${encodeURIComponent(fid)}`);
}
async function addDialogue(customerCode, fid, body) {
  return request('POST', `/api/board/${encodeURIComponent(customerCode)}/fragment/${encodeURIComponent(fid)}/dialogue`, body);
}
async function updateDialogue(customerCode, did, body) {
  return request('PUT', `/api/board/${encodeURIComponent(customerCode)}/dialogue/${encodeURIComponent(did)}`, body);
}
async function deleteDialogue(customerCode, did, fid) {
  const q = fid ? `?fid=${encodeURIComponent(fid)}` : '';
  return request('DELETE', `/api/board/${encodeURIComponent(customerCode)}/dialogue/${encodeURIComponent(did)}${q}`);
}
async function setSent(customerCode, did, sent, fid) {
  return request('POST', `/api/board/${encodeURIComponent(customerCode)}/sent`, { did, sent: !!sent, fid: fid || '' });
}
async function setFragmentSentAll(customerCode, fid, sent) {
  return request('POST', `/api/board/${encodeURIComponent(customerCode)}/sent`, { fid, sent: !!sent, all: true });
}

/* ------------------------------- 电话查重 ------------------------------- */

/**
 * 保存档案前问一次：这个号有没有被别的编号登记过。
 * @returns {{ conflict:boolean, owners:Array, mine:boolean, skipped?:boolean }}
 */
async function checkPhone(phone, customerCode) {
  const j = await request('POST', '/api/phone/check', { phone, customerCode });
  return { conflict: !!j.conflict, owners: j.owners || [], mine: !!j.mine, skipped: !!j.skipped };
}

/** 把号码登记进自己编号的仓库。 */
async function registerPhone(phone, customerCode, customerName, forced) {
  return request('POST', '/api/phone/register', {
    phone, customerCode, customerName, forced: !!forced,
  });
}

/* ------------------------------- 状态查询 ------------------------------- */

function status() {
  const pref = readSyncPref();
  return {
    configured: !!state.base,
    base: state.base,
    loggedIn: !!state.token,
    operator: state.operator,
    device: state.device,
    online: state.online,
    lastError: state.lastError,
    lastSyncAt: state.lastSyncAt,
    autoSync: pref.autoSync,          // 「启动时同步」勾选框当前状态
    cooldownLeft: cooldownLeft(),     // 「同步话题」按钮还要等多久（毫秒，0=可点）
    manualCooldownMs: MANUAL_COOLDOWN_MS,
    firstLaunchAt: pref.firstLaunchAt, // 第一次启动的时间戳（老板要求记下）
    master: (() => {
      const m = cachedMaster();
      return {
        fragments: (m.fragments || []).length,
        replies: (m.replies || []).length,
        syncedAt: m.syncedAt,
      };
    })(),
  };
}

/**
 * 启动时调用：读配置 → 心跳 + （勾了的话）同步一次主数据。
 *
 * 「同步完成自动取消勾选」在这里落地：勾了 → 同步 → 立刻把勾去掉，
 * 所以下次启动就不会再去拉网络数据；想再自动同步得手动勾一次。
 */
async function boot() {
  const configured = loadConfig();
  if (!configured) return { configured: false };
  startHeartbeat();
  const pref = readSyncPref();
  let autoSynced = false;
  try {
    await heartbeat();
    if (state.token && pref.autoSync) {
      await syncMaster(myCode());
      autoSynced = true;
      writeSyncPref({ ...readSyncPref(), autoSync: false });   // ← 自动取消勾选
    }
  } catch (e) {
    state.lastError = e.message || '同步失败';
  }
  return { configured: true, autoSynced, ...status() };
}

/** 是否已登录云端（翻译记忆同步用） */
function isLoggedIn() { return !!(state.base && state.token); }

/* ------------------------------- 集中托管密钥库 ------------------------------- */
/*
 * 云端（wa-cloud）/api/settings 只存【密文】：客户端用内置 VAULT_KEY 加密后 PUT，
 * 云端绝不解密（见 wa-cloud/src/worker.js 的 putSettings/getSettings）。
 * 这里只负责把密文发上去 / 拉下来，加密解密在 src/aiVault.js 里做。
 */

/** 拉取密钥库密文（没存过返回 null）。未登录会抛错，调用方自己 catch。 */
async function pullSettings() {
  const j = await request('GET', '/api/settings');
  return (j && j.vault) ? String(j.vault) : null;
}

/** 把密钥库密文推上云端（仅管理员可写，后端会拦 role !== 'admin'）。
 *  @param {string} vaultB64  客户端用 VAULT_KEY 密封后的密文（base64）
 *  @param {Array}  [meta]    可选：服务商元数据数组（不含明文 key，只有地址/模型/单向哈希掩码），
 *                            供后台「AI 模型设置」只读展示；会员登录走 pull 不传此参。 */
async function pushSettings(vaultB64, meta) {
  const body = { vault: String(vaultB64 || '') };
  if (Array.isArray(meta) && meta.length) body.meta = meta;
  const j = await request('PUT', '/api/settings', body);
  return { ok: !!j.ok, updatedAt: j.updatedAt || null };
}

module.exports = {
  boot, loadConfig, login, logout, heartbeat, startHeartbeat, stopHeartbeat,
  syncMaster, cachedMaster, localMasterInfo, masterPath, myCode, mergeUnique,
  readSyncPref, setAutoSync, cooldownLeft, manualSync, MANUAL_COOLDOWN_MS,
  getBoard, pullMyBoard, addFragment, updateFragment, deleteFragment,
  addDialogue, updateDialogue, deleteDialogue, setSent, setFragmentSentAll,
  getReplies, addReplyScene, updateReplyScene, deleteReplyScene,
  addReplyText, updateReplyText, deleteReplyText,
  checkPhone, registerPhone,
  status, onEvent,
  // 翻译记忆共享同步（v2.6.1127）需要：直接走带令牌的 request
  request, isLoggedIn,
  // 集中托管密钥库（v2.6.115x）
  pullSettings, pushSettings,
  // 测试用
  _state: state,
  MASTER_FILE, SESSION_FILE, SYNC_FILE,
};
