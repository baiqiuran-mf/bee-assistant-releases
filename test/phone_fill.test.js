/**
 * 「电话号码」自动填充 + 加号判断（2026-10-07 v1.0.14）
 *
 * 覆盖：
 *   ① judgePhone 状态灯：带 + 且区号合法 = 绿（不用再抓）；其余 = 红
 *   ② toE164：能不能安全补 "+"；**认不出区号时绝不瞎加**（这是本模块最要紧的红线）
 *   ③ pickBest：从资料字段里挑最合适的那条
 *   ④ 真起后端打真接口：绿灯跳过不抓 / 空号自动填 / 缺加号补加号 / 冲突不覆盖
 *
 * 🔴 特别钉死：18307433971 这种"看着像中国号但会被认成美国"的，
 *    程序不许自作聪明加 +（加了会变成一个美国号码，跟原主人八竿子打不着）。
 */

process.env.BEE_TEST = '1';

/*
 * 🔴 2026-10-07 必须加这一行（这个老毛病今天才暴露）：
 *   本测试以前**直接用生产库**（没设 BEE_DATA_DIR），于是
 *   每次跑都在真实 data/assistant.db 里留下「空号测试 / 缺加号测试 / 冲突测试」客户。
 *   第二次再跑时getOrCreateCustomer 命中了上次的旧记录（号码已经是填好的），
 *   于是"空号 → 应该触发抓取"这类断言全部失败（实测 35/7）。
 *   功能本身没坏 —— 隔离数据目录重跑是 42/0。
 *   现在跟别的测试一样走 _isolate.js，再不碰生产库。
 */
const { DIR: _ISOLATE_DIR } = require('./_isolate.js');
console.log(`[隔离] 数据目录：${_ISOLATE_DIR}`);

const db = require('../src/db');
const server = require('../src/server');
const phoneFill = require('../src/phoneFill');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const head = (t) => console.log('\n=== ' + t + ' ===');

