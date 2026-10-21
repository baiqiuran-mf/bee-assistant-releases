/*
 * probe_tg_events.js —— Telegram MTProto 事件管道实测探针（只读 + 只给自己发一条）
 * =====================================================================
 * 目的：回答一个问题 —— 「MTProto 到底收不收得到 update？」
 * 背景：老板 2026-10-14 报「T 还是无法收到消息」，而 /api/telegram/channel
 *       回报 ready:true（客户端在），却收不到。
 *
 * v2 增强（2026-10-14 第二次实测）：
 *   第 1 版只挂 NewMessage，收到 0 条 —— 但那可能是"自己发的消息只随响应返回、
 *   不走推送"造成的**假阴性**。所以这一版同时挂：
 *     · Raw({})        —— 抓**所有** update（不过滤，最底层）
 *     · NewMessage({}) —— 业务用的那个
 *   再补 getDialogs() 证明读能力正常，从而区分三种情形：
 *     ① Raw 也 0 条        → update 流彻底不通（会话/连接层问题）
 *     ② Raw 有、NewMessage 无 → 事件 builder 过滤问题
 *     ③ 两者都有          → 管道正常，问题在应用侧
 *
 * 🔴 只给自己发，绝不给任何客户发。
 * 用法：node --experimental-sqlite test/probe_tg_events.js [dataDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dataDir = process.argv[2] || 'D:\\蜜蜂采集数据\\wa-assistant\\data';

function readCfg() {
  const yaml = (() => { try { return require('js-yaml'); } catch (e) { return require(path.join(ROOT, 'src/yaml-lite')); } })();
  const cfgs = [
    path.join(process.env.APPDATA || '', 'wa-assistant', 'config.yaml'),
    path.join(ROOT, 'config.yaml'),
  ];
  for (const p of cfgs) {
    try {
      if (fs.existsSync(p)) return { cfg: yaml.load(fs.readFileSync(p, 'utf8')) || {}, file: p };
    } catch (e) { /* next */ }
  }
  return { cfg: {}, file: '(none)' };
}

(async () => {
  const log = (s) => console.log(s);

  const { cfg, file } = readCfg();
  const t = (cfg && cfg.telegram) || {};
  log('# 配置文件：' + file);
  log('# apiId=' + (t.apiId || '(空)') + '  apiHash=' + (t.apiHash ? t.apiHash.slice(0, 6) + '…' : '(空)'));

  const sessFile = path.join(dataDir, 'telegram-session-7.txt');
  log('# 会话文件：' + sessFile);
  if (!fs.existsSync(sessFile)) { log('❌ 会话文件不存在'); process.exit(1); }
  const sess = fs.readFileSync(sessFile, 'utf8').trim();
  log('# 会话串长度：' + sess.length + '（mtime ' + fs.statSync(sessFile).mtime.toISOString() + '）');

  const { TelegramClient } = require(path.join(ROOT, 'node_modules/teleproto'));
  const { StringSession } = require(path.join(ROOT, 'node_modules/teleproto/sessions'));
  const { NewMessage, Raw } = require(path.join(ROOT, 'node_modules/teleproto/events'));

  const client = new TelegramClient(new StringSession(sess), Number(t.apiId), String(t.apiHash), {
    connectionRetries: 2,
    deviceModel: 'BeeProbe',
    systemVersion: '1.0',
    appVersion: '1.0',
    langCode: 'zh',
  });

  try {
    await client.connect();
    log('✅ connect() 成功');
  } catch (e) {
    log('❌ connect() 失败：' + ((e && e.message) || e));
    process.exit(1);
  }

  try {
    const me = await client.getMe();
    log('✅ getMe()：id=' + (me && me.id) + '  username=@' + (me && (me.username || '-')) + '  phone=' + (me && (me.phone || '-')));
  } catch (e) { log('❌ getMe() 失败：' + ((e && e.message) || e)); }

  try { log('✅ isUserAuthorized = ' + (await client.isUserAuthorized())); } catch (e) { log('❌ isUserAuthorized 异常：' + ((e && e.message) || e)); }

  // 读能力：能列会话说明会话/连接完全正常
  try {
    const dialogs = await client.getDialogs({ limit: 5 });
    log('✅ getDialogs() 返回 ' + dialogs.length + ' 条：' +
      dialogs.slice(0, 5).map((d) => (d.name || d.title || d.id)).join(' / '));
  } catch (e) { log('⚠️  getDialogs() 失败：' + ((e && e.message) || e)); }

  const rawTypes = {};
  let rawN = 0;
  const got = [];

  client.addEventHandler((upd) => {
    rawN += 1;
    const name = (upd && upd.className) || (upd && upd.constructor && upd.constructor.name) || 'unknown';
    rawTypes[name] = (rawTypes[name] || 0) + 1;
    log('📡 Raw update #' + rawN + '：' + name);
  }, new Raw({}));
  log('# 已挂 Raw({}) 全量监听');

  client.addEventHandler((upd) => {
    const m = upd && upd.message;
    if (!m) return;
    got.push({ id: m.id, out: !!m.out });
    log('🎯 NewMessage！msgId=' + m.id + '  out=' + !!m.out + '  text=' + JSON.stringify((m.message || '').slice(0, 40)));
  }, new NewMessage({}));
  log('# 已挂 new NewMessage({}) 监听');

  const stamp = 'BEE-PROBE-' + Date.now();
  try {
    const sent = await client.sendMessage('me', { message: stamp });
    log('➡️  已给自己发出一条测试消息：' + stamp + '（返回 id=' + (sent && sent.id) + '）');
  } catch (e) { log('⚠️  给自己发消息失败：' + ((e && e.message) || e)); }

  log('# 等待 25 秒看 update 是否回来…');
  await new Promise((r) => setTimeout(r, 25000));

  log('');
  log('==================== 结论 ====================');
  log('Raw update 总数：' + rawN + (rawN ? '  类型分布：' + JSON.stringify(rawTypes) : ''));
  log('NewMessage 事件数：' + got.length);
  if (rawN > 0 && got.length === 0) {
    log('⚠️  Raw 有数据、NewMessage 没有 → 事件 builder 过滤问题（不是连接问题）。');
  } else if (rawN === 0) {
    log('❌ 连 Raw 都收不到任何 update → update 流彻底不通。');
    log('   读（getDialogs）可能正常，但推送这条线没建立起来。');
  } else {
    log('✅ 事件管道正常：Raw 与 NewMessage 都收到了。');
    log('   → 那软件收不到，问题必在应用侧（重复客户端 / 闸门丢弃 / 入库链路）。');
  }

  try { await client.disconnect(); log('# 已断开探针连接'); } catch (e) { /* ignore */ }
  process.exit(0);
})().catch((e) => {
  console.error('探针异常：', (e && e.stack) || e);
  process.exit(1);
});
