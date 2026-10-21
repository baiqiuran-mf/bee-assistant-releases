/**
 * 软件自动更新（2026-10-07 v1.2.0）
 *
 * 更新源：GitHub Releases（公开仓库 bee-assistant-releases）
 * 🔴 为什么是公开仓库：私有仓库的下载必须带 token，而这个 token 要写进软件里
 *   → 打包进 exe → 发给每个客户 → 任何人反编译就能拿到，能删你的 Release。
 *   公开仓库不需要 token，零风险。源码本来也不在这个仓库里。
 *
 * 三个必须记住的现实：
 *
 * ① **必须打包后才可用**。直接 `node src/main.js` 跑时 updater 会抛
 *   "app-update.yml not found"。所以本模块一切都在 isPackaged 为假时安静降级，
 *   绝不 throw —— 单测和开发调试不能被这个功能炸掉。
 *
 * ② **正在采集时不自动重启**（老板选了"自动重启"，但这条我加了保护）。
 *   quitAndInstall() 会直接杀进程。如果此刻正在采集客户消息，
 *   重启会丢消息上下文，而且 WhatsApp 可能要重新扫码登录 —— 那个代价
 *   比自己点一下大得多。所以：有任务在跑 → 只提示，绝不自动重启。
 *   这条钉在 test/v120_update.test.js 里。
 *
 * ③ **失败的更新也写库**。只记成功的话，界面上会显示"上次更新于三个月前"，
 *   其实那次是失败的 —— 比不显示更误导。
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const pkg = require('../package.json');

/* ============================================================
 * 一、纯逻辑部分（无 Electron 依赖，单测直接测这部分）
 * ============================================================ */

/**
 * 版本号比较：a 比 b 新返回正数，a 比 b 旧返回负数，相同返回 0。
 *
 * 🔴 为什么不能直接比字符串："1.10.0" < "1.9.0"（字符串比'1'后 '1'<'9'），
 *   但实际 1.10.0 比 1.9.0 新。这类错会让用户永远收不到更新，或者反之。
 *
 * 非规范版本号（"1.2-beta"、"v1.2.3"）都能处理：
 *   - 前面多个 v 直接去掉
 *   - 分段取数字，取不到当0
 *   - 预发布后缀（-beta.1）按 semver 规则视为**比正式版旧**
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.num[i] !== pb.num[i]) return pa.num[i] > pb.num[i] ? 1 : -1;
  }
  // 数值全同：有预发布标记的算旧（semver 规定）
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

/** 把 "v1.2.3-beta.1" / "1.2.3" 拆成 { num:[1,2,3], pre:'beta.1' } */
function parseVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/.exec(s);
  if (!m) return { num: [0, 0, 0], pre: '' };
  return {
    num: [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0],
    pre: String(m[4] || '').replace(/^[-+]/, '').trim(),
  };
}

/** 当前软件版本（读 package.json，打包后这个值随exe 走） */
function currentVersion() {
  return String((pkg && pkg.version) || '0.0.0').replace(/^v/i, '');
}

/**
 * publish 配置是不是「还差仓库地址没填」。
 * 占位符没替换时必须**拒绝检查更新** —— 不然每次都去请求一个不存在的
 * 仓库，用户看到的是一句看不懂的报错，还以为软件坏了。
 */
function publishTarget(publish) {
  const cfg = Array.isArray(publish) ? publish[0] : publish;
  if (!cfg || cfg.provider !== 'github') return { ok: false, reason: 'provider 不是 github' };
  const owner = String(cfg.owner || '');
  const repo = String(cfg.repo || '');
  if (!owner || !repo) return { ok: false, reason: '仓库地址没配' };
  if (owner === '__OWNER__') return { ok: false, reason: '仓库地址还没填（owner 是占位符）' };
  if (/^__.*__$/.test(repo)) return { ok: false, reason: '仓库地址还没填（repo 是占位符）' };
  return { ok: true, url: `https://github.com/${owner}/${repo}` };
}

/**
 * 能不能自动重启安装。
 * 🔴 老板选了"自动重启"，但正在采集时绝不能自动重启 —— 见文件头②。
 *
 * @param {boolean} busy  此刻是否有采集/ 登录等任务在跑
 * @returns {{auto:boolean, reason:string}}
 */
function restartDecision(busy) {
  if (busy) {
    return {
      auto: false,
      reason: '软件正在采集客户消息，为免丢掉这一轮，已改成手动安装。采集结束后再点一次即可。',
    };
  }
  return { auto: true, reason: '正在安装新版本，软件会重新打开。' };
}

/** 下载进度格式化：给界面用，别让界面自己算 */
function formatProgress(percent, transferred, total) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  let size = '';
  if (Number(total) > 0) size = ` (${fmtMb(transferred)} / ${fmtMb(total)} MB)`;
  return `${p}%${size}`;
}

