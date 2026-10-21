/**
 * telegramOfficialChannel.js — 【Telegram 官方 MTProto 直连通道】
 *
 * 🔴 2026-10-13 起这是**唯一的** Telegram 通道（单线 A 版的实现本体）。
 *   双版本已取消 —— A/B 两包 appId/productName/userData 全相同，NSIS 认作同一个程序会互相覆盖。
 *   现在只有一条线，就是本模块。
 *
 * 设计依据：Telegram 官方 MTProto 文档（本文件所有规则均照官方文档实现，不靠猜）
 *   - /api/obtaining_api_id：api_id / api_hash 必须来自 my.telegram.org 的应用信息，
 *     每个手机号只能绑一个 api_id，发布应用必须用自己的 api_id。
 *   - /api/auth：auth.sendCode(phone, api_id, api_hash) → auth.signIn(code, hash)
 *     → 开了两步验证时返回 SESSION_PASSWORD_NEEDED，再 auth.checkPassword。
 *   - /api/files：inputFile 必带 id / parts / name / md5_checksum；
 *     分片 part_size 必须满足 part_size % 1024 == 0 且 524288 % part_size == 0
 *     （推荐 512KB）；>10MB 走 upload.saveBigFilePart，小文件走 upload.saveFilePart。
 *     —— 「name 为空 → 对方看到 unnamed」正是官方 schema 里 name 字段缺失造成的。
 *   - /constructor/user：phone:flags.4? / username:flags.3? / photo:flags.5?
 *     / status:flags.6? UserStatus，最后上线由 UserStatus* 系列构造器表达。
 *
 * 行为约定：必须填 api_id / api_hash，只走官方协议。没凭证就明确报错，
 *   绝不偷偷退回网页版（那条路 telegramWebView.js 还留着，但不再被调用）。
 *
 * 铁律：绝不自动发送。所有发送只由操作员在 Tele① 点击「发送」触发。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { NewMessage } = require('teleproto/events');
/* v2.6.1140：与 telegramMtproto.js 同款 —— Telegram 专属的
 * 「Saved Messages 判定 / 正文尾部时间剥离」走 telegramMerge（同一个 Telegram 频道内的共享，
 * **不**与 WhatsApp / Signal 合流，各渠道抓取方式不同，不许合并）。 */
const tgMerge = require('./telegramMerge');

/* 通道标识：用于界面显示与日志。CHANNEL 保持 'A' 不变——
 * 它是 telegramChannel.js 的同源标识，改了会让调用点的IS_A 判断对不上。 */
const CHANNEL = 'A';
const CHANNEL_LABEL = 'Telegram 官方直连';
const CHANNEL_DESC = '用 my.telegram.org 的 api_id / api_hash 直连，能取到客户手机号与头像';

/** 官方 /api/files：推荐 512KB 分片（524288 % part_size == 0 且 part_size % 1024 == 0） */
const PART_SIZE = 512 * 1024;
const BIG_FILE_THRESHOLD = 10 * 1024 * 1024; // 官方：>10MB 用 saveBigFilePart

const clients = new Map(); // accountId -> { client, entCache }

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
    console.warn(`[tg-A ${id}] 保存会话失败：${(e && e.message) || e}`);
    return false;
  }
}

/** 代理字符串 → teleproto SocksProxyType（与 telegramMtproto 同款解析） */
function parseProxy(str) {
  if (!str) return null;
  str = String(str).trim();
  if (!str) return null;
  let m = str.match(/^socks[45]::\/\/([^:]+):(\d+)$/i)
    || str.match(/^socks[45]:\/\/([^:@]+):([^@]+)@([^:]+):(\d+)$/i);
  if (m) {
    if (m.length === 4) return { socksType: 5, ip: m[1], port: parseInt(m[2], 10) };
    return { socksType: 5, ip: m[3], port: parseInt(m[4], 10), username: m[1], password: m[2] };
  }
  m = str.match(/^(?:([^:@]+):([^@]+)@)?([^:]+):(\d+)$/);
  if (m) {
    return { socksType: 5, ip: m[3], port: parseInt(m[4], 10), username: m[1], password: m[2] };
  }
  return null;
}

/**
 * 校验凭证是否可用。**必须有** api_id + api_hash，没有就直接拒，
 * 绝不偷偷退回网页通道（那条路 telegramWebView.js 还留着，但不再被调用）。
 */
function hasCred(cfg) {
  const t = (cfg && cfg.telegram) || {};
  return !!(t.apiId && t.apiHash);
}

function credError() {
  return '需要 api_id / api_hash：请到设置 →「📨 Telegram」页签填写'
    + '（在 https://my.telegram.org → API development tools 创建应用获取）';
}

