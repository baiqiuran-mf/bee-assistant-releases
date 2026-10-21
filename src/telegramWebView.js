/**
 * v2.5.1056：从「内置浏览器」读 Telegram（兜底方案，不依赖 api_id / api_hash）
 *
 * 背景：
 *   · 1050~1052 用 puppeteer 外挂 Chrome 爬 web.telegram.org 的 DOM，K 版结构一直在变，读不到。
 *   · 1053/1054 改走 MTProto（teleproto），但要 my.telegram.org 申请的 api_id / api_hash，老板手上没有。
 *   · 1055 老板拍板：做成**内置浏览器**（中栏 Tele① 页签里的 <webview>），在里面登录。
 *   → 于是有了这一层：**直接读软件自己肚子里那个 webview**，不用任何凭证、不用外挂浏览器。
 *
 * 为什么走「主进程 executeJavaScript 拉数据」而不是往页面里塞脚本（preload）：
 *   ① 零前端改动、不用新增 preload 文件（也就不用操心 asar 打包路径）；
 *   ② executeJavaScript **不受页面 CSP 限制**；
 *   ③ 同步返回 JSON，比「页面回调 → ipc」那条链路好排查（一屏就能看到扫到了什么）。
 *   代价是轮询式（5 秒一趟），不是 MutationObserver 那种实时 —— 建客户档案够用了。
 *
 * 🔴 铁律：只读。本文件没有任何发送能力，发送仍走 telegramRead.openOrFocus 的浏览器预填。
 */

const telegramRead = require('./telegramRead');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 内置浏览器算「Tele①」→ 用 Telegram 账号组的第一个 id（7/8/9 里的 7） */
const ACCOUNT_ID = telegramRead.TELEGRAM_ACCOUNT_IDS[0];

/** 轮询间隔。内置浏览器常开，5 秒一趟足够，也不至于把界面拖慢。 */
const POLL_MS = 5000;

/** 单轮最多上报多少条（防止一次刷屏把写库链路压住） */
const BATCH_MAX = 20;

/* =====================================================================
 * 在页面里执行的扫描脚本（Node 侧以字符串下发）
 *
 * 🔴 写成真函数再 toString()，好处：Node 加载时就帮我们做了一遍语法检查，
 *    而且不用在字符串里转义引号（以前那种写法最容易写出语法错还不报错）。
 *    函数体里**只能**用浏览器 API，不许引用 Node 作用域。
 * ===================================================================== */
