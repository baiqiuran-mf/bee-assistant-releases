/**
 * 代理本地中转自检（v2.6.1120）
 * =====================================================================
 * 验的是老板 2026-10-14 的那句话：「全局设置 → 代理 里 WA① 的代理用不了」。
 *
 * 根因（两条，缺一不可）：
 *   ① 协议选错了也能理解，但**关键在于 Chromium 内核压根不支持代理账密** ——
 *      `--proxy-server` / `setProxy({proxyRules})` 都不认 `user:pass@`，账密被静默丢弃；
 *      旧代码还只在「socks + 有账密」时才起中转，http/https 直接把带账密的串交出去 → 必死。
 *   ② gost **先起监听再去连上游** —— 上游协议/地址填错时它照样「已监听」，所以
 *      「端口能连上」根本不能用来判断代理是否可用，必须真发一个请求出去探。
 *
 * 本测试**全离线**（只连 127.0.0.1 上的假上游），不碰真实数据、不需要外网：
 *   · 起一个「要账密的假 HTTP 代理」当上游；
 *   · 让代理模块按配置拉起 gost 中转；
 *   · 断言：中转起来了、真能穿过去、**账密确实被 gost 带给了上游**（浏览器永远看不到账密）、
 *     以及「类型选成 https 时会自动改回 http 再试一次」（协议自适应）。
 *
 * 运行：node --experimental-sqlite test/proxy_relay.test.js
 */

const path = require('path');
const net = require('net');
const http = require('http');

// 数据隔离：只写临时目录，绝不碰真实 data/ 与真实 proxies.json
const { DIR } = require('./_isolate.js');

const proxies = require('../src/proxies');
const proxyRelay = require('../src/proxyRelay');
const { resolveGostPath } = require('../src/gostPath');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + extra : ''}`); }
}
function eq(name, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  check(name, ok, ok ? '' : `实际 ${JSON.stringify(a)} ≠ 期望 ${JSON.stringify(b)}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 假上游：一个「要 Basic 账密」的 HTTP 正向代理（**必须支持 CONNECT**）。
 *
 * 🔴 2026-10-14 实测踩到的坑：gost 连 HTTP 上游时，**哪怕目标是 80 端口的明文 HTTP，
 *    它也是先发 `CONNECT host:80` 建隧道**，而不是发绝对形式 GET。所以假上游要按
 *    裸 TCP 来处理 CONNECT，不能只写个 http.createServer 等 request 事件（那样一个请求都收不到）。
 *
 * 隧道建好之后，客户端真正的请求会从隧道里过来 —— 这里不真去连外网，直接回一个
 * 写死的 200 + {"ip":"9.9.9.9"}，这样连探针都能在**完全离线**的情况下判为成功。
 */
function startFakeUpstream(user, pass) {
  const want = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const seen = { auth: [], first: [], inner: [] };
  const BODY = '{"ip":"9.9.9.9"}';

  const srv = net.createServer((sock) => {
    let buf = '';
    let mode = 'head'; // head = 读代理请求；tunnel = 读隧道里的真实请求
    sock.setEncoding('utf8');
    sock.on('error', () => {});

    const pump = () => {
      const i = buf.indexOf('\r\n\r\n');
      if (i === -1) return;
      const head = buf.slice(0, i);
      const rest = buf.slice(i + 4);
      const lines = head.split('\r\n');
      const first = lines[0] || '';

      if (mode === 'tunnel') {
        seen.inner.push(first);
        buf = '';
        sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(BODY)}\r\nConnection: close\r\n\r\n${BODY}`);
        return sock.end();
      }

      // 不是 HTTP（例如 gost 拿 https:// 来连时发的是 TLS 握手）→ 立刻断，让它快速失败
      if (!/^(CONNECT|GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH) /i.test(first)) {
        return sock.destroy();
      }

      const authLine = lines.find((l) => /^proxy-authorization:/i.test(l)) || '';
      seen.auth.push(authLine.replace(/^proxy-authorization:\s*/i, '').trim());
      seen.first.push(first);
      buf = rest;

      if (seen.auth[seen.auth.length - 1] !== want) {
        sock.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fake"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return sock.end();
      }
      if (/^CONNECT /i.test(first)) {
        mode = 'tunnel';
        sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (buf) pump(); // 客户端可能已经把真实请求一起发过来了
        return;
      }
      sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(BODY)}\r\nConnection: close\r\n\r\n${BODY}`);
      return sock.end();
    };

    sock.on('data', (c) => { buf += c; pump(); });
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

/**
 * 经本地中转发一个最简单的 GET（不走 undici，用裸 http 避开依赖差异）。
 * 中继是 HTTP 代理 → 用绝对形式 URL。
 */
function getThroughProxy(localUrl, target) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(localUrl); } catch (e) { return resolve({ ok: false, err: 'bad localUrl' }); }
    const req = http.request({
      host: u.hostname,
      port: u.port,
      method: 'GET',
      path: target,
      headers: { Host: new URL(target).host },
      timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, err: e && e.message }));
    req.end();
  });
}

