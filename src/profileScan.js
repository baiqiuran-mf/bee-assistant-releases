/**
 * 「📞 抓取」= 抓**聊天对象的资料**里的电话号码（2026-10-07 老板纠正后重做）
 *
 * 🔴 之前做错在哪：
 *    第一版把「抓取」理解成"扫描历史聊天正文里出现过的数字"—— 那是**对话内容**，
 *    不是老板要的东西。老板要的是**客户资料卡里那个号码**
 *    （WhatsApp 联系人信息 / Contact 模型 / 联系人信息面板上明晃晃显示的那个号）。
 *    这两件事数据源完全不同：对话内容在 messages 表里，资料在**活着的浏览器页面**里。
 *
 * 资料里到底有哪些号码相关的字段（这一版要把它们**全列出来**，不是只挑一个）：
 *   · contact.id            —— @c.us/@s.whatsapp.net 时就是真号；@lid 是隐私号（不是号码）
 *   · contact.number        —— userid，**LID 会话下这串常常就是那串假号**，不能直接信
 *   · contact.msisdn        —— WhatsApp 内部的国家码字段，号码型联系人才有值
 *   · contact.phoneNumber   —— 注入层在能查到映射时才填真号
 *   · contact.lid           —— 隐私 ID，本身永远不是电话号码
 *   · LID→真号码 的官方映射 —— getPhoneNumber / enforceLidAndPnRetrieval，最正规的一条
 *   · 网页 DOM              —— 会话头部标题 / 联系人信息副标题 / 联系人信息面板（用户肉眼能看到的）
 *
 * 硬边界：
 *   1) **只读**。不写档案、不发消息、不点"保存联系人"。看和改必须分开。
 *   2) 只在浏览器里做**读取 + 打开会话**（为了渲染出资料），不改任何联系人状态。
 *   3) 一个字段都不许静默丢弃 —— 哪怕它是 LID、是 15 位、看着就不像号码，也要列出来
 *      并写清"为什么不像"，这样老板能确认"确实扫过了，没有真号"。
 */

/** 把 puppeteer page.evaluate 收集到的原始字段，整理成界面能直接显示的清单（纯函数，好测） */
const SRC_LABEL = {
  contact_id: '联系人 ID（Contact.id）',
  contact_number: '联系人号码（Contact.number）',
  contact_msisdn: '国家码字段（Contact.msisdn）',
  contact_phoneNumber: '联系人电话字段（Contact.phoneNumber）',
  contact_lid: '隐私 ID（Contact.lid）',
  chat_id: '会话 ID（Chat.id）',
  chat_number: '会话号码（Chat.contact.number）',
  lid_lookup: 'WhatsApp 官方 LID→号码 映射',
  lid_enforce: 'WhatsApp 注入层 LID→号码 映射',
  dom_header: '网页 · 会话头部标题',
  dom_subtitle: '网页 · 联系人信息副标题',
  dom_panel: '网页 · 联系人信息面板',
  dom_header_block: '网页 · 会话头部整块文字',
};

const KIND_LABEL = {
  phone: '电话号码',
  lid: 'LID 隐私号（不是号码）',
  jid: '会话 ID',
  text: '网页上显示的文字',
};

/** 判断一段数字「像不像」真号码 —— 跟 phoneScan 同一套口径（宁可多列，不要静默丢） */
function judge(digits, hasPlus, intlOk) {
  const len = digits.length;
  if (!len) return { ok: false, reason: '没有数字' };
  if (len <= 4) return { ok: false, reason: `只有 ${len} 位，太短（年份 / 门牌 / 房间号那种）` };
  if (len === 5) return { ok: false, reason: '5 位 —— 多半是美国邮编' };
  if (len === 8 && /^(?:19|20)\d{6}$/.test(digits)) {
    return { ok: false, reason: '8 位且 19xx/20xx 开头 —— 这是日期（YYYYMMDD），不是号码' };
  }
  if (len >= 6 && len <= 8) {
    return { ok: false, reason: `${len} 位 —— 更像邮编 / 工号，真手机号通常 ≥9 位` };
  }
  if (len >= 14) {
    return { ok: false, reason: `${len} 位 —— 超过国际号码上限 13 位，这是 LID 隐私号，不是电话号码` };
  }
  if (hasPlus && intlOk) return { ok: true, reason: `原文带 ${hasPlus} 且区号合法 —— 最可信的一条` };
  if (hasPlus && !intlOk) return { ok: false, reason: '原文带 + 或 00，但区号不在国际表里 —— 可疑，别直接用' };
  if (len >= 9 && len <= 13) {
    return { ok: true, reason: `${len} 位，纯数字无 + —— 可能是没写国际区号的本地写法，需人工核对` };
  }
  return { ok: false, reason: `${len} 位 —— 不在常见号码长度区间` };
}

