/*
 * Signal Desktop 消息采集（只读，2026-10-08 · v1.5.0）
 * =====================================================================
 * 干什么：每 3 秒读一次 Signal 的本地库，把**新消息**捞出来，
 *        交给 main.js 走和 WhatsApp 完全一样的写库 / 翻译 / 广播链路。
 *
 * 🔴 本模块**只读** Signal 的一切：不写它的库、不写它的目录、不发消息。
 *    只把内容抄进我们自己的 assistant.db。
 *
 * ---- 为什么必须这样（不是「读不到」，是「压根没读」）----
 *   上一版只做了状态灯（绿灯/红灯），那只是告诉界面"能不能用"，
 *   真正的采集模块从来没写。所以 Signal 收到新消息，左栏不会有任何反应。
 *
 * ---- 表结构（全部本机实测，没猜）----
 *   messages.conversationId → conversations.id
 *   conversations.serviceId  → 对方 ACI（**客户唯一标识**，比本地 id 稳）
 *   messages.type            → 'incoming'（客户发来）/ 'outgoing'（我发出）
 *                              还有 'story' / 'message-request-response-event' 等系统事件，要挡掉
 *   messages.id              → UUID，天然去重键，塞进我们的 wa_msg_id 列
 *   messages.sent_at         → 毫秒时间戳，做增量水位
 *   conversations.e164       → 电话。🔴 实测这家客户是 null（没存号码），
 *                              所以电话允许为空，不能因此跳过采集。
 *
 * ---- 官方 Signal 号必须排除 ----
 *   serviceId = 11111111-1111-4111-8111-111111111111（装完就有，一直在）
 *   它自己也会往 messages 里塞 5 条 type='story'。不过滤的话，
 *   界面上会凭空多出一个叫「Signal」的假客户。
 */

const path = require('path');
const fs = require('fs');
const signalStatus = require('./signalStatus');

/* 官方 Signal 号（实测值）。
   🔴 signalStatus.js 里那个常量写错了（11111111-2222-3333-…），
      那边靠 type!=='official' 兜住没出事，这里用实测的真值。 */
const OFFICIAL_SERVICE_ID = '11111111-1111-4111-8111-111111111111';

/** 我们自己的 Signal 账号占用的 account_id（1-5 是五个 WhatsApp 号） */
const SIGNAL_ACCOUNT_ID = 6;

/** 轮询间隔：3 秒。实测单次查询约 3ms，CPU 占用可忽略。 */
const POLL_MS = 3000;

/**
 * 只处理这两种 type，其余全是系统事件：
 *   story（官方号的朋友圈）/ message-request-response-event（系统回执）
 *   / reaction / call 等 —— 这些不该变成客户消息。
 */
const INCOMING = 'incoming';
const OUTGOING = 'outgoing';

/* =====================================================================
 * 纯函数：把一行 Signal 原始消息 + 它所属会话，转成统一结构
 * （抽成纯函数是为了能单测，不用真开库）
 * ===================================================================== */

/**
 * 客户唯一标识。
 * 🔴 为什么用 conversations.serviceId 而不是 conversations.id：
 *    `id` 是本地库的行 id，`storageID` 会随重装变化；只有 serviceId（ACI）
 *    在 Signal 侧是全球唯一且稳定的，跨重启、跨重装都不会变。
 */
function customerKey(conv) {
  if (!conv) return null;
  return String(conv.serviceId || conv.groupId || conv.id || '').trim() || null;
}

/**
 * 客户显示名。实测优先级：profileFullName > profileName > name（群组用 name）。
 * @returns {{name: string|null, e164: string|null, state: string}}
 */
function readIdentity(conv) {
  const e164 = conv && conv.e164 ? String(conv.e164).trim() : '';
  let name = '';
  if (conv) {
    name = String(conv.profileFullName || conv.profileName || conv.name || '').trim();
  }
  /*
   * 电话状态要能区分三种情况（界面上要如实告诉用户，别让人以为抓失败）：
   *   ok       有号码
   *   hidden   对方在 Signal 里开了隐私隐藏
   *   pending  还没抓到（可能是首次会话还没交换 profile）
   */
  const state = e164 ? 'ok' : (conv && conv.serviceId === OFFICIAL_SERVICE_ID ? 'hidden' : 'pending');
  return { name: name || null, e164: e164 || null, state };
}

