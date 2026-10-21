/**
 * 后台翻译队列（综合改造版）
 *
 * 以前的问题：
 *   每条消息单独发一个请求、没有超时、没有并发上限。provider 一慢 / 一限流，
 *   长消息就永远卡在「翻译中」——界面一直转圈，消息却永远翻不出来。
 *
 * 现在的做法（更快 + 不再卡死）：
 *   1. 统一队列 + 并发上限（CONCURRENCY）：不会瞬间并发十几个请求去炸 provider。
 *   2. 每一条 HTTP 请求都带超时（ai.js 里的 AbortController）。超时就放弃，
 *      绝不再「永远翻译中」。
 *   3. 长消息（超过 CHUNK_LIMIT）自动切片，几段并行翻，再拼回来 —— 长消息不再慢。
 *   4. 同一个客户短时间内进来的多条消息，合并成「一次请求」翻完（translateBatch），
 *      原本 N 条 = N 次往返，现在一批 = 1 次。
 *   5. 翻译失败（超时 / 空返回）自动重试一次；仍不行就标 failed，重开客户可再试，
 *      不再假装还在「翻译中」。
 *
 * 节奏不变：消息一到 → 立刻广播 new_message（界面马上出现，右边标「⟳ 等待翻译中…」）
 *          → 后台排队翻译 → 翻完写库 + 广播 translated（界面占位自动消失）。
 *
 * 硬边界：这里只做「翻译成中文」，没有任何发送能力。
 */

const db = require('./db');
const ai = require('./ai');
const lang = require('./lang');
const bubbleConfig = require('./bubbleConfig'); // v2.6.1121：老板指定的「气泡翻译模型」（服务商 key）
const translationMemory = require('./translationMemory'); // v2.6.1122：跨消息翻译记忆（同一句话只翻一次）

/** 同时最多几个翻译在跑（够快，又不会把 AI 服务商打爆） */
const CONCURRENCY = 4;
/** 同客户一次最多合并几条进一个请求 */
const BATCH_MAX = 6;
/** 单条超过这个字数就切片并行翻 */
const CHUNK_LIMIT = 1400;
/**
 * 一条消息【自动】最多试几次就彻底放手（2026-09-30 加，解决反复烧 token）
 *
 * 为什么必须有这个数、而且必须写进数据库：
 *   以前重试次数记在内存里，进程一重启、或者每次重新打开客户就归零，
 *   于是「永远翻不出来」的那批消息（判定不用翻的 / 模型空返回的）被无限重试 ——
 *   每来一条新消息、每打开一次客户，就白烧一轮 AI。
 *   现在次数落在 messages.translate_tries，跨重启都记得：
 *   试满这个数就再也不自动碰，只有用户手动点「重翻这条」才清零重来。
 */
const MAX_AUTO_TRIES = 2;

/** 正在翻译中的消息 id（排队中 + 跑着都算，界面据此显示「等待翻译中」） */
const inflight = new Set();
/** 每个客户最近一次翻译报错 */
const lastError = new Map();
/** 待处理队列 */
const queue = [];
/** 当前并发数 */
let active = 0;
/** 是否已经排了一次 pump（合并同一瞬间涌入的多条消息，让它们能攒成一批） */
let pumpScheduled = false;
function schedulePump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  process.nextTick(() => {
    pumpScheduled = false;
    pump();
  });
}

function isTranslating(msgId) {
  return inflight.has(Number(msgId));
}

function translatingIds() {
  return [...inflight];
}

function errorOf(code) {
  return lastError.get(code) || null;
}

/**
 * 这条还允许自动翻译吗（2026-09-30：挡住反复烧 token 的总闸门）
 *   skipped  = AI 判定「本来就是中文 / 不用翻」 → 永久跳过，一次都不再问
 *   failed   = 试过但没翻出来 → 次数没到上限可以让它再试，到了就放手
 *   其余（从没翻过 / 翻成功过但现在没译文）→ 允许
 */