/** 只取数字（保留 + 号的判定另算） */
function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

/**
 * 把页面里收集到的原始字段，整理成清单。
 *
 * @param {Array} rawFields 页面 evaluate 收集的 {key, value, kind}
 * @param {object} customer 客户档案（拿现有号码做对比）
 * @returns {{fields:Array, okCount:number, total:number, current:object}}
 */
function summarize(rawFields, customer) {
  const identity = require('./identity');
  const cur = digitsOnly(customer && customer.phone);
  const seen = new Set();
  const out = [];

  for (const f of Array.isArray(rawFields) ? rawFields : []) {
    const value = String((f && f.value) != null ? f.value : '').trim();
    if (!value) continue;

    const key = String(f.key || '');
    const kind = String(f.kind || 'text');
    const digits = digitsOnly(value);
    const hasPlus = /^\s*\+/.test(value) || /\b00\d/.test(value) ? '+' : '';

    // LID / 会话 ID 这类：本身就是"不是号码"的东西，原样列出但标清楚
    if (kind === 'lid' || kind === 'jid') {
      // 🔴 去重必须带上字段名：Contact.id 和 Chat.id 值可能一模一样（都是 xxx@lid），
      //    但它们是**两个不同的资料字段**，都要列出来给老板看，不许塌成一条。
      const dedup = key + ':' + kind + ':' + value;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      out.push({
        key,
        src: SRC_LABEL[key] || key,
        kind,
        kindLabel: KIND_LABEL[kind] || kind,
        raw: value,
        digits,
        len: digits.length,
        hasPlus: '',
        country: '',
        ok: false,
        isCurrent: false,
        reason: kind === 'lid'
          ? '这是 WhatsApp 的 LID 隐私 ID —— 是一串内部编号，不是电话号码，不能填进档案'
          : '这是会话 ID，不是电话号码',
      });
      continue;
    }

    // 没有数字的纯文字（客户资料里的昵称/公司名之类）也列出来，但要标"不是号码"
    if (!digits) {
      const dedup = 'text:' + value;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      out.push({
        key,
        src: SRC_LABEL[key] || key,
        kind,
        kindLabel: KIND_LABEL[kind] || '文字',
        raw: value,
        digits: '',
        len: 0,
        hasPlus: '',
        country: '',
        ok: false,
        isCurrent: false,
        reason: '这一项里没有数字 —— 是昵称 / 公司名之类的文字',
      });
      continue;
    }

    const dedup = key + ':' + digits;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    // 带 + / 00 才做国际区号校验（裸号区号校验没意义，容易误杀）
    let intlOk = false;
    let country = '';
    if (hasPlus) {
      const intl = identity.parseIntlPhone(digits, 4);
      intlOk = !!(intl && intl.phone);
      if (intlOk) country = identity.countryOfPhone(intl.phone) || '';
    } else {
      country = identity.countryOfPhone(digits) || '';
    }

    const { ok, reason } = judge(digits, hasPlus, intlOk);
    out.push({
      key,
      src: SRC_LABEL[key] || key,
      kind,
      kindLabel: KIND_LABEL[kind] || '号码候选',
      raw: value,
      digits,
      len: digits.length,
      hasPlus,
      country,
      ok,
      isCurrent: !!cur && cur === digits,
      reason,
    });
  }

  // 排序：先「像真号」，再按位数多，再按来源可信度（官方映射 > Contact 字段 > 网页）
  const trust = {
    lid_lookup: 6, lid_enforce: 6, contact_phoneNumber: 5, contact_msisdn: 5,
    contact_id: 4, contact_number: 4, chat_id: 4, chat_number: 4,
    dom_subtitle: 3, dom_header: 3, dom_panel: 3, dom_header_block: 2,
  };
  out.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    const ta = trust[a.key] || 0;
    const tb = trust[b.key] || 0;
    if (ta !== tb) return tb - ta;
    if (b.len !== a.len) return b.len - a.len;
    return 0;
  });

  return {
    fields: out,
    okCount: out.filter((f) => f.ok).length,
    total: out.length,
    current: { phone: cur, src: (customer && customer.phone_src) || '' },
  };
}

