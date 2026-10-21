/**
 * 档案查重 / 合并（蜜蜂信息采集）
 *
 * 为什么要有这个文件（用户的原始问题）：
 *   "发现编号的档案里面存在有相同电话的不同档案文件 —— 相同电话号码意味着只有一个客户，
 *    为什么会有两个档案文件？"
 *
 * 根因不是档案写错，是**数据库里本来就建了两条客户**：
 *   编号库（number_library.json）是 2026-09-25 才加的，之前同一个手机号在
 *   不同 WhatsApp 账号上会各建一条客户（3A00003 / 3A00050），于是各写一份档案。
 *   编号库上线后，新客户不会再这样了，但**历史遗留的重复条目还在**。
 *
 * 这个模块负责：
 *   1. 扫描 customers 目录，按【电话号码】找出属于同一个人的多份档案；
 *      电话从两处取：① 文件名（新命名 编号_名称_电话.md 里就有）
 *                       ② 文档头部「| 电话号码 | … |」那一行（兼容旧的 名称_地区_编号.md）
 *   2. 记住"哪几个编号已经并进哪一份"（doc_groups.json），
 *      以后无论刷新哪个编号的档案，都写进同一份文件、不再各自冒出一份。
 *
 * 注意：合并**只动档案文件**，不删任何东西。被合并的旧文件挪进
 * customers/_merged_backup/ 备份，随时能翻回去。
 *
 * 路径没写死：目录一律走 customerDoc.docsDir() / paths.DATA_ROOT，
 * 以后做成安装版、用户改了 app.dataDir 也不会失效。
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const doc = require('./customerDoc');

/** 归并表：{ "3A00003": ["3A00050", "2A00002"] } —— 键=保留的编号，值=并进来的编号 */
const GROUPS_FILE = path.join(paths.DATA_ROOT, 'doc_groups.json');

let groups = null;

function loadGroups() {
  if (groups) return groups;
  try {
    if (fs.existsSync(GROUPS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
      groups = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    } else {
      groups = {};
    }
  } catch (e) {
    groups = {};
  }
  // 值一律收敛成字符串数组
  for (const k of Object.keys(groups)) {
    groups[k] = Array.isArray(groups[k]) ? groups[k].filter((x) => typeof x === 'string' && x) : [];
  }
  return groups;
}

function saveGroups() {
  if (!groups) return;
  try {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2), 'utf8');
  } catch (e) {
    /* 写不进就下次再写，不挡主流程 */
  }
}

/** 测试用：把内存里的表换掉（配 _isolate 的临时目录） */
function setGroups(obj) {
  groups = obj && typeof obj === 'object' ? obj : {};
  return groups;
}

/** 把任意电话压成纯数字；太短（<5 位）当无效 —— 和 numberLibrary 的口径一致 */
function normalizePhone(p) {
  if (!p) return null;
  const s = String(p).replace(/[^\d]/g, '');
  return s.length >= 5 ? s : null;
}

/** 从档案正文里抠出「| 电话号码 | xxx |」那一行（旧命名不带电话时的兜底） */
function readDocPhone(filePath) {
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    // 表格行：| 电话号码 | 1534685245 |
    const m = /^\|\s*电话号码\s*\|\s*([^|]*)\|/m.exec(txt);
    if (m && m[1]) return m[1].trim();
    // 兜底：非表格写法
    const m2 = /电话号码\s*[:：]\s*([^\n|]+)/.exec(txt);
    return m2 ? m2[1].trim() : '';
  } catch (e) {
    return '';
  }
}

/** 某编号被并进了哪个编号（没并过返回 null） */
function canonicalOf(code) {
  if (!code) return null;
  const g = loadGroups();
  if (g[code]) return code;                       // 自己是保留的那份
  for (const k of Object.keys(g)) {
    if (g[k].includes(code)) return k;            // 自己被并进了 k
  }
  return null;
}

/** 保留的那份编号下，一共并进来了哪些编号 */
function mergedCodesOf(canonical) {
  const g = loadGroups();
  return Array.isArray(g[canonical]) ? g[canonical].slice() : [];
}

/** 记一笔归并关系（把 merged 列表并进 canonical 名下，去重） */
function setGroup(canonical, mergedCodes) {
  if (!canonical) return loadGroups();
  const g = loadGroups();
  const list = new Set(g[canonical] || []);

  const add = (c) => {
    if (!c || c === canonical || list.has(c)) return;
    list.add(c);
    // 这个编号如果自己也是一组（之前并过别的号），把它那一组一起收编过来
    if (g[c]) for (const x of g[c]) add(x);
  };
  for (const c of mergedCodes || []) add(c);

  // 被收编的编号，自己那份"组头"身份注销（现在都归 canonical）
  for (const c of [...list]) if (c !== canonical && g[c]) delete g[c];
  // canonical 若原本是被别人并着的那一份，从旧组里摘出来
  for (const k of Object.keys(g)) {
    if (k === canonical) continue;
    g[k] = g[k].filter((x) => x !== canonical);
    if (!g[k].length) delete g[k];
  }
  g[canonical] = [...list];
  saveGroups();
  return g;
}

/** 撤掉一个编号的归并关系（界面以后要"拆开"时用得上） */
function ungroup(canonical) {
  const g = loadGroups();
  delete g[canonical];
  saveGroups();
  return g;
}

/**
 * 按电话号码找同一个人名下的其它档案。
 *
 * @param {string} phone 电话号码（带不带 + / 空格都行）
 * @param {{excluding?:string}} [opts] excluding = 当前正在处理的编号（不算自己）
 * @returns {Array<{file:string,path:string,code:string,name:string,phone:string,legacy:boolean}>}
 */
function scanDocsByPhone(phone, opts = {}) {
  const norm = normalizePhone(phone);
  if (!norm) return [];
  const exclude = opts.excluding || null;

  const out = [];
  for (const d of doc.listDocFiles()) {
    if (!d.code) continue;                          // 文件名不像编号，跳过（别乱碰）
    if (exclude && d.code === exclude) continue;
    let p = normalizePhone(d.phone);
    if (!p) p = normalizePhone(readDocPhone(d.path));  // 旧命名里没电话 → 读文档头部
    if (p && p === norm) {
      out.push({ file: d.file, path: d.path, code: d.code, name: d.name || '', phone: d.phone || '', legacy: !!d.legacy });
    }
  }
  return out;
}

/** 读一份档案的全文（合并交给 AI 之前先读出来） */
function readDoc(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return '';
  }
}

module.exports = {
  GROUPS_FILE,
  normalizePhone,
  readDocPhone,
  readDoc,
  canonicalOf,
  mergedCodesOf,
  setGroup,
  ungroup,
  loadGroups,
  setGroups,
  saveGroups,
  scanDocsByPhone,
};
