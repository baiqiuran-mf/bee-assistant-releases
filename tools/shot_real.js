/**
 * 真实启动界面截图（给"我的界面怎么和截图不一样"这个问题用）
 *
 * 之前的 preview/界面自检.png 是【测试用假数据】渲染的：5 个假账号、假客户、
 * 假未读。你真机上打开时库里可能一个未读都没有，于是 ①②③④⑤ 整排不显示、
 * 「待处理 0」、消息左边没有数字 —— 看起来就像"不是同一个界面"。
 *
 * 这个脚本连【真实数据库】渲染三张图：
 *   preview/界面_真实启动.png      你现在打开就是这个样子（真实数据，不注入任何假数据）
 *   preview/界面_有新消息.png      注入几条演示新消息后的样子（红点圈数字、今日消息、待处理都出来）
 *   preview/界面_客户档案弹窗.png  点中栏客户名右边的「客户档案」按钮后的弹窗长什么样
 *
 * 只读渲染：不写数据库、不起 WhatsApp、不调 AI。
 *
 * 跑法：node --experimental-sqlite tools/shot_real.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// 明确指向真实数据目录（不设 BEE_DATA_DIR 时也默认是它，这里写死更安心）
const REAL_DATA = path.join(ROOT, 'data');
process.env.BEE_DATA_DIR = REAL_DATA;

const db = require('../src/db');
const { createServer } = require('../src/server');
const { loadConfig } = require('../src/main');

(async () => {
  const cfg = loadConfig();

  // 真实账号状态（不连 WhatsApp，直接报 offline；顶栏那五个灯按真实配置来）
  const accounts = (cfg.accounts || []).map((a) => ({
    id: a.id,
    label: a.label || `账号${a.id}`,
    enabled: !!a.enabled,
    status: 'offline',
    proxy: a.proxy || '',
  }));

  const srv = createServer(
    {
      db,
      doc: require('../src/customerDoc'),
      ai: require('../src/ai'),
      knowledge: require('../src/knowledge'),
      cfg,
      getAccountStates: () => accounts,
    },
    0
  );
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const outDir = path.join(ROOT, 'preview');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 820 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1500));

    // ---- 第一张：真实启动状态，什么都不注入 ----
    const real = await page.evaluate(() => ({
      customers: (state.customers || []).length,
      rowNums: document.querySelectorAll('#list-body .cust .row-num').length,
      pending: document.querySelector('#pending')?.textContent.trim() || '',
      build: document.querySelector('#build')?.textContent.trim() || '',
    }));
    await page.screenshot({ path: path.join(outDir, '界面_真实启动.png') });
    console.log('真实启动：', JSON.stringify(real));

    // ---- 第二张：注入演示新消息（只改页面内存，不写数据库） ----
    await page.evaluate(() => {
      const base = Date.now() - 3 * 60 * 1000;
      state.customers = [
        { code: '1A00001', name: 'Dio（演示）', account_id: 1, unread: 2, pending: 1, region: '俄勒冈', timezone: 'America/Los_Angeles', stage_day: 3, mood: '有兴趣', created_at: new Date(Date.now() - 2 * 86400000).toISOString() },
        { code: '2A00001', name: 'Noah（演示）', account_id: 2, unread: 1, pending: 1, region: '澳大利亚', timezone: 'Australia/Sydney', stage_day: 5 },
        // 这条演示「已看还没回」：数字应该是绿色（处理完才消失）
        { code: '3A00001', name: 'Robert（演示）', account_id: 3, unread: 0, pending: 1, region: '美国', timezone: 'America/New_York', stage_day: 4 },
      ];
      state.activeCode = '1A00001';
      // 把中栏客户名 + 档案条也画出来（加入时间=红、客户当地时间=绿、地区=紫）
      renderChatHead(state.customers[0], {});
      state.messages = [
        { id: 9001, direction: 'in', processed: 0, msg_ts: new Date(base).toISOString(), body: 'Hi Sherry, I found a photo of my barn cat. Can you paint it?', body_zh: '你好 Sherry，我找到一张我家谷仓猫的照片，你能画它吗？' },
        { id: 9002, direction: 'in', processed: 0, msg_ts: new Date(base + 60000).toISOString(), body: 'It is 16x20 inches, the wall above the sofa.', body_zh: '沙发上方那面墙，16x20 英寸。' },
        { id: 9003, direction: 'out', processed: 1, msg_ts: new Date(base + 120000).toISOString(), body: 'Sure, send it over and I will take a look.' },
        { id: 9004, direction: 'in', processed: 0, msg_ts: new Date(base + 180000).toISOString(), body: 'Great, I will send it tonight.', body_zh: '好的，我今晚发给你。' },
      ];
      paintCustomers();
      renderMessages(state.messages);
      // 左栏「今日消息」提示窗也跟着演示数据走
      const dd = new Date();
      const z = (n) => String(n).padStart(2, '0');
      renderToday({
        date: `${dd.getFullYear()}-${z(dd.getMonth() + 1)}-${z(dd.getDate())}`,
        received: 7, handled: 4, todo: 3, sent: 2, byAccount: { 1: 4, 2: 2, 3: 1 },
      });
      // 顶栏「待处理」也跟着演示数据走，否则截图里会显示 0，对不上
      const pendEl = document.querySelector('#pending');
      pendEl.textContent = '待处理 3';
      pendEl.className = 'pending';
    });
    await new Promise((r) => setTimeout(r, 600));
    const demo = await page.evaluate(() => ({
      redRowNums: document.querySelectorAll('#list-body .cust .row-num.red').length,
      circs: [...document.querySelectorAll('#list-body .cust .row-num')].map((e) => e.textContent.trim()),
      today: document.querySelector('#today-box')?.textContent.replace(/\s+/g, ' ').trim() || '',
      docBtns: document.querySelectorAll('#chat-head .ch-doc-col button').length,
    }));
    await page.screenshot({ path: path.join(outDir, '界面_有新消息.png') });
    console.log('演示状态：', JSON.stringify(demo));

    // ---- 第三张：点中栏头部右端「客户档案」之后的弹窗 ----
    await page.evaluate(() => {
      document.querySelector('#pf-title').textContent = '客户档案 · Dio（演示）';
      renderProfile({
        customer: {
          code: '1A00001', name: 'Dio（演示）', created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
          region: '俄勒冈', timezone: 'America/Los_Angeles', stage_day: 3, phone: '+15419000088',
        },
        duplicates: [],
        docFile: null,
      });
      document.querySelector('#pf-modal').classList.remove('hidden');
    });
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(outDir, '界面_客户档案弹窗.png') });
    console.log('档案弹窗：已生成');

    console.log('\n已生成：');
    console.log('  ' + path.join(outDir, '界面_真实启动.png'));
    console.log('  ' + path.join(outDir, '界面_有新消息.png'));
    console.log('  ' + path.join(outDir, '界面_客户档案弹窗.png'));
  } finally {
    await browser.close();
    srv.server.close();
  }
  process.exit(0);
})().catch((e) => {
  console.error('截图失败：', e);
  process.exit(1);
});
