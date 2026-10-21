/**
 * 媒体延时重抓（2026-10-07 v1.1.0）
 *
 * ## 要解决的问题
 * whatsapp-web.js 的 `Message.js:49`：`this.hasMedia = Boolean(data.directPath)`。
 * `directPath` 是媒体在 WhatsApp 服务器上的真实地址，**消息刚推过来时经常还没到**
 * （图片还在上传/排队）。这时候：
 *   - 官方 `downloadMedia()` 调不了（没有地址）
 *   - 消息正文里也还没有 base64
 *   → media_src='none'，界面上只剩一个占位符，图永远不出现。
 *
 * ## 老板的原话（2026-10-07）
 * "如果你需要已读信息才能获取图片的信息，那你告诉我一下" → 不需要，见下。
 * "你如果是检测到图片的信息的时候你可以开始获取，如果暂时获取不到
 *   可以延迟几秒重新再抓取" → 就是这个模块。
 *
 * ## 为什么和「已读」无关
 * 全项目没有 sendSeen / markRead 调用，抓图只依赖 directPath 和消息正文。
 * 所以**不需要为了看图去点已读**，也不会因为没读而漏图。
 *
 * ## 退避表
 * 10/ 30 / 90 / 240 / 600 秒（1/ 1.5 / 3 / 6 / 15 分钟），
 * 共 5 轮，之后标记 'fail' 彻底放手 —— 避免一条永远抓不到的图
 * 在后台无限刷（和 translate_tries / media_tries 同一个教训：账本写库，不放内存）。
 *
 * ## 硬边界
 * 只读本地文件、只写数据库；没有任何发送能力。
 */

const db = require('./db');
const path = require('path');
const media = require('./media');

/**
 * 退避表（秒）。数组下标 = 已经重抓过几次。
 *
 * 🔴 2026-10-08 调整：原先10/ 30 / 90 / 240 / 600，总共只覆盖到 10 分钟。
 * 但路B（回页面重取）要等 directPath 落地 + mediaStage 变成 RESOLVED，
 * WhatsApp 服务器有时候要更久。改成**前密后疏**：
 *   前 4 轮拉近（15/ 30 / 60 / 120 秒）—— 绝大多数图在这 4 分钟内就能拿到；
 *   后 3 轮拉远（300 / 600 / 900 秒）—— 覆盖到 30 分钟，给慢的一次机会。
 *
 * 为什么不是无限重试：一条永远抓不到的图在后台无限刷，
 * 和 translate_tries / media_tries 同一个教训 —— 账本写库，不放内存。
 */
const BACKOFF_SEC = [15, 30, 60, 120, 300, 600, 900];

/** 正在排队/重抓中的消息 id，内存态只用来防重复排队（账本在库里） */
const inflight = new Set();

/** 现在存不存在"还没抓到图的媒体消息"（决定要不要挂着定时器） */
let timer = null;
let wake = null;

/** 注入的抓图函数（main.js 启动时塞进来，避免这里 require main 造成循环依赖） */
let fetcher = null;

/**
 * 注册真正的抓图动作。
 * @param {Function} fn async ({ customerCode, waMsgId, accountId }) =>
 *                { path, src, mimetype, kind } | null
 */
function setFetcher(fn) {
  fetcher = typeof fn === 'function' ? fn : null;
}

/**
 * 一条消息值不值得重抓。
 * - 只重抓客户发来的（direction='in'）
 * - 现在确实没有 media_path
 * - 而且它本来就是媒体消息（media_type 是媒体，或当初判定是媒体）
 * 🔴 自己发出去的一律不重抓 —— 发出去时 directPath 必然有，缺了是本地问题，重抓也没用。
 */
function isFetchable(row) {
  if (!row) return false;
  if (row.direction !== 'in') return false;
  if (row.media_path) return false;
  const t = String(row.media_type || '');
  return t === 'image' || t === 'sticker' || t === 'video' || t === 'document'
    || t === 'ptt' || t === 'audio' || row.media_src === 'none';
}

/**
 * 抓到图之后：写库 + 通知界面 + 排AI 看图。
 * @param {object} row messages 那一行
 * @param {object} saved saveMedia 的返回值 { path, src, mimetype, kind }
 * @param {Function} onDone 回调（main.js 塞进来，用来broadcast + 排队看图）
 */
function onFetched(row, saved, onDone) {
  if (!saved || !saved.path) {
    // 还是没拿到 → 记一笔，等下一轮退避
    db.bumpMediaFetchTry.run(BACKOFF_SEC.length, row.id);
    return false;
  }
  db.setMediaFetched.run(saved.path, saved.src || 'download', saved.kind || '', row.id);
  const fresh = db.getMessage.get(row.id);
  console.log(`[media-fetch] 第 ${row.id} 条补抓成功：${saved.src} → ${path.basename(saved.path)}`);
  try {
    if (onDone) onDone({ code: row.customer_code, row: fresh, saved });
  } catch (e) {
    /* 回调出错绝不能影响其他消息 */
  }
  return true;
}

