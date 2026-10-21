/**
 * 媒体后台队列：客户发来的图片 / 语音 → AI 看完听完 → 用中文写一句说明
 *
 * 为什么单独一个模块：
 *   和翻译一个道理 —— 看图/听语音要几秒到十几秒，不能卡住消息上界面。
 *   消息一到就先显示（气泡里写「正在看图…」），AI 处理完再补上中文说明。
 *
 * 「看视频」还没接（接口留在 ai.TASK_CATALOG 的 video 里），这里先把口子留好。
 *
 * 硬边界：只读本地文件、只写数据库；没有任何发送能力。
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const lang = require('./lang');
const scanConfig = require('./scanConfig'); // v2.6.1171：扫描图片用哪家视觉模型（服务商 key）
const voiceConfig = require('./voiceConfig'); // v2.6.1188：语音识别用哪家模型（服务商 key）

/** 正在处理中的消息 id（内存态：重启后重跑一遍就是"还没看的那些"） */
const inflight = new Set();
/** 每个客户最近一次媒体处理报错，界面据此说明原因 */
const lastError = new Map();

/** 文件扩展名 → 媒体类型 */
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic'];
const AUDIO_EXT = ['ogg', 'opus', 'mp3', 'mpeg', 'wav', 'm4a', 'aac', 'amr', 'flac'];
const VIDEO_EXT = ['mp4', 'mov', '3gp', 'avi', 'mkv', 'webm'];

/** 这条消息带的媒体是什么类型（没有就返回 null） */
function kindOf(mediaPath) {
  if (!mediaPath) return null;
  const ext = String(mediaPath).toLowerCase().replace(/^.*\./, '');
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return 'file';
}

/** 这个类型 AI 能处理吗（video 还没接） */
function canProcess(kind) {
  return kind === 'image' || kind === 'audio';
}

function isProcessing(msgId) {
  return inflight.has(Number(msgId));
}

/**
 * 看图 / 听语音的自动重试上限（2026-09-30）
 * 图片走的是视觉模型，单价最贵。以前看图失败没有任何记账，每打开一次客户
 * 就把那几张看不出来的图重新看一遍 —— 现在次数写进 messages.media_tries，
 * 试满就彻底放手，只有用户手动点「重新看」才清零重来。
 */
const MAX_MEDIA_TRIES = 2;

function autoAllowed(msgId) {
  const row = db.getMessage.get(Number(msgId));
  if (!row) return true;
  return (Number(row.media_tries) || 0) < MAX_MEDIA_TRIES;
}

/** 用户手动点「重新看这张 / 重新听这段」：账本清零再给一次机会 */
function retryManual(msgId, code, mediaPath, onDone) {
  const id = Number(msgId);
  if (!id) return false;
  db.resetMediaTry.run(id);
  inflight.delete(id);
  return describeLater(id, code, mediaPath, onDone);
}

function errorOf(code) {
  return lastError.get(code) || null;
}

/**
 * 丢一条进后台：看图 / 听语音，处理完写库并回调
 *
 * @param {number} msgId
 * @param {string} code 客户编号
 * @param {string} mediaPath 本地文件路径
 * @param {Function} onDone 回调 {code, msgId, kind, mediaZh, error}
 * @returns {boolean} 是否真的排上了
 */
