/**
 * 实验：把一份导出的客户对话 .docx（已由 tools/parse_docx_chat.py 解析成 JSON）
 * 当作某个客户的历史对话导入隔离数据库，跑【真】AI 抽取档案，
 * 然后打开「客户档案」弹窗截图，方便肉眼核对抽到了什么、有没有错。
 *
 * 运行（必须指向隔离目录，别碰真实 data/）：
 *   python tools/parse_docx_chat.py "输入.docx" tools/_exp_tom_messages.json
 *   BEE_DATA_DIR=$(mktemp -d) node --experimental-sqlite tools/exp_extract_docx.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const MSG_JSON = process.env.EXP_MSG_JSON || path.join(__dirname, '_exp_tom_messages.json');
const PROFILE_JSON = path.join(__dirname, '_exp_tom_profile.json'); // 抽取结果缓存，留档方便对照
const OUT_MODAL = path.join(ROOT, 'preview', '实验_档案弹窗_从对话抽取.png');
const OUT_MAIN = path.join(ROOT, 'preview', '实验_主界面_地区与Day.png');
const PORT = Number(process.env.EXP_PORT || 8987);

if (!process.env.BEE_DATA_DIR) {
  console.error('拒绝跑：请先设置 BEE_DATA_DIR 指向一个隔离目录（避免动到真实 data/）');
  process.exit(1);
}

const db = require('../src/db');
const doc = require('../src/customerDoc');
const ai = require('../src/ai');
const knowledge = require('../src/knowledge');
const { createServer } = require('../src/server');
const { loadConfig } = require('../src/main');

function request(method, port, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (e) { resolve({ raw: buf }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const cfg = loadConfig();
  ai.setAiConfig(cfg.ai || {});
  knowledge.setKnowledgeConfig(cfg.knowledge || {});

  for (const a of (cfg.accounts || [])) {
    db.upsertAccount.run({ id: a.id, label: a.label || '', phone: a.phone || '', proxy: a.proxy || '' });
  }

  const data = JSON.parse(fs.readFileSync(MSG_JSON, 'utf8'));
  const phone = (data.meta['电话'] || '+13303307087').replace(/[^\d+]/g, '');
  const jid = phone.replace(/^\+/, '') + '@c.us';

  const { customer, isNew } = db.getOrCreateCustomer(1, jid, { phone, name: null });
  const code = customer.code;
  db.db.prepare('DELETE FROM messages WHERE customer_code=?').run(code); // 重复跑时先清干净

  let n = 0;
  for (const m of data.messages) {
    const ts = `${m.date}T${m.time}:00+09:00`;
    db.saveMessage({
      customerCode: code, accountId: 1, direction: m.direction,
      body: m.body, bodyZh: m.body_zh || null, msgTs: ts, silent: true,
    });
    n++;
  }
  console.log(`导入 ${n} 条消息 → 客户 ${code}（isNew=${isNew}，电话 ${phone}）`);

  const srv = createServer(
    { db, doc, ai, knowledge, cfg, getAccountStates: () => (cfg.accounts || []).map((a) => ({ ...a, enabled: a.id === 1, status: 'offline' })) },
    PORT
  );
  await new Promise((res, rej) => { srv.server.once('error', rej); srv.server.listen(PORT, '127.0.0.1', res); });

  console.log('→ 调 /extract，用真 AI（DeepSeek）抽取…');
  const t0 = Date.now();
  const r = await request('POST', PORT, `/api/customer/${code}/extract`);
  console.log(`← 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.error) {
    console.error('抽取失败：', r.error);
  } else {
    console.log('=== AI 抽到的字段 ===');
    console.log(JSON.stringify(r.profile, null, 2));
    try { fs.writeFileSync(PROFILE_JSON, JSON.stringify(r.profile, null, 2), 'utf8'); } catch (e) {}
  }

  const c = db.getCustomer.get(code);
  let extra = {};
  try { extra = JSON.parse(c.profile_json || '{}'); } catch (e) { extra = {}; }
  console.log('=== 落库后的客户行 ===');
  console.log(JSON.stringify({
    code: c.code, name: c.name, phone: c.phone, region: c.region, timezone: c.timezone,
    stage_day: c.stage_day, created_at: c.created_at, profile_json: extra,
  }, null, 2));
  if (r.docFile) console.log('档案文档：', r.docFile);

  // ---- 截图：客户档案弹窗 + 主界面（核对「地区」常在、Day 计算） ----
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 1500, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
  await new Promise((res) => setTimeout(res, 1200));

  // 打开档案弹窗（不切左栏对话，避免触发翻译）
  await page.evaluate((cd) => {
    const sim = document.getElementById('sim-panel');
    if (sim) sim.classList.add('hidden');
    openProfileModal(cd);
  }, code);
  // 去掉弹窗自身的 86vh 限高与内部滚动，否则末尾几个字段（父母/宠物/孩子）会被截掉
  await page.addStyleTag({ content: '#pf-modal .pf-box{max-height:none !important;overflow:visible !important;}' });
  await new Promise((res) => setTimeout(res, 1000));

  const handle = await page.$('#pf-modal .pf-box');
  if (handle) {
    await handle.screenshot({ path: OUT_MODAL, captureBeyondViewport: true });
    console.log('已截图（档案弹窗，整窗）：', OUT_MODAL);
  } else {
    console.error('弹窗没打开，跳过截图');
  }

  // 主界面截图用常规高度，避免大片空白
  await page.setViewport({ width: 1360, height: 900, deviceScaleFactor: 2 });
  await new Promise((res) => setTimeout(res, 250));

  // 主界面：关掉弹窗，用真实客户数据渲染中栏头部，核对「地区」常在 + Day
  const factsText = await page.evaluate((obj) => {
    const m = document.getElementById('pf-modal');
    if (m) m.classList.add('hidden');
    renderChatHead(obj, {});
    return (document.querySelector('#chat-head .ch-facts')?.textContent || '').replace(/\s+/g, ' ').trim();
  }, { code: c.code, name: c.name || '未命名', region: c.region, timezone: c.timezone, created_at: c.created_at, stage_day: c.stage_day });
  console.log('中栏档案条渲染结果：', factsText);
  await new Promise((res) => setTimeout(res, 300));
  await page.screenshot({ path: OUT_MAIN });
  console.log('已截图（主界面）：', OUT_MAIN);

  await browser.close();
  await new Promise((res) => srv.server.close(res));
})().catch((e) => {
  console.error('实验失败：', e && e.stack || e);
  process.exit(1);
});
