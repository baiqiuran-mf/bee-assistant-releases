/**
 * 本地数据库层（SQLite）
 *
 * 设计要点：
 *   - customers.code 是业务主键（1A00001），一经分配永不回收
 *   - 唯一性按 (account_id, wa_jid)，同一个人加你多个号 => 多个编号，可关联查重
 *   - pending=1 表示有待处理消息，界面红点；发出消息或点"已回复"后自动归零
 *   - unread  是新消息计数器：客户每发一条就 +1，你在界面上点开这个客户才清零。
 *     它和 pending 是两件事——pending 管"我还没回复"，unread 管"我还没看"。
 */

const path = require('path');
const fs = require('fs');
const ids = require('./ids');
const paths = require('./paths');
const numberLibrary = require('./numberLibrary');
const identity = require('./identity'); // 只用它那个「JID → 电话」的纯函数

// 数据目录：默认 <项目>/data，可用环境变量 BEE_DATA_DIR 或 config.yaml 的 app.dataDir 改。
// 自动化测试会把它指到临时目录，所以测试不会碰到你的真实客户数据。
const DATA_DIR = paths.DATA_ROOT;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * 驱动适配：优先 better-sqlite3（Windows / macOS 有预编译包，npm 直接装得上）；
 * 装不上时回退 Node 内置的 node:sqlite（Node 22.5+，需 --experimental-sqlite 启动）
 */
function openDatabase(file) {
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const d = new BetterSqlite3(file);
    return { raw: d, pragma: (s) => d.pragma(s), driver: 'better-sqlite3' };
  } catch (err) {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(file);
    return { raw: d, pragma: (s) => d.exec(`PRAGMA ${s}`), driver: 'node:sqlite' };
  }
}

const handle = openDatabase(path.join(DATA_DIR, 'assistant.db'));
const db = handle.raw;
handle.pragma('journal_mode = WAL');
handle.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY,
  label         TEXT,
  phone         TEXT,
  proxy         TEXT,
  status        TEXT DEFAULT 'offline',
  last_seen     TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  account_id    INTEGER NOT NULL,
  wa_jid        TEXT    NOT NULL,
  phone         TEXT,
  name          TEXT,
  region        TEXT,
  timezone      TEXT,
  stage_day     INTEGER DEFAULT 1,
  mood          TEXT,
  pending       INTEGER DEFAULT 0,
  summary       TEXT,
  profile_json  TEXT,
  created_at    TEXT,
  last_msg_at   TEXT,
  UNIQUE(account_id, wa_jid)
);
CREATE INDEX IF NOT EXISTS idx_customers_account ON customers(account_id);
CREATE INDEX IF NOT EXISTS idx_customers_pending ON customers(pending);
CREATE INDEX IF NOT EXISTS idx_customers_phone   ON customers(phone);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_code TEXT NOT NULL,
  account_id    INTEGER NOT NULL,
  direction     TEXT NOT NULL,          -- in / out
  body          TEXT,
  body_zh       TEXT,                   -- 中文翻译
  translate_state TEXT,                 -- NULL=还没排/排队中 / done=已翻好 / failed=翻失败（可重开客户重试）
  media_zh      TEXT,                   -- 客户发来的图片/语音：AI 用中文说清"这是什么"
  media_path    TEXT,
  wa_msg_id     TEXT UNIQUE,
  msg_ts        TEXT,
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_code);
CREATE INDEX IF NOT EXISTS idx_messages_ts       ON messages(msg_ts);
-- 2026-10-15 v2.6.1121：WA① 中文气泡的「翻译记忆」要按账号倒序捞最近翻好的译文，
-- 这个复合索引让那句 ORDER BY id DESC 走索引、不做全表扫。
CREATE INDEX IF NOT EXISTS idx_messages_account_id ON messages(account_id, id);

CREATE TABLE IF NOT EXISTS suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_code TEXT NOT NULL,
  message_id    INTEGER,
  model         TEXT,
  options_json  TEXT,
  rationale     TEXT,
  risk_flags    TEXT,
  adopted_index INTEGER,
  edited_text   TEXT,
  created_at    TEXT
);

/*
 * 版本历史（2026-10-07 v1.2.0 · 自动更新）
 *
 * 为什么需要这张表：
 *   「设置 → 软件更新」那个页签要能回答三个问题——
 *     ① 我现在跑的是哪个版本？（当前版本记一条）
 *     ② 什么时候升过级、从哪个版本升的？
 *     ③ 上次更新成功没有？（失败的也记，不然看不出反复失败）
 *
 * 只记 app 版本，不记消息、客户的任何东西。
 * 🔴 这一张表和 updateLog() 的字段都是「只记事实」：
 *   失败的更新也必须写进去。只记成功的话，界面上会显示
 *   「上次更新于三个月��」，其实那次是失败��——比不显示更误导。
 */
CREATE TABLE IF NOT EXISTS app_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version      TEXT NOT NULL,
  channel      TEXT DEFAULT 'latest',
  result       TEXT DEFAULT '',          -- ok / fail / cancelled
  from_version TEXT DEFAULT '',          -- 从哪个版本升上来的
  note         TEXT DEFAULT '',          -- 出错时的原文（给排障用）
  created_at   TEXT
);

  -- v2.5.1028：Tele 译文缓存表已随中栏 Tele 标签与自动翻译取消而移除

/*
 * 跨消息的翻译记忆（2026-10-15 v2.6.1122 · 老板拍板方案 A）
 *
 * 为什么单独一张表：
 *   messages.body_zh 是「按消息」记的 —— 同一句原文出现在两条不同消息里，
 *   就是两行、两次 AI 调用。客户反复发 How much? / Ok / Thanks 这类短句时，
 *   每出现一次都要再烧一次 token。
 *   这张表改成「按原文文本」记：原文 → 译文，不看它是哪条消息，
 *   也不分 WhatsApp / Signal / Telegram —— 三个渠道共用一本字典。
 *
 * src_norm 是唯一键（归一化后的原文：去首尾空格、连续空白折一个）。
 * 只有完全一致才复用，避免把不同语境的同一句话翻串。
 */
CREATE TABLE IF NOT EXISTS translation_memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  src_norm   TEXT NOT NULL UNIQUE,   -- 归一化后的原文（唯一键）
  src_text   TEXT NOT NULL,          -- 第一次见到时的原文原样（给人看）
  body_zh    TEXT NOT NULL,          -- 译文
  provider   TEXT DEFAULT '',        -- 哪家 AI 翻的（空 = 跟随全局）
  hits       INTEGER NOT NULL DEFAULT 0,  -- 被复用过多少次（省下的 AI 调用数）
  src_len    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

-- v2.6.1148：被判定「不值得进词典」的原文，记在这里，避免同一句反复问 AI
CREATE TABLE IF NOT EXISTS translation_reject (
  src_norm TEXT PRIMARY KEY,   -- 归一化后的原文
  reason   TEXT,               -- rule / ai
  at       TEXT
);

/* 扫描日志（2026-10-20 v2.6.1174 · 老板要的"看得懂的扫描记录"）
 * 每次软件用 AI 看客户发来的图 / 听客户发来的语音，都写一条：
 *   · ts            什么时候扫的
 *   · customer_code 哪个客户编号（如 1A00013；没编号时留空）
 *   · msg_id        消息 id
 *   · kind          扫的是 image（图）还是 audio（语音）
 *   · direction     这条消息是 in（客户发来）还是 out（自己发的）
 *   · provider      用的哪家视觉/ASR 模型（服务商 key）
 *   · ok            1=成功扫出文字 / 0=失败
 *   · ocr_text      扫出来的文字（成功时）
 *   · error         失败原因（失败时）
 * 界面（全局设置 → 扫描日志）把每条拼成一句人话给老板看（含 OCR 扫出的文字）。 */
CREATE TABLE IF NOT EXISTS scan_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  customer_code TEXT DEFAULT '',
  msg_id        INTEGER DEFAULT 0,
  kind          TEXT DEFAULT '',
  direction     TEXT DEFAULT '',
  provider      TEXT DEFAULT '',
  ok            INTEGER DEFAULT 1,
  ocr_text      TEXT DEFAULT '',
  error         TEXT DEFAULT ''
);

`);

/* 版本号不能重复记账：同一个版本重复记录就取最早那条 */
const insVersion = db.prepare(`
  INSERT INTO app_versions (version, channel, result, from_version, note, created_at)
  VALUES (@version, @channel, @result, @from_version, @note, @created_at)
`);
const lastVersion = db.prepare(`
  SELECT * FROM app_versions WHERE channel=@channel ORDER BY id DESC LIMIT 1
`);
const listVersions = db.prepare(`
  SELECT * FROM app_versions ORDER BY id DESC LIMIT @limit
`);

/* 扫描日志（v2.6.1174）：写一条 + 倒序读最近 N 条。
 * 写失败绝不抛错（不能因为记日志把看图主流程拖垮）。 */
const insScanLog = db.prepare(`
  INSERT INTO scan_log (ts, customer_code, msg_id, kind, direction, provider, ok, ocr_text, error)
  VALUES (@ts, @customer_code, @msg_id, @kind, @direction, @provider, @ok, @ocr_text, @error)
`);
const listScanLog = db.prepare(`
  SELECT * FROM scan_log ORDER BY id DESC LIMIT @limit
