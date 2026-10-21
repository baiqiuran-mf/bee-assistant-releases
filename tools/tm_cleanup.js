/**
 * 翻译词典清理工具（v2.6.1148）
 *
 * 独立脚本，不依赖 Electron / app 模块（那些会 require('electron')，裸 node 跑不了）。
 * 直接：本地用 node:sqlite 开生产库；云端用 Cloudflare D1 REST（.cf_token）直写。
 *
 * 干两件事：
 *   1. 规则过滤（确定性，不烧 AI）：长串 / 乱码 / 中文 / 拼音 / 时间戳 / IP:端口 / URL —— 一律删。
 *   2. AI 复核：规则过了的，再用 DeepSeek 判断是不是真人会发的正常英文，DROP 就删。
 *
 * 删之前先备份：本地库复制一份 .bak-<时间戳>；云端整表导成 JSON。
 *
 * 用法（在项目根目录，需要 --experimental-sqlite）：
 *   node --experimental-sqlite tools/tm_cleanup.js --dry        只看会删哪些，不真删
 *   node --experimental-sqlite tools/tm_cleanup.js --confirm    真删（删前自动备份）
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DRY = !process.argv.includes('--confirm');
if (DRY) {
  console.log('⚠️  DRY RUN（只读，不会删除任何数据）。要真删请加 --confirm');
}

// ---------- 本地库 ----------
const DB_FILE = 'D:/蜜蜂采集数据/wa-assistant/data/assistant.db';

// ---------- 云端 D1 ----------
const CF_TOKEN_FILE = 'E:/WorkBuddy-Projects/wa-cloud/.cf_token';
const CF_ACCOUNT = '9515e631c679f1373e2ad67140da50b9';
const CF_DB = '9cb002af-c565-484a-8666-b261cd1c1f4d';
const QAPI = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${CF_DB}/query`;
const CF_TOKEN = (fs.existsSync(CF_TOKEN_FILE) ? fs.readFileSync(CF_TOKEN_FILE, 'utf8') : '').trim();

// ---------- DeepSeek（词典 AI 默认）----------
const CONFIG_FILE = 'D:/蜜蜂采集数据/wa-assistant/config.yaml';
function loadDeepseek() {
  const txt = fs.readFileSync(CONFIG_FILE, 'utf8');
  // 只取 deepseek 段里的 baseUrl / apiKey
  const block = txt.match(/deepseek:\s*\n([\s\S]*?)(?:\n\w+\s*:|translation:|ui:|$)/);
  let baseUrl = 'https://api.deepseek.com/v1';
  let apiKey = '';
  if (block) {
    const b = block[1].match(/baseUrl:\s*(\S+)/);
    const k = block[1].match(/apiKey:\s*"?([^"\n]+)"?/);
    if (b) baseUrl = b[1].replace(/['"]/g, '');
    if (k) apiKey = k[1].trim();
  }
  return { baseUrl, apiKey };
}
const DS = loadDeepseek();

// ============ 规则过滤（与 src/translationMemory.js 的 rulePasses 对齐）============
/* 🔴 改这里之前先看 src/translationMemory.js 的 rulePasses —— 两份必须一致，
 *    否则「清理工具删掉的」和「新翻译不会再收的」会对不上。 */
const DICT_MAX = 120;
/** 12 个月：完整写法 + 常见缩写（i 标志，大小写不敏感） */
const MONTH_ALT = [
  'jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'jun(?:e)?',
  'jul(?:y)?', 'aug(?:ust)?', 'sep(?:t(?:ember)?)?', 'oct(?:ober)?', 'nov(?:ember)?',
  'dec(?:ember)?',
].join('|');
/** 序数后缀：13th / 2nd（可省） */
const ORD_SUFFIX = '(?:st|nd|rd|th)?';
/* v2.6.1149：日期 / 时间类型（老板：「October 13 这种时间类型不要加入」）。
 * 只认「月份 + 数字」或明确的日期格式，绝不只看月份单词就删 —— 否则
 * "May I help you?" / "See you in March" / "I love April" 会被误杀。 */
