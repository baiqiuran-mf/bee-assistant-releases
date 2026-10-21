/* =====================================================================
 * SIGNAL 渠道标记 UI 测试（2026-10-08）
 *
 * 验三件事：
 *   ① isSignalCustomer 两个判定条件（channel / account_id）都能认出来
 *   ② WhatsApp 客户**绝不能**被误判成 Signal（这是最危险的回归）
 *   ③ SIGNAL 标签是 Signal 原装图标（public/img/signal.svg，20×20 像素）
 *
 * 只测纯函数 + 字符串，不碰生产库。
 * ===================================================================== */

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

/* --- 把 app.js 里的三个函数抠出来跑（不启动整个前端环境） --- */
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function grabFn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('app.js 里找不到 ' + name);
  // 从function 关键字开始，遇到「下一个顶格的 function 或 const」就停
  let depth = 0, j = src.indexOf('{', i);
  const start = j;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

const SIGNAL_ACCOUNT_ID = 99;

/** 从 app.js 里真读一个「const XXX = {...}」对象常量（不手抄，改了 app.js 这里跟着变） */
function grabObj(name) {
  const i = src.indexOf('const ' + name);
  if (i < 0) throw new Error('app.js 里找不到 ' + name);
  const a = src.indexOf('{', i);
  const b = src.indexOf('}', a) + 1;
  return eval('(' + src.slice(a, b) + ')');
}

const sandboxDeps = {
  SIGNAL_ACCOUNT_ID,
  // custNumHtml 里还要用到 ① ② ③ ④ ⑤ 这张账号表 —— 从 app.js 真读，不手抄
  ACCT_CIRCLED: grabObj('ACCT_CIRCLED'),
  // 2026-10-10：左栏新增两套渠道符号表（Signal ⑴⑵⑶ / Telegram ∮∯∰），同样真读
  SIGNAL_GLYPH: grabObj('SIGNAL_GLYPH'),
  TELE_GLYPH: grabObj('TELE_GLYPH'),
  esc: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
};

/**
 * 🔴 关键：真正执行 app.js 里的源码，不是抄一遍。
 * 用 new Function 把依赖当参数注进去，body 里就能访问这些依赖。
 *
 * 注意 custNumHtml 内部会调 isSignalCustomer，所以三个函数必须
 * **在同一批参数里**一起注入（isSignalCustomer 要排在custNumHtml 前面）。
 */
function loadRealBatch(names, deps) {
  const code = names.map(grabFn).join('\n\n');
  const keys = Object.keys(deps);
  const fn = new Function(...keys, code + `\nreturn { ${names.join(', ')} };`);
  return fn(...keys.map(k => deps[k]));
}
const rowSeenAt = {};
const { isSignalCustomer, isTelegramCustomer, signalInstanceNo, teleInstanceNo, signalTagHtml, custNumHtml } =
  loadRealBatch(
    ['isSignalCustomer', 'isTelegramCustomer', 'signalInstanceNo', 'teleInstanceNo', 'signalTagHtml', 'custNumHtml'],
    { ...sandboxDeps, rowSeenAt }
  );

console.log('\n【①】isSignalCustomer 判定');
ok(isSignalCustomer({ channel: 'signal' }), 'channel=signal → 是 Signal');
ok(isSignalCustomer({ channel: 'SIGNAL' }), 'channel=SIGNAL（大写）→ 也是（已转小写）');
ok(isSignalCustomer({ channel: ' Signal ' }), 'channel=" Signal "（带空格）→ 也是（已trim）');
ok(isSignalCustomer({ account_id: 99 }), 'account_id=99 → 是 Signal（兜底条件）');
ok(isSignalCustomer({ channel: 'signal', account_id: 1 }), 'channel=signal + account_id=1 → 是 Signal');
ok(!/\bconst SIGNAL_TAG_LETTERS\b/.test(src), 'SIGNAL_TAG_LETTERS 常量定义已删除（改作图标，注释里提到不算）');

console.log('\n【②】WhatsApp 客户绝不能被误判（最重要）');
const waCases = [
  { channel: 'whatsapp', account_id: 1, tag: '主号' },
  { channel: 'whatsapp', account_id: 2, tag: '二号' },
  { channel: 'whatsapp', account_id: 5, tag: '五号' },
  { channel: '', account_id: 1, tag: '老数据 channel 为空' },
  { channel: null, account_id: 3, tag: 'channel 为 null' },
  { account_id: 1, tag: '根本没有 channel 字段' },
  { channel: 'manual', account_id: 1, tag: '手动录入' },
];
for (const c of waCases) {
  ok(!isSignalCustomer(c), `${c.tag}（channel=${JSON.stringify(c.channel)}, account_id=${c.account_id}）→ 不是 Signal`);
  ok(!isTelegramCustomer(c), `${c.tag} → 也不是 Telegram`);
}
ok(!isSignalCustomer(null), '传null → 不是 Signal（不崩）');
ok(!isSignalCustomer(undefined), '传 undefined → 不是 Signal（不崩）');
ok(!isSignalCustomer({}), '传空对象 → 不是 Signal');
ok(isTelegramCustomer({ channel: 'telegram' }), 'channel=telegram → 是 Telegram');
ok(isTelegramCustomer({ channel: ' TG ' }), 'channel=" TG " → 也是（大写+空格都能认）');
ok(isSignalCustomer({ channel: 'telegram' }) === false, '🔴 Telegram 客户绝不能同时被判成 Signal');