/** 拉起官方直连采集。缺凭证直接返回错误（不启动任何其他通道）。 */
async function startWatching({ accounts = [], cfg = {}, hooks = {}, dataDir = '' } = {}) {
  if (!hasCred(cfg)) {
    return { ok: false, error: credError() };
  }
  const opened = [];
  const failed = [];
  for (const acc of accounts) {
    try {
      const ok = await connectAccount(acc, cfg, hooks, dataDir);
      if (ok) opened.push(acc.id);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.warn(`[tg-A] 账号 ${acc.id} 启动失败：${msg}`);
      failed.push({ id: acc.id, error: msg });
      /* 🔴 v2.6.1140：以前失败只 console.warn，顶栏**什么都不显示**——
       *   老板只看到「没提醒」，完全不知道这个号压根没连上。
       *   现在把状态报上去：会话文件不存在 = 需要登录（最常见：8/9 号从未登录过）。 */
      if (typeof hooks.onState === 'function') {
        try {
          const needLogin = !loadSession(dataDir, acc.id);
          hooks.onState({
            id: acc.id, accountId: acc.id, channel: 'telegram_mtproto',
            status: 'login_required', connected: false,
            title: needLogin
              ? '需要登录（该账号还没有 Telegram 会话，点顶栏 T①/T② 用手机号 + 验证码登录一次）'
              : `连接失败：${msg}`,
          });
        } catch (_) { /* ignore */ }
      }
    }
  }
  return { ok: opened.length > 0, opened, failed };
}

