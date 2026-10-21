/**
 * v121_update_poll.test.js —— 钉死「点检查更新后一直卡在检查中」这个 bug。
 *
 * 2026-10-11 老板报："同样都是新版本，检查更新都是同个版本的直接提示已经最新版本就可以，
 * 怎么还一直再检查。"
 *
 * 根因：public/settings.js 的 upPoll() 第一句是 `if (upBusy) return`，而 upBusy 在点击
 * 「检查更新」时就设为 true → 轮询每拍都在第一行 return，永远读不到后端状态，upBusy 也
 * 永远复位不了，只能熬到硬超时。本测试复刻该控制流，证明：
 *   - 旧逻辑（带 if (upBusy) return）：后端回 latest，UI 仍停在"正在检查更新…"（bug 复现）
 *   - 新逻辑（去掉那行）：后端回 latest，UI 立刻变"已经是最新版本"且 upBusy 复位（已修）
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const update = require('../src/update.js');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✅ ' + msg); }
  else { failed++; console.log('  ❌ ' + msg); }
}

/* ---------- 1. 后端纯逻辑：同版本走 'latest' 分支 ---------- */
console.log('① 后端 compareVersions：同版本应判为「已是最新」');
ok(update.compareVersions('2.5.1042', '2.5.1042') === 0, '同版本 compareVersions 返回 0');
ok(update.compareVersions('2.5.1042', '2.5.1041') > 0, '新版本 > 旧版本');
ok(update.compareVersions('2.5.1041', '2.5.1042') < 0, '旧版本 < 新版本');

/* ---------- 2. 前端轮询控制流复刻（真实 settings.js 逻辑）---------- */

// 极简 DOM 桩
function makeUI() {
  const els = {};
  const mk = () => ({ textContent: '', innerHTML: '', classList: { add() {}, remove() {} }, style: {} });
  ['up-state', 'up-bar', 'up-fill', 'up-install', 'up-note'].forEach((k) => (els[k] = mk()));
  return {
    ui: els,
    upSetState(text) { els['up-state'].innerHTML = String(text); },
    getState() { return els['up-state'].innerHTML; },
  };
}

// 模拟 fetch('/api/update/status') 返回的后端状态
function makeBackend(statusObj) {
  return {
    status: statusObj,
    fetchStatus() { return this.status; }, // 复刻 `await fetch(...).then(r=>r.json())` 的同步等价
  };
}

/**
 * 复刻 upPoll 的核心一拍。variant='old' 带 bug 行；variant='new' 已修。
 * 返回 { tick, click }，tick() 模拟一次 1.2s 轮询；click() 模拟点击「检查更新」。
 */
function makePoll(variant, ui, backend) {
  let upPollTimer = null;
  let upBusy = false;
  const HARD_TIMEOUT_MS = 45000;
  const startedAt = Date.now();

  function tick() {
    // —— 旧版 bug：upBusy 在点击时已是 true，这里直接 return，永远读不到后端 ——
    if (variant === 'old' && upBusy) return;
    if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
      ui.upSetState('检查更新等待超时（超过 45 秒）。请检查网络能否连上 GitHub，或到项目下载安装包手动安装。');
      upBusy = false;
      return;
    }
    const r = backend.fetchStatus();
    if (!r || !r.ok) return;
    if (r.state === 'downloading') { /* upSetBar */ }
    if (r.state === 'downloaded') {
      ui.upSetState(r.text || '下载完成。'); upBusy = false;
    }
    if (r.state === 'error' || r.state === 'latest' || r.state === 'done') {
      ui.upSetState(r.text || (r.state === 'done' ? '检查完成。' : ''));
      upBusy = false;
    }
  }

  function click() {
    upBusy = true;
    ui.upSetState('正在检查更新…');
    // 真实代码：POST /api/update/check 立刻返回 ok:true，然后 upPoll()
    tick(); // 第一拍（真实里是 1.2s 后，这里直接拉一拍模拟）
  }

  return {
    click,
    tick,
    isBusy() { return upBusy; },
  };
}

console.log('② 旧逻辑（带 if (upBusy) return）：后端回 latest，UI 却永远停在「正在检查更新…」');
{
  const ui = makeUI();
  const backend = makeBackend({ ok: true, state: 'latest', text: '已经是最新版本。' });
  const poll = makePoll('old', ui, backend);
  poll.click();
  // 模拟用户等了 5 拍轮询（后端一直是 latest）
  for (let i = 0; i < 5; i++) poll.tick();
  ok(ui.getState() === '正在检查更新…', '旧逻辑：5 拍后 UI 仍显示「正在检查更新…」（bug 复现）');
  ok(poll.isBusy() === true, '旧逻辑：upBusy 永远没复位（卡死）');
}

console.log('③ 新逻辑（去掉那行）：后端回 latest，UI 立刻变「已经是最新版本」');
{
  const ui = makeUI();
  const backend = makeBackend({ ok: true, state: 'latest', text: '已经是最新版本。' });
  const poll = makePoll('new', ui, backend);
  poll.click();
  for (let i = 0; i < 5; i++) poll.tick();
  ok(ui.getState() === '已经是最新版本。', '新逻辑：UI 立刻显示「已经是最新版本。」');
  ok(poll.isBusy() === false, '新逻辑：upBusy 已复位（轮询停止）');
}

console.log('④ 新逻辑：后端回 error（真连不上），也应给出终态而非一直转');
{
  const ui = makeUI();
  const backend = makeBackend({ ok: true, state: 'error', text: '更新失败：网络超时' });
  const poll = makePoll('new', ui, backend);
  poll.click();
  for (let i = 0; i < 3; i++) poll.tick();
  ok(ui.getState() === '更新失败：网络超时', '新逻辑：error 终态正确显示');
  ok(poll.isBusy() === false, '新逻辑：error 后 upBusy 复位');
}

/* ---------- 3. 静态断言：改动确实落在真实文件里 ---------- */
console.log('⑤ 静态断言：真实文件已改对');
{
  const settingsPath = path.join(__dirname, '..', 'public', 'settings.js');
  const updatePath = path.join(__dirname, '..', 'src', 'update.js');
  const settings = fs.readFileSync(settingsPath, 'utf8');
  const upd = fs.readFileSync(updatePath, 'utf8');

  // 在 upPoll 函数体内不应再有「if (upBusy) return;」
  const pollFn = settings.slice(settings.indexOf('function upPoll'));
  ok(!/if\s*\(\s*upBusy\s*\)\s*return;/.test(pollFn.slice(0, 600)),
    'settings.js · upPoll 内已移除 `if (upBusy) return`');
  // 前端硬超时改成 45000
  ok(/HARD_TIMEOUT_MS\s*=\s*45000/.test(settings), 'settings.js · 前端硬超时 = 45000');
  // 后端看门狗改成 30000
  ok(/setTimeout\([^]*?30000\)/.test(upd) || /,\s*30000\)/.test(upd), 'update.js · 后端看门狗 = 30000');
  // publishTarget 仍回退读 app-update.yml（来自 1041 的修复不能丢）
  ok(/readPackagedUpdateConfig/.test(upd), 'update.js · 回退读 app-update.yml 逻辑仍在');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
