/**
 * 客户身份抓取：从 whatsapp-web.js 的一条消息里尽量挖出「显示名 + 电话号码」
 *
 * 为什么要单独一个文件（2026-09-28 修「抓不到名字 / 抓不到电话」）：
 *   1) 老代码用的是 `msg.notifyName || msg.pushName`。这两个字段是**很老版本**的
 *      whatsapp-web.js 才有的；本机装的是 1.34.7，Message 上根本没有这两个属性
 *      （整个包里搜不到 notifyName 字样）——所以名字**永远是空**。
 *      现在改走 `msg.getContact()`：Contact 上一定有 pushname / name / shortName / number。
 *   2) 老代码从 JID 里推断电话用的是 `/^\+?\d{5,}@/`。WhatsApp 这两年在推 **LID**
 *      （@lid 隐私 ID，用来对未存通讯录的人隐藏手机号），`@lid` 那一串也是纯数字，
 *      于是"号码"会被当成电话存进去 —— 存了一串根本打不通的假号码。
 *      现在只认 `@c.us` / `@s.whatsapp.net`，其余（@lid / @g.us / @broadcast）一律不算电话。
 *   3) 光靠 JID 不够：LID 会话里 JID 没有号码，必须问 Contact 才能拿到真号码
 *      （wwjs 注入层有 lid→phoneNumber 的换算，见 getContactModel）。
 *      对方没设昵称时，WhatsApp 会把号码当名字给出来，那个也不能当名字存。
 *
 * 使用：await identity.resolve(msg, { client })  → { name, phone }
 * 纯逻辑、不碰数据库，所以可以直接喂假对象做单测。
 */

/** 命中缓存有效期：拿到过身份的，10 分钟内不再问浏览器 */
const HIT_TTL = 10 * 60 * 1000;
/*
 * 2026-10-07 删掉了 MISS_TTL（失败结果缓存 60 秒）。
 * 原因：客户连发 5 条、第 1 条抓不到号码 → 后 4 条全部命中"失败缓存"直接返回空，
 * 等于白抓。老板的原话是"电话号码是空，那就启动抓取" —— 号码为空就必须真抓，
 * 所以现在**号码为空一律不写缓存**（见 resolve 末尾）。
 */
/** 问浏览器最多等多久：卡住也不能拖住整条收消息链路
 *  🔴 2026-10-18 老板拍板「修复代码三处」之一：原 8000ms 太短，wa2 等外置账号的
 *    联系人 / LID→真号码 查询常在 8s 内还没回就被掐断 → 号码永远抓不到。
 *    拉到 18000ms（老板原话「15-20s」区间内取中值）。迟到结果仍会被末尾的
 *    cache.set 落缓存（号码非空才缓存），下一条消息直接命中，不重复烧查询。 */
const CONTACT_TIMEOUT = 18000;
const CHAT_TIMEOUT = 6000;

/**
 * 去掉 JID 末尾的设备后缀（如 `105407573966851@lid:2` 里的 `:2`）。
 * 🔴 2026-10-18 老板拍板「修复代码三处」之二：WhatsApp 多设备会把设备号拼到 JID 后面，
 *    一旦带了 `:N`，`@lid$` / `@c.us$` 这些正则判定全失准 → LID 会话永远认不出、号码永远抓不到。
 *    单点归一化，所有判 JID 形态的地方都走它。 */
function stripDevice(jid) {
  return String(jid || '').replace(/:\d+$/, '').trim();
}

/**
 * 号码来源可信度（2026-10-07 用户点名要的「有没有 + 」）
 *
 * ⚠️ 关键事实：**加号在取号链路里已经被剥掉了**。
 * plausiblePhone / parseIntlPhone / phoneFromText 全都走 digitsOnly()，
 * 实测 phoneFromText('my wa is +44 7726 795080') → "447726795080"（+ 没了）。
 * 所以「判断库里有没有 +」这个判据恒为假（库里 21 条号码只有 2 条带 +，还是人工填的）。
 *
 * 改成**记录号码是从哪一层拿到的**，判据才立得住 —— 同一个号码，
 * 从 WhatsApp 官方接口拿到的和从客户留言里正则抠出来的，可信度完全不同。
 * 数字越大越可信（与 db.js 的 PHONE_SRC_RANK 保持一致）。
 */
const SRC_RANK = { e164: 5, manual: 4, contact: 3, jid: 2, text: 1, '': 0 };

const cache = new Map();

function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

/** 只有长得像真手机号才要（7~15 位纯数字） */
function plausiblePhone(v) {
  const d = digitsOnly(v);
  if (!d || d.length < 7 || d.length > 15) return '';
  return d;
}

/**
 * 国际电话区号白名单（ITU E.164 已分配的国家/地区码，1~3 位）。
 * 2026-09-29 加：用来给"带 + 的号码"做真实性校验——
 *   真实 WhatsApp 号码一定是 +国家区号+本地号；区号不在表里的（如 +99… 瞎编的、
 *   或 LID 假号那串纯数字）一律不当电话号码认，从源头堵住"把订单号/邮编当电话存"。
 * ⚠️ 不含非地理码（800/808/870/878/882/883/888/979/991 等免费/卫星/共享服务），
 *   那些不可能是客户手机号。
 * 港/澳/台按中国地区标注（与项目惯例一致）。
 */
