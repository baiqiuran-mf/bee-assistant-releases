/**
 * 教练引擎：判断现在在第几天、该往哪走、从哪个角度说
 *
 * 天数不是日历天数，是**关系进度**。信号到了才算推进。
 * 手动指定的 stage_day 优先于自动判定；自动判定时会给出命中的信号，方便你核对。
 */

const learn = require('./learn');

/* ---------------- 七天目标与偏好角度 ---------------- */

const PLAYBOOK = {
  0: {
    goal: '让他回第二句，且这句带信息量。只做自我介绍和问一个关于宠物的问题，不报价、不发作品集。',
    angles: ['curiosity', 'share', 'humor'],
  },
  1: {
    goal: '把"卖家和客人"扭成两个聊宠物的人。聊名字、性格、怪癖，你自己也讲一点生活碎片。',
    angles: ['curiosity', 'empathy', 'share'],
  },
  2: {
    goal: '用作品建立专业信任。分享创作过程，而不是展示成品；让他发一张清楚的宠物照片。',
    angles: ['story', 'share', 'curiosity'],
  },
  3: {
    goal: '视频通话，信任跃迁。给他看画布和工作室，别谈钱。',
    angles: ['nudge', 'share', 'reassure'],
  },
  4: {
    goal: '摸清他为什么想要这幅画——挂在哪、送给谁、宠物多大了。动机比预算重要。',
    angles: ['empathy', 'story', 'curiosity'],
  },
  5: {
    goal: '把想要变成具体：尺寸、摆放位置、时间节点。可以给价格区间，但不发报价单。',
    angles: ['nudge', 'reassure', 'curiosity'],
  },
  6: {
    goal: '给两个具体方案让他选。他犹豫就问他犹豫什么，问出来别猜。',
    angles: ['close', 'reassure', 'nudge'],
  },
  7: {
    goal: '成了就进流程并发开工照；没成就一句"没事，随时聊"，真的不再提。',
    angles: ['close', 'retreat', 'reassure'],
  },
};

const ANGLE_LABEL = {
  empathy: '共情',
  curiosity: '好奇',
  story: '故事',
  humor: '幽默',
  share: '分享',
  nudge: '轻推进',
  reassure: '打消顾虑',
  close: '收口',
  retreat: '退让',
};

/**
 * 信号关键词：命中就把阶段顶到对应天数
 * 注意是"顶到"，不是"加一天"——信号是里程碑
 */
/**
 * 注意：中文不能加 \b —— 单词边界只对 ASCII 生效，汉字永远匹配不上。
 * 所以每条正则都是「英文用 \b 版 | 中文裸词」的或关系。
 */
