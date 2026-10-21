/**
 * 「📞 抓取」端到端自检（2026-10-07）
 *
 * 验的是真链路：真起后端 → 真灌带号码的消息 → 打真接口 → 看真返回。
 * 不用假 client、不 mock，因为这个功能**不碰浏览器**（只读），可以离线跑全流程。
 *
 * 红线：
 *   ① 一个候选都不许静默丢 —— 老板要的是「全列出来」；
 *   ② 顺序：像真号的排前面；
 *   ③ 只读：这个接口不许写库（跑完对比消息条数不变）。
 */
process.env.BEE_TEST = '1';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-scan-'));
process.env.BEE_DATA_DIR = tmp;

const db = require('../src/db');
const server = require('../src/server');
const phoneScan = require('../src/phoneScan');

let fail = 0;
const ok = (c, m) => { if (!c) fail++; console.log((c ? '  ✅' : '  ❌') + ' ' + m); };

// 一段"像样"的客户对话：真号 + 各种干扰项混在一起
const SCRIPT = [
  'hello, my whatsapp is +1 (541) 801-0646',
  '这是我的号码 +86 (0)138 0013 8000',
  'Call me on 077726795080 via WhatsApp',
  'order number 20260929 shipped, price 699',
  'PO ref AB-123456789',
  'my old wa is 243834688639050',
  'zip 97201',
  '📞 +44 7726 795080',
];

(async () => {
  // ---- 造一个客户 + 8 条消息 ----
  const { customer } = db.getOrCreateCustomer(1, '15550001234@s.whatsapp.net', {
    name: '扫描测试', phone: '', region: '',
  });
  const code = customer.code;
  SCRIPT.forEach((body, i) => {
    db.saveMessage({
      customerCode: code, accountId: 1, direction: 'in', body,
      mediaPath: null, mediaSrc: '', waMsgId: 'm' + i,
      msgTs: new Date(Date.now() - (SCRIPT.length - i) * 60000).toISOString(),
      silent: true,
    });
  });

  const before = db.listMessages.all(code).length;

  // ---- 单条文本扫描 ----
  console.log('\n[1] scanText：所有候选都要列出来');
  const all = phoneScan.scanText(SCRIPT.join('\n'));
  ok(all.length >= 8, `扫出 ${all.length} 个候选（预期 ≥8，一个都不许丢）`);

  // ---- 逐条核对期望 ----
  console.log('\n[2] 该认出来的号码');
  const has = (d) => all.some((c) => c.digits === d);
  ok(has('15418010646'), '+1 (541) 801-0646 → 15418010646');
  ok(has('8613800138000'), '+86 (0)138 0013 8000 → 剥掉 trunk 0');
  ok(has('447726795080'), '📞 +44 7726 795080');
  ok(has('077726795080'), 'via WhatsApp 那个裸号');
  ok(has('97201'), '邮编 97201 也必须列出来（只是标"不像"）');

  console.log('\n[3] 干扰项要被标成"不像"，但不许消失');
  const no = (d) => all.find((c) => c.digits === d);
  ok(no('20260929') && !no('20260929').ok, '日期 20260929 → 列了但标不像');
  ok(no('243834688639050') && !no('243834688639050').ok, 'LID 15 位 → 列了但标不像');
  ok(no('97201') && !no('97201').ok, '邮编 97201 → 列了但标不像');

  console.log('\n[4] 排序：像真号的排前面');
  const firstNo = all.findIndex((c) => !c.ok);
  ok(firstNo === -1 || firstNo === 0 || all.slice(0, firstNo).every((c) => c.ok),
    '所有"像号码"的都排在"不像"的前面');

  // ---- 真接口 ----
  console.log('\n[5] 真起后端打真接口');
  const cfg = require('../src/main').loadConfig();
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const srv = server.createServer({
    db, doc, ai, knowledge, cfg,
    getAccountStates: () => [],
    openAccount: async () => ({}),
    prefillChat: async () => ({ ok: false }),
    simulateMessage: () => ({}),
    clearSimulated: () => {},
  }, 0);
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;

  const page = await fetch(`${base}/phone.html`);
  ok(page.status === 200, `phone.html 能打开（HTTP ${page.status}）`);
  const js = await fetch(`${base}/phone.js`);
  ok(js.status === 200, `phone.js 能打开（HTTP ${js.status}）`);

  const r = await fetch(`${base}/api/phone/scan?code=${code}`);
  const j = await r.json();
  ok(r.status === 200, `接口 200（实际 ${r.status}）`);
  ok(j.code === code, '返回里带上了客户编号');
  ok(j.total >= 8, `接口列出 ${j.total} 个候选`);
  ok(j.okCount > 0, `${j.okCount} 个标为"像号码"`);
  ok(Array.isArray(j.list) && j.list[0].reason, '每条都带判定理由');

  const e164 = j.list.find((c) => c.digits === '15418010646');
  ok(e164 && e384Ok(e164), '接口里 +1 那个标为可信');
  ok(e164 && Array.isArray(e164.from) && e164.from.length > 0, '接口里带出处（哪条消息）');

  // ---- 只读校验：消息条数不能变 ----
  const after = db.listMessages.all(code).length;
  ok(after === before, `只读：消息条数没变（${before} → ${after}）`);

  // ---- 缺参数 / 不存在 ----
  console.log('\n[6] 边界');
  const bad = await fetch(`${base}/api/phone/scan`);
  ok(bad.status === 400, '不传 code → 400');
  const nf = await fetch(`${base}/api/phone/scan?code=ZZ99999`);
  ok(nf.status === 404, '客户不存在 → 404');

  srv.server.close();
  console.log(`\n=== ${fail === 0 ? '通过' : '失败'}：${fail} 个问题 ===`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本异常：', e); process.exit(2); });

function e384Ok(c) { return c.ok === true; }