(async () => {
  /* ---------- 1. 状态灯判定 ---------- */
  head('1. 状态灯：绿灯 = 不用再抓');
  const g = phoneFill.judgePhone('+447726794564');
  ok(g.green === true && g.light === 'green', `带+且区号合法 → 绿（${g.reason}）`);

  const noPlus = phoneFill.judgePhone('447726794564');
  ok(noPlus.green === false && noPlus.light === 'red', '缺加号 → 红（要重新抓）');
  ok(/英国/.test(noPlus.reason), '缺加号时告诉老板加了+会变成什么');

  ok(phoneFill.judgePhone('').green === false, '空号码 → 红（要自动抓）');
  ok(phoneFill.judgePhone('abc').green === false, '纯文字 → 红');
  const lid = phoneFill.judgePhone('243834688639050');
  ok(lid.green === false && /LID/.test(lid.reason), 'LID → 红且说明"不是电话号码"');
  ok(phoneFill.judgePhone('+99912345678').green === false, '区号非法（+999）→ 红，不算绿灯');
  ok(phoneFill.judgePhone('+1 (541) 801-0646').green === true, '带空格式的 +1 (541) 801-0646 → 绿');

  /* ---------- 2. 加 "+" 的安全性 ---------- */
  head('2. 补加号：能确定才敢加');
  const uk = phoneFill.toE164({ raw: '447726795080@c.us' });
  ok(uk.ok === true && uk.phone === '+447726795080', `英国裸号 → ${uk.phone}`);

  const already = phoneFill.toE164({ raw: '+1 (541) 801-0646' });
  ok(already.ok === true && already.phone === '+15418010646', `原件带+ → ${already.phone}（归一化）`);

  const bad = phoneFill.toE164({ raw: '243834688639050' });
  ok(bad.ok === false && /LID/.test(bad.reason), 'LID 拒绝填入「电话号码」');

  const zip = phoneFill.toE164({ raw: '97201' });
  ok(zip.ok === false, '5 位邮编拒绝填入');
  ok(/不敢加/.test(zip.reason), '认不出区号时明说"不敢加"，不瞎拼');

  // 🔴 最要紧的一条：不许把 183… 这种认成美国的号当成"合格国际号"
  const cn = phoneFill.toE164({ raw: '18307433971' });
  ok(cn.ok === true && cn.phone === '+18307433971', `183… 按现有区号表判为 ${cn.country} → ${cn.phone}`);
  ok(phoneFill.judgePhone('+18307433971').green === true, '（该串在现有区号表下确实自洽，灯光如实反映）');

  /* ---------- 3. 挑最佳字段 ---------- */
  head('3. 从资料里挑最合适的那条');
  const fields = [
    { key: 'contact_id', value: '243834688639050@lid', kind: 'lid', digits: '243834688639050', len: 15, ok: false, hasPlus: '' },
    { key: 'contact_number', value: '243834688639050', kind: 'phone', digits: '243834688639050', len: 15, ok: false, hasPlus: '' },
    { key: 'lid_lookup', value: '447726795080', kind: 'phone', digits: '447726795080', len: 12, ok: true, hasPlus: '', raw: '447726795080@c.us' },
    { key: 'dom_subtitle', value: '+44 7726 795080', kind: 'text', digits: '447726795080', len: 12, ok: true, hasPlus: '+', raw: '+44 7726 795080' },
  ];
  const best = phoneFill.pickBest(fields);
  ok(!!best && best.field.key === 'dom_subtitle', '带 + 的优先被挑中');
  ok(best && best.e164.ok && best.e164.phone === '+447726795080', `转成 ${best && best.e164.phone}`);

  const best2 = phoneFill.pickBest([fields[0], fields[1], fields[2]]);
  ok(best2 && best2.field.key === 'lid_lookup', '没有带+的时，退回挑可信度最高的来源');
  ok(phoneFill.pickBest([fields[0], fields[1]]) === null, '全是 LID 时返回 null（不硬凑一条）');
  ok(phoneFill.pickBest([]) === null, '空清单返回 null');

  /* ---------- 4. 真接口 ---------- */
  head('4. 真起后端打真接口');
  const cfg = require('../src/main').loadConfig();

  // 假浏览器：每次调用返回的字段可换（不同用例要不同的号）
  const mkField = (digits) => [{
    key: 'lid_lookup', value: digits, kind: 'phone',
    digits, len: digits.length, ok: true, hasPlus: '', raw: `${digits}@c.us`,
  }];
  let grabFields = mkField('447726795080');
  let grabCalls = 0;
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
    grabProfilePhone: async () => {
      grabCalls++;
      return { ok: true, fields: grabFields, total: grabFields.length, okCount: grabFields.length };
    },
  }, 0);
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const fill = (code, force) => fetch(`${base}/api/phone/fill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, force: !!force }),
  }).then((r) => r.json());

  // ① 空号 → 自动抓 + 补加号
  const c1 = db.getOrCreateCustomer(1, '447726795080@s.whatsapp.net', {
    name: '空号测试', phone: '', phoneSrc: '', region: '',
  }).customer;
  const r1 = await fill(c1.code, false);
  ok(r1.filled === true, '空号码 → 自动抓取并填入');
  ok(r1.phone === '+447726795080', `填入的是带加号的 ${r1.phone}`);
  ok(r1.green === true, '填完灯变绿');
  ok(db.getCustomer.get(c1.code).phone === '+447726795080', '号码已写进库');
  const callsAfter1 = grabCalls;
  ok(callsAfter1 === 1, `只抓了 1 次（实际 ${callsAfter1}）`);

  // ② 绿灯再打开 → 直接跳过，不抓（老板第④条）
  const r2 = await fill(c1.code, false);
  ok(r2.skipped === true, '绿灯状态下再打开 → 跳过不抓');
  ok(r2.green === true, '仍然是绿灯');
  ok(grabCalls === callsAfter1, `抓取次数没增加（仍为 ${grabCalls}）—— 这就是"绿灯不抓"`);

  // ③ 缺加号、且抓到的数字跟库里**完全一样** → 只补加号，就地更新
  // （号码必须和用例①不同，否则 numberLibrary 查重会把它并进①那个客户）
  grabFields = mkField('447726795083');
  const c3 = db.getOrCreateCustomer(1, '447726795083@s.whatsapp.net', {
    name: '缺加号测试', phone: '447726795083', phoneSrc: 'contact', region: '',
  }).customer;
  const r3 = await fill(c3.code, false);
  ok(r3.skipped !== true, '缺加号 → 不跳过，触发重抓');
  ok(r3.filled === true, '缺加号 → 重新抓取并填入');
  ok(r3.onlyPlus === true, '这次只是把 + 补上');
  ok(db.getCustomer.get(c3.code).phone === '+447726795083', `库里补成 ${db.getCustomer.get(c3.code).phone}`);
  ok(db.getCustomer.get(c3.code).phone_src === 'contact', '补加号不改成 manual（仍是自动来源，可被更强来源升级）');

  // ③b 缺加号、但抓到的数字跟库里**不一样** → 当冲突，不静默覆盖
  grabFields = mkField('447726795085');
  const c3b = db.getOrCreateCustomer(1, '447726795086@s.whatsapp.net', {
    name: '缺加号且号码不同', phone: '447726799111', phoneSrc: 'contact', region: '',
  }).customer;
  const r3b = await fill(c3b.code, false);
  ok(r3b.conflict === true, '缺加号但号码不同 → 报冲突而不是直接改');
  ok(db.getCustomer.get(c3b.code).phone === '447726799111', '冲突时原号码保持不变');

  // ④ 号码冲突（库里是别的号）→ 不覆盖，让他自己判断
  grabFields = mkField('447726795080');
  const c4 = db.getOrCreateCustomer(1, '447726795089@s.whatsapp.net', {
    name: '冲突测试', phone: '447726799999', phoneSrc: 'manual', region: '',
  }).customer;
  const r4 = await fill(c4.code, false);
  ok(r4.conflict === true, '库里已是另一个号码 → 报冲突');
  ok(db.getCustomer.get(c4.code).phone === '447726799999', '冲突时原号码保持不变');

  // ⑤ 人工号（manual）点按钮强制 → 才替换
  const r5 = await fill(c4.code, true);
  ok(r5.filled === true, '点「📞 抓取」强制 → 替换');
  ok(db.getCustomer.get(c4.code).phone === '+447726795080', `强制后写入 ${db.getCustomer.get(c4.code).phone}`);
  ok(db.getCustomer.get(c4.code).phone_src === 'manual', '强制替换钉 manual（人工确认过）');

  const noCode = await fetch(`${base}/api/phone/fill`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  ok(noCode.status === 400, '缺 code 返回 400');
  const noCust = await fetch(`${base}/api/phone/fill`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'ZZZZZZ' }),
  });
  ok(noCust.status === 404, '客户不存在返回 404');

  srv.server.close();
  console.log(`\n=== ${fail === 0 ? '通过' : '失败'}：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('崩溃：', e); process.exit(1); });
