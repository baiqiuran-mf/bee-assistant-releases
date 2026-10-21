/**
 * 2.6.1124 产物验收：抽 dist/win-unpacked/resources/app.asar，
 * 逐文件验「WA① 4 处改动（路由跳 WA① / 对话信息左右分侧 / 去掉跳到聊天 / 编号规则只记不扩）」真的进了安装包。
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
const TMP = path.join(ROOT, '.tmp-asar-1124');

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
check('asar 内 package.json version = 2.6.1124', pkg.version === '2.6.1124', pkg.version);
check('CHANGELOG 有 2.6.1124 段', has('CHANGELOG.md', '2.6.1124'));

console.log('\n=== ① 左栏点 WA① 客户 → 跳 WA① 页签 ===');
const appjs = rd('public/app.js');
// 新分支：命中 isWhatsappWebCustomer 就 switchMidTab('wa1') 并 return
check('openCustomerRow 新增 WA① 分支（isWhatsappWebCustomer）',
  /if \(row && isWhatsappWebCustomer\(row\)\)/.test(appjs));
check('WA① 分支里调 switchMidTab\(\'wa1\'\)', /switchMidTab\('wa1'\)/.test(appjs));
check('WA① 分支有 return（不回通用）',
  /if \(row && isWhatsappWebCustomer\(row\)\)[\s\S]{0,900}?return;/.test(appjs));
check('外部 WA 客户（channel=whatsapp）仍走 switchMidTab\(\'general\'\)',
  /switchMidTab\('general'\)/.test(appjs));

console.log('\n=== ③ 对话信息左右分侧（in/out） ===');
const css = rd('public/style.css');
check('app.js renderWaConvInfo 按方向加 in/out 类',
  /const side = \(m && m\.direction === 'out'\) \? 'out' : 'in'/.test(appjs)
  && /class="tv-msg \$\{side\}"/.test(appjs));
check('style.css 有 .tv-msg.in 规则', /\.tv-msg\.in\s*\{/.test(css));
check('style.css 有 .tv-msg.out 规则', /\.tv-msg\.out\s*\{/.test(css));
check('style.css 给 in 靠左 / out 靠右',
  /\.tv-msg\.in\s*\{\s*align-items:\s*flex-start/.test(css)
  && /\.tv-msg\.out\s*\{\s*align-items:\s*flex-end/.test(css));

console.log('\n=== ④ 去「↗ 跳到聊天」按钮 ===');
const idx = rd('public/index.html');
check('index.html 里 #wa1-jump 按钮已删', !has('public/index.html', 'id="wa1-jump"'));
check('WA① 资料卡还剩「客户档案」「对话提档」两个按钮',
  /id="wa1-profile-full"[^>]*>客户档案/.test(idx) && /id="wa1-profile-extract"[^>]*>对话提档/.test(idx));
check('app.js 不再绑定 wa1-jump（无 const jump = $\(\'wa1-jump\'\)）',
  !/const jump = \$\('wa1-jump'\)/.test(appjs));
check('app.js 不再调 jumpToWaChat(wa1ActiveCode, jump)',
  !/jumpToWaChat\(wa1ActiveCode, jump\)/.test(appjs));
// jumpToWaChat 函数本身保留（无别处调用，删不删等老板说）——只确认它还在、且没被误删关键逻辑
check('jumpToWaChat 函数仍在（暂留未删）', has('public/app.js', 'async function jumpToWaChat'));

console.log('\n=== 编号规则 · 只记不扩（ids.js 一个字节没动） ===');
const ids = rd('src/ids.js');
check('ids.js 仍只有 WA(\\\\d{5}) 规则',
  /WA\(\\d\{5\}\)|WA\(d\{5\}\)/.test(ids.replace(/\\\\/g, '\\')) || /WA\(\\d\{5\}\)/.test(ids));
check('ids.js 没扩 WB(\\\\d{5})', !/WB\(\\d\{5\}\)/.test(ids));
check('ids.js 没扩 WD(\\\\d{5})', !/WD\(\\d\{5\}\)/.test(ids));
check('ids.js 没扩 WE(\\\\d{5})', !/WE\(\\d\{5\}\)/.test(ids));
check('ids.js 没扩 WF(\\\\d{5})', !/WF\(\\d\{5\}\)/.test(ids));

console.log('\n=== 不该碰的文件 · 一个字节都没动 ===');
check('perm.js 仍是 2.6.1123 的 .perm-hidden 方案（没回退）',
  /classList\.toggle\(\s*'perm-hidden'/.test(rd('public/perm.js')));
check('index.html .mid-pane[data-mp=wa1] 仍带 HTML 自带 hidden（默认藏次要页签）',
  /<div\s+class="mid-pane hidden"\s+data-mp="wa1"/.test(idx));

console.log('\n========== 通过 ' + pass + ' / 失败 ' + fail + ' ==========');
if (fail > 0) process.exit(1);
