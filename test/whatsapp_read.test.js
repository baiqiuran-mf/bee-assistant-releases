/**
 * WA① 内置浏览器采集内核自检（src/whatsappRead.js · v2.6.1121）
 *
 * 为什么需要这层：
 *   老板 2026-10-14 看图要求「红框内是软件内置的浏览器，我要获取这个 WhatsApp 的
 *   新消息、好友资料、还有对话信息」。真机验证要老板自己扫码登录、还要等真消息，
 *   代劳不了 —— 但**「把内部 Store 读出来 → 变成一条能入库的消息」这一段能不能成立**
 *   是可以提前钉死的。所以这里分两层：
 *     [A] 假 window.require：把 probeInPage **真跑一遍**，断言它把
 *         会话 / 联系人 / 消息 / @lid→真号码 都抠出来了、返回的是**纯数据**（能结构化克隆）。
 *     [B] 假页面：给 startWatching 注入一个假 findPage，**真跑 tick()**，
 *         断言首轮水位、只回灌最新 N 条、后续轮只收新消息、旧消息绝不回灌、
 *         一条不重复（这是最容易写错、又最难在真机上发现的一段）。
 *
 * 跑法：node --experimental-sqlite test/whatsapp_read.test.js
 */

const vm = require('vm');
const path = require('path');

process.env.BEE_TEST = '1'; // 🔴 必须在 require 之前：startWatching 据此不挂定时器

