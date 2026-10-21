/**
 * 按行改写 config.yaml（蜜蜂信息采集）
 *
 * 为什么不用 js-yaml 重新序列化整个文件：
 *   config.yaml 里有大量中文注释（每个字段是干什么的、怎么填），
 *   用 yaml.dump() 会把注释全部丢掉，你下次打开配置就再也看不懂了。
 *   所以这里只做「定位到某一行 → 只替换那个值」，其余一个字节都不动。
 *
 * 用法：
 *   const { setScalar, saveAiConfig } = require('./configWrite');
 *   setScalar(text, ['ai','providers','deepseek','apiKey'], 'sk-xxx')
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

/* ---------------- 工具 ---------------- */

function indentOf(line) {
  const m = /^[ ]*/.exec(line);
  return m ? m[0].length : 0;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 这一行是不是 `key:` 或 `- key:`（只看键，不看值） */
function isKeyLine(text, key) {
  return new RegExp(`^(?:-\\s+)?${escapeRe(key)}\\s*:`).test(text);
}

/** 把 JS 值渲染成 YAML 标量 */
function render(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  // baseUrl / apiKey 里有 : / 等字符，一律加引号最稳
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 在 from 之后、parentIndent 的直接子层里找 key
 * @returns {{idx:number, indent:number}|null}
 */
function findChild(lines, from, parentIndent, key) {
  let childIndent = null;
  for (let i = from; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const ind = indentOf(raw);
    if (parentIndent >= 0 && ind <= parentIndent) return null; // 已经出了父块
    if (childIndent === null) {
      if (parentIndent < 0 && ind !== 0) continue; // 顶层只认 indent 0
      childIndent = ind;
    }
    if (ind !== childIndent) continue; // 只在直接子层找，不钻到孙子层
    if (isKeyLine(t, key)) return { idx: i, indent: ind };
  }
  return null;
}

/** 沿着 path 找到对应的那一行；matched=已匹配的前缀键数，lastIdx/lastIndent=最后一个命中的父行 */
function locate(lines, pathArr) {
  let parentIndent = -1;
  let parentLine = -1;
  let matched = 0;
  let lastIdx = -1;
  let lastIndent = -1;
  let from = 0;
  for (const key of pathArr) {
    const hit = findChild(lines, from, parentIndent, key);
    if (!hit) return { found: false, parentIndent, parentLine, lastIdx, lastIndent, matched };
    parentIndent = hit.indent;
    parentLine = hit.idx;
    lastIdx = hit.idx;
    lastIndent = hit.indent;
    matched++;
    from = hit.idx + 1;
  }
  return { found: true, idx: parentLine, indent: parentIndent, lastIdx, lastIndent, matched };
}

/**
 * 把 YAML 文本里 path 指向的值改掉（找不到父级就原样返回）
 * @param {string} text
 * @param {string[]} pathArr
 * @param {any} value
 * @returns {{text:string, changed:boolean, inserted:boolean}}
 */
function setScalar(text, pathArr, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const loc = locate(lines, pathArr);

  if (loc.found) {
    const raw = lines[loc.idx];
    const colon = raw.indexOf(':');
    if (colon < 0) return { text, changed: false, inserted: false };
    // 保住行尾注释：`key: 旧值  # 说明`
    const after = raw.slice(colon + 1);
    const m = /^(\s*)((?:"[^"]*"|'[^']*'|[^#]*?)?)(\s*#.*)?$/.exec(after);
    const comment = m && m[3] ? '  ' + m[3].trim() : '';
    const newLine = raw.slice(0, colon + 1) + ' ' + render(value) + comment;
    if (newLine === raw) return { text, changed: false, inserted: false }; // 值没变，不假报
    lines[loc.idx] = newLine;
    return { text: lines.join(eol), changed: true, inserted: false };
  }

  // 没找到：沿路径把缺失的那一段（从第一个没命中的键开始）整串补上。
  // 这样即便顶层段（如 telegram:）整个缺失，也能一次性建出来，不再静默 return。
  const remaining = pathArr.slice(loc.matched);
  if (!remaining.length) return { text, changed: false, inserted: false };

  let anchorIndent, insertAt;
  if (loc.matched === 0) {
    // 顶层键都缺失：追加到文件末尾（先吃掉尾部空行）。
    anchorIndent = -1;
    insertAt = lines.length - 1;
    while (insertAt > 0 && lines[insertAt].trim() === '') insertAt--;
  } else {
    // 父级存在：插到该父块的末尾（沿用原逻辑：跳过块内空行/注释，但保留结构）。
    anchorIndent = loc.lastIndent;
    insertAt = loc.lastIdx;
    for (let i = loc.lastIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      if (t.startsWith('#')) {
        if (indentOf(lines[i]) > anchorIndent) { insertAt = i; continue; }
        break;
      }
      if (indentOf(lines[i]) <= anchorIndent) break; // 出了父块
      insertAt = i;
    }
  }

  const pad = anchorIndent < 0 ? 0 : anchorIndent + 2;
  const block = [];
  let indent = pad;
  for (let i = 0; i < remaining.length; i++) {
    const key = remaining[i];
    if (i === remaining.length - 1) {
      block.push(`${' '.repeat(indent)}${key}: ${render(value)}`);
    } else {
      block.push(`${' '.repeat(indent)}${key}:`);
    }
    indent += 2;
  }
  if (anchorIndent < 0) block.unshift(''); // 顶层新块前加个空行，和上文隔开
  lines.splice(insertAt + 1, 0, ...block);
  return { text: lines.join(eol), changed: true, inserted: true };
}

/**
 * 把任意输入收敛成合法的「提取间隔」秒数（2~15）。
 * 非数字 / 超出范围 / 缺失 → 回退默认 5。界面下拉只给 2~15，这里再兜底一道。
 */
function clampExtractInterval(v, fallback = 5) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  if (n < 2) return 2;
  if (n > 15) return 15;
  return Math.round(n);
}

/** apiKey 只回显尾巴，避免界面/日志里到处是明文 */
function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 3)}••••${s.slice(-4)}`;
}

/** 把路径写成可读的点号形式，报错时看得懂 */
function dotted(pathArr) {
  return pathArr.join('.');
}

/**
 * 把「AI 设置」弹窗提交的内容写进 config.yaml
 *
 * @param {object} patch
 *   { providers: { deepseek: {baseUrl,apiKey,model}, gpt: {...}, anthropic: {...} },
 *     tasks:     { translate: {provider,model}, ... } }
 * @param {object} cfg 内存里的完整配置对象（写文件的同时同步改它，省得重启）
 * @returns {{ok:boolean, changed:string[], skipped:string[], error?:string}}
 */
function saveAiConfig(patch, cfg) {
  const file = paths.configFile();
  if (!fs.existsSync(file)) return { ok: false, changed: [], skipped: [], error: `找不到配置文件：${file}` };

  let text = fs.readFileSync(file, 'utf8');
  const changed = [];
  const skipped = [];

  const targets = [];
  for (const [pName, pv] of Object.entries(patch.providers || {})) {
    for (const [k, v] of Object.entries(pv || {})) {
      if (v === undefined) continue;
      targets.push({ pathArr: ['ai', 'providers', pName, k], value: v, group: 'providers', name: pName, key: k });
    }
  }
  for (const [tName, tv] of Object.entries(patch.tasks || {})) {
    for (const [k, v] of Object.entries(tv || {})) {
      if (v === undefined) continue;
      targets.push({ pathArr: ['ai', 'tasks', tName, k], value: v, group: 'tasks', name: tName, key: k });
    }
  }

  for (const t of targets) {
    const r = setScalar(text, t.pathArr, t.value);
    if (!r.changed) {
      skipped.push(dotted(t.pathArr));
      continue;
    }
    text = r.text;
    changed.push(dotted(t.pathArr));
    // 同步内存配置：界面立刻就能用新 key，不用重启软件
    if (cfg && cfg.ai) {
      const bag = t.group === 'providers' ? (cfg.ai.providers ||= {}) : (cfg.ai.tasks ||= {});
      (bag[t.name] ||= {})[t.key] = t.value;
    }
  }

  try {
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) {
    return { ok: false, changed: [], skipped, error: `写不进配置文件：${e.message}` };
  }
  return { ok: true, changed, skipped, file };
}

/* ---------------- telegram 账号注入 ---------------- */

/** 重复空格串 */
function indentStr(n) { return ' '.repeat(Math.max(0, n)); }

/**
 * 把默认 Telegram 账号数组渲染成 YAML 文本块（accounts: 及其子项）。
 * base = accounts: 这一行的缩进（通常 2，挂在 telegram: 下）。
 */
function accountsBlockYaml(accounts, base = 2) {
  const itemIndent = base + 2;     // "- id:" 这行
  const keyIndent = itemIndent + 2; // 各字段这行
  const lines = [indentStr(base) + 'accounts:'];
  for (const a of accounts) {
    lines.push(indentStr(itemIndent) + '- id: ' + Number(a.id));
    lines.push(indentStr(keyIndent) + 'label: ' + render(a.label || ('Tele' + a.id)));
    lines.push(indentStr(keyIndent) + 'waAccount: ' + Number(a.waAccount || 0));
    lines.push(indentStr(keyIndent) + 'enabled: ' + (a.enabled !== false));
    lines.push(indentStr(keyIndent) + 'proxy: ' + render(a.proxy || ''));
    lines.push(indentStr(keyIndent) + 'cdpProfile: ' + render(a.cdpProfile || ('TG-PC' + (Number(a.id) - 6) + '-CDP')));
    lines.push(indentStr(keyIndent) + 'cdpPort: ' + (a.cdpPort || (9244 + (Number(a.id) - 7))));
  }
  return lines.join('\n');
}

/**
 * 确保 config.yaml 里有 telegram.accounts 列表；没有就补上（不覆盖已存在的）。
 * @returns {{text:string, changed:boolean}}
 */
function ensureTelegramAccounts(text, accounts) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let tgIdx = -1, tgIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^telegram\s*:\s*$/.test(t)) { tgIdx = i; tgIndent = indentOf(lines[i]); break; }
  }
  if (tgIdx < 0) {
    // 整个 telegram 段都没有：末尾追加完整块。
    let at = lines.length - 1;
    while (at > 0 && lines[at].trim() === '') at--;
    const block = ['telegram:', ...accountsBlockYaml(accounts, 2).split('\n')];
    lines.splice(at + 1, 0, '', ...block);
    return { text: lines.join(eol), changed: true };
  }
  // 已存在 telegram 段：看是否已有 accounts:
  let hasAccounts = false;
  for (let i = tgIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= tgIndent) break;
    if (/^accounts\s*:\s*$/.test(lines[i].trim())) { hasAccounts = true; break; }
  }
  if (hasAccounts) return { text, changed: false };
  // 在 telegram: 行后插入 accounts 块
  const block = accountsBlockYaml(accounts, 2).split('\n');
  lines.splice(tgIdx + 1, 0, ...block);
  return { text: lines.join(eol), changed: true };
}

function defaultTelegramAccounts() {
  return [
    { id: 7, label: 'Tele①', waAccount: 1, enabled: true },
    { id: 8, label: 'Tele②', waAccount: 2, enabled: false },
    { id: 9, label: 'Tele③', waAccount: 3, enabled: false },
  ];
}

module.exports = { setScalar, saveAiConfig, maskKey, dotted, clampExtractInterval, ensureTelegramAccounts, defaultTelegramAccounts, accountsBlockYaml, indentStr };
