/**
 * 常用话术库（软件端）· 本机优先 · 云端后台留一份
 *
 * 2026-10-03 老板定的两条：
 *   · 自己添加 / 改的话术【先落本机】：界面立刻生效，不用每次都去读数据库；
 *   · 同时【后台上传到云端】：管理员和二级管理员在后台「常用话术」里看得见，每条带着自己的编号；
 *     好内容管理员可以「采纳」进主数据，不好的可以「删除」。
 *   上传不动（没登录 / 断网）也不丢 —— 留在 pending 队列里，下次启动、下次改动、点「⟳」时重试。
 *
 * 铁律不变：
 *   · 云端【主数据】只读，所有写操作都只进「自己编号的仓库」；
 *   · 话术库【跟编号走、全局一份】，不分客户；
 *   · 云端永远是对的：队列清空后会用云端返回的合并结果覆盖本机快照。
 */

const fs = require('fs');
const path = require('path');
const { DATA_ROOT } = require('./paths');

const CACHE_FILE = path.join(DATA_ROOT, 'replies.json');

let cloud = null;
function cloudMod() {
  if (cloud === null) {
    try { cloud = require('./cloud'); } catch (e) { cloud = false; }
  }
  return cloud || null;
}

function cloudReady() {
  const c = cloudMod();
  if (!c) return false;
  try {
    const st = c.status();
    return !!(st.configured && st.loggedIn);
  } catch (e) { return false; }
}

function readJsonSafe(file, dflt) {
  try {
    if (!fs.existsSync(file)) return dflt;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return dflt; }
}

/** 本机快照：{ version, scenes, syncedAt, pending }（老快照只有 scenes，也能读）。 */
function readLocal() {
  const d = readJsonSafe(CACHE_FILE, null);
  if (!d || typeof d !== 'object') return { version: 1, scenes: [], syncedAt: null, pending: [] };
  return {
    version: 1,
    scenes: Array.isArray(d.scenes) ? d.scenes : [],
    syncedAt: d.syncedAt || null,
    pending: Array.isArray(d.pending) ? d.pending : [],
  };
}

function saveLocal(d) {
  try {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(d, null, 2), 'utf8');
  } catch (e) { /* 本机写不了就算了，不挡界面 */ }
}

function nowIso() { return new Date().toISOString(); }

/** 本地 id：云端接受客户端给的 id，所以本机先定下来，后面改名/加回复才对得上。 */
function localId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 把一次改动塞进待上传队列。同一条东西还没上传就又被改/删了 →
 * 直接改队列里那条（或干脆取消），别叠出一堆云端会报 not found 的操作。
 */
function enqueue(l, job) {
  const find = (op) => l.pending.filter((j) => j.op === op && j.id === job.id)[0];
  if (job.op === 'updateScene') {
    const head = find('addScene');
    if (head) { head.name = job.name; return; }
  }
  if (job.op === 'deleteScene') {
    const head = find('addScene');
    if (head) { l.pending = l.pending.filter((j) => j !== head); return; }  // 还没上传就删 → 取消
  }
  if (job.op === 'updateText') {
    const head = find('addText');
    if (head) { head.tone = job.tone; head.en = job.en; head.zh = job.zh; return; }
  }
  if (job.op === 'deleteText') {
    const head = find('addText');
    if (head) { l.pending = l.pending.filter((j) => j !== head); return; }
  }
  l.pending.push(job);
}

/** 本机改完立刻落盘 + 入队（界面不等网络）。 */
function mutate(fn) {
  const l = readLocal();
  fn(l);
  saveLocal(l);
  return l;
}

/* ------------------------------- 读 ------------------------------- */

/**
 * 读话术库。本机有快照就直接用（不等网络）；本机还没有（刚装 / 没同步过）才去云端拿一次。
 * @returns {{scenes:Array, source:'local'|'local-pending'|'cloud'|'cache'|'master'|'empty', syncedAt:string|null, pending:number}}
 */
async function getRepliesAsync() {
  const l = readLocal();
  if (l.scenes.length) {
    return {
      scenes: l.scenes,
      source: l.pending.length ? 'local-pending' : 'local',
      syncedAt: l.syncedAt,
      pending: l.pending.length,
    };
  }
  // 本机没东西 → 第一次必须问云端要
  if (cloudReady()) {
    try {
      const r = await cloudMod().getReplies();
      if (r && Array.isArray(r.scenes) && r.scenes.length) {
        saveLocal({ version: 1, scenes: r.scenes, syncedAt: nowIso(), pending: [] });
        return { scenes: r.scenes, source: 'cloud', syncedAt: nowIso(), pending: 0 };
      }
    } catch (e) { /* 云端抖动 → 继续往下找兜底 */ }
  }
  // 没快照时，用「同步话题」拉下来的主数据里那份话术当兜底
  const c = cloudMod();
  if (c && typeof c.cachedMaster === 'function') {
    const m = c.cachedMaster();
    const scenes = (m && m.replies) || [];
    if (scenes.length) return { scenes, source: 'master', syncedAt: null, pending: 0 };
  }
  return { scenes: [], source: 'empty', syncedAt: null, pending: 0 };
}

/* --------------------------- 上传队列 --------------------------- */

let flushing = false;

