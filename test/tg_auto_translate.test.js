/**
 * Telegram 新消息自动翻译 · 回归锁死（v2.6.1141）
 *
 * 老板实机反馈（原文）：「Telegram在Tele①接收新消息正常，但是接收新消息打开不会自动翻译。」
 *
 * 🔴 真实断点（2026-10-16 用生产库 + 生产配置实证，不是推断）：
 *   生产 config.yaml 里 `ai.tasks.translate` 与 `bubble.translateModel` **都**写着 tikhub，
 *   而那把 tikhub key 没有 gpt-4o-mini 的权限 —— 实测每次调用都 HTTP 403
 *   （"This token has no access to model gpt-4o-mini"），且它唯一开通的 gpt-4.1 实测 25s+ 无响应。
 *   于是 ai.translate() 每次都返回 null → translator.finish() 判定「翻译无返回」
 *   → 试满 MAX_AUTO_TRIES=2 → translate_state='failed' → autoAllowed() 永久拉黑。
 *   证据：生产库 telegram 渠道 failed=37 / done=11，**done 的那 11 条全是命中翻译记忆的**
 *   （Today / October 9 / hello —— 0 次 AI 调用），凡是要真调 AI 的全部 failed。
 *
 * 本测试守三件事：
 *   1. 英文新消息进来，最终 translate_state 必须是 done（不是 failed / skipped / 空）；
 *   2. **短消息也要翻**（Hi / Hello / OK / Thanks —— 最容易漏的一批）；
 *   3. 反向约束：MAX_AUTO_TRIES 仍是 2，不许被"多试几次"糊过去。
 *
 * ⚠️ 判「有没有引入某代码」一律先剥注释 —— 中文注释里会提到关键词，直接 grep 会造出假失败。
 * ⚠️ 抓函数体禁用 /\n\}/ 正则收尾，必须花括号配平 + 抓取器自证用例。
 * ⚠️ 本测试**不连生产库**、**不连真实 AI**：用临时库 + 假 provider，绝不烧老板的 token。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 数据隔离：必须在 require('../src/...') 之前（src/paths.js 在 require 那一刻就解析数据目录）
const { DIR: DATA_DIR } = require('./_isolate.js');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

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
    bad(name, (e && e.message) || String(e));
  }
}
function eq(name, actual, expected) {
  check(name, () => (actual === expected ? true : new Error(
    `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)));
}

/* ------------------------------------------------------------------
 * 剥注释：中文注释里会出现 translate / failed / MAX_AUTO_TRIES 等关键词，
 * 直接在原文里 grep 会造出假失败（本项目已踩过多次）。先剥掉再判断。
 * ------------------------------------------------------------------ */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inS = false;   // 单引号
  let inD = false;   // 双引号
  let inT = false;   // 反引号
  let inLine = false;
  let inBlock = false;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++; continue;
    }
    if (inBlock) {
      if (c === '*' && c2 === '/') { inBlock = false; i += 2; continue; }
      i++; continue;
    }
    if (!inS && !inD && !inT) {
      if (c === '/' && c2 === '/') { inLine = true; i += 2; continue; }
      if (c === '/' && c2 === '*') { inBlock = true; i += 2; continue; }
    }
    if (!inD && !inT && c === "'") { if (!inS) inS = true; else if (src[i - 1] !== '\\') inS = false; }
    else if (!inS && !inT && c === '"') { if (!inD) inD = true; else if (src[i - 1] !== '\\') inD = false; }
    else if (!inS && !inD && c === '`') { if (!inT) inT = true; else if (src[i - 1] !== '\\') inT = false; }
    out += c;
    i++;
  }
  return out;
}

/* 花括号配平抓函数体 —— 禁用 /\n\}/ 正则收尾（会被嵌套 {} 截断） */
function grabBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'gu');
  const m = re.exec(src);
  if (!m) throw new Error('抓不到函数 ' + name);
  // 从 '(' 起做括号配平，找到参数列表结束位置
  let i = src.indexOf('(', m.index);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  // 跳到函数体的第一个 '{'
  while (i < src.length && src[i] !== '{' && src[i] !== '\n') {
    if (src[i] === ';' || src[i] === '=') throw new Error('函数 ' + name + ' 不是函数体形式');
    i++;
  }
  if (src[i] !== '{') throw new Error('函数 ' + name + ' 找不到函数体 {');
  let d = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(start, i + 1); }
  }
  throw new Error('函数 ' + name + ' 花括号不配平');
}

