/**
 * 路B + 路C：从 WhatsApp Web 页面里把客户的图片真正挖出来（2026-10-08）
 *
 * ## 背景：为什么官方 downloadMedia 一张都没成功
 * 生产库实测：抓到 16 张图，`media_src` 全是 `base64`，`download` 路 **0 条**。
 * 而 16 张 base64 里有 12 张是 **70 字节的 1×1 像素空白 PNG**（占位图），
 * 4 张是 5KB 的 75×100缩略图 —— 都不是客户发的那张图。
 *
 * 根因链条：
 *   1) `Message.js:49` `this.hasMedia = Boolean(data.directPath)`
 *      —— 事件推来的对象里 directPath 常是空 → hasMedia=false
 *   2) `Message.js:514` `downloadMedia() { if (!this.hasMedia) return undefined }`
 *      —— 库自己第一行就把门关了
 *   → 我们永远只走base64 兜底，而 base64 里是占位图。
 *
 * ## 路B：拿 msgId 回页面重新取完整对象
 * 官方源码 `Message.js:518-525` 的做法就是**不信任事件对象**，
 * 而是回页面里按 id 重新捞：
 *   WAWebCollections.Msg.get(msgId) || (await Msg.getMessagesById([msgId])).messages[0]
 * 页面里的对象是**完整**的，directPath 齐全 → hasMedia 才是真的 true。
 *
 * ## 路C：主动踢库去解密media
 * 官方 `Message.js:535-541`：mediaStage 不是 RESOLVED 时，
 * 库自己会去 resolve；我们主动调`downloadMedia({downloadEvenIfExpensive:true})` 触发它。
 * `Message.js:544-548`：若stage 是 FETCHING/ERROR，官方直接放弃 —— 我们不能放弃，
 * 所以先强制 resolve 再拿。
 *
 * ## 🔴 关于压缩（老板明确要求）
 * C 路拿到的是**真原图**，动辄 1-3MB，直接进消息框会卡。
 * 老板原话（2026-10-08）："一定要把图片压缩成很小的图片，10k 大小左右"。
 * 且老板选择**只存小图，不要双份原图** → 落盘走 imageShrink。
 */

const path = require('path');
const fs = require('fs');
const shrink = require('./imageShrink');

/** 页面里执行时的超时（ms）。解密可能要好几秒，别把调用方挂死。 */
const EVAL_TIMEOUT = 30000;

/**
 * 在页面里跑一段脚本，返回可序列化结果。
 * 任何异常都吞成 null —— 这个模块的所有失败都不该炸掉采集主流程。
 */
async function safeEval(client, fn, ...args) {
  const page = client && client.pupPage;
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const r = await page.evaluate(fn, ...args);
    return r === undefined ? null : r;
  } catch (e) {
    console.warn('[media-raw]页面脚本出错：', (e && e.message) || e);
    return null;
  }
}

/**
 * 🔴 路B：拿 msgId 回页面重新取一个"完整"的消息对象（字段齐全）。
 *
 * 返回的是一个**在页面里组装好的普通对象**（含 directPath/mediaKey 等），
 * 不是 whatsapp-web.js 的 Message 实例 —— 因为我们要的就是它的原始字段。
 *
 * @param {object} client whatsapp-web.js client
 * @param {string} msgId  消息 id（形如 false_15551234567@c.us_ABC123）
 * @returns {Promise<object|null>}
 */
async function refetchFullMessage(client, msgId) {
  if (!client || !msgId) return null;
  return safeEval(client, async (id) => {
    const WWA = window.require('WAWebCollections');
    const msg = WWA.Msg.get(id)
      || (await WWA.Msg.getMessagesById([id]))?.messages?.[0];
    if (!msg) return null;
    // 只把我们要的字段带出来（页面对象带函数、带循环引用，不能整体序列化）
    return {
      id: msg.id,
      type: msg.type,
      // 🔴 directPath 是判定 hasMedia 的唯一依据，必须带出来
      directPath: msg.directPath || null,
      // 🔴 这五个字段是解密媒体必需的（Message.js:563-569）
      encFilehash: msg.encFilehash || null,
      filehash: msg.filehash || null,
      mediaKey: msg.mediaKey || null,
      mediaKeyTimestamp: msg.mediaKeyTimestamp || null,
      mimetype: msg.mimetype || null,
      filename: msg.filename || null,
      size: msg.size || null,
      // mediaStage 决定要不要走C 路强制解密
      mediaStage: msg.mediaData && msg.mediaData.mediaStage ? msg.mediaData.mediaStage : null,
      // 顺带把正文捞回来（万一 directPath 还没到，body 里可能已有 base64）
      body: msg.body || null,
    };
  }, msgId);
}

/**
 * 🔴 路C：主动触发库里解密媒体并取回base64。
 *
 * 对应官方 Message.js:535-571 的逻辑，但**不等它放弃**：
 *   1. mediaStage 不是 RESOLVED → 先强制 resolve（downloadEvenIfExpensive）
 *   2. resolve 之后再downloadAndMaybeDecrypt
 *   3. 返回 base64 + mimetype
 *
 * @param {object} client whatsapp-web.js client
 * @param {object} full   refetchFullMessage 的返回（必须含 directPath 等字段）
 * @returns {Promise<{base64:string, mimetype:string}|null>}
 */
