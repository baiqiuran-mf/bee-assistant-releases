/**
 * 打包相关自检：exe 运行时的数据落点 / 首次运行铺文件 / 浏览器兜底发现
 *
 * 为什么要有这套断言：
 *   打包安装到 C:\Program Files 之后，程序目录是只读的（界面还压在 app.asar 里）。
 *   只要 config.yaml、数据库、知识库、登录态里有一个还往程序目录写，
 *   用户在 exe 里「改 AI 设置」「扫码登录」就会静默失败 —— 而这种失败在开发模式
 *   （electron .）下**一次都不会出现**，所以必须靠测试钉住。
 *
 * 用 BEE_HOME 环境变量模拟「打包后指向用户目录」，不需要真起 Electron。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP_ROOT = path.join(ROOT, '.tmp-test-data');

/**
 * 清一个目录并**复查**（Windows 上 rmSync 可能「不抛异常、但也没删」）。
 * @param {string} dir
 * @returns {{ok: boolean, why: string}}
 */
function wipeDir(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, why: `rmSync 抛异常：${(e && e.message) || e}` };
  }
  if (fs.existsSync(dir)) return { ok: false, why: 'rmSync 没报错，但目录仍然在' };
  return { ok: true, why: '' };
}

/**
 * 🔴 2026-10-18 改（为什么）：
 *   以前 HOME 固定为 .tmp-test-data/packaging-home，而第 17 行的 rmSync 被
 *   静默 try/catch 吞掉 —— Windows 上它经常「不报错但也没删」（实测该目录自
 *   00:56 起就再没被清掉）。于是每次跑都复用同一个用户目录：
 *   「config.yaml 是新建出来的」永远失败（旧的还在），
 *   「知识库 36 个文件全部复制」永远 0/36（早就复制过了）。
 *   现在改成：本轮用一个带时间戳 + pid + 随机串的全新目录，删不掉也如实告警，
 *   保证「本轮起点一定是空的」。
 */
function sweepStaleHomes(ageMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(TMP_ROOT)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(TMP_ROOT)) {
      // 老版本留下的固定目录 packaging-home 也一并回收
      if (entry !== 'packaging-home' && !entry.startsWith('packaging-home-')) continue;
      const full = path.join(TMP_ROOT, entry);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st || !st.isDirectory()) continue;
      if (now - st.mtimeMs < ageMs) continue; // 太新，可能是别人正在跑的
      wipeDir(full);
    }
  } catch (e) {
    console.warn(`[打包自检] 回收旧用户目录失败（不影响本轮）：${(e && e.message) || e}`);
  }
}

