/*
 * Telegram 网页版消息采集（只读）
 * =====================================================================
 * 🔴 v2.5.1050 修正（根因）：Telegram 实际运行在【关联 WA 号那个浏览器】
 *   （WA-PCnn-CDP）里的 web.telegram.org 标签页（由 session.js 的
 *   restoreOpenTabs 把上次开的标签重新开回 WA 浏览器），并不是独立 Chrome。
 *   所以采集器【优先连上关联 WA 号的浏览器】，在里面找 / 开 Telegram 标签并注入
 *   轮询器；绝不再去拉一个空的「独立 TG 窗口（TG-PCn-CDP）」爬 —— 那里面没有任何
 *   Telegram 登录态，永远读 0 条，正是「WhatsApp 收得到、Telegram 收不到」的病根。
 *
 * 退路：账号没挂 waAccount（老配置）→ 才退回独立 Chrome 窗口；
 *       挂了 waAccount 但 WA 浏览器还没起来 → 这轮先跳过，等下一轮 WA 起来再接。
 *
 * 仿 WA 外跑 Chrome 的思路不变：注入脚本读 web.telegram.org 的 DOM，转成和 WA / Signal
 * 同构的结构后交给 main.js 走完全一样的写库 / 翻译 / 广播链路。
 *
 * 🔴 本模块【只读】Telegram 的一切：不写它的库、不碰它的目录、绝不发消息。
 *    只把内容抄进我们自己的 assistant.db。
 *
 * ---- 为什么这样（不是「读不到」，是「用网页版 DOM 读」）----
 *   用户拍板走「网页版抓取（仿 WA 外跑 Chrome）」：不依赖 Bot API、不需要手机号 / token，
 *   直接用已经登录的 web.telegram.org 会话读消息。代价是：Telegram 网页是 React SPA、
 *   虚拟列表，DOM 选择器会随版本变（web.telegram.org 改版即可能失效）。
 *   所以这里的 DOM 选择器都写了【多个候选 + try/catch 兜底】，读不到就记日志、不崩。
 *   真机登录 web.telegram.org 后，按日志里打印的「命中选择器」确认一下即可；
 *   若某次改版失效，改这里的选择器列表就行，不用动主链路。
 *
 * ---- 抓取范围（v1 取舍，务必知悉）----
 *   只抓「当前在 web.telegram.org 里打开的那个对话」里的消息，并自动轮询侧栏里
 *   标了未读的对话（点开→等渲染→读→再看下一个），把每个未读对话的新消息都捞出来。
 *   已读过的消息 id 会记在内存里去重，重复轮询不会重复入库。
 *   这点和 WA（实时推送）不同：Telegram 网页版没有稳定的实时事件，只能靠轮询 DOM。
 */

const path = require('path');
const fs = require('fs');
const session = require('./session');
/* v2.6.1136：Telegram 专属的「键归一 / 合并 / 时间剥离 / Saved Messages 判定」全在
 * src/telegramMerge.js —— 各归各的文件，绝不抽成公共抓取函数给别的渠道复用。 */
const tgMerge = require('./telegramMerge');

/** 我们自己的 Telegram 账号占用的 account_id（1~5 是五个 WhatsApp，6 是 Signal）。 */
const TELEGRAM_ACCOUNT_IDS = [7, 8, 9];

/** 轮询间隔：2 秒。Telegram 网页版没有实时事件，只能靠轮询 DOM。 */
const POLL_MS = 2000;

/** 每轮最多处理多少条（防止一次刷屏把主线程卡住），超出留到下一轮。 */
const BATCH_PER_TICK = 30;

/** 默认 Telegram 网页地址。 */
const DEFAULT_URL = 'https://web.telegram.org';

/** 各账号正在跑的浏览器实例（id -> {browser, page}）。startWatching / openOrFocus 都会登记，
 *  供 UI「点账号名聚焦窗口」时复用，避免重复拉起第二个 Chrome。 */
const browsers = new Map();

/** startWatching 设进来、openOrFocus/startOne 复用的默认回调。 */
let defaultHooks = { onMessages() {}, onState() {} };

/* =====================================================================
 * 垃圾消息过滤（v2.6.1093 · 老板 10-13 看到真库后要求清掉）
 * ---------------------------------------------------------------------
 * 真实事故（2026-10-12 16:46 一次性抓了4 条，其中 3 条根本不是客户发的）：
 *     tg:777000  → "Login code: ⡍⡫⠰⡏⡱. Do not give this code to anyone..."
 *                  这是 **Telegram 官方服务号**推的登录验证码，被当成客户建了档，
 *                  档案名称就叫「Telegram」。
 *     tg:6041069068 → "last seen yesterday at 23:01"
 *                  这是网页版把「最后上线时间」当成一条消息（状态行，不是对话内容）。
 *     tg:7207229390 → "platinum-vip.miyavip.vip:8001:szezcdsxxz:oqwmwemoeemoyi"
 *                  这是代理/系统通知串，不是人话。
 * 后果：待处理列表永远混垃圾，AI 建议会拿验证码当客户上下文去生成话术。
 *
 * 🔴 判断口径全部是**结构化的**（peerId 精确值 / 固定文案特征），
 *    绝不用「看起来像乱码」这种模糊匹配 —— 真人客户也可能发一串乱码。
 * ===================================================================== */
/** Telegram 官方服务号 peerId（登录验证码、频道推荐等系统推送都来自它） */
const TG_SYSTEM_PEERS = new Set(['777000', '0', '1']);

