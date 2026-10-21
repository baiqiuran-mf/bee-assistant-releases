'use strict';
/**
 * 代理「本地无密码中转」——gost 内核（v2.6.1120 全量重写）
 * =====================================================================
 * ★ 这段「根因」是整件事的钥匙，改这个文件前务必先读完 ★
 *
 * Chromium / Electron 内核**从根上不支持**代理的账号密码：
 *   ① `--proxy-server=socks5://user:pass@host:port` —— 账密被**静默丢弃**，浏览器当它是无认证代理
 *      （Chromium bug 40829748：SOCKS5 认证压根没实现）；
 *   ② `session.setProxy({ proxyRules })` 的 **proxyRules 语法本身就不认 `user:pass@`**
 *      —— 不是「不支持 socks 认证」，是这一段直接被扔掉，所以**带账密的 http/https 也一样死**；
 *   ③ `page.authenticate()` 只对 HTTP 代理生效，对 SOCKS5 完全无效。
 *   ⇒ 结论：**只要代理要账密，浏览器就直接连不上**，跟选 http 还是 socks 无关。
 *
 * 解法（老板指定的 gost 方案，https://github.com/go-gost/gost）：
 *   在本机起一个【无密码】的中转端口，账密只交给 gost 让它去连上游：
 *       gost.exe -L http://127.0.0.1:<port> -F <scheme>://<user>:<pass>@<host>:<port>
 *   浏览器 / webview / Signal 只看到 `http://127.0.0.1:<port>`，**永远碰不到账密**。
 *   好处：http / https / socks4 / socks5 带不带账密全都能用；不依赖任何代理商；
 *   gost 是独立 exe，不占主进程、崩了也只影响自己那一路。
 *
 * 协议自适应（老板很容易选错）：
 *   设置页里 http 与 https 填的往往是**同一个「HTTP 代理」端口**，选错了就连不上。
 *   所以对 http/https 这一对做**自动重试**：先按配置试，起不通就换另一种再试一次，
 *   用户不必纠结选哪个。
 *
 * 生命周期（谁也别乱关）：
 *   · 同一个 key 只起一个中继（复用端口）；并发的 getRelay 会合并成同一次启动；
 *   · 配置改了 → reset(key) 重建；
 *   · 程序退出 → closeAll() 杀光全部 gost 子进程，绝不留孤儿监听端口；
 *   · **不按浏览器断开来关** —— 中继可能被多个入口共用，关早了会断另一路。
 */
const fs = require('fs');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { resolveGostPath } = require('./gostPath');

const START_TIMEOUT_MS = 8000;  // 单个 gost 实例的启动等待上限
const PROBE_TIMEOUT_MS = 4000;  // 「起得来 ≠ 连得通」的功能性探针超时（别调太大：选错协议时启动要等它）
const PORT_ATTEMPTS = 3;        // 端口冲突/起不来时的重试次数

/**
 * 探针目标（两个，任一通即算通）。
 * 为什么必须要有探针：**gost 是先起监听、再去连上游的** —— 上游地址/协议填错时，
 * 它照样「已监听」、端口照样能连上，但所有流量都超时。只探端口会误判成功。
 * （2026-10-14 实测：上游写成 https:// 时端口正常监听，三种目标全超时；写成 http:// 全部通。）
 * 用两个目标是因为单一目标可能被某些出口地区拦掉，双保险。
 */
const PROBE_TARGETS = [
  'http://www.gstatic.com/generate_204',
  'http://api.ipify.org/?format=json',
];

/** key -> rec（已起的中继） */
const relays = new Map();
/** key -> Promise（正在启动中的中继，用于合并并发请求） */
const pending = new Map();

/* ------------------------------------------------------------------ *
 *  工具
 * ------------------------------------------------------------------ */

/** 让操作系统分配一个空闲端口。监听 socket 从未 accept 过连接，关掉不会留 TIME_WAIT。 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 轮询 TCP 连接，确认 gost 的监听端口真的起来了（进程提前退出则立即判失败） */
function waitListening(proc, port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    let done = false;
    function finish(v) { if (!done) { done = true; resolve(v); } }
    function attempt() {
      if (done) return;
      if (proc.exitCode !== null || proc.signalCode) return finish(false);
      if (Date.now() - start >= timeoutMs) return finish(false);
      const sock = net.connect({ host: '127.0.0.1', port });
      let settled = false;
      sock.setTimeout(700);
      function fail() {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch (e) { /* 忽略 */ }
        setTimeout(attempt, 150);
      }
      sock.once('connect', () => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch (e) { /* 忽略 */ }
        finish(true);
      });
      sock.once('error', fail);
      sock.once('timeout', fail);
    }
    attempt();
  });
}

