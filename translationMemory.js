/**
 * 跨消息的翻译记忆（2026-10-15 v2.6.1122 · 老板拍板方案 A）
 *
 * 老板的原话：
 *   「翻译过的就不用再翻译，建立个数据可读取翻译过的内容。每次就不用再翻译一次。」
 *
 * 之前只做到一半：
 *   messages.body_zh 是**按消息**记的 —— 同一句原文出现在两条不同消息里就是两行、
 *   两次 AI 调用。客户反复发 How much? / Ok / Thanks 这类短句时，每出现一次都要再烧
 *   一次 token。气泡那一层（waBubble）已经会按原文查库，但**翻译管线本身不会**。
 *
 * 这个模块补上后半截：
 *   原文文本 → 译文 的一本字典（表 translation_memory），不看它是哪条消息、
 *   也不分 WhatsApp / Signal / Telegram，三个渠道共用一本。
 *   翻译前先查字典：命中 → 直接复用，0 次 AI 调用；未命中 → 正常调 AI，翻完写回。
 *
 * 🔴 边界与取舍（改之前先看这几条）：
 *   1. **只按完全一致复用**（归一化后精确匹配）。同一句 "Ok" 在不同语境译文可能不同，
 *      宁可多翻一次，也不许把客人说的话翻串。
 *   2. **归一化只做两件事**：去首尾空格、连续空白折成一个空格。不改大小写、不动标点。
 *   3. **超长文本（> MAX_LEN）不入记忆**。一整段话几乎不会重复，塞进字典只是占地方。
 *   4. **只走 db 里那几条 tm* 语句**，别的文件不许直接写这张表。
 *   5. 这个模块**没有任何发送能力**，也不碰消息内容以外的东西 —— 纯读取 + 纯记账。
 */

const db = require('./db');
const ai = require('./ai'); // v2.6.1148：词典准入的 AI 复核走这里（callProviderByName）

/** 超过这个长度的原文不进记忆（长消息几乎不会重复，别占字典） */
const MAX_LEN = 200;
/** 词典只收短句：超过这个长度的原文（一大串英文）不进字典（老板 2026-10-17 要求：要那种简短的） */
const DICT_MAX = 120;
/** 回填时最多扫多少条历史消息（新→旧） */
const SEED_LIMIT = 5000;

/** v2.6.1148：词典准入用的 AI（「翻译词典用哪个 AI」可切换），默认 DeepSeek */
const MEMORY_MODEL_CHOICES = ['deepseek', 'siliconflow', 'tikhub', 'bailian'];
/** 各家做「这句值不值得收」分类时用哪个模型（没填 key 就放行，不卡翻译） */
const GATE_MODEL = {
  deepseek: 'deepseek-v4-flash',
  siliconflow: 'Qwen/Qwen2.5-7B-Instruct',
  tikhub: 'gpt-4o-mini',
  bailian: 'qwen-plus',
};
let _memoryModel = 'deepseek';

let _enabled = true;
let _seeded = false;
/** 本次进程内的运行账（不是库里的持久统计） */
const _runtime = { lookups: 0, hits: 0, writes: 0, seedAdded: 0 };

function now() {
  return new Date().toISOString();
}

/** 归一化：只做「去首尾空格 + 连续空白折一个」，不改大小写、不动标点 */
function normalize(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function raw(text) {
  return String(text == null ? '' : text);
}

function usable(text) {
  const t = raw(text);
  const norm = normalize(t);
  if (!norm) return null;
  if (t.length > MAX_LEN) return null; // 太长的不入字典
  return norm;
}

/**
 * v2.6.1148：词典准入的规则过滤（确定性，不烧 AI）。
 * 命中任一条 → 不收，返回 { ok:false, reason }。
 * 老板点名的几类全在这里挡掉：长串 / 乱码 / 中文 / 拼音 / 时间戳 / IP:端口 / URL / 中文混写。
 */
function rulePasses(norm) {
  if (norm.length > DICT_MAX) return { ok: false, reason: 'too_long' };
  // 中文 / 日文 / 韩文（含「Signal REST API 真实收发测试」这种）
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(norm)) {
    return { ok: false, reason: 'cjk' };
  }
  // 诡异的空白字符（j j j 里那个 U+2009）
  if (/[\u2009\u200a\u200b\u3000]/.test(norm)) return { ok: false, reason: 'weird_space' };
  // URL / 域名（platinum-vip.miyavip.vip:8001）
  if (/(https?:\/\/|www\.)/i.test(norm)) return { ok: false, reason: 'url' };
  if (/\b[a-z0-9-]+\.(vip|com|net|org|cn|io|xyz|top|gov|edu|co|me|info|live|shop|app|dev|ru|de|fr|uk|us|jp|kr)\b/i.test(norm)) {
    return { ok: false, reason: 'domain' };
  }
  // IP 地址（198.87.177.142）
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(norm)) return { ok: false, reason: 'ip' };
  // 时间戳（00:54:11 / 23:03）
  if (/\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(norm)) return { ok: false, reason: 'timestamp' };
  // host:port 或任何「冒号+2~5 位数字」（198.65.67.111:8022）
  if (/:\d{2,5}/.test(norm)) return { ok: false, reason: 'port' };
  // 4 个以上连续相同字母（Tyyttytyyy / wewwwwwww / tyyttytyyyyyyyyyy）
  if (/(.)\1{3,}/.test(norm)) return { ok: false, reason: 'repeat' };
  return { ok: true };
}

