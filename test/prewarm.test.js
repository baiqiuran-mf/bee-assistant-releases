/**
 * 预热闸门 · 扫描节奏 自测（v2.5.1036）
 *
 * 老板 2026-10-11 的规矩，本文件逐条钉死：
 *   ① 登录 + 同步走完之前，任何预热都不许动（总闸 prewarm.arm()）；
 *   ② 进程扫描：没点「启动」→ 一次都不扫；点了「启动」→ 观察期 2 秒一次；
 *      全绿后 → 稳定期 611 秒一次；
 *   ③ 每次扫描独占静默窗口：扫描前 3 秒 + 扫描后 1 秒，别的预热全让路。
 *
 * 跑法：node --experimental-sqlite test/prewarm.test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const prewarm = require('../src/prewarm');
const launcher = require('../src/launcher');
const signalStatus = require('../src/signalStatus');
const loopBeat = require('../src/loops');

let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + extra : ''}`); }
}
const src = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
/*
 * 剥掉注释行再断言（v2.5.1037）：
 *   源码级断言最容易被自己写的说明文字骗过去 —— 比如注释里写着
 *   「已经不再调 signalStatus.startBackgroundRefresh」，正则照样能匹配到。
 *   所以检查"某个调用还在不在"时，一律只看真正的代码行。
 */
const code = (f) => src(f).split('\n')
  .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  .join('\n');