const INTL_DIAL_CODES = new Set([
  // 1 位
  '1', '7',
  // 2 位（欧洲 / 美洲 / 亚太主干）
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41',
  '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54',
  '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
  // 3 位（非洲 / 欧洲小国 / 拉美 / 大洋洲 / 中亚中东）
  '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225',
  '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236',
  '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '247',
  '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258',
  '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290',
  '291', '297', '298', '299', '350', '351', '352', '353', '354', '355', '356',
  '357', '358', '359', '370', '371', '372', '373', '374', '375', '376', '377',
  '378', '379', '380', '381', '382', '383', '385', '386', '387', '389', '420',
  '421', '423', '500', '501', '502', '503', '504', '505', '506', '507', '508',
  '509', '590', '591', '592', '593', '594', '595', '596', '597', '598', '599',
  '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681',
  '682', '683', '685', '686', '687', '688', '689', '690', '691', '692', '850',
  '852', '853', '855', '856', '880', '886', '960', '961', '962', '963', '964',
  '965', '966', '967', '968', '970', '971', '972', '973', '974', '975', '976',
  '977', '992', '993', '994', '995', '996', '998',
]);

/** 区号 → 中文国家/地区名（用于自动标注客户所在国，对欧美油画生意有用） */
const COUNTRY_BY_CODE = new Map([
  ['1', '美国/加拿大'], ['7', '俄罗斯/哈萨克斯坦'],
  ['20', '埃及'], ['27', '南非'], ['30', '希腊'], ['31', '荷兰'], ['32', '比利时'],
  ['33', '法国'], ['34', '西班牙'], ['36', '匈牙利'], ['39', '意大利'],
  ['40', '罗马尼亚'], ['41', '瑞士'], ['43', '奥地利'], ['44', '英国'],
  ['45', '丹麦'], ['46', '瑞典'], ['47', '挪威'], ['48', '波兰'], ['49', '德国'],
  ['51', '秘鲁'], ['52', '墨西哥'], ['53', '古巴'], ['54', '阿根廷'], ['55', '巴西'],
  ['56', '智利'], ['57', '哥伦比亚'], ['58', '委内瑞拉'], ['60', '马来西亚'],
  ['61', '澳大利亚'], ['62', '印度尼西亚'], ['63', '菲律宾'], ['64', '新西兰'],
  ['65', '新加坡'], ['66', '泰国'], ['81', '日本'], ['82', '韩国'],
  ['84', '越南'], ['86', '中国'], ['90', '土耳其'], ['91', '印度'],
  ['92', '巴基斯坦'], ['93', '阿富汗'], ['94', '斯里兰卡'], ['95', '缅甸'], ['98', '伊朗'],
  ['211', '南苏丹'], ['212', '摩洛哥'], ['213', '阿尔及利亚'], ['216', '突尼斯'],
  ['218', '利比亚'], ['220', '冈比亚'], ['221', '塞内加尔'], ['222', '毛里塔尼亚'],
  ['223', '马里'], ['224', '几内亚'], ['225', '科特迪瓦'], ['226', '布基纳法索'],
  ['227', '尼日尔'], ['228', '多哥'], ['229', '贝宁'], ['230', '毛里求斯'],
  ['231', '利比里亚'], ['232', '塞拉利昂'], ['233', '加纳'], ['234', '尼日利亚'],
  ['235', '乍得'], ['236', '中非'], ['237', '喀麦隆'], ['238', '佛得角'],
  ['239', '圣多美和普林西比'], ['240', '赤道几内亚'], ['241', '加蓬'],
  ['242', '刚果(布)'], ['243', '刚果(金)'], ['244', '安哥拉'], ['245', '几内亚比绍'],
  ['246', '英属印度洋领地'], ['247', '阿森松岛'], ['248', '塞舌尔'], ['249', '苏丹'],
  ['250', '卢旺达'], ['251', '埃塞俄比亚'], ['252', '索马里'], ['253', '吉布提'],
  ['254', '肯尼亚'], ['255', '坦桑尼亚'], ['256', '乌干达'], ['257', '布隆迪'],
  ['258', '莫桑比克'], ['260', '赞比亚'], ['261', '马达加斯加'], ['262', '留尼汪'],
  ['263', '津巴布韦'], ['264', '纳米比亚'], ['265', '马拉维'], ['266', '莱索托'],
  ['267', '博茨瓦纳'], ['268', '斯威士兰'], ['269', '科摩罗'], ['290', '圣赫勒拿'],
  ['291', '厄立特里亚'], ['297', '阿鲁巴'], ['298', '法罗群岛'], ['299', '格陵兰'],
  ['350', '直布罗陀'], ['351', '葡萄牙'], ['352', '卢森堡'], ['353', '爱尔兰'],
  ['354', '冰岛'], ['355', '阿尔巴尼亚'], ['356', '马耳他'], ['357', '塞浦路斯'],
  ['358', '芬兰'], ['359', '保加利亚'], ['370', '立陶宛'], ['371', '拉脱维亚'],
  ['372', '爱沙尼亚'], ['373', '摩尔多瓦'], ['374', '亚美尼亚'], ['375', '白俄罗斯'],
  ['376', '安道尔'], ['377', '摩纳哥'], ['378', '圣马力诺'], ['379', '梵蒂冈'],
  ['380', '乌克兰'], ['381', '塞尔维亚'], ['382', '黑山'], ['383', '科索沃'],
  ['385', '克罗地亚'], ['386', '斯洛文尼亚'], ['387', '波黑'], ['389', '北马其顿'],
  ['420', '捷克'], ['421', '斯洛伐克'], ['423', '列支敦士登'], ['500', '福克兰群岛'],
  ['501', '伯利兹'], ['502', '危地马拉'], ['503', '萨尔瓦多'], ['504', '洪都拉斯'],
  ['505', '尼加拉瓜'], ['506', '哥斯达黎加'], ['507', '巴拿马'], ['508', '圣皮埃尔'],
  ['509', '海地'], ['590', '瓜德罗普'], ['591', '玻利维亚'], ['592', '圭亚那'],
  ['593', '厄瓜多尔'], ['594', '法属圭亚那'], ['595', '巴拉圭'], ['596', '马提尼克'],
  ['597', '苏里南'], ['598', '乌拉圭'], ['599', '荷属加勒比'], ['670', '东帝汶'],
  ['672', '南极洲'], ['673', '文莱'], ['674', '瑙鲁'], ['675', '巴布亚新几内亚'],
  ['676', '汤加'], ['677', '所罗门群岛'], ['678', '瓦努阿图'], ['679', '斐济'],
  ['680', '帕劳'], ['681', '瓦利斯和富图纳'], ['682', '库克群岛'], ['683', '纽埃'],
  ['685', '萨摩亚'], ['686', '基里巴斯'], ['687', '新喀里多尼亚'], ['688', '图瓦卢'],
  ['689', '法属波利尼西亚'], ['690', '托克劳'], ['691', '密克罗尼西亚'],
  ['692', '马绍尔群岛'], ['850', '朝鲜'], ['852', '中国香港'], ['853', '中国澳门'],
  ['855', '柬埔寨'], ['856', '老挝'], ['880', '孟加拉'], ['886', '中国台湾'],
  ['960', '马尔代夫'], ['961', '黎巴嫩'], ['962', '约旦'], ['963', '叙利亚'],
  ['964', '伊拉克'], ['965', '科威特'], ['966', '沙特阿拉伯'], ['967', '也门'],
  ['968', '阿曼'], ['970', '巴勒斯坦'], ['971', '阿联酋'], ['972', '以色列'],
  ['973', '巴林'], ['974', '卡塔尔'], ['975', '不丹'], ['976', '蒙古'],
  ['977', '尼泊尔'], ['992', '塔吉克斯坦'], ['993', '土库曼斯坦'],
  ['994', '阿塞拜疆'], ['995', '格鲁吉亚'], ['996', '吉尔吉斯斯坦'],
  ['998', '乌兹别克斯坦'],
]);

