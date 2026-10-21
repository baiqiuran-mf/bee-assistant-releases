/**
 * 翻译链路自检（另起进程）
 *
 * 守的是用户这次提的那件事：
 *   「来新消息的时候一般都被 AI 截取了消息，所以都开始在翻译，我们点开查看消息，
 *     如果还没有翻译好，右侧的位置可以有个提醒的信息『等待翻译中』」
 *
 * 也就是说：
 *   1. 消息一到就得进界面 —— 绝对不能等 AI 翻完才通知（以前就是那样，AI 慢的时候像卡住）
 *   2. 还没翻好的时候，接口要如实说「正在翻译」，界面才能挂出「等待翻译中」
 *   3. 翻完要推一条 translated，界面把占位换成中文
 *   4. 本来就是中文的消息【不去调 AI】（省钱，也免得把中文再翻一遍）
 *
 * 做法：把 src/ai 打桩成"能翻、但很慢"（慢到需要测试主动放行），
 * 这样才能稳定地在"翻译中"那个瞬间去检查接口和事件。
 *
 * 跑法：node --experimental-sqlite test/translation_flow.test.js
 */

require('./_isolate.js');

const fs = require('fs');
const path = require('path');

const { DIR } = require('./_isolate.js');
const ROOT = path.join(__dirname, '..');
const PORT = 8983;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + extra : ''}`); }
}
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `实际 ${JSON.stringify(a)} ≠ 期望 ${JSON.stringify(b)}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let srv = null;
  try {
    const ai = require('../src/ai');

    /* ---- 把 AI 打桩成"能翻、但很慢"：等测试放行才返回 ---- */
    let calls = 0;
    let pending = [];
    ai.isReady = () => true;
    ai.providerReady = () => true;
    ai.notConfiguredReason = () => null;
    ai.translate = async (text) => {
      calls++;
      await new Promise((res) => pending.push(() => res()));
      return `（译）${text}`;
    };
    /* v2.6.1149：批量路径走的是 translateBatch（translator.js:238），以前这里没桩 →
     * 落到真的 ai.js，拿 .tmp-test-data/config.yaml 副本里的**真 key 去联网**。
     * 桩的形状跟上面的 ai.translate 保持一致（同样要 releaseAll() 才返回），
     * 这样「AI 很慢、但不联网」的设定不会失真。 */
    ai.translateBatch = async (texts) => {
      calls++; // 一次批量请求 = 一次 AI 调用
      await new Promise((res) => pending.push(() => res()));
      return (Array.isArray(texts) ? texts : []).map((t) => `（译）${t}`);
    };
    /* v2.6.1149：translationMemory 的 AI 准入**唯一出口**就是 callProviderByName
     * （record() → aiDecideKeep()）。不桩它 → 真联网、超时窗口 8s，
     * 而它 await 的位置在 translator 写库那一步之前（translator.js:186 / 248），
     * 会把整条链路拖死：finish() 迟迟不跑，body_zh 一直写不进去。 */
    ai.callProviderByName = async () => 'KEEP';
    const releaseAll = () => { const ps = pending; pending = []; ps.forEach((f) => f()); };

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

    /* ---- 订阅 SSE：界面就是靠这些事件动的 ---- */
    const events = [];
    const ac = new AbortController();
    const sse = await fetch(BASE + '/api/events', { signal: ac.signal });
    (async () => {
      const rd = sse.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(chunk);
            if (!ev) continue; // 心跳 ': ping'
            const da = /^data: (.+)$/m.exec(chunk);
            let data = null;
            try { data = da ? JSON.parse(da[1]) : null; } catch { /* 忽略坏包 */ }
            events.push({ type: ev[1], data });
          }
        }
      } catch (e) { /* abort 或连接关闭 */ }
    })();
    await wait(120);

    /* ============================================================
     *  1) 新消息进来：未读累计（同一个编号只占一格）
     * ============================================================ */
    console.log('\n=== 新消息 · 未读累计 ===');
    const { customer } = db.getOrCreateCustomer(1, '14155550002@c.us', { name: '翻译链路' });
    const code = customer.code;
    const rows = [
      '你好，请问一幅猫的油画多少钱',   // 本来就是中文 → 不该翻
      'hi there, is this still available?',
      'I live on a farm in Oregon',
    ];
    rows.forEach((body, i) => {
      db.saveMessage({ customerCode: code, accountId: 1, direction: 'in', body, waMsgId: `flow-${i}` });
    });
    const msgsOf = () => db.listMessages.all(code);
    eq('连发 3 条 → 未读数累计成 3（不是铺成 3 格）', db.getCustomer.get(code).unread, 3);
    eq('未读总数也跟着涨', db.totalUnread() >= 3, true);

    /* ============================================================
     *  2) 中文不翻 / 英文排进后台队列
     * ============================================================ */
    console.log('\n=== 语种判断 · 中文不翻 ===');
    const zhRow = msgsOf().find((m) => m.body === rows[0]);
    const enRow = msgsOf().find((m) => m.body === rows[1]);
    eq('中文消息不排进翻译队列（不花 AI 调用）', translator.translateLater(zhRow.id, code, zhRow.body, () => {}), false);
    eq('此时一次 AI 都没调', calls, 0);

    console.log('\n=== 先推消息 · 后台翻译 ===');
    let done = null;
    const queued = translator.translateLater(enRow.id, code, enRow.body, (r) => { done = r; });
    eq('英文消息排进后台翻译队列', queued, true);
    eq('队列里查得到这条（界面据此显示「等待翻译中」）', translator.isTranslating(enRow.id), true);
    await wait(10);
    eq('AI 已经被调起来了（后台已开跑）', calls, 1);
    eq('但还没返回 —— translateLater 是立刻返回的，界面不用等它', done, null);

    /* ============================================================
     *  3) "翻译中"这个瞬间：接口必须如实回报
     * ============================================================ */
    console.log('\n=== 翻译中 · 接口回报（界面显示「等待翻译中」）===');
    let r = await api(`/api/customer/${code}`);
    const enState = r.body.messages.find((m) => m.id === enRow.id);
    const zhState = r.body.messages.find((m) => m.id === zhRow.id);
    eq('英文那条：translating=true', enState && enState.translating, true);
    eq('英文那条：还没有译文', enState && !enState.body_zh, true);
    eq('中文那条：不标翻译中、也不标没翻', [zhState.translating, zhState.untranslated], [false, false]);
    check('接口回报还有几条没翻（界面决定要不要提示）', r.body.untranslated >= 1, String(r.body.untranslated));

    /* ============================================================
     *  4) 翻完：写库 + 推 translated（界面把占位换成中文）
     * ============================================================ */
    console.log('\n=== 翻完 · 写库 + 推事件 ===');
    releaseAll();
    await wait(150);
    eq('回调带回中文', done && done.bodyZh, `（译）${rows[1]}`);
    eq('译文写进库了', msgsOf().find((m) => m.id === enRow.id).body_zh, `（译）${rows[1]}`);
    eq('翻完就不再标"翻译中"', translator.isTranslating(enRow.id), false);
    r = await api(`/api/customer/${code}`);
    eq('再查接口：已经带译文了', r.body.messages.find((m) => m.id === enRow.id).body_zh, `（译）${rows[1]}`);

    /* ============================================================
     *  5) 打开客户时补翻译（走真接口）：只补没译文的那几条英文，
     *     翻完必须推 translated —— 界面就靠它把「等待翻译中」换成中文
     * ============================================================ */
    console.log('\n=== 打开客户 · 补翻译没翻的（走 /translate 接口）===');
    const before = calls;
    r = await api(`/api/customer/${code}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max: 10 }),
    });
    eq('接口排上 1 条（中文那条不算，已经翻过的不重复翻）', r.body.queued, 1);
    eq('只调了一次 AI', calls, before + 1);
    releaseAll();
    await wait(250);
    eq('补完之后没有未翻译的客户消息了', translator.untranslatedCount(code), 0);
    check('翻完推出了 translated 事件（界面靠它撤掉「等待翻译中」）',
      events.some((e) => e.type === 'translated' && e.data && e.data.bodyZh),
      JSON.stringify(events.map((e) => e.type)));

    /* ============================================================
     *  6) 点开 = 已看：未读清零，但"待处理"不受影响
     * ============================================================ */
    console.log('\n=== 点开客户 · 未读清零 ===');
    eq('点开前未读还是 3', db.getCustomer.get(code).unread, 3);
    r = await api(`/api/customer/${code}/read`, { method: 'POST' });
    eq('POST /read 成功', r.status === 200 && r.body.ok, true);
    eq('未读清零', db.getCustomer.get(code).unread, 0);
    eq('“待处理”不动（那是回没回复的事）', db.getCustomer.get(code).pending, 1);
    r = await api('/api/customers');
    eq('列表里也不再有未读徽标', r.body.find((c) => c.code === code).unread, 0);

    /* ============================================================
     *  7) 源码级回归：守住"先推后译"，别改回去
     * ============================================================ */
    console.log('\n=== 源码回归 · 别把顺序改回去 ===');
    const mainjs = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    check('handleMessage 里没有 await ai.translate（否则界面要干等 AI 几十秒）',
      !/await\s+ai\.translate\(/.test(mainjs));
    check('先广播 new_message，再把翻译丢后台',
      mainjs.indexOf("broadcastSafe('new_message'") < mainjs.indexOf('translator.translateLater('));
    check('翻完会推 translated 事件', /translateLater\([\s\S]{0,400}broadcastSafe\('translated'/.test(mainjs));

    const srvjs = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
    check('手动录入也走后台翻译（不 await）', !/await\s+ai\.translate\(/.test(srvjs));
    check('补翻译接口翻完也推 translated', /backfill\([\s\S]{0,200}broadcast\('translated'/.test(srvjs));

    ac.abort();
    console.log(`\n========== 翻译链路自检：${pass} 通过 / ${fail} 失败 ==========`);
    if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  } catch (e) {
    console.error('\n[致命错误] 翻译链路自检中断：', e);
    fail++;
  } finally {
    try { srv && srv.server.close(); } catch (e) {}
    try { const db = require('../src/db'); if (db.db && db.db.close) db.db.close(); } catch (e) {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();