function autoAllowed(msgId) {
  const row = db.getMessage.get(Number(msgId));
  if (!row) return true;
  const state = row.translate_state || '';
  if (state === 'skipped') return false;
  if (state === 'failed' && (Number(row.translate_tries) || 0) >= MAX_AUTO_TRIES) return false;
  return true;
}

/** 用户手动点「重翻这条」：把账本清零，重新给它机会（只此一次入口，不自动触发） */
function retryManual(msgId, code, body, onDone) {
  const id = Number(msgId);
  if (!id) return false;
  db.resetTranslateTry.run(id);
  db.setTranslateState.run(null, id);
  inflight.delete(id);
  // force：绕过跨消息记忆，真的再翻一次（并用新译文把字典里那条覆盖掉）
  return translateLater(id, code, body, onDone, { force: true });
}

/** 这条要不要进翻译队列（中文 / 空 / AI 没配 → 不翻） */
function shouldQueue(body) {
  if (!body || !String(body).trim()) return false;
  if (lang.needsTranslation(body)) return !!ai.isReady('translate');
  // 中英混着写、正则拿不准 → 归到「翻译环节」问一句要不要翻
  if (lang.isAmbiguous(body) && ai.isReady('translate')) return true;
  return false;
}

/** 把长消息切成几段（优先按换行切，避免一句话断两半） */
function splitChunks(text, limit = CHUNK_LIMIT) {
  if (!text || text.length <= limit) return [text];
  const byLine = String(text).split(/\r?\n+/).filter(Boolean);
  if (byLine.length > 1) {
    const chunks = [];
    let cur = '';
    for (const line of byLine) {
      if (cur && cur.length + 1 + line.length > limit) {
        chunks.push(cur);
        cur = line;
      } else {
        cur = cur ? cur + '\n' + line : line;
      }
    }
    if (cur) chunks.push(cur);
    if (chunks.length) return chunks;
  }
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out.length ? out : [text];
}

/** 从队列里取下一个「工作单元」：长消息/语种兜底单独跑，短消息攒一批 */
function nextUnit() {
  if (!queue.length) return null;
  const head = queue[0];
  if (head.body.length > CHUNK_LIMIT || head.ambiguous) {
    return { type: head.ambiguous ? 'single' : 'long', job: queue.shift() };
  }
  const jobs = [];
  while (jobs.length < BATCH_MAX && queue.length) {
    const j = queue[0];
    if (j.body.length > CHUNK_LIMIT || j.ambiguous) break; // 遇到长的/兜底的中断这一批
    jobs.push(queue.shift());
  }
  return { type: 'batch', jobs };
}

function pump() {
  while (active < CONCURRENCY) {
    const unit = nextUnit();
    if (!unit) break;
    active++;
    runUnit(unit).catch((e) => console.warn('[翻译] 调度异常：', e && e.message)).finally(() => {
      active--;
      pump();
    });
  }
}

/** 翻译一条消息（含长消息切片）；返回中文或 null */
async function translateOne(job) {
  // 「气泡翻译模型」指定的那家（空串 = 跟随 tasks.translate，ai 内部自己回退）
  const picked = bubbleConfig.translateModel();
  // v2.6.1122：先查跨消息翻译记忆 —— 同一句原文以前翻过，这次 0 次 AI 调用直接复用。
  // 🔴 手动「重翻这条」（force）必须跳过这一步，否则拿回的还是旧译文。
  if (!(job && job.force)) {
    const mem = translationMemory.lookup(job.body);
    if (mem && mem.zh) {
      translationMemory.hit(job.body);
      return mem.zh;
    }
  }
  const chunks = splitChunks(job.body);
  let zh = null;
  if (chunks.length === 1) {
    zh = await ai.translate(chunks[0], picked);
  } else {
    const parts = await Promise.all(chunks.map((c) => ai.translate(c, picked).catch(() => null)));
    zh = parts.filter(Boolean).join('\n').trim() || null;
  }
  if (zh) await translationMemory.record(job.body, zh, picked);
  return zh;
}

