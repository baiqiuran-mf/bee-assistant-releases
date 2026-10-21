/* 蜜蜂采集 · 网页版 WhatsApp 抓图（content script）
 *
 * 职责（严格限定）：
 *   只抓「客户发来的图片」；自己发出的一律不碰。
 *   抓到后把图片字节（统一转成 dataURL）连同发送方昵称 POST 给本机软件：
 *   http://127.0.0.1:8787/api/wa-web/incoming-image
 *
 * 🔴 2026-10-09 重做「怎么认出是客户发的」（旧版彻底失败的根因）：
 *   旧版只认 `[data-id^="false_"]` 和 `.message-in` 两种判据。老板这台机器上的
 *   网页版 WhatsApp 已经全面改成混淆类名（`x1n2onr6` 这种），上面两条**一条都命中不了**，
 *   于是"客户消息 0 条" → 压根走不到抓图那一步（不是抓图代码的问题）。
 *   现在改成 **三重判据**，命中任一即可，全部失效还有几何兜底：
 *     ① 祖先带 data-id 且以 false_ 开头（false_=收到 / true_=自己发的）→ 最可靠
 *     ② 祖先 class 含 message-in / message-out
 *     ③ 几何：消息面板里【左边的=客户】【右边的=自己】——WhatsApp 布局恒定，不看类名。
 *        量的是外层"气泡"而非图片本身：全宽图片（style=width:100%）直接量会判成"居中、判不出"被漏抓，
 *        改成量气泡后，老板这张 1200×1600 全宽图也能正确识别为"客户发的"。
 *   自己发的（判成 out）一律不抓，这是老板的硬要求。
 *
 * 其它要点：
 *   - 抓的图可能是 <img src=blob:/data:/https:>，也可能挂在 div 的 background-image 上，都试。
 *   - blob: 优先用 fetch 取原字节（保原图画质）；失败再退 canvas 快照。
 *   - 头像 / 表情 / 链接预览图 必须排除，否则会把客户头像当图片发回。
 *   - 去重用【内容指纹】（昵称+图片数据），刷新页面、重复扫描都不会重复发回软件。
 *   - 全程打 F12 控制台日志（[蜜蜂抓图]），页面左下角有状态角标；
 *     弹窗里还有「调试报告」按钮 —— 不用开 F12 也能看到插件到底看到了什么。
 */

const PROCESSED = new Set();   // 本次会话内已成功发回的消息标识
const SENT_HASH = new Set();   // 已发回的内容指纹（跨刷新，持久化）
const INFLIGHT = new Set();    // 正在处理中
const ATTEMPTS = new Map();    // 尝试次数（防死循环）
const SEEN_EL = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;  // 处理过的元素（含"判定为自己发的"）
let CFG = { port: 8787, token: '', accountId: 1 };

const STATS = {
  captured: 0, lastAt: 0, lastError: '', chat: '',
  imgs: 0,        // 面板里 <img> 总数
  incoming: 0,    // 判定为"客户发来的"的图片数
  outgoing: 0,    // 判定为"自己发的"（不抓）
  unknown: 0,     // 判不出来的（几何也失效时）
  panel: '',      // 命中的消息面板选择器
};

// 测试环境下用更小的步长，加速单测；浏览器里仍用真实步长
const FAST = (typeof process !== 'undefined' && process.env && process.env.WAWEB_FAST) === '1';
const STEP = FAST ? 10 : 400;            // 轮询间隔
const MAX_TRIES = FAST ? 20 : 16;        // 自动监听：单条消息最多轮询次数
const SCAN_TRIES = FAST ? 20 : 4;        // 手动扫描：历史图已渲染，短等待即可
const MIN_IMG_CHARS = 2000;              // 低于此长度的 dataURL 视为占位图
const MIN_NATURAL = 110;                 // 原图短边 ≥ 此值才算真图片（挡掉表情/图标）
const SENT_KEEP = 3000;

/* ---------------- 基础工具 ---------------- */