function describeLater(msgId, code, mediaPath, onDone) {
  const id = Number(msgId);
  const kind = kindOf(mediaPath);
  if (!id || !mediaPath || !canProcess(kind)) return false;
  if (inflight.has(id)) return false;
  if (kind === 'image' && !ai.isReady('vision')) return false;
  if (kind === 'audio' && !ai.isReady('asr')) return false;
  if (!fs.existsSync(mediaPath)) return false;
  if (!autoAllowed(id)) return false; // 试满次数还看不出来的，不再自动看（2026-09-30）

  inflight.add(id);
  lastError.delete(code);

  (async () => {
    let zh = '';
    let error = null;
    let provider = '';   // v2.6.1174：记日志用，标这次看图/听语音实际走的是哪家模型
    try {
      if (kind === 'image') {
        // v2.6.1171：优先用「扫描图片」下拉指定的视觉模型；那家没填 key 时，
        // resolveTaskWithProvider 会安静回退到 tasks.vision 默认那家（不会让看图整段失效）。
        const sel = scanConfig.getImageModel();
        const r = ai.resolveTaskWithProvider('vision', sel && sel !== 'vision' ? sel : null);
        const providerName = (r && r.providerName) || null;
        provider = providerName && providerName !== 'vision' ? providerName : '';
        zh = await ai.describeImage(mediaPath, '', providerName && providerName !== 'vision' ? providerName : null);
        if (!zh) error = ai.lastError('vision') || '看图没有返回内容';
      } else {
        // 语音：先转文字（客户说的原话），再翻成中文
        const voiceSel = voiceConfig.getVoiceModel();
        const raw = await ai.transcribe(mediaPath, voiceSel && voiceSel !== 'asr' ? voiceSel : null);
        if (!raw) {
          error = ai.lastError('asr') || '语音转写没有返回内容';
        } else if (ai.isReady('translate') && lang.needsTranslation(raw)) {
          const cn = await ai.translate(raw);
          zh = cn || `（没翻出来，原话：${raw}）`;
        } else {
          zh = raw; // 本来就是中文 / 没配翻译模型，就存原话
        }
      }
      if (zh) {
        db.setMediaZh.run(String(zh).trim(), id);
        db.resetMediaTry.run(id); // 看出来了就把旧账清零
      } else {
        db.bumpMediaTry.run(id);  // 记一笔：下次不再自动重试
      }
    } catch (e) {
      error = (e && e.message) || String(e);
      db.bumpMediaTry.run(id);
      console.warn(`[media] ${code} 第 ${id} 条失败：${error}`);
    } finally {
      inflight.delete(id);
    }
    // ---- 写扫描日志（v2.6.1174）：让老板在「全局设置 → 扫描日志」看得见
    //      "到底扫过什么图 / 听过的语音，以及 OCR 扫出来的文字内容"。
    //      成功写 ocr_text，失败写 error，绝不因记日志拖垮主流程。 ----
    try {
      const row = db.getMessage.get(id);
      db.addScanLog({
        ts: new Date().toISOString(),
        customer_code: code || '',
        msg_id: id,
        kind,
        direction: (row && row.direction) || '',
        provider,
        ok: !!zh,
        ocr_text: zh || '',
        error: error || '',
      });
    } catch (e) { /* 写日志失败绝不能影响主流程 */ }
    if (error) lastError.set(code, error);
    try {
      if (onDone) onDone({ code, msgId: id, kind, mediaZh: zh || '', error });
    } catch (e) {
      /* 回调出错不能影响别的消息 */
    }
  })();

  return true;
}

/** 一个客户还有几条图片/语音没出中文说明（打开客户时补看） */
function pendingCount(code) {
  const rows = db.listMessages.all(code);
  return rows.filter((m) => m.direction === 'in' && !m.media_zh && canProcess(kindOf(m.media_path))
    && !inflight.has(m.id) && autoAllowed(m.id)).length;
}

/**
 * 补看：把一个客户"还没出说明"的图片/语音排上队（最近的 max 条）
 * @returns {number} 排上队的条数
 */
function backfill(code, onDone, max = 6) {
  const rows = db.listMessages.all(code);
  const todo = rows
    .filter((m) => m.direction === 'in' && !m.media_zh && canProcess(kindOf(m.media_path))
      && !inflight.has(m.id) && autoAllowed(m.id))
    .slice(-max);
  let queued = 0;
  for (const m of todo) {
    if (describeLater(m.id, code, m.media_path, onDone)) queued++;
  }
  return queued;
}

module.exports = {
  kindOf,
  canProcess,
  isProcessing,
  errorOf,
  describeLater,
  retryManual,
  autoAllowed,
  MAX_MEDIA_TRIES,
  backfill,
  pendingCount,
};
