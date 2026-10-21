/*
 * Signal 采集专项测试（2026-10-08 · v1.5.0）
 *
 * 跑**真源码**（require src/signalRead.js，不复制逻辑）：
 * 之前 test_signal_lamp.js 栽过一次 —— 复制了一份函数去测，测的东西和产品代码无关。
 * 这里直接调真函数，所以测挂了就是产品真的挂了。
 *
 * 数据用**真 Signal 库读出来的形状**（本机实测，见下方 REAL_FIXTURES），
 * 不联网、不改生产库、不需要 Signal 在运行。
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sr = require(path.join(ROOT, 'src', 'signalRead.js'));
const ids = require(path.join(ROOT, 'src', 'ids.js'));

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ------------------------------------------------------------------
 * 真数据形状（本机 Signal 库实测，2026-10-08）
 * 官方号 serviceId = 11111111-1111-4111-8111-111111111111
 * ------------------------------------------------------------------ */
const CONV_SIGNAL = {
  id: '41771d23-3fd7-4e04-ac29-efd700c5b506',
  type: 'private',
  name: null,
  profileName: 'Sherry',
  profileFullName: 'Sherry Lin',
  e164: null,
  serviceId: 'e70af58b-805d-4da3-9eae-16b3560b912e',
  groupId: null,
};
const CONV_OFFICIAL = {
  id: 'ec7bc122-2fe3-4de4-a400-2f693b482be3',
  type: 'private',
  name: null,
  profileName: 'Signal',
  profileFullName: 'Signal',
  e164: null,
  serviceId: '11111111-1111-4111-8111-111111111111',
  groupId: null,
};
const CONV_ME = {
  id: 'd1aec023-26a1-4521-a6e1-a83c834393bf',
  type: 'private',
  name: null,
  profileName: 'wanqiu',
  profileFullName: 'wanqiu Lin',
  e164: '+16058384634',
  serviceId: '62fdba09-8db8-426d-b576-1fcd0aabcea5',
  groupId: null,
};

function row(o) {
  return Object.assign({
    id: 'uuid-1',
    sent_at: 1791433573904,
    timestamp: 1791433573904,
    type: 'incoming',
    body: 'here',
    sourceServiceId: CONV_SIGNAL.serviceId,
    conversationId: CONV_SIGNAL.id,
    hasAttachments: 0,
  }, o);
}
function withConv(r, conv) { return Object.assign({}, r, { conversation: conv }); }

/* ============================ 一、客户唯一标识 ============================ */
section('一、客户唯一标识 customerKey');
ok(sr.customerKey(CONV_SIGNAL) === CONV_SIGNAL.serviceId, '私聊用 serviceId（ACI）');
ok(sr.customerKey(CONV_OFFICIAL) === CONV_OFFICIAL.serviceId, '官方号也有 serviceId');
ok(sr.customerKey({ type: 'group', groupId: 'g-1', serviceId: null, id: 'x' }) === 'g-1', '群组退回 groupId');
ok(sr.customerKey({ serviceId: null, groupId: null, id: 'only-id' }) === 'only-id', '都没时有 id 兜底');
ok(sr.customerKey(null) === null, 'null 会话返回 null');
ok(sr.customerKey({}) === null, '空会话返回 null');
ok(
  sr.customerKey(CONV_SIGNAL) !== CONV_SIGNAL.id,
  '🔴 用的不是 conversations.id（本地 id 会变，重装就认错人）'
);

/* ============================ 二、身份读取 ============================ */
section('二、客户名字与电话 readIdentity');
{
  const a = sr.readIdentity(CONV_SIGNAL);
  ok(a.name === 'Sherry Lin', '优先 profileFullName', a.name);
  ok(a.e164 === null, '实测这家客户 e164 是 null', String(a.e164));
  ok(a.state === 'pending', '没号码 → pending（不是 hidden）', a.state);

  const b = sr.readIdentity(CONV_ME);
  ok(b.e164 === '+16058384634', '有号码就如实取到');
  ok(b.state === 'ok', '有号码 → ok');

  ok(sr.readIdentity({ profileName: '只有昵称' }).name === '只有昵称', '没全名退回 profileName');
  ok(sr.readIdentity({ name: '群名字' }).name === '群名字', '群组用 name');
  ok(sr.readIdentity({}).name === null, '什么都没有 → null');
  ok(sr.readIdentity({ serviceId: sr.OFFICIAL_SERVICE_ID }).state === 'hidden',
    '官方号 → hidden（和 pending 区分开）');
}

/* ============================ 三、过滤（最容易出错的地方） ============================ */
section('三、哪些消息该收 shouldAccept');
ok(sr.shouldAccept(withConv(row(), CONV_SIGNAL)).ok, '普通 incoming 收');
ok(sr.shouldAccept(withConv(row({ type: 'outgoing' }), CONV_SIGNAL)).ok, 'outgoing 收（我发的也要显示）');
ok(!sr.shouldAccept(withConv(row({ type: 'story' }), CONV_OFFICIAL)).ok,
  '🔴 story 不收（官方号 5 条假消息就是 story）');
