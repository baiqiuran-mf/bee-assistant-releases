/**
 * 内置 WA webview（WA①~⑤）取图模块（2026-10-20，v2.6.1170）
 *
 * ## 🔴 四模块红线（最高优先，盖过一切）
 * 这是「内置 WA webview」**自己**的取图模块，和外置 Chrome + CDP（src/mediaRaw.js）
 * **完全分开**：两个模块互不 require、互不影响、绝不抽公共函数。
 *   · 外置一号~五号 走 `client.pupPage.evaluate`；
 *   · 本模块走 `whatsappWebView.findGuest(partition).executeJavaScript`，
 *     按分区（persist:wa6 ~ persist:wa10）精确定位每个内置 webview，绝不串台。
 * 页面里 B+C 那段脚本（路B 回页面取完整对象 → 路C 强制解密）虽然和外置思路相似，
 * **代码是本模块自己写的**，没有复用 mediaRaw.js 的任何函数 —— 改一个不会牵动另一个。
 *
 * ## 和外置 mediaFetch.js 的关系
 * mediaFetch.js 是「外置 WA」的调度器，本文件是「内置 WA」的调度器，各自独立、不共用。
 * 唯一下游动作「抓到图之后」复用 main.js 的 `onMediaFetched` 回调（通过 start 注入），
 * 那是通用基建（AI 看图 + 重写档案 + 广播），不是取图逻辑，复用无妨。
 *
 * ## 取图流程
 * 1) 内置 webview 里某客户发了图 → handleWhatsappWebMessage 把 media_fetch_state 标 'pending' 入库存盘。
 * 2) 本模块的调度器从 db.listPendingWaWebMedia 捞出这些 pending（只挑 channel='whatsapp-web'）。
 * 3) 按 account_id 查到对应分区 → findGuest(partition) 拿到 webview 页面。
 * 4) executeJavaScript 跑只读 B+C 脚本：WWA.Msg.get(id) → downloadAndMaybeDecrypt 解密原图。
 * 5) 落盘（图片走 imageShrink 压缩到小图，其他原样存）→ db.setMediaFetched 钉成 done → 回调 onMediaFetched。
 *
 * ## 硬边界
 * 只读本地文件、只写 media/ 目录、只写数据库；没有任何发送能力。
 */

const db = require('./db');
const ids = require('./ids');
const path = require('path');
const fs = require('fs');
const whatsappWebView = require('./whatsappWebView');
const shrink = require('./imageShrink');
const paths = require('./paths');

/** 退避表（秒），和 mediaFetch 同款：前密后疏，最多 7 轮后标记 fail 彻底放手 */
const BACKOFF_SEC = [15, 30, 60, 120, 300, 600, 900];
const MAX_TRIES = BACKOFF_SEC.length;

/** 正在抓的消息 id（内存态只防重复排队，账本在库里） */
const inflight = new Set();

/** 「这次不该算失败」的哨兵：webview 还没就绪（guest 没开/没登录）时返回它，
 *  runOnce 见到它不会 burn 一次重试，等 webview 好了再来一轮自然就抓到了——
 *  否则窗口一关 / 刚启动那一两拍就被算成失败，7 次耗光直接变 fail 永远不抓。 */
const SKIP = { skipped: true };

/** main.js 注入的「抓到图之后」回调（复用 onMediaFetched） */
let onFetchedCb = null;
/** media 目录（start 时确定） */
let mediaDir = '';

/* ================================================================
 * 一、只在 webview 内跑的 B+C 脚本（字符串，executeJavaScript 执行）
 *    🔴 这段是本模块自己写的，不依赖 mediaRaw.js。
 * ================================================================ */

/**
 * 在页面里按消息 id 取完整对象并解密出原图 base64。
 * 入参 idStr 形如 `0_15551234567@c.us_3EB0...` 或 `1_...`（probe 重建的格式）。
 * 返回 { data, mimetype, filename, size } | { error } | { expired:true }。
 */
