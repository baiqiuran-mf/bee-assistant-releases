/**
 * v2.5.1085 asar 内验证
 * 目的：确认 1063（中栏头部 Signal 彩色文字→原装图标 20×20）以及 v2.5.1085（Tele① 应用版原生 UI）真打进了 NSIS 安装包内的 app.asar。
 *       复用 1061/1062/1063 的关键断言，防止打包把前面版本的能力冲掉。
 * 用法：node --experimental-sqlite test/verify_asar_1063.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const asar = require('@electron/asar');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, evidence) {
  if (cond) { pass++; console.log('  PASS  ' + name + (evidence ? '  ← ' + evidence : '')); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name); }
}

const candidates = [
  path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar'),
  path.join(ROOT, 'dist', 'resources', 'app.asar'),
];
let asarPath = candidates.find(p => fs.existsSync(p));
if (!asarPath) {
  console.log('找不到 app.asar，候选：\n' + candidates.join('\n'));
  process.exit(1);
}
console.log('asar 位置：' + asarPath);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-verify-'));
asar.extractAll(asarPath, tmp);
console.log('已解包到：' + tmp + '\n');

// ---- 版本号 ----
const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
check('包内 version = 2.5.1085', pkg.version === '2.5.1085', 'version=' + pkg.version);

// ---- 1063：图标落地 ----
const hasIcon = fs.existsSync(path.join(tmp, 'public', 'img', 'signal.svg'));
check('app.asar 内包含 public/img/signal.svg', hasIcon);
if (hasIcon) {
  const svg = fs.readFileSync(path.join(tmp, 'public', 'img', 'signal.svg'), 'utf8');
  check('图标根标签 width/height=20', /width="20"/.test(svg) && /height="20"/.test(svg), 'signal.svg');
  check('图标是官方蓝 #3a76f0 圆角底', /#3a76f0/.test(svg), 'signal.svg 配色');
  check('图标含官方白色气泡 path', /<path fill="#ffffff"/.test(svg), 'signal.svg 标记');
}
const appJs = fs.readFileSync(path.join(tmp, 'public', 'app.js'), 'utf8');
check('signalTagHtml 改用 /img/signal.svg 图标', /class="ch-signal-ico" src="\/img\/signal.svg"/.test(appJs), 'public/app.js');
check('signalTagHtml 不再逐字彩色（无 SIGNAL_TAG_LETTERS 定义）',
  !/\bconst SIGNAL_TAG_LETTERS\b/.test(appJs), 'public/app.js');
check('图标尺寸写死 20×20（HTML）', /ch-signal-ico" src="\/img\/signal.svg"[^>]*width="20"[^>]*height="20"|width="20"[^>]*height="20"[^>]*src="\/img\/signal.svg"/.test(appJs), 'public/app.js');
const css = fs.readFileSync(path.join(tmp, 'public', 'style.css'), 'utf8');
check('CSS 有 .ch-signal-ico 图标尺寸规则', /#chat-head \.ch-name \.ch-signal \.ch-signal-ico\s*\{/.test(css), 'public/style.css');
check('CSS 图标固定 20×20 像素', /#chat-head \.ch-name \.ch-signal \.ch-signal-ico\s*\{[^}]*width:\s*20px[^}]*height:\s*20px/.test(css), 'public/style.css');

// ---- v2.5.1085：Tele① 应用版原生 UI（替代旧 webview，防回退）----
const html = fs.readFileSync(path.join(tmp, 'public', 'index.html'), 'utf8');
check('Tele① 原生会话列表 #tg-list 在', /id="tg-list"/.test(html));
check('Tele① 对话正文 #tg-conv-body 在', /id="tg-conv-body"/.test(html));
check('Tele① 列表刷新 #btn-tg-list-refresh 在', /id="btn-tg-list-refresh"/.test(html));
check('Tele① 对话刷新 #btn-tg-conv-refresh 在', /id="btn-tg-conv-refresh"/.test(html));
check('Tele① 不再有 webview 内嵌浏览器', !/id="tg-webview"/.test(html));
check('app.js 原生 Tele① 函数齐全',
  /function loadTgConversations/.test(appJs) && /function renderTgConvList/.test(appJs)
  && /function selectTgConv/.test(appJs) && /function loadTgChat/.test(appJs)
  && /function renderTgChat/.test(appJs) && /function onTelegramMessageLive/.test(appJs));
check('app.js 旧 webview 函数已清除',
  !/function tgGoto/.test(appJs) && !/function initTgAddrBar/.test(appJs)
  && !/function loadTgWebview/.test(appJs) && !/async function tgwProbe/.test(appJs)
  && !/async function tgwPages/.test(appJs) && !/function setTgWebviewProxy/.test(appJs));

// ---- 1061：跳转标签选择（防回退）----
const mainJs = fs.readFileSync(path.join(tmp, 'src', 'main.js'), 'utf8');
check('main.js require 了 ./jumpTab', /require\('\.\/jumpTab'\)/.test(mainJs), 'src/main.js');
check('WhatsApp 跳转用 selectImTab + /web\\.whatsapp\\.com/',
  /selectImTab\(found\.browser, found\.page, \/web\\.whatsapp\\.com\//.test(mainJs), 'src/main.js');

// ---- 1062：Signal 跳转回车确认（防回退）----
const sig = fs.readFileSync(path.join(tmp, 'src', 'signalJump.js'), 'utf8');
check('signalJump.js 加了「回车确认」',
  /keyboard\.press\('Enter'\)/.test(sig) && /确认 = 输完文字回车/.test(sig), 'src/signalJump.js');

console.log('\n===== asar 内验证：' + pass + ' 通过 / ' + fail + ' 失败 =====');
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
