/**
 * LID 取号逐层诊断（只读，不改任何业务代码）
 *
 * 背景：老板反馈「软件一直拿不到客户真实电话号码」。
 * 根因是 WhatsApp 2024 起把陌生人的会话 ID 从 @c.us 换成了 @lid（隐私号），
 * 那串数字不是手机号。现在要弄清：**wwjs 1.34.7 到底能不能把 @lid 换回真号码，
 * 哪一层能用、哪一层已经失效。**
 *
 * 本工具复用软件自己的登录态（LocalAuth，clientId=acc-<id>），
 * 拿到真实 browserWSEndpoint 后，对每个待测 LID 逐层实测并打印结果。
 *
 * 用法：
 *   node tools/lid_probe.js                # 用配置里第一个账号
 *   node tools/lid_probe.js --account 2# 15301234567@lid
 *   node tools/lid_probe.js --auto 20#     # 自动从最近会话里挑 20 个 @lid 测
 *
 * ⚠️ 会真实打开一个浏览器窗口并连上 WhatsApp（只读取消息，不发送任何内容）。
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { Client, LocalAuth } = require('whatsapp-web.js');

let puppeteer;
try {
  const extra = require('puppeteer-extra');
  extra.use(require('puppeteer-extra-plugin-stealth')());
  puppeteer = extra;
} catch (e) {
  puppeteer = require('puppeteer');
}

const ROOT = path.resolve(__dirname, '..');

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const ACCOUNTS = (() => {
  const raw = argOf('--accounts', '1');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
})();
const EXPLICIT = argv.filter((a) => a.includes('@lid') || a.includes('@c.us'));
const AUTO_N = Number(argOf('--auto', '0')) || 0;

/* 读库里真实的 @lid 客户（不写任何东西） */
function loadLidCustomers() {
  const dbPath = path.join(ROOT, 'data', 'assistant.db');
  if (!fs.existsSync(dbPath)) return [];
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(
    "SELECT code, name, wa_jid, phone FROM customers WHERE wa_jid LIKE '%@lid' ORDER BY code",
  ).all();
  db.close();
  return rows;
}

function dataBase() {
  const env = process.env.BEE_HOME;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return ROOT; // 开发态：homeDir() 为空时 dataBase() 回落到项目根
}

/* ---------- 读账号配置（跟 session.js 同口径） ---------- */
function loadAccounts() {
  const dbPath = path.join(dataBase(), 'data', 'assistant.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`[probe] 找不到账号库：${dbPath}`);
    console.error('        如果软件装在别处，请设 BEE_HOME 指向它的数据目录后再跑。');
    process.exit(1);
  }
  // 项目已改用 node:sqlite，这里只做只读查询
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT id, label, phone, proxy FROM accounts ORDER BY id').all();
  db.close();
  return rows;
}

function loadCfg() {
  const y = fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8');
  const sessionDir = (y.match(/sessionDir:\s*(\S+)/) || [, './sessions'])[1];
  const headless = /headless:\s*true/.test(y);
  return { sessionDir, headless };
}