/**
 * 从一段"带 + / 00 前缀"的文本里抠出国际电话，并校验区号是否真实。
 *
 * 2026-10-07 用户点明："+"加号是很关键的，有它判断就能很明显地拿到"。
 * 所以带 + 的路径下限放宽到 **7 位**（区号本身已经是很强的证据，
 * 有些国家号码本来就短，如 +4122… 瑞士 9 位以下也常见）；
 * 其它调用方（countryOfPhone 反查等）保持 8 位默认不变。
 *
 * @param {string} raw
 * @param {number} [minLen=8] 允许的最短位数
 * @returns {{phone:string, code:string, country:string}|null}
 */
function parseIntlPhone(raw, minLen = 8) {
  let digits = digitsOnly(raw);
  // 🔴 加号在【返回值】里被剥掉（phone 字段全系统统一存纯数字），
  //    但「原文有没有 +」这个证据必须留住 —— 它是号码可信度最高的一个硬特征。
  //    调用方靠 hasPlus 拿 SRC.e164，比事后从库里查加号可靠得多。
  const hasPlus = /^\s*(?:\+|00)/.test(String(raw || ''));
  if (digits.startsWith('00')) digits = digits.slice(2); // 00 等同 +
  if (digits.length < minLen || digits.length > 15) return null;
  // 最长匹配：先试 3 位区号，再 2 位，再 1 位（如 +4477… → 447 不在表，回退到 44 英国）
  let code = '';
  if (INTL_DIAL_CODES.has(digits.slice(0, 3))) code = digits.slice(0, 3);
  else if (INTL_DIAL_CODES.has(digits.slice(0, 2))) code = digits.slice(0, 2);
  else if (INTL_DIAL_CODES.has(digits.slice(0, 1))) code = digits.slice(0, 1);
  if (!code) return null;
  return { phone: digits, code, country: COUNTRY_BY_CODE.get(code) || '', hasPlus };
}

/** 已知一串纯数字号码，反查它属于哪个国家（用于给抓到的号码自动标注地区） */
function countryOfPhone(phone) {
  const d = digitsOnly(phone);
  if (!d) return '';
  let code = '';
  if (INTL_DIAL_CODES.has(d.slice(0, 3))) code = d.slice(0, 3);
  else if (INTL_DIAL_CODES.has(d.slice(0, 2))) code = d.slice(0, 2);
  else if (INTL_DIAL_CODES.has(d.slice(0, 1))) code = d.slice(0, 1);
  return code ? (COUNTRY_BY_CODE.get(code) || '') : '';
}

/** 这个 JID 是不是 @lid（WhatsApp 用来藏手机号的隐私 ID） */
function isLidJid(jid) {
  return /@lid$/i.test(stripDevice(jid));
}

