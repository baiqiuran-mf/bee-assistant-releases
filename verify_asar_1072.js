'use strict';
/**
 * v2.5.1072 asar 内验证：源码过 ≠ 包内过。
 * 从打包产物 win-unpacked 的 app.asar 抽出关键文件，核对三件事：
 *   1) package.json 的 version === 2.5.1072
 *   2) src/main.js 含「forceTopmost 在 selectImTab/bringToFront 之前」的修复
 *   3) app.asar.unpacked/bin/settop.exe 体积 < 1MB（已替换 36.5MB .NET 旧版）
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const RES = path.join(ROOT, 'dist', 'win-unpacked', 'resources');
const ASAR = path.join(RES, 'app.asar');
const UNPK = path.join(RES, 'app.asar.unpacked', 'bin', 'settop.exe');

let failed = 0;
function check(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failed++;
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

if (!fs.existsSync(ASAR)) {
  console.error('找不到 app.asar：' + ASAR + '\n请先跑 `npm run pack:dir` 生成 win-unpacked。');
  process.exit(2);
}

const tmp = path.join(ROOT, '.verify_1072');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'), 'extractAll', ASAR, tmp], { stdio: 'pipe' });
} catch (e) {
  console.error('asar 解包失败：', e.message);
  process.exit(2);
}

// 1) version
const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
check('version === 2.5.1072', pkg.version === '2.5.1072', '实际 ' + pkg.version);

// 2) main.js 关键修复
const main = fs.readFileSync(path.join(tmp, 'src', 'main.js'), 'utf8');
// WA 分支：forceTopmost({pid}) 出现在 selectImTab(/web.whatsapp.com/) 之前
const waFt = main.indexOf("forceTopmost(pid ? { pid } : { title: 'WhatsApp' });");
const waSel = main.indexOf("selectImTab(found.browser, found.page, /web\\.whatsapp\\.com/");
check('WA: forceTopmost 在 selectImTab 之前', waFt > 0 && waSel > 0 && waFt < waSel, `forceTopmost@${waFt} < selectImTab@${waSel}`);
// TG 分支
const tgFt = main.indexOf("forceTopmost(pid ? { pid } : { title: 'WhatsApp' });");
const tgSel = main.indexOf("selectImTab(r.browser, r.page, /web\\.telegram\\.org|telegram\\.org/");
check('TG: forceTopmost 在 selectImTab 之前', tgFt > 0 && tgSel > 0 && tgFt < tgSel, `forceTopmost@${tgFt} < selectImTab@${tgSel}`);
// Signal 分支：新调用 wait:6000 + 旧错时机调用已删
const sigNew = main.indexOf("forceTopmost({ procName: 'Signal', wait: 6000 })");
const sigOld = main.indexOf("forceTopmost({ procName: 'Signal' })");
check('Signal: 新 wait:6000 调用存在', sigNew > 0, `@${sigNew}`);
check('Signal: 旧错时机调用已删除', sigOld < 0, sigOld < 0 ? '已无残留' : `@${sigOld} 仍存在(FAIL)`);

// 3) settop.exe 体积
if (fs.existsSync(UNPK)) {
  const sz = fs.statSync(UNPK).size;
  check('settop.exe 体积 < 1MB（已弃 36.5MB .NET 版）', sz < 1024 * 1024, `${(sz / 1024).toFixed(1)} KB`);
} else {
  check('settop.exe 在 app.asar.unpacked/bin/ 存在', false, '未找到 ' + UNPK);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n========== asar 内验证结果 ==========');
if (failed === 0) {
  console.log('全部通过 ✅ 包内已含 2.5.1072 修复。');
  process.exit(0);
} else {
  console.log(`有 ${failed} 项失败 ❌ 不应发布。`);
  process.exit(1);
}
