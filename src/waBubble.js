/**
 * WA① 内置浏览器 —— 中文译文气泡（2026-10-15 v2.6.1121）
 *
 * 只做一件事：把**已经翻好的中文**，贴到网页里那条消息的正下方。
 *
 * 老板拍板的四条：
 *   ① 「网页自己画对话，我们只往上叠中文译文气泡」—— 不接管网页的对话渲染；
 *   ② 「插在对话消息的下方」—— 落点 = `.copyable-text` 的父节点（实测过，见下）；
 *   ③ 「看网页渲染几条按照实际的来做」—— 只贴网页**当前真的渲染出来**的那几条；
 *   ④ 「50 / 100」—— 记住最近 50 条气泡，累计到 100 条自动缩回 50 条；
 *      计数**不分方向**：客户发来 1 条算 1、我回复 1 条也算 1。**一条消息算一条**。
 *
 * 🔴 实测拿死的三条（`tools/wa-dom-probe.js --bubble` 可复跑，2026-10-15）：
 *   · 锚点 `#main [data-id="<裸消息id>"]` —— 实测 10 条**全是裸 id**，不带 `true_/false_` 前缀；
 *   · 落点 `holder.querySelector('.copyable-text').parentNode` —— 插完容器高 112→141，
 *     删掉完全复原 112，零副作用；而且**自动跟随消息左右**（我方消息落 x=495 右侧），
 *     所以这里**不需要**判方向、也**不需要**写 CSS 去对齐；
 *   · 网页同屏只渲染 **7~10 条**（虚拟列表，视口外的节点是回收空壳，内层 `copyable-text` 没有）
 *     ⇒「50 条」是**我们记住**的条数，不是同屏贴 50 个。
 *
 * 🔴 只读铁律：注入脚本里只有 querySelector / createElement / appendChild / removeChild /
 *    textContent。不点、不输入、不滚动、不发请求、不碰原节点（原节点一个字节都不改）。
 *
 * 译文从哪来：**不重新翻**。直接吃数据库里已经有的 `body_zh`，按**原文文本**匹配 ——
 *   这就是老板要的「建立个数据可读取翻译过的内容，每次就不用再翻译一次」：
 *   同一句话翻过一次，之后在网页上再看到它，0 次 AI 调用就能贴回中文。
 *
 * ---- v2.6.1134：复刻成 WA①~WA⑤ 五个标签（参数化共用一套）----
 *   与 whatsappRead 同一策略：气泡内核只写一套，5 个实例按 accId / partition / prefix / label
 *   参数化。模块级导出的仍是 **WA① 实例**（accId=10），既有测试（ACC_ID=10、无现翻、
 *   describe 含 WA①）纹丝不动；其余 4 个实例由 main.js 通过 createInstance(cfg) 起出来。
 *
 * ---- v2.6.1135：节拍交给 src/waChain.js 的串联调度链 ----
 *   main.js 用 `startWatching({ ..., manual: true })` 只装 hooks、不起内部 3 秒定时器，
 *   由调度链每 2 秒一次 `await inst.tick()`。开关是 opt-in：不传 manual 时行为一字不变。
 */

const db = require('./db');
const lang = require('./lang');
const ids = require('./ids');
const whatsappWebView = require('./whatsappWebView');

/** 累计到这么多条气泡就缩回去（老板的 100） */
const BUBBLE_MAX = 100;
/** 缩回后留最新的这么多条（老板的 50） */
const BUBBLE_KEEP = 50;
/** 多久看一次网页（跟采集同一个 3 秒节拍） */
const POLL_MS = 3000;
/** 每次从库里捞多少条最近的译文当「翻译记忆」 */
const LOOKBACK = 800;
/** 启动后延迟多久开始跑（别跟 Electron 启动抢主线程，同采集侧） */
const START_DELAY_MS = 3000;

/* =====================================================================
 * 一、注入到网页里的两段脚本（**只读**）
 *     跟 whatsappRead 一样：整个 toString() 后扔进网页执行，所以
 *   · 不许引用本文件的任何外部变量；
 *   · 不许 await；
 *   · 只返回能结构化克隆的纯数据。
 * ===================================================================== */

/**
 * 读「网页现在真的渲染出来的那些消息」。
 * 视口外的节点被虚拟列表回收了（内层没有 `.copyable-text`），顺手就当没看见 —— 正好。
 */