/**
 * JID → 电话号码。只认 @c.us / @s.whatsapp.net。
 * @lid（隐私 ID）、@g.us（群）、@broadcast（广播）都不是电话，一律返回空。
 */
function phoneFromJid(jid) {
  const s = stripDevice(jid);
  if (!s) return '';
  if (!/@(c\.us|s\.whatsapp\.net)$/.test(s)) return '';
  return plausiblePhone(s.split('@')[0]);
}

/**
 * 这个号码是不是"其实是从 LID 抄来的假号码"（2026-09-29 用户报的 bug：
 * 真号码 +447726795080 被存成了 243834688639050）。
 *
 * 判据（只在客户 JID 是 @lid 时才敢这么判，别人的正常号码不动）：
 *   a) 号码整串 == JID 里那串 LID 数字；或
 *   b) 号码长度 ≥ 14（LID 是 14~16 位；真手机号 E.164 最长 15 位，
 *      但全世界实际在用的号码几乎没有超过 13 位的）。
 * 这种一律当"没拿到号码"处理，留给后续的 LID 查询 / 消息正文 / 补身份去填真的。
 */
function isLidPhone(jid, phone) {
  const d = digitsOnly(phone);
  if (!d) return false;
  if (!isLidJid(jid)) return false;
  const lidDigits = digitsOnly(String(jid).split('@')[0]);
  return d === lidDigits || d.length >= 14;
}

/**
 * 从消息正文里抠电话号码（2026-09-29 加，2026-09-29 晚加强：带 +/00 必须过国际区号校验）。
 * 刚加进来的客户常把号码直接甩过来（"这是我的 WhatsApp 号 +44 7726 795080"），
 * 这时候 LID 查不到、Contact 也空，只能从他自己打的字里拿。
 *
 * 只认两种写法，宁可漏、不许错（把订单号/日期当电话存进去更糟）：
 *   ① 带 + / 00 前缀 —— 用国际区号白名单校验（真号码一定带合法国家区号；
 *      LID 假号 243834688639050 是纯数字连写、没有 +，天然不会被认成号码；
 *      订单号 / 邮编 / +99… 这种区号瞎编的也会被区号表挡掉）
 *   ② 整条消息基本就是一个号码（≤24 字符、除了数字只剩分隔符）—— 客户刚加进来常这么干
 *      （兼容无 + 的本地号写法，如 "447726795080"；上限 13 位，14 位以上多半是 LID/订单号）
 * @returns {string} 纯数字号码，找不到就是 ''
 */
function phoneFromText(text) {
  // 先把全角统一成半角：中文输入法打出来的 "（+1）541 801 0646"、"＋86 138…"，
  // 不转的话下面正则一个都认不出。
  let s = String(text == null ? '' : text)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\u3000\u00A0]/g, ' ');
  if (!s.trim() || s.length > 400) return '';

  // 剥掉 trunk 前缀 "(0)" —— 国际拨号惯例：+86 (0) 138… / +44 (0) 7700… 里
  // 那个 0 是本地长途前缀，国际号码里不该有。**必须先剥**，否则它会被下面的
  // 正则当成号码第一位吃进去，"+86 (0) 138 0013 8000" 就变成 86013800138000（14 位）。
  // 只在"区号后面紧跟 (0)"时才剥，避免误伤 "(020) 1234" 这种国内写法。
  s = s.replace(/((?:\+|00)\s*\d{1,4}[\s\-]*)\(\s*0\s*\)\s*/, '$1');

  // ① 带 + / 00 前缀 → 用国际区号白名单校验（这是 WhatsApp 真号码的硬特征）
  //
  // 2026-10-07 用户点名扩宽四类写法。根因：原来的分隔符类 \`[\s\-()]\` **一次只能吃一个字符**，
  // 而 " +1 (541) 801-0646" 里那个 " (" 是两个字符 → 正则当场断掉。
  // 以前这条能过纯属侥幸（靠规则②"整条就是号码"兜住），
  // 一旦前面有文字（"my whatsapp is +1 (541) 801-0646"）就彻底认不出。
  //
  // 现在 SEP 是一段**连续**分隔符（空格/横线/点/下划线/圆括号，可叠加）：
  //   a) "+1 (541) 801-0646" / "+1-541-801-0646" / "+1 _541_ 801 0646" 全吃得下；
  //   b) 号码本体逐位吃，SEP 里没有字母/中文 → 遇文字自然停，
  //      所以 "… 801-0646 via WhatsApp" 能取到前面那串（用户点名要的第 4 条）；
  //   c) 全角括号已在开头转半角，"（+1）541 801 0646" 同样能认。
  const SEP = '[\\s\\-._()]*';
  const re = new RegExp('(?:\\+|00)' + SEP + '(\\d{1,4})' + SEP + '(\\d(?:' + SEP + '\\d){4,14})', 'g');
  let m;
  while ((m = re.exec(s))) {
    // "+" 是最硬的证据：过了区号白名单就认，下限放到 7 位
    const r = parseIntlPhone(m[1] + m[2], 7);
    if (r) return r.phone;
  }

  // ② 整条消息就是号码（"447726795080" / "(44) 7726-795080" / "📞 (541) 801-0646"）
  //    上限只放到 13 位：14 位以上多半是 LID / 订单号那种，宁可漏。
  //    前面剥掉电话图标/emoji 前缀（"📞 (541)…" / "☎ +1 541…"）——
  //    ⚠️ 只剥**非字母数字**的符号。不能用 /^[^+\d]+/，那会把 " my number is "
  //    整句单词也削掉 → "+879 123 456 789" 会被削成纯符号+数字、绕过规则①的
  //    区号白名单校验（879 不在表里，本该挡掉）。
  const bare = s.replace(/^[^\p{L}\p{N}+]+/u, '');
  // 带 + / 00 的一律**不走这条**（2026-10-07 抓到）：带 + 就该由规则①
  //    过区号白名单决定，不能在这里被"整条都是数字"顺手放过去。
  //    否则 "+99 123456"（99 不是任何国家的区号）会被判成 99123456。
  const hasIntlPrefix = bare.includes('+') || /^[\s\-.]*00[\s\-.]*\d/.test(bare);
  if (!hasIntlPrefix
    && bare.length <= 24 && /\d/.test(bare) && /^[\d\s\-._()]+$/.test(bare)) {
    const d = digitsOnly(bare);
    // 8 位且 19xx/20xx 开头 → 那是日期（20260929），不是号码
    if (d.length >= 8 && d.length <= 13 && !/^(?:19|20)\d{6}$/.test(d)) return d;
  }

  // ③ "号码 + via/on WhatsApp" 这种尾巴 —— 用户点名"带 via 前面那串是对的"。
  //    ⚠️ 这是唯一没有 + 号兜底的规则，误伤风险最高，所以卡五道闸：
  //      · 号码 10~13 位（8 位日期 20260929、5 位邮编 97201 长度不够，挡掉）；
  //      · 不能是 19xx / 20xx 开头的年份串；
  //      · 数字之间只允许空格/横线/点，一出现字母就断（订单号串不会连上来）；
  //      · 号码前面不能紧邻别的数字（防止从长串中间切一段出来）；
  //      · 后面必须紧跟"联系方式"类关键词（via / wa / whatsapp / number…）。
  const m3 = s.match(/(?<![\d\-.])\d(?:[\s\-.]*\d){9,12}/);
  if (m3 && typeof m3.index === 'number') {
    const d = digitsOnly(m3[0]);
    const tail = s.slice(m3.index + m3[0].length);
    const kw = /^\s*(?:via\b|wa\b|whatsapp\b|on\s+whatsapp\b|number\b|phone\b|mobile\b|cell\b|is\s+my\b)/i;
    if (d.length >= 10 && d.length <= 13
      && !/^(?:19|20)\d{2}/.test(d)
      && kw.test(tail)) {
      return d;
    }
  }
  return '';
}

