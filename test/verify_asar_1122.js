/**
 * 2.6.1122 产物验收：抽 dist/win-unpacked/resources/app.asar，
 * 逐文件验「跨消息翻译记忆」真的进了安装包。只读，不修改产物。
 *
 * ⚠️ 用 asar CLI 的 `extract`（整包抽到临时目录再逐文件读），
 *    不要用 listPackage().includes('src/x.js')——它返回的是反斜杠路径，永远不命中。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
const TMP = path.join(ROOT, '.tmp-asar-1122');

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
};

if (!fs.existsSync(ASAR)) {
  console.log('✗ 找不到 ' + ASAR);
  process.exit(1);
}
fs.rmSync(TMP, { recursive: true, force: true });
execFileSync(process.execPath,
  [path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'), 'extract', ASAR, TMP],
  { stdio: 'inherit' });

const rd = (rel) => fs.readFileSync(path.join(TMP, rel), 'utf8');
const has = (rel, needle) => rd(rel).includes(needle);
const exists = (rel) => fs.existsSync(path.join(TMP, rel));

console.log('\n=== 版号 ===');
const pkg = JSON.parse(rd('package.json'));
check('asar 内 package.json version = 2.6.1122', pkg.version === '2.6.1122', pkg.version);
check('CHANGELOG 有 2.6.1122 段', has('CHANGELOG.md', '2.6.1122'));

console.log('\n=== 新文件进包了吗 ===');
check('新文件 src/translationMemory.js 在包里', exists('src/translationMemory.js'));

console.log('\n=== 数据库 src/db.js ===');
check('新表 translation_memory 建表语句在', has('src/db.js', 'CREATE TABLE IF NOT EXISTS translation_memory'));
check('src_norm 是唯一键', /src_norm\s+TEXT NOT NULL UNIQUE/.test(rd('src/db.js')));
check('有 hits 字段（省了多少次调用）', has('src/db.js', 'hits'));
check('查语句 tmGet 在', has('src/db.js', 'tmGet'));
check('命中计数 tmHit 在', has('src/db.js', 'tmHit'));
check('写回 tmUpsert 在（ON CONFLICT 覆盖）', has('src/db.js', 'ON CONFLICT(src_norm) DO UPDATE'));
check('回填 tmSeed 在（INSERT OR IGNORE，只补空缺）', has('src/db.js', 'INSERT OR IGNORE INTO translation_memory'));
check('回填源 listAllTranslations 在', has('src/db.js', 'listAllTranslations'));
check('这批语句都导出了', has('src/db.js', 'tmUpsert,') && has('src/db.js', 'listAllTranslations,'));

console.log('\n=== 记忆模块 src/translationMemory.js ===');
check('归一化函数 normalize', has('src/translationMemory.js', 'function normalize'));
check('上限 MAX_LEN（超长不入字典）', has('src/translationMemory.js', 'MAX_LEN'));
check('查 lookup', has('src/translationMemory.js', 'function lookup'));
check('写回 record', has('src/translationMemory.js', 'function record'));
check('回填 seed / ensureSeeded', has('src/translationMemory.js', 'function seed')
  && has('src/translationMemory.js', 'function ensureSeeded'));
check('开关 fromCfg', has('src/translationMemory.js', 'function fromCfg'));
check('统计 stats', has('src/translationMemory.js', 'function stats'));

console.log('\n=== 翻译管线 src/translator.js ===');
check('引入了 translationMemory', has('src/translator.js', "require('./translationMemory')"));
check('translateOne 先查记忆', /async function translateOne[\s\S]{0,800}translationMemory\.lookup/.test(rd('src/translator.js')));
check('翻完写回记忆', /async function translateOne[\s\S]{0,1600}translationMemory\.record/.test(rd('src/translator.js')));
check('🔴 手动重翻绕过记忆（force）', has('src/translator.js', 'force: !!(opt && opt.force)')
  && has('src/translator.js', 'if (!(job && job.force))')
  && has('src/translator.js', 'if (j.force) { need.push(j); continue; }'));
check('批量先分流（已记住的不进请求）', has('src/translator.js', 'const fromMem = new Map()')
  && has('src/translator.js', 'ai.translateBatch(need.map'));

console.log('\n=== 主进程 src/main.js ===');
check('装载 translationMemory', has('src/main.js', "require('./translationMemory')"));
check('读开关 fromCfg', has('src/main.js', 'translationMemory.fromCfg'));
check('启动后回填 ensureSeeded', has('src/main.js', 'translationMemory.ensureSeeded'));
check('启动清单记了 translation-memory', has('src/main.js', "'translation-memory'"));

console.log('\n=== 服务端 src/server.js ===');
check('只读路由 /api/translate/memory', has('src/server.js', "'/api/translate/memory'"));
check('这条路由确实只读（GET + 返回 stats）',
  /p === '\/api\/translate\/memory' && req\.method === 'GET'/.test(rd('src/server.js'))
  && has('src/server.js', 'translationMemory.stats()'));

console.log('\n=== 设置界面 ===');
check('settings.js 有 renderMemoryStat', has('public/settings.js', 'renderMemoryStat'));
check('settings.js 有 fillMemoryStat', has('public/settings.js', 'fillMemoryStat'));
check('settings.js 渲染后去填统计', has('public/settings.js', 'fillMemoryStat();'));
check('统计块 id 是 ai-mem-stat', has('public/settings.js', 'ai-mem-stat'));

console.log('\n=== 本轮不该动的东西还在吗 ===');
check('translator 并发常量 CONCURRENCY 还在', has('src/translator.js', 'CONCURRENCY'));
check('批大小 BATCH_MAX 还在', has('src/translator.js', 'BATCH_MAX'));
check('重试上限 MAX_AUTO_TRIES 还在', has('src/translator.js', 'MAX_AUTO_TRIES'));
check('气泡模块 waBubble.js 还在（上一版没被弄丢）', exists('src/waBubble.js'));
check('气泡配置 bubbleConfig.js 还在', exists('src/bubbleConfig.js'));

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n[2.6.1122 产物验收] 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
