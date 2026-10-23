/**
 * 本地 HTTP 服务 + SSE 推送
 *
 * 只包含读取与建议接口——刻意不提供任何发送接口，这是红线。
 *
 * 接口：
 *   GET  /api/state                  账号状态、待处理数、未读总数、AI 是否可用
 *   GET  /api/customers              客户列表（?only=pending 只看待处理 / ?only=unread 只看有未读）
 *   GET  /api/customer/:code         单个客户 + 消息（含"正在翻译/没翻译"状态）+ 疑似重复 + 档案字段定义
 *   POST /api/customer/:code/read    标记已看（未读清零，点开客户时调）
 *   POST /api/customer/:code/translate 把还没翻的客户消息补翻（打开客户时自动调，默认最多 20 条）
 *   GET  /api/customer/:code/conversation 右栏「对话翻译」用：从最新一条往回取 N 条（含译文/翻译态）
 *   POST /api/customer/:code/profile 更新档案（填地区会自动补时区；created_at 改加入时间）
 *   POST /api/customer/:code/extract 从整段对话里抽取/更新客户档案（不用先生成建议）；
 *                                    顺带按电话号码查重：有重复档案就用 AI 读进来合并成一份
 *   POST /api/customer/:code/replied 标记已回复（清红点）
 *   POST /api/customer/:code/suggest 生成三条中文建议
 *   POST /api/suggestion/adopt       采纳：存进话术库
 *   POST /api/suggestion/reject      不采纳：记负样本并换思路重出
 *   GET  /api/learned                话术库 + 负样本 + 统计
 *   POST /api/manual                 手动录入消息（不连 WhatsApp / Signal 客户也能用）
 *   POST /api/account/:id/open       打开该账号的 WhatsApp 浏览器（没开就启动，开了就拉到前台）
 *   GET  /api/ai/config              读 AI 配置（baseUrl / 模型；apiKey 只回显尾巴）
 *   POST /api/ai/config              存 AI 配置（回写 config.yaml，只改值、注释全留）
 *   POST /api/ai/test                拿配置真打一次请求，验证 key 能不能通
 *   GET  /api/ai/prompts             看每个 AI 任务实际发出去的提示词（含知识库正文）
 *   GET  /api/events                 SSE：new_message / translated / qr / account / pending / notice / synced
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const coach = require('./coach');
const learn = require('./learn');
const configWrite = require('./configWrite');
const translator = require('./translator');
const media = require('./media');
const numberLibrary = require('./numberLibrary');
const docDedup = require('./docDedup');
const bubbleConfig = require('./bubbleConfig'); // v2.6.1121：气泡翻译模型（用哪家 AI 翻气泡）
const translationMemory = require('./translationMemory'); // v2.6.1122：跨消息翻译记忆（同一句话只翻一次）
const scanConfig = require('./scanConfig'); // v2.6.1171：扫描图片用哪家视觉模型（服务商 key）
const voiceConfig = require('./voiceConfig'); // v2.6.1188：语音识别用哪家模型（服务商 key）
const scriptBoard = require('./scriptBoard');
const replyLibrary = require('./replyLibrary');
const identity = require('./identity');
const ids = require('./ids');   // v2.6.1095：WA① 客户编号走独立 WA 段（ACC_WA_EMBEDDED=10）
const cloud = require('./cloud');
const phoneScan = require('./phoneScan');   // 2026-10-07 「📞 抓取」：全量号码候选扫描（只读）
const phoneFill = require('./phoneFill');   // 2026-10-07 「电话号码」自动填充 + 加号判断（只读）
const ai = require('./ai');                  // v2.6.1164：地区→时区 用 DeepSeek 算（translator/media 已间接加载，安全）
const aiVault = require('./aiVault');        // v2.6.115x：集中托管 API key（本地密钥库 + 云端密文）
const regions = require('./regions');        // 回落用静态时区表
const telegramMtproto = require('./telegramMtproto'); // v2.5.1087：Tele① 回复框真发送（sendToPeer）
const telegramMerge = require('./telegramMerge');   // v2.6.1194：Telegram 专属判定（乱码标记；绝不供 WA/Signal 复用）
/* 🔴 安全 require（保留，理由变了）
 * 起因：A/B 双版物理隔离期间，另一版专属模块不在安装包内，直接 require 会
 * 抛 Cannot find module 整个软件起不来。双版本已取消、两个模块都会打进包，
 * 理论不再需要兜底 —— 但保留：模块缺失时给 null + 明确报错，比让 HTTP 服务
 * 直接崩掉更好。调用处一律判空。 */
function safeRequireTelegram(rel) {
  try { return require(rel); } catch (e) { return null; }
}
const telegramChannel = require('./telegramChannel'); // 通道常量（单线，恒为 A）
const telegramOfficialChannel = safeRequireTelegram('./telegramOfficialChannel'); // 🔴 当前唯一通道：MTProto 官方直连
/* 🔴 v2.6.1094 WA①（WhatsApp 内置浏览器）：独立模块，跟Telegram 那套完全分开。
 *   只提供「只读跳转」——把WA① 网页打开某个客户的对话，绝不发送任何消息。 */
const whatsappWebView = safeRequireTelegram('./whatsappWebView');
/* 🔴 v2.6.1121 WA①（内置浏览器）**采集**：跟上面那个「只读跳转」是两个模块、两个职责
 *   （老板铁律：不同功能各归各的文件）。这里只**读状态**给界面看 —— 采集本身
 *   由 main.js 的 startWhatsappWebWatching() 起，server 一行采集逻辑都没有。 */
const whatsappRead = safeRequireTelegram('./whatsappRead');
const waBubble = safeRequireTelegram('./waBubble');   // v2.6.1121：WA① 中文译文气泡

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * 界面构建戳：取 public/ 里界面文件的最新修改时间（2026-09-30 起把
 * 「全局设置」那扇窗的 settings.html / settings.js 也算进来 —— 否则改了它，
 * 顶栏那个版本号不动，你没法一眼确认窗口跑的是哪份）。
 * 作用有两个：
 *  1) index.html 里 `/app.js?v=__BUILD__` 的占位会被换成它，文件一改、地址就变，缓存必然失效；
 *  2) /api/version 把它回给界面，顶栏显示极小一行版本号，
 *     你一眼就能确认「现在这个窗口跑的是不是最新的那份界面」。
 */