/**
 * 这条消息对应哪个会话（也就是"客户是谁"）
 * 自己发出去的消息，对象是 msg.to；收到的才是 msg.from（群消息看 msg.author）。
 * 这一步必须和 src/main.js 的 handleMessage 用同一个口径 —— 否则自己发出的消息
 * 会全部落到 msg.from（也就是自己 me@c.us）上，缓存撞车、客户认错人。
 */
function jidOfMessage(msg) {
  if (!msg) return '';
  if (msg.fromMe) return stripDevice(String(msg.to || msg.from || ''));
  return stripDevice(String(msg.author || msg.from || ''));
}

/** wwjs 的 ContactId 可能是字符串，也可能是 { _serialized } */
function jidOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return String(v._serialized || v.user || '');
}

/**
 * 从 Contact 上取号码：number（userid）优先，其次 id（lid 时注入层会换成真号码）。
 *
 * ⚠️ 坑（2026-09-29 用户报："真号码 +447726795080 存成了 243834688639050"）：
 *   wwjs 的 getContactModel 只有在 **contact.phoneNumber 查得到** 的时候，
 *   才会把 LID 联系人的 id 换成真号码（见 node_modules/.../Injected/Utils.js
 *   的 `if (wid.isLid() && contact.phoneNumber) res.id = contact.phoneNumber`）。
 *   查不到的时候 id **和** number 都是那串 LID —— 老代码直接信 number，
 *   于是把这串假号码存进了客户档案。
 *   现在：id 是 @lid 时，number 必须"不像 LID"才敢用（见 isLidPhone）。
 */
function phoneFromContact(c) {
  if (!c) return '';
  const idJid = jidOf(c.id);
  const fromId = phoneFromJid(idJid); // 只有 id 本身是 @c.us/@s.whatsapp.net 才算
  const num = plausiblePhone(c.number);
  if (!num) return fromId;
  if (isLidPhone(idJid, num)) return fromId;
  return num;
}

/**
 * 直接问 WhatsApp Web 要 LID → 真号码 的映射（2026-09-29 加）。
 *
 * wwjs 内部就有这个能力，只是默认不主动查：注入层的
 * `window.WWebJS.enforceLidAndPnRetrieval(wid)` 会
 *   · 用 WAWebApiContact.getPhoneNumber(lid) 先查本地表；
 *   · 查不到就发一次 queryWidExists 网络查询再查一次。
 * 这是"在网页上能看到真号码"的正规来源 —— 比装任何浏览器插件都靠谱
 * （插件只会让 WhatsApp Web 刷新掉线，见 2026-09-29 的调研结论）。
 *
 * @returns {Promise<string>} 纯数字号码，拿不到就是 ''
 */
