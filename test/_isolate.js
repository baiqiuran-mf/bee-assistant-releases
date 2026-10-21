/**
 * 测试数据隔离（所有 test/*.test.js 共用的第一行 require）
 *
 * 作用：把数据目录指到 .tmp-test-data/<测试文件名>，让每个测试文件
 * 用自己独立的临时库，绝不读写真实客户数据 data/assistant.db；
 * 同时把配置文件（config.yaml）也拷一份副本，写入只落在副本上。
 *
 * 必须放在其它 require('../src/...') 之前 —— src/paths.js 在 require 的
 * 那一刻就会解析数据目录，晚一步就来不及了。
 *
 * 🔴 2026-10-18 硬化（为什么改这一段）：
 *   以前清旧目录写成 try { rmSync(DIR) } catch (e) { /* 忽略 *\/ }，失败被静默吞掉。
 *   万一真删不掉（Windows 文件锁 / 被 safe-delete 之类的钩子拦下），测试会
 *   **沿用上一次留下的旧库**，结果取决于「上一次跑了什么」，而控制台一个字都不提。
 *   排查「两个人跑 run_all 却拿到两套数字」那次事故时，我被这句静默 catch
 *   误导过一轮。所以这里改成三条：
 *     1) 删完之后**复查目录是不是真没了**——force:true 也可能「不报错但也没删」；
 *     2) 真删不掉就**绝不复用脏目录**，换一个带时间戳的新目录，保证眼前一定是干净库；
 *     3) 两种情况都在 stderr 明确告警——失败不许再穿着成功的外衣溜过去。
 *
 * 用法：
 *   const { DIR } = require('./_isolate.js');
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP_ROOT = path.join(ROOT, '.tmp-test-data');
const rawName = path.basename(process.argv[1] || 'test', '.js') || 'test';
const NAME = rawName.replace(/[^\w.-]/g, '_');

/**
 * 删除前的**归属校验**：只允许删「自己造的那一棵临时目录」。
 *
 * 为什么必须先校验再删：rmSync 是 recursive+force 的，路径一旦算错就没有回头路
 * （真实客户数据 data/assistant.db 就躺在项目根下）。所以任何 wipeDir 之前，
 * 都必须先证明这个目录满足全部三条：
 *   1) 位于 .tmp-test-data/ 之内（含路径穿越检查，'..' 一律拒绝）；
 *   2) 不是 .tmp-test-data 根目录本身；
 *   3) 目录名属于本测试（NAME 或 NAME- 前缀的兜底目录）。
 * 任何一条不满足 → 直接抛错，**绝不执行删除**。
 *
 * @param {string} dir 打算删的目录
 * @returns {string} 通过校验的绝对路径
 * @throws {Error} 校验不通过时抛出（不删任何东西）
 */
function assertOwnedTmpDir(dir) {
  const resolved = path.resolve(dir);
  const rootResolved = path.resolve(TMP_ROOT);
  const rel = path.relative(rootResolved, resolved);
  const base = path.basename(resolved);
  const problems = [];
  if (!rel) problems.push('它就是 .tmp-test-data 根目录本身');
  else if (rel.startsWith('..') || path.isAbsolute(rel)) problems.push('它不在 .tmp-test-data 之内（疑似路径穿越）');
  if (base !== NAME && !base.startsWith(NAME + '-')) problems.push(`目录名 ${base} 不属于本测试（${NAME}）`);
  if (problems.length) {
    throw new Error(
      `拒绝删除 ${resolved}：${problems.join('；')}。\n` +
      `  测试只允许删自己在 ${TMP_ROOT} 下造出来的临时目录，绝不碰真实数据目录。`
    );
  }
  return resolved;
}

/**
 * 清掉一个目录，**如实**对待失败：删完复查是否真没了，不是不报错就当成功。
 *
 * 🔴 失败一律抛出可读错误（带上完整路径 + 原始 err.message），绝不静默吞掉：
 *   force:true 在 Windows 上可能「不报错、但也没删」（文件被别的进程占着），
 *   也有可能被环境层的删除钩子拦下（本次实测就撞上 safe-delete 的批量阈值）。
 *   这两种情况一旦静默，测试就会沿用上一轮的脏库，结果取决于「上一次跑了什么」。
 *
 * @param {string} dir 要清的目录（必须是本测试自己造的临时目录）
 * @returns {string} 已确认删除的绝对路径
 * @throws {Error} 校验不通过 / rmSync 抛异常 / 删完仍在，都抛出
 */