async function runUnit(unit) {
  try {
    if (unit.type === 'long') {
      const zh = await translateOne(unit.job);
      finish(unit.job, zh, zh ? null : '长消息分段翻译均无返回');
      return;
    }
    if (unit.type === 'single') {
      const job = unit.job;
      // 语种兜底：中英混着写 → 问一句要不要翻
      if (job.ambiguous) {
        const verdict = await ai.decideTranslate(job.body);
        if (verdict !== true) {
          // AI 说本来就是中文 → 记进账本永久跳过（2026-09-30：以前这里当成"失败"，
          // 于是每次打开客户都要再问一遍 AI「这句要不要翻」，白烧两次调用）
          finish(job, null, null, { skip: true });
          return;
        }
      }
      const zh = await translateOne(job);
      finish(job, zh, zh ? null : '翻译无返回');
      return;
    }
    // batch：同客户多条 → 一次请求
    const jobs = unit.jobs;
    if (jobs.length === 1) {
      const zh = await translateOne(jobs[0]);
      finish(jobs[0], zh, zh ? null : '翻译无返回');
      return;
    }
    // v2.6.1122：先按记忆分流 —— 已翻过的那几句直接出结果，只有没命中的才真正发请求
    const pickedBatch = bubbleConfig.translateModel();
    const fromMem = new Map();
    const need = [];
    for (const j of jobs) {
      if (j.force) { need.push(j); continue; } // 手动重翻的：不许拿记忆里的旧译文顶
      const mem = translationMemory.lookup(j.body);
      if (mem && mem.zh) {
        fromMem.set(j.id, mem.zh);
        translationMemory.hit(j.body);
      } else {
        need.push(j);
      }
    }
    const posOf = new Map();
    need.forEach((j, i) => posOf.set(j.id, i));
    let arr = [];
    if (need.length) {
      arr = await ai.translateBatch(need.map((j) => j.body), pickedBatch);
      if (!Array.isArray(arr) || arr.length !== need.length) {
        // 模型没按数组回 → 退化为逐条翻，保证不丢
        arr = await Promise.all(need.map((j) => translateOne(j).catch(() => null)));
      }
      const recPromises = [];
      need.forEach((j, i) => {
        const v = arr && arr[i] ? String(arr[i]).trim() : '';
        if (v) recPromises.push(translationMemory.record(j.body, v, pickedBatch));
      });
      if (recPromises.length) await Promise.all(recPromises);
    }
    jobs.forEach((j) => {
      let zh = null;
      if (fromMem.has(j.id)) {
        zh = fromMem.get(j.id);
      } else {
        const i = posOf.get(j.id);
        zh = i !== undefined && arr && arr[i] ? String(arr[i]).trim() : null;
      }
      finish(j, zh, zh ? null : '翻译无返回');
    });
  } catch (e) {
    const failed = unit.type === 'long' || unit.type === 'single' ? [unit.job] : unit.jobs;
    for (const j of failed) finish(j, null, (e && e.message) || '翻译失败');
  }
}

function notify(job, bodyZh, error) {
  try {
    if (job.onDone) job.onDone({ code: job.code, msgId: job.id, bodyZh: bodyZh || '', error });
  } catch (e) {
    /* 回调出错不能影响别的消息 */
  }
}

function finish(job, zh, error, opt = {}) {
  if (zh) {
    db.setTranslation.run(zh, job.id);
    db.setTranslateState.run('done', job.id);
    db.resetTranslateTry.run(job.id); // 翻成功了就把旧账清零
    lastError.delete(job.code);
    inflight.delete(job.id);
    notify(job, zh, null);
    return;
  }
  // 判定「本来就中文 / 不用翻」：不是错误，只是不用翻 —— 记 skipped，永久不再问
  if (opt.skip) {
    db.setTranslateState.run('skipped', job.id);
    db.resetTranslateTry.run(job.id);
    lastError.delete(job.code);
    inflight.delete(job.id);
    notify(job, '', null);
    return;
  }
  // 没翻出来（超时 / 空返回）：次数记进数据库，不再是内存里那个一重启就归零的计数器
  db.bumpTranslateTry.run(job.id);
  const tries = Number(db.getMessage.get(job.id)?.translate_tries) || 0;
  if (tries < MAX_AUTO_TRIES) {
    inflight.add(job.id); // 还在处理中，界面继续显示「等待翻译中」
    queue.push(job);
    pump();
    return;
  }
  db.setTranslateState.run('failed', job.id);
  lastError.set(job.code, error || '翻译无返回');
  inflight.delete(job.id);
  notify(job, '', error || '翻译无返回');
}