`);
const countScanLog = db.prepare(`SELECT COUNT(*) AS n FROM scan_log`);

function addScanLog(e) {
  try {
    insScanLog.run({
      ts: e.ts || new Date().toISOString(),
      customer_code: e.customer_code || '',
      msg_id: Number(e.msg_id) || 0,
      kind: e.kind || '',
      direction: e.direction || '',
      provider: e.provider || '',
      ok: e.ok ? 1 : 0,
      ocr_text: String(e.ocr_text || ''),
      error: String(e.error || ''),
    });
  } catch (err) {
    console.warn('[scan_log] 写日志失败：', err && err.message);
  }
}
function listScanLogs(limit = 200) {
  try {
    return listScanLog.all({ limit: Math.max(1, Math.min(1000, limit | 0)) });
  } catch (e) { return []; }
}
function countScanLogs() {
  try { return (countScanLog.get() || { n: 0 }).n; } catch (e) { return 0; }
}

/*
 * 渠道预留（2026-09-23）
 *
 * 第一版只跑 WhatsApp，但表结构先把 channel 留出来。后期接 Telegram / Instagram /
 * LinkedIn / Facebook 时，不用重建表、不用改编号规则。
 *
 * 唯一键仍是 (account_id, wa_jid)，所以跨渠道的标识必须带前缀区分：
 *   whatsapp → 14155552671@c.us      telegram → tg:14155552671
 *   instagram → ig:some_user         linkedin → li:some-user
 * 同一个人在两个渠道 = 两个编号，靠 phone / 姓名做疑似重复提示。
 */
function ensureColumn(table, column, def) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

ensureColumn('accounts', 'channel', "TEXT DEFAULT 'whatsapp'");
ensureColumn('customers', 'channel', "TEXT DEFAULT 'whatsapp'");
// 未读新消息计数：同一个人连发 5 条 → 该客户这一格显示 5，点开清零（不会变成 5 个格子）
ensureColumn('customers', 'unread', 'INTEGER DEFAULT 0');
// 翻译结果状态：区分"还没翻 / 翻好 / 翻失败"，避免失败后界面还一直挂"等待翻译中"
ensureColumn('messages', 'translate_state', 'TEXT DEFAULT NULL');
/* v2.6.1136：Telegram 正文尾部剥出来的「显示时间」（14:03 / 下午 2:03）。
   为什么单独一列：网页版抓取用 textContent 会把时间一起吞进正文（"Hello 14:03"），
   时间必须在采集侧剥出来、单独存，界面才不会渲染两次、翻译也不会把时间一起翻了。
   🔴 只有 Telegram 写入这一列；其它渠道留空，行为与之前一字不差。 */
ensureColumn('messages', 'msg_time', "TEXT DEFAULT ''");
// 加入时间：created_at 由系统自动记，但客户可能是很久以前就加了的，
// 这种要能手动填。source 用来区分是哪个来的，免得手动填的被自动值覆盖回去。
ensureColumn('customers', 'created_at_source', "TEXT DEFAULT 'auto'");
/*
 * Telegram 客户的 @username（v2.5.1032）：
 *   跳转时走官方深链 web.telegram.org/k/#@username —— 比按显示名搜索精准得多
 *   （用户名唯一，不会重名点错；SPA 内改 hash 即可，不会整页刷新丢登录态）。
 *   🔴 只有对方设了用户名才有值；没设的留空，跳转时退回搜索框兜底。
 */
ensureColumn('customers', 'tg_username', 'TEXT');
// 客户发来的图片 / 语音 / 视频：AI 看完听完后用中文写的说明（原图不动，只存这段字）
ensureColumn('messages', 'media_zh', 'TEXT');
/*
 * 模拟客户标记（2026-09-25）：
 * 「模拟新消息」功能造出来的测试客户标 1，方便一键清空时只删这些，
 * 绝不误删真实客户。
 */
ensureColumn('customers', 'is_sim', 'INTEGER DEFAULT 0');
/*
 * 「这行是我自己」标记（2026-10-17）：
 *   Telegram 账号本人的号（tg:Xue / tg_username=wanfengzhiqiu）曾被误当成客户建了档，
 *   还顺着这条档案抓了 22 条**自己发出去**的消息，被误报成"新客户来消息"。
 *   is_self=1 就是给这种行打的标记：它不是客户，是账号主人本人。
 *
 * 🔴 这一列只用来做「客户列表不显示」，**别的什么都不改**：
 *   - getCustomer(code) 照样能取到这条行 → 档案页还能打开自己那条（出问题要查/要删）
 *   - writeCustomerDoc / 档案导出不改
 *   - Telegram / WhatsApp 采集写入路径一行都不动
 *   老库没有这一列时由下面 prepareCustomerListStmt() 自动退回不过滤的版本（见下）。
 */
ensureColumn('customers', 'is_self', 'INTEGER DEFAULT 0');
/*
 * 翻译 / 看图的「重试账本」（2026-09-30 加，解决反复烧 token）：
 * 以前重试次数记在内存里，进程一重启、或每次重新打开客户就归零，
 * 于是「永远翻不出来」的那批消息被无限重试 —— 每打开一次客户白烧一轮 AI。
 * 现在次数写进数据库，跨进程跨重启都记得：试满 MAX_AUTO_TRIES 次就彻底放手，
 * 只有用户手动点「重翻这条」才会清零重来。
 */
ensureColumn('messages', 'translate_tries', 'INTEGER DEFAULT 0');
ensureColumn('messages', 'media_tries', 'INTEGER DEFAULT 0');
/*
 * 2026-10-07 v1.1.0：图片「延时重抓」的账本
 *
 * whatsapp-web.js 的 `Message.js:49`：`this.hasMedia = Boolean(data.directPath)`。
 * 客户刚发来图片时 directPath常常**还没到**（媒体还在 WhatsApp 服务器上排队），
 * 于是 saveMedia() 两条路都拿不到 → media_src='none' → 界面只剩一个占位符。
 * 老板要求："检测到图片就开始获取，暂时获取不到可以延迟几秒重新再抓取"。
 *
 *   media_fetch_state —— 'pending' 还在等 directPath / 'done' 抓到了 / 'fail' 试满放弃
 *   media_fetch_tries —— 已经重抓过几次
 *
 * 🔴 必须在这里加（不能放到文件后面的 prepare 区）：下面 insertMessage 的 SQL
 *   已经用到这两列，ensureColumn 必须排在所有 db.prepare 之前，
 *   否则 require db.js 的瞬间就报 "table messages has no column named media_fetch_state"。
 * 🔴 写库而不放内存：放内存进程一重启就归零 → 那批图重启后被无限重抓。
 */
ensureColumn('messages', 'media_fetch_state', "TEXT DEFAULT ''");
ensureColumn('messages', 'media_fetch_tries', 'INTEGER DEFAULT 0');

/*
 * 左栏「新消息提醒」的排队时间（2026-09-26 按用户要求新增）：
 *   客户第一次进入"待处理"状态时记下此刻；之后同一客户再发消息【不更新】它。
 *   左栏就按它升序排 —— 先到的一条在最上、后到的往下排（越新的越往下）；
 *   同一客户连发多条时，行位置保持不动（钉在第一次那条的位置）。
 *   处理完（标记已回复 / 我发出回复）清空，下次再来消息重新排队。
 */
ensureColumn('customers', 'queue_since', 'TEXT');

/*
 * phone_src —— 电话号码的「可信度标记」（2026-10-07 用户点名要加）
 *
 * 为什么需要：以前判断号码靠"有没有 + 号"，但取号三条路径
 * （parseIntlPhone / phoneFromJid / plausiblePhone）都走 digitsOnly()，
 * **加号在建库前就被剥掉了** —— 实测库里 21 条有号码的客户只有 2 条带 +，
 * 而那 2 条还是人工在档案弹窗填的。也就是说"有没有 +"这个判据恒为假，
 * 自动抓取那条链路基本没在跑（data 里 0 张图 / media_path 全空是同一个问题的另一面）。
 *
 * 改成记「号码从哪来」，判据才立得住：
 *   e164   —— 客户原文里带 + / 00，过了国际区号白名单。最可信
 *   jid    —— 从 @c.us JID 直接推出来的，WhatsApp 自己给的，可信
 *   contact—— 问 WhatsApp 联系人拿到的，可信
 *   text   —— 从客户自己打的字里抠出来的（"my wa is +44 7726 795080"）
 *   manual —— 用户自己在档案弹窗填的，最高优先级，永不被自动流程覆盖
 *   ''     —— 还没有 / 没抓到
 *
 * 弱来源（text 且数字对不上国际格式）会触发"重抓一次跟原号对比"。
 * phone 字段本身继续存**纯数字**，编号库 / 档案文件名 / 云端查重全都不受影响。
 */
ensureColumn('customers', 'phone_src', "TEXT DEFAULT ''");

/*
 * media_src —— 附件的来源标记（2026-10-07 方案 A 加）
 *   download —— 走 whatsapp-web.js 官方 downloadMedia() 拿到的真原图，永久有效
 *   base64 —— 从消息正文（data:image/...;base64）里救出来的，当天能看到，
 *              但消息在浏览器里刷新后可能失效
 *   none    —— 是媒体消息但没拿到图（界面显示占位符，不留空白气泡）
 * 用它一眼分辨"能长期存的图"和"临时抢救的图"。
 */
ensureColumn('messages', 'media_src', "TEXT DEFAULT ''");

/*
 * media_type —— 这条消息的真实媒体身份（2026-10-07 21:15 加）
 *   image / sticker / video / audio / ptt / document
 *
 * 🔴 为什么必须单独存（这是一个真 bug 的根因）：
 *   `media.kindOf(path)` 是按**文件扩展名**判类型的，而 WhatsApp 贴纸存下来
 *   就是 .webp —— webp 在 IMAGE_EXT 里 → **贴纸被当成图片**，
 *   界面上写「🖼 图片」，谁也分不出那是贴纸。
 *   msg.type 这个真实身份以前在 saveMedia 之后就丢了，这里把它留下来。
 *
 * 空字符串 = 老数据/ 不是媒体消息（界面按扩展名兜底，不影响）。
 */
ensureColumn('messages', 'media_type', "TEXT DEFAULT ''");

/** key 是否真的在对象里（值可以是 undefined，但键存在） */
function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 存量回填（2026-10-07）：给已有号码猜一个来源标记。
 * ⚠️ 只在 phone_src 为空时填，绝不覆盖已经判过的。
 * 判据（从严）：
 *   带+号→ manual 或 e164（人工填的带 +，自动抓的带不了 +，所以带 + 一律判人工）
 *   11 位且以 1 开头 → jid（北美 E.164）
 *   8~13 位 → text（弱来源，值得重抓对比一次）
 *   其余（7 位 / 14 位+）→ text 但标记为脏数据，交给 clearLidPhones 那套处理
 */
(function backfillPhoneSrc() {
  const cols = db.prepare(`PRAGMA table_info(customers)`).all().map((c) => c.name);
  if (!cols.includes('phone_src')) return;
  const rows = db
    .prepare(
      `SELECT code, phone, created_at_source FROM customers
        WHERE COALESCE(phone_src, '') = ''
          AND phone IS NOT NULL AND TRIM(phone) <> ''`
    )
    .all();
  const upd = db.prepare(`UPDATE customers SET phone_src=? WHERE code=?`);
  for (const r of rows) {
    const raw = String(r.phone);
    const d = raw.replace(/\D/g, '');
    let src = '';
    if (raw.includes('+')) src = 'manual'; // 自动链路剥了加号，带 + 只能是人工填的
    else if (r.created_at_source === 'manual') src = 'manual';
    else if (d.length === 11 && d.startsWith('1')) src = 'jid';
    else src = 'text';
    upd.run(src, r.code);
  }
})();

/*
 * 消息级「已处理」：新收到的客户消息 processed=0，界面上它的左侧就挂一个红数字；
 * 点过该消息 1 秒后数字变绿；等这条消息真被处理了（标记已回复 / 自己发出消息）才置 1、数字消失。
 *
 * 存量历史消息一律算"已处理"——否则一升级，顶栏「待处理」会瞬间变成几百条（那些早就是旧消息）。
 */
(function ensureProcessed() {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
  if (!cols.includes('processed')) {
    db.exec(`ALTER TABLE messages ADD COLUMN processed INTEGER DEFAULT 0`);
    db.exec(`UPDATE messages SET processed = 1`); // 只有新来的才算未处理
  }
})();

/* ---------------- 账号 ---------------- */

const upsertAccount = db.prepare(`
  INSERT INTO accounts (id, label, phone, proxy) VALUES (@id, @label, @phone, @proxy)
  ON CONFLICT(id) DO UPDATE SET label=@label, phone=@phone, proxy=@proxy
