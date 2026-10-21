/**
 * pack.js — 单线版打包器（v2.6.1092起取代 pack-ab.js）
 *
 * 🔴 2026-10-13 老板拍板：取消 A / B 双版本，只保留一条线（MTProto 官方直连 =原 A 版）。
 *
 * 为什么取消：两个包的 appId 同为 com.beeassistant.app、productName 同为「蜜蜂信息采集」、
 * userData 同为 D:\蜜蜂采集数据\wa-assistant。NSIS 认作同一个程序 → 第二个包直接覆盖第一个；
 * 就算硬装两份，登录态 / SQLite / 板块文件也会互相污染。双版本在同一个 appId 下不可能共存。
 *
 * 用法：
 *   npm run pack          # 打安装包（打完自动自检，不通过即视为失败）
 *   node tools/pack.js          # 同上
 *   node tools/pack.js --skip-verify   # 只打包不抽 asar（排障用，不推荐）
 *
 * 🔴 本脚本继承 pack-ab.js 的两道防线，一行都没削弱：
 *   ① verifyAsar()        —— 抽产物 asar 实测所有相对 require，凡指向不存在的文件即失败
 *   ② assertBuildSection()—— 打包前后校验 package.json 的 build/scripts/devDependencies 完整
 * 这两道是真实事故换来的，绝不能因为「取消双版本」就一起删掉。
 *
 * ⚠️ 版号铁律：只在 package.json 的 version 定义一处，单线递增（2.6.1092 → 2.6.1093 → …）。
 *    不要再出现 2.6.0-A1091 这类预发布号 —— 2.6.0-A1091 在 semver 里**小于** 2.6.0，
 *    会让自动更新判成「降级」而拒绝升级。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const OUT_DIR = 'dist';

function log(s) { console.log(`[pack] ${s}`); }
function readPkg() { return JSON.parse(fs.readFileSync(PKG, 'utf8')); }
function writePkg(p) { fs.writeFileSync(PKG, JSON.stringify(p, null, 2) + '\n', 'utf8'); }

/**
 * 🔴 build 段完整性校验
 *
 * 真实事故：electron-builder 打包会把工作区 package.json 的 build / scripts /
 * devDependencies 整段剥掉（旧脚本只还原 version 和 build.files，等于没还原）。
 * 结果下一次跑打包脚本第一行就报 `Cannot read properties of undefined (reading 'files')`，
 * 一个包都出不来。build 段缺失还会连带让 app-update.yml 不生成 → 自动更新彻底失效。
 */
function assertBuildSection(pkg, when) {
  const b = pkg.build;
  const problems = [];
  if (!b) problems.push('build 段缺失');
  else {
    if (!Array.isArray(b.files) || !b.files.length) problems.push('build.files 为空');
    if (!b.directories || !b.directories.output) problems.push('build.directories.output 缺失');
    if (!b.nsis || b.nsis.artifactName !== 'wa-assistant-setup-${version}.${ext}') {
      problems.push('build.nsis.artifactName 不是英文规范名');
    }
    if (!Array.isArray(b.publish) || !b.publish.length) problems.push('build.publish 缺失（会导致自动更新失效）');
    if (!b.productName) problems.push('build.productName 缺失');
  }
  if (!pkg.scripts || !pkg.scripts.test) problems.push('scripts 段缺失');
  if (!pkg.devDependencies || !pkg.devDependencies['electron-builder']) {
    problems.push('devDependencies 缺失');
  }
  if (problems.length) {
    log(`✗ ${when} 校验不通过：${problems.join(' / ')}`);
    log('  package.json 被 electron-builder 剥掉了？用 git show HEAD:package.json 恢复。');
    process.exit(2);
  }
}

/**
 * 🔴 产物自检门禁（抽 asar 实测，不靠人记得检查）
 *
 * 背景：真实事故 —— B 包排除了 src/telegramOfficialChannel.js，但 main.js 顶层
 * 还在无条件 require('./telegramOfficialChannel')，装到用户机器上一启动就抛
 *「Cannot find module './telegramOfficialChannel' · 桌面窗口没能打开」，整个软件起不来。
 *
 * 光靠「源码里写了 safeRequire」是不够的：任何人以后新增一处 require 都会重犯。
 * 所以这里在打包后**自动抽 asar 实测**：把产物里所有 `require('./xxx')` 逐个解析到真实
 * 文件，凡指向不存在的文件 → 直接抛错、打包视为失败。
 *
 * 单线 A 版自检项：
 *   ① telegramOfficialChannel.js 必须在（走A 通道没它就是废包）
 *   ② telegramChannel.js 必须在，且里面的 CHANNEL 恒为 'A'（防止有人改回环境变量分流）
 *   ③ 所有相对 require 都能解析到真实文件
 *   ④ 产物版本号 == package.json 的 version
 */
