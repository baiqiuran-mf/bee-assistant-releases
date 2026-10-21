/**
 * 地区 → 时区（**纯本地表，不调 AI**）
 *
 * 为什么要有这个文件（2026-09-25 用户提问）：
 *   "能不能设计个本地数据，记录所有美国、加拿大的州名地区名，然后和本国的时间差，
 *    根据客户资料里的地区直接提取当地时间，至少存下来之后不需要每次调用 AI。"
 *
 * 答案分两半，很重要：
 *
 * ① 地区 → 时区：**查这张表就够了**，不需要 AI。
 *    表里放美国 50 州 + 特区 + 属地、加拿大 13 省区、两国主要城市，以及中英文别名。
 *
 * ② 时区 → 当地时间 / 时差：**存"时区名"，不要存"差几个小时"**。
 *    这是关键坑：美国和加拿大大部分地区一年换两次时间（夏令时 3 月 / 11 月）。
 *    如果客户档案里存死"比北京晚 15 小时"，那半年后它就会错一个小时，
 *    而且你会发现所有的客户都不准了。
 *    正确做法是存 IANA 时区名（America/Los_Angeles 这种），
 *    每次要用的时候用系统时区库（Intl）现算 —— 夏令时自动处理，永远准。
 *    src/customerDoc.js 的 tzOffsetMinutes() / timeDiffFromBeijing() 就是干这个的。
 *
 * 所以：表里存的每一行都是 { 地区写法 → IANA 时区名 }，没有一行是"小时数"。
 */

/* ============================================================
 *  表：地区写法 → 时区
 *
 *  每一行 = [ [这个地区的中文写法、英文写法、常见别名…], IANA 时区名 ]
 *
 *  注意：跨时区的州（佛罗里达、德州、密歇根、印第安纳、肯塔基、田纳西、
 *  北达科他、南达科他、内布拉斯加、堪萨斯、爱达荷、俄勒冈、内华达），
 *  这里填的是该州**主要城市所在的那个时区**。客户如果在小地方，
 *  你可以在「客户档案」弹窗里手动把时区改掉 —— 手填的永远优先。
 * ============================================================ */

