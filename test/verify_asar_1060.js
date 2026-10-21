/**
 * v2.5.1085 asar 内验证
 * 目的：确认 Tele① 应用版（原生会话列表 + 气泡面板，MTProto 落库）的改动真的打进了 NSIS 安装包内的 app.asar，
 *       而不是只改了源码（源码过了 ≠ 包内过了，这是老板定的铁律）。
 * 用法：node --experimental-sqlite test/verify_asar_1060.js
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

// 1) 定位 app.asar：优先 win-unpacked/resources/app.asar
const candidates = [
  path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar'),
  path.join(ROOT, 'dist', 'resources', 'app.asar'),
];
let asarPath = candidates.find(p => fs.existsSync(p));
if (!asarPath) {
  console.log('找不到 app.asar，候选路径：\n' + candidates.join('\n'));
  console.log('\n===== asar 验证：0 通过 / 1 失败（未找到 app.asar，先确认打包已成功） =====');
  process.exit(1);
}
console.log('asar 位置：' + asarPath);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-verify-'));
asar.extractAll(asarPath, tmp);
console.log('已解包到：' + tmp + '\n');

// 2) 版本号
const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
check('包内 package.json 版本号 = 2.5.1085', pkg.version === '2.5.1085', 'version=' + pkg.version);

// 3) Tele① 应用版原生 UI（v2.5.1085）：会话列表 + 气泡面板，替代旧 webview
const html = fs.readFileSync(path.join(tmp, 'public', 'index.html'), 'utf8');
check('Tele① 原生会话列表 #tg-list 在包内', /id="tg-list"/.test(html), 'public/index.html');
check('Tele① 对话正文 #tg-conv-body 在包内', /id="tg-conv-body"/.test(html), 'public/index.html');
check('Tele① 列表刷新按钮 #btn-tg-list-refresh 在包内', /id="btn-tg-list-refresh"/.test(html), 'public/index.html');
check('Tele① 对话刷新按钮 #btn-tg-conv-refresh 在包内', /id="btn-tg-conv-refresh"/.test(html), 'public/index.html');
check('Tele① 不再有 webview 内嵌浏览器', !/id="tg-webview"/.test(html), 'public/index.html');

// 4) app.js 原生函数齐全、旧 webview 函数已清
const appJs = fs.readFileSync(path.join(tmp, 'public', 'app.js'), 'utf8');
check('app.js 原生 Tele① 函数齐全（loadTgConversations/renderTgConvList/selectTgConv/loadTgChat/renderTgChat/onTelegramMessageLive）',
  /function loadTgConversations/.test(appJs) && /function renderTgConvList/.test(appJs)
  && /function selectTgConv/.test(appJs) && /function loadTgChat/.test(appJs)
  && /function renderTgChat/.test(appJs) && /function onTelegramMessageLive/.test(appJs), 'public/app.js');
check('app.js 旧 webview 函数已清除（tgGoto/initTgAddrBar/loadTgWebview/tgwProbe/tgwPages/setTgWebviewProxy 都不在）',
  !/function tgGoto/.test(appJs) && !/function initTgAddrBar/.test(appJs)
  && !/function loadTgWebview/.test(appJs) && !/async function tgwProbe/.test(appJs)
  && !/async function tgwPages/.test(appJs) && !/function setTgWebviewProxy/.test(appJs), 'public/app.js');

// 5) 后端接口与 DB 落点
const srv = fs.readFileSync(path.join(tmp, 'src', 'server.js'), 'utf8');
check('server.js 暴露 /api/telegram/conversations 与 /api/telegram/messages',
  /api\/telegram\/conversations/.test(srv) && /api\/telegram\/messages/.test(srv), 'src/server.js');
const dbjs = fs.readFileSync(path.join(tmp, 'src', 'db.js'), 'utf8');
check('db.js 有 tgConversations / tgMessages',
  /function tgConversations/.test(dbjs) && /function tgMessages/.test(dbjs), 'src/db.js');

// 6) 铁律：绝无自动发送
check('铁律：前端不调任何发送', !/\.sendMessage/.test(appJs) && !/function tgGoto/.test(appJs), 'public/app.js');

console.log('\n===== asar 内验证：' + pass + ' 通过 / ' + fail + ' 失败 =====');
if (fail) {
  console.log('失败项：\n - ' + fails.join('\n - '));
  process.exit(1);
}
process.exit(0);
