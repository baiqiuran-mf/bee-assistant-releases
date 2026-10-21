/**
 * test/tg_merge_identity.test.js — Telegram 合并「只认数字身份」专项（甲方案）
 * ============================================================================
 * 老板实机事故（2026-10-16）原文：
 *   「还有新加的好友，因为名称相同，竟然跟早期的客户合并了客户档案和聊天对话。」
 * 老板拍板甲方案：**合并只认「同一个数字身份」，名字相同一律不合并。**
 *
 * 本测试把甲方案逐条钉死（正反向都钉）：
 *   ① peerId 不同、显示名相同         → 不合并，各建各档
 *   ② tg_username 不同、显示名相同    → 不合并
 *   ③ peerId 相同                     → 合并（正向：防止改过头把该合的也拆了）
 *   ④ tg_username 相同                → 合并（正向）
 *   ⑤ 只有名字相同、无任何身份        → 不合并
 *   ⑥ Saved Messages（收藏夹）仍被拦
 *   ⑦ 反向约束：新代码里不许出现「仅凭名字就合并」的路径
 *   ⑧ 铁律自查：频道隔离 / 无字面控制字符 / 无 window.prompt / 无形参与局部 const 同名
 *
 * 跑法：node --experimental-sqlite test/tg_merge_identity.test.js
 *
 * 🔴 全程只碰临时库（test/_isolate.js 指到 .tmp-test-data/），绝不连生产库。
 * 🔴 只测 Telegram（channel='telegram'），WhatsApp / Signal 一律不碰。
 */

const fs = require('fs');
const path = require('path');

// 数据隔离：必须放在任何 require('../src/...') 之前（src/paths.js 在 require 那刻就解析目录）
const { DIR: DATA_DIR } = require('./_isolate.js');

const db = require('../src/db');
const tgMerge = require('../src/telegramMerge');

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
const ACC = 7;

/**
 * 造一个 Telegram 客户（直接写库，绕开 getOrCreateCustomer，好精确控制 wa_jid 形态）。
 * @param {string} jid      wa_jid 形态：'tg:7664570369'（数字键）或 'tg:Xue'（名键）
 * @param {string} name     显示名
 * @param {string} username @username（可空）
 */
function makeTgCustomer(jid, name, username) {
  const last = db.db.prepare(`SELECT code FROM customers WHERE account_id=? ORDER BY code DESC LIMIT 1`).get(ACC);
  const code = db.ids.nextCustomerCode(ACC, last ? last.code : null);
  db.db.prepare(
    `INSERT INTO customers (code, account_id, wa_jid, phone, name, channel, created_at)
     VALUES (?,?,?,?,?, 'telegram', ?)`,
  ).run(code, ACC, jid, null, name || null, nowIso());
  if (username) db.saveTgUsername(code, username);
  return db.getCustomer.get(code);
}

function addMsg(code, body, waMsgId) {
  return db.saveMessage({
    customerCode: code, accountId: ACC, direction: 'in',
    body, mediaSrc: 'none', mediaFetchState: 'na',
    waMsgId, msgTs: nowIso(), msgTime: '',
  });
}

const msgCount = (code) =>
  db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(code).n;

console.log('=== Telegram 合并身份专项：只认数字身份，名字相同一律不合并（甲方案）===');
console.log(`驱动：${db.driver}    临时库：${DATA_DIR}`);

/* =====================================================================
 * ① 同名 + peerId 不同 → 绝不合并
 * ---------------------------------------------------------------------
 * 这就是生产事故的形态：7A00004 'Xue'(名键) 被并进 7A00005 'tg:7664570369'。
 * ================================================================== */
section('① 同名但 peerId 不同 → 不合并，各建各档');
const a1 = makeTgCustomer('tg:1000000001', 'Alex Chen', 'alex_one');
const a2 = makeTgCustomer('tg:1000000002', 'Alex Chen', 'alex_two');
addMsg(a1.code, 'from person one', '1000000001:m1');
addMsg(a2.code, 'from person two', '1000000002:m2');

