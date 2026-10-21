/**
 * 统一路径解析（蜜蜂信息采集）
 *
 * 数据根目录优先级：
 *   1) 环境变量 BEE_DATA_DIR      —— 测试/临时实例用，指向隔离目录
 *   2) config.yaml 的 app.dataDir —— 你可以在配置里改数据存放位置
 *   3) <项目>/data                —— 默认
 *
 * 为什么要这个文件：
 *   以前 db.js 把数据库路径写死在 <项目>/data 下，导致自动化测试只能"先备份
 *   真实 data 再跑、跑完还原"。一旦还原失败，真实客户数据就被测试数据污染了。
 *   现在测试只要设一个 BEE_DATA_DIR 指向临时目录，就可以完全不碰真实数据。
 *
 * 全部为绝对路径，方便在说明书里直接写给用户。
 */

const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');

const ROOT = path.join(__dirname, '..');

/**
 * 配置文件路径。
 *
 * 优先级：环境变量 BEE_CONFIG > <项目>/config.yaml
 *
 * 为什么要能改：界面上有「AI 设置」会**回写 config.yaml**（填 baseUrl / apiKey）。
 * 自动化测试必须把写操作引到临时文件上，否则跑一次测试就会把你真实的
 * apiKey / 账号配置改掉。测试里设 BEE_CONFIG 即可完全隔离。
 *
 * 打包成 exe 之后，配置不能写回程序目录（只读），因此落到「用户数据目录」：
 *   便携版 = exe 所在目录；安装版 = %APPDATA%\蜜蜂信息采集
 * 详见 src/runtime.js。开发模式仍然是项目根的 config.yaml。
 */
function configFile() {
  const env = process.env.BEE_CONFIG;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  const home = runtime.homeDir();
  if (home) return path.join(home, 'config.yaml');
  return path.join(ROOT, 'config.yaml');
}

function resolveDataRoot() {
  if (process.env.BEE_DATA_DIR && String(process.env.BEE_DATA_DIR).trim()) {
    return path.resolve(String(process.env.BEE_DATA_DIR).trim());
  }
  // 相对路径的基准：打包后是可写的用户目录，开发时是项目根
  const BASE = runtime.dataBase();
  // 读 config.yaml 的 app.dataDir（读不到就退回默认，不影响主流程）
  try {
    const cfgFile = configFile();
    if (fs.existsSync(cfgFile)) {
      let yaml;
      try { yaml = require('js-yaml'); } catch (e) { yaml = require('./yaml-lite'); }
      const cfg = yaml.load(fs.readFileSync(cfgFile, 'utf8')) || {};
      const dir = cfg.app && cfg.app.dataDir;
      if (dir) return path.resolve(BASE, dir);
    }
  } catch (e) { /* 配置坏了也不该在这里崩 */ }
  return path.join(BASE, 'data');
}

function ensure(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DATA_ROOT = resolveDataRoot();
ensure(DATA_ROOT);

module.exports = {
  ROOT,
  DATA_ROOT,
  DB_FILE: path.join(DATA_ROOT, 'assistant.db'),
  /** config.yaml 的路径（测试可用 BEE_CONFIG 指向临时副本） */
  configFile,
  /** 每个客户一个 .md 档案的目录 */
  docsDir: () => ensure(path.join(DATA_ROOT, 'customers')),
  /** 客户发来的图片/语音等媒体目录 */
  mediaDir: () => ensure(path.join(DATA_ROOT, 'media')),
  ensure,
};
