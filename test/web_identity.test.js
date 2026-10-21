/**
 * WA① 浏览器身份（UA）测试 —— v2.6.1097
 * ---------------------------------------------------------------------------
 * 背景（真实事故）：WA① 内置 webview 打开 web.whatsapp.com 弹「更新 Google Chrome」页。
 *   1096 那版想的是"渲染进程里 setAttribute('useragent')"，但那**对已建好的 guest 无效**
 *   （`<webview partition="persist:wa6" src="">` 是静态写在 HTML 里的，元素一挂进 DOM，
 *   guest 的 UA 就定死了）→ 弹窗照旧。
 *   本版正解：主进程 `session.fromPartition('persist:wa6').setUserAgent(纯 Chrome UA)`，
 *   并且必须**抢在开窗口之前**调用。
 *
 * 本测试就是把这套链路锁住：数值正确 + 调用时机正确 + 不退回旧写法 + HTML 不覆盖。
 * 运行：node --experimental-sqlite test/web_identity.test.js
 */

const fs = require('fs');
const path = require('path');
const webIdentity = require('../src/webIdentity');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('--- WA① 浏览器身份 ---');

/* ===== 1. UA 字符串本身要"干净、标准、动态" ===== */
const ua = webIdentity.chromeUserAgent();
check('生成的是标准 Chrome 形态 UA',
  /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/537\.36$/.test(ua),
  ua);
check('🔴 不含 Electron 令牌（这正是 WhatsApp 认不出的元凶）', !/Electron/i.test(ua), ua);
check('🔴 不含应用名（否则同样会被判成不认识的浏览器）', !/蜜蜂|assistant/i.test(ua), ua);
check('版本号动态跟随传入的 Chromium 版本（不是写死的）',
  webIdentity.chromeUserAgent('140.0.7339.1').includes('Chrome/140.0.7339.1'));

/* ===== 2. 分区常量：必须是六号那个独立分区，不许是一号那个 ===== */
check('🔴 默认分区 = persist:wa6（六号独立数据夹）', webIdentity.WA_PARTITION === 'persist:wa6',
  webIdentity.WA_PARTITION);
check('🔴 绝不用一号的旧分区 wa-web-1', webIdentity.WA_PARTITION !== 'persist:wa-web-1');

/* ===== 3. 非 Electron 环境下要优雅返回，不能把测试/其他进程搞崩 ===== */
let r = null;
try { r = webIdentity.applyChromeIdentity('persist:wa6'); } catch (e) { r = { crashed: String(e && e.message) }; }
check('非 Electron 环境下 applyChromeIdentity 优雅返回（不抛错）',
  r && r.crashed === undefined && r.ok === false && r.partition === 'persist:wa6',
  JSON.stringify(r));

/* ===== 4. 🔴 最关键：主进程必须在"开窗口之前"调用（否则又白改） ===== */
const mainSrc = read('electron/main.js');
check('主进程已 require src/webIdentity', /require\(['"]\.\.\/src\/webIdentity['"]\)/.test(mainSrc));
check('主进程已调用 applyChromeIdentity', mainSrc.includes('applyChromeIdentity'));
const iHook = mainSrc.indexOf('applyChromeIdentity');
const iStart = mainSrc.indexOf('await startDesktop()');
check('🔴 调用点在 startDesktop()（开窗口）之前 —— 抢在 webview 建 guest 之前',
  iHook > -1 && iStart > -1 && iHook < iStart,
  `hook@${iHook} startDesktop@${iStart}`);

/* ===== 5. 渲染进程那份兜底：不许退回"只剥 Electron 令牌"的旧写法 ===== */
const appSrc = read('public/app.js');
check('渲染进程兜底不再用「replace(/(\\s)Electron.../）」旧写法', !appSrc.includes('\\sElectron'));
check('渲染进程兜底改为"从宿主 UA 抠 Chrome 版本、重建纯 Chrome 串"',
  appSrc.includes("Chrome/' + v + ' Safari/537.36"));

/* ===== 6. HTML 里 WA① 的 webview 不许自带 useragent 属性（会盖掉主进程钉的值） ===== */
const htmlSrc = read('public/index.html');
const m = /<webview id="wa1-webview"[\s\S]*?>/.exec(htmlSrc);
check('index.html 里能找到 WA① 的 webview 标签', !!m);
check('🔴 WA① webview 标签里没有 useragent 属性（避免盖掉主进程钉的值）',
  !!m && !/useragent/i.test(m[0]),
  m ? m[0].replace(/\s+/g, ' ') : '');
check('WA① webview 仍用 persist:wa6 分区', !!m && /partition="persist:wa6"/.test(m[0]));

/* ===== 7. 打包不会漏掉这个新文件（build.files 含 src/**，且已被 require 串起来） ===== */
check('新模块位于 src/ 下（会被 build.files 的 src/** 收进包）',
  fs.existsSync(path.join(ROOT, 'src', 'webIdentity.js')));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