`);

const setAccountStatus = db.prepare(
  `UPDATE accounts SET status=?, last_seen=? WHERE id=?`
);

const listAccounts = db.prepare(`SELECT * FROM accounts ORDER BY id`);

/* ---------------- 客户与编号 ---------------- */

const findCustomer = db.prepare(
  `SELECT * FROM customers
   WHERE account_id=? AND wa_jid=? AND IFNULL(channel,'whatsapp')=IFNULL(?,'whatsapp')`
);

const maxCodeOfAccount = db.prepare(
  `SELECT code FROM customers WHERE account_id=? ORDER BY code DESC LIMIT 1`
);

/* Telegram「翻译面板」反查用（2026-10-11）：
   采集侧入库时 wa_jid 固定是 `tg:<peerId>`、channel='telegram'、account_id=7，
   这里按同样口径把客户档案捞回来 —— 不额外建表、不加列，口径跟采集侧天然一致。 */
const findCustomerByTgPeer = db.prepare(
  `SELECT * FROM customers
   WHERE account_id=? AND wa_jid=? AND IFNULL(channel,'whatsapp')=?`
);

const insertCustomer = db.prepare(`
  INSERT INTO customers (code, account_id, wa_jid, phone, name, channel, region, phone_src, created_at, is_sim)
  VALUES (@code, @account_id, @wa_jid, @phone, @name, @channel, @region, @phone_src, @created_at, @is_sim)
`);

/**
 * 取客户；不存在则按规则分配新编号
 * @returns {{customer: object, isNew: boolean}}
 */
/** 最近一次"号码因重复被拒写"的记录（供 /api 排查；不落库，只在本进程内存）
 *  🔴 必须声明在**所有使用点之前**：getOrCreateCustomer(360 行) 也会写它，
 *     放到文件后半段会踩 let 的 TDZ（暂时性死区）—— 这是 2.5.1073 ai.js 崩过的同类坑。
 */
// 🔴 按**客户编号**存，不存单条：并发采集时多个客户可能同时被拒，
//    存单条会被后来的覆盖，A 客户的拒写记录就错报成 B 的。
const phoneDupLog = new Map();   // code -> { phone, owner, at, via }
function notePhoneDup(code, phone, owner, via) {
  phoneDupLog.set(String(code), { code: String(code), phone, owner, via: via || '', at: new Date().toISOString() });
  // 只留最近 200 条，别让它无限长（纯内存，进程退出即消失）
  if (phoneDupLog.size > 200) {
    const oldest = phoneDupLog.keys().next().value;
    phoneDupLog.delete(oldest);
  }
}

function getOrCreateCustomer(accountId, waJid, info = {}) {
  const channel = info.channel || 'whatsapp';
  const existed = findCustomer.get(accountId, waJid, channel);
  if (existed) return { customer: existed, isNew: false };

  // 同一手机号已经分配过编号？直接复用（跨账号也合一，符合"以手机为基准"）。
  // 这样同一个客户加你多个 WhatsApp 号，编号永远只有一个，读档案更快、也不会被认成两个客户。
  //
  // 注意：只在**同一渠道**内合并。tg:/ig:/li:/fb: 是后期要接的渠道，
  //   同号码在 Telegram 和 WhatsApp 上是两条独立会话（渠道前缀是刻意预留的），
  //   跨渠道合并会把 tg 客户吞成 WhatsApp 客户、渠道字段也跟着错。见 test/manual.test.js
  //   「渠道预留：同一号码在不同渠道是两个客户」。
  // 电话只认 @c.us / @s.whatsapp.net 且是 7~15 位数字：
  // @lid（WhatsApp 用来隐藏手机号的隐私 ID）那串也是数字，以前被当电话存进去过，
  // 结果档案里躺着一串打不通的假号码。见 src/identity.js 的 phoneFromJid。
  const phone = info.phone || identity.phoneFromJid(waJid) || null;
  const norm = numberLibrary.normalizePhone(phone);
  if (norm) {
    const existingCode = numberLibrary.lookup(norm, channel);
    if (existingCode) {
      const c = getCustomer.get(existingCode);
      if (c) return { customer: c, isNew: false };
    }
  }

  const last = maxCodeOfAccount.get(accountId);
  const code = ids.nextCustomerCode(accountId, last ? last.code : null);
  const now = new Date().toISOString();

  // 🔴 v2.6.1095 建档守门：上面的 lookup 只在「同渠道」里找，跨渠道 / 老数据格式不一致时会漏。
  //    这里再兜一次全库查重 —— 号码已被别人占用就**不把这个号写进新档案**，
  //    客户档案照建（消息得留地方），但号码位留空，绝不让一个号躺在 N 个档案里。
  //    （老板原话：「先识别电话号码有没有相同的，如果没有相同就存进去」）
  const dupOwner = norm ? phoneOwnerOf(norm, code) : '';
  const phoneToStore = dupOwner ? null : phone;
  if (dupOwner) {
    notePhoneDup(code, norm, dupOwner, 'getOrCreateCustomer');
  }

  const row = {
    code,
    account_id: accountId,
    wa_jid: waJid,
    // 只有 JID 长得像手机号时才推断号码，别把 "ig:some_user" 当号码存进去；
    // 且号码已被别的客户占用时**留空**（v2.6.1095 查重守门）
    phone: phoneToStore || null,
    name: info.name || null,
    channel,
    // 新建客户时把抓取到的国家（来自国际区号反查）写进地区，方便按国别跟进
    region: info.region || null,
    // 号码来源标记（2026-10-07）：e164/jid/contact/text/manual —— 判"要不要重抓对比"用
    phone_src: info.phoneSrc || (phone ? 'jid' : ''),
    created_at: now,
    is_sim: info.isSim ? 1 : 0,
  };
  insertCustomer.run(row);
  if (norm) numberLibrary.register(norm, code, channel); // 登记进编号库：手机号 ↔ 编号（按渠道分桶）
  return { customer: findCustomer.get(accountId, waJid, channel), isNew: true };
}

const updateCustomer = db.prepare(`
  UPDATE customers SET
    name      = COALESCE(@name, name),
    region    = COALESCE(@region, region),
    timezone  = COALESCE(@timezone, timezone),
    stage_day = COALESCE(@stage_day, stage_day),
    mood      = COALESCE(@mood, mood),
    summary   = COALESCE(@summary, summary),
    profile_json = COALESCE(@profile_json, profile_json),
    phone     = COALESCE(@phone, phone),
    phone_src = CASE
      WHEN @phone IS NOT NULL AND TRIM(@phone) <> '' THEN 'manual'
      ELSE COALESCE(@phone_src, phone_src) END,
    created_at = COALESCE(@created_at, created_at),
    created_at_source = COALESCE(@created_at_source, created_at_source)
  WHERE code = @code