function fmtMb(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1);
  return (v / 1024).toFixed(0);
}

/* ============================================================
 * 二、版本历史（写库，不放内存 —— 重启不丢）
 * ============================================================ */

/**
 * 记一笔版本历史。
 * db 用懒加载 require：单测里不碰库也能加载本模块。
 */
function recordVersion(db, entry) {
  if (!db || typeof db.logVersion !== 'function') return null;
  try {
    return db.logVersion({
      version: String(entry.version || '').replace(/^v/i, ''),
      channel: entry.channel || 'latest',
      result: entry.result || 'ok',
      fromVersion: entry.fromVersion || '',
      note: String(entry.note || '').slice(0, 500),
    });
  } catch (e) {
    console.warn('[update] 版本历史写入失败（不影响更新本身）：', e.message);
    return null;
  }
}

/* ============================================================
 * 三、真正的更新动作（需要 Electron）
 * ============================================================ */

const bus = new EventEmitter();
bus.setMaxListeners(50);

let updater = null;
let cachedUpdaterError = null;

function isDesktop() {
  try {
    // eslint-disable-next-line global-require
    const electron = require('electron');
    return Boolean(electron && electron.app);
  } catch (e) {
    return false;
  }
}

/**
 * 拿 autoUpdater，拿不到就说清楚为什么，绝不 throw。
 * 直接 node 跑的时候 electron.app 是 undefined，返回 null。
 */
function getUpdater() {
  if (cachedUpdaterError) return null;
  if (updater) return updater;
  if (!isDesktop()) {
    cachedUpdaterError = '开发模式不支持更新（要打成 exe 后才能用）';
    return null;
  }
  try {
    // eslint-disable-next-line global-require
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.logger = null; // 不用它自带的log，避免污染 data 目录
    // 打开发环境时不要真去下载
    try {
      // eslint-disable-next-line global-require
      const { app } = require('electron');
      if (app && !app.isPackaged) autoUpdater.autoDownload = false;
    } catch (e) { /* 拿不到 app 就先这么着 */ }
    bindEvents(autoUpdater);
    updater = autoUpdater;
    return updater;
  } catch (e) {
    cachedUpdaterError = '更新组件没能加载：' + e.message;
    return null;
  }
}

let bound = false;

function bindEvents(au) {
  if (bound) return;
  bound = true;

  au.on('checking-for-update', () => bus.emit('state', { state: 'checking', text: '正在检查更新…' }));

  au.on('update-available', (info) => {
    bus.emit('available', info);
    bus.emit('state', {
      state: 'downloading',
      version: String((info && info.version) || ''),
      text: `发现新版本 ${(info && info.version) || ''}，正在下载…`,
    });
  });

  au.on('update-not-available', (info) => {
    bus.emit('state', {
      state: 'latest',
      version: String((info && info.version) || ''),
      text: '已经是最新版本。',
    });
  });

  au.on('download-progress', (p) => {
    bus.emit('state', {
      state: 'downloading',
      percent: Math.round(Number(p && p.percent) || 0),
      text: '正在下载：' + formatProgress(p && p.percent, p && p.transferred, p && p.total),
    });
  });

  au.on('update-downloaded', (info) => {
    bus.emit('downloaded', info);
    bus.emit('state', {
      state: 'downloaded',
      version: String((info && info.version) || ''),
      text: `新版本 ${(info && info.version) || ''} 已下载完成。`,
    });
  });

  au.on('error', (e) => {
    const msg = String((e && e.message) || e || '未知错误');
    bus.emit('error', msg);
    bus.emit('state', { state: 'error', text: '更新失败：' + msg });
  });
}

/** 供界面订阅更新过程 */
function onState(cb) {
  bus.on('state', cb);
  return () => bus.off('state', cb);
}

/**
 * 检查更新（含下载）。
 * @param {object} o
 * @param {boolean} o.silent  true=只是后台查一下，不弹窗
 * @returns {Promise<{ok:boolean, state:string, text:string, version?:string}>}
 */
