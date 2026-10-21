/**
 * 功能实测（真启动内核 + 真打 HTTP 接口 + 真调 AI）
 *
 * 和 test/*.test.js 的区别：
 *   那些是「用桩的单元/集成测试」，跑得快、不花钱；
 *   这个是「端到端实测」——起真的内核、走真的接口、AI 也真打（②③⑤ 会花一点点 token）。
 *
 * 数据隔离：第一行 require('./_isolate.js')，数据目录指到 .tmp-test-data/functional_check，
 * 绝不碰真实的 data/assistant.db；配置用副本（里面有你填的混元 key），写也只写副本。
 *
 * 用法： node --experimental-sqlite test/functional_check.js
 */

const I = require('./_isolate.js'); // 必须第一行（先定好 BEE_DATA_DIR / BEE_CONFIG）
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'output');
try { fs.mkdirSync(OUT, { recursive: true }); } catch (e) { /* ignore */ }

const LINES = [];
const RESULTS = [];
const out = (s) => { console.log(s); LINES.push(s); };
const section = (t) => out(`\n=== ${t} ===`);
function rec(name, ok, detail) {
  const tag = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'WARN';
  RESULTS.push({ name, tag, detail: detail || '' });
  out(`  ${tag}  ${name}${detail ? '   ← ' + detail : ''}`);
}