`);

/** 改加入时间。手动改过之后就标 manual，之后自动流程不再覆盖它 */
function setJoinedAt(code, iso, source = 'manual') {
  db.prepare(`UPDATE customers SET created_at=?, created_at_source=? WHERE code=?`).run(iso, source, code);
}

/**
 * 补身份（2026-09-28 加）：老客户建号时没抓到名字 / 电话，后来从 WhatsApp 问到了就补上。
 * **只填空、绝不覆盖**——用户自己改过的名字、填过的号码不能被采集流程冲掉。
 *
 * 2026-10-07 加 phone_src：号码来源一起写。manual（人工填的）永远钉死不动，
 * 自动流程只能填空、不能替换，避免"系统把老板手填的号码冲掉"。
 * @returns {boolean} 是否真的补了东西（用来决定要不要广播给界面刷新）
 */
const fillIdentityStmt = db.prepare(
  `UPDATE customers SET
     name   = COALESCE(name,  NULLIF(@name, '')),
     phone  = COALESCE(phone, NULLIF(@phone, '')),
     region = COALESCE(region, NULLIF(@region, '')),
     phone_src = CASE
       WHEN COALESCE(phone_src, '') = '' THEN NULLIF(@phoneSrc, '')
       ELSE phone_src END
   WHERE code = @code`
);
/**
 * 补写 Telegram 客户的 @username（v2.5.1032）
 *   只填空、不覆盖：已经有值的老客户不会被后来的值冲掉（用户名基本不会变，但保守点更安全）。
 *   这个函数是「跳到聊天」用官方深链 web.telegram.org/k/#@username 的前提 ——
 *   有 username 就能精确定位（用户名唯一，不会重名点错），没有就退回搜索框兜底。
 * @param {string} code 客户编号
 * @param {string} username 不含 @ 的用户名；空值直接忽略
 * @returns {boolean} 真的写入了返回 true（客户不存在 / 已有值 / 空值 都返回 false）
 */
function saveTgUsername(code, username) {
  const u = String(username || '').trim().replace(/^@/, '');
  if (!code || !u) return false;
  try {
    // 函数内 prepare：列由 ensureColumn 保证存在，且不依赖模块加载顺序
    const r = db
      .prepare(`UPDATE customers SET tg_username = ? WHERE code = ? AND COALESCE(tg_username, '') = ''`)
      .run(u, String(code));
    return Number(r && r.changes) > 0;
  } catch (e) {
    return false;
  }
}

/** 这一行的号码位是不是还空着（人工填的号也算「不空」） */
function needPhoneSlot(c) {
  return !String((c && c.phone) || '').trim();
}

/* ---------------- 跨账号查重（v2.6.1095 电话入库守门） ---------------- */

/**
 * 这个号码是不是已经被别的客户占了？占了返回那个客户编号，没占用返回空串。
 *
 * 🔴 老板原话：「一定要直接写到数据库，这里很关键的一步
 *    **先识别电话号码有没有相同的，如果没有相同就存进去**。」
 *    这条守门就架在这儿：任何自动流程（backfillIdentity / applyRegrab）
 *    写号码前都必须先过它。
 *
 * 为什么能直接等值比：phone 字段全系统统一存**纯数字**，
 * 「+」号在 src/identity.js:166 的返回值里就已经被剥掉了。
 *
 * @param {string} phone 纯数字号码
 * @param {string} [excludeCode] 排除自己（回填自己的档案时用）
 * @returns {string} 已占用的客户编号，或 ''（可用）
 */
function phoneOwnerOf(phone, excludeCode) {
  // 比的是**纯数字**：库里存的虽然是纯数字，但调用方（重抓、文本抽取）
  // 有可能递进来带 "+" / 空格的串。只按原样比会漏掉同一个号的两种写法。
  const p = String(phone || '').replace(/\D/g, '');
  if (!p) return '';
  const self = String(excludeCode || '');
  try {
    // ① 先走索引快查（库里绝大多数是纯数字，idx_customers_phone 能命中）
    const hit = db
      .prepare(`SELECT code FROM customers WHERE phone = ? AND code <> ? LIMIT 1`)
      .get(p, self);
    if (hit && hit.code) return String(hit.code);

    // ② 兜底扫全表归一比较：防存量库里混着 "+86…" 这种老写法被当成另一个号。
    //    走这条的次数极少（只有第一查没命中才扫），代价可接受。
    const rows = db
      .prepare(`SELECT code, phone FROM customers WHERE code <> ? AND COALESCE(phone,'') <> ''`)
      .all(self);
    for (const r of rows) {
      if (String(r.phone || '').replace(/\D/g, '') === p) return String(r.code);
    }
    return '';
  } catch (e) {
    // 查重失败**绝不能当成"没重复"就放行** —— 那等于把关卡形同虚设。
    // 返回一个不可能等于真实编号的哨兵值，让上层拒绝写入。
    return '§查重失败§';
  }
}

function backfillIdentity(code, info = {}) {
  const name = String(info.name || '').trim();
  const phone = String(info.phone || '').trim();
  // 国家标注：resolve 现在会返回 country（来自国际区号反查），作为 region 的兜底
  const region = String(info.region || info.country || '').trim();
  const c = getCustomer.get(code);
  if (!c) return false;

  // 🔴 v2.6.1095 老板定调：「自动获取到的电话号码一定要直接写进数据库，
  //    **先查这个号码有没有相同的，没有相同才存**」。
  //    原实现的漏洞：fillIdentityStmt 只看**本行** phone 空不空（COALESCE(phone, …)），
  //    从来不查全库 —— 同一个号能落进 N 个客户档案，越收越多。
  //    这里补上查重门：号码已被别人占用（或查重失败）→ **不写这个号**，
  //    但姓名/地区照常补，不因为一个号码卡住整条资料。
  let dupOf = '';
  if (phone && needPhoneSlot(c)) {
    const dup = phoneOwnerOf(phone, code);
    if (dup) dupOf = dup;
  }
  const phoneToWrite = dupOf ? '' : phone;

  // 人工填的号码：来源钉死 manual，任何自动流程都不许动它（含号码本身）
  const src = c.phone_src === 'manual' ? '' : String(info.phoneSrc || '');
  const needName = !String(c.name || '').trim();
  const needRegion = region && !String(c.region || '').trim();
  const needSrc = src && !String(c.phone_src || '').trim();
  // 🔴 号码项单独算「有进展」：有重复时它算没进展，否则会拿 dupOf 当成功返回给上层
  const wantPhone = !dupOf && needPhoneSlot(c) && !!phone;
  if (!wantPhone && !needName && !needRegion && !needSrc) return false;
  const r = fillIdentityStmt.run({
    code, name, region, phoneSrc: src,
    phone: phoneToWrite,
  });
  const changed = Number(r.changes || 0) > 0;
  if (dupOf && changed) {
    // 如实留痕：这个号被别人占了，所以**没写进去**，别让上层以为取号成功了
    notePhoneDup(code, phone, dupOf, 'backfillIdentity');
  }
  // 🔴 返回值只表示"这次改动有没有发生"，重复与否由 lastPhoneDup / phoneOwnerOf 自查
  return changed;
}

/** 某个客户的号码最近一次因重复被拒写的记录；没有就返回 null */
function lastPhoneDuplicate(code) {
  if (!code) return null;
  return phoneDupLog.get(String(code)) || null;
}

/** 来源可信度：数字越大越可信（判断"要不要重抓对比"用） */
const PHONE_SRC_RANK = { e164: 5, manual: 4, contact: 3, jid: 2, text: 1, '': 0 };
function phoneSrcRank(src) {
  return PHONE_SRC_RANK[String(src || '')] || 0;
}

/**
 * 重抓对比后的落库（2026-10-07 加）
 *
 * 用户的原话是"电话号码里没有 + 就重新提取电话，跟原来的电话进行对比"。
 * 因为加号在取号链路里已经被剥掉了（见 phone_src 那段注释），
 * 所以实际判据改成**来源强度**：弱来源（text / ''）才值得重抓。
 *
 * @param {string} code
 * @param {{phone:string, phoneSrc:string, country?:string}} info 新抓到的一轮
 * @returns {{action:string, oldPhone?:string, newPhone?:string}}
 *   action = 'skip'      没有新号码 / 不该动
 *             'filled'   原来空 → 已填
 *             'upgraded' 号码数字一样、只是来源更可信 → 只升级来源标记
 *             'conflict' 两次抓到的号码不一样 → **绝不覆盖**，交给用户判断
 */
function applyRegrab(code, info = {}) {
  const c = getCustomer.get(code);
  if (!c) return { action: 'skip' };
  const newPhone = String(info.phone || '').trim();
  if (!newPhone) return { action: 'skip', oldPhone: c.phone || '' };

  const oldPhone = String(c.phone || '').trim();
  const newSrc = String(info.phoneSrc || '').trim();

  // 人工填的号码，谁都不许动
  if (c.phone_src === 'manual') return { action: 'skip', oldPhone, newPhone };

  // 情况1：原来空 → 直接填
  if (!oldPhone) {
    // 🔴 v2.6.1095 补门：这条路径原来直接写号码，完全不查重 ——
    //    同一个号能经由"重抓"再次落库，绕过 backfillIdentity 的查重。
    //    现在所有写号码的路都必须先过 phoneOwnerOf。
    const owner = phoneOwnerOf(newPhone, code);
    if (owner) {
      notePhoneDup(code, newPhone, owner, 'applyRegrab');
      return { action: 'duplicate', oldPhone, newPhone, owner };
    }
    db.prepare('UPDATE customers SET phone=?, phone_src=?, region=COALESCE(NULLIF(region,\'\'), ?) WHERE code=?')
      .run(newPhone, newSrc, String(info.country || '').trim(), code);
    return { action: 'filled', newPhone };
  }

  const dOld = oldPhone.replace(/\D/g, '');
  const dNew = newPhone.replace(/\D/g, '');

  // 情况2：数字一样 → 只是来源更可信，升级标记，不动号码
  if (dOld === dNew) {
    if (phoneSrcRank(newSrc) > phoneSrcRank(c.phone_src)) {
      db.prepare('UPDATE customers SET phone_src=? WHERE code=?').run(newSrc, code);
      return { action: 'upgraded', oldPhone, newPhone };
    }
    return { action: 'skip', oldPhone, newPhone };
  }

  // 情况3：新号码比旧号码弱 → 保留旧的（别用一个弱来源覆盖）
  if (phoneSrcRank(newSrc) <= phoneSrcRank(c.phone_src)) {
    return { action: 'skip', oldPhone, newPhone };
  }

  // 情况4：新来源更强但号码不一样 —— 疑似两个号码（换号 / 抓错）。
  // 🔴 不静默覆盖，也不改 phone_src。
  //    原因：phone_src 描述的是"**库里这个号码**从哪来"。号码没换、来源标记却换成
  //    新抓的那个，等于给旧号码贴了错标签 —— 下次判断强弱来源就会基于错的依据，
  //    而且再也回不去原来那个标记了。这里一律不动，只把两个号报给用户人工判断。
  return { action: 'conflict', oldPhone, newPhone };
}

/**
 * 缺身份的客户（姓名或电话是空的）——账号一登录就补一次。
 * 老版本抓不到名字/电话，库里躺着一批"无名氏"；这次按 JID 反问一次 WhatsApp 就能补上。
 */
const listMissingIdentity = db.prepare(
  `SELECT code, wa_jid, account_id FROM customers
    WHERE COALESCE(is_sim, 0) = 0
      AND (TRIM(COALESCE(name, '')) = '' OR TRIM(COALESCE(phone, '')) = '')
    ORDER BY id DESC LIMIT ?`
);

/**
 * 清掉被当成电话存进去的 **LID**（2026-09-28 加，2026-09-29 加严）
 *
 * 老代码从 JID 推断电话时只看"是不是数字"，WhatsApp 的 @lid 隐私 ID 也是数字，
 * 于是有一批客户档案里躺着那串 LID（15 位、打不通、还会在查重时误合并）。
 *
 * 判据（只对 wa_jid 是 @lid 的客户动手，别人的正常号码一律不碰）：
 *   a) 电话正好等于 JID 里那串数字 → 一定是从 LID 抄来的；
 *   b) 电话长度 ≥ 14 位 → LID 是 14~16 位，真手机号实际极少超过 13 位。
 *      （2026-09-29 用户报："+447726795080 变成了 243834688639050"，
 *        这条就是长度兜底抓出来的。）
 * 清掉留空，好让登录后的补身份流程（backfillIdentities）去问出真号码。
 * @returns {number} 清掉几条的假号码
 */
function clearLidPhones() {
  let n = 0;
  try {
    const rows = db
      .prepare(`SELECT code, wa_jid, phone FROM customers WHERE wa_jid LIKE '%@lid' AND phone IS NOT NULL`)
      .all();
    const upd = db.prepare(`UPDATE customers SET phone=NULL WHERE code=?`);
    for (const r of rows) {
      const lidDigits = String(r.wa_jid || '').split('@')[0].replace(/\D/g, '');
      const phoneDigits = String(r.phone || '').replace(/\D/g, '');
      if (!phoneDigits) continue;
      const sameAsLid = !!lidDigits && String(r.phone) === lidDigits;
      if (sameAsLid || phoneDigits.length >= 14) {
        upd.run(r.code);
        n++;
      }
    }
  } catch (e) {
    /* 查不动就算了 */
  }
  return n;
}

/**
 * 清掉「空消息」：既没有文字、也没有图片语音的消息（撤回提示、加密提示、通话记录、
 * 表情回应这类）不该被采集出来占一条对话。2026-09-28 用户反馈后加。
 * 只在启动时跑一次，把历史遗留的空行清掉；新消息在入库前就被拦住了。
 * @returns {number} 删掉多少条
 */
function purgeEmptyMessages() {
  const r = db
    .prepare(
      `DELETE FROM messages
        WHERE TRIM(COALESCE(body, '')) = ''
          AND TRIM(COALESCE(media_path, '')) = ''`
    )
    .run();
  return Number(r.changes || 0);
}

const getCustomer = db.prepare(`SELECT * FROM customers WHERE code=?`);

/* ---------------- 待处理状态 ---------------- */

const setPending = db.prepare(
  `UPDATE customers SET pending=?, last_msg_at=? WHERE code=?`
);

/**
 * 排队时间只在"从没待处理 → 变成待处理"这一刻写入（pending 还不是 1 时）。
 * 同一客户之后再来消息不会重写它 —— 左栏位置因此保持不动（用户 2026-09-26 规则二）。
 */
const stampQueueSince = db.prepare(
  `UPDATE customers SET queue_since=? WHERE code=? AND COALESCE(pending, 0)=0`
);

/** 收到客户消息 -> 置为待处理 */
function markPending(code, ts) {
  const t = ts || new Date().toISOString();
  stampQueueSince.run(t, code); // 先于 setPending：只在"这是第一条待处理消息"时记排队时间
  setPending.run(1, t, code);
}

/** 我回复了 / 手动点已回复 -> 清除待处理（提示窗口消失） */
function clearPending(code) {
  setPending.run(0, new Date().toISOString(), code);
  db.prepare(`UPDATE customers SET queue_since=NULL WHERE code=?`).run(code); // 出队，位置清空
  // 处理完 = 红/绿数字一并消失：未读也清零（回了就等于看过了）。
  // 补这一句是为了让「✓ 标记已回复」直接调接口也能出队，不必依赖界面先点开过。
  clearUnread(code);
  markProcessed(code); // 这个客户的新消息都算处理完
}

/** 把某个客户所有未处理的「客户发来的」消息标成已处理 */
function markProcessed(code) {
  db.prepare(
    `UPDATE messages SET processed=1
      WHERE customer_code=? AND direction='in' AND COALESCE(processed,0)=0`
  ).run(code);
}

/**
 * 「我是不是已经回过这条了」—— 这个客户**最新的一条对话是我发的** → 该点「✓ 标记已回复」了。
 *
 * 界面拿它当闸门（用户 2026-09-26 要求）：
 *   没检测到我的回复 → 「✓ 标记已回复」灰着按不动；
 *   检测到了        → 亮起来，点一下把左栏那一格收起来。
 * 之所以看"最新一条"而不是"有没有回过"：客户又发来新的一条之后，
 * 上一轮的回复就不算数了，得再回一次才行。
 */
const lastMsgDirStmt = db.prepare(
  `SELECT direction FROM messages WHERE customer_code=? ORDER BY id DESC LIMIT 1`
);
function repliedLast(code) {
  const r = lastMsgDirStmt.get(code);
  return !!r && r.direction === 'out';
}

/** 全局还有多少条新消息没处理（顶栏「待处理 N」用：每来一条 +1） */
function countUnprocessed() {
  return (
    db.prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE direction='in' AND COALESCE(processed,0)=0`
    ).get().n || 0
  );
}

