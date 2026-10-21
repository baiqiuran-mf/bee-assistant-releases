/**
 * 翻译词典「清干净 + 灌 350 句」工具（老板 2026-10-17 指示）
 *
 * 干两件事，按顺序：
 *   1. 彻底清空本地 + 云端后台的 translation_memory（以及 translation_reject 黑名单一并清，
 *      给「重新录制」一个真正干净的开始）。
 *   2. 把老板亲自整理的 350 句中英对照（tools/tm_seed_350.json）灌进本地 + 云端。
 *      ⚠️ 这 350 句是老板挑选的，**不经过 rulePasses / AI 复核**，直接入库。
 *
 * 顺序很重要 —— 为什么先清空再灌、而且必须在一次运行里做完：
 *   · src/main.js:3812 启动时会跑 ensureSeeded()，它发现词典是空的就会从 messages 历史译文回填。
 *     → 灌完 350 之后词典非空了，ensureSeeded 会自动跳过，老板新录的不会被历史脏数据冲回来。
 *   · src/tmCloud.js 登录/关软件时会双向同步本地↔云端。
 *     → 只清一边，另一边会被同步回来。必须两边同时清、同时灌。
 *
 * 跑之前必须**完全关闭「蜜蜂信息采集」软件**（否则本地库会写冲突）。
 *
 * 用法（项目根目录，需要 --experimental-sqlite）：
 *   node --experimental-sqlite tools/tm_reseed.js --dry       只看会做什么，不动数据
 *   node --experimental-sqlite tools/tm_reseed.js --confirm   真做（删前自动备份）
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DRY = !process.argv.includes('--confirm');
if (DRY) console.log('⚠️  DRY RUN：只读不清不灌。要真做请加 --confirm\n');

// ---------- 本地生产库 ----------
const DB_FILE = 'D:/蜜蜂采集数据/wa-assistant/data/assistant.db';

// ---------- 云端 D1 ----------
const CF_TOKEN_FILE = 'E:/WorkBuddy-Projects/wa-cloud/.cf_token';
const CF_ACCOUNT = '9515e631c679f1373e2ad67140da50b9';
const CF_DB = '9cb002af-c565-484a-8666-b261cd1c1f4d';
const QAPI = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${CF_DB}/query`;
const CF_TOKEN = (fs.existsSync(CF_TOKEN_FILE) ? fs.readFileSync(CF_TOKEN_FILE, 'utf8') : '').trim();

const STAMP = Date.now();
const PROVIDER = '老板录入';

// ---------- 读 350 句 ----------
const PAIRS_FILE = path.join(ROOT, 'tools', 'tm_seed_350.json');
if (!fs.existsSync(PAIRS_FILE)) { console.error('❌ 找不到', PAIRS_FILE); process.exit(1); }
const PAIRS = JSON.parse(fs.readFileSync(PAIRS_FILE, 'utf8'));
console.log(`读到老板整理的句子：${PAIRS.length} 条`);

/** 与 translationMemory.js 的 normalize 对齐：去首尾空格 + 连续空白折一个（不动大小写） */
function normalize(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); }

