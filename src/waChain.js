/* =====================================================================
 * v2.6.1135「WA①~⑤ 采集串联调度链」
 * ---------------------------------------------------------------------
 * 干什么：把软件**内置浏览器**那 5 个 WA 页签（WA①/WA②/WA③/WA④/WA⑤）的
 *         消息采集（src/whatsappRead.js）与中文气泡（src/waBubble.js）
 *         **收进一条链里统一驱动**，替掉原来「10 个实例各自一个 3 秒定时器」的散养节拍。
 *
 * 🔴 为什么单建这个文件（老板跨项目铁律）：
 *    「不同功能各归各的文件与函数，不要塞进同一个大函数里。」
 *    所以调度逻辑**全部在这里**，src/main.js 只负责「把 hooks 装好 + 叫一声 startChain()」，
 *    绝不把几十行调度代码塞进 main.js 的既有函数。
 *    链自己的常量（节拍 2000ms / 单步超时 2000ms）也只在本文件里，不散落到别处。
 *
 * ---- 改造前 → 改造后（老板 2026-10-16 拍板的方案，逐条照做）----
 *
 *   改造前：5 个消息实例 + 5 个气泡实例 = **10 个独立定时器**，
 *           而且它们是在同一个 for 循环里几乎同一刻创建的
 *           ⇒ **全部对齐在 0/3/6 秒的整点同时开火**。
 *           8 个 webview 共享同一个 Electron 引擎进程，整点必然掉帧/卡顿尖峰。
 *
 *   改造后（本文件实现的四条）：
 *   ① **实例之间严格串联**：WA① → WA② → WA③ → WA④ → WA⑤，
 *      **上一个完成才交棒给下一个**（await，绝不同时跑两个实例）。
 *   ② **实例内部并行**：每个实例这一步里，它的**消息 tick 和气泡 tick 同时跑**
 *      （Promise.all），不是「消息跑完再跑气泡」。
 *   ③ **一拍 = 2 秒**（不是 3 秒）：一拍之内把 ①→⑤ 串完，跑完就**空闲等待**，
 *      下一拍再从头跑。所以每个实例仍约每 2 秒被检一次（检测延迟基本不变），
 *      但同一瞬间**只有一个实例在干活**。
 *      某轮跑超了 2 秒就顺延（wait = max(0, 2000 - 本轮耗时)）——
 *      **不追帧、不并发补跑**。
 *   ④ 两条保险：
 *      A. **单实例超时 2 秒**：某一步（某实例的消息或气泡 tick）超过 2 秒没回来，
 *         立刻**跳过它并记 warn 日志**，继续下一个实例。
 *         ⇒ 绝不允许一个卡住的实例把整条链堵死（否则 ②③④⑤ 全饿死）。
 *      B. **未加载/未登录的实例快速跳过**：某页签的 webview 还没加载、
 *         WhatsApp 还没登录、或实例状态显示不可用 ⇒ 这一步**直接跳过、几乎零耗时**，
 *         不傻等、不占链上的时间片。判据只用**已有的轻量接口**：
 *           · whatsappWebView.findGuest(partition)（实例自己找页面也是走这条）
 *           · inst.state().status（no-page / unreadable / error 视为不可用）
 *         不为此改动 whatsappRead / waBubble 的任何内部逻辑。
 *
 * ---- 为什么不会「重复驱动」----
 *   链起来之后，实例内部那个自带的 3 秒定时器**必须停掉**，否则会
 *   「链跑一遍 + 定时器又跑一遍」重复采集。
 *   做法：whatsappRead.startWatching / waBubble.startWatching 新增**可选开关**
 *   `{ manual: true }`（等价写法 `{ autoStart: false }`）——
 *   **opt-in，默认关闭**：不传时行为与以前一模一样（既有测试纹丝不动）。
 *   传了就只装 hooks、**不挂内部定时器**，由本链 `await inst.tick()` 来驱动。
 *
 * ===================================================================== */

'use strict';

