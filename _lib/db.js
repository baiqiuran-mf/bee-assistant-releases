/**
 * 本地数据库层（SQLite）
 *
 * 设计要点：
 *   - customers.code 是业务主键（1A00001），一经分配永不回收
 *   - 唯一性按 (account_id, wa_jid)，同一个人加你多个号 => 多个编号，可关联查重
 *   - pending=1 表示有待处理消息，界面红点；发出消息或点"已回复"后自动归零
 */

const path = require('path');
const fs = require('fs');
const ids = require('./ids');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
  stage_day     INTEGER DEFAULT 0,
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
  media_path    TEXT,
  wa_msg_id     TEXT UNIQUE,
  msg_ts        TEXT,
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_code);
CREATE INDEX IF NOT EXISTS idx_messages_ts       ON messages(msg_ts);

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
`);

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
  `SELECT * FROM customers WHERE account_id=? AND wa_jid=?`
);

const maxCodeOfAccount = db.prepare(
  `SELECT code FROM customers WHERE account_id=? ORDER BY code DESC LIMIT 1`
);

const insertCustomer = db.prepare(`
  INSERT INTO customers (code, account_id, wa_jid, phone, name, created_at)
  VALUES (@code, @account_id, @wa_jid, @phone, @name, @created_at)
`);

/**
 * 取客户；不存在则按规则分配新编号
 * @returns {{customer: object, isNew: boolean}}
 */
function getOrCreateCustomer(accountId, waJid, info = {}) {
  const existed = findCustomer.get(accountId, waJid);
  if (existed) return { customer: existed, isNew: false };

  const last = maxCodeOfAccount.get(accountId);
  const code = ids.nextCustomerCode(accountId, last ? last.code : null);
  const now = new Date().toISOString();

  const row = {
    code,
    account_id: accountId,
    wa_jid: waJid,
    phone: info.phone || (waJid || '').split('@')[0] || null,
    name: info.name || null,
    created_at: now,
  };
  insertCustomer.run(row);
  return { customer: findCustomer.get(accountId, waJid), isNew: true };
}

const updateCustomer = db.prepare(`
  UPDATE customers SET
    name      = COALESCE(@name, name),
    region    = COALESCE(@region, region),
    timezone  = COALESCE(@timezone, timezone),
    stage_day = COALESCE(@stage_day, stage_day),
    mood      = COALESCE(@mood, mood),
    summary   = COALESCE(@summary, summary),
    profile_json = COALESCE(@profile_json, profile_json)
  WHERE code = @code
`);

const getCustomer = db.prepare(`SELECT * FROM customers WHERE code=?`);

/* ---------------- 待处理状态 ---------------- */

const setPending = db.prepare(
  `UPDATE customers SET pending=?, last_msg_at=? WHERE code=?`
);

/** 收到客户消息 -> 置为待处理 */
function markPending(code, ts) {
  setPending.run(1, ts || new Date().toISOString(), code);
}

/** 我回复了 / 手动点已回复 -> 清除待处理（提示窗口消失） */
function clearPending(code) {
  setPending.run(0, new Date().toISOString(), code);
}

const listPending = db.prepare(`
  SELECT c.*, (SELECT body FROM messages m WHERE m.customer_code=c.code
               ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT body_zh FROM messages m WHERE m.customer_code=c.code
               ORDER BY m.id DESC LIMIT 1) AS last_body_zh
  FROM customers c WHERE c.pending=1
  ORDER BY c.last_msg_at DESC
`);

/* ---------------- 消息 ---------------- */

const insertMessage = db.prepare(`
  INSERT OR IGNORE INTO messages
    (customer_code, account_id, direction, body, body_zh, media_path, wa_msg_id, msg_ts, created_at)
  VALUES (@customer_code, @account_id, @direction, @body, @body_zh, @media_path, @wa_msg_id, @msg_ts, @created_at)
`);

const setTranslation = db.prepare(`UPDATE messages SET body_zh=? WHERE id=?`);

/**
 * 保存一条消息，并同步客户的待处理状态
 * direction='in'  => 置为待处理
 * direction='out' => 自动清除待处理（已回复，提示消失）
 */
function saveMessage({ customerCode, accountId, direction, body, bodyZh, mediaPath, waMsgId, msgTs, silent }) {
  const ts = msgTs || new Date().toISOString();
  const res = insertMessage.run({
    customer_code: customerCode,
    account_id: accountId,
    direction,
    body: body || null,
    body_zh: bodyZh || null,
    media_path: mediaPath || null,
    wa_msg_id: waMsgId || null,
    msg_ts: ts,
    created_at: new Date().toISOString(),
  });

  // 历史同步时 silent=true：只入库，不改动待处理状态（否则一登录就几十条待办）
  if (!silent) {
    if (direction === 'in') markPending(customerCode, ts);
    else clearPending(customerCode);
  }

  return { id: res.lastInsertRowid, changes: res.changes };
}

const listMessages = db.prepare(
  `SELECT * FROM messages WHERE customer_code=? ORDER BY id ASC`
);

const recentMessages = db.prepare(
  `SELECT * FROM messages WHERE customer_code=? ORDER BY id DESC LIMIT ?`
);

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

module.exports = {
  db,
  driver: handle.driver,
  ids,
  upsertAccount,
  setAccountStatus,
  listAccounts,
  getOrCreateCustomer,
  updateCustomer,
  getCustomer,
  markPending,
  clearPending,
  listPending,
  saveMessage,
  setTranslation,
  listMessages,
  recentMessages,
  findPossibleDuplicates,
  insertSuggestion,
};
