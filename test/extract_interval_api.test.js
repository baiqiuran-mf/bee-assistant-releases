/**
 * 提取间隔 · 接口集成测试（POST/GET /api/ai/config 真的能存、能读）
 *
 * 隔离：用 _isolate.js 把配置文件指到临时副本（BEE_CONFIG），写入只落在副本，
 * 绝不碰你真实的 config.yaml。
 * 跑法：node --experimental-sqlite test/extract_interval_api.test.js
 */
const { CONFIG } = require('./_isolate.js');

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const http = require('http');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + extra : ''}`); }
}

(async () => {
  // 用临时副本加载配置（和 BEE_CONFIG 指向同一份，保证内存对象 == 落盘文件）
  const cfg = yaml.load(fs.readFileSync(CONFIG, 'utf8')) || {};
  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');

  const srv = createServer(
    { db, doc, ai, knowledge, cfg, getAccountStates: () => (cfg.accounts || []).map((a) => ({ ...a, status: 'offline' })) },
    0
  );
  await new Promise((res, rej) => { srv.server.once('error', rej); srv.server.listen(0, '127.0.0.1', res); });
  const PORT = srv.server.address().port;
  const base = `http://127.0.0.1:${PORT}`;
  const api = async (p, opts = {}) => {
    const r = await fetch(base + p, opts);
    const t = await r.text();
    let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: r.status, body: b };
  };

  console.log('\n=== 提取间隔 · GET/POST /api/ai/config ===');
  const g0 = await api('/api/ai/config');
  check('GET 返回 200', g0.status === 200, g0.status);
  // 别写死"默认 5"：用户随时会在「AI 设置」里改这个值（现在库里就是 2），
  // 断言只管"接口确实把当前值带出来了、且在合法区间 2~15 内"。
  const iv0 = Number(g0.body.extractInterval);
  check('GET 带出 extractInterval（取 config.yaml 里的当前值）',
    Number.isFinite(iv0) && iv0 >= 2 && iv0 <= 15, g0.body.extractInterval);

  // 只改提取间隔，别的都不动
  const p1 = await api('/api/ai/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ extractInterval: 12 }),
  });
  check('POST 返回 200', p1.status === 200, p1.status);
  check('changed 含 app.extractInterval', Array.isArray(p1.body.changed) && p1.body.changed.includes('app.extractInterval'), JSON.stringify(p1.body.changed));
  check('POST 回显 extractInterval=12', p1.body.extractInterval === 12, p1.body.extractInterval);

  const g1 = await api('/api/ai/config');
  check('再 GET 已是 12（立即生效，不用重启）', g1.body.extractInterval === 12, g1.body.extractInterval);

  // 落盘文件也改了（行内改写、注释不丢）
  const onDisk = fs.readFileSync(CONFIG, 'utf8');
  check('临时 config.yaml 落盘写入 12', /extractInterval:\s*"?12"?/.test(onDisk), onDisk.split('\n').find((l) => /extractInterval/.test(l)));
  check('原同行注释没丢', /消息提取间隔/.test(onDisk));

  // 越界值被收拢到 15
  const p2 = await api('/api/ai/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ extractInterval: 99 }),
  });
  check('越界 99 → 收拢到 15', p2.body.extractInterval === 15, p2.body.extractInterval);
  const g2 = await api('/api/ai/config');
  check('GET 确认是 15', g2.body.extractInterval === 15, g2.body.extractInterval);

  // 还原成跑测试前那个值（不是写死 5 —— 用户自己设的是几就还原成几）
  await api('/api/ai/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ extractInterval: iv0 }),
  });

  try { srv.server.close(); } catch (e) {}
  const ok = fail === 0;
  console.log(`\n[提取间隔·接口测试] ${ok ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
  if (!ok) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('异常：', e); process.exit(1); });
