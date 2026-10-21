/**
 * WA① 中文译文气泡自检（src/waBubble.js · v2.6.1121）
 *
 * 老板拍板的四条，这里逐条钉死：
 *   ① 气泡插在**每条消息下方** —— 落点必须是 `.copyable-text` 的父节点，不能是别处；
 *   ② 只贴网页**当前真的渲染出来**的那几条 —— 视口外的回收空壳（没有 `.copyable-text`）要跳过；
 *   ③ 幂等 —— 同一个 mid 反复贴只改文字，绝不越贴越多；
 *   ④ 50 / 100 —— 记住 50 条，满 100 自动缩回 50；**一条消息算一条，不分方向**。
 *
 * 另外两条硬约束：
 *   · 只读 —— 注入脚本里不许出现任何「点/输入/滚动/发请求」的字眼；
 *   · 不重新翻 —— 译文只从库里已有的 body_zh 取（用假 DOM + 真数据库跑一整轮 tick 验证）。
 *
 * 跑法：node --experimental-sqlite test/wa_bubble.test.js
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

process.env.BEE_TEST = '1'; // 🔴 必须在 require 之前：startWatching 据此不挂定时器

const ROOT = path.join(__dirname, '..');
const wb = require(path.join(ROOT, 'src', 'waBubble.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? `  << ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =====================================================================
 * 一、一个「够用就行的」假 DOM
 *     只实现注入脚本真正用到的那几个方法，不引第三方库。
 * ===================================================================== */
function matches(el, sel) {
  if (!el || !sel) return false;
  if (sel[0] === '.') return String(el._attrs.class || '').split(/\s+/).indexOf(sel.slice(1)) >= 0;
  if (sel[0] === '#') return String(el._attrs.id || '') === sel.slice(1);
  let m = /^\[([^=\]]+)="([^"]*)"\]$/.exec(sel);
  if (m) return String(el._attrs[m[1]] || '') === m[2];
  m = /^\[([^=\]]+)\]$/.exec(sel);
  if (m) return Object.prototype.hasOwnProperty.call(el._attrs, m[1]);
  return false;
}
function collect(root, sel, out) {
  for (const c of root.children) {
    if (matches(c, sel)) out.push(c);
    collect(c, sel, out);
  }
  return out;
}
function makeEl(tag, attrs) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    _attrs: Object.assign({}, attrs || {}),
    style: { cssText: '' },
    textContent: '',
    innerText: '',
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
      return c;
    },
    querySelector(sel) { return collect(this, sel, [])[0] || null; },
    querySelectorAll(sel) { return collect(this, sel, []); },
  };
  return el;
}

/**
 * 造一页假对话。
 * @param {number} n 消息条数
 * @param {(i:number)=>string} textOf 第 i 条的正文
 * @param {(i:number)=>boolean} [shellAt] 这条要不要做成「视口外的回收空壳」（内层被回收）
 */
function buildPage(n, textOf, shellAt) {
  const main = makeEl('div', { id: 'main' });
  const doc = {
    _main: main,
    createElement: (t) => makeEl(t),
    querySelector: (sel) => (sel === '#main' ? main : null),
  };
  const mids = [];
  for (let i = 0; i < n; i++) {
    const mid = 'A' + String(i).padStart(3, '0');
    const holder = makeEl('div', { 'data-id': mid });
    if (!(shellAt && shellAt(i))) {
      const host = makeEl('div', { class: 'bubble-host' });
      const box = makeEl('div', { class: 'copyable-text' });
      box.innerText = textOf(i);
      host.appendChild(box);
      holder.appendChild(host);
    }
    main.appendChild(holder);
    mids.push(mid);
  }
  return { doc, main, mids };
}

/** 假 webview 页面：把注入脚本丢进 vm 里真跑，DOM 是上面那套 */
function makePage(doc) {
  return {
    executeJavaScript: async (src) => vm.runInNewContext(src, { document: doc, console }),
  };
}

const bubblesOn = (main) => main.querySelectorAll('[data-owner]');

/* =====================================================================
 * 二、用例
 * ===================================================================== */