console.log('\n【③】SIGNAL 标签渲染 = 原装图标（20×20）');
const html = signalTagHtml();
console.log('  实际输出：' + html);
ok(html.includes('class="ch-signal"'), '带 class="ch-signal"（CSS 钩子）');
ok(html.includes('title='), '带 title（鼠标悬停有说明）');
ok(html.includes('/img/signal.svg'), '引用 public/img/signal.svg（Signal 原装图标）');
ok(html.includes('width="20"') && html.includes('height="20"'), '图标尺寸写死 20×20');
ok(html.includes('alt="Signal"'), 'alt 文本为 Signal');
ok(!/<span style="color:/.test(html), '🔴 不再有逐字彩色（旧方案已作废）');

console.log('\n【④】标签在 renderChatHead 里被正确调用');
const headSrc = src.slice(src.indexOf('function renderChatHead'));
ok(/isSignalCustomer\(c\)\s*\?\s*signalTagHtml\(\)\s*:\s*''/.test(headSrc),
  '头部按条件插入：Signal 才渲染，WhatsApp 渲染空串');

console.log('\n【⑤】左栏 ⑴⑵⑶ 标记 = 真跑 custNumHtml 看输出');
const sigRow = custNumHtml({ code: '1S00001', channel: 'signal', account_id: 99, unread: 0, pending: 0 });
console.log('  Signal 客户（无新消息）→ ' + sigRow);
ok(sigRow.includes('row-signal'), 'Signal 客户输出 row-signal');
ok(sigRow.includes('⑴'), '用的是 ⑴（2026-10-10 老板定：◉ 换成 ⑴⑵⑶）');
ok(!sigRow.includes('◉'), '🔴 不再出现旧的 ◉');
ok(!sigRow.includes('①') && !sigRow.includes('②') && !sigRow.includes('③')
   && !sigRow.includes('④') && !sigRow.includes('⑤'), '🔴 不出现任何圈数字');
ok(!sigRow.includes('class="dot"'), '🔴 没新消息时也不退化成小圆点（否则看不出是 Signal）');
ok(sigRow.includes('Signal 客户'), 'title 里说明了是 Signal 客户');

// Telegram 客户（2026-10-10 老板定）：左端用 ∮ ∯ ∰，常驻不消失
const teleRow = custNumHtml({ code: '1T00001', channel: 'telegram', account_id: 7, unread: 0, pending: 0 });
console.log('  Telegram 客户（无新消息）→ ' + teleRow);
ok(teleRow.includes('row-tele'), 'Telegram 客户输出 row-tele');
ok(teleRow.includes('∮'), '实例 1 用 ∮');
ok(!teleRow.includes('class="dot"'), '🔴 没新消息时也不退化成小圆点');
ok(teleRow.includes('Telegram 客户'), 'title 里说明了是 Telegram 客户');
const tele3 = custNumHtml({ code: '1T00003', channel: 'telegram', account_id: 9, unread: 1, pending: 0 });
ok(tele3.includes('∰'), '实例 3 用 ∰（∮ ∯ ∰ 三个符号各有归属）');

const waNoMsg = custNumHtml({ code: '1A00004', channel: 'whatsapp', account_id: 1, unread: 0, pending: 0 });
console.log('  WhatsApp 客户（无新消息）→ ' + waNoMsg);
ok(waNoMsg.includes('class="dot"'), 'WhatsApp 无消息仍退回小圆点（行为没变）');
const waUnread = custNumHtml({ code: '1A00004', channel: 'whatsapp', account_id: 1, unread: 2, pending: 0 });
console.log('  WhatsApp 客户（2 条未读）→ ' + waUnread);
ok(waUnread.includes('row-num') && waUnread.includes('①'), 'WhatsApp 有未读仍显示 ①');
ok(!waUnread.includes('row-signal'), '🔴 WhatsApp 客户绝不出现 Signal 标记');
ok(!waUnread.includes('row-tele'), '🔴 WhatsApp 客户绝不出现 Telegram 标记');
const waAcct5 = custNumHtml({ code: '1A00009', channel: 'whatsapp', account_id: 5, unread: 1, pending: 0 });
ok(waAcct5.includes('⑤'), '五号账号仍显示 ⑤');

console.log('\n【⑥】CSS 样式存在');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
ok(/\.cust \.row-signal\s*\{/.test(css), 'CSS 有 .cust .row-signal 规则');
ok(/\.cust \.row-tele\s*\{/.test(css), 'CSS 有 .cust .row-tele 规则');
// 注意选择器是 `.cust.pending`（无空格，同 .cust .row-num.red 那套写法），
// 不是 `.cust .pending` —— 后者永远匹配不上。
ok(/\.cust\.pending \.row-signal\s*\{/.test(css), 'CSS 有 pending 态（待处理时变红）');
ok(/\.cust\.pending \.row-tele\s*\{/.test(css), 'CSS 有 row-tele 的 pending 态');
ok(/#chat-head \.ch-name \.ch-signal\s*\{/.test(css), 'CSS 有 #chat-head .ch-name .ch-signal 规则');
ok(/#chat-head \.ch-name \.ch-signal \.ch-signal-ico\s*\{/.test(css), 'CSS 有 .ch-signal-ico 图标尺寸规则');
ok(/width:\s*20px/.test(css) && /height:\s*20px/.test(css), '图标 CSS 固定 20×20 像素');
ok(css.includes('var(--accent)'), '用的是实际存在的 --accent 变量');
ok(!/\.cust \.row-signal\s*\{[^}]*var\(--blue\)/.test(css),
  '🔴 没有用到不存在的 --blue 变量（会解析失败导致无色）');

console.log(`\n通过：${pass}　失败：${fail}`);
process.exit(fail ? 1 : 0);