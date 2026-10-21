/**
 * 采纳记忆库
 *
 * 作用就一件事：你采纳过的思路，下次遇到相似场景优先复用；你否掉的思路，下次避开。
 *
 * 这是本地文件库，不是模型微调——不需要训练、不上传、随时能改。
 * 数据落在 data/assistant.db 的两张表里：learned（采纳）与 rejected（不采纳）。
 *
 * 无 AI 依赖：全部是本地检索，断网也能用。
 */

const path = require('path');
const db = require('./db');

/* ---------------- 建表 ---------------- */

db.db.exec(`
CREATE TABLE IF NOT EXISTS learned (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  angle        TEXT,                 -- 角度：empathy / story / nudge …
  day          INTEGER,              -- 当时的阶段 Day 0–7
  scene        TEXT,                 -- 触发这条思路的客户原话（截断）
  keywords     TEXT,                 -- 场景关键词，用于相似度匹配
  text         TEXT NOT NULL,        -- 你采纳的那句话（可含你修改后的版本）
  note         TEXT,                 -- 你备注的"为什么这条好"
  source_code  TEXT,                 -- 来自哪个客户编号
  use_count    INTEGER DEFAULT 1,    -- 同一场景命中过几次
  created_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_learned_angle ON learned(angle);
CREATE INDEX IF NOT EXISTS idx_learned_day   ON learned(day);

CREATE TABLE IF NOT EXISTS rejected (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  angle       TEXT,
  day         INTEGER,
  scene       TEXT,
  keywords    TEXT,
  text        TEXT NOT NULL,         -- 被你否掉的那句话
  reason      TEXT,                  -- 你填的否掉原因（可空）
  source_code TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_rejected_angle ON rejected(angle);
`);

/* ---------------- 语句 ---------------- */

const insertLearned = db.db.prepare(`
  INSERT INTO learned (angle, day, scene, keywords, text, note, source_code, created_at)
  VALUES (@angle, @day, @scene, @keywords, @text, @note, @source_code, @created_at)
`);

const insertRejected = db.db.prepare(`
  INSERT INTO rejected (angle, day, scene, keywords, text, reason, source_code, created_at)
  VALUES (@angle, @day, @scene, @keywords, @text, @reason, @source_code, @created_at)
`);

const selectLearned = db.db.prepare(`SELECT * FROM learned ORDER BY id DESC`);
const selectRejected = db.db.prepare(`SELECT * FROM rejected ORDER BY id DESC`);
const delLearned = db.db.prepare(`DELETE FROM learned WHERE id=?`);
const delRejected = db.db.prepare(`DELETE FROM rejected WHERE id=?`);
const bumpUse = db.db.prepare(`UPDATE learned SET use_count = use_count + 1 WHERE id=?`);

/* ---------------- 关键词与相似度 ---------------- */

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'to', 'of', 'and', 'or',
  'i', 'you', 'he', 'she', 'it', 'my', 'your', 'his', 'her', 'we', 'they', 'me', 'him',
  'this', 'that', 'these', 'those', 'for', 'with', 'on', 'in', 'at', 'so', 'but', 'if',
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '这', '那', '就', '都',
  '也', '还', '很', '太', '有', '和', '与', '不', '没', '吗', '呢', '吧', '啊', '哦', '嗯',
]);

/**
 * 抽关键词：英文按单词，中文按二字组（不分词，够用且零依赖）
 * @param {string} text
 * @returns {string[]}
 */
