/**
 * telegramMerge.js — 🔴【只服务 Telegram】键归一 + 重复档案合并 + 存量迁移
 * ============================================================================
 * 为什么单独开这个文件（老板铁律：不同功能各归各的文件与函数）：
 *   Telegram 的键有两个来源，天生会裂成两条客户记录 ——
 *     ① 网页抓取（src/telegramRead.js）：拿不到数字 peerId 时退回**显示名**
 *        → chatKey = "Eileen Lin"           → wa_jid = tg:Eileen Lin
 *     ② MTProto（src/telegramMtproto.js）：直接拿数字 peerId
 *        → chatKey = "7207229390"          → tg:7207229390
 *   同一个人因此出现两条记录、左栏出现两个同名提醒。
 *
 * 🔴 红线：本模块只处理 channel='telegram' 的记录。
 *    WhatsApp（一号~五号 / WA①~⑤）、Signal（S1~S3）一个字节都不碰；
 *    也不提供任何"公共抓取函数"给别的渠道复用 —— 每个渠道的抓取方式不同，
 *    合在一起就是事故。
 *
 * 本模块只做四件事，各自独立成函数：
 *   ① isSavedMessage()      —— Saved Messages（收藏夹）是系统消息：不提醒、不建档
 *   ② stripTrailingTime()   —— 把正文尾部被 DOM 吞进来的时间剥出来（气泡里不再带时间）
 *   ③ resolveIncoming()     —— 增量防裂：入库前把"名字键"归并到已存在的"数字键"
 *   ④ runMigration()        —— 存量迁移：库里已经裂开的两条合并（先备份 · 幂等 · 只限 tg · 逐条日志）
 *
 * 🔴 全程只读 Telegram 自己的记录，绝无自动发送，绝不弹 prompt。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ==========================================================================
 * 一、Saved Messages（收藏夹）识别
 * --------------------------------------------------------------------------
 * 实证（2026-10-16 老板出图）：对话编号是 `tg:Saved Messages`、名称 `Saved Messages`。
 * 全项目检索 "Saved Messages" 零命中 —— 目前完全没过滤，于是它既弹提醒又建了档。
 *
 * 判据必须**同时**覆盖两种键形态（老板指定）：
 *   · 键等于 Saved Messages（网页路径拿不到 peerId 时退回显示名）
 *   · 名称等于 Saved Messages（MTProto 路径键是数字、名字才是它）
 * 比较口径：去 `tg:` 前缀 → trim → 连续空白折一个 → 大小写不敏感。
 * ======================================================================== */

/** 归一化：trim + 连续空白折一个 + 转小写（中英文都不受影响） */
function normLabel(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 去掉 `tg:` 前缀（两种键形态都可能出现：tg:Saved Messages / Saved Messages） */
function stripTgPrefix(v) {
  return String(v == null ? '' : v).trim().replace(/^tg:/i, '').trim();
}

/** Telegram「收藏夹 / Saved Messages」的各种叫法（中英文 UI 都覆盖） */
const SAVED_LABELS = new Set([
  'saved messages', 'saved message',
  '收藏夹', '收藏的消息', '已保存的消息', '我的收藏',
]);

/**
 * 这条是不是 Telegram 的「Saved Messages（收藏夹）」—— 是系统消息，不该提醒也不该建档。
 * @param {string|number} [chatKey]  对话键（可能带 tg: 前缀，也可能是纯名字）
 * @param {string} [chatName]        对话显示名
 * @returns {boolean}
 */
function isSavedMessage(chatKey, chatName) {
  if (SAVED_LABELS.has(normLabel(stripTgPrefix(chatKey)))) return true;
  if (SAVED_LABELS.has(normLabel(chatName))) return true;
  return false;
}

/* ==========================================================================
 * 二、正文尾部时间剥离
 * --------------------------------------------------------------------------
 * 根因（实证 src/telegramRead.js:263）：抓取用 el.textContent 把**时间一起吞进正文**
 *   → body 变成 "Hello 14:03" → 界面再单独渲染一次时间 → 时间出现两次；
 *   翻译也把时间一起翻了（气泡显示「你好 14:03」）。
 *
 * 覆盖形态（老板点名）：14:03 / 9:05，可能带 上午|下午|凌晨|早上|中午|晚上 / AM|PM。
 * 剥完正文为空 → 说明这条**只剩时间**（状态行/空消息）→ 调用方丢弃，不建档。
 * ======================================================================== */

/**
 * 🔴 v2.6.1138：清掉正文里的**不可见字符**（老板截图里的「豆腐块」真身）。
 *
 * 实证（生产库assistant.db，2026-10-16）：Telegram 把我方(out)消息的时间用
 * **Unicode 私用区字符 U+E901** 包在正文尾部 —— body 实际是
 *   "hi" + U+E901 + " " + "18:32" + U+E901
 * 而 v2.6.1136 的 TRAILING_TIME_RE 要求时间「顶到字符串末尾」，`\s` **不匹配
 * 私用区字符**（实测 /\s/.test('\uE901') === false）→ 正则匹配失败 → 时间剥不掉，
 * 留在正文里显示成豆腐块；而 messages.msg_time 又存了一份 → **一条消息两个时间**。
 * 全库统计：U+E901 × 14、U+E9EF × 1、U+E918 × 1（后者在通话记录里）。
 *
 * 所以顺序必须是：**先洗不可见字符，再跑时间正则**。
 *
 * 洗哪些（都是纯控制/不可见，不可能是正文语义）：
 *   - C0/C1 控制字符（保留 \t \n \r）
 *   - 零宽与方向控制 U+200B–U+200F、U+202A–U+202E、U+2060–U+2064
 *   - BOM U+FEFF
 *   - 私用区 U+E000–U+F8FF（豆腐块本体）
 * ⚠️ 故意**不洗** U+FE00–U+FE0F（emoji 变体选择符），洗了 emoji 会掉变体变黑白。
 */
const INVISIBLE_RE = new RegExp(
  // 🔴 单个字符类：一个字符只要落在任一区间就被洗掉。
  // ⚠️ U+200D (ZWJ) 故意不列 —— 它是 emoji 组合序列的一部分（👨‍🎻 = U+1F468 U+200D U+1F3BB），
  //    洗掉会毁掉 emoji。U+FE00–U+FE0F 变体选择符同理故意不列。
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B\\u200C\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\uE000-\\uF8FF]',
  'gu',
);

