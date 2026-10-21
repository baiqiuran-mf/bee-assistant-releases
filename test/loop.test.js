/**
 * 采纳 / 换思路 的端到端闭环测试
 *
 * 用假 AI 顶替模型，真起 HTTP 服务，走完整链路：
 *   生成 → 不采纳 → 记住负样本 → 换思路重生成（且避开刚才的说法）
 *        → 采纳 → 存进话术库 → 下次生成时作为范例出现
 *
 * 不联网、不需要 API key。
 * 跑法：node --experimental-sqlite test/loop.test.js
 */

// 数据隔离：本测试只写临时目录，绝不碰真实 data/
require('./_isolate.js');

const db = require('../src/db');
const learn = require('../src/learn');
const { createServer } = require('../src/server');

const PORT = 8901;
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = '9A00001'; // 账号 9 的第一个客户，编号规则决定

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

/* ---------------- 假 AI：记录每次收到的入参 ---------------- */

const calls = [];
const fakeAi = {
  isReady: () => true,
  notConfiguredReason: () => null,
  translate: async () => '（译）',
  // 批量翻译（提速改造后同客户多条合并成一次请求）：假 AI 也得有这条，
  // 否则走批量那条路会抛错，译文永远补不上。
  translateBatch: async (texts) => (texts || []).map(() => '（译）'),
  extractProfile: async () => null,
  // 需求②：现在返回「分组」结构（每条客户留言一组，组内 3 条）。
  // 按传入的 groups 数量产出对应组数——几条留言就几组，每组 3 条。
  suggest: async (payload) => {
    calls.push(payload);
    const n = calls.length;
    const groupsIn = (payload && Array.isArray(payload.groups)) ? payload.groups : [{ index: 0, text: '客户留言' }];
    return {
      groups: groupsIn.map((g, i) => ({
        index: i,
        message: g.text || `客户留言${i + 1}`,
        options: [
          { angle: 'empathy', text: `第${n}轮·共情说法` },
          { angle: 'story', text: `第${n}轮·故事说法` },
          { angle: 'nudge', text: `第${n}轮·推进说法` },
        ],
      })),
      rationale: `第${n}轮理由`,
      riskFlags: [],
    };
  },
};

const fakeKnowledge = {
  buildBlocks: () => ({ text: '【人设】林晚秋，厦门画室', always: ['persona.md'], matched: [] }),
};

const fakeDoc = { writeCustomerDoc: () => 'x.md', findExistingDoc: () => null, guessTimezone: () => null };

const cfg = {
  ai: { tasks: { suggest: { provider: 'hunyuan', model: 'hy3' }, extract: { provider: 'hunyuan', model: 'hy3' } } },
  knowledge: { always: ['persona.md'] },
};

/* ---------------- 准备数据 ---------------- */

function clean() {
  db.db.prepare('DELETE FROM learned WHERE source_code=?').run(CODE);
  db.db.prepare('DELETE FROM rejected WHERE source_code=?').run(CODE);
  db.db.prepare('DELETE FROM suggestions WHERE customer_code=?').run(CODE);
  // 按 wa_msg_id 清，别只按 customer_code——上一轮残留会占住唯一键，让新消息被 OR IGNORE 掉
  db.db.prepare("DELETE FROM messages WHERE wa_msg_id LIKE 'loop-%'").run();
  db.db.prepare('DELETE FROM customers WHERE code=?').run(CODE);
}
clean();

const { customer } = db.getOrCreateCustomer(9, '19998887777@s.whatsapp.net', { name: 'Test Loop', phone: '19998887777' });
eq('测试客户编号', customer.code, CODE);

db.saveMessage({
  customerCode: CODE,
  accountId: 9,
  direction: 'in',
  body: 'my golden retriever passed away last month, I miss him so much',
  bodyZh: '我的金毛上个月过世了，我很想他',
  waMsgId: 'loop-msg-1',
  msgTs: new Date().toISOString(),
});

/* ---------------- 起服务 ---------------- */

