/**
 * telegramMtproto.js — Telegram 采集（MTProto 协议层，v2.5.1053 起）
 *
 * 为什么换掉旧的 web.telegram.org 爬虫：
 *   web 版（K 版 SolidJS）DOM 结构持续变，靠 class 选择器爬了 3 版（1050/1051/1052）都收不到。
 *   这条路走 Telegram 官方 MTProto 协议（teleproto 库，gramjs 的活跃维护分支），
 *   读消息 / 未读完全独立于网页 DOM，Telegram 改版也影响不到。
 *
 * 关键约束（沿用老板铁律）：
 *   - 绝无自动发送：本模块只监听 + 统计，从不主动外发。
 *   - 发送功能（sendToPeer）为**操作员在 Tele① 回复框主动点击「发送」**触发，属人工显式动作，非自动。
 *     2026-10-13 老板明确授权放开原只读红线，允许在软件内直接发消息/媒体（方案B 真正发送）。
 *   - 同账号的第二会话：MTProto 登录的是和网页同一个 Telegram 号，Telegram 允许多设备，互不踢。
 *
 * 消息结构严格对齐 main.js 的 handleTelegramMessage(m) 契约：
 *   m = { accountId, displayJid, customerKey, msgId, direction, body, hasAttachment,
 *         ts, name, username, phone, isGroup }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { NewMessage } = require('teleproto/events');
/* v2.6.1136：Telegram 专属的「Saved Messages 判定 / 正文时间剥离」——
 * 与网页抓取（src/telegramRead.js）共用同一套 Telegram 自己的规则，
 * 但**不**与 WhatsApp / Signal 共用任何东西（各渠道抓取方式不同，不许合并）。 */
const tgMerge = require('./telegramMerge');

const clients = new Map(); // accountId -> { client, acc, cfg, dataDir, hooks, readCounter, timer, entityCache }

/* ----------------------------- 工具函数 ----------------------------- */

function sessionPath(dataDir, id) {
  return path.join(dataDir || '.', `telegram-session-${id}.txt`);
}