/**
 * 判定「这条是不是不该入库的系统消息」。
 * @param {string} chatKey   对话键（可能是数字 peerId，也可能退回显示名）
 * @param {string} body      正文
 * @param {string} direction in / out
 * @param {string} [chatName] 对话显示名（v2.6.1136 新增，可选）
 *   为什么加第 4 个参数：Saved Messages 有两种键形态 ——
 *     网页路径拿不到 peerId → 键本身就是 "Saved Messages"；
 *     MTProto 路径键是数字、只有名字才是 "Saved Messages"。
 *   不传这个参数的老调用（test/telegram_webview.test.js 等）行为与之前一字不差。
 */
function isSystemMessage(chatKey, body, direction, chatName) {
  const peer = String(chatKey || '').trim();
  const t = String(body || '').trim();

  // ⓪ v2.6.1136：Saved Messages（收藏夹）= 自己的备忘夹，不是客户
  //    → 不产生新消息提醒、不建档。键 / 名称命中任一即拦（大小写不敏感、trim 后比较）
  if (tgMerge.isSavedMessage(chatKey, chatName)) return true;

  // ① 官方服务号：登录验证码 / 系统推送。只认 in（自己发给它不会有意义）
  if (direction !== 'out' && TG_SYSTEM_PEERS.has(peer)) return true;

  // ② 状态行：网页版把「最后上线 / 在线」渲染成一条消息，那不是客户说的话
  if (/^(last seen|online|offline)\b/i.test(t)) return true;

  // ③ 登录验证码正文（万一 peerId 变了也拦得住）
  if (/^login code\s*[:：]/i.test(t)) return true;
  if (/do not give this code to anyone/i.test(t)) return true;

  // ④ 代理/系统通知串：`host:port:token:token` 四段冒号、无空格 —— 人不会这么发
  if (/^[A-Za-z0-9._-]+:\d{2,5}:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(t)) return true;

  return false;
}

/* =====================================================================
 * 纯函数：把一条原始 DOM 抽取结果，转成和 Signal 同构的统一结构
 * （抽成纯函数，方便单测，不用真开浏览器）
 * ===================================================================== */
function toMessage(raw, accountId) {
  if (!raw) return null;
  const rawName = String(raw.chatName || '').trim();
  const chatKey = String(raw.chatKey || raw.chatName || '').trim();
  const msgId = String(raw.msgId || '').trim();

  /* 🔴 v2.6.1136 问题 3 / 4：正文尾部的时间必须**在采集侧剥掉**。
   * 根因：抓取用 el.textContent 把气泡里的「14:03」一起吞进正文（body = "Hello 14:03"），
   *   于是 ① 界面再渲染一次时间 → 时间出现两次；② 翻译把时间一起翻 → 气泡显示「你好 14:03」。
   * 剥完只剩时间（状态行 / 空气泡）→ 当空消息丢弃，不建档。 */
  const stripped = tgMerge.stripTrailingTime(raw.body);
  const body = stripped.body;
  const msgTime = stripped.msgTime || '';
  if (!body) return null;   // 空消息 / 只剩时间 —— 一律不入库（与 WA / Signal 同铁律）
  if (!chatKey) return null;
  // 系统消息 / 状态行 / 通知串 / Saved Messages 一律不入库（见上方 isSystemMessage 的事故记录）
  if (isSystemMessage(chatKey, body, raw.direction, rawName)) return null;

  return {
    key: chatKey,
    // 去重键：chatKey + msgId；msgId 为空时退回 正文哈希，至少避免同一条无限重复
    msgId: msgId || `${chatKey}:${body.slice(0, 40)}`,
    direction: raw.direction === 'out' ? 'out' : 'in',
    body,
    // 剥出来的显示时间（14:03 / 下午 2:03）—— 单独一个字段，绝不留在 body 里
    msgTime,
    hasAttachment: !!raw.hasAttachment,
    // Telegram 网页不给可靠的服务端时间戳（DOM 只有「今天 14:03」这种相对时间），
    // 用抓取时刻的本地时间即可（排序用，够用）
    ts: raw.ts || new Date().toISOString(),
    customerKey: chatKey,
    name: String(raw.chatName || '').trim() || null,
    // v2.5.1032：Telegram @username（从 location.hash 读的），跳转时用它走官方深链最精准。
    // 对方没设用户名时为空，跳转退回搜索框兜底。
    username: String(raw.username || '').trim() || null,
    phone: '',
    phoneState: 'pending',
    // wa_jid 这一列在 Telegram 没有 JID 概念，但 NOT NULL 且被 UNIQUE 用着，
    // 用 `tg:` 前缀值，一眼能看出是 Telegram 渠道来的，排查不跟 WA 混淆。
    displayJid: `tg:${chatKey}`,
    mediaType: body ? '' : 'image',
    isGroup: !!raw.isGroup,
  };
}

/* =====================================================================
 * 注入页面的轮询脚本（字符串，page.evaluate 里执行）
 *
 * 职责：每 POLL_MS 读一次当前打开的对话 + 侧栏未读对话，把「新的」消息通过
 *   window.__tgReport(...) 上报。去重交给 Node 侧（window.__seen 只作页面内快筛）。
 *
 * 🔴 选择器全部写成「候选数组」，取第一个能返回元素的选择器，任何一个失效都不会崩。
 * ===================================================================== */