async function resolveLidPhone(client, jid, timeoutMs = CONTACT_TIMEOUT) {
  if (!isLidJid(jid)) return '';
  // ① 优先用 wwjs 官方接口 getContactLidAndPhone（内部就是 enforceLidAndPnRetrieval，
  //    查不到会自己发一次 queryWidExists 网络查询再查，见 Client.js:3307）
  if (client && typeof client.getContactLidAndPhone === 'function') {
    try {
      const arr = await withTimeout(client.getContactLidAndPhone([jid]), timeoutMs, '查LID号码');
      const pn = arr && arr[0] && arr[0].pn;
      const p = phoneFromJid(String(pn || ''));
      if (p) return p;
    } catch (e) { /* 换下一种问法 */ }
  }
  // ② 直接调注入层（老版本 wwjs 可能没有上面那个方法）
  if (!client || !client.pupPage || typeof client.pupPage.evaluate !== 'function') return '';
  let raw = '';
  try {
    raw = await withTimeout(
      client.pupPage.evaluate(async (wid) => {
        try {
          const r = await window.WWebJS.enforceLidAndPnRetrieval(wid);
          const p = r && r.phone;
          if (!p) return '';
          return typeof p === 'string' ? p : (p._serialized || p.user || '');
        } catch (e) {
          return '';
        }
      }, jid),
      timeoutMs,
      '查LID号码',
    );
  } catch (e) {
    raw = '';
  }
  const s = String(raw || '');
  if (!s) return '';
  return phoneFromJid(s.includes('@') ? s : `${s}@c.us`);
}

/**
 * 直接从 **WhatsApp 网页 DOM** 里抠号码（2026-09-29 用户点名要的"任何手段"）。
 *
 * 用户给的实锤位置（WhatsApp Web 里这位客户的号码就明晃晃挂在那儿）：
 *   · `[data-testid="conversation-info-header-chat-title"]`  —— 顶部会话标题（号码型联系人直接显示号码）
 *   · `[data-testid="contact-info-subtitle"]`               —— 点开联系人信息那行的副标题
 * 还有第三处 `[dir="auto"].xnpuxes` 的小字。直接读这些 DOM 文本，再用 phoneFromText 抽号码，
 * 比猜 LID / 翻联系人接口都稳 —— 因为**网页上已经渲染出来了**。
 *
 * 为了拿得到，会先把这位客户的会话置顶（chat.open()）：没号码时才这么干，
 * 且只对"当前正在聊/刚来的"这条消息触发（见 resolve 的 scrapeDom 开关），不会乱切窗口。
 *
 * @returns {Promise<string>} 纯数字号码，拿不到就是 ''
 */
async function phoneFromWhatsappDom(client, jid, timeoutMs = CONTACT_TIMEOUT) {
  if (!client || !client.pupPage || typeof client.pupPage.evaluate !== 'function') return '';
  try {
    const raw = await withTimeout(
      client.pupPage.evaluate(async (wid) => {
        const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
        const want = digits(wid);
        // 先把这位客户的会话置顶，确保头部渲染出它的号码
        try {
          const Store = window.Store || (window.WWebJS && window.WWebJS.Store);
          let chat = null;
          if (Store && Store.Chat) {
            const cands = [wid, wid.replace(/@lid$/, '@c.us'), wid.replace(/@c\.us$/, '@s.whatsapp.net')];
            for (const id of cands) {
              try { chat = Store.Chat.get(id); } catch (e) { chat = null; }
              if (chat) break;
            }
            if (!chat && want) {
              const list = typeof Store.Chat.getModelsArray === 'function' ? Store.Chat.getModelsArray() : [];
              for (const c of list) {
                const idStr = (c && c.id && (c.id._serialized || c.id.user)) || '';
                const ct = (c && c.contact) || {};
                const ph = ct.phoneNumber
                  ? (ct.phoneNumber._serialized || ct.phoneNumber.user || '')
                  : (ct.number || '');
                if ((idStr && digits(idStr) === want) || (ph && digits(ph) === want)) { chat = c; break; }
              }
            }
            if (chat) { try { chat.open(); } catch (e) { /* ignore */ } }
          }
        } catch (e) { /* 开聊天失败不影响读 DOM */ }

        // 等头部渲染（open 是异步的）
        await new Promise((r) => setTimeout(r, 350));

        const txt = (sel) => {
          const el = document.querySelector(sel);
          return el ? (el.textContent || '').trim() : '';
        };
        // 头部整块（含右上角信息区）兜底
        const header = document.querySelector('header');
        return [
          // 用户 2026-09-29 实测的三个位置（号码直接明晃晃挂在这儿）
          txt('[data-testid="conversation-info-header-chat-title"]'),
          txt('[data-testid="contact-info-subtitle"]'),
          txt('[data-testid="conversation-info-header"]'),
          // 多备几处：不同 WhatsApp Web 版本见过这些 testid / 类名
          txt('[data-testid="cell-frame-title"]'),
          txt('[data-testid="chat-title"]'),
          txt('#main header span[title]') || (() => {
            const el = document.querySelector('#main header span[title]');
            return el ? el.getAttribute('title') || '' : '';
          })(),
          // 联系人信息面板（点开联系人详情时的号码行）
          txt('[data-testid="contact-info-panel"]'),
          header ? (header.innerText || '') : '',
          // 兜底：整个 #main 顶部的 textContent 里找（phoneFromText 只会认像号码的那段）
          (() => { const m = document.querySelector('#main'); return m ? (m.innerText || '').slice(0, 400) : ''; })(),
        ].join('\n');
      }, jid),
      timeoutMs,
      '读网页电话',
    );
    return phoneFromText(String(raw || ''));
  } catch (e) {
    return '';
  }
}

