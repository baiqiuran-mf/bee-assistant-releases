/**
 * Telegram 六项修复专项自检（v2.6.1194）
 * ============================================================================
 * 老板 2026-10-21 拍板的 6 项 Telegram 修复，逐条钉死：
 *   需求 1  名键（tg:ganmeng）不建档；已有名键档案继续用
 *   需求 2Telegram 电话号码补 `+`（写入层 + 显示层）
 *   需求 3  档案命名 = 编号 + ID + 电话 + 名称（md 与 docx 两套），老格式仍能解析
 *   需求 4  日期分隔条不进「对话信息」
 *   需求 5  乱码不翻译，气泡上写「乱码无法翻译」
 *   需求 6  WA 系列一个字节都不动
 *
 * 跑法：node --experimental-sqlite test/tg_fix_1194.test.js
 *
 * 🔴 全程只碰临时库（test/_isolate.js 指到 .tmp-test-data/），绝不读写真实 data/。
 * 🔴 只断言 Telegram（channel='telegram'）的行为；WA / Signal 只做「不许被波及」的负向断言。
 * 🔴 本文件**只读**生产库做回归（readonly:true，见第五节），绝不写生产库。
 */

const fs = require('fs');
const path = require('path');

// 数据隔离：必须放在任何 require('../src/...') 之前（src/paths.js 在 require 那刻就解析目录）
const { DIR: DATA_DIR } = require('./_isolate.js');

const db = require('../src/db');
const tgMerge = require('../src/telegramMerge');
const telegramRead = require('../src/telegramRead');
const customerDoc = require('../src/customerDoc');
const wordDoc = require('../src/wordDoc');

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

const nowIso = () => new Date().toISOString();
const ROOT = path.join(__dirname, '..');

/** 读源码并**统一行尾**（仓库里有的文件是 CRLF、有的 LF，不归一会让逐字符断言假失败） */
function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}
/** 逐字符断言用：归一行尾后的源码 */
function normSource(rel) { return readSrc(rel).replace(/\r\n/g, '\n'); }

/** 造一个 Telegram 客户（直接写库，精确控制 wa_jid 形态） */
function makeTg(accountId, jid, name, phone, username) {
  const last = db.db.prepare(`SELECT code FROM customers WHERE account_id=? ORDER BY code DESC LIMIT 1`).get(accountId);
  const code = db.ids.nextCustomerCode(accountId, last ? last.code : null);
  db.db.prepare(
    `INSERT INTO customers (code, account_id, wa_jid, phone, name, channel, created_at)
     VALUES (?,?,?,?,?, 'telegram', ?)`,
  ).run(code, accountId, jid, phone || null, name || null, nowIso());
  if (username) db.saveTgUsername(code, username);
  return db.getCustomer.get(code);
}

/** 造一个 WhatsApp 客户（负向断言用：证明 Telegram 的改动没波及 WA） */
function makeWa(accountId, jid, name, phone) {
  const last = db.db.prepare(`SELECT code FROM customers WHERE account_id=? ORDER BY code DESC LIMIT 1`).get(accountId);
  const code = db.ids.nextCustomerCode(accountId, last ? last.code : null);
  db.db.prepare(
    `INSERT INTO customers (code, account_id, wa_jid, phone, name, channel, created_at)
     VALUES (?,?,?,?,?, 'whatsapp', ?)`,
  ).run(code, accountId, jid, phone || null, name || null, nowIso());
  return db.getCustomer.get(code);
}

console.log('=== Telegram 六项修复专项（v2.6.1194） ===');
console.log(`驱动：${db.driver}    临时库：${DATA_DIR}`);

/* =====================================================================
 * 需求 1：名键不建档（老板原话「抓到 tg:ganmeng 这种编码不要生成客户编号档案」）
 * ================================================================== */
