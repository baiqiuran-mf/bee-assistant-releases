/**
 * v2.5.1064 asar 内验证
 * 目的：确认 1064（WhatsApp 不再用 Chrome for Testing、改用系统标准版浏览器）真打进了 NSIS 安装包。
 *       并复用 1060/1061/1062/1063 的关键断言防回退。
 * 用法：node --experimental-sqlite test/verify_asar_1064.js
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
if (!asarPath) { console.log('找不到 app.asar，候选：\n' + candidates.join('\n')); process.exit(1); }
console.log('asar 位置：' + asarPath);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-verify-'));
asar.extractAll(asarPath, tmp);
console.log('已解包到：' + tmp + '\n');

// ---- 版本号 ----
const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
check('包内 version = 2.5.1064', pkg.version === '2.5.1064', 'version=' + pkg.version);

// ---- 1064：WhatsApp 改用系统标准版浏览器（不再用 CfT）----
const sessionSrc = fs.readFileSync(path.join(tmp, 'src', 'session.js'), 'utf8');
check('session.js 用 resolveStandardExecutable 给 WA 选浏览器',
  /require\('\.\/browserPath'\)\.resolveStandardExecutable\(\{\}\)/.test(sessionSrc), 'src/session.js');
check('session.js 不再用 resolveExecutable（CfT 优先）给 WA 选浏览器',
  !/require\('\.\/browserPath'\)\.resolveExecutable\(\{\}\)/.test(sessionSrc), 'src/session.js');
const browserPath = fs.readFileSync(path.join(tmp, 'src', 'browserPath.js'), 'utf8');
check('browserPath.js 有 resolveStandardExecutable（系统优先）',
  /function resolveStandardExecutable/.test(browserPath) && /systemBrowsers\(\), \.\.\.puppeteerChromes/.test(browserPath), 'src/browserPath.js');

// ---- 1063：Signal 图标（防回退）----
check('app.asar 内包含 public/img/signal.svg', fs.existsSync(path.join(tmp, 'public', 'img', 'signal.svg')));
const appJs = fs.readFileSync(path.join(tmp, 'public', 'app.js'), 'utf8');
check('signalTagHtml 改用 /img/signal.svg 图标', /class="ch-signal-ico" src="\/img\/signal.svg"/.test(appJs), 'public/app.js');
check('Signal 图标 CSS 固定 20×20', /#chat-head \.ch-name \.ch-signal \.ch-signal-ico\s*\{[^}]*width:\s*20px[^}]*height:\s*20px/.test(fs.readFileSync(path.join(tmp, 'public', 'style.css'), 'utf8')));

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
