/**
 * 跨消息翻译记忆 · 自检（2026-10-15 v2.6.1122 · 老板拍板方案 A）
 *
 * 为什么单独一份：这是**一个独立功能**（「同一句话只翻一次」），
 * 不跟气泡、不跟 AI 配置混在一起测 —— 坏了只查这一块。
 *
 * 核心要钉死的一条：
 *   **同一句原文第二次出现时，AI 一次都不许调。**
 *   测试办法是给 ai.translate / ai.translateBatch 装计数器，
 *   跑两遍同样的原文，看计数有没有涨 —— 不涨才算对。
 *
 * 七组：
 *   [A] 归一化（去首尾空格、连续空白折一个、不改大小写）
 *   [B] 字典读写（查/写/命中计数/互不干扰）
 *   [C] 🔴 翻译管线：第二次 0 次 AI 调用；换一句才调
 *   [D] 边界（超长不入字典、开关关掉退回老行为、中文不进队列）
 *   [E] 回填（历史译文灌进字典、只补空缺不覆盖、只灌一次）
 *   [F] 接线（只读路由、主进程装载、别处不许直接写这张表）
 *   [G] 批量分流（一批里已记住的那几条不进 AI 请求）
 *
 * 跑法：node --experimental-sqlite test/translation_memory.test.js
 */

