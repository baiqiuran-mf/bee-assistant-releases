/**
 * 找用来登录 WhatsApp 网页版的浏览器可执行文件
 *
 * 为什么要单独一趟：
 *   软件用 Puppeteer 起一个 Chromium 打开 WhatsApp 网页版。Puppeteer 默认用自己下载的
 *   Chromium（放在系统用户目录 ~/.cache/puppeteer），软件开发时这份缓存一直在，所以从来没出过事。
 *   但打包成 exe 以后，目标电脑上**不一定有这份缓存**（也不会自动下载），一登录就炸。
 *   所以这里排一条兜底链：配置指定 → Puppeteer 自带 Chromium → 本机 Chrome → 本机 Edge。
 *   绝大多数 Windows 电脑都有 Edge，走到最后一步基本一定能用。
 *
 * 纯函数式，不联网、不启动进程，方便在测试里直接断言。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Puppeteer 下载缓存的可能位置（不同系统 / 不同 PUPPETEER_CACHE_DIR 都列上） */
function puppeteerRoots(opt = {}) {
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };
  if (opt.cacheDir) push(path.resolve(String(opt.cacheDir)));
  if (process.env.PUPPETEER_CACHE_DIR) push(path.resolve(String(process.env.PUPPETEER_CACHE_DIR)));
  push(path.join(os.homedir(), '.cache', 'puppeteer'));
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) push(path.join(local, 'puppeteer'));
  }
  return roots;
}

/** 一个 Chromium 版本目录里，可执行文件叫什么 */
function chromeBinIn(versionDir) {
  if (process.platform === 'win32') {
    return [path.join(versionDir, 'chrome-win64', 'chrome.exe'), path.join(versionDir, 'chrome-win32', 'chrome.exe')];
  }
  if (process.platform === 'darwin') {
    return [
      path.join(versionDir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(versionDir, 'chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
  }
  return [path.join(versionDir, 'chrome-linux64', 'chrome'), path.join(versionDir, 'chrome-linux', 'chrome')];
}

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch (_) { return []; }
}

/** Puppeteer 缓存里已下载的各种 Chromium（新版本优先） */
function puppeteerChromes(opt = {}) {
  const found = [];
  for (const root of puppeteerRoots(opt)) {
    for (const sub of ['chrome', 'chrome-headless-shell']) {
      const base = path.join(root, sub);
      const versions = listDirs(base).sort().reverse(); // 版本号目录，倒序=新的在前
      for (const v of versions) {
        for (const bin of chromeBinIn(path.join(base, v))) found.push(bin);
      }
    }
  }
  return found;
}

/** 系统里常规安装的浏览器（Windows 以 Edge/Chrome 为主） */
function systemBrowsers() {
  const list = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA;
    list.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return list;
}

function firstExisting(files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) return f; } catch (_) { /* 继续 */ }
  }
  return null;
}

/**
 * 解析浏览器可执行文件绝对路径
 * @param {object} opt
 *   explicit  string  —— 用户在 config.yaml 的 browser.executablePath 里写死的；写了就直接用它
 *   cacheDir  string  —— Puppeteer 缓存目录（测试可注入）
 * @returns {string|null} 找不到返回 null（Puppeteer 会尝试自己下载）
 */
function resolveExecutable(opt = {}) {
  if (opt.explicit && String(opt.explicit).trim()) return String(opt.explicit).trim();
  return firstExisting([...puppeteerChromes(opt), ...systemBrowsers()]);
}

/**
 * 解析「标准版」浏览器（不带 Chrome-for-Testing 那个测试提示）。
 * 优先本机装的 Chrome / Edge（正常自动更新版），找不到才退回 Puppeteer 自带的 CfT。
 * 用于 Telegram 网页版这种「给人用的窗口」—— 不希望弹出
 * "Chrome for Testing ... is only for automated testing" 的提示。
 */
function resolveStandardExecutable(opt = {}) {
  if (opt.explicit && String(opt.explicit).trim()) return String(opt.explicit).trim();
  return firstExisting([...systemBrowsers(), ...puppeteerChromes(opt)]);
}

module.exports = { resolveExecutable, resolveStandardExecutable, puppeteerChromes, systemBrowsers, firstExisting };
