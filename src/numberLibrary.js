/**
 * 编号库：手机号 ↔ 客户编号 的对照表
 *
 * 设计（按 2026-09-25 用户要求）：
 *   - 客户编号以「手机号」为基准：同一个手机号，无论加你哪个 WhatsApp 号，永远对应同一个编号。
 *   - 一张文件化的对照表（number_library.json），存在数据根目录，随库持久化。
 *   - 首次见到一个手机号 → 分配一个编号（沿用现有 3A00050 格式）并登记进库；
 *     之后再见到这个号，直接查表复用，读取客户档案也更快（不用再按账号+JID 反查）。
 *   - 编号一经分配永不回收、永不复用（和原 ids 规则一致）。
 *
 * 注意：只认"纯数字"的手机号（去掉 +、空格、横线），所以 +1415… 和 1415… 视为同一个号。
 * 不同国家码（带不带 +1）会判成不同号，这是预期的——避免把无关的人并成一个。
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const FILE = path.join(paths.DATA_ROOT, 'number_library.json');

let map = {}; // normalizedPhone -> code

function load() {
  try {
    if (fs.existsSync(FILE)) map = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    if (typeof map !== 'object' || map === null) map = {};
  } catch (e) {
    map = {};
  }
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    /* 写不下就下次再写，不影响主流程 */
  }
}

load();

/** 把任意手机号规整成纯数字串；太短（<5 位）的当无效返回 null */
function normalizePhone(p) {
  if (!p) return null;
  const s = String(p).replace(/[^\d]/g, '');
  return s.length >= 5 ? s : null;
}

/**
 * 编号库的键：渠道 + 手机号。
 * WhatsApp 沿用**裸号码**做键（兼容已有 number_library.json，不用迁移）；
 * tg:/ig:/li:/fb: 等后期渠道用 `<channel>:<号码>`，避免同号码跨渠道互相覆盖
 * （见 test/manual.test.js「渠道预留：同一号码在不同渠道是两个客户」）。
 */
function keyOf(phone, channel) {
  const n = normalizePhone(phone);
  if (!n) return null;
  const ch = channel || 'whatsapp';
  return ch === 'whatsapp' ? n : `${ch}:${n}`;
}

/** 查手机号对应的编号；没有返回 null */
function lookup(phone, channel) {
  const k = keyOf(phone, channel);
  return k ? map[k] || null : null;
}

/** 登记 手机号→编号（覆盖写，永远指向最新分配的那个编号） */
function register(phone, code, channel) {
  const k = keyOf(phone, channel);
  if (!k || !code) return;
  if (map[k] === code) return;
  map[k] = code;
  save();
}

/**
 * 从数据库已有客户回填编号库（首次运行 / 升级时调用一次）。
 * @param {() => Array<{code:string, phone:string}>} getAll 返回所有客户的查询函数
 * @returns {number} 新增登记条数
 */
function backfillFromDb(getAll) {
  let added = 0;
  try {
    const rows = getAll() || [];
    for (const c of rows) {
      const k = keyOf(c.phone, c.channel);
      if (k && !map[k]) {
        map[k] = c.code;
        added++;
      }
    }
    if (added) save();
  } catch (e) {
    /* 填不动就跳过 */
  }
  return added;
}

module.exports = {
  FILE,
  normalizePhone,
  keyOf,
  lookup,
  register,
  backfillFromDb,
};