function log(...a) { try { console.log('[蜜蜂抓图]', ...a); } catch (e) {} }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 内容指纹（FNV-1a）：用于跨刷新去重，同样的图只发一次 */
function fnv(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  const n = Math.min(s.length, 2 * 1024 * 1024);
  for (let i = 0; i < n; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(36) + '_' + n.toString(36);
}

function attr(el, name) {
  try { return (el && el.getAttribute && el.getAttribute(name)) || ''; } catch (e) { return ''; }
}
function clsOf(el) {
  try { return typeof el.className === 'string' ? el.className : ''; } catch (e) { return ''; }
}
function closestSafe(el, sel) {
  try { return (el && el.closest) ? el.closest(sel) : null; } catch (e) { return null; }
}

/* ---------------- 页面角标（可见反馈） ---------------- */

let BADGE = null;
function updateBadge(text) {
  if (typeof document === 'undefined' || !document.body || !document.createElement) return;
  try {
    if (!BADGE) {
      BADGE = document.createElement('div');
      BADGE.id = 'bee-waweb-badge';
      const s = BADGE.style;
      s.position = 'fixed'; s.left = '10px'; s.bottom = '10px'; s.zIndex = '2147483000';
      s.background = 'rgba(18,22,26,.9)'; s.color = '#8ff0b8';
      s.font = '12px/1.6 "Microsoft YaHei",sans-serif';
      s.padding = '6px 10px'; s.borderRadius = '8px';
      s.boxShadow = '0 2px 10px rgba(0,0,0,.4)';
      s.cursor = 'pointer'; s.userSelect = 'none'; s.maxWidth = '320px';
      s.border = '1px solid rgba(143,240,184,.35)';
      BADGE.title = '点我：立即扫描当前对话里客户发来的图片';
      BADGE.addEventListener('click', () => { updateBadge('🔄 正在扫描当前对话…'); scanNow(true); });
      document.body.appendChild(BADGE);
    }
    if (text == null) text = `🐝 蜜蜂抓图 · 客户图 ${STATS.incoming} · 已发 ${STATS.captured}`;
    BADGE.textContent = text;
  } catch (e) { /* 角标失败不影响抓图 */ }
}

function saveStats() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        wawebStats: {
          captured: STATS.captured, lastAt: STATS.lastAt, lastError: STATS.lastError,
          chat: STATS.chat, imgs: STATS.imgs, incoming: STATS.incoming,
          outgoing: STATS.outgoing, unknown: STATS.unknown, panel: STATS.panel,
          tokenOk: !!CFG.token, at: Date.now(),
        },
      });
    }
  } catch (e) {}
}

/* ---------------- 持久去重（按内容指纹） ---------------- */

function loadSent(cb) {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return cb && cb();
    chrome.storage.local.get(['wawebSent', 'wawebStats'], (v) => {
      if (v && Array.isArray(v.wawebSent)) SENT_HASH.clear(), v.wawebSent.forEach((x) => SENT_HASH.add(x));
      if (v && v.wawebStats && Number(v.wawebStats.captured)) STATS.captured = Number(v.wawebStats.captured) || 0;
      cb && cb();
    });
  } catch (e) { cb && cb(); }
}
function markSent(key) {
  if (!key) return;
  PROCESSED.add(key);
  if (SENT_HASH.has(key)) return;
  SENT_HASH.add(key);
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const arr = Array.from(SENT_HASH);
      chrome.storage.local.set({ wawebSent: arr.slice(Math.max(0, arr.length - SENT_KEEP)) });
    }
  } catch (e) {}
}
function alreadySent(key) { return !!key && (SENT_HASH.has(key) || PROCESSED.has(key)); }

/* ---------------- 网络 ---------------- */

function waitForEl(sel, cb, tries = 60) {
  if (typeof document === 'undefined') return;
  const el = document.querySelector(sel);
  if (el) return cb(el);
  if (tries <= 0) return;
  setTimeout(() => waitForEl(sel, cb, tries - 1), 500);
}

