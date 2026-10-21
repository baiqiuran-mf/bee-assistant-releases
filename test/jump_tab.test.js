/**
 * v2.5.1061：跳转「检测 IM 标签 + 自动选中」逻辑单测
 * 跑法：node --experimental-sqlite test/jump_tab.test.js
 *
 * 重点：复现老板 2026-10-12 指出的坑 —— revealBrowser 会先把「第一个非 about:blank 的标签」顶上来，
 *       不一定是 IM 标签；selectImTab 必须在「激活窗口之后」重新枚举并选中 IM 标签。
 */
const { pickImTab, selectImTab } = require('../src/jumpTab');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}

// ---- 假对象 ----
function fakePage(url, log) {
  return {
    _url: url,
    url() { return this._url; },
    bringToFront() { if (log) log.push(this._url); return Promise.resolve(); },
  };
}
function fakeBrowser(pages) {
  return { pages() { return Promise.resolve(pages); } };
}

const WA = 'https://web.whatsapp.com/';
const TG = 'https://web.telegram.org/k/';
const BLANK = 'about:blank';

console.log('\n=== pickImTab（检测 IM 标签）===');
{
  const wa = fakePage(WA), blank = fakePage(BLANK), tg = fakePage(TG);
  check('从 [WA, blank, TG] 里挑出 WA 标签', pickImTab([wa, blank, tg], /web\.whatsapp\.com/) === wa);
  check('没有 WA 标签时返回 null', pickImTab([blank, tg], /web\.whatsapp\.com/) === null);
  check('空数组返回 null', pickImTab([], /web\.whatsapp\.com/) === null);
  check('undefined 返回 null', pickImTab(undefined, /web\.whatsapp\.com/) === null);
  check('Telegram 正则能挑出 TG 标签', pickImTab([wa, tg], /web\.telegram\.org|telegram\.org/) === tg);
}

console.log('\n=== selectImTab（激活窗口 + 自动选中，盖过 reveal 的内部选择）===');
(async () => {
  // 1) 正常：reveal 不顶标签，最后应该选中 WA
  {
    const fronted = [];
    const wa = fakePage(WA, fronted), blank = fakePage(BLANK, fronted);
    const browser = fakeBrowser([wa, blank]);
    const reveal = () => {};
    const r = await selectImTab(browser, wa, /web\.whatsapp\.com/, 1, reveal);
    check('最终选中 WA 标签（fronted 含 WA）', fronted.includes(WA), 'fronted=' + JSON.stringify(fronted));
    check('返回的就是 WA page', r === wa);
  }

  // 2) 关键回归：reveal 先顶了「别的标签」，selectImTab 仍要把 IM 标签顶上来（且是最后一个被前置的）
  {
    const fronted = [];
    const wa = fakePage(WA, fronted);
    const other = fakePage('https://example.com/', fronted);
    const browser = fakeBrowser([other, wa]); // WA 不是第一个
    const reveal = () => { other.bringToFront(); }; // reveal 把 example.com 顶上
    const r = await selectImTab(browser, wa, /web\.whatsapp\.com/, 1, reveal);
    check('reveal 先顶了别的标签（example.com 进了 fronted）', fronted.includes('https://example.com/'), 'fronted=' + JSON.stringify(fronted));
    check('但 fronted 末尾是 WA（证明 IM 标签最终被选中，盖过 reveal）', fronted[fronted.length - 1] === WA, 'fronted=' + JSON.stringify(fronted));
    check('返回的仍是 WA page', r === wa);
  }

  // 3) reveal 抛错也不影响选标签
  {
    const wa = fakePage(WA);
    const browser = fakeBrowser([wa]);
    const reveal = () => { throw new Error('reveal 炸了'); };
    let threw = false;
    let r;
    try { r = await selectImTab(browser, wa, /web\.whatsapp\.com/, 1, reveal); } catch (e) { threw = true; }
    check('reveal 抛错不向上抛', !threw);
    check('reveal 抛错后仍选中 WA', r === wa);
  }

  // 4) browser 为 null → 直接返回原 page，reveal 不调用
  {
    let revealCalled = false;
    const wa = fakePage(WA);
    const r = await selectImTab(null, wa, /web\.whatsapp\.com/, 1, () => { revealCalled = true; });
    check('browser 为 null 时 reveal 不被调用', revealCalled === false);
    check('browser 为 null 时返回原 page', r === wa);
  }

  // 5) Telegram 场景：reveal 顶错标签，最终选中 TG
  {
    const tg = fakePage(TG), other = fakePage('https://example.com/');
    const browser = fakeBrowser([other, tg]);
    const reveal = () => { other.bringToFront(); };
    const r = await selectImTab(browser, tg, /web\.telegram\.org|telegram\.org/, 7, reveal);
    check('Telegram：最终选中 TG 标签', r === tg);
  }

  console.log(`\n========== 跳转标签选择：${pass} 通过 / ${fail} 失败 ==========`);
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
  process.exit(0);
})();