async function check(o = {}) {
  const cur = currentVersion();

  const t = publishTarget((pkg && pkg.build && pkg.build.publish) || null);
  if (!t.ok) {
    const r = { ok: false, state: 'error', text: '还没配置更新源：' + t.reason, version: cur };
    bus.emit('state', r);
    return r;
  }

  const au = getUpdater();
  if (!au) {
    const r = { ok: false, state: 'error', text: cachedUpdaterError || '更新功能不可用', version: cur };
    bus.emit('state', r);
    return r;
  }

  try {
    // 🔴 2026-10-09 二次修复（老板二次报「更新还是有问题」）：
    //   第一版用 Promise.race 把 checkForUpdates() 和 25 秒定时器赛跑。
    //   问题：GitHub 慢（比如 26 秒才响应）时，25 秒定时器先 reject → 前端
    //   显示「超时」并停止轮询；但 checkForUpdates() 其实在后台仍在跑、
    //   autoDownload 还在下 —— 下载完了前端却看不到「安装」按钮，白下。
    //   改成「看门狗」：不跟 checkForUpdates 赛跑，等它自己返回；
    //   只有 90 秒内连 checking 状态都没往前走（真的卡死）才判超时。
    let settled = false;
    let watchdog = null;
    watchdog = setTimeout(() => {
      if (!settled) {
        bus.emit('state', {
          ok: false,
          state: 'error',
          text: '检查更新超时（超过 90 秒仍无响应）。可能是网络连不上 GitHub，或下载极慢。请检查网络后重试，或到 GitHub 手动下载安装包安装。',
          version: cur,
        });
      }
    }, 90000);
    // 看门狗只用来兜底，不阻止进程退出
    if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();

    const res = await au.checkForUpdates();
    settled = true;
    if (watchdog) clearTimeout(watchdog);
    const info = res && res.updateInfo;
    const remote = info && info.version ? String(info.version) : '';
    if (remote && compareVersions(remote, cur) <= 0) {
      const r = { ok: true, state: 'latest', text: '已经是最新版本。', version: cur };
      bus.emit('state', r);
      return r;
    }
    return { ok: true, state: 'done', text: '检查完成。', version: cur };
  } catch (e) {
    // checkForUpdates() 自己 reject（网络错/被墙/ rate limit）→ 这里接住，
    // 这是真实的失败原因（不是看门狗超时）。
    const r = {
      ok: false,
      state: 'error',
      text: '检查失败：' + (e && e.message ? e.message : String(e)),
      version: cur,
    };
    bus.emit('state', r);
    return r;
  }
}

/**
 * 安装下载好的更新。
 * 🔴 busy=true 时**只提示不自动重启**（文件头②）。绝不擅自决定。
 *
 * @param {object} o
 * @param {boolean} o.busy  此刻是否有采集/登录任务在跑
 * @param {object}  o.db    版本历史写库用
 * @returns {Promise<{auto:boolean, reason:string, version:string}>}
 */
async function install(o = {}) {
  const cur = currentVersion();
  const target = String(o.version || cur);
  const d = restartDecision(Boolean(o.busy));

  if (!d.auto) {
    recordVersion(o.db, { version: target, result: 'fail', fromVersion: cur, note: d.reason });
    bus.emit('state', { state: 'cancelled', version: target, text: d.reason });
    return { auto: false, reason: d.reason, version: target };
  }

  const au = getUpdater();
  if (!au) {
    const reason = cachedUpdaterError || '更新功能不可用';
    recordVersion(o.db, { version: target, result: 'fail', fromVersion: cur, note: reason });
    return { auto: false, reason, version: target };
  }

  try {
    recordVersion(o.db, { version: target, result: 'ok', fromVersion: cur, note: d.reason });
    bus.emit('state', { state: 'installing', version: target, text: '正在安装…' });
    // 注意：这一步会立刻杀进程，后面的代码不会执行
    setTimeout(() => {
      try { au.quitAndInstall(false, true); } catch (e) { /* 正在退出就无所谓 */ }
    }, 300);
    return { auto: true, reason: d.reason, version: target };
  } catch (e) {
    recordVersion(o.db, { version: target, result: 'fail', fromVersion: cur, note: e.message });
    return { auto: false, reason: '安装失败：' + e.message, version: target };
  }
}

/** 设置窗口页签要显示的信息 */
function status() {
  const cur = currentVersion();
  const t = publishTarget((pkg && pkg.build && pkg.build.publish) || null);
  // 带上下文的进度/状态，供前端轮询（设置页每 1.2 秒问一次）
  const ctx = lastCtx || {};
  return {
    version: cur,
    ready: t.ok,
    hint: t.ok ? '更新源：' + t.url : '还没配置更新源：' + t.reason,
    state: ctx.state || 'idle',
    percent: ctx.percent == null ? null : ctx.percent,
    text: ctx.text || '',
    remote: ctx.version || '',
  };
}

/* 保存最近一次状态：check() 的事件里写，status() 读。
   为什么要有这个：前端是**轮询**状态接口的（每 1.2 秒一次），
   事件只活在后端进程里，前端拿不到 —— 得有个地方把"现在什么状态"存着。 */
let lastCtx = null;

const origEmit = bus.emit.bind(bus);
bus.emit = function patched(ev, arg) {
  if (ev === 'state' && arg && typeof arg === 'object') lastCtx = arg;
  return origEmit(ev, arg);
};

module.exports = {
  // 纯逻辑（单测重点）
  compareVersions,
  parseVersion,
  restartDecision,
  formatProgress,
  currentVersion,
  publishTarget,
  // 需要 Electron
  check,
  install,
  onState,
  status,
  recordVersion,
  bus,
};