ok(!sr.shouldAccept(withConv(row({ type: 'message-request-response-event' }), CONV_SIGNAL)).ok,
  'message-request-response-event 不收');
ok(!sr.shouldAccept(withConv(row({ type: 'reaction' }), CONV_SIGNAL)).ok, 'reaction 不收');
ok(!sr.shouldAccept(withConv(row({ type: 'call' }), CONV_SIGNAL)).ok, 'call 不收');
ok(!sr.shouldAccept(withConv(row({ type: '' }), CONV_SIGNAL)).ok, '空 type 不收');
ok(!sr.shouldAccept(withConv(row({ conversationId: CONV_OFFICIAL.id }), CONV_OFFICIAL)).ok,
  '🔴 官方 Signal 号的会话一律不收');
ok(!sr.shouldAccept(withConv(row({ body: null, hasAttachments: 0 }), CONV_SIGNAL)).ok,
  '🔴 空消息不收（撤回提示/通话记录不能凭空造客户）');
ok(!sr.shouldAccept(withConv(row({ body: '   ' }), CONV_SIGNAL)).ok, '纯空白也当空消息');
ok(sr.shouldAccept(withConv(row({ body: null, hasAttachments: 1 }), CONV_SIGNAL)).ok,
  '🔴 附件消息要收（留占位，不能整条丢掉）');
ok(!sr.shouldAccept(null).ok, 'null 行不收');
ok(!sr.shouldAccept(withConv(row(), {})).ok, '会话啥都没有 → 不收（拿不到客户标识）');
ok(!sr.shouldAccept(withConv(row({ type: 'incoming', sourceServiceId: sr.OFFICIAL_SERVICE_ID }), CONV_SIGNAL)).ok,
  '官方号发来的 incoming 不收');
// 🔴 回归：官方号判据必须认**三个来源**，不能只读 SQL 别名 convServiceId。
//    踩过的坑：只读别名时，一旦调用方构造的行没带这个字段，
//    官方号就会混进来 → 界面上凭空多一个叫「Signal」的假客户。
ok(!sr.shouldAccept(withConv(row(), CONV_OFFICIAL)).ok, '🔴 从 conversation.serviceId 也能认出官方号');
ok(!sr.shouldAccept(Object.assign(row(), { convServiceId: sr.OFFICIAL_SERVICE_ID, conversation: CONV_SIGNAL })).ok,
  '🔴 从 SQL 别名 convServiceId 也能认出官方号');
ok(!sr.shouldAccept(Object.assign(row(), { sourceServiceId: sr.OFFICIAL_SERVICE_ID, conversation: CONV_SIGNAL })).ok,
  '🔴 从 sourceServiceId 也能认出官方号');

/* ============================ 四、转成统一结构 ============================ */
section('四、toMessage 输出结构');
{
  const m = sr.toMessage(withConv(row(), CONV_SIGNAL));
  ok(m.direction === 'in', 'incoming → in');
  ok(m.customerKey === CONV_SIGNAL.serviceId, '带出 customerKey');
  ok(m.displayJid === 'sig:' + CONV_SIGNAL.serviceId, 'wa_jid 用 sig: 前缀', m.displayJid);
  ok(m.msgId === 'uuid-1', '带出去重键 msgId');
  ok(m.body === 'here', '正文原样');
  ok(m.name === 'Sherry Lin', '带出客户名');
  ok(m.phone === null && m.phoneState === 'pending', '🔴 没号码要如实留空，不能编一个');
  ok(typeof m.ts === 'string' && m.ts.endsWith('Z'), '时间转成 ISO', m.ts);
  ok(m.hasAttachment === false, 'hasAttachment 布尔化');
  ok(sr.toMessage(withConv(row({ type: 'outgoing' }), CONV_SIGNAL)).direction === 'out', 'outgoing → out');

  // 时间戳换算必须对：1791433573904 → 2026-10-08T04:26:13.904Z
  ok(m.ts === new Date(1791433573904).toISOString(), '毫秒时间戳换算正确', m.ts);

  // 缺 sent_at 时不能崩
  const noTs = sr.toMessage(withConv(row({ sent_at: undefined }), CONV_SIGNAL));
  ok(noTs && typeof noTs.ts === 'string', 'sent_at 缺失时有兜底，不崩');

  // 附件消息 mediaType
  ok(sr.toMessage(withConv(row({ body: null, hasAttachments: 1 }), CONV_SIGNAL)).mediaType === 'image',
    '纯附件消息 mediaType=image');
  ok(sr.toMessage(withConv(row({ body: '看图', hasAttachments: 1 }), CONV_SIGNAL)).mediaType === '',
    '图文都有时 mediaType 留空（走文字）');
}

