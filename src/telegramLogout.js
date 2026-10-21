/**
 * telegramLogout.js — Telegram 账号「登出」（v2.6.1137）
 *
 * 起因：老板 2026-10-16 看图点名
 *   「软件版的 Tele① 标签有登录，也需要有个登出的功能，我如果要换账号，
 *     Tele② 标签里没有登录的入口，这个是另一个账号的登录」。
 *
 * 🔴 老板拍板的范围（A 方案，2026-10-16）——只做「清本软件的会话凭证」：
 *   ① 停掉这个号的 MTProto 采集（断开连接 + 清 20 秒未读轮询）；
 *   ② 把 telegram-session-<id>.txt **先备份**成 .bak-<时间戳> 再删掉。
 *   就这两件。**不做**的：
 *     · 不删这个号已经采到的客户档案 / 消息（那是数据，不是登录态）；
 *     · 不关这个号的外部 Chrome 窗口（TG-PCn-CDP）；
 *     · 不清外部浏览器的登录态（TG-PCn-CDP profile）；
 *     · 不碰别的 Telegram 号，更不碰 WA / Signal / WA①~⑤。
 *
 * 🔴 这个文件只服务 Telegram。别把它抽成「通用登出」给别的渠道复用
 *    （老板 2026-10-16 明确：每种抓取方式不同，不允许合在一起）。
 *
 * 🔴 与 telegramRead / telegramMerge 一样，走「依赖注入」：
 *    stopAccount / sessionPath 由 telegramMtproto 提供（在 main.js 里接），
 *    本文件不直接 require 它 —— 好处是离线单测能塞假实现，不连 Telegram 也能验。
 */

'use strict';

const fs = require('fs');

/** 时间戳 20261016-101530 */
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 建一个登出控制器。
 * @param {object} o
 *   - stopAccount(id)  telegramMtproto 的「只停一个号」
 *   - sessionPath(dataDir, id)  telegramMtproto 的会话文件路径（唯一来源，别在别处再写一份）
 */
function createController({ stopAccount, sessionPath } = {}) {
  const stopOne = typeof stopAccount === 'function'
    ? stopAccount
    : () => ({ ok: true, stopped: false, error: '' });
  const pathOf = typeof sessionPath === 'function'
    ? sessionPath
    : (dataDir, id) => `${dataDir}\\telegram-session-${id}.txt`;

  /**
   * 登出某个 Telegram 账号。
   * @param {object} o
   *   - accountId Telegram 账号 id（7 / 8 / 9）
   *   - dataDir   会话文件所在目录（与数据库同目录）
   * @returns {Promise<{ok:boolean, accountId:number, stopped:boolean,
   *                    sessionRemoved:boolean, backup:string, error:string}>}
   */
  async function logout({ accountId, dataDir } = {}) {
    const out = { ok: true, accountId: Number(accountId) || 0, stopped: false, sessionRemoved: false, backup: '', error: '' };
    if (!out.accountId) { out.ok = false; out.error = '缺少 Telegram 账号 id'; return out; }

    // ① 先断连：否则删了凭证之后这个号还在用内存里的会话继续收消息
    let r;
    try {
      r = await stopOne(out.accountId);
    } catch (e) {
      r = { ok: false, stopped: false, error: (e && e.message) || String(e) };
    }
    out.stopped = !!(r && r.stopped);
    // 没在采（本来就没连）不算失败；真报错才拦下来
    if (r && r.ok === false && r.error) {
      out.ok = false;
      out.error = `停止采集失败：${r.error}`;
      return out;
    }

    // ② 清凭证：删之前一定先备份（老板铁律：删东西先留后路）
    let p;
    try {
      p = pathOf(dataDir, out.accountId);
    } catch (e) {
      out.ok = false;
      out.error = `算不出会话文件路径：${(e && e.message) || e}`;
      return out;
    }
    let exists = false;
    try { exists = fs.existsSync(p); } catch (e) { exists = false; }
    if (!exists) return out; // 本来就没凭证 —— 已经等于登出，算成功

    try {
      const bak = `${p}.bak-${stamp(new Date())}`;
      fs.copyFileSync(p, bak);
      out.backup = bak;
      fs.unlinkSync(p);
      out.sessionRemoved = true;
    } catch (e) {
      out.ok = false;
      out.error = `删除会话文件失败：${(e && e.message) || e}`;
      return out;
    }
    return out;
  }

  return { logout };
}

module.exports = { createController, stamp };