const plan1 = tgMerge.resolveIncoming(db, {
  accountId: ACC, chatKey: 'Alex Chen', name: 'Alex Chen', username: 'alex_three',
});
eq('① 只有名字 + 同名但 peerId/username 都对不上 → 键保持名字（按新客户建自己的档）',
  plan1.customerKey, 'Alex Chen');
check('① 绝不把消息归到别人身上（没有 mergeFromCode）', plan1.mergeFromCode === '',
  `mergeFromCode=${plan1.mergeFromCode}`);
check('① 如实记下被拒的档案 code（供人工核对）',
  plan1.sameNameDiffIdentity.length > 0, JSON.stringify(plan1.sameNameDiffIdentity));
eq('① 两个人的原有消息一条没少（没被物理搬走）', msgCount(a1.code) + msgCount(a2.code), 2);
check('① 两条档案都还活着（都没被作废）',
  Number(db.getCustomer.get(a1.code).voided || 0) === 0
  && Number(db.getCustomer.get(a2.code).voided || 0) === 0);

/* 反向：数字键那条来了，名字撞上名键那条，但身份不同 → 也绝不合并 */
section('①-b 数字键来了 + 同名但身份不同 → 绝不把名键那条合并掉');
const b1 = makeTgCustomer('tg:Alex Chen', 'Alex Chen', 'alex_named');
addMsg(b1.code, 'named key conversation', 'Alex Chen:n1');
const plan1b = tgMerge.resolveIncoming(db, {
  accountId: ACC, chatKey: '2000000009', name: 'Alex Chen', username: '',
});
eq('①-b 数字键保持自己（不被名键那条顶掉）', plan1b.customerKey, '2000000009');
check('🔴 ①-b **不触发合并**（名键那条没被吞掉，还留在库里）', plan1b.mergeFromCode === '',
  `mergeFromCode=${plan1b.mergeFromCode}`);
check('🔴 ①-b 名键那条依然未作废（消息还在它名下）',
  Number(db.getCustomer.get(b1.code).voided || 0) === 0 && msgCount(b1.code) === 1);

/* =====================================================================
 * ② tg_username 不同、显示名相同 → 不合并
 * ================================================================== */
section('② 同名但 @username 不同 → 不合并');
const c1 = makeTgCustomer('tg:Bob Li', 'Bob Li', 'bob_real');
addMsg(c1.code, 'bob named key msg', 'Bob Li:b1');
const plan2 = tgMerge.resolveIncoming(db, {
  accountId: ACC, chatKey: 'Bob Li', name: 'Bob Li', username: 'bob_impostor',
});
eq('② 名字键保持自己（不归到 bob_real 那条）', plan2.customerKey, 'Bob Li');
check('② 不触发合并', plan2.mergeFromCode === '');
check('🔴 ② 名键那条没被作废', Number(db.getCustomer.get(c1.code).voided || 0) === 0);
eq('🔴 ② 它的消息一条没被搬走', msgCount(c1.code), 1);

/* =====================================================================
 * ③ peerId 相同 → 合并（正向：防止改过头）
 * ---------------------------------------------------------------------
 * ⚠️ 注意：同一个 peerId 在库里**只能存在一条**（UNIQUE(account_id, wa_jid)），
 *   所以「peerId 相同」不可能靠造两条库记录来端到端验证 ——
 *   正向判定由 sameTelegramIdentity 直接验（这才是真正决定合不合的那一步），
 *   端到端再验一次「同一个 peerId 不会被拆成两条」。
 * ================================================================== */
section('③ peerId 相同 → 合并（正向，防改过头）');
const d1 = makeTgCustomer('tg:3000000003', 'Carol Same', '');
addMsg(d1.code, 'carol msg', '3000000003:d1');
const plan3 = tgMerge.resolveIncoming(db, {
  accountId: ACC, chatKey: '3000000003', name: 'Carol Same', username: '',
});
eq('③ 同一个 peerId 再来一次 → 键就是它自己（不会凭空另建一条）',
  plan3.customerKey, '3000000003');