function getChatName() {
  const el = document.querySelector('[data-testid="conversation-info-header-chat-title"]')
    || document.querySelector('[data-testid="conversation-info-header"] span[title]')
    || document.querySelector('#main header span[title]')
    || document.querySelector('header span[title]')
    || document.querySelector('[data-testid="conversation-info-header"]');
  const t = el ? (attr(el, 'title') || el.textContent || '').trim() : '';
  return (t || '客户').slice(0, 60);
}

/** 把任意图片 src 转成 dataURL（data:/blob:/https: 都试） */
async function urlToDataUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('data:')) return url;
  try {
    const resp = await fetch(url);
    if (!resp.ok) { log('⚠️ 图片源响应异常：HTTP', resp.status); return null; }
    const blob = await resp.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch (e) {
    log('⚠️ 无法 fetch 该图片源（可能是跨域限制）：', (e && e.message) || e);
    return null;
  }
}

/** 元素 → dataURL：先取 src/背景图走 fetch，失败再用 canvas 兜底（blob: 图适用） */
async function elToDataUrl(el) {
  const src = attr(el, 'src') || (el && el.src) || '';
  const style = attr(el, 'style') || '';
  const bg = /background-image\s*:\s*url\((["']?)([^"')]+)\1\)/.exec(style);
  const url = src || (bg ? bg[2] : '');
  if (url) {
    const d = await urlToDataUrl(url);
    if (d && typeof d === 'string' && d.startsWith('data:')) return d;
  }
  // canvas 兜底：<img> 已解码就直接画到画布，再 toBlob → FileReader 转 dataURL（比 toDataURL 更稳，超大图也不崩）
  try {
    if (el && el.tagName === 'IMG' && el.naturalWidth
      && typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = el.naturalWidth; c.height = el.naturalHeight;
      c.getContext('2d').drawImage(el, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      if (blob) {
        const d2 = await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => resolve(null);
          fr.readAsDataURL(blob);
        });
        if (d2 && String(d2).startsWith('data:')) return d2;
      }
    }
  } catch (e) {
    log('⚠️ canvas 兜底失败（图片受跨域保护）：', (e && e.message) || e);
  }
  return null;
}

/** 把图发回软件 */
async function postImageData(key, dataUrl, name) {
  const payload = {
    accountId: CFG.accountId,
    sender: { name },
    image: dataUrl,
    caption: '',
    ts: Math.floor(Date.now() / 1000),
    waId: key,
  };
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CFG.port}/api/wa-web/incoming-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-waweb-token': CFG.token },
        body: JSON.stringify(payload),
      });
      if (r.ok) { log(`✅ 已把图片发回软件（客户：${name}）`); return true; }
      if (r.status === 401) { log('❌ 令牌无效：请到软件「设置 → 网页插件」复制最新令牌，粘进插件弹窗'); STATS.lastError = '令牌无效'; saveStats(); return false; }
      if (r.status === 400) {
        const j = await r.json().catch(() => ({}));
        log('⚠️ 软件拒绝：', j.error); STATS.lastError = '软件拒绝：' + (j.error || ''); saveStats(); return false;
      }
      log(`⚠️ 软件返回 ${r.status}，重试 ${i + 1}/3`);
    } catch (e) {
      log(`⚠️ 发送失败（${e.message}），重试 ${i + 1}/3`);
      STATS.lastError = '发送失败：' + (e.message || e); saveStats();
    }
    await sleep(FAST ? 10 : 1200);
  }
  return false;
}

/* ---------------- ★ 方向判定：这条图是不是客户发来的 ---------------- */

/** 沿祖先找 data-id / message-in / message-out；返回 'in' | 'out' | '' */
function directionByAncestor(el) {
  let n = el, depth = 0;
  while (n && n.nodeType === 1 && depth < 16) {
    const id = attr(n, 'data-id');
    if (id) {
      if (/^false_/.test(id)) return 'in';
      if (/^true_/.test(id)) return 'out';
    }
    const cls = clsOf(n);
    if (cls) {
      if (/(^|\s)message-in(\s|$)/.test(cls)) return 'in';
      if (/(^|\s)message-out(\s|$)/.test(cls)) return 'out';
    }
    n = n.parentElement; depth++;
  }
  return '';
}

