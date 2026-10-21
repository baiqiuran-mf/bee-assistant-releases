/**
 * 桌面入口自检：electron/main.js 必须真的走到「开窗口」这一步
 *
 * 用 Electron 桩把 main.js 完整跑一遍：
 *   - app.whenReady() 立即 resolve
 *   - BrowserWindow 记账，看有没有被创建、loadURL 了什么
 *   - dialog.showErrorBox 记账，一旦被调用说明启动失败
 *   - src/session 换成桩，测试不真起 Chrome、不联网
 *
 * 这条测试的直接动机：startDesktop 里重复 listen 后端 → ERR_SERVER_ALREADY_LISTEN
 * → createWindow 永远执行不到 → 用户只看到终端里一个二维码，窗口一直不出来。
 */
const { DIR } = require('./_isolate.js'); // 必须第一行：隔离数据目录，不碰真实 data/
const path = require('path');
const Module = require('module');

/* ---- 1) 把 src/session 换成桩：不真起浏览器 ---- */
const sessionPath = require.resolve('../src/session');
require.cache[sessionPath] = {
  id: sessionPath, filename: sessionPath, loaded: true, children: [], paths: [],
  exports: {
    createSession: async () => { throw new Error('测试桩：不真起浏览器'); },
    splitProxy: () => ({ url: null, auth: null }),
  },
};

/* ---- 2) Electron 桩 ---- */
const windows = [];
const dialogs = [];
class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts;
    this.url = null;
    this.events = {};
    this.cacheCleared = false;
    this.forcedReloads = 0;
    this.webContents = {
      session: { clearCache: () => { this.cacheCleared = true; } },
      on: (evt, fn) => { this.events[evt] = fn; },
      reloadIgnoringCache: () => { this.forcedReloads += 1; },
    };
    windows.push(this);
  }
  loadURL(u) { this.url = u; return Promise.resolve(); }
  on(evt, fn) { this.events[evt] = fn; }
  close() { this.closed = true; if (this.events.closed) this.events.closed(); }
  isDestroyed() { return !!this.closed; }
  isMinimized() { return false; }
  show() {}
  focus() {}
  restore() {}
  static getAllWindows() { return windows; }
}
const ipcHandlers = {};
const fakeElectron = {
  app: { whenReady: () => Promise.resolve(), on() {}, quit() {} },
  BrowserWindow: Object.assign(
    function (opts) { return new FakeBrowserWindow(opts); },
    { getAllWindows: () => windows }
  ),
  dialog: { showErrorBox: (title, msg) => dialogs.push({ title, msg }) },
  // 话术编排台的独立浮窗靠 ipcMain 通道打开（board:open / board:sync / board:close）
  ipcMain: { handle: (channel, fn) => { ipcHandlers[channel] = fn; } },
};

/* ---- 3) 骗过 require('electron') ---- */
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
};