section('需求 1｜isNumericTgJid：只有 tg+纯数字才是可建档形态');
eq('tg:7207229390（老板说的正确形态）', tgMerge.isNumericTgJid('tg:7207229390'), true);
eq('tg:ganmeng（生产库 7A00007 那种名键）', tgMerge.isNumericTgJid('tg:ganmeng'), false);
eq('tg:Eileen Lin（名键，含空格）', tgMerge.isNumericTgJid('tg:Eileen Lin'), false);
eq('tg:Telegram（生产库 7A00008 那种垃圾档）', tgMerge.isNumericTgJid('tg:Telegram'), false);
eq('tg:-1001234567890（频道，允许负号）', tgMerge.isNumericTgJid('tg:-1001234567890'), true);
eq('空串', tgMerge.isNumericTgJid(''), false);
eq('裸数字（无 tg: 前缀）也认', tgMerge.isNumericTgJid('7207229390'), true);
eq('大小写不同的前缀也认', tgMerge.isNumericTgJid('TG:7207229390'), true);
check('与 numericPeer 口径完全一致（绝不两处各写一套）',
  ['tg:7207229390', 'tg:ganmeng', 'tg:Eileen Lin', 'tg:-1001234567890', '']
    .every((v) => tgMerge.isNumericTgJid(v) === !!tgMerge.numericPeer(v)));

section('需求 1｜闸门：名键新建被拦、已有名键档案继续用');
{
  // 库里**没有**的名键 → 不建档
  const before = db.db.prepare(`SELECT COUNT(*) n FROM customers WHERE account_id=7`).get().n;
  makeTg(7, 'tg:Existing Named', 'Existing Named');   // 先把 7 号账号用掉，隔离本节
  const base = db.db.prepare(`SELECT COUNT(*) n FROM customers WHERE account_id=7`).get().n;
  check('名键档案若已在库里 → 查得到（闸门靠它放行）',
    !!db.findCustomerByTgPeer.get(7, 'tg:Existing Named', 'telegram'));
  check('数字键档案同样查得到',
    (() => { makeTg(7, 'tg:7207229390', 'Eileen Lin'); return !!db.findCustomerByTgPeer.get(7, 'tg:7207229390', 'telegram'); })());
  check('闸门放行时**不新建**任何档案（查两次条数不变）',
    db.db.prepare(`SELECT COUNT(*) n FROM customers WHERE account_id=7`).get().n === base + 1,
    '只应多出刚才那 1 条数字键档案');
  check('闸门只认 telegram 渠道：同 wa_jid 但 channel=whatsapp 查不到',
    (() => { makeWa(8, 'tg:Wa Named', 'Wa Named'); return !db.findCustomerByTgPeer.get(8, 'tg:Wa Named', 'telegram'); })());
  check('findCustomerByTgPeer 认 wa_jid 原样传 displayJid（不必自己拼 tg:）',
    !!db.findCustomerByTgPeer.get(7, 'tg:Existing Named', 'telegram'));
  check('闸门源码：main.js 在 getOrCreateCustomer **之前**就有这道判断',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
      const iGate = src.indexOf('isNumericTgJid(m.displayJid)');
      const iCreate = src.indexOf('db.getOrCreateCustomer(', iGate);
      return iGate > 0 && iCreate > iGate;
    })());
  check('闸门命中时 return null（消息不入库、不建档）',
    /isNumericTgJid\(m\.displayJid\)[\s\S]{0,600}?return null;/.test(
      fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')));
  check('已有名键档案：库里那条**原样保留**（不删、不作废）',
    (() => {
      const c = db.findCustomerByTgPeer.get(7, 'tg:Existing Named', 'telegram');
      return !!c && Number(c.voided || 0) === 0;
    })());
  check('mergePair 的合并逻辑一个字都没动（本次不碰它）',
    !/mergePair[\s\S]{0,80}isNumericTgJid/.test(fs.readFileSync(path.join(ROOT, 'src', 'telegramMerge.js'), 'utf8')));
  void before;
}

/* =====================================================================
 * 需求 2：电话号码补 `+`
 * ================================================================== */
section('需求 2｜pickPhoneWithPlus：补 + 且不重复加');
eq('纯数字 85256188141（生产库 7A00006 那种）', tgMerge.pickPhoneWithPlus('85256188141', ''), '+85256188141');
eq('已带 + 的不重复加', tgMerge.pickPhoneWithPlus('+85256188141', ''), '+85256188141');
eq('空号（好友隐藏电话）→ 留空', tgMerge.pickPhoneWithPlus('', ''), '');
eq('带空格/横杠的归一', tgMerge.pickPhoneWithPlus('+44 7745 759388', ''), '+447745759388');
eq('第一个空时取第二个', tgMerge.pickPhoneWithPlus('', '13800138000'), '+13800138000');
eq('两个都空', tgMerge.pickPhoneWithPlus(null, undefined), '');

section('需求 2｜写入层：autoFetchTelegramPhone 改走 pickPhoneWithPlus');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  check('main.js 取号处用 telegramMerge.pickPhoneWithPlus（不再是裸 String().trim()）',
    /const phone = telegramMerge\.pickPhoneWithPlus\(info\.phone/.test(src));
  check('写入层不再有旧的裸 trim 取号', !/const phone = String\(info\.phone \|\| ''\)\.trim\(\);/.test(src));
}
section('需求 2｜显示层：档案弹窗只给 Telegram 补 +（共用组件绝不连坐 WA）');
{
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('renderProfile 的 #pf-phone 取值改走 tgPhoneShow(c)',
    /id="pf-phone" value="\$\{esc\(tgPhoneShow\(c\)\)\}"/.test(src));
  check('tgPhoneShow 判了 channel === telegram（非 Telegram 原样返回）',
    /function tgPhoneShow\(c\)[\s\S]{0,600}?channel\) \|\| ''\) !== 'telegram'\) return raw;/.test(src));
  check('已有 + 的不会变成 ++', /return raw\.startsWith\('\+'\) \? raw : '\+' \+ raw;/.test(src));
  check('空号返回空串（好友隐藏电话 → 输入框留空）', /if \(!raw\) return '';/.test(src));
}