const codes = require('./ids');                    // WA_EMBEDDED：5 个内置浏览器实例的唯一出处
const whatsappRead = require('./whatsappRead');    // 消息采集实例工厂
const waBubble = require('./waBubble');            // 中文气泡实例工厂
const whatsappWebView = require('./whatsappWebView'); // 唯一一条「找到内置浏览器页面」的通道（轻量探活用）

/** 🔴 一拍 = 2 秒（老板拍板：一拍之内把 ①→⑤ 串完，跑完就空闲等待） */
const CHAIN_BEAT_MS = 2000;

/** 🔴 单步超时 = 2 秒（某个实例的消息 tick 或气泡 tick 超过它就跳过交棒） */
const STEP_TIMEOUT_MS = 2000;

/** 启动后第一拍的延迟（别跟 Electron 启动抢主线程，跟两个采集内核原来的 START_DELAY_MS 一致） */
const FIRST_BEAT_DELAY_MS = 3000;

/**
 * 「这一步看起来不可用」时最多连续跳过几拍就必须**强制探一次**。
 * 🔴 为什么必须有上限：如果无脑一直跳过，老板一旦点开某个页签 / 扫完码，
 *    这个实例会**永远被跳过**（状态永远是旧的 no-page）→ 那才是真事故（饿死）。
 *    每 5 拍（≈10 秒）强制探一次，代价可忽略，保证「一点开就自动接着采」。
 */
const SKIP_MAX_BEATS = 5;

/** 这些 status 视为「这一步现在不可用」（都来自实例已有的 state()，不新增任何字段） */
const NOT_READY_STATUS = new Set(['no-page', 'unreadable', 'error']);

/** 当前那条链（模块级单实例 —— 全软件只会有一条链） */
let _chain = null;

/* =====================================================================
 * 一、小工具
 * ===================================================================== */

/**
 * 取某个实例当前状态（只读，绝不抛）。
 * 优先用消息采集器的 state()（它的 status 最全），没有就退到气泡的。
 * @param {object} step 链上的一步
 * @returns {object|null}
 */
function probeState(step) {
  const r = step.reader;
  if (r && typeof r.state === 'function') {
    try { return r.state() || null; } catch (e) { return null; }
  }
  const b = step.bubble;
  if (b && typeof b.state === 'function') {
    try { return b.state() || null; } catch (e) { return null; }
  }
  return null;
}

/**
 * 这个分区的 webview 页面在不在（**轻量**：只查 webContents，不注入任何脚本）。
 * @param {object} chain 链对象
 * @param {object} cfg codes.WA_EMBEDDED 里的一条
 * @returns {boolean}
 */
function pageExists(chain, cfg) {
  if (typeof chain.findPage === 'function') {
    try { return !!chain.findPage(cfg); } catch (e) { return false; }
  }
  try { return !!whatsappWebView.findGuest(cfg && cfg.partition); } catch (e) { return false; }
}

/**
 * 这一步这拍要不要跑（保险 B：未加载 / 未登录 / 状态不可用 ⇒ 快速跳过）。
 * @param {object} chain 链对象
 * @param {object} step 链上的一步
 * @returns {boolean}
 */
function isStepReady(chain, step) {
  const hasPage = pageExists(chain, step.cfg);
  const st = probeState(step);
  const status = String((st && st.status) || '');
  const bad = !hasPage || NOT_READY_STATUS.has(status);
  if (!bad) {
    step.skipBeats = 0;
    return true;
  }
  /* 🔴 连续跳过有上限：到点就强制探一次，保证「老板一点页签 / 一扫码」能自动恢复，
     绝不因为一次历史状态把这个实例永久饿死。 */
  if (step.skipBeats + 1 >= chain.skipMaxBeats) {
    step.skipBeats = 0;
    return true;
  }
  return false;
}

/**
 * 给一个 tick 套上超时（保险 A）。
 * 🔴 超时后**不等它**，直接交棒给下一个 —— 那个卡住的 tick 爱跑多久跑多久，
 *    它回来时链早走到下一步了，绝不会把 ②③④⑤ 堵死。
 *
 * @param {string} label 日志用名字，例如「WA③ 消息」
 * @param {Function} work 真正要跑的那一下（() => inst.tick()）
 * @param {number} ms 超时毫秒
 * @returns {Promise<*>} 超时/出错 → undefined；正常 → tick 的返回值
 */
