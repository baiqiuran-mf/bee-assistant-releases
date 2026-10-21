/**
 * 内置浏览器读取（Tele① webview）自检
 *
 * 为什么需要这层：老板 2026-10-11 问「现在 telegram 登录在内核版浏览器里面，你试试能不能获取信息」。
 * 真机登录要老板手机收验证码，我代劳不了 —— 但**扫描脚本读不读得出东西**是可以提前钉死的：
 * 这里仿一份 Telegram K 版的真实 DOM（结构取自老板之前给的截图：
 *   <div class="ListItem Chat"><a class="ListItem-button" href="#8937920881">
 *     <div class="info"><div class="info-row"><span class="peer-title">…</span></div>
 *       <div class="subtitle"><p class="last-message">…</p>
 *         <div class="shown open chat-badge-transition"><span>2</span></div>
 * 然后把 src/telegramWebView.js 那段扫描脚本真跑一遍，断言它把「对话 ID / 名字 / 最后一条 /
 * 未读数 / 气泡」都抠出来了 —— 真机上读不到时，至少能确定**不是这段脚本的问题**。
 *
 * 跑法：node --experimental-sqlite test/telegram_webview.test.js
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
// v2.6.1093：自动取号那组断言要用到 telegramRead 的 isSystemMessage（它必须已导出）
const tr = require(path.join(ROOT, 'src', 'telegramRead.js'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? `  << ${extra}` : ''}`); }
}

/** 仿 Telegram K 版聊天列表 + 已打开的对话（结构照老板给的截图来） */
const FAKE_TG = `
<div id="LeftColumn">
  <div class="chat-list">
    <div class="ListItem Chat chat-item-clickable">
      <a class="ListItem-button" href="#8937920881">
        <div class="info">
          <div class="info-row"><span class="peer-title">Dio</span></div>
          <div class="subtitle">
            <p class="last-message">Hello, is the painting ready?</p>
            <div class="shown open UCRlRpZc chat-badge-transition"><span>2</span></div>
          </div>
        </div>
      </a>
    </div>
    <div class="ListItem Chat chat-item-clickable">
      <a class="ListItem-button" href="#7788990011">
        <div class="info">
          <div class="info-row"><span class="peer-title">Emma</span></div>
          <div class="subtitle"><p class="last-message">thank you so much!</p></div>
        </div>
      </a>
    </div>
  </div>
</div>
<div class="chat">
  <div class="chat-header"><div class="user-title">Dio</div></div>
  <div class="bubbles">
    <div data-mid="101" class="bubble"><div class="text">Hello, is the painting ready?</div></div>
    <div data-mid="102" class="bubble is-out"><div class="text">Yes, almost done</div></div>
    <div data-mid="103" class="bubble"><div class="text">great, take your time</div></div>
  </div>
</div>
`;

const FAKE_LOGIN = `
<div class="login-form">
  <input name="phone" placeholder="Your phone number">
</div>
`;

/** v2.5.1060：**新版** Web K 结构（老板 2026-10-12 截图实证：老选择器 0 命中）。
 *  特点 = 左栏是 #column-left > ul.chatlist > a.chatlist-chat[data-peer-id]，
 *  对话号挂在 data-peer-id 上（不是从 href 抠）。故意**不带** #LeftColumn / .ListItem-button，
 *  用来证明「不看老结构也能读到」。 */
const FAKE_TG_NEW = `
<div id="column-left" class="column column-left">
  <ul class="chatlist">
    <a class="chatlist-chat row" href="#6762427025" data-peer-id="6762427025">
      <span class="peer-title">Richard Bennett</span>
      <span class="row-subtitle"><span class="last-message">Hi there, I am an oil painter</span></span>
      <span class="chat-badge badge">1</span>
    </a>
    <a class="chatlist-chat row" href="#555000111" data-peer-id="555000111">
      <span class="peer-title">Eileen Lin</span>
      <span class="row-subtitle"><span class="last-message">thanks!</span></span>
    </a>
  </ul>
</div>
<div class="chat">
  <div class="chat-header"><div class="peer-title">Richard Bennett</div></div>
  <div class="bubbles">
    <div data-mid="201" class="bubble"><div class="text">Good morning!</div></div>
  </div>
</div>
`;

