/**
 * 「全局设置」独立窗口的界面逻辑（2026-09-30）
 *
 * 用户要求：顶栏只留一个「⚙ 设置」按钮，点开一扇独立窗口（标题「全局设置」），
 * 把原来挤在顶栏的三样东西整块搬进来，**功能一模一样**：
 *   ① AI 设置      —— 7 个 AI 分别用哪家、填接入地址 / API Key / 模型、测试连接
 *   ② AI 提示词    —— 每个 AI 实际发出去的那份提示词 + 版本信息
 *   ③ 模拟新消息   —— 造一条假消息喂给真正的处理链路，试软件用
 *
 * 这扇窗和「每日话术编排台」一样是真正的系统窗口，可以移到主窗口外面、两个并排看。
 * 数据全部走本地 127.0.0.1 的接口，不依赖主窗口；主窗口收到后端广播（data_changed）
 * 会自己刷新，所以两个窗口各干各的、互不干扰。
 *
 * ⚠️ 这份代码原来长在 public/app.js 里（是三个弹窗），是**整体搬过来**的：
 *    搬完就把主窗口那份删了 —— 同一件事只留一份代码，别两边都改。
 *    主窗口那份现在只剩一句说明（见 app.js 里 "已搬到「全局设置」" 那段注释）。
 */

const $ = (id) => document.getElementById(id);

/* ---------------- 这个窗口自己的全局提示条 ----------------
   主界面的提示条挂在顶栏第二行，这扇窗没有那条，所以自己弹一个小条（和编排台一个做法）。 */
let setToastTimer = null;
function showNotice(level, text, ms = 6000) {
  // 老板 2026-10-18：在「AI 设置」页时，提示条贴在底部「保存」那一行最右侧（提示句右边）；
  // 切到其他页签时仍用页签条下方那条全局提示，互不影响。
  const aiSec = $('sec-ai');
  const aiToast = $('ai-toast');
  const useAi = !!(aiSec && !aiSec.classList.contains('hidden') && aiToast);
  const box = useAi ? aiToast : $('set-toast');
  if (!box) return;
  const base = useAi ? 'set-toast inline' : 'set-toast';
  box.textContent = String(text ?? '');
  box.title = String(text ?? '');
  box.className = `${base} show n-${level}`;
  clearTimeout(setToastTimer);
  setToastTimer = setTimeout(() => { box.className = base; box.textContent = ''; }, ms);
}
window.addEventListener('error', (e) => showNotice('error', '界面出错：' + (e.message || '未知')));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  showNotice('error', '操作失败：' + ((r && r.message) || r || '未知'));
});


/* ---------------- 通用小工具（和主窗口各一份，改动互不影响） ---------------- */

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

/* ---------------- AI 设置（原主窗口弹窗，整块搬来） ---------------- */

let aiSnap = null;   // 打开弹窗时读到的配置快照（用来判断哪些字段被改过）
let aiCat = null;    // 后端给的目录：7 个 AI + 6 个服务商 + 说明
let aiAdminShown = null;  // 上一次渲染「服务商填地址和 key」区块时是否为管理员（权限翻转才重渲染该区块）

const aiVal = (id) => ($(id)?.value || '').trim();
const pv = (name, field) => $(`ai-p-${name}-${field}`);
const pvVal = (name, field) => ($(`ai-p-${name}-${field}`)?.value || '').trim();

/* ============================================================
   「AI 提示词」页签（在「全局设置」窗口里，原来挂在顶栏）
   看每个 AI 任务是拿什么话去干这件事的：提消息、翻消息、出建议、
   翻英文、看图、听语音。
   提示词由后端现取（和真跑用的是同一份 prompt* 函数），所以看到的就是真的。
   ============================================================ */
let prCat = null;       // 后端给的提示词目录
let prCur = null;       // 当前选中的任务 key


/**
 * 把版本号 + 更新日志填进指定容器（默认右侧内容区）。
 * 用户 2026-09-29 指定：所有版本信息统一放「AI 提示词」弹窗**左栏最下面的「版本信息」**里，
 * 点它右侧就看更新内容（见项目根 CHANGELOG.md）。
 */
async function loadVersionPanel(targetId) {
  const box = $(targetId || 'pr-main');
  if (!box) return;
  box.innerHTML = '<div class="hint">正在读取版本信息…</div>';
  try {
    const v = await api('/api/version');
    const stamp = String(v.build || '').replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5');
    const md = String(v.changelog || '').trim();
    box.innerHTML = `
      <div class="pv-head">蜜蜂信息采集 · 版本 <b>${esc(stamp || v.build || '—')}</b>
        <span class="pv-node">${esc(v.node || '')}</span></div>
      <div class="pv-log">${md ? renderChangelog(md) : '<div class="hint">暂无更新记录</div>'}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="hint">读不到版本信息：${esc((e && e.message) || e)}</div>`;
  }
}

/**
 * 把 CHANGELOG.md 的「## 版本标题」转成一条条版本卡片。
 * 每个标题下面的 `- xxx` 保留成列表项（版本号 / 优化了什么 / 处理了什么问题），
 * 子项（缩进的 `-`）合成一句跟在主项后面，保持紧凑又能看清细节。
 */
