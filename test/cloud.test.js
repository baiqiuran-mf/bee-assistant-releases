/**
 * 云端客户端自检（蜜蜂信息采集 v1.0.1）
 *
 * 覆盖（对应老板的四条要求在【软件这一侧】的表现）：
 *   ① 主数据只读：软件对云端主数据只有 GET，写操作一个都没有；
 *   ② 登录互斥：编号被占用时客户端能拿到 busy 标记和占用者；
 *   ③ 编号仓库：编排台的增删改走云端仓库接口，不动主数据；
 *   ④ 电话查重：保存档案前会去问云端，重复号返回 409 + 归属编号；
 *   ⑤ 离线兜底：没登录 / 云端挂了 → 编排台自动退回本地，软件照常能用。
 *
 * 跑法：node test/cloud.test.js
 * 数据隔离：.tmp-test-data/cloud.test（不碰真实 data/）
 *
 * 做法：起一个「假云端」HTTP 服务（内存态），把 config.cloud.baseUrl 指过去，
 *       这样能真跑一遍 fetch 链路，不用连真的 Cloudflare。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const { DIR: DATA_DIR, CONFIG } = require('./_isolate.js');

/* ------------------------------ 迷你断言 ------------------------------ */
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + String(extra).slice(0, 240) : ''}`); }
}

/* ------------------------------ 假云端 ------------------------------ */
const CLOUD = {
  calls: [],             // 记录收到的请求（用来证明"只 GET 主数据"）
  sessions: new Map(),   // code → { token, device }
  board: new Map(),      // key = `${op}|${code}` → fragments（模拟编号仓库）
  phones: new Map(),     // phone → [{code, customerCode}]
  masterFrags: [
    { id: 'f1_1', day: 1, name: '开场 · 纯文字轻问候 + 自介绍', morning: false, evening: false,
      dialogues: [{ id: 'd1_1_1', en: 'Hi there!', zh: '你好呀！' }] },
    { id: 'f1_14', day: 1, name: '白天经历（晚）', morning: false, evening: true,
      dialogues: [{ id: 'd1_14_1', en: 'How was your day?', zh: '今天过得怎么样？' }] },
  ],
  adminFragAdd: null,    // 测试里"管理员在后台加碎片"用
};

function makeFakeCloud() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const m = req.method;
    let body = {};
    if (m === 'POST' || m === 'PUT') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { body = {}; }
    }
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    const who = [...CLOUD.sessions.entries()].find(([, v]) => v.token === auth)?.[0] || '';
    CLOUD.calls.push({ m, p, who });

    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (p === '/api/auth/login' && m === 'POST') {
      const { code, device } = body;
      const cur = CLOUD.sessions.get(code);
      if (cur && cur.device !== device) {
        return send(409, { ok: false, busy: true, device: cur.device,
          error: `编号 ${code} 已经在别的电脑上登录了（${cur.device}），请先在那边退出。` });
      }
      const token = 'tk-' + code + '-' + Date.now();
      CLOUD.sessions.set(code, { token, device });
      return send(200, { ok: true, token, operator: { id: 1, code, name: code, role: 'user' }, heartbeatMs: 60000 });
    }
    if (p === '/api/auth/heartbeat' && m === 'POST') {
      if (!who) return send(401, { ok: false, error: '未登录' });
      return send(200, { ok: true, alive: true, evicted: false });
    }
    if (p === '/api/auth/logout' && m === 'POST') {
      if (who) CLOUD.sessions.delete(who);
      return send(200, { ok: true, loggedOut: true });
    }
    if (p === '/api/master' && m === 'GET') {
      if (!who) return send(401, { ok: false, error: '未登录' });
      const frags = CLOUD.adminFragAdd ? [...CLOUD.masterFrags, CLOUD.adminFragAdd] : CLOUD.masterFrags;
      return send(200, { ok: true, fragments: frags, syncedAt: new Date().toISOString() });
    }
    if (p.startsWith('/api/board/') && m === 'GET') {
      if (!who) return send(401, { ok: false, error: '未登录' });
      const key = `${who}|${p.split('/')[3]}`;
      const frags = CLOUD.board.get(key) || JSON.parse(JSON.stringify(CLOUD.masterFrags));
      return send(200, { ok: true, board: { day: 1, fragments: frags } });
    }
    if (p.startsWith('/api/board/') && m === 'POST' && p.endsWith('/fragment')) {
      if (!who) return send(401, { ok: false, error: '未登录' });
      const key = `${who}|${p.split('/')[3]}`;
      const frags = CLOUD.board.get(key) || JSON.parse(JSON.stringify(CLOUD.masterFrags));
      const id = 'new-' + Date.now();
      frags.push({ id, name: body.name, morning: !!body.morning, evening: !!body.evening,
        day: body.day || 1, dialogues: [] });
      CLOUD.board.set(key, frags);
      return send(200, { ok: true, id });
    }
    if (p.startsWith('/api/board/') && m === 'POST' && p.endsWith('/sent')) {
      return send(200, { ok: true });
    }
    if (p === '/api/phone/check' && m === 'POST') {
      if (!who) return send(401, { ok: false, error: '未登录' });
      const list = CLOUD.phones.get(body.phone) || [];
      const owners = list.filter((x) => x.code !== who).map((x) => ({ code: x.code, name: x.code, customerCode: x.customerCode }));
      return send(200, { ok: true, conflict: owners.length > 0, owners, mine: list.some((x) => x.code === who) });
    }
    if (p === '/api/phone/register' && m === 'POST') {
      if (!who) return send(401, { ok: false, error: '未登录' });
      const list = CLOUD.phones.get(body.phone) || [];
      list.push({ code: who, customerCode: body.customerCode || '' });
      CLOUD.phones.set(body.phone, list);
      return send(200, { ok: true, saved: true });
    }
    return send(404, { ok: false, error: 'mock 没这个接口：' + p });
  });
}

/* ------------------------------ 开跑 ------------------------------ */

(async () => {
  const server = makeFakeCloud();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  const BASE = `http://127.0.0.1:${PORT}`;

  // 把假云端写进测试用的那份 config.yaml（隔离副本，不碰真实配置）
  const yaml = (() => { try { return require('js-yaml'); } catch (e) { return require('../src/yaml-lite'); } })();
  const cfgText = fs.readFileSync(CONFIG, 'utf8');
  const cfg = yaml.load(cfgText) || {};
  cfg.cloud = { baseUrl: BASE, lastCode: '' };
  fs.writeFileSync(CONFIG, yaml.dump(cfg), 'utf8');

  const cloud = require('../src/cloud');

  console.log('\n=== ① 主数据只读 ===');
  await cloud.login({ baseUrl: BASE, code: 'mj005', password: 'x', device: 'TEST-PC' });
  const m = await cloud.syncMaster();
  check('能同步到主数据', m.fragments.length === 2, JSON.stringify(m.fragments.map((f) => f.id)));
  const masterWrites = CLOUD.calls.filter((c) => c.p.startsWith('/api/master') && c.m !== 'GET');
  check('软件对主数据【只有 GET】，没有任何写操作', masterWrites.length === 0,
    JSON.stringify(masterWrites));

  console.log('\n=== ② 登录互斥 ===');
  const c2 = require('../src/cloud');   // 同一个模块实例，用改设备的方式模拟"另一台机器"
  c2._state.token = '';                 // 清掉本机令牌（另一台机器），但云端那条会话还在
  let busyErr = null;
  try {
    await cloud.login({ baseUrl: BASE, code: 'mj005', password: 'x', device: 'ANOTHER-PC' });
  } catch (e) { busyErr = e; }
  check('编号被别人占用 → 抛 busy', !!busyErr && busyErr.busy === true, busyErr && busyErr.message);
  check('提示里写明占用者', !!busyErr && /TEST-PC/.test(busyErr.message), busyErr && busyErr.message);

  // 本机重新登回来
  await cloud.login({ baseUrl: BASE, code: 'mj005', password: 'x', device: 'TEST-PC' });
  check('本机重登成功（同设备放行）', cloud.status().loggedIn === true);

  console.log('\n=== ③ 编号仓库（编排台走云端） ===');
  const before = CLOUD.calls.filter((c) => c.m !== 'GET' && c.p.startsWith('/api/master')).length;
  const b0 = await cloud.getBoard('C001');
  check('能拉到合并看板', (b0.fragments || []).length === 2, JSON.stringify((b0.fragments || []).length));
  await cloud.addFragment('C001', { name: '我在软件里加的话题', day: 3 });
  const masterAfter = CLOUD.calls.filter((c) => c.m !== 'GET' && c.p.startsWith('/api/master')).length;
  check('加碎片后，主数据依然没被写过', masterAfter === before, String(masterAfter));
  check('加碎片确实打到了仓库接口',
    CLOUD.calls.some((c) => c.p.includes('/api/board/C001/fragment') && c.m === 'POST'));

  console.log('\n=== ④ 电话查重 ===');
  // mj006 先登记一个号，mj005 再存同一个号应该报冲突
  CLOUD.phones.set('+15418010646', [{ code: 'mj006', customerCode: 'C009' }]);
  const chk = await cloud.checkPhone('+15418010646', 'C001');
  check('冲突能识别出来', chk.conflict === true, JSON.stringify(chk));
  check('提示里带归属编号', chk.owners?.[0]?.code === 'mj006', JSON.stringify(chk.owners));
  const chk2 = await cloud.checkPhone('+19990001111', 'C001');
  check('没登记过的号 → 不冲突', chk2.conflict === false);
  await cloud.registerPhone('+19990001111', 'C001', 'Kevin', false);
  check('登记号码打到 /api/phone/register',
    CLOUD.calls.some((c) => c.p === '/api/phone/register' && c.m === 'POST'));

  console.log('\n=== ⑤ 后台改主数据 → 软件同步看得见 ===');
  CLOUD.adminFragAdd = { id: 'mf_new', day: 7, name: '后台新加的 Day7 话题', morning: true, evening: false, dialogues: [] };
  await cloud.syncMaster();
  const cached = cloud.cachedMaster();
  check('本地缓存里出现了后台新加的碎片',
    (cached.fragments || []).some((f) => f.id === 'mf_new'),
    JSON.stringify((cached.fragments || []).map((f) => f.id)));

  console.log('\n=== ⑥ 离线兜底 ===');
  await cloud.logout(false);
  check('退出后 status.loggedIn = false', cloud.status().loggedIn === false);
  check('配置仍在（知道云端地址）', cloud.status().configured === true);

  // scriptBoard 在没登录时必须走本地
  const scriptBoard = require('../src/scriptBoard');
  check('没登录云端时 scriptBoard.cloudReady() = false', scriptBoard.cloudReady() === false);
  // ⚠️ 客户编号落盘时会被安全化（只留字母数字），所以这里别用连字符，否则文件名对不上
  const localBoard = await scriptBoard.getBoardAsync('CLOUDLOCAL1');
  check('没登录时仍能拿到看板（走本地种子）', (localBoard.fragments || []).length > 0,
    String((localBoard.fragments || []).length));
  const localFile = path.join(DATA_DIR, 'board', 'CLOUDLOCAL1.json');
  check('本地看板确实落盘了（离线可用）', fs.existsSync(localFile), localFile);

  // 云端地址不可达时不能让软件崩
  cloud._state.base = 'http://127.0.0.1:1';
  cloud._state.token = 'x';
  cloud._state.operator = { code: 'x' };
  const b = await scriptBoard.getBoardAsync('CLOUDOFFLINE1');
  check('云端不可达 → 自动退回本地，不抛错', (b.fragments || []).length > 0,
    String((b.fragments || []).length));

  console.log('\n=== ⑦ 心跳 ===');
  cloud._state.base = BASE;
  await cloud.login({ baseUrl: BASE, code: 'mj005', password: 'x', device: 'TEST-PC' });
  const hb = await cloud.heartbeat();
  check('心跳正常返回 alive', hb.alive === true, JSON.stringify(hb));

  // 云端说"你被踢了" → 客户端要清令牌
  CLOUD.sessions.clear();
  const hb2 = await cloud.heartbeat();
  check('令牌失效时清掉登录态（会被踢下线）', hb2.alive === false && cloud.status().loggedIn === false,
    JSON.stringify(hb2));

  console.log('\n=== ⑧ 同步话题开关 + 5 分钟冷却（老板 2026-10-01 第 3 条） ===');
  // 上一节把云端会话清掉了，这里重新登录，保证 manualSync / boot 有令牌
  await cloud.login({ baseUrl: BASE, code: 'mj005', password: 'x', device: 'TEST-PC' });

  // 清掉本地 sync 偏好，模拟"第一次用软件"：默认应勾上「启动同步」
  if (fs.existsSync(cloud.SYNC_FILE)) fs.unlinkSync(cloud.SYNC_FILE);
  const pref0 = cloud.readSyncPref();
  check('第一次用软件默认勾上启动同步', pref0.autoSync === true, JSON.stringify(pref0));

  // 「启动同步」勾选框：切来切去要落盘 + 反映在 status
  cloud.setAutoSync(false);
  check('取消启动同步后 status.autoSync=false', cloud.status().autoSync === false);
  cloud.setAutoSync(true);
  check('勾上启动同步后 status.autoSync=true', cloud.status().autoSync === true);

  // 「同步话题」第一次点：成功
  const s1 = await cloud.manualSync();
  check('第一次点同步话题成功', s1.ok === true, JSON.stringify(s1));
  const expectedFrags = CLOUD.masterFrags.length + (CLOUD.adminFragAdd ? 1 : 0);
  check('同步回来的碎片数 = 主数据碎片数', s1.fragments === expectedFrags, String(s1.fragments) + ' vs ' + expectedFrags);
  check('同步后立刻进入 5 分钟冷却（cooldownLeft>0）', cloud.cooldownLeft() > 0, String(cloud.cooldownLeft()));
  check('状态里也报冷却中', cloud.status().cooldownLeft > 0);

  // 5 分钟内再点：被拦（ok:false + cooldownLeft），不会重复烧流量
  const s2 = await cloud.manualSync();
  check('冷却期内再点被拦下', s2.ok === false && s2.cooldownLeft > 0, JSON.stringify(s2));

  // 把 lastManualAt 改到 5 分钟前 → 冷却应当归零，又能点
  fs.writeFileSync(cloud.SYNC_FILE, JSON.stringify({ autoSync: false, lastManualAt: Date.now() - (cloud.MANUAL_COOLDOWN_MS + 1000) }));
  check('冷却过期后 cooldownLeft 归零', cloud.cooldownLeft() === 0, String(cloud.cooldownLeft()));
  const s3 = await cloud.manualSync();
  check('冷却归零后又能同步', s3.ok === true, JSON.stringify(s3));

  // 启动同步：boot() 应同步一次并自动取消勾选
  cloud.setAutoSync(true);
  const bootRes = await cloud.boot();
  check('boot 读到了云端配置', bootRes.configured === true, JSON.stringify(bootRes));
  check('boot 勾了启动同步 → 同步一次', bootRes.autoSynced === true, JSON.stringify(bootRes));
  check('boot 之后启动同步被自动取消', cloud.status().autoSync === false, JSON.stringify(cloud.status()));

  /* ------------------------------ 汇总 ------------------------------ */
  // ⚠️ 这行的格式要跟其它子套件一致（run_all.js 靠 /自检\]\s*通过|失败/ 抓它）
  console.log(`\n[云端自检] 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) console.log('[云端自检] 失败项：\n - ' + failures.join('\n - '));

  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('[云端自检] 异常：', e);
  process.exit(1);
});