sweepStaleHomes();
const HOME = path.join(
  TMP_ROOT,
  `packaging-home-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
);
const wiped = wipeDir(HOME); // 本轮新建的目录，正常不存在；真撞上了也要说清楚
if (!wiped.ok) console.warn(`[打包自检] ⚠️  清不掉本轮用户目录（${wiped.why}）`);
fs.mkdirSync(HOME, { recursive: true });

// 必须在 require('../src/...') 之前：src/runtime.js 第一次被调用时就把目录定死了
process.env.BEE_HOME = HOME;
delete process.env.BEE_CONFIG;
delete process.env.BEE_DATA_DIR;

const runtime = require('../src/runtime');
const paths = require('../src/paths');
const firstRun = require('../src/firstRun');
const browserPath = require('../src/browserPath');

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + extra : '')); }
};

console.log(`[打包自检] 模拟用户目录：${HOME}`);

/* ---------- 1) 运行期目录 ---------- */
console.log('\n[1] 运行期目录：打包后一律落在用户可写目录');
check('BEE_HOME 指哪就认哪', runtime.homeDir() === HOME, runtime.homeDir());
check('认作「打包运行」', runtime.isPackaged() === true);
check('数据基准目录 = 用户目录', runtime.dataBase() === HOME, runtime.dataBase());
check('自带资源目录仍是项目根（只读那份）', runtime.RESOURCE_ROOT === ROOT, runtime.RESOURCE_ROOT);
check('config.yaml 落在用户目录里', paths.configFile() === path.join(HOME, 'config.yaml'), paths.configFile());
check('数据目录落在用户目录里', paths.DATA_ROOT === path.join(HOME, 'data'), paths.DATA_ROOT);
check('客户档案目录也在用户目录里', paths.docsDir() === path.join(HOME, 'data', 'customers'), paths.docsDir());
check('媒体目录也在用户目录里', paths.mediaDir() === path.join(HOME, 'data', 'media'), paths.mediaDir());

/* ---------- 2) 首次运行铺文件 ---------- */
console.log('\n[2] 首次运行：把配置和知识库铺到用户目录');
const rep1 = firstRun.prepareUserSpace(HOME, ROOT);
check('config.yaml 是新建出来的', rep1.config === 'created', rep1.config);
check('建了 data / sessions / knowledge 三个目录',
  ['data', 'sessions', 'knowledge'].every((d) => fs.existsSync(path.join(HOME, d))),
  rep1.dirs.join(','));
function walk(dir, base = '') {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}
const srcKnowledge = walk(path.join(ROOT, 'knowledge'));
check(`知识库 ${srcKnowledge.length} 个文件全部复制到用户目录（含子目录）`,
  rep1.knowledge.length === srcKnowledge.length
  && srcKnowledge.every((f) => fs.existsSync(path.join(HOME, 'knowledge', ...f.split('/')))),
  `复制了 ${rep1.knowledge.length} / 共 ${srcKnowledge.length}`);
check('知识库子目录也复制过去了（playbook/day1.md）',
  !srcKnowledge.includes('playbook/day1.md') || fs.existsSync(path.join(HOME, 'knowledge', 'playbook', 'day1.md')),
  srcKnowledge.slice(0, 3).join(','));

const seeded = fs.readFileSync(path.join(HOME, 'config.yaml'), 'utf8');
check('配置里原来的中文注释没丢（不是重新序列化出来的）',
  /消息提取间隔/.test(seeded) && /申请地址/.test(seeded));
check('dataDir 改成了用户目录下的绝对路径',
  new RegExp(`dataDir:\\s*'${HOME.replace(/\\/g, '\\\\')}[\\\\/]data'`).test(seeded), seeded.match(/.*dataDir.*/) || '未匹配');
check('sessionDir 改成了绝对路径',
  /sessionDir:\s*'/.test(seeded), seeded.match(/.*sessionDir.*/) || '未匹配');
check('knowledge.dir 改成了绝对路径',
  /\n\s+dir:\s*'/.test(seeded), (seeded.match(/knowledge:[\s\S]{0,200}/) || [''])[0]);
check('没动别的配置（extractInterval 原样保留）', /extractInterval:\s*\d+/.test(seeded));
check('没动账号配置（proxy 行原样保留）', /proxy:\s*""|proxy:/.test(seeded));

/* ---------- 3) 第二次启动不覆盖用户改过的东西 ---------- */
console.log('\n[3] 再启动一次：不能把用户改过的文件冲掉');
const personaFile = path.join(HOME, 'knowledge', 'persona.md');
const edited = fs.existsSync(personaFile) ? fs.readFileSync(personaFile, 'utf8') : '';
try { fs.writeFileSync(personaFile, edited + '\n（我手工补的一条规则）'); } catch (e) { /* 文件不存在就跳过 */ }
const rep2 = firstRun.prepareUserSpace(HOME, ROOT);
check('第二次：配置保持已存在', rep2.config === 'exists', rep2.config);
check('第二次：知识库一个都不用补', rep2.knowledge.length === 0, rep2.knowledge.join(','));
if (edited) {
  check('用户改过的知识库没被覆盖', fs.readFileSync(personaFile, 'utf8').includes('我手工补的一条规则'));
}

/* ---------- 4) 逐行改写函数本身 ---------- */
console.log('\n[4] 路径改写函数');
const sample = [
  'app:',
  '  dataDir: ./data',
  'browser:',
  '  executablePath: ""',
  '  sessionDir: ./sessions',
  'knowledge:',
  '  dir: ./knowledge',
  'ai:',
  '  providers:',
  '    hunyuan:',
  '      baseUrl: "https://x/v1"',
].join('\n');
const out = firstRun.retargetConfig(sample, HOME);
check('只改 app.dataDir', out.includes(`dataDir: '${path.join(HOME, 'data')}'`));
check('只改 browser.sessionDir', out.includes(`sessionDir: '${path.join(HOME, 'sessions')}'`));
check('只改 knowledge.dir', out.includes(`dir: '${path.join(HOME, 'knowledge')}'`));
check('同小节里别的键不动（executablePath 仍为空）', /executablePath:\s*""\s*$/m.test(out), out.match(/.*executablePath.*/));
check('ai 小节里同名的键不会被误改（baseUrl 原样）', /baseUrl:\s*"https:\/\/x\/v1"/.test(out));

/* ---------- 5) 浏览器可执行文件兜底 ---------- */
console.log('\n[5] 浏览器兜底：Puppeteer 缓存没有时也能找到本机浏览器');
check('配置里写死了就用写死的那个',
  browserPath.resolveExecutable({ explicit: 'D:\\my\\chrome.exe' }) === 'D:\\my\\chrome.exe');
check('配置里写空字符串时不算写死（继续走自动找）',
  browserPath.resolveExecutable({ explicit: '   ', cacheDir: path.join(HOME, 'no-such-cache') }) !== '   ');

const fakeCache = path.join(HOME, 'fake-puppeteer-cache');
const fakeBin = path.join(fakeCache, 'chrome', 'win64-131.0.6778.204', 'chrome-win64', 'chrome.exe');
fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
fs.writeFileSync(fakeBin, 'not a real binary, just for path probing');
check('能认出 Puppeteer 缓存里的 Chromium',
  browserPath.resolveExecutable({ cacheDir: fakeCache }) === fakeBin,
  browserPath.resolveExecutable({ cacheDir: fakeCache }));
check('找不到时返回 null（交给 Puppeteer 默认行为）',
  browserPath.resolveExecutable({ cacheDir: path.join(HOME, '没有这个目录') }) !== undefined);
check('firstExisting 全都不存在时返回 null',
  browserPath.firstExisting([path.join(HOME, 'a'), path.join(HOME, 'b')]) === null);

/* ---------- 5b) 标准版浏览器优先于 Chrome for Testing（防 v2.5.1064 之前的 banner 回归）---------- */
console.log('\n[5b] 标准版浏览器优先：避免拉起 Puppeteer 的 Chrome for Testing 弹测试提示');
const stdPath = browserPath.resolveStandardExecutable({});
const cfTPath = browserPath.resolveExecutable({});
const isSystem = (p) => !!p && !/puppeteer[\\/]chrome[\\/]win64-/.test(p) && /(Chrome|Edge)[\\/]Application[\\/]/.test(p);
const isCfT = (p) => !!p && /puppeteer[\\/]chrome[\\/]win64-/.test(p);
check('resolveStandardExecutable 优先返回系统 Chrome/Edge（非 CfT）', isSystem(stdPath), stdPath);
check('本机确有系统浏览器（前提下一条有意义）', !!stdPath, stdPath);
check('对比：resolveExecutable 会落到 CfT（这正是 banner 来源，WA 之前用它）', isCfT(cfTPath), cfTPath);
check('两者不是同一个文件（标准版确实排在 CfT 前面）', stdPath !== cfTPath);
// 回归锁：session.js 给 WhatsApp 拉起浏览器时必须用 resolveStandardExecutable，
// 不能用 resolveExecutable（CfT 优先），否则又会弹 "Chrome for Testing ... is only for automated testing"
const sessionSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'session.js'), 'utf8');
check('session.js 已改用 resolveStandardExecutable 给 WA 选浏览器',
  /require\('\.\/browserPath'\)\.resolveStandardExecutable\(\{\}\)/.test(sessionSrc), 'src/session.js');
check('session.js 不再用 resolveExecutable（CfT 优先）给 WA 选浏览器',
  !/require\('\.\/browserPath'\)\.resolveExecutable\(\{\}\)/.test(sessionSrc), 'src/session.js');

/* ---------- 6) 真实数据库能不能在用户目录里建起来 ---------- */
console.log('\n[6] 数据库在用户目录里能建起来（不碰开发目录）');
const db = require('../src/db');
try {
  const { customer } = db.getOrCreateCustomer(1, '12125550123@c.us', { name: '打包测试客户', phone: '+12125550123', isSim: true });
  check('在用户目录里建库并写入客户', !!(customer && customer.code), customer && customer.code);
  check('数据库文件确实在用户目录下', fs.existsSync(path.join(HOME, 'data', 'assistant.db')),
    fs.readdirSync(path.join(HOME, 'data')).join(','));
} catch (e) {
  check('在用户目录里建库并写入客户', false, (e && e.message) || e);
}

const ok = fail === 0;
console.log(`\n[打包自检] ${ok ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
if (!ok) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(ok ? 0 : 1);
