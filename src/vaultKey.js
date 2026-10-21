/**
 * 客户端密钥库加密（蜜蜂信息采集 · 集中托管 API key）
 * ------------------------------------------------------------------
 * 设计（D 方案 + 三项 A 默认）：
 *   · 管理入口 = 桌面「AI 设置 / 云端」页的「同步 AI 设置」按钮（非网页后台表单）；
 *   · 云端（wa-cloud）只存【密文】：客户端用内置 VAULT_KEY 做 AES-256-GCM 加密后 PUT，
 *     云端绝不持有明文、也绝不解密；
 *   · 会员拉到密文 → 用同一把 VAULT_KEY 解开 → 把明文 key 再用 DPAPI 加密落盘（双保险）；
 *   · 冲突以云端为准（拉取覆盖本地）；
 *   · 拉取 = 启动自动 + 手动按钮。
 *
 * 安全边界（诚实说明）：VAULT_KEY 是写死在客户端二进制里的「共享密钥」，
 * 它能保证【云端 / 备份 / 截图】泄露时别人看不到 key 明文；但拿到本软件二进制的
 * 人也能解出 key（运行态从内存抠 key 同样防不住）。本模块只负责把"云端存密文"
 * 这件事做扎实，让后台运维 / 数据库导出都不暴露 key。
 *
 * 算法：AES-256-GCM，IV 12 字节随机，authTag 16 字节；输出 = base64(iv | tag | ct)。
 */

const crypto = require('crypto');

// 🔴 内置密钥（32 字节，base64）。改这一行 = 让所有旧密文失效，需重新同步一次。
const VAULT_KEY = Buffer.from('rtkMQTTcghS7aJtyMOdef830omhLGwtEnbU4PQIfsSA=', 'base64');
if (VAULT_KEY.length !== 32) throw new Error('VAULT_KEY 必须是 32 字节');

/** 把任意 JS 对象密封成密文串（base64）。 */
function seal(obj) {
  if (obj === undefined) obj = null;
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** 把密文串解开回 JS 对象。密钥错 / 被篡改 → 抛错（GCM 验证失败）。 */
function unseal(b64) {
  if (!b64 || typeof b64 !== 'string') throw new Error('VAULT_EMPTY');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('VAULT_MALFORMED');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { seal, unseal, VAULT_KEY_LEN: VAULT_KEY.length };
