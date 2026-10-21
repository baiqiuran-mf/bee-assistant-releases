/**
 * 每个客户一个档案文档
 *
 * 文件名：{编号}_{名称}_{电话}.md      例：3A00050_Mike_1534685245.md
 *
 * 为什么 2026-09-26 换成这个顺序（用户要求）：
 *   电话号码提到文件名里，同一号码的两份档案一眼就能看出来 ——
 *   以前叫 {名称}_{地区}_{编号}.md，同名客户（比如三个 gfgdf）在文件夹里
 *   长得几乎一样，看不出"其实是同一个人重复建了三个档案"。
 *   现在编号打头（编号永不回收、唯一，利于排序和查找），电话收尾（用于查重）。
 *   旧格式（名称_地区_编号.md）继续能认，见 findExistingDoc / parseDocFileName。
 *
 * 文档开头固定是客户信息头（名称、地区、编号、时间差、电话、加好友时间），
 * 下面是客户档案和完整对话记录。
 *
 * 改名/改电话时自动重命名，编号永远不变。
 */

const fs = require('fs');
const path = require('path');

const paths = require('./paths');

/**
 * 档案目录。**每次都现取**，不在模块加载时写死 ——
 * 这样以后做成安装版、用户在「AI 设置」里改了 app.dataDir（或换了盘符），
 * 不用重启就能指到新目录，也不会出现"写去老路径"的鬼问题。
 */
function docsDir() {
  return paths.docsDir();
}

/* ---------------- 时区推断 ----------------
 * 2026-09-25 起改为查本地表 src/regions.js（覆盖美国 50 州 + 特区 + 属地、
 * 加拿大 13 省区、两国主要城市及中英文别名，共 regionCount() 种写法）。
 *
 * 设计要点（用户提问的回答就在这一条）：
 *   表里只存「地区写法 → IANA 时区名」，绝不存"差几小时"。
 *   美加一年换两次夏令时（3 月 / 11 月），存死的小时数半年后就错，
 *   而且你会发现所有客户的时差全错。正确做法是存 IANA 时区名，
 *   每次要用时交给系统时区库（Intl）现算 —— 夏令时自动处理，永远准，
 *   且**不需要调 AI**。客户档案里存的就是 timezone（IANA 名），不是小时数。
 *   更详细的说明见 src/regions.js 文件头注释。 */

const { guessTimezone, tzName, matchRegion, matchedKey, regionCount } = require('./regions');

/**
 * 手填的时差（2026-09-30 用户要求）
 *
 * 以前档案弹窗的「时区」栏填的是 IANA 时区名（America/New_York）——得懂英文才填得对，
 * 用户提出来改成**填数字**：填「和北京差几小时」（比北京晚填负数，比北京快填正数），
 * 只要 60px 的小框就够。
 *
 * 于是 timezone 这一列现在有两种写法，读取时按这个规则分辨：
 *   ① 纯数字（-12 / +3 / 0 / -2.5）→ **手填的时差**，优先，压过地区推算；
 *   ② 其他（America/New_York 这类 IANA 名、或空）→ 老数据/按地区自动推的时区，照旧交给 Intl 算。
 * 留空 = 按「地区」自动算时差，行为和以前一致（用户明确要求）。
 */
