/* 建议浮窗 · 独立窗口逻辑（不依赖主窗口 app.js）
 * 由 suggest.html 加载。收到 beeSuggest.onData(sug) 后渲染。
 * sug 形状：{ id, attempt, avoid, day, groups:[{message,options:[{angle,text}]}], scene, code, messageId }
 * 与「针对这条消息的建议」弹窗一致：每条客户留言给 3 条建议。
 * v2.5.1027（老板 2026-10-10 看图 QQ20261010-233817.png 定）：
 *   ① 每条建议的按钮改成「采纳 / 不采纳 / 翻译」；
 *   ② 「不采纳」= **只把这一条划掉**（不影响另外两条、不重出建议），旁边留「撤销」可反悔；
 *   ③ 原来底部那张整张「第 4 张 · 不采纳」卡**已删除**（不想回这条时用主界面的「⏭ 跳过消息」）。
 * 窗口可拖出主窗口（body.float-window + .float-head 的 -webkit-app-region: drag）。 */
(function () {
  'use strict';

  const ANGLE_CN = {
    empathy: '共情', curiosity: '好奇', story: '故事', humor: '幽默',
    share: '分享', nudge: '轻推进', reassure: '打消顾虑', close: '收口', retreat: '退让',
  };

  let sug = null;

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

  function $(id) { return document.getElementById(id); }

  function showSrc() {
    const el = $('suggest-src');
    if (!el) return;
    const groups = (sug && sug.groups) || [];
    const msgs = groups.map((g) => g.message || '').filter(Boolean);
    const text = msgs.length ? msgs.join('\n') : (sug.scene || '');
    el.innerHTML = `<b>客户说：</b>${esc(text)}`;
  }

  function optionHtml(g, i, o) {
    return `<div class="opt" data-g="${g}" data-i="${i}">
      <div class="angle">${esc(ANGLE_CN[o.angle] || o.angle || '建议')}</div>
      <div class="text">${esc(o.text)}</div>
      <div class="acts">
        <button class="adopt" data-g="${g}" data-i="${i}">采纳</button>
        <button class="noad" data-g="${g}" data-i="${i}">不采纳</button>
        <button class="tr" data-g="${g}" data-i="${i}">翻译</button>
      </div>
    </div>`;
  }

  /* ---- 不采纳：只把这一条划掉（v2.5.1027）----
     老板要求「只划掉这一条」：不调后端、不重出建议、另外两条原样不动；
     旁边给一个「撤销」，点错了能原样回来。 */
  function strikeOption(g, i) {
    const wrap = $('suggest-groups');
    if (!wrap) return;
    const box = wrap.querySelector(`.opt[data-g="${g}"][data-i="${i}"]`);
    if (!box) return;
    const grp = (sug && sug.groups && sug.groups[g]) || null;
    const raw = (grp && grp.options && grp.options[i]) || {};
    const text = raw.text || '';
    const angle = ANGLE_CN[raw.angle] || raw.angle || '建议';

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
      const a = box.querySelector('.adopt'); if (a) a.onclick = () => adopt(g, i, a);
      const n = box.querySelector('.noad'); if (n) n.onclick = () => strikeOption(g, i);
      const t = box.querySelector('.tr'); if (t) t.onclick = () => openTranslate(g, i, null);
    };
  }

  function renderGroups() {
    const wrap = $('suggest-groups');
    if (!wrap) return;
    const groups = (sug && sug.groups) || [];
    if (!groups.length) {
      wrap.innerHTML = '<div class="hint">这次没有可显示的建议</div>';
      return;
    }
    let html = groups.map((grp, g) => {
      const msg = grp.message || '';
      const opts = (grp.options || []).map((o, i) => optionHtml(g, i, o)).join('');
      return `<div class="sgroup">
        <div class="sg-head" title="${esc(msg)}">客户说：${esc(msg.length > 90 ? msg.slice(0, 90) + '…' : msg)}</div>
        <div class="sg-opts">${opts}</div>
      </div>`;
    }).join('');

    // v2.5.1027：原来这里那张「第 4 张 · 不采纳」整张卡已按老板要求删除，
    // 「不采纳」改成挂在每条建议自己的按钮行上（见 optionHtml / strikeOption）。

    // 「都不行，换一批」
    html += `<div class="again"><button id="suggest-again" class="ghost">都不行，换一批</button></div>`;

    wrap.innerHTML = html;
    bindGroupButtons();
  }

  function bindGroupButtons() {
    const wrap = $('suggest-groups');
    if (!wrap) return;
    for (const b of wrap.querySelectorAll('.adopt')) b.onclick = () => adopt(Number(b.dataset.g), Number(b.dataset.i), b);
    for (const b of wrap.querySelectorAll('.noad')) b.onclick = () => strikeOption(Number(b.dataset.g), Number(b.dataset.i));
    for (const b of wrap.querySelectorAll('.tr')) b.onclick = () => openTranslate(Number(b.dataset.g), Number(b.dataset.i), null);
    const again = $('suggest-again');
    if (again) again.onclick = rejectAll;
  }

  /* ---- 采纳：先让你改，改完才存 ---- */
  function adopt(g, i, btn) {
    const box = btn.closest('.opt');
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
      </div>`;
    box.querySelector('.save').onclick = async () => {
      const text = box.querySelector('.edit').value.trim();
      const note = box.querySelector('.note').value.trim();
      if (!text) return;
      const res = await api('/api/suggestion/adopt', {
        method: 'POST',
        body: JSON.stringify({
          suggestionId: sug.id, groupId: g, optionIndex: i, text,
          note: note || null, angle: opt.angle, day: sug.day, scene: sug.scene,
        }),
      });
      if (res && res.ok) {
        box.innerHTML = `<div class="angle done">已记住 ${res.dedup ? '（同一句已有，次数 +1）' : ''}</div>
          <div class="text">${esc(text)}</div>
          <div class="hint">下次遇到相似场景，会优先往这个路子上靠。</div>
          <div class="acts"><button class="tr">翻译</button></div>`;
        box.querySelector('.tr').onclick = () => openTranslate(g, i, text);
      } else {
        box.innerHTML = `<div class="warn">${esc((res && res.error) || '采纳失败')}</div>`;
      }
    };
    box.querySelector('.cancel').onclick = renderGroups;
  }

  /* v2.5.1027：原来这里有个 reject(g,i)（「不要这条」→ 记负样本 + 整批重出），
     老板把单条按钮改成「不采纳 = 只划掉这一条」后它已无人调用，删除。
     要「重新出一批」走下面的 rejectAll（「都不行，换一批」）。 */

  /* ---- 都不行，换一批：整批否掉重出 ---- */
  async function rejectAll() {
    if (!sug) return;
    const wrap = $('suggest-groups');
    if (wrap) wrap.innerHTML = '<div class="hint">记下了，正在换一个切入口重新想…</div>';
    const data = await api('/api/suggestion/reject', {
      method: 'POST',
      body: JSON.stringify({
        suggestionId: sug.id, optionIndex: -1,
        attempt: sug.attempt, avoid: sug.avoid, day: sug.day, scene: sug.scene,
      }),
    });
    if (data && data.error) { if (wrap) wrap.innerHTML = `<div class="warn">${esc(data.error)}</div>`; return; }
    applyNewSug(data);
  }

  function applyNewSug(data) {
    sug = {
      id: data.suggestionId,
      attempt: data.attempt || 0,
      avoid: sug.avoid,
      day: (data.day && data.day.day != null) ? data.day.day : sug.day,
      groups: data.groups || [],
      scene: sug.scene,
      code: sug.code,
      messageId: sug.messageId,
    };
    renderGroups();
  }

  /* ---- 点「翻译」：在右侧栏内嵌翻译面板，不再弹独立窗（老板 2026-10-18 方案A） ---- */
  const TR_MODE_KEY = 'bee.trMode';
  function getTrPaneMode() {
    try { return localStorage.getItem(TR_MODE_KEY) === 'auto' ? 'auto' : 'manual'; } catch (e) { return 'manual'; }
  }
  function setTrPaneMode(m) {
    const v = m === 'auto' ? 'auto' : 'manual';
    try { localStorage.setItem(TR_MODE_KEY, v); } catch (e) { /* ignore */ }
    return v;
  }

  function openTranslate(g, i, textOverride) {
    if (!sug) return;
    const grp = sug.groups[g];
    if (!grp) return;
    const opt = grp.options[i];
    if (!opt) return;
    const text = String(textOverride != null ? textOverride : opt.text || '').trim();
    if (!text) return;
    openTrPane(text, sug.code);
  }

  let trPaneSnap = null;
  let trPaneBusy = false;
  let paneWidthBefore = null; // 打开翻译栏前的窗口宽度，关栏时还原

  function openTrPane(text, code) {
    const pane = $('tr-pane');
    if (!pane) return;
    if (paneWidthBefore == null) {
      // 第一次开栏：记下当前窗口宽，再加 700（左 8 份 + 右 7 份 = 700），超出屏幕主进程会自动限宽
      paneWidthBefore = window.innerWidth || 800;
      const target = paneWidthBefore + 700;
      if (window.beeSuggest && window.beeSuggest.resize) window.beeSuggest.resize(target, window.innerHeight || 800);
    }
    pane.hidden = false;
    pane.innerHTML = `
      <div class="tr-pane-head">
        <span>翻译建议 · 英文口语</span>
        <button id="tr-pane-close" class="x">×</button>
      </div>
      <div class="tr-pane-body">
        <div class="tr-src"><b>中文原文</b><div class="zh-src">${esc(text)}</div></div>
        <div class="tr-bar">
          <label>模型 <span class="tr-model" id="tr-pane-provider">读取中…</span></label>
          <label>版本数 <select id="tr-pane-count"><option value="2">2 个</option><option value="3">3 个</option></select></label>
          <label>方式 <select id="tr-pane-mode"><option value="manual">手动翻译</option><option value="auto">自动翻译</option></select></label>
          <button id="tr-pane-go" class="primary">翻译</button>
        </div>
        <div id="tr-pane-out" class="tr-out"><div class="hint">点「翻译」后，会按客户地区（如美国人→美式）把中文直接翻成英文，给出 2 种不同风格的版本。</div></div>
      </div>`;
    $('tr-pane-close').onclick = closeTrPane;
    const modeSel = $('tr-pane-mode');
    const countSel = $('tr-pane-count');
    const goBtn = $('tr-pane-go');
    const mode = getTrPaneMode();
    modeSel.value = mode;
    modeSel.onchange = () => {
      setTrPaneMode(modeSel.value);
      if (modeSel.value === 'auto') runTrPane(text, code);
      else applyTrPaneHint();
    };
    countSel.onchange = () => { if (getTrPaneMode() === 'auto') runTrPane(text, code); };
    goBtn.onclick = () => runTrPane(text, code);
    syncTrPaneProvider();
    if (mode === 'auto') runTrPane(text, code);
    else applyTrPaneHint();
  }

  function closeTrPane() {
    const pane = $('tr-pane');
    if (pane) { pane.hidden = true; pane.innerHTML = ''; }
    if (paneWidthBefore != null && window.beeSuggest && window.beeSuggest.resize) {
      window.beeSuggest.resize(paneWidthBefore, window.innerHeight || 800);
      paneWidthBefore = null;
    }
  }

  function applyTrPaneHint() {
    const out = $('tr-pane-out');
    if (!out) return;
    out.innerHTML = '<div class="hint">现在是「手动翻译」—— 点右边「翻译」才开始。想开窗即翻，把上面「方式」改成「自动翻译」。</div>';
  }

  function trProvShort(snap, key) {
    const p = (snap && snap.catalog && snap.catalog.providers || []).find((x) => x.key === key);
    return p ? (p.short || p.cn) : (key || '未知');
  }
  function paintTrPaneProvider(el, snap) {
    const st = snap && snap.taskState && snap.taskState.translateReply;
    const key = (st && st.provider) || '';
    if (!key) { el.textContent = '未配置'; el.classList.add('warn'); return; }
    const name = trProvShort(snap, key);
    const ready = !!(st && st.ready);
    el.textContent = ready ? name : `${name} · 未配好`;
    el.classList.toggle('warn', !ready);
  }
  async function syncTrPaneProvider() {
    const el = $('tr-pane-provider');
    if (!el) return;
    try { const snap = await api('/api/ai/config'); if (snap && !snap.error) trPaneSnap = snap; } catch (e) { /* keep last */ }
    paintTrPaneProvider(el, trPaneSnap);
  }

  async function runTrPane(text, code) {
    const out = $('tr-pane-out');
    if (!out || !text || trPaneBusy) return;
    trPaneBusy = true;
    const count = Number($('tr-pane-count').value) || 2;
    const who = trPaneSnap ? trProvShort(trPaneSnap, trPaneSnap.taskState && trPaneSnap.taskState.translateReply && trPaneSnap.taskState.translateReply.provider) : '';
    out.innerHTML = `<div class="hint">翻译中…（${who ? who + ' · ' : ''}按客户信息调口吻，给 ${count} 个版本）</div>`;
    const goBtn = $('tr-pane-go');
    if (goBtn) goBtn.disabled = true;
    try {
      const data = await api('/api/translate', { method: 'POST', body: JSON.stringify({ text, code: code || '', count }) });
      if (data.error) {
        out.innerHTML = `<div class="warn">${esc(data.error)}</div>`
          + (/key|未配|没配置|没填/i.test(data.error)
            ? '<div class="hint">「采纳后翻英文」要用的那家 AI 还没填好 —— 点顶栏「⚙ 设置 → AI 设置」，在对应服务商那一段填上接入地址和 key，再点「测试连接」。</div>'
            : '');
        return;
      }
      const versions = data.versions || [];
      const tip = data.tip || '';
      let html = versions.map((v, idx) =>
        `<div class="tr-ver">
          <div class="tr-ver-head">版本 ${idx + 1}
            <span style="display:flex;align-items:center;gap:8px;">
              <span class="only-en">只复制英文</span>
              <button class="x copy" data-t="${esc(v.text)}">复制</button>
            </span>
          </div>
          <div class="tr-ver-text">${esc(v.text)}</div>
          ${v.zh ? `<div class="tr-ver-zh"><b>中文译文</b>　${esc(v.zh)}</div>` : ''}
          ${v.note ? `<div class="tr-ver-note">建议：${esc(v.note)}</div>` : ''}
        </div>`).join('');
      if (tip) html += `<div class="tr-tip"><b>AI 整体建议</b>：${esc(tip)}</div>`;
      const who2 = trProvShort(trPaneSnap, data.provider) || data.provider || '';
      html += `<div class="hint">模型：${esc(who2)}${data.model ? ' / ' + esc(data.model) : ''}　·　按客户信息（${esc(data.region || '未知地区')}）调整了口吻</div>`;
      out.innerHTML = html;
      for (const b of out.querySelectorAll('.copy')) b.onclick = () => copyTrText(b.dataset.t, b);
    } catch (e) {
      out.innerHTML = '<div class="warn">翻译接口未连接</div>';
    } finally {
      trPaneBusy = false;
      if (goBtn) goBtn.disabled = false;
    }
  }

  function copyTrText(t, btn) {
    const done = () => {
      if (btn) {
        const old = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = old; }, 1200);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done, () => fallbackCopyTr(t, done));
    } else {
      fallbackCopyTr(t, done);
    }
  }
  function fallbackCopyTr(t, done) {
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

  /* v2.5.1027：原来这里有个 dontAdopt()（底部第 4 张卡「不采纳这条消息」→ 标记客户已处理 + 关窗），
     该卡已删，函数随之删除。「不想回这条」请用主界面底部的「⏭ 跳过消息」。 */

  function showPending() {
    const text = (sug && sug.scene) || '';
    const src = $('suggest-src');
    if (src) src.innerHTML = text ? `<b>客户说：</b>${esc(text)}` : '';
    const wrap = $('suggest-groups');
    if (wrap) wrap.innerHTML = '<div class="hint">正在为这条消息想 3 条回复…</div>';
  }
  function showError(msg) {
    const src = $('suggest-src');
    if (src) src.innerHTML = '';
    const wrap = $('suggest-groups');
    if (wrap) wrap.innerHTML = `<div class="warn">${esc(msg || '生成建议失败')}</div>`;
  }

  function render(data) {
    if (!data) return;
    sug = data;
    if (data.error) { showError(data.error); return; }
    if (data.pending) { showPending(); return; }
    showSrc();
    renderGroups();
  }

  function bind() {
    const closeBtn = $('suggest-close');
    if (closeBtn) closeBtn.onclick = () => { if (window.beeSuggest) window.beeSuggest.close(); };
    const winMax = $('win-max');
    if (winMax) winMax.onclick = () => { if (window.beeSuggest) window.beeSuggest.toggleMax(); };
    const ftitle = document.querySelector('.float-title');
    if (ftitle) ftitle.addEventListener('dblclick', () => { if (window.beeSuggest) window.beeSuggest.toggleMax(); });
    if (window.beeSuggest && window.beeSuggest.onData) {
      window.beeSuggest.onData((d) => render(d));
    } else {
      // 兜底：开发期直接打开 suggest.html?data=... 时可从这里拿（正常走 onData）
      const q = new URLSearchParams(location.search);
      const t = q.get('text');
      if (t) render({ id: 0, attempt: 0, avoid: [], groups: [{ message: '', options: [{ angle: '建议', text: t }] }], scene: t, code: q.get('code') || '' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
