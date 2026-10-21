/**
 * 复现「修改后无法获取信息」的回归（2026-10-07）
 *
 * 根因：src/main.js handleMessage() 第 676 / 685 行引用了 `opt.client`，
 * 但这个函数的形参叫 `opts`（没有叫 opt 的形参，也没有模块级 opt 变量）。
 * → 老客户（isNew=false）收到消息时，`opt.client` 直接抛
 *   ReferenceError: opt is not defined
 * → 被 onMessage 的 try/catch 吞掉，只在日志里留一行「处理消息出错」。
 * → 现象：新客户能建档（走不到那两行），但**老客户的每一条消息都不入库、不显示**，
 *   也就是「修改后无法获取信息」。
 *
 * 本脚本：不依赖浏览器，纯内存/隔离库跑真实 handleMessage()。
 */
process.env.BEE_TEST = '1';
const path = require('path');
const fs = require('fs');
const os = require('os');

// 隔离数据目录，绝不碰生产库
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-repro-'));
process.env.BEE_DATA_DIR = tmp;

const main = require('../src/main');
const db = require('../src/db');

const account = { id: 1 };

function mkMsg(text, from) {
  return {
    id: { id: 'x' + Math.random().toString(36).slice(2) },
    from,
    to: '1@s.whatsapp.net',
    fromMe: false,
    body: text,
    type: 'chat',
    timestamp: Math.floor(Date.now() / 1000),
    hasMedia: false,
  };
}

(async () => {
  const jid = '15550001111@s.whatsapp.net';
  let fail = 0;
  const ok = (c, m) => { if (!c) fail++; console.log((c ? '  ✅' : '  ❌') + ' ' + m); };

  // 第 1 条：建档（isNew=true，走不到出错那两行）
  await main.handleMessage(account, mkMsg('first hello', jid), { client: null });
  const c = db.listCustomers.all().find((x) => x.wa_jid === jid);
  console.log('\n[1] 新客户建档');
  ok(!!c, `客户已建档：${c?.code}`);

  // 第 2 条：老客户回消息 —— 这条才是崩的
  console.log('\n[2] 老客户回消息（关键）');
  let err = null;
  try {
    await main.handleMessage(account, mkMsg('second message', jid), { client: null });
  } catch (e) {
    err = e;
  }
  if (err) {
    fail++;
    console.log(`  ❌ 抛异常：${err.constructor.name}: ${err.message}`);
    console.log('     → 这条消息没入库、没广播、界面上什么都看不到');
  } else {
    console.log('  ✅ 没有抛异常');
  }

  // 验证：消息到底入库了没有
  const rows = db.listMessages.all(c.code);
  console.log(`\n[3] 入库条数 = ${rows.length}（期望 2）`);
  if (rows.length < 2) { fail++; console.log('  ❌ 老客户那条消息丢了'); }
  else console.log('  ✅ 两条都在');

  // ---- 4) base64 图片：正文必须是 [图片]，不能是一串 data:image/... ----
  console.log('\n[4] 图片消息正文不许出现 base64');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const jid2 = '15550003333@s.whatsapp.net';
  await main.handleMessage(account, {
    id: { id: 'm1' }, from: jid2, to: '1@s.whatsapp.net', fromMe: false,
    body: 'data:image/png;base64,' + png, type: 'image',
    timestamp: Math.floor(Date.now() / 1000), hasMedia: false,
  }, { client: null });
  const c2 = db.listCustomers.all().find((x) => x.wa_jid === jid2);
  const r2 = db.listMessages.all(c2.code)[0];
  ok(r2.body === '[图片]', `正文 = ${JSON.stringify(r2.body)}`);
  ok(r2.media_src === 'base64', `media_src = ${JSON.stringify(r2.media_src)}`);
  ok(!!r2.media_path && fs.existsSync(r2.media_path), '图片文件已落盘');

  // ---- 5) applyRegrab：冲突时不得改写 phone_src ----
  console.log('\n[5] 号码冲突不得污染 phone_src');
  const sql = db.db.prepare.bind(db.db);
  const { customer: c3 } = db.getOrCreateCustomer(1, '15550004444@s.whatsapp.net', {
    name: '冲突测试', phone: '5411111111', phoneSrc: 'text', region: '',
  });
  sql('UPDATE customers SET phone=?, phone_src=? WHERE code=?')
    .run('5411111111', 'text', c3.code);
  const res = db.applyRegrab(c3.code, { phone: '5412222222', phoneSrc: 'e164', country: 'US' });
  const after = db.getCustomer.get(c3.code);
  ok(res.action === 'conflict', `action = ${res.action}（期望 conflict）`);
  ok(after.phone === '5411111111', `号码保持原值 = ${after.phone}`);
  ok(after.phone_src === 'text', `phone_src 未被改写 = ${after.phone_src}`);

  // ---- 6) manual 人工号永不被覆盖 ----
  console.log('\n[6] 人工填的号码谁都不许动');
  sql('UPDATE customers SET phone=?, phone_src=? WHERE code=?')
    .run('5413333333', 'manual', c3.code);
  const res2 = db.applyRegrab(c3.code, { phone: '5414444444', phoneSrc: 'e164', country: 'US' });
  ok(res2.action === 'skip', `action = ${res2.action}（期望 skip）`);
  ok(db.getCustomer.get(c3.code).phone === '5413333333', '人工号保持不变');

  // ---- 7) 空号 → 填上；同号 → 只升级来源 ----
  console.log('\n[7] 空号填上 / 同号升级来源');
  const { customer: c4 } = db.getOrCreateCustomer(1, '15550005555@s.whatsapp.net', { name: '空号', region: '' });
  sql("UPDATE customers SET phone='', phone_src='' WHERE code=?").run(c4.code);
  const r4 = db.applyRegrab(c4.code, { phone: '5415555555', phoneSrc: 'jid', country: 'US' });
  ok(r4.action === 'filled', `空号 → action=${r4.action}`);
  ok(db.getCustomer.get(c4.code).phone === '5415555555', '空号已填上');

  const r5 = db.applyRegrab(c4.code, { phone: '5415555555', phoneSrc: 'e164', country: 'US' });
  ok(r5.action === 'upgraded', `同号更强来源 → action=${r5.action}`);
  ok(db.getCustomer.get(c4.code).phone_src === 'e164', '来源已升级为 e164');

  console.log(`\n=== ${fail === 0 ? '通过' : '失败'}：${fail} 个问题 ===`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本自身异常：', e);
  process.exit(2);
});
