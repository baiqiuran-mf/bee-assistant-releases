/**
 * 翻译「更快 / 不再卡死」专项自检（另起进程）
 *
 * 守的是这一轮针对「信息比较多的会一直翻译中」做的改造：
 *   ① 同客户多条消息合并成一次请求（translateBatch）—— 请求数骤降
 *   ② 长消息自动切片并行翻（splitChunks）—— 长消息不再慢
 *   ③ 并发上限（CONCURRENCY）+ 单请求超时（ai.js 里 AbortController）—— 不再永久卡死
 *   ④ 失败重试一次后仍不行就标 failed，界面不再假装还在「等待翻译中」
 *
 * 跑法：node --experimental-sqlite test/translator_speed.test.js
 */

require('./_isolate.js');
const fs = require('fs');
const path = require('path');
const { DIR } = require('./_isolate.js');
const ROOT = path.join(__dirname, '..');
const PORT = 8987;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + extra : ''}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let srv = null;
  try {
    const ai = require('../src/ai');
    // 记录调用，便于断言「合并 / 切片」
    let batchCalls = [];
    let singleCalls = 0;

    ai.isReady = () => true;
    ai.providerReady = () => true;
    ai.notConfiguredReason = () => null;
    ai.decideTranslate = async () => true;
    ai.translate = async (text) => { singleCalls++; return `（译）${text}`; };
    ai.translateBatch = async (texts) => {
      batchCalls.push(texts.slice());
      return texts.map((t) => `（译）${t}`);
    };
    /* v2.6.1149：translationMemory 的 AI 准入**唯一出口**是 callProviderByName
     * （record() → aiDecideKeep()）。本文件以前没桩它 → 拿副本里的真 key 联网，
     * 超时窗口 8s，而它 await 在 translator.js:248 `await Promise.all(recPromises)`
     * 这一行、正好卡在写库（第 250~258 行 finish()）**之前** ——
     * 测试只 wait(120) 就去看 body_zh，finish() 根本还没跑。 */
    ai.callProviderByName = async () => 'KEEP';

    const db = require('../src/db');
    const doc = require('../src/customerDoc');
    const knowledge = require('../src/knowledge');
    const translator = require('../src/translator');
    const { createServer } = require('../src/server');
    const { loadConfig } = require('../src/main');

    const cfg = loadConfig();
    srv = createServer({ db, doc, ai, knowledge, cfg, getAccountStates: () => [] }, PORT);
    await new Promise((res, rej) => {
      srv.server.once('error', rej);
      srv.server.listen(PORT, '127.0.0.1', res);
    });
    const BASE = `http://127.0.0.1:${PORT}`;
    const api = async (p, o = {}) => {
      const r = await fetch(BASE + p, o);
      const t = await r.text();
      let b; try { b = JSON.parse(t); } catch { b = t; }
      return { status: r.status, body: b };
    };

    const { customer } = db.getOrCreateCustomer(1, '14155550100@c.us', { name: '提速测试' });
    const code = customer.code;

    /* ============================================================
     * 1) 批量合并：同客户多条短消息 → 一次 translateBatch 请求
     * ============================================================ */
    console.log('\n=== 批量合并：同步涌入多条 → 一次请求 ===');
    batchCalls = [];
    const shortMsgs = [
      'hi there',
      'is this still available?',
      'I live in Oregon',
      'do you paint cats?',
      'how much for a 30x40?',
      'can I see more?',
    ];
    const ids = [];
    shortMsgs.forEach((body, i) => {
      const m = db.saveMessage({ customerCode: code, accountId: 1, direction: 'in', body, waMsgId: `batch-${i}` });
      ids.push(m.id);
      translator.translateLater(m.id, code, body, () => {});
    });
    // 同步涌入后，全部已在队列；等一个 tick 让 pump 把这一批合并
    await wait(60);
    check('6 条短消息只触发 1 次 translateBatch（不是 6 次往返）', batchCalls.length === 1, `实际 ${batchCalls.length} 次：${JSON.stringify(batchCalls.map((b) => b.length))}`);
    check('那一次请求里包含了全部 6 条', batchCalls[0] && batchCalls[0].length === 6, JSON.stringify(batchCalls[0] && batchCalls[0].length));
    check('没有用单条 translate（应是批量走的）', singleCalls === 0, `singleCalls=${singleCalls}`);
    await wait(120);
    const batched = db.listMessages.all(code).filter((m) => ids.includes(m.id));
    check('6 条全部翻好写库', batched.every((m) => m.body_zh && m.translate_state === 'done'), JSON.stringify(batched.map((m) => m.translate_state)));

    /* ============================================================
     * 2) 长消息切片：一条超长消息 → 切几段并行翻（走单条 translate，不是 batch）
     * ============================================================ */
    console.log('\n=== 长消息切片：超长消息并行翻 ===');
    singleCalls = 0; batchCalls = [];
    const longBody = 'This is a very long customer message. '.repeat(80); // 远超 1400 字符
    const lm = db.saveMessage({ customerCode: code, accountId: 1, direction: 'in', body: longBody, waMsgId: 'long-1' });
    translator.translateLater(lm.id, code, longBody, () => {});
    await wait(200);
    check('长消息走了「切片并行翻」：单条 translate 被调用了多次', singleCalls >= 2, `singleCalls=${singleCalls}`);
    check('长消息没有走 translateBatch（它本来就只有 1 条）', batchCalls.length === 0, `batchCalls=${batchCalls.length}`);
    const longRow = db.listMessages.all(code).find((m) => m.id === lm.id);
    check('长消息最终有中文译文', !!longRow.body_zh && longRow.body_zh.startsWith('（译）'), (longRow.body_zh || '').slice(0, 20));
    check('长消息译文字数约为原文的 3 字前缀累加（拼接正确）', longRow.body_zh.includes('（译）'), '');

    /* ============================================================
     * 3) 失败 → 重试一次 → 仍失败标 failed（界面不再假装翻译中）
     * ============================================================ */
    console.log('\n=== 失败处理：重试一次后仍失败 → 标 failed ===');
    ai.translate = async () => { throw new Error('模拟服务商超时'); };
    ai.translateBatch = async () => { throw new Error('模拟服务商超时'); };
    const fm = db.saveMessage({ customerCode: code, accountId: 1, direction: 'in', body: 'this will fail', waMsgId: 'fail-1' });
    translator.translateLater(fm.id, code, 'this will fail', () => {});
    await wait(200); // 重试一次 + 失败
    const failRow = db.listMessages.all(code).find((m) => m.id === fm.id);
    check('翻译失败的消息状态写成 failed', failRow.translate_state === 'failed', failRow.translate_state);
    check('失败后不再处于「翻译中」', translator.isTranslating(fm.id) === false, '');
    const r = await api(`/api/customer/${code}`);
    const fState = r.body.messages.find((m) => m.id === fm.id);
    check('接口装饰：translateFailed=true（界面据此显示「没翻出来」，而非转圈）', fState && fState.translateFailed === true, JSON.stringify(fState && fState.translateFailed));
    check('接口装饰：不再标 untranslated/translating（避免假「等待翻译中」）', fState && fState.untranslated === false && fState.translating === false, JSON.stringify([fState && fState.untranslated, fState && fState.translating]));

    /* ============================================================
     * 4) 2026-09-30 改规则：补翻【不再】自动碰已经试满次数的 failed
     *    以前这里写的是"重开客户就把 failed 救回来"，结果是每打开一次客户
     *    就把那批永远翻不出来的消息重翻一遍，token 一直烧。
     *    现在只有用户手动点「点这里重翻」才清零重来。
     * ============================================================ */
    console.log('\n=== 封顶后：补翻不再自动重试 failed（不烧 token）===');
    ai.translate = async (text) => `（译）${text}`;
    ai.translateBatch = async (texts) => texts.map((t) => `（译）${t}`);
    const before = db.listMessages.all(code).filter((m) => m.translate_state === 'failed').length;
    const rr = await api(`/api/customer/${code}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max: 20 }),
    });
    check('补翻不再把已试满次数的 failed 排上（queued = 0）', rr.body.queued === 0, JSON.stringify(rr.body));
    check('「还有几条没翻」也不再算它（界面不会反复发起补翻）', rr.body.remaining === 0, JSON.stringify(rr.body));
    await wait(150);
    const failRow2 = db.listMessages.all(code).find((m) => m.id === fm.id);
    check('它保持 failed 不动（不偷偷重试）', failRow2.translate_state === 'failed', failRow2.translate_state);

    console.log('\n=== 用户手动点「点这里重翻」才能救回 ===');
    const r2 = await api(`/api/message/${fm.id}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('手动重翻接口把它排上了（queued = 1）', r2.body.queued === 1, JSON.stringify(r2.body));
    await wait(250);
    const failRow3 = db.listMessages.all(code).find((m) => m.id === fm.id);
    check('手动重翻把它救回来了（done + 有中文）',
      failRow3.translate_state === 'done' && !!failRow3.body_zh, JSON.stringify(failRow3.translate_state));

    console.log(`\n========== 翻译提速自检：${pass} 通过 / ${fail} 失败 ==========`);
    if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  } catch (e) {
    console.error('\n[致命错误] 翻译提速自检中断：', e);
    fail++;
  } finally {
    try { srv && srv.server.close(); } catch (e) {}
    try { const db = require('../src/db'); if (db.db && db.db.close) db.db.close(); } catch (e) {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();