function pagePollerSource() {
  const SEL = {
    chatTitle: [
      '.chat .chat-header .user-title', '.panel-header .peer-title', '.topbar .peer-title',
      '.chat-header .title', '.chat-header .chat-title .peer-title', '.peer-title',
      '.chat-title', '[data-peer-title]', '.sidebar .selected .title',
    ],
    // 🔴 优先用 [data-mid]：Telegram 各版本消息元素都带这个属性，比 class 名稳得多
    bubbles: [
      '[data-mid]', '.bubbles .bubble', '.bubble', '.messages .bubble',
      '.bubbles-group .bubble', '.messages-container .message', '.Message', '.message',
    ],
    bubbleText: [
      '.text', '.bubble .text-content', '.message .text',
      '.translatable-message .text-content', '.message-content .text',
      '.text-content', '[data-text]', '.bubble__text',
    ],
    unreadChats: [
      // 🔴 留作极老版本兜底：Telegram K 版【不会】给未读对话加 .unread class，
      //    真正可靠的是下面 chatBadge（数字徽标）。别再指望这几条能命中。
      '.chat-list .chat.unread', '.dialogs .dialog.unread', '.sidebar .ListItem.unread',
      '.chatlist-list .chat.unread', '.chatlist .Chat.unread', '.sidebar .row.unread',
      '.chatlist .chat.unread', '.chat.unread', '.ListItem.unread',
      '[aria-label*="unread" i]',
    ],
    // 🔴 v2.5.1052（真根因）：Telegram K 的聊天列表条目。href="#<peerId>" 是稳定对话 ID。
    chatItem: [
      '#LeftColumn a.ListItem-button[href^="#"]',
      '.chat-list a.ListItem-button[href^="#"]',
      '.chat-list .ListItem.Chat',
      '#LeftColumn .ListItem.Chat',
      '.ListItem.Chat',
    ],
    // 未读数字徽标：截图实测 class="shown open UCRlRpZc chat-badge-transition"，里面
    // 一个 <span> 就是未读条数（1 显示 1、2 显示 2）。chat-badge-transition 不是哈希名。
    chatBadge: ['.chat-badge-transition', '[class*="chat-badge"]', '[class*="badge"]'],
    // 对话名：必须限制在 .info 里，否则会误抓到「最后一条消息」里的发送者前缀
    chatPeerTitle: ['.info-row .peer-title', '.info .peer-title', '.info .title', '.peer-title', '.user-title', '.title'],
    // 最后一条消息的预览文字（不打括号、不点开也能拿到大概内容）
    chatPreview: ['.last-message', '.subtitle p'],
    chatList: [
      '.chat-list', '.sidebar .chatlist', '.dialogs', '.sidebar', '.left-sidebar',
      '[data-chatlist]', '#column-center', '.chatlist',
    ],
    loginMarker: [
      '.login-form', '#sign-in-pages', '.auth-form', '.auth-pages', '#auth-login',
      '.login-wrapper', '.tg-login',
    ],
  };

  function first(selectors) {
    for (const s of selectors) {
      try { const el = document.querySelector(s); if (el) return el; } catch (e) {}
    }
    return null;
  }
  function all(selectors) {
    for (const s of selectors) {
      try { const els = Array.from(document.querySelectorAll(s)); if (els.length) return els; } catch (e) {}
    }
    return [];
  }
  function textOf(el, selectors) {
    if (!el) return '';
    for (const s of selectors) {
      try { const sub = el.querySelector(s); if (sub && sub.textContent) return sub.textContent.trim(); } catch (e) {}
    }
    return (el.textContent || '').trim();
  }
  function isLoginPage() {
    return SEL.loginMarker.some((s) => { try { return !!document.querySelector(s); } catch (e) { return false; } });
  }
  function currentUsername() {
    try { const m = String(location.hash || '').match(/^#@([A-Za-z0-9_]{3,32})$/); return m ? m[1] : ''; } catch (e) { return ''; }
  }
  /* 🔴 v2.6.1136 问题 2（键归一）：地址栏 #peerId 是**数字对话号**，比显示名稳得多
   *   —— 用户改备注名、同名联系人都不会串。有数字就优先用数字当 chatKey，
   *   显示名仍然一起上报（建档案的姓名靠它）。拿不到（#@username 形态）才退回名字。 */
  function currentPeerId() {
    try { const m = String(location.hash || '').match(/^#(-?\d{3,})$/); return m ? m[1] : ''; } catch (e) { return ''; }
  }
  if (!window.__seen) window.__seen = {};

  // ===== 方案③：拦截系统通知（与页面结构无关，右下角弹窗就是它）=====
  try {
    if (!window.__tgNotePatched && typeof window.Notification === 'function') {
      const NativeNotification = window.Notification;
      function PatchedNotification(title, opts) {
        try {
          const o = opts || {};
          const body = typeof o.body === 'string' ? o.body
            : (o.data && typeof o.data.body === 'string') ? o.data.body : '';
          if (body && typeof window.__tgReport === 'function') {
            window.__tgReport({
              chatKey: String(title || ''), chatName: String(title || ''),
              username: '', msgId: 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
              direction: 'in', body: String(body), ts: new Date().toISOString(),
              isGroup: /group|群|\(/.test(String(title || '')), via: 'notification',
            });
          }
        } catch (e) {}
        try { return new NativeNotification(title, opts); } catch (e) {}
      }
      PatchedNotification.prototype = NativeNotification.prototype;
      try { Object.setPrototypeOf(PatchedNotification, NativeNotification); } catch (e) {}
      window.Notification = PatchedNotification;
      window.__tgNotePatched = true;
      if (typeof window.__tgDiag === 'function') window.__tgDiag('notification hook installed');
    }
  } catch (e) {
    if (typeof window.__tgError === 'function') window.__tgError('note hook: ' + (e && e.message));
  }

  // ===== 方案②：MutationObserver 实时捕获新渲染的消息气泡 =====
  function reportBubble(el) {
    try {
      const mid = (el.getAttribute && el.getAttribute('data-mid')) || '';
      const dir = (el.classList && (el.classList.contains('is-out') || el.classList.contains('out'))) ? 'out' : 'in';
      let body = '';
      for (const s of SEL.bubbleText) {
        const sub = el.querySelector && el.querySelector(s);
        if (sub && sub.textContent) { body = sub.textContent.trim(); break; }
      }
      if (!body) body = (el.textContent || '').trim();
      if (!body) return;
      let chatName = '';
      const t = first(SEL.chatTitle);
      if (t) chatName = t.textContent.trim();
      if (!chatName) {
        const dt = (document.title || '').replace(/\((\d+)\)\s*$/, '').trim();
        if (dt && !/telegram/i.test(dt)) chatName = dt;
      }
      if (!chatName) chatName = 'Telegram';
      const uid = chatName + '|' + (mid || body.slice(0, 40));
      if (window.__seen[uid]) return;
      window.__seen[uid] = 1;
      if (typeof window.__tgReport === 'function') {
        window.__tgReport({
          chatKey: currentPeerId() || chatName, chatName, username: currentUsername(),
          msgId: mid, direction: dir, body, ts: new Date().toISOString(),
          isGroup: /群|group/i.test(chatName), via: 'observer',
        });
      }
    } catch (e) {}
  }
  function attachObserver() {
    if (window.__tgObs) return;
    try {
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (!m.addedNodes || !m.addedNodes.length) continue;
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            let el = null;
            try {
              if (node.matches && (node.matches('[data-mid]') || node.matches('.bubble, .message, .Message'))) el = node;
              else if (node.querySelector) el = node.querySelector('[data-mid], .bubble, .message, .Message');
            } catch (e) {}
            if (el) reportBubble(el);
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      window.__tgObs = obs;
      if (typeof window.__tgDiag === 'function') window.__tgDiag('mutation observer installed');
    } catch (e) {
      if (typeof window.__tgError === 'function') window.__tgError('observer: ' + (e && e.message));
    }
  }

  async function readOpenChat() {
    let titleEl = first(SEL.chatTitle);
    let chatName = titleEl ? titleEl.textContent.trim() : '';
    if (!chatName) {
      const t = (document.title || '').replace(/\((\d+)\)\s*$/, '').trim();
      if (t && !/telegram/i.test(t)) chatName = t;
    }
    if (!chatName) return 0;
    const bubbles = all(SEL.bubbles);
    let n = 0;
    for (const b of bubbles) {
      const mid = (b.getAttribute && b.getAttribute('data-mid')) || '';
      const dir = (b.classList && (b.classList.contains('is-out') || b.classList.contains('out'))) ? 'out' : 'in';
      const body = textOf(b, SEL.bubbleText);
      if (!body) continue;
      const uid = chatName + '|' + (mid || body.slice(0, 40));
      if (window.__seen[uid]) continue;
      window.__seen[uid] = 1;
      n += 1;
      if (typeof window.__tgReport === 'function') {
        try {
          await window.__tgReport({
            chatKey: currentPeerId() || chatName, chatName, username: currentUsername(),
            msgId: mid, direction: dir, body,
            ts: new Date().toISOString(), isGroup: /群|group/i.test(chatName),
          });
        } catch (e) {}
      }
    }
    return n;
  }

  // ===== 方案④（v2.5.1052）：读「聊天列表里的未读数字徽标」=====
  //   Telegram K 版不给未读对话加 .unread class，而是在条目里渲染一个数字徽标：
  //     <div class="ListItem Chat ..."><a class="ListItem-button" href="#8937920881">
  //        <div class="info"><div class="subtitle">
  //          <p class="last-message">…</p>
  //          <div class="shown open chat-badge-transition"><span>1</span></div>
  //  旧代码找 .unread 永远匹配不到 —— 这才是「TG 明明在弹新消息、软件却收不到」的真根因。
  //   这里【只读列表】:对话ID(href="#peerId") + 对话名 + 最后一条预览 + 未读数，
  //   【不点开】—— 点开会把未读清零，还会改动用户在 Telegram 里的已读状态。
  function scanChatList() {
    const out = [];
    let items = [];
    for (const s of SEL.chatItem) {
      try {
        const els = Array.from(document.querySelectorAll(s));
        if (els.length) { items = els; break; }
      } catch (e) {}
    }
    for (const el of items) {
      try {
        const anchor = el.tagName === 'A' ? el : (el.querySelector('a.ListItem-button') || el.closest('a'));
        const href = (anchor && anchor.getAttribute && anchor.getAttribute('href')) || '';
        const peerId = (String(href).match(/(\d{3,})/) || [])[1] || '';
        let title = '';
        for (const s of SEL.chatPeerTitle) {
          const t = el.querySelector(s);
          // 排除「最后一条消息里的发送者前缀」，只要真正的对话名
          if (t && t.textContent && !(t.closest && t.closest('.last-message'))) {
            title = t.textContent.trim();
            if (title) break;
          }
        }
        if (!title) {
          // 兜底：整行 info 的第一段文字（避免退化成「只显示一串数字 peerId」）
          const row = el.querySelector('.info-row');
          if (row && row.textContent) title = row.textContent.trim().split('\n')[0].slice(0, 60);
        }
        let preview = '';
        for (const s of SEL.chatPreview) {
          const p = el.querySelector(s);
          if (!p) continue;
          try {
            const clone = p.cloneNode(true);
            const who = clone.querySelector && clone.querySelector('.peer-title, .sender-title');
            if (who) who.remove();
            preview = (clone.textContent || '').trim();
          } catch (e) {
            preview = (p.textContent || '').trim();
          }
          if (preview) break;
        }
        let count = 0;
        for (const s of SEL.chatBadge) {
          const b = el.querySelector(s);
          if (!b) continue;
          let visible = true;
          try { const r = b.getBoundingClientRect(); visible = r.width > 0 && r.height > 0; } catch (e) {}
          if (!visible) continue; // .shown/.hidden 切换时旧节点还在，用尺寸判可见
          const txt = (b.textContent || '').trim();
          const m = txt.match(/\d+/);
          count = m ? parseInt(m[0], 10) : 1; // 免打扰小圆点没数字，按 1 条算
          if (count > 0) break;
        }
        if (!peerId && !title) continue;
        out.push({ peerId, title, preview, count });
      } catch (e) {}
    }
    return out;
  }

  /** 扫一遍列表，把「未读变多 / 预览文字变了」的对话上报。返回本轮统计。 */
  async function readUnreadFromList() {
    if (!window.__tgUnread) window.__tgUnread = {};
    if (!window.__tgLastBody) window.__tgLastBody = {};
    let list = [];
    try { list = scanChatList(); } catch (e) {}
    let unread = 0;
    let n = 0;
    for (const it of list) {
      const peer = it.peerId || it.title;
      if (!peer) continue;
      const prev = window.__tgUnread[peer];
      window.__tgUnread[peer] = it.count;
      if (!it.count) continue; // 已读清零 → 记 0，下次再来 1 才会重新报（不漏）
      unread += 1;
      const body = it.preview || '[新消息]';
      const grew = prev == null || it.count > prev;
      const bodyChanged = window.__tgLastBody[peer] != null && window.__tgLastBody[peer] !== body;
      if (!grew && !bodyChanged) continue;
      window.__tgLastBody[peer] = body;
      const uid = peer + '|' + it.count + '|' + body.slice(0, 40);
      if (window.__seen[uid]) continue;
      window.__seen[uid] = 1;
      n += 1;
      if (typeof window.__tgReport === 'function') {
        try {
          await window.__tgReport({
            // chatKey 用 href 里的 peerId：比对话名稳（用户改备注名也不会变成新客户）
            chatKey: peer, chatName: it.title || peer, username: '',
            msgId: 'list-' + it.count + '-' + body.slice(0, 32),
            direction: 'in', body, ts: new Date().toISOString(),
            isGroup: /group|群/i.test(it.title || ''), via: 'chatlist',
          });
        } catch (e) {}
      }
    }
    return { n, total: list.length, unread };
  }

  async function tick() {
    if (typeof window.__tgActive !== 'number') window.__tgActive = 1;
    if (window.__tgPaused) return;
    attachObserver(); // 页面可能刚 ready
    if (isLoginPage()) {
      if (typeof window.__tgLogin === 'function') { try { await window.__tgLogin(); } catch (e) {} }
      if (typeof window.__tgState === 'function') { try { await window.__tgState({ status: 'login_required', title: document.title }); } catch (e) {} }
      return;
    }
    const loadedChat = SEL.chatList.some((s) => { try { return !!document.querySelector(s); } catch (e) { return false; } });
    try {
      let n = await readOpenChat();
      // 🔴 v2.5.1052：改读「聊天列表未读徽标」。旧代码在这里点开 .unread 对话 ——
      //   K 版根本没有 .unread，循环体一次都没执行过；而且点开会清掉未读、
      //   还会改动用户在 TG 里的已读状态，所以彻底去掉「点开」这套。
      const st4 = await readUnreadFromList();
      n += st4.n;
      if (typeof window.__tgDiag === 'function' && !window.__tgListDiag && st4.total > 0) {
        window.__tgListDiag = 1;
        try { await window.__tgDiag(`chatlist ok: ${st4.total} items, ${st4.unread} unread, ${n} read`); } catch (e) {}
      }
      if (typeof window.__tgState === 'function') {
        try {
          await window.__tgState({
            status: loadedChat ? 'collecting' : 'selector_issue',
            read: n, chats: st4.total, unread: st4.unread, title: document.title,
          });
        } catch (e) {}
      }
      if (!loadedChat && n === 0 && typeof window.__tgDiag === 'function') {
        try {
          const probe = Array.from(document.querySelectorAll('body *'))
            .map((el) => (el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : ''))
            .filter(Boolean).slice(0, 50).join(' ');
          await window.__tgDiag(`title=${JSON.stringify(document.title)} classes=${probe.slice(0, 300)}`);
        } catch (e) {}
      }
    } catch (e) {
      if (typeof window.__tgError === 'function') { try { await window.__tgError(String(e && e.message || e)); } catch (x) {} }
    }
  }

  attachObserver();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachObserver);
  }
  if (!window.__tgTimer) {
    window.__tgTimer = setInterval(tick, 2000);
    setTimeout(tick, 1500);
  }
  return true;
}

/* =====================================================================
 * 复用「关联 WhatsApp 浏览器」的助手
 * ===================================================================== */

/** 在给定浏览器里找已开的 web.telegram.org 标签；没有就新开一个并加载。返回 { page } */
async function getOrOpenTgPage(browser, cfg) {
  const url = (cfg.telegram && cfg.telegram.url) || DEFAULT_URL;
  let tgPage = null;
  try {
    const pages = await browser.pages();
    tgPage = pages.find((p) => (p.url() || '').includes('web.telegram.org'));
  } catch (e) { /* 取不到就新开 */ }
  if (tgPage) return { page: tgPage };
  const page = await browser.newPage();
  try {
    await page.goto(`${url.replace(/\/$/, '')}/k/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) { /* 旧版 K 地址打不开就跳过，下面裸地址兜底 */ }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) { /* 加载失败也无所谓，轮询器每 2 秒会再试 */ }
  return { page };
}

/** 把轮询器 + 上报函数挂到某个 TG 页面上（watchAccount / openOrFocus 共用） */
async function attachPoller(page, acc, hooks, seen) {
  await page.exposeFunction('__tgReport', async (raw) => {
    const m = toMessage(raw, acc.id);
    if (!m) return;
    m.accountId = acc.id;
    const uid = m.customerKey + ' ' + m.msgId;
    if (seen.has(uid)) return;
    seen.add(uid);
    try {
      hooks.onMessages && hooks.onMessages([m]);
    } catch (e) {
      console.warn(`[telegram ${acc.id}] 单条处理失败：`, e && e.message);
    }
  });
  await page.exposeFunction('__tgLogin', async () => {
    hooks.onState && hooks.onState({ id: acc.id, status: 'login_required' });
  });
  await page.exposeFunction('__tgError', async (msg) => {
    console.warn(`[telegram ${acc.id}] 页面轮询报错：${msg}`);
  });
  await page.exposeFunction('__tgState', async (st) => {
    hooks.onState && hooks.onState(Object.assign({ id: acc.id }, st));
  });
  await page.exposeFunction('__tgDiag', async (msg) => {
    console.warn(`[telegram ${acc.id}] 页面探测：${msg}`);
  });
  await page.evaluate(pagePollerSource).catch((e) => {
    console.warn(`[telegram ${acc.id}] 注入轮询脚本失败：`, e && e.message);
  });
  // Telegram 偶尔整体刷新 / 切 tab 会清空页面上下文，注入了会丢 → 跳转后自动补注
  try {
    if (!page.__tgNavHook) {
      page.__tgNavHook = true;
      page.on('framenavigated', (frame) => {
        try {
          if (frame === page.mainFrame()) page.evaluate(pagePollerSource).catch(() => {});
        } catch (e) {}
      });
    }
  } catch (e) {}
  // 健康检查：每 30s 确认注入还在（定时器/观察者/通知钩子），丢了就补
  try {
    if (!page.__tgHealth) {
      page.__tgHealth = setInterval(() => {
        page.evaluate(() => !!(window.__tgTimer && window.__tgObs && window.__tgNotePatched))
          .then((ok) => { if (!ok) page.evaluate(pagePollerSource).catch(() => {}); })
          .catch(() => {});
      }, 30000);
    }
  } catch (e) {}
}

/* =====================================================================
 * 单账号：连上关联 WA 浏览器 → 里面找/开 Telegram 标签 → 装轮询器
 *   waBrowser = 关联 WA 号已起来的浏览器（由 main.js 从 runningSessions 取来传入）
 * ===================================================================== */
/**
 * 单账号：拉【自己的】独立外部 Chrome（独立 user-data-dir + CDP 端口），开 web.telegram.org。
 * v2.6.1111（指令③ Option 1）：不再共用关联 WA 号的浏览器——
 *   每个 TG 账号独立进程，登录态物理隔离，T①/T② 互不干扰、互不踢。
 *   session.launchBrowser 已按 acc.cdpProfile(TG-PCn-CDP) / acc.cdpPort(9244+n) 生成独立目录与端口。
 */
/* =====================================================================
 * 🔴 v2.6.1113单例锁（老板 2026-10-14 17:31 实机报BUG：「T①/T② 自动打开浏览器，
 *    而且是重复多打开一次」）
 *
 * 根因：改「每账号独立 Chrome」之后，有**三条路径**都会调 session.launchBrowser：
 *   ① 点顶栏一号/二号/三号 → openLinkedTelegram → openOrFocus
 *   ② 启动即拉起 → startTelegramWatching → watchAccount
 *   ③ 每 3 秒循环 → loops.js ensureTelegram → ensureWatching → watchAccount
 * 而 session.launchBrowser **每调一次就真起一个 Chrome 进程**，文件里没有任何
 * 「这个号已经开过了就别再开」的检查；再叠加 config.yaml 里T① 的 waAccount 挂在
 * 一号/二号/三号上 —— 点任意一个 WA 号都会顺手开一个 T 浏览器，越点越多。
 *
 * 正解 = 复用 browsers 这个 Map 当单例锁（它本来就是所有 T 路径的汇聚点，
 * 一处加锁三条路径通吃），并且**并发也要挡住**：三个调用可能同时进来，
 *光「查了没有就返回」会漏（都查到空→ 都去起）。所以用 launching 这个
 * Promise Map做互斥：同一个号正在起，第二个调用 await 第一个的结果，不重复起。
 * ===================================================================== */
const launching = new Map();   // accId -> Promise<{browser,page}>

/** 这个号是不是已经有活着的浏览器（进程还连着）。 */
function liveOf(id) {
  const h = browsers.get(id);
  if (!h || !h.browser || !h.page) return null;
  const b = h.browser;
  // puppeteer 的 Browser 有 isConnected()；判不出来就当作活着（宁可复用也别重复开）
  const alive = typeof b.isConnected === 'function' ? b.isConnected() : true;
  if (!alive) { browsers.delete(id); return null; }
  return h;
}

/**
 * 🔴 唯一允许起 Telegram 浏览器的入口。三条路径（点 WA 号 / 启动 / 3 秒循环）
 * 全部改走这里，保证「一个号最多一个 Chrome」。
 * @param acc   TG 账号配置（要带 id / cdpProfile / cdpPort）
 * @param cfg   主配置
 * @param opts  { hooks, onState, needPage:false } needPage=false 只保证浏览器在，不开新 page
 */
async function acquireBrowser(acc, cfg, opts) {
  const o = opts || {};
  const id = acc.id;

  // ① 已经活着 → 直接复用（顺带把窗口拉到前台）
  const live = liveOf(id);
  if (live) {
    try { if (live.page && typeof live.page.bringToFront === 'function') await live.page.bringToFront(); } catch (e) {}
    return live;
  }

  // ② 正在起 → await 那个 Promise，绝不重复起
  if (launching.has(id)) {
    try { return await launching.get(id); } catch (e) { /* 下面自己再起一次 */ }
  }

  // ③ 真起一个，并用 Promise 互斥（后面的同号调用都进① ②分支）
  const job = (async () => {
    const tgCfg = { browser: Object.assign({}, cfg.browser, { windowPosition: '60,60', headless: false }) };
    const browser = await session.launchBrowser(acc, tgCfg);
    let page = null;
    if (o.needPage !== false) {
      page = await browser.newPage();
      const url = (cfg.telegram && cfg.telegram.url) || DEFAULT_URL;
      try { await page.goto(`${url.replace(/\/$/, '')}/k/`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
    }
    // 🔴 v2.6.1117：关掉 Chrome 启动自带的空白新标签页（老板实机截图里红框那张 New Tab）。
    //    必须在 newPage + goto 之后做，且把自己的 page 传进去保住 —— 否则会连 Telegram 页一起关掉。
    try { await session.closeStrayPages(browser, page); } catch (e) {}
    const h = { browser, page, shared: false };
    browsers.set(id, h);
    return h;
  })();

  launching.set(id, job);
  try {
    return await job;
  } finally {
    launching.delete(id);
  }
}

async function watchAccount(account, cfg, hooks) {
  const acc = Object.assign({}, account);
  const seen = new Set();
  hooks.onState && hooks.onState({ id: acc.id, status: 'starting' });

  let h;
  try {
    h = await acquireBrowser(acc, cfg, { needPage: true });
  } catch (e) {
    hooks.onState && hooks.onState({ id: acc.id, status: 'offline', error: 'Chrome 启动失败：' + ((e && e.message) || e) });
    return null;
  }
  // 🔴 关键：拿到的可能是**别人已经起好的**浏览器（复用，不是新建）。
  //   只有真正新建的那次才挂轮询 + 记 seen，否则会重复注册定时器、重复收消息。
  //   这里用「browsers 里这台的 page 是否已经有 poller」做判据。
  const already = !!h.__poller;
  if (!already) {
    await attachPoller(h.page, acc, hooks, seen);
    h.__poller = true;
    h.seen = seen;
    h.hooks = hooks;
  }
  /* 🔴 v2.6.1113 修「一条启动打两条日志」：原来 watchAccount 开头（starting）
     和末尾（又starting）各广播一次，老板图里看到两条一模一样的
     「T① 采集器启动中…」。开头那次就够了，末尾改成 online。 */
  hooks.onState && hooks.onState({ id: acc.id, status: 'online' });
  return { browser: h.browser, page: h.page, seen: h.seen || seen, shared: false, reused: already };
}

/* =====================================================================
 * 启动整体轮询
 * @param {object} o
 * @param {Array} o.accounts  Telegram 账号配置数组（来自 config.telegram.accounts）
 * @param {object} o.cfg      全局配置（browser / telegram.url）
 * @param {(batch:object[])=>void} o.onMessages  拿到新消息时回调
 * @param {(st:object)=>void} [o.onState]        状态变化回调（starting/online/login_required）
 * @returns {{stop:Function, state:Function}}
 */
function startWatching({ accounts, cfg, onMessages, onState, pollMs = POLL_MS, autostart = false }) {
  const list = (accounts || []).filter((a) => a && a.enabled);
  const handles = new Map(); // id -> {browser, page, seen}
  let stopped = false;

  const hooks = { onMessages, onState };
  defaultHooks = hooks; // 供 openOrFocus / startOne 复用同一套回调

  /* 🔴 v2.6.1113 老板 18:27 实机反馈「登录账号后怎么还是自动开启浏览器」。
   * 根因：startWatching 一进来就for 循环 watchAccount → 每号 launchBrowser 拉一个 Chrome。
   * 老板要的是**自己点顶栏 T①/T② 按钮才开**（登录也该手动，不要软件替他弹窗）。
   * 所以 autostart 默认 false：只把状态置成「未启动」，**不碰浏览器**。
   * 老板点按钮 → openTelegramAccount() → openOrFocus() → acquireBrowser() 才真开。
   * autostart:true 保留给「确实要开机自启」的场景（设置里将来可接）。 */
  if (!autostart) {
    for (const acc of list) {
      onState && onState({ id: acc.id, status: 'idle', message: '未启动 · 点顶栏 T 按钮打开' });
    }
    console.log('[telegram] 外部 Chrome 采集**未自动启动**（老板 18:27 要求：点顶栏 T①/T② 按钮才开）');
  }

  (async () => {
    if (!autostart) return;   // 没开autostart 就到此为止，绝不碰浏览器
    for (const acc of list) {
      if (stopped) break;
      try {
        const h = await watchAccount(acc, cfg, hooks);
        handles.set(acc.id, h);
      } catch (e) {
        console.warn(`[telegram] 账号 ${acc.id} 启动失败：`, e && e.message);
        onState && onState({ id: acc.id, status: 'offline', error: e && e.message });
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      for (const [, h] of handles) {
        try {
          if (h.shared && h.page) {
            // 共用 WA 浏览器：只关 Telegram 标签，绝不关整个浏览器（会连 WhatsApp 一起杀）
            h.page.close().catch(() => {});
          } else if (h.browser && h.browser.isConnected && h.browser.isConnected()) {
            h.browser.disconnect();
          }
        } catch (e) {}
      }
      handles.clear();
    },
    state() {
      return { accounts: list.length, running: handles.size, stopped };
    },
  };
}

/**
 * 「Telegram 开 Chrome 预热」的保活版（v2.5.1039 · 老板图里的循环1 / 循环2）。
 *
 * 图上循环1 是「Telegram 开 Chrome 最先预热 + 开前等静默窗口」每 3 秒循环一轮，
 * 循环2 里也带着这一项 —— 所以它必须能【反复调】：
 *   · 已经在跑（CDP 还连着）→ 什么都不做（纯内存判断，几乎零成本）；
 *   · 掉了 / 还没开 → 拉起来一个（开前先等 ③ 扫描的静默窗口，这一步由调用方负责）。
 *
 * 🔴 幂等：绝不重复拉起第二个 Chrome（靠 browsers 表判断），也不会把已经
 *    开着的窗口抢到前台（那是 UI 点账号名的活儿，见 openOrFocus）。
 *
 * @param {object} o
 * @param {Array}  o.accounts  账号配置数组（只处理 enabled 的）
 * @param {object} o.cfg       全局配置
 * @param {object} [o.hooks]   { onMessages, onState }，会登记成默认回调供 openOrFocus 复用
 * @returns {Promise<number[]>} 这一轮真正拉起来的账号 id（都活着就是空数组）
 */
async function ensureWatching({ accounts, cfg, hooks = {}, waBrowserFor } = {}) {
  if (hooks.onMessages || hooks.onState) {
    defaultHooks = {
      onMessages: hooks.onMessages || defaultHooks.onMessages,
      onState: hooks.onState || defaultHooks.onState,
    };
  }
  const opened = [];
  for (const acc of (accounts || []).filter((a) => a && a.enabled !== false)) {
    if (isRunning(acc.id)) continue;
    /* 🔴 v2.6.1113 老板 18:27：「登录账号后怎么还是自动开启浏览器」。
     * ensureWatching 原来在这里「没跑就拉一个」→ 3 秒循环一跑就弹浏览器。
     * 现在改成：**没跑就跳过，绝不自动开**。
     * 只有老板点顶栏 T①/T② 按钮（走 openOrFocus → acquireBrowser）才真开。
     * 这里只负责「已经开着的那几个，别让它们掉线」——
     * 所以下面只在 isRunning 时补挂轮询，不再新建浏览器。 */
    continue;
  }
  return opened;
}

/**
 * 给 UI「点账号名打开」用：拉起或聚焦这个 Tele 账号的浏览器。
 * - 已开着（browsers 里有）→ 直接聚焦它的窗口（focusBrowser）。
 * - 没开着 → 单独拉起一个 Chrome 开 web.telegram.org，并登记进 browsers，复用默认采集回调。
 */
/**
 * 给 UI「点账号名打开」用：拉起或聚焦这个 Tele 账号自己的外部 Chrome（独立目录）。
 * v2.6.1111：始终拉自己的 Chrome（与 watchAccount 同路），不再依赖 WA 浏览器先起。
 */
async function openOrFocus(account, cfg) {
  const acc = Object.assign({}, account);
  /* 🔴 v2.6.1113：改走 acquireBrowser 单例锁 —— 原来这里每次都 launchBrowser，
     点 WA 号 / 启动 / 3 秒循环三条路都会新开一个 Chrome（老板报的重复多开就是它）。 */
  const h = await acquireBrowser(acc, cfg, { needPage: true });
  try { if (h.page && typeof h.page.bringToFront === 'function') await h.page.bringToFront(); } catch (e) {}
  if (!h.__poller) {
    const seen = new Set();
    await attachPoller(h.page, acc, defaultHooks, seen);
    h.__poller = true; h.seen = seen; h.hooks = defaultHooks;
  }
  return { browser: h.browser, page: h.page, focused: true };
}

/**
 * 把某个已开着的 Tele 账号窗口拉到前台（激活它的 tab）。
 * 用 puppeteer 的 page.bringToFront()（CDP Target.activateTarget）—— 窗口本身在屏幕 60,60，
 * 只是把对应 tab 激活到最前。返回是否成功。
 */
async function focusBrowser(id) {
  const h = browsers.get(id);
  if (!h || !h.browser || !h.browser.isConnected || !h.browser.isConnected()) return false;
  try {
    if (h.page && typeof h.page.bringToFront === 'function') await h.page.bringToFront();
    return true;
  } catch (e) {
    return false;
  }
}

/** 供 main.js 查询：这个 Tele 账号的浏览器现在在不在跑。 */
function isRunning(id) {
  const h = browsers.get(id);
  return !!(h && h.browser && h.browser.isConnected());
}

module.exports = {
  TELEGRAM_ACCOUNT_IDS,
  POLL_MS,
  toMessage,
  startWatching,
  /** v2.5.1039：循环1/循环2 用的「Telegram 预热保活」（幂等，掉了才补） */
  ensureWatching,
  openOrFocus,
  focusBrowser,
  isRunning,
  pagePollerSource,
  /**
   * v2.6.1093：导出「这条是不是系统消息/状态行/通知串」的判定。
   * 供 main.js 的autoFetchTelegramPhone 复用 —— 自动取号前先判一次，
   * 不然会给登录验证码号、代理通知串这些垃圾档案建出带手机的假客户。
   * （原来只在 toMessage 内部用，没导出，导致外部复用会静默失效。）
   */
  isSystemMessage,
};
