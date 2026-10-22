/* 只读验证：用真实 Electron 跑一遍启动窗（electron/splash.js），
 * 逐步推真实启动步骤 → 截图 → 收尾，确认 800×550 + 机器人图 + 进度算法在真实环境正常。
 * 不碰数据库、不起后端、不写任何产品数据。 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const Splash = require('../electron/splash');

const OUT = path.resolve(__dirname, '..', 'preview');
const STEPS = [
  '准备启动后端内核（src/main.startCore —— 数据库 / 采集模块都在这里加载）',
  '清理历史空消息与假号码',
  '校验知识库与 AI 配置',
  '生成浏览器插件连接令牌',
  '创建本地 HTTP 服务',
  '启动图片延时重抓',
  '启动器预热（Signal S1~S3）',
  '加载 Telegram 登录/登出控制器',
  '后端内核已就绪',
  '准备加载主窗口页面',
  '主窗口已创建',
  '桌面内核启动完成，主窗口已交出来',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  Splash.createSplash();
  await sleep(900);

  const win = BrowserWindow.getAllWindows()[0];
  const size = win ? win.getSize() : null;

  let expect = 0;
  for (const s of STEPS) {
    expect += 1;
    Splash.addStep(s);
    await sleep(110);
    const got = await win.webContents.executeJavaScript("document.querySelectorAll('#list .step').length");
    console.log('step', expect, 'rows', got);
  }
  // 让时间曲线往前走，模拟「等待主窗口页面加载」那段最长的时间
  await sleep(3000);

  const probe = async () => win.webContents.executeJavaScript(`(function(){
    var b = document.getElementById('bar');
    var img = document.querySelector('.art img');
    return {
      pct: document.getElementById('pct').textContent,
      barWidth: b.style.width,
      imgLoaded: !!(img && img.complete && img.naturalWidth > 0),
      imgNatural: img ? (img.naturalWidth + 'x' + img.naturalHeight) : null,
      rows: document.querySelectorAll('#list .step').length,
      texts: Array.prototype.map.call(document.querySelectorAll('#list .step span:last-child'), function(e){return e.textContent;}),
      bodyScroll: [document.body.scrollWidth, document.body.scrollHeight],
      viewport: [window.innerWidth, window.innerHeight]
    };
  })()`);

  const p1 = await probe();
  const img1 = await win.capturePage();
  fs.writeFileSync(path.join(OUT, '_splash_real_mid.png'), img1.toPNG());

  Splash.done();
  await sleep(600);
  const p2 = await win.webContents.executeJavaScript(
    `({ pct: document.getElementById('pct').textContent, state: document.getElementById('state').textContent, bar: document.getElementById('bar').style.width })`);

  console.log('WINDOW_SIZE =', JSON.stringify(size));
  console.log('MID  =', JSON.stringify(p1));
  console.log('DONE =', JSON.stringify(p2));
  app.exit(0);
});
