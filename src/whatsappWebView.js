/* =====================================================================
 * v2.6.1094「WA①」页签 —— WhatsApp 内置浏览器的只读跳转
 * ---------------------------------------------------------------------
 * 用途：WA① 资料卡上那个「↗ 跳到聊天」按钮 —— 把内置浏览器**打开**某个客户的对话
 *       并滚到最新。
 *
 * 🔴 铁律（本文件唯一职责，做完就收手）：
 *   **只读、只导航页面，绝不发送任何消息、绝不点任何发送按钮。**
 *   跟 src/telegramWebView.js 里那套 Telegram 采集/预填代码**完全分开**，
 *   两个模块互不调用、互不影响 —— 改 WA 不会碰 Telegram，改 Telegram 不会碰 WA。
 *
 * 🔴 为什么单独建文件、不复用 telegramWebView.js：
 *   老板 2026-10-12 定的铁律「不同功能各归各的文件与函数，不要代码放一块」。
 *   WhatsApp 走的是 web.whatsapp.com，Telegram 走 web.telegram.org，
 *   页面结构、路由、会话定位方式**全都不一样**，硬塞进一个文件就是埋雷。
 * ===================================================================== */

const WA_URL_HINTS = ['web.whatsapp.com', 'wa.me'];

/** 这个 webContents 看起来像不像 WhatsApp 网页 */
function looksLikeWhatsapp(w) {
  try {
    const u = String((w && w.getURL && w.getURL()) || '').toLowerCase();
    if (!u) return false;
    return WA_URL_HINTS.some((h) => u.includes(h));
  } catch (_) { return false; }
}

/** 取 Electron 的 webContents 模块；纯 Node（跑测试）里返回 null */
function electronWebContents() {
  try {
    const e = require('electron');
    if (e && typeof e === 'object' && e.webContents && typeof e.webContents.getAllWebContents === 'function') {
      return e.webContents;
    }
  } catch (_) { /* 不在 Electron 里 */ }
  return null;
}

/** 取 Electron 的 session 模块；纯 Node（跑测试）里返回 null */
let _session = null;
function electronSession() {
  if (_session) return _session;
  try {
    const e = require('electron');
    if (e && typeof e === 'object' && e.session && typeof e.session.fromPartition === 'function') {
      _session = e.session;
    }
  } catch (_) { /* 不在 Electron 里 */ }
  return _session || null;
}

let lastGuest = null;   // 上一次找到过的页面（兜底：跳转中 URL 可能短暂变 about:blank）

/**
 * 找到某个 WA 内置浏览器（webview）里那个 web.whatsapp.com 页面。
 * 🔴 2026-10-16 复刻成 5 个标签（WA①~WA⑤）后，5 个 webview 都加载同一个
 *    web.whatsapp.com，光看 URL 根本分不清是哪个 —— 必须按**分区（partition）**精确定位。
 *    每个 webview 的 webContents.session === session.fromPartition(它自己的分区)，
 *    拿这个去匹配，5 个页面互不串台。
 *
 * @param {string} [partition] 例如 'persist:wa6'。不传则退回到「全局随便找一个 WhatsApp 页面」（兼容老的单实例调用）。
 */
function findGuest(partition) {
  const wc = electronWebContents();
  if (!wc) return null;
  let targetSession = null;
  const sess = electronSession();
  if (partition && sess && typeof sess.fromPartition === 'function') {
    try { targetSession = sess.fromPartition(partition); } catch (e) { targetSession = null; }
  }
  let all = [];
  try { all = wc.getAllWebContents() || []; } catch (_) { return null; }
  for (const w of all) {
    try {
      if (!w || (w.isDestroyed && w.isDestroyed())) continue;
      if (!looksLikeWhatsapp(w)) continue;
      if (targetSession) {
        // 按分区精确匹配：只有 session identity 相等的那个 webview 才算数
        try { if (w.session !== targetSession) continue; } catch (_) { continue; }
      }
      lastGuest = w;
      return w;
    } catch (_) { /* 单个页面查状态出错就跳过 */ }
  }
  // 兜底：没传分区时，退回到上一次找到过的页面（跳转中 URL 可能短暂变 about:blank）
  if (!partition) {
    try {
      if (lastGuest && !(lastGuest.isDestroyed && lastGuest.isDestroyed())) return lastGuest;
    } catch (_) {}
  }
  return null;
}