function readRenderedInPage() {
  try {
    var main = document.querySelector('#main');
    if (!main) return { ok: false, error: '没找到对话区 #main（可能没打开任何对话）' };
    var holders = main.querySelectorAll('[data-id]');
    var items = [];
    var seen = {};
    for (var i = 0; i < holders.length; i++) {
      var h = holders[i];
      var mid = String(h.getAttribute('data-id') || '');
      // 🔴 裸化：网页 data-id 可能是「方向_会话JID_<裸mid>」或纯裸 id，只取最后一个 _ 之后那段当 mid
      var bu = mid.lastIndexOf('_');
      mid = bu >= 0 ? mid.slice(bu + 1) : mid;
      if (!mid || seen[mid]) continue;
      var box = h.querySelector('.copyable-text');
      if (!box) continue;                        // 回收空壳：内层没了，没得贴
      var text = String(box.innerText || '').trim();
      if (!text) continue;
      seen[mid] = 1;
      items.push({ mid: mid, text: text });
    }
    return { ok: true, items: items, url: String((typeof location !== 'undefined' && location.href) || '') };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 贴气泡。幂等：同一个 mid 的节点带 `data-owner` 标，第二次只改文字，不会越贴越多。
 *
 * @param {Array<{mid:string, zh:string}>} rows 要贴的（网页上真实存在的那几条）
 * @param {string[]} dropIds 要摘掉的（50/100 缩容时被挤出去的那一批）
 */
function paintInPage(rows, dropIds) {
  try {
    var main = document.querySelector('#main');
    if (!main) return { ok: false, error: '没找到对话区 #main' };
    var list = Array.isArray(rows) ? rows : [];
    var drops = Array.isArray(dropIds) ? dropIds : [];

    var style = 'margin:4px 2px 0;padding:3px 7px;font-size:12px;line-height:1.6;'
      + 'color:#1f6aa5;font-weight:600;background:rgba(31,106,165,.08);border-radius:6px;'
      + 'white-space:pre-wrap;word-break:break-word;';

    /* ① 缩容：把这些 mid 的气泡从网页上摘掉 */
    var removed = 0;
    for (var d = 0; d < drops.length; d++) {
      var dead = main.querySelectorAll('[data-owner="' + String(drops[d]).replace(/"/g, '') + '"]');
      for (var q = 0; q < dead.length; q++) {
        if (dead[q].parentNode) { dead[q].parentNode.removeChild(dead[q]); removed++; }
      }
    }

    /* ② 贴 / 更新 */
    var want = {};
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      var mid = String(r.mid || '');
      var zh = String(r.zh || '').trim();
      if (mid && zh) want[mid] = zh;
    }

    var holders = main.querySelectorAll('[data-id]');
    var painted = 0;
    var updated = 0;
    for (var k = 0; k < holders.length; k++) {
      var h = holders[k];
      var m = String(h.getAttribute('data-id') || '');
      var bu = m.lastIndexOf('_');
      m = bu >= 0 ? m.slice(bu + 1) : m;
      var text = want[m];
      if (!text) continue;
      var box = h.querySelector('.copyable-text');
      if (!box || !box.parentNode) continue;     // 视口外的空壳：这轮先不管
      var host = box.parentNode;

      // 找自己上次贴的那个（只找**我自己的**直接子节点，别人一个都不碰）
      var node = null;
      for (var c = 0; c < host.children.length; c++) {
        if (String(host.children[c].getAttribute('data-owner') || '') === m) { node = host.children[c]; break; }
      }
      if (!node) {
        node = document.createElement('div');
        node.setAttribute('data-owner', m);
        node.style.cssText = style;
        host.appendChild(node);
        painted++;
      } else if (node.textContent !== text) {
        updated++;
      }
      if (node.textContent !== text) node.textContent = text;
    }
    return { ok: true, painted: painted, updated: updated, removed: removed };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function readSource() {
  return `(${readRenderedInPage.toString()})()`;
}

function paintSource(rows, dropIds) {
  return `(${paintInPage.toString()})(${JSON.stringify(rows || [])},${JSON.stringify(dropIds || [])})`;
}

/* =====================================================================
 * 二、实例工厂（v2.6.1134：WA①~⑤ 共用一套气泡内核）
 * ===================================================================== */

const _instances = {};

/**
 * 造一个气泡实例。
 * @param {object} cfg { accId, prefix, partition, label }
 */
function makeInstance(cfg) {
  const accId = cfg.accId;
  const prefix = cfg.prefix;
  const partition = cfg.partition;
  const label = cfg.label || prefix;

  let _timer = null;
  let _watching = false;
  let _stopped = false;
  let _busy = false;
  let _delay = null;
  let _opts = null;
  let _status = 'idle';       // idle / ok / no-page / unreadable / error
  let _error = '';
  let _seq = 0;

  /** 记住的气泡：mid → { zh, text, seq }。上限 BUBBLE_MAX（满了缩到 BUBBLE_KEEP） */
  const _store = new Map();
  /** 被缩容挤掉、还没从网页上摘掉的 mid */
  let _drops = [];
  /** 最近一次统计 */
  const _stats = { painted: 0, updated: 0, removed: 0, at: '' };

  function setStatus(status, error) {
    if (_status !== status || _error !== (error || '')) {
      _status = status;
      _error = error || '';
      notifyState();
    }
  }

  function notifyState() {
    try {
      if (_opts && typeof _opts.onState === 'function') _opts.onState(state());
    } catch (e) { /* 上报出错不能影响贴气泡 */ }
  }

  /**
   * 记住一条气泡（老板的 50/100 就落在这里）
   * 一条消息算一条，**不分方向** —— 这里根本不看 direction，天然就对。
   */
  function remember(mid, text, zh) {
    const key = String(mid);
    const entry = { zh: String(zh || '').trim(), text: String(text || ''), seq: ++_seq };
    _store.delete(key);          // 重新插到 Map 末尾 = 最新的在最后
    _store.set(key, entry);
    if (_store.size >= BUBBLE_MAX) {
      const arr = [..._store.entries()].sort((a, b) => a[1].seq - b[1].seq);
      const dropCount = arr.length - BUBBLE_KEEP;
      for (let i = 0; i < dropCount; i++) {
        const k = arr[i][0];
        _store.delete(k);
        _drops.push(k);          // 下一页把它的气泡从网页上摘掉
      }
    }
    return entry;
  }

  /**
   * 「翻译记忆」：这个账号最近翻好的 原文 → 译文。
   * 🔴 v2.6.1127 方案 A（老板拍板）：同时建两份索引 ——
   *   · byText：原文文本 → 译文（无 emoji 的消息仍可用；保底）；
   *   · byMid ：消息编号 mid → 译文（wa_msg_id = "..._<mid>"，按编号定位，
   *             emoji / 空格 / 标点差异全免疫 —— 直接修掉「翻译好了却贴不上」那个 bug）。
   * 同一句原文会出现多条，取**最新**的那份译文（结果集是新→旧，所以先到先得）。
   */
  function loadMemory() {
    const byText = new Map();
    const byMid = new Map();
    try {
      const rows = db.listRecentBubbleSources.all(accId, LOOKBACK) || [];
      for (const r of rows) {
        const zh = String(r.body_zh || '').trim();
        if (!zh) continue;
        const src = String(r.body || '').replace(/\s+/g, ' ').trim();
        if (src && !byText.has(src)) byText.set(src, zh);
        // 🔴 按消息编号定位：wa_msg_id 形如 "wa1:1_xxx@lid_<mid>"，取最后一个 _ 之后那段
        const wmid = String(r.wa_msg_id || '');
        const i = wmid.lastIndexOf('_');
        const mid = i >= 0 ? wmid.slice(i + 1) : '';
        if (mid && !byMid.has(mid)) byMid.set(mid, zh);
      }
    } catch (e) {
      // 读不到就当没有记忆：这一轮不贴，下一轮再来 —— 绝不影响采集和翻译本身
    }
    return { byText, byMid };
  }

  function findPage() {
    const find = (_opts && typeof _opts.findPage === 'function') ? _opts.findPage : null;
    if (find) { try { return find(); } catch (e) { return null; } }
    return whatsappWebView.findGuest(partition);
  }

  /* =====================================================================
   * 三、节拍
   * ===================================================================== */

  async function tick() {
    if (_stopped || _busy) return state();
    _busy = true;
    try {
      const page = findPage();
      if (!page) {
        setStatus('no-page', `没找到 ${label} 的内置浏览器页面 —— 先点中栏「${label}」把 WhatsApp 网页打开`);
        return state();
      }
      let read = null;
      try {
        read = await page.executeJavaScript(readSource(), false);
      } catch (e) {
        setStatus('unreadable', '注入失败：' + String((e && e.message) || e));
        return state();
      }
      if (!read || read.ok !== true) {
        setStatus('unreadable', (read && read.error) || '页面没返回数据（可能还没登录 / 还在加载）');
        return state();
      }
      setStatus('ok', '');

      const items = read.items || [];
      if (!items.length) return state();

      const memory = loadMemory();
      const rows = [];
      for (const it of items) {
        const mid = String(it.mid || '');
        const text = String(it.text || '').replace(/\s+/g, ' ').trim();
        if (!mid || !text) continue;
        // 🔴 翻译铁律：正常中文不贴气泡（本来就看不懂才需要气泡）
        if (!lang.needsTranslation(text)) continue;
        let hit = _store.get(mid);
        if (!hit) {
          // 🔴 v2.6.1127 方案 A（老板拍板）：优先按消息编号 mid 查，emoji/空格/标点差异全免疫；
          //   退路才按原文文本（无 emoji 的消息仍可用）。绝不在气泡里现翻。
          let zh = memory.byMid.get(mid);
          if (!zh) zh = memory.byText.get(text);
          if (!zh) continue;              // 还没翻出来：下一轮再说，绝不在这里现翻
          hit = remember(mid, text, zh);
        }
        rows.push({ mid: mid, zh: hit.zh });
      }

      const drops = _drops;
      _drops = [];
      // 🔴 刚刚被缩容挤出去的那些**不能再贴**（否则「满 100 缩回 50」当场就失效了）
      const dropSet = new Set(drops);
      const finalRows = dropSet.size ? rows.filter((r) => !dropSet.has(r.mid)) : rows;
      if (finalRows.length || drops.length) {
        const painted = await page.executeJavaScript(paintSource(finalRows, drops), false);
        if (painted && painted.ok === true) {
          _stats.painted = painted.painted || 0;
          _stats.updated = painted.updated || 0;
          _stats.removed = painted.removed || 0;
        }
      }
      _stats.at = new Date().toISOString();
      return state();
    } catch (e) {
      setStatus('error', String((e && e.message) || e));
      return state();
    } finally {
      _busy = false;
    }
  }

  /** 只读探测（排障用）：看看网页现在渲染了哪些消息、我们手里记得几条 */
  async function probe() {
    const page = findPage();
    if (!page) return { ok: false, status: 'no-page', error: `没找到 ${label} 页面` };
    let read = null;
    try {
      read = await page.executeJavaScript(readSource(), false);
    } catch (e) {
      return { ok: false, status: 'error', error: String((e && e.message) || e) };
    }
    if (!read || read.ok !== true) return { ok: false, status: 'unreadable', error: (read && read.error) || '无返回' };
    const memory = loadMemory();
    const items = (read.items || []).map((it) => {
      const mid = String(it.mid || '');
      const text = String(it.text || '').trim();
      return {
        mid,
        text: text.slice(0, 40),
        translatable: lang.needsTranslation(text),
        remembered: _store.has(mid),
        hasMemory: !!memory.byMid.get(mid) || (!!text && memory.byText.has(text)),
      };
    });
    return { ok: true, status: 'ok', accountId: accId, rendered: items.length, remembered: _store.size, items };
  }

  /**
   * 手动「↻ 补气泡」按钮用（老板 2026-10-15 要的按钮，v2.6.1127 落地）：
   * 忽略 _busy 节流，立刻重贴一轮 —— 让刚翻好 / 刚按 mid 重新匹配到的中文立刻显出来。
   */
  async function forceRepaint() {
    _busy = false;
    return tick();
  }

  /* =====================================================================
   * 四、启停 + 对外文案
   * ===================================================================== */

  /**
   * 起气泡采集。
   *
   * 🔴 v2.6.1135 新增**手动/外部驱动**开关（`{ manual: true }`，等价写法 `{ autoStart: false }`）：
   *    hooks 全部装好、状态置位，但**不挂内部 3 秒定时器**，由 src/waChain.js
   *    那条串联调度链来 `await inst.tick()`。
   *    —— 不这样就会「链跑一遍 + 定时器又跑一遍」重复贴气泡。
   *
   *    ⚠️ opt-in（默认关闭）：不传时本函数行为与 v2.6.1134 一字不差，
   *       既有测试（ACC_ID=10、无现翻、describe 含 WA①）纹丝不动。
   *
   * @param {object} opts onState / findPage / manual
   */
  function startWatching(opts) {
    if (opts) _opts = opts;
    _stopped = false;
    _watching = true;
    const manual = !!(opts && (opts.manual === true || opts.autoStart === false));
    // 自测里不挂真定时器（同 whatsappRead 的约定）：只把 hook 装上，由测试自己调 tick()
    if (process.env.BEE_TEST === '1') return state();
    if (manual) return state();   // v2.6.1135：链驱动 —— 只装 hooks，节拍交给 src/waChain.js
    if (_timer) return state();
    _timer = setInterval(() => { tick(); }, POLL_MS);
    if (_timer.unref) _timer.unref();
    // 启动后晚一点再跑第一轮（别跟 Electron 启动抢主线程）
    _delay = setTimeout(() => { tick(); }, START_DELAY_MS);
    if (_delay.unref) _delay.unref();
    return state();
  }

  function stopWatching() {
    _stopped = true;
    _watching = false;
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_delay) { clearTimeout(_delay); _delay = null; }
    return state();
  }

  function state() {
    return {
      watching: _watching,
      status: _status,
      error: _error,
      accountId: accId,
      painted: _stats.painted,
      updated: _stats.updated,
      removed: _stats.removed,
      remembered: _store.size,
      max: BUBBLE_MAX,
      keep: BUBBLE_KEEP,
      at: _stats.at,
    };
  }

  /**
   * 文案在**生产者**这里统一出，界面/日志直接用 ——
   * 免得同一个状态在两处各编一套话（照 whatsappRead.describe 的做法，连返回形状都一样）。
   * @returns {{text:string, level:string}} level: ok / info / warn / error
   */
  function describe(st) {
    const s = st || state();
    if (!s.watching) return { text: '气泡：未启动', level: 'info' };
    if (s.status === 'no-page') {
      return { text: `气泡：没找到 ${label} 网页（先点中栏「${label}」）`, level: 'info' };
    }
    if (s.status === 'unreadable') return { text: '气泡：网页没返回数据', level: 'warn' };
    if (s.status === 'error') return { text: '气泡：出错 —— ' + (s.error || '未知'), level: 'error' };
    return { text: `气泡：已贴 ${s.painted} 条 · 记住 ${s.remembered}/${s.max} 条`, level: 'ok' };
  }

  const api = {
    accId, prefix, partition, label,
    BUBBLE_MAX, BUBBLE_KEEP, POLL_MS, LOOKBACK,
    readSource, paintSource, readRenderedInPage, paintInPage,
    startWatching, stopWatching, state, describe, probe, forceRepaint, tick,
    _internal: { remember, loadMemory, store: _store },
  };
  _instances[prefix] = api;
  return api;
}

/* ---- 模块级 = WA① 实例（accId=10 / wa1 / persist:wa6），既有测试与 server 默认路由都靠它 ---- */
const WA1 = makeInstance({ accId: ids.ACC_WA_EMBEDDED, prefix: 'wa1', partition: 'persist:wa6', label: 'WA①' });

function getInstance(key) {
  return _instances[key];
}

/* =====================================================================
 * 五、对外模块级接口（保持 WA① 形态，向后兼容既有测试 / server 默认路由）
 * ===================================================================== */

module.exports = Object.assign({}, WA1, {
  ACC_ID: ids.ACC_WA_EMBEDDED,
  BUBBLE_MAX,
  BUBBLE_KEEP,
  POLL_MS,
  LOOKBACK,
  readSource,
  paintSource,
  readRenderedInPage,
  paintInPage,
  startWatching: WA1.startWatching,
  stopWatching: WA1.stopWatching,
  state: WA1.state,
  describe: WA1.describe,
  probe: WA1.probe,
  forceRepaint: WA1.forceRepaint,
  tick: WA1.tick,
  // v2.6.1134：多实例工厂
  createInstance: makeInstance,
  getInstance,
  WA1,
});
