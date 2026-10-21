/**
 * v2.6.1137 Telegram「登出」自检
 * ============================================================================
 * 老板 2026-10-16 出图点名（甲方案 + A 范围）：
 *   ① Tele① 状态条要有「登出」（有登录就该有登出，方便换账号）
 *   ② Tele② 要有登录入口（以前 #tg-status-t2 没人写，永远空白）
 *   ③ 登出范围 = A：只清这个号的会话凭证 + 停这个号的采集，
 *      客户档案 / 消息、外部浏览器、别的 TG 号一律不动
 *
 * 跑法：node test/telegram_logout.test.js
 *
 * 🔴 全程用临时目录写假会话文件，绝不碰真实的 data/telegram-session-*.txt。
 * 🔴 只断言 Telegram，WhatsApp / Signal 一个都不碰（铁律：各渠道各改各的）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? `  << ${extra}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
function section(t) { console.log(`\n--- ${t} ---`); }

const telegramLogout = require('../src/telegramLogout');

/** 临时工作目录（脚本退出前删掉） */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-logout-'));

/** 假会话文件路径算法：telegram-session-<id>.txt（跟 telegramMtproto 的形态一致） */
const fakeSessionPath = (dataDir, id) => path.join(dataDir, `telegram-session-${id}.txt`);

/** 造一个假 stopAccount：用数组记账，看它到底停了谁 */
function makeStopSpy() {
  const called = [];
  const spy = async (id) => { called.push(Number(id)); return { ok: true, stopped: true, error: '' }; };
  return { spy, called };
}

/** 造一个「没在采」的 stopAccount（stopped=false，不该报错） */
const stopNotRunning = async () => ({ ok: true, stopped: false, error: '' });