/* 只读定位脚本：在 WhatsApp 网页左栏找到对应客户并点开，然后滚到最新。
 *🔴 全程只调 .click() 和 scrollTo，**没有任何输入框赋值、没有 send 事件**。 */
const JUMP_SOURCE = `(function (needle) {
  try {
    var items = document.querySelectorAll(
      '[data-testid="cell-frame"], [role="listitem"], .matched-text, #pane-side [role="listitem"]'
    );
    var hit = null;
    for (var i = 0; i < items.length; i++) {
      var t = (items[i].textContent || '');
      if (t.indexOf(needle) >= 0) { hit = items[i]; break; }
    }
    // 精确名找不到就退一步：只要**唯一**一个会话名里含这个词
    if (!hit && needle) {
      var many = [];
      for (var j = 0; j < items.length; j++) {
        var tt = (items[j].textContent || '');
        if (tt.indexOf(needle) >= 0) many.push(items[j]);
      }
      if (many.length === 1) hit = many[0];
    }
    if (!hit) {
      return { ok: false, error: 'WhatsApp 网页左栏里没找到这个客户（可能还没扫码登录，或会话没加载出来）' };
    }
    hit.click();
    // 打开后滚到最新（只滚动，不点任何东西）
    var sc = document.querySelector('#pane-side, [data-testid="chat-panel"]') || document.scrollingElement;
    setTimeout(function () {
      try {
        var main = document.querySelector('#main, [data-testid="chat-panel"]');
        if (main) { var m = main.querySelector('[data-testid="scroll-panel"]'); (m || main).scrollTop = 999999; }
        else if (sc) sc.scrollTop = 999999;
      } catch (_) {}
    }, 700);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
})`;

/**
 * 在 WA① 内置浏览器里打开某个客户的对话（只读导航）。
 * @param {string} needle 会话列表里要匹配的文本（客户名或号码）
 */
async function jumpViaWeb(needle) {
  if (!needle) return { ok: false, error: '缺少客户名/号码' };
  const guest = findGuest();
  if (!guest) {
    return { ok: false, error: '没找到 WA① 的浏览器页面 —— 先点中栏「WA①」页签把网页打开' };
  }
  try {
    const r = await guest.executeJavaScript(`${JUMP_SOURCE}(${JSON.stringify(String(needle))})`, false);
    return (r && typeof r === 'object') ? r : { ok: false, error: '页面没有返回结果' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 只读诊断：把 WA① 现在打开了哪些页面列出来（老板排障用） */
function listPages() {
  const wc = electronWebContents();
  const out = { ok: true, electron: !!wc, count: 0, pages: [], found: false };
  if (!wc) {
    out.hint = '当前不在 Electron 主进程里（开发调试或纯 Node 环境）';
    return out;
  }
  let all = [];
  try { all = wc.getAllWebContents() || []; } catch (e) { out.hint = 'getAllWebContents 调用失败'; return out; }
  out.count = all.length;
  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    let row = { i, url: '', title: '', type: '', isWA: false };
    try {
      if (w && w.isDestroyed && w.isDestroyed()) { row.destroyed = true; out.pages.push(row); continue; }
      row.url = String((w && w.getURL && w.getURL()) || '');
      row.title = String((w && w.getTitle && w.getTitle()) || '');
      try { row.type = String((w && w.getType && w.getType()) || ''); } catch (_) {}
      row.isWA = looksLikeWhatsapp(w);
      if (row.isWA) out.found = true;
    } catch (e) { row.error = String((e && e.message) || e); }
    out.pages.push(row);
  }
  out.hint = out.found
    ? '找到 WhatsApp 页面'
    : (out.count
      ? `一共 ${out.count} 个页面，但没一个是 WhatsApp（先点中栏「WA①」页签）`
      : '内置浏览器还没真正创建（先点中栏「WA①」页签）');
  return out;
}

module.exports = { jumpViaWeb, listPages, looksLikeWhatsapp, findGuest };