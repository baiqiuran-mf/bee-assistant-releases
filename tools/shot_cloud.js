/**
 * v1.0.1 云端界面截图（给老板看新东西长什么样）
 *
 * 两张图：
 *   preview/云端_设置页签.png   「全局设置」窗口里的「☁ 云端」页签（填地址/编号/密码）
 *   preview/云端_主窗提示条.png 主窗口顶栏下面那条「还没登录云端编号」提示条
 *
 * 只读渲染：不写真实数据库、不起 WhatsApp、不调 AI、不连真的云端。
 *
 * 跑法：node --experimental-sqlite tools/shot_cloud.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
// 用一份临时数据目录，绝不碰真实 data/
process.env.BEE_DATA_DIR = path.join(ROOT, '.tmp-shot-cloud');

const db = require('../src/db');
const doc = require('../src/customerDoc');
const ai = require('../src/ai');
const knowledge = require('../src/knowledge');
const { createServer } = require('../src/server');
const { loadConfig } = require('../src/main');

  // 为了让提示条露出来，临时把云端地址写进这份隔离 config（真实 config.yaml 不动）。
  // ⚠️ 必须在 cloud.loadConfig() 之前写，否则客户端读到的还是空地址。
  const { configFile } = require('../src/paths');
  try {
    const yaml = require('js-yaml');
    const f = configFile();
    const c = yaml.load(fs.readFileSync(f, 'utf8')) || {};
    c.cloud = { baseUrl: 'https://wa-cloud-api.example.workers.dev', lastCode: '' };
    fs.writeFileSync(f, yaml.dump(c), 'utf8');
    console.log('（已给隔离配置填了一个示例云端地址，只为让提示条显示出来）');
  } catch (e) {
    console.log('写隔离配置失败（提示条可能不显示）：' + e.message);
  }
  require('../src/cloud').loadConfig();

(async () => {
  const cfg = loadConfig();

  const srv = createServer({
    db, doc, ai, knowledge, cfg,
    getAccountStates: () => (cfg.accounts || []).map((a) => ({
      id: a.id, label: a.label || `账号${a.id}`, enabled: !!a.enabled,
      status: 'offline', proxy: a.proxy || '',
    })),
    openAccount: async () => ({}),
    prefillChat: async () => ({ ok: true, method: 'prefill' }),
    simulateMessage: () => ({}),
    clearSimulated: () => {},
  }, 0);
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  console.log('本地服务：' + base);

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const outDir = path.join(ROOT, 'preview');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  /* ---------- 1. 设置窗口 · 云端页签 ---------- */
  const p1 = await browser.newPage();
  await p1.setViewport({ width: 1000, height: 760 });
  await p1.goto(`${base}/settings.html#cloud`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 600));
  const f1 = path.join(outDir, '云端_设置页签.png');
  await p1.screenshot({ path: f1 });
  console.log('✓ ' + f1);
  await p1.close();

  /* ---------- 2. 主窗口 · 云端提示条 ---------- */
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 1440, height: 900 });
  // ⚠️ 主窗口挂着 SSE 长连接，networkidle0 永远不会触发 → 用 domcontentloaded
  await p2.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));
  const shown = await p2.evaluate(() => {
    const b = document.getElementById('cloud-bar');
    return b ? !b.classList.contains('hidden') : false;
  });
  console.log('提示条是否显示：' + (shown ? '是' : '否'));
  const f2 = path.join(outDir, '云端_主窗提示条.png');
  await p2.screenshot({ path: f2, clip: { x: 0, y: 0, width: 1440, height: 260 } });
  console.log('✓ ' + f2);
  await p2.close();

  await browser.close();
  try { srv.server.close(); } catch (e) { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
