/**
 * Signal 桌面端「跳到聊天」—— CDP 辅助注入方案（v2.5.1032）
 *
 * ---- 为什么这条路走得通 ----
 *   Signal Desktop 是 Electron 应用，官方就支持 `--remote-debugging-port`。
 *   带这个参数启动后，可以用 puppeteer.connect 连进去，在它自己的页面上下文里操作 DOM。
 *   🔴 最关键：Signal 本来就是 `launcher.js` 我们 spawn 起来的，所以端口是我们自己传的，
 *      不需要老板手动去改 Signal 的快捷方式（这也是比外部模拟键鼠稳得多的原因——
 *      不受窗口最小化 / 被遮挡 / 虚拟桌面的影响）。
 *
 * ---- 已有的开源先例 ----
 *   mandatoryprogrammer/signal-bot 就是用 CDP hook Signal Desktop 做收发消息自动化，
 *   这条路是验证过的，不是我方拍脑袋。
 *
 * ---- 定位依据的现实约束（实测，很重要）----
 *   Signal 的 `conversations.e164`（电话号码）**实测是 null**（signalRead.js 里已注明
 *   "这家客户没存号码"），所以：
 *     - `sgnl://signal.me/#p/+号码` 深链大概率用不了（没号码可拼）→ 只能作为有号码时的兜底
 *     - 这里主要靠 **显示名** 在 Signal 搜索框里搜；serviceId(ACI) 是 UUID，UI 搜索框搜不到，
 *       仅在将来摸清 Signal 内部 Redux API 后可用于精准定位。
 *
 * ---- 选择器策略 ----
 *   Signal Desktop 的 DOM 我无法在沙箱里实测（本机没装/没登录 Signal），
 *   所以全部写成**候选数组**，任一失效都不崩，并且失败时返回明确 reason 便于实测后微调。
 *   找不到输入框时，兜底用 Signal 的搜索快捷键 Ctrl+K（功能级，比选择器稳）。
 *
 * @module signalJump
 */

let puppeteer;
try {
  const extra = require('puppeteer-extra');
  try { extra.use(require('puppeteer-extra-plugin-stealth')()); } catch (e) { /* stealth 可选 */ }
  puppeteer = extra;
} catch (e) {
  try { puppeteer = require('puppeteer'); } catch (e2) { puppeteer = null; }
}

// 测试注入点：单测时可临时替换 puppeteer 实现，不影响生产路径
let _puppeteerOverride = null;
function setPuppeteerForTest(p) { _puppeteerOverride = p; }

/** Signal 搜索框候选选择器（按顺序试，实测后往这里加/减） */
const SEARCH_INPUT_SELECTORS = [
  'input[type="search"]',
  '.SearchInput input',
  '.module-search-input input',
  '.search-input input',
  'input[placeholder*="Search"]',
  'input[placeholder*="搜索"]',
  '.module-search input',
];

/** 搜索结果 / 会话列表项候选选择器 */
const RESULT_ITEM_SELECTORS = [
  '.ConversationListItem',
  '.module-conversation-list-item',
  '[class*="ConversationListItem"]',
  '.search-result',
  '[data-testid*="conversation"]',
  '.module-conversation-list .conversation',
];

/**
 * 连到某个 Signal 实例的 CDP 端口，把窗口拉到最前并尝试定位到指定会话。
 *
 * @param {number} port CDP 调试端口（S1=9333 / S2=9334 / S3=9335）
 * @param {{name?:string, serviceId?:string}} ident 定位依据：优先显示名，serviceId 仅备用
 * @returns {Promise<{ok:boolean, reason?:string, error?:string}>}
 */