/**
 * 跑一轮：把该重抓的消息都试一遍。
 * @param {Function} fetchOne async (row) => { path, src, mimetype, kind } | null
 * @param {Function} onDone抓到之后的回调
 * @returns {Promise<{tried:number, got:number}>}
 */
async function runOnce(fetchOne, onDone) {
  const maxTries = BACKOFF_SEC.length;
  const rows = db.listPendingMedia.all(maxTries, 30);
  let tried = 0;
  let got = 0;
  for (const row of rows) {
    if (!isFetchable(row)) {
      // 不该抓的（已经抓到过 / 不是媒体）→ 直接销号，别让它一直占着 pending
      db.setMediaFetched.run(null, '', '', row.id);
      continue;
    }
    if (inflight.has(row.id)) continue;
    const tries = Number(row.media_fetch_tries) || 0;
    if (tries >= maxTries) continue;
    inflight.add(row.id);
    tried += 1;
    try {
      const saved = await fetchOne(row);
      if (saved && saved.path) {
        if (onFetched(row, saved, onDone)) got += 1;
      } else {
        db.bumpMediaFetchTry.run(maxTries, row.id);
      }
    } catch (e) {
      db.bumpMediaFetchTry.run(maxTries, row.id);
      console.warn(`[media-fetch] 第 ${row.id} 条重抓出错：`, (e && e.message) || e);
    } finally {
      inflight.delete(row.id);
    }
  }
  return { tried, got };
}

/**
 * 启动延时重抓。
 *
 * 调度方式（不轮询！）：每抓到一条"还没成功的"，就为它单独排一个 setTimeout。
 * 没有待重抓的消息时**一个定时器都不挂**，彻底不空转。
 *
 * @param {Function} fetchOne async (row) => { path, src, mimetype, kind } | null
 * @param {Function} onDone抓到之后的回调（main.js：broadcast + 排AI 看图 + 重写档案）
 * @param {object} opts { reset:boolean 启动时把历史 fail 复位 }
 */
function start(fetchOne, onDone, opts = {}) {
  stop();
  if (opts.reset) {
    try { db.resetPendingMedia.run(); } catch (e) { /* 表还没建好就算*/ }
  }
  if (typeof fetchOne !== 'function') {
    console.warn('[media-fetch] 没给抓图函数，延时重抓不启动');
    return;
  }
  fetcher = fetchOne;

  /** 排下一轮 */
  const schedule = () => {
    if (timer) return;
    const step = BACKOFF_SEC[0];
    timer = setTimeout(async () => {
      timer = null;
      try {
        await runOnce(fetcher, onDone);
      } catch (e) {
        console.warn('[media-fetch] 这一轮出错：', (e && e.message) || e);
      }
      // 这一轮里如果又产生了新的 pending（比如新消息刚进来），继续排
      if (hasPending()) schedule();
    }, step * 1000);
    if (timer.unref) timer.unref();
  };

  const hasPending = () => {
    try {
      const rows = db.listPendingMedia.all(BACKOFF_SEC.length, 1);
      return rows.length > 0;
    } catch (e) {
      return false;
    }
  };

  wake = () => {
    if (hasPending()) schedule();
  };

  // 启动时先看有没有历史遗留的 pending（有就立刻跑一轮）
  if (hasPending()) {
    // 稍等一拍再跑，别和登录/历史同步抢浏览器
    setTimeout(() => {
      runOnce(fetcher, onDone)
        .then((r) => { if (r.tried) console.log(`[media-fetch] 启动补抓：试${r.tried} 条，补到${r.got} 张`); })
        .catch(() => {})
        .then(() => { if (hasPending()) schedule(); });
    }, 8000);
  }
}

function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  wake = null;
}

/** 有新消息进来时调一下：唤醒重抓 */
function notify() {
  if (typeof wake === 'function') {
    try { wake(); } catch (e) { /* 忽略 */ }
  }
}

/** 测试用：直接跑一轮 */
async function tick(fetchOne, onDone) {
  return runOnce(fetchOne || fetcher, onDone);
}

/** 测试/诊断用：某条消息现在是什么状态 */
function statusOf(msgId) {
  const row = db.getMessage.get(Number(msgId));
  if (!row) return null;
  return {
    id: row.id,
    mediaPath: row.media_path || '',
    mediaSrc: row.media_src || '',
    mediaType: row.media_type || '',
    fetchState: row.media_fetch_state || '',
    fetchTries: Number(row.media_fetch_tries) || 0,
    fetchable: isFetchable(row),
  };
}

module.exports = {
  BACKOFF_SEC,
  isFetchable,
  start,
  stop,
  notify,
  tick,
  statusOf,
  setFetcher,
};