(async () => {
  console.log(`[桌面入口自检] 数据目录：${DIR}`);

  require('../electron/main.js');
  // 等 startDesktop 把窗口开出来（挂起的 WhatsApp 会话在后台，不影响）
  await new Promise((r) => setTimeout(r, 2500));

  check('桌面入口没有弹「启动失败」错误框', dialogs.length === 0,
    dialogs.map((d) => d.title + ' / ' + String(d.msg).slice(0, 160)).join(' | '));
  check('BrowserWindow 真的被创建了（窗口能打开）', windows.length === 1, `实际 ${windows.length} 个`);
  check('窗口加载的是本地后端的首页（不是网址/浏览器）',
    !!windows[0] && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(windows[0].url || ''),
    windows[0] && windows[0].url);
  check('窗口标题是「蜜蜂信息采集」', !!windows[0] && windows[0].opts.title === '蜜蜂信息采集');

  // 窗口加载的那个地址必须真的能打开
  if (windows[0] && windows[0].url) {
    try {
      const r = await fetch(windows[0].url);
      check('窗口地址真的能打开（HTTP 200）', r.status === 200, 'status=' + r.status);
      const cc = r.headers.get('cache-control') || '';
      check('首页明确不缓存（no-store）—— 防「改了界面窗口还是旧的」', /no-store/.test(cc), cc);
      const html = await r.text();
      check('首页里没有残留的 __BUILD__ 占位', !html.includes('__BUILD__'));
    } catch (e) {
      check('窗口地址真的能打开（HTTP 200）', false, e.message);
    }
  }

  // 开窗口前清过 HTTP 缓存 + F5 能强制刷新（怀疑看到旧界面时用）
  check('开窗口前清过 Electron 的 HTTP 缓存', !!windows[0] && windows[0].cacheCleared === true);
  const fake = windows[0];
  check('窗口注册了按键事件（F5 强制刷新用）', !!(fake && fake.events && fake.events['before-input-event']));
  if (fake && fake.events && fake.events['before-input-event']) {
    let prevented = false;
    fake.events['before-input-event']({ preventDefault: () => { prevented = true; } }, { key: 'F5', type: 'keyDown' });
    check('按 F5 真的触发了「忽略缓存刷新」', fake.forcedReloads === 1 && prevented, `reloads=${fake.forcedReloads} prevented=${prevented}`);
    fake.events['before-input-event']({ preventDefault: () => {} }, { key: 'a', type: 'keyDown' });
    check('普通按键不会触发刷新', fake.forcedReloads === 1, `reloads=${fake.forcedReloads}`);
  }

  // ---- 每日话术编排台：独立浮窗（可拖到主窗口外任意位置） ----
  check('注册了话术编排台的 IPC 通道', typeof ipcHandlers['board:open'] === 'function'
    && typeof ipcHandlers['board:sync'] === 'function'
    && typeof ipcHandlers['board:close'] === 'function',
  Object.keys(ipcHandlers).join(','));

  if (typeof ipcHandlers['board:open'] === 'function') {
    const nBefore = windows.length;
    await ipcHandlers['board:open']({}, '1A00009');
    check('board:open 开出一扇新窗口（不是主界面里的浮层）', windows.length === nBefore + 1,
      `窗口数 ${nBefore} → ${windows.length}`);
    const bw = windows[windows.length - 1];
    check('浮窗加载的是 board.html（带客户编号）',
      !!bw && /\/board\.html\?code=1A00009$/.test(bw.url || ''), bw && bw.url);
    check('浮窗是无边框窗口（标题栏可拖动到屏幕任意位置）', !!bw && bw.opts.frame === false, bw && bw.opts.frame);
    check('浮窗可缩放、且不设父窗口（不受主窗口边界限制）',
      !!bw && bw.opts.resizable === true && !bw.opts.parent, bw && JSON.stringify({ r: bw.opts.resizable, p: bw.opts.parent }));

    // 已开着时再 open 应复用同一扇窗，而不是越开越多
    const nMid = windows.length;
    await ipcHandlers['board:open']({}, '1A00010');
    check('浮窗已开着时复用同一扇窗（不重复开）', windows.length === nMid, `窗口数 ${nMid} → ${windows.length}`);
    check('复用时会切到新客户', /code=1A00010$/.test(windows[windows.length - 1].url || ''), windows[windows.length - 1].url);

    // sync：浮窗开着就跟着换客户
    await ipcHandlers['board:sync']({}, '1A00011');
    check('board:sync 让开着的浮窗跟着换客户', /code=1A00011$/.test(windows[windows.length - 1].url || ''), windows[windows.length - 1].url);

    // close：关掉浮窗；关掉之后再 sync 不应该又开出来（不主动弹窗）
    await ipcHandlers['board:close']({});
    const nAfterClose = windows.length;
    await ipcHandlers['board:sync']({}, '1A00012');
    check('浮窗关掉后 sync 不会自动弹窗', windows.length === nAfterClose, `窗口数 ${nAfterClose} → ${windows.length}`);
  }

  const ok = fail === 0;
  console.log(`\n[桌面入口自检] ${ok ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
  if (!ok) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('桌面入口自检异常：', e); process.exit(1); });