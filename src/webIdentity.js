/**
 * 蜜蜂信息采集 · WA① 内置浏览器的「浏览器身份」统一设置（v2.6.1097）
 * ---------------------------------------------------------------------------
 * 要解决的问题：WA① 的内置 webview 打开 web.whatsapp.com 时被弹
 * 「WhatsApp 支持 Google Chrome 100 及更高版本 / 更新 Google Chrome」页。
 *
 * 为什么需要它（v2.6.1096 那次没修好的真因）：
 *   `public/index.html` 里 WA① 的 `<webview partition="persist:wa6" src="">` 是
 *   **静态写在 HTML 里**的 —— 元素一挂进 DOM，Electron 就把 guest 建好了，此时
 *   它的 User-Agent 已经定死。之后再在渲染进程里 `setAttribute('useragent')`
 *   **对已建好的 guest 无效**，所以 1096 那次"钉 UA"等于没生效。
 *
 * 正解（本文件）：在**主进程**里、在**任何窗口/webview 用到该分区之前**，
 *   对该分区 `session.setUserAgent(标准 Chrome UA)` —— 这是 Electron 官方推荐做法；
 *   再配一层 `webRequest.onBeforeSendHeaders` 逐请求兜底，强制把 User-Agent 钉成同一个值。
 *
 * 🔴 内核一个字节都没动：仍是 Electron 44.4.5 自带的 Chromium（≈152）。
 *    这里只改「浏览器身份字符串」，让 WhatsApp 认得它 —— 与"换内核"完全是两回事。
 *
 * 🔴 模块边界（老板 2026-10-12「代码不要放一块」铁律）：
 *    本文件**只管"给某个分区钉浏览器身份"这一件事**，不碰采集 / 翻译 / 代理 / 界面。
 *    调用方只有 `electron/main.js` 一处。
 * ---------------------------------------------------------------------------
 */
'use strict';

/** WA① 用的分区名（内置浏览器内核版，与一号~五号的"外部 Chrome"完全隔离） */
const WA_PARTITION = 'persist:wa6';

/**
 * 生成一个「纯标准 Chrome」User-Agent。
 * 特点：① 不含 `Electron/xx` 令牌；② 不含应用名（如「蜜蜂信息采集/2.6.x」）；
 *      ③ Chrome 版本号**动态跟随**当前内置的 Chromium，不写死（换 Electron 自动跟着变）。
 * @param {string} [chromeVersion] 不传则取 process.versions.chrome
 */
function chromeUserAgent(chromeVersion) {
  const v = String(chromeVersion || (process.versions && process.versions.chrome) || '152.0.0.0');
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'
    + v + ' Safari/537.36';
}

/**
 * 给指定分区钉「标准 Chrome 身份」。
 * 🔴 必须在任何 webview / 窗口用到该分区**之前**调用（本工程里 = 开主窗口之前）。
 *
 * @param {string} [partition] 默认 WA_PARTITION（persist:wa6）
 * @returns {{ok:boolean, partition:string, ua:string, effective:string, headers:boolean, error?:string}}
 *          ok=true 表示 setUserAgent 已调用成功；effective = 调用后该分区实际生效的 UA（用于自证）。
 */
function applyChromeIdentity(partition) {
  const part = partition || WA_PARTITION;
  let session = null;
  try {
    ({ session } = require('electron'));
  } catch (e) {
    /* 非 Electron 环境（例如普通 node 跑测试）会走到这里 */
  }
  if (!session || typeof session.fromPartition !== 'function') {
    return { ok: false, partition: part, ua: '', effective: '', headers: false, error: '当前环境没有 Electron session（非桌面模式）' };
  }

  const ses = session.fromPartition(part);
  const ua = chromeUserAgent();
  let ok = false;
  let headers = false;

  // ① 主手段：整个分区的默认 UA 换成纯标准 Chrome
  try { ses.setUserAgent(ua); ok = true; } catch (e) { /* 记在 ok=false */ }

  // ② 兜底手段：逐请求强钉 User-Agent（防个别路径又把 UA 改回带 Electron 令牌的默认值）
  //    只动 User-Agent 这一个头，sec-ch-ua 等保持 Chromium 自身的值（不动反而更一致、更安全）。
  try {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const h = details.requestHeaders || {};
      for (const k of Object.keys(h)) {
        if (k.toLowerCase() === 'user-agent' && h[k] !== ua) h[k] = ua;
      }
      callback({ requestHeaders: h });
    });
    headers = true;
  } catch (e) { /* 某些环境可能不允许 hook，不影响主手段 */ }

  let effective = '';
  try { effective = ses.getUserAgent(); } catch (e) { /* 读不到就算了 */ }

  return { ok, partition: part, ua, effective, headers };
}

module.exports = { WA_PARTITION, chromeUserAgent, applyChromeIdentity };
