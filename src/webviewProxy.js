/**
 * 给「主窗口里的 in-app webview」真正应用代理（v2.6.1100 立，v2.6.1120 改为一律走本地中转）
 * =====================================================================
 * 根因（2026-10-13 老板实测）：在「全局设置 → 代理」里给 Tele① / WA① 填了代理，
 *   但浏览器/webview 永远走直连、出口 IP 不变 —— 因为没有代码把配置喂给 webview 的
 *   session。/api/proxy/relay 一直是死代码，从没被谁调用。
 *
 * 修法：本模块把「有对应 webview 分区」的实例，用 proxyRelay 起本地无密码中转，
 *   再 session.fromPartition(partition).setProxy({ proxyRules }) 真正落地。
 *
 * ★ v2.6.1120 的关键修正（老板报「WA① 代理用不了」的真正原因）：
 *   旧版只在「socks4/socks5 且填了账密」时才走中转，http/https **直接把带账密的 URL 交给
 *   setProxy**。但 Chromium 的 proxyRules 语法**压根不认 `user:pass@`**（整段被静默丢弃），
 *   所以 http/https 带账密同样是死的 —— 这不只是 "不支持 SOCKS 认证" 的问题。
 *   现改为：**只要该实例启用了代理，一律走本地 gost 中转**，不再按类型分流。
 *   浏览器永远只看到 127.0.0.1:port，账密只由 gost 拿去连上游。类型选 http 还是 https
 *   由 gost 那边的「协议自适应」兜住（见 src/proxyRelay.js）。
 *
 * 分区映射（只列「真有 <webview> 挂在主窗口 DOM 上」的实例）：
 *   wa1 → persist:wa6  （WA① 标签，<webview id="wa1-webview">，index.html 里唯一的 webview）
 *   tg1 → persist:tg-tele-7（历史遗留映射：Telegram webview 已从主窗口拿掉，
 *        目前没有元素挂这个分区；保留是为了万一加回来能直接生效，不会误伤别的实例）
 * tg2/tg3 没有独立 webview，不在此映射（避免覆盖 tg1）；它们的代理走
 *   src/session.js 那条外部 Chrome 通路（见 proxies.keyForAccount）。
 * s1~s3（Signal 桌面端）也不是 webview，走 src/launcher.js。
 */
const proxies = require('./proxies');
const proxyRelay = require('./proxyRelay');

let session = null;
try { session = require('electron').session; } catch (e) { session = null; }

const PARTITION_OF = {
  wa1: 'persist:wa6',
  wa2: 'persist:wa7',
  wa3: 'persist:wa8',
  wa4: 'persist:wa9',
  wa5: 'persist:wa10',
  tg1: 'persist:tg-tele-7',
};

/** 把本地中转给的 http://127.0.0.1:port 转成 Chromium proxyRules（不认 http:// 前缀） */
function rulesFromUrl(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\//, ''); // 去掉协议，对全部协议生效（中转会按需 CONNECT 隧道）
}

/** 让某个分区直连（关掉代理） */
async function setDirect(partition) {
  try { await session.fromPartition(partition).setProxy({ proxyRules: '' }); } catch (e) { /* 忽略 */ }
}

/**
 * 给某个实例应用 webview 代理。
 * @returns {Promise<{key,applied,proxyRules?,direct?,reason?}>}
 */
async function applyForInstance(key) {
  const partition = PARTITION_OF[key];
  if (!partition || !session || typeof session.fromPartition !== 'function') {
    return { key, applied: false, reason: 'no-webview-partition' };
  }
  const entry = proxies.get(key);
  if (!entry || !entry.enabled) {
    await setDirect(partition);
    return { key, applied: false, direct: true };
  }

  // ★ v2.6.1120：一律走本地 gost 无密码中转（不再按 socks/http 分流，理由见文件头注释）
  let proxyRules = '';
  try {
    const rec = await proxyRelay.getRelay(key);
    if (rec) proxyRules = rulesFromUrl(rec.localUrl);
  } catch (e) {
    console.warn(`[webviewProxy] ${key} 本地中转起不来：`, e && (e.message || e));
  }
  if (!proxyRules) {
    // 中转起不来 → 宁可直接连，也**绝不**把带账密的上游串喂给 Chromium（那必然 407/连不上，
    // 而且账密被丢后 Chromium 还可能静默直连，IP 泄漏 —— 直连至少是可控的已知状态）
    await setDirect(partition);
    return { key, applied: false, reason: 'relay-unavailable' };
  }
  await session.fromPartition(partition).setProxy({ proxyRules });
  return { key, applied: true, proxyRules };
}

/** 应用全部有 webview 分区的实例（启动时调用一次） */
async function applyAll() {
  const results = [];
  for (const key of Object.keys(PARTITION_OF)) {
    results.push(await applyForInstance(key));
  }
  return results;
}

/**
 * ★ v2.6.1120 ★ 预热全部「已启用」实例的本地中转（不只 webview 那两个）。
 *
 * 为什么需要：src/launcher.js 的 startLauncher() 是同步函数，取中继只能用
 * proxyRelay.peek()（同步）。所以要提前把 gost 起好，等老板点 S1 时能立刻拿到地址。
 * 软件启动时 + 每次保存代理配置后各跑一次即可。
 *
 * @returns {Promise<string[]>} 预热成功的 key 列表
 */
async function warmUpAll() {
  const keys = proxies.INSTANCE_KEYS.filter((k) => {
    const e = proxies.get(k);
    return e && e.enabled;
  });
  const out = await Promise.all(keys.map(async (key) => {
    try {
      const rec = await proxyRelay.getRelay(key);
      return rec ? key : null;
    } catch (e) {
      return null; // 单路失败不影响其它
    }
  }));
  return out.filter(Boolean);
}

module.exports = { PARTITION_OF, applyForInstance, applyAll, warmUpAll, rulesFromUrl };