/**
 * 这一行要不要收。
 * @returns {{ok: boolean, reason?: string}}
 */
function shouldAccept(row) {
  if (!row) return { ok: false, reason: '空行' };

  const type = String(row.type || '');
  if (type !== INCOMING && type !== OUTGOING) {
    return { ok: false, reason: `系统事件 type=${type}` };
  }

  /*
   * 🔴 官方 Signal 号一律不收（它自己会往 messages 里塞 type='story'，
   *    不过滤的话界面上会凭空多出一个叫「Signal」的假客户）。
   *
   * 判据读**三个来源**而不是只读 SQL 别名：
   *   conversation.serviceId（最权威，是 toMessage 真正的入参）
   *   → convServiceId（SQL 里的别名）
   *   → sourceServiceId（发件方自己）
   * 只读别名的话，一旦调用方构造的行没带这个字段，
   * 官方号就会混进来 —— 而这种漏进来的后果是"界面上多一个假客户"，很难一眼看出。
   */
  const conv = row.conversation || {};
  const sids = [conv.serviceId, row.convServiceId, row.sourceServiceId]
    .map((v) => String(v || ''))
    .filter(Boolean);
  if (sids.indexOf(OFFICIAL_SERVICE_ID) >= 0) {
    return { ok: false, reason: '官方 Signal 号' };
  }

  // 🔴 空消息不入库（和 WhatsApp 同一条铁律：记忆里明确写过）。
  //    对方撤回了一条消息 / 表情回应 / 通话记录 —— 这些不该凭空造出一个客户。
  //    没附件且正文为空 → 跳过。附件消息（body 为 null）留到后面单独处理。
  const body = row.body == null ? '' : String(row.body);
  const hasAttach = Number(row.hasAttachments || 0) > 0;
  if (!body.trim() && !hasAttach) return { ok: false, reason: '空消息' };

  if (!customerKey(row.conversation)) return { ok: false, reason: '拿不到客户标识' };

  return { ok: true };
}

/**
 * 转成和 WhatsApp 侧同构的一条消息。
 * @param {object} row 原始行（必须已 JOIN 出 convServiceId 与 conversation 对象）
 * @returns {null|{
 *   key: string, msgId: string, direction: 'in'|'out', body: string,
 *   hasAttachment: boolean, ts: string, customerKey: string,
 *   name: string|null, phone: string|null, phoneState: string,
 *   displayJid: string, mediaType: string, isGroup: boolean
 * }}
 */
function toMessage(row) {
  const acc = shouldAccept(row);
  if (!acc.ok) return null;

  const conv = row.conversation || {};
  const key = customerKey(conv);
  const ident = readIdentity(conv);
  const body = row.body == null ? '' : String(row.body);

  return {
    key,
    // 去重键：Signal 的消息 UUID。全局唯一，天然幂等 —— 重复采集也不会重复入库。
    msgId: String(row.id || ''),
    direction: row.type === OUTGOING ? 'out' : 'in',
    body,
    hasAttachment: Number(row.hasAttachments || 0) > 0,
    // sent_at 是毫秒；实测 1791433573904 → 与 WhatsApp 的 msgTs 同为 ISO 串
    ts: new Date(Number(row.sent_at || Date.now())).toISOString(),
    customerKey: key,
    name: ident.name,
    phone: ident.e164,
    phoneState: ident.state,
    /*
     * wa_jid 这一列在 Signal 里没有 JID 概念，但 NOT NULL 且被 findCustomer /
     * UNIQUE(account_id, wa_jid) 用着，所以给它一个 Signal 专属前缀值。
     * 用 `sig:` 而不是裸 UUID：一眼能看出这是哪个渠道来的，排查时不会和 WhatsApp 混淆。
     */
    displayJid: `sig:${key}`,
    mediaType: body.trim() ? '' : 'image',
    isGroup: String(conv.type || '') === 'group',
  };
}

