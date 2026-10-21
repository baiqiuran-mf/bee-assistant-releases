/**
 * 翻译去重测试（2026-09-30 用户要求：「上次翻译过的，不要再翻译，还要显示上次的中文」）
 *
 * 数的是【AI 真实调用次数】——用假 AI 桩计数，比看界面状态硬。
 * 锁住三件事：
 *   ① 翻好的消息，反复打开客户 = 0 次调用，且译文还在（能显示上次的中文）
 *   ② 翻不出来的消息，试满 MAX_AUTO_TRIES 就彻底放手，不再反复烧 token
 *   ③ AI 判定「本来就是中文」的 → 记 skipped，一次判定之后永久不再问
 * 运行：node --experimental-sqlite test/translate_dedup.test.js
 */

// 必须在 require('../src/...') 之前：src/paths.js 在加载那一刻就定数据目录
const { DIR } = require('./_isolate.js');
const db = require('../src/db');
const ai = require('../src/ai');
const translator = require('../src/translator');
const translationMemory = require('../src/translationMemory');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
}
function eq(name, actual, expected) {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

/** 假 AI：数调用次数，mode 控制"能翻出来"还是"永远翻不出来" */
let calls = 0;
let mode = 'ok';
ai.isReady = () => true;
ai.translate = async (t) => { calls++; await new Promise((r) => setTimeout(r, 3)); return mode === 'ok' ? `【中】${t}` : null; };
ai.translateBatch = async (arr) => { calls++; await new Promise((r) => setTimeout(r, 3)); return mode === 'ok' ? arr.map((t) => `【中】${t}`) : arr.map(() => null); };
ai.decideTranslate = async () => { calls++; return mode === 'ok'; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitIdle() {
  for (let i = 0; i < 300 && translator.translatingIds().length; i++) await sleep(20);
  await sleep(50);
}

(async () => {
  /* 🔴 本文件测的是「按消息去重 / 失败封顶 / skipped / 手动重翻」这套账本机制，
   *   跟 v2.6.1122 的「跨消息翻译记忆」是两件事 —— 先把记忆关掉，各测各的。
   *   不关的话：② 里那条「一直翻不出来的消息」原文跟 ① 翻过的一模一样，
   *   会被记忆命中直接复用（这是记忆的功劳），于是「试满 2 次就放手」
   *   根本没机会被验证到。记忆本身由 test/translation_memory.test.js 负责。 */
  translationMemory.setEnabled(false);

  const c = db.getOrCreateCustomer(1, '90001@c.us', { name: 'Dedup' });
  const code = (c && c.customer && c.customer.code) || (typeof c === 'string' ? c : null);
  check('测试客户建好了', !!code, String(code));

  const texts = ['Hello there', 'How are you doing today', 'Please send the photo'];
  const ids = [];
  for (const t of texts) {
    const saved = db.saveMessage({ customerCode: code, accountId: 1, direction: 'in', body: t, waMsgId: `d${Math.random()}`, msgTs: new Date().toISOString() });
    ids.push(Number(saved.id));
  }

  // ---------- ① 翻过的：不重翻 + 译文还在 ----------
  console.log('\n--- ① 翻好的消息，反复打开客户 ---');
  for (const id of ids) translator.translateLater(id, code, db.getMessage.get(id).body, () => {});
  await waitIdle();
  let rows = db.listMessages.all(code);
  eq('三条都翻出了中文', rows.filter((m) => m.body_zh).length, 3);

  const before1 = calls;
  for (let i = 0; i < 5; i++) { translator.backfill(code, () => {}, 12); await waitIdle(); }
  eq('反复打开客户 5 次：AI 一次都没被调用', calls - before1, 0);
  eq('上次翻译的中文还在（界面能原样显示）', db.listMessages.all(code).filter((m) => m.body_zh).length, 3);
  eq('「还有几条没翻」报 0（界面不会再发起补翻）', translator.untranslatedCount(code), 0);

  // ---------- ② 翻不出来的：封顶 ----------
  console.log('\n--- ② 一直翻不出来的消息 ---');
  mode = 'fail';
  const bad = ids[0];
  db.setTranslation.run('', bad);
  db.setTranslateState.run('failed', bad);
  db.resetTranslateTry.run(bad);
  const before2 = calls;
  for (let i = 0; i < 6; i++) { translator.backfill(code, () => {}, 12); await waitIdle(); }
  const spent2 = calls - before2;
  check(`试满 ${translator.MAX_AUTO_TRIES} 次就放手（不再无限重试）`, spent2 <= translator.MAX_AUTO_TRIES, `实际 ${spent2} 次`);
  check('账本记在数据库里（不是内存，重启也记得）',
    (Number(db.getMessage.get(bad).translate_tries) || 0) >= translator.MAX_AUTO_TRIES,
    `tries=${db.getMessage.get(bad).translate_tries}`);
  eq('状态标记为 failed', db.getMessage.get(bad).translate_state, 'failed');
  const before2b = calls;
  for (let i = 0; i < 3; i++) { translator.backfill(code, () => {}, 12); await waitIdle(); }
  eq('封顶之后再打开客户：0 次调用', calls - before2b, 0);
  eq('「还有几条没翻」也不再把它算进去', translator.untranslatedCount(code), 0);

  // ---------- ③ 判定不用翻：记 skipped ----------
  console.log('\n--- ③ AI 判定本来就是中文 ---');
  // 中英混排（"明天见 ok"）才会走「问 AI 要不要翻」这条分支；
  // 补翻（backfill）只收纯外文的，所以这里按"新消息到达"的方式直接排队。
  const amb = db.saveMessage({ customerCode: code, accountId: 1, direction: 'in', body: '明天见 ok', waMsgId: `a${Math.random()}`, msgTs: new Date().toISOString() });
  const ambId = Number(amb.id);
  const before3 = calls;
  translator.translateLater(ambId, code, '明天见 ok', () => {});
  await waitIdle();
  eq('只用一次判定就定性（不重试）', calls - before3, 1);
  eq('状态标记为 skipped', db.getMessage.get(ambId).translate_state, 'skipped');
  eq('skipped 的消息不再允许自动翻', translator.autoAllowed(ambId), false);
  const before3b = calls;
  for (let i = 0; i < 3; i++) { translator.translateLater(ambId, code, '明天见 ok', () => {}); translator.backfill(code, () => {}, 12); await waitIdle(); }
  eq('skipped 之后反复排队：0 次调用', calls - before3b, 0);

  // ---------- ④ 手动重翻：唯一的重来入口 ----------
  console.log('\n--- ④ 用户手动点「点这里重翻」 ---');
  mode = 'ok';
  const before4 = calls;
  const okRetry = translator.retryManual(bad, code, db.getMessage.get(bad).body, () => {});
  await waitIdle();
  eq('手动重翻排上了队', okRetry, true);
  check('手动重翻确实又翻了一次', calls - before4 >= 1, `实际 ${calls - before4} 次`);
  check('这次翻出来并写了中文', !!db.getMessage.get(bad).body_zh, String(db.getMessage.get(bad).body_zh));
  eq('翻成功后账本清零', Number(db.getMessage.get(bad).translate_tries) || 0, 0);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  console.log('隔离数据目录:', DIR);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