/* ---------- 逐层探测（在浏览器页面内执行） ---------- */
const PROBE_SRC = async (targets) => {
  const out = { layers: {}, env: {}, samples: [] };

  // —— 0. 环境自检：确认哪些内部模块还在 ——
  try {
    const probe = (m) => {
      try { return typeof window.require(m); } catch (e) { return 'THROW:' + (e && e.message); }
    };
    out.env = {
      hasWWebJS: typeof window.WWebJS !== 'undefined',
      hasEnforce: !!(window.WWebJS && window.WWebJS.enforceLidAndPnRetrieval),
      hasClientApi: typeof window.WWebJS?.getContactLidAndPhone === 'function',
      mod_WidFactory: probe('WAWebWidFactory'),
      mod_ApiContact: probe('WAWebApiContact'),
      mod_QueryExistsJob: probe('WAWebQueryExistsJob'),
      mod_Collections: probe('WAWebCollections'),
      mod_ContactGetters: probe('WAWebContactGetters'),
      mod_LidMigration: probe('WAWebLidMigrationUtils'),
    };
    // 🔴 最关键：WhatsApp 官方自己的 LID→手机号转换器。
    // 上面 enforceLidAndPnRetrieval 走的是 ApiContact.getPhoneNumber，
    // 而这个 toPn 是迁移期的官方通道，两个都要看。
    try {
      const M = window.require('WAWebLidMigrationUtils');
      out.env.lidMigrationFns = Object.keys(M).filter((k) => typeof M[k] === 'function');
    } catch (e) {
      out.env.lidMigrationFns = 'ERR:' + (e && e.message);
    }
    // ApiContact 上到底有哪几个方法（决定 getPhoneNumber 能不能用）
    try {
      const AC = window.require('WAWebApiContact');
      out.env.apiContactMethods = Object.keys(AC).filter((k) => /phone|lid|wid|alternate/i.test(k));
    } catch (e) {
      out.env.apiContactMethods = 'ERR:' + (e && e.message);
    }
    // Store 里有没有 Contact / PhoneNumberCollection（LID 映射常存在这）
    try {
      const S = window.Store || {};
      out.env.storeKeys = ['Contact', 'Chat', 'PhoneNumberCollection', 'LidUtils', 'GroupMetadata']
        .map((k) => k + '=' + (S[k] ? 'YES' : 'no'));
    } catch (e) {
      out.env.storeKeys = 'ERR:' + (e && e.message);
    }
    // WhatsApp 版本（模块名随版本变，版本号要记进报告）
    out.env.waVersion = (() => {
      try {
        const m = window.require('WAWebVersion');
        return (m && (m.VERSION || m.version)) || 'unknown';
      } catch (e) { return 'unknown'; }
    })();
  } catch (e) {
    out.env.fatal = String(e && e.message);
  }

  // —— 1~5 层：逐层实测 ——
  for (const t of targets) {
    const rec = { target: t };

    // 层1：wwjs 官方接口（内部 = enforceLidAndPnRetrieval）
    try {
      if (window.WWebJS?.getContactLidAndPhone) {
        const arr = await window.WWebJS.getContactLidAndPhone([t]);
        rec.L1_api = JSON.parse(JSON.stringify(arr?.[0] || null));
      } else rec.L1_api = 'NO_METHOD';
    } catch (e) { rec.L1_api = 'ERR:' + (e && e.message); }

    // 层2：直接注入层
    try {
      if (window.WWebJS?.enforceLidAndPnRetrieval) {
        const r = await window.WWebJS.enforceLidAndPnRetrieval(t);
        rec.L2_inject = {
          lid: r?.lid?._serialized || r?.lid?.user || String(r?.lid || '') || null,
          phone: r?.phone?._serialized || r?.phone?.user || String(r?.phone || '') || null,
        };
      } else rec.L2_inject = 'NO_METHOD';
    } catch (e) { rec.L2_inject = 'ERR:' + (e && e.message); }

    // 层3：底层模块直调（绕过 wwjs 封装，看是模块没了还是封装坏了）
    try {
      const W = window.require('WAWebWidFactory');
      const wid = W.createWid(t);
      const AC = window.require('WAWebApiContact');
      rec.L3_raw = {
        server: wid.server,
        isLid: typeof wid.isLid === 'function' ? wid.isLid() : null,
        getPhoneNumber: AC.getPhoneNumber ? String(AC.getPhoneNumber(wid)?._serialized ?? '') : 'NO_FN',
        getCurrentLid: AC.getCurrentLid ? String(AC.getCurrentLid(wid)?._serialized ?? '') : 'NO_FN',
        getAlternateUserWid: AC.getAlternateUserWid ? String(AC.getAlternateUserWid(wid)?._serialized ?? '') : 'NO_FN',
      };
    } catch (e) { rec.L3_raw = 'ERR:' + (e && e.message); }

    // 层3b：显式触发一次网络查询（WhatsApp 允许你用 LID 问「这号存在吗」，
    //      回应里会带回 pn，这才是真正能解 LID 的路径）
    try {
      const W = window.require('WAWebWidFactory');
      const QE = window.require('WAWebQueryExistsJob');
      const wid = W.createWid(t);
      const q = await QE.queryWidExists(wid);
      rec.L3b_query = q ? JSON.parse(JSON.stringify({ wid: q.wid?._serialized, pn: q.phoneNumber?._serialized })) : 'NULL';
    } catch (e) { rec.L3b_query = 'ERR:' + (e && e.message); }

    // 🔴 层3c：WhatsApp 官方 LID 迁移工具 toPn —— 优先级最高的一条路。
    // wwjs 自己在渲染群成员时就是用它把 participant 的 @lid 换成 @c.us 的。
    try {
      const M = window.require('WAWebLidMigrationUtils');
      const ser = (v) => (v && (v._serialized || v.user)) ? (v._serialized || v.user) : (v ? String(v) : null);
      const r = {
        toPn: M.toPn ? ser(M.toPn(t)) : 'NO_FN',
        toLid: M.toLid ? ser(M.toLid(t)) : 'NO_FN',
      };
      // 有的版本toPn 吃的是 wid 对象而不是字符串，两种都试
      if (M.toPn && r.toPn === 'NO_FN') {
        try { r.toPn_widArg = ser(M.toPn(window.require('WAWebWidFactory').createWid(t))); }
        catch (e) { r.toPn_widArg = 'ERR:' + (e && e.message); }
      }
      rec.L3c_migration = r;
    } catch (e) { rec.L3c_migration = 'ERR:' + (e && e.message); }

    // 层4：Contact 模型自带的 phoneNumber 字段
    try {
      const S = window.Store;
      let contact = null;
      const C = S?.Contact;
      if (C) {
        const wid = window.require('WAWebWidFactory').createWid(t);
        try { contact = C.get(wid); } catch (e) { contact = null; }
        if (!contact) {
          // 用 alternate 再找一次（lid↔pn 是双向映射）
          try {
            const AC = window.require('WAWebApiContact');
            const alt = AC.getAlternateUserWid(wid);
            if (alt) contact = C.get(alt);
          } catch (e) { /* ignore */ }
        }
      }
      rec.L4_contact = contact
        ? {
            id: contact.id?._serialized,
            // 🔴 number 字段：Contact.js:35 官方注释就是 "Contact's phone number"，
            //    注入层 Utils.js:1042 由 getUserid() 填。和 id 是两条独立的路——
            //    现有代码只读 id，若 id 是 @lid 而 number 有值，就是零改动直接能用。
            number: contact.number ?? null,
            phoneNumber: contact.phoneNumber?._serialized ?? String(contact.phoneNumber ?? '') ?? null,
            pushname: contact.pushname || null,
            name: contact.name || null,
            shortName: contact.shortName || null,
            verifiedName: contact.verifiedName || null,
            verifiedLevel: contact.verifiedLevel ?? null,
            isMyContact: !!contact.isMyContact,
            isUser: !!contact.isUser,
            isBusiness: !!contact.isBusiness,
            isWAContact: !!contact.isWAContact,
            labels: contact.labels || null,
          }
        : (C ? 'NO_CONTACT' : 'NO_STORE');
    } catch (e) { rec.L4_contact = 'ERR:' + (e && e.message); }

    // 层5：网页 DOM（老板在页面上能直接看到号码的那几个位置）
    try {
      const pick = (sel) => Array.from(document.querySelectorAll(sel))
        .map((n) => (n.innerText || n.textContent || '').trim()).filter(Boolean);
      const grab = (d) => {
        const t = (d.innerText || d.textContent || '');
        const m = t.match(/\+?\d[\d\s().-]{6,}\d/);
        return m ? m[0].replace(/\D/g, '') : '';
      };
      let headerPhone = '';
      for (const sel of ['[data-testid="conversation-info-header-chat-title"]',
        '[data-testid="contact-info-subtitle"]', 'header span[title]', '[dir="auto"].xnpuxes']) {
        const el = document.querySelector(sel);
        if (el) { headerPhone = grab(el); if (headerPhone) break; }
      }
      rec.L5_dom = { headerPhone: headerPhone || null, titleTexts: pick('header [title]').slice(0, 4) };
      // 顺手探测两项表里列出、但本项目还没用的能力（只读，不改任何状态）
      try {
        const img = document.querySelector('header img[src^="blob:"], header img[src^="data:"]');
        rec.L5b_extra = {
          hasAvatar: !!img,
          statusText: (document.querySelector('[data-status="info-panel-profile-chat-details__status"]')?.innerText || '').trim() || null,
        };
      } catch (e) { rec.L5b_extra = 'ERR:' + (e && e.message); }
    } catch (e) { rec.L5_dom = 'ERR:' + (e && e.message); }

    out.samples.push(rec);
  }
  return out;
};