/**
 * v2.6.1148：AI 复核——这句到底是「真人会发的正常英文」，还是乱码/拼音/无意义？
 * 用「翻译词典用哪个 AI」选定的那家。返回 true=收 / false=不收 / null=AI 不可用（放行）。
 */
async function aiDecideKeep(norm) {
  if (!ai || typeof ai.callProviderByName !== 'function') return null;
  const model = getMemoryModel();
  const modelName = GATE_MODEL[model] || 'deepseek-v4-flash';
  const user = 'Decide if this text is a normal, meaningful English sentence or phrase a real customer might send in chat (worth saving to a phrase dictionary). Reply with exactly one word: KEEP or DROP. DROP if it is gibberish, random letters, pinyin, has no clear meaning, or is not a real sentence.\nText: ' + norm;
  try {
    const out = await ai.callProviderByName(model, modelName, {
      system: 'You are a strict filter. Output only KEEP or DROP, one word.',
      user,
      maxTokens: 4,
      temperature: 0,
      timeout: 8000,
    });
    if (!out) return null;
    const u = String(out).trim().toUpperCase();
    if (u.startsWith('DROP')) return false;
    if (u.startsWith('KEEP')) return true;
    return null;
  } catch (e) {
    return null; // AI 出错不卡住收录，规则已挡掉大部分
  }
}

/** 是否跳过 AI 复核（超常见的短句直接收，省调用） */
function skipAi(norm) {
  return SKIP_AI.has(norm.toLowerCase());
}
const SKIP_AI = new Set([
  'ok', 'okay', 'yes', 'no', 'hi', 'hello', 'hey', 'thanks', 'thank you', 'good morning',
  'good evening', 'good night', 'good afternoon', 'bye', 'see you', 'wow', 'love it', 'nice',
  'great', 'sure', 'please', 'how are you', "i'm fine", 'good', 'nice to meet you', 'welcome',
  'sorry', 'excuse me', 'of course', 'no problem', 'lol', 'haha', 'yes please', 'not now',
  'later', 'soon', 'perfect', 'amazing', 'beautiful', 'cute', 'lovely', 'sweet', 'dear',
  'oh', 'right', 'here', 'there', 'me too', 'i see', 'got it', 'sounds good', 'agreed',
  'maybe', 'definitely', 'always', 'never', 'thank you so much', 'good job', 'well done',
  'congrats', 'yes!', 'no!', 'ok thanks', 'see you later', 'talk soon', 'miss you', 'love you',
]);

function setEnabled(v) {
  _enabled = v !== false;
  return _enabled;
}

function enabled() {
  return _enabled;
}

/** 从 config.yaml 读开关（translation.memory 默认开；translation.memoryModel 默认 deepseek） */
function fromCfg(cfg) {
  const t = cfg && cfg.translation;
  if (t && typeof t.memory === 'boolean') setEnabled(t.memory);
  else setEnabled(true);
  if (t && typeof t.memoryModel === 'string' && MEMORY_MODEL_CHOICES.includes(t.memoryModel)) {
    setMemoryModel(t.memoryModel);
  }
  return _enabled;
}

/** 「翻译词典用哪个 AI」当前值（'' 或非法值都回落 deepseek） */
function getMemoryModel() {
  return _memoryModel;
}
function setMemoryModel(m) {
  _memoryModel = (m && typeof m === 'string' && MEMORY_MODEL_CHOICES.includes(m)) ? m : 'deepseek';
  return _memoryModel;
}

/**
 * 查字典。
 * @returns {null | {zh: string, hits: number}} 命中返回译文，未命中返回 null
 */
function lookup(text) {
  _runtime.lookups++;
  if (!_enabled) return null;
  const norm = usable(text);
  if (!norm) return null;
  let row = null;
  try {
    row = db.tmGet.get(norm);
  } catch (e) {
    return null; // 表还没建好 / 查询出错 —— 不能因为记忆出岔子就把翻译整个拖垮
  }
  if (!row || !row.body_zh) return null;
  _runtime.hits++;
  return { zh: String(row.body_zh), hits: Number(row.hits) || 0 };
}