/** 洗掉正文里的不可见字符（不改可见文字，不改大小写/标点）。 */
function stripInvisible(raw) {
  return String(raw == null ? '' : raw).replace(INVISIBLE_RE, '');
}

/** 尾部时间：可选中文时段词 + H:MM(:SS) + 可选 AM/PM，必须顶到字符串末尾 */
const TRAILING_TIME_RE =
  /(?:上午|下午|凌晨|早上|中午|晚上)?\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[AaPp][Mm])?\s*$/;

/**
 * 剥出正文尾部的时间。
 * 🔴 v2.6.1138：**先洗不可见字符再跑正则** —— Telegram 用私用区字符 U+E901 包住
 * 我方(out)消息的时间（"hi" + U+E901 + " 18:32" + U+E901），不洗的话正则匹配失败，
 * 时间留在正文里变豆腐块，且msg_time 又存一份 → 一条消息两个时间。
 * 洗完只剩时间（状态行/空消息）→ onlyTime=true，调用方应当丢弃。
 * @param {string} raw 原始正文
 * @returns {{body:string, msgTime:string, onlyTime:boolean}}
 *   body     剥掉时间 + 洗掉不可见字符后的正文（trim 过）
 *   msgTime  剥出来的时间原文（含 上午/下午 / AM/PM）；没剥到则 ''
 *   onlyTime 原文本来就只剩一个时间（剥完为空）—— 调用方应当丢弃
 */
function stripTrailingTime(raw) {
  const src = stripInvisible(raw);
  const m = src.match(TRAILING_TIME_RE);
  if (!m) return { body: src.trim(), msgTime: '', onlyTime: false };
  const body = src.slice(0, m.index).trim();
  const msgTime = String(m[0] || '').trim();
  return { body, msgTime, onlyTime: body === '' };
}

/* ==========================================================================
 * 三、键形态判定（名键 / 数字键）
 * ======================================================================== */

/**
 * 这个键是不是「数字 peerId」（允许负号：Telegram 群组/频道是 -100xxxxxxxxxx）。
 * @param {string} key 对话键（可带 tg: 前缀）
 * @returns {string} 是数字键则返回纯数字串（带负号），否则 ''
 */
function numericPeer(key) {
  const s = stripTgPrefix(key);
  return /^-?\d+$/.test(s) ? s : '';
}

/** Telegram 客户：wa_jid 固定 `tg:<key>` */
function displayJidOf(key) {
  return `tg:${stripTgPrefix(key)}`;
}

/* ==========================================================================
 * 三之二、身份判定（🔴 甲方案：合并只认「同一个数字身份」，名字相同一律不合并）
 * --------------------------------------------------------------------------
 * 事故实证（生产库 assistant.db，2026-10-16，老板实机反馈「名称相同竟然跟早期客户合并了」）：
 *   · 7A00004  wa_jid='tg:Xue'           name='Xue'      tg_username='wanfengzhiqiu'
 *   · 7A00005  wa_jid='tg:7664570369'    name='ganmeng'
 *   → 7A00004 被 mergePair 物理并进 7A00005，22 条消息（wa_msg_id 前缀 'Xue:'）被搬走。
 *   同类：7A00001(tg:wanyu lee) 并进 7A00002(tg:8696576132)。
 *
 * ⚠️ 为什么「显示名不同也能合」？—— 这是本次事故最反直觉的一点，必须写清楚：
 *   触发合并的是 resolveIncoming 的**数字键分支**，它比对的是
 *   **「本次进来的这条消息的名字」× 「名键那条记录里的名字」**，
 *   而**数字键那条记录自己叫什么名字（ganmeng）从头到尾没参与过判定**。
 *   那条消息的 customerKey 是数字 7664570369、名字却是 'Xue'
 *   （网页抓取路径 chatKey 取 URL 里的 peerId、chatName 取 DOM 标题，两者可以不同源，
 *    见 src/telegramRead.js 的 `chatKey: currentPeerId() || chatName`），
 *   于是 findTwin(name='Xue', 名键) 命中 7A00004 → mergePair 把它的消息全部搬走。
 *
 * 🔴 结论（写死在这里，新逻辑一律按它执行）：
 *   Telegram 里能证明「是同一个人」的只有两样 —— **数字 peerId** 与 **@tg_username**。
 *   **显示名不是身份**：Telegram 允许重名，两个不同的人可以显示成同一个名字。
 *   所以「名字相同」既不能用来归并、也不能用来把名键那条合并掉。
 *
 * ── 合并判定表（唯一权威口径，resolveIncoming / findDuplicatePairs / mergePair 共用）──
 *   | 本次 peerId | 本次 @username | 对方 peerId | 对方 @username | 判定 |
 *   |-------------|---------------|------------|--------------|------|
 *   |  7664570369 |  空            |  7664570369 |  空           | ✅ 合（peerId 相同）|
 *   |  空         |  emma         |  4000000004 |  emma         | ✅ 合（username 相同；一方无 peerId 不算冲突）|
 *   |  空         |  空            |  空         |  emma         | ❌ 不合（我方无任何身份）|
 *   |  7664570369 |  空            |  8696576132 |  空           | ❌ 不合（peerId 不同）|
 *   |  空         |  alice         |  空         |  bob          | ❌ 不合（username 不同）|
 *   |  空         |  空            |  8899       |  空           | ❌ 不合（对方无任何身份）|
 *   |  7664570369 |  alice         |  8696576132 |  alice        | ❌ 不合（peerId 冲突时以 peerId 为准）|
 *   |  空         |  空            |  空         |  空           | ❌ 不合（只有名字相同，绝不合并）|
 *   |  任意        |  任意          |  任意       |  任意         | ❌ 名字相同本身永远不作为依据 |
 *   优先级：**两边都有 peerId 时以 peerId 为准**（数字身份最硬，username 冲突也救不回来）；
 *   只有一边有 peerId 时**不算冲突**（网页抓取拿不到 peerId 是常态），继续看 @username；
 *   @username 全局唯一，两边都有值且相同即视为同一人；其余一律不合并。
 * ======================================================================== */