/* ================= 本地 ================= */
async function handleLocal() {
  console.log('\n================ 本地库 ================');
  if (!fs.existsSync(DB_FILE)) { console.log('❌ 本地库不存在：' + DB_FILE); return null; }

  const db = new DatabaseSync(DB_FILE);

  // 备份（VACUUM INTO 拿一致性快照，比直接 copy 更安全）
  const bak = `${DB_FILE}.before-reseed-${STAMP}`;
  if (!DRY) {
    db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
    console.log('  已备份（VACUUM INTO）→', bak);
  }

  const before = db.prepare('SELECT COUNT(*) AS n FROM translation_memory').get().n;
  const beforeRej = db.prepare('SELECT COUNT(*) AS n FROM translation_reject').get().n;
  console.log(`  清空前：翻译词典 ${before} 条，黑名单 ${beforeRej} 条`);

  if (DRY) { db.close(); return { before }; }

  const delTm = db.prepare('DELETE FROM translation_memory');
  const infoTm = delTm.run();
  let infoRej = { changes: 0 };
  try { infoRej = db.prepare('DELETE FROM translation_reject').run(); } catch (e) { /* 表不存在就算了 */ }
  console.log(`  已清空：词典删 ${infoTm.changes} 条，黑名单删 ${infoRej.changes} 条`);

  // 灌 350 句
  const ins = db.prepare(`INSERT OR REPLACE INTO translation_memory
    (src_norm, src_text, body_zh, provider, hits, src_len, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)`);
  const at = new Date().toISOString();
  let inserted = 0; const seenKey = new Set(); let dupSkipped = 0;
  db.exec('BEGIN');
  try {
    for (const [en, zh] of PAIRS) {
      const srcNorm = normalize(en);
      const srcText = String(en);
      const bodyZh = String(zh);
      if (!srcNorm || !bodyZh) continue;
      // 同一次灌入内部的大小写重复也挡掉（Hello / hello 只留第一次那条）
      const key = srcNorm.toLowerCase();
      if (seenKey.has(key)) { dupSkipped++; continue; }
      seenKey.add(key);
      ins.run(srcNorm, srcText, bodyZh, PROVIDER, srcText.length, at, at);
      inserted++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('❌ 写入失败，已回滚：', e.message);
    db.close();
    throw e;
  }

  const after = db.prepare('SELECT COUNT(*) AS n FROM translation_memory').get().n;
  const sample = db.prepare('SELECT src_text, body_zh FROM translation_memory ORDER BY id LIMIT 3').all();
  console.log(`  灌入：新增 ${inserted} 条${dupSkipped ? `（跳过内部重复 ${dupSkipped} 条）` : ''}`);
  console.log(`  最终：本地词典 ${after} 条`);
  console.log('  抽样前 3 条：');
  for (const s of sample) console.log(`    「${s.src_text}」 → 「${s.body_zh}」`);
  db.close();
  return { after };
}

/* ================= 云端 D1 ================= */
function esc(s) { return String(s == null ? '' : s).replace(/'/g, "''"); }
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
async function handleCloud() {
  console.log('\n================ 云端后台 D1 ================');
  if (!CF_TOKEN) { console.log('❌ 找不到 .cf_token，跳过云端'); return null; }

  await d1Query(`CREATE TABLE IF NOT EXISTS translation_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, src_norm TEXT NOT NULL UNIQUE, src_text TEXT NOT NULL,
    body_zh TEXT NOT NULL, provider TEXT DEFAULT '', hits INTEGER NOT NULL DEFAULT 0,
    src_len INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT)`).catch(() => {});

  // 备份：整表导出
  const bakName = `tools/tm_cloud_backup-before-reseed-${STAMP}.json`;
  const beforeRows = ((await d1Query('SELECT * FROM translation_memory'))[0] || {}).results || [];
  if (!DRY) {
    fs.writeFileSync(path.join(ROOT, bakName), JSON.stringify(beforeRows, null, 2));
    console.log('  已备份', beforeRows.length, '条 →', bakName);
  } else {
    console.log('  云端现有', beforeRows.length, '条（DRY 不备份）');
  }

  if (DRY) return { before: beforeRows.length };

  const d1 = await d1Query('DELETE FROM translation_memory');
  let d2;
  try { d2 = await d1Query('DELETE FROM translation_reject'); } catch (e) { d2 = [{ changes: 0 }]; }
  console.log(`  已清空：词典删 ${d1[0] && d1[0].changes} 条，黑名单删 ${d2[0] && d2[0].changes} 条`);

  // 分批灌（每批 50 条一条 INSERT，少打 REST 调用）
  const at = new Date().toISOString();
  const seenKey = new Set(); let inserted = 0; let dupSkipped = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const sql = `INSERT OR REPLACE INTO translation_memory
      (src_norm, src_text, body_zh, provider, hits, src_len, created_at, updated_at) VALUES `
      + batch.join(',');
    await d1Query(sql);
    inserted += batch.length;
    batch = [];
  };
  for (const [en, zh] of PAIRS) {
    const srcNorm = normalize(en);
    const srcText = String(en);
    const bodyZh = String(zh);
    if (!srcNorm || !bodyZh) continue;
    const key = srcNorm.toLowerCase();
    if (seenKey.has(key)) { dupSkipped++; continue; }
    seenKey.add(key);
    batch.push(`('${esc(srcNorm)}','${esc(srcText)}','${esc(bodyZh)}','${esc(PROVIDER)}',0,${srcText.length},'${esc(at)}','${esc(at)}')`);
    if (batch.length >= 50) await flush();
  }
  await flush();

  const after = ((await d1Query('SELECT COUNT(*) AS n FROM translation_memory'))[0] || {}).results || [];
  const afterN = (after[0] || {}).n;
  console.log(`  灌入：新增 ${inserted} 条${dupSkipped ? `（跳过内部重复 ${dupSkipped} 条）` : ''}`);
  console.log(`  最终：云端词典 ${afterN} 条`);
  return { after: afterN };
}

(async () => {
  if (!DRY) console.log('🔴 真做模式：清库前会自动备份本地库（VACUUM INTO）和云端整表导出');
  const lo = await handleLocal();
  const cl = await handleCloud();
  console.log('\n================ 汇总 ================');
  console.log(`句子源：${PAIRS.length} 条（tools/tm_seed_350.json）`);
  if (DRY) {
    console.log(`本地：清空前 ${lo && lo.before} 条 → 将灌入 ${PAIRS.length} 条`);
    console.log(`云端：清空前 ${cl && cl.before} 条 → 将灌入 ${PAIRS.length} 条`);
    console.log('⚠️ 这是 DRY RUN，没有任何数据被改动。');
  } else {
    console.log(`本地：${lo && lo.after} 条`);
    console.log(`云端：${cl && cl.after} 条`);
    console.log('✅ 完成。两边数量应当一致。');
  }
})();
