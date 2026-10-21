/**
 * tools/probe_tg_notify_mainline.js —— v2.6.1139「Telegram 新消息提醒下沉到采集主路」实测探针
 * ============================================================================
 * 老板报的现象：「你并没有给我提醒新消息，而是我点了消息后才提醒有新消息。」
 *
 * 本探针要证明三件事（用**真代码路径**，不是复制副本）：
 *   ① 一条 direction==='in' 的新消息 → 通知 1 次、提示音按开关生效
 *   ② 一条 direction==='out' 的消息   → 通知 0 次（我方发出的绝不提醒）
 *   ③ 同一条 in 消息重复采集两次      → 通知**仍只1 次**（不重复弹）
 *
 * 🔴 关键做法：被测函数**全部从 src/main.js 原文按花括号配平抠出来**再执行，
 *    所以测的就是磁盘上那份真代码，改一个字符这里立刻测不出来。
 *    只有最外层的副作用（notify / playNotifySound / broadcastSafe / notice）
 *    换成注入桩，好数调用次数；db 与 telegramMerge 用**真模块 + 真临时库**，
 *    这样 wa_msg_id 撞唯一键 → changes=0 这条去重判据是**真跑出来的**。
 *
 * 跑法：node tools/probe_tg_notify_mainline.js
 *（数据隔离到 .tmp-test-data/，绝不碰真实 data/assistant.db）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// 🔴 数据隔离必须放在任何 require('../src/...') 之前（src/paths.js 在 require 那刻解析目录）
const ROOT = path.join(__dirname, '..');
const { DIR: DATA_DIR } = require(path.join(ROOT, 'test', '_isolate.js'));

const db = require(path.join(ROOT, 'src', 'db.js'));
const telegramMerge = require(path.join(ROOT, 'src', 'telegramMerge.js'));

const MAIN_JS = path.join(ROOT, 'src', 'main.js');
const mainSrc = fs.readFileSync(MAIN_JS, 'utf8');

/**
 * 按**花括号配平**从源码里抠出一个函数的完整函数体。
 * 🔴 绝不能用 /\n\}/ 收尾 —— 函数体里有嵌套 {}（try/catch、if），会提前截断，
 *    抠出半截函数体后测试结论全是假的。
 */
function grabFn(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, '源码里找不到：' + signature);
  const open = src.indexOf('{', start);
  assert.ok(open >= 0, signature + ' 没有花括号，不是函数');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(signature + ' 花括号没配平，源码可能被截断');
}

/** 抠出一段 const 声明（到分号为止） */
function grabConst(src, name) {
  const re = new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;');
  const m = src.match(re);
  assert.ok(m, '源码里找不到 const ' + name);
  return m[0];
}

const handleTelegramMessageSrc = grabFn(mainSrc, 'function handleTelegramMessage(');
const telegramHooksSrc = grabFn(mainSrc, 'function telegramHooks()');
const tgShouldNotifySrc = grabFn(mainSrc, 'function tgShouldNotify(');
const notifyTelegramIncomingSrc = grabFn(mainSrc, 'function notifyTelegramIncoming(');
const playNotifySoundSrc = grabFn(mainSrc, 'function playNotifySound()');

/* 🔴 关键：把真 playNotifySound 抠出来后**改名**保留。
 *   否则下面那个同名桩会因函数声明提升（hoisting）把真函数整个覆盖掉 ——
 *   那样第 5 节测的就不是真函数，而是一个假结论（这个坑真踩过一次）。 */
const realPlayNotifySoundSrc = playNotifySoundSrc.replace(
  'function playNotifySound()',
  'function realPlayNotifySound()',
);

console.log('=== 探针：Telegram 新消息提醒（v2.6.1139）===');
console.log(`数据隔离：${DATA_DIR}`);
console.log(`真代码抠取：handleTelegramMessage ${handleTelegramMessageSrc.split('\n').length} 行 / `
  + `telegramHooks ${telegramHooksSrc.split('\n').length} 行 / `
  + `tgShouldNotify ${tgShouldNotifySrc.split('\n').length} 行 / `
  + `notifyTelegramIncoming ${notifyTelegramIncomingSrc.split('\n').length} 行`);

/* ------------------------------------------------------------------ *
 * 1) 自证：抠出来的确实是真代码，不是半截 / 不是副本
 * ------------------------------------------------------------------ */