const PAGE_FETCH_SOURCE = `(async function (idStr) {
  try {
    var WWA = window.require('WAWebCollections');
    if (!WWA || !WWA.Msg) return { error: 'no-WAWebCollections' };

    var parts = String(idStr).split('_');
    var fromMe = parts[0] === '1';
    var remote = parts[1] || '';
    var mid = parts.slice(2).join('_');

    // 🔴 2026-10-20 v2 修复：**优先按 mid 唯一值遍历集合**找消息对象 ——
    //    不依赖 remote 是否带 @c.us、也不依赖 Msg.get 的 key 格式（WA 内部 false_/true_，probe 存 0_/1_）。
    //    探针证明集合的取值口是 getModelsArray()；之前这里写的是 WWA.Msg.models（很可能根本不存在）→ 永远 msg-not-found → 取不到图。
    function arrOf(coll) {
      try {
        if (!coll) return [];
        if (typeof coll.getModelsArray === 'function') return coll.getModelsArray() || [];
        if (Array.isArray(coll.models)) return coll.models;
      } catch (e) {}
      return [];
    }
    var msg = null;
    var list = arrOf(WWA.Msg);
    for (var i = 0; i < list.length; i++) {
      var mm = list[i]; var ido = mm && mm.id;
      if (ido && String(ido.id) === mid) { msg = mm; break; }
    }
    // 兜底：Msg.get 多种 key 试（含去掉 @server 的写法）
    if (!msg) {
      var cands = [idStr,
        (fromMe ? 'true_' : 'false_') + remote + '_' + mid,
        (fromMe ? 'true_' : 'false_') + String(remote).split('@')[0] + '_' + mid];
      for (var c = 0; c < cands.length && !msg; c++) {
        try { msg = WWA.Msg.get(cands[c]); } catch (e) { msg = null; }
      }
    }
    if (!msg && typeof WWA.Msg.getMessagesById === 'function') {
      try {
        var byId = await WWA.Msg.getMessagesById([(fromMe ? 'true_' : 'false_') + remote + '_' + mid]);
        if (byId && byId.messages && byId.messages[0]) msg = byId.messages[0];
      } catch (e) { msg = null; }
    }
    if (!msg) return { error: 'msg-not-found', mid: mid, remote: remote };

    // ---- 路C：强制 resolve（directPath / mediaKey 可能还没到）----
    try {
      var stage = msg.mediaData && msg.mediaData.mediaStage;
      if (typeof msg.downloadMedia === 'function' && (!msg.directPath || (stage && stage !== 'RESOLVED'))) {
        await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      }
    } catch (e) { /* 继续，下面再判 */ }
    if (msg.mediaData && msg.mediaData.mediaStage === 'REUPLOADING') {
      return { expired: true };
    }
    if (!msg.directPath) return { error: 'no-directPath', hasMedia: !!msg.hasMedia, type: String(msg.type || '') };
    // 🔴 2026-10-20 补：msg.type 可能为空（媒体未完全加载），下载解密需要明确的类型，
    //    从 mimetype / mediaData 反推一个，避免 downloadAndMaybeDecrypt 因 type 空而失败。
    var dlType = msg.type;
    if (!dlType && msg.mimetype) {
      var mmx = String(msg.mimetype).toLowerCase();
      if (mmx.indexOf('image/') >= 0) dlType = 'image';
      else if (mmx.indexOf('video/') >= 0) dlType = 'video';
      else if (mmx.indexOf('audio/') >= 0) dlType = 'audio';
      else dlType = 'document';
    }
    if (!dlType && msg.mediaData && msg.mediaData.type) dlType = msg.mediaData.type;
    if (!dlType) dlType = 'image';
    var mockQpl = { addAnnotations: function () { return this; }, addPoint: function () { return this; } };
    var decrypted = await window.require('WAWebDownloadManager')
      .downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: dlType,
        signal: new AbortController().signal,
        downloadQpl: mockQpl,
      });
    if (!decrypted) return { error: 'decrypt-empty' };
    // 🔴 2026-10-20 修复：内置 WA webview 不暴露 window.WWebJS（那是外置 Chrome + whatsapp-web.js 才有），
    //    原先调 arrayBufferToBase64Async 必抛错 → 每条图取图失败 → 7 次后 media_fetch_state='fail'，media_path 永远空。
    //    改成页面内自实现 ArrayBuffer→base64（btoa 分块，避免长数组爆栈），与外置 mediaRaw.js 解耦但功能等价。
    var abToBase64 = function (buf) {
      var bytes = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
      var binary = '';
      var ch = 0x8000;
      for (var i = 0; i < bytes.length; i += ch) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + ch));
      }
      return btoa(binary);
    };
    var data = abToBase64(decrypted);
    return {
      data: data,
      mimetype: msg.mimetype || 'image/jpeg',
      filename: msg.filename || null,
      size: msg.size || null,
      type: dlType,
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
})`;

