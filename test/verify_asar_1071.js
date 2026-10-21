'use strict';
// v2.5.1071 asar 内验证：确认「窗口切换 + 停着」修复真的进了安装包
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const ROOT = path.join(__dirname, '..');
const appAsar = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
const unpackedExe = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'bin', 'settop.exe');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); fail++; }
}

if (!fs.existsSync(appAsar)) {
  console.error('找不到 app.asar：' + appAsar);
  process.exit(1);
}

// 1) 包内 package.json 版本号
const pkgRaw = asar.extractFile(appAsar, 'package.json').toString('utf8');
const pkg = JSON.parse(pkgRaw);
check('包内 version = 2.5.1071', pkg.version === '2.5.1071', '实际=' + pkg.version);

// 2) 包内 src/main.js 含"窗口切换 + 停着 + 诊断日志"关键标记
const main = asar.extractFile(appAsar, 'src/main.js').toString('utf8');
check('src/main.js 含 forceTopmost 定义', main.includes('async function forceTopmost(opts'));
check('src/main.js 含 ensureSignalLaunched（Signal ②拉起）', main.includes('async function ensureSignalLaunched()'));
check('src/main.js 含 isSilent（静默锁）', main.includes('isSilent()'));
check('src/main.js 引入 ./silence', main.includes("require('./silence')"));
check('src/main.js 引入 ./settop', main.includes("require('./settop')"));
check('src/main.js 含 forceTopmost({ procName: \'Signal\' })', main.includes("forceTopmost({ procName: 'Signal' })"));
check('src/main.js ensureTelegram 尊重静默锁', main.includes('if (isSilent())'));
check('src/main.js 含 getBrowserPid（真实 pid 取 __chromeChild）', main.includes('function getBrowserPid(') && main.includes('__chromeChild'));
check('src/main.js WA 跳转用 getBrowserPid', main.includes('const pid = getBrowserPid(found.browser)'));
check('src/main.js TG 跳转用 getBrowserPid', main.includes('const pid = getBrowserPid(r.browser)'));
check('src/main.js 诊断日志 _logSettop', main.includes('function _logSettop('));
check('src/main.js 写 settop_debug.log', main.includes('settop_debug.log'));

// 3) 包内新增纯逻辑模块
let hasSilence = false, hasSettop = false;
try { asar.extractFile(appAsar, 'src/silence.js'); hasSilence = true; } catch (e) {}
try { asar.extractFile(appAsar, 'src/settop.js'); hasSettop = true; } catch (e) {}
check('src/silence.js 在包内', hasSilence);
check('src/settop.js 在包内', hasSettop);

// 4) 包内 CHANGELOG 顶部为 2.5.1071（窗口切换修复）
const cl = asar.extractFile(appAsar, 'CHANGELOG.md').toString('utf8');
check('CHANGELOG.md 顶部含 ## 2.5.1071', cl.includes('## 2.5.1071'));

// 5) 原生 exe 正确 unpack 到 app.asar.unpacked/bin/settop.exe
check('app.asar.unpacked/bin/settop.exe 存在', fs.existsSync(unpackedExe));
if (fs.existsSync(unpackedExe)) {
  const sz = fs.statSync(unpackedExe).size;
  check('settop.exe 体积合理（>30MB self-contained）', sz > 30 * 1024 * 1024, '字节=' + sz);
}

console.log('\n========== asar 内验证 2.5.1071：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
process.exit(fail ? 1 : 0);
