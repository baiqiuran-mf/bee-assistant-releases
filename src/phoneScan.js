/**
 * 电话号码「全量候选扫描」（2026-10-07 · 顶栏「📞 抓取」按钮）
 *
 * 🔴 为什么要有这个模块：identity.phoneFromText 只返回**第一个**认出来的号码，
 *    那是给自动入库用的（只要一个就够）。但老板要的是
 *    「把所有能抓取到的电话号码相关的字符都列出来」——
 *    也就是把整段对话里**每一个**像号码的字符串全部摊开给他看，
 *    附带「为什么像 / 为什么不像」，由人来判断。
 *
 *    两者口径必须分开：
 *      · phoneFromText  = 宁可漏、只要一个、直接写库（红线：错号码比没号码更糟）
 *      · 本模块         = 宁可多、全部列出、只给人看（红线：一个都不许静默丢弃）
 *
 * 所以这里**不复用** phoneFromText 的判定，而是另写一套「宽松收集」：
 * 先用正则把所有「数字 + 分隔符」的连续片段全捞出来，再逐个打分。
 *
 * 硬边界：只读数据库、只读内存里的消息文本。**不碰浏览器、不发任何请求。**
 */

/** 数字之间允许出现的分隔符（跟 identity 那边口径一致，再多认几个常见的） */
const SEP_CLASS = '[\\s\\-._()\\[\\]]*';

/**
 * 一段「看起来像号码」的字符。
 * @typedef {object} Candidate
 * @property {string} raw      原文里抠出来的那一段（保留用户写的分隔符，便于核对）
 * @property {string} digits   纯数字
 * @property {number} len      数字位数
 * @property {boolean} hasPlus 原文带 + 或 00（最硬的真号证据）
 * @property {string} country  反查出的国家/地区名（认不出就是 ''）
 * @property {boolean} ok      是否通过「像真号码」的判定
 * @property {string} reason   判定理由（界面上原样显示，老板才看得懂为什么）
 * @property {string} rule     命中的是哪条规则（e164 / bare / via / long-digit…）
 */

/** 把全角转半角 + 归一化空白（跟 identity.phoneFromText 同一个起点） */
function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\u3000\u00A0]/g, ' ');
}

/**
 * 判断一段数字「像不像」真号码 —— 返回 {ok, reason}。
 *
 * 🔴 这里的标准刻意比 identity 宽松：这是给人看的清单，宁可多列一条让老板自己否掉，
 *    也不能因为标准太严而让某个真号根本没出现在列表里。
 *    真正写库的判断仍然走 identity.applyRegrab，两套口径互不干扰。
 */
function judge(digits, hasPlus, intlOk) {
  const len = digits.length;

  if (!len) return { ok: false, reason: '没有数字' };

  // 明显不是号码的，先说清楚为什么，用户才不会再问同样的问题
  if (len <= 4) {
    return { ok: false, reason: `只有 ${len} 位，太短（门牌号/房间号/年份那种）` };
  }
  if (len === 5) {
    return { ok: false, reason: '5 位 —— 多半是美国邮编' };
  }
  if (len >= 8 && len <= 10 && /^(?:19|20)\d{2}$/.test(digits.slice(0, 4))
      && /^(?:19|20)\d{6}$/.test(digits)) {
    return { ok: false, reason: '8 位且是 19xx/20xx 开头 —— 这是日期（YYYYMMDD），不是号码' };
  }
  if (len >= 6 && len <= 8) {
    return { ok: false, reason: `${len} 位 —— 更像邮编 / 工号 / 订单短号，真手机号通常 ≥9 位` };
  }
  if (len >= 14) {
    return { ok: false, reason: `${len} 位 —— 超过国际号码上限 13 位，多半是 WhatsApp 的 LID 隐私号或订单号` };
  }

  // 带 + / 00 且过了区号表 → 最可信
  if (hasPlus && intlOk) {
    return { ok: true, reason: `原文带 ${hasPlus === '00' ? '00' : '+'} 且区号合法 —— 最可信的一条` };
  }
  if (hasPlus && !intlOk) {
    return { ok: false, reason: '原文带 + 或 00，但区号不在国际表里 —— 可疑，别直接用' };
  }

  if (len >= 9 && len <= 13) {
    return { ok: true, reason: `${len} 位，纯数字无 + —— 可能是没写国际区号的本地写法，需人工核对` };
  }
  return { ok: false, reason: `${len} 位 —— 不在常见号码长度区间` };
}

/**
 * 从一段文本里捞出**所有**号码候选。
 *
 * ⚠️ 关键点：这里不是"找第一个就返回"，而是把整段文本里所有数字片段全收集、
 *    按出现顺序去重（同一个号在对话里出现 5 次只列一条，但记出现次数）。
 *
 * @param {string} text
 * @returns {Candidate[]}
 */