function guardTick(label, work, ms) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      console.warn(`[wa-chain] ${label} 超过 ${ms}ms 没回来 —— 跳过这一步，交棒给下一个`);
      finish(undefined);
    }, Number(ms) > 0 ? Number(ms) : STEP_TIMEOUT_MS);
    if (timer && timer.unref) timer.unref();
    Promise.resolve()
      .then(() => work())
      .then((v) => finish(v))
      .catch((e) => {
        console.warn(`[wa-chain] ${label} 抛错（跳过这一步，不影响其余实例）：${(e && e.message) || e}`);
        finish(undefined);
      });
  });
}

/* =====================================================================
 * 二、链本体
 * ===================================================================== */

/**
 * 造链上的一步（一个 WA 页签 = 一步）。
 * @param {object} cfg codes.WA_EMBEDDED 里的一条
 * @param {object|null} reader 消息采集实例
 * @param {object|null} bubble 气泡实例
 * @returns {object}
 */
function makeStep(cfg, reader, bubble) {
  return {
    cfg,
    key: String(cfg.key || cfg.prefix || ''),
    label: String(cfg.label || cfg.key || cfg.prefix || ''),
    reader: reader || null,
    bubble: bubble || null,
    /** 连续被判定「不可用」的拍数（到上限就强制探一次） */
    skipBeats: 0,
    /** 统计：跑了几次 / 跳过了几拍 / 超时了几次 / 上一轮这一步花了多少毫秒 */
    runs: 0,
    skips: 0,
    timeouts: 0,
    lastMs: 0,
  };
}

/**
 * 跑一步：这一个 WA 页签的**消息 tick + 气泡 tick 同时跑**（Promise.all），
 * 两者都各自带 2 秒超时，谁先回来都不影响另一个。
 *
 * @param {object} chain 链对象
 * @param {object} step 链上的一步
 * @returns {Promise<void>}
 */
async function runStep(chain, step) {
  if (!isStepReady(chain, step)) {
    step.skips += 1;
    step.skipBeats += 1;
    step.lastMs = 0;
    return;
  }
  step.skipBeats = 0;
  const t0 = Date.now();

  const jobs = [];
  if (step.reader && typeof step.reader.tick === 'function') {
    jobs.push(guardTick(`${step.label} 消息`, () => step.reader.tick(), chain.stepTimeoutMs));
  }
  if (step.bubble && typeof step.bubble.tick === 'function') {
    jobs.push(guardTick(`${step.label} 气泡`, () => step.bubble.tick(), chain.stepTimeoutMs));
  }
  if (!jobs.length) return;

  /* 🔴 实例内部并行：两个 tick 同时开跑，不是「消息跑完再跑气泡」 */
  const results = await Promise.all(jobs);
  let timedOut = 0;
  for (const r of results) if (r === undefined) timedOut += 1;
  if (timedOut) step.timeouts += timedOut;
  step.runs += 1;
  step.lastMs = Date.now() - t0;
}

/**
 * 跑一整轮：WA① → WA② → WA③ → WA④ → WA⑤，**严格串联**（前一个 await 完才下一个）。
 * @param {object} chain 链对象
 * @returns {Promise<number>} 本轮耗时（毫秒）
 */
async function runRound(chain) {
  const t0 = Date.now();
  for (const step of chain.steps) {
    if (chain.stopped) return Date.now() - t0;
    await runStep(chain, step);
  }
  const spent = Date.now() - t0;
  chain.rounds += 1;
  chain.lastRoundMs = spent;
  chain.lastRoundAt = new Date().toISOString();
  return spent;
}

/**
 * 一拍：跑一轮 → 算空闲多久 → 排下一拍。
 * 🔴 超了 2 秒就顺延（wait = max(0, 2000 - 本轮耗时)），**不追帧、不并发补跑**。
 * @param {object} chain 链对象
 * @returns {Promise<void>}
 */