console.log('\n--- 0、先自证抠取没截断（否则下面全是假结论）---');
assert.ok(handleTelegramMessageSrc.includes('catch'), 'handleTelegramMessage 没抓到 catch');
assert.ok(telegramHooksSrc.includes('catch'), 'telegramHooks 没抓到 catch');
assert.ok(tgShouldNotifySrc.includes('catch'), 'tgShouldNotify 没抓到 catch');
assert.ok(notifyTelegramIncomingSrc.includes('catch'), 'notifyTelegramIncoming 没抓到 catch');
// 提醒只允许在主路发一次：handleTelegramMessage 里已经不该再有 notify/playNotifySound
const handleOnly = handleTelegramMessageSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
assert.ok(!/[^_a-zA-Z]notify\(/.test(handleOnly), 'handleTelegramMessage 里还有 notify() → 会双响');
assert.ok(!/playNotifySound\(/.test(handleOnly), 'handleTelegramMessage 里还有 playNotifySound() → 会双响');
// telegram_message 广播必须保留（前端 Tele①/Tele② 面板靠它刷新）
assert.ok(/broadcastSafe\('telegram_message'/.test(telegramHooksSrc), 'telegram_message 广播被删了');
console.log('  ✅ 抠出的函数体完整（有 catch、括号配平）');
console.log('  ✅ handleTelegramMessage 里已无 notify/playNotifySound（提醒只在主路发一次）');
console.log('  ✅ telegram_message 广播保留');

/* ------------------------------------------------------------------ *
 * 2) 组装沙箱：真db + 真 telegramMerge，副作用层换桩
 * ------------------------------------------------------------------ */
const calls = { notify: [], sound: [], notice: [], telegram_message: [], new_message: [] };

/** 起一套全新沙箱，返回 { onMessages, playNotifySound, cfg } */
function makeSandbox(cfgOverrides) {
  calls.notify.length = 0;
  calls.sound.length = 0;
  calls.notice.length = 0;
  calls.telegram_message.length = 0;
  calls.new_message.length = 0;

  const cfg = Object.assign(
    { app: { desktopNotify: true }, telegram: { notifySound: true } },
    cfgOverrides || {},
  );

  const sandbox = {
    console,
    db,
    telegramMerge,
    cfg,
    calls, // 桩版提示音要往里记次数
    //—— 注入桩：只拦最外层副作用，函数体本身是真代码 ——
    notify: (title, message) => { calls.notify.push({ title, message }); },
    playNotifySoundRef: null,
    broadcastSafe: (type, payload) => {
      if (type === 'telegram_message') calls.telegram_message.push(payload);
      if (type === 'new_message') calls.new_message.push(payload);
    },
    notice: (text, level) => { calls.notice.push({ text, level }); },
    // —— 其余依赖：给最小可用桩，聚焦「提醒」这一条线 ——
    prewarm: { blocked: () => false },
    TELEGRAM_ACCS: [{ id: 7 }, { id: 8 }],
    autoFetchTelegramPhone: () => {},
    translator: { needsTranslation: () => false, translateLater: () => {} },
    ai: { isReady: () => false },
    doc: { writeCustomerDoc: () => {} },
    electronBridge: { bridge: { playSound: () => true, notifyDesktop: () => true } },
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const code = [
    grabConst(mainSrc, 'TG_NOTIFY_SEEN_MAX'),
    grabConst(mainSrc, 'tgNotifiedSeen'),
    handleTelegramMessageSrc,
    tgShouldNotifySrc,
    notifyTelegramIncomingSrc,
    telegramHooksSrc,
    realPlayNotifySoundSrc,
    // 桩版提示音：和真函数同一套开关语义（notifySound !== true 就不响），
    // 用来验证「主路确实调了提示音」以及「重复采集不重复调」
    'function playNotifySound() {'
    + '  if (cfg.telegram?.notifySound !== true) return false;'
    + '  calls.sound.push(1);'
    + '  return true;'
    + '}',
    'globalThis.__hooks = telegramHooks();',
    'globalThis.__realPlayNotifySound = realPlayNotifySound;',
    // const 声明不会挂到 context 对象上（那是脚本作用域），要显式导出才能在外部检查
    'globalThis.__seen = tgNotifiedSeen;',
    'globalThis.__seenMax = TG_NOTIFY_SEEN_MAX;',
    'globalThis.__probeShouldNotify = tgShouldNotify;',
  ].join('\n\n');
  vm.runInContext(code, ctx, { filename: 'main.js-extracted.js' });

  return {
    onMessages: sandbox.__hooks.onMessages,
    realPlayNotifySound: sandbox.__realPlayNotifySound,
    ctx: sandbox,
    //🔴 直接指到 vm 里的**那一个** Set/常量（不是副本），改了才测得出来
    getSeen: () => sandbox.__seen,
    seenMax: sandbox.__seenMax,
  };
}

const nowIso = () => new Date().toISOString();

/** 造一条 MTProto 口径的统一消息结构（对齐 src/telegramMtproto.js toContract） */
function mkMsg(dir, msgId, body, chatKey) {
  return {
    accountId: 7,
    displayJid: `tg:${chatKey}`,
    customerKey: chatKey,
    msgId,
    direction: dir,
    body,
    hasAttachment: false,
    ts: nowIso(),
    name: 'Eileen Lin',
    username: null,
    phone: '',
    isGroup: false,
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  << ' + extra : ''}`); }
}

/* ------------------------------------------------------------------ *
 * 3) 情形一：一条 in 新消息 → 通知 1 次
 * ------------------------------------------------------------------ */
console.log('\n--- 1、一条 in 新消息 ---');
{
  const sb = makeSandbox();
  sb.onMessages([mkMsg('in', '1001', '你好，在吗？', '7207229390')]);
  check('通知恰好 1 次', calls.notify.length === 1, `实际 ${calls.notify.length} 次`);
  check('通知标题带客户名+ 编号', /Eileen Lin · \w+/.test(calls.notify[0] ? calls.notify[0].title : ''),
    `实际 title=${JSON.stringify(calls.notify[0] && calls.notify[0].title)}`);
  check('通知正文截断到 80 字内', calls.notify[0] && calls.notify[0].message === '你好，在吗？',
    `实际 ${JSON.stringify(calls.notify[0] && calls.notify[0].message)}`);
  check('提示音按开关生效（notifySound=true → 响 1 次）', calls.sound.length === 1,
    `实际 ${calls.sound.length} 次`);
  check('界面气泡 notice 也弹了 1 次', calls.notice.length === 1, `实际 ${calls.notice.length} 次`);
  check('telegram_message 广播仍然保留（前端面板要靠它刷新）', calls.telegram_message.length === 1,
    `实际 ${calls.telegram_message.length} 次`);
  check('消息真的入库了', (() => {
    const c = db.db.prepare(`SELECT code FROM customers WHERE account_id=7 AND wa_jid=?`).get('tg:7207229390');
    if (!c) return false;
    return db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(c.code).n === 1;
  })());
}

/* ------------------------------------------------------------------ *
 * 4) 情形二：out 消息 → 通知 0 次
 * ------------------------------------------------------------------ */
console.log('\n--- 2、一条 out 消息（我方发出，绝不提醒）---');
{
  const sb = makeSandbox();
  sb.onMessages([mkMsg('out', '2001', '我方发出的回复', '7207229390')]);
  check('通知 0 次', calls.notify.length === 0, `实际 ${calls.notify.length} 次`);
  check('提示音 0 次', calls.sound.length === 0, `实际 ${calls.sound.length} 次`);
  check('notice 气泡 0 次', calls.notice.length === 0, `实际 ${calls.notice.length} 次`);
  check('但消息仍然入库 + 广播 out_message 链路不受影响', (() => {
    const c = db.db.prepare(`SELECT code FROM customers WHERE account_id=7 AND wa_jid=?`).get('tg:7207229390');
    if (!c) return false;
    return db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=? AND direction='out'`).get(c.code).n === 1;
  })());
  check('telegram_message 广播照旧（out 也要刷新面板）', calls.telegram_message.length === 1);
}

/* ------------------------------------------------------------------ *
 * 5) 情形三：同一条 in 消息重复采集两次 → 通知仍只1 次
 * ------------------------------------------------------------------ */
console.log('\n--- 3、同一条 in 消息重复采集两次 ---');
{
  const sb = makeSandbox();
  const dup = mkMsg('in', '3001', '重复采集我这条', '7207229391');
  sb.onMessages([dup]);
  const firstRound = calls.notify.length;
  // 第二次：同一个 wa_msg_id（customerKey:msgId）→ 撞唯一键 → changes=0
  sb.onMessages([mkMsg('in', '3001', '重复采集我这条', '7207229391')]);
  check('第一次：通知 1 次', firstRound === 1, `实际 ${firstRound} 次`);
  check('重复采集后：通知仍只 1 次', calls.notify.length === 1, `实际 ${calls.notify.length} 次`);
  check('重复采集后：提示音仍只 1 次', calls.sound.length === 1, `实际 ${calls.sound.length} 次`);
  check('重复采集后：notice 仍只 1 次', calls.notice.length === 1, `实际 ${calls.notice.length} 次`);
  check('库里只有 1 行（唯一键真的挡住了重复入库）', (() => {
    const c = db.db.prepare(`SELECT code FROM customers WHERE account_id=7 AND wa_jid=?`).get('tg:7207229391');
    if (!c) return false;
    return db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(c.code).n === 1;
  })());
  // 连灌 5 次也不能多弹
  for (let i = 0; i < 5; i++) sb.onMessages([mkMsg('in', '3001', '重复采集我这条', '7207229391')]);
  check('连灌 5 次后：通知仍是 1 次', calls.notify.length === 1, `实际 ${calls.notify.length} 次`);
}

/* ------------------------------------------------------------------ *
 * 6) 去重集合有上限（不许无限增长）
 * ------------------------------------------------------------------ */
console.log('\n--- 4、已提醒集合有上限 ---');
{
  const sb = makeSandbox();
  const seen = sb.getSeen();
  check('集合初始为空', seen.size === 0, `实际 ${seen.size}`);
  check('上限常量是 500', sb.seenMax === 500, `实际 ${sb.seenMax}`);
  // 塞 600 个不同键（直接调 vm 里那个真 tgShouldNotify）
  for (let i = 0; i < 600; i++) sb.ctx.__probeShouldNotify(true, `chat${i}:msg${i}`);
  check('塞 600 个键后，集合被裁到 <= 500（丢最旧的）', seen.size <= 500, `实际 ${seen.size}`);
  check('最新的键还留着', seen.has('chat599:msg599'));
  check('最旧的键已被丢掉', !seen.has('chat0:msg0'));
}

/* ------------------------------------------------------------------ *
 * 7) 提示音开关语义（复用真 playNotifySound）
 * ------------------------------------------------------------------ */
console.log('\n--- 5、提示音开关（复用真 playNotifySound）---');
{
  const on = makeSandbox({ telegram: { notifySound: true } });
  const sentOn = [];
  on.ctx.broadcastSafe = (type) => { sentOn.push(type); };
  const rOn = on.realPlayNotifySound();
  check('notifySound=true → 真 playNotifySound 广播 notify_sound（WebAudio 兜底）',
    rOn === true && sentOn.includes('notify_sound'),
    `返回=${rOn} 广播=${JSON.stringify(sentOn)}`);
  const off = makeSandbox({ telegram: { notifySound: false } });
  const sentOff = [];
  off.ctx.broadcastSafe = (type) => { sentOff.push(type); };
  const rOff = off.realPlayNotifySound();
  check('notifySound=false → 真 playNotifySound 不广播、直接 return false（一声不响）',
    rOff === false && sentOff.length === 0,
    `返回=${rOff} 广播=${JSON.stringify(sentOff)}`);
}

/* ------------------------------------------------------------------ *
 * 8) 提醒层异常绝不能打断入库
 * ------------------------------------------------------------------ */
console.log('\n--- 6、提醒失败不许打断入库 ---');
{
  const sb = makeSandbox();
  sb.ctx.notify = () => { throw new Error('模拟系统通知炸了'); };
  sb.ctx.notice = () => { throw new Error('模拟气泡炸了'); };
  // 这一批里：第一条通知层会炸，第二条必须照样处理完（证明异常没打断整批）
  sb.onMessages([
    mkMsg('in', '4001', '提醒层要炸', '7207229392'),
    mkMsg('in', '4002', '后面这条不能被连累', '7207229393'),
  ]);
  const c = db.db.prepare(`SELECT code FROM customers WHERE account_id=7 AND wa_jid=?`).get('tg:7207229392');
  check('notify/notice 抛异常后，消息照样入库',
    !!c && db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(c.code).n === 1);
  const c2 = db.db.prepare(`SELECT code FROM customers WHERE account_id=7 AND wa_jid=?`).get('tg:7207229393');
  check('整批没有被打断：第一条之后那一条也处理完了（异常没冒到 onMessages 外面）',
    !!c2 && db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE customer_code=?`).get(c2.code).n === 1);
  check('两条消息都广播了 telegram_message（面板照常刷新）', calls.telegram_message.length === 2,
    `实际 ${calls.telegram_message.length}`);
}

/* ------------------------------------------------------------------ *
 * 9) 边界：Saved Messages（收藏夹）绝不提醒（沿用 v2.6.1136 既有约定）
 * ------------------------------------------------------------------ */
console.log('\n--- 7、边界：Saved Messages 收藏夹不提醒 ---');
{
  const sb = makeSandbox();
  const saved = mkMsg('in', '5001', '我自己的备忘', 'Saved Messages');
  saved.name = 'Saved Messages';
  sb.onMessages([saved]);
  check('Saved Messages：通知 0 次', calls.notify.length === 0, `实际 ${calls.notify.length} 次`);
  check('Saved Messages：提示音 0 次', calls.sound.length === 0, `实际 ${calls.sound.length} 次`);
  check('Saved Messages：没被建档（不在客户表里）',
    !db.db.prepare(`SELECT code FROM customers WHERE wa_jid=?`).get('tg:Saved Messages'));
}

console.log('\n=================================================');
console.log(`  探针通过 ${pass} / 失败 ${fail}`);
console.log('=================================================\n');
process.exit(fail ? 1 : 0);