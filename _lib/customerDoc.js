/**
 * 每个客户一个档案文档
 *
 * 文件名：{名称}_{地区}_{编号}.md      例：Mike_旧金山_3A00050.md
 * 文档开头固定是客户信息头（名称、地区、编号、时间差、电话、加好友时间），
 * 下面是客户档案和完整对话记录。
 *
 * 改名/改地区时自动重命名，编号永远不变。
 */

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(__dirname, '..', 'data', 'customers');

/* ---------------- 时区推断 ---------------- */

const TZ_MAP = {
  // 中文
  旧金山: 'America/Los_Angeles', 洛杉矶: 'America/Los_Angeles', 加州: 'America/Los_Angeles',
  硅谷: 'America/Los_Angeles', 圣地亚哥: 'America/Los_Angeles', 西雅图: 'America/Los_Angeles',
  波特兰: 'America/Los_Angeles', 拉斯维加斯: 'America/Los_Angeles',
  纽约: 'America/New_York', 波士顿: 'America/New_York', 华盛顿: 'America/New_York',
  迈阿密: 'America/New_York', 亚特兰大: 'America/New_York', 费城: 'America/New_York',
  德州: 'America/Chicago', 休斯顿: 'America/Chicago', 达拉斯: 'America/Chicago',
  芝加哥: 'America/Chicago', 奥斯汀: 'America/Chicago', 新奥尔良: 'America/Chicago',
  丹佛: 'America/Denver', 凤凰城: 'America/Phoenix', 盐湖城: 'America/Denver',
  檀香山: 'Pacific/Honolulu', 阿拉斯加: 'America/Anchorage',
  // 英文
  'san francisco': 'America/Los_Angeles', 'los angeles': 'America/Los_Angeles',
  california: 'America/Los_Angeles', seattle: 'America/Los_Angeles', vegas: 'America/Los_Angeles',
  'new york': 'America/New_York', boston: 'America/New_York', florida: 'America/New_York',
  miami: 'America/New_York', atlanta: 'America/New_York',
  texas: 'America/Chicago', houston: 'America/Chicago', dallas: 'America/Chicago',
  chicago: 'America/Chicago', austin: 'America/Chicago',
  denver: 'America/Denver', phoenix: 'America/Phoenix', hawaii: 'Pacific/Honolulu',
};

function guessTimezone(region) {
  if (!region) return null;
  const r = String(region).trim().toLowerCase();
  for (const [key, tz] of Object.entries(TZ_MAP)) {
    if (r.includes(key.toLowerCase())) return tz;
  }
  return null;
}

/** 某时区相对 UTC 的偏移分钟数（自动处理夏令时） */
function tzOffsetMinutes(timezone, date = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' });
    const part = dtf.formatToParts(date).find((p) => p.type === 'timeZoneName');
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part?.value || '');
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch (e) {
    return null;
  }
}

/**
 * 与北京时间（UTC+8）的时差描述
 * @returns {{text:string, hours:number, localTz:string|null}}
 */
function timeDiffFromBeijing(timezone, date = new Date()) {
  if (!timezone) return { text: '（地区未填，无法判断）', hours: null, localTz: null };
  const local = tzOffsetMinutes(timezone, date);
  const bj = tzOffsetMinutes('Asia/Shanghai', date) ?? 480;
  if (local == null) return { text: '（时区识别失败）', hours: null, localTz: timezone };

  const diffHours = (local - bj) / 60; // 负数=比北京晚
  let text;
  if (diffHours === 0) text = '与北京时间相同';
  else if (diffHours < 0) text = `当地时间比北京时间晚 ${Math.abs(diffHours)} 小时`;
  else text = `当地时间比北京时间早 ${diffHours} 小时`;

  const utcSign = local >= 0 ? '+' : '-';
  const utcH = Math.abs(local) / 60;
  return { text: `${text}（当地 UTC${utcSign}${utcH}）`, hours: diffHours, localTz: timezone };
}

/* ---------------- 文件名 ---------------- */

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
}

function docFileName(customer) {
  return `${safeName(customer.name) || '未命名'}_${safeName(customer.region) || '未知地区'}_${customer.code}.md`;
}

function findExistingDoc(code) {
  if (!fs.existsSync(DOCS_DIR)) return null;
  const f = fs.readdirSync(DOCS_DIR).find((n) => n.endsWith(`_${code}.md`));
  return f ? path.join(DOCS_DIR, f) : null;
}

/* ---------------- 渲染 ---------------- */

function fmtLocal(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderDoc(customer, messages = [], opts = {}) {
  const tz = customer.timezone || guessTimezone(customer.region);
  const diff = timeDiffFromBeijing(tz, new Date());
  const profile = safeParse(customer.profile_json);

  const head = [
    `# ${customer.name || '未命名'} · ${customer.region || '未知地区'} · ${customer.code}`,
    '',
    `> 编号 ${customer.code} 与此客户绑定，永不变更、永不复用。`,
    '',
    '## 客户信息',
    '',
    '| 项目 | 内容 |',
    '|---|---|',
    `| 编号 | **${customer.code}** |`,
    `| 姓名 | ${customer.name || '（未填写）'} |`,
    `| 地区 | ${customer.region || '（未填写）'} |`,
    `| 时间差 | ${diff.text} |`,
    `| 时区 | ${tz || '（未识别）'} |`,
    `| 电话号码 | ${customer.phone || '（未知）'} |`,
    `| 加好友时间 | ${fmtLocal(customer.created_at)} |`,
    `| 所属 WhatsApp 账号 | ${customer.account_id} 号 |`,
    `| 最近联系 | ${fmtLocal(customer.last_msg_at)} |`,
    `| 当前阶段 | Day ${customer.stage_day ?? 0} |`,
    `| 情绪 | ${customer.mood || '（未知）'} |`,
    '',
  ];

  const profilePart = [
    '## 客户档案',
    '',
    profile
      ? Object.entries(profile).map(([k, v]) => `- **${k}**：${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
      : '- （尚未抽取，生成建议后会自动填充）',
    '',
    customer.summary ? `**历史摘要**：${customer.summary}` : '',
    customer.summary ? '' : '',
  ];

  const dialogPart = ['## 对话记录', ''];
  if (!messages.length) {
    dialogPart.push('（暂无消息）');
  } else {
    for (const m of messages) {
      const who = m.direction === 'in' ? '客户' : '我';
      dialogPart.push(`**[${fmtLocal(m.msg_ts)}] ${who}**：${(m.body || '').replace(/\n/g, ' ')}`);
      if (m.body_zh) dialogPart.push(`　　└ 译：${m.body_zh}`);
      if (m.media_path) dialogPart.push(`　　└ 图片：${m.media_path}`);
      dialogPart.push('');
    }
  }

  return [...head, ...profilePart, ...dialogPart].join('\n');
}

function safeParse(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 写入（或更新）客户文档
 * @returns {string} 文档路径
 */
function writeCustomerDoc(customer, messages = [], opts = {}) {
  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

  const wanted = path.join(DOCS_DIR, docFileName(customer));
  const existing = findExistingDoc(customer.code);

  // 改名/改地区 -> 重命名旧文件
  if (existing && existing !== wanted && fs.existsSync(existing)) {
    fs.renameSync(existing, wanted);
  }

  fs.writeFileSync(wanted, renderDoc(customer, messages, opts), 'utf8');
  return wanted;
}

module.exports = {
  writeCustomerDoc,
  renderDoc,
  docFileName,
  findExistingDoc,
  guessTimezone,
  timeDiffFromBeijing,
  tzOffsetMinutes,
  DOCS_DIR,
};
