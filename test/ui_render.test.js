/**
 * 界面真实渲染自检（puppeteer headless）
 *
 * 为什么需要这层：光看代码看不出「主界面不见了」「按钮没出来」「提示条堆成一片」。
 * 上一版的扫码弹窗是 position:fixed + inset:0 的半透明遮罩，一收到二维码就把整个主界面糊住。
 * 所以这里真的开一个浏览器把页面渲染出来，量 main / 列表 / 对话 / 右栏的可见尺寸，
 * 确认没有任何全屏元素盖在上面，并核对：五个账号排成一行 + 红绿灯、顶栏有「⚙ AI 设置」、
 * 提示条是单行且落在「客户档案」右栏上方（按最新需求，二维码已不再出现在主界面）。
 *
 * 跑法：node --experimental-sqlite test/ui_render.test.js
 * 输出：PASS/FAIL 明细 + preview/界面自检.png（可以直接打开看）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { DIR } = require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8981;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + extra : ''}`); }
}

const FAKE_ACCOUNTS = [
  { id: 1, label: '一号', status: 'waiting_qr' },
  { id: 2, label: '二号', status: 'online' },
  { id: 3, label: '三号', status: 'offline' },
  { id: 4, label: '四号', status: 'offline' },
  { id: 5, label: '五号', status: 'error' },
].map((a) => ({ ...a, enabled: a.id === 1, proxy: '' }));

function hasPuppeteer() {
  try {
    require.resolve('puppeteer');
    return true;
  } catch (e) {
    try {
      require.resolve('puppeteer-core');
      return spawnSync(path.join(ROOT, 'node_modules', '.bin', 'puppeteer.cmd'), ['--version']).status === 0;
    } catch (e2) {
      return false;
    }
  }
}

(async () => {
  if (!hasPuppeteer()) {
    console.log('[跳过] 没装 puppeteer，跳过界面渲染自检（不影响其它测试）');
    process.exit(0);
  }

  const db = require('../src/db');
  const doc = require('../src/customerDoc');
  const ai = require('../src/ai');
  const knowledge = require('../src/knowledge');
  const { createServer } = require('../src/server');
  const { loadConfig } = require('../src/main');

  const cfg = loadConfig();
  const srv = createServer(
    { db, doc, ai, knowledge, cfg, getAccountStates: () => FAKE_ACCOUNTS },
    PORT
  );
  await new Promise((res, rej) => {
    srv.server.once('error', rej);
    srv.server.listen(PORT, '127.0.0.1', res);
  });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    // 桌面窗口的默认尺寸，按真实使用场景量
    await page.setViewport({ width: 1280, height: 820 });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1200));

    // 这一节守的是「改了界面，窗口还是旧样子」这个坑：
    // 静态文件必须明确不缓存，且 index.html 里的 ?v=__BUILD__ 要被换成真实构建戳。
    console.log('\n=== 界面渲染 · 界面文件不缓存 + 版本号 ===');
    const resHtml = await fetch(`http://127.0.0.1:${PORT}/`);
    const htmlTxt = await resHtml.text();
    const ccHtml = resHtml.headers.get('cache-control') || '';
    check('index.html 带 no-store（不缓存）', /no-store/.test(ccHtml), ccHtml);
    check('index.html 里 __BUILD__ 已换成真实构建戳',
      !htmlTxt.includes('__BUILD__') && /\?v=20\d{6}-\d{4}/.test(htmlTxt),
      (htmlTxt.match(/\?v=\S+/g) || []).slice(0, 2).join(' , '));
    const resJs = await fetch(`http://127.0.0.1:${PORT}/app.js`);
    const ccJs = resJs.headers.get('cache-control') || '';
    check('app.js 带 no-store（不缓存）', /no-store/.test(ccJs), ccJs);
    const resCss = await fetch(`http://127.0.0.1:${PORT}/style.css`);
    const ccCss = resCss.headers.get('cache-control') || '';
    check('style.css 带 no-store（不缓存）', /no-store/.test(ccCss), ccCss);
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/api/version`)).json();
    check('/api/version 返回构建戳', /^20\d{6}-\d{4}$/.test(String(ver.build)), JSON.stringify(ver));
    check('/api/version 给出界面文件目录', typeof ver.publicDir === 'string' && ver.publicDir.length > 0, String(ver.publicDir));
    const stampVisible = await page.evaluate(() => (document.querySelector('#build')?.textContent || '').trim());
    check('顶栏真的显示出界面版本号', /v\d{2}-\d{2}/.test(stampVisible), JSON.stringify(stampVisible));

    console.log('\n=== 界面渲染 · 主界面必须真的在 ===');
    const m = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display };
      };
      // 盖在主界面上的东西：fixed 定位 + 可见 + 面积超过窗口 1/4
      const covers = [...document.querySelectorAll('body *')]
        .filter((el) => {
          // 🔴 登录浮层（#boot-login）是「打开软件先登录」的有意全屏门，
          // 不是会糊住主界面的意外遮罩（本自检原意只盯扫码弹窗那类意外层）。
          // 它在成功登录后才 hidden，这里不应算作"盖住主界面"。
          if (el.id === 'boot-login') return false;
          const cs = getComputedStyle(el);
          if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return false;
          if (Number(cs.opacity) < 0.05 || cs.pointerEvents === 'none') return false;
          const r = el.getBoundingClientRect();
          return r.width * r.height > window.innerWidth * window.innerHeight * 0.25;
        })
        .map((el) => el.id || el.className || el.tagName);
      return {
        main: box('main'),
        list: box('#list'),
        chat: box('#chat'),
        panel: box('#panel'),
        covers,
        accts: document.querySelectorAll('#accounts .acct').length,
        leds: [...document.querySelectorAll('#accounts .led')].map((l) => l.className.trim()),
        openBtns: document.querySelectorAll('#accounts button[data-act="open"]').length,
        qrBtns: document.querySelectorAll('#accounts button[data-act="qr"]').length,
        btnTexts: [...document.querySelectorAll('#accounts button')].map((b) => b.textContent.trim()),
        headerH: Math.round(document.querySelector('header').getBoundingClientRect().height),
        accountRows: new Set([...document.querySelectorAll('#accounts .acct')].map((a) => Math.round(a.getBoundingClientRect().top))).size,
        // 顶栏第一行最右端的社交平台官网 LOGO（2026-09-26 用户要求：从账号条挪到第一行、
        //   紧跟「🧪 模拟新消息」右边）
        logoCount: document.querySelectorAll('#brand-logos .brand-logo').length,
        logoNames: [...document.querySelectorAll('#brand-logos .brand-logo')].map((e) => e.getAttribute('title')),
        logoSizes: [...document.querySelectorAll('#brand-logos .brand-logo svg')].map((s) => {
          const r = s.getBoundingClientRect();
          return `${Math.round(r.width)}x${Math.round(r.height)}`;
        }),
        logoSameRowAsSetBtn: (() => {
          const wrap = document.querySelector('#brand-logos');
          const setBtn = document.querySelector('#btn-settings');
          if (!wrap || !setBtn) return false;
          const wr = wrap.getBoundingClientRect();
          const sr = setBtn.getBoundingClientRect();
          // 2026-09-30 用户要求 LOGO 改「依靠左侧」：排到「⚙ 设置」左边，但同一行
          return wr.right <= sr.left + 2 && Math.abs(wr.top - sr.top) < 12;
        })(),
        logoRightOfBrand: (() => {
          const wrap = document.querySelector('#brand-logos');
          const brand = document.querySelector('header .brand');
          if (!wrap || !brand) return false;
          // 靠左那一簇：品牌名在左、LOGO 紧跟其右
          return wrap.getBoundingClientRect().left >= brand.getBoundingClientRect().right - 2;
        })(),
        // 「＋手动录入 / 话术编排台 / ⚙设置」这一组 2026-09-30 按用户要求整体靠右：
        //   组内最后一个按钮的右边 ≈ 顶栏第一行的右边（留出一点 padding）
        actionsHugRight: (() => {
          const top = document.querySelector('.head-top');
          const setBtn = document.querySelector('#btn-settings');
          if (!top || !setBtn) return false;
          const tr = top.getBoundingClientRect();
          const sr = setBtn.getBoundingClientRect();
          return tr.right - sr.right <= 30;
        })(),
        // 「待处理 N」和那句红/绿数字说明 2026-09-30 已从顶栏删掉
        goneTopIds: ['pending', 'pending-tip'].filter((id) => document.getElementById(id)),
        // 这三样 2026-09-30 搬进「全局设置」独立窗口了，主界面上不该再出现
        goneIds: ['btn-sim', 'btn-ai', 'btn-prompts', 'ai-modal', 'pr-modal', 'sim-panel']
          .filter((id) => document.getElementById(id)),
        logoInsideHeadTop: (() => {
          const wrap = document.querySelector('#brand-logos');
          const top = document.querySelector('.head-top');
          return !!(wrap && top && top.contains(wrap));
        })(),
        logoInAcctBar: document.querySelectorAll('#accounts .brand-logos').length,
      };
    });

    check('主界面（main）真实可见且有尺寸', !!m.main && m.main.w > 600 && m.main.h > 400, JSON.stringify(m.main));
    check('三栏都在：客户列表 / 对话 / 右侧档案建议', !!m.list?.h && !!m.chat?.h && !!m.panel?.h, JSON.stringify({ l: m.list, c: m.chat, p: m.panel }));
    check('没有任何全屏元素盖住主界面', m.covers.length === 0, m.covers.join('、'));

    console.log('\n=== 界面渲染 · 五个账号 + 红绿灯 ===');
    check('顶栏排出 5 个账号', m.accts === 5, `实际 ${m.accts}`);
    check('账号名本身就是按钮（点名字开浏览器，不再有单独的「浏览器」按钮）',
      m.openBtns === 5 && JSON.stringify(m.btnTexts) === JSON.stringify(['一号', '二号', '三号', '四号', '五号']),
      JSON.stringify(m.btnTexts));
    check('【不应】有"扫码"按钮（已删除）', m.qrBtns === 0, `实际 ${m.qrBtns}`);
    check('红绿灯按状态分别是 黄/绿/红/红/红', JSON.stringify(m.leds) === JSON.stringify(['led amber', 'led green', 'led red', 'led red', 'led red']), JSON.stringify(m.leds));
    check('五个账号排在一行（没折成两行）', m.accountRows === 1, `实际占 ${m.accountRows} 行`);
    check('顶栏不超过 100px（不挤掉主界面）', m.headerH <= 100, `实际 ${m.headerH}px`);

    /* ============================================================
     * 顶栏第一行最右端的社交平台官网 LOGO（2026-09-26 用户要求挪位）
     *   WhatsApp / Facebook / Instagram / TikTok / LinkedIn / Reddit / YouTube，
     *   每个 20px，从账号条（第二行）挪到第一行、紧跟「🧪 模拟新消息」右边。
     * ============================================================ */
    console.log('\n=== 界面渲染 · 顶栏第一行的社交平台 LOGO ===');
    check('第一行挂了 7 个官网 LOGO', m.logoCount === 7, `实际 ${m.logoCount}`);
    check('LOGO 顺序/名称正确（WhatsApp/FB/IG/TikTok/LinkedIn/Reddit/YouTube）',
      JSON.stringify(m.logoNames) === JSON.stringify(['WhatsApp', 'Facebook', 'Instagram', 'TikTok', 'LinkedIn', 'Reddit', 'YouTube']),
      JSON.stringify(m.logoNames));
    check('每个 LOGO 都是 20×20',
      m.logoSizes.length === 7 && m.logoSizes.every((s) => s === '20x20'), m.logoSizes.join(','));
    check('LOGO 在顶栏第一行（.head-top）里', m.logoInsideHeadTop === true, `inside=${m.logoInsideHeadTop}`);
    // 2026-09-30 用户要求：LOGO「依靠左侧」——紧跟品牌名，排在右下角那组按钮的左边
    check('LOGO 靠在左边：紧跟品牌名右边', m.logoRightOfBrand === true, `rightOfBrand=${m.logoRightOfBrand}`);
    check('LOGO 在「⚙ 设置」那组按钮左边、同一行', m.logoSameRowAsSetBtn === true, `leftOfSetBtn=${m.logoSameRowAsSetBtn}`);
    // 2026-09-30 用户要求：手动录入 / 话术编排台 / ⚙设置 这一组「依靠右侧」
    check('「手动录入 / 话术编排台 / ⚙设置」整体靠右（顶栏最右边就是 ⚙ 设置）',
      m.actionsHugRight === true, `hugRight=${m.actionsHugRight}`);
    check('顶栏【不再】有「待处理 N」和那句红/绿数字说明（用户要求删掉）',
      m.goneTopIds.length === 0, m.goneTopIds.join('、'));
    check('主界面上不再有「AI 提示词 / AI 设置 / 模拟新消息」三个按钮和它们的弹窗（全搬进「全局设置」窗口了）',
      m.goneIds.length === 0, m.goneIds.join('、'));
    check('账号条（第二行）里【不再】有 LOGO', m.logoInAcctBar === 0, `实际 ${m.logoInAcctBar}`);

    /* ============================================================
     * 账号圈数字 ① ② ③ ④ ⑤（2026-09-25 第二次纠偏）
     *   用户明确：数字挂在**每个客户行最左端、原来红点的位置**，
     *   不是放在中间的对话信息里面。
     *   红=有新消息；点开这一行 1 秒后转绿（看过、还没处理完）；处理完（回复/标记已回复）才消失。
     * ============================================================ */
    console.log('\n=== 界面渲染 · 客户行左端的账号圈数字（①②③④⑤）===');
    // 注意（2026-09-26 新规则）：左栏只渲染"有事要办"的客户，处理完的直接不进 DOM。
    //   所以这里三个客户里，只有前两个有 pending/unread 的会出现。
    const rowNums = await page.evaluate(() => {
      state.customers = [
        { code: '1A00001', name: '甲', account_id: 1, unread: 2, pending: 1 },
        { code: '2A00002', name: '乙', account_id: 2, unread: 1, pending: 1 },
        { code: '3A00003', name: '丙', account_id: 3, unread: 0, pending: 0 }, // 处理完了 → 不显示
      ];
      paintCustomers();
      const rows = [...document.querySelectorAll('#list-body .cust')];
      const row = (code) => rows.find((r) => r.dataset.code === code);
      const num = (code) => row(code)?.querySelector('.row-num');
      const name = row('1A00001')?.querySelector('.name');
      return {
        count: rows.length,
        a: num('1A00001')?.textContent.trim() || '',
        b: num('2A00002')?.textContent.trim() || '',
        ca: num('1A00001')?.className || '',
        cb: num('2A00002')?.className || '',
        noneC: !!row('3A00003'),
        // 数字在最左端：比客户名还靠左（= 原来红点的位置）
        leftOfName: !!(num('1A00001') && name) && num('1A00001').getBoundingClientRect().left <= name.getBoundingClientRect().left,
        inMsgs: document.querySelectorAll('#msgs .msg-num').length,
      };
    });
    check('左栏只显示"有事要办"的客户（处理完的那个不出现）', rowNums.count === 2, `实际 ${rowNums.count}`);
    check('有新消息的客户行显示账号圈数字 ① ②', rowNums.a === '①' && rowNums.b === '②', JSON.stringify(rowNums));
    check('数字默认是红色', /red/.test(rowNums.ca) && /red/.test(rowNums.cb), JSON.stringify(rowNums));
    check('数字挂在客户行最左端（原来红点的位置）', rowNums.leftOfName, JSON.stringify(rowNums));
    check('处理完的客户不出现在左栏（noneC=false 即那一格没了）', rowNums.noneC === false, JSON.stringify(rowNums));
    check('中间的对话信息里【不再】有数字', rowNums.inMsgs === 0, `还有 ${rowNums.inMsgs}`);

    // 点开这一行：1 秒内仍是红色 → 之后转绿并**留着**（绿=看过还没处理完）
    const flashStart = await page.evaluate(() => {
      state.customers = [{ code: '1A00001', name: '甲', account_id: 1, unread: 0, pending: 1 }];
      rowSeenAt['1A00001'] = Date.now() + 1000;   // 模拟"刚点开这一行"
      paintCustomers();
      return document.querySelector('#list-body .cust .row-num')?.className || '';
    });
    check('刚点开的一瞬间还是红色（1 秒后才转绿）', /red/.test(flashStart), flashStart);
    await new Promise((r) => setTimeout(r, 1200));
    const afterGreen = await page.evaluate(() => {
      delete rowSeenAt['1A00001'];   // openCustomerRow 里的 1 秒定时器就是干这个
      paintCustomers();
      return document.querySelector('#list-body .cust .row-num')?.className || '';
    });
    check('1 秒后转绿，而且不会自己消失', /green/.test(afterGreen), afterGreen);

    // 处理完（回复 / 标记已回复 → pending=0）→ **整格从左栏移除**（数字、圆点连同那一行一起没了）
    const doneGone = await page.evaluate(() => {
      state.customers = [{ code: '1A00001', name: '甲', account_id: 1, unread: 0, pending: 0 }];
      paintCustomers();
      return {
        cust: !!document.querySelector('#list-body .cust'),
        num: !!document.querySelector('#list-body .cust .row-num'),
        dot: !!document.querySelector('#list-body .cust .dot'),
      };
    });
    check('处理完 → 整格从左栏消失（不是留个小圆点占位）',
      !doneGone.cust && !doneGone.num && !doneGone.dot, JSON.stringify(doneGone));

    // 点客户行的动作必须真的接了这个时序（别只改渲染、忘了接线）
    const wiring = await page.evaluate(() => openCustomerRow.toString());
    check('点客户行的动作里带「1 秒后转绿」的时序', /rowSeenAt/.test(wiring) && /1100/.test(wiring), wiring.slice(0, 100));
    // 还原：重新拉一次真实列表，避免影响后面用例
    await page.evaluate(() => refreshCustomers());

    /* ============================================================
     * 左栏顶部「今日消息」提示窗（2026-09-30 用户配图精简）
     *   只保留 ① ② ③ ④ ⑤ 各来几条；「收到 / 已处理 / 待处理」三个数字格
     *   与「①主号 … ⑤五号」图例已按要求删除。
     * ============================================================ */
    console.log('\n=== 界面渲染 · 左栏「今日消息」提示窗 ===');
    const todayBox = await page.evaluate(() => {
      const box = document.querySelector('#today-box');
      const list = document.querySelector('#list');
      const body = document.querySelector('#list-body');
      renderToday({ date: '2026-09-25', received: 7, handled: 5, todo: 2, sent: 3, byAccount: { 1: 4, 3: 3 } });
      const t = (id) => document.querySelector(id)?.textContent.trim() || '';
      return {
        inList: !!(box && list && list.contains(box)),
        aboveList: !!(box && body) && box.getBoundingClientRect().top <= body.getBoundingClientRect().top,
        date: t('#tb-date'),
        acct: t('#tb-acct'),
        acctHas: [...document.querySelectorAll('#tb-acct .ta.has')].map((e) => e.textContent.trim()),
        hasIn: !!document.querySelector('#tb-in'),
        hasDone: !!document.querySelector('#tb-done'),
        hasTodo: !!document.querySelector('#tb-todo'),
        hasTip: !!document.querySelector('.tb-tip'),
        boxText: box?.textContent || '',
      };
    });
    check('「今日消息」窗口在最左侧栏目里（不是浮层）', todayBox.inList, JSON.stringify(todayBox));
    check('窗口在客户列表上方（列表滚动它不动）', todayBox.aboveList, JSON.stringify(todayBox));
    check('日期显示成 09-25', todayBox.date === '09-25', todayBox.date);
    check('按账号拆出 ① ② ③ ④ ⑤ 五个数字', /①4.*②0.*③3.*④0.*⑤0/.test(todayBox.acct.replace(/\s+/g, '')), todayBox.acct);
    check('今天有消息的账号标红（① 和 ③）', todayBox.acctHas.length === 2 && /①/.test(todayBox.acctHas[0]) && /③/.test(todayBox.acctHas[1]), JSON.stringify(todayBox.acctHas));
    check('【不再】有「收到 / 已处理 / 待处理」三个数字格（用户配图要求删）', !todayBox.hasIn && !todayBox.hasDone && !todayBox.hasTodo, JSON.stringify(todayBox));
    check('【不再】有「①主号 … ⑤五号」图例（用户配图要求删）', !todayBox.hasTip && !/主号/.test(todayBox.boxText), todayBox.boxText);

    // 数据来自后端接口（不是写死的）
    const todayApi = await fetch(`http://127.0.0.1:${PORT}/api/stats/today`).then((r) => r.json()).catch(() => null);
    check('后端 /api/stats/today 返回今天几个数（含 byAccount）',
      !!todayApi && typeof todayApi.received === 'number' && typeof todayApi.todo === 'number' && !!todayApi.byAccount,
      JSON.stringify(todayApi));

    /* ============================================================
     * 客户行最右端「档案」按钮 → 客户档案弹窗（2026-09-25 用户要求）
     *   档案从右栏搬成弹窗；按钮就放在编号 1A00001 那一行的右侧空白处
     * ============================================================ */
    console.log('\n=== 界面渲染 · 中栏头部「客户档案 / 从对话里提取档案」+ 档案弹窗 ===');
    await page.evaluate(() => {
      state.customers = [
        { code: '1A00001', name: '甲', account_id: 1, unread: 2, pending: 1 },
        // 故意用一个真实长度的名字（"诺亚 (演示)"）：左栏宽度不够时会被挤成「诺亚 (演…」，
        // 这条就是盯着"客户名有没有出现省略号"的。两个都给了 pending/unread，
        // 因为 2026-09-26 起左栏只渲染"有事要办"的客户（处理完的直接不显示）。
        { code: '2A00002', name: '诺亚 (演示)', account_id: 2, unread: 1, pending: 1 },
      ];
      state.activeCode = '2A00002';
      paintCustomers();
    });
    // 2026-09-25 第二轮：客户行里那两个按钮挪到中栏头部了 —— 左栏应该**一个按钮都没有**，
    // 整行点哪儿都是"打开这个客户"，行尾不再留空档。
    const rowShape = await page.evaluate(() => {
      const row = document.querySelector('#list-body .cust[data-code="1A00001"]');
      const names = [...document.querySelectorAll('#list-body .cust .name')];
      return {
        rowHasBtn: !!row?.querySelector('button, .doc-col, .row-doc, .row-extract'),
        rowBtnCount: document.querySelectorAll('#list-body button').length,
        childCount: row ? row.children.length : 0,
        nameCount: names.length,
        badNames: names.filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent),
      };
    });
    check('左栏客户行里不再有「客户档案 / 从对话里提取档案」按钮',
      !rowShape.rowHasBtn && rowShape.rowBtnCount === 0, JSON.stringify(rowShape));
    check('左栏客户行恢复成「圈数字 + 信息」两块（行尾不留空档）',
      rowShape.childCount === 2, JSON.stringify(rowShape));
    check('客户名没被挤成省略号', rowShape.nameCount === 2 && rowShape.badNames.length === 0, JSON.stringify(rowShape));

    // ② 左栏客户行排版：**编码在名称左边**，但「名称:」标签【不再】在左栏行里
    //    （按用户 2026-09-26 纠正：「名称:」应放在【中栏头部】客户名那一行，左栏只留「编码 + 客户名」两块）
    const nameRow = await page.evaluate(() => {
      const row = document.querySelector('#list-body .cust[data-code="1A00001"]');
      const code = row?.querySelector('.code');
      const label = row?.querySelector('.name-label');
      const name = row?.querySelector('.name');
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      return {
        hasCode: !!code,
        hasLabelInRow: !!label,        // 左栏不该再有「名称:」标签
        hasName: !!name,
        codeText: code?.textContent.trim() || '',
        codeLeftOfName: !!(r(code) && r(name)) && r(code).right <= r(name).left + 2,
      };
    });
    check('左栏客户行：编码排在名称左边',
      nameRow.hasCode && nameRow.hasName && nameRow.codeLeftOfName && /^[0-9A-Z]{5,}$/.test(nameRow.codeText),
      JSON.stringify(nameRow));
    check('左栏客户行【不再】带「名称:」标签（已按用户要求移到中栏头部）',
      !nameRow.hasLabelInRow, JSON.stringify(nameRow));

    // ②' 中栏头部客户名那一行：**编码 →「名称:」→ 客户名**，其中「名称:」= 红色 + 14px + 加粗 + 黑体字族
    //🔴 v2.6.1118：这一块连同下面的档案条一起改成了 .tv-card 单栏竖排（跟 Tele 档案卡同一套 class），
    //    所以选择器从 #chat-head .ch-name 改成 #chat-head .tv-head —— 元素结构变了，id 一个没动。
    const headName = await page.evaluate(() => {
      renderChatHead({ code: '1A00001', name: '甲', created_at: new Date().toISOString(), timezone: 'America/New_York', stage_day: 3, region: '纽约' }, {});
      const ch = document.querySelector('#chat-head .tv-head');
      const code = ch?.querySelector('.code');
      const label = ch?.querySelector('.name-label');
      const name = ch?.querySelector('.cname');
      const cs = label ? getComputedStyle(label) : null;
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      return {
        hasCode: !!code,
        hasLabel: !!label,
        hasName: !!name,
        labelText: label?.textContent.trim() || '',
        codeLeftOfLabel: !!(r(code) && r(label)) && r(code).right <= r(label).left + 2,
        labelLeftOfName: !!(r(label) && r(name)) && r(label).right <= r(name).left + 2,
        labelColor: cs ? cs.color : '',
        labelSize: cs ? cs.fontSize : '',
        labelWeight: cs ? Number(cs.fontWeight) || 0 : 0,
        labelFamily: cs ? cs.fontFamily : '',
      };
    });
    check('中栏头部：编码 →「名称:」→ 客户名 顺序正确',
      headName.hasCode && headName.hasLabel && headName.hasName
      && headName.codeLeftOfLabel && headName.labelLeftOfName && headName.labelText === '名称:',
      JSON.stringify(headName));
    check('中栏头部「名称:」是红色 + 13px + 加粗（跟 Tele 档案卡同一套 .tv-head 样式）',
      headName.labelColor === 'rgb(229, 72, 77)' && headName.labelSize === '13px' && headName.labelWeight >= 700,
      `${headName.labelColor} / ${headName.labelSize} / ${headName.labelWeight} / ${headName.labelFamily}`);

    // 档案卡里那三个按钮 + 逐行竖排的四项信息
    // 🔴 v2.6.1118：三个按钮从「中栏头部最右端横排」挪进档案卡底部（.tv-actions，Tele 同位）；
    //    档案条从 2×2 网格（.ch-facts）改成 .tv-ln 逐行竖排。断言整体按新结构重写。
    const headBtns = await page.evaluate(() => {
      renderChatHead(
        {
          code: '1A00001', name: '甲', created_at: new Date().toISOString(),
          timezone: 'America/New_York', stage_day: 3, mood: '有兴趣', region: '纽约',
        },
        {}
      );
      const doc = document.querySelector('#ch-doc');
      const ext = document.querySelector('#ch-extract');
      const jump = document.querySelector('#ch-jump');
      const card = document.querySelector('#chat-head .tv-card');
      const actions = document.querySelector('#chat-head .tv-actions');
      const head = document.querySelector('#chat-head');
      const nameEl = document.querySelector('#chat-head .tv-head .cname');
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const cR2 = r(card);
      const b = r(doc);
      const e2 = r(ext);
      const aR = r(actions);
      return {
        docText: doc?.textContent.trim() || '',
        extText: ext?.textContent.trim() || '',
        jumpText: jump?.textContent.trim() || '',
        tag: doc?.tagName || '',
        extTag: ext?.tagName || '',
        // 横排一行：客户档案在左、对话提档在右，两个按钮垂直中线基本对齐
        sideBySide: !!b && !!e2 && b.right <= e2.left + 2
          && Math.abs((b.top + b.bottom) / 2 - (e2.top + e2.bottom) / 2) <= 6,
        colColor: ext ? getComputedStyle(ext).color : '',
        colWeight: Number(ext ? getComputedStyle(ext).fontWeight : 0) || 0,
        // ① 两个按钮要做成**同款**：都有 1px 边框 + 浅蓝底
        extBorder: ext ? `${getComputedStyle(ext).borderTopWidth} ${getComputedStyle(ext).borderTopColor}` : '',
        extBg: ext ? getComputedStyle(ext).backgroundColor : '',
        docBorder: doc ? `${getComputedStyle(doc).borderTopWidth} ${getComputedStyle(doc).borderTopColor}` : '',
        docBg: doc ? getComputedStyle(doc).backgroundColor : '',
        nameColor: nameEl ? getComputedStyle(nameEl).color : '',
        nameWeight: Number(nameEl ? getComputedStyle(nameEl).fontWeight : 0) || 0,
        // 三个按钮都在档案卡里（v2.6.1118 的核心要求：跟 Tele 的 .tv-actions 同一个位置）
        inCard: !!(r(doc) && card) && r(doc).top >= r(card).top
          && !!(r(ext) && card) && r(ext).bottom <= r(card).bottom + 2
          && !!(jump && card) && r(jump).top >= r(card).top,
        // 按钮栏右对齐（跟 Tele 一致）
        // 按钮栏右对齐（跟 Tele 一致）。容差说明：按钮栏右沿落在**卡片**内，
        //   卡片比#chat-head 多了自身 padding(10px 12px) + 边框(1px) + #chat-head 的 padding(16px)，
        //   所以按 #chat-head 右沿量要放宽到 40px；改量卡片右沿更准，这里两个都验。
        actionsRight: !!(aR && head) && aR.right >= r(head).right - 44
          && !!(cR2) && aR.right >= cR2.right - 16,
        rightOfName: !!(b && nameEl) && b.left >= r(nameEl).right - 2,
        // 档案卡逐行竖排：加入时间 / 认识第N天 / 地区 / 客户当地时间
        lines: [...document.querySelectorAll('#chat-head .tv-ln')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
        stars: [...document.querySelectorAll('#chat-head .tv-star')].map((x) => x.textContent.trim()),
        starColor: document.querySelector('#chat-head .tv-star')
          ? getComputedStyle(document.querySelector('#chat-head .tv-star')).color : '',
        dayBadge: (() => {
          const el = document.querySelector('#chat-head .tv-fact-day');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { text: el.textContent.trim(), color: cs.color, size: cs.fontSize, weight: Number(cs.fontWeight) || 0 };
        })(),
        // 档案条末尾那个重复的「客户档案 ↗」应该已经没了
        dupGone: !document.querySelector('#ch-open-profile'),
        noDupText: !/客户档案 ↗/.test(head?.textContent || ''),
        factsAlive: !!card && /加入时间/.test(card.textContent || ''),
      };
    });
    check('档案卡里有「客户档案」+「对话提档」两个按钮',
      headBtns.docText === '客户档案' && headBtns.extText === '对话提档', JSON.stringify(headBtns));
    check('两个按钮都是真按钮（<button>），不是一行纯文字',
      headBtns.tag === 'BUTTON' && headBtns.extTag === 'BUTTON', JSON.stringify(headBtns));
    check('两个按钮**横排一行**（左「客户档案」、右「对话提档」）',
      headBtns.sideBySide, JSON.stringify(headBtns));
    check('「对话提档」是蓝色文字',
      headBtns.colColor === 'rgb(37, 99, 235)',
      `${headBtns.colColor} / ${headBtns.colWeight}`);
    check('「对话提档」做成和「客户档案」同款的按钮（1px 边框 + 浅蓝底，不是光秃秃的文字）',
      headBtns.extBorder === headBtns.docBorder && headBtns.extBg === headBtns.docBg
      && /^1px /.test(headBtns.extBorder) && headBtns.extBorder !== '1px rgba(0, 0, 0, 0)'
      && headBtns.extBg !== 'rgba(0, 0, 0, 0)',
      `ext=${headBtns.extBorder} / ${headBtns.extBg}　doc=${headBtns.docBorder} / ${headBtns.docBg}`);
    check('客户名加黑加粗（#000 + ≥800）',
      headBtns.nameColor === 'rgb(0, 0, 0)' && headBtns.nameWeight >= 800,
      `${headBtns.nameColor} / ${headBtns.nameWeight}`);
    // v2.6.1118：原来这条查的是「整栏贴中栏头部最右端 + 在档案条上方」，
    // 现在按钮搬进档案卡底部，改查「三个按钮都在卡内 + 按钮栏右对齐」。
    check('三个按钮都在档案卡内（跟 Tele 的 .tv-actions 同一位置）',
      headBtns.inCard && headBtns.jumpText === '↗ 跳到聊天', JSON.stringify(headBtns));
    check('按钮栏右对齐（贴着卡片右边缘）',
      headBtns.actionsRight, JSON.stringify(headBtns));
    check('按钮在客户名右边的空白处',
      headBtns.rightOfName, JSON.stringify(headBtns));
    check('档案卡逐行竖排：① 加入时间 ② 认识第 N 天 ③ 地区 ④ 客户当地时间',
      headBtns.lines.length >= 4
      && /加入时间/.test(headBtns.lines[0])
      && headBtns.lines.some((x) => /认识第 \d+ 天/.test(x))
      && headBtns.lines.some((x) => /地区/.test(x))
      && headBtns.lines.some((x) => /客户当地时间/.test(x)),
      JSON.stringify(headBtns.lines));
    check('「认识第 N 天」前后各一个黄色五角星，包着它',
      headBtns.stars.length === 2 && headBtns.stars.every((s) => s === '★')
      && headBtns.starColor === 'rgb(245, 179, 1)', `${headBtns.stars.join('')} ${headBtns.starColor}`);
    check('「认识第 N 天」右边有个紫色加粗的 Day 标记',
      !!headBtns.dayBadge && /^Day \d+$/.test(headBtns.dayBadge.text)
      && headBtns.dayBadge.color === 'rgb(124, 58, 237)'
      && headBtns.dayBadge.weight >= 700,
      JSON.stringify(headBtns.dayBadge));
    check('档案卡末尾那个重复的「客户档案 ↗」已经删掉',
      headBtns.dupGone && headBtns.noDupText && headBtns.factsAlive, JSON.stringify(headBtns));

    // ②'' 🔴 v2.6.1118 作废：原来查的是「档案条右列两条信息对齐 + 右列起点在绿框中点」
    //   （那是 2×2 网格 .ch-facts 时代的口径）。档案卡改成 .tv-ln 逐行竖排后没有"右列"了，
    //   换成查竖排本身：四项都在、同一左边界、行高一致、都不横向溢出卡片。
    const cardLayout = await page.evaluate(() => {
      renderChatHead({ code: '1A00001', name: '甲', created_at: new Date().toISOString(), timezone: 'America/New_York', region: '纽约' }, {});
      const card = document.querySelector('#chat-head .tv-card');
      const lines = [...document.querySelectorAll('#chat-head .tv-ln')];
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const cR = r(card);
      const cs = card ? getComputedStyle(card) : null;
      const padL = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
      const rects = lines.map((l) => r(l));
      const lefts = rects.filter(Boolean).map((x) => Math.round(x.left));
      return {
        count: lines.length,
        lefts,
        // 每一行都必须在卡片内容区内（不横向溢出）
        noOverflow: rects.filter(Boolean).every((x) => x.right <= cR.right + 1),
        // 逐行往下排（后一行 top 必须大于前一行 top）
        stacked: rects.length >= 2 && rects.every((x, i) => i === 0 || x.top > rects[i - 1].top),
        // 左边界全部一致（同一列起排，看着齐）
        sameLeft: lefts.length >= 2 && Math.abs(Math.max(...lefts) - Math.min(...lefts)) <= 1,
        padL,
      };
    });
    check('档案卡是逐行竖排（行往下堆、不横向溢出、左边界齐）',
      cardLayout.count >= 4 && cardLayout.stacked && cardLayout.noOverflow && cardLayout.sameLeft,
      JSON.stringify(cardLayout));

    // ②''' 「地区」永远都在：客户没抽到地区时也要显示「地区」这一项（用户 2026-09-26 要求）
    const noRegion = await page.evaluate(() => {
      renderChatHead({ code: '1A00001', name: '无地区', created_at: new Date().toISOString(), timezone: '', stage_day: 0, region: '' }, {});
      const card = document.querySelector('#chat-head .tv-card');
      const label = card.querySelector('b.tv-f-region');
      return {
        text: (card.textContent || '').replace(/\s+/g, ' ').trim(),
        hasLabel: !!label,
        labelColor: label ? getComputedStyle(label).color : '',
      };
    });
    check('客户没地区时「地区」这一项依然在（不整格消失）',
      noRegion.hasLabel && /地区/.test(noRegion.text) && /未填/.test(noRegion.text), JSON.stringify(noRegion));
    check('「地区」标题仍是紫色', noRegion.labelColor === 'rgb(124, 58, 237)', noRegion.labelColor);

    // ②'''' Day 徽标 = 「加入后第几天」，**纯按加入时间算**：
    //    加入当天 = Day 1（认识第 1 天），过了零点 +1（认识第 2 天 = Day 2）。
    //    用户 2026-09-26 点名：原来错显 Day 2；2026-09-29 再点名：Day 从 **1** 开始，不是 0。
    const dayMath = await page.evaluate(() => {
      const mk = (dayOffset) => {
        const d = new Date();
        d.setDate(d.getDate() - dayOffset);
        d.setHours(12, 0, 0, 0);
        return d.toISOString();
      };
      const read = (iso, stage) => {
        renderChatHead({ code: '1A00001', name: 'x', created_at: iso, timezone: 'America/New_York', stage_day: stage || 0, region: '纽约' }, {});
        const card = document.querySelector('#chat-head .tv-card');
        return {
          know: (card.querySelector('.tv-day-num')?.textContent || '').trim(),
          day: (card.querySelector('.tv-fact-day')?.textContent || '').trim(),
        };
      };
      return { today: read(mk(0)), yesterday: read(mk(1)), threeDays: read(mk(3)), stage2Today: read(mk(0), 2) };
    });
    check('今天加入：认识第 1 天 + Day 1（Day 从 1 开始）',
      dayMath.today.know === '第 1 天' && dayMath.today.day === 'Day 1', JSON.stringify(dayMath.today));
    check('昨天加入：认识第 2 天 + Day 2（过了零点就翻页）',
      dayMath.yesterday.know === '第 2 天' && dayMath.yesterday.day === 'Day 2', JSON.stringify(dayMath.yesterday));
    check('3 天前加入：认识第 4 天 + Day 4',
      dayMath.threeDays.know === '第 4 天' && dayMath.threeDays.day === 'Day 4', JSON.stringify(dayMath.threeDays));
    check('Day 只按加入时间算，不受 stage_day 影响（stage_day=2 但今天加入 → Day 1）',
      dayMath.stage2Today.day === 'Day 1', JSON.stringify(dayMath.stage2Today));

    // 点它：开档案弹窗，但【不要】把左边的对话也切过去
    await page.evaluate(() => {
      state.activeCode = '2A00002';
      document.querySelector('#ch-doc').click();
    });
    await new Promise((r) => setTimeout(r, 500));
    const pfOpen = await page.evaluate(() => {
      const m = document.querySelector('#pf-modal');
      const box = document.querySelector('#profile');
      // 再手动喂一份档案数据（库里这会儿还没有这个客户），确认弹窗能完整渲染出档案表
      renderProfile({
        customer: {
          code: '1A00001', name: '甲', created_at: new Date().toISOString(),
          region: '美国', timezone: 'America/New_York', stage_day: 3, phone: '+15419000099',
          // 2026-09-29：档案弹窗要显示「WA对话编号」（wa_jid）
          wa_jid: '243834688639050@lid',
          profile_json: JSON.stringify({ 婚姻情况: '未婚', 生活规律: '早睡早起', 宠物: '一只橘猫' }),
        },
        duplicates: [],
        docFile: 'E:\\WorkBuddy-Projects\\wa-assistant\\data\\customers\\1A00001_甲_+15419000099.md',
      });
      const save = document.querySelector('#pf-save');
      const prof = document.querySelector('#profile');
      const topbar = document.querySelector('.pf-topbar');
      return {
        open: !!m && !m.classList.contains('hidden'),
        title: document.querySelector('#pf-title')?.textContent.trim() || '',
        activeStill: state.activeCode,
        profileCode: state.profileCode,
        hasField: !!box?.querySelector('.pf, .field'),
        hasJoin: /加入时间/.test(box?.textContent || ''),
        hasGroup: /阶段|地区|电话/.test(box?.textContent || ''),
        hasSave: !!save,
        // 「保存档案」在弹窗最上面：在 .pf-topbar 里，且位置在 #profile 之上
        saveOnTop: !!(save && topbar && prof && topbar.contains(save)
          && topbar.getBoundingClientRect().top < prof.getBoundingClientRect().top),
        saveText: save?.textContent.trim() || '',
        // 「从对话里提取档案」已经搬到中栏头部，弹窗里不该再有它
        extractLeftModal: !m?.querySelector('#ch-extract, .row-extract, #btn-extract'),
        oldExtractGone: !document.querySelector('#btn-extract'),
        modalW: Math.round(m.getBoundingClientRect().width),
        // ③ 10 个附加字段：8 个单行 input + 2 个独占一行的 textarea（生活规律 / 家庭经济情况）
        extraIds: [...document.querySelectorAll('#profile [id^="pf-x-"]')].map((el) => el.id),
        extraInputs: [...document.querySelectorAll('#profile .field:not(.full) [id^="pf-x-"]')].map((el) => el.id),
        routine: (() => {
          const el = document.querySelector('#pf-x-routine');
          const box = document.querySelector('#profile');
          if (!el || !box) return null;
          return {
            tag: el.tagName,
            pct: el.getBoundingClientRect().width / box.getBoundingClientRect().width,
            val: el.value,
          };
        })(),
        family: (() => {
          const el = document.querySelector('#pf-x-family');
          const box = document.querySelector('#profile');
          if (!el || !box) return null;
          return { tag: el.tagName, pct: el.getBoundingClientRect().width / box.getBoundingClientRect().width };
        })(),
        // 2026-09-29 新增：只读「WA对话编号」+「文件路径」按钮 + 红字提醒
        waId: (() => {
          const el = document.querySelector('#pf-wa-id');
          if (!el) return null;
          return { val: el.value, ro: el.readOnly, labelOk: /WA对话编号/.test(box?.textContent || '') };
        })(),
        pathBtn: document.querySelector('#pf-path')?.textContent.trim() || '',
        tipRed: (() => {
          const el = document.querySelector('.pf-tip-red');
          if (!el) return null;
          return { text: el.textContent.trim(), color: getComputedStyle(el).color };
        })(),
      };
    });
    check('点头部「客户档案」→ 档案弹窗打开', pfOpen.open, JSON.stringify(pfOpen));
    check('弹窗标题带上客户名字', /1A00001|甲/.test(pfOpen.title), pfOpen.title);
    check('弹窗指向头部那个客户', pfOpen.profileCode === '1A00001', String(pfOpen.profileCode));
    check('弹窗里是完整档案（含加入时间 + 分组字段）',
      pfOpen.hasField && pfOpen.hasJoin && pfOpen.hasGroup, JSON.stringify(pfOpen));
    check('「保存档案」按钮在弹窗最上面（原来沉在最底下）',
      pfOpen.hasSave && pfOpen.saveOnTop && pfOpen.saveText === '保存档案', JSON.stringify(pfOpen));
    check('「从对话里提取档案」已搬出弹窗（弹窗里不再有）',
      pfOpen.extractLeftModal && pfOpen.oldExtractGone, JSON.stringify(pfOpen));
    check('点客户档案按钮【不会】顺带切换左边的对话', pfOpen.activeStill === '2A00002', String(pfOpen.activeStill));
    check('弹窗比原来的窄栏宽（612px 上限）', pfOpen.modalW >= 560, String(pfOpen.modalW));

    // ③ 弹窗里除了 6 个核心字段，还有 10 个附加字段
    check('档案弹窗：6 核心字段之外还有 10 个附加字段（婚姻/生活规律/别名/老家/爱好/职业/家庭经济/父母/宠物/孩子）',
      pfOpen.extraIds.length === 10
      && ['pf-x-marriage', 'pf-x-routine', 'pf-x-alias', 'pf-x-hometown', 'pf-x-hobby',
        'pf-x-occupation', 'pf-x-family', 'pf-x-parents', 'pf-x-pets', 'pf-x-children']
        .every((id) => pfOpen.extraIds.includes(id)),
      JSON.stringify(pfOpen.extraIds));
    check('「生活规律」单独一行填写（独占整行的 textarea，宽度≈整栏）',
      !!pfOpen.routine && pfOpen.routine.tag === 'TEXTAREA' && pfOpen.routine.pct >= 0.9,
      JSON.stringify(pfOpen.routine));
    check('「家庭经济情况」单独一行填写（独占整行的 textarea，宽度≈整栏）',
      !!pfOpen.family && pfOpen.family.tag === 'TEXTAREA' && pfOpen.family.pct >= 0.9,
      JSON.stringify(pfOpen.family));
    check('其余 8 个附加字段是普通单行输入框',
      pfOpen.extraInputs.length === 8, JSON.stringify(pfOpen.extraInputs));
    check('已有的附加字段值会回填进输入框（profile_json 读回来了）',
      pfOpen.routine.val === '早睡早起', JSON.stringify(pfOpen.routine));
    // ④ 弹窗标题只留「客户档案 · 名字」——长路径已收进「文件路径」按钮（2026-09-29 用户要求）
    check('④ 弹窗标题不再塞长路径（只留「客户档案 · 客户名」）',
      /客户档案 · 甲/.test(pfOpen.title) && !/\.md/.test(pfOpen.title)
      && !/[A-Za-z]:[\\/]/.test(pfOpen.title), pfOpen.title);
    check('④ 标题右边是「文件路径」按钮（点开才看路径）',
      pfOpen.pathBtn === '文件路径', pfOpen.pathBtn);
    check('④ 「保存档案」旁边是**红字**提醒：电话和姓名需要手动添加，没获取到就空着',
      !!pfOpen.tipRed && /电话和姓名需要手动添加/.test(pfOpen.tipRed.text)
      && pfOpen.tipRed.color === 'rgb(229, 72, 77)', JSON.stringify(pfOpen.tipRed));

    // 2026-09-30：档案弹窗「阶段(Day)」改为只读展示（不再手填），值形如 Day N（按加入时间自动同步主窗口）
    const stageRo = await page.evaluate(() => {
      const el = document.querySelector('#pf-stage');
      if (!el) return null;
      return { tag: el.tagName, text: el.textContent.trim(), ro: el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' };
    });
    check('档案弹窗「阶段(Day)」是只读展示（不是填框），值形如 Day N',
      !!stageRo && stageRo.ro && stageRo.tag === 'SPAN' && /^Day \d+$/.test(stageRo.text), JSON.stringify(stageRo));
    // 2026-09-30 用户又补了一句：这一格**只显示 Day + 数字**，底下那行解释小字不要
    const stageClean = await page.evaluate(() => {
      const f = document.querySelector('.pf-stagefield');
      return {
        subCount: f ? f.querySelectorAll('.joined-sub').length : -1,
        text: f ? f.textContent.trim() : '',
      };
    });
    check('「阶段(Day)」那格只剩 Day + 数字，没有多余的说明文字',
      stageClean.subCount === 0 && /^阶段（Day）?\s*Day \d+$/.test(stageClean.text.replace(/\s+/g, ' ')),
      JSON.stringify(stageClean));

    // 2026-09-30 用户要求：档案弹窗「时区」改成填数字的小框（填与北京的小时差，60px 宽），
    // 右边一个「填写说明」按钮，点开把时差怎么算讲清楚。
    const tzField = await page.evaluate(() => {
      const el = document.querySelector('#pf-tz');
      const btn = document.querySelector('#pf-tz-help');
      const pop = document.querySelector('#pf-tz-pop');
      const hint = document.querySelector('#pf-tz-hint');
      const row = document.querySelector('#pf-tz-row, .pf-tz-row');
      return {
        tag: el?.tagName || '',
        type: el?.getAttribute('type') || '',
        cls: el?.className || '',
        w: el ? Math.round(el.getBoundingClientRect().width) : 0,
        val: el?.value ?? null,
        btnText: btn?.textContent.trim() || '',
        popHidden: pop ? pop.classList.contains('hidden') : null,
        popDisplay: pop ? getComputedStyle(pop).display : '',
        hint: hint?.textContent.trim() || '',
        rowFlex: row ? getComputedStyle(row).display : '',
      };
    });
    check('档案弹窗「时区」是数字输入框（type=number）',
      tzField.tag === 'INPUT' && tzField.type === 'number', JSON.stringify(tzField));
    check('「时区」框只要 60px 宽（用户要求）',
      tzField.w >= 56 && tzField.w <= 66, String(tzField.w));
    check('「时区」框右边是「填写说明」按钮',
      tzField.btnText === '填写说明', tzField.btnText);
    check('存的还是 IANA 时区名（老数据）→ 数字框留空，表示"按地区自动"',
      tzField.val === '', JSON.stringify(tzField.val));
    check('「时区」框下面说明当前按什么算（留空 = 按地区自动）',
      /留空/.test(tzField.hint) && /地区/.test(tzField.hint), tzField.hint);
    check('「填写说明」弹层默认收起',
      tzField.popHidden === true && tzField.popDisplay === 'none', JSON.stringify(tzField));
    check('「时区」那一行是横排（框 + 按钮）', tzField.rowFlex === 'flex', tzField.rowFlex);

    // 点「填写说明」→ 弹出说明，里面必须写清"比北京晚填负数、快填正数、留空按地区自动"
    const tzPop = await page.evaluate(() => {
      const btn = document.querySelector('#pf-tz-help');
      const pop = document.querySelector('#pf-tz-pop');
      if (!btn || !pop) return null;
      btn.click();
      return { hidden: pop.classList.contains('hidden'), text: pop.textContent.replace(/\s+/g, ' ').trim() };
    });
    check('点「填写说明」→ 时差说明弹出来',
      !!tzPop && tzPop.hidden === false, JSON.stringify(tzPop));
    // 留一张图给用户看（界面改动习惯直接看图）：时区小框 + 填写说明
    await page.screenshot({ path: path.join(ROOT, 'preview', '客户档案弹窗_时区填写说明.png') });
    check('说明里写明：比北京时间晚填负数（波士顿 -12）、快填正数（东京 +1）',
      /填负数/.test(tzPop?.text || '') && /-12/.test(tzPop?.text || '')
      && /填正数/.test(tzPop?.text || '') && /\+1/.test(tzPop?.text || ''),
      (tzPop?.text || '').slice(0, 200));
    check('说明里写明：留空 = 按「地区」自动算，并且报出当前算出来的时差',
      /留空/.test(tzPop?.text || '') && /按.*地区.*自动/.test(tzPop?.text || '')
      && /比北京(早|晚)|同时区/.test(tzPop?.text || ''),
      (tzPop?.text || '').slice(0, 300));

    // 在框里填数字 → 下面那行小字立刻变成"已手填：比北京晚 12 小时"（可见反馈）
    const tzTyped = await page.evaluate(() => {
      const el = document.querySelector('#pf-tz');
      if (!el) return null;
      el.value = '-12';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const hint = document.querySelector('#pf-tz-hint');
      return { val: el.value, hint: hint?.textContent.trim() || '' };
    });
    check('填了数字 → 说明行立刻改口"已手填"（比北京晚 12 小时）',
      tzTyped?.val === '-12' && /已手填/.test(tzTyped?.hint || '')
      && /比北京晚 12 小时/.test(tzTyped?.hint || ''), JSON.stringify(tzTyped));
    await page.evaluate(() => {
      const el = document.querySelector('#pf-tz');
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
      document.querySelector('#pf-tz-pop')?.classList.add('hidden');
    });

    // 2026-09-29：客户那串"抓到的长数字"= WhatsApp 内部唯一编号 → 只读显示在「WA对话编号」里
    check('档案弹窗有只读的「WA对话编号」，显示 wa_jid（不是塞进电话号码）',
      !!pfOpen.waId && pfOpen.waId.ro === true && pfOpen.waId.val === '243834688639050@lid'
      && pfOpen.waId.labelOk, JSON.stringify(pfOpen.waId));

    // 点「文件路径」→ 弹出的层里是完整路径（可复制）
    // 先留一张"弹出层收起"的截图：红字提示 + 按钮都在（用户看界面改动习惯直接看图）
    await page.screenshot({ path: path.join(ROOT, 'preview', '客户档案弹窗_红字提示.png') });
    const pathPop = await page.evaluate(async () => {
      const btn = document.querySelector('#pf-path');
      const pop = document.querySelector('#pf-path-pop');
      if (!btn || !pop) return null;
      btn.click();
      await new Promise((r) => setTimeout(r, 120));
      return {
        opened: !pop.classList.contains('hidden'),
        txt: pop.textContent || '',
        copyBtn: !!pop.querySelector('#pf-path-copy'),
      };
    });
    check('④ 点「文件路径」→ 弹出完整路径（含 data\\customers 与 .md）',
      !!pathPop && pathPop.opened && /\.md/.test(pathPop.txt) && /data[\\/]customers/.test(pathPop.txt),
      JSON.stringify(pathPop && pathPop.txt));
    check('④ 弹出的路径能一键复制（有复制按钮）', !!pathPop && pathPop.copyBtn);
    // 再留一张"弹层开着"的截图（证明路径确实躺在按钮后面，不占标题位置）
    await page.screenshot({ path: path.join(ROOT, 'preview', '客户档案弹窗_路径按钮.png') });
    const pathClosed = await page.evaluate(async () => {
      const pop = document.querySelector('#pf-path-pop');
      document.body.click();
      await new Promise((r) => setTimeout(r, 150));
      return pop.classList.contains('hidden');
    });
    check('④ 点别处弹出层自动收起', pathClosed === true, String(pathClosed));

    // 关掉：弹窗隐藏
    const pfClosed = await page.evaluate(() => {
      document.querySelector('#pf-close').click();
      return document.querySelector('#pf-modal').classList.contains('hidden');
    });
    check('点 × 能关掉档案弹窗', pfClosed);

    // 中栏头部下面那个「从对话里提取档案」：点了要有即时反馈，而且【不切换】你正在看的那段对话。
    // 接口用桩，别真去调 AI。
    const extClick = await page.evaluate(async () => {
      const saved = api;
      api = async (url) => {
        if (url === '/api/customers') return state.customers || [];
        if (url === '/api/customer/1A00001') return { customer: { code: '1A00001', name: '甲' }, messages: [] };
        return { ok: true };
      };
      state.activeCode = '2A00002';
      const btn = document.querySelector('#ch-extract');
      const before = btn ? btn.textContent.trim() : '';
      if (btn) btn.click();
      const during = btn ? btn.textContent.trim() : '';
      await new Promise((r) => setTimeout(r, 400));
      api = saved;
      return {
        before,
        during,
        activeAfter: state.activeCode,
        backToNormal: document.querySelector('#ch-extract')?.textContent.trim() || '',
      };
    });
    check('点「对话提档」立刻有反馈（按钮变「正在读对话…」）',
      extClick.before === '对话提档' && extClick.during === '正在读对话…', JSON.stringify(extClick));
    check('抽档案【不切换】左边正在看的对话，抽完按钮自己恢复',
      extClick.activeAfter === '2A00002' && extClick.backToNormal === '对话提档', JSON.stringify(extClick));

    // 右栏不该再有常驻的「客户档案」卡片了（已改成弹窗）
    const panelCards = await page.evaluate(() => ({
      cards: [...document.querySelectorAll('#panel .card h4')].map((h) => h.textContent.trim()),
      profileInPanel: !!document.querySelector('#panel #profile'),
    }));
    check('右栏不再常驻「客户档案」卡片（只剩中文回复建议）',
      !panelCards.cards.includes('客户档案') && !panelCards.profileInPanel, JSON.stringify(panelCards));

    await page.evaluate(() => refreshCustomers());

    console.log('\n=== 界面渲染 · 顶栏「⚙ 设置」按钮 + 提示条单行且在客户档案上方 ===');
    const t = await page.evaluate(() => {
      const setBtn = document.querySelector('#btn-settings');
      const statusBtn = document.querySelector('#status');
      const toast = document.querySelector('#toast');
      const panel = document.querySelector('#panel');
      const header = document.querySelector('header');
      const cs = toast ? getComputedStyle(toast) : null;
      const tr = toast ? toast.getBoundingClientRect() : null;
      const pr = panel ? panel.getBoundingClientRect() : null;
      const toastSingle = cs
        ? cs.whiteSpace === 'nowrap' && (cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden')
        : false;
      const inHeader = toast && header ? header.contains(toast) : false;
      const abovePanel = tr && pr ? tr.top < pr.top : false;
      // AI 状态灯（2026-09-26 改成一个小圆点：无文字、无边框、不可点）
      const stc = statusBtn ? getComputedStyle(statusBtn) : null;
      return {
        hasSetBtn: !!setBtn,
        hasStatus: !!statusBtn,
        statusTag: statusBtn ? statusBtn.tagName : '',
        statusText: statusBtn ? statusBtn.textContent.trim() : '',
        statusColor: stc ? stc.color : '',
        statusBorderW: stc ? parseFloat(stc.borderTopWidth) : -1,
        statusBg: stc ? stc.backgroundColor : '',
        statusCursor: stc ? stc.cursor : '',
        toastSingle,
        inHeader,
        abovePanel,
        toastTop: tr ? Math.round(tr.top) : null,
        panelTop: pr ? Math.round(pr.top) : null,
      };
    });
    check('顶栏有「⚙ 设置」按钮（AI 设置 / AI 提示词 / 模拟新消息 的入口）', t.hasSetBtn, JSON.stringify(t));
    check('顶栏有 AI 状态灯', t.hasStatus, JSON.stringify(t));
    check('状态灯不是一个按钮：无边框、无背景',
      t.statusTag === 'SPAN' && t.statusBorderW === 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(t.statusBg),
      `tag=${t.statusTag} border=${t.statusBorderW} bg=${t.statusBg}`);
    check('状态灯只是一个实心圆点「●」，且不可点（cursor:default）',
      t.statusText === '●' && t.statusCursor === 'default', `text="${t.statusText}" cursor=${t.statusCursor}`);
    check('状态灯有颜色（绿=已连上 / 红=没连上）', /^rgb\(/.test(t.statusColor), t.statusColor);
    check('提示条是单行（nowrap + 省略号/裁剪，不堆叠多条）', t.toastSingle, JSON.stringify(t));
    check('提示条在顶栏内', t.inHeader, JSON.stringify(t));
    check('提示条落在「客户档案」右栏的上方', t.abovePanel, `toastTop=${t.toastTop} panelTop=${t.panelTop}`);

    /* ============================================================
     * 新消息累计 + 等待翻译中（按用户最新两张截图改的行为）
     *   1) 同一个客户连发多条 → 左栏只占一格，未读数累计
     *   2) 点开这一格 → 未读清零
     *   3) 右栏顶部提醒「等待翻译中」，英文那条气泡里也标着
     *   4) 客户发的中文不翻译、也不标"等待翻译中"
     * ============================================================ */
    console.log('\n=== 界面渲染 · 新消息累计 + 等待翻译中 ===');
    const { customer: seedC } = db.getOrCreateCustomer(1, '19990001111@c.us', { name: '待翻译测试' });
    // 给个时区，才能验证「客户当地时间」真的算出来了（真实客户都会有：地区填了自动带出来）
    db.db.prepare('UPDATE customers SET timezone=?, region=? WHERE code=?')
      .run('America/Los_Angeles', '纽约', seedC.code);
    db.saveMessage({ customerCode: seedC.code, accountId: 1, direction: 'in', body: 'hi, is this still available?', waMsgId: 'ui-en-1' });
    db.saveMessage({ customerCode: seedC.code, accountId: 1, direction: 'in', body: '你好，我想问一下价格', waMsgId: 'ui-zh-1' });

    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1200));

    const before = await page.evaluate((code) => {
      const rows = [...document.querySelectorAll('#list .cust')];
      const mine = rows.filter((r) => r.dataset.code === code);
      return {
        boxes: mine.length,
        badge: (mine[0]?.querySelector('.unread')?.textContent || '').trim(),
        first: rows[0]?.dataset.code || '',
      };
    }, seedC.code);
    check('同一个客户只占一格（多条新消息累计，不铺成多个格子）', before.boxes === 1, JSON.stringify(before));
    check('未读数累计成 2（没点开就一直累加）', before.badge === '2', JSON.stringify(before));
    check('有未读的客户排到左栏最上面', before.first === seedC.code, JSON.stringify(before));

    await page.evaluate((code) => document.querySelector(`#list .cust[data-code="${code}"]`).click(), seedC.code);
    await new Promise((r) => setTimeout(r, 900));

    const after = await page.evaluate((code) => {
      const row = document.querySelector(`#list .cust[data-code="${code}"]`);
      const bubbles = [...document.querySelectorAll('#msgs .bubble')];
      const en = bubbles.find((b) => (b.querySelector('.body')?.textContent || '').includes('still available'));
      const zhMsg = bubbles.find((b) => (b.querySelector('.body')?.textContent || '').includes('我想问一下价格'));
      const strip = document.querySelector('#chat-status');
      return {
        badgeGone: !row || !row.querySelector('.unread'),
        statusText: (strip?.textContent || '').trim(),
        statusVisible: !!strip && !strip.classList.contains('hidden'),
        stripAboveMsgs: !!strip && !!document.querySelector('#msgs') &&
          strip.getBoundingClientRect().bottom <= document.querySelector('#msgs').getBoundingClientRect().top + 2,
        enWaiting: !!en && !!en.querySelector('.zh.waiting'),
        zhWaiting: !!zhMsg && !!zhMsg.querySelector('.zh'),
      };
    }, seedC.code);
    check('点开后未读清零', after.badgeGone, JSON.stringify(after));
    check('右栏顶部提醒「等待翻译中…」', after.statusVisible && after.statusText.includes('等待翻译中'), JSON.stringify(after));
    check('这条提醒在客户名下方、消息区上方（截图箭头指的位置）', after.stripAboveMsgs, JSON.stringify(after));
    check('英文那一条气泡里标着「等待翻译中」', after.enWaiting, JSON.stringify(after));
    check('客户发的中文【不】翻译、也不标等待', !after.zhWaiting, JSON.stringify(after));

    /* ============================================================
     * 中栏档案条 + 生成建议按钮位置（用户 2026-09-25 第二张截图的要求）
     *   1) 右栏「客户档案」里最该随时看见的几项抬到中栏客户名下面：14px 加粗黑体，固定两行
     *   2) 必须含【加入时间】和【客户当地时间】（当地时间真的算出来了）
     *   3) 「生成建议」按钮挪到中栏底部（不再在右栏卡片里）
     * ============================================================ */
    console.log('\n=== 界面渲染 · 中栏档案条 + 生成建议按钮 ===');
    const head = await page.evaluate(() => {
      const facts = document.querySelector('#chat-head .tv-card');
      // 🔴 v2.6.1118：字号/字重要在 .tv-ln 上量（.tv-card 容器本身不设这两项，
      //   字体是 .tv-head / .tv-ln 各自带的 —— 跟 Tele 那边完全一致）
      const ln = document.querySelector('#chat-head .tv-card .tv-ln');
      const cs = ln ? getComputedStyle(ln) : (facts ? getComputedStyle(facts) : null);
      const loc = document.querySelector('#ch-loc');
      const btn = document.querySelector('#btn-suggest');
      const chat = document.querySelector('#chat');
      const msgs = document.querySelector('#msgs');
      const panel = document.querySelector('#panel');
      const foot = document.querySelector('#chat-foot');
      return {
        hasFacts: !!facts,
        factsText: (facts?.textContent || '').replace(/\s+/g, ' ').trim(),
        fontSize: cs?.fontSize || '',
        fontWeight: Number(cs?.fontWeight) || 0,
        hasJoined: /加入时间/.test(facts?.textContent || ''),
        hasLocal: /客户当地时间/.test(facts?.textContent || ''),
        loc: (loc?.textContent || '').trim(),
        // 三个标题的颜色（用户要求：加入时间=红、客户当地时间=绿、地区=紫）
        colJoined: getComputedStyle(facts.querySelector('b.tv-f-joined')).color,
        colLoc: getComputedStyle(facts.querySelector('b.tv-f-loc')).color,
        colRegion: getComputedStyle(facts.querySelector('b.tv-f-region')).color,
        hasRegionLabel: !!facts.querySelector('b.tv-f-region'),
        btnInChat: !!(btn && chat && chat.contains(btn)),
        btnBelowMsgs: !!(btn && msgs) && btn.getBoundingClientRect().top >= msgs.getBoundingClientRect().top,
        footAtBottom: !!(foot && chat) && Math.abs(foot.getBoundingClientRect().bottom - chat.getBoundingClientRect().bottom) < 3,
        btnInPanel: !!(btn && panel && panel.contains(btn)),
      };
    });
    check('中栏客户名下方有档案卡', head.hasFacts, JSON.stringify(head));
    // 🔴 v2.6.1118：原断言是「14px 加粗黑体」（.ch-facts 2×2 网格时代的口径）。
    //   老板 2026-10-14 20:29 要求改成跟 Tele 档案卡一栏 → 字号跟着 Tele 走（13px 加粗）。
    //   这正是「弄成一栏」的预期结果：两边 .tv-ln 同一条 CSS，永远一致。
    check('档案卡是 13px 加粗（跟 Tele 档案卡同一套 .tv-ln 样式）',
      head.fontSize === '13px' && head.fontWeight >= 700,
      `fontSize=${head.fontSize} fontWeight=${head.fontWeight}`);
    check('档案条里有「加入时间」', head.hasJoined, head.factsText.slice(0, 120));
    check('档案条里有「客户当地时间」', head.hasLocal, head.factsText.slice(0, 120));
    check('客户当地时间真的算出来了（形如 09-25 03:12）', /^\d{2}-\d{2} \d{2}:\d{2}$/.test(head.loc), head.loc);
    // 三个标题的颜色（rgb 写法，注释里标出对应的颜色名）
    check('标题「加入时间」是红色', head.colJoined === 'rgb(229, 72, 77)', head.colJoined);
    check('标题「客户当地时间」是绿色', head.colLoc === 'rgb(48, 164, 108)', head.colLoc);
    check('标题「地区」是紫色', head.hasRegionLabel && head.colRegion === 'rgb(124, 58, 237)', head.colRegion);
    check('「⚡ 生成建议」按钮在中栏', head.btnInChat, JSON.stringify(head));
    check('它在中栏底部（消息区下方、贴着底边）', head.btnBelowMsgs && head.footAtBottom, JSON.stringify(head));
    check('右栏卡片里【不再】有这个按钮', !head.btnInPanel);

    // 2026-09-30：档案里填了「与北京的小时差」（数字）时，中栏「客户当地时间/时差」按它算
    const handTzHead = await page.evaluate(() => {
      const iso = new Date().toISOString();
      // -12 = 比北京晚 12 小时（用户举的例子：美国波士顿）
      renderChatHead({ code: '9A00009', name: '手填时差', created_at: iso, region: 'Boston', timezone: '-12' }, {});
      const loc = (document.querySelector('#ch-loc')?.textContent || '').trim();
      const facts = document.querySelector('#chat-head .tv-card');
      // 手填数字时，地区推出来的时区（autoTimezone）也要能兜底显示
      renderChatHead({ code: '9A00010', name: '留空自动', created_at: iso, region: 'Boston', timezone: '' }, { autoTimezone: 'America/New_York' });
      const locAuto = (document.querySelector('#ch-loc')?.textContent || '').trim();
      const autoText = (document.querySelector('#chat-head .tv-card')?.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        loc,
        handText: (facts?.textContent || '').replace(/\s+/g, ' ').trim(),
        locAuto,
        autoText,
      };
    });
    check('档案里手填了「-12」→ 中栏时差按手填的算（比北京晚 12 小时）',
      /比北京晚 12 小时/.test(handTzHead.handText), handTzHead.handText.slice(0, 140));
    check('手填时差时，客户当地时间照样算得出来（不是空）',
      /^\d{2}-\d{2} \d{2}:\d{2}$/.test(handTzHead.loc), handTzHead.loc);
    check('时区栏留空 → 中栏按「地区」推出来的时区算（波士顿 = 纽约时间）',
      /比北京晚 1[23] 小时/.test(handTzHead.autoText)
      && /^\d{2}-\d{2} \d{2}:\d{2}$/.test(handTzHead.locAuto), handTzHead.autoText.slice(0, 140));

    /* ============================================================
     * 顶栏「待处理」+ 一句说明 + 「标记已回复」的位置（2026-09-25 用户要求）
     *   注意：红/绿数字现在在**左栏客户行**（前面那一节），不在对话信息里。
     * ============================================================ */
    console.log('\n=== 界面渲染 · 待处理说明 + 按钮位置 ===');
    const noNums = await page.evaluate(() => {
      const ts = new Date().toISOString();
      renderMessages([
        { id: 901, direction: 'in', body: 'hello there', msg_ts: ts, processed: 0 },
        { id: 902, direction: 'in', body: 'second one', msg_ts: ts, processed: 0 },
        { id: 903, direction: 'out', body: 'my reply', msg_ts: ts, processed: 0 },
        { id: 904, direction: 'in', body: 'old handled', msg_ts: ts, processed: 1 },
      ]);
      return {
        nums: document.querySelectorAll('#msgs .msg-num').length,
        bubbles: document.querySelectorAll('#msgs .bubble').length,
      };
    });
    check('对话里的气泡正常画出来了', noNums.bubbles === 4, `实际 ${noNums.bubbles}`);
    check('对话信息里没有红/绿数字（数字只放左栏客户行）', noNums.nums === 0, `还有 ${noNums.nums}`);

    const lay = await page.evaluate(() => {
      const sug = document.querySelector('#btn-suggest');
      const rep = document.querySelector('#btn-replied');
      return {
        // 「待处理 N」和它右边那句说明 2026-09-30 已按要求从顶栏删除
        hasPendingChip: !!document.querySelector('#pending'),
        hasPendingTip: !!document.querySelector('#pending-tip'),
        repInFoot: !!(rep && document.querySelector('#chat-foot')?.contains(rep)),
        repNextToSug: !!(rep && sug) && Math.abs(rep.getBoundingClientRect().left - sug.getBoundingClientRect().right) < 40,
        repNotInPanel: !!rep && !document.querySelector('#panel')?.contains(rep),
      };
    });
    check('顶栏里的「待处理」胶囊已删掉', lay.hasPendingChip === false, JSON.stringify(lay));
    check('顶栏里那句红/绿数字说明已删掉', lay.hasPendingTip === false, JSON.stringify(lay));
    check('「标记已回复」挪到了中栏底部', lay.repInFoot && lay.repNotInPanel, JSON.stringify(lay));
    check('它紧挨着「生成建议」', lay.repNextToSug, JSON.stringify(lay));

    // 真实客户再走一遍「客户档案」入口：这次字段是服务端给的（不是上面喂的假数据）。
    // 入口已经挪到中栏头部右端，所以先把那个客户打开（头部才会渲染他），再点那儿的按钮。
    const pfReal = await page.evaluate(async (code) => {
      await refreshCustomers();
      await openCustomer(code);
      const btn = document.querySelector('#ch-doc');
      if (!btn) return { has: false };
      btn.click();
      await new Promise((r) => setTimeout(r, 1200));
      const box = document.querySelector('#profile');
      const m = document.querySelector('#pf-modal');
      const r = { has: true, open: !!m && !m.classList.contains('hidden'), fields: box?.querySelectorAll('.field').length || 0, hasName: /姓名/.test(box?.textContent || '') };
      closeProfileModal();
      return r;
    }, seedC.code);
    check('真实客户的「客户档案」按钮同样能开弹窗，字段来自服务端', pfReal.has && pfReal.open && pfReal.fields >= 6 && pfReal.hasName, JSON.stringify(pfReal));

    /* ============================================================
     * 图片/语音：客户发来的图，AI 看完要给中文说明（⑤ 看图 / ⑥ 听语音）
     * ============================================================ */
    console.log('\n=== 界面渲染 · 客户发来的图片 ===');
    db.saveMessage({
      customerCode: seedC.code, accountId: 1, direction: 'in',
      body: '[图片/附件]', mediaPath: path.join(DIR, 'x_no_such_photo.jpg'), waMsgId: 'ui-img-1',
    });
    await page.evaluate((code) => document.querySelector(`#list .cust[data-code="${code}"]`)?.click() || openCustomer(code), seedC.code);
    await new Promise((r) => setTimeout(r, 900));
    const img = await page.evaluate(() => {
      // 🔴 2026-10-08 老板要求：纯占位的「[图片/附件]」不再在 .body 里重复显示，
      // 改为直接渲染缩略图（.media）。所以按 .media 找这条气泡，
      // 旧的「[图片/附件]」正文匹配作为兜底保留。
      const b = [...document.querySelectorAll('#msgs .bubble')]
        .find((x) => x.querySelector('.media')
          || (x.querySelector('.body')?.textContent || '').includes('[图片/附件]'));
      const strip = document.querySelector('#chat-status');
      return {
        has: !!b,
        waiting: !!b?.querySelector('.zh.waiting'),
        text: (b?.querySelector('.zh')?.textContent || '').trim(),
        strip: (strip?.textContent || '').trim(),
      };
    });
    check('图片那条气泡里标了「正在看图…」（或已经出中文说明）', img.has && (img.waiting || /图：/.test(img.text)), JSON.stringify(img));
    check('顶部状态把"看图"也算进等待里', /看图|听语音|等待翻译中/.test(img.strip), img.strip);

    /* ============================================================
     * AI 设置弹窗：7 个 AI + 12 个服务商 + 1 个「气泡翻译模型」设置卡（共 11 个区块）+ 申请地址（第 2 点需求）
     * ============================================================ */
    console.log('\n=== 界面渲染 · AI 设置（在「全局设置」独立窗口里） ===');
    // 2026-09-30 用户要求：AI 设置 / AI 提示词 / 模拟新消息 三块搬进独立窗口「全局设置」，
    // 主窗口只留一个「⚙ 设置」图标。所以这一段另开一页去量那扇窗，主页面（page）保持不动。
    const setPageA = await browser.newPage();
    await setPageA.goto(`http://127.0.0.1:${PORT}/settings.html`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1000));
    const aiBox = await setPageA.evaluate(() => {
      const body = document.querySelector('#ai-body');
      const tasks = [...document.querySelectorAll('#ai-body .ai-task')];
      // 排除「通用设置」（.ai-general）和「抽客户档案用哪个 AI」下拉（.ai-extract-pick）；
      // 后者是这次为修「抽档案选 hy3/Agnes 不生效」新加的专section，不算 7 个服务商之一
      const secs = [...document.querySelectorAll('#ai-body .ai-sec:not(.ai-general):not(.ai-extract-pick)')];
      const applies = [...document.querySelectorAll('#ai-body .ai-apply a')];
      const fixed = [...document.querySelectorAll('#ai-body .fixed-model')].map((x) => x.textContent.trim());
      const sec = document.querySelector('#sec-ai');
      return {
        visible: !!sec && !sec.classList.contains('hidden'),
        taskCount: tasks.length,
        taskNames: tasks.map((t) => t.querySelector('.ai-task-cn')?.textContent.trim() || ''),
        picks: document.querySelectorAll('#ai-body select.ai-task-pick').length,
        // 每个「用哪家」下拉里能选到的服务商（2026-10-09 加：守「下拉漏列 TikHub」这个坑）
        pickOpts: [...document.querySelectorAll('#ai-body select.ai-task-pick')]
          .map((s) => [...s.options].map((o) => o.value)),
        // 「抽客户档案用哪个 AI」那个专属下拉
        extractOpts: [...(document.querySelector('#ai-extract-ai')?.options || [])].map((o) => o.value),
        secCount: secs.length,
        secNames: secs.map((s) => s.querySelector('.ai-sec-head')?.textContent.replace(/\s+/g, ' ').trim() || ''),
        applyCount: applies.length,
        applyUrls: applies.map((a) => a.getAttribute('href')),
        fixed,
        hasSave: !!document.querySelector('#ai-save'),
      };
    });
    check('AI 设置页签能打开（窗口里的第一个页签）', aiBox.visible, JSON.stringify(aiBox).slice(0, 200));
    check('弹窗里列出 5 个 AI', aiBox.taskCount === 5, `实际 ${aiBox.taskCount}：${aiBox.taskNames.join('、')}`);
    check('5 个 AI 里给「用哪家」下拉的是 4 个（只有 ① 接收信息不用配）',
      aiBox.picks === 4, `实际 ${aiBox.picks} 个下拉`);
    // 2026-10-09 用户报的 bug：手动自由翻译那行的下拉里看不到 TikHub（每任务自己的 providerChoices 漏了它）。
    // 守死：凡是「用哪家」下拉，都必须能选到 TikHub。
    const noTik = aiBox.pickOpts
      .map((o, i) => (o.includes('tikhub') ? null : i))
      .filter((x) => x !== null);
    check('每个「用哪家」下拉里都能选到 TikHub（不再漏）',
      aiBox.pickOpts.length > 0 && noTik.length === 0,
      `没有 TikHub 的下拉序号：${JSON.stringify(noTik)} · 第一个下拉的可选值：${JSON.stringify(aiBox.pickOpts[0])}`);
    check('「抽客户档案用哪个 AI」下拉里也有 TikHub',
      aiBox.extractOpts.includes('tikhub'), JSON.stringify(aiBox.extractOpts));
    check('固定项只剩 ① 接收信息（程序自己做 · 不用配）；④ 不再固定',
      aiBox.fixed.length === 1 && aiBox.fixed.some((x) => /不用配/.test(x)),
      JSON.stringify(aiBox.fixed));

    // ① 接收信息：采集环节，界面要明说「不需要 AI」，不能误报「未配置」
    const recRow = await setPageA.evaluate(() => {
      const row = [...document.querySelectorAll('#ai-body .ai-task')]
        .find((x) => /接收信息/.test(x.textContent));
      if (!row) return null;
      return {
        badge: row.querySelector('.ai-badge')?.textContent.trim() || '',
        pickCount: row.querySelectorAll('select.ai-task-pick').length,
        fixedTxt: row.querySelector('.fixed-model')?.textContent.trim() || '',
        use: row.querySelector('.ai-task-use')?.textContent.trim() || '',
      };
    });
    check('① 接收信息标成「不需要 AI」（不是「未配置」）',
      !!recRow && /不需要 AI/.test(recRow.badge), JSON.stringify(recRow));
    check('① 接收信息不给「用哪家」下拉（它不调 AI）', !!recRow && recRow.pickCount === 0);

    // ④ 采纳后翻英文：现在应该是一个可选 DeepSeek / GPT / Agnes 的下拉，而不是固定文案
    const trRow = await setPageA.evaluate(() => {
      const row = [...document.querySelectorAll('#ai-body .ai-task')]
        .find((x) => /采纳后翻成英文/.test(x.textContent));
      if (!row) return null;
      const sel = row.querySelector('select.ai-task-pick');
      const opts = sel ? [...sel.options].map((o) => o.value) : [];
      return { hasPick: !!sel, opts };
    });
    check('④ 采纳后翻英文现在有「用哪家」下拉（可选 DeepSeek / Agnes / 硅基流动 / OpenRouter / TikHub）',
      !!trRow && trRow.hasPick && ['deepseek', 'agnes', 'siliconflow', 'openrouter', 'tikhub'].every((k) => trRow.opts.includes(k)),
      JSON.stringify(trRow));
    check('① 接收信息写清是「抓 WhatsApp 新消息入库、不看语种」',
      !!recRow && /抓取客户发来的新消息/.test(recRow.use) && /不判断语种/.test(recRow.use),
      recRow && recRow.use.slice(0, 70));
    check('列出 14 个 AI 设置区块（12 个服务商卡片 + 气泡翻译模型 + 翻译词典 两张设置卡）：含 DeepSeek / Agnes / 硅基流动 / OpenRouter / TikHub / 阿里百炼 / AstrBot / ChatAnyWhere / API2GPT / 钱多多 / No.1 API-Pro / 智创聚合', aiBox.secCount === 14, `实际 ${aiBox.secCount}：${aiBox.secNames.join('、')}`);
    check('每个服务商都给出去哪申请（可点开的地址）',
      aiBox.applyCount === 12 && aiBox.applyUrls.every((u) => /^https?:\/\//.test(u)),
      JSON.stringify(aiBox.applyUrls));
    check('弹窗里有「保存」按钮', aiBox.hasSave);

    // 通用设置：提取间隔下拉（2~15 秒）
    const gen = await setPageA.evaluate(() => {
      const sel = document.querySelector('#ai-extract');
      return {
        has: !!sel,
        options: sel ? [...sel.options].map((o) => o.value) : [],
        selected: sel ? sel.value : null,
      };
    });
    check('通用设置里有「提取间隔」下拉', gen.has, JSON.stringify(gen));
    check('下拉选项是 2~15 秒（共 14 项）', gen.options.length === 14 && gen.options[0] === '2' && gen.options[gen.options.length - 1] === '15', JSON.stringify(gen));
    // 不写死 5 秒：用户会自己在「AI 设置」里改提取间隔，写死就会假失败（2026-09-28）
    const cfgExtract = String((require('../src/main').loadConfig().app || {}).extractInterval || 5);
    check(`当前提取间隔与 config.yaml 一致（${cfgExtract} 秒）`, gen.selected === cfgExtract,
      `selected=${gen.selected} config=${cfgExtract}`);
    check('提取间隔落在 2~15 秒的合法区间里',
      Number(gen.selected) >= 2 && Number(gen.selected) <= 15, `selected=${gen.selected}`);

    /* 🔴 v2.6.1098 老板看图要求：AI 服务商卡片排版 = 三字段一行 + 测试连接并入「去哪申请」行
       （目标图 QQ20261012-214150-副本.png；12 个服务商统一这个样式） */
    const aiLayout = await setPageA.evaluate(() => {
      const secs = [...document.querySelectorAll('#ai-body .ai-sec:not(.ai-general):not(.ai-extract-pick):not(.ai-bubble-model)')];
      // 取第一张「服务商卡片」（带 .ai-fields 的那种）；mem-model / bubble-model 卡片没有这一行，不能拿来量排版
      const first = secs.find((s) => s.querySelector('.ai-fields')) || secs[0];
      const fields = first ? [...first.querySelectorAll('.ai-fields label')] : [];
      const rects = fields.map((l) => l.getBoundingClientRect());
      const sameRow = rects.length >= 2 && rects.every((r) => Math.abs(r.top - rects[0].top) < 6);
      const testBtn = first ? first.querySelector('.ai-apply button[data-test]') : null;
      const copyBtn = first ? first.querySelector('.ai-apply button[data-copy]') : null;
      const tRect = testBtn ? testBtn.getBoundingClientRect() : null;
      const cRect = copyBtn ? copyBtn.getBoundingClientRect() : null;
      return {
        secCount: secs.length,
        withFields: secs.filter((s) => s.querySelector('.ai-fields')).length,
        fieldsPerCard: fields.length,
        sameRow,
        useInCard: document.querySelectorAll('#ai-body .ai-sec:not(.ai-general):not(.ai-extract-pick):not(.ai-bubble-model):not(.ai-mem-model) .ai-use').length,
        testInApply: !!testBtn,
        testText: testBtn ? testBtn.textContent.trim() : '',
        copyText: copyBtn ? copyBtn.textContent.trim() : '',
        // 复制地址 / 测试连接 并排（同一行）
        btnsSameRow: !!tRect && !!cRect && Math.abs(tRect.top - cRect.top) < 6,
      };
    });
    check('🔴 12 个服务商卡片都改成「三字段一行」排版（接入地址 / API Key / 模型名 同排）',
      aiLayout.secCount === 13 && aiLayout.withFields === 12 && aiLayout.fieldsPerCard === 3 && aiLayout.sameRow,
      JSON.stringify(aiLayout));
    check('🔴 服务商卡片里不再有「用来干：…」那行（按目标图撤掉；「通用设置」「抽档案」两块不受影响）',
      aiLayout.useInCard === 0, JSON.stringify(aiLayout));
    check('🔴「测试连接」已并入「去哪申请」那行末尾，与「复制地址」并排',
      aiLayout.testInApply && aiLayout.testText === '测试连接' && aiLayout.copyText === '复制地址' && aiLayout.btnsSameRow,
      JSON.stringify(aiLayout));

    /* 🔴 v2.6.1098 老板看图要求：代理行排版 = 协议/主机/端口/用户名/密码/测试代理 一行放齐
       （目标图 QQ20261013-194825-副本.png；地区备注从界面撤掉，值保留） */
    const pxTab = await setPageA.$('.set-tab[data-tab="proxy"]');
    if (pxTab) await pxTab.click();
    await new Promise((r) => setTimeout(r, 700));
    const pxLayout = await setPageA.evaluate(() => {
      const grid = document.querySelector('#proxy-body .px-row .px-grid');
      if (!grid) return { hasGrid: false };
      const kids = [...grid.children];
      const tops = kids.map((k) => Math.round(k.getBoundingClientRect().top));
      const spread = Math.max(...tops) - Math.min(...tops);
      const f = (n) => grid.querySelector(`[data-f="${n}"]`);
      const testBtn = grid.querySelector('.px-test');
      const regionHidden = document.querySelector('#proxy-body .px-row [data-f="region"]');
      return {
        hasGrid: true,
        childCount: kids.length,
        oneRow: spread <= 8,
        spread,
        userPh: f('user') ? f('user').placeholder : '',
        passPh: f('pass') ? f('pass').placeholder : '',
        testInGrid: !!testBtn,
        testText: testBtn ? testBtn.textContent.trim() : '',
        regionInGrid: !!grid.querySelector('[data-f="region"]'),
        regionHiddenPresent: !!regionHidden,
        regionHiddenType: regionHidden ? regionHidden.getAttribute('type') : '',
        oldRegionInputGone: !grid.querySelector('.px-region-in'),
      };
    });
    check('🔴 代理行改成一横排：协议 / 主机 / 端口 / 用户名 / 密码 / 测试代理 同处一行',
      pxLayout.hasGrid && pxLayout.oneRow && pxLayout.testInGrid && pxLayout.testText === '测试代理',
      JSON.stringify(pxLayout));
    check('🔴 代理行：用户名 / 密码 改成框内占位字（不再左侧标签）',
      pxLayout.userPh === '用户名' && pxLayout.passPh === '密码', JSON.stringify(pxLayout));
    check('🔴 代理行：地区备注从界面撤掉，但值保留（隐藏 input 仍在，保存不丢数据）',
      pxLayout.regionInGrid === false && pxLayout.regionHiddenPresent === true
      && pxLayout.regionHiddenType === 'hidden' && pxLayout.oldRegionInputGone,
      JSON.stringify(pxLayout));

    await setPageA.close();   // 量完就关掉这一页（后面还有别的段落）

    /* ============================================================
     * AI 提示词弹窗：每个任务是拿什么话去干这件事的
     * ============================================================ */
    console.log('\n=== 界面渲染 · AI 提示词（「全局设置」窗口的第二个页签） ===');
    // 顶栏那个「AI 提示词」按钮 2026-09-30 收进「⚙ 设置」了，这里改成量「⚙ 设置」的位置
    // 在主窗口（第一个标签页）上量它
    const setBtn = await page.evaluate(() => {
      const b = document.querySelector('#btn-settings');
      const board = document.querySelector('#btn-board');
      if (!b || !board) return null;
      const br = b.getBoundingClientRect();
      const dr = board.getBoundingClientRect();
      return { text: b.textContent.trim(), left: br.left, right: br.right, boardRight: dr.right, visible: br.width > 0 && br.height > 0 };
    });
    check('顶栏有「⚙ 设置」图标按钮', !!setBtn && /设置/.test(setBtn.text) && setBtn.visible, JSON.stringify(setBtn));
    check('「⚙ 设置」在「话术编排台」右边（用户截图红箭头的位置）',
      !!setBtn && setBtn.left >= setBtn.boardRight - 1, JSON.stringify(setBtn));

    // 另开一页 → 切到「AI 提示词」页签
    const setPageB = await browser.newPage();
    await setPageB.goto(`http://127.0.0.1:${PORT}/settings.html`, { waitUntil: 'networkidle2' });
    await setPageB.evaluate(() => { const t = document.querySelector('.set-tab[data-tab="prompts"]'); if (t) t.click(); });
    await new Promise((r) => setTimeout(r, 1000));
    const pr = await setPageB.evaluate(() => {
      const sec = document.querySelector('#sec-prompts');
      const tabs = [...document.querySelectorAll('#pr-side .pr-tab')];
      const sys = document.querySelector('#pr-main .pr-pre.pr-sys');
      return {
        visible: !!sec && !sec.classList.contains('hidden'),
        tabCount: tabs.length,
        tabNames: tabs.map((t) => t.querySelector('.pr-tab-cn')?.textContent.trim() || ''),
        title: document.querySelector('#pr-main .pr-title')?.textContent.trim() || '',
        sysText: sys ? sys.textContent : '',
        userText: document.querySelector('#pr-main .pr-pre.pr-user')?.textContent || '',
        hasWhen: !!document.querySelector('#pr-main .pr-when'),
        hasWhere: !!document.querySelector('#pr-main .pr-where code'),
        hasCopy: document.querySelectorAll('#pr-main button[data-pr-copy]').length,
        hasOut: !!document.querySelector('#pr-main .pr-out'),
      };
    });
    check('AI 提示词页签能打开', pr.visible);
    // 5 个 AI + 1 个内部任务（抽档案）+ 1 个「版本信息」
    check('左边列出 5 个 AI + 1 个内部任务 + 版本信息', pr.tabCount === 7, `实际 ${pr.tabCount}：${pr.tabNames.join('、')}`);
    check('「版本信息」是左栏最后一项', pr.tabNames[pr.tabNames.length - 1] === '版本信息', pr.tabNames.join('、'));
    check('说了"什么时候跑"', pr.hasWhen);
    check('说了代码位置（改提示词就去那）', pr.hasWhere);
    check('系统提示词真的显示出来了', pr.sysText.length > 10, `实际 ${pr.sysText.length} 字`);
    check('发了什么内容也显示出来（不是空的）', pr.userText.length > 0);
    check('有复制按钮（系统提示词 / 发出去的内容）', pr.hasCopy >= 2, `实际 ${pr.hasCopy}`);
    check('说了它会返回什么', pr.hasOut);

    // 切到「翻译收到的消息」：内容要跟着换（不是死的）
    await setPageB.evaluate(() => {
      const t = [...document.querySelectorAll('#pr-side .pr-tab')]
        .find((x) => /翻译收到的消息/.test(x.textContent));
      if (t) t.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    const pr2 = await setPageB.evaluate(() => ({
      title: document.querySelector('#pr-main .pr-title')?.textContent.trim() || '',
      sys: document.querySelector('#pr-main .pr-pre.pr-sys')?.textContent || '',
      onTab: document.querySelector('#pr-side .pr-tab.on .pr-tab-cn')?.textContent.trim() || '',
    }));
    check('点另一个任务，右边会换成它的提示词', pr2.title === pr2.onTab && /翻译收到的消息/.test(pr2.title), JSON.stringify(pr2.title));
    check('看到的就是真的提示词（"你是翻译器…"）', /你是翻译器/.test(pr2.sys), pr2.sys.slice(0, 60));

    // ① 接收信息：采集环节 —— 看到的是「不调 AI、没有提示词」，不是 yes/no 语种判断
    await setPageB.evaluate(() => {
      const t = [...document.querySelectorAll('#pr-side .pr-tab')]
        .find((x) => /接收信息/.test(x.textContent));
      if (t) t.click();
    });
    await new Promise((r) => setTimeout(r, 250));
    const pr0 = await setPageB.evaluate(() => ({
      badges: [...document.querySelectorAll('#pr-main .pr-badges .ai-badge')].map((b) => b.textContent.trim()),
      sys: document.querySelector('#pr-main .pr-pre.pr-sys')?.textContent || '',
      out: document.querySelector('#pr-main .pr-out')?.textContent || '',
      when: document.querySelector('#pr-main .pr-when')?.textContent || '',
      notes: [...document.querySelectorAll('#pr-main .pr-notes li')].map((li) => li.textContent.trim()),
    }));
    check('① 接收信息在提示词弹窗里标明「采集环节 · 不调用 AI」',
      pr0.badges.some((b) => /不调用 AI/.test(b)), JSON.stringify(pr0.badges));
    check('① 接收信息不再显示 yes/no 语种判断那套提示词',
      !/yes/.test(pr0.sys + pr0.out), (pr0.sys || '').slice(0, 50));
    check('① 接收信息说清是「客户每发来一条新消息就跑」',
      /客户每发来一条新消息/.test(pr0.when), (pr0.when || '').slice(0, 50));
    check('① 接收信息写清「中文不会被翻译」',
      pr0.notes.some((n) => /中文不翻|不会被翻译|直接跳过/.test(n)), JSON.stringify(pr0.notes).slice(0, 130));
    fs.mkdirSync(path.join(ROOT, 'preview'), { recursive: true });
    await setPageB.screenshot({ path: path.join(ROOT, 'preview', '提示词_接收信息.png') });

    // ② 翻译：语种判断挪到这边了，点开能看到那段兜底提示词
    const pr1 = await setPageB.evaluate(() => {
      const t = [...document.querySelectorAll('#pr-side .pr-tab')]
        .find((x) => /翻译收到的消息/.test(x.textContent));
      if (t) t.click();
      const det = document.querySelector('#pr-main .pr-parts');
      return {
        hasParts: !!det,
        sum: det ? det.querySelector('summary')?.textContent.trim() : '',
        partText: det ? [...det.querySelectorAll('.pr-pre')].map((p) => p.textContent).join('\n') : '',
        notes: [...document.querySelectorAll('#pr-main .pr-notes li')].map((li) => li.textContent.trim()),
      };
    });
    check('② 翻译里挂着「语种兜底」那段（中英混着写才用得上）',
      pr1.hasParts && /语种兜底/.test(pr1.sum) && /要不要译成中文/.test(pr1.partText), pr1.sum);
    check('② 翻译写明「本来就是中文的直接跳过、不花钱」',
      pr1.notes.some((n) => /直接跳过不翻/.test(n)), JSON.stringify(pr1.notes).slice(0, 150));

    // 切到「③ 回复建议」（内容最全：知识库 + 教练块都在里面），留一张截图
    await setPageB.evaluate(() => {
      const t = [...document.querySelectorAll('#pr-side .pr-tab')]
        .find((x) => /回复建议/.test(x.textContent));
      if (t) t.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    fs.mkdirSync(path.join(ROOT, 'preview'), { recursive: true });
    await setPageB.screenshot({ path: path.join(ROOT, 'preview', '提示词弹窗.png') });
    await setPageB.close();   // 量完就关掉这一页（后面还有别的段落）

    /* ============================================================
     * 中文回复建议 + 翻译弹窗
     *   本轮三件事：① 点「采纳」之后「翻译」按钮必须还在；
     *              ② 弹窗里加「方式」下拉（自动翻译 = 开窗即翻 / 手动翻译 = 点按钮才翻）；
     *              ③ 模型徽章跟着「AI 设置 → ④ 采纳后翻成英文」显示，不再是「GPT（固定）」。
     * ============================================================ */
    console.log('\n=== 界面渲染 · 建议卡「采纳」+ 翻译弹窗 ===');
    await page.evaluate((code) => openCustomer(code), seedC.code);
    await new Promise((r) => setTimeout(r, 700));

    // 打桩：/api/suggestion/adopt 假装记住成功；/api/ai/config 假装 ④ 选了 DeepSeek；
    //       /api/translate 假装翻好了，并记下被调用了几次（用来看"自动"到底翻没翻）
    await page.evaluate(() => {
      window.__trCalls = [];
      window.__origFetch = window.fetch.bind(window);
      const json = (obj) => Promise.resolve(new Response(JSON.stringify(obj), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
      window.fetch = (url, opt) => {
        const u = String(url);
        if (u.includes('/api/suggestion/adopt')) return json({ ok: true, dedup: false });
        if (u.includes('/api/ai/config')) {
          return json({
            file: 'config.yaml', providers: {}, tasks: {},
            taskState: { translateReply: { provider: 'deepseek', model: 'deepseek-chat', ready: true } },
            catalog: {
              tasks: [],
              providers: [
                { key: 'deepseek', cn: 'DeepSeek（深度求索）', short: 'DeepSeek' },
                { key: 'gpt', cn: 'GPT（OpenAI 或兼容网关）', short: 'GPT' },
                { key: 'agnes', cn: 'Agnes（agnes-ai.com）', short: 'Agnes' },
              ],
            },
          });
        }
        if (u.includes('/api/translate')) {
          window.__trCalls.push(u);
          return json({
            ok: true, provider: 'deepseek', model: 'deepseek-chat',
            versions: [{ text: 'I am painting a ginger cat.', note: 'casual' }, { text: 'Working on an orange cat.', note: '' }],
            tip: 'keep it warm',
          });
        }
        // 需求③：逐条「建议」按钮走 /api/customer/:code/suggest（带 messageId），这里桩掉，不真打 AI
        if (u.includes('/suggest')) {
          return json({
            suggestionId: 99, attempt: 0,
            day: { day: 0, source: 'join' },
            groups: [{
              index: 0, message: '客户说：测试这条消息',
              options: [
                { angle: 'empathy', text: '我特别懂这种感觉。' },
                { angle: 'story', text: '我家也养过一只很闹腾的猫。' },
                { angle: 'nudge', text: '它叫什么名字呀？' },
              ],
            }],
            rationale: '', riskFlags: [],
          });
        }
        return window.__origFetch(url, opt);
      };
    });

    // 需求②：右栏已不再渲染「生成建议」卡片（#suggest-out / #suggest-groups 已移除），
    // 该功能已迁到独立浮窗（window.beeSuggest.open）。这里断言旧卡确实不存在，
    // 防止回归时又把建议塞回右栏。原「采纳后翻译按钮留存 / 手动·自动翻译弹窗」断言
    // 依赖已删除的右栏卡片 DOM，故改为负向校验（翻译弹窗行为由逐条「建议」弹窗用例覆盖）。
    const noRightSuggest = await page.evaluate(() => ({
      hasOldCard: !!document.querySelector('#suggest-out') || !!document.querySelector('#suggest-groups'),
    }));
    check('需求②：右栏不再有「生成建议」卡片（已迁独立浮窗）', !noRightSuggest.hasOldCard, JSON.stringify(noRightSuggest));

    /* ============================================================
     * 需求③：每条客户消息后的「建议」按钮 → 弹窗给 3 条（不占右栏）
     * ============================================================ */
    console.log('\n=== 界面渲染 · 需求③ 逐条「建议」按钮 → 弹窗 ===');
    const bubbleSuggest = await page.evaluate(async () => {
      const btn = document.querySelector('#msgs .bubble .bub-suggest');
      if (!btn) return { hasBtn: false };
      const beforeRight = document.querySelectorAll('#suggest-out .opt').length;
      btn.click();
      await new Promise((r) => setTimeout(r, 450));
      const modal = document.querySelector('#msg-suggest-modal');
      const open = !!(modal && !modal.classList.contains('hidden'));
      const cards = document.querySelectorAll('#msg-suggest-groups .opt').length;
      const src = (document.querySelector('#msg-suggest-src')?.textContent || '').trim().slice(0, 40);
      const afterRight = document.querySelectorAll('#suggest-out .opt').length;
      return { hasBtn: true, open, cards, src, beforeRight, afterRight };
    });
    check('需求③：每条客户消息后有「建议」按钮', bubbleSuggest.hasBtn, JSON.stringify(bubbleSuggest));
    check('点「建议」弹出独立小窗（不再占用右栏）', bubbleSuggest.open, JSON.stringify(bubbleSuggest));
    check('弹窗里针对这条消息给出 3 条建议', bubbleSuggest.cards === 3, `卡片 ${bubbleSuggest.cards}`);
    check('弹窗没有把建议塞进右栏（右栏卡片数不变）',
      bubbleSuggest.afterRight === bubbleSuggest.beforeRight, `点前 ${bubbleSuggest.beforeRight} → 点后 ${bubbleSuggest.afterRight}`);
    await page.evaluate(() => {
      const m = document.querySelector('#msg-suggest-modal');
      if (m) m.classList.add('hidden');
    });

    /* ============================================================
     * 底部「✓ 标记已回复」闸门 + 「⏭ 跳过消息」+ 左栏分组（需求③）
     *   - 没检测到我已回复 → 「✓ 标记已回复」灰着按不动；「⏭ 跳过消息」只要还有未处理消息就亮
     *   - 检测到我已回复（最新一条是 out）→ 两个都亮
     *   - 灰着时点按钮不会真的发请求（闸门接线）
     *   - 处理完的客户（pending=0 且 unread=0）**直接从左栏列表移除**（不是折叠组）
     * ============================================================ */
    console.log('\n=== 界面渲染 · 底部「标记已回复」闸门 + 「跳过消息」+ 左栏分组 ===');
    const foot = await page.evaluate(() => {
      state.messages = [];
      renderMessages(state.messages);
      const rep = document.querySelector('#btn-replied');
      const skip = document.querySelector('#btn-skip');
      return {
        repInFoot: !!(rep && document.querySelector('#chat-foot')?.contains(rep)),
        skipInFoot: !!(skip && document.querySelector('#chat-foot')?.contains(skip)),
        repDisabled: rep?.disabled ?? null,
        skipDisabled: skip?.disabled ?? null,
      };
    });
    check('底部有「✓ 标记已回复」按钮（在 #chat-foot 里）', foot.repInFoot, JSON.stringify(foot));
    check('底部有「⏭ 跳过消息」按钮（在 #chat-foot 里）', foot.skipInFoot, JSON.stringify(foot));
    // 「跳过消息」= 永远可点（用户 2026-09-26 两次强调："都是可操作的按键，没有限制的"）
    check('没有任何消息时，「⏭ 跳过消息」**依然可点**（无前置条件）',
      foot.skipDisabled === false, JSON.stringify(foot));
    // 「标记已回复」没有对话可回 → 灰
    check('没有任何消息时，「✓ 标记已回复」灰色不可按',
      foot.repDisabled === true, JSON.stringify(foot));

    // 闸门：有未处理新消息、但还没检测到我的回复 → 标记已回复 灰；跳过永远 亮
    const gateNoReply = await page.evaluate(() => {
      const ts = new Date().toISOString();
      state.customer = null;
      state.messages = [{ id: 1, direction: 'in', body: 'hi', msg_ts: ts, processed: 0 }];
      renderMessages(state.messages);
      return {
        rep: document.querySelector('#btn-replied')?.disabled,
        skip: document.querySelector('#btn-skip')?.disabled,
      };
    });
    check('有对话、但没检测到我的回复 → 「✓ 标记已回复」灰色不可按',
      gateNoReply.rep === true, JSON.stringify(gateNoReply));
    check('「⏭ 跳过消息」始终可点（与有没有回复无关）',
      gateNoReply.skip === false, JSON.stringify(gateNoReply));

    // 闸门：检测到我发的回复（最新一条是 out）→ 标记已回复 亮
    const gateReplied = await page.evaluate(() => {
      const ts = new Date().toISOString();
      state.customer = null;
      state.messages = [
        { id: 1, direction: 'in', body: 'hi', msg_ts: ts, processed: 0 },
        { id: 2, direction: 'out', body: 'hello back', msg_ts: ts, processed: 0 },
      ];
      renderMessages(state.messages);
      return {
        rep: document.querySelector('#btn-replied')?.disabled,
        skip: document.querySelector('#btn-skip')?.disabled,
      };
    });
    check('检测到我已回复（最新一条是 out）→ 「✓ 标记已回复」亮起来可按',
      gateReplied.rep === false, JSON.stringify(gateReplied));
    check('检测到我已回复后「⏭ 跳过消息」也仍亮',
      gateReplied.skip === false, JSON.stringify(gateReplied));

    // ⚠️ 真实场景（用户截图 #1）：这个客户已经被处理过——所有 in 消息都已 processed=1（left=0），
    //    但对话末尾是我发的回复（或后端 repliedLast=true）→ 「标记已回复」必须仍可点！
    //    旧实现用 left>0 当门槛，导致这里被灰掉，就是用户说的"你还没有处理好"。
    const gateProcessedButReplied = await page.evaluate(() => {
      const ts = new Date().toISOString();
      state.customer = null;
      state.messages = [
        { id: 1, direction: 'in', body: 'hi', msg_ts: ts, processed: 1 },
        { id: 2, direction: 'out', body: 'hello back', msg_ts: ts, processed: 1 },
        { id: 3, direction: 'in', body: 'new york', msg_ts: ts, processed: 1 },
      ];
      renderMessages(state.messages);
      return {
        rep: document.querySelector('#btn-replied')?.disabled,
        skip: document.querySelector('#btn-skip')?.disabled,
      };
    });
    check('所有 in 消息都已 processed（left=0）但末尾是 out → 「✓ 标记已回复」仍可点（真实截图场景）',
      gateProcessedButReplied.rep === false, JSON.stringify(gateProcessedButReplied));
    check('该场景下「⏭ 跳过消息」也可点',
      gateProcessedButReplied.skip === false, JSON.stringify(gateProcessedButReplied));

    // 反向：我回复过，但客户之后又发来一条**未处理**的新消息 → 上一轮回复失效，标记已回复应重新变灰
    const gateNewAfterReply = await page.evaluate(() => {
      const ts = new Date().toISOString();
      state.customer = { code: '1A00001', repliedLast: false };
      state.messages = [
        { id: 1, direction: 'in', body: 'hi', msg_ts: ts, processed: 1 },
        { id: 2, direction: 'out', body: 'hello back', msg_ts: ts, processed: 1 },
        { id: 3, direction: 'in', body: 'are you there?', msg_ts: ts, processed: 0 }, // 新，未处理
      ];
      renderMessages(state.messages);
      const rep = document.querySelector('#btn-replied')?.disabled;
      state.customer = null;
      return { rep };
    });
    check('我回复后客户又发来未处理新消息 → 「✓ 标记已回复」重新变灰（需再回一次）',
      gateNewAfterReply.rep === true, JSON.stringify(gateNewAfterReply));

    // 闸门（兜底）：后端 repliedLast=true 但前端消息序里最后一条不是 out
    //   —— 例如这条回复是历史里更早发的、或前端排序差异。只要有未处理新消息 + 后端认定已回复，
    //      标记已回复就必须亮（用户 2026-09-26 真实场景：看到了自己回复、按钮却灰着）。
    const gateFallback = await page.evaluate(() => {
      const ts = new Date().toISOString();
      state.customer = { code: '1A00001', repliedLast: true };
      state.messages = [
        { id: 1, direction: 'in', body: 'hi', msg_ts: ts, processed: 0 },
        { id: 2, direction: 'out', body: 'hello back', msg_ts: ts, processed: 0 },
        { id: 3, direction: 'in', body: 'thanks!', msg_ts: ts, processed: 0 },
      ]; // 最后一条是 in，但后端认定已回复过
      renderMessages(state.messages);
      const rep = document.querySelector('#btn-replied')?.disabled;
      const skip = document.querySelector('#btn-skip')?.disabled;
      state.customer = null; // 还原，免得影响后面
      return { rep, skip };
    });
    check('后端 repliedLast=true（即使前端末条不是 out）→ 「✓ 标记已回复」仍亮',
      gateFallback.rep === false, JSON.stringify(gateFallback));
    check('兜底情形下「⏭ 跳过消息」也亮',
      gateFallback.skip === false, JSON.stringify(gateFallback));

    // 闸门接线：按钮灰着时 markReplied 直接 return，不会真的发请求
    const gateWire = await page.evaluate(async () => {
      window.__replyCalls = 0;
      window.__origFetch2 = window.fetch.bind(window);
      window.fetch = (url, opt) => {
        if (String(url).includes('/replied')) window.__replyCalls++;
        return window.__origFetch2(url, opt);
      };
      const ts = new Date().toISOString();
      state.customer = null;
      state.messages = [{ id: 1, direction: 'in', body: 'hi', msg_ts: ts, processed: 0 }];
      renderMessages(state.messages);
      await markReplied(false); // 灰的，应该直接 return
      const calls = window.__replyCalls;
      window.fetch = window.__origFetch2;
      return { calls, repDisabled: document.querySelector('#btn-replied').disabled };
    });
    check('「✓ 标记已回复」灰色时，点它不会真的发请求（闸门接线正确）',
      gateWire.repDisabled === true && gateWire.calls === 0, JSON.stringify(gateWire));

    // 「⏭ 跳过消息」永远可点 → 点了必须真的发请求（用户 2026-09-26："都是可操作的按键"）
    const skipWire = await page.evaluate(async () => {
      window.__skipCalls = 0;
      window.__origFetch3 = window.fetch.bind(window);
      window.fetch = (url, opt) => {
        if (String(url).includes('/replied')) window.__skipCalls++;
        return window.__origFetch3(url, opt);
      };
      const ts = new Date().toISOString();
      state.customer = null;
      state.messages = [{ id: 1, direction: 'in', body: 'hi', msg_ts: ts, processed: 0 }];
      renderMessages(state.messages);
      const beforeDisabled = document.querySelector('#btn-skip').disabled;
      await markReplied(true);
      const calls = window.__skipCalls;
      window.fetch = window.__origFetch3;
      return { beforeDisabled, calls };
    });
    check('「⏭ 跳过消息」永远可点，点了真的发请求（无前置条件）',
      skipWire.beforeDisabled === false && skipWire.calls === 1, JSON.stringify(skipWire));

    // 左栏：处理完的客户（pending=0 且 unread=0）**直接从列表移除**（用户 2026-09-26 第三次强调：
    //   要"删掉/隐藏"，不是"折叠成一个可展开的「已处理 · N」组、还得点开才看到"）。
    const group = await page.evaluate(() => {
      state.customers = [
        { code: '1A00001', name: '甲', account_id: 1, unread: 1, pending: 1 },
        { code: '1A00002', name: '乙', account_id: 2, unread: 0, pending: 0 },
      ];
      paintCustomers();
      return {
        hasGroupHead: !!document.querySelector('#group-done'),        // 旧的折叠组标题不该再有
        hasGroupBody: !!document.querySelector('#group-done-body'),
        liveExists: !!document.querySelector('#list-body .cust[data-code="1A00001"]'),
        doneAnywhere: !!document.querySelector('#list-body .cust[data-code="1A00002"]'), // 乙彻底不出现
        custCount: document.querySelectorAll('#list-body .cust').length,
      };
    });
    check('处理完的客户**直接从左栏列表移除**（DOM 里彻底没有它）',
      group.doneAnywhere === false, JSON.stringify(group));
    check('不再有「已处理 · N」折叠组标题（那是上一版做错的"折叠置顶"）',
      group.hasGroupHead === false && group.hasGroupBody === false, JSON.stringify(group));
    check('待处理的客户仍在左栏', group.liveExists, JSON.stringify(group));
    check('左栏只剩 1 个还在待处理的客户', group.custCount === 1, JSON.stringify(group));

    // 处理完的客户再来新消息 → 按新消息规则重新冒回左栏
    const reborn = await page.evaluate(() => {
      state.customers = [
        { code: '1A00001', name: '甲', account_id: 1, unread: 1, pending: 1 },
        { code: '1A00002', name: '乙', account_id: 2, unread: 1, pending: 1 }, // 乙又来消息
      ];
      paintCustomers();
      return {
        back: !!document.querySelector('#list-body .cust[data-code="1A00002"]'),
        count: document.querySelectorAll('#list-body .cust').length,
      };
    });
    check('处理完的客户再来新消息 → 重新冒回左栏（不是永久消失）',
      reborn.back === true && reborn.count === 2, JSON.stringify(reborn));

    // 全空时显示占位
    const emptyList = await page.evaluate(() => {
      state.customers = [{ code: '1A00001', name: '甲', account_id: 1, unread: 0, pending: 0 }];
      paintCustomers();
      return {
        none: !!document.querySelector('#list-body .list-none'),
        custs: document.querySelectorAll('#list-body .cust').length,
      };
    });
    check('所有客户都处理完 → 左栏显示「现在没有待处理的新消息」占位',
      emptyList.none === true && emptyList.custs === 0, JSON.stringify(emptyList));

    // 紧盯着底部栏拍两张：① 还没回复（标记已回复灰、跳过亮）② 已回复（两个都亮）
    // 用户 2026-09-26 反馈"按钮看起来都是灰的/排版乱"——这里直接给他看清楚两种态。
    await page.evaluate(() => {
      const ts = new Date().toISOString();
      state.customer = { code: '1A00001', repliedLast: false };
      state.messages = [{ id: 1, direction: 'in', body: 'Hi Sherry, I saw your pet portraits!', msg_ts: ts, processed: 0 }];
      renderMessages(state.messages);
    });
    await new Promise((r) => setTimeout(r, 60));
    const footNo = path.join(ROOT, 'preview', '底部栏_尚未回复.png');
    const footNoEl = await page.$('#chat-foot');
    if (footNoEl) await footNoEl.screenshot({ path: footNo });

    await page.evaluate(() => {
      const ts = new Date().toISOString();
      state.customer = { code: '1A00001', repliedLast: true };
      state.messages = [
        { id: 1, direction: 'in', body: 'Hi Sherry, I saw your pet portraits!', msg_ts: ts, processed: 0 },
        { id: 2, direction: 'out', body: "Hi! Thank you so much, that means a lot 🐾", msg_ts: ts, processed: 0 },
      ];
      renderMessages(state.messages);
    });
    await new Promise((r) => setTimeout(r, 60));
    const footYes = path.join(ROOT, 'preview', '底部栏_已回复.png');
    const footYesEl = await page.$('#chat-foot');
    if (footYesEl) await footYesEl.screenshot({ path: footYes });
    console.log(`\n底部栏截图：\n  - 尚未回复：${footNo}\n  - 已回复：${footYes}`);

    /* ============================================================
     * 话术编排台（左栏话题碎片 + 右侧对话卡片）
     * 守这几条：
     *   ① 左栏每个碎片各自一个圆角方框（常驻描边，不是只在悬停/选中才出现）
     *   ② 左栏底部有「＋ 添加」按钮，点了能真的新加一个碎片
     *   ③ 右侧卡片能「点选」；右上角的「删」删的是被点选的那条对话（≠ 左下角删整个碎片）
     *   ④ 「已发」= 把这条静默（灰掉+划线），按钮变「恢复」；再点「恢复」取消静默
     * ============================================================ */
    console.log('\n=== 界面渲染 · 话术编排台 ===');
    await page.evaluate((code) => window.Board.openFor(code), seedC.code);
    await new Promise((r) => setTimeout(r, 500));

    const boardShown = await page.evaluate(() => {
      const p = document.getElementById('board-panel');
      const s = p ? getComputedStyle(p) : null;
      return { exists: !!p, hidden: p ? p.classList.contains('hidden') : true, display: s ? s.display : '' };
    });
    check('编排台面板能打开', boardShown.exists && !boardShown.hidden && boardShown.display !== 'none', JSON.stringify(boardShown));

    // ① 每个碎片都有圆角方框
    const fragBox = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#board-list .bp-frag'));
      const noBox = items.filter((el) => {
        const s = getComputedStyle(el);
        return !(parseFloat(s.borderTopWidth) >= 1 && s.borderTopStyle === 'solid');
      });
      return { n: items.length, noBox: noBox.length, radius: items[0] ? getComputedStyle(items[0]).borderTopLeftRadius : '' };
    });
    check('左栏每个碎片各自有圆角方框（常驻描边）',
      fragBox.n > 0 && fragBox.noBox === 0 && parseFloat(fragBox.radius) >= 4, JSON.stringify(fragBox));

    // ①-b 碎片标题前的时段图标：早=绿底 晚=紫底 通=蓝底
    const tags = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#board-list .bp-frag').forEach((el) => {
        const tag = el.querySelector('.bp-tag');
        const name = el.querySelector('.bp-frag-name');
        if (!tag || !name) { out.push({ name: el.textContent.trim(), missing: true }); return; }
        const s = getComputedStyle(tag);
        out.push({
          name: name.textContent.trim(),
          ch: tag.textContent.trim(),
          bg: s.backgroundColor,
          before: tag.compareDocumentPosition(name) === Node.DOCUMENT_POSITION_FOLLOWING,
          w: Math.round(tag.getBoundingClientRect().width),
        });
      });
      return out;
    });
    const tagMap = {};
    tags.forEach((t) => { tagMap[t.name] = t; });
    check('每个碎片标题前都有时段图标（早/晚/通）',
      tags.length > 0 && tags.every((t) => !t.missing && ['早', '晚', '通'].includes(t.ch) && t.before),
      JSON.stringify(tags.slice(0, 3)));
    // 时段图标三态：不写死碎片名（种子会更新），按「图标字符」分组各取一个来验底色。
    // ⚠️ Day 1 页里不一定三种都有（种子里早上碎片在别的天），所以这里扫【全部数据】，
    //    按字符先查到对应的色值，再跟当前页里出现过的图标交叉验证。
    const byCh = (c) => tags.find((t) => t.ch === c);
    const seenCh = new Set(tags.map((t) => t.ch));
    check('早上碎片 = 绿底「早」',
      !seenCh.has('早') ? true /* 本页没有早上碎片就不判它 */
        : (byCh('早') && /rgb\(47,\s*158,\s*94\)/.test(byCh('早').bg || '')),
      JSON.stringify(byCh('早') || `本页没有「早」图标（${[...seenCh].join('')}）`));
    check('晚上碎片 = 紫底「晚」', byCh('晚') && /rgb\(124,\s*58,\s*237\)/.test(byCh('晚').bg || ''),
      JSON.stringify(byCh('晚') || null));
    check('通用碎片 = 蓝底「通」', byCh('通') && /rgb\(47,\s*127,\s*209\)/.test(byCh('通').bg || ''),
      JSON.stringify(byCh('通') || null));
    check('图标是看得见的小方块（不是零尺寸）', tags.every((t) => t.w >= 12), JSON.stringify(tags.map((t) => t.w)));

    // ② 左栏底部「＋ 添加」
    const addBtn = await page.evaluate(() => {
      const b = document.getElementById('board-add');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const left = document.getElementById('board-left').getBoundingClientRect();
      return {
        text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height),
        insideLeft: r.left >= left.left - 1 && r.right <= left.right + 1 && r.top >= left.top - 1,
      };
    });
    check('左栏底部有「＋ 添加」按钮', !!addBtn && /添加/.test(addBtn.text) && addBtn.w > 20 && addBtn.h > 15 && addBtn.insideLeft,
      JSON.stringify(addBtn));

    // 点「＋ 添加」→ 标题变「添加碎片」→ 填名保存 → 左栏多一个且自动选中
    const addFlow = await page.evaluate(async () => {
      const before = document.querySelectorAll('#board-list .bp-frag').length;
      document.getElementById('board-add').click();
      await new Promise((r) => setTimeout(r, 80));
      const title = document.getElementById('bp-frag-title').textContent.trim();
      const empty = document.getElementById('bp-frag-name').value === '';
      document.getElementById('bp-frag-name').value = 'UI测试碎片';
      document.getElementById('bp-frag-morning').checked = false;
      document.getElementById('bp-frag-evening').checked = true;
      document.getElementById('bp-frag-save').click();
      await new Promise((r) => setTimeout(r, 600));
      // 碎片名在 .bp-frag-name 里（前面还挂了一个时段图标「早/晚/通」，别把它算进名字）
      const nameOf = (el) => (el.querySelector('.bp-frag-name')?.textContent || '').trim();
      const names = Array.from(document.querySelectorAll('#board-list .bp-frag')).map(nameOf);
      const sel = document.querySelector('#board-list .bp-frag.active');
      return { before, title, empty, after: names.length, added: names.includes('UI测试碎片'), selName: sel ? nameOf(sel) : '' };
    });
    check('点「＋ 添加」弹窗标题是「添加碎片」且名称框为空', addFlow.title === '添加碎片' && addFlow.empty, JSON.stringify(addFlow));
    check('保存后左栏多出一个碎片并自动选中', addFlow.after === addFlow.before + 1 && addFlow.added && addFlow.selName === 'UI测试碎片',
      JSON.stringify(addFlow));

    // 挑一个「没被静默」且带 ≥2 条对话的碎片，点开右侧卡片
    let pickedName = '', cardsN = 0;
    const candidates = await page.evaluate(() => Array.from(document.querySelectorAll('#board-list .bp-frag'))
      .filter((el) => !el.classList.contains('struck')).map((el) => el.textContent.trim()));
    for (const nm of candidates) {
      pickedName = await page.evaluate((n) => {
        const el = Array.from(document.querySelectorAll('#board-list .bp-frag')).find((x) => x.textContent.trim() === n);
        if (!el) return '';
        el.click(); return n;
      }, nm);
      await new Promise((r) => setTimeout(r, 350));
      cardsN = await page.evaluate(() => document.querySelectorAll('#board-cards .bp-card').length);
      if (cardsN >= 2) break;
    }
    check('点左栏碎片后右侧列出对话卡片（≥2 条）', cardsN >= 2, `碎片=${pickedName} 卡片=${cardsN}`);

    // ③ 位置：右上角「删」在右栏表头里，左下角「删」在左栏按钮条里 —— 两个不是同一个
    const delPos = await page.evaluate(() => ({
      topInRightHead: !!document.querySelector('.board-right-head #board-delfrag'),
      leftInLeftBtns: !!document.querySelector('.board-left-btns #board-del'),
    }));
    check('右上角「删」在右栏表头、左下角「删」在左栏按钮条（是两个不同的按钮）',
      delPos.topInRightHead && delPos.leftInLeftBtns, JSON.stringify(delPos));

    // 未点选任何对话时点「删」→ 不弹删除框、卡片数不变
    const delNoSel = await page.evaluate(async () => {
      const before = document.querySelectorAll('#board-cards .bp-card').length;
      document.getElementById('board-delfrag').click();
      await new Promise((r) => setTimeout(r, 120));
      const poped = !document.getElementById('board-pop-del-dlg').classList.contains('hidden');
      return { before, poped, after: document.querySelectorAll('#board-cards .bp-card').length };
    });
    check('没点选对话时点右上角「删」不会删任何东西', !delNoSel.poped && delNoSel.after === delNoSel.before, JSON.stringify(delNoSel));

    // ④ 「已发」→ 静默 + 变「恢复」；再点「恢复」→ 取消静默
    const sentFlow = await page.evaluate(async () => {
      const cards = document.querySelectorAll('#board-cards .bp-card');
      const firstId = cards[0].dataset.did;
      const otherId = cards[1].dataset.did;
      const btn0 = cards[0].querySelector('button[data-act="sent"]');
      const label0 = btn0.textContent.trim();
      btn0.click();
      await new Promise((r) => setTimeout(r, 700));
      const c1 = document.querySelector(`#board-cards .bp-card[data-did="${firstId}"]`);
      const o1 = document.querySelector(`#board-cards .bp-card[data-did="${otherId}"]`);
      const b1 = c1.querySelector('button[data-act="sent"]').textContent.trim();
      const sent1 = c1.classList.contains('sent');
      const strike1 = getComputedStyle(c1.querySelector('.bp-en')).textDecorationLine;
      const otherSent1 = o1.classList.contains('sent');   // 不能串到别的条
      c1.querySelector('button[data-act="sent"]').click();
      await new Promise((r) => setTimeout(r, 700));
      const c2 = document.querySelector(`#board-cards .bp-card[data-did="${firstId}"]`);
      const b2 = c2.querySelector('button[data-act="sent"]').textContent.trim();
      return {
        label0, b1, sent1, strike1, otherSent1, b2,
        sent2: c2.classList.contains('sent'),
        btnClass2: c2.querySelector('button[data-act="sent"]').className,
      };
    });
    check('未静默时按钮是「已发」', sentFlow.label0 === '已发', JSON.stringify(sentFlow));
    check('点「已发」→ 这条被静默（灰掉+划线）且按钮变「恢复」',
      sentFlow.sent1 && sentFlow.b1 === '恢复' && /line-through/.test(sentFlow.strike1), JSON.stringify(sentFlow));
    check('点「已发」不会把别的对话也静默掉', sentFlow.otherSent1 === false, JSON.stringify(sentFlow));
    check('点「恢复」→ 取消静默、按钮变回「已发」',
      sentFlow.sent2 === false && sentFlow.b2 === '已发', JSON.stringify(sentFlow));

    // ④-b 话题「已完成」：整个话题的对话都点过「已发」→ 左栏打绿色 ✓，并且仍然能点进去看
    const doneFlow = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const selName = document.getElementById('board-frag-name').textContent.trim();
      // 把当前话题里的每条都点成「已发」（每点一次界面会重画，所以每次都重新取按钮）
      for (let i = 0; i < 14; i++) {
        const btn = Array.from(document.querySelectorAll('#board-cards .bp-card button[data-act="sent"]'))
          .find((b) => b.textContent.trim() === '已发');
        if (!btn) break;
        btn.click();
        await wait(420);
      }
      const frag = Array.from(document.querySelectorAll('#board-list .bp-frag'))
        .find((el) => (el.querySelector('.bp-frag-name') || {}).textContent === selName);
      const nm = frag ? frag.querySelector('.bp-frag-name') : null;
      const badge = frag ? frag.querySelector('.bp-done') : null;
      const bs = badge ? getComputedStyle(badge) : null;
      const out = {
        selName,
        hasDone: !!(frag && frag.classList.contains('done')),
        hasBadge: !!badge,
        badgeCh: badge ? badge.textContent.trim() : '',
        badgeBg: bs ? bs.backgroundColor : '',
        badgeW: badge ? Math.round(badge.getBoundingClientRect().width) : 0,
        badgeBeforeName: !!(badge && nm
          && badge.compareDocumentPosition(nm) === Node.DOCUMENT_POSITION_FOLLOWING),
        struck: frag ? frag.classList.contains('struck') : null,
        nameStrike: nm ? getComputedStyle(nm).textDecorationLine : '',
        cursor: frag ? getComputedStyle(frag).cursor : '',
        leftCardsAllSent: Array.from(document.querySelectorAll('#board-cards .bp-card'))
          .every((c) => c.classList.contains('sent')),
      };
      // 已完成的话题仍然可以点进去看
      if (frag) frag.click();
      await wait(400);
      out.afterClickName = document.getElementById('board-frag-name').textContent.trim();
      out.afterClickCards = document.querySelectorAll('#board-cards .bp-card').length;
      // 收尾：还原成未发，免得影响后面的用例
      for (let i = 0; i < 14; i++) {
        const btn = Array.from(document.querySelectorAll('#board-cards .bp-card button[data-act="sent"]'))
          .find((b) => b.textContent.trim() === '恢复');
        if (!btn) break;
        btn.click();
        await wait(320);
      }
      return out;
    });
    check('话题的对话全部标「已发」→ 左栏该碎片带上「已完成」标记',
      doneFlow.leftCardsAllSent && doneFlow.hasDone, JSON.stringify(doneFlow));
    check('完成标记是绿色 ✓ 徽章（圆形、在名字前面）',
      doneFlow.hasBadge && doneFlow.badgeCh === '✓'
      && /rgb\(47,\s*158,\s*94\)/.test(doneFlow.badgeBg || '') && doneFlow.badgeW >= 12
      && doneFlow.badgeBeforeName, JSON.stringify(doneFlow));
    check('已完成的话题不被静默：不划线、名字不变灰、光标仍是可点',
      doneFlow.struck === false && !/line-through/.test(doneFlow.nameStrike) && doneFlow.cursor === 'pointer',
      JSON.stringify(doneFlow));
    check('已完成的话题仍然可以点进去查看（没有静默/藏起来）',
      doneFlow.afterClickName === doneFlow.selName && doneFlow.afterClickCards >= 1,
      JSON.stringify(doneFlow));

    // ③ 卡片可点选：点卡片正文（不是按钮）就算选中，且有可见高亮
    const selFlow = await page.evaluate(async () => {
      const cards = document.querySelectorAll('#board-cards .bp-card');
      const first = cards[0], second = cards[1];
      const firstId = first.dataset.did, secondId = second.dataset.did;
      second.querySelector('.bp-en').click();
      await new Promise((r) => setTimeout(r, 80));
      const s2 = document.querySelector(`#board-cards .bp-card[data-did="${secondId}"]`);
      const s1 = document.querySelector(`#board-cards .bp-card[data-did="${firstId}"]`);
      const sh = getComputedStyle(s2).boxShadow;
      return {
        secondSel: s2.classList.contains('selected'),
        firstSel: s1.classList.contains('selected'),
        shadow: sh && sh !== 'none',
      };
    });
    check('点卡片正文即选中（另一条自动取消选中）', selFlow.secondSel && !selFlow.firstSel, JSON.stringify(selFlow));
    check('选中的卡片有可见高亮', selFlow.shadow === true, JSON.stringify(selFlow));

    // 右上角「删」→ 删掉被点选的那条对话（确认弹窗里带这条的英文）
    const delFlow = await page.evaluate(async () => {
      const before = document.querySelectorAll('#board-cards .bp-card').length;
      const selCard = document.querySelector('#board-cards .bp-card.selected');
      const selId = selCard ? selCard.dataset.did : null;
      const selEn = selCard ? selCard.querySelector('.bp-en').textContent.trim().slice(0, 20) : '';
      document.getElementById('board-delfrag').click();
      await new Promise((r) => setTimeout(r, 120));
      const poped = !document.getElementById('board-pop-del-dlg').classList.contains('hidden');
      const quote = document.getElementById('bp-deldlg-text').textContent.trim();
      document.getElementById('bp-deldlg-yes').click();
      await new Promise((r) => setTimeout(r, 600));
      const after = document.querySelectorAll('#board-cards .bp-card').length;
      const stillThere = !!document.querySelector(`#board-cards .bp-card[data-did="${selId}"]`);
      return { before, selId, selEn, poped, quote, after, stillThere };
    });
    check('点右上角「删」弹出确认框，且引用了被选中那条的内容',
      delFlow.poped && delFlow.quote.length > 0, JSON.stringify(delFlow));
    check('确认后只删掉被点选的那一条对话',
      delFlow.after === delFlow.before - 1 && !delFlow.stillThere, JSON.stringify(delFlow));

    /* ---- Day 分页（2026-09-30）：左栏按天分页，右栏表头「上一页 / Day N / 下一页」 ---- */
    const dayPage = await page.evaluate(async () => {
      const tip = () => document.getElementById('board-left-tip')?.textContent.trim() || '';
      const pageTxt = () => document.getElementById('board-page')?.textContent.trim() || '';
      const n = () => document.querySelectorAll('#board-list .bp-frag').length;
      const page0 = pageTxt(), tip0 = tip(), n0 = n();
      const prevDisabled0 = document.getElementById('board-prev')?.disabled === true;
      document.getElementById('board-next')?.click();
      await new Promise((r) => setTimeout(r, 150));
      const page1 = pageTxt(), tip1 = tip(), n1 = n();
      const empty1 = document.querySelector('#board-list .board-empty')?.textContent || '';
      const prevDisabled1 = document.getElementById('board-prev')?.disabled === true;
      document.getElementById('board-prev')?.click();
      await new Promise((r) => setTimeout(r, 150));
      const page2 = pageTxt(), n2 = n();
      return { page0, tip0, n0, prevDisabled0, page1, tip1, n1, empty1, prevDisabled1, page2, n2 };
    });
    check('编排台左栏默认停在 Day 1（标题/页码都是 Day 1，「上一页」灰着）',
      /^Day 1$/.test(dayPage.page0) && /Day 1 话题碎片/.test(dayPage.tip0)
      && dayPage.n0 > 0 && dayPage.prevDisabled0, JSON.stringify(dayPage));
    // 2026-09-30 起种子是 Day1-7 + 后期维护 全量，Day2 也有碎片了 ——
    // 所以这里不再断言"Day2 是空的"，只验「翻页确实到了 Day 2 且上一页可点」。
    check('点「下一页」→ 翻到 Day 2（标题/页码跟着变，「上一页」变可用）',
      /^Day 2$/.test(dayPage.page1) && /Day 2 话题碎片/.test(dayPage.tip1)
      && dayPage.prevDisabled1 === false,
      JSON.stringify(dayPage));
    check('点「上一页」→ 回到 Day 1（碎片列表原样回来）',
      /^Day 1$/.test(dayPage.page2) && dayPage.n2 === dayPage.n0, JSON.stringify(dayPage));

    // 收回面板，别影响后面的截图
    await page.evaluate(() => window.Board.close());
    await new Promise((r) => setTimeout(r, 120));

    /* ============================================================
     * 处理完 → 中栏一起清空（2026-09-28 需求③）
     *   点「✓ 标记已回复」/「⏭ 跳过消息」之后，中间栏目的消息内容也要消失。
     *   以前只把左栏那一格移除、中栏还停在这个人身上，看着像"没收起来"。
     *   注意：清的是**显示**，数据库和本地档案文件里的对话一条不少（消失 ≠ 删除）。
     * ============================================================ */
    console.log('\n=== 界面渲染 · 处理完中栏一起清空 ===');

    // 造一个「客户发了 + 我回了」的客户，这样「✓ 标记已回复」是亮着的，可以真点
    const clr = db.getOrCreateCustomer(1, '19990003333@c.us', { name: '清空测试' }).customer;
    db.saveMessage({ customerCode: clr.code, accountId: 1, direction: 'in', body: 'hi, is it still available?', waMsgId: 'clr-in-1' });
    db.saveMessage({ customerCode: clr.code, accountId: 1, direction: 'out', body: 'Yes! Still available 🐾', waMsgId: 'clr-out-1' });

    const opened = await page.evaluate(async (code) => {
      await openCustomer(code);
      await new Promise((r) => setTimeout(r, 250));
      return {
        active: state.activeCode,
        bubbles: document.querySelectorAll('#msgs .bubble').length,
        headHasName: /名称:/.test(document.getElementById('chat-head').textContent || ''),
        body: document.getElementById('msgs').textContent || '',
      };
    }, clr.code);
    check('点开客户后中栏有消息内容（清空前的前提）',
      opened.active === clr.code && opened.bubbles >= 2 && opened.headHasName,
      JSON.stringify({ ...opened, body: opened.body.slice(0, 60) }));
    check('中栏确实显示了客户发来的那句', /still available/.test(opened.body), opened.body.slice(0, 80));

    // 真点按钮（不是直接调函数）：「✓ 标记已回复」
    const cleared = await page.evaluate(async () => {
      const btn = document.getElementById('btn-replied');
      const wasEnabled = !btn.disabled;
      btn.click();
      await new Promise((r) => setTimeout(r, 700));
      const msgsText = (document.getElementById('msgs').textContent || '').trim();
      return {
        wasEnabled,
        active: state.activeCode,
        bubbles: document.querySelectorAll('#msgs .bubble').length,
        stillThere: /still available/.test(msgsText),
        placeholder: /已收起|已处理完/.test(msgsText),
        headText: (document.getElementById('chat-head').textContent || '').trim(),
        repDisabled: document.getElementById('btn-replied').disabled,
        skipDisabled: document.getElementById('btn-skip').disabled,
        suggestDisabled: document.getElementById('btn-suggest').disabled,
        activeRow: document.querySelectorAll('#list-body .cust.active').length,
      };
    });
    check('「✓ 标记已回复」当时是亮着的（先确认能按）', cleared.wasEnabled === true, JSON.stringify(cleared));
    check('点完「✓ 标记已回复」→ 中栏消息内容全部消失', cleared.bubbles === 0 && !cleared.stillThere, JSON.stringify(cleared));
    check('中栏给了一句说明（不是一片空白，让人知道去哪了）', cleared.placeholder, JSON.stringify(cleared));
    check('中栏头部回到「选择一个客户」', cleared.headText === '选择一个客户', JSON.stringify(cleared));
    check('没有选中客户 → 两个动作按钮 + 生成建议都灰着（点了不会没反应）',
      cleared.repDisabled && cleared.skipDisabled && cleared.suggestDisabled, JSON.stringify(cleared));
    check('左栏没有任何一行还是选中态', cleared.activeRow === 0, JSON.stringify(cleared));

    // 「⏭ 跳过消息」走同一条路：点完也要把中栏清空
    const skipped = await page.evaluate(async (code) => {
      await openCustomer(code);
      await new Promise((r) => setTimeout(r, 250));
      const before = document.querySelectorAll('#msgs .bubble').length;
      document.getElementById('btn-skip').click();
      await new Promise((r) => setTimeout(r, 700));
      return {
        before,
        after: document.querySelectorAll('#msgs .bubble').length,
        active: state.activeCode,
      };
    }, clr.code);
    check('「⏭ 跳过消息」点完同样把中栏清空',
      skipped.before > 0 && skipped.after === 0 && skipped.active === null, JSON.stringify(skipped));

    // 还原：把客户重新打开，后面的总截图才是正常样子
    await page.evaluate(async (code) => { await openCustomer(code); }, seedC.code);
    await new Promise((r) => setTimeout(r, 250));

    // 2026-09-29 用户需求（截图红框）：底部「⚡生成建议 / ✓标记已回复 / ⏭跳过消息」
    // 那一整条必须**钉在窗口底部**，不能跟着聊天记录一起滚走。
    // 这里真渲染出来量几何：往 #msgs 塞一堆高行把它撑到能滚，滚到底后底部条的 y 必须一动不动。
    console.log('\n=== 界面渲染 · 底部操作条钉在窗口底部（不跟着聊天记录滚）===');
    const footFixed = await page.evaluate(async () => {
      const msgs = document.getElementById('msgs');
      const foot = document.getElementById('chat-foot');
      const chat = document.getElementById('chat');
      const filler = document.createElement('div');
      for (let i = 0; i < 40; i++) {
        const d = document.createElement('div');
        d.textContent = `填充行 ${i}`;
        d.style.height = '60px';
        d.style.flex = '0 0 auto';
        filler.appendChild(d);
      }
      msgs.appendChild(filler);
      const topBefore = Math.round(foot.getBoundingClientRect().top);
      const chatBottom = Math.round(chat.getBoundingClientRect().bottom);
      msgs.scrollTop = msgs.scrollHeight;
      await new Promise((r) => setTimeout(r, 150));
      const topAfter = Math.round(foot.getBoundingClientRect().top);
      const bottomAfter = Math.round(foot.getBoundingClientRect().bottom);
      const out = {
        canScroll: msgs.scrollHeight - msgs.clientHeight,
        scrolled: Math.round(msgs.scrollTop),
        topBefore,
        topAfter,
        bottomAfter,
        chatBottom,
        chatScrolled: Math.round(chat.scrollTop),
        footVisible: getComputedStyle(foot).display !== 'none',
        msgsOverflowY: getComputedStyle(msgs).overflowY,
      };
      filler.remove();
      msgs.scrollTop = 0;
      return out;
    });
    check('#msgs 自己能滚（消息多了只有这一块滚）',
      footFixed.canScroll > 200 && footFixed.scrolled > 100 && footFixed.msgsOverflowY === 'auto',
      JSON.stringify(footFixed));
    check('滚到底之后底部操作条位置**纹丝不动**',
      footFixed.topBefore === footFixed.topAfter && footFixed.footVisible, JSON.stringify(footFixed));
    check('底部操作条始终贴在中栏底边（没被滚走）',
      Math.abs(footFixed.bottomAfter - footFixed.chatBottom) <= 2, JSON.stringify(footFixed));
    check('中栏整栏不滚动（滚的只有消息区）', footFixed.chatScrolled === 0, JSON.stringify(footFixed));

    // 2026-10-09 用户需求：手动自由翻译「中文→外文」的 3 个情绪版本，除了外文，
    // 每个版本英文下方都要再显示「该版本对应的中文说法」（三种口吻的中文短句各不相同，都要翻）。
    // 这里真渲染一遍（桩 3 个带 zh 的版本），量 DOM 确认：3 张卡、每张都有中文、中文互不相同、
    // 「复制中文」按钮已接线、末尾仍保留「你输入的中文」原句对照。
    console.log('\n=== 界面渲染 · 手动自由翻译：每个情绪版本下方都显示对应中文 ===');
    const ftRendered = await page.evaluate(async () => {
      const inEl = document.getElementById('ft-input');
      const outEl = document.getElementById('ft-out');
      if (!inEl || !outEl) return { missing: true };
      const zhBtn = [...document.querySelectorAll('.ft-mode')].find((b) => b.dataset.mode === 'zh2en');
      if (zhBtn) zhBtn.click();
      inEl.value = '你好，我在厦门';
      inEl.dispatchEvent(new Event('input', { bubbles: true }));
      const realFetch = window.fetch;
      window.fetch = async (url, opts) => {
        if (String(url).includes('/api/translate/free')) {
          return {
            json: async () => ({
              ok: true, provider: 'tikhub', model: 'gpt-4o-mini',
              versions: [
                { tone: '温柔甜', text: "Hi there! I'm in Xiamen, such a lovely place, don't you think?", zh: '你好呀！我在厦门，真是个可爱的地方，你觉得呢？' },
                { tone: '幽默俏皮', text: "Hey! Guess what? I'm lounging in Xiamen, soaking up the good vibes!", zh: '嘿！猜猜看？我正窝在厦门，享受惬意时光呢！' },
                { tone: '克制高冷', text: 'Hello. I am in Xiamen.', zh: '你好，我在厦门。' },
              ],
            }),
          };
        }
        return realFetch(url, opts);
      };
      try { await window.doFreeTranslate(); } finally { window.fetch = realFetch; }
      const cards = [...outEl.querySelectorAll('.ft-ver')];
      return {
        cardCount: cards.length,
        zhCount: cards.filter((c) => (c.querySelector('.ft-ver-zh .ft-zh-body')?.textContent || '').trim()).length,
        zhs: cards.map((c) => (c.querySelector('.ft-ver-zh .ft-zh-body')?.textContent || '').trim()),
        copyZh: cards.filter((c) => c.querySelectorAll('.ft-ver-zh .copy').length > 0).length,
        hasFoot: !!outEl.querySelector('.ft-zh-foot'),
        footHasInput: (outEl.querySelector('.ft-zh-foot .ft-zh-text')?.textContent || '').includes('你好，我在厦门'),
      };
    });
    check('自由翻译·中文→外文：渲染出 3 个情绪版本卡', ftRendered.cardCount === 3, JSON.stringify(ftRendered).slice(0, 220));
    check('自由翻译·中文→外文：每个版本下方都有中文说法（3/3）', ftRendered.zhCount === 3, JSON.stringify(ftRendered.zhs));
    check('自由翻译·中文→外文：三种口吻的中文短句各不相同',
      new Set(ftRendered.zhs).size === 3 && ftRendered.zhs.every((z) => z.length > 0), JSON.stringify(ftRendered.zhs));
    check('自由翻译·中文→外文：每条中文都带「复制中文」按钮', ftRendered.copyZh === 3, `实际 ${ftRendered.copyZh}`);
    check('自由翻译·中文→外文：末尾仍保留「你输入的中文」原句对照',
      ftRendered.hasFoot && ftRendered.footHasInput, JSON.stringify({ foot: ftRendered.hasFoot, input: ftRendered.footHasInput }));

    // 2026-09-29 用户需求：版本信息放「AI 提示词」**左栏最下面的「版本信息」**，
    // 点它右侧才显示全部版本更新内容（上次放错到顶部了，这次按截图红框位置修正）。
    // 2026-09-30：这块界面搬进「全局设置」窗口的「AI 提示词」页签，这里另开一页去量。
    console.log('\n=== 界面渲染 · 版本信息在「AI 提示词」左栏最下面 ===');
    const setPageC = await browser.newPage();
    await setPageC.goto(`http://127.0.0.1:${PORT}/settings.html`, { waitUntil: 'networkidle2' });
    const verPanel = await setPageC.evaluate(async () => {
      // 默认停在「AI 设置」页签，先切到「AI 提示词」
      const tab = document.querySelector('.set-tab[data-tab="prompts"]');
      if (tab) tab.click();
      await new Promise((r) => setTimeout(r, 900));
      const sec = document.getElementById('sec-prompts');
      const tabs = [...document.querySelectorAll('#pr-side .pr-tab')];
      const names = tabs.map((t) => (t.querySelector('.pr-tab-cn')?.textContent || '').trim());
      const last = tabs[tabs.length - 1];
      const meta = {
        anyVisible: !!last,
        lastName: names[names.length - 1] || '',
        lastHasVersion: /版本/.test(last ? last.textContent : ''),
        lastSub: last ? (last.querySelector('.pr-tab-sub')?.textContent || '').trim() : '',
        isLast: (last ? last.dataset.pr : '') === '__version__',
        openBefore: !!(sec && !sec.classList.contains('hidden')),
      };
      if (last) last.click();
      await new Promise((r) => setTimeout(r, 800));
      meta.mainText = document.getElementById('pr-main')?.innerText || '';
      meta.onTab = document.querySelector('#pr-side .pr-tab.on .pr-tab-cn')?.textContent.trim() || '';
      return meta;
    });
    check('「AI 提示词」页签打开了', verPanel.openBefore === true, JSON.stringify(verPanel).slice(0, 80));
    check('左栏最下面一项就是「版本信息」',
      verPanel.isLast && verPanel.lastHasVersion, JSON.stringify(verPanel).slice(0, 120));
    check('点它右侧就显示版本更新内容',
      verPanel.onTab === '版本信息' && /版本/.test(verPanel.mainText), verPanel.mainText.slice(0, 120));
    check('更新内容含版本号（v0.1.2 / v0.1.1…）', /v0\.1\.\d/.test(verPanel.mainText), verPanel.mainText.slice(0, 140));
    check('更新内容描述优化了什么（不是空页）',
      /修复|优化|新增|调整/.test(verPanel.mainText), verPanel.mainText.slice(0, 140));
    // 关掉这一页，免得挡住后面的总截图
    await setPageC.close();

    /* ---- 2026-10-11 中栏页签：通用 / Tele①（Telegram 内置浏览器兜底）----
     * 断言的是「真点了之后 DOM 真的变了」，不是只看 HTML 里有没有那几个字：
     *  ① 两个页签在   ② 默认停在「通用」且消息框撑得起来（包一层 pane 后中栏不能塌）
     *  ③ 点 Tele① 才懒加载 src  ④ 切回「通用」消息框还在  ⑤ 右栏页签没被带着切 */
    console.log('\n=== 界面渲染 · 中栏页签：通用 / Tele①（Telegram 内置浏览器）===');
    const midTabs = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const on = () => document.querySelector('.mtab.on')?.dataset.mp || '';
      const vis = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const tabs = [...document.querySelectorAll('.mtab')].map((b) => ({
        mp: b.dataset.mp, text: (b.textContent || '').trim(),
      }));
      const snap = { tabs, startOn: on(), msgsVisible0: vis('#msgs'), footVisible0: vis('#chat-foot') };

      const t1 = document.querySelector('.mtab[data-mp="tele1"]');
      if (t1) t1.click();
      await sleep(400);
      const list = document.getElementById('tg-list');
      const convBody = document.getElementById('tg-conv-body');
      void list; void convBody;   // v2.6.1093 已改回内置浏览器布局，这两个旧元素不再参与断言
      snap.afterTele = {
        on: on(),
        // v2.6.1093：Tele① = 内置浏览器 + 右侧红框资料面板（旧的 #tg-list / #tg-conv-body 已删）
        hasBrowser: !!document.getElementById('tg-webview'),
        browserVisible: vis('.tele-browser'),
        hasAside: !!document.querySelector('.mid-pane[data-mp="tele1"] .tg-conv-aside'),
        generalHidden: document.querySelector('.mid-pane[data-mp="general"]')?.classList.contains('hidden'),
        telePaneVisible: vis('.mid-pane[data-mp="tele1"]'),
        rightTabStill: document.querySelector('.ptab.on')?.dataset.pt || '',
        // 🔴 v2.6.1093 补回地址栏（老板看图要求）：网址框 + 前往按钮
        addrBar: (() => {
          const bar = document.querySelector('.mid-pane[data-mp="tele1"] .tgb-bar');
          const inp = document.getElementById('tgb-url');
          const btn = document.getElementById('tgb-go');
          const wv = document.getElementById('tg-webview');
          const r = bar ? bar.getBoundingClientRect() : { width: 0, height: 0, top: 0, left: 0 };
          const wr = wv ? wv.getBoundingClientRect() : { top: 0, left: 0 };
          return {
            hasBar: !!bar,
            hasInput: !!inp,
            hasBtn: !!btn,
            btnText: (btn && btn.textContent || '').trim(),
            inputValue: (inp && inp.value) || '',
            // 地址栏必须在 webview 正上方（顶边更靠上）
            barAbove: !!bar && !!wv && r.top <= wr.top,
            barH: Math.round(r.height),
            barW: Math.round(r.width),
            visible: r.width > 100 && r.height > 10,
            // 🔴 v2.6.1098 样式对齐：实测计算样式，锁死 WA① == Tele①
            btnBg: btn ? getComputedStyle(btn).backgroundColor : '',
            btnRadius: btn ? getComputedStyle(btn).borderRadius : '',
            btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
            inputRadius: inp ? getComputedStyle(inp).borderRadius : '',
            barBg: bar ? getComputedStyle(bar).backgroundColor : '',
          };
        })(),
      };

      /* 🔴 v2.6.1094 老板拍板新增「WA①」页签：形态必须与 Tele① 完全对称。 */
      const tw = document.querySelector('.mtab[data-mp="wa1"]');
      if (tw) tw.click();
      await sleep(400);
      snap.afterWa = {
        on: on(),
        hasWebview: !!document.getElementById('wa1-webview'),
        // 🔴 partition 必须与 Tele① 分开，否则两个网页登录态会互相顶掉
        partition: document.getElementById('wa1-webview')?.getAttribute('partition') || '',
        src: document.getElementById('wa1-webview')?.getAttribute('src') || '',
        browserVisible: vis('.mid-pane[data-mp="wa1"] .tele-browser'),
        hasAside: !!document.querySelector('.mid-pane[data-mp="wa1"] .tg-conv-aside'),
        waPaneVisible: vis('.mid-pane[data-mp="wa1"]'),
        teleHidden: document.querySelector('.mid-pane[data-mp="tele1"]')?.classList.contains('hidden'),
        generalHidden: document.querySelector('.mid-pane[data-mp="general"]')?.classList.contains('hidden'),
        rightTabStill: document.querySelector('.ptab.on')?.dataset.pt || '',
        addrBar: (() => {
          const bar = document.querySelector('.mid-pane[data-mp="wa1"] .tgb-bar');
          const inp = document.getElementById('wa1-url');
          const btn = document.getElementById('wa1-go');
          const wv = document.getElementById('wa1-webview');
          const r = bar ? bar.getBoundingClientRect() : { width: 0, height: 0, top: 0 };
          const wr = wv ? wv.getBoundingClientRect() : { top: 0 };
          return {
            hasBar: !!bar, hasInput: !!inp, hasBtn: !!btn,
            btnText: (btn && btn.textContent || '').trim(),
            inputValue: (inp && inp.value) || '',
            barAbove: !!bar && !!wv && r.top <= wr.top,
            visible: r.width > 100 && r.height > 10,
            // 🔴 v2.6.1098 样式对齐：实测计算样式，锁死 WA① == Tele①
            btnBg: btn ? getComputedStyle(btn).backgroundColor : '',
            btnRadius: btn ? getComputedStyle(btn).borderRadius : '',
            btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
            inputRadius: inp ? getComputedStyle(inp).borderRadius : '',
            barBg: bar ? getComputedStyle(bar).backgroundColor : '',
          };
        })(),
        // 右半三个块：客户资料卡 + 三按钮 + 对话信息（跟 Tele① 同一套 .tv-* 类）
        hasProfileCard: !!document.getElementById('wa1-profile-body'),
        hasConvInfo: !!document.getElementById('wa1-convinfo-body'),
        btnTexts: [...document.querySelectorAll('.mid-pane[data-mp="wa1"] .tv-actions .tv-btn')]
          .map((b) => (b.textContent || '').trim()),
        // 红框宽度跟 Tele① 一样是 clamp(300px, 46%, 550px)
        asideFlex: (() => {
          const a = document.querySelector('.mid-pane[data-mp="wa1"] .tg-conv-aside');
          return a ? getComputedStyle(a).flexBasis : '';
        })(),
      };

      const tg0 = document.querySelector('.mtab[data-mp="general"]');
      if (tg0) tg0.click();
      await sleep(400);
      snap.backGeneral = {
        on: on(),
        msgsVisible: vis('#msgs'),
        footVisible: vis('#chat-foot'),
        msgsH: Math.round(document.getElementById('msgs')?.getBoundingClientRect().height || 0),
        teleHidden: document.querySelector('.mid-pane[data-mp="tele1"]')?.classList.contains('hidden'),
      };
      return snap;
    });
    /* 🔴 v2.6.1094 老板拍板新增「WA①」页签后，这里从「两个」改成「三个」。
 *    这条断言本意是验「中栏页签机制正常」（通用在最前、Tele① 紧随），不是验数量上限 ——
 *    所以按名字逐个找，不写死长度。Tele① / WA① 各自的位置也顺带锁住，防以后插页签插错地方。 */
    const tabTexts = midTabs.tabs.map((t) => t.text);
    check('中栏共 8 个页签：通用 / Tele① / Tele② / WA① / WA② / WA③ / WA④ / WA⑤（2026-10-16 复刻 WA①→WA⑤）',
      midTabs.tabs.length === 8
      && tabTexts[0] === '通用' && tabTexts[1] === 'Tele①' && tabTexts[2] === 'Tele②'
      && tabTexts[3] === 'WA①' && tabTexts[4] === 'WA②' && tabTexts[5] === 'WA③'
      && tabTexts[6] === 'WA④' && tabTexts[7] === 'WA⑤',
      JSON.stringify(midTabs.tabs));
    check('默认停在「通用」，消息框和底部操作条都撑得起来（包了 pane 没塌）',
      midTabs.startOn === 'general' && midTabs.msgsVisible0 && midTabs.footVisible0,
      JSON.stringify(midTabs).slice(0, 160));
    check('点「Tele①」渲染应用版原生面板 + 右侧红框资料面板（v2.5.1085 应用版，不再用 webview）',
      !midTabs.afterTele.hasBrowser && midTabs.afterTele.hasAside && midTabs.afterTele.telePaneVisible,
      JSON.stringify(midTabs.afterTele));
    check('切到 Tele①：「通用」收起、Tele① 显示、页签高亮跟着走',
      midTabs.afterTele.on === 'tele1' && midTabs.afterTele.generalHidden === true && midTabs.afterTele.telePaneVisible,
      JSON.stringify(midTabs.afterTele));
    check('切中栏不会把右栏页签一起切了（.mtab 与 .ptab 互不干扰）',
      midTabs.afterTele.rightTabStill !== '', midTabs.afterTele.rightTabStill);
    // 🔴 v2.6.1126 老板改软件版：Tele① 内置浏览器不再需要地址栏（#tgb-url / #tgb-go 已移除）
    const ab = midTabs.afterTele.addrBar || {};
    check('🔴 Tele① 是软件版内置浏览器，不需要地址栏（#tgb-url / #tgb-go 已移除，不再有网页版那套网址框）',
      !ab.hasBar && !ab.hasInput && !ab.hasBtn, JSON.stringify(ab));

    /* 🔴 v2.6.1094 老板拍板新增「WA①」页签 —— 形态必须与 Tele① 完全对称 */
    const aw = midTabs.afterWa || {};
    check('点「WA①」渲染内置浏览器 + 右侧红框资料面板（与 Tele① 同形态）',
      aw.hasWebview && aw.browserVisible && aw.hasAside && aw.waPaneVisible,
      JSON.stringify(aw).slice(0, 200));
    check('切到 WA①：页签高亮跟着走，「通用」和 Tele① 都收起',
      aw.on === 'wa1' && aw.generalHidden === true && aw.teleHidden === true,
      JSON.stringify({ on: aw.on, g: aw.generalHidden, t: aw.teleHidden }));
    // 🔴 v2.6.1095 老板定调「WA① 不要跟一号一样，当成六号 / 另一个数据文件夹」：
    //    partition 从 wa-web-1 改成 wa6（数据夹独立），并加断言锁死
    //    「既不是 Tele① 的分区，也不该带 wa-web-1 这个含'一号'意味的旧名」。
    check('🔴 WA① 的 partition 与 Tele① 分开（两个网页登录态不能互相顶掉）',
      aw.partition === 'persist:wa6' && aw.partition !== 'persist:tg-tele-7',
      `wa=${aw.partition}`);
    check('🔴 WA① 编号段独立成 WA（绝不用一号那个 wa-web-1 分区）',
      aw.partition !== 'persist:wa-web-1', `wa=${aw.partition}`);
    check('WA① 首次点开就自动加载 WhatsApp 网页（不用老板再点一次）',
      /web\.whatsapp\.com/.test(aw.src || ''), `src=${aw.src}`);
    check('WA① 页签下方有地址栏：网址框 + 「前往」按钮（与 Tele① 同形态）',
      aw.addrBar && aw.addrBar.hasBar && aw.addrBar.hasInput && aw.addrBar.hasBtn
      && aw.addrBar.btnText === '前往' && aw.addrBar.barAbove === true && aw.addrBar.visible,
      JSON.stringify(aw.addrBar));
    check('WA① 地址栏默认填 web.whatsapp.com',
      /web\.whatsapp\.com/.test((aw.addrBar && aw.addrBar.inputValue) || ''),
      `value=${JSON.stringify(aw.addrBar && aw.addrBar.inputValue)}`);
    /* 🔴 v2.6.1126：Tele① 已去掉地址栏（软件版），不再与 WA① 比对称。
     *   只锁 WA① 自己的地址栏样式（防止「结构都在、但样式没挂上」的浏览器默认外观）。 */
    const wb = midTabs.afterWa.addrBar || {};
    check('🔴 WA① 地址栏样式：按钮蓝色 #378ADD + 圆角 5px + 高 26px，输入框圆角 5px，条底浅灰',
      wb.btnBg && /55,\s*138,\s*221/.test(wb.btnBg)
        && /^5px$/.test(wb.btnRadius) && wb.inputRadius === wb.btnRadius && /^5px$/.test(wb.inputRadius)
        && wb.btnH === 26 && wb.barBg,
      `wa=${JSON.stringify(wb)}`);
    check('WA① 右半 = 客户资料卡 + 两个按钮（客户档案 / 对话提档）+ 对话信息（复用 Tele① 那套 .tv-*；v2.6.1124 去掉「↗ 跳到聊天」）',
      aw.hasProfileCard && aw.hasConvInfo
      && aw.btnTexts.length === 2
      && /客户档案/.test(aw.btnTexts[0] || '')
      && /对话提档/.test(aw.btnTexts[1] || ''),
      JSON.stringify(aw.btnTexts));
    // 🔴 v2.6.1126：红框宽度用「实际渲染值」判定（getComputedStyle 在大窗口下返回解析后的 px，
    //   不再死磕 clamp 文本）。WA① 走通用规则 flex:0 0 clamp(300px,46%,550px)，解析后必落在 240~560px。
    check('WA① 红框为弹性宽度（规则 clamp(300px,46%,550px)，实际渲染落在 240~560px）',
      (() => { const v = aw.asideFlex || ''; if (/clamp/.test(v)) return /clamp\(/.test(v); const n = parseFloat(v); return n >= 240 && n <= 560; })(),
      `flexBasis=${aw.asideFlex}`);
    check('切 WA① 不会把右栏页签一起切了（.mtab 与 .ptab 互不干扰）',
      (aw.rightTabStill || '') !== '', aw.rightTabStill);

    check('切回「通用」：消息框有高度、底部操作条还在',
      midTabs.backGeneral.on === 'general' && midTabs.backGeneral.msgsVisible
      && midTabs.backGeneral.msgsH > 100 && midTabs.backGeneral.footVisible,
      JSON.stringify(midTabs.backGeneral));

    /* 🔴 2026-10-16 复刻 WA①→WA⑤：WA②~WA⑤ 必须与 WA① 形态完全对称（同结构、独立分区）。
     *   这里只查 DOM 结构（不点开、不触发懒加载），锁死五个页签「骨架一致」。 */
    const waParity = await page.evaluate(() => {
      const PANES = [
        { mp: 'wa1', partition: 'persist:wa6' },
        { mp: 'wa2', partition: 'persist:wa7' },
        { mp: 'wa3', partition: 'persist:wa8' },
        { mp: 'wa4', partition: 'persist:wa9' },
        { mp: 'wa5', partition: 'persist:wa10' },
      ];
      return PANES.map((p) => {
        const pane = document.querySelector('.mid-pane[data-mp="' + p.mp + '"]');
        const wv = pane ? pane.querySelector('webview') : null;
        const btns = pane ? [...pane.querySelectorAll('.tv-actions .tv-btn')].map((b) => (b.textContent || '').trim()) : [];
        return {
          mp: p.mp,
          hasPane: !!pane,
          webviewId: wv ? wv.id : '',
          partition: wv ? wv.getAttribute('partition') : '',
          hasProfileCard: !!(pane && pane.querySelector('.tv-body')),
          hasConvInfo: !!(pane && pane.querySelector('.tv-conv-body')),
          btnCount: btns.length,
          hasArchive: btns.some((t) => /客户档案/.test(t)),
          hasExtract: btns.some((t) => /对话提档/.test(t)),
          expectPartition: p.partition,
        };
      });
    });
    const waParityOk = waParity.every((p) =>
      p.hasPane && p.webviewId === p.mp + '-webview' && p.partition === p.expectPartition
      && p.hasProfileCard && p.hasConvInfo && p.btnCount === 2 && p.hasArchive && p.hasExtract);
    check('WA①~WA⑤ 五个页签骨架一致（各自独立 webview + 资料卡 + 对话信息 + 客户档案/对话提档两按钮 + 独立分区）',
      waParityOk, JSON.stringify(waParity));
    // 抽查两个非首屏页签的 partition 绝对不能串到别的分区
    const wa2 = waParity.find((p) => p.mp === 'wa2');
    const wa5 = waParity.find((p) => p.mp === 'wa5');
    check('🔴 WA② 分区是 persist:wa7、WA⑤ 分区是 persist:wa10（五个网页登录态互不顶掉）',
      wa2 && wa2.partition === 'persist:wa7' && wa5 && wa5.partition === 'persist:wa10',
      JSON.stringify({ wa2: wa2 && wa2.partition, wa5: wa5 && wa5.partition }));

    /* ---- 2026-10-11 老板看图纠正：翻译面板**不在右栏**，改到中栏 Tele① 内 ----
       老板原话「错了，对话翻译不是在那个位置，看图（红框）…这个翻译是针对 telegram」。
       所以这里断言的是**新位置**：右栏只剩两个页签，翻译面板在 .mid-pane[data-mp="tele1"] 里。
       v2.5.1085 起改为**原生会话列表 + 气泡**（数据来自 MTProto 落库，不再加载 web.telegram.org 网页）。 */
    console.log('\n=== 界面渲染 · 右栏已去掉「对话翻译」+ Tele① 内的 Telegram 原生面板（v2.5.1085 应用版） ===');
    const conv = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const snap = {};
      snap.tabs = [...document.querySelectorAll('.ptab')].map((b) => ({
        pt: b.dataset.pt, text: (b.textContent || '').trim(),
      }));
      snap.hasConvTab = !!document.querySelector('.ptab[data-pt="conv"]');
      snap.hasConvPane = !!document.querySelector('.pbody[data-pb="conv"]');

      // v2.6.1093：Tele① 改回**内置浏览器**布局 —— 左侧 <webview> + 右侧红框资料面板
      const mt = document.querySelector('.mtab[data-mp="tele1"]');
      if (mt) mt.click();
      await sleep(900);
      const pane = document.querySelector('.mid-pane[data-mp="tele1"]');
      snap.paneVisible = !!pane && !pane.classList.contains('hidden');
      snap.hasBrowser = !!(pane && pane.querySelector('#tg-webview'));
      snap.browserVisible = !!(pane && pane.querySelector('.tele-browser'));
      snap.hasAside = !!(pane && pane.querySelector('.tg-conv-aside'));
      snap.asideWidth = (() => {
        const a = pane && pane.querySelector('.tg-conv-aside');
        if (!a) return 0;
        try { return Math.round(a.getBoundingClientRect().width); } catch (e) { return 0; }
      })();
      snap.webviewSrc = (pane && pane.querySelector('#tg-webview')?.getAttribute('src')) || '';
      snap.webviewPartition = (pane && pane.querySelector('#tg-webview')?.getAttribute('partition')) || '';
      // 切回「通用」，收尾
      const g = document.querySelector('.mtab[data-mp="general"]');
      if (g) g.click();
      await sleep(300);
      snap.backOn = document.querySelector('.mtab.on')?.dataset.mp || '';
      return snap;
    });
    check('右栏只剩两个页签（「对话翻译」已按老板要求删掉）',
      conv.tabs.length === 2 && conv.tabs[0].pt === 'lib' && conv.tabs[1].pt === 'ft' && !conv.hasConvTab && !conv.hasConvPane,
      JSON.stringify(conv.tabs) + ` hasConvTab=${conv.hasConvTab}`);
    check('Tele① 是应用版原生面板，无 <webview> 内置浏览器（v2.5.1085 老板拍板，数据走本地库）',
      !conv.hasBrowser && conv.paneVisible && conv.hasAside, JSON.stringify(conv).slice(0, 180));
    check('应用版不加载 telegram.org 网页（无 webview src 可指）',
      conv.webviewSrc === '', conv.webviewSrc);
    check('应用版无 webview，不需要独立 partition',
      conv.webviewPartition === '', conv.webviewPartition);
    check('右侧红框资料面板还在（老板 2026-10-13 拍板原地不动）',
      conv.hasAside && conv.asideWidth > 200, `hasAside=${conv.hasAside} width=${conv.asideWidth}`);
    // 🔴 v2.6.1093 老板看图要求（QQ20261013-133048.png）：红框原来写死 300px，
    //    要改成「窗口越宽越宽、主窗口最大化时 = 550px」。这里锁死 CSS 规则本身，
    //    真实像素宽度由 .tmp 一次性实测脚本核过（1280→300 / 1920→550 / 2560→550）。
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
    const asideRule = (cssSrc.match(/\.tg-conv-aside \{[^}]*\}/) || [''])[0];
    check('红框不再写死 300px（改成 clamp 弹性宽度）',
      !/flex:\s*0\s*0\s*300px/.test(asideRule), asideRule.slice(0, 70));
    check('红框宽度规则：clamp(下限, 中段, 上限) 弹性宽度（下限<上限，随窗口变宽）',
      /clamp\(\s*\d+px\s*,\s*[\d.]+(vw|%)\s*,\s*\d+px\s*\)/.test(asideRule), asideRule.slice(0, 90));
    check('切回「通用」正常', conv.backOn === 'general', conv.backOn);
    const appjsSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    check('前端原生函数齐全（loadTgConversations/renderTgConvList/selectTgConv/loadTgChat/renderTgChat/onTelegramMessageLive）',
      /function loadTgConversations/.test(appjsSrc) && /function renderTgConvList/.test(appjsSrc)
      && /function selectTgConv/.test(appjsSrc) && /function loadTgChat/.test(appjsSrc)
      && /function renderTgChat/.test(appjsSrc) && /function onTelegramMessageLive/.test(appjsSrc),
      'app.js 原生 Tele① 函数');
    check('地址栏函数齐全（tgGoto / initTgAddrBar · v2.6.1093 老板要求补回）',
      /function tgGoto/.test(appjsSrc) && /function initTgAddrBar/.test(appjsSrc),
      'app.js 地址栏函数');
    check('v2.5.1085 原生面板的死代码仍不在（renderTgwState/tgwProbe/tgwPages/loadTgWebview/setTgWebviewProxy）',
      !/function renderTgwState/.test(appjsSrc) && !/async function tgwProbe/.test(appjsSrc)
      && !/async function tgwPages/.test(appjsSrc) && !/function loadTgWebview/.test(appjsSrc)
      && !/function setTgWebviewProxy/.test(appjsSrc), 'app.js 死代码已清');
    check('前端从库取数：调用 /api/telegram/conversations 与 /api/telegram/messages',
      appjsSrc.includes('/api/telegram/conversations') && appjsSrc.includes('/api/telegram/messages'), 'app.js 接口调用');
    const srvSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
    check('后端暴露 /api/telegram/conversations 与 /api/telegram/messages',
      /api\/telegram\/conversations/.test(srvSrc) && /api\/telegram\/messages/.test(srvSrc), 'src/server.js');
    const dbSrc = fs.readFileSync(path.join(ROOT, 'src', 'db.js'), 'utf8');
    check('DB 层有 tgConversations / tgMessages',
      /function tgConversations/.test(dbSrc) && /function tgMessages/.test(dbSrc), 'src/db.js');
    // 🔴 铁律：绝不自动发送。真实含义 = 「没有任何定时器/轮询会自己去调发送接口」。
