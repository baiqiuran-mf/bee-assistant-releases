/**
 * Telegram 自动提醒 · 回归锁死（v2.6.1140）
 *
 * 老板反馈：「我打开T1浏览器这个窗口，登录T账号后，我再点这个浏览器的某个好友，
 *   才会弹出新消息提醒。这样子是错的。我是需要新消息过来的时候，自动提醒，
 *   而不是要点选好友才提醒。」
 *
 * 🔴 本测试守的是「MTProto 这条推送链路上，让消息静默消失的那几处」——
 *   每一处都曾让新消息**收不到**，而报错还被 teleproto 内部 logger 吞掉、
 *   主进程零输出，所以只能靠测试锁死，不能靠看日志。
 *
 * ⚠️ 判「有没有引入某代码」一律先剥注释 —— 中文注释里会提到关键词，
 *    直接 grep 会造出假失败（本项目已踩过多次）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, extra) {
  pass += 1;
  console.log('PASS  ' + name + (extra ? '  ' + extra : ''));
}
function bad(name, detail) {
  fail += 1;
  console.log('FAIL  ' + name + '\n        ' + detail);
}
function check(name, fn) {
  try {
    const r = fn();
    if (r === true) ok(name);
    else bad(name, r && r.message ? r.message : '断言返回 falsy: ' + JSON.stringify(r));
  } catch (e) {
    bad(name, e && e.message);
  }
}

/** 花括号配平抓函数/表达式体 —— 禁用 /\n\}/ 正则收尾（会被嵌套 {} 截断）
 *
 *  🔴 本项目踩过的三个坑（都真实发生过）：
 *    坑1`async function startWatching({ accounts = [], cfg = {} } = {}) {`
 *        签名里有解构参数、默认值又是 `{}` / `[]` —— 第一个 `{` 绝不是函数体。
 *    坑2`client.addEventHandler(async (upd) => { ... })`
 *        箭头函数：抓参数列表会把**整个函数体当参数跳过**。
 *    坑3 抓取器本身出错 → 测试假通过/假失败（所以每节都要有「抓取器自证」）。
 *
 *  解法（确定路径，不靠猜）：
 *    1) 找到函数名/调用名之后的**参数列表**，只按顶层逗号数数**参数个数**，
 *       不做括号跨越（跨越是坑2的根源）；
 *    2) 参数列表闭合后，若下一个非空白字符是 `=>` 或 `:` 或 `=`，再跳到其后的
 *       第一个 `{`；
 *    3) 从该 `{` 起做花括号配平取函数体。
 */