const DATE_RE = new RegExp(
  '\\b(?:' + MONTH_ALT + ')\\.?\\s+\\d{1,2}' + ORD_SUFFIX + '\\b'              // October 13
  + '|\\b\\d{1,2}' + ORD_SUFFIX + '\\s+(?:of\\s+)?(?:' + MONTH_ALT + ')\\.?\\b'   // 13 October
  + '|\\b\\d{4}[-\\/.]\\d{1,2}[-\\/.]\\d{1,2}\\b'                                 // 2026-10-17
  + '|\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?\\b'                                   // 10/13
  + '|\\b(?:' + MONTH_ALT + ')\\.?\\s+\\d{4}\\b',                                   // October 2026
  'i'
);
function rulePasses(norm) {
  if (norm.length > DICT_MAX) return { ok: false, reason: 'too_long' };
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(norm)) return { ok: false, reason: 'cjk' };
  if (/[\u2009\u200a\u200b\u3000]/.test(norm)) return { ok: false, reason: 'weird_space' };
  if (/(https?:\/\/|www\.)/i.test(norm)) return { ok: false, reason: 'url' };
  if (/\b[a-z0-9-]+\.(vip|com|net|org|cn|io|xyz|top|gov|edu|co|me|info|live|shop|app|dev|ru|de|fr|uk|us|jp|kr)\b/i.test(norm)) return { ok: false, reason: 'domain' };
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(norm)) return { ok: false, reason: 'ip' };
  if (/\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(norm)) return { ok: false, reason: 'timestamp' };
  if (DATE_RE.test(norm)) return { ok: false, reason: 'date' };
  if (/:\d{2,5}/.test(norm)) return { ok: false, reason: 'port' };
  if (/(.)\1{3,}/.test(norm)) return { ok: false, reason: 'repeat' };
  return { ok: true };
}