async function beat(chain) {
  if (chain.stopped) return;
  if (chain.running) return; // 上一轮还没收尾 → 这一拍直接让掉，绝不并发补跑
  chain.running = true;
  try {
    const spent = await runRound(chain);
    if (chain.stopped) return;
    scheduleBeat(chain, Math.max(0, chain.beatMs - spent));
  } catch (e) {
    console.warn('[wa-chain] 一轮跑出错（下一拍照常继续）：', (e && e.message) || e);
    if (!chain.stopped) scheduleBeat(chain, chain.beatMs);
  } finally {
    chain.running = false;
  }
}

/**
 * 排下一拍。
 * @param {object} chain 链对象
 * @param {number} delay 毫秒
 * @returns {void}
 */
function scheduleBeat(chain, delay) {
  if (chain.stopped) return;
  if (chain.timer) clearTimeout(chain.timer);
  const ms = Number(delay) >= 0 ? Number(delay) : chain.beatMs;
  chain.timer = setTimeout(() => {
    beat(chain).catch((e) => {
      console.warn('[wa-chain] 一拍异常（下一拍照常继续）：', (e && e.message) || e);
      if (!chain.stopped) scheduleBeat(chain, chain.beatMs);
    });
  }, ms);
  if (chain.timer && chain.timer.unref) chain.timer.unref();
}

/**
 * 起链。
 *
 * 🔴 幂等：链已经在跑就**原样返回**，绝不挂出第二条链（重启 / 重初始化会重复调）。
 * 🔴 可停：见 stopChain()。
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.cfgs] 实例清单，默认 codes.WA_EMBEDDED
 * @param {Function} [opts.readerFactory] (cfg) => 消息采集实例，默认 whatsappRead.getInstance(cfg.prefix)
 * @param {Function} [opts.bubbleFactory] (cfg) => 气泡实例，默认 waBubble.getInstance(cfg.prefix)
 * @param {Function} [opts.findPage] (cfg) => webContents|null，轻量探活用（默认走 whatsappWebView.findGuest）
 * @param {number} [opts.beatMs] 一拍毫秒，默认 CHAIN_BEAT_MS
 * @param {number} [opts.stepTimeoutMs] 单步超时毫秒，默认 STEP_TIMEOUT_MS
 * @param {number} [opts.firstDelayMs] 第一拍延迟毫秒，默认 FIRST_BEAT_DELAY_MS
 * @param {number} [opts.skipMaxBeats] 连续跳过上限拍数，默认 SKIP_MAX_BEATS
 * @returns {object} 链句柄 { stop, state, beatMs, stepTimeoutMs, steps }
 */
function startChain(opts = {}) {
  if (_chain && !_chain.stopped) return _chain.handle; // 幂等：已经在跑就直接还回去
  if (_chain) stopChain();                             // 旧的已停 → 清干净再起新的

  const cfgs = Array.isArray(opts.cfgs) && opts.cfgs.length ? opts.cfgs : codes.WA_EMBEDDED;
  const readerFactory = typeof opts.readerFactory === 'function'
    ? opts.readerFactory
    : (cfg) => whatsappRead.getInstance(cfg.prefix);
  const bubbleFactory = typeof opts.bubbleFactory === 'function'
    ? opts.bubbleFactory
    : (cfg) => waBubble.getInstance(cfg.prefix);

  const steps = [];
  for (const cfg of cfgs) {
    let reader = null;
    let bubble = null;
    try { reader = readerFactory(cfg) || null; } catch (e) { reader = null; }
    try { bubble = bubbleFactory(cfg) || null; } catch (e) { bubble = null; }
    if (!reader && !bubble) continue; // 一个都没接上就不占链上的位置
    steps.push(makeStep(cfg, reader, bubble));
  }

  const chain = {
    stopped: false,
    running: false,
    timer: null,
    steps,
    beatMs: Number(opts.beatMs) > 0 ? Number(opts.beatMs) : CHAIN_BEAT_MS,
    stepTimeoutMs: Number(opts.stepTimeoutMs) > 0 ? Number(opts.stepTimeoutMs) : STEP_TIMEOUT_MS,
    skipMaxBeats: Number(opts.skipMaxBeats) > 0 ? Number(opts.skipMaxBeats) : SKIP_MAX_BEATS,
    findPage: typeof opts.findPage === 'function' ? opts.findPage : null,
    rounds: 0,
    lastRoundMs: 0,
    lastRoundAt: '',
    startedAt: new Date().toISOString(),
  };

  const handle = {
    stop: stopChain,
    state,
    beatMs: chain.beatMs,
    stepTimeoutMs: chain.stepTimeoutMs,
    steps: steps.map((s) => s.label),
  };
  chain.handle = handle;
  _chain = chain;

  console.log(
    `[wa-chain] 串联调度链已启动：${steps.map((s) => s.label).join(' → ')}，` +
    `一拍 ${chain.beatMs}ms，单步超时 ${chain.stepTimeoutMs}ms`
  );
  scheduleBeat(chain, Number(opts.firstDelayMs) >= 0 ? Number(opts.firstDelayMs) : FIRST_BEAT_DELAY_MS);
  return handle;
}