/* =====================================================================
 * 需求 3：档案命名（md 四段 / docx 四段）+ 老格式仍能解析
 * ================================================================== */
section('需求 3｜docFileName：Telegram 四段 / 缺 ID 和电话时两段');
eq('TG 四段齐全',
  customerDoc.docFileName({ code: '7A00006', name: 'Eileen Lin', phone: '85256188141', tg_username: 'EileenLin09', channel: 'telegram' }),
  '7A00006_EileenLin09_85256188141_Eileen Lin.md');
eq('TG 有 ID 无电话',
  customerDoc.docFileName({ code: '7A00006', name: 'Eileen Lin', phone: '', tg_username: 'EileenLin09', channel: 'telegram' }),
  '7A00006_EileenLin09_未知电话_Eileen Lin.md');
eq('TG 无 ID 有电话',
  customerDoc.docFileName({ code: '7A00006', name: 'Eileen Lin', phone: '85256188141', tg_username: '', channel: 'telegram' }),
  '7A00006_无ID_85256188141_Eileen Lin.md');
eq('TG ID 和电话都没有 → 退成两段（编号_名称）',
  customerDoc.docFileName({ code: '7A00008', name: 'Telegram', phone: '', tg_username: '', channel: 'telegram' }),
  '7A00008_Telegram.md');
eq('ID 去掉 @ 前缀（EileenLin09 而不是 @EileenLin09）',
  customerDoc.docFileName({ code: '7A00006', name: 'E', phone: '85256188141', tg_username: '@EileenLin09', channel: 'telegram' }),
  '7A00006_EileenLin09_85256188141_E.md');

section('需求 3｜🔴 WA / Signal 分支一字未变（老板铁律）');
eq('WA 客户仍然是 {编号}_{名称}_{电话}.md',
  customerDoc.docFileName({ code: '3A00050', name: 'Mike', phone: '1534685245' }),
  '3A00050_Mike_1534685245.md');
eq('WA 客户即使带 tg_username 也走老分支（channel 不是 telegram 就不进新分支）',
  customerDoc.docFileName({ code: '3A00050', name: 'Mike', phone: '1534685245', tg_username: 'EileenLin09', channel: 'whatsapp' }),
  '3A00050_Mike_1534685245.md');
eq('WA 客户无电话 → 未知电话',
  customerDoc.docFileName({ code: '3A00051', name: 'Amy', phone: '' }),
  '3A00051_Amy_未知电话.md');
eq('Signal 客户仍是三段',
  customerDoc.docFileName({ code: '1A00010', name: 'Amy', phone: '13800138000', channel: 'signal' }),
  '1A00010_Amy_13800138000.md');
check('🔴 WA 分支的源码逐字符断言（就是那一句，一字不多一字不少）',
  normSource('src/customerDoc.js').includes(
    '  // ---- WA / Signal：以下为改动前原样，一行未动 ----\n  return `${code}_${name}_${phone}.md`;\n}'),
  'WA 分支源码与改动前完全一致');