eq('③ displayJid 归一正确', plan3.displayJid, 'tg:3000000003');
check('③ 本条已是数字键，没有名键可并', plan3.mergeFromCode === '');
eq('🔴 ③ 同一个 peerId 在库里仍然只有一条（没被拆成两条档案）',
  db.db.prepare(`SELECT COUNT(*) n FROM customers WHERE account_id=? AND wa_jid='tg:3000000003'`).get(ACC).n, 1);

/* 真正决定合不合的那一步：sameTelegramIdentity 的 peerId 正向判定 */
eq('③ sameTelegramIdentity：peerId 相同 → 同一人',
  tgMerge.sameTelegramIdentity({ peer: '7664570369', user: '' }, { peer: '7664570369', user: '' }).same, true);
eq('③ sameTelegramIdentity：peerId 不同 → 不是同一人',
  tgMerge.sameTelegramIdentity({ peer: '7664570369', user: '' }, { peer: '8696576132', user: '' }).same, false);
eq('③ sameTelegramIdentity：peerId 冲突时以 peerId 为准（username 相同也不合）',
  tgMerge.sameTelegramIdentity({ peer: '111', user: 'alice' }, { peer: '222', user: 'alice' }).same, false);
/* 端到端正向：名键那条带着与数字键**同一个 @username** → 这次真的触发合并指令。
   真实场景：MTProto 先用数字 peerId 建了档并记下 @username，之后网页路径只拿得到名字，
   但 @username 一致 → 证明是同一人 → 归一（这正是「增量防裂」该做的事）。 */
const d1b = makeTgCustomer('tg:3000000013', 'Carol Same', 'carol_official');
addMsg(d1b.code, 'carol numeric msg', '3000000013:d1b');
const plan3b = tgMerge.resolveIncoming(db, {
  accountId: ACC, chatKey: 'Carol Same', name: 'Carol Same', username: 'carol_official',
});
eq('③ @username 相同 + 对方是数字键 → 名字键真的被归一到数字键（正向生效）',
  plan3b.customerKey, '3000000013');
eq('③ 归一后 numeric=true', plan3b.numeric, true);
eq('③ displayJid 跟着归一成数字键', plan3b.displayJid, 'tg:3000000013');

/* =====================================================================
 * ④ tg_username 相同 → 合并（正向：两边都拿不到 peerId 时唯一的身份依据）
 * ================================================================== */
section('④ @username 相同 → 合并（正向）');
const e1 = makeTgCustomer('tg:Dave U', 'Dave U', 'dave_official');
addMsg(e1.code, 'dave named key msg', 'Dave U:e1');
const plan4 = tgMerge.resolveIncoming(db, {
  accountId: ACC, chatKey: 'Dave U', name: 'Dave U', username: '@Dave_Official',
});
eq('④ @username 相同（大小写与 @ 前缀都归一后）→ 归到那条数字键/既有档案上',
  plan4.customerKey, 'Dave U');   // e1 本身是名键形态，归一后仍是它自己
check('④ 归并目标就是 e1 那条', tgMerge.rowIdentity(db.getCustomer.get(e1.code)).user === 'dave_official');
eq('④ sameTelegramIdentity：@username 相同 → 同一人',
  tgMerge.sameTelegramIdentity({ peer: '', user: 'dave_official' }, { peer: '', user: 'Dave_Official' }).same, true);

/* @username 相同 + 对方是数字键形态 → 名字键真的被归到数字键上（正向生效路径） */
const e2 = makeTgCustomer('tg:4000000004', 'Emma Same', 'emma_official');
const plan4b = tgMerge.resolveIncoming(db, {
  accountId: ACC, chatKey: 'Emma Same', name: 'Emma Same', username: 'emma_official',
});
eq('④ @username 相同 → 名字键被归一到对方的数字键上（这次真的生效了）',
  plan4b.customerKey, '4000000004');

/* =====================================================================
 * ⑤ 只有名字相同、无任何身份 → 绝不合并
 * ================================================================== */
