'use strict';
/**
 * 全局「静默锁」—— 跳转真置顶期间（老板要求 3 秒）让后台循环别抢焦点。
 *
 * 背景（老板 2026-10-12 拍板）：点「跳到聊天」→ 把目标窗口（WhatsApp / Signal）真置顶 2 秒，
 * 软件自己静默 3 秒不抢焦点，之后取消置顶、窗口留在最前。
 * 这里就是那个「静默 3 秒」的计时器：任何会偷焦点的后台动作（开 Telegram 窗口、激活浏览器窗口等）
 * 在 Date.now() < silentUntil 时应当跳过，避免把刚置顶的窗口又压下去。
 *
 * 纯内存、无副作用、可单测。
 */

let silentUntil = 0;

/** 开启静默，持续 ms 毫秒（从调用那一刻起算） */
function setSilence(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const until = Date.now() + ms;
  // 取较大值，避免连续跳转把静默期越缩越短
  silentUntil = Math.max(silentUntil, until);
}

/** 当前是否处于静默期 */
function isSilent() {
  return Date.now() < silentUntil;
}

/** 剩余静默毫秒（0 表示不在静默期），便于测试/日志 */
function remaining() {
  const r = silentUntil - Date.now();
  return r > 0 ? r : 0;
}

/** 仅供测试：清空 */
function _reset() {
  silentUntil = 0;
}

module.exports = { setSilence, isSilent, remaining, _reset };