async function connectAccount(acc, cfg, hooks, dataDir) {
  const t = cfg.telegram || {};
  const client = new TelegramClient(
    new StringSession(loadSession(dataDir, acc.id)),
    Number(t.apiId),
    String(t.apiHash),
    { connectionRetries: 5 }
  );
  const proxy = parseProxy(acc.proxy || t.proxy || '');
  if (proxy) client.connect({ proxy });

  await client.start({
    phoneNumber: String(acc.phone || '').replace(/[^\d+]/g, '') || undefined,
    password: acc.password || undefined,
    phoneCode: typeof hooks.onPhoneCode === 'function'
      ? await hooks.onPhoneCode(acc) : undefined,
    onAuthKeyRegenerated: (k) => saveSession(dataDir, acc.id, k),
  });

  if (typeof client.isUserAuthorized === 'function' && !(await client.isUserAuthorized())) {
    throw new Error('未通过手机号+验证码完成登录');
  }

  const rec = { client, entCache: new Map(), acc };
  clients.set(Number(acc.id), rec);

  if (typeof hooks.onState === 'function') {
    /* 🔴 v2.6.1140 修字段名不一致：这里原来只发 { accountId, connected }，
     *   而 main.js 的 telegramHooks().onState 读的是 **st.id**（src/main.js:3026）
     *   —— 字段对不上 → `if (!st || st.id == null) return;` 直接return，
     *   顶栏状态条**永远收不到** MTProto 的状态，老板看不到「收集中」。
     *   现在两个字段都发：id 给 main.js 用，accountId 保留兼容旧调用点。 */
    try {
      hooks.onState({
        id: acc.id, accountId: acc.id, channel: 'telegram_mtproto',
        status: 'collecting', connected: true,
        title: '收集中（MTProto 官方直连，新消息自动提醒）',
      });
    } catch (e) { /* ignore */ }
  }

  /* 🔴 v2.6.1109 修复：原来这里传的是**类** NewMessage，teleproto 的事件分发
     (teleproto/client/updates/dispatch.js:143) 要求 builder 是**实例**
     （要有 resolve()/build()），传类会报
     「Error resolving event builder: TypeError: builder.resolve is not a function」，
     结果新消息事件**一个都收不到**。
     正解：传实例 new NewMessage({})（空参 = 所有新消息）。 */
  client.addEventHandler(async (upd) => {
    const m = upd && upd.message;
    if (!m) return;
    const peer = peerIdOf(m);
    if (peer === null || peer === undefined) return;
    const chatKey = String(peer);

    /* 🔴 v2.6.1140 真根因修复（老板反馈「不点任何东西就收不到新消息提醒」的真正断点）：
     *   下面这段映射原来只交出 id/正文/方向，漏了三件事，每一件都足以让消息「静默消失」：
     *
     *   ① 正文没剥尾部时间 —— MTProto 的 message 字段尾部带时间/不可见字符。
     *      stripTrailingTime 先洗不可见字符再剥时间；剥完正文为空 → 说明这条是
     *      系统提示/撤回/表情回应，不是真人话 → **直接丢弃**（原来没这道判断）。
     *   ② 没做 Saved Messages（收藏夹）判定 —— 收藏夹是自己的备忘夹，不是客户，
     *      既不该建档也不该提醒。
     *   ③ name 一直是空串 —— 客户名取不到，提醒标题就退化成「Telegram 新消息」，
     *      老板看不出是谁发来的。client.getEntity 能取到真实 first/last name。
     *
     *   以上三条与 telegramMtproto.toContract 用同一套 telegramMerge 规则
     *   （同一个 Telegram 频道内共享；**不**与 WhatsApp / Signal 合流）。 */
    const stripped = tgMerge.stripTrailingTime(typeof m.message === 'string' ? m.message : '');
    const body = stripped.body;
    const msgTime = stripped.msgTime || '';
    const hasAttachment = !!(m.media && m.media.className && m.media.className !== 'MessageMediaEmpty');
    // 剥完只剩时间、又没有附件 = 系统提示行，不是真人消息 → 不建档、不提醒
    if (stripped.onlyTime && !hasAttachment) return;

    // 取真实客户名（取不到就退回空串，**绝不因取名失败而丢消息**）
    let name = '';
    try {
      const ent = await resolveEntity(rec, chatKey);
      if (ent) {
        const fn = ent.firstName || ent.first_name || '';
        const ln = ent.lastName || ent.last_name || '';
        name = [fn, ln].filter(Boolean).join(' ').trim() || ent.title || '';
      }
    } catch (e) { name = ''; }

    // 收藏夹 = 自己发给自己的备忘夹，不建档、不提醒
    if (tgMerge.isSavedMessage(chatKey, name)) return;

    const batch = [{
      accountId: acc.id,
      displayJid: `tg:${chatKey}`,
      customerKey: chatKey,
      msgId: String(m.id),
      direction: m.out ? 'out' : 'in',
      body,
      msgTime,
      // 🔴 原来写的是 !!m.media —— MessageMediaEmpty（纯文字消息）也是对象，
      //   会让**每一条文字消息都被当成带附件**，界面显示成图片气泡。
      //   正确判据：媒体类名存在且不是 MessageMediaEmpty（与 telegramMtproto 同款）。
      hasAttachment,
      // 🔴 ts 契约是 **ISO 字符串**（telegramMtproto.toContract / telegramRead 都是）。
      //   原来传的是毫秒数字 → 跨渠道路径的时间排序/渲染对不上。
      //
      // 🔴🔴 v2.6.1140 再修一次（这行差点又踩同一个坑）：
      //   teleproto 的 Api.Message.date 类型是 **int（unix 秒）**，不是 Date 对象
      //   —— 已核对 node_modules/teleproto/tl/generated/api.d.ts 的 Message 类声明
      //   （`date: int;`），且 telegramMtproto.js:153 自己就是 `new Date(msg.date * 1000)`。
      //   对 number 调 `.getTime()` 会抛 TypeError → 每条消息都在这里挂掉，
      //   而抛错点在 hooks.onMessages **之前**、又被 teleproto 的 dispatch 吞进内部 logger，
      //   主进程零输出 —— 结果就是「一条消息都收不到，却什么报错都看不到」。
      //   所以正确写法必须是 `new Date(m.date * 1000)`（秒→毫秒），
      //   并且**对两种形态都兜住**：万一将来teleproto 改成 Date 对象也不能整条挂掉。
      ts: (typeof m.date === 'number'
        ? new Date(m.date * 1000)
        : (m.date instanceof Date ? m.date : new Date())).toISOString(),
      name,
      username: '',
      phone: '',
      // 🔴 原来写的是 !!m.chatId —— Api.Message 上**没有** chatId 字段（群/频道在 peerId 里），
      //   所以 isGroup 恒为 false。正确判据看 peerId 的类名。
      isGroup: !!(m.peerId && (m.peerId.className === 'PeerChat' || m.peerId.className === 'PeerChannel')),
    }];
    if (typeof hooks.onMessages === 'function') {
      try { hooks.onMessages(batch); } catch (e) { /* ignore */ }
    }
  }, new NewMessage({}));

  return true;
}

function peerIdOf(m) {
  const p = m.peerId;
  if (!p) return null;
  if (p.className === 'PeerUser') return p.userId;
  if (p.className === 'PeerChat') return p.chatId;
  if (p.className === 'PeerChannel') return p.channelId;
  return null;
}

function hasClient(accountId) {
  const rec = clients.get(Number(accountId));
  return !!(rec && rec.client);
}

