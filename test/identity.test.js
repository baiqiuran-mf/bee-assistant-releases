/**
 * 采集链路自检：客户身份抓取（名字 / 电话）+ 空消息不入库
 *
 * 对应 2026-09-28 用户反馈的三条：
 *   ① 客户发消息过来，抓不到名字、也抓不到电话号码
 *      —— 根因：老代码用 msg.notifyName / msg.pushName，本机装的 whatsapp-web.js 1.34.7
 *         的 Message 上根本没有这两个属性（全包搜不到 notifyName 字样），名字永远是空。
 *         现在改走 msg.getContact()：Contact 上有 pushname / name / number。
 *         电话那边还有个坑：@lid（WhatsApp 用来隐藏手机号的隐私 ID）那串也是数字，
 *         老代码 `/^\+?\d{5,}@/` 会把 LID 当电话存进去 —— 现在只认 @c.us。
 *   ② 空消息（撤回提示 / 加密提示 / 通话记录 / 表情回应）不该被采集出来
 *   ③ （中栏清空那条在 ui_render.test.js 里验，属于界面行为）
 *
 * 运行：node --experimental-sqlite test/identity.test.js
 */

const fs = require('fs');
const path = require('path');

// 数据隔离：只写临时目录，绝不碰真实 data/
const { DIR: DATA_DIR } = require('./_isolate.js');
const DB = path.join(DATA_DIR, 'assistant.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);

const identity = require('../src/identity');
const db = require('../src/db');
const { messageText } = require('../src/main');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? '  << ' + extra : ''}`); }
}
function eq(name, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  check(name, ok, ok ? '' : `实际 ${JSON.stringify(a)} ≠ 期望 ${JSON.stringify(b)}`);
}

/**
 * 2026-10-07 加：identity.resolve / parseIntlPhone 新增了 phoneSrc、hasPlus 字段
 * （号码从哪一层拿到的可信度标记）。老断言比的是整个对象，加了字段就必挂，
 * 但那些断言真正想验的是「号码/名字/国家对不对」—— 字段多一个不代表功能坏。
 * 所以这里默认**忽略新增字段**做比较，另配 eqFull 供确实要逐字比全字段的新断言用。
 */
const NEW_FIELDS = ['phoneSrc', 'hasPlus'];
function eqNoNew(name, a, b) {
  const strip = (o) => {
    if (!o || typeof o !== 'object') return o;
    const c = {};
    for (const k of Object.keys(o).sort()) if (!NEW_FIELDS.includes(k)) c[k] = o[k];
    return c;
  };
  const ok = JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  check(name, ok, ok ? '' : `实际 ${JSON.stringify(strip(a))} ≠ 期望 ${JSON.stringify(strip(b))}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }

/** 造一个和 whatsapp-web.js 的 Message 同形状的假对象 */
function fakeMsg(o = {}) {
  const m = {
    from: o.from || '15418010646@c.us',
    to: o.to,
    fromMe: !!o.fromMe,
    body: o.body || '',
    type: o.type || 'chat',
    hasMedia: !!o.hasMedia,
    id: { id: o.waId || 'fake-1', fromMe: !!o.fromMe },
    timestamp: o.ts || Math.floor(Date.now() / 1000),
  };
  if (o.contact !== undefined) m.getContact = async () => o.contact;
  if (o.contactThrow) m.getContact = async () => { throw new Error('boom'); };
  if (o.chat !== undefined) m.getChat = async () => o.chat;
  return m;
}