/** 归一化 @username：去 @ 前缀 + trim + 转小写。拿不到 → '' */
function normUsername(v) {
  return String(v == null ? '' : v).trim().replace(/^@/, '').trim().toLowerCase();
}

/**
 * 从一条 customers 行里抽出「可用于判同一人」的身份要素。
 * @param {object} row customers 行（也接受 { wa_jid, tg_username } 这种半截对象）
 * @returns {{peer:string, user:string}} peer=数字 peerId（无则 ''），user=@username（无则 ''）
 */
function rowIdentity(row) {
  const r = row || {};
  return {
    peer: numericPeer(r.wa_jid || r.chatKey || ''),
    user: normUsername(r.tg_username != null ? r.tg_username : r.username),
  };
}

/**
 * 判断「我方」与「库里那条」是不是同一个人 —— **只有能证明才返回 true**。
 *
 * 🔴 名字**不参与**判定（甲方案）。宁可漏合并，也绝不凭名字吞人。
 *
 * @param {{peer:string,user:string}} mine 我方身份（本次这条消息带来的）
 * @param {{peer:string,user:string}} other 对方身份（库里那条记录）
 * @returns {{same:boolean, reason:string}} reason 供日志说明用（中文，可直接打给老板看）
 */
function sameTelegramIdentity(mine, other) {
  const a = mine || {};
  const b = other || {};
  const myPeer = String(a.peer || '').trim();
  const myUser = normUsername(a.user);
  const otPeer = String(b.peer || '').trim();
  const otUser = normUsername(b.user);

  // ① 两边都拿得到数字 peerId → 数字身份最硬，只看它（peerId 冲突时 username 也救不回来）
  if (myPeer && otPeer) {
    if (myPeer === otPeer) return { same: true, reason: `peerId 相同（${myPeer}）` };
    return { same: false, reason: `peerId 不同（我方 ${myPeer} / 对方 ${otPeer}）` };
  }
  /* ② 只有一边拿得到 peerId —— 这不是「冲突」，只是**证据缺失**（网页抓取拿不到 peerId 是常态），
   *    所以继续往下看 @username。Telegram 的 @username 全局唯一且不重复，
   *    两边都有值且相同本身就是强证据，也正是「名键 → 数字键」该合并的正向通路。 */
  if (myUser && otUser) {
    if (myUser === otUser) {
      return {
        same: true,
        reason: `@username 相同（${myUser}）${myPeer && otPeer ? '' : '（一方无 peerId，以 username 为准）'}`,
      };
    }
    // 一方有 peerId、另一方 username 不同 → 判不是同一人
    return { same: false, reason: `@username 不同（我方 ${myUser || '无'} / 对方 ${otUser}）` };
  }
  // ③ 走到这里：peerId 至少缺一边，且 username 也凑不齐 → 拿不到任何身份证据
  return {
    same: false,
    reason: '只有显示名相同、拿不到 peerId 与 @username 任何一个身份证据 → 绝不合并',
  };
}

/* ==========================================================================
 * 四、列兜底（voided / void_note）：作废 = 打标记，绝不物理删除
 * --------------------------------------------------------------------------
 * 老板要求「不要物理删除，标为作废/停用更安全」，所以加两个只给 Telegram 用的列。
 * 用 db.ensureColumn 加（已存在就跳过），老库不用重建表。
 * ======================================================================== */

function ensureVoidColumns(dbx) {
  if (!dbx || typeof dbx.ensureColumn !== 'function') return false;
  try {
    dbx.ensureColumn('customers', 'voided', 'INTEGER DEFAULT 0');
    dbx.ensureColumn('customers', 'void_note', "TEXT DEFAULT ''");
    return true;
  } catch (e) {
    return false;
  }
}

/* ==========================================================================
 * 五、查孪生记录（同 Telegram 账号 + 同显示名）
 * ======================================================================== */

/** 拉某个 Telegram 账号下所有**未作废**的客户（只认 channel='telegram'） */
function listTelegramCustomers(dbx, accountId) {
  if (!dbx || !dbx.db) return [];
  try {
    return dbx.db
      .prepare(
        `SELECT * FROM customers
          WHERE IFNULL(channel, 'whatsapp') = 'telegram'
            AND account_id = ?
            AND COALESCE(voided, 0) = 0`,
      )
      .all(Number(accountId));
  } catch (e) {
    // voided 列还没建（老库且 ensureColumn 没跑成功）→ 退回不带该条件的查询
    try {
      return dbx.db
        .prepare(
          `SELECT * FROM customers
            WHERE IFNULL(channel, 'whatsapp') = 'telegram' AND account_id = ?`,
        )
        .all(Number(accountId));
    } catch (e2) {
      return [];
    }
  }
}

