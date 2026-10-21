/* 翻译浮窗 · 独立窗口逻辑（不依赖主窗口 app.js）
 * 由 translate.html 加载。收到 beeTranslate.onData({text,code,count}) 后渲染。
 * 复用主界面 style.css 的 .tr-ver / .tr-bar / .zh 等样式。
 * 窗口可拖出主窗口（body.float-window + .float-head 的 -webkit-app-region: drag）。 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    try { return await res.json(); } catch (e) { return {}; }
  }

  /* ---- 翻译方式（手动/自动）记在本机 ---- */
  const TR_MODE_KEY = 'bee.trMode';
  function getTrMode() {
    try { return localStorage.getItem(TR_MODE_KEY) === 'auto' ? 'auto' : 'manual'; } catch (e) { return 'manual'; }
  }
  function setTrMode(mode) {
    const m = mode === 'auto' ? 'auto' : 'manual';
    try { localStorage.setItem(TR_MODE_KEY, m); } catch (e) { /* ignore */ }
    const sel = document.getElementById('tr-mode');
    if (sel) sel.value = m;
    return m;
  }
  function syncTrModeSelect() {
    const m = getTrMode();
    const sel = document.getElementById('tr-mode');
    if (sel && sel.value !== m) sel.value = m;
    return m;
  }

  function applyTrHint() {
    const out = document.getElementById('tr-out');
    if (!out || out.querySelector('.tr-ver') || out.querySelector('.warn')) return;
    out.innerHTML = getTrMode() === 'auto'
      ? '<div class="hint">「自动翻译」已开 —— 打开这个窗口就自动开始翻，不用再点「翻译」（换版本数会重翻）。</div>'
      : '<div class="hint">现在是「手动翻译」—— 点右边「翻译」才开始。想开窗即翻，把上面「方式」改成「自动翻译」。</div>';
  }

  /* ---- 模型徽章：显示「AI 设置 → ④ 采纳后翻成英文」当前选的那家 ---- */
  let trSnapCache = null;
  let trSnapAt = 0;
  function trProvShort(snap, key) {
    const p = (snap && snap.catalog && snap.catalog.providers || []).find((x) => x.key === key);
    return p ? (p.short || p.cn) : (key || '未知');
  }
  function paintTrProvider(el, snap) {
    const st = snap && snap.taskState && snap.taskState.translateReply;
    const key = (st && st.provider) || '';
    if (!key) {
      el.textContent = '未配置';
      el.classList.add('warn');
      el.title = '还没选「采纳后翻成英文」用哪家 —— 点顶栏「⚙ AI 设置」里选一个';
      return;
    }
    const name = trProvShort(snap, key);
    const ready = !!(st && st.ready);
    el.textContent = ready ? name : `${name} · 未配好`;
    el.classList.toggle('warn', !ready);
    el.title = `按「AI 设置 → ④ 采纳后翻成英文」显示的：${name}`
      + (st && st.model ? ` · 模型 ${st.model}` : '')
      + (ready ? '' : '（这把 key 还没填好：点顶栏「⚙ AI 设置」补上接入地址和 key，再点「测试连接」）');
  }
  async function syncTrProvider(force) {
    const el = document.getElementById('tr-provider-label');
    if (!el) return;
    const now = Date.now();
    if (force || !trSnapCache || now - trSnapAt > 5000) {
      try {
        const snap = await api('/api/ai/config');
        if (snap && !snap.error) { trSnapCache = snap; trSnapAt = Date.now(); }
      } catch (e) { /* keep last */ }
    }
    paintTrProvider(el, trSnapCache);
  }

  let trText = '';
  let trCode = '';
  let trBusy = false;

  async function doTranslate() {
    if (!trText) return;
    if (trBusy) return;
    const count = Number(document.getElementById('tr-count').value) || 2;
    const out = document.getElementById('tr-out');
    const goBtn = document.getElementById('tr-go');
    trBusy = true;
    const who = trSnapCache ? trProvShort(trSnapCache, trSnapCache.taskState && trSnapCache.taskState.translateReply && trSnapCache.taskState.translateReply.provider) : '';
    out.innerHTML = `<div class="hint">翻译中…（${who ? who + ' · ' : ''}按客户信息调口吻，给 ${count} 个版本）</div>`;
    if (goBtn) goBtn.disabled = true;
    try {
      const data = await api('/api/translate', {
        method: 'POST',
        body: JSON.stringify({ text: trText, code: trCode, count }),
      });
      if (data.error) {
        out.innerHTML = `<div class="warn">${esc(data.error)}</div>`
          + (/key|未配|没配置|没填/i.test(data.error)
            ? '<div class="hint">「采纳后翻英文」要用的那家 AI 还没填好 —— 点顶栏「⚙ AI 设置」，在对应的服务商那一段填上接入地址和 key，再点「测试连接」。</div>'
            : '');
        return;
      }
      const versions = data.versions || [];
      const tip = data.tip || '';
      let html = versions.map((v, idx) =>
        `<div class="tr-ver">
          <div class="tr-ver-head">版本 ${idx + 1}<button class="x copy" data-t="${esc(v.text)}">复制</button></div>
          <div class="tr-ver-text">${esc(v.text)}</div>
          ${v.zh ? `<div class="tr-ver-zh"><b>中文译文</b>　${esc(v.zh)}</div>` : ''}
          ${v.note ? `<div class="tr-ver-note">建议：${esc(v.note)}</div>` : ''}
        </div>`).join('');
      if (tip) html += `<div class="tr-tip"><b>AI 整体建议</b>：${esc(tip)}</div>`;
      const who2 = trProvShort(trSnapCache, data.provider) || data.provider || '';
      html += `<div class="hint">模型：${esc(who2)}${data.model ? ' / ' + esc(data.model) : ''}　·　按客户信息（${esc(data.region || '未知地区')}）调整了口吻</div>`;
      out.innerHTML = html;
      for (const b of out.querySelectorAll('.copy')) b.onclick = () => copyText(b.dataset.t, b);
    } catch (e) {
      out.innerHTML = '<div class="warn">翻译接口未连接</div>';
    } finally {
      trBusy = false;
      if (goBtn) goBtn.disabled = false;
    }
  }

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
    } catch (e) { /* ignore */ }
  }

  function render(payload) {
    trText = String(payload && payload.text || '').trim();
    trCode = (payload && payload.code) || '';
    const srcEl = document.getElementById('tr-src-text');
    if (srcEl) srcEl.textContent = trText;
    syncTrModeSelect();
    const out = document.getElementById('tr-out');
    if (out) out.innerHTML = '';
    const mode = getTrMode();
    // 翻译浮窗方便在多个客户间反复开：版本数用 payload 给的（默认 2），但尊重用户本机记忆的方式
    if (payload && payload.count) {
      const sel = document.getElementById('tr-count');
      if (sel && [2, 3].indexOf(Number(payload.count)) >= 0) sel.value = String(payload.count);
    }
    syncTrProvider(false);
    if (mode === 'auto') doTranslate();
    else applyTrHint();
  }

  function bind() {
    const closeBtn = document.getElementById('tr-close');
    if (closeBtn) closeBtn.onclick = () => { if (window.beeTranslate) window.beeTranslate.close(); };
    const goBtn = document.getElementById('tr-go');
    if (goBtn) goBtn.onclick = doTranslate;
    const modeSel = document.getElementById('tr-mode');
    if (modeSel) modeSel.onchange = () => {
      setTrMode(modeSel.value);
      const out = document.getElementById('tr-out');
      if (modeSel.value === 'auto') doTranslate();
      else applyTrHint();
    };
    const countSel = document.getElementById('tr-count');
    if (countSel) countSel.onchange = () => { if (getTrMode() === 'auto') doTranslate(); };
    if (window.beeTranslate && window.beeTranslate.onData) {
      window.beeTranslate.onData((payload) => render(payload));
    } else {
      // 兜底：没桥也能从 URL 拿到 text（开发期直接打开 translate.html?text=...）
      const q = new URLSearchParams(location.search);
      const t = q.get('text');
      if (t) render({ text: t, code: q.get('code') || '' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
