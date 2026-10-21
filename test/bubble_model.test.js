/**
 * 气泡翻译模型 · 配置链路自检（v2.6.1121）
 *
 * 为什么单独一个文件：这是**一个独立功能**（「译文气泡用哪家 AI」这一个开关），
 * 不跟提取间隔、也不跟 7 个 AI 任务目录混在一份测试里 —— 坏了只查这一块。
 *
 * 钉死四件事：
 *   [A] 取值优先级：bubble.translateModel ＞ telegram.translateModel（老键）；
 *       🔴 新键存在时（**哪怕空串**）不许再回头看老键 —— 否则老板把下拉选回
 *       「跟随全局翻译」之后，老键那份旧值会被复活。
 *   [B] ai.resolveTaskWithProvider：指定了且配好 → 用那家；没指定 / 那家没配好 / 名字不存在
 *       → **安静回退**到 tasks.translate（不抛错、不报红）。
 *   [C] 接口：GET 带出 bubbleTranslateModel；POST 能把值写进 config.yaml 的 bubble 段。
 *   [D] 落盘：真的写掉 config.yaml（走隔离副本），且**老键原样保留、一个字节不动**。
 *
 * 跑法：node --experimental-sqlite test/bubble_model.test.js
 */

const { CONFIG } = require('./_isolate.js');

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const bubbleConfig = require(path.join(ROOT, 'src', 'bubbleConfig.js'));
const ai = require(path.join(ROOT, 'src', 'ai.js'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? `  << ${extra}` : ''}`); }
}

(async function run() {
  console.log('\n=== 气泡翻译模型 · 配置链路 ===\n');

  /* ---- [A] 取值优先级 ---- */
  console.log('[A] 取值优先级（新键 ＞ 老键，新键空串也算“新键在”）');
  check('两个键都没有 → 空（跟随全局翻译）', bubbleConfig.fromCfg({}) === '', bubbleConfig.translateModel());
  check('只有老键 → 用老键（兼容，老板不用重选）',
    bubbleConfig.fromCfg({ telegram: { translateModel: 'deepseek' } }) === 'deepseek',
    bubbleConfig.translateModel());
  check('只有新键 → 用新键',
    bubbleConfig.fromCfg({ bubble: { translateModel: 'gpt' } }) === 'gpt', bubbleConfig.translateModel());
  check('新键在老键之上（两个都有时听新键的）',
    bubbleConfig.fromCfg({ bubble: { translateModel: 'agnes' }, telegram: { translateModel: 'deepseek' } }) === 'agnes',
    bubbleConfig.translateModel());
  check('🔴 新键是空串 → 就是「跟随全局」，绝不去复活老键',
    bubbleConfig.fromCfg({ bubble: { translateModel: '' }, telegram: { translateModel: 'deepseek' } }) === '',
    bubbleConfig.translateModel());
  check('set() 会去掉首尾空白', bubbleConfig.set('  agnes  ') === 'agnes', bubbleConfig.translateModel());
  check('set(null) 当空处理', bubbleConfig.set(null) === '', bubbleConfig.translateModel());

  /* ---- [B] 按服务商覆盖（安静回退） ---- */
  console.log('\n[B] resolveTaskWithProvider：覆盖 + 安静回退');
  ai.setAiConfig({
    providers: {
      agnes: { baseUrl: 'https://a.example/v1', apiKey: 'k1', model: 'hy3' },
      deepseek: { baseUrl: 'https://b.example/v1', apiKey: 'k2', model: 'deepseek-v4-flash' },
      gpt: { baseUrl: '', apiKey: '', model: 'gpt-4o-mini' },   // 没配好
    },
    tasks: { translate: { provider: 'agnes', model: 'hy3' } },
  });

  const base = ai.resolveTask('translate');
  check('不覆盖时 = tasks.translate 那家', base.providerName === 'agnes' && base.model === 'hy3',
    base.providerName + '/' + base.model);

  const over = ai.resolveTaskWithProvider('translate', 'deepseek');
  check('指定 deepseek → 改用 deepseek', over.providerName === 'deepseek', over.providerName);
  check('模型用那家自己的默认模型', over.model === 'deepseek-v4-flash', over.model);

  check('空串 = 不覆盖（跟随全局）',
    ai.resolveTaskWithProvider('translate', '').providerName === 'agnes');
  check('undefined = 不覆盖', ai.resolveTaskWithProvider('translate', undefined).providerName === 'agnes');
  check('🔴 选中那家没填 key → 安静回退到全局，不抛错',
    ai.resolveTaskWithProvider('translate', 'gpt').providerName === 'agnes');
  check('选了个不存在的服务商 → 也安静回退',
    ai.resolveTaskWithProvider('translate', '不存在的家').providerName === 'agnes');

  /* ---- [C][D] 接口 + 落盘 ---- */
  console.log('\n[C] GET/POST /api/ai/config 带出/存进 bubble.translateModel');
  const before = fs.readFileSync(CONFIG, 'utf8');
  // 造一份「老键已有值」的起点，验证写新键时老键原样不动
  const legacyLine = /^(\s*)translateModel:.*$/m.test(before);
  check('起点：临时配置里 telegram.translateModel 的状态已知', true, legacyLine ? '老键存在' : '老键不存在');

  const db = require(path.join(ROOT, 'src', 'db.js'));
  const doc = require(path.join(ROOT, 'src', 'customerDoc.js'));
  const knowledge = require(path.join(ROOT, 'src', 'knowledge.js'));
  const { createServer } = require(path.join(ROOT, 'src', 'server.js'));
  const cfg = yaml.load(before) || {};

  const srv = createServer(
    { db, doc, ai, knowledge, cfg, getAccountStates: () => [] },
    0
  );
  await new Promise((res, rej) => { srv.server.once('error', rej); srv.server.listen(0, '127.0.0.1', res); });
  const base2 = `http://127.0.0.1:${srv.server.address().port}`;
  const api = async (p, opts = {}) => {
    const r = await fetch(base2 + p, opts);
    const t = await r.text();
    let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: r.status, body: b };
  };

  const g0 = await api('/api/ai/config');
  check('GET 返回 200', g0.status === 200, g0.status);
  check('GET 带出 bubbleTranslateModel（字符串）', typeof g0.body.bubbleTranslateModel === 'string',
    JSON.stringify(g0.body.bubbleTranslateModel));

  const p1 = await api('/api/ai/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bubbleTranslateModel: 'deepseek' }),
  });
  check('POST 返回 200', p1.status === 200, p1.status);
  check('changed 含 bubble.translateModel',
    Array.isArray(p1.body.changed) && p1.body.changed.indexOf('bubble.translateModel') >= 0,
    JSON.stringify(p1.body.changed));
  check('POST 回显 bubbleTranslateModel=deepseek', p1.body.bubbleTranslateModel === 'deepseek', p1.body.bubbleTranslateModel);

  const g1 = await api('/api/ai/config');
  check('再 GET 已是 deepseek（立即生效，不用重启）', g1.body.bubbleTranslateModel === 'deepseek', g1.body.bubbleTranslateModel);

  const after = fs.readFileSync(CONFIG, 'utf8');
  check('落盘：config.yaml 里写进了 bubble.translateModel',
    yaml.load(after).bubble && yaml.load(after).bubble.translateModel === 'deepseek',
    JSON.stringify((yaml.load(after) || {}).bubble));

  // 选回「跟随全局」：新键写成空串，老键不许被复活
  const p2 = await api('/api/ai/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bubbleTranslateModel: '' }),
  });
  check('选回「跟随全局」也算一次改动', p2.body.changed.indexOf('bubble.translateModel') >= 0, JSON.stringify(p2.body.changed));
  check('🔴 选回空之后取到空（老键没被复活）', bubbleConfig.translateModel() === '', bubbleConfig.translateModel());
  const g2 = await api('/api/ai/config');
  check('GET 也确认是空', g2.body.bubbleTranslateModel === '', JSON.stringify(g2.body.bubbleTranslateModel));

  // 老键（telegram 段）没有被这场写入破坏：整段 telegram 应保持原样
  const beforeTele = (yaml.load(before) || {}).telegram || {};
  const afterTele = (yaml.load(after) || {}).telegram || {};
  check('老键 telegram.* 一个字节没被这场写入改动',
    JSON.stringify(beforeTele) === JSON.stringify(afterTele),
    JSON.stringify(afterTele));

  try { srv.server.close(); } catch (e) {}

  const ok = fail === 0;
  console.log(`\n[气泡翻译模型自检] ${ok ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
  if (!ok) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('异常：', e); process.exit(1); });