function keywords(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const out = new Set();

  for (const w of s.match(/[a-z][a-z']{2,}/g) || []) {
    if (!STOP.has(w)) out.add(w);
  }

  // 中文：滑窗取二字组，纯汉字片段里切
  for (const seg of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i < seg.length - 1; i++) {
      const g = seg.slice(i, i + 2);
      if (!STOP.has(g)) out.add(g);
    }
  }
  return [...out];
}

/**
 * 两串文本的相似度：关键词集合的交集占比（Jaccard 的温和版）
 * @returns {number} 0–1
 */
function similarity(a, b) {
  const ka = new Set(a);
  const kb = new Set(b);
  if (!ka.size || !kb.size) return 0;
  let hit = 0;
  for (const k of ka) if (kb.has(k)) hit++;
  // 用较小集合做分母：短句命中长句也算像，避免长文本稀释
  return hit / Math.min(ka.size, kb.size);
}

/* ---------------- 写入 ---------------- */

/**
 * 记一条采纳。同一客户同一句话重复采纳只 +1 次数，不重复入库。
 * @param {object} p {angle, day, scene, text, note, customerCode}
 */
function recordAdopt(p) {
  const text = String(p.text || '').trim();
  if (!text) return null;

  const kw = keywords(`${p.scene || ''} ${text}`);
  const now = new Date().toISOString();

  const dup = db.db
    .prepare('SELECT id FROM learned WHERE text=? AND source_code=?')
    .get(text, p.customerCode || '');
  if (dup) {
    bumpUse.run(dup.id);
    return { id: dup.id, dedup: true };
  }

  const res = insertLearned.run({
    angle: p.angle || null,
    day: Number.isFinite(p.day) ? p.day : null,
    scene: (p.scene || '').slice(0, 300),
    keywords: kw.join(' '),
    text,
    note: p.note || null,
    source_code: p.customerCode || null,
    created_at: now,
  });
  return { id: res.lastInsertRowid, dedup: false };
}

/**
 * 记一条不采纳
 * @param {object} p {angle, day, scene, text, reason, customerCode}
 */
function recordReject(p) {
  const text = String(p.text || '').trim();
  if (!text) return null;

  const kw = keywords(`${p.scene || ''} ${text}`);
  const res = insertRejected.run({
    angle: p.angle || null,
    day: Number.isFinite(p.day) ? p.day : null,
    scene: (p.scene || '').slice(0, 300),
    keywords: kw.join(' '),
    text,
    reason: p.reason || null,
    source_code: p.customerCode || null,
    created_at: new Date().toISOString(),
  });
  return { id: res.lastInsertRowid };
}

/* ---------------- 检索 ---------------- */

/**
 * 找相似场景下你采纳过的思路，按相关度排序
 * @param {string} scene 当前对话文本
 * @param {object} opt {angle, day, limit, minScore}
 * @returns {Array<{row:object, score:number}>}
 */
function findExemplars(scene, opt = {}) {
  const kw = keywords(scene);
  if (!kw.length) return [];
  const limit = opt.limit ?? 5;
  const minScore = opt.minScore ?? 0.12;

  const scored = [];
  for (const row of selectLearned.all()) {
    const rk = (row.keywords || '').split(' ').filter(Boolean);
    let score = similarity(kw, rk);

    // 同阶段 / 同角度加权：这两项比字面相似更能说明"路子对"
    if (opt.day != null && row.day === opt.day) score += 0.15;
    if (opt.angle && row.angle === opt.angle) score += 0.2;

    // 被采纳次数多的加分，形成正反馈
    score += Math.min((row.use_count || 1) - 1, 5) * 0.02;

    if (score >= minScore) scored.push({ row, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * 取被否掉的样本，用来告诉模型"别再往这个方向写"
 *
 * 两类都要：
 *   1. 场景相似的——说明这个话题上这个路子不行
 *   2. 最近几条无条件的——"太早了""太硬了"这类是节奏和分寸问题，跟话题无关，必须一直避开
 *
 * @param {string} scene
 * @param {object} opt {limit, minScore, alwaysRecent}
 */
function findRejections(scene, opt = {}) {
  const kw = keywords(scene);
  const limit = opt.limit ?? 6;
  const minScore = opt.minScore ?? 0.1;
  const alwaysRecent = opt.alwaysRecent ?? 3;

  const all = selectRejected.all();
  const scored = all.map((row) => {
    const rk = (row.keywords || '').split(' ').filter(Boolean);
    return { row, score: kw.length ? similarity(kw, rk) : 0 };
  });

  const picked = new Map();

  // 1) 场景相关的
  scored
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .forEach((s) => picked.set(s.row.id, s));

  // 2) 最近几条，无条件
  [...all]
    .sort((a, b) => b.id - a.id)
    .slice(0, alwaysRecent)
    .forEach((row) => {
      if (!picked.has(row.id)) {
        picked.set(row.id, { row, score: scored.find((s) => s.row.id === row.id)?.score ?? 0 });
      }
    });

  return [...picked.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 某个角度最近被拒了几次（用来压制这个角度） */
function rejectCountOfAngle(angle) {
  if (!angle) return 0;
  return db.db.prepare('SELECT COUNT(*) AS n FROM rejected WHERE angle=?').get(angle).n;
}

/* ---------------- 管理 ---------------- */

function listLearned(limit = 200) {
  return selectLearned.all().slice(0, limit);
}

function listRejected(limit = 100) {
  return selectRejected.all().slice(0, limit);
}

function removeLearned(id) {
  delLearned.run(id);
}

function removeRejected(id) {
  delRejected.run(id);
}

/** 统计：给界面显示的"你训练了多少条" */
function stats() {
  const d = db.db;
  return {
    learned: d.prepare('SELECT COUNT(*) AS n FROM learned').get().n,
    rejected: d.prepare('SELECT COUNT(*) AS n FROM rejected').get().n,
    byAngle: d.prepare('SELECT angle, COUNT(*) AS n FROM learned GROUP BY angle ORDER BY n DESC').all(),
  };
}

module.exports = {
  keywords,
  similarity,
  recordAdopt,
  recordReject,
  findExemplars,
  findRejections,
  rejectCountOfAngle,
  listLearned,
  listRejected,
  removeLearned,
  removeRejected,
  stats,
};