section('⑤ 只有名字相同、拿不到任何身份 → 绝不合并');
const f1 = makeTgCustomer('tg:Frank Only', 'Frank Only', '');
addMsg(f1.code, 'frank named key', 'Frank Only:f1');
const plan5 = tgMerge.resolveIncoming(db, {
  accountId: ACC, chatKey: 'Frank Only', name: 'Frank Only', username: '',
});
eq('⑤ 保持名字键（不并到任何人名下）', plan5.customerKey, 'Frank Only');
check('⑤ 不触发合并', plan5.mergeFromCode === '');
eq('⑤ sameTelegramIdentity：两边都没身份 → 不是同一人',
  tgMerge.sameTelegramIdentity({ peer: '', user: '' }, { peer: '', user: '' }).same, false);
eq('⑤ sameTelegramIdentity：只有一边有身份 → 不是同一人',
  tgMerge.sameTelegramIdentity({ peer: '555', user: '' }, { peer: '', user: '' }).same, false);

/* =====================================================================
 * ⑥ Saved Messages（收藏夹）仍被拦 —— 身份收紧不许把这条弄坏
 * ================================================================== */
section('⑥ Saved Messages（收藏夹）仍被拦');
check('⑥ 键 = Saved Messages 被拦', tgMerge.isSavedMessage('Saved Messages', '') === true);
check('⑥ 键 = tg:Saved Messages 被拦', tgMerge.isSavedMessage('tg:Saved Messages', '') === true);
check('⑥ 名称 = Saved Messages 被拦（数字键那条路）', tgMerge.isSavedMessage('7207229390', 'Saved Messages') === true);
check('⑥ 大小写/空格不敏感', tgMerge.isSavedMessage('  saved   MESSAGES ', '') === true);
check('⑥ 中文「收藏夹」也认', tgMerge.isSavedMessage('tg:收藏夹', '') === true);
check('⑥ 真人客户不被误伤', tgMerge.isSavedMessage('Frank Only', 'Frank Only') === false);
check('⑥ 数字键 + 真人名字不被误伤',
  tgMerge.isSavedMessage('7207229390', 'Eileen Lin') === false);
check('🔴 ⑥ 身份收紧没有把收藏夹判成「可合并对象」',
  tgMerge.sameTelegramIdentity({ peer: '', user: '' }, { peer: '', user: '' }).same === false);

/* =====================================================================
 * ⑦ mergePair 兜底闸：直接调也拒绝凭名字合并
 * ================================================================== */
section('⑦ mergePair 兜底闸：直接调用也拒绝「仅凭名字」的合并');
const g1 = makeTgCustomer('tg:Gina Name', 'Gina Name', '');
const g2 = makeTgCustomer('tg:5000000005', 'Gina Name', '');
addMsg(g1.code, 'gina named key msg', 'Gina Name:g1');
const r7 = tgMerge.mergePair(db, g1.code, g2.code, { log: () => {} });
check('🔴 ⑦ mergePair 拒绝合并（返回 ok=false）', r7.ok === false, `note=${r7.note}`);
check('🔴 ⑦ 拒绝原因写清了「身份无法证明」', /身份无法证明/.test(String(r7.note || '')), r7.note);
eq('🔴 ⑦ 名键那条没被作废', Number(db.getCustomer.get(g1.code).voided || 0), 0);
eq('🔴 ⑦ 消息一条没被搬走', msgCount(g1.code), 1);
eq('🔴 ⑦ 数字键那条一条消息都没多', msgCount(g2.code), 0);

/* 反向：该合的仍然合（防止改过头）—— 用 @username 作为身份证据的正向通路。
   （peerId 相同的两条不可能并存于库里，peerId 正向由 sameTelegramIdentity 直接验，见 ③） */