function loadSession(dataDir, id) {
  try {
    const p = sessionPath(dataDir, id);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (e) { /* ignore */ }
  return '';
}

function saveSession(dataDir, id, str) {
  try {
    const p = sessionPath(dataDir, id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(str || ''), 'utf8');
    return true;
  } catch (e) {
    console.warn(`[telegram-mtproto ${id}] 保存会话失败：${(e && e.message) || e}`);
    return false;
  }
}

/**
 * 解析代理字符串 → teleproto 的 SocksProxyType。
 * 支持：socks5://user:pass@host:port / socks5://host:port / host:port
 * 全局 VPN 环境下留空即可（Node 直连走系统网络栈）。
 */
function parseProxy(str) {
  if (!str) return null;
  str = String(str).trim();
  if (!str) return null;
  let m = str.match(/^socks[45]:\/\/(?:([^:@]+):([^@]+)@)?([^:]+):(\d+)$/i);
  if (m) {
    return {
      socksType: m[1] ? parseInt(m[1], 10) : 5,
      ip: m[3],
      port: parseInt(m[4], 10),
      username: m[2] || undefined,
      password: undefined,
    };
  }
  m = str.match(/^(?:([^:@]+):([^@]+)@)?([^:]+):(\d+)$/);
  if (m) {
    return {
      socksType: 5,
      ip: m[3],
      port: parseInt(m[4], 10),
      username: m[2] || undefined,
      password: undefined,
    };
  }
  return null;
}

function peerIdNum(peer) {
  if (!peer || !peer.className) return null;
  if (peer.className === 'PeerUser') return peer.userId;
  if (peer.className === 'PeerChat') return peer.chatId;
  if (peer.className === 'PeerChannel') return peer.channelId;
  return null;
}

function state(hooks, st) {
  if (hooks && typeof hooks.onState === 'function') {
    try { hooks.onState(st); } catch (e) { /* ignore */ }
  }
}

function emit(hooks, batch) {
  if (hooks && typeof hooks.onMessages === 'function') {
    try { hooks.onMessages(batch); } catch (e) { /* ignore */ }
  }
}

/* ----------------------------- 实体缓存 ----------------------------- */

async function getPeerEntity(client, peer, cache) {
  const num = peerIdNum(peer);
  if (num == null) return null;
  const key = String(num);
  if (cache.has(key)) return cache.get(key);
  try {
    const ent = await client.getEntity(peer);
    if (ent) cache.set(key, ent);
    return ent;
  } catch (e) {
    return null;
  }
}

/* ----------------------------- 消息映射 ----------------------------- */

/**
 * 把 teleproto 的 Api.Message 映射成 handleTelegramMessage 需要的统一结构。
 * 取「对话对方」实体当客户（私聊时对方=user，群聊时=群），不受发送方向影响。
 */
async function toContract(msg, acc, client, cache) {
  if (!msg) return null;
  const peer = msg.peerId;
  const peerNum = peerIdNum(peer);
  if (peerNum == null) return null;

  const chatKey = String(peerNum);
  const direction = msg.out ? 'out' : 'in';
  const hasAttachment = !!(msg.media && msg.media.className && msg.media.className !== 'MessageMediaEmpty');
  /* 🔴 v2.6.1136 问题 3 / 4：正文尾部时间剥出来单独存，绝不留在 body 里
   *   （否则界面渲染一次 + body 里带一次 = 时间重复；翻译也会把时间一起翻）。
   *   剥完只剩时间、又没附件 → 当空消息丢弃，不造客户。 */
  const stripped = tgMerge.stripTrailingTime((typeof msg.message === 'string') ? msg.message : '');
  const body = stripped.body;
  const msgTime = stripped.msgTime || '';
  // 空文本且无附件的（系统事件/撤回提示/表情回应）不造客户、不入库
  if (!body && !hasAttachment) return null;
  /* 🔴 v2.6.1194：日期条不入「对话信息」（与 telegramRead.toMessage 同款口径）。
   * MTProto 走服务端消息、理论上不会产生日期分隔条，但**接上更保险**：
   * 万一某条正文恰好就是 `October 15` 这种形态（比如客户真的发了日期），
   * 这一层只会多拦一条极罕见的短消息；反过来漏接的代价是日期条又进了对话栏。
   * ⚠️ 拦的只有「整串就是日期」，长句子（`I will meet you on October 15`）一律放行，
   *   所以不存在「客户真的聊到日期被误吞」的风险。 */
  if (tgMerge.isDateOnlyMessage(body)) return null;

  const msgId = String(msg.id);
  const ts = (msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString());
  const isGroup = !!(peer && (peer.className === 'PeerChat' || peer.className === 'PeerChannel'));

  let name = '';
  let username = null;
  let phone = '';
  const ent = await getPeerEntity(client, peer, cache);
  if (ent) {
    const fn = ent.firstName || ent.first_name || '';
    const ln = ent.lastName || ent.last_name || '';
    name = [fn, ln].filter(Boolean).join(' ').trim();
    if (!name && ent.title) name = ent.title;
    if (ent.username) username = String(ent.username).replace(/^@/, '');
    if (ent.phone) phone = String(ent.phone);
  }

  /* 🔴 v2.6.1136 问题 1：Saved Messages（收藏夹）是**自己的备忘夹**，不是客户
   *   —— 不产生新消息提醒、不建档。MTProto 这条路径键是数字 peerId，
   *   只有名字才是 "Saved Messages"，所以两个判据都要过一遍（键 / 名称）。 */
  if (tgMerge.isSavedMessage(chatKey, name)) return null;

  return {
    accountId: acc.id,
    displayJid: `tg:${chatKey}`,
    customerKey: chatKey,
    msgId,
    direction,
    body,
    // 剥出来的显示时间（网页路径才有；MTProto 用服务端 date，这里恒为网页侧剥到的值）
    msgTime,
    hasAttachment,
    ts,
    name: name || null,
    username,
    phone,
    isGroup,
  };
}

/* ----------------------------- 未读统计 ----------------------------- */

async function pollDialogs(acc, client, hooks, readCounter) {
  let dialogs;
  try {
    dialogs = await client.getDialogs({ limit: 100 });
  } catch (e) {
    return;
  }
  let chats = 0;
  let unread = 0;
  for (const d of dialogs) {
    chats += 1;
    unread += (d.unreadCount || 0);
  }
  const read = readCounter ? readCounter.n : 0;
  if (readCounter) readCounter.n = 0;
  state(hooks, { id: acc.id, status: 'collecting', title: '收集中', chats, unread, read });
}

/* ----------------------------- 单账号启动 ----------------------------- */

async function startAccount(acc, cfg, hooks, dataDir) {
  const tgCfg = (cfg && cfg.telegram) || {};
  const apiId = parseInt(tgCfg.apiId, 10);
  const apiHash = tgCfg.apiHash || '';
  if (!apiId || !apiHash) {
    state(hooks, {
      id: acc.id, status: 'login_required',
      title: '未配置 apiId/apiHash（请在 config.yaml 的 telegram 段填写，再运行 scripts/tg-login.js 一次性登录）',
    });
    return;
  }

  const sessionStr = loadSession(dataDir, acc.id);
  const proxy = parseProxy(acc.proxy || tgCfg.proxy) || undefined;
  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5,
    proxy,
  });

  state(hooks, { id: acc.id, status: 'starting', title: '连接 Telegram…' });

  try {
    await client.connect();
  } catch (e) {
    state(hooks, { id: acc.id, status: 'login_required', title: `连接失败：${(e && e.message) || e}（检查网络/代理）` });
    return;
  }

  let me = null;
  try { me = await client.getMe(); } catch (e) { me = null; }
  if (!me) {
    state(hooks, {
      id: acc.id, status: 'login_required',
      title: '会话无效，需一次性登录（运行 scripts/tg-login.js）',
    });
    try { await client.disconnect(); } catch (e) { /* ignore */ }
    return;
  }

  // 登录态有效：把客户端交给统一的「监听 + 未读统计」注册函数
  await registerWatching(client, acc, cfg, hooks, dataDir);
  console.log(`[telegram-mtproto ${acc.id}] 已连上，账号 @${me.username || me.phone || me.id}`);
}

