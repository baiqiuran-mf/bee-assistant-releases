/**
 * v1.2.0 自检：软件自动更新
 *
 * 钉死八件事：
 *   ① 版本比较不能退化成字符串比（"1.10.0" vs "1.9.0" 字符串比会判反）
 *   ② 版本号带 v / 带预发布后缀都要认
 *   ③ 更新源占位符没替换时**必须拒绝检查**，不能去请求一个不存在的仓库
 *   ④ 🔴 正在采集时**绝不自动重启**（老板选了自动重启，这条是保护）
 *   ⑤ 失败的更新也要写库（只记成功会让界面显示"三个月前更新过"，其实那次失败）
 *   ⑥ 开发模式（没打成exe）调用检查不能崩，要给出人话提示
 *   ⑦ 设置页有「软件更新」页签、三个接口和样式都在
 *   ⑧ 打包红线没被破坏（knowledge/CHANGELOG 保留、puppeteer 没被排除）
 *
 * 用真起后端 + 隔离数据目录，绝不碰生产库。
 */
process.env.BEE_TEST = '1';

const fs = require('fs');
const path = require('path');
const http = require('http');

const { DIR } = require('./_isolate.js');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}${extra ? '  << ' + extra : ''}`); }
}

const db = require('../src/db');
const update = require('../src/update');
const pkg = require('../package.json');

/** HTTP 返回体一定是 JSON，解析失败要能报出来而不是抛 */
function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

(async function run() {
  console.log('\n=== ① 版本比较（字符串比会错的地方） ===');
  ok(update.compareVersions('1.10.0', '1.9.0') === 1, '1.10.0 比 1.9.0 新（字符串比会判反）');
  ok(update.compareVersions('1.9.0', '1.10.0') === -1, '1.9.0 比 1.10.0 旧');
  ok(update.compareVersions('1.1.0', '1.1.0') === 0, '相同版本 = 0');
  ok(update.compareVersions('1.1.0', 'v1.1.0') === 0, '带 v 前缀视为相同');
  ok(update.compareVersions('1.2.0-beta', '1.2.0') === -1, '预发布版比正式版旧（semver 规则）');
  ok(update.compareVersions('1.2.0-beta.2', '1.2.0-beta.1') === 1, 'beta.2 比 beta.1 新');
  ok(update.compareVersions('2.0.0', '1.99.99') === 1, '2.0.0 > 1.99.99');
  ok(update.compareVersions('1.9', '1.10.0') === -1, '少一段的版本 1.9 < 1.10.0');
  ok(update.compareVersions('', '1.0.0') === -1, '空版本号当 0，不崩');
  ok(update.compareVersions(null, null) === 0, 'null 不崩');
  ok(update.compareVersions('abc', '1.0.0') === -1, '非规范版本号不崩');

  console.log('\n=== ③ 更新源占位符必须拒绝 ===');
  const ph = update.publishTarget({ provider: 'github', owner: '__OWNER__', repo: 'x' });
  ok(!ph.ok && /占位符/.test(ph.reason), `owner 是占位符时报「还没填」（实测：${ph.reason}）`);
  const ph2 = update.publishTarget({ provider: 'github', owner: 'abc', repo: '__REPO__' });
  ok(!ph2.ok, 'repo 是占位符也拒绝');
  const real = update.publishTarget({ provider: 'github', owner: 'abc', repo: 'bee' });
  ok(real.ok && real.url === 'https://github.com/abc/bee', '真地址能识别出来');
  ok(!update.publishTarget(null).ok, '没配publish 也拒绝');
  ok(!update.publishTarget({ provider: 's3' }).ok, 'provider 不对也拒绝');

  // 🔴 2026-10-11 真机事故回归：装好的软件里点「检查更新」完全没反应。
  //   根因：electron-builder 打包会把 package.json 的 `build` 段**整段剥掉**
  //   （实测包内 app/package.json 没有 build），于是 publishTarget(pkg.build.publish)
  //   永远拿到 null → 判「provider 不是 github」→ check() 第一道关就 return，
  //   **根本没调用 autoUpdater.checkForUpdates()**。真正的更新源在
  //   resources/app-update.yml（electron-updater 自己就读它），必须回退到它。
  //   这条测试模拟「包内 package.json 已被剥掉」的场景，钉死回退逻辑。
  console.log('\n=== ③b 打包态：build 被剥掉后必须回退读 app-update.yml（本次事故根因） ===');
  {
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
    const resDir = path.join(tmp, 'resources');
    fs.mkdirSync(resDir, { recursive: true });
    const prevResources = process.resourcesPath;
    // 先证明：既没 publish、也没 app-update.yml 时，仍必须拒绝（不能瞎放行）
    process.resourcesPath = resDir;
    ok(!update.publishTarget(null).ok, '包内没有 app-update.yml 时仍判失败（不误放行）');
    // 放一份与 electron-builder 生成内容一致的 app-update.yml
    fs.writeFileSync(path.join(resDir, 'app-update.yml'), [
      'provider: github',
      'owner: baiqiuran-mf',
      'repo: bee-assistant-releases',
      'channel: latest',
      'updaterCacheDirName: wa-assistant-updater',
    ].join('\n'), 'utf8');
    const t = update.publishTarget(null); // 模拟 pkg.build.publish === undefined
    ok(t.ok && t.url === 'https://github.com/baiqiuran-mf/bee-assistant-releases',
      `build 被剥掉后，从 app-update.yml 认出更新源（实测：${t.ok ? t.url : t.reason}）`);
    // 手写解析兜底也要能读（不依赖 js-yaml）：临时把 require 换成抛错
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (req, ...rest) {
      if (req === 'js-yaml') { const e = new Error('模拟未安装 js-yaml'); e.code = 'MODULE_NOT_FOUND'; throw e; }
      return origResolve.call(this, req, ...rest);
    };
    let t2;
    try { t2 = update.publishTarget(null); } finally { Module._resolveFilename = origResolve; }
    ok(t2 && t2.ok && t2.url === 'https://github.com/baiqiuran-mf/bee-assistant-releases',
      '没有 js-yaml 时手写解析兜底也能读出更新源');
    if (prevResources === undefined) delete process.resourcesPath; else process.resourcesPath = prevResources;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n=== ④ 正在采集绝不自动重启（红线） ===');
  const busy = update.restartDecision(true);
  ok(busy.auto === false, 'busy=true → 不自动重启');
  ok(/采集/.test(busy.reason), `理由写清了（实测：${busy.reason}）`);
  const idle = update.restartDecision(false);
  ok(idle.auto === true, '空闲时 → 自动重启（老板选的）');

  console.log('\n=== ⑤ 失败的更新也要写库 ===');
  const id1 = db.logVersion({ version: 'v1.2.0', result: 'ok', fromVersion: '1.1.0', note: '正常升级' });
  ok(id1 > 0, '成功记了一笔');
  const id2 = db.logVersion({ version: '1.2.1', result: 'fail', fromVersion: '1.2.0', note: '采集中未自动重启' });
  ok(id2 > 0, '失败也记了一笔（不能只记成功）');
  const last = db.getLastVersion('latest');
  ok(last && last.version === '1.2.1' && last.result === 'fail', 'getLastVersion 拿到的是失败那条');
  ok(db.listVersionHistory().length >= 2, '历史列表有记录');
  ok(db.logVersion({ version: 'x'.repeat(900), note: 'y'.repeat(900) }) > 0, '超长内容不炸库');
  const cut = db.getLastVersion('latest');
  ok(cut.note.length <= 500, `note 被截到500 字（实测 ${cut.note.length}）`);
  ok(db.getLastVersion('不存在渠道') === null, '没记过的渠道返回 null，不报错');

  console.log('\n=== ⑥ 开发模式调用不崩 ===');
  const r = await update.check();
  ok(r && typeof r.ok === 'boolean', 'check() 返回结构完整，不抛异常');
  ok(r.state === 'error' && r.version === update.currentVersion(),
    `给出人话提示而不是崩（实测：${r.text}）`);
  const st = update.status();
  ok(st && typeof st.version === 'string' && 'state' in st, 'status() 带着 state 给前端轮询');
  ok(typeof st.percent !== 'undefined', 'status() 带 percent（没下载时可为 null）');

  console.log('\n=== install：busy 时只记失败、不调 quitAndInstall ===');
  const before = db.listVersionHistory().length;
  const ins = await update.install({ busy: true, version: '1.3.0', db });
  ok(ins.auto === false, 'busy=true 时 install 返回 auto=false');
  ok(db.listVersionHistory().length === before + 1, '这次尝试被记进了库（result=fail）');
  ok(db.getLastVersion('latest').result === 'fail', '记的是 fail 不是 ok');
  ok(db.getLastVersion('latest').version === '1.3.0', '版本号记对了');

  console.log('\n=== ② parseVersion 细节 ===');
  const pv = update.parseVersion('v2.13.5-beta.2');
  ok(pv.num.join('.') === '2.13.5', `主版本解析对（${pv.num.join('.')}）`);
  ok(pv.pre === 'beta.2', `预发布后缀解析对（${pv.pre}）`);
  ok(update.parseVersion('1').num.join('.') === '1.0.0', '只有一段补成 1.0.0');
  ok(update.parseVersion('1.2.3.4').num.join('.') === '1.2.3', '多出来的一段被忽略');

  console.log('\n=== ⑦ 界面：页签/接口/样式都在 ===');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

  ok(html.includes('data-tab="update"'), '设置里有「🔄 软件更新」页签');
  ok(html.includes('id="sec-update"'), '更新面板存在');
  ok(html.includes('id="up-check"'), '有「检查更新」按钮');
  ok(html.includes('id="up-install"'), '有「安装」按钮（下载完才亮）');
  ok(html.includes('id="up-bar"') && html.includes('id="up-fill"'), '有下载进度条');
  ok(html.includes('id="up-hist"'), '有更新记录区');
  ok(js.includes('/api/update/status'), '前端调 status 接口');
  ok(js.includes('/api/update/check'), '前端调 check 接口');
  ok(js.includes('/api/update/install'), '前端调 install 接口');
  ok(js.includes("name === 'update'") && js.includes('loadUpdateStatus'), '切到页签会加载状态');
  ok(/JSON\.stringify\(\{\s*busy\s*,/.test(js) || /busy:\s*busy/.test(js),
    'install 时如实上报 busy（后端才敢拒绝重启）');
  ok(css.includes('.up-bar-fill'), '进度条样式在');
  ok(css.includes('.up-hist-row'), '更新记录样式在');

  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  ok(server.includes('/^\\/api\\/update\\/status$/'), '后端有 status 路由');
  ok(server.includes('/^\\/api\\/update\\/check$/'), '后端有 check 路由');
  ok(server.includes('/^\\/api\\/update\\/install$/'), '后端有 install 路由');
  ok(/mUpdateInstall[\s\S]{0,900}busy: Boolean\(body && body\.busy\)/.test(server),
    '后端只认前端上报的 busy，不自己猜（猜错会丢客户消息）');

  // 🔴 回归（2026-10-07 真踩过）：deps.update 注入的是整个**模块对象**，
  //   当时写成了 typeof deps.update !== 'function'，于是三个接口永远返 501，
  //   而单测只查「字符串在不在」没查行为，差点直接打包发出去。
  //   这条断言钉的是「判断逻辑不能再退回 function」，且必须真打一次 HTTP。
  //   只查代码行（排除注释：注释里为了说明坑会故意写出那个错的写法）。
  const serverCode = server.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok(!/typeof deps\.update\s*!==\s*'function'/.test(serverCode),
    '可用性判断不再退回 typeof===\'function\'（模块是对象，会永远判成不可用）');
  ok(server.includes('hasUpdater()'), '三个路由都走 hasUpdater() 统一判断');
  {
    const { createServer } = require('../src/server');
    const http = require('http');
    const srv = createServer({ db, update }, 0);
    srv.server.listen(0, '127.0.0.1');
    await new Promise((r) => srv.server.on('listening', r));
    const P = srv.server.address().port;
    const call = (path, method, body) => new Promise((res) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        host: '127.0.0.1', port: P, path, method: method || 'GET',
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ code: r.statusCode, body: b })); });
      req.on('error', (e) => res({ code: 0, body: 'ERR ' + e.message }));
      if (data) req.write(data);
      req.end();
    });

    const st = await call('/api/update/status');
    ok(st.code === 200, `GET status 不是 501（实测 ${st.code}）—— 真打过 HTTP`);
    const j = safeJson(st.body);
    ok(j && j.ok === true && typeof j.version === 'string', 'status 真返回了版本号');
    ok(Array.isArray(j.history), 'status 带更新历史');

    const ck = await call('/api/update/check', 'POST');
    ok(ck.code === 200, `POST check 不是 501（实测 ${ck.code}）`);

    const n0 = db.listVersionHistory().length;
    const ins = await call('/api/update/install', 'POST', { busy: true, version: '1.4.0' });
    ok(ins.code === 200, `POST install 不是 501（实测 ${ins.code}）`);
    const ij = safeJson(ins.body);
    ok(ij && ij.auto === false && /采集/.test(ij.reason || ''),
      'HTTP 层也拦住自动重启（busy=true）');
    ok(db.listVersionHistory().length === n0 + 1, '这次 HTTP 调用也写进了版本历史');

    srv.server.close();
  }

  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  ok(/createServer\(\s*\{[^}]*update/.test(main), 'update 已注入 server');

  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  ok(!/beeUpdate/.test(preload),
    'preload 没加东西（settings 窗明写「不挂 preload 保持最小权限」，不为一个功能破它）');

  console.log('\n=== ⑧ 打包红线没被破坏 ===');
  ok(pkg.build.files.includes('knowledge/**/*'), 'knowledge/*.md 还在（误排除会报「知识库缺少文件」）');
  ok(pkg.build.files.includes('CHANGELOG.md'), 'CHANGELOG.md 还在');
  // 🔴 只查「真的把 puppeteer 整个排掉」那种写法。
  // `"!**/node_modules/@puppeteer/browsers/lib/cjs/generated/**"` 排除的是
  // @puppeteer/browsers 包里的**自动生成代码**，puppeteer 本体照样在包里 ——
  // 所以不能简单 grep "puppeteer" 就断言（我第一次就是这么写错的）。
  ok(!pkg.build.files.some((x) => /^\*\*\/node_modules\/(puppeteer|puppeteer-core)\/\*\*$/.test(String(x))),
    'puppeteer 本体没被整个排除（缺了登录不了 WhatsApp）');
  ok(!pkg.build.files.some((x) => /^\*\*\/node_modules\/puppeteer/.test(String(x))),
    '没有任何一条把 puppeteer 目录整体排掉');
  ok(pkg.build.nsis.artifactName === 'wa-assistant-setup-${version}.${ext}',
    'NSIS 包名规则 = 英文（2026-10-11 老板要求统一英文名，与 GitHub 既有约定一致）');
  ok(pkg.build.artifactName === 'wa-assistant-setup-${version}-${arch}.${ext}',
    '顶层 artifactName 也是英文（两处必须一致，否则产物名会打架）');
  ok(pkg.build.nsis.oneClick === false, 'NSIS oneClick=false 保留（仍能选安装目录）');
  ok(pkg.build.nsis.differentialPackage === true, '增量更新已开（这是省流量的关键）');
  ok(pkg.dependencies['electron-updater'], 'electron-updater 装上了');
  ok(pkg.build.publish && pkg.build.publish[0].provider === 'github', 'publish 指向 GitHub');

  console.log(`\n${'='.repeat(50)}`);
  console.log(fail === 0 ? `全部通过：${pass} 项 / 0 失败` : `通过：${pass} 项，失败：${fail} 项`);
  if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  · ' + f)); }
  console.log(`${'='.repeat(50)}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n💥 测试自身崩了（不是产品问题）：', e.stack || e.message);
  process.exit(1);
});