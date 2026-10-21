/**
 * WA① 译文气泡 · 动手前的只读实测（诊断工具，不是业务代码）
 *
 * 🔴 为什么要先做这一步（老板 2026-10-15 要求）：
 *   老板的方案是「WhatsApp 网页自己画对话，我们只往上叠中文译文气泡」。
 *   要叠，就必须能**在网页里认到每一条消息**（哪条是客户发的、哪条是我发的，
 *   以及它对应我们库里的哪一条）。认不到，整个方案就得换。
 *   所以先实测，拿到真凭实据再动代码。
 *
 * 🔴 本工具只读，一个字都不改：
 *   · 不点开任何对话、不点未读、不滚页面、不写输入框、不发送
 *   · 只读当前已经渲染出来的 DOM + 只读 WhatsApp 内部 Store
 *   · 跑完自动关掉自己起的 Chrome，不碰老板正在用的软件
 *
 * 用法（在仓库根目录）：
 *   node tools/wa-dom-probe.js
 *   node tools/wa-dom-probe.js --profile "<chrome配置目录>" --port 9333 --wait 20000
 *   node tools/wa-dom-probe.js --headed        # 用可见窗口跑（headless 读不到时用）
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

/** 老板的 WhatsApp 账号一号的独立 Chrome 配置（有真登录态） */
const DEFAULT_PROFILE = path.join(
  process.env.APPDATA || path.join('C:', 'Users', 'Administrator', 'AppData', 'Roaming'),
  'wa-assistant', 'sessions', 'chrome-acc-1'
);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headed') { o.headless = false; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) { o[k] = v; i++; } else { o[k] = true; }
    }
  }
  return o;
}

/** 找一个能用的 Chrome */
function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* 继续找 */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================================
 * 注入网页的只读探测脚本
 * 只做三件事：看有没有登录、看网页里现在有多少条消息、看能不能跟 Store 的 id 对上。
 * ========================================================================= */