const TABLE = [
  /* ---------------- 美国 · 50 州 ---------------- */
  [['alabama', '阿拉巴马', '阿拉巴马州'], 'America/Chicago'],
  [['alaska', '阿拉斯加', '阿拉斯加州'], 'America/Anchorage'],
  [['arizona', '亚利桑那', '亚利桑那州', '凤凰城', '菲尼克斯'], 'America/Phoenix'],
  [['arkansas', '阿肯色', '阿肯色州'], 'America/Chicago'],
  [['california', '加利福尼亚', '加利福尼亚州', '加州', '加州州'], 'America/Los_Angeles'],
  [['colorado', '科罗拉多', '科罗拉多州'], 'America/Denver'],
  [['connecticut', '康涅狄格', '康涅狄格州', '康州'], 'America/New_York'],
  [['delaware', '特拉华', '特拉华州'], 'America/New_York'],
  [['florida', '佛罗里达', '佛罗里达州', '佛州', '弗罗里达'], 'America/New_York'],
  [['georgia', '佐治亚', '佐治亚州', '乔治亚'], 'America/New_York'],
  [['hawaii', '夏威夷', '夏威夷州', '檀香山'], 'Pacific/Honolulu'],
  [['idaho', '爱达荷', '爱达荷州'], 'America/Denver'],
  [['illinois', '伊利诺伊', '伊利诺伊州', '伊利诺斯'], 'America/Chicago'],
  [['indiana', '印第安纳', '印第安纳州'], 'America/New_York'],
  [['iowa', '艾奥瓦', '艾奥瓦州', '爱荷华', '衣阿华'], 'America/Chicago'],
  [['kansas', '堪萨斯', '堪萨斯州'], 'America/Chicago'],
  [['kentucky', '肯塔基', '肯塔基州'], 'America/New_York'],
  [['louisiana', '路易斯安那', '路易斯安那州'], 'America/Chicago'],
  [['maine', '缅因', '缅因州'], 'America/New_York'],
  [['maryland', '马里兰', '马里兰州'], 'America/New_York'],
  [['massachusetts', '马萨诸塞', '马萨诸塞州', '麻省', '麻州'], 'America/New_York'],
  [['michigan', '密歇根', '密歇根州', '密执安'], 'America/New_York'],
  [['minnesota', '明尼苏达', '明尼苏达州'], 'America/Chicago'],
  [['mississippi', '密西西比', '密西西比州'], 'America/Chicago'],
  [['missouri', '密苏里', '密苏里州'], 'America/Chicago'],
  [['montana', '蒙大拿', '蒙大拿州'], 'America/Denver'],
  [['nebraska', '内布拉斯加', '内布拉斯加州'], 'America/Chicago'],
  [['nevada', '内华达', '内华达州'], 'America/Los_Angeles'],
  [['new hampshire', '新罕布什尔', '新罕布什尔州'], 'America/New_York'],
  [['new jersey', '新泽西', '新泽西州'], 'America/New_York'],
  [['new mexico', '新墨西哥', '新墨西哥州'], 'America/Denver'],
  [['new york state', '纽约州', '纽约上州'], 'America/New_York'],
  [['new york', '纽约', '纽约市', '布鲁克林', '皇后区', '曼哈顿'], 'America/New_York'],
  [['north carolina', '北卡罗来纳', '北卡罗来纳州', '北卡'], 'America/New_York'],
  [['north dakota', '北达科他', '北达科他州'], 'America/Chicago'],
  [['ohio', '俄亥俄', '俄亥俄州'], 'America/New_York'],
  [['oklahoma', '俄克拉荷马', '俄克拉荷马州', '俄克拉何马'], 'America/Chicago'],
  [['oregon', '俄勒冈', '俄勒冈州', '奥勒冈'], 'America/Los_Angeles'],
  [['pennsylvania', '宾夕法尼亚', '宾夕法尼亚州', '宾州', '宾西法尼亚'], 'America/New_York'],
  [['rhode island', '罗德岛', '罗德岛州'], 'America/New_York'],
  [['south carolina', '南卡罗来纳', '南卡罗来纳州', '南卡'], 'America/New_York'],
  [['south dakota', '南达科他', '南达科他州'], 'America/Chicago'],
  [['tennessee', '田纳西', '田纳西州'], 'America/Chicago'],
  [['texas', '德克萨斯', '德克萨斯州', '得克萨斯', '德州', '得州'], 'America/Chicago'],
  [['utah', '犹他', '犹他州'], 'America/Denver'],
  [['vermont', '佛蒙特', '佛蒙特州'], 'America/New_York'],
  [['virginia', '弗吉尼亚', '弗吉尼亚州'], 'America/New_York'],
  [['washington state', '华盛顿州', '西雅图'], 'America/Los_Angeles'],
  [['washington', '华盛顿', '华盛顿特区', '哥伦比亚特区', '华府'], 'America/New_York'],
  [['west virginia', '西弗吉尼亚', '西弗吉尼亚州'], 'America/New_York'],
  [['wisconsin', '威斯康星', '威斯康星州'], 'America/Chicago'],
  [['wyoming', '怀俄明', '怀俄明州'], 'America/Denver'],
  [['puerto rico', '波多黎各'], 'America/Puerto_Rico'],

  /* ---------------- 加拿大 · 13 个省 / 地区 ---------------- */
  [['alberta', '阿尔伯塔', '阿尔伯塔省', '艾伯塔', '亚伯达'], 'America/Edmonton'],
  [['british columbia', '不列颠哥伦比亚', '不列颠哥伦比亚省', '卑诗', '卑诗省'], 'America/Vancouver'],
  [['manitoba', '曼尼托巴', '曼尼托巴省'], 'America/Winnipeg'],
  [['new brunswick', '新不伦瑞克', '新不伦瑞克省', '新布伦瑞克'], 'America/Moncton'],
  [['newfoundland', '纽芬兰', '纽芬兰省', '纽芬兰与拉布拉多'], 'America/St_Johns'],
  [['nova scotia', '新斯科舍', '新斯科舍省'], 'America/Halifax'],
  [['ontario', '安大略', '安大略省'], 'America/Toronto'],
  [['prince edward island', '爱德华王子岛', '爱德华王子岛省'], 'America/Halifax'],
  [['quebec', '魁北克', '魁北克省'], 'America/Toronto'],
  [['saskatchewan', '萨斯喀彻温', '萨斯喀彻温省', '萨省'], 'America/Regina'],
  [['northwest territories', '西北地区', '西北领地'], 'America/Yellowknife'],
  [['nunavut', '努纳武特', '努纳武特地区'], 'America/Iqaluit'],
  [['yukon', '育空', '育空地区'], 'America/Whitehorse'],

  /* ---------------- 美国 / 加拿大 主要城市 ---------------- */
  [['los angeles', '洛杉矶'], 'America/Los_Angeles'],
  [['san francisco', '旧金山', '三藩市', '圣弗朗西斯科', '硅谷'], 'America/Los_Angeles'],
  [['san jose', '圣何塞', '圣荷西'], 'America/Los_Angeles'],
  [['san diego', '圣地亚哥', '圣迭戈'], 'America/Los_Angeles'],
  [['sacramento', '萨克拉门托'], 'America/Los_Angeles'],
  [['seattle', '西雅图'], 'America/Los_Angeles'],
  [['portland', '波特兰'], 'America/Los_Angeles'],
  [['las vegas', '拉斯维加斯', '赌城'], 'America/Los_Angeles'],
  [['phoenix', '凤凰城', '菲尼克斯'], 'America/Phoenix'],
  [['tucson', '图森'], 'America/Phoenix'],
  [['denver', '丹佛'], 'America/Denver'],
  [['salt lake city', '盐湖城'], 'America/Denver'],
  [['albuquerque', '阿尔伯克基'], 'America/Denver'],
  [['chicago', '芝加哥'], 'America/Chicago'],
  [['houston', '休斯顿', '休斯敦'], 'America/Chicago'],
  [['dallas', '达拉斯'], 'America/Chicago'],
  [['austin', '奥斯汀'], 'America/Chicago'],
  [['san antonio', '圣安东尼奥'], 'America/Chicago'],
  [['fort worth', '沃斯堡'], 'America/Chicago'],
  [['minneapolis', '明尼阿波利斯'], 'America/Chicago'],
  [['st. louis', 'st louis', '圣路易斯'], 'America/Chicago'],
  [['kansas city', '堪萨斯城'], 'America/Chicago'],
  [['omaha', '奥马哈'], 'America/Chicago'],
  [['new orleans', '新奥尔良'], 'America/Chicago'],
  [['memphis', '孟菲斯'], 'America/Chicago'],
  [['nashville', '纳什维尔'], 'America/Chicago'],
  [['milwaukee', '密尔沃基'], 'America/Chicago'],
  [['des moines', '得梅因'], 'America/Chicago'],
  [['atlanta', '亚特兰大'], 'America/New_York'],
  [['miami', '迈阿密'], 'America/New_York'],
  [['orlando', '奥兰多'], 'America/New_York'],
  [['tampa', '坦帕'], 'America/New_York'],
  [['jacksonville', '杰克逊维尔'], 'America/New_York'],
  [['charlotte', '夏洛特'], 'America/New_York'],
  [['raleigh', '罗利'], 'America/New_York'],
  [['richmond', '里士满'], 'America/New_York'],
  [['baltimore', '巴尔的摩'], 'America/New_York'],
  [['philadelphia', '费城'], 'America/New_York'],
  [['pittsburgh', '匹兹堡'], 'America/New_York'],
  [['boston', '波士顿'], 'America/New_York'],
  [['cleveland', '克利夫兰'], 'America/New_York'],
  [['columbus', '哥伦布'], 'America/New_York'],
  [['cincinnati', '辛辛那提'], 'America/New_York'],
  [['detroit', '底特律'], 'America/New_York'],
  [['indianapolis', '印第安纳波利斯'], 'America/New_York'],
  [['buffalo', '布法罗', '水牛城'], 'America/New_York'],
  [['anchorage', '安克雷奇'], 'America/Anchorage'],
  [['honolulu', '火奴鲁鲁'], 'Pacific/Honolulu'],
  [['toronto', '多伦多'], 'America/Toronto'],
  [['montreal', '蒙特利尔', '满地可'], 'America/Toronto'],
  [['ottawa', '渥太华'], 'America/Toronto'],
  [['quebec city', '魁北克城'], 'America/Toronto'],
  [['vancouver', '温哥华'], 'America/Vancouver'],
  [['victoria', '维多利亚'], 'America/Vancouver'],
  [['calgary', '卡尔加里'], 'America/Edmonton'],
  [['edmonton', '埃德蒙顿'], 'America/Edmonton'],
  [['winnipeg', '温尼伯'], 'America/Winnipeg'],
  [['regina', '里贾纳'], 'America/Regina'],
  [['saskatoon', '萨斯卡通'], 'America/Regina'],
  [['halifax', '哈利法克斯'], 'America/Halifax'],
  [['moncton', '蒙克顿'], 'America/Moncton'],
  [['st. johns', "st john's", '圣约翰斯'], 'America/St_Johns'],
  [['whitehorse', '白马市'], 'America/Whitehorse'],
  [['yellowknife', '耶洛奈夫'], 'America/Yellowknife'],

  /* ---------------- 其他常见国家 / 地区（顺手加上，客户不一定只在北美） ---------------- */
  [['united kingdom', 'england', 'britain', '伦敦', 'london', '英国', '英格兰'], 'Europe/London'],
  [['ireland', '都柏林', 'dublin', '爱尔兰'], 'Europe/Dublin'],
  [['germany', 'berlin', '柏林', '慕尼黑', 'munich', '法兰克福', 'frankfurt', '德国'], 'Europe/Berlin'],
  [['france', 'paris', '巴黎', '法国'], 'Europe/Paris'],
  [['netherlands', 'amsterdam', '阿姆斯特丹', '荷兰'], 'Europe/Amsterdam'],
  [['spain', 'madrid', 'barcelona', '马德里', '巴塞罗那', '西班牙'], 'Europe/Madrid'],
  [['italy', '罗马', 'rome', '米兰', 'milan', '意大利'], 'Europe/Rome'],
  [['switzerland', 'zurich', '苏黎世', '瑞士'], 'Europe/Zurich'],
  [['sweden', 'stockholm', '斯德哥尔摩', '瑞典'], 'Europe/Stockholm'],
  [['norway', 'oslo', '奥斯陆', '挪威'], 'Europe/Oslo'],
  [['poland', 'warsaw', '华沙', '波兰'], 'Europe/Warsaw'],
  [['russia', 'moscow', '莫斯科', '俄罗斯'], 'Europe/Moscow'],
  [['turkey', 'istanbul', '伊斯坦布尔', '土耳其'], 'Europe/Istanbul'],
  [['dubai', '迪拜', 'uae', '阿联酋'], 'Asia/Dubai'],
  [['israel', 'tel aviv', '特拉维夫', '以色列'], 'Asia/Jerusalem'],
  [['india', 'mumbai', 'delhi', 'new delhi', '孟买', '新德里', '印度'], 'Asia/Kolkata'],
  [['thailand', 'bangkok', '曼谷', '泰国'], 'Asia/Bangkok'],
  [['vietnam', 'hanoi', 'ho chi minh', '河内', '胡志明', '越南'], 'Asia/Ho_Chi_Minh'],
  [['indonesia', 'jakarta', '雅加达', '印尼', '印度尼西亚'], 'Asia/Jakarta'],
  [['philippines', 'manila', '马尼拉', '菲律宾'], 'Asia/Manila'],
  [['singapore', '新加坡'], 'Asia/Singapore'],
  [['malaysia', 'kuala lumpur', '吉隆坡', '马来西亚'], 'Asia/Kuala_Lumpur'],
  [['japan', 'tokyo', '东京', '大阪', 'osaka', '日本'], 'Asia/Tokyo'],
  [['korea', 'seoul', '首尔', '韩国'], 'Asia/Seoul'],
  [['hong kong', '香港'], 'Asia/Hong_Kong'],
  [['macau', 'macao', '澳门'], 'Asia/Macau'],
  [['taiwan', 'taipei', '台北', '台湾'], 'Asia/Taipei'],
  [['beijing', '北京'], 'Asia/Shanghai'],
  [['shanghai', '上海'], 'Asia/Shanghai'],
  [['shenzhen', '深圳'], 'Asia/Shanghai'],
  [['guangzhou', '广州'], 'Asia/Shanghai'],
  [['chengdu', '成都'], 'Asia/Shanghai'],
  [['hangzhou', '杭州'], 'Asia/Shanghai'],
  [['xiamen', '厦门'], 'Asia/Shanghai'],
  [['china', '中国'], 'Asia/Shanghai'],
  [['australia', 'sydney', '悉尼', '澳大利亚', '澳洲'], 'Australia/Sydney'],
  [['melbourne', '墨尔本'], 'Australia/Melbourne'],
  [['brisbane', '布里斯班'], 'Australia/Brisbane'],
  [['perth', '珀斯'], 'Australia/Perth'],
  [['adelaide', '阿德莱德'], 'Australia/Adelaide'],
  [['new zealand', 'auckland', '奥克兰', '新西兰'], 'Pacific/Auckland'],
  [['canada', '加拿大'], 'America/Toronto'],
  [['united states', 'usa', 'america', '美国', '美利坚'], 'America/New_York'],
  [['mexico', 'mexico city', '墨西哥', '墨西哥城'], 'America/Mexico_City'],
  [['brazil', 'sao paulo', '圣保罗', '巴西'], 'America/Sao_Paulo'],
  [['argentina', 'buenos aires', '布宜诺斯艾利斯', '阿根廷'], 'America/Argentina/Buenos_Aires'],
  [['south africa', 'cape town', 'johannesburg', '南非', '开普敦'], 'Africa/Johannesburg'],
  [['egypt', 'cairo', '开罗', '埃及'], 'Africa/Cairo'],
  [['nigeria', 'lagos', '拉各斯', '尼日利亚'], 'Africa/Lagos'],
];