/** 关掉一个 gost 子进程；Windows 上 kill() 偶尔不生效，再用 taskkill 兜一刀 */
function killProc(proc) {
  if (!proc) return;
  try { proc.kill(); } catch (e) { /* 已退出 */ }
  if (proc.pid && proc.exitCode === null) {
    setTimeout(() => {
      if (proc.exitCode !== null) return;
      try {
        execFile('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { windowsHide: true }, () => {});
      } catch (e) { /* 忽略 */ }
    }, 500);
  }
}

/** 由配置项 + scheme 拼出 gost 的 `-F` 上游串：scheme://[user:pass@]host:port */
function buildUpstream(entry, scheme) {
  const host = String(entry.host || '').trim();
  const port = String(entry.port || '').trim();
  if (!host || !port) return null;
  const auth = entry.user ? `${encodeURIComponent(entry.user)}:${encodeURIComponent(entry.pass || '')}@` : '';
  return `${scheme}://${auth}${host}:${port}`;
}

/**
 * 功能性探针：真经这个本地中转发一个请求出去，通不通。
 * ★ 不能用「端口能不能连上」代替 —— 见 PROBE_TARGETS 上面的说明。
 * @returns {Promise<{ok:boolean, ip:string}>}
 */
async function probeThrough(localUrl) {
  let ProxyAgent, fetch;
  try {
    ({ ProxyAgent, fetch } = require('undici'));
  } catch (e) {
    return { ok: false, ip: '' }; // undici 不可用就不探测（宁可放过）
  }
  const one = async (target) => {
    let agent = null;
    try {
      agent = new ProxyAgent(localUrl);
      const r = await fetch(target, { dispatcher: agent, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!r || r.status < 200 || r.status >= 400) return null;
      const body = await r.text().catch(() => '');
      let ip = '';
      const m = body && body.match(/"ip"\s*:\s*"([^"]+)"/);
      if (m) ip = m[1];
      return { ok: true, ip };
    } catch (e) {
      return null;
    } finally {
      if (agent) { try { await agent.close(); } catch (e) { /* 忽略 */ } }
    }
  };
  const results = await Promise.all(PROBE_TARGETS.map(one));
  for (const r of results) {
    if (r && r.ok) return { ok: true, ip: r.ip || '' };
  }
  return { ok: false, ip: '' };
}

/**
 * 该实例要按顺序试哪些 scheme。
 *   · http  ↔ https：互为一对，自动互换重试（老板最容易选错的就是这两个）；
 *   · socks4 / socks5：无歧义，只试一种；
 *   · ss / trojan / vmess / vless / hysteria2 / tuic：填的是本地协议客户端的监听端口，
 *     统一按 socks5 连（见 proxies.js 的 SCHEME_OF），也只试一种。
 */
function schemeCandidates(entry) {
  let base = 'socks5';
  try { base = require('./proxies').schemeFor(entry && entry.type); } catch (e) { /* 兜底 socks5 */ }
  if (base === 'http') return ['http', 'https'];
  if (base === 'https') return ['https', 'http'];
  return [base];
}

/* ------------------------------------------------------------------ *
 *  启动 / 取用 / 关闭
 * ------------------------------------------------------------------ */

/** 起一个 gost 实例（失败返回 null，调用方负责换 scheme 重试） */
async function startOne(entry, scheme) {
  const gostPath = resolveGostPath();
  if (!fs.existsSync(gostPath)) {
    console.warn(`[proxyRelay] 找不到 gost.exe：${gostPath} → 本地中转用不了，带账密的代理必然连不上`);
    return null;
  }
  const upstream = buildUpstream(entry, scheme);
  if (!upstream) return null;

  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    let port = 0;
    try { port = await getFreePort(); } catch (e) { port = 0; }
    if (!port) continue;

    let proc;
    try {
      // -L = 本机监听（无密码！），-F = 上游转发链
      proc = spawn(gostPath, ['-L', `http://127.0.0.1:${port}`, '-F', upstream], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      console.warn(`[proxyRelay] gost 启动异常：${e.message}`);
      continue;
    }

    // 收 gost 的输出，只为出错时能报出原因（正常时它是 JSON 日志，不往控制台打）
    let tail = '';
    const onData = (d) => { tail = (tail + d.toString()).slice(-1500); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => { tail = (tail + '\n' + e.message).slice(-1500); });

    const ok = await waitListening(proc, port, START_TIMEOUT_MS);
    if (ok) return { proc, port, upstream };

    killProc(proc);
    console.warn(`[proxyRelay] gost 起不来（端口 ${port}）：${tail.trim() || '无输出'}`);
  }
  return null;
}

/** 组装对外记录（签名与旧版一致：getRelay(key) 返回 {key,port,localUrl,close,...}） */
function buildRec(key, entry, started) {
  return {
    key,
    proc: started.proc,
    pid: started.proc.pid,
    port: started.port,
    localUrl: `http://127.0.0.1:${started.port}`,
    upstream: started.upstream,
    scheme: String(started.upstream).split('://')[0],
    type: entry && entry.type,
    alive: () => started.proc.exitCode === null && started.proc.signalCode === null,
    close: async () => {
      killProc(started.proc);
      relays.delete(key);
    },
  };
}

/** 采用某个已起好的 gost 实例：登记进 relays、打日志、返回 rec */
function adopt(key, entry, started, ip) {
  const rec = buildRec(key, entry, started);
  rec.exitIp = ip || ''; // 探通了才有值；没探通就是空串（绝不编一个出来）
  relays.set(key, rec);
  const masked = started.upstream.replace(/\/\/[^@]*@/, '//***@');
  console.log(`[proxyRelay] ${key} 本地中转已起（${rec.scheme}）：${masked} → ${rec.localUrl}${rec.exitIp ? `（出口 IP ${rec.exitIp}）` : ''}`);
  return rec;
}

/**
 * 给某个实例（wa1 / tg1~tg3 / s1~s3）取本地无密码中转。
 *   - 该实例没启用代理、配置不全、或 gost 起不来 → 返回 null（调用方退回直连，
 *     **绝不能**再把带账密的上游串喂给 Chromium）；
 *   - 同一个 key 复用同一个中继；并发调用合并为一次启动。
 * @returns {Promise<{key,port,localUrl,upstream,scheme,exitIp,close,alive}|null>}
 */
async function getRelay(key) {
  if (pending.has(key)) return pending.get(key);

  const task = (async () => {
    const cached = relays.get(key);
    if (cached) {
      if (cached.alive()) return cached;
      // 中继进程曾经挂过 → 先清掉，再重起一个
      try { cached.close(); } catch (e) { /* 忽略 */ }
      relays.delete(key);
    }

    let proxies;
    try { proxies = require('./proxies'); } catch (e) { return null; }
    const entry = proxies.get(key);
    if (!entry || !entry.enabled) return null;
    if (!String(entry.host || '').trim() || !String(entry.port || '').trim()) return null;

    const schemes = schemeCandidates(entry);
    let fallback = null; // 起得来但没探通的那一个，留作最后兜底（保持它活着，不白起）

    for (const scheme of schemes) {
      const started = await startOne(entry, scheme);
      if (!started) continue;

      // 单一候选（socks4/socks5 等无歧义类型）→ 不探测，保持启动快
      if (schemes.length === 1) return adopt(key, entry, started, '');

      const pr = await probeThrough(`http://127.0.0.1:${started.port}`);
      if (pr.ok) {
        if (fallback) killProc(fallback.proc); // 上一个兜底的可以扔了
        return adopt(key, entry, started, pr.ip);
      }
      console.warn(`[proxyRelay] ${key} 按 ${scheme} 起得来但流量不通（端口是通的，是协议/地址不对）→ 换下一种再试`);
      if (!fallback) fallback = started; else killProc(started.proc);
    }

    if (fallback) {
      // 两种都没探通：仍然交出去（可能只是探针目标被那台出口挡住），但把话说清楚
      console.warn(`[proxyRelay] ${key} 两种协议都没探通，暂用 ${String(fallback.upstream).split('://')[0]}` +
        '（浏览器若还是连不上，多半是上游代理本身不通/欠费，不是本机中转的问题）');
      return adopt(key, entry, fallback, '');
    }
    console.warn(`[proxyRelay] ${key} 本地中转起不来（已试 ${schemes.join(' / ')}）→ 该实例退回直连`);
    return null;
  })();

  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

/** 配置变更后重建：杀掉旧中继，下次 getRelay 会按新配置重起 */
async function reset(key) {
  const rec = relays.get(key);
  relays.delete(key);
  if (rec) { try { await rec.close(); } catch (e) { /* 忽略 */ } }
  return true;
}

/**
 * ★ v2.6.1120 ★ 同步取「已经起好的」中继（没起好返回 null）。
 *
 * 给**不能 await 的调用点**用 —— 典型是 src/launcher.js 的 startLauncher()：
 * 它是纯同步函数（调用方 `const r = startLauncher(id)` 直接当对象用），没法等 gost 起来。
 * 所以策略是「**提前预热**」：软件启动时、以及老板在设置页保存代理后，立刻把已启用实例的
 * 中继起好；等用户真去点 S1，中继早就在跑了，这里就能同步拿到。
 *
 * 注意：返回 null 时调用方必须**退回直连**，绝不能把带账密的上游串交给 Chromium。
 */
function peek(key) {
  const rec = relays.get(key);
  return rec && rec.alive() ? rec : null;
}

/** 程序退出：杀光全部 gost 子进程 */
async function closeAll() {
  for (const rec of relays.values()) {
    try { await rec.close(); } catch (e) { /* 忽略 */ }
  }
  relays.clear();
}

/** 诊断用：当前活着的中继一览 */
function listRelays() {
  const out = [];
  for (const [key, rec] of relays.entries()) {
    out.push({ key, port: rec.port, localUrl: rec.localUrl, alive: rec.alive() });
  }
  return out;
}

module.exports = { getRelay, reset, closeAll, listRelays, peek };