function tzManualHours(value) {
  const t = String(value == null ? '' : value).trim();
  if (!/^[+-]?\d{1,2}(?:\.\d)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 这个值是不是「手填的时差」（而不是 IANA 时区名） */
function isTzOffset(value) {
  return tzManualHours(value) !== null;
}

/** 只有「与北京的小时差」时，怎么说这句时差（和 timeDiffFromBeijing 同样的话术） */
function diffFromOffsetHours(hours) {
  let text;
  if (hours === 0) text = '与北京时间相同';
  else if (hours < 0) text = `当地时间比北京时间晚 ${Math.abs(hours)} 小时`;
  else text = `当地时间比北京时间早 ${hours} 小时`;

  // 北京 = UTC+8，所以当地 UTC 偏移 = 8 + 与北京的差（-12 → UTC-4，+3 → UTC+11）
  const utc = 8 + hours;
  const sign = utc >= 0 ? '+' : '-';
  return { text: `${text}（当地 UTC${sign}${Math.abs(utc)}）`, hours, localTz: null };
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

/** 电话号码放进文件名时统一成「只留数字和开头的 +」：+1 (541) 801-0646 → +15418010646 */
function safePhone(s) {
  const raw = safeName(s).replace(/[^\d+]/g, '');
  return raw || '';
}

/**
 * 档案文件名：{编号}_{名称}_{电话}.md
 *
 * 编号打头（唯一、永不回收，排序好看），电话收尾（用来查重：同一号码的档案
 * 文件名里会出现同一串数字，一眼能揪出来重复建档）。
 * 例：`3A00050_Mike_1534685245.md`
 */
function docFileName(customer) {
  const code = safeName(customer.code) || '未知编号';
  const name = safeName(customer.name) || '未命名';
  const phone = safePhone(customer.phone) || '未知电话';
  return `${code}_${name}_${phone}.md`;
}

/**
 * 从文件名反解出 {code, name, phone, legacy}。
 * 兼容两种格式：
 *   新 3A00050_Mike_1534685245.md  → code 在第一段
 *   旧 Mike_旧金山_3A00050.md      → code 在最后一段（第二段是地区）
 * 解不出来就返回 null（不认识的 .md 一律跳过，不去碰）。
 */
function parseDocFileName(fileName) {
  const base = String(fileName || '').replace(/\.md$/i, '');
  const parts = base.split('_');
  if (parts.length < 2) return null;
  const CODE_RE = /^[A-Z0-9]{4,}$/;
  // 新格式：第一段就是编号
  if (CODE_RE.test(parts[0])) {
    return {
      code: parts[0],
      name: parts.length > 1 ? parts[1] : '',
      phone: parts.length > 2 ? parts.slice(2).join('_') : '',
      legacy: false,
    };
  }
  // 旧格式：最后一段是编号
  const last = parts[parts.length - 1];
  if (CODE_RE.test(last)) {
    return {
      code: last,
      name: parts[0],
      region: parts.length > 2 ? parts[1] : '',   // 旧格式第二段是地区
      phone: '',
      legacy: true,
    };
  }
  return null;
}

/**
 * 找一个编号已有的档案文件。
 * 新格式（编号打头）优先；同时兼容旧格式（编号收尾），改名时才能把旧文件重命名掉。
 */
function findExistingDoc(code) {
  const dir = docsDir();
  if (!fs.existsSync(dir)) return null;
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return null; }
  const md = files.filter((n) => n.toLowerCase().endsWith('.md'));
  const byPrefix = md.find((n) => n.startsWith(`${code}_`));
  if (byPrefix) return path.join(dir, byPrefix);
  const bySuffix = md.find((n) => n.endsWith(`_${code}.md`));
  return bySuffix ? path.join(dir, bySuffix) : null;
}

/** 目录下所有档案文件（只第一层，不含备份子目录） */
function listDocFiles() {
  const dir = docsDir();
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.md'))
      .map((n) => ({ file: n, path: path.join(dir, n), ...(parseDocFileName(n) || {}) }));
  } catch (e) {
    return [];
  }
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
  // 时区两套口径（2026-09-30 用户要求，详见文件上方 tzManualHours 的注释）：
  //   填了数字 → 手填的时差优先（就算地区能推出时区，也以手填的为准）
  //   留空（或老数据里的 IANA 名）→ 按地区自动推
  const manualHours = tzManualHours(customer.timezone);
  const regionTz = guessTimezone(customer.region); // 按地区推出来的 IANA（诊断/展示用）
  const autoTz = manualHours != null ? regionTz : (customer.timezone || regionTz);
  const diff = manualHours != null ? diffFromOffsetHours(manualHours) : timeDiffFromBeijing(autoTz, new Date());
  const tzLabel = manualHours != null
    ? `手填时差 ${manualHours > 0 ? '+' : ''}${manualHours} 小时（按地区推测：${regionTz || '未识别'}）`
    : (autoTz || '（未识别）');

  // 极简档案：文档头部只呈现 5 个字段（加入时间 / 姓名 / 电话 / 地区 / 时区），
  // 不写情绪、爱好、动机等任何额外资料——和界面、AI 抽档保持一致。
  // 2026-09-30 用户要求：档案 md 里**不再记录任何 Day（阶段 / 认识第几天）**——
  // 「阶段」现在只在界面上按加入时间自动同步显示，不进档案文件。
  // 合并过重复档案时，在文件名下面写清"这份档案由哪几个编号并过来"，
  // 免得以后看着 3A00003 的档案里冒出 3A00050 的对话，以为串号了。
  const merged = Array.isArray(opts.mergedCodes) ? opts.mergedCodes.filter(Boolean) : [];
  const mergeNote = merged.length
    ? [`> 本档案已合并同一个电话号码下的重复档案：编号 ${merged.join('、')}。`,
      `> 被合并的那几份原始文件已备份到 customers/${opts.mergedBucket || '_merged_backup'}/，没有删除。`]
    : [];

  const head = [
    `# ${customer.name || '未命名'} · ${customer.region || '未知地区'} · ${customer.code}`,
    '',
    `> 编号 ${customer.code} 与此客户绑定，永不变更、永不复用。`,
    ...mergeNote,
    '',
    '## 客户信息',
    '',
    '| 项目 | 内容 |',
    '|---|---|',
    `| 编号 | **${customer.code}** |`,
    `| 姓名 | ${customer.name || '（未填写）'} |`,
    `| 地区 | ${customer.region || '（未填写）'} |`,
    `| 时间差 | ${diff.text} |`,
    `| 时区 | ${tzLabel} |`,
    `| 电话号码 | ${customer.phone || '（未知）'} |`,
    `| **加入时间** | **${fmtLocal(customer.created_at)}** |`,
    `| 加入时间来源 | ${customer.created_at_source === 'manual' ? '手动填写' : '系统自动'} |`,
    `| 所属 WhatsApp 账号 | ${customer.account_id} 号 |`,
    `| 最近联系 | ${fmtLocal(customer.last_msg_at)} |`,
    `| 消息条数 | ${messages.length} |`,
    '',
  ];

  // 附加 10 字段（存在 profile_json）：有值才写进文档，保持档案干净
  let extra = {};
  try {
    const raw = customer.profile_json;
    extra = raw && typeof raw === 'object' ? raw : JSON.parse(raw || '{}');
  } catch (e) { extra = {}; }
  const extraDefs = [
    ['婚姻情况', '婚姻情况'], ['生活规律', '生活规律'], ['别名', '别名'],
    ['老家家乡', '老家 / 家乡'], ['爱好', '爱好'], ['职业', '职业'],
    ['家庭经济情况', '家庭经济情况'], ['父母', '父母'], ['宠物', '宠物'], ['孩子', '孩子'],
  ];
  const extraRows = extraDefs.filter(([k]) => extra[k]).map(([k, label]) => `| ${label} | ${extra[k]} |`);
  if (extraRows.length) {
    head.push('', '## 更多资料（选填）', '', '| 项目 | 内容 |', '|---|---|', ...extraRows, '');
  }

  const dialogPart = ['## 对话记录', ''];
  // 图片/附件条数汇总（2026-10-07）：档案顶部就能一眼看到"这个客户发过几张图"，
  // 不用往下翻。图片本体存在 data/media/ 里，md 只记相对路径指路。
  const mediaCount = messages.filter((m) => m.media_path).length;
  if (mediaCount) {
    const kinds = {};
    messages.filter((m) => m.media_path).forEach((m) => {
      const k = m.media_type === 'sticker' ? '贴纸' : m.media_type === 'video' ? '视频'
        : (m.media_type === 'audio' || m.media_type === 'ptt') ? '语音' : '图片';
      kinds[k] = (kinds[k] || 0) + 1;
    });
    dialogPart.push(`> 共 ${messages.length} 条消息，其中附件 ${mediaCount} 个（`
      + Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join('、')
      + '）。图片文件存在 data/media/，下文每条只记文件名。', '');
  }
  if (!messages.length) {
    dialogPart.push('（暂无消息）');
  } else {
    for (const m of messages) {
      const who = m.direction === 'in' ? '客户' : '我';
      // 合并过来的对话标一下原编号，方便回溯（没合并时就是一个字都不多写）
      const from = (merged.length && m.customer_code && m.customer_code !== customer.code)
        ? `（原编号 ${m.customer_code}）` : '';
      dialogPart.push(`**[${fmtLocal(m.msg_ts)}] ${who}**${from}：${(m.body || '').replace(/\n/g, ' ')}`);
      if (m.body_zh) dialogPart.push(`　　└ 译：${m.body_zh}`);
      //图片 / 语音 / 附件（2026-10-07 改）
      //
      // 🔴 为什么**只记相对路径 + AI 中文说明**，不把图片 base64 塞进 md：
      //   档案全文会整段发给 AI 做「合并重复档案」（promptMergeDocs，每份截 8000 字符）。
      //   一张 75×100 的图 base64 就要 7000 字符 —— **一张图就把配额吃光了**，
      //   而且 AI 看图要走视觉模型，这里塞 base64 它也读不出来，纯浪费。
      //   所以 md 保持"人读的档案"，图片本体在 data/media/ 里，md 只指路。
      if (m.media_path) {
        const fname = String(m.media_path).split(/[\\/]/).pop();
        const isImg = (() => {
          const ext = String(fname).toLowerCase().replace(/^.*\./, '');
          return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext);
        })();
        // 真实媒体身份（media_type）：贴纸就是贴纸，不再一律写「图片」
        const what = m.media_type === 'sticker' ? '贴纸'
          : m.media_type === 'video' ? '视频'
            : m.media_type === 'audio' || m.media_type === 'ptt' ? '语音'
              : m.media_type === 'document' ? '文件'
                : isImg ? '图片' : '附件';
        // 路径写成相对 data/ 的形式（data/media/xxx.jpg），
        // 这样档案和图片一起搬走也不会失效 —— 不要写成 data/../media/ 这种绕路写法。
        const baseDir = path.dirname(docsDir());          // …/data
        const rel = path.relative(baseDir, m.media_path).split(path.sep).join('/');
        dialogPart.push(`　　└ ${what}：\`${rel}\`${m.media_src === 'base64' ? '（临时抢救的，刷新后可能失效）' : ''}`);
        // AI 看图给出的中文说明 —— 这才是档案里真正有价值的部分（人能看懂、AI 也能读）
        if (m.media_zh) dialogPart.push(`　　　${what}内容：${m.media_zh}`);
      }
      dialogPart.push('');
    }
  }

  return [...head, ...dialogPart].join('\n');
}

