/**
 * 首次运行准备（只对打包成 exe 之后有意义）
 *
 * 打包后程序本体在只读目录（甚至压在 app.asar 里），
 * 所以第一次启动要把「会变的文件」从程序目录复制一份到**用户可写目录**：
 *
 *   <用户目录>/
 *     config.yaml     ← 从程序自带那份复制，里面的 data/knowledge/sessions 路径改成绝对路径
 *     knowledge/      ← 人设/红线/范例等知识库，复制过去是为了让你能直接改
 *     data/           ← 数据库、客户档案、客户发来的图片
 *     sessions/       ← WhatsApp 登录态（扫码一次，之后免扫码）
 *
 * 已经存在的文件**一律不覆盖**（你改过的知识库不会被下次启动冲掉）。
 */

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 把配置里的三处相对路径，换成用户目录下的绝对路径。
 * 逐行改写而不是整段 YAML 重新序列化 —— 那样会把你写的中文注释全丢掉。
 */
function retargetConfig(text, home) {
  const want = {
    app: { dataDir: path.join(home, 'data') },
    browser: { sessionDir: path.join(home, 'sessions') },
    knowledge: { dir: path.join(home, 'knowledge') },
  };
  let section = '';
  const lines = String(text).split(/\r?\n/);
  const out = lines.map((line) => {
    const sec = /^([a-zA-Z_][\w-]*)\s*:\s*(#.*)?$/.exec(line);
    if (sec) { section = sec[1]; return line; }
    const kv = /^(\s+)([a-zA-Z_][\w-]*)(\s*:\s*)(.*)$/.exec(line);
    if (!kv) return line;
    const [, indent, key, sep, rawVal] = kv;
    const abs = want[section] && want[section][key];
    if (!abs) return line;
    const cm = rawVal.indexOf(' #');
    const comment = cm >= 0 ? ' ' + rawVal.slice(cm).trim() : '';
    const quoted = `'${String(abs).replace(/'/g, "''")}'`; // 单引号里反斜杠是字面量，正合适 Windows 路径
    return `${indent}${key}${sep}${quoted}${comment}`;
  });
  const joined = out.join('\n');
  return /\r\n/.test(text) ? joined.replace(/\n/g, '\r\n') : joined;
}

/**
 * 把 src 目录里「目标端还没有的」文件补过去（含子目录，一层层往下走）。
 * 已经存在的一律不动 —— 你改过的知识库不会被下次启动冲掉。
 * @returns {string[]} 这次补进去的相对路径
 */
function copyMissing(src, dst, prefix = '') {
  const copied = [];
  let entries = [];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (_) {
    return copied; // 源目录不存在就什么都不做
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      ensureDir(d);
      copied.push(...copyMissing(s, d, rel));
      continue;
    }
    if (fs.existsSync(d)) continue;
    try {
      ensureDir(path.dirname(d));
      fs.copyFileSync(s, d);
      copied.push(rel);
    } catch (_) { /* 单个文件复制失败不该拖垮启动 */ }
  }
  return copied;
}

/**
 * @param {string} home      用户可写目录（必填；为空表示没传，直接跳过）
 * @param {string} resources 程序自带资源目录（app.asar 根 / 项目根）
 * @returns {{home:string, config:string, knowledge:string[], dirs:string[]}}
 */
function prepareUserSpace(home, resources) {
  const rep = { home: home || '', config: 'skipped', knowledge: [], dirs: [] };
  if (!home || !resources) return rep;

  ensureDir(home);
  for (const sub of ['data', 'sessions', 'knowledge']) {
    ensureDir(path.join(home, sub));
    rep.dirs.push(sub);
  }

  // ---- 配置文件 ----
  const cfgDst = path.join(home, 'config.yaml');
  if (fs.existsSync(cfgDst)) {
    rep.config = 'exists';
  } else {
    const cfgSrc = path.join(resources, 'config.yaml');
    if (fs.existsSync(cfgSrc)) {
      fs.writeFileSync(cfgDst, retargetConfig(fs.readFileSync(cfgSrc, 'utf8'), home), 'utf8');
      rep.config = 'created';
    } else {
      rep.config = 'no-source';
    }
  }

  // ---- 知识库（含子目录；缺哪个补哪个，已存在的不用动）----
  rep.knowledge = copyMissing(path.join(resources, 'knowledge'), path.join(home, 'knowledge'));

  return rep;
}

module.exports = { prepareUserSpace, retargetConfig };
