/**
 * 一次性截图工具：把「客户档案」弹窗（含 6 核心字段 + 10 附加字段）拍下来，
 * 方便肉眼确认排版（生活规律 / 家庭经济情况 是否独占一行）、标题上的文件路径。
 *
 * 做法：打开 preview/蜜蜂信息采集_界面预览.html（真实 style.css + app.js 内联），
 * 直接调界面自己的 openProfileModal()，稳定后再截图。
 *
 * 运行：node tools/shot_profile_modal.js
 */

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const PREVIEW = path.join(ROOT, 'preview', '蜜蜂信息采集_界面预览.html');
const OUT = path.join(ROOT, 'preview', '界面_客户档案弹窗.png');

(async () => {
  if (!fs.existsSync(PREVIEW)) {
    console.error('找不到预览文件，先跑：python preview/make_preview.py');
    process.exit(1);
  }
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page.goto('file://' + PREVIEW.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1200));

  // 直接开弹窗，喂一份带附加字段的档案（预览里的假后端有 1A00012）
  // 注：app.js 里 state / openProfileModal 是 classic script 的顶层声明，
  //     能用裸名字访问，但**不是** window 的属性，别写 window.state。
  const code = await page.evaluate(() => {
    const list = (typeof state !== 'undefined' && state.customers) || [];
    const pick = list.find((c) => c.code === '1A00012') || list[0];
    if (!pick) return null;
    // 预览里会自动弹一个「翻译建议」演示弹窗，先关掉，别挡住档案弹窗
    const tr = document.getElementById('tr-modal');
    if (tr) tr.classList.add('hidden');
    const sim = document.getElementById('sim-panel');
    if (sim) sim.classList.add('hidden');
    openProfileModal(pick.code);
    return pick.code;
  });
  await new Promise((r) => setTimeout(r, 900));
  // 再兜一次：演示弹窗可能在初始化后才弹出来
  await page.evaluate(() => {
    const tr = document.getElementById('tr-modal');
    if (tr) tr.classList.add('hidden');
  });
  await new Promise((r) => setTimeout(r, 300));

  const box = await page.evaluate(() => {
    const m = document.querySelector('#pf-modal .pf-box') || document.querySelector('#pf-modal');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box) {
    console.error('弹窗没打开');
    await browser.close();
    process.exit(1);
  }
  await page.screenshot({
    path: OUT,
    clip: {
      x: Math.max(0, box.x - 8),
      y: Math.max(0, box.y - 8),
      width: Math.min(1280, box.width + 16),
      height: Math.min(900, box.height + 16),
    },
  });
  await browser.close();
  console.log('已生成：', OUT, '客户编号：', code);
})().catch((e) => {
  console.error('截图失败：', e && e.message);
  process.exit(1);
});