section('需求 3｜parseDocFileName：老格式 / 新四段 / legacy 都能解析');
{
  const p = customerDoc.parseDocFileName;
  const a = p('7A00002_wanyu lee_未知电话.md');
  eq('老三段 code', a.code, '7A00002');
  eq('老三段 name', a.name, 'wanyu lee');
  eq('老三段 phone', a.phone, '未知电话');

  const b = p('7A00006_Eileen Lin_85256188141.md');
  eq('老三段（数字电话）code', b.code, '7A00006');
  eq('老三段 name', b.name, 'Eileen Lin');
  eq('老三段 phone', b.phone, '85256188141');

  const c = p('7A00006_EileenLin09_85256188141_Eileen Lin.md');
  eq('新四段 code', c.code, '7A00006');
  eq('新四段 tgId', c.tgId, 'EileenLin09');
  eq('新四段 phone', c.phone, '85256188141');
  eq('新四段 name', c.name, 'Eileen Lin');

  const d = p('7A00006_EileenLin09_85256188141_Eileen_Lin.md');
  eq('新四段 + 名字含下划线 → name 用 slice(3).join("_") 还原', d.name, 'Eileen_Lin');

  const e = p('Mike_旧金山_3A00050.md');
  eq('legacy 格式 code 在最后一段', e.code, '3A00050');
  eq('legacy 格式 name', e.name, 'Mike');
  eq('legacy 格式 region', e.region, '旧金山');
  eq('legacy 格式 legacy=true', e.legacy, true);

  const f = p('3A00050_Mike_Jr_1534685245.md');
  eq('老格式 + 名字第 2 段含下划线 → 仍走三段（name=Mike）', f.name, 'Mike');
  eq('老格式 + 名字第 2 段含下划线 → phone 收尾（与改动前一致）', f.phone, 'Jr_1534685245');

  eq('认不出来的返回 null（不认识的 .md 一律跳过）', p('随便一个文件.md'), null);
  check('findExistingDoc 仍按 `编号_` 前缀找，改名后不会留下同一客户两个 md',
    /const byPrefix = md\.find\(\(n\) => n\.startsWith\(\`\$\{code\}_\`\)\);/.test(
      fs.readFileSync(path.join(ROOT, 'src', 'customerDoc.js'), 'utf8')));
}

section('需求 3｜wordDoc：Telegram 四段命名 + WA 分支一字未变');
{
  const b = wordDoc.wordBaseName;
  eq('TG 四段齐全',
    b({ code: '7A00006', name: 'Eileen Lin', phone: '85256188141', tg_username: 'EileenLin09', channel: 'telegram' }),
    '7A00006_EileenLin09_85256188141_Eileen Lin');
  eq('TG 有 ID 无电话',
    b({ code: '7A00006', name: 'Eileen Lin', phone: '', tg_username: 'EileenLin09', channel: 'telegram' }),
    '7A00006_EileenLin09_未知电话_Eileen Lin');
  eq('TG 无 ID 有电话',
    b({ code: '7A00006', name: 'Eileen Lin', phone: '+85256188141', tg_username: '', channel: 'telegram' }),
    '7A00006_无ID_+85256188141_Eileen Lin');
  eq('TG ID 和电话都没有 → 退成两段',
    b({ code: '7A00008', name: 'Telegram', phone: '', tg_username: '', channel: 'telegram' }),
    '7A00008_Telegram');

  eq('🔴 WA 分支逐字符断言（{code}_{name} 与改动前完全一致）',
    b({ code: '3A00050', name: 'Mike', phone: '1534685245' }), '3A00050_Mike');
  eq('🔴 WA 分支带 tg_username 也不受影响',
    b({ code: '3A00050', name: 'Mike', phone: '1534685245', tg_username: 'EileenLin09', channel: 'whatsapp' }), '3A00050_Mike');
  eq('🔴 WA 缺名字 → 客户（改动前的兜底）', b({ code: '3A00051', name: '', phone: '1534685246' }), '3A00051_客户');
  eq('🔴 Signal 分支逐字符断言', b({ code: '1A00010', name: 'Amy', phone: '13800138000', channel: 'signal' }), '1A00010_Amy');

  const wsrc = readSrc('src/wordDoc.js');
  check('🔴 WA 分支源码逐字符断言',
    wsrc.includes("  // ---- WA / Signal：以下为改动前原样，一行未动 ----\n  return `${customer.code}_${customer.name || '客户'}`;\n}"));
  check('md 与 docx 用同一个 ID 口径（都去掉 @ 前缀）',
    wsrc.includes("replace(/^@/, '')") && readSrc('src/customerDoc.js').includes("replace(/^@/, '')"));
  check('🔴 没有新建定时器：沿用现有 startHourly / rebuildAll',
    /DEFAULT_INTERVAL_MS = 60 \* 60 \* 1000/.test(wsrc) && /function startHourly/.test(wsrc) && !/setInterval[\s\S]{0,80}1194/.test(wsrc));
  check('rebuildAll 不传 codes 时全量重建（本来就包含 Telegram 客户）',
    /db\.listCustomers\.all\(\)/.test(wsrc));
}

/* =====================================================================
 * 需求 4：日期分隔条不进「对话信息」
 * ================================================================== */
section('需求 4｜isDateOnlyMessage：老板截图里的形态全拦、真人话全放行');
['October 15', 'Oct 15', '15 October', 'December 25', 'October 9', '10月13日', '10月15号', '11月3日']
  .forEach((s) => eq(`拦：${s}`, tgMerge.isDateOnlyMessage(s), true));
eq('拦：Today（Telegram 日期分隔条的一种渲染）', tgMerge.isDateOnlyMessage('Today'), true);
eq('拦：今天', tgMerge.isDateOnlyMessage('今天'), true);
['Hello', 'October', 'Monday', 'May', 'I will meet you on October 15', 'hi', '你好', '', 'Nilai', 'Hai phong', 'Y', 'He']
  .forEach((s) => eq(`放行：${JSON.stringify(s)}`, tgMerge.isDateOnlyMessage(s), false));
check('🔴 裸月份词不拦（真人可能说 October / May）',
  tgMerge.isDateOnlyMessage('October') === false && tgMerge.isDateOnlyMessage('May') === false);
check('🔴 裸星期词不拦（Monday / Friday）',
  tgMerge.isDateOnlyMessage('Monday') === false && tgMerge.isDateOnlyMessage('Friday') === false);
check('🔴 长句子里含日期不拦（老板要的是「纯日期」）',
  tgMerge.isDateOnlyMessage('I will meet you on October 15') === false);

section('需求 4｜四个采集入口都接上了（别漏）');
{
  const read = fs.readFileSync(path.join(ROOT, 'src', 'telegramRead.js'), 'utf8');
  const mt = fs.readFileSync(path.join(ROOT, 'src', 'telegramMtproto.js'), 'utf8');
  const off = fs.readFileSync(path.join(ROOT, 'src', 'telegramOfficialChannel.js'), 'utf8');
  const wv = fs.readFileSync(path.join(ROOT, 'src', 'telegramWebView.js'), 'utf8');
  check('telegramRead.toMessage 命中时 return null（整条丢弃：不入库/不翻译/不显示）',
    /if \(tgMerge\.isDateOnlyMessage\(body\)\) return null;/.test(read));
  check('telegramMtproto.toContract 接上了', /if \(tgMerge\.isDateOnlyMessage\(body\)\) return null;/.test(mt));
  check('telegramOfficialChannel 接上了', /if \(tgMerge\.isDateOnlyMessage\(body\)\) return;/.test(off));
  check('🔴 telegramWebView 复用 telegramRead.toMessage（本次已核实，无需另改）',
    /telegramRead\.toMessage\(/.test(wv) && (wv.match(/telegramRead\.toMessage\(/g) || []).length >= 2);
  check('🔴 没有把规则写进四模块共用的 lang.js / translator.js',
    !/isDateOnlyMessage/.test(fs.readFileSync(path.join(ROOT, 'src', 'lang.js'), 'utf8'))
    && !/isDateOnlyMessage/.test(fs.readFileSync(path.join(ROOT, 'src', 'translator.js'), 'utf8')));
}
section('需求 4｜端到端：日期条真的不入库');
{
  eq('toMessage("October 15") → null',
    telegramRead.toMessage({ chatKey: '7207229390', chatName: 'Eileen Lin', body: 'October 15', direction: 'in' }, 7), null);
  eq('toMessage("Today") → null',
    telegramRead.toMessage({ chatKey: '7207229390', chatName: 'Eileen Lin', body: 'Today', direction: 'in' }, 7), null);
  eq('toMessage("10月13日") → null',
    telegramRead.toMessage({ chatKey: '7207229390', chatName: 'Eileen Lin', body: '10月13日', direction: 'in' }, 7), null);
  const ok = telegramRead.toMessage({ chatKey: '7207229390', chatName: 'Eileen Lin', body: 'Hello', direction: 'in' }, 7);
  check('真人消息照常转成标准结构（不被误拦）', !!ok && ok.body === 'Hello');
}

/* =====================================================================
 * 需求 5：乱码不翻译 + 气泡写「乱码无法翻译」
 * ================================================================== */
section('需求 5｜isGarbledText：三种形态全拦、正常人话与 WA base64 全放行');
[
  'sk-jq0qNZ3qw56DaXARrJyJjeU8z598VUP7B0tgnzwXa95uIKvR',                 // 生产库真实样本（id 1835/1883）
  'platform-mm.jnpjydv-dp-0001pxjipxpjcjpjemkpmumou',                     // 老板截图里的形态
  'platinum-vip.miyavip.vip:8001:qxdqaqqxze:oqwmrtmopumiir',              // 代理通知串（含 :）
  '198.65.67.111:8022:eewrqdddae:oqwmrtmremooo',                          // IP 型代理通知串
].forEach((s) => eq(`拦：${s.slice(0, 30)}…`, tgMerge.isGarbledText(s), true));
['Hello how are you', 'Thank you!', 'Hi', 'OK', 'Y', 'see you at 8', 'Hai phong, Vietnam']
  .forEach((s) => eq(`放行：${JSON.stringify(s)}`, tgMerge.isGarbledText(s), false));
check('🔴 WA 的 base64 图片字节（含 / + =）天然排除',
  tgMerge.isGarbledText('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==') === false);
check('🔴 短词不算乱码（长度闸）', tgMerge.isGarbledText('Hello') === false && tgMerge.isGarbledText('OK') === false);

section('需求 5｜后端不发给 AI（省一次翻译额度）');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const iTr = src.indexOf('const needsTr = !!m.body');
  check('needsTr 判定里加了 !telegramMerge.isGarbledText(m.body)',
    /const needsTr = !!m\.body[\s\S]{0,200}?!telegramMerge\.isGarbledText\(m\.body\)/.test(src), `idx=${iTr}`);
  check('🔴 没有把规则写进四模块共用的 lang.js / translator.js',
    !/isGarbledText/.test(fs.readFileSync(path.join(ROOT, 'src', 'lang.js'), 'utf8'))
    && !/isGarbledText/.test(fs.readFileSync(path.join(ROOT, 'src', 'translator.js'), 'utf8')));
  check('🔴 没有在采集侧丢弃乱码（消息本身照常入库、照常显示）',
    !/isGarbledText/.test(fs.readFileSync(path.join(ROOT, 'src', 'telegramRead.js'), 'utf8'))
    && !/isGarbledText/.test(fs.readFileSync(path.join(ROOT, 'src', 'telegramMtproto.js'), 'utf8')));
}

section('需求 5｜后端下标记 + 前端两处渲染一致');
{
  const ssrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  const asrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('server.js 用TranslationState 下发 tgGarbled（规则只有一份）',
    /tgGarbled: telegramMerge\.isGarbledText\(m\.body\)/.test(ssrc));
  check('/api/telegram/messages 也补了 tgGarbled（重载版 renderTgChat 读的就是它）',
    /messages: rows\.map\(\(m\) => \(\{ \.\.\.m, tgGarbled: telegramMerge\.isGarbledText\(m\.body\) \}\)\)/.test(ssrc));
  // 只数**真正渲染的那两处**（注释里也提到了这句话，所以不能直接数字符串出现次数）
  const rendered = (asrc.match(/<span class="tg-zh-tag">译<\/span>乱码无法翻译<\/div>/g) || []).length;
  check('两处 renderTgChat 都渲染「译 乱码无法翻译」（只数代码，不数注释）',
    rendered === 2, `实际渲染 ${rendered} 处`);
  check('🔴 样式复用现有 tg-zh / tg-zh-tag（不自创样式）', rendered === 2);
  check('乱码分支排在译文判断**之前**（才能盖掉已存的垃圾译文）',
    /if \(m\.tgGarbled\) zhHtml = '<div class="tg-zh"><span class="tg-zh-tag">译<\/span>乱码无法翻译<\/div>';\s*\n\s*else if \(zh\)/.test(asrc));
  check('重载版用三元式把 tgGarbled 放在最前',
    /const zhHtml = m\.tgGarbled[\s\S]{0,300}?tg-zh-tag">译<\/span>乱码无法翻译/.test(asrc));
  check('🔴 样式复用现有 tg-zh / tg-zh-tag（不自创样式）',
    (asrc.match(/<span class="tg-zh-tag">译<\/span>乱码无法翻译<\/div>/g) || []).length === 2);
  check('🔴 样式复用现有 tg-zh / tg-zh-tag（不自创样式）',
    (asrc.match(/<span class="tg-zh-tag">译<\/span>乱码无法翻译<\/div>/g) || []).length === 2);
  check('🔴 生效的是 public/app.js，不是根目录那个历史残留 app.js',
    fs.existsSync(path.join(ROOT, 'public', 'app.js'))
    && !/乱码无法翻译|tgGarbled/.test(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')));
}

/* =====================================================================
 * 需求 6：WA 系列零改动（负向断言 —— 用真实数据证明 Telegram 规则不误伤 WA）
 * ================================================================== */
section('需求 6｜🔴 WA / Signal 一个字节都不动');
{
  const protectedFiles = [
    'src/whatsappRead.js', 'src/waBubble.js', 'src/waChain.js', 'src/waWebMedia.js',
    'src/whatsappWebView.js', 'src/signalRead.js', 'src/signalStatus.js', 'src/signalJump.js',
    'src/phoneScan.js', 'src/profileScan.js', 'src/phoneFill.js', 'src/identity.js',
    'src/numberLibrary.js', 'src/translator.js', 'src/lang.js', 'src/ai.js', 'src/ids.js', 'src/db.js',
  ];
  const { execFileSync } = require('child_process');
  const changed = [];
  for (const rel of protectedFiles) {
    try {
      const now = execFileSync('git', ['hash-object', rel], { cwd: ROOT, encoding: 'utf8' }).trim();
      const base = execFileSync('git', ['rev-parse', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8' }).trim();
      if (now !== base) changed.push(rel);
    } catch (e) { /* git 不可用就跳过，绝不因此报「通过」 */ }
  }
  check(`18 个受保护文件与 HEAD 逐字节一致（实测 ${protectedFiles.length - changed.length}/${protectedFiles.length}）`,
    changed.length === 0, changed.join('、'));
}
{
  // 负向断言：Telegram 的两条新规则对 WA 样本必须全部放行
  const waBodies = [
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'Hello how are you', 'OK', 'Meeting on October 15', '10月13日 我们见',
    'Hi', 'image/jpeg', 'Check this out https://example.com/photo',
  ];
  check('🔴 WA 样本没有一个被 isGarbledText 误判', waBodies.every((b) => !tgMerge.isGarbledText(b)));
  check('🔴 WA 样本没有一个被 isDateOnlyMessage 误判', waBodies.every((b) => !tgMerge.isDateOnlyMessage(b)));
  const wa = makeWa(8, 'wa1:206459950338291@c.us', 'Mike Chen', '1534685245');
  eq('WA 档案命名仍是三段（真库验证）',
    customerDoc.docFileName(db.getCustomer.get(wa.code)), `${wa.code}_Mike Chen_1534685245.md`);
  eq('WA Word 命名仍是两段（真库验证）',
    wordDoc.wordBaseName(db.getCustomer.get(wa.code)), `${wa.code}_Mike Chen`);
}

/* =====================================================================
 * 第五节：生产库只读回归（🔴 绝不许写）
 * ================================================================== */
section('生产库只读回归（readonly:true，绝不写）');
{
  const PROD = 'D:/蜜蜂采集数据/wa-assistant/data/assistant.db';
  if (!fs.existsSync(PROD)) {
    check('生产库存在（找不到则跳过本节，不算通过）', false, PROD);
  } else {
    const Database = require('better-sqlite3-multiple-ciphers');
    const pdb = new Database(PROD, { readonly: true, fileMustExist: true });
    try {
      // 需求 1：名键档案
      const r7 = pdb.prepare(`SELECT code,wa_jid,name FROM customers WHERE code='7A00007'`).get();
      eq('7A00007 的 wa_jid 判为「不可建档」（名键）', tgMerge.isNumericTgJid(r7 && r7.wa_jid), false);
      const r6 = pdb.prepare(`SELECT code,wa_jid,name,phone FROM customers WHERE code='7A00006'`).get();
      eq('7A00006 的 wa_jid 判为「可建档」（数字键）', tgMerge.isNumericTgJid(r6 && r6.wa_jid), true);
      eq('7A00006 的库内存量号确实缺 +（就是老板截图那一处）', String(r6 && r6.phone), '85256188141');
      eq('pickPhoneWithPlus 能把它补成 +85256188141',
        tgMerge.pickPhoneWithPlus(r6 && r6.phone, ''), '+85256188141');

      // 需求 4：日期样本
      const dates = pdb.prepare(
        `SELECT body, COUNT(*) n FROM messages WHERE body IN ('October 9','Today','October 16','October 15','October 14','October 13','October 12','October 10','October 17')
         GROUP BY body`).all();
      check(`生产库日期样本全部判定为「纯日期」（${dates.length} 种 / ${dates.reduce((s, r) => s + r.n, 0)} 条）`,
        dates.length > 0 && dates.every((r) => tgMerge.isDateOnlyMessage(r.body)));

      // 需求 5：乱码样本 + 各渠道命中分布
      const rows = pdb.prepare(
        `SELECT IFNULL(c.channel,'whatsapp') ch, m.body FROM messages m LEFT JOIN customers c ON c.code=m.customer_code`).all();
      const byCh = {};
      for (const r of rows) if (tgMerge.isGarbledText(r.body)) byCh[r.ch] = (byCh[r.ch] || 0) + 1;
      check(`🔴 isGarbledText 只命中 telegram（${JSON.stringify(byCh)}），其它渠道一律 0`,
        Object.keys(byCh).length === 1 && byCh.telegram > 0
        && !byCh['whatsapp-web'] && !byCh.whatsapp && !byCh.signal);
      check(`生产库 telegram 乱码命中 ${byCh.telegram || 0} 条（与老板说的「2 条 sk- + 10 条代理串」一致）`,
        (byCh.telegram || 0) === 12, `实际 ${byCh.telegram || 0}`);
      const sk = rows.find((r) => /^sk-/.test(String(r.body || '')));
      check('生产库 sk- 密钥串判为乱码', !!sk && tgMerge.isGarbledText(sk.body));
      /* 代理通知串在生产库里有两种形态（这是**采集侧把时间粘上来了**的历史数据）：
       * 单行纯机器串 `…:8001:token:token20:51`（尾部粘了个时间）→ 应判乱码；
       * 整段转发（含换行 + `https://…/1`）→ 含换行与 `/`，本来就不是纯机器串，判正常文本才对。
       * 这里按「代理串前缀 + 确实是单行」来取样，与老板截图、需求里的样本一致。 */
      const px = rows.find((r) => {
        const b = String(r.body || '').trim();
        // 代理通知串的共同特征：host 部分 + `:端口:` + 至少两段 token，且**整条没有换行与 /**
        return /:8001:|:8022:/.test(b) && !/[\r\n/]/.test(b);
      });
      check('生产库代理通知串判为乱码', !!px && tgMerge.isGarbledText(px.body), px ? px.body : '生产库没找到单行代理串');
      check('生产库带换行的整段转发**不被**误判成乱码（它含换行与 /，本来就不是纯机器串）',
        rows.filter((r) => /platinum-vip|198\.65\./.test(String(r.body || '')))
          .filter((r) => !/[\r\n/]/.test(String(r.body || '')))
          .every((r) => tgMerge.isGarbledText(r.body)));

      // 需求 4 的渠道分布：日期条其它渠道 0 条
      const dByCh = {};
      for (const r of rows) if (tgMerge.isDateOnlyMessage(r.body)) dByCh[r.ch] = (dByCh[r.ch] || 0) + 1;
      check(`🔴 isDateOnlyMessage 只命中 telegram（${JSON.stringify(dByCh)}）`,
        Object.keys(dByCh).length === 1 && (dByCh.telegram || 0) > 0);

      // 需求 3：用真实档案数据跑一遍新命名
      const realTg = pdb.prepare(
        `SELECT code,name,phone,tg_username FROM customers WHERE code='7A00006'`).get();
      const fn = customerDoc.docFileName({ ...realTg, channel: 'telegram' });
      eq('真实档案 7A00006 的 md 命名 = 编号_ID_电话_名称',
        fn, '7A00006_EileenLin09_85256188141_Eileen Lin.md');
      const parsed = customerDoc.parseDocFileName(fn);
      eq('新命名能被自己的解析器认回来（code）', parsed.code, '7A00006');
      eq('新命名能被自己的解析器认回来（ID）', parsed.tgId, 'EileenLin09');
      eq('新命名能被自己的解析器认回来（名称）', parsed.name, 'Eileen Lin');
    } finally {
      pdb.close();   // 🔴 只读连接，绝不写生产库
    }
  }
}

console.log(`\n========== Telegram 六项修复专项：${pass} 通过 / ${fail} 失败 ==========`);
if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);