/**
 * 地区 → 时区：保存档案时的「有修改才解读」回归测试（v2.7.1231）
 *
 * 老板要求：
 *   ① 填了/改了地区 → 点「保存档案」时用 AI 解读该地区的时区；
 *   ② 地区没改 → 不许重复问 AI，沿用库里已有的时区；
 *   ③ AI 失败 → 回落静态表，功能不中断；
 *   ④ 时区落库后，右侧资料卡能算出「客户当地时间」和「与北京时间差」。
 *
 * 运行：node --experimental-sqlite test/region_tz_ai.test.js
 * 不联网：这里把 ai.callProviderByName 换成桩，只数调用次数 + 返回固定 IANA 名。
 */

const fs = require('fs');
const path = require('path');

// 数据隔离：只写临时目录，绝不碰真实 data/
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

(async () => {
  const cfg = loadConfig();
  ai.setAiConfig(cfg.ai);
  knowledge.setKnowledgeConfig(cfg.knowledge);

  // ---- AI 桩：不联网，数调用次数 ----
  let aiCalls = 0;
  let lastPrompt = null;
  let aiReply = '{"tz":"America/Chicago"}';
  const origCall = ai.callProviderByName;
  ai.callProviderByName = async (prov, model, opts) => {
    aiCalls++;
    lastPrompt = opts;
    return aiReply;
  };

  store.upsertAccount.run({ id: 1, label: '主号', phone: '', proxy: '' });
  const created = store.getOrCreateCustomer(1, '15346850002@s.whatsapp.net', { name: 'David', phone: '15056371912' });
  const code = created.customer.code;
  store.updateCustomer.run({
    code, name: 'David', region: '美国/加拿大', timezone: 'America/New_York',
    stage_day: 1, mood: '', summary: null, profile_json: null,
    phone: created.customer.phone, created_at: null, created_at_source: null,
  });

  const httpServer = createServer({ db: store, doc, ai, knowledge, cfg }, 0);
  await new Promise((r) => httpServer.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${httpServer.server.address().port}`;

  const save = (body) => fetch(`${base}/api/customer/${code}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ name: 'David', phone: created.customer.phone }, body)),
  }).then((r) => r.json());

  console.log('--- ① 地区没改：不许调 AI ---');
  aiCalls = 0;
  let r = await save({ region: '美国/加拿大', timezone: '' });
  check('地区没改 → 不调 AI', aiCalls === 0, `aiCalls=${aiCalls}`);
  check('地区没改 → 时区沿用旧值', r.customer && r.customer.timezone === 'America/New_York',
    `实际=${r.customer && r.customer.timezone}`);

  console.log('\n--- ② 地区改了：AI 解读一次，时区跟着换 ---');
  aiCalls = 0;
  r = await save({ region: '美国 芝加哥', timezone: '' });
  check('地区改了 → AI 调 1 次', aiCalls === 1, `aiCalls=${aiCalls}`);
  check('地区改了 → 时区用 AI 结果', r.customer && r.customer.timezone === 'America/Chicago',
    `实际=${r.customer && r.customer.timezone}`);
  check('提示词里带的是新地区', !!(lastPrompt && String(lastPrompt.user).includes('美国 芝加哥')),
    lastPrompt && lastPrompt.user);

  console.log('\n--- ③ 同地区再保存：不许重复问 AI ---');
  aiCalls = 0;
  r = await save({ region: '美国 芝加哥', timezone: '' });
  check('同一地区再保存 → 不调 AI', aiCalls === 0, `aiCalls=${aiCalls}`);
  check('同一地区再保存 → 时区不变', r.customer && r.customer.timezone === 'America/Chicago',
    `实际=${r.customer && r.customer.timezone}`);

  console.log('\n--- ④ 时区落库后：当地时间 + 与北京时差可算 ---');
  aiCalls = 0;
  const info = await fetch(`${base}/api/region/timezone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, region: '美国 芝加哥' }),
  }).then((x) => x.json());
  check('时差接口 ok', info.ok === true, JSON.stringify(info));
  check('已有 tz → 不重复调 AI', aiCalls === 0, `aiCalls=${aiCalls}`);
  check('返回客户当地时间（MM-DD HH:MM）', /^\d{2}-\d{2} \d{2}:\d{2}$/.test(String(info.localTime || '')),
    `实际=${info.localTime}`);
  check('返回与北京时差文案', /比北京(早|晚) \d+(\.5)? 小时|和北京同时区/.test(String(info.diffText || '')),
    `实际=${info.diffText}`);

  console.log('\n--- ⑤ AI 挂了：回落静态表，功能不中断 ---');
  aiReply = '这不是 JSON';
  aiCalls = 0;
  r = await save({ region: '英国', timezone: '' });
  check('AI 调用发生了', aiCalls === 1, `aiCalls=${aiCalls}`);
  check('AI 失败 → 静态表兜底 Europe/London', r.customer && r.customer.timezone === 'Europe/London',
    `实际=${r.customer && r.customer.timezone}`);

  console.log('\n--- ⑥ 三段式 IANA 名（以前会被正则误杀）---');
  aiReply = '{"tz":"America/Argentina/Buenos_Aires"}';
  aiCalls = 0;
  r = await save({ region: '阿根廷', timezone: '' });
  check('AI 调 1 次', aiCalls === 1, `aiCalls=${aiCalls}`);
  check('三段式合法时区被接受', r.customer && r.customer.timezone === 'America/Argentina/Buenos_Aires',
    `实际=${r.customer && r.customer.timezone}`);

  console.log('\n--- ⑦ 手填时差优先：数字框有值就不解读 ---');
  aiCalls = 0;
  r = await save({ region: '日本', timezone: '-12' });
  check('手填数字 → 不调 AI', aiCalls === 0, `aiCalls=${aiCalls}`);
  check('手填数字优先于地区', r.customer && r.customer.timezone === '-12',
    `实际=${r.customer && r.customer.timezone}`);

  ai.callProviderByName = origCall;
  await new Promise((r2) => httpServer.server.close(r2));

  console.log(`\n[REGION TZ AI] PASS ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