function wipeDir(dir) {
  const target = assertOwnedTmpDir(dir);   // 先证明「可以删」，再删
  if (!fs.existsSync(target)) return target;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    throw new Error(`删除临时目录失败：${target}\n  原始错误：${(e && e.message) || e}`);
  }
  // force:true 不保证真删掉：Windows 上文件被别的进程占着时是「不报错、也不删」。
  if (fs.existsSync(target)) {
    throw new Error(`删除临时目录失败：${target}\n  rmSync 没报错，但目录仍然在（多半被别的进程占着）。`);
  }
  return target;
}

/**
 * 给「删不掉的旧目录」准备的全新目录名：时间戳 + pid + 随机串，撞不上任何现存目录。
 * @param {string} base 原测试名
 * @returns {string}
 */
function uniqueName(base) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${base}-${Date.now()}-${process.pid}-${rand}`;
}

/**
 * 回收本测试以前留下的「兜底目录」，免得它们永远堆在 .tmp-test-data 里。
 * 只清理 ageMs 之前的，防止误删别的进程此刻正在用的那个。
 * @param {string} base 原测试名
 * @param {number} ageMs 只有比这更旧才回收（默认 2 小时）
 */
function sweepStale(base, ageMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(TMP_ROOT)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(TMP_ROOT)) {
      if (!entry.startsWith(base + '-')) continue; // 只认本测试名的兜底目录
      const full = path.join(TMP_ROOT, entry);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st || !st.isDirectory()) continue;
      if (now - st.mtimeMs < ageMs) continue; // 太新，可能是别人正在跑的，绝不碰
      wipeDir(full);
    }
  } catch (e) {
    // 回收失败不影响本次隔离成立 —— 但也不能装作没发生
    console.warn(`[_isolate] 回收旧临时目录失败（不影响本次运行）：${(e && e.message) || e}`);
  }
}

// 每次都从干净目录开始
const preferred = path.join(TMP_ROOT, NAME);

let DIR = preferred;
try {
  wipeDir(preferred);          // 删干净就继续用这个固定名字的目录
} catch (e) {
  // 🔴 删不干净就绝不复用脏目录 —— 换全新的，保证这次面对的一定是干净库。
  //    这条分支不再是「静默沿用旧库」，而是硬失败 + 换目录 + stderr 明确告警。
  DIR = path.join(TMP_ROOT, uniqueName(NAME));
  console.warn(
    `[_isolate] ⚠️  清不掉旧数据目录 ${NAME}\n` +
    `[_isolate]    原因：${(e && e.message) || e}\n` +
    `[_isolate]    已改用全新目录 ${path.basename(DIR)}，本次运行仍保证是干净库。\n` +
    `[_isolate]    这行若反复出现，说明有进程占着 ${preferred}，请查是谁没退出。`
  );
}
process.env.BEE_DATA_DIR = DIR;

try {
  fs.mkdirSync(DIR, { recursive: true });
} catch (e) {
  console.warn(`[_isolate] ⚠️  建不了数据目录 ${DIR}：${(e && e.message) || e}`);
}

/* 配置也要隔离：
 * 「AI 设置」会回写 config.yaml（填 baseUrl / apiKey）。测试里如果直接写真实的
 * config.yaml，跑一次测试就把你真实的 apiKey / 账号配置改掉了。
 * 这里给每个测试文件拷一份独立副本，所有写入都落在副本上。
 */
const CONFIG = path.join(DIR, 'config.yaml');
try {
  fs.copyFileSync(path.join(ROOT, 'config.yaml'), CONFIG);
} catch (e) {
  // 没有真实配置时不拦着测试跑，但必须说出来，别让后面的失败查不到根
  console.warn(`[_isolate] ⚠️  拷不了 config.yaml 副本：${(e && e.message) || e}`);
}
process.env.BEE_CONFIG = CONFIG;

// 兜底目录的堆积清理（只清本测试名、且 2 小时前的）
sweepStale(NAME);

module.exports = { DIR, NAME, CONFIG };