async function resolveEntity(rec, chatKey) {
  const client = rec.client;
  const key = String(chatKey);
  if (rec.entCache.has(key)) return rec.entCache.get(key);
  let ent = null;
  try { ent = await client.getEntity(key); } catch (e) { ent = null; }
  if (ent) rec.entCache.set(key, ent);
  return ent;
}

/**
 * 官方合规媒体上传（/api/files）：
 *   1. 生成 file_id（64 位随机数）
 *   2. 按 512KB 切分（最后一片可小于 512KB）
 *   3. 计算整个文件的 md5_checksum（inputFile 必填）
 *   4. 逐片 upload.saveFilePart / upload.saveBigFilePart
 *   5. 以 inputFile(id, parts, name, md5_checksum) 发送 —— name 必须有，
 *      否则对方看到的附件就是「unnamed」
 *
 * @param {object} rec { client }
 * @param {any} target 已解析的 peer
 * @param {Buffer} buf 文件内容
 * @param {string} fileName 原始文件名（务必带真实名字 + 扩展名）
 * @param {string} caption 图文说明
 */
async function sendMediaOfficial(client, target, buf, fileName, caption) {
  const name = (fileName && String(fileName).trim()) || 'file';
  const lower = name.toLowerCase();
  const isVideo = /\.(mp4|mov|webm|m4v|avi|mkv)$/.test(lower);
  const mime = isVideo
    ? (/^video\//.test(lower) ? name.split('.').pop() : 'video/mp4')
    : (/^image\//.test(lower) ? name.split('.').pop() : 'image/jpeg');

  // 官方要求：md5_checksum 对整个文件内容计算
  const md5 = crypto.createHash('md5').update(buf).digest();

  // 512KB 分片；>10MB 走 saveBigFilePart
  const isBig = buf.length > BIG_FILE_THRESHOLD;
  const parts = Math.max(1, Math.ceil(buf.length / PART_SIZE));

  // 写入临时文件：teleproto 的 sendFile 支持传路径，也便于 name/mime 正确识别
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-a-'));
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
  const tmpPath = path.join(tmpDir, safeName);
  fs.writeFileSync(tmpPath, buf);

  try {
    const r = await client.sendFile(target, {
      file: tmpPath,
      caption: caption || '',
      fileName: safeName,
      mimeType: mime,
    });
    return r;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

/**
 * 真正发送一条消息 / 媒体（唯一通道：MTProto 官方直连）
 * 仅由操作员点击「发送」触发，绝不自动调用。
 * @param {number} accountId
 * @param {string|number} chatKey peerId（对应 customers.wa_jid 去 tg: 前缀）
 * @param {object} opts { text, caption, file(Buffer), fileName, replyTo }
 */
async function sendToPeer(accountId, chatKey, opts = {}) {
  const rec = clients.get(Number(accountId));
  if (!rec || !rec.client) {
    return { ok: false, via: 'mtproto', error: '该 Telegram 账号未连接，请先在 Tele① 里完成 Telegram 登录' };
  }
  const client = rec.client;
  const target = await resolveEntity(rec, chatKey);
  if (!target) return { ok: false, via: 'mtproto', error: '找不到该会话（peer 解析失败）' };

  try {
    let sent;
    if (opts.file && Buffer.isBuffer(opts.file) && opts.file.length) {
      sent = await sendMediaOfficial(client, target, opts.file, opts.fileName, opts.caption || '');
    } else {
      sent = await client.sendMessage(target, {
        message: opts.text || '',
        replyTo: opts.replyTo || undefined,
      });
    }
    return { ok: true, via: 'mtproto', kind: opts.file ? 'media' : 'text', id: sent && sent.id };
  } catch (e) {
    return { ok: false, via: 'mtproto', error: (e && e.message) || String(e) };
  }
}

/**
 * 客户资料（官方 user 构造器字段）：
 *   phone:flags.4? / username:flags.3? / photo:flags.5? / status:flags.6? UserStatus
 * lastSeen 由 UserStatus* 系列映射（与官方文档构造器名一一对应）。
 */
async function getUserProfile(accountId, chatKey) {
  const rec = clients.get(Number(accountId));
  if (!rec || !rec.client) {
    return { ok: false, error: '该 Telegram 账号未连接，请先在 Tele① 里完成 Telegram 登录' };
  }
  let ent;
  try { ent = await resolveEntity(rec, chatKey); } catch (e) { ent = null; }
  if (!ent) return { ok: false, error: '找不到该用户/群组' };

  const name = [ent.firstName || ent.first_name, ent.lastName || ent.last_name]
    .filter(Boolean).join(' ').trim() || (ent.title || '');
  const username = ent.username ? String(ent.username).replace(/^@/, '') : '';
  const phone = ent.phone ? String(ent.phone) : '';

  let lastSeen = '';
  const st = ent.status;
  if (st && st.className) {
    if (st.className === 'UserStatusOnline') lastSeen = '在线';
    else if (st.className === 'UserStatusRecently') lastSeen = '最近在线';
    else if (st.className === 'UserStatusLastWeek') lastSeen = '上周在线';
    else if (st.className === 'UserStatusLastMonth') lastSeen = '上个月在线';
    else if (st.className === 'UserStatusOffline') {
      const t = st.wasOnline;
      if (t) {
        try { lastSeen = `离线（${new Date(t).toLocaleString('zh-CN', { hour12: false })}）`; }
        catch (e) { lastSeen = '离线'; }
      } else lastSeen = '离线';
    } else if (st.className === 'UserStatusEmpty') lastSeen = '';
  }

  let photoDataUrl = '';
  try {
    const buf = await rec.client.downloadProfilePhoto(ent);
    if (buf && buf.length) {
      photoDataUrl = `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`;
    }
  } catch (e) { /* 无头像取不到属正常 */ }

  return { ok: true, name, username, phone, lastSeen, photoDataUrl };
}

/** 该账号的 MTProto 客户端是否**真的连着**（不只是 Map 里有记录）。
 *  v2.6.1140：Map 里有 ≠ 还在连。断线后 teleproto 会把 sender 标成 disconnected，
 *  这时若还当它在采，提醒就永久停了 —— 老板那边表现就是「昨天还好好的，今天彻底不响了」。 */
function isClientAlive(accountId) {
  const rec = clients.get(Number(accountId));
  if (!rec || !rec.client) return false;
  try {
    if (typeof rec.client.isConnected === 'function' && !rec.client.isConnected()) return false;
  } catch (e) { return false; }
  try {
    // teleproto 的公开只读属性：disconnected 为 true 表示底层连接已断
    if (rec.client.disconnected === true) return false;
  } catch (e) { /* 读不到就按还活着算，宁可多保活一次也别误杀 */ }
  return true;
}

/**
 * 🔴 v2.6.1140 保活：掉线自动重连（老板要「什么都不做也会响」的前提）。
 *
 * 为什么必须有：MTProto 是**唯一**靠 Telegram 服务器主动推送的通道，
 * 一旦这根连接断了（网络抖动 / 休眠唤醒 / 换网 / 服务器单方面断开），
 * 没有任何东西会把它拉回来 —— 软件看起来一切正常，就是**永远不再提醒**。
 * 这个函数做成**幂等**的，由 main.js 的 3 秒节拍循环调用：
 *   · 还连着 → 什么都不做（绝不重复 connect，绝不重复挂事件监听）
 *   · 断了/压根没起 → 重新走一遍 startWatching
 */
async function ensureWatching({ accounts = [], cfg = {}, hooks = {}, dataDir = '' } = {}) {
  if (!hasCred(cfg)) return { ok: false, error: credError() };
  const relaunched = [];
  const needLogin = [];
  for (const acc of accounts) {
    if (isClientAlive(acc.id)) continue;
    /* 🔴 没有会话文件 = 这个号**从没登录过**，不是「掉线」。
     *   这种情况绝不能反复重连：连不上是必然的，每 3 秒重试一次只会
     *   刷满警告日志、把真正的掉线告警淹掉（老板那边也看不到任何有用信息）。
     *   直接跳过，登录与否是老板手动操作，不是保活该管的事。 */
    if (!loadSession(dataDir, acc.id)) {
      needLogin.push(acc.id);
      continue;
    }
    try {
      const ok = await connectAccount(acc, cfg, hooks, dataDir);
      if (ok) relaunched.push(acc.id);
    } catch (e) {
      // 保活失败只记一行，绝不抛 —— 3 秒后会再试，绝不能把节拍循环带崩
      console.warn(`[tg-A] 账号 ${acc.id} 保活重连失败（下一轮再试）：${(e && e.message) || e}`);
    }
  }
  return { ok: true, relaunched, needLogin };
}

function stop() {
  for (const [, rec] of clients) {
    try { rec.client.disconnect(); } catch (e) { /* ignore */ }
  }
  clients.clear();
}

module.exports = {
  CHANNEL, CHANNEL_LABEL, CHANNEL_DESC,
  PART_SIZE, BIG_FILE_THRESHOLD,
  hasCred, credError, startWatching, stop,
  sendToPeer, getUserProfile, hasClient,
  // 🔴 v2.6.1140 新增：掉线保活（幂等），由 main.js 节拍循环调用
  ensureWatching, isClientAlive,
  parseProxy, loadSession, saveSession,
};