function buildStamp() {
  try {
    const files = ['index.html', 'board.html', 'settings.html', 'phone.html',
      'app.js', 'board.js', 'settings.js', 'phone.js', 'style.css']
      .map((f) => path.join(PUBLIC_DIR, f));
    const ms = files.filter((f) => fs.existsSync(f)).map((f) => fs.statSync(f).mtimeMs);
    if (!ms.length) return 'dev';
    const d = new Date(Math.max(...ms));
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  } catch (e) {
    return 'dev';
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // 2026-10-07 加：聊天里的图片/语音缩略图要能直接显示（见 /media 路由）
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** 按加入时间算「认识第几天」：Day = 距离加入日 0 点的日历天 + 1（加入当天 = Day 1） */
function dayOf(joinedAt) {
  const j = new Date(joinedAt);
  if (isNaN(j.getTime())) return 1;
  const jMid = new Date(j.getFullYear(), j.getMonth(), j.getDate()).getTime();
  const now = new Date();
  const tMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.floor((tMid - jMid) / 86400000) + 1;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    return {};
  }
}

/**
 * @param {object} deps {db, doc, ai, knowledge, cfg, getAccountStates}
 * @param {number} port
 */
function createServer(deps, port = 8787) {
  const { db, doc, ai, knowledge, cfg, simulateMessage, clearSimulated, telegramWebView } = deps;

  // 左栏列表的排序与字段都收在 db.listCustomers 里（2026-09-26：新消息提醒的排队规则，
  // 有未读的在上、按"先来先排"升序，同一客户再来消息位置不动）。
  const listCustomersStmt = db.listCustomers;

  const sseClients = new Set();

  function broadcast(type, payload) {
    const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(line);
      } catch (e) {
        sseClients.delete(res);
      }
    }
  }

  /**
   * 安全更新客户：自动补齐 updateCustomer 所需的全部命名参数
   * （node:sqlite 要求参数必须都存在，否则抛 Missing named parameter），
   * 未传的字段沿用库里现有值（等价于原 SQL 的 COALESCE）。
   */
  function updateCustomerSafe(f) {
    const cur = db.getCustomer.get(f.code) || {};
    db.updateCustomer.run({
      code: f.code,
      name: f.name ?? cur.name,
      region: f.region ?? cur.region,
      timezone: f.timezone ?? cur.timezone,
      stage_day: f.stage_day ?? cur.stage_day,
      mood: f.mood ?? cur.mood,
      summary: f.summary ?? cur.summary,
      profile_json: f.profile_json ?? cur.profile_json,
      phone: f.phone ?? cur.phone,
      // 号码来源标记（2026-10-07）：人工在弹窗里填/改的号码钉成 manual，
      // 之后自动流程永不覆盖（applyRegrab / backfillIdentity 都认这个标记）。
      phone_src: f.phone != null && String(f.phone).trim() ? 'manual' : (cur.phone_src || ''),
      created_at: f.created_at ?? cur.created_at,
      created_at_source: f.created_at_source ?? cur.created_at_source,
    });
  }

  function aiStatus() {
    const names = ['receive', 'translate', 'translateReply', 'extract', 'suggest', 'vision', 'asr', 'video'];
    const out = {};
    for (const n of names) {
      // ① 接收信息是采集环节（抓消息入库），本身不调 AI —— 永远算就绪，不显示「未配置」
      if (typeof ai.noAiTask === 'function' && ai.noAiTask(n)) {
        out[n] = { provider: '', model: '', ready: true, noAi: true };
        continue;
      }
      const t = cfg?.ai?.tasks?.[n];
      out[n] = t ? { provider: t.provider, model: t.model, ready: ai.isReady(n) } : null;
    }
    return out;
  }

  /** 没配好就说清是哪一项没配好，界面直接显示这句话去引导用户填 key */
  function aiNotReadyReason() {
    if (ai.isReady('suggest')) return null;
    return ai.notConfiguredReason('suggest') || '未填 key';
  }

  /**
   * 取一组编号的全部消息（合并过的档案要把并进来的编号的对话一起写上），
   * 按时间排序、按 wa_msg_id 去重。
   */
  function collectMessages(codes) {
    const seen = new Set();
    const all = [];
    for (const c of codes) {
      if (!c) continue;
      for (const m of db.listMessages.all(c)) {
        const key = m.wa_msg_id || `${m.customer_code}|${m.msg_ts}|${m.direction}|${m.body}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(m);
      }
    }
    return all.sort((a, b) => String(a.msg_ts || a.created_at || '')
      .localeCompare(String(b.msg_ts || b.created_at || '')));
  }

  /**
   * 重新生成客户档案文档。
   * 2026-09-26 起感知「归并表」：如果这个编号已经并进了另一个编号的档案，
   * 就写进那份文件（并把并进来的几个编号的对话一起写全），自己不再单独留一份。
   */
  function refreshDoc(code) {
    const canon = docDedup.canonicalOf(code) || code;
    const c = db.getCustomer.get(canon) || db.getCustomer.get(code);
    if (!c) return null;
    const merged = docDedup.mergedCodesOf(canon);
    const msgs = collectMessages([canon, ...merged]);
    const file = doc.writeCustomerDoc(c, msgs, { mergedCodes: merged });
    // 非保留编号：自己那份旧文档挪进备份，别让文件夹里又出现一份重复档案
    if (canon !== code && typeof doc.stashDocFile === 'function') {
      try { doc.stashDocFile(code); } catch (e) { /* 挪不动就算了，不影响写档 */ }
    }
    return file;
  }

  /**
   * 把 AI 抽出来/合并出来的 16 字段写进某个编号的客户记录（列 + profile_json）。
   * 抽档案、合并重复档案两处都要用，抽成一个函数免得两边跑偏。
   */
  function applyExtractedProfile(code, extracted) {
    const c = db.getCustomer.get(code);
    if (!c || !extracted) return null;
    const region = extracted['地区'] || c.region || null;
    const phone = extracted['电话号码'] || c.phone || null;
    const name = extracted['姓名'] || c.name || null;
    // 时区（2026-09-30）：客户自己手填的「与北京的小时差」是明确指令，**AI 不许覆盖**；
    // 没手填时才让抽取结果顶上，还空就按地区推。
    const handTz = doc.isTzOffset && doc.isTzOffset(c.timezone) ? c.timezone : null;
    let timezone = handTz || extracted['时区'] || c.timezone || null;
    if (!timezone && region) timezone = doc.guessTimezone(region) || null;

    const extraObj = {};
    for (const k of (ai.EXTRA_PROFILE_KEYS || [])) {
      if (extracted[k] !== undefined && extracted[k] !== '') extraObj[k] = extracted[k];
    }
    let mergedProfile = {};
    try { mergedProfile = JSON.parse(c.profile_json || '{}'); } catch (e) { mergedProfile = {}; }
    mergedProfile = { ...mergedProfile, ...extraObj };
    const profileJsonStr = Object.keys(mergedProfile).length
      ? JSON.stringify(mergedProfile) : (c.profile_json || null);

    updateCustomerSafe({
      code,
      name,
      region,
      timezone,
      phone,
      stage_day: c.stage_day || 0,
      profile_json: profileJsonStr != null ? profileJsonStr : undefined,
    });
    return { name, region, phone, timezone };
  }

  /**
   * 给消息补上翻译 / 媒体状态，界面据此显示「⟳ 等待翻译中…」「正在看图…」：
   *   translating  正在翻（后台队列里）
   *   untranslated 该翻但还没翻（历史同步进来的 / AI 没配）
   *   mediaKind    image / audio / video / file（这条带的媒体是什么）
   *   mediaWaiting AI 还没看完（图片/语音 → 中文说明）
   * 本来就是中文的消息两个都是 false —— 界面不会多此一举地写"未翻译"。
   */
  /* Telegram 气泡 id 提取（v2.5.1057）
     库里 wa_msg_id = `${chatKey}:${msgId}`；Telegram 的 chatKey 是纯数字对话 id，
     但为了不被冒号坑到，这里不解析前缀 —— **只把第一个冒号之前的部分当 chatKey**，
     按长度切掉，剩下的原样返回。WA / Signal 的行不适用（它们本来也不需要贴气泡）。 */
  function midOfTelegramRow(m) {
    const raw = String((m && (m.wa_msg_id || m.waMsgId)) || '');
    const i = raw.indexOf(':');
    if (i < 0) return raw;
    return raw.slice(i + 1);
  }

  function withTranslationState(m) {
    const translating = translator.isTranslating(m.id);
    // 2026-10-15 v2.6.1121：两个方向都算（自己发出去的也要有中文）
    const needs = !m.body_zh && translator.needsTranslation(m.body);
    const failed = m.translate_state === 'failed';
    // 2026-09-30：「判定不用翻」（本来就是中文）也记事，界面据此什么都不显示，
    // 不再挂"等待翻译中"骗人，也不会被当成失败去反复重试。
    const skipped = m.translate_state === 'skipped';
    // 🔴 2026-10-07 21:20：mediaKind 优先用库里的 media_type（真实 msg.type），
    //   没有才按扩展名兜底。原因：贴纸存下来是 .webp，在 IMAGE_EXT 里 → 贴纸
    //   会被当成图片。老数据 media_type 为空时行为不变。
    const byExt = media.kindOf(m.media_path);
    const realType = String(m.media_type || '').toLowerCase();
    const mediaKind = realType && realType !== 'sticker' && realType !== 'ptt'
      ? realType
      : (realType || byExt || '');
    const aiKind = media.kindOf(m.media_path); // AI 只处理按扩展名判得出的图/语音
    const mediaWaiting = !!(aiKind && media.canProcess(aiKind)
      && m.direction === 'in' && !m.media_zh);
    return {
      ...m,
      // v2.5.1057：把 Telegram 气泡的 data-mid 一起带出去（= wa_msg_id 里 `tg peer:` 后面那段）。
      // 采集侧存的是 `${chatKey}:${msgId}`，chatKey 可能自己带冒号，所以按长度切更稳。
      mid: midOfTelegramRow(m),
      translating,
      translateFailed: failed && !translating,
      translateSkipped: skipped && !translating,
      untranslated: needs && !translating && !failed && !skipped,
      mediaKind: mediaKind || '',
      // 真实媒体身份：贴纸用它显示「贴纸」而不是「图片」
      mediaType: realType || byExt || '',
      // 2026-10-07 加：附件来源。download=官方真原图 / base64=从正文里救出来的
      //（当天可见，消息刷新后可能失效）/ none=是媒体消息但没拿到图。
      // 界面上用它决定"给不给临时图"的水印提示。
      mediaSrc: m.media_src || '',
      mediaFetchState: m.media_fetch_state || '',
      mediaWaiting: mediaWaiting && !media.isProcessing(m.id),
      mediaWorking: mediaWaiting && media.isProcessing(m.id),
      /* 🔴 v2.6.1194 老板原话：「像这种无法翻译的就不要翻译了。这种乱码，
       *   直接在气泡上写上『乱码无法翻译』就可以了」。
       *
       * 为什么要后端下标记、而不是让 public/app.js 自己判 ——
       *   规则必须**前后端只有一份**。前端是复制粘贴的独立副本（public/ 不能 require src/），
       *   两边各判一次迟早会漂移；下发标记后，public/app.js 只读这个布尔值，
       *   判据仍然只有 telegramMerge.isGarbledText 这**一个**实现。
       *
       * 为什么还要覆盖「已经有 body_zh 的老数据」：
       *   生产库 id 1883 那条，模型回了句「抱歉，这条消息看起来是一串密钥或代码…」，
       *   已经被当成正常译文持久化进 body_zh 了。前端只要看到 tgGarbled=true 就
       *   **优先显示「乱码无法翻译」**，那条无用译文自然被盖掉 —— 不必写迁移脚本。
       *
       * 🔴 判定本身对 WA/Signal 一律返回 false（全库只读实测：telegram 12 条，
       *   whatsapp-web / whatsapp / signal 各 0 条），所以这个字段对其它渠道
       *   恒为 false，**不改变任何现有行为**。 */
      tgGarbled: telegramMerge.isGarbledText(m.body),
    };
  }

  /* ---------------- 手动录入 ---------------- */

  /** 渠道前缀：第一版只用 WhatsApp，这里先留好坑 */
  const CHANNEL_PREFIX = { tg: 'telegram', ig: 'instagram', li: 'linkedin', fb: 'facebook' };

  function channelOfJid(jid) {
    const m = /^(tg|ig|li|fb):/.exec(jid || '');
    if (m) return CHANNEL_PREFIX[m[1]];
    if (/@c\.us$|@s\.whatsapp\.net$/.test(jid || '')) return 'whatsapp';
    return 'manual'; // 人工录入、渠道未标明
  }

  /**
   * 客户标识 → JID
   * 手机号（纯数字 6 位以上）按 WhatsApp 格式；tg:/ig:/li:/fb: 前缀的按对应渠道；其他走 manual:
   */
  function normalizeJid(ident) {
    const s = String(ident || '').trim();
    if (!s) return null;
    if (/@/.test(s)) return s; // 已经带域名，原样用
    if (/^\+?\d{6,}$/.test(s)) return `${s.replace(/^\+/, '')}@c.us`;
    if (/^(tg|ig|li|fb):/.test(s)) return s;
    return `manual:${s}`;
  }

  /** 从 JID 里剥出纯号码，剥不出来就 null（避免把 "tg:123" 当手机号存） */
  function phoneOfJid(jid) {
    const raw = String(jid || '')
      .replace(/^[a-z]{2}:/, '')
      .split('@')[0];
    return /^\+?\d{5,}$/.test(raw) ? raw.replace(/^\+/, '') : null;
  }

  /** 把粘贴的文本拆成 [{direction, body}]：以「我:」「me:」开头的算自己发的 */
  function parseLines(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^(我|me|Me|ME)\s*[:：]\s*(.+)$/.exec(l);
        return m ? { direction: 'out', body: m[2].trim() } : { direction: 'in', body: l };
      });
  }

  /**
   * 手动录入消息：不连 WhatsApp 也能用
   * body: {ident, name, region, accountId, body | lines:[{direction, body, ts}], translate:boolean}
   */
  async function handleManual(body) {
    const jid = normalizeJid(body.ident || body.phone);
    if (!jid) return { error: '缺少客户标识（手机号、Signal 用户名或你给的固定代号）' };

    const accountId = Number(body.accountId) || 1;
    const raw = String(body.body || '');
    const lines = Array.isArray(body.lines) && body.lines.length
      ? body.lines
          .map((l) => (typeof l === 'string' ? { direction: 'in', body: l } : l))
          .filter((l) => l && String(l.body || '').trim())
      : // 单行且没写「我:」前缀时，按调用方指定的方向走；多行则按前缀自动分
        /\n/.test(raw) || /^\s*(我|me)\s*[:：]/.test(raw)
        ? parseLines(raw)
        : [{ direction: body.direction === 'out' ? 'out' : 'in', body: raw }];

    const nonEmpty = lines.filter((l) => String(l.body || '').trim());
    if (!nonEmpty.length) return { error: '没有可录入的内容' };

    const channel = body.channel || channelOfJid(jid);
    const { customer, isNew } = db.getOrCreateCustomer(accountId, jid, {
      name: body.name || null,
      phone: phoneOfJid(jid),
      channel,
    });

    // 这个客户可能是很久以前就加了的——允许手动指定加入时间，
    // 一旦手填就标 manual，之后任何自动流程都不再覆盖它。
    if (body.joinedAt) {
      const d = new Date(body.joinedAt);
      if (!isNaN(d)) db.setJoinedAt(customer.code, d.toISOString(), 'manual');
    }

    if (body.region) {
      // 只覆盖地区/时区/姓名；created_at / created_at_source 原样传回，
      // 确保"补录带地区的对话"不会把已手填的加入时间清空。
      // （极简档案只有 6 字段，没有情绪/动机等附加资料，不存在被抹掉的风险。）
      updateCustomerSafe({
        code: customer.code,
        name: body.name || null,
        region: body.region,
        timezone: doc.guessTimezone ? doc.guessTimezone(body.region) : null,
        created_at: customer.created_at,
        created_at_source: customer.created_at_source,
      });
    }

    const wantTranslate = body.translate !== false && cfg?.app?.autoTranslate !== false;
    const dedupe = body.dedupe !== false; // 默认开：重复粘贴同一段不会变成两份
    let count = 0;
    const now = new Date().toISOString();

    // 手动录入没有消息服务端 ID，只能靠内容去重：最近 30 条里出现过一模一样的话就跳过。
    // 代价是客户连发两句完全相同的短话（比如两个 "ok"），第二句可能录不进来——用 dedupe:false 关掉。
    const recent = dedupe ? db.recentMessages.all(customer.code, 30) : [];
    const seen = new Set(recent.map((m) => `${m.direction}|${m.body || ''}`));

    for (let i = 0; i < nonEmpty.length; i++) {
      const line = nonEmpty[i];
      const direction = line.direction === 'out' ? 'out' : 'in';
      const text = String(line.body || '').trim();
      if (!text) continue;

      const key = `${direction}|${text}`;
      if (dedupe && seen.has(key)) continue;
      seen.add(key);

      const saved = db.saveMessage({
        customerCode: customer.code,
        accountId,
        direction,
        body: text,
        waMsgId: `manual:${customer.code}:${Date.now()}:${i}`,
        msgTs: line.ts || now,
        silent: false,
      });
      if (!saved.changes) continue; // 重复内容，跳过
      count++;

      // 手动录入也走"先入库、后台翻译"：录完立刻能在右栏看到，中文慢慢补上
      // （本来就是中文的那几行不会去调 AI，省一半成本）
      if (direction === 'in' && wantTranslate) {
        translator.translateLater(saved.id, customer.code, text, (r) => {
          broadcast('translated', r);
          if (r.bodyZh) refreshDoc(customer.code);
        });
      }
    }

    if (count) {
      refreshDoc(customer.code);
      broadcast('new_message', {
        code: customer.code,
        name: customer.name,
        direction: 'in',
        unread: db.getCustomer.get(customer.code)?.unread || 0,
      });
      broadcast('pending', { code: customer.code });
    }

    return { ok: true, code: customer.code, isNew, count, customer: db.getCustomer.get(customer.code) };
  }

  /**
   * 从整段对话里抽取客户档案（极简卡片：只补 姓名 / 电话号码 / 地区 / 时区 几项，
   * 拿不准的留空让系统补）。阶段由教练按节奏判，加入时间系统自动记。
   * 只在抽到东西时才写库，返回抽到的结果。
   */
  async function extractProfileOf(code, messagesArg, profileArg) {
    const c = db.getCustomer.get(code);
    if (!c) return { error: '客户不存在' };

    const messages = messagesArg || db.listMessages.all(code);

    // 整段对话都喂进去——只看最近几条会漏掉他早先说过的地区/电话线索
    const convText = messages
      .map((m) => `[${m.direction === 'in' ? '客户' : '我'}] ${m.body || ''}${m.body_zh ? `\n  （译）${m.body_zh}` : ''}`)
      .join('\n')
      .slice(-12000);

    if (!convText.trim()) return { error: '还没有对话内容' };

    const extracted = await ai.extractProfile(convText, profileArg || null);
    if (!extracted) return { error: 'AI 抽取失败，详见终端日志' };

    applyExtractedProfile(code, extracted);

    // 同一份对话也可能是"并进来的那个编号"，档案统一写在保留的那份上
    const canon = docDedup.canonicalOf(code) || code;
    if (canon !== code) applyExtractedProfile(canon, extracted);

    // 查重 & 合并：同一个电话号码下还有别的档案 → 让 AI 读进来合并成一份
    // （用户的流程：先取电话 → 遍历 customers 目录 → 有重复就合并）
    const dedupInfo = await mergeDuplicateDocs(code);

    const docFile = refreshDoc(code);
    return { profile: extracted, docFile, dedup: dedupInfo };
  }

  /**
   * 「从对话里提取档案」的查重合并。
   *
   * 为什么会有多份档案：编号库（同一手机号只发一个编号）是 2026-09-25 才加的，
   * 在那之前同一个号码在不同 WhatsApp 账号上会各建一条客户，于是各写一份档案。
   * 新客户不会再这样，但历史遗留的重复档案需要清一次。
   *
   * 流程（严格按用户要求）：
   *   ① 把这个客户的电话号码拿出来（拿不到就跳过，没号码无从查重）
   *   ② 扫 customers 目录里所有 .md，文件名或文档头部的电话号码相同 → 就是重复档案
   *   ③ 有重复 → 用 AI（「抽客户档案用哪个 AI」选的那家）把这几份**读进来合并成一份**，
   *      合并结果落回保留编号的客户记录
   *   ④ 那几份重复文件挪进 customers/_merged_backup/ 备份（**不删**），
   *      并把归并关系记进 doc_groups.json —— 以后刷新任何一个编号都写同一份文件
   *
   * @returns {Promise<object|null>} 给界面看的合并结果（null = 没电话，跳过）
   */
  async function mergeDuplicateDocs(code) {
    const c = db.getCustomer.get(code);
    if (!c) return null;
    const phone = docDedup.normalizePhone(c.phone);
    if (!phone) return { skipped: 'no-phone', duplicates: 0 };

    const canon = docDedup.canonicalOf(code) || code;
    const dupes = docDedup.scanDocsByPhone(phone, { excluding: canon });
    if (!dupes.length) return { duplicates: 0, canonical: canon };

    // 把保留的那份 + 重复的那几份文档全文读出来
    const docsToMerge = [];
    const canonPath = doc.findExistingDoc(canon);
    if (canonPath && fs.existsSync(canonPath)) {
      docsToMerge.push({ file: path.basename(canonPath), code: canon, text: docDedup.readDoc(canonPath) });
    }
    for (const d of dupes) docsToMerge.push({ file: d.file, code: d.code, text: docDedup.readDoc(d.path) });

    // 交给 AI 读 + 合并（用「抽客户档案用哪个 AI」那家；假 ai 没这函数就跳过，只做归并）
    let mergedProfile = null;
    if (typeof ai.mergeProfileFromDocs === 'function' && docsToMerge.length >= 2) {
      mergedProfile = await ai.mergeProfileFromDocs(docsToMerge);
    }
    if (mergedProfile) applyExtractedProfile(canon, mergedProfile);

    // 记账 + 备份重复文件（不删：数据无价，留一户随时能翻回去）
    const mergedCodes = dupes.map((d) => d.code);
    docDedup.setGroup(canon, mergedCodes);
    const backedUp = [];
    for (const d of dupes) {
      if (typeof doc.stashDocFile !== 'function') break;
      const where = doc.stashDocFile(d.code);
      backedUp.push({ code: d.code, file: d.file, backup: where || null });
    }

    return {
      duplicates: dupes.length,
      canonical: canon,
      mergedCodes,
      backedUp,
      aiMerged: !!mergedProfile,
      mergedProfile: mergedProfile || null,
    };
  }

  /**
   * 生成回复建议
   * @param {string} code 客户编号
   * @param {object} opt {attempt:number, angleOnly:string, avoid:string[]}
   */
  async function handleSuggest(code, opt = {}) {
    const customer = db.getCustomer.get(code);
    if (!customer) return { error: '客户不存在' };

    if (!ai.isReady('suggest')) {
      return { error: `AI 未配置：${ai.notConfiguredReason('suggest') || '未知原因'}（消息照常入库，只是不出建议）` };
    }

    const attempt = Number(opt.attempt) || 0;
    const angleOnly = opt.angleOnly || null;
    const avoid = Array.isArray(opt.avoid) ? opt.avoid : [];

    const messages = db.listMessages.all(code); // 按 id ASC（旧 → 新）

    // 需求②（收窄）：只给「我最后一条回复之后」客户发来的新消息出建议。
    //   1) 找最后一条 direction==='out' 的消息（即我最近一次回复）的位置；
    //   2) 只取它【之后】的 in 消息作为建议对象；
    //   3) 如果一条 out 都没有（我还没回复过），则全部 in 消息都算「还没回过的新消息」。
    // 单条模式（消息气泡的「建议」按钮）仍走 messageId 那条，不走这里的收窄。
    const MAX_GROUPS = 8; // 一次最多给 8 条留言的建议（8×3=24），再多就截断，避免 prompt 爆掉
    const lastOutIdx = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].direction === 'out') return i;
      }
      return -1;
    })();
    let targets;
    if (lastOutIdx >= 0) {
      targets = messages.slice(lastOutIdx + 1).filter((m) => m.direction === 'in');
    } else {
      targets = messages.filter((m) => m.direction === 'in');
    }
    targets = targets.slice(-MAX_GROUPS);
    if (!targets.length) {
      return {
        error: lastOutIdx >= 0
          ? '我最后一条回复之后，客户还没有发来新消息，暂时不需要出建议'
          : '这个客户还没有客户发来的消息，没法出建议',
      };
    }

    const singleId = opt.messageId ? String(opt.messageId) : null;
    let groupMsgs = targets;
    if (singleId) {
      const one = messages.find((m) => String(m.id) === singleId && m.direction === 'in');
      groupMsgs = one ? [one] : [];
    }
    if (!groupMsgs.length) return { error: '没找到这条消息（可能它不是客户发来的，或已被删除）' };

    // 喂给 AI 的「逐条输入」：每条客户留言一份（原文 + 译文）
    const groupsIn = groupMsgs.map((m, i) => ({
      index: i,
      id: m.id,
      text: `${m.body || ''}${m.body_zh ? `\n（译）${m.body_zh}` : ''}`.trim(),
    }));

    // 触发知识库匹配：只用最近对话 + 已有地区/阶段等少量信息
    const trigger = [
      ...groupMsgs.map((m) => `${m.body || ''} ${m.body_zh || ''}`),
      customer.region || '',
      customer.summary || '',
    ].join('\n');

    const blocks = knowledge.buildBlocks(trigger);

    // ---- 教练：第几天（需求①：按「加入后第几天」算，和中栏一致）、从哪几个角度说 ----
    // 注意：显示用的 Day 用 joinDay（加入天数），教练内部用 min(joinDay,7) 取对应的七天节奏，
    // 这样右栏建议头里的 Day 和中栏档案条的 Day 永远对得上。
    const joinDay = coach.joinDayOf(customer);
    const coachDay = Math.min(joinDay, 7);
    const angles = angleOnly ? [angleOnly] : coach.pickAngles(coachDay, {}).slice(0, 3);
    const coachBlock = coach.buildCoachBlock({ day: coachDay, angles, scene: trigger });

    const result = await ai.suggest({
      customer,
      messages,
      profile: null,
      knowledgeBlocks: blocks.text,
      coach: { day: coachDay, angles, coachBlock },
      avoid,
      angleOnly,
      attempt,
      groups: groupsIn, // 需求②：逐条给建议
    });
    if (!result) {
      const detail = (typeof ai.lastError === 'function' && ai.lastError('suggest')) || '';
      return { error: 'AI 调用失败' + (detail ? ('：' + detail) : '，详见终端日志') };
    }

    const task = cfg?.ai?.tasks?.suggest;
    const modelName = task ? `${task.provider}:${task.model}` : '';
    const lastMsg = groupMsgs[groupMsgs.length - 1];
    const ins = db.insertSuggestion.run({
      customer_code: code,
      message_id: lastMsg ? lastMsg.id : null,
      model: modelName,
      // 存的是「分组结构」：每条客户留言 + 它对应的 3 条选项
      options_json: JSON.stringify(result.groups || []),
      rationale: result.rationale || '',
      risk_flags: JSON.stringify(result.riskFlags || []),
      created_at: new Date().toISOString(),
    });

    return {
      ...result,
      suggestionId: Number(ins.lastInsertRowid),
      attempt,
      angles,
      day: { day: joinDay, source: 'join' }, // 需求①：右栏显示的就是这个 joinDay
      knowledge: { always: blocks.always, matched: blocks.matched },
      single: !!singleId,
    };
  }

  /**
   * 中文建议 → 英文口语（翻译弹窗）
   * body: { text, code?, provider?: 'deepseek'|'gpt', count?: 2|3 }
   */
  async function handleTranslate(body) {
    const text = body.text;
    if (!text || !text.trim()) return { error: '没有可翻译的中文内容' };

    const code = body.code || null;
    const customer = code ? db.getCustomer.get(code) : null;

    // 把客户信息灌进翻译提示词：美国人→美式口语、到第几天、朋友关系口吻
    // 时区这一项（2026-09-30）：手填成数字时对判断"是不是美国人"没用，改用按地区推的时区。
    const tzForAi = doc.isTzOffset && doc.isTzOffset(customer?.timezone)
      ? (doc.guessTimezone(customer?.region) || '')
      : (customer?.timezone || '');
    const ctx = {
      name: customer?.name || null,
      region: customer?.region || null,
      timezone: tzForAi || null,
      stage_day: customer?.stage_day || 0,
      mood: customer?.mood || null,
      summary: customer?.summary || null,
    };

    // ④「采纳后翻英文」：用「AI 设置」里单独选的那家（DeepSeek / GPT / Agnes）。
    //   没填就明确报错让你去填，不偷偷用别的模型（免得口吻前后不一致）。
    const providerName = cfg?.ai?.tasks?.translateReply?.provider || 'gpt';
    if (!ai.providerReady(providerName)) {
      return {
        error: '「采纳后翻英文」所选的 AI 还没配置（缺接入地址或 API Key）：'
          + '点顶栏「⚙ AI 设置」，在对应服务商那一段填好并点「测试连接」。',
      };
    }
    const modelName = (cfg?.ai?.tasks?.translateReply?.model)
      || getProvider(providerName)?.model || 'gpt-4o-mini';

    const count = Math.min(3, Math.max(2, Number(body.count) || 2));
    const result = await ai.translateReply(text, ctx, { providerName, modelName, count });
    if (!result) return { error: '翻译调用失败，详见终端日志' };
    return { ok: true, provider: providerName, model: modelName, ...result };
  }

  /**
   * 手动自由翻译（右栏面板）：中文 → 外文（3 情绪版本，语言可选）/ 其他语言 → 中文
   * body: { text, mode:'zh2en'|'other2zh', targetLang }
   */
  async function handleFreeTranslate(body) {
    const text = body.text;
    if (!text || !text.trim()) return { error: '没有可翻译的内容' };

    const mode = body.mode === 'other2zh' ? 'other2zh' : 'zh2en';
    const targetLang = mode === 'zh2en' ? (body.targetLang || '英语') : '中文';

    const providerName = cfg?.ai?.tasks?.freeTranslate?.provider || 'gpt';
    if (!ai.providerReady(providerName)) {
      return {
        error: '「手动自由翻译」所选的 AI 还没配置（缺接入地址或 API Key）：'
          + '点顶栏「⚙ AI 设置」，在对应服务商那一段填好并点「测试连接」。',
      };
    }
    const modelName = cfg?.ai?.tasks?.freeTranslate?.model
      || getProvider(providerName)?.model || 'gpt-4o-mini';

    const result = await ai.freeTranslate({ text, mode, targetLang, providerName, modelName });
    if (!result) return { error: '翻译调用失败，详见终端日志' };
    return { ok: true, provider: providerName, model: modelName, ...result };
  }

  /** 取某条建议记录里的某个选项。现在 options_json 存的是「分组」结构：
   *  [{ index, message, options:[{angle,text}, ...] }, ...]
   *  @param {number} suggestionId
   *  @param {number} groupId   第几组（对应某条客户留言）
   *  @param {number} optionIndex 组内第几个选项（<0 表示整批/整组） */
  function optionOf(suggestionId, groupId, optionIndex) {
    const row = db.db.prepare('SELECT * FROM suggestions WHERE id=?').get(suggestionId);
    if (!row) return null;
    let groups = [];
    try {
      groups = JSON.parse(row.options_json || '[]');
    } catch (e) {
      groups = [];
    }
    if (!groups.length) return null;
    const gi = Number.isFinite(groupId) ? Number(groupId) : 0;
    const group = groups[gi];
    if (!group) return null;
    const oi = Number.isFinite(optionIndex) ? Number(optionIndex) : 0;
    const option = oi >= 0 ? (group.options || [])[oi] || null : null;
    return { row, groups, group, option };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname;

    // ---- SSE ----
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch (e) {
          clearInterval(keepAlive);
        }
      }, 25000);
      req.on('close', () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    // ---- API ----
    try {
      if (p === '/api/state') {
        return json(res, 200, {
          accounts: (deps.getAccountStates ? deps.getAccountStates() : []).map((a) => ({
            id: a.id,
            label: a.label,
            enabled: a.enabled,
            status: a.status || 'offline',
          })),
          // Signal 启动状态（v1.4.0）：顶栏那盏灯。
          // 🔴 v2.5.1034：detectCached 现在**只读缓存、永不起进程**（后台定时刷新维护），
          //    所以这个接口恒定毫秒级返回，绝不再被 PowerShell 拖慢。
          signal: deps.signalStatus ? deps.signalStatus.detectCached(false) : null,
          // 顶栏「S1~S3」启动器状态（v1.5.1017）：Signal 三开。
          // 🔴 v2.5.1034：同样只读缓存 + 后台刷新，异常全兜住，绝不搞挂 /api/state。
          launchers: deps.launcher ? deps.launcher.launcherStates(false) : [],
          // 🔴 v2.6.1116：仓库 config.yaml 与软件实际读的那份是否漂移（老板 19:11 报的 T② enabled:false 根因）。
          //     非空 = 两份不一致，界面顶栏会亮红字提示"你改的那份和软件读的那份不是同一个文件"。
          configDrift: deps.configDrift || null,
          pending: db.db.prepare('SELECT COUNT(*) AS n FROM customers WHERE pending=1').get().n,
          // 顶栏「待处理 N」按"没处理过的新消息"计数：客户每发来一条就 +1，处理完才减
          pendingMsgs: db.countUnprocessed(),
          unread: db.totalUnread(),
          driver: db.driver,
          ai: aiStatus(),
          aiReason: aiNotReadyReason(),
          aiReady: ai.isReady('suggest'),
        });
      }

      // v2.6.1174：「全局设置 → 扫描日志」读取最近扫过的图/语音记录（含 OCR 扫出的文字）
      if (p === '/api/scan/log' && req.method === 'GET') {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
        return json(res, 200, { ok: true, total: db.countScanLogs(), logs: db.listScanLogs(limit) });
      }

      /*
       * ---- 启动顺序第 2 步：数据同步（v2.5.1035 · 老板拍板）----
       *
       * 老板定的规矩（2026-10-11）：
       *   ①软件打开 → 除了登录界面，不许有任何后台动作；
       *   ②登录校验通过 → **这一趟先把云端的话题碎片 + 常用对话拉下来写进本地**；
       *   ③同一份内容和本地已有的相同 → **跳过，不重复加进来**；
       *   ④有了本地副本后，第二次打开直接读本地，**不再联网拉云端**。
       *
       * 返回每一步的真实结果，前端拿它推进度条（不是假的缓动动画）。
       */
      if (p === '/api/boot/sync' && req.method === 'POST') {
        const st0 = cloud.status();
        const code = (st0 && st0.operator && st0.operator.code) || '';
        const body = await readJsonBody(req).catch(() => ({}));
        const force = body && body.force === true;

        const before = cloud.localMasterInfo(code);
        // 本地副本存在、且确实属于当前会员 → 直接用本地，绝不联网（第二次起就该走这条）
        const usable = !!before.exists && before.ownerCode === code
          && ((before.fragments || 0) + (before.replies || 0)) > 0;
        const steps = [];

        let phase = 'local';
        let detail = null;
        if (!usable || force) {
          if (st0 && st0.loggedIn) {
            try {
              const d = await cloud.syncMaster(code);   // 拉云端 → 去重 → 写本地
              phase = 'cloud';
              detail = d;
              steps.push(`云端同步完成：新增 ${d.added.fragments} 个碎片 / ${d.added.replies} 条话术，跳过重复 ${d.skipped.fragments + d.skipped.replies} 条`);
            } catch (e) {
              phase = 'cloud-failed';
              detail = { error: e.message || String(e) };
              steps.push(`云端同步失败：${e.message || e}${ usable ? '（本地副本仍可用，继续用本地）' : ''}`);
              if (!usable) {
                return json(res, 200, { ok: false, error: '云端同步失败：' + (e.message || e), steps });
              }
            }
          } else {
            steps.push('还没登录云端，只能用本地数据');
          }
        } else {
          steps.push('本地已有本编号的数据副本，直接读本地（不联网）');
        }

        // 「启动时同步」勾选框语义：同步过一次就把勾清掉（挪到这里，因为同步已移到本步）
        try { if (cloud.readSyncPref().autoSync) cloud.setAutoSync(false); } catch (e) { /* ignore */ }

        const after = cloud.localMasterInfo(code);
        const local = cloud.cachedMaster(code);
        steps.push(`本地数据就绪：${(local.fragments || []).length} 个话题碎片 / ${(local.replies || []).length} 条常用话术`);

        try { broadcast('data_changed', {}); } catch (e) { /* ignore */ }
        return json(res, 200, {
          ok: true, phase, code, steps, detail,
          fragments: (local.fragments || []).length,
          replies: (local.replies || []).length,
          syncedAt: after.syncedAt || before.syncedAt || null,
        });
      }

      /*
       * ---- 启动顺序第 3 步：拉起后台重活（v2.5.1035）----
       *
       * 只有走到这一步，才允许：扫进程（S1~S3 灯）/ Signal 采集 / Telegram 网页版
       * / Word 每小时重建。以前这些在开机时就偷偷跑了（最过分的是 3.5 秒自动开
       * Telegram 网页版），现在全部等数据和界面都加载完再说。
       */
      if (p === '/api/boot/services' && req.method === 'POST') {
        if (!deps.startBackgroundServices) {
          return json(res, 200, { ok: true, skipped: true, started: [], reason: '本模式没有后台服务' });
        }
        try {
          const r = deps.startBackgroundServices();
          return json(res, 200, { ok: true, started: r.started || [], already: !!r.already });
        } catch (e) {
          // 后台服务起不来不该挡用户进主界面 —— 只报告，不算失败
          return json(res, 200, { ok: true, started: [], warning: e.message || String(e) });
        }
      }

      // ---- Signal 状态：顶栏那盏灯的独立接口（v1.4.0）----
      // 为什么单独开一个：/api/state 是读缓存的被动查询，
      // 而用户「刚打开 Signal」时想立刻看到灯变绿 → 需要一个能强制重查的入口。
      // 🔴 v2.5.1034：强制重查改成 await 异步刷新（refreshNow）——
      //    等的过程是异步的（其它请求照常被处理，界面不卡），但返回的是真正新鲜的结果。
      //    旧版这里同步跑 PowerShell，会把整个软件焊死 1.8~3.3 秒，就是"点一下卡一下"的来源。
      // ---- Telegram 应用内登录弹窗（v2.5.1054）----
      // 这套接口只做「登录授权」：前端分步把手机号 / 验证码 / 两步密码传进来，
      // 后端用 deferred promise 喂给 teleproto 的 client.start()，登录成功后由 main.js 接管消息接收。
      // 🔴 绝无发送：登录是只读鉴权，不破 server.js「不提供任何发送接口」红线。
      if (p === '/api/telegram/login/start' && req.method === 'POST') {
        if (!deps.telegramLogin) return json(res, 501, { ok: false, error: '本版未启用 Telegram 登录模块' });
        const body = await readJsonBody(req).catch(() => ({}));
        const accountId = Number(body.accountId || body.id || 0);
        const acc = (cfg.telegram && cfg.telegram.accounts || []).find((a) => a.id === accountId);
        if (!acc) return json(res, 404, { ok: false, error: `找不到 Telegram 账号 ${accountId}` });
        const r = await deps.telegramLogin.start(accountId, acc);
        return json(res, r.ok ? 200 : 400, r);
      }
      if (p === '/api/telegram/login/phone' && req.method === 'POST') {
        if (!deps.telegramLogin) return json(res, 501, { ok: false, error: '未启用' });
        const body = await readJsonBody(req).catch(() => ({}));
        return json(res, 200, deps.telegramLogin.submit('phone', body.value));
      }
      if (p === '/api/telegram/login/code' && req.method === 'POST') {
        if (!deps.telegramLogin) return json(res, 501, { ok: false, error: '未启用' });
        const body = await readJsonBody(req).catch(() => ({}));
        return json(res, 200, deps.telegramLogin.submit('code', body.value));
      }
      if (p === '/api/telegram/login/password' && req.method === 'POST') {
        if (!deps.telegramLogin) return json(res, 501, { ok: false, error: '未启用' });
        const body = await readJsonBody(req).catch(() => ({}));
        return json(res, 200, deps.telegramLogin.submit('password', body.value));
      }
      if (p === '/api/telegram/login/cancel' && req.method === 'POST') {
        if (!deps.telegramLogin) return json(res, 501, { ok: false, error: '未启用' });
        const r = await deps.telegramLogin.cancel();
        return json(res, 200, r);
      }

      // ---- Telegram 应用凭证（v2.5.1081）：读 / 写 config.yaml 的 telegram.apiId / apiHash ----
      // 和 AI 配置同一套安全写法：只改对应那几行、注释全保留；同时更新内存里的 cfg，
      // 这样保存后登录接口（deps.telegramLogin.start）立刻能拿到新凭证，不用重启。
      if (p === '/api/telegram/config' && req.method === 'GET') {
        const t = (cfg && cfg.telegram) || {};
        const hash = t.apiHash || '';
        return json(res, 200, {
          ok: true,
          apiId: t.apiId || 0,
          apiHashSet: !!hash,
          apiHashHint: hash ? (hash.slice(0, 6) + '…' + hash.slice(-4)) : '',
        });
      }
      if (p === '/api/telegram/config' && req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => ({}));
        const idRaw = Number(body && body.apiId);
        const hashRaw = (body && body.apiHash || '').trim();
        if (!Number.isInteger(idRaw) || idRaw <= 0) return json(res, 400, { ok: false, error: 'apiId 必须是正整数' });
        if (!/^[0-9a-fA-F]{32}$/.test(hashRaw)) return json(res, 400, { ok: false, error: 'apiHash 必须是 32 位 hex' });
        try {
          const paths = require('./paths');
          const cfgFile = paths.configFile();
          let txt = fs.readFileSync(cfgFile, 'utf8');
          const changed = [];
          const r1 = configWrite.setScalar(txt, ['telegram', 'apiId'], idRaw);
          if (r1 && r1.changed) { txt = r1.text; fs.writeFileSync(cfgFile, txt, 'utf8'); changed.push('telegram.apiId'); }
          const r2 = configWrite.setScalar(txt, ['telegram', 'apiHash'], hashRaw);
          if (r2 && r2.changed) { txt = r2.text; fs.writeFileSync(cfgFile, txt, 'utf8'); changed.push('telegram.apiHash'); }
          cfg.telegram = cfg.telegram || {};
          cfg.telegram.apiId = idRaw;
          cfg.telegram.apiHash = hashRaw;
          broadcast('data_changed', { what: 'telegram_config' });
          return json(res, 200, { ok: changed.length > 0, changed });
        } catch (e) {
          return json(res, 500, { ok: false, error: '写入 config.yaml 失败：' + ((e && e.message) || e) });
        }
      }
      if (p === '/api/telegram/options' && req.method === 'GET') {
        const t = (cfg && cfg.telegram) || {};
        return json(res, 200, {
          ok: true,
          translateModel: t.translateModel || '',     // 空 = 跟随全局翻译（deepseek）
          notifySound: !!(t.notifySound),
        });
      }
      if (p === '/api/telegram/options' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req).catch(() => ({}));
          const paths = require('./paths');
          const cfgFile = paths.configFile();
          let txt = fs.readFileSync(cfgFile, 'utf8');
          const changed = [];
          if (body && typeof body.translateModel === 'string') {
            const r = configWrite.setScalar(txt, ['telegram', 'translateModel'], body.translateModel);
            if (r.changed) { txt = r.text; fs.writeFileSync(cfgFile, txt, 'utf8'); changed.push('telegram.translateModel'); }
          }
          if (body && typeof body.notifySound === 'boolean') {
            const r = configWrite.setScalar(txt, ['telegram', 'notifySound'], body.notifySound);
            if (r.changed) { txt = r.text; fs.writeFileSync(cfgFile, txt, 'utf8'); changed.push('telegram.notifySound'); }
          }
          cfg.telegram = cfg.telegram || {};
          if (body && typeof body.translateModel === 'string') cfg.telegram.translateModel = body.translateModel;
          if (body && typeof body.notifySound === 'boolean') cfg.telegram.notifySound = body.notifySound;
          broadcast('data_changed', { what: 'telegram_options' });
          return json(res, 200, { ok: changed.length > 0, changed });
        } catch (e) {
          return json(res, 500, { ok: false, error: '写入 config.yaml 失败：' + ((e && e.message) || e) });
        }
      }
      /* 🔴 v2.6.1137：Tele① / Tele② 各自一格状态条，所以这个接口要能问「某一个号」。
         ?account= 不传 **默认还是 7**（老调用方的行为一个字不变）；
         传了就按那个号查它自己的 telegram-session-<id>.txt。
         —— 之前写死 7，Tele② 的状态条（#tg-status-t2）压根问不到自己登没登录。 */
      if (p === '/api/telegram/status' && req.method === 'GET') {
        const t = (cfg && cfg.telegram) || {};
        const hasCred = !!(t.apiId && t.apiHash);
        const accountId = Number(url.searchParams.get('account')) || 7;
        let loggedIn = false;
        try {
          const p2 = require('./paths');
          const dataDir = p2.DATA_ROOT || (cfg && cfg.app && cfg.app.dataDir) || '.';
          const sessPath = require('path').join(dataDir, `telegram-session-${accountId}.txt`);
          loggedIn = fs.existsSync(sessPath) && fs.readFileSync(sessPath, 'utf8').trim().length > 0;
        } catch (e) { /* 读不到就当未登录 */ }
        return json(res, 200, { ok: true, hasCred, loggedIn, accountId });
      }

      /* 🔴 v2.6.1137：Telegram 单账号登出（老板 2026-10-16 拍板 A 方案）。
         只做两件 —— 断开这个号的采集 + 备份后删掉它的会话凭证文件。
         客户档案 / 消息、外部 Chrome 窗口、别的 TG 号一律不动（实现在 src/telegramLogout.js）。 */
      if (p === '/api/telegram/logout' && req.method === 'POST') {
        if (!deps.telegramLogout || typeof deps.telegramLogout.logout !== 'function') {
          return json(res, 501, { ok: false, error: '本版未启用 Telegram 登出模块' });
        }
        const body = await readJsonBody(req).catch(() => ({}));
        const accountId = Number((body && (body.accountId || body.account)) || url.searchParams.get('account') || 0);
        const accs = (cfg && cfg.telegram && Array.isArray(cfg.telegram.accounts)) ? cfg.telegram.accounts : [];
        if (!accs.some((a) => Number(a.id) === accountId)) {
          return json(res, 404, { ok: false, error: `找不到 Telegram 账号 ${accountId}（只有 ${accs.map((a) => a.id).join(' / ') || '无'}）` });
        }
        let dataDir = '.';
        try { dataDir = require('./paths').DATA_ROOT || (cfg && cfg.app && cfg.app.dataDir) || '.'; } catch (e) { /* 兜底 */ }
        const r = await deps.telegramLogout.logout({ accountId, dataDir });
        if (r && r.ok) {
          broadcast('data_changed', { what: 'telegram_logout', accountId });
          console.log(
            `[telegram-logout] 账号 ${accountId} 已登出` +
            (r.stopped ? '（采集已停）' : '（本来没在采）') +
            (r.sessionRemoved ? `，会话文件已备份到 ${r.backup}` : '，本来就没有会话文件'),
          );
        }
        return json(res, r && r.ok ? 200 : 400, r);
      }

      // ---- A / B 双通道标识（前端顶栏显示当前装的是哪个版本，避免装错） ----
      if (p === '/api/telegram/channel' && req.method === 'GET') {
        const credOk = !!(cfg && cfg.telegram && cfg.telegram.apiId && cfg.telegram.apiHash);
        return json(res, 200, {
          ok: true,
          channel: telegramChannel.CHANNEL,
          label: telegramChannel.CHANNEL_LABEL,
          desc: telegramChannel.CHANNEL_DESC,
          hasCred: credOk,
          ready: telegramChannel.IS_A
            ? !!(telegramOfficialChannel && telegramOfficialChannel.hasClient(7))
            : true,
          hint: telegramChannel.IS_A && !credOk ? telegramChannel.CRED_HINT : '',
        });
      }

      // ---- v2.5.1056：从「内置浏览器（Tele① 页签里的 webview）」读 Telegram ----
      // 这条路径**不依赖 api_id / api_hash**：软件自己肚子里那个浏览器登录了就能读。
      // 🔴 只读：探测接口只把页面里看到的东西原样返回，绝不发送、绝不改动页面。
      if (p === '/api/telegram/webview/probe' && req.method === 'GET') {
        if (!telegramWebView) return json(res, 501, { ok: false, error: '本版未启用内置浏览器读取模块' });
        const r = await telegramWebView.probe().catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
        return json(res, 200, r);
      }

      // ---- v2.5.1058：内置浏览器「找不到页面」时的诊断 ----
      // 老板 2026-10-11 报「Telegram 明明在软件里登着，却说没找到内置浏览器里的 Telegram 页面」。
      // 这条接口把 Electron 里**所有页面**（类型 / URL / 标题）原样列出来 —— 一眼能看出
      // 到底是「webview 没被算进 getAllWebContents」还是「URL 匹配没对上」。
      if (p === '/api/telegram/webview/pages' && req.method === 'GET') {
        if (!telegramWebView || typeof telegramWebView.listPages !== 'function') {
          return json(res, 501, { ok: false, error: '本版未启用内置浏览器读取模块' });
        }
        return json(res, 200, telegramWebView.listPages());
      }

      if (p === '/api/signal/status' && req.method === 'GET') {
        if (!deps.signalStatus) return json(res, 200, { ok: true, state: 'red', reason: '本版没带 Signal 检测' });
        let s;
        if (typeof deps.signalStatus.refreshNow === 'function') {
          s = await deps.signalStatus.refreshNow(true).catch(() => null);
        }
        if (!s) s = deps.signalStatus.detectCached(true);
        return json(res, 200, Object.assign({ ok: true }, s));
      }

      // ---- 界面版本号 + 更新日志：详细版本信息统一放「AI 提示词」弹窗里 ----
      if (p === '/api/version' && req.method === 'GET') {
        let changelog = '';
        try {
          // 开发版：__dirname = <项目>/src，CHANGELOG.md 在项目根（上一级）。
          // 打包版：__dirname = resources/app.asar/src，CHANGELOG.md 被收进 app.asar 根（上一级）。
          // 再补几个候选位置，防止不同打包形态 / 解包方式下读不到。
          const cand = [
            path.join(__dirname, '..', 'CHANGELOG.md'),
            path.join(__dirname, '..', '..', 'CHANGELOG.md'),
            path.join(process.resourcesPath || '', 'CHANGELOG.md'),
            path.join(process.cwd(), 'CHANGELOG.md'),
          ];
          for (const cl of cand) {
            try { if (cl && fs.existsSync(cl)) { changelog = fs.readFileSync(cl, 'utf8'); break; } } catch (_) { /* 继续试下一个 */ }
          }
        } catch (e) { changelog = ''; }
        return json(res, 200, {
          build: buildStamp(),
          version: (() => { try { return require('../package.json').version; } catch (e) { return ''; } })(),
          publicDir: PUBLIC_DIR,
          dataDir: (() => { try { return require('./paths').DATA_ROOT; } catch (e) { return null; } })(),
          node: process.version,
          changelog,
        });
      }

      // ---- 代理配置（v2.5.10020）：每个实例独立代理通道 ----
      if (p === '/api/proxy' && req.method === 'GET') {
        try {
          const proxies = require('./proxies');
          return json(res, 200, { ok: true, proxies: proxies.load() });
        } catch (e) {
          return json(res, 200, { ok: true, proxies: {} });
        }
      }
      if (p === '/api/proxy' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            const proxies = require('./proxies');
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
              return json(res, 400, { ok: false, error: '格式错误' });
            }
            const ok = proxies.save(payload);
            if (!ok) return json(res, 500, { ok: false, error: '保存失败' });
            // v2.6.1100：保存后立刻把代理应用到对应 webview（WA① / Tele①），并广播让前端重载 webview
            // v2.6.1120：再加两步 —— ① 先 reset 掉旧中继（否则 getRelay 会复用按**旧配置**起的 gost）；
            //            ② 预热全部「已启用」实例的中转，供外部 Chrome / Signal 那两条路直接取用
            //               （Signal 的 startLauncher 是同步函数，只能 peek，必须提前起好）。
            try {
              const webviewProxy = require('./webviewProxy');
              const proxyRelay = require('./proxyRelay');
              const partKeys = Object.keys(webviewProxy.PARTITION_OF || {});
              const saved = proxies.load();

              // ① 配置可能变了 → 把旧的中继全杀掉（reset 内部同步摘表，随后 getRelay 必然重起新的）
              for (const k of Object.keys(saved)) {
                proxyRelay.reset(k).catch(() => {});
              }
              // ② 预热已启用实例的中转（不 await，避免拖慢保存响应）
              webviewProxy.warmUpAll().catch((e) => console.warn('[proxy] 预热中转失败：', e && (e.message || e)));

              // ③ 有 webview 分区的实例：立刻真正 setProxy + 广播让前端重载 webview
              for (const k of Object.keys(payload || {})) {
                if (partKeys.indexOf(k) === -1) continue;
                webviewProxy.applyForInstance(k).catch((e) => console.warn(`[proxy] ${k} 应用失败：`, e && (e.message || e)));
                try { broadcast('proxy:changed', { key: k }); } catch (e) { /* ignore */ }
              }
            } catch (e) { console.warn('[proxy] 应用 webview 代理失败：', e && (e.message || e)); }
            return json(res, 200, { ok: true, proxies: proxies.load() });
          } catch (e) {
            return json(res, 400, { ok: false, error: '解析失败：' + (e.message || e) });
          }
        });
        return; // 异步读取 body，这里先返回
      }

      // ---- 代理测试（v2.5.1074，v2.5.1077 增：返回地区）：经本地中转真连一次，
      //      比对直连/代理的 IP 与地区，证明代理真的生效且路由到了正确区域 ----
      if (p === '/api/proxy/test' && req.method === 'GET') {
        const m = (req.url.split('?')[1] || '').match(/key=([^&]+)/);
        const k = m ? decodeURIComponent(m[1]) : '';
        if (!k) return json(res, 400, { ok: false, error: '缺少 key' });
        const proxies = require('./proxies');
        const entry = proxies.get(k);
        if (!entry || !entry.enabled) return json(res, 200, { ok: false, changed: false, reason: '该实例未启用代理' });
        try {
          const proxyRelay = require('./proxyRelay');
          const rec = await proxyRelay.getRelay(k);
          if (!rec) return json(res, 200, { ok: false, changed: false, reason: '本地中转起不来（代理配置可能不完整）' });
          const { ProxyAgent, fetch } = require('undici');
          // 取 IP + 地区（ipinfo.io 免费无需 key；超时或失败就回退到 ip-api.com）
          const geo = async (dispatcher) => {
            try {
              const r = await fetch('https://ipinfo.io/json', { dispatcher, signal: AbortSignal.timeout(8000) });
              const j = await r.json().catch(() => ({}));
              if (j && j.ip) return { ip: j.ip, region: [j.country, j.region, j.city].filter(Boolean).join(' · ') || '' };
            } catch (e) { /* 换源 */ }
            try {
              const r2 = await fetch('https://ip-api.com/json/?fields=status,query,country,regionName,city', { dispatcher, signal: AbortSignal.timeout(8000) });
              const j2 = await r2.json().catch(() => ({}));
              if (j2 && j2.query) return { ip: j2.query, region: [j2.country, j2.regionName, j2.city].filter(Boolean).join(' · ') || '' };
            } catch (e) { /* 都失败 */ }
            return { ip: '', region: '' };
          };
          const direct = await geo();
          let prox = { ip: '', region: '' }, reason = '';
          try { prox = await geo(new ProxyAgent(rec.localUrl)); }
          catch (e) { reason = '经代理请求失败：' + (e.message || e); }
          const changed = !!prox.ip && prox.ip !== direct.ip;
          return json(res, 200, {
            ok: !!prox.ip, changed,
            directIp: direct.ip, directRegion: direct.region,
            proxyIp: prox.ip, proxyRegion: prox.region,
            reason,
          });
        } catch (e) {
          return json(res, 200, { ok: false, changed: false, reason: '测试异常：' + (e.message || e) });
        }
      }

      // ---- 本地中转地址（v2.5.1074）：给 Tele① webview 拿一个无密码的中转地址去 setProxy ----
      if (p === '/api/proxy/relay' && req.method === 'GET') {
        const m = (req.url.split('?')[1] || '').match(/key=([^&]+)/);
        const k = m ? decodeURIComponent(m[1]) : '';
        if (!k) return json(res, 400, { ok: false, error: '缺少 key' });
        try {
          const proxyRelay = require('./proxyRelay');
          const rec = await proxyRelay.getRelay(k);
          if (!rec) return json(res, 200, { ok: false, localUrl: null, reason: '该实例未启用代理或配置不完整' });
          return json(res, 200, { ok: true, localUrl: rec.localUrl });
        } catch (e) {
          return json(res, 200, { ok: false, localUrl: null, reason: (e.message || e) });
        }
      }

      // ---- 浏览器插件（网页版 WhatsApp 抓图）：连通性自检 + 接收客户发来的图片 ----
      // 🔴 跨域来源是 web.whatsapp.com（插件 content script）或 chrome-extension://，
      //    **两个端点都必须返回 CORS 头**，否则浏览器在 fetch 阶段就拦掉。
      //    2026-10-09 修：此前只给 incoming-image 加了 CORS，token 端点走全局 json()
      //    没有任何 CORS 头 → 插件自检报「No 'Access-Control-Allow-Origin'」，误判为「连不上软件」，
      //    进而让人以为整个插件没工作。现在两端点共用同一套 CORS 头。
      if (p === '/api/wa-web/token' || p === '/api/wa-web/incoming-image') {
        const origin = req.headers.origin || '';
        const isLocal = /^https:\/\/web\.whatsapp\.com(\/|$)/.test(origin)
          || /^chrome-extension:\/\//.test(origin)
          || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
          || origin === 'null' || origin === '';
        const allowOrigin = isLocal ? (origin || '*') : 'https://web.whatsapp.com';
        const corsHeaders = {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-waweb-token',
          'Access-Control-Max-Age': '600',
        };
        // Chrome 私有网络访问（PNA）：公网页面（web.whatsapp.com）→ 本机 127.0.0.1 时，
        // 新版本 Chrome 可能要求显式许可，否则预检失败。
        if (req.headers['access-control-request-private-network'] === 'true') {
          corsHeaders['Access-Control-Allow-Private-Network'] = 'true';
        }
        const send = (code, obj) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }

        // 连通性自检 / 插件读取令牌（GET 也要带 CORS 头）
        if (p === '/api/wa-web/token') {
          if (req.method !== 'GET') return send(405, { error: '仅支持 GET' });
          return send(200, { ok: true, token: (deps.cfg && deps.cfg.app && deps.cfg.app.waWebToken) || '', port });
        }

        // 接收客户发来的图片：仅 POST
        if (req.method !== 'POST') return send(405, { error: '仅支持 POST' });
        // 令牌校验：插件每次 POST 都要带 x-waweb-token，否则 401
        const token = req.headers['x-waweb-token']
          || new URL(req.url, `http://127.0.0.1:${port}`).searchParams.get('token') || '';
        const expect = (deps.cfg && deps.cfg.app && deps.cfg.app.waWebToken) || '';
        if (!expect || token !== expect) return send(401, { error: '令牌无效' });
        // 读 body（上限 15MB，防滥用）
        let raw = '';
        let overflow = false;
        try {
          for await (const c of req) {
            raw += c;
            if (raw.length > 15 * 1024 * 1024) { overflow = true; req.destroy(); break; }
          }
        } catch (e) { /* 连接中断 */ }
        if (overflow) return send(413, { error: '图片过大（上限 15MB）' });
        let data;
        try { data = JSON.parse(raw); } catch (e) { return send(400, { error: 'JSON 解析失败' }); }
        try {
          const r = await deps.ingestExtensionImage(data);
          if (!r.ok) return send(400, { error: r.error });
          return send(200, { ok: true, code: r.code, msgId: r.msgId, isNew: !!r.isNew });
        } catch (e) {
          console.error('[wa-web] 入库失败：', e);
          return send(500, { error: '服务端处理失败：' + ((e && e.message) || e) });
        }
      }

      // ---- AI 设置：读当前配置（apiKey 只回显尾巴，不回明文）----
      if (p === '/api/ai/config' && req.method === 'GET') {
        if (typeof ai.providerSnapshot !== 'function') return json(res, 501, { error: '当前模式不支持读 AI 配置' });
        const snap = ai.providerSnapshot(configWrite.maskKey);
        snap.aiReady = ai.isReady('suggest');
        snap.aiReason = aiNotReadyReason();
        // 「通用设置」里的提取间隔：同一次 GET 一起回给界面（界面下拉要显示当前值）
        snap.extractInterval = configWrite.clampExtractInterval(cfg.app?.extractInterval);
        // 「通用设置」里的气泡翻译模型（服务商 key，'' = 跟随全局翻译）
        snap.bubbleTranslateModel = bubbleConfig.translateModel();
        // 「通用设置」里的翻译词典用哪个 AI（v2.6.1148）
        snap.translationMemoryModel = translationMemory.getMemoryModel();
        // 「专项 AI」里的扫描图片用哪家视觉模型（v2.6.1171，服务商 key，'' = 跟随视觉任务默认）
        snap.scanImageModel = scanConfig.getImageModel();
        snap.voiceModel = voiceConfig.getVoiceModel();
        return json(res, 200, snap);
      }

      // ---- AI 提示词：把 7 个任务实际发出去的提示词摆出来给界面看 ----
      //   知识库正文和教练块用样例数据现拼，所以看到的就是真发出去的那一份。
      if (p === '/api/ai/prompts' && req.method === 'GET') {
        if (typeof ai.promptCatalog !== 'function') {
          return json(res, 501, { error: '当前模式不支持查看提示词' });
        }
        let knowledgeBlocks = '';
        let coachBlock = '';
        try {
          knowledgeBlocks = knowledge.buildBlocks('你好，我想给我的狗画一张画，挂客厅').text || '';
        } catch (e) { knowledgeBlocks = ''; }
        try {
          const day = 2;
          const angles = coach.pickAngles(day, {}).slice(0, 3);
          coachBlock = coach.buildCoachBlock({ day, angles, scene: '客户刚提到已过世的宠物' });
        } catch (e) { coachBlock = ''; }
        const cat = ai.promptCatalog({ knowledgeBlocks, coachBlock });
        cat.file = ai.configPath ? ai.configPath() : '';
        return json(res, 200, cat);
      }

      // ---- AI 设置：保存（只改 config.yaml 里对应那几行，注释全保留）----
      if (p === '/api/ai/config' && req.method === 'POST') {
        if (typeof ai.providerSnapshot !== 'function') return json(res, 501, { error: '当前模式不支持改 AI 配置' });
        const body = await readJsonBody(req);

        const patch = { providers: {}, tasks: {} };
        // 7 个服务商（DeepSeek / Agnes / 硅基流动 / OpenRouter / TikHub / 阿里百炼 / AstrBot）
        // ⚠️ 混元Hy3 / GPT / Claude / 视觉·看图 / 听觉·语音转文字 已在 2.6.1149 由老板点名删除，兜底数组同步清掉
        const ALLOWED = Array.isArray(ai.PROVIDER_CATALOG)
          ? ai.PROVIDER_CATALOG.map((p) => p.key)
          : ['deepseek', 'agnes', 'siliconflow', 'openrouter', 'tikhub', 'bailian', 'astrbot'];
        // ⚠️ 这里必须包含【内部任务 extract】：
        //   TASK_CATALOG 只列界面上那 5 个 AI，「抽客户档案」是软件内部任务、不在里面，
        //   但它在 AI 设置里有一个专用下拉（抽客户档案用哪个 AI）。2026-09-26 的 bug 就是
        //   因为它不在白名单里，前端发来的 tasks.extract 被这里静默丢掉 ——
        //   表现为「选 Agnes 都不生效，永远是 DeepSeek」。
        const INTERNAL_TASKS = ['extract'];
        const TASKS = [
          ...(Array.isArray(ai.TASK_CATALOG) ? ai.TASK_CATALOG.map((t) => t.key)
            : ['receive', 'translate', 'suggest', 'translateReply', 'freeTranslate']),
          ...INTERNAL_TASKS,
        ];

        for (const name of ALLOWED) {
          const src = body?.providers?.[name];
          if (!src) continue;
          const bag = {};
          if (typeof src.baseUrl === 'string') bag.baseUrl = src.baseUrl.trim();
          if (typeof src.model === 'string' && src.model.trim()) bag.model = src.model.trim();
          // 界面上回显的是 ••••，用户没动就别把掩码写回配置里
          if (typeof src.apiKey === 'string' && src.apiKey.trim() && !src.apiKey.includes('•')) {
            bag.apiKey = src.apiKey.trim();
          }
          if (Object.keys(bag).length) patch.providers[name] = bag;
        }

        // 「这个 AI 用哪家」：界面上 7 个 AI 每个都能单独指定服务商 + 模型
        // （④ 采纳后翻英文固定 GPT，界面上不给改，这里也拦一道，免得被改坏）
        for (const name of TASKS) {
          const src = body?.tasks?.[name];
          if (!src) continue;
          const bag = {};
          if (typeof src.provider === 'string' && ALLOWED.includes(src.provider.trim())) {
            bag.provider = src.provider.trim();
          }
          if (typeof src.model === 'string' && src.model.trim()) bag.model = src.model.trim();
          if (Object.keys(bag).length) patch.tasks[name] = bag;
        }

        // 默认服务商：跟着把几个「文字类」任务切过去（④ 采纳后翻译是独立选择、不跟着变；
        // vision/asr 也不动，它们各有专门的服务商槽）
        const def = body?.defaultProvider;
        if (ALLOWED.includes(def)) {
          // 「一套配好」时各家的默认文字模型。
          // ⚠️ 新增服务商必须同时在这里补一行，否则选了它 modelFor 为 null、
          //    整个 defaultProvider 分支被跳过（2026-09-26 补 Agnes 时差点又踩一次）。
          const FALLBACK_MODEL = {
            gpt: 'gpt-4o-mini',
            anthropic: 'claude-sonnet-4-5',
            deepseek: 'deepseek-v4-flash',
            agnes: 'agnes-3.0-flash',
            siliconflow: 'Qwen/Qwen2.5-72B-Instruct',
            openrouter: 'openai/gpt-4o-mini',
            tikhub: 'gpt-4o-mini',
          };
          const modelFor = FALLBACK_MODEL[def]
            ? (body?.providers?.[def]?.model?.trim()
              || cfg?.ai?.providers?.[def]?.model
              || FALLBACK_MODEL[def])
            : null;
          if (modelFor) {
            for (const task of ['translate', 'extract', 'suggest']) {
              patch.tasks[task] = { provider: def, model: modelFor };
            }
          }
        }

        // 「通用设置」：提取间隔（秒）。只改这个值、别的没动也照存。
        // 抄进 cfg.app.extractInterval，main.js 的兜底重扫循环下次 tick 自动用新值（不用重启）。
        let extractChanged = false;
        if (body && typeof body.extractInterval !== 'undefined') {
          const n = configWrite.clampExtractInterval(body.extractInterval);
          if (n !== configWrite.clampExtractInterval(cfg.app?.extractInterval)) {
            cfg.app = cfg.app || {};
            cfg.app.extractInterval = n;
            extractChanged = true;
            try {
              const paths = require('./paths');
              const cfgFile = paths.configFile();
              const txt = fs.readFileSync(cfgFile, 'utf8');
              const r2 = configWrite.setScalar(txt, ['app', 'extractInterval'], n);
              if (r2 && r2.changed) fs.writeFileSync(cfgFile, r2.text, 'utf8');
            } catch (e) { /* 写不进就只改内存 */ }
          }
        }

        // 「通用设置」：气泡翻译模型（存的是**服务商 key**，'' = 跟随全局翻译）。
        // 只改这个值、别的没动也照存；写进 cfg.bubble 并同步内存里的 bubbleConfig，
        // 翻译队列（translator.js）每次取的都是这个内存值 → 不用重启软件。
        let bubbleChanged = false;
        if (body && typeof body.bubbleTranslateModel === 'string') {
          const wantModel = body.bubbleTranslateModel.trim();
          if (wantModel !== bubbleConfig.translateModel()) {
            cfg.bubble = cfg.bubble || {};
            cfg.bubble.translateModel = wantModel;
            bubbleConfig.set(wantModel);
            bubbleChanged = true;
            try {
              const cfgFile2 = require('./paths').configFile();
              const txt2 = fs.readFileSync(cfgFile2, 'utf8');
              const rb = configWrite.setScalar(txt2, ['bubble', 'translateModel'], wantModel);
              if (rb && rb.changed) fs.writeFileSync(cfgFile2, rb.text, 'utf8');
            } catch (e) { /* 写不进就只改内存 */ }
          }
        }

        // 「通用设置」：翻译词典用哪个 AI（v2.6.1148，默认 deepseek）
        let memModelChanged = false;
        if (body && typeof body.translationMemoryModel === 'string') {
          const wantModel = body.translationMemoryModel.trim();
          if (translationMemory.MEMORY_MODEL_CHOICES.includes(wantModel)
            && wantModel !== translationMemory.getMemoryModel()) {
            cfg.translation = cfg.translation || {};
            cfg.translation.memoryModel = wantModel;
            translationMemory.setMemoryModel(wantModel);
            memModelChanged = true;
            try {
              const cfgFile3 = require('./paths').configFile();
              const txt3 = fs.readFileSync(cfgFile3, 'utf8');
              const rb3 = configWrite.setScalar(txt3, ['translation', 'memoryModel'], wantModel);
              if (rb3 && rb3.changed) fs.writeFileSync(cfgFile3, rb3.text, 'utf8');
            } catch (e) { /* 写不进就只改内存 */ }
          }
        }

        // 「专项 AI」：扫描图片用哪家视觉模型（v2.6.1171，存的是服务商 key，'' = 跟随视觉任务默认）。
        // 只改这一个值；写进 cfg.scan 并同步内存里的 scanConfig，看图逻辑（media.js）每次取新的，不用重启。
        let scanChanged = false;
        if (body && typeof body.scanImageModel === 'string') {
          const wantModel = body.scanImageModel.trim();
          if (wantModel !== scanConfig.getImageModel()) {
            cfg.scan = cfg.scan || {};
            cfg.scan.imageModel = wantModel;
            scanConfig.set(wantModel);
            scanChanged = true;
            try {
              const cfgFile4 = require('./paths').configFile();
              const txt4 = fs.readFileSync(cfgFile4, 'utf8');
              const rb4 = configWrite.setScalar(txt4, ['scan', 'imageModel'], wantModel);
              if (rb4 && rb4.changed) fs.writeFileSync(cfgFile4, rb4.text, 'utf8');
            } catch (e) { /* 写不进就只改内存 */ }
          }
        }

        // 「专项 AI」：语音识别用哪家模型（v2.6.1188，存的是服务商 key，'' = 跟随语音任务默认）。
        let voiceChanged = false;
        if (body && typeof body.voiceModel === 'string') {
          const wantModel = body.voiceModel.trim();
          if (wantModel !== voiceConfig.getVoiceModel()) {
            cfg.scan = cfg.scan || {};
            cfg.scan.voiceModel = wantModel;
            voiceConfig.set(wantModel);
            voiceChanged = true;
            try {
              const cfgFile5 = require('./paths').configFile();
              const txt5 = fs.readFileSync(cfgFile5, 'utf8');
              const rb5 = configWrite.setScalar(txt5, ['scan', 'voiceModel'], wantModel);
              if (rb5 && rb5.changed) fs.writeFileSync(cfgFile5, rb5.text, 'utf8');
            } catch (e) { /* 写不进就只改内存 */ }
          }
        }

        const r = configWrite.saveAiConfig(patch, cfg);
        if (!r.ok) return json(res, 500, r);
        // 内存里的 cfg.ai 已被同步改好，这里把它交回给 ai（same object），立即生效
        ai.setAiConfig(cfg.ai);

        const snap = ai.providerSnapshot(configWrite.maskKey);
        snap.aiReady = ai.isReady('suggest');
        snap.aiReason = aiNotReadyReason();
        const changed = (r.changed || [])
          .concat(extractChanged ? ['app.extractInterval'] : [])
          .concat(bubbleChanged ? ['bubble.translateModel'] : [])
          .concat(memModelChanged ? ['translation.memoryModel'] : [])
          .concat(scanChanged ? ['scan.imageModel'] : [])
          .concat(voiceChanged ? ['scan.voiceModel'] : []);
        // AI 配置是「全局设置」那扇独立窗口改的，主窗口得跟着变（AI 状态灯 / 翻译徽章）。
        // 两扇窗是两个渲染进程，谁也不认识谁，所以由后端广播一声，主窗口收到自己重读。
        broadcast('data_changed', { what: 'ai_config' });
        return json(res, 200, { ok: true, changed, skipped: r.skipped, extractInterval: configWrite.clampExtractInterval(cfg.app?.extractInterval), bubbleTranslateModel: bubbleConfig.translateModel(), translationMemoryModel: translationMemory.getMemoryModel(), scanImageModel: scanConfig.getImageModel(), voiceModel: voiceConfig.getVoiceModel(), snapshot: snap });
      }

      // ---- AI 设置：真打一次最小的对话请求，验证 key / 地址 / 模型能不能通 ----
      // 允许带上界面里"还没保存"的 baseUrl / apiKey，这样用户填完就能直接测
      if (p === '/api/ai/test' && req.method === 'POST') {
        if (typeof ai.testProvider !== 'function') return json(res, 501, { error: '当前模式不支持连接测试' });
        const body = await readJsonBody(req);
        const override = {};
        if (typeof body?.baseUrl === 'string' && body.baseUrl.trim()) override.baseUrl = body.baseUrl.trim();
        if (typeof body?.apiKey === 'string' && body.apiKey.trim() && !body.apiKey.includes('•')) {
          override.apiKey = body.apiKey.trim();
        }
        const r = await ai.testProvider(String(body?.provider || '').trim(), body?.model, override);
        return json(res, 200, r);
      }

      // ---- 🔴 2026-10-23 第6模块「人设对话」：独立 AI 聊天，钱多多 / AstrBot 双模型 + web_search ----
      //     不碰 WA/Tele/Signal 任何采集/话术逻辑；对话不入客户库、不进 translation_memory，只回文本。
      if (p === '/api/persona/chat' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const provider = String(body?.provider || 'qianduoduo').trim();
        const allowed = ['qianduoduo', 'astrbot'];
        if (!allowed.includes(provider)) return json(res, 400, { error: '不支持的模型：' + provider });
        if (typeof ai.providerReady === 'function' && !ai.providerReady(provider)) {
          const why = (ai.notConfiguredReason && ai.notConfiguredReason(provider)) || '请在 AI 设置里配置';
          return json(res, 400, { error: '「' + provider + '」未配置或不可用：' + why });
        }
        const prov = (cfg?.ai?.providers && cfg.ai.providers[provider]) || {};
        const model = String(prov.model || body?.model || '').trim();
        if (!model) return json(res, 400, { error: '「' + provider + '」未设置模型名，请在 AI 设置里填好' });
        const msgs = Array.isArray(body?.messages) ? body.messages : [];
        if (!msgs.length) return json(res, 400, { error: '没有消息内容' });
        const webSearch = !!body?.webSearch;
        const PERSONA = '你是林晚秋（英文名 Sherry），中国美术学院油画系出身、常驻厦门的女性画家，擅长宠物画与肖像画定制。'
          + '你说话真诚、温柔、有朋友感，不推销、不夸大、不编故事、不谈恋爱。'
          + '客户聊油画、宠物画、肖像画、价格或只是闲聊，你都自然回应；涉及价格和工期只给区间、不承诺死。'
          + (webSearch ? ' 如需要最新信息（如参考图、行情），可自行联网搜索后回答，并尽量给出带图的参考。' : '');
        const userText = msgs.map((m) => ((m.role === 'user' ? '客户' : '你') + '：' + (m.content || ''))).join('\n');
        try {
          // 🔴 web_search：先 A 打底（用模型自带联网，上面已写进 system）；
          //    B 口子预留：将来要"带图更稳"时，在此先调搜索接口、把结果拼进 userText 再发，不另接服务。
          const reply = await ai.callProviderByName(provider, model, {
            system: PERSONA,
            user: userText,
            temperature: 0.8,
            maxTokens: 1200,
            timeout: 60000,
          });
          if (!reply) {
            const detail = (typeof ai.lastError === 'function' && ai.lastError(provider)) || '';
            return json(res, 502, { error: 'AI 没有返回正文' + (detail ? ('：' + detail) : '') });
          }
          return json(res, 200, { reply: String(reply) });
        } catch (e) {
          return json(res, 502, { error: 'AI 调用失败：' + ((e && e.message) || e) });
        }
      }

      // ---- 打开某个账号的 WhatsApp 浏览器（没开就启动，开了就拉到前台）----
      const mAccOpen = /^\/api\/account\/(\d+)\/open$/.exec(p);
      if (mAccOpen && req.method === 'POST') {
        if (!deps.openAccount) return json(res, 501, { error: '当前模式不支持打开浏览器' });
        const r = await deps.openAccount(Number(mAccOpen[1]));
        return json(res, r.ok === false ? 500 : 200, r);
      }

      // ---- 🔴 v2.6.1113顶栏「T①/T②」按钮专用（老板 17:31 报「按钮不见了」）
      //     走telegramRead 的单例锁，一个号最多一个 Chrome，重复点也只会拉前台不会新开。 ----
      const mTgOpen = /^\/api\/telegram\/account\/(\d+)\/open$/.exec(p);
      if (mTgOpen && req.method === 'POST') {
        if (!deps.openTelegramAccount) return json(res, 501, { error: '当前模式不支持打开 Telegram 浏览器' });
        const r = await deps.openTelegramAccount(Number(mTgOpen[1]));
        return json(res, r.ok === false ? 500 : 200, r);
      }

      // ---- 启动器：S1~S3（Signal 三开） 启停 ----
      // 🔴 只接受白名单 id（s1~s3），launcher 模块内部已强制校验，
      //    绝不接收客户端任意路径，防命令注入。
      // 🔴 v2.5.1034：启停后**异步**刷新一次状态再返回。
      //    因为状态现在是"后台刷新 + 只读缓存"，不刷新的话前端紧接着调 refreshState
      //    会读到启停前的旧值（灯不变色）。await 是异步等，不卡主线程。
      const mLunchStart = /^\/api\/launcher\/([a-z]\d)\/start$/.exec(p);
      if (mLunchStart && req.method === 'POST') {
        if (!deps.launcher) return json(res, 501, { error: '当前模式不支持启动器' });
        const r = deps.launcher.startLauncher(mLunchStart[1]);
        if (typeof deps.launcher.refreshNow === 'function') {
          await deps.launcher.refreshNow().catch(() => {});
        }
        return json(res, r.ok === false ? 500 : 200, r);
      }
      const mLunchStop = /^\/api\/launcher\/([a-z]\d)\/stop$/.exec(p);
      if (mLunchStop && req.method === 'POST') {
        if (!deps.launcher) return json(res, 501, { error: '当前模式不支持启动器' });
        const r = deps.launcher.stopLauncher(mLunchStop[1]);
        if (typeof deps.launcher.refreshNow === 'function') {
          await deps.launcher.refreshNow().catch(() => {});
        }
        return json(res, r.ok === false ? 500 : 200, r);
      }

      // 左栏顶部「今日消息」提示窗：今天收到多少 / 处理多少 / 还等你多少 + 按账号拆
      if (p === '/api/stats/today') {
        const d = typeof db.statsToday === 'function' ? db.statsToday() : null;
        return json(res, 200, d || { date: '', received: 0, handled: 0, todo: 0, sent: 0, byAccount: {} });
      }

      // 左栏「今日消息」实时收件箱（v2.5.1084）：今天跨客户消息列表，前端直接列出内容
      if (p === '/api/messages/today') {
        const rows = typeof db.todayMessages === 'function' ? db.todayMessages(200) : [];
        const d = typeof db.statsToday === 'function' ? db.statsToday() : null;
        return json(res, 200, { date: d ? d.date : '', messages: rows });
      }

      // Tele① 应用版（v2.5.1085）：原生会话列表 + 某客户消息流，数据来自库（MTProto 已落库）
      if (p === '/api/telegram/conversations') {
        const rows = typeof db.tgConversations === 'function' ? db.tgConversations(50) : [];
        return json(res, 200, { ok: true, conversations: rows });
      }
      if (p === '/api/telegram/messages') {
        const code = url.searchParams.get('customer') || '';
        const rows = code && typeof db.tgMessages === 'function' ? db.tgMessages(code, 200) : [];
        /* 🔴 v2.6.1194：这条路由**不走** withTranslationState（它只捞 telegram 消息），
         *   但前端重载版 renderTgChat(rows) 正是读它 → 乱码标记必须在这里也补上，
         *   否则两处 renderTgChat 会对同一条消息给出不一致的显示。
         *   判据与 withTranslationState 里那行**同一个函数**，规则仍然只有一份。 */
        return json(res, 200, {
          ok: true,
          customer: code,
          messages: rows.map((m) => ({ ...m, tgGarbled: telegramMerge.isGarbledText(m.body) })),
        });
      }

      // ---- v2.5.1087：Tele① 回复框「真正发送」（方案B）----
      // 只响应操作员在对话栏点击「发送」的显式请求；后端绝不自动外发。
      // 文本走 client.sendMessage，图片/视频走 client.sendFile（file=Buffer）。
      // ⚠️ 媒体以 base64 入参，受 JSON body 体积限制，超大视频建议走外部发。
      if (p === '/api/telegram/send' && req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => ({}));
        const code = (body && body.code) || '';
        if (!code) return json(res, 400, { ok: false, error: '缺少客户编号 code' });
        const peer = (typeof db.tgPeerByCode === 'function') ? db.tgPeerByCode(code) : null;
        if (!peer || !peer.chatKey) return json(res, 404, { ok: false, error: '找不到该客户的 Telegram 会话（需先采到过消息）' });
        const text = (body.text || '').toString();
        const caption = (body.caption || '').toString();
        let file = null;
        if (body.mediaBase64) {
          try { file = Buffer.from(String(body.mediaBase64), 'base64'); } catch (e) { file = null; }
        }
        if (!text && !file) return json(res, 400, { ok: false, error: '文本和媒体不能同时为空' });

        /* 🔴 Telegram 发送通道：单线 MTProto 官方直连（2026-10-13 起 A/B 双版本已取消）。
         * 没连接就明确报错，绝不退回网页。下面的 else 分支已成死代码（IS_B 恒 false），
         * 保留是为了不牵连其他逻辑，以后要恢复网页版把 IS_B 改回 true 即可。 */
        let r;
        if (telegramChannel.IS_A) {
          r = telegramOfficialChannel
            ? await telegramOfficialChannel.sendToPeer(peer.accountId, peer.chatKey, {
                text, caption, file, fileName: (body.mediaName || 'file'), replyTo: body.replyTo || null,
              })
            : { ok: false, error: 'Telegram 官方直连模块缺失（安装包异常，请重新安装）' };
        } else {
          r = telegramWebView
            ? await telegramWebView.sendViaWeb(peer.chatKey, {
                text, caption, mediaBuffer: file, mediaName: (body.mediaName || 'file'),
              })
            : { ok: false, error: 'Telegram 网页读取模块缺失（安装包异常，请重新安装）' };
        }
        if (r && r.ok) return json(res, 200, { ok: true, id: (r && r.id) || null, via: (r && r.via) || telegramChannel.CHANNEL });
        return json(res, 502, {
          ok: false,
          error: (r && r.error)
            || (telegramChannel.IS_A
              ? 'Telegram 发送失败：请确认该 Telegram 账号已登录成功'
              : 'Telegram 发送失败：请确认中栏「Tele①」里的 Telegram 网页已登录并打开'),
        });
      }

      /* 🔴 v2.6.1094 老板看图要求（QQ20261013-141311.png）：Tele① 资料卡上那个
         「↗ 跳到聊天」按钮 —— 让内置浏览器打开这个客户的对话并滚到最新。
         ⚠️ **只读**：只改 location.hash 打开会话 + 滚到底，绝不发任何消息（铁律不变）。 */
      if (p === '/api/telegram/jump' && req.method === 'POST') {
        if (!telegramWebView || typeof telegramWebView.jumpViaWeb !== 'function') {
          return json(res, 501, { ok: false, error: '本版未启用内置浏览器读取模块' });
        }
        const code = url.searchParams.get('customer') || '';
        if (!code) return json(res, 400, { ok: false, error: '缺少客户编号 customer' });
        const peer = (typeof db.tgPeerByCode === 'function') ? db.tgPeerByCode(code) : null;
        if (!peer || !peer.chatKey) {
          return json(res, 404, { ok: false, error: '找不到该客户的 Telegram 会话（需先采到过消息）' });
        }
        const r = await telegramWebView.jumpViaWeb(peer.chatKey).catch((e) => ({
          ok: false, error: String((e && e.message) || e),
        }));
        return json(res, 200, {
          ok: !!(r && r.ok),
          chatKey: String(peer.chatKey),
          reason: (r && (r.error || r.reason)) || '',
        });
      }

      // ══════════════ WA①（WhatsApp 内置浏览器）· v2.6.1094 ══════════════
      // 🔴 这一整块只做**只读导航**：把 WA① 网页打开某个客户的对话。
      //    绝不发送任何消息、绝不点任何发送按钮（老板铁律：内置浏览器只看不代发）。
      if (p === '/api/whatsapp/jump' && req.method === 'POST') {
        if (!whatsappWebView || typeof whatsappWebView.jumpViaWeb !== 'function') {
          return json(res, 501, { ok: false, error: '本版未启用 WA① 内置浏览器模块' });
        }
        const code = url.searchParams.get('customer') || '';
        if (!code) return json(res, 400, { ok: false, error: '缺少客户编号 customer' });
        // 拿客户名和电话：号码最准（会话列表里带号码），没有就退回名字
        let needle = '';
        try {
          const c = (typeof db.getCustomer === 'function') ? db.getCustomer(code) : null;
          const phone = c && String(c.phone || '').replace(/[^\d]/g, '');
          needle = phone || (c && (c.name || '')) || code;
        } catch (_) { needle = code; }
        const r = await whatsappWebView.jumpViaWeb(needle).catch((e) => ({
          ok: false, error: String((e && e.message) || e),
        }));
        return json(res, 200, { ok: !!(r && r.ok), reason: (r && (r.error || r.reason)) || '' });
      }

      // WA① 只读诊断：把 WA① 现在打开了哪些页面列出来（老板排障用）
      if (p === '/api/whatsapp/pages' && req.method === 'GET') {
        if (!whatsappWebView || typeof whatsappWebView.listPages !== 'function') {
          return json(res, 501, { ok: false, error: '本版未启用 WA① 内置浏览器模块' });
        }
        return json(res, 200, whatsappWebView.listPages());
      }

      // ══════════════ WA①（内置浏览器）采集 · 状态与探测 · v2.6.1121 ══════════════
      // 🔴 这两条**只读**：不触发采集、不改任何数据。
      //    state 给界面画状态条（启动时拉一次 + 每 5 秒兜底，实时走 whatsapp_status 事件）；
      //    probe 给老板排障：一次性把内部 Store 读出来看看有什么（带样本，不整份倒）。
      if (p === '/api/whatsapp/read/state' && req.method === 'GET') {
        if (!whatsappRead || typeof whatsappRead.state !== 'function') {
          return json(res, 501, { ok: false, error: '本版未启用 WA① 采集模块' });
        }
        // 🔴 v2.6.1134：按 ?account= 路由到对应 WA①~⑤ 实例（10~14）；缺省回退 WA①
        const accId = Number(url.searchParams.get('account')) || ids.ACC_WA_EMBEDDED;
        const key = 'wa' + (accId - ids.ACC_WA_EMBEDDED + 1);
        const inst = (whatsappRead.getInstance && whatsappRead.getInstance(key)) || whatsappRead;
        const st = inst.state();
        const d = inst.describe(st);
        return json(res, 200, Object.assign({ ok: true, account: (inst.accId || accId), channel: (inst.channel || whatsappRead.CHANNEL) }, st, d));
      }
      if (p === '/api/whatsapp/read/probe' && req.method === 'GET') {
        if (!whatsappRead || typeof whatsappRead.probe !== 'function') {
          return json(res, 501, { ok: false, error: '本版未启用 WA① 采集模块' });
        }
        const r = await whatsappRead.probe().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        return json(res, 200, r);
      }

      // ---- WA① 中文译文气泡（v2.6.1121）：状态 + 只读排障 ----
      //   只贴已翻好的中文，**绝不在这里现翻**；整条链路连 AI 都不调。
      if (p === '/api/whatsapp/bubble/state' && req.method === 'GET') {
        // 🔴 v2.6.1134：按 ?account= 路由到对应 WA①~⑤ 实例
        const accId = Number(url.searchParams.get('account')) || (waBubble.ACC_ID || ids.ACC_WA_EMBEDDED);
        const key = 'wa' + (accId - ids.ACC_WA_EMBEDDED + 1);
        const inst = (waBubble.getInstance && waBubble.getInstance(key)) || waBubble;
        const st = inst.state();
        return json(res, 200, Object.assign({ ok: true }, st, { text: inst.describe(st) }));
      }
      if (p === '/api/whatsapp/bubble/probe' && req.method === 'GET') {
        const r = await waBubble.probe().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        return json(res, 200, r);
      }
      // 🔴 v2.6.1127 老板要的「↻ 补气泡」按钮：按消息编号重贴 + 补翻库里没翻的
      if (p === '/api/whatsapp/bubble/repaint' && req.method === 'POST') {
        if (!waBubble || typeof waBubble.forceRepaint !== 'function') {
          return json(res, 501, { ok: false, error: '气泡模块未就绪' });
        }
        // 🔴 v2.6.1134：按 ?account= 路由到对应 WA①~⑤ 实例（只补翻 / 重贴那一个账号的气泡）
        const accId = Number(url.searchParams.get('account')) || (waBubble.ACC_ID || ids.ACC_WA_EMBEDDED);
        const key = 'wa' + (accId - ids.ACC_WA_EMBEDDED + 1);
        const inst = (waBubble.getInstance && waBubble.getInstance(key)) || waBubble;
        // ① 把该实例在库里「还没翻译」的外文消息补翻一遍（有 AI key 才有效，没 key 只是没得翻，绝不假装成功）
        let backfilled = 0;
        try {
          const all = (typeof db.listCustomers === 'function') ? db.listCustomers.all() : [];
          const codes = (all || [])
            .filter((c) => c.account_id === inst.accId)
            .map((c) => String(c.code || ''))
            .filter(Boolean);
          for (const code of codes) {
            try { backfilled += translator.backfill(code, null, 12); } catch (e) { /* 单客户失败不影响别的 */ }
          }
        } catch (e) { /* 翻译回填失败不影响气泡重贴 */ }
        // ② 立刻按消息编号重新匹配并重贴气泡（emoji 差异免疫）
        const st = await inst.forceRepaint().catch((e) => ({ status: 'error', error: String((e && e.message) || e) }));
        return json(res, 200, Object.assign({ ok: true, backfilled: backfilled || 0 }, st, { text: inst.describe(st) }));
      }

      // ---- 跨消息翻译记忆（v2.6.1122）：只读统计 ----
      //   记住了多少句、一共省了多少次 AI 调用、被复用得最多的几句。
      //   纯读，一个字节都不写。
      if (p === '/api/translate/memory' && req.method === 'GET') {
        return json(res, 200, Object.assign({ ok: true }, translationMemory.stats()));
      }

      // ══════════════ WA① 建档（编号走 WA 段）· v2.6.1095 ══════════════
      // 🔴 老板定调：「WA① 不要跟一号一样，当成六号 / 另一个数据文件夹」。
      //    WA① 是**软件内置浏览器内核**，一号~五号是**软件外独立 Chrome**，
      //    所以 WA① 的客户编号落在独立的 **WA00001** 段（account_id=10），
      //    绝不再和一号共用 1A 段 —— 否则两边建的档案分不清是谁的。
      //    号码仍走 db.getOrCreateCustomer → phoneOwnerOf 查重门，绝不重复入库。
      if (p === '/api/whatsapp/upsert' && req.method === 'POST') {
        if (typeof db.getOrCreateCustomer !== 'function') {
          return json(res, 501, { ok: false, error: '数据库模块未就绪' });
        }
        const code = url.searchParams.get('customer') || '';
        if (!code) return json(res, 400, { ok: false, error: '缺少客户编号 customer' });
        try {
          const c = db.getCustomer(code);
          if (!c) return json(res, 404, { ok: false, error: `找不到客户 ${code}` });
          // 🔴 只读：这里**只**返回这个客户该用哪个 WA 段编号，不改任何库
          // 🔴 v2.6.1134：按 ?account= 路由到对应 WA①~⑤ 的编号段（10~14）
          const accId = Number(url.searchParams.get('account')) || ids.ACC_WA_EMBEDDED;
          const waCode = ids.nextCustomerCode(accId, null);
          return json(res, 200, {
            ok: true,
            source: code,
            waAccountId: accId,
            waPrefixSample: waCode,
            phone: c.phone || '',
            name: c.name || '',
            // 如实回报号码是否已被别的客户占用（老板要「先查重再存」）
            phoneOwner: c.phone && typeof db.phoneOwnerOf === 'function'
              ? db.phoneOwnerOf(c.phone, c.code) : '',
          });
        } catch (e) {
          return json(res, 500, { ok: false, error: String((e && e.message) || e) });
        }
      }

      // v2.5.1088：中栏头像「查看客户资料」浮层数据源（Telegram 原生 User Info）
      // 实时取头像/名称/用户名/手机号/最后上线；取不到时回退库里存的名称 + @username（库里无手机号）。
      if (p === '/api/telegram/userinfo' && req.method === 'GET') {
        const code = url.searchParams.get('customer') || '';
        const light = url.searchParams.get('light') === '1';
        if (!code) return json(res, 400, { ok: false, error: '缺少客户编号 customer' });
        const peer = (typeof db.tgPeerByCode === 'function') ? db.tgPeerByCode(code) : null;
        if (!peer || !peer.chatKey) return json(res, 404, { ok: false, error: '找不到该客户的 Telegram 会话（需先采到过消息）' });
        /* 🔴 A / B 双通道分开：
         *单线 MTProto 官方直连取 user 的 phone/username/photo/status（能拿手机号）。
         * 网页端刮 user info 那条路（telegramWebView）已成死代码，保留不删。 */
        let info = null;
        if (telegramChannel.IS_A) {
          try {
            info = telegramOfficialChannel
              ? await telegramOfficialChannel.getUserProfile(peer.accountId, peer.chatKey)
              : null;
          } catch (e) { info = null; }
        } else if (!light && telegramWebView && typeof telegramWebView.getUserProfileViaWeb === 'function') {
          try { info = await telegramWebView.getUserProfileViaWeb(peer.chatKey); } catch (e) { info = null; }
        }
        if (!info || !info.ok) {
          const c = (typeof db.getCustomer === 'function') ? db.getCustomer.get(code) : null;
          return json(res, 200, {
            ok: true, fallback: true,
            name: c ? (c.name || '') : '',
            username: c ? (c.tg_username || c.username || '') : '',
            phone: '', lastSeen: '', photoDataUrl: '',
            hint: telegramChannel.IS_B ? '网页端取不到手机号（手机号只有 MTProto 官方通道能取到）' : '',
          });
        }
        return json(res, 200, { ok: true, fallback: false, ...info });
      }

      if (p === '/api/customers') {
        const rows = listCustomersStmt.all();
        const only = url.searchParams.get('only');
        return json(res, 200, rows.filter((r) => {
          if (only === 'pending') return r.pending === 1;
          if (only === 'unread') return (r.unread || 0) > 0;
          return true;
        }));
      }

      const mCustomer = /^\/api\/customer\/([A-Z0-9]+)$/.exec(p);
      if (mCustomer) {
        const code = mCustomer[1];
        const customer = db.getCustomer.get(code);
        if (!customer) return json(res, 404, { error: '客户不存在' });
        // 档案文件可能"住在"另一个编号名下（同一个电话号码被重复建档、已合并过），
        // 所以路径按【保留的那份编号】去找，否则弹窗标题会空着。
        const canonDoc = docDedup.canonicalOf(code) || code;
        return json(res, 200, {
          customer,
          // 按「地区」推出来的时区（IANA）。时区栏填了数字时，timezone 存的是那个数字，
          // 界面要显示/兜底"按地区算是几点"就得靠这个字段（2026-09-30）。
          autoTimezone: doc.guessTimezone ? (doc.guessTimezone(customer.region) || null) : null,
          messages: db.listMessages.all(code).map(withTranslationState),
          duplicates: db.findPossibleDuplicates(code),
          docFile: doc.findExistingDoc(canonDoc),
          docCanonical: canonDoc,
          docMergedCodes: docDedup.mergedCodesOf(canonDoc),
          // 最新一条对话是不是我发的 → 界面据此决定「✓ 标记已回复」亮不亮
          repliedLast: typeof db.repliedLast === 'function' ? db.repliedLast(code) : false,
          // 还有几条没翻（界面据此决定要不要自动补翻 / 提示 AI 没配）
          untranslated: translator.untranslatedCount(code),
          // 还有几张图片/几条语音没出中文说明（后台补看用）
          mediaPending: media.pendingCount(code),
          translateError: translator.errorOf(code),
          mediaError: media.errorOf(code),
        });
      }

      /* ============ 右栏「对话翻译」：从最新一条往回取 N 条（v2.5.1056） ============
         老板要求：点开客户自动翻译，**从最新一条往回最多 20 条**；
         「翻译过的不翻译」——已经翻好的（body_zh 有值）直接读档显示，不再调 AI。
         这里只负责**取数据**（含译文与翻译态），真正排队翻译走下面那个 /translate 接口。 */
      const mConv = /^\/api\/customer\/([A-Z0-9]+)\/conversation$/.exec(p);
      if (mConv && req.method === 'GET') {
        const code = mConv[1];
        const customer = db.getCustomer.get(code);
        if (!customer) return json(res, 404, { error: '客户不存在' });
        const q = new URL(req.url, 'http://x').searchParams;
        const limit = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 50);
        // recentMessages 是 DESC（最新在前），往回取 limit 条后再翻回正序，界面从上往下读才顺
        const rows = db.recentMessages.all(code, limit).reverse();
        return json(res, 200, {
          code,
          name: customer.name || '',
          limit,
          messages: rows.map(withTranslationState),
          // 还有几条没翻（界面拿它决定要不要显示「补翻」按钮）
          untranslated: translator.untranslatedCount(code),
          translating: translator.translatingIds(),
          aiReady: ai.isReady('translate'),
        });
      }

      /* ============ Tele① 页面「脏检查」指纹（v2.5.1059，思路来自 wa-split 样品 PROBE_CODE）============
         返回 Telegram 页面此刻的指纹：会话标题 + hash + 气泡数 + 已贴译文数 + 未读总数。
         前端拿它当闸门：**指纹没变 = 页面没动 = 这一轮一趟都不跑**（不再每 15 秒无脑重贴）；
         指纹变了 = 切了对话 / 来了新消息 / 译文被 Telegram 重绘冲掉了 → 才真去重拉重贴。
         只读，不写库，不动页面任何节点。 */
      const mTgKey = /^\/api\/telegram\/pagekey$/.exec(p);
      if (mTgKey && req.method === 'GET') {
        if (!telegramWebView) return json(res, 501, { ok: false, error: '本版未启用内置浏览器读取模块' });
        const k = await telegramWebView.pageKey().catch((e) => ({
          ok: false, found: false, reason: String((e && e.message) || e),
        }));
        return json(res, 200, k);
      }

      /* ============ Tele①「Telegram 翻译」面板数据源（2026-10-11 老板看图纠正位置后新增）============
         老板原话（配 QQ20261011-232614.png 红框）：翻译要放在 Telegram 网页那块区域的右边，
         而且「这个翻译是针对 telegram」。
         所以这里**按 Telegram 自己的页面状态**决定翻谁，不靠我在软件里点开了谁：
           ① 问 telegramWebView：列表最下面那个对话的最新一条是不是我自己发的 → 是就往上找；
           ② 拿到 peer（跟采集侧一样用 Telegram 的对话 id）→ 反查 customers 表里的客户档案；
           ③ 再走跟右栏同一个「从最新一条往回 20 条」的取数逻辑。
         「翻译过的不翻译 / 读档不翻译」照旧：有 body_zh 的直接用，不重复烧 token。 */
      const mTgConv = /^\/api\/telegram\/conversation$/.exec(p);
      if (mTgConv && req.method === 'GET') {
        if (!telegramWebView) return json(res, 501, { ok: false, error: '本版未启用内置浏览器读取模块' });
        const q = new URL(req.url, 'http://x').searchParams;
        const limit = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 50);
        const cur = await telegramWebView.currentConversation().catch((e) => ({
          ok: false, found: false, reason: String((e && e.message) || e),
        }));
        if (!cur || !cur.found) {
          return json(res, 200, {
            ok: false, needPeer: true, limit, messages: [],
            reason: (cur && cur.reason) || '拿不到 Telegram 页面状态',
          });
        }
        const peer = cur.pick && cur.pick.peer;
        if (!peer) {
          return json(res, 200, {
            ok: false, needPeer: true, limit, messages: [],
            reason: 'Telegram 侧边栏里还没读到任何对话',
          });
        }
        // 采集侧入库时用的是 telegramWebView.ACCOUNT_ID（Telegram 账号组第一个 = 7），
        // wa_jid 固定是 `tg:<peerId>`（见 telegramRead.toMessage 的 displayJid）。
        // 这里就用它反查客户档案，跟采集侧完全同一个口径；查不到 = 这个对话的消息还没采进来。
        const row = db.findCustomerByTgPeer
          ? db.findCustomerByTgPeer.get(telegramWebView.ACCOUNT_ID, `tg:${peer}`, 'telegram')
          : null;
        if (!row) {
          return json(res, 200, {
            ok: false, needPeer: true, limit, messages: [],
            peer, title: (cur.pick && cur.pick.title) || '',
            reason: `Telegram 当前这个对话（${(cur.pick && cur.pick.title) || peer}）的消息还没采进来 —— 在 Tele① 里点开它，等 5 秒，软件会自动读走。`,
          });
        }
        /* 老板 2026-10-12 定的第三件事：一轮最多新翻 10 条。
           思路照抄 wa-split 样品的 `missIdx.slice(-10)`：最新的 10 条先出中文，
           更老的留给下一轮 —— 防止一进对话就把整段历史的钱一次性烧掉。
           ⚠️ 注意样品那段代码有个 bug（用了没定义的 `take` 变量，ReferenceError 被吞），
              这里没有照抄它的写法，只照抄它的**限流思路**。
           backfill=0（默认）= 这轮只贴已经翻好的、不新翻（开关关着时用）。 */
        const bf = Math.min(Math.max(Number(q.get('backfill')) || 0, 0), 50);
        let queued = 0;
        if (bf > 0 && ai.isReady('translate')) {
          queued = translator.backfill(row.code, (r) => {
            broadcast('translated', r);
            if (r && r.bodyZh) refreshDoc(row.code);
          }, bf);
        }
        const rows = db.recentMessages.all(row.code, limit).reverse();
        // 老板选的方案 B：翻译完还要**贴到 Telegram 每条气泡下方**。
        // 气泡上的 data-mid 就是采集侧存进库的 msgId（telegramRead.toMessage），
        // 所以这里把 mid 一起带出来，前端拿去调 /api/telegram/paint。
        const messages = rows.map((m) => {
          const st = withTranslationState(m);
          // withTranslationState 里已经按「第一个冒号」切好了 mid；
          // 这里再确认一遍确实属于当前这个对话（防止同一个 msgId 撞到别的对话）
          if (peer && String(m.wa_msg_id || '').startsWith(`${peer}:`)) {
            st.mid = String(m.wa_msg_id).slice(peer.length + 1);
          }
          return st;
        });
        return json(res, 200, {
          ok: true,
          code: row.code,
          name: row.name || (cur.pick && cur.pick.title) || '',
          peer,
          title: (cur.pick && cur.pick.title) || row.name || '',
          why: (cur.pick && cur.pick.why) || '',
          openTitle: cur.openTitle || '',
          limit,
          messages,
          untranslated: translator.untranslatedCount(row.code),
          translating: translator.translatingIds(),
          aiReady: ai.isReady('translate'),
          queued,
        });
      }

      /* ============ 把译文贴到 Telegram 气泡下方（2026-10-11 老板选的方案 B）============
         前端把 [{mid, zh}] 发过来，主进程往内置浏览器的页面里塞自绘的译文块。
         **同一时刻只贴当前这个对话的**，切对话时前端会先 /api/telegram/unpaint 清一遍，
         免得两个对话的译文混在一起。铁律：只加文字，绝不改 Telegram 的消息内容、绝不发送。 */
      const mTgPaint = /^\/api\/telegram\/(paint|unpaint)$/.exec(p);
      if (mTgPaint && req.method === 'POST') {
        if (!telegramWebView) return json(res, 501, { ok: false, error: '本版未启用内置浏览器读取模块' });
        if (mTgPaint[1] === 'unpaint') {
          const r = await telegramWebView.clearBubbles().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
          return json(res, 200, r);
        }
        const body = await readJsonBody(req).catch(() => ({}));
        const rows = Array.isArray(body && body.rows) ? body.rows.slice(0, 60) : [];
        if (!rows.length) return json(res, 200, { ok: true, painted: 0 });
        const r = await telegramWebView.paintBubbles(rows).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        return json(res, 200, r);
      }

      /* ============ 跳转到真实聊天窗口（2026-10-11 用户需求） ============
         左栏看到新消息 → 点进对话 → 点「跳到聊天」→ 后端把对应 IM 窗口拉到最前并定位到该客户。
         WhatsApp 走 openChatByJid（零刷新置顶会话）；Telegram 走搜索框定位；Signal 本版不支持。 */
      const mJump = /^\/api\/customer\/([A-Z0-9]+)\/jump$/.exec(p);
      if (mJump && req.method === 'POST') {
        const code = mJump[1];
        if (typeof deps.jumpToChat !== 'function') {
          return json(res, 501, { ok: false, reason: '当前模式不支持跳转' });
        }
        try {
          const r = await deps.jumpToChat(code);
          return json(res, 200, { ok: !!r.ok, ...r });
        } catch (e) {
          return json(res, 500, { ok: false, reason: 'jump-failed', error: e && e.message });
        }
      }

      /* ============ 窗口化取消息（2026-09-30 方案 C） ============
         前端默认只渲染最近 N 条；滚到顶时 ?before=<最老可见id> 取更早一批往前插；
         ?after=<最新可见id> 取更新一批往后插。返回 {messages:[带翻译态], hasMore}。 */
      const mMsgs = /^\/api\/customer\/([A-Z0-9]+)\/messages$/.exec(p);
      if (mMsgs && req.method === 'GET') {
        const code = mMsgs[1];
        if (!db.getCustomer.get(code)) return json(res, 404, { error: '客户不存在' });
        const u = new URL(req.url, 'http://localhost');
        const before = Number(u.searchParams.get('before')) || 0;
        const after = Number(u.searchParams.get('after')) || 0;
        const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 50, 1), 100);
        let rows = [];
        let hasMore = false;
        if (before) {
          rows = db.messagesBefore.all(code, before, limit).reverse(); // DESC→ASC
          const oldest = rows.length ? rows[0].id : before;
          hasMore = (db.countMessagesBefore.get(code, oldest)?.n || 0) > 0;
        } else if (after) {
          rows = db.messagesAfter.all(code, after, limit);
          const newest = rows.length ? rows[rows.length - 1].id : after;
          hasMore = (db.countMessagesAfter.get(code, newest)?.n || 0) > 0;
        } else {
          rows = db.recentMessages.all(code, limit).reverse(); // 最新在前 → 翻成 ASC
        }
        return json(res, 200, { messages: rows.map(withTranslationState), hasMore });
      }

      /* ============ 云端（wa-cloud）· 登录与同步 ============ */
      /* 说明：软件对云端【主数据】只有 GET；所有书架操作都进「自己编号的仓库」。 */

      if (p === '/api/cloud/status' && req.method === 'GET') {
        return json(res, 200, { ok: true, ...cloud.status() });
      }

      if (p === '/api/cloud/login' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const r = await cloud.login({
            code: body.code,
            password: body.password,
          });
          /*
           * 🔴 启动顺序铁律（v2.5.1035 · 老板拍板）：登录**只做登录**，不再顺手同步。
           *
           *    旧版在这里 await cloud.syncMaster() —— 登录按钮按下后要先把云端数据
           *    整趟拉完才返回，网络一慢按钮就像卡住了。
           *
           *    现在数据同步挪到 POST /api/boot/sync，由前端走完登录这一步之后
           *    单独推进（真实进度条那一段），各步骤可见、可控。
           */
          broadcast('cloud', { event: 'login', operator: r.operator });
          broadcast('data_changed', {});
          // 🔴 v2.6.1127 共享翻译记忆：登录成功后非阻塞把后台共享字典拉回本地（只补空缺）。
          //   失败静默，绝不影响登录本身。后台 pull/push 同步本身不受 config.yaml 开关控制。
          try { require('./tmCloud').syncOnLogin(); } catch (e) { /* 拉取失败不影响登录 */ }
          return json(res, 200, {
            ok: true, operator: r.operator,
            masterCount: 0,   // 同步已挪到 /api/boot/sync，这里不再返回数量
            ...cloud.status(),
          });
        } catch (e) {
          // 编号被别人占用：err.busy = true，界面要弹「该编号已有人登录」
          return json(res, e.status === 409 ? 409 : 400, {
            ok: false, busy: !!e.busy, error: e.message || '登录失败',
            owner: (e.payload && e.payload.device) || '',
          });
        }
      }

      if (p === '/api/cloud/logout' && req.method === 'POST') {
        await cloud.logout(false);
        broadcast('cloud', { event: 'logout' });
        broadcast('data_changed', {});
        return json(res, 200, { ok: true, ...cloud.status() });
      }

      // 「同步话题」按钮：把云端的话术碎片 + 对话同步到本地。
      // 5 分钟冷却 —— 冷却里再点返回 ok:false + cooldownLeft，界面按钮置灰。
      if (p === '/api/cloud/sync' && req.method === 'POST') {
        try {
          const r = await cloud.manualSync();
          if (!r.ok) {
            return json(res, 200, { ok: false, cooldown: true, cooldownLeft: r.cooldownLeft, ...cloud.status() });
          }
          broadcast('data_changed', {});
          broadcast('cloud', { event: 'sync' });
          return json(res, 200, { ok: true, count: r.fragments, syncedAt: r.syncedAt, ...cloud.status() });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message || '同步失败', ...cloud.status() });
        }
      }

      // 「启动时同步」勾选框：勾上 → 下次开软件同步一次，同步完自动取消
      if (p === '/api/cloud/auto-sync' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const r = cloud.setAutoSync(!!body.on);
        broadcast('cloud', { event: 'sync_pref', autoSync: r.autoSync });
        return json(res, 200, { ok: true, ...cloud.status() });
      }

      /* 保存档案前查重复号：带 + 的号码会去云端问「有没有被别的编号登记过」 */
      if (p === '/api/cloud/check-phone' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!cloud.status().loggedIn) {
          return json(res, 200, { ok: true, conflict: false, owners: [], skipped: true });
        }
        try {
          const r = await cloud.checkPhone(body.phone, body.code || '');
          return json(res, 200, { ok: true, ...r });
        } catch (e) {
          // 云端问不到就别拦着人保存（宁可漏提示，不能不让存）
          return json(res, 200, { ok: true, conflict: false, owners: [], skipped: true, error: e.message || '' });
        }
      }

      /* ============ 集中托管 API key（D 方案 + 三项 A 默认） ============ */
      /* 桌面「同步 AI 设置」按钮走这里：
       *   mode=push（管理员）→ 把本地 AI 密钥密封后推上云端（云端只存密文）；
       *   mode=pull（会员）→ 从云端拉密文 → 解开 → 注入内存（云端为准）。 */

      if (p === '/api/ai/vault' && req.method === 'GET') {
        try { return json(res, 200, { ok: true, ...aiVault.vaultStatus() }); }
        catch (e) { return json(res, 200, { ok: true, hasLocalCache: false, providers: [] }); }
      }

      if (p === '/api/ai/sync' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const mode = (body && body.mode === 'push') ? 'push' : 'pull';
        if (!cloud.status().loggedIn) {
          return json(res, 200, { ok: false, error: '还没登录云端，无法同步 AI 设置' });
        }
        if (mode === 'push') {
          // 🔴 只有管理员能写密钥库（云端后端还会再拦一道 role !== 'admin'）
          const role = cloud.status().operator && cloud.status().operator.role;
          if (role !== 'admin') {
            return json(res, 403, { ok: false, error: '只有管理员能把 AI 设置保存到云端' });
          }
          try {
            const r = await aiVault.pushCurrent(cfg);
            return json(res, 200, { ok: !!r.ok, updatedAt: r.updatedAt || null, ...cloud.status() });
          } catch (e) {
            return json(res, 200, { ok: false, error: e.message || '保存到云端失败', ...cloud.status() });
          }
        }
        // pull：会员 / 任何登录者都能拉（云端只存密文，拉下来也只在本机解开用）
        try {
          const r = await aiVault.pullAndApply(cfg);
          if (!r.ok) {
            return json(res, 200, { ok: false, empty: true, error: '云端还没有保存过 AI 设置', ...cloud.status() });
          }
          broadcast('data_changed', { what: 'ai_config' });
          return json(res, 200, { ok: true, providers: r.providers, ...cloud.status() });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message || '同步失败', ...cloud.status() });
        }
      }

      /* ============ 常用话术库（主窗口右栏「话术库」页签） ============ */
      if (p === '/api/replies' && req.method === 'GET') {
        try {
          const r = await replyLibrary.getRepliesAsync();
          // 本机优先：先给界面数据，云端同步在后台另跑（/api/replies/sync）
          return json(res, 200, {
            ok: true, scenes: r.scenes, source: r.source, pending: r.pending || 0,
            canEdit: true, loggedIn: cloud.status().loggedIn,
          });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message || '读话术库失败', scenes: [] });
        }
      }
      if (p === '/api/replies/sync' && req.method === 'POST') {
        try {
          const r = await replyLibrary.syncAsync();
          return json(res, 200, {
            ok: true, scenes: r.scenes, source: 'cloud', pending: r.pending || 0, canEdit: true, loggedIn: true,
          });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message || '同步失败' });
        }
      }
      if (p === '/api/replies/scene' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try { return json(res, 200, { ok: true, source: 'local', pending: replyLibrary.pendingCount(), scenes: await replyLibrary.addSceneAsync(body.name) }); }
        catch (e) { return json(res, 200, { ok: false, error: e.message || '新增场景失败' }); }
      }
      const mRepScene = /^\/api\/replies\/scene\/([A-Za-z0-9_]+)$/.exec(p);
      if (mRepScene && req.method === 'PUT') {
        const body = await readJsonBody(req);
        try { return json(res, 200, { ok: true, source: 'local', pending: replyLibrary.pendingCount(), scenes: await replyLibrary.updateSceneAsync(mRepScene[1], body.name) }); }
        catch (e) { return json(res, 200, { ok: false, error: e.message || '保存失败' }); }
      }
      if (mRepScene && req.method === 'DELETE') {
        try { return json(res, 200, { ok: true, source: 'local', pending: replyLibrary.pendingCount(), scenes: await replyLibrary.deleteSceneAsync(mRepScene[1]) }); }
        catch (e) { return json(res, 200, { ok: false, error: e.message || '删除失败' }); }
      }
      const mRepText = /^\/api\/replies\/scene\/([A-Za-z0-9_]+)\/text$/.exec(p);
      if (mRepText && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          return json(res, 200, {
            ok: true, source: 'local', pending: replyLibrary.pendingCount(),
            scenes: await replyLibrary.addTextAsync(mRepText[1], body.tone, body.en, body.zh),
          });
        } catch (e) { return json(res, 200, { ok: false, error: e.message || '新增回复失败' }); }
      }
      const mRepTextId = /^\/api\/replies\/text\/([A-Za-z0-9_]+)$/.exec(p);
      if (mRepTextId && req.method === 'PUT') {
        const body = await readJsonBody(req);
        try { return json(res, 200, { ok: true, source: 'local', pending: replyLibrary.pendingCount(), scenes: await replyLibrary.updateTextAsync(mRepTextId[1], body) }); }
        catch (e) { return json(res, 200, { ok: false, error: e.message || '保存失败' }); }
      }
      if (mRepTextId && req.method === 'DELETE') {
        try {
          return json(res, 200, {
            ok: true, source: 'local', pending: replyLibrary.pendingCount(),
            scenes: await replyLibrary.deleteTextAsync(mRepTextId[1], url.searchParams.get('rid') || ''),
          });
        } catch (e) { return json(res, 200, { ok: false, error: e.message || '删除失败' }); }
      }

      const mUpdateStatus = /^\/api\/update\/status$/.exec(p);
      const mUpdateCheck = /^\/api\/update\/check$/.exec(p);
      const mUpdateInstall = /^\/api\/update\/install$/.exec(p);

      /* deps.update 是 src/update.js 整个模块（对象），判"在不在"看有没有方法 */
      const hasUpdater = () => Boolean(deps.update && typeof deps.update.status === 'function');

      /* ============ 软件更新（2026-10-07 v1.2.0）============
       *
       * 🔴 为什么走 HTTP 而不挂 preload：
       *   settings.html 那扇窗明写着「不挂 preload，保持最小权限」（electron/main.js:288）。
       *   更新功能是唯一需要桌面能力的页签，但它只在「点按钮」时动作，
       *   所以走本地 HTTP 完全够用 —— 不为了一个功能去破安全设置。
       *
       * deps.update 由 src/main.js 注入（未打包运行时不注入 → 501）。
       * 三个路由：
       *   GET  /api/update/status  当前版本 + 更新源配好没
       *   POST /api/update/check   检查并开始下载（带进度回调用 SSE 推，简化成轮询 status）
       *   POST /api/update/install 安装；busy=1（正在采集）时只提示不重启
       */
      if (mUpdateStatus && req.method === 'GET') {
        // 🔴 deps.update 注入的是 src/update.js **整个模块**（对象），
        //    不是单个函数 —— 所以判断"有没有"要看有没有 status 方法，
        //    写成 typeof deps.update !== 'function' 会永远判成不可用（返 501）。
        if (!hasUpdater()) {
          return json(res, 501, { ok: false, error: '当前模式不支持更新（要打成 exe 后才能用）' });
        }
        const st = deps.update.status();
        const last = typeof db.getLastVersion === 'function' ? db.getLastVersion('latest') : null;
        const hist = typeof db.listVersionHistory === 'function' ? db.listVersionHistory(10) : [];
        return json(res, 200, { ok: true, ...st, last, history: hist });
      }
      if (mUpdateCheck && req.method === 'POST') {
        if (!hasUpdater()) {
          return json(res, 501, { ok: false, error: '当前模式不支持更新（要打成 exe 后才能用）' });
        }
        // 立即返回，进度靠 /api/update/status 轮询（这里不阻塞到下载完）
        deps.update.check({ silent: true }).catch(() => { /* 事件里已广播 */ });
        return json(res, 200, { ok: true, text: '已开始检查更新…' });
      }
      if (mUpdateInstall && req.method === 'POST') {
        if (!hasUpdater()) {
          return json(res, 501, { ok: false, error: '当前模式不支持更新（要打成 exe 后才能用）' });
        }
        const body = await readJsonBody(req);
        try {
          // busy 由前端如实上报；后端只认它，不自己猜（猜错会丢客户消息）
          const r = await deps.update.install({
            busy: Boolean(body && body.busy),
            version: (body && body.version) || '',
            db,
          });
          return json(res, 200, { ok: true, ...r });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message || '安装失败' });
        }
      }

      /* ============ 「📞 抓取」：抓**聊天对象的资料**里的电话号码 ============
         2026-10-07 加，v1.0.13 改方向。
         🔴 老板原话："我这个抓取不是让你抓聊天的对话内容，是要让你抓取聊天对象的资料里面了的电话号码"
            —— 第一版扫的是 messages 表里的**正文**，方向错了。本版改成去**活着的
            WhatsApp 网页**里读这位客户的**联系人资料**（Contact 模型 / LID→号码 映射 /
            联系人信息面板 / 会话头部），把他资料上所有号码相关的字段全列出来。

         GET /api/phone/profile?code=客户编号
         · 只读：不写档案、不发消息、不点保存联系人（红线：这是"看"，不是"改"）
         · 一个字段都不静默丢弃：LID、15 位、看着不像号码的也列出来并写清理由 */
      const mPhoneProfile = /^\/api\/phone\/profile$/.exec(p);
      if (mPhoneProfile && req.method === 'GET') {
        const code = String(url.searchParams.get('code') || '').trim();
        if (!code) return json(res, 400, { error: '缺少客户编号' });
        const c = db.getCustomer.get(code);
        if (!c) return json(res, 404, { error: '客户不存在' });
        if (typeof deps.grabProfilePhone !== 'function') {
          return json(res, 501, { error: '当前模式不支持抓取资料（没有可操作的浏览器）' });
        }
        try {
          const r = await deps.grabProfilePhone(code);
          // 「浏览器没开」不是服务器错误 —— 用 200 + ok:false，前端据此显示"怎么该做"
          return json(res, 200, r);
        } catch (e) {
          return json(res, 500, { error: '抓取失败：' + (e.message || e) });
        }
      }

      /* ============ 「电话号码」自动填充（2026-10-07 v1.0.14）============
         老板需求：打开客户档案时
           ① 号码框为空 → 自动抓取并填入
           ② 号码框没有 "+" → 重新抓取，填入时前面补 "+"
           ③ 绿灯 = 已判定带 + 的合格号码 → 不用再抓
         POST /api/phone/fill  { code, force? }
           · force=0（默认）：绿灯直接跳过，不做任何抓取 ← 老板第④条要求
           · force=1：点「📞 抓取」按钮强制重来一次
         🔴 写库口径：自动抓的钉 phone_src='contact'（可被更强的来源升级）；
            人工在弹窗里改的钉 'manual'（谁都不许覆盖，见 db.updateCustomer）。 */
      if (p === '/api/phone/fill' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const code = String(body.code || '').trim();
        const force = !!body.force;
        if (!code) return json(res, 400, { error: '缺少客户编号' });
        const c = db.getCustomer.get(code);
        if (!c) return json(res, 404, { error: '客户不存在' });

        // ① 先判绿灯。绿灯且不是强制 → 直接返回，什么都不抓（老板第④条）
        const light = phoneFill.judgePhone(c.phone);
        if (light.green && !force) {
          return json(res, 200, { ...light, code, phone: c.phone, skipped: true, filled: false });
        }

        if (typeof deps.grabProfilePhone !== 'function') {
          return json(res, 501, { error: '当前模式不支持抓取资料（没有可操作的浏览器）' });
        }

        let probe;
        try {
          probe = await deps.grabProfilePhone(code);
        } catch (e) {
          return json(res, 200, {
            green: false, light: phoneFill.LIGHT.red, code,
            reason: '抓取出错：' + (e.message || e), filled: false,
          });
        }

        if (!probe || probe.ok === false) {
          return json(res, 200, {
            green: false, light: phoneFill.LIGHT.red, code,
            reason: (probe && probe.hint) || (probe && probe.reason) || '没抓到号码',
            filled: false,
          });
        }

        // ② 从资料字段里挑最合适的一条，转成带 + 的 e164
        const best = phoneFill.pickBest(probe.fields);
        if (!best || !best.e164 || !best.e164.ok) {
          const why = best && best.e164 ? best.e164.reason : '这次资料里没有能用的号码';
          return json(res, 200, {
            green: false, light: phoneFill.LIGHT.red, code,
            reason: why, filled: false,
          });
        }

        const e164 = best.e164;
        const curDigits = identity.digitsOnly(c.phone);
        // ③ 号码跟库里已有的一样 → 只补加号，不新建；不一样 → 当冲突处理，不静默覆盖
        const sameNumber = curDigits && curDigits === e164.digits;
        const toWrite = e164.phone; // 带 + 的

        if (sameNumber) {
          // 只差一个加号：就地更新（顺带把号码写进编号库）
          numberLibrary.register(toWrite, code, c.channel);
          db.db.prepare('UPDATE customers SET phone=? WHERE code=?').run(toWrite, code);
          refreshDoc(code);
          broadcast('customer', db.getCustomer.get(code));
          const j2 = phoneFill.judgePhone(toWrite);
          return json(res, 200, {
            ...j2, code, phone: toWrite, filled: true, onlyPlus: true,
            reason: `${j2.reason}（这次只是补上了 +）`,
          });
        }

        if (curDigits && !force) {
          // 库里已经有另一个号码，且不是老板点了按钮强制来的 → 不覆盖，让他自己判断
          const j3 = phoneFill.judgePhone(c.phone);
          return json(res, 200, {
            ...j3, code, phone: c.phone, filled: false, conflict: true,
            reason: `库里已经是 ${c.phone}，这次抓到的是 ${toWrite}（${e164.country}）—— 两个人不一样，没敢自动改。要换成新的请点「📞 抓取」按钮。`,
          });
        }

        // 空号 / 老板强制 → 写入
        numberLibrary.register(toWrite, code, c.channel);
        db.db.prepare("UPDATE customers SET phone=?, phone_src=COALESCE(NULLIF(phone_src,''),?) WHERE code=?")
          .run(toWrite, force ? 'manual' : 'contact', code);
        if (e164.country && !db.getCustomer.get(code).region) {
          db.db.prepare('UPDATE customers SET region=? WHERE code=?').run(e164.country, code);
        }
        refreshDoc(code);
        broadcast('customer', db.getCustomer.get(code));
        const j4 = phoneFill.judgePhone(toWrite);
        return json(res, 200, {
          ...j4, code, phone: toWrite, filled: true, country: e164.country,
          reason: `${j4.reason} —— ${e164.reason}`,
        });
      }

      /* ============ 用 DeepSeek 按「地区」自动算时区 / 与北京时差（v2.6.1164）============
         老板需求：档案里地区填了（如「英国」），自动用 DeepSeek 把地区映射到 IANA 时区，
         再由 Intl 算出与北京（Asia/Shanghai）的时差，回填客户 timezone 字段，并返回给前端，
         让聊天头部「客户当地时间 / 比北京慢快 N 小时」自动显示。
         · DeepSeek 不可用时回落到静态 guessTimezone（功能不中断，只是不是 AI 算的）。
         · 只在 timezone 为空（还没算过）时写库，绝不覆盖手填的数字时差。 */
      /** 该时区与北京的时差（小时，可为小数，如印度 -2.5）。用「同一瞬间两地墙钟差」= 偏移差，DST 自动准确。 */
      function tzOffsetHoursVsBeijing(tz) {
        try {
          const now = new Date();
          const fmt = (z) => {
            const p = new Intl.DateTimeFormat('en-US', {
              timeZone: z, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit', second: '2-digit',
            }).formatToParts(now).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
            return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
          };
          const a = fmt(tz); const b = fmt('Asia/Shanghai');
          if (isNaN(a) || isNaN(b)) return null;
          return (a - b) / 3600000;
        } catch (e) { return null; }
      }
      function tzLooksValid(tz) {
        if (!tz || typeof tz !== 'string') return false;
        // 2026-10-23：放宽 IANA 名校验 —— 原正则只认「两段、纯字母下划线」，
        // 会把 America/Argentina/Buenos_Aires、Etc/GMT+5、America/Port-au-Prince
        // 这类合法时区判成非法（AI 明明给对了却回落静态表）。仍必须含「/」且 Intl 认得。
        if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
        if (!tz.includes('/')) return false;
        try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
      }
      function localTimeOfTz(tz) {
        try {
          const f = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          const p = {}; for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
          return `${p.month}-${p.day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
        } catch (e) { return ''; }
      }

      /**
       * 把「地区」解析成 IANA 时区（v2.7.1231）。
       *   ① 先问「时差计算」任务指的那家 AI（默认 DeepSeek）—— 用户填的地区写法千奇百怪
       *      （"美国 加州 洛杉矶"、"加拿大 温哥华"），静态表认不出来时只能靠 AI；
       *   ② AI 不可用 / 返回不合法 → 回落静态表 regions.guessTimezone，功能不中断。
       * 返回 { tz, source }，source = 'ai' | 'static' | 'none'。
       *
       * 🔴 只负责「地区 → 时区名」这一步；当地时间 / 与北京时差仍由 Intl 现算，
       *    DST 才不会算错（别让 AI 直接报几点，它会报错时区）。
       */
      async function resolveRegionTz(region) {
        const useRegion = String(region || '').trim();
        if (!useRegion) return { tz: null, source: 'none' };
        let tz = null;
        try {
          const tzSel = ai.resolveTask('timezone') || {};
          const tzProv = tzSel.providerName || 'deepseek';
          const tzModel = tzSel.model || 'deepseek-v4-flash';
          const r = await ai.callProviderByName(tzProv, tzModel, {
            system: '你是时区换算助手。用户给一个地区或国家名（可能为中文，如"英国""美国西海岸""日本"），请返回该地当前使用的 IANA 时区名。只输出 JSON，不要任何解释。',
            user: `地区：${useRegion}\n请返回 JSON：{"tz":"Europe/London"}`,
            jsonMode: true, temperature: 0, maxTokens: 64,
            // 保存档案要等这一步，别让 AI 卡 60 秒：12 秒不回来就先落静态表，保存照常完成。
            timeout: 12000,
          });
          if (r) { const m = /"tz"\s*:\s*"([^"]+)"/.exec(r); if (m) tz = m[1]; }
        } catch (e) { tz = null; }
        if (tzLooksValid(tz)) return { tz, source: 'ai' };
        const guess = regions.guessTimezone(useRegion) || null;
        return { tz: guess, source: guess ? 'static' : 'none' };
      }

      if (p === '/api/region/timezone' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const code = String(body.code || '').trim();
          const region = String(body.region || '').trim();
          if (!code) return json(res, 400, { error: '缺少客户编号' });
          const c = db.getCustomer.get(code);
          if (!c) return json(res, 404, { error: '客户不存在' });
          const useRegion = region || (c.region || '');
          if (!useRegion) return json(res, 200, { ok: false, reason: 'no-region', code });
          const curTz = String(c.timezone || '').trim();
          if (curTz) {
            // 已有（手填数字 或 之前算过的 IANA）→ 直接返回现有显示数据，不重复算
            const valid = tzLooksValid(curTz);
            const off = valid ? tzOffsetHoursVsBeijing(curTz) : null;
            return json(res, 200, {
              ok: true, code, region: useRegion, tz: curTz, source: 'existing',
              offsetHours: off,
              localTime: valid ? localTimeOfTz(curTz) : '',
              diffText: off === null ? '' : (off === 0 ? '和北京同时区' : `比北京${off > 0 ? '早' : '晚'} ${Math.abs(off)} 小时`),
              wrote: false,
            });
          }
          // ① 优先用「时差计算」任务指的那家 AI 把地区映射成 IANA 时区（没配就回落 DeepSeek）
          const resolved = await resolveRegionTz(useRegion);
          let tz = resolved.tz;
          const source = resolved.source;
          if (!tz) return json(res, 200, { ok: false, reason: 'no-tz', code, region: useRegion });
          let offset = tzOffsetHoursVsBeijing(tz);
          if (offset === null) { // IANA 不合法，再回落静态
            tz = regions.guessTimezone(useRegion) || null;
            offset = tz ? tzOffsetHoursVsBeijing(tz) : null;
          }
          if (!tz) return json(res, 200, { ok: false, reason: 'no-tz', code, region: useRegion });
          const localTime = localTimeOfTz(tz);
          const diffText = offset === 0 ? '和北京同时区' : `比北京${offset > 0 ? '早' : '晚'} ${Math.abs(offset)} 小时`;
          // 只在 timezone 为空时写库（不覆盖手填数字）
          try {
            db.db.prepare('UPDATE customers SET timezone=? WHERE code=?').run(tz, code);
            refreshDoc(code);
            broadcast('customer', db.getCustomer.get(code));
          } catch (e) { /* 写库失败不致命 */ }
          return json(res, 200, {
            ok: true, code, region: useRegion, tz, source,
            offsetHours: offset, localTime, diffText, wrote: true,
          });
        } catch (e) {
          return json(res, 500, { error: '时区计算失败：' + (e.message || e) });
        }
      }

      /* ---- 旧接口保留：扫**对话正文**里的数字（跟资料是两回事，2026-10-13 前一直在用）
         保留是因为它仍然有用（客户自己在聊天里打出来的号），但它**不是**「抓取」按钮干的事。 */
      const mScan = /^\/api\/phone\/scan$/.exec(p);
      if (mScan && req.method === 'GET') {
        const code = String(url.searchParams.get('code') || '').trim();
        if (!code) return json(res, 400, { error: '缺少客户编号' });
        const c = db.getCustomer.get(code);
        if (!c) return json(res, 404, { error: '客户不存在' });
        try {
          const r = phoneScan.scanCustomer(code, db.listMessages.all(code), c);
          return json(res, 200, r);
        } catch (e) {
          return json(res, 500, { error: '扫描失败：' + (e.message || e) });
        }
      }

      /* 把一句话术预填进「当前选中客户」的对话框（绝不按回车）。 */
      if (p === '/api/prefill' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const code = String(body.code || '');
        const text = String(body.text || '');
        if (!code || !text) return json(res, 400, { error: '缺少客户或内容' });
        const c = db.getCustomer.get(code);
        if (!c) return json(res, 404, { error: '客户不存在' });
        if (typeof deps.prefillChat !== 'function') {
          return json(res, 200, { ok: false, method: 'clipboard', reason: 'no-prefill' });
        }
        const r = await deps.prefillChat(c.account_id, c.phone, text);
        return json(res, 200, { ok: r.ok, method: r.method, reason: r.reason });
      }

      /* ============ 每日话术编排台 · 看板接口 ============ */
      const mBoard = /^\/api\/board\/([A-Z0-9]+)$/.exec(p);
      if (mBoard) {
        const code = mBoard[1];
        const c = db.getCustomer.get(code);
        if (!c) return json(res, 404, { error: '客户不存在' });
        if (req.method === 'GET') {
          const board = await scriptBoard.getBoardAsync(code);
          return json(res, 200, {
            code,
            name: c.name,
            phone: c.phone,
            accountId: c.account_id,
            joinedAt: c.joined_at,
            day: dayOf(c.joined_at),
            board,
            hasV376: scriptBoard.hasV376(code),   // 这份看板有没有 V3.7.6 导入段
          });
        }
      }

      /* V3.7.6.1 导入段：把新增的 267 个碎片幂等补进**已有**看板。
       * 只补本地没有的 id，不覆盖老板改过的内容、不动 sent 标记；重复调用无副作用。 */
      const mV376 = /^\/api\/board\/([A-Z0-9]+)\/import-v376$/.exec(p);
      if (mV376 && req.method === 'POST') {
        const code = mV376[1];
        const c = db.getCustomer.get(code);
        if (!c) return json(res, 404, { error: '客户不存在' });
        const r = scriptBoard.importV376(code);
        const board = await scriptBoard.getBoardAsync(code);
        return json(res, 200, { ok: true, ...r, board });
      }

      const mFragAdd = /^\/api\/board\/([A-Z0-9]+)\/fragment$/.exec(p);
      if (mFragAdd && req.method === 'POST') {
        const code = mFragAdd[1];
        const body = await readJsonBody(req);
        const b = await scriptBoard.addFragmentAsync(code, body.name, { morning: body.morning, evening: body.evening, day: body.day });
        return json(res, 200, { ok: true, board: b });
      }

      const mFragUpd = /^\/api\/board\/([A-Z0-9]+)\/fragment\/([A-Za-z0-9_]+)$/.exec(p);
      if (mFragUpd && req.method === 'PUT') {
        const code = mFragUpd[1]; const fid = mFragUpd[2];
        const body = await readJsonBody(req);
        const b = await scriptBoard.updateFragmentAsync(code, fid, body);
        return json(res, 200, { ok: true, board: b });
      }

      const mFragDel = /^\/api\/board\/([A-Z0-9]+)\/fragment\/([A-Za-z0-9_]+)$/.exec(p);
      if (mFragDel && req.method === 'DELETE') {
        const code = mFragDel[1]; const fid = mFragDel[2];
        const body = await readJsonBody(req);
        if ((body.pwd || '') !== '123456') return json(res, 403, { error: '密码错误' });
        const b = await scriptBoard.deleteFragmentAsync(code, fid);
        return json(res, 200, { ok: true, board: b });
      }

      const mDlgAdd = /^\/api\/board\/([A-Z0-9]+)\/fragment\/([A-Za-z0-9_]+)\/dialogue$/.exec(p);
      if (mDlgAdd && req.method === 'POST') {
        const code = mDlgAdd[1]; const fid = mDlgAdd[2];
        const body = await readJsonBody(req);
        const b = await scriptBoard.addDialogueAsync(code, fid, body.en, body.zh);
        return json(res, 200, { ok: true, board: b });
      }

      const mDlgUpd = /^\/api\/board\/([A-Z0-9]+)\/dialogue\/([A-Za-z0-9_]+)$/.exec(p);
      if (mDlgUpd && req.method === 'PUT') {
        const code = mDlgUpd[1]; const did = mDlgUpd[2];
        const body = await readJsonBody(req);
        // fid 只用来「锁定在哪条碎片里找」：历史数据里对话 id 可能撞车，带上 fid 才不会改错条
        const b = await scriptBoard.updateDialogueAsync(code, did, body, body.fid || url.searchParams.get('fid') || '');
        return json(res, 200, { ok: true, board: b });
      }

      const mDlgDel = /^\/api\/board\/([A-Z0-9]+)\/dialogue\/([A-Za-z0-9_]+)$/.exec(p);
      if (mDlgDel && req.method === 'DELETE') {
        const code = mDlgDel[1]; const did = mDlgDel[2];
        const b = await scriptBoard.deleteDialogueAsync(code, did, url.searchParams.get('fid') || '');
        return json(res, 200, { ok: true, board: b });
      }

      const mSent = /^\/api\/board\/([A-Z0-9]+)\/dialogue\/([A-Za-z0-9_]+)\/sent$/.exec(p);
      if (mSent && req.method === 'POST') {
        const code = mSent[1]; const did = mSent[2];
        const body = await readJsonBody(req);
        const b = await scriptBoard.setSentAsync(code, did, body.sent !== false, body.fid || url.searchParams.get('fid') || '');
        return json(res, 200, { ok: true, board: b });
      }

      const mFragSentAll = /^\/api\/board\/([A-Z0-9]+)\/fragment\/([A-Za-z0-9_]+)\/sentall$/.exec(p);
      if (mFragSentAll && req.method === 'POST') {
        const code = mFragSentAll[1]; const fid = mFragSentAll[2];
        const body = await readJsonBody(req);
        // v1.0.8：已发状态只写本机（scriptBoard 里不再碰云端）。ids = 界面当前看到的那几条
        const b = await scriptBoard.setFragmentSentAllAsync(code, fid, body.sent !== false, body.ids);
        return json(res, 200, { ok: true, board: b });
      }

      const mSend = /^\/api\/board\/([A-Z0-9]+)\/send$/.exec(p);
      if (mSend && req.method === 'POST') {
        const code = mSend[1];
        const body = await readJsonBody(req);
        const c = db.getCustomer.get(code);
        if (!c) return json(res, 404, { error: '客户不存在' });
        const b = scriptBoard.getBoard(code);
        const hit = scriptBoard.findDialogue(b, body.did);
        const en = hit ? hit.dialogue.en : (body.en || '');
        if (typeof deps.prefillChat !== 'function') {
          return json(res, 200, { ok: false, method: 'clipboard', reason: 'no-prefill', en });
        }
        const r = await deps.prefillChat(c.account_id, c.phone, en);
        return json(res, 200, { ok: r.ok, method: r.method, reason: r.reason, en });
      }

      const mProfile = /^\/api\/customer\/([A-Z0-9]+)\/profile$/.exec(p);
      if (mProfile && req.method === 'POST') {
        const code = mProfile[1];
        const body = await readJsonBody(req);
        const c = db.getCustomer.get(code);
        if (!c) return json(res, 404, { error: '客户不存在' });

        const region = body.region ?? c.region;

        // 时区（2026-09-30 用户要求改成「填数字」：填与北京的小时差，留空=按地区自动）
        //   ① 这次填了数字（-12 / +3 / 0）→ **手填的时差优先**，存进 timezone 这一列；
        //   ② 这次清空了（''）→ 回到「按地区自动」：原来手填的数字作废，
        //      改成地区推出来的时区（地区推不出来就留空，界面会提示"填了时区才显示"）；
        //   ③ 前端没传这个字段（内部调用）→ 沿用旧规则：地区改了重算、没改就沿用库里的；
        //   ④ 兼容老数据/老界面：非数字的手填值（America/New_York 这种 IANA 名）照旧优先，
        //      免得以前手改过时区的客户被"地区"覆盖掉。
        const bodyTzRaw = body.timezone == null ? null : String(body.timezone).trim();
        const bodyOffset = doc.isTzOffset ? doc.isTzOffset(bodyTzRaw) : null;
        const manualBefore = doc.isTzOffset ? doc.isTzOffset(c.timezone) : null;
        const regionChanged = body.region != null && String(body.region) !== String(c.region || '');
        let timezone;
        if (bodyOffset) {
          timezone = bodyTzRaw;                        // ① 手填数字优先
        } else if (bodyTzRaw === '') {
          // ② 数字框空着 = 按「地区」自动。注意：新界面**每次保存都会把这个字段发上来**，
          //   所以这里必须自己判断"地区是不是改了"，不能像以前那样靠"字段没传"来判。
          if (regionChanged) {
            // 🔴 v2.7.1231（老板要求「有修改才解读」）：
            //   地区改过 → 用 AI 重新解读一遍（静态表只作兜底），这样换了国家/城市，
            //   右侧资料卡的「客户当地时间 / 与北京时间差」才会跟着变；
            //   地区没改 → 绝不重复问 AI，沿用库里已有的时区。
            const resolved = await resolveRegionTz(region);
            timezone = resolved.tz || c.timezone || null;
          } else if (manualBefore) {
            timezone = doc.guessTimezone(region) || null;                // 撤销原来手填的数字
          } else {
            timezone = c.timezone || doc.guessTimezone(region) || null;  // 本来就没填 → 沿用
          }
        } else if (bodyTzRaw !== null) {
          timezone = bodyTzRaw;                        // ④ 老界面/老数据传上来的 IANA，照旧优先
        } else {
          timezone = regionChanged                     // ③ 内部调用：地区变了就重算
            ? (doc.guessTimezone(region) || c.timezone || null)
            : (c.timezone || doc.guessTimezone(region));
        }

        // 加入时间：手动改过就一直保留手填的值
        let createdAt = null;
        let createdSource = null;
        if (body.created_at) {
          const d = new Date(body.created_at);
          if (!isNaN(d)) {
            createdAt = d.toISOString();
            createdSource = 'manual';
          }
        }

        // 客户档案：6 个核心字段落独立列（姓名/电话/地区/时区/阶段/加入时间），
        // 另 10 个附加字段（婚姻情况/生活规律/别名/老家家乡/爱好/职业/家庭经济情况/父母/宠物/孩子）
        // 以 JSON 存进 profile_json，不做 schema 改动。手机号变了要同步进编号库。
        // 手机号变了要同步进编号库。
        // 2026-09-29 加一道兜底（用户报"长数字被当成电话号码"）：客户 JID 是 @lid 时，
        // 那串内部编号（WhatsApp 用来藏手机号的隐私 ID）绝不许进「电话号码」栏 ——
        // 手填也拦掉。它是身份标识，只该待在档案弹窗那个只读的「WA对话编号」里。
        let phone = body.phone != null ? String(body.phone).trim() : c.phone;
        if (phone && identity.isLidPhone(c.wa_jid, phone)) phone = '';

        /* ---------- 跨编号查重（v1.0.1） ----------
         * 老板要求：mj005 存了号码 a，mj006 某天也存 a → 点「保存档案」要弹窗
         * 「该电话号码已经被 mj005 的用户添加了」。
         * 做法：保存前先问云端。界面可以带 force=1 表示"我知道重复，还是要存"。
         * 云端问不到（没登录/断网）就不拦 —— 宁可漏提示，不能不让存。 */
        if (phone && !body.force && cloud.status().loggedIn) {
          try {
            const chk = await cloud.checkPhone(phone, code);
            if (chk.conflict && chk.owners.length) {
              const o = chk.owners[0];
              return json(res, 409, {
                ok: false,
                phoneConflict: true,
                owners: chk.owners,
                error: `该电话号码已经被 ${o.code} 的用户添加了`
                  + (o.customerCode && o.customerCode !== code ? `（客户编号 ${o.customerCode}）` : ''),
              });
            }
          } catch (e) { /* 云端抖动 → 不拦 */ }
        }
        if (phone) {
          numberLibrary.register(phone, code, c.channel);
          // 登录云端时把号码登记进自己编号的仓库（带 + 的才登记，云端会自己过滤）
          if (cloud.status().loggedIn) {
            try {
              await cloud.registerPhone(phone, code, body.name ?? c.name, !!body.force);
            } catch (e) { /* 登记不上不影响本地保存 */ }
          }
        }

        updateCustomerSafe({
          code,
          name: body.name ?? c.name,
          region,
          timezone,
          stage_day: body.stage_day ?? c.stage_day,
          phone,
          created_at: createdAt,
          created_at_source: createdSource,
          profile_json: body.profile_json != null ? String(body.profile_json) : undefined,
        });
        const file = refreshDoc(code);
        broadcast('pending', { code });
        return json(res, 200, { ok: true, customer: db.getCustomer.get(code), docFile: file });
      }

      // ---- 单独从对话里抽取档案（不用先生成建议） ----
      const mExtract = /^\/api\/customer\/([A-Z0-9]+)\/extract$/.exec(p);
      if (mExtract && req.method === 'POST') {
        const code = mExtract[1];
        const c = db.getCustomer.get(code);
        if (!c) return json(res, 404, { error: '客户不存在' });
        if (!ai.isReady || !ai.isReady('extract')) {
          return json(res, 503, { error: `AI 未配置：${ai.notConfiguredReason ? ai.notConfiguredReason('extract') : '未填 key'}，没法自动提取` });
        }

        const result = await extractProfileOf(code);
        if (result.error) return json(res, 503, result);
        // dedup：同一个电话号码下发现几份重复档案、合并到哪份、原文件备份在哪
        return json(res, 200, {
          ok: true, profile: result.profile, docFile: result.docFile, dedup: result.dedup || null,
        });
      }

      const mReplied = /^\/api\/customer\/([A-Z0-9]+)\/replied$/.exec(p);
      if (mReplied && req.method === 'POST') {
        const code = mReplied[1];
        // 两个按钮走同一段逻辑（都表示"这条我处理完了"）：
        //   · 「✓ 标记已回复」= 已经回过客户了（要求真的检测到我发出的消息才亮，界面把的关）
        //   · 「⏭ 跳过消息」  = 不想回这条，也算处理完了（传 {skip:true}，只是语义不同）
        const body = await readJsonBody(req);
        const skipped = body && body.skip === true;
        db.clearPending(code);
        // 处理完了 = 这一格从左栏「待处理」收进「已处理」：
        // 消失≠删除 —— 最新对话要落盘到该客户编号对应的 .md 文件（本地始终留着完整对话）
        let docFile = null;
        try { docFile = refreshDoc(code); } catch (e) { /* 落盘失败不影响标记成功 */ }
        // 这一个事件界面收到就够：顶栏待处理 -1、左栏把这一格收进「已处理」、今日统计跟着变
        broadcast('pending', { code, pending: 0, skipped });
        return json(res, 200, { ok: true, docFile, skipped });
      }

      // ---- 标记已看：未读清零（用户在左栏点开这个客户时调）----
      // 注意：和 /replied 是两回事——这里只表示"我看了"，不代表"我回了"。
      const mRead = /^\/api\/customer\/([A-Z0-9]+)\/read$/.exec(p);
      if (mRead && req.method === 'POST') {
        const code = mRead[1];
        if (!db.getCustomer.get(code)) return json(res, 404, { error: '客户不存在' });
        db.clearUnread(code);
        broadcast('pending', { code, unread: 0 });
        return json(res, 200, { ok: true, unread: 0, total: db.totalUnread() });
      }

      // ---- 补翻译：把这个客户还没翻的客户消息翻一遍（后台跑，翻完逐条推 translated）----
      // 历史同步进来的消息当初没翻（几十个对话几千条，全翻太贵），
      // 所以打开客户时补最近这几条，右栏才有中文可看。
      const mBackfill = /^\/api\/customer\/([A-Z0-9]+)\/translate$/.exec(p);
      if (mBackfill && req.method === 'POST') {
        const code = mBackfill[1];
        if (!db.getCustomer.get(code)) return json(res, 404, { error: '客户不存在' });
        const raw = await readJsonBody(req);
        const max = Math.min(Math.max(Number(raw.max) || 12, 1), 50);
        if (!ai.isReady('translate')) {
          return json(res, 200, {
            ok: false,
            queued: 0,
            reason: ai.notConfiguredReason ? ai.notConfiguredReason('translate') : '未填 key',
          });
        }
        const queued = translator.backfill(code, (r) => {
          broadcast('translated', r);
          if (r.bodyZh) refreshDoc(code);
        }, max);
        // 顺手把客户发来的图片/语音也补看一遍（同样后台跑，看完推 translated）
        const mediaQueued = media.backfill(code, (r) => {
          broadcast('translated', { code: r.code, msgId: r.msgId, bodyZh: '', mediaZh: r.mediaZh, kind: r.kind, error: r.error });
        }, Math.min(max, 6));
        return json(res, 200, {
          ok: true,
          queued,
          mediaQueued,
          remaining: translator.untranslatedCount(code),
          mediaRemaining: media.pendingCount(code),
        });
      }

      // v2.5.1028：Tele 独立自动翻译接口已随中栏 Tele 标签与自动翻译功能取消而移除


      /*
       * 手动重翻这一条（2026-09-30）
       * 自动重试封顶之后，一条"翻不出来"的消息会被彻底放手，不再烧 token。
       * 用户想再试一次就点气泡上的「点这里重翻」——只有这个入口能把账本清零重来。
       */
      const mRetry = /^\/api\/message\/(\d+)\/translate$/.exec(p);
      if (mRetry && req.method === 'POST') {
        const id = Number(mRetry[1]);
        const row = db.getMessage.get(id);
        if (!row) return json(res, 404, { error: '消息不存在' });
        const raw = await readJsonBody(req);
        let queued = false;
        if (raw.media) {
          // 媒体翻译仍只针对客户发来的（media.js 那套只管 in）：自己发的媒体不翻
          if (row.direction !== 'in') return json(res, 200, { ok: false, reason: '自己发的媒体不翻' });
          queued = media.retryManual(id, row.customer_code, row.media_path, (r) => {
            broadcast('translated', { code: r.code, msgId: r.msgId, bodyZh: '', mediaZh: r.mediaZh, kind: r.kind, error: r.error });
          });
        } else {
          // 2026-10-15 v2.6.1121：文字重翻两个方向都放行（自己发出去的也要有中文）
          queued = translator.retryManual(id, row.customer_code, row.body, (r) => {
            broadcast('translated', r);
            if (r.bodyZh) refreshDoc(row.customer_code);
          });
        }
        return json(res, 200, { ok: !!queued, queued: queued ? 1 : 0 });
      }

      const mSuggest = /^\/api\/customer\/([A-Z0-9]+)\/suggest$/.exec(p);
      if (mSuggest && req.method === 'POST') {
        const code = mSuggest[1];
        const body = await readJsonBody(req);
        const result = await handleSuggest(code, {
          attempt: body.attempt,
          angleOnly: body.angleOnly,
          avoid: body.avoid,
          messageId: body.messageId,
        });
        return json(res, result.error ? 503 : 200, result);
      }

      // ---- 采纳：把这句话存进话术库 ----
      if (p === '/api/suggestion/adopt' && req.method === 'POST') {
        const body = await readJsonBody(req);
        // 兼容旧前端：传 groupId+optionIndex（新）；只传 index 的旧调用回落成第 0 组、第 index 个。
        const groupId = Number.isFinite(body.groupId) ? Number(body.groupId) : 0;
        const optionIndex = Number.isFinite(body.optionIndex)
          ? Number(body.optionIndex)
          : (Number.isFinite(body.index) ? Number(body.index) : 0);
        const found = optionOf(Number(body.suggestionId), groupId, optionIndex);
        if (!found || !found.option) return json(res, 404, { error: '找不到这条建议' });

        const text = String(body.text ?? found.option.text ?? '').trim();
        const rec = learn.recordAdopt({
          angle: found.option.angle || body.angle || null,
          day: Number.isFinite(body.day) ? body.day : null,
          scene: String(body.scene || '').slice(0, 300),
          text,
          note: body.note || null,
          customerCode: found.row.customer_code,
        });

        db.db.prepare('UPDATE suggestions SET adopted_index=?, edited_text=? WHERE id=?').run(
          optionIndex,
          body.text != null && body.text !== found.option.text ? text : null,
          Number(body.suggestionId)
        );
        broadcast('learned', { type: 'adopt', id: rec?.id });
        return json(res, 200, { ok: true, dedup: rec?.dedup || false, id: rec?.id, stats: learn.stats() });
      }

      // ---- 不采纳：记进负样本，然后换思路重新生成 ----
      if (p === '/api/suggestion/reject' && req.method === 'POST') {
        const body = await readJsonBody(req);
        // 兼容旧前端：新调用传 groupId+optionIndex；旧调用只传 index（视为第 0 组、第 index 个）。
        const groupId = Number.isFinite(body.groupId) ? Number(body.groupId) : 0;
        const optionIndex = Number.isFinite(body.optionIndex)
          ? Number(body.optionIndex)
          : (Number.isFinite(body.index) ? Number(body.index) : -1);
        // 整批否掉（optionIndex<0）也要能拿到整份 groups，所以这里 groupId 传 0、optionIndex 传 -1
        const found = optionOf(Number(body.suggestionId), groupId, optionIndex < 0 ? -1 : optionIndex);
        if (!found) return json(res, 404, { error: '找不到这条建议' });

        const scene = String(body.scene || '').slice(0, 300);
        const day = Number.isFinite(body.day) ? body.day : null;

        if (optionIndex < 0) {
          // 整批否掉：所有组的所有选项都记负样本
          for (const g of found.groups) {
            for (const o of (g.options || [])) {
              learn.recordReject({ angle: o.angle, day, scene, text: o.text, reason: body.reason || null, customerCode: found.row.customer_code });
            }
          }
        } else {
          const o = found.option;
          if (o) {
            learn.recordReject({ angle: o.angle, day, scene, text: o.text, reason: body.reason || null, customerCode: found.row.customer_code });
          }
        }

        db.db.prepare('UPDATE suggestions SET adopted_index=-1 WHERE id=?').run(Number(body.suggestionId));
        broadcast('learned', { type: 'reject' });

        // 换思路：避开刚才这些说法，重新生成
        const avoid = [
          ...(Array.isArray(body.avoid) ? body.avoid : []),
          ...found.groups.flatMap((g) => (g.options || []).map((o) => o.text)),
        ];
        const result = await handleSuggest(found.row.customer_code, {
          attempt: (Number(body.attempt) || 0) + 1,
          angleOnly: body.angleOnly || null,
          avoid: [...new Set(avoid.filter(Boolean))],
        });
        return json(res, result.error ? 503 : 200, result);
      }

      // ---- 手动录入：粘一段对话进来，走同一条教练链路 ----
      if (p === '/api/manual' && req.method === 'POST') {
        const bodyIn = await readJsonBody(req);
        const result = await handleManual(bodyIn);
        return json(res, result.error ? 400 : 200, result);
      }

      /* ---- 模拟新消息（测试用，2026-09-25） ----
       * 界面顶栏「🧪 模拟新消息」调它。造一条和真实 WhatsApp 消息同形状的假消息，
       * 走真正的 handleMessage：入库 → 编号 → 广播 → 后台翻译 → 写档案。
       * 不会发给任何人；造出来的客户标了 is_sim，可一键清空。
       *
       * 注意：必须放在下面「静态文件」之前，否则会被当成找文件、返回 404。 */
      if (p === '/api/dev/simulate' && req.method === 'POST') {
        if (typeof simulateMessage !== 'function') return json(res, 501, { ok: false, error: '这个实例没挂模拟功能' });
        const bodyIn = await readJsonBody(req);
        const result = await simulateMessage(bodyIn);
        return json(res, result.ok ? 200 : 400, result);
      }
      if (p === '/api/dev/simulate/clear' && req.method === 'POST') {
        if (typeof clearSimulated !== 'function') return json(res, 501, { ok: false, error: '这个实例没挂模拟功能' });
        const result = await clearSimulated();
        // 清空是在「全局设置」那扇窗里点的，主窗口左栏 / 今日消息得跟着刷新 → 广播一声
        broadcast('data_changed', { what: 'sim_clear' });
        return json(res, 200, result);
      }
      if (p === '/api/dev/simulate' && req.method === 'GET') {
        return json(res, 200, { ok: true, count: db.countSimulated(), accounts: db.listAccounts.all() });
      }

      // ---- 翻译：选中某条中文建议 → 译成 2-3 个英文版本（按客户信息调口吻） ----
      if (p === '/api/translate' && req.method === 'POST') {
        const bodyIn = await readJsonBody(req);
        const result = await handleTranslate(bodyIn);
        return json(res, result.error ? 503 : 200, result);
      }

      // ---- 手动自由翻译（右栏面板）：中文→外文(3 情绪) / 其他语言→中文 ----
      if (p === '/api/translate/free' && req.method === 'POST') {
        const bodyIn = await readJsonBody(req);
        const result = await handleFreeTranslate(bodyIn);
        return json(res, result.error ? 503 : 200, result);
      }

      // ---- 截图设置：读 app.screenshot.*（默认合并，保证界面永远拿得到值）----
      if (p === '/api/screenshot/config' && req.method === 'GET') {
        const sc = (cfg && cfg.app && cfg.app.screenshot) || {};
        return json(res, 200, {
          ok: true,
          config: {
            enabled: sc.enabled !== false,
            hotkey: typeof sc.hotkey === 'string' ? sc.hotkey : 'Ctrl+Alt+Z',
            savePath: typeof sc.savePath === 'string' ? sc.savePath : '',
            enableAiTranslate: sc.enableAiTranslate !== false,
            providerName: typeof sc.providerName === 'string' ? sc.providerName : 'vision',
            targetLang: typeof sc.targetLang === 'string' ? sc.targetLang : '中文',
          },
        });
      }

      // ---- 截图设置：写 app.screenshot.*（落 config.yaml，注释全留，不碰别处）----
      if (p === '/api/screenshot/config' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const paths = require('./paths');
        const cfgFile = paths.configFile();
        if (!fs.existsSync(cfgFile)) return json(res, 500, { error: '找不到配置文件' });
        let text = fs.readFileSync(cfgFile, 'utf8');

        // 第一次写之前，确保 app.screenshot: 块存在，否则 setScalar 会把子键插到 app 顶层
        if (!/^\s{2}screenshot:\s*$/m.test(text)) {
          const lines = text.split(/\r?\n/);
          let appIdx = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === 'app:') { appIdx = i; break; }
          }
          if (appIdx >= 0) {
            lines.splice(appIdx + 1, 0, '  screenshot:');
            text = lines.join(text.includes('\r\n') ? '\r\n' : '\n');
          }
        }

        const map = {
          enabled: ['app', 'screenshot', 'enabled'],
          hotkey: ['app', 'screenshot', 'hotkey'],
          savePath: ['app', 'screenshot', 'savePath'],
          enableAiTranslate: ['app', 'screenshot', 'enableAiTranslate'],
          providerName: ['app', 'screenshot', 'providerName'],
          targetLang: ['app', 'screenshot', 'targetLang'],
        };
        const changed = [];
        const incoming = {};
        for (const [k, pathArr] of Object.entries(map)) {
          if (typeof body[k] === 'undefined') continue;
          const r2 = configWrite.setScalar(text, pathArr, body[k]);
          if (r2 && r2.changed) { text = r2.text; changed.push(pathArr.join('.')); }
          incoming[k] = body[k];
        }
        if (changed.length) {
          fs.writeFileSync(cfgFile, text, 'utf8');
          cfg.app = cfg.app || {};
          cfg.app.screenshot = Object.assign({}, cfg.app.screenshot, incoming);
        }
        return json(res, 200, { ok: true, changed, config: (cfg.app && cfg.app.screenshot) || {} });
      }

      // ---- 话术库 ----
      if (p === '/api/learned' && req.method === 'GET') {
        return json(res, 200, { learned: learn.listLearned(), rejected: learn.listRejected(), stats: learn.stats() });
      }

      const mLearnedDel = /^\/api\/learned\/(\d+)$/.exec(p);
      if (mLearnedDel && req.method === 'DELETE') {
        learn.removeLearned(Number(mLearnedDel[1]));
        return json(res, 200, { ok: true, stats: learn.stats() });
      }

      // ---- 客户发来的图片/语音/文件：给界面一个能直接看的地址 ----
    // 2026-10-07 加。以前聊天气泡里只显示「📎 文件名」一行字，图片也得点开文件夹
    // 才能看到；这里开一条只读路由把 media 目录里的文件喂给 <img>/<audio>。
    // 安全：只允许 mediaDir 内的文件、只认白名单扩展名、路径规范化后必须还在 mediaDir 里。
    if (p.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      let mediaDir = '';
      try { mediaDir = require('./paths').mediaDir(); } catch (e) { mediaDir = ''; }
      if (!mediaDir) return json(res, 404, { error: 'media dir not ready' });
      const relName = decodeURIComponent(p.slice('/media/'.length)).replace(/^\/+/, '');
      const filePath = path.join(mediaDir, path.normalize(relName).replace(/^([/\\])+/, ''));
      // 目录穿越防护：解析后必须仍在 mediaDir 之内
      if (!filePath.startsWith(mediaDir)) return json(res, 403, { error: 'forbidden' });
      const ext = path.extname(filePath).toLowerCase();
      // 白名单：只放行媒体扩展名，别把 .db / .js 之类顺着这个口漏出去
      if (!MIME[ext] || ['.html', '.css', '.js', '.json', '.svg'].includes(ext)) {
        return json(res, 403, { error: 'media type not allowed' });
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return json(res, 404, { error: 'media not found' });
      }
      const buf = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': buf.length,
        // 图片是可能变的内容（客户重发同名），本地服务不缓存省事
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      });
      return req.method === 'HEAD' ? res.end() : res.end(buf);
    }

    // ---- 静态文件 ----
      let rel = p === '/' ? '/index.html' : p;
      const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        let body = fs.readFileSync(filePath);
        // index.html 里 css/js 后面带 ?v=__BUILD__，这里换成真实构建戳：
        // 界面文件一改，地址就变，浏览器/桌面窗口不可能还拿旧的。
        if (ext === '.html') {
          const txt = String(body);
          if (txt.includes('__BUILD__')) body = Buffer.from(txt.split('__BUILD__').join(buildStamp()), 'utf8');
        }
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': body.length,
          // 关键：界面文件一律不缓存。
          // 之前没带这个头，Electron 会把自己下载的 app.js / style.css 存进
          // %APPDATA%\wa-assistant\Cache，改完代码重开窗口还是旧界面 ——
          // 「我启动的界面和截图不一样」就是这么来的。
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
        });
        return res.end(body);
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[server]', e);
      return json(res, 500, { error: e.message });
    }
  });

  return {
    server,
    broadcast,
    aiStatus,
    handleSuggest,
    handleManual,
    extractProfileOf,
    /** 只做查重合并（不抽档案）——测试和以后界面上的"整理重复档案"按钮直接用 */
    mergeDuplicateDocs,
    refreshDoc,
    normalizeJid,
    parseLines,
    channelOfJid,
    phoneOfJid,
    sseClients,
  };
}

module.exports = { createServer, buildStamp, PUBLIC_DIR };