function renderChangelog(md) {
  const blocks = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const ln = raw.replace(/\s+$/, '');
    if (/^##\s+/.test(ln)) { cur = { title: ln.replace(/^##\s+/, ''), items: [] }; blocks.push(cur); continue; }
    if (!cur) continue;
    if (/^\s{2,}[-*]\s+/.test(ln)) {                       // 子项 → 接到上一条后面
      const t = ln.replace(/^\s+[-*]\s+/, '').trim();
      if (cur.items.length) cur.items[cur.items.length - 1] += '；' + t;
      else cur.items.push(t);
    } else if (/^[-*]\s+/.test(ln)) {                       // 主项
      cur.items.push(ln.replace(/^[-*]\s+/, '').trim());
    }
  }
  return blocks.map((b) => {
    // 每个版本最多列 12 条：用户要求"每个版本的优化和修复都要看得见"，
    // 所以别切太狠（原来是 8，够不到后来补全的条目）。
    const items = b.items.filter((x) => x && !/^#/.test(x)).slice(0, 12);
    return `<div class="pv-item"><b>${esc(b.title)}</b>
      ${items.length ? '<ul class="pv-ul">' + items.map((t) => `<li>${esc(t)}</li>`).join('') + '</ul>' : ''}
    </div>`;
  }).join('');
}

async function loadPrompts() {
  const side = $('pr-side');
  const main = $('pr-main');
  if (prCat) { renderPrSide(); renderPrMain(prCur || prCat.tasks[0].key); return; }
  if (main) main.innerHTML = '<div class="hint">正在读取提示词…</div>';
  try {
    const r = await fetch('/api/ai/prompts').then((x) => x.json());
    if (r && Array.isArray(r.tasks) && r.tasks.length) {
      prCat = r;
      renderPrSide();
      renderPrMain(prCur || r.tasks[0].key);
    } else if (main) {
      main.innerHTML = `<div class="hint">读不到提示词：${esc((r && r.error) || '未知错误')}</div>`;
    }
  } catch (e) {
    if (main) main.innerHTML = `<div class="hint">连不上本地服务：${esc((e && e.message) || e)}</div>`;
  }
}

/** 左边一列：7 个 AI（＋内部任务 extract），点一下右边换内容 */
function renderPrSide() {
  const side = $('pr-side');
  if (!side || !prCat) return;
  const main7 = prCat.tasks.filter((t) => t.key !== 'extract');
  const inner = prCat.tasks.filter((t) => t.key === 'extract');
  const tabHtml = (t) => `
    <button class="pr-tab${t.key === prCur ? ' on' : ''}" data-pr="${esc(t.key)}">
      <span class="pr-tab-cn">${esc(t.cn)}</span>
      <span class="pr-tab-sub">${esc(t.model || '')}${t.wired === false ? ' · 未接' : ''}</span>
    </button>`;
  // 「版本信息」也是一项，放在最下面（用户 2026-09-29 指定位置：左栏最底那个红框）
  const verTab = `<div class="pr-tab-cap">软件自己</div>
    <button class="pr-tab${prCur === '__version__' ? ' on' : ''}" data-pr="__version__">
      <span class="pr-tab-cn">版本信息</span>
      <span class="pr-tab-sub">版本号 · 更新了什么</span>
    </button>`;
  side.innerHTML = `
    <div class="pr-tab-cap">${main7.length} 个 AI（点一个看它的提示词）</div>
    ${main7.map(tabHtml).join('')}
    ${inner.length ? '<div class="pr-tab-cap">软件内部自己用的</div>' + inner.map(tabHtml).join('') : ''}
    ${verTab}`;
}

/** 右边：这个任务干什么 / 什么时候跑 / 系统提示词 / 发给它的内容 / 返回什么 / 注意点 */
function renderPrMain(key) {
  const main = $('pr-main');
  if (!main || !prCat) return;
  // 左边选了「版本信息」→ 右侧整块换成更新日志（用户 2026-09-29 指定）
  if (key === '__version__') {
    prCur = '__version__';
    renderPrSide();
    main.innerHTML = '<div class="hint">正在读取版本信息…</div>';
    loadVersionPanel('pr-main');
    return;
  }
  const t = prCat.tasks.find((x) => x.key === key) || prCat.tasks[0];
  prCur = t.key;

  const badges = [];
  if (t.noAi) {
    // ① 接收信息：采集环节，没有提示词、不用配 key
    badges.push('<span class="ai-badge on">✋ 采集环节 · 不调用 AI</span>');
    badges.push('<span class="ai-badge">用：不需要 —— 程序自己把消息抓下来入库</span>');
  } else {
    badges.push(`<span class="ai-badge ${t.ready ? 'on' : ''}">${t.ready ? '✓ 已配好' : '⚠ 还没配 key'}</span>`);
    badges.push(`<span class="ai-badge">用：${esc(t.providerCn)}${t.model ? ' · ' + esc(t.model) : ''}</span>`);
  }
  if (t.wired === false) badges.push('<span class="ai-badge">接口已留 · 暂未接</span>');

  const pre = (cls, text) => `<pre class="pr-pre ${cls}">${esc(text || '')}</pre>`;

  const partsHtml = Array.isArray(t.parts) && t.parts.length
    ? `<details class="pr-parts">
         <summary>${esc(t.partsTitle || '提示词里还会拼进去的部分（点开看全文）')}</summary>
         ${t.parts.map((p) => `<div class="pr-part-label">${esc(p.label)}</div>${pre('', p.text)}`).join('')}
       </details>`
    : '';

  const notes = Array.isArray(t.notes) && t.notes.length
    ? `<div class="pr-block">
         <div class="pr-block-head">注意点</div>
         <ul class="pr-notes">${t.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
       </div>`
    : '';

  main.innerHTML = `
    <div class="pr-title">${esc(t.cn)}</div>
    <div class="pr-badges">${badges.join('')}</div>
    <div class="pr-when">${esc(t.when || '')}</div>
    <div class="pr-where">代码位置：<code>${esc(t.where || '')}</code></div>

    <div class="pr-block">
      <div class="pr-block-head">系统提示词（固定的规矩，每次都发）
        <button class="mini copy pr-copy" data-pr-copy="system">复制</button>
      </div>
      ${pre('pr-sys', t.system)}
    </div>

    <div class="pr-block">
      <div class="pr-block-head">发给它的内容（${esc(t.userLabel || '')}）
        <button class="mini copy pr-copy" data-pr-copy="user">复制</button>
      </div>
      ${pre('pr-user', t.user)}
    </div>

    ${partsHtml}

    <div class="pr-block">
      <div class="pr-block-head">它会返回什么</div>
      <div class="pr-out">${esc(t.output || '—')}</div>
    </div>

    ${notes}

    <div class="pr-where" style="margin-top:10px">
      想让建议更贴你，改的不是这段提示词，而是
      <code>knowledge/persona.md</code>、<code>redlines.md</code>、<code>templates.md</code>、<code>playbook7d.md</code> ——
      它们会被整段拼进「③ 回复建议」的系统提示词里。
    </div>`;
}

function copyPrField(which, btn) {
  const t = prCat && prCat.tasks.find((x) => x.key === prCur);
  if (!t) return;
  copyText(String(t[which] || ''), btn);
}

/** 服务商中文名（界面上到处要用：「DeepSeek」而不是「deepseek」） */
function pvCn(name) {
  const p = (aiCat?.providers || []).find((x) => x.key === name);
  return p ? p.cn : name;
}
function taskCn(key) {
  const t = (aiCat?.tasks || []).find((x) => x.key === key);
  return t ? t.cn : key;
}

/** 把「7 个 AI」渲染成一张表：编号 + 干什么 + 用哪家 + 状态 */
function renderAiTasks() {
  const tasks = aiCat?.tasks || [];
  const state0 = aiSnap?.taskState || {};
  const rows = tasks.map((t) => {
    const st = state0[t.key] || {};
    const ready = !!st.ready;
    const noAi = !!(t.noAi || st.noAi);
    const badge = noAi
      ? '<span class="ai-badge on" title="采集环节：程序自己抓消息入库，不调用 AI">不需要 AI</span>'
      : `<span class="ai-badge ${ready ? 'on' : ''}" title="${esc(st.reason || (ready ? '已配好' : '还没配好'))}">${ready ? '已就绪' : '未配置'}</span>`;

    let pick;
    if (noAi) {
      // ① 接收信息：抓消息这一步不调 AI，不给它下拉，免得以为要配 key
      pick = '<span class="fixed-model">程序自己做 · 不用配</span>';
    } else {
      const cur = st.provider || '';
      // ④ 采纳后翻英文也是这里选（只列 DeepSeek / GPT / Agnes），不再是"固定 GPT"
      const choices = t.providerChoices || aiCat?.taskProviderChoices
        || ['deepseek', 'agnes', 'siliconflow', 'openrouter', 'tikhub', 'bailian', 'astrbot'];
      const opts = choices
        .map((k) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(pvCn(k))}</option>`)
        .join('');
      pick = `<select class="ai-task-pick" data-task="${esc(t.key)}">${opts}</select>`;
    }
    const model = st.model ? `<span class="ai-cur-model">${esc(st.model)}</span>` : '';
    const unwired = t.wired === false ? '<span class="ai-badge warn">接口已留 · 暂未接</span>' : '';

    return `<div class="ai-task">
      <div class="ai-task-top">
        <span class="ai-task-cn">${esc(t.cn)}</span>
        <span class="ai-task-right">${pick}${model}${badge}${unwired}</span>
      </div>
      <div class="ai-task-use">${esc(t.use)}</div>
    </div>`;
  }).join('');

  return `
    <div class="ai-lead">
      <b>${tasks.length} 个 AI，各管一件事。</b>① 接收信息是<b>采集环节</b>（抓 WhatsApp 新消息入库），
      不调用 AI、也不用判断语种 —— 中文消息不会被翻译，所以它不用配 key。
      文字生成（翻译 / 回复建议 / 抽客户档案 / 自由翻译）走 <b>DeepSeek</b> / <b>Agnes</b> / <b>TikHub</b> / <b>阿里百炼</b> 等；回复建议默认走 <b>AstrBot</b>（按客户编号分上下文）。
      点「从对话里提取档案」用哪家 AI，在弹窗最上面的「抽客户档案用哪个 AI」里单独选（DeepSeek / Agnes / TikHub）。
      ④（挑好建议后翻英文）可在 <b>DeepSeek / Agnes / TikHub</b> 里单独选一家。
      下面每个服务商填完点「测试连接」，绿灯了再点「保存」。
    </div>
    <div class="ai-tasks">
      <div class="ai-tasks-head">一、${tasks.length} 个 AI 分别干什么 · 现在用哪家</div>
      ${rows}
    </div>`;
}

/** 把「6 个服务商」渲染成可填的表单 */
function renderAiProviders() {
  const list = aiCat?.providers || [];
  const prov = aiSnap?.providers || {};
  return list.map((meta) => {
    const p = prov[meta.key] || {};
    const ok = !!(p.hasKey && p.baseUrl);
    return `<div class="ai-sec">
      <div class="ai-sec-head">${esc(meta.cn)}
        ${meta.badge ? `<span class="ai-badge">${esc(meta.badge)}</span>` : ''}
        <span class="ai-badge ${ok ? 'on' : ''}" id="ai-badge-${esc(meta.key)}">${ok ? '已填' : '未填'}</span>
      </div>
      <!-- v2.6.1098 排版（老板看图 QQ20261012-214150-副本.png）：
           接入地址 / API Key / 模型名 排成一行；「测试连接」并入「去哪申请」那行末尾。
           （原「用来干：…」一行按目标图撤掉；10 个服务商卡片统一此样式） -->
      <div class="ai-fields">
        <label>接入地址 baseUrl
          <input id="ai-p-${esc(meta.key)}-baseUrl" placeholder="${esc(meta.sample)}">
        </label>
        <label>API Key
          <input id="ai-p-${esc(meta.key)}-apiKey" type="password" autocomplete="off" placeholder="sk-...">
        </label>
        <label>模型名
          <input id="ai-p-${esc(meta.key)}-model" placeholder="${esc(meta.modelSample)}">
        </label>
      </div>
      <div class="ai-apply">去哪申请：
        <a href="${esc(meta.applyUrl)}" target="_blank" rel="noreferrer">${esc(meta.applyName)}</a>
        <button class="mini copy" data-copy="${esc(meta.applyUrl)}">复制地址</button>
        <button class="mini" data-test="${esc(meta.key)}">测试连接</button>
        <span class="ai-test" id="ai-test-${esc(meta.key)}"></span>
      </div>
      ${meta.note ? `<div class="ai-note">${esc(meta.note)}</div>` : ''}
    </div>`;
  }).join('');
}

/** 「通用设置」里的一项：译文气泡用哪家 AI 翻。
 *  2026-10-15 v2.6.1121 从「Telegram」页签挪过来（原来存了没人读，选了不生效）；
 *  现在管全部渠道。存的是**服务商 key**，空串 = 跟随 tasks.translate（上面「② 翻译」那家）。 */
function renderBubbleModelPicker() {
  const cur = String(aiSnap?.bubbleTranslateModel || '');
  // 老板 2026-10-18 二次精简：删除「跟随全局翻译 / Agnes / AstrBot」，只留这 5 家
  // （DeepSeek / 硅基流动 / OpenRouter / TikHub / 阿里百炼）。以后新增服务商（如「硅基流动 OCR」）
  // 不会自动跑进来，要加必须同时写进 BUBBLE_ALLOW。
  // 2026 新增 5 家 OpenAI 兼容网关也加入气泡翻译模型下拉
  const BUBBLE_ALLOW = ['deepseek', 'siliconflow', 'openrouter', 'tikhub', 'bailian',
    'chatanywhere', 'api2gpt', 'qianduoduo', 'no1apipro', 'zhichuang'];
  const list = (aiCat?.providers || [])
    .filter((p) => !p.hidden && !p.noPick && BUBBLE_ALLOW.includes(p.key));
  const has = list.some((p) => p.key === cur);
  const opts = list
    .map((p, i) => `<option value="${esc(p.key)}"${(has ? p.key === cur : i === 0) ? ' selected' : ''}>${esc(p.cn || p.key)}</option>`)
    .join('');
  return `<div class="ai-sec ai-bubble-model">
      <div class="ai-sec-head">气泡翻译模型</div>
      <div class="ai-use">对话消息<b>下方的中文译文气泡</b>用哪家 AI 来翻，<b>全部渠道通用</b>
        （Telegram / WA① 内置浏览器 / WA 一号~五号都走它）。
        <b>选中的那家没填 key 时会安静回退到「② 翻译」那家</b>，不会让译文整段失效。</div>
      <label>翻译用 AI
        <select id="ai-bubble-model">${opts}</select>
      </label>
    </div>`;
}

/** 「翻译词典用哪个 AI」：决定词典准入筛查用哪家 AI（默认 DeepSeek）。
 *  对应 config 的 translation.memoryModel。 */
function renderMemoryModelPicker() {
  const cur = String(aiSnap?.translationMemoryModel || 'deepseek');
  // 2026 新增 5 家 OpenAI 兼容网关也加入「翻译词典用哪个 AI」下拉
  const choices = [
    { v: 'deepseek', t: 'DeepSeek（deepseek-v4-flash）' },
    { v: 'siliconflow', t: '硅基流动 SiliconFlow' },
    { v: 'tikhub', t: 'TikHub（gpt-4o-mini）' },
    { v: 'bailian', t: '阿里百炼 Bailian（qwen-plus）' },
    { v: 'chatanywhere', t: 'ChatAnyWhere（OpenAI 兼容）' },
    { v: 'api2gpt', t: 'API2GPT（OpenAI 兼容）' },
    { v: 'qianduoduo', t: '钱多多（OpenAI 兼容）' },
    { v: 'no1apipro', t: 'No.1 API-Pro（OpenAI 兼容）' },
    { v: 'zhichuang', t: '智创聚合（OpenAI 兼容）' },
  ];
  const opts = choices
    .map((o) => `<option value="${o.v}" ${o.v === cur ? 'selected' : ''}>${esc(o.t)}</option>`)
    .join('');
  return `<div class="ai-sec ai-mem-model">
      <div class="ai-sec-head">翻译词典用哪个 AI</div>
      <div class="ai-use">客户发的英文要进<b>翻译词典</b>（以后同一句直接复用、不再烧 AI）之前，
        先过两道关：规则过滤（长串/乱码/中文/拼音/时间戳/IP 先挡掉）+ 这一家 AI 的复核
        （判断是不是真人会发的正常英文）。默认 DeepSeek，可换成硅基流动 / TikHub / 阿里百炼，
        或新增的 ChatAnyWhere / API2GPT / 钱多多 / No.1 API-Pro / 智创聚合（均 OpenAI 兼容）。
        这家没填 key 时自动放行（规则已挡掉大部分脏数据）。</div>
      <label>词典 AI
        <select id="ai-mem-model">${opts}</select>
      </label>
    </div>`;
}

/** 「专项 AI」里的「扫描图片用哪个模型」：决定客户发来的图片/截图用哪家视觉模型扫成文字。
 *  对应 config 的 scan.imageModel（服务商 key，'' = 跟随视觉任务默认 vision）。
 *  选项 = 硅基流动OCR（后期 OCR 专用那一栏，这里放开进下拉）+ 2026 新增 5 家 OpenAI 兼容网关；
 *  「其他（后面添加的新模型）」= 占位（选它 = 跟随视觉任务默认）。 */
function renderScanImagePicker() {
  const cur = String(aiSnap?.scanImageModel || 'siliconflow_ocr');
  // 这 6 家是扫描图片可选的服务商（siliconflow_ocr 虽标 hidden/noPick，但扫描图片这一处要放开）
  const SCAN_ALLOW = ['siliconflow_ocr', 'agnes', 'chatanywhere', 'api2gpt', 'qianduoduo', 'no1apipro', 'zhichuang'];
  const list = (aiCat?.providers || [])
    .filter((p) => SCAN_ALLOW.includes(p.key));
  const has = list.some((p) => p.key === cur);
  const realOpts = list
    .map((p, i) => `<option value="${esc(p.key)}"${(has ? p.key === cur : i === 0) ? ' selected' : ''}>${esc(p.cn || p.key)}</option>`)
    .join('');
  // 「其他（后面添加的新模型）」占位：value 空 = 跟随视觉任务默认
  const placeholderSel = !has ? ' selected' : '';
  const opts = realOpts + `<option value=""${placeholderSel}>其他（后面添加的新模型）</option>`;
  return `<div class="ai-sec ai-scan-image">
      <div class="ai-sec-head">扫描图片 <span class="ai-badge on">看客户发来的图，扫成文字交给 AI</span></div>
      <div class="ai-use">客户发来的图片 / 截图，软件先用<b>视觉模型</b>把图里的内容扫描成文字
        （例如画里的宠物品种、尺寸要求、参考图说明），再交给 AI 写中文说明、进档案。
        这里单独选「扫描图片」用哪家视觉模型，不影响上面那几家文字 AI；
        选「其他（后面添加的新模型）」= 跟随「视觉任务默认」那家。选中的那家没填 key 时会安静回退到视觉任务默认，不会让看图失效。</div>
      <label>扫描图片用哪个模型
        <select id="ai-scan-image-model">${opts}</select>
      </label>
    </div>`;
}

/** 「专项 AI」里的「语音识别用哪个模型」：决定客户发来的语音/语音消息用哪家模型转成文字。
 *  对应 config 的 scan.voiceModel（服务商 key，'' = 跟随语音任务默认 asr）。
 *  选项 = 5 家 OpenAI 兼容网关 + ARS千问（阿里语音专用，专用接口暂未接，先放菜单）。
 *  「其他（跟随语音任务默认）」= 占位（选它 = 跟随 tasks.asr 默认那家）。 */
function renderVoicePicker() {
  const cur = String(aiSnap?.voiceModel || '');
  const VOICE_ALLOW = ['chatanywhere', 'api2gpt', 'qianduoduo', 'no1apipro', 'zhichuang', 'ars_qianwen'];
  const list = (aiCat?.providers || [])
    .filter((p) => VOICE_ALLOW.includes(p.key));
  const has = list.some((p) => p.key === cur);
  const realOpts = list
    .map((p, i) => `<option value="${esc(p.key)}"${(has ? p.key === cur : i === 0) ? ' selected' : ''}>${esc(p.cn || p.key)}</option>`)
    .join('');
  const placeholderSel = !has ? ' selected' : '';
  const opts = realOpts + `<option value=""${placeholderSel}>其他（跟随语音任务默认）</option>`;
  return `<div class="ai-sec ai-voice">
      <div class="ai-sec-head">语音识别 <span class="ai-badge on">听客户发的语音，转成文字交给 AI</span></div>
      <div class="ai-use">客户发来的<b>语音消息</b>，软件先用<b>语音识别模型</b>把声音转成文字
        （转出来是客户说的原话，再交给翻译那家翻成中文、进档案）。
        这里单独选「语音识别」用哪家模型，不影响上面那几家文字 AI；
        选「其他（跟随语音任务默认）」= 跟随「语音任务默认」那家（tasks.asr）。选中的那家没填 key 时会安静回退到语音任务默认，不会让听语音失效。</div>
      <label>语音识别用哪个模型
        <select id="ai-voice-model">${opts}</select>
      </label>
    </div>`;
}

/** 「通用设置」：和 AI 无关、但属于软件设置的部分。目前放「消息提取间隔」+「气泡翻译模型」。 */
function renderGeneral() {
  const cur = Math.min(15, Math.max(2, Number(aiSnap?.extractInterval) || 5));
  const opts = [];
  for (let s = 2; s <= 15; s++) opts.push(`<option value="${s}" ${s === cur ? 'selected' : ''}>${s} 秒</option>`);
  return `<div class="ai-prov-head">通用设置</div>
    <div class="ai-sec ai-general">
      <div class="ai-sec-head">消息提取间隔</div>
      <div class="ai-use">
        软件用 WhatsApp 网页版<b>实时监听</b>收消息（消息一发出就到，不是定时轮询、也不是一直空转扫描）。
        这个间隔是<b>兜底重扫</b>：每隔这么久再核对一次最近对话，把实时推送偶尔漏掉的消息捞回来。
        调小更不容易漏、但更费资源；调大更省、但偶发漏收的窗口更长。默认 5 秒。
      </div>
      <label>提取间隔
        <select id="ai-extract">${opts.join('')}</select>
      </label>
    </div>${renderMemoryStat()}`;
}

/** 「跨消息翻译记忆」的只读统计（v2.6.1122）。
 *  同一句原文翻过一次就记进字典，之后再遇到**完全一致**的原文直接复用、一次 AI 都不调。
 *  这里只显示「记住了多少句 / 省了多少次调用」，是给人看的账，不提供开关。 */
function renderMemoryStat() {
  return `<div class="ai-sec ai-general">
      <div class="ai-sec-head">跨消息翻译记忆</div>
      <div class="ai-use" id="ai-mem-stat">读取中…</div>
      <div class="ai-use">
        同一句原文（客户发的、自己发的都算）翻过一次就记进字典，之后再遇到<b>完全一样</b>的原文
        直接复用、<b>一次 AI 都不调</b>；WhatsApp / Signal / Telegram 三个渠道共用这本字典。
        只按完全一致复用 —— 免得把不同语境下的同一句话翻串。
      </div>
    </div>`;
}

/** 把翻译记忆的统计填进上面那块（异步，慢一点也不影响页面先出来；读不到就整块留空） */
async function fillMemoryStat() {
  const box = $('ai-mem-stat');
  if (!box) return;
  try {
    const r = await api('/api/translate/memory');
    if (!r || r.ok === false) { box.textContent = '翻译记忆：暂时读不到统计'; return; }
    const total = Number(r.total) || 0;
    const saved = Number(r.saved) || 0;
    box.innerHTML = `已记住 <b>${total}</b> 句 · 已经省下 <b>${saved}</b> 次 AI 调用`
      + (r.enabled === false ? '（配置里已关闭，现在每条都重新翻）' : '');
  } catch (e) {
    box.textContent = '翻译记忆：暂时读不到统计';
  }
}

/** 「抽客户档案用哪个 AI」：AI 设置里单独一个下拉，可选：DeepSeek / Agnes / TikHub。
 *  对应 config 的 tasks.extract.provider（「从对话里提取档案」按钮就走它）。 */
function renderExtractPicker() {
  const st = aiSnap?.taskState?.extract || {};
  const cur = st.provider || aiSnap?.tasks?.extract?.provider || 'deepseek';
  // 2026 新增 5 家 OpenAI 兼容网关（chatanywhere / api2gpt / qianduoduo / no1apipro / zhichuang）也加入下拉
  const opts = [
    { v: 'deepseek', t: 'DeepSeek（deepseek-v4-flash）' },
    { v: 'agnes', t: 'Agnes（agnes-3.0-flash）' },
    { v: 'tikhub', t: 'TikHub（gpt-4o-mini）' },
    { v: 'chatanywhere', t: 'ChatAnyWhere（OpenAI 兼容）' },
    { v: 'api2gpt', t: 'API2GPT（OpenAI 兼容）' },
    { v: 'qianduoduo', t: '钱多多（OpenAI 兼容）' },
    { v: 'no1apipro', t: 'No.1 API-Pro（OpenAI 兼容）' },
    { v: 'zhichuang', t: '智创聚合（OpenAI 兼容）' },
  ].map((o) => `<option value="${o.v}" ${o.v === cur ? 'selected' : ''}>${esc(o.t)}</option>`).join('');
  const readyTxt = st.ready
    ? `<span class="ai-badge on">✓ 已配好（${esc(st.providerCn || cur)}）</span>`
    : `<span class="ai-badge">⚠ 这家还没填 key</span>`;
  return `<div class="ai-prov-head">③' 抽客户档案用哪个 AI（从对话里提取档案）</div>
    <div class="ai-sec ai-extract-pick">
      <div class="ai-sec-head">③' 从对话里提取档案 ${readyTxt}</div>
      <div class="ai-use">点中栏「从对话里提取档案」时，软件会读这个客户编号的<b>整段对话</b>（只认客户发来的 in 方向），
        交给下面选的 AI 抽成档案字段；对话里没提到的字段就留空，不硬编。换一家 AI 就在这里切。</div>
      <label>抽取用的 AI
        <select id="ai-extract-ai" data-task="extract">${opts}</select>
      </label>
    </div>`;
}

/** 「一、N 个 AI 分别干什么 · 现在用哪家」区块：6 个 AI 的任务表 + 3 个专项 AI（抽档案 / 气泡翻译 / 翻译词典）。
 *  2026 调整：把「从对话里提取档案 / 气泡翻译模型 / 翻译词典用哪个 AI」这三块从「通用设置」搬进本区块内，
 *  让「每个 AI 干什么、用哪家」和「那三个专项 AI 用哪家」一眼看全。 */
function renderAiTaskSection() {
  return `
    ${renderAiTasks()}
    <div class="ai-prov-head">专项 AI · 5 个（抽档案 / 气泡翻译 / 翻译词典 / 扫描图片 / 语音识别：单独选，不跟着「默认用哪家」变）</div>
    ${renderExtractPicker()}
    ${renderBubbleModelPicker()}
    ${renderMemoryModelPicker()}
    ${renderScanImagePicker()}
    ${renderVoicePicker()}`;
}

/** 「二、服务商：填地址和 key」区块的 HTML（管理员可见，会员显示提示）。
 *  顺手记下当前是否管理员（aiAdminShown），供权限翻转时只重渲染这一块。 */
function renderAiProvidersBlock() {
  const isAdmin = !!(window.BeePerm && typeof window.BeePerm.isAdmin === 'function' && window.BeePerm.isAdmin());
  aiAdminShown = isAdmin;
  if (isAdmin) {
    return `<div class="ai-prov-head">二、${(aiCat?.providers || []).length} 个服务商：填地址和 key（填完点「测试连接」）</div>`
      + renderAiProviders();
  }
  return `<div class="ai-prov-head">二、服务商配置（填地址和 key）</div>
    <div class="ai-note">这部分<b>仅管理员可见</b> —— 你当前以会员身份登录，密钥填写区不显示。请用管理员编号登录后再来配置。</div>`;
}

/** 权限（管理员 / 会员）翻转时，只重渲染「服务商」区块，不动其它已填的表单。
 *  只在 isAdmin 结论真的变了才动手，避免心跳刷新每次都重画。 */
function maybeRefreshProviderBlock() {
  const isAdmin = !!(window.BeePerm && typeof window.BeePerm.isAdmin === 'function' && window.BeePerm.isAdmin());
  if (aiAdminShown === isAdmin) return;   // 权限没变，不动
  aiAdminShown = isAdmin;
  const box = $('ai-prov-block');
  if (!box) return;
  box.innerHTML = renderAiProvidersBlock();
  if (isAdmin) {
    // 重新灌入已保存的值（会员态时这块没渲染，切到管理员后补一次）
    const prov = aiSnap?.providers || {};
    for (const meta of aiCat?.providers || []) {
      const p = prov[meta.key] || {};
      const b = pv(meta.key, 'baseUrl');
      const m = pv(meta.key, 'model');
      const k = pv(meta.key, 'apiKey');
      if (b) b.value = p.baseUrl || '';
      if (m) m.value = p.model || '';
      if (k) {
        k.value = p.hasKey ? (p.keyHint || '••••') : '';
        k.placeholder = p.hasKey ? '已填（想换就整个替换掉）' : 'sk-...';
      }
    }
  }
}

function renderAiBody() {
  const body = $('ai-body');
  if (!body) return;
  body.innerHTML = renderAiTaskSection() + renderGeneral()
    + `<div id="ai-prov-block">${renderAiProvidersBlock()}</div>`;

  fillMemoryStat(); // v2.6.1122：翻译记忆统计（只读，异步填，不阻塞页面）

  // 把已保存的值灌进表单（key 只回显掩码，用户不动就不会被改写）
  const prov = aiSnap?.providers || {};
  for (const meta of aiCat?.providers || []) {
    const p = prov[meta.key] || {};
    const b = pv(meta.key, 'baseUrl');
    const m = pv(meta.key, 'model');
    const k = pv(meta.key, 'apiKey');
    if (b) b.value = p.baseUrl || '';
    if (m) m.value = p.model || '';
    if (k) {
      k.value = p.hasKey ? (p.keyHint || '••••') : '';
      k.placeholder = p.hasKey ? '已填（想换就整个替换掉）' : 'sk-...';
    }
  }
}

/** 把后端当前配置填进表单（key 是掩码，用户不动它就不会被改写） */
async function loadAiConfigForm() {
  const hint = $('ai-hint');
  try {
    const snap = await api('/api/ai/config');
    if (snap.error) {
      if (hint) hint.textContent = snap.error;
      return;
    }
    aiSnap = snap;
    aiCat = snap.catalog || { tasks: [], providers: [] };
    if ($('ai-file')) $('ai-file').textContent = snap.file || 'config.yaml';
    renderAiBody();

    const tasks = aiCat.tasks || [];
    const notReady = tasks.filter((t) => !(snap.taskState || {})[t.key]?.ready && t.wired !== false);
    if (hint) {
      hint.textContent = notReady.length
        ? `还有 ${notReady.length} 个 AI 没配好：${notReady.map((t) => t.cn).join('、')}`
        : `${tasks.length} 个 AI 全部就绪。改完记得保存。`;
    }
  } catch (e) {
    if (hint) hint.textContent = '读不到配置：' + (e.message || e);
  }
}

/** 保存：只提交真正被改过的字段，避免把没动过的地址清空 */
async function saveAiConfig() {
  if (!aiSnap || !aiCat) {
    showNotice('warn', '配置还没读出来，等一下再保存');
    return;
  }
  const btn = $('ai-save');
  const hint = $('ai-hint');
  const old = btn ? btn.textContent : '保存';
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }

  const body = { providers: {}, tasks: {} };
  for (const meta of aiCat.providers || []) {
    // 会员态「服务商填地址和 key」区块不渲染（仅管理员可见）：对应的输入框不存在，
    // 跳过这些服务商，避免把云端同步下来的配置当成空值清空。
    if (!pv(meta.key, 'baseUrl')) continue;
    const cur = aiSnap.providers?.[meta.key] || {};
    const bag = {};
    const base = pvVal(meta.key, 'baseUrl');
    if (base !== (cur.baseUrl || '')) bag.baseUrl = base;
    const model = pvVal(meta.key, 'model');
    if (model !== (cur.model || '')) bag.model = model;
    const key = ($(`ai-p-${meta.key}-apiKey`)?.value || '').trim();
    if (key && !key.includes('•') && key !== (cur.keyHint || '')) bag.apiKey = key;
    if (Object.keys(bag).length) body.providers[meta.key] = bag;
  }

  // 7 个 AI 各自指向哪家（① 采集不用配，所以不在表单里、不发）
  for (const t of aiCat.tasks || []) {
    if (t.fixed) continue;
    const sel = document.querySelector(`select.ai-task-pick[data-task="${t.key}"]`);
    if (!sel) continue;
    const want = sel.value;
    if (want === (aiSnap.taskState?.[t.key]?.provider || '')) continue;
    body.tasks[t.key] = { provider: want, model: pvVal(want, 'model') || '' };
  }

  // ③' 抽客户档案用哪个 AI（专用下拉，不在 7 个 AI 里）：DeepSeek / Agnes / TikHub 三选一
  {
    const exPick = document.querySelector('select[data-task="extract"]');
    if (exPick) {
      const want = exPick.value;
      const cur = aiSnap?.taskState?.extract?.provider || aiSnap?.tasks?.extract?.provider || '';
      if (want !== cur) body.tasks.extract = { provider: want, model: pvVal(want, 'model') || '' };
    }
  }

  // 通用设置：提取间隔（秒）。和下拉当前值不同才发，避免无谓写盘
  const extSel = $('ai-extract');
  if (extSel) {
    const want = Number(extSel.value);
    if (isFinite(want) && want !== Number(aiSnap?.extractInterval || 5)) body.extractInterval = want;
  }

  // 通用设置：气泡翻译模型（服务商 key，'' = 跟随全局翻译）
  const bubbleSel = $('ai-bubble-model');
  if (bubbleSel) {
    const want = String(bubbleSel.value || '');
    if (want !== String(aiSnap?.bubbleTranslateModel || '')) body.bubbleTranslateModel = want;
  }

  // 通用设置：翻译词典用哪个 AI（deepseek / siliconflow / tikhub / bailian）
  const memSel = $('ai-mem-model');
  if (memSel) {
    const want = String(memSel.value || 'deepseek');
    if (want !== String(aiSnap?.translationMemoryModel || 'deepseek')) body.translationMemoryModel = want;
  }

  // 专项 AI：扫描图片用哪个视觉模型（服务商 key，'' = 跟随视觉任务默认）
  const scanSel = $('ai-scan-image-model');
  if (scanSel) {
    const want = String(scanSel.value || '');
    if (want !== String(aiSnap?.scanImageModel || '')) body.scanImageModel = want;
  }

  // 专项 AI：语音识别用哪个模型（服务商 key，'' = 跟随语音任务默认 asr）
  const voiceSel = $('ai-voice-model');
  if (voiceSel) {
    const want = String(voiceSel.value || '');
    if (want !== String(aiSnap?.voiceModel || '')) body.voiceModel = want;
  }

  try {
    const r = await api('/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.error) {
      if (hint) hint.textContent = '保存失败：' + r.error;
      showNotice('error', 'AI 配置没存上：' + r.error);
      return;
    }
    if (!r.changed || !r.changed.length) {
      if (hint) hint.textContent = '没有改动，什么都没写。';
    } else {
      if (hint) hint.textContent = `已保存 ${r.changed.length} 项，立即生效。`;
      showNotice('ok', `AI 配置已保存（${r.changed.length} 项），点「测试连接」确认能通`);
    }
    if (r.snapshot) {
      aiSnap = r.snapshot;
      aiCat = r.snapshot.catalog || aiCat;
      /* ④ 可能被改了：主窗口收到后端广播的 data_changed，会自己去重读配置、换徽章 */
      if ($('ai-file')) $('ai-file').textContent = r.snapshot.file || 'config.yaml';
    }
    await loadAiConfigForm();   // 掩码 / 徽章 / 就绪状态重新回显
  } catch (e) {
    if (hint) hint.textContent = '保存失败：' + (e.message || e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

/** 测试连接：拿表单里【正填着】的值真打一次请求（不用先保存） */
async function testAiProvider(name) {
  const el = $(`ai-test-${name}`);
  if (el) { el.textContent = '测试中…'; el.className = 'ai-test'; }
  const keyRaw = ($(`ai-p-${name}-apiKey`)?.value || '');
  try {
    const r = await api('/api/ai/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: name,
        model: pvVal(name, 'model'),
        baseUrl: pvVal(name, 'baseUrl'),
        apiKey: keyRaw.includes('•') ? '' : keyRaw.trim(),
      }),
    });
    if (el) {
      el.textContent = r.ok
        ? `✓ 通了（${r.ms}ms · ${r.model}）${r.reply ? '：' + r.reply : ''}`
        : `✗ ${r.error}`;
      el.className = `ai-test ${r.ok ? 'ok' : 'err'}`;
      // 真打了哪个地址也写出来 —— 404 的时候一眼能看出地址拼错在哪
      if (r.url) {
        const u = document.createElement('div');
        u.className = 'ai-test-url';
        u.textContent = '请求地址：' + r.url;
        el.insertAdjacentElement('afterend', u);
      }
    }
    showNotice(r.ok ? 'ok' : 'error', r.ok
      ? `${pvCn(name)} 连接正常（${r.ms}ms）`
      : `${pvCn(name)} 连不通：${r.error}`);
  } catch (e) {
    if (el) { el.textContent = '✗ ' + (e.message || e); el.className = 'ai-test err'; }
  }
}

/* ---------------- 模拟新消息（原主窗口浮出小卡片，整块搬来） ---------------- */

/* ---------------- 模拟新消息（原来挂在顶栏「🧪 模拟新消息」，2026-09-30 搬进本窗口） ----------------
 *
 * 给「想试软件，但没人隔着时差配合发消息」用：造一条假消息，喂给**真正的后端链路**。
 * 后端 handleMessage 是同一份代码，所以界面表现和真客户发消息一模一样：
 *   左栏跳出客户 + 红数字 → 右栏「⟳ 等待翻译中…」→ 译文补上 → 待处理 +1 → 档案文档写出来
 * 不会发给任何人（软件本来就没有发送能力）；模拟客户带 is_sim 标记，可一键清空。
 */

function simLog(html, cls) {
  const box = $('sim-log');
  if (!box) return;
  const hint = box.querySelector('.hint');
  if (hint) box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'line' + (cls ? ' ' + cls : '');
  d.innerHTML = html;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

async function refreshSimCount() {
  try {
    const r = await api('/api/dev/simulate');
    const el = $('sim-count');
    if (el) el.textContent = `库里现有模拟客户 ${r.count || 0} 个`;
    const sel = $('sim-acct');
    if (sel && !sel.options.length && r.accounts && r.accounts.length) {
      sel.innerHTML = r.accounts
        .map((a) => `<option value="${a.id}">${a.id} 号 · ${esc(a.label || '')}</option>`)
        .join('');
    }
  } catch (e) {
    /* 拿不到不影响使用 */
  }
}


/** 造一条模拟消息（direction=in 客户发给我 / out 我发给客户） */
async function sendSimulated(direction) {
  const text = ($('sim-text') && $('sim-text').value || '').trim();
  if (!text) {
    showNotice('warn', '先写一句客户会说的话，或点上面那四个现成句子');
    return;
  }
  const payload = {
    accountId: Number($('sim-acct') && $('sim-acct').value || 1),
    name: ($('sim-name') && $('sim-name').value || '').trim(),
    phone: ($('sim-phone') && $('sim-phone').value || '').trim(),
    body: text,
    direction,
  };
  try {
    const r = await api('/api/dev/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.error) {
      simLog(`✗ ${esc(r.error)}`, 'bad');
      showNotice('error', r.error);
      return;
    }
    const who = direction === 'out' ? '我 → 客户' : '客户 → 我';
    const cut = text.length > 42 ? text.slice(0, 42) + '…' : text;
    simLog(`✓ ${who} · <b>${esc(r.code)}</b> ${esc(r.name)}：${esc(cut)}`, 'good');
    refreshSimCount();
    // 界面不用手动刷：后端已经通过 SSE 推了 new_message / pending 过来
  } catch (e) {
    simLog(`✗ 发送失败：${esc(e.message || e)}`, 'bad');
  }
}

async function clearSimulatedData() {
  try {
    const r = await api('/api/dev/simulate/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (r.error) {
      simLog(`✗ ${esc(r.error)}`, 'bad');
      return;
    }
    simLog(`✓ 已清空：删掉 ${r.customers || 0} 个模拟客户、${r.messages || 0} 条消息（真实客户一条没碰）`, 'good');
    refreshSimCount();
    // 主窗口收到后端广播的 data_changed 会自己刷新左栏 / 今日消息，这里不用管它
  } catch (e) {
    simLog(`✗ 清空失败：${esc(e.message || e)}`, 'bad');
  }
}



/* ============================================================
   这一扇窗自己的装配（页签 / 按钮 / 首次加载）
   ============================================================ */

/** 五个页签：AI 设置 / AI 提示词 / 云端 / 模拟新消息 / 软件更新（记住上次停在哪一个） */
function switchTab(name) {
  for (const t of document.querySelectorAll('.set-tab')) t.classList.toggle('on', t.dataset.tab === name);
  for (const s of document.querySelectorAll('.set-sec')) s.classList.toggle('hidden', s.id !== `sec-${name}`);
  try { localStorage.setItem('bee.settingsTab', name); } catch (e) { /* 存不下无所谓 */ }
  if (name === 'cloud') loadCloudStatus();
  if (name === 'update') loadUpdateStatus();
  if (name === 'proxy') loadProxy();
  if (name === 'screenshot') loadScreenshotCfg();
  if (name === 'telegram') loadTelegramCfg();
  if (name === 'scanlog') { loadScanLog(); startScanLogPolling(); }
}
for (const t of document.querySelectorAll('.set-tab')) t.onclick = () => switchTab(t.dataset.tab);

// 关窗口：原生标题栏也能关，这里再给个 × 和 Esc
const setClose = $('set-close');
if (setClose) setClose.onclick = () => window.close();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });


/* ============================================================
   「🔄 软件更新」页签（2026-10-07 v1.2.0）
   ============================================================

   走本地 HTTP（/api/update/*），**不挂 preload** ——
   settings.html 那扇窗本来刻意不挂 preload 保持最小权限，
   不为一个功能去破它。

   🔴 采集中的判定：这里只管"如实上报"，绝不自己猜。
      正在采集客户消息时后端会拒绝自动重启，只显示提示。
*/

let upPollTimer = null;
let upBusy = false;      // 防连点：正在下载/检查时不再重复触发
let upReady = false;     // 有新版本已下载完 -> 亮出安装按钮

/** 软件此刻在不在采集？主窗口在跑就算在忙。
 *  🔴 2026-10-11 修：旧实现 `window.opener.document` 恒为真 → 永远判"忙" →
 *    后端 restartDecision(busy=true) 永远拒绝重启，导致点了安装也没反应。
 *    改为：只有当主窗口明确标了"正在采集"（window.__beeCollecting===true）才算忙，
 *    否则放行。主窗口目前没设这个标记，所以等效"采集结束可重启"，由下面的弹窗让用户确认。 */
function softwareIsBusy() {
  try {
    const w = window.opener;
    if (w && w.__beeCollecting === true) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function upSetState(text, kind) {
  const el = $('up-state');
  if (!el) return;
  const color = kind === 'error' ? 'var(--danger,#c0392b)'
    : kind === 'ok' ? 'var(--ok,#1d9e75)'
    : 'inherit';
  el.innerHTML = `<div style="color:${color}">${String(text || '')}</div>`;
}

function upSetBar(percent) {
  const bar = $('up-bar');
  const fill = $('up-fill');
  if (!bar || !fill) return;
  if (percent == null) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  fill.style.width = Math.max(0, Math.min(100, Math.round(percent))) + '%';
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch (e) { return String(iso); }
}

async function loadUpdateStatus() {
  const ver = $('up-ver');
  const src = $('up-src');
  const last = $('up-last');
  if (!ver) return;
  try {
    const r = await fetch('/api/update/status').then((x) => x.json());
    if (!r || !r.ok) {
      ver.textContent = '—';
      src.textContent = (r && r.error) || '读不到状态';
      return;
    }
    ver.textContent = `v${r.version || '?'}`;
    src.textContent = r.hint || '—';
    if (r.last) {
      const okWord = r.last.result === 'ok' ? '成功' : (r.last.result === 'fail' ? '失败' : '已取消');
      last.textContent = `${fmtTime(r.last.created_at)} · v${r.last.from_version || '?'} → v${r.last.version}（${okWord}）`;
    } else {
      last.textContent = '还没有更新记录';
    }
    const box = $('up-hist');
    if (box) {
      const h = Array.isArray(r.history) ? r.history : [];
      box.innerHTML = h.length
        ? h.map((x) => {
          const w = x.result === 'ok' ? '成功' : (x.result === 'fail' ? '失败' : '已取消');
          return `<div class="up-hist-row"><span>${fmtTime(x.created_at)}</span><span>v${x.from_version || '—'} → v${x.version}</span><span>${w}</span></div>`
            + (x.note ? `<div class="up-hist-note">${String(x.note)}</div>` : '');
        }).join('')
        : '<div class="hint">还没有更新记录。</div>';
    }
    upReady = false;
    const ib = $('up-install');
    if (ib) ib.classList.add('hidden');
  } catch (e) {
    upSetState('读不到状态：' + e.message, 'error');
  }
}

/** 轮询后端进度：下载大安装包可能要几分钟，只能轮询。
 *  ⚠️ 2026-10-11 修的致命 bug：轮询函数第一行曾写成 `if (upBusy) return`，
 *  而 upBusy 在点击「检查更新」时就被设为 true → 每一拍都在第一行 return，
 *  轮询永远读不到后端状态、也永远重置不了 upBusy，只能熬到硬超时（看着像"一直检查"）。
 *  upBusy 只该用来防按钮连点，不该挡轮询本身 —— 这一版把它拿掉了。 */
function upPoll() {
  if (upPollTimer) clearInterval(upPollTimer);
  // 前端硬超时兜底：后端看门狗 30 秒，这里放到 45 秒，确保后端那句超时提示
  // 能被轮询到并显示，绝不无限转圈、也不抢在后端之前误报。
  const HARD_TIMEOUT_MS = 45000;
  const startedAt = Date.now();
  upPollTimer = setInterval(async () => {
    // 前端硬超时兜底：到点仍没有任何终态 → 停下来
    if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
      upSetState('检查更新等待超时（超过 150 秒）。请检查网络能否连上 GitHub，或到项目下载安装包手动安装。', 'error');
      upSetBar(null);
      upBusy = false;
      if (upPollTimer) { clearInterval(upPollTimer); upPollTimer = null; }
      return;
    }
    try {
      const r = await fetch('/api/update/status').then((x) => x.json());
      if (!r || !r.ok) return;
      if (r.state === 'downloading') upSetBar(r.percent);
      if (r.state === 'downloaded') {
        upSetState(r.text || '下载完成。', 'ok');
        upSetBar(100);
        upBusy = false;
        upReady = true;
        const ib = $('up-install');
        if (ib) ib.classList.remove('hidden');
        // 🔴 2026-10-19 改造：空闲时下载完**自动跳安装**（静默装到默认位置，装完自动回主页面免登录）；
        //    正在采集时保留确认框让用户稍后手动点（不自动重启，避免丢消息上下文）。
        const busy = softwareIsBusy();
        if (!busy) {
          beginInstall();
        } else if ($('up-restart-modal') && $('up-restart-modal').classList.contains('hidden')) {
          showRestartModal(r.version, true);
        }
        const nb = $('up-note');
        if (nb) nb.textContent = '';
        if (upPollTimer) { clearInterval(upPollTimer); upPollTimer = null; }
        loadUpdateStatus();
      }
      if (r.state === 'error' || r.state === 'latest' || r.state === 'done') {
        upSetState(r.text || (r.state === 'done' ? '检查完成。' : ''), r.state === 'error' ? 'error' : 'ok');
        upSetBar(null);
        upBusy = false;
        if (upPollTimer) { clearInterval(upPollTimer); upPollTimer = null; }
        loadUpdateStatus();
      }
    } catch (e) { /* 轮询失败不打扰，下一轮再试 */ }
  }, 1200);
}

const upCheckBtn = $('up-check');
if (upCheckBtn) {
  upCheckBtn.onclick = async () => {
    if (upBusy) return;
    upBusy = true;
    upSetBar(0);
    upSetState('正在检查更新…');
    try {
      const r = await fetch('/api/update/check', { method: 'POST' }).then((x) => x.json());
      if (!r || !r.ok) {
        upSetState((r && r.error) || '检查失败', 'error');
        upBusy = false;
        return;
      }
      upPoll();
    } catch (e) {
      upSetState('检查失败：' + e.message, 'error');
      upBusy = false;
    }
  };
}

/** 弹出"是否立即重启安装"弹窗 */
function showRestartModal(version, busy) {
  const modal = $('up-restart-modal');
  const text = $('up-restart-text');
  const now = $('up-restart-now');
  if (!modal) return;
  if (text) {
    text.innerHTML = busy
      ? '软件正在采集客户消息，现在安装会关闭软件。<br>仍要立即安装并重启吗？（建议等采集结束再点）'
      : `新版本 ${version ? 'v' + version : ''} 已下载完成，是否立即重启软件完成安装？<br>安装完成后会自动重新打开。`;
  }
  if (now) now.textContent = busy ? '仍要安装并重启' : '立即安装并重启';
  modal.classList.remove('hidden');
}

/** 关闭重启弹窗（用户选"稍后"） */
function hideRestartModal() {
  const modal = $('up-restart-modal');
  if (modal) modal.classList.add('hidden');
}

/** 真正开始安装：弹窗关闭 → 全屏"正在安装"遮罩（带加载进度条）→ 调安装接口 → App 退出 → NSIS 装完自动重启 */
function beginInstall() {
  const busy = softwareIsBusy();
  hideRestartModal();
  const cover = $('up-install-cover');
  if (cover) {
    cover.classList.remove('hidden');
    const bar = cover.querySelector('.up-cover-bar');
    if (bar) bar.classList.add('indet'); // 走马灯不确定进度条（方案A）
  }
  try {
    fetch('/api/update/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ busy, version: '' }),
    })
      .then((x) => x.json())
      .then((r) => {
        if (r && r.auto) {
          // 后端 300ms 后 quitAndInstall；遮罩保持显示直到进程退出，NSIS 接管并显示真实进度，装完自动重启
          upSetState(r.reason || '正在安装…');
        } else {
          // 被后端拒绝（如采集保护）或出错：收起遮罩、提示原因
          if (cover) cover.classList.add('hidden');
          upSetState((r && (r.reason || r.error)) || '没有安装', 'error');
          loadUpdateStatus();
        }
      })
      .catch((e) => {
        if (cover) cover.classList.add('hidden');
        upSetState('安装失败：' + e.message, 'error');
      });
  } catch (e) {
    if (cover) cover.classList.add('hidden');
    upSetState('安装失败：' + e.message, 'error');
  }
}

const upRestartNow = $('up-restart-now');
if (upRestartNow) upRestartNow.onclick = beginInstall;
const upRestartLater = $('up-restart-later');
if (upRestartLater) upRestartLater.onclick = hideRestartModal;

const upInstallBtn = $('up-install');
if (upInstallBtn) {
  // 保留安装按钮做"稍后再装"的入口：点它重新弹出重启确认弹窗
  upInstallBtn.onclick = () => showRestartModal('', softwareIsBusy());
}

/* AI 设置 */
const aiSaveBtn = $('ai-save');
if (aiSaveBtn) aiSaveBtn.onclick = saveAiConfig;
// 弹窗内容是按后端目录动态渲染的，所以「测试连接 / 复制地址」用事件委托
const aiBodyEl = $('ai-body');
if (aiBodyEl) {
  aiBodyEl.addEventListener('click', (e) => {
    const t = e.target.closest('button[data-test]');
    if (t) { testAiProvider(t.dataset.test); return; }
    const c = e.target.closest('button[data-copy]');
    if (c) copyText(c.dataset.copy, c);
  });
}

/* AI 提示词 */
const prSideEl = $('pr-side');
if (prSideEl) {
  prSideEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pr]');
    if (!b) return;
    // 先切内容（renderPrMain 会把 prCur 更新成这个任务），再重画左边的高亮
    renderPrMain(b.dataset.pr);
    renderPrSide();
  });
}
const prMainEl = $('pr-main');
if (prMainEl) {
  prMainEl.addEventListener('click', (e) => {
    const c = e.target.closest('button[data-pr-copy]');
    if (c) copyPrField(c.dataset.prCopy, c);
  });
}

/* ---------------- 云端（v1.0.1） ----------------
   用编号登录云端后，「每日话术编排台」的话题碎片/对话就跟后台数据库同步了。
   铁律（老板要求）：
     · 后台录入的默认数据（主数据）只有管理员能改，软件只读，绝不回写；
     · 每个编号有自己唯一的仓库，默认后台数据不会进编号的仓库；
     · 一个编号同一时间只能在一台电脑上用（互斥）。
   没登录 / 断网 → 编排台自动退回本地，软件照常能用。 */

let cloudStatus = null;

function renderCloudState(st) {
  cloudStatus = st || null;
  // 🔴 v2.6.1106：云端身份一变（登录 / 退出 / 被踢下线）就立刻重算界面权限 ——
  //    「AI 设置 / AI 提示词 / 模拟新消息 / Telegram / 代理 / 截图设置」六个页签
  //    跟着「是不是管理员」自动出现或消失。
  //    判定规则一份在 perm.js，这里只负责把最新状态递过去，不自己判。
  if (window.BeePerm && typeof window.BeePerm.ingest === 'function') {
    try { window.BeePerm.ingest(st); } catch (e) { /* 权限模块没就绪不该拖垮设置窗 */ }
  }
  // 权限（管理员 / 会员）一变：重新渲染「服务商填地址和 key」区块（会员登录后这块要藏起来）
  try { maybeRefreshProviderBlock(); } catch (e) { /* 折叠出错也不该拖垮设置窗 */ }
  // 回填「启动时同步」勾选框，并启动「同步话题」按钮的冷却倒计时
  if ($('cl-autosync')) $('cl-autosync').checked = !!(st && st.autoSync);
  refreshCooldown();
  const line = $('cl-state-online');
  const box = $('cl-state-box');
  const hint = $('cl-hint');
  if (!st || !st.configured) {
    if (box) box.classList.add('hidden');
    if (hint) hint.textContent = '还没配置云端：编排台就用本地数据。';
    return;
  }

  const logged = !!st.loggedIn;
  if (box) box.classList.toggle('hidden', !logged);
  if ($('cl-login-box')) $('cl-login-box').classList.toggle('hidden', logged);
  if ($('cl-login')) $('cl-login').classList.toggle('hidden', logged);
  if ($('cl-logout')) $('cl-logout').classList.toggle('hidden', !logged);
  if ($('cl-code') && logged && st.operator) $('cl-code').value = st.operator.code || '';
  if ($('cl-pass') && logged) $('cl-pass').value = '';
  // 云端地址固定显示（写死，不可改）
  if ($('cl-base-label') && st.base) $('cl-base-label').textContent = st.base;

  if (logged && st.operator) {
    if ($('cl-state-code')) $('cl-state-code').textContent = st.operator.code + (st.operator.name && st.operator.name !== st.operator.code ? '（' + st.operator.name + '）' : '');
    if (line) line.textContent = st.online ? '在线（心跳正常）' : ('离线' + (st.lastError ? '：' + st.lastError : ''));
    const m = st.master || {};
    if ($('cl-state-master')) $('cl-state-master').textContent = m.fragments ? (m.fragments + ' 个碎片') : '还没同步';
    if ($('cl-state-sync')) {
      $('cl-state-sync').textContent = m.syncedAt
        ? String(m.syncedAt).replace('T', ' ').slice(0, 19)
        : (st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : '—');
    }
    if (hint) hint.textContent = '编排台现在读的是云端数据（后台改过的东西同步一次就生效）。';
  } else if (hint) {
    hint.textContent = '当前未登录：编排台用本地数据，登录后才跟后台同步。';
  }
}

async function loadCloudStatus() {
  try {
    const st = await api('/api/cloud/status');
    renderCloudState(st);
    refreshVaultStatus();
  } catch (e) { /* 读不到就不显示 */ }
}

const clLogin = $('cl-login');
if (clLogin) clLogin.onclick = async () => {
  const code = ($('cl-code') && $('cl-code').value || '').trim();
  const password = ($('cl-pass') && $('cl-pass').value || '');
  if (!code || !password) { showNotice('warn', '编号和密码都要填'); return; }
  clLogin.disabled = true;
  clLogin.textContent = '登录中…';
  try {
    const r = await api('/api/cloud/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, password }),
    });
    if (!r.ok) {
      // 编号被占用 → 这句是老板要的互斥提示
      showNotice('error', r.busy ? (r.error || '该编号已经有人在用') : (r.error || '登录失败'), 9000);
    } else {
      showNotice('ok', `已登录：${r.operator ? r.operator.code : code}（主数据 ${r.masterCount || 0} 个碎片）`, 7000);
      if ($('cl-pass')) $('cl-pass').value = '';
    }
    renderCloudState(r);
  } catch (e) {
    showNotice('error', '登录失败：' + (e.message || '网络不通'));
  }
  clLogin.disabled = false;
  clLogin.textContent = '登录云端';
};

const clLogout = $('cl-logout');
if (clLogout) clLogout.onclick = async () => {
  try {
    const r = await api('/api/cloud/logout', { method: 'POST' });
    showNotice('ok', '已退出云端，编排台改用本地数据');
    renderCloudState(r);
  } catch (e) { showNotice('error', '退出失败：' + (e.message || '')); }
};

/* 「同步话题」按钮 + 「启动时同步」勾选框（老板 2026-10-01 第 3 条） */
const clManualSync = $('cl-manual-sync');
let clCdTimer = null;
let clCdLeft = 0;      // 当前冷却剩余毫秒（来自最近一次状态快照）
let clCdStamp = 0;    // 上面那个快照对应的时间戳，用来实时递减

/** 拿到一份新状态（刚同步 / 刚登录 / 定时刷新）时调一次：把 cooldownLeft 灌进倒计时基准。 */
function refreshCooldown() {
  const st = cloudStatus || {};
  clCdLeft = Math.max(0, Number(st.cooldownLeft) || 0);
  clCdStamp = Date.now();
  tickManualSync();
}

function fmtCd(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 同步按钮的冷却倒计时：还剩多久才能再点，直接显示在按钮上。 */
function tickManualSync() {
  if (!clManualSync) return;
  const left = Math.max(0, clCdLeft - (Date.now() - clCdStamp));
  if (left > 0) {
    clManualSync.disabled = true;
    clManualSync.textContent = `⟳ 同步话题（${fmtCd(left)}）`;
    if ($('cl-sync-hint')) $('cl-sync-hint').textContent = '刚同步过，稍等一会儿再点。';
    if (!clCdTimer) clCdTimer = setInterval(tickManualSync, 500);
  } else {
    clManualSync.disabled = false;
    clManualSync.textContent = '⟳ 同步话题';
    if ($('cl-sync-hint')) $('cl-sync-hint').textContent = '';
    if (clCdTimer) { clearInterval(clCdTimer); clCdTimer = null; }
  }
}

if (clManualSync) clManualSync.onclick = async () => {
  clManualSync.disabled = true;
  clManualSync.textContent = '同步中…';
  try {
    const r = await api('/api/cloud/sync', { method: 'POST' });
    if (r.ok) {
      showNotice('ok', `已同步话题：${r.count} 个碎片（${r.syncedAt ? String(r.syncedAt).slice(0, 19).replace('T', ' ') : '刚刚'}）`, 7000);
    } else if (r.cooldown) {
      showNotice('warn', '刚同步过，5 分钟内不能重复同步');
    } else {
      showNotice('error', r.error || '同步失败');
    }
    renderCloudState(r);
  } catch (e) {
    showNotice('error', '同步失败：' + (e.message || ''));
    renderCloudState(cloudStatus);
  }
};

const clAutosync = $('cl-autosync');
if (clAutosync) clAutosync.onchange = async () => {
  const on = !!clAutosync.checked;
  try {
    const r = await api('/api/cloud/auto-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    showNotice('ok', on
      ? '已勾选：下次开软件自动同步一次，同步完会自动取消'
      : '已取消：下次开软件不再自动同步', 7000);
    renderCloudState(r);
  } catch (e) {
    showNotice('error', '设置失败：' + (e.message || ''));
    clAutosync.checked = !on;
  }
};

/* 「同步 AI 设置」按钮（v2.6.115x · 集中托管 API key） */
const clVaultSync = $('cl-vault-sync');
if (clVaultSync) clVaultSync.onclick = async () => {
  clVaultSync.disabled = true;
  clVaultSync.textContent = '同步中…';
  try {
    // 管理员 = 把本地 AI 密钥上传云端；会员 = 从云端拉密钥到本机（云端为准）
    const isAdmin = cloudStatus && cloudStatus.operator && cloudStatus.operator.role === 'admin';
    const r = await api('/api/ai/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: isAdmin ? 'push' : 'pull' }),
    });
    if (r.ok) {
      if (isAdmin) {
        showNotice('ok', '已把 AI 设置（密钥）保存到云端（云端只存密文）', 7000);
      } else {
        showNotice('ok', `已从云端同步 AI 设置：${(r.providers || []).join(' / ') || '（云端暂无密钥）'}`, 7000);
      }
      refreshVaultStatus();
    } else {
      showNotice('error', r.error || '同步失败', 9000);
    }
  } catch (e) {
    showNotice('error', '同步失败：' + (e.message || ''));
  } finally {
    clVaultSync.disabled = false;
    clVaultSync.textContent = '⟳ 同步 AI 设置';
  }
};

/** 拉一下本机密钥库状态，填到 cl-vault-status。 */
async function refreshVaultStatus() {
  const el = $('cl-vault-status');
  if (!el) return;
  try {
    const v = await api('/api/ai/vault');
    if (v && v.providers && v.providers.length) {
      el.textContent = '本机已有密钥：' + v.providers.join(' / ');
    } else {
      el.textContent = '本机还没有从云端同步的密钥';
    }
  } catch (e) { el.textContent = ''; }
}

/* 模拟新消息 */
const simIn = $('sim-in');
if (simIn) simIn.onclick = () => sendSimulated('in');
const simOut = $('sim-out');
if (simOut) simOut.onclick = () => sendSimulated('out');
const simClear = $('sim-clear');
if (simClear) simClear.onclick = clearSimulatedData;
const simText = $('sim-text');
if (simText) {
  simText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendSimulated('in');
  });
}
// 快捷英文句：点一下填进输入框，再点「客户发给我」就发出去
const simPanel = $('sim-panel');
if (simPanel) {
  simPanel.addEventListener('click', (e) => {
    const q = e.target.closest('button.sim-q');
    if (q) {
      const t = $('sim-text');
      if (t) { t.value = q.dataset.q; t.focus(); }
    }
  });
}

// ---- 代理（v2.5.1029 起）：2026-10-16 复刻 WA①→WA⑤ 后，五个内置浏览器标签各加一行代理 ----
/*
 * 代理实例清单（v2.6.1134）
 *   · WA①~⑤：五个内置浏览器标签（wa1~wa5，独立分区 persist:wa6~wa10），各一行代理。
 *     🔴 注意：代理 key 与编号段一致 —— wa1~wa5 走 webviewProxy（无账密本机 gost 中转），
 *       与外号 Chrome（一号~五号）的 account 代理互不相关。
 *   · tg1~tg3：Telegram 网页版标签；s1~s3：Signal 桌面端。
 *   · proxies.js 的 INSTANCE_KEYS 已含 wa1~wa5 + tg1~tg3 + s1~s3。
 */
const PROXY_INSTANCES = [
  { key: 'wa1', name: 'WA①', kind: 'WhatsApp 内置浏览器（WA① 标签）', color: '#25d366' },
  { key: 'wa2', name: 'WA②', kind: 'WhatsApp 内置浏览器（WA② 标签）', color: '#25d366' },
  { key: 'wa3', name: 'WA③', kind: 'WhatsApp 内置浏览器（WA③ 标签）', color: '#25d366' },
  { key: 'wa4', name: 'WA④', kind: 'WhatsApp 内置浏览器（WA④ 标签）', color: '#25d366' },
  { key: 'wa5', name: 'WA⑤', kind: 'WhatsApp 内置浏览器（WA⑤ 标签）', color: '#25d366' },
  { key: 'tg1', name: 'Tele①', kind: 'Telegram 网页版（标签）', color: '#229ed9' },
  { key: 'tg2', name: 'Tele②', kind: 'Telegram 网页版（标签）', color: '#229ed9' },
  { key: 'tg3', name: 'Tele③', kind: 'Telegram 网页版（标签）', color: '#229ed9' },
  { key: 's1', name: 'S1', kind: 'Signal 桌面端', color: '#5b8def' },
  { key: 's2', name: 'S2', kind: 'Signal 桌面端', color: '#5b8def' },
  { key: 's3', name: 'S3', kind: 'Signal 桌面端', color: '#5b8def' },
];
const PROXY_TYPES = ['http', 'https', 'socks4', 'socks5', 'ss', 'trojan', 'vmess', 'vless', 'hysteria2', 'tuic'];

function renderProxyRows(proxies) {
  const body = $('proxy-body');
  if (!body) return;
  body.innerHTML = PROXY_INSTANCES.map((inst) => {
    const p = (proxies && proxies[inst.key]) || {};
    const typeOpts = PROXY_TYPES.map((t) =>
      `<option value="${t}" ${(p.type || 'socks5') === t ? 'selected' : ''}>${t}</option>`).join('');
    return `<div class="px-row" data-key="${inst.key}">
      <div class="px-row-top">
        <span class="px-name"><i class="px-color" style="background:${inst.color}"></i>${inst.name}</span>
        <span class="px-kind">${inst.kind}</span>
        <label class="px-en"><input type="checkbox" data-f="enabled" ${p.enabled ? 'checked' : ''}> 启用代理</label>
      </div>
      <!-- v2.6.1098 排版（老板看图 QQ20261013-194825-副本.png）：
           一行放齐 = 协议 [下拉] [主机/IP] [端口] [用户名] [密码] [测试代理]
           · 用户名 / 密码：左侧标签撤掉、改框内占位字，与主机/端口并到同一行
           · 测试代理：从标题行挪到本行末尾，按内容宽度（不再撑满整行）
           · 地区备注：界面撤掉，值用隐藏 input 原样保留（保存不丢数据） -->
      <div class="px-grid">
        <label class="px-lb">协议</label>
        <select data-f="type" class="px-sel">${typeOpts}</select>
        <input data-f="host" placeholder="主机 / IP" value="${esc(p.host || '')}">
        <input data-f="port" placeholder="端口" value="${esc(p.port || '')}">
        <input data-f="user" placeholder="用户名" value="${esc(p.user || '')}">
        <input data-f="pass" class="px-pass" type="password" placeholder="密码" value="${p.pass ? '••••' : ''}">
        <button class="mini px-test" data-key="${inst.key}">测试代理</button>
      </div>
      <input type="hidden" data-f="region" value="${esc(p.region || '')}">
    </div>`;
  }).join('');
}

function readProxyRows() {
  const out = {};
  document.querySelectorAll('#proxy-body .px-row').forEach((row) => {
    const key = row.dataset.key;
    const f = (name) => row.querySelector(`[data-f="${name}"]`);
    const pass = f('pass').value;
    const entry = {
      enabled: !!f('enabled').checked,
      type: f('type').value,
      host: f('host').value.trim(),
      port: f('port').value.trim(),
      user: f('user').value.trim(),
      // 密码框是掩码（••••）时，说明用户没改过 → 不提交后端、保留原值
      region: f('region').value.trim(),
    };
    if (pass && pass.indexOf('•') === -1) entry.pass = pass;
    out[key] = entry;
  });
  return out;
}

let proxyLoaded = null;
async function loadProxy() {
  try {
    const r = await api('/api/proxy');
    proxyLoaded = (r && r.ok && r.proxies) ? r.proxies : {};
    renderProxyRows(proxyLoaded);
  } catch (e) {
    showNotice('error', '读代理配置失败：' + (e.message || e));
  }
}

async function saveProxy() {
  const btn = $('proxy-save');
  const hint = $('proxy-hint');
  const old = btn ? btn.textContent : '保存';
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const payload = readProxyRows();
    const r = await api('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r || r.ok === false) {
      showNotice('error', '代理保存失败：' + ((r && r.error) || '未知错误'));
    } else {
      proxyLoaded = r.proxies || payload;
      showNotice('ok', '代理配置已保存（WA / Signal 下次启动生效；webview 标签重新点开生效）');
    }
  } catch (e) {
    showNotice('error', '代理保存失败：' + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

const proxySaveBtn = $('proxy-save');
if (proxySaveBtn) proxySaveBtn.onclick = saveProxy;

// v2.5.1074：每行「测试代理」按钮 → 调 /api/proxy/test，比对直连/代理 IP 证明真的生效
document.addEventListener('click', async (e) => {
  const btn = e.target.closest && e.target.closest('.px-test');
  if (!btn) return;
  const key = btn.dataset.key;
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '测试中…';
  try {
    const r = await api('/api/proxy/test?key=' + encodeURIComponent(key));
    if (!r || r.ok === false) {
      showNotice('error', `测试失败（${key}）：${(r && (r.reason || r.error)) || '未知'}`);
    } else if (r.changed) {
      showNotice('ok', `${key} 代理生效：直连 ${r.directIp}（${r.directRegion || '未知地区'}） → 经代理 ${r.proxyIp}（${r.proxyRegion || '未知地区'}）`);
    } else if (r.proxyIp) {
      showNotice('warn', `${key} 代理通了：代理IP ${r.proxyIp}（${r.proxyRegion || '未知地区'}）；与直连 ${r.directIp}（${r.directRegion || '未知地区'}）相同，可能该实例没走代理或代理本身不换 IP`);
    } else {
      showNotice('error', `代理连不通（${key}）：${r.reason || '未知'}`);
    }
  } catch (ex) {
    showNotice('error', '测试异常：' + (ex.message || ex));
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
});


/* ============ 截图设置（v2.5.1065） ============ */
async function loadScreenshotCfg() {
  const hint = $('sh-hint');
  try {
    const cfg = await api('/api/screenshot/config');
    if (cfg.error) { if (hint) hint.textContent = cfg.error; return; }
    const c = cfg.config || {};
    $('sh-enabled').checked = c.enabled !== false;
    $('sh-hotkey').value = c.hotkey || 'Ctrl+Alt+Z';
    $('sh-savePath').value = c.savePath || '';
    $('sh-enableAiTranslate').checked = c.enableAiTranslate !== false;
    $('sh-targetLang').value = c.targetLang || '中文';
    // 翻译用 AI 下拉：视觉默认 + 各服务商
    let providers = [{ key: 'vision', cn: '视觉任务默认' }];
    try {
      const snap = await api('/api/ai/config');
      if (snap && snap.catalog && snap.catalog.providers) {
        for (const p of snap.catalog.providers) providers.push({ key: p.key, cn: p.cn || p.key });
      }
    } catch (e) { /* 拿不到也不阻塞 */ }
    const sel = $('sh-provider');
    sel.innerHTML = providers.map((p) => `<option value="${p.key}">${p.cn}</option>`).join('');
    sel.value = c.providerName || 'vision';
    if (hint) hint.textContent = '改完点「保存」立即生效。';
  } catch (e) {
    if (hint) hint.textContent = '读不到截图配置：' + (e.message || e);
  }
}

async function saveScreenshotCfg() {
  const btn = $('sh-save');
  const hint = $('sh-hint');
  const old = btn ? btn.textContent : '保存';
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  const body = {
    enabled: $('sh-enabled').checked,
    hotkey: ($('sh-hotkey').value || 'Ctrl+Alt+Z').trim(),
    savePath: $('sh-savePath').value.trim(),
    enableAiTranslate: $('sh-enableAiTranslate').checked,
    providerName: $('sh-provider').value,
    targetLang: ($('sh-targetLang').value || '中文').trim(),
  };
  try {
    const r = await api('/api/screenshot/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.error) {
      if (hint) hint.textContent = '保存失败：' + r.error;
      showNotice('error', '截图设置没存上：' + r.error);
    } else {
      const n = (r.changed && r.changed.length) || 0;
      if (hint) hint.textContent = `已保存 ${n} 项，立即生效。`;
      showNotice('ok', '截图设置已保存');
      // 通知主进程重注册快捷键（不用重启）
      if (window.beeShot && window.beeShot.setHotkey) {
        try { window.beeShot.setHotkey(body.enabled, body.hotkey); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    if (hint) hint.textContent = '保存失败：' + (e.message || e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

const shSaveBtn = $('sh-save');
if (shSaveBtn) shSaveBtn.onclick = saveScreenshotCfg;

/* ============ Telegram 凭证（v2.5.1081）：api_id / api_hash 存进 config.yaml ============
   只管凭证的读写；一次性登录在主窗口中栏「Tele①」的 Telegram 登录弹窗里完成。 */
async function loadTelegramCfg() {
  const state = $('tg-state');
  try {
    const r = await api('/api/telegram/config');
    if (r && r.ok) {
      if ($('tg-api-id')) $('tg-api-id').value = r.apiId ? String(r.apiId) : '';
      if ($('tg-api-hash')) $('tg-api-hash').value = r.apiHashSet ? (r.apiHashHint || '••••') : '';
    }
  } catch (e) { /* 读不到就算了 */ }

  // 新消息提示音开关（v2.5.1083）
  // 「气泡翻译模型」2026-10-15 v2.6.1121 已挪去「AI 设置 → 通用设置」，这里不再管它。
  let opt = null;
  try { opt = await api('/api/telegram/options'); } catch (e) { /* 读不到就用默认 */ }
  if ($('tg-notify-sound')) $('tg-notify-sound').checked = !!(opt && opt.notifySound);

  try {
    const st = await api('/api/telegram/status');
    if (!state) return;
    if (!st) state.textContent = '读不到状态';
    else if (st.loggedIn) state.textContent = '已配置 · 已登录（MTProto 采集中）';
    else if (st.hasCred) state.textContent = '已配置 · 未登录（回主窗口点 Tele① 登录）';
    else state.textContent = '未配置凭证';
  } catch (e) { if (state) state.textContent = '读不到状态'; }
}

async function saveTelegramCfg() {
  const btn = $('tg-save');
  const hint = $('tg-hint');
  const old = btn ? btn.textContent : '保存凭证';
  const idRaw = ($('tg-api-id') && $('tg-api-id').value || '').trim();
  const hashRaw = ($('tg-api-hash') && $('tg-api-hash').value || '').trim();
  if (!idRaw || !hashRaw || hashRaw.includes('•')) {
    showNotice('warn', '请填好 API ID 和 API Hash（已是掩码的不用重填，直接保存即可）');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const r = await api('/api/telegram/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiId: idRaw, apiHash: hashRaw }),
    });
    if (r && r.ok) {
      showNotice('ok', 'Telegram 凭证已保存（config.yaml）。回主窗口点 Tele① 登录即可开始采集。');
      if (hint) hint.textContent = `已保存 ${(r.changed || []).length} 项，立即生效。`;
      loadTelegramCfg();
    } else if (r && Array.isArray(r.changed) && r.changed.length === 0) {
      showNotice('ok', 'Telegram 凭证无变化，已是最新（config.yaml 已含这两项）。');
      if (hint) hint.textContent = '无变化';
    } else {
      showNotice('error', '保存失败：' + ((r && r.error) || '未知'));
      if (hint) hint.textContent = (r && r.error) || '保存失败';
    }
  } catch (e) {
    showNotice('error', '保存失败：' + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

const tgSaveBtn = $('tg-save');
if (tgSaveBtn) tgSaveBtn.onclick = saveTelegramCfg;

// v2.5.1083：新消息提示音（与凭证分开保存，避免改选项被迫重填 Hash）
// 2026-10-15 v2.6.1121：气泡翻译模型从这里移走，只剩提示音一个开关。
async function saveTelegramOpts() {
  const sound = !!(document.querySelector('#tg-notify-sound') && document.querySelector('#tg-notify-sound').checked);
  try {
    const r = await api('/api/telegram/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifySound: sound }),
    });
    if (r && r.ok) showNotice('ok', 'Telegram 提示音已保存。');
    else if (r && Array.isArray(r.changed) && r.changed.length === 0) showNotice('ok', 'Telegram 选项无变化，已是最新。');
    else showNotice('error', '保存失败：' + ((r && r.error) || '未知'));
  } catch (e) {
    showNotice('error', '保存失败：' + (e.message || e));
  }
}
const tgOptsBtn = $('tg-save-opts');
if (tgOptsBtn) tgOptsBtn.onclick = saveTelegramOpts;

/* ============ 扫描日志（v2.6.1174） ============
   把每次软件用 AI 看图 / 听语音的事件，写成老板看得懂的句子，
   成功时把 OCR 扫出来的文字显示出来，失败时显示失败原因。
   页签开着时每 5 秒自动刷新一次，让老板能实时看到"软件确实在扫"。 */
let slPollTimer = null;

function fmtSlTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把"服务商 key"转成界面上能看懂的名字（拿不到就回退到 key 本身） */
function slProviderName(provider, kind) {
  if (provider) return pvCn(provider);
  return kind === 'audio' ? '默认语音模型' : '默认视觉模型';
}

function slRowHtml(r) {
  const time = fmtSlTime(r.ts);
  const code = r.customer_code ? `客户 ${esc(r.customer_code)}` : '某客户';
  const dir = r.direction === 'out' ? '（我发的）' : '（客户发来）';
  const what = r.kind === 'audio' ? `一段语音${dir}` : `一张图${dir}`;
  const prov = slProviderName(r.provider, r.kind);
  const ok = Number(r.ok) === 1;
  if (ok) {
    const text = String(r.ocr_text || '').trim();
    const body = text
      ? `<div class="sl-text">扫出文字：「${esc(text)}」</div>`
      : '<div class="sl-text sl-empty">（看图成功，但没扫出文字）</div>';
    return `<div class="sl-row ok">
      <div class="sl-line"><span class="sl-time">${time}</span>
        <span class="sl-code">${code}</span> 发来${what}
        <span class="sl-prov">· 用 ${esc(prov)}</span></div>
      ${body}
    </div>`;
  }
  const err = String(r.error || '未知原因').trim();
  return `<div class="sl-row bad">
    <div class="sl-line"><span class="sl-time">${time}</span>
      <span class="sl-code">${code}</span> 发来${what}
      <span class="sl-prov">· 用 ${esc(prov)}</span></div>
    <div class="sl-text sl-err">扫描失败：${esc(err)}</div>
  </div>`;
}

async function loadScanLog() {
  const box = $('sl-list');
  if (!box) return;
  try {
    const r = await api('/api/scan/log');
    if (!r || r.ok === false) {
      box.innerHTML = `<div class="hint">读不到扫描日志：${esc((r && r.error) || '未知')}</div>`;
      return;
    }
    const logs = Array.isArray(r.logs) ? r.logs : [];
    const cnt = $('sl-count');
    if (cnt) cnt.textContent = r.total ? `共 ${r.total} 条` : '';
    if (!logs.length) {
      box.innerHTML = '<div class="hint">还没有扫描记录。客户发来图片或语音时，这里会出现一条条记录（含 AI 扫出来的文字）。</div>';
      return;
    }
    box.innerHTML = logs.map(slRowHtml).join('');
  } catch (e) {
    box.innerHTML = `<div class="hint">读不到扫描日志：${esc(e.message || e)}</div>`;
  }
}

function startScanLogPolling() {
  if (slPollTimer) return;
  slPollTimer = setInterval(() => {
    // 只在「扫描日志」页签还开着时刷，切走就停
    const sec = $('sec-scanlog');
    if (!sec || sec.classList.contains('hidden')) { stopScanLogPolling(); return; }
    loadScanLog();
  }, 5000);
}
function stopScanLogPolling() {
  if (slPollTimer) { clearInterval(slPollTimer); slPollTimer = null; }
}

const slRefresh = $('sl-refresh');
if (slRefresh) slRefresh.onclick = () => loadScanLog();


// 首次加载：三块都读一遍（都在各自页签里，读一次很快）
// v1.0.1：URL 上带 #cloud 之类锚点时优先落那个页签（主窗口云端提示条点「登录」就是这么跳进来的）
let startTab = 'ai';
try { startTab = localStorage.getItem('bee.settingsTab') || 'ai'; } catch (e) { /* ignore */ }
try {
  const h = String(location.hash || '').replace(/^#/, '');
  if (h && document.querySelector(`.set-tab[data-tab="${h}"]`)) startTab = h;
} catch (e) { /* ignore */ }
switchTab(startTab);
loadAiConfigForm();
loadPrompts();
loadCloudStatus();
refreshSimCount();
if (startTab === 'proxy') loadProxy();
loadScreenshotCfg();
