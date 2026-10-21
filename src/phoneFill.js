/**
 * 「电话号码」自动填充 + 加号判断（2026-10-07 v1.0.14）
 *
 * 老板需求（四条）：
 *   ① 打开客户档案时，号码框为空 → 自动抓取并填入
 *   ② 号码框里没有 "+" → 重新抓取，填入时前面加 "+"
 *   ③ 档案弹窗标题栏加「📞 抓取」按钮 + 指示灯（绿=已判定带+ / 红=异常）
 *   ④ 每次打开档案，绿灯就是"不用抓"的依据 —— 绿了就不做抓取动作
 *
 * 🔴 本模块的硬边界：**只判断和只读**，自己绝不写库。
 *    写不写、什么时候写，由界面（app.js）决定 —— 这样"看"和"改"永远分开。
 *
 * 🔴🔴 为什么"加 +"这件事必须走这个模块，不能在界面上直接拼字符串：
 *    加号不是装饰，它是**国际区号的声明**，加错 = 号码彻底作废。
 *    真实踩得到的坑：`18307433971` 看着像中国手机号，但程序按最长匹配取区号
 *    会取到 "1"（美国）→ 加 + 变成 +1 830-743-3971（美国田纳西州），
 *    跟原主人（中国号码）八竿子打不着。**错号码比没号码危险得多。**
 *    所以这里只在"能确定这是完整的国际号码"时才敢加 +，其余一律返回 needsCode。
 */

/** 号码状态灯的四种颜色 */
const LIGHT = {
  green: 'green',   // 已判定：带 + 且区号合法 —— 不用再抓
  red: 'red',       // 异常：抓不到 / 加不了 + / 是 LID / 区号认不出
  gray: 'gray',     // 正在判断或抓取中
};

/**
 * 判断一个号码字符串"现在算不算已经合格（带 + 且区号合法）"。
 * 这是绿灯的唯一依据 —— 老板原话：「绿灯的话就不做抓取操作」。
 *
 * @param {string} phone 号码框里的原始内容（用户可能手打了空格、括号、+）
 * @returns {{green:boolean, light:string, reason:string, digits:string, e164:string}}
 */
function judgePhone(phone) {
  const raw = String(phone == null ? '' : phone).trim();
  const identity = require('./identity');
  const digits = identity.digitsOnly(raw);

  if (!raw) {
    return { green: false, light: LIGHT.red, reason: '还没有号码', digits: '', e164: '' };
  }
  if (!digits) {
    return { green: false, light: LIGHT.red, reason: '这里只有文字，没有数字', digits: '', e164: '' };
  }
  if (identity.isLidPhone('', digits) || digits.length >= 14) {
    return {
      green: false, light: LIGHT.red,
      reason: '这是 LID 隐私号（一串内部编号），不是电话号码 —— 抓了也用不了',
      digits, e164: '',
    };
  }

  const hasPlus = /^\s*\+/.test(raw);
  if (!hasPlus) {
    // 缺加号 = 还没合格。告诉老板加 + 后会变成什么样，让他知道值不值得抓。
    const guess = identity.parseIntlPhone(digits, 9);
    const tail = guess
      ? `加上 + 会变成 +${guess.phone}（${guess.country}）`
      : '但认不出国家区号，不敢贸然加 +';
    return {
      green: false, light: LIGHT.red,
      reason: `还没有国际区号的加号（+）—— ${tail}`,
      digits, e164: guess ? guess.phone : '',
    };
  }

  const intl = identity.parseIntlPhone(digits, 9);
  if (!intl) {
    return {
      green: false, light: LIGHT.red,
      reason: '有 + 但区号不在国际表里 —— 这串数字可能不是电话号码，别直接用',
      digits, e164: '',
    };
  }
  return {
    green: true, light: LIGHT.green,
    reason: `已判定：+${intl.phone}（${intl.country}）—— 不用再抓`,
    digits, e164: intl.phone,
  };
}

/**
 * 把一个刚抓到的裸号码，变成**可以安全写进档案**的字符串。
 *
 * 规则（宁可返回 needsCode 让人来判断，也不给一个错号码）：
 *   · 原件本来就带 +            → 原样保留（这是最硬的证据）
 *   · 裸数字，但能确定是完整国际号 → 补上 "+"
 *   · 认不出区号 / 是 LID / 超长 → needsCode，**绝不瞎加**
 *
 * @param {object} field profileScan.summarize 的一条字段
 * @returns {{ok:boolean, phone:string, reason:string, needCode:string, digits:string, country:string}}
 */