/* ============================================================
 *  时区 → 中文说明（写在客户档案 / 界面上用的，比 America/Los_Angeles 好懂）
 * ============================================================ */

const TZ_CN = {
  'America/New_York': '美国东部时间',
  'America/Chicago': '美国中部时间',
  'America/Denver': '美国山地时间',
  'America/Phoenix': '美国山地时间（亚利桑那，夏天不调表）',
  'America/Los_Angeles': '美国太平洋时间',
  'America/Anchorage': '阿拉斯加时间',
  'Pacific/Honolulu': '夏威夷时间',
  'America/Puerto_Rico': '波多黎各时间',
  'America/St_Johns': '加拿大纽芬兰时间',
  'America/Halifax': '加拿大大西洋时间',
  'America/Moncton': '加拿大大西洋时间',
  'America/Toronto': '加拿大东部时间',
  'America/Winnipeg': '加拿大中部时间',
  'America/Regina': '加拿大中部时间（萨斯喀彻温，夏天不调表）',
  'America/Edmonton': '加拿大山地时间',
  'America/Vancouver': '加拿大太平洋时间',
  'America/Whitehorse': '育空时间',
  'America/Yellowknife': '加拿大山地时间（西北地区）',
  'America/Iqaluit': '加拿大东部时间（努纳武特）',
  'Asia/Shanghai': '中国标准时间',
  'Asia/Tokyo': '日本时间',
  'Asia/Seoul': '韩国时间',
  'Asia/Singapore': '新加坡时间',
  'Asia/Kuala_Lumpur': '马来西亚时间',
  'Asia/Hong_Kong': '中国香港时间',
  'Asia/Macau': '中国澳门时间',
  'Asia/Taipei': '中国台湾时间',
  'Asia/Bangkok': '泰国时间',
  'Asia/Manila': '菲律宾时间',
  'Asia/Jakarta': '印尼西部时间',
  'Asia/Dubai': '阿联酋时间',
  'Asia/Kolkata': '印度时间',
  'Europe/London': '英国时间',
  'Europe/Paris': '中欧时间（法国）',
  'Europe/Berlin': '中欧时间（德国）',
  'Europe/Madrid': '中欧时间（西班牙）',
  'Europe/Rome': '中欧时间（意大利）',
  'Europe/Amsterdam': '中欧时间（荷兰）',
  'Europe/Moscow': '莫斯科时间',
  'Australia/Sydney': '澳洲东部时间',
  'Australia/Melbourne': '澳洲东部时间',
  'Australia/Brisbane': '澳洲东部时间（布里斯班，夏天不调表）',
  'Australia/Perth': '澳洲西部时间',
  'Pacific/Auckland': '新西兰时间',
  'America/Mexico_City': '墨西哥城时间',
  'America/Sao_Paulo': '巴西时间',
};

