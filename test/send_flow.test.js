/**
 * 发送链路自检（2026-09-28 新增，2026-09-29 改：不再整页刷新）
 *
 * 1) 编排台点「发送」：**零整页刷新**地把文字放进输入框 ——
 *    · 有电话 → 用 WhatsApp 内部 Store 把该客户的会话置顶（`openChatByJid`），再填文字；
 *    · 置顶不成 / 没电话 → 兜底把文字塞进**当前最前面**那个对话的输入框。
 *    **绝不再用 page.goto('/send?phone=…')** —— 那是一次整页重载，用户看到的就是
 *    "发个信息网页就刷新了"，也正是 2026-09-29 用户报的那条 bug。
 *    两条路都**绝不按回车**（红线：软件不能替用户发出去）。
 * 2) 我在 WhatsApp 网页版发出的消息，必须进主窗口中间栏目：
 *    - 那个客户正被选中 → 直接出现在对话里；
 *    - 那个客户没被选中 → 中间栏目跟过去（用户 2026-09-28 要求）。
 *
 * 跑法：node --experimental-sqlite test/send_flow.test.js
 * 全程数据隔离（.tmp-test-data/send_flow.test），不碰真实 data/ 与 config.yaml。
 */

const fs = require('fs');
const path = require('path');

const { DIR: DATA_DIR } = require('./_isolate.js');
const DB = path.join(DATA_DIR, 'assistant.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);

const { startCore, prefillIntoPage } = require('../src/main');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + String(extra).slice(0, 200) : ''}`); }
}

/* ---------- 假 page：模拟 puppeteer 的 Page，只实现 prefill 用到的三件事 ---------- */
function fakePage(opt = {}) {
  const log = { navs: [], opened: '', evaluates: 0, inserted: '', focused: false };
  let boxText = opt.boxText || '';   // 「输入框里现在有什么」
  const page = {
    async bringToFront() { log.focused = true; },
    // 万一代码里还有整页导航，这里会记下来 —— 断言里要保证这个数组永远是空的
    async goto(url) { log.navs.push(String(url)); if (opt.gotoThrows) throw new Error('导航失败'); },
    async evaluate(fn, arg) {
      log.evaluates++;
      // 这里不真的执行浏览器里的函数，而是按「假浏览器的设定」回答三类问题：
      const src = String(fn);
      // openChatByJid：按 JID 在会话列表里找这个客户
      if (/Store/.test(src) && /Chat/.test(src) && /openChatByWid|chat\.open/.test(src)) {
        log.opened = String(arg || '');
        return opt.chatExists !== false;
      }
      // inputHasText：框里有没有这句话
      if (/contenteditable/.test(src) && /indexOf/.test(src)) {
        return boxText.indexOf(String(arg || '').slice(0, 12)) >= 0;
      }
      // typeIntoInput：塞进去
      if (/insertText/.test(src)) {
        if (!opt.hasBox) return false;
        if (opt.insertFails) return false;
        log.inserted = String(arg || '');
        boxText = log.inserted;
        return boxText.trim().length > 0;
      }
      return false;
    },
  };
  return { page, log };
}

(async () => {
  /* ================= 1. 发送 = 预填（零刷新，不自动发） ================= */
  console.log('\n=== 发送 · 有电话时按号码置顶会话并预填（零整页刷新） ===');
  {
    const { page, log } = fakePage({ chatExists: true, hasBox: true });
    const body = "Hi Mike, here's the painting 🎨";
    const r = await prefillIntoPage(page, '+15418010646', body, 1);
    check('预填成功 ok=true（实务 method 走 typed：前端据此提示「确认是这个客户」）', r.ok === true, JSON.stringify(r));
    check('★ 全程零整页导航（不再刷新 WhatsApp 网页）', log.navs.length === 0, JSON.stringify(log.navs));
    check('按号码定位到这位客户的会话（E164@c.us）',
      log.opened === '15418010646@c.us', log.opened);
    check('窗口被拉到最前面（用户回车就能发）', log.focused === true);
    check('文字进了输入框（不是按回车发出去）', log.inserted === body, log.inserted);
    check('emoji 原样保留（没被转义坏）', /🎨/.test(log.inserted), log.inserted);
  }

  console.log('\n=== 发送 · 会话没定位到 → 退回当前对话（并在界面上提示核对） ===');
  {
    const { page, log } = fakePage({ chatExists: false, hasBox: true });
    const r = await prefillIntoPage(page, '+15418010646', 'Fallback line 🐱', 2);
    check('置顶不成也 ok=true（否则用户就完全发不出去了）', r.ok === true, JSON.stringify(r));
    check('但 method 明确标成 typed（前端会提示"确认是这个客户"）', r.method === 'typed', r.method);
    check('依然零整页导航', log.navs.length === 0, JSON.stringify(log.navs));
    check('真的把那段英文塞进了输入框', log.inserted === 'Fallback line 🐱', log.inserted);
    check('emoji 原样保留（没被转义坏）', /🐱/.test(log.inserted), log.inserted);
  }

  console.log('\n=== 发送 · 没电话也能塞进当前对话 ===');
  {
    const { page, log } = fakePage({ hasBox: true });
    const r = await prefillIntoPage(page, '', 'No phone line', 1);
    check('没电话也 ok=true', r.ok === true && r.method === 'typed-no-phone', JSON.stringify(r));
    check('没有电话就不去翻会话列表', log.opened === '', log.opened);
    check('依然零整页导航', log.navs.length === 0, JSON.stringify(log.navs));
    check('文字照样进了输入框', log.inserted === 'No phone line', log.inserted);
  }

  console.log('\n=== 发送 · 两条路都不成 → 明确失败（前端才会退回剪贴板） ===');
  {
    const { page } = fakePage({ hasBox: false });
    const r = await prefillIntoPage(page, '+15418010646', 'x', 1);
    check('没输入框 → ok=false', r.ok === false && r.method === 'none', JSON.stringify(r));
    check('给出失败原因', !!r.reason, JSON.stringify(r));
    const r2 = await prefillIntoPage(null, '+15418010646', 'x', 1);
    check('连页面都没有 → ok=false', r2.ok === false, JSON.stringify(r2));
  }

  /* ================= 2. 我发出去的消息要进中间栏目 ================= */
  console.log('\n=== 主窗口 · 我在网页版发出的消息进中间栏目 ===');
  const core = await startCore({ port: 8979, startWhatsApp: false });
  const base = `http://127.0.0.1:${core.PORT}`;
  const J = { 'Content-Type': 'application/json' };
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: J, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const mk = async (ident, name) => (await post('/api/manual', {
    ident, name, region: '俄勒冈', accountId: 1, body: 'hi there',
  })).body;
  const c1 = await mk('+15418017771', '甲客户');
  const c2 = await mk('+15418017772', '乙客户');
  const code1 = c1.customer?.code || c1.code;
  const code2 = c2.customer?.code || c2.code;
  check('两个客户都建好了', !!code1 && !!code2 && code1 !== code2, `${code1} / ${code2}`);

  let hasPuppeteer = true;
  try { require.resolve('puppeteer'); } catch (e) { hasPuppeteer = false; }

  if (!hasPuppeteer) {
    console.log('  [跳过] 没装 puppeteer，跳过界面部分（不影响其它断言）');
  } else {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 820 });
      await page.goto(`${base}/`, { waitUntil: 'networkidle2' });
      await new Promise((r) => setTimeout(r, 1200));

      const sendOut = async (phone, name, body) => post('/api/dev/simulate', {
        accountId: 1, phone, name, direction: 'out', body,
      });
      const midText = () => page.evaluate(() => document.getElementById('msgs')?.innerText || '');
      const active = () => page.evaluate(() => (typeof state !== 'undefined' ? state.activeCode : null));

      // ① 正看着甲：我回甲 → 直接出现在中间栏目
      await page.evaluate((c) => openCustomer(c), code1);
      await new Promise((r) => setTimeout(r, 700));
      const before1 = await midText();
      await sendOut('+15418017771', '甲客户', 'Yes! just finished this painting for you 🎨');
      await new Promise((r) => setTimeout(r, 1400));
      const after1 = await midText();
      check('看着甲时，我发给甲的消息直接出现在中间栏目',
        /just finished this painting/.test(after1) && after1.length > before1.length,
        after1.slice(-120));
      check('中间栏目还是甲（没有被切走）', (await active()) === code1, await active());

      // ② 还看着甲：我回乙 → 中间栏目跟过去，显示乙和我发的那条
      await sendOut('+15418017772', '乙客户', 'Sure, sending you two size options now');
      await new Promise((r) => setTimeout(r, 1400));
      const after2 = await midText();
      check('我发给「没选中的客户」时，中间栏目跟着切过去', (await active()) === code2, await active());
      check('切过去后中间栏目里就有我刚发的那条',
        /two size options/.test(after2), after2.slice(-160));

      // ③ 客户发来的消息不自动切（保持既有规则）
      await page.evaluate((c) => openCustomer(c), code1);
      await new Promise((r) => setTimeout(r, 700));
      await post('/api/dev/simulate', {
        accountId: 1, phone: '+15418017772', name: '乙客户', direction: 'in', body: 'thanks! how much?',
      });
      await new Promise((r) => setTimeout(r, 1400));
      check('客户发来的消息【不】自动切换中间栏目（沿用既有规则）',
        (await active()) === code1, await active());
    } finally {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
  }

  try { core.srv.close(); } catch (e) { /* ignore */ }

  console.log(`\n[发送链路自检] 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('[发送链路自检] 异常：', e);
  process.exit(1);
});
