/**
 * 手动录入通道测试
 *
 * 覆盖：不连 WhatsApp / Signal 客户粘贴对话进来，走同一条链路（入库 → 翻译 → 建档案 → 能出建议）。
 * 不联网、不需要 API key。
 * 跑法：node --experimental-sqlite test/manual.test.js
 */

// 数据隔离：本测试只写临时目录，绝不碰真实 data/
require('./_isolate.js');

const db = require('../src/db');
const { createServer } = require('../src/server');

const PORT = 8903;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  << ' + extra}`);
  cond ? pass++ : fail++;
}
function eq(name, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  check(name, ok, ok ? '' : `实际 ${JSON.stringify(a)} ≠ 期望 ${JSON.stringify(b)}`);
}

/* ---------------- 假依赖 ---------------- */

const translated = [];
const extractedCalls = [];
const fakeAi = {
  isReady: () => true,
  notConfiguredReason: () => null,
  translate: async (t) => {
    translated.push(t);
    return `（译）${t}`;
  },
  // 同客户多条短消息现在合并成一次批量请求（src/translator.js 的提速改造），
  // 假 AI 必须也实现 translateBatch，否则批量那条路直接抛错 → 消息永远没译文。
  translateBatch: async (texts) => {
    (texts || []).forEach((t) => translated.push(t));
    return (texts || []).map((t) => `（译）${t}`);
  },
  extractProfile: async (convText, existing) => {
    extractedCalls.push(convText);
    return {
      ...(existing || {}),
      姓名: '农场主',
      地区: '俄勒冈',
      电话号码: '+15419000088',
      时区: 'America/Los_Angeles',
      阶段: 2,
      加入时间: '',
      // 附加字段：server 会按 EXTRA_PROFILE_KEYS 白名单把它们收进 profile_json
      宠物: '橘猫一只',
      爱好: '打理农场',
    };
  },
  // server 读这个常量做白名单；注入的假 ai 必须一起给，否则整段抽取流程会崩
  EXTRA_PROFILE_KEYS: ['婚姻情况', '生活规律', '别名', '老家家乡', '爱好', '职业', '家庭经济情况', '父母', '宠物', '孩子'],
  // 需求②：返回「分组」结构（每条客户留言一组，组内 3 条）
  suggest: async (payload) => {
    const groupsIn = (payload && Array.isArray(payload.groups)) ? payload.groups : [{ index: 0, text: '客户留言' }];
    return {
      groups: groupsIn.map((g, i) => ({
        index: i,
        message: g.text || '客户留言',
        options: [
          { angle: 'empathy', text: '测试建议' },
          { angle: 'story', text: '测试建议2' },
          { angle: 'nudge', text: '测试建议3' },
        ],
      })),
      rationale: '',
      riskFlags: [],
    };
  },
};

/* 上面那份 fakeAi 只注进了 server 的依赖位；但"后台翻译"走的是
 * src/translator → require('./ai')（真模块），不是这个注入对象。
 * 所以真 ai 模块的几个函数也得换成假的，否则 needsTranslation 过了、
 * 真发请求时没 key → 直接不翻 → 「客户消息被翻译」永远为假。 */
{
  const realAi = require('../src/ai');
  realAi.isReady = () => true;
  realAi.notConfiguredReason = () => null;
  realAi.translate = async (t) => {
    translated.push(t);
    return `（译）${t}`;
  };
  realAi.translateBatch = async (texts) => {
    (texts || []).forEach((t) => translated.push(t));
    return (texts || []).map((t) => `（译）${t}`);
  };
}

const docWrites = [];
const fakeDoc = {
  writeCustomerDoc: (c) => {
    docWrites.push(c.code);
    return 'x.md';
  },
  findExistingDoc: () => null,
  guessTimezone: (r) => (r === '旧金山' ? 'America/Los_Angeles' : null),
};

const fakeKnowledge = { buildBlocks: () => ({ text: '', always: [], matched: [] }) };
const cfg = { app: { autoTranslate: true } };

const { server, handleManual, normalizeJid, parseLines } = createServer(
  { db, doc: fakeDoc, ai: fakeAi, knowledge: fakeKnowledge, cfg, getAccountStates: () => [] },
  PORT
);

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, data: await r.json() };
};

/* ---------------- 纯函数 ---------------- */

console.log('=== 标识归一化 ===');
eq('纯数字手机号 → @c.us', normalizeJid('14155552671'), '14155552671@c.us');
eq('带 + 号去掉', normalizeJid('+14155552671'), '14155552671@c.us');
eq('Signal 用户名 → manual:', normalizeJid('duomi.88'), 'manual:duomi.88');
eq('中文昵称 → manual:', normalizeJid('旧金山 Mike'), 'manual:旧金山 Mike');
eq('已带域名原样返回', normalizeJid('14155552671@s.whatsapp.net'), '14155552671@s.whatsapp.net');
eq('空值返回 null', normalizeJid(''), null);