function toE164(field) {
  const identity = require('./identity');
  const raw = String((field && field.raw) != null ? field.raw : '').trim();
  const digits = identity.digitsOnly(raw);

  if (!digits) {
    return { ok: false, phone: '', reason: '这一项里没有数字', needCode: '', digits: '', country: '' };
  }
  if (identity.isLidPhone('', digits) || digits.length >= 14) {
    return {
      ok: false, phone: '',
      reason: '这是 LID 隐私号，不是电话号码，不能填进「电话号码」',
      needCode: '', digits, country: '',
    };
  }

  const hasPlus = /^\s*\+/.test(raw);
  if (hasPlus) {
    const intl = identity.parseIntlPhone(digits, 9);
    if (!intl) {
      return {
        ok: false, phone: '',
        reason: '原件带 + 但区号不合法 —— 别用这个',
        needCode: '', digits, country: '',
      };
    }
    return {
      ok: true, phone: '+' + intl.phone, reason: `原件就带 +，原样采用（${intl.country}）`,
      needCode: '', digits: intl.phone, country: intl.country,
    };
  }

  const intl = identity.parseIntlPhone(digits, 9);
  if (!intl) {
    return {
      ok: false, phone: '',
      reason: `这串 ${digits.length} 位数字认不出国家区号，不敢加 + —— 需要你手动确认国家`,
      needCode: digits, digits, country: '',
    };
  }
  return {
    ok: true, phone: '+' + intl.phone,
    reason: `确认是完整的 ${intl.country} 国际号码，已补上 +`,
    needCode: '', digits: intl.phone, country: intl.country,
  };
}

/**
 * 从资料抓取结果里，挑出**最适合写进「电话号码」框**的那一条。
 *
 * 排序：像真号优先 → 带 + 优先 → 来源可信度高优先。
 * 挑不出来就返回 null，让界面显示"确实没有"，而不是拿一条不像的充数。
 *
 * @param {Array} fields profileScan.summarize 的 fields
 * @returns {object|null} { field, e164 }
 */
function pickBest(fields) {
  const list = (Array.isArray(fields) ? fields : []).filter((f) => f && f.ok);
  if (!list.length) return null;
  const trust = {
    lid_lookup: 6, lid_enforce: 6, contact_phoneNumber: 5, contact_msisdn: 5,
    contact_id: 4, contact_number: 4, chat_id: 4, chat_number: 4,
    dom_subtitle: 3, dom_header: 3, dom_panel: 3, dom_header_block: 2,
  };
  const sorted = [...list].sort((a, b) => {
    const pa = a.hasPlus ? 1 : 0;
    const pb = b.hasPlus ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ta = trust[a.key] || 0;
    const tb = trust[b.key] || 0;
    if (ta !== tb) return tb - ta;
    return b.len - a.len;
  });
  const field = sorted[0];
  const e = toE164(field);
  return { field, e164: e };
}

/**
 * 把一个从页面 / 消息里拿到的号码，规整成「可安全落库」的形式。
 *
 * 规则（跟 toE164 同一个口径，但返回字符串而不是对象，方便采集落库直接拼）：
 *   · 已经带 + 且区号合法          → 原样保留（最硬的证据）
 *   · 裸数字但能确定是完整国际号  → 补上 "+"
 *   · 认不出区号 / 是 LID / 超长  → 退回原样裸数字（不瞎编一个错的国家码，也不丢弃）
 *
 * @param {string} phone 原始号码（可能带 + / 空格 / 括号，也可能是一串 LID）
 * @returns {string} 规整后的号码；拿不到任何数字时返回 ''
 */
function toStoredPhone(phone) {
  const identity = require('./identity');
  const raw = String(phone == null ? '' : phone).trim();
  if (!raw) return '';
  const digits = identity.digitsOnly(raw);
  if (!digits) return '';
  if (identity.isLidPhone('', digits) || digits.length >= 14) return '';
  const hasPlus = /^\s*\+/.test(raw);
  const intl = identity.parseIntlPhone(digits, 9);
  if (hasPlus) return intl ? '+' + intl.phone : '+' + digits;
  if (intl) return '+' + intl.phone;
  return digits;
}

module.exports = { judgePhone, toE164, pickBest, toStoredPhone, LIGHT };
