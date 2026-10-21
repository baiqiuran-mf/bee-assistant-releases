/**
 * AI 设置（配置界面）自检
 *
 * 覆盖：
 *   GET  /api/ai/config   读配置（apiKey 只回显尾巴，绝不回明文）
 *   POST /api/ai/config   保存（只改 config.yaml 对应那几行；掩码不会被写回）
 *   POST /api/ai/test     拿配置真打一次请求（这里用本地假网关，不联网）
 *
 * 隔离：数据目录 + 配置文件都指向 .tmp-test-data/<本文件名>/，
 * 跑一百遍也不会动你真实的 data/ 和 config.yaml。
 *
 * 运行：node --experimental-sqlite test/ai_config.test.js
 */

const { CONFIG } = require('./_isolate.js');

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const REAL_CONFIG = path.join(ROOT, 'config.yaml');
const realConfigBefore = fs.readFileSync(REAL_CONFIG, 'utf8');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    fails.push(name + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 160) : ''));
    console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 160) : ''));
  }
}

/* ---------------- 本地假网关（OpenAI 兼容），用来验证"测试连接"真的发请求 ----------------
 * 只认 /v1/chat/completions 和 /v1/models：别的路径回 404，
 * 这样"地址写错 → 404"这条链路也能被真测到。 */
let stubbed = 0;
const fakeGateway = http.createServer((req, res) => {
  const okPath = /^\/v1\/chat\/completions\/?$/.test(req.url)
    || (/^\/v1\/models\/?$/.test(req.url) && req.method === 'GET');
  if (!okPath) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }
  stubbed++;
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (/models/.test(req.url)) {
      res.end(JSON.stringify({ data: [{ id: 'FunAudioLLM/SenseVoiceSmall' }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: '好' } }] }));
  });
});