/** 孪生查询的短缓存：每条新消息都扫一遍该账号的全部 Telegram 客户太浪费，
 *  3 秒内的重复查询直接复用（合并发生时立刻清空，不会拿到过期的孪生）。 */
const TWIN_TTL_MS = 3000;
const twinCache = new Map();   // `accountId|normName|0/1` -> { at, row }

/**
 * 列「同账号 + 同显示名」的孪生记录（**全部**命中，不只第一条）。
 *
 * 🔴 v2.6.1141（甲方案）：本函数的语义已收窄 ——
 *   它现在只是**候选筛选器**（按名字把可能的记录捞出来，好少扫一点），
 *   **绝不代表「这些就是同一个人」**。真要合并，必须再过
 *   sameTelegramIdentity()：peerId 或 @username 能证明同一人才合并。
 *   历史上这里被当成「就是同一人」直接用，是本次误合事故的根因。
 *
 * @param {object} dbx      src/db.js 导出的对象
 * @param {number} accountId
 * @param {string} name     显示名（仅作候选筛选，不作身份依据）
 * @param {boolean} wantNumeric true=要数字键那条 / false=要名键那条
 * @returns {object[]} customers 行数组（可能为空）
 */
function listTwins(dbx, accountId, name, wantNumeric) {
  const want = normLabel(name);
  if (!want) return [];
  const ck = `${Number(accountId)}|${want}|${wantNumeric ? 1 : 0}`;
  const hit = twinCache.get(ck);
  if (hit && Date.now() - hit.at < TWIN_TTL_MS) return hit.rows;

  const found = [];
  for (const row of listTelegramCustomers(dbx, accountId)) {
    const rowName = normLabel(row.name || '');
    if (rowName !== want) continue;
    const isNum = !!numericPeer(row.wa_jid);
    if (isNum === !!wantNumeric) found.push(row);
  }
  twinCache.set(ck, { at: Date.now(), rows: found });
  return found;
}

/**
 * 找「同账号 + 同显示名」的孪生记录（第一条命中）。
 * @returns {object|null} customers 行
 */
function findTwin(dbx, accountId, name, wantNumeric) {
  const rows = listTwins(dbx, accountId, name, wantNumeric);
  return rows.length ? rows[0] : null;
}

/** 合并 / 迁移之后必须清掉孪生缓存（否则下一秒还会拿到已经作废的那条） */
function clearTwinCache() {
  twinCache.clear();
}

/* ==========================================================================
 * 六、增量防裂：入库前解析该用哪个键
 * --------------------------------------------------------------------------
 * 老板拍板规则（照做，不自创）：
 *   · 能拿到数字 peerId → 就用数字键；
 *   · 只有名字 → 先按「同 Telegram 账号 + 同显示名」找已存在的数字键记录，
 *     找到就归并到那条（不要新建）；
 *   · 反过来（这次来的是数字键、库里已有名键）也一并归并，两边都不留裂缝。
 * ======================================================================== */

/**
 * @param {object} dbx
 * @param {{accountId:number, chatKey:string, name?:string, username?:string}} o
 *   🔴 v2.6.1141：新增可选 `username`（本次这条消息带过来的 @username）。
 *      它是**唯一能在两边都拿不到 peerId 时**证明同一人身份的东西 ——
 *      没有它，「@username 相同 → 同一人」这条正向判定就永远走不到。
 *      调用方（src/main.js handleTelegramMessage）会从 m.username 传进来；
 *      老调用方不传也不报错，只是退回更严的判定（宁可不合并）。
 *
 * @returns {{customerKey:string, displayJid:string, numeric:boolean, mergeFromCode:string,
 *            ambiguous:string[], sameNameDiffIdentity:string[]}}
 *   mergeFromCode 非空 = 建/取完数字键那条之后，要把这条（名键）合并进去
 *                      🔴 但只在本条能证明身份时才会非空
 *   ambiguous            同名同类型的候选不止一条（只记日志，绝不自动归并）
 *   sameNameDiffIdentity 同名但身份对不上被拒的记录 code（只记日志）
 */