(async () => {
  console.log('\n=== 预热总闸 · 未登录前一律不许动 ===');
  prewarm._reset();
  check('默认状态：总闸没开（ready=false）', prewarm.ready() === false);
  {
    const g = prewarm.gate();
    check('总闸没开 → gate() 一律让路（skip=true）', g.skip === true);
    check('让路原因标得明白（owner=not-ready）', g.owner === 'not-ready');
    check('让路时建议 5 秒后再试', g.retryInMs === 5000);
  }
  {
    /*
     * 🔴 v2.5.1037（老板拍板）：「检测 Signal 有没有开、有没有登录」这条预热整条删除。
     *    所以这里断言的是：**detection 变成了纯只读缓存** —— 没缓存就回占位，
     *    绝不因为一次接口调用就去起 PowerShell / 开 SQLCipher 库。
     */
    const s = signalStatus.detectCached(false);
    check('总闸没开 → Signal 检测回占位，不偷偷起进程',
      !!s && s.state === 'red' && /未检测/.test(s.reason || '') && s.idle === true,
      JSON.stringify(s));
  }
  {
    const st = launcher.scanStatus();
    check('总闸没开 → launcher 扫描状态里也是未就绪', st.gate.ready === false);
  }

  console.log('\n=== 开总闸（登录 + 同步完成后才调） ===');
  prewarm.arm();
  check('arm() 之后 ready=true', prewarm.ready() === true);
  check('开闸且没人占着 → gate() 放行（skip=false）', prewarm.gate().skip === false);
  check('开闸后 blocked()=false', prewarm.blocked() === false);

  console.log('\n=== 静默窗口：扫描前 3 秒 + 扫描后 1 秒 ===');
  prewarm.hold(3000, 'test-scan');
  check('占住 3 秒 → blocked()=true', prewarm.blocked() === true);
  {
    const g = prewarm.gate();
    check('闸门关着 → 别的预热跳过本轮（skip=true）', g.skip === true);
    check('占用者名字带上了（test-scan）', g.owner === 'test-scan');
    check('重试时间 ≈ 剩余时间 + 200ms', g.retryInMs > 2800 && g.retryInMs <= 3200, String(g.retryInMs));
  }
  check('remaining() 在 0~3000 之间', prewarm.remaining() > 0 && prewarm.remaining() <= 3000);
  // 只延后、不提前
  prewarm.holdUntil(Date.now() + 500, 'test-short');
  check('后来的短占用不会缩短已占住的窗口（只延后不提前）', prewarm.remaining() > 2400, String(prewarm.remaining()));

  console.log('\n=== launcher 扫描节奏 · 常量与懒启动 ===');
  {
    const lj = src('launcher.js');
    check('稳定期扫描间隔 = 611 秒（SCAN_PERIOD_MS = 611000）', /const SCAN_PERIOD_MS = 611000;/.test(lj));
    check('扫描前静默 = 3 秒（SCAN_LEAD_MS = 3000）', /const SCAN_LEAD_MS = 3000;/.test(lj));
    check('扫描后静默 = 1 秒（SCAN_TAIL_MS = 1000）', /const SCAN_TAIL_MS = 1000;/.test(lj));
    check('观察期扫描间隔 = 2 秒（OBSERVE_MS = 2000）', /const OBSERVE_MS = 2000;/.test(lj));
    check('观察期最长 3 分钟后自动退回稳定期', /const OBSERVE_MAX_MS = 180000;/.test(lj));
    check('扫描前先压闸门（prewarm.hold(SCAN_LEAD_MS...）', /prewarm\.hold\(SCAN_LEAD_MS, 'launcher-scan'\)/.test(lj));
    check('扫描后再压 1 秒闸门（prewarm.hold(SCAN_TAIL_MS...）', /prewarm\.hold\(SCAN_TAIL_MS, 'launcher-scan'\)/.test(lj));
    check('稳定期下一轮 = 611 秒 - 本轮耗时（扫描到扫描正好 611 秒）',
      /SCAN_PERIOD_MS - \(Date\.now\(\) - cycleStart\)/.test(lj));
    check('没点过「启动」→ 扫描周期直接跳过，一次都不扫',
      /if \(!_armed\) \{\s*\n\s*scheduleScan\(SCAN_PERIOD_MS\);\s*\n\s*return;/.test(lj));
    check('后台刷新启动时：没 armed 就【不】先扫一轮（旧版是进来就扫）',
      /if \(_armed\) scanOnce\(\)/.test(lj));
  }

  console.log('\n=== 运行时：未点「启动」时一次都不扫 ===');
  {
    launcher._resetCache();
    launcher.init({ launchers: {} });      // 只建表，不扫
    const before = launcher.scanStatus().scans;
    await new Promise((r) => setTimeout(r, 1500)); // 等一会儿，确认后台没偷偷扫
    const after = launcher.scanStatus().scans;
    check(`未点「启动」时扫描次数为 0（before=${before} after=${after}）`, after === 0);
    const states = launcher.launcherStates(false);
    check('未点「启动」时三盏灯都是红灯（"未启动"）',
      Array.isArray(states) && states.length === 3 && states.every((s) => s.status === 'red'),
      JSON.stringify(states));
    check('状态文案写的是「未启动」，不是「检测中」',
      states.every((s) => /未启动/.test(s.title)), JSON.stringify(states.map((s) => s.title)));
  }

  console.log('\n=== 运行时：点了「启动」才进观察期，并开始扫描 ===');
  {
    launcher._markUserStarted();
    const st1 = launcher.scanStatus();
    check('markUserStarted 后 armed=true', st1.armed === true);
    check('markUserStarted 后进入观察期（observing=true）', st1.observing === true);
    check('观察期窗口 ≤ 3 分钟', st1.observeLeftMs > 0 && st1.observeLeftMs <= 180000);
    check('观察期扫描间隔是 2 秒', /const OBSERVE_MS = 2000;/.test(src('launcher.js')));
  }

  console.log('\n=== 让路：闸门关着时，等一会儿就放行（不会卡死） ===');
  {
    prewarm._reset();
    prewarm.arm();
    prewarm.hold(600, 'short-hold');
    const t0 = Date.now();
    const ok = await prewarm.waitUntilFree(5000);
    const cost = Date.now() - t0;
    check('闸门关着时 waitUntilFree 会等（返回 true）', ok === true);
    check(`等待时长 ≈ 闸门剩余时间（${cost}ms，约 600ms 上下）`, cost >= 400 && cost <= 2000, String(cost));
  }
  {
    prewarm._reset();
    prewarm.arm();
    prewarm.hold(9000, 'long-hold');                 // 故意给一个超过超时的占用
    const t0 = Date.now();
    const ok = await prewarm.waitUntilFree(800);      // 超时 0.8 秒
    const cost = Date.now() - t0;
    check('等超时就照常返回、绝不卡死', cost < 3000, String(cost));
    check('超时后返回的是"还在闸着"（false），调用方自己决定要不要照做', ok === false);
    prewarm._reset();
  }

  console.log('\n=== 总闸兜底：采集 / Word / Telegram 都认这把闸 ===');
  {
    const sj = src('signalStatus.js');
    const rj = src('signalRead.js');
    const mj = src('main.js');
    /*
     * 🔴 v2.5.1037（老板拍板）：Signal 登录检测那条预热整条删掉，
     *    所以断言反过来 —— signalStatus.js 里**不许再有任何后台定时器**，
     *    也不许再 require 闸门（没定时任务就不需要问闸）。
     */
    const cj = code('signalStatus.js');
    check('signalStatus 已经没有 startBackgroundRefresh（预热已清理）',
      !/function startBackgroundRefresh/.test(cj), 'signalStatus.js 里还留着后台刷新');
    check('signalStatus 已经没有 tickRefresh / scheduleRefresh 定时器链',
      !/function tickRefresh|function scheduleRefresh/.test(cj));
    check('signalStatus 不再 require 闸门（没有定时任务了）',
      !/require\('\.\/prewarm'\)/.test(cj));
    check('signalStatus 仍保留显式刷新入口 refreshNow（手动 / 采集按需调用）',
      /function refreshNow/.test(cj));
    check('main.js 不再调 signalStatus.startBackgroundRefresh',
      !/signalStatus\.startBackgroundRefresh/.test(code('main.js')), 'main.js 还在起 Signal 检测定时器');
    check('launcher 算灯时不再调 signalStatus.detectCached（改成只看进程）',
      !/signalStatus\.detectCached/.test(code('launcher.js')));
    check('signalRead.startPolling 支持 shouldRun 钩子', /shouldRun = null/.test(rj));
    check('signalRead 被闸住时跳过本轮（水位不动，不丢消息）', /if \(!go\) \{\s*\n\s*timer = setTimeout\(tick, 1000\);/.test(rj));
    check('main.js 给 Signal 采集挂上了 shouldRun', /shouldRun: \(\) => prewarm\.ready\(\) && !prewarm\.blocked\(\)/.test(mj));
    check('main.js 在拉起各路预热前先 prewarm.arm()', /prewarm\.arm\(\);/.test(mj));
    check('main.js 开 Telegram 窗口前等闸门让路', /await prewarm\.waitUntilFree\(/.test(mj));
    const wj = src('wordDoc.js');
    check('wordDoc 每小时重建给闸门让路', /if \(g\.skip\) \{\s*\n\s*const t = setTimeout\(tickOnce/.test(wj));
  }

  console.log('\n=== v2.5.1039 · 三个循环（照老板桌面图逐条钉死） ===');
  {
    const mj = code('main.js');
    const lj = code('launcher.js');
    const tj = code('telegramRead.js');
    const oj = code('loops.js');

    // 循环①：登录同步完 → 每 3 秒一轮 Telegram 开 Chrome 预热 → 任一绿灯停
    check('节拍 = 3 秒（BEAT_MS = 3000）', /const BEAT_MS = 3000;/.test(oj));
    check('main.js 用节拍器起循环①/②（loopBeat.createLoops）', /loopBeat\.createLoops\(\{/.test(mj));
    check('循环① 起手就是 Telegram 预热（ensureTelegram）', /ensureTelegram,/.test(mj));
    check('循环① 停止条件 = S1~S3 任一绿灯（只读缓存，不催扫描）',
      /anyGreen: \(\) => launcher\.anySignalGreenCached\(\)/.test(mj));
    {
      const iA = lj.indexOf('function anySignalGreenCached');
      const iB = lj.indexOf('function beginStableRhythm');
      const body = (iA > -1 && iB > iA) ? lj.slice(iA, iB) : '';
      check('anySignalGreenCached 内部绝不 refreshNow（否则 3 秒问一次=3 秒扫一次）',
        body.length > 0 && !/refreshNow\(/.test(body), 'anySignalGreenCached 里出现了刷新调用');
    }

    // 循环②：Signal 消息采集 + Telegram 预热，每 3 秒一轮
    check('循环② 里起 Signal 消息采集', /startSignal: \(\) => \{ doStartSignal\(\); \}/.test(mj));
    check('循环② 起来时把 611 秒计时归零（launcher.beginStableRhythm）',
      /onStableRhythm: \(\) => \{/.test(mj) && /launcher\.beginStableRhythm\(\)/.test(mj));
    check('beginStableRhythm：第一枪排在 611-3=608 秒后（此后每 611 秒）',
      /function beginStableRhythm/.test(lj) && /const firstScanInMs = Math\.max\(1000, SCAN_PERIOD_MS - SCAN_LEAD_MS\)/.test(lj));
    check('循环每轮先问闸门：被扫描占住 → 整轮跳过（图上"停下 → 扫描 → 等 1 秒 → 继续"）',
      /const g = prewarm\.gate\(\);\s*\n\s*if \(g\.skip\) \{\s*\n\s*stat\.beatsSkipped \+= 1;/.test(oj));
    check('循环② 与循环① 是串行交接（循环① 停 → enterLoop2）',
      /if \(green\) enterLoop2\(\);/.test(oj));

    // 循环③：扫描计时器仍在，且未启动零扫
    check('循环③（扫进程）仍由 launcher.startBackgroundRefresh 起', /launcher\.startBackgroundRefresh\(\)/.test(mj));

    // Telegram 预热：幂等保活
    check('Telegram 预热是幂等的（ensureWatching，已经在跑就不动）',
      /async function ensureWatching/.test(tj) && /if \(isRunning\(acc\.id\)\) continue;/.test(tj));
    check('Telegram 预热开前仍先等闸门让路（waitUntilFree）', /await prewarm\.waitUntilFree\(30000\)/.test(mj));
    check('Telegram 收消息时仍给扫描让路（blocked 时跳过本轮，不丢消息）',
      /if \(prewarm\.blocked\(\)\) return;/.test(mj));

    // ⑤ Word：不在三个循环里，但循环② 起跑后 3 秒要起，另有 60 秒兜底
    check('⑤ Word 在循环② 起跑后延迟 3 秒起', /wordScheduled = true;/.test(mj) && /\}, 3000\);/.test(mj));
    check('⑤ Word 有 60 秒兜底（一直没绿灯也不耽误重建档案）', /\}, 60000\);/.test(mj));
  }

  console.log('\n=== 循环节拍器 · 运行时（把节拍压到 20ms 跑一遍） ===');
  {
    prewarm._reset();
    prewarm.arm();
    let tg = 0, signalStarts = 0, rhythm = 0, green = false;
    const loops = loopBeat.createLoops({
      intervalMs: 20,
      ensureTelegram: async () => { tg += 1; },
      startSignal: () => { signalStarts += 1; },
      anyGreen: () => green,
      onStableRhythm: () => { rhythm += 1; },
      log: () => {},
    });
    check('起始 phase = idle（没起之前什么都不做）', loops.state().phase === 'idle');
    loops.start();
    check('start() 后进循环①', loops.state().phase === 'loop1');

    await new Promise((r) => setTimeout(r, 140));
    const s1 = loops.state();
    check(`循环① 每轮都在做 Telegram 预热（轮数 ${s1.beats1} ≥ 2）`, s1.beats1 >= 2 && tg >= 2);
    check('还没绿灯 → Signal 采集绝不起（循环② 不启动）', signalStarts === 0 && s1.phase === 'loop1');

    green = true;
    await new Promise((r) => setTimeout(r, 140));
    const s2 = loops.state();
    check('任一绿灯 → 循环① 停、循环② 起', s2.phase === 'loop2');
    check('循环② 里 Signal 采集只起一次（防重入）', signalStarts === 1);
    check('循环② 起点把 611 秒计时归零一次', rhythm === 1);
    check(`循环② 继续每轮做 Telegram 预热（轮数 ${s2.beats2} ≥ 2）`, s2.beats2 >= 2);

    // 「跑到 611 秒后停下…等待 1 秒，继续循环②」——用闸门模拟扫描窗口
    prewarm.hold(300, 'test-scan');
    await new Promise((r) => setTimeout(r, 80)); // 让在飞的那一拍落地
    const b2 = loops.state().beats2;
    await new Promise((r) => setTimeout(r, 150));
    const s3 = loops.state();
    check(`闸门关着时循环② 整轮跳过、轮数不涨（${b2} → ${s3.beats2}）`, s3.beats2 === b2);
    check(`跳过有记账（beatsSkipped=${s3.beatsSkipped} > 0）`, s3.beatsSkipped > 0);

    prewarm._reset(); // 放闸（_reset 会把闸门清空）
    prewarm.arm();
    await new Promise((r) => setTimeout(r, 150));
    check(`闸门一开 → 循环② 自动接上（轮数 ${loops.state().beats2} > ${b2}）`, loops.state().beats2 > b2);

    loops.stop();
    const fin = loops.state().beats2;
    await new Promise((r) => setTimeout(r, 100));
    check('stop() 之后彻底不动了', loops.state().beats2 === fin);
  }

  console.log(`\n========== 预热闸门自检：${pass} 通过 / ${failures.length} 失败 ==========`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
})();