console.log('\n=== 粘贴文本分行 ===');
eq(
  '按「我:」分方向',
  parseLines('Hi there\n我: hey!\nDo you do cats?'),
  [
    { direction: 'in', body: 'Hi there' },
    { direction: 'out', body: 'hey!' },
    { direction: 'in', body: 'Do you do cats?' },
  ]
);
eq('英文 me: 也认', parseLines('me: ok'), [{ direction: 'out', body: 'ok' }]);
eq('全角冒号也认', parseLines('我：收到'), [{ direction: 'out', body: '收到' }]);
eq('空行被过滤', parseLines('a\n\n\nb'), [
  { direction: 'in', body: 'a' },
  { direction: 'in', body: 'b' },
]);
eq('空文本返回空数组', parseLines(''), []);

/* ---------------- 起服务跑链路 ---------------- */

(async () => {
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res));

  const IDENT = 'manual-test-signal-user';
  const jid = normalizeJid(IDENT);

  // 清掉上一轮残留（按 wa_msg_id 前缀清，避免唯一键占住）
  db.db.prepare("DELETE FROM messages WHERE wa_msg_id LIKE 'manual:%'").run();
  db.db.prepare('DELETE FROM customers WHERE wa_jid=?').run(jid);

  console.log('\n=== 首次录入：新建客户 ===');
  const r1 = await post('/api/manual', {
    ident: IDENT,
    name: 'Signal Mike',
    region: '旧金山',
    body: 'Hi, I saw your work\n我: hey thanks!\nmy cat passed away last month',
  });
  eq('返回 200', r1.status, 200);
  eq('新建客户', r1.data.isNew, true);
  eq('录入 3 条', r1.data.count, 3);
  check('编号已分配', /^\d[A-Z]\d{5}$/.test(r1.data.code || ''), r1.data.code);

  const code = r1.data.code;
  // 翻译是「先入库、后台排队翻」（src/translator.js），不是同步做完的：
  // 等它补上译文再断言，否则会在竞态里假失败。
  for (let i = 0; i < 60; i++) {
    const list = db.listMessages.all(code);
    if (list.filter((m) => m.direction === 'in').every((m) => m.body_zh)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const msgs = db.listMessages.all(code);
  eq('消息数 3', msgs.length, 3);
  eq('方向依次为 in/out/in', msgs.map((m) => m.direction), ['in', 'out', 'in']);
  eq('客户消息被翻译', msgs.filter((m) => m.direction === 'in').every((m) => m.body_zh), true);
  eq('自己发的没翻译（省成本）', msgs.filter((m) => m.direction === 'out').every((m) => !m.body_zh), true);
  eq('地区写入', r1.data.customer.region, '旧金山');
  eq('时区自动补', r1.data.customer.timezone, 'America/Los_Angeles');
  check('生成了档案文档', docWrites.includes(code), JSON.stringify(docWrites));
  eq('待处理=1（有客户新消息）', r1.data.customer.pending, 1);

  console.log('\n=== 第二次录入：同一标识复用同一客户 ===');
  const r2 = await post('/api/manual', {
    ident: IDENT,
    body: '我: I painted cats for 3 years\nHow much for 16x20?',
  });
  eq('不是新客户', r2.data.isNew, false);
  eq('同一编号', r2.data.code, code);
  eq('又录 2 条', r2.data.count, 2);
  eq('累计 5 条', db.listMessages.all(code).length, 5);

  console.log('\n=== 单行按 direction 走 ===');
  const r3 = await post('/api/manual', { ident: IDENT, direction: 'out', body: 'sure, let me check' });
  eq('记录为我发出', db.listMessages.all(code).slice(-1)[0].direction, 'out');

  console.log('\n=== 重复内容去重 ===');
  const before = db.listMessages.all(code).length;
  const r4 = await post('/api/manual', { ident: IDENT, direction: 'out', body: 'sure, let me check' });
  eq('重复条目被忽略', r4.data.count, 0);
  eq('消息数没变', db.listMessages.all(code).length, before);

  const r4b = await post('/api/manual', { ident: IDENT, direction: 'out', body: 'sure, let me check', dedupe: false });
  eq('dedupe:false 时允许重复', r4b.data.count, 1);
  eq('消息数 +1', db.listMessages.all(code).length, before + 1);

  console.log('\n=== 参数校验 ===');
  eq('缺标识 → 400', (await post('/api/manual', { body: 'hi' })).status, 400);
  eq('缺内容 → 400', (await post('/api/manual', { ident: 'x' })).status, 400);
  eq('空白内容 → 400', (await post('/api/manual', { ident: 'x', body: '   \n  ' })).status, 400);

  console.log('\n=== 关掉翻译也能录 ===');
  const r5 = await post('/api/manual', { ident: IDENT, body: 'one more question', translate: false });
  eq('入库成功', r5.data.count, 1);
  eq(
    '这条没翻译',
    db.listMessages.all(code).slice(-1)[0].body_zh,
    null
  );

  console.log('\n=== 录入后能直接出建议 ===');
  const s = await post(`/api/customer/${code}/suggest`, { attempt: 0 });
  eq('建议接口 200', s.status, 200);
  check('返回了建议', (s.data.groups || []).flatMap((g) => g.options || []).length > 0, JSON.stringify(s.data));

  console.log('\n=== 手机号标识走 WhatsApp 格式 ===');
  const r6 = await post('/api/manual', { ident: '14155550000', body: 'hello from wa style' });
  eq('返回 200', r6.status, 200);
  eq('JID 格式正确', r6.data.customer.wa_jid, '14155550000@c.us');
  eq('phone 被拆出', r6.data.customer.phone, '14155550000');
  eq('渠道 = whatsapp', r6.data.customer.channel, 'whatsapp');

  console.log('\n=== 渠道预留：同一号码在不同渠道是两个客户 ===');
  const r7 = await post('/api/manual', { ident: 'tg:14155550000', body: 'hi from telegram' });
  eq('tg: 前缀保留', r7.data.customer.wa_jid, 'tg:14155550000');
  eq('渠道 = telegram', r7.data.customer.channel, 'telegram');
  check('与 WhatsApp 客户编号不同', r7.data.code !== r6.data.code, `${r7.data.code} vs ${r6.data.code}`);
  eq('phone 仍能剥出来用于查重', r7.data.customer.phone, '14155550000');
  eq('ig: 前缀 → instagram', (await post('/api/manual', { ident: 'ig:some_user', body: 'hi' })).data.customer.channel, 'instagram');
  eq('manual: 前缀 → manual', (await post('/api/manual', { ident: '老客户A', body: 'hi' })).data.customer.channel, 'manual');
  eq('phone 非数字时不乱拆', (await post('/api/manual', { ident: 'ig:some_user', body: 'x' })).data.customer.phone, null);

  console.log('\n=== 加入时间：老客户可以手填 ===');
  const IDENT_J = 'joined-at-test';
  const rj = await post('/api/manual', { ident: IDENT_J, body: 'we talked months ago' });
  const codeJ = rj.data.code;
  eq('不填时自动记今天', db.getCustomer.get(codeJ).created_at_source, 'auto');

  const threeMonthsAgo = new Date(Date.now() - 90 * 86400000).toISOString();
  const rj2 = await post('/api/manual', { ident: IDENT_J, joinedAt: threeMonthsAgo.slice(0, 10), body: 'another line here' });
  eq('手填后来源变 manual', db.getCustomer.get(codeJ).created_at_source, 'manual');
  check(
    '手填的日期被记下（同一天）',
    db.getCustomer.get(codeJ).created_at.slice(0, 10) === threeMonthsAgo.slice(0, 10),
    db.getCustomer.get(codeJ).created_at
  );
  eq('重复录入同一标识不会新建客户', rj2.data.isNew, false);

  // 通过档案接口也能改加入时间
  const rj3 = await post(`/api/customer/${codeJ}/profile`, {
    name: 'Dio',
    region: '俄勒冈',
    created_at: threeMonthsAgo,
  });
  eq('档案接口改加入时间成功', rj3.status, 200);
  eq('档案接口改后仍是 manual', db.getCustomer.get(codeJ).created_at_source, 'manual');
  eq('姓名一并保存', db.getCustomer.get(codeJ).name, 'Dio');

  console.log('\n=== 单独抽取档案（不用先生成建议） ===');
  const callsBeforeExtract = extractedCalls.length;
  const rx = await post(`/api/customer/${codeJ}/extract`, {});
  eq('extract 接口 200', rx.status, 200);
  check('调用了模型抽取', extractedCalls.length > callsBeforeExtract, `${extractedCalls.length} vs ${callsBeforeExtract}`);
  const cJ = db.getCustomer.get(codeJ);
  eq('抽取后写入地区', cJ.region, '俄勒冈');
  eq('抽取后写入电话号码', cJ.phone, '+15419000088');
  eq('抽取后写入时区', cJ.timezone, 'America/Los_Angeles');
  check('抽取后写入姓名', !!cJ.name, String(cJ.name));

  console.log('\n=== 客户接口返回极简档案 6 字段 ===');
  const g = await (await fetch(`${BASE}/api/customer/${codeJ}`)).json();
  check('返回档案含 6 字段列', ['name', 'phone', 'region', 'timezone', 'stage_day', 'created_at']
    .every((k) => k in g.customer), JSON.stringify(Object.keys(g.customer)));
  check('接口不再返回 profileFields 定义', Array.isArray(g.profileFields) === false, String(g.profileFields));

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
