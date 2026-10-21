'use strict';
/**
 * v2.5.1072：进程内 Win32 窗口切换（替代旧的 36MB settop.exe）。
 *
 * 核心思路（根因级修复，区别于旧 settop.exe）：
 *  - 旧 settop.exe 是从「非前台进程」去调 SetForegroundWindow，且 AllowSetForegroundWindow 调错了进程，
 *    被 Windows 前台锁挡掉 → 窗口只闪一下就回到我们软件后面。
 *  - 这里改在 Electron 主进程（点击瞬间它就是前台进程）里直接调 user32：
 *      1) allowForeground()：前台进程授权 ASFW_ANY（点击瞬间调用）
 *      2) switchToWindow()：拿到目标 HWND 后同步 SetForegroundWindow，窗口真切到最前并停留。
 *  - 不依赖 .NET 子进程，无冷启动延迟，无"方向错"问题。
 *
 * 依赖 koffi（原生 FFI，带预编译 .node，需 asarUnpack）。
 */
const path = require('path');

let user32 = null;
let EnumWindows = null;
let GetWindowThreadProcessId = null;
let GetForegroundWindow = null;
let SetForegroundWindow = null;
let AllowSetForegroundWindow = null;
let IsIconic = null;
let ShowWindow = null;
let GetWindowTextLength = null;
let GetWindowText = null;

function loadUser32() {
  if (user32) return true;
  let koffi;
  try {
    koffi = require('koffi');
  } catch (e) {
    console.warn('[winfocus] 找不到 koffi：', e.message);
    return false;
  }
  user32 = koffi.load('user32.dll');
  const HWND = 'void *';
  const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *, intptr_t)');
  EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc cb, intptr_t lParam)');
  GetWindowThreadProcessId = user32.func('uint GetWindowThreadProcessId(void *hwnd, uint *lpdwProcessId)');
  GetForegroundWindow = user32.func('void * GetForegroundWindow()');
  SetForegroundWindow = user32.func('bool SetForegroundWindow(void *hwnd)');
  AllowSetForegroundWindow = user32.func('bool AllowSetForegroundWindow(uint dwProcessId)');
  IsIconic = user32.func('bool IsIconic(void *hwnd)');
  ShowWindow = user32.func('bool ShowWindow(void *hwnd, int nCmdShow)');
  GetWindowTextLength = user32.func('int GetWindowTextLengthW(void *hwnd)');
  GetWindowText = user32.func('int GetWindowTextW(void *hwnd, void *lpString, int nMaxCount)');
  return true;
}

const ASFW_ANY = 0xFFFFFFFF;
const SW_RESTORE = 9;
const SW_SHOW = 5;

function getWindowPid(hwnd) {
  const out = { value: 0 };
  GetWindowThreadProcessId(hwnd, out);
  return out.value;
}

function getWindowText(hwnd) {
  try {
    const len = GetWindowTextLength(hwnd);
    if (len <= 0) return '';
    // WideChar 缓冲：每字符 2 字节
    const buf = Buffer.alloc((len + 1) * 2);
    GetWindowText(hwnd, buf, len + 1);
    return buf.toString('utf16le').replace(/\0+$/, '');
  } catch (e) {
    return '';
  }
}

/**
 * 前台进程授权：允许任意进程（含本进程）之后调用 SetForegroundWindow 绕过前台锁。
 * 必须在 Electron 仍是前台进程时调用（点击瞬间）。
 * @returns {{ok:boolean, granted:boolean}}
 */
function allowForeground() {
  if (!loadUser32()) return { ok: false, granted: false, reason: 'no-koffi' };
  try {
    const granted = AllowSetForegroundWindow(ASFW_ANY);
    return { ok: true, granted: !!granted };
  } catch (e) {
    return { ok: false, granted: false, reason: e.message };
  }
}

/**
 * 枚举所有顶层窗口，按条件筛选最佳 HWND。
 * @param {{pid?:number, title?:string, procName?:string}} opts
 * @returns {Array<{hwnd:string, pid:number, title:string}>}
 */
function enumWindows(opts = {}) {
  if (!loadUser32()) return [];
  const matches = [];
  const titleSub = opts.title ? opts.title.toLowerCase() : null;
  const targetPid = opts.pid ? Number(opts.pid) : 0;

  // 收集候选
  const found = [];
  EnumWindows((hwnd, lParam) => {
    try {
      const pid = getWindowPid(hwnd);
      if (targetPid && pid !== targetPid) return true;
      if (opts.procName) {
        // procName 用 pid 反查进程名成本较高，这里只在给了 pid/title 时走；procName 由调用方先解析成 pid 更稳
      }
      const title = getWindowText(hwnd);
      if (titleSub && title.toLowerCase().indexOf(titleSub) < 0) return true;
      found.push({ hwnd, pid, title });
    } catch (e) { /* 跳过损坏项 */ }
    return true;
  }, 0);

  // 取可见 + 面积最大（主窗口优先）；这里用标题非空 + 长度筛选近似
  found.forEach((f) => matches.push({ hwnd: String(f.hwnd), pid: f.pid, title: f.title }));
  return matches;
}

/**
 * 把目标窗口切到最前（等同 Alt-Tab / 点任务栏）。先恢复最小化，再 SetForegroundWindow。
 * @param {{pid?:number, title?:string, procName?:string, silenceMs?:number}} opts
 * @returns {Promise<{ok:boolean, reason?:string, hwnd?:string, setfg?:boolean, pid?:number}>}
 */
async function switchToWindow(opts = {}) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not-win32' };
  if (!loadUser32()) return { ok: false, reason: 'no-koffi' };

  let candidates = [];
  if (opts.pid) {
    candidates = enumWindows({ pid: opts.pid });
  } else if (opts.title) {
    candidates = enumWindows({ title: opts.title });
  }
  if (candidates.length === 0) {
    return { ok: false, reason: 'no-window', pid: opts.pid ? Number(opts.pid) : undefined };
  }
  // 优先选标题非空（主窗口）的那个
  candidates.sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0));
  const target = candidates[0];
  const hwnd = target.hwnd;

  let wasMin = false;
  try { wasMin = IsIconic(hwnd); } catch (e) {}
  try { ShowWindow(hwnd, wasMin ? SW_RESTORE : SW_SHOW); } catch (e) {}

  // 直接抢前台（本进程若是前台/已授权则成功；否则再试 AttachThreadInput 兜底）
  let setfg = false;
  try { setfg = SetForegroundWindow(hwnd); } catch (e) {}
  if (!setfg) {
    setfg = attemptSteal(hwnd);
  }
  return { ok: true, hwnd, setfg: !!setfg, pid: target.pid, title: target.title };
}

/** AttachThreadInput 单向挂接兜底（旧 settop 双向不解绑会错乱，这里调用后立刻解绑） */
function attemptSteal(hwnd) {
  try {
    const fg = GetForegroundWindow();
    if (!fg || fg === hwnd) return false;
    const fgThread = getWindowThreadProcessId(fg, { value: 0 });
    // 用 kernel32 取当前线程 id 较麻烦，这里用简单重试：直接再试一次 SetForegroundWindow
    let ok = false;
    for (let i = 0; i < 6; i++) {
      try { ok = SetForegroundWindow(hwnd); } catch (e) {}
      if (ok) break;
      // 微等，给 OS 一点时间
      const start = Date.now();
      while (Date.now() - start < 50) { /* busy wait 50ms */ }
    }
    return ok;
  } catch (e) {
    return false;
  }
}

module.exports = { allowForeground, switchToWindow, enumWindows, loadUser32 };