/* ================================================================
 * 二、页面外：单条取图（拿到分区 → 跑脚本 → 落盘）
 * ================================================================ */

/** mimetype → 扩展名（小工具，够用就行） */
function mimeToExt(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/3gpp') return '3gp';
  if (m === 'audio/mpeg' || m === 'audio/mp3') return 'mp3';
  if (m === 'audio/ogg') return 'ogg';
  if (m === 'audio/mp4' || m === 'audio/m4a') return 'm4a';
  if (m.includes('pdf')) return 'pdf';
  const tail = m.split('/')[1] || 'bin';
  return tail.replace(/[^a-z0-9]/g, '') || 'bin';
}

/** mimetype → 媒体大类（image/audio/video/document）；页面给的 type 不可全信，以落盘 MIME 为准 */
function kindFromMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m.includes('pdf')) return 'document';
  return '';
}

/** account_id（10~14）→ 内置 webview 分区 */
function partitionOf(accountId) {
  const acc = Number(accountId);
  const entry = ids.WA_EMBEDDED.find((e) => e.accId === acc);
  return entry ? entry.partition : null;
}

/**
 * 🔴 单条取图（内置 WA webview 专属）。
 * @param {object} row messages 表一行（需 account_id / wa_msg_id / customer_code / media_type）
 * @returns {Promise<{path:string,src:string,mimetype:string,kind:string,bytes:number}|null>}
 */
async function fetchOne(row) {
  if (!row) return null;
  const partition = partitionOf(row.account_id);
  // 拿不到分区（不是内置 WA 账号）→ 不动，等外置那套处理（外置走别的渠道，不会碰 whatsapp-web）
  if (!partition) return SKIP;

  const guest = whatsappWebView.findGuest(partition);
  if (!guest) {
    // webview 没开 / 没登录 → 这次不算失败，留 pending 等下一轮（别 burn 重试次数）
    return SKIP;
  }

  // wa_msg_id 形如 `wa1:0_15551234567@c.us_3EB0...` → 去掉 `waN:` 前缀还原成页面 id
  const raw = String(row.wa_msg_id || '');
  const idStr = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
  if (!idStr) return null;

  let res = null;
  try {
    res = await guest.executeJavaScript(`${PAGE_FETCH_SOURCE}(${JSON.stringify(idStr)})`, false);
  } catch (e) {
    console.warn('[wa-web-media] 页面脚本执行出错：', (e && e.message) || e);
    return null;
  }

  if (!res || !res.data) {
    // no-directPath / not-found / expired / decrypt 失败 → 留 pending（directPath 可能还没到）
    // 🔴 2026-10-20：把真实原因打出来，老板在日志里能看见「为什么这张没取到」，不再静默。
    const why = res
      ? (res.error || (res.expired ? 'expired(媒体已过期/需重新上传)' : 'no-data'))
      : 'no-result(页面没返回)';
    console.log(`[wa-web-media] 第 ${row.id} 条暂未取到（${why}），留 pending 下轮再试`);
    return null;
  }

  const rawBuf = Buffer.from(res.data, 'base64');
  if (rawBuf.length < 32) return null;

  // 🔴 2026-10-20 修复：kind 优先按落盘后的真实 MIME 判定（语音 mimetype 是 audio/ogg → 'audio'），
  //    不再只看 row.media_type（语音常被标成 'ptt'）。这样 audio 能正确走「原样存 + 转写」，不会再被当图压缩失败。
  const kind = kindFromMime(res.mimetype) || String(row.media_type || '').toLowerCase() || 'image';
  const isImage = kind === 'image' || kind === 'sticker';
  const stamp = Date.now();

  // 图片走压缩（老板要求小图），其他原样存
  if (isImage && shrink.available()) {
    const out = path.join(mediaDir, `${row.customer_code}_${stamp}.jpg`);
    const small = await shrink.shrinkToFile(rawBuf, out);
    if (small && small.path) {
      console.log(`[wa-web-media] 第 ${row.id} 条：原图 ${rawBuf.length} B → 压缩 ${small.bytes} B (${small.width}x${small.height})`);
      return { path: small.path, src: 'download', mimetype: small.mimetype, kind, bytes: small.bytes };
    }
  }

  // 没 sharp，或不是图片 → 原样存
  const ext = mimeToExt(res.mimetype);
  const out = path.join(mediaDir, `${row.customer_code}_${stamp}.${ext}`);
  fs.writeFileSync(out, rawBuf);
  return { path: out, src: 'download', mimetype: res.mimetype || ext, kind, bytes: rawBuf.length };
}

