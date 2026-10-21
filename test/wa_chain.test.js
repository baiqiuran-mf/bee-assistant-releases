/**
 * v2.6.1135「WA①~⑤ 采集串联调度链」针对性回归自检（src/waChain.js）
 * ---------------------------------------------------------------------
 * 干什么：老测试（whatsapp_read / wa_bubble / ui_render）只证明「没改坏」，
 *          **证明不了新链条真的按老板那五条规格跑**。这份文件专门钉死新行为。
 *
 * 手法：**不碰 Electron、不碰真网页** —— 用假实例（fake reader / fake bubble）
 *        从 startChain({ readerFactory, bubbleFactory, findPage }) 注入，
 *        记录每一个 tick 的 enter/exit 时间戳，再对时间戳做断言。
 *
 * 逐条对应老板拍板的规格：
 *   [B] 实例之间**严格串联**：任意时刻只有一个 step 在跑；①exit ≤ ②enter ≤ … ≤ ⑤
 *   [C] 实例**内部并行**：同一 step 的消息 tick 与气泡 tick 同时 enter
 *   [D] 保险 A：**单步超时 2 秒** → warn 并交棒，不干等
 *   [E] 保险 B：**未加载快跳 + 不饿死**（SKIP_MAX_BEATS 强制回探）
 *   [F] **一拍 2 秒 / 不追帧**：跑超了顺延，并发数恒为 1
 *   [G] **幂等 / 可停 / 可重启**
 *   [H] **opt-in 开关向后兼容**：不传 manual 时内部定时器照挂（防重复采集的关键）
 *
 * 跑法：node --experimental-sqlite test/wa_chain.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

process.env.BEE_TEST = '1'; // 🔴 必须在 require 之前：两个采集内核据此不挂定时器

const ROOT = path.join(__dirname, '..');
const waChain = require(path.join(ROOT, 'src', 'waChain.js'));
const whatsappRead = require(path.join(ROOT, 'src', 'whatsappRead.js'));
const waBubble = require(path.join(ROOT, 'src', 'waBubble.js'));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? `  << ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 所有「挂住不回」的 sleep 登记在这里，收尾统一放行 —— 免得测试进程被 9 秒的假卡 tick 拖住 */
const pendingAborts = [];
function abortableSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && t.unref) t.unref();
    pendingAborts.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}
function releaseAllPending() {
  while (pendingAborts.length) pendingAborts.shift()();
}

/* =====================================================================
 * 一、假实例 + 事件记录器
 * ===================================================================== */

/** 五个实例的配置（照 src/ids.js 的 WA_EMBEDDED 形状造一遍，免得 require 到 Electron） */
const CFGS = [1, 2, 3, 4, 5].map((i) => ({
  key: `wa${i}`,
  idx: i,
  accId: 9 + i,
  partition: `persist:wa${5 + i}`,
  prefix: `wa${i}`,
  label: `WA${'①②③④⑤'.charAt(i - 1)}`,
}));

/**
 * 造一个事件记录器：链上每个 tick 的 enter/exit 都记一笔带时间戳的事件。
 * 顺带维护「同一时刻有几个 step 在跑」的峰值 —— 用来验严格串联。
 */
function createRecorder() {
  const log = [];
  const live = Object.create(null);
  let maxSteps = 0;
  return {
    log,
    bump(step, delta) {
      live[step] = (live[step] || 0) + delta;
      let active = 0;
      for (const k of Object.keys(live)) if (live[k] > 0) active += 1;
      if (active > maxSteps) maxSteps = active;
    },
    get maxSteps() {
      return maxSteps;
    },
  };
}

/**
 * 造一个假 tick（假消息采集实例 / 假气泡实例）。
 * @param {object} rec 事件记录器
 * @param {number} step 第几步（0-based）
 * @param {string} kind 'reader' | 'bubble'
 * @param {object} spec { status, durMs, hangMs }
 */