/* ---------------- 今日消息统计（左栏顶部那个"今日消息"提示窗） ---------------- */

/**
 * 今天（按本机本地日期）的消息概览。
 *
 * msg_ts 存的是 ISO UTC（形如 2026-09-24T23:11:00.000Z），SQLite 认得这个格式，
 * 所以直接用 date(msg_ts,'localtime') 换成当地日期，和 date('now','localtime') 比。
 *
 * 返回：
 *   received  今天客户发来的消息条数
 *   handled   今天这些里已经处理掉的
 *   todo      今天这些里还等你处理的
 *   sent      今天你自己发出去的条数
 *   byAccount 按账号拆：{ 1: 3, 2: 0, ... }（左栏 ① ② ③ ④ ⑤ 各自多少条）
 */
function statsToday() {
  const today = "date(msg_ts,'localtime') = date('now','localtime')";
  const one = (sql) => {
    try {
      return db.prepare(sql).get().n || 0;
    } catch (e) {
      return 0;
    }
  };
  const received = one(`SELECT COUNT(*) AS n FROM messages WHERE direction='in' AND ${today}`);
  const todo = one(
    `SELECT COUNT(*) AS n FROM messages
      WHERE direction='in' AND COALESCE(processed,0)=0 AND ${today}`
  );
  const sent = one(`SELECT COUNT(*) AS n FROM messages WHERE direction='out' AND ${today}`);

  const byAccount = {};
  try {
    for (const r of db
      .prepare(
        `SELECT account_id AS id, COUNT(*) AS n FROM messages
          WHERE direction='in' AND ${today} GROUP BY account_id`
      )
      .all()) {
      byAccount[Number(r.id)] = r.n;
    }
  } catch (e) {
    /* 查不动就空着 */
  }

  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    received,
    handled: Math.max(0, received - todo),
    todo,
    sent,
    byAccount,
  };
}

/**
 * 今日消息实时收件箱（v2.5.1084）：返回今天跨客户收到的消息，按时间倒序。
 * 之前左栏「今日消息」只显示账号计数，客户发来的具体内容看不到 → 体感"收不到新消息"。
 * 这里把内容拉出来，前端直接列在账号圈下方，点开进对应客户对话。
 * 字段：code(客户编号)/name(客户名)/direction(in|out)/body/bodyZh(译文)
 *       accountId/msgTs(时间)/hasMedia(是否有图或语音)。
 */
function todayMessages(limit = 200) {
  const today = "date(msg_ts,'localtime') = date('now','localtime')";
  const notEmpty = "(TRIM(COALESCE(m.body,''))<>'' OR TRIM(COALESCE(m.media_path,''))<>'')";
  try {
    /* 🔴 v2.6.1093 老板拍板：**去掉 account_id NOT IN (7,8,9) 整段排除**。
       原来那句是v2.5.1087 为「去掉 Telegram 重复消息」加的，副作用是把 Telegram 三个账号
       整段踢出今日消息 → 老板反馈「收不到信息」的直接原因。
       Telegram 现在照样在这里显示：主表 messages 靠 wa_msg_id 天然去重（同一串 id 只入一次），
       不需要再靠"整段排除"来去重。 */
    return db.prepare(
      `SELECT m.customer_code AS code,
              c.name AS name,
              m.direction AS direction,
              m.body AS body,
              m.body_zh AS bodyZh,
              m.account_id AS accountId,
              m.msg_ts AS msgTs,
              m.wa_msg_id AS waMsgId,
              (CASE WHEN TRIM(COALESCE(m.media_path,''))<>'' THEN 1 ELSE 0 END) AS hasMedia
       FROM messages m
       LEFT JOIN customers c ON c.code = m.customer_code
       WHERE ${today} AND ${notEmpty}
       ORDER BY m.id DESC
       LIMIT ?`
    ).all(limit).map((r) => ({
      code: r.code,
      name: r.name || '',
      direction: r.direction === 'out' ? 'out' : 'in',
      body: r.body || '',
      bodyZh: r.bodyZh || '',
      accountId: Number(r.accountId) || 0,
      msgTs: r.msgTs || '',
      waMsgId: r.waMsgId || '',
      hasMedia: Number(r.hasMedia) || 0,
    }));
  } catch (e) {
    return [];
  }
}

/* ---------------- Telegram 原生界面（应用版，v2.5.1085） ----------------
 * 清掉 web.telegram.org 网页后，Tele① 左栏 = 原生会话列表、右栏 = 原生聊天气泡，
 * 数据全部来自库（MTProto 采集已落库），不再读网页 DOM。
 * Telegram 账号 account_id 固定为 7/8/9（Tele①②③），见 config.yaml。 */

const TG_ACCOUNTS = [7, 8, 9];

/** Tele① 左栏会话列表：每个 Telegram 客户一条，带最近一条预览 + 未读数，按时间倒序 */
function tgConversations(limit = 50) {
  const notEmpty = "(TRIM(COALESCE(m.body,''))<>'' OR TRIM(COALESCE(m.media_path,''))<>'')";
  try {
    return db.prepare(
      `SELECT m.customer_code AS code,
              c.name AS name,
              m.direction AS direction,
              m.body AS body,
              m.body_zh AS bodyZh,
              m.msg_ts AS lastTs,
              COALESCE(c.unread, 0) AS unread
       FROM messages m
       JOIN customers c ON c.code = m.customer_code
       WHERE m.account_id IN (${TG_ACCOUNTS.join(',')}) AND ${notEmpty}
         AND m.msg_ts = (
           SELECT MAX(msg_ts) FROM messages mx
           WHERE mx.customer_code = m.customer_code AND mx.account_id IN (${TG_ACCOUNTS.join(',')})
         )
       ORDER BY m.msg_ts DESC
       LIMIT ?`
    ).all(limit).map((r) => ({
      code: r.code,
      name: r.name || '',
      direction: r.direction === 'out' ? 'out' : 'in',
      preview: r.body || (r.bodyZh ? '(图片/媒体)' : ''),
      bodyZh: r.bodyZh || '',
      lastTs: r.lastTs || '',
      unread: Number(r.unread) || 0,
    }));
  } catch (e) {
    return [];
  }
}

/** Tele① 右栏聊天气泡：某客户全部 Telegram 消息（含译文），时间正序 */
function tgMessages(code, limit = 200) {
  const notEmpty = "(TRIM(COALESCE(m.body,''))<>'' OR TRIM(COALESCE(m.media_path,''))<>'')";
  try {
    return db.prepare(
      `SELECT m.id AS id,
              m.direction AS direction,
              m.body AS body,
              m.body_zh AS bodyZh,
              (CASE WHEN TRIM(COALESCE(m.media_path,''))<>'' THEN 1 ELSE 0 END) AS hasMedia,
              m.msg_ts AS msgTs,
              m.wa_msg_id AS waMsgId,
              /* v2.6.1136：Telegram 正文尾部剥出来的显示时间（界面用它渲染时间方框） */
              COALESCE(m.msg_time, '') AS msgTime
       FROM messages m
       WHERE m.customer_code = ? AND m.account_id IN (${TG_ACCOUNTS.join(',')}) AND ${notEmpty}
       ORDER BY m.msg_ts ASC
       LIMIT ?`
    ).all(code, limit).map((r) => ({
      id: Number(r.id) || 0,
      direction: r.direction === 'out' ? 'out' : 'in',
      body: r.body || '',
      bodyZh: r.bodyZh || '',
      hasMedia: Number(r.hasMedia) || 0,
      msgTs: r.msgTs || '',
      waMsgId: r.waMsgId || '',
      msgTime: r.msgTime || '',
    }));
  } catch (e) {
    return [];
  }
}

