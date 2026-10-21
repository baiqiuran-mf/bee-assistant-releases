/**
 * 「📞 抓取」= 抓**客户资料**里的电话（2026-10-07 v1.0.13）
 *
 * 覆盖两件事：
 *   1) summarize 的判定口径（LID 必须被标成"不是号码"、真号必须被标出来、按可信度排序）
 *   2) 真起后端打真接口，且**只读**（跑完客户档案和消息条数都不能变）
 *
 * 🔴 这个套件专门钉死"抓的是资料不是对话正文"这条 —— 第一版就错在这里。
 */

const path = require('path');
process.env.BEE_TEST = '1';

const db = require('../src/db');
const server = require('../src/server');
const profileScan = require('../src/profileScan');

let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); }
}
function head(t) { console.log('\n=== ' + t + ' ==='); }

(async () => {
  /* ================= 1) 判定口径 ================= */
  head('1. 资料字段的判定');

  const raw = [
    { key: 'contact_id', value: '243834688639050@lid', kind: 'lid' },
    { key: 'contact_number', value: '243834688639050', kind: 'phone' },
    { key: 'contact_phoneNumber', value: '+1 (541) 801-0646', kind: 'phone' },
    { key: 'contact_lid', value: '243834688639050', kind: 'lid' },
    { key: 'lid_lookup', value: '15418010646', kind: 'phone' },
    { key: 'dom_subtitle', value: '+1 (541) 801-0646', kind: 'text' },
    { key: 'dom_header', value: 'Sherry', kind: 'text' },
  ];
  const r = profileScan.summarize(raw, { phone: '15418010646', phone_src: 'e164' });

  ok(r.total === 7, `共列出 ${r.total} 项（期望 7，空字段不占位）`);
  ok(r.okCount === 3, `其中 ${r.okCount} 项判为像真号码（期望 3）`);

  const lidRow = r.fields.find((f) => f.key === 'contact_id');
  ok(!!lidRow, 'LID 也被列出来了（不许静默丢弃）');
  ok(lidRow && lidRow.ok === false, 'LID 不被当成电话号码');
  ok(lidRow && /不是电话号码|隐私/.test(lidRow.reason), 'LID 的理由说清了「不是号码」');

  const lidNum = r.fields.find((f) => f.key === 'contact_number');
  ok(lidNum && lidNum.ok === false, 'contact.number 那串 15 位 LID 数字不算号码');

  const official = r.fields.find((f) => f.key === 'lid_lookup');
  ok(!!official && official.ok, '官方 LID→号码 映射被判为像真号');

  // 可信度排序：官方映射 / Contact.phoneNumber 必须排在裸 LID 前面
  const firstBad = r.fields.findIndex((f) => !f.ok);
  const lastGood = r.fields.map((f) => f.ok).lastIndexOf(true);
  ok(lastGood < firstBad, '像真号的全部排在不像的前面');

  ok(r.fields.some((f) => f.isCurrent), '档案现有号码被标出来了');
  ok(r.fields.some((f) => f.key === 'dom_header' && !f.digits), '昵称这类无数字文字也列了并说明原因');

  head('2. 边界：没有号码 / 全是 LID');
  const empty = profileScan.summarize([], { phone: '' });
  ok(empty.total === 0 && empty.okCount === 0, '资料为空时返回空清单，不报错');

  const allLid = profileScan.summarize([
    { key: 'contact_id', value: '93042480525348@lid', kind: 'lid' },
    { key: 'chat_id', value: '93042480525348@lid', kind: 'lid' },
  ], { phone: '' });
  ok(allLid.total === 2 && allLid.okCount === 0, '全是 LID 时：列出 2 项、0 项像号码');

  head('3. 没有浏览器时不能说崩');
  const noPage = await profileScan.probeProfile(null, 'x@lid');
  ok(noPage.ok === false && noPage.reason === 'no-page', '没有页面时返回 ok:false/no-page，不抛');

  const slow = { evaluate: () => new Promise(() => {}) };
  const timedOut = await profileScan.probeProfile(slow, 'x@lid', { timeoutMs: 60 });
  ok(timedOut.ok === false, '页面卡死时超时返回，不把请求挂住');

  /* ================= 4) 真接口 + 只读 ================= */
  head('4. 真起后端打真接口');

  const { customer } = db.getOrCreateCustomer(1, '243834688639050@lid', {
    name: '资料抓取测试', phone: '', phoneSrc: '', region: '',
  });
  db.saveMessage({
    customerCode: customer.code, accountId: 1, direction: 'in',
    body: '聊天正文里的号码 +86 (0)138 0013 8000', mediaPath: null, mediaSrc: '',
    waMsgId: 'pm1', msgTs: new Date().toISOString(), silent: true,
  });

  const before = {
    phone: db.getCustomer.get(customer.code).phone,
    src: db.getCustomer.get(customer.code).phone_src,
    msgs: db.listMessages.all(customer.code).length,
  };

  // 假浏览器：模拟 page.evaluate 的真实返回形状（{jid, fields, meta, errors}）
  const fakePage = {
    evaluate: async () => ({ jid: '243834688639050@lid', fields: raw, meta: { isLid: true }, errors: [] }),
  };
  let grabCalled = 0;
  const cfg = require('../src/main').loadConfig();
  const srv = server.createServer({
    db,
    doc: require('../src/customerDoc'),
    ai: require('../src/ai'),
    knowledge: require('../src/knowledge'),
    cfg,
    getAccountStates: () => [],
    openAccount: async () => ({}),
    prefillChat: async () => ({ ok: false }),
    simulateMessage: () => ({}),
    clearSimulated: () => {},
    grabProfilePhone: async (code) => {
      grabCalled++;
      const c = db.getCustomer.get(code);
      const probe = await profileScan.probeProfile(fakePage, c.wa_jid);
      const sum = profileScan.summarize(probe.fields, c);
      return { ...sum, ok: true, code, jid: c.wa_jid, isLid: true };
    },
  }, 0);

  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;

  const resp = await fetch(`http://127.0.0.1:${port}/api/phone/profile?code=${customer.code}`);
  const j = await resp.json();
  ok(resp.status === 200, `接口 200（实际 ${resp.status}）`);
  ok(j.ok === true, '返回 ok:true');
  ok(grabCalled === 1, '确实走了 live 抓取（不是读 messages 表）');
  ok(Array.isArray(j.fields) && j.fields.length > 0, `列出 ${(j.fields || []).length} 项资料字段`);
  ok(j.fields.some((f) => f.key === 'lid_lookup'), '含官方 LID→号码 映射');

  // 🔴 只读校验：档案和消息条数都不能变
  const after = {
    phone: db.getCustomer.get(customer.code).phone,
    src: db.getCustomer.get(customer.code).phone_src,
    msgs: db.listMessages.all(customer.code).length,
  };
  ok(after.phone === before.phone, `档案号码没被改（${before.phone || '空'} → ${after.phone || '空'}）`);
  ok(after.src === before.src, 'phone_src 没被改');
  ok(after.msgs === before.msgs, `消息条数没变（${before.msgs} → ${after.msgs}）`);

  const noCode = await fetch(`http://127.0.0.1:${port}/api/phone/profile`);
  ok(noCode.status === 400, '缺 code 返回 400');
  const noCust = await fetch(`http://127.0.0.1:${port}/api/phone/profile?code=ZZZZZZ`);
  ok(noCust.status === 404, '客户不存在返回 404');

  srv.server.close();
  console.log(`\n=== ${fail === 0 ? '通过' : '失败'}：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('崩溃：', e); process.exit(1); });