/* ----------------------------- 注册监听（已连上/已授权的客户端统一走这里） ----------------------------- */

/**
 * 给一个已经 connect + 已登录授权的 client 挂上 NewMessage 监听和未读统计，
 * 并登记进 clients Map（确保 stop() 能正确断开）。
 * startAccount 登录成功后走这里；应用内登录弹窗（telegramLogin）走 adoptLoggedInClient。
 */
async function registerWatching(client, acc, cfg, hooks, dataDir) {
  const readCounter = { n: 0 };
  const cache = new Map();
  const handler = async (event) => {
    try {
      const m = await toContract(event.message, acc, client, cache);
      if (m) {
        readCounter.n += 1;
        emit(hooks, [m]);
      }
    } catch (e) {
      console.warn(`[telegram-mtproto ${acc.id}] 消息处理失败：${(e && e.message) || e}`);
    }
  };
  /* 🔴 v2.6.1109：与 telegramOfficialChannel 同一个坑 —— 事件 builder 必须是**实例**，
     传类 NewMessage 会让 teleproto 报「builder.resolve is not a function」、事件全部失效。
     统一改成 new NewMessage({})。 */
  client.addEventHandler(handler, new NewMessage({}));

  const rec = { client, acc, cfg, dataDir, hooks, readCounter, cache, timer: null };
  clients.set(acc.id, rec);

  // 首轮未读统计
  await pollDialogs(acc, client, hooks, readCounter);
  // 周期统计（20s），让顶栏状态条的「列表 N 项 / 未读 M 个」真实可见
  rec.timer = setInterval(() => {
    pollDialogs(acc, client, hooks, readCounter).catch(() => {});
  }, 20000);
  return rec;
}