/**
 * 写入（或更新）客户文档
 * @returns {string} 文档路径
 */
function writeCustomerDoc(customer, messages = [], opts = {}) {
  const dir = docsDir();

  const wanted = path.join(dir, docFileName(customer));
  const existing = findExistingDoc(customer.code);

  // 改名 / 改电话 / 换到新命名格式 -> 把旧文件重命名掉（不留两份）
  if (existing && existing !== wanted && fs.existsSync(existing)) {
    try { fs.renameSync(existing, wanted); } catch (e) { /* 重命名失败就以 wanted 为准再写一份 */ }
  }

  fs.writeFileSync(wanted, renderDoc(customer, messages, opts), 'utf8');
  return wanted;
}

/**
 * 把某编号的档案文件挪进备份子目录（合并掉重复档案时用，绝不直接删）。
 * @returns {string|null} 挪到哪儿了
 */
function stashDocFile(code, bucket = '_merged_backup') {
  const existing = findExistingDoc(code);
  if (!existing || !fs.existsSync(existing)) return null;
  const dest = path.join(docsDir(), bucket);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const target = path.join(dest, path.basename(existing));
  try {
    fs.renameSync(existing, target);
    return target;
  } catch (e) {
    return null;
  }
}

module.exports = {
  writeCustomerDoc,
  renderDoc,
  docFileName,
  parseDocFileName,
  findExistingDoc,
  listDocFiles,
  stashDocFile,
  safeName,
  safePhone,
  docsDir,
  guessTimezone,
  tzName,
  matchRegion,
  matchedKey,
  regionCount,
  timeDiffFromBeijing,
  tzOffsetMinutes,
  // 手填时差（2026-09-30）：判断某一列是不是"与北京的小时差"，以及只按小时差说时差
  tzManualHours,
  isTzOffset,
  diffFromOffsetHours,
  /** @deprecated 用 docsDir()；保留只为兼容老调用，值是模块加载那一刻的目录 */
  DOCS_DIR: docsDir(),
};
