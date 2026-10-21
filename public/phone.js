/**
 * 「📞 抓取」独立窗口的界面逻辑（2026-10-07，v1.0.13 改方向）
 *
 * 干什么：点一下，去**活着的 WhatsApp 网页**里把这位客户「资料」上的号码全捞回来，
 * 逐条显示：来自资料的哪个字段、原值、带没带 +、反查出哪个国家、**为什么**判成现在这样。
 *
 * 🔴 三条硬边界（别改）：
 *   1) 抓的是**客户资料**，不是聊天对话正文。（老板 2026-10-07 纠正过，第一版就搞错了。）
 *   2) 只读。不调任何写接口，不改档案，不发消息 —— 「看」和「改」必须分开。
 *   3) 判定宁宽勿缺。哪怕是 LID、哪怕 15 位看着就不像号码，也照样列出来并写清理由，
 *      这样老板能确认「确实看过了，没有真号」，而不是「怎么什么都没扫到」。
 */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const CODE = String(params.get('code') || '').trim();

/** 点开窗口时主进程会把客户名推过来（没推就显示编号） */
let custName = '';
window.addEventListener('DOMContentLoaded', init);

function init() {
  $('scan-close').addEventListener('click', () => window.close());
  $('scan-reload').addEventListener('click', () => load());

  // Electron 下由主进程推客户名；浏览器里直接开（调试）就只显示编号
  try {
    if (window.beePhone && typeof window.beePhone.onData === 'function') {
      window.beePhone.onData((d) => {
        if (d && d.name) { custName = String(d.name); paintHead(); }
      });
    }
  } catch (e) { /* 浏览器环境没有这个通道，忽略 */ }

  paintHead();
  load();
}

function paintHead() {
  $('scan-cust').textContent = CODE ? (custName ? `${CODE} · ${custName}` : CODE) : '（没选中客户）';
}

async function load() {
  if (!CODE) {
    $('scan-sum').textContent = '';
    $('scan-list').innerHTML = '<div class="scan-empty">没有指定客户。<br>请在主界面先选一个客户，再点「📞 抓取」。</div>';
    return;
  }
  $('scan-sum').textContent = '正在读这位客户的资料…';
  $('scan-list').innerHTML = '<div class="scan-empty">正在去 WhatsApp 里读联系人资料…</div>';
  try {
    const r = await fetch(`/api/phone/profile?code=${encodeURIComponent(CODE)}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    render(j);
  } catch (e) {
    $('scan-sum').textContent = '';
    $('scan-list').innerHTML = `<div class="scan-empty">抓取失败：${esc(e.message || e)}</div>`;
  }
}

function render(d) {
  const sum = $('scan-sum');
  const list = d.fields || [];

  // ---- 浏览器没开 / 读失败：说清楚下一步该做什么，别只丢一句"失败" ----
  if (d.ok === false) {
    sum.textContent = '';
    const why = d.reason === 'no-session' ? 'WhatsApp 窗口没开着' : '读取资料失败';
    $('scan-list').innerHTML = `<div class="scan-empty">
      <b style="color:#b23c3c">${esc(why)}</b><br>
      ${esc(d.hint || '请点右上角「重新抓取」再试一次。')}
      ${d.reason && d.reason !== 'no-session' ? `<br><span style="font-size:12px">原因：${esc(d.reason)}</span>` : ''}
    </div>`;
    return;
  }

  // ---- 顶部汇总 ----
  sum.innerHTML = [
    `这位客户的 <b>资料</b>上找到 <b>${d.total}</b> 项号码相关字段`,
    `<b>${d.okCount}</b> 项像真号码`,
    d.isLid
      ? '<span class="cur">这是 <b>LID 隐私会话</b> —— 号码被 WhatsApp 藏起来了</span>'
      : '<span class="cur">这是<b>号码型</b>会话（不是 LID）</span>',
    d.current && d.current.phone
      ? `档案现有号码：<b>${esc(d.current.phone)}</b>（来源 ${esc(d.current.src || '未标记')}）`
      : '<span class="cur">档案里现在<b>没有</b>号码</span>',
  ].join('');

  if (!list.length) {
    $('scan-list').innerHTML =
      '<div class="scan-empty">这位客户的资料上，<b>没有</b>任何号码相关的字段。<br>'
      + '<span style="font-size:12px">（说明 WhatsApp 确实没给我们这个号码 —— 不是软件没抓到）</span></div>';
    return;
  }

  $('scan-list').innerHTML = list.map(rowHtml).join('');
}

function rowHtml(c) {
  const tags = [];
  if (c.hasPlus) tags.push(`<span class="tag t-plus">原文带 ${esc(c.hasPlus)}</span>`);
  if (c.country) tags.push(`<span class="tag t-cc">${esc(c.country)}</span>`);
  if (c.len) tags.push(`<span class="tag">${c.len} 位</span>`);
  tags.push(`<span class="tag t-src">${esc(c.src || '')}</span>`);
  if (!c.ok) tags.push(`<span class="tag t-no">${esc(c.kindLabel || '不像号码')}</span>`);
  if (c.isCurrent) tags.push('<span class="tag t-cur">＝档案现有号码</span>');

  return `<div class="scan-row ${c.ok ? 'ok' : 'no'} ${c.isCurrent ? 'cur' : ''}">
    <div class="scan-line1">
      <span class="scan-digits">${c.digits ? esc(c.digits) : '（无数字）'}</span>
      ${tags.join('')}
    </div>
    <div class="scan-raw">资料上的原值：${esc(c.raw)}</div>
    <div class="scan-why">${esc(c.reason)}</div>
  </div>`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