function resolveIncoming(dbx, o) {
  const opts = o || {};
  const accountId = Number(opts.accountId);
  const chatKey = String(opts.chatKey || '').trim();
  const name = String(opts.name || '').trim();
  const num = numericPeer(chatKey);
  // 🔴 本条消息自己的身份凭据（user 一律走 normUsername，避免 '@Alice' / 'alice' 判成两个人）
  const mine = { peer: num, user: normUsername(opts.username) };

  const out = {
    customerKey: chatKey,
    displayJid: displayJidOf(chatKey),
    numeric: !!num,
    mergeFromCode: '',
    // 同名歧义时非空：列出所有重名的数字键编号，供上层只记日志、不做自动合并
    ambiguous: [],
    // 🔴 v2.6.1141：同名但身份对不上、这次坚决不合并的记录（只记日志，人工再判）
    sameNameDiffIdentity: [],
  };
  if (!dbx || !dbx.db || !chatKey) return out;

  /** 记一行「同名但身份不同」的日志：沿用现有 `[telegram]` 前缀风格，绝不弹窗、绝不 prompt */
  function noteRefused(row, why) {
    const codeStr = row && row.code ? String(row.code) : '(未知)';
    out.sameNameDiffIdentity.push(codeStr);
    console.log(
      `[telegram] 同名但身份不同：账号 ${accountId} 下「${name}」的 ${codeStr}` +
      `(${row && row.wa_jid ? String(row.wa_jid) : '?'}) → **本次不合并**，${why}`,
    );
  }

  /**
   * 在候选里挑出**身份能证明是同一人**的那条。
   * 🔴 名字只用来缩小范围，能不能合并一律看 sameTelegramIdentity。
   * @returns {object|null}
   */
  function pickProven(rows) {
    let rejected = null;
    for (const row of rows) {
      const verdict = sameTelegramIdentity(mine, rowIdentity(row));
      if (verdict.same) return row;
      if (!rejected) rejected = { row, reason: verdict.reason };
    }
    // 全都被拒 → 记一行日志说明为什么不合（含重名多条的情况）
    if (rejected && rows.length === 1) noteRefused(rejected.row, rejected.reason);
    else if (rejected) {
      out.ambiguous = rows.map((r) => String(r.code));
      noteRefused(rejected.row, `同名候选有 ${rows.length} 条且都拿不到身份证据：${rejected.reason}`);
    }
    return null;
  }

  try {
    if (num) {
      // 这次拿到的是数字键：库里若已有「同名 + 名键」那条 → **身份能证明是同一人**才记下来合并
      const candidates = listTwins(dbx, accountId, name, false);
      const twin = pickProven(candidates);
      if (twin && twin.code) out.mergeFromCode = String(twin.code);
      return out;
    }
    // 这次只有名字：库里若已有「同名 + 数字键」那条 → **身份能证明是同一人**才归到它身上
    const candidates = listTwins(dbx, accountId, name || chatKey, true);
    const twin = pickProven(candidates);
    if (twin && twin.wa_jid) {
      out.customerKey = stripTgPrefix(twin.wa_jid);
      out.displayJid = String(twin.wa_jid);
      out.numeric = true;
    }
    return out;
  } catch (e) {
    return out;
  }
}

/* ==========================================================================
 * 七、合并一条（名键 → 数字键）
 * --------------------------------------------------------------------------
 * 老板拍板的合并规则（逐条照做）：
 *   姓名   两条一样 → 取之（两条都有就留数字键那条的名字）
 *   电话   一条空、另一条有数字 → **取有数字的那个，并在号码前补一个 +**
 *   编号   取数字那条（wa_jid = tg:7207229390）
 *   对话   名键那条抓的对话是正确的 → **它的消息归到合并后的记录上**
 *   名键那条 **不物理删除**，标 voided=1 作废/停用
 * ======================================================================== */

/**
 * 取 `wa_msg_id` 里的**消息号**（最后一个冒号后面的那段），只在它是纯数字时返回。
 * 用途：两条采集路径抓到同一条真实消息时，wa_msg_id 的前缀（chatKey）不同、
 * 但消息号一样 —— 靠它去重，避免合并后同一条出现两次。
 * @param {string} waMsgId 形如 `7207229390:555` / `Eileen Lin:555` / `list-2-Hello`
 * @returns {string} 数字消息号；不是数字则返回 ''
 */
function numericMsgIdOf(waMsgId) {
  const raw = String(waMsgId == null ? '' : waMsgId).trim();
  if (!raw) return '';
  const i = raw.lastIndexOf(':');
  const tail = (i >= 0 ? raw.slice(i + 1) : raw).trim();
  return /^\d+$/.test(tail) ? tail : '';
}

/** 两个号码里挑「有数字的那个」，并补 `+`；都没有 → '' */
function pickPhoneWithPlus(phoneA, phoneB) {
  const a = String(phoneA == null ? '' : phoneA);
  const b = String(phoneB == null ? '' : phoneB);
  const da = a.replace(/\D/g, '');
  const db = b.replace(/\D/g, '');
  if (da) return '+' + da;
  if (db) return '+' + db;
  return '';
}

/**
 * 合并两个 Telegram 客户档案：from（名键，作废）→ to（数字键，保留）。
 * 🔴 只处理 channel='telegram'；调用前请自行确认两条都是 Telegram。
 *
 * @param {object} dbx      src/db.js
 * @param {string} fromCode 要作废的那条（名键）
 * @param {string} toCode   要保留的那条（数字键）
 * @param {{log?:Function, reason?:string}} [opts]
 * @returns {{ok:boolean, movedMessages:number, phone:string, note:string}}
 */