/** 沿祖先找一个"比面板明显窄"的容器（=消息气泡）。
 *  全宽图片（width:100%）直接量图片会落在正中间被判"居中、判不出"，
 *  必须量它的外层气泡——气泡靠左/靠右才是真正的方向信号。 */
function bubbleRect(el, panelRect) {
  try {
    let n = el && el.parentElement;
    while (n && n.nodeType === 1) {
      const r = n.getBoundingClientRect && n.getBoundingClientRect();
      if (r && r.width && panelRect && panelRect.width && r.width < panelRect.width * 0.95) return r;
      n = n.parentElement;
    }
  } catch (e) {}
  return null;
}

/** 几何兜底：气泡【靠左=客户】【靠右=自己】——WhatsApp 布局恒定，不看任何类名 */
function directionByGeometry(el, panelRect) {
  try {
    if (!panelRect || !panelRect.width) return '';
    // 优先量"气泡"；全宽图片靠量图片本身会判成居中，必须量外层气泡
    const r = bubbleRect(el, panelRect) || (el.getBoundingClientRect && el.getBoundingClientRect());
    if (!r || !r.width) return '';
    const leftGap = r.left - panelRect.left;
    const rightGap = panelRect.right - r.right;
    if (Math.abs(leftGap - rightGap) < 24) return '';   // 太居中，判不准 → 不下结论
    return leftGap < rightGap ? 'in' : 'out';
  } catch (e) { return ''; }
}

/**
 * 综合判定：先祖先判据（最可靠），再用几何兜底。
 * @returns 'in' | 'out' | ''
 */
function directionOf(el, panelRect) {
  const byAnc = directionByAncestor(el);
  if (byAnc) return byAnc;
  return directionByGeometry(el, panelRect);
}

/* ---------------- 消息面板 / 候选图片 ---------------- */

/** 找到"消息列表"容器（按可靠性排序，找到就用） */
function panelEl() {
  if (typeof document === 'undefined') return null;
  const cands = [
    '[data-testid="conversation-panel-messages"]',
    '#main .copyable-area',
    '#main [role="application"]',
    '#main',
  ];
  for (const sel of cands) {
    const el = document.querySelector(sel);
    if (el) { STATS.panel = sel; return el; }
  }
  STATS.panel = '';
  return null;
}