async function runJob(c, job) {
  switch (job.op) {
    case 'addScene': return c.addReplyScene(job.name, job.id);
    case 'updateScene': return c.updateReplyScene(job.id, job.name);
    case 'deleteScene': return c.deleteReplyScene(job.id);
    case 'addText': return c.addReplyText(job.rid, { id: job.id, tone: job.tone, en: job.en, zh: job.zh });
    case 'updateText': return c.updateReplyText(job.id, { tone: job.tone, en: job.en, zh: job.zh });
    case 'deleteText': return c.deleteReplyText(job.id, job.rid);
    default: return null;
  }
}

/**
 * 把本机没上传的改动推到云端；推完再用云端返回的合并结果覆盖本机快照。
 * 没登录 / 断网 → 什么都不做，队列留着（返回 null）。
 * @returns {Promise<Array|null>} 同步后的 scenes（null = 这次没同步成）
 */
async function flushPending() {
  if (flushing) return null;
  if (!cloudReady()) return null;
  flushing = true;
  try {
    const c = cloudMod();
    // 1) 先把队列推上去
    for (;;) {
      const l = readLocal();
      if (!l.pending.length) break;
      const job = l.pending[0];
      try {
        await runJob(c, job);
      } catch (e) {
        break;                       // 推不动就停在这儿，剩下的下次再试
      }
      const l2 = readLocal();        // 重读一次：期间用户可能又改了
      l2.pending = l2.pending.slice(1);
      saveLocal(l2);
    }
    // 2) 队列空了 → 拉云端权威结果（管理员新采纳的主数据也在这儿带回来）
    const l3 = readLocal();
    if (l3.pending.length) return l3.scenes;
    const r = await c.getReplies();
    if (r && Array.isArray(r.scenes)) {
      saveLocal({ version: 1, scenes: r.scenes, syncedAt: nowIso(), pending: [] });
      return r.scenes;
    }
    return l3.scenes;
  } catch (e) {
    return null;
  } finally {
    flushing = false;
  }
}

/** 还有几条本机改动没上传（界面上提示「待上传 N」用）。 */
function pendingCount() {
  return readLocal().pending.length;
}

/** 「⟳」按钮 / 启动后台同步：强制跟云端对一次。没登录时才报错。 */
async function syncAsync() {
  if (!cloudReady()) {
    const e = new Error('还没登录编号，连不上云端（本机改的内容会留着，登录后自动上传）');
    e.offline = true;
    throw e;
  }
  const scenes = await flushPending();
  if (!scenes) throw new Error('同步失败，本机改动已留着，等下次重试');
  const l = readLocal();
  return { scenes, syncedAt: l.syncedAt, pending: l.pending.length };
}

/* ------------------------------- 写 ------------------------------- */

async function addSceneAsync(name) {
  const id = localId('rs');
  const nm = String(name || '').trim() || '新场景';
  const l = mutate((x) => {
    x.scenes.push({ id, name: nm, texts: [] });
    enqueue(x, { op: 'addScene', id, name: nm });
  });
  void flushPending();
  return l.scenes;
}

async function updateSceneAsync(id, name) {
  const nm = String(name || '').trim();
  const l = mutate((x) => {
    const s = x.scenes.filter((v) => v.id === id)[0];
    if (s && nm) s.name = nm;
    enqueue(x, { op: 'updateScene', id, name: nm });
  });
  void flushPending();
  return l.scenes;
}

async function deleteSceneAsync(id) {
  const l = mutate((x) => {
    x.scenes = x.scenes.filter((v) => v.id !== id);
    enqueue(x, { op: 'deleteScene', id });
  });
  void flushPending();
  return l.scenes;
}

async function addTextAsync(rid, tone, en, zh) {
  const id = localId('rt');
  const l = mutate((x) => {
    const s = x.scenes.filter((v) => v.id === rid)[0];
    if (s) (s.texts = s.texts || []).push({ id, tone: tone || '', en: en || '', zh: zh || '' });
    enqueue(x, { op: 'addText', id, rid, tone: tone || '', en: en || '', zh: zh || '' });
  });
  void flushPending();
  return l.scenes;
}

async function updateTextAsync(id, patch) {
  const p = patch || {};
  const l = mutate((x) => {
    for (const s of x.scenes) {
      const t = (s.texts || []).filter((v) => v.id === id)[0];
      if (t) {
        if (p.tone !== undefined) t.tone = p.tone;
        if (p.en !== undefined) t.en = p.en;
        if (p.zh !== undefined) t.zh = p.zh;
      }
    }
    enqueue(x, { op: 'updateText', id, tone: p.tone || '', en: p.en || '', zh: p.zh || '' });
  });
  void flushPending();
  return l.scenes;
}

async function deleteTextAsync(id, rid) {
  const l = mutate((x) => {
    let owner = rid;
    for (const s of x.scenes) {
      const before = (s.texts || []).length;
      s.texts = (s.texts || []).filter((v) => v.id !== id);
      if (!owner && s.texts.length !== before) owner = s.id;
    }
    enqueue(x, { op: 'deleteText', id, rid: owner || '' });
  });
  void flushPending();
  return l.scenes;
}

module.exports = {
  getRepliesAsync, syncAsync, flushPending, pendingCount,
  addSceneAsync, updateSceneAsync, deleteSceneAsync,
  addTextAsync, updateTextAsync, deleteTextAsync,
  cloudReady,
  CACHE_FILE,
};
