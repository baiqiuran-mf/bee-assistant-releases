/**
 * 每日话术编排台 · 看板自检
 *
 * 覆盖：
 *  1) 数据层（src/scriptBoard.js）：Day1 种子的「早上 / 晚上 / 通用」三态、互斥写盘、
 *     老数据（只有 evening）的迁移、新增碎片；
 *  2) HTTP 层：独立浮窗页面 board.html、看板增删改查、发送=预填（绝不自动发）、密码删碎片。
 *
 * 跑法：node --experimental-sqlite test/board.test.js
 * 全程数据/配置隔离（.tmp-test-data/board.test），不碰真实 data/ 与 config.yaml。
 */

const fs = require('fs');
const path = require('path');

// 数据隔离必须放在 require 任何 src/* 之前
const { DIR: DATA_DIR } = require('./_isolate.js');
const DB = path.join(DATA_DIR, 'assistant.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);

const store = require('../src/db');
const doc = require('../src/customerDoc');
const ai = require('../src/ai');
const knowledge = require('../src/knowledge');
const scriptBoard = require('../src/scriptBoard');
const { createServer } = require('../src/server');
const { loadConfig } = require('../src/main');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + String(extra).slice(0, 200) : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`);
}
const boolean = (v) => typeof v === 'boolean';

(async () => {
  /* ================= 1. 数据层 ================= */
  console.log('\n=== 数据层 · 三态时段 ===');
  const b = scriptBoard.getBoard('1A00009');
  const g = (id) => b.fragments.find((f) => f.id === id);
  // 2026-10-06 起V3.7.6.1 那 267 个碎片只存在于**云端主数据** master_fragments，
  // 本地 buildSeed 不再内置 → 本地种子回到 Day1-7 + 后期维护（121 碎片 / 443 条）。
  // ⚠️ 断言一律用「动态锚点」：种子内容以后还会改，写死 id 或数量必然挂（踩过两次）。
  const SEED_N = b.fragments.length;
  check('种子是本地基础版（Day1-7 + 后期维护 = 121 个碎片）', SEED_N === 121, String(SEED_N));
  check('本地种子不含 V3.7.6 段（已上云端，本地不再内置）',
    !b.fragments.some((f) => /^fx[1-6]_/.test(f.id)), '');
  check('V3.7.6 段已从云端下发（云端主数据承载，本地只读不存）',
    typeof scriptBoard.hasV376 === 'function' && scriptBoard.hasV376('1A00009') === false, '');
  const byDay = {};
  b.fragments.forEach((f) => { byDay[f.day] = (byDay[f.day] || 0) + 1; });
  check('Day1-8 每天都有碎片（8 = 后期维护）',
    [1, 2, 3, 4, 5, 6, 7, 8].every((d) => byDay[d] > 0), JSON.stringify(byDay));
  check('Day1 有十几个碎片',
    b.fragments.filter((f) => f.day === 1).length >= 10,
    String(b.fragments.filter((f) => f.day === 1).length));
  check('每个碎片都有 morning/evening 两个布尔',
    b.fragments.every((f) => boolean(f.morning) && boolean(f.evening)));
  check('每个碎片都有 day 且 ≥ 1（2026-09-30 起碎片按 Day 分页）',
    b.fragments.every((f) => Number.isFinite(f.day) && f.day >= 1),
    JSON.stringify([...new Set(b.fragments.map((f) => f.day))]));

  // 三态锚点：不管种子怎么改，只要「早 / 晚 / 通用」三种都还在，断言就成立
  const M0 = b.fragments.find((f) => f.morning === true && f.evening === false);
  const E0 = b.fragments.find((f) => f.morning === false && f.evening === true);
  const N0 = b.fragments.find((f) => f.morning === false && f.evening === false);
  check('种子里有「早上」碎片（morning=true / evening=false）', !!M0, M0 && M0.name);
  check('种子里有「晚上」碎片（evening=true / morning=false）', !!E0, E0 && E0.name);
  check('种子里有「通用」碎片（两个都不选）', !!N0, N0 && N0.name);
  check('没有任何碎片同时是「早」又是「晚」',
    b.fragments.every((f) => !(f.morning === true && f.evening === true)));

  console.log('\n=== 数据层 · 三态互斥 ===');
  let r = scriptBoard.updateFragment('1A00009', N0.id, { name: N0.name, morning: true, evening: false });
  let f = r.fragments.find((x) => x.id === N0.id);
  check('改成「早上」', f.morning === true && f.evening === false, f);
  r = scriptBoard.updateFragment('1A00009', N0.id, { evening: true });
  f = r.fragments.find((x) => x.id === N0.id);
  check('改「晚上」时自动取消「早上」', f.evening === true && f.morning === false, f);
  r = scriptBoard.updateFragment('1A00009', N0.id, { morning: false, evening: false });
  f = r.fragments.find((x) => x.id === N0.id);
  check('两个都不勾 = 通用', f.morning === false && f.evening === false, f);
  r = scriptBoard.updateFragment('1A00009', M0.id, { morning: true, evening: true });
  f = r.fragments.find((x) => x.id === M0.id);
  check('两个都送到时仍保持互斥（不会同时为真）', f.morning !== f.evening, f);

  console.log('\n=== 数据层 · 老数据迁移（只有 evening） ===');
  const boardDir = path.join(DATA_DIR, 'board');
  fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(path.join(boardDir, 'OLD001.json'), JSON.stringify({
    day: 1,
    fragments: [
      { id: 'f_breakfast', name: '早餐照片（食物）', evening: false, dialogues: [] },
      { id: 'f_title', name: '称呼对换', evening: false, dialogues: [] },
      { id: 'f_dayexp', name: '白天经历', evening: true, dialogues: [] },
      { id: 'f_custom', name: '我自己加的碎片', evening: false, dialogues: [] },
    ],
  }, null, 2));
  const ob = scriptBoard.getBoard('OLD001');
  const og = (id) => ob.fragments.find((x) => x.id === id);
  check('老「早餐照片」→ 早上', og('f_breakfast').morning === true && og('f_breakfast').evening === false, og('f_breakfast'));
  check('老「称呼对换」→ 通用', og('f_title').morning === false && og('f_title').evening === false, og('f_title'));
  check('老「白天经历」→ 晚上', og('f_dayexp').morning === false && og('f_dayexp').evening === true, og('f_dayexp'));
  check('认不出的自定义碎片 → 通用', og('f_custom').morning === false && og('f_custom').evening === false, og('f_custom'));
  const persisted = JSON.parse(fs.readFileSync(path.join(boardDir, 'OLD001.json'), 'utf8'));
  check('迁移结果已回写落盘', persisted.fragments.every((x) => boolean(x.morning)));

  console.log('\n=== 数据层 · 新增碎片 ===');
  const ab = scriptBoard.addFragment('1A00009', '测试碎片', { morning: true });
  const nf = ab.fragments[ab.fragments.length - 1];
  check('新增碎片带 morning', nf.morning === true && nf.evening === false, nf);
  const ab2 = scriptBoard.addFragment('1A00009', '旧式调用', true);
  const nf2 = ab2.fragments[ab2.fragments.length - 1];
  check('兼容旧式布尔调用（=晚上）', nf2.evening === true && nf2.morning === false, nf2);
  check('不带 day 的新碎片默认归 Day1', nf2.day === 1, nf2);
  const ab3 = scriptBoard.addFragment('1A00009', 'Day2碎片', { day: 2 });
  const nf3 = ab3.fragments[ab3.fragments.length - 1];
  check('带 day:2 的新碎片落到 Day2', nf3.day === 2, nf3);

  console.log('\n=== 数据层 · Day 迁移（老数据没有 day） ===');
  const ob2 = scriptBoard.getBoard('OLD001');
  check('老数据缺 day 的碎片被补成 Day1',
    ob2.fragments.every((x) => x.day === 1), ob2.fragments.map((x) => x.day));

  console.log('\n=== 数据层 · 对话 id 全看板唯一（防「改到别的碎片」） ===');
  const seedAll = scriptBoard.getBoard('SEEDCHK').fragments.flatMap((f) => f.dialogues.map((d) => d.id));
  check('种子数据的对话 id 全看板唯一', new Set(seedAll).size === seedAll.length, seedAll);

  // 老数据：两个碎片都从 d1/d2 编号（历史 bug 现场）
  fs.writeFileSync(path.join(boardDir, 'DUP001.json'), JSON.stringify({
    day: 1,
    fragments: [
      { id: 'f_a', name: '甲', evening: false, dialogues: [
        { id: 'd1', en: 'A1', zh: '', sent: false }, { id: 'd2', en: 'A2', zh: '', sent: false }] },
      { id: 'f_b', name: '乙', evening: false, dialogues: [{ id: 'd1', en: 'B1', zh: '', sent: false }] },
    ],
  }, null, 2));
  const dup = scriptBoard.getBoard('DUP001');
  const dupIds = dup.fragments.flatMap((f) => f.dialogues.map((d) => d.id));
  check('老数据里撞车的对话 id 被自动改成唯一',
    dupIds.length === 3 && new Set(dupIds).size === 3, dupIds);
  check('迁移结果已回写落盘',
    new Set(JSON.parse(fs.readFileSync(path.join(boardDir, 'DUP001.json'), 'utf8'))
      .fragments.flatMap((f) => f.dialogues.map((d) => d.id))).size === 3);

  const bDid = dup.fragments.find((f) => f.id === 'f_b').dialogues[0].id;
  const afterSent = scriptBoard.setSent('DUP001', bDid, true);
  check('在第二个碎片上标记已发，不会串到第一个碎片',
    afterSent.fragments.find((f) => f.id === 'f_b').dialogues[0].sent === true
    && afterSent.fragments.find((f) => f.id === 'f_a').dialogues.every((d) => d.sent === false),
    afterSent.fragments.map((f) => f.dialogues.map((d) => `${d.id}:${d.sent}`)));
  const afterDel = scriptBoard.deleteDialogue('DUP001', bDid);
  check('按 id 删对话只删那一条，不会连带删掉别的碎片里的条',
    afterDel.fragments.find((f) => f.id === 'f_b').dialogues.length === 0
    && afterDel.fragments.find((f) => f.id === 'f_a').dialogues.length === 2,
    afterDel.fragments.map((f) => f.dialogues.length));

  /* ================= 2. HTTP 层 ================= */
  console.log('\n=== HTTP · 独立浮窗页面与接口 ===');
  const cfg = loadConfig();
  const prefillCalls = [];
  const srv = createServer({
    db: store, doc, ai, knowledge, cfg,
    getAccountStates: () => [],
    openAccount: async () => ({}),
    prefillChat: async (accountId, phone, text) => {
      prefillCalls.push({ accountId, phone, text });
      return { ok: true, method: 'prefill' };
    },
    simulateMessage: () => ({}),
    clearSimulated: () => {},
  }, 0);
  await new Promise((res) => srv.server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const api = async (p, opt) => {
    const res = await fetch(base + p, opt);
    const t = await res.text();
    let body = null; try { body = JSON.parse(t); } catch (e) { body = t; }
    return { status: res.status, body };
  };
  const J = { 'Content-Type': 'application/json' };

  const html = await api('/board.html');
  check('GET /board.html = 200', html.status === 200, html.status);
  check('board.html 含「早上的对话」勾选框',
    typeof html.body === 'string' && html.body.includes('bp-frag-morning') && html.body.includes('早上的对话'));
  check('board.html 是独立浮窗形态（body.board-window）',
    typeof html.body === 'string' && html.body.includes('board-window'));
  check('board.html 的 __BUILD__ 占位已替换',
    typeof html.body === 'string' && !html.body.includes('__BUILD__'));

  const mk = await api('/api/manual', {
    method: 'POST', headers: J,
    body: JSON.stringify({ ident: '+15418016666', region: '俄勒冈', accountId: 1, body: 'hi' }),
  });
  const code = mk.body.customer?.code || mk.body.code;
  check('录入客户拿到编号', !!code, mk.body);

  let gb = await api(`/api/board/${code}`);
  check('GET /api/board/:code = 200', gb.status === 200, gb.status);
  eq('接口拿到的看板 = 整份种子（121 个碎片）', gb.body.board.fragments.length, SEED_N);
  check('接口返回的碎片带 morning/evening 布尔',
    gb.body.board.fragments.every((x) => boolean(x.morning) && boolean(x.evening)));
  check('返回 day 字段', typeof gb.body.day === 'number', gb.body.day);

  const fidFrag = gb.body.board.fragments.find((x) => x.id === N0.id) || gb.body.board.fragments[0];
  const fid = fidFrag.id;
  check('能按 id 定位到种子碎片', !!fid, N0.id);
  let pu = await api(`/api/board/${code}/fragment/${fid}`, {
    method: 'PUT', headers: J, body: JSON.stringify({ name: '称呼对换', morning: true, evening: false }),
  });
  check('PUT 改碎片时段成功', pu.status === 200 && pu.body.ok, pu.body);
  let pf = pu.body.board.fragments.find((x) => x.id === fid);
  check('已存为「早上」', pf.morning === true && pf.evening === false, pf);
  pu = await api(`/api/board/${code}/fragment/${fid}`, {
    method: 'PUT', headers: J, body: JSON.stringify({ evening: true }),
  });
  pf = pu.body.board.fragments.find((x) => x.id === fid);
  check('改「晚上」自动取消「早上」', pf.evening === true && pf.morning === false, pf);
  pu = await api(`/api/board/${code}/fragment/${fid}`, {
    method: 'PUT', headers: J, body: JSON.stringify({ morning: false, evening: false }),
  });
  pf = pu.body.board.fragments.find((x) => x.id === fid);
  check('都不勾 = 通用', pf.morning === false && pf.evening === false, pf);

  const gb2 = await api(`/api/board/${code}`);
  const dlg = gb2.body.board.fragments.find((x) => x.id === fid).dialogues[0];
  const sd = await api(`/api/board/${code}/send`, {
    method: 'POST', headers: J, body: JSON.stringify({ did: dlg.id }),
  });
  check('POST send → ok', sd.status === 200 && sd.body.ok === true, sd.body);
  eq('发送走的是「预填」通道（不自动发）', sd.body.method, 'prefill');
  check('prefillChat 收到该客户电话与英文原文',
    prefillCalls.length === 1
    && /15418016666/.test(prefillCalls[0].phone)
    && prefillCalls[0].text.includes('Wanqiu'), prefillCalls);

  const bad = await api(`/api/board/${code}/fragment/${fid}`, {
    method: 'DELETE', headers: J, body: JSON.stringify({ pwd: 'wrong' }),
  });
  eq('错密码删碎片 → 403', bad.status, 403);
  const good = await api(`/api/board/${code}/fragment/${fid}`, {
    method: 'DELETE', headers: J, body: JSON.stringify({ pwd: '123456' }),
  });
  check('对密码删碎片 → 200 且少一个碎片',
    good.status === 200 && good.body.board.fragments.length === SEED_N - 1, good.body.board.fragments.length);

  console.log('\n=== HTTP · 左栏「＋ 添加」与右上角「删单条对话」 ===');
  check('board.html 左栏有「＋ 添加」按钮（加话题碎片）',
    typeof html.body === 'string' && html.body.includes('id="board-add"') && html.body.includes('添加'));
  check('board.html 的改/添加碎片弹窗标题可切换（id=bp-frag-title）',
    typeof html.body === 'string' && html.body.includes('bp-frag-title'));
  check('board.html 有「删除单条对话」确认弹窗',
    typeof html.body === 'string' && html.body.includes('board-pop-del-dlg') && html.body.includes('bp-deldlg-yes'));

  // 新增碎片走接口（同一个接口就是「＋ 添加」用的）
  const addOne = await api(`/api/board/${code}/fragment`, {
    method: 'POST', headers: J, body: JSON.stringify({ name: '接口加的碎片', morning: false, evening: true }),
  });
  check('POST 新增碎片 → 200 且多一个', addOne.status === 200 && addOne.body.board.fragments.length === SEED_N,
    addOne.body.board && addOne.body.board.fragments.length);

  // 「已发」= 静默：可反复切（恢复就是 sent:false），且只影响「那一条」
  const gb3 = await api(`/api/board/${code}`);
  const f3 = gb3.body.board.fragments.find((x) => (x.dialogues || []).length > 1);
  const d3 = f3.dialogues[0];
  const sOn = await api(`/api/board/${code}/dialogue/${d3.id}/sent`, {
    method: 'POST', headers: J, body: JSON.stringify({ sent: true, fid: f3.id }),
  });
  const flat = sOn.body.board.fragments.flatMap((f) => f.dialogues);
  const nowSent = flat.filter((d) => d.sent);
  check('点「已发」→ 该条 sent=true（前端表现为静默、按钮变「恢复」）',
    flat.find((d) => d.id === d3.id).sent === true, flat.find((d) => d.id === d3.id));
  check('点「已发」只改这一条，不会串到其它碎片',
    nowSent.length === 1 && nowSent[0].id === d3.id, nowSent.map((d) => d.id));
  const sOff = await api(`/api/board/${code}/dialogue/${d3.id}/sent`, {
    method: 'POST', headers: J, body: JSON.stringify({ sent: false, fid: f3.id }),
  });
  const dOff = sOff.body.board.fragments.flatMap((f) => f.dialogues).find((d) => d.id === d3.id);
  check('点「恢复」→ 该条 sent=false（取消静默）', dOff.sent === false, dOff);

  // 右上角「删」删的是单条对话，碎片本身还在
  const dCount = f3.dialogues.length;
  const dDel = await api(`/api/board/${code}/dialogue/${d3.id}?fid=${f3.id}`, { method: 'DELETE', headers: J });
  const f3b = dDel.body.board.fragments.find((x) => x.id === f3.id);
  check('右上角「删」删掉一条对话、碎片本身还在',
    dDel.status === 200 && !!f3b && f3b.dialogues.length === dCount - 1 && !f3b.dialogues.some((d) => d.id === d3.id),
    f3b && f3b.dialogues.length);
  check('删一条后其它碎片的对话数不变',
    dDel.body.board.fragments.filter((f) => f.id !== f3.id)
      .map((f) => f.dialogues.length).join(',')
    === gb3.body.board.fragments.filter((f) => f.id !== f3.id)
      .map((f) => f.dialogues.length).join(','),
    dDel.body.board.fragments.map((f) => `${f.name}:${f.dialogues.length}`));

  /* ============ 「已发 / 恢复」纯本地 + 话题碎片完成标记（v1.0.8） ============
   * 老板 2026-10-05 的要求：
   *   ① 已发 / 恢复**不连数据库**，只记本地；② 一个话题的对话全部已发 = 这个话题完成，
   *   左栏要能一眼看出（绿色 ✓）；③ 完成的话题仍可点进去看，不许静默。
   * ⚠️ 本测试环境根本没登录云端，光跑起来看不出「有没有偷偷调云端」——
   *    所以这里再加一条源码级护栏：这两个函数体里不许出现云端调用。 */
  console.log('\n=== 「已发 / 恢复」= 只记本机，不碰云端 ===');
  const sbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'scriptBoard.js'), 'utf8');
  const sentBlock = sbSrc.slice(sbSrc.indexOf('async function setSentAsync'),
    sbSrc.indexOf('function addFragment(code'));
  check('「已发 / 恢复」不再调用任何云端接口（源码级护栏）',
    sentBlock.length > 100 && !/cloudMod\(\)|cloud\./.test(sentBlock), sentBlock.slice(0, 160));

  const sentPath = scriptBoard.sentFile(code);
  check('已发状态落在 board/<编号>.sent.json（跟看板内容分开存）',
    sentPath.replace(/\\/g, '/').endsWith(`/board/${code}.sent.json`), sentPath);

  let gbS = await api(`/api/board/${code}`);
  const fS = gbS.body.board.fragments
    .find((x) => (x.dialogues || []).length >= 2 && x.doneAll === false && x.sentCount === 0);
  check('找到一个「还没发过」的话题做样本', !!fS, gbS.body.board.fragments.length);
  const dn = fS.dialogues.length;
  check('没发过的话题不是「已完成」', fS.doneAll === false && fS.sentCount === 0 && fS.total === dn,
    { doneAll: fS.doneAll, sentCount: fS.sentCount, total: fS.total });

  let lastBoard = null;
  for (const d of fS.dialogues) {
    const rr = await api(`/api/board/${code}/dialogue/${d.id}/sent`, {
      method: 'POST', headers: J, body: JSON.stringify({ sent: true, fid: fS.id }),
    });
    lastBoard = rr.body.board;
  }
  const fS2 = lastBoard.fragments.find((x) => x.id === fS.id);
  check('逐条标完后：这个碎片 doneAll=true（= 这个话题完成）',
    fS2.doneAll === true && fS2.sentCount === dn && fS2.total === dn,
    { doneAll: fS2.doneAll, sentCount: fS2.sentCount, total: fS2.total });
  check('完成标记按碎片各算各的，没串到别的话题',
    lastBoard.fragments.filter((x) => x.id !== fS.id).every((x) => x.doneAll === false),
    lastBoard.fragments.filter((x) => x.doneAll).map((x) => x.id));

  const disk = JSON.parse(fs.readFileSync(sentPath, 'utf8'));
  check('已发状态真的写进了本机 sent.json',
    fS.dialogues.every((d) => disk[d.id] === true), Object.keys(disk).length);

  const gbR = await api(`/api/board/${code}`);
  const fR = gbR.body.board.fragments.find((x) => x.id === fS.id);
  check('重新打开看板：已发状态与完成标记都还在（本机持久化）',
    fR.doneAll === true && fR.dialogues.every((d) => d.sent === true), { doneAll: fR.doneAll });

  const rec = await api(`/api/board/${code}/dialogue/${fS.dialogues[0].id}/sent`, {
    method: 'POST', headers: J, body: JSON.stringify({ sent: false, fid: fS.id }),
  });
  const fR2 = rec.body.board.fragments.find((x) => x.id === fS.id);
  check('恢复任意一条 → doneAll 立刻变回 false',
    fR2.doneAll === false && fR2.sentCount === dn - 1,
    { doneAll: fR2.doneAll, sentCount: fR2.sentCount });
  check('「恢复」也明确记成 false（免得又被云端老值采纳回来）',
    JSON.parse(fs.readFileSync(sentPath, 'utf8'))[fS.dialogues[0].id] === false);

  const idsS = fS.dialogues.map((d) => d.id);
  const all = await api(`/api/board/${code}/fragment/${fS.id}/sentall`, {
    method: 'POST', headers: J, body: JSON.stringify({ sent: true, ids: idsS }),
  });
  const fA = all.body.board.fragments.find((x) => x.id === fS.id);
  check('「全部已发」一次把整个话题标完（doneAll=true）',
    all.status === 200 && all.body.ok && fA.doneAll === true && fA.sentCount === dn, { doneAll: fA.doneAll });

  const allOff = await api(`/api/board/${code}/fragment/${fS.id}/sentall`, {
    method: 'POST', headers: J, body: JSON.stringify({ sent: false, ids: idsS }),
  });
  const fA2 = allOff.body.board.fragments.find((x) => x.id === fS.id);
  check('「全部恢复」把整个话题清干净（doneAll=false）',
    fA2.doneAll === false && fA2.sentCount === 0, { doneAll: fA2.doneAll });

  const emptyB = scriptBoard.addFragment(code, '空话题（用来验完成判定）', { day: 1 });
  const eF = emptyB.fragments.find((x) => x.name === '空话题（用来验完成判定）');
  check('空话题还没对话 → 不算已完成（可以继续往里加对话）',
    eF.doneAll === false && eF.total === 0 && eF.sentCount === 0, eF.doneAll);

  /* 老数据迁移：云端仓库里 sent=true、本地没记过 → 读一次就采纳成本地已发（老进度不丢） */
  const MIG = 'MIG001';
  fs.writeFileSync(path.join(boardDir, `${MIG}.json`), JSON.stringify({
    day: 1,
    fragments: [
      { id: 'f_m1', name: '迁移话题', day: 1, morning: false, evening: false, dialogues: [
        { id: 'dm1', en: 'M1', zh: '', sent: true },
        { id: 'dm2', en: 'M2', zh: '', sent: false },
      ] },
    ],
  }, null, 2));
  const migB = scriptBoard.getBoard(MIG);
  const migF = migB.fragments.find((x) => x.id === 'f_m1');
  check('云端老数据里的 sent=true 会被采纳成本地已发（老进度不丢）',
    migF.dialogues[0].sent === true && migF.sentCount === 1 && migF.doneAll === false,
    { sentCount: migF.sentCount, doneAll: migF.doneAll });
  const migMap = JSON.parse(fs.readFileSync(scriptBoard.sentFile(MIG), 'utf8'));
  check('采纳结果也落了盘（只迁一次，不用每次再认）',
    migMap.dm1 === true && migMap.dm2 === undefined, migMap);
  const migOff = scriptBoard.setSent(MIG, 'dm1', false);
  const migF2 = migOff.fragments.find((x) => x.id === 'f_m1');
  check('迁移过来的已发也能正常恢复', migF2.dialogues[0].sent === false && migF2.sentCount === 0);

  /* 迁移兜底（v1.0.8 实测踩到的真情况）：云端那份记录已经被清了（sent 全 false），
     但本地看板文件里还留着 sent=true（以前从云端抄下来的）——
     这份本地凭据必须先收进 sent.json，才不会被云端那份覆盖冲掉。 */
  const MIG2 = 'MIG002';
  fs.writeFileSync(path.join(boardDir, `${MIG2}.json`), JSON.stringify({
    day: 1,
    fragments: [
      { id: 'f_n1', name: '旧快照话题', day: 1, morning: false, evening: false, dialogues: [
        { id: 'dn1', en: 'N1', zh: '', sent: true },
        { id: 'dn2', en: 'N2', zh: '', sent: false },
      ] },
    ],
  }, null, 2));
  const cloudLike = {   // 模拟云端返回的那份：记录已被清 → 全部 sent=false
    day: 1,
    fragments: [
      { id: 'f_n1', name: '旧快照话题', day: 1, morning: false, evening: false, dialogues: [
        { id: 'dn1', en: 'N1', zh: '', sent: false },
        { id: 'dn2', en: 'N2', zh: '', sent: false },
      ] },
    ],
  };
  const adopted = scriptBoard.applySentState(MIG2, cloudLike);
  check('云端记录被清了，也能从本地快照把旧已发认回来（迁移兜底）',
    adopted.fragments[0].dialogues[0].sent === true && adopted.fragments[0].sentCount === 1
    && adopted.fragments[0].doneAll === false,
    { sentCount: adopted.fragments[0].sentCount });
  check('兜底认回来的结果也落了盘（下次不用再认）',
    JSON.parse(fs.readFileSync(scriptBoard.sentFile(MIG2), 'utf8')).dn1 === true);
  check('兜底认回来的旧已发，用户点「恢复」照样能取消（不会被反复顶回来）',
    scriptBoard.setSent(MIG2, 'dn1', false).fragments[0].sentCount === 0);

  try { srv.server.close(); } catch (e) { /* ignore */ }

  /* ================= 5. V3.7.6.1 导入段：幂等补进已有看板（2026-10-06） ================= */
  console.log('\n=== V3.7.6.1 导入段 · 幂等追加 ===');
  const fsx = require('fs');
  const pathx = require('path');
  const { DATA_ROOT } = require('../src/paths');
  const OLD = 'ZZV376T';
  const vDir = pathx.join(DATA_ROOT, 'board');
  fsx.mkdirSync(vDir, { recursive: true });
  const oldJson = pathx.join(vDir, `${OLD}.json`);
  const oldSent = pathx.join(vDir, `${OLD}.sent.json`);
  // 造一个「老客户」看板：只有 1 个老碎片，且其中一条已发
  fsx.writeFileSync(oldJson, JSON.stringify({
    day: 1,
    fragments: [{
      id: 'f1_1', name: '老客户自己的碎片', day: 1, morning: false, evening: false,
      dialogues: [{ id: 'd1_1_1', en: '老板改过的英文', zh: '老板改过的中文', sent: true }],
    }],
  }, null, 2), 'utf8');

check('老客户看板只有 1 个碎片（本地不预置云端内容）',
    scriptBoard.getBoard(OLD).fragments.length === 1 && scriptBoard.hasV376(OLD) === false);

  // 2026-10-06 起：V3.7.6 段只放云端主数据，桌面端**不再本地补全**
  // （这是老板明确要求：只要写进管理员后台数据库，不要加在本地）。
  const r1 = scriptBoard.importV376(OLD);
  check('importV376 是空操作（内容在云端，本地不补）',
    r1.added === 0 && r1.cloudOnly === true, JSON.stringify(r1));

  const after = scriptBoard.getBoard(OLD);
  check('调用后老碎片原样保留（名字没被覆盖）',
    after.fragments[0].name === '老客户自己的碎片'
    && after.fragments[0].dialogues[0].en === '老板改过的英文');
  check('调用后老碎片的「已发」标记没被冲掉',
    after.fragments[0].dialogues[0].sent === true);
  check('本地碎片数不变（仍 1，云端内容不落地本地）',
    after.fragments.length === 1, String(after.fragments.length));
  check('hasV376 恒 false（前端据此隐藏「补全新话术」按钮）',
    scriptBoard.hasV376(OLD) === false);

  const r2 = scriptBoard.importV376(OLD);
  check('再点一次：仍是空操作（无副作用）', r2.added === 0, JSON.stringify(r2));
  check('再点一次后碎片数仍是 1', scriptBoard.getBoard(OLD).fragments.length === 1);

  const r3 = scriptBoard.importV376(OLD);
  check('第三次点：仍然 added=0（反复点无副作用）', r3.added === 0);

  fsx.unlinkSync(oldJson);
  try { fsx.unlinkSync(oldSent); } catch (e) { /* ignore */ }

  console.log(`\n[看板自检] 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) console.log('[看板自检] 失败项：\n - ' + failures.join('\n - '));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('[看板自检] 异常：', e);
  process.exit(1);
});