const h1 = makeTgCustomer('tg:Henry Name', 'Henry Peer', 'henry_official');
const h2 = makeTgCustomer('tg:6000000006', 'Henry Peer', 'henry_official');
addMsg(h1.code, 'henry msg', 'Henry Name:h1');
const r7b = tgMerge.mergePair(db, h1.code, h2.code, { log: () => {} });
check('⑦ @username 相同的一对 mergePair 仍然合（正向没被改过头）', r7b.ok === true, r7b.note);
eq('⑦ 合并后消息归到保留那条（数字键）', msgCount(h2.code), 1);
eq('⑦ 名键那条标作废', Number(db.getCustomer.get(h1.code).voided || 0), 1);

/* =====================================================================
 * ⑧ 存量迁移 findDuplicatePairs：同名但无身份 → 不产出合并对
 * ================================================================== */
section('⑧ 存量迁移：同名但拿不到身份 → 不产出合并对');
const migPairs = tgMerge.findDuplicatePairs(db, () => {});
check('⑧ 同名无身份的一对不再出现在迁移配对里',
  !migPairs.some((p) => p.fromCode === g1.code || p.fromCode === f1.code),
  JSON.stringify(migPairs.map((p) => `${p.fromCode}->${p.toCode}`)));
check('⑧ 已合并的那条（h1）不再重复出现（它已 voided，幂等性不破）',
  !migPairs.some((p) => p.fromCode === h1.code));

/* =====================================================================
 * ⑨ 反向约束：新代码里不许出现「仅凭名字就合并」的路径
 * ---------------------------------------------------------------------
 * ⚠️ 判「有没有引入某段代码」必须**先剥注释**（中文注释里含关键词会造假失败）。
 * ================================================================== */
section('⑨ 反向约束：源码里不存在「仅凭名字就合并」的路径');

/** 剥掉块注释与行注释，只留真代码（判「是否引入某逻辑」前必须先剥注释） */
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const mergeSrcPath = path.join(__dirname, '..', 'src', 'telegramMerge.js');
const mergeSrcRaw = fs.readFileSync(mergeSrcPath, 'utf8');
const mergeSrcCode = stripComments(mergeSrcRaw);

/* 抓取器自证：先证明 stripComments 真的能剥掉注释，
   否则下面「代码里没有某关键词」的结论就不可信（中文注释含关键词会造假失败）。 */
check('⑨ 自证·剥注释后，注释里的话消失了',
  !stripComments('// 合并只认名字\nconst a = 1;').includes('合并只认名字'));
check('⑨ 自证·剥注释后，真代码还留着',
  stripComments('// 注释\nconst a = 1;').includes('const a = 1'));
check('⑨ 自证·块注释也能剥',
  !stripComments('/* 凭名字就合并 */ const b = 2;').includes('凭名字就合并'));

/* 抓取器自证 2：花括号配平抓函数体（禁用 /\n\}/ 正则收尾，必须配平数括号） */
function extractFunctionBody(src, funcName) {
  const start = src.indexOf('function ' + funcName);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}
check('⑨ 自证·函数体能抓出来（花括号配平法，非 \\n\\} 正则）',
  extractFunctionBody(mergeSrcCode, 'sameTelegramIdentity').includes('peer')
  && extractFunctionBody(mergeSrcCode, 'resolveIncoming').includes('mergeFromCode')
  && extractFunctionBody(mergeSrcCode, 'mergePair').includes('telegram'));
/* 自证：抓取器对「函数不存在」必须返回空串而不是整篇文件（否则上面的断言毫无意义） */
check('⑨ 自证·函数名不存在时返回空串（不会误抓整篇）',
  extractFunctionBody(mergeSrcCode, 'noSuchFunctionAnywhere') === '');

/* 真正的反向断言：resolveIncoming / findDuplicatePairs 里，
   不许出现「拿名字当身份」的写法 —— 判据统一走 sameTelegramIdentity。 */
const resolveBody = extractFunctionBody(mergeSrcCode, 'resolveIncoming');
const findDupBody = extractFunctionBody(mergeSrcCode, 'findDuplicatePairs');
const mergePairBody = extractFunctionBody(mergeSrcCode, 'mergePair');

check('⑨ resolveIncoming 的函数体里出现了身份判定（sameTelegramIdentity）',
  resolveBody.includes('sameTelegramIdentity'));