/** 头像 / 表情 / 图标 判定（这些绝不能当客户图片发回） */
function isJunkImg(img) {
  try {
    if (closestSafe(img, '[data-testid*="avatar"],[data-testid*="default-user"],[class*="avatar"],[class*="Avatar"]')) return true;
    if (closestSafe(img, 'header,[data-testid*="conversation-info-header"]')) return true;
    // 链接预览图 / 引用消息里的缩略图：不是客户主动发的照片
    if (closestSafe(img, '[data-testid*="link-preview"],[data-testid*="quoted-message"]')) return true;
  } catch (e) { /* 继续用尺寸兜底 */ }
  const src = String((img.currentSrc || img.src || ''));
  if (/\/avatar\//i.test(src) || /pps\.whatsapp\.net/i.test(src)) return true;   // 头像 CDN
  return false;
}

/** 收集面板里"像是客户发的照片"的图片元素 → [{ img, dir }] */
function collectCandidates() {
  const panel = panelEl();
  const out = [];
  if (!panel || !panel.querySelectorAll) return { list: out, panel: null };
  const pr = (panel.getBoundingClientRect && panel.getBoundingClientRect()) || null;
  let imgs = [];
  try { imgs = Array.from(panel.querySelectorAll('img')); } catch (e) { imgs = []; }
  STATS.imgs = imgs.length;
  let inc = 0, outc = 0, unk = 0;
  for (const img of imgs) {
    try {
      if (!img) continue;
      if (isJunkImg(img)) continue;
      if (SEEN_EL && SEEN_EL.has(img)) continue;
      const r = (img.getBoundingClientRect && img.getBoundingClientRect()) || null;
      // 尺寸过滤：头像 49px / 表情 ~26px 全都挡在门外
      if (r && r.width && (r.width < 48 || r.height < 48)) continue;
      const src = img.currentSrc || img.src || attr(img, 'src') || '';
      if (!src) continue;
      const dir = directionOf(img, pr);
      if (dir === 'in') inc++;
      else if (dir === 'out') outc++;
      else unk++;
      out.push({ img, dir });
    } catch (e) { /* 单个元素出错不影响整体 */ }
  }
  STATS.incoming = inc; STATS.outgoing = outc; STATS.unknown = unk;
  return { list: out, panel };
}

/** 从元素反查一个稳定的消息标识（data-id 优先，其次 blob 地址） */
function ancestorKey(el) {
  let n = el, depth = 0;
  while (n && n.nodeType === 1 && depth < 16) {
    const id = attr(n, 'data-id');
    if (id) return id;
    n = n.parentElement; depth++;
  }
  return '';
}

/* ---------------- 抓一条图片 ---------------- */

/**
 * 抓取单个 <img>（已判定为 in 才会被调用）。
 * @returns 'sent' | 'noimg' | 'postfail' | 'skip'
 */
async function captureImg(img, opts) {
  const o = opts || {};
  if (!img) return 'noimg';
  if (SEEN_EL && SEEN_EL.has(img)) return 'skip';

  const name = getChatName();
  STATS.chat = name;
  const key0 = ancestorKey(img) || ('src:' + fnv(img.currentSrc || img.src || ''));
  if (key0 && alreadySent(key0)) return 'skip';

  const tries = Number(o.maxTries) || MAX_TRIES;
  let result = 'noimg';
  for (let attempt = 0; attempt < tries; attempt++) {
    const dataUrl = await elToDataUrl(img);
    if (dataUrl && dataUrl.startsWith('data:')) {
      const natW = img.naturalWidth || 0;
      const natH = img.naturalHeight || 0;
      const realBySize = natW >= MIN_NATURAL && natH >= MIN_NATURAL;
      const realByLen = dataUrl.length >= MIN_IMG_CHARS;
      if (!realBySize && !realByLen) {
        if (o.verbose) log(`⏳ 疑似占位图（${dataUrl.length} 字符 / ${natW}×${natH}），再等等…`);
      } else {
        // 🔴 内容指纹：昵称 + 图片数据 → 同一张图（哪怕刷新页面换了 blob 地址）只发一次
        const fp = 'h:' + fnv(name + '|' + dataUrl);
        if (alreadySent(fp) || alreadySent(key0)) { result = 'skip'; break; }
        if (o.verbose) log(`📦 拿到图片数据（${dataUrl.length} 字符），发送中…`);
        if (await postImageData(key0 || fp, dataUrl, name)) {
          markSent(fp); if (key0) markSent(key0);
          if (SEEN_EL) SEEN_EL.add(img);
          result = 'sent';
          break;
        }
        result = 'postfail';
        break;
      }
    } else if (o.verbose && attempt === 0) {
      log('⚠️ 该图暂取不到数据（可能还在解密/懒加载），继续等…');
    }
    await sleep(STEP);
  }
  return result;
}

/** 兼容旧入口：抓"一条消息行"里的图（保留给单测与 MutationObserver） */
async function captureMessage(msgEl, opts) {
  if (!msgEl) return 'noid';
  const rid = rowId(msgEl);          // 行级标识（data-id / 兜底），用于"已处理"记账与去重
  const els = pickMediaEls(msgEl);
  if (!els.length) return 'noimg';
  let last = 'noimg';
  for (const el of els) {
    const r = await captureImg(el, opts);
    if (r === 'sent') { if (rid) markSent(rid); return 'sent'; }
    if (r === 'skip') return 'skip'; // 该图已发过 → 整条消息视为已处理（防重复发回软件）
    if (r === 'postfail') last = 'postfail';
  }
  return last;
}

/* ---------------- 行 / 元素识别（兼容旧导出） ---------------- */

function isIncomingRow(row) {
  if (!row || row.nodeType !== 1) return false;
  const cls = clsOf(row);
  if (cls && /(^|\s)message-in(\s|$)/.test(cls)) return true;
  const id = attr(row, 'data-id');
  return /^false_/.test(id);
}

function isIncoming(node) {
  if (!node || node.nodeType !== 1) return false;
  try { if (node.matches && node.matches('[data-id][class*="message-in"]')) return true; } catch (e) {}
  return isIncomingRow(node);
}

let FALLBACK_SEQ = 0;
const FALLBACK_IDS = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
function rowId(row) {
  const id = attr(row, 'data-id');
  if (id) return id;
  if (!row || !FALLBACK_IDS) return '';
  if (!FALLBACK_IDS.has(row)) FALLBACK_IDS.set(row, 'row#' + (++FALLBACK_SEQ));
  return FALLBACK_IDS.get(row);
}

function allRows(root, rows) {
  const out = rows || [];
  if (!root || !root.querySelectorAll) return out;
  const push = (el) => { if (el && !out.includes(el)) out.push(el); };
  try {
    root.querySelectorAll('[data-id]').forEach((el) => {
      if (/^(true|false)_/.test(attr(el, 'data-id'))) push(el);
    });
  } catch (e) {}
  try { root.querySelectorAll('.message-in').forEach(push); } catch (e) {}
  return out;
}

function pickMediaEls(row) {
  const out = [];
  const push = (el) => { if (el && !out.includes(el)) out.push(el); };
  if (!row || !row.querySelectorAll) return out;
  try {
    row.querySelectorAll('[data-testid="image-thumb"] img,[data-testid="media-image"] img,'
      + '[data-testid="image-thumb"],[data-testid="media-image"]').forEach((el) => { if (!isJunkImg(el)) push(el); });
  } catch (e) {}
  try {
    row.querySelectorAll('img').forEach((el) => { if (!isJunkImg(el)) push(el); });
  } catch (e) {}
  try {
    row.querySelectorAll('*[style*="background-image"]').forEach((el) => { if (!isJunkImg(el)) push(el); });
  } catch (e) {}
  return out;
}

function onMutations(muts) {
  let touched = false;
  for (const m of muts) {
    // 图片 src 被替换（占位 → 真图）时，重新尝试抓该消息
    if (m.type === 'attributes' && m.attributeName === 'src') {
      const row = m.target && m.target.closest && m.target.closest('[data-id]');
      if (row && isIncomingRow(row)) captureMessage(row);
      touched = true;
      continue;
    }
    if (!m.addedNodes) continue;
    touched = true;
    m.addedNodes.forEach((n) => {
      if (!n || n.nodeType !== 1) return;
      if (n.tagName === 'IMG') captureImg(n);
      else if (isIncomingRow(n)) captureMessage(n);
      else if (n.querySelectorAll) {
        n.querySelectorAll('[data-id]').forEach((r) => { if (isIncomingRow(r)) captureMessage(r); });
      }
    });
  }
  // 任何 DOM 变化都安排一次"面板全扫"（兜住所有认不出来的新版结构）
  if (touched) scheduleScan(700);
}

/* ---------------- 面板全扫（新版结构的主力） ---------------- */

let scanTimer = null;
let scanning = false;
function scheduleScan(delay) {
  if (scanTimer) return;
  scanTimer = setTimeout(() => { scanTimer = null; scanPanel(false); }, delay || 700);
}

async function scanPanel(verbose) {
  if (scanning) return { ok: false, busy: true };
  scanning = true;
  let sent = 0, incoming = 0, outgoing = 0;
  try {
    const { list } = collectCandidates();
    for (const c of list) {
      if (SEEN_EL && SEEN_EL.has(c.img)) continue;
      if (c.dir === 'out') { if (SEEN_EL) SEEN_EL.add(c.img); outgoing++; continue; }
      if (c.dir !== 'in') continue;             // 判不出来的不动手（宁可漏，不可把"我自己发的"发出去）
      incoming++;
      const t0 = Date.now();
      const r = await captureImg(c.img, { maxTries: verbose ? SCAN_TRIES : 2, verbose: !!verbose });
      if (r === 'sent') sent++;
      if (!verbose && Date.now() - t0 > 4000) break;   // 后台扫别拖太久
    }
  } finally { scanning = false; }
  if (verbose) log(`🧹 扫描完成：客户图 ${incoming} 张（自己发的 ${outgoing} 张已跳过），本轮新发回 ${sent} 张`);
  updateBadge(sent ? `✅ 扫描完成：新发回 ${sent} 张` : `✅ 扫描完成：没有新图片（客户图 ${incoming} 张）`);
  setTimeout(() => { if (BADGE) updateBadge(null); }, 5000);
  saveStats();
  return { ok: true, incoming, outgoing, sent, captured: STATS.captured };
}

async function scanNow(verbose) {
  // 旧的行扫描（data-id/message-in 结构还在的版本更精准）
  if (typeof document !== 'undefined') {
    try {
      const rows = allRows(document).filter(isIncomingRow);
      for (const r of rows) {
        if (!SEEN_EL || !SEEN_EL.has(r)) {
          const res = await captureMessage(r, { maxTries: verbose ? SCAN_TRIES : 1, verbose: !!verbose });
          if (res === 'sent') STATS.lastAt = Date.now();
        }
      }
    } catch (e) {}
  }
  return scanPanel(verbose);
}

/* ---------------- 诊断 ---------------- */

let lastDiag = '';
function diagnose() {
  if (typeof document === 'undefined') return;
  try {
    collectCandidates();
    STATS.chat = getChatName();
    const msg = `面板(${STATS.panel || '未找到'}) 图片 ${STATS.imgs} 张`
      + `｜判定为客户 ${STATS.incoming}｜自己 ${STATS.outgoing}｜判不出 ${STATS.unknown}`;
    if (msg !== lastDiag) { lastDiag = msg; log('🔎 ' + msg); }
    saveStats();
    updateBadge(null);
  } catch (e) {}
}

/** 给弹窗用的"调试报告"：把插件到底看到了什么讲清楚 */
function debugReport() {
  const lines = [];
  try {
    const panel = panelEl();
    lines.push('扩展版本：' + (CFG.version || '?'));
    lines.push('软件端口：' + CFG.port + '｜令牌：' + (CFG.token ? '已填(' + CFG.token.slice(0, 6) + '…)' : '❌ 空'));
    lines.push('页面：' + (typeof location !== 'undefined' ? location.href.slice(0, 60) : ''));
    lines.push('消息面板：' + (STATS.panel || '❌ 未找到'));
    if (!panel || !panel.querySelectorAll) { lines.push('→ 找不到消息面板，请先打开一个对话'); return lines.join('\n'); }
    const imgs = Array.from(panel.querySelectorAll('img'));
    lines.push('面板内 <img> 总数：' + imgs.length);
    lines.push('判定：客户 ' + STATS.incoming + ' 张｜自己 ' + STATS.outgoing + ' 张｜判不出 ' + STATS.unknown + ' 张');
    if (SENT_HASH.size) lines.push('已发回软件：' + STATS.captured + ' 张（去重库 ' + SENT_HASH.size + ' 条）');
    if (STATS.lastError) lines.push('最近错误：' + STATS.lastError);
    lines.push('— 前 6 张图的判定依据 —');
    const pr = panel.getBoundingClientRect ? panel.getBoundingClientRect() : null;
    imgs.slice(0, 6).forEach((img, i) => {
      const anc = directionByAncestor(img);
      const geo = directionByGeometry(img, pr);
      const r = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
      const src = String(img.currentSrc || img.src || '').slice(0, 40);
      lines.push(`#${i + 1} ${Math.round(r ? r.width : 0)}×${Math.round(r ? r.height : 0)}`
        + ` 祖先判据=${anc || '无'} 几何=${geo || '无'}`
        + ` junk=${isJunkImg(img) ? 'Y' : 'N'}`
        + ` src=${src || '(空)'}`);
    });
  } catch (e) { lines.push('生成报告出错：' + ((e && e.message) || e)); }
  return lines.join('\n');
}

/* ---------------- 连通性自检 ---------------- */

async function selfCheck() {
  try {
    const r = await fetch(`http://127.0.0.1:${CFG.port}/api/wa-web/token`, { method: 'GET' });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      if (j.port) CFG.port = j.port;
      log(`✅ 已连上软件（端口 ${CFG.port}），令牌${j.token ? '已配置' : '为空——请到软件「设置 → 网页插件」复制'}`);
      return true;
    }
    log(`⚠️ 软件返回 HTTP ${r.status}，请确认软件版本 ≥ 1.5.1013`);
  } catch (e) {
    log(`❌ 连不上软件（http://127.0.0.1:${CFG.port}）：${e.message}。请确认软件已启动、且端口与设置页一致`);
  }
  return false;
}