/* =====================================================================
 * 增量读取
 * ===================================================================== */

/**
 * 一次查询语句。
 *
 * 🔴 水位选 sent_at 而不是 timestamp：实测两者在这批数据里相同，
 *    但 sent_at 是 Signal 服务端确认的发送时间，乱序到达时更可靠。
 * 🔴 同时用 id 去重（wa_msg_id UNIQUE），所以水位漏一条也不会重复入库 ——
 *    双保险：水位负责快，UNIQUE 负责准。
 *
 * @param {number} watermark 上一次的最大 sent_at
 * @param {number} limit 单次上限。Signal 单边刷屏时一次几百条，
 *   一次全捞会让主线程卡一下；宁可多轮。
 */
const SQL_POLL = `
  SELECT m.id, m.sent_at, m.timestamp, m.type, m.body, m.sourceServiceId,
         m.conversationId, m.hasAttachments,
         c.serviceId  AS convServiceId,
         c.type       AS convType,
         c.name       AS convName,
         c.profileName, c.profileFullName, c.e164, c.groupId
    FROM messages m
    JOIN conversations c ON c.id = m.conversationId
   WHERE m.sent_at > ?
   ORDER BY m.sent_at ASC
   LIMIT ?
`;

/**
 * 读一轮新消息。
 * @returns {{items: object[], watermark: number, ok: boolean, reason?: string}}
 */
/**
 * 读一轮新消息。
 * @param {number} watermark 上一次的最大 sent_at
 * @param {string|null} [dir] Signal 实例目录（Signal_1 … Signal_5）；省略=默认 %APPDATA%\Signal
 * @param {number} [limit] 单次上限
 */
function readNew(watermark, dir = null, limit = 200) {
  // 🔴 多实例支持：dir 指向某个 Signal_N 目录；省略则读默认 Signal。
  const p = signalStatus.pathsFor(dir);
  // 实例还没初始化（没登录 / 库还没生成）→ 软跳过，不计入连续失败，避免刷屏
  if (!fs.existsSync(p.DB_PATH)) {
    return { items: [], watermark: Number(watermark) || 0, ok: true, reason: 'no-db' };
  }
  let db;
  try {
    db = signalStatus.openDb(dir);
  } catch (e) {
    return { items: [], watermark, ok: false, reason: signalStatus.describeOpenError
      ? signalStatus.describeOpenError(e)
      : ('打不开 Signal 库：' + (e.message || e)) };
  }

  try {
    const rows = db.prepare(SQL_POLL).all(Number(watermark) || 0, Number(limit) || 200);
    const items = [];
    let max = Number(watermark) || 0;
    for (const r of rows) {
      const s = Number(r.sent_at) || 0;
      if (s > max) max = s;
      const conv = {
        id: r.conversationId,
        type: r.convType,
        name: r.convName,
        profileName: r.profileName,
        profileFullName: r.profileFullName,
        e164: r.e164,
        serviceId: r.convServiceId,
        groupId: r.groupId,
      };
      const m = toMessage(Object.assign({}, r, { conversation: conv }));
      if (m) items.push(m);
    }
    return { items, watermark: max || Number(watermark) || 0, ok: true };
  } catch (e) {
    return { items: [], watermark, ok: false, reason: '查询失败：' + (e.message || e) };
  } finally {
    try { db.close(); } catch (e) { /* 只读，关不掉也无所谓 */ }
  }
}

/* =====================================================================
 * 轮询器
 * ===================================================================== */

/**
 * 起轮询。
 * @param {object} o
 * @param {(batch: object[]) => void} o.onMessages 拿到新消息时回调（同步返回，不 await）
 * @param {(st: object) => void} [o.onState] 状态变化时回调
 * @param {number} [o.intervalMs]
 * @returns {{stop: Function, state: Function}}
 */
