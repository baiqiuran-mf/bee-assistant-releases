/*
 * 三个循环 · 3 秒节拍（v2.5.1039 · 老板 2026-10-11 拍板，照桌面那张图逐条落地）
 * =====================================================================
 * 老板图上的原文（一字不改抄下来，代码就是按它写的）：
 *
 *   循环1：Telegram 开 Chrome「最先预热 + 开前等静默窗口」→ 加 3 秒循环
 *          「S1 S2 S3 随便启动一个，随便一个启动绿灯后，循环1 停止」
 *
 *   循环2：Signal 消息采集 + Telegram 开 Chrome 预热 → 加 3 秒循环
 *          「循环2 跑起来，跑到 611 秒后停下，扫进程 S1 2 3 预热，等待 1 秒，继续循环2」
 *
 *   循环3：扫进程 S1~S3 灯，611 秒（未启动零扫）
 *
 * 翻成代码就四句话：
 *
 *   ① 循环1 与 循环2 是【串行】的，不是并行：
 *      登录 + 同步走完 → 循环1 起（每 3 秒一轮，只做 Telegram 预热）
 *      → S1~S3 里【任意一个】绿灯 → 循环1 停，循环2 接着起。
 *
 *   ② 循环2 起来的那一刻，顺手把 611 秒的计时【归零】（onStableRhythm）：
 *      老板说的是「循环2 跑起来，跑到 611 秒后停下」，所以这 611 秒从循环2
 *      起来那一刻算，不是从登录那一刻算。
 *
 *   ③ 「跑到 611 秒停下 → 扫进程 → 等 1 秒 → 继续循环2」不另写一套定时器：
 *      循环3（launcher 的进程扫描）动手前会压住闸门（前 3 秒 + 后 1 秒），
 *      本模块每一轮动手前先问一句 prewarm.gate() —— 被闸住就【整轮跳过】，
 *      闸一开下一轮自动接上。这就是图里"停下 → 扫描 → 等 1 秒 → 继续"。
 *
 *   ④ 循环1 的停止条件只看【缓存】（anyGreen 由 launcher.anySignalGreenCached 提供），
 *      绝不因为"问了一句灯绿没绿"就多扫一轮进程。
 */

'use strict';

const prewarm = require('./prewarm');

/** 老板定的节拍：3 秒一轮 */
const BEAT_MS = 3000;

/**
 * 起一套循环节拍器。
 *
 * @param {object} o
 * @param {number}   [o.intervalMs=3000]  一轮多少毫秒
 * @param {Function} o.ensureTelegram     每轮要干的活（Telegram 开 Chrome 预热），可 async
 * @param {Function} o.startSignal        循环2 起来时调一次（拉起 Signal 消息采集）
 * @param {Function} o.anyGreen           S1~S3 里有没有任意一个绿灯（只读缓存，不许催扫描）
 * @param {Function} [o.onStableRhythm]   循环2 起来 → 611 秒计时归零
 * @param {Function} [o.log]              日志出口
 * @returns {{start:Function, stop:Function, state:Function, _tick:Function}}
 */
function createLoops(o = {}) {
  const intervalMs = Number(o.intervalMs) > 0 ? Number(o.intervalMs) : BEAT_MS;
  const ensureTelegram = typeof o.ensureTelegram === 'function' ? o.ensureTelegram : async () => {};
  const startSignal = typeof o.startSignal === 'function' ? o.startSignal : () => {};
  const anyGreen = typeof o.anyGreen === 'function' ? o.anyGreen : () => false;
  const onStableRhythm = typeof o.onStableRhythm === 'function' ? o.onStableRhythm : () => {};
  const log = typeof o.log === 'function' ? o.log : () => {};

  /** 'idle' 还没起 / 'loop1' Telegram 预热循环 / 'loop2' Signal 采集 + Telegram 预热循环 */
  let phase = 'idle';
  let stopped = false;
  /** 上一轮还没干完 → 这一拍不叠着上（防止 Telegram 拉起慢把循环堆成一大坨） */
  let busy = false;
  let timer = null;

  const stat = {
    beats1: 0,            // 循环1 真干活的轮数
    beats2: 0,            // 循环2 真干活的轮数
    beatsSkipped: 0,      // 被闸门（扫描静默窗口）挡掉、整轮跳过的轮数
    beatsBusySkipped: 0,  // 上一轮还没干完而跳过
    startedAt: 0,
    loop2At: 0,
  };

  function snapshot() {
    return {
      phase,
      stopped,
      intervalMs,
      beats1: stat.beats1,
      beats2: stat.beats2,
      beatsSkipped: stat.beatsSkipped,
      beatsBusySkipped: stat.beatsBusySkipped,
      startedAt: stat.startedAt,
      loop2At: stat.loop2At,
      gate: prewarm.status(),
    };
  }

  /** 排下一拍（定时器 unref：绝不阻止进程退出） */
  function schedule(delay = intervalMs) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { tick().catch(() => {}); }, Math.max(0, Number(delay) || 0));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** 循环1 停 → 循环2 起（串行交接） */
  function enterLoop2() {
    phase = 'loop2';
    stat.loop2At = Date.now();
    log('循环① 停止：S1~S3 已有一个绿灯 → 循环② 起来（Signal 消息采集 + Telegram 预热，每 3 秒一轮）');
    try {
      onStableRhythm();
    } catch (e) {
      log(`循环② 起点对齐失败（不影响循环本身）：${(e && e.message) || e}`);
    }
    try {
      startSignal();
    } catch (e) {
      log(`循环② 里 Signal 采集启动失败（不影响 Telegram 预热）：${(e && e.message) || e}`);
    }
  }

  /** 一拍 */
  async function tick() {
    if (stopped) return;

    /*
     * 🔴 老板图上那句「跑到 611 秒后停下，…，等待 1 秒，继续循环2」：
     *    循环3（进程扫描）动手前压住闸门 → 这里 skip → 本轮整轮跳过；
     *    闸一开，下一轮自动接上（Signal 的水位原地不动，所以不丢消息）。
     */
    const g = prewarm.gate();
    if (g.skip) {
      stat.beatsSkipped += 1;
      schedule();
      return;
    }
    if (busy) {
      stat.beatsBusySkipped += 1;
      schedule();
      return;
    }

    busy = true;
    try {
      if (phase === 'loop1') {
        stat.beats1 += 1;
        try {
          await ensureTelegram();
        } catch (e) {
          log(`循环① 第 ${stat.beats1} 轮出错（不影响下一轮）：${(e && e.message) || e}`);
        }
        // 随便一个绿灯 → 循环1 停、循环2 起
        let green = false;
        try { green = !!anyGreen(); } catch (e) { green = false; }
        if (green) enterLoop2();
      } else if (phase === 'loop2') {
        stat.beats2 += 1;
        try {
          await ensureTelegram();
        } catch (e) {
          log(`循环② 第 ${stat.beats2} 轮出错（不影响下一轮）：${(e && e.message) || e}`);
        }
      }
    } finally {
      busy = false;
      schedule();
    }
  }

  return {
    /** 起循环1（登录 + 同步走完后才调） */
    start() {
      if (stopped || phase !== 'idle') return snapshot();
      phase = 'loop1';
      stat.startedAt = Date.now();
      log('循环① 起来：Telegram 开 Chrome 预热，每 3 秒一轮（开前先等 ③ 扫描的静默窗口）');
      schedule(0);
      return snapshot();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    state: snapshot,
    /** 测试用：手动跑一拍 */
    _tick: tick,
  };
}

module.exports = { BEAT_MS, createLoops };