/* ---------------- 启动 ---------------- */

function attach(root) {
  if (!root) return;
  log('👀 开始监听消息（整个页面：子节点 + src 属性变化 + 定时兜底扫描）');
  const obs = new MutationObserver(onMutations);
  obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  // 冷启动补扫（页面在插件之前就打开的，历史图靠这次捞回来）
  setTimeout(() => scanPanel(false), 1200);
  setTimeout(() => scanPanel(false), 4000);
  // 定时兜底：MutationObserver 有盲区（切对话重建 DOM / 懒加载 / 虚拟列表），每 10 秒补一次
  setInterval(() => scanPanel(false), 10000);
}

function start() {
  log('🔌 网页版 WhatsApp 抓图插件已加载 v' + (CFG.version || '?'));
  loadSent(() => {
    if (typeof document !== 'undefined' && document.body) attach(document.body);
    else waitForEl('body', () => attach(document.body), 30);
  });
  selfCheck();
  diagnose();
  setInterval(diagnose, 12000);
}

// ---------- 浏览器环境启动 ----------
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  try { CFG.version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || ''; } catch (e) {}
  chrome.storage.local.get(['port', 'token', 'accountId'], (v) => {
    if (v && v.port) CFG.port = v.port;
    if (v && v.token) CFG.token = v.token;
    if (v && v.accountId) CFG.accountId = v.accountId;
    start();
  });
  try {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg && msg.type === 'scanNow') { scanNow(true).then((r) => reply(r)); return true; }
      if (msg && msg.type === 'stats') { reply({ ok: true, online: true, ...STATS, captured: STATS.captured }); return true; }
      if (msg && msg.type === 'debug') { reply({ ok: true, report: debugReport() }); return true; }
      return false;
    });
  } catch (e) {}
} else if (typeof document !== 'undefined') {
  start();
}

// ---- 单测导出（浏览器里 module 不存在，不影响运行）----
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    captureMessage, captureImg, onMutations, isIncoming, isIncomingRow, allRows, pickMediaEls,
    elToDataUrl, urlToDataUrl, postImageData, selfCheck, scanNow, scanPanel, diagnose, debugReport,
    directionOf, directionByAncestor, directionByGeometry, collectCandidates, panelEl, isJunkImg, fnv,
    MIN_IMG_CHARS, MIN_NATURAL,
    _setCFG: (c) => Object.assign(CFG, c),
    _reset: () => {
      PROCESSED.clear(); INFLIGHT.clear(); ATTEMPTS.clear(); SENT_HASH.clear();
      STATS.captured = 0; STATS.lastError = '';
      if (SEEN_EL && SEEN_EL.clear) SEEN_EL.clear();
    },
    _state: () => ({
      processed: [...PROCESSED], inflight: [...INFLIGHT], attempts: [...ATTEMPTS.keys()],
      sent: [...SENT_HASH], stats: { ...STATS },
    }),
  };
}