function mergePair(dbx, fromCode, toCode, opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : function (s) { console.log(s); };
  const reason = String(o.reason || 'migration');
  const empty = { ok: false, movedMessages: 0, phone: '', note: '' };
  if (!dbx || !dbx.db || !fromCode || !toCode || fromCode === toCode) return empty;
  // 作废标记用的两列（老库没有）先补上，保证 mergePair 单独调也能跑
  ensureVoidColumns(dbx);

  const from = dbx.db.prepare(`SELECT * FROM customers WHERE code = ?`).get(fromCode);
  const to = dbx.db.prepare(`SELECT * FROM customers WHERE code = ?`).get(toCode);
  if (!from || !to) return Object.assign(empty, { note: '找不到这两条记录' });
  if (String(from.channel || 'whatsapp') !== 'telegram' || String(to.channel || 'whatsapp') !== 'telegram') {
    return Object.assign(empty, { note: '这两条不都是 telegram，拒绝合并' });
  }

  /* 🔴 v2.6.1141（甲方案）最后一道闸：合并前再验一次身份。
   * 上游（resolveIncoming / findDuplicatePairs）已经验过，这里再验一次是**兜底**——
   * 万一将来有人新写一处调用点直接调 mergePair，也不会凭名字吞人。
   * 想跳过这道闸（例如人工确认过后的修复动作）可传 { skipIdentityCheck:true }。 */
  if (!o.skipIdentityCheck) {
    const verdict = sameTelegramIdentity(rowIdentity(from), rowIdentity(to));
    if (!verdict.same) {
      log(
        `[telegram-merge] 🔴 拒绝合并 ${fromCode} → ${toCode}：` +
        `${from.wa_jid} 与 ${to.wa_jid} 拿不出同一人证据（${verdict.reason}）` +
        `（名字相同不算证据）`,
      );
      return Object.assign(empty, { note: '身份无法证明是同一人，拒绝合并：' + verdict.reason });
    }
  }

  log(
    `[telegram-merge] 开始合并（${reason}）：` +
    `${fromCode}(${from.wa_jid}${from.name ? ' / ' + from.name : ''}) → ` +
    `${toCode}(${to.wa_jid}${to.name ? ' / ' + to.name : ''})`,
  );

  // 档案动过了 → 清掉孪生缓存，免得下一条消息还按旧的配对去归并
  clearTwinCache();

  // ① 姓名（两条一样 → 取之；谁有值取谁，都有值时留数字键那条）
  const name = String(to.name || '').trim() || String(from.name || '').trim();

  // ② 电话：有数字的那条胜出，并补 `+`
  //    🔴 铁律：同号绝不落两档案 —— 写入前先过 db.phoneOwnerOf 查重
  const wanted = pickPhoneWithPlus(from.phone, to.phone);
  let phone = '';
  if (wanted) {
    const digits = wanted.replace(/\D/g, '');
    const owner = typeof dbx.phoneOwnerOf === 'function' ? dbx.phoneOwnerOf(digits, toCode) : '';
    /* 🔴 铁律「同号绝不落两档案」的例外判定：
     *   占用者如果是**正要作废的那条本身**（号码就挂在名键那条上），不算重复 ——
     *   合并完那条就停用了，号码归到保留的那条，全库仍然只有一份。 */
    const ownerIsFrom = !!owner && String(owner) === String(fromCode);
    if (owner && !ownerIsFrom) {
      log(`[telegram-merge] ${toCode} 号码 ${wanted} 已被客户 ${owner} 占用 → **未写入**号码（姓名/消息照常合并）`);
    } else {
      phone = wanted;
      log(`[telegram-merge] ${toCode} 电话 ← ${wanted}（取有数字的那条并补 +）`);
    }
  } else {
    log(`[telegram-merge] ${toCode} 两条都没有电话号码 → 电话留空`);
  }

  try {
    dbx.db
      .prepare(`UPDATE customers SET name = COALESCE(NULLIF(?, ''), name), phone = COALESCE(NULLIF(?, ''), phone) WHERE code = ?`)
      .run(name, phone, toCode);
  } catch (e) {
    return Object.assign(empty, { note: '更新保留档案失败：' + ((e && e.message) || e) });
  }

  // ③ 对话（消息记录）：名键那条抓的对话是正确的 → 以它为准，搬到数字键那条
  //    · wa_msg_id 完全相同 → 删掉数字键那条的同 id 行，留下「名键那条的正确版本」
  //    · 🔴 v2.6.1136（QA 实测）：两条路径抓同一条真实消息时 wa_msg_id **前缀不同**
  //      （名键侧 `Eileen Lin:555`、数字键侧 `7207229390:555`），比整串比不出重复 →
  //      合并后同一条会显示两次。所以再按**消息号**（冒号后那段数字）判一次重复，
  //      撞上就删掉数字键那份、仍以名键那条为准（绝不留下双份）。
  let moved = 0;
  let deduped = 0;
  try {
    const msgs = dbx.db
      .prepare(`SELECT id, wa_msg_id FROM messages WHERE customer_code = ? ORDER BY id ASC`)
      .all(fromCode);
    const delStmt = dbx.db.prepare(`DELETE FROM messages WHERE id = ?`);
    const moveStmt = dbx.db.prepare(`UPDATE messages SET customer_code = ? WHERE id = ?`);
    // 保留档案里已有的「消息号 → 行 id」（只收数字消息号，非数字的不参与去重）
    const existingByNumId = new Map();
    for (const r of dbx.db.prepare(`SELECT id, wa_msg_id FROM messages WHERE customer_code = ?`).all(toCode)) {
      const k = numericMsgIdOf(r.wa_msg_id);
      if (k && !existingByNumId.has(k)) existingByNumId.set(k, r.id);
    }
    for (const m of msgs) {
      let clashId = null;
      if (m.wa_msg_id) {
        const same = dbx.db
          .prepare(`SELECT id FROM messages WHERE customer_code = ? AND wa_msg_id = ? LIMIT 1`)
          .get(toCode, m.wa_msg_id);
        if (same) clashId = same.id;
        else {
          const k = numericMsgIdOf(m.wa_msg_id);
          if (k && existingByNumId.has(k)) { clashId = existingByNumId.get(k); deduped += 1; }
        }
      }
      if (clashId) delStmt.run(clashId);
      moveStmt.run(toCode, m.id);
      moved += 1;
    }
    // 建议记录一起搬（跟着消息走，别让 AI 建议留在作废档案上）
    try {
      dbx.db.prepare(`UPDATE suggestions SET customer_code = ? WHERE customer_code = ?`).run(toCode, fromCode);
    } catch (e) { /* 没有这张表 / 没这条记录就跳过 */ }
    log(
      `[telegram-merge] ${toCode} 对话 ← ${fromCode} 的 ${moved} 条消息（名键那条为准）` +
      (deduped ? `，其中 ${deduped} 条是两条路径重复抓的同一条（已按消息号去重，只留一份）` : ''),
    );
  } catch (e) {
    log(`[telegram-merge] 搬消息失败（不中断合并）：${(e && e.message) || e}`);
  }

  // ④ 名键那条作废（**不物理删除**），并清掉它的待处理/未读，左栏不再重复提醒
  try {
    dbx.db
      .prepare(
        `UPDATE customers
            SET voided = 1,
                void_note = ?,
                pending = 0,
                unread = 0
                ${phone ? ', phone = NULL' : ''}
          WHERE code = ?`,
      )
      .run(`已合并进 ${toCode}（${reason}）· ${new Date().toISOString()}`, fromCode);
    log(
      `[telegram-merge] ${fromCode} 已标记为作废/停用（未物理删除，可随时核对）` +
      (phone ? `，号码已移到 ${toCode}、本条清空（同号绝不落两档案）` : ''),
    );
  } catch (e) {
    log(`[telegram-merge] 标作废失败（不中断）：${(e && e.message) || e}`);
  }

  log(`[telegram-merge] 合并完成：${fromCode} → ${toCode}，姓名「${name}」，搬 ${moved} 条消息`);
  return { ok: true, movedMessages: moved, phone, note: '' };
}