/**
 * 客户编号 → Telegram 发送目标（peer）解析（v2.5.1087：Tele① 回复框真发送用）。
 * 返回 { code, chatKey(数值 peerId), accountId, waJid }；找不到返回 null。
 * wa_jid 对 Telegram 客户固定是 `tg:<peerId>`、channel='telegram'、account_id=7/8/9。
 */
function tgPeerByCode(code) {
  if (!code) return null;
  try {
    const r = db.prepare(
      `SELECT code, wa_jid, account_id FROM customers
       WHERE code = ? AND IFNULL(channel, 'whatsapp') = 'telegram' LIMIT 1`
    ).get(code);
    if (!r || !r.wa_jid) return null;
    const chatKey = String(r.wa_jid).replace(/^tg:/, '').trim();
    if (!/^\d+$/.test(chatKey)) return null;
    return { code: r.code, chatKey, accountId: r.account_id, waJid: r.wa_jid };
  } catch (e) {
    return null;
  }
}

/* ---------------- 未读新消息计数 ---------------- */

const bumpUnreadStmt = db.prepare(
  `UPDATE customers SET unread = COALESCE(unread, 0) + 1 WHERE code = ?`
);
const clearUnreadStmt = db.prepare(`UPDATE customers SET unread = 0 WHERE code = ?`);

/** 收到一条客户消息 -> 未读 +1（同一个客户的多条消息累计在这一格里） */
function bumpUnread(code) {
  bumpUnreadStmt.run(code);
  return getCustomer.get(code)?.unread || 0;
}

/** 用户在界面上点开了这个客户 -> 未读清零 */
function clearUnread(code) {
  clearUnreadStmt.run(code);
}

/** 未读总数（顶栏/侧栏小结用） */
function totalUnread() {
  return db.prepare('SELECT COALESCE(SUM(unread), 0) AS n FROM customers').get().n || 0;
}

/**
 * 「自己」的行（is_self=1）从**列表类**查询里排掉（2026-10-17）。
 *
 * 🔴 为什么必须放在 db 层、而不是 server.js 的 rows.filter() 里：
 *   列表**排序**也依赖未读/排队时间，先排完再过滤会让"自己那条"占着红点位置、
 *   把真客户往下挤。在 SQL 里排掉才是真的从源头没有这一行。
 *
 * 🔴 边界（一条都不能越）：
 *   - 只排 listCustomers / listPending 这两个「列表展示」查询；
 *   - getCustomer(code)、findCustomer*、采集写入路径 —— 一律不动。
 *     档案页仍能打开自己那条（出问题要查/要删）。
 *
 * ⚠️ 已知副作用（如实记录，不隐瞒）：wordDoc.rebuildAll() 在**不传 codes** 时
 *   是遍历本语句来"全量重建"的，所以那条自动重建会跳过 is_self 的档案。
 *   磁盘上已有的 docx 不会被删；按编号单独重建走的是 getCustomer（不过滤），
 *   照样能生成。要不要让"全量重建"也带上它，属于档案导出的口径问题，
 *   改它要动 src/wordDoc.js（不在本次范围内），所以这里只登记、不动。
 *
 * 老库没有 is_self 列时（ALTER 没跑成功的极端情况）退回不过滤的旧 SQL：
 * 宁可多显示自己那一行，也绝不让整个客户列表报 "no such column" 打不开。
 *
 * @param {string} sqlFiltered 带 is_self 过滤的 SQL
 * @param {string} sqlPlain    不带过滤的兜底 SQL（老库用）
 * @returns {object} prepared statement
 */
function prepareListStmt(sqlFiltered, sqlPlain) {
  try {
    return db.prepare(sqlFiltered);
  } catch (e) {
    console.warn('[db] customers 没有 is_self 列，客户列表退回不过滤版本：', (e && e.message) || e);
    return db.prepare(sqlPlain);
  }
}

const listPending = prepareListStmt(`
  SELECT c.*, (SELECT body FROM messages m WHERE m.customer_code=c.code
               ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT body_zh FROM messages m WHERE m.customer_code=c.code
               ORDER BY m.id DESC LIMIT 1) AS last_body_zh
  FROM customers c WHERE c.pending=1 AND COALESCE(c.is_self, 0) <> 1
  ORDER BY c.last_msg_at DESC
`, `
  SELECT c.*, (SELECT body FROM messages m WHERE m.customer_code=c.code
               ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT body_zh FROM messages m WHERE m.customer_code=c.code
               ORDER BY m.id DESC LIMIT 1) AS last_body_zh
  FROM customers c WHERE c.pending=1
  ORDER BY c.last_msg_at DESC
`);

/**
 * 左栏客户列表 = 界面上那句"新消息提醒"。排序规则（2026-09-26 按用户要求定）：
 *   ① 有未读的客户（红点）永远排最上面；
 *   ② 红点客户之间按 queue_since 升序 —— 先到的一条在最上、后到的往下排（越新越往下）；
 *      同一客户连发多条时 queue_since 不变，所以他的行位置不动（钉在第一次那条的位置）；
 *   ③ 其余（没有未读的）按最近消息时间倒序。
 *
 * ⚠️ is_self=1（账号主人自己那条）在这里被排掉 —— 见 prepareListStmt() 的说明。
 */
const listCustomers = prepareListStmt(`
  SELECT c.*,
         (SELECT body FROM messages m WHERE m.customer_code=c.code ORDER BY m.id DESC LIMIT 1)    AS last_body,
         (SELECT body_zh FROM messages m WHERE m.customer_code=c.code ORDER BY m.id DESC LIMIT 1) AS last_body_zh
  FROM customers c
  WHERE COALESCE(c.is_self, 0) <> 1
  ORDER BY (COALESCE(c.unread, 0) > 0) DESC,
           CASE WHEN COALESCE(c.unread, 0) > 0
                THEN COALESCE(c.queue_since, c.last_msg_at) END ASC,
           (c.last_msg_at IS NULL), c.last_msg_at DESC
`, `
  SELECT c.*,
         (SELECT body FROM messages m WHERE m.customer_code=c.code ORDER BY m.id DESC LIMIT 1)    AS last_body,
         (SELECT body_zh FROM messages m WHERE m.customer_code=c.code ORDER BY m.id DESC LIMIT 1) AS last_body_zh
  FROM customers c
  ORDER BY (COALESCE(c.unread, 0) > 0) DESC,
           CASE WHEN COALESCE(c.unread, 0) > 0
                THEN COALESCE(c.queue_since, c.last_msg_at) END ASC,
           (c.last_msg_at IS NULL), c.last_msg_at DESC
`);

/* ---------------- 消息 ---------------- */

const insertMessage = db.prepare(`
  INSERT OR IGNORE INTO messages
    (customer_code, account_id, direction, body, body_zh, media_path, media_src, media_type, media_fetch_state, wa_msg_id, msg_ts, created_at, msg_time)
  VALUES (@customer_code, @account_id, @direction, @body, @body_zh, @media_path, @media_src, @media_type, @media_fetch_state, @wa_msg_id, @msg_ts, @created_at, @msg_time)
`);

const setTranslation = db.prepare(`UPDATE messages SET body_zh=? WHERE id=?`);
const setTranslateState = db.prepare(`UPDATE messages SET translate_state=? WHERE id=?`);
/** 媒体说明（看图/听语音的中文结果） */
const setMediaZh = db.prepare(`UPDATE messages SET media_zh=? WHERE id=?`);

/*
 * 翻译 / 看图的重试账本（2026-09-30）
 * tries 只在"没翻出来"时 +1，翻成功或判定不用翻时清零 —— 这样"以前翻过、
 * 后来又失败"的消息不会带着旧账被永久放弃。
 */
const bumpTranslateTry = db.prepare(`UPDATE messages SET translate_tries = COALESCE(translate_tries,0) + 1 WHERE id=?`);
const resetTranslateTry = db.prepare(`UPDATE messages SET translate_tries = 0 WHERE id=?`);
const bumpMediaTry = db.prepare(`UPDATE messages SET media_tries = COALESCE(media_tries,0) + 1 WHERE id=?`);
const resetMediaTry = db.prepare(`UPDATE messages SET media_tries = 0 WHERE id=?`);
const getMessage = db.prepare(`SELECT * FROM messages WHERE id=?`);

/* 🔴 media_fetch_state / media_fetch_tries 这两列的 ensureColumn
   在本文件靠前处（和 translate_tries 一起）就加好了 —— 下面 insertMessage
   的 SQL 已经用到它们，加列必须排在所有 db.prepare 之前，
   否则 require db.js 的瞬间就报 "table messages has no column named media_fetch_state"。 */

/* ---------------------------------------------------------------------------
 * 版本历史（2026-10-07 v1.2.0 自动更新）
 *
 * 表和三个 prepare 已在文件靠前处建好，这里只包一层函数。
 * 🔴 失败的更新也记 —— 只记成功的话界面上会显示"上次更新于三个月前"，
 *   其实那次失败了，比不显示更误导。
 * --------------------------------------------------------------------------- */

/**
 * 记一笔版本历史。
 * @param {{version,channel,result,fromVersion,note}} o
 */
function logVersion(o = {}) {
  const res = insVersion.run({
    version: String(o.version || '').replace(/^v/i, ''),
    channel: o.channel || 'latest',
    result: o.result || 'ok',
    from_version: o.fromVersion || '',
    note: String(o.note || '').slice(0, 500),
    created_at: new Date().toISOString(),
  });
  return Number(res.lastInsertRowid) || 0;
}

/** 这个渠道最后一次更新记账（界面上"上次更新"用它） */
function getLastVersion(channel = 'latest') {
  return lastVersion.get({ channel }) || null;
}

/** 最近 n 条更新历史 */
function listVersionHistory(limit = 20) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  return listVersions.all({ limit: n });
}

// v2.5.1028：Tele 译文缓存相关函数（getTeleTranslations / saveTeleTranslations / insTeleTranslation）
// 已随中栏 Tele 标签与自动翻译功能取消而移除。


