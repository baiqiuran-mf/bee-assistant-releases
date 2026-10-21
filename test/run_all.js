/**
 * 蜜蜂信息采集 · 全功能集成测试
 *
 * 覆盖：每一个底层模块（ids / db / knowledge / coach / learn /
 * customerDoc / ai）+ 每一个 HTTP 接口（手动录入 → 出建议 → 采纳 → 换思路 →
 * 保存档案 → 抽档案 → 标记已回复 → 话术库）。
 *
 * 用假 AI 打桩，不需要联网、不需要 API key。全程走数据/配置隔离（BEE_DATA_DIR、
 * BEE_CONFIG 指向 .tmp-test-data/ 里的副本），绝对不碰你真实的 data/ 与 config.yaml。
 *
 * 运行：node --experimental-sqlite test/run_all.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* ---------------- 数据隔离（关键） ----------------
 * 把数据目录指向项目下的临时目录，测试全程只写这里，绝不碰真实客户数据。
 * 必须在 require 任何 src/* 之前设置（src/paths.js 在 require 时就会解析它）。
 *
 * 🔴 2026-10-18 改（为什么）：
 *   以前 TMP_DATA 固定为 .tmp-test-data **根目录**，而 cleanTmpData() 的 rmSync
 *   失败被静默吞掉（外层 catch 什么都不做，日志照样打印「已清理」）。
 *   根目录删不掉 → 本文件的**内联 section 跨次复用同一个库** →
 *   「今天再来一条 → 收到 +1」这类计数断言越跑越红，
 *   同一份代码什么都不动，失败数从 6 → 10 → 18 → 19 一路涨。
 *   现在改成：本轮用一个**带时间戳 + pid + 随机串的全新子目录**，
 *   删除成不成功都不影响「本轮起点是干净的」；删不掉还要如实告警，不再装成功。
 *   子测试那头由 test/_isolate.js 各自隔离，不受这里影响。
 */
const TMP_ROOT = path.join(ROOT, '.tmp-test-data');
/* 本轮的独立目录名（run_id）。每次跑都是一棵全新的树：
 *   - 不再复用旧的 .tmp-test-data 根目录 → 跨次累积彻底消失；
 *   - 也不再复用上一次 run_all-* → 本轮起点必然是干净的库。
 * 名字带时间戳 + pid + 随机串，两个人同时跑也撞不上。 */
const RUN_ID = `run_all-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const TMP_DATA = path.join(TMP_ROOT, RUN_ID);
process.env.BEE_DATA_DIR = TMP_DATA;

/* 配置也隔离：界面上「AI 设置」会回写 config.yaml，测试必须写副本，
 * 否则跑一次测试就会把真实的 apiKey / 账号配置改掉。 */
const TMP_CONFIG = path.join(TMP_DATA, 'config.yaml');

/**
 * 删除前的**归属校验**：只允许删「本轮自己造的那一棵临时目录」。
 *
 * 为什么必须先校验再删：rmSync 是 recursive + force 的，路径一旦算错就没有回头路
 * ——真实客户数据 data/assistant.db 就躺在项目根下。所以任何删除之前都必须先证明：
 *   1) 位于 .tmp-test-data/ 之内（含路径穿越检查，'..' 一律拒绝）；
 *   2) 不是 .tmp-test-data 根目录本身（**根目录是别人留下的，测试无权删**）；
 *   3) 目录名与本轮 run_id 完全一致（只删自己这一棵，不碰别人的）。
 * 任何一条不满足 → 直接抛错，**绝不执行删除**。
 *
 * @param {string} dir 打算删的目录
 * @returns {string} 通过校验的绝对路径
 * @throws {Error} 校验不通过时抛出（不删任何东西）
 */
function assertOwnedTmpDir(dir) {
  const resolved = path.resolve(dir);
  const rootResolved = path.resolve(TMP_ROOT);
  const rel = path.relative(rootResolved, resolved);
  const base = path.basename(resolved);
  const problems = [];
  if (!rel) problems.push('它就是 .tmp-test-data 根目录本身（那是别人留下的，测试无权删）');
  else if (rel.startsWith('..') || path.isAbsolute(rel)) problems.push('它不在 .tmp-test-data 之内（疑似路径穿越）');
  if (base !== RUN_ID) problems.push(`目录名 ${base} 不是本轮的 run_id（${RUN_ID}），不能删`);
  if (problems.length) {
    throw new Error(
      `拒绝删除 ${resolved}：${problems.join('；')}。\n` +
      `  测试只允许删自己本轮造出来的那一棵临时目录。`
    );
  }
  return resolved;
}

/**
 * 清掉本轮目录，**如实**对待失败：删完复查是否真没了，绝不静默。
 *
 * 🔴 为什么不能靠 force:true 就闭嘴：Windows 上文件被别的进程占着时，
 *   rmSync 是「不报错、也没删」；环境层的删除钩子（本次实测撞上 safe-delete
 *   的批量阈值 50）也会直接抛异常。这两种失败一旦被静默吞掉，测试就会
 *   带着上一轮的脏库继续跑，失败数单调上升而日志一个字都不提。
 *
 * @param {string} dir 必须是本轮自己造的临时目录
 * @returns {string} 已确认删除的绝对路径
 * @throws {Error} 校验不通过 / rmSync 抛异常 / 删完仍在，都抛出（带路径 + 原始 err.message）
 */
function wipeDir(dir) {
  const target = assertOwnedTmpDir(dir);   // 先证明「可以删」，再删
  if (!fs.existsSync(target)) return target;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    throw new Error(`删除本轮数据目录失败：${target}\n  原始错误：${(e && e.message) || e}`);
  }
  if (fs.existsSync(target)) {
    throw new Error(`删除本轮数据目录失败：${target}\n  rmSync 没报错，但目录仍然在（多半被别的进程占着）。`);
  }
  return target;
}

/**
 * 清掉本轮目录。
 *
 * 本轮用的是**全新目录**（见上面 RUN_ID），所以「删不掉」不影响本轮结论 ——
 * 它本来就是这次新建的、只属于这一轮的。但删不掉必须**说出来**，
 * 绝不许再打印「已清理」穿着成功的外衣。
 * @returns {boolean} 是否确实清掉了
 */
function cleanTmpData() {
  try {
    wipeDir(TMP_DATA);
    console.log('[隔离] 已清理本轮数据目录，你的真实 data/ 未被改动。');
    return true;
  } catch (e) {
    console.warn(`[隔离] ⚠️  ${(e && e.message) || e}\n[隔离]    不影响本轮结论——它本来就是本轮新建的目录。`);
    console.warn(`[隔离]    残留目录请手工清理：${TMP_DATA}`);
    return false;
  }
}

// 只建本轮这一棵新目录。旧的残留 .tmp-test-data **一律不碰**——
// 那是别人留下的目录，测试无权删，也不再复用它。
cleanTmpData();
fs.mkdirSync(TMP_DATA, { recursive: true });
try {
  fs.copyFileSync(path.join(ROOT, 'config.yaml'), TMP_CONFIG);
  process.env.BEE_CONFIG = TMP_CONFIG;
} catch (e) {
  console.warn(`[隔离] ⚠️  拷不了 config.yaml 副本：${(e && e.message) || e}`);
}
console.log(`[隔离] 本轮数据目录：${TMP_DATA}（你的真实 data/ 与 config.yaml 全程不被读写）`);

/* ---------------- 测试框架 ---------------- */
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + extra : ''}`); }
}
function eq(name, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  check(name, ok, ok ? '' : `实际 ${JSON.stringify(a)} ≠ 期望 ${JSON.stringify(b)}`);
}
function section(title) { console.log(`\n=== ${title} ===`); }

/* 子测试用「另起进程」跑（内核/桌面/界面/AI 设置）。
 * 注意：受限环境（如某些沙箱）会禁止从 node 里再 spawn 子进程（EBUSY）。
 * 这种情况不是代码问题，跳过并提示，别误报成 FAIL。在本机 Windows 上能正常拉起。 */
function spawnSubtest(checkName, file) {
  section(checkName);
  const r = spawnSync(
    process.execPath,
    ['--experimental-sqlite', path.join(__dirname, file)],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, BEE_NOPAUSE: '1' } }
  );
  if (r.error) {
    console.log(`  SKIP  ${checkName} —— 子进程无法启动（环境限制：${r.error.message}）。`);
    console.log(`        请在本地 Windows 用 Node 直接跑：node --experimental-sqlite test/${file}`);
    return;
  }
  const outs = (r.stdout || '').split('\n');
  const line = outs.find((l) => /自检\]\s*(PASS|FAIL|通过|失败)/.test(l)) || '';
  const tail = outs.filter((l) => /FAIL|失败|✗/.test(l)).join(' | ').trim();
  // TEMP-PROBE：抓一下子进程全量输出，定位「只在 run_all 里死」的子测试（用完即删）
  if (r.status !== 0) {
    try {
      const dumpTo = path.join(process.env.TEMP || '.', `runall-sub-${file}-${Date.now()}.log`);
      fs.writeFileSync(dumpTo, `[status] ${r.status}\n[STDOUT]\n${r.stdout || ''}\n[STDERR]\n${r.stderr || ''}`);
      console.log('        [TEMP-PROBE] 子进程输出已落盘：' + dumpTo);
    } catch (e) { /* ignore */ }
  }
  check(checkName + ' 通过', r.status === 0, (line + ' ' + tail + ' ' + (r.stderr || '')).trim().slice(0, 300));
  if (line) console.log('        ' + line.trim());
}

/* ---------------- 假 AI（打桩） ---------------- */
function makeFakeAi() {
  return {
    isReady: () => true,
    providerReady: () => true,
    notConfiguredReason: () => null,
    translate: async (t) => `（译）${t}`,
    // 提速改造后，同客户多条短消息会走批量接口；假 AI 不实现它就直接抛错，
    // 表现为"消息永远没有译文"（manual.test.js 就是这么坏掉的）。
    translateBatch: async (texts) => (texts || []).map((t) => `（译）${t}`),
    translateReply: async (text, ctx, opts) => ({
      versions: [
        { text: `[EN v1] ${text}`, note: '更口语，朋友感' },
        { text: `[EN v2] ${text}`, note: '更短' },
        ...(opts && Number(opts.count) === 3 ? [{ text: `[EN v3] ${text}`, note: '更暖' }] : []),
      ],
      tip: '建议先接客户上句的话题，再自然带出你是画画的',
    }),
    // 档案：6 个核心字段进客户列；附加 10 字段（白名单）进 profile_json
    extractProfile: async (convText, existing) => ({
      ...(existing || {}),
      姓名: 'Dio',
      地区: '俄勒冈',
      电话号码: '+15419000088',
      时区: 'America/Los_Angeles',
      阶段: 2,
      加入时间: '',
      // 附加字段示例（server 按 EXTRA_PROFILE_KEYS 白名单收集）
      宠物: '谷仓猫一只',
      爱好: '打理农场',
    }),
    EXTRA_PROFILE_KEYS: ['婚姻情况', '生活规律', '别名', '老家家乡', '爱好', '职业', '家庭经济情况', '父母', '宠物', '孩子'],
    // 需求②：现在返回「分组」结构（每条客户留言一组，组内 3 条）。
    // 按传入的 groups 数量产出对应组数——几条留言就几组，每组 3 条。
    suggest: async (payload) => {
      const groupsIn = (payload && Array.isArray(payload.groups)) ? payload.groups : [{ index: 0, text: '客户留言' }];
      return {
        groups: groupsIn.map((g, i) => ({
          index: i,
          message: g.text || `客户留言${i + 1}`,
          options: [
            { angle: 'empathy', text: '听到你说的农场我就觉得好治愈，橘猫一定很淘气吧？' },
            { angle: 'story', text: '我刚画完一只正在打盹的橘猫，毛色和你说的好像。' },
            { angle: 'curiosity', text: '你那边的苹果熟了吗？我超爱秋天果园的味道。' },
          ],
        })),
        rationale: '沿 Day1-2 的朋友式聊天，先共情再分享，不问买卖。',
        riskFlags: [],
      };
    },
  };
}

/* ---------------- 启动 ---------------- */