/* ==========================================================================
 * 八、存量迁移：把库里已经裂开的两条合并掉
 * --------------------------------------------------------------------------
 * 三条硬要求（老板指定）：
 *   🔴 迁移前**先备份数据库文件**（带时间戳的 .bak）
 *   🔴 **幂等**（重复跑不重复合）—— 已作废的记录不再参与配对，第二次跑必然 0 条
 *   🔴 **只处理 channel='telegram'**，绝不波及 WhatsApp / Signal
 *   🔴 逐条 console.log 记录合并了什么，方便老板核对
 * ======================================================================== */

/**
 * 找库里所有「同账号 + 同名字，一条名键 + 一条数字键」的重复对。
 * @param {object} dbx
 * @param {Function} [log] 记录「因同名歧义而跳过」的说明（默认 console.log）
 * @returns {object[]}
 */
function findDuplicatePairs(dbx, log) {
  const L = typeof log === 'function' ? log : function (s) { console.log(s); };
  if (!dbx || !dbx.db) return [];
  ensureVoidColumns(dbx);
  let rows = [];
  /* 🔴 v2.6.1141：必须把 tg_username 一起查出来 —— 身份判定（甲方案）就靠它。
   * 老库可能还没有这一列，所以先试带列的查询，失败退回不带列的老查询（此时判定退回
   * 「只有 peerId 能证明」，比误合并安全得多）。 */
  const SQL_WITH_USER =
    `SELECT code, account_id, wa_jid, name, phone, tg_username
       FROM customers
      WHERE IFNULL(channel, 'whatsapp') = 'telegram'
        AND COALESCE(voided, 0) = 0`;
  const SQL_NO_USER =
    `SELECT code, account_id, wa_jid, name, phone
       FROM customers
      WHERE IFNULL(channel, 'whatsapp') = 'telegram'
        AND COALESCE(voided, 0) = 0`;
  try {
    rows = dbx.db.prepare(SQL_WITH_USER).all();
  } catch (e) {
    try {
      rows = dbx.db.prepare(SQL_NO_USER).all();
    } catch (e2) {
      return [];
    }
  }

  const groups = new Map(); // `${accountId}|${normName}` -> { numeric:[], named:[] }
  for (const r of rows) {
    // 名字列空着时，退回 wa_jid（名键那条的名字就藏在 tg: 后面）—— 否则会漏掉那一半
    const label = normLabel(r.name || stripTgPrefix(r.wa_jid));
    if (!label) continue; // 连键都没有 → 没法判"同一个人"，不动
    const key = `${Number(r.account_id)}|${label}`;
    if (!groups.has(key)) groups.set(key, { numeric: [], named: [] });
    const g = groups.get(key);
    if (numericPeer(r.wa_jid)) g.numeric.push(r);
    else g.named.push(r);
  }

  const pairs = [];
  for (const [gkey, g] of groups) {
    if (!g.numeric.length || !g.named.length) continue;
    /* 🔴 v2.6.1141（甲方案，老板拍板「合并只认同一个数字身份，名字相同一律不合并」）：
     * 这一段历史上是「同名即同一人」，把名键那条直接并进最早那条数字键 ——
     * 正是它 + resolveIncoming 一起造成了生产事故
     * （7A00004 'Xue' 的 22 条消息被搬进 7A00005 'ganmeng'）。
     * 现在改为：**逐对拿身份去证明，证明得了才合并**；
     * 证明不了的（多半是名键那条根本没有 peerId、只能靠名字）→ 一律不合，记录日志。 */
    for (const named of g.named) {
      let matched = null;
      let firstReject = '';
      for (const keep of g.numeric) {
        const verdict = sameTelegramIdentity(rowIdentity(named), rowIdentity(keep));
        if (verdict.same) { matched = keep; break; }
        if (!firstReject) firstReject = verdict.reason;
      }
      if (!matched) {
        L(
          `[telegram] 同名但身份不同：账号 ${Number(named.account_id)} 下「${named.name || ''}」` +
          `名键 ${named.code}(${named.wa_jid}) 与 ${g.numeric.length} 条数字键档案` +
          `均无法证明是同一人 → **不合并**，${firstReject}`,
        );
        continue;
      }
      pairs.push({
        accountId: Number(matched.account_id),
        name: matched.name || named.name || stripTgPrefix(named.wa_jid) || '',
        fromCode: String(named.code),   // 名键 → 作废
        toCode: String(matched.code),   // 数字键 → 保留
        fromJid: String(named.wa_jid),
        toJid: String(matched.wa_jid),
      });
    }
  }
  return pairs;
}

