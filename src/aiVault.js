/**
 * 集中托管 API key · 客户端编排（蜜蜂信息采集 v2.6.115x）
 * ------------------------------------------------------------------
 * 职责：把「云端只存密文」这件事在客户端落地。
 *   管理员：把自己 config.yaml 里的 AI 密钥 → VAULT_KEY 加密 → PUT 云端（pushCurrent）
 *   会员：从云端拉密文 → VAULT_KEY 解密 → 明文 key 用 DPAPI 再加密落盘（双保险）
 *        → 注入到内存里的 ai 配置（applyVaultToConfig），软件立刻能用了
 *
 * 铁律（D 方案 + 三项 A 默认）：
 *   · 云端绝不持有明文（加密在客户端，VAULT_KEY 写死在二进制里）；
 *   · 本地落盘再套一层 DPAPI（Windows 用户绑定），即便本机文件/备份泄露也看不到 key；
 *   · 冲突以云端为准（pullAndApply 覆盖本地内存配置）；
 *   · 拉取 = 启动自动（applyLocalCache + pullAndApply）+ 手动「同步 AI 设置」按钮。
 *
 * 退化：非 Windows / PowerShell 不可用 → DPAPI 这层跳过，本地只存 VAULT_KEY 密文
 *       （仍是加密态，只是少了一层 OS 用户绑定；云端那层不变）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const vaultKey = require('./vaultKey');
const dpapi = require('./dpapi');
const ai = require('./ai');
const cloud = require('./cloud');

const VAULT_FILE = path.join(paths.DATA_ROOT, 'cloud', 'vault.json');

function ensureDir() {
  const dir = path.dirname(VAULT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ---------------- 本地密钥库（DPAPI 加密落盘，双保险） ---------------- */

/** 把明文对象写成「VAULT_KEY 密文 + DPAPI 外层」存本地。 */
function writeLocalVault(plainObj) {
  ensureDir();
  const sealedB64 = vaultKey.seal(plainObj);     // 第一层：VAULT_KEY（云端同款）
  // 🔴 存的是「密文的 base64 字符串」本身（utf8 字节）：
  //   · DPAPI 模式 → 加密这串字符串的字节，读时解开得到同一串 base64；
  //   · 退化模式 → 直接把这串 base64 当文本落盘，读时原样取回。
  // 绝不能把 Buffer.from(sealedB64,'base64')（已解码的二进制）写进去再当字符串读，会损坏。
  const raw = Buffer.from(sealedB64, 'utf8');
  let toWrite = raw;
  if (dpapi.powershellWorks()) {                  // 第二层：DPAPI（Windows 用户绑定）
    try { toWrite = dpapi.dpapiProtect(raw); }
    catch (e) { toWrite = raw; }                  // 退化：只用 VAULT_KEY 那层
  }
  fs.writeFileSync(VAULT_FILE, toWrite);
}

/** 读回本地密钥库 → 解密成明文对象；没有 / 损坏 → null。 */
function readLocalVault() {
  if (!fs.existsSync(VAULT_FILE)) return null;
  const buf = fs.readFileSync(VAULT_FILE);
  let sealedB64;
  if (dpapi.powershellWorks()) {
    try { sealedB64 = dpapi.dpapiUnprotectRaw(buf).toString('utf8'); }
    catch (e) { sealedB64 = buf.toString('utf8'); }   // 退化路径：本就只存了 VAULT_KEY 密文
  } else {
    sealedB64 = buf.toString('utf8');
  }
  return vaultKey.unseal(sealedB64);              // 失败（密钥错 / 被改）→ 抛错，由调用方忽略
}

/* ---------------- 把密钥库并到内存里的 ai 配置 ---------------- */

/**
 * 把密钥库里的 providers / tasks 覆盖进 cfg.ai（云端为准）。
 * 🔴 只改内存配置、不回写 config.yaml —— config.yaml 仍是会员自己的手动兜底，
 *    密钥库的真相存在本地 DPAPI 文件 + 云端，不在 config.yaml。
 */