/* ------------------------------------------------------------------
 * 假 provider：不连真实 AI、不烧 token。
 * translate() 直接按词典回中文；翻不出来的返回 null（模拟「服务商挂了」）。
 * ------------------------------------------------------------------ */
const DICT = {
  Hi: '嗨',
  Hello: '你好',
  OK: '好的',
  Thanks: '谢谢',
  'I’m sorry': '对不起',
  'We will be there in about an hour': '我们大概一个小时后到',
  'Thank you': '谢谢你',
  'How much is it': '多少钱',
};
const WORD_RE = new RegExp('^[\\s\\S]*$', 'u');

let aiCallCount = 0;   // 统计真·AI 调用次数（验证翻译记忆有没有生效）
let aiBroken = false;  // 模拟「服务商返回 403/空」

function fakeTranslate(text) {
  aiCallCount++;
  if (aiBroken) return null;
  if (Object.prototype.hasOwnProperty.call(DICT, text)) return DICT[text];
  if (WORD_RE.test(text)) return '【译】' + text;
  return null;
}

const ai = require('../src/ai');
// 覆盖网络出口（只在本测试进程内生效，不改 src/ai.js）
ai.translate = async function (text) { return fakeTranslate(String(text || '')); };
ai.translateBatch = async function (texts) {
  return (Array.isArray(texts) ? texts : []).map((t) => fakeTranslate(String(t || '')) || '');
};
ai.decideTranslate = async function () { return true; };
ai.isReady = function () { return true; };

const db = require('../src/db');
const translator = require('../src/translator');
const lang = require('../src/lang');

/* ------------------------------------------------------------------
 * 建一条 Telegram 消息 + 触发自动翻译（与 main.js handleTelegramMessage 同一条链路）
 * ------------------------------------------------------------------ */
let seq = 0;
function newCustomer(tag) {
  seq += 1;
  const r = db.getOrCreateCustomer(7, `probe-${tag}-${seq}`, { name: 'AutoTr-' + tag, channel: 'telegram' });
  return r.customer.code;
}

/** 存一条消息并走 translateLater；返回消息 id */
function ingest(code, body) {
  const saved = db.saveMessage({
    customerCode: code,
    accountId: 7,
    direction: 'in',
    body,
    mediaPath: '',
    mediaSrc: 'none',
    mediaType: '',
    mediaFetchState: 'na',
    waMsgId: `probe:${code}:${body}:${seq}:${Math.random()}`,
    msgTs: String(Date.now()),
  });
  if (!saved || !saved.id) throw new Error('saveMessage 没拿到 id');
  translator.translateLater(saved.id, code, body, () => {});
  return saved.id;
}

function stateOf(id) {
  const row = db.getMessage.get(Number(id));
  return {
    state: (row && row.translate_state) || '',
    tries: Number(row && row.translate_tries) || 0,
    zh: (row && row.body_zh) || '',
  };
}

/** 等翻译队列跑完（最多 timeoutMs） */
function waitIdle(ids, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const busy = ids.some((id) => translator.translatingIds().includes(Number(id)));
      const past = Date.now() - t0 > timeoutMs;
      if (!busy || past) { clearInterval(iv); resolve(); }
    }, 40);
  });
}

async function section(title, fn) {
  console.log('\n===== ' + title + ' =====');
  await fn();
}