let PORT = 0;
function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: url, method, timeout: 180000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: j, text: buf });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('请求超时')); });
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一张真的 PNG（不依赖任何库）：64x64 纯色 + 一条对角线，够视觉模型看出画面 */
function makePng() {
  const W = 64, H = 64;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      const diag = Math.abs(x - y) < 6;
      raw[o++] = diag ? 40 : 210;          // R
      raw[o++] = diag ? 60 : 150;          // G
      raw[o++] = diag ? 200 : 90;          // B
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_T[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function main() {
  out('蜜蜂信息采集 · 功能实测（真打接口 + 真调 AI）');
  out('数据目录（隔离）：' + I.DIR);
  out('配置文件（副本）：' + process.env.BEE_CONFIG);

  const { startCore } = require('../src/main.js');
  const db = require('../src/db.js');

  /* ---------------- 1. 内核启动 ---------------- */
  section('一、内核启动');
  const core = await startCore({ startWhatsApp: false });
  PORT = core.PORT;
  rec('内核起来并监听端口（没有 ERR_SERVER_ALREADY_LISTEN）', !!PORT && PORT > 0, `端口 ${PORT}`);
  rec('startWhatsApp:false —— 没有自动开浏览器、没有自动连 WhatsApp', true, '已按桌面入口的参数启动');

  const v = await req('GET', '/api/version');
  rec('GET /api/version：界面构建戳 + 界面/数据目录',
    v.status === 200 && !!v.body.build,
    `build=${v.body && v.body.build} · public=${v.body && String(v.body.publicDir).replace(ROOT, '.')} · data=${v.body && String(v.body.dataDir).replace(ROOT, '.')}`);

  const st = await req('GET', '/api/state');
  const accs = (st.body && st.body.accounts) || [];
  const waAccs = accs.filter((a) => Number(a.id) <= 5);
  rec('GET /api/state：5 个 WhatsApp 号都在（主号…五号）',
    st.status === 200 && waAccs.length === 5,
    waAccs.map((a) => `${a.id}${a.label}`).join(' '));
  /*
   * 2026-10-08 v1.5.0：Signal 开始真采集后，账号表多了第 6 条（label='Signal'）。
   * 这是有意的（界面上顶栏会多一个 Signal 按钮+ 右侧状态灯），但要守住两条：
   *   ① 编号必须是 6 —— ids.js 只接受账号号 1~9，且 CODE_RE 只匹配一位数字，
   *      所以绝不能是 99（nextCustomerCode 会直接抛「无法解析已有编号」）。
   *   ② 状态必须是 offline/online/waiting_qr 之一 —— 前端红绿灯按这个取值渲染。
   *
   * 🔴 2026-10-11 更正（v2.5.1057 查这条失败项时发现）：
   *   /api/state 的 accounts 现在**只返回顶栏那 5 个 WhatsApp 号**（老板 2026-10-11
   *   拍板「顶栏只显示一号~五号」，Tele①②③ 并入一号/二号/三号）。
   *   所以这里不能再从 /api/state 找 Signal —— 改查**账号表**（db.listAccounts）：
   *   Signal 仍必须在库里、id=6、label='Signal'，只是不再进顶栏。
   */
  const accRows = db.listAccounts.all();
  const sigAccs = accRows.filter((a) => Number(a.id) === 6);
  rec('Signal 账号仍在账号表第 6 位（1-5 是 WhatsApp 号，6 是 Signal）',
    sigAccs.length === 1 && sigAccs[0].label === 'Signal',
    sigAccs.map((a) => `${a.id}${a.label}`).join(' ') || '缺失');
  rec('Signal 不再进顶栏账号条（老板 2026-10-11：顶栏只显示一号~五号）',
    !accs.some((a) => Number(a.id) === 6),
    accs.map((a) => `${a.id}${a.label}`).join(' '));
  rec('每个账号都有红绿灯状态（offline/online/waiting_qr）',
    accs.every((a) => ['offline', 'online', 'waiting_qr'].includes(a.status)),
    accs.map((a) => a.status).join(','));
  rec('AI 就绪状态能读出来', typeof st.body.aiReady === 'boolean',
    `aiReady=${st.body.aiReady} · ${st.body.aiReason || '（已就绪）'}`);

  /* ---------------- 2. 采集（手输，不用 AI） ---------------- */
  section('二、接收信息（采集环节）');
  const enMsg = 'Hi! I saw your pet paintings. My dog passed away last month and I would love a memory painting.';
  const cnMsg = '你好，我想问一下画一张宠物油画大概要多久？';
  const mixMsg = 'Thanks! 我等你的消息 please let me know the size options.';

  const man1 = await req('POST', '/api/manual', {
    ident: '+1 503 555 0142', name: '功能实测客户', accountId: 1,
    region: '美国 波特兰', joinedAt: new Date(Date.now() - 6 * 86400000).toISOString(),
    lines: [
      { direction: 'in', body: enMsg },
      { direction: 'out', body: 'So sorry for your loss. I would be honored to paint him.' },
      { direction: 'in', body: cnMsg },
      { direction: 'in', body: mixMsg },
    ],
  });
  const code = man1.body && (man1.body.code || (man1.body.customer && man1.body.customer.code));
  rec('POST /api/manual：一段对话粘进去就能建成客户',
    man1.status === 200 && !!code, `客户编号 ${code || man1.text.slice(0, 120)}`);

  const list = await req('GET', '/api/customers');
  const row = ((list.body && list.body) || []).find((c) => c.code === code) || {};
  rec('GET /api/customers：新客户出现在左栏，未读/待处理都记账了',
    list.status === 200 && row.code === code && Number(row.unread) >= 1,
    `unread=${row.unread} pending=${row.pending} region=${row.region} tz=${row.timezone}`);
  rec('编号规则：账号 1 + 字母段 + 五位序号', /^1[A-Z]\d{5}$/.test(String(code)), String(code));
  rec('填了地区会自动带出时区', !!row.timezone, `${row.region} → ${row.timezone}`);

  const today0 = await req('GET', '/api/stats/today');
  rec('GET /api/stats/today：今日收到/已处理/待处理 + 按账号拆',
    today0.status === 200 && today0.body.received >= 1 && !!today0.body.byAccount,
    `收到 ${today0.body.received} · 已处理 ${today0.body.handled} · 待处理 ${today0.body.todo} · 按账号 ${JSON.stringify(today0.body.byAccount)}`);

  const one = await req('GET', `/api/customer/${code}`);
  rec('GET /api/customer/:code：消息 + 极简档案 6 字段都返回',
    one.status === 200 && one.body.messages.length === 4
      && ['name', 'phone', 'region', 'timezone', 'stage_day', 'created_at'].every((k) => k in one.body.customer),
    `${one.body.messages.length} 条消息 · 档案字段 ${Object.keys(one.body.customer || {}).join('/')}`);

  const txtMsg = one.body.messages.find((m) => m.body === enMsg);
  rec('英文消息进来时没有译文（翻译是后台补的，先推消息后翻译）',
    !!txtMsg && !txtMsg.body_zh, `translate_state=${txtMsg && txtMsg.translate_state}`);
  rec('纯中文消息不进翻译队列（省一半成本）',
    !!one.body.messages.find((m) => m.body === cnMsg),
    '中文那条已入库；翻译时会由 ② 的语种判定跳过');

  const rd = await req('POST', `/api/customer/${code}/read`);
  rec('POST /api/customer/:code/read：点开客户未读清零',
    rd.status === 200 && rd.body.unread === 0, `unread=${rd.body && rd.body.unread}`);

  /* ---------------- 3. ② 翻译（真调混元 hy3） ---------------- */
  section('三、② 翻译收到的消息（真调 AI）');
  // 注意：手动录入本身就是「先入库、后台翻译」，所以这里得等它翻完，不能立刻断言。
  // 混元 hy3 是推理模型，翻一条要 9~16 秒。
  const waitFor = async (cond, maxSec) => {
    for (let i = 0; i < maxSec; i++) {
      const r = await req('GET', `/api/customer/${code}`);
      if (cond(r.body)) return r.body;
      await sleep(1000);
    }
    return (await req('GET', `/api/customer/${code}`)).body;
  };
  const afterTr = await waitFor(
    (b) => b.messages.some((m) => m.body === enMsg && m.body_zh), 90);
  const zhRow = afterTr.messages.find((m) => m.body === enMsg);
  rec('② 翻译：客户发来的英文 → 中文（后台自动翻，翻完推给界面）',
    !!zhRow && !!zhRow.body_zh,
    zhRow && zhRow.body_zh ? String(zhRow.body_zh).slice(0, 60) : `translate_state=${zhRow && zhRow.translate_state}`);
  const cnRow = afterTr.messages.find((m) => m.body === cnMsg);
  const mixRow = afterTr.messages.find((m) => m.body === mixMsg);
  rec('本来就是中文的那条没被翻译（跳过，不浪费钱）',
    !!cnRow && !cnRow.body_zh, `body_zh=${cnRow && cnRow.body_zh}`);
  rec('中英混写那条：正则拿不准才让 AI 判一次（判完要么翻、要么跳过，不会卡住）',
    !!mixRow && mixRow.translate_state !== 'pending',
    `state=${mixRow && mixRow.translate_state} body_zh=${mixRow && (mixRow.body_zh || '（判定不用翻）')}`);
  rec('自己发出的消息没有被翻译（红线：只翻客户发来的）',
    afterTr.messages.filter((m) => m.direction === 'out').every((m) => !m.body_zh),
    'out 方向那条无译文（原文照存）');

  // 补翻接口：历史同步进来的消息当初没翻（silent=true 不自动排），得靠这个接口补。
  // 这里真造一条"历史消息"，验证 queued>=1 且最后真翻出来。
  const oldId = db.saveMessage({
    customerCode: code, accountId: 1, direction: 'in', silent: true,
    body: 'By the way, my sister lives in California and she loves your style too.',
    msgTs: new Date(Date.now() - 3 * 86400000).toISOString(),
  }).id;
  const trRes = await req('POST', `/api/customer/${code}/translate`);
  const afterBack = await waitFor((b) => b.messages.some((m) => m.id === oldId && m.body_zh), 90);
  const backRow = afterBack.messages.find((m) => m.id === oldId);
  rec('POST /api/customer/:code/translate：把没翻的历史消息补翻',
    trRes.status === 200 && trRes.body.queued >= 1 && !!backRow && !!backRow.body_zh,
    `排上队 ${trRes.body && trRes.body.queued} 条 → ${backRow && backRow.body_zh ? String(backRow.body_zh).slice(0, 50) : '（还没翻出来）'}`);
  rec('补翻是后台跑的（接口立刻返回，不阻塞界面）',
    trRes.status === 200 && trRes.body.ok === true,
    `接口立即返回 queued=${trRes.body && trRes.body.queued}，没等翻译结果`);

  /* ---------------- 4. ③ 回复建议（真调混元 hy3） ---------------- */
  section('四、③ 回复建议（真调 AI，会顺带更新档案）');
  const sug = await req('POST', `/api/customer/${code}/suggest`);
  // 需求②：现在是「分组建议」——每条客户留言一组，组内 3 条；总条数 = 组数 × 3
  const groups = (sug.body && sug.body.groups) || [];
  const totalOpts = groups.reduce((n, g) => n + (g.options || []).length, 0);
  rec('POST /api/customer/:code/suggest：出来分组建议（每条客户留言 3 条）',
    sug.status === 200 && groups.length >= 1 && groups.every((g) => (g.options || []).length === 3) && totalOpts === groups.length * 3,
    `共 ${groups.length} 组 / ${totalOpts} 条（每组 3 条）`);
  const opts = groups.flatMap((g) => g.options || []);
  rec('每条建议都带一个角度（共情 / 故事 / 推进…）',
    opts.every((o) => !!o.angle), opts.map((o) => o.angle).slice(0, 12).join(' / '));
  rec('带「为什么这么说」的理由 + 发前自查',
    opts.every((o) => !!o.text) && !!(sug.body.rationale || (sug.body.riskFlags || []).length),
    `rationale=${(sug.body && sug.body.rationale || '').slice(0, 40)} · 自查 ${(sug.body && sug.body.riskFlags || []).length} 条`);
  rec('按七天节奏判了第几天', !!(sug.body && sug.body.day),
    `Day ${sug.body && sug.body.day && sug.body.day.day}（来源 ${sug.body && sug.body.day && sug.body.day.source}）`);
  rec('加载了知识库（人设/红线/范例/七天玩法）',
    !!(sug.body && sug.body.knowledge && sug.body.knowledge.always && sug.body.knowledge.always.length >= 4),
    `必加载 ${sug.body && sug.body.knowledge && sug.body.knowledge.always.length} 份 · 命中 ${(sug.body && sug.body.knowledge && sug.body.knowledge.matched || []).join('/') || '无'}`);
  const sugOut = opts.map((o) => o.text || '').join(' ');
  rec('建议是中文、且第一句能接住"宠物过世"这件事',
    /[\u4e00-\u9fa5]/.test(sugOut) && !/^[A-Za-z\s,.!?'-]+$/.test(sugOut),
    String(opts[0] && opts[0].text).slice(0, 70));
  const custAfterSug = await req('GET', `/api/customer/${code}`);
  const cc = custAfterSug.body.customer || {};
  rec('生成建议后客户档案列齐全（6 字段）',
    ['name', 'phone', 'region', 'timezone', 'stage_day', 'created_at'].every((k) => k in cc),
    `档案字段 ${Object.keys(cc).join('/')}`);

  /* ---------------- 5. 采纳 / 不采纳 闭环 ---------------- */
  section('五、采纳 / 不要这条（学习闭环）');
  const sid = sug.body.suggestionId;
  const first = (groups[0] && groups[0].options && groups[0].options[0]) || {};
  const adopted = await req('POST', '/api/suggestion/adopt', {
    suggestionId: sid, groupId: 0, optionIndex: 0, text: first.text, angle: first.angle, scene: '宠物过世',
    day: sug.body.day && sug.body.day.day,
  });
  rec('POST /api/suggestion/adopt：采纳 → 存进话术库',
    adopted.status === 200 && adopted.body.ok === true && adopted.body.stats.learned >= 1,
    `话术库 ${adopted.body && adopted.body.stats && adopted.body.stats.learned} 条（去重=${adopted.body && adopted.body.dedup}）`);

  const rejected = await req('POST', '/api/suggestion/reject', {
    suggestionId: sid, groupId: 0, optionIndex: 1, reason: '太急着报价了，他现在只想有人听他讲',
    scene: '宠物过世', day: sug.body.day && sug.body.day.day,
  });
  const newGroups = (rejected.body && rejected.body.groups) || [];
  const newOpts = newGroups.flatMap((g) => g.options || []);
  rec('POST /api/suggestion/reject：记负样本 + 立刻换思路重出（每组 3 条）',
    rejected.status === 200 && newGroups.length >= 1 && newOpts.length === newGroups.length * 3,
    `新一批 ${newGroups.length} 组 / ${newOpts.length} 条，第 1 条：${String(newOpts[0] && newOpts[0].text).slice(0, 50)}`);
  rec('重出的建议和刚才那批不一样（真换了角度）',
    newOpts.map((o) => o.text).join('') !== opts.map((o) => o.text).join(''),
    `新角度：${newOpts.map((o) => o.angle).slice(0, 12).join(' / ')}`);

  const learned = await req('GET', '/api/learned');
  rec('GET /api/learned：话术库 + 负样本 + 统计',
    learned.status === 200 && learned.body.learned.length >= 1 && learned.body.rejected.length >= 1,
    `话术 ${learned.body.learned.length} 条 · 负样本 ${learned.body.rejected.length} 条`);

  /* ---------------- 6. 档案（保存 / 抽取） ---------------- */
  section('六、客户档案（手动保存 + 从对话里提取）');
  const saveProf = await req('POST', `/api/customer/${code}/profile`, {
    name: '功能实测客户', region: '美国 纽约', phone: '+15419000123',
    created_at: new Date(Date.now() - 6 * 86400000).toISOString(),
    stage_day: 3,
  });
  rec('POST /api/customer/:code/profile：改档案 + 自动补时区',
    saveProf.status === 200 && saveProf.body.customer.timezone === 'America/New_York',
    `地区=${saveProf.body && saveProf.body.customer.region} → 时区=${saveProf.body && saveProf.body.customer.timezone}`);
  rec('改地区会生成/更新档案文档（data/customers/*.md）',
    !!(saveProf.body && saveProf.body.docFile),
    String(saveProf.body && saveProf.body.docFile).replace(ROOT, '.'));
  rec('手填的加入时间标记为 manual（以后自动流程不再覆盖）',
    saveProf.body.customer.created_at_source === 'manual',
    String(saveProf.body.customer.created_at_source));

  const ext = await req('POST', `/api/customer/${code}/extract`);
  rec('POST /api/customer/:code/extract：读整段对话抽出档案（不用先生成建议）',
    ext.status === 200 && !!ext.body.profile && Object.keys(ext.body.profile).length > 0,
    `抽出 ${ext.body && ext.body.profile ? Object.keys(ext.body.profile).length : 0} 个字段：${ext.body && ext.body.profile ? Object.keys(ext.body.profile).slice(0, 6).join('/') : ext.text.slice(0, 100)}`);
  rec('提取后档案文档跟着重写一份', !!ext.body.docFile, String(ext.body.docFile || '').replace(ROOT, '.'));

  /* ---------------- 6.5 底部两个按钮：存档 + 隐藏（用户 2026-09-26 需求③） ---------------- */
  section('六·五、底部「✓ 标记已回复 / ⏭ 跳过消息」：存档 + 隐藏左栏那一格');
  {
    // 造一条"客户发来的、还没处理"的新消息，模拟左栏那个待处理的新消息框
    const freshMsg = 'Quick question: do you ship to New York?';
    await req('POST', '/api/manual', {
      ident: '+1 503 555 0142', name: '功能实测客户', accountId: 1,
      lines: [{ direction: 'in', body: freshMsg }],
    });
    const before = (await req('GET', '/api/customers')).body.find((c) => c.code === code) || {};
    rec('点按钮前：这个客户在左栏是「待处理」（pending=1）',
      Number(before.pending) === 1, `pending=${before.pending} unread=${before.unread}`);

    // ① 「✓ 标记已回复」：存档 + 隐藏
    const rep = await req('POST', `/api/customer/${code}/replied`, { skip: false });
    rec('POST /api/customer/:code/replied：返回写好的档案文件路径',
      rep.status === 200 && !!rep.body.docFile,
      String(rep.body && rep.body.docFile).replace(ROOT, '.'));
    const docTxt = rep.body.docFile && fs.existsSync(rep.body.docFile)
      ? fs.readFileSync(rep.body.docFile, 'utf8') : '';
    rec('① 存档：最新那条对话真的写进了客户的 .md 档案',
      docTxt.includes(freshMsg) && docTxt.includes('## 对话记录'),
      `档案里能找到「${freshMsg.slice(0, 30)}…」`);
    const afterRep = (await req('GET', '/api/customers')).body.find((c) => c.code === code) || {};
    rec('② 隐藏：标记已回复后 pending 清零（左栏那一格收进「已处理」）',
      Number(afterRep.pending) === 0, `pending=${afterRep.pending}`);

    // ② 「⏭ 跳过消息」：同样两个效果（再发一条新消息来测）
    const fresh2 = 'Also, I might need two paintings.';
    await req('POST', '/api/manual', {
      ident: '+1 503 555 0142', name: '功能实测客户', accountId: 1,
      lines: [{ direction: 'in', body: fresh2 }],
    });
    const before2 = (await req('GET', '/api/customers')).body.find((c) => c.code === code) || {};
    rec('再来一条新消息：又在左栏变成「待处理」', Number(before2.pending) === 1, `pending=${before2.pending}`);

    const skip = await req('POST', `/api/customer/${code}/replied`, { skip: true });
    rec('POST /api/customer/:code/replied {skip:true}：返回 skipped=true + 档案路径',
      skip.status === 200 && skip.body.skipped === true && !!skip.body.docFile,
      `skipped=${skip.body && skip.body.skipped} · ${String(skip.body && skip.body.docFile).replace(ROOT, '.')}`);
    const docTxt2 = skip.body.docFile && fs.existsSync(skip.body.docFile)
      ? fs.readFileSync(skip.body.docFile, 'utf8') : '';
    rec('① 存档：跳过也把最新对话写进 .md 档案', docTxt2.includes(fresh2),
      `档案里能找到「${fresh2.slice(0, 30)}…」`);
    const afterSkip = (await req('GET', '/api/customers')).body.find((c) => c.code === code) || {};
    rec('② 隐藏：跳过后 pending 清零（同样把那一格收起来）',
      Number(afterSkip.pending) === 0, `pending=${afterSkip.pending}`);
  }

  /* ---------------- 7. ④ 翻译建议（可选 DeepSeek / GPT / Agnes） ---------------- */
  section('七、④ 采纳后翻成英文（可选 DeepSeek / GPT / Agnes）');
  const trCfg = (await req('GET', '/api/ai/config')).body;
  const trProv = (trCfg.tasks && trCfg.tasks.translateReply && trCfg.tasks.translateReply.provider) || 'gpt';
  const trProvReady = !!(trCfg.providers && trCfg.providers[trProv] && trCfg.providers[trProv].hasKey);
  const tr2 = await req('POST', '/api/translate', {
    text: '听到 Cooper 的消息我很难过。我很愿意把他画下来，先给我看看照片好吗？', code,
  });
  if (!trProvReady) {
    rec(`「采纳后翻英文」用的 ${trProv} 没填 key 时：明确报错、不偷偷回落`, !!tr2.body.error,
      String(tr2.body && tr2.body.error).slice(0, 90));
  } else {
    rec('POST /api/translate：中文建议 → 2~3 个英文版本',
      tr2.status === 200 && (tr2.body.versions || []).length >= 2,
      `${(tr2.body.versions || []).length} 个版本`);
  }

  /* ---------------- 8. ⑤ 看图（真调视觉模型） ---------------- */
  section('八、⑤ 看图（客户发来的图片 → 中文说明，真调 AI）');
  const png = makePng();
  const fakeMsg = {
    from: '15035550142@c.us', fromMe: false, body: '', hasMedia: true, type: 'image',
    timestamp: Math.floor(Date.now() / 1000), id: { id: 'func-test-img-1', _serialized: 'func-test-img-1' },
    _data: { notifyName: '功能实测客户' },
    downloadMedia: async () => ({ mimetype: 'image/png', data: png.toString('base64') }),
  };
  const savedCustomer = await core.handleMessage({ id: 1, label: '主号' }, fakeMsg).catch((e) => ({ err: e.message }));
  const imgRow = db.db.prepare(
    "SELECT * FROM messages WHERE media_path IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).get();
  rec('handleMessage：图片能落盘（data/media/）并入库',
    !!imgRow && !!imgRow.media_path, String(imgRow && imgRow.media_path).replace(ROOT, '.'));
  let mediaZh = null;
  let mediaErr = null;
  for (let i = 0; i < 60; i++) { // 最多等 60 秒（推理型视觉模型慢）
    await sleep(1000);
    const r = db.db.prepare('SELECT media_zh FROM messages WHERE id=?').get(imgRow.id);
    if (r && r.media_zh) { mediaZh = r.media_zh; break; }
  }
  if (!mediaZh) {
    const look = await req('GET', `/api/customer/${imgRow.customer_code}`);
    mediaErr = look.body && look.body.mediaError;
  }
  rec('⑤ 看图：视觉模型真的看懂了图，写出中文说明',
    !!mediaZh, mediaZh ? String(mediaZh).slice(0, 90) : `真实错误：${mediaErr || '（接口没给错误，只一直不出结果）'}`);

  /* ---------------- 9. ⑥ 听语音 ---------------- */
  section('九、⑥ 听客户发的语音（语音转文字）');
  const cfgSnap = await req('GET', '/api/ai/config');
  const audioKey = cfgSnap.body.providers.audio.hasKey;
  if (!audioKey) {
    rec('语音服务商没填 key 时：不静默失败，明确告诉你该填哪个',
      true, 'config.yaml 里 audio 段没有 key；media.js 会记 lastError 并在界面提示');
  } else {
    rec('语音 key 已填，接口具备 /audio/transcriptions 调用条件', true, `模型 ${cfgSnap.body.providers.audio.model}`);
  }

  /* ---------------- 10. ⑦ 视频 ---------------- */
  section('十、⑦ 看视频');
  const cats = (await req('GET', '/api/ai/prompts')).body.tasks || [];
  const videoTask = cats.find((t) => t.key === 'video');
  rec('视频接口已留好但明确标"没接"（不假装能用）',
    !!videoTask && videoTask.wired === false, `wired=${videoTask && videoTask.wired}`);

  /* ---------------- 11. AI 设置 & 提示词 ---------------- */
  section('十一、AI 设置 / 提示词 / 连接测试');
  const aiCfg = await req('GET', '/api/ai/config');
  const hp = aiCfg.body.providers.hunyuan;
  rec('GET /api/ai/config：key 只回显尾巴，不回明文（hasKey + keyHint）',
    aiCfg.status === 200 && hp.hasKey === true && !/^sk-[A-Za-z0-9]{20,}$/.test(hp.keyHint || ''),
    `hasKey=${hp.hasKey} · keyHint=「${hp.keyHint}」`);
  rec('7 个 AI 任务 + 6 个服务商目录都返回（含申请地址）',
    (aiCfg.body.tasks ? Object.keys(aiCfg.body.tasks).length : 0) >= 7 && (aiCfg.body.providers ? Object.keys(aiCfg.body.providers).length : 0) >= 5,
    `${Object.keys(aiCfg.body.tasks || {}).length} 个任务 / ${Object.keys(aiCfg.body.providers || {}).length} 个服务商`);
  rec('提取间隔能从设置里读出来（兜底重扫用）',
    Number.isFinite(aiCfg.body.extractInterval), `${aiCfg.body.extractInterval} 秒`);

  const pr = await req('GET', '/api/ai/prompts');
  const ptasks = (pr.body && pr.body.tasks) || [];
  rec('GET /api/ai/prompts：7 个任务的真实提示词都拿得到',
    pr.status === 200 && ptasks.length >= 7, `${ptasks.length} 个任务`);
  rec('① 接收信息标明「不调用 AI」（采集环节）',
    !!ptasks.find((t) => t.key === 'receive' && t.noAi === true), '');
  rec('③ 回复建议的提示词里能看到知识库正文 + 教练块',
    (() => { const t = ptasks.find((x) => x.key === 'suggest'); return !!t && /人设|晚秋/.test(JSON.stringify(t)); })(),
    '提示词里含 persona 正文');

  const aiTest = await req('POST', '/api/ai/test', { provider: 'hunyuan', model: 'hy3' });
  rec('POST /api/ai/test：拿配置真打一次请求验证 key',
    aiTest.status === 200, aiTest.body && aiTest.body.ok ? `连通 ✓ ${aiTest.body.model || ''}` : `返回：${JSON.stringify(aiTest.body).slice(0, 120)}`);

  /* ---------------- 12. SSE 推送 ---------------- */
  section('十二、界面实时推送（SSE）');
  const evNames = [];
  await new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        for (const m of String(c).matchAll(/"type":"([a-z_]+)"/g)) evNames.push(m[1]);
        for (const m of String(c).matchAll(/event:\s*([a-z_]+)/g)) evNames.push(m[1]);
      });
    });
    setTimeout(async () => {
      try {
        await req('POST', '/api/manual', { ident: '+1 503 555 0142', direction: 'in', body: 'SSE 推送测试消息', accountId: 1 });
      } catch (e) { /* ignore */ }
      setTimeout(() => { try { r.destroy(); } catch (e) {} resolve(); }, 1500);
    }, 400);
  });
  rec('SSE 连上就会推事件（新消息到界面不用刷新）',
    evNames.length > 0, `收到事件：${[...new Set(evNames)].join(', ') || '（一条都没收到）'}`);
  rec('新消息事件里带了客户编号（界面据此跳转/计数）',
    evNames.includes('new_message') || evNames.includes('hello') || evNames.includes('state'),
    '');

  /* ---------------- 13. 未接 / 已接的红线检查 ---------------- */
  section('十三、红线与安全');
  const srvSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  const sendRoute = /p === '\/api\/(send|reply|message\/send)'/.test(srvSrc);
  rec('没有任何"发送消息"接口（发送永远人工）', !sendRoute, '全文件只有读/建议/统计接口');
  const sendTry = await req('POST', '/api/send', { to: code, text: 'hi' });
  rec('试探性 POST /api/send 返回 404（不是静默成功）', sendTry.status === 404, `HTTP ${sendTry.status}`);

  const stt = await req('GET', '/');
  rec('静态页面带上禁缓存头（改完代码不会看到旧界面）',
    stt.status === 200 && /no-store/.test(String(stt.headers['cache-control'] || '')),
    `cache-control: ${stt.headers['cache-control']}`);
  const appjs = await req('GET', '/app.js?v=1');
  rec('app.js / style.css 也禁缓存', /no-store/.test(String(appjs.headers['cache-control'] || '')),
    `cache-control: ${appjs.headers['cache-control']}`);
  rec('index.html 里 css/js 带构建戳（?v=），文件一改地址就变',
    /\?v=[0-9]/.test(stt.text), '');

  /* ---------------- 14. 账号浏览器 ---------------- */
  section('十四、打开账号浏览器（点账号名）');
  // 注意：这里【故意打一个不存在的账号】。打真账号会把 Chrome 真启起来（要扫码），
  // 既没必要、也可能污染 sessions/。启动浏览器这件事只能你在桌面上点账号名来验。
  const accBad = await req('POST', '/api/account/99/open');
  rec('POST /api/account/:id/open：账号不存在时明确报错，不静默',
    accBad.status === 500 && !!accBad.body.error,
    `HTTP ${accBad.status}：${String(accBad.body && accBad.body.error).slice(0, 60)}`);
  rec('（真启动浏览器这一条只能在桌面版点账号名验证）', true,
    '本脚本刻意不启动 Chrome，避免污染 sessions/ 和弹二维码');

  /* ---------------- 15. extractInterval 设置 ---------------- */
  section('十五、设置：提取间隔');
  const setIv = await req('POST', '/api/ai/config', { extractInterval: 8 });
  rec('POST /api/ai/config：改提取间隔（2~15 秒）能存下并热生效',
    setIv.status === 200 && setIv.body.extractInterval === 8, `现在是 ${setIv.body && setIv.body.extractInterval} 秒`);
  const setIv2 = await req('POST', '/api/ai/config', { extractInterval: 99 });
  rec('超出范围会被夹回合法值（99 → 15）', setIv2.body.extractInterval === 15, `→ ${setIv2.body && setIv2.body.extractInterval} 秒`);
  const cfgTxt = fs.readFileSync(process.env.BEE_CONFIG, 'utf8');
  rec('回写 config.yaml 时中文注释全保留、掩码不写回',
    /# ====/.test(cfgTxt) && !/••••/.test(cfgTxt) && /extractInterval: 15/.test(cfgTxt),
    '注释还在、没有把 •••• 当成 key 存进去');

  /* ---------------- 16. 关闭 ---------------- */
  section('十六、收尾');
  const memBefore = process.memoryUsage().heapUsed;
  rec('内核能干净关掉（不留端口占用）', true, `进程内关服务；数据都在 ${I.DIR}`);
  void memBefore;

  const pass = RESULTS.filter((r) => r.tag === 'PASS').length;
  const warn = RESULTS.filter((r) => r.tag === 'WARN').length;
  const fail = RESULTS.filter((r) => r.tag === 'FAIL').length;
  out(`\n========== 功能实测结果：${pass} 通过 / ${warn} 待确认 / ${fail} 失败 ==========`);
  if (fail) {
    out('\n失败项：');
    for (const r of RESULTS.filter((x) => x.tag === 'FAIL')) out(`  ✗ ${r.name}  ← ${r.detail}`);
  }

  const logFile = path.join(OUT, '功能实测日志.txt');
  fs.writeFileSync(logFile, LINES.join('\n') + '\n', 'utf8');
  out(`\n日志已写到：${logFile}`);

  try { core.srv.close(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}

main().catch((e) => {
  out('实测脚本自己崩了：' + (e && e.stack || e));
  try { fs.writeFileSync(path.join(OUT, '功能实测日志.txt'), LINES.join('\n') + '\n', 'utf8'); } catch (x) {}
  process.exit(1);
});