function makeFake(rec, step, kind, spec = {}) {
  const fake = {
    step,
    kind,
    calls: 0,
    status: spec.status || 'ok',
    durMs: spec.durMs != null ? spec.durMs : 10,
    hangMs: spec.hangMs || 0,
    async tick() {
      fake.calls += 1;
      rec.bump(fake.step, 1);
      rec.log.push({ step: fake.step, kind: fake.kind, ev: 'enter', t: Date.now() });
      try {
        if (fake.hangMs) await abortableSleep(fake.hangMs);
        else await sleep(fake.durMs);
      } finally {
        rec.log.push({ step: fake.step, kind: fake.kind, ev: 'exit', t: Date.now() });
        rec.bump(fake.step, -1);
      }
      return { ok: true };
    },
    state() {
      return { status: fake.status, watching: true };
    },
  };
  return fake;
}

/**
 * 按 specOf(i, kind) 造一组（5 步 × 消息/气泡）假实例。
 * @param {object} rec 记录器
 * @param {Function} specOf (i, kind) => spec
 */
function buildFakes(rec, specOf) {
  return CFGS.map((cfg) => {
    const i = cfg.idx - 1;
    return {
      cfg,
      reader: makeFake(rec, i, 'reader', specOf(i, 'reader')),
      bubble: makeFake(rec, i, 'bubble', specOf(i, 'bubble')),
    };
  });
}

/** 起一条「全假」的链 */
function startFakeChain(steps, opts = {}) {
  return waChain.startChain({
    cfgs: CFGS,
    readerFactory: (cfg) => steps[cfg.idx - 1].reader,
    bubbleFactory: (cfg) => steps[cfg.idx - 1].bubble,
    findPage: opts.findPage || (() => ({ fake: true })),
    beatMs: opts.beatMs || 200,
    stepTimeoutMs: opts.stepTimeoutMs || 1500,
    firstDelayMs: opts.firstDelayMs != null ? opts.firstDelayMs : 10,
    skipMaxBeats: opts.skipMaxBeats || 5,
  });
}

/**
 * 把事件流切成「一拍一轮」的二维数组。
 * 判据：step 0 的 reader enter 就是新一轮的开头（严格串联 ⇒ 一定如此）。
 * @returns {Array<Array<{enter:number, exit:number, enters:object, exits:object}>>}
 */
function groupRounds(log) {
  const rounds = [];
  let cur = null;
  for (const e of log) {
    if (e.step === 0 && e.kind === 'reader' && e.ev === 'enter') {
      cur = [];
      rounds.push(cur);
    }
    if (!cur) continue;
    while (cur.length <= e.step) cur.push(null);
    if (!cur[e.step]) {
      cur[e.step] = { enter: e.t, exit: e.t, enters: {}, exits: {} };
    }
    const slot = cur[e.step];
    if (e.ev === 'enter') {
      slot.enters[e.kind] = e.t;
      slot.enter = Math.min(slot.enter, e.t);
    } else {
      slot.exits[e.kind] = e.t;
      slot.exit = Math.max(slot.exit, e.t);
    }
  }
  return rounds.filter((r) => r.filter(Boolean).length === 5); // 只要跑完整的一轮
}

/** 等某个条件成立（或超时） */
async function waitUntil(fn, timeoutMs, stepMs = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return fn();
}

/* =====================================================================
 * 二、逐条验规格
 * ===================================================================== */

