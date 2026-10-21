/**
 * v2.5.1061 asar 内验证
 * 目的：确认「搬状态区 + 加地址栏 + 修读取（1060）」以及「跳转：激活窗口→检测标签→自动选中→搜索（1061）」
 *       都真的打进了 NSIS 安装包内的 app.asar，而不是只改了源码。
 * 用法：node --experimental-sqlite test/verify_asar_1061.js
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

// ---- v2.5.1085：Tele① 应用版原生 UI（替代旧 webview）----
const html = fs.readFileSync(path.join(tmp, 'public', 'index.html'), 'utf8');
check('Tele① 原生会话列表 #tg-list 在', /id="tg-list"/.test(html));
check('Tele① 对话正文 #tg-conv-body 在', /id="tg-conv-body"/.test(html));
check('Tele① 列表刷新 #btn-tg-list-refresh 在', /id="btn-tg-list-refresh"/.test(html));
check('Tele① 对话刷新 #btn-tg-conv-refresh 在', /id="btn-tg-conv-refresh"/.test(html));
check('Tele① 不再有 webview 内嵌浏览器', !/id="tg-webview"/.test(html));
const appJs = fs.readFileSync(path.join(tmp, 'public', 'app.js'), 'utf8');
check('app.js 原生 Tele① 函数齐全',
  /function loadTgConversations/.test(appJs) && /function renderTgConvList/.test(appJs)
  && /function selectTgConv/.test(appJs) && /function loadTgChat/.test(appJs)
  && /function renderTgChat/.test(appJs) && /function onTelegramMessageLive/.test(appJs));
check('app.js 旧 webview 函数已清除',
  !/function tgGoto/.test(appJs) && !/function initTgAddrBar/.test(appJs)
  && !/function loadTgWebview/.test(appJs) && !/async function tgwProbe/.test(appJs)
  && !/async function tgwPages/.test(appJs) && !/function setTgWebviewProxy/.test(appJs));
const srv = fs.readFileSync(path.join(tmp, 'src', 'server.js'), 'utf8');
check('server.js 暴露 /api/telegram/conversations 与 /api/telegram/messages',
  /api\/telegram\/conversations/.test(srv) && /api\/telegram\/messages/.test(srv));
const dbjs = fs.readFileSync(path.join(tmp, 'src', 'db.js'), 'utf8');
check('db.js 有 tgConversations / tgMessages',
  /function tgConversations/.test(dbjs) && /function tgMessages/.test(dbjs));

// ---- 1061：跳转标签选择 ----
const jumpTab = fs.readFileSync(path.join(tmp, 'src', 'jumpTab.js'), 'utf8');
check('jumpTab.js 存在且含 pickImTab', /function pickImTab/.test(jumpTab), 'src/jumpTab.js');
check('jumpTab.js 含 selectImTab', /function selectImTab/.test(jumpTab), 'src/jumpTab.js');
check('selectImTab 先 reveal 再按 URL 选标签', /typeof reveal === 'function'/.test(jumpTab) && /pickImTab\(pages/.test(jumpTab) && /bringToFront/.test(jumpTab));

const mainJs = fs.readFileSync(path.join(tmp, 'src', 'main.js'), 'utf8');
check('main.js require 了 ./jumpTab', /require\('\.\/jumpTab'\)/.test(mainJs), 'src/main.js');
check('WhatsApp 跳转用 selectImTab + /web\\.whatsapp\\.com/', /selectImTab\(found\.browser, found\.page, \/web\\.whatsapp\\.com\//.test(mainJs), 'src/main.js jumpToChat WA');
check('Telegram 跳转用 selectImTab + /web\\.telegram\\.org|telegram\\.org/', /selectImTab\(r\.browser, r\.page, \/web\\.telegram\\.org\|telegram\\.org\//.test(mainJs), 'src/main.js jumpToChat TG');

console.log('\n===== asar 内验证：' + pass + ' 通过 / ' + fail + ' 失败 =====');
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
