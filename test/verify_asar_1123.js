/**
 * 2.6.1123 产物验收：抽 dist/win-unpacked/resources/app.asar，
 * 逐文件验「权限模块用 .perm-hidden 替代 .hidden + CSS 加 .perm-hidden 规则」真的进了安装包。
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
const TMP = path.join(ROOT, '.tmp-asar-1123');

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
// 🔴 2026-10-16：版本号断言改为动态读源码 package.json，避免每次升版本都要手动改这里。
const SRC_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('asar 内 package.json version = 源码版本（当前 ' + SRC_PKG.version + '）',
  pkg.version === SRC_PKG.version, pkg.version);
check('CHANGELOG 有 2.6.1123 段', has('CHANGELOG.md', '2.6.1123'));

console.log('\n=== public/perm.js · A 方案核心改动 ===');
const perm = rd('public/perm.js');

// ✅ 应有：新类 .perm-hidden
check('setHidden 用 .perm-hidden（不再复用 .hidden）',
  /classList\.toggle\(\s*'perm-hidden'\s*,\s*!!hide\s*\)/.test(perm));

// ✅ 注释里写明根因
check('注释提到「QQ20261015-104120」红框', has('public/perm.js', 'QQ20261015-104120'));
check('注释提到「QQ20261015-104218」红框', has('public/perm.js', 'QQ20261015-104218'));
check('注释提到「HTML 自带的 .hidden 一字不动」', has('public/perm.js', 'HTML 自带的 .hidden 一字不动'));

// ❌ 不该再有的旧用法：把 'hidden' 直接 toggle 进业务元素 classList
const oldToggleHidden = perm.match(/classList\.toggle\(\s*'hidden'\s*,\s*!!hide\s*\)/);
check('旧用法 classList.toggle(\'hidden\', !!hide) 已移除', !oldToggleHidden);

// 🔴 检查「把 HTML 自带的 .hidden 一并摘掉」这条警示还在（注释保留）
check('注释保留「admin 登录『放出』」措辞', has('public/perm.js', 'admin 登录'));

console.log('\n=== public/style.css · .perm-hidden 规则 ===');
const css = rd('public/style.css');
check('.perm-hidden 规则已加', /\.perm-hidden\s*\{\s*display:\s*none\s*!important\s*;\s*\}/.test(css));
check('.perm-hidden 规则紧跟在 .hidden 之后（顺序对）',
  css.indexOf('.hidden { display: none !important; }') < css.indexOf('.perm-hidden'));
check('注释说明「与 .hidden 分开」', has('public/style.css', '与 .hidden 分开') || has('public/style.css', '与 HTML 自带的 .hidden 分开'));
check('CSS 注释提到 2.6.1123 A 方案', has('public/style.css', '2.6.1123'));

// ✅ 原有 .hidden 规则还在（不能误删）
check('.hidden 规则原样保留', /\.hidden\s*\{\s*display:\s*none\s*!important\s*;\s*\}/.test(css));
// ✅ 原有 .set-sec.hidden 还在（设置页次要 section 默认藏的那条）
check('.set-sec.hidden 规则原样保留', /\.set-sec\.hidden\s*\{\s*display:\s*none\s*;\s*\}/.test(css));

console.log('\n=== 不该改的文件 · 一个字节都没动 ===');
// index.html 里 .mid-pane[data-mp="wa1"]：A2（v2.6.1143）起改用 wa-offscreen（移出屏幕保活），
// 不再用 HTML 自带的 hidden（display:none 会卸载 webview 内核）。这里锁死「是 wa-offscreen 而非 hidden」。
const idx = rd('public/index.html');
check('index.html: .mid-pane[data-mp=wa1] 是 wa-offscreen（A2 移出屏幕保活，非 display:none 的 hidden）',
  /<div\s+class="mid-pane wa-offscreen"\s+data-mp="wa1"/.test(idx));
check('settings.html: #sec-prompts 类未变（仍是 set-sec hidden）',
  has('public/settings.html', 'class="set-sec hidden" id="sec-prompts"'));

// settings.html / app.js / settings.js 不该出现 perm-hidden（它们都不该碰这个类）
check('settings.js 没有 .perm-hidden（不该碰）', !has('public/settings.js', 'perm-hidden'));
const appJs = rd('public/app.js');
const appNoApplyPermHidden = !/classList\.(toggle|add|remove|contains)\(\s*'perm-hidden'/.test(appJs);
check('app.js 不『应用』.perm-hidden（不该用 classList 碰这个类）', appNoApplyPermHidden);

console.log('\n=== perm.js 其余逻辑没被动过 ===');
// RULES 表保留
check('RULES.midTabs 已清空（2026-10-17 老板拍板：WA①~⑤ 对所有人生效，不再分权限）',
  /midTabs:\s*\[\]/.test(perm));
check('RULES.setTabs = [\'prompts\', \'sim\', \'screenshot\', \'hidden\']（2026-10-17 ①③：proxy 解除隐藏移出、hidden 说明页签改 admin-only 加进）',
  /setTabs:\s*\['prompts',\s*'sim',\s*'screenshot',\s*'hidden'\]/.test(perm));
// ADMIN_ROLE / SAFE 保留
check('ADMIN_ROLE 仍是 admin', has('public/perm.js', "var ADMIN_ROLE = 'admin';"));
check('SAFE.mid 仍是 general', has('public/perm.js', "mid: 'general',"));
check('SAFE.set 仍是 cloud', has('public/perm.js', "set: 'cloud',"));
// ensureSafeTab / blankWaWebview / suspended / ingest 仍都在
check('ensureSafeTab 还在', has('public/perm.js', 'function ensureSafeTab'));
check('blankWaWebview 还在（2026-10-17 起改为 no-op：不再清空 webview，所有人都能加载 WA）', has('public/perm.js', 'function blankWaWebview'));
check('suspended 还在（自动化豁免逻辑）', has('public/perm.js', 'function suspended'));
check('ingest 还在（喂云端状态）', has('public/perm.js', 'function ingest'));
check('apply 还在（主入口）', has('public/perm.js', 'function apply'));
check('BeePerm 暴露在 window', has('public/perm.js', 'global.BeePerm'));

console.log('\n=== 公开 API ===');
// app.js:350 / settings.js:1075 调 BeePerm.ingest 的两处
check('app.js 仍调 BeePerm.ingest', has('public/app.js', 'window.BeePerm.ingest'));
check('settings.js 仍调 BeePerm.ingest', has('public/settings.js', 'window.BeePerm.ingest'));

console.log('\n========== 通过 ' + pass + ' / 失败 ' + fail + ' ==========');
if (fail > 0) process.exit(1);
