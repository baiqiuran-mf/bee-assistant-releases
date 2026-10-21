/**
 * v2.6.1115 · 「T② / T③ 按钮点了没反应」实测探针
 *
 * 老板 2026-10-14 18:56 反馈：「T② 和 T③ 按钮没有反应」
 *
 * 排查思路：整条链路代码静态看全对（renderTgAccounts→ /api/telegram/account/:id/open
 *   → openTelegramAccount → telegramRead.openOrFocus → acquireBrowser），
 *   所以必须**真点一次**看断在哪一环，一环一环打点，不靠推断。
 *
 * 跑法：node --experimental-sqlite test/probe_v1115_tgbtn.js
 */

const path = require('path');
require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8995;

(async () => {
  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');
  const cfg = loadConfig();

  console.log('=== ① config.yaml 里 TG 账号实况 ===');
  const tgAccs = (cfg.telegram && cfg.telegram.accounts) || [];
  tgAccs.forEach((t) => console.log(`   id=${t.id} label=${t.label} enabled=${t.enabled} cdpProfile=${t.cdpProfile} cdpPort=${t.cdpPort}`));

  console.log('\n=== ② main.js 的 TELEGRAM_ACCS 是怎么筛的（决定 openTelegramAccount 能不能找到号）===');
  const src = require('fs').readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const i = src.indexOf('const TELEGRAM_ACCS');
  console.log(src.slice(i, i + 420));

  // 起真服务
  const all = (cfg.accounts || []).map((a) => ({ id: a.id, label: a.label, enabled: a.enabled !== false, status: 'online' }))
    .concat(tgAccs.filter((t) => t.enabled !== false).map((t) => ({ id: Number(t.id), label: t.label, enabled: true, status: 'idle' })));
  // 🔴 必须注入 openTelegramAccount，否则 server.js:1466 直接 501
  //    （生产由 src/main.js:2846 注入；探针第一版漏了这步 → 全部 501，看着像"按钮坏了"）
  const telegramRead = require('../src/telegramRead');
  const call2 = async (id) => {
    const acc = tgAccs.find((t) => Number(t.id) === id);
    if (!acc) return { ok: false, error: `没有 Telegram 账号 ${id}` };
    if (!acc.enabled) return { ok: false, error: `${acc.label} 在 config.yaml 里是 enabled: false` };
    const A = { id: Number(acc.id), label: acc.label, waAccount: Number(acc.waAccount) || 0,
                enabled: true, proxy: acc.proxy || '', channel: 'telegram',
                cdpProfile: acc.cdpProfile, cdpPort: acc.cdpPort, timezone: acc.timezone, locale: acc.locale };
    try {
      await telegramRead.openOrFocus(A, cfg);
      return { ok: true, id, label: acc.label };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  };

  const srv = createServer({
    db, doc, ai, knowledge, cfg,
    getAccountStates: () => all,
    openTelegramAccount: async (id) => {
      const r = await call2(id);
      console.log(`      [deps.openTelegramAccount(${id})] →`, JSON.stringify(r));
      return r;
    },
  }, PORT);
  await new Promise((res, rej) => { srv.server.once('error', rej); srv.server.listen(PORT, '127.0.0.1', res); });

  const http = require('http');
  const call = (method, p) => new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (r) => {
      let b = ''; r.on('data', (d) => b += d); r.on('end', () => res({ status: r.statusCode, body: b }));
    });
    req.on('error', (e) => res({ status: 0, body: 'ERR ' + e.message }));
    req.end();
  });

  console.log('\n=== ③ /api/state 的 accounts（T 按钮的数据源）===');
  const st = await call('GET', '/api/state');
  const j = JSON.parse(st.body);
  (j.accounts || []).forEach((a) => console.log(`   id=${a.id} label=${a.label} status=${a.status}`));
  console.log('   → 前端按 id>=7 筛 T 按钮 ⇒应出现 ' + (j.accounts || []).filter((a) => Number(a.id) >= 7).map((a) => a.label).join(','));

  console.log('\n=== ④ 真调 POST /api/telegram/account/:id/open（每号都试，看后端答什么）===');
  for (const id of [7, 8, 9]) {
    const r = await call('POST', `/api/telegram/account/${id}/open`);
    console.log(`   id=${id} → HTTP ${r.status}  ${r.body.slice(0, 220)}`);
  }

  console.log('\n=== ⑤ 直接调 main.js 的 openTelegramAccount 同款逻辑（绕开 HTTP，看内部判定）===');
  for (const id of [7, 8, 9]) {
    const acc = tgAccs.find((t) => Number(t.id) === id);
    if (!acc) { console.log(`   id=${id} → cfg 里没这个号`); continue; }
    if (!acc.enabled) { console.log(`   id=${id} → ** enabled:false ⇒ openTelegramAccount 会直接返错**`); continue; }
    console.log(`   id=${id} → 会被受理，尝试拉起 CDP 浏览器（这一步会真开窗口，探针里改用 dry-run）`);
  }

  console.log('\n=== ⑥ session.launchBrowser 是否认识 cdpProfile/cdpPort ===');
  const session = require('../src/session');
  const a8 = tgAccs.find((t) => Number(t.id) === 8) || {};
  console.log('   T② 用的字段：', JSON.stringify({ id: a8.id, cdpProfile: a8.cdpProfile, cdpPort: a8.cdpPort, exe: a8.exe, dir: a8.dir, proxy: a8.proxy }));
  const ssrc = require('fs').readFileSync(path.join(ROOT, 'src', 'session.js'), 'utf8');
  const j2 = ssrc.indexOf('function launchBrowser');
  console.log(ssrc.slice(j2, j2 + 900));

  srv.server.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });