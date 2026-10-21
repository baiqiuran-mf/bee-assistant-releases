/**
 * 客户编号生成器
 *
 * 格式：{账号号}{字母段}{5位序号}      例：1A00001
 * 规则：
 *   - 账号号 1-5，对应你手上的 5 个 WhatsApp 号（外部独立 Chrome）
 *   - 账号号 6=Signal / 7-9=Tele①-③ / 10=WA①（内置浏览器版，编号段 WA）
 *   - 序号 00001 起，递增到 99999
 *   - 满 99999 后字母进一位（A→B→C…），序号重置为 00001
 *   - 编号一经分配永不回收、永不复用
 *
 * 🔴 v2.6.1095 老板定调「WA① 不要跟一号一样，当成另一个账号 / 另一个数据文件夹」：
 *   WA① 是**软件内置浏览器内核**（webview），一号~五号是**软件外独立 Chrome 进程**，
 *   两者根本不是同类，绝不能共用编号段。所以给它独立的 WA 段：
 *     一号~五号 1A00001 / 2A00001 / …
 *     Signal    6A00001
 *     Tele①~③   7A00001 / 8A00001 / 9A00001
 *     WA①      WA00001   ← 一眼认出是内置浏览器版，绝不撞任何现有账号
 *   实现方式：账号号段支持「WA」两字符前缀，WA① 传 ACC_WA_EMBEDDED（=10），
 *   由 ACC_PREFIX 把 10 映射成 'WA'。这样**不必把 account_id 列从 INTEGER 改成 TEXT**
 *   （老库 1~9 的行一个字节都不用动）。
 *
 * ⚠️ WA 段是**独立一条规则**，刻意不含「字母进位段」：
 *   数字号才有 A/B/C 进位；WA 段用满 99999 就走 WA1/WA2 那种下一段。
 *   老板看编号要一眼分清「这是内置浏览器版」，中间多个字母反而看不懂。
 */

const SEQ_MAX = 99999;
// 🔴 数字号：一位账号号 + 字母段 + 5 位序号（1A00001）—— 原样不动
const CODE_RE = /^([1-9])([A-Z])(\d{5})$/;
// 🔴 WA①~⑤ 内置浏览器版：WA/WB/WD/WE/WF + 5 位序号（WA00001 / WB00001 …）。
//    🔴 2026-10-16 老板拍板：复刻 WA① 成 5 个内置浏览器标签，编号段**各自独立**：
//       WA① = WA00001（accId 10）｜WA② = WB00001（accId 11）｜WA③ = WD00001（accId 12）
//       WA④ = WE00001（accId 13）｜WA⑤ = WF00001（accId 14）
//       ⚠️ 跳过 WC：WA③ 用 WD（老板原话如此）。
//    各自独立计数器，绝不共用一条编号段，一眼认出是哪台内置浏览器采的。
//    序号与数字号同为 5 位（SEQ_MAX=99999），用满就抛错，绝不越界写坏编号。
const WA_CODE_RE = /^(WA|WB|WD|WE|WF)(\d{5})$/;

/** 账号号 → 编号前缀。数字号原样，WA①~⑤（10~14）各映射成 WA/WB/WD/WE/WF。 */
const ACC_PREFIX = { 10: 'WA', 11: 'WB', 12: 'WD', 13: 'WE', 14: 'WF' };

/** WA① 内置浏览器版的账号号（老库 account_id 是 INTEGER，用 10 占位） */
const ACC_WA_EMBEDDED = 10;

/** WA①~⑤ 编号前缀 → 账号号（parseCode / prefixAccount 用） */
const WA_PREFIX_TO_ACC = { WA: 10, WB: 11, WD: 12, WE: 13, WF: 14 };

/** WA①~⑤ 五个内置浏览器实例的「账号号 / 分区 / 渠道前缀 / 显示名」全量表。
 *  🔴 唯一出处：改 WA 标签数量 / 账号分配只动这一张表，别处都得从它派生。 */
const WA_EMBEDDED = [
  { key: 'wa1', idx: 1, accId: 10, partition: 'persist:wa6',  prefix: 'wa1', label: 'WA①', codePrefix: 'WA' },
  { key: 'wa2', idx: 2, accId: 11, partition: 'persist:wa7',  prefix: 'wa2', label: 'WA②', codePrefix: 'WB' },
  { key: 'wa3', idx: 3, accId: 12, partition: 'persist:wa8',  prefix: 'wa3', label: 'WA③', codePrefix: 'WD' },
  { key: 'wa4', idx: 4, accId: 13, partition: 'persist:wa9',  prefix: 'wa4', label: 'WA④', codePrefix: 'WE' },
  { key: 'wa5', idx: 5, accId: 14, partition: 'persist:wa10', prefix: 'wa5', label: 'WA⑤', codePrefix: 'WF' },
];
const WA_EMBEDDED_ACCOUNTS = WA_EMBEDDED.map((x) => x.accId);
const WA_EMBEDDED_BY_KEY = {};
for (const x of WA_EMBEDDED) WA_EMBEDDED_BY_KEY[x.key] = x;

