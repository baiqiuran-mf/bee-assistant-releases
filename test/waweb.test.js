/* 浏览器插件（网页版 WhatsApp 抓图）端点集成测试
 * 不依赖数据库：用桩 deps 把 createServer 起在随机端口，直接打 HTTP 验证
 * CORS / 令牌校验 / 正常入库 /  OPTIONS 预检。 */
const assert = require('assert');
const { createServer } = require('../src/server');

const TOKEN = 'test-waweb-token-abc123';
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

async function main() {
  const calls = [];
  const deps = {
    cfg: { app: { waWebToken: TOKEN } },
    db: { listCustomers: { name: 'stub' } },
    ingestExtensionImage: async (data) => {
      calls.push(data);
      return { ok: true, code: '1A00001', msgId: 7, isNew: true };
    },
  };
  const httpServer = createServer(deps, 0);
  const server = httpServer.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // 1) OPTIONS 预检：必须返回 CORS 头
  {
    const r = await fetch(`${base}/api/wa-web/incoming-image`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://web.whatsapp.com' },
    });
    check('OPTIONS 预检返回 204', r.status === 204, 'status=' + r.status);
    check('OPTIONS 带 Access-Control-Allow-Origin', (r.headers.get('access-control-allow-origin') || '').includes('web.whatsapp.com'));
    check('OPTIONS 允许 x-waweb-token 头', (r.headers.get('access-control-allow-headers') || '').includes('x-waweb-token'));
  }

  // 2) 错误令牌 → 401
  {
    const r = await fetch(`${base}/api/wa-web/incoming-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-waweb-token': 'wrong', Origin: 'https://web.whatsapp.com' },
      body: JSON.stringify({ sender: { name: 'Emma' }, image: 'data:image/png;base64,AAA' }),
    });
    check('错误令牌返回 401', r.status === 401, 'status=' + r.status);
  }

  // 3) 正确令牌 + WhatsApp 源 → 200，且入库函数被调用
  {
    const r = await fetch(`${base}/api/wa-web/incoming-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-waweb-token': TOKEN, Origin: 'https://web.whatsapp.com' },
      body: JSON.stringify({ accountId: 1, sender: { name: 'Emma' }, image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC', caption: 'hi' }),
    });
    const j = await r.json();
    check('正确令牌返回 200', r.status === 200, 'status=' + r.status);
    check('返回 ok:true 且带回客户编号', j.ok === true && j.code === '1A00001', JSON.stringify(j));
    check('入库函数被调用且收到发送方昵称', calls.length === 1 && calls[0].sender.name === 'Emma');
    check('响应也带 Access-Control-Allow-Origin', (r.headers.get('access-control-allow-origin') || '').includes('web.whatsapp.com'));
  }

  // 4) 正确令牌但无 Origin（本地页面） → 仍 200，allowOrigin 回退 *
  {
    const r = await fetch(`${base}/api/wa-web/incoming-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-waweb-token': TOKEN },
      body: JSON.stringify({ sender: { name: 'Bob' }, image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC' }),
    });
    check('无 Origin 也能 200（allowOrigin 回退 *）', r.status === 200, 'status=' + r.status);
  }

  // 5) GET 令牌接口 —— 🔴 必须带 CORS 头。
  //    2026-10-09 曾漏给该端点加 CORS，导致插件自检被浏览器拦死（"连不上软件"），
  //    而旧测试只断言返回值、没断言响应头，bug 从测试里漏过。此处补上防回归断言。
  {
    const r = await fetch(`${base}/api/wa-web/token`, { headers: { Origin: 'https://web.whatsapp.com' } });
    const j = await r.json();
    check('GET /api/wa-web/token 回显令牌', r.status === 200 && j.token === TOKEN, JSON.stringify(j));
    check('GET /api/wa-web/token 带 Access-Control-Allow-Origin（防 CORS 拦截回归）',
      (r.headers.get('access-control-allow-origin') || '').includes('web.whatsapp.com'),
      'ACAO=' + r.headers.get('access-control-allow-origin'));
  }

  // 6) token 端点的 OPTIONS 预检也必须放行（浏览器对带自定义头的请求会先预检）
  {
    const r = await fetch(`${base}/api/wa-web/token`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://web.whatsapp.com', 'Access-Control-Request-Method': 'GET' },
    });
    check('token 端点 OPTIONS 返回 204 且带 CORS 头',
      r.status === 204 && (r.headers.get('access-control-allow-origin') || '').includes('web.whatsapp.com'),
      'status=' + r.status + ' ACAO=' + r.headers.get('access-control-allow-origin'));
  }

  await new Promise((r) => server.close(r));
  console.log(`\nwa-web 端点测试：通过 ${passed} / 失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
