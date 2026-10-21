/**
 * 内核启动自检：只 listen 一次 + 端口被占用能自己让路
 *
 * 起因（真实事故）：electron/main.js 里 startCore() 之后又调了一次 listen()，
 * 抛 ERR_SERVER_ALREADY_LISTEN 把 startDesktop 打断，桌面窗口永远打不开，
 * 终端只留一条 UnhandledPromiseRejectionWarning —— 用户看到的就是"一直卡在这个画面"。
 *
 * 这一条测试就守住这个坑：startCore 返回的 srv 必须已经在监听，
 * 而且对同一个 server 再 listen 必须报错（所以谁都不许再 listen 一次）。
 */
const { DIR } = require('./_isolate.js'); // 必须第一行：隔离数据目录，不碰真实 data/
const net = require('net');
const { startCore } = require('../src/main');

function occupy(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

(async () => {
  let pass = 0, fail = 0;
  const failures = [];
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
  };

  console.log(`[内核启动自检] 数据目录：${DIR}`);

  /* ---- 1) startCore 返回时服务已在监听 ---- */
  const core = await startCore({ startWhatsApp: false, port: 0 });
  check('startCore 返回时 srv 已在监听（调用方不许再 listen）', core.srv.listening === true);
  check('返回的 PORT 就是实际监听端口', core.PORT === core.srv.address().port,
    `${core.PORT} vs ${core.srv.address().port}`);

  /* ---- 2) 重复 listen 必须报错（留作根因证据） ---- */
  let dup = null;
  try {
    await new Promise((res, rej) => {
      core.srv.once('error', rej);
      core.srv.listen(core.PORT, '127.0.0.1', res);
    });
  } catch (e) { dup = e.code; }
  check('对同一个 server 再 listen 会抛 ERR_SERVER_ALREADY_LISTEN',
    dup === 'ERR_SERVER_ALREADY_LISTEN', String(dup));

  /* ---- 3) 端口被占用 → 自动换空闲端口，不打断启动 ---- */
  const busy = await occupy(8791);
  const core2 = await startCore({ startWhatsApp: false, port: 8791 });
  check('端口被占用时自动改用空闲端口（不再 EADDRINUSE 崩掉）',
    core2.srv.listening === true && core2.PORT !== 8791, 'PORT=' + core2.PORT);

  /* ---- 4) 起来之后界面真的能打开 ---- */
  const home = await fetch(`http://127.0.0.1:${core.PORT}/`);
  check('首页 HTTP 200', home.status === 200, 'status=' + home.status);
  const st = await fetch(`http://127.0.0.1:${core.PORT}/api/state`);
  const j = await st.json();
  /* 🔴 v2.6.1113 改口径：原来断言「返回 5 个账号」是写死了只有五个 WhatsApp。
     现在 getAccountStates 把 **Telegram 账号也一并返回**（顶栏 T①/T② 按钮要这份数据，
     老板 18:27 实机报「T 按钮不见了」就是这个漏返），所以总数不再是 5。
     断言改成验「1~5 五个 WA 号都在，且 Telegram 号也返回了」—— 不写死总数，
     免得将来加账号又要改测试（WA=1~5 / Signal=6 / T=7~9，三段互不重叠）。 */
  const accs = Array.isArray(j.accounts) ? j.accounts : [];
  const waIds = accs.filter((a) => Number(a.id) <= 5).map((a) => Number(a.id)).sort();
  const hasTg = accs.some((a) => Number(a.id) >= 7);
  check('/api/state 返回 1~5 五个 WhatsApp 账号 + Telegram 账号（顶栏红绿灯与 T 按钮都要用）',
    waIds.length === 5 && waIds.every((n, i) => n === i + 1) && hasTg,
    `账号数=${accs.length} WA=${JSON.stringify(waIds)} 含T=${hasTg} 状态=${JSON.stringify(accs.map((a) => a.status))}`);

  try { core.srv.close(); } catch (e) {}
  try { core2.srv.close(); } catch (e) {}
  try { busy.close(); } catch (e) {}

  const ok = fail === 0;
  console.log(`\n[内核启动自检] ${ok ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
  if (!ok) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('内核启动自检异常：', e); process.exit(1); });