(async () => {
  try {
    const db = require('../src/db');
    const doc = require('../src/customerDoc');
    const ai = require('../src/ai');
    const knowledge = require('../src/knowledge');
    const coach = require('../src/coach');
    const learn = require('../src/learn');
    const ids = require('../src/ids');
    const { createServer } = require('../src/server');
    const { loadConfig } = require('../src/main');

    const cfg = loadConfig();

    /* ============================================================
     *  模块级：ids
     * ============================================================ */
    section('模块 ids · 编号生成');
    eq('空账号首号', ids.nextCustomerCode(1, null), '1A00001');
    eq('顺序 +1', ids.nextCustomerCode(1, '1A00001'), '1A00002');
    eq('满 99999 进字母', ids.nextCustomerCode(1, '1A99999'), '1B00001');
    // 🔴 v2.6.1095：多了 prefix 字段（WA 段要靠它区分「编号前缀是 WA 还是数字」）
    eq('parseCode 解析', ids.parseCode('3A00050'), { account: 3, prefix: '3', letter: 'A', seq: 50 });
    eq('parseCode 解析 WA① 段', ids.parseCode('WA00001'), { account: 10, prefix: 'WA', letter: '', seq: 1 });
    eq('compareCode 顺序', ids.compareCode('1A00009', '1A00010'), -1);

    /* ============================================================
     *  模块级：db
     * ============================================================ */
    section('模块 db · 入库 / 待处理 / 查重');
    const { customer: c1 } = db.getOrCreateCustomer(1, '14155550001@c.us', { name: 'TestA' });
    const { customer: c1b } = db.getOrCreateCustomer(1, '14155550001@c.us', { name: 'TestA' });
    eq('同一 JID 不重复建号', c1.code, c1b.code);
    check('首次建号 isNew', c1.code.startsWith('1'));

    const r1 = db.saveMessage({ customerCode: c1.code, accountId: 1, direction: 'in', body: 'hello' });
    check('in 消息入库', r1.changes === 1);
    const cust = db.getCustomer.get(c1.code);
    eq('in 消息置为待处理', cust.pending, 1);
    const r2 = db.saveMessage({ customerCode: c1.code, accountId: 1, direction: 'out', body: 'hi back' });
    const cust2 = db.getCustomer.get(c1.code);
    eq('out 消息不再自动清 pending（待用户点「标记已回复」）', cust2.pending, 1);
    eq('out 消息清除未读', cust2.unread, 0);

    // 编号库：同手机号跨账号合并到同一编号（需求③：手机↔编号一一对应，读档案更快）
    const { customer: c2 } = db.getOrCreateCustomer(2, '14155550099@c.us', { phone: '14155550099' });
    const { customer: c3, isNew } = db.getOrCreateCustomer(3, '14155550099@c.us', { phone: '14155550099' });
    check('同手机号跨账号合并到同一编号（编号库）', c2.code === c3.code && isNew === false, JSON.stringify({ c2: c2.code, c3: c3.code, isNew }));

    // findPossibleDuplicates：两个不同编号但同手机号的客户能被找出来（绕过编号库直接改手机号的场景）
    const { customer: c4 } = db.getOrCreateCustomer(1, '14155551111@c.us', { phone: '14155551111' });
    db.updateCustomer.run({ code: c4.code, phone: '14155550099', name: null, region: null, timezone: null, stage_day: 0, mood: null, summary: null, profile_json: null, created_at: null, created_at_source: null });
    const dups = db.findPossibleDuplicates(c2.code);
    check('同手机号被判定为疑似重复', dups.some((d) => d.code === c4.code), JSON.stringify(dups.map((d) => d.code)));

    // 加入时间
    db.setJoinedAt(c1.code, new Date('2026-08-01').toISOString(), 'manual');
    const cust3 = db.getCustomer.get(c1.code);
    eq('加入时间来源 = manual', cust3.created_at_source, 'manual');
    check('joined_at 已写入', !!cust3.created_at);

    /* ============================================================
     *  模块级：knowledge
     * ============================================================ */
    section('模块 knowledge · 必加载 / 按需命中');
    knowledge.setKnowledgeConfig(cfg.knowledge);
    eq('必加载 4 份', knowledge.alwaysFiles().length, 4);
    check('必加载含 playbook7d', knowledge.alwaysFiles().some((f) => f.includes('playbook7d')));
    const priceHit = knowledge.matchFiles('这个尺寸多少钱？运费怎么算');
    check('问价格命中 products.md', priceHit.includes('products.md'), JSON.stringify(priceHit));
    const petHit = knowledge.matchFiles('my dog passed away last year');
    check('宠物过世命中 stories.md', petHit.includes('stories.md'));
    const blocks = knowledge.buildBlocks('这个多大尺幅？多少钱');
    check('知识块含人设内容', blocks.text.includes('人设'));
    check('命中时才带产品表', blocks.matched.includes('products.md'));

    /* ============================================================
     *  模块级：coach
     * ============================================================ */
    section('模块 coach · 阶段判定 / 角度');
    const dayPhoto = coach.inferDay({}, [{ direction: 'in', body: 'here is a photo of my cat', body_zh: '' }]);
    check('发来照片 → Day≥2', dayPhoto.day >= 2, `day=${dayPhoto.day}`);
    const dayVideo = coach.inferDay({}, [{ direction: 'in', body: 'can we do a video call', body_zh: '' }]);
    check('提到视频 → Day≥3', dayVideo.day >= 3, `day=${dayVideo.day}`);
    const manualDay = coach.inferDay({ stage_day: 5 }, []);
    eq('手动 stage_day 优先', manualDay.source, 'manual');
    const ang = coach.pickAngles(2, {});
    check('pickAngles 返回至少一个角度', ang.length >= 3, `len=${ang.length}`);
    check('buildCoachBlock 返回文本', typeof coach.buildCoachBlock({ day: 2, angles: ang, scene: '' }) === 'string');

    /* ============================================================
     *  模块级：learn
     * ============================================================ */
    section('模块 learn · 采纳记忆 / 负样本');
    const beforeLearned = learn.stats().learned;
    // 文本带时间戳，保证每次运行都是"全新一条"，不会命中历史记录里的去重
    const uniqText = `橘猫一定很淘气吧（自检 ${Date.now()}）`;
    const a1 = learn.recordAdopt({ angle: 'empathy', day: 2, scene: '农场猫好可爱', text: uniqText, customerCode: c1.code });
    const a2 = learn.recordAdopt({ angle: 'empathy', day: 2, scene: '农场猫好可爱', text: uniqText, customerCode: c1.code });
    check('首次采纳不是 dedup', a1.dedup === false);
    check('重复采纳返回 dedup', a2.dedup === true);
    eq('去重后只入库 1 条', learn.stats().learned - beforeLearned, 1);
    const ex = learn.findExemplars('农场猫真的好可爱啊', { day: 2 });
    check('相似场景能召回采纳样本', ex.length > 0);
    const beforeRej = learn.stats().rejected;
    const beforeCloseCount = learn.rejectCountOfAngle('close');
    learn.recordReject({ angle: 'close', day: 1, scene: '太早了', text: '现在下单有优惠', reason: '节奏太早', customerCode: c1.code });
    eq('负样本 +1', learn.stats().rejected - beforeRej, 1);
    eq('rejectCountOfAngle 计数 +1', learn.rejectCountOfAngle('close') - beforeCloseCount, 1);
    const rj = learn.findRejections('现在买更便宜哦', { limit: 5 });
    check('findRejections 能召回', rj.length > 0);

    /* ============================================================
     *  模块级：customerDoc
     * ============================================================ */
    section('模块 customerDoc · 时区 / 文档生成');
    eq('旧金山 → LA 时区', doc.guessTimezone('旧金山'), 'America/Los_Angeles');
    const diff = doc.timeDiffFromBeijing('America/Los_Angeles');
    check('美西比北京晚', diff.hours < 0, `hours=${diff.hours}`);
    const fn = doc.docFileName({ code: c1.code, name: 'Dio', phone: '14155550001' });
    check('档案文件名格式 = 编号_名称_电话', fn === `${c1.code}_Dio_14155550001.md`, fn);
    const sampleCust = { ...cust3, name: 'Dio', region: '俄勒冈' };
    const docPath = doc.writeCustomerDoc(sampleCust, [{ direction: 'in', body: 'hi', msg_ts: new Date().toISOString() }]);
    check('档案文档已落盘', fs.existsSync(docPath), docPath);
    const docText = fs.readFileSync(docPath, 'utf8');
    check('文档含加入时间字段', docText.includes('加入时间'));

    /* ============================================================
     *  模块级：ai（真实模块，空 key）
     * ============================================================ */
    section('模块 ai · 降级 / JSON 解析');
    ai.setAiConfig({ providers: { hunyuan: { type: 'openai_compatible', baseUrl: '', apiKey: '' } }, tasks: {} });
    eq('空 key 时 suggest 不就绪', ai.isReady('suggest'), false);
    eq('parseJsonSafe 去围栏', ai.parseJsonSafe('```json\n{"a":1}\n```'), { a: 1 });
    eq('parseJsonSafe 容错', ai.parseJsonSafe('前面废话 {"b":2} 后面废话'), { b: 2 });

    /* ============================================================
     *  HTTP 集成：起服务 + 假 AI
     * ============================================================ */
    section('HTTP · 启动服务 + 全链路');
    const fakeAi = makeFakeAi();
    const srv = createServer({ db, doc, ai: fakeAi, knowledge, cfg, getAccountStates: () => [] }, 8977);
    await new Promise((res) => srv.server.listen(8977, '127.0.0.1', res));
    const BASE = 'http://127.0.0.1:8977';

    const api = async (p, opts = {}) => {
      const res = await fetch(BASE + p, opts);
      const txt = await res.text();
      let body;
      try { body = JSON.parse(txt); } catch { body = txt; }
      return { status: res.status, body, raw: txt, contentType: res.headers.get('content-type') || '' };
    };

    // state
    let r = await api('/api/state');
    check('GET /api/state 200', r.status === 200 && r.body.ai && typeof r.body.pending === 'number');

    // 静态首页
    r = await api('/');
    check('GET / 返回 HTML', r.status === 200 && /text\/html/.test(r.contentType) && r.raw.includes('蜜蜂信息采集'), `ct=${r.contentType}`);

    // 手动录入（多行，含我方）
    // ⚠️ 最后一行必须是【客户发来的】—— 2026-10-09 起「生成建议」只取
    //    「我最后一条回复之后」的客户新消息（见 server.js handleSuggest 的 lastOutIdx）。
    //    这条对话以我方回复结尾的话，suggest 会正确地回「暂时不需要出建议」，测试就无从断言了。
    const ident = '+15419000077';
    r = await api('/api/manual', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ident, name: 'DioTest', region: '俄勒冈', accountId: 1,
        body: '我: 嗨我是画油画的 Wanqiu\n你那农场怎么样\n我: 我特别喜欢橘猫\n'
          + 'That sounds lovely — Sunny is the barn cat here, could you paint him for me?',
      }),
    });
    check('POST /api/manual 成功', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
    const code = r.body.code;
    check('录入后得到客户编号', /^1[A-Z]\d{5}$/.test(code), code);
    const msgs = db.listMessages.all(code);
    check('手动录入解析出 in/out 行', msgs.some((m) => m.direction === 'in') && msgs.some((m) => m.direction === 'out'));

    // 客户列表
    r = await api('/api/customers');
    check('GET /api/customers 返回数组', r.status === 200 && Array.isArray(r.body) && r.body.some((c) => c.code === code));

    // 单个客户：返回极简档案 6 字段（姓名/电话/地区/时区/阶段/加入时间）
    r = await api(`/api/customer/${code}`);
    check('GET /api/customer/:code 200', r.status === 200 && r.body.customer.code === code);
    check('返回档案含 6 字段列', ['name', 'phone', 'region', 'timezone', 'stage_day', 'created_at']
      .every((k) => k in r.body.customer), JSON.stringify(Object.keys(r.body.customer)));

    // 抽档案（假 AI：6 核心字段 + 2 个附加字段）
    r = await api(`/api/customer/${code}/extract`, { method: 'POST' });
    check('POST extract 200', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    const prof = db.getCustomer.get(code);
    check('抽取后写入地区', prof.region === '俄勒冈', JSON.stringify(prof));
    check('抽取后写入电话号码', prof.phone === '+15419000088', JSON.stringify(prof));
    check('抽取后写入时区', prof.timezone === 'America/Los_Angeles', JSON.stringify(prof));
    // 附加 10 字段落进 profile_json（白名单内）
    const extraSaved = JSON.parse(prof.profile_json || '{}');
    check('附加字段进 profile_json（宠物）', extraSaved['宠物'] === '谷仓猫一只', JSON.stringify(extraSaved));
    check('附加字段进 profile_json（爱好）', extraSaved['爱好'] === '打理农场', JSON.stringify(extraSaved));
    check('白名单外的键不会被写进 profile_json', !('姓名' in extraSaved) && !('阶段' in extraSaved),
      JSON.stringify(extraSaved));

    // 保存档案：6 核心字段正确落库；10 个附加字段经 profile_json 保存
    r = await api(`/api/customer/${code}/profile`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Dio', region: '俄勒冈', phone: '+15419000077',
        timezone: 'America/Los_Angeles', stage_day: 3,
        created_at: new Date('2026-07-15').toISOString(),
        profile_json: JSON.stringify({ 婚姻情况: '未婚', 生活规律: '早睡早起' }),
      }),
    });
    check('POST profile 200', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    const saved = db.getCustomer.get(code);
    check('姓名已保存', saved.name === 'Dio');
    check('电话已保存', saved.phone === '+15419000077');
    check('地区已保存', saved.region === '俄勒冈');
    check('时区已保存', saved.timezone === 'America/Los_Angeles');
    check('阶段已保存', saved.stage_day === 3);
    check('加入时间手动写入', saved.created_at_source === 'manual');
    const savedExtra = JSON.parse(saved.profile_json || '{}');
    check('弹窗保存的附加字段落库（婚姻情况）', savedExtra['婚姻情况'] === '未婚', JSON.stringify(savedExtra));
    check('弹窗保存的附加字段落库（生活规律）', savedExtra['生活规律'] === '早睡早起', JSON.stringify(savedExtra));

    // 2026-09-29：@lid 客户的那串内部编号（"抓到的长数字"）绝不进「电话号码」栏，手填也拦。
    //           它是身份标识，只该显示在档案弹窗那个只读的「WA对话编号」里。
    {
      const acct = db.listAccounts.all()[0];
      const lidJid = '243834688639050@lid';
      const { customer: lidC } = db.getOrCreateCustomer(acct.id, lidJid, { name: 'Lucky', phone: '' });
      let r3 = await api(`/api/customer/${lidC.code}/profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '243834688639050' }),
      });
      check('@lid 那串编号当电话填 → 后端兜底拦掉（不写进电话号码）',
        r3.status === 200 && !db.getCustomer.get(lidC.code).phone,
        JSON.stringify(db.getCustomer.get(lidC.code)));
      r3 = await api(`/api/customer/${lidC.code}/profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+447726795080' }),
      });
      check('@lid 客户手填真号码 → 正常存下来',
        db.getCustomer.get(lidC.code).phone === '+447726795080',
        String(db.getCustomer.get(lidC.code).phone));
      check('@lid 客户的 wa_jid 原样留着（档案弹窗就靠它显示「WA对话编号」）',
        db.getCustomer.get(lidC.code).wa_jid === lidJid);
    }

    // 关键回归：补录带地区的对话不应清空已抽好的档案（server.js handleManual 修复点）
    {
      const rid = '+15419000088';
      let rr = await api('/api/manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ident: rid, name: 'Reg', region: '俄勒冈', accountId: 1, body: '你好' }),
      });
      const rcode = rr.body.code;
      rr = await api(`/api/customer/${rcode}/extract`, { method: 'POST' });
      const before = db.getCustomer.get(rcode);
      // 再补录一次带地区的对话
      await api('/api/manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ident: rid, region: '俄勒冈', accountId: 1, body: '苹果熟了' }),
      });
      const after = db.getCustomer.get(rcode);
      check('补录带地区不清空已抽档案',
        !!before.region && !!before.phone && after.region === before.region && after.phone === before.phone,
        JSON.stringify({ b: before, a: after }));
    }

    // 出建议（需求②：现在按「每条客户留言一组，组内 3 条」返回 groups）
    r = await api(`/api/customer/${code}/suggest`, { method: 'POST', body: JSON.stringify({}) });
    check('POST suggest 200', r.status === 200 && Array.isArray(r.body.groups) && r.body.groups.length >= 1 && r.body.groups.every((g) => g.options.length === 3), JSON.stringify(r.body).slice(0, 200));
    check('建议带回 suggestionId', typeof r.body.suggestionId === 'number');
    check('建议带回教练角度', Array.isArray(r.body.angles) && r.body.angles.length === 3);
    const sid = r.body.suggestionId;
    const suggestBody = r.body;

    // 翻译：选中某条建议 → 出 2-3 个英文版本（按客户信息调口吻）
    r = await api('/api/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: r.body.groups[0].options[0].text, code, provider: 'hunyuan', count: 3 }),
    });
    check('POST /api/translate 200', r.status === 200 && r.body.ok && Array.isArray(r.body.versions) && r.body.versions.length >= 2, JSON.stringify(r.body).slice(0, 200));
    // ④ 现在由「AI 设置 → ④ 采纳后翻成英文」决定用哪家：界面就算传 hunyuan 也不作数，
    //    一律按配置里选的那家翻（口吻前后一致）
    const trWanted = cfg?.ai?.tasks?.translateReply?.provider || 'gpt';
    check('翻译走「AI 设置 → ④」选的那家（界面传的 provider 不作数）',
      r.body.provider === trWanted && r.body.provider !== 'hunyuan',
      JSON.stringify({ got: r.body.provider, want: trWanted }));
    check('翻译带回 AI tip', typeof (r.body.tip || '') === 'string');

    // 空文本应报错
    r = await api('/api/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    check('空文本翻译返回错误', r.status === 503 && !!r.body.error, JSON.stringify(r.body));

    // 采纳（用分组坐标：第 0 组第 0 条）
    const learnedBefore = learn.stats().learned;
    r = await api('/api/suggestion/adopt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestionId: sid, groupId: 0, optionIndex: 0, day: suggestBody.day?.day ?? 2, scene: '农场猫', text: suggestBody.groups[0].options[0].text }),
    });
    check('POST adopt 200', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    eq('采纳后话术库 +1', learn.stats().learned - learnedBefore, 1);

    // 不采纳整批 → 换思路重出 + 负样本（组数 ×3）
    const rejBefore = learn.stats().rejected;
    r = await api('/api/suggestion/reject', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestionId: sid, optionIndex: -1, day: 2, scene: '农场猫', reason: '太客套' }),
    });
    const expectedNeg = suggestBody.groups.reduce((n, g) => n + g.options.length, 0);
    check('POST reject 返回新建议', r.status === 200 && Array.isArray(r.body.groups) && r.body.groups.length >= 1, JSON.stringify(r.body).slice(0, 150));
    eq('整批否掉负样本数 = 建议总数', learn.stats().rejected - rejBefore, expectedNeg);

    // 话术库
    r = await api('/api/learned');
    check('GET /api/learned 含统计', r.status === 200 && r.body.stats && typeof r.body.stats.learned === 'number');
    const delId = r.body.learned[0]?.id;
    if (delId) {
      const beforeDel = learn.stats().learned;
      r = await api(`/api/learned/${delId}`, { method: 'DELETE' });
      check('DELETE /api/learned/:id 成功', r.status === 200 && r.body.ok);
      eq('删除后话术库 -1', learn.stats().learned, beforeDel - 1);
    }

    // 标记已回复
    r = await api(`/api/customer/${code}/replied`, { method: 'POST' });
    check('POST replied 200', r.status === 200 && r.body.ok);
    eq('已回复后 pending=0', db.getCustomer.get(code).pending, 0);
    // ⑤「标记已回复」：消息框消失 ≠ 删除 —— 最新对话要落盘到该编号对应的档案文件里
    check('标记已回复 → 返回该客户的档案文件路径',
      typeof r.body.docFile === 'string' && /\.md$/.test(r.body.docFile), JSON.stringify(r.body));
    check('标记已回复 → 档案文件真的写在磁盘上，且内容含这个客户的对话',
      !!r.body.docFile && fs.existsSync(r.body.docFile)
      && fs.readFileSync(r.body.docFile, 'utf8').includes('Dio'),
      String(r.body.docFile));

    /* ============================================================
     *  左栏累计未读 · 点开清零 · 消息翻译状态（2026-09-24 用户截图需求）
     * ============================================================ */
    section('左栏累计新消息 · 标记已看 · 翻译状态');
    const translator = require('../src/translator');

    // 客户连发 3 条（同一编号）→ 未读累计成 3，不是铺成 3 个格子
    for (let i = 1; i <= 3; i++) {
      db.saveMessage({
        customerCode: code,
        accountId: 1,
        direction: 'in',
        body: i === 1 ? '你好，我想问一下价格' : `第 ${i} 条新消息 Hi there`,
        waMsgId: `unread-${i}`,
      });
    }

    r = await api('/api/state');
    check('GET /api/state 带未读总数', typeof r.body.unread === 'number' && r.body.unread >= 3, JSON.stringify({ unread: r.body.unread }));

    r = await api('/api/customers');
    const row = r.body.find((c) => c.code === code);
    eq('同一客户的多条新消息累计成一个未读数', row.unread, 3);
    // FIFO 新规则：所有「有未读」的客户整体排在「无未读」客户之前（越先来的未读越靠上；
    // 同一客户连发多条时位置不动）。DioTest 是测试后期才录入、queue_since 最晚，故不保证在 [0]，
    // 但只要它（unread=3）落在「无未读客户」之前即符合规则。
    const firstNonUnread = r.body.findIndex((c) => (c.unread || 0) === 0);
    const unreadAllBefore = firstNonUnread === -1
      ? true
      : r.body.slice(0, firstNonUnread).every((c) => (c.unread || 0) > 0);
    check('有未读的客户整体排在列表最上面（FIFO：越新越靠下）', unreadAllBefore,
      JSON.stringify(r.body.map((c) => ({ code: c.code, unread: c.unread }))));
    check('DioTest（未读=3）排在所有无未读客户之前',
      firstNonUnread === -1 || r.body.slice(0, firstNonUnread).some((c) => c.code === code),
      JSON.stringify(r.body.map((c) => ({ code: c.code, unread: c.unread }))));

    r = await api('/api/customers?only=unread');
    check('?only=unread 只返回有未读的客户', r.body.length > 0 && r.body.every((c) => (c.unread || 0) > 0));

    // 点开 = 我看过了 → 未读清零；但 pending（还没回复）不受影响
    r = await api(`/api/customer/${code}/read`, { method: 'POST' });
    check('POST /api/customer/:code/read 200', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    eq('标记已看后未读清零', db.getCustomer.get(code).unread, 0);
    eq('标记已看【不】动"待处理"（那是回没回复的事）', db.getCustomer.get(code).pending, 1);

    // 语种判断：英文要翻，中文不翻（省一半 AI 调用，也让"等待翻译中"只出现在该等的地方）
    check('英文消息需要翻译', translator.needsTranslation('hi, is this still available?') === true);
    check('客户发的中文不翻译', translator.needsTranslation('你好，我想问一下价格') === false);
    check('图片占位不翻译', translator.needsTranslation('[图片/附件]') === false);

    r = await api(`/api/customer/${code}`);
    const zhMsg = r.body.messages.find((m) => m.body === '你好，我想问一下价格');
    const enMsg = r.body.messages.find((m) => m.body === '第 2 条新消息 Hi there');
    check('中文消息不标"等待翻译中"', zhMsg && !zhMsg.translating && !zhMsg.untranslated, JSON.stringify(zhMsg));
    check('英文消息标记为待翻译（界面据此显示「等待翻译中」）',
      enMsg && enMsg.translating === false && enMsg.untranslated === true, JSON.stringify(enMsg));
    check('接口回报还有几条没翻', typeof r.body.untranslated === 'number' && r.body.untranslated >= 2, String(r.body.untranslated));

    // 补翻译接口：AI 没配好时给出原因，不空跑（假 AI 走的是真 translator，真 translator 看真配置）
    r = await api(`/api/customer/${code}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max: 5 }),
    });
    check('POST /api/customer/:code/translate 能应答且不崩',
      r.status === 200 && typeof r.body.queued === 'number', JSON.stringify(r.body).slice(0, 160));

    /* ---- 左栏「今日消息」提示窗的数据源：GET /api/stats/today ---- */
    const t1 = await api('/api/stats/today');
    check('GET /api/stats/today 200 且字段齐全',
      t1.status === 200 && typeof t1.body.received === 'number'
      && typeof t1.body.handled === 'number' && typeof t1.body.todo === 'number'
      && !!t1.body.byAccount, JSON.stringify(t1.body).slice(0, 160));
    db.saveMessage({ customerCode: code, accountId: 1, direction: 'in', body: 'today +1', waMsgId: 'today-1' });
    const t2 = await api('/api/stats/today');
    eq('今天再来一条 → 收到 +1', t2.body.received, t1.body.received + 1);
    eq('同时待处理 +1', t2.body.todo, t1.body.todo + 1);
    eq('按账号拆的 1 号也 +1', t2.body.byAccount['1'] || 0, (t1.body.byAccount['1'] || 0) + 1);
    db.saveMessage({
      customerCode: code, accountId: 1, direction: 'in', body: '很久以前', waMsgId: 'today-old',
      msgTs: '2020-01-01T00:00:00.000Z',
    });
    const t3 = await api('/api/stats/today');
    eq('往年老消息不计入今天', t3.body.received, t2.body.received);

    srv.server.close();

    /* ============================================================
     *  账号条：打开浏览器 / 红绿灯（回归用）
     *  真实踩过的坑：app.js 顶层声明在使用之后（暂时性死区），
     *  脚本第一行就抛 ReferenceError，结果所有按钮都绑不上事件——
     *  表现就是"点了没反应"。这里用 DOM 桩把 app.js 真正执行一遍来守住。
     * ============================================================ */
    section('界面 · app.js 能正常加载');
    {
      const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
      const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

      // 1) app.js 顶层必须能跑完（不再有暂时性死区之类的低级错误）
      //    注意：这里会把 window/document/fetch 换成桩。桩用完【必须还原】——
      //    原来忘了还原 fetch，导致后面任何真的打接口的用例都会炸
      //    （报 "Cannot read properties of undefined (reading 'get')"）。
      let loadErr = null;
      const gReal = {
        window: global.window, document: global.document, navigator: global.navigator,
        EventSource: global.EventSource, fetch: global.fetch,
      };
      try {
        const els = {};
        const mkEl = (id) => (els[id] ||= {
          id, textContent: '', innerHTML: '', value: '', className: '', disabled: false,
          dataset: {}, style: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
          addEventListener() {}, focus() {}, remove() {}, insertAdjacentHTML() {},
          appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
        });
        global.window = { addEventListener() {} };
        global.document = {
          getElementById: mkEl,
          querySelectorAll: () => [],
          addEventListener() {},
        };
        global.navigator = {};
        global.EventSource = class { addEventListener() {} };
        global.fetch = async () => ({ json: async () => ({}), text: async () => '' });
        new Function(appjs)();
        // 顶层启动的那些异步调用（refreshState / refreshCustomers / refreshToday …）
        // 会在微任务里继续碰 document，所以等它们跑完再还原全局桩。
        await new Promise((r) => setTimeout(r, 80));
      } catch (e) {
        loadErr = e;
      } finally {
        // 还原全局桩，别污染后面的用例（真 fetch 必须还回去）
        global.window = gReal.window;
        global.document = gReal.document;
        global.navigator = gReal.navigator;
        global.EventSource = gReal.EventSource;
        global.fetch = gReal.fetch;
      }
      check('app.js 顶层无脚本错误（否则所有按钮都失效）', !loadErr, loadErr ? loadErr.message : '');
      check('加载 app.js 用的全局桩用完已还原（fetch 必须还是真的）',
        global.fetch === gReal.fetch && typeof global.fetch === 'function');

      // 2) 界面里用到的 id 必须真实存在：要么在 index.html 里，
      //    要么是 app.js 自己在 innerHTML 模板里生成的（renderProfile / renderSuggest）
      //
      // 🔴 v2.6.1093 老板拍板 Tele① 改回内置浏览器后，index.html 里删掉了三块读库界面
      //    （tele-left 会话列表 / tg-conv 气泡区 / tg-composer 回复框）。
      //    app.js 里对应的函数**故意保留**（将来要恢复网页版读取时把元素加回 HTML 即可，
      //    函数本身全部有判空保护，不会在缺元素时报错）。
      //    所以这批 id 属于「已知可选」：不算缺失，但也必须留在名单里显式登记，
      //    一旦有人改了这些函数却忘了同步名单，测试会立刻发现多出来的未知缺失。
      const OPTIONAL_TG_IDS = new Set([
        'btn-tg-list-refresh', 'btn-tg-conv-refresh', 'tg-list', 'tg-chat-title', 'tg-conv-sub',
        'tg-conv-body', 'tg-avatar', 'tg-userinfo', 'tui-close', 'tui-photo', 'tui-initial',
        'tui-name', 'tui-lastseen', 'tui-phone', 'tui-username', 'tg-composer', 'tg-reply',
        'tg-reply-text', 'tg-reply-x', 'tg-input', 'tg-file', 'tg-attach-img',
        'tg-attach-video', 'tg-send',
      ]);
      const ids = [...new Set([...appjs.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
      const selfMade = new Set([...appjs.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
      const missing = ids.filter((id) => !html.includes(`id="${id}"`) && !selfMade.has(id));
      // 真实缺失 = 缺失清单里扣掉已登记的可选 id，剩下的才是问题
      const realMissing = missing.filter((id) => !OPTIONAL_TG_IDS.has(id));
      const registeredButPresent = [...OPTIONAL_TG_IDS].filter(
        (id) => ids.includes(id) && html.includes(`id="${id}"`) && !selfMade.has(id),
      );
      check(`app.js 引用的 ${ids.length - missing.length + realMissing.length} 个 id 都有落点`,
        realMissing.length === 0, realMissing.join('、'));
      check('Tele① 已删元素的可选 id 名单与实际缺失一致（防止名单过期）',
        registeredButPresent.length === 0,
        `这些可选 id 又出现在 index.html 里了，名单该清理：${registeredButPresent.join('、')}`);

      // 3) 关键交互不能是空实现
      check('登录/消息有界面提示（notice 事件）', html.includes('id="toast"') && appjs.includes('showNotice'));

      // 4) 账号条：五个账号各一块，【账号名本身就是按钮】+ 红绿灯
      const leds = appjs.includes('ledOf') && appjs.includes('class="led');
      // 账号条是对 accounts 数组逐个渲染，一个账号一块，所以源码里各出现一次模板
      check('顶栏账号名本身就是按钮（点名字开浏览器）',
        appjs.includes('class="acct-name" data-act="open"') && html.includes('class="acct-bar"'));
      check('账号条【不应】再有单独的「浏览器」按钮（已按需求合并到名字上）',
        !/>浏览器</.test(appjs));
      check('顶栏每个账号【不应】有「扫码」小按钮（已按需求删除）', !appjs.includes('data-act="qr"'));
      check('顶栏有红绿灯（绿=在线 / 黄=待扫码 / 红=离线）', leds);
      check('账号状态来自 /api/state 的 accounts', appjs.includes('/api/state') && appjs.includes('renderAccounts'));

      // 5) 二维码已从主界面彻底移除：扫码改到 Chrome 窗口里做（点账号名启动那个账号，在它的窗口里扫）
      check('主界面【不应】再出现二维码小卡片', !appjs.includes('acct-pop') && !css.includes('.acct-pop') && !html.includes('id="qr-modal"'));
      check('主界面【不应】有「扫码」相关逻辑（openQr / qr 弹窗）', !appjs.includes('openQrModal') && !appjs.includes('openQr['));

      // 5b) 左栏"新消息提醒"：同客户累计未读数 + 点开清零 + 右栏等待翻译中
      check('左栏有未读数徽标（同一客户的多条新消息累计成一格）',
        appjs.includes('class="unread"') && css.includes('.cust .unread'));
      check('点开客户会标记已看（未读清零；和"标记已回复"是两个动作）',
        appjs.includes('/read`') && appjs.includes('/replied`'));
      check('右栏客户名下方有"等待翻译中"状态条',
        html.includes('id="chat-status"') && appjs.includes('等待翻译中') && css.includes('.chat-status'));
      check('正在翻译的气泡里有占位（等待翻译中，翻好自动换成中文）',
        appjs.includes('zh waiting') && css.includes('.zh.waiting'));

      // 6) 后端要有「打开浏览器」接口，且没有被写死成 501
      const srvjs = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
      const mainjs = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
      check('后端提供 POST /api/account/:id/open', /\/api\\\/account\\\//.test(srvjs) && srvjs.includes('openAccount'));
      check('openAccount 已接到内核并导出', mainjs.includes('openAccount') && mainjs.includes('runningSessions.set'));

      // 7) 五个账号：config 里必须是 5 个，界面才会排 5 块
      const cfgAccounts = (cfg.accounts || []).length;
      check('config.yaml 配了 5 个账号（界面就排 5 块）', cfgAccounts === 5, `实际 ${cfgAccounts}`);

      // 8) 桌面窗口必须能打开：
      //    startCore 已经把 HTTP 服务 listen 好了，入口再 listen 一次会抛
      //    ERR_SERVER_ALREADY_LISTEN，窗口就永远出不来（真实发生过的"卡住不动"）。
      const emjs = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
      check('桌面入口不再对后端重复 listen', !/listen\s*\(\s*backend\.srv/.test(emjs));
      check('桌面入口启动失败会弹错误框（不再静默死掉）',
        emjs.includes('dialog.showErrorBox') && emjs.includes('unhandledRejection'));
      check('桌面入口启动时不自动拉起浏览器（按需求：双击先见干净工作区，浏览器按需点）',
        /startWhatsApp:\s*false/.test(emjs));
    }

    /* ============================================================
     *  本轮改动自检（2026-09-25）：
     *    ① 改名「蜜蜂采息」→「蜜蜂信息采集」
     *    ② AI 任务 + 服务商（含申请地址）
     *       🔴 老板拍板删除：服务商 hunyuan（混元Hy3）/ gpt / anthropic / vision（视觉）/
     *          audio（听觉）；任务 vision（看图）/ asr（听语音）/ video（看视频）。
     *          凡是被删实体的断言，一律改成「已删除」的反向断言（防复发），不许注释了事。
     *    ③ hy3 报 404 的根因（baseUrl 自带 /chat/completions，代码又拼了一次）
     *    ④ 中栏档案条 14px 加粗黑体（加入时间 + 客户当地时间）+「生成建议」挪到中栏底部
     * ============================================================ */
    section('本轮 · 改名 / 7 个 AI / 404 / 界面');
    {
      const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
      const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
      const aix = fs.readFileSync(path.join(ROOT, 'src', 'ai.js'), 'utf8');
      const srvjs2 = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
      const dbjs = fs.readFileSync(path.join(ROOT, 'src', 'db.js'), 'utf8');
      const mainjs2 = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
      const cfgText = fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8');

      /* ---- ① 改名 ---- */
      check('界面标题已改成「蜜蜂信息采集」', html.includes('蜜蜂信息采集'));
      check('前端三个文件里【不应】再出现旧名「蜜蜂采息」',
        !appjs.includes('蜜蜂采息') && !html.includes('蜜蜂采息') && !css.includes('蜜蜂采息'));
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      check('打包出来的软件名也改了（build.productName）',
        !!(pkg.build && pkg.build.productName === '蜜蜂信息采集'));

      /* ---- ② 5 个 AI 任务（看图 / 听语音 / 看视频 三个已删除）---- */
      const TASKS5 = ['receive', 'translate', 'suggest', 'translateReply', 'freeTranslate'];
      const tasks = (cfg.ai && cfg.ai.tasks) || {};
      const missTask = TASKS5.filter((k) => !tasks[k]);
      check(`config.yaml 里 5 个 AI 任务都在（缺：${missTask.join('、') || '无'}）`, missTask.length === 0);
      // ⚠️ 项目铁律：断言别写死与真实 config 有关的值（用户会改配置，一改测试就红）。
      // 所以「用哪家」一律只校验「指向 ai.js 目录里现在还存在的服务商」，不钉死具体某家。
      // 🔴 老板已删除：服务商 hunyuan / gpt / anthropic / vision / audio，
      //    任务 vision（看图）/ asr（听语音）/ video（看视频）—— 下面改成反向断言守住「别回来」。
      const aiModCat = require('../src/ai');
      const aiCatProv = aiModCat.PROVIDER_CATALOG.map((p) => p.key);
      const aiCatTask = aiModCat.TASK_CATALOG.map((t) => t.key);
      const DEL_PROV = ['gpt', 'anthropic', 'vision', 'audio'];
      const DEL_TASK = ['vision', 'asr', 'video'];
      const validProv = aiCatProv;
      check('③ 回复建议指向目录里的一家服务商（用哪家由「AI 设置」决定）',
        !!(tasks.suggest && validProv.includes(tasks.suggest.provider)),
        tasks.suggest && tasks.suggest.provider);
      const trChoice = aiModCat.TASK_CATALOG.find((t) => t.key === 'translateReply');
      check('④「采纳后翻成英文」指向它可选集里的一家（不再锁死某一家）',
        !!(tasks.translateReply && trChoice && Array.isArray(trChoice.providerChoices)
          && trChoice.providerChoices.includes(tasks.translateReply.provider)),
        tasks.translateReply && tasks.translateReply.provider);
      // ⑤ 看图 / ⑥ 听语音 / ⑦ 看视频：三个任务已整块删除，config.yaml 里不该再有它们。
      const delTaskLeft = DEL_TASK.filter((k) => tasks[k]);
      check('【已删除】config.yaml 里不再有 看图 vision / 听语音 asr / 看视频 video 三个任务',
        delTaskLeft.length === 0, delTaskLeft.join('、') || '无');

      /* ---- ②' 在用的服务商端口 + 申请地址 ---- */
      const provs = (cfg.ai && cfg.ai.providers) || {};
      // 只盯「正在用」的那几家必须在 config.yaml 里有块：
      //   · hunyuan 是删掉后残留在配置里的历史块，不算必需（也不算错）；
      //   · bailian 目录里有、配置里暂时没块，setScalar 现在能自动补，不在这里卡它。
      const missProv = ['deepseek', 'agnes', 'siliconflow', 'openrouter', 'tikhub', 'astrbot']
        .filter((k) => !provs[k]);
      check(`在用的服务商端口在 config.yaml 里都有块（缺：${missProv.join('、') || '无'}）`, missProv.length === 0);
      const delProvLeft = DEL_PROV.filter((k) => provs[k]);
      check('【已删除】config.yaml 里不再有 gpt / anthropic / 视觉 / 听觉这四个已删端口',
        delProvLeft.length === 0, delProvLeft.join('、') || '无');
      const catProvLeft = ['hunyuan', 'gpt', 'anthropic', 'vision', 'audio'].filter((k) => aiCatProv.includes(k));
      check('【已删除】ai.js 服务商目录里不再有 混元 / GPT / Claude / 视觉 / 听觉',
        catProvLeft.length === 0, catProvLeft.join('、') || '无');
      const catTaskLeft = DEL_TASK.filter((k) => aiCatTask.includes(k));
      check('【已删除】ai.js 任务目录里不再有 看图 / 听语音 / 看视频',
        catTaskLeft.length === 0, catTaskLeft.join('、') || '无');
      check('ai.js 有服务商目录，带申请地址（applyUrl）',
        aix.includes('PROVIDER_CATALOG') && aix.includes('applyUrl'));
      const applyUrls = [...aix.matchAll(/applyUrl:\s*'([^']+)'/g)].map((m) => m[1]);
      check(`每个服务商都给了申请地址（${applyUrls.length} 个）`, applyUrls.length >= 6);
      check('申请地址都是点得开的 https 链接',
        applyUrls.length > 0 && applyUrls.every((u) => u.startsWith('https://')));
      check('ai.js 有 5 个任务的中文说明目录（界面按它显示"干什么 / 用哪家"，已删的三个不在里）',
        aix.includes('TASK_CATALOG') && TASKS5.every((k) => aix.includes(`key: '${k}'`))
        && !DEL_TASK.some((k) => aix.includes(`key: '${k}'`)));
      // ⑤⑥⑦ 已删除：后端那张白名单不再依赖写死的旧数组（旧兜底里还留着 asr / video 字符串），
      // 而是运行时直接取 ai.js 的目录 —— 这样以后再删/加任务，后端不用跟着改。
      check('后端 /api/ai/config 的白名单取自 ai.js 目录（不再写死含 asr / video 的老名单）',
        srvjs2.includes('ai.PROVIDER_CATALOG') && srvjs2.includes('ai.TASK_CATALOG'));
      // AI 设置界面 2026-09-30 搬到「全局设置」窗口了，这个名单跟着挪进 settings.js
      const setjsAI = fs.readFileSync(path.join(ROOT, 'public', 'settings.js'), 'utf8');
      check('界面服务商清单由 ai.js 目录渲染（视觉 / 听觉已删除，不再写死在界面里）',
        setjsAI.includes('aiCat?.providers') && !setjsAI.includes("'vision', 'audio'"));
      check('④ 前端不再写死单一服务商（改由「AI 设置」里选）',
        !appjs.includes("const provider = 'gpt'"));
      check('④ 后端不再把 translateReply 钉死在 gpt（改由「AI 设置」里选）',
        !srvjs2.includes("if (name === 'translateReply') continue"));
      // 2026-10-09：新增服务商必须补进「一套配好」的默认模型表，否则 modelFor 为 null、
      // 整个默认切换分支被静默跳过（选 TikHub 保存后 ②③ 根本没变）。这里守 TikHub 那一行。
      check('「一套配好」的默认模型表里补了 TikHub（漏了会静默跳过整段切换）',
        srvjs2.includes("tikhub: 'gpt-4o-mini'"));
      // 2026-10-09：手动自由翻译「中文→外文」要给每个情绪版本附「该版本的中文说法」，
      // 三种口吻回译出的中文短句各不相同、逐条显示；这里守「后端带 zh + 前端渲染 ft-ver-zh」这条链。
      check('自由翻译：提示词要求每个版本给 zh（该版本的中文说法）',
        aix.includes('"zh":"这句的中文说法"'));
      check('自由翻译：后端解析出每个版本的 zh 并透传',
        aix.includes('zh: v.zh ? String(v.zh).trim()'));
      check('自由翻译：前端每个情绪版本下方渲染中文（ft-ver-zh + 样式）',
        appjs.includes('ft-ver-zh') && css.includes('.ft-ver-zh'));

      /* ---- ④ 翻译弹窗：模型徽章跟着走 + 自动/手动 + 采纳后保留「翻译」 ---- */
      check('翻译弹窗的模型徽章跟着「AI 设置 → ④」显示（不再写死「GPT（固定）」）',
        !appjs.includes('GPT（固定）') && !html.includes('（固定）') && appjs.includes('tr-provider-label'));
      check('每个服务商都有短名 short（徽章只显示 DeepSeek / Agnes / TikHub 这种短名）',
        (aix.match(/short:\s*'[^']+'/g) || []).length >= 7);
      check('翻译弹窗有「方式」下拉：自动翻译 / 手动翻译',
        html.includes('id="tr-mode"') && html.includes('自动翻译') && html.includes('手动翻译')
        && appjs.includes('bee.trMode') && appjs.includes('getTrMode'));
      check('选「自动翻译」时开窗即翻（不用点「翻译」按钮）',
        appjs.includes("getTrMode() === 'auto') doTranslate()"));
      const adoptDone = (appjs.match(/class="angle done">已记住[\s\S]{0,700}/) || [''])[0];
      check('点「采纳」之后卡片里的「翻译」按钮还在（采纳完能接着翻英文）',
        adoptDone.includes('class="tr"') && adoptDone.includes('translateOption(g, i, text'));

      /* ---- ③ 404 ---- */
      check('ai.js 有地址规范化（cleanBase：去引号 / 去重复端点 / 补 /v1）', aix.includes('function cleanBase'));
      // 混元 hy3 已删除，但「baseUrl 只写到 /v1、别自带 /chat/completions」这条 404 铁律
      // 对**所有**服务商都成立 —— 所以不再只盯 hunyuan 一家，改成扫全表（比原来更严）。
      const badSuffix = Object.keys(provs).filter((k) => /chat\/completions/.test(String((provs[k] || {}).baseUrl || '')));
      check('所有服务商的 baseUrl 都只写到 /v1，【不】自带 /chat/completions',
        badSuffix.length === 0, badSuffix.join('、') || '无');
      const badQuote = Object.keys(provs).filter((k) => /['"]/.test(String((provs[k] || {}).baseUrl || '')));
      check('所有服务商的 baseUrl 里都没有多余引号（复制粘贴高发错误 → 直接 404）',
        badQuote.length === 0, badQuote.join('、') || '无');
      check('报错里带真实请求地址 + 404 排查提示（下次一眼看出）',
        aix.includes('请求地址') && aix.includes('404'));
      check('配置文件里写了"只写到 /v1 为止"的提醒', cfgText.includes('只写到 /v1 为止'));

      /* ---- ④ 界面：客户档案卡（v2.6.1118 改成跟 Tele 档案卡同一栏竖排）----
         老板 2026-10-14 20:29 看图 QQ20261014-195410.png 指名：
         「通用」标签这块要跟 Tele 档案卡（QQ20261014-195428.png 红框）同字体、同颜色、同竖排。
         实现落点 = 通用侧直接用 .tv-card/.tv-head/.tv-ln/.tv-actions 同一套 class，
         旧的 .ch-facts 2×2 网格整块删除。下面断言锁的是这个新结构。 */
      check('中栏档案卡是 .tv-card 单栏卡（跟 Tele 同一套class）',
        /* 🔴 v2.6.1118 21:45 修正：卡片容器 #ch-head-slot 已从中栏顶部搬到**右栏**
           （.gen-aside，id 沿用 chat-head），所以 class="tv-card ch-card" 现在写在
           index.html 的静态结构里，app.js 只渲染卡内 .tv-body/.tv-actions。 */
        html.includes('class="tv-card ch-card"') && html.includes('id="ch-head-slot"')
        && appjs.includes('class="tv-body"')
        && appjs.includes('class="tv-head"') && appjs.includes('class="tv-actions"'));
      check('档案卡含「加入时间」', appjs.includes('加入时间'));
      check('档案卡含「客户当地时间」', appjs.includes('客户当地时间') && appjs.includes('localTimeOf'));
      check('四项逐行竖排（.tv-ln × 4：加入时间 / 认识第N天 / 地区 / 客户当地时间）',
        (appjs.match(/class="tv-ln"/g) || []).length >= 3
        && (appjs.match(/class="tv-ln sep"/g) || []).length >= 1);
      check('「认识第 N 天」前后各一个黄色五角星（css .tv-star 黄色 + app.js 两个 ★）',
        /\.tv-star \{[^}]*color: #f5b301/.test(css)
        /*注意：class="tv-star" 现在通用侧也有一份（v2.6.1118），所以是「每张卡2 个」而不是全库2 个。
          断言改成「至少 2 个」—— 具体哪张卡由渲染自检那一组兜。*/
        && (appjs.match(/class="tv-star"/g) || []).length >= 2);
      check('「Day N」紫色 / 加粗（css .tv-fact-day）',
        /\.tv-fact-day \{[^}]*color: #7c3aed[^}]*font-weight: 800/.test(css));
      check('通用侧已不再用旧的 .ch-facts 2×2 网格（v2.6.1118 删掉）',
        //只查**真实代码**，注释里提到旧名不算（否则这条永远红）
        !/class="ch-facts"/.test(appjs) && !/id="ch-doc-col"/.test(appjs)
        && !/#chat-head \.ch-facts \{/.test(css) && !/#chat-head \.ch-doc-col \{/.test(css));
      check('中栏适配只留最小几条（#chat-head .ch-card），观感仍由 .tv-* 决定',
        /#chat-head \.ch-card \{/.test(css) && !/#chat-head \.ch-card \.tv-head \{/.test(css));
      check('客户名加黑加粗（css .ch-name #000 + font-weight: 800）',
        /#chat-head \.ch-name \{[\s\S]*?font-weight: 800;[\s\S]*?color: #000;/.test(css));
      check('「⚡ 生成建议」已挪到中栏底部（在 #chat 的 #chat-foot 里、右栏之前）',
        html.indexOf('id="btn-suggest"') > html.indexOf('id="chat-foot"')
        && html.indexOf('id="btn-suggest"') < html.indexOf('id="panel"'));
      check('右栏「中文回复建议」卡片已整体移除（生成建议改到独立浮窗里出）',
        html.indexOf('id="suggest-out"') === -1
        && !appjs.includes("$('suggest-out')")
        && appjs.includes('beeSuggest.open'),
        `index.html 里 suggest-out=${html.indexOf('id="suggest-out"')}`);

      /* ---- ⑤⑥⑦ 媒体：图 / 语音走后台，不卡消息 ---- */
      check('消息表有 media_zh 列（AI 看完/听完写的中文说明存这）', dbjs.includes('media_zh'));
      check('收到图片/语音会丢后台队列', mainjs2.includes('media.describeLater'));
      check('看图/听语音不 await（消息先上界面，AI 在后台慢慢看）',
        !/await\s+media\.describeLater/.test(mainjs2));
      check('ai.js 真有看图（describeImage）与听语音（transcribe）的实现',
        aix.includes('async function describeImage') && aix.includes('async function transcribe'));
    }

    /* ============================================================
     *  顶栏「AI 提示词」按钮：看每个 AI 是拿什么话去干这件事的
     *  关键在「看到的就是真发的」——提示词必须只有一份，界面和任务共用，
     *  否则界面上展示一套、实际发另一套，等于骗自己。
     * ============================================================ */
    section('本轮 · AI 提示词按钮');
    {
      const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
      const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
      const aix = fs.readFileSync(path.join(ROOT, 'src', 'ai.js'), 'utf8');
      const srvjs3 = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');

      // 2026-09-30 用户要求：顶栏只留一个「⚙ 设置」图标（放在「话术编排台」右边），
      // 点开一扇独立窗口「全局设置」，把 AI 设置 / AI 提示词 / 模拟新消息 三块搬进去。
      check('顶栏有「⚙ 设置」图标按钮（AI 设置 / AI 提示词 / 模拟新消息 的入口）', html.includes('id="btn-settings"'));
      check('「⚙ 设置」在「话术编排台」右边（用户截图红箭头的位置）',
        html.indexOf('id="btn-board"') < html.indexOf('id="btn-settings"'));
      check('主窗口上不再有这三个按钮和它们的弹窗（整块搬进「全局设置」窗口了，不是复制一份）',
        ['btn-prompts', 'btn-ai', 'btn-sim', 'pr-modal', 'ai-modal', 'sim-panel']
          .every((k) => !html.includes(`id="${k}"`)));
      check('「⚙ 设置」绑到打开独立窗口（beeSettings + 浏览器兜底 window.open）',
        appjs.includes("$('btn-settings').onclick") && appjs.includes('beeSettings'));
      check('手动录入里有红字说明「这个添加别的平台的客户用来锁客，客户信息录入数据库」',
        html.includes('ig-note-red') && html.includes('用来锁客，客户信息录入数据库'));
      check('红字说明在「粘贴对话」标签下面、说明文字上面（截图红框位置）',
        html.indexOf('ig-note-red') > html.indexOf('粘贴对话')
        && html.indexOf('ig-note-red') < html.indexOf('ig-desc'));

      // 2026-09-30 顶栏布局（用户配图）：删掉「待处理 N」+ 数字说明；按钮组靠右、LOGO 靠左
      check('顶栏【不再】有「待处理 N」和那句红/绿数字说明',
        !html.includes('id="pending"') && !html.includes('id="pending-tip"')
        && !/数字：红=新消息/.test(html));
      check('顶栏多了一个「右端一组」容器 .head-right（靠右靠的是它 margin-left:auto）',
        /class="head-right"/.test(html) && /\.head-right\s*\{[^}]*margin-left:\s*auto/.test(css));
      check('「＋手动录入 / 话术编排台 / ⚙设置」都在 .head-right 里',
        (() => {
          const blk = html.slice(html.indexOf('class="head-right"'), html.indexOf('</div>', html.indexOf('class="head-right"')));
          return ['btn-ingest', 'btn-board', 'btn-settings'].every((k) => blk.includes(`id="${k}"`));
        })());
      check('顶栏里的社交 LOGO 改靠左：DOM 上排在「＋手动录入」之前（品牌名右边）',
        html.indexOf('brand-logos') < html.indexOf('id="btn-ingest"'));
      check('AI 状态灯也在靠右那一组里（跟着按钮一起靠右）',
        html.indexOf('class="head-right"') < html.indexOf('id="status"'));
      check('前端不再去操作已删掉的 #pending（否则一刷新就整脚本报错）',
        !appjs.includes("$('pending')") && !appjs.includes("'pending-tip'"));

      // 「全局设置」那扇窗：页面 + 逻辑 + 主进程开窗 + 通道
      const setHtml = fs.readFileSync(path.join(ROOT, 'public', 'settings.html'), 'utf8');
      const setJs = fs.readFileSync(path.join(ROOT, 'public', 'settings.js'), 'utf8');
      const mainjs = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
      const prejs = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
      check('「全局设置」页面标题就是「全局设置」', /<title>全局设置<\/title>/.test(setHtml));
      check('窗口三个页签：AI 设置 / AI 提示词 / 模拟新消息',
        ['ai', 'prompts', 'sim'].every((k) => setHtml.includes(`data-tab="${k}"`)));
      check('三块界面都在这扇窗里',
        setHtml.includes('id="ai-body"') && setHtml.includes('id="pr-side"')
        && setHtml.includes('id="pr-main"') && setHtml.includes('id="sim-panel"'));
      check('搬过来的功能一个不少（保存配置 / 取提示词 / 造模拟消息 / 清空）',
        setJs.includes('async function saveAiConfig') && setJs.includes('async function loadPrompts')
        && setJs.includes('async function sendSimulated') && setJs.includes('async function clearSimulatedData'));
      check('主进程开窗：窗口标题「全局设置」+ settings:open 通道',
        mainjs.includes("title: '全局设置'") && mainjs.includes("ipcMain.handle('settings:open'"));
      check('渲染进程通过 preload 的 beeSettings 让主进程开窗',
        prejs.includes("'beeSettings'") && prejs.includes("'settings:open'"));
      check('两扇窗是两个渲染进程 → 存完 AI 配置 / 清空模拟数据由后端广播，主窗口自己刷新',
        srvjs3.includes("broadcast('data_changed'") && appjs.includes("addEventListener('data_changed'"));
      check('改了设置窗口的界面，顶栏那行版本号也会变（buildStamp 把 settings.* 算进去）',
        srvjs3.includes("'settings.html'") && srvjs3.includes("'settings.js'"));

      // 后端接口 + 前端取数
      check('后端提供 GET /api/ai/prompts', srvjs3.includes("'/api/ai/prompts'"));
      check('接口把知识库正文和教练块也拼进去（看到的就是真发的那一份）',
        srvjs3.includes('knowledge.buildBlocks') && srvjs3.includes('coach.buildCoachBlock'));
      check('前端从 /api/ai/prompts 取数（提示词页签现在在「全局设置」窗口里）',
        setJs.includes("fetch('/api/ai/prompts')") && !appjs.includes("fetch('/api/ai/prompts')"));

      // 「只有一份提示词」：任务里不能再内联自己那套字符串，必须走 prompt* 函数
      //   v2.6.1121：translate 多传了一个「气泡翻译模型」的服务商参数，
      //   所以这里按「调用形状」判，不再钉死整串字面量。
      check('每个任务都走共享的 prompt* 函数（提示词只有一份）',
        /complete\('translate',\s*promptTranslate\(text[,)]/.test(aix)
        && aix.includes("complete('suggest', promptSuggest(payload))")
        && aix.includes("complete('extract', promptExtractProfile(conversationText, existing))")
        && aix.includes("complete('translate', promptDecideTranslate(text))"));
      // v2.6.1121 新契约：气泡翻译模型 = 按服务商覆盖，选中那家没配好就安静回退
      check('气泡翻译模型：按服务商覆盖，没配好安静回退（不抛错、不报红）',
        aix.includes('function resolveTaskWithProvider')
        && aix.includes('resolveTaskWithProvider(taskName, providerKey)')
        && aix.includes('if (!p || !p.apiKey || !p.baseUrl) return base;'));
      check('翻译那段提示词全文只有一份（不在任务里再抄一遍）',
        (aix.match(/你是翻译器。把客户的英文消息译成自然的中文口语。/g) || []).length === 1);
      check('语种兜底那段提示词也只有一份',
        (aix.match(/你只做一件事：判断这条客户消息要不要译成中文。/g) || []).length === 1);
      check('【① 接收信息 = 采集，不判断语种】语种判断挂的是 ② translate，不是 receive',
        aix.includes("complete('translate', promptDecideTranslate(text))")
        && !aix.includes("complete('receive',"));
      check('【① 接收信息】在目录里被标成 noAi（不用配 key）',
        /key: 'receive'[^}]*noAi: true/.test(aix));
      check('【① 接收信息】isReady 恒为真（采集环节不顶红灯）',
        /cat && cat\.noAi\) return true/.test(aix));
      check('【中文不翻】语种判断的提示词里明确写了"主要是中文就不用翻"',
        aix.includes('回 no = 主要是中文，中国人一眼看得懂，不用翻。'));
      check('【中文不翻】本地正则规则还在（中文占多就跳过，不花钱调 AI）',
        /return cjk < latin;/.test(require('fs').readFileSync(path.join(__dirname, '..', 'src', 'lang.js'), 'utf8')));

      // 【防复发】token 预算必须够「推理模型」用 —— 2026-09-25 实测踩过的大坑：
      // 混元 hy3 会先写一大段 reasoning_content，那段也算进 max_tokens。预算给小了
      // （原来翻译 512 / 建议 1200），推理就把预算吃光、正文 0 字，接口却照样 HTTP 200，
      // 界面只表现成「没翻出来 / 没有建议」。别再把这些数字调小。
      check('【防复发】ai.js 有统一的 TOKENS 预算表',
        /const TOKENS = \{/.test(aix));
      check('【防复发】各任务的 maxTokens 都走 TOKENS（不再散落魔法数字）',
        /maxTokens: TOKENS\.translate\b/.test(aix)
        && /maxTokens:.*TOKENS\.suggest/.test(aix)
        && /maxTokens: TOKENS\.extract\b/.test(aix)
        && /TOKENS\.vision\b/.test(aix)   // 看图走的是原生 fetch，参数名是 max_tokens
        && /maxTokens: TOKENS\.decide\b/.test(aix)
        && /maxTokens: TOKENS\.reply\b/.test(aix));
      check('【防复发】翻译/建议/抽档案/看图的预算都够推理模型用',
        /translate: 3000/.test(aix) && /suggest: 8192/.test(aix)
        && /extract: 5000/.test(aix) && /vision: 4000/.test(aix) && /decide: 256/.test(aix));
      check('【防复发】模型返回空正文时会报出原因（不再静默当成"没反应"）',
        /模型没给出正文/.test(aix) && /reasoning_content/.test(aix));
      check('【防复发】连接测试必须拿到非空正文才算通（以前只看 HTTP 就报"连通"）',
        /接口通了，但模型没返回任何正文/.test(aix));
      // 混元视觉模型（hy-vision-2.0-instruct）随混元一起删除：
      //   原来这条是「模型名必须写全」，现在守的方向反过来 —— ai.js 里不该再有这个模型名。
      //   （注意只禁完整模型名：`含混元 hy-vision` 这类注释性提法不算。）
      check('【已删除】ai.js 里不再写死混元视觉模型名 hy-vision-2.0-instruct',
        !/hy-vision-2\.0/.test(aix));
      check('④ 翻英文的 system / user 也是共用的',
        aix.includes('promptReplySystem(ctx, count)') && aix.includes('promptReplyUser(text, count)'));
      check('看图那段说明只写一份（IMAGE_HINT_DEFAULT）',
        (aix.match(/这是一位客户发来的照片。用中文说清画面里有什么：/g) || []).length === 1);

      // 真的能产出内容（用真模块跑一遍，样例 + 真知识库正文）
      const aiMod = require('../src/ai');
      check('promptCatalog 可用', typeof aiMod.promptCatalog === 'function');
      if (typeof aiMod.promptCatalog === 'function') {
        const cat = aiMod.promptCatalog({ knowledgeBlocks: '【知识库正文样例】', coachBlock: '【教练块样例】' });
        eq('目录里 6 个条目（5 个 AI + 内部抽档案）', cat.tasks.length, 6);
        const keys = cat.tasks.map((t) => t.key);
        for (const k of ['receive', 'translate', 'suggest', 'translateReply', 'freeTranslate', 'extract']) {
          check(`目录里有 ${k}`, keys.indexOf(k) >= 0);
        }
        const tr = cat.tasks.find((t) => t.key === 'translate');
        check('② 翻译：system 就是真发出去的那句', /你是翻译器/.test(tr.system) && /只输出译文一行/.test(tr.system));
        check('② 翻译：user 是消息原文（样例）', /passed away/.test(tr.user));
        check('每条都写了"什么时候跑"和"代码位置"',
          cat.tasks.every((t) => t.when && t.where));
        check('每条都写了 system 和 user（含①采集环节的占位说明）',
          cat.tasks.filter((t) => ['receive', 'translate', 'suggest', 'translateReply', 'extract'].indexOf(t.key) >= 0)
            .every((t) => t.system && t.user));
        const rep = cat.tasks.find((t) => t.key === 'translateReply');
        check('④ 提示词里灌进了客户信息（地区 / 第几天 → 口吻）',
          /第 2 天/.test(rep.system) && /美式/.test(rep.system), rep.system.slice(0, 80));
        check('④ 不再标「固定 GPT」，改为可选集（DeepSeek / Agnes / 硅基流动 / OpenRouter / TikHub）',
          !rep.fixed && Array.isArray(rep.providerChoices)
            && ['deepseek', 'agnes', 'siliconflow', 'openrouter', 'tikhub'].every((k) => rep.providerChoices.includes(k)),
          rep.providerChoices);
        const sug = cat.tasks.find((t) => t.key === 'suggest');
        check('③ 建议：知识库正文出现在 system 里', /【知识库正文样例】/.test(sug.system));
        check('③ 建议：教练块出现在 system 里', /【教练块样例】/.test(sug.system));
        check('③ 建议：拆出了"两大块"给界面单独看',
          Array.isArray(sug.parts) && sug.parts.length === 2);
        // 🔴 老板已把 ⑤ 看图 / ⑥ 听语音 / ⑦ 看视频 三个 AI 任务整块删除。
        //    原来这里断言「⑦ 视频老实标着『接口已留、暂未接』」，现在连条目都不该存在 ——
        //    改成反向断言：哪天 vision / asr / video 又冒出来，这条立刻红。
        //    （旧写法 cat.tasks.find(...).wired 会因 find 返回 undefined 直接把整套测试崩掉。）
        const goneKeys = ['vision', 'asr', 'video'].filter((k) => keys.indexOf(k) >= 0);
        check('【已删除】目录里不再有 看图 vision / 听语音 asr / 看视频 video',
          goneKeys.length === 0, goneKeys.join('、') || '无');

        // 【① 接收信息是采集环节】—— 用户点名的语义：抓消息，不看语种
        const rec = cat.tasks.find((t) => t.key === 'receive');
        check('① 接收信息在人设上是「抓 WhatsApp 新消息入库」',
          /抓取客户发来的新消息/.test(rec.use) && /写进本地库/.test(rec.use), rec.use.slice(0, 60));
        check('① 接收信息明说「不判断语种 / 不调用 AI」',
          /不调用 AI/.test(rec.use) && /也不判断语种/.test(rec.use));
        check('① 接收信息不再挂着 yes/no 语种判断的提示词',
          !/yes/.test(String(rec.system)) && !/yes/.test(String(rec.output)));
        check('① 接收信息标了 noAi（界面显示「不需要 AI」而不是「未配置」）', rec.noAi === true);
        check('② 翻译顺带管「要不要翻」，并把那段兜底提示词挂在自己身上',
          Array.isArray(tr.parts) && tr.parts.some((p) => /要不要翻|语种兜底/.test(p.label))
          && /要不要译成中文/.test(tr.parts[0].text));
        check('② 翻译的注意点里写明「中文直接跳过不翻」',
          Array.isArray(tr.notes) && tr.notes.some((n) => /本来就是中文|直接跳过不翻/.test(n)));
        eq('① 接收信息在界面上不显示服务商/模型（没有 AI 可显示）', rec.providerCn, '不需要 AI');
      }

      // 弹窗长什么样 —— 2026-09-30 起这三块界面搬到「全局设置」独立窗口，断言跟着挪过去
      const sHtml = fs.readFileSync(path.join(ROOT, 'public', 'settings.html'), 'utf8');
      const sJs = fs.readFileSync(path.join(ROOT, 'public', 'settings.js'), 'utf8');
      check('提示词面板左边是任务清单、右边是内容（在全局设置窗口里）',
        sHtml.includes('id="pr-side"') && sHtml.includes('id="pr-main"'));
      check('提示词面板里有复制按钮（想拿去调的时候直接拷）',
        sJs.includes('data-pr-copy') && css.includes('.pr-copy'));
      // （左栏现在用 prSideEl 这个变量，不能再按 app.js 时代的行号顺序去比）
      const prClick = sJs.slice(sJs.indexOf('prSideEl.addEventListener'));
      check('点另一个任务，左边高亮跟着换（先切内容 renderPrMain，再重画高亮 renderPrSide）',
        prClick.indexOf('renderPrMain(b.dataset.pr)') > 0
        && prClick.indexOf('renderPrMain(b.dataset.pr)') < prClick.indexOf('renderPrSide();'));
      check('提示词用等宽字体展示（好读、好对照）', css.includes('.pr-pre'));
    }

    /* ============================================================
     *  本轮 · 翻译提速（批量合并 / 长消息切片 / 单请求超时 / 失败可重试）
     * ============================================================ */
    section('本轮 · 翻译提速');
    {
      const aijs = fs.readFileSync(path.join(ROOT, 'src', 'ai.js'), 'utf8');
      const trjs = fs.readFileSync(path.join(ROOT, 'src', 'translator.js'), 'utf8');
      const dbjs = fs.readFileSync(path.join(ROOT, 'src', 'db.js'), 'utf8');
      check('ai.js 有批量翻译 translateBatch + 对应提示词',
        /async function translateBatch/.test(aijs) && /function promptTranslateBatch/.test(aijs));
      check('ai.js 给每个请求都加了超时（AbortController + 超时即抛错），杜绝"永远翻译中"',
        /new AbortController\(\)/.test(aijs) && /AbortError/.test(aijs) && /请求超时/.test(aijs));
      check('translator.js 设了并发上限 / 批大小 / 切片阈值（不再逐条裸发）',
        /CONCURRENCY\s*=/.test(trjs) && /BATCH_MAX\s*=/.test(trjs) && /CHUNK_LIMIT\s*=/.test(trjs));
      check('translator.js 多条同客户消息走 translateBatch（合并成一次请求）',
        /ai\.translateBatch\(/.test(trjs));
      check('translator.js 长消息走 splitChunks 切片并行翻',
        /function splitChunks/.test(trjs) && /splitChunks\(/.test(trjs));
      check('translator.js 失败重试一次后仍不行就标 failed（不再假装还在翻译中）',
        /setTranslateState\.run\('failed'/.test(trjs));
      check('db.js 给 messages 加了 translate_state 列 + 写入语句 + 迁移',
        /translate_state/.test(dbjs) && /setTranslateState/.test(dbjs) && /ensureColumn\('messages'/.test(dbjs));

      /* v2.6.1122 新契约：翻译管线先查跨消息记忆（同一句原文第二次出现 → 0 次 AI 调用）。
       * 三条路都要接上：单条（translateOne，长消息也走它）+ 批量（runUnit 的 batch 分支）。 */
      check('翻译先查跨消息记忆：命中直接复用、不调 AI',
        trjs.includes("require('./translationMemory')")
        && /async function translateOne[\s\S]{0,800}translationMemory\.lookup/.test(trjs));
      check('翻完写回记忆（单条 + 批量两条路都写了）',
        /async function translateOne[\s\S]{0,1600}translationMemory\.record/.test(trjs)
        && /need\.forEach[\s\S]{0,400}translationMemory\.record/.test(trjs));
      check('批量里已记住的那几条不进 AI 请求（先分流再发）',
        /const fromMem = new Map\(\)/.test(trjs) && /const need = \[\]/.test(trjs)
        && /ai\.translateBatch\(need\.map/.test(trjs));
    }

    /* ============================================================
     *  本轮 · 左栏「今日消息」提示窗 + 客户档案改弹窗 + 圈数字对应关系
     *  2026-09-30 用户配图：提示窗只留 ① ② ③ ④ ⑤ 各几条，
     *  「收到 / 已处理 / 待处理」三格与「①主号…⑤五号」图例都删掉。
     * ============================================================ */
    section('本轮 · 今日消息窗 + 客户档案弹窗');
    {
      const html3 = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      const appjs3 = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
      const css3 = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
      const dbjs3 = fs.readFileSync(path.join(ROOT, 'src', 'db.js'), 'utf8');
      const srvjs3 = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');

      check('左栏顶部有「今日消息」提示窗（在 #list 里、客户列表 #list-body 之前）',
        html3.indexOf('id="today-box"') > html3.indexOf('id="list"')
        && html3.indexOf('id="today-box"') < html3.indexOf('id="list-body"'));
      check('提示窗【不再】有 收到 / 已处理 / 待处理 三个数字格（2026-09-30 用户配图删掉）',
        !/id="tb-in"/.test(html3) && !/id="tb-done"/.test(html3) && !/id="tb-todo"/.test(html3));
      check('提示窗【不再】有「①主号 … ⑤五号」那行图例（同上）',
        !/class="tb-tip"/.test(html3));          // 查元素，不查文本 —— 注释里提到旧标签是允许的
      check('提示窗保留 ① ② ③ ④ ⑤ 各几条那一行（#tb-acct）', /id="tb-acct"/.test(html3));
      check('圈数字映射就是 account_id：1→① … 5→⑤',
        /ACCT_CIRCLED = \{ 1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤' \}/.test(appjs3));
      check('db.js 有 statsToday（只算今天 + 按账号拆）',
        /function statsToday/.test(dbjs3) && /date\(msg_ts,'localtime'\)/.test(dbjs3) && /byAccount/.test(dbjs3));
      check('server.js 暴露 GET /api/stats/today', srvjs3.includes("p === '/api/stats/today'"));
      check('app.js 来消息就刷今日消息（启动 + new_message + pending 都接上）',
        (appjs3.match(/refreshToday\(\)/g) || []).length >= 3);

      // 右栏那一段（#panel 到 #pf-modal 之间）里不该再出现 #profile —— 档案已经搬进弹窗
      const panelSeg = html3.slice(html3.indexOf('id="panel"'), html3.indexOf('id="pf-modal"'));
      check('「客户档案」已从右栏搬成弹窗（右栏那一段里不再有 #profile）',
        panelSeg.length > 0 && !/id="profile"/.test(panelSeg) && html3.includes('id="pf-modal"'));
      check('左栏客户行里没有「档案」按钮了（app.js 不再有 .doc-col / .row-doc / .row-extract）',
        !appjs3.includes('class="doc-col"') && !appjs3.includes('row-doc') && !appjs3.includes('row-extract'));
      check('「客户档案 / 对话提档」两个按钮在档案卡里（app.js #ch-doc + #ch-extract）',
        appjs3.includes('id="ch-doc"') && appjs3.includes('id="ch-extract"'));
      // 🔴 v2.6.1118：三个按钮从「中栏头部最右端横排」改成「档案卡底部右端」（老板选的位置），
      //   旧断言锁的 .ch-doc-col margin-left:auto / flex-direction:row 已随之作废。
      check('三个按钮在档案卡底部（.tv-actions，跟 Tele 同一个位置）',
        appjs3.includes('class="tv-actions"') && appjs3.includes('id="ch-jump"'));
      check('按钮栏右对齐（css #chat-head .ch-card .tv-actions justify-content: flex-end）',
        /#chat-head \.ch-card \.tv-actions \{[\s\S]*?justify-content: flex-end/.test(css3));
      check('「跳到聊天」是实心蓝主按钮、另两个是浅蓝描边（.tv-btn-primary / .tv-btn-blue）',
        /\.tv-btn-primary \{[^}]*background: #2f6fe0/.test(css3) && /\.tv-btn-blue \{[^}]*border-color: #cbdcfb/.test(css3));
      check('按钮文案已改成「对话提档」（四处实体按钮）',
        (appjs3.match(/>对话提档<\/button>/g) || []).length >= 1
        && (html3.match(/>对话提档<\/button>/g) || []).length === 3);
      check('按钮显示状态恢复时也用新文案「对话提档」（不会变回旧长文案）',
        appjs3.includes("b.dataset.old || '对话提档'"));
      check('行里那个按钮的文字就是「客户档案」',
        appjs3.includes('>客户档案</button>'));
      check('「保存档案」抬到弹窗最上面（.pf-topbar 里，排在 #profile 之前）',
        /pf-topbar[\s\S]{0,400}?id="pf-save"[\s\S]{0,400}?id="profile"/.test(html3));
      // 2026-09-29 用户提的三件事：路径改按钮、旁边红字提示、档案弹窗要有「WA对话编号」
      check('档案弹窗标题里不再塞长路径，改成「文件路径」按钮（点开才弹）',
        html3.includes('id="pf-path"') && html3.includes('id="pf-path-pop"')
        && html3.includes('>文件路径</button>') && !/\$\{base\}\s+（文件：/.test(appjs3)
        && appjs3.includes('function toggleProfilePath'));
      check('「保存档案」右边的提醒是红字（css .pf-tip-red 用 var(--red)）',
        /\.pf-topbar \.pf-tip-red \{[\s\S]*?color: var\(--red\)/.test(css3)
        && html3.includes('电话和姓名需要手动添加'));
      check('档案弹窗新增只读「WA对话编号」（显示 wa_jid，只读不参与保存）',
        appjs3.includes('WA对话编号') && appjs3.includes('id="pf-wa-id"')
        && /id="pf-wa-id"[^>]*readonly/.test(appjs3)
        && !/extraMap[\s\S]{0,400}pf-wa-id/.test(appjs3));
      check('「从对话里提取档案」已搬出弹窗（弹窗里不再有 #btn-extract）',
        !html3.includes('id="btn-extract"') && !appjs3.includes("$('btn-extract')"));
      check('档案条末尾那个重复的「客户档案 ↗」已删（app.js/css 里都不再有 ch-open-profile / fact-open）',
        !appjs3.includes('ch-open-profile') && !css3.includes('fact-open'));
      check('点头部「客户档案」只开弹窗、不切换左边的对话',
        /docBtn\.onclick = \(\) => openProfileModal\(c\.code\)/.test(appjs3));
      check('档案弹窗有独立的 profileCode（可以和正在看的对话不是同一个人）',
        /profileCode: null/.test(appjs3) && /state\.profileCode = target/.test(appjs3));
      check('今日消息窗的数据源是 /api/stats/today（不是前端自己算的）',
        appjs3.includes("api('/api/stats/today')") && /setInterval\(refreshToday, 60000\)/.test(appjs3));

      /* ---- 2026-09-30 本轮：档案 md 不写 Day；档案弹窗「阶段」只读同步；编排台按 Day 分页 ---- */
      const docjs = fs.readFileSync(path.join(ROOT, 'src', 'customerDoc.js'), 'utf8');
      const bhtml = fs.readFileSync(path.join(ROOT, 'public', 'board.html'), 'utf8');
      const bjs = fs.readFileSync(path.join(ROOT, 'public', 'board.js'), 'utf8');
      const sbjs = fs.readFileSync(path.join(ROOT, 'src', 'scriptBoard.js'), 'utf8');
      check('档案 md 不再写「当前阶段 / Day N」',
        !docjs.includes('| 当前阶段 |') && !/\|\s*Day \$\{/.test(docjs));
      check('档案 md 不再写「认识第 N 天」',
        !docjs.includes('认识第 ${'));
      check('档案弹窗「阶段(Day)」改成只读展示（pf-stage-auto），不再是可填输入框、也不再提交 stage_day',
        appjs3.includes('pf-stage-auto') && !/id="pf-stage"\s+type="number"/.test(appjs3)
        && !/stage_day: Number\(\$\('pf-stage'\)/.test(appjs3));
      check('css 有 .pf-stage-auto 只读样式', /\.pf-stage-auto\s*\{/.test(css3));
      check('编排台碎片带 Day 字段、并做了老数据迁移（scriptBoard normalizeDays）',
        /function normalizeDays/.test(sbjs) && /normalizeDays\(board\)/.test(sbjs));
      check('编排台右栏表头有「上一页 / 下一页」翻 Day（board.html 与 index.html 内嵌面板都要有）',
        bhtml.includes('id="board-prev"') && bhtml.includes('id="board-next"')
        && bhtml.includes('id="board-page"') && bhtml.includes('>下一页</button>')
        && html3.includes('id="board-prev"') && html3.includes('id="board-next"')
        && html3.includes('id="board-page"'));
      check('编排台按 Day 分页：默认打开「还没全部发完」的第一天（board.js defaultViewDay）',
        /function defaultViewDay/.test(bjs) && /function fragsOfDay/.test(bjs)
        && /fragsOfDay\(state\.viewDay\)/.test(bjs));

      /* ---- 2026-09-30 第二轮：档案弹窗「时区」改成填数字 + 手填时差优先 ---- */
      const svjs = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
      check('档案弹窗「时区」是 60px 的**数字**输入框（不是原来的时区名文本框）',
        /id="pf-tz"[^>]*type="number"/.test(appjs3) && /class="pf-tz-num"/.test(appjs3)
        && /\.pf-tzfield input\.pf-tz-num\s*\{[^}]*width:\s*60px/.test(css3));
      check('「时区」框右边是「填写说明」按钮，点开弹出时差说明（比北京晚填负数 / 快填正数）',
        appjs3.includes('id="pf-tz-help"') && appjs3.includes('填写说明')
        && appjs3.includes('id="pf-tz-pop"') && appjs3.includes('function toggleTzHelp')
        && appjs3.includes('填负数') && appjs3.includes('填正数'));
      check('「时区」留空 = 按地区自动（数字框留空、说明行实时跟着改）',
        /function refreshTzHint/.test(appjs3) && /state\.profileAutoTz/.test(appjs3)
        && /留空 = 按「地区」自动/.test(appjs3));
      check('档案弹窗「阶段(Day)」那格只剩 Day + 数字（底下的解释小字已去掉）',
        !/pf-stage-auto"[^>]*>Day \$\{days \|\| 0\}<\/span>\s*<span class="joined-sub">按/.test(appjs3));
      check('后端口径：时区栏填了数字 → 数字优先；清空 → 回到按地区自动',
        /doc\.isTzOffset/.test(svjs) && /if \(bodyOffset\)/.test(svjs)
        && /timezone = bodyTzRaw;\s*\/\/ ① 手填数字优先/.test(svjs));
      check('AI 抽档案不会覆盖客户手填的时差数字',
        /const handTz = doc\.isTzOffset/.test(svjs));
      check('档案 md：手填时差也要说人话（与北京的小时差 / 当地 UTC）',
        /function tzManualHours/.test(docjs) && /function diffFromOffsetHours/.test(docjs)
        && /manualHours != null \? diffFromOffsetHours/.test(docjs));
      check('客户详情接口回传按地区推出来的时区（autoTimezone），界面据此报"按地区算是几小时"',
        /autoTimezone:/.test(svjs));
    }

    /* ============================================================
     *  内核启动自检（另起进程）：只 listen 一次 + 端口被占能自己让路
     * ============================================================ */
    spawnSubtest('预热闸门 · 登录前零动作 + 扫描节奏（611 秒 / 前3后1静默）', 'prewarm.test.js');

    spawnSubtest('内核 · 启动与端口', 'kernel_port.test.js');

    /* ============================================================
     *  桌面入口自检（另起进程 + Electron 桩）：必须真的走到"开窗口"
     * ============================================================ */
    spawnSubtest('桌面 · 入口能开出窗口', 'desktop_entry.test.js');

    /* ============================================================
     *  界面真实渲染自检（另起一个进程，用真浏览器把页面渲染出来量尺寸）
     *  光看源码看不出「主界面被弹窗糊住」这种问题，必须真渲染一遍。
     * ============================================================ */
    spawnSubtest('界面 · 真实渲染自检', 'ui_render.test.js');

    /* ============================================================
     *  WA① 浏览器身份（UA）：🔴 2026-10-13 真机事故回归 ——
     *  WA① 内置 webview 弹「更新 Google Chrome」页。根因不是内核旧，
     *  是 Electron 默认 UA 带 Electron 令牌、且**渲染进程事后 setAttribute 对已建 guest 无效**。
     *  正解是主进程对 persist:wa6 分区 setUserAgent，且必须抢在开窗口之前。
     *  这条之前不在套件里，所以白改了一版；本版接进来，防止再退回旧写法。
     * ============================================================ */
    spawnSubtest('界面 · WA① 浏览器身份（UA 钉在主进程，须早于开窗口）', 'web_identity.test.js');

    /* ============================================================
     *  AI 设置（配置界面）：读 / 按行改写保存(不丢注释) / 掩码 / 连接测试
     *  这是用户第 3 点需求（界面上填 API Key）的后端落点，必须单独跑一遍。
     * ============================================================ */
    spawnSubtest('AI 设置 · 配置界面后端', 'ai_config.test.js');

    /* ============================================================
     *  软件更新（检查 / 安装）：🔴 2026-10-11 真机事故回归 ——
     *  electron-builder 打包会把 package.json 的 build 段**整段剥掉**，
     *  于是 pkg.build.publish 永远 undefined → check() 第一道关就 return、
     *  **根本不调 autoUpdater.checkForUpdates()** → 点「检查更新」永远没反应。
     *  必须回退读 resources/app-update.yml。这条之前不在套件里，
     *  所以这个 bug 一路漏到真机；本版把它接进来，防止再漏。
     * ============================================================ */
    spawnSubtest('软件更新 · 检查/安装/更新源回退（build 被剥掉也能更新）', 'v120_update.test.js');
    spawnSubtest('软件更新 · 轮询卡死回归（同版本立刻显示已是最新，不再一直检查）', 'v121_update_poll.test.js');

    /* ============================================================
     *  翻译链路自检（另起进程）：先推消息、后台翻译、翻完推 translated
     *  这是"点开消息能看到译文 / 没好就显示等待翻译中"的根，
     *  AI 在测试里打桩成"慢 2 秒"，验证界面真的不会被拖住。
     * ============================================================ */
    /* ---- 翻译去重（2026-09-30 用户要求）：源码层面锁住"不反复烧 token" ---- */
    {
      const trjs = fs.readFileSync(path.join(ROOT, 'src', 'translator.js'), 'utf8');
      const mdjs = fs.readFileSync(path.join(ROOT, 'src', 'media.js'), 'utf8');
      const dbjsX = fs.readFileSync(path.join(ROOT, 'src', 'db.js'), 'utf8');
      const appjsX = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
      const srvjsX = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
      const cssX = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
      check('重试次数写进数据库（不是内存，重启不归零）',
        /ensureColumn\('messages', 'translate_tries'/.test(dbjsX) && /bumpTranslateTry/.test(dbjsX));
      check('看图也有次数账本（视觉模型最贵，必须有上限）',
        /ensureColumn\('messages', 'media_tries'/.test(dbjsX) && /bumpMediaTry/.test(dbjsX));
      check('翻译有自动重试上限 + 总闸门 autoAllowed',
        /MAX_AUTO_TRIES\s*=/.test(trjs) && /function autoAllowed/.test(trjs) && /!autoAllowed\(id\)/.test(trjs));
      check('AI 判定不用翻的记 skipped（不再当失败反复问）',
        /setTranslateState\.run\('skipped'/.test(trjs) && /opt\.skip/.test(trjs));
      check('补翻/untranslated 统计都排除 skipped 与已封顶的 failed',
        /autoAllowed\(m\.id\)/.test(trjs) && /translate_state !== 'skipped'/.test(trjs));
      check('看图补翻也带总闸门', /autoAllowed\(m\.id\)/.test(mdjs));
      check('断了「翻完→重画→再补翻」的回环（重画不补翻）',
        /opt\.noBackfill/.test(appjsX) && /noBackfill: true/.test(appjsX));
      check('补翻加了 30 秒节流（同一个客户不反复排）',
        /backfillAt\[code\]/.test(appjsX) && /30000/.test(appjsX));
      check('有手动重翻接口（封顶后唯一的重来入口）',
        srvjsX.includes('api\\/message\\/(\\d+)\\/translate') && /retryManual/.test(srvjsX));
      check('气泡上有「点这里重翻」按钮 + 样式',
        /zh-retry/.test(appjsX) && /data-retry-tr/.test(appjsX) && /\.zh-retry/.test(cssX));
    }

    spawnSubtest('翻译 · 先推消息再后台翻', 'translation_flow.test.js');
    spawnSubtest('翻译 · 提速（批量/切片/超时/失败）', 'translator_speed.test.js');
    /* 2026-09-30 用户要求：「上次翻译过的不要再翻译，还要显示上次的中文」。
       这条数的是 AI 真实调用次数，锁住"翻过的不重翻 / 翻不出来的封顶 / 不用翻的记 skipped"。 */
    spawnSubtest('翻译 · 去重（翻过的不重翻、失败封顶）', 'translate_dedup.test.js');

    /* ============================================================
     *  图片 / 语音链路自检（另起进程）：7 个 AI 里的第 ⑤⑥ 个
     *  客户发的图 → AI 用中文说清画面；客户发的语音 → 转文字 → 翻中文。
     *  和翻译一个节奏：消息先上界面，AI 在后台看/听，好了再补上。
     * ============================================================ */
    spawnSubtest('媒体 · 看图与听语音', 'media_flow.test.js');
    spawnSubtest('媒体 · 裸base64 图片抓取（不漏图不误抓）', 'media_fetch.test.js');

    /* ============================================================
     *  每日话术编排台自检（另起进程）：三态时段（早上/晚上/通用）+ 老数据迁移
     *  + 独立浮窗页面 board.html + 发送=预填（绝不自动发）+ 密码删碎片。
     * ============================================================ */
    spawnSubtest('编排台 · 三态时段与独立浮窗', 'board.test.js');

    /* ============================================================
     *  云端（v1.0.1）：编号登录 + 编排台同步 + 电话跨编号查重
     *  源码层面先锁四条铁律，再另起进程真跑一遍 fetch 链路。
     * ============================================================ */
    {
      const cjs = fs.readFileSync(path.join(ROOT, 'src', 'cloud.js'), 'utf8');
      const sbjs = fs.readFileSync(path.join(ROOT, 'src', 'scriptBoard.js'), 'utf8');
      const srvjs = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
      const mnjs = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
      const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
      const shtml = fs.readFileSync(path.join(ROOT, 'public', 'settings.html'), 'utf8');
      const cfgyml = fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8');

      check('有云端客户端模块 src/cloud.js（登录/心跳/同步/查重）',
        /function login\(/.test(cjs) && /function heartbeat\(/.test(cjs)
        && /function syncMaster\(/.test(cjs) && /function checkPhone\(/.test(cjs));
      check('🔴 主数据只读：cloud.js 对 /api/master 只有 GET（没有任何 POST/PUT/DELETE）',
        /request\('GET', '\/api\/master'\)/.test(cjs)
        && !/request\('(POST|PUT|DELETE)', '\/api\/master/.test(cjs));
      check('🔴 后台数据不会被软件改：所有写操作都打在自己编号的仓库 /api/board/:code 上',
        /`\/api\/board\/\$\{encodeURIComponent\(customerCode\)\}\/fragment`/.test(cjs)
        && /'\/api\/phone\/register'/.test(cjs));
      check('登录互斥：编号被占用时把 busy 标记带回来（界面能提示被谁占着）',
        /err\.busy = !!j\.busy/.test(cjs));
      check('心跳 401（被管理员踢下线）→ 清令牌并广播 kicked',
        /e\.status === 401/.test(cjs) && /emit\('kicked'/.test(cjs));
      check('编排台云端优先、离线退回本地（cloudReady + getBoardAsync）',
        /function cloudReady\(\)/.test(sbjs) && /async function getBoardAsync\(/.test(sbjs)
        && /return local;/.test(sbjs));
      check('🔴 电话跨编号查重：保存档案前先问云端，重复号返回 409 + 归属编号',
        /phoneConflict/.test(srvjs) && /已经被 \$\{o\.code\} 的用户添加了/.test(srvjs)
        && /cloud\.checkPhone\(/.test(srvjs));
      check('查重命中时前端弹窗确认，确认后才带 force 强写',
        /r\.phoneConflict/.test(appjs) && /body\.force = 1/.test(appjs));
      check('启动时自动接云端（boot 被 try/catch 包住，云挂了也不挡启动）',
        /cloud\.boot\(\)/.test(mnjs) && /cloud\.onEvent\(/.test(mnjs));
      check('设置窗口有「☁ 云端」页签（填地址/编号/密码）',
        /data-tab="cloud"/.test(shtml) && /sec-cloud/.test(shtml)
        && /^cloud:/m.test(cfgyml) && /baseUrl:/.test(cfgyml));
      const idxhtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      const cssjs = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
      check('配了云端但没登录 → 主窗口有提示条（🔴 是提示条不是弹窗，不遮挡工作区）',
        /id="cloud-bar"/.test(idxhtml) && /cb-login/.test(idxhtml)
        && /function refreshCloudBar/.test(appjs) && /\.cloud-bar/.test(cssjs));
      check('没配云端地址 / 已登录 → 提示条隐藏（纯单机用看不见它）',
        /!s\.configured \|\| s\.loggedIn/.test(appjs) && /bar\.classList\.add\('hidden'\)/.test(appjs));
      // ⚠️ 这里的 openSettingsWindow 在 electron/main.js（不是 src/main.js）
      const emjs = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
      const pljs = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
      check('提示条「点这里登录」直达设置窗的云端页签（open(tab) 通道）',
        /beeSettings\.open\('cloud'\)/.test(appjs)
        && /ipcMain\.handle\('settings:open', \(_e, tab\)/.test(emjs)
        && /function openSettingsWindow\(tab\)/.test(emjs)
        && /open: \(tab\) => ipcRenderer\.invoke\('settings:open', tab \|\| ''\)/.test(pljs));
      check('令牌不写进 config.yaml（走 <数据目录>/cloud/session.json）',
        /const SESSION_FILE = path\.join\(CLOUD_DIR, 'session\.json'\)/.test(cjs)
        && !/token/.test(String(cfgyml.match(/^cloud:[\s\S]*?(?=\n\S)/m) || '')));
    }
    spawnSubtest('云端 · 编号登录 / 编排台同步 / 电话查重', 'cloud.test.js');

    /* ============================================================
     *  发送链路自检（另起进程）：① 编排台点「发送」= 按号码预填 / 兜底塞进最前面的
     *  WhatsApp 对话，两条路都绝不按回车；② 我在网页版发出的消息要进主窗口中间栏目
     *  （没选中那个客户时中间栏目跟过去）。
     * ============================================================ */
    spawnSubtest('发送 · 预填与"我发出的消息"进中栏', 'send_flow.test.js');

    /* ============================================================
     *  采集链路自检（另起进程）：① 客户身份抓取 —— 名字走 Contact（wwjs 1.34 的
     *  Message 上已经没有 notifyName）、电话只认 @c.us（@lid 是隐私 ID 不是号码）；
     *  ② 空消息（撤回/加密提示/通话记录/表情回应）不入库、不显示。
     * ============================================================ */
    spawnSubtest('采集 · 客户身份与空消息', 'identity.test.js');

    /* ============================================================
     *  采集 · 重抓回归（另起进程）：
     *  2026-10-07 修「修改后无法获取信息」时加的。
     *  当时真实故障是 handleMessage() 里写了 `opt.client`，可形参叫 `opts`
     *  → 老客户每条消息都抛 ReferenceError，被 onMessage 的 catch 吞掉，
     *    消息不入库、不广播，界面上什么都看不到。而 node --check 查不出来
     *    （语法合法，只是运行时变量不存在），单测也漏了 —— 所以这里专门钉死。
     *  同时钉住：base64 图片正文必须是 [图片]、号码冲突不得改写 phone_src、
     *            人工号(manual)永不被覆盖。
     * ============================================================ */
    spawnSubtest('采集 · 重抓回归与号码对比', 'regrab_regress.test.js');

    /* ============================================================
     *  采集 ·「📞 抓取」全量候选扫描（另起进程）：
     *  2026-10-07 加的顶栏按钮。红线有三条，测试就是盯着这三条：
     *   ① 一个候选都不许静默丢（连邮编、日期、LID 都必须列出来，只标"不像"）；
     *   ② 判定宁宽勿缺 —— 跟自动入库那套"只要一个就够"的口径故意相反；
     *   ③ 只读：跑完消息条数必须不变。
     * ============================================================ */
    spawnSubtest('采集 ·「📞 抓取」全量候选扫描', 'phone_scan.test.js');

    /* ============================================================
     * 「📞 抓取」= 抓**客户资料**里的电话（v1.0.13）
     *   🔴 第一版方向就错了：扫的是聊天对话正文里的数字，不是客户资料上的号。
     *      这个套件专门钉死"抓资料不是抓正文"：
     *      ① summarize 口径（LID 必须标成不是号码、真号必须标出来、按可信度排序）
     *      ② 真起后端打真接口，且**只读**（档案号码/phone_src/消息条数都不能变）
     * ============================================================ */
    spawnSubtest('采集 ·「📞 抓取」客户资料号码', 'profile_scan.test.js');

    /* ============================================================
     * 「电话号码」自动填充 + 加号判断（v1.0.14）
     *   老板四条：① 空号自动抓 ② 缺加号重抓并补+ ③ 标题栏按钮+指示灯 ④ 绿灯不抓
     *   🔴 本套件钉死两条红线：
     *      · 绿灯状态下抓取次数**不得增加**（老板第④条）
     *      · 认不出国家区号时**绝不瞎加 +**（错号码比没号码危险）
     * ============================================================ */
    spawnSubtest('档案 ·「电话号码」自动填充与加号', 'phone_fill.test.js');

    /* ============================================================
     *  打包自检（另起进程）：exe 运行时数据必须落在「用户可写目录」而不是只读的
     *  程序目录；首次运行要把 config.yaml / 知识库铺过去且不覆盖用户改过的；
     *  Chromium 找不到时要能回落到本机 Chrome / Edge。
     * ============================================================ */
    spawnSubtest('打包 · exe 数据落点与首次运行', 'packaging.test.js');

    /* ============================================================
     *  Telegram 内置浏览器读取（v2.5.1056）：
     *  老板问「登录在内核版浏览器里，能不能获取信息」。真机登录要老板手机收码，代劳不了，
     *  所以这里用仿 Telegram K 版 DOM 把扫描脚本真跑一遍，钉死「读不读得出对话 ID / 名字 /
     *  最后一条 / 未读数 / 气泡方向」。真机上万一读不到，至少能确认不是这段脚本的问题。
     * ============================================================ */
    spawnSubtest('采集 · Telegram 内置浏览器读取（Tele①）', 'telegram_webview.test.js');

    /* ============================================================
     *  Telegram 专项（v2.6.1136 · 老板出图报的 4 个问题）：
     *  Saved Messages 不该提醒/建档、同一个人裂成两条要合并（存量迁移先备份·幂等·只限 tg）、
     *  正文尾部时间要剥出来（时间只渲染一次 + 时间方框）、译文气泡里不带时间。
     *  全程只写 .tmp-test-data 的临时库，不碰真实客户数据。
     * ============================================================ */
    spawnSubtest('采集 · Telegram 专项（Saved 过滤 / 同名合并 / 时间方框）', 'telegram_merge.test.js');

    /* ============================================================
     *  代理本地中转（v2.6.1120）：
     *  老板报「全局设置 → 代理 里 WA① 的代理用不了」。根因是 Chromium 内核对代理账密
     *  从根上不支持（proxyRules 不认 user:pass@，账密被静默丢弃），且 gost 先起监听再连上游
     *  （选错协议时端口照样通、流量全超时）。现在一律走本机 gost 无密码中转 + 协议自适应。
     *  本测试全离线（假上游跑在 127.0.0.1），不需要外网。
     * ============================================================ */
    spawnSubtest('代理 · 本地中转（账号 key / 真穿透 / 账密不进浏览器 / 协议自适应）', 'proxy_relay.test.js');

    /* ============================================================
     *  WA① 内置浏览器采集（v2.6.1121）：
     *  老板给图指出「软件内置浏览器里的这个 WhatsApp 也要采」。
     *  webview 没有调试端口，puppeteer 连不进去，只能主进程侧注入脚本，
     *  走内部 Store（WAWebCollections）拿全量 —— 不点开对话，不碰未读红点。
     *  本测试用假 Store + vm 真跑注入脚本，钉死「读得出会话/联系人/消息、
     *  @lid 能还原成真号码、三层挡得住系统行/群/广播、绝不丢消息、绝不写页面」。
     * ============================================================ */
    spawnSubtest('采集 · WA① 内置浏览器采集（只读）', 'whatsapp_read.test.js');

    /* ============================================================
     *  WA① 中文译文气泡（v2.6.1121 老板拍板：「插在对话消息的下方」）
     *  假 DOM + vm 真跑注入脚本，钉死「贴哪 / 幂等 / 撤销 / 50-100 / 只读 /
     *  译文只从库里取（不重新翻）」。含翻译铁律：正常中文不贴气泡。
     * ============================================================ */
    spawnSubtest('采集 · WA① 中文译文气泡（只读）', 'wa_bubble.test.js');

    /* ============================================================
     *  「气泡翻译模型」这一个开关的完整链路（v2.6.1121）
     *  取值优先级 / 老键兼容 / 按服务商覆盖 + 安静回退 / 接口 / 落盘。
     *  单独一份：坏了只查这一块，不跟提取间隔、7 个 AI 目录混在一起。
     * ============================================================ */
    spawnSubtest('AI · 气泡翻译模型（配置链路 · 全渠道）', 'bubble_model.test.js');

    /* ============================================================
     *  跨消息翻译记忆（v2.6.1122 · 老板拍板方案 A）
     *  核心断言：同一句原文第二次出现 → AI 调用次数**不涨**。
     *  另有：归一化 / 超长不入字典 / 开关 / 回填不覆盖 / 批量分流 / 别处不许直接写这张表。
     *  单独一份：坏了只查这一块。
     * ============================================================ */
    spawnSubtest('翻译 · 跨消息翻译记忆（同一句只翻一次）', 'translation_memory.test.js');

    /* ============================================================
     *  汇总
     * ============================================================ */
    console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
    if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); }
  } catch (e) {
    console.error('\n[致命错误] 测试中断：', e);
    fail++;
  } finally {
    // 关掉数据库句柄再删临时目录（Windows 上文件被占用会删不掉）
    try { const d = require('../src/db'); if (d.db && d.db.close) d.db.close(); } catch (e) {}
    // 成功路径上清掉自己这一棵；清不掉会如实告警（cleanTmpData 内部已处理），
    // 不再在这里无脑打印「已清理」—— 之前那句是无条件打印的，删失败也照样说已清理。
    cleanTmpData();
  }
  process.exit(fail ? 1 : 0);
})();
