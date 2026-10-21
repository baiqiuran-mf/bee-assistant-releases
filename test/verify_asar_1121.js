/**
 * 2.6.1121 产物验收：抽 dist/win-unpacked/resources/app.asar，
 * 逐文件验本轮改动真的进了安装包。只读，不修改产物。
 *
 * 本轮核心：WA① 中文译文气泡（新文件 src/waBubble.js）+ 气泡翻译模型挪进 AI 设置
 *          （新文件 src/bubbleConfig.js）+ 自己发的也翻 + 采集侧水位。
 *
 * ⚠️ 用 asar CLI 的 `extract`（整包抽到临时目录再逐文件读），
 *    不要用 listPackage().includes('src/x.js')——它返回的是反斜杠路径，永远不命中。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
const TMP = path.join(ROOT, '.tmp-asar-1121');

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
check('asar 内 package.json version = 2.6.1121', pkg.version === '2.6.1121', pkg.version);
check('asar 内有 CHANGELOG.md', exists('CHANGELOG.md'));
check('CHANGELOG 有 2.6.1121 段', has('CHANGELOG.md', '2.6.1121'));

console.log('\n=== 新文件进去了吗 ===');
check('新文件 src/waBubble.js 在包里', exists('src/waBubble.js'));
check('新文件 src/bubbleConfig.js 在包里', exists('src/bubbleConfig.js'));

console.log('\n=== WA① 中文气泡 src/waBubble.js ===');
check('常量 BUBBLE_MAX（满 100 缩回）', has('src/waBubble.js', 'BUBBLE_MAX'));
check('常量 BUBBLE_KEEP（保留 50）', has('src/waBubble.js', 'BUBBLE_KEEP'));
check('网页侧读消息 readRenderedInPage', has('src/waBubble.js', 'readRenderedInPage'));
check('网页侧贴气泡 paintInPage', has('src/waBubble.js', 'paintInPage'));
check('气泡节点打标记 data-owner（幂等/摘除用）', has('src/waBubble.js', 'data-owner'));
check('读库里已有译文 listRecentTranslations', has('src/waBubble.js', 'listRecentTranslations'));
check('缩容后同轮不许贴回（dropSet）', has('src/waBubble.js', 'dropSet'));
check('绝不重新翻（注释/逻辑里写明）', /不.*重新翻|不.*现翻/.test(rd('src/waBubble.js')));
check('describe 返回 {text, level}', /level/.test(rd('src/waBubble.js')));

console.log('\n=== 气泡翻译模型 src/bubbleConfig.js ===');
check('读新键 bubble.translateModel', has('src/bubbleConfig.js', 'translateModel'));
check('保留老键 telegram.translateModel 回退', has('src/bubbleConfig.js', 'telegram'));
check('导出 set / translateModel / fromCfg',
  has('src/bubbleConfig.js', 'module.exports') &&
  has('src/bubbleConfig.js', 'fromCfg'));

console.log('\n=== 翻译链路 ===');
check('ai.js 有 resolveTaskWithProvider', has('src/ai.js', 'resolveTaskWithProvider'));
check('ai.js complete 收 providerKey', /complete\s*\(\s*taskName\s*,\s*opts\s*,\s*providerKey/.test(rd('src/ai.js')));
check('translator.js 拿 bubbleConfig.translateModel()',
  has('src/translator.js', 'bubbleConfig.translateModel()'));
check('translator.js 引入 bubbleConfig', has('src/translator.js', "require('./bubbleConfig')"));
check('translator.js backfill 不再卡 direction === \'in\'',
  !/backfill[\s\S]{0,600}direction === 'in'/.test(rd('src/translator.js')));

console.log('\n=== 数据库 ===');
check('db.js 有 listRecentTranslations', has('src/db.js', 'listRecentTranslations'));
check('db.js 有复合索引 idx_messages_account_id', has('src/db.js', 'idx_messages_account_id'));
check('listRecentTranslations 走 account_id + body_zh',
  /listRecentTranslations[\s\S]{0,400}body_zh/.test(rd('src/db.js')));

console.log('\n=== 采集侧水位 src/whatsappRead.js ===');
check('常量 PAGE_MAX_NEW（页面侧硬上限 50）', has('src/whatsappRead.js', 'PAGE_MAX_NEW'));
check('probeInPage 收水位参数 SINCE_TS', has('src/whatsappRead.js', 'SINCE_TS'));
check('pageProbeSource 把水位当参数传进去', has('src/whatsappRead.js', 'pageProbeSource'));

console.log('\n=== 服务端接线 src/server.js ===');
check('只读路由 /api/whatsapp/bubble/state', has('src/server.js', '/api/whatsapp/bubble/state'));
check('只读路由 /api/whatsapp/bubble/probe', has('src/server.js', '/api/whatsapp/bubble/probe'));
check('AI 配置回吐 bubbleTranslateModel', has('src/server.js', 'bubbleTranslateModel'));
check('保存时写 bubble.translateModel', has('src/server.js', "bubble', 'translateModel'"));
check('引入 bubbleConfig', has('src/server.js', "require('./bubbleConfig')"));

console.log('\n=== 主进程接线 src/main.js ===');
check('气泡启动 waBubble.startWatching', has('src/main.js', 'waBubble.startWatching'));
check('独立广播事件 wa_bubble_status（不借 whatsapp_status）',
  has('src/main.js', 'wa_bubble_status'));
check('启动清单含 whatsapp-bubble', has('src/main.js', 'whatsapp-bubble'));
check('配置装载 bubbleConfig.fromCfg', has('src/main.js', 'bubbleConfig.fromCfg'));

console.log('\n=== 设置界面 ===');
const js = rd('public/settings.js');
const html = rd('public/settings.html');
check('settings.js 有 id ai-bubble-model', js.includes('ai-bubble-model'));
check('settings.js 有 renderBubbleModelPicker', js.includes('renderBubbleModelPicker'));
check('settings.js 保存时提交 bubbleTranslateModel', js.includes('bubbleTranslateModel'));
check('settings.html 已移除 id="tg-translate-model"', !html.includes('id="tg-translate-model"'));
check('settings.html 留了挪位说明（v2.6.1121）', html.includes('v2.6.1121'));
check('settings.html 保留「新消息提示音」', html.includes('tg-notify-sound'));

console.log('\n=== 本轮不该动的东西还在吗 ===');
check('translator 并发常量 CONCURRENCY 还在', has('src/translator.js', 'CONCURRENCY'));
check('whatsappRead 首轮上限 MAX_PER_TICK 还在', has('src/whatsappRead.js', 'MAX_PER_TICK'));
check('bubble 段独立（老键 telegram.translateModel 仍可读）',
  has('src/bubbleConfig.js', 'telegram'));

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n[2.6.1121 产物验收] 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