/**
 * 停链。可重复调；停了之后再 startChain() 能重新起一条（重启 / 重初始化不会挂两条）。
 * 🔴 只停**调度**，不动实例自己的 hooks —— 实例要不要停由 main.js 决定。
 * @returns {boolean} 之前有没有链在跑
 */
function stopChain() {
  if (!_chain) return false;
  const was = !_chain.stopped;
  _chain.stopped = true;
  if (_chain.timer) {
    clearTimeout(_chain.timer);
    _chain.timer = null;
  }
  if (was) console.log('[wa-chain] 串联调度链已停止');
  return was;
}

/**
 * 链的当前状态（排障 / 日志用）。
 * @returns {object}
 */
function state() {
  const c = _chain;
  if (!c) {
    return {
      running: false,
      busy: false,
      rounds: 0,
      beatMs: CHAIN_BEAT_MS,
      stepTimeoutMs: STEP_TIMEOUT_MS,
      lastRoundMs: 0,
      lastRoundAt: '',
      startedAt: '',
      steps: [],
    };
  }
  return {
    running: !c.stopped,
    busy: !!c.running,
    rounds: c.rounds,
    beatMs: c.beatMs,
    stepTimeoutMs: c.stepTimeoutMs,
    lastRoundMs: c.lastRoundMs,
    lastRoundAt: c.lastRoundAt,
    startedAt: c.startedAt,
    steps: c.steps.map((s) => ({
      key: s.key,
      label: s.label,
      hasReader: !!s.reader,
      hasBubble: !!s.bubble,
      runs: s.runs,
      skips: s.skips,
      timeouts: s.timeouts,
      lastMs: s.lastMs,
    })),
  };
}

/**
 * 把链状态翻成一句人话（照 whatsappRead.describe / waBubble.describe 的返回形状）。
 * @param {object} [st] 不传就现取
 * @returns {{level: 'ok'|'warn'|'muted', text: string}}
 */
function describe(st) {
  const s = st || state();
  if (!s.running) return { level: 'muted', text: 'WA 采集调度链：未启动' };
  const parts = [`已跑 ${s.rounds} 拍`];
  if (s.lastRoundMs) parts.push(`上一拍 ${s.lastRoundMs}ms`);
  const to = (s.steps || []).reduce((n, x) => n + (x.timeouts || 0), 0);
  if (to) parts.push(`超时跳过 ${to} 次`);
  return { level: to ? 'warn' : 'ok', text: `WA 采集链（一拍 ${s.beatMs}ms，①→⑤ 串联）：${parts.join('，')}` };
}

/** 链在不在跑（给幂等判断 / 排障用） */
function isRunning() {
  return !!(_chain && !_chain.stopped);
}

module.exports = {
  CHAIN_BEAT_MS,
  STEP_TIMEOUT_MS,
  FIRST_BEAT_DELAY_MS,
  SKIP_MAX_BEATS,
  NOT_READY_STATUS,
  startChain,
  stopChain,
  isRunning,
  state,
  describe,
};
