/**
 * 跨消息翻译记忆 · 后台共享同步（单向：后台 → 本地）
 *
 * 🔴 2026-10-18 老板最终拍板：
 *   ① 翻译词典 = 单向「后台 → 本地」。本地**不再自动录入**（record/seed 在
 *      src/translationMemory.js 里由 _recordEnabled 关掉），也不上传本地 → 后台（push 永久关闭）。
 *   ② 本地词典初始为空；**每次登录**都从后台拉取共享词条到本地（只补空缺，不覆盖已有）。
 *   ③ 关闭软件时**不再**做云端同步；关前改为在渲染端补建客户 docx 档案（见 electron/main.js）。
 *
 * 本文件只做「后台 → 本地」的搬运（pullAll / syncOnLogin），绝不改翻译记忆的业务规则
 * （那些规则全在 src/translationMemory.js）。它只碰 db.tmUpsertFromCloud。
 *
 * 方向开关：PULL_ENABLED（登录拉取，默认 true）/ PUSH_ENABLED（本地推后台，永久 false）。
 */

const cloud = require('./cloud');
const db = require('./db');

/**
 * 🔴 2026-10-18 老板最终拍板：翻译词典 = 单向「后台 → 本地」。
 *  PULL_ENABLED：登录时从后台拉取共享词典到本地（只补空缺，不覆盖）。
 *  PUSH_ENABLED：本地 → 后台 永久关闭（本地不再录入、也不上传）。
 *  关闭软件时不再同步（关闭流程改为补建 docx 档案，见 electron/main.js）。
 */
const PULL_ENABLED = true;
const PUSH_ENABLED = false;

const PULL_PATH = '/api/translate/memory/pull';
const PUSH_PATH = '/api/translate/memory/push';
const REQ_TIMEOUT = 5000;   // 单次请求超时（ms）
const PUSH_BATCH = 500;     // 推送分批大小（避免一次 POST 太大）

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 是否已登录云端（没登录就不做任何网络动作） */
function loggedIn() {
  try { return !!(cloud.isLoggedIn && cloud.isLoggedIn()); } catch (e) { return false; }
}

/**
 * 拉全量共享字典到本地（只补空缺，不覆盖本地已有）。
 * 网络/HTTP 出错会抛异常，交给上层决定重试；本地为空不算错。
 */
async function pullAll() {
  // 🔴 2026-10-18：登录时从后台拉取共享词典（只补空缺，不覆盖本地已有）
  if (!PULL_ENABLED) return { pulled: 0, skipped: true };
  if (!loggedIn()) return { pulled: 0, skipped: true };
  const j = await cloud.request('GET', PULL_PATH, undefined, { timeout: REQ_TIMEOUT });
  const rows = (j && j.rows) || [];
  let added = 0;
  for (const r of rows) {
    if (!r || !r.src_norm || !r.body_zh) continue; // 没译文的不要拉进本地字典
    try {
      db.tmUpsertFromCloud.run({
        norm: String(r.src_norm),
        text: String(r.src_text == null ? '' : r.src_text) || String(r.src_norm),
        zh: String(r.body_zh),
        provider: String(r.provider == null ? '' : r.provider),
        hits: Number(r.hits) || 0,
        len: Number(r.src_len) || 0,
        at: String(r.updated_at || ''),
      });
      added++;
    } catch (e) { /* 单条失败不影响其余 */ }
  }
  return { pulled: added };
}

/**
 * 把本地全部翻译记忆推回后台（后台 upsert 去重；分批 POST）。
 * 网络/HTTP 出错会抛异常，交给上层决定重试。
 */
async function pushAll() {
  // 🔴 2026-10-18：本地 → 后台 永久关闭（PUSH_ENABLED=false）
  if (!PUSH_ENABLED) return { pushed: 0, skipped: true };
  if (!loggedIn()) return { pushed: 0, skipped: true };
  const rows = db.tmAll.all();
  if (!rows || !rows.length) return { pushed: 0 };
  const payload = rows.map((r) => ({
    src_norm: r.src_norm,
    src_text: r.src_text,
    body_zh: r.body_zh,
    provider: r.provider || '',
    hits: Number(r.hits) || 0,
    src_len: Number(r.src_len) || 0,
    updated_at: r.updated_at || '',
  }));
  let pushed = 0;
  for (let i = 0; i < payload.length; i += PUSH_BATCH) {
    const chunk = payload.slice(i, i + PUSH_BATCH);
    const j = await cloud.request('POST', PUSH_PATH, { rows: chunk }, { timeout: REQ_TIMEOUT });
    pushed += (j && Number(j.applied)) || 0;
  }
  return { pushed };
}

/** 登录时非阻塞拉取（fire-and-forget，失败静默） */
function syncOnLogin() {
  // 🔴 2026-10-18：登录时从后台拉取翻译词典到本地（每次登录都拉）
  if (!PULL_ENABLED) return;
  pullAll().catch(() => {});
}

/**
 * 关闭软件时双向整理（先拉后推），带重试与超时兜底。
 * @param {object} [opt]
 *   retries        重试次数，默认 3
 *   overallTimeoutMs 整体硬上限（ms），默认 12000；到时放弃同步直接关
 *   onProgress     (info) => void，info.phase: start|skip|sync|done|retry|gaveUp
 * @returns {object} { ok, pulled, pushed, gaveUp, skipped, error }
 */
async function syncOnClose(opt) {
  const o = opt || {};
  const retries = o.retries == null ? 3 : o.retries;
  const overallTimeoutMs = o.overallTimeoutMs || 12000;
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
  const startedAt = Date.now();

  // 🔴 2026-10-18：关闭软件时不再做云端同步（改为补建 docx 档案，见 electron/main.js）。
  //   syncOnClose 直接返回「无操作成功」，关闭序列照常走到关闭。
  return { ok: true, pulled: 0, pushed: 0, disabled: true };

  if (onProgress) onProgress({ phase: 'start' });

  if (!loggedIn()) {
    if (onProgress) onProgress({ phase: 'skip', reason: '未登录云端' });
    return { ok: true, skipped: true };
  }

  let lastErr = null;
  let pulled = 0;
  let pushed = 0;

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (onProgress) onProgress({ phase: 'sync', attempt, retries });
    try {
      const p = await pullAll();
      pulled += p.pulled || 0;
      const s = await pushAll();
      pushed += s.pushed || 0;
      if (onProgress) onProgress({ phase: 'done', pulled, pushed });
      return { ok: true, pulled, pushed };
    } catch (e) {
      lastErr = e;
      if (onProgress) onProgress({ phase: 'retry', attempt, error: String((e && e.message) || e) });
      // 整体超时兜底：到时间就放弃，绝不拖慢关闭
      if (Date.now() - startedAt > overallTimeoutMs) break;
      if (attempt < retries) await sleep(Math.min(800, attempt * 400));
    }
  }

  // 3 次仍失败 → 放弃同步，直接关（老板原话"取消就可以"）
  if (onProgress) onProgress({ phase: 'gaveUp', error: lastErr ? String(lastErr.message || lastErr) : '' });
  return { ok: false, gaveUp: true, pulled, pushed, error: lastErr ? String(lastErr.message || lastErr) : '' };
}

module.exports = { pullAll, pushAll, syncOnLogin, syncOnClose, loggedIn };