/* ============================================================
 *  匹配
 * ============================================================ */

/** 把表压平、按 key 长度从长到短排 —— 长的先匹配，避免「华盛顿州」被「华盛顿」抢走 */
const FLAT = TABLE
  .reduce((acc, [keys, tz]) => {
    for (const k of keys) acc.push({ key: String(k).toLowerCase(), tz });
    return acc;
  }, [])
  .sort((a, b) => b.key.length - a.key.length);

const EXACT = new Map(FLAT.map((e) => [e.key, e.tz]));

/** 表里一共有多少种写法（界面上/文档里报个数用） */
function regionCount() {
  return FLAT.length;
}

/**
 * 查地区对应的时区。
 * @param {string} region 客户档案里的地区，如「美国 俄勒冈」「Portland, OR」「加拿大 安大略」
 * @returns {{timezone:string, matched:string}|null}
 */
function matchRegion(region) {
  if (region == null) return null;
  const raw = String(region).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return null;

  // 1) 整串就是某个写法（最准）
  if (EXACT.has(raw)) return { timezone: EXACT.get(raw), matched: raw };

  // 2) 包含匹配：长 key 优先
  for (const e of FLAT) {
    if (raw.includes(e.key)) return { timezone: e.tz, matched: e.key };
  }
  return null;
}

/**
 * 只想要时区名的时候用它（和旧接口兼容）。
 * 查不到返回 null —— 调用方要么让用户手填，要么去问 AI（但要记得把结果存回档案，
 * 下次就查得到了，不用再问）。
 */
function guessTimezone(region) {
  const m = matchRegion(region);
  return m ? m.timezone : null;
}

/** 命中的是哪个写法（排查"为什么认成这个时区"） */
function matchedKey(region) {
  const m = matchRegion(region);
  return m ? m.matched : null;
}

/** 时区的中文说法，没有就原样返回 */
function tzName(timezone) {
  if (!timezone) return '';
  return TZ_CN[timezone] || timezone;
}

module.exports = { guessTimezone, matchRegion, matchedKey, tzName, regionCount, TZ_CN, TABLE };