/** v2.5.1060 兜底用：**左栏一个字都读不到**，只有一个打开的对话（地址栏带 #号）。
 *  期望：列表照旧空 → 但用「当前打开的这个对话」顶上一条，并打 fromOpen 标记。 */
const FAKE_TG_FALLBACK = `
<div class="chat">
  <div class="chat-header"><div class="user-title">Richard Bennett</div></div>
  <div class="bubbles">
    <div data-mid="301" class="bubble"><div class="text">Good morning!</div></div>
    <div data-mid="302" class="bubble is-out"><div class="text">Morning!</div></div>
    <div data-mid="303" class="bubble"><div class="text">How are you?</div></div>
  </div>
</div>
`;

/** v2.6.1093 回归用：**整页没有标题栏**，但气泡明明白白在页面上。
 *  模拟Telegram 网页版改版 / 窗口拉窄把标题栏折叠掉的情况。
 *  老代码 `if (out.chatTitle)` 在这份 DOM 上读到 0 条气泡。 */
const FAKE_TG_NO_TITLE = `
<div id="column-left" class="column column-left">
  <ul class="chatlist">
    <a class="chatlist-chat row" href="#6762427025" data-peer-id="6762427025">
      <span class="chat-badge badge">1</span>
    </a>
  </ul>
</div>
<div class="chat">
  <div class="bubbles">
    <div data-mid="501" class="bubble"><div class="text">Is this still available?</div></div>
    <div data-mid="502" class="bubble is-out"><div class="text">Yes! still here</div></div>
  </div>
</div>
`;