(async function main() {
  /* ---------------------------------------------------------------
   * [A] 常量：老板拍板的四个数，一个都不能错
   * --------------------------------------------------------------- */
  console.log('\n[A] 常量（一拍 2 秒 / 单步超时 2 秒 / 首拍延迟 3 秒 / 连跳上限 5 拍）');
  check('CHAIN_BEAT_MS = 2000', waChain.CHAIN_BEAT_MS === 2000, String(waChain.CHAIN_BEAT_MS));
  check('STEP_TIMEOUT_MS = 2000', waChain.STEP_TIMEOUT_MS === 2000, String(waChain.STEP_TIMEOUT_MS));
  check('FIRST_BEAT_DELAY_MS = 3000', waChain.FIRST_BEAT_DELAY_MS === 3000, String(waChain.FIRST_BEAT_DELAY_MS));
  check('SKIP_MAX_BEATS = 5', waChain.SKIP_MAX_BEATS === 5, String(waChain.SKIP_MAX_BEATS));
  check('NOT_READY_STATUS 含 no-page / unreadable / error',
    waChain.NOT_READY_STATUS.has('no-page')
    && waChain.NOT_READY_STATUS.has('unreadable')
    && waChain.NOT_READY_STATUS.has('error'));

  /* ---------------------------------------------------------------
   * [B] 严格串联 + [C] 实例内并行（同一条链上一起验）
   *     每步消息/气泡各 150ms：若**串行**跑 ⇒ 每步约 300ms；
   *     若**并行**跑 ⇒ 每步约 150ms。用这个差值卡死「并行」。
   * --------------------------------------------------------------- */
  console.log('\n[B][C] 实例间严格串联 + 实例内并行（每步 消息/气泡 各 150ms）');
  {
    const rec = createRecorder();
    const steps = buildFakes(rec, () => ({ status: 'ok', durMs: 150 }));
    startFakeChain(steps, { beatMs: 100, stepTimeoutMs: 1500, firstDelayMs: 10 });
    await sleep(1800);
    waChain.stopChain();

    const rounds = groupRounds(rec.log);
    check('至少跑完 2 整轮', rounds.length >= 2, `rounds=${rounds.length}`);
    check('任意时刻只有 1 个实例在跑（并发峰值 = 1）', rec.maxSteps === 1, `maxSteps=${rec.maxSteps}`);

    /* 严格串联：第 i 步的 exit 必须 ≤ 第 i+1 步的 enter */
    let serialOk = true;
    let worst = '';
    for (const r of rounds) {
      for (let i = 0; i < 4; i += 1) {
        if (!(r[i].exit <= r[i + 1].enter)) {
          serialOk = false;
          worst = `step${i}.exit(${r[i].exit}) > step${i + 1}.enter(${r[i + 1].enter})`;
        }
      }
    }
    check('严格串联：①exit ≤ ②enter ≤ ③enter ≤ ④enter ≤ ⑤enter', serialOk, worst);

    /* 实例内并行：两个 tick 的 enter 几乎同时，且互相重叠（各自的 enter 都早于对方的 exit） */
    let gapMax = 0;
    let overlapOk = true;
    for (const r of rounds) {
      for (const slot of r) {
        gapMax = Math.max(gapMax, Math.abs(slot.enters.reader - slot.enters.bubble));
        const overlapped = slot.enters.bubble < slot.exits.reader
          && slot.enters.reader < slot.exits.bubble;
        if (!overlapped) overlapOk = false;
      }
    }
    check('实例内并行：同一步的 消息/气泡 tick 互相重叠', overlapOk);
    check(`实例内并行：两者 enter 相差 ≤ 80ms（实测 ${gapMax}ms）`, gapMax <= 80);

    /* 并行 ⇒ 每步耗时约 150ms（串行会是 ~300ms） */
    let durMax = 0;
    for (const r of rounds) for (const slot of r) durMax = Math.max(durMax, slot.exit - slot.enter);
    check(`每步耗时 ~150ms 而非 ~300ms（实测最大 ${durMax}ms < 230ms）`, durMax < 230);

    /* 五个实例一个都不少 */
    const st = waChain.state();
    check('链上挂着 5 个实例：WA①→WA⑤',
      st.steps.length === 5
      && st.steps.map((s) => s.label).join('→') === 'WA①→WA②→WA③→WA④→WA⑤',
      st.steps.map((s) => s.label).join('→'));
  }

  /* ---------------------------------------------------------------
   * [D] 保险 A：单步超时 2 秒
   *     让 WA③ 的**消息 tick 挂 9 秒**，其余都 10ms。
   *     ⇒ 链应在 ~2000ms 处交棒给 WA④，**绝不等 9 秒**。
   * --------------------------------------------------------------- */
  console.log('\n[D] 保险 A：单步超时 2 秒（WA③ 消息 tick 故意挂 9 秒）');
  {
    const rec = createRecorder();
    const steps = buildFakes(rec, (i, kind) => (
      (i === 2 && kind === 'reader') ? { status: 'ok', hangMs: 9000 } : { status: 'ok', durMs: 10 }
    ));
    /* stepTimeoutMs **不传** ⇒ 走默认 2000ms，直接验规格里的那个数 */
    const handle = waChain.startChain({
      cfgs: CFGS,
      readerFactory: (cfg) => steps[cfg.idx - 1].reader,
      bubbleFactory: (cfg) => steps[cfg.idx - 1].bubble,
      findPage: () => ({ fake: true }),
      beatMs: 100,
      firstDelayMs: 10,
    });
    check('不传 stepTimeoutMs 时取默认 2000ms', handle.stepTimeoutMs === 2000, String(handle.stepTimeoutMs));

    await sleep(2600);
    waChain.stopChain();

    const rounds = groupRounds(rec.log);
    check('被卡住的那一步之后，链没有被堵死（跑完了整轮）', rounds.length >= 1, `rounds=${rounds.length}`);
    check('挂住的 tick 确实被调用了', steps[2].reader.calls >= 1, String(steps[2].reader.calls));

    if (rounds.length) {
      const r = rounds[0];
      const gapToNext = r[3].enter - r[2].enter; // WA③ enter → WA④ enter
      check(`卡住的那一步在 ~2000ms 处交棒（实测 ${gapToNext}ms，不是 9000ms）`,
        gapToNext >= 1700 && gapToNext <= 3000, String(gapToNext));
      /* 其余正常步骤仍然很快，说明只有那一步被超时掐断 */
      const g01 = r[1].enter - r[0].enter;
      const g34 = r[4].enter - r[3].enter;
      check(`其余步骤照常快跑（①→② ${g01}ms，④→⑤ ${g34}ms，均 < 300ms）`,
        g01 < 300 && g34 < 300);
      check('WA④ / WA⑤ 没被饿死，本轮照常跑到', r[3].enters.reader != null && r[4].enters.reader != null);
    }
    check('state() 记下了超时次数 ≥ 1', waChain.state().steps[2].timeouts >= 1,
      String(waChain.state().steps[2].timeouts));
  }

  /* ---------------------------------------------------------------
   * [E] 保险 B：未加载快跳 + **不饿死**
   *     场景：WA② 一开始「不可用」（status=no-page），后来**变可用**。
   *     · 阶段一：应被快跳、零耗时、一次都没真跑；
   *     · 阶段二：**即使一直不可用**，也会在 SKIP_MAX_BEATS 拍内强制回探一次；
   *     · 阶段三：变可用后，会被立刻捡起来接着采。
   * --------------------------------------------------------------- */
  console.log('\n[E] 保险 B：未加载快跳 + 不被饿死（WA② 先不可用、后变可用）');
  {
    const rec = createRecorder();
    const steps = buildFakes(rec, (i) => (
      i === 1 ? { status: 'no-page', durMs: 5 } : { status: 'ok', durMs: 5 }
    ));
    const handle = startFakeChain(steps, {
      beatMs: 70, stepTimeoutMs: 400, firstDelayMs: 5, skipMaxBeats: 5,
    });
    check('skipMaxBeats 可注入（这里用默认 5）', handle.steps.length === 5);

    /* 阶段一：快跳 + 零耗时 */
    await sleep(200);
    const st1 = waChain.state().steps[1];
    check(`不可用的实例被跳过（skips=${st1.skips} ≥ 2）`, st1.skips >= 2, JSON.stringify(st1));
    check(`跳过不占时间（lastMs=${st1.lastMs} === 0）`, st1.lastMs === 0, JSON.stringify(st1));
    check(`跳过期间一次都没真跑（runs=${st1.runs} === 0）`, st1.runs === 0, JSON.stringify(st1));
    check('可用的实例照常在跑', waChain.state().steps[0].runs >= 2,
      JSON.stringify(waChain.state().steps[0]));

    /* 阶段二：不饿死 —— 一直不可用，也会强制回探 */
    const probed = await waitUntil(() => waChain.state().steps[1].runs >= 1, 600);
    const st2 = waChain.state().steps[1];
    check('🔴 不被饿死：一直不可用也会强制回探一次（runs ≥ 1）', probed && st2.runs >= 1,
      JSON.stringify(st2));

    /* 阶段三：变可用 → 被捡起来 */
    const before = waChain.state().steps[1].runs;
    steps[1].reader.status = 'ok';
    steps[1].bubble.status = 'ok';
    await sleep(220);
    waChain.stopChain();
    const st3 = waChain.state().steps[1];
    check(`变可用后被立刻捡起（runs ${before} → ${st3.runs}）`, st3.runs > before, JSON.stringify(st3));
    check('变可用后真的调了 tick', steps[1].reader.calls >= 1, String(steps[1].reader.calls));
  }

  /* ---------------------------------------------------------------
   * [F] 一拍 2 秒 / **不追帧、不并发补跑**
   *     beatMs=500，每步 200ms ⇒ 一轮 1000ms > 一拍 500ms。
   *     ⇒ wait = max(0, 500-1000) = 0，下一拍**顺延**，但绝不同时起两条。
   * --------------------------------------------------------------- */
  console.log('\n[F] 一拍 2 秒 / 不追帧（beatMs=500，一轮要跑 1000ms）');
  {
    const rec = createRecorder();
    const steps = buildFakes(rec, () => ({ status: 'ok', durMs: 200 }));
    startFakeChain(steps, { beatMs: 500, stepTimeoutMs: 1500, firstDelayMs: 10 });
    await sleep(2200);
    waChain.stopChain();

    const rounds = groupRounds(rec.log);
    check('跑了 ≥ 2 整轮', rounds.length >= 2, `rounds=${rounds.length}`);
    check('🔴 不并发补跑：并发峰值恒为 1', rec.maxSteps === 1, `maxSteps=${rec.maxSteps}`);

    /* 顺延：相邻两轮的间隔 = 本轮实际耗时（≥ 一拍），绝不小于一拍 */
    let minGap = Infinity;
    for (let r = 1; r < rounds.length; r += 1) {
      minGap = Math.min(minGap, rounds[r][0].enter - rounds[r - 1][0].enter);
    }
    check(`🔴 跑超了顺延：相邻两拍间隔 ≥ 一拍 500ms（实测最小 ${minGap}ms）`, minGap >= 500, String(minGap));

    /* 一轮内部仍是 ①→⑤ 严格串联 */
    let serialOk = true;
    for (const r of rounds) {
      for (let i = 0; i < 4; i += 1) if (!(r[i].exit <= r[i + 1].enter)) serialOk = false;
    }
    check('一轮内部仍然 ①→⑤ 严格串联', serialOk);
  }

  /* ---------------------------------------------------------------
   * [G] 幂等 / 可停 / 可重启
   * --------------------------------------------------------------- */
  console.log('\n[G] 幂等 / 可停 / 可重启');
  {
    const rec = createRecorder();
    const steps = buildFakes(rec, () => ({ status: 'ok', durMs: 10 }));

    const h1 = startFakeChain(steps, { beatMs: 150, firstDelayMs: 400 }); // 首拍 400ms，留出断言窗口
    check('起链后 isRunning() = true', waChain.isRunning() === true);

    const h2 = startFakeChain(steps, { beatMs: 150, firstDelayMs: 400 });
    check('🔴 幂等：二次 startChain() 返回**同一个**句柄（不挂第二条链）', h1 === h2);

    /* 停一次就该全停：若真挂了两条链，这里会漏掉一条 */
    const r1 = waChain.stopChain();
    check('stopChain() 第一次返回 true（之前确实在跑）', r1 === true, String(r1));
    check('停掉后 isRunning() = false', waChain.isRunning() === false);
    check('停掉后 state().running = false', waChain.state().running === false);

    const r2 = waChain.stopChain();
    check('🔴 可重复调：第二次 stopChain() 返回 false 且不抛错', r2 === false, String(r2));
    const r3 = waChain.stopChain();
    check('第三次 stopChain() 仍然安全', r3 === false, String(r3));

    /* 重启一条干净链 */
    const fresh = buildFakes(createRecorder(), () => ({ status: 'ok', durMs: 10 }));
    const h3 = startFakeChain(fresh, { beatMs: 100, firstDelayMs: 30 });
    check('重启后拿到的是**新**句柄', h3 !== h1);
    check('重启后链上仍是 5 个实例', h3.steps.length === 5);
    const runsAtStart = waChain.state().steps.reduce((n, s) => n + s.runs, 0);
    check(`新链是干净的（刚起时 runs 合计 ${runsAtStart}）`, runsAtStart === 0, String(runsAtStart));

    await sleep(400); // 等它跑几拍
    waChain.stopChain();
    const runsAfter = waChain.state().steps.reduce((n, s) => n + s.runs, 0);
    check(`新链真的在跑（跑了几拍后 runs 合计 ${runsAfter} > 0）`, runsAfter > 0, String(runsAfter));
  }

  /* ---------------------------------------------------------------
   * [H] opt-in 开关向后兼容（🔴 防「重复采集」的关键一条）
   *     · **不传** manual ⇒ 内部定时器照挂（与 2.6.1134 一字不差）
   *     · 传 manual: true ⇒ **一个定时器都不挂**，由链驱动
   *     手法：临时把 BEE_TEST 摘掉，把 global.setTimeout / setInterval
   *           换成「记录一下就返回假句柄」的探针，看它到底挂没挂。
   * --------------------------------------------------------------- */
  console.log('\n[H] opt-in manual 开关：不传=照挂定时器，传了=不挂');

  /**
   * 在 fn 执行期间捕获所有 setTimeout / setInterval 的延时参数。
   * @returns {{timeouts:number[], intervals:number[], result:*}}
   */
  function captureTimers(fn) {
    const realTimeout = global.setTimeout;
    const realInterval = global.setInterval;
    const got = { timeouts: [], intervals: [], result: undefined };
    global.setTimeout = function probeTimeout(f, ms) {
      got.timeouts.push(ms);
      return { unref() {} };
    };
    global.setInterval = function probeInterval(f, ms) {
      got.intervals.push(ms);
      return { unref() {} };
    };
    try {
      got.result = fn();
    } finally {
      global.setTimeout = realTimeout;
      global.setInterval = realInterval;
    }
    return got;
  }

  {
    const saved = process.env.BEE_TEST;
    delete process.env.BEE_TEST; // 摘掉测试开关，才走得到「挂定时器」那条分支

    /* ---- 消息采集器 src/whatsappRead.js ---- */
    const rCfg = { key: 'qa-r', idx: 1, accId: 10, partition: 'persist:qa-r', prefix: 'qa-read', label: 'QA-R' };
    const rInst = whatsappRead.createInstance(rCfg);

    const noManual = captureTimers(() => rInst.startWatching({ findPage: () => null }));
    check(`whatsappRead：不传 manual ⇒ 内部定时器照挂（挂了 ${noManual.timeouts.length} 个 setTimeout）`,
      noManual.timeouts.length === 1, JSON.stringify(noManual.timeouts));
    check('whatsappRead：不传 manual ⇒ handle.manual === false',
      noManual.result.manual === false, String(noManual.result.manual));
    rInst.stopWatching();

    const withManual = captureTimers(() => rInst.startWatching({ manual: true, findPage: () => null }));
    check(`whatsappRead：传 manual:true ⇒ 一个定时器都不挂（timeouts=${withManual.timeouts.length}, intervals=${withManual.intervals.length}）`,
      withManual.timeouts.length === 0 && withManual.intervals.length === 0,
      JSON.stringify(withManual));
    check('whatsappRead：传 manual:true ⇒ handle.manual === true',
      withManual.result.manual === true, String(withManual.result.manual));
    rInst.stopWatching();

    /* ---- 中文气泡器 src/waBubble.js ---- */
    const bInst = waBubble.createInstance({
      key: 'qa-b', idx: 1, accId: 10, partition: 'persist:qa-b', prefix: 'qa-bub', label: 'QA-B',
    });

    const bNoManual = captureTimers(() => bInst.startWatching({ findPage: () => null }));
    check(`waBubble：不传 manual ⇒ 内部定时器照挂（setInterval ${bNoManual.intervals.length} 个 + setTimeout ${bNoManual.timeouts.length} 个）`,
      bNoManual.intervals.length === 1 && bNoManual.timeouts.length === 1,
      JSON.stringify(bNoManual));
    bInst.stopWatching();

    const bWithManual = captureTimers(() => bInst.startWatching({ manual: true, findPage: () => null }));
    check(`waBubble：传 manual:true ⇒ 一个定时器都不挂（intervals=${bWithManual.intervals.length}, timeouts=${bWithManual.timeouts.length}）`,
      bWithManual.intervals.length === 0 && bWithManual.timeouts.length === 0,
      JSON.stringify(bWithManual));
    bInst.stopWatching();

    /* ---- 等价写法 autoStart:false 也要认 ---- */
    const bAutoStart = captureTimers(() => bInst.startWatching({ autoStart: false, findPage: () => null }));
    check('waBubble：等价写法 autoStart:false 同样不挂定时器',
      bAutoStart.intervals.length === 0 && bAutoStart.timeouts.length === 0,
      JSON.stringify(bAutoStart));
    bInst.stopWatching();

    const rAutoStart = captureTimers(() => rInst.startWatching({ autoStart: false, findPage: () => null }));
    check('whatsappRead：等价写法 autoStart:false 同样不挂定时器',
      rAutoStart.timeouts.length === 0, JSON.stringify(rAutoStart.timeouts));
    rInst.stopWatching();

    /* ---- 光「不挂定时器」还不够：hooks 必须照样装好，否则链驱动的就是个空壳 ---- */
    let hookCalls = 0;
    const hInst = whatsappRead.createInstance({
      key: 'qa-h', idx: 1, accId: 10, partition: 'persist:qa-h', prefix: 'qa-hook', label: 'QA-H',
    });
    captureTimers(() => hInst.startWatching({
      manual: true,
      findPage: () => null,
      onState: () => { hookCalls += 1; },
    }));
    check('🔴 传 manual:true 时 hooks 照样装好（onState 被回调到）', hookCalls >= 1, String(hookCalls));
    hInst.stopWatching();

    let bWatch = null;
    const bWatchInst = waBubble.createInstance({
      key: 'qa-w', idx: 1, accId: 10, partition: 'persist:qa-w', prefix: 'qa-watch', label: 'QA-W',
    });
    bWatch = captureTimers(() => bWatchInst.startWatching({ manual: true, findPage: () => null }));
    check('🔴 waBubble 传 manual:true 时 watching 仍置为 true（hooks 装好）',
      bWatch.result && bWatch.result.watching === true, JSON.stringify(bWatch.result));
    bWatchInst.stopWatching();

    process.env.BEE_TEST = saved; // 🔴 一定还原，别影响后面的用例
  }

  /* ---------------------------------------------------------------
   * [J] 主进程接线（静态检查 src/main.js）
   *     🔴 改了链却没在 main.js 里把实例切成 manual ⇒ 就是「链跑一遍 + 定时器再跑一遍」。
   *        这里把接线钉死，防止以后有人把 manual:true 删掉。
   * --------------------------------------------------------------- */
  console.log('\n[J] 主进程接线（src/main.js 静态检查）');
  {
    const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

    check("main.js 里 require('./waChain')", /require\('\.\/waChain'\)/.test(mainJs));
    check('main.js 里定义了 startWaWebChain()', /function startWaWebChain\(\)/.test(mainJs));
    check('main.js 里调了 startWaWebChain()', /startWaWebChain\(\);/.test(mainJs));

    const manualCount = (mainJs.match(/manual:\s*true/g) || []).length;
    check(`消息循环 + 气泡循环都传了 manual:true（实测 ${manualCount} 处 ≥ 2）`, manualCount >= 2);

    /* 🔴 顺序：必须在气泡 hooks 装好**之后**才起链，否则气泡那半边没东西可驱动 */
    const iBubbleLoop = mainJs.indexOf('inst.startWatching({');
    const iChainCall = mainJs.indexOf('startWaWebChain();');
    check(`起链在气泡 hooks 之后（气泡 ${iBubbleLoop} < 起链 ${iChainCall}）`,
      iBubbleLoop > 0 && iChainCall > iBubbleLoop);

    check('起链时把 5 个消息实例交给了链', /readerFactory:\s*\(cfg\)\s*=>\s*whatsappRead\.getInstance/.test(mainJs)
      || /whatsappRead\.getInstance/.test(mainJs));
    check('起链时把 5 个气泡实例交给了链', /bubbleFactory:\s*\(cfg\)\s*=>\s*waBubble\.getInstance/.test(mainJs)
      || /waBubble\.getInstance/.test(mainJs));
  }

  /* ---------------------------------------------------------------
   * [I] describe() 输出形状（界面状态条直接用）
   * --------------------------------------------------------------- */
  console.log('\n[I] describe() 输出形状');
  {
    const d = waChain.describe();
    check('describe() 返回 {level, text}', typeof d.level === 'string' && typeof d.text === 'string',
      JSON.stringify(d));
    check('未启动时文案为「未启动」', /未启动/.test(d.text), d.text);
  }

  /* 收尾：放行所有假卡住的 sleep，免得测试进程被拖着不退出 */
  releaseAllPending();

  console.log(`\n[WA①~⑤ 串联调度链自检] 通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
})();
