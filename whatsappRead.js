/* =====================================================================
 * v2.6.1121「WA①」内置浏览器 —— WhatsApp 消息采集内核
 * ---------------------------------------------------------------------
 * 干什么：每 3 秒读一次软件**内置浏览器**（中栏「WA①」页签里的 webview，
 *         partition=persist:wa6，加载 web.whatsapp.com）里的
 *           · 新消息
 *           · 好友资料（联系人：名字 / 电话号码 / 地区）
 *           · 对话信息
 *         交给 main.js 走和一号~五号 / Telegram / Signal **完全一样**的
 *         入库 → 翻译 → 广播链路 —— 左栏分栏、中栏气泡、翻译、AI 建议全部直接复用，
 *         界面上不为 WA① 另写一套。
 *
 * 🔴 铁律（本文件唯一职责，做完就收手）：
 *   **只读 WhatsApp 网页的一切 —— 不点开任何对话、不滚任何滚动条、
 *     不写任何输入框、不触发任何发送。**
 *   （这一点跟 telegramRead 里那套 Telegram 采集器、以及 signalRead 是同一个铁律。）
 *
 * 🔴 为什么单独建文件、不复用 telegramRead.js / whatsappWebView.js：
 *   老板 2026-10-12 定的铁律「不同功能各归各的文件与函数，不要代码放一块」。
 *     · whatsappWebView.js = **只读跳转**（把内置浏览器打开某个客户的对话）
 *     · 本文件          = **采集**（读新消息 / 好友资料 / 对话信息）
 *   两者都碰同一个网页，但目的完全不同。这里只**借用** whatsappWebView 的
 *   findGuest()（那是全项目唯一一条「找到内置浏览器页面」的通道），
 *   跳转逻辑一行都不重复。
 *
 * ---- 为什么走内部 Store，而不是读网页 DOM（老板拍板「直接写采集」）----
 *   老板 2026-10-14 给的图里红框就是这个内置浏览器。实测结论（在外部 Chrome 里
 *   跑**同一份** web.whatsapp.com 代码验证过，两边同源）：
 *     window.require('WAWebCollections')            ← 读得到
 *       · Chat.getModelsArray()     会话（含 unreadCount / 时间戳）
 *       · Contact.getModelsArray()  联系人（含 name / pushname / 号码）
 *       · Msg.getModelsArray()      消息（含 body / t / hasMedia / id）
 *     window.require('WAWebLidMigrationUtils').toPn(wid)  ← @lid → 真号码
 *   走 Store 比读 DOM 强三点：
 *     ① **不用点开对话** → 不破坏老板的未读红点、不切走他正在看的会话；
 *     ② 不依赖 DOM 选择器（网页一改版就全失效，telegramRead 吃过这个亏）；
 *     ③ 一次拿全量，不必逐条滚动。
 *
 * ---- 为什么必须停在「WA①」页签才采得到 ----
 *   WhatsApp 网页只在**可见**时才刷新（不可见会被 Chromium 节流）。
 *   切到别的页签 / 把窗口最小化，网页就不动了 —— 这不是本模块的 bug。
 *   所以状态里带 visible 字段，界面上如实告诉老板「网页在后台，先切回来」。
 *   （外部一号~五号没这个毛病：它们各自有独立窗口，一直是可见的。）
 *
 * ---- 消息去重键 ----
 *   实测 Msg 的 id 是**裸对象**（{fromMe, remote, id}），**没有 _serialized**。
 *   所以去重键 = `${fromMe}_${remote}_${id}`，塞进 messages.wa_msg_id（UNIQUE），
 *   重复采集 / 重启后重捞都不会产生重复行。
 * ===================================================================== */

'use strict';

const whatsappWebView = require('./whatsappWebView'); // 唯一一条「找到内置浏览器页面」的通道
const identity = require('./identity');               // 只借它的**纯函数**（号码/名字清洗），不调浏览器
const codes = require('./ids');                       // ACC_WA_EMBEDDED = 10 → 客户编号走 WA 段

/** 我们给内置浏览器分配的账号号（老库 account_id 是 INTEGER，用 10 占位） */
const ACC_ID = codes.ACC_WA_EMBEDDED; // = 10

/**
 * 渠道名。刻意不叫 'whatsapp' —— WA① 是**内置浏览器内核**，一号~五号是
 * **软件外独立 Chrome 进程**，两者不是同类（老板 2026-10-14 定调）。
 * 分开标记，客户档案里一眼能看出这条是从哪来的。
 */
const CHANNEL = 'whatsapp-web';

/** 采集节拍：3 秒（老板拍板「跟 TG 一致」） */
const POLL_MS = 3000;