/* ================================================================
 * 三、调度器（内置 WA 专属，不碰 mediaFetch.js）
 * ================================================================ */

function listPending() {
  try {
    return db.listPendingWaWebMedia.all(MAX_TRIES, 30);
  } catch (e) {
    return [];
  }
}

function hasPending() {
  try {
    return db.listPendingWaWebMedia.all(MAX_TRIES, 1).length > 0;
  } catch (e) {
    return false;
  }
}

let timer = null;
let wake = null;

function schedule() {
  if (timer) return;
  const step = BACKOFF_SEC[0];
  timer = setTimeout(async () => {
    timer = null;
    try {
      await runOnce();
    } catch (e) {
      console.warn('[wa-web-media] 本轮出错：', (e && e.message) || e);
    }
    if (hasPending()) schedule();
  }, step * 1000);
  if (timer.unref) timer.unref();
}

async function runOnce() {
  const rows = listPending();
  let tried = 0;
  let got = 0;
  for (const row of rows) {
    if (inflight.has(row.id)) continue;
    if (Number(row.media_fetch_tries) >= MAX_TRIES) continue;
    if (row.media_path) continue; // 已经抓到了，别重复
    inflight.add(row.id);
    tried += 1;
    try {
      const saved = await fetchOne(row);
      if (saved && saved.skipped) {
        // webview 还没就绪（guest 没开/没登录）：这次不算失败，留 pending 不 burn 重试次数
        continue;
      }
      if (saved && saved.path) {
        db.setMediaFetched.run(saved.path, saved.src || 'download', saved.kind || '', row.id);
        const fresh = db.getMessage.get(row.id);
        console.log(`[wa-web-media] 第 ${row.id} 条取图成功：${saved.src} → ${path.basename(saved.path)}`);
        if (onFetchedCb) {
          try { onFetchedCb({ code: row.customer_code, row: fresh, saved }); } catch (e) { /* 回调出错不影响其他 */ }
        }
        got += 1;
      } else {
        db.bumpMediaFetchTry.run(MAX_TRIES, row.id);
      }
    } catch (e) {
      db.bumpMediaFetchTry.run(MAX_TRIES, row.id);
      console.warn(`[wa-web-media] 第 ${row.id} 条出错：`, (e && e.message) || e);
    } finally {
      inflight.delete(row.id);
    }
  }
  return { tried, got };
}

/**
 * 启动内置 WA webview 取图调度。
 * @param {Function} onFetched 抓到图之后的回调（main.js 传 onMediaFetched）
 * @param {object} [opts] { mediaDir }
 */
function start(onFetched, opts = {}) {
  stop();
  onFetchedCb = typeof onFetched === 'function' ? onFetched : null;
  mediaDir = (opts && opts.mediaDir) || paths.mediaDir();
  if (!onFetchedCb) {
    console.warn('[wa-web-media] 没给「抓到图之后」回调，取图不启动');
    return;
  }
  // 先把此前被错判成 fail 的媒体复活（webview 当时没就绪），给一次重抓机会
  try { resetFailed(); } catch (e) { /* 不影响后续 */ }
  if (hasPending()) {
    // 稍等一拍，别和登录/历史同步抢浏览器
    setTimeout(() => {
      runOnce()
        .then((r) => { if (r.tried) console.log(`[wa-web-media] 启动补抓：试 ${r.tried} 条，补到 ${r.got} 张`); })
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

/** 新消息进来时唤醒（main.js 在 handleWhatsappWebMessage 入库存盘后调一下） */
function notify() {
  if (hasPending()) schedule();
}

/** 把「之前试满 7 次被标成 fail、再也不抓」的内置 WA 媒体复活成 pending，给一次重抓机会
 *  （老板场景：刚启动 / webview 刚开那几拍还没就绪就被算失败，复活后 webview 好了就能抓到）。 */
function resetFailed() {
  try {
    const r = db.resetWaWebMediaFailed.run();
    if (r && r.changes) console.log(`[wa-web-media] 复活 ${r.changes} 条此前失败的媒体为 pending，重新尝试抓取`);
    return r ? r.changes : 0;
  } catch (e) {
    return 0;
  }
}

/** 测试/诊断用：直接跑一轮 */
async function tick() {
  return runOnce();
}

module.exports = { start, stop, notify, tick, fetchOne, resetFailed, PAGE_FETCH_SOURCE };