const { server } = createServer(
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
const get = async (p) => (await fetch(BASE + p)).json();

(async () => {
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res));

  console.log('===== 第一轮：生成 =====');
  const s1 = await post(`/api/customer/${CODE}/suggest`, { attempt: 0 });
  eq('返回 200', s1.status, 200);
  check('返回 suggestionId', Number.isFinite(s1.data.suggestionId), JSON.stringify(s1.data.suggestionId));
  eq('共 1 组（1 条客户留言）', s1.data.groups.length, 1);
  eq('每组 3 条建议', s1.data.groups[0].options.length, 3);
  eq('attempt 为 0', s1.data.attempt, 0);
  check('判定出阶段(天)', s1.data.day && Number.isFinite(s1.data.day.day), JSON.stringify(s1.data.day));
  // 需求①：右栏 Day 现在跟中栏档案条一致，用「加入后第几天」（joinDay），来源标记 join
  eq('Day 用加入天数（来源 join）', s1.data.day && s1.data.day.source, 'join');
  check('Day 是数字', typeof s1.data.day.day === 'number', s1.data.day.day);

  console.log('\n===== 不采纳：整批否掉，换思路 =====');
  const r1 = await post('/api/suggestion/reject', {
    suggestionId: s1.data.suggestionId,
    index: null,
    reason: '太早了，他现在只想说话',
    attempt: 0,
    avoid: [],
    day: s1.data.day.day,
    scene: 'my golden retriever passed away 我的金毛过世了',
  });
  eq('换思路返回 200', r1.status, 200);
  eq('attempt 递增到 1', r1.data.attempt, 1);
  check('生成了新建议', r1.data.groups[0].options[0].text.includes('第2轮'), JSON.stringify(r1.data.groups));

  eq('三条负样本入库', learn.listRejected().filter((r) => r.source_code === CODE).length, 3);

  console.log('\n===== 验证：换思路时确实避开了上一轮 =====');
  eq('AI 被调用两次', calls.length, 2);
  const second = calls[1];
  eq('第二次 attempt=1', second.attempt, 1);
  check('avoid 传入上一轮三条说法', second.avoid.some((a) => a.includes('第1轮·共情说法')), JSON.stringify(second.avoid));
  eq('上一轮三条全部进 avoid', second.avoid.length, 3);
  check('coachBlock 含负样本清单', second.coach.coachBlock.includes('这些路子被否过'), second.coach.coachBlock.slice(0, 300));
  check('负样本里带上了原因', second.coach.coachBlock.includes('太早了，他现在只想说话'), '');
  eq('本轮角度已轮换', Array.isArray(second.coach.angles) && second.coach.angles.length > 0, true);

  console.log('\n===== 采纳：存进话术库 =====');
  const a1 = await post('/api/suggestion/adopt', {
    suggestionId: r1.data.suggestionId,
    groupId: 0,
    optionIndex: 0,
    text: '我懂那种感觉。我家哆咪走的那年，我画了第一幅宠物油画。',
    note: '先共情，不谈画',
    angle: 'empathy',
    day: r1.data.day.day,
    scene: 'my golden retriever passed away 我的金毛过世了',
  });
  eq('采纳返回 ok', a1.data.ok, true);
  eq('首次采纳 dedup=false', a1.data.dedup, false);
  eq('话术库 +1', a1.data.stats.learned, 1);

  // 重复采纳同一句
  const a2 = await post('/api/suggestion/adopt', {
    suggestionId: r1.data.suggestionId,
    groupId: 0,
    optionIndex: 0,
    text: '我懂那种感觉。我家哆咪走的那年，我画了第一幅宠物油画。',
    day: r1.data.day.day,
    scene: 'my golden retriever passed away',
  });
  eq('重复采纳 dedup=true', a2.data.dedup, true);
  eq('话术库仍是 1 条', a2.data.stats.learned, 1);

  console.log('\n===== 验证：下次生成会把采纳过的思路喂回去 =====');
  const s3 = await post(`/api/customer/${CODE}/suggest`, { attempt: 0 });
  eq('第三次调用成功', s3.status, 200);
  const third = calls[2];
  check('coachBlock 含"你以前采纳过的思路"', third.coach.coachBlock.includes('你以前采纳过的思路'), '');
  check('范例里是我改过的那句', third.coach.coachBlock.includes('我家哆咪走的那年'), third.coach.coachBlock.slice(0, 500));
  check('范例带上备注', third.coach.coachBlock.includes('先共情，不谈画'), '');

  console.log('\n===== 话术库接口 =====');
  const lib = await get('/api/learned');
  eq('learned 1 条', lib.learned.length, 1);
  eq('rejected 3 条', lib.rejected.length, 3);
  eq('统计一致', lib.stats.learned, 1);
  check('采纳记录带角度', lib.learned[0].angle === 'empathy', lib.learned[0].angle);
  check('采纳记录带备注', lib.learned[0].note === '先共情，不谈画', lib.learned[0].note);

  console.log('\n===== 单条不采纳（只否第二条）=====');
  const r2 = await post('/api/suggestion/reject', {
    suggestionId: s3.data.suggestionId,
    groupId: 0,
    optionIndex: 1,
    reason: null,
    attempt: 0,
    avoid: [],
    day: s3.data.day.day,
    scene: 'my golden retriever passed away',
  });
  eq('单条否掉返回 200', r2.status, 200);
  eq('rejected 增加到 4', learn.listRejected().filter((r) => r.source_code === CODE).length, 4);
  check('负样本里只有被否的那条', calls[3].coach.coachBlock.includes('第3轮·故事说法'), calls[3].coach.coachBlock);
  check('没被否的那条不进负样本库', !learn.listRejected().some((r) => r.text.includes('第3轮·推进说法')), '');
  // 但整批是换新的，所以旧的三条都进了 avoid——避免重生成时原地打转
  eq('换一批时旧三条都进 avoid', calls[3].avoid.length, 3);

  console.log('\n===== 不存在建议的处理 =====');
  const bad = await post('/api/suggestion/adopt', { suggestionId: 999999, index: 0, text: 'x' });
  eq('不存在 → 404', bad.status, 404);

  clean();
  server.close();
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  server.close();
  process.exit(1);
});