/**
 * 备份数据库文件（带时间戳）。
 * 优先用 SQLite 的 `VACUUM INTO`（拿一致快照，WAL 里没落盘的内容也在）；
 * 不支持时退回文件复制（.db + -wal + -shm）。
 *
 * @param {object} dbx   src/db.js
 * @param {string} dbPath 数据库文件绝对路径
 * @param {Function} [log]
 * @returns {{ok:boolean, backup:string, via:string}}
 */
function backupDatabase(dbx, dbPath, log) {
  const L = typeof log === 'function' ? log : function (s) { console.log(s); };
  const p = String(dbPath || '');
  if (!p || !fs.existsSync(p)) return { ok: false, backup: '', via: 'skip' };
  const stamp = timestamp();
  const dest = `${p}.bak-${stamp}`;
  try {
    if (dbx && dbx.db && typeof dbx.db.exec === 'function') {
      dbx.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      if (fs.existsSync(dest)) {
        L(`[telegram-merge] 数据库已备份：${dest}（VACUUM INTO 一致快照）`);
        return { ok: true, backup: dest, via: 'vacuum-into' };
      }
    }
  } catch (e) {
    /* 退回文件复制 */
  }
  try {
    fs.copyFileSync(p, dest);
    for (const s of ['-wal', '-shm']) {
      if (fs.existsSync(p + s)) fs.copyFileSync(p + s, `${dest}${s}`);
    }
    L(`[telegram-merge] 数据库已备份：${dest}（文件复制）`);
    return { ok: true, backup: dest, via: 'file-copy' };
  } catch (e) {
    L(`[telegram-merge] ⚠ 数据库备份失败：${(e && e.message) || e}（为安全起见**中止迁移**）`);
    return { ok: false, backup: '', via: 'failed' };
  }
}

/** 备份 / 日志用的时间戳：20261016-034512 */
function timestamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * 执行存量迁移（幂等）。
 * @param {object} dbx  src/db.js
 * @param {{dbPath?:string, log?:Function, backup?:boolean}} [opts]
 * @returns {{ok:boolean, backup:string, backupVia:string, pairs:number, merged:number, details:object[]}}
 */
function runMigration(dbx, opts) {
  const o = opts || {};
  const L = typeof o.log === 'function' ? o.log : function (s) { console.log(s); };
  const result = { ok: true, backup: '', backupVia: 'skip', pairs: 0, merged: 0, details: [] };
  if (!dbx || !dbx.db) return Object.assign(result, { ok: false });

  ensureVoidColumns(dbx);

  const dbPath = o.dbPath || defaultDbPath();
  const pairs = findDuplicatePairs(dbx, L);
  result.pairs = pairs.length;
  if (!pairs.length) {
    L('[telegram-merge] 存量迁移：没有发现「同名 + 名键/数字键」重复的 Telegram 记录（无需合并）');
    return result;
  }

  L(`[telegram-merge] 存量迁移：发现 ${pairs.length} 组重复的 Telegram 记录，准备合并（只限 channel='telegram'）`);

  // 🔴 先备份，再动数据
  if (o.backup !== false) {
    const b = backupDatabase(dbx, dbPath, L);
    result.backup = b.backup;
    result.backupVia = b.via;
    if (!b.ok) {
      L('[telegram-merge] 备份未成功 → **未做任何改动**，请检查磁盘权限后重跑');
      return Object.assign(result, { ok: false });
    }
  }

  for (const p of pairs) {
    const r = mergePair(dbx, p.fromCode, p.toCode, { log: L, reason: '存量迁移' });
    if (r.ok) result.merged += 1;
    result.details.push({
      fromCode: p.fromCode, toCode: p.toCode, name: p.name,
      fromJid: p.fromJid, toJid: p.toJid,
      movedMessages: r.movedMessages, phone: r.phone, ok: r.ok, note: r.note,
    });
  }

  L(`[telegram-merge] 存量迁移完成：合并 ${result.merged}/${result.pairs} 组（重复跑不会重复合，已作废记录不再参与配对）`);
  return result;
}

/** 数据库文件默认路径（和 src/db.js 的打开路径一致） */
function defaultDbPath() {
  try {
    const paths = require('./paths');
    return path.join(paths.DATA_ROOT, 'assistant.db');
  } catch (e) {
    return path.join(__dirname, '..', 'data', 'assistant.db');
  }
}

module.exports = {
  /* ① Saved Messages */
  isSavedMessage,
  normLabel,
  stripTgPrefix,
  /* ② 时间剥离 */
  stripTrailingTime,
  stripInvisible,
  /* ③ 键归一（增量防裂） */
  numericPeer,
  numericMsgIdOf,
  displayJidOf,
  /* ③之二 身份判定（甲方案：只认数字身份，名字相同一律不合并） */
  normUsername,
  rowIdentity,
  sameTelegramIdentity,
  listTwins,
  findTwin,
  clearTwinCache,
  resolveIncoming,
  /* ④ 合并 + 存量迁移 */
  ensureVoidColumns,
  pickPhoneWithPlus,
  mergePair,
  findDuplicatePairs,
  backupDatabase,
  runMigration,
  defaultDbPath,
};