const { DIR } = require('./_isolate.js');

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'src', 'db.js'));
const ai = require(path.join(ROOT, 'src', 'ai.js'));
const translator = require(path.join(ROOT, 'src', 'translator.js'));
const tm = require(path.join(ROOT, 'src', 'translationMemory.js'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? `  << ${extra}` : ''}`); }
}

/* ---- 假 AI：装计数器，用来证明「第二次到底有没有调 AI」 ---- */
let calls = 0;          // ai.translate 被调用几次
let batchCalls = 0;     // ai.translateBatch 被调用几次
let lastBatchLen = -1;  // 上一次批量请求里带了几条
ai.isReady = () => true;
ai.translate = async (t) => { calls++; return '【中】' + String(t); };
ai.translateBatch = async (list) => {
  batchCalls++;
  lastBatchLen = Array.isArray(list) ? list.length : -1;
  return list.map((t) => '【中】' + String(t));
};
/* v2.6.1148 起，词典准入的 AI 复核走 callProviderByName（「翻译词典用哪个 AI」那一家）。
 * 这里打桩成「这句值得收」：测试全程不联网、不烧真 key，也不靠「没配 key 就放行」
 * 那条兜底分支——否则 record() 写没写进字典全看网络，断言就是碰运气。 */
ai.callProviderByName = async () => 'KEEP';

/* ---- 造数据 ---- */
let seq = 0;
function newMsg(code, body, direction = 'in') {
  const jid = `${code}@c.us`;
  const { customer } = db.getOrCreateCustomer(10, jid, { name: '测试' + code });
  const saved = db.saveMessage({
    customerCode: customer.code,
    accountId: 10,
    direction,
    body,
    waMsgId: `${code}-m${++seq}`,
    msgTs: new Date().toISOString(),
  });
  return { id: saved.id, code: customer.code };
}

function translate(id, code, body) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const ok = translator.translateLater(id, code, body, finish);
    if (!ok) finish({ error: '没排上队' });
    setTimeout(() => finish({ error: '超时' }), 8000);
  });
}

(async function run() {
  console.log('\n=== 跨消息翻译记忆（v2.6.1122）===\n');

  /* 防御「.tmp-test-data 没删干净就复用旧库」导致的假失败：
   * Windows 上文件常被上一个进程占着，_isolate 删不掉目录就会沿用旧库，
   * 于是「空字典查不到」这类断言会莫名其妙变红。开跑前先把字典清空。 */
  try { db.db.exec('DELETE FROM translation_memory'); } catch (e) { /* 表还没建就算了 */ }

  /* ---------- [A] 归一化 ---------- */
  console.log('[A] 归一化（只去首尾空格 + 连续空白折一个，不改大小写）');
  check('首尾空格去掉', tm.normalize('  How much?  ') === 'How much?', tm.normalize('  How much?  '));
  check('连续空格折成一个', tm.normalize('How    much?') === 'How much?', tm.normalize('How    much?'));
  check('换行也折成空格', tm.normalize('a\n\nb') === 'a b', JSON.stringify(tm.normalize('a\n\nb')));
  check('大小写原样保留（不折叠）', tm.normalize('How Much?') === 'How Much?');
  check('空串 → 空', tm.normalize('') === '');
  check('null → 空', tm.normalize(null) === '');

  /* ---------- [B] 字典读写 ---------- */
  console.log('\n[B] 字典读写');
  tm.setEnabled(true);
  tm.setRecordEnabled(true);   // 🔴 2026-10-18：验证「本地录入」机制仍可用（生产默认关闭，仅测试打开）
  check('空字典查不到', tm.lookup('How much?') === null);
  // 🔴 record() 是 async（要过 AI 准入），必须 await —— 不 await 拿到的是 Promise，
  //    后面「写进去就能查到」会莫名变红（v2.6.1148 之前是同步的，测试没跟着改）。
  const wrote = await tm.record('How much?', '多少钱？', 'deepseek');
  check('写进去了', wrote === true, String(wrote));
  const got = tm.lookup('How much?');
  check('写进去就能查到', !!got && got.zh === '多少钱？', JSON.stringify(got));
  check('归一化后也能命中（原文带多余空格）', (() => {
    const g = tm.lookup('  How    much?  ');
    return !!g && g.zh === '多少钱？';
  })());
  // v2.6.1149（老板 2026-10-17 要求）：Hello / hello、Hi / hi 是同一句，
  // 查字典时大小写不敏感（写的时候也只会更新同一行，不会插出第二行）。
  const lower = tm.lookup('how much?');
  check('🔴 大小写不同视为同一句（查得到，不重复入字典）',
    !!lower && lower.zh === '多少钱？', JSON.stringify(lower));
  const before = tm.stats().saved;
  tm.hit('How much?');
  check('复用一次 → 命中数 +1', tm.stats().saved === before + 1, `${before} → ${tm.stats().saved}`);
  check('别的句子不串味', tm.lookup('How long?') === null);

  /* ---------- [C] 🔴 核心：第二次 0 次 AI 调用 ---------- */
  console.log('\n[C] 🔴 核心：同一句原文第二次出现，AI 一次都不许调');
  calls = 0;
  const m1 = newMsg('C1', 'How much for a portrait?');
  const r1 = await translate(m1.id, m1.code, 'How much for a portrait?');
  check('第一次翻出来了', !!r1.bodyZh, JSON.stringify(r1));
  check('第一次调了 1 次 AI', calls === 1, `calls=${calls}`);

  const m2 = newMsg('C1', 'How much for a portrait?');
  const r2 = await translate(m2.id, m2.code, 'How much for a portrait?');
  check('🔴 第二次同样原文 —— AI 调用次数没涨（0 次）', calls === 1, `calls=${calls}`);
  check('第二次照样有中文', String(r2.bodyZh || '').indexOf('【中】') === 0, JSON.stringify(r2));
  check('第二次的译文跟第一次一样', String(r2.bodyZh) === String(r1.bodyZh));

  const m3 = newMsg('C1', 'Do you ship to Canada?');
  const r3 = await translate(m3.id, m3.code, 'Do you ship to Canada?');
  check('换一句新话 → 才真的调 AI（+1）', calls === 2, `calls=${calls}`);
  check('新话翻出来了', !!r3.bodyZh, JSON.stringify(r3));

  const m4 = newMsg('C1', 'Do you ship to Canada?');
  await translate(m4.id, m4.code, 'Do you ship to Canada?');
  check('第二句第二次也不调 AI', calls === 2, `calls=${calls}`);

  const m5 = newMsg('C1', 'How much for a portrait?', 'out');
  await translate(m5.id, m5.code, 'How much for a portrait?');
  check('自己发的（out 方向）同样复用', calls === 2, `calls=${calls}`);

  /* ---------- [C2] 🔴 手动「重翻这条」必须绕过记忆 ---------- */
  console.log('\n[C2] 🔴 手动「重翻这条」不许被记忆里的旧译文顶回来');
  const fm = newMsg('C2', 'Please redo this sentence');
  await translate(fm.id, fm.code, 'Please redo this sentence');
  check('这句话先翻了一次（进了字典）', calls === 3, `calls=${calls}`);
  const beforeRetry = calls;
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    const ok = translator.retryManual(fm.id, fm.code, 'Please redo this sentence', fin);
    if (!ok) fin();
    setTimeout(fin, 8000);
  });
  check('🔴 手动重翻真的又调了一次 AI（force 绕过了字典）',
    calls === beforeRetry + 1, `${beforeRetry} → ${calls}`);

  /* ---------- [D] 边界 ---------- */
  console.log('\n[D] 边界（超长 / 开关 / 中文）');
  // 造一段确定超过 MAX_LEN 的英文（整段话几乎不会重复，本就不该进字典）
  const long = 'A very specific paragraph that will never repeat itself in any chat. '.repeat(5).trim();
  check('测试用的长文本确实超过上限', long.length > tm.MAX_LEN, `${long.length} > ${tm.MAX_LEN}`);
  calls = 0;
  const l1 = newMsg('D1', long);
  await translate(l1.id, l1.code, long);
  const l2 = newMsg('D1', long);
  await translate(l2.id, l2.code, long);
  check('超长文本不入字典 → 两次都真调 AI（calls=2）', calls === 2, `calls=${calls}`);

  tm.setEnabled(false);
  calls = 0;
  const f1 = newMsg('D2', 'Thanks a lot');
  await translate(f1.id, f1.code, 'Thanks a lot');
  const f2 = newMsg('D2', 'Thanks a lot');
  await translate(f2.id, f2.code, 'Thanks a lot');
  check('开关关掉 → 退回老行为（每条都翻，calls=2）', calls === 2, `calls=${calls}`);
  check('开关关掉时 lookup 一律不命中', tm.lookup('Thanks a lot') === null);
  tm.setEnabled(true);

  check('本来就是中文 → 不进翻译队列', translator.shouldTranslate('你好，这幅画多少钱') === false);

  /* ---------- [E] 回填 ---------- */
  console.log('\n[E] 回填（历史译文立刻可用）');
  const s0 = newMsg('E1', 'Seeded sentence one');
  db.setTranslation.run('回填译文一', s0.id);
  const s1 = newMsg('E1', 'Seeded sentence two');
  db.setTranslation.run('回填译文二', s1.id);
  check('回填前字典里没有这两句', tm.lookup('Seeded sentence one') === null);
  tm.setRecordEnabled(true);   // 🔴 2026-10-18：seed 走录入闸门，测试内打开
  const seeded = tm.seed(5000);
  check('回填扫到了历史消息', seeded.scanned > 0, JSON.stringify(seeded));
  check('回填真的加进去了', seeded.added >= 2, JSON.stringify(seeded));
  check('回填后能查到（老译文立刻复用）', (() => {
    const g = tm.lookup('Seeded sentence one');
    return !!g && g.zh === '回填译文一';
  })(), JSON.stringify(tm.lookup('Seeded sentence one')));
  check('第二句也回填了', (() => {
    const g = tm.lookup('Seeded sentence two');
    return !!g && g.zh === '回填译文二';
  })());
  // 只补空缺、不覆盖
  db.setTranslation.run('后来改的译文', s0.id);
  const seeded2 = tm.seed(5000);
  check('再回填一次不覆盖已有译文（还是「回填译文一」）', (() => {
    const g = tm.lookup('Seeded sentence one');
    return !!g && g.zh === '回填译文一';
  })(), JSON.stringify(tm.lookup('Seeded sentence one')));
  check('重复回填不会再重复新增（added=0）', seeded2.added === 0, JSON.stringify(seeded2));
  const ensured = tm.ensureSeeded();
  check('ensureSeeded 已经灌过就跳过', ensured.skipped === true, JSON.stringify(ensured));

  /* ---------- [F] 接线与边界 ---------- */
  console.log('\n[F] 接线（接口 / 主进程 / 别处不许直接写这张表）');
  const st = tm.stats();
  check('stats 有 enabled/total/saved/maxLen/top',
    'enabled' in st && 'total' in st && 'saved' in st && 'maxLen' in st && Array.isArray(st.top));
  check('stats.total 大于 0（前面确实记住了几句）', st.total > 0, JSON.stringify({ total: st.total }));

  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  check('server.js 有只读路由 /api/translate/memory', serverSrc.includes("'/api/translate/memory'"));
  check('这条路由是 GET 且只读', /p === '\/api\/translate\/memory' && req\.method === 'GET'/.test(serverSrc));

  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  check('main.js 装载了 translationMemory', mainSrc.includes("require('./translationMemory')"));
  check('main.js 调 fromCfg 读开关', mainSrc.includes('translationMemory.fromCfg'));
  check('main.js 启动后回填 ensureSeeded', mainSrc.includes('translationMemory.ensureSeeded'));

  const others = fs.readdirSync(path.join(ROOT, 'src'))
    .filter((f) => f.endsWith('.js') && f !== 'translationMemory.js' && f !== 'db.js');
  const leaks = others.filter((f) => {
    const s = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    // 只拦「常规读写」那几条（tmUpsert / tmSeed / tmGet / tmHit）和裸表名；
    // tmCloud.js 用的是它自己那两条（tmAll / tmUpsertFromCloud），db.js 里已经写明
    // 「这两条只给 src/tmCloud.js 用」，是官方口子，不算漏。
    return /tmUpsert(?!FromCloud)|tmSeed|tmGet|tmHit|translation_memory/.test(s);
  });
  check('🔴 别的模块不许直接写这张表（业务规则只收在 translationMemory.js）',
    leaks.length === 0, leaks.join(','));

  /* ---------- [G] 批量分流 ---------- */
  console.log('\n[G] 批量分流（一批里已记住的那几条不进 AI 请求）');
  tm.setEnabled(true);
  tm.setRecordEnabled(true);   // 🔴 2026-10-18：record 走录入闸门，测试内打开
  await tm.record('Known sentence', '已知句子', ''); // 同样是 async，得等它真的进字典
  batchCalls = 0;
  lastBatchLen = -1;
  const g1 = newMsg('G1', 'Known sentence');
  const g2 = newMsg('G1', 'Fresh sentence here');
  await Promise.all([
    translate(g1.id, g1.code, 'Known sentence'),
    translate(g2.id, g2.code, 'Fresh sentence here'),
  ]);
  check('一批里只有没记住的那条进了 AI 请求（长度=1）',
    lastBatchLen === 1, `lastBatchLen=${lastBatchLen}`);
  check('批量请求只发了一次', batchCalls === 1, `batchCalls=${batchCalls}`);
  check('已记住那条也有中文（来自字典）', (() => {
    const row = db.getMessage.get(g1.id);
    return !!row && row.body_zh === '已知句子';
  })(), JSON.stringify(db.getMessage.get(g1.id)));
  check('新那条也翻出来了', (() => {
    const row = db.getMessage.get(g2.id);
    return !!row && String(row.body_zh || '').indexOf('【中】') === 0;
  })(), JSON.stringify(db.getMessage.get(g2.id)));

  console.log(`\n[跨消息翻译记忆自检] 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身崩了：', e);
  process.exit(1);
});
