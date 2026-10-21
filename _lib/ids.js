/**
 * 客户编号生成器
 *
 * 格式：{账号号}{字母}{5位序号}      例：1A00001
 * 规则：
 *   - 账号号 1-5，对应你手上的 5 个 WhatsApp 号
 *   - 序号 00001 起，递增到 99999
 *   - 满 99999 后字母进一位（A→B→C…），序号重置为 00001
 *   - 编号一经分配永不回收、永不复用
 */

const SEQ_MAX = 99999;
const CODE_RE = /^([1-9])([A-Z])(\d{5})$/;

function parseCode(code) {
  const m = CODE_RE.exec(String(code || '').trim().toUpperCase());
  if (!m) return null;
  return { account: Number(m[1]), letter: m[2], seq: Number(m[3]) };
}

function formatSeq(seq) {
  return String(seq).padStart(5, '0');
}

function nextLetter(letter) {
  const next = letter.charCodeAt(0) + 1;
  if (next > 'Z'.charCodeAt(0)) throw new Error('编号空间已耗尽（字母段用完）');
  return String.fromCharCode(next);
}

function nextCode(account, letter, seq) {
  if (seq + 1 > SEQ_MAX) return `${account}${nextLetter(letter)}${formatSeq(1)}`;
  return `${account}${letter}${formatSeq(seq + 1)}`;
}

/**
 * 生成该账号的下一个客户编号
 * @param {number|string} account 账号号，1-5
 * @param {string|null} lastCode 该账号当前最大的编号，没有则传 null
 * @returns {string} 例如 1A00001
 */
function nextCustomerCode(account, lastCode) {
  const acc = Number(account);
  if (!Number.isInteger(acc) || acc < 1 || acc > 9) {
    throw new Error(`账号号非法: ${account}`);
  }
  if (!lastCode) return `${acc}A${formatSeq(1)}`;

  const p = parseCode(lastCode);
  if (!p) throw new Error(`无法解析已有编号: ${lastCode}`);
  if (p.account !== acc) throw new Error(`账号 ${acc} 与编号 ${lastCode} 不匹配`);

  return nextCode(p.account, p.letter, p.seq);
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
  SEQ_MAX,
};