function applyVaultToConfig(plainObj, cfg) {
  if (!plainObj) return false;
  cfg.ai = cfg.ai || {};
  cfg.ai.providers = cfg.ai.providers || {};
  cfg.ai.tasks = cfg.ai.tasks || {};
  for (const [name, pv] of Object.entries(plainObj.providers || {})) {
    if (!pv) continue;
    cfg.ai.providers[name] = Object.assign({}, cfg.ai.providers[name], pv);
  }
  for (const [name, tv] of Object.entries(plainObj.tasks || {})) {
    if (!tv) continue;
    cfg.ai.tasks[name] = Object.assign({}, cfg.ai.tasks[name], tv);
  }
  ai.setAiConfig(cfg.ai);
  return true;
}

/** 把当前内存/磁盘的 ai 配置收敛成可密封的密钥库对象（只挑密钥相关字段）。 */
function configToVaultObj(cfg) {
  const a = cfg.ai || {};
  const providers = {};
  for (const [name, pv] of Object.entries(a.providers || {})) {
    if (!pv) continue;
    providers[name] = { baseUrl: pv.baseUrl || '', apiKey: pv.apiKey || '', model: pv.model || '' };
  }
  const tasks = {};
  for (const [name, tv] of Object.entries(a.tasks || {})) {
    if (!tv) continue;
    tasks[name] = { provider: tv.provider || '', model: tv.model || '', fallback: tv.fallback || '' };
  }
  return { providers, tasks };
}

/* ---------------- 启动 / 手动 拉取 ---------------- */

/** 启动阶段：先把本地密钥库灌进内存（离线也能用），云端拉取在后面另跑。 */
async function applyLocalCache(cfg) {
  try {
    const plain = readLocalVault();
    if (plain) { applyVaultToConfig(plain, cfg); return { applied: true }; }
  } catch (e) { /* 本地密钥库损坏就忽略，等云端拉取覆盖 */ }
  return { applied: false };
}

/**
 * 从云端拉密文 → 解开 → 落本地 DPAPI → 注入内存（云端为准）。
 * @returns {{ok:boolean, empty?:boolean, providers?:string[], error?:string}}
 */
async function pullAndApply(cfg) {
  const vault = await cloud.pullSettings();     // 未登录会抛错，由调用方 catch
  if (!vault) return { ok: false, empty: true };
  const plain = vaultKey.unseal(vault);
  writeLocalVault(plain);                        // 双保险：同步落本地
  applyVaultToConfig(plain, cfg);
  return { ok: true, providers: Object.keys(plain.providers || {}) };
}

/**
 * 管理员把当前 AI 配置（密钥）密封后推上云端。后端只会让 admin 写。
 * @returns {{ok:boolean, updatedAt?:string, error?:string}}
 */
async function pushCurrent(cfg) {
  const obj = configToVaultObj(cfg);
  const vault = vaultKey.seal(obj);
  // 构建「元数据」：只回传接入地址 / 模型名 / Key 的单向哈希掩码（sha256 前 8 位十六进制），
  // 绝不含明文 key。后台「AI 模型设置」只读展示这些，云端 DB 也不存明文。
  const a = cfg.ai || {};
  const catalog = ai.PROVIDER_CATALOG || [];
  const meta = catalog.map((p) => {
    const name = p.key;
    const pv = (a.providers && a.providers[name]) || {};
    const apiKey = pv.apiKey || '';
    const keyMask = apiKey ? crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8) : null;
    return {
      key: name,
      cn: p.cn || name,
      baseUrl: pv.baseUrl || '',
      model: pv.model || '',
      keyMask,
    };
  });
  const r = await cloud.pushSettings(vault, meta);
  return { ok: !!r.ok, updatedAt: r.updatedAt || null };
}

/** 本地密钥库状态（界面展示用）：是否已有本地缓存、当前哪些服务商有 key。 */
function vaultStatus() {
  const a = ai.loadAiConfig();
  const providers = [];
  for (const [name, pv] of Object.entries(a.providers || {})) {
    if (pv && pv.apiKey) providers.push(name);
  }
  return { hasLocalCache: fs.existsSync(VAULT_FILE), providers };
}

module.exports = {
  writeLocalVault,
  readLocalVault,
  applyVaultToConfig,
  configToVaultObj,
  applyLocalCache,
  pullAndApply,
  pushCurrent,
  vaultStatus,
  VAULT_FILE,
};