/**
 * 名字清洗：
 *   - 空 / 空白 → 不要
 *   - 和电话一模一样（WhatsApp 对没昵称的人会把号码当名字）→ 不要
 *   - 纯数字样式的（"+1 541 801 0646"）→ 不要
 */
function cleanName(n, phone) {
  const s = String(n == null ? '' : n).trim();
  if (!s) return '';
  const d = digitsOnly(s);
  const pd = digitsOnly(phone);
  if (d && d === pd) return '';
  // 去掉 + - ( ) 空格后全是数字 → 这不是名字
  if (d && s.replace(/[\d+\-()\s]/g, '') === '' && d.length >= 7) return '';
  return s;
}

/** Contact / Chat 上挑一个最像"客户名字"的字段 */
function nameFromContact(c, phone) {
  if (!c) return '';
  // name = 我通讯录里存的备注（有就用我的）；
  // pushname = 对方自己设的公开昵称（WhatsApp 网页版会话列表默认显示的就是它）；
  // verifiedName = 企业号认证名；shortName = 简称。
  return cleanName(c.name, phone)
    || cleanName(c.pushname, phone)
    || cleanName(c.verifiedName, phone)
    || cleanName(c.shortName, phone);
}

function nameFromChat(chat, phone) {
  if (!chat) return '';
  return cleanName(chat.name, phone) || cleanName(chat.formattedTitle, phone);
}

