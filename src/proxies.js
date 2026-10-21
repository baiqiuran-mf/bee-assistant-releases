/**
 * 代理配置（v2.5.10020 新增）
 * =====================================================================
 * 每个可独立走代理的实例一份：WA① 内置浏览器(wa1)、
 * Telegram 标签 Tele①②③(tg1..tg3)、Signal 桌面端 S1~S3(s1..s3)。
 * wa1 = WA① 内置浏览器（webview 分区 persist:wa6），2026-10-13 老板要求补回并真正生效。
 *
 * 与 config.yaml 解耦：单独存 <DATA>/proxies.json，避免改写 config.yaml 的注释。
 * 设置页「代理」页读写这个文件；session.js（WA 内核 Chrome）/ launcher.js（Signal）
 * 启动时读它注入代理；主窗口里的 app 内 webview（WA/Tele 标签）也读它设代理。
 *
 * 协议（市面常用）：http / https / socks4 / socks5 / ss / trojan / vmess / vless /
 * hysteria2 / tuic。其中 ss/trojan/vmess/vless/hysteria2/tuic 这 6 种是「协议客户端」
 * （v2rayN / Clash 等），浏览器实际连的是它们在本机开的监听端口，scheme 默认走 socks5；
 * 这类填「本地客户端监听的 host:port」即可。
 */

const fs = require('fs');
const path = require('path');

let DATA_ROOT = '.';
try { DATA_ROOT = require('./paths').DATA_ROOT || '.'; } catch (e) { /* 兜底 */ }

const FILE = path.join(DATA_ROOT, 'proxies.json');

// 浏览器 / webview 真正接受的 scheme：ss/trojan/vmess/vless/hysteria2/tuic 都映射到本地客户端的监听类型（默认 socks5）
const SCHEME_OF = {
  http: 'http', https: 'https', socks4: 'socks4', socks5: 'socks5',
  ss: 'socks5', trojan: 'socks5', vmess: 'socks5', vless: 'socks5',
  hysteria2: 'socks5', tuic: 'socks5',
};

const INSTANCE_KEYS = [
  'wa1', 'wa2', 'wa3', 'wa4', 'wa5',   // WA①~⑤ 内置浏览器（webview 分区 persist:wa6~wa10）
  'tg1', 'tg2', 'tg3',
  's1', 's2', 's3',
];

function emptyEntry() {
  return { enabled: false, type: 'socks5', host: '', port: '', user: '', pass: '', region: '' };
}

function defaults() {
  const o = {};
  for (const k of INSTANCE_KEYS) o[k] = emptyEntry();
  return o;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const base = defaults();
    for (const k of INSTANCE_KEYS) {
      if (raw && raw[k]) base[k] = Object.assign(emptyEntry(), raw[k]);
    }
    return base;
  } catch (e) {
    return defaults();
  }
}

function save(obj) {
  const base = defaults();
  const cur = load();   // 现有落盘值（保留原密码等没被这次修改的字段）
  for (const k of INSTANCE_KEYS) {
    const incoming = obj && obj[k];
    if (!incoming) { base[k] = cur[k]; continue; }   // 没提交这个实例 → 保留原值
    // 以「现有值」为底，只覆盖前端真正提交上来的字段；密码没提交（掩码未改）就保留原来的
    const merged = Object.assign(emptyEntry(), cur[k]);
    for (const fld of ['enabled', 'type', 'host', 'port', 'user', 'region']) {
      if (fld in incoming) merged[fld] = incoming[fld];
    }
    if ('pass' in incoming) merged.pass = incoming.pass;
    base[k] = merged;
  }
  try { fs.writeFileSync(FILE, JSON.stringify(base, null, 2)); return true; }
  catch (e) { console.error('[proxies] 保存失败：', e && (e.message || e)); return false; }
}

/** 返回某个实例的代理配置（未启用返回 {enabled:false}） */
function get(key) {
  return load()[key] || emptyEntry();
}

/**
 * 把某个实例的代理配置翻译成 Chromium / webview 能用的 proxyRules 串。
 * 返回 null 表示「不启用代理」（直连）。
 */