/** 记一次复用（命中数 +1），用来算「省了几次 AI 调用」 */
function hit(text) {
  if (!_enabled) return false;
  const norm = usable(text);
  if (!norm) return false;
  try {
    db.tmHit.run(now(), norm);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 翻完写回字典。已有这句就覆盖译文并把命中数 +1。
 * v2.6.1148：写回前先过「规则过滤 + AI 复核」两道准入，脏数据一律不收。
 * @returns {Promise<boolean>} 是否写进了字典
 */
async function record(text, zh, provider) {
  if (!_enabled) return false;
  const norm = usable(text);
  const out = String(zh == null ? '' : zh).trim();
  if (!norm || !out) return false;

  // 第一道：规则过滤（确定性，不烧 AI）
  const rule = rulePasses(norm);
  if (!rule.ok) {
    try { db.tmRejectPut.run(norm, 'rule:' + rule.reason, now()); } catch (e) { /* 拒绝表写不进也不影响 */ }
    return false;
  }

  // 第二道：AI 复核（超常见短句跳过，省调用；已判过不收的也跳过）
  if (!skipAi(norm)) {
    try {
      const already = db.tmRejectGet.get(norm);
      if (!already) {
        const decision = await aiDecideKeep(norm);
        if (decision === false) {
          db.tmRejectPut.run(norm, 'ai', now());
          return false; // AI 说这句不值得收
        }
        // decision === true / null → 放行（null=AI 不可用，规则已过就收）
      }
    } catch (e) { /* AI 出错不卡住收录 */ }
  }

  try {
    db.tmUpsert.run({
      norm,
      text: raw(text),
      zh: out,
      provider: String(provider || ''),
      len: raw(text).length,
      at: now(),
    });
    _runtime.writes++;
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 回填：把库里**已经翻好**的消息灌进字典（只补空缺，不覆盖、不误加命中数）。
 * 这样一装上新版，历史消息里的老译文立刻就能被复用，不用等重新翻一遍。
 */
function seed(limit = SEED_LIMIT) {
  if (!_enabled) return { scanned: 0, added: 0 };
  let rows = [];
  try {
    rows = db.listAllTranslations.all(Number(limit) || SEED_LIMIT);
  } catch (e) {
    return { scanned: 0, added: 0 };
  }
  const seen = new Set();
  const at = now();
  let added = 0;
  for (const r of rows) {
    if (!r) continue;
    const body = raw(r.body);
    const zh = String(r.body_zh == null ? '' : r.body_zh).trim();
    const norm = usable(body);
    if (!norm || !zh) continue;
    if (seen.has(norm)) continue; // 同一句在历史里翻过多次，取最新的那条就够了
    seen.add(norm);
    // v2.6.1148：脏数据不回灌字典（只过规则过滤，不过 AI，避免一次灌几千条触发爆发调用）
    if (!rulePasses(norm).ok) continue;
    try {
      const info = db.tmSeed.run({ norm, text: body, zh, len: body.length, at });
      if (info && Number(info.changes) > 0) added++;
    } catch (e) {
      /* 单条失败不影响其他 */
    }
  }
  _runtime.seedAdded += added;
  return { scanned: rows.length, added };
}

/**
 * 启动时灌一次就行：字典里已经有内容就跳过（说明上回灌过了）。
 * 只在「从没灌过」的第一次启动真正跑一遍。
 */
function ensureSeeded() {
  if (_seeded) return { scanned: 0, added: 0, skipped: true };
  _seeded = true;
  try {
    const c = db.tmCount.get();
    if (c && Number(c.n) > 0) return { scanned: 0, added: 0, skipped: true };
  } catch (e) {
    /* 查不到就当没灌过，继续走 seed */
  }
  return seed();
}

/** 统计（给接口和界面看：记住了多少条、省了多少次调用） */
function stats() {
  let total = 0;
  let saved = 0;
  try {
    const c = db.tmCount.get();
    total = Number(c && c.n) || 0;
    saved = Number(c && c.hits) || 0;
  } catch (e) {
    /* 表不可用时如实报 0，不谎报 */
  }
  let top = [];
  try {
    top = db.tmTop.all(5);
  } catch (e) {
    /* 同上 */
  }
  return {
    enabled: _enabled,
    total,
    saved,
    maxLen: MAX_LEN,
    top,
    runtime: Object.assign({}, _runtime),
  };
}

module.exports = {
  MAX_LEN,
  SEED_LIMIT,
  DICT_MAX,
  MEMORY_MODEL_CHOICES,
  normalize,
  setEnabled,
  enabled,
  fromCfg,
  getMemoryModel,
  setMemoryModel,
  rulePasses,
  lookup,
  hit,
  record,
  seed,
  ensureSeeded,
  stats,
  _internal: { runtime: _runtime, resetSeeded: () => { _seeded = false; } },
};
