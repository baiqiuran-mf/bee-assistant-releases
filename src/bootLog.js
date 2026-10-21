/**
 * 启动自检日志（v2.6.1106）
 *
 * 只管一件事：**把软件从「双击 exe」到「窗口出来」的每一步，同步写进一个日志文件。**
 * 不采集、不发网络、不碰任何业务逻辑。
 *
 * 为什么要有这个模块：
 *   2026-10-14 老板把 2.6.1100 发到别的电脑安装，装完双击就闪退。
 *   排查时最大的障碍是「不知道它死在哪一步」—— 本机一切正常，只能靠猜。
 *   有了这份日志，对方只要把文件发回来，就能一眼看到最后一行停在哪。
 *
 * 🔴 两条硬性设计（都是被闪退这件事逼出来的）：
 *   1) **同步写**（fs.appendFileSync）。闪退时进程可能立刻消失，
 *      异步的 write 还在队列里就随进程一起没了 —— 那样日志等于没写。
 *   2) **尽可能早地启用**。main.js 要在 require 任何重依赖（sharp 之类原生模块）之前
 *      就调 bootLog.init()，否则原生模块一加载失败，日志还来不及建文件。
 *
 * 日志落点：
 *   打包安装版 → 用户数据目录 / logs / boot-<日期>-<时间>.log（例如 %APPDATA%\蜜蜂信息采集\logs\）
 *   便携版      → exe 所在目录 / logs /
 *   开发模式    → 项目根 / data / logs /
 *   全都拿不到  → 系统临时目录（保证极端情况下也留得下点东西）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 只保留最近这么多份日志，防止无限堆积占满磁盘 */
const MAX_FILES = 20;

let dir = null;
let file = null;
let seq = 0;
let startedAt = 0;

/** 挑一个「大概率能写」的目录；都写不了就退回系统临时目录 */
function pickDir() {
  const candidates = [];
  try {
    const runtime = require('./runtime');
    const home = runtime.homeDir();
    if (home) candidates.push(path.join(home, 'logs'));
  } catch (e) { /* runtime 还没就绪也不该拖垮日志 */ }
  candidates.push(path.join(os.tmpdir(), 'bee-boot-logs'));
  return candidates;
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function localTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/** 同步写一行；写不进去就静默放弃（日志本身绝不能导致软件崩溃） */
function write(line) {
  if (!file) return;
  try {
    fs.appendFileSync(file, line + '\n');
  } catch (e) { /* 磁盘满 / 目录只读 —— 认了，不影响主流程 */ }
}

/** 清掉超出数量的旧日志，只留最近 MAX_FILES 份 */
function rotate(dirPath) {
  try {
    const names = fs.readdirSync(dirPath)
      .filter((n) => /^boot-.*\.log$/.test(n))
      .sort();
    while (names.length > MAX_FILES) {
      const old = names.shift();
      try { fs.unlinkSync(path.join(dirPath, old)); } catch (e) { /* 删不掉就算了 */ }
    }
  } catch (e) { /* 目录读不了不影响 */ }
}

/**
 * 启用日志。可以重复调用，第二次起直接忽略。
 * @param {object} [meta] 额外写进文件头的说明（比如应用版本）
 * @returns {string|null} 日志文件路径
 */
function init(meta) {
  if (file) return file;
  startedAt = Date.now();
  for (const d of pickDir()) {
    try {
      fs.mkdirSync(d, { recursive: true });
      // 试探性写一次，确认这个目录真的可写
      const probe = path.join(d, '.write-probe');
      fs.writeFileSync(probe, '1');
      fs.unlinkSync(probe);
      dir = d;
      break;
    } catch (e) { /* 换下一个候选目录 */ }
  }
  if (!dir) return null;

  file = path.join(dir, 'boot-' + stamp(new Date()) + '.log');
  rotate(dir);

  write('================ 蜜蜂信息采集 · 启动自检日志 ================');
  write('时间：' + new Date().toLocaleString());
  if (meta && typeof meta === 'object') {
    for (const k of Object.keys(meta)) write(String(k) + '：' + String(meta[k]));
  }
  write('日志文件：' + file);
  write('------------------------------------------------------------');
  return file;
}

/**
 * 记一步。这是日志的主体，每一步都要留痕。
 * @param {string} label 这一步在干什么
 * @param {string} [detail] 补充信息（路径、版本号之类）
 */
function step(label, detail) {
  seq += 1;
  const ms = String(Date.now() - startedAt).padStart(6, ' ');
  write('[' + localTime() + ' +' + ms + 'ms] #' + String(seq).padStart(2, '0') + ' ' + label
    + (detail ? '  →  ' + detail : ''));
}

/**
 * 记一个「出错但还在继续」的情况。
 * @param {string} label
 * @param {*} err
 */
function warn(label, err) {
  const msg = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  write('[!] 警告 · ' + label + '：' + String(msg).split('\n').slice(0, 6).join('\n    '));
}

/**
 * 记一个致命错误（紧接着进程多半就要退出了）。
 * @param {string} label
 * @param {*} err
 */
function fail(label, err) {
  const msg = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  write('============================================================');
  write('【致命】' + label + '：');
  write(String(msg));
  write('============================================================');
  /* eslint-disable no-console */
  console.error('[启动日志] ' + label + '：', msg);
}

/**
 * 挂上全局兜底：未捕获异常、未处理的 Promise 拒绝，一律先落盘再走原逻辑。
 * 这一步是「闪退可诊断」的关键 —— 很多时候闪退就是这两个钩子吃掉的。
 */
function installCrashHooks() {
  process.on('uncaughtException', (err) => {
    fail('未捕获异常（uncaughtException）', err);
  });
  process.on('unhandledRejection', (reason) => {
    fail('未处理的 Promise 拒绝（unhandledRejection）', reason);
  });
}

/** 把一批「环境事实」一次性写进日志（排查闪退时最想看的几行） */
function logEnv(extra) {
  try {
    write('--- 运行环境 ---');
    write('操作系统：' + os.type() + ' ' + os.release() + '（' + os.arch() + '）');
    const totalMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMB = Math.round(os.freemem() / 1024 / 1024);
    write('内存：共 ' + totalMB + ' MB，当前可用 ' + freeMB + ' MB');
    write('CPU：' + (os.cpus()[0] ? os.cpus()[0].model : '未知') + '（' + os.cpus().length + ' 核）');
    write('主机名：' + os.hostname());
    write('Node：' + process.version);
    write('进程位数：' + (process.arch || '未知'));
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) write(String(k) + '：' + String(extra[k]));
    }
    write('----------------');
  } catch (e) { /* 环境信息取不到也无所谓 */ }
}

/** 日志文件路径（没启用就是 null）。给界面/排障脚本用。 */
function logPath() {
  return file;
}

/** 日志目录（没启用就是 null） */
function logDir() {
  return dir;
}

module.exports = {
  init,
  step,
  warn,
  fail,
  installCrashHooks,
  logEnv,
  logPath,
  logDir,
};