/** 给 Promise 加超时：浏览器卡住时不能把收消息链路拖死 */
function withTimeout(p, ms, label = '') {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label || '操作'}超时`)), ms)),
  ]);
}

/** 拿联系人：先试 msg.getContact()（自带 client），再退到 client.getContactById(jid) */
async function fetchContact(msg, client, jid, timeoutMs = CONTACT_TIMEOUT) {
  const jobs = [];
  if (msg && typeof msg.getContact === 'function') jobs.push(() => msg.getContact());
  if (client && typeof client.getContactById === 'function' && jid) jobs.push(() => client.getContactById(jid));
  for (const job of jobs) {
    try {
      const c = await withTimeout(job(), timeoutMs, '取联系人');
      if (c) return c;
    } catch (e) {
      /* 换下一种问法 */
    }
  }
  return null;
}

/** 拿会话：会话标题在联系人取不到时是最后一道兜底 */
async function fetchChat(msg, client, jid, timeoutMs = CHAT_TIMEOUT) {
  const jobs = [];
  if (msg && typeof msg.getChat === 'function') jobs.push(() => msg.getChat());
  if (client && typeof client.getChatById === 'function' && jid) jobs.push(() => client.getChatById(jid));
  for (const job of jobs) {
    try {
      const ch = await withTimeout(job(), timeoutMs, '取会话');
      if (ch) return ch;
    } catch (e) {
      /* 换下一种问法 */
    }
  }
  return null;
}

/**
 * 消息自带的那点身份（最稳的名字来源，不依赖 getContact / 不依赖当前打开了哪个聊天窗）
 * 1.34 的 Message 没有 pushName getter，但原始数据里带着发送方的显示名：
 *   _data.notifyName / _data.pushname / _data.sender.pushname 都能拿到对方在 WhatsApp 里设的公开昵称。
 * 这正是"在网页上能看到、但接口取不到"的那个名字 —— 优先从这里拿，拿不到再退到 getContact。
 */
function nameFromMsg(msg) {
  if (!msg) return '';
  const raw = msg.rawData || msg._data || {};
  const sender = raw.sender || (raw.chat && raw.chat.sender) || {};
  return cleanName(
    msg.pushName
    || raw.pushName
    || msg.notifyName
    || raw.notifyName
    || sender.pushname
    || sender.notifyName
    || '',
    '',
  );
}

/**
 * 解析一条消息背后的客户身份
 *
 * 电话的取法，从最可信往下排（拿到就走，不再往下问）：
 *   ① JID 本身就是手机号会话（@c.us / @s.whatsapp.net）
 *   ② Contact.number（且不像 LID）
 *   ③ 问 WhatsApp 要 LID → 真号码 的映射（enforceLidAndPnRetrieval）
 *   ④ 消息正文里客户自己打出来的号码（刚加进来的客户常这么给）
 * 任何一步拿到的号码，只要"是 LID 抄来的"一律作废（isLidPhone）。
 *
 * @param {object} msg whatsapp-web.js 的 Message（也可以是同形状的假对象）
 * @param {object} opt { client, jid, force, text, timeoutMs }
 * @returns {Promise<{name:string, phone:string}>} 拿不到就是空串，不会抛
 */
async function resolve(msg, opt = {}) {
  const jid = stripDevice(opt.jid || jidOfMessage(msg) || '');
  const body = String(opt.text != null ? opt.text : (msg && msg.body) || '');

  // ① 消息自带 + JID 直接能推出号码 → 不必问浏览器（绝大多数情况走这条，最快）
  const name0 = nameFromMsg(msg);
  const phone0 = phoneFromJid(jid);
  if (name0 && phone0) {
    cache.set(jid, { name: name0, phone: phone0, src: 'jid', ts: Date.now(), empty: false });
    return { name: name0, phone: phone0, phoneSrc: 'jid', country: countryOfPhone(phone0) };
  }

  // ② 缓存：同一个会话的几十条历史消息只问一次浏览器
  //
  // 2026-10-07 用户要求"号码是空就启动抓取"——这跟老逻辑冲突过：
  // 老代码把**失败也缓存 60 秒**（MISS_TTL），所以客户连发 5 条、第 1 条抓不到，
  // 后面 4 条全部走缓存直接返回空，等于白抓。现在规矩改成：
  //   · 号码为空 **一律不读缓存**，每次来消息都重新抓（反正 miss 走的就是缓存里没有的结果）
  //   · 只有拿到过号码的才用缓存，且认来源一起带出来
  const hit = cache.get(jid);
  if (hit && !opt.force && hit.phone && Date.now() - hit.ts < HIT_TTL) {
    const p = hit.phone || phone0;
    return { name: hit.name || name0, phone: p, phoneSrc: hit.src || '', country: countryOfPhone(p) };
  }

  let name = name0;
  let phone = phone0;
  // 📌 记住号码是从哪一步拿到的（2026-10-07 新增）——决定这条号码可不可信、
  //    值不值得下次再重抓一遍跟它对比。取号路径分五级，见上面 SRC_RANK。
  let src = phone0 ? 'jid' : '';

  // ③ 问浏览器要联系人（LID 会话只有这一步能拿到真号码）
  const ms = Number(opt.timeoutMs) > 0 ? Number(opt.timeoutMs) : CONTACT_TIMEOUT;
  const c = await fetchContact(msg, opt.client, jid, ms);
  if (c) {
    const p = phoneFromContact(c);
    if (p && p !== phone) {
      phone = p;
      src = 'contact'; // WhatsApp 联系人给的，比 JID 推断更实
    }
    const n = nameFromContact(c, phone || p);
    if (n) name = n;
  }

  // ④ LID 会话：再直接问一次 WhatsApp 的 LID→真号码 映射（wwjs 注入层能力）
  if (!phone && isLidJid(jid)) {
    const p = await resolveLidPhone(opt.client, jid, ms);
    if (p) {
      phone = p;
      src = 'contact'; // 官方 LID→PN 接口，可信度同 contact
    }
  }

  // ④b 直接从网页 DOM 抠（用户在 WhatsApp 网页里一眼就能看到的那个号码）
  //    只在"有浏览器、且这条消息是实时来的"时才开聊天去读，登录后批量补身份时不乱切窗口
  if (!phone && opt.client && opt.client.pupPage && opt.scrapeDom !== false) {
    const p = await phoneFromWhatsappDom(opt.client, jid, ms);
    if (p) {
      phone = p;
      src = 'contact'; // 网页上肉眼可见的那个号，跟 Contact 同源
    }
  }

  // ⑤ 最后兜底：客户自己在消息里打出来的号码
  //    📌 这里要区分「原文带 +」（e164，最可信）和「客户只打了个裸号」（text，弱）。
  //       用户原话是"判断电话里有没有 +" —— 加号虽然被 digitsOnly 剥掉了，
  //       但"抓的那一刻原文带没带 +"这个信息只有这里知道，必须当场抓住。
  if (!phone && body) {
    const p = phoneFromText(body);
    if (p) {
      phone = p;
      src = /\+\s?\d|00\d/.test(body) ? 'e164' : 'text';
    }
  }

  // 保险丝：不管从哪一步来的，是 LID 抄来的一律作废
  if (phone && isLidPhone(jid, phone)) {
    phone = '';
    src = '';
  }

  // ⑥ 兜底：会话标题（联系人取不到时，聊天窗口顶上那个名字总归是对的）
  if (!name) {
    const chat = await fetchChat(msg, opt.client, jid, ms);
    const n = nameFromChat(chat, phone);
    if (n) name = n;
  }

  const out = { name: name || '', phone: phone || '', phoneSrc: phone ? src : '' };
  // 无论号码来自 JID / Contact / 网页 DOM / 消息正文，都反查一下属于哪个国家，
  // 自动标注客户地区（对欧美油画生意有用，也顺带验证号码确实是带合法区号的国际号）。
  // 始终带着 country 字段（无号码则为空串），让返回结构稳定、前端不必判空。
  out.country = out.phone ? countryOfPhone(out.phone) : '';
  // 🔴 号码为空时**不写缓存**（老代码写 empty:true + 60s TTL，导致后续消息全走空缓存）。
  //    只记成功的，下次同一会话再来消息才会重新问一遍浏览器。
  if (out.phone || out.name) {
    cache.set(jid, { name: out.name, phone: out.phone, src: out.phoneSrc, ts: Date.now(), empty: !out.name && !out.phone });
  }
  return out;
}

/** 测试用：清空缓存 */
function clearCache() {
  cache.clear();
}

module.exports = {
  resolve,
  clearCache,
  SRC_RANK,
  // 下面这些是纯函数，单测直接测它们
  digitsOnly,
  plausiblePhone,
  isLidJid,
  isLidPhone,
  phoneFromJid,
  phoneFromContact,
  phoneFromText,
  cleanName,
  nameFromContact,
  nameFromChat,
  jidOf,
  jidOfMessage,
  // 需要浏览器（注入层的 LID→真号码 查询），单测里给假 client 也能跑
  resolveLidPhone,
  // 国际区号白名单（2026-09-29 晚加）
  INTL_DIAL_CODES,
  COUNTRY_BY_CODE,
  parseIntlPhone,
  countryOfPhone,
};
