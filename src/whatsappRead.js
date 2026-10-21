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
 * ---- v2.6.1134：复刻成 WA①~WA⑤ 五个内置浏览器标签（参数化共用一套）----
 *   老板 2026-10-16 拍板：把 WA① 的全部功能**原样复制**成 5 个标签
 *   （WA①/WA②/WA③/WA④/WA⑤），各自独立账号号（10~14）、独立数据分区
 *   （persist:wa6 ~ persist:wa10）、独立编号段（WA/WB/WD/WE/WF）、独立显示前缀
 *   （wa1~wa5）。
 *   🔴 实现要点（老板选的「参数化共用一套」方案）：采集/入库/翻译/气泡**只写一套
 *   内核**，5 个实例只是把 accId / partition / prefix / label 当成参数传进去，
 *   绝不另起 5 套重复模块。模块级导出的仍是 **WA① 实例**（accId=10 / wa1 / wa6），
 *   所以所有既有测试（displayJid=wa1:…、ACC_ID=10、startWatching 行为）纹丝不动；
 *   其余 4 个实例由 main.js 通过 createInstance(cfg) 起出来。
 * ===================================================================== */

'use strict';

const whatsappWebView = require('./whatsappWebView'); // 唯一一条「找到内置浏览器页面」的通道
const identity = require('./identity');               // 只借它的**纯函数**（号码/名字清洗），不调浏览器
const phoneFill = require('./phoneFill');             // v2.6.1164：落库前把号码规整成带 + 的 e164
const codes = require('./ids');                       // ACC_WA_EMBEDDED = 10 → 客户编号走 WA 段

/** 渠道名。刻意不叫 'whatsapp' —— WA①~⑤ 是**内置浏览器内核**，一号~五号是
 *  **软件外独立 Chrome 进程**，两者不是同类（老板 2026-10-14 定调）。
 *  分开标记，客户档案里一眼能看出这条是从哪来的。 */
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

/* 🔴 2026-10-20 修复：客户刚发图片时 directPath 可能还没到 → hasMedia=false，
 *    但 Msg.type 已能认出是图片/视频/语音。只认 hasMedia 会把这类图在探针层直接丢弃、
 *    水位越过后再也捞不回来。这里补 type 兜底，和外置 main.js 的 MEDIA_TYPES 同口径。 */
const MEDIA_TYPES = new Set([
  'image', 'sticker', 'video', 'audio', 'ptt', 'document', 'gif',
]);

/* =====================================================================
 * 一、注入到 WhatsApp 网页里的**只读**读取脚本
 * ---------------------------------------------------------------------
 * 这个函数**整个被 toString() 之后扔进网页执行**，所以：
 *   · 不许引用本文件里的任何外部变量（网页里根本看不到）；
 *   · 不许 await（保持同步，一次 evaluate 拿到全部结果）；
 *   · 返回的必须是能结构化克隆的**纯数据**（Model 对象带一堆循环引用，克隆会炸）。
 * 参数（全部由 pageProbeSource 传进去，源码里不写死）：
 *   MAX_CHATS / MAX_CONTACTS / MAX_MSGS —— 三段各自的读取上限；
 *   SINCE_TS —— 水位：只要 ts 大于它的消息（0 = 首轮，全量扫）；
 *   MAX_NEW  —— 有水位时单轮最多返回几条（页面侧就截断，别搬 1000 条回主进程）。
 * ===================================================================== */