const ROOT = path.join(__dirname, '..');
const wr = require(path.join(ROOT, 'src', 'whatsappRead.js'));
const identity = require(path.join(ROOT, 'src', 'identity.js'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? `  << ${extra}` : ''}`); }
}

/* =====================================================================
 * 造一份「假 WhatsApp 网页」
 *   Store 的形状全部照实测来：
 *     · Chat.id 是 {_serialized}
 *     · Msg.id 是**裸对象** {fromMe, remote, id}（没有 _serialized）
 * ===================================================================== */
const LID_CHAT = '206459950338291@lid';
const LID_CHAT2 = '154147131236396@lid';
const PN_CHAT = '15418010646@c.us';
const GROUP_CHAT = '120363000000000000@g.us';

function t0() { return 1791433000; }

/** 网页里 WAWebCollections 的假实现 */
function makeCollections(messages) {
  return {
    Chat: {
      getModelsArray: () => ([
        { id: { _serialized: LID_CHAT }, name: 'Wanqiu lin', unreadCount: 2, t: t0() + 300 },
        { id: { _serialized: GROUP_CHAT }, name: '油画交流群', unreadCount: 5, t: t0() + 200 },
        { id: { _serialized: PN_CHAT }, name: '', unreadCount: 0, t: t0() + 100 },
      ]),
    },
    Contact: {
      getModelsArray: () => ([
        // 🔴 关键：通讯录里这个人存的是**真号码 JID**，会话侧却是 @lid
        { id: { _serialized: '85292235147@c.us' }, name: '程', pushname: 'Cheng',
          phoneNumber: { _serialized: '85292235147@c.us' }, isMyContact: true },
        { id: { _serialized: PN_CHAT }, name: '', pushname: 'Dio',
          phoneNumber: { _serialized: PN_CHAT }, isMyContact: true },
      ]),
    },
    Msg: { getModelsArray: () => messages },
  };
}

/** 在沙箱里真跑一遍 probeInPage */
function runProbe(messages) {
  const sandbox = {
    window: {
      require: (mod) => {
        if (mod === 'WAWebCollections') return makeCollections(messages);
        if (mod === 'WAWebWidFactory') return { createWid: (s) => ({ _serialized: String(s) }) };
        if (mod === 'WAWebLidMigrationUtils') {
          return {
            // 实测：toPn(154147131236396@lid) → 85292235147@c.us
            toPn: (w) => {
              const s = (w && w._serialized) || String(w);
              if (/^154147131236396|^206459950338291/.test(s)) return { _serialized: '85292235147@c.us' };
              return null;
            },
          };
        }
        throw new Error('unknown module ' + mod);
      },
    },
    document: { visibilityState: 'visible' },
    location: { href: 'https://web.whatsapp.com/' },
  };
  return vm.runInNewContext(wr.pageProbeSource(), sandbox);
}

function msg(o) {
  return Object.assign({
    id: { fromMe: false, remote: LID_CHAT, id: 'MID' + Math.random().toString(16).slice(2) },
    body: 'hello', t: t0(), type: 'chat', hasMedia: false,
  }, o);
}

(async function main() {
  try {
  /* =================================================================
   * [A] probeInPage —— 真跑一遍（假 window.require）
   * ================================================================= */
  console.log('\n--- [A] 页面读取脚本（probeInPage 真跑）---');

  check('脚本字符串非空', wr.pageProbeSource().length > 800, 'len=' + wr.pageProbeSource().length);

  // 没有 window.require 的环境（网页没加载完）→ 必须返回 ok:false，绝不抛
  let noWin = null;
  try { noWin = vm.runInNewContext(wr.pageProbeSource(), {}); } catch (e) { noWin = { threw: String(e && e.message) }; }
  check('无 window.require 时不抛，返回 ok:false',
    !!(noWin && noWin.ok === false && !noWin.threw), JSON.stringify(noWin));

  const srcMsgs = [
    msg({ id: { fromMe: false, remote: LID_CHAT, id: 'AAA1' }, body: 'Is the painting ready?', t: t0() + 10 }),
    msg({ id: { fromMe: true, remote: LID_CHAT, id: 'AAA2' }, body: 'Almost! two more days', t: t0() + 20 }),
    // 空正文的系统行：页面侧就该丢掉
    msg({ id: { fromMe: false, remote: LID_CHAT, id: 'AAA3' }, body: '', type: 'e2e_notification', t: t0() + 30 }),
    // 有正文的系统行：页面侧留，由 toMessage 的 JUNK_TYPES 挡
    msg({ id: { fromMe: false, remote: LID_CHAT, id: 'AAA4' }, body: '消息和通话已端到端加密', type: 'e2e_notification', t: t0() + 40 }),
    // 群消息：页面侧照收，由 toMessage 挡掉
    msg({ id: { fromMe: false, remote: GROUP_CHAT, id: 'AAA5' }, body: '群里的闲聊', t: t0() + 50 }),
    // 纯号码会话（通讯录里的人）
    msg({ id: { fromMe: false, remote: PN_CHAT, id: 'AAA6' }, body: 'hi from dio', t: t0() + 60 }),
    // 图片消息：没正文但有附件，必须留下
    msg({ id: { fromMe: false, remote: PN_CHAT, id: 'AAA7' }, body: '', hasMedia: true, type: 'image', t: t0() + 70 }),
  ];

  const probed = runProbe(srcMsgs);
  check('假网页里 ok:true', !!(probed && probed.ok === true), JSON.stringify(probed && probed.error));
  check('读到 3 个会话', probed && probed.chats && probed.chats.length === 3,
    probed && probed.chats && probed.chats.length);
  check('读到 2 个联系人', probed && probed.contacts && probed.contacts.length === 2,
    probed && probed.contacts && probed.contacts.length);
  check('7 条原始消息里，空正文那条被丢弃 → 剩 6 条',
    probed && probed.messages && probed.messages.length === 6,
    probed && probed.messages && probed.messages.length);
  check('Msg.id 是裸对象也能取到 id 字段',
    !!(probed && probed.messages[0].mid === 'AAA1'), probed && probed.messages[0].mid);
  check('fromMe 判定正确（第二条是发出去的）',
    !!(probed && probed.messages[1].fromMe === true && probed.messages[0].fromMe === false));
  check('会话 isGroup 判定正确（群那条）',
    !!(probed && probed.chats[1].isGroup === true && probed.chats[0].isGroup === false));
  check('@lid → 真号码 映射表里有值',
    !!(probed && probed.pnByLid && probed.pnByLid[LID_CHAT] === '85292235147@c.us'),
    JSON.stringify(probed && probed.pnByLid));

  // 🔴 返回的必须是能结构化克隆的纯数据（Model 对象带循环引用，克隆会炸）
  let cloneOk = true;
  try { require('v8').serialize(probed); } catch (e) { cloneOk = false; }
  check('返回值是纯数据（v8.serialize 不炸）', cloneOk);

  /* =================================================================
   * [B] normalize + toMessage —— 纯函数
   * ================================================================= */
  console.log('\n--- [B] normalize / toMessage（纯函数）---');

  const ctx = wr.normalize(probed);
  const byId = (id) => probed.messages.find((m) => m.mid === id);

  const m1 = wr.toMessage(byId('AAA1'), ctx);
  check('客户消息转出统一结构', !!m1);
  check('displayJid = wa1:<会话 JID>', m1 && m1.displayJid === `wa1:${LID_CHAT}`, m1 && m1.displayJid);
  check('msgId = <0|1>_<remote>_<id>', m1 && m1.msgId === `0_${LID_CHAT}_AAA1`, m1 && m1.msgId);
  check('direction = in', m1 && m1.direction === 'in');
  check('正文原样带过去', m1 && m1.body === 'Is the painting ready?');
  check('accountId = 10（独立 WA 段）', m1 && m1.accountId === 10, m1 && m1.accountId);
  check('channel = whatsapp-web', m1 && m1.channel === 'whatsapp-web', m1 && m1.channel);

  // 🔴 本次最关键的一条：@lid 会话也要拿到真号码
  check('@lid 会话还原出真号码 85292235147', m1 && m1.phone === '85292235147', m1 && m1.phone);
  check('号码来源标成 contact（可信度同通讯录）', m1 && m1.phoneSrc === 'contact', m1 && m1.phoneSrc);
  check('地区按国际区号反查出中国香港', m1 && /香港/.test(m1.region), m1 && m1.region);
  check('名字取到（通讯录备注 程）', m1 && m1.name === '程', m1 && m1.name);
  check('ts 是 ISO 串', m1 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(m1.ts), m1 && m1.ts);
  check('tsSec 是原始秒级时间戳', m1 && m1.tsSec === t0() + 10, m1 && String(m1.tsSec));

  const mOut = wr.toMessage(byId('AAA2'), ctx);
  check('自己发出去的消息 direction = out', mOut && mOut.direction === 'out', mOut && mOut.direction);
  check('出去的消息 msgId 前缀是 1_', mOut && mOut.msgId === `1_${LID_CHAT}_AAA2`, mOut && mOut.msgId);

  check('有正文的 e2e_notification 被挡掉', wr.toMessage(byId('AAA4'), ctx) === null);
  check('群消息被挡掉（不是"一个客户"）', wr.toMessage(byId('AAA5'), ctx) === null);

  const mPn = wr.toMessage(byId('AAA6'), ctx);
  check('纯号码会话 phoneSrc = jid', mPn && mPn.phone === '15418010646' && mPn.phoneSrc === 'jid',
    mPn && (mPn.phone + '/' + mPn.phoneSrc));

  const mImg = wr.toMessage(byId('AAA7'), ctx);
  check('图片消息（无正文有附件）保留，mediaType=image',
    mImg && mImg.hasAttachment === true && mImg.mediaType === 'image' && mImg.body === '',
    JSON.stringify(mImg && { a: mImg.hasAttachment, t: mImg.mediaType, b: mImg.body }));

  // 各种「不该收」的
  const mk = (o) => Object.assign({ mid: 'M1', fromMe: false, remote: PN_CHAT, body: 'x', ts: t0() }, o);
  check('群 @g.us 不收', wr.toMessage(mk({ remote: GROUP_CHAT }), ctx) === null);
  check('status@broadcast 不收', wr.toMessage(mk({ remote: 'status@broadcast' }), ctx) === null);
  check('其它 @broadcast 不收', wr.toMessage(mk({ remote: '123456@broadcast' }), ctx) === null);
  check('空正文且无附件不收', wr.toMessage(mk({ body: '' }), ctx) === null);
  check('没有 mid 不收', wr.toMessage(mk({ mid: '' }), ctx) === null);
  check('没有 remote 不收', wr.toMessage(mk({ remote: '' }), ctx) === null);
  check('null 输入不收（不抛）', wr.toMessage(null, ctx) === null);
  check('撤回 / 通话记录 / 表情回应这类 type 一律不收',
    wr.toMessage(mk({ type: 'revoked' }), ctx) === null
    && wr.toMessage(mk({ type: 'call_log' }), ctx) === null
    && wr.toMessage(mk({ type: 'reaction' }), ctx) === null);

  // 好友资料卡
  const card = wr.contactCard(probed.chats[0], ctx);
  check('会话 → 好友资料卡（名字 + 真号码 + 地区）',
    !!(card && card.name === '程' && card.phone === '85292235147' && /香港/.test(card.region)),
    JSON.stringify(card));
  check('资料卡 displayJid 前缀 wa1:', card && card.displayJid === `wa1:${LID_CHAT}`, card && card.displayJid);
  check('群会话不产出资料卡', wr.contactCard(probed.chats[1], ctx) === null);

  check('rawKey 与 toMessage 的 msgId 完全一致（去重键同源）',
    wr.rawKey(byId('AAA1')) === (m1 && m1.msgId), wr.rawKey(byId('AAA1')));

  /* =================================================================
   * [C] tick() —— 首轮水位 / 增量 / 不重复 / 不回灌
   * ================================================================= */
  console.log('\n--- [C] tick()：首轮水位 + 增量采集 ---');

  const CH = '11111111@c.us';
  const feed = [];           // 页面当前「内存里」有哪些消息
  let pageCalls = 0;
  const fakePage = {
    executeJavaScript: async () => {
      pageCalls++;
      return {
        ok: true, visible: true, url: 'https://web.whatsapp.com/',
        counts: { chats: 1, contacts: 1, messages: feed.length },
        chats: [{ id: CH, name: 'Tester', unread: 0, ts: t0(), isGroup: false }],
        contacts: [{ id: CH, name: 'Tester', pushname: '', shortName: '', number: CH, isMyContact: true }],
        messages: feed.slice(),
        pnByLid: {},
      };
    },
  };

  const gotMsgs = [];
  const gotCards = [];
  const w = wr.startWatching({
    findPage: () => fakePage,
    onMessages: (b) => { for (const m of b) gotMsgs.push(m); },
    onContacts: (c) => { for (const x of c) gotCards.push(x); },
  });
  check('BEE_TEST 下 startWatching 不挂定时器（watching=true 但无 timer）',
    w.state().watching === true && !!process.env.BEE_TEST, JSON.stringify(w.state()));

  // 先往页面里放 30 条**历史**消息（超过 FIRST_BATCH=20）
  for (let i = 1; i <= 30; i++) {
    feed.push({ mid: 'H' + i, fromMe: false, remote: CH, body: 'old-' + i, ts: t0() + i, type: 'chat', hasMedia: false });
  }

  await w.tick();
  check(`首轮只回灌最新 ${wr.FIRST_BATCH} 条（不是全部 30 条）`,
    gotMsgs.length === wr.FIRST_BATCH, '实际=' + gotMsgs.length);
  check('首轮拿到的是**最新的**那批（old-11 … old-30）',
    gotMsgs.length === wr.FIRST_BATCH
    && gotMsgs[0].body === 'old-11' && gotMsgs[gotMsgs.length - 1].body === 'old-30',
    gotMsgs.length ? (gotMsgs[0].body + '…' + gotMsgs[gotMsgs.length - 1].body) : '');
  check('首轮把「有会话的联系人」报上来建好友资料',
    gotCards.length === 1 && gotCards[0].displayJid === `wa1:${CH}`, JSON.stringify(gotCards));
  check('首轮水位顶到最新一条（ts = t0+30）', w.state().watermark === t0() + 30, String(w.state().watermark));
  check('首轮状态 = collecting', w.state().status === 'collecting', w.state().status);
  check('首轮 read = 回灌条数', w.state().read === wr.FIRST_BATCH, String(w.state().read));

  // 第二轮：页面没变 → 一条都不该再进（绝不能重复入库）
  const before = gotMsgs.length;
  await w.tick();
  check('页面没变时第二轮 read=0（不重复）', w.state().read === 0 && gotMsgs.length === before,
    'read=' + w.state().read + ' total=' + gotMsgs.length);
  check('第二轮不再重复报好友资料', gotCards.length === 1, String(gotCards.length));

  // 第三轮：来一条真新消息
  feed.push({ mid: 'N1', fromMe: false, remote: CH, body: 'brand new!', ts: t0() + 100, type: 'chat', hasMedia: false });
  await w.tick();
  check('新消息进了（read=1）', w.state().read === 1, String(w.state().read));
  check('新消息正文正确', gotMsgs[gotMsgs.length - 1].body === 'brand new!', gotMsgs[gotMsgs.length - 1].body);
  check('水位推进到新消息', w.state().watermark === t0() + 100, String(w.state().watermark));

  // 第四轮：页面开始出现**水位之前**的旧消息（网页补历史）→ 绝不回灌
  const mark4 = gotMsgs.length;
  feed.push({ mid: 'H31', fromMe: false, remote: CH, body: 'very old', ts: t0() + 5, type: 'chat', hasMedia: false });
  await w.tick();
  check('水位之下的旧消息不回灌', w.state().read === 0 && gotMsgs.length === mark4,
    'read=' + w.state().read);

  // 第五轮：同一条新消息重复出现（页面重扫）→ 去重，不收第二遍
  feed.push({ mid: 'N1', fromMe: false, remote: CH, body: 'brand new!', ts: t0() + 100, type: 'chat', hasMedia: false });
  const mark5 = gotMsgs.length;
  await w.tick();
  check('同一条消息重复出现不重复收', gotMsgs.length === mark5 && w.state().read === 0,
    'total=' + gotMsgs.length);

  // 每条消息的 msgId 必须唯一（这就是入库时的 waMsgId 去重键）
  const idSet = new Set(gotMsgs.map((m) => m.msgId));
  check('所有入过的消息 msgId 互不相同', idSet.size === gotMsgs.length,
    `${idSet.size} vs ${gotMsgs.length}`);

  await w.tick();
  check('页面调用次数正常累加', pageCalls >= 6, String(pageCalls));

  w.stop();
  check('stop() 后 watching=false', w.state().watching === false);

  /* ---- 页面打不开时：如实报错，绝不假装在采 ---- */
  console.log('\n--- [C2] 页面打不开 / 读不到时的如实反馈 ---');
  const w2 = wr.startWatching({ findPage: () => null, onMessages: () => {} });
  await w2.tick();
  check('找不到内置浏览器页面 → ok:false / status=no-page',
    w2.state().ok === false && w2.state().status === 'no-page',
    JSON.stringify({ ok: w2.state().ok, s: w2.state().status }));
  check('报错文案明确指向「先点中栏 WA① 页签」',
    /WA①/.test(w2.state().error), w2.state().error);
  w2.stop();

  const w3 = wr.startWatching({
    findPage: () => ({ executeJavaScript: async () => ({ ok: false, error: 'WAWebCollections 读不到：网页可能还没登录' }) }),
    onMessages: () => {},
  });
  await w3.tick();
  check('网页读不到（没登录）→ ok:false / status=unreadable',
    w3.state().ok === false && w3.state().status === 'unreadable',
    JSON.stringify({ ok: w3.state().ok, s: w3.state().status }));
  check('错误原文带上来（不吞）', /WAWebCollections/.test(w3.state().error), w3.state().error);
  w3.stop();

  /* ---- 只读铁律：注入脚本里不许出现任何「发送/输入」动作 ---- */
  console.log('\n--- [D] 只读铁律（静态检查注入脚本）---');
  const src = wr.pageProbeSource();
  const FORBIDDEN = [
    ['.click(', '点击'],
    ['sendMessage', '发送消息'],
    ['.value =', '写输入框'],
    ['dispatchEvent', '派发事件'],
    ['scrollTop', '滚动'],
    ['scrollTo', '滚动'],
    ['chat.open(', '打开对话'],
    ['fetch(', '发网络请求'],
    ['XMLHttpRequest', '发网络请求'],
  ];
  for (const [needle, what] of FORBIDDEN) {
    check(`注入脚本里没有「${what}」（${needle}）`, src.indexOf(needle) < 0, '找到了 ' + needle);
  }
  check('注入脚本只读 Store（有 getModelsArray）', src.indexOf('getModelsArray') >= 0);

  /* ---- 账号 / 渠道常量 ---- */
  console.log('\n--- [E] 账号与渠道常量 ---');
  check('ACC_ID = ids.ACC_WA_EMBEDDED = 10', wr.ACC_ID === 10, String(wr.ACC_ID));
  check('channel = whatsapp-web（与一号~五号的 whatsapp 分开）', wr.CHANNEL === 'whatsapp-web', wr.CHANNEL);
  check('节拍 = 3 秒（老板拍板跟 TG 一致）', wr.POLL_MS === 3000, String(wr.POLL_MS));
  check('identity.countryOfPhone 可用（地区反查依赖它）',
    identity.countryOfPhone('85292235147') === '中国香港',
    identity.countryOfPhone('85292235147'));

  } catch (e) {
    fail++;
    failures.push('异常：' + ((e && e.message) || e));
    console.error('\n[异常]', e);
  }

  console.log(`\n[WA①内置浏览器采集自检] 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) console.log('[WA①内置浏览器采集自检] 失败项：\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