function domProbeInPage() {
  const out = { ok: true, steps: {} };
  try {
    out.url = String(location.href);
    out.title = String(document.title);
    out.visibility = (typeof document.visibilityState === 'string') ? document.visibilityState : '';

    const q = (s, root) => { try { return (root || document).querySelectorAll(s).length; } catch (e) { return -1; } };

    /* ---- 1. 登录了吗（有没有二维码 / 有没有左侧会话列表）---- */
    const paneSide = q('#pane-side');
    const qrCanvas = q('[data-ref] canvas') + q('canvas[aria-label]');
    out.steps.login = {
      paneSide: paneSide,           // >0 = 已登录（左侧会话列表在）
      qrCanvas: qrCanvas,           // >0 = 还在扫码页
      loginText: /scan|二维码|link a device|扫码/i.test(String(document.body ? document.body.innerText : '').slice(0, 400)),
    };

    /* ---- 2. 网页里现在渲染了多少条消息（含三个候选选择器）---- */
    const main = document.querySelector('#main');
    out.steps.counts = {
      app: q('#app'),
      main: main ? 1 : 0,
      msgIn: q('#main .message-in'),                              // 官方样式：客户发来的
      msgOut: q('#main .message-out'),                            // 官方样式：我发出去的
      messageBoth: q('#main .message-in, #main .message-out'),
      roleRow: q('#main div[role="row"]'),
      anyDataId: q('#main [data-id]'),
      copyableText: q('#main .copyable-text'),
      selectableText: q('#main .selectable-text'),
    };

    /* ---- 3. 每条消息节点的「锚点」长什么样（前 6 条）---- */
    const nodes = Array.from(document.querySelectorAll('#main .message-in, #main .message-out'));
    out.steps.samples = nodes.slice(0, 6).map((el) => {
      const holder = el.closest('[data-id]') || el.querySelector('[data-id]') || el;
      return {
        dir: el.classList.contains('message-out') ? 'out' : 'in',
        tag: holder.tagName,
        dataId: String(holder.getAttribute && holder.getAttribute('data-id') || ''),
        prePlain: String(holder.getAttribute && holder.getAttribute('data-pre-plain-text') || '').slice(0, 50),
        hasText: !!el.querySelector('.selectable-text, .copyable-text'),
        text: String(el.innerText || '').replace(/\s+/g, ' ').slice(0, 46),
      };
    });

    /* ---- 4. 网页 DOM 里所有 [data-id] 的原样值（前 8 个，看 id 格式）---- */
    out.steps.dataIdSamples = Array.from(document.querySelectorAll('#main [data-id]'))
      .slice(0, 8).map((el) => String(el.getAttribute('data-id') || ''));

    /* ---- 5. 跟内部 Store 对账：库里每条消息 id，能不能在 DOM 里找到 ---- */
    let C = null;
    try { C = window.require('WAWebCollections'); } catch (e) { C = null; }
    if (!C) {
      out.steps.store = { available: false, reason: 'window.require(WAWebCollections) 拿不到' };
      out.steps.match = { available: false };
    } else {
      let models = [];
      try { models = C.Msg.getModelsArray() || []; } catch (e) { models = []; }
      const ser = (v) => {
        if (v == null) return '';
        if (typeof v === 'string') return v;
        try { return String(v._serialized || v.id || ''); } catch (e) { return ''; }
      };
      const storeIds = [];
      for (let i = models.length - 1; i >= 0 && storeIds.length < 50; i--) {
        const m = models[i];
        if (!m || !m.id) continue;
        const idObj = m.id;
        const mid = (typeof idObj === 'string') ? idObj : String(idObj.id || '');
        if (!mid) continue;
        const remote = (typeof idObj === 'string') ? '' : String(idObj.remote || '');
        storeIds.push({
          mid: mid,
          fromMe: typeof idObj === 'object' ? !!idObj.fromMe : null,
          remote: remote,
          full: `${(typeof idObj === 'object' && idObj.fromMe) ? 'true' : 'false'}_${remote}_${mid}`,
          t: Number(m.t || 0) || 0,
        });
      }

      /* 三种候选认法，逐个统计命中率 —— 哪个能中就用哪个 */
      const allDataIds = Array.from(document.querySelectorAll('#main [data-id]'))
        .map((el) => String(el.getAttribute('data-id') || ''));
      const bodyText = String(main ? main.innerText : '');

      let hitFull = 0, hitSuffix = 0, hitAnyInDoc = 0;
      const detail = [];
      for (const s of storeIds) {
        const byFull = !!document.querySelector(`#main [data-id="${s.full}"]`);
        const bySuffix = allDataIds.some((d) => d.endsWith(s.mid));
        const byDoc = !!document.querySelector(`[data-id$="${s.mid}"]`);
        if (byFull) hitFull++;
        if (bySuffix) hitSuffix++;
        if (byDoc) hitAnyInDoc++;
        if (detail.length < 8) detail.push({ mid: s.mid.slice(0, 22), full: s.full.slice(0, 60), byFull, bySuffix, byDoc });
      }

      out.steps.store = {
        available: true,
        total: models.length,
        takenForCheck: storeIds.length,
        newestTs: storeIds.length ? storeIds[0].t : 0,
      };
      out.steps.match = {
        available: true,
        checked: storeIds.length,
        byFullId: hitFull,
        bySuffixId: hitSuffix,
        byAnywhereInDoc: hitAnyInDoc,
        domDataIdCount: allDataIds.length,
        detail: detail,
      };
    }

    /* ---- 6. 顺便看一眼：每个消息节点外面套了几层（贴译文气泡要挂在哪一层）---- */
    if (nodes[0]) {
      const chain = [];
      let p = nodes[0];
      for (let i = 0; i < 5 && p; i++) {
        chain.push(`${p.tagName}.${String(p.className || '').split(' ').filter(Boolean).slice(0, 2).join('.')}`);
        p = p.parentElement;
      }
      // 消息行在页面里的定位方式（relative/absolute 决定气泡能不能贴着插）
      const holder = nodes[0].closest('[data-id]') || nodes[0];
      let cs = null;
      try { cs = getComputedStyle(holder); } catch (e) { cs = null; }
      out.steps.mount = {
        chain: chain,
        holderPosition: cs ? cs.position : '',
        holderDisplay: cs ? cs.display : '',
        parentPosition: holder.parentElement ? getComputedStyle(holder.parentElement).position : '',
      };
    }

    return out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* =========================================================================
 * 挑一个「本来就没有未读」的会话（🔴 只点这种，绝不碰未读，不破坏红点）
 * ========================================================================= */
function pickQuietRowInPage() {
  try {
    const SEL = '#pane-side [role="row"], #pane-side [data-testid="cell-frame-container"]';
    const rows = Array.from(document.querySelectorAll(SEL))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.height > 20 && r.width > 20; });
    if (!rows.length) return { ok: false, reason: '左侧会话列表里一个可点的行都没有', rows: 0 };

    /* 🔴 判定「有没有未读」以内部 Store 的 unreadCount 为准（不猜 DOM 徽标） */
    const unreadNames = new Set();
    let storeChats = 0;
    try {
      const C = window.require('WAWebCollections');
      const cs = (C && C.Chat && C.Chat.getModelsArray()) || [];
      storeChats = cs.length;
      cs.forEach((c) => {
        if (Number(c.unreadCount) > 0) {
          unreadNames.add(String(c.name || c.formattedTitle || '').trim());
        }
      });
    } catch (e) { /* 拿不到 Store 就退回只靠 DOM 徽标 */ }

    const list = rows.map((el, i) => {
      const txt = String(el.innerText || '').replace(/\s+/g, ' ').trim();
      const title = txt.split('\n')[0].trim();
      const r = el.getBoundingClientRect();
      const badge = el.querySelectorAll('[aria-label*="unread"], [aria-label*="未读"]').length;
      const unread = badge > 0 || (title && unreadNames.has(title));
      return {
        i, unread,
        name: title.slice(0, 22),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    });

    const quiet = list.filter((r) => !r.unread);
    return {
      ok: true,
      rows: rows.length,
      storeChats,
      unreadChatsInStore: unreadNames.size,
      domRows: list.length,
      picked: quiet.length ? quiet[0] : null,
      allRows: list.map((r) => `${r.unread ? '[未读]' : '[无未读]'} ${r.name}`),
    };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/** 点开之后再看一眼：这次开了哪个会话 */
function openStateInPage() {
  try {
    const main = document.querySelector('#main');
    if (!main) return { open: false };
    const head = main.querySelector('header');
    const q = (s) => { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
    return {
      open: true,
      who: String(head ? head.innerText : '').replace(/\s+/g, ' ').slice(0, 40),
      counts: {
        msgIn: q('#main .message-in'),
        msgOut: q('#main .message-out'),
        messageBoth: q('#main .message-in, #main .message-out'),
        anyDataId: q('#main [data-id]'),
        copyableText: q('#main .copyable-text'),
      },
    };
  } catch (e) {
    return { open: false, error: String((e && e.message) || e) };
  }
}

/** 把左侧会话列表的真实结构打出来（选择器不能靠猜） */
function dumpPaneInPage() {
  try {
    const root = document.querySelector('#pane-side') || document.querySelector('#side');
    if (!root) return { ok: false, reason: '连 #pane-side / #side 都没有' };
    const collect = (sel) => {
      try { return root.querySelectorAll(sel).length; } catch (e) { return -1; }
    };
    const roles = {};
    root.querySelectorAll('[role]').forEach((el) => {
      const r = String(el.getAttribute('role') || '');
      roles[r] = (roles[r] || 0) + 1;
    });
    const testids = {};
    root.querySelectorAll('[data-testid]').forEach((el) => {
      const t = String(el.getAttribute('data-testid') || '');
      testids[t] = (testids[t] || 0) + 1;
    });
    const ariaCount = {};
    root.querySelectorAll('[aria-label]').forEach((el) => {
      const a = String(el.getAttribute('aria-label') || '');
      const key = a.replace(/\d+/g, 'N').slice(0, 40);
      if (key) ariaCount[key] = (ariaCount[key] || 0) + 1;
    });
    /* 候选行容器：各种可能，看哪个真能命中 */
    const cands = {
      'div[role=listitem]': collect('div[role="listitem"]'),
      '[role=listitem]': collect('[role="listitem"]'),
      'div[role=row]': collect('div[role="row"]'),
      '[role=grid]': collect('[role="grid"]'),
      'div[aria-selected]': collect('div[aria-selected]'),
      '[data-testid=cell-frame-container]': collect('[data-testid="cell-frame-container"]'),
      'div[tabindex]': collect('div[tabindex]'),
      'li': collect('li'),
    };
    /* 取第一行看它长什么样 */
    let firstRow = null;
    const rowEl = root.querySelector('div[role="listitem"]')
      || root.querySelector('[role="listitem"]')
      || root.querySelector('div[role="row"]')
      || root.querySelector('div[aria-selected]');
    if (rowEl) {
      const r = rowEl.getBoundingClientRect();
      firstRow = {
        tag: rowEl.tagName,
        role: String(rowEl.getAttribute('role') || ''),
        cls: String(rowEl.className || '').slice(0, 90),
        ariaSelected: String(rowEl.getAttribute('aria-selected') || ''),
        ariaLabel: String(rowEl.getAttribute('aria-label') || '').slice(0, 60),
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
        text: String(rowEl.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
        unreadHits: rowEl.querySelectorAll('[aria-label*="unread"], [aria-label*="未读"]').length,
      };
    }
    return {
      ok: true,
      paneSideHtmlLen: root.outerHTML.length,
      roles, testids, cands, firstRow,
      ariaTop: Object.entries(ariaCount).sort((a, b) => b[1] - a[1]).slice(0, 12),
      unreadBadgeAnywhere: collect('[aria-label*="unread"]') + collect('[aria-label*="未读"]'),
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* =========================================================================
 * 深度探测：以 [data-id] 为锚点，验「认不认得到每条消息」+ 方向 + 虚拟化窗口
 * ========================================================================= */
function deepProbeInPage(stage) {
  try {
    const out = { stage: stage || '', ok: true };
    const main = document.querySelector('#main');
    if (!main) return { ok: false, reason: '#main 不存在（没有打开对话）' };

    /* ---- 消息节点：以 [data-id] 为准（官方类名 .message-in/.message-out 已废弃）---- */
    const holders = Array.from(main.querySelectorAll('[data-id]'));
    out.domMsgCount = holders.length;

    /* 找到真正能滚的那个容器 */
    let scroller = null;
    if (holders[0]) {
      let p = holders[0].parentElement;
      while (p && p !== main.parentElement) {
        if (p.scrollHeight > p.clientHeight + 8) { scroller = p; break; }
        p = p.parentElement;
      }
    }
    out.scroller = scroller ? {
      cls: String(scroller.className || '').slice(0, 60),
      scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: Math.round(scroller.scrollHeight),
      clientHeight: Math.round(scroller.clientHeight),
    } : null;

    /* ---- 逐条：id / 文本 / 几何位置（左还是右）/ 祖先链 ---- */
    const rows = holders.map((el, i) => {
      const r = el.getBoundingClientRect();
      const pre = el.getAttribute('data-pre-plain-text')
        || (el.closest('[data-pre-plain-text]') ? el.closest('[data-pre-plain-text]').getAttribute('data-pre-plain-text') : '')
        || '';
      return {
        i,
        mid: String(el.getAttribute('data-id') || ''),
        hasText: !!el.querySelector('.selectable-text, .copyable-text'),
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        prePlain: String(pre).slice(0, 60),
        cls: String(el.className || '').slice(0, 70),
        tag: el.tagName,
      };
    });
    out.rows = rows;
    out.rowsSample = rows.slice(0, 6);

    /* ---- 方向判定：① 几何（靠左=来件 靠右=去件）② 库里 Store 的 fromMe ---- */
    let C = null;
    try { C = window.require('WAWebCollections'); } catch (e) { C = null; }
    const byMid = {};
    let storeForChat = 0;
    if (C) {
      let models = [];
      try { models = C.Msg.getModelsArray() || []; } catch (e) { models = []; }
      storeForChat = models.length;
      models.forEach((m) => {
        if (!m || !m.id) return;
        const idObj = m.id;
        const mid = (typeof idObj === 'string') ? idObj : String(idObj.id || '');
        if (!mid) return;
        byMid[mid] = {
          fromMe: (typeof idObj === 'object') ? !!idObj.fromMe : null,
          remote: (typeof idObj === 'object') ? String(idObj.remote || '') : '',
          t: Number(m.t || 0) || 0,
          body: String(m.body || '').slice(0, 40),
        };
      });
    }
    out.storeMsgCount = storeForChat;

    /* 容器中心线（判断左右）*/
    const panel = scroller || main;
    const pr = panel.getBoundingClientRect();
    const centerX = pr.left + pr.width / 2;

    let geomIn = 0, geomOut = 0, agree = 0, checked = 0, mismatch = [];
    const merged = rows.map((row) => {
      const s = byMid[row.mid] || null;
      const geom = row.x + row.w / 2 < centerX ? 'in' : 'out';
      if (geom === 'in') geomIn++; else geomOut++;
      let storeDir = null;
      if (s && s.fromMe !== null) storeDir = s.fromMe ? 'out' : 'in';
      if (storeDir) {
        checked++;
        if (storeDir === geom) agree++;
        else if (mismatch.length < 5) mismatch.push({ mid: row.mid.slice(0, 20), geom, store: storeDir });
      }
      return { mid: row.mid.slice(0, 20), geom, store: storeDir, hasText: row.hasText, bodyLen: s ? s.body.length : -1 };
    });
    out.direction = {
      geomIn, geomOut,
      compared: checked,
      agree,
      agreeRate: checked ? `${agree}/${checked}` : 'n/a',
      mismatch,
    };
    out.perMessage = merged;

    /* ---- 命中率：DOM 的 data-id 能不能在 Store 里查到（反过来也查） ---- */
    let inStore = 0;
    rows.forEach((row) => { if (byMid[row.mid]) inStore++; });
    out.match = {
      domCount: rows.length,
      domFoundInStore: inStore,
      domNotInStore: rows.filter((r) => !byMid[r.mid]).map((r) => r.mid.slice(0, 20)),
      storeCount: storeForChat,
      storeNotInDom: Object.keys(byMid).filter((k) => !rows.some((r) => r.mid === k)).length,
    };
    return out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 滚动对话（只为量「网页一次渲染几条」，不改任何数据）dir: 'up' | 'bottom' */
function scrollChatInPage(dir) {
  try {
    const main = document.querySelector('#main');
    if (!main) return { ok: false };
    const h = main.querySelector('[data-id]');
    let p = h && h.parentElement;
    let s = null;
    while (p && p !== main.parentElement) {
      if (p.scrollHeight > p.clientHeight + 8) { s = p; break; }
      p = p.parentElement;
    }
    if (!s) return { ok: false, reason: '找不到可滚动的消息容器' };
    if (dir === 'bottom') s.scrollTop = s.scrollHeight;
    else s.scrollTop = Math.max(0, s.scrollTop - Math.round(s.clientHeight * 0.9));
    return {
      ok: true,
      scrollTop: Math.round(s.scrollTop),
      scrollHeight: Math.round(s.scrollHeight),
      clientHeight: Math.round(s.clientHeight),
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 钻进 [data-id] 容器内部：找真正的气泡节点 + 左右对齐 + 文字在哪个后代 */
function dumpRowInPage() {
  try {
    const main = document.querySelector('#main');
    if (!main) return { ok: false, reason: '#main 不存在' };
    const holders = Array.from(main.querySelectorAll('[data-id]'));
    if (!holders.length) return { ok: false, reason: '没有 [data-id] 节点' };

    /* 容器的中心线：用它判内部气泡是靠左还是靠右 */
    const box = holders[0].getBoundingClientRect();
    const centerX = box.left + box.width / 2;

    const brief = (el, depth) => {
      const r = el.getBoundingClientRect();
      return {
        d: depth,
        tag: el.tagName,
        cls: String(el.className || '').split(' ').filter(Boolean).slice(0, 3).join(' '),
        role: String(el.getAttribute('role') || ''),
        tid: String(el.getAttribute('data-testid') || ''),
        aria: String(el.getAttribute('aria-label') || '').slice(0, 40),
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        side: (r.width > 4 && r.left + r.width / 2 < centerX - 4) ? 'left'
          : (r.width > 4 && r.left + r.width / 2 > centerX + 4 ? 'right' : 'full'),
        text: String(el.innerText || '').replace(/\s+/g, ' ').slice(0, 34),
        childCount: el.children.length,
      };
    };

    /* 前 3 条 [data-id]，各往下钻 3 层，最多记 12 个节点 */
    const trees = [];
    for (let i = 0; i < Math.min(3, holders.length); i++) {
      const nodes = [brief(holders[i], 0)];
      const walk = (el, depth) => {
        if (depth > 3 || nodes.length > 12) return;
        for (const c of Array.from(el.children)) {
          if (nodes.length > 12) return;
          nodes.push(brief(c, depth));
          walk(c, depth + 1);
        }
      };
      walk(holders[i], 1);
      trees.push({
        rowIndex: i,
        mid: String(holders[i].getAttribute('data-id') || ''),
        nodes,
      });
    }

    /* 统计：所有 [data-id] 里，哪一层的节点会分成靠左 / 靠右 */
    const sideStats = {};
    holders.forEach((h) => {
      const kids = Array.from(h.querySelectorAll('*'));
      kids.forEach((k) => {
        const r = k.getBoundingClientRect();
        if (r.width < 20 || r.height < 8) return;
        const key = `${k.tagName}.${String(k.className || '').split(' ')[0] || '(无类名)'}`;
        if (!sideStats[key]) sideStats[key] = { left: 0, right: 0, full: 0, sample: String(k.getAttribute('data-testid') || '') };
        const c = r.left + r.width / 2;
        if (c < centerX - 8) sideStats[key].left++;
        else if (c > centerX + 8) sideStats[key].right++;
        else sideStats[key].full++;
      });
    });
    const discriminators = Object.entries(sideStats)
      .filter(([, v]) => v.left > 0 && v.right > 0)
      .map(([k, v]) => ({ sel: k, left: v.left, right: v.right, tid: v.sample }))
      .slice(0, 15);

    /* 找文本节点：哪个选择器能拿到消息正文 */
    const textSel = {
      '.selectable-text': main.querySelectorAll('.selectable-text').length,
      '.copyable-text': main.querySelectorAll('.copyable-text').length,
      '[data-pre-plain-text]': main.querySelectorAll('[data-pre-plain-text]').length,
      '[data-testid="msg-text"]': main.querySelectorAll('[data-testid="msg-text"]').length,
      'span[dir="ltr"]': main.querySelectorAll('span[dir="ltr"]').length,
      'span[dir="auto"]': main.querySelectorAll('span[dir="auto"]').length,
    };
    const textSamples = Array.from(main.querySelectorAll('[data-pre-plain-text]')).slice(0, 5)
      .map((el) => String(el.getAttribute('data-pre-plain-text') || '').slice(0, 60));

    return {
      ok: true, holderCount: holders.length,
      holderBox: { x: Math.round(box.left), w: Math.round(box.width), centerX: Math.round(centerX) },
      trees,
      discriminators,
      textSel,
      textSamples,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* =========================================================================
 * 气泡可插性实测（老板 2026-10-15 拍板：网页自己画对话，我们只叠中文气泡）
 *
 * 干什么：
 *   ① 把 #main 里所有 [data-id] 的**原样值**列出来 —— 要确认它到底是
 *      `true_<remote>_<id>`（带方向前缀）还是裸 `<id>`，这决定我们库里
 *      的 wa_msg_id 怎么跟它对上；
 *   ② 真往第一条消息里**插一个中文气泡**，量插入前后容器高度变化，
 *      **插完立刻删掉**（只验可行性，不留痕）。
 * ========================================================================= */
function bubbleFitInPage() {
  try {
    const main = document.querySelector('#main');
    if (!main) return { ok: false, reason: '#main 不存在（没打开任何对话）' };
    const holders = Array.from(main.querySelectorAll('[data-id]'));
    if (!holders.length) return { ok: false, reason: '没有 [data-id] 节点' };

    /* ---- ① 全部 data-id 原样值 + 形态分布 ---- */
    const ids = [];
    const seen = {};
    holders.forEach((h) => {
      const v = String(h.getAttribute('data-id') || '');
      if (v && !seen[v]) { seen[v] = 1; ids.push(v); }
    });
    const shape = { true_: 0, false_: 0, plain: 0, other: 0 };
    ids.forEach((v) => {
      if (/^true_/.test(v)) shape.true_++;
      else if (/^false_/.test(v)) shape.false_++;
      else if (/^[A-Za-z0-9]{6,}$/.test(v)) shape.plain++;
      else shape.other++;
    });

    /* ---- ② 每条消息容器的几何 + 正文在哪一层 ---- */
    const shapeList = holders.slice(0, 8).map((h) => {
      const r = h.getBoundingClientRect();
      const ct = h.querySelector('.copyable-text');
      const st = h.querySelector('.selectable-text');
      let depthOfText = -1;
      if (ct) { let d = 0, n = ct; while (n && n !== h && d < 30) { d++; n = n.parentElement; } depthOfText = d; }
      return {
        id: String(h.getAttribute('data-id') || ''),
        tag: h.tagName,
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        kids: h.children.length,
        copyable: !!ct,
        selectable: !!st,
        depthOfText: depthOfText,
      };
    });

    /* ---- ③ 视口内的第一条消息：内部两层结构（气泡到底贴哪） ----
     * 🔴 必须挑**视口内**的：WhatsApp 是虚拟列表，滚出视口的消息容器还在、
     *    但内容被回收（内层高度 0、innerText 空），拿它测等于测了个空壳。 */
    const vh = window.innerHeight || 800;
    const inView = holders.filter((h) => {
      const r = h.getBoundingClientRect();
      return r.height > 8 && r.bottom > 0 && r.top < vh;
    });
    const first = inView[0] || holders[0];
    const inner = [];
    (function walk(el, d) {
      if (d > 2 || inner.length > 16) return;
      for (const c of Array.from(el.children)) {
        if (inner.length > 16) return;
        const r = c.getBoundingClientRect();
        inner.push({
          d: d, tag: c.tagName,
          cls: String(c.className || '').split(' ').filter(Boolean).slice(0, 2).join(' '),
          tid: String(c.getAttribute('data-testid') || ''),
          x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height),
          kids: c.children.length,
          text: String(c.innerText || '').replace(/\s+/g, ' ').slice(0, 30),
        });
        walk(c, d + 1);
      }
    })(first, 1);

    /* ---- ④ 真插一个气泡，量完立刻删 ---- */
    const before = first.getBoundingClientRect();
    const beforeH = Math.round(before.height);

    const textEl = first.querySelector('.copyable-text') || first.querySelector('.selectable-text') || null;
    const probe = document.createElement('div');
    probe.id = '__bee_bubble_probe__';
    probe.style.cssText = 'margin:4px 2px 0;padding:3px 7px;font-size:12px;line-height:1.6;' +
      'color:#1f6aa5;font-weight:600;background:rgba(31,106,165,.08);border-radius:6px;' +
      'white-space:pre-wrap;word-break:break-word;';
    probe.textContent = '【蜜蜂测试气泡】这是一句中文译文';

    let insertTarget = '';
    let insertError = '';
    try {
      if (textEl && textEl.parentNode) { textEl.parentNode.appendChild(probe); insertTarget = 'copyable-text.parentNode'; }
      else { first.appendChild(probe); insertTarget = '[data-id] 本身'; }
    } catch (e) { insertError = String((e && e.message) || e); }

    const after = first.getBoundingClientRect();
    const pr = probe.getBoundingClientRect();
    const bubbleInfo = {
      insertTarget: insertTarget,
      insertError: insertError,
      textElFound: !!textEl,
      textElTag: textEl ? textEl.tagName : '',
      containerH: { before: beforeH, after: Math.round(after.height), delta: Math.round(after.height) - beforeH },
      probeBox: { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height) },
      visible: pr.width > 0 && pr.height > 0,
    };

    try { probe.parentNode.removeChild(probe); } catch (e) {}
    bubbleInfo.restoredH = Math.round(first.getBoundingClientRect().height);
    bubbleInfo.cleaned = !document.getElementById('__bee_bubble_probe__');

    return {
      ok: true,
      holderCount: holders.length,
      uniqueIds: ids.length,
      ids: ids.slice(0, 15),
      shape: shape,
      shapeList: shapeList,
      inner: inner,
      bubbleInfo: bubbleInfo,
      mainBox: { w: Math.round(main.getBoundingClientRect().width) },
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* =========================================================================
 * 极简 CDP 客户端（Node 22 自带 WebSocket，不需要 puppeteer）
 * ========================================================================= */
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    let id = 0;
    const pending = new Map();
    const api = {
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) { /* ignore */ } },
    };
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  });
}

async function httpJson(url, timeoutMs = 3000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/* =========================================================================
 * 主流程
 * ========================================================================= */
(async () => {
  const args = parseArgs(process.argv.slice(2));
  const chromePath = args.chrome || findChrome();
  const profile = args.profile || DEFAULT_PROFILE;
  const port = Number(args.port || 9333);
  const waitMs = Number(args.wait || 20000);
  const wantHeaded = args.headless === false || args.headed === true;

  const report = { at: new Date().toISOString(), chromePath, profile, port, headless: !wantHeaded };

  if (!chromePath) {
    report.fatal = '找不到 chrome.exe，请用 --chrome "<路径>" 指定';
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }
  if (!fs.existsSync(profile)) {
    report.fatal = `Chrome 配置目录不存在：${profile}`;
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

  const chromeArgs = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--user-agent=${UA}`,
    'about:blank',
  ];
  if (!wantHeaded) chromeArgs.unshift('--headless=new');

  report.args = chromeArgs.join(' ');
  const child = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: false });
  report.chromePid = child.pid;

  const cleanup = () => {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  };

  try {
    /* 等调试端口起来 */
    const base = `http://127.0.0.1:${port}`;
    let ver = null;
    for (let i = 0; i < 40; i++) {
      try { ver = await httpJson(`${base}/json/version`); break; } catch (e) { await sleep(500); }
    }
    if (!ver) throw new Error(`调试端口 ${port} 起不来（Chrome 可能启动失败或被占用）`);
    report.browser = ver.Browser;

    /* 自己开一张标签去 WhatsApp（不依赖 Chrome 的默认页） */
    let target = null;
    try {
      const r = await fetch(`${base}/json/new?${encodeURIComponent('https://web.whatsapp.com/')}`, { method: 'PUT' });
      target = await r.json();
    } catch (e) { target = null; }
    if (!target || !target.webSocketDebuggerUrl) {
      const list = await httpJson(`${base}/json/list`);
      target = (list || []).find((t) => t.type === 'page');
    }
    if (!target || !target.webSocketDebuggerUrl) throw new Error('拿不到可调试的页面');

    const cdp = await cdpConnect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    report.step1_navigate = '已打开 https://web.whatsapp.com/，等页面渲染…';
    await sleep(waitMs);

    /* 只读探测 */
    const expr = `(${domProbeInPage.toString()})()`;
    const res = await cdp.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res && res.exceptionDetails) {
      report.probeError = JSON.stringify(res.exceptionDetails).slice(0, 500);
    } else {
      report.probe = res && res.result ? res.result.value : null;
    }

    /* 再等一会儿，看 DOM 消息数会不会继续变（判断是不是虚拟化列表） */
    await sleep(4000);
    const res2 = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{const q=s=>{try{return document.querySelectorAll(s).length}catch(e){return -1}};return {msgIn:q('#main .message-in'),msgOut:q('#main .message-out'),dataId:q('#main [data-id]')};})()`,
      returnByValue: true,
    });
    report.probeAfter4s = res2 && res2.result ? res2.result.value : null;

    /* 可选：把左侧会话列表的真实结构打出来（选择器不能靠猜） */
    if (args.dump) {
      const d = await cdp.send('Runtime.evaluate', {
        expression: `(${dumpPaneInPage.toString()})()`, returnByValue: true,
      });
      report.paneDump = d && d.result ? d.result.value : null;
    }

    /* =====================================================================
     * 第二阶段：挑一个「本来就没有未读」的会话点开
     * 🔴 为什么必须点开：WhatsApp 网页默认不选中任何对话，#main 是空的，
     *    一条消息 DOM 都没有 —— 不点开就验不了「认不认得到每条消息」。
     * 🔴 为什么只点「没有未读红点」的那一个：这样老板的未读状态一个都不变。
     * ===================================================================== */
    if (!args['skip-click'] && !report.fatal) {
      const pickRes = await cdp.send('Runtime.evaluate', {
        expression: `(${pickQuietRowInPage.toString()})()`,
        returnByValue: true,
      });
      report.pickRow = pickRes && pickRes.result ? pickRes.result.value : null;
      const pick = report.pickRow || {};

      if (pick.ok && pick.picked) {
        const { x, y } = pick.picked;
        try {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        } catch (e) { /* 退回页内点击 */ }
        await sleep(5000);

        let opened = await cdp.send('Runtime.evaluate', {
          expression: `(${openStateInPage.toString()})()`, returnByValue: true,
        });
        report.afterClick = opened && opened.result ? opened.result.value : null;

        if (!report.afterClick || !report.afterClick.open) {
          await cdp.send('Runtime.evaluate', {
            expression: `(()=>{const SEL='#pane-side [role="listitem"], #pane-side div[role="row"], #pane-side div[aria-selected]';const rows=Array.from(document.querySelectorAll(SEL)).filter(e=>e.getBoundingClientRect().height>20);const q=rows.find(e=>!e.querySelector('[aria-label*="unread"], [aria-label*="未读"]'));if(q){q.click();return true}return false})()`,
            returnByValue: true,
          });
          await sleep(5000);
          opened = await cdp.send('Runtime.evaluate', {
            expression: `(${openStateInPage.toString()})()`, returnByValue: true,
          });
          report.afterClick2 = opened && opened.result ? opened.result.value : null;
        }

        /* 对话开了 → 重新对账（这才是老板要的那个结果） */
        const res3 = await cdp.send('Runtime.evaluate', {
          expression: `(${domProbeInPage.toString()})()`,
          returnByValue: true,
          awaitPromise: true,
        });
        report.probeWithChat = res3 && res3.result ? res3.result.value : null;

        /* ---- 深度探测：认不认得到 + 方向 + 网页一次渲染几条 ---- */
        if (args.deep) {
          const evalIn = async (expr) => {
            const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
            return r && r.result ? r.result.value : null;
          };
          const deep = [];
          deep.push(await evalIn(`(${deepProbeInPage.toString()})('刚打开')`));

          /* 往上滚 4 次，看网页会不会把更早的消息也渲染出来（量虚拟化窗口上限） */
          for (let k = 0; k < 4; k++) {
            const s = await evalIn(`(${scrollChatInPage.toString()})('up')`);
            await sleep(2500);
            const d = await evalIn(`(${deepProbeInPage.toString()})('往上滚第${k + 1}次')`);
            if (d) { d.scroll = s; deep.push(d); }
          }
          /* 回到底部 */
          const sb = await evalIn(`(${scrollChatInPage.toString()})('bottom')`);
          await sleep(2500);
          const db = await evalIn(`(${deepProbeInPage.toString()})('滚回底部')`);
          if (db) { db.scroll = sb; deep.push(db); }
          report.deep = deep;

          /* 钻一层：真正的气泡在哪、左右怎么分、文字在哪 */
          if (args.dump) {
            const t = await evalIn(`(${dumpRowInPage.toString()})()`);
            report.rowDump = t;
          }

          /* 最后一道：气泡插哪儿、插进去什么样（插完立刻删） */
          if (args.bubble) {
            report.bubble = await evalIn(`(${bubbleFitInPage.toString()})()`);
          }
        }
      } else {
        report.pickRowSkip = '左侧会话列表里没找到「没有未读」的会话，跳过点开（绝不碰未读）';
      }
    }

    cdp.close();
  } catch (e) {
    report.fatal = String((e && e.message) || e);
  } finally {
    cleanup();
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.fatal ? 1 : 0);
})();