function probeInPage(MAX_CHATS, MAX_CONTACTS, MAX_MSGS, SINCE_TS, MAX_NEW, MEDIA_TYPES_LIST) {
  try {
    // 🔴 2026-10-20 修：probeInPage 会被序列化成字符串丢进网页里跑（pageProbeSource），
    //    网页侧拿不到 Node 的模块级 const MEDIA_TYPES → 报 "MEDIA_TYPES is not defined"。
    //    所以这里只能用自己的局部 Set：优先用主进程透传进来的清单（和 Node 侧同源），
    //    没有就回退一份内置清单，绝不引用任何 Node 作用域的变量。
    var MEDIA_SET = (MEDIA_TYPES_LIST && MEDIA_TYPES_LIST.length)
      ? new Set(MEDIA_TYPES_LIST)
      : new Set(['image', 'sticker', 'video', 'audio', 'ptt', 'document', 'gif']);
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

    /** 媒体 MIME 兜底正则（从 mimetype 反推类型用） */
    function mediaMimeRe(s) {
      return /^image\/|^video\/|^audio\/|application\/(pdf|vnd|msword|octet-stream)/i.test(String(s || ''));
    }
    /** 一条消息对象「是不是媒体」—— 用尽所有能拿到的信号
     *  🔴 2026-10-20 换方法：内置 WA webview 的媒体消息，directPath 常还没到 →
     *    hasMedia=false、type 可能为空，单看这两个会漏。mediaData / directPath /
     *    mediatype / mimetype 都算，确保「图片/语音/视频/文件」一条不漏。 */
    function looksLikeMedia(m) {
      try {
        if (m.hasMedia || m.isMedia) return true;
        var t = String(m.type || '').toLowerCase();
        if (MEDIA_SET.has(t)) return true;
        if (m.directPath) return true;
        if (m.mediaData && (m.mediaData.type || m.mediaData.mediaStage || m.mediaData.filehash || m.mediaData.encFilehash)) return true;
        if (m.mediatype && MEDIA_SET.has(String(m.mediatype).toLowerCase())) return true;
        if (m.mimetype && mediaMimeRe(m.mimetype)) return true;
        if (m.ptt === true) return true;
        return false;
      } catch (e) { return false; }
    }
    /** 推断真实媒体类型（m.type 缺时从 mediaData / mediatype / mimetype 兜底反推） */
    function mediaTypeOf(m) {
      var t = String(m.type || '').toLowerCase();
      if (MEDIA_SET.has(t)) return t;
      if (m.mediaData && m.mediaData.type && MEDIA_SET.has(String(m.mediaData.type).toLowerCase())) return String(m.mediaData.type).toLowerCase();
      if (m.mediatype && MEDIA_SET.has(String(m.mediatype).toLowerCase())) return String(m.mediatype).toLowerCase();
      var mm = String(m.mimetype || '').toLowerCase();
      if (mm.indexOf('image/gif') >= 0) return 'gif';
      if (mm.indexOf('image/') >= 0) return 'image';
      if (mm.indexOf('video/') >= 0) return 'video';
      if (mm.indexOf('audio/') >= 0) return (m.ptt ? 'ptt' : 'audio');
      if (mm.indexOf('pdf') >= 0) return 'document';
      if (m.directPath || (m.mediaData && (m.mediaData.mediaStage || m.mediaData.type))) return 'image'; // 兜底
      return '';
    }

    /* ---- @lid → 真号码（老板长期卡住的那个问题，这里是正规解法）----
     * 🔴 只读查表，不发任何网络请求；查不到就老实返回空串，绝不编。 */
    var pnByLid = {};
    function pnOf(jid) {
      // 🔴 2026-10-18 老板拍板「三处」之二：去掉 JID 末尾设备后缀（如 @lid:2），否则 @lid$ 判定失准
      var s = String(jid || '').replace(/:\d+$/, '').trim();
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
    var mediaFound = 0;
    var mediaSample = null;
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
      // 🔴 2026-10-20 换方法：内置 WA webview 的媒体消息，directPath 常还没到 →
      //    hasMedia=false、type 可能为空，单看这两个会漏。改用多信号兜底判定
      //    （mediaData / directPath / mediatype / mimetype 都算），type 缺时从 mediaData/mimetype 反推。
      var mType = mediaTypeOf(m);
      var isMedia = looksLikeMedia(m);
      // 空正文 + 不像媒体 = 系统行/撤回/表情回应，跳过（和 WA / Signal 同一条铁律）
      if (!body && !isMedia) continue;
      pnOf(remote); // 这条消息的会话要是 @lid，把真号码一起带回去
      if (isMedia) {
        mediaFound++;
        if (!mediaSample) {
          // 🔴 诊断快照：把第一条媒体消息在页面里的真实字段打出来，
          //    老板在日志里就能看见「到底是哪个字段有值」，不用猜。
          mediaSample = {
            type: String(m.type || ''),
            hasMedia: !!m.hasMedia, isMedia: !!m.isMedia,
            directPath: !!m.directPath,
            mediaData: !!(m.mediaData),
            mediaDataFields: m.mediaData ? Object.keys(m.mediaData).slice(0, 8) : [],
            mediatype: String(m.mediatype || ''),
            mimetype: String(m.mimetype || ''),
            ptt: !!m.ptt, bodyLen: body.length,
            inferred: mType,
          };
        }
      }
      var sender = m.sender || {};
      msgs.push({
        mid: mid,
        fromMe: !!(typeof idObj === 'object' && idObj.fromMe),
        remote: remote,
        body: body,
        ts: ts,
        type: mType,
        hasMedia: isMedia,
        pushName: String(m.notifyName || sender.pushname || sender.notifyName || ''),
      });
      if (since <= 0 && msgs.length >= MAX_MSGS) break; // 首轮沿用老上限
    }

    // 🔴 2026-10-20 兜底：每个会话的 lastMessage / lastReceivedMessage 也扫一遍（只看媒体）。
    //    内置 WA webview 里，非前台会话的媒体消息可能还没进 C.Msg 集合（懒加载），
    //    但会话列表的「最后一条消息」一定存在（聊天列表要显示预览），用它兜底抓最新一张图/一段语音。
    //    （只取像媒体的，避免把普通文字末条重复搬进来。）
    try {
      var chatModelsForMedia = models(C.Chat);
      for (var cmi = 0; cmi < chatModelsForMedia.length; cmi++) {
        var chm = chatModelsForMedia[cmi];
        if (!chm) continue;
        var cLast = chm.lastMessage || chm.lastReceivedMessage || null;
        if (!cLast || !cLast.id) continue;
        var cMid = (typeof cLast.id === 'string') ? cLast.id : String(cLast.id.id || '');
        if (!cMid) continue;
        var dup = false;
        for (var di = 0; di < msgs.length; di++) { if (msgs[di].mid === cMid) { dup = true; break; } }
        if (dup) continue;
        var cRemote = (typeof cLast.id === 'string') ? '' : String(cLast.id.remote || '');
        if (!cRemote) cRemote = ser(cLast.from) || ser(cLast.to);
        if (!cRemote) continue;
        var cTs = Number(cLast.t || cLast.timestamp || 0) || 0;
        if (since > 0 && cTs <= since) continue;
        var cBody = (cLast.body == null) ? '' : String(cLast.body);
        var cType = mediaTypeOf(cLast);
        var cIsMedia = looksLikeMedia(cLast);
        if (!cIsMedia) continue; // 只兜底媒体，不重复搬普通文字
        pnOf(cRemote);
        mediaFound++;
        if (!mediaSample) {
          mediaSample = {
            type: String(cLast.type || ''),
            hasMedia: !!cLast.hasMedia, isMedia: !!cLast.isMedia,
            directPath: !!cLast.directPath,
            mediaData: !!(cLast.mediaData),
            mediaDataFields: cLast.mediaData ? Object.keys(cLast.mediaData).slice(0, 8) : [],
            mediatype: String(cLast.mediatype || ''),
            mimetype: String(cLast.mimetype || ''),
            ptt: !!cLast.ptt, bodyLen: cBody.length,
            from: 'chat.lastMessage', inferred: cType,
          };
        }
        var cSender = cLast.sender || {};
        msgs.push({
          mid: cMid,
          fromMe: !!(typeof cLast.id === 'object' && cLast.id.fromMe),
          remote: cRemote,
          body: cBody,
          ts: cTs,
          type: cType,
          hasMedia: true,
          pushName: String(cLast.notifyName || cSender.pushname || cSender.notifyName || ''),
        });
      }
    } catch (e) {}
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
        media: mediaFound,
      },
      mediaSample: mediaSample,
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
  return `(${String(probeInPage)})(${PAGE_MAX_CHATS},${PAGE_MAX_CONTACTS},${PAGE_MAX_MSGS},${since},${PAGE_MAX_NEW}, ${JSON.stringify([...MEDIA_TYPES])})`;
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
  // 🔴 2026-10-18 老板拍板「三处」之二：查表前同样剥掉设备后缀，和 pnOf 同口径
  const s = String(jid || '').replace(/:\d+$/, '').trim();
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
 * 🔴 2026-10-19 老板原话：「这个自动抓取可以检测档案的名称有没有存在电话号码」。
 * 很多 WA 联系人的「名字 / 昵称 / 会话标题」本身就是电话号码（尤其是新联系人、没设昵称的），
 * 这时从 JID / Contact.number / 正文都拿不到号，只能从名字里抠。
 * 用 identity.phoneFromText（要求带 + 国际区号或纯 8~13 位数字），不会把门牌号 / 房间号误当号码。
 *
 * @param {object|null} cObj contactFor() 的产物（含 name/pushname/shortName）
 * @param {object|null} chat normalize() 的会话对象（含 name/formattedTitle）
 * @returns {string} 抠到的带 + E164 号码，或 ''
 */
function phoneFromName(cObj, chat) {
  const cands = [
    cObj && (cObj.name || cObj.pushname || cObj.shortName),
    chat && (chat.name || chat.formattedTitle),
  ];
  for (const c of cands) {
    if (!c) continue;
    const p = identity.phoneFromText(String(c));
    if (p) return p;
  }
  return '';
}

/**
 * 一条原始消息 → 和 Signal / Telegram 同构的统一结构。
 * @param {object} raw 页面里那一条（mid / fromMe / remote / body / ts / type / hasMedia）
 * @param {object} ctx normalize() 的产物
 * @param {object} inst 实例配置 { accId, prefix }
 * @returns {null|object} 不该收的返回 null
 */
function toMessageFor(raw, ctx, inst) {
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
  const hasAttachment = !!(raw.hasMedia || MEDIA_TYPES.has(String(raw.type || '').toLowerCase()));
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
  // 🔴 2026-10-20 补：带附件的消息（图片/语音/视频）正文可能含长串字符（如语音转写占位），
  //    不再因「整串 base64」规则误杀；只有纯文字消息才走这条过滤。
  if (!hasAttachment && body.length > 300 && /^[A-Za-z0-9+/=\s]+$/.test(body)) return null;

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
  // 🔴 2026-10-18 老板拍板「三处」之三：上面都没拿到，最后从消息正文里抠号码
  //    （客户常在开场白里直接写 "my number is +44..."）。phoneFromText 只认像号码的纯数字段，
  //    不会把订单号/邮编写进去；作为最后兜底，可信度最低（text）。
  if (!phone && raw.body) {
    const p4 = identity.phoneFromText(String(raw.body));
    if (p4) { phone = p4; phoneSrc = 'text'; }
  }
  // 🔴 2026-10-19 老板：名字/昵称/会话标题本身可能就是电话号码（新联系人常把号码当名字）。
  //    上面都没拿到，最后从名字里抠一次。只认像号码的，绝不乱塞。
  if (!phone) {
    const pn = phoneFromName(cObj, chat);
    if (pn) { phone = pn; phoneSrc = 'name'; }
  }

  // ---- 名字：通讯录备注 > 对方昵称 > 会话标题 > 消息自带 pushName ----
  let name = identity.nameFromContact(cObj, phone)
    || identity.nameFromChat(chat, phone)
    || identity.cleanName(raw.pushName, phone);

  const tsSec = Number(raw.ts) > 0 ? Number(raw.ts) : Math.floor(Date.now() / 1000);
  // 🔴 2026-10-20 诊断：媒体被采集到时打一行（老板要「看得见的成败判定」）。
  //   真机发图/视频/语音 → 日志应出现「采集到媒体 type=xxx」；没出现就是探针没认出媒体。
  if (hasAttachment) {
    console.log(`[wa-web-collect] 采集到媒体 type=${type || '?'} fromMe=${raw.fromMe ? 1 : 0} remote=${remote}`);
  }
  return {
    accountId: inst.accId,
    channel: CHANNEL,
    // 客户标识（wa_jid 列）：一眼看出是「内置浏览器 + 哪个会话 + 哪个实例」
    displayJid: `${inst.prefix}:${remote}`,
    // 去重键的一部分 / 日志用
    customerKey: remote,
    // 🔴 实测 Msg.id 没有 _serialized，只能自己拼：fromMe_remote_id
    msgId: `${raw.fromMe ? 1 : 0}_${remote}_${mid}`,
    direction: raw.fromMe ? 'out' : 'in',
    // 🔴 2026-10-20 修复：之前把 mediaType 一律压成 'image'，导致语音(ptt/audio)/视频被当成图片 →
    //    取图模块拿去当图压缩 → 失败 → 永远取不到；界面也误显示“图片占位符”。
    //    现在直接带真类型（WA 给的 raw.type，已 lowercased）：image/sticker/video/audio/ptt/document。
    body: body.trim() ? body : '',
    hasAttachment,
    mediaType: hasAttachment ? type.toLowerCase() : '',
    ts: new Date(tsSec * 1000).toISOString(),
    tsSec,
    name: name || '',
    phone: phone ? phoneFill.toStoredPhone(phone) || phone : '',
    phoneSrc: phone ? phoneSrc : '',
    region: phone ? identity.countryOfPhone(phoneFill.toStoredPhone(phone) || phone) : '',
  };
}

/**
 * 一个会话 → 一张「好友资料卡」（首轮同步用）。
 * 不造消息、不动未读，只把名字/号码/地区带过去建档。
 * @param {object} chat 会话对象
 * @param {object} ctx normalize() 产物
 * @param {object} inst 实例配置 { accId, prefix }
 */
function contactCardFor(chat, ctx, inst) {
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
  // 🔴 2026-10-19 老板：名字/昵称/会话标题本身可能就是电话号码
  if (!phone) {
    const pn = phoneFromName(cObj, chat);
    if (pn) { phone = pn; phoneSrc = 'name'; }
  }
  const name = identity.nameFromContact(cObj, phone)
    || identity.nameFromChat(chat, phone)
    || '';
  return {
    accountId: inst.accId,
    channel: CHANNEL,
    displayJid: `${inst.prefix}:${jid}`,
    customerKey: jid,
    name: name || '',
    phone: phone ? phoneFill.toStoredPhone(phone) || phone : '',
    phoneSrc,
    region: phone ? identity.countryOfPhone(phoneFill.toStoredPhone(phone) || phone) : '',
  };
}

/** 页面原始消息 → 会话内去重键（和 toMessage 的 msgId 保持一致） */
function rawKey(raw) {
  return `${raw && raw.fromMe ? 1 : 0}_${String((raw && raw.remote) || '')}_${String((raw && raw.mid) || '')}`;
}

/* =====================================================================
 * 三、实例工厂（v2.6.1134：WA①~⑤ 共用一套内核，只把参数传进去）
 * ===================================================================== */

/** 实例登记表：prefix → 实例对象（server.js 按 ?key=waN 取用） */
const _instances = {};

/**
 * 造一个采集实例。
 * @param {object} cfg { accId, prefix, partition, label }
 *   - accId     账号号（10~14）
 *   - prefix    显示前缀（wa1~wa5，拼进 displayJid / msgId 去重键）
 *   - partition webview 数据分区（persist:wa6 ~ persist:wa10）
 *   - label     显示名（WA①~WA⑤，状态文案用）
 */
function makeInstance(cfg) {
  const accId = cfg.accId;
  const prefix = cfg.prefix;
  const partition = cfg.partition;
  const label = cfg.label || prefix;
  const inst = { accId, prefix };

  let _timer = null;
  let _opts = null;
  let _stopped = true;
  let _busy = false;
  let _initialized = false;
  let _seen = new Set();
  let _watermark = 0;        // 已读到的最新时间戳（秒）
  let _failCount = 0;
  let _lastMediaCount = -1;
  let _stats = {
    ok: false,
    status: 'idle',
    accountId: accId,
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

  function defaultFindPage() {
    // 🔴 唯一一条「找到内置浏览器页面」的通道，复用 whatsappWebView，**按分区精确定位**。
    const fp = (_opts && typeof _opts.findPage === 'function') ? _opts.findPage : null;
    if (fp) { try { return fp(); } catch (e) { return null; } }
    return whatsappWebView.findGuest(partition);
  }

  /**
   * 在网页里跑一次只读读取脚本。
   * @param {number} [sinceTs] 水位：只要比它新的消息（0 = 全量，排障/首轮用）
   */
  async function readPage(sinceTs) {
    const find = defaultFindPage;
    let page = null;
    try { page = find(); } catch (e) { page = null; }
    if (!page) {
      return {
        ok: false,
        status: 'no-page',
        error: `没找到 ${label} 的内置浏览器页面 —— 先点中栏「${label}」页签把 WhatsApp 网页打开`,
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
      .map((m) => toMessageFor(m, ctx, inst))
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

  /** 跑一轮。可以反复调（测试里直接调它，不挂定时器）。 */
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
        if (changed || _failCount === 3) notifyState();
        return Object.assign({}, _stats);
      }

      _failCount = 0;
      const raw = r.raw;
      const ctx = normalize(raw);

      // 🔴 2026-10-20 诊断：页面里认出几条媒体、以及真实字段快照，
      //    老板在日志里一眼看到「媒体到底有没有被认出来 / 哪个字段有值」。
      //    只在数量变化时打（避免每 3 秒刷屏）。
      if (raw && raw.counts && raw.counts.media && raw.counts.media !== _lastMediaCount) {
        _lastMediaCount = raw.counts.media;
        console.log(`[${label}] 在 WA 网页里认出 ${raw.counts.media} 条媒体消息` +
          (raw.mediaSample ? ` | 快照: ${JSON.stringify(raw.mediaSample)}` : ''));
      }
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
          _watermark = all.length ? (Number(all[all.length - 1].ts) || 0) : Math.floor(Date.now() / 1000);
        }
        items = tail;
        _initialized = true;
        console.log(
          `[${label}] 首轮建立水位：网页内存 ${all.length} 条消息，回灌最新 ${tail.length} 条，` +
          `水位 ts=${_watermark}`
        );

        /* ---- 好友资料：把「有会话的」联系人报上去建档（只做这一轮）---- */
        if (_opts && typeof _opts.onContacts === 'function' && ctx.chats.length) {
          try {
            const cards = ctx.chats.map((c) => contactCardFor(c, ctx, inst)).filter(Boolean);
            if (cards.length) _opts.onContacts(cards);
          } catch (e) {
            console.warn(`[${label}] 好友资料同步失败（不影响采集）：`, (e && e.message) || e);
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

      const mapped = items.map((m) => toMessageFor(m, ctx, inst)).filter(Boolean);
      if (mapped.length && _opts && typeof _opts.onMessages === 'function') {
        try { _opts.onMessages(mapped); } catch (e) {
          console.warn(`[${label}] onMessages 抛错（不影响其余）：`, (e && e.message) || e);
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
        error: raw.visible ? '' : 'WhatsApp 网页在后台（切到「' + label + '」页签它才会刷新）',
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

  /**
   * 起采集。
   *
   * 🔴 v2.6.1135 新增**手动/外部驱动**开关（`{ manual: true }`，等价写法 `{ autoStart: false }`）：
   *    把 hooks 全部装好、状态置位，但**不挂内部 3 秒定时器**，由 src/waChain.js
   *    那条串联调度链来 `await inst.tick()`。
   *    —— 不这样就会「链跑一遍 + 定时器又跑一遍」重复采集。
   *
   *    ⚠️ 这个开关是 **opt-in（默认关闭）**：不传时本函数行为与 v2.6.1134 一字不差，
   *       WA① 默认实例与既有测试（displayJid=wa1:…、ACC_ID=10、startWatching 行为）纹丝不动。
   *
   * @param {object} o onMessages / onContacts / onState / shouldRun / findPage / intervalMs / manual
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
       测试直接调返回的 tick()。
       🔴 v2.6.1135：manual（外部驱动）时同样不挂 —— 节拍交给 src/waChain.js 的串联调度链。 */
    const manual = o.manual === true || o.autoStart === false;
    if (!process.env.BEE_TEST && !manual) {
      schedule(START_DELAY_MS);
    }

    return {
      stop: stopWatching,
      state,
      tick,
      intervalMs: interval,
      /** v2.6.1135：true = 这个实例不起内部定时器，由外部（串联调度链）驱动 */
      manual,
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
   * @returns {{level: 'ok'|'warn'|'error'|'muted', text: string}}
   */
  function describe(st) {
    const s = st || _stats;
    const status = String(s.status || '');
    if (status === 'idle') return { level: 'muted', text: '' };
    if (status === 'starting') return { level: 'muted', text: `${label}：采集启动中…` };
    if (status === 'no-page') {
      return {
        level: 'warn',
        text: `${label}：内置浏览器还没打开 —— 点中栏「${label}」页签把 WhatsApp 网页开起来`,
      };
    }
    if (status === 'unreadable' || status === 'error') {
      return { level: 'error', text: `${label}：读不到（${s.error || '未知原因'}）` };
    }
    if (status === 'paused') {
      return { level: 'muted', text: `${label}：暂停中（让路给进程扫描，下一轮自动接着读）` };
    }
    if (status === 'collecting') {
      const parts = [];
      if (typeof s.chats === 'number') parts.push(`会话 ${s.chats} 项`);
      if (typeof s.contacts === 'number') parts.push(`联系人 ${s.contacts} 个`);
      if (typeof s.unread === 'number') parts.push(`未读 ${s.unread} 个`);
      parts.push(`本轮读到 ${s.read || 0} 条`);
      if (!s.visible) parts.push(`⚠ 网页在后台，切回「${label}」页签才会刷新`);
      return { level: s.visible ? 'ok' : 'warn', text: `${label}：采集中（${parts.join('，')}）` };
    }
    return { level: 'muted', text: `${label}：${status}` };
  }

  const api = {
    accId, prefix, partition, label,
    channel: CHANNEL,
    POLL_MS, FIRST_BATCH, MAX_PER_TICK, JUNK_TYPES,
    isPnJid, normalize, pnJidOf, contactFor, rawKey,
    readPage, probe, tick, startWatching, stopWatching, state, describe,
    toMessage: (raw, ctx) => toMessageFor(raw, ctx, inst),
    contactCard: (chat, ctx) => contactCardFor(chat, ctx, inst),
    pageProbeSource,
    /** 纯函数（单测直接测这些，不用开浏览器） */
    _pure: { toMessage: toMessageFor, contactCard: contactCardFor },
  };
  _instances[prefix] = api;
  return api;
}

/* ---- 模块级 = WA① 实例（accId=10 / wa1 / persist:wa6），既有测试与 server 默认路由都靠它 ---- */
const WA1 = makeInstance({ accId: codes.ACC_WA_EMBEDDED, prefix: 'wa1', partition: 'persist:wa6', label: 'WA①' });

function getInstance(key) {
  return _instances[key];
}

/* =====================================================================
 * 四、对外模块级接口（保持 WA① 形态，向后兼容既有测试 / server 默认路由）
 * ===================================================================== */

module.exports = Object.assign({}, WA1, {
  ACC_ID: codes.ACC_WA_EMBEDDED,
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
  toMessage: (raw, ctx) => toMessageFor(raw, ctx, WA1),
  contactCard: (chat, ctx) => contactCardFor(chat, ctx, WA1),
  rawKey,
  pageProbeSource,
  describe: WA1.describe,
  // 需要浏览器的（默认走 WA① 实例）
  readPage: WA1.readPage,
  probe: WA1.probe,
  tick: WA1.tick,
  startWatching: WA1.startWatching,
  stopWatching: WA1.stopWatching,
  state: WA1.state,
  // v2.6.1134：多实例工厂
  createInstance: makeInstance,
  getInstance,
  WA1,
});