//    注意：app.js 里存在 tgSend()（点按钮才走的手动发送），它不等于自动发送；
//    这里要盯的是「有没有被 setInterval / setTimeout 自动调度」。
const tgGotoBody = (appjsSrc.match(/function tgGoto\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
const autoSend = [
  /setInterval\([^)]*tgSend/,
  /setTimeout\([^)]*tgSend/,
  /setInterval\([^)]*sendMessage/,
  /setInterval\([^)]*sendFile/,
  /requestAnimationFrame\([^)]*tgSend/,
];
check('铁律没破：绝无自动发送（发送函数不得被任何定时器/循环自动调度）',
      !autoSend.some((re) => re.test(appjsSrc))
      // 有发送接口调用的话，必须同时存在 tgSend 这类"显式按钮入口"，且被按钮绑定
      && (appjsSrc.includes('/api/telegram/send') === /function tgSend/.test(appjsSrc)),
      '无自动调度发送');
    check('铁律没破：应用版地址栏已删，tgGoto 是空壳、不触发任何发送',
      /function tgGoto/.test(appjsSrc) && !/send|api\(/i.test(tgGotoBody),
      'tgGoto 不含发送逻辑');

    // 收尾：还原打桩、弹窗关掉、方式恢复到「手动」（免得影响后面的截图）
    await page.evaluate(() => {
      window.fetch = window.__origFetch;
      localStorage.setItem('bee.trMode', 'manual');
      closeTranslateModal();
    });

    fs.mkdirSync(path.join(ROOT, 'preview'), { recursive: true });
    const shot = path.join(ROOT, 'preview', '界面自检.png');
    await page.screenshot({ path: shot });
    console.log(`\n截图：${shot}`);

    /* ---- v2.6.1093：贴译文的前端取字段必须是 body_zh（下划线），不是 bodyZh ----
       老板问「气泡翻译能用吗」查出来的真 bug：tgPaintOnce 里写的是 m.bodyZh，
       而后端 withTranslationState() 是 `...m` 展开原样返回 body_zh，
       api() 只做 res.json() 零转换 → bodyZh 永远 undefined → 译文一块都贴不上。
       项目里其它 20 多处一律读 body_zh，这处写驼峰 = 译文链路直接断。 */
    console.log('\n--- v2.6.1093 贴译文取字段必须是 body_zh ---');
    const appJsTxt = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    check('tgPaintOnce 读的是 body_zh 不是 bodyZh（后端就返回这个）',
      /const zh = String\(\(m && \(m\.body_zh \|\| m\.bodyZh\)\) \|\| ''\)\.trim\(\)/.test(appJsTxt),
      'tgPaintOnce 的 zh 取值写法不对');
    check('paint 请求体仍按 { mid, zh } 组装（后端 paintBubbles 认这个结构）',
      /rows\.push\(\{ mid, zh \}\)/.test(appJsTxt), 'rows.push 结构变了');
    check('没有残留的裸 m.bodyZh 取值（那种写法取不到值）',
      !/\(m && m\.bodyZh\)/.test(appJsTxt), '还有地方在裸读 bodyZh');
    check('贴译文前先判 Tele① 面板可见（不在看不见的页面白烧 token）',
      /\.mid-pane\[data-mp="tele1"\]/.test(appJsTxt) && /classList\.contains\('hidden'\)/.test(appJsTxt),
      '缺可见性判断');

    console.log(`\n========== 界面自检：${pass} 通过 / ${fail} 失败 ==========`);
    if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  } catch (e) {
    console.error('\n[致命错误] 界面自检中断：', e);
    fail++;
  } finally {
    try { await browser.close(); } catch (e) {}
    try { srv.server.close(); } catch (e) {}
    try { if (db.db && db.db.close) db.db.close(); } catch (e) {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();