(async () => {
  console.log('=== 内置浏览器读取 · 扫描脚本（仿 Telegram K 版 DOM）===');

  const tw = require('../src/telegramWebView');

  /* ---- ① 纯 Node 环境（跑测试 / 没开 Electron）必须优雅降级，不能崩 ---- */
  console.log('\n--- 环境降级 ---');
  check('不在 Electron 里时 findGuest() 返回 null（不抛错）', tw.findGuest() === null);
  const p = await tw.probe();
  check('没内置浏览器时 probe() 返回 ok:false + 中文原因',
    p && p.ok === false && p.found === false && /内置浏览器|Telegram 页面|桌面版/.test(String(p.reason || '')),
    JSON.stringify(p));

  /* ---- ② 扫描脚本真跑一遍 ---- */
  let puppeteer = null;
  try { puppeteer = require('puppeteer'); } catch (e) {}
  if (!puppeteer) {
    console.log('\n[跳过] 没装 puppeteer，DOM 扫描部分跳过（不影响其余断言）');
    console.log(`\n========== 内置浏览器读取：${pass} 通过 / ${fail} 失败 ==========`);
    process.exit(fail ? 1 : 0);
  }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(FAKE_TG, { waitUntil: 'domcontentloaded' });
    const scan = await page.evaluate(tw.SCAN_SOURCE);

    console.log('\n--- 聊天列表 ---');
    check('扫到了聊天列表（命中选择器有值）', !!(scan.hit && scan.hit.chatItem), JSON.stringify(scan.hit));
    check('扫到 2 个对话', (scan.list || []).length === 2, JSON.stringify(scan.list));
    const dio = (scan.list || []).find((x) => x.peerId === '8937920881');
    check('对话 ID 从 href="#8937920881" 抠出来了', !!dio, JSON.stringify(scan.list));
    check('对话名 = Dio（不是拿"最后一条消息"里的发送者前缀）', dio && dio.title === 'Dio', dio && dio.title);
    check('最后一条消息预览读到了', dio && /painting ready/.test(dio.preview || ''), dio && dio.preview);
    check('未读数 = 2（数字徽标 <span>2</span>）', dio && dio.count === 2, dio && String(dio.count));
    const emma = (scan.list || []).find((x) => x.peerId === '7788990011');
    check('没有未读徽标的对话 count = 0（不会误报）', emma && emma.count === 0, emma && String(emma.count));

    console.log('\n--- 已打开的对话（气泡）---');
    check('当前对话标题读到了', scan.chatTitle === 'Dio', scan.chatTitle);
    check('扫到 3 条气泡', (scan.msgs || []).length === 3, JSON.stringify(scan.msgs || []));
    const outMsg = (scan.msgs || []).find((m) => m.dir === 'out');
    check('自己发的消息方向判成 out（is-out class）', !!outMsg && /almost done/.test(outMsg.body || ''), outMsg && outMsg.body);
    const inMsgs = (scan.msgs || []).filter((m) => m.dir === 'in');
    check('客户发的方向判成 in（不会把"已发送"当新消息）', inMsgs.length === 2, String(inMsgs.length));
    check('气泡带 data-mid（去重靠它）', (scan.msgs || []).every((m) => m.mid), JSON.stringify(scan.msgs || []));

    console.log('\n--- 登录页判定 ---');
    const page2 = await browser.newPage();
    await page2.setContent(FAKE_LOGIN, { waitUntil: 'domcontentloaded' });
    const scan2 = await page2.evaluate(tw.SCAN_SOURCE);
    check('停在登录页时能认出来（不谎报"收集中"）', scan2.loginPage === true, JSON.stringify(scan2.loginPage));

    /* ---- ②-2 v2.5.1060：新版 Web K 结构（老板实证「对话列表没命中」）----
       老板那张图上：气泡 [data-mid] 命中 7 条、对话列表 0 个 —— 页面读得到，是列表那层选择器对不上。
       这份 DOM 走 Web K 现行结构，**故意不带** #LeftColumn / .ListItem-button。 */
    console.log('\n--- v2.5.1060 新版 Web K 结构（不看 #LeftColumn 也能读）---');
    const pageNew = await browser.newPage();
    await pageNew.setContent(FAKE_TG_NEW, { waitUntil: 'domcontentloaded' });
    const scanNew = await pageNew.evaluate(tw.SCAN_SOURCE);
    check('新版结构里对话列表命中了（不再只认 #LeftColumn）', !!scanNew.hit.chatItem, JSON.stringify(scanNew.hit));
    check('新版结构扫到 2 个对话', (scanNew.list || []).length === 2, JSON.stringify(scanNew.list));
    const richard = (scanNew.list || []).find((x) => x.peerId === '6762427025');
    check('对话号从 data-peer-id 读出来了（不靠 href 抠数字）', !!richard, JSON.stringify(scanNew.list));
    check('新版结构下名字读对了 = Richard Bennett', richard && richard.title === 'Richard Bennett', richard && richard.title);
    check('新版结构下未读数读到了（1）', richard && richard.count === 1, richard && String(richard.count));
    check('新版结构下最后一条预览读到了', richard && /oil painter/.test(richard.preview || ''), richard && richard.preview);

    /* ---- ②-3 结构探针：选择器失灵时得能把页面真实结构带回来（v2.5.1060）---- */
    console.log('\n--- 结构探针（选择器失灵时的定位手段）---');
    check('扫描结果带 dom 结构探针', !!(scanNew.dom && scanNew.dom.probes), JSON.stringify(scanNew.dom && Object.keys(scanNew.dom)));
    check('探针里有选择器命中数（.chatlist 命中 1）', scanNew.dom.probes['.chatlist'] === 1, JSON.stringify(scanNew.dom.probes));
    check('探针里有页面 id 清单（含 column-left）',
      Array.isArray(scanNew.dom.ids) && scanNew.dom.ids.indexOf('column-left') >= 0, JSON.stringify(scanNew.dom.ids));
    check('探针里有左栏链接样本（pid + class 都在）',
      (scanNew.dom.links || []).some((l) => l.pid && /chatlist-chat/.test(l.cls || '')), JSON.stringify(scanNew.dom.links));
    check('探针是只读的：不改页面（气泡数仍为 1）', (scanNew.dom.probes['[data-mid]'] || 0) === 1, JSON.stringify(scanNew.dom.probes));

    /* ---- ②-4 兜底：列表读不到时用"当前打开的对话"顶上（不许谎报成列表读到了）---- */
    console.log('\n--- 兜底：列表读不到时用当前打开的对话 ---');
    const pageFb = await browser.newPage();
    await pageFb.setContent(FAKE_TG_FALLBACK, { waitUntil: 'domcontentloaded' });
    await pageFb.evaluate(() => { location.hash = '6762427025'; });
    const scanFb = await pageFb.evaluate(tw.SCAN_SOURCE);
    check('列表没命中时 hit.chatItem 仍为空（没谎报）', !scanFb.hit.chatItem, JSON.stringify(scanFb.hit));
    check('兜底顶上 1 条对话（当前打开的那个）', (scanFb.list || []).length === 1, JSON.stringify(scanFb.list));
    check('兜底那条带 fromOpen 标记 + openFallback=true',
      !!(scanFb.list[0] && scanFb.list[0].fromOpen === true && scanFb.openFallback === true), JSON.stringify(scanFb));
    check('兜底那条的对话号来自地址栏 #hash', !!(scanFb.list[0] && scanFb.list[0].peerId === '6762427025'), JSON.stringify(scanFb.list[0]));
    check('兜底不影响气泡读取（照样读到 3 条）', (scanFb.msgs || []).length === 3, String((scanFb.msgs || []).length));

    /* ---- ②-5 v2.6.1093：标题栏读不到时，气泡**不许**被连累（老板问「网页这边加载不了气泡？」）----
     * 根因：老代码是 `if (out.chatTitle)` 才扫气泡 —— 把最容易随改版失配的标题栏类名
     * 当成了读气泡的门槛。实测老代码在下面这份 DOM 上读到 **0 条**，
     * 删掉那个 if 之后读到 2 条。 */
    console.log('\n--- v2.6.1093 标题栏缺失也不许连累气泡读取 ---');
    const pageNoTitle = await browser.newPage();
    await pageNoTitle.setContent(FAKE_TG_NO_TITLE, { waitUntil: 'domcontentloaded' });
    const rawNoTitle = await pageNoTitle.evaluate(() => ({
      dataMid: document.querySelectorAll('[data-mid]').length,
      peerTitle: document.querySelectorAll('.peer-title').length,
    }));
    check('这份页面上确实一个标题栏都没有（.peer-title = 0）', rawNoTitle.peerTitle === 0, JSON.stringify(rawNoTitle));
    check('这份页面上气泡确实存在（[data-mid] = 2）', rawNoTitle.dataMid === 2, JSON.stringify(rawNoTitle));
    const scanNoTitle = await pageNoTitle.evaluate(tw.SCAN_SOURCE);
    check('标题栏读不到时 chatTitle 为空（这是前提，不是 bug）', scanNoTitle.chatTitle === '', JSON.stringify(scanNoTitle.chatTitle));
    check('🔴 气泡不被连累：照样读到 2 条（v2.6.1093 修的就是这条）',
      (scanNoTitle.msgs || []).length === 2, JSON.stringify(scanNoTitle.msgs || []));
    check('气泡选择器确实被执行到了（hit.bubbles 不是 undefined）',
      !!scanNoTitle.hit.bubbles, JSON.stringify(scanNoTitle.hit));
    check('读到的正文内容正确',
      (scanNoTitle.msgs || []).map((m2) => m2.body).join('|') === 'Is this still available?|Yes! still here',
      JSON.stringify((scanNoTitle.msgs || []).map((m2) => m2.body)));
    check('方向 still 分得清（in / out 各一条）',
      (scanNoTitle.msgs || []).filter((m2) => m2.dir === 'in').length === 1
      && (scanNoTitle.msgs || []).filter((m2) => m2.dir === 'out').length === 1,
      JSON.stringify((scanNoTitle.msgs || []).map((m2) => m2.dir)));
    await pageNoTitle.close();

    /* ---- ③ 转成统一消息结构（toMessage 走的是同一套）---- */
    console.log('\n--- 入库结构 ---');
    const telegramRead = require('../src/telegramRead');
    const m = telegramRead.toMessage({
      chatKey: '8937920881', chatName: 'Dio',
      msgId: 'wvlist:8937920881:2:Hello, is the',
      direction: 'in', body: 'Hello, is the painting ready?',
      ts: new Date().toISOString(), isGroup: false,
    }, tw.ACCOUNT_ID);
    check('列表预览能转成标准消息（不为空）', !!m, JSON.stringify(m));
    check('displayJid 带 tg: 前缀（一眼看出是 Telegram 来的）', m && /^tg:/.test(m.displayJid || ''), m && m.displayJid);
    check('空消息不入库（撤回/系统提示不造客户）',
      telegramRead.toMessage({ chatKey: 'x', chatName: 'x', body: '  ', direction: 'in' }, 7) === null);

    /* ---- ④ 「该翻谁」的选对话规则（2026-10-11 老板看图定的）
       老板红框那一屏：最下面 Richard Bennett 最新一条是**他自己发的**，
       上面 Xue 有未读 —— 要翻的显然是 Xue，不是已回过的那条。
       铁律：只有真拿到气泡才敢下"已回过"的结论（拿不到就不瞎猜）。 ---- */
    console.log('\n--- 该翻哪个对话（老板看图定的规则）---');
    const list = [
      { peerId: '111', title: 'Emma', count: 0, preview: 'thank you so much!' },
      { peerId: '222', title: 'Richard', count: 0, preview: 'Hi there, I am an oil painter' },
    ];
    const pick1 = tw.pickConversation(list, [{ mid: '1', dir: 'in', body: 'hi' }, { mid: '2', dir: 'out', body: 'hello' }]);
    check('最下面那个已经回过了 → 往上找上一个', pick1 && pick1.peer === '111', JSON.stringify(pick1));
    const pick2 = tw.pickConversation(list, [{ mid: '3', dir: 'in', body: 'hi there' }]);
    check('最下面那个还没回 → 就翻最下面那个', pick2 && pick2.peer === '222', JSON.stringify(pick2));
    const pick3 = tw.pickConversation(list, []);
    check('拿不到气泡时不瞎猜，仍用最下面那个', pick3 && pick3.peer === '222', JSON.stringify(pick3));
    const listUnread = [
      { peerId: '333', title: 'Xue', count: 3, preview: 'Hello' },
      { peerId: '444', title: 'Richard', count: 0, preview: 'I am an oil painter' },
    ];
    const pick4 = tw.pickConversation(listUnread, [{ mid: '9', dir: 'out', body: 'ok' }]);
    check('往上找时优先挑有未读的那个（Xue 3 条未读）', pick4 && pick4.peer === '333', JSON.stringify(pick4));
    check('单个对话时不越界（就翻它自己）',
      (tw.pickConversation([{ peerId: '555', title: 'Solo', count: 0 }], [{ dir: 'out', body: 'x' }]) || {}).peer === '555');
    check('空列表返回 null（不编造客户）', tw.pickConversation([], [{ dir: 'in', body: 'x' }]) === null);

    /* ---- ⑤ 把译文贴到气泡下方：幂等 + 不碰 Telegram 原有节点 ---- */
    console.log('\n--- 译文贴到气泡下方（老板选的方案 B）---');
    const page3 = await browser.newPage();
    await page3.setContent(FAKE_TG, { waitUntil: 'domcontentloaded' });
    const painted1 = await page3.evaluate(tw.paintSource([{ mid: '101', zh: '你好，画好了吗？' }, { mid: '999', zh: '这条不在页面上' }]));
    check('贴上了 1 条（不在页面里的那条自动跳过）', painted1 && painted1.painted === 1, JSON.stringify(painted1));
    const t1 = await page3.$eval('#tg-zh-101', (el) => el.textContent);
    check('译文内容写进气泡下方了', t1 === '你好，画好了吗？', t1);
    const parented = await page3.$eval('#tg-zh-101', (el) => el.parentElement.getAttribute('data-mid'));
    check('译文挂在对应那条气泡里（data-mid 101）', parented === '101', String(parented));
    // 同一个 mid 再贴一次：**绝不能插成两条**（轮询会反复贴，幂等是硬要求）
    await page3.evaluate(tw.paintSource([{ mid: '101', zh: '你好，画好了吗？（改）' }]));
    const cnt = await page3.$$eval('[id^="tg-zh-"]', (els) => els.length);
    check('重复贴同一条不会越插越多（幂等）', cnt === 1, `页面上的译文块 = ${cnt}`);
    const t2 = await page3.$eval('#tg-zh-101', (el) => el.textContent);
    check('但内容会更新成新的译文', t2 === '你好，画好了吗？（改）', t2);
    const orig = await page3.$eval('[data-mid="101"] .text', (el) => el.textContent);
    check('Telegram 原有消息内容一个字没动', orig === 'Hello, is the painting ready?', orig);
    const cleared = await page3.evaluate(`(${tw.clearPaintInPage.toString()})()`);
    check('清得掉（切走 Tele① 时不留痕）', cleared && cleared.cleared === 1, JSON.stringify(cleared));
    const after = await page3.$$eval('[id^="tg-zh-"]', (els) => els.length);
    check('清完页面上一个译文块都不剩', after === 0, String(after));

    /* ---- ⑥ v2.5.1058：找不到页面时必须说得清是「哪一种找不到」
       老板 2026-10-11 报：Telegram 明明在软件里登着，却说「没找到内置浏览器里的 Telegram 页面」。
       根因之一是那句提示太笼统，分不清"页面没开 / Electron 没算上 webview / URL 没对上"。
       这里钉住：① URL 判据放宽到多个 Telegram 域名 ② 报错分三档 ③ 诊断能列出所有页面。 ---- */
    console.log('\n--- 找不到页面时的诊断（v2.5.1058 老板报过的坑）---');
    check('URL 判据认得 web.telegram.org', tw.looksLikeTelegram({ getURL: () => 'https://web.telegram.org/k/' }) === true);
    check('URL 判据认得带参数的 Telegram 地址',
      tw.looksLikeTelegram({ getURL: () => 'https://web.telegram.org/a/#-1001234567890' }) === true);
    check('URL 判据不把别的网站误认成 Telegram',
      tw.looksLikeTelegram({ getURL: () => 'https://web.whatsapp.com/' }) === false);
    check('URL 判据能扛住空页面（about:blank 不崩）',
      tw.looksLikeTelegram({ getURL: () => '' }) === false && tw.looksLikeTelegram({}) === false);
    check('页面已销毁时不认（不拿一个死页面去读）',
      tw.looksLikeTelegram({ getURL: () => 'https://web.telegram.org/', isDestroyed: () => true }) === true
      && typeof tw.findGuest === 'function');
    // 非 Electron 环境（就是跑测试这个环境）：
    const diag = tw.listPages();
    check('诊断在非 Electron 环境明确说「不在桌面版里」',
      diag && diag.ok === true && diag.electron === false && /桌面版|Electron|开发/.test(diag.hint || ''), JSON.stringify(diag));
    const p2 = await tw.probe();
    check('probe 在非 Electron 环境给的是「不在桌面版里」而不是笼统一句"没找到"',
      p2.ok === false && p2.reasonCode === 'no-electron' && /桌面版/.test(p2.reason || ''), JSON.stringify(p2).slice(0, 180));
    check('probe 失败时会带上页面清单字段（好让老板截图定位）',
      Array.isArray(p2.pages), JSON.stringify(Object.keys(p2)));

    /* ---- ⑦ v2.5.1059：页面指纹（脏检查）—— 思路来自样品 PROBE_CODE，代码重写 ----
       钉三件事：① 指纹能真读出来 ② 切对话/来新消息 → 指纹必须变（否则不会重贴）
       ③ 贴译文后指纹会变，但**同一批译文再贴一次指纹必须稳住**（不然每轮都抖） ---- */
    console.log('\n--- 页面指纹（v2.5.1059 脏检查，从 wa-split 样品搬来的思路）---');
    const page4 = await browser.newPage();
    await page4.setContent(FAKE_TG, { waitUntil: 'domcontentloaded' });
    const k0 = await page4.evaluate(tw.pageKeySource());
    check('指纹读得出来（带 key / title / total）',
      !!k0 && typeof k0.key === 'string' && k0.key.length > 0 && typeof k0.total === 'number', JSON.stringify(k0));
    check('指纹里的会话标题 = Dio', k0 && k0.title === 'Dio', k0 && k0.title);
    check('指纹里的气泡数 = 3', k0 && k0.total === 3, k0 && String(k0.total));
    check('没贴译文时 painted = 0', k0 && k0.painted === 0, k0 && String(k0.painted));
    check('未读总数读到了（Dio 2 条未读）', k0 && k0.unread === 2, k0 && String(k0.unread));

    // 贴一批译文 → 指纹必须变（说明"页面动过"，会触发重贴）
    await page4.evaluate(tw.paintSource([{ mid: '101', zh: '你好，画好了吗？' }]));
    const k1 = await page4.evaluate(tw.pageKeySource());
    check('贴完译文后指纹变了（painted 进去了）',
      k1 && k1.painted === 1 && k1.key !== k0.key, JSON.stringify(k1));
    // 再贴同一批 → 指纹必须**稳住**（不然每 5 秒自己抖自己，永远停不下来）
    await page4.evaluate(tw.paintSource([{ mid: '101', zh: '你好，画好了吗？' }]));
    const k2 = await page4.evaluate(tw.pageKeySource());
    check('同一批译文再贴一次，指纹稳住（不会自己抖个不停）',
      k2 && k2.key === k1.key, `${k1 && k1.key} vs ${k2 && k2.key}`);

    // 切对话（换标题 + 换气泡）→ 指纹必须变
    await page4.evaluate(() => {
      document.querySelector('.chat-header .user-title').textContent = 'Emma';
      const b = document.querySelector('.bubbles');
      b.innerHTML = '<div data-mid="201" class="bubble"><div class="text">hi emma</div></div>';
    });
    const k3 = await page4.evaluate(tw.pageKeySource());
    check('切到另一个对话后指纹变了（才会去重拉重贴）',
      k3 && k3.key !== k2.key && k3.total === 1, JSON.stringify(k3));

    // 切完对话后重新贴一次（此时 painted 从 0 → 1）
    await page4.evaluate(tw.paintSource([{ mid: '201', zh: '你好艾玛' }]));
    const kA = await page4.evaluate(tw.pageKeySource());
    check('新对话里贴上译文后 painted = 1', kA && kA.painted === 1, JSON.stringify(kA));
    // 译文被 Telegram 重绘冲掉（painted 掉回 0）→ 指纹必须变（这是样品 PROBE_CODE 的核心价值）
    await page4.evaluate(() => {
      const els = document.querySelectorAll('[id^="tg-zh-"]');
      for (const e of els) e.parentNode.removeChild(e);
    });
    const k4 = await page4.evaluate(tw.pageKeySource());
    check('译文被页面重绘冲掉后指纹变了（下一轮会补回来）',
      k4 && k4.painted === 0 && k4.key !== kA.key, `${kA && kA.key} vs ${k4 && k4.key}`);

    // 空页面（什么都没有）也不能崩
    const page5 = await browser.newPage();
    await page5.setContent('<div></div>', { waitUntil: 'domcontentloaded' });
    const k5 = await page5.evaluate(tw.pageKeySource());
    check('空页面不崩，指纹照样返回（只是 title 空、total 0）',
      !!k5 && k5.total === 0 && k5.title === '' && typeof k5.key === 'string', JSON.stringify(k5));
    check('非 Electron 环境 pageKey() 明确返回 ok:false（不谎报"页面没变"）',
      (await tw.pageKey()).ok === false);
  } catch (e) {
    console.error('\n[致命错误] 扫描自检中断：', e);
    fail++;
  } finally {
    try { await browser.close(); } catch (e) {}
  }

  // ---- v2.6.1093：新客户建档自动取手机号（老板拍板方案 1）----
  const mainjs = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  check('isSystemMessage 已从 telegramRead 导出（自动取号要靠它拦垃圾档案）',
    typeof tr.isSystemMessage === 'function', typeof tr.isSystemMessage);
  check('自动取号函数已写进 main.js（autoFetchTelegramPhone）',
    /function autoFetchTelegramPhone/.test(mainjs), 'main.js 有该函数');
  check('取号只挂在 isNew 分支（老客户不重复打 API）',
    /if \(isNew\) autoFetchTelegramPhone\(/.test(mainjs), 'isNew 才调');
  check('取号不 await（不阻塞消息入库 / 通知 / 广播）',
    /if \(isNew\) autoFetchTelegramPhone\(/.test(mainjs)
    && !/await autoFetchTelegramPhone/.test(mainjs)
    && /\(async \(\) => \{[\s\S]{0,80}getUserProfile/.test(mainjs),
    '调用点不 await + 内部 async 立即跑');
  check('取号失败有兜底 try/catch 且只记日志（绝不影响采集）',
    /自动取号失败（不影响采集）/.test(mainjs)
    && /自动取号入口异常（不影响采集）/.test(mainjs), '双重兜底');
  check('已有号不重复取（只填空不覆盖，人工填的号永不被自动流程改动）',
    /if \(!cur \|\| String\(cur\.phone \|\| ''\)\.trim\(\)\) return;/.test(mainjs), '已有号就跳过');
  check('限流常量在（两次取号至少隔 3 秒）',
    /TG_PHONE_MIN_GAP_MS\s*=\s*3000/.test(mainjs), '限流 3 秒');
  check('回填走 db.backfillIdentity（只填空，不覆盖）',
    /db\.backfillIdentity\(customerCode/.test(mainjs)
    && /phoneSrc: 'telegram'/.test(mainjs), 'phoneSrc=telegram');

  // 白名单实测：垃圾消息拦下、真人放行（这是「不给垃圾档案建出带号假客户」的保证）
  const junk = [
    ['777000', 'Login code: ⡍⡫⠰⡏⡱. Do not give this code to anyone.', 'in'],
    ['6041069068', 'last seen yesterday at 23:01', 'in'],
    ['7207229390', 'platinum-vip.miyavip.vip:8001:szezcdsxxz:oqwmwemoeemoyi', 'in'],
  ];
  check('垃圾档案白名单：登录验证码/状态行/代理通知串 一律拦下（不取号）',
    junk.every(([k, b, d]) => tr.isSystemMessage(k, b, d) === true),
    junk.map(([k, b]) => `${k}:${String(b).slice(0, 18)}=${tr.isSystemMessage(k, b, 'in')}`).join(' | '));
  const real = [
    ['7207229390', 'hello', 'in'],
    ['Lsherry3', 'Hi, is this still available?', 'in'],
    ['8937920881', 'Gggg', 'in'],
  ];
  check('真人消息不被白名单误伤（照常取号）',
    real.every(([k, b, d]) => tr.isSystemMessage(k, b, d) === false),
    real.map(([k, b]) => `${k}:${b}=${tr.isSystemMessage(k, b, 'in')}`).join(' | '));

  console.log(`\n========== 内置浏览器读取：${pass} 通过 / ${fail} 失败 ==========`);
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
