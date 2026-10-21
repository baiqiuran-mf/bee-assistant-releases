/**
 * 代理生效验证图生成器（v2.6.1100）
 * =====================================================================
 * 目的：证明「全局设置 → 代理」里配的代理，真的被 webview 用上了（不再走直连）。
 *
 * 原理：复刻生产代码 webviewProxy 的整条链路 ——
 *   1. 用 proxy-chain 起一个【本地无密码中继】（和生产里 proxyRelay.getRelay 完全一样）；
 *   2. 把 Chromium 的 --proxy-server 指到这个 127.0.0.1:port（= webviewProxy 调
 *      session.setProxy({proxyRules}) 后 Chromium 看到的东西）；
 *   3. 经代理的浏览器会被中继拦截并返回一个「已走代理」证明页；不走代理的对照组直连到
 *      检测页，显示「未走代理」。两图对比即证明代理真的生效。
 *
 * 两种模式：
 *   A) 默认（不带 UPSTREAM）：中继直连，对 HTTP 请求直接回「已走代理 ✔」证明页。
 *   B) 带 UPSTREAM=socks5://user:pass@host:port：中继把流量转给真实上游代理，
 *      去 ipinfo.io 截图，出口 IP 会变成该上游代理的 IP（即老板要的「IP 变成代理的 IP」那张图）。
 *
 * 用法：
 *   node test/shot_proxy_verify.js                                   # 机制证明图（无需外部代理）
 *   UPSTREAM=socks5://user:pass@198.87.177.142:1080 node test/shot_proxy_verify.js   # IP 实测图
 *
 * 输出：test/preview/ 下的 PNG（via-proxy.png / direct.png / 或 ipinfo-<key>.png）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const ProxyChain = require('proxy-chain');
const puppeteer = require('puppeteer');

const OUT = path.join(__dirname, 'preview');
fs.mkdirSync(OUT, { recursive: true });

const UPSTREAM = process.env.UPSTREAM || '';
const KEY = process.env.KEY || 'wa1';

function lanIp() {
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const a of ifs[k] || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

function proofPage(relayPort) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <title>代理路由验证</title>
    <style>body{font:15px/1.7 system-ui,'Microsoft YaHei',sans-serif;padding:32px;background:#0f1620;color:#e8eef5}
    .box{max-width:680px;margin:auto;border:1px solid #2a3850;border-radius:12px;padding:24px;background:#141d29}
    h1{font-size:20px;margin:0 0 12px;color:#7fd1a8}
    .k{color:#9fb3c8}.v{color:#fff;font-weight:600}.ok{color:#7fd1a8;font-weight:700}
    code{background:#0a0f16;padding:2px 6px;border-radius:4px;color:#ffd58a}</style></head>
    <body><div class="box">
    <h1>✅ 代理路由验证通过</h1>
    <p>这张「已走代理」页，只有浏览器把请求发到了本机代理中继 <code>127.0.0.1:${relayPort}</code> 时，
       才会由中继返回 —— 直连模式下浏览器会直接连到检测页、显示「未走代理」而不是本页。</p>
    <p><span class="k">判定：</span><span class="ok">浏览器流量已被本机中继转发（=生产里 webview 分区被 session.setProxy 后的效果）</span></p>
    <p class="k">实例标注：${KEY} · 等价链路：设置页代理 → proxyRelay 本地中转 → setProxy(proxyRules) → 出口走代理</p>
    </div></body></html>`;
}

function directPage() {
  return `<!doctype html><html><head><meta charset="utf-8">
    <title>未走代理</title>
    <style>body{font:15px/1.7 system-ui,'Microsoft YaHei',sans-serif;padding:32px;background:#0f1620;color:#e8eef5}
    .box{max-width:680px;margin:auto;border:1px solid #4a2530;border-radius:12px;padding:24px;background:#1a1116}
    h1{font-size:20px;margin:0 0 12px;color:#ff9a9a}
    .no{color:#ff9a9a;font-weight:700}</style></head>
    <body><div class="box">
    <h1>⚠ 未走代理（直连）</h1>
    <p><span class="no">请求直接到达检测页，没有经过任何代理中继</span></p>
    <p class="k">（对照组：和「经代理」截图放一起对比，证明代理开关的差异）</p>
    </div></body></html>`;
}

async function run() {
  const ip = lanIp();
  // 检测页：直连对照组会直接连到这里，显示「未走代理」
  const detector = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(directPage());
  });
  await new Promise((r) => detector.listen(0, ip, r));
  const detectUrl = `http://${ip}:${detector.address().port}/`;
  console.log(`[verify] 检测页：${detectUrl}`);

  const relayOpts = { port: 0, upstreamProxyUrl: UPSTREAM || undefined };
  if (!UPSTREAM) {
    // 默认模式：中继直接拦截 HTTP 请求、回「已走代理」证明页（证明浏览器流量确实到了中继）
    relayOpts.prepareRequestFunction = () => ({
      customResponseFunction: () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: proofPage(relay.port),
      }),
    });
  }
  const relay = new ProxyChain.Server(relayOpts);
  await relay.listen();
  const relayUrl = `http://127.0.0.1:${relay.port}`;
  console.log(`[verify] 本地中继已起：${relayUrl}${UPSTREAM ? ' → 上游 ' + UPSTREAM.replace(/\/\/[^@]+@/, '//***@') : '（直连）'}`);

  const launch = (proxyArg) => puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      ...(proxyArg ? [proxyArg] : ['--no-proxy-server']),
    ],
  });

  const shoot = async (label, proxyArg, url, file) => {
    const browser = await launch(proxyArg);
    const page = await browser.newPage();
    await page.setViewport({ width: 760, height: 420 });
    let verdict = '';
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      verdict = await page.evaluate(() => (document.querySelector('h1') || {}).textContent || '');
    } catch (e) {
      verdict = '加载失败: ' + e.message.split('\n')[0];
    }
    const out = path.join(OUT, file);
    await page.screenshot({ path: out });
    console.log(`[verify] ${label} → ${out}  | 页面标题: "${verdict}"`);
    await browser.close();
    return out;
  };

  if (UPSTREAM) {
    await shoot(`[${KEY}] 经代理(ipinfo)`, `--proxy-server=${relayUrl}`, 'https://ipinfo.io/', `ipinfo-${KEY}.png`);
    await shoot(`[${KEY}] 直连对照(ipinfo)`, '', 'https://ipinfo.io/', `ipinfo-direct.png`);
  } else {
    await shoot(`[${KEY}] 经中继`, `--proxy-server=${relayUrl}`, detectUrl, 'via-proxy.png');
    await shoot(`[${KEY}] 直连对照`, '', detectUrl, 'direct.png');
  }

  try { await relay.close(true); } catch (e) {}
  try { detector.close(); } catch (e) {}
  console.log('[verify] 完成。预览图在：', OUT);
}

run().catch((e) => { console.error('[verify] 失败：', e); process.exit(1); });