/**
 * 在活着的 WhatsApp 网页里，把这位客户**资料里所有号码相关的字段**全捞一遍。
 *
 * ⚠️ 只读 + 只开会话：不点保存、不改资料、不发消息。
 *    开会话（chat.open()）是必要的 —— 号码渲染在头部，不开就读不到；
 *    这只会把聊天窗口切过去，不会改变任何联系人数据。
 *
 * @param {object} page puppeteer Page
 * @param {string} jid  客户 wa_jid
 * @param {object} [opt] { timeoutMs }
 * @returns {Promise<{ok:boolean, reason?:string, jid:string, fields:Array, meta:object}>}
 */
/** 统一「在页面里跑一段脚本」的入口：puppeteer 用 page.evaluate；Electron webContents 用 executeJavaScript */
function makeRunner(page) {
  if (page && typeof page.evaluate === 'function') {
    return (fn, arg) => page.evaluate(fn, arg);
  }
  if (page && typeof page.executeJavaScript === 'function') {
    // Electron webContents：把函数 toString 后包成 IIFE，参数用 JSON 嵌入；executeJavaScript 会 await 返回的 promise
    return (fn, arg) => page.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`, false);
  }
  return null;
}

async function probeProfile(page, jid, opt = {}) {
  const empty = { ok: false, reason: 'no-page', jid: String(jid || ''), fields: [], meta: {} };
  const run = makeRunner(page);
  if (!run) return empty;

  const timeoutMs = Number(opt.timeoutMs) > 0 ? Number(opt.timeoutMs) : 20000;

  let raw;
  try {
    raw = await Promise.race([
      run(async (widArg) => {
        const out = { jid: String(widArg || ''), fields: [], meta: {}, errors: [] };
        const S = (v) => {
          if (v == null) return '';
          if (typeof v === 'string') return v;
          if (typeof v === 'object') {
            if (v._serialized) return String(v._serialized);
            if (v.user) return String(v.user);
            try { return String(v); } catch (e) { return ''; }
          }
          return String(v);
        };
        const D = (v) => S(v).replace(/\D/g, '');
        // 字段收集器：没有数字的一律不收（昵称/公司名不是"号码相关字段"）
        const F = (key, value, kind, force) => {
          const v = S(value).trim();
          if (!v) return;
          if (!force && !/\d/.test(v)) return;
          out.fields.push({ key, value: v, kind: kind || 'phone' });
        };

        const Store = window.Store || (window.WWebJS && window.WWebJS.Store) || null;
        out.meta.hasStore = !!Store;

        /* ---------- ① 找 Contact 模型 ---------- */
        // 🔴 2026-10-19：剥掉「wa1:」这类页签前缀，拿到真实 JID（内置浏览器落库的 wa_jid 带前缀）。
        // 不剥的话，下面无论 Store 还是模块系统都按「wa1:...」去查，查无此人 → 抓不到号。
        const wid = String(widArg || '').replace(/^wa\d+:/i, '');
        const variants = [wid];
        if (/@lid$/i.test(wid)) variants.push(wid.replace(/@lid$/i, '@c.us'));
        if (/@c\.us$/i.test(wid)) variants.push(wid.replace(/@c\.us$/i, '@s.whatsapp.net'));
        if (/@s\.whatsapp\.net$/i.test(wid)) variants.push(wid.replace(/@s\.whatsapp\.net$/i, '@c.us'));

        let contact = null;
        let chat = null;

        if (Store) {
          /* ---------- 外部 Chrome（whatsapp-web.js）原始逻辑（保持不变） ---------- */
          try {
            if (Store.Contact && typeof Store.Contact.get === 'function') {
              for (const v of variants) {
                try { contact = Store.Contact.get(v); } catch (e) { contact = null; }
                if (contact) break;
              }
              if (!contact && D(wid).length >= 8 && typeof Store.Contact.getModelsArray === 'function') {
                const list = Store.Contact.getModelsArray() || [];
                const want = D(wid);
                for (const c of list) {
                  const idS = S(c && c.id);
                  const num = S(c && c.number);
                  if ((idS && D(idS) === want) || (num && D(num) === want)) { contact = c; break; }
                }
              }
            }
          } catch (e) { out.errors.push('Contact.get: ' + (e && e.message)); }
        } else if (typeof window.require === 'function') {
          /* ---------- 内置浏览器（WA①~⑤ webview）：用 WhatsApp 自己的 AMD 模块系统 ---------- */
          // 🔴 关键：内置 webview 没有 whatsapp-web.js 注入的 window.Store / window.WWebJS，
          //    但它有 WhatsApp 自己的 window.require('WAWebCollections')（采集器 probeInPage 就是这么用的）。
          try {
            const C = window.require('WAWebCollections');
            let WID = null, LIDM = null;
            try { WID = window.require('WAWebWidFactory'); } catch (e) { /* ignore */ }
            try { LIDM = window.require('WAWebLidMigrationUtils'); } catch (e) { /* ignore */ }
            if (C) {
              const contacts = (C.Contact && typeof C.Contact.getModelsArray === 'function')
                ? (C.Contact.getModelsArray() || []) : [];
              const chats = (C.Chat && typeof C.Chat.getModelsArray === 'function')
                ? (C.Chat.getModelsArray() || []) : [];
              const want = D(wid);
              const normLid = (s) => String(s || '').replace(/:\d+@/, '@');
              const matchId = (id) => {
                const s = String(id || '');
                if (!s) return false;
                if (want && D(s) && D(s) === want) return true;          // 纯数字匹配
                if (normLid(s) === normLid(wid)) return true;          // lid:2@lid ↔ lid@lid
                const alt = s.replace(/@lid$/i, '@c.us').replace(/@c\.us$/i, '@s.whatsapp.net').replace(/@s\.whatsapp\.net$/i, '@c.us');
                return normLid(alt) === normLid(wid);
              };
              for (const c of contacts) { if (matchId(c && c.id)) { contact = c; break; } }
              for (const c of chats) { if (matchId(c && c.id)) { chat = c; break; } }
              out.meta.env = 'req';
            } else {
              out.meta.env = 'no-collections';
            }
          } catch (e) { out.errors.push('req-probe: ' + (e && e.message)); }
        } else {
          out.meta.env = 'no-env';
        }

        /* ---------- ② 收集 Contact 上所有号码相关字段（两种环境通用） ---------- */
        if (contact) {
          out.meta.contactFound = true;
          F('contact_id', contact.id, /@lid$/i.test(S(contact.id)) ? 'lid' : 'jid');
          F('contact_number', contact.number, 'phone');
          F('contact_msisdn', contact.msisdn, 'phone');
          F('contact_phoneNumber', contact.phoneNumber, 'phone');
          F('contact_lid', contact.lid, 'lid');
          // 名字类字段不是号码，但常常就写着号码（如 +1 541 801 0646）—— 原样收，
          // 后面 summarize 会照常判断"像不像号码"。
          // 🔴 2026-10-19 老板：很多 WA 联系人的「名字」本身就是电话号码，必须一并收进来。
          if (contact.pushname) F('dom_header', contact.pushname, 'text');
          if (contact.verifiedName) F('dom_header', contact.verifiedName, 'text');
          if (contact.name) F('dom_header', contact.name, 'text');
          if (contact.formattedName) F('dom_header', contact.formattedName, 'text');
        } else {
          out.meta.contactFound = false;
        }

        /* ---------- ③ 找 Chat 模型（会话资料） ---------- */
        if (Store) {
          try {
            if (Store.Chat && typeof Store.Chat.get === 'function') {
              for (const v of variants) {
                try { chat = Store.Chat.get(v); } catch (e) { chat = null; }
                if (chat) break;
              }
              if (!chat && D(wid).length >= 8 && typeof Store.Chat.getModelsArray === 'function') {
                const list = Store.Chat.getModelsArray() || [];
                const want = D(wid);
                for (const c of list) {
                  const idS = S(c && c.id);
                  const ct = c && c.contact;
                  const pn = S(ct && (ct.phoneNumber || ct.number));
                  if ((idS && D(idS) === want) || (pn && D(pn) === want)) { chat = c; break; }
                }
              }
            }
          } catch (e) { out.errors.push('Chat.get: ' + (e && e.message)); }
        } // 内置 webview 的 chat 已在上面的 req 分支里一并找好

        if (chat) {
          out.meta.chatFound = true;
          F('chat_id', chat.id, /@lid$/i.test(S(chat.id)) ? 'lid' : 'jid');
          const ct = chat.contact;
          if (ct) {
            F('chat_number', ct.phoneNumber || ct.number, 'phone');
            F('chat_number', ct.msisdn, 'phone');
          }
          F('dom_header', chat.formattedTitle, 'text');

          // 开一下会话 —— 号码渲染在头部，不开读不到。只切窗口，不改任何数据。
          try { if (typeof chat.open === 'function') await chat.open(); } catch (e) { /* ignore */ }
        } else {
          out.meta.chatFound = false;
        }

        /* ---------- ④ 问 WhatsApp 要 LID → 真号码 的映射 ---------- */
        const lidWid = /@lid$/i.test(wid) ? wid : (contact && /@lid$/i.test(S(contact.id)) ? S(contact.id) : '');
        if (lidWid) {
          out.meta.isLid = true;
          if (Store) {
            // ④a 本地表先查
            try {
              const AC = (window.WWebJS && window.WWebJS.Store && window.WWebJS.Store.WAWebApiContact)
                || (Store && Store.WAWebApiContact);
              if (AC && typeof AC.getPhoneNumber === 'function') {
                const r = await AC.getPhoneNumber(lidWid);
                F('lid_lookup', r, 'phone');
              }
            } catch (e) { out.errors.push('getPhoneNumber: ' + (e && e.message)); }
            // ④b 注入层的官方查询（本地查不到会发一次网络查询）
            try {
              const W = window.WWebJS;
              if (W && typeof W.getContactLidAndPhone === 'function') {
                const arr = await W.getContactLidAndPhone([lidWid]);
                const row = arr && arr[0];
                F('lid_lookup', row && (row.pn || row.phoneNumber), 'phone');
              } else if (W && typeof W.enforceLidAndPnRetrieval === 'function') {
                const r = await W.enforceLidAndPnRetrieval(lidWid);
                F('lid_enforce', r && (r.phone || r.phoneNumber), 'phone');
              }
            } catch (e) { out.errors.push('enforceLidAndPnRetrieval: ' + (e && e.message)); }
          } else if (typeof window.require === 'function') {
            // 内置 webview：用 WAWebLidMigrationUtils.toPn（与采集器 probeInPage 同口径）
            try {
              const LIDM = window.require('WAWebLidMigrationUtils');
              const WID = window.require('WAWebWidFactory');
              if (LIDM && typeof LIDM.toPn === 'function') {
                let w = lidWid;
                if (WID && typeof WID.createWid === 'function') w = WID.createWid(lidWid);
                const r = S(LIDM.toPn(w));
                if (r) F('lid_lookup', r, 'phone');
              }
            } catch (e) { out.errors.push('LIDM.toPn: ' + (e && e.message)); }
          }
        } else {
          out.meta.isLid = false;
        }

        /* ---------- ⑤ 读网页上肉眼能看到的那几处 ---------- */
        // 等头部渲染出来（chat.open 是异步的）
        await new Promise((r) => setTimeout(r, 450));
        const txt = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return '';
          return (el.innerText || el.textContent || '').trim();
        };
        F('dom_header', txt('[data-testid="conversation-info-header-chat-title"]'), 'text');
        F('dom_subtitle', txt('[data-testid="contact-info-subtitle"]'), 'text');
        F('dom_panel', txt('[data-testid="contact-info-panel"]'), 'text');
        const header = document.querySelector('#main header');
        if (header) F('dom_header_block', (header.innerText || '').slice(0, 300), 'text');
        out.meta.domReadable = !!txt('[data-testid="conversation-info-header-chat-title"]')
          || !!txt('[data-testid="contact-info-subtitle"]');

        return out;
      }, jid),
      new Promise((_, rej) => setTimeout(() => rej(new Error('读资料超时')), timeoutMs)),
    ]);
  } catch (e) {
    return {
      ok: false,
      reason: String((e && e.message) || e),
      jid: String(jid || ''),
      fields: [],
      meta: {},
    };
  }

  const r = raw || {};
  return {
    ok: true,
    jid: String(jid || ''),
    fields: Array.isArray(r.fields) ? r.fields : [],
    meta: r.meta || {},
    errors: Array.isArray(r.errors) ? r.errors : [],
  };
}

module.exports = { probeProfile, summarize, judge, digitsOnly, SRC_LABEL };