(async () => {
  /* ══════════ 1. 范围 A：只清会话凭证 + 停采集 ══════════ */
  section('登出 = 停这个号采集 + 删这个号的会话凭证');

  const s1 = makeStopSpy();
  const c1 = telegramLogout.createController({ stopAccount: s1.spy, sessionPath: fakeSessionPath });
  const f7 = fakeSessionPath(TMP, 7);
  fs.writeFileSync(f7, 'AAAAAAAA-fake-session-7', 'utf8');

  const r1 = await c1.logout({ accountId: 7, dataDir: TMP });
  check('登出成功返回 ok', r1.ok === true, JSON.stringify(r1));
  eq('确实调用了 stopAccount 停这个号', JSON.stringify(s1.called), JSON.stringify([7]));
  check('标记为已停止采集', r1.stopped === true);
  check('会话凭证标记已删除', r1.sessionRemoved === true);
  check('原始会话文件没了', fs.existsSync(f7) === false);
  check('删前に备份了 .bak 文件', !!r1.backup && fs.existsSync(r1.backup) === true, `backup=${r1.backup}`);
  eq('备份内容与原件一致', fs.readFileSync(r1.backup, 'utf8'), 'AAAAAAAA-fake-session-7');
  check('备份文件名带 .bak- 前缀', /telegram-session-7\.txt\.bak-/.test(path.basename(r1.backup)), path.basename(r1.backup));

  /* ══════════ 2. 只动自己那一个号 ══════════ */
  section('只动自己这个号 —— 别的号会话文件原封不动');

  const f8 = fakeSessionPath(TMP, 8);
  fs.writeFileSync(f8, 'fake-session-8', 'utf8');
  const s2 = makeStopSpy();
  const c2 = telegramLogout.createController({ stopAccount: s2.spy, sessionPath: fakeSessionPath });
  await c2.logout({ accountId: 7, dataDir: TMP });
  check('Tele②（8 号）的会话文件没被动过', fs.existsSync(f8) === true);
  eq('8 号会话内容一字未改', fs.readFileSync(f8, 'utf8'), 'fake-session-8');
  check('没有去停 8 号的采集', JSON.stringify(s2.called) === JSON.stringify([7]), JSON.stringify(s2.called));

  /* ══════════ 3. 幂等 / 边界 ══════════ */
  section('再来一次（幂等）与异常情况');

  const c3 = telegramLogout.createController({ stopAccount: stopNotRunning, sessionPath: fakeSessionPath });
  const r3 = await c3.logout({ accountId: 9, dataDir: TMP });
  check('本来就没凭证也算成功（幂等）', r3.ok === true, JSON.stringify(r3));
  check('没凭证时不标删除', r3.sessionRemoved === false);
  check('没在采 → stopped=false 但不报错', r3.stopped === false && r3.error === '');

  const r4 = await c3.logout({ accountId: 0, dataDir: TMP });
  check('缺账号 id → 明确报错，不误删东西', r4.ok === false && /缺少/.test(r4.error), JSON.stringify(r4));

  const stopBoom = async () => ({ ok: false, stopped: false, error: '连接已断' });
  const c5 = telegramLogout.createController({ stopAccount: stopBoom, sessionPath: fakeSessionPath });
  const f5 = fakeSessionPath(TMP, 7);
  fs.writeFileSync(f5, 'keep-me', 'utf8');
  const r5 = await c5.logout({ accountId: 7, dataDir: TMP });
  check('停采集失败要拦下来', r5.ok === false && /停止采集失败/.test(r5.error), JSON.stringify(r5));
  check('停采集失败时**绝不删**凭证文件', fs.existsSync(f5) === true);

  /* ══════════ 4. 前端：Tele① / Tele② 各写各的状态条 ══════════ */
  section('前端（public/app.js）：双页签状态条 + 登录 / 登出入口');

  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styleSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

  check('renderTgStatus 按页签取元素（不再写死 #tg-status）', /tgEl\(mp, 'tg-status'\)/.test(appSrc));
  check('Tele② 的刷新走账号 8', /mp === 'tele2' \? 8 : 7/.test(appSrc));
  check('状态请求带 account 参数', /\/api\/telegram\/status\?account=/.test(appSrc));
  check('已登录（collecting）时挂「登出」按钮', /d\.status === 'collecting'[\s\S]{0,400}登出/.test(appSrc));
  check('未登录（login_required）时挂「去登录」按钮', /d\.status === 'login_required'[\s\S]{0,400}去登录/.test(appSrc));
  check('Tele② 的动态按钮 id 统一带 -t2', /function tgpId\(mp, base\) \{ return mp === 'tele2' \? `\$\{base\}-t2` : base; \}/.test(appSrc));
  check('Tele① 的老 id 一个字节没改（不加后缀）', /tgpId\(mp, 'tg-login-btn'\)/.test(appSrc));
  check('登出是异步 ask → 先确认再执行', /async function tgLogoutAsk\(/.test(appSrc) && /await tgLogoutConfirm\(/.test(appSrc));
  check('登出调用 /api/telegram/logout', /api\('\/api\/telegram\/logout'/.test(appSrc));
  check('启动 + 轮询两个页签都刷（Tele② 不再是死角）', /TG_PANES\.forEach\(\(mp\) => refreshTgStatus\(mp\)\)/.test(appSrc));
  check('TG_PANES 含 tele1 / tele2', /const TG_PANES = \['tele1', 'tele2'\]/.test(appSrc));
  check('telegram_status 事件按账号路由到对应页签', /Number\(d\.id\) === 8 \? 'tele2' : 'tele1'/.test(appSrc));
  check('登录成功后立刻刷新对应页签状态条', /refreshTgStatus\(mp\);/.test(appSrc));

  check('index.html 有独立的登出确认浮层（不蹭关闭软件那套）', /id="tg-logout-confirm-overlay"/.test(htmlSrc));
  check('确认浮层自己的取消 / 确定按钮 id 独立', /id="tg-logout-confirm-cancel"/.test(htmlSrc) && /id="tg-logout-confirm-ok"/.test(htmlSrc));
  check('Tele② 状态条元素本来就存在（#tg-status-t2）', /id="tg-status-t2"/.test(htmlSrc));
  check('style.css 加了登出按钮的警示色', /\.tg-login-btn\.danger/.test(styleSrc) && /\.tg-logout-ok-btn/.test(styleSrc));

  /* ══════════ 5. 后端：接口与接线 ══════════ */
  section('后端：/api/telegram/logout 与 status 的账号参数');

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const mtSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegramMtproto.js'), 'utf8');

  check('新增 POST /api/telegram/logout 路由', /p === '\/api\/telegram\/logout' && req\.method === 'POST'/.test(serverSrc));
  check('logout 校验账号必须存在（防乱传 id 误删）', /找不到 Telegram 账号/.test(serverSrc));
  check('status 支持 ?account=（不传默认 7，老行为不变）', /searchParams\.get\('account'\)\) \|\| 7/.test(serverSrc));
  check('status 按账号查自己的会话文件', /telegram-session-\$\{accountId\}\.txt/.test(serverSrc));
  check('登出后广播 data_changed 让界面有反馈', /what: 'telegram_logout'/.test(serverSrc));

  check('main.js 接上了 telegramLogout 依赖', /telegramLogout: tgLogout/.test(mainSrc));
  check('main.js 把 stopAccount / sessionPath 注入登出控制器', /stopAccount:/.test(mainSrc) && /sessionPath:/.test(mainSrc));

  check('telegramMtproto 新增 stopAccount', /function stopAccount\(accountId\)/.test(mtSrc));
  check('telegramMtproto 导出了 stopAccount 和 sessionPath', /module\.exports = \{[^}]*stopAccount[^}]*sessionPath/.test(mtSrc));
  check('老的全停 stop() 没被动过', /function stop\(\) \{/.test(mtSrc));

  /* ══════════ 6. 🔴 范围 A 的反向约束：不许偷偷扩大打击面 ══════════ */
  section('A 方案的反向约束：不许连别的号 / 别的渠道一起动');

  const logoutSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegramLogout.js'), 'utf8');
  /* 🔴 判「有没有真的引入」必须先剥注释 —— 文件头那段中文铁律里提到了「外部 Chrome / TG-PCn-CDP」，
     不剥会把它当成代码命中，凭空多一条假失败。 */
  const logoutCode = logoutSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const kw of ['CDP', 'Chrome', 'puppeteer', 'launchBrowser', 'acquireBrowser']) {
    check(`登出代码里没出现「${kw}」（不碰外部浏览器）`, !logoutCode.includes(kw));
  }
  check('登出模块不删库、不删客户数据', !/DELETE FROM/.test(logoutCode) && !/require\(['"]\.\/db['"]\)/.test(logoutCode));
  check('登出模块不 require 别的采集渠道', !/require\(['"]\.\/(whatsapp|signal|wa[A-Za-z]*|telegramRead)['"]\)/.test(logoutCode));
  check('登出实现是独立新文件（没塞进 main.js）', fs.existsSync(path.join(__dirname, '..', 'src', 'telegramLogout.js')));

  /** 0821：同时给 7 / 8 两个号都建了凭证，登出 7 之后 8 必须还能用 */
  const f7b = fakeSessionPath(TMP, 7);
  const f8b = fakeSessionPath(TMP, 8);
  fs.writeFileSync(f7b, 'seven', 'utf8');
  fs.writeFileSync(f8b, 'eight', 'utf8');
  const s6 = makeStopSpy();
  const c6 = telegramLogout.createController({ stopAccount: s6.spy, sessionPath: fakeSessionPath });
  await c6.logout({ accountId: 7, dataDir: TMP });
  check('登出 7 号后：7 号凭证没了', fs.existsSync(f7b) === false);
  check('登出 7 号后：8 号凭证还在（换账号不影响另一个号）', fs.existsSync(f8b) === true);
  eq('8 号凭证内容未变', fs.readFileSync(f8b, 'utf8'), 'eight');

  /* 收尾 */
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n==================================================');
  console.log(`Telegram 登出自检（v2.6.1137）：${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  console.log('==================================================');
  process.exit(fail ? 1 : 0);
})();
