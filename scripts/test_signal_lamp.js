/*
 * Signal 状态灯 · 前端专项测试（v1.4.0）
 *
 * 🔴 纪律：renderSignalLamp / refreshSignalLamp 从 app.js 里**抠出真源码执行**，
 *    不是抄一遍 —— 抄一遍等于没测。
 *    （上一轮 SIGNAL 标签那次就吃过这个亏：一开始抄函数，测了半天全绿，
 *      结果真跑起来依赖没注入、选择器写错，是假通过。）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  << ' + extra : '')); }
}

/** 按大括号配平抠出一个函数定义（含前置的 function / async function 关键字） */
function grabFn(name) {
  // 🔴 必须同时匹配 async：refreshSignalLamp 是 async function，
  //    只找 'function ' +名字 会漏掉 async 前缀，导致抠出来的东西语法不完整。
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = appJs.match(re);
  if (!m) throw new Error('找不到函数 ' + name);
  const start = m.index;
  const open = appJs.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < appJs.length; i++) {
    if (appJs[i] === '{') depth++;
    else if (appJs[i] === '}') { depth--; if (depth === 0) return appJs.slice(start, i + 1); }
  }
  throw new Error('函数 ' + name + ' 大括号不配平');
}

/* ---------- 造一个假的 DOM / api，跑真源码 ---------- */
function makeEl() {
  const el = {
    className: '', title: '', textContent: '',
    _children: {},
    querySelector(sel) { return this._children[sel] || null; },
    classList: { add() {}, remove() {} },
  };
  el._children['.sig-txt'] = { textContent: '' };
  el._children['.sig-led'] = { textContent: '' };
  return el;
}

const els = { 'signal-lamp': makeEl() };
const $stub = (id) => els[id] || null;

let apiHits = [];
const apiStub = async (p) => { apiHits.push(p); return { signal: { state: 'green', reason: 'x' } }; };

/**
 * 🔴 坑（第一版就踩了）：用 `new Function('$', 'api', src)` 传参，
 *    但真源码里调的是裸 `$('signal-lamp')` —— 在 new Function 的作用域里
 *    形参名就是 `$`，**必须把参数名写成 '$' 才注入得进去**。
 *    写成别的名字（或只传对象）都会得到 "TypeError: $ is not a function"。
 *    这跟上一轮 SIGNAL 标签那次「依赖没注入」是同一类错，同一个教训。
 */
function runFns(names) {
  const src = names.map(grabFn).join('\n\n');
  const factory = new Function('$', 'api', 'state', src + '\nreturn {' + names.join(',') + '};');
  return factory($, apiStub, {});
}

// eslint-disable-next-line no-unused-vars
function $(id) { return $stub(id); }

let F = runFns(['renderSignalLamp']);
const el = els['signal-lamp'];

console.log('=== 一、绿灯 ===');
F.renderSignalLamp({ state: 'green', reason: 'Signal 已启动并登录（3 个会话 / 9 条消息）' });
check('className 含 green', el.className.includes('green'), el.className);
check('文案是「Signal 已启动」', el.querySelector('.sig-txt').textContent === 'Signal 已启动');
check('悬停提示以✅ 开头', el.title.startsWith('✅'));
check('悬停提示带上会话/消息数', el.title.includes('3 个会话'));

console.log('\n=== 二、红灯（没启动）===');
el.className = ''; el.title = '';
F.renderSignalLamp({ state: 'red', reason: 'Signal 没启动 —— 打开它并保持登录' });
check('className 含 red', el.className.includes('red'), el.className);
check('文案是「Signal 未启动」', el.querySelector('.sig-txt').textContent === 'Signal 未启动');
check('悬停提示以 ⛔ 开头', el.title.startsWith('⛔'));
check('悬停提示说清后果（读不到消息）', el.title.includes('读不到'));

console.log('\n=== 三、红灯（在跑但没登录）===');
el.className = '';
F.renderSignalLamp({ state: 'red', reason: 'Signal 在跑，但还没登录', running: true });
check('仍是 red', el.className.includes('red'));
check('悬停提示保留具体原因', el.title.includes('在跑'));

console.log('\n=== 四、没拿到 signal 字段（老版后端）===');
el.className = '';
F.renderSignalLamp(null);
check('退成 unknown（不谎报绿灯）', el.className.includes('unknown'), el.className);
check('提示本版没带检测', el.title.includes('没带'));

console.log('\n=== 五、未知 state 不能当成绿灯 ===');
el.className = '';
F.renderSignalLamp({ state: 'whatever' });
check('非 green 一律红灯', el.className.includes('red'), el.className);

console.log('\n=== 六、HTML：灯在账号条右边 ===');
check('index.html 有 #signal-lamp', html.includes('id="signal-lamp"'));
check('初始 class 含 unknown（避免首屏假红）', /id="signal-lamp"[^>]*class="signal-lamp unknown"/.test(html));
check('放在 #accounts 之后（截图红框位置）',
  html.indexOf('id="accounts"') < html.indexOf('id="signal-lamp"'));
check('跟 #toast 同在 .head-bottom 里', (() => {
  const seg = html.slice(html.indexOf('class="head-bottom"'), html.indexOf('</header>'));
  return seg.includes('id="signal-lamp"') && seg.includes('id="accounts"');
})());

console.log('\n=== 七、CSS：绿/红/灰三种态都定义了 ===');
check('.signal-lamp 基础样式', css.includes('.signal-lamp {'));
check('绿灯用 var(--green)', /\.signal-lamp\.green \.sig-led\s*\{\s*background:\s*var\(--green\)/.test(css));
check('红灯用 var(--red)', /\.signal-lamp\.red \.sig-led\s*\{\s*background:\s*var\(--red\)/.test(css));
check('灰灯（unknown）在闪', /\.signal-lamp\.unknown \.sig-led/.test(css));
check('复用 led-blink 动画', css.includes('animation: led-blink'));
check('🔴 用的是真实存在的 CSS 变量',
  ['--green', '--red', '--line', '--muted'].every((v) => css.includes(v + ':')));
check('🔴 没有用不存在的 --blue', !/\.signal-lamp[^}]*var\(--blue\)/.test(css));

console.log('\n=== 八、轮询与降级 ===');
check('有独立的 Signal 轮询定时器', /setInterval\(\(\)\s*=>\s*refreshSignalLamp\(false\)/.test(appJs));
check('轮询间隔 10 秒', /refreshSignalLamp\(false\)\s*,\s*10000\)/.test(appJs));
check('refreshState 里调了 renderSignalLamp(s.signal)', /renderSignalLamp\(s\.signal\)/.test(appJs));
check('点一下走 force 接口', appJs.includes("api('/api/signal/status')"));

console.log('\n=== 九、refreshSignalLamp 真跑一遍 ===');
F = runFns(['renderSignalLamp', 'refreshSignalLamp']);
el.className = 'signal-lamp unknown';
apiHits = [];
(async () => {
  await F.refreshSignalLamp(false);
  check('非 force 走 /api/state', apiHits.includes('/api/state'), JSON.stringify(apiHits));
  await F.refreshSignalLamp(true);
  check('force 走 /api/signal/status', apiHits.includes('/api/signal/status'), JSON.stringify(apiHits));
  console.log('\n========================================');
  console.log('通过：' + pass +'　失败：' + fail);
  if (fail) { console.log('失败项：'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})();