/**
 * 丢一条进后台翻译，立刻返回。
 * @returns {boolean} 是否真的排上了
 */
function translateLater(msgId, code, body, onDone, opt = {}) {
  const id = Number(msgId);
  if (!id) return false;
  if (inflight.has(id)) return false;
  if (queue.some((j) => j.id === id)) return false;
  if (!shouldQueue(body)) return false;
  // 总闸门：已经判定不用翻的、或者已经试满次数还没翻出来的，一律不再自动翻
  if (!autoAllowed(id)) return false;

  const job = {
    id,
    code,
    body: String(body),
    onDone,
    /* v2.6.1122：手动点「重翻这条」时置 true。
     * 必须真的再调一次 AI —— 否则跨消息记忆会把旧译文又递回来，
     * 老板点了「重翻」却什么都没变，等于这个按钮失效。 */
    force: !!(opt && opt.force),
    ambiguous: !lang.needsTranslation(body) && lang.isAmbiguous(body) && ai.isReady('translate'),
  };
  inflight.add(id);
  queue.push(job);
  schedulePump();
  return true;
}

/**
 * 把「还没翻译的外文消息」补翻一遍（按时间顺序，只补最近 max 条）。
 * 包括之前翻失败的（重开客户即可重试）。
 * 2026-10-15 v2.6.1121：**两个方向都补**（自己发出去的也要有中文），不再只看 in。
 * @returns {number} 排上队的条数
 */
function backfill(code, onDone, max = 12) {
  const rows = db.listMessages.all(code);
  const todo = rows
    .filter(
      (m) =>
        !m.body_zh &&
        lang.needsTranslation(m.body) &&
        !inflight.has(m.id),
    )
    .slice(-max);

  let queued = 0;
  for (const m of todo) {
    // 🔴 手动补翻（「↻ 补气泡」按钮走这里）：把之前翻失败 / 重试满的那批也放进来。
    //   先重置它的状态，translateLater 内部的 autoAllowed 才放它通过 —— 否则 failed 消息永远卡死、按钮点烂也没用。
    if (m.translate_state === 'failed' || (Number(m.translate_tries) || 0) >= MAX_AUTO_TRIES) {
      db.resetTranslateTry.run(m.id);
    }
    if (translateLater(m.id, code, m.body, onDone)) queued++;
  }
  return queued;
}

/**
 * 还没翻的外文消息还有几条（界面用来决定要不要提示「点这里补翻」）
 * 2026-09-30：把「判定不用翻」和「已试满次数仍翻不出来」的都排除掉 ——
 * 不然界面永远显示"还有 N 条没翻"，每次打开客户都要白跑一趟补翻请求。
 * 2026-10-15 v2.6.1121：两个方向都算（口吻跟着 backfill 走）。
 */
function untranslatedCount(code) {
  const rows = db.listMessages.all(code);
  return rows.filter(
    (m) =>
      !m.body_zh &&
      m.translate_state !== 'failed' &&
      m.translate_state !== 'skipped' &&
      lang.needsTranslation(m.body),
  ).length;
}

module.exports = {
  isTranslating,
  translatingIds,
  translateLater,
  retryManual,
  autoAllowed,
  MAX_AUTO_TRIES,
  backfill,
  untranslatedCount,
  shouldTranslate: shouldQueue,
  errorOf,
  needsTranslation: lang.needsTranslation,
  looksChinese: lang.looksChinese,
};
