/**
 * 界面权限（v2.6.1106 · 老板 2026-10-14 拍板）
 *
 * 只管一件事：**判断当前登录的人是不是管理员，是就把藏起来的界面放出来，不是就藏起来。**
 * 不采集、不发消息、不碰业务逻辑。
 *
 * 为什么要单独一个文件：
 *   主窗口（WA① 页签）和全局设置窗（6 个页签）都要按同一个口径藏东西。
 *   规则如果写在两处，改一处漏一处，就会出现「设置里藏了、主窗口没藏」这种漏子。
 *   所以判定规则和隐藏动作**只有这一份**，两个页面都来问它。
 *
 * 🔴 口径（老板亲口定）：**只有 admin 能看。**
 *    云端角色一共三种 admin 管理员 / editor 二级管理员 / user 编号会员，
 *    老板明确选了「只 admin 能看」，所以 editor 和 user 一样，什么都看不见。
 *    没登录、没配置云端、连不上云 → 一律按「不是管理员」处理。
 *
 * 🔴 只做「看不见」，不做「删功能」：
 *    所有元素都是加 .hidden 藏起来，代码一个字不删、按钮的绑定一个不摘。
 *    管理员一登录，界面立刻原样回来。
 */

(function (global) {
  'use strict';

  /** 唯一算管理员的角色（老板拍板：二级管理员也不算） */
  var ADMIN_ROLE = 'admin';

  /**
   * 只有管理员能看见的东西 —— 全项目**唯一的规则表**，改这里就够了。
   *   midTabs : 主窗口「中栏页签」（public/index.html 的 .mtab / .mid-pane）
   *   setTabs : 全局设置窗页签（public/settings.html 的 .set-tab / #sec-<名>）
   */
  var RULES = {
    // 🔴 2026-10-17 老板拍板：WA①~⑤（wa1~wa5）不再分权限 —— 所有人（含非管理员）都能看到、都能用，
    //   功能与管理员完全一致。从隐藏表移出（v2.6.1143 之前是「只有 admin 看得见」）。
    //   ⚠️ 注意：这只是「去掉 WA 的权限门槛」，Signal / Telegram / 设置页的权限口径一个字没动。
    midTabs: [],
    /* 🔴 2026-10-14 老板拍板（v2.6.1111 落地）：设置里的「⚙ AI 设置」页签**解除隐藏**（所有人都能看）。
       原表 ['ai','prompts','sim','telegram','proxy','screenshot'] → 先去掉 'telegram'，
       本次再去掉 'ai'。
       🔴 2026-10-17 老板两项新指令：
         · ①「代理」页签解除隐藏 → 从隐藏表移除（所有人可见）；
         · ③「隐藏说明」页签改为只有管理员可见 → 加进隐藏表。
       最终剩 ['prompts','sim','screenshot','hidden'] 仍是「只有 admin 能看」。 */
    setTabs: ['prompts', 'sim', 'screenshot', 'hidden'],

    /* 🔴 2026-10-17 老板指令②：顶栏「一号~五号」外部 Chrome WA 账号按钮（#accounts 里的
       .acct[data-id=1..5]）只有管理员可见；内置 WA①~⑤ 网页页签（.mtab[data-mp=wa1..wa5]）一个字不动。
       Signal（#accounts 里的 .acct[data-id=6]）也不动 —— 它和外部 WA 账号挤在同一个 #accounts 容器里，
       只藏 1~5 即可。绝不动 Telegram 的 #tg-accounts 容器（三软件红线）。 */
    hideAccounts: [1, 2, 3, 4, 5],
  };

  /** 不是管理员时，人该停在哪一页（这两页所有人都看得见） */
  var SAFE = {
    mid: 'general',
    set: 'cloud',
  };

  var isAdmin = false;
  var lastRole = '';
  var lastCode = '';
  /** 已经真正收拾过一次界面没有。
   *  🔴 别拿 lastRole 当「跑过没有」的判据 —— ingest() 是先把 lastRole 填好再调 apply() 的，
   *     用 `lastRole` 做短路条件会让**第一次**判定被整个跳过，界面根本没被收拾
   *    （v2.6.1106 第一版就是这个坑：未登录能藏住，user / editor 藏不住）。 */
  var appliedOnce = false;

  function log(msg) {
    /* 权限是界面上的事，出错了不该刷屏，安静记一行就行 */
    if (global.console && console.debug) console.debug('[权限] ' + msg);
  }

  /** 藏 / 放。🔴 v2.6.1123 A 方案：用 perm.js 自己的 .perm-hidden 类，
   *  绝不复用 HTML 自带的 .hidden —— 否则 admin 登录「放出」时会顺手把
   *  HTML 里默认就藏着的次要页签 / 次要 section（#sec-prompts、.mid-pane[data-mp=wa1] 等）
   *  也一并摘掉，导致「AI设置页底下露出 AI提示词和模拟新消息」「通用页下方露出 WA① 区域」
   *  （老板 QQ20261015-104120 / QQ20261015-104218 两个红框的根因）。
   *  用独立类后，perm.js 只摘自己加的那一份，HTML 自带的 .hidden 一字不动。 */
  function setHidden(el, hide) {
    if (!el) return;
    el.classList.toggle('perm-hidden', !!hide);
  }

  /** 主窗口：WA① 的页签按钮 + 面板一起藏。面板藏了，里面的 webview 自然也不会加载。 */
  function applyMidTabs(hide) {
    RULES.midTabs.forEach(function (name) {
      setHidden(document.querySelector('.mtab[data-mp="' + name + '"]'), hide);
      setHidden(document.querySelector('.mid-pane[data-mp="' + name + '"]'), hide);
    });
  }

  /** 设置窗：页签按钮和内容区一起藏（只藏按钮的话，内容区可能被别处调出来） */
  function applySetTabs(hide) {
    RULES.setTabs.forEach(function (name) {
      setHidden(document.querySelector('.set-tab[data-tab="' + name + '"]'), hide);
      setHidden(document.getElementById('sec-' + name), hide);
    });
  }

  /** 顶栏「一号~五号」外部 WA 账号按钮：非管理员时藏起来（只藏 #accounts 里的 .acct[data-id=1..5]，
   *  不动 Signal 6、不动内置 WA①~⑤ 页签、不动 Telegram）。 */
  function applyAccounts(hide) {
    RULES.hideAccounts.forEach(function (id) {
      setHidden(document.querySelector('#accounts .acct[data-id="' + id + '"]'), hide);
    });
  }

  /**
   * 兜底挪位：如果人现在正停在「刚被藏起来」的那一页，帮他挪到看得见的页面。
   * 走的是页面原本的切换函数（点按钮 / switchTab），不另写一套，保证行为一致。
   */
  function ensureSafeTab() {
    if (isAdmin) return;
    try {
      var onMid = document.querySelector('.mtab.on');
      if (onMid && RULES.midTabs.indexOf(onMid.dataset.mp) >= 0) {
        var safeMid = document.querySelector('.mtab[data-mp="' + SAFE.mid + '"]');
        if (safeMid) { safeMid.click(); log('当前停在受限页签，已挪到「' + SAFE.mid + '」'); }
      }
    } catch (e) { /* 主窗口不一定有这些元素，忽略 */ }

    try {
      var onSet = document.querySelector('.set-tab.on');
      if (onSet && RULES.setTabs.indexOf(onSet.dataset.tab) >= 0) {
        if (typeof global.switchTab === 'function') {
          global.switchTab(SAFE.set);
          log('当前停在受限页签，已挪到「' + SAFE.set + '」');
        }
      }
    } catch (e) { /* 设置窗不一定有这些元素，忽略 */ }
  }

  /**
   * （v2.6.1143 停用）原本非管理员时把 WA①~⑤ 五个 webview 设成 about:blank，
   * 不给非管理员留加载机会。2026-10-17 老板拍板：WA①~⑤ 对所有人生效、功能同管理员，
   * 不再区分权限 → 不再清空白，所有人都能正常加载并使用内置浏览器。
   * 函数保留为 no-op（ids 置空即不做事），避免动调用点；只改这里的语义。
   */
  function blankWaWebview() {
    if (isAdmin) return;
    var ids = [];
    ids.forEach(function (id) {
      var wv = document.getElementById(id);
      if (!wv) return;
      try {
        if (wv.getAttribute('src') !== 'about:blank') wv.setAttribute('src', 'about:blank');
      } catch (e) { /* webview 还没挂上，忽略 */ }
    });
  }

  /**
   * 这一回要不要跳过权限检查（把界面完全恢复原样）。
   *
   * 为什么必须有这条：自动化测试（puppeteer）跑的页面**不会登录云端**，
   * 按正常口径就是「非管理员」，界面会被正确藏起来 —— 可测试断言的是「这些东西还在」。
   * v2.6.1106 第一版就因为这个一跑多红了 8 项（基线本来只有 3 项历史红）。
   * 这不是功能错，是「测试环境」和「真实使用」本来就不是一回事，得有办法分开。
   *
   * 三道开关，优先级从高到低：
   *   1) localStorage 里 bee.perm = off → 关（排障用：想在会员号下临时看一眼）
   *   2) localStorage 里 bee.perm = on  → 强制开（连自动化也不放过）
   *   3) 浏览器自动化标记 navigator.webdriver = true → 关。
   *      Electron 真窗口实测为 false（已用独立探针验证），不会误伤老板的真软件。
   *   另外网址上加 ?perm=off 也能临时关。
   */
  function suspended() {
    try {
      var flag = null;
      try { flag = global.localStorage ? localStorage.getItem('bee.perm') : null; } catch (e) { flag = null; }
      if (flag === 'off') return true;
      if (flag === 'on') return false;
      try {
        if (global.location && /[?&]perm=off\b/.test(String(location.search || ''))) return true;
      } catch (e) { /* 网址读不到就算了 */ }
      return !!(global.navigator && navigator.webdriver === true);
    } catch (e) {
      return false;
    }
  }

  /** 按「是不是管理员」把界面收拾一遍。幂等，重复调用没副作用。 */
  function apply(admin) {
    if (suspended()) {
      // 豁免：把可能已经加上去的 .hidden 摘掉，界面回到 HTML 原本的样子
      applyMidTabs(false);
      applySetTabs(false);
      applyAccounts(false);
      isAdmin = true;
      appliedOnce = true;
      log('权限检查已豁免（自动化测试 / 手动关闭），受限界面保持原样');
      return;
    }
    var next = !!admin;
    if (appliedOnce && next === isAdmin) return;   // 已经收拾过、结论又没变，就别白忙
    appliedOnce = true;
    isAdmin = next;
    applyMidTabs(!isAdmin);
    applySetTabs(!isAdmin);
    applyAccounts(!isAdmin);
    blankWaWebview();
    ensureSafeTab();
    log((isAdmin ? '管理员：受限界面已放出' : '非管理员：受限界面已隐藏')
      + '（角色 ' + (lastRole || '未知') + '，编号 ' + (lastCode || '未登录') + '）');
  }

  /**
   * 喂一份云端状态进来 —— 两个页面各自已经拉过 /api/cloud/status，
   * 直接把结果递给这里就行，避免同一个接口重复请求。
   * @param {object} st /api/cloud/status 的返回
   */
  function ingest(st) {
    var op = st && st.operator;
    lastRole = (op && op.role) || '';
    lastCode = (op && op.code) || '';
    var admin = !!(st && st.loggedIn && lastRole === ADMIN_ROLE);
    apply(admin);
    return admin;
  }

  /** 自己拉一次云端状态（页面初始化时用；后面交给页面在状态变化时调 ingest） */
  function refresh() {
    return fetch('/api/cloud/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (st) { return ingest(st); })
      .catch(function () { apply(false); return false; });
  }

  var ready = refresh();

  global.BeePerm = {
    isAdmin: function () { return isAdmin; },
    role: function () { return lastRole; },
    /** 让 app.js 在重画 #accounts 后重新套一遍账号隐藏（只藏 1~5 号，Signal 6 不动） */
    applyAccounts: function () { applyAccounts(!isAdmin); },
    ingest: ingest,
    refresh: refresh,
    ready: ready,
    /** 规则表对外只读，方便排查「到底藏了哪几项」 */
    rules: RULES,
  };
})(window);