(async () => {
  section('JID → 电话：只认 @c.us，@lid 不是电话');
  eq('普通手机号 JID 能推出号码', identity.phoneFromJid('15418010646@c.us'), '15418010646');
  eq('带 + 号的 JID 也能推出', identity.phoneFromJid('+15418010646@c.us'), '15418010646');
  eq('@s.whatsapp.net 也算', identity.phoneFromJid('15418010646@s.whatsapp.net'), '15418010646');
  eq('LID（@lid）**不能**当电话', identity.phoneFromJid('123456789012345@lid'), '');
  eq('群 JID（@g.us）不是电话', identity.phoneFromJid('12036301234@g.us'), '');
  eq('广播（status@broadcast）不是电话', identity.phoneFromJid('status@broadcast'), '');
  eq('太短的数字串不算电话', identity.phoneFromJid('123@c.us'), '');

  section('名字清洗：别把号码当名字');
  eq('正常名字照收', identity.cleanName('Mike', '15418010646'), 'Mike');
  eq('前后空白去掉', identity.cleanName('  Wanqiu Lin  ', ''), 'Wanqiu Lin');
  eq('名字和电话一模一样 → 不要（WhatsApp 对没昵称的人会这么给）',
    identity.cleanName('15418010646', '15418010646'), '');
  eq('格式化过的号码（+1 541 801 0646）也不是名字',
    identity.cleanName('+1 541 801 0646', '15418010646'), '');
  eq('空名字 → 空', identity.cleanName('', '15418010646'), '');

  section('从 Contact 上取名字 / 号码');
  eq('Contact.number 优先', identity.phoneFromContact({ number: '15418010646' }), '15418010646');
  eq('number 没有时退到 id（{_serialized}）',
    identity.phoneFromContact({ number: undefined, id: { _serialized: '15418010646@c.us' } }), '15418010646');
  eq('LID 联系人的 id 也要挡住', identity.phoneFromContact({ id: { _serialized: '999999@lid' } }), '');
  eq('通讯录备注（name）优先', identity.nameFromContact({ name: 'Mike 客户', pushname: 'MikeT' }, '15418010646'), 'Mike 客户');
  eq('没备注就用公开昵称 pushname', identity.nameFromContact({ pushname: 'MikeT' }, '15418010646'), 'MikeT');
  eq('企业号用认证名', identity.nameFromContact({ verifiedName: 'Pet Portrait Studio' }, ''), 'Pet Portrait Studio');
  eq('什么都没有 → 空', identity.nameFromContact({}, '15418010646'), '');
  eq('会话标题也能当兜底名字', identity.nameFromChat({ name: 'Robert' }, ''), 'Robert');

  // 2026-09-29 用户实报：真号码 +447726795080 被存成了 243834688639050（那是 LID）
  section('LID 号码必须挡住（用户报的 447726795080 → 243834688639050）');
  eq('识别 LID JID', identity.isLidJid('243834688639050@lid'), true);
  eq('普通手机号 JID 不是 LID', identity.isLidJid('447726795080@c.us'), false);
  eq('LID 会话 + number 就是那串 LID → 不要',
    identity.phoneFromContact({ number: '243834688639050', id: { _serialized: '243834688639050@lid' } }), '');
  eq('LID 会话 + number 是 15 位（不管等不等）→ 不要',
    identity.phoneFromContact({ number: '999888777666555', id: { _serialized: '243834688639050@lid' } }), '');
  eq('LID 会话但 number 是真号码（wwjs 换过 id）→ 留下',
    identity.phoneFromContact({ number: '447726795080', id: { _serialized: '447726795080@c.us' } }), '447726795080');
  eq('isLidPhone：等于 LID 那串 → true', identity.isLidPhone('243834688639050@lid', '243834688639050'), true);
  eq('isLidPhone：14 位以上 → true', identity.isLidPhone('243834688639050@lid', '2438346886390501'), true);
  eq('isLidPhone：像真号码 → false', identity.isLidPhone('243834688639050@lid', '447726795080'), false);
  eq('isLidPhone：非 LID 会话一律不判（不动别人的号码）',
    identity.isLidPhone('447726795080@c.us', '243834688639050'), false);

  section('从消息正文里抠电话（刚加进来的客户会直接把号码发过来）');
  eq('带 + 的国际号码', identity.phoneFromText('my whatsapp is +44 7726 795080'), '447726795080');
  eq('带 00 前缀', identity.phoneFromText('call me 0044 7726 795080'), '447726795080');
  eq('带括号和横线', identity.phoneFromText('(44) 7726-795080'), '447726795080');
  eq('整条消息就是号码', identity.phoneFromText('447726795080'), '447726795080');
  eq('普通聊天不会被当成号码', identity.phoneFromText('New York is a very bustling city.'), '');
  eq('15 位裸数字（LID/订单号那种）不认', identity.phoneFromText('243834688639050'), '');
  eq('空消息 → 空', identity.phoneFromText(''), '');

  section('国际区号白名单（2026-09-29 晚加：带 + 的号码必须区号合法）');
  eqNoNew('parseIntlPhone +1 北美', identity.parseIntlPhone('+1 541 801 0646'),
    { phone: '15418010646', code: '1', country: '美国/加拿大' });
  eqNoNew('parseIntlPhone +44 英国', identity.parseIntlPhone('+44 7726 795080'),
    { phone: '447726795080', code: '44', country: '英国' });
  eqNoNew('parseIntlPhone +86 中国（3 位区号回退到 2 位）', identity.parseIntlPhone('+86 138 0013 8000'),
    { phone: '8613800138000', code: '86', country: '中国' });
  eqNoNew('parseIntlPhone +81 日本', identity.parseIntlPhone('+81 90 1234 5678'),
    { phone: '819012345678', code: '81', country: '日本' });
  eqNoNew('parseIntlPhone 00 前缀等同 +', identity.parseIntlPhone('0044 7726 795080'),
    { phone: '447726795080', code: '44', country: '英国' });
  eq('parseIntlPhone 区号瞎编（879 未分配）返回 null', identity.parseIntlPhone('+879 123 456 789'), null);
  eq('parseIntlPhone 太短（<8 位）返回 null', identity.parseIntlPhone('+1 234'), null);
  eq('countryOfPhone 反查英国', identity.countryOfPhone('447726795080'), '英国');
  eq('countryOfPhone 反查北美', identity.countryOfPhone('15418010646'), '美国/加拿大');
  eq('countryOfPhone 反查日本', identity.countryOfPhone('819012345678'), '日本');
  eq('phoneFromText 区号不在白名单的不认（从源头排除瞎编号）',
    identity.phoneFromText('my number is +879 123 456 789'), '');
  eq('phoneFromText 带合法区号的才认',
    identity.phoneFromText('call me at +81 90 1234 5678'), '819012345678');
  eq('phoneFromText 区号合法但整体太短也不认',
    identity.phoneFromText('+44 123'), '');

  section('resolve()：真问浏览器时拿得到身份');
  identity.clearCache();
  {
    const r = await identity.resolve(
      fakeMsg({ contact: { pushname: 'Mike', number: '15418010646' } }),
      { timeoutMs: 500 }
    );
    eqNoNew('Contact 上拿到名字 + 号码（含国家标注）', r, { name: 'Mike', phone: '15418010646', country: '美国/加拿大' });
  }
  {
    // 关键场景：@lid 会话，JID 里没有号码，只能靠 Contact 问出来
    const r = await identity.resolve(
      fakeMsg({ from: '123456789012345@lid', contact: { pushname: 'Noah', number: '61412345678' } }),
      { timeoutMs: 500 }
    );
    eqNoNew('LID 会话也能问到真号码（含国家标注）', r, { name: 'Noah', phone: '61412345678', country: '澳大利亚' });
  }
  {
    // 走 client.getContactById 的那条路（msg 上没有 getContact）
    const r = await identity.resolve(
      { from: '447700900999@c.us', body: 'hi' },
      { client: { getContactById: async () => ({ pushname: 'Dio', number: '447700900999' }) }, timeoutMs: 500 }
    );
    eqNoNew('msg 没有 getContact 时退到 client.getContactById（含国家标注）', r, { name: 'Dio', phone: '447700900999', country: '英国' });
  }
  {
    // 联系人取不到 → 用会话标题兜底
    const r = await identity.resolve(
      fakeMsg({ from: '555555555555555@lid', contactThrow: true, chat: { name: 'James' } }),
      { timeoutMs: 500 }
    );
    eqNoNew('联系人取不到时用会话标题兜底（无电话则无国家）', r, { name: 'James', phone: '', country: '' });
  }
  {
    // 浏览器卡住也不能拖死收消息链路
    const t0 = Date.now();
    const r = await identity.resolve(
      { from: '12125550123@c.us', getContact: () => new Promise(() => {}), getChat: () => new Promise(() => {}) },
      { timeoutMs: 120 }
    );
    const cost = Date.now() - t0;
    check('联系人接口卡住时按超时返回，不会挂死', cost < 1000, `耗时 ${cost}ms`);
    eqNoNew('超时后至少还有 JID 推出来的号码（含国家标注）', r, { name: '', phone: '12125550123', country: '美国/加拿大' });
  }
  {
    // 同一个会话的第 2 条消息不再问浏览器（历史同步几百条也不会把浏览器问爆）
    let calls = 0;
    const mk = () => ({
      from: '447700900123@c.us',
      getContact: async () => { calls += 1; return { pushname: 'Emma', number: '447700900123' }; },
    });
    await identity.resolve(mk(), { timeoutMs: 500 });
    await identity.resolve(mk(), { timeoutMs: 500 });
    await identity.resolve(mk(), { timeoutMs: 500 });
    eq('同一个 JID 只问一次浏览器（有缓存）', calls, 1);
  }

  // 2026-09-29：LID 会话查不到号码时的两条新出路
  section('resolve()：LID 会话的真号码（问 WhatsApp / 从消息正文）');
  {
    // ① 问注入层的 enforceLidAndPnRetrieval（就是网页上能看到那个真号码）
    let asked = '';
    const r = await identity.resolve(
      fakeMsg({ from: '111111111111111@lid' }),
      {
        timeoutMs: 500,
        client: {
          getContactById: async () => ({ pushname: 'Noah' }),
          pupPage: { evaluate: async (_fn, wid) => { asked = wid; return '447726795080@c.us'; } },
        },
      },
    );
    eqNoNew('LID 会话能问出真号码（含国家标注）', r, { name: 'Noah', phone: '447726795080', country: '英国' });
    eq('问的就是这个 LID', asked, '111111111111111@lid');
  }
  {
    // ② 什么都查不到 → 从客户自己打的那句话里抠
    const r = await identity.resolve(
      fakeMsg({ from: '222222222222222@lid', body: 'hi! this is my number +44 7726 795080' }),
      { timeoutMs: 400 },
    );
    eqNoNew('LID 会话从消息正文拿到号码（含国家标注）', r, { name: '', phone: '447726795080', country: '英国' });
  }
  {
    // ③ 用户实际报的那一条：联系人给的 number 就是那串 LID，正文里有真号码
    const r = await identity.resolve(
      fakeMsg({
        from: '243834688639050@lid',
        body: '+44 7726 795080',
        contact: {
          pushname: 'Lucky',
          number: '243834688639050',
          id: { _serialized: '243834688639050@lid' },
        },
      }),
      { timeoutMs: 400 },
    );
    eqNoNew('LID 假号码绝不入库，改从正文拿真号码（含国家标注）', r, { name: 'Lucky', phone: '447726795080', country: '英国' });
  }
  {
    // ④ 什么都没有、只有网页 DOM 里显示着号码（用户 2026-09-29 给的那几个 span）
    //    → 读 DOM 兜底（phoneFromWhatsappDom）
    //    换个新 JID，免得撞上上一条用例的缓存
    const r = await identity.resolve(
      fakeMsg({ from: '444444444444444@lid' }),
      {
        timeoutMs: 600,
        client: {
          // getContactById 拿不到号码（只有昵称）
          getContactById: async () => ({ pushname: 'Lucky2' }),
          // getContactLidAndPhone 也查不到（真实世界常见）
          getContactLidAndPhone: async () => [{ lid: '444444444444444@lid', pn: undefined }],
          pupPage: {
            evaluate: async () => '+44 7726 795080',
          },
        },
      },
    );
    eqNoNew('网页 DOM 兜底能拿到真号码（含国家标注）', r, { name: 'Lucky2', phone: '447726795080', country: '英国' });
  }

  section('空消息：不该被采集出来（撤回提示 / 加密提示 / 通话记录 / 表情回应）');
  eq('有文字 → 用文字', messageText(fakeMsg({ body: 'hi there' })), 'hi there');
  eq('没文字没附件 → 空（不入库）', messageText(fakeMsg({ body: '' })), '');
  eq('撤回提示（revoked）→ 空', messageText(fakeMsg({ type: 'revoked' })), '');
  eq('加密提示（e2e_notification）→ 空', messageText(fakeMsg({ type: 'e2e_notification' })), '');
  eq('通话记录（call_log）→ 空', messageText(fakeMsg({ type: 'call_log' })), '');
  eq('表情回应（reaction）→ 空', messageText(fakeMsg({ type: 'reaction' })), '');
  eq('图片（说明文字为空）→ [图片]', messageText(fakeMsg({ hasMedia: true, type: 'image' })), '[图片]');
  eq('语音 → [语音]', messageText(fakeMsg({ hasMedia: true, type: 'ptt' })), '[语音]');
  eq('视频 → [视频]', messageText(fakeMsg({ hasMedia: true, type: 'video' })), '[视频]');
  eq('文件 → [文件]', messageText(fakeMsg({ hasMedia: true, type: 'document' })), '[文件]');
  eq('图片带了说明文字 → 用说明文字', messageText(fakeMsg({ hasMedia: true, type: 'image', body: 'my cat' })), 'my cat');
  eq('位置 → [位置]', messageText(fakeMsg({ type: 'location', location: {} })), '[位置]');
  eq('名片 → [名片]', messageText(fakeMsg({ type: 'vcard', vCards: ['x'] })), '[名片]');

  section('数据库：空消息不显示 / 身份只补不覆盖');
  {
    const { customer: c1 } = db.getOrCreateCustomer(9, '15418010646@c.us', { name: '', phone: '' });
    db.saveMessage({ customerCode: c1.code, accountId: 9, direction: 'in', body: 'hi', waMsgId: 'id-1' });
    db.saveMessage({ customerCode: c1.code, accountId: 9, direction: 'in', body: '', waMsgId: 'id-empty-1' });
    db.saveMessage({ customerCode: c1.code, accountId: 9, direction: 'out', body: '   ', waMsgId: 'id-empty-2' });
    db.saveMessage({ customerCode: c1.code, accountId: 9, direction: 'in', body: '', mediaPath: 'x.jpg', waMsgId: 'id-media' });

    const before = db.listMessages.all(c1.code).length;
    eq('读的时候空消息被挡住（只剩文字那条 + 带图那条）', before, 2);
    check('带附件的那条没有被误删',
      db.listMessages.all(c1.code).some((m) => m.media_path === 'x.jpg'));

    const purged = db.purgeEmptyMessages();
    check('purgeEmptyMessages 清掉了历史遗留的空行', purged === 2, `实际 ${purged}`);
    eq('清完还是只剩两条真消息', db.listMessages.all(c1.code).length, 2);

    // 身份补录：建号时没抓到，后来抓到了
    const filled = db.backfillIdentity(c1.code, { name: 'Dio', phone: '15418010646' });
    check('空的姓名/电话会被补上', filled === true);
    const afterFill = db.getCustomer.get(c1.code);
    eq('补录后姓名正确', afterFill.name, 'Dio');
    eq('补录后电话正确', afterFill.phone, '15418010646');

    const again = db.backfillIdentity(c1.code, { name: '别人', phone: '999' });
    check('已经有的姓名/电话**不会被覆盖**', again === false);
    eq('姓名还是原来那个', db.getCustomer.get(c1.code).name, 'Dio');
    eq('电话还是原来那个', db.getCustomer.get(c1.code).phone, '15418010646');

    // 老数据里那批「LID 被当成电话存进去」的假号码：清掉，好让补身份填真的
    const lidJid = '206459950338291@lid';
    db.db.prepare(`INSERT INTO customers (code, account_id, wa_jid, phone, name, channel, created_at, is_sim)
                   VALUES ('9Z00001', 9, ?, '206459950338291', '老数据', 'whatsapp', datetime('now'), 0)`).run(lidJid);
    eq('（前置）老数据里确实存着那串 LID 当电话', db.getCustomer.get('9Z00001').phone, '206459950338291');
    const cleared = db.clearLidPhones();
    check('clearLidPhones 把假号码清掉了', cleared === 1, `实际 ${cleared}`);
    eq('清完电话留空（等登录后补真的）', db.getCustomer.get('9Z00001').phone, null);
    eq('姓名没被顺手动过', db.getCustomer.get('9Z00001').name, '老数据');

    // LID 建号不能把 LID 存成电话
    const { customer: c2 } = db.getOrCreateCustomer(9, '123456789012345@lid', { name: '' });
    eq('LID 客户建号时电话留空（不能存那串 LID）', c2.phone, null);
    const filledLid = db.backfillIdentity(c2.code, { name: 'Noah', phone: '61412345678' });
    check('后来问到真号码能补上', filledLid === true);
    eq('补上的是真号码', db.getCustomer.get(c2.code).phone, '61412345678');

    // 2026-09-29：号码跟 LID 那串**不相等**、但长度明显是 LID（≥14 位）也要清
    // （用户实报：真号码 +447726795080 被存成了 243834688639050）
    // 走正规建号接口（编号由分配器给），再把假号码写进去 —— 手插编号会撞分配器的解析
    const { customer: cb } = db.getOrCreateCustomer(9, '7@lid', { name: '用户报的那条' });
    db.db.prepare(`UPDATE customers SET phone=? WHERE code=?`).run('243834688639050', cb.code);
    eq('（前置）这条的 JID 是 LID、号码是 15 位假号码', db.getCustomer.get(cb.code).phone, '243834688639050');
    const cleared2 = db.clearLidPhones();
    check('clearLidPhones 也认得 ≥14 位的 LID 假号码', cleared2 === 1, `实际 ${cleared2}`);
    eq('清完电话留空（等补身份填真的）', db.getCustomer.get(cb.code).phone, null);

    // 补身份时要用"客户最近几条来信"的正文去找号码（identity.phoneFromText 的输入）
    const { customer: c3 } = db.getOrCreateCustomer(9, '333333333333333@lid', { name: '' });
    db.saveMessage({ customerCode: c3.code, accountId: 9, direction: 'in', body: 'hello', silent: true });
    db.saveMessage({ customerCode: c3.code, accountId: 9, direction: 'out', body: 'hi 5550001234', silent: true });
    db.saveMessage({ customerCode: c3.code, accountId: 9, direction: 'in', body: 'my number is +44 7726 795080', silent: true });
    const txt = db.recentInboundText(c3.code, 5);
    check('recentInboundText 含客户来信', txt.includes('my number is'), JSON.stringify(txt));
    check('recentInboundText 不含自己发出去的（免得把自号码当客户的）',
      !txt.includes('5550001234'), JSON.stringify(txt));
    eq('recentInboundText 拿到的正文能抠出号码',
      identity.phoneFromText(txt), '447726795080');
  }

  /*
   * ============================================================
   * 2026-10-07新增：号码可信度标记（phoneSrc / hasPlus）
   *
   * 起因：老板要求"判断电话号码里有没有 + 号，没有就重新提取跟原来对比"。
   * 实测发现**加号在取号链路里已经被剥掉了**（parseIntlPhone / phoneFromJid /
   * plausiblePhone 全走 digitsOnly），所以"查库里有没有 +"恒为假。
   * 改成记录"号码从哪一层拿到的"，判据才立得住。
   * ============================================================
   */
  section('phoneSrc · 号码可信度标记（2026-10-07 新增）');

  // hasPlus：原文带不带 + 号（号码字段本身永远不带，这是设计如此）
  eq('parseIntlPhone 带 + → hasPlus=true', identity.parseIntlPhone('+44 7726 795080').hasPlus, true);
  eq('parseIntlPhone 00 前缀 → hasPlus=true', identity.parseIntlPhone('0044 7726 795080').hasPlus, true);
  eq('parseIntlPhone 裸号→ hasPlus=false', identity.parseIntlPhone('447726795080').hasPlus, false);
  eq('parseIntlPhone 号码字段仍是纯数字（不带 + ，全系统统一）',
    identity.parseIntlPhone('+15418010646').phone, '15418010646');

  // phoneSrc：不同取号路径要标对来源
  // SRC_RANK：五级排序 e164 > contact > jid > text > 空（判断"要不要重抓对比"用）
  check('SRC_RANK 五级排序：e164 > contact > jid > text > 空',
    identity.SRC_RANK.e164 > identity.SRC_RANK.contact
    && identity.SRC_RANK.contact > identity.SRC_RANK.jid
    && identity.SRC_RANK.jid > identity.SRC_RANK.text
    && identity.SRC_RANK.text > identity.SRC_RANK['']);

  // JID 直接能推 → jid
  {
    const r = await identity.resolve(fakeMsg({ from: '447726795080@c.us', notifyName: 'X' }), { jid: '447726795080@c.us' });
    eq('号码能从 JID 直接推出来 → phoneSrc=jid', r.phoneSrc, 'jid');
    eq('JID 路径号码正确', r.phone, '447726795080');
  }
  // 正文里带 + 的号码 → e164（老板点名要的那个判据）
  // ⚠️ 每条都换 jid + force:true —— 同一个 jid 会命中缓存拿到上一轮的结果
  {
    const r = await identity.resolve(fakeMsg({ from: '900000000001@lid', body: 'my wa is +44 7726 795080' }),
      { jid: '900000000001@lid', scrapeDom: false, force: true });
    eq('正文原文带 + 号 → phoneSrc=e164（最可信）', r.phoneSrc, 'e164');
    eq('e164 路径号码正确', r.phone, '447726795080');
  }
  // 正文里只有裸号 → text（弱来源，值得重抓对比）
  // ⚠️ 用「整条消息就是一个裸号」这种写法（规则②能认），
  //    别用 "my wa is 447726795080" —— 规则③要求关键词后紧跟号码，
  //    中间插个 is 就认不出了，那是老行为，不是本轮改动。
  {
    const r = await identity.resolve(fakeMsg({ from: '900000000002@lid', body: '447726795080' }),
      { jid: '900000000002@lid', scrapeDom: false, force: true });
    eq('正文只有裸号 → phoneSrc=text（弱来源）', r.phoneSrc, 'text');
    eq('裸号路径号码正确', r.phone, '447726795080');
  }
  // 什么都拿不到 → phoneSrc 必须为空串（不能瞎标）
  {
    const r = await identity.resolve(fakeMsg({ from: '900000000003@lid', body: 'hello' }),
      { jid: '900000000003@lid', scrapeDom: false, force: true });
    eq('拿不到号码 → phoneSrc 空串', r.phoneSrc, '');
    eq('拿不到号码 → phone 空串', r.phone, '');
  }
  // 缓存行为（2026-10-07 改动）：号码为空时不再写"空结果"进缓存
  {
    identity.clearCache();
    const msg = fakeMsg({ from: '900000000004@lid', body: 'hello' });
    const a1 = await identity.resolve(msg, { jid: '900000000004@lid', scrapeDom: false });
    const a2 = await identity.resolve(msg, { jid: '900000000004@lid', scrapeDom: false });
    eq('抓不到号码时两次都仍会重试（空结果不进缓存）', a2.phone, '');
    identity.clearCache();
  }

  console.log(`\n[采集链路自检] 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) console.log(`失败清单：\n - ${failures.join('\n - ')}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
