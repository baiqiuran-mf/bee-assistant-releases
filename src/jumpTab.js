'use strict';
/**
 * 跳转时「检测 IM 标签 + 自动选中该标签」的纯逻辑（独立成模块，便于单测，不依赖 Electron 启动）。
 *
 * 背景（老板 2026-10-12 要求）：点击「跳到聊天」→ 知道是哪个窗口 → 给窗口发激活命令 →
 * 检测 WhatsApp / Telegram 标签 → 自动选中该标签 → 再定位搜索。
 *
 * 之前的坑：revealBrowser 内部会「挑第一个非 about:blank 的标签」直接 bringToFront，
 * 不一定是 IM 那个标签 → 窗口激活了、但前台显示的是别的标签，IM 标签没被真正选中，
 * 后面 openChatByJid / 搜索框定位就跑在没激活的标签上，时灵时不灵。
 * 这里在「激活窗口」之后，显式重新枚举标签、按 URL 找到 IM 标签并选中，盖过 revealBrowser 的内部选择。
 */

/**
 * 在一堆标签页里挑出目标 IM 的（按 URL 正则）。找不到返回 null。
 * 纯函数，便于单测。
 * @param {Array<{url:Function}>} pages
 * @param {RegExp} urlRe
 * @returns {object|null}
 */
function pickImTab(pages, urlRe) {
  if (!Array.isArray(pages) || !pages.length) return null;
  return pages.find((p) => urlRe.test((p && p.url && p.url()) || '')) || null;
}

/**
 * 激活窗口 + 自动选中 IM 标签。
 * @param {object} browser  puppeteer browser（需有 pages() 方法，返回的 page 有 bringToFront()）
 * @param {object} page     已知的 IM page（fallback，挑不到时用它）
 * @param {RegExp} urlRe    IM 页面 URL 正则（如 /web\.whatsapp\.com/）
 * @param {number} account  账号号（传给 reveal 做窗口槽位错开）
 * @param {Function} [reveal] 激活窗口的函数（默认 no-op），由调用方注入 revealBrowser
 * @returns {Promise<object>} 最终应作为操作目标的 page
 */
async function selectImTab(browser, page, urlRe, account, reveal) {
  if (!browser) return page;
  // 1) 激活 OS 窗口（搬到槽位 + 置顶，用户在一堆窗口里才找得到）
  //    revealBrowser 现在会按 urlRe 锁定目标 IM 标签、并先激活标签再搬窗口，避免露出黑屏。
  if (typeof reveal === 'function') {
    try { await reveal(browser, account, urlRe); } catch (e) { /* 激活失败不影响后面选标签 */ }
  }
  // 2) 重新枚举标签，挑出 IM 标签并选中（在窗口激活之后，盖过 reveal 的内部选择）
  try {
    const pages = await browser.pages();
    const target = pickImTab(pages, urlRe) || page;
    if (target && typeof target.bringToFront === 'function') await target.bringToFront().catch(() => {});
    return target || page;
  } catch (e) {
    return page;
  }
}

module.exports = { pickImTab, selectImTab };