/* ============================ 五、编号（account_id=6 的由来） ============================ */
section('五、客户编号 6A00001');
{
  ok(sr.SIGNAL_ACCOUNT_ID === 6, 'Signal 占用 account_id=6');
  let c = null;
  try { c = ids.nextCustomerCode(6, null); } catch (e) { /* expected */ }
  ok(c === '6A00001', '🔴 6 号位能生成合法编号 6A00001', String(c));

  // 这是为什么不能用 99 —— 必须真的抛出来才算证明
  let threw = false;
  try { ids.nextCustomerCode(99, null); } catch (e) { threw = true; }
  ok(threw, '🔴 证明 account_id=99 会抛异常（所以不能用 99）');

  let threw2 = false;
  try { ids.nextCustomerCode(6, '9A00001'); } catch (e) { threw2 = true; }
  ok(threw2, '跨账号编号会抛（防串号）');

  ok(ids.nextCustomerCode(6, '6A00001') === '6A00002', '递增正常');
  ok(/^6[A-Z]\d{5}$/.test(ids.nextCustomerCode(6, null)), '编号格式符合 CODE_RE');
}

/* ============================ 六、SQL 水位 ============================ */
section('六、增量 SQL');
{
  ok(sr.SQL_POLL.includes('m.sent_at > ?'), '🔴 按 sent_at 做增量（不是全表扫）');
  ok(sr.SQL_POLL.includes('ORDER BY m.sent_at ASC'), '按时间升序（先进先出，不会乱序）');
  ok(sr.SQL_POLL.includes('JOIN conversations'), 'JOIN 出会话（客户名/电话/ACI 在这里）');
  ok(sr.SQL_POLL.includes('LIMIT ?'), '有单次上限（防一次刷屏卡主线程）');
  ok(!/SELECT \* FROM messages/.test(sr.SQL_POLL), '不裸 SELECT *（只取用得到的列）');
}

/* ============================ 七、轮询器 ============================ */
section('七、startPolling 行为');
{
  // 回调抛错绝不能停掉轮询（停了 = 采集彻底死了且没人知道）
  let calls = 0;
  let poller = null;
  const p = sr.startPolling({
    intervalMs: 10,
    onMessages() { calls++; throw new Error('故意抛错'); },
  });
  poller = p;
  ok(typeof p.stop === 'function', '返回 stop()');

  // 真实跑一小段，确认抛错也不会退出
  const t0 = Date.now();
  while (Date.now() - t0 < 400) { /* 忙等让定时器跑 */ }
  ok(poller.state().stopped === false, '🔴 回调抛错后轮询仍在跑（没被静默停掉）');

  poller.stop();
  ok(poller.state().stopped === true, 'stop() 能停');

  const n = calls;
  const t1 = Date.now();
  while (Date.now() - t1 < 300) { /* 停后不该再调 */ }
  ok(calls === n, '🔴 stop() 之后不再回调', calls + ' vs ' + n);
}

/* ============================ 八、readNew 出错不能抛 ============================ */
section('八、readNew 容错');
{
  const r = sr.readNew(0);
  ok(typeof r.ok === 'boolean', '永远返回 ok 字段（Signal 没开时 ok=false 而不是抛异常）');
  ok(Array.isArray(r.items), '永远返回 items 数组');
  ok(typeof r.watermark === 'number', '永远返回数字水位');
  if (!r.ok) {
    ok(typeof r.reason === 'string' && r.reason.length > 0, '失败时带可读原因', r.reason);
    console.log('     （本机 Signal 当前' + (r.reason || '不可用') + '，属于正常情况）');
  } else {
    ok(r.items.every((m) => m.msgId && m.customerKey), '真库读到的每条都带齐 msgId + customerKey');
    const hasStory = r.items.some((m) => /story/.test(m.body || ''));
    ok(!hasStory, '🔴 真库里没有 story 混进来');
  }
}

/* ============================ 九、真实库联调 ============================ */
section('九、真实 Signal 库（有就读，没有就跳过）');
{
  const r = sr.readNew(0);
  if (!r.ok) {
    console.log('  ⏭跳过（Signal 不可用：' + r.reason + '）');
  } else {
    ok(r.items.length > 0, '读到了真实消息（' + r.items.length + ' 条）');
    const r2 = sr.readNew(r.watermark);
    ok(r2.items.length === 0, '同一水位再读→ 0 条（增量正确，不重复捞）');
    const r3 = sr.readNew(0);
    ok(r3.items.length === r.items.length, '从 0 再读条数一致（读库稳定）');

    const t0 = Date.now();
    for (let i = 0; i < 10; i++) sr.readNew(r.watermark);
    const per = (Date.now() - t0) / 10;
    ok(per < 50, '单轮耗时 ' + per.toFixed(1) + 'ms（3 秒轮询完全无压力）');

    const ids2 = r.items.map((m) => m.msgId);
    ok(new Set(ids2).size === ids2.length, '🔴 msgId 无重复（去重键成立）');
  }
}

/* ============================ 汇总 ============================ */
console.log('\n' + '='.repeat(50));
console.log('Signal 采集测试：' + pass + ' 通过 / ' + fail + ' 失败');
console.log('='.repeat(50));
process.exit(fail === 0 ? 0 : 1);