/**
 * 应用内登录弹窗登录成功后调用：client 已经 connect + 授权，
 * 这里把会话串落盘，并直接接管它的消息接收（不再重新 connect）。
 * @param {object} acc 账号配置（含 id / proxy 等）
 * @param {object} client 已登录的 TelegramClient
 */
async function adoptLoggedInClient(acc, cfg, hooks, dataDir, client) {
  saveSession(dataDir, acc.id, client.session.save());
  await registerWatching(client, acc, cfg, hooks, dataDir);
  state(hooks, { id: acc.id, status: 'collecting', title: '收集中（登录后已接管）' });
}

/* ----------------------------- 对外接口 ----------------------------- */

/**
 * 启动所有启用账号的 MTProto 采集。
 * @param {object} o { accounts, cfg, hooks, dataDir }
 *   - accounts: telegram 账号配置数组（含 enabled）
 *   - cfg: 全局配置（需有 cfg.telegram.apiId / apiHash / proxy）
 *   - hooks: { onMessages(batch), onState(st) } —— 与旧 telegramRead 契约一致
 *   - dataDir: 应用数据根目录（session 文件落这里，和数据库同目录）
 */
async function ensureWatching({ accounts, cfg, hooks = {}, dataDir } = {}) {
  const enabled = (accounts || []).filter((a) => a.enabled);
  for (const acc of enabled) {
    try {
      await startAccount(acc, cfg, hooks, dataDir);
    } catch (e) {
      console.warn(`[telegram-mtproto ${acc.id}] 启动失败：${(e && e.message) || e}`);
      state(hooks, { id: acc.id, status: 'login_required', title: `启动失败：${(e && e.message) || e}` });
    }
  }
  return Array.from(clients.keys());
}

function stop() {
  for (const [id, rec] of clients) {
    if (rec.timer) clearInterval(rec.timer);
    try { rec.client.disconnect(); } catch (e) { /* ignore */ }
  }
  clients.clear();
}

/**
 * 🔴 v2.6.1137「登出」用：只停**一个** Telegram 账号，别的号照采。
 *
 * 与 stop() 的区别（别合并，别互相替代）：
 *   · stop()    = 软件退出时把 7/8/9 全停，一个不留；
 *   · stopAccount(id) = 老板在 Tele①/Tele② 状态条点「登出」时，只摘这一个号。
 *
 * 干三件事：清掉这个号的 20 秒未读轮询 → 断开连接 → 从 clients 里摘掉。
 * 没在采（Map 里没有）也返回 ok，只是 stopped=false —— 登出流程靠它区分「真停过」和「本来就没跑」。
 * @param {number} accountId Telegram 账号 id（7/8/9）
 * @returns {{ok:boolean, stopped:boolean, error:string}}
 */
function stopAccount(accountId) {
  const id = Number(accountId);
  if (!id) return { ok: false, stopped: false, error: '缺少账号 id' };
  const rec = clients.get(id);
  if (!rec) return { ok: true, stopped: false, error: '' };
  if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
  try { if (rec.client && typeof rec.client.disconnect === 'function') rec.client.disconnect(); } catch (e) { /* ignore */ }
  clients.delete(id);
  return { ok: true, stopped: true, error: '' };
}

/** 该账号的 MTProto 客户端是否已连接（决定发送走 MTProto 还是退回 webview 注入） */
function hasClient(accountId) {
  const rec = clients.get(Number(accountId));
  return !!(rec && rec.client);
}

