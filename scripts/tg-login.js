/**
 * tg-login.js — Telegram 一次性登录（v2.5.1053）
 *
 * 用途：teleproto 走 MTProto 协议，需要你的 Telegram 号做一次登录，把会话串
 *       存到应用数据目录（teleproto 的 session 文件）。之后 app 启动会自动连，
 *       不用再登。这与网页版是同一个号的两个会话，互不踢。
 *
 * 用法（在 wa-assistant 项目根目录）：
 *   node scripts/tg-login.js 7          # 给 Tele①（id=7）登录；账号 id 见 config.yaml
 *
 * 前置：先去 https://my.telegram.org → API development tools → 创建应用，
 *       把 api_id / api_hash 填进 config.yaml 的 telegram 段。
 *
 * 运行后会交互式问你：手机号 → Telegram 发来的验证码 → 两步验证密码（没有就直接回车）。
 * 登录成功会把 session 写到 paths.DATA_ROOT/telegram-session-<id>.txt。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { DATA_ROOT, configFile } = require('../src/paths');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

function loadConfig() {
  const f = configFile();
  if (!fs.existsSync(f)) throw new Error(`找不到配置文件：${f}`);
  const yaml = require('js-yaml');
  return yaml.load(fs.readFileSync(f, 'utf8')) || {};
}

const cfg = loadConfig();
const tgCfg = cfg.telegram || {};
const apiId = parseInt(tgCfg.apiId, 10);
const apiHash = tgCfg.apiHash || '';
if (!apiId || !apiHash) {
  console.error('❌ 请先在 config.yaml 的 telegram 段填好 apiId / apiHash（去 my.telegram.org 创建应用获取）');
  process.exit(1);
}

const accountId = parseInt(process.argv[2] || '7', 10);
const sessionFile = path.join(DATA_ROOT, `telegram-session-${accountId}.txt`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

(async () => {
  console.log(`→ 目标账号 id=${accountId}，session 将写到：${sessionFile}`);
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: () => ask('手机号（含国家码，如 +86138xxxx）：'),
    phoneCode: () => ask('Telegram 发来的验证码：'),
    password: async () => {
      const p = await ask('两步验证密码（没有就直接回车）：');
      return p || '';
    },
    onError: (e) => console.log('登录过程出错：', e && e.message),
  });

  const me = await client.getMe();
  const session = client.session.save();
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, session, 'utf8');

  console.log('✅ 登录成功！会话已保存。');
  console.log('   账号：', me.username ? '@' + me.username : (me.phone || me.id));
  console.log('   现在启动/重启蜜蜂信息采集，Telegram 采集会自动连上。');

  await client.disconnect();
  rl.close();
})().catch((e) => {
  console.error('❌ 登录失败：', e && e.message);
  rl.close();
  process.exit(1);
});