async function jumpViaCdp(port, ident) {
  const pp = _puppeteerOverride || puppeteer;
  if (!pp) return { ok: false, reason: 'no-puppeteer' };
  const keyword = String((ident && (ident.name || ident.serviceId)) || '').trim();
  if (!keyword) return { ok: false, reason: 'no-keyword' };

  let browser = null;
  try {
    // 🔴 defaultViewport:null —— 不要改 Signal 自己的窗口尺寸，否则界面会被压变形
    browser = await pp.connect({
      browserURL: `http://127.0.0.1:${port}`,
      defaultViewport: null,
      protocolTimeout: 20000,
    });
  } catch (e) {
    // 端口没开/被占用/Signal 不是我们拉的（没带参数启动）→ 交由调用方降级到深链
    return { ok: false, reason: 'cdp-connect-failed', error: (e && e.message) || String(e) };
  }

  try {
    const pages = await browser.pages();
    // Signal 是单窗口应用；排除 devtools 自身的页面
    const page = (pages || []).find((p) => {
      try { return p.url() && !String(p.url()).startsWith('devtools://'); } catch (e) { return false; }
    }) || (pages || [])[0];
    if (!page) return { ok: false, reason: 'no-signal-page' };

    // ①【先激活窗口】老板要求：跳转流程第一步就是把 Signal 窗口拉到最前。
    //    bringToFront 会让 OS 把 Signal 的窗口置顶（哪怕后面定位失败，用户也看得到 Signal）。
    try { await page.bringToFront(); } catch (e) { /* 失败不影响后续 */ }
    await new Promise((r) => setTimeout(r, 250));

    // ②【搜索】在搜索框里填值（原生 setter + input 事件，触发 React state 更新）
    const filled = await page.evaluate((sels, kw) => {
      const q = (list) => {
        for (const s of list) {
          try { const e = document.querySelector(s); if (e) return e; } catch (e) { /* 选择器非法就跳过 */ }
        }
        return null;
      };
      const input = q(sels);
      if (!input) return false;
      try {
        input.focus();
        // React 受控组件：必须走原生 setter + input 事件，直接赋 .value 不会触发 state 更新
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, kw);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch (e) { return false; }
    }, SEARCH_INPUT_SELECTORS, keyword);

    // ③ 没找到搜索框（或填不进去）→ 兜底用 Signal 的搜索快捷键 Ctrl+K 唤起搜索再敲字
    let usedCtrlK = false;
    if (!filled) {
      try {
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyK');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 700));
        await page.keyboard.type(keyword, { delay: 30 });
        usedCtrlK = true;
      } catch (e) {
        return { ok: false, reason: 'no-search-box', error: (e && e.message) || String(e) };
      }
    }

    // ④【确认 = 输完文字回车】老板明确：「确认就是输完文字回车的意思」。
    //    在 Signal 桌面版搜索框按回车，会自动打开最顶部的匹配会话 —— 这正是用户手动操作的那一下确认。
    //    先等搜索结果渲染，再把焦点锁回搜索框、按回车。
    await new Promise((r) => setTimeout(r, filled ? 1000 : 900));
    try {
      await page.evaluate((sels) => {
        const q = (list) => {
          for (const s of list) {
            try { const e = document.querySelector(s); if (e) return e; } catch (e) {}
          }
          return null;
        };
        const input = q(sels);
        if (input) { input.focus(); if (input.select) input.select(); }
      }, SEARCH_INPUT_SELECTORS);
      await page.keyboard.press('Enter');
    } catch (e) { /* 回车失败不影响下面的兜底点击 */ }

    // ⑤ 兜底：某些 Signal 版本回车不自动开会话 → 再尝试点第一条结果（点到就当确认成功）
    await new Promise((r) => setTimeout(r, 700));
    let clicked = false;
    try {
      clicked = await page.evaluate((sels) => {
        const all = (list) => {
          for (const s of list) {
            try { const arr = Array.from(document.querySelectorAll(s)); if (arr.length) return arr; } catch (e) {}
          }
          return [];
        };
        const items = all(sels);
        if (!items.length) return false;
        try { items[0].click(); return true; } catch (e) { return false; }
      }, RESULT_ITEM_SELECTORS);
    } catch (e) { clicked = false; }

    /* 老板 2026-10-12 裁定：跳转三步（激活窗口 → 搜索 → 回车确认）都走完了就视为成功。
       之前只「填搜索框 + 点第一条结果」，但 Signal 的会话列表选择器对不上 → 点不到 →
       表现为"搜索一下就没有了"。改为「回车确认」后，走的是用户自己手动确认的那一下，最稳。 */
    if (filled || usedCtrlK) {
      return { ok: true, located: true, method: 'signal-cdp-search', confirmed: true, clicked };
    }
    return { ok: false, reason: 'signal-no-match' };
  } catch (e) {
    return { ok: false, reason: 'signal-cdp-error', error: (e && e.message) || String(e) };
  } finally {
    // 🔴 只断开连接，绝不关 Signal（browser.disconnect 不会杀进程；close 才会）
    if (browser) { try { await browser.disconnect(); } catch (e) { /* 忽略 */ } }
  }
}

/**
 * CDP 连不上时的兜底：把已经运行的 Signal 窗口激活到最前（v2.5.1033）
 *
 * 场景：Signal 是老板自己手动开的（不是用软件里的 S1~S3 按钮启动的），
 *       那它没带 `--remote-debugging-port`，CDP 连不进去。
 *       但老板认可的最低要求是"跳到那个消息窗口"就行 —— 所以这里用 PowerShell 的
 *       WScript.Shell.AppActivate 把窗口拉到最前，至少这一步能成。
 *
 * @returns {boolean} 是否成功激活
 */
function activateSignalWindow() {
  if (process.platform !== 'win32') return false;
  try {
    // eslint-disable-next-line global-require
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        "$p = Get-Process -Name Signal -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1; if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null; 'ok' } else { 'none' }",
      ],
      { encoding: 'utf8', timeout: 6000, windowsHide: true },
    );
    return String(out || '').includes('ok');
  } catch (e) {
    return false;
  }
}

module.exports = { jumpViaCdp, activateSignalWindow, setPuppeteerForTest };