/** 重抓成功了：补上 media_path / media_src，并把状态钉成 done（不再重抓） */
const setMediaFetched = db.prepare(
  `UPDATE messages
      SET media_path=?, media_src=?, media_type=COALESCE(NULLIF(?,''), media_type),
          media_fetch_state='done', media_fetch_tries=COALESCE(media_fetch_tries,0)+1
    WHERE id=?`
);
/** 还没抓到：次数 +1，状态留pending（供下一轮重抓挑出来） */
const bumpMediaFetchTry = db.prepare(
  `UPDATE messages SET media_fetch_tries = COALESCE(media_fetch_tries,0)+1,
          media_fetch_state = CASE WHEN COALESCE(media_fetch_tries,0)+1 >= ? THEN 'fail' ELSE 'pending' END
    WHERE id=?`
);
/**
 * 客户发来的、还没抓到图的媒体消息，且重抓次数还够 —— 延时重抓就挑这些
 *
 * 🔴 2026-10-08：必须排除 channel='signal'。
 *
 * 原来这个查询会把 Signal 的 incoming 消息一起捞出来，然后 mediaFetch 拿
 * **WhatsApp 的浏览器客户端**去处理一个 wa_jid = 'sig:xxx' 的客户——
 * 那个客户根本不在任何 WhatsApp 会话里，必然抓不到，还会白烧一堆重试预算、
 * 在日志里刷一堆假失败。
 *
 * 判据用 channel='signal'（客户的渠道是权威字段，不靠 account_id 猜）。
 * 以后 Signal 附件解密做完了，这里改成"只捞已解密成功的"，而不是删掉这个条件。
 * （Signal 消息自己写的是 media_fetch_state='na'，双保险。）
 */
const listPendingMedia = db.prepare(
  `SELECT m.* FROM messages m
    LEFT JOIN customers c ON c.code = m.customer_code
    WHERE m.direction='in'
      AND IFNULL(c.channel,'whatsapp') NOT IN ('signal','whatsapp-web')
      AND (m.media_fetch_state='pending' OR (m.media_fetch_state='' AND m.media_src='none'))
      AND COALESCE(m.media_fetch_tries,0) < ?
      AND (m.media_type IN ('image','sticker','video','document','ptt','audio') OR m.media_src='none')
    ORDER BY m.id ASC LIMIT ?`
);
/** 一条都不剩了就把所有 pending 复位（新消息进来时唤醒）
 *  🔴 同样要排除 channel='signal' 和 'whatsapp-web' —— 否则每次唤醒都会把它们
 *     从'na' 改回 'pending'，又在各自的 listPending* 里被排除，来回折腾。*/
const resetPendingMedia = db.prepare(
  `UPDATE messages SET media_fetch_state='pending', media_fetch_tries=0
    WHERE direction='in' AND (media_fetch_state='fail' OR media_fetch_state='pending')
      AND customer_code IN (SELECT code FROM customers WHERE IFNULL(channel,'whatsapp') NOT IN ('signal','whatsapp-web'))`
);

/**
 * 🔴 内置 WA webview（WA①~⑤）待取图媒体：只挑 channel='whatsapp-web'，
 *    和外置 mediaFetch 用的 listPendingMedia **完全分开**（四模块红线）。
 *    外置那条已经把 whatsapp-web 排除掉了，这里反过来只收 whatsapp-web，
 *    两边永不交叉 —— 改一边绝不会牵动另一边。
 */
const listPendingWaWebMedia = db.prepare(
  `SELECT m.* FROM messages m
    LEFT JOIN customers c ON c.code = m.customer_code
    WHERE m.direction IN ('in','out')
      AND IFNULL(c.channel,'whatsapp') = 'whatsapp-web'
      AND (m.media_fetch_state='pending' OR (m.media_fetch_state='' AND m.media_src='none'))
      AND COALESCE(m.media_fetch_tries,0) < ?
      AND (m.media_type IN ('image','sticker','video','document','ptt','audio') OR m.media_src='none')
    ORDER BY m.id ASC LIMIT ?`
);

/** 把内置 WA 之前被标成 fail（试满 7 次）的媒体复活成 pending，给一次重抓机会
 *  （webview 刚启动/刚开那几拍没就绪就被算失败时会用到）。只动 whatsapp-web 渠道，绝不动别的模块。 */
const resetWaWebMediaFailed = db.prepare(
  `UPDATE messages SET media_fetch_state='pending', media_fetch_tries=0
   WHERE media_fetch_state='fail'
     AND customer_code IN (SELECT code FROM customers WHERE channel='whatsapp-web')`
);

/**
 * 保存一条消息，并同步客户的待处理状态
 * direction='in'  => 置为待处理
 * direction='out' => 自动清除待处理（已回复，提示消失）
 */
function saveMessage({ customerCode, accountId, direction, body, bodyZh, mediaPath, mediaSrc, mediaType, waMsgId, msgTs, silent, mediaFetchState, msgTime }) {
  const ts = msgTs || new Date().toISOString();
  const res = insertMessage.run({
    customer_code: customerCode,
    account_id: accountId,
    direction,
    body: body || null,
    body_zh: bodyZh || null,
    media_path: mediaPath || null,
    // 附件来源（download/base64/none）—— 界面上用不同标记区分"真图"和"临时救的"
    media_src: mediaSrc || '',
    // 真实媒体身份（image/sticker/video/audio/ptt/document）——贴纸不再被当成图片
    media_type: mediaType || '',
    /*
     * 2026-10-07 v1.1.0：客户发来的媒体消息**先标pending**，
     * 哪怕这一刻已经抓到图（saveMedia 拿到就直接done，见下面的 setMediaFetched）。
     * 这里是"没抓到"的那一半：directPath 还没到 → 交给延时重抓那一轮去补。
     * 自己发出去的不重抓（发出去时directPath 一定是有的，缺了也是本地问题）。
     *
     * 2026-10-08：调用方可以显式传 mediaFetchState 覆盖。
     * Signal 用它标 'na' —— Signal 附件的解密链路还没做，
     * 让纯文字消息标成 pending 会被 listPendingMedia 捞去重抓，
     * 拿 WhatsApp 客户端去处理一个 sig: 客户，纯属白费力气。
     */
    media_fetch_state: (mediaFetchState !== undefined && mediaFetchState !== null && mediaFetchState !== '')
      ? mediaFetchState
      : ((direction === 'in' && !mediaPath) ? 'pending' : ''),
    wa_msg_id: waMsgId || null,
    msg_ts: ts,
    // v2.6.1136：Telegram 专用 —— 正文尾部剥出来的显示时间（其余渠道恒为空字符串）
    msg_time: String(msgTime || ''),
    created_at: new Date().toISOString(),
  });

  // 历史同步时 silent=true：只入库，不改动待处理/未读（否则一登录就几十条待办）
  if (!silent) {
    if (direction === 'in') {
      markPending(customerCode, ts);
      bumpUnread(customerCode); // 未读 +1：同一个人连发多条，累计在这一格
    } else {
      // 我自己发出的消息（2026-09-26 用户改规则，重要）：
      //   【不再】自动清「待处理」—— 回复只是让底部「✓ 标记已回复」亮起来；
      //   真正"这条处理完了"要用户点「✓ 标记已回复 / ⏭ 跳过消息」才算数
      //   （那两个按钮才是唯一动作，点了左栏那一格才会收起来）。
      //   这里只清「未读」：都回了，当然算看过了。
      clearUnread(customerCode);
    }
  }

  return { id: res.lastInsertRowid, changes: res.changes };
}

/* 读的时候也把「空消息」挡在外面（2026-09-28）：
   既没文字又没图片语音的那些（撤回提示 / 加密提示 / 通话记录 / 表情回应）一律不显示。
   入库那头（src/main.js 的 messageText）已经拦了一道，这里是给历史遗留数据兜底。 */
const NOT_EMPTY = `(TRIM(COALESCE(body,''))<>'' OR TRIM(COALESCE(media_path,''))<>'')`;

const listMessages = db.prepare(
  `SELECT * FROM messages WHERE customer_code=? AND ${NOT_EMPTY} ORDER BY id ASC`
);

const recentMessages = db.prepare(
  `SELECT * FROM messages WHERE customer_code=? AND ${NOT_EMPTY} ORDER BY id DESC LIMIT ?`
);

/**
 * 某个账号「最近翻好的译文」——WA① 中文气泡的翻译记忆底料（2026-10-15 v2.6.1121）
 *
 * 只取 body / body_zh 两列，按 id 倒序。
 * 🔴 走 idx_messages_account_id，别改成 ORDER BY msg_ts（那个索引用不上，会退化成全表扫）。
 *
 * 气泡只认**原文 → 译文**这一层：同一句话翻过一次，之后网页上再看到同一句话
 * 直接贴回中文，0 次 AI 调用。
 */
const listRecentTranslations = db.prepare(
  `SELECT body, body_zh FROM messages
    WHERE account_id = ?
      AND body IS NOT NULL AND body <> ''
      AND body_zh IS NOT NULL AND body_zh <> ''
    ORDER BY id DESC LIMIT ?`
);

/**
 * WA① 中文气泡的翻译记忆底料（v2.6.1127 改版）：
 * 额外带 wa_msg_id，便于按「消息编号 mid」直接定位 —— emoji / 空格 / 标点差异全免疫。
 * 同一句原文会出现多条，取**最新**的那份译文（结果集是新→旧，所以先到先得）。
 */
const listRecentBubbleSources = db.prepare(
  `SELECT wa_msg_id, body, body_zh FROM messages
    WHERE account_id = ?
      AND body IS NOT NULL AND body <> ''
      AND body_zh IS NOT NULL AND body_zh <> ''
    ORDER BY id DESC LIMIT ?`
);

/* ---- 跨消息翻译记忆（2026-10-15 v2.6.1122）-----------------------------
 * 这本字典的所有读写都只走下面这几条语句，别的文件不许直接碰这张表
 * （业务规则统一收在 src/translationMemory.js 里，方便单独改、单独测）。
 */
/* v2.6.1149：大小写不敏感匹配（老板要求 Hello / hello、Hi / hi 视为同一句，字典里只留一行）。
 * 表结构不动（src_norm 的 UNIQUE 索引仍是 BINARY），只在**比较时**挂 COLLATE NOCASE：
 *   · tmGet 查得到 "hello" 那行 → 查 "Hello" / "HELLO" 都能命中；
 *   · tmHit / tmDelete 同理，只会动到同一行，不会各改各的。
 * LIMIT 1 是防御：万一老库里真有只差大小写的两行，也只取 id 最小的那行。 */