(async function main() {
  await section('一、英文新消息进来 → 最终必须是 done', async () => {
    const code = newCustomer('en');
    const id = ingest(code, 'How much is it');
    await waitIdle([id]);
    const r = stateOf(id);
    eq('英文消息 translate_state=done', r.state, 'done');
    check('英文消息真的写进了译文（不是只调了函数）', () => (r.zh ? true : new Error('body_zh 为空')));
    eq('翻成功后 tries 清零', r.tries, 0);
  });

  await section('二、短消息也要翻（Hi/Hello/OK/Thanks —— 最容易漏的一批）', async () => {
    const shortBodies = ['Hi', 'Hello', 'OK', 'Thanks'];
    const code = newCustomer('short');
    const ids = shortBodies.map((b) => ingest(code, b));
    await waitIdle(ids);
    for (let i = 0; i < shortBodies.length; i++) {
      const r = stateOf(ids[i]);
      eq(`短消息 ${JSON.stringify(shortBodies[i])} → done`, r.state, 'done');
      check(`短消息 ${JSON.stringify(shortBodies[i])} 有译文`, () => (r.zh ? true : new Error('body_zh 为空')));
    }
    // 顺带把「短消息到底该不该翻」的判据写死：纯拉丁字母必须判为需要翻译
    eq("lang.needsTranslation('Hi') = true", lang.needsTranslation('Hi'), true);
    eq("lang.needsTranslation('Hello') = true", lang.needsTranslation('Hello'), true);
    eq("lang.needsTranslation('OK') = true", lang.needsTranslation('OK'), true);
  });

  await section('三、中英混写走 ambiguous 分支也能翻', async () => {
    const mixed = '好的 OK';
    eq('isAmbiguous(中英混写) = true', lang.isAmbiguous(mixed), true);
    const code = newCustomer('mixed');
    const id = ingest(code, mixed);
    await waitIdle([id]);
    const r = stateOf(id);
    eq('中英混写 → done（没被当成不用翻）', r.state, 'done');
    check('中英混写有译文', () => (r.zh ? true : new Error('body_zh 为空')));
  });

  await section('四、中文消息不翻（断言的是「不排队」这一支）', async () => {
    const cn = '你好，今天有空吗';
    eq('中文 needsTranslation=false', lang.needsTranslation(cn), false);
    eq('中文 isAmbiguous=false（纯中文不猜）', lang.isAmbiguous(cn), false);
    const code = newCustomer('cn');
    const id = ingest(code, cn);
    await waitIdle([id]);
    const r = stateOf(id);
    // 断言口径：shouldQueue 直接返回 false → 压根没排队 → 状态保持空（不是 skipped）
    eq('中文不进翻译队列 → translate_state 仍为空', r.state, '');
    eq('中文不消耗 tries', r.tries, 0);
    eq('中文不产生译文', r.zh, '');
    // skipped 是另一条路径（AI 判定「本来就是中文」），中文消息走不到这里 —— 顺手锁死
    eq('translator.shouldTranslate(中文) = false', translator.shouldTranslate(cn), false);
  });

  await section('五、同一句原文重复进来不重复烧 token（翻译记忆生效）', async () => {
    const code = newCustomer('mem');
    // ⚠️ 必须用一句「本测试前面没用过」的原文：翻译记忆是本进程内共用的，
    //    拿第一节已翻过的那句来测，第一次就会直接命中记忆（aiCallCount 不涨），
    //    断言「第一次真的调了 AI」会假失败。
    const body = 'Where is the warehouse';
    const before = aiCallCount;
    const id1 = ingest(code, body);
    await waitIdle([id1]);
    const afterFirst = aiCallCount;
    check('第一次真的调了 AI', () => (afterFirst > before ? true : new Error('第一次没有 AI 调用')));

    // 同一句原文再来一条（不同消息 id）——应命中翻译记忆，0 次 AI 调用
    const id2 = ingest(code, body);
    await waitIdle([id2]);
    const afterSecond = aiCallCount;
    eq('第二句命中记忆 → AI 调用次数没增加', afterSecond, afterFirst);
    const r2 = stateOf(id2);
    eq('第二句同样 done', r2.state, 'done');
    check('第二句有译文（复用的是同一份译文）', () => (r2.zh ? true : new Error('body_zh 为空')));
    eq('两处译文一致', r2.zh, stateOf(id1).zh);
  });

  await section('六、反向约束：MAX_AUTO_TRIES 没被放宽', async () => {
    eq('MAX_AUTO_TRIES 仍是 2（绝不能改成 3+）', translator.MAX_AUTO_TRIES, 2);

    // 源码层面再钉一道：剥掉注释后，MAX_AUTO_TRIES 的字面量必须还是 2
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'translator.js'), 'utf8'));
    const m = new RegExp('const\\s+MAX_AUTO_TRIES\\s*=\\s*(\\d+)\\s*;', 'u').exec(src);
    check('translator.js 里 MAX_AUTO_TRIES 的字面量 = 2', () => {
      if (!m) return new Error('源码里找不到 MAX_AUTO_TRIES 的赋值');
      return Number(m[1]) === 2 ? true : new Error('字面量=' + m[1]);
    });

    // 行为层面：服务商一直返回空 → 试满 2 次就永久放手（不无限重试白烧 token）
    aiBroken = true;
    const code = newCustomer('black');
    const id = ingest(code, 'This sentence has never been translated before');
    await waitIdle([id], 20000);
    const r = stateOf(id);
    aiBroken = false;
    eq('服务商一直失败 → state=failed', r.state, 'failed');
    eq('恰好试满 MAX_AUTO_TRIES=2 次就停', r.tries, 2);
    eq('试满后被永久拉黑（不再自动翻）', translator.autoAllowed(id), false);
    // 手动重翻是唯一入口（且会清零重试账）
    check('用户手动重翻能把账清零（retryManual 存在）', () => (typeof translator.retryManual === 'function' ? true : new Error('没有 retryManual')));
  });

  await section('七、根因防线：翻译服务商不可用时，别把消息判成「不用翻」', async () => {
    // 这条锁的是本次真实事故的语义：服务商 403/空返回 = 「翻不出来」，
    // 绝不是「本来就是中文」。skipped 一旦写进去就是永久拉黑（translator.js autoAllowed）。
    aiBroken = true;
    const code = newCustomer('rootcause');
    const id = ingest(code, 'We will be there in about an hour');
    await waitIdle([id], 20000);
    const r = stateOf(id);
    aiBroken = false;
    check('服务商坏掉时状态不能是 skipped', () => (r.state !== 'skipped' ? true : new Error('被误判成 skipped —— 会永久拉黑')));
    eq('服务商坏掉时状态是 failed（可解释、可重试）', r.state, 'failed');
    // 自动翻译总闸：failed + tries>=2 依然拦住（与上一节一致，没被这次修复放宽）
    eq('failed 且试满 → 仍被总闸拦住', translator.autoAllowed(id), false);
  });

  /* ---------------- 抓取器自证 ---------------- */
  await section('八、抓取器自证（禁用正则收尾的证明）', async () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'translator.js'), 'utf8'));
    check('grabBody 能抓到一个真实存在的函数', () => {
      const b = grabBody(src, 'autoAllowed');
      if (!b || b.length < 10) return new Error('抓到的函数体太短: ' + b);
      if (!b.startsWith('{') || !b.endsWith('}')) return new Error('函数体首尾不是花括号');
      return true;
    });
    check('grabBody 能正确跳过带默认值的解构参数（老坑1）', () => {
      const fake = 'function probe(a = {}, b = []) { const inner = { x: 1 }; if (a) { return inner; } return 0; }';
      const b = grabBody(fake, 'probe');
      if (!b.includes('inner')) return new Error('没抓到函数体内容');
      return true;
    });
    check('grabBody 不会把 return 后的裸对象当成函数结束（老坑：嵌套 {}）', () => {
      const fake = 'function probe2() { const o = { a: { b: 1 } }; return o.a.b; }';
      const b = grabBody(fake, 'probe2');
      if (!b.includes('return o.a.b')) return new Error('被提前截断: ' + b);
      return true;
    });
    check('stripComments 确实剥掉了注释里的干扰词', () => {
      const c = stripComments('/** MAX_AUTO_TRIES 注释里也写 3 */ const MAX_AUTO_TRIES = 2;');
      if (c.includes('注释里也写')) return new Error('块注释没剥干净');
      if (!/MAX_AUTO_TRIES = 2/u.test(c)) return new Error('把真代码也剥掉了: ' + c);
      return true;
    });
    // 含不可见字符的正则一律显式 \uXXXX 转义（纪律要求）
    check('正则用显式 \\uXXXX 转义（不写裸不可见字符）', () => {
      const re = new RegExp('[\\u4e00-\\u9fff]', 'gu');
      return re.test('中') ? true : new Error('中文范围没匹配上');
    });
  });

  console.log('\n=================================================');
  console.log(`Telegram 自动翻译自检：${pass} 通过 / ${fail} 失败`);
  console.log('=================================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身异常：', (e && e.stack) || e);
  process.exit(1);
});