async function forceResolveAndDownload(client, full) {
  if (!client || !full || !full.directPath) return null;

  return safeEval(client, async (m) => {
    const WWA = window.require('WAWebCollections');
    const msg = WWA.Msg.get(m.id)
      || (await WWA.Msg.getMessagesById([m.id]))?.messages?.[0];
    if (!msg) return null;

    // ---- ① 强制 resolve（官方 Message.js:535-541）----
    if (msg.mediaData && msg.mediaData.mediaStage !== 'RESOLVED') {
      try {
        await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      } catch (e) {
        // resolve 失败不直接放弃，下面download 还会再试一次
      }
    }

    // ---- ② 过期媒体（REUPLOADING）没法下，直接告诉调用方 ----
    if (msg.mediaData && msg.mediaData.mediaStage === 'REUPLOADING') {
      return { expired: true };
    }

    // ---- ③ 真正下载 + 解密（官方 Message.js:551-571）----
    const mockQpl = {
      addAnnotations: function () { return this; },
      addPoint: function () { return this; },
    };
    try {
      const decrypted = await window
        .require('WAWebDownloadManager')
        .downloadManager.downloadAndMaybeDecrypt({
          directPath: msg.directPath,
          encFilehash: msg.encFilehash,
          filehash: msg.filehash,
          mediaKey: msg.mediaKey,
          mediaKeyTimestamp: msg.mediaKeyTimestamp,
          type: msg.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        });
      if (!decrypted) return null;
      const data = await window.WWebJS.arrayBufferToBase64Async(decrypted);
      return {
        data,
        mimetype: msg.mimetype || 'image/jpeg',
        filename: msg.filename || null,
        size: msg.size || null,
      };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }, full);
}

/**
 * 🔴 B+C 组合入口：拿一张消息的**真原图**并压缩落盘。
 *
 * 流程：B(回页面取完整对象) → C(强制解密下载) → 压缩到约 10KB → 存盘
 *
 * ⚠️ 只有图片才压缩（老板说的"10k 才能显示在新消息框"是针对图片气泡）。
 *    视频/语音/文件原样存盘 —— 压了也没法在气泡里播。
 *
 * @param {object} client whatsapp-web.js client
 * @param {string} msgId消息 id
 * @param {string} customerCode 客户编号（用于文件名）
 * @param {string} mediaDir media 目录
 * @param {string} msgType 消息类型（image/sticker/video/...）
 * @returns {Promise<{path:string,src:string,mimetype:string,kind:string,bytes:number}|null>}
 */
async function fetchRawImage(client, msgId, customerCode, mediaDir, msgType) {
  const kind = String(msgType || 'image').toLowerCase();

  // ---- 路B：回页面拿完整对象 ----
  const full = await refetchFullMessage(client, msgId);
  if (!full || !full.directPath) {
    // B 也没拿到 directPath → 说明消息太老 / 已被清理，交给上层再试下一轮
    console.log(`[media-raw][诊断] 路B 未拿到 directPath | msgId=${msgId} | 原因=${full ? '对象有但directPath为空(可能消息太老/被清理)' : '页面Msg.get返回null(裸哈希id或页面已死)'}`);
    return null;
  }
  console.log(`[media-raw][诊断] 路B 成功 | directPath=${String(full.directPath).slice(0, 20)}… mediaStage=${full.mediaStage} type=${full.type}`);

  // ---- 路C：强制解密下载 ----
  const dl = await forceResolveAndDownload(client, full);
  if (!dl || !dl.data) {
    console.log(`[media-raw][诊断] 路C 未解出数据 | msgId=${msgId} | dl=${JSON.stringify(dl)}`);
    return null;
  }
  if (dl.expired) {
    console.log('[media-raw] 媒体已过期（REUPLOADING），拿不到了：', msgId);
    return null;
  }

  const rawBuf = Buffer.from(dl.data, 'base64');
  console.log(`[media-raw][诊断] 路C 解出字节数=${rawBuf.length} mimetype=${dl.mimetype} filename=${dl.filename || ''}`);
  if (rawBuf.length < 32) return null;

  // ---- 落盘：图片走压缩，其他原样存 ----
  const stamp = Date.now();
  const isImage = kind === 'image' || kind === 'sticker';
  if (isImage && shrink.available()) {
    const out = path.join(mediaDir, `${customerCode}_${stamp}.jpg`);
    const small = await shrink.shrinkToFile(rawBuf, out);
    if (small && small.path) {
      console.log(
        `[media-raw] 第${msgId} 条：原图 ${rawBuf.length} B → 压缩 ${small.bytes} B` +
        ` (q=${small.quality} ${small.width}x${small.height})`
      );
      return { path: small.path, src: 'download', mimetype: small.mimetype, kind, bytes: small.bytes };
    }
  }

  // 没 sharp，或不是图片 → 原样存（扩展名按 mimetype 猜）
  const ext = mimeToExt(dl.mimetype);
  const out = path.join(mediaDir, `${customerCode}_${stamp}.${ext}`);
  fs.writeFileSync(out, rawBuf);
  return { path: out, src: 'download', mimetype: dl.mimetype || ext, kind, bytes: rawBuf.length };
}

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

module.exports = {
  refetchFullMessage,
  forceResolveAndDownload,
  fetchRawImage,
  EVAL_TIMEOUT,
};
