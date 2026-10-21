/**
 * 端到端冒烟测试：配置解析 + 知识库按需加载 + AI 降级 + HTTP 接口 + 静态页面 + SSE
 * 不需要联网，不需要 API key
 * 运行：node --experimental-sqlite test/smoke.test.js
 */

const fs = require('fs');
const path = require('path');

// 数据隔离：本测试只写临时目录，绝不碰真实 data/
const { DIR: DATA_DIR } = require('./_isolate.js');
const DB = path.join(DATA_DIR, 'assistant.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);

const store = require('../src/db');
const doc = require('../src/customerDoc');
const ai = require('../src/ai');
const knowledge = require('../src/knowledge');
const { createServer } = require('../src/server');
const { loadConfig } = require('../src/main');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
}
function eq(name, actual, expected) {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

(async () => {
  console.log('--- 配置解析 ---');
  const cfg = loadConfig();
  check('config.yaml 解析成功', !!cfg && !!cfg.app);
  eq('默认端口', cfg.app.port || 8787, 8787);
  eq('账号数量', (cfg.accounts || []).length, 5);
  eq('默认只启用 1 个账号', (cfg.accounts || []).filter((a) => a.enabled).length, 1);
  check('浏览器默认有头模式', cfg.browser.headless === false);
  // ②③ 用哪家是用户在「AI 设置」里自己定的（2026-09-25 加了 DeepSeek 之后，
  // 用户真的把 ② 切到了 deepseek）——所以这里只断言「能解析出一家 + 有模型名」，
  // 不再把混元写死，否则用户一改配置这个测试就假失败。
  const tr = (cfg.ai.tasks || {}).translate || {};
  const sg = (cfg.ai.tasks || {}).suggest || {};
  check('translate 解析出了服务商 + 模型名',
    !!(cfg.ai.providers || {})[tr.provider] && !!tr.model, JSON.stringify(tr));
  check('suggest 解析出了服务商 + 模型名',
    !!(cfg.ai.providers || {})[sg.provider] && !!sg.model, JSON.stringify(sg));
  // ⑤ 看图用哪家同样是用户在「AI 设置」里定的（混元欠费那阵子被切到了 Agnes，
  // 模型也就跟着变成 agnes-3.0-flash）——所以这里也只断言「解析得出服务商 + 有模型名」，
  // 不把 hy-vision-2.0-instruct 写死，否则用户一改配置这条就假失败。
  const vs = (cfg.ai.tasks || {}).vision || {};
  check('vision 解析出了服务商 + 模型名',
    !!(cfg.ai.providers || {})[vs.provider] && !!vs.model, JSON.stringify(vs));

  // 「未配 key 时的降级」必须可测，就不能依赖"用户还没填 key"这个前提
  // （用户填上 key 之后这几条就会假失败）。这里显式清空一份配置副本用来测降级，
  // 真配置 cfg 原样留着给后面的 HTTP 用例。
  const cfgNoKey = JSON.parse(JSON.stringify(cfg.ai));
  for (const p of Object.values(cfgNoKey.providers || {})) {
    if (p && typeof p === 'object') p.apiKey = '';
  }
  check('清空 key 的副本里确实没 key（默认状态）', !cfgNoKey.providers.hunyuan.apiKey);

  console.log('\n--- 知识库按需加载 ---');
  ai.setAiConfig(cfg.ai);
  knowledge.setKnowledgeConfig(cfg.knowledge);
  eq('必加载文件 4 份', knowledge.alwaysFiles().length, 4);
  check('必加载含 playbook7d', knowledge.alwaysFiles().some((f) => f.includes('playbook7d')));
  check('必加载含 persona', knowledge.alwaysFiles().includes('persona.md'));
  check('必加载含 redlines', knowledge.alwaysFiles().includes('redlines.md'));
  check('必加载含 templates', knowledge.alwaysFiles().includes('templates.md'));

  const priceHit = knowledge.matchFiles('这个尺寸多少钱？运费怎么算');
  check('问价格命中 products.md', priceHit.includes('products.md'), JSON.stringify(priceHit));
  const petHit = knowledge.matchFiles('my dog passed away last year');
  check('宠物过世命中 stories.md', petHit.includes('stories.md'), JSON.stringify(petHit));
  check('无关闲聊不误命中', knowledge.matchFiles('今天天气不错').length === 0);

  const blocks = knowledge.buildBlocks('这个多大尺幅？多少钱');
  check('知识块包含必加载内容', blocks.text.includes('人设与说话习惯'));
  check('知识块包含红线', blocks.text.includes('红线清单'));
  check('命中时才带上产品表', blocks.matched.includes('products.md'));
  check('未命中时不带故事集', !blocks.matched.includes('stories.md'));

  console.log('\n--- AI 未配置时的降级 ---');
  ai.setAiConfig(cfgNoKey);            // 换成"没 key"那份，测降级
  check('key 未填时 translate 不可用', !ai.isReady('translate'));
  check('key 未填时给出明确原因', !!ai.notConfiguredReason('suggest'));
  const noKey = await ai.translate('hello');
  check('无 key 调用返回 null 而不是抛错', noKey === null, String(noKey));
  const noSuggest = await ai.suggest({ customer: {}, messages: [] });
  check('无 key 时 suggest 返回 null', noSuggest === null);
  check('能把围栏里的 JSON 解出来', ai.parseJsonSafe('```json\n{"a":1}\n```').a === 1);
  check('能把混杂文字里的 JSON 解出来', ai.parseJsonSafe('好的：{"a":2}，完毕').a === 2);
  check('解不出 JSON 时返回 null 而不崩', ai.parseJsonSafe('这不是JSON') === null);
  // 注意：这里【故意不还原】真配置。本文件承诺"不联网、不需要 API key"，
  // 后面的 HTTP 用例（AI 就绪标记=false、suggest 返回 503 带中文原因）就是在
  // "没配 key"这个前提下断言的；哪天用户真填了 key，还原就会让它们假失败。

  console.log('\n--- HTTP 接口 ---');
  store.upsertAccount.run({ id: 1, label: '主号', phone: '', proxy: '' });
  const c1 = store.getOrCreateCustomer(1, '15346850001@s.whatsapp.net', { name: 'Alice', phone: '15346850001' });
  store.updateCustomer.run({
    code: c1.customer.code, name: 'Alice', region: '旧金山',
    timezone: doc.guessTimezone('旧金山'), stage_day: 1, mood: '有兴趣',
    summary: null, profile_json: null,
    phone: c1.customer.phone,
    // updateCustomer 用的是命名参数：少一个就抛 "Missing named parameter"
    created_at: null, created_at_source: null,
  });
  store.saveMessage({ customerCode: c1.customer.code, accountId: 1, direction: 'in', body: 'How much for a 16x20?', waMsgId: 'smoke-1' });
  store.saveMessage({ customerCode: c1.customer.code, accountId: 1, direction: 'in', body: 'size please', waMsgId: 'smoke-2', silent: true });
  doc.writeCustomerDoc(store.getCustomer.get(c1.customer.code), store.listMessages.all(c1.customer.code));

  const accountStates = new Map([[1, { id: 1, label: '主号', enabled: true, status: 'online' }]]);
  const httpServer = createServer(
    { db: store, doc, ai, knowledge, cfg, getAccountStates: () => [...accountStates.values()] },
    0
  );

  await new Promise((r) => httpServer.server.listen(0, '127.0.0.1', r));
  const port = httpServer.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  eq('GET /api/state 返回账号 1 条', state.accounts.length, 1);
  check('账号状态透传到前端', state.accounts[0].status === 'online');
  check('AI 就绪标记透传给前端', state.ai.suggest.ready === false);
  check('驱动名透传', typeof state.driver === 'string' && state.driver.length > 0);

  const list = await fetch(`${base}/api/customers`).then((r) => r.json());
  eq('客户列表返回 1 条', list.length, 1);
  check('列表带最后一条预览', !!list[0].last_body);

  const pendingOnly = await fetch(`${base}/api/customers?only=pending`).then((r) => r.json());
  check('only=pending 过滤生效', pendingOnly.length === 1 && pendingOnly[0].pending === 1);

  const detail = await fetch(`${base}/api/customer/${c1.customer.code}`).then((r) => r.json());
  eq('客户详情返回编号一致', detail.customer.code, c1.customer.code);
  eq('消息条数正确', detail.messages.length, 2);
  check('详情返回档案文档路径', !!detail.docFile);
  check('详情返回疑似重复（数组）', Array.isArray(detail.duplicates));

  const notFound = await fetch(`${base}/api/customer/9A99999`);
  eq('不存在的客户返回 404', notFound.status, 404);

  const profRes = await fetch(`${base}/api/customer/${c1.customer.code}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Wu', region: '纽约', timezone: null, stage_day: 2, mood: '有事' }),
  }).then((r) => r.json());
  eq('改档案后姓名更新', profRes.customer.name, 'Alice Wu');
  eq('改档案后阶段更新', profRes.customer.stage_day, 2);
  // 地区改了 → 时区跟着重算（2026-09-25 实测发现的老问题：以前沿用旧时区，
  // 于是"地区=纽约、时区=洛杉矶"这种自相矛盾的数据会留在库里，
  // 档案文档和界面上的"客户当地时间"都是错的 —— 而当地时间决定"现在该不该发消息"）
  eq('改地区 → 时区按新地区重算', profRes.customer.timezone, 'America/New_York');
  check('改名后档案文档跟着重命名', String(profRes.docFile).includes('Alice Wu_15346850001'));

  // 但用户【手填】的时区不能被地区覆盖：时区栏填了值（和库里不一样）就听用户的
  const tzKeep = await fetch(`${base}/api/customer/${c1.customer.code}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Wu', region: '纽约', timezone: 'Asia/Tokyo', stage_day: 2, mood: '有事' }),
  }).then((r) => r.json());
  eq('手填的时区优先（不被地区覆盖）', tzKeep.customer.timezone, 'Asia/Tokyo');

  /* ---- 2026-09-30：「时区」栏改成填数字（与北京的小时差）后的一整套口径 ---- */
  // 新界面每次保存都会把时区字段发上来（空就是空字符串），所以"地区改了要重算时区"
  // 不能再靠"字段没传"判断（不然改地区后时区还停在原地，中栏当地时间就是错的）。
  const tzRegion = await fetch(`${base}/api/customer/${c1.customer.code}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Wu', region: '洛杉矶', timezone: '', stage_day: 2 }),
  }).then((r) => r.json());
  eq('时区栏留空 + 地区改成洛杉矶 → 时区跟着重算', tzRegion.customer.timezone, 'America/Los_Angeles');

  const tzHand = await fetch(`${base}/api/customer/${c1.customer.code}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Wu', region: '洛杉矶', timezone: '-12', stage_day: 2 }),
  }).then((r) => r.json());
  eq('时区栏填数字 → 手填的数字优先（比北京晚 12 小时）', tzHand.customer.timezone, '-12');
  const handDoc = fs.readFileSync(tzHand.docFile, 'utf8');
  check('md 里手填时差说人话（比北京晚 12 小时 / 当地 UTC-4）',
    handDoc.includes('当地时间比北京时间晚 12 小时') && handDoc.includes('UTC-4'),
    handDoc.split('\n').filter((l) => l.includes('时间差') || l.includes('| 时区')).join(' | '));

  const tzClear = await fetch(`${base}/api/customer/${c1.customer.code}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Wu', region: '洛杉矶', timezone: '', stage_day: 2 }),
  }).then((r) => r.json());
  eq('把数字清空 → 回到按地区自动（不再是 -12）', tzClear.customer.timezone, 'America/Los_Angeles');

  const suggestRes = await fetch(`${base}/api/customer/${c1.customer.code}/suggest`, { method: 'POST' });
  eq('AI 未配置时 suggest 返回 503', suggestRes.status, 503);
  const suggestBody = await suggestRes.json();
  check('503 里有可读的中文原因', /AI 未配置/.test(suggestBody.error), suggestBody.error);

  const replied = await fetch(`${base}/api/customer/${c1.customer.code}/replied`, { method: 'POST' }).then((r) => r.json());
  check('标记已回复接口成功', replied.ok === true);
  eq('标记后红点清零', store.getCustomer.get(c1.customer.code).pending, 0);

  const indexHtml = await fetch(`${base}/`);
  eq('首页返回 200', indexHtml.status, 200);
  check('首页是 HTML', (indexHtml.headers.get('content-type') || '').includes('text/html'));
  check('首页包含三个容器', (await indexHtml.text()).includes('id="panel"'));

  const css = await fetch(`${base}/style.css`);
  eq('样式文件可访问', css.status, 200);
  const js = await fetch(`${base}/app.js`);
  eq('界面脚本可访问', js.status, 200);
  const missing = await fetch(`${base}/nope.js`);
  eq('不存在的静态资源返回 404', missing.status, 404);

  // 广播的事件应能到达 SSE 客户端
  console.log('\n--- SSE 推送 ---');
  const ctrl = new AbortController();
  const sseRes = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  eq('SSE 连接成功', sseRes.status, 200);
  check('SSE 内容类型正确', (sseRes.headers.get('content-type') || '').includes('text/event-stream'));

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  setTimeout(() => httpServer.broadcast('pending', { code: c1.customer.code, pending: 1 }), 100);

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !buf.includes('event: pending')) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  check('SSE 收到推送事件', buf.includes('event: pending'), buf.slice(0, 120));
  ctrl.abort();

  httpServer.server.close();
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('冒烟测试异常：', e);
  process.exit(1);
});