(async function run() {
  console.log('\n=========== WA① 中文译文气泡自检 ===========\n');

  /* ---- [A] 常量与说话口径 ---- */
  console.log('[A] 账号 / 节拍 / 50-100 规则');
  check('ACC_ID = 10（WA① 内置浏览器）', wb.ACC_ID === 10, String(wb.ACC_ID));
  check('节拍 = 3 秒（跟采集一致）', wb.POLL_MS === 3000, String(wb.POLL_MS));
  check('满 100 缩回 50（老板原话）', wb.BUBBLE_MAX === 100 && wb.BUBBLE_KEEP === 50,
    `${wb.BUBBLE_MAX}/${wb.BUBBLE_KEEP}`);
  check('没启动时 describe 说未启动', /未启动/.test(wb.describe({ watching: false }).text));
  check('describe 与 whatsappRead 同形状（{text, level}），界面两处共用一套',
    typeof wb.describe({ watching: true, status: 'ok' }).text === 'string'
    && typeof wb.describe({ watching: true, status: 'ok' }).level === 'string');

  /* ---- [B] 只读铁律（静态检查注入脚本） ---- */
  console.log('\n[B] 只读铁律：注入脚本里不许有「点/输入/滚动/发请求」');
  const injected = wb.readSource() + '\n' + wb.paintSource([{ mid: 'X', zh: '中文' }], ['Y']);
  const banned = [
    ['.click(', '点击'], ['dispatchEvent', '派发事件'], ['.value =', '改输入框'],
    ['scrollTo', '滚动'], ['scrollTop', '滚动'], ['sendMessage', '发消息'],
    ['fetch(', '网络请求'], ['XMLHttpRequest', '网络请求'], ['innerHTML =', '覆盖原节点'],
  ];
  for (const [needle, what] of banned) {
    check(`注入脚本不含「${what}」(${needle})`, injected.indexOf(needle) < 0);
  }
  check('注入脚本锚点 = #main [data-id]', injected.indexOf("querySelector('#main')") >= 0
    && injected.indexOf("querySelectorAll('[data-id]')") >= 0);
  check('注入脚本落点 = copyable-text 的父节点', injected.indexOf("querySelector('.copyable-text')") >= 0
    && injected.indexOf('box.parentNode') >= 0);

  /* ---- [C] 读「网页现在渲染了什么」 ---- */
  console.log('\n[C] 读网页：只认真的渲染出来的那几条');
  {
    const { doc, mids } = buildPage(5, (i) => 'Hello ' + i, (i) => i === 1 || i === 3);
    const out = vm.runInNewContext(wb.readSource(), { document: doc, console });
    check('返回 ok', out && out.ok === true, JSON.stringify(out));
    check('回收空壳被跳过（5 条里 2 条是空壳 → 只剩 3 条）', out.items.length === 3, String(out.items.length));
    check('留下的是 0/2/4 这三条', out.items.map((x) => x.mid).join(',') === [mids[0], mids[2], mids[4]].join(','),
      out.items.map((x) => x.mid).join(','));
    check('正文一起带回来了', out.items[0].text === 'Hello 0', out.items[0].text);
  }
  {
    const { doc } = buildPage(3, () => '   ');
    const out = vm.runInNewContext(wb.readSource(), { document: doc, console });
    check('全是空正文 → 一条都不算', out.ok === true && out.items.length === 0, JSON.stringify(out.items));
  }

  /* ---- [D] 贴气泡：位置 / 幂等 / 更新 / 摘除 ---- */
  console.log('\n[D] 贴气泡：贴哪、幂等、改文字、摘掉');
  {
    const { doc, main, mids } = buildPage(3, (i) => 'Hello ' + i);
    const rows = [{ mid: mids[0], zh: '你好 0' }, { mid: mids[2], zh: '你好 2' }];

    let r = vm.runInNewContext(wb.paintSource(rows, []), { document: doc, console });
    check('第一次贴了 2 条', r.ok === true && r.painted === 2, JSON.stringify(r));
    check('页面上正好 2 个气泡', bubblesOn(main).length === 2, String(bubblesOn(main).length));

    const holder0 = main.querySelectorAll('[data-id]')[0];
    const box0 = holder0.querySelector('.copyable-text');
    const host0 = box0.parentNode;
    const bubble0 = host0.children[host0.children.length - 1];
    check('气泡挂在 .copyable-text 的父节点下（第 4 节拍老板拍的「消息下方」）',
      bubble0.parentNode === host0, bubble0.parentNode && bubble0.parentNode._attrs.class);
    check('气泡排在正文之后（真的是「下方」）',
      host0.children.indexOf(bubble0) === host0.children.length - 1);
    check('气泡文字 = 中文译文', bubble0.textContent === '你好 0', bubble0.textContent);
    check('原正文一个字节没动', box0.textContent === '' && box0.innerText === 'Hello 0', box0.innerText);

    // 再贴一遍：幂等，不新增
    r = vm.runInNewContext(wb.paintSource(rows, []), { document: doc, console });
    check('重复贴不会越贴越多（painted = 0）', r.painted === 0 && r.updated === 0, JSON.stringify(r));
    check('页面上还是 2 个气泡', bubblesOn(main).length === 2, String(bubblesOn(main).length));

    // 改文字：只改文字，不动节点
    r = vm.runInNewContext(wb.paintSource([{ mid: mids[0], zh: '你好 0（改）' }], []), { document: doc, console });
    check('译文变了只改文字（updated = 1）', r.updated === 1 && r.painted === 0, JSON.stringify(r));
    check('文字确实换了', bubble0.textContent === '你好 0（改）', bubble0.textContent);
    check('节点还是原来那个（没重建）', host0.children[host0.children.length - 1] === bubble0);

    // 摘掉：50/100 缩容时用
    r = vm.runInNewContext(wb.paintSource([{ mid: mids[2], zh: '你好 2' }], [mids[0]]), { document: doc, console });
    check('缩容能摘掉指定气泡（removed = 1）', r.removed === 1, JSON.stringify(r));
    check('页面上只剩 1 个气泡', bubblesOn(main).length === 1, String(bubblesOn(main).length));
    check('被摘的是第一条', bubblesOn(main)[0].getAttribute('data-owner') === mids[2],
      bubblesOn(main)[0].getAttribute('data-owner'));
  }

  /* ---- [E] 整轮 tick：译文从库里拿、不重新翻、50/100 生效 ---- */
  console.log('\n[E] 整轮 tick（真数据库 + 假网页）：译文只从库里取');
  const CODE = 'WA09999';
  const N = 100;
  for (let i = 0; i < N; i++) {
    db.saveMessage({
      customerCode: CODE,
      accountId: 10,
      // 🔴 故意一半 in 一半 out：验证「一条消息算一条，不分方向」
      direction: i % 2 === 0 ? 'in' : 'out',
      body: 'Hello ' + i,
      bodyZh: '你好 ' + i,
      waMsgId: 'wabubble_' + i,
      msgTs: new Date(Date.now() + i * 1000).toISOString(),
      silent: true,
    });
  }
  {
    const { doc, main, mids } = buildPage(N, (i) => 'Hello ' + i);
    wb.startWatching({ findPage: () => makePage(doc) });

    await wb.tick();
    await sleep(30);

    const st = wb.state();
    check('tick 后状态 = ok', st.status === 'ok', st.status + ' / ' + st.error);
    check('网页上贴了 50 条气泡（满 100 缩回 50）', bubblesOn(main).length === 50, String(bubblesOn(main).length));
    check('记住的也是 50 条', st.remembered === 50, String(st.remembered));
    check('留下的是最新的 50 条（A050~A099）',
      bubblesOn(main).every((b) => Number(b.getAttribute('data-owner').slice(1)) >= 50));
    check('译文来自库里（不重新翻）—— 第一条气泡是「你好 99」',
      bubblesOn(main)[bubblesOn(main).length - 1].textContent === '你好 99',
      bubblesOn(main)[bubblesOn(main).length - 1].textContent);

    // 库里没有译文的消息：贴不出来，也不该现翻
    db.saveMessage({
      customerCode: CODE, accountId: 10, direction: 'in',
      body: 'No translation yet', bodyZh: null,
      waMsgId: 'wabubble_none', msgTs: new Date().toISOString(), silent: true,
    });
    const p2 = buildPage(2, (i) => (i === 0 ? 'No translation yet' : 'Hello 7'));
    wb.startWatching({ findPage: () => makePage(p2.doc) });
    await wb.tick();
    await sleep(30);
    check('库里没译文的那条：不贴、也不现翻',
      bubblesOn(p2.main).every((b) => b.getAttribute('data-owner') !== p2.mids[0]),
      String(bubblesOn(p2.main).length));
    check('同一句话在别处也贴得出来（翻译记忆生效）',
      bubblesOn(p2.main).some((b) => b.textContent === '你好 7'),
      String(bubblesOn(p2.main).length));

    // 中文正文：按翻译铁律，不贴气泡
    const p3 = buildPage(1, () => '这是一句中文');
    wb.startWatching({ findPage: () => makePage(p3.doc) });
    await wb.tick();
    await sleep(30);
    check('正常中文不贴气泡（翻译铁律）', bubblesOn(p3.main).length === 0, String(bubblesOn(p3.main).length));

    wb.stopWatching();
    check('stopWatching 后 watching = false', wb.state().watching === false);
  }

  /* ---- [F] 找不到网页时如实报告，不装死 ---- */
  console.log('\n[F] 找不到网页：如实报错，不假装成功');
  {
    wb.startWatching({ findPage: () => null });
    const st = await wb.tick();
    check('状态 = no-page', st.status === 'no-page', st.status);
    check('describe 会提示先把 WA① 页签打开', /WA①/.test(wb.describe(st).text), wb.describe(st).text);
    wb.stopWatching();
  }

  /* ---- [G] 接线：独立事件、不抢采集器的状态条 ---- */
  console.log('\n[G] 主进程接线');
  {
    const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    check('主进程真的把气泡起起来了', mainJs.includes('waBubble.startWatching(')
      && mainJs.includes("started.push('whatsapp-bubble')"));
    check('用独立事件广播（不抢采集器的 whatsapp_status，否则看着像采集坏了）',
      mainJs.includes("broadcastSafe('wa_bubble_status'")
      && !mainJs.includes("broadcastSafe('whatsapp_status', {\n          account: waBubble.ACC_ID"));
    const srvJs = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
    check('后端有只读状态/排障路由', srvJs.includes("'/api/whatsapp/bubble/state'")
      && srvJs.includes("'/api/whatsapp/bubble/probe'"));
  }

  console.log(`\n[WA①中文气泡自检] 通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
})();