function scanInPage() {
  var SEL = {
    loginMarker: [
      '.login-form', '#sign-in-pages', '.auth-form', '.auth-pages', '#auth-login',
      '.login-wrapper', '.tg-login', 'input[name="phone"]', '.input-field-phone',
    ],
    // 🔴 v2.5.1060 修「对话列表读不到」（老板 2026-10-12 截图实证）：
    //    同一次扫描里「消息气泡 [data-mid] 命中 7 条」，但「对话列表 0 个 / 没命中」——
    //    说明**页面读得到、只是对话列表那层的选择器对不上**：Telegram K 版改过版，
    //    老的 `#LeftColumn a.ListItem-button` 在新页面上已经不存在了。
    //    新版 Web K 的现行结构（按"越具体越靠前"排，老版选择器全部留作兜底）：
    //      左栏容器 #column-left → ul.chatlist → a.chatlist-chat（条目自带 data-peer-id）
    chatList: [
      '#column-left .chatlist', 'ul.chatlist', '.chatlist', '.chats-container',
      '#column-left', '.column-left', '[data-chatlist]',
      '.chat-list', '#LeftColumn .chat-list', '.dialogs', '.sidebar',
    ],
    chatItem: [
      '#column-left a.chatlist-chat', '.chatlist a.chatlist-chat', 'a.chatlist-chat',
      'a[data-peer-id]', '[data-peer-id]',
      '#column-left a[href^="#"]', '.chatlist a[href^="#"]',
      '#LeftColumn a.ListItem-button[href^="#"]', '.chat-list a.ListItem-button[href^="#"]',
      '.ListItem.Chat', '.chat-list .chat', '.dialogs .dialog',
    ],
    chatPeerTitle: [
      '.info-row .peer-title', '.info .peer-title', '.info .title',
      '.peer-title', '.user-title', '.title', '.dialog-title',
    ],
    chatPreview: ['.last-message', '.subtitle p', '.info .subtitle', '.dialog-subtitle'],
    chatBadge: ['.chat-badge-transition', '[class*="chat-badge"]', '[class*="badge"]', '.unread-count'],
    chatTitle: [
      '.chat .chat-header .user-title', '.panel-header .peer-title', '.topbar .peer-title',
      '.chat-header .title', '.peer-title', '.chat-title', '[data-peer-title]',
    ],
    bubbles: [
      '[data-mid]', '.bubbles .bubble', '.bubble', '.messages .bubble', '.Message', '.message',
    ],
    bubbleText: [
      '.text', '.bubble .text-content', '.translatable-message .text-content',
      '.message-content .text', '.text-content', '[data-text]',
    ],
  };

  function firstOf(list) {
    for (var i = 0; i < list.length; i++) {
      try {
        var el = document.querySelector(list[i]);
        if (el) return { el: el, sel: list[i] };
      } catch (e) {}
    }
    return null;
  }
  function allOf(list) {
    for (var i = 0; i < list.length; i++) {
      try {
        var els = Array.prototype.slice.call(document.querySelectorAll(list[i]));
        if (els.length) return { els: els, sel: list[i] };
      } catch (e) {}
    }
    return { els: [], sel: '' };
  }
  function txt(el) { return el && el.textContent ? String(el.textContent).trim() : ''; }

  var out = {
    url: String(location.href || ''),
    docTitle: String(document.title || ''),
    loginPage: false,
    hasChatList: false,
    chatTitle: '',
    openPeer: '',
    list: [],
    msgs: [],
    openFallback: false,   // 列表没命中、退回"当前打开的对话"时为 true（不许当成列表读到了）
    dom: null,             // 页面结构探针（v2.5.1060）—— 选择器对不上时靠它定位
    hit: {},          // 命中的选择器名 —— 排查「到底哪一层扫到了」就靠它
  };

  var m;
  try {
    var h = String(location.hash || '');
    m = h.match(/^#(-?\d{3,})$/) || h.match(/^#@([A-Za-z0-9_]{3,32})$/);
    if (m) out.openPeer = m[1];
  } catch (e) {}

  out.loginPage = SEL.loginMarker.some(function (s) {
    try { return !!document.querySelector(s); } catch (e2) { return false; }
  });

  var listHit = allOf(SEL.chatList);
  out.hasChatList = !!listHit.sel;
  out.hit.chatList = listHit.sel;

  var t = firstOf(SEL.chatTitle);
  if (t) { out.chatTitle = txt(t.el); out.hit.chatTitle = t.sel; }

  // ---- ① 聊天列表：对话 ID + 名字 + 最后一条预览 + 未读数（**不点开**，点开会清未读）----
  var items = allOf(SEL.chatItem);
  out.hit.chatItem = items.sel;
  for (var i = 0; i < items.els.length && out.list.length < 80; i++) {
    var el = items.els[i];
    try {
      var anchor = el.tagName === 'A' ? el
        : (el.querySelector('a.chatlist-chat') || el.querySelector('a.ListItem-button')
           || el.querySelector('a[href^="#"]') || el.closest('a'));
      var href = (anchor && anchor.getAttribute && anchor.getAttribute('href')) || '';
      var pm = String(href).match(/(\d{3,})/);
      // v2.5.1060：Web K 新版把对话号直接挂在条目上（data-peer-id），比从 href 里抠数字靠得住。
      // 取不到才退回 href（老版 / 别的皮肤）。
      var dpid = '';
      try {
        dpid = String((el.getAttribute && el.getAttribute('data-peer-id')) || '');
        if (!dpid && anchor && anchor.getAttribute) dpid = String(anchor.getAttribute('data-peer-id') || '');
      } catch (e7) { /* 属性读不到就退回 href */ }
      var peerId = dpid || (pm ? pm[1] : '');
      var title = '';
      for (var j = 0; j < SEL.chatPeerTitle.length; j++) {
        var te = el.querySelector(SEL.chatPeerTitle[j]);
        if (te && txt(te) && !(te.closest && te.closest('.last-message'))) { title = txt(te); break; }
      }
      if (!title) {
        var row = el.querySelector('.info-row') || el.querySelector('.info');
        if (row && txt(row)) title = txt(row).split('\n')[0].slice(0, 60);
      }
      var preview = '';
      for (var k = 0; k < SEL.chatPreview.length; k++) {
        var pe = el.querySelector(SEL.chatPreview[k]);
        if (!pe) continue;
        try {
          var clone = pe.cloneNode(true);
          var who = clone.querySelector && clone.querySelector('.peer-title, .sender-title');
          if (who) who.parentNode.removeChild(who);
          preview = txt(clone);
        } catch (e3) { preview = txt(pe); }
        if (preview) break;
      }
      var count = 0;
      for (var b = 0; b < SEL.chatBadge.length; b++) {
        var be = el.querySelector(SEL.chatBadge[b]);
        if (!be) continue;
        var visible = true;
        try { var r = be.getBoundingClientRect(); visible = r.width > 0 && r.height > 0; } catch (e4) {}
        if (!visible) continue;   // .shown/.hidden 切换时旧节点还在，用尺寸判可见
        var nm = String(be.textContent || '').match(/\d+/);
        count = nm ? parseInt(nm[0], 10) : 1;   // 免打扰小圆点没数字，按 1 条算
        if (count > 0) break;
      }
      if (!peerId && !title) continue;
      out.list.push({ peerId: peerId, title: title, preview: preview, count: count });
    } catch (e5) {}
  }

  // 🔴 v2.5.1060 兜底（老板 2026-10-12 截图实证：列表 0 个、但当前对话的气泡读得到）：
  // 列表选择器没命中的时候，至少把**当前打开的这个对话**当成一条，别让「正在翻：谁」整个空掉 ——
  // 老板的用途是"建立客户档案"，能读到一个算一个。
  // 会用 fromOpen:true 打标记：界面上照样说明白这是兜底来的，不谎报成"列表读到了"。
  if (!out.list.length && out.chatTitle) {
    out.list.push({ peerId: out.openPeer || '', title: out.chatTitle, preview: '', count: 0, fromOpen: true });
    out.openFallback = true;
  }

  // ---- ② 当前打开的对话：气泡（点开某个客户时才会有，用来补全上下文）----
  /* 🔴 v2.6.1093 老板问「网页这边加载不了气泡？」实测查出的真 bug：
   *  原来这里写的是 `if (out.chatTitle)` —— 把**标题栏**当成了读气泡的前置门槛。
   *  实测（真 puppeteer 渲染，非推理）：页面上明明有 2 个 [data-mid] 气泡、
   *  但只要 .peer-title 一个都命中不了，msgs 就直接是 0 条、hit.bubbles 是 undefined。
   *  ——拿**最容易随改版失配的标题栏类名**去卡**最稳的数据属性 [data-mid]**，
   *    逻辑是反的：Telegram 网页版一改类名、或窗口拉窄折叠标题，气泡就全军覆没，
   *    连带译文也贴不上（贴译文要靠气泡的 mid 定位）。
   *  修法：标题栏从「门槛」降级为「有就带上、没有也照样扫气泡」。
   *  只删这一个 if，块内逻辑一行没动。*/
  {
    var bb = allOf(SEL.bubbles);
    out.hit.bubbles = bb.sel;
    var els2 = bb.els.slice(-20);   // 只看最后 20 条，别把整段历史都搬回来
    for (var n = 0; n < els2.length; n++) {
      var b2 = els2[n];
      try {
        var mid = (b2.getAttribute && b2.getAttribute('data-mid')) || '';
        var dir = (b2.classList && (b2.classList.contains('is-out') || b2.classList.contains('out'))) ? 'out' : 'in';
        var body = '';
        for (var q = 0; q < SEL.bubbleText.length; q++) {
          var sub = b2.querySelector(SEL.bubbleText[q]);
          if (sub && txt(sub)) { body = txt(sub); break; }
        }
        if (!body) body = txt(b2);
        if (!body) continue;
        out.msgs.push({ mid: mid, dir: dir, body: body.slice(0, 500) });
      } catch (e6) {}
    }
  }

  // ---- ③ 页面结构探针（v2.5.1060）----
  // 老板 2026-10-12 报「对话列表 0 个」——光回一句"没命中"没法定位到底是哪一层对不上。
  // 这里把页面**真实结构**的硬证据一起带回去（有哪些 id / 每个候选选择器命中几条 / 左栏前几个链接长什么样），
  // 全是只读查询，不动页面。凭这些就能一轮把选择器定死。
  try {
    out.dom = { ids: [], probes: {}, links: [] };
    var idEls = document.querySelectorAll('[id]');
    for (var di = 0; di < idEls.length && out.dom.ids.length < 60; di++) {
      var iv = String((idEls[di] && idEls[di].id) || '');
      if (iv && out.dom.ids.indexOf(iv) < 0) out.dom.ids.push(iv);
    }
  } catch (e8) { out.dom = { ids: [], probes: {}, links: [] }; }

  var PROBE_SEL = [
    '#column-left', '.column-left', '.chatlist', 'ul.chatlist', 'a.chatlist-chat',
    'a[data-peer-id]', '[data-peer-id]', '#LeftColumn', '.ListItem-button',
    '.chat-list', '.chats-container', '.sidebar', '.dialog', '.chat-badge',
    '[data-mid]', '.bubbles', '.bubble',
  ];
  for (var ps = 0; ps < PROBE_SEL.length; ps++) {
    try { out.dom.probes[PROBE_SEL[ps]] = document.querySelectorAll(PROBE_SEL[ps]).length; }
    catch (e9) { out.dom.probes[PROBE_SEL[ps]] = -1; }
  }
  try {
    var lks = document.querySelectorAll('a[href^="#"], a[data-peer-id]');
    for (var li = 0; li < lks.length && out.dom.links.length < 8; li++) {
      var la = lks[li];
      out.dom.links.push({
        href: String((la.getAttribute && la.getAttribute('href')) || '').slice(0, 40),
        pid: String((la.getAttribute && la.getAttribute('data-peer-id')) || '').slice(0, 24),
        cls: String(la.className || '').slice(0, 70),
        txt: txt(la).split('\n')[0].slice(0, 30),
      });
    }
  } catch (e10) {}

  return out;
}

/**
 * v2.5.1088：在 Telegram 网页里**真正发送**一条消息 / 媒体（老板授权放开原只读红线）。
 * 走老板自己登录的 web.telegram.org 会话（Tele① 内置浏览器），无需任何 api 凭证。
 * 流程：打开对应会话 → 填输入框 / 注入文件 → 点发送。只发，不发自己读到的消息。
 * 🔴 仅由操作员点击「发送」触发（前端 tgSend → /api/telegram/send → 主进程 sendViaWeb）。
 * @param {{chatKey:string,text:string,caption:string,mediaB64:string,mediaName:string}} args
 */
/**
 * v2.6.1089 修复：文本直发（媒体走 CDP 路径，见 sendViaWeb）。
 * 流程：打开会话 → 填输入框 → 点发送。仅操作员点击「发送」触发。
 * @param {{chatKey:string,text:string,caption:string,mediaB64:string,mediaName:string,isMedia:boolean}} args
 */
function sendInPage(args) {
  var chatKey = String((args && args.chatKey) || '');
  var text = String((args && args.text) || '');
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(fn, timeout, step) {
    timeout = timeout || 9000; step = step || 200;
    return new Promise(function (res) {
      var t0 = Date.now();
      (function loop() {
        var v; try { v = fn(); } catch (e) { v = null; }
        if (v) return res(v);
        if (Date.now() - t0 > timeout) return res(null);
        setTimeout(loop, step);
      })();
    });
  }
  function setText(el, txt) {
    el.focus();
    try { el.innerHTML = ''; } catch (e) { try { el.textContent = ''; } catch (e2) {} }
    try { document.execCommand('insertText', false, txt); }
    catch (e) {
      el.textContent = txt;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }
  function sendBtn() {
    return document.querySelector('button.send-button')
      || document.querySelector('.send-button')
      || document.querySelector('button[aria-label="Send"]')
      || document.querySelector('.composer-send-button')
      || document.querySelector('button.tg-composer-send')
      || document.querySelector('.send-message-button')
      || document.querySelector('[data-testid="send"]');
  }
  function composerInput() {
    return document.querySelector('.input-message-input')
      || document.querySelector('[contenteditable][data-placeholder]')
      || document.querySelector('.composer-input [contenteditable]')
      || document.querySelector('.new-message-wrapper .input-message-input');
  }
  return (async function () {
    try {
      if (chatKey) {
        var cur = String(location.hash || '').replace(/^#/, '');
        if (cur !== chatKey) {
          try { location.hash = chatKey.charAt(0) === '@' ? chatKey : String(chatKey); } catch (e) {}
          await sleep(800);
        }
      }
      var input = await waitFor(composerInput, 9000);
      if (!input) return { ok: false, error: '找不到输入框（会话可能没打开 / Telegram 还在加载 / 你还没登录）' };
      if (!text) return { ok: false, error: '内容为空' };
      setText(input, text);
      var b = await waitFor(sendBtn, 5000);
      if (!b) return { ok: false, error: '找不到发送按钮' };
      b.click();
      return { ok: true, via: 'web', kind: 'text' };
    } catch (e) {
      return { ok: false, error: '页面脚本异常：' + ((e && e.message) || e) };
    }
  })();
}

/**
 * 🔴 v2.6.1094 老板看图要求（QQ20261013-141311.png）：点左栏带 ∮ 的 Telegram 消息，
 *   中栏直接切到 Tele① 并**打开那个客户的对话**。这条就是「跳到聊天」按钮背后的实现。
 *
 * ⚠️ 铁律：这里**只改 location.hash 打开会话**，不碰输入框、不碰发送、不发任何消息。
 *   （跟 tgOpenChat 刻意分开 —— 那个是"发附件前的第一步"，会点开附件面板，不许复用。）
 *
 * 做法跟 tgOpenChat 里已验证过的那段一致（Telegram Web K 用 hash 记当前对话），
 * 额外做两件事：
 *   ① 页面 hash 里现在是别的对话时，先等它真的切过去再返回（轮询 openPeer / 标题）
 *   ② 切完把消息区滚到最底下（老板要"看到最新那条"）
 */
function jumpInPage(args) {
  var chatKey = String((args && args.chatKey) || '');
  if (!chatKey) return Promise.resolve({ ok: false, error: '没给对话标识' });
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  return (async function () {
    try {
      var cur = String(location.hash || '').replace(/^#/, '');
      if (cur !== chatKey) {
        try {
          // Telegram K 版：个人号是纯数字 peerId，频道/群是 -100… 开头 —— 都直接当 hash 用
          location.hash = chatKey.charAt(0) === '@' ? chatKey : String(chatKey);
        } catch (e) { return { ok: false, error: '切不过去：' + ((e && e.message) || e) }; }
        await sleep(1200);
      }
      // 等消息区真的出来（最多 6 秒），出来就把滚动条拉到最底下看最新那条
      for (var i = 0; i < 12; i++) {
        var box = document.querySelector('#column-center .messages-content, .messages-content, #MiddleColumn')
          || document.scrollingElement;
        if (box) { try { box.scrollTop = box.scrollHeight; } catch (e) {} }
        var composer = document.querySelector('.input-message-input, [contenteditable][data-placeholder]');
        if (composer && i > 1) break;
        await sleep(500);
      }
      return { ok: true, hash: String(location.hash || '').replace(/^#/, '') };
    } catch (e) {
      return { ok: false, error: '跳转异常：' + ((e && e.message) || e) };
    }
  })();
}

/**
 * v2.6.1089 媒体发送第一步（页内）：打开会话 + 点附件按钮 + 把真正的文件框标记 data-tgsend=1，
 * 供主进程用 CDP DOM.setFileInputFiles 注入真实文件（React onChange 必认，根治「unnamed 空壳」）。
 */
function tgOpenChat(args) {
  var chatKey = String((args && args.chatKey) || '');
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(fn, timeout, step) {
    timeout = timeout || 9000; step = step || 200;
    return new Promise(function (res) {
      var t0 = Date.now();
      (function loop() {
        var v; try { v = fn(); } catch (e) { v = null; }
        if (v) return res(v);
        if (Date.now() - t0 > timeout) return res(null);
        setTimeout(loop, step);
      })();
    });
  }
  function composerInput() {
    return document.querySelector('.input-message-input')
      || document.querySelector('[contenteditable][data-placeholder]')
      || document.querySelector('.composer-input [contenteditable]')
      || document.querySelector('.new-message-wrapper .input-message-input');
  }
  function markInput() {
    var ins = document.querySelectorAll('input[type="file"]');
    for (var i = 0; i < ins.length; i++) {
      var a = (ins[i].getAttribute('accept') || '').toLowerCase();
      if (a.indexOf('image') >= 0 || a.indexOf('video') >= 0) { ins[i].setAttribute('data-tgsend', '1'); return true; }
    }
    for (var j = 0; j < ins.length; j++) {
      if (ins[j].offsetParent !== null || (ins[j].style && ins[j].style.display !== 'none')) { ins[j].setAttribute('data-tgsend', '1'); return true; }
    }
    if (ins[0]) { ins[0].setAttribute('data-tgsend', '1'); return true; }
    return false;
  }
  return (async function () {
    try {
      if (chatKey) {
        var cur = String(location.hash || '').replace(/^#/, '');
        if (cur !== chatKey) {
          try { location.hash = chatKey.charAt(0) === '@' ? chatKey : String(chatKey); } catch (e) {}
          await sleep(800);
        }
      }
      var input = await waitFor(composerInput, 9000);
      if (!input) return { ok: false, error: '找不到输入框（会话可能没打开 / Telegram 还在加载 / 你还没登录）' };
      var attach = document.querySelector('.composer-attach-button') || document.querySelector('.attach-button')
        || document.querySelector('[data-testid="attach"]') || document.querySelector('button[aria-label="Attach"]');
      if (attach) { try { attach.click(); } catch (e) {} }
      await sleep(500);
      if (!markInput()) {
        await sleep(1000);
        if (!markInput()) return { ok: false, error: '找不到文件上传框' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '打开会话异常：' + ((e && e.message) || e) };
    }
  })();
}

/**
 * v2.6.1089 媒体发送第二步（页内）：等 Telegram 出现附件预览 → 填 caption → 点发送。
 */
function tgFinalizeSend(args) {
  var caption = String((args && args.caption) || '');
  var mediaName = String((args && args.mediaName) || '');
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(fn, timeout, step) {
    timeout = timeout || 9000; step = step || 200;
    return new Promise(function (res) {
      var t0 = Date.now();
      (function loop() {
        var v; try { v = fn(); } catch (e) { v = null; }
        if (v) return res(v);
        if (Date.now() - t0 > timeout) return res(null);
        setTimeout(loop, step);
      })();
    });
  }
  function setText(el, txt) {
    el.focus();
    try { el.innerHTML = ''; } catch (e) { try { el.textContent = ''; } catch (e2) {} }
    try { document.execCommand('insertText', false, txt); }
    catch (e) {
      el.textContent = txt;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }
  function sendBtn() {
    return document.querySelector('button.send-button')
      || document.querySelector('.send-button')
      || document.querySelector('button[aria-label="Send"]')
      || document.querySelector('.composer-send-button')
      || document.querySelector('button.tg-composer-send')
      || document.querySelector('.send-message-button')
      || document.querySelector('[data-testid="send"]');
  }
  function composerInput() {
    return document.querySelector('.input-message-input')
      || document.querySelector('[contenteditable][data-placeholder]')
      || document.querySelector('.composer-input [contenteditable]')
      || document.querySelector('.new-message-wrapper .input-message-input');
  }
  function previewReady() {
    return document.querySelector('.media-preview') || document.querySelector('[class*="preview"]')
      || document.querySelector('.album-item') || document.querySelector('.photo')
      || document.querySelector('.video') || document.querySelector('.document') || null;
  }
  return (async function () {
    try {
      var pv = await waitFor(previewReady, 8000);
      if (!pv) return { ok: false, error: '文件已选但 Telegram 没出现预览（可能文件太大 / 格式不支持）' };
      if (caption) {
        var ci = await waitFor(composerInput, 5000);
        if (ci) setText(ci, caption);
      }
      var btn = await waitFor(sendBtn, 5000);
      if (!btn) return { ok: false, error: '找不到发送按钮（媒体预览可能没出来）' };
      btn.click();
      return { ok: true, via: 'web', kind: 'media', name: mediaName };
    } catch (e) {
      return { ok: false, error: '发送异常：' + ((e && e.message) || e) };
    }
  })();
}

/* =====================================================================
 * v2.5.1089：从已登录的 Telegram 网页里**实时取客户资料**（头像/名称/用户名/手机号/最后上线）。
 * 这是 MTProto 没连上时的唯一真通道 —— 复用老板自己登录的 web.telegram.org 会话，
 * 无需任何 api 凭证。MTProto 连上时优先走它（teleproto.getUserProfile），没连才退回这里。
 * 流程：确保打开目标会话 → 读头部名称/状态/小头像 → 点开资料卡取 @username 与手机号 → 关掉资料卡。
 * 取不到时返回 {ok:false}，由 server 再退回 DB 里存的名称/@username。
 * ===================================================================== */
function profileInPage(args) {
  var chatKey = String((args && args.chatKey) || '');
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(fn, timeout, step) {
    timeout = timeout || 8000; step = step || 200;
    return new Promise(function (res) {
      var t0 = Date.now();
      (function loop() {
        var v; try { v = fn(); } catch (e) { v = null; }
        if (v) return res(v);
        if (Date.now() - t0 > timeout) return res(null);
        setTimeout(loop, step);
      })();
    });
  }
  function q(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
  function txt(el) { return el && el.textContent ? String(el.textContent).trim() : ''; }
  function openPeer() {
    if (chatKey) {
      var cur = String(location.hash || '').replace(/^#/, '');
      if (cur !== chatKey) {
        try { location.hash = chatKey.charAt(0) === '@' ? chatKey : String(chatKey); } catch (e) {}
      }
    }
  }
  return (async function () {
    try {
      openPeer();
      var header = await waitFor(function () {
        return q('.chat .chat-header') || q('.panel-header') || q('.chat-header') || q('.sidebar-header');
      }, 9000);
      if (!header) return { ok: false, error: '找不到聊天头部（会话可能没打开 / 未登录）' };
      var name = txt(q('.chat .chat-header .user-title')) || txt(q('.peer-title')) || txt(q('.chat-header .title')) || txt(q('.panel-header .peer-title'));
      var lastSeen = txt(q('.chat .chat-header .subtitle')) || txt(q('.chat-header .subtitle')) || txt(q('.chat-info .subtitle')) || '';
      var hdrAvatar = q('.chat .chat-header .avatar img') || q('.chat-header .avatar img') || q('.panel-header .avatar img');
      var photoDataUrl = hdrAvatar && hdrAvatar.src ? hdrAvatar.src : '';
      var username = ''; var phone = '';
      var infoBtn = q('.chat .chat-header .chat-info') || q('.chat-header .chat-info') || (header.querySelector ? header.querySelector('.chat-info') : null);
      if (infoBtn) { try { infoBtn.click(); } catch (e) {} }
      var profile = await waitFor(function () { return q('.profile') || q('.sidebar .profile'); }, 4000);
      if (profile) {
        var un = txt(q('.profile .profile-username')) || (profile.querySelector('.profile-username') ? txt(profile.querySelector('.profile-username')) : '');
        if (un) username = un.replace(/^@/, '');
        var nm = txt(q('.profile .profile-name')) || (profile.querySelector('.profile-name') ? txt(profile.querySelector('.profile-name')) : '');
        if (nm && !name) name = nm;
        var pav = q('.profile .profile-avatar img') || (profile.querySelector('.profile-avatar img'));
        if (pav && pav.src) photoDataUrl = pav.src;
        var allTxt = txt(profile);
        var pm = allTxt.match(/(\+\d[\d\s\-()]{6,}\d)/);
        if (pm) phone = pm[1].replace(/\s/g, '');
        var closeBtn = q('.profile .btn-close') || q('.profile .close-button') || q('.sidebar .profile .btn-icon') || (profile.querySelector('.btn-close'));
        if (closeBtn) { try { closeBtn.click(); } catch (e) {} }
      }
      if (!name && !username && !photoDataUrl) return { ok: false, error: '页面未取到资料' };
      return { ok: true, via: 'web', name: name, username: username, phone: phone, lastSeen: lastSeen, photoDataUrl: photoDataUrl };
    } catch (e) {
      return { ok: false, error: '页面脚本异常：' + ((e && e.message) || e) };
    }
  })();
}

const PROFILE_SOURCE = `(${profileInPage.toString()})()`;
const SCAN_SOURCE = `(${scanInPage.toString()})()`;
const SEND_SOURCE = `(${sendInPage.toString()})()`;

/* =====================================================================
 * 把中文译文**贴到 Telegram 每条气泡下方**（2026-10-11 老板在 A/B 两个方案里选了 B）
 *
 * 做法：往气泡里插一个自己的 div（id 固定 tg-zh-<mid>），内容是中文。
 *   · **幂等**：同一条消息第二次进来，只更新文字，不会越插越多；
 *   · **不碰 Telegram 的任何原有节点**，只 append 一个自己的兄弟节点；
 *   · 只贴**能看到的那几条**（页面上真实存在的气泡），没在页面里的不凭空造；
 *   · Telegram 自己重绘/切对话把它冲掉了没关系 —— 面板里那份始终在，下一轮 5 秒内会补回来。
 * 🔴 铁律没变：只往里加文字，不改 Telegram 的任何消息内容，更不做任何发送动作。
 * ===================================================================== */
function paintInPage(rows) {
  var LOG = '[蜜蜂]';
  var n = 0;
  try {
    if (!Array.isArray(rows) || !rows.length) return { ok: true, painted: 0 };
    // 先把「已经不在页面上的旧译文」清掉，避免切了对话还留着上一个人的译文
    var olds = document.querySelectorAll('[id^="tg-zh-"]');
    for (var o = 0; o < olds.length; o++) {
      try {
        if (!document.getElementById(olds[o].id)) continue;
        if (!olds[o].getAttribute('data-tg-zh-live')) olds[o].parentNode.removeChild(olds[o]);
      } catch (e0) {}
    }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      var mid = String(r.mid || '');
      var zh = String(r.zh || '').trim();
      if (!mid || !zh) continue;
      var bub = document.querySelector('[data-mid="' + mid + '"]');
      if (!bub) continue;                       // 这条不在当前视图里，跳过
      var id = 'tg-zh-' + mid;
      var el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.setAttribute('data-tg-zh-live', '1');
        el.style.cssText = 'margin:4px 2px 0;padding:3px 7px;font-size:12px;line-height:1.6;' +
          'color:#1f6aa5;font-weight:600;background:rgba(31,106,165,.08);border-radius:6px;' +
          'white-space:pre-wrap;word-break:break-word;';
        bub.appendChild(el);
      }
      if (el.textContent !== zh) el.textContent = zh;
      el.title = '软件翻的中文（原文没动）';
      n++;
    }
    return { ok: true, painted: n };
  } catch (e) {
    console.warn(LOG, '贴译文失败：', (e && e.message) || e);
    return { ok: false, painted: n, error: String((e && e.message) || e) };
  }
}

/** 下发用的脚本（带着参数一起序列化，避免再拼一层引号） */
function paintSource(rows) {
  return `(${paintInPage.toString()})(${JSON.stringify(rows || [])})`;
}

/** 清掉所有贴上去的译文（切走 Tele① / 关软件时用，不留痕） */
function clearPaintInPage() {
  try {
    var els = document.querySelectorAll('[id^="tg-zh-"]');
    for (var i = 0; i < els.length; i++) {
      try { els[i].parentNode.removeChild(els[i]); } catch (e) {}
    }
    return { ok: true, cleared: els.length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/* =====================================================================
 * v2.5.1059：页面「脏检查」探针（思路来自样品 wa-split 的 PROBE_CODE）
 *
 * 样品原版（wa-split/inject-code.js:106-113）：key = 会话标题 + 条数 + 已挂译文数，
 *   用来判断「WhatsApp 是不是把整个会话 DOM 重建了」—— 重建了译文就跟着没了，得重贴。
 * Telegram 一个毛病：它也是虚拟列表 + 单页应用，切对话 / 来新消息时气泡被整批换掉。
 *
 * 主进程这边拿它当**省钱闸门**（老板 2026-10-12 选的甲方案）：
 *   key 没变 = 页面没动 = 这一轮一趟都不跑，不再每 15 秒无脑重贴一次。
 *   key 变了 = 切了对话 / 来了新消息 / 译文被冲掉了 → 才真去拉数据重贴。
 *
 * 🔴 只读取页面上的东西，不改任何节点。
 * ===================================================================== */
function pageKeyInPage() {
  var title = '';
  var hash = '';
  try { hash = String(location.hash || ''); } catch (e) {}
  var SEL = [
    '.chat .chat-header .user-title', '.panel-header .peer-title', '.topbar .peer-title',
    '.chat-header .title', '.peer-title', '.chat-title', '[data-peer-title]',
  ];
  for (var i = 0; i < SEL.length; i++) {
    try {
      var el = document.querySelector(SEL[i]);
      if (el && el.textContent && String(el.textContent).trim()) { title = String(el.textContent).trim(); break; }
    } catch (e2) {}
  }
  var total = 0;
  try { total = document.querySelectorAll('[data-mid]').length; } catch (e3) {}
  if (!total) {
    try { total = document.querySelectorAll('.bubbles .bubble, .bubble, .Message, .message').length; } catch (e4) {}
  }
  var painted = 0;
  try { painted = document.querySelectorAll('[id^="tg-zh-"]').length; } catch (e5) {}
  var unread = 0;
  try {
    var badges = document.querySelectorAll('.chat-badge-transition');
    for (var b = 0; b < badges.length; b++) {
      var n = parseInt(String(badges[b].textContent || '').replace(/\D+/g, ''), 10);
      if (n > 0) unread += n;
    }
  } catch (e6) {}
  return {
    key: title + '|' + hash + '|' + total + '|' + painted + '|' + unread,
    title: title, hash: hash, total: total, painted: painted, unread: unread,
    url: String((location && location.href) || ''),
  };
}

function pageKeySource() { return `(${pageKeyInPage.toString()})()`; }

/** 主进程：取一次页面指纹。拿不到页面返回 { ok:false, found:false } */
async function pageKey() {
  const guest = findGuest();
  if (!guest) return { ok: false, found: false, reason: '内置浏览器没打开' };
  try {
    const r = await guest.executeJavaScript(pageKeySource(), false);
    if (!r || typeof r !== 'object') return { ok: false, found: true, reason: '页面没返回指纹（可能还在加载）' };
    return Object.assign({ ok: true, found: true }, r);
  } catch (e) {
    return { ok: false, found: true, reason: String((e && e.message) || e) };
  }
}

/* =====================================================================
 * 主进程侧
 * ===================================================================== */

/** 取 Electron 的 webContents 模块；纯 Node（跑测试）里返回 null */
function electronWebContents() {
  try {
    const e = require('electron');
    if (e && typeof e === 'object' && e.webContents && typeof e.webContents.getAllWebContents === 'function') {
      return e.webContents;
    }
  } catch (_) { /* 不在 Electron 主进程里 */ }
  return null;
}

/** 取 Electron 的 webContents 模块；拿不到就 null（和上面同义，留着给 listPages 用同一个入口） */
function electronApp() {
  try {
    const e = require('electron');
    if (e && typeof e === 'object') return e;
  } catch (_) { /* 不在 Electron 里 */ }
  return null;
}

/* 🔴 2026-10-11 v2.5.1058：把「认不认得出这是 Telegram」的判据放宽 + 留痕。
   老板报「明明登着，却说没找到内置浏览器里的 Telegram 页面」，根因候选有三个：
     ① webview 的页面压根没进 getAllWebContents（Electron 版本 / webviewTag 配置问题）
     ② 进了，但 URL 不是 web.telegram.org（比如二次跳转到别的域名、或停在 about:blank / 中间页）
     ③ 页面类型是 webview，但 getType 拿不到、或我们的判断太窄
   所以这里：a) 记下**每一次**判定的过程（找没找到、都看到了哪些页面）；b) URL 判据放宽到
   多种 Telegram 域名；c) 加一层「上一次找到过的页面」缓存兜底（同一次运行里能找到过就还认它）。 */
const TG_URL_HINTS = ['web.telegram.org', 'telegram.org', 'telegram.dog'];

/** 这个 webContents 看起来像不像 Telegram 页面 */
function looksLikeTelegram(w) {
  try {
    const u = String((w && w.getURL && w.getURL()) || '');
    if (!u) return false;
    const lower = u.toLowerCase();
    return TG_URL_HINTS.some((h) => lower.includes(h));
  } catch (_) { return false; }
}

let lastGuest = null;   // 上一次找到的那个 guest（兜底：这一轮找不到就先用它）

/** 把 Electron 里所有页面列出来（诊断用：老板点「看诊断」时调，只读） */
function listPages() {
  const wc = electronWebContents();
  const out = { ok: true, electron: !!wc, count: 0, pages: [], found: false, hint: '' };
  if (!wc) {
    out.hint = '当前不在 Electron 主进程里（开发调试或纯 Node 环境）';
    return out;
  }
  let all = [];
  try { all = wc.getAllWebContents() || []; } catch (e) { out.hint = 'getAllWebContents 调用失败：' + (e && e.message); return out; }
  out.count = all.length;
  let foundIdx = -1;
  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    let row = { i, url: '', title: '', type: '', destroyed: false, isTG: false };
    try {
      row.destroyed = !!(w.isDestroyed && w.isDestroyed());
      if (!row.destroyed) {
        row.url = String((w.getURL && w.getURL()) || '');
        row.title = String((w.getTitle && w.getTitle()) || '');
        try { row.type = String((w.getType && w.getType()) || ''); } catch (_) {}
        row.isTG = looksLikeTelegram(w);
        if (row.isTG && foundIdx < 0) foundIdx = i;
      }
    } catch (e) { row.error = String((e && e.message) || e); }
    out.pages.push(row);
  }
  out.found = foundIdx >= 0;
  out.foundIndex = foundIdx;
  out.hint = out.found
    ? `找到 Telegram 页面（第 ${foundIdx} 个：${out.pages[foundIdx].url}）`
    : (out.count ? `一共 ${out.count} 个页面，但没一个是 Telegram（看 pages 里各自的 url）`
                 : 'getAllWebContents 返回了 0 个页面 —— 说明内置浏览器还没真正创建（先点中栏「Tele①」页签）');
  return out;
}

/** 找到内置浏览器（Tele① 的 webview）里那个 web.telegram.org 页面 */
function findGuest() {
  const wc = electronWebContents();
  if (!wc) return null;
  let all = [];
  try { all = wc.getAllWebContents() || []; } catch (_) { return null; }
  for (const w of all) {
    try {
      if (!w || (w.isDestroyed && w.isDestroyed())) continue;
      if (looksLikeTelegram(w)) { lastGuest = w; return w; }
    } catch (_) { /* 单个页面查状态出错就跳过 */ }
  }
  // 兜底：这一轮没扫到，但之前找到过、而且那个页面还活着 → 还用它
  // （Telegram 页面在跳转/重载的一瞬间 URL 可能是 about:blank，别因此判"没找到"）
  try {
    if (lastGuest && !(lastGuest.isDestroyed && lastGuest.isDestroyed())) return lastGuest;
  } catch (_) {}
  return null;
}

const seenList = new Map();   // peer -> { count, body }
const seenBubble = new Set(); // `${chatKey}|${mid}|${body前40}`
let timer = null;
let hooks = { onMessages() {}, onState() {} };
let lastScan = null;          // 最近一次原始扫描结果（probe 直接复用，不再重复扫页面）
let busy = false;
/* 🔴 v2.5.1058：把「这次为什么没读到」留住。
   原来 scanOnce 失败一律 return null，probe 只能说一句笼统的「没找到内置浏览器里的 Telegram 页面」，
   老板拿着这句话根本没法判断是"页面没开"还是"Electron 没算上这个 webview"还是"URL 没对上"。
   现在分三档记原因：no-electron / no-page / exec-failed。 */
let lastFail = null;   // { reason, detail, pages, at }

/** 扫一次页面（不落库），返回原始结果；没找到内置浏览器返回 null */
async function scanOnce() {
  const guest = findGuest();
  if (!guest) {
    lastScan = null;
    const diag = listPages();
    // 分清楚两件事：Electron 环境本身拿不到（开发模式），还是环境正常但页面上没这个 webview
    lastFail = {
      reason: diag.electron ? 'no-page' : 'no-electron',
      detail: diag.hint,
      pages: diag.pages || [],
      at: new Date().toISOString(),
    };
    return null;
  }
  let res = null;
  try {
    res = await guest.executeJavaScript(SCAN_SOURCE, false);
  } catch (e) {
    lastScan = null;
    lastFail = {
      reason: 'exec-failed',
      detail: String((e && e.message) || e),
      url: (() => { try { return String(guest.getURL() || ''); } catch (_) { return ''; } })(),
      at: new Date().toISOString(),
    };
    return null;
  }
  if (!res || typeof res !== 'object') {
    lastScan = null;
    lastFail = { reason: 'exec-failed', detail: '页面没返回扫描结果（可能是页面还在加载）', at: new Date().toISOString() };
    return null;
  }
  lastFail = null;
  lastScan = { ...res, at: new Date().toISOString() };
  return lastScan;
}

/** 一轮采集：扫 → 挑出新的/变了的 → 交给 hooks.onMessages 入库 */
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const snap = await scanOnce();
    if (!snap) {
      hooks.onState({ id: ACCOUNT_ID, status: 'not_open', text: '内置浏览器没打开（点中栏「Tele①」页签，在里面登录 Telegram）', level: 'info' });
      return;
    }
    if (snap.loginPage) {
      hooks.onState({ id: ACCOUNT_ID, status: 'login_required', text: 'Tele①：还没登录（在下面的内置浏览器里登录 Telegram）', level: 'warn' });
      return;
    }

    const batch = [];

    // ① 聊天列表：未读数变多、或最后一条预览变了 → 报一条
    let unreadChats = 0;
    for (const it of snap.list || []) {
      const peer = it.peerId || it.title;
      if (!peer) continue;
      const prev = seenList.get(peer);
      seenList.set(peer, { count: it.count, body: it.preview });
      if (!it.count) continue;
      unreadChats += 1;
      const grew = !prev || it.count > prev.count;
      const changed = prev && prev.body != null && prev.body !== it.preview;
      if (!grew && !changed) continue;   // 没变化 → 不重复报（"翻译过的读档不翻"同理，读过的不再读）
      const body = it.preview || '[新消息]';
      const m = telegramRead.toMessage({
        chatKey: peer,
        chatName: it.title || peer,
        msgId: `wvlist:${peer}:${it.count}:${String(body).slice(0, 24)}`,
        direction: 'in',
        body,
        ts: new Date().toISOString(),
        isGroup: /group|群/i.test(it.title || ''),
      }, ACCOUNT_ID);
      // toMessage 不带 accountId（历史原因：telegramRead 是在 attachPoller 里补的），
      // 这里补上，handleTelegramMessage 才能认出是「Tele①」这个号。
      if (m) { m.accountId = ACCOUNT_ID; batch.push(m); }
    }

    // ② 当前打开的对话：新气泡（补上下文，方便建档案）
    const chatKey = snap.openPeer || snap.chatTitle;
    if (chatKey && Array.isArray(snap.msgs)) {
      for (const b of snap.msgs) {
        const key = `${chatKey}|${b.mid}|${String(b.body).slice(0, 40)}`;
        if (seenBubble.has(key)) continue;
        seenBubble.add(key);
        const m = telegramRead.toMessage({
          chatKey,
          chatName: snap.chatTitle || chatKey,
          msgId: b.mid || `wvbubble:${String(b.body).slice(0, 32)}`,
          direction: b.dir === 'out' ? 'out' : 'in',
          body: b.body,
          ts: new Date().toISOString(),
          isGroup: /group|群/i.test(snap.chatTitle || ''),
        }, ACCOUNT_ID);
        if (m) batch.push(m);
      }
    }

    if (batch.length) hooks.onMessages(batch.slice(0, BATCH_MAX));
    hooks.onState({
      id: ACCOUNT_ID,
      status: 'collecting',
      chats: (snap.list || []).length,
      unread: unreadChats,
      read: batch.length,
      text: `Tele①：收集中（列表 ${(snap.list || []).length} 项，未读 ${unreadChats} 个，本轮读到 ${batch.length} 条）`,
      level: 'ok',
    });
  } catch (e) {
    hooks.onState({ id: ACCOUNT_ID, status: 'error', text: `Tele①：读取出错（${(e && e.message) || e}）`, level: 'error' });
  } finally {
    busy = false;
  }
}

/** 启动定时采集（幂等） */
function start(h = {}) {
  hooks = {
    onMessages: typeof h.onMessages === 'function' ? h.onMessages : function () {},
    onState: typeof h.onState === 'function' ? h.onState : function () {},
  };
  if (timer) return;
  tick().catch(() => {});                 // 先立刻跑一趟，别让状态条空着
  timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * 「试着读取」用的一次性诊断：把这一刻在内置浏览器里真实看到的东西原样返回。
 * 目的：让「到底能不能读到」有可核对的证据，而不是一句"收集中"。
 *
 * 🔴 v2.5.1058：找不到页面时**必须说出是哪一种找不到**（老板 2026-10-11 报过
 *    「明明在软件里登录着，却说没找到」）。三种原因分开报，并且把 Electon 里
 *    所有页面一起带回去 —— 老板截个图我就能定位。
 */
async function probe() {
  const snap = await scanOnce();
  if (!snap) {
    const f = lastFail || { reason: 'no-page', detail: '未知' };
    const base = { ok: false, found: false, reasonCode: f.reason, pages: f.pages || [], detail: f.detail || '' };
    if (f.reason === 'no-electron') {
      return Object.assign(base, {
        reason: '当前不是在软件的桌面版里跑（拿不到 Electron 的页面列表）—— 这条功能只在安装后的软件里有效。',
      });
    }
    if (f.reason === 'exec-failed') {
      return Object.assign(base, {
        reason: `找到了 Telegram 页面，但读它的内容失败了：${f.detail}`,
      });
    }
    const n = (f.pages || []).length;
    return Object.assign(base, {
      reason: n
        ? `没找到 Telegram 页面。当前软件里一共 ${n} 个页面，都不是 Telegram（点「看诊断」能看到各自的网址）。`
        : '没找到 Telegram 页面。软件里现在一个内嵌页面都没有 —— 请先点中栏「Tele①」页签，等网页加载出来再试。',
    });
  }
  return {
    ok: true,
    found: true,
    url: snap.url,
    loginPage: snap.loginPage,
    chatTitle: snap.chatTitle,
    chats: (snap.list || []).length,
    unread: (snap.list || []).filter((x) => x.count > 0).length,
    bubbles: (snap.msgs || []).length,
    hit: snap.hit,                                  // 命中的选择器 —— Telegram 改版时先查这里
    // v2.5.1060：列表没命中、退回"当前打开的那个对话"时为 true —— 界面必须说清楚，不许当成列表读到了
    openFallback: !!snap.openFallback,
    dom: snap.dom || null,                          // 页面真实结构（id 清单 / 选择器命中数 / 左栏链接样本）
    sample: (snap.list || []).filter((x) => x.count > 0).slice(0, 5),
    sampleMsgs: (snap.msgs || []).slice(-3),
    at: snap.at,
  };
}

/**
 * 给「Telegram 翻译面板」用：告诉我**现在该翻哪个对话**（2026-10-11 老板看图定的规则）。
 *
 * 老板的红框里那一屏就是这样：最下面那个对话（Richard Bennett）最新一条是**他自己发的**，
 * 上面那个（Xue，有未读标记）才是等着回的。所以规则是：
 *   ① 最下面那个对话的最新一条是 out → 说明这个已经回过了，改用**上一个对话**（优先有未读的）；
 *   ② 否则就用最下面那个对话。
 * @param {Array<{peerId?:string,title?:string,count?:number,preview?:string}>} list 聊天列表（页面上从上到下）
 * @param {Array<{dir?:string,body?:string}>} msgs 当前打开那个对话的气泡
 * @returns {{peer:string,title:string,why:string}|null}
 */
function pickConversation(list, msgs) {
  const arr = Array.isArray(list) ? list.filter((x) => x && (x.peerId || x.title)) : [];
  if (!arr.length) return null;
  const bottom = arr[arr.length - 1];
  const last = Array.isArray(msgs) && msgs.length ? msgs[msgs.length - 1] : null;
  // 判断"最下面那个是不是已经回过了"：只有真拿到气泡才敢下这个结论，
  // 拿不到气泡（对话框没开 / 选择器失效）就老老实实用最下面那个，不瞎猜。
  if (last && last.dir === 'out') {
    for (let i = arr.length - 2; i >= 0; i--) {
      if (arr[i].count > 0) return { peer: arr[i].peerId || arr[i].title, title: arr[i].title || arr[i].peerId, why: '上一个（有未读，等着回）' };
    }
    if (arr.length >= 2) {
      const p = arr[arr.length - 2];
      return { peer: p.peerId || p.title, title: p.title || p.peerId, why: '上一个（最下面那个你已经回过了）' };
    }
  }
  return { peer: bottom.peerId || bottom.title, title: bottom.title || bottom.peerId, why: '最上面读到的那个对话' };
}

/**
 * 「Telegram 翻译面板」用：现在 Telegram 页面上开着/该看的对话是哪个 + 当前气泡快照。
 * 只读、不落库。拿不到页面就返回 found:false。
 */
async function currentConversation() {
  const snap = lastScan || (await scanOnce());
  if (!snap) {
    return { ok: false, found: false, reason: '没找到内置浏览器里的 Telegram 页面（点中栏「Tele①」页签，等网页加载出来）' };
  }
  if (snap.loginPage) {
    return { ok: false, found: false, loginPage: true, reason: '内置浏览器还停在登录页 —— 先在 Tele① 里登录 Telegram。' };
  }
  const pick = pickConversation(snap.list, snap.msgs);
  return {
    ok: true,
    found: true,
    at: snap.at,
    openPeer: snap.openPeer || null,
    openTitle: snap.chatTitle || null,
    chats: (snap.list || []).length,
    pick,                                   // { peer, title, why } —— 界面右上角那行「正在翻谁」用它
    bubbles: (snap.msgs || []).length,
  };
}

/**
 * 把中文译文贴到 Telegram 每条气泡下方（老板选的方案 B）。
 * @param {Array<{mid:string, zh:string}>} rows 每条 = Telegram 气泡的 data-mid + 中文
 *        mid 就是采集侧存进库里的 waMsgId 后半段（telegramRead.toMessage 的 msgId），
 *        所以「库里翻好的译文」能一对一贴回原气泡。
 */
async function paintBubbles(rows) {
  const guest = findGuest();
  if (!guest) return { ok: false, found: false, reason: '内置浏览器没打开' };
  try {
    return await guest.executeJavaScript(paintSource(rows), false);
  } catch (e) {
    return { ok: false, found: true, error: String((e && e.message) || e) };
  }
}

/** 清掉贴上去的译文（切走 Tele① 时调用，不在人家页面上留东西） */
async function clearBubbles() {
  const guest = findGuest();
  if (!guest) return { ok: false, found: false };
  try {
    return await guest.executeJavaScript(`(${clearPaintInPage.toString()})()`, false);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 用 CDP 把本地文件塞进页面里标记好的 <input data-tgsend=1>（模拟真实文件选择框，
 * React 的 onChange 必触发，彻底解决「input.files=dt.files 注入触发不了 Telegram 上传」的 unnamed 空壳问题）。
 */
async function setFileViaCdp(guest, absPath) {
  const dbg = guest && guest.debugger;
  if (!dbg) return { ok: false, error: 'WebContents 无 debugger（无法走 CDP 注入文件）' };
  let attached = false;
  try { dbg.attach('1.3'); attached = true; } catch (e) { /* 已被其它模块 attach，复用即可 */ }
  try {
    try { await dbg.sendCommand('DOM.enable'); } catch (e) {}
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[data-tgsend="1"]' });
    if (!nodeId) { try { await dbg.sendCommand('DOM.disable'); } catch (e) {} if (attached) try { dbg.detach(); } catch (_) {} return { ok: false, error: '找不到标记的文件框（data-tgsend）' }; }
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [absPath] });
    try { await dbg.sendCommand('DOM.disable'); } catch (e) {}
    if (attached) try { dbg.detach(); } catch (_) {}
    return { ok: true };
  } catch (e) {
    try { await dbg.sendCommand('DOM.disable'); } catch (_) {}
    if (attached) try { dbg.detach(); } catch (_) {}
    return { ok: false, error: 'CDP 设置文件失败：' + ((e && e.message) || e) };
  }
}

/**
 * 🔴 v2.6.1094：只读跳转 —— 在 Tele① 内置浏览器里打开某个 peerId / @username 的对话，
 * 并把消息区滚到最新。**不发任何消息**（铁律：绝不自动发送）。
 * @param {string|number} chatKey peerId（数值）或 @username
 */
async function jumpViaWeb(chatKey) {
  const guest = findGuest();
  if (!guest) {
    return { ok: false, error: '内置浏览器里没找到 Telegram 页面（请先点中栏「Tele①」页签，等网页加载出来）' };
  }
  try {
    return await guest.executeJavaScript(`(${jumpInPage.toString()})({chatKey:${JSON.stringify(String(chatKey))}})`, false);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 在已登录的 Telegram 网页（Tele① 内置浏览器）里真正发送一条消息 / 媒体。
 * 不需要 api 凭证 —— 复用老板自己的登录会话。仅操作员点击「发送」时调用。
 * 媒体：主进程把 Buffer 写临时文件，用 CDP DOM.setFileInputFiles 注入真实文件（React 必认，根治 unnamed）。
 * @param {string|number} chatKey peerId（数值，如 123456789）或 @username
 * @param {{text?:string, caption?:string, mediaBuffer?:Buffer|string, mediaName?:string}} opts
 * @returns {Promise<{ok:boolean, via?:string, kind?:string, error?:string}>}
 */
async function sendViaWeb(chatKey, opts = {}) {
  const guest = findGuest();
  if (!guest) {
    return { ok: false, error: '内置浏览器里没找到 Telegram 页面（请先点中栏「Tele①」页签，在里面登录并打开 Telegram）' };
  }
  const text = (opts.text || '').toString();
  const caption = (opts.caption || '').toString();
  const mediaName = (opts.mediaName || 'file').toString();
  const isMedia = !!(opts.mediaBuffer && Buffer.isBuffer(opts.mediaBuffer) && opts.mediaBuffer.length > 0);

  if (isMedia) {
    // 写临时文件（保留原扩展名，便于 Telegram 识别类型），再用 CDP 注入真实文件
    const m = mediaName.match(/\.[a-z0-9]+$/i);
    const ext = m ? m[0].toLowerCase() : '';
    const mediaPath = path.join(os.tmpdir(), `wa-tg-${Date.now()}${ext}`);
    try { fs.writeFileSync(mediaPath, opts.mediaBuffer); } catch (e) { return { ok: false, error: '写临时文件失败：' + e.message }; }
    const cleanup = () => { try { fs.unlinkSync(mediaPath); } catch (_) {} };
    try {
      const open = await guest.executeJavaScript(`(${tgOpenChat.toString()})(${JSON.stringify({ chatKey: String(chatKey || '') })})`, true);
      if (!open || !open.ok) { cleanup(); return open || { ok: false, error: '打开会话失败' }; }
      const cdp = await setFileViaCdp(guest, mediaPath);
      if (!cdp.ok) { cleanup(); return { ok: false, error: cdp.error }; }
      const fin = await guest.executeJavaScript(`(${tgFinalizeSend.toString()})(${JSON.stringify({ caption, mediaName })})`, true);
      cleanup();
      return (fin && typeof fin === 'object') ? fin : { ok: false, error: '页面脚本无返回（可能 Telegram 还在加载）' };
    } catch (e) {
      cleanup();
      return { ok: false, error: '注入发送失败：' + ((e && e.message) || e) };
    }
  }

  // 纯文本：页内直发
  const arg = { chatKey: String(chatKey || ''), text, caption, mediaB64: '', mediaName };
  const src = `(${sendInPage.toString()})(${JSON.stringify(arg)})`;
  try {
    const r = await guest.executeJavaScript(src, true);
    if (r && typeof r === 'object') return r;
    return { ok: false, error: '页面脚本没有返回结果（可能 Telegram 还在加载）' };
  } catch (e) {
    return { ok: false, error: '注入发送失败：' + ((e && e.message) || e) };
  }
}

/**
 * 在已登录的 Telegram 网页（Tele① 内置浏览器）里实时取客户资料：头像/名称/用户名/手机号/最后上线。
 * 不需要 api 凭证 —— 复用老板自己的登录会话。仅操作员点开「客户资料」浮层时调用。
 * 头像若是远程 URL，主进程把它拉回转 base64（避免跨域 / blob 无法在主窗口显示）。
 * @param {string|number} chatKey peerId（数值）或 @username
 * @returns {Promise<{ok:boolean, name?:string, username?:string, phone?:string, lastSeen?:string, photoDataUrl?:string, error?:string}>}
 */
async function getUserProfileViaWeb(chatKey) {
  const guest = findGuest();
  if (!guest) {
    return { ok: false, error: '内置浏览器里没找到 Telegram 页面（请先点中栏「Tele①」页签并登录）' };
  }
  const arg = { chatKey: String(chatKey || '') };
  const src = `(${profileInPage.toString()})(${JSON.stringify(arg)})`;
  try {
    const r = await guest.executeJavaScript(src, true);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || '网页未取到资料' };
    let photoDataUrl = r.photoDataUrl || '';
    if (photoDataUrl && /^https?:/i.test(photoDataUrl)) {
      try {
        const ab = await fetch(photoDataUrl).then((x) => x.arrayBuffer());
        const m = (r.photoDataUrl || '').match(/\.(png|jpe?g|gif|webp)/i);
        const ct = !m ? 'image/jpeg' : (m[1].toLowerCase() === 'jpg' ? 'image/jpeg' : 'image/' + m[1].toLowerCase());
        photoDataUrl = `data:${ct};base64,${Buffer.from(ab).toString('base64')}`;
      } catch (e) { photoDataUrl = ''; }
    }
    return { ok: true, name: r.name || '', username: r.username || '', phone: r.phone || '', lastSeen: r.lastSeen || '', photoDataUrl };
  } catch (e) {
    return { ok: false, error: '注入取资料失败：' + ((e && e.message) || e) };
  }
}

module.exports = {
  start, stop, probe, scanOnce, tick, findGuest, currentConversation, pickConversation,
  paintBubbles, paintSource, clearBubbles, paintInPage, clearPaintInPage,
  listPages, looksLikeTelegram, sendViaWeb, jumpViaWeb, jumpInPage,
  tgOpenChat, tgFinalizeSend, getUserProfileViaWeb,
  pageKey, pageKeySource, pageKeyInPage,
  ACCOUNT_ID, POLL_MS, scanInPage, SCAN_SOURCE, SEND_SOURCE, PROFILE_SOURCE,
};