/** 这个前缀是不是「WA 内置浏览器段」（WA/WB/WD/WE/WF 都算，跟数字号那种走字母进位的区分开） */
function isWaPrefix(p) {
  return Object.prototype.hasOwnProperty.call(WA_PREFIX_TO_ACC, String(p || '').toUpperCase());
}

/** 账号号（数字）→ 编号里那一段（字符串） */
function accountPrefix(account) {
  const acc = Number(account);
  if (ACC_PREFIX[acc]) return ACC_PREFIX[acc];
  if (!Number.isInteger(acc) || acc < 1 || acc > 9) {
    throw new Error(`账号号非法: ${account}`);
  }
  return String(acc);
}

/** 编号里那一段（字符串）→ 账号号（数字）；认不出来返回 null */
function prefixAccount(prefix) {
  const p = String(prefix || '').trim().toUpperCase();
  for (const [acc, pre] of Object.entries(ACC_PREFIX)) {
    if (pre === p) return Number(acc);
  }
  if (/^[1-9]$/.test(p)) return Number(p);
  return null;
}

function parseCode(code) {
  const s = String(code || '').trim().toUpperCase();
  // WA 段先判：WA/WB/WD/WE/WF + 5位数字，绝不能被数字号那条正则误吃
  const w = WA_CODE_RE.exec(s);
  if (w) return { account: WA_PREFIX_TO_ACC[w[1]], prefix: w[1], letter: '', seq: Number(w[2]) };
  const m = CODE_RE.exec(s);
  if (!m) return null;
  return { account: Number(m[1]), prefix: m[1], letter: m[2], seq: Number(m[3]) };
}

function formatSeq(seq) {
  return String(seq).padStart(5, '0');
}

function nextLetter(letter) {
  const next = letter.charCodeAt(0) + 1;
  if (next > 'Z'.charCodeAt(0)) throw new Error('编号空间已耗尽（字母段用完）');
  return String.fromCharCode(next);
}

/**
 * 序号进位。prefix 是编号里那一段的**字符串**（'1'…'9' 或 'WA'），
 * 不是数字 —— WA① 的前缀是两位 'WA'，走字符串拼接才不会丢字。
 */
function nextCode(prefix, letter, seq) {
  if (seq + 1 > SEQ_MAX) return `${prefix}${nextLetter(letter)}${formatSeq(1)}`;
  return `${prefix}${letter}${formatSeq(seq + 1)}`;
}

/**
 * 生成该账号的下一个客户编号
 * @param {number|string} account 账号号，1-9 或 10（WA① 内置浏览器版）
 * @param {string|null} lastCode 该账号当前最大的编号，没有则传 null
 * @returns {string} 例如 1A00001 / WA00001
 */
function nextCustomerCode(account, lastCode) {
  const acc = Number(account);
  const prefix = accountPrefix(acc);   // 非法账号号在这里抛
  const isWa = isWaPrefix(prefix);
  // 🔴 WA 段首个 = WA00001 / WB00001 …（5 位序号，没有字母段）；数字号首个 = 1A00001
  if (!lastCode) return isWa ? `${prefix}${formatSeq(1)}` : `${prefix}A${formatSeq(1)}`;

  const p = parseCode(lastCode);
  if (!p) throw new Error(`无法解析已有编号: ${lastCode}`);
  if (p.account !== acc) throw new Error(`账号 ${acc} 与编号 ${lastCode} 不匹配`);

  // 🔴 WA 段不走字母进位（老板要编号一眼看出是内置版），用满 99999 就明确报错
  if (isWa) {
    if (p.seq + 1 > SEQ_MAX) throw new Error(`${prefix} 编号段已用尽（99999 个客户）`);
    return `${prefix}${formatSeq(p.seq + 1)}`;
  }

  return nextCode(prefix, p.letter, p.seq);
}

/**
 * 排序用的比较器：1A00009 < 1A00010 < 1B00001
 * 因为位数固定，字典序等价于数值序，直接用字符串比较即可
 */
function compareCode(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

module.exports = {
  parseCode,
  nextCustomerCode,
  nextCode,
  nextLetter,
  formatSeq,
  compareCode,
  accountPrefix,
  prefixAccount,
  ACC_WA_EMBEDDED,
  ACC_PREFIX,
  WA_PREFIX_TO_ACC,
  WA_EMBEDDED,
  WA_EMBEDDED_ACCOUNTS,
  WA_EMBEDDED_BY_KEY,
  isWaPrefix,
  WA_CODE_RE,
  SEQ_MAX,
};