function rules(key) {
  const url = urlFor(key);
  if (!url) return null;
  // webview setProxy 的 proxyRules 也认 scheme://host:port；这里保持兼容
  return url;
}

/** 给 Chromium `--proxy-server` / webview setProxy 用的完整串（scheme://[user:pass@]host:port） */
function urlFor(key) {
  const e = get(key);
  if (!e || !e.enabled) return null;
  const host = String(e.host || '').trim();
  const port = String(e.port || '').trim();
  if (!host || !port) return null;
  const scheme = SCHEME_OF[e.type] || 'socks5';
  let auth = '';
  if (e.user) auth = `${encodeURIComponent(e.user)}:${encodeURIComponent(e.pass || '')}@`;
  return `${scheme}://${auth}${host}:${port}`;
}

/** 设置页选的「代理类型」→ 浏览器/gost 真正要连的 scheme（单一出处，别在别处再抄一份表） */
function schemeFor(type) {
  return SCHEME_OF[type] || 'socks5';
}

/**
 * ★ v2.6.1120 新增 ★ 账号 → 「代理」页的实例 key（wa1..wa5 / tg1~tg3 / s1~s3）。
 *
 * 为什么必须要有这个映射（旧代码的锅，别退回去）：
 *   旧代码在 src/session.js 里用 `'wa' + account.id` 硬推 key ——
 *     · Tele① 的 id 是 7 → 算成 `wa7`，`tg1` 的配置**从来没接上过**；
 *     · 一号的 id 是 1 → 算成 `wa1`，**误撞 WA① 内置浏览器**的配置。
 *
 * 返回 null 的两种情况（都不是 bug，是刻意）：
 *   · WhatsApp 外部 Chrome（一号~五号）：它们的代理走 config.yaml 的 accounts[].proxy，
 *     不占用「代理」页的 key。wa1~wa5 是「WA①~⑤ 内置浏览器（webview persist:wa6~wa10）」专属，
 *     与一号是完全隔离的两套数据夹 / 登录态 / 出口 IP，绝不能互串。
 *   · 认不出来的账号。
 *
 * 🔴 v2.6.1134：WA①~⑤ 五个内置浏览器各有独立账号号（10~14），分别映射到 wa1~wa5。
 *
 * @param {object} account 账号配置（WA 账号 / TG 账号）或启动器对象（Signal 的 id 即 s1~s3）
 * @returns {string|null}
 */
const WA_ACC_TO_KEY = { 10: 'wa1', 11: 'wa2', 12: 'wa3', 13: 'wa4', 14: 'wa5' };

function keyForAccount(account) {
  if (!account) return null;
  const id = String(account.id == null ? '' : account.id).trim();
  // ① Signal 桌面端启动器：id 本身就是 s1~s3（见 launcher.js buildLaunchers）
  if (/^s[1-9]$/i.test(id)) return id.toLowerCase();
  // ② Telegram 采集账号：cdpProfile = TG-PCn-CDP → tgN（Tele①/②/③ 分别对应 tg1/tg2/tg3）
  const m = String(account.cdpProfile || '').match(/^TG-PC(\d+)-CDP$/i);
  if (m) return 'tg' + Number(m[1]);
  // ③ WA①~⑤ 内置浏览器（账号号 10~14）→ wa1~wa5
  if (Object.prototype.hasOwnProperty.call(WA_ACC_TO_KEY, id)) return WA_ACC_TO_KEY[id];
  // ④ 其余（含 WA 外部 Chrome 一号~五号）→ 不用「代理」页的配置
  return null;
}

/** 给 Signal 这类认环境变量的程序用：返回 {HTTPS_PROXY, HTTP_PROXY} 或 null */
function envFor(key) {
  const e = get(key);
  if (!e || !e.enabled) return null;
  const host = String(e.host || '').trim();
  const port = String(e.port || '').trim();
  if (!host || !port) return null;
  const scheme = SCHEME_OF[e.type] || 'socks5';
  const url = `${scheme}://${host}:${port}`;
  return { HTTPS_PROXY: url, HTTP_PROXY: url };
}

module.exports = {
  INSTANCE_KEYS,
  emptyEntry,
  load,
  save,
  get,
  rules,
  urlFor,
  envFor,
  schemeFor,
  keyForAccount,
};
