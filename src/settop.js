'use strict';
/**
 * v2.5.1069：settop.exe（预编译 Win32 真置顶小工具，方案 C）的路径解析与参数构造。
 * 单独成模块，便于单测（纯逻辑、不依赖 Electron）。
 *
 * 路径：
 *   - 打包后：<resources>/app.asar.unpacked/bin/settop.exe（asarUnpack 解出来的，可被 spawn）
 *   - 开发态：项目根 bin/settop.exe
 */
const fs = require('fs');
const path = require('path');

function resolveSettopPath() {
  const cands = [];
  if (process.resourcesPath) {
    cands.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'settop.exe'));
  }
  cands.push(path.join(__dirname, '..', 'bin', 'settop.exe')); // 开发态：src/.. = 项目根
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0]; // 回退第一个，让报错信息能指出缺哪个
}

/**
 * 根据 opts 构造 settop.exe 的命令行参数；无有效目标时返回 null。
 * @param {{pid?:number, procName?:string, title?:string|string[], wait?:number}} opts
 *   - pid / procName / title：定位目标窗口（v2.5.1080 起可组合，例如 pid+title 一起传，
 *     既能精准锁定进程，又能按标题排除同进程的空白/黑屏窗）
 *   - title 支持字符串或字符串数组（数组 = 多个关键字 OR）
 *   - wait：找不到窗口时轮询等待毫秒（Signal 刚启动还没建窗口等场景）
 * @returns {string[]|null}
 */
function buildArgs(opts = {}) {
  const args = [];
  if (opts.pid) args.push('--pid', String(opts.pid));
  if (opts.procName) args.push('--proc', opts.procName);
  if (typeof opts.title === 'string' && opts.title) {
    args.push('--title', opts.title);
  } else if (Array.isArray(opts.title)) {
    for (const t of opts.title) if (t) args.push('--title', t);
  }
  if (args.length === 0) return null; // 无目标
  if (Number.isFinite(opts.wait) && opts.wait > 0) args.push('--wait', String(opts.wait));
  return args;
}

module.exports = { resolveSettopPath, buildArgs };