/**
 * 起轮询。
 * @param {object} o
 * @param {(batch: object[]) => void} o.onMessages 拿到新消息时回调（同步返回，不 await）
 * @param {(st: object) => void} [o.onState] 状态变化时回调
 * @param {number} [o.intervalMs]
 * @param {Array<string|null>} [o.dirs] 要轮询的 Signal 实例目录列表。
 *        省略或为空 → 只轮询默认 %APPDATA%\Signal（向后兼容单实例时代）。
 *        传入 [Signal_1 … Signal_5] → 逐个实例独立轮询，每个实例各自维护水位。
 * @param {() => boolean} [o.shouldRun] v2.5.1036：本轮要不要真的读库。
 *        返回 false → **跳过本轮**（水位不动，下轮照常用老水位接着读，不丢消息）。
 *        用来让路给进程扫描的静默窗口，以及守住"登录前不许动"。
 * @returns {{stop: Function, state: Function}}
 */
function startPolling({ onMessages, onState, intervalMs = POLL_MS, dirs = null, shouldRun = null }) {
  /*
   * 水位**只存在内存里**是刻意的（见下方单实例说明）。
   * 多实例：每个 dir 一个独立水位 + 独立连续失败计数，互不干扰——
   * 某个实例没开 / 解密失败，不会把别的实例的采集拖停。
   */
  const targets = (dirs && dirs.length) ? dirs.slice() : [null];
  const states = targets.map(() => ({ watermark: 0, consecutiveErrors: 0 }));
  let stopped = false;
  let timer = null;

  function tick() {
    if (stopped) return;
    /*
     * 🔴 v2.5.1036：动手前先问一句闸门。
     *    让路期间【不读库】——水位留在原地不动，等闸开了下一轮从老水位继续读，
     *    所以只是晚几秒收到，绝不会漏消息（水位是"已读到哪"的游标，不是"最近 N 秒"）。
     */
    if (typeof shouldRun === 'function') {
      let go = true;
      try { go = !!shouldRun(); } catch (e) { go = true; }
      if (!go) {
        timer = setTimeout(tick, 1000);
        if (timer.unref) timer.unref();
        return;
      }
    }
    let anyError = false;
    for (let i = 0; i < targets.length; i++) {
      const dir = targets[i];
      const st = states[i];
      let r;
      try {
        r = readNew(st.watermark, dir);
      } catch (e) {
        r = { items: [], watermark: st.watermark, ok: false, reason: String(e.message || e) };
      }

      if (!r.ok) {
        st.consecutiveErrors += 1;
        // 连续失败 3 次才记一笔，避免 Signal 刚启动那几秒疯狂报错刷屏
        if (st.consecutiveErrors >= 3) anyError = true;
      } else {
        st.consecutiveErrors = 0;
        if (r.items.length && typeof onMessages === 'function') {
          try {
            onMessages(r.items);
          } catch (e) {
            // 🔴 回调抛错绝不能停掉轮询 —— 停了就等于采集彻底死了，而且没人知道
            console.warn('[signalRead] onMessages 抛错：', e && e.message);
          }
        }
        st.watermark = r.watermark;
      }
    }
    if (anyError && onState) onState({ ok: false, reason: '部分 Signal 实例读不到', consecutiveErrors: -1 });
    timer = setTimeout(tick, intervalMs);
    if (timer.unref) timer.unref();
  }

  // 首轮延后一点：别跟 Electron 启动抢主线程
  timer = setTimeout(tick, 4000);
  if (timer.unref) timer.unref();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    state() {
      return { targets: targets.length, states, stopped };
    },
  };
}

module.exports = {
  OFFICIAL_SERVICE_ID,
  SIGNAL_ACCOUNT_ID,
  POLL_MS,
  INCOMING,
  OUTGOING,
  SQL_POLL,
  customerKey,
  readIdentity,
  shouldAccept,
  toMessage,
  readNew,
  startPolling,
};