const SIGNALS = [
  { day: 7, key: 'confirmed', label: '已确认订单', re: /\b(start|started|begin|invoice|deposit\s+paid|order\s+confirm)\b|开工|已付|确定要/i },
  { day: 6, key: 'deal', label: '谈到付款或下单', re: /\b(pay|paid|payment|deposit|order|checkout|card|zelle|paypal)\b|怎么付|下单|付款|定金|订金/i },
  { day: 5, key: 'spec', label: '聊到尺寸或时间', re: /\b(size|inch|inches|cm|dimension|wall|frame|how\s+long|deadline|by\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\b|尺寸|多大|多久|挂墙|相框/i },
  { day: 4, key: 'motive', label: '说出动机或场景', re: /\b(for\s+my\s+(mom|mother|dad|father|wife|husband|sister|brother)|gift|birthday|anniversary|memorial|in\s+memory|passed\s+away|getting\s+old|she\s+is\s+\d+|he\s+is\s+\d+)\b|纪念|生日|周年|挂在|摆在|想念|已经很老|它很老/i },
  { day: 3, key: 'video', label: '提到视频通话', re: /\b(video|facetime|zoom|call\s+you|hop\s+on\s+a\s+call|see\s+you\s+live)\b|视频|通话|语音通|见个面/i },
  { day: 2, key: 'photo', label: '发来照片 / 聊作品', re: /\b(here\s+is|heres|attached|sending\s+a\s+photo|pics?|photos?|portfolio|your\s+work|your\s+painting)\b|照片|作品|发给你看|看看你的画/i },
];

/**
 * 判定阶段
 * @param {object} customer customers 表一行
 * @param {Array} messages 消息列表（按时间升序）
 * @returns {{day:number, source:'manual'|'auto'|'none', signals:Array, confidence:number}}
 */
function inferDay(customer, messages = []) {
  const inMsgs = messages.filter((m) => m.direction === 'in');
  const text = messages
    .slice(-30)
    .map((m) => `${m.body || ''} ${m.body_zh || ''}`)
    .join('\n');

  const signals = [];
  let autoDay = 0;

  for (const s of SIGNALS) {
    if (s.re.test(text)) {
      signals.push({ key: s.key, label: s.label, day: s.day });
      if (s.day > autoDay) autoDay = s.day;
    }
  }

  // 有图片消息也能顶到 Day 2（照片到手了）
  if (autoDay < 2 && messages.some((m) => m.direction === 'in' && m.media_path)) {
    signals.push({ key: 'photo', label: '收到图片', day: 2 });
    autoDay = 2;
  }

  // 对话轮次兜底：客户回复越多，至少不在头两天
  const rounds = inMsgs.length;
  const byRounds = rounds <= 1 ? 0 : rounds <= 3 ? 1 : rounds <= 6 ? 2 : 3;
  if (autoDay < byRounds) autoDay = byRounds;

  // 手动指定的优先
  const manual = Number(customer?.stage_day);
  if (Number.isFinite(manual) && manual > 0) {
    return { day: Math.min(manual, 7), source: 'manual', signals, confidence: 1 };
  }

  return {
    day: Math.min(autoDay, 7),
    source: signals.length || rounds > 0 ? 'auto' : 'none',
    signals,
    confidence: signals.length ? 0.8 : rounds > 0 ? 0.5 : 0.2,
  };
}

/**
 * 挑角度：按当天偏好排序，压掉最近被否多的角度
 * @param {number} day
 * @param {object} opt {exclude:string[], text:string}
 * @returns {string[]}
 */
function pickAngles(day, opt = {}) {
  const pref = (PLAYBOOK[day] || PLAYBOOK[0]).angles.slice();
  const all = Object.keys(ANGLE_LABEL);
  const ordered = [...pref, ...all.filter((a) => !pref.includes(a))];

  const exclude = new Set(opt.exclude || []);
  return ordered.filter((a) => {
    if (exclude.has(a)) return false;
    // 这个角度被否过 3 次以上，暂时不用
    return learn.rejectCountOfAngle(a) < 3;
  });
}

/**
 * 组装注入模型的教练上下文
 * @param {object} p {day, angles, scene}
 * @returns {string}
 */
function buildCoachBlock(p) {
  const { day, angles, scene } = p;
  const plan = PLAYBOOK[day] || PLAYBOOK[0];
  const lines = [
    `【当前阶段】Day ${day}`,
    `【今天只做一件事】${plan.goal}`,
    `【本轮角度】${(angles || []).map((a) => `${a}（${ANGLE_LABEL[a] || a}）`).join(' / ')}——每条建议用一个不同角度`,
  ];

  const ex = learn.findExemplars(scene || '', { day, limit: 4 });
  if (ex.length) {
    lines.push('');
    lines.push('【你以前采纳过的思路，风格往这边靠，但不要照抄】');
    for (const e of ex) {
      lines.push(`- （${e.row.angle || '未标'} / Day${e.row.day ?? '?'}）${e.row.text}${e.row.note ? `　※${e.row.note}` : ''}`);
    }
  }

  const rj = learn.findRejections(scene || '', { limit: 4 });
  if (rj.length) {
    lines.push('');
    lines.push('【这些路子被否过，不要再往这边写】');
    for (const r of rj) {
      lines.push(`- ${r.row.text}${r.row.reason ? `　（原因：${r.row.reason}）` : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * 「加入后第几天」（1 起）——和前端中栏那个紫色 Day 徽标用同一个算法。
 * 加入当天 = Day 1；过了本地零点 = Day 2（对应"认识第 2 天"）。
 * 纯按加入时间算，不再跟内容信号走的 stage_day 混——否则左右两栏 Day 会对不上
 * （用户 2026-09-26 点名：右栏建议头里的 Day 要跟中栏一致；2026-09-29 起 Day 从 1 开始算）。
 * @param {object} customer customers 表一行（要有 created_at / joined_at）
 * @returns {number} 1 起整数（没加入时间返回 0）
 */
function joinDayOf(customer) {
  const ts = customer && (customer.created_at || customer.joined_at);
  if (!ts) return 0;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 0;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  return Math.max(1, diff + 1);
}

module.exports = {
  PLAYBOOK,
  ANGLE_LABEL,
  SIGNALS,
  inferDay,
  joinDayOf,
  pickAngles,
  buildCoachBlock,
};
