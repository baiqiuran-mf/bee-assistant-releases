/**
 * 2.6.1125 产物验收：抽 dist/win-unpacked/resources/app.asar，
 * 逐文件验「每日话术编排台浮窗置顶（alwaysOnTop）」真的进了安装包，
 * 并复用 2.6.1124 的 WA① 4 处改动断言（确认没被回退）。
 * 只读，不修改产物。
 *
 * ⚠️ 用 asar CLI 的 `extract`（整包抽到临时目录再逐文件读），
 *    不要用 listPackage().includes('src/x.js')——它返回的是反斜杠路径，永远不命中。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
const TMP = path.join(ROOT, '.tmp-asar-1125');

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

console.log('\n=== 版号 ===');
const pkg = JSON.parse(rd('package.json'));
check('asar 内 package.json version = 2.6.1125', pkg.version === '2.6.1125', pkg.version);
check('CHANGELOG 有 2.6.1125 段', has('CHANGELOG.md', '2.6.1125'));
check('CHANGELOG 有 2.6.1124 段（延续未删）', has('CHANGELOG.md', '2.6.1124'));

console.log('\n=== 🔴 2.6.1125 核心：每日话术编排台浮窗始终置顶（alwaysOnTop） ===');
const mainjs = rd('electron/main.js');
// openBoardWindow 里 new BrowserWindow({... title: '每日话术编排台' ...}) 必须带 alwaysOnTop:true
const block = mainjs.slice(mainjs.indexOf("title: '每日话术编排台'") - 400, mainjs.indexOf("title: '每日话术编排台'") + 400);
check('openBoardWindow 的 BrowserWindow 带 alwaysOnTop: true',
  /title:\s*'每日话术编排台'[\s\S]{0,120}?alwaysOnTop:\s*true/.test(block)
  || /alwaysOnTop:\s*true[\s\S]{0,120}?title:\s*'每日话术编排台'/.test(block),
  '窗口构造块未同时含 alwaysOnTop:true + 标题');
check('alwaysOnTop 注释带老板 2026-10-15 标注', /alwaysOnTop:\s*true[^\n]*编排台浮窗始终置顶/.test(mainjs));

console.log('\n=== 复用 2.6.1124：WA① 4 处改动仍在（确认没被回退） ===');
const appjs = rd('public/app.js');
const css = rd('public/style.css');
const idx = rd('public/index.html');
check('① 左栏点 WA① 客户 → 跳 WA① 页签（isWhatsappWebCustomer 分支）',
  /if \(row && isWhatsappWebCustomer\(row\)\)/.test(appjs) && /switchMidTab\('wa1'\)/.test(appjs));
check('③ 对话信息左右分侧（in/out）',
  /\.tv-msg\.in\s*\{/.test(css) && /\.tv-msg\.out\s*\{/.test(css));
check('④ #wa1-jump 按钮已删', !has('public/index.html', 'id="wa1-jump"'));
check('④ WA① 资料卡剩「客户档案」「对话提档」两个按钮',
  /id="wa1-profile-full"[^>]*>客户档案/.test(idx) && /id="wa1-profile-extract"[^>]*>对话提档/.test(idx));
check('气泡底色保留（.tv-msg.in 浅蓝 #eaf2ff / .tv-msg.out 浅绿 #e8f7ee）',
  /\.tv-msg\.in\s+\.tv-zh[^\n]*background:\s*#eaf2ff/.test(css)
  && /\.tv-msg\.out\s+\.tv-zh[^\n]*background:\s*#e8f7ee/.test(css));

console.log('\n=== 编号规则 · 只记不扩（ids.js 一个字节没动） ===');
const ids = rd('src/ids.js');
check('ids.js 仍只有 WA(\\d{5}) 规则', /WA\(\\d\{5\}\)|WA\(d\{5\}\)/.test(ids));
check('ids.js 没扩 WB/WD/WE/WF', !/WB\(\\d\{5\}\)/.test(ids) && !/WD\(\\d\{5\}\)/.test(ids) && !/WE\(\\d\{5\}\)/.test(ids) && !/WF\(\\d\{5\}\)/.test(ids));

console.log('\n=== 不该碰的文件 · 一个字节都没动 ===');
check('perm.js 仍是 .perm-hidden 方案（没回退）',
  /classList\.toggle\(\s*'perm-hidden'/.test(rd('public/perm.js')));

console.log('\n========== 通过 ' + pass + ' / 失败 ' + fail + ' ==========');
if (fail > 0) process.exit(1);