// ============ AI 复核（DeepSeek）============
async function aiDecide(norm) {
  if (!DS.apiKey) return null; // 没 key 就放行（规则已过）
  const url = DS.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions.*$/i, '') + '/chat/completions';
  const body = {
    model: 'deepseek-v4-flash',
    temperature: 0,
    max_tokens: 4,
    thinking: { type: 'disabled' }, // v4-flash 默认开思考模式会把输出额度用在推理上，必须显式关掉
    messages: [
      { role: 'system', content: 'You are a strict filter. Output only KEEP or DROP, one word.' },
      { role: 'user', content: 'Decide if this text is a normal, meaningful English sentence or phrase a real customer might send in chat (worth saving to a phrase dictionary). Reply with exactly one word: KEEP or DROP. DROP if it is gibberish, random letters, pinyin, has no clear meaning, or is not a real sentence.\nText: ' + norm },
    ],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DS.apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) { console.warn('   [AI] HTTP', r.status, '→ 放行'); return null; }
    const d = await r.json();
    const c = (d?.choices?.[0]?.message?.content || '').trim().toUpperCase();
    if (c.startsWith('DROP')) return false;
    if (c.startsWith('KEEP')) return true;
    return null;
  } catch (e) {
    console.warn('   [AI] 异常', e.message, '→ 放行');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============ 通用判定（规则 + AI）============
async function classify(norm) {
  const rule = rulePasses(norm);
  if (!rule.ok) return { drop: true, reason: 'rule:' + rule.reason };
  const ai = await aiDecide(norm);
  if (ai === false) return { drop: true, reason: 'ai' };
  return { drop: false, reason: 'keep' };
}

// ============ 本地库 ============
async function cleanLocal() {
  console.log('\n=== 本地库 ===');
  if (!fs.existsSync(DB_FILE)) { console.log('  本地库不存在，跳过'); return; }
  const bak = DB_FILE + '.bak-' + Date.now();
  fs.copyFileSync(DB_FILE, bak);
  console.log('  已备份 →', bak);

  const db = new DatabaseSync(DB_FILE);
  db.exec(`CREATE TABLE IF NOT EXISTS translation_reject (
    src_norm TEXT PRIMARY KEY, reason TEXT, at TEXT)`);
  const rows = db.prepare('SELECT id, src_norm, src_text, body_zh FROM translation_memory ORDER BY id').all();
  console.log('  共', rows.length, '条');
  // v2.6.1149：大小写不敏感——只差大小写的重复行一起清掉
  const delStmt = db.prepare('DELETE FROM translation_memory WHERE src_norm=? COLLATE NOCASE');
  const rejStmt = db.prepare('INSERT OR REPLACE INTO translation_reject (src_norm, reason, at) VALUES (?,?,?)');
  let kept = 0, dropped = 0;
  const drops = [];
  for (const r of rows) {
    const v = await classify(r.src_norm);
    if (v.drop) {
      dropped++;
      drops.push(`  ✗ [${v.reason}] ${JSON.stringify(r.src_norm)}  →「${r.body_zh || ''}」`);
      if (!DRY) { delStmt.run(r.src_norm); rejStmt.run(r.src_norm, v.reason, new Date().toISOString()); }
    } else {
      kept++;
    }
  }
  console.log(drops.join('\n'));
  console.log(`  结果：保留 ${kept} 条，删除 ${dropped} 条${DRY ? '（DRY，未真删）' : ''}`);
  db.close();
}

// ============ 云端 D1 ============
// 沿用 wa-cloud 工具的约定：D1 REST 的 /query 端点直接发 { sql }，值用 esc() 内联转义（不走 bindings 数组）
function esc(s) {
  return String(s == null ? '' : s).replace(/'/g, "''");
}
async function d1Query(sql) {
  const r = await fetch(QAPI, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CF_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const d = await r.json();
  if (!d.success) throw new Error('D1 错误: ' + JSON.stringify(d.errors || d));
  return d.result;
}
async function cleanCloud() {
  console.log('\n=== 云端 D1 ===');
  if (!CF_TOKEN) { console.log('  找不到 .cf_token，跳过云端'); return; }
  // 备份：整表导出
  const bakName = `tools/tm_cloud_backup-${Date.now()}.json`;
  try {
    const bk = await d1Query('SELECT * FROM translation_memory');
    const all = bk && bk[0] ? bk[0].results : [];
    fs.writeFileSync(path.join(ROOT, bakName), JSON.stringify(all, null, 2));
    console.log('  已备份', all.length, '条 →', bakName);
  } catch (e) { console.warn('  备份失败（继续）：', e.message); }

  await d1Query(`CREATE TABLE IF NOT EXISTS translation_reject (
    src_norm TEXT PRIMARY KEY, reason TEXT, at TEXT)`).catch(() => {});

  const res = await d1Query('SELECT id, src_norm, src_text, body_zh FROM translation_memory ORDER BY id');
  const rows = (res && res[0] && res[0].results) || [];
  console.log('  共', rows.length, '条');
  let kept = 0, dropped = 0;
  const drops = [];
  for (const r of rows) {
    const v = await classify(r.src_norm);
    if (v.drop) {
      dropped++;
      drops.push(`  ✗ [${v.reason}] ${JSON.stringify(r.src_norm)}  →「${r.body_zh || ''}」`);
      if (!DRY) {
        await d1Query(`DELETE FROM translation_memory WHERE src_norm = '${esc(r.src_norm)}'`);
        await d1Query(`INSERT OR REPLACE INTO translation_reject (src_norm, reason, at) VALUES ('${esc(r.src_norm)}', '${esc(v.reason)}', '${esc(new Date().toISOString())}')`).catch(() => {});
      }
    } else {
      kept++;
    }
  }
  console.log(drops.join('\n'));
  console.log(`  结果：保留 ${kept} 条，删除 ${dropped} 条${DRY ? '（DRY，未真删）' : ''}`);
}

(async () => {
  if (!DRY) console.log('🔴 真删模式：删前已自动备份本地库与云端整表');
  await cleanLocal();
  await cleanCloud();
  console.log('\n完成。' + (DRY ? '（DRY RUN，没有任何数据被删除）' : '（已删除异常数据，备份文件保留）'));
})();