function scanText(text) {
  const s = normalize(text);
  const out = [];
  if (!s.trim()) return out;

  // 一条片段 = 数字 + 数字之间允许的分隔符 + 数字。
  // 至少要有 5 位数字才值得看（4 位以下一定是门牌/年份，见 judge）。
  const re = new RegExp('\\d' + SEP_CLASS + '(?:\\d' + SEP_CLASS + '){4,20}', 'g');
  let m;
  const seen = new Map();

  while ((m = re.exec(s))) {
    const raw = m[0].trim().replace(/[\s\-._()\[\]]+$/, ''); // 切掉尾部分隔符（"07700 900123 (" 这种）
    const digits0 = raw.replace(/\D/g, '');
    if (!digits0) continue;

    // 往前看一眼紧邻的字符，判断这段数字是不是「带 + / 00 前缀」
    //（"+1 541 801 0646" 里正则从 "1" 开始吃，前面的 + 在片段外，得单独补）
    const before = s.slice(Math.max(0, m.index - 4), m.index);
    const hasPlus = /\+\s*\d*$/.test(before) ? '+' : (/00\s*$/.test(before) ? '00' : '');

    // 🔴 剥 trunk 前缀 (0)（2026-10-07 抓到）：国际拨号惯例里 "+86 (0)138…" 那个 0
    //    是本地长途前缀，国际号码里不该有 —— 不剥的话 138 0013 8000 会变成
    //    86013800138000（14 位），被自己的长度闸挡掉，一个真号就这么丢了。
    //    只在「区号后面紧跟 (0)」时剥，和 identity.phoneFromText 同一口径。
    const hasTrunk = hasPlus && /^\d{1,4}[\s\-._()]*\(\s*0\s*\)/.test(raw);
    const digits = hasTrunk ? digits0.replace(/^(\d{1,4})0(\d{6,})$/, '$1$2') : digits0;
    if (!digits) continue;

    // 区号校验：借用 identity 的 parseIntlPhone（传 minLen=4 只验区号合法性）
    let intlOk = false;
    let country = '';
    if (hasPlus) {
      // 从原文里把这串连同前缀重新切出来喂给 identity
      const intl = require('./identity').parseIntlPhone(digits, 4);
      intlOk = !!(intl && intl.phone);
      if (intlOk) {
        country = require('./identity').countryOfPhone(intl.phone) || '';
        // 区号对得上时，用 identity 归一化后的号码（它会正确处理 trunk 0）
        if (intl.phone !== digits) { /* 保持原样展示，只借它的国家判断 */ }
      }
    } else {
      country = require('./identity').countryOfPhone(digits) || '';
    }

    const key = hasPlus + ':' + digits;
    if (seen.has(key)) {
      seen.get(key).hits++;
      continue;
    }

    const { ok, reason } = judge(digits, hasPlus, intlOk);
    const cand = {
      raw, digits, len: digits.length, hasPlus,
      country, ok, reason,
      rule: hasPlus ? 'e164' : (ok ? 'bare' : 'weak'),
      hits: 1,
    };
    seen.set(key, cand);
    out.push(cand);
  }

  return out;
}

/**
 * 扫一个客户的**整段历史对话**，把所有候选汇总。
 *
 * 每条候选额外带上「在第几条消息里出现、原文长什么样」，
 * 这样老板一眼能回溯核对，而不是只看到一个光秃秃的号码。
 *
 * @param {string} code 客户编号
 * @param {Array} messages db.listMessages.all(code) 的结果
 * @param {object} [customer] 客户档案（取现在已存的号码做对比）
 */
function scanCustomer(code, messages, customer) {
  const rows = Array.isArray(messages) ? messages : [];
  const map = new Map();

  for (const m of rows) {
    // 只看客户发来的（direction='in'）——号码是他自己给的，
    // 我发出去的串里出现的数字多半是订单号/价格，反而干扰。
    if (m.direction && m.direction !== 'in') continue;
    const text = String(m.body || '');
    if (!text || /^data:[\w./+-]+;base64,/i.test(text)) continue; // 图片 base64 跳过

    for (const c of scanText(text)) {
      const key = (c.hasPlus ? '+' : '') + c.digits;
      if (map.has(key)) {
        map.get(key).hits++;
        if (map.get(key).from.length < 5) map.get(key).from.push({
          msgId: m.id, at: m.msg_ts, snippet: snippetAround(text, c.raw),
        });
        continue;
      }
      map.set(key, {
        ...c,
        from: [{ msgId: m.id, at: m.msg_ts, snippet: snippetAround(text, c.raw) }],
      });
    }
  }

  const list = [...map.values()];

  // 排序：先「像真号」的，再按位数多的优先，最后按出现次数
  list.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (b.len !== a.len) return b.len - a.len;
    return b.hits - a.hits;
  });

  // 和档案里现有的号码对一下标出来（省得老板自己比）
  const cur = String((customer && customer.phone) || '').replace(/\D/g, '');
  for (const c of list) c.isCurrent = !!cur && cur === c.digits;

  return {
    code,
    okCount: list.filter((c) => c.ok).length,
    total: list.length,
    scannedMsgs: rows.filter((m) => m.direction === 'in' || !m.direction).length,
    current: { phone: cur || '', src: (customer && customer.phone_src) || '' },
    list,
  };
}

/** 从原文里截一段带上下文的片段，方便老板核对（前后各 18 个字符） */
function snippetAround(text, needle) {
  const i = text.indexOf(needle);
  if (i < 0) return String(text).slice(0, 60);
  const a = Math.max(0, i - 18);
  const b = Math.min(text.length, i + needle.length + 18);
  return (a > 0 ? '…' : '') + text.slice(a, b) + (b < text.length ? '…' : '');
}

module.exports = { scanText, scanCustomer, judge, normalize };
