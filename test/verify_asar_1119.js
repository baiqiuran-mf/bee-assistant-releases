/**
 * 2.6.1119 产物验收：抽 dist/win-unpacked/resources/app.asar，验新结构真的进了安装包。
 * 只读，不修改产物。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
const TMP = path.join(os.tmpdir(), 'asar-check-1119');

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
};

if (!fs.existsSync(ASAR)) {
  console.log('✗ 找不到 ' + ASAR);
  process.exit(1);
}
fs.rmSync(TMP, { recursive: true, force: true });
execFileSync(process.execPath,
  [path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'), 'extract', ASAR, TMP],
  { stdio: 'inherit' });

const rd = (rel) => fs.readFileSync(path.join(TMP, rel), 'utf8');
const has = (rel, needle) => rd(rel).includes(needle);

const idx = rd('public/index.html');
const app = rd('public/app.js');
const css = rd('public/style.css');
const pkg = JSON.parse(rd('package.json'));

console.log('\n=== 版号 ===');
check('asar 内 package.json version = 2.6.1119', pkg.version === '2.6.1119', pkg.version);

console.log('\n=== 通用中栏两栏结构（本次核心改动）===');
check('index.html 有 .gen-wrap（横向分栏容器）', idx.includes('class="gen-wrap"'));
check('index.html 左栏是 .gen-chat（id=gen-chat）', idx.includes('class="gen-chat" id="gen-chat"'));
check('index.html 左栏顶部有「对话信息」标题', /tgc-title">对话信息</.test(idx));
check('index.html 左栏副标题 id=gen-chat-sub', idx.includes('id="gen-chat-sub"'));
check('index.html 右栏容器 class="tg-conv-aside gen-aside" id="chat-head"',
  idx.includes('class="tg-conv-aside gen-aside" id="chat-head"'));
check('index.html 右栏卡片槽 id=ch-head-slot', idx.includes('id="ch-head-slot"'));
check('index.html 通用内【不含】好友对话栏（.tg-friends 只在 Tele①/②）',
  (() => {
    /* ⚠️ 必须按「pane 元素」定位，不能拿裸 data-mp="general" 去 indexOf ——
       第一次命中的是顶栏那个页签按钮（<button class="mtab" data-mp="general">），
       而 tele1 的首次命中还落在注释里（位置更靠前），窗口会算反。 */
    const a = idx.indexOf('class="mid-pane" data-mp="general"');
    const b = idx.indexOf('class="mid-pane hidden" data-mp="tele1"');
    if (a < 0 || b < 0 || b <= a) return false;
    return !idx.slice(a, b).includes('tg-friends');
  })());

console.log('\n=== app.js 渲染落点 ===');
check('renderChatHead 渲染到 ch-head-slot', app.includes("$('ch-head-slot')"));
check('renderChatHead 用 .tv-head / .tv-actions', app.includes('class="tv-head"') && app.includes('class="tv-actions"'));
check('空状态写 gen-chat-sub', app.includes("$('gen-chat-sub')"));
check('已删旧 chat-sub 死代码', !/\$\('chat-sub'\)/.test(app));
check('按钮文案是「对话提档」', app.includes('对话提档'));
/* ⚠️ 不能直接 includes：旧文案在几处**注释**里保留（记录历史沿革，属正常），
   要判的是「按钮/文案本身有没有还在用」。所以先把块注释和行注释都剥掉再查。
   （只剥行首 `//` 不够 —— 块注释的后续行不以 * 开头，会漏网。） */
const appNoComments = app
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释（含跨行）
  .replace(/^[ \t]*\/\/.*$/gm, '')    // 整行行注释
  .replace(/[ \t]+\/\/[^\n]*/g, '');  // 行尾注释
check('按钮文案已无旧文「从对话里提取档案」（注释里的历史记录不算）',
  !appNoComments.includes('从对话里提取档案'));

console.log('\n=== style.css ===');
check('有 .gen-wrap 规则', /\.gen-wrap \{/.test(css));
check('有 general .gen-chat 规则', /\.mid-pane\[data-mp="general"\] \.gen-chat \{/.test(css));
check('有 general .gen-aside 300px 规则', /\.mid-pane\[data-mp="general"\] \.gen-aside \{[\s\S]*?flex: 0 0 300px/.test(css));
check('旧 #chat-head sticky 顶栏已删', !/#chat-head \{[^}]*position: sticky/.test(css));
check('Signal 图标选择器补了 .tv-head', css.includes('.tv-head .ch-signal'));

console.log('\n=== 打包红线 ===');
check('产物含 knowledge/（知识库没被排除）', fs.existsSync(path.join(TMP, 'knowledge')));
check('产物含 CHANGELOG.md', fs.existsSync(path.join(TMP, 'CHANGELOG.md')));
check('产物含 config.yaml', fs.existsSync(path.join(TMP, 'config.yaml')));
check('产物含 puppeteer（未被排除）', fs.existsSync(path.join(TMP, 'node_modules', 'puppeteer-core')) || fs.existsSync(path.join(TMP, 'node_modules', 'puppeteer')));

console.log('\n=== 安装包与更新清单 ===');
const setup = path.join(ROOT, 'dist', 'wa-assistant-setup-2.6.1119.exe');
check('安装包存在', fs.existsSync(setup));
if (fs.existsSync(setup)) {
  const mb = (fs.statSync(setup).size / 1024 / 1024).toFixed(1);
  console.log(`       体积 ${mb} MB`);
}
const ly = fs.readFileSync(path.join(ROOT, 'dist', 'latest.yml'), 'utf8');
check('latest.yml 指向 2.6.1119', /version:\s*2\.6\.1119/.test(ly));
check('latest.yml 含 exe 名', ly.includes('wa-assistant-setup-2.6.1119.exe'));

console.log(`\n========== 验收结果：${pass} 通过 / ${fail} 失败 ==========`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
