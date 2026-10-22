/**
 * 三栏界面逻辑
 *
 * 左：客户列表（红点=待处理）　中：英文原文 + 中文翻译　右：档案卡 + 中文建议
 * 所有数据来自本地 127.0.0.1 的接口，没有任何外发请求。
 */

const $ = (id) => document.getElementById(id);

/* ---------------- 界面提示条 ----------------
   凡是要告诉用户"发生了什么"，一律走这里，宁可吵一点也不要"点了没反应"。

   位置在顶栏第二行右侧（右栏「客户档案」的正上方），而且【只保留一条】：
   以前是一个堆叠的列表，消息一多就把右下角的工作区糊住了。 */
var noticeTimer = null;

function showNotice(level, text, ms = 6000) {
  const box = $('toast');
  if (!box) return;
  box.textContent = String(text ?? '');
  box.title = String(text ?? '');          // 被省略号截断时，悬停能看全
  box.className = `show n-${level}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    box.className = '';
    box.textContent = '';
    box.title = '';
  }, ms);
}

// 兜底：脚本一出错，界面必须自己说出来，不许再出现"点了没反应"
window.addEventListener('error', (e) => showNotice('error', '界面出错：' + (e.message || '未知')));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  showNotice('error', '操作失败：' + ((r && r.message) || r || '未知'));
});

/**
 * 🔴 v2.6.1138：新消息提示音（WebAudio 兼底）—— 合成一声短促的「叮」。
 *
 * 为什么要有这一层：主进程那一级走 Electron shell.beep()，本质是调 Windows 的
 * MessageBeep，**系统里把「系统声音 / 通知声音」静音它就一起哑**，而且这种哑法
 * 从代码里区分不出「没响」还是「系统静音」（老板 2026-10-16 拍板加的兼底）。
 * WebAudio 是浏览器内核自己合成，不吃系统音量设置那一套，只吃总音量。
 *
 * 关键细节：
 *   · AudioContext **必须在用户手势里创建/恢复**，否则被自动播放策略挂起 → 不响。
 *     所以这里先尝试 resume()，并且用「一次性小音量重播」把解锁做了。
 *   · 不加载任何外部音频文件 → 不会因为打包漏文件而静默失败。
 *   · 全程 try/catch：提示层失败绝不能影响界面。
 *
 * @returns {boolean} 是否真的播了
 */
function tgBeep() {
  let ctx = tgBeep._ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) ctx = tgBeep._ctx = new AC();
    // 被自动播放策略挂起时先恢复（必须在用户手势语境下才可能成功，失败也无妨）
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { ctx.resume(); } catch (e) { /* 忽略 */ }
    }
    const now = ctx.currentTime;
    // 两个正弦叠一下，听起来更像「叮」而不是「嘟」
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.012);   // 起音，避免爆音
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26); // 快速衰减，不刺耳
    gain.connect(ctx.destination);
    for (const [freq, delay] of [[1180, 0], [1560, 0.045]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + delay);
      osc.connect(gain);
      osc.start(now + delay);
      osc.stop(now + 0.3);
    }
    return true;
  } catch (e) {
    return false;
  }
}

const state = {
  customers: [],
  activeCode: null,
  messages: [],      // 当前对话的消息（带 translating / untranslated 状态）
  aiReady: false,    // AI 配好了没（决定"等待翻译中"还是"AI 未配置"）
  suggestBusy: false,
  suggest: null, // { id, attempt, avoid, day, options, rationale }
  trText: null,  // 当前正在翻译的中文原文
  trBusy: false, // 翻译请求进行中（自动模式下防重复发单）
  // 「客户档案」弹窗正在看哪个客户（和 activeCode 分开：可以开着甲的对话、
  // 点开看乙的档案）。见 openProfileModal。
  profileCode: null,
  profileDoc: '',     // 档案弹窗里那个客户的 .md 完整路径（「文件路径」按钮用）
  profileAutoTz: '',  // 按「地区」推出来的时区（时区栏的提示/填写说明要用它说"按地区算几小时"）
  backfillBusy: {},   // 正在补翻译的客户（避免重复请求）
  backfillAt: {},     // 每个客户上次补翻的时间戳（2026-09-30：30 秒内不重复补翻，省 token）

  // 方案 C（2026-09-30）：消息框窗口化，避免几千条消息时每次重画全卡顿
  hasMoreOlder: false, // 当前客户还有更早的消息没加载吗
  oldestId: 0,         // 当前已渲染的最老一条消息的 id（滚到顶用它去取更早的）
  loadingOlder: false, // 正在懒加载更早消息，防重复请求
  newMsgCount: 0,      // 用户滚在历史里时，新来了几条（点提示条跳到最新）
  // 标签页未读角标（v1.5.1021）：key=后端账号 id（WA 一号~五号=1~5，Signal=6）
  tabUnread: {},       // { 1: n, 2: n, ..., 6: n }
  backfillWarned: {}, // 已经提示过"AI 没配"的客户（别每次点开都弹一遍）
  stats: { learned: 0, rejected: 0 },
};

/** 消息框一次最多渲染多少条（窗口化上限，想更流畅就调小，想多看点就调大） */
const WINDOW = 50;

/* 五个 WhatsApp 账号的圈数字：① = 一号（账号 1）、② = 二号 …… ⑤ = 五号。
   提前声明在这里，避免后面的函数提前用它时撞上 const 的暂时性死区。 */
const ACCT_CIRCLED = { 1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤' };

/* ---------------------------------------------------------------
 * 左栏客户行左端的「渠道标记」三套符号（2026-10-10 老板看图 QQ20261010-200721.png 定）：
 *   WhatsApp = ① ② ③ ④ ⑤     —— 圈数字，代表五个 WhatsApp 账号（1~5）
 *   Signal   = ⑴ ⑵ ⑶          —— 括号数字，代表三个 Signal 实例（S1~S3）
 *                                  🔴 原来是 ◉，老板明确要求换成 ⑴⑵⑶（形状家族和圈数字拉开）
 *   Telegram = ∮ ∯ ∰           —— 数学符号（环路/曲面积分），代表三个 Telegram 实例
 *                                  （Tele① 对应 ∮、Tele② 对应 ∯、Tele③ 对应 ∰）
 * 为什么三套要用三种完全不同的形状：左栏扫一眼就要能分出"这条是哪个渠道来的"，
 * 形状一样只换颜色的话，缩小到 14px 就糊成一片了。
 * --------------------------------------------------------------- */
const SIGNAL_GLYPH = { 1: '⑴', 2: '⑵', 3: '⑶' };
const TELE_GLYPH = { 1: '∮', 2: '∯', 3: '∰' };

/** Signal 客户的账号序号 —— 它不是 WhatsApp 账号表里的一行，只占这一个虚拟号。 */
const SIGNAL_ACCOUNT_ID = 99;

/**
 * 这个客户是不是 Signal 来的？（2026-10-08 老板立项 Signal 时定）
 *
 * 两个判定条件，任一成立就算：
 *   ① channel 字段明确写着 'signal' —— 这是采集模块写库时落的，是权威依据
 *   ② account_id 等于 SIGNAL_ACCOUNT_ID —— 兜底，防止 channel 字段没填上
 *
 * 为什么要两个：channel 是后加的列，老数据/手动录入的档案可能是空字符串，
 * 只认 channel 会漏掉一批。只认 account_id 又怕以后账号表真加了第 6 号。
 */
function isSignalCustomer(c) {
  if (!c) return false;
  const ch = String(c.channel || '').trim().toLowerCase();
  if (ch === 'signal') return true;
  return Number(c.account_id) === SIGNAL_ACCOUNT_ID;
}

/**
 * 这个客户是不是 Telegram 来的？（2026-10-10 老板定左栏用 ∮∯∰ 标记）
 *
 * Telegram 已通过 src/telegramRead.js（外跑 Chrome 开 web.telegram.org）接入后端采集，
 * 左栏用 ∮∯∰ 标记 channel='telegram' 的客户。这里只做判定 + 标记。
 */
function isTelegramCustomer(c) {
  if (!c) return false;
  const ch = String(c.channel || '').trim().toLowerCase();
  return ch === 'telegram' || ch === 'tele' || ch === 'tg';
}

/**
 * Signal 实例序号 → ⑴/⑵/⑶。
 *
 * 🔴 现状（2026-10-10 问过老板，答复"按之前的图标显示"）：
 *   后端只有一个 Signal 账号（SIGNAL_ACC.id = 6），S1~S3 三个启动器共用同一个
 *   Signal 库，库里**没有"这条消息是哪个实例发的"这一列**，所以区分不出 ⑵/⑶，
 *   一律按 ⑴ 显示。
 * 留好口子：将来后端把实例记进来（账号 6/7/8 或别的号段），这里返回 2/3，
 *   左端就自动变 ⑵/⑶，界面一个字都不用再改。
 */
function signalInstanceNo(c) {
  const n = Number(c && c.account_id) || 0;
  const idx = n - 5; // 6 → 1（当前唯一情况）；7 → 2、8 → 3 预留给多实例
  return idx >= 1 && idx <= 3 ? idx : 1;
}

/** Telegram 实例序号 → ∮/∯/∰（号段 7/8/9 预留给 Tele①②③，接入前一律 ∮）。 */
function teleInstanceNo(c) {
  const n = Number(c && c.account_id) || 0;
  const idx = n - 6; // 7 → 1、8 → 2、9 → 3
  return idx >= 1 && idx <= 3 ? idx : 1;
}

/**
 * Signal 渠道标记的 HTML —— **Signal 原装图标**（2026-10-12 老板换的）。
 *
 * 🔴 2026-10-12 老板看图（红框 = 中栏头部那串 SIGNAL）：
 *    「那个彩色的 SIGNAL 本来是用来提醒这个消息是来自哪个软件的，但是这个文字太长了，
 *      我想换个图标，把彩色的 SIGNAL 换成一个 signal 的原装图标，图标的大小为 20x20 像素。」
 *   → 逐字彩色的 B 方案作废，`SIGNAL_TAG_LETTERS` 常量已删（不留死代码）。
 *
 * 图标文件 = public/img/signal.svg（官方蓝 #3a76f0 圆角底 + 官方白色气泡标记，
 *   路径数据逐字取自官方发行版图形，没有手绘、没有简化）。
 * 尺寸 = **20×20 像素**，HTML 上写死 + CSS 再兜一层（见 style.css 的 .ch-signal-ico）。
 *
 * 位置不变（2026-10-08 定的）：紧跟在客户名后面，WhatsApp / Telegram 客户渲染空串。
 * 换图标只改 public/img/signal.svg 这一个文件，这里一个字都不用动。
 */
function signalTagHtml() {
  return '<span class="ch-signal" title="这个客户来自 Signal，不是 WhatsApp">'
    + '<img class="ch-signal-ico" src="/img/signal.svg" width="20" height="20" alt="Signal">'
    + '</span>';
}

const ANGLE_CN = {
  empathy: '共情',
  curiosity: '好奇',
  story: '故事',
  humor: '幽默',
  share: '分享',
  nudge: '轻推进',
  reassure: '打消顾虑',
  close: '收口',
  retreat: '退让',
};

async function refreshStats() {
  try {
    const d = await api('/api/learned');
    state.stats = d.stats || state.stats;
  } catch (e) {
    /* 接口没起来就算了 */
  }
}

/* ============================================================
   左栏顶部的「今日消息」提示窗
   只显示 ① ② ③ ④ ⑤ 各来了几条（2026-09-30 用户配图：收到/已处理/待处理
   三个数字格与「①主号…⑤五号」图例都已删）。
   数据来自 /api/stats/today（后端按本地日期算，跨零点自动归零）。
   ============================================================ */
async function refreshToday() {
  try {
    const [d, m] = await Promise.all([
      api('/api/stats/today'),
      api('/api/messages/today'),
    ]);
    const list = m && Array.isArray(m.messages) ? m.messages : (Array.isArray(m) ? m : []);
    renderToday(d, list);
  } catch (e) {
    /* 接口没起来就算了，数字保持原样 */
  }
}

function timeShort(ts) {
  if (!ts) return '';
  const s = String(ts);
  const mm = /(\d{1,2}:\d{2})/.exec(s);
  if (mm) return mm[1];
  const dt = new Date(s);
  if (!isNaN(dt)) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(dt.getHours())}:${p(dt.getMinutes())}`;
  }
  return s.slice(5);
}

function renderToday(d, list) {
  if (!d) return;
  const dateEl = $('tb-date');
  if (dateEl) dateEl.textContent = String(d.date || '').slice(5) || '—';
  // 2026-09-30（用户配图）：不再显示 收到 / 已处理 / 待处理 三个数字，只留 ① ② ③ ④ ⑤ 各几条。

  const by = d.byAccount || {};
  const wrap = $('tb-acct');
  if (wrap) {
    wrap.innerHTML = [1, 2, 3, 4, 5].map((id) => {
      const n = Number(by[id]) || 0;
      const label = { 1: '一号', 2: '二号', 3: '三号', 4: '四号', 5: '五号' }[id];
      return `<span class="ta ${n ? 'has' : ''}" title="账号 ${id}（${label}）：今天收到 ${n} 条">${ACCT_CIRCLED[id]}<b>${n}</b></span>`;
    }).join('');
  }

  /* 🔴 v2.6.1093 老板拍板（方案一）：今日消息收件箱**折叠成红圈数字，横向排列**。
     原来这里是一列客户名 + 预览文字（一条消息一行），占了左栏太多高度。
     现在只留红圈数字：数字 = 该客户今天有多少条**未读**（direction='in'）消息，
     数字下方小字 = 客户首字母（tooltip 显示全名），红色 = 有新消息。
     点数字直接跳到该客户对话 —— 折叠掉名字后，这是唯一进对话的入口。
     按未读数从多到少排，最多的在最左边。 */
  const box = $('tb-list');
  if (box) {
    // 按客户聚合未读数
    // v2.6.1107：Telegram 客户不进主窗口左栏「今日消息」（老板要求取消 T 消息），只走 Tele① 好友列。
    const teleCodes = new Set((Array.isArray(state.customers) ? state.customers : []).filter(isTelegramCustomer).map((c) => c.code));
    const agg = new Map();
    for (const m of (list || [])) {
      if (teleCodes.has(m.code)) continue;               // v2.6.1107：Telegram 不进主窗口左栏
      if (m.direction !== 'in') continue;                 // 只算客户发来的
      if (!m.code) continue;                              // 没有客户编号的（系统通知行）不进这里
      const cur = agg.get(m.code);
      if (cur) cur.n += 1;
      else agg.set(m.code, { code: m.code, name: m.name || '', n: 1, ts: m.msgTs });
    }
    const items = [...agg.values()].sort((a, b) => b.n - a.n);

    if (!items.length) {
      box.innerHTML = '<div class="tb-empty">今日还没有新消息</div>';
    } else {
      box.innerHTML = items.map((it) => {
        const nm = it.name || it.code;
        const ini = nm.trim().charAt(0).toUpperCase() || '?';
        return `<div class="tb-badge-wrap" data-code="${esc(it.code)}"
          title="${esc(nm)}：今天 ${it.n} 条新消息（点开对话）">
          <span class="tb-badge-num">${it.n > 99 ? '99+' : it.n}</span>
          <span class="tb-badge-ini">${esc(ini)}</span>
        </div>`;
      }).join('');
      box.querySelectorAll('.tb-badge-wrap').forEach((el) => {
        el.addEventListener('click', () => {
          const code = el.getAttribute('data-code');
          // 🔴 v2.6.1094：走同一条路 —— Telegram 的直接跳 Tele①，别跳「通用」
          if (code) openCustomerRow(code);
        });
      });
    }
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* ---------------- 接口 ---------------- */

async function api(path, options) {
  const res = await fetch(path, options);
  return res.json();
}

/* ---------------- 顶栏 ---------------- */

async function refreshState() {
  try {
    const s = await api('/api/state');
    // 「待处理」胶囊和右边那句数字说明 2026-09-30 按用户要求从顶栏撤掉了；
    // 待处理条数在左栏「今日消息」窗里照旧能看到（收到 / 已处理 / 待处理）。
    state.aiReady = !!s.aiReady;

    state.accounts = s.accounts || [];
    renderAccounts(s.accounts || []);
    // 🔴 v2.6.1113 顶栏「T①/T②」按钮（独立容器，别塞进 renderAccounts —— 那里每次都重画）
    renderTgAccounts(s.accounts || []);

    // 顶栏 Signal 启动器条：S1~S3 三个 Signal 桌面端实例的启动/停止 + 红黄绿灯（v2.5.1029 补回）
    renderLaunchers(s.launchers || []);

    // 🔴 v2.6.1116：config.yaml 漂移告警（老板 19:11 报的「T② enabled:false」根因）。
    //     软件打包后读的是**用户目录**那份 config.yaml，不是仓库那份。
    //     改错文件 → 改什么都不生效 → 这里直接把"两份不一致"亮在顶栏，
    //     老板一眼能看见，不用再猜"我明明改了怎么没反应"。
    renderConfigDrift(s.configDrift);

    // AI 状态 = 一个纯色小圆点（2026-09-26 按用户要求：不再是按钮，去掉文字和边框）
    //   绿 = 已连上（能出建议和翻译）　红 = 没连上 / 没配 key
    //   想改配置去点顶栏最右边的「⚙ 设置」→ 里面的「AI 设置」页签，这个点只负责"亮灯"，不响应点击。
    const ready = !!s.aiReady;
    const st = $('status');
    st.className = ready ? 'green' : 'red';
    st.title = ready
      ? `AI 已连上：${s.ai?.suggest?.provider || ''}/${s.ai?.suggest?.model || ''}`
      : (s.aiReason ? `AI 没连上：${s.aiReason}` : 'AI 没连上（没配 key）');

    // AI 状态变了 → 对话区顶上的提示条也要跟着变（"等待翻译中" ↔ "AI 未配置"）
    if (state.activeCode) renderChatStatus();
  } catch (e) {
    const st = $('status');
    st.className = 'red';
    st.title = '接口未连接';
  }
  // 云端（v1.0.1）：顺手刷一下「没登录编号」的提示条，失败也不影响主流程
  await refreshCloudBar().catch(() => {});
}

/* ---------------- 云端提示条（v1.0.1） ----------------
 * 只在「配了云端地址、但还没登录编号」时露出来：一行字 + 一个登录按钮。
 * 🔴 铁律：不弹窗、不遮挡任何东西 —— 没配云端地址的（纯单机）永远不显示。
 *    点按钮 = 打开「全局设置」的「☁ 云端」页签（不在这扇窗里另起弹窗）。 */
async function refreshCloudBar() {
  const bar = $('cloud-bar');
  if (!bar) return;
  let s = null;
  try { s = await api('/api/cloud/status'); } catch (e) { bar.classList.add('hidden'); return; }
  state.cloud = s || {};
  // 🔴 v2.6.1106：拿到云端状态就顺手重算界面权限（WA① 页签只对管理员显示）。
  //    判定规则一份在 perm.js，这里只负责把最新状态递过去，不自己判。
  if (window.BeePerm && typeof window.BeePerm.ingest === 'function') {
    try { window.BeePerm.ingest(s); } catch (e) { /* 权限模块没就绪不该拖垮主窗口 */ }
  }
  if (!s || !s.configured || s.loggedIn) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const note = $('cb-note');
  if (note) {
    note.textContent = s.lastError ? `（上次连不上：${s.lastError}）` : '';
  }
}

/* ---------------- config.yaml 漂移告警（v2.6.1116） ----------------
 * 🔴 这条是老板 19:11 实机报「T② 打开失败：enabled: false」查出来的真根因：
 *   **打包后的软件读的是用户目录那份 config.yaml，我改的是仓库那份，两份不是同一个文件。**
 *   所以「我明明改了怎么没反应」这个坑必须让老板在界面上直接看见，不能只在我的日志里。
 * 只提示、绝不在界面上自动改用户的配置。 */
function renderConfigDrift(d) {
  const bar = $('config-drift-bar');
  if (!bar) return;
  if (!d || !d.checked || !d.diff || !d.diff.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const txt = $('cd-txt');
  if (txt) txt.textContent = '⚠️ 配置文件对不上：软件读的是「' + d.active + '」，你在项目里改的那份它根本不看。';
  const det = $('cd-detail');
  if (det) {
    det.textContent = d.diff.join('；');
    det.title = '仓库那份：' + d.repo;
  }
}

function statusText(status) {
  /* 🔴 v2.6.1113 加 idle：TG 账号的「未启动」态（老板要求点按钮才开浏览器，
     所以启动后这一段是 idle 而不是 offline —— 红灯看着像故障，其实是「还没点」）。 */
  return { online: '在线', waiting_qr: '待扫码', offline: '离线', error: '异常', idle: '未启动' }[status] || status || '离线';
}

/** 红绿灯：绿=已登录，黄=待扫码，红=离线/异常，灰=未启动（idle，别误导成故障） */
function ledOf(status) {
  return { online: 'green', waiting_qr: 'amber', error: 'red', offline: 'red', idle: 'grey' }[status] || 'red';
}

/**
 * 顶栏第一行【靠左】的一排社交平台官网 LOGO（2026-09-26 用户要求：
 * 从原来账号条（第二行）的右端，挪到第一行；2026-09-30 再按用户要求改靠左，紧跟品牌名）。
 *   WhatsApp / Facebook / Instagram / TikTok / LinkedIn / Reddit / YouTube
 *   纯展示：20px 实心品牌图标，鼠标悬停出平台名；不跳转、不可点。
 *   路径取自 simple-icons（24×24 viewBox），缩到 20px 用；离线可用，不依赖网络图片。
 */
const SOCIAL_LOGOS = [
  { name: 'WhatsApp', color: '#25D366', d: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z' },
  { name: 'Facebook', color: '#1877F2', d: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z' },
  { name: 'Instagram', color: '#E4405F', d: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077' },
  { name: 'TikTok', color: '#010101', d: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
  { name: 'LinkedIn', color: '#0A66C2', d: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
  { name: 'Reddit', color: '#FF4500', d: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z' },
  { name: 'YouTube', color: '#FF0000', d: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
];

/** 第一行靠左那排 LOGO 的 HTML（内容填进 index.html 的 #brand-logos） */
function socialLogosHtml() {
  const items = SOCIAL_LOGOS.map((s) =>
    `<span class="brand-logo" title="${esc(s.name)}">` +
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="${s.color}" aria-hidden="true"><path d="${s.d}"/></svg>` +
    `</span>`
  ).join('');
  return items;
}

/** 把社交 LOGO 画进第一行的 #brand-logos（顶栏初始化时调一次即可） */
function renderSocialLogos() {
  const box = $('brand-logos');
  if (box) box.innerHTML = socialLogosHtml();
}

/**
 * 顶栏账号条：五个账号各一块
 *   ● 红绿灯  [一号]             ← 账号名【本身就是按钮】，点它开浏览器（在线/离线只用红绿点提示，不显示文字）
 *
 * 2026-09-24 按用户要求改：后面那个单独的「浏览器」按钮去掉了，太占地方。
 * 扫码在 Chrome 窗口里做：点名字启动这个账号，窗口会被搬到屏幕里并置顶，用手机扫它。
 * 这里【不显示二维码】。
 */
function renderAccounts(accounts) {
  const bar = $('accounts');
  if (!bar) return;

  /* 🔴 v2.6.1113：后端 getAccountStates 现在**把 TG 账号也一起返回**了（顶栏 T 按钮要那份数据），
     这里必须**排除 Telegram 账号**（id>=7），否则 T①/T② 会在 WA 这条容器里也画一遍 → 顶栏重复出现两套。
     真正的 T 按钮在 #tg-accounts（renderTgAccounts 画）。 */
  const waOnly = (accounts || []).filter((a) => Number(a.id) <= 6);

  if (!waOnly.length) {
    bar.innerHTML = '<span class="muted">未配置账号 —— 打开项目里的 config.yaml，把要用的账号 enabled 改成 true</span>';
    return;
  }

  bar.innerHTML = waOnly
    .map((a) => {
      const id = esc(a.id);
      const label = esc(a.label || a.id + '号');
      const st = esc(statusText(a.status));
      return `<div class="acct ${esc(a.status)}" data-id="${id}">
        <span class="led ${ledOf(a.status)}" title="${st}"></span>
        <button class="acct-name" data-act="open" data-id="${id}"
          title="点「${label}」启动 / 唤起这个账号的浏览器（第一次登录就在这里扫码）">${label}</button>
      </div>`;
    })
    .join('');
  // 🔴 2026-10-17：每次重画 #accounts 会把 perm.js 加的 .perm-hidden 冲掉，
  // 所以重画后立刻让权限模块重新套一遍（只藏 1~5 号，Signal 6 不动）。
  if (window.BeePerm && window.BeePerm.applyAccounts) window.BeePerm.applyAccounts();
  // 社交 LOGO 不在这里了 —— 2026-09-26 已挪到顶栏第一行「模拟新消息」右边（见 renderSocialLogos）。
}

/* 🔴 v2.6.1113 顶栏「T①/T②」按钮（老板 2026-10-14 17:31 报「按钮不见了」补回来）。
 * · 只显示 channel==='telegram' 且 enabled 的账号（T② 现在 enabled:false，所以只显示 T①）
 * · 点一下 = 那个号浏览器没开就启动、开了就拉前台；后端走单例锁，绝不重复开
 * · 🔴 必须走**独立**的 #tg-accounts 容器，不能塞进 renderAccounts 的 innerHTML ——
 *   那个函数每次 refreshState 都会重画，塞进去会被立刻冲掉。 */
function renderTgAccounts(accounts) {
  const bar = $('tg-accounts');
  if (!bar) return;
  /* 🔴 v2.6.1113：按 id>=7 筛 Telegram 账号（WA=1~5、Signal=6、T=7~9，三者 id 段不重叠）。
     这份数据来自后端 getAccountStates —— 它原先**只返回 cfg.accounts（WA）**，
     TG 账号压根没被送出来，所以按钮永远不画（老板 18:27 实机反馈）。后端已一并返回。 */
  const tgs = (accounts || []).filter((a) => Number(a.id) >= 7);
  if (!tgs.length) { bar.innerHTML = ''; return; }

  bar.innerHTML = tgs.map((a) => {
    const id = esc(a.id);
    /* 🔴 config.yaml 里 label 写的是「Tele① / Tele②」，但顶栏按钮空间窄、老板口径是「T① / T②」，
       这里统一去掉 "ele" 前缀（Tele③→T③），只影响按钮文字，不动任何数据字段。 */
    const raw = String(a.label || ('T' + a.id));
    const label = esc(/^Tele/i.test(raw) ? raw.replace(/^Tele/i, 'T') : raw);
    const st = esc(statusText(a.status));
    return `<div class="acct tg-acct ${esc(a.status)}" data-id="${id}">
      <span class="led ${ledOf(a.status)}" title="${st}"></span>
      <button class="acct-name" data-act="tg-open" data-id="${id}"
        title="点「${label}」启动 / 唤起这个 Telegram 账号的浏览器（web.telegram.org，登录态独立保存）">${label}</button>
    </div>`;
  }).join('');

  bar.querySelectorAll('[data-act="tg-open"]').forEach((b) => {
    b.onclick = async () => {
      const id = Number(b.dataset.id);
      const name = b.textContent.trim();
      /* 🔴 v2.6.1115 真根因（老板 18:56 报「T②/T③ 点了没反应」）：
         showNotice 的签名是 **(level, text)**，而这里三个调用都把「文字」当第一个参数传了
         → level 变成一整句中文、text 是 undefined → box.textContent = ''，
         **提示框永远空白** ⇒ 浏览器其实开了，但界面一点反馈都没有，老板看着就像"没反应"。
         （同函数 verify 已实测：POST /api/telegram/account/8/open 真的发出去了，后端也真收到。）
         全库 40+ 处调用都是 (level, text)，只有这三行是v2.6.1113 写错的。 */
      b.disabled = true;
      showNotice('info', `正在启动 ${name} 的浏览器…`);
      try {
        const r = await api(`/api/telegram/account/${id}/open`, { method: 'POST' });
        if (r && r.ok === false) showNotice('error', `${name} 打开失败：${(r.error || '未知原因')}`);
        else showNotice('ok', `${name} 浏览器已打开并拉到最前（登录请在那个 Chrome 窗口里扫码）`);
      } catch (e) {
        showNotice('error', `${name} 打开失败：${((e && e.message) || e)}`);
      } finally {
        b.disabled = false;
      }
    };
  });
}

/** 点账号名 = 开这个账号的浏览器 */
$('accounts').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const chip = btn.closest('.acct');
  const id = chip?.dataset.id;
  if (!id) return;
  if (btn.dataset.act === 'open') await openBrowser(id, btn);
});

/* 顶栏 Signal 启动器条（v2.5.1029 补回）：S1~S3 三个 Signal 桌面端实例
 *   - 渲染：从 /api/state 的 launchers 拿 [{id,label,kind,status,title}]
 *   - 点击：红（没启动）→ start；绿/黄（在跑）→ stop。每次操作完刷一次状态灯。
 *   数据来自后端 launcher.launcherStates()（v2.5.1034 起：后台异步刷新 + 只读缓存，
 *   请求恒定毫秒级返回、异常全兜住，不会搞挂界面）。
 */
function renderLaunchers(launchers) {
  const bar = $('launcher-bar');
  if (!bar) return;
  if (!launchers || !launchers.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = launchers.map((l) => {
    const cls = l.kind === 'signal' ? 'sig' : 'tg';
    return `<button class="launcher ${cls} ${l.status}" data-id="${l.id}" title="${l.title || l.label}">` +
             `<span class="lamp ${l.status}"></span><span class="lname">${l.label}</span>` +
           `</button>`;
  }).join('');
}

/* 点启动器：红→启动，绿/黄→停止（v2.5.1029 补回） */
$('launcher-bar').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  const id = btn.dataset.id;
  const running = btn.classList.contains('green') || btn.classList.contains('amber');
  btn.disabled = true;
  try {
    const r = await api(`/api/launcher/${id}/${running ? 'stop' : 'start'}`, { method: 'POST' });
    if (r.error) showNotice('error', `${id} 操作失败：${r.error}`);
    else showNotice('ok', `${id} 已${running ? '停止' : '启动'}`);
  } catch (err) {
    showNotice('error', '连不上本地服务：' + (err.message || err));
  } finally {
    btn.disabled = false;
    refreshState();
  }
});

/** 点账号名：没开就启动，已开就把那个 Chrome 窗口拉到前台 */
async function openBrowser(id, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '开启中…';
  const chip = btn.closest('.acct');
  chip?.classList.add('busy');
  try {
    const r = await api(`/api/account/${id}/open`, { method: 'POST' });
    if (r.error) {
      showNotice('error', `账号 ${id} 打不开：${r.error}`);
      return;
    }
    if (r.action === 'focused') {
      showNotice('info', r.window
        ? `账号 ${id}：Chrome 窗口已拉到桌面左上 ${r.window.left}, ${r.window.top}`
        : `账号 ${id}：Chrome 窗口已拉到前台`);
    } else if (r.status === 'waiting_qr') {
      showNotice('warn', `账号 ${id}：Chrome 窗口已打开，用手机 WhatsApp 扫那里的二维码`);
    } else if (r.revealed === false) {
      // 窗口没搬回桌面：说清楚原因 + 怎么救（绝不说"已启动"就完事）
      showNotice('warn', `账号 ${id}：浏览器起来了，但窗口没能自动搬到桌面（${r.revealError || '未知原因'}）—— 在屏幕下面的任务栏点一下 Chrome 就能看到它`);
    } else {
      const at = r.window ? `（窗口在左上 ${r.window.left}, ${r.window.top}）` : '';
      showNotice('ok', r.status === 'online'
        ? `账号 ${id}：已登录 WhatsApp${at}`
        : `账号 ${id}：已启动，Chrome 窗口正在打开…${at}`);
    }
  } catch (err) {
    showNotice('error', '连不上本地服务：' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    chip?.classList.remove('busy');
    refreshState();
  }
}

/* ---------------- 客户列表（左边这栏就是"新消息提醒"） ----------------
 *
 * 规则（2026-09-24 按用户要求定）：
 *   - 一个客户只占一格。他连发 5 条，就在这一格上累计成「5」，不会变成 5 个格子。
 *   - 没点开之前，未读数一直累加（刷新、重启都不清零，除非你真点开看了）。
 *   - 有未读的客户永远排在最上面；点开这个客户 = 我看过了，未读清零。
 */

async function refreshCustomers(selectCode) {
  const rows = await api('/api/customers');
  state.customers = rows;
  paintCustomers();
  renderTgFriends();   // v2.6.1107：Tele① 好友对话列同步刷新
  // 只有明确指定要打开哪个客户时才自动打开（否则每次刷新列表都会把对话区重画一遍）
  if (selectCode) openCustomer(selectCode);
}

/**
 * 这一格现在「有事要办」吗？
 *   pending = 有还没处理的新消息；unread = 有还没点开看过的新消息。
 *   两者都 0 → 这一格算处理完了，收进下面的「已处理」里。
 */
function customerHasWork(c) {
  return (Number(c.pending) || 0) > 0 || (Number(c.unread) || 0) > 0;
}

/**
 * 只重画左栏（未读清零这种局部变化，不必重新请求接口）
 *
 * 左栏**只显示"有事要办"的客户**（用户 2026-09-26 第三次强调，之前做成了"折叠组"是错的）：
 *   - 有新消息 / 未读的客户 → 显示在列表里，按"先到的在上"排好序
 *   - 处理完的客户（点了「✓ 标记已回复」/「⏭ 跳过消息」，pending 和 unread 都归 0）
 *     → **直接从列表里拿掉，看不见了**（不是折叠、不是置顶、不是收进某个组）
 *   - 这个客户**再来新消息** → 按新消息排队规则重新冒出来
 *   聊天记录一条都不会丢：数据库和本地 .md 档案始终完整保留。
 */
function paintCustomers() {
  const body = $('list-body');
  if (!body) return;
  const rows = state.customers || [];
  if (!rows.length) {
    body.innerHTML = '<div class="empty">还没有客户。<br>点某个账号的名字打开浏览器，扫码登录后会自动同步最近对话。</div>';
    return;
  }
  // 只留"有事要办"的：处理完的客户直接不渲染 = 从眼前彻底消失。
  // v2.6.1107：Telegram 客户统一在 Tele① 页签的「好友对话」列里选，主窗口左栏不再列出（老板要求取消 T 消息）。
  const live = rows.filter(customerHasWork).filter((c) => !isTelegramCustomer(c));

  let html = live.map(customerRowHtml).join('');
  if (!live.length) {
    html += '<div class="list-none">现在没有待处理的新消息'
      + '<span>客户来新消息，会自己按顺序冒到这儿</span></div>';
  }
  body.innerHTML = html;
  for (const el of document.querySelectorAll('.cust')) {
    el.onclick = () => openCustomerRow(el.dataset.code);
  }
  // 注意：客户行里【没有】任何按钮。
  // 「客户档案 / 从对话里提取档案」这两个按钮 2026-09-25 第二轮挪到了**中栏头部最右端**
  // （renderChatHead 里的 #ch-doc / #ch-extract），左栏客户行恢复成"点哪儿都是打开这个客户"。
}

function customerRowHtml(c) {
  const preview = c.last_body_zh || c.last_body || '';
  // 左栏这个「Day N」跟中栏头部那个紫色徽标必须同一个数（都按加入时间算，Day 0 = 加入当天），
  // 否则会出现"左栏 Day 2、点进去头部 Day 0"的矛盾。Day 0（刚加入）不显示，免得一堆 Day 0 太吵。
  const dayIdx = dayIndex(c);
  const tags = [c.region, dayIdx > 0 ? `Day ${dayIdx}` : '', c.mood].filter(Boolean).join(' · ');
  const unread = Number(c.unread) || 0;
  return `<div class="cust ${c.pending ? 'pending' : ''} ${unread ? 'has-unread' : ''} ${c.code === state.activeCode ? 'active' : ''}" data-code="${esc(c.code)}">
    ${custNumHtml(c)}
    <div class="meta">
      <div class="top">
        <span class="code">${esc(c.code)}</span>
        <span class="name">${esc(c.name || '未命名')}</span>
        ${unread ? `<span class="unread" title="有 ${unread} 条新消息还没看">${unread > 99 ? '99+' : unread}</span>` : ''}
      </div>
      <div class="preview">${esc(preview)}</div>
      <div class="tags">${esc(tags)}</div>
    </div>
  </div>`;
}

/**
 * 客户行左端的「账号圈数字」① ② ③ ④ ⑤ —— 就挂在原来那个**红点的位置**上
 * （不是放在中间的对话里）。
 *
 * 颜色规则（按用户要求）：
 *   - 红 = 这个客户有新消息（来自哪个 WhatsApp 账号一目了然）——唯一的持续提醒
 *   - 绿 = 这条你看过了，但**还没处理完**（没回复）——选中的 1 秒后由红转绿
 *   - 处理完（回复了 / 点「✓ 标记已回复」）→ 数字消失，退回原来那个安静的小圆点
 *   - 没新消息、也没待回复 → 一直就是小圆点，不显示数字
 */
/** code -> 时间戳：刚点开这一行，1 秒内数字仍显示红色（然后自己转绿） */
const rowSeenAt = {};

function custNumHtml(c) {
  const acct = Number(c.account_id) || 0;
  const circ = ACCT_CIRCLED[acct];
  const unread = Number(c.unread) || 0;
  const pending = Number(c.pending) || 0;
  const justSeen = !!rowSeenAt[c.code] && Date.now() < rowSeenAt[c.code];
  /*
   * Telegram 客户（2026-10-10 老板定）：左端用 **∮ ∯ ∰**（Tele①=∮ / Tele②=∯ / Tele③=∰）。
   * 和 Signal 一样常驻不消失（没新消息时也不缩回小圆点），
   * 这样左栏一眼就能分出渠道，不用点进去看。
   */
  if (isTelegramCustomer(c)) {
    const teleTip = pending
      ? `Telegram 客户${unread ? ` · ${unread} 条新消息还没看` : ' · 你看过了，还没回复'}`
      : `Telegram 客户${unread ? ` · ${unread} 条新消息还没看` : ' · 没有待处理的消息'}`;
    return `<span class="row-tele" title="${esc(teleTip)}">${TELE_GLYPH[teleInstanceNo(c)]}</span>`;
  }
  /*
   * Signal 客户（2026-10-08 老板定要"换一个形状"；2026-10-10 老板定换成 **⑴⑵⑶**）：
   * 左端不用 ① ② ③ ④ ⑤，改用括号数字 ⑴⑵⑶（S1/S2/S3）。
   * 为什么这样能"顺带解决标签何时出现"：
   *   ① ② ③ ④ ⑤ 表达的是「哪个 WhatsApp 账号」，而 Signal 是**另一个渠道**、
   *   没有 WhatsApp 账号序号，所以必须换一个形状 —— ⑴ 一眼就知道不是 WhatsApp 那五个。
   *   而且不管有没有新消息都常驻（原来没消息时缩成小圆点就没了），
   *   这样扫左栏就能立刻分出「哪几个是 Signal 客户」，中栏头部的 Signal 图标
   *   也就跟着一起出现了。
   * 🔴 实例序号（⑴/⑵/⑶）目前恒为 ⑴ —— 后端只有一个 Signal 账号，
   *    见 signalInstanceNo() 的说明；⑵⑶ 已经留好口子。
   */
  if (isSignalCustomer(c)) {
    const sigTip = pending
      ? `Signal 客户${unread ? ` · ${unread} 条新消息还没看` : ' · 你看过了，还没回复'}`
      : `Signal 客户${unread ? ` · ${unread} 条新消息还没看` : ' · 没有待处理的消息'}`;
    return `<span class="row-signal" title="${esc(sigTip)}">${SIGNAL_GLYPH[signalInstanceNo(c)]}</span>`;
  }
  /*
   * 🔴 v2.6.1121 WA①（内置浏览器）客户（2026-10-15 老板拍板「加 Ⓦ」）；v2.6.1134 扩为 WA①~⑤。
   *   左端用 **Ⓦ₁ Ⓦ₂ Ⓦ₃ Ⓦ₄ Ⓦ₅**（Ⓦ + 下标数字），按下标数字一眼分出是五个内置浏览器里的哪一个。
   *   为什么必须是又一个新形状：左栏扫一眼要能分出"这条是从哪来的"——
   *     ①②③④⑤  = 一号~五号（外部独立 Chrome）
   *     ⑴⑵⑶     = Signal
   *     ∮∯∰      = Telegram
   *     Ⓦ₁~Ⓦ₅    = WA①~⑤（软件内置浏览器那份）
   *   形状一样只换颜色，缩到 14px 就糊成一片了（老板 2026-10-10 定的规矩）。
   *   和 Signal / Telegram 一样**常驻不消失**（有没有新消息都在），
   *   否则没消息时缩成小圆点就分不出渠道了。
   */
  if (isWhatsappWebCustomer(c)) {
    const pane = waInstanceByCode(c.code) || WA_PANES[0];
    const idx = pane ? pane.cfg.idx : 1;
    const WA_GLYPH = { 1: 'Ⓦ₁', 2: 'Ⓦ₂', 3: 'Ⓦ₃', 4: 'Ⓦ₄', 5: 'Ⓦ₅' };
    const glyph = WA_GLYPH[idx] || 'Ⓦ';
    const waTip = pending
      ? `${pane.cfg.label}（内置浏览器）客户${unread ? ` · ${unread} 条新消息还没看` : ' · 你看过了，还没回复'}`
      : `${pane.cfg.label}（内置浏览器）客户${unread ? ` · ${unread} 条新消息还没看` : ' · 没有待处理的消息'}`;
    return `<span class="row-wa1" title="${esc(waTip)}">${glyph}</span>`;
  }
  // 没有新消息、也没有待回复：保持原来那个小圆点
  if (!circ || (!unread && !pending)) return '<div class="dot"></div>';
  const cls = (unread > 0 || justSeen) ? 'red' : 'green';
  const tip = cls === 'red'
    ? `账号 ${acct} 来的新消息（${unread || 1} 条还没看）· 点开这一行 1 秒后变绿`
    : `账号 ${acct} 来的消息你看过了，还没回复 · 回复了或点「✓ 标记已回复」后这个数字才消失`;
  return `<span class="row-num ${cls}" title="${esc(tip)}">${circ}</span>`;
}

/** 清掉这个客户的未读（本地先清，界面立刻响应；服务端失败也没关系，下次刷新以服务端为准） */
async function markReadQuietly(code) {
  const row = (state.customers || []).find((c) => c.code === code);
  if (!row || !Number(row.unread)) return;
  row.unread = 0;
  paintCustomers();
  try {
    await api(`/api/customer/${code}/read`, { method: 'POST' });
  } catch (e) {
    /* 接口没起来就算了 */
  }
}

/** 用户在左栏点了一格：先算"看过了"，再打开对话 */
function openCustomerRow(code) {
  // 先记「刚点开」：这个账号圈数字 1 秒内保持红色，满 1 秒后自己转绿（用户要的节奏）
  rowSeenAt[code] = Date.now() + 1000;
  markReadQuietly(code); // 不 await：先把对话显示出来，清零在后台完成
  paintCustomers();
  setTimeout(() => {
    delete rowSeenAt[code];
    paintCustomers();   // 红 → 绿（一直绿到真的处理完）
  }, 1100);

  /* 🔴 v2.6.1094 老板看图定稿（QQ20261013-141311.png 那个红框的 ∮ 标记）：
     点左栏**带 ∮ 的 Telegram 消息**，**不再跳「通用」**，直接切到中栏 Tele①
     并把这个客户的资料卡 + 对话信息挂上。
       · WhatsApp / Signal 客户 → 照旧走「通用」，一个字都不变
       · 左边客户列表、右栏话术库、采集链路：一律不碰
     判定必须在**左栏那条 c 上**做，但 openCustomerRow 只拿到 code，
     所以先从 state.customers 里找到那一条；找不到就退回原行为（绝不猜）。 */
  const row = (state.customers || []).find((x) => x && x.code === code);
  if (row && isTelegramCustomer(row)) {
    // 🔴 v2.6.1113 Tele②：左栏点 T 客户时**按编号段自动路由**到对应页签 ——
    //   编号第一位 7 → Tele①，8 → Tele②（客户编号形如 7A00001 / 8A00001，一眼能分）。
    const seg = String(code || '').charAt(0);
    const pane = seg === '8' ? 'tele2' : 'tele1';
    tgActiveCode = code;
    tgSetCode(pane, code);
    switchMidTab(pane);
    loadTgProfile(code, pane);       // 右侧资料卡
    renderTgConvInfo(code, pane);    // 右侧对话信息
    // 🔴 v2.6.1111 指令②（老板新要求）：点左栏 T 客户 → 「话术编排台」也跟着切到这个客户。
    //    原来这条分支直接 return，openCustomer() 没跑 → state.activeCode 没设、Board.syncFor 没调
    //    → 编排台永远停在上一个 WA 客户。T 客户走不到通用那套，所以必须在这里单独补一次。
    state.activeCode = code;
    if (window.Board && typeof window.Board.syncFor === 'function') window.Board.syncFor(code);
    return;                            // ⚠️ 不再走下面的「通用」那套
  }

  /* 🔴 v2.6.1124 老板 2026-10-15 拍板（QQ20261015-122735.png 红框①②③④）：
     点左栏 **WA① 内置浏览器**客户（isWhatsappWebCustomer，即 channel='whatsapp-web'，编号形如 WA00001）
     → **直接跳 WA① 页签**，不回「通用」。与 T 客户跳 Tele① 同理；
     外部 1~5 号 WA 客户（channel='whatsapp'）照旧走通用，一个字不改。
     对话信息本来就只渲染进对应 WA 内置页签右栏「对话信息」（renderConvInfo 落在 #waN-convinfo-body），
     路由一改，这些客户的对话信息自然只在对应的 WA 页签，通用页不再掺和。
     ⚠️ 必须放在 switchMidTab('general') **之前**：switchMidTab('general') 内部会先清各 WA 页签的 activeCode 再走 else。 */
  if (row && isWhatsappWebCustomer(row)) {
    const pane = waInstanceByCode(row.code) || WA_PANES[0]; // 按编号段（WA/WB/WD/WE/WF）路由到对应页签
    pane.setActiveCode(code);              // 先记上，switchMidTab 内部会再 renderConvInfo 一次
    pane.loadProfile(code);                // 右侧资料卡
    pane.renderConvInfo(code);             // 右侧对话信息
    switchMidTab(pane.cfg.mp);             // 🔴 切到对应 WA 页签（不回通用）
    // 🔴 v2.6.1111 指令②同款：点左栏 WA 客户 → 「话术编排台」也跟着切到这个客户
    state.activeCode = code;
    if (window.Board && typeof window.Board.syncFor === 'function') window.Board.syncFor(code);
    return;                              // ⚠️ 不再走下面的「通用」那套
  }

  /* 🔴 v2.6.1111 指令②：点左栏 WhatsApp / Signal 客户 → 中栏自动切回「通用」工作台。
     老板 2026-10-14 新要求，**覆盖** v2.6.1094「切不切页签由老板自己点、绝不替他改」那条
     （那条针对的是"别自动跳 WA①"，现在要的是"自动回通用"，两回事）。
     🔴 位置铁律：必须放在挂 WA 页签 activeCode **之前** —— switchMidTab('general') 内部会先
        把各 WA 页签 activeCode / tgActiveCode 清空再走 else 分支；放后面等于自己把自己刚挂的清掉。
     T 客户在上面已经 return（走 Tele①），这里只管 WA / Signal。 */
  switchMidTab('general');

  /* 🔴 v2.6.1094 老板拍板新增 WA① 页签后，WhatsApp 客户点开时**多挂一份 WA① 的资料卡**，
     但**中栏仍然照旧显示对话**（「通用」那套一个字都没变）。
     ⚠️ 2026-10-13 修正一次踩过的坑：
        我第一版写成「WA 客户点开 → 直接跳 WA①，不再走通用」，结果 ui_render 测试里
        「右栏顶部提醒等待翻译中」和「英文气泡标等待翻译中」两条当场变红 —— 根因是
        openCustomer() 没跑 → #msgs 是空的 → 「等待翻译」提示条根本不出现。
        这也说明**「通用」是 WA 客户的主工作台，WA① 是附加的浏览器页**，两者不是替代关系。
        现在改成：照旧走通用，同时把 WA① 那边的资料卡 + 对话信息填好；
        切不切页签由老板自己在中栏顶部点 WA①，绝不替他改。 */
  if (row && isWhatsappCustomer(row)) {
    WA_PANES[0].setActiveCode(code);               // 先记上：老板什么时候点 WA① 都是现成的
    WA_PANES[0].loadProfile(code);
    WA_PANES[0].renderConvInfo(code);
  }

  openCustomer(code);
}

/** 这个客户是不是 WhatsApp 来的（WA① 页签的入口判据） */
function isWhatsappCustomer(c) {
  if (!c) return false;
  const ch = String(c.channel || '').trim().toLowerCase();
  /* 🔴 v2.6.1121：channel='whatsapp-web' = **WA① 内置浏览器**采来的客户。
     它跟一号~五号（channel='whatsapp'）是同一类「WhatsApp 客户」——
     左栏点开时要照样在中栏挂上 WA① 的资料卡 + 对话信息。
     ⚠️ 不加这一条会踩的坑：WA① 客户里那些 @lid 隐私号的 wa_jid 是
        `wa1:206459950338291@lid`，**不以 @c.us 结尾**，下面那条 JID 兜底判据
        也认不出来 → WA① 资料卡永远挂不上（只有号码型客户能挂，一半好一半坏）。 */
  if (ch === 'whatsapp' || ch === 'wa' || ch === 'whatsapp-web') return true;
  const jid = String(c.wa_jid || c.jid || '');
  return jid.endsWith('@c.us') || jid.endsWith('@s.whatsapp.net');
}

/**
 * 这个客户是不是 **WA① 内置浏览器**采来的（v2.6.1121）。
 * 只认 channel（不认 JID）：一号~五号的 wa_jid 也以 @c.us 结尾，
 * 靠 JID 判会把五个外部号一起卷进来。
 */
function isWhatsappWebCustomer(c) {
  if (!c) return false;
  return String(c.channel || '').trim().toLowerCase() === 'whatsapp-web';
}

/**
 * 客户当地时间 / 与我们的时差
 * 客户在纽约、洛杉矶、芝加哥…… 你得知道他那边现在几点，才知道该不该发消息。
 *
 * 2026-09-30 起支持两种写法（用户要求档案里能直接填"与北京差几小时"）：
 *   ① 纯数字（-12 / +3 / 0 / -2.5）= 手填的时差，优先；
 *   ② IANA 时区名（America/New_York）= 按地区自动推出来的（或老数据），交给 Intl 现算。
 */

/** 手填的时差（与北京相差小时数）；不是纯数字就返回 null（那是 IANA 时区名） */
function tzManualHours(v) {
  const t = String(v == null ? '' : v).trim();
  if (!/^[+-]?\d{1,2}(?:\.\d)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function tzParts(tz) {
  if (!tz) return null;
  try {
    const f = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const p = {};
    for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
    return p;
  } catch (e) {
    return null;
  }
}

/** 「09-24 09:51」这样的当地时间；时区不认就返回空 */
function localTimeOf(tz) {
  // 手填数字：北京（本机）现在几点 + 时差小时数
  const m = tzManualHours(tz);
  if (m !== null) {
    const d = new Date(Date.now() + m * 3600000);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const p = tzParts(tz);
  if (!p) return '';
  return `${p.month}-${p.day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** 客户那边比我们早/晚几小时（+ 表示比北京早） */
function tzOffsetHours(tz) {
  if (!tz) return null;
  const m = tzManualHours(tz);
  if (m !== null) return m;   // 手填的数字本身就是"与北京的小时差"
  try {
    const asLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    if (isNaN(asLocal)) return null;
    const h = Math.round((asLocal.getTime() - Date.now()) / 3600000);
    if (!isFinite(h)) return null;
    return h;
  } catch (e) {
    return null;
  }
}

/** 时差说成人话：比北京晚 15 小时（洛杉矶）、和北京同时区（伦敦）这种 */
function tzOffsetText(tz) {
  const h = tzOffsetHours(tz);
  if (h === null) return '';
  if (h === 0) return '和北京同时区';
  return `比北京${h > 0 ? '早' : '晚'} ${Math.abs(h)} 小时`;
}

/**
 * 中栏顶部的「档案条」：把右栏客户档案里最该随时看见的几项抬到这儿。
 * 按用户要求：14px、加粗；固定两行；必须有「加入时间」和「客户当地时间」。
 */
function renderChatHead(c, data, opt = {}) {
  // 🔴 v2.6.1118（老板 21:45 看图 QQ20261014-214556.png 指名 + 21:48 拍板「客户名也搬到右栏」）：
  //   通用中栏改成跟 Tele① 一样分栏，客户名 + 档案卡整体渲染到**右栏资料卡槽位** #ch-head-slot
  //   （旧的 #chat-head 已从中栏移除，这里保留 id 兼容与外层代码的取用）。
  const head = $('ch-head-slot');
  if (!head) return;
  const joined = fmt(c.created_at || c.joined_at);
  const days = daysSince(c.created_at || c.joined_at);
  // 时区（2026-09-30）：档案里填的是数字就是"与北京的手填时差"，优先；
  // 空着（或老数据存的 IANA 名）就用档案里的时区；都空才回落到"按地区推出来的时区"。
  const tzHand = tzManualHours(c.timezone) !== null ? String(c.timezone).trim() : '';
  const tz = c.timezone || (data && data.autoTimezone) || '';
  const tzTip = tzHand
    ? `手填时差 ${Number(tzHand) > 0 ? '+' : ''}${Number(tzHand)} 小时（客户那边现在几点按它算）`
    : (tz || '未知时区');
  const loc = localTimeOf(tz);
  // 「加入后第几天」：**纯按加入时间算**（加入当天 = Day 1，过零点 +1），
  // 不再取 stage_day —— stage_day 是教练按对话内容判的节奏，跟"加入几天了"不是一回事，
  // 混用会出现「认识第 1 天 Day 2」这种自相矛盾（用户 2026-09-26 点名要改）。
  // 认识第 N 天 = Day（2026-09-29 起 Day 从 1 开始算，加入当天 = Day 1）。
  const dayNo = days !== null ? days : 0;
  const who = esc(c.name || c.code);
  // 🔴 v2.6.1118（老板 21:45 看图 QQ20261014-214556.png + 21:48 拍板）：通用中栏已跟 Tele① 一样分栏，
  //   客户名 + 档案卡**整体搬到右栏资料卡**（#ch-head-slot，它本身就是 .tv-card，不用再套一层）。
  //   卡片内容用**与 Tele① 完全同一套 .tv-* class**，所以字体/颜色/虚线/圆角天然一致。
  //   id 一个都没改（ch-jump / ch-doc / ch-extract / ch-loc），绑按钮的代码照旧能用。
  head.innerHTML = `
      <div class="tv-body">
        <div class="tv-head">
          <span class="code">${esc(c.code)}</span>
          <span class="name-label">名称:</span>
          <span class="cname">${esc(c.name || '未命名')}</span>
          <!-- Signal 渠道标记（2026-10-08 老板指定位置）：紧跟客户名，WhatsApp 客户不显示。 -->
          ${isSignalCustomer(c) ? signalTagHtml() : ''}
        </div>
        <div class="tv-ln"><b class="tv-f-joined">加入时间</b><span class="tv-val">${esc(joined || '—')}</span></div>
        ${days !== null ? `<div class="tv-ln"><i class="tv-star">★</i><i class="tv-sub-joined">认识</i><span class="tv-day-num">第 ${days} 天</span><i class="tv-star">★</i><b class="tv-fact-day" title="加入后第几天：按加入时间算，加入当天 = Day 1">Day ${dayNo}</b></div>` : ''}
        <!-- 「地区」永远都在：没抽到也显示「未填」，不能整行消失。 -->
        <div class="tv-ln sep"><b class="tv-f-region">地区</b>${c.region ? `<span class="chip chip-region">${esc(c.region)}</span>` : '<span class="tv-empty">未填</span>'}</div>
        <div class="tv-ln" title="${esc(tzTip)}"><b class="tv-f-loc">客户当地时间</b><span class="tv-val" id="ch-loc">${esc(loc || '—')}</span><i class="tv-sub-joined">${esc(tzOffsetText(tz) || (tz ? '' : '（在右栏填了时区就会显示）'))}</i></div>
      </div>
      <div class="tv-actions">
        <button id="ch-jump" class="tv-btn tv-btn-primary"
                title="跳到「${who}」在对应 IM（WhatsApp / Telegram）里的真实聊天窗口：把那个账号的浏览器拉到最前，并自动定位到该客户的对话">↗ 跳到聊天</button>
        <button id="ch-doc" class="tv-btn tv-btn-blue"
                title="打开「${who}」的客户档案（加入时间 / 姓名 / 电话 / 地区 / 时区 / 阶段 + 婚姻 / 生活规律 / 别名 / 老家 / 爱好 / 职业 / 家庭经济 / 父母 / 宠物 / 孩子）">客户档案</button>
        <button id="ch-extract" class="tv-btn tv-btn-blue"
                title="读「${who}」的整段对话，把能确认的档案字段抽出来补进档案（不用先生成建议）；同时按电话号码查一遍 customers 目录，发现同一个人的重复档案就用 AI 合并成一份">对话提档</button>
      </div>`;
  startClock(tz);
  // 头部右端两个按钮（横排）：左=打开这个客户的档案弹窗，右=直接读整段对话抽档案
  const docBtn = $('ch-doc');
  if (docBtn) docBtn.onclick = () => openProfileModal(c.code);
  const exBtn = $('ch-extract');
  if (exBtn) exBtn.onclick = () => extractProfileFromChat(c.code, exBtn);
  const jumpBtn = $('ch-jump');
  if (jumpBtn) jumpBtn.onclick = () => jumpToChat(c.code, jumpBtn);

  /*
   * 补翻没翻的消息 + 补看没看的图片/语音（后台跑，界面不用等）
   *
   * 2026-09-30 收紧：这条以前是「每次重画对话都补翻一轮」，于是形成回环 ——
   *   翻好一条 → 广播 translated → 重画 → 又补翻一轮 → 又翻好一条 → …
   * 只要还剩一条永远翻不出来的，这环就停不下来，token 一直烧。
   * 现在只有【用户主动点开这个客户】才补翻一次；
   * 翻译/看图完成引起的重画、新消息到达引起的重画，一律不再补翻
   * （新消息本身在进来那一刻就已经排进翻译队列了，不需要再来一轮）。
   */
  if (opt.noBackfill) return;
  const untranslated = Number(data?.untranslated) || 0;
  const mediaPending = Number(data?.mediaPending) || 0;
  if (untranslated > 0 || mediaPending > 0) {
    backfillTranslations(c.code, untranslated + mediaPending);
  }
}

/**
 * 跳到聊天：调后端 /api/customer/CODE/jump。
 * 后端负责把对应 IM 窗口（WhatsApp / Telegram）拉到最前并定位到该客户的会话，
 * 手机/桌面端本版都不自动跳转（无稳定接口）。
 * @param {string} code 客户编号
 * @param {HTMLElement} btn 触发按钮（用于临时改文案 + 禁用）
 */
async function jumpToChat(code, btn) {
  if (!code) return;
  const oldLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '跳转中…'; }
  try {
    const r = await api(`/api/customer/${code}/jump`, { method: 'POST' });
    if (r && r.ok) {
      /* located===false = 只跳到了窗口、没定位到具体对话（老板认可的最低要求）。
         这种情况用 info 级提示，诚实说明走到了哪一步，但不报成失败。 */
      if (r.located === false) {
        showNotice('info', (r && r.hint) || '已切到对应 IM 窗口，但没能自动定位到该客户的对话');
      } else {
        const ch = r.account >= 1 && r.account <= 5
          ? 'WhatsApp'
          : (r.account >= 7 && r.account <= 9 ? 'Telegram' : (r.account === 6 ? 'Signal' : '对应窗口'));
        showNotice('ok', `已把「${ch}」窗口拉到最前并定位到该客户`);
      }
    } else {
      // 后端给的 hint 是最贴近用户的解释（比如"没找到运行中的窗口"），没有就退化为 reason
      showNotice('error', (r && (r.hint || r.reason)) || '跳转失败');
    }
  } catch (e) {
    showNotice('error', '跳转请求失败：' + (e && e.message ? e.message : e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldLabel; }
  }
}

/** 客户当地时间每分钟自己走一格（只改那一个节点，不重画整个界面） */
let clockTimer = null;
let clockTz = null;
function startClock(tz) {
  clockTz = tz;
  if (clockTimer) clearInterval(clockTimer);
  if (!tz) return;
  clockTimer = setInterval(() => {
    const el = $('ch-loc');
    if (!el) return;
    const t = localTimeOf(clockTz);
    if (t) el.textContent = t;
  }, 30000);
}

/**
 * 打开某个客户的对话
 * @param {string} code
 * @param {object} opt {keepSuggest:true} 兼容旧调用（2026-10-09 起右栏不再显示建议，
 *        建议已改到独立浮窗里出，所以这个开关现在没有实际作用了）
 *        （翻译是后台补的，随时可能有 translated 事件把对话区重画一遍，
 *          不能顺手把用户刚生成的建议抹掉）
 */
async function openCustomer(code, opt = {}) {
  // opt.noBackfill = true：只是重画（翻译好了 / 有新消息 / 我回了），不要顺手补翻一轮
  //                        （2026-09-30：那一轮补翻会和"翻完就重画"形成死循环，一直烧 token）
  state.activeCode = code;
  state.suggest = null;
  state.msgSuggest = null;
  for (const el of document.querySelectorAll('.cust')) {
    el.classList.toggle('active', el.dataset.code === code);
  }

  const data = await api(`/api/customer/${code}`);
  if (data.error) return;

  const c = data.customer;
  state.customer = c;
  renderChatHead(c, data, opt);
  // 🔴 v2.6.1118：原来这里还有一句「删掉旧中栏头部那行副标题」的清理（id 是 chat-sub，
  //   写成 chat 加 sub 两段）。通用中栏已分栏、头部整块移除，那个 id 在 index.html 里
  //   已不存在，这句删掉（留着只是死代码 + 会被「app.js 引用的 id 都有落点」断言判成缺落点）。
  //   现在副标题的位置是左栏对话区顶部那条「对话信息」右侧的 #gen-chat-sub。
  const gsub0 = $('gen-chat-sub');
  if (gsub0) gsub0.textContent = `${c.name || c.code} · ${c.region ? c.region + ' · ' : ''}加入 ${fmt(c.created_at || c.joined_at) || '—'}`;

  // 方案 C（2026-09-30）：只渲染最近 WINDOW 条，更早的等滚到顶再懒加载。
  // 这样客户有几千条消息时，界面里始终只有几十个气泡节点，不会每次重画都卡。
  const all = data.messages || [];
  const windowed = all.slice(-WINDOW);
  renderMessages(windowed);
  state.hasMoreOlder = all.length > windowed.length;
  state.oldestId = windowed.length ? windowed[0].id : 0;
  state.loadingOlder = false;
  state.newMsgCount = 0;
  updateNewPill();
  // 选中客户时让「话术编排台」跟着切客户：浮窗开着就换内容，没开就不打扰（点顶栏按钮才开窗）
  if (window.Board && typeof window.Board.syncFor === 'function') window.Board.syncFor(code);
  // 档案现在在弹窗里。弹窗关着时顺便把内容准备好（点「档案」立刻就有）；
  // 弹窗正开着（可能在看别的客户）就不要覆盖它，免得把用户正在看/改的档案冲掉。
  const pfOpen = !$('pf-modal')?.classList.contains('hidden');
  if (!pfOpen) {
    state.profileCode = code;
    renderProfile(data);
  }
  // 2026-10-09：右栏已改成「手动自由翻译」面板，不再显示建议（建议在独立浮窗里出），
  // 所以这里不再需要「把右栏上一轮的建议清掉」。
  // 2026-10-11：右栏那个「对话翻译」页签已删（位置错了，改到中栏 Tele① 内），这里不用再刷新它。
}

/** 请后端把没译文的消息 + 没出说明的图片/语音补一遍（后台跑，好一条推一条 translated） */
async function backfillTranslations(code, count) {
  if (state.backfillBusy[code]) return;
  // 节流（2026-09-30）：同一个客户 30 秒内只补翻一次。
  // 频繁点开/切走同一个客户时，队列里那批还在翻，没必要再排一遍。
  const now = Date.now();
  if (state.backfillAt[code] && now - state.backfillAt[code] < 30000) return;
  state.backfillAt[code] = now;
  state.backfillBusy[code] = true;
  try {
    const r = await api(`/api/customer/${code}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 2026-10-11 老板要求：从最新一条往回**最多 20 条**（原来是 12 条）。
      // 只会排「还没有译文」的那几条 —— 翻过的读档不会再翻一次。
      body: JSON.stringify({ max: 20 }),
    });
    if (r && r.ok === false && r.reason && !state.backfillWarned[code]) {
      state.backfillWarned[code] = true;
      showNotice('warn', `有 ${count} 条还没处理：${r.reason}（点顶栏「⚙ 设置 → AI 设置」看一下）`);
    }
  } catch (e) {
    /* 接口没起来就算了 */
  } finally {
    delete state.backfillBusy[code];
  }
}

/** 重画对话区（消息带上"正在翻译 / 正在看图"的状态）
 *  注意：新消息的红/绿数字**不在这里**，而是挂在左栏客户行的红点位置（见 custNumHtml）。
 *  用户明确：数字放左侧、不要放在中间的对话信息里。 */
function renderMessages(msgs) {
  state.messages = msgs || [];
  $('msgs').innerHTML = state.messages.length
    ? state.messages.map((m) => renderBubble(m)).join('')
    : '<div class="empty">暂无消息</div>';
  $('msgs').scrollTop = $('msgs').scrollHeight;
  renderChatStatus();
  renderChatFoot(); // 底部两个按钮的亮/灰跟着这次渲染一起算
}

/* ---------------- 方案 C：窗口化 + 懒加载（2026-09-30） ---------------- */

/** 顶部「↓ N 条新消息」提示条的显隐与数字 */
function updateNewPill() {
  const pill = $('msgs-new');
  if (!pill) return;
  if (state.newMsgCount > 0) {
    pill.classList.remove('hidden');
    const n = $('msgs-new-n');
    if (n) n.textContent = String(state.newMsgCount);
  } else {
    pill.classList.add('hidden');
  }
}

/** 用 SSE 推送来的字段拼成一条消息对象（new_message / out_message 都带这些字段，
 *  所以增量追加时不用为一条新消息去重新拉全部对话） */
function buildMsgFromEvent(d) {
  return {
    id: d.msgId,
    direction: d.direction,
    body: d.body || '',
    body_zh: d.bodyZh || '',
    translateFailed: false,
    translating: !!d.translating,
    untranslated: !!d.translating,
    translateSkipped: false,
    mediaKind: d.mediaKind || '',
    // 2026-10-07 加：附件来源（download=真原图 / base64=临时救的 / none=没抓到）
    mediaSrc: d.mediaSrc || '',
    mediaWaiting: !!d.mediaWaiting,
    mediaWorking: false,
    media_path: d.mediaPath || '',
    media_zh: '',
    msg_ts: d.ts || Date.now(),
    customer_code: d.code,
  };
}

/** 增量追加一条新消息（客户发来 / 我回的），不再整段重画，避免卡顿、也不拽动滚动位置 */
function appendIncoming(d) {
  const m = buildMsgFromEvent(d);
  state.messages.push(m);
  const el = $('msgs');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
  el.insertAdjacentHTML('beforeend', renderBubble(m));
  if (atBottom) {
    el.scrollTop = el.scrollHeight;
    state.newMsgCount = 0;
    updateNewPill();
  } else {
    state.newMsgCount++;
    updateNewPill();
  }
  renderChatStatus();
  renderChatFoot();
}

/** 翻译 / 看图完成后，只更新那一条气泡，不重画整段 */
function updateBubbleTranslated(msgId, bodyZh, mediaZh, error) {
  const m = state.messages.find((x) => x.id === msgId || x.id == msgId);
  if (!m) return;
  if (bodyZh) {
    m.body_zh = bodyZh;
    m.translating = false;
    m.untranslated = false;
  }
  if (mediaZh !== undefined) {
    m.media_zh = mediaZh || m.media_zh || '';
    m.mediaWaiting = false;
    m.mediaWorking = false;
  }
  if (error) {
    m.translateFailed = true;
    m.translating = false;
    m.untranslated = false;
  }
  const b = document.querySelector(`#msgs .bubble[data-id="${msgId}"]`);
  if (b) b.outerHTML = renderBubble(m);
}

/** 滚到顶时加载更早的一批消息，插到最前面（保持视觉位置不跳） */
async function loadOlder() {
  if (state.loadingOlder || !state.hasMoreOlder || !state.activeCode) return;
  state.loadingOlder = true;
  try {
    const r = await api(`/api/customer/${state.activeCode}/messages?before=${state.oldestId}&limit=${WINDOW}`);
    if (r && Array.isArray(r.messages) && r.messages.length) {
      const el = $('msgs');
      const prevH = el.scrollHeight;
      const prevTop = el.scrollTop;
      state.messages = r.messages.concat(state.messages);
      renderMessages(state.messages);
      el.scrollTop = el.scrollHeight - prevH + prevTop; // 维持滚动位置
      state.oldestId = r.messages[0].id;
      state.hasMoreOlder = !!r.hasMore;
    } else {
      state.hasMoreOlder = false;
    }
  } catch (e) {
    /* 拿不到更早的消息就算了，用户还能点开客户重新加载 */
  } finally {
    state.loadingOlder = false;
  }
}


/**
 * 中栏底部那两个按钮的亮/灰（用户 2026-09-26 规则，这是"闸门"）
 *
 *   「✓ 标记已回复」亮起来的条件：这个客户还有没处理的新消息
 *        **并且** 检测到我已经回复了（对话里最新一条是我发的）。
 *        没检测到回复 → 灰的、按不动，鼠标悬停会说明为什么。
 *   「⏭ 跳过消息」：只要还有没处理的新消息就能按（不想回这条就走这个，
 *        作用跟"已回复"一样，也会把左栏那一格收起来）。
 *
 * 判定「已回复」的口径：**最新一条对话是我发的**（db.repliedLast 同口径）。
 * 客户又发来新的一条之后，上一轮的回复就不算数了 —— 得再回一次才能亮。
 */
function renderChatFoot() {
  const msgs = state.messages || [];
  const left = msgs.filter((m) => m.direction === 'in' && !Number(m.processed)).length;
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const first = msgs.length ? msgs[0] : null;

  // 「已回复」口径 —— 目标是：**只要我确实回复过、且没有"我回复之后客户又发来、还没处理"的新消息，
  // 就算已回复，按钮就该能按**。
  //
  // 为什么不用单一"最新一条是否 out"：用户 2026-09-26 截图 #1 打脸——客户在我回复后又发了一条
  //   （如 "new york"），那条若已被标 processed，末尾就不是 out 了，可实际我已回复。旧口径误灰。
  //
  // 采用三层判断，任一成立即算已回复：
  //   ① 后端 db.repliedLast：库里最新一条是我发的（最权威）；
  //   ② 前端：最后一条是我发的；
  //   ③ 兜底：**最后一条「更新过的」消息（in 未处理 / out）是我发的**——
  //      忽略那些"已处理的 in"（历史遗留、看过就算），只看还有没有"等着我回的 in"。
  //      若没有等回的新 in，就认为我这边已经回过了。
  const repliedByMsg = !!last && last.direction === 'out';
  const repliedByDb = !!(state.customer && state.customer.repliedLast);
  const lastSignificant = [...msgs].reverse().find(
    (m) => m.direction === 'out' || !Number(m.processed)
  );
  const repliedBySig = !!lastSignificant && lastSignificant.direction === 'out';
  const replied = repliedByMsg || repliedByDb || repliedBySig;

  // 有没有"进行中的对话"（这个客户至少有一条消息）——决定「标记已回复」能不能按。
  // 关键（用户 2026-09-26 两次强调）：**不要再用 left>0 当门槛**。
  //   left（未处理的 in 消息数）会因为我发出的回复、或历史入库时被标 processed 而变成 0，
  //   结果"明明回了、按钮却还是灰的"。现在只在"这个客户压根没有对话"时才不给按。
  const hasThread = !!first;

  // 「✓ 标记已回复」= 有对话 + 检测到我已经回复了。
  const canMark = hasThread && replied;
  // 「⏭ 跳过消息」= **永远可点**（用户 2026-09-26 明确："这个跳过消息都是可操作的按键，没有限制的"）。
  //   它的语义只是"我不想回这条、把左栏那一格收起来"，不需要任何前置条件。
  const canSkip = true;

  const mark = $('btn-replied');
  if (mark) {
    mark.disabled = !canMark;
    mark.title = !hasThread
      ? '这个客户还没有对话'
      : replied
        ? '检测到你已经回复了 —— 点这里把这条消息框收起来（对话不会删，照旧存进本地档案文件）'
        : '还没检测到你发出的回复：在 WhatsApp 里回复客户之后，这里会自动亮起来。不想回就点右边「⏭ 跳过消息」';
  }
  const skip = $('btn-skip');
  if (skip) {
    // 永远可点（只要还选着某个客户）：不管有没有回复、有没有未处理消息，都能"跳过 / 收起这一格"。
    // 唯一会灰的情况：中栏已经被清空（点过「✓ 标记已回复 / ⏭ 跳过消息」）——那时没有对象可跳。
    skip.disabled = !state.activeCode;
    skip.title = state.activeCode
      ? '不想回这条（或已经处理完）：点一下把这一格收起来，中栏也一起清空（对话照样存本地档案文件）'
      : '当前没有选中的客户（上一条已处理完并收起）';
  }
  // 「⚡ 生成建议」同样只在选着客户时可按：没对话时不给按，免得"点了没反应"
  const bsBtn = $('btn-suggest');
  if (bsBtn) bsBtn.disabled = !state.activeCode || !!state.suggestBusy;
  const hint = $('chat-foot-hint');
  if (hint) {
    hint.textContent = !state.activeCode
      ? '当前没有选中的客户 —— 上一条已处理完并收起（对话完整保存在本地档案里）'
      : replied
        ? '检测到你的回复了 → 点「✓ 标记已回复」把这一格收起来；不想回也可点「⏭ 跳过消息」'
        : left > 0
          ? '等你回复后「✓ 标记已回复」才会亮；不想回就点「⏭ 跳过消息」'
          : '「⏭ 跳过消息」随时可点，用来把左栏这一格收起来';
  }
}

/**
 * 对话区顶部那条状态（就在客户名/档案条的正下方）：
 *   - 有消息在翻 / 有图片语音在看 → 「⟳ 等待翻译中…」
 *   - 有没翻的但 AI 没配       → 告诉他去填 key
 *   - 都处理好了               → 整条隐藏
 */
function renderChatStatus() {
  const el = $('chat-status');
  if (!el) return;
  const msgs = state.messages || [];
  const waiting = msgs.filter((m) => m.translating).length;
  const todo = msgs.filter((m) => m.untranslated).length;
  const failed = msgs.filter((m) => m.translateFailed).length;
  const media = msgs.filter((m) => m.mediaWaiting || m.mediaWorking).length;

  if (waiting || todo || media || failed) {
    const parts = [];
    if (waiting || todo) parts.push(`${waiting || todo} 条正在翻译`);
    if (media) parts.push(`${media} 条在看图/听语音`);
    if (failed) parts.push(`${failed} 条没翻出来（已停自动重试，点气泡里的「重翻」可再试一次）`);
    const n = parts.join(' · ');
    // 2026-09-30：还在翻的才说"等待翻译中…"；只剩"没翻出来"的不再假装在等，
    // 直接说清楚是它翻不出来、以及怎么手动救（不然"等待"和"已停止重试"自相矛盾）
    const working = !!(waiting || todo || media);
    if (!working) {
      el.className = 'chat-status warn';
      el.textContent = n;
      return;
    }
    el.className = `chat-status ${state.aiReady ? 'busy' : 'warn'}`;
    el.innerHTML = state.aiReady
      ? `<span class="spin"></span> 等待翻译中…（${n}，好了会自动出现在下面）`
      : `<span class="spin"></span> 等待翻译中…（${n}）`
        + ' —— AI 未配置，点顶栏「⚙ 设置 → AI 设置」填 API Key，这里就会自动出中文';
    return;
  }
  el.className = 'chat-status hidden';
  el.textContent = '';
}

/**
 * 客户发来的图片 / 语音 / 文件怎么显示（2026-10-07 加）
 *
 * 以前只有一行「📎 文件名」，图片要点开文件夹才看得见。现在：
 *   · 图片 → 直接显示缩略图（点一下在新标签打开原图）
 *   · 语音 → 内置播放器，直接能听
 *   · 其它 → 文件名 + 可点链接（下载/打开）
 *
 * 路径里存的是本机绝对路径（…\data\media\1A00013_1757...jpg），
 * 取文件名后交给服务端 /media/ 路由（见 src/server.js，那里做了目录穿越防护）。
 */
function renderMedia(m) {
  const src = m.media_src || m.mediaSrc || '';
  const name = String(m.media_path || '').split(/[\\/]/).pop() || '';
  // 🔴 2026-10-07：用真实 msg.type 区分图片和贴纸。贴纸也是 webp，
  //   光看扩展名会被当成图片（media.kindOf 的老毛病）。
  const type = String(m.mediaType || m.media_type || '').toLowerCase();
  // 内置 WA webview 抓不到真图时，body 里可能还留着整串 base64（真实媒体字节）→ 直接当临时媒体渲染
  const b64Uri = mediaDataUri(m);
  // base64 救出来的图会随消息刷新失效，标一下别当成正式存档
  const tempTag = (src === 'base64' || b64Uri) ? '<span class="media-temp" title="从消息正文里抢救出来的临时媒体，WhatsApp 里消息刷新后可能失效">临时</span>' : '';

  /*
   * 2026-10-07 加：src==='none' = 这是一条媒体消息，但**图片没抓到**。
   * 以前这种情况 media_path 是空的 → 整块不渲染 → 气泡里什么都不显示，
   * 看起来像"消息丢了"。现在先试 base64 临时渲染，再给占位，让人知道对方确实发过东西。
   */
  if (!name) {
    if (b64Uri) {
      if (b64Uri.render === 'video') return `<div class="media"><video class="media-thumb" src="${esc(b64Uri.uri)}" controls preload="metadata"></video><div class="media-name">🎬 视频（临时） ${tempTag}</div></div>`;
      if (b64Uri.render === 'audio') return `<div class="media"><audio class="media-audio" src="${esc(b64Uri.uri)}" controls preload="metadata">你的浏览器放不了这段语音</audio><div class="media-name">🎤 语音（临时） ${tempTag}</div></div>`;
      return `<div class="media"><a href="${esc(b64Uri.uri)}" target="_blank" rel="noopener"><img class="media-thumb" src="${esc(b64Uri.uri)}" alt="客户发来的图（临时）" loading="lazy"></a><div class="media-name">🖼 图片（临时） ${tempTag}</div></div>`;
    }
    if (src === 'none') {
      const what = type === 'sticker' ? '贴纸' : (type === 'video' ? '视频' : (type === 'audio' || type === 'ptt') ? '语音' : '图片');
      return `<div class="media media-missing">📷 对方发来一个${esc(what)}，但没能抓下来
        <span class="media-tip">（WhatsApp 刚发完时是这种情况，过一会儿可能能抓到）</span></div>`;
    }
    return '';
  }

  const kind = m.media_kind || m.mediaKind || '';
  const url = `/media/${encodeURIComponent(name)}`;

  if (kind === 'image') {
    const label = type === 'sticker' ? '贴纸' : '图片';
    return `<div class="media">
      <a href="${esc(url)}" target="_blank" rel="noopener" title="点开看原图：${esc(name)}">
        <img class="media-thumb" src="${esc(url)}" alt="客户发来的${label}" loading="lazy"
             onerror="this.closest('.media').classList.add('media-broken');this.remove();">
      </a>
      <div class="media-name">${type === 'sticker' ? '🎭 贴纸' : '🖼 图片'} · ${esc(name)} ${tempTag}</div>
    </div>`;
  }
  if (kind === 'audio') {
    return `<div class="media">
      <audio class="media-audio" src="${esc(url)}" controls preload="metadata">你的浏览器放不了这段语音</audio>
      <div class="media-name">🎤 语音 · ${esc(name)}</div>
    </div>`;
  }
  const label = kind === 'video' ? '🎬 视频' : '📎 文件';
  return `<div class="media">
    <a class="media-link" href="${esc(url)}" target="_blank" rel="noopener">${label} · ${esc(name)} ${tempTag}</a>
  </div>`;
}

/**
 * 媒体消息的**纯占位正文**（后端 saveMedia/messageBody 写进 body 的那些）。
 * 🔴 2026-10-08 老板要求：既然下面已经显示了缩略图/播放器，
 *    气泡里那行「[图片]」「[贴纸]」…就是多余的，不再重复显示。
 */
const MEDIA_PLACEHOLDER_RE = /^\[(图片|视频|贴纸|文件|语音|图片\/附件)\]$/;

/**
 * 画一条消息气泡
 * @param {object} m 消息
 */
function renderBubble(m) {
  const who = m.direction === 'in' ? `${m.customer_code ? '客户' : ''} ${fmt(m.msg_ts)}`.trim() : `我 ${fmt(m.msg_ts)}`;
  // 🔴 2026-10-08 老板要求：媒体消息下面已经渲染了缩略图/播放器，
  //    气泡里那行纯占位（「[图片]」「[贴纸]」…）就不再重复显示。
  //    只在「确实有 media 渲染出来」且「body 就是纯占位、没有别的正文」时才隐藏，
  //    客户若在图上配了文字（body 不止是占位），文字照常显示，绝不吞掉客户说的话。
  const rawBody = String(m.body || '');
  const bodyIsPurePlaceholder = MEDIA_PLACEHOLDER_RE.test(rawBody.trim());
  const bodyGarbage = isBase64Garbage(rawBody);
  // 🔴 2026-10-20 修回归：媒体消息的 body 是 base64 媒体字节（图片/视频缩略图），
  //    当正文显示就是一串乱码 → 不显示；只有客户在媒体上配的真实文字才显示。
  const isMedia = isMediaMessage(m);
  const body = (bodyGarbage || (bodyIsPurePlaceholder && m.media_path)) ? '' : esc(rawBody);
  let zh = '';
  if (isMedia) {
    // 媒体消息的 body_zh 是 AI 把 base64 当文本翻出来的垃圾（"抱歉，这条消息里只有一串乱码…"），绝不显示
    zh = '';
  } else if (m.body_zh) {
    zh = `<div class="zh">译：${esc(m.body_zh)}</div>`;
  } else if (m.translateFailed) {
    // 翻过但没翻出来：明说，并给一个手动重翻的入口。
    // 2026-09-30：自动重试已经封顶（试 2 次就不再试，免得反复烧 token），
    // 想再试只能用户自己点 —— 所以这里的按钮是唯一的重来入口。
    zh = '<div class="zh failed">⚠ 这条没能翻出来（已停止自动重试，不浪费 token）'
      + `<button class="zh-retry" data-retry-tr="${m.id}" title="手动再翻一次这一条">点这里重翻</button></div>`;
  } else if (m.translating || m.untranslated) {
    // 客户发来的（英文）还没有中文 —— 等一会儿就出来，不用用户操心
    zh = '<div class="zh waiting"><span class="spin"></span> 等待翻译中…</div>';
  }

  // 客户发来的图片 / 语音：AI 用中文写一句"这是什么"（看图 ⑤ / 听语音 ⑥）
  let mediaZh = '';
  const icon = m.mediaKind === 'audio' ? '🎤 语音' : m.mediaKind === 'video' ? '🎬 视频' : '🖼 图';
  if (m.media_zh) {
    mediaZh = `<div class="zh media-zh">${icon}：${esc(m.media_zh)}</div>`;
  } else if (m.mediaWaiting || m.mediaWorking) {
    mediaZh = m.mediaKind === 'audio'
      ? '<div class="zh waiting"><span class="spin"></span> 正在听语音…（转成文字后给中文）</div>'
      : '<div class="zh waiting"><span class="spin"></span> 正在看图…</div>';
  } else if (m.mediaKind === 'video') {
    mediaZh = '<div class="zh waiting">🎬 视频：还没接自动识别，点开文件自己看一眼</div>';
  }

  // 客户发来的图片/语音/文件：直接显示，不只是一个文件名
  //   2026-10-07 加：以前只有「📎 文件名」一行字，图片要点开文件夹才看得见。
  //   图片走 <img src="/media/文件名"> 直接显示缩略图，点一下看原图；
  //   语音走 <audio controls> 能直接听；其它附件还是给文件名 + 可点链接。
  const media = (m.media_path || mediaDataUri(m)) ? renderMedia(m) : '';
  // 🔴 2026-10-20：语音(录音)消息但什么都没抓到（body=null、取图失败）→ 给一个明确的"已收到语音"信号，
  // 别无声无息让人以为没收到（老板要求：录音抓不到要有提示）。body 里有 base64 时会走上面的 media 渲染成可播放音频。
  const k = String(m.mediaKind || m.mediaType || m.media_type || '').toLowerCase();
  const voiceSignal = (!media && isMedia && /^(audio|ptt)$/.test(k))
    ? `<div class="media media-missing">🎤 语音留言 · 已收到，但媒体文件没能抓下来（可能已过期）
        <span class="media-tip">（WhatsApp 媒体有时效，过期就取不回；本地没抓到时会显示这条提示而非一片空白）</span></div>`
    : '';

  // 需求③：每条客户消息（in）后面加一个「建议」按钮，点它只针对这一条出 3 条回复（弹窗）。
  // 自己发的（out）不加 —— 那是"我"说的话，不是要回复的对象。
  const bubbleAct = m.direction === 'in'
    ? `<button class="bub-suggest" data-id="${esc(m.id)}" title="只针对这条客户消息，生成 3 条回复建议（弹窗）">建议</button>`
    : '';

  return `<div class="bubble ${m.direction === 'out' ? 'out' : ''}" data-id="${esc(m.id)}">
    <div class="bub-main">
      <div class="who">${esc(who)}</div>
      ${body ? `<div class="body">${body}</div>` : ''}
      ${zh}${mediaZh}${media}${voiceSignal}
    </div>
    ${bubbleAct}
  </div>`;
}

/* ---------------- 档案卡 ---------------- */

/* datetime-local 需要本地时间的 YYYY-MM-DDTHH:mm */
function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 认识第几天（1 起）——【按日历天】算，不是滚动 24 小时。
 * 用户 2026-09-26 明确：加入当天 = 第 1 天；过了本地零点（凌晨）就 +1，第 1 天变第 2 天。
 * 之前是 Math.floor((now-加入)/24h)+1，加入当天下午 3 点加的人，第二天下午 3 点才 +1，
 * 跟"过零点就翻页"对不上，所以改成按日历日相减。
 */
function daysSince(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  return Math.max(0, diff) + 1;
}

/**
 * 「加入后第几天」（1 起）——就是中栏那个紫色 Day 徽标的数。
 * 加入当天 = Day 1；过了零点 = Day 2（对应"认识第 2 天"）。
 * 纯按加入时间算，不再跟 stage_day（内容信号判的节奏）走，
 * 免得出现「认识第 1 天 Day 2」这种自相矛盾的显示（用户 2026-09-26 点名要改）。
 */
function dayIndex(c) {
  const n = daysSince(c && (c.created_at || c.joined_at));
  return n === null ? 0 : n;
}

/* ---------------- 档案弹窗里的「电话号码」显示（🔴 v2.6.1194） ----------------
 * 老板原话：「抓取客户档案的电话号码，带数字的是正确的，这里缺少个 + 号，
 *   一定要加入到数字的前面，如果好友的电话隐藏，这个位置空白没事。」
 *
 * 🔴 为什么必须判 channel：renderProfile 是**四模块共用**组件（WA①~⑤ / Telegram / Signal
 *   都用它）。WA 那边号码的带 + 展示由各自模块负责，这里**只补 Telegram**，
 *   绝不给所有客户无条件加 +（那会波及 WA 的既有显示）。
 *
 * 为什么需要这一层（旧数据也要显示对）：写入层已改成 pickPhoneWithPlus，
 *   但**存量库里已经存着不带 + 的号**（生产库 7A00006 = `85256188141`）。
 *   这里补一层显示，用户点「保存档案」就会把带 + 的值写回库（public/app.js → server.js 原样入库）
 *   —— 顺带把存量数据修好，不需要额外写迁移脚本。
 *
 * 空白处理：好友隐藏电话时 c.phone 为空 → 返回 ''，输入框留空（符合老板要求）。
 */
function tgPhoneShow(c) {
  const raw = String((c && c.phone) || '').trim();
  if (!raw) return '';
  if (String((c && c.channel) || '') !== 'telegram') return raw;   // 非 Telegram：原样，不碰
  return raw.startsWith('+') ? raw : '+' + raw;
}

function renderProfile(data) {
  const c = data.customer;
  const dup = (data.duplicates || []).length
    ? `<div class="warn">⚠ 疑似重复客户：${data.duplicates.map((d) => esc(d.code)).join('、')}（同手机号，可能加了你多个号）</div>`
    : '';

  const days = daysSince(c.created_at);
  const src = c.created_at_source === 'manual' ? '手填' : '自动';

  // 时区（2026-09-30 用户要求）：这一栏改成填「和北京差几小时」的小数字框 ——
  //   填了数字 → 数字优先（比北京晚填负数、快填正数）；
  //   留空     → 按上面「地区」自动算时差（地区和以前一样，会自动带出时区）。
  // 老数据/自动推出来的值是 IANA 名（America/New_York），那种不回填进数字框，按"留空"显示。
  const tzStored = String(c.timezone || '').trim();
  const tzHand = tzManualHours(tzStored);
  const tzAuto = (data && data.autoTimezone) || (tzHand === null ? tzStored : '');
  const autoHours = tzOffsetHours(tzAuto);
  const tzVal = tzHand !== null ? String(tzHand) : '';
  const autoWord = autoHours === null
    ? ''
    : `比北京${autoHours > 0 ? '早' : '晚'} ${Math.abs(autoHours)} 小时`;
  const handWord = tzHand === null
    ? ''
    : (tzHand === 0 ? '和北京同时区' : `比北京${tzHand > 0 ? '早' : '晚'} ${Math.abs(tzHand)} 小时`);
  const tzHint = tzHand !== null
    ? `已手填：${handWord}（以填的数字为准，地区自动算的不生效）`
    : (autoWord ? `留空 = 按「地区」自动：${autoWord}` : '留空 = 按「地区」自动算时差');

  // 客户档案 = 6 个核心字段 + 10 个附加字段。
  // 附加字段存在 customers.profile_json（JSON），不占独立列、不做 schema 改动。
  let extra = {};
  try { extra = JSON.parse(c.profile_json || '{}') || {}; } catch (e) { extra = {}; }
  const xField = (id, label, val) =>
    `<div class="field"><label>${label}</label><input id="${id}" value="${esc(val || '')}"></div>`;

  $('profile').innerHTML = `
    ${dup}
    <div class="field joined">
      <label>加入时间</label>
      <input id="pf-joined" type="datetime-local" value="${esc(toLocalInput(c.created_at))}">
      <span class="joined-sub">${days ? `认识第 ${days} 天` : '未填'} · ${esc(src)}</span>
    </div>
    <div class="field"><label>姓名</label><input id="pf-name" value="${esc(c.name || '')}"></div>
    <div class="field"><label>电话号码</label><input id="pf-phone" value="${esc(tgPhoneShow(c))}" placeholder="抓不到就手动填，如 +44 7726 795080"></div>
    <div class="field"><label>地区（填了自动补时区）</label><input id="pf-region" value="${esc(c.region || '')}"></div>
    <div class="field pf-tzfield"><label>时区</label>
      <div class="pf-tz-row">
        <input id="pf-tz" class="pf-tz-num" type="number" step="0.5" min="-20" max="14"
               inputmode="numeric" placeholder="自动" value="${esc(tzVal)}">
        <button type="button" class="pf-tz-help" id="pf-tz-help"
                title="看看这个数字该怎么填">填写说明</button>
      </div>
      <span class="pf-tz-hint" id="pf-tz-hint">${esc(tzHint)}</span>
      <div class="pf-tz-pop hidden" id="pf-tz-pop"></div>
    </div>
    <!-- 阶段（Day）：2026-09-30 用户要求 —— 只显示「Day + 数字」，其他说明文字一律不要。
         数值与主窗口「认识第 N 天」右边的那个 Day 完全同步（都按加入时间算，加入当天 = Day 1）。 -->
    <div class="field pf-stagefield"><label>阶段（Day）</label>
      <span class="pf-stage-auto" id="pf-stage">Day ${days || 0}</span></div>

    <div class="pf-sep"><span>更多资料（选填 · 可手填，也可点「对话提档」由 DeepSeek 抽取；抽不到的留空）</span></div>
    ${xField('pf-x-marriage', '婚姻情况', extra['婚姻情况'])}
    <!-- WA对话编号（2026-09-29 用户要求）：WhatsApp 给这个客户分配的**内部唯一编号**。
         所谓"抓到的长数字"就是它（@lid 隐私编号），它是身份标识、不是电话号码，
         只在这里只读展示，绝不写进上面的「电话号码」。 -->
    <div class="field pf-idfield">
      <label>WA对话编号</label>
      <input id="pf-wa-id" class="ro" readonly value="${esc(c.wa_jid || '')}"
        title="WhatsApp 给这个客户分配的内部唯一编号（不是电话号码，别填到上面「电话号码」里）">
      <span class="joined-sub">唯一标识 · 不是电话</span>
    </div>
    <div class="field full"><label>生活规律（单独一行）</label><textarea id="pf-x-routine" rows="2">${esc(extra['生活规律'] || '')}</textarea></div>
    ${xField('pf-x-alias', '别名', extra['别名'])}
    ${xField('pf-x-hometown', '老家 / 家乡', extra['老家家乡'])}
    ${xField('pf-x-hobby', '爱好', extra['爱好'])}
    ${xField('pf-x-occupation', '职业', extra['职业'])}
    <div class="field full"><label>家庭经济情况（单独一行）</label><textarea id="pf-x-family" rows="2">${esc(extra['家庭经济情况'] || '')}</textarea></div>
    ${xField('pf-x-parents', '父母', extra['父母'])}
    ${xField('pf-x-pets', '宠物', extra['宠物'])}
    ${xField('pf-x-children', '孩子', extra['孩子'])}

    <div class="hint">文档：${esc((data.docFile || '').split(/[\\/]/).pop() || '未生成')}</div>
  `;

  // 标题只写「客户档案 · 名字」。
  // 2026-09-29 用户要求：原来把整条绝对路径塞在标题里又长又丑，
  // 现在改成标题右边一个「文件路径」按钮，点开才弹出完整路径（见 toggleProfilePath）。
  const titleEl = $('pf-title');
  if (titleEl) {
    const base = c.name ? `客户档案 · ${c.name}` : `客户档案 · ${c.code}`;
    titleEl.textContent = base;
    titleEl.title = data.docFile ? `档案文件：${data.docFile}` : '档案文件还没生成';
  }
  // 路径存起来给「文件路径」按钮用：每次渲染都刷新，切客户不会弹出上一个客户的路径
  state.profileDoc = data.docFile || '';
  // 按「地区」推出来的时区存一份：时区那一栏的提示、填写说明里都要报"按地区算是几小时"
  state.profileAutoTz = tzAuto;
  // 「时区」栏的两个交互（2026-09-30）：按钮点开填写说明；框里一改，下面那行小字立刻跟着变
  const tzHelpBtn = $('pf-tz-help');
  if (tzHelpBtn) tzHelpBtn.onclick = (e) => { e.stopPropagation(); toggleTzHelp(); };
  const tzNum = $('pf-tz');
  if (tzNum) tzNum.oninput = refreshTzHint;
  // 切客户/重渲染时先把弹出层收起来，免得它挂在新客户的按钮上还显示旧路径
  const pop0 = $('pf-path-pop');
  if (pop0) pop0.classList.add('hidden');
  const tzPop0 = $('pf-tz-pop');
  if (tzPop0) tzPop0.classList.add('hidden');

  // 「电话号码」自动填充（2026-10-07）：每次打开档案都判一次。
  // 绿灯（已带 + 且区号合法）→ 后端直接跳过不抓；红灯 → 自动抓一次并填上带 + 的号码。
  const phoneBox = $('pf-phone');
  if (phoneBox) phoneBox.oninput = rejudgePhoneLight;
  if (typeof autoFillPhone === 'function') {
    // 不 await：让弹窗先显示出来，抓取在后面跑（抓取可能要几秒，不能卡住界面）
    setTimeout(() => autoFillPhone(false), 120);
  }
  // 🔴 v2.7.1231（老板要求「有修改才解读」）：
  //   地区框**输入/失焦不再触发** AI —— 只有点「保存档案」且地区真的改过，
  //   后端才会去解读并重算时区（见 server.js 保存档案分支）。
  //   例外：这个客户还没有时区（旧数据/新客户）→ 打开时先补算一次，
  //   否则右侧资料卡上「客户当地时间」只能显示「—」。
  if (typeof autoFillTimezone === 'function' && !c.timezone && String(c.region || '').trim()) {
    setTimeout(() => autoFillTimezone(), 200);
  }
}

/* ---------------- 「电话号码」自动填充 + 状态灯（2026-10-07 v1.0.14）----------------
 *
 * 老板四条需求：
 *   ① 打开档案时号码框为空 → 自动抓取填入
 *   ② 号码框没有 "+" → 重新抓取，填入时前面补 "+"
 *   ③ 标题栏有「📞 抓取」按钮 + 指示灯（绿=已判定带+；红=异常）
 *   ④ 绿灯 = 不做抓取（这是"不用抓"的唯一依据）
 *
 * 🔴 状态灯的判定全部在后端做（/api/phone/fill 同一个接口返回 light + reason），
 *    前端**不自己判断** —— 两边各判一套必然对不上，出了错还查不出是谁判的。
 */

/** 更新标题栏那个指示灯。light: green / red / gray */
function setPhoneLight(light, reason) {
  const el = $('pf-phone-light');
  if (!el) return;
  const c = light === 'green' ? 'green' : (light === 'gray' ? 'gray' : 'red');
  el.className = 'pf-light ' + c;
  el.textContent = '●';
  el.title = reason || '';
}

/**
 * 打开档案时自动判断 + 必要时自动抓取填号。
 * @param {boolean} force true = 老板点了「📞 抓取」按钮，强制重来（无视绿灯）
 */
async function autoFillPhone(force) {
  const code = state.profileCode || state.activeCode;
  if (!code) return;

  const input = $('pf-phone');
  // 没有浏览器会话时不要去戳后端（会白等一轮超时），先把灯摆成红的并说明
  setPhoneLight('gray', '正在判断…');

  try {
    const r = await api('/api/phone/fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, force: !!force }),
    });

    // 后端说不用抓（绿灯）→ 什么都不改，只把灯点绿
    if (r && r.skipped) {
      setPhoneLight('green', r.reason);
      return;
    }

    // 抓到了并写库 → 把号码显示到框里（框里显示带 + 的，库里也已存了）
    if (r && r.filled && r.phone) {
      const box = $('pf-phone');
      if (box && String(box.value).trim() !== String(r.phone)) box.value = r.phone;
      setPhoneLight(r.green ? 'green' : 'red', r.reason);
      if (r.onlyPlus) showNotice('ok', `电话号码已补上国际区号：${r.phone}`);
      else showNotice('ok', `已抓取并填入电话：${r.phone}`);
      return;
    }

    // 没抓到 / 有冲突 / 浏览器没开 → 红灯 + 说清楚为什么（不静默）
    setPhoneLight('red', r && r.reason ? r.reason : '没抓到号码');
    if (r && r.conflict) {
      showNotice('warn', r.reason || '库里已有另一个号码，没敢自动改');
    }
  } catch (e) {
    setPhoneLight('red', '判断失败：' + (e.message || e));
  }
}

/**
 * 地区填了 → 用后端 DeepSeek 自动算「时区 / 与北京时差」，回填并刷新「客户当地时间」。
 * 🔴 只在客户 timezone 还空（还没算过）时才调后端 + 写库，避免重复消耗 AI、也避免覆盖手填的数字时差。
 */
async function autoFillTimezone() {
  const code = state.profileCode || state.activeCode;
  if (!code) return;
  const row = (state.customers || []).find((x) => x.code === code);
  const c = row || state.customer;
  if (!c) return;
  if (c.timezone) return; // 已有（手填数字 / 之前算过的 IANA）→ 不重复算
  const region = String(c.region || '').trim() || String($('pf-region')?.value || '').trim();
  if (!region) return;
  try {
    const r = await api('/api/region/timezone', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, region }),
    });
    if (!r || !r.ok || !r.tz) return;
    if (row && !row.timezone) row.timezone = r.tz;
    if (state.customer && state.customer.code === code && !state.customer.timezone) state.customer.timezone = r.tz;
    state.profileAutoTz = r.tz;
    if (state.activeCode === code && state.customer) renderChatHead(state.customer, {}, { noBackfill: true });
    refreshTzHint();
  } catch (e) { /* 时区算不出来不影响其它功能 */ }
}

/** 号码框内容变化时立刻重判灯（老板手填时给的即时反馈） */
function rejudgePhoneLight() {
  const box = $('pf-phone');
  if (!box) return;
  const v = String(box.value || '').trim();
  if (!v) { setPhoneLight('red', '还没有号码 —— 打开档案时会自动抓取'); return; }
  // 前端只做"最基本"的粗判（有没有 + / 有没有数字），真正的区号合法性由后端判。
  // 粗判只是为了手填时灯光即时响应，不参与任何写库决策。
  const digits = v.replace(/\D/g, '');
  if (!digits) { setPhoneLight('red', '这里没有数字'); return; }
  if (/^\s*\+/.test(v)) setPhoneLight('green', '已带 + —— 点「保存档案」生效');
  else setPhoneLight('red', '还没有国际区号的 + —— 点「📞 抓取」可自动补上');
}


function pfTitle(code) {
  const row = (state.customers || []).find((c) => c.code === code);
  return row?.name ? `客户档案 · ${row.name}` : `客户档案 · ${code}`;
}

/** 打开某个客户的档案弹窗（不切换左边的对话） */
function openProfileModal(code) {
  const target = code || state.activeCode;
  if (!target) return;
  const m = $('pf-modal');
  if (!m) return;
  state.profileCode = target;
  const t = $('pf-title');
  if (t) t.textContent = pfTitle(target);
  const box = $('profile');
  if (box) box.innerHTML = '<div class="hint">正在读取档案…</div>';
  m.classList.remove('hidden');
  reloadProfile(target);
}

function closeProfileModal() {
  const m = $('pf-modal');
  if (m) m.classList.add('hidden');
}

async function saveProfile() {
  const code = state.profileCode || state.activeCode;
  if (!code) return;

  const joined = $('pf-joined')?.value || '';
  const body = {
    name: $('pf-name').value,
    phone: $('pf-phone').value,
    region: $('pf-region').value,
    // 时区（2026-09-30）：框里填的是「和北京差几小时」的数字（比北京晚填负数）。
    // 后端规则：填了数字 → 数字优先；留空（''）→ 按地区自动算，和以前一致。
    timezone: ($('pf-tz')?.value || '').trim(),
    // 阶段（Day）不再手填/提交：它按加入时间自动算（主窗口那个 Day），
    // 这里不带 stage_day，后端就保持原值不动（见 renderProfile 里的只读展示）。
  };
  // 10 个附加字段统一收进 profile_json（键名与 AI 抽取、文档渲染保持一致）
  const extraMap = {
    'pf-x-marriage': '婚姻情况', 'pf-x-routine': '生活规律', 'pf-x-alias': '别名',
    'pf-x-hometown': '老家家乡', 'pf-x-hobby': '爱好', 'pf-x-occupation': '职业',
    'pf-x-family': '家庭经济情况', 'pf-x-parents': '父母', 'pf-x-pets': '宠物', 'pf-x-children': '孩子',
  };
  const extra = {};
  for (const [id, key] of Object.entries(extraMap)) extra[key] = $(id)?.value ?? '';
  body.profile_json = JSON.stringify(extra);
  // 加入时间只在真的改过时才提交，避免每次保存都把手填的来源重新标一遍
  if (joined) {
    const d = new Date(joined);
    if (!isNaN(d)) body.created_at = d.toISOString();
  }

  const btn = $('pf-save');
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '保存中…';
  let conflictMsg = '';
  try {
    const r = await api(`/api/customer/${code}/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // 跨编号查重（v1.0.1，老板要求）：这个电话号码已经被别的编号登记过 →
    // 后端回 409 + phoneConflict。弹窗问「还要不要保存」，不硬拦。
    if (r && r.phoneConflict) {
      btn.textContent = oldText;
      btn.disabled = false;
      const owners = (r.owners || []).map((o) =>
        `${o.code}${o.name && o.name !== o.code ? '（' + o.name + '）' : ''}`
        + (o.customerCode ? ` · 客户 ${o.customerCode}` : '')).join('、');
      const goOn = confirm(
        `${r.error}\n\n`
        + `登记人：${owners}\n\n`
        + `同一批客户被两个人跟，容易撞车。\n`
        + `确定要照样保存吗？（会记一笔"重复仍保存"，管理员在后台看得到）`,
      );
      if (goOn) {
        body.force = 1;
        const r2 = await api(`/api/customer/${code}/profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (r2 && r2.ok === false) throw new Error(r2.error || '保存失败');
        await reloadProfile(code);
        showNotice('warn', r.error + '（已按你的确认保存）', 8000);
        btn.textContent = '已保存 ✓';
      } else {
        conflictMsg = r.error;
        showNotice('warn', '没有保存：' + r.error, 8000);
        btn.textContent = '未保存';
      }
    } else {
      // 保存后刷新档案面板：加入时间来源、认识第几天、自动补的时区都会立即更新
      await reloadProfile(code);
      btn.textContent = '已保存 ✓';
    }
  } catch (e) {
    btn.textContent = '保存失败';
  } finally {
    btn.disabled = false;
    const keep = conflictMsg ? '未保存' : oldText;
    setTimeout(() => { btn.textContent = keep; }, 1500);
  }
  await refreshCustomers(code);
  // 🔴 v2.7.1231：保存后把右侧资料卡（WA①~⑤ 内置页签）也刷一遍 ——
  //   refreshCustomers → openCustomer 只刷「通用」中栏，刷不到 WA 页签自己的资料卡；
  //   不补这一步，改完地区点保存，卡片上的「客户当地时间 / 与北京时间差」还是旧的。
  try {
    const row = (state.customers || []).find((x) => x.code === code);
    const pane = row ? (waInstanceByCode(row.code) || WA_PANES[0]) : WA_PANES[0];
    if (pane && typeof pane.loadProfile === 'function') await pane.loadProfile(code);
  } catch (e) { /* 资料卡刷新失败不影响保存结果 */ }
}

/** 重新拉取并只刷新档案弹窗里的内容（不重排对话、不丢当前建议） */
async function reloadProfile(code) {
  try {
    const data = await api(`/api/customer/${code}`);
    if (!data.error) renderProfile(data);
  } catch (e) {
    /* 接口没起来就算了 */
  }
}

/**
 * 「文件路径」按钮：点一下弹出 / 收起这份客户档案 .md 的完整存放位置。
 * 2026-09-29 用户要求：标题里那串绝对路径太难看 → 收进按钮里，弹层里可一键复制。
 */
function toggleProfilePath(force) {
  const pop = $('pf-path-pop');
  if (!pop) return;
  const willShow = force != null ? !!force : pop.classList.contains('hidden');
  if (!willShow) { pop.classList.add('hidden'); return; }
  const p = state.profileDoc || '';
  pop.innerHTML = p
    ? `<div class="pp-label">这份客户档案存在电脑的这里：</div>
       <div class="pp-path">${esc(p)}</div>
       <div class="pp-acts"><button class="mini" id="pf-path-copy">复制完整路径</button></div>`
    : `<div class="pp-label">这份客户档案还没有生成文件</div>
       <div class="pp-path">点「保存档案」，或点中栏那个「对话提档」，就会自动生成 .md 文件。</div>`;
  pop.classList.remove('hidden');
  const cp = $('pf-path-copy');
  if (cp) cp.onclick = () => copyText(p, cp);
}

/**
 * 「时区」那一栏（2026-09-30 用户要求改成填数字）：
 *   · 框里填「和北京差几小时」——比北京晚填负数、比北京快填正数；留空=按地区自动。
 *   · 右边「填写说明」按钮点开，把时差怎么算一次讲清（用户要的"时间差的说明"）。
 *   · 框下面那行小字跟着输入实时变，一眼知道自己填的会被怎么用。
 */
function tzAutoWord(autoTz) {
  const h = tzOffsetHours(autoTz);
  if (h === null) return '';
  if (h === 0) return '和北京同时区';
  return `比北京${h > 0 ? '早' : '晚'} ${Math.abs(h)} 小时`;
}

function refreshTzHint() {
  const el = $('pf-tz-hint');
  if (!el) return;
  const v = tzManualHours($('pf-tz')?.value);
  const autoWord = tzAutoWord(state.profileAutoTz || '');
  if (v !== null) {
    el.textContent = `已手填：${v === 0 ? '和北京同时区' : `比北京${v > 0 ? '早' : '晚'} ${Math.abs(v)} 小时`}`
      + '（以填的数字为准，地区自动算的不生效）';
  } else {
    el.textContent = autoWord ? `留空 = 按「地区」自动：${autoWord}` : '留空 = 按「地区」自动算时差';
  }
}

function toggleTzHelp(force) {
  const pop = $('pf-tz-pop');
  if (!pop) return;
  const willShow = force != null ? !!force : pop.classList.contains('hidden');
  if (!willShow) { pop.classList.add('hidden'); return; }
  const autoWord = tzAutoWord(state.profileAutoTz || '')
    || '（「地区」还没填，所以算不出来）';
  pop.innerHTML = `
    <div class="pp-label">这个框填的是「和北京差几小时」：</div>
    <div class="tz-line"><b>比北京时间晚</b> → 填<b>负数</b>。例：美国波士顿填 <b>-12</b>（我们中午 12 点，他那边是 0 点）</div>
    <div class="tz-line"><b>比北京时间快</b> → 填<b>正数</b>。例：日本东京填 <b>+1</b></div>
    <div class="tz-line">和北京一样快慢 → 填 <b>0</b>；不是整点的（如印度）可填 <b>-2.5</b></div>
    <div class="tz-line"><b>留空</b> = 按上面的「地区」自动算，现在算出来是：<b>${esc(autoWord)}</b></div>
    <div class="tz-note">填了数字就以你填的为准（地区自动算的暂时不生效）；把数字清空，又回到按地区自动算。</div>`;
  pop.classList.remove('hidden');
}

/** 从整段对话里抽取档案（不用先生成建议）。
 *  code 不传就用弹窗里正在看的那个客户；btn 是主界面那一行上的按钮（用来显示进度）。 */
async function extractProfileFromChat(code, btn) {
  const target = code || state.profileCode || state.activeCode;
  if (!target) return;
  const b = btn;
  if (b) {
    b.disabled = true;
    b.dataset.old = b.textContent;
    b.textContent = '正在读对话…';
  }
  try {
    const res = await api(`/api/customer/${target}/extract`, { method: 'POST' });
    if (res.error) {
      // 抽不动就把原因说出来（界面反馈红线：绝不"点了没反应"）
      showNotice('warn', `提取档案失败：${res.error}`);
      const tip = $('profile');
      if (tip && state.profileCode === target) {
        tip.insertAdjacentHTML('afterbegin', `<div class="warn">${esc(res.error)}</div>`);
      }
      return;
    }
    // 这一趟除了抽档案，还会按电话号码在 customers 目录里查重：
    // 发现同一个号码下有多份档案 → 用 AI 读进来合并成一份（原文件备份在 _merged_backup/）
    const dd = res.dedup || {};
    const dupN = Number(dd.duplicates) || 0;
    if (dupN > 0) {
      const codes = (dd.mergedCodes || []).join('、');
      showNotice('ok',
        `档案已提取。另外发现同一个电话号码下有 ${dupN} 份重复档案（编号 ${codes}），`
        + `已${dd.aiMerged ? '交给 AI ' : ''}合并成一份；原文件没删，备份在 customers/_merged_backup/ 里。`, 8000);
    } else {
      showNotice('ok', '档案已从对话里提取，弹窗/左栏都刷新了');
    }
    // 不传 code：只刷左栏，【不切换】你正在看的那段对话（和「客户档案」按钮一个分寸）
    await refreshCustomers();
    // 抽完档案立刻把弹窗里的内容换掉（不用用户关掉再点开）
    const m = $('pf-modal');
    if (m && !m.classList.contains('hidden') && state.profileCode === target) await reloadProfile(target);
  } catch (e) {
    showNotice('warn', `提取档案失败：${e.message || e}`);
  } finally {
    if (b) {
      b.disabled = false;
      // v2.6.1118：按钮显示文案已改成「对话提档」，恢复时也要用新文案（否则点了会变回旧的「从对话里提取档案」）
      b.textContent = b.dataset.old || '对话提档';
    }
  }
}

/**
 * 中栏底部两个按钮都走这里（用户 2026-09-26 加）
 * @param {boolean} skip true = 「⏭ 跳过消息」（不想回这条）；false = 「✓ 标记已回复」
 *
 * 两个动作的效果一模一样：这条算处理完了 → 左栏那一格收进「已处理」（从眼前消失）。
 * 区别只是语义和提示文案。对话一条都不会删，照样落盘进该编号的本地档案文件。
 */
async function markReplied(skip = false) {
  const code = state.activeCode;
  if (!code) return;
  const btn = skip ? $('btn-skip') : $('btn-replied');
  if (btn && btn.disabled) return; // 灰的按不动（闸门在 renderChatFoot 里算）
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/api/customer/${code}/replied`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skip: !!skip }),
    });
    if (r && r.error) {
      showNotice('warn', r.error);
      return;
    }
    const who = state.customer ? `${state.customer.code} ${state.customer.name || ''}`.trim() : code;
    refreshToday();
    await refreshCustomers(code);
    await refreshState();
    // 需求（2026-09-28）：点完这两个按钮，**中间栏目的消息内容也要一起消失**。
    // 左栏那一格已经移除了，中栏还停在这个人身上会让人以为"没收起来"。
    // 对话一条都没删，完整存在本地档案文件里 —— 只是从眼前清空。
    clearChatPane(`${skip ? '已跳过' : '已标记回复'}：${who} —— 对话已收起（完整记录仍保存在本地档案文件里）`);
    showNotice('ok', skip
      ? `已跳过这条 —— ${who} 从中栏和左栏都收起来了（对话完整保留在本地档案里，来新消息会再冒出来）`
      : `已标记回复 —— ${who} 从中栏和左栏都收起来了（对话完整保留在本地档案里，来新消息会再冒出来）`);
  } finally {
    renderChatFoot(); // 没有选中客户了 → 两个按钮都该灰着
  }
}

/**
 * 把中栏清空，回到"还没选客户"的样子（2026-09-28 加）
 *
 * 触发时机：点「✓ 标记已回复」/「⏭ 跳过消息」之后。
 * 清掉的是**界面上的显示**——消息、名字条、右栏建议都收起来；
 * 数据库和本地档案文件里的对话一条不少（消失 ≠ 删除）。
 */
function clearChatPane(text) {
  state.activeCode = null;
  state.customer = null;
  state.messages = [];
  state.suggest = null;
  state.msgSuggest = null;

  for (const el of document.querySelectorAll('.cust')) el.classList.remove('active');

  // 🔴 v2.6.1118：客户名 + 档案卡搬进右栏资料卡（#ch-head-slot）后，
  //   「没选中客户」时清空的是右栏那个槽位；左边对话区顶部那句提示走 #gen-chat-sub。
  const head = $('ch-head-slot');
  if (head) head.innerHTML = '<div class="tv-empty">点左栏客户看资料</div>';
  const gsub = $('gen-chat-sub');
  if (gsub) gsub.textContent = '选择一个客户，这里列他这段对话';
  const st = $('chat-status');
  if (st) { st.classList.add('hidden'); st.textContent = ''; }

  const msgs = $('msgs');
  if (msgs) msgs.innerHTML = `<div class="empty">${esc(text || '已处理完 —— 对话内容已收起（完整记录仍保存在本地档案文件里）')}</div>`;

  // 没有选中客户 → 「生成建议」按钮也灰着（建议已在独立浮窗里出，右栏不再有建议卡片）
  const bs = $('btn-suggest');
  if (bs) bs.disabled = true;

  startClock(null);   // 客户当地时间那个自走的时钟也停掉
  renderChatFoot();   // 没有选中客户 → 两个按钮都灰
}

/* ---------------- 建议 ---------------- */

/**
 * 生成建议
 * @param {object} opt {attempt:number, avoid:string[], angleOnly:string}
 */
async function generateSuggest(opt = {}) {
  const code = state.activeCode;
  if (!code || state.suggestBusy) return;

  state.suggestBusy = true;
  const btn = $('btn-suggest');
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }

  try {
    const data = await api(`/api/customer/${code}/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attempt: opt.attempt || 0,
        avoid: opt.avoid || [],
        angleOnly: opt.angleOnly || null,
      }),
    });
    if (data.error) {
      if (window.beeSuggest) showNotice('warn', data.error);
      else showNotice('warn', data.error);
      return;
    }

    // 需求②：建议改为独立浮窗展示（suggest.html），不再渲染进右栏；
    // 只针对「我最后一条回复之后」客户发来的新消息（收窄逻辑在 server.js handleSuggest 里）。
    const sug = {
      id: data.suggestionId,
      attempt: data.attempt || 0,
      avoid: opt.avoid || [],
      day: data.day?.day ?? null,
      groups: data.groups || [],
      scene: sceneText(),
      code,
      _cid: 'suggest-float',
    };
    state.suggest = sug;

    if (window.beeSuggest) {
      window.beeSuggest.open(sug);
    } else {
      showNotice('warn', '建议浮窗不可用');
    }
  } finally {
    state.suggestBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = state.suggest?.attempt ? '再换一批' : '生成建议'; }
  }
}

/** 当前对话末尾文本，作为场景存进话术库 */
function sceneText() {
  const bubbles = [...document.querySelectorAll('#msgs .bubble')].slice(-6);
  return bubbles
    .map((b) => {
      const body = b.querySelector('.body')?.textContent || '';
      const zh = b.querySelector('.zh')?.textContent || '';
      return `${body} ${zh}`.trim();
    })
    .filter(Boolean)
    .join('\n')
    .slice(-600);
}

/**
 * 渲染「分组建议」：每条客户留言一组（sgroup），组内 3 张卡。
 * @param {HTMLElement} container 装分组的容器
 * @param {object} sug { id, groups:[{index,message,options:[{angle,text}]}], day, scene, avoid, attempt, _cid }
 * @param {'main'|'popup'} scope 决定采纳/不要这条/翻译时回写哪份 state、重画哪个容器
 */
function renderGroups(container, sug, scope) {
  if (!container) return;
  const groups = (sug && sug.groups) || [];
  if (!groups.length) {
    container.innerHTML = '<div class="hint">这次没有可显示的建议</div>';
    return;
  }
  container.innerHTML = groups.map((grp, g) => {
    const msg = grp.message || '';
    const opts = (grp.options || []).map((o, i) => `
      <div class="opt" data-g="${g}" data-i="${i}">
        <div class="angle">${esc(ANGLE_CN[o.angle] || o.angle || '建议')}</div>
        <div class="text">${esc(o.text)}</div>
        <div class="acts">
          <button class="adopt" data-g="${g}" data-i="${i}">采纳</button>
          <button class="noad" data-g="${g}" data-i="${i}">不采纳</button>
          <button class="tr" data-g="${g}" data-i="${i}">翻译</button>
        </div>
      </div>`).join('');
    return `<div class="sgroup">
      <div class="sg-head" title="${esc(msg)}">客户说：${esc(msg.length > 90 ? msg.slice(0, 90) + '…' : msg)}</div>
      <div class="sg-opts">${opts}</div>
    </div>`;
  }).join('');

  for (const b of container.querySelectorAll('.adopt')) b.onclick = () => adoptOption(Number(b.dataset.g), Number(b.dataset.i), sug, scope);
  for (const b of container.querySelectorAll('.noad')) b.onclick = () => strikeOptionIn(container, Number(b.dataset.g), Number(b.dataset.i), scope);
  for (const b of container.querySelectorAll('.tr')) b.onclick = () => translateOption(Number(b.dataset.g), Number(b.dataset.i), null, sug, scope);
}

/* ---- 不采纳：只把这一条划掉（v2.5.1027，与浮窗 suggest.js 的 strikeOption 同款行为）----
   不调后端、不重出建议、同组另外两条原样不动；旁边留「撤销」可反悔。 */
function strikeOptionIn(container, g, i, scope) {
  if (!container) return;
  const box = container.querySelector(`.opt[data-g="${g}"][data-i="${i}"]`);
  if (!box) return;
  const raw = box.querySelector('.angle');
  const angle = raw ? String(raw.textContent || '').trim() : '建议';
  const txtEl = box.querySelector('.text');
  const text = txtEl ? String(txtEl.textContent || '') : '';

  box.classList.add('struck');
  box.innerHTML = `
    <div class="angle">${esc(angle)} · 已不采纳</div>
    <div class="text struck-text">${esc(text)}</div>
    <div class="acts"><button class="undo">撤销</button></div>`;
  box.querySelector('.undo').onclick = () => {
    box.classList.remove('struck');
    box.innerHTML = `
      <div class="angle">${esc(angle)}</div>
      <div class="text">${esc(text)}</div>
      <div class="acts">
        <button class="adopt" data-g="${g}" data-i="${i}">采纳</button>
        <button class="noad" data-g="${g}" data-i="${i}">不采纳</button>
        <button class="tr" data-g="${g}" data-i="${i}">翻译</button>
      </div>`;
    const a = box.querySelector('.adopt'); if (a) a.onclick = () => adoptOption(g, i, sugFor(container), scope || 'popup');
    const n = box.querySelector('.noad'); if (n) n.onclick = () => strikeOptionIn(container, g, i, scope);
    const t = box.querySelector('.tr'); if (t) t.onclick = () => translateOption(g, i, null, sugFor(container), scope || 'popup');
  };
}

/* 兜底：从当前 state 里找回正在显示的那份建议（撤销按钮要用） */
function sugFor(container) {
  const cid = container && container.id;
  if (cid === 'msg-suggest-groups') return state.msgSuggest;
  return state.suggest || state.msgSuggest;
}

// 2026-10-09：原来这里有个 renderSuggest()，负责把建议画进右栏 #suggest-out。
// 用户需求②把建议改成独立浮窗（suggest.html / suggest.js，走 window.beeSuggest.open），
// 右栏换成了「手动自由翻译」面板，所以这个函数连同 #suggest-out 一起删了。

/** 前端备一份每日目标文案，后端没回时也能显示 */
function dayGoal(day) {
  return {
    1: '让他回第二句，且这句带信息量',
    2: '把「卖家和客人」扭成两个聊宠物的人',
    3: '用作品建立专业信任',
    4: '视频通话，信任跃迁，别谈钱',
    5: '摸清他为什么想要这幅画',
    6: '确定尺寸、摆放、时间',
    7: '给两个方案让他选（成了进流程，没成就退回朋友线）',
  }[day] || '';
}

/* ---- 采纳：先让你改，改完才存（分组模式下针对某组某条） ---- */

function adoptOption(g, i, sug, scope) {
  const cid = (sug && sug._cid) || 'msg-suggest-groups';
  const box = document.querySelector(`#${cid} .opt[data-g="${g}"][data-i="${i}"]`);
  if (!box || !sug) return;
  const grp = sug.groups[g];
  if (!grp) return;
  const opt = grp.options[i];
  if (!opt) return;

  box.innerHTML = `
    <div class="angle">${esc(ANGLE_CN[opt.angle] || opt.angle || '建议')} · 采纳前可改</div>
    <textarea class="edit">${esc(opt.text)}</textarea>
    <input class="note" placeholder="为什么这条好？（选填，会一起记住）">
    <div class="acts">
      <button class="save">记住这条思路</button>
      <button class="cancel">取消</button>
    </div>
  `;

  box.querySelector('.save').onclick = async () => {
    const text = box.querySelector('.edit').value.trim();
    const note = box.querySelector('.note').value.trim();
    if (!text) return;

    const res = await api('/api/suggestion/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        suggestionId: sug.id,
        groupId: g,
        optionIndex: i,
        text,
        note: note || null,
        angle: opt.angle,
        day: sug.day,
        scene: sug.scene,
      }),
    });
    await refreshStats();
    if (res.ok) {
      // 采纳之后「翻译」按钮要留着 —— 记完思路接着就能把这条翻成英文（用改过的那版文字）
      box.innerHTML = `<div class="angle done">已记住 ${res.dedup ? '（同一句已有，次数 +1）' : ''}</div>
        <div class="text">${esc(text)}</div>
        <div class="hint">下次遇到相似场景，会优先往这个路子上靠。</div>
        <div class="acts">
          <button class="tr" data-g="${g}" data-i="${i}">翻译</button>
        </div>`;
      const trBtn = box.querySelector('.tr');
      if (trBtn) trBtn.onclick = () => translateOption(g, i, text, sug, scope);
    }
  };
  box.querySelector('.cancel').onclick = () => renderGroups(document.getElementById(cid), sug, scope);
}

/* ---- 不采纳：记负样本 + 换思路（分组模式） ---- */

/** 不要「某组里的某一条」：记负样本，整批换思路重出 */
async function rejectOption(g, i, sug, scope) {
  if (!sug) return;
  const cid = sug._cid;
  // 2026-10-09：右栏主面板已移除（建议只在浮动窗/弹窗里出），「哪里不对」那个输入框也没有了，
  // 所以 reason 一律留空；负样本照记（后台仍按场景 + 这条建议文本去避开）。
  const reason = null;
  const container = document.getElementById(cid);
  if (container) container.innerHTML = '<div class="hint">记下了，正在换一个切入口重新想…</div>';

  const data = await api('/api/suggestion/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      suggestionId: sug.id,
      groupId: g,
      optionIndex: i,
      reason,
      attempt: sug.attempt,
      avoid: sug.avoid,
      day: sug.day,
      scene: sug.scene,
    }),
  });

  await refreshStats();
  if (data.error) {
    if (container) container.innerHTML = `<div class="warn">${esc(data.error)}</div>`;
    return;
  }

  const newSug = {
    id: data.suggestionId,
    attempt: data.attempt || 0,
    avoid: sug.avoid,
    day: data.day?.day ?? sug.day,
    groups: data.groups || [],
    scene: sug.scene,
    _cid: cid,
  };
  if (scope === 'main') state.suggest = newSug;
  else state.msgSuggest = newSug;

  if (container) renderGroups(container, newSug, scope);
}

// 2026-10-09：原来这里有个 rejectAll()（右栏主面板的「都不行，换一批」），随右栏建议卡一起删了。
// 现在「都不行，换一批」在独立浮窗里，由 suggest.js 自己那份 rejectAll 处理（走 /api/suggestion/reject）。

/* ---------------- 翻译弹窗：选中某条建议 → 出 2-3 个英文版本 ---------------- */

/* ---- 翻译方式：自动（开窗即翻）/ 手动（点「翻译」才翻）。选择记在本机，下次照旧 ---- */
const TR_MODE_KEY = 'bee.trMode';

function getTrMode() {
  try { return localStorage.getItem(TR_MODE_KEY) === 'auto' ? 'auto' : 'manual'; } catch (e) { return 'manual'; }
}

/** 把下拉同步成本机记住的方式（打开弹窗、切方式都走它） */
function syncTrModeSelect() {
  const m = getTrMode();
  const sel = $('tr-mode');
  if (sel && sel.value !== m) sel.value = m;
  return m;
}

function setTrMode(mode) {
  const m = mode === 'auto' ? 'auto' : 'manual';
  try { localStorage.setItem(TR_MODE_KEY, m); } catch (e) { /* 存不住就只这次生效 */ }
  const sel = $('tr-mode');
  if (sel) sel.value = m;
  return m;
}

/** 还没出结果时按当前方式写一句提示；已经有译文/报错就不动它，别把结果冲掉 */
function applyTrHint() {
  const out = $('tr-out');
  if (!out || out.querySelector('.tr-ver') || out.querySelector('.warn')) return;
  out.innerHTML = getTrMode() === 'auto'
    ? '<div class="hint">「自动翻译」已开 —— 打开这个窗口就自动开始翻，不用再点「翻译」（换版本数会重翻）。</div>'
    : '<div class="hint">现在是「手动翻译」—— 点右边「翻译」才开始。想开窗即翻，把上面「方式」改成「自动翻译」。</div>';
}

/* ---- 模型徽章：显示「AI 设置 → ④ 采纳后翻成英文」当前选的那家（不写死 GPT） ---- */
let trSnapCache = null;   // /api/ai/config 的快照（短时间缓存，免得每开一次窗都读盘）
let trSnapAt = 0;

function trProvShort(snap, key) {
  const p = (snap?.catalog?.providers || []).find((x) => x.key === key);
  return p ? (p.short || p.cn) : (key || '未知');
}

function paintTrProvider(el, snap) {
  const st = snap?.taskState?.translateReply;
  const key = (st && st.provider) || '';
  if (!key) {
    el.textContent = '未配置';
    el.classList.add('warn');
    el.title = '还没选「采纳后翻成英文」用哪家 —— 点顶栏「⚙ 设置 → AI 设置」里选一个';
    return;
  }
  const name = trProvShort(snap, key);
  const ready = !!(st && st.ready);
  el.textContent = ready ? name : `${name} · 未配好`;
  el.classList.toggle('warn', !ready);
  el.title = `按「AI 设置 → ④ 采纳后翻成英文」显示的：${name}`
    + (st?.model ? ` · 模型 ${st.model}` : '')
    + (ready ? '' : '（这把 key 还没填好：点顶栏「⚙ 设置 → AI 设置」补上接入地址和 key，再点「测试连接」）');
}

/** 读一次 AI 配置，把模型徽章刷成当前 ④ 用的那家；读不到就保持原样（不影响翻译本身） */
async function syncTrProvider(force) {
  const el = $('tr-provider-label');
  if (!el) return;
  const now = Date.now();
  if (force || !trSnapCache || now - trSnapAt > 5000) {
    try {
      const snap = await api('/api/ai/config');
      if (snap && !snap.error) { trSnapCache = snap; trSnapAt = Date.now(); }
    } catch (e) { /* 保持原样 */ }
  }
  paintTrProvider(el, trSnapCache);
}

/** 点「翻译」按钮：记下中文原文（采纳后可能改过，用改过的那版），打开弹窗
 *  「方式」选了自动翻译 → 开窗即翻；手动翻译 → 等点「翻译」
 *  @param {number} g 组号（某条客户留言）  @param {number} i 组内选项号
 *  @param {string} [textOverride] 采纳后改过的那版文字
 *  @param {object} [sug] 指定从哪份建议取（主面板用 state.suggest，弹窗用 state.msgSuggest）
 *  @param {'main'|'popup'} [scope] */
function translateOption(g, i, textOverride, sug, scope) {
  const s = sug || state.suggest || state.msgSuggest;
  if (!s) return;
  const grp = s.groups[g];
  if (!grp) return;
  const opt = grp.options[i];
  if (!opt) return;
  const text = String(textOverride != null ? textOverride : opt.text || '').trim();
  if (!text) return;

  // 优先用独立翻译浮窗（可拖到主窗口外、顶到最前）；没有桥再退回页内弹窗
  if (window.beeTranslate) {
    window.beeTranslate.open({ text, code: state.activeCode, count: 2 });
    return;
  }

  state.trText = text;
  const src = $('tr-src-text');
  if (src) src.textContent = text;
  syncTrModeSelect();
  const out = $('tr-out');
  if (out) out.innerHTML = '';
  openTranslateModal();
  syncTrProvider(false);            // 徽章跟着「AI 设置」里的选择显示，不是固定 GPT
  if (getTrMode() === 'auto') doTranslate();
  else applyTrHint();
}

function openTranslateModal() {
  const m = $('tr-modal');
  if (m) m.classList.remove('hidden');
}
function closeTranslateModal() {
  const m = $('tr-modal');
  if (m) m.classList.add('hidden');
}

/* ---------------- 需求③：每条客户消息的「建议」按钮 → 弹窗给 3 条 ---------------- */

/** 点消息气泡后的「建议」：只针对这一条客户消息，调 /suggest?messageId= 出 3 条，
 *  改用独立浮窗展示（suggest.html，可拖出主窗口）。 */
async function suggestForMessage(messageId) {
  const code = state.activeCode;
  if (!code) return;
  const m = (state.messages || []).find((x) => String(x.id) === String(messageId));
  if (!m) return;

  // 先把客户原话存一份，浮窗加载/没桥时也能显示来源
  const srcMsg = `${m.body || ''}${m.body_zh ? `\n（译）${m.body_zh}` : ''}`.trim();

  if (!window.beeSuggest) {
    // 兜底：没有浮窗桥就退回原页内弹窗
    const src = $('msg-suggest-src');
    if (src) src.innerHTML = `<div class="src-msg"><b>客户说：</b>${esc(m.body || '')}${m.body_zh ? `<div class="zh">译：${esc(m.body_zh)}</div>` : ''}</div>`;
    const out = $('msg-suggest-groups');
    if (out) out.innerHTML = '<div class="hint">正在为这条消息想 3 条回复…</div>';
    const modal = $('msg-suggest-modal');
    if (modal) modal.classList.remove('hidden');
  } else {
    // 老板 2026-10-18：先立刻弹窗显示骨架，AI 回来再填内容（不等）
    window.beeSuggest.open({
      id: null, attempt: 0, avoid: [], day: null,
      groups: [], scene: srcMsg, code, messageId, _cid: 'suggest-float', pending: true,
    });
  }

  const data = await api(`/api/customer/${code}/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, attempt: 0, avoid: [], angleOnly: null }),
  });

  if (window.beeSuggest) {
    if (data.error) {
      window.beeSuggest.push({ error: data.error, _cid: 'suggest-float' });
      return;
    }
    const sug = {
      id: data.suggestionId,
      attempt: 0,
      avoid: [],
      day: data.day?.day ?? null,
      groups: data.groups || [],
      scene: srcMsg,
      code,
      messageId,
      _cid: 'suggest-float',
    };
    state.msgSuggest = sug;
    window.beeSuggest.push(sug);
    return;
  }

  // 兜底页内弹窗路径（无桥）
  if (data.error) {
    const out = $('msg-suggest-groups');
    if (out) out.innerHTML = `<div class="warn">${esc(data.error)}</div>`;
    return;
  }
  const sug = {
    id: data.suggestionId,
    attempt: 0,
    avoid: [],
    day: data.day?.day ?? null,
    groups: data.groups || [],
    scene: (m.body || ''),
    code,
    messageId,
    _cid: 'suggest-float',
  };
  state.msgSuggest = sug;
  const out = $('msg-suggest-groups');
  if (out) renderGroups(out, sug, 'popup');
  const againBtn = $('msg-suggest-again');
  if (againBtn) againBtn.onclick = msgRejectAll;
}

/** 🔴 v2.6.1142：WA 对话信息面板里点「💡 建议」——只给「最后一条 out 之后」的未回复 in 消息挂的按钮用。
 *  和中间栏 suggestForMessage 不同：WA 页签各自有 activeCode / cfg.accId，不能直接复用 state.activeCode，
 *  所以这里直接拿按钮上的 data-code（= 客户编号）去打 /api/customer/:code/suggest，复用现有浮窗。 */
async function suggestForWaMessage(code, messageId) {
  if (!code || !messageId) return;
  if (!window.beeSuggest) {
    showNotice('info', '正在为这条消息想 3 条回复…');
  } else {
    // 老板 2026-10-18：先立刻弹窗显示骨架，AI 回来再填内容（不等）
    window.beeSuggest.open({
      id: null, attempt: 0, avoid: [], day: null,
      groups: [], scene: '', code, messageId, _cid: 'suggest-float', pending: true,
    });
  }
  const data = await api(`/api/customer/${encodeURIComponent(code)}/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, attempt: 0, avoid: [], angleOnly: null }),
  });
  if (window.beeSuggest) {
    if (data.error) { window.beeSuggest.push({ error: data.error, _cid: 'suggest-float' }); return; }
    const sug = {
      id: data.suggestionId,
      attempt: 0,
      avoid: [],
      day: data.day?.day ?? null,
      groups: data.groups || [],
      scene: '',
      code,
      messageId,
      _cid: 'suggest-float',
    };
    window.beeSuggest.push(sug);
    return;
  }
  if (data.error) { showNotice('warn', data.error); return; }
  const sug = {
    id: data.suggestionId,
    attempt: 0,
    avoid: [],
    day: data.day?.day ?? null,
    groups: data.groups || [],
    scene: '',
    code,
    messageId,
    _cid: 'suggest-float',
  };
  if (window.beeSuggest) window.beeSuggest.open(sug);
  else showNotice('warn', '建议浮窗未就绪，请稍后再点一次');
}

/** 弹窗里的「都不行，换一批」：整批否掉，重新为这条消息出 3 条 */
async function msgRejectAll() {
  const s = state.msgSuggest;
  if (!s) return;
  const wrap = $('msg-suggest-groups');
  if (wrap) wrap.innerHTML = '<div class="hint">记下了，正在换思路…</div>';
  const data = await api('/api/suggestion/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      suggestionId: s.id,
      optionIndex: -1,
      attempt: s.attempt,
      avoid: s.avoid,
      day: s.day,
      scene: s.scene,
    }),
  });
  await refreshStats();
  if (data.error) {
    if (wrap) wrap.innerHTML = `<div class="warn">${esc(data.error)}</div>`;
    return;
  }
  state.msgSuggest = {
    id: data.suggestionId,
    attempt: data.attempt || 0,
    avoid: s.avoid,
    day: data.day?.day ?? s.day,
    groups: data.groups || [],
    scene: s.scene,
    _cid: 'msg-suggest-groups',
  };
  if (wrap) renderGroups(wrap, state.msgSuggest, 'popup');
}

function closeMsgSuggestModal() {
  const m = $('msg-suggest-modal');
  if (m) m.classList.add('hidden');
}

/** 复制英文到剪贴板，给个「已复制」反馈 */
function copyText(t, btn) {
  const done = () => {
    if (btn) {
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = old; }, 1200);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
  } else {
    fallbackCopy(t, done);
  }
}
function fallbackCopy(t, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done();
  } catch (e) { /* 复制失败就随它去，用户手动选 */ }
}

/** 调 /api/translate，把 2-3 个英文版本 + AI 的整体建议渲染出来
 *  用哪家 AI 在「AI 设置 → ④ 采纳后翻成英文」里选（DeepSeek / GPT / Agnes），口吻按所选那家走 */
async function doTranslate() {
  const text = state.trText || '';
  if (!text) return;
  if (state.trBusy) return;             // 自动模式下别重复发同一单
  const count = Number($('tr-count')?.value) || 2;
  const out = $('tr-out');
  const goBtn = $('tr-go');

  state.trBusy = true;
  const who = trSnapCache ? trProvShort(trSnapCache, trSnapCache?.taskState?.translateReply?.provider) : '';
  out.innerHTML = `<div class="hint">翻译中…（${who ? who + ' · ' : ''}按客户信息调口吻，给 ${count} 个版本）</div>`;
  if (goBtn) goBtn.disabled = true;
  try {
    const data = await api('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, code: state.activeCode, count }),
    });
    if (data.error) {
      out.innerHTML = `<div class="warn">${esc(data.error)}</div>`
        + (/key|未配|没配置|没填/i.test(data.error)
          ? '<div class="hint">「采纳后翻英文」要用的那家 AI 还没填好 —— 点顶栏「⚙ 设置 → AI 设置」，在对应的服务商那一段填上接入地址和 key，再点「测试连接」。</div>'
          : '');
      return;
    }
    const versions = data.versions || [];
    const tip = data.tip || '';
    let html = versions
      .map(
        (v, idx) => `<div class="tr-ver">
          <div class="tr-ver-head">版本 ${idx + 1}<button class="x copy" data-t="${esc(v.text)}">复制</button></div>
          <div class="tr-ver-text">${esc(v.text)}</div>
          ${v.zh ? `<div class="tr-ver-zh"><b>中文译文</b>　${esc(v.zh)}</div>` : ''}
          ${v.note ? `<div class="tr-ver-note">建议：${esc(v.note)}</div>` : ''}
        </div>`
      )
      .join('');
    if (tip) html += `<div class="tr-tip"><b>AI 整体建议</b>：${esc(tip)}</div>`;
    const who2 = trProvShort(trSnapCache, data.provider) || data.provider || '';
    html += `<div class="hint">模型：${esc(who2)}${data.model ? ' / ' + esc(data.model) : ''}　·　按客户信息（${esc((state.customer?.region) || '未知地区')}）调整了口吻</div>`;
    out.innerHTML = html;
    for (const b of out.querySelectorAll('.copy')) b.onclick = () => copyText(b.dataset.t, b);
  } catch (e) {
    out.innerHTML = '<div class="warn">翻译接口未连接</div>';
  } finally {
    state.trBusy = false;
    if (goBtn) goBtn.disabled = false;
  }
}

/* ============================================================
   AI 设置 / AI 提示词 / 模拟新消息 —— 2026-09-30 已**整体搬到「全局设置」独立窗口**
   （页面 public/settings.html、逻辑 public/settings.js，主进程里由 openSettingsWindow 打开）。
   入口只有一个：顶栏最右边那个「⚙ 设置」图标（见下面的 btn-settings）。
   改这三样东西请去 settings.js，不要在这里重写一份。
   ============================================================ */
/* ---------------- 手动录入 ---------------- */

function toggleIngest(show) {
  const box = $('ingest');
  if (!box) return;
  const on = show ?? box.classList.contains('hidden');
  box.classList.toggle('hidden', !on);
  if (on) $('ig-ident')?.focus();
}

async function submitIngest() {
  const ident = ($('ig-ident')?.value || '').trim();
  const text = ($('ig-text')?.value || '').trim();
  const hint = $('ig-hint');
  if (!ident) {
    hint.textContent = '先填客户标识——同一个人每次要填一样的，否则会拆成两个客户';
    return;
  }
  if (!text) {
    hint.textContent = '粘贴点内容再录入';
    return;
  }

  const send = $('ig-send');
  send.disabled = true;
  hint.className = 'muted';
  hint.textContent = '录入中…';
  try {
    const data = await api('/api/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ident,
        name: ($('ig-name')?.value || '').trim() || null,
        region: ($('ig-region')?.value || '').trim() || null,
        joinedAt: ($('ig-joined')?.value || '').trim() || null,
        body: text,
      }),
    });

    if (data.error) {
      hint.className = 'muted err';
      hint.textContent = '✗ ' + data.error;
      showNotice('error', '录入失败：' + data.error);
      return;
    }

    $('ig-text').value = '';
    hint.className = 'muted';
    hint.textContent = `✓ 已录入 ${data.count} 条 → 客户 ${data.code}${data.isNew ? '（新建）' : ''}`;
    showNotice('ok', `已录入 ${data.count} 条 → ${data.code}，翻译在后台跑，稍等就出中文`);
    await refreshState();
    await refreshCustomers(data.code);   // 会顺带把这个客户打开
  } catch (e) {
    hint.className = 'muted err';
    hint.textContent = '✗ 连不上本地服务，软件是不是没起来？';
    showNotice('error', '连不上本地服务：' + (e.message || e));
  } finally {
    send.disabled = false;
  }
}

/* ---------------- 实时推送 ---------------- */

/* 一批消息同时在翻的时候，translated 会连着来好几条。
   现在改为「每条就地更新」而不是整段重画，所以不再需要攒批重画定时器。 */

/** Telegram 采集状态条渲染（2026-10-11 加）。让"收集中 / 未登录 / 选择器失效"看得见。 */
/* ---------------- Telegram 应用内登录弹窗（v2.5.1054） ---------------- */

let tgLoginStep = '';
let tgLoginAccount = 0;

function openTgLogin(accountId) {
  tgLoginAccount = accountId || 0;
  tgLoginStep = '';
  const acctEl = $('tg-login-acct');
  if (acctEl) acctEl.textContent = accountId ? `Telegram（${accountId >= 7 ? accountId - 6 : accountId}号）` : '—';
  const st = $('tg-login-status');
  if (st) { st.textContent = '正在连接 Telegram…'; st.className = 'tg-login-status'; }
  showTgStep('');
  const modal = $('tg-login-modal');
  if (modal) modal.classList.remove('hidden');
  // 后端开始交互式登录（会先连 Telegram，再等手机号）
  api('/api/telegram/login/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId }),
  }).catch(() => {});
}

function closeTgLogin() {
  const modal = $('tg-login-modal');
  if (modal) modal.classList.add('hidden');
}

function showTgStep(step) {
  ['phone', 'code', 'password'].forEach((s) => {
    const el = $('tg-step-' + s);
    if (el) el.classList.toggle('hidden', s !== step);
  });
  tgLoginStep = step;
}

function tgLoginOnEvent(d) {
  const st = $('tg-login-status');
  if (d.status === 'await_input') {
    showTgStep(d.step);
    if (st) { st.textContent = d.message || '请输入'; st.className = 'tg-login-status'; }
    const map = { phone: 'tg-login-phone', code: 'tg-login-code', password: 'tg-login-password' };
    const inp = map[d.step] && $(map[d.step]);
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 30); }
  } else if (d.status === 'starting') {
    if (st) { st.textContent = d.message || '连接中…'; st.className = 'tg-login-status'; }
  } else if (d.status === 'success') {
    showTgStep('');
    if (st) { st.textContent = d.message || '登录成功'; st.className = 'tg-login-status ok'; }
    /* 🔴 v2.6.1137：登录成功要把**对应页签**那一格状态条立刻刷成「已登录 · 登出」，
       否则要等下一次 5 秒轮询，老板看着像"登录没生效"。
       tgLoginAccount 是这次在弹窗里的账号号（7=Tele①，8=Tele②，9=Tele③）。 */
    const mp = Number(tgLoginAccount) === 8 ? 'tele2' : 'tele1';
    setTimeout(() => {
      closeTgLogin();
      refreshState();
      refreshCustomers();
      refreshTgStatus(mp);
    }, 1400);
  } else if (d.status === 'cancelled') {
    closeTgLogin();
  } else if (d.status === 'error') {
    if (st) { st.textContent = '⛔ ' + (d.message || '出错了'); st.className = 'tg-login-status err'; }
  }
}

function tgLoginNext() {
  if (tgLoginStep === 'phone') {
    const v = $('tg-login-phone').value;
    if (!v.trim()) return;
    api('/api/telegram/login/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) });
  } else if (tgLoginStep === 'code') {
    const v = $('tg-login-code').value;
    if (!v.trim()) return;
    api('/api/telegram/login/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) });
  } else if (tgLoginStep === 'password') {
    const v = $('tg-login-password').value;
    // 两步密码允许为空（没开两步验证时后端不会再要密码，这里只是兜底）
    api('/api/telegram/login/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) });
  }
}

function tgLoginCancel() {
  api('/api/telegram/login/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(() => {});
  closeTgLogin();
}

/**
 * WA①（内置浏览器）采集状态条（v2.6.1121）。
 *
 * 🔴 为什么必须点亮它：老板铁律「不许静默失败 —— 收没收到、卡在哪一环，
 *    必须一眼看得见」。这个 `#wa1-status` 元素从 v2.6.1094 就在 index.html 里
 *    （第 528 行），但一直没人往里写东西，等于是个摆设。
 *
 * 样式复用 Tele① 那条 `.tg-status`（ok / warn / err / muted 四档），
 * 位置也同一格（.tg-conv-aside 里、对话信息上方），不新造排版。
 */
/** 把 WA 采集状态画到对应页签的状态条（按 account 路由到 WA①~⑤ 里那一个） */
function renderWaStatus(d) {
  const pane = waInstanceByAcc(d && d.account) || WA_PANES[0];
  pane.renderStatus(d);
}

/** 拉一次某个 WA 内置浏览器页签的采集状态（启动时一次 + 之后每 5 秒兜底；实时靠 whatsapp_status 事件） */
async function refreshWaStatus(accId) {
  const aid = Number(accId) || WA_INSTANCES[0].accId;
  try {
    const r = await api('/api/whatsapp/read/state?account=' + aid);
    if (!r) return;
    /* 后端没在跑（接口 404 / 501）→ 不画状态条，免得凭空多一条"采集失败"吓人 */
    if (r.ok === false && r.error) return;
    renderWaStatus({ account: aid, status: r.status || 'starting', text: r.text || '', level: r.level || '' });
  } catch (e) { /* 读不到就不动状态条 */ }
}

/**
 * 把 Telegram 采集状态画到状态条上。
 * 位置：资料卡下方、「Telegram 采集数据」日志上方那一格（老板 2026-10-16 图的红框）。
 *
 * 🔴 v2.6.1137：改按**页签**走 —— Tele① 写 #tg-status、Tele② 写 #tg-status-t2。
 *    Tele② 那个元素 HTML 里一直都在，但以前没有任何代码往里写 → 永远空白、没有登录入口。
 * @param {object} d { id, status, text }（id = Telegram 账号 id：7 / 8 / 9）
 * @param {string} [pane] 'tele1' | 'tele2'，不传按 Tele① 算（老调用方行为不变）
 */
function renderTgStatus(d, pane) {
  const mp = pane || 'tele1';
  const el = tgEl(mp, 'tg-status');
  if (!el) return;
  if (!d || !d.status) {
    el.className = 'tg-status hidden'; el.textContent = '';
    tgLastStatusText[mp] = '';
    return;
  }
  const map = {
    collecting: { cls: 'ok', pre: '✅ ' },
    login_required: { cls: 'warn', pre: '⚠️ ' },
    selector_issue: { cls: 'err', pre: '⛔ ' },
    starting: { cls: 'muted', pre: '… ' },
  };
  const m = map[d.status] || { cls: 'muted', pre: '' };
  const accId = Number(d.id) || (mp === 'tele2' ? 8 : 7);
  // 用 DOM 节点拼，避免把后端文本当 HTML 注入
  el.textContent = '';
  const span = document.createElement('span');
  span.textContent = (m.pre || '') + (d.text || `Telegram：${d.status}`);
  el.appendChild(span);
  if (d.status === 'login_required') {
    el.appendChild(document.createTextNode(' '));
    const btn = document.createElement('button');
    btn.id = tgpId(mp, 'tg-login-btn');
    btn.className = 'tg-login-btn';
    btn.textContent = '去登录';
    btn.onclick = () => openTgLogin(accId);
    el.appendChild(btn);
  } else if (d.status === 'collecting') {
    /* 🔴 v2.6.1137 老板拍板「甲方案」：登出按钮就放状态条里，跟「去登录」同一格同一套排版
       （登出/登录在同一个位置，想得起、找得到）。点它 → 先确认 → 只清这个号的会话凭证。 */
    el.appendChild(document.createTextNode(' '));
    const btn = document.createElement('button');
    btn.id = tgpId(mp, 'tg-logout-btn');
    btn.className = 'tg-login-btn danger';
    btn.textContent = '登出';
    btn.onclick = () => tgLogoutAsk(accId, mp);
    el.appendChild(btn);
  }
  el.className = `tg-status ${m.cls}`;
  // 第三栏日志：只在状态文案变化时记一行（避免 5 秒轮询刷屏）
  if (d.text && d.text !== tgLastStatusText[mp]) {
    tgLastStatusText[mp] = d.text;
    tgLog(d.text);
  }
}

/** 页签里的动态 id：Tele① 用原名，Tele② 统一加 -t2（和 HTML 里静态 id 的后缀规矩一致） */
function tgpId(mp, base) { return mp === 'tele2' ? `${base}-t2` : base; }

/** 拉一次某个 Telegram 页签的采集状态（启动时一次 + 之后每 5 秒兜底；实时靠 telegram_status 事件）。
 *  @param {string} [pane] 'tele1' → 账号 7；'tele2' → 账号 8 */
async function refreshTgStatus(pane) {
  const mp = pane || 'tele1';
  const accId = mp === 'tele2' ? 8 : 7;
  try {
    const r = await api('/api/telegram/status?account=' + accId);
    if (!r || !r.ok) return;
    let status, text;
    if (r.loggedIn) { status = 'collecting'; text = '已登录 · Telegram 采集中'; }
    /* 🔴 v2.6.1137：这里的文案要**留得下右边那颗按钮**。原来写「已配置凭证 · 未登录（点此去登录）」，
       在 Tele② 那格（290px）会把按钮挤到第二行 —— 改成短句，登录/登出按钮都在同一行。 */
    else if (r.hasCred) { status = 'login_required'; text = '未登录 · 点此去登录'; }
    else { status = 'login_required'; text = '未配置凭证 · 请到设置页填写 API ID / Hash'; }
    renderTgStatus({ id: r.accountId || accId, status, text }, mp);
  } catch (e) { /* 读不到就不动状态条 */ }
}

/* ══════════ v2.6.1137 Telegram「登出」（Tele① / Tele② 共用这一个实现） ══════════
 * 老板原话（2026-10-16）：「软件版的 Tele① 标签有登录，也需要有个登出的功能，
 *   我如果要换账号，Tele② 标签里没有登录的入口，这个是另一个账号的登录」。
 *
 * 🔴 老板拍板的范围 = **A 方案**：只清本软件的会话凭证（telegram-session-<id>.txt）+ 停这个号的采集。
 *   客户档案 / 消息、那个号的外部 Chrome 窗口、别的 TG 号 —— 统统不动。
 *   （后端实现在 src/telegramLogout.js，界面只负责问一句「确定吗」然后调接口。）
 *
 * 🔴 登出 = 要重输手机号 + 验证码的重动作 → 必须有一次可见确认，防手滑。
 *    确认浮层是独立的一套（#tg-logout-confirm-*），不去蹭「关闭软件」那套。 */
const TG_PANE_LABEL = { tele1: 'Tele①', tele2: 'Tele②' };
const TG_PANE_WHO = { tele1: 'T①', tele2: 'T②' };
/** 所有 Telegram 页签（目前 Tele① / Tele② 两个；以后加 Tele③ 只动这一行） */
const TG_PANES = ['tele1', 'tele2'];

/** 弹确认浮层，返回 true=确定登出 / false=取消 */
function tgLogoutConfirm(label) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('tg-logout-confirm-overlay');
    const btnOk = document.getElementById('tg-logout-confirm-ok');
    const btnCancel = document.getElementById('tg-logout-confirm-cancel');
    if (!overlay || !btnOk || !btnCancel) {
      showNotice('error', '登出确认框没找到（界面加载不全），请重启软件再试');
      resolve(false);
      return;
    }
    const titleEl = document.getElementById('tg-logout-confirm-title');
    if (titleEl) titleEl.textContent = `确定登出 ${label}？`;
    const done = (v) => {
      overlay.classList.remove('show');
      btnOk.onclick = null;
      btnCancel.onclick = null;
      resolve(v);
    };
    btnCancel.onclick = () => done(false);
    btnOk.onclick = () => done(true);
    overlay.classList.add('show');
  });
}

/** 状态条上的「登出」被点了：确认 → 调接口 → 显结果 → 立刻重刷这一格状态 */
async function tgLogoutAsk(accountId, pane) {
  const mp = pane || 'tele1';
  const label = TG_PANE_LABEL[mp] || (`Telegram ${accountId}`);
  const btn = document.getElementById(tgpId(mp, 'tg-logout-btn'));
  try {
    const yes = await tgLogoutConfirm(label);
    if (!yes) return;
    if (btn) { btn.disabled = true; btn.textContent = '登出中…'; }
    const r = await api('/api/telegram/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: Number(accountId) || 0 }),
    });
    if (!r || r.ok === false) {
      showNotice('error', `${label} 登出失败：${((r && r.error) || '未知原因')}`);
      return;
    }
    showNotice('ok', `${label} 已登出${r.stopped ? '，采集已停' : ''} · ${r.sessionRemoved ? '会话凭证已清（下次要重新输手机号 + 验证码）' : '本来就没有会话凭证'}`);
    try { appendTgLog(mp, 'info', TG_PANE_WHO[mp] || 'T', '已登出 · 点「去登录」可以换另一个号'); } catch (e) { /* 日志写不进不影响主流程 */ }
  } catch (e) {
    showNotice('error', `${label} 登出失败：${(e && e.message) || e}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '登出'; }
    refreshTgStatus(mp);
  }
}

function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('new_message', (e) => {
    const d = JSON.parse(e.data);
    // v1.5.1021：哪个账号(后端 account id)来了新消息，就给对应标签页角标 +1（WA 1~5 / Signal 6）
    if (d.account) bumpTabUnread(d.account);
    refreshState();
    refreshCustomers();
    refreshToday();   // 左栏「今日消息」立刻 +1
    if (d.code === state.activeCode) {
      // 正在看这个客户：只把这条新消息追加到气泡末尾（2026-09-30 方案 C）。
      // 不再整段重画 —— 几千条消息时也不会卡，且不会把滚动位置拽到底部。
      // 新消息进来那一刻后台已经排好翻译了，这里只是显示，不用再补翻一轮。
      appendIncoming(d);
      // 人就在看这个窗口，顺手当作"已经看过了"，别让左边一直挂着红数字
      if (!document.hidden) markReadQuietly(d.code);
    }
    if (document.hidden) document.title = `新消息 · ${d.name || d.code}`;
    // Tele① 原生面板若正可见则顺手保活（应用版走库，列表/气泡已各自轮询+实时广播）
    refreshTgPanelIfOpen();
  });

  // 我发出去的消息（在 WhatsApp 里回复客户）：也要当场进窗口 —— 用户 2026-09-26 要求。
  // 这是「✓ 标记已回复」能亮起来的前提：看见自己回了什么，才谈得上点"已回复"。
  //
  // 2026-09-28 再加一条：如果我回的是**当前没选中**的那个客户，中间栏目要跟过去。
  // 以前这种情况只弹一句提示、中间栏还停在上一个客户身上，用户就会觉得
  // "我在网页版发了消息，主窗口没收到"。自己在 WhatsApp 里按下发送 = 一次明确动作，
  // 跟着切过去是合理的（客户发来的消息不自动切，那条另算）。
  es.addEventListener('out_message', (e) => {
    const d = JSON.parse(e.data);
    refreshCustomers();
    refreshToday();
    refreshState();
    if (d.code === state.activeCode) {
      appendIncoming(d); // 我的回复立刻出现在对话里（只追加一条，按钮跟着亮）
      return;
    }
    showNotice('info', `你刚回了 ${d.name || d.code}：${String(d.body || '').slice(0, 30)}`);
    // 只有「用户没在干别的」时才跟过去：档案弹窗开着就别打断
    if ($('pf-modal') && !$('pf-modal').classList.contains('hidden')) return;
    openCustomer(d.code);
  });

  // 翻译好了：重画一遍，右边「等待翻译中」自己就消掉了。
  // 左栏也跟着刷一下——列表的预览用的就是译文。
  es.addEventListener('translated', (e) => {
    const d = JSON.parse(e.data);
    refreshCustomers();
    // 2026-09-30 方案 C：只更新那一条气泡，不再整段重画（翻译是一批连着来的，整段重画会卡）
    if (d.code === state.activeCode) {
      updateBubbleTranslated(d.msgId, d.bodyZh, d.mediaZh, d.error);
      renderChatStatus();
    }
    if (d.error) showNotice('warn', `有条消息没翻出来：${d.error}`);
    // Tele① 原生面板若正可见则顺手保活（应用版走库，不再依赖 webview 页面）
    refreshTgPanelIfOpen();
  });

  // 🔴 2026-10-20：图片/语音取到了 —— 之前界面**根本不监听**这个事件，所以就算后台把图取回来了，
  //    「对话信息」红框和气泡也不会刷新，看着就像一直没取到。现在取到就当场刷。
  es.addEventListener('mediaFetched', (e) => {
    let d = {};
    try { d = JSON.parse(e.data); } catch (_) { return; }
    refreshCustomers();
    // 更新主气泡里的那条（把占位换成真图）
    if (d.code === state.activeCode) {
      const m = state.messages.find((x) => x.id === d.msgId || x.id == d.msgId);
      if (m) {
        if (d.mediaPath) m.media_path = d.mediaPath;
        if (d.mediaType) m.mediaKind = String(d.mediaType).toLowerCase();
        m.mediaWaiting = false;
        m.mediaWorking = false;
        const b = document.querySelector(`#msgs .bubble[data-id="${d.msgId}"]`);
        if (b) b.outerHTML = renderBubble(m);
      }
    }
    // 刷新右侧「对话信息」的缩略图带（WA①~⑤ 各自一套，按 activeCode 找到对应 pane）
    WA_PANES.forEach((p) => {
      try {
        if (p && p.getActiveCode && p.getActiveCode() === d.code && p.renderConvInfo) p.renderConvInfo(d.code);
      } catch (_) { /* 单个 pane 出错不影响其他 */ }
    });
  });

  es.addEventListener('pending', () => {
    refreshState();
    refreshCustomers();
    refreshToday();
  });

  // 补到身份了（名字 / 电话）：老客户建号时 WhatsApp 没给出来，后来问到了。
  // 界面要跟着变——左栏那一行、中栏头部那个名字都得换成真的。
  es.addEventListener('identity', (e) => {
    const d = JSON.parse(e.data);
    refreshCustomers();
    // 身份（名字 / 电话）变了要刷新头部，整段重画一次（这种事件很少，不卡）
    if (d.code === state.activeCode) openCustomer(d.code, { keepSuggest: true, noBackfill: true });
  });

  es.addEventListener('account', (e) => {
    const d = JSON.parse(e.data);
    showNotice(d.status === 'online' ? 'ok' : 'warn', `账号 ${d.id}：${statusText(d.status)}`);
    refreshState();
  });

  // Telegram 采集状态（2026-10-11 加）：把"收集中 / 未登录 / 选择器失效"常驻显示在状态条上
  // 🔴 v2.6.1137：事件里带账号（7=Tele①，8=Tele②）→ 按账号路由到自己那一格，各写各的
  es.addEventListener('telegram_status', (e) => {
    let d = {};
    try { d = JSON.parse(e.data || '{}'); } catch (err) { return; }
    renderTgStatus(d, Number(d.id) === 8 ? 'tele2' : 'tele1');
  });

  // WA①~⑤（内置浏览器）采集状态（v2.6.1121）：常驻显示在对应页签右半的状态条上。
  // 🔴 v2.6.1134：事件带 account（10~14），按账号路由到对应页签（WA①~⑤），各写各的互不干扰。
  // 跟 Telegram 那条完全分开、各写各的 —— 改了 WA 绝不会碰 Telegram。
  es.addEventListener('whatsapp_status', (e) => {
    let d = {};
    try { d = JSON.parse(e.data || '{}'); } catch (err) { return; }
    renderWaStatus(d);
  });

  // Telegram 应用内登录弹窗进度（v2.5.1054）：后端把"等待手机号 / 验证码 / 密码 / 成功 / 失败"推过来
  es.addEventListener('telegram_login', (e) => {
    let d = {};
    try { d = JSON.parse(e.data || '{}'); } catch (err) { return; }
    tgLoginOnEvent(d);
  });

  /* Telegram 应用版实时刷新（v2.5.1085）：MTProto 收到消息后主进程广播过来，原生界面即时更新 */
  es.addEventListener('telegram_message', (e) => {
    let m = {};
    try { m = JSON.parse(e.data || '{}'); } catch (err) { return; }
    onTelegramMessageLive(m);
    tgLog(`收到新消息 · ${m.name || m.customerCode || ''}`);
    /* 🔴 v2.6.1113 指令①：把「采到消息」写进 Tele①/Tele② 的采集数据日志。
       按消息归属的账号号（7→Tele①，8→Tele②）决定写到哪个页签。 */
    const accNo = Number(m.accountId || m.accId || 0);
    const pane = accNo === 8 ? 'tele2' : 'tele1';
    const who = accNo === 8 ? 'T②' : 'T①';
    const body = String(m.body || m.text || '').trim();
    appendTgLog(pane, 'ok', who, `采到消息 · ${m.name || m.customerCode || '未知客户'}`
      + (body ? `：「${body.slice(0, 40)}${body.length > 40 ? '…' : ''}」` : ''));
  });

  /* 🔴 v2.6.1113 指令①：采集器状态也写进日志（启动中 / 离线 / 出错）。
     老板原话「哪怕没有采集到都需要展示在这里，当成日志」→ 连「启动中」「没登录」
     这种中间态都要有一行，让人一眼知道现在卡在哪一步。 */
  es.addEventListener('telegram_webview', (e) => {
    let d = {};
    try { d = JSON.parse(e.data || '{}'); } catch (err) { return; }
    if (d.status === 'online') appendTgLog('tele1', 'ok', 'T①', '采集器已连接 web.telegram.org');
    else if (d.status === 'starting') appendTgLog('tele1', 'info', 'T①', '采集器启动中…（独立 Chrome 正在打开）');
    /* 🔴 idle = 未启动（老板 18:27 要求：点顶栏 T 按钮才开浏览器，软件不自动弹）。
       这条也要写进日志，老板一眼知道「现在是没点，不是坏了」。 */
    else if (d.status === 'idle') appendTgLog('tele1', 'info', 'T①', '未启动 —— 点顶栏「T①」按钮打开浏览器并登录');
    else if (d.status === 'offline') appendTgLog('tele1', 'err', 'T①', '未连接到 Telegram' + (d.error ? `：${d.error}` : '') + '（顶栏点 T① 按钮打开浏览器登录）');
  });

  es.addEventListener('learned', () => refreshStats());

  // 「全局设置」那扇独立窗口改了东西（AI 配置 / 清空模拟数据）→ 它和主窗口是两个渲染进程，
  // 谁也刷不到谁，所以由后端广播一声，这里自己把该重读的重读一遍。
  // 2026-09-30 加：不然在设置窗口里存完 AI 配置，主窗口那个 AI 状态灯还是老样子。
  es.addEventListener('data_changed', (e) => {
    let d = {};
    try { d = JSON.parse(e.data || '{}'); } catch (err) { /* 没带内容也无所谓 */ }
    trSnapCache = null;    // ④ 用哪家可能被改了 → 下次开翻译弹窗重新读
    refreshState();
    refreshCustomers();
    refreshToday();
    if (d.what === 'sim_clear') refreshStats();
  });

  // v2.6.1100：代理保存后，后端已把新代理应用到分区 session，这里重载对应 webview 使新出口 IP 立即生效。
  // 不动其它 webview，避免无谓刷新（例如只改了 WA①，就不碰 Tele①）。
  es.addEventListener('proxy:changed', (e) => {
    let d = {};
    try { d = JSON.parse(e.data || '{}'); } catch (err) { /* ignore */ }
    const key = d && d.key;
    let wv = null;
    if (key === 'wa1') wv = document.getElementById('wa1-webview');
    // v2.6.1106：Tele① 的网页版 webview 已删除。软件版走 MTProto 官方直连，
    // 代理改动由后端重新应用到那条连接上，不需要在这里重载任何页面。
    if (wv && typeof wv.reload === 'function') {
      try { wv.reload(); } catch (err) { /* ignore */ }
    }
  });

  // 云端（v1.0.1）：登录成功 / 退出 / 被管理员踢下线 → 提示条跟着变。
  // 被踢下线时给一句明确提示（编排台会退回本地，不会把软件卡死）。
  es.addEventListener('cloud', (e) => {
    let d = {};
    try { d = JSON.parse(e.data || '{}'); } catch (err) { /* ignore */ }
    if (d.event === 'kicked') {
      showNotice('warn', '云端：你这个编号被管理员踢下线了，编排台已退回本地数据');
    } else if (d.event === 'evicted') {
      showNotice('warn', `云端：编号在别处登录了${d.by ? '（' + d.by + '）' : ''}，本机已退出`);
    } else if (d.event === 'login') {
      showNotice('ok', `云端已登录：${d.operator ? d.operator.code : ''}`);
    }
    refreshCloudBar().catch(() => {});
  });

  // 需要扫码：只把黄灯点亮 + 一行提示，界面上不显示二维码
  // （扫码在 Chrome 窗口里做，不在主窗口里做——主窗口只管三栏工作区）
  es.addEventListener('qr', (e) => {
    const d = JSON.parse(e.data);
    refreshState();
    showNotice('warn', d.needScan
      ? `账号 ${d.account} 需要扫码：点它右边的「浏览器」，在 Chrome 窗口里扫`
      : `账号 ${d.account}：${d.status || '待扫码'}`);
  });

  // 登录成功：汇报历史同步进度
  es.addEventListener('synced', (e) => {
    const d = JSON.parse(e.data);
    showNotice('ok', `账号 ${d.account} 已登录，历史同步完成，入库 ${d.count} 条`);
    refreshState();
    refreshCustomers();
  });

  es.addEventListener('notice', (e) => {
    const d = JSON.parse(e.data);
    showNotice(d.level || 'info', d.text || '');
  });

  // 🔴 v2.6.1138：新消息提示音的 **WebAudio 兼底**。
  //   主进程那一级走 shell.beep()（系统提示音），但 Windows 里把「系统声音/通知声音」
  //   静音它就一起哑、且没法从代码区分是「没响」还是「系统静音」。
  //   这里用 WebAudio 自己合成一声，不吃系统音量设置那一套，只吃总音量。
  //   独立事件名 notify_sound，🔴 绝不借 new_message / notice（那两个所有渠道共用，借了会串）。
  es.addEventListener('notify_sound', () => {
    try { tgBeep(); } catch (err) { /* 提示层，出不来就算了，绝不影响界面 */ }
  });

  es.onerror = () => {
    const st = $('status');
    st.textContent = '连接中断，正在重试…';
    st.className = 'warn';
  };
  es.onopen = () => refreshState();
}

/* ---------------- 启动 ---------------- */

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = '蜜蜂信息采集';
});

// Esc 关掉客户档案弹窗（和点遮罩、点 × 一个效果）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeProfileModal();
});

$('btn-suggest').onclick = generateSuggest;
// 注意别把点击事件当参数传进去（skip 只认 true/false）
$('btn-replied').onclick = () => markReplied(false);
$('btn-skip').onclick = () => markReplied(true);

/* 客户档案弹窗：关闭（右上 ×、点遮罩、按 Esc 都行）
   「保存档案」按钮现在在弹窗**最上面**（index.html 的 .pf-topbar），是静态元素，
   和关闭按钮一起绑在这里；「从对话里提取档案」在主界面客户行那一栏，绑在 paintCustomers。 */
$('pf-close').onclick = closeProfileModal;
$('pf-mask').onclick = closeProfileModal;
$('pf-save').onclick = saveProfile;

/* 「📞 抓取」按钮（2026-10-07）：档案标题栏那个。点了强制去 WhatsApp 读一次客户资料，
   把号码抓下来填进「电话号码」框（后端会补上国际区号 +）。
   force=true → 无视绿灯强制重来（老板第②条：没有 + 就重新抓）。 */
$('pf-phone-grab').onclick = async (e) => {
  e.stopPropagation();
  const btn = $('pf-phone-grab');
  const code = state.profileCode || state.activeCode;
  if (!code) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '抓取中…';
  setPhoneLight('gray', '正在从 WhatsApp 读客户资料…');
  try {
    await autoFillPhone(true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
};

/* 「文件路径」按钮（2026-09-29 加）：点开弹出这份 .md 的完整存放位置。
   弹出层是 index.html 里的静态元素，所以在这里绑一次；点别处 / 按 Esc 自动收起。 */
$('pf-path').onclick = (e) => { e.stopPropagation(); toggleProfilePath(); };
document.addEventListener('click', (e) => {
  // 「时区」栏那个「填写说明」弹层也一样：点别处收起（点按钮本身不算，见它的 onclick）
  const tzPop = $('pf-tz-pop');
  if (tzPop && !tzPop.classList.contains('hidden')
      && !(e.target && e.target.closest && e.target.closest('.pf-tzfield'))) {
    tzPop.classList.add('hidden');
  }
  const pop = $('pf-path-pop');
  if (!pop || pop.classList.contains('hidden')) return;
  if (e.target && e.target.closest && e.target.closest('.pf-path-wrap')) return;
  pop.classList.add('hidden');
});
// 「WA对话编号」是只读的，点一下整串选中，方便手动复制
$('profile').addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('#pf-wa-id');
  if (el && el.select) el.select();
});

/* 「⚙ 设置」：全局设置独立窗口（AI 设置 / AI 提示词 / 模拟新消息 都在那扇窗里）。
   浏览器里直接开 index.html 调试时没有桌面通道，退化成 window.open 开一个普通窗口。 */
$('btn-settings').onclick = () => {
  if (window.beeSettings && typeof window.beeSettings.open === 'function') {
    window.beeSettings.open();
  } else {
    window.open('/settings.html', 'bee-settings', 'width=1000,height=780');
  }
};

/* 云端提示条上的「点这里登录」→ 直接打开设置窗，并落到「☁ 云端」页签。
   （beeSettings.open 支持传页签名；退化通道就靠 URL 的 #cloud 锚点。） */
$('cb-login').onclick = () => {
  if (window.beeSettings && typeof window.beeSettings.open === 'function') {
    try { window.beeSettings.open('cloud'); } catch (e) { window.beeSettings.open(); }
  } else {
    window.open('/settings.html#cloud', 'bee-settings', 'width=1000,height=780');
  }
};

$('btn-ingest').onclick = () => toggleIngest();
$('ig-close').onclick = () => toggleIngest(false);
$('ig-send').onclick = submitIngest;
// Ctrl/Cmd + Enter 直接录入
$('ig-text').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitIngest();
});

/* 翻译弹窗 */
$('tr-close').onclick = closeTranslateModal;
$('tr-mask').onclick = closeTranslateModal;
$('tr-go').onclick = doTranslate;

/* Telegram 应用内登录弹窗（v2.5.1054） */
$('tg-login-close').onclick = tgLoginCancel;
$('tg-login-mask').onclick = tgLoginCancel;
$('tg-login-next').onclick = tgLoginNext;
$('tg-login-cancel').onclick = tgLoginCancel;
// 输入框里按回车 = 下一步
['tg-login-phone', 'tg-login-code', 'tg-login-password'].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tgLoginNext(); } });
});

/* Tele①（v2.6.1093 改回内置浏览器）：读库的会话列表 / 气泡 / 回复框三块已从HTML 删除，
   下面这些事件绑定的元素随之不存在 —— **必须判空**，否则 undefined.onclick 会让整个脚本在此抛错、
   后面的初始化全不执行（软件看起来就是"启动了但什么都不对"）。
   回复/发图/发视频改为**在 Telegram 网页里自己操作**，本软件不再代发（老板拍板）。 */
const btnTgListRefresh = $('btn-tg-list-refresh');
if (btnTgListRefresh) btnTgListRefresh.onclick = () => loadTgConversations();
const btnTgConvRefresh = $('btn-tg-conv-refresh');
if (btnTgConvRefresh) btnTgConvRefresh.onclick = () => { if (tgActiveCode) loadTgChat(tgActiveCode); };
// v2.5.1088：中栏顶部 40×40 客户头像 → 点开「客户资料」浮层（再点一次收起）
const tgAvatarBtn = $('tg-avatar');
if (tgAvatarBtn) tgAvatarBtn.onclick = () => { const pop = $('tg-userinfo'); if (pop && !pop.hidden) closeTgUserinfo(); else openTgUserinfo(); };
const tuiCloseBtn = $('tui-close');
if (tuiCloseBtn) tuiCloseBtn.onclick = closeTgUserinfo;
/* 🔴 v2.6.1094 第三栏资料卡三个按钮：
     ① 跳到聊天        → 复用中栏头部那个 jumpToChat（原生置顶那套，一个字节不重写）
     ② 客户档案        → 复用 openProfileModal，弹那个 16 项完整窗口
     ③ 从对话里提取档案 → 复用 extractProfileFromChat
   全部复用主面板同款逻辑，只是当前客户换成 Tele① 这个（tgActiveCode）。 */
const tgProfileFull = $('tg-profile-full');
if (tgProfileFull) tgProfileFull.onclick = () => { if (tgActiveCode) openProfileModal(tgActiveCode); };
const tgProfileExtract = $('tg-profile-extract');
if (tgProfileExtract) tgProfileExtract.onclick = () => { if (tgActiveCode) extractProfileFromChat(tgActiveCode, tgProfileExtract); };
/* 🔴 v2.6.1113 Tele② 的同款两个按钮（HTML 复制过去，id 多了 -t2），
   绑同一套逻辑，只是取 Tele② 自己那个页签的当前客户。 */
const tgProfileFull2 = $('tg-profile-full-t2');
if (tgProfileFull2) tgProfileFull2.onclick = () => { const c = tgCodeOf('tele2'); if (c) openProfileModal(c); };
const tgProfileExtract2 = $('tg-profile-extract-t2');
if (tgProfileExtract2) tgProfileExtract2.onclick = () => { const c = tgCodeOf('tele2'); if (c) extractProfileFromChat(c, tgProfileExtract2); };
// v2.6.1106：原「↗ 跳到聊天」（#tg-jump）随网页版内核一起删除 ——
// 现在已经没有 Telegram 网页窗口可跳了。「客户档案 / 从对话里提取档案」两个按钮照旧保留。

// 回复框（v2.5.1087）：图片/视频选择 + 发送 + 取消引用
const tgFile = $('tg-file');
const tgAttachImg = $('tg-attach-img');
if (tgAttachImg && tgFile) tgAttachImg.onclick = () => { tgFile.accept = 'image/*'; tgFile.click(); };
const tgAttachVideo = $('tg-attach-video');
if (tgAttachVideo && tgFile) tgAttachVideo.onclick = () => { tgFile.accept = 'video/*'; tgFile.click(); };
const tgSendBtn = $('tg-send');
if (tgSendBtn) tgSendBtn.onclick = tgSend;
const tgReplyX = $('tg-reply-x');
if (tgReplyX) tgReplyX.onclick = clearTgReply;
const tgInput = $('tg-input');
if (tgInput) tgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); tgSend(); }
});
if (tgFile) tgFile.onchange = () => {
  const f = tgFile.files && tgFile.files[0];
  if (f) tgLog(`已选附件：${f.name}（点「发送」发出）`);
};

/* 需求③：每条客户消息后的「建议」按钮（事件委托，挂在 #msgs 上，
   因为 #msgs 本身不重画，只换内部 innerHTML，委托一次就一直有效） */
const msgsEl = document.getElementById('msgs');
if (msgsEl) {
  msgsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.bub-suggest');
    if (b) suggestForMessage(b.dataset.id);
  });
  // 方案 C（2026-09-30）：滚到顶就懒加载更早的一批，避免一次渲染几千条卡顿
  msgsEl.addEventListener('scroll', () => {
    if (msgsEl.scrollTop < 40 && state.hasMoreOlder && !state.loadingOlder) {
      loadOlder();
    }
  });
}
// 🔴 v2.6.1142：WA 对话信息面板里的「💡 建议」按钮（事件委托挂在 document，覆盖 WA①~⑤ 各页签的 convinfo-body）
document.addEventListener('click', (e) => {
  const b = e.target.closest('.tv-suggest');
  if (b) {
    e.preventDefault();
    suggestForWaMessage(b.dataset.code, b.dataset.id);
  }
});

// 「↓ N 条新消息」提示条：点一下跳到最新（用户在历史里没跟着滚到底时用）
const msgsNewPill = document.getElementById('msgs-new');
if (msgsNewPill) {
  msgsNewPill.addEventListener('click', () => {
    if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
    state.newMsgCount = 0;
    updateNewPill();
  });
}

/* 逐条建议弹窗（需求③）关闭 */
$('msg-suggest-close').onclick = closeMsgSuggestModal;
$('msg-suggest-mask').onclick = closeMsgSuggestModal;

// 「方式」下拉：手动 = 点「翻译」才翻；自动 = 开窗即翻（记在本机，下次照旧）
$('tr-mode')?.addEventListener('change', () => {
  const mode = setTrMode($('tr-mode').value);
  const out = $('tr-out');
  const hasResult = !!(out && out.querySelector('.tr-ver'));
  if (mode === 'auto' && !hasResult) doTranslate();   // 刚切成自动，马上翻一次
  else applyTrHint();
});

// 自动模式下换版本数就重翻；手动模式下只提示你要点「翻译」
$('tr-count')?.addEventListener('change', () => {
  if (getTrMode() === 'auto') doTranslate();
  else applyTrHint();
});

/**
 * 顶栏品牌名后面那行极小的版本号（界面构建戳）。
 * 用途：你怀疑「窗口里的界面和我改的不一样」时，看这一行就知道加载的是哪一份文件
 * —— 它是 public/index.html、app.js、style.css 里最新那个文件的修改时间。
 * 鼠标悬停还能看到 public 目录绝对路径和数据目录。
 */
async function loadBuild() {
  try {
    const v = await api('/api/version');
    // v1.5.1020：版本号（如 1.5.1020）显示在顶栏品牌名右边红框位置，与构建戳分开
    const verEl = $('ver');
    if (verEl) {
      const ver = String(v.version || '').trim();
      verEl.textContent = ver ? `v${ver}` : 'v…';
      verEl.title = `软件版本 ${ver || '读取中'}`;
    }
    const el = $('build');
    if (!el) return;
    const stamp = String(v.build || '').replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/, '$2-$3 $4:$5');
    el.textContent = ` v${stamp || v.build || ''}`;
    el.title = `界面版本 ${v.build}\n界面文件目录：${v.publicDir || ''}\n数据目录：${v.dataDir || ''}\n${v.node || ''}\n\n（这行数字 = public 三个界面文件里最新的修改时间。改完界面重开窗口，它必须跟着变；没变说明加载的还是旧文件，按 F5 强制刷新）`;
  } catch (e) { /* 版本号拿不到不影响使用 */ }
}

/*
 * 「点这里重翻」（2026-09-30）
 * 自动重试封顶之后，没翻出来的消息不会再被反复重试；用户想再试就点气泡上那个小按钮。
 * 用事件委托挂在 document 上：对话区每次重画都会换掉气泡节点，直接绑会丢。
 */
document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('[data-retry-tr]') : null;
  if (!btn) return;
  const id = btn.dataset.retryTr;
  if (!id || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '重翻中…';
  try {
    const r = await api(`/api/message/${id}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r || r.ok === false) {
      showNotice('warn', (r && r.reason) || '这条现在没法重翻（AI 没配，或消息不可翻）');
      btn.disabled = false;
      btn.textContent = '点这里重翻';
    }
  } catch (err) {
    showNotice('warn', '重翻失败，请稍后再试');
    btn.disabled = false;
    btn.textContent = '点这里重翻';
  }
});

/* ---------------- 启动登录浮层（v1.0.3） ----------------
 * 打开软件先填编号 + 密码，登录并同步数据后进入主窗口。
 * 浮层和主窗口同个界面、一样大，盖住主窗；登录加载成功后自动关闭。 */
function initBootLogin() {
  const overlay = $('boot-login');
  if (!overlay) return;
  const form = $('boot-form');
  const codeEl = $('boot-code');
  const passEl = $('boot-pass');
  const errEl = $('boot-err');
  const loading = $('boot-loading');
  const bar = $('boot-bar');
  const statusEl = $('boot-status');
  if (!form || !codeEl || !passEl) return;

  let timer = null;
  // 🔴 进度条只走真实进度：每一步由后端返回的结果驱动，不再"缓动到 92% 硬跳 100"骗人
  let cur = 0;
  let target = 0;
  const setBar = (p) => {
    const v = Math.max(0, Math.min(100, p));
    if (bar) bar.style.width = v + '%';
    cur = v;
  };
  /** 平滑推进到指定百分比（只是视觉缓动，目标值本身必须是真实步骤给的） */
  const gotoTarget = (t) => {
    target = Math.max(0, Math.min(100, t));
    if (timer) clearInterval(timer);
    const step = () => {
      if (cur >= target - 0.5) { setBar(target); timer = null; return; }
      setBar(cur + (target - cur) * 0.25 + 0.6);
    };
    timer = setInterval(step, 60);
  };
  const status = (txt) => { if (statusEl) statusEl.textContent = txt || ''; };

  const showLoading = (txt) => {
    if (form) form.classList.add('hidden');
    if (loading) loading.classList.remove('hidden');
    if (statusEl) statusEl.textContent = txt || '正在登录云端…';
    cur = 0;
    setBar(0);
    gotoTarget(12);
  };
  const showForm = (msg) => {
    if (timer) { clearInterval(timer); timer = null; }
    if (loading) loading.classList.add('hidden');
    if (form) form.classList.remove('hidden');
    if (errEl) errEl.textContent = msg || '';
    cur = 0; target = 0;
    setBar(0);
  };

  async function doLogin() {
    const code = (codeEl.value || '').trim();
    const password = passEl.value || '';
    if (!code || !password) { showForm('编号和密码都要填'); return; }
    if (errEl) errEl.textContent = '';
    showLoading('正在登录云端…');
    try {
      // ---- ① 登录：后端只做登录，不再顺手同步（按下去立刻就有回应）----
      const r = await api('/api/cloud/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password }),
      });
      if (!r.ok) {
        const msg = r.busy ? (r.error || '该编号已经有人在用') : (r.error || '登录失败');
        showForm(msg);
        return;
      }
      gotoTarget(35);

      /*
       * ---- ② 数据同步（老板定的第 2 步，必须看得见）----
       * 后端逻辑：本地已有「本编号」的副本 → 直接读本地、不联网；
       *          没有（或换了编号）→ 去云端拉，跟本地相同的一律跳过不重复加。
       * 后端把每一步的真实结果通过 steps[] 返回，这里逐条显示 —— 都是真的。
       */
      status('正在同步话题碎片与常用话术…');
      let sr = null;
      try {
        sr = await api('/api/boot/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
      } catch (e) { sr = null; }

      const steps = (sr && Array.isArray(sr.steps)) ? sr.steps : [];
      if (steps.length) {
        const base = 35;
        const span = 45;               // 35% → 80%
        for (let i = 0; i < steps.length; i++) {
          status(steps[i]);
          gotoTarget(base + Math.round((span * (i + 1)) / steps.length));
          await new Promise((res) => setTimeout(res, 420));   // 让人看清走到哪一步了
        }
      } else {
        status('数据同步完成');
        gotoTarget(80);
      }
      if (sr && sr.ok === false) {
        // 本地没副本、联网又失败 → 说清楚，但仍然放行（编排台会空着，可到设置→云端重试）
        try { showNotice('error', (sr.error || '数据同步失败') + '（可在「设置 → 云端」点「同步话题」重试）'); } catch (e) { /* ignore */ }
      }

      // ---- ③ 加载界面数据 ----
      status('正在加载界面…');
      gotoTarget(90);
      try { await refreshState(); } catch (e) { /* 忽略 */ }
      try { await loadReplies(true); } catch (e) { /* 忽略 */ }

      /*
       * ---- ④ 后台重活：必须等数据全部就位、界面加载完，才轮到它们 ----
       * （进程扫描 / Signal 采集 / Telegram 网页版 / Word 每小时重建）
       * 以前这些在开机时就偷偷跑了，现在由这一步显式拉起。
       */
      status('正在启动消息采集…');
      gotoTarget(96);
      try { await api('/api/boot/services', { method: 'POST' }); } catch (e) { /* 后台服务起不来不该挡用户进主界面 */ }

      status('加载完成');
      gotoTarget(100);
      await new Promise((res) => setTimeout(res, 300));
      overlay.classList.add('hidden');
    } catch (e) {
      showForm('登录失败：' + (e.message || '网络不通'));
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });

  /*
   * 先看这台机器有没有配过云端：
   *   · 没配（configured=false）→ 本来就没有「编号登录」这回事，
   *     直接放行进主窗，并顺手把后台服务拉起来 ——
   *     🔴 必须拉！后台重活现在全靠 /api/boot/services 触发，
   *        没人调它就永远不会采集消息（没人登录 = 永远没人调）。
   *   · 配了 → 照常显示登录框（老板定的规矩：每次启动都要先登录）
   * 顺便：有旧登录态就预填编号，省得重输。
   */
  try {
    api('/api/cloud/status').then(async (st) => {
      if (st && st.loggedIn && st.operator && st.operator.code) codeEl.value = st.operator.code;
      if (st && st.configured === false) {
        overlay.classList.add('hidden');
        try { await api('/api/boot/services', { method: 'POST' }); } catch (e) { /* 起不来不挡用户 */ }
      }
    }).catch(() => {});
  } catch (e) { /* 忽略 */ }
}

/* ---------------- 右栏页签 + 常用话术库（v1.0.4） ----------------
 * 右栏两个页签：话术库 / AI 建议。
 * 话术库 = 场景（客户夸漂亮 / 说想你了 / 表白 / 谈宗教 / 谈感情状态…）
 *          下挂 3 条不同情绪的回复（温柔甜 / 幽默俏皮 / 克制高冷），中英双语。
 * 数据：登录云端时读写云端「自己编号的仓库」；没登录时只读本地快照。
 * 铁律：主数据只有后台能改；软件里改的只进自己编号的仓库。
 */
let replyScenes = [];
let replyCanEdit = false;
/* 手风琴状态：undefined = 还没定（首次进来展开第一个）；'' = 用户明确全收起；其余 = 展开的那个场景 id。 */
let replyOpenRid;

function initPanelTabs() {
  document.querySelectorAll('.ptab').forEach((b) => {
    b.onclick = () => switchPanelTab(b.dataset.pt);
  });
  const ra = $('btn-lib-refresh');
  if (ra) ra.onclick = () => manualSyncReplies();
  const aa = $('btn-lib-add');
  if (aa) aa.onclick = addReplyScene;
  // 页内「新建场景」输入条（Electron 不支持 window.prompt，只能自己做）
  const nInp = $('lib-new-name');
  const nOk = $('lib-new-ok');
  const nCc = $('lib-new-cancel');
  if (nOk) nOk.onclick = submitReplyScene;
  if (nCc) nCc.onclick = cancelReplyScene;
  if (nInp) {
    nInp.onkeydown = (e) => {
      if (e.key === 'Enter') submitReplyScene();
      else if (e.key === 'Escape') cancelReplyScene();
    };
  }
  initFreeTranslate();
  /* 🔴 v2.6.1112 右栏 ⑤「自动」按钮（老板 2026-10-14 追加要求）：
     「右栏收缩的意思是 400px 直接缩到 80 固定宽度，
      点击『自动』会在弹出来，再点『自动』收缩进去」
     · 只有一个按钮，在 400 ↔ 80 两态之间切（老板原话，不要两套开关）
     · 另带自动降级：开着时窗口变窄，⑤ 自己往下掉（500→400→80），CSS @media 全自动
     · 状态存 localStorage，重开软件还在
     · 快捷键 Alt+P 同效（老板常用手势） */
  const pa = $('panel-auto-toggle');
  if (pa) pa.onclick = togglePanelAuto;
  applyPanelWidthMode();
  syncPanelNarrow();
  window.addEventListener('resize', syncPanelNarrow);
  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); togglePanelAuto(); }
  });
}

/* ---- 右栏 ⑤ 宽度：500 ｜ 400 ｜ 80（老板 2026-10-14 定死） ----
 * 🔴 口径修正过一次：老板原话「右栏收缩的意思是 400px 直接缩到 80 固定宽度，
 *    点击『自动』会在弹出来，再点『自动』收缩进去」。
 *    → 收缩终点是 80px（不是 14、不是 0），且**只有一个按钮**在 400↔80 之间切。
 * 三态：
 *   open = 弹出来（500；窗口<1307 时自动落到 400）
 *   mid  = 中间态（400，窗口再窄自动落到 80）
 *   thin = 收缩进去（80 固定，任何窗口下都是 80）
 * 另加自动降级：开着时窗口变窄，⑤ 自己往下掉（≥1307→500 / 1118~1306→400 / <1118→80）。
 * 状态存 localStorage，重开软件还在。宽度全部交给 style.css 的 @media，JS 只切 class。 */
let panelWidthState = 'open';
try { panelWidthState = localStorage.getItem('panel.width') || 'open'; } catch (e) { /* 隐私模式用默认 */ }

function applyPanelWidthMode() {
  /* 🔴 document.body 在自检桩里可能不存在，必须先判 —— 否则「app.js 顶层无脚本错误」当场变红。
     （同一个坑踩第二次了：桩只有 getElementById / querySelectorAll / addEventListener。） */
  const bd = document.body;
  if (bd) {
    bd.classList.remove('panel-open', 'panel-mid', 'panel-thin');
    bd.classList.add('panel-' + panelWidthState);
  }
  const btn = $('panel-auto-toggle');
  if (!btn) return;
  const thin = panelWidthState === 'thin';
  btn.classList.toggle('on', !thin);
  btn.classList.toggle('off', thin);
  btn.textContent = thin ? '⇤ 自动' : '⇥ 自动';
  btn.title = thin
    ? '点一下弹出来（收着 80px，点这里回到 400）'
    : '点一下收缩进去（收成 80px）';
}
function togglePanelAuto() {
  // 老板原话：「点击『自动』会在弹出来，再点『自动』收缩进去」→ 只在 **400 ↔ 80** 之间切。
  //🔴 注意 open 态也要先落到 mid（400），不能一按就跳到 thin（80）——
  //   否则第一次点按钮会从 500 直接掉到 80，跳过了老板指定的 400 那一档。
  panelWidthState = (panelWidthState === 'thin') ? 'mid' : 'thin';
  try { localStorage.setItem('panel.width', panelWidthState); } catch (e) { /* 忽略 */ }
  applyPanelWidthMode();
  syncPanelNarrow();
  showNotice(panelWidthState === 'thin' ? '右栏收缩到 80px' : '右栏弹出来（400px）');
}
/* ⑤ 是不是已经窄到看不见内容了（决定要不要挂 .narrow 那个竖排按钮形态）
   🔴 自检桩的假元素没有 getBoundingClientRect，必须先判 typeof 再调 —— 这是同一个桩坑的第三次，
      以后凡是摸 DOM 几何的顶层代码，一律先 typeof 判一遍。 */
function syncPanelNarrow() {
  const p = $('panel');
  if (!p || typeof p.getBoundingClientRect !== 'function') return;
  p.classList.toggle('narrow', Math.round(p.getBoundingClientRect().width) <= 90);
}

function switchPanelTab(name) {
  /* 🔴 v2.6.1112：右栏收成 80px 后页签是**竖排可见的**（老板要求竖排按钮），
     所以在收起态点「话术库 / 手动自由翻译」必须**先弹回来再切页** ——
     否则点了没反应，老板会以为按钮坏了。
     规则：收起态点页签 → 先把右栏弹到 400（mid），然后照常切页签。 */
  if (panelWidthState === 'thin') {
    panelWidthState = 'mid';
    try { localStorage.setItem('panel.width', 'mid'); } catch (e) { /* 忽略 */ }
    applyPanelWidthMode();
    syncPanelNarrow();
  }
  document.querySelectorAll('.ptab').forEach((b) => b.classList.toggle('on', b.dataset.pt === name));
  document.querySelectorAll('.pbody').forEach((s) => s.classList.toggle('hidden', s.dataset.pb !== name));
  if (name === 'lib' && !replyScenes.length) loadReplies();
  // 2026-10-11：原「conv」（对话翻译）页签已删 —— 老板纠正位置，改到中栏 Tele① 内。
}

/* ---------------- 中栏页签：通用 / Tele①（2026-10-11 老板要求恢复） ----------------
 *
 * 背景：Telegram 采集连着三版（v2.5.1050/1051/1052）爬 web.telegram.org 都读不到消息，
 *       改走 MTProto 又要 my.telegram.org 的 api_id / api_hash（老板手上没有）。
 *       老板拍板兜底：**做成浏览器内置版**，放回「之前那个位置」（中栏页签），
 *       · 通用   = 原来那个消息框，一个字不动
 *       · Tele①  = Telegram 内置浏览器（webview），至少能在软件里直接开网页版看消息、预填回复。
 *
 * 🔴 为什么必须另起 .mtab / .mid-pane，绝不能复用 .ptab / .pbody：
 *    switchPanelTab() 用 document.querySelectorAll('.ptab') 全页面扫，
 *    中栏要是也用 .ptab，切右栏会把中栏一起切掉（串味）。这里是**独立的一套**。
 *
 * 🔴 铁律没变：内置浏览器只是「看 + 手动预填」，**绝不自动发送**。
 */
function initMidTabs() {
  document.querySelectorAll('.mtab').forEach((b) => {
    b.onclick = () => switchMidTab(b.dataset.mp);
  });
  initTgAddrBar();   // 🔴 v2.6.1093 补回地址栏：网址框 + 前往（webview 懒加载，必须在这里先绑好）
  // 🔴 v2.6.1134：五个内置浏览器页签（WA①~⑤）的地址栏 + 右半按钮，统一按实例循环绑定
  WA_PANES.forEach((p) => { p.initAddrBar(); p.bindButtons(); });
  /* 🔴 v2.6.1112：「对话信息」列的手动收/展开关（Tele① 好友列头部那个「对话 ▤」按钮）。
     Alt+D 快捷键同效 —— 老板在打字时手不离键盘就能收/展这一列。
     🔴 v2.6.1113 Tele② 的那个同名按钮也要绑（HTML 是复制过去的，id 多了 -t2）。 */
  ['tele1', 'tele2'].forEach((pane) => {
    const t = tgEl(pane, 'tg-chat-toggle');
    if (t) t.onclick = toggleTgChat;
  });
  applyTgChatToggle();   // 进软件先把 localStorage 里记住的状态刷到 DOM 上
  initTgCollectLog();    // 🔴 v2.6.1113 指令①：启动就写占位行，日志区绝不空白
  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); toggleTgChat(); }
  });

  // 🔴 2026-10-23 新增第5/6模块：GPT对话（内置浏览器）+ 人设对话（独立 AI 聊天），各自独立、不碰其它模块
  initGptPane();
  initPersonaPane();
}

/* ════════════════════════════════════════════════════════════════════════════
 * GPT对话（第5模块）：软件内置浏览器登录 ChatGPT。
 * 🔴 独立分区 persist:gpt1，不采集、不入库、不与其他 4 套采集逻辑共用任何代码。
 * 🔴「绝不自动发送」铁律同样适用：这里只是看 + 手动填。
 * ════════════════════════════════════════════════════════════════════════════ */
function initGptPane() {
  const wv = $('gpt-webview');
  if (!wv) return;
  const addrText = $('gpt-addr-text');
  const syncAddr = () => { try { if (addrText && wv.getURL) addrText.textContent = wv.getURL(); } catch (_) {} };
  if (wv.addEventListener) { wv.addEventListener('did-navigate', syncAddr); wv.addEventListener('did-stop-loading', syncAddr); }
  const wb = $('gpt-back'), wf = $('gpt-fwd'), rl = $('gpt-reload');
  if (wb && typeof wv.goBack === 'function') wb.onclick = () => { try { wv.goBack(); } catch (_) {} };
  if (wf && typeof wv.goForward === 'function') wf.onclick = () => { try { wv.goForward(); } catch (_) {} };
  if (rl && typeof wv.reload === 'function') rl.onclick = () => { try { wv.reload(); } catch (_) {} };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 人设对话（第6模块）：独立 AI 聊天窗，模型 钱多多 / AstrBot，配合 web_search 联网。
 * 🔴 不与其他渠道共享任何上下文；对话只存本机（localStorage），不入库、不采集。
 * 🔴 web_search：先 A 打底（用模型自带联网）；B 口子（另接搜索接口）预留、暂不实现。
 * ════════════════════════════════════════════════════════════════════════════ */
function initPersonaPane() {
  const seg = $('persona-seg');
  const toggle = $('persona-websearch');
  const input = $('persona-input');
  const send = $('persona-send');
  const chat = $('persona-chat');
  if (!seg || !input || !send || !chat) return;

  let provider = 'qianduoduo';   // 默认 钱多多
  let webSearch = false;          // 默认不开联网搜索（A 打底：开时仅提示模型联网）
  const history = [];             // 本机会话（仅 localStorage 留存，不入库）

  seg.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      provider = b.dataset.prov || 'qianduoduo';
    };
  });
  if (toggle) {
    toggle.onclick = () => {
      webSearch = !webSearch;
      toggle.classList.toggle('off', !webSearch);
    };
  }

  function addBubble(role, text) {
    const el = document.createElement('div');
    el.className = 'persona-msg ' + (role === 'user' ? 'user' : 'ai');
    const b = document.createElement('div');
    b.className = 'persona-bubble';
    b.textContent = text;
    el.appendChild(b);
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }

  async function sendMsg() {
    const text = String(input.value || '').trim();
    if (!text) return;
    input.value = '';
    addBubble('user', text);
    history.push({ role: 'user', content: text });
    const wait = addBubble('ai', '人设正在思考…');

    try {
      const res = await fetch('/api/persona/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, messages: history.slice(), webSearch }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        wait.querySelector('.persona-bubble').textContent = '出错了：' + (data.error || ('HTTP ' + res.status));
        return;
      }
      const reply = data.reply || '(空回复)';
      wait.querySelector('.persona-bubble').textContent = reply;
      history.push({ role: 'assistant', content: reply });
      // 🔴 只存本机，不入库、不采集、不与任何渠道共享
      try { localStorage.setItem('persona_history_' + provider, JSON.stringify(history.slice(-50))); } catch (_) {}
    } catch (e) {
      wait.querySelector('.persona-bubble').textContent = '请求失败：' + ((e && e.message) || e);
    }
  }

  send.onclick = sendMsg;
  input.onkeydown = (e) => { if (e && e.key === 'Enter') { e.preventDefault(); sendMsg(); } };

  // 🔴 进来先放一句人设开场白（林晚秋 / Sherry，油画销售人设），纯前端、不写库
  if (!chat.children.length) {
    addBubble('ai', '你好，我是林晚秋（Sherry）～ 关于油画、定制宠物画或肖像画，或者只是想聊聊，都可以跟我说。');
  }
}

function switchMidTab(name) {
  document.querySelectorAll('.mtab').forEach((b) => b.classList.toggle('on', b.dataset.mp === name));
  /*
   * 🔴 v2.6.1143 修「WA 左栏不提醒」根因之一：WA 页签绝不用 display:none 隐藏。
   * display:none 会把内置浏览器 webview 内核挂起/卸载，采集链 findGuest 就再也找
   * 不到页面 → 后台收不到消息。改用「移出屏幕」(wa-offscreen) 保活：webview 仍在
   * 渲染进程里跑，只是被推到屏幕外，采集桥随时能命中。
   * 非 WA 页签（通用 / Tele①/②）仍走 .hidden（display:none），一个字不动。
   */
  document.querySelectorAll('.mid-pane').forEach((s) => {
    const mp = s.dataset.mp || '';
    const isWa = mp.indexOf('wa') === 0;
    const active = (mp === name);
    if (isWa) {
      if (active) {
        s.classList.remove('hidden', 'wa-offscreen');
      } else {
        s.classList.remove('hidden');
        s.classList.add('wa-offscreen');
      }
    } else {
      s.classList.toggle('hidden', !active);
    }
  });
  if (name && name.indexOf('wa') === 0 && WA_BY_MP[name]) {
    // 🔴 v2.6.1134 WA①~⑤：五个内置浏览器页签，各自独立，谁也不碰谁。
    //    切到哪个就加载哪个的网页、渲染哪个当前客户的对话信息、拉哪个的采集状态。
    const pane = WA_BY_MP[name];
    pane.ensureLoaded();
    const ac = pane.getActiveCode();
    if (ac) pane.renderConvInfo(ac);
    // 🔴 v2.6.1121：顺手拉一次采集状态 —— 老板一点页签就看到"到底采没采上"，
    //    不用等 5 秒轮询那一下（状态条本体靠 whatsapp_status 事件实时刷）。
    refreshWaStatus(pane.cfg.accId);
    return;
  }
  if (name === 'tele1' || name === 'tele2') {
    // 🔴 v2.6.1113 Tele②（老板 17:38 拍板）：功能与 Tele① 完全一样，
    //    唯一区别是「只看哪个号的数据」—— Tele① 只列编号段7（T①），Tele② 只列编号段8（T②）。
    const seg = name === 'tele2' ? '8' : '7';
    ensureTgBrowserLoaded();
    applyTgChatToggle();              // 把「对话信息」列的手动状态重新刷一遍
    startTgTranslateLoop();      // 🔴 v2.6.1093：进 Tele① 就开始把中文贴到气泡下方
    renderTgFriends(name, seg);  // 只列这个号的对话，两个页签天然隔离
    const code = tgCodeOf(name);
    if (code) renderTgChat(code, name);   // 回来时对话信息列也刷新
  } else {
    tgSetCode('tele1', null);   // 切走清空当前会话（Tele② 的选中状态先保留，切回来还在）
    tgSetCode('tele2', null);
    renderTgConvInfo(null);   // 🔴 v2.6.1094：「对话信息」一起清空，别留上一个客户的对话
    renderTgConvInfo(null, 'tele2');
    stopTgTranslateLoop(); // 切走就停，别在看不见的时候白烧 token
    // 顺手把上一页贴的译文清掉，不在人家 Telegram 页面上留东西
    api('/api/telegram/unpaint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  }
  // 离开任意 WA 页签时，把所有 WA 页签的当前客户清掉，别留着
  if (!(name && name.indexOf('wa') === 0 && WA_BY_MP[name])) {
    WA_PANES.forEach((p) => { p.setActiveCode(null); p.renderProfileRaw(null); p.renderConvInfo(null); });
  }
}

/* 🔴 v2.6.1093 Tele① 改回内置浏览器（老板拍板，扫码登录）：
 *   src 故意在 HTML 里留空，启动不加载（懒加载）。第一次点 Tele① 页签时才填上 Telegram 网页。
 *   partition 固定persist:tg-tele-7，登录态存本机 → 关软件再开还是登着的，不用反复扫码。
 *   只做「加载网页」，绝不在这里调任何发送动作（铁律：绝不自动发送）。 */
const TG_WEB_URL = 'https://web.telegram.org/k/';   // 仅留作记录：软件版不再加载这个网页
function ensureTgBrowserLoaded() {
  // v2.6.1106：网页版内核已删除，软件版**不需要加载任何网页** ——
  // 新消息由 MTProto 官方直连推送进来（官方推送比网页版轮询更快），这里什么都不用做。
}

/* 🔴 v2.6.1093 老板看图要求补回（QQ20261013-131330.png）：网页版 Telegram 少了「网址框 + 前往」。
 *   2026-10-12 老板就要过这个（#tgb-url / #tgb-go），清理旧 .tele-left 时被我一起删了，现在恢复。
 *
 *   行为：
 *     · 回车 = 点「前往」（等价，不用鼠标）
 *     · 只填了域名没写协议 → 自动补 https://（省得老板自己敲）
 *     · did-navigate / did-navigate-in-page → 把真实网址回填进输入框
 *       （Telegram 站内跳转会改地址，不回填的话输入框会一直显示老网址）
 *     · webview 一旦被换掉（懒加载重建），监听自动摘掉，不留野监听
 *
 *   🔴 铁律：这条地址栏只负责「在浏览器里打开网址」，
 *      **不碰任何发送动作**（软件绝不自动发送消息）。
 */
function tgGoto() {
  // v2.6.1106：网址框和 webview 都随网页版一起删除了，没有网址可跳、没有页面可开。
}

/** 绑一次地址栏（回车 + 按钮 + 网址回填）。幂等，重复调用不会绑两遍。 */
let tgAddrBarBound = false;
function initTgAddrBar() {
  // v2.6.1106：地址栏（#tgb-url 网址框 / #tgb-go「前往」）随网页版内核一起删除了。
  // 原本这里绑回车、绑按钮、把跳转后的真实网址回填进输入框 —— 服务对象已经不存在，整段停用。
  // 留个空壳是为了不用去改调用点（initMidTabs 还在调它）。
  if (tgAddrBarBound) return;
  tgAddrBarBound = true;
}

/* =====================================================================
 * v2.6.1093：把中文译文贴到 Telegram 网页的气泡下方
 * ---------------------------------------------------------------------
 * 背景（这一段以前是有的，但前端从来没调用过，等于白写）：
 *   后端 /api/telegram/paint 会往浏览器页面里塞自绘的译文块（只加文字、
 *   绝不碰 Telegram 自己的节点）。前端要做的是：
 *     ① 问后端「你现在开着哪个对话、那20 条消息的中文是什么」→ /api/telegram/conversation
 *     ② 把带中文的消息调→ /api/telegram/paint
 *
 * 省 token 的闸门（照抄后端 v2.5.1059 的设计）：
 *   /api/telegram/pagekey 返回页面指纹（会话标题 + hash + 气泡数 + 已贴数）。
 *   指纹没变 = 页面没动 = 这一轮一趟 API 都不跑；变了才真去取数重贴。
 *   否则每 15 秒无脑翻一遍，白烧钱。
 *
 * 🔴 铁律：这一整段只读页面 + 只加自己的 div，一个字都不改 Telegram 的消息，
 *    更不碰任何发送动作。
 * ===================================================================== */
const TG_PAINT_INTERVAL = 15000;   // 指纹变了之后的最小重贴间隔
let tgPaintTimer = null;
let tgPaintBusy = false;
let tgPaintLastKey = '';
let tgPaintLastAt = 0;

/** 进 Tele① 时启动；已在跑就不重复起 */
function startTgTranslateLoop() {
  if (tgPaintTimer) return;
  // 先立刻跑一趟，别让老板点进来等十几秒才看到中文
  tgPaintOnce().catch(() => {});
  tgPaintTimer = setInterval(() => { tgPaintOnce().catch(() => {}); }, TG_PAINT_INTERVAL);
}

/** 切走时停掉，别在看不见的页面白烧 token */
function stopTgTranslateLoop() {
  if (tgPaintTimer) { clearInterval(tgPaintTimer); tgPaintTimer = null; }
  tgPaintLastKey = '';   // 下次进来重新判断，别拿上次的指纹糊弄
}

async function tgPaintOnce() {
  if (tgPaintBusy) return;                       // 上一轮还没跑完就跳过，绝不并发
  const pane = document.querySelector('.mid-pane[data-mp="tele1"]');
  if (!pane || pane.classList.contains('hidden') || document.hidden) return;
  // v2.6.1106：网页版内核已删除 —— Telegram 网页气泡不存在了，「把中文译文贴到气泡下方」
  // 这件事随之停用。软件版 T 只做四件事（实时收新消息 / 取客户档案 / 三种会话都能读 /
  // 登录一次长期复用），「往网页里贴译文」是网页版时代的产物，不在其中。
  return;
  const now = Date.now();
  if (now - tgPaintLastAt < 3000) return;         // 最小间隔，防止频繁切页签时刷接口

  tgPaintBusy = true;
  try {
    // ① 页面脏检查：指纹没变就直接收工，一个数据接口都不调
    const key = await api('/api/telegram/pagekey').catch(() => null);
    const k = key && (key.key || key.fingerprint || '');
    if (k && k === tgPaintLastKey && now - tgPaintLastAt < TG_PAINT_INTERVAL * 2) return;
    tgPaintLastKey = k || tgPaintLastKey;
    tgPaintLastAt = now;

    // ② 取当前对话的消息（后端已把 mid 切好、中文翻好的带上）
    const conv = await api('/api/telegram/conversation?limit=20&backfill=10').catch(() => null);
    if (!conv || !conv.ok || !Array.isArray(conv.messages) || !conv.messages.length) return;

    // ③ 只要「有中文译文」的那些，组装成 paint 要的 { mid, zh } 结构
    /* 🔴 v2.6.1093 修：这里原来读的是 m.bodyZh（驼峰），而后端 withTranslationState()
     *  是`...m` 展开原样返回的 body_zh（下划线），api() 只做 res.json() 零转换
     *  → bodyZh 永远是 undefined → rows 永远空 → **译文一块都贴不上**。
     *  项目里其它 20 多处（line 564/1045/1292/2279...）一律读 body_zh，
     *  这里跟着用 body_zh，并留bodyZh 兜底，两种命名都不会漏。 */
    const rows = [];
    for (const m of conv.messages) {
      const zh = String((m && (m.body_zh || m.bodyZh)) || '').trim();
      const mid = String((m && m.mid) || '').trim();
      if (zh && mid) rows.push({ mid, zh });     // mid 或中文缺一个就跳过，贴了也是空块
    }
    if (!rows.length) return;

    // ④ 交给主进程塞进页面（幂等：同一 mid 只会有一块，不会越贴越多）
    const r = await api('/api/telegram/paint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: rows.slice(0, 60) }),
    }).catch(() => null);
    if (r && r.ok && r.painted) {
      tgLog(`已贴中文译文 ${r.painted} 条`);
    }
  } catch (e) {
    // 一轮失败不能连累后面：记一行就收手，绝不打断定时器
    tgLog('贴译文这一轮失败：' + String((e && e.message) || e));
  } finally {
    tgPaintBusy = false;
  }
}

/** 原生面板若正可见则顺手保活（替代旧 webview 的 loadTgConversation）。
 *  列表与气泡已各自 5 秒轮询 + 实时广播，这里只是事件发生时轻量刷新，无副作用。 */
function refreshTgPanelIfOpen() {
  const pane = document.querySelector('.mid-pane[data-mp="tele1"]');
  if (!pane || pane.classList.contains('hidden') || document.hidden) return;
  if (tgActiveCode) loadTgChat(tgActiveCode);
  else loadTgConversations();
}



/* =====================================================================
 * v2.6.1094「WA①」页签 —— WhatsApp 内置浏览器（老板拍板「方案一 · 内置浏览器」）
 * ---------------------------------------------------------------------
 * 形态与 Tele① 完全对称（老板原话：「功能界面可以模仿 Tele① 标签」）：
 *   左半 = 真的 WhatsApp 网页（地址栏 + webview，扫码登录，能看能发）
 *   右半 = 客户资料卡 + 三个按钮 + 对话信息
 *
 * 🔴 模块边界（老板 2026-10-12「代码不要放一块」铁律）：
 *   本块**只管 WA①**，与 Tele① 那套（tgActiveCode / tgPaintOnce / startTgTranslateLoop）
 *   完全独立，两边变量、函数、DOM id 都各用各的，改一个绝不牵连另一个。
 *   右半的资料卡 / 对话信息**复用 Tele① 的 .tv-* 样式类**（不另挑颜色、不另发明排版），
 *   但 DOM id 全部 wa1- 前缀，避免和 Tele① 抢同一个节点。
 *
 * 🔴 铁律不变：内置浏览器只做「看 + 手动预填」，**绝不自动发送任何消息**。
 * ===================================================================== */
/* =====================================================================
 * v2.6.1134「WA①~⑤」页签 —— WhatsApp 内置浏览器（复刻自 WA①，共用一套）
 * ---------------------------------------------------------------------
 * 🔴 五个内置浏览器页签（WA①~⑤）共用同一套采集 / 气泡 / 资料卡 / 对话信息代码，
 *    仅按 accId / partition / 前缀 / 编号段 参数化。DOM id 全部 <mp>- 前缀
 *    （wa1-/wa2-/…/wa5-），各自独立，互不抢节点。
 * 🔴 模块边界（老板 2026-10-12「代码不要放一块」铁律）：
 *    本块只管 WA①~⑤ 五个内置浏览器页签，与 Tele①/② 那套完全独立。
 * 🔴 铁律不变：内置浏览器只做「看 + 手动预填」，**绝不自动发送任何消息**。
 * ===================================================================== */

/** 五个实例的配置：mp=页签 key、idx=显示序号、accId=账号号、partition、codePrefix=编号段、label */
const WA_INSTANCES = [
  { mp: 'wa1', idx: 1, accId: 10, partition: 'persist:wa6',  codePrefix: 'WA', label: 'WA①' },
  { mp: 'wa2', idx: 2, accId: 11, partition: 'persist:wa7',  codePrefix: 'WB', label: 'WA②' },
  { mp: 'wa3', idx: 3, accId: 12, partition: 'persist:wa8',  codePrefix: 'WD', label: 'WA③' },
  { mp: 'wa4', idx: 4, accId: 13, partition: 'persist:wa9',  codePrefix: 'WE', label: 'WA④' },
  { mp: 'wa5', idx: 5, accId: 14, partition: 'persist:wa10', codePrefix: 'WF', label: 'WA⑤' },
];

/** 取某个实例的 DOM 节点（mp 即 id 前缀） */
function waDom(cfg, base) { return $(cfg.mp + '-' + base); }

/** 左栏客户编号（WA00001 / WB00001 / …）映射到对应的实例 */
function waInstanceByCode(code) {
  const cp = String(code || '').slice(0, 2).toUpperCase();
  const cfg = WA_INSTANCES.find((x) => x.codePrefix === cp);
  return cfg ? WA_BY_MP[cfg.mp] : null;
}
/** 后端账号号（10~14）映射到对应的实例 */
function waInstanceByAcc(accId) {
  const cfg = WA_INSTANCES.find((x) => x.accId === Number(accId));
  return cfg ? WA_BY_MP[cfg.mp] : null;
}

/** 工厂：造一个 WA 内置浏览器页签实例（状态闭包，互不干扰） */
function makeWaPane(cfg) {
  let activeCode = null;
  let addrBarBound = false;

  function applyChromeUA() {
    const wv = waDom(cfg, 'webview');
    if (!wv) return;
    try { wv.setAttribute('useragent', WA_CHROME_UA); } catch (_) {}
    if (typeof wv.setUserAgent === 'function') { try { wv.setUserAgent(WA_CHROME_UA); } catch (_) {} }
  }
  function ensureLoaded() {
    const wv = waDom(cfg, 'webview');
    if (!wv) return;
    applyChromeUA();
    if (wv.getAttribute('src') === WA_WEB_URL) return;
    wv.setAttribute('src', WA_WEB_URL);
  }
  function goto() {
    const wv = waDom(cfg, 'webview');
    const inp = waDom(cfg, 'url');
    if (!wv || !inp) return;
    applyChromeUA();
    let v = String(inp.value || '').trim();
    if (!v) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'https://' + v;
    inp.value = v;
    try { wv.setAttribute('src', v); }
    catch (e) { console.warn(`[${cfg.label}] 打开网址失败：`, (e && e.message) || e); }
  }
  function initAddrBar() {
    const inp = waDom(cfg, 'url');
    const btn = waDom(cfg, 'go');
    const wv = waDom(cfg, 'webview');
    if (!inp || !btn || !wv) return;
    if (addrBarBound) return;
    addrBarBound = true;
    btn.onclick = goto;
    inp.onkeydown = (e) => { if (e && e.key === 'Enter') { e.preventDefault(); goto(); } };
    const sync = () => {
      try {
        const u = wv.getURL && wv.getURL();
        if (u && document.activeElement !== inp) inp.value = u;
      } catch (_) { /* 跳转中读 URL 可能抛，忽略 */ }
    };
    if (wv.addEventListener) {
      wv.addEventListener('did-navigate', sync);
      wv.addEventListener('did-navigate-in-page', sync);
    }
  }
  function renderProfileRaw(c) {
    const body = waDom(cfg, 'profile-body');
    if (!body) return;
    if (!c) { body.innerHTML = '<div class="tv-empty">这个客户还没建档</div>'; return; }
    const joined = fmt(c.created_at || c.joined_at) || '—';
    const days = daysSince(c.created_at || c.joined_at);
    const dayNo = days != null ? days : 0;
    const tzHand = tzManualHours(c.timezone) !== null ? String(c.timezone).trim() : '';
    const tz = c.timezone || '';
    const loc = localTimeOf(tz);
    const locTip = tz
      ? (tzHand
        ? `手填时差 ${Number(tzHand) > 0 ? '+' : ''}${tzHand} 小时（客户那边现在几点按它算）`
        : String(tz))
      : '还没填时区 —— 在「客户档案」里填了时区这里就会走';
    const regionHtml = c.region
      ? `<span class="chip chip-region">${esc(c.region)}</span>`
      : '<span class="tv-empty">未填</span>';
    // 比北京早/晚几小时（手填数字 或 IANA 时区都认；没有就先显示「—」）
    const offText = tzOffsetText(tz);
    body.innerHTML = `
      <div class="tv-head">
        <span class="code">${esc(c.code || '—')}</span><span class="name-label">名称:</span><span class="cname">${esc(c.name || '未命名')}</span>
      </div>
      <div class="tv-ln"><b class="tv-f-joined">加入时间</b><span class="tv-val">${esc(joined)}</span></div>
      ${days !== null ? `<div class="tv-ln"><i class="tv-star">★</i><i class="tv-sub-joined">认识</i><span class="tv-day-num">第 ${days} 天</span><i class="tv-star">★</i><b class="tv-fact-day" title="加入后第几天：按加入时间算，加入当天 = Day 1">Day ${dayNo}</b></div>` : ''}
      <div class="tv-ln sep"><b class="tv-f-region">地区</b>${regionHtml}</div>
      <div class="tv-ln"><b class="tv-f-loc" title="${esc(locTip)}">客户当地时间</b><span class="tv-val">${esc(loc || '—')}</span>${tz ? '' : '<i class="tv-sub-joined">（在右栏填了时区就会显示）</i>'}</div>
      <div class="tv-ln"><b class="tv-f-loc">与北京时间差</b><span class="tv-val">${esc(offText || '—')}</span></div>`;
  }
  async function loadProfile(code) {
    if (!code) { renderProfileRaw(null); return; }
    try {
      const data = await api(`/api/customer/${encodeURIComponent(code)}`);
      const c = (data && (data.customer || data)) || null;
      if (activeCode !== code) return;
      // 时差：有地区、还没算过时区 → 让 AI 算一次并写进档案，下次直接读（不重复烧 AI）
      if (c && !c.timezone && c.region) {
        try {
          const r = await api('/api/region/timezone', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, region: String(c.region) }),
          });
          if (r && r.ok && r.tz) c.timezone = r.tz;
        } catch (_) { /* 算不出不影响其它 */ }
      }
      renderProfileRaw(c);
    } catch (_) { renderProfileRaw(null); }
  }
  /** 判断一段正文是不是「媒体 base64 乱码」（WA 媒体消息 body 有时是整串 base64 / data URI，不该当文本显示） */
  function isBase64Garbage(s) {
    if (!s) return false;
    const t = String(s).trim();
    if (t.startsWith('data:')) return true;
    if (t.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(t)) return true;
    return false;
  }

  /** 判断一条消息是不是「媒体消息」（图片/视频/语音/文件）。
   *  用多个信号兜底，避免只靠单一字段漏判（DB 里这些字段不一定齐全）：
   *  ① mediaType/mediaKind 命中媒体类型；② 有 media_path（已落盘真文件）；
   *  ③ body 是整串 base64（探针抓到的媒体字节）；④ 取图状态是 pending/fail（说明是媒体但还没取到）。
   *  媒体消息的 body 是脏数据（base64 字节或空），正文/译文都不能当文本渲染。 */
  function isMediaMessage(m) {
    const k = String(m.mediaKind || m.mediaType || m.media_type || '').toLowerCase();
    if (/^(image|sticker|video|audio|ptt|document|gif)$/.test(k)) return true;
    if (m.media_path) return true;
    if (isBase64Garbage(String(m.body || ''))) return true;
    const fs = String(m.mediaFetchState || m.media_fetch_state || '');
    if (fs === 'pending' || fs === 'fail') return true;
    return false;
  }

  /** 视频占位符：用一张「写了『视频』二字的图」代替真视频（老板要求：视频就给占位符，别把 base64 当正文） */
  function videoPlaceholder(url) {
    return `<a class="conv-ph-video" href="${esc(url)}" target="_blank" rel="noopener" title="点开看视频原文件">
      <span class="conv-ph-video-ico">🎬</span><span class="conv-ph-video-txt">视频</span>
    </a>`;
  }

  /**
   * 内置 WA webview 抓不到真图时，消息 body 里常还留着整串 base64（真实媒体字节）。
   * 直接拼成 data URI 当临时媒体渲染——这正是「把乱码解析成图片缩略图」的那条路：
   * 不显示脏文本，但能直接显示图/视频/语音。抓到真图（media_path 有值）时不会走这里。
   *
   * ⚠️ 关键：先嗅 base64 头部魔数，再决定怎么渲染。实测视频消息的 body 常常是一张
   * JPEG 缩略图（头部 `/9j/`），并不是 mp4 字节——若按 type='video' 硬塞 video/mp4
   * 会解码失败。所以「能嗅出图片魔数就当图渲染」，其余才按声明类型兜底。
   * @returns {{uri:string, render:'image'|'video'|'audio'}|null}
   */
  function mediaDataUri(m) {
    const body = String(m.body || '');
    if (!isBase64Garbage(body)) return null;
    const k = String(m.mediaKind || m.mediaType || '').toLowerCase();
    let mime = null, render = null;
    if (body.startsWith('iVBOR')) { mime = 'image/png'; render = 'image'; }
    else if (body.startsWith('R0lGOD')) { mime = 'image/gif'; render = 'image'; }
    else if (body.startsWith('UklGR')) { mime = 'image/webp'; render = 'image'; }
    else if (body.startsWith('/9j/')) { mime = 'image/jpeg'; render = 'image'; }
    if (!mime) {
      if (k === 'video') { mime = 'video/mp4'; render = 'video'; }
      else if (k === 'audio' || k === 'ptt') { mime = 'audio/ogg'; render = 'audio'; }
      else if (k === 'image' || k === 'sticker') { mime = 'image/jpeg'; render = 'image'; }
      else return null; // 不知道类型就不瞎渲染
    }
    return { uri: 'data:' + mime + ';base64,' + body, render };
  }

  async function renderConvInfo(code) {
    const box = waDom(cfg, 'convinfo-body');
    if (!box) return;
    if (!code) { box.innerHTML = '<div class="tv-empty">点左栏 WhatsApp 客户，这里列他这段对话的原话 + 中文</div>'; return; }
    try {
      const data = await api(`/api/customer/${encodeURIComponent(code)}`);
      if (activeCode !== code) return;
      const msgs = (data && data.messages) || [];
      const rows = msgs.filter((m) => m.direction === 'in' || m.body_zh || m.media_path || m.mediaType || m.mediaKind || m.mediaFetchState === 'pending');
      // 🔴 2026-10-20：对话信息最上方拼一条媒体带——
      //   客户/我们自己发的图片显示缩略图；视频/语音给占位符（老板要求：视频就发个占位符）；
      //   还没取下来的媒体先给「正在取文件…」占位，让人知道对方确实发了东西。
      const mediaMsgs = msgs.filter((m) => {
        const k = String(m.mediaKind || m.mediaType || '').toLowerCase();
        return (m.direction === 'in' || m.direction === 'out')
          && (m.media_path || m.mediaFetchState === 'pending' || /^(image|sticker|video|audio|ptt)$/.test(k));
      });
      let strip = '';
      if (mediaMsgs.length) {
        strip = '<div class="tv-img-row">' + mediaMsgs.slice(-30).map((m) => {
          const k = String(m.mediaKind || m.mediaType || '').toLowerCase();
          const phTxt = k === 'video' ? '视频' : (k === 'audio' || k === 'ptt') ? '语音' : k === 'sticker' ? '贴纸' : '图片';
          if (m.media_path) {
            const nm = String(m.media_path).split(/[\\/]/).pop();
            const url = '/media/' + encodeURIComponent(nm);
            if (k === 'image' || k === 'sticker') {
              const tip = esc(String(m.body || '').slice(0, 60));
              return `<img class="conv-thumb" src="${url}" title="${tip}" alt="${tip}" loading="lazy" onerror="this.classList.add('conv-thumb-bad')">`;
            }
            if (k === 'video') return videoPlaceholder(url);
            if (k === 'audio' || k === 'ptt') return `<a class="conv-ph" href="${url}" target="_blank" rel="noopener">🎤 语音</a>`;
            return `<a class="conv-ph" href="${url}" target="_blank" rel="noopener">📎 文件</a>`;
          }
          const mu = mediaDataUri(m);
          if (mu) {
            if (mu.render === 'image') return `<img class="conv-thumb" src="${esc(mu.uri)}" title="临时图（base64 救出）" alt="临时图" loading="lazy" onerror="this.classList.add('conv-thumb-bad')">`;
            if (mu.render === 'video') return `<video class="conv-thumb" src="${esc(mu.uri)}" controls preload="metadata" title="临时视频（base64 救出）"></video>`;
            if (mu.render === 'audio') return `<a class="conv-ph" href="${esc(mu.uri)}" target="_blank" rel="noopener">🎤 语音（临时）</a>`;
            return `<a class="conv-ph" href="${esc(mu.uri)}" target="_blank" rel="noopener">📎 文件（临时）</a>`;
          }
          const failed = m.mediaFetchState === 'fail';
          const ph = failed ? `${phTxt} · 未能抓取` : `${phTxt} · 正在取文件…`;
          return `<span class="conv-ph conv-ph-wait${failed ? ' conv-ph-fail' : ''}">${ph}</span>`;
        }).join('') + '</div>';
      }
      if (!rows.length) { box.innerHTML = strip + '<div class="tv-empty">这个客户还没有采到消息</div>'; return; }
      // 找「我最后一条 out」的位置：它之后的 in 消息 = 还没回复的新消息
      // （老板 2026-10-15 铁律：已回复过的不出建议按钮，只给出未回复的新消息）
      let lastOutIdx = -1;
      msgs.forEach((m, i) => { if (m.direction === 'out') lastOutIdx = i; });
      const idxOf = new Map();
      msgs.forEach((m, i) => idxOf.set(String(m.id), i));
      box.innerHTML = strip + rows.slice(-30).map((m) => {
        const zh = String((m && (m.body_zh || m.bodyZh)) || '').trim();
        const rawEn = String((m && m.body) || '');
        const side = (m && m.direction === 'out') ? 'out' : 'in';
        const k = String(m.mediaKind || m.mediaType || '').toLowerCase();
        // 🔴 媒体消息的 body 可能是整串 base64 / data URI（WA 没抓到图时落库的脏数据），
        //    不要再当正文渲染成乱码；只有「确实是人话正文」才显示（客户在图上配的文字照常显示）。
        const isMedia = !!m.media_path || /^(image|sticker|video|audio|ptt)$/.test(k) || m.mediaFetchState === 'pending' || m.mediaFetchState === 'fail';
        const en = (isMedia && isBase64Garbage(rawEn)) ? '' : rawEn.trim();
        // 媒体消息的 body_zh 是 AI 把 base64 当文本翻出来的垃圾（"抱歉，这条消息里只有一串乱码…"），绝不显示
        const zhShow = isMedia ? '' : zh;
        const uri = mediaDataUri(m);
        let mediaNote = '';
        if (m.media_path) {
          const nm = String(m.media_path).split(/[\\/]/).pop();
          const url = '/media/' + encodeURIComponent(nm);
          if (k === 'image' || k === 'sticker') mediaNote = `<div class="tv-media">🖼 图片（见上方缩略图）</div>`;
          else if (k === 'video') mediaNote = `<div class="tv-media">🎬 视频 · <a href="${url}" target="_blank" rel="noopener">点开看</a></div>`;
          else if (k === 'audio' || k === 'ptt') mediaNote = `<div class="tv-media">🎤 语音 · <a href="${url}" target="_blank" rel="noopener">点开听</a></div>`;
          else mediaNote = `<div class="tv-media">📎 文件 · <a href="${url}" target="_blank" rel="noopener">${esc(nm)}</a></div>`;
        } else if (uri) {
          // 🔴 v2.6.1184（老板截图实测：右栏每条只显示「图片（base64 临时）·看大图」一行文字，没有图）：
          //    DB 实证 body 是**完整有效 JPEG**（ffd8ffe0…ffd9，长度 4 的倍数），不是乱码也不是截断；
          //    所以直接把它当 data URI 渲染成缩略图，别再只给一个文字链接。
          //    视频消息的 body 实测也是一张 JPEG 缩略图 → 同样按图渲染，右下角加「🎬 视频」角标。
          if (uri.render === 'image') {
            const isVid = (k === 'video');
            mediaNote = `<div class="tv-media tv-media-img"><a class="conv-thumb-link" href="${esc(uri.uri)}" target="_blank" rel="noopener" title="点开看大图">`
              + `<img class="conv-thumb" src="${esc(uri.uri)}" alt="${isVid ? '视频缩略图' : '图片'}" loading="lazy" onerror="this.classList.add('conv-thumb-bad')">`
              + `${isVid ? '<span class="conv-thumb-badge">🎬 视频</span>' : ''}</a></div>`;
          }
          else if (uri.render === 'video') mediaNote = `<div class="tv-media"><video class="conv-thumb-video" src="${esc(uri.uri)}" controls preload="metadata"></video></div>`;
          else if (uri.render === 'audio') mediaNote = `<div class="tv-media">🎤 语音 · <a href="${esc(uri.uri)}" target="_blank" rel="noopener">点开听</a></div>`;
          else mediaNote = `<div class="tv-media">📎 文件 · <a href="${esc(uri.uri)}" target="_blank" rel="noopener">打开</a></div>`;
        } else if (m.mediaFetchState === 'fail') {
          const ph = k === 'video' ? '🎬 视频' : (k === 'audio' || k === 'ptt') ? '🎤 语音' : k === 'sticker' ? '🎭 贴纸' : '🖼 图片';
          // 🔴 v2.6.1184：语音（ptt）在 WA 里 body 就是 null（没有文本体），下载又过期失败 → 本地确实没有字节可放。
          //    这里必须给一句明确的「已收到」，不能让老板以为漏采；图片/视频则继续按「抓取失败」提示。
          const extra = (k === 'audio' || k === 'ptt')
            ? ' · 已收到这条语音，但内容没能取回（WhatsApp 语音文件有时效，过期就取不回来）'
            : ' · 没能抓下来（媒体可能已过期）';
          mediaNote = `<div class="tv-media tv-media-fail">${ph}${extra}</div>`;
        } else if (m.mediaFetchState === 'pending' || /^(image|sticker|video|audio|ptt)$/.test(k)) {
          const ph = k === 'video' ? '🎬 视频' : (k === 'audio' || k === 'ptt') ? '🎤 语音' : k === 'sticker' ? '🎭 贴纸' : '🖼 图片';
          mediaNote = `<div class="tv-media tv-media-wait">${ph} · 正在取文件…</div>`;
        }
        // 只给「最后一条 out 之后」的 in 消息挂「💡 建议」（未回复的新消息）
        const isNew = m.direction === 'in' && (idxOf.get(String(m.id)) > lastOutIdx);
        const btn = isNew
          ? `<button class="tv-suggest" data-id="${esc(m.id)}" data-code="${esc(code)}" title="为这条还没回复的新消息生成 3 条回复建议">💡 建议</button>`
          : '';
        return `<div class="tv-msg ${side}" data-id="${esc(m.id)}">
          ${zhShow ? `<div class="tv-zh">${esc(zhShow)}</div>` : ''}
          ${en ? `<div class="tv-en">${esc(en)}</div>` : ''}
          ${mediaNote}
          ${btn}
        </div>`;
      }).join('');
      box.scrollTop = box.scrollHeight;
    } catch (_) { box.innerHTML = '<div class="tv-empty">对话读取失败</div>'; }
  }
  async function markReplied(btn) {
    const code = activeCode || state.activeCode;
    if (!code) return;
    if (btn && btn.disabled) return;
    if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
    try {
      const r = await api(`/api/customer/${code}/replied`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skip: false }),
      });
      if (r && r.error) { showNotice('warn', r.error); return; }
      refreshToday();
      await refreshCustomers();
      await refreshState();
      state.activeCode = null;
      activeCode = null;
      const ci = waDom(cfg, 'convinfo-body');
      if (ci) ci.innerHTML = '<div class="tv-empty">点左栏 WhatsApp 客户，这里列他这段对话的原话 + 中文</div>';
      const pb = waDom(cfg, 'profile-body');
      if (pb) pb.innerHTML = '<div class="tv-empty">点左栏 WhatsApp 客户看资料</div>';
      showNotice('ok', `${code} 已收进「已处理」—— 左栏那一格没了，对话完整保留在本地档案里（来新消息会再冒出来）`);
    } catch (e) {
      showNotice('warn', `标记回复失败：${(e && e.message) || e}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '标记回复'; }
    }
  }
  function bindButtons() {
    const full = waDom(cfg, 'profile-full');
    if (full) full.onclick = () => { if (activeCode) openProfileModal(activeCode); };
    const extract = waDom(cfg, 'profile-extract');
    if (extract) extract.onclick = () => { if (activeCode) extractProfileFromChat(activeCode, extract); };
    const repaint = waDom(cfg, 'repaint');
    if (repaint) repaint.onclick = () => repaintWaBubbles(repaint, cfg.accId);
    const markRepliedBtn = waDom(cfg, 'mark-replied');
    if (markRepliedBtn) markRepliedBtn.onclick = () => markReplied(markRepliedBtn);
  }
  function renderStatus(d) {
    const el = waDom(cfg, 'status');
    if (!el) return;
    if (!d || !d.status) { el.className = 'tg-status hidden'; el.textContent = ''; return; }
    const map = {
      collecting: { cls: 'ok', pre: '✅ ' },
      'no-page': { cls: 'warn', pre: '⚠️ ' },
      unreadable: { cls: 'err', pre: '⛔ ' },
      error: { cls: 'err', pre: '⛔ ' },
      paused: { cls: 'muted', pre: '⏸ ' },
      starting: { cls: 'muted', pre: '… ' },
    };
    const m = map[d.status] || { cls: 'muted', pre: '' };
    el.className = `tg-status ${m.cls}`;
    el.textContent = (m.pre || '') + String(d.text || `${cfg.label}：${d.status}`);
  }
  return {
    cfg,
    setActiveCode: (c) => { activeCode = c || null; },
    getActiveCode: () => activeCode,
    applyChromeUA, ensureLoaded, goto, initAddrBar,
    renderProfileRaw, loadProfile, renderConvInfo, markReplied, bindButtons, renderStatus,
  };
}

/* 五个实例（WA①~⑤）：模块级单例，全局复用 */
const WA_PANES = WA_INSTANCES.map(makeWaPane);
const WA_BY_MP = {};
WA_INSTANCES.forEach((x, i) => { WA_BY_MP[x.mp] = WA_PANES[i]; });
/** 按页签 key 取实例（WA① 向后兼容别名） */
function waPaneByMp(mp) { return WA_BY_MP[mp] || WA_PANES[0]; }

const WA_WEB_URL = 'https://web.whatsapp.com/';
let wa1ActiveCode = null;
let waAddrBarBound = false;

/**
 * 🔴 v2.6.1097：WA① 的浏览器身份现在**由主进程统一钉**（src/webIdentity.js，
 *    对 persist:wa6 分区 setUserAgent + 逐请求兜底），那才是真正生效的一层。
 *    这里保留一个**渲染进程侧兜底**，只防"万一主进程那步没走到"。
 * 关键修正（1096 的错）：上一版直接拿宿主 UA 剥 `Electron/...`，结果串里还留着
 *    应用名（如「蜜蜂信息采集/2.6.x」），同样会被判成不认识的浏览器。
 *    现在改成：从宿主 UA 里**只抠出 Chrome/<版本>**，重建成一个纯标准 Chrome 串 ——
 *    既不带 Electron 令牌、也不带应用名；版本动态跟随内置 Chromium，不写死。
 * 说明：内核不变（仍是内置 Chromium），只是身份字符串变成 WhatsApp 认得的 Chrome。
 */
const WA_CHROME_UA = (function () {
  try {
    const m = /Chrome\/(\d+(?:\.\d+){0,3})/.exec(navigator.userAgent || '');
    const v = m ? m[1] : '152.0.7977.130';
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + v + ' Safari/537.36';
  } catch (_) {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36';
  }
})();

/** 渲染进程侧兜底：把 WA① webview 的 UA 也钉成纯标准 Chrome（主进程那层才是主力，这里是保险） */
function waApplyChromeUA() {
  const wv = $('wa1-webview');
  if (!wv) return;
  try { wv.setAttribute('useragent', WA_CHROME_UA); } catch (_) {}
  if (typeof wv.setUserAgent === 'function') { try { wv.setUserAgent(WA_CHROME_UA); } catch (_) {} }
}

/** 懒加载：第一次点 WA① 页签才填src（启动不拖慢）。已加载过就不重复刷登录态。 */
function ensureWaBrowserLoaded() {
  const wv = $('wa1-webview');
  if (!wv) return;
  waApplyChromeUA();   // 🔴 v2.6.1097：主进程已钉该分区 UA；这里再兜一次，保证首屏请求就是干净 Chrome UA
  if (wv.getAttribute('src') === WA_WEB_URL) return;
  wv.setAttribute('src', WA_WEB_URL);
}

/** 地址栏「前往」：回车 = 点按钮；只写域名没写协议自动补 https:// */
function waGoto() {
  const wv = $('wa1-webview');
  const inp = $('wa1-url');
  if (!wv || !inp) return;
  waApplyChromeUA();   // 🔴 v2.6.1097：手动「前往」也兜一次，避免跳转后 UA 变回默认（带 Electron 令牌）
  let v = String(inp.value || '').trim();
  if (!v) return;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'https://' + v;
  inp.value = v;
  try { wv.setAttribute('src', v); }
  catch (e) { console.warn('[WA①] 打开网址失败：', (e && e.message) || e); }
}

/** 绑一次地址栏（幂等，重复调用不会绑两遍） */
function initWaAddrBar() {
  const inp = $('wa1-url');
  const btn = $('wa1-go');
  const wv = $('wa1-webview');
  if (!inp || !btn || !wv) return;
  if (waAddrBarBound) return;
  waAddrBarBound = true;
  if (btn) btn.onclick = waGoto;
  if (inp) inp.onkeydown = (e) => { if (e && e.key === 'Enter') { e.preventDefault(); waGoto(); } };
  const sync = () => {
    try {
      const u = wv.getURL && wv.getURL();
      if (u && document.activeElement !== inp) inp.value = u;
    } catch (_) { /* 跳转中读 URL 可能抛，忽略 */ }
  };
  if (wv.addEventListener) {
    wv.addEventListener('did-navigate', sync);
    wv.addEventListener('did-navigate-in-page', sync);
  }
}

/**
 * 渲染 WA① 的客户资料卡。
 * 🔴 内容与 Tele① 那张**逐字一致**（竖排单列：编号+名称 / 加入时间 / ★认识第N天★Day N /
 *    地区 / 客户当地时间），配色也全部来自 .tv-* 类，一个字节都没为 WA 新写样式。
 *    这里只换挂载节点：Tele① → #tg-profile-body，WA① → #wa1-profile-body。
 */
function renderWaProfileRaw(c) {
  const body = $('wa1-profile-body');
  if (!body) return;
  if (!c) {
    body.innerHTML = '<div class="tv-empty">这个客户还没建档</div>';
    return;
  }
  const now = new Date();
  const joined = fmt(c.created_at || c.joined_at) || '—';
  const days = daysSince(c.created_at || c.joined_at);
  const dayNo = days != null ? days : 0;

  const tzHand = tzManualHours(c.timezone) !== null ? String(c.timezone).trim() : '';
  const tz = c.timezone || '';
  const loc = localTimeOf(tz);
  const locTip = tz
    ? (tzHand
      ? `手填时差 ${Number(tzHand) > 0 ? '+' : ''}${tzHand} 小时（客户那边现在几点按它算）`
      : String(tz))
    : '还没填时区 —— 在「客户档案」里填了时区这里就会走';

  const regionHtml = c.region
    ? `<span class="chip chip-region">${esc(c.region)}</span>`
    : '<span class="tv-empty">未填</span>';

  body.innerHTML = `
    <div class="tv-head">
      <span class="code">${esc(c.code || '—')}</span><span class="name-label">名称:</span><span class="cname">${esc(c.name || '未命名')}</span>
    </div>
    <div class="tv-ln"><b class="tv-f-joined">加入时间</b><span class="tv-val">${esc(joined)}</span></div>
    ${days !== null ? `<div class="tv-ln"><i class="tv-star">★</i><i class="tv-sub-joined">认识</i><span class="tv-day-num">第 ${days} 天</span><i class="tv-star">★</i><b class="tv-fact-day" title="加入后第几天：按加入时间算，加入当天 = Day 1">Day ${dayNo}</b></div>` : ''}
    <div class="tv-ln sep"><b class="tv-f-region">地区</b>${regionHtml}</div>
    <div class="tv-ln"><b class="tv-f-loc" title="${esc(locTip)}">客户当地时间</b><span class="tv-val">${esc(loc || '—')}</span>${tz ? '' : '<i class="tv-sub-joined">（在右栏填了时区就会显示）</i>'}</div>`;
}

/** 取客户档案填进 WA① 资料卡 */
function loadWaProfile(code) {
  if (!code) { renderWaProfileRaw(null); return; }
  api(`/api/customer/${encodeURIComponent(code)}`)
    .then((data) => {
      const c = (data && (data.customer || data)) || null;
      if (wa1ActiveCode !== code) return;      // 期间又切走了就别画了
      renderWaProfileRaw(c);
    })
    .catch(() => { renderWaProfileRaw(null); });
}

/**
 * WA① 的「对话信息」：中文译文深蓝加粗在上，客户英文原话灰色小字在下。
 * 没有译文时只显示英文原话那一行（**不硬凑一句中文出来骗人**）。
 */
function renderWaConvInfo(code) {
  const box = $('wa1-convinfo-body');
  if (!box) return;
  if (!code) {
    box.innerHTML = '<div class="tv-empty">点左栏 WhatsApp 客户，这里列他这段对话的原话 + 中文</div>';
    return;
  }
  api(`/api/customer/${encodeURIComponent(code)}`)
    .then((data) => {
      if (wa1ActiveCode !== code) return;
      const msgs = (data && data.messages) || [];
      const rows = msgs.filter((m) => m.direction === 'in' || m.body_zh);
      if (!rows.length) {
        box.innerHTML = '<div class="tv-empty">这个客户还没有采到消息</div>';
        return;
      }
      let lastOutIdx = -1;
      msgs.forEach((m, i) => { if (m.direction === 'out') lastOutIdx = i; });
      const idxOf = new Map();
      msgs.forEach((m, i) => idxOf.set(String(m.id), i));
      box.innerHTML = rows.slice(-30).map((m) => {
        const zh = String((m && (m.body_zh || m.bodyZh)) || '').trim();
        const en = String((m && m.body) || '').trim();
        // 🔴 2026-10-20：媒体消息的 base64 body / 垃圾 body_zh 都不当文本显示（同 renderConvInfo）
        const isMedia = isMediaMessage(m);
        const enShow = (isMedia && isBase64Garbage(en)) ? '' : en;
        const zhShow = isMedia ? '' : zh;
        // 🔴 v2.6.1124：按方向加 in/out 类，对话信息左右分侧（客户 in 靠左 / 我 out 靠右）
        const side = (m && m.direction === 'out') ? 'out' : 'in';
        // 🔴 v2.6.1142：只给「最后一条 out 之后」的 in 消息挂「💡 建议」（未回复的新消息）
        const isNew = m.direction === 'in' && (idxOf.get(String(m.id)) > lastOutIdx);
        const btn = isNew
          ? `<button class="tv-suggest" data-id="${esc(m.id)}" data-code="${esc(code)}" title="为这条还没回复的新消息生成 3 条回复建议">💡 建议</button>`
          : '';
        return `<div class="tv-msg ${side}" data-id="${esc(m.id)}">
          ${zhShow ? `<div class="tv-zh">${esc(zhShow)}</div>` : ''}
          ${enShow ? `<div class="tv-en">${esc(enShow)}</div>` : ''}
          ${btn}
        </div>`;
      }).join('');
      box.scrollTop = box.scrollHeight;                   // 停在最新一条
    })
    .catch(() => { box.innerHTML = '<div class="tv-empty">对话读取失败</div>'; });
}

/**
 * WA① 资料卡上的「↗ 跳到聊天」。
 * 🔴 铁律：只把内置浏览器**打开**这个客户的对话，**绝不发任何消息**。
 * 失败一律用 showNotice 提示（项目统一提示函数）。
 *
 * 🔴 已隐藏（2026-10-15 老板要求）：WA① 是软件内置浏览器，不需要「跳到聊天」按钮，
 *   这个函数的绑定已在 v2.6.1124 删除（app.js 的 bindWa1Buttons 不再绑）。
 *   函数本身暂留备用（无调用点），清单见「全局设置 → 🙈 隐藏说明」。
 */
async function jumpToWaChat(code, btn) {
  if (!code) return;
  if (btn) { btn.disabled = true; btn.textContent = '跳转中…'; }
  try {
    const r = await api(`/api/whatsapp/jump?customer=${encodeURIComponent(code)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (r && r.ok) {
      if (btn) btn.textContent = '已打开';
      showNotice && showNotice('已在 WhatsApp 里打开这个客户的对话');
    } else {
      showNotice && showNotice((r && r.error) || '跳转没成功');
    }
  } catch (e) {
    showNotice && showNotice('跳转异常：' + String((e && e.message) || e));
  } finally {
    if (btn) { setTimeout(() => { btn.disabled = false; btn.textContent = '↗ 跳到聊天'; }, 1200); }
  }
}

/**
 * WA① 右栏「对话信息」标题栏的「标记回复」按钮（2026-10-15 老板）。
 * 点一下 = 把这个 WA① 客户从左栏收起来（收进「已处理」），对话一条不删。
 *
 * 🔴 为什么不能直接复用通用那套 markReplied()（2026-10-15 老板实测报的 bug）：
 *    markReplied 的第一道闸门是 `if ($('btn-replied').disabled) return;`，
 *    那个按钮属于**通用中栏**，灰/亮由 renderChatFoot 依据 state.messages 算。
 *    而点左栏 WA① 客户时，openCustomerRow 走完 WA① 分支就 return（app.js:814），
 *    openCustomer() 根本没跑 → 通用中栏从没为这个客户算过 → 那道闸门一直是灰的
 *    → 点「标记回复」当场被 return 掉，接口一个字节都没发出去（活库证据：
 *      pending 一直停在客户最新一条入来的时间，从没被清过）。
 *    所以 WA① 这条走自己的路：不查通用按钮、也不重画通用中栏。
 *
 * 🔴 三件事，顺序不能乱：
 *    ① 发接口 —— 与通用那条路同一个：POST /api/customer/<code>/replied
 *       （服务端 db.clearPending：清 pending + unread + 标 processed，一处逻辑不分叉）
 *    ② 刷左栏 —— refreshCustomers() **不带 code**。带了会走 openCustomer(code)，
 *       把 WA① 客户画进通用中栏 —— 那不是它该待的地方（它只属于 WA① 页签）。
 *    ③ 清空 WA① 页签面板（对话信息 / 资料卡），回到"没选客户"的样子。
 *
 * 🔴 只收起、不删除：与通用那套口径完全一致 —— 来新消息照样再冒出来。
 */
async function markWa1Replied(btn) {
  const code = wa1ActiveCode || state.activeCode;
  if (!code) return;
  if (btn && btn.disabled) return;              // 防连点（这里的 disabled 只由本函数自己管）
  if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
  try {
    const r = await api(`/api/customer/${code}/replied`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skip: false }),
    });
    if (r && r.error) {
      showNotice('warn', r.error);
      return;
    }
    refreshToday();
    await refreshCustomers();                    // ⚠️ 不带 code：只重画左栏，绝不把 WA① 客户塞进通用中栏
    await refreshState();
    state.activeCode = null;                     // 这个客户已收起，不再是"当前选中"
    wa1ActiveCode = null;
    const ci = $('wa1-convinfo-body');
    if (ci) ci.innerHTML = '<div class="tv-empty">点左栏 WhatsApp 客户，这里列他这段对话的原话 + 中文</div>';
    const pb = $('wa1-profile-body');
    if (pb) pb.innerHTML = '<div class="tv-empty">点左栏 WhatsApp 客户看资料</div>';
    showNotice('ok', `${code} 已收进「已处理」—— 左栏那一格没了，对话完整保留在本地档案里（来新消息会再冒出来）`);
  } catch (e) {
    showNotice('warn', `标记回复失败：${(e && e.message) || e}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '标记回复'; }
  }
}

/** 三个按钮的绑定（点开客户档案 / 从对话里提取档案复用主面板同款逻辑） */
function bindWa1Buttons() {
  const full = $('wa1-profile-full');
  if (full) full.onclick = () => { if (wa1ActiveCode) openProfileModal(wa1ActiveCode); };
  const extract = $('wa1-profile-extract');
  if (extract) extract.onclick = () => { if (wa1ActiveCode) extractProfileFromChat(wa1ActiveCode, extract); };
  // 🔴 v2.6.1127 老板要的「↻ 补气泡」按钮：按消息编号重新补贴中文气泡（emoji/空格差异免疫）
  const repaint = $('wa1-repaint');
  if (repaint) repaint.onclick = () => repaintWaBubbles(repaint);
  // 🔴 2026-10-15 老板：WA① 右栏「对话信息」标题栏加「标记回复」按钮。
  //    ⚠️ 这里**不能**复用通用那套 markReplied()，原因见 markWa1Replied 的注释（闸门问题）。
  const markRepliedBtn = $('wa1-mark-replied');
  if (markRepliedBtn) markRepliedBtn.onclick = () => markWa1Replied(markRepliedBtn);
  // 🔴 v2.6.1124 删除「↗ 跳到聊天」按钮（老板 2026-10-15：内置浏览器就在软件里，不需要再跳）。
  //    jumpToWaChat 函数暂留（无其他调用点），清单见「全局设置 → 🙈 隐藏说明」（2026-10-15 老板要求）。
}

/* ---------------- Tele① 应用版（v2.5.1085）：原生会话列表 + 气泡，数据来自库 ----------------
 * 不再依赖 web.telegram.org 网页 / webview DOM；MTProto 采集已落库，这里只从库取。
 * 🔴 绝不自动发送：回复预填沿用既有 prefillChat，本模块不调任何发送。 */

/* 🔴 v2.6.1113 Tele②（老板 17:38 拍板：T② 独立，功能与 Tele① 一样）。
   原来 tgActiveCode 是**单个全局变量**，两个页签会互相抢「当前选中的客户」。
   现在改成**按页签分开存**：TG_ACTIVE = { tele1: code|null, tele2: code|null }，
   后面所有 tgActiveCode 的读写点都要换成 tgCodeOf(mp) / tgSetCode(mp, code)。
   · mp 只有一个字符（'1' / '2'），用来拼 id 后缀：'tgf-list' + mp → 'tgf-list' / 'tgf-list-2'
   ⚠️ HTML 里 tele2 的 id 后缀是 '-t2'，而 mp 是 '2' —— 统一用 tgEl(mp, 'tgf-list') 这个helper 取，别手拼。 */
/** 「↻ 补气泡」按钮：调后端立刻按 mid 重新匹配并重贴（v2.6.1127 / v2.6.1134 按账号路由到对应 WA 页签） */
async function repaintWaBubbles(btn, accId) {
  if (btn) { btn.disabled = true; btn.textContent = '补气泡中…'; }
  const aid = Number(accId) || WA_INSTANCES[0].accId;
  try {
    const r = await api('/api/whatsapp/bubble/repaint?account=' + aid, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const painted = (r && r.painted) || 0;
    const back = (r && r.backfilled) || 0;
    showNotice(`已补气泡：重贴 ${painted} 条${back ? ` · 触发补翻 ${back} 条` : ''}`, 'ok');
  } catch (e) {
    showNotice('补气泡失败：' + (e && e.message ? e.message : '未知错误'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ 补气泡'; }
  }
}

let tgActiveCode = null;      // 保留：兼容历史读写点，等全部换成 helper 之后再删
let tgActiveName = '';
let tgReplyTo = null; // { msgId, name } 引用回复目标
let tgListTimer = null;

/* ---- Tele① / Tele② 每页签各存一份「当前选中客户」和「收放状态」 ---- */
const TG_ACTIVE = { tele1: null, tele2: null };
const TG_CHAT_OFF = { tele1: false, tele2: false };
/** 取这个页签当前选中的客户编号 */
function tgCodeOf(mp) { return TG_ACTIVE[mp] || null; }
/** 设置这个页签当前选中的客户编号 */
function tgSetCode(mp, code) { TG_ACTIVE[mp] = code || null; }
/** 按页签取元素：tgEl('tele1','tgf-list') / tgEl('tele2','tgf-list') */
function tgEl(mp, base) { return $(mp === 'tele2' ? base + '-t2' : base); }
// 第三栏「Telegram 日志」：前端实时流水（v2.5.1086，纯前端，记录真实轮询/拉取/接收动作）
let tgLogLines = [];
/* 🔴 v2.6.1137：Tele① / Tele② 各自记各自的「上次状态文案」（5 秒轮询时不互相刷屏） */
const tgLastStatusText = { tele1: '', tele2: '' };
let tgLastConvCount = -1;
let tgLastMsgCount = -1;

/* 🔴 v2.6.1094 老板看图要求：第三栏那块「Telegram 日志」流水已经**换成「对话信息」**
   （index.html 里 .tg-log 整块删除，改成 .tv-conv）。原来这十几个 tgLog(...) 调用点
   **一个都不删**（删了就是改无关模块，违反改动范围铁律），只是把落点从那块死掉的
   流水 DOM 换成浏览器控制台 —— 排障时照样看得到，不影响界面。
   函数名与签名保持不变，所有既有调用点零改动。 */
function tgLog(msg) {
  console.log('[tg]', msg);
}

/** 切到 Tele① 拉一次会话列表；并 5 秒轻量轮询（只拉列表，不拉全文） */
function loadTgConversations() {
  const pull = () => api('/api/telegram/conversations')
    .then((r) => renderTgConvList((r && r.conversations) || []))
    .catch(() => {});
  pull();
  if (!tgListTimer) {
    tgListTimer = setInterval(() => {
      const pane = document.querySelector('.mid-pane[data-mp="tele1"]');
      if (pane && !pane.classList.contains('hidden')) pull();
    }, 5000);
  }
}

function renderTgConvList(rows) {
  const box = $('tg-list');
  if (!box) return;
  if (rows.length !== tgLastConvCount) {
    tgLastConvCount = rows.length;
    tgLog(rows.length ? `拉取会话列表 ${rows.length} 条` : '会话列表为空');
  }
  if (!rows.length) {
    box.innerHTML = '<div class="tg-conv-empty">还没有 Telegram 消息。MTProto 已连上，收到消息会自动出现在这里。</div>';
    return;
  }
  let html = '';
  for (const c of rows) {
    const unread = Number(c.unread) || 0;
    const active = c.code === tgActiveCode ? ' on' : '';
    const preview = String(c.preview || '').trim() || '(无文字消息)';
    html += `<div class="tg-item${active}" data-code="${esc(c.code)}" data-name="${esc(c.name || '')}">
      <div class="tg-ava">${esc((c.name || c.code || '?').slice(0, 1).toUpperCase())}</div>
      <div class="tg-meta">
        <div class="tg-name">${esc(c.name || c.code || '未知')}</div>
        <div class="tg-prev">${esc(preview)}</div>
      </div>
      ${unread ? `<span class="tg-unread">${unread}</span>` : ''}
    </div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('.tg-item').forEach((el) => {
    el.onclick = () => selectTgConv(el.dataset.code, el.dataset.name);
  });
}

function selectTgConv(code, name) {
  tgActiveCode = code;
  tgActiveName = name || '';
  clearTgReply();
  const title = $('tg-chat-title');
  if (title) title.textContent = name || code || 'Telegram 对话';
  document.querySelectorAll('#tg-list .tg-item').forEach((el) => el.classList.toggle('on', el.dataset.code === code));
  tgLog(`打开对话 ${name || code || ''}`);
  loadTgChat(code);
  loadTgProfile(code);
  loadTgAvatar(code);
}

let tgUserInfo = null; // 当前对话的 Telegram 资料（selectTgConv 时实时拉取缓存，浮层直接复用）

/** 中栏顶部 40×40 客户头像（v2.5.1088）：打开对话时实时取一次资料，填头像（有图）/ 首字母（无图） */
function loadTgAvatar(code) {
  const av = $('tg-avatar');
  if (!av) return;
  av.hidden = true;
  api(`/api/telegram/userinfo?customer=${encodeURIComponent(code)}&light=1`)
    .then((r) => {
      tgUserInfo = r || null;
      const name = (r && r.name) || tgActiveName || code || '?';
      const initial = name.trim().charAt(0).toUpperCase() || '?';
      av.textContent = '';
      if (r && r.ok && r.photoDataUrl) {
        const img = document.createElement('img');
        img.src = r.photoDataUrl; img.alt = name;
        av.appendChild(img);
      } else {
        av.textContent = initial;
      }
      av.hidden = false;
      av.title = name;
    })
    .catch(() => { av.hidden = true; });
}

/** 点头像打开「客户资料」浮层：点开时实时去 Telegram 网页取一次资料（头像/名称/用户名/手机号/最后上线） */
async function openTgUserinfo() {
  const pop = $('tg-userinfo');
  if (!pop) return;
  // 点开才取实时资料（避免每次切对话都去点资料卡闪一下）；取不到就用已缓存/库里的
  if (tgActiveCode) {
    try {
      const r = await api(`/api/telegram/userinfo?customer=${encodeURIComponent(tgActiveCode)}`);
      tgUserInfo = r || tgUserInfo;
    } catch (e) { /* 沿用已缓存 */ }
  }
  const r = tgUserInfo || {};
  const name = r.name || tgActiveName || '';
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const photo = $('tui-photo');
  const init = $('tui-initial');
  if (r.photoDataUrl) {
    if (photo) { photo.src = r.photoDataUrl; photo.style.display = ''; }
    if (init) { init.style.display = 'none'; }
  } else {
    if (photo) { photo.style.display = 'none'; }
    if (init) { init.style.display = ''; init.textContent = initial; }
  }
  const nm = $('tui-name'); if (nm) nm.textContent = name;
  const ls = $('tui-lastseen'); if (ls) ls.textContent = r.lastSeen ? `最后上线：${r.lastSeen}` : '';
  const ph = $('tui-phone'); if (ph) ph.textContent = r.phone || '（Telegram 未提供）';
  const un = $('tui-username'); if (un) un.textContent = r.username ? `@${r.username}` : '（无）';
  pop.hidden = false;
}

function closeTgUserinfo() { const p = $('tg-userinfo'); if (p) p.hidden = true; }

/** 点击浮层/头像以外的区域自动关闭（弹层隐藏时无副作用） */
function tgUserinfoOutside(e) {
  const pop = $('tg-userinfo');
  const av = $('tg-avatar');
  if (!pop || pop.hidden) return;
  if (pop.contains(e.target) || (av && av.contains(e.target))) return;
  closeTgUserinfo();
}
document.addEventListener('click', tgUserinfoOutside);

function loadTgChat(code) {
  if (!code) return;
  api(`/api/telegram/messages?customer=${encodeURIComponent(code)}`)
    .then((r) => {
      const msgs = (r && r.messages) || [];
      if (msgs.length !== tgLastMsgCount) {
        tgLastMsgCount = msgs.length;
        tgLog(`读取对话 ${msgs.length} 条`);
      }
      renderTgChat(msgs);
    })
    .catch(() => { tgLog('读取对话失败'); });
}

/* ---------------- v2.6.1136：Telegram 正文时间剥离 + 「时间方框」 ----------------
 * 事故：Telegram 抓取用 textContent 把气泡里的「14:03」一起吞进正文 → body = "Hello 14:03"，
 *   界面再单独渲染一次时间 → **时间出现两次**；翻译也把时间一起翻 → 气泡显示「你好 14:03」。
 * 采集侧（src/telegramRead.js / src/telegramMtproto.js）已经把时间剥进 messages.msg_time，
 * 下面是**渲染前的第二道保险**：库里躺着老数据（body 还带着时间）也不会重复显示，
 * 译文气泡里也绝不会出现时间。时间**只渲染一次**，用一个带边框的方框单独展示。
 * 🔴 只在 Telegram 会话里用（.tg-crow），不动其它渠道的任何渲染。 */
const TG_TRAIL_TIME_RE = /(?:上午|下午|凌晨|早上|中午|晚上)?\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[AaPp][Mm])?\s*$/;

/**
 * 🔴 v2.6.1138：洗掉正文里的**不可见字符**（老板截图里的「豆腐块」真身）。
 * 实证（生产库 2026-10-16）：Telegram 用**私用区字符**包住我方(out)消息的时间 ——
 *   "hi" + U+E901 + "12:10" + U+E901（实际库里还见到 U+E900 / U+EA21，不止一个码位）
 * 私用区字符不是 `\s`，所以上面那条尾部时间正则**匹配不上** → 时间留在正文里变豆腐块；
 * 而 messages.msg_time 又存了一份 → **一条消息两个时间**。所以必须**先洗再剥**。
 * 与采集侧 src/telegramMerge.js 的 stripInvisible() 同一套规则（前端这边是独立副本，
 * 因为 public/ 不能 require src/；改一处必须同步改另一处）。
 * ⚠️ 故意不洗 U+FE00–U+FE0F（emoji 变体选择符），洗了 emoji 会掉变体变黑白。
 */
const TG_INVISIBLE_RE = new RegExp(
  // 🔴 单个字符类：一个字符只要落在任一区间就被洗掉。
  // ⚠️ U+200D (ZWJ) 故意不列 —— 它是 emoji 组合序列的一部分（👨‍🎻 = U+1F468 U+200D U+1F3BB），
  //    洗掉会毁掉 emoji。U+FE00–U+FE0F 变体选择符同理故意不列。
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B\\u200C\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\uE000-\\uF8FF]',
  'gu',
);

/** 洗掉不可见字符（不动可见文字 / 大小写 / 标点） */
function tgStripInvisible(raw) {
  return String(raw == null ? '' : raw).replace(TG_INVISIBLE_RE, '');
}

/** 剥出正文尾部的时间。@returns {{text:string, time:string}} */
function tgSplitTime(text, storedTime) {
  const src = tgStripInvisible(text);          // 🔴 先洗不可见字符，再剥时间
  const fallback = String(storedTime == null ? '' : storedTime).trim();
  const m = src.match(TG_TRAIL_TIME_RE);
  if (!m) return { text: src.trim(), time: fallback };
  const left = src.slice(0, m.index).trim();
  const hit = String(m[0] || '').trim();
  if (!left) return { text: '', time: hit || fallback };  // 原本就只剩一个时间
  return { text: left, time: hit || fallback };
}

/** 时间方框的 HTML（没有时间就返回空串 —— 时间只在 Telegram 会话里渲染一次） */
function tgTimeBoxHtml(time) {
  const t = String(time == null ? '' : time).trim();
  if (!t) return '';
  return `<div class="tg-time-box">${esc(t)}</div>`;
}

/** 画聊天气泡：对方左浅色、自己右蓝；中文译文深蓝加粗跟在原文下（沿用界面铁律配色） */
function renderTgChat(rows) {
  const box = $('tg-conv-body');
  const sub = $('tg-conv-sub');
  if (!box) return;
  if (sub) sub.textContent = rows.length ? `${rows.length} 条` : '';
  if (!rows.length) {
    box.innerHTML = '<div class="tg-conv-empty">这个对话还没有采到消息。</div>';
    return;
  }
  let html = '';
  for (const m of rows) {
    const isOut = m.direction === 'out';
    // 🔴 v2.6.1136：先把正文尾部的时间剥出来（第二道保险），时间只渲染一次
    const sp = tgSplitTime(String(m.body || '').trim(), (m.msg_time || m.msgTime));
    const body = sp.text;
    // 译文里也绝不能带时间（老译文可能翻成「你好 14:03」）
    const zh = tgSplitTime(String(m.bodyZh || m.body_zh || '').trim()).text;
    const text = body || (m.hasMedia ? '(图片/媒体)' : '');
    let zhHtml = '';
    if (!isOut) {
      /* 🔴 v2.6.1194：乱码气泡写「译 乱码无法翻译」。
       *   判据读的是**后端下的 tgGarbled 标记**（src/server.js 用 telegramMerge.isGarbledText 算），
       *   前端不自己判 —— 规则全项目只有一份，两边不会漂移。
       *   放在「有没有译文」这一层**最前面**：所以 id 1883 那种已经被当成正常译文
       *   持久化进 body_zh 的垃圾译文（模型回的那句「抱歉，这是一条密钥…」）也会被盖掉。
       *   样式复用本函数现有的 tg-zh / tg-zh-tag 结构，不自创样式。
       *   与下面 renderTgChat(code, mp) 那处**必须一致**（两处原有注释也这么写）。 */
      if (m.tgGarbled) zhHtml = '<div class="tg-zh"><span class="tg-zh-tag">译</span>乱码无法翻译</div>';
      else if (zh) zhHtml = `<div class="tg-zh"><span class="tg-zh-tag">译</span>${esc(zh)}</div>`;
      else if (body && !/[\u4e00-\u9fa5]/.test(body)) zhHtml = '<div class="tg-zh wait">待翻译</div>';
    }
    const mid = m.id != null ? m.id : '';
    // 🔴 v2.6.1138：正文剥空且没有媒体 = 这条本来就是「只有时间」的状态行
    //   （生产库 #1010 就是body="00:16" 的通话时长行，采集侧本该丢弃、当年错存进来了）。
    //   以前会渲染成一条假的「(图片/媒体)」空泡，老板截图里那条空蓝框就是它。
    //   现在只显示时间、不造空泡；库里的数据一个字不删（要不要删是老板的决定）。
    if (!text) {
      const t = tgTimeBoxHtml(sp.time);
      if (!t) continue;                    // 既没正文也没时间 → 整条不渲染
      html += `<div class="tg-crow ${isOut ? 'out' : 'in'} solo" data-mid="${esc(String(mid))}">
        <div class="tg-line">${t}</div>
      </div>`;
      continue;
    }
    html += `<div class="tg-crow ${isOut ? 'out' : 'in'}" data-mid="${esc(String(mid))}" title="点击引用回复">
      <div class="tg-line"><div class="tg-bubble">${esc(text)}</div>${tgTimeBoxHtml(sp.time)}</div>
      ${zhHtml}
    </div>`;
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
  // 点气泡 = 引用回复（点自己已发的 out 也允许引用）
  box.querySelectorAll('.tg-crow').forEach((el) => {
    el.onclick = () => {
      const mid = el.dataset.mid;
      if (mid) setTgReply(mid, tgActiveName, el.querySelector('.tg-bubble') ? el.querySelector('.tg-bubble').textContent : '');
    };
  });
}

/* ---------------- Tele① 回复框（v2.5.1087）：引用回复 + 真发送 ---------------- */

function setTgReply(msgId, name, preview) {
  tgReplyTo = { msgId, name: name || '' };
  const box = $('tg-reply');
  const txt = $('tg-reply-text');
  if (box) box.hidden = false;
  if (txt) txt.textContent = `回复 @${name || '客户'}：${(preview || '').slice(0, 30)}`;
}
function clearTgReply() {
  tgReplyTo = null;
  const box = $('tg-reply');
  if (box) box.hidden = true;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const r = fr.result || '';
      const i = r.indexOf(',');
      resolve(i >= 0 ? r.slice(i + 1) : r);
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function appendOutBubble(text, isMedia) {
  const box = $('tg-conv-body');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'tg-crow out';
  div.innerHTML = `<div class="tg-bubble">${esc(isMedia ? '(图片/媒体)' : (text || ''))}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function tgSend() {
  const code = tgActiveCode;
  if (!code) { tgLog('未选择对话，无法发送'); return; }
  const input = $('tg-input');
  const text = (input && input.value || '').trim();
  const fileInput = $('tg-file');
  const file = (fileInput && fileInput.files && fileInput.files[0]) || null;
  if (!text && !file) { tgLog('请输入内容或选择图片/视频'); return; }
  const btn = $('tg-send');
  if (btn) btn.disabled = true;
  try {
    const body = { code };
    if (tgReplyTo) body.replyTo = tgReplyTo.msgId;
    if (file) {
      body.mediaBase64 = await fileToBase64(file);
      body.mediaName = file.name;
      body.caption = text;
    } else {
      body.text = text;
    }
    const r = await api('/api/telegram/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r && r.ok) {
      tgLog(file ? `已发送媒体：${file.name}` : `已发送：${text.slice(0, 20)}`);
      appendOutBubble(text, !!file); // 乐观显示已发气泡
      if (input) input.value = '';
      if (fileInput) fileInput.value = '';
      clearTgReply();
    } else {
      tgLog('发送失败：' + ((r && r.error) || '未知错误'));
    }
  } catch (e) {
    tgLog('发送异常：' + ((e && e.message) || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 第三栏资料卡：从 /api/customer/:code 取真实客户档案渲染（v2.5.1086）
 *  🔴 v2.6.1113 加 mp 参数支持 Tele②（HTML 里 tele2 的 id 后缀是 '-t2'） */
async function loadTgProfile(code, mp) {
  const pane = mp || 'tele1';
  const body = tgEl(pane, 'tg-profile-body');
  if (!body) return;
  if (!code) { body.innerHTML = '<div class="tp-empty">点开左侧会话查看资料</div>'; return; }
  try {
    const r = await api(`/api/customer/${encodeURIComponent(code)}`);
    renderTgProfile(r && r.customer, r && r.autoTimezone, pane);
    /* 🔴 v2.6.1113 指令①：把「这个客户采到了什么 / 没采到什么」写进采集数据日志。
       老板原话：「采集了哪些数据客户资料客户的信息，**哪怕没有采集到**都需要展示在这里」 */
    const c = (r && r.customer) || {};
    const phone = c.phone || '';
    const username = c.username || c.tg_username || '';
    const accNo = String(code || '').charAt(0);
    const who = accNo === '8' ? 'T②' : 'T①';
    if (phone || username) {
      const bits = [];
      if (phone) bits.push(`手机号 ${phone}`);
      if (username) bits.push(`用户名 @${String(username).replace(/^@/, '')}`);
      appendTgLog(pane, 'ok', who, `${c.name || code} · 采到 ${bits.join(' / ')}`);
    } else {
      // 客户在库里但手机号/用户名都没采到 —— 这也要写一行（老板要求"没采到也展示"）
      appendTgLog(pane, 'miss', who, `${c.name || code} · 未获取到手机号 / 用户名（该客户可能没授权或没聊过）`);
    }
  } catch (e) {
    body.innerHTML = '<div class="tp-empty">资料读取失败</div>';
    const accNo = String(code || '').charAt(0);
    appendTgLog(pane, 'err', accNo === '8' ? 'T②' : 'T①',
      `${code} · 资料读取失败：${(e && e.message) || e}`);
  }
}

/**
 * 🔴 v2.6.1094 老板看图定稿（QQ20261013-150420.png）：Tele① 第三栏的「客户资料卡」。
 *
 * 🔴 铁律：这里**只显示基本信息**，一共就这七样：
 *     编号 / 名称 / 加入时间 / ★认识第 N 天★ + Day N / 地区 / 客户当地时间
 *     —— 跟「通用」中栏顶部那张档案条（renderChatHead 的 .ch-facts）**完全同一套字段**。
 *     「客户档案」是**按钮**，点了才弹那个 16 项的完整窗口（openProfileModal）；
 *     资料卡本身**不做**那个窗口（2026-10-13 我第一次就是画错成那样，被老板纠正过）。
 *
 * 排版 = 老板选定的**方案一：竖排单列**，一行一条，窄栏永不挤成一团。
 * 颜色一个不自己发明，全部沿用通用那边 style.css 里的真值：
 *   加入时间 var(--red) / 认识第N天 var(--accent)蓝 / Day #7c3aed紫 /
 *   地区 #7c3aed紫 / 客户当地时间 var(--green) / 星 #f5b301黄
 */
function renderTgProfile(c, autoTz, mp) {
  const body = tgEl(mp || 'tele1', 'tg-profile-body');
  if (!body) return;
  if (!c) {
    body.innerHTML = '<div class="tv-empty">这个客户还没建档</div>';
    return;
  }
  const now = new Date();
  const joined = fmt(c.created_at || c.joined_at) || '—';
  const days = daysSince(c.created_at || c.joined_at);
  const dayNo = days != null ? days : 0;

  // 时区口径与 renderChatHead 完全一致：档案里的手填时差数字优先 → 再用按地区推的 IANA。
  const tzHand = tzManualHours(c.timezone) !== null ? String(c.timezone).trim() : '';
  const tz = c.timezone || (autoTz || '');
  const loc = localTimeOf(tz);
  const locTip = tz
    ? (tzHand
      ? `手填时差 ${Number(tzHand) > 0 ? '+' : ''}${tzHand} 小时（客户那边现在几点按它算）`
      : String(tz))
    : '还没填时区 —— 在「客户档案」里填了时区这里就会走';

  const regionHtml = c.region
    ? `<span class="chip chip-region">${esc(c.region)}</span>`
    : '<span class="tv-empty">未填</span>';

  body.innerHTML = `
    <div class="tv-head">
      <span class="code">${esc(c.code || '—')}</span><span class="name-label">名称:</span><span class="cname">${esc(c.name || '未命名')}</span>
    </div>
    <div class="tv-ln"><b class="tv-f-joined">加入时间</b><span class="tv-val">${esc(joined)}</span></div>
    ${days !== null ? `<div class="tv-ln"><i class="tv-star">★</i><i class="tv-sub-joined">认识</i><span class="tv-day-num">第 ${days} 天</span><i class="tv-star">★</i><b class="tv-fact-day" title="加入后第几天：按加入时间算，加入当天 = Day 1">Day ${dayNo}</b></div>` : ''}
    <div class="tv-ln sep"><b class="tv-f-region">地区</b>${regionHtml}</div>
    <div class="tv-ln"><b class="tv-f-loc" title="${esc(locTip)}">客户当地时间</b><span class="tv-val">${esc(loc || '—')}</span>${tz ? '' : '<i class="tv-sub-joined">（在右栏填了时区就会显示）</i>'}</div>`;

  // v2.6.1107：软件版好友资料块（getUserProfile 经 MTProto 官方通道提供）。
  // 这些字段库里不一定有，缺的一律给占位、不硬凑；手机号强制带 + 号（老板要求）。
  const phone = String(c.phone || '').trim();
  const username = String(c.tg_username || c.username || '').trim();
  const online = String(c.online || '').trim();
  const phoneShow = phone ? (phone.startsWith('+') ? esc(phone) : '+' + esc(phone)) : '（官方通道未提供）';
  const userShow = username ? '@' + esc(username.replace(/^@/, '')) : '（官方通道未提供）';
  const onlineShow = online || '（官方通道未提供）';
  body.insertAdjacentHTML('beforeend', `
    <div class="tv-ln sep"><b style="color:#1f6aa5;">手机号</b><span class="tv-val" style="font-weight:700;">${phoneShow}</span></div>
    <div class="tv-ln"><b style="color:#1f6aa5;">Username</b><span class="tv-val">${userShow}</span></div>
    <div class="tv-ln"><b style="color:#2e9e5b;">在线状态</b><span class="tv-val">${onlineShow}</span></div>
    <div class="tv-ln sep"><b style="color:#a795de;">来源</b><span class="tv-val">Telegram 官方通道（MTProto）</span></div>
  `);
}

/**
 * v2.6.1107 · Tele① 软件版「好友对话选择」列表。
 *
 * 数据来源（按可用情况降级）：
 *   ① 已登录 MTProto 官方通道 → 真实对话列表（getUserProfile 拿手机号 / username / 在线状态），后续接 telegramOfficialChannel；
 *   ② 没登录时 → 本地已建档的 Telegram 客户（state.customers 里 channel='telegram' 的），点一个同样能看资料卡和对话。
 * 选中 → 复用现有的 loadTgProfile + renderTgConvInfo（和左栏点 ∮ 客户完全同一条路）。
 */
/* 🔴 v2.6.1112 「对话信息」列（Tele① 的 ③ 号栏目）的手动收/展开关。
   背景（老板 QQ20261014-140415 红框反馈）：v2.6.1111 用 display:none 把整列永久藏掉，
   老板反馈「改完就不能展开对话信息」。现在改成两套并存、互不干扰：
     ① 自动：.tg-chat 是 flex:1 1 300px + min-width:0 → 主窗口够宽就占剩余，
             收窄就自己压到 0（这一段纯 CSS，零 JS）
     ② 手动：这个函数切 .tele-wrap 的 .tgchat-off class → 老板想主动收起时点按钮。
   状态存 localStorage（跨重启记住），切 Tele①/Tele② 页签时由 syncTgChatToggle 补一次。 */
let tgChatHidden = false;
try { tgChatHidden = localStorage.getItem('tg.chatHidden') === '1'; } catch (e) { /* 隐私模式忽略 */ }

function applyTgChatToggle() {
  /* 🔴 用 querySelectorAll 而不是 querySelector：测试桩的 document 只实现了前者，
     这里跟着桩走，app.js 顶层就不会在自检里报「document.querySelector is not a function」。
     🔴 v2.6.1113 Tele② 也要跟着收放 —— 两个 .tele-wrap 一起切。 */
  document.querySelectorAll('.mid-pane[data-mp="tele1"] .tele-wrap, .mid-pane[data-mp="tele2"] .tele-wrap')
    .forEach((wrap) => wrap.classList.toggle('tgchat-off', tgChatHidden));
  ['tele1', 'tele2'].forEach((pane) => {
    const btn = tgEl(pane, 'tg-chat-toggle');
    if (btn) {
      btn.classList.toggle('on', !tgChatHidden);
      btn.title = tgChatHidden ? '展开「对话信息」列（快捷键 Alt+D）' : '收起「对话信息」列（快捷键 Alt+D）';
    }
  });
}
function toggleTgChat() {
  tgChatHidden = !tgChatHidden;
  try { localStorage.setItem('tg.chatHidden', tgChatHidden ? '1' : '0'); } catch (e) { /* 忽略 */ }
  applyTgChatToggle();
  showNotice(tgChatHidden ? '已收起「对话信息」列' : '已展开「对话信息」列');
}

/* 🔴 v2.6.1113 指令①：Telegram「采集数据」日志（老板 2026-10-14 17:31 看图点名，位置见 index.html 红框）
 *  老板原话：「展示放置 Telegram 采集数据，采集了哪些数据客户资料客户的信息，
 *            **哪怕没有采集到都需要展示在这里，当成日志**」
 *  → 硬要求：一条都没有时**也要显示占位行**，绝不出现空白框。
 *  → 每行：[时间] [账号] [采到什么]，四色：ok 采到 / miss 没采到 / err 失败 / info 事件
 * Tele① 和 Tele② 各有一份（id后缀区分），互不干扰。 */
const TG_LOG_MAX = 300;
function tgLogBody(mp) { return $('tg-log-body-' + mp); }

/** 往指定页签的日志里加一行。kind: ok|miss|err|info|plain */
function appendTgLog(mp, kind, who, text) {
  const body = tgLogBody(mp);
  if (!body) return;
  // 第一行若是占位行，加真日志时先清掉（老板要求"哪怕没采到也展示"，
  // 但真采到第一条时占位就该让位，否则看起来像一直没采到）
  const ph = body.querySelector('.tg-log-placeholder');
  if (ph && kind !== 'plain') ph.remove();
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const div = document.createElement('div');
  div.className = 'tg-log-line ' + (kind === 'plain' ? '' : kind);
  const ts = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  div.innerHTML = `<span class="ts">${ts}</span>` + (who ? `<span class="who">${esc(who)}</span>` : '') + esc(text);
  body.appendChild(div);
  // 只留最近 N 条，别把内存和滚动条撑爆
  while (body.children.length > TG_LOG_MAX) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
}

/** 启动占位：两个页签各写一行「等待采集」，绝不空白（老板明确要求） */
function initTgCollectLog() {
  ['tele1', 'tele2'].forEach((mp) => {
    const body = tgLogBody(mp);
    if (!body) return;
    body.innerHTML = '<div class="tg-log-line tg-log-placeholder muted">等待采集…（采到一条记一条，没采到也会写明原因）</div>';
  });
  /*🔴 用 tgEl 取「清空」按钮 —— HTML 里 tele1 带 -tele1 后缀、tele2 带 -t2 后缀，
     不能用无后缀的旧 id（v2.6.1113 加日志区时已经不存在了）。
     ⚠️ 这段注释别再把那个旧 id 的调用形式原样抄进来：
     test/run_all.js 用正则扫「$( + 引号 + id + 引号 + 右括号」这种字面量核对落点，
     **写在注释里也会被当成真代码命中** → 凭空多一条 FAIL。今天已经踩了两次。 */
  ['tele1', 'tele2'].forEach((mp) => {
    const cl = tgEl(mp, 'tg-log-clear');
    if (cl) cl.onclick = () => { initTgCollectLog(); showNotice('采集日志已清空'); };
  });
}

/** Tele① / Tele② 的好友对话列（v2.6.1113 加 mp 参数支持双页签）
 *  @param mp 'tele1' | 'tele2'
 *  @param onlyAcc 可选：只显示属于某个 TG 账号的客户编号段（如 '7' / '8'），undefined=不过滤 */
function renderTgFriends(mp, onlyAcc) {
  const pane = mp || 'tele1';
  const list = tgEl(pane, 'tgf-list');
  if (!list) return;
  let friends = (Array.isArray(state.customers) ? state.customers : []).filter(isTelegramCustomer);
  // 🔴 Tele② 只显示 T②（编号段 8）的客户，Tele① 只显示 T①（编号段 7）的 —— 天然隔离
  if (onlyAcc) {
    const seg = String(onlyAcc);
    friends = friends.filter((c) => String(c.code || '').charAt(0) === seg);
  }
  const cur = tgCodeOf(pane);
  if (!friends.length) {
    list.innerHTML = '<div class="tv-empty">登录后这里列出你的 Telegram 对话</div>';
    return;
  }
  friends.sort((a, b) => (Number(b.unread) || 0) - (Number(a.unread) || 0));
  list.innerHTML = friends.map((c) => {
    const code = c.code || '';
    const ini = (c.name || code || '?').trim().charAt(0).toUpperCase() || '?';
    const unread = Number(c.unread) || 0;
    const preview = c.last_body_zh || c.last_body || '';
    const on = code === cur ? ' on' : '';
    return `<div class="tgf-row${on}" data-code="${esc(code)}">
      <span class="tg-ava">${esc(ini)}</span>
      <div class="tgf-meta">
        <div class="tgf-top"><span class="tgf-name">${esc(c.name || '未命名')}</span></div>
        <div class="tgf-prev">${esc(preview)}</div>
      </div>
      ${unread ? `<span class="tgf-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
    </div>`;
  }).join('');
  list.querySelectorAll('.tgf-row').forEach((el) => {
    el.onclick = () => {
      const code = el.getAttribute('data-code');
      tgSetCode(pane, code);
      tgActiveCode = code;            // 兼容还没换完的历史读写点
      switchMidTab(pane);
      loadTgProfile(code, pane);
      renderTgConvInfo(code, pane);
      /* 🔴 v2.6.1111 指令②（老板新要求，两件事）：
         ① 点 T 好友 → 「话术编排台」切到这个客户。这里原来只设了 tgActiveCode，
            没设 state.activeCode、没调 Board.syncFor（那是 openCustomer 才做的，
            而点好友这条路根本不走 openCustomer）→ 编排台永远不跟 T 客户走。
         ② 与左栏互斥：点 T 好友 = 正在看这个人，把左栏那条 .cust.active 高亮摘掉，
            否则左栏还亮着上一个人，看上去像同时选了两个客户。 */
      state.activeCode = code;
      if (window.Board && typeof window.Board.syncFor === 'function') window.Board.syncFor(code);
      for (const c of document.querySelectorAll('.cust.active')) c.classList.remove('active');
      renderTgFriends(pane, onlyAcc); // 刷新高亮
    };
  });
}

/**
 * 🔴 v2.6.1094 Tele① 资料卡上的「↗ 跳到聊天」按钮。
 *
 * 铁律：只把内置浏览器**打开**这个客户的对话并滚到最新，**绝不发任何消息**。
 * 失败一律用 showNotice 提示（项目统一提示函数），不用 toast（已删）。
 */
async function jumpToTgChat(code, btn) {
  if (!code) return;
  if (btn) { btn.disabled = true; btn.textContent = '跳转中…'; }
  try {
    const r = await api(`/api/telegram/jump?customer=${encodeURIComponent(code)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (r && r.ok) {
      if (btn) { btn.textContent = '已打开'; }
      showNotice && showNotice('已在 Telegram 里打开这个客户的对话');
    } else {
      const why = (r && r.error) || '跳转没成功';
      showNotice && showNotice(why);
    }
  } catch (e) {
    showNotice && showNotice('跳转异常：' + String((e && e.message) || e));
  } finally {
    if (btn) { setTimeout(() => { btn.disabled = false; btn.textContent = '↗ 跳到聊天'; }, 1200); }
  }
}

/**
 * 🔴 v2.6.1108 翻译铁律（老板 2026-10-14 亲口）：
 * 中文消息**绝不弹「译」气泡**（不需要翻译）；任何非中文（英/西/法/俄/日…）都译成中文。
 * 判定口径与 onTelegramMessageLive 一直用的那条一致：正文里一个汉字都没有 → 非中文。
 */
function tgMsgIsChinese(text) {
  return /[\u4e00-\u9fa5]/.test(String(text || ''));
}

/**
 * v2.6.1108：「对话信息」独立成列 —— 中间那列（好友对话 ↔ 客户资料卡之间，红框位置）。
 * 客户消息在左（灰气泡）、我方消息在右（蓝气泡）；双方只要不是中文，
 * 下面都跟一个「译」气泡（浅蓝底 + 深蓝 #1f6aa5 中文），紧贴在消息正下方。
 * 数据走 /api/customer/<code>（和旧资料卡底部版同一条路），只画最近的 30 条。
 */
// 🔴 2026-10-21：Telegram 对话信息顶部的媒体缩略图带（复用 WA 同套 .tv-img-row / .conv-thumb 样式）。
//   只展示图片/语音/视频（视频用首帧缩略图 + 🎬 角标）；媒体文件本体走 /media/ 路由直接出图。
function tgMediaStripHtml(msgs) {
  const mediaMsgs = (msgs || []).filter((m) => {
    const k = String(m.mediaKind || m.mediaType || '').toLowerCase();
    return (m.direction === 'in' || m.direction === 'out')
      && (m.media_path || /^(image|sticker|video|audio|ptt)$/.test(k));
  });
  if (!mediaMsgs.length) return '';
  return '<div class="tv-img-row">' + mediaMsgs.slice(-30).map((m) => {
    const k = String(m.mediaKind || m.mediaType || '').toLowerCase();
    if (m.media_path) {
      const nm = String(m.media_path).split(/[\\/]/).pop();
      const url = '/media/' + encodeURIComponent(nm);
      if (k === 'image' || k === 'sticker') {
        const tip = esc(String(m.body || '').slice(0, 60));
        return `<img class="conv-thumb" src="${url}" title="${tip}" alt="${tip}" loading="lazy" onerror="this.classList.add('conv-thumb-bad')">`;
      }
      if (k === 'video') {
        return `<a class="conv-thumb-link" href="${url}" target="_blank" rel="noopener" title="点开看视频首帧">`
          + `<img class="conv-thumb" src="${url}" alt="视频缩略图" loading="lazy" onerror="this.classList.add('conv-thumb-bad')">`
          + `<span class="conv-thumb-badge">🎬 视频</span></a>`;
      }
      if (k === 'audio' || k === 'ptt') return `<a class="conv-ph" href="${url}" target="_blank" rel="noopener">🎤 语音</a>`;
      return `<a class="conv-ph" href="${url}" target="_blank" rel="noopener">📎 文件</a>`;
    }
    const phTxt = k === 'video' ? '视频' : (k === 'audio' || k === 'ptt') ? '语音' : k === 'sticker' ? '贴纸' : '图片';
    return `<span class="conv-ph conv-ph-wait">${phTxt} · 正在取文件…</span>`;
  }).join('') + '</div>';
}

function renderTgChat(code, mp) {
  const pane = mp || 'tele1';
  const box = tgEl(pane, 'tg-chat-body');
  const sub = tgEl(pane, 'tg-chat-sub');
  if (!box) return;
  if (!code) {
    box.innerHTML = '<div class="tv-empty">点一个好友，这里列他这段对话的原话 + 中文</div>';
    if (sub) sub.textContent = '点一个好友，这里列他这段对话';
    return;
  }
  if (sub) {
    const c = (Array.isArray(state.customers) ? state.customers : []).find((x) => x && x.code === code);
    sub.textContent = (c && c.name) ? `${c.name} · ${code}` : code;
  }
  api(`/api/customer/${encodeURIComponent(code)}`)
    .then((data) => {
      if (tgCodeOf(pane) !== code) return;                // 期间又切走了就别画了（按页签判，别被另一个页签抢
      const msgs = (data && data.messages) || [];
      const strip = tgMediaStripHtml(msgs);
      if (!msgs.length) {
        box.innerHTML = '<div class="tv-empty">这个客户还没有采到消息</div>';
        return;
      }
      box.innerHTML = strip + msgs.slice(-30).map((m) => {
        const isOut = m.direction === 'out';
        // 🔴 v2.6.1136：正文尾部时间先剥出来（第二道保险），时间只用方框渲染一次
        const sp = tgSplitTime(String(m.body || '').trim(), m.msg_time);
        const body = sp.text;
        // 🔴 字段名兼容：后端返回 body_zh，老数据有 bodyZh，两个都读（2026-10-13 修过的坑）
        //    译文里也绝不能带时间 —— 老的译文可能翻成了「你好 14:03」，这里再剥一次
        const zh = tgSplitTime(String((m && (m.body_zh || m.bodyZh)) || '').trim()).text;
        /* 🔴 翻译铁律：中文不出译气泡；非中文且有译文才出
         * 🔴 v2.6.1194：乱码统一写「译 乱码无法翻译」，且**排在译文判断之前** ——
         *   1) 判据读后端下的 tgGarbled 标记（规则只有一份，见 src/server.js withTranslationState）
         *   2) 排在前面才能盖掉「已经被当成译文存进 body_zh 的垃圾译文」（生产库 id 1883）
         *   3) 样式复用本函数现有的 tg-zh / tg-zh-tag，不自创样式
         *   与上面 renderTgChat(rows) 那处**必须一致**（两处原有注释也这么写）。 */
        const zhHtml = m.tgGarbled
          ? '<div class="tg-zh"><span class="tg-zh-tag">译</span>乱码无法翻译</div>'
          : ((zh && !tgMsgIsChinese(body))
            ? `<div class="tg-zh"><span class="tg-zh-tag">译</span>${esc(zh)}</div>`
            : '');
        // 🔴 v2.6.1138：正文剥空 = 「只有时间」的状态行（生产库 #1010 通话时长行），
        //   不造假的「(图片/媒体)」空泡，只显示时间；整条没内容就连行都不出。
        //   与 renderTgChat 同款处理，两处必须一致。
        if (!body) {
          const t = tgTimeBoxHtml(sp.time);
          return t ? `<div class="tg-crow ${isOut ? 'out' : 'in'} solo"><div class="tg-line">${t}</div></div>` : '';
        }
        return `<div class="tg-crow ${isOut ? 'out' : 'in'}">
          <div class="tg-line"><div class="tg-bubble">${esc(body)}</div>${tgTimeBoxHtml(sp.time)}</div>${zhHtml}
        </div>`;
      }).join('');
      box.scrollTop = box.scrollHeight;                   // 停在最新一条
    })
    .catch(() => {
      box.innerHTML = '<div class="tv-empty">对话读取失败</div>';
    });
}

/**
 * v2.6.1094：「对话信息」区 —— 替掉原来那块「Telegram 日志」流水。
 * 🔴 v2.6.1108：这块已从资料卡底部**搬出来独立成列**（中间 .tg-chat），
 * 旧容器 #tg-convinfo-body 已删除。既有 3 个调用点（openCustomerRow /
 * switchMidTab / renderTgFriends 的点击）一个字都不用改 —— 这里直接转调新列。
 */
function renderTgConvInfo(code, mp) {
  renderTgChat(code, mp || 'tele1');
}

/** MTProto 实时广播：收到新 Telegram 消息 → 好友列/对话列即时刷新 */
function onTelegramMessageLive(m) {
  if (!m || m.accountId == null || m.accountId < 7) return;
  const pane = document.querySelector('.mid-pane[data-mp="tele1"]');
  if (!pane || pane.classList.contains('hidden')) return;   // 没打开 Tele① 不用白刷
  /* 🔴 v2.6.1109 修复两处死逻辑（老板报「收不到新消息提示」）：
     ① 原来调 loadTgConversations() 画的 #tg-list 早在 v2.6.1093 删网页版时就没了 → 空调用；
     ② 原来判 `m.customerCode === tgActiveCode` —— MTProto 推来的对象里**没有 customerCode**
        这个字段（只有 accountId / customerKey / displayJid / msgId …），所以这段永远不执行。
     现在改成：好友列 + 未读徽标即时重绘；正在看谁就把他的对话列重画一遍（库里已有这条消息）。 */
  renderTgFriends();
  if (tgActiveCode) renderTgChat(tgActiveCode);
}




/* ---------------- 手动自由翻译面板（右栏，替换原「AI 建议」） ---------------- */

/** 主窗口最大化状态 → 给 body 加/去 .win-max，让右栏宽度在 450px（平时）/ 500px（最大化）间切换。
 *  仅桌面端有效（win:state 由 electron/main.js 在 maximize/unmaximize/首屏加载时推送；浏览器版无此通道）。 */
function initWinState() {
  if (window.beeWindow && window.beeWindow.onState) {
    window.beeWindow.onState((st) => {
      document.body.classList.toggle('win-max', st === 'maximized');
    });
  }
}

function bumpTabUnread(account) {
  if (!account) return;
  state.tabUnread[account] = (state.tabUnread[account] || 0) + 1;
  renderTabBadges();
}

function setBadge(el, n) {
  if (!el) return;
  if (n > 0) {
    el.hidden = false;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.add('on');
  } else {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('on');
  }
}

function renderTabBadges() {
  // v2.5.1028：Tele 中栏标签与自动翻译已取消，Tele①②③ 改为顶栏账号条（仿 WA①~⑤），
  // 不再有 .mid-tab[data-mt^="tg"] 的红点；这里保留 Signal 启动器角标 + WA①~⑤ 页签角标。
  // Signal S1~S3：后端是单一账号 id=6，三个启动器共用同一计数
  const sigN = state.tabUnread[6] || 0;
  document.querySelectorAll('.launcher[data-id^="s"]').forEach((b) => {
    setBadge(b.querySelector('.sig-badge'), sigN);
  });
}


let ftMode = 'zh2en';
let ftBusy = false;

/** 显示当前「手动自由翻译」用的哪家模型（和翻译浮窗的 provider 徽章一个思路） */
function ftRenderProvider() {
  const el = $('ft-provider');
  if (!el) return;
  api('/api/ai/config').then((snap) => {
    if (!snap || snap.error) return;
    const st = snap.taskState && snap.taskState.freeTranslate;
    const key = (st && st.provider) || 'gpt';
    const prov = (snap.catalog && snap.catalog.providers || []).find((x) => x.key === key);
    const name = (prov && (prov.short || prov.cn)) || key;
    const ready = !!(st && st.ready);
    el.textContent = ready ? `模型：${name}` : `${name} · 未配好`;
    el.classList.toggle('warn', !ready);
    el.title = ready
      ? `按「AI 设置 → 手动自由翻译」显示：${name}`
      : '这把 key 还没填好：点顶栏「⚙ AI 设置」补上接入地址和 key，再点「测试连接」';
  }).catch(() => {});
}

/** 切换「手动自由翻译」模式：同步标签高亮 + 语言选择显隐 */
function setFtMode(mode) {
  ftMode = mode;
  document.querySelectorAll('.ft-mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  const langWrap = $('ft-lang-wrap');
  if (langWrap) langWrap.classList.toggle('hidden', mode !== 'zh2en');
}

/** 输入即识别语种，自动切到对应模式（2026-10-09 用户要求：
 *  含中文 → 中文→外文；纯外文 → 外文→中文，且只给一种译文） */
function autoDetectFtMode() {
  const input = $('ft-input');
  if (!input) return;
  const t = input.value.trim();
  if (!t) return; // 空着不切，避免误触
  const hasCJK = /[一-鿿]/.test(t);
  const want = hasCJK ? 'zh2en' : 'other2zh';
  if (want !== ftMode) setFtMode(want);
}

function initFreeTranslate() {
  const input = $('ft-input');
  // 模式切换：中文→外文（显示语言选择）/ 外文→中文（隐藏语言选择）
  document.querySelectorAll('.ft-mode').forEach((b) => {
    b.onclick = () => setFtMode(b.dataset.mode);
  });
  if (ftMode !== 'zh2en') setFtMode(ftMode);
  ftRenderProvider();
  const go = $('ft-go');
  if (go) go.onclick = doFreeTranslate;
  if (input) {
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doFreeTranslate();
    });
    // 输入时自动识别语种并切模式
    input.addEventListener('input', autoDetectFtMode);
  }
}

async function doFreeTranslate() {
  const input = $('ft-input');
  const out = $('ft-out');
  const go = $('ft-go');
  if (!input || !out || ftBusy) return;
  const text = input.value.trim();
  if (!text) { out.innerHTML = '<div class="hint">先输入要翻译的内容</div>'; return; }
  // 点翻译时按当前文本再识别一次语种，确保界面/请求模式与内容一致：
  // 含中文 → 回切「中文→外文」；纯外文 → 回切「外文→中文」（与输入即识别互补）
  autoDetectFtMode();
  ftBusy = true;
  if (go) go.disabled = true;
  const lang = ftMode === 'zh2en' ? ($('ft-lang') ? $('ft-lang').value : '英语') : null;
  out.innerHTML = `<div class="hint">翻译中…（${ftMode === 'zh2en' ? '翻成 ' + (lang || '英语') + '，给 3 种情绪版本' : '翻成中文'}）</div>`;
  try {
    const data = await api('/api/translate/free', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode: ftMode, targetLang: lang }),
    });
    if (data.error) {
      out.innerHTML = `<div class="warn">${esc(data.error)}</div>`;
      return;
    }
    const versions = data.versions || [];
    if (!versions.length) { out.innerHTML = '<div class="hint">没有翻译结果</div>'; return; }
    if (ftMode === 'other2zh') {
      // 外文→中文：不论模型回了几条，只取第一条（用户要求「只要显示一种」，外文不论什么语言都翻成中文）
      const v = versions[0];
      out.innerHTML =
        `<div class="ft-ver">
           <div class="ft-ver-head">中文译文<button class="x copy" data-t="${esc(v.text)}">复制</button></div>
           <div class="ft-ver-text">${esc(v.text)}</div>
         </div>`
        + `<div class="hint">模型：${esc(data.provider || '')}${data.model ? ' / ' + esc(data.model) : ''}　·　已自动识别为「外文 → 中文」</div>`;
    } else {
      // 中文→外文：给 3 种情绪版本，每个版本英文下方再附「该版本的中文说法」
      // （用户要求：三种口吻翻回中文后短句各不相同，都要显示）；末尾再附「你输入的中文」原句对照。
      out.innerHTML = versions.map((v, i) =>
        `<div class="ft-ver">
           <div class="ft-ver-head">${esc(v.tone || ('版本' + (i + 1)))}<button class="x copy" data-t="${esc(v.text)}">复制</button></div>
           <div class="ft-ver-text">${esc(v.text)}</div>`
        + (v.zh ? `<div class="ft-ver-zh"><span class="ft-zh-tag">中文</span><span class="ft-zh-body">${esc(v.zh)}</span><button class="x copy" data-t="${esc(v.zh)}">复制中文</button></div>` : '')
        + `</div>`).join('')
        + `<div class="ft-zh-foot"><span class="ft-zh-label">你输入的中文</span><span class="ft-zh-text">${esc(text)}</span><button class="x copy" data-t="${esc(text)}">复制中文</button></div>`
        + `<div class="hint">模型：${esc(data.provider || '')}${data.model ? ' / ' + esc(data.model) : ''}　·　Ctrl/⌘+Enter 也能直接翻</div>`;
    }
    for (const b of out.querySelectorAll('.copy')) b.onclick = () => copyText(b.dataset.t, b);
  } catch (e) {
    out.innerHTML = '<div class="warn">翻译接口未连接</div>';
  } finally {
    ftBusy = false;
    if (go) go.disabled = false;
  }
}

async function loadReplies(force) {
  const box = $('reply-lib');
  if (!box) return;
  if (force || !replyScenes.length) box.innerHTML = '<div class="hint">正在加载话术库…</div>';
  try {
    const r = await api('/api/replies');
    replyScenes = r.scenes || [];
    replyCanEdit = r.canEdit !== false;      // 本机优先：改自己的话术不再要求联网
    renderReplies(r.source, r.pending || 0);
    // 读的是本机快照，界面已经出来了；再后台跟云端对一次（把本机改动传上去、把管理员新采纳的拉回来）
    if (r.loggedIn !== false) void syncReplies();
  } catch (e) {
    box.innerHTML = `<div class="warn">读话术库失败：${esc(e.message || '')}</div>`;
  }
}

/** 后台静默同步：有变化才重画（不管失败，本机照用）。 */
async function syncReplies() {
  try {
    const r = await api('/api/replies/sync', { method: 'POST' });
    if (!r || r.ok === false) return;
    if (Array.isArray(r.scenes) && JSON.stringify(r.scenes) !== JSON.stringify(replyScenes)) {
      replyScenes = r.scenes;
      renderReplies(r.source || 'cloud', r.pending || 0);
    }
  } catch (e) { /* 同步失败不打扰用户：本机那份照样能用 */ }
}

/** 「⟳」按钮：手动跟云端对一次（有提示）。 */
async function manualSyncReplies() {
  try {
    const r = await api('/api/replies/sync', { method: 'POST' });
    if (!r || r.ok === false) { showNotice('warn', (r && r.error) || '同步失败'); return; }
    replyScenes = r.scenes || [];
    renderReplies(r.source || 'cloud', r.pending || 0);
    showNotice('ok', r.pending ? `已同步，还有 ${r.pending} 条改动没上传` : '已同步');
  } catch (e) {
    showNotice('error', '同步失败：' + (e.message || '网络不通'));
  }
}

function renderReplies(source, pending) {
  const box = $('reply-lib');
  if (!box) return;
  const srcEl = $('lib-src');
  if (srcEl) {
    srcEl.textContent = (source === 'cloud' || source === 'local') ? ''
      : source === 'local-pending' ? `本机改了 ${pending || 0} 处 · 待上传`
        : source === 'empty' ? '还没同步到内容'
          : '离线快照（只读）';
  }
  const addBtn = $('btn-lib-add');
  if (addBtn) addBtn.style.display = replyCanEdit ? '' : 'none';

  if (!replyScenes.length) {
    box.innerHTML = '<div class="hint">话术库还没有内容。管理员在后台「常用话术」里添加后，这里就有啦。</div>';
    return;
  }

  box.innerHTML = replyScenes.map((s) => {
    const items = (s.texts || []).map((t) => `
      <div class="lib-item" data-tid="${esc(t.id)}">
        <div class="lib-tone">${esc(t.tone || '回复')}</div>
        <div class="lib-en">${esc(t.en || '')}</div>
        <div class="lib-zh">${esc(t.zh || '')}</div>
        <div class="lib-ops">
          <button class="mini" data-act="fill" title="预填进当前客户的对话框（不会自动发送）">填入</button>
          <button class="mini" data-act="copy">复制</button>
          <button class="mini" data-act="edit">改</button>
          <button class="mini danger" data-act="del">删</button>
        </div>
        <div class="lib-edit hidden">
          <input data-k="tone" placeholder="情绪，如 温柔甜" value="${esc(t.tone || '')}">
          <textarea data-k="en" placeholder="英文">${esc(t.en || '')}</textarea>
          <textarea data-k="zh" placeholder="中文">${esc(t.zh || '')}</textarea>
          <div class="lib-ops">
            <button class="mini primary" data-act="save">保存</button>
            <button class="mini" data-act="cancel">取消</button>
          </div>
        </div>
      </div>`).join('') || '<div class="hint">这个场景还没有回复</div>';

    return `
      <div class="lib-scene" data-rid="${esc(s.id)}">
        <div class="lib-scene-h">
          <span class="lib-caret">▸</span>
          <span class="lib-scene-name">${esc(s.name)}</span>
          <span class="lib-scene-n">${(s.texts || []).length}</span>
        </div>
        <div class="lib-scene-b">
          <div class="lib-scene-edit">
            <input class="lib-name" value="${esc(s.name)}" placeholder="场景名">
            <button class="mini" data-act="scene-save">存名</button>
            <button class="mini danger" data-act="scene-del">删场景</button>
          </div>
          ${items}
          <button class="mini" data-act="text-add">＋ 加一条回复</button>
        </div>
      </div>`;
  }).join('');

  // 离线（未登录）：只能看、只能填入/复制，编辑一律收起来
  if (!replyCanEdit) {
    box.querySelectorAll('.lib-scene-edit, .lib-item > .lib-ops').forEach((n) => { n.style.display = 'none'; });
    box.querySelectorAll('[data-act="text-add"]').forEach((n) => { n.style.display = 'none'; });
  }

  box.querySelectorAll('.lib-scene').forEach((el) => {
    const rid = el.dataset.rid;
    const head = el.querySelector('.lib-scene-h');
    if (head) head.onclick = () => toggleReplyScene(el);
    const act = (sel, fn) => { const b = el.querySelector(`[data-act="${sel}"]`); if (b) b.onclick = fn; };

    act('scene-save', async () => {
      const name = (el.querySelector('.lib-name').value || '').trim();
      if (!name) { showNotice('warn', '场景名不能空着'); return; }
      await replyWrite('/api/replies/scene/' + encodeURIComponent(rid), 'PUT', { name }, '已保存');
    });
    act('scene-del', async () => {
      if (!confirm('删掉「' + (el.querySelector('.lib-scene-name').textContent || '') + '」这个场景和它下面的回复？')) return;
      await replyWrite('/api/replies/scene/' + encodeURIComponent(rid), 'DELETE', undefined, '已删除');
    });
    act('text-add', async () => {
      await replyWrite('/api/replies/scene/' + encodeURIComponent(rid) + '/text', 'POST', { tone: '', en: '', zh: '' }, '已添加');
    });

    el.querySelectorAll('.lib-item').forEach((row) => {
      const tid = row.dataset.tid;
      const en = row.querySelector('.lib-en').textContent || '';
      const zh = row.querySelector('.lib-zh').textContent || '';
      const edit = row.querySelector('.lib-edit');
      const setEdit = (on) => {
        if (edit) edit.classList.toggle('hidden', !on);
        row.querySelectorAll('.lib-ops')[0].classList.toggle('hidden', on);
        const t = row.querySelector('.lib-tone');
        if (t) t.classList.toggle('hidden', on);
      };
      row.querySelector('[data-act="fill"]').onclick = () => fillReply((zh || en).trim());
      row.querySelector('[data-act="copy"]').onclick = async () => {
        await copyText(en);
        showNotice(en ? 'ok' : 'warn', en ? '已复制英文' : '这条没有英文内容');
      };
      row.querySelector('[data-act="edit"]').onclick = () => setEdit(true);
      row.querySelector('[data-act="cancel"]').onclick = () => setEdit(false);
      row.querySelector('[data-act="save"]').onclick = async () => {
        const body = {
          tone: row.querySelector('[data-k=tone]').value,
          en: row.querySelector('[data-k=en]').value,
          zh: row.querySelector('[data-k=zh]').value,
        };
        await replyWrite('/api/replies/text/' + encodeURIComponent(tid), 'PUT', body, '已保存');
      };
      row.querySelector('[data-act="del"]').onclick = async () => {
        if (!confirm('删掉这一条回复？')) return;
        await replyWrite('/api/replies/text/' + encodeURIComponent(tid) + '?rid=' + encodeURIComponent(rid),
          'DELETE', undefined, '已删除');
      };
    });
  });

  // 手风琴复位：始终最多只有一个是展开的
  //   · 还没定（undefined）→ 展开第一个，免得看起来是空的
  //   · 用户明确全收起（''）→ 一个都不展开
  //   · 记住的那个 id 还在 → 展开它（改完话术重画后停回原处）
  const list = Array.prototype.slice.call(box.querySelectorAll('.lib-scene'));
  if (replyOpenRid === undefined) {
    if (list[0]) { list[0].classList.add('open'); replyOpenRid = list[0].dataset.rid; }
  } else if (replyOpenRid) {
    const keep = list.filter((n) => n.dataset.rid === replyOpenRid)[0];
    if (keep) keep.classList.add('open');
  }
}

/** 场景展开/收起（2026-10-03 老板要求）：要么全部收缩，要么只展开一个。
 *  点当前展开的那个 → 收起（等于全收）；点另一个 → 收起其它、只展开它。 */
function toggleReplyScene(el) {
  const box = $('reply-lib');
  const willOpen = !el.classList.contains('open');
  if (box) {
    Array.prototype.slice.call(box.querySelectorAll('.lib-scene.open'))
      .forEach((n) => n.classList.remove('open'));
  }
  if (willOpen) {
    el.classList.add('open');
    replyOpenRid = el.dataset.rid;
  } else {
    replyOpenRid = '';
  }
}

/** 话术库写操作统一入口：成功就重画（后台每次都回全量场景列表）。 */
async function replyWrite(url, method, body, okMsg) {
  try {
    const r = await api(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r || r.ok === false) { showNotice('warn', (r && r.error) || '操作失败'); return; }
    replyScenes = r.scenes || [];
    renderReplies(r.source || 'local', r.pending || 0);
    // 改动先落本机。上传不动（没登录 / 断网）要如实说，别让用户以为已经传到后台了。
    showNotice('ok', r.pending ? `${okMsg || '已完成'}（已存本机，登录后自动上传）` : (okMsg || '已完成'));
  } catch (e) {
    showNotice('error', '操作失败：' + (e.message || '网络不通'));
  }
}

/**
 * 新建场景：Electron 渲染进程里 window.prompt 根本不存在，
 * 一调用就抛「prompt() is and will not be supported」——所以这里不用 prompt，
 * 改成标题栏下方滑出一条输入框（回车保存 / Esc 取消）。
 */
function addReplyScene() {
  const bar = $('lib-new');
  const inp = $('lib-new-name');
  if (!bar || !inp) return;
  bar.classList.remove('hidden');
  inp.value = '';
  inp.focus();
}

function cancelReplyScene() {
  const bar = $('lib-new');
  if (bar) bar.classList.add('hidden');
}

async function submitReplyScene() {
  const inp = $('lib-new-name');
  const name = (inp && inp.value || '').trim();
  if (!name) {
    showNotice('warn', '先写个场景名字');
    if (inp) inp.focus();
    return;
  }
  cancelReplyScene();
  await replyWrite('/api/replies/scene', 'POST', { name }, '已添加');
}

/** 把一条话术预填进「当前选中客户」的对话框（绝不自动发送）。 */
async function fillReply(text) {
  if (!text) { showNotice('warn', '这条话术是空的'); return; }
  if (!state.activeCode) { showNotice('warn', '先选一个客户，再点「填入」'); return; }
  try {
    const r = await api('/api/prefill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: state.activeCode, text }),
    });
    if (r && r.ok) { showNotice('ok', '已预填到对话框（不会自动发送）'); return; }
    await copyText(text);
    showNotice('warn', (r && r.reason === 'no-prefill') ? '没找到 WhatsApp 窗口，已复制到剪贴板' : '预填失败，已复制到剪贴板');
  } catch (e) {
    await copyText(text);
    showNotice('warn', '预填失败，已复制到剪贴板');
  }
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(String(t || '')); return true; } catch (e) { return false; }
}

refreshState();
refreshCustomers();
refreshStats();
refreshToday();
TG_PANES.forEach((mp) => refreshTgStatus(mp));
setInterval(() => { TG_PANES.forEach((mp) => refreshTgStatus(mp)); }, 5000);
/* WA①（内置浏览器）采集状态：启动拉一次 + 每 5 秒兜底（实时靠 whatsapp_status 事件）。
   🔴 跟 Telegram 那条分开跑，互不影响。v2.6.1134：五个内置浏览器页签各拉各的。 */
WA_PANES.forEach((p) => refreshWaStatus(p.cfg.accId));
setInterval(() => { WA_PANES.forEach((p) => refreshWaStatus(p.cfg.accId)); }, 5000);
connectSSE();
loadBuild();
renderSocialLogos(); // 顶栏第一行靠左那排社交平台图标（静态，画一次）
// 刚打开还没选客户：底部「生成建议 / 标记已回复 / 跳过消息」都该灰着（点了也是没对象可操作）
renderChatFoot();
initBootLogin();   // 启动登录浮层：盖住主窗，登录并同步数据后才露出主窗口
initPanelTabs();   // 右栏两个页签（话术库 / AI 建议）
initMidTabs();     // 中栏两个页签（通用 / Tele① 内置浏览器，2026-10-11 恢复）
// 🔴 v2.6.1143 修「WA 左栏不提醒」根因之二：启动后立刻把 5 个 WA 内置浏览器网页
// 全部加载（eager-load），不依赖老板手点页签。webview 常驻 → 采集链随时找得到页
// → 后台持续收消息、左栏出 Ⓦ 客户 + 未读角标。只动 WA，不碰 Signal / Telegram。
WA_PANES.forEach((p) => p.ensureLoaded());
initWinState();    // 主窗口最大化状态 → 右栏宽度 450/500px 切换（2026-10-09）
loadReplies();     // 话术库：登录云端读云端，没登录读本地快照

// 「今日消息」每分钟对一次（跨零点时上面那行日期和数据会自己归零）
setInterval(refreshToday, 60000);

/* 启动器单独轮询（v1.5.1017）
 * 🔴 为什么要单独一轮，而不是只跟着业务动作走：
 *    refreshState 只在业务动作后被调（打开客户、标记已回复…），
 *    老板「手动去打开 Signal / 启动 Telegram」这个动作**不会触发任何界面事件**——
 *    灯就一直是红的，得手动去点一下。
 *
 * 🔴 v2.5.1034 卡顿治理：后端改成「后台每 10 秒自动刷新 + 接口只读缓存」之后，
 *    前端轮询拿到的永远是热数据，且单次请求恒定毫秒级。所以这里从 10 秒放宽到 15 秒，
 *    照样跟手（最坏也就晚 10 秒看到灯变色），请求量还少三分之一。
 *    首轮可能还是黄灯「状态检测中…」，属正常（后台异步刷新约 1~2 秒后变真色）。 */
setInterval(refreshState, 15000);

/* 🔴 v2.6.1127 关闭同步浮层（共享翻译记忆）：主进程在 before-quit 跑同步，
   通过 IPC 通知渲染进程显示「数据保存中」浮层并刷新进度。 */
(function initTmSyncOverlay() {
  const overlay = document.getElementById('tm-sync-overlay');
  const fill = document.getElementById('tm-sync-fill');
  const pct = document.getElementById('tm-sync-pct');
  const status = document.getElementById('tm-sync-status');
  if (!overlay || !fill || !pct) return;
  const show = () => overlay.classList.add('show');
  const hide = () => overlay.classList.remove('show');
  const setProgress = (p) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(p) || 0)));
    fill.style.width = v + '%';
    pct.textContent = v + '%';
  };
  const setStatus = (s) => { if (status) status.textContent = s; };

  const api = window.beeTmSync;
  if (!api) return;

  api.onStart(() => { setProgress(0); setStatus('正在生成客户档案…'); show(); });
  api.onProgress((info) => {
    if (!info) return;
    switch (info.phase) {
      case 'docx':   setStatus(info.status || ('正在生成客户档案（' + (info.current || 0) + ' / ' + (info.total || 0) + '）')); setProgress(info.pct != null ? info.pct : 0); break;
      case 'skip':   setStatus(info.status || '未登录云端，跳过同步'); setProgress(100); break;
      case 'sync':   setStatus('正在同步翻译记忆到后台数据库…'); setProgress(35); break;
      case 'retry':  setStatus('网络错误，正在重试（第 ' + (info.attempt || 1) + ' 次）' + (info.error ? '：' + info.error : '') + '…'); setProgress(60); break;
      case 'done':   setStatus(info.status || '同步完成'); setProgress(100); break;
      case 'gaveUp': setStatus(info.status || '网络不可用，已跳过同步'); setProgress(100); break;
      default: break;
    }
  });
  // 关闭时让最终结论多停留一会儿（配合主进程延迟退出），让用户看清成功/失败再关
  api.onEnd(() => { setTimeout(() => { hide(); }, 1600); });
})();

/* 🔴 v2.6.1133 关闭确认浮层：点 X → 主进程让渲染进程弹这个确认框，
   点「确定关闭」才进入「备份 + 进度条 → 退出」流程；点「取消」留在软件。 */
(function initCloseConfirmOverlay() {
  const overlay = document.getElementById('close-confirm-overlay');
  const btnCancel = document.getElementById('close-cancel');
  const btnOk = document.getElementById('close-ok');
  if (!overlay || !btnCancel || !btnOk) return;
  const show = () => overlay.classList.add('show');
  const hide = () => overlay.classList.remove('show');
  const api = window.beeCloseConfirm;
  if (!api) return;
  api.onShow(() => show());
  btnCancel.addEventListener('click', () => { hide(); if (api.cancel) api.cancel(); });
  btnOk.addEventListener('click', () => { hide(); if (api.confirm) api.confirm(); });
})();
