/**
 * 运行环境判定：开发模式 vs 打包后的 exe
 *
 * 为什么要区分：
 *   软件打包安装到 C:\Program Files\... 以后，程序自身所在目录是**只读**的
 *   （界面、源码还被压在 app.asar 里），往这里写 config.yaml、写数据库一定会失败。
 *   所以打包版必须把「会变的东西」放到一个**可写目录**：
 *     便携版（portable exe） → exe 所在的那个文件夹
 *     安装版（NSIS）         → %APPDATA%\蜜蜂信息采集
 *   开发模式（electron . / node src/main.js）完全不变，还是用项目目录。
 *
 * 只在 Electron 主进程里生效：纯 Node 环境（跑测试）里 require('electron')
 * 拿回来的是一个字符串路径，因此一律走开发分支，测试行为不受影响。
 */

const path = require('path');

/** 取 Electron 的 app 对象；不在 Electron 主进程里时返回 null */
function electronMainApp() {
  try {
    const e = require('electron');
    const a = e && typeof e === 'object' ? e.app : null;
    return a && typeof a.getPath === 'function' ? a : null;
  } catch (_) {
    return null;
  }
}

let cached;
let cachedSet = false;

/**
 * 用户数据目录（可写）。
 * 开发模式返回 null —— 调用方看到 null 就继续用项目目录，行为与以前完全一致。
 */
function homeDir() {
  if (cachedSet) return cached;
  let home = null;
  const env = process.env.BEE_HOME;
  if (env && String(env).trim()) {
    home = path.resolve(String(env).trim());
  } else {
    const a = electronMainApp();
    if (a && a.isPackaged) {
      const portable = process.env.PORTABLE_EXECUTABLE_DIR;
      if (portable && String(portable).trim()) {
        home = path.resolve(String(portable).trim()); // 便携版：exe 所在目录
      } else {
        try { home = a.getPath('userData'); } catch (_) { home = null; } // 安装版：%APPDATA%\蜜蜂信息采集
      }
    }
  }
  cached = home;
  cachedSet = true;
  return home;
}

/** 程序自带资源所在目录（开发=项目根，打包=app.asar 根）。只读，别往这写。 */
const RESOURCE_ROOT = path.join(__dirname, '..');

/** 是否跑在打包后的 exe 里 */
function isPackaged() {
  return !!homeDir();
}

/** 找「应该可写的那类文件」时的基准目录：打包后是用户目录，开发时是项目根 */
function dataBase() {
  return homeDir() || RESOURCE_ROOT;
}

module.exports = {
  homeDir,
  isPackaged,
  dataBase,
  RESOURCE_ROOT,
  /** 测试专用：清掉缓存，方便在同一个进程里切换环境 */
  _reset() { cached = null; cachedSet = false; },
};
