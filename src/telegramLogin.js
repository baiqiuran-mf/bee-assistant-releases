/**
 * telegramLogin.js — Telegram 应用内登录控制器（v2.5.1054 起）
 *
 * 背景：v2.5.1053 把 Telegram 采集从 web.telegram.org 爬虫换成官方 MTProto 协议
 * （teleproto 库）。MTProto 登录需要手机号 + 验证码（+ 可能的两步验证密码），
 * 这一步必须在软件里完成（老板拍板：做应用内登录弹窗，不装 node、不跑脚本）。
 *
 * 本模块把 teleproto 的「交互式登录」和前端的分步输入对接起来：
 *   - client.start({ phoneNumber, phoneCode, password }) 的回调是异步函数，
 *     我们用「deferred promise」把它们挂起，等前端把手机号/验证码/密码
 *     通过 server.js 的 POST 接口传进来，再 resolve 对应的 promise。
 *   - 每一步状态都通过 onState 回调广播（server.js 走 SSE → 前端弹窗跟着走）。
 *   - 登录成功 → 会话串落盘 → 调 onAdopt(client) 让 telegramMtproto 接管消息接收。
 *
 * 🔴 铁律延续：本模块只做「登录授权 + 读取接管」，绝不调用 sendMessage。
 *   发送仍走浏览器预填（telegramRead.openOrFocus）。
 */

'use strict';

const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { parseProxy, saveSession } = require('./telegramMtproto');

/**
 * 创建一个登录控制器实例。
 * @param {object} o
 *   - cfg: 全局配置（需 cfg.telegram.apiId / apiHash / proxy）
 *   - dataDir: 会话文件落盘目录（与数据库同处）
 *   - onState(st): 状态变更回调，st = { accountId, status, step, message, ... }
 *   - onAdopt(acc, client): 登录成功后接管客户端（由 main.js 接 telegramMtproto.adoptLoggedInClient）
 */
function createController({ cfg, dataDir, onState, onAdopt } = {}) {
  const tgCfg = (cfg && cfg.telegram) || {};
  const apiId = parseInt(tgCfg.apiId, 10);
  const apiHash = tgCfg.apiHash || '';

  let active = null; // { accountId, client, def, acc }

  function makeDeferred() {
    let resolve, reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { p, resolve, reject };
  }

  function emit(st) {
    if (typeof onState === 'function') {
      try { onState(st); } catch (e) { /* ignore */ }
    }
  }

  /**
   * 开始登录某个账号。
   * @param {number} accountId Telegram 账号 id（来自 cfg.telegram.accounts，如 7）
   * @param {object} acc 该账号配置（需含 id / proxy 等）
   */
  async function start(accountId, acc) {
    // 上一次没走完先清掉，避免两个登录搅在一起
    if (active) { try { await cancel(); } catch (e) { /* ignore */ } }

    if (!apiId || !apiHash) {
      emit({
        accountId, status: 'error', step: 'config',
        message: 'config.yaml 的 telegram.apiId / apiHash 还没填：先去 https://my.telegram.org → API development tools 创建应用，把值填进 config.yaml，再点登录。',
      });
      return { ok: false, message: '缺少 apiId/apiHash' };
    }

    const proxy = parseProxy((acc && acc.proxy) || tgCfg.proxy) || undefined;
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 5,
      proxy,
    });

    const def = { phone: makeDeferred(), code: makeDeferred(), password: makeDeferred() };
    active = { accountId, client, def, acc, done: false };

    emit({ accountId, status: 'starting', step: 'connect', message: '正在连接 Telegram…' });

    // client.start 内部会：connect → checkAuthorization → sendCode → 按需要两步密码。
    // 三个回调都返回 deferred.promise，等前端把对应输入传进来再 resolve。
    client.start({
      phoneNumber: async () => {
        emit({ accountId, status: 'await_input', step: 'phone', message: '请输入手机号（含国家码，例如 +8613800138000）' });
        return def.phone.p;
      },
      phoneCode: async (isApp, info) => {
        const delivery = info && info.type ? `（通过 ${info.type} 发送）` : '';
        emit({ accountId, status: 'await_input', step: 'code', message: `请输入 Telegram 发来的登录验证码${delivery}` });
        return def.code.p;
      },
      password: async (hint) => {
        emit({
          accountId, status: 'await_input', step: 'password',
          message: hint ? `请输入两步验证密码（提示：${hint}）` : '请输入两步验证密码',
        });
        return def.password.p;
      },
      onError: (err) => {
        emit({ accountId, status: 'error', step: 'signin', message: (err && err.message) || String(err) });
      },
    }).then(async () => {
      const str = client.session.save();
      if (str) saveSession(dataDir, accountId, str);
      emit({ accountId, status: 'success', step: 'done', message: '登录成功，正在接管消息接收…' });
      try {
        if (acc && typeof onAdopt === 'function') await onAdopt(acc, client);
      } catch (e) {
        emit({ accountId, status: 'error', step: 'adopt', message: `接管失败：${(e && e.message) || String(e)}` });
      }
      active = null;
    }).catch((err) => {
      emit({ accountId, status: 'error', step: 'signin', message: (err && err.message) || String(err) });
      try { client.disconnect(); } catch (e) { /* ignore */ }
      active = null;
    });

    return { ok: true, accountId };
  }

  /** 提交某一步输入（step ∈ phone|code|password） */
  function submit(step, value) {
    if (!active) return { ok: false, message: '当前没有进行中的登录' };
    const d = active.def[step];
    if (!d) return { ok: false, message: `当前不在等待「${step}」` };
    d.resolve(String(value == null ? '' : value).trim());
    return { ok: true };
  }

  /** 取消登录：拒绝所有 deferred（teleproto 收到 AUTH_USER_CANCEL 后停止），断开连接 */
  async function cancel() {
    if (!active) return { ok: true };
    const a = active;
    active = null;
    try { a.def.phone.reject(new Error('AUTH_USER_CANCEL')); } catch (e) { /* ignore */ }
    try { a.def.code.reject(new Error('AUTH_USER_CANCEL')); } catch (e) { /* ignore */ }
    try { a.def.password.reject(new Error('AUTH_USER_CANCEL')); } catch (e) { /* ignore */ }
    try { await a.client.disconnect(); } catch (e) { /* ignore */ }
    emit({ accountId: a.accountId, status: 'cancelled', step: 'cancel', message: '已取消登录' });
    return { ok: true };
  }

  return { start, submit, cancel, isActive: () => !!active };
}

module.exports = { createController };