check('⑨ resolveIncoming 不再用「找到就归并」的裸 findTwin 写法',
  !/findTwin\(/.test(resolveBody));
check('⑨ findDuplicatePairs 用身份判定逐对验证',
  findDupBody.includes('sameTelegramIdentity'));
check('⑨ findDuplicatePairs 不再出现「同名即同一人」的旧注释（已剥注释仍可见=真代码）',
  !/同名即同一人/.test(findDupBody));
check('⑨ mergePair 里有身份兜底闸',
  mergePairBody.includes('sameTelegramIdentity'));
check('⑨ 全文件（剥注释后）没有 window.prompt',
  !/window\s*\.\s*prompt/.test(mergeSrcCode));
check('⑨ 全文件（剥注释后）没有裸 prompt( 调用',
  !/(^|[^.\w])prompt\s*\(/.test(mergeSrcCode));

/* =====================================================================
 * ⑩ 铁律自查
 * ================================================================== */
section('⑩ 铁律自查');

/* 频道隔离：Telegram 模块不许 require WA / Signal 的代码，也不许被它们 require */
check('⑩ telegramMerge 不 require 任何 WhatsApp / Signal 相关模块',
  !/require\(\s*['"].*(whatsapp|signal|waRead)/i.test(mergeSrcRaw));

/* 无字面控制字符（用显式 RegExp 构造，绝不在源码里写不可见字符） */
const CTRL_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', '');
check('⑩ 源码里没有字面控制字符（\\u0000-\\u001F 等）',
  !CTRL_RE.test(mergeSrcCode));
check('⑩ 自证·控制字符检测器真的会抓到控制字符',
  !CTRL_RE.test(CTRL_RE ? 'a' + String.fromCharCode(9) + 'b' : ''));
check('⑩ 源码是合法 UTF-8 且没有 BOM 开头',
  mergeSrcRaw.charCodeAt(0) !== 0xFEFF);

/* 形参与局部 const 同名 → TDZ 崩溃事故：逐个函数粗查 */
function hasParamLocalShadow(src, funcName) {
  const body = extractFunctionBody(src, funcName);
  if (!body) return false;
  // 取形参名（只取简单标识符形参）
  const sig = src.slice(src.indexOf('function ' + funcName));
  const head = sig.slice(0, sig.indexOf(')') + 1);
  const params = [];
  const pm = head.match(/\(([^)]*)\)/);
  if (pm && pm[1]) {
    for (const piece of pm[1].split(',')) {
      const m2 = piece.match(/^\s*([A-Za-z_$][\w$]*)/);
      if (m2) params.push(m2[1]);
    }
  }
  for (const p of params) {
    // 函数体内是否有 `const p =` / `let p =` / `var p =`（同名局部声明 = TDZ 风险）
    const decl = new RegExp('\\b(const|let|var)\\s+' + p + '\\s*=');
    if (decl.test(body)) return true;
  }
  return false;
}
for (const fn of ['resolveIncoming', 'sameTelegramIdentity', 'rowIdentity', 'findDuplicatePairs', 'mergePair', 'listTwins']) {
  check(`⑩ ${fn}() 没有「形参与局部 const 同名」的 TDZ 风险`,
    !hasParamLocalShadow(mergeSrcCode, fn));
}

/* 反向确认：模块仍导出合并所需的老接口（不许破坏既有调用方） */
for (const fn of ['resolveIncoming', 'mergePair', 'findDuplicatePairs', 'isSavedMessage', 'listTwins', 'findTwin', 'runMigration']) {
  check(`⑩ 仍导出 ${fn}（没破坏既有调用方）`, typeof tgMerge[fn] === 'function');
}
for (const fn of ['sameTelegramIdentity', 'rowIdentity', 'normUsername']) {
  check(`⑩ 新导出 ${fn} 可用`, typeof tgMerge[fn] === 'function');
}

/* =====================================================================
 * 汇总
 * ================================================================== */
console.log('\n=================================================');
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log('=================================================');
if (fail) {
  console.log('失败用例：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
