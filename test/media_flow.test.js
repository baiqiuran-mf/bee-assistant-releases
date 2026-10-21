/**
 * 图片 / 语音链路自检（另起进程）
 *
 * 守的是「7 个 AI」里的第 ⑤ ⑥ 个：
 *   ⑤ 客户发来的图片 → AI 用中文说清画面里有什么
 *   ⑥ 客户发来的语音 → 先转成文字，再翻成中文
 * 以及和翻译一样的节奏：消息先上界面，AI 在后台看/听，好了再补上去。
 *
 * 跑法：node --experimental-sqlite test/media_flow.test.js
 */

require('./_isolate.js');

const fs = require('fs');
const path = require('path');

const { DIR } = require('./_isolate.js');
const ROOT = path.join(__dirname, '..');
const PORT = 8984;

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

    /* ---- 打桩：看图/听语音都能返回，且记录被调了几次 ---- */
    let visionCalls = 0;
    let asrCalls = 0;
    let translateCalls = 0;
    let visionReady = true;
    let asrReady = true;
    let asrText = 'Oh my god he is so cute, look at his little paws';
    ai.isReady = (task) => {
      if (task === 'vision') return visionReady;
      if (task === 'asr') return asrReady;
      return true;
    };
    ai.describeImage = async () => { visionCalls++; return '一只橘猫趴在窗台上，眯着眼睛，前爪收在身下'; };
    ai.transcribe = async () => { asrCalls++; return asrText; };
    ai.translate = async (t) => { translateCalls++; return `（译）${t}`; };
    ai.decideTranslate = async () => null;

    const db = require('../src/db');
    const doc = require('../src/customerDoc');
    const knowledge = require('../src/knowledge');
    const media = require('../src/media');
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

    /* ---- SSE：界面靠 translated 事件把「正在看图…」换成中文 ---- */
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
            if (!ev) continue;
            const da = /^data: (.+)$/m.exec(chunk);
            let data = null;
            try { data = da ? JSON.parse(da[1]) : null; } catch { /* 忽略 */ }
            events.push({ type: ev[1], data });
          }
        }
      } catch (e) { /* 连接关闭 */ }
    })();
    await wait(120);

    /* ============================================================
     *  1) 媒体分类：靠扩展名认出是图还是语音
     * ============================================================ */
    console.log('\n=== 媒体分类 ===');
    eq('jpg → 图片', media.kindOf('/x/a_1.jpg'), 'image');
    eq('png → 图片', media.kindOf('/x/a_1.png'), 'image');
    eq('ogg（WhatsApp 语音就是它）→ 语音', media.kindOf('/x/a_1.ogg'), 'audio');
    eq('m4a → 语音', media.kindOf('/x/a_1.m4a'), 'audio');
    eq('mp4 → 视频', media.kindOf('/x/a_1.mp4'), 'video');
    eq('没有媒体 → null', media.kindOf(null), null);
    check('图片和语音 AI 能处理，视频还不能（接口已留）',
      media.canProcess('image') && media.canProcess('audio') && !media.canProcess('video'));

    /* ============================================================
     *  2) 看图：AI 看完写中文说明，进库 + 回调 + 推事件
     * ============================================================ */
    console.log('\n=== ⑤ 看图 ===');
    const { customer: c1 } = db.getOrCreateCustomer(1, '19991110001@c.us', { name: '发图的客户' });
    const imgFile = path.join(DIR, 'test_photo.jpg');
    fs.writeFileSync(imgFile, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // 内容不重要，AI 是打桩的
    const imgRow = db.saveMessage({
      customerCode: c1.code, accountId: 1, direction: 'in',
      body: '[图片/附件]', mediaPath: imgFile, waMsgId: 'm-img-1',
    });

    let done1 = null;
    const queued1 = media.describeLater(imgRow.id, c1.code, imgFile, (r) => { done1 = r; });
    check('图片排上了后台队列', queued1 === true);
    eq('排队期间标着「正在处理」', media.isProcessing(imgRow.id), true);
    await wait(120);
    eq('AI 看了一次图', visionCalls, 1);
    eq('翻完就不再标「正在处理」', media.isProcessing(imgRow.id), false);
    check('回调带回中文说明', !!done1 && /橘猫/.test(done1.mediaZh || ''), JSON.stringify(done1));
    const imgAfter = db.listMessages.all(c1.code).find((m) => m.id === imgRow.id);
    check('中文说明写进库了（media_zh）', /橘猫/.test(imgAfter.media_zh || ''), imgAfter.media_zh);
    eq('这条不再算"还没看"', media.pendingCount(c1.code), 0);

    /* ============================================================
     *  3) 语音：转文字 → 翻中文（英文才翻，中文不翻）
     * ============================================================ */
    console.log('\n=== ⑥ 听语音 ===');
    const { customer: c2 } = db.getOrCreateCustomer(1, '19991110002@c.us', { name: '发语音的客户' });
    const audFile = path.join(DIR, 'test_voice.ogg');
    fs.writeFileSync(audFile, Buffer.from([0x4f, 0x67, 0x67, 0x53]));
    const audRow = db.saveMessage({
      customerCode: c2.code, accountId: 1, direction: 'in',
      body: '[图片/附件]', mediaPath: audFile, waMsgId: 'm-aud-1',
    });
    const beforeTr = translateCalls;
    media.describeLater(audRow.id, c2.code, audFile, () => {});
    await wait(120);
    eq('AI 转写了一次', asrCalls, 1);
    eq('英文语音 → 又多调了一次翻译', translateCalls, beforeTr + 1);
    const audAfter = db.listMessages.all(c2.code).find((m) => m.id === audRow.id);
    check('语音说明也进了库，而且是中文', /（译）/.test(audAfter.media_zh || ''), audAfter.media_zh);

    // 客户本来就说中文：转写出来是中文 → 不再浪费一次翻译
    asrText = '你好我想问一下画一只狗多少钱';
    const audRow2 = db.saveMessage({
      customerCode: c2.code, accountId: 1, direction: 'in',
      body: '[图片/附件]', mediaPath: audFile, waMsgId: 'm-aud-2',
    });
    const beforeTr2 = translateCalls;
    media.describeLater(audRow2.id, c2.code, audFile, () => {});
    await wait(120);
    eq('中文语音【不】再调翻译', translateCalls, beforeTr2);
    const audAfter2 = db.listMessages.all(c2.code).find((m) => m.id === audRow2.id);
    eq('直接存原话', audAfter2.media_zh, '你好我想问一下画一只狗多少钱');

    /* ============================================================
     *  4) 不该排队的：AI 没配 / 文件不在 / 视频
     * ============================================================ */
    console.log('\n=== 不该排队的 ===');
    visionReady = false;
    check('⑤ 看图没配好 → 不排队（界面挂"未配置"，不会一直转圈）',
      media.describeLater(imgRow.id + 999, c1.code, imgFile, () => {}) === false);
    visionReady = true;
    check('文件其实不在 → 不排队',
      media.describeLater(imgRow.id + 999, c1.code, path.join(DIR, 'nope.jpg'), () => {}) === false);
    const vidFile = path.join(DIR, 'test_clip.mp4');
    fs.writeFileSync(vidFile, Buffer.from([0x00]));
    const vidRow = db.saveMessage({
      customerCode: c1.code, accountId: 1, direction: 'in',
      body: '[视频]', mediaPath: vidFile, waMsgId: 'm-vid-1',
    });
    check('⑦ 视频暂时不排队（接口留着，还没接）',
      media.describeLater(vidRow.id, c1.code, vidFile, () => {}) === false);

    /* ============================================================
     *  5) 接口：界面要能知道"这条图还没看"
     * ============================================================ */
    console.log('\n=== 接口 · 媒体状态 ===');
    const { customer: c3 } = db.getOrCreateCustomer(1, '19991110003@c.us', { name: '接口用客户' });
    const imgRow3 = db.saveMessage({
      customerCode: c3.code, accountId: 1, direction: 'in',
      body: '[图片/附件]', mediaPath: imgFile, waMsgId: 'm-img-3',
    });
    let r = await api(`/api/customer/${c3.code}`);
    let m3 = r.body.messages.find((m) => m.id === imgRow3.id);
    eq('接口说这是图片', m3.mediaKind, 'image');
    eq('接口说"还没看"（界面据此挂「正在看图…」）', m3.mediaWaiting, true);
    eq('客户维度也有"还有几张没看"的计数', r.body.mediaPending, 1);

    const beforeQ = visionCalls;
    r = await api(`/api/customer/${c3.code}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max: 12 }) });
    check('打开客户会顺手把没看的图排上队', r.status === 200 && r.body.mediaQueued >= 1, r.body);
    await wait(200);
    eq('补看真的调了 AI', visionCalls, beforeQ + 1);

    const ev = events.find((e) => e.type === 'translated' && e.data && e.data.msgId === imgRow3.id);
    check('推了 translated 事件，里面带着图片的中文说明（界面靠它换掉占位）',
      !!ev && /橘猫/.test(ev.data.mediaZh || ''), JSON.stringify(ev && ev.data));

    r = await api(`/api/customer/${c3.code}`);
    m3 = r.body.messages.find((m) => m.id === imgRow3.id);
    eq('再看接口：已经有中文说明了', /橘猫/.test(m3.media_zh || ''), true);
    eq('也不再标"还没看"', m3.mediaWaiting, false);
    eq('客户维度清零', r.body.mediaPending, 0);

    /* ============================================================
     *  6) 源码回归：别把顺序改回去
     * ============================================================ */
    console.log('\n=== 源码回归 · 顺序 ===');
    const mainjs = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    check('先广播 new_message，再把图片/语音丢后台（界面不用等 AI 看图）',
      mainjs.indexOf("broadcastSafe('new_message'") < mainjs.indexOf('media.describeLater('));
    check('看图/听语音没有任何 await（不许卡住消息链路）',
      !/await\s+media\.describeLater/.test(mainjs));
    const aix = fs.readFileSync(path.join(ROOT, 'src', 'ai.js'), 'utf8');
    check('地址规范化在（去引号 / 去误拼的 /chat/completions / 补 /v1）',
      aix.includes('function cleanBase') && aix.includes('ENDPOINT_SUFFIX'));
    check('报错里带"请求地址"（404 一眼看出问题）', aix.includes('请求地址'));

    console.log(`\n========== 图片语音自检：${pass} 通过 / ${fail} 失败 ==========`);
    if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
    try { ac.abort(); } catch (e) {}
  } catch (e) {
    console.error('\n[致命错误] 媒体自检中断：', e);
    fail++;
  } finally {
    try { srv.server.close(); } catch (e) {}
    try { require('../src/db').db.close(); } catch (e) {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();