(async () => {
  await new Promise((r) => fakeGateway.listen(0, '127.0.0.1', r));
  const gwPort = fakeGateway.address().port;
  const gwBase = `http://127.0.0.1:${gwPort}/v1`;

  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');

  const cfg = loadConfig();
  ai.setAiConfig(cfg.ai || {});
  knowledge.setKnowledgeConfig(cfg.knowledge || {});

  const srv = createServer({ db, doc, ai, knowledge, cfg, getAccountStates: () => [] }, 0);
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;

  const api = async (p, opts = {}) => {
    const res = await fetch(base + p, opts);
    const txt = await res.text();
    let body; try { body = JSON.parse(txt); } catch { body = txt; }
    return { status: res.status, body };
  };
  const post = (p, obj) => api(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });

  console.log('\n【1】配置文件路径隔离');
  check('测试写的是临时副本，不是真实 config.yaml', ai.configPath() === CONFIG, ai.configPath());

  console.log('\n【2】GET /api/ai/config');
  let r = await api('/api/ai/config');
  check('接口 200', r.status === 200, r.body);
  check('带回 7 个服务商（DeepSeek / Agnes / 硅基流动 / OpenRouter / TikHub / 阿里百炼 / AstrBot）',
    ['deepseek', 'agnes', 'siliconflow', 'openrouter', 'tikhub', 'bailian', 'astrbot']
      .every((n) => r.body.providers && r.body.providers[n]),
    Object.keys(r.body.providers || {}));
  check('apiKey 不以明文回显（只给 hasKey + 掩码）',
    r.body.providers.deepseek
      && r.body.providers.deepseek.apiKey === undefined
      && r.body.providers.deepseek.hasKey === true
      && typeof r.body.providers.deepseek.keyHint === 'string'
      && r.body.providers.deepseek.keyHint.length > 0,
    r.body.providers.deepseek);
  check('带回配置文件绝对路径（说明书要求写绝对路径）',
    typeof r.body.file === 'string' && path.isAbsolute(r.body.file), r.body.file);
  check('aiReady / aiReason 两个字段都在，且互不矛盾',
    typeof r.body.aiReady === 'boolean' && (r.body.aiReady ? r.body.aiReason === null : !!r.body.aiReason),
    { ready: r.body.aiReady, reason: r.body.aiReason });

  console.log('\n【2b】8 个 AI 的目录（界面就是照它渲染的）');
  const cat = r.body.catalog || {};
  check('目录里正好 6 个 AI', Array.isArray(cat.tasks) && cat.tasks.length === 6,
    (cat.tasks || []).map((t) => t.key));
  check('每个 AI 都写清了「干什么用」',
    (cat.tasks || []).every((t) => t.cn && t.use && t.use.length > 8),
    (cat.tasks || []).map((t) => t.key));
  check('目录里正好 15 个服务商（DeepSeek / Agnes / 硅基流动 / 硅基流动OCR / OpenRouter / TikHub / 阿里百炼 / AstrBot + 5 家 OpenAI 兼容：ChatAnyWhere / API2GPT / 钱多多 / No.1 API-Pro / 智创聚合 + 钱多多语音识别 + ARS千问）',
    Array.isArray(cat.providers) && cat.providers.length === 15, (cat.providers || []).map((p) => p.key));
  check('每个服务商都给了「去哪申请」的可点开地址 + 用途说明',
    (cat.providers || []).every((p) => /^https?:\/\//.test(p.applyUrl) && p.applyTo && p.sample),
    (cat.providers || []).map((p) => p.applyUrl));
  check('每个服务商都有短名 short（翻译弹窗的模型徽章只显示短名，如 DeepSeek / GPT / Agnes）',
    (cat.providers || []).every((p) => typeof p.short === 'string' && p.short.length > 0),
    (cat.providers || []).map((p) => `${p.key}=${p.short}`));
  const trCat = (cat.tasks || []).find((t) => t.key === 'translateReply');
  check('④「采纳后翻英文」可选 DeepSeek / Agnes / 硅基流动 / OpenRouter / TikHub',
    !!trCat && !trCat.fixed && Array.isArray(trCat.providerChoices)
      && ['deepseek', 'agnes', 'siliconflow', 'openrouter', 'tikhub'].every((k) => trCat.providerChoices.includes(k)),
    trCat && trCat.providerChoices);
  check('每个 AI 都有运行状态（ready / provider / reason）',
    (cat.tasks || []).every((t) => r.body.taskState && typeof r.body.taskState[t.key]?.ready === 'boolean'),
    Object.keys(r.body.taskState || {}));

  console.log('\n【3】POST /api/ai/config 保存（混元已从「界面目录」移除，这里用仍在目录里的 DeepSeek 走一遍，验证保存/掩码/即时生效链路）');
  const KEY = 'sk-selftest-abcdef123456';
  r = await post('/api/ai/config', {
    providers: { deepseek: { baseUrl: gwBase, apiKey: KEY, model: 'deepseek-v4-flash' } },
  });
  check('保存返回 ok', r.status === 200 && r.body.ok === true, r.body);
  check('报告了改了哪几项', Array.isArray(r.body.changed) && r.body.changed.length >= 2
    && r.body.changed.some((c) => c.includes('deepseek')), r.body.changed);

  const tmpText = fs.readFileSync(CONFIG, 'utf8');
  check('值真的写进了配置文件', tmpText.includes(gwBase) && tmpText.includes(KEY));
  check('中文注释原样保留（没有被重新序列化冲掉）',
    tmpText.includes('只写到 /v1 为止') && tmpText.includes('英→中翻译'));

  const yaml = require('js-yaml').load(tmpText);
  check('改完仍是合法 YAML，且解析出来就是新值',
    yaml?.ai?.providers?.deepseek?.baseUrl === gwBase && yaml?.ai?.providers?.deepseek?.apiKey === KEY,
    yaml?.ai?.providers?.deepseek);

  console.log('\n【4】界面回显的掩码不能把真 key 覆盖掉');
  r = await post('/api/ai/config', {
    providers: { deepseek: { baseUrl: gwBase, apiKey: 'sk-••••3456' } },
  });
  const afterMask = require('js-yaml').load(fs.readFileSync(CONFIG, 'utf8'));
  check('带 • 的掩码被忽略，真 key 还在',
    afterMask?.ai?.providers?.deepseek?.apiKey === KEY, afterMask?.ai?.providers?.deepseek?.apiKey);

  console.log('\n【5】保存后立即生效（不用重启软件）');
  r = await api('/api/ai/config');
  check('hasKey 变 true 且给出掩码尾巴',
    r.body.providers.deepseek.hasKey === true && /3456$/.test(r.body.providers.deepseek.keyHint || ''),
    r.body.providers.deepseek);
  r = await api('/api/state');
  // 全局「AI 就绪」取决于「回复建议」(suggest→AstrBot) 是否已配 key；本自检不配 AstrBot，
  // 所以这里改验「刚保存的 DeepSeek 所服务的 translate 任务立刻就绪」——这才是保存即时生效该看的指标。
  check('/api/state 里 translate 任务立刻变"就绪"（保存即时生效）',
    !!(r.body.ai && r.body.ai.translate && r.body.ai.translate.ready === true),
    { translate: r.body.ai && r.body.ai.translate, aiReady: r.body.aiReady });

  console.log('\n【6】POST /api/ai/test 连接测试');
  const before = stubbed;
  r = await post('/api/ai/test', { provider: 'deepseek', baseUrl: gwBase, apiKey: KEY, model: 'deepseek-v4-flash' });
  check('真发了一次请求（假网关收到）', stubbed === before + 1, { stubbed, before });
  check('返回 ok + 耗时 + 模型名', r.body.ok === true && typeof r.body.ms === 'number' && r.body.model === 'deepseek-v4-flash', r.body);
  check('返回里带上「真实请求的地址」，出问题一眼看得出',
    typeof r.body.url === 'string' && /\/v1\/chat\/completions$/.test(r.body.url), r.body.url);

  // 【这就是用户报的那个 404 的根因】复制粘贴来的地址常带引号，还把 /chat/completions 一起拼了进来
  const messy = `"${gwBase}/chat/completions'"`;
  const beforeMessy = stubbed;
  r = await post('/api/ai/test', { provider: 'deepseek', baseUrl: messy, apiKey: KEY, model: 'deepseek-v4-flash' });
  check('地址带引号 + 多写了 /chat/completions → 自动纠正后照样打得通（404 那个坑）',
    r.body.ok === true && stubbed === beforeMessy + 1, r.body);

  r = await post('/api/ai/test', { provider: 'deepseek', baseUrl: `${gwBase}/wrongbase`, apiKey: KEY });
  check('地址真写错时，报错里带 404 + 中文排查提示（不是干巴巴的英文）',
    r.body.ok === false && /404/.test(r.body.error || '') && /地址写错/.test(r.body.error || ''), r.body.error);

  r = await post('/api/ai/test', { provider: 'not-exist', baseUrl: gwBase, apiKey: KEY });
  check('服务商不存在时也不崩', r.body.ok === false && /没有这个服务商/.test(r.body.error || ''), r.body);

  r = await post('/api/ai/test', { provider: 'deepseek', baseUrl: 'http://127.0.0.1:1/v1', apiKey: KEY });
  check('地址打不通时把原因带回来', r.body.ok === false && !!r.body.error && r.body.ms >= 0, r.body);

  console.log('\n【7】切默认服务商');
  // 切之前先记下当前值，用来验证「切默认不带动接收信息」
  const beforeTasks = require('js-yaml').load(fs.readFileSync(CONFIG, 'utf8'))?.ai?.tasks || {};
  r = await post('/api/ai/config', {
    defaultProvider: 'deepseek',
    providers: { deepseek: { baseUrl: gwBase, apiKey: 'sk-deepseek-test-000111', model: 'deepseek-v4-flash' } },
  });
  let afterDefault = require('js-yaml').load(fs.readFileSync(CONFIG, 'utf8'));
  check('②③（翻译/抽档案/建议）都切到 deepseek（① 接收信息是采集，不参与切换）',
    ['translate', 'extract', 'suggest'].every((t) => afterDefault?.ai?.tasks?.[t]?.provider === 'deepseek'),
    Object.fromEntries(['translate', 'extract', 'suggest'].map((t) => [t, afterDefault?.ai?.tasks?.[t]?.provider])));
  check('① 接收信息不被「默认用哪家」改动（它是采集环节，不调 AI）',
    afterDefault?.ai?.tasks?.receive?.provider === 'deepseek',
    afterDefault?.ai?.tasks?.receive);
  const beforeTr = beforeTasks?.translateReply?.provider || 'deepseek';
  check('④ 采纳后翻英文不跟着「默认用哪家」变（保持你单独选的那家）',
    afterDefault?.ai?.tasks?.translateReply?.provider === beforeTr
      && ['deepseek', 'agnes', 'tikhub'].includes(afterDefault?.ai?.tasks?.translateReply?.provider),
    { before: beforeTr, after: afterDefault?.ai?.tasks?.translateReply?.provider });
  check('⑤ 看图 / ⑥ 听语音 各有专门的服务商槽，不跟着「默认用哪家」变（保持切之前的值）',
    afterDefault?.ai?.tasks?.vision?.provider === beforeTasks?.vision?.provider
      && afterDefault?.ai?.tasks?.asr?.provider === beforeTasks?.asr?.provider,
    { before: { vision: beforeTasks?.vision?.provider, asr: beforeTasks?.asr?.provider },
      after: { vision: afterDefault?.ai?.tasks?.vision?.provider, asr: afterDefault?.ai?.tasks?.asr?.provider } });

  // 再把「默认用哪家」切到 Agnes，验证④仍保持单独选的那家（不被默认切换带跑）
  const beforeAgnes = require('js-yaml').load(fs.readFileSync(CONFIG, 'utf8'))?.ai?.tasks || {};
  r = await post('/api/ai/config', { defaultProvider: 'agnes' });
  afterDefault = require('js-yaml').load(fs.readFileSync(CONFIG, 'utf8'));
  check('把默认切到 Agnes 之后，④ 仍然保持你单独选的那家（不被带跑）',
    afterDefault?.ai?.tasks?.translateReply?.provider === beforeTr,
    { expected: beforeTr, actual: afterDefault?.ai?.tasks?.translateReply?.provider });
  check('⑦ 看视频槽位也不跟着「默认用哪家」变（保持切之前的值，接口已留、暂未接）',
    afterDefault?.ai?.tasks?.video?.provider === beforeAgnes?.video?.provider,
    { before: beforeAgnes?.video?.provider, after: afterDefault?.ai?.tasks?.video?.provider });

  // 2026-10-09 新增 TikHub：它必须也在「一套配好」里生效。
  // （server.js 的 FALLBACK_MODEL 漏补它的话，modelFor 会是 null → 整段默认切换被静默跳过，
  //   表现为「选 TikHub 点了保存，②③ 根本没变」。这条就是守那个坑。）
  await post('/api/ai/config', {
    defaultProvider: 'tikhub',
    providers: { tikhub: { baseUrl: gwBase, apiKey: 'sk-tikhub-test-000111', model: 'gpt-4o-mini' } },
  });
  const afterTik = require('js-yaml').load(fs.readFileSync(CONFIG, 'utf8'));
  check('「一套配好」选 TikHub 也能生效（②③/抽档案都切过去，不被静默跳过）',
    ['translate', 'extract', 'suggest'].every((t) => afterTik?.ai?.tasks?.[t]?.provider === 'tikhub'),
    Object.fromEntries(['translate', 'extract', 'suggest'].map((t) => [t, afterTik?.ai?.tasks?.[t]?.provider])));

  console.log('\n【8】真实 config.yaml 全程没被碰');
  check('真实 config.yaml 内容与测试开始时完全一致',
    fs.readFileSync(REAL_CONFIG, 'utf8') === realConfigBefore);

  /* ---------------- 汇总 ---------------- */
  console.log(`\n========== AI 设置自检：${pass} 通过 / ${fail} 失败 ==========`);
  if (fail) console.log('失败项:\n - ' + fails.join('\n - '));

  try { srv.server.close(); } catch (e) {}
  try { fakeGateway.close(); } catch (e) {}
  try { db.db.close(); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常：', e);
  try { fakeGateway.close(); } catch (e2) {}
  process.exit(1);
});