/* ----------------------------- 发送（v2.5.1087：方案B 真正发送） -----------------------------
 * 仅由操作员在 Tele① 回复框点击「发送」触发，绝不自动调用。
 * @param {number} accountId Telegram 账号 id（7/8/9），对应 clients Map 的 key
 * @param {string|number} chatKey peerId（数值），即 customers.wa_jid 去掉 tg: 前缀
 * @param {object} opts { text, caption, file(Buffer|string 路径), replyTo(消息id) }
 */
async function sendToPeer(accountId, chatKey, opts = {}) {
  const rec = clients.get(Number(accountId));
  if (!rec || !rec.client) {
    return { ok: false, error: '该 Telegram 账号未连接（请确认已登录且在采集中）' };
  }
  let target;
  try {
    target = await rec.client.getEntity(String(chatKey));
  } catch (e) {
    // 解析失败则退回原始数值（私聊用户通常可直接用 id 发送）
    target = String(chatKey);
  }
  try {
    let sent;
    if (opts.file) {
      sent = await rec.client.sendFile(target, { file: opts.file, caption: opts.caption || '' });
    } else {
      sent = await rec.client.sendMessage(target, {
        message: opts.text || '',
        replyTo: opts.replyTo || undefined,
      });
    }
    return { ok: true, id: sent && sent.id };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* ----------------------------- 客户资料（v2.5.1088：中栏头像点开浮层用） -----------------------------
 * 实时取 Telegram 原生 User Info：头像 / 名称 / 用户名 / 手机号 / 最后上线。
 * 失败（未登录 / 取不到实体）→ 返回 { ok:false }，由调用方回退库里存的名称 + @username。
 * @param {number} accountId Telegram 账号 id（7/8/9）
 * @param {string|number} chatKey peerId（数值），对应 customers.wa_jid 去掉 tg: 前缀
 */
async function getUserProfile(accountId, chatKey) {
  const rec = clients.get(Number(accountId));
  if (!rec || !rec.client) {
    return { ok: false, error: '该 Telegram 账号未连接（请确认已登录且在采集中）' };
  }
  let ent;
  try {
    ent = await rec.client.getEntity(String(chatKey));
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  if (!ent) return { ok: false, error: '找不到该用户/群组' };

  const fn = ent.firstName || ent.first_name || '';
  const ln = ent.lastName || ent.last_name || '';
  let name = [fn, ln].filter(Boolean).join(' ').trim();
  if (!name && ent.title) name = ent.title;
  const username = ent.username ? String(ent.username).replace(/^@/, '') : '';
  const phone = ent.phone ? String(ent.phone) : '';

  // 最后上线状态映射（gramjs 的 UserStatus* 子类）
  let lastSeen = '';
  const st = ent.status;
  if (st) {
    const cls = st.className || '';
    if (cls === 'UserStatusOnline') lastSeen = '在线';
    else if (cls === 'UserStatusRecently') lastSeen = '最近在线';
    else if (cls === 'UserStatusLastWeek') lastSeen = '上周在线';
    else if (cls === 'UserStatusLastMonth') lastSeen = '上个月在线';
    else if (cls === 'UserStatusOffline') {
      const t = st.wasOnline;
      if (t) {
        try { lastSeen = `离线（${new Date(t).toLocaleString('zh-CN', { hour12: false })}）`; }
        catch (e) { lastSeen = '离线'; }
      } else lastSeen = '离线';
    }
  }

  // 头像：下载转 dataURL（无头像时 downloadProfilePhoto 通常返回 falsy）
  let photoDataUrl = '';
  try {
    const buf = await rec.client.downloadProfilePhoto(ent);
    if (buf && buf.length) {
      photoDataUrl = `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`;
    }
  } catch (e) { photoDataUrl = ''; }

  return { ok: true, name, username, phone, lastSeen, photoDataUrl };
}

module.exports = { ensureWatching, stop, stopAccount, sessionPath, parseProxy, loadSession, saveSession, registerWatching, adoptLoggedInClient, sendToPeer, getUserProfile, hasClient };