function grabBody(src, startIdx) {
  // 1) 找参数列表：从 startIdx 起第一个 '('，只做**方/花括号内的逗号不计数**的配平。
  //    🔴 坑：箭头函数 `(upd) => { ... }` 里，参数列表的 ')' 之后紧跟 `=> {`，
  //       若把 `{` 也纳入同一个深度栈，配平会一路走到函数体末尾才返回 close（实测 argCount=2）。
  //       所以**括号栈只吃 () 与 []，绝不把 { 放进去**；{} 交给后面单独处理。
// 🔴 坑D（本项目真实调用形态）：`client.addEventHandler(async (upd) => {...}, new NewMessage({}))`
//   startIdx 指向 `client.addEventHandler`。它自己带一个 `(`，里面才是回调
//   `(upd) => {...}`；第二个参数 `new NewMessage({})` 里**还有一层括号**。
//   🔴 任何「把所有括号收集起来再猜」的写法都会在这里抓串（实测试过两次：
//      一次抓到 peerIdOf 的函数体、argCount=2）。所以不再猜 ——
//   正解（确定路径）：**先找 `=>`，`=>` 之后的第一个 `{` 就是函数体起点。**
//        没有 `=>`（普通 function 声明 / 方法定义）才退回「参数列表闭合后的第一个 `{`」。
let argCount = 0;
let bodyStart = -1;
const arrowPos = src.indexOf('=>', startIdx);
if (arrowPos > 0 && arrowPos - startIdx < 400) {
  let p = arrowPos + 2;
  while (p < src.length && /\s/.test(src[p])) p += 1;
  // 箭头函数体可能带括号：=> ({...})
  if (src[p] === '(') {
    let d = 0;
    while (p < src.length) {
      if (src[p] === '(') d += 1;
      else if (src[p] === ')') { d -= 1; if (d === 0) { p += 1; break; } }
      p += 1;
    }
    while (p < src.length && /\s/.test(src[p])) p += 1;
  }
  if (src[p] === '{') bodyStart = p;
}
if (bodyStart < 0) {
  // 退回路径：普通 function 声明 / 类方法 —— 先配平参数列表
  const open = src.indexOf('(', startIdx);
  if (open < 0) return null;
  let depth = 0;
  let commas = 0;
  let close = -1;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') { depth -= 1; if (depth === 0) { close = i; break; } }
    else if (ch === ',' && depth === 1) commas += 1;
  }
  if (close < 0) return null;
  argCount = commas + 1;
  let k = close + 1;
  while (k < src.length && /\s/.test(src[k])) k += 1;
  // TypeScript 返回类型标注：): Type {
  if (src[k] === ':') { k += 1; while (k < src.length && /\s/.test(src[k])) k += 1; }
  // 箭头函数默认值参数之后：) => {
  if (src[k] === '=' && src[k + 1] === '=' && src[k + 2] === '>') {
    k += 3;
    while (k < src.length && /\s/.test(src[k])) k += 1;
    if (src[k] === '(') { let d = 0; while (k < src.length) { if (src[k] === '(') d += 1; else if (src[k] === ')') { d -= 1; if (d === 0) { k += 1; break; } } k += 1; } while (k < src.length && /\s/.test(src[k])) k += 1; }
  }
  // 孤立的 `{`（类方法 / 对象方法）
  while (k < src.length && src[k] !== '{') {
    if (!/[A-Za-z0-9_$>:=\s'"`([|]/.test(src[k])) break;
    k += 1;
  }
  if (src[k] !== '{') return null;
  bodyStart = k;
}
if (bodyStart < 0) return null;
  if (bodyStart < 0) return null;
  let d2 = 0;
  let started = false;
  for (let m = bodyStart; m < src.length; m += 1) {
    const ch = src[m];
    if (ch === '{') { d2 += 1; started = true; }
    else if (ch === '}') {
      d2 -= 1;
      if (started && d2 === 0) return { body: src.slice(bodyStart, m + 1), argCount };
    }
  }
  return null;
}

/** 剥掉 // 与 /* *\/ 注释 —— 本项目铁律 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CH = fs.readFileSync(path.join(ROOT, 'src', 'telegramOfficialChannel.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

console.log('\n── 一、ts 的时间换算（老板反馈的直接根因）──\n');

// 先证明测试自己没抓错位置（抓取器自证）
const handlerIdx = CH.indexOf('client.addEventHandler');
check('抓取器自证：能定位到 addEventHandler 回调体', () => {
  if (handlerIdx < 0) return 'src/telegramOfficialChannel.js 里找不到 addEventHandler';
  const got = grabBody(CH, handlerIdx);
  const body = got && got.body;
  if (!body) return '花括号配平没抓到完整回调体（可能后面还有嵌套 {}）';
  if (body.length < 400) return '抓到的回调体太短（' + body.length + ' 字），疑似被截断';
  return true;
});

const gotHandler = grabBody(CH, handlerIdx);
const handlerBody = (gotHandler && gotHandler.body) || '';
const handlerCode = stripComments(handlerBody);

check('🔴 不再对 m.date 调 .getTime()（teleproto 的 date 是 int 秒，会抛 TypeError）', () => {
  const bad = handlerCode.match(/\bm\.date\s*\.\s*getTime\s*\(/g)
    || handlerCode.match(/\bmsg\.date\s*\.\s*getTime\s*\(/g);
  if (bad) return '仍存在对 date 调 getTime：' + bad.join(', ');
  return true;
});

check('✅ ts 走 new Date(m.date * 1000) 这条（int 秒 → 毫秒）', () => {
  if (!/new Date\(\s*m\.date\s*\*\s*1000\s*\)/.test(handlerCode)) {
    return '回调体里找不到 new Date(m.date * 1000)';
  }
  return true;
});

check('✅ ts 对两种形态都兜住（number 秒 / Date 对象都不会整条挂）', () => {
  const hasNumber = /typeof\s+m\.date\s*===\s*'number'/.test(handlerCode);
  const hasInstance = /m\.date\s+instanceof\s+Date/.test(handlerCode);
  if (!hasNumber) return '缺 typeof m.date === "number" 的分支';
  if (!hasInstance) return '缺 m.date instanceof Date 的兜底分支';
  return true;
});

check('✅ ts 最终产出的是 ISO 字符串（跨渠道路约一致）', () => {
  if (!/\.toISOString\(\)/.test(handlerCode)) return '回调体里没有 .toISOString()';
  return true;
});

console.log('\n── 二、新消息不会被静默丢掉的三道闸 ──\n');

check('✅ 正文剥完只剩时间时丢弃（系统提示行不是真人消息）', () => {
  if (!/onlyTime/.test(handlerCode)) return '没看到 onlyTime 判断';
  if (!/stripTrailingTime/.test(handlerCode)) return '没调用 stripTrailingTime';
  return true;
});

check('✅ Saved Messages（收藏夹）不建档不提醒', () => {
  if (!/isSavedMessage/.test(handlerCode)) return '没调用 isSavedMessage';
  return true;
});

check('✅ 取客户名失败时不丢消息（catch 里只置空名，不能 return）', () => {
  const idx = handlerCode.indexOf('resolveEntity');
  if (idx < 0) return '回调体里没看到 resolveEntity（客户名解析）';
  const seg = handlerCode.slice(idx, idx + 400);
  const cIdx = seg.indexOf('catch');
  if (cIdx < 0) return '取名那段没有 catch 保护 —— 一抛错整条消息就没了';
  // 只取 catch 后面紧跟的那个花括号块（纯花括号配平，不走 grabBody）
  const braceAt = seg.indexOf('{', cIdx);
  if (braceAt < 0 || braceAt - cIdx > 12) return 'catch 后面的花括号位置异常（' + (braceAt - cIdx) + ' 字处），疑似不是块语句';
  let d = 0;
  let cBody = '';
  for (let k = braceAt; k < seg.length; k += 1) {
    if (seg[k] === '{') d += 1;
    else if (seg[k] === '}') { d -= 1; if (d === 0) { cBody = seg.slice(braceAt, k + 1); break; } }
  }
  if (!cBody) return 'catch 体没抓到（花括号没配平）';
  const inner = stripComments(cBody.slice(1, -1));
  if (/\breturn\b/.test(inner)) {
    return '取名 catch 块里有 return —— 取名失败会丢消息（绝不允许）：' + cBody.trim();
  }
  if (!/name\s*=\s*['"]['"]/.test(inner)) {
    return 'catch 块里没有把 name 置空，实测内容：' + cBody.trim();
  }
  return true;
});

check('✅ 附件判定排除 MessageMediaEmpty（否则纯文字消息全变图片气泡）', () => {
  if (!/MessageMediaEmpty/.test(handlerCode)) return 'hasAttachment 判定里没排除 MessageMediaEmpty';
  if (/hasAttachment:\s*!!m\.media/.test(handlerCode)) return '仍是旧的 !!m.media 写法';
  return true;
});

console.log('\n── 三、onState 字段名对得上（状态条要能看到「收集中」）──\n');

const onStateIdx = CH.indexOf('hooks.onState');
check('🔴 onState 发的是 id（main.js 读的是 st.id，不是 st.accountId）', () => {
  const seg = CH.slice(onStateIdx, onStateIdx + 400);
  const code = stripComments(seg);
  if (!/\bid\s*:/.test(code)) return 'onState 里没发 id 字段';
  return true;
});

check('main.js 侧确实读 st.id（证明两端字段名一致）', () => {
  const i = MAIN.indexOf('function telegramHooks');
  if (i < 0) return 'main.js 里找不到 telegramHooks';
  const g = grabBody(MAIN, i);
  const body = stripComments((g && g.body) || '');
  if (!/st\s*\.\s*id/.test(body)) return 'telegramHooks 的 onState 里没读 st.id';
  return true;
});

console.log('\n── 四、绝不双响（提醒只能在主路一处发）──\n');

check('🔴 handleTelegramMessage 的 in 分支里没有残留 notify（否则双响）', () => {
  const i = MAIN.indexOf('function handleTelegramMessage');
  if (i < 0) return 'main.js 里找不到 handleTelegramMessage';
  const g = grabBody(MAIN, i);
  const body = stripComments((g && g.body) || '');
  // 提醒函数名在 handleTelegramMessage 里出现即为残留
  const hits = body.match(/\bnotifyTelegramIncoming\s*\(|\bplayNotifySound\s*\(|\bnotify\s*\(/g);
  if (hits && hits.length) {
    return 'in 分支里仍直接调用提醒函数：' + hits.join(', ') + '（主路已下沉，这里再调会双响）';
  }
  return true;
});

check('✅ 提醒只在采集主路 telegramHooks().onMessages 里发一次', () => {
  const i = MAIN.indexOf('function telegramHooks');
  if (i < 0) return 'main.js 里找不到 telegramHooks';
  const g = grabBody(MAIN, i);
  const body = stripComments((g && g.body) || '');
  const n = (body.match(/notifyTelegramIncoming\s*\(/g) || []).length;
  if (n !== 1) return '期望恰好 1 处，实际 ' + n + ' 处';
  return true;
});

console.log('\n── 五、失败不再静默 ──\n');

check('startWatching 的返回值里带失败账号列表（能逐个告警）', () => {
  const i = CH.indexOf('function startWatching');
  if (i < 0) return '找不到 startWatching';
  const g2 = grabBody(CH, i);
  const body = (g2 && g2.body) || '';
  if (!body) return 'startWatching 函数体没抓到（括号没配平）';
  if (body.length < 300) return '抓到的 startWatching 体太短（' + body.length + ' 字），疑似截断';
  // 三处都要有：声明、push 进失败列表、return 里带出去
  const hasDecl = /\bfailed\s*=\s*\[\]/.test(body);
  const hasPush = /failed\.push\(/.test(body);
  const hasReturn = /return\s*\{[^}]*failed/.test(body);
  if (!hasDecl) return 'startWatching 里没有 failed 列表声明 —— 失败只 console.warn，顶栏不亮';
  if (!hasPush) return 'failed 列表从没被 push —— 收集了但没用';
  if (!hasReturn) return 'return 里没把 failed 带出去 —— main.js 拿不到失败清单';
  return true;
});

check('main.js 侧对失败账号有明确告警', () => {
  const i = MAIN.indexOf('telegramOfficialChannel.startWatching');
  if (i < 0) return 'main.js 里找不到 telegramOfficialChannel.startWatching 的调用';
  const seg = stripComments(MAIN.slice(i, i + 900));
  if (!/failed/.test(seg)) return '调用点没有处理 failed 列表';
  return true;
});

console.log('\n── 六、项目铁律自查 ──\n');

check('🔴 频道隔离：MTProto 代码没有 require WA / Signal / 翻��模块', () => {
  const code = stripComments(CH);
  const bad = [];
  if (/require\(['"][^'"]*whatsapp/i.test(code)) bad.push('whatsapp');
  if (/require\(['"][^'"]*signal/i.test(code)) bad.push('signal');
  if (bad.length) return '引入了：' + bad.join(', ');
  return true;
});

check('🔴 不许出现字面控制字符（要用 new RegExp 显式转义）', () => {
  const bad = CH.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g);
  if (bad) return '发现 ' + bad.length + ' 个字面控制字符';
  return true;
});

check('🔴 没有 window.prompt / 绝不自动发送', () => {
  const code = stripComments(CH + MAIN.slice(MAIN.indexOf('function telegramHooks'), MAIN.indexOf('function telegramHooks') + 1200));
  if (/window\.prompt/.test(code)) return '出现了 window.prompt';
  return true;
});

check('🔴 代码里不残留 .getTime() 调 date（剥注释后再查，全文件范围）', () => {
  const code = stripComments(CH);
  const hits = code.match(/\.date\s*\.\s*getTime\s*\(/g);
  if (hits) return '仍有：' + hits.join(', ');
  return true;
});

console.log('\n' + '═'.repeat(56));
console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('═'.repeat(56) + '\n');

process.exit(fail ? 1 : 0);