/**
 * 首轮最多回灌多少条**已有**历史消息。
 * 🔴 有上限是刻意的：没有它，第一次跑就会把网页内存里的会话历史一次全灌进库，
 *    左栏当场被几十条「待处理」淹没、还白烧几十次翻译。
 *    取 20 条 = 老板一打开就能看到「这几个会话 + 最近聊了什么」，
 *    又不至于变成搬家。想只看新消息把它改成 0 即可（下一条新消息照常进）。
 */
const FIRST_BATCH = 20;

/** 单轮最多入多少条（刷屏保护；剩下的下一轮接着入，绝不丢） */
const MAX_PER_TICK = 30;

/** 首轮落库后，最多保留多少个「已见」键（防止无限涨内存） */
const SEEN_MAX = 5000;

/** 页面侧读取上限（防极端账号把 evaluate 的返回值撑爆） */
const PAGE_MAX_CHATS = 1000;
const PAGE_MAX_CONTACTS = 1000;
const PAGE_MAX_MSGS = 1000;

/**
 * 单轮从页面搬回主进程的消息**硬上限**（2026-10-15 v2.6.1121）
 *
 * 以前每 3 秒把网页内存里最多 1000 条消息整个序列化搬进主进程再筛 ——
 * 会话一多，光是跨进程搬这一下就够卡。现在改成「水位当参数传进页面，页面先筛」，
 * 后续轮最多只搬 PAGE_MAX_NEW 条回来。首轮（水位还没建立）沿用老行为全量扫。
 */
const PAGE_MAX_NEW = 50;

/** 首轮落库后延迟多少毫秒才开始跑（别跟 Electron 启动抢主线程） */
const START_DELAY_MS = 3000;

/**
 * 这些 type 一律不收 —— 它们不是客户说的话，是 WhatsApp 的系统行。
 * 🔴 必须挡在 toMessage 里：这些行**有正文**（"消息和通话已端到端加密"、
 *    "你未接听的语音通话"…），只靠「正文为空就跳过」挡不住，
 *    放进去就会凭空建出一堆假客户。
 */
const JUNK_TYPES = new Set([
  'e2e_notification',    // 「消息已端到端加密」提示行
  'notification',        // 群公告 / 改群名一类的系统行
  'gp2',                 // 群成员进出 / 改群头像
  'call_log',            // 未接语音 / 视频通话记录
  'protocol',            // 协议消息（已读回执、密钥分发）
  'revoked',             // 「此消息已删除」（撤回）
  'ciphertext',          // 解不开的密文占位
  'debug',               // 调试
  'reaction',            // 表情回应
  'enc_reaction',
  'poll_creation', 'poll_update',
  'keep_in_chat', 'pin',
  'broadcast_notification', 'business_notification', 'business_removed',
  'payment', 'payment_invite', 'order', 'product',
  'groups_v4_invite', 'sender_key_distribution',
  'album',               // 相册聚合行（真正的图另有各自的 image 消息）
]);

/* =====================================================================
 * 一、注入到 WhatsApp 网页里的**只读**读取脚本
 * ---------------------------------------------------------------------
 * 这个函数**整个被 toString() 之后扔进网页执行**，所以：
 *   · 不许引用本文件里的任何外部变量（网页里根本看不到）；
 *   · 不许 await（保持同步，一次 evaluate 拿到全部结果）；
 *   · 返回的必须是能结构化克隆的**纯数据**（Model 对象带一堆循环引用，克隆会炸）。
 * 参数（全部由 pageProbeSource 传进来，源码里不写死）：
 *   MAX_CHATS / MAX_CONTACTS / MAX_MSGS —— 三段各自的读取上限；
 *   SINCE_TS —— 水位：只要 ts 大于它的消息（0 = 首轮，全量扫）；
 *   MAX_NEW  —— 有水位时单轮最多返回几条（页面侧就截断，别搬 1000 条回主进程）。
 * ===================================================================== */