(async () => {
  /* ---------------- 1. 纯函数：账号 → 代理 key ---------------- */
  section('代理 key 映射（账号 → 「代理」页的实例）');
  eq('Tele① (id=7 / TG-PC1-CDP) → tg1', proxies.keyForAccount({ id: 7, cdpProfile: 'TG-PC1-CDP' }), 'tg1');
  eq('Tele② (id=8 / TG-PC2-CDP) → tg2', proxies.keyForAccount({ id: 8, cdpProfile: 'TG-PC2-CDP' }), 'tg2');
  eq('Tele③ (id=9 / TG-PC3-CDP) → tg3', proxies.keyForAccount({ id: 9, cdpProfile: 'TG-PC3-CDP' }), 'tg3');
  eq('Signal 启动器 s2 → s2', proxies.keyForAccount({ id: 's2', kind: 'signal' }), 's2');
  // 这两条是旧 bug 的防线：一号不能撞 WA①，Tele① 不能算成 wa7
  eq('一号 (id=1, WA 外部 Chrome) → 不吃「代理」页配置', proxies.keyForAccount({ id: 1 }), null);
  eq('不带 cdpProfile 的账号 → null', proxies.keyForAccount({ id: 5, label: '五号' }), null);
  eq('null 不炸', proxies.keyForAccount(null), null);

  section('代理类型 → 真正要连的 scheme');
  eq('http → http', proxies.schemeFor('http'), 'http');
  eq('https → https', proxies.schemeFor('https'), 'https');
  eq('socks5 → socks5', proxies.schemeFor('socks5'), 'socks5');
  eq('vless（本地客户端）→ socks5', proxies.schemeFor('vless'), 'socks5');
  eq('未知类型 → socks5 兜底', proxies.schemeFor('瞎写的'), 'socks5');

  /* ---------------- 2. gost.exe 在不在 ---------------- */
  section('gost 内核路径');
  const gost = resolveGostPath();
  check('gost.exe 找得到（开发态 bin/gost/gost.exe）', require('fs').existsSync(gost), gost);

  /* ---------------- 3. 未启用 / 配置不全 → 不起中转 ---------------- */
  section('未启用或配置不全时不起中转（宁可直连，也不给 Chromium 半个坏代理）');
  eq('未启用 → getRelay 返回 null', await proxyRelay.getRelay('wa1'), null);
  proxies.save({ wa1: { enabled: true, type: 'http', host: '', port: '', user: '', pass: '' } });
  eq('启用了但没填 host/port → 还是 null', await proxyRelay.getRelay('wa1'), null);

  /* ---------------- 4. 真起一次中转（假上游） ---------------- */
  const USER = 'testuser';
  const PASS = 'testpass';
  const up = await startFakeUpstream(USER, PASS);

  section('启用后起本地中转并真正穿透（账密由 gost 带，浏览器碰不到）');
  proxies.save({ wa1: { enabled: true, type: 'http', host: '127.0.0.1', port: String(up.port), user: USER, pass: PASS } });
  await proxyRelay.reset('wa1');
  const rec = await proxyRelay.getRelay('wa1');

  check('中转起来了', !!rec);
  if (rec) {
    check('本地地址是 127.0.0.1 上的无密码 http', /^http:\/\/127\.0\.0\.1:\d+$/.test(rec.localUrl), rec.localUrl);
    eq('实际使用的 scheme = http', rec.scheme, 'http');
    eq('探针确认了出口 IP（假上游写死的 9.9.9.9）', rec.exitIp, '9.9.9.9');

    const r = await getThroughProxy(rec.localUrl, 'http://example.com/hello');
    check('经中转发请求成功', r.ok && r.status === 200, JSON.stringify(r));
    check('假上游收到了正确的 Basic 账密（= 账密真的被 gost 带过去了）',
      up.seen.auth.indexOf('Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')) !== -1,
      JSON.stringify(up.seen.auth.slice(0, 3)));
    check('上游走的是 CONNECT 隧道（gost 对 http 上游也是先 CONNECT，不是绝对形式 GET）',
      up.seen.first.some((l) => /^CONNECT /i.test(l)), JSON.stringify(up.seen.first.slice(0, 3)));
    check('同一个 key 再取一次是复用同一个中继（不重复起进程）',
      (await proxyRelay.getRelay('wa1')) === rec);
    check('peek() 能同步拿到（Signal 那条同步路径靠它）', proxyRelay.peek('wa1') === rec);
  }

  /* ---------------- 5. 协议自适应：类型选成 https 也能自动改回 http ---------------- */
  section('协议自适应（老板把类型选成 https 时，自动换 http 再试一次）');
  proxies.save({ tg1: { enabled: true, type: 'https', host: '127.0.0.1', port: String(up.port), user: USER, pass: PASS } });
  await proxyRelay.reset('tg1');
  const rec2 = await proxyRelay.getRelay('tg1');
  check('仍拿到了可用中转', !!rec2);
  if (rec2) {
    eq('自动改用 http（配置里写的是 https）', rec2.scheme, 'http');
    eq('出口 IP 探到了', rec2.exitIp, '9.9.9.9');
  }

  /* ---------------- 6. 上游不通时不谎报 ---------------- */
  section('上游连不通时不谎报出口（fail-open 但要如实标"未验证"）');
  proxies.save({ s1: { enabled: true, type: 'http', host: '127.0.0.1', port: '59991', user: USER, pass: PASS } });
  await proxyRelay.reset('s1');
  const rec3 = await proxyRelay.getRelay('s1');
  if (rec3) {
    eq('拿得到本地地址（fail-open，浏览器侧看到的是"代理连不上"而不是悄悄直连）', !!rec3.localUrl, true);
    eq('但出口 IP 为空 —— 没探通就不编一个出来', rec3.exitIp, '');
  } else {
    check('上游不通 → 返回 null（也是可接受策略）', true);
  }

  /* ---------------- 7. 收摊：不留孤儿进程 ---------------- */
  section('关闭后不留孤儿 gost 进程');
  const procs = [rec && rec.proc, rec2 && rec2.proc, rec3 && rec3.proc].filter(Boolean);
  await proxyRelay.closeAll();
  eq('closeAll 后 peek 全空', [proxyRelay.peek('wa1'), proxyRelay.peek('tg1'), proxyRelay.peek('s1')], [null, null, null]);
  await sleep(800);
  const alive = procs.filter((p) => p.exitCode === null && p.signalCode === null);
  check('spawn 出来的 gost 进程确实退出了', alive.length === 0, `还活着 ${alive.length} 个`);
  eq('listRelays 也清空了', proxyRelay.listRelays().length, 0);

  try { up.srv.close(); } catch (e) { /* 忽略 */ }

  console.log(`\n[代理本地中转自检] 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) console.log(`失败清单：\n - ${failures.join('\n - ')}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