/** 按归一化原文查一条（大小写不敏感） */
const tmGet = db.prepare(`SELECT * FROM translation_memory WHERE src_norm=? COLLATE NOCASE LIMIT 1`);
/** 复用了一次：命中数 +1（用来算「省了几次 AI 调用」） */
const tmHit = db.prepare(`UPDATE translation_memory SET hits=hits+1, updated_at=? WHERE src_norm=? COLLATE NOCASE`);
/** 翻完写回：新句子插进去，已有则覆盖译文并把命中数 +1 */
const tmUpsert = db.prepare(
  `INSERT INTO translation_memory
     (src_norm, src_text, body_zh, provider, hits, src_len, created_at, updated_at)
   VALUES (@norm, @text, @zh, @provider, 0, @len, @at, @at)
   ON CONFLICT(src_norm) DO UPDATE SET
     body_zh=excluded.body_zh, provider=excluded.provider,
     hits=hits+1, updated_at=excluded.updated_at`
);
/** 回填用：只补空缺，不覆盖已有译文、也不误加命中数 */
const tmSeed = db.prepare(
  `INSERT OR IGNORE INTO translation_memory
     (src_norm, src_text, body_zh, provider, hits, src_len, created_at, updated_at)
   VALUES (@norm, @text, @zh, '', 0, @len, @at, @at)`
);
/** 统计：记了多少条、一共省了多少次调用 */
const tmCount = db.prepare(
  `SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS hits FROM translation_memory`
);
/** 排障/展示：被复用得最多的几句 */
const tmTop = db.prepare(
  `SELECT src_text, body_zh, hits FROM translation_memory ORDER BY hits DESC LIMIT ?`
);
/* ---- v2.6.1148：词典准入（规则筛 + AI 复核） ----
 * 不合格的原文记进 translation_reject，同一句不再反复问 AI。
 * 清理脚本（tools/tm_cleanup.js）用 tmAllTexts / tmDelete，别的地方别直接用。
 */
/** 这句是不是已经被判过「不收」 */
const tmRejectGet = db.prepare(`SELECT 1 AS x FROM translation_reject WHERE src_norm=? LIMIT 1`);
/** 记一笔「不收」 */
const tmRejectPut = db.prepare(
  `INSERT OR REPLACE INTO translation_reject (src_norm, reason, at) VALUES (?,?,?)`
);
/** 清理：删掉某条 */
const tmDelete = db.prepare(`DELETE FROM translation_memory WHERE src_norm=? COLLATE NOCASE`);
/** 清理：取全部（含 id，便于出报告） */
const tmAllTexts = db.prepare(
  `SELECT id, src_norm, src_text, body_zh FROM translation_memory ORDER BY id`
);
/** 回填源：库里所有已经翻好的消息（不分账号、不分方向，新→旧） */
const listAllTranslations = db.prepare(
  `SELECT body, body_zh FROM messages
    WHERE body IS NOT NULL AND body <> ''
      AND body_zh IS NOT NULL AND body_zh <> ''
    ORDER BY id DESC LIMIT ?`
);

/* ---- 跨消息翻译记忆 · 后台同步（2026-10-15 v2.6.1127）----------------------
 * 设计：字典小（几十→几千句），全量对账最稳，不做增量标记。
 *   · tmAll            —— 取本地全部行，关闭时整包推给后台（后台 upsert 去重）。
 *   · tmUpsertFromCloud —— 登录时从后台拉回，只补空缺（INSERT OR IGNORE），
 *                          绝不覆盖本地已有的译文（本地可能比后台新）。
 * 这两条只给 src/tmCloud.js 用；翻译记忆的常规读写仍只走上面的 tm*。
 */
/** 取本地全部翻译记忆（推送用） */
const tmAll = db.prepare(
  `SELECT src_norm, src_text, body_zh, provider, hits, src_len, created_at, updated_at
   FROM translation_memory ORDER BY id`
);
/** 从后台拉回时写入：只补空缺，不覆盖本地已有 */
const tmUpsertFromCloud = db.prepare(
  `INSERT OR IGNORE INTO translation_memory
     (src_norm, src_text, body_zh, provider, hits, src_len, created_at, updated_at)
   VALUES (@norm, @text, @zh, @provider, @hits, @len, @at, @at)`
);

/* 窗口化取消息（2026-09-30 加，方案 C：默认只渲染最近 N 条，往上滚再加载更早的）
   before：取 id < before 的更早一批（DESC，调用方自己 reverse 成 ASC 便于往前插）
   after ：取 id > after 的更新一批（ASC，便于往后追加） */
const messagesBefore = db.prepare(
  `SELECT * FROM messages WHERE customer_code=? AND ${NOT_EMPTY} AND id < ? ORDER BY id DESC LIMIT ?`
);
const messagesAfter = db.prepare(
  `SELECT * FROM messages WHERE customer_code=? AND ${NOT_EMPTY} AND id > ? ORDER BY id ASC LIMIT ?`
);
const countMessagesBefore = db.prepare(
  `SELECT COUNT(*) AS n FROM messages WHERE customer_code=? AND ${NOT_EMPTY} AND id < ?`
);
const countMessagesAfter = db.prepare(
  `SELECT COUNT(*) AS n FROM messages WHERE customer_code=? AND ${NOT_EMPTY} AND id > ?`
);

/**
 * 这位客户最近几条**来信**的文字，拼成一段（2026-09-29 加）。
 * 用途：LID 会话问不到真号码时，从客户自己打出来的字里找电话（identity.phoneFromText）。
 * 只取 in（客户发来的），自己发的不算 —— 免得把我自己打出去的号码当客户的。
 */
function recentInboundText(code, limit = 5) {
  try {
    const rows = db
      .prepare(
        `SELECT body FROM messages
          WHERE customer_code=? AND direction='in' AND TRIM(COALESCE(body,''))<>''
          ORDER BY id DESC LIMIT ?`,
      )
      .all(code, Math.max(1, Math.min(50, Number(limit) || 5)));
    return rows.map((r) => r.body).join('\n');
  } catch (e) {
    return '';
  }
}

/* ---------------- 跨账号查重 ---------------- */

const findByPhone = db.prepare(
  `SELECT * FROM customers WHERE phone=? AND code<>?`
);

/** 同一个手机号出现在多个账号下，返回疑似重复列表 */
function findPossibleDuplicates(code) {
  const c = getCustomer.get(code);
  if (!c || !c.phone) return [];
  return findByPhone.all(c.phone, code);
}

/* ---------------- 建议 ---------------- */

const insertSuggestion = db.prepare(`
  INSERT INTO suggestions (customer_code, message_id, model, options_json, rationale, risk_flags, created_at)
  VALUES (@customer_code, @message_id, @model, @options_json, @rationale, @risk_flags, @created_at)
`);

/* ---------------- 模拟数据（测试用，2026-09-25） ----------------
 *
 * 「模拟新消息」造出来的客户 is_sim=1。清空时只删这些，
 * 真实客户一条都不碰。
 */

const listSimCustomers = db.prepare(
  `SELECT code, name, wa_jid FROM customers WHERE COALESCE(is_sim,0)=1`
);

/**
 * 清空所有模拟客户及其消息 / 建议。
 * @returns {{customers:number, messages:number}}
 */
function clearSimulated() {
  const rows = listSimCustomers.all();
  if (!rows.length) return { customers: 0, messages: 0 };

  const delMsg = db.prepare(`DELETE FROM messages WHERE customer_code=?`);
  const delSug = db.prepare(`DELETE FROM suggestions WHERE customer_code=?`);
  const delCus = db.prepare(`DELETE FROM customers WHERE code=?`);
  let messages = 0;
  for (const r of rows) {
    try { messages += delMsg.run(r.code).changes; } catch (e) { /* 忽略 */ }
    try { delSug.run(r.code); } catch (e) { /* 忽略 */ }
    try { delCus.run(r.code); } catch (e) { /* 忽略 */ }
  }
  return { customers: rows.length, messages };
}

/** 现在库里有几个模拟客户（界面上给个数，方便确认清干净了没） */
function countSimulated() {
  try {
    return listSimCustomers.all().length;
  } catch (e) {
    return 0;
  }
}

/* 启动时把库里已有客户的手机号回填进编号库（首次运行 / 升级时一次性补齐）。
   这样老客户的手机号也能立刻走"查表复用"，不用等下次新消息触发。 */
(function backfillNumberLibrary() {
  try {
    numberLibrary.backfillFromDb(() => {
      try {
        return db.prepare('SELECT code, phone FROM customers').all();
      } catch (e) {
        return [];
      }
    });
  } catch (e) {
    /* 填不动也不影响主流程 */
  }
})();

module.exports = {
  db,
  driver: handle.driver,
  // v2.6.1136：把「补列」能力导出，Telegram 合并模块（src/telegramMerge.js）要用它加
  // voided / void_note 两列 —— 各归各的文件，不把 Telegram 的列定义塞进本文件
  ensureColumn,
  ids,
  upsertAccount,
  setAccountStatus,
  listAccounts,
  getOrCreateCustomer,
  updateCustomer,
  setJoinedAt,
  getCustomer,
  findCustomerByTgPeer,
  tgPeerByCode,
  markPending,
  clearPending,
  markProcessed,
  repliedLast,
  countUnprocessed,
  statsToday,
  todayMessages,
  tgConversations,
  tgMessages,
  bumpUnread,
  clearUnread,
  totalUnread,
  listPending,
  listCustomers,
  saveMessage,
  saveTgUsername,
  backfillIdentity,
  applyRegrab,
  phoneSrcRank,
  listMissingIdentity,
  purgeEmptyMessages,
  clearLidPhones,
  setTranslation,
  setTranslateState,
  setMediaZh,
  bumpTranslateTry,
  resetTranslateTry,
  bumpMediaTry,
  resetMediaTry,
  getMessage,
  setMediaFetched,
  bumpMediaFetchTry,
  listPendingMedia,
  listPendingWaWebMedia,
  resetWaWebMediaFailed,
  resetPendingMedia,
  listMessages,
  recentMessages,
  listRecentTranslations,
  listRecentBubbleSources,
  // v2.6.1122 跨消息翻译记忆（只经 src/translationMemory.js 对外，别处不许直接写这张表）
  tmGet,
  tmHit,
  tmUpsert,
  tmSeed,
  tmCount,
  tmTop,
  tmAll,
  tmUpsertFromCloud,
  // v2.6.1148：词典准入（规则筛 + AI 复核）+ 清理脚本专用
  tmRejectGet,
  tmRejectPut,
  tmDelete,
  tmAllTexts,
  listAllTranslations,
  messagesBefore,
  messagesAfter,
  countMessagesBefore,
  countMessagesAfter,
  recentInboundText,
  findPossibleDuplicates,
  phoneOwnerOf,        // v2.6.1095：号码查重守门（自动取号写库前必过）
  lastPhoneDuplicate,  // v2.6.1095：最近一次"因重复被拒写"的记录（排查用）
  insertSuggestion,
  clearSimulated,
  countSimulated,
  logVersion,
  getLastVersion,
  listVersionHistory,
  addScanLog,
  listScanLogs,
  countScanLogs,
};