/* ---------- 主流程 ---------- */
(async () => {
  const cfg = loadCfg();
  const all = loadAccounts();
  const picked = all.filter((a) => ACCOUNTS.includes(String(a.id)));
  if (!picked.length) {
    console.error('[probe] 指定的账号不存在。可用：', all.map((a) => a.id + '=' + a.label).join(', '));
    process.exit(1);
  }

  for (const acc of picked) {
    console.log(`\n========== 账号 ${acc.id}（${acc.label}） ==========`);
    const sessionDir = path.resolve(dataBase(), cfg.sessionDir);
    const userDataDir = path.join(sessionDir, 'chrome-acc-' + acc.id);
    const browser = await puppeteer.launch({
      headless: cfg.headless ? true : false,
      userDataDir,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: `acc-${acc.id}`, dataPath: sessionDir }),
      puppeteer: { browserWSEndpoint: browser.wsEndpoint() },
    });

    const ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('等待登录超时（120s）')), 120000);
      client.on('qr', () => console.log('[probe] 需要扫码，请在弹出的浏览器里扫…'));
      client.on('ready', () => { clearTimeout(t); resolve(); });
      client.on('auth_failure', (m) => { clearTimeout(t); reject(new Error('认证失败：' + m)); });
    });
    await client.initialize();
    try { await ready; } catch (e) {
      console.error('[probe]', e.message);
      await browser.close().catch(() => {});
      continue;
    }
    console.log('[probe] 已就绪，开始探测…');

    // 决定测哪些目标
    let targets = EXPLICIT.slice();
    let fromDb = null;

    if (!targets.length && AUTO_N === 'db') {
      // 直接测库里那 4 条真实客户（最能说明问题）
      fromDb = loadLidCustomers();
      targets = fromDb.map((r) => r.wa_jid);
      console.log(`[probe] 库里的 @lid 客户 ${fromDb.length} 条：`);
      fromDb.forEach((r) => console.log(`   ${r.code}  ${r.wa_jid}  phone=${r.phone || '(空)'}`));
      console.log('[probe] 开始逐条探测…\n');
    } else if (!targets.length && AUTO_N > 0) {
      const chats = await client.getChats();
      const lids = chats
        .map((c) => c.id && c.id._serialized)
        .filter((id) => id && /@lid$/i.test(id));
      targets = lids.slice(0, AUTO_N);
      console.log(`[probe] 会话里共 ${chats.length} 个，其中 @lid ${lids.length} 个，测前 ${targets.length} 个`);
    }
    if (!targets.length) {
      console.log('[probe] 没有目标。用 --auto db 测库里真实客户，或 --auto 20 自动挑，或直接给 --accounts 1# 123@lid');
      await browser.close().catch(() => {});
      continue;
    }

    const result = await client.pupPage.evaluate(PROBE_SRC, targets);
    console.log('\n---------- 环境自检 ----------');
    console.log(JSON.stringify(result.env, null, 1));
    console.log('\n---------- 逐层结果 ----------');
    for (const s of result.samples) {
      console.log('\n### ' + s.target);
      console.log('  L1 官方接口   :', JSON.stringify(s.L1_api));
      console.log('  L2 注入层     :', JSON.stringify(s.L2_inject));
      console.log('  L3 底层模块   :', JSON.stringify(s.L3_raw));
      console.log('  L3b 网络查询  :', JSON.stringify(s.L3b_query));
      console.log('  L3c 官方迁移  :', JSON.stringify(s.L3c_migration));
      console.log('  L4 Contact    :', JSON.stringify(s.L4_contact));
      console.log('  L5 DOM        :', JSON.stringify(s.L5_dom));
      console.log('  L5b头像/状态:', JSON.stringify(s.L5b_extra));
    }

    const report = {
      at: new Date().toISOString(),
      account: { id: acc.id, label: acc.label },
      targets,
      result,
    };
    const outPath = path.join(__dirname, 'lid_probe_report.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log('\n[probe] 报告已存：' + outPath);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((res) => rl.question('按回车关闭浏览器…', res));
    rl.close();
    await browser.close().catch(() => {});
  }
  process.exit(0);
})().catch((e) => { console.error('[probe] 致命错误:', e); process.exit(1); });