function verifyAsar(targetVersion) {
  const asarPath = path.join(ROOT, OUT_DIR, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    log(`✗ 自检失败：找不到产物 ${asarPath}`);
    process.exit(2);
  }
  // 旧自检目录可能清不掉（安全删除钩子 / 文件占用）→ 换个新目录名，照样能抽包自检
  let tmp = path.join(ROOT, '.tmp-verify');
  if (fs.existsSync(tmp)) tmp = path.join(ROOT, `.tmp-verify-${Date.now()}`);
  try {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'),
       'extract', asarPath, tmp],
      { cwd: ROOT, stdio: 'pipe' }
    );

    // ① 官方直连模块必须在
    const offPath = path.join(tmp, 'src', 'telegramOfficialChannel.js');
    if (!fs.existsSync(offPath)) {
      log('✗ 自检失败：产物里没有 src/telegramOfficialChannel.js（单线版走MTProto，没它就是废包）');
      process.exit(2);
    }

    // ② 通道常量必须锁死 A
    const chPath = path.join(tmp, 'src', 'telegramChannel.js');
    if (!fs.existsSync(chPath)) {
      log('✗ 自检失败：产物里没有 src/telegramChannel.js');
      process.exit(2);
    }
    const chSrc = fs.readFileSync(chPath, 'utf8');
    // 只匹配「真实读取环境变量」的写法，不匹配注释里提到变量名的说明文字
    if (/process\.env\.BEE_TG_CHANNEL/.test(chSrc)) {
      log('✗ 自检失败：telegramChannel.js 里还在读 process.env.BEE_TG_CHANNEL（双版本已取消，通道必须锁死）');
      process.exit(2);
    }
    const ch = require(path.join(tmp, 'src', 'telegramChannel.js'));
    if (ch.CHANNEL !== 'A' || ch.IS_A !== true || ch.IS_B !== false) {
      log(`✗ 自检失败：通道不是锁死 A（CHANNEL=${ch.CHANNEL} IS_A=${ch.IS_A} IS_B=${ch.IS_B}）`);
      process.exit(2);
    }
    log(`  通道自检 OK：CHANNEL=${ch.CHANNEL}（MTProto 官方直连，无环境变量分流）`);

    // ③ 遍历产物里所有 js，解析每个相对 require，指向不存在的即失败
    const missing = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) { if (name !== 'node_modules') walk(full); continue; }
        if (!name.endsWith('.js')) continue;
        const src = fs.readFileSync(full, 'utf8');
        const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
        let m;
        while ((m = re.exec(src))) {
          const target = path.resolve(path.dirname(full), m[1]);
          const ok = ['', '.js', '.json', '.node'].some((ext) => fs.existsSync(target + ext))
            || fs.existsSync(path.join(target, 'index.js'));
          if (!ok) missing.push(`${path.relative(tmp, full)} → ${m[1]}`);
        }
      }
    };
    walk(tmp);
    if (missing.length) {
      log(`✗ 自检失败：产物里有 ${missing.length} 处 require 指向不存在的文件（会导致启动崩溃）：`);
      for (const x of missing.slice(0, 20)) log(`    ${x}`);
      process.exit(2);
    }

    // ④ 版本号必须一致
    const v = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')).version;
    if (v !== targetVersion) {
      log(`✗ 自检失败：产物版本号 ${v} ≠ 目标 ${targetVersion}`);
      process.exit(2);
    }

    // ⑤ latest.yml 必须存在且指向本版安装包（自动更新链路）
    const ymlPath = path.join(ROOT, OUT_DIR, 'latest.yml');
    if (!fs.existsSync(ymlPath)) {
      log('✗ 自检失败：没有生成 dist/latest.yml（自动更新会彻底失效）');
      process.exit(2);
    }
    const yml = fs.readFileSync(ymlPath, 'utf8');
    if (!yml.includes(`wa-assistant-setup-${targetVersion}.exe`)) {
      log('✗ 自检失败：latest.yml 没有指向本版安装包');
      process.exit(2);
    }
    const exePath = path.join(ROOT, OUT_DIR, `wa-assistant-setup-${targetVersion}.exe`);
    if (!fs.existsSync(exePath)) {
      log(`✗ 自检失败：没有生成安装包 ${exePath}`);
      process.exit(2);
    }

    log(`  自检通过：无缺失 require · 通道锁死 A · 版本 ${v} · latest.yml 指向正确`);
  } finally {
    // 清理失败不许让打包失败（系统可能有文件占用 / 安全删除钩子拦截）。
    // 残留的 .tmp-verify* 目录不影响产物，下次打包会覆盖。
    try { fs.rmSync(tmp, { recursive: true, force: true }); }
    catch (e) { log('  （临时自检目录未能自动清理，可稍后手动删除，不影响安装包）'); }
  }
}

function main() {
  const skipVerify = process.argv.includes('--skip-verify');
  const pkg = readPkg();
  assertBuildSection(pkg, '打包前');
  const version = pkg.version;
  const origBuild = JSON.parse(JSON.stringify(pkg.build));
  const origScripts = JSON.parse(JSON.stringify(pkg.scripts));
  const origDevDeps = JSON.parse(JSON.stringify(pkg.devDependencies));
  const origComments = {};
  for (const k of Object.keys(pkg)) if (k.startsWith('_comment')) origComments[k] = pkg[k];

  log(`===== 开始打包（版号 ${version}，输出 ${OUT_DIR}） =====`);
  try {
    const exe = path.join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd');
    execFileSync(exe, ['--win', '--x64'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE
          || 'E:/WorkBuddy-Projects/_builder-cache',
      },
    });
    log(`打包完成 → ${OUT_DIR}/wa-assistant-setup-${version}.exe`);

    if (skipVerify) {
      log('⚠ 已跳过 asar 自检（--skip-verify）');
    } else {
      verifyAsar(version);
    }
  } catch (e) {
    log(`打包失败：${(e && e.message) || e}`);
    process.exitCode = 1;
  } finally {
    // 🔴 还原源码：整段还原 build / scripts / devDependencies / _comment*。
    // 只还原 version + build.files 等于没还原 —— electron-builder 会把整个 build 段剥掉。
    const back = readPkg();
    back.version = version;
    if (origBuild) back.build = origBuild;
    if (origScripts) back.scripts = origScripts;
    if (origDevDeps) back.devDependencies = origDevDeps;
    for (const k of Object.keys(origComments)) back[k] = origComments[k];
    writePkg(back);
    assertBuildSection(back, '打包后还原');
    log(`已完整还原 package.json（version=${version}，build/scripts/devDependencies 齐全）`);
  }
}

main();
