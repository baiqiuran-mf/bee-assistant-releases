/**
 * 浏览器会话：每个 WhatsApp 账号一个独立实例
 *
 * 隔离三件套：
 *   1. 独立 userDataDir（LocalAuth 的 clientId）—— cookie / localStorage 物理隔离
 *   2. 独立代理 IP —— 启动参数 --proxy-server，每号一个出口
 *   3. puppeteer-extra + stealth —— Node 层补丁，消除自动化痕迹（不是浏览器扩展）
 *
 * 另外：时区与语言必须和代理所在地一致，否则代理在美国、时区在上海，一眼假。
 */

const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');

let puppeteer;
try {
  const extra = require('puppeteer-extra');
  extra.use(require('puppeteer-extra-plugin-stealth')());
  puppeteer = extra;
} catch (e) {
  console.warn('[session] 未安装 puppeteer-extra，反检测能力会打折扣');
  puppeteer = require('puppeteer');
}

/** 从代理 URL 里剥离账密，Chrome 不接受 URL 内嵌账密（会静默丢弃导致 407） */
function splitProxy(proxyUrl) {
  if (!proxyUrl) return { url: null, auth: null };
  try {
    const u = new URL(proxyUrl);
    const auth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : null;
    u.username = '';
    u.password = '';
    return { url: u.toString().replace('://', '://'), auth };
  } catch (e) {
    return { url: proxyUrl, auth: null };
  }
}

async function launchBrowser(account, cfg) {
  const { url, auth } = splitProxy(account.proxy);

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled', // 关键：去掉自动化标记
    `--lang=${account.locale || 'en-US'}`,
    `--accept-lang=${account.locale || 'en-US'},en`,
    `--timezone=${account.timezone || 'America/Chicago'}`,
    '--window-size=1280,860',
  ];

  if (url) args.push(`--proxy-server=${url}`);
  if (cfg.browser?.windowPosition) args.push(`--window-position=${cfg.browser.windowPosition}`);

  const launchOpts = {
    headless: cfg.browser?.headless === true, // 默认 false：有头模式指纹更像真人
    args,
  };
  if (cfg.browser?.executablePath) launchOpts.executablePath = cfg.browser.executablePath;

  const browser = await puppeteer.launch(launchOpts);

  // 代理需要账密时，对每个新开的页面做认证
  if (auth) {
    const attach = async (target) => {
      if (target.type() !== 'page') return;
      const page = await target.page().catch(() => null);
      if (page && !page.__authed) {
        page.__authed = true;
        await page.authenticate(auth).catch(() => {});
      }
    };
    browser.on('targetcreated', attach);
    for (const p of await browser.pages()) await p.authenticate(auth).catch(() => {});
  }

  return browser;
}

/**
 * 启动一个账号
 * @param {object} account config.yaml 里的账号配置
 * @param {object} cfg 全局配置
 * @param {object} handlers { onQR, onReady, onMessage, onDisconnected, onError }
 */
async function createSession(account, cfg, handlers = {}) {
  const sessionDir = path.resolve(process.cwd(), cfg.browser?.sessionDir || './sessions');
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const browser = await launchBrowser(account, cfg);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `acc-${account.id}`, dataPath: sessionDir }),
    puppeteer: { browserWSEndpoint: browser.wsEndpoint() },
    // 历史消息同步：首次登录时能拉到更早的对话
    restartOnAuthFail: true,
  });

  client.on('qr', (qr) => {
    console.log(`[账号${account.id}] 需要扫码登录`);
    handlers.onQR?.(account, qr);
  });

  client.on('ready', () => {
    console.log(`[账号${account.id}] 就绪`);
    handlers.onReady?.(account, client);
  });

  client.on('authenticated', () => console.log(`[账号${account.id}] 认证成功`));
  client.on('auth_failure', (m) => console.error(`[账号${account.id}] 认证失败：${m}`));
  client.on('disconnected', (r) => {
    console.warn(`[账号${account.id}] 断开：${r}`);
    handlers.onDisconnected?.(account, r);
  });

  // message_create 覆盖双向消息（含自己发出的），这样才能自动判断"已回复"
  client.on('message_create', (msg) => {
    handlers.onMessage?.(account, client, msg);
  });

  client.on('error', (err) => handlers.onError?.(account, err));

  await client.initialize();
  return { client, browser };
}

module.exports = { createSession, splitProxy };