function probeInPage(MAX_CHATS, MAX_CONTACTS, MAX_MSGS, SINCE_TS, MAX_NEW) {
  try {
    var req = (typeof window !== 'undefined' && window.require) || null;
    if (typeof req !== 'function') {
      return { ok: false, error: 'window.require 还不可用：WhatsApp 网页没加载完（或没登录）' };
    }
    var C = null;
    try { C = req('WAWebCollections'); } catch (e) { C = null; }
    if (!C) return { ok: false, error: 'WAWebCollections 读不到：网页可能还没登录' };

    var WID = null;
    var LIDM = null;
    try { WID = req('WAWebWidFactory'); } catch (e) { WID = null; }
    try { LIDM = req('WAWebLidMigrationUtils'); } catch (e) { LIDM = null; }

    /** Wid / 字符串 → 序列化 JID */    function ser(v) {
      if (!v) return '';
      if (typeof v === 'string') return v;
      try { return String(v._serialized || v.user || ''); } catch (e) { return ''; }
    }
    function models(coll) {
      try {
        if (!coll || typeof coll.getModelsArray !== 'function') return [];
        return coll.getModelsArray() || [];
      } catch (e) { return []; }
    }

    /* ---- @lid → 真号码（老板长期卡住的那个问题，这里是正规解法）----
     * 🔴 只读查表，不发任何网络请求；查不到就老实返回空串，绝不编。 */
    var pnByLid = {};
    function pnOf(jid) {
      var s = String(jid || '');
      if (!s || !/@lid$/i.test(s)) return '';
      if (Object.prototype.hasOwnProperty.call(pnByLid, s)) return pnByLid[s];
      var out = '';
      try {
        if (LIDM && typeof LIDM.toPn === 'function') {
          var w = s;
          if (WID && typeof WID.createWid === 'function') w = WID.createWid(s);
          out = ser(LIDM.toPn(w));
        }
      } catch (e) { out = ''; }
      pnByLid[s] = out;
      return out;
    }

    /* ---- 会话 ---- */
    var chats = [];
    var chatModels = models(C.Chat);
    for (var i = 0; i < chatModels.length && chats.length < MAX_CHATS; i++) {
      var c = chatModels[i];
      if (!c) continue;
      var cid = ser(c.id);
      if (!cid) continue;
      pnOf(cid); // 顺手把会话的 @lid → 真号码 记进映射表（下面组客户资料要用）
      var ct = c.contact || {};
      chats.push({
        id: cid,
        name: String(c.name || c.formattedTitle || ct.name || ct.pushname || ''),
        unread: Number(c.unreadCount || 0) || 0,
        ts: Number(c.t || c.timestamp || 0) || 0,
        isGroup: /@g\.us$/i.test(cid),
      });
    }

    /* ---- 联系人（好友资料）---- */
    var contacts = [];
    var contactModels = models(C.Contact);
    for (var j = 0; j < contactModels.length && contacts.length < MAX_CONTACTS; j++) {
      var p = contactModels[j];
      if (!p) continue;
      var pid = ser(p.id);
      if (!pid) continue;
      pnOf(pid);
      contacts.push({
        id: pid,
        name: String(p.name || ''),
        pushname: String(p.pushname || p.notifyName || ''),
        shortName: String(p.shortName || ''),
        // phoneNumber 优先（那是真正的 PN），退到 number
        number: ser(p.phoneNumber || p.number || ''),
        isMyContact: !!p.isMyContact,
      });
    }

    /* ---- 消息 ---- */
    // 🔴 2026-10-15 v2.6.1121：**水位当参数传进来，页面侧先筛**，只把该搬的搬回去。
    //    since > 0（后续轮）→ 只要比水位新的，按时间升序留最旧的 maxNew 条（保证每轮都往前推进）；
    //    since = 0（首轮）  → 沿用老行为：全量扫（最多 MAX_MSGS 条），排序与截断交给主进程。
    var since = Number(SINCE_TS) || 0;
    var maxNew = Number(MAX_NEW) || 0;
    var msgs = [];
    var msgModels = models(C.Msg);
    for (var k = 0; k < msgModels.length; k++) {
      var m = msgModels[k];
      if (!m || !m.id) continue;
      var idObj = m.id;
      var mid = (typeof idObj === 'string') ? idObj : String(idObj.id || '');
      if (!mid) continue;
      // 🔴 id.remote 就是**会话**的 JID（不管是收还是发），拿它当客户标识最稳。
      var remote = (typeof idObj === 'string') ? '' : String(idObj.remote || '');
      if (!remote) remote = ser(m.from) || ser(m.to);
      if (!remote) continue;
      var ts = Number(m.t || m.timestamp || 0) || 0;
      if (since > 0 && ts <= since) continue;   // 比水位旧的：页面侧直接丢，一字节都不搬
      var body = (m.body == null) ? '' : String(m.body);
      var hasMedia = !!(m.hasMedia || m.isMedia);
      // 空正文 + 没附件 = 系统行/撤回/表情回应，一律跳过（和 WA / Signal 同一条铁律）
      if (!body && !hasMedia) continue;
      pnOf(remote); // 这条消息的会话要是 @lid，把真号码一起带回去
      var sender = m.sender || {};
      msgs.push({
        mid: mid,
        fromMe: !!(typeof idObj === 'object' && idObj.fromMe),
        remote: remote,
        body: body,
        ts: ts,
        type: String(m.type || ''),
        hasMedia: hasMedia,
        pushName: String(m.notifyName || sender.pushname || sender.notifyName || ''),
      });
      if (since <= 0 && msgs.length >= MAX_MSGS) break; // 首轮沿用老上限
    }
    if (since > 0) {
      msgs.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      if (maxNew > 0 && msgs.length > maxNew) msgs = msgs.slice(0, maxNew);
    }

    return {
      ok: true,
      visible: (typeof document !== 'undefined' && document.visibilityState === 'visible'),
      url: String((typeof location !== 'undefined' && location.href) || ''),
      counts: {
        chats: chatModels.length,
        contacts: contactModels.length,
        messages: msgModels.length,
      },
      chats: chats,
      contacts: contacts,
      messages: msgs,
      pnByLid: pnByLid,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 生成可以直接 executeJavaScript 的页面脚本。
 * 🔴 五个参数**全部当参数传进去**，不在源码里做字符串替换 ——
 *    少一层「哪天漏替换就是一个语法错误」的隐患。
 *
 * @param {number} [sinceTs] 只收 ts 大于它的消息（0 = 首轮，全量扫）。
 *        这就是老板说的「水位」：告诉网页「我只关心这个时间点之后的消息」，
 *        网页自己先筛掉旧的，主进程不用再搬 1000 条回来自己筛。
 */
function pageProbeSource(sinceTs) {
  const since = Number(sinceTs) || 0;
  return `(${String(probeInPage)})(${PAGE_MAX_CHATS},${PAGE_MAX_CONTACTS},${PAGE_MAX_MSGS},${since},${PAGE_MAX_NEW})`;
}

/* =====================================================================
 * 二、纯函数：把页面返回的原始数据整理成「客户上下文」
 *     （抽成纯函数是为了能单测，不用真开浏览器）
 * ===================================================================== */

/** 这串 JID 是不是「真号码」形态（只有这两种后缀能推出电话） */
function isPnJid(jid) {
  return /@(c\.us|s\.whatsapp\.net)$/i.test(String(jid || '').trim());
}

/**
 * @param {object} raw 页面 probeInPage 的返回值
 * @returns {{chats:Array, contacts:Array, byChat:Map, byContact:Map, pnByLid:object}}
 */
function normalize(raw) {
  const chats = Array.isArray(raw && raw.chats) ? raw.chats : [];
  const contacts = Array.isArray(raw && raw.contacts) ? raw.contacts : [];
  const byChat = new Map();
  for (const c of chats) {
    const id = String((c && c.id) || '');
    if (id && !byChat.has(id)) byChat.set(id, c);
  }
  const byContact = new Map();
  for (const p of contacts) {
    const id = String((p && p.id) || '');
    if (id && !byContact.has(id)) byContact.set(id, p);
  }
  const pnByLid = (raw && raw.pnByLid && typeof raw.pnByLid === 'object') ? raw.pnByLid : {};
  return { chats, contacts, byChat, byContact, pnByLid };
}

/** 某个 JID 对应的真号码 JID（@lid 才会去查表；查不到返回空串） */
function pnJidOf(jid, ctx) {
  const s = String(jid || '').trim();
  if (!s) return '';
  if (isPnJid(s)) return s;
  const pn = ctx && ctx.pnByLid ? ctx.pnByLid[s] : '';
  return pn && isPnJid(pn) ? String(pn) : '';
}

/**
 * 把某个会话 JID 组装成一个「像 wwjs Contact」的对象，喂给 identity 的纯函数。
 * 🔴 关键一步：**把 @lid 换成真号码 JID**。
 *    identity.phoneFromContact 对 @lid 的 id 是**故意不信**的（它见过的假号码
 *    243834688639050 就是这么存进去的），不换的话这批 LID 客户一个号码都拿不到。
 */
function contactFor(jid, ctx) {
  const s = String(jid || '').trim();
  if (!s) return null;
  const pn = pnJidOf(s, ctx);
  const base = (ctx.byContact.get(s)) || (pn ? ctx.byContact.get(pn) : null) || null;
  if (!base && !pn) return null;
  const out = Object.assign({}, base || {});
  if (pn) {
    out.id = pn;
    out.number = pn.split('@')[0];
  } else if (!out.id) {
    out.id = s;
  }
  return out;
}

/**
 * 一条原始消息 → 和 Signal / Telegram 同构的统一结构。
 * @param {object} raw 页面里那一条（mid / fromMe / remote / body / ts / type / hasMedia）
 * @param {object} ctx normalize() 的产物
 * @returns {null|object} 不该收的返回 null
 */
function toMessage(raw, ctx) {
  if (!raw) return null;

  const remote = String(raw.remote || '').trim();
  if (!remote) return null;
  // 🔴 群聊 / 广播 / 状态 一律不收：
  //    群不是「一个客户」，状态（@broadcast）是朋友圈，收进来只会污染客户档案。
  if (/@g\.us$/i.test(remote)) return null;
  if (/@broadcast$/i.test(remote)) return null;

  const mid = String(raw.mid || '').trim();
  if (!mid) return null;

  const type = String(raw.type || '');
  if (JUNK_TYPES.has(type)) return null;

  const body = String(raw.body == null ? '' : raw.body);
  const hasAttachment = !!raw.hasMedia;
  if (!body.trim() && !hasAttachment) return null;

  // 🔴 2026-10-15 老板：挡掉 WhatsApp 官方系统会话（如 wa1:0@c.us）。
  //    这类 JID 的 user 段不是真号码（真号是 6~15 位纯数字），它偶尔会吐一大段
  //    base64 图片当"消息"，正文是"抱歉，我无法处理这个请求。"，绝不能当客户新消息。
  if (/@c\.us$/i.test(remote)) {
    const userPart = String((remote.split('@')[0]) || '');
    if (!/^\d{6,15}$/.test(userPart)) return null; // 非真号码 → 丢
  }

  // 🔴 2026-10-15 老板：挡掉整串 base64 图片 dump（实样 17584 字节纯 base64 JPEG）。
  //    真人类消息极少是"纯 base64 且超长"，命中就是机器吐的脏数据。
  if (body.length > 300 && /^[A-Za-z0-9+/=\s]+$/.test(body)) return null;

  const chat = ctx.byChat.get(remote) || null;
  const cObj = contactFor(remote, ctx);

  // ---- 号码：会话 JID 本身是号码 → 最直接；否则问 Contact；再否则问 @lid 映射表 ----
  let phone = '';
  let phoneSrc = '';
  const pJid = identity.phoneFromJid(remote);
  if (pJid) { phone = pJid; phoneSrc = 'jid'; }
  if (!phone) {
    const p2 = identity.phoneFromContact(cObj);
    if (p2) { phone = p2; phoneSrc = 'contact'; }
  }
  if (!phone) {
    // @lid 会话：pnByLid 里要是查到了真号码，可信度等同 contact
    const p3 = identity.phoneFromJid(pnJidOf(remote, ctx));
    if (p3) { phone = p3; phoneSrc = 'contact'; }
  }

  // ---- 名字：通讯录备注 > 对方昵称 > 会话标题 > 消息自带 pushName ----
  let name = identity.nameFromContact(cObj, phone)
    || identity.nameFromChat(chat, phone)
    || identity.cleanName(raw.pushName, phone);

  const tsSec = Number(raw.ts) > 0 ? Number(raw.ts) : Math.floor(Date.now() / 1000);

  return {
    accountId: ACC_ID,
    channel: CHANNEL,
    // 客户标识（wa_jid 列）：一眼看出是「内置浏览器 + 哪个会话」
    displayJid: `wa1:${remote}`,
    // 去重键的一部分 / 日志用
    customerKey: remote,
    // 🔴 实测 Msg.id 没有 _serialized，只能自己拼：fromMe_remote_id
    msgId: `${raw.fromMe ? 1 : 0}_${remote}_${mid}`,
    direction: raw.fromMe ? 'out' : 'in',
    // 有附件没正文时 body 留空、标 mediaType —— 和 Telegram 的既有取舍一致
    body: body.trim() ? body : '',
    hasAttachment,
    mediaType: (hasAttachment && !body.trim()) ? 'image' : '',
    ts: new Date(tsSec * 1000).toISOString(),
    tsSec,
    name: name || '',
    phone: phone || '',
    phoneSrc: phone ? phoneSrc : '',
    region: phone ? identity.countryOfPhone(phone) : '',
  };
}

/**
 * 一个会话 → 一张「好友资料卡」（首轮同步用）。
 * 不造消息、不动未读，只把名字/号码/地区带过去建档。
 */
function contactCard(chat, ctx) {
  const jid = String((chat && chat.id) || '').trim();
  if (!jid || /@g\.us$/i.test(jid) || /@broadcast$/i.test(jid)) return null;
  const cObj = contactFor(jid, ctx);
  let phone = identity.phoneFromJid(jid);
  let phoneSrc = phone ? 'jid' : '';
  if (!phone) {
    const p = identity.phoneFromContact(cObj);
    if (p) { phone = p; phoneSrc = 'contact'; }
  }
  if (!phone) {
    const p = identity.phoneFromJid(pnJidOf(jid, ctx));
    if (p) { phone = p; phoneSrc = 'contact'; }
  }
  const name = identity.nameFromContact(cObj, phone)
    || identity.nameFromChat(chat, phone)
    || '';
  return {
    accountId: ACC_ID,
    channel: CHANNEL,
    displayJid: `wa1:${jid}`,
    customerKey: jid,
    name: name || '',
    phone: phone || '',
    phoneSrc,
    region: phone ? identity.countryOfPhone(phone) : '',
  };
}

/** 页面原始消息 → 会话内去重键（和 toMessage 的 msgId 保持一致） */
function rawKey(raw) {
  return `${raw && raw.fromMe ? 1 : 0}_${String((raw && raw.remote) || '')}_${String((raw && raw.mid) || '')}`;
}

/* =====================================================================
 * 三、模块级运行状态（单例，和 telegramRead 的 browsers 表一个思路）
 * ===================================================================== */

let _timer = null;
let _opts = null;
let _stopped = true;
let _busy = false;
let _initialized = false;
let _seen = new Set();
let _watermark = 0;        // 已读到的最新时间戳（秒）
let _failCount = 0;
let _stats = {
  ok: false,
  status: 'idle',
  accountId: ACC_ID,
  channel: CHANNEL,
  pollMs: POLL_MS,
  chats: 0,
  contacts: 0,
  unread: 0,
  read: 0,
  visible: false,
  firstRun: false,
  lastTickAt: '',
  error: '',
};

function setStats(patch) {
  _stats = Object.assign({}, _stats, patch || {});
}

/** 把状态推给上层（main.js 会转成 broadcastSafe('whatsapp_status', …)） */
function notifyState() {
  if (_opts && typeof _opts.onState === 'function') {
    try { _opts.onState(Object.assign({}, _stats)); } catch (e) { /* 状态回调抛错绝不能停采集 */ }
  }
}

/* =====================================================================
 * 四、读一轮网页
 * ===================================================================== */

function defaultFindPage() {
  // 🔴 唯一一条「找到内置浏览器页面」的通道，复用 whatsappWebView，不另造一份。
  return whatsappWebView.findGuest();
}

/**
 * 在网页里跑一次只读读取脚本。
 * @param {number} [sinceTs] 水位：只要比它新的消息（0 = 全量，排障/首轮用）
 * @returns {Promise<{ok:boolean, raw?:object, status?:string, error?:string}>}
 */
async function readPage(sinceTs) {
  const find = (_opts && typeof _opts.findPage === 'function') ? _opts.findPage : defaultFindPage;
  let page = null;
  try { page = find(); } catch (e) { page = null; }
  if (!page) {
    return {
      ok: false,
      status: 'no-page',
      error: '没找到内置浏览器页面 —— 先点中栏「WA①」页签把 WhatsApp 网页打开',
    };
  }
  let raw = null;
  try {
    raw = await page.executeJavaScript(pageProbeSource(sinceTs), false);
  } catch (e) {
    return { ok: false, status: 'error', error: '注入失败：' + String((e && e.message) || e) };
  }
  if (!raw || raw.ok !== true) {
    return {
      ok: false,
      status: 'unreadable',
      error: String((raw && raw.error) || '页面没有返回数据（可能还没登录 / 页面还在加载）'),
    };
  }
  return { ok: true, raw };
}

/** 只读探测（给 /api/whatsapp/read/probe 排障用），带样本但不整份倒出来 */
async function probe() {
  const r = await readPage();
  if (!r.ok) {
    const pages = (() => { try { return whatsappWebView.listPages(); } catch (e) { return null; } })();
    return { ok: false, status: r.status, error: r.error, pages };
  }
  const raw = r.raw;
  const ctx = normalize(raw);
  const sampleMsgs = (raw.messages || [])
    .slice(-5)
    .map((m) => toMessage(m, ctx))
    .filter(Boolean);
  return {
    ok: true,
    visible: !!raw.visible,
    url: raw.url || '',
    counts: raw.counts || { chats: 0, contacts: 0, messages: 0 },
    // 只有会话里**不是群**的那几个才算客户（群/广播在 toMessage 里会被挡掉）
    customerCandidates: ctx.chats.filter((c) => !c.isGroup && !/@broadcast$/i.test(String(c.id))).length,
    lidResolved: Object.keys(ctx.pnByLid).filter((k) => ctx.pnByLid[k]).length,
    lidTotal: Object.keys(ctx.pnByLid).length,
    chatsSample: ctx.chats.slice(0, 5),
    contactsSample: ctx.contacts.slice(0, 5),
    messagesSample: sampleMsgs,
  };
}

/* =====================================================================
 * 五、一轮采集
 * ===================================================================== */

/**
 * 跑一轮。可以反复调（测试里直接调它，不挂定时器）。
 * @returns {Promise<object>} 本轮状态
 */
async function tick() {
  if (_busy) return Object.assign({}, _stats);
  _busy = true;
  try {
    if (_opts && typeof _opts.shouldRun === 'function') {
      let go = true;
      try { go = !!_opts.shouldRun(); } catch (e) { go = true; }
      if (!go) {
        setStats({ status: 'paused', error: '' });
        notifyState();
        return Object.assign({}, _stats);
      }
    }

    // 🔴 水位当参数传进页面：首轮（水位还没建立）传 0 全量扫，
    //    之后每轮只让网页把「比水位新的」搬回来（最多 PAGE_MAX_NEW 条）。
    const r = await readPage(_initialized ? _watermark : 0);
    if (!r.ok) {
      _failCount += 1;
      const changed = _stats.status !== r.status;
      setStats({ ok: false, status: r.status, error: r.error, read: 0 });
      // 状态**变了**才往上报（否则每 3 秒推一次同样的错，界面白刷）；
      // 连续失败 3 次再补报一次，确保"一直读不到"也一定会被看见（同 signalRead）。
      if (changed || _failCount === 3) notifyState();
      return Object.assign({}, _stats);
    }

    _failCount = 0;
    const raw = r.raw;
    const ctx = normalize(raw);
    let items = [];
    const wasFirst = !_initialized;

    if (!_initialized) {
      /* ---- 首轮：把网页内存里已有的消息按时间排序，**只回灌最新 FIRST_BATCH 条** ---- */
      const all = (raw.messages || []).slice().filter((m) => rawKey(m));
      all.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
      for (const m of all) _seen.add(rawKey(m));
      const tail = FIRST_BATCH > 0 ? all.slice(-FIRST_BATCH) : [];
      if (tail.length) {
        _watermark = Number(tail[tail.length - 1].ts) || 0;
      } else {
        // 一条都不回灌时，水位直接顶到「现在」，只收此后新来的
        _watermark = all.length ? (Number(all[all.length - 1].ts) || 0) : Math.floor(Date.now() / 1000);
      }
      items = tail;
      _initialized = true;
      console.log(
        `[WA①] 首轮建立水位：网页内存 ${all.length} 条消息，回灌最新 ${tail.length} 条，` +
        `水位 ts=${_watermark}`
      );

      /* ---- 好友资料：把「有会话的」联系人报上去建档（只做这一轮）---- */
      if (_opts && typeof _opts.onContacts === 'function' && ctx.chats.length) {
        try {
          const cards = ctx.chats.map((c) => contactCard(c, ctx)).filter(Boolean);
          if (cards.length) _opts.onContacts(cards);
        } catch (e) {
          console.warn('[WA①] 好友资料同步失败（不影响采集）：', (e && e.message) || e);
        }
      }
    } else {
      /* ---- 后续轮：只收水位之上的新消息；水位之下的一律记下、绝不回灌 ---- */
      const cands = [];
      for (const m of (raw.messages || [])) {
        const k = rawKey(m);
        if (!k || _seen.has(k)) continue;
        if ((Number(m.ts) || 0) <= _watermark) { _seen.add(k); continue; }
        cands.push(m);
      }
      cands.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
      // 🔴 只取前 MAX_PER_TICK 条，**超出的不加进 _seen** —— 下一轮接着收，一条都不丢。
      //    （先全加进 _seen 再截断 = 被截掉的那些永远收不到，是个隐蔽的丢消息 bug。）
      const take = cands.slice(0, MAX_PER_TICK);
      for (const m of take) {
        _seen.add(rawKey(m));
        const t = Number(m.ts) || 0;
        if (t > _watermark) _watermark = t;
      }
      items = take;
    }

    // 清一次 _seen，防止长跑几个月把内存撑起来
    if (_seen.size > SEEN_MAX) {
      const keep = new Set();
      for (const m of (raw.messages || [])) {
        const k = rawKey(m);
        if (k && _seen.has(k)) keep.add(k);
      }
      _seen = keep;
    }

    const mapped = items.map((m) => toMessage(m, ctx)).filter(Boolean);
    if (mapped.length && _opts && typeof _opts.onMessages === 'function') {
      try { _opts.onMessages(mapped); } catch (e) {
        // 🔴 入库回调抛错绝不能停掉采集 —— 停了整条线就死了，而且没人知道
        console.warn('[WA①] onMessages 抛错（不影响其余）：', (e && e.message) || e);
      }
    }

    let unread = 0;
    for (const c of ctx.chats) unread += Number(c.unread) || 0;

    setStats({
      ok: true,
      status: 'collecting',
      visible: !!raw.visible,
      chats: ctx.chats.length,
      contacts: ctx.contacts.length,
      unread,
      read: mapped.length,
      firstRun: wasFirst,
      lastTickAt: new Date().toISOString(),
      error: raw.visible ? '' : 'WhatsApp 网页在后台（切到「WA①」页签它才会刷新）',
    });
    notifyState();
    return Object.assign({}, _stats);
  } catch (e) {
    setStats({ ok: false, status: 'error', error: String((e && e.message) || e), read: 0 });
    notifyState();
    return Object.assign({}, _stats);
  } finally {
    _busy = false;
  }
}

function schedule(delay) {
  if (_stopped) return;
  _timer = setTimeout(() => {
    tick().catch(() => {}).then(() => schedule(POLL_MS));
  }, Number(delay) >= 0 ? Number(delay) : POLL_MS);
  if (_timer && _timer.unref) _timer.unref();
}

/* =====================================================================
 * 六、对外接口
 * ===================================================================== */

/**
 * 起采集。
 * @param {object} o
 * @param {(batch:object[])=>void} o.onMessages 拿到新消息时回调（同步返回，不 await）
 * @param {(cards:object[])=>void} [o.onContacts] 首轮把「有会话的联系人」报上去建档
 * @param {(st:object)=>void} [o.onState] 状态变化回调
 * @param {()=>boolean} [o.shouldRun] 本轮要不要真读（返回 false 则跳过本轮，不丢消息）
 * @param {()=>object} [o.findPage] 测试注入用：默认走 whatsappWebView.findGuest()
 * @param {number} [o.intervalMs]
 */
function startWatching(o = {}) {
  stopWatching(); // 幂等：重复调用不会把定时器起两份
  _opts = {
    onMessages: o.onMessages,
    onContacts: o.onContacts,
    onState: o.onState,
    shouldRun: o.shouldRun,
    findPage: o.findPage,
  };
  const interval = Number(o.intervalMs) > 0 ? Number(o.intervalMs) : POLL_MS;
  _stopped = false;
  _busy = false;
  _initialized = false;
  _failCount = 0;
  _seen = new Set();
  _watermark = 0;
  setStats({
    ok: false, status: 'starting', read: 0, chats: 0, contacts: 0,
    unread: 0, firstRun: false, lastTickAt: '', error: '',
    pollMs: interval,
  });
  notifyState();

  /* 🔴 测试环境绝不挂定时器 —— 一个 setTimeout 就能把测试进程挂着不退出。
     规矩同 startExtractLoop / startSignalPolling / telegramRead.startWatching。
     测试直接调返回的 tick()。 */
  if (!process.env.BEE_TEST) {
    schedule(START_DELAY_MS);
  }

  return {
    stop: stopWatching,
    // 🔴 必须走模块级的 state()：它才带上 watching / watermark 这些派生字段。
    //    之前这里写成 () => Object.assign({}, _stats)，界面永远读不到 watching。
    state,
    /** 跑一轮（测试 / 手动触发用） */
    tick,
    intervalMs: interval,
  };
}

function stopWatching() {
  _stopped = true;
  if (_timer) clearTimeout(_timer);
  _timer = null;
}

/** 当前状态（给 /api/whatsapp/read/state 用） */
function state() {
  return Object.assign({}, _stats, {
    initialized: _initialized,
    seen: _seen.size,
    watermark: _watermark,
    watching: !_stopped,
  });
}

/**
 * 把内部状态翻成一句人话 + 一个颜色档位（界面状态条直接用）。
 *
 * 🔴 文案放在**状态的生产者**这里，而不是散在 main.js / server.js 各写一套：
 *    两个消费者（main.js 的 onState 广播、server.js 的 /api/whatsapp/read/state）
 *    共用同一份 —— 否则同一个状态在"实时推的"和"轮询拉的"两条路上说法不一样，
 *    老板看到的状态条会自己跳变，很难查。
 *
 * @returns {{level: 'ok'|'warn'|'error'|'muted', text: string}}
 */
function describe(st) {
  const s = st || _stats;
  const status = String(s.status || '');
  if (status === 'idle') return { level: 'muted', text: '' };
  if (status === 'starting') return { level: 'muted', text: 'WA①：采集启动中…' };
  if (status === 'no-page') {
    return {
      level: 'warn',
      text: 'WA①：内置浏览器还没打开 —— 点中栏「WA①」页签把 WhatsApp 网页开起来',
    };
  }
  if (status === 'unreadable' || status === 'error') {
    return { level: 'error', text: `WA①：读不到（${s.error || '未知原因'}）` };
  }
  if (status === 'paused') {
    return { level: 'muted', text: 'WA①：暂停中（让路给进程扫描，下一轮自动接着读）' };
  }
  if (status === 'collecting') {
    const parts = [];
    if (typeof s.chats === 'number') parts.push(`会话 ${s.chats} 项`);
    if (typeof s.contacts === 'number') parts.push(`联系人 ${s.contacts} 个`);
    if (typeof s.unread === 'number') parts.push(`未读 ${s.unread} 个`);
    parts.push(`本轮读到 ${s.read || 0} 条`);
    // 🔴 网页被切到后台就不刷新 —— 这是 WhatsApp Web 自己的行为，不是 bug。
    //    必须明说，否则老板会以为"采集坏了"。
    if (!s.visible) parts.push('⚠ 网页在后台，切回「WA①」页签才会刷新');
    return { level: s.visible ? 'ok' : 'warn', text: `WA①：采集中（${parts.join('，')}）` };
  }
  return { level: 'muted', text: `WA①：${status}` };
}

module.exports = {
  ACC_ID,
  CHANNEL,
  POLL_MS,
  FIRST_BATCH,
  MAX_PER_TICK,
  JUNK_TYPES,
  // 纯函数（单测直接测这些，不用开浏览器）
  isPnJid,
  normalize,
  pnJidOf,
  contactFor,
  toMessage,
  contactCard,
  rawKey,
  pageProbeSource,
  describe,
  // 需要浏览器的
  readPage,
  probe,
  tick,
  // 轮询
  startWatching,
  stopWatching,
  state,
};
