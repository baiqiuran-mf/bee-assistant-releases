/**
 * 每日话术编排台 · 前端逻辑（主窗口内共享 / 独立浮窗共用同一份）
 *
 * 两种运行形态：
 *  ① 桌面端「独立浮窗」：Electron 开一个真正的窗口（board.html），可拖到屏幕任意位置、
 *     不受主窗口边界限制。主窗口点「话术编排台」/ 切客户时，通过 window.beeBoard 通知主进程。
 *  ② 浏览器兜底：没有 beeBoard 通道时，退化为嵌在主界面右侧的可移动面板（原来的形态）。
 *
 * 与后端 /api/board/:code 对接。左栏=Day 话题碎片（过了时段的静默划线、不可点；
 * 全部对话都点过「已发」的话题打绿色 ✓，仍然可以点进去看），
 * 右栏=选中碎片的对话卡片（英文+中文+修改/已发/复制/发送）。
 * 「发送」只把英文预填进 WhatsApp 输入框（后端 prefillChat），不自动发出去。
 * ⚠️ 「已发 / 恢复」只记本机（后端写 board/<编号>.sent.json），不联网、不碰云端。
 */
(function () {
  const $ = (id) => document.getElementById(id);

  // 独立浮窗模式（board.html 里会先设 __BOARD_STANDALONE__）
  const STANDALONE = !!window.__BOARD_STANDALONE__;

  async function api(path, opt) {
    const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opt));
    let b = null;
    try { b = await r.json(); } catch (e) { b = null; }
    return { status: r.status, body: b };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  // 英文里的 {name} 占位符替换成当前客户的称呼
  function subst(en) {
    const name = (state.name || '').trim();
    return String(en || '').replace(/\{name\}/g, name);
  }

  // 提示：主界面有全局 showNotice 就用它；独立浮窗里自己弹一个小条
  let toastTimer = null;
  function notice(text) {
    if (window.showNotice) { window.showNotice('info', text, 5000); return; }
    let t = document.getElementById('board-toast');
    if (!t) { t = document.createElement('div'); t.id = 'board-toast'; document.body.appendChild(t); }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
  }

  const state = {
    code: null, name: '', phone: '', accountId: null, day: 1,
    board: null, selFrag: null,
    selDlg: null,   // 右侧被点选的那条对话（右上角「删」就是删它）
    viewDay: 1,     // 左栏当前浏览的是第几天的话题碎片（2026-09-30：按 Day 分页）
    hasV376: true,  // 这份看板有没有 V3.7.6 导入段（false 时左下角出现「补全新话术」）
  };

  // 页序：Day 1 … Day 7，之后是「后期维护」（数据里 day=8，页签显示中文名）。
  const DAY_MIN = 1, DAY_MAX = 7;
  const DAY_MAINTENANCE = 8;   // 「后期维护」页在数据里的 day 值
  const PAGE_MAX = DAY_MAINTENANCE;   // 可浏览的最大页码

  /** 页码 → 页签文字（第 8 页不叫 "Day 8"，叫「后期维护」） */
  function pageLabel(d) {
    return d === DAY_MAINTENANCE ? '后期维护' : `Day ${d}`;
  }

  /** 时段三态：morning / evening 互斥，两者皆 false = 通用（永不划线）。
   *  本地时间 <13:00 划掉「晚上的对话」；≥13:00 划掉「早上的对话」。 */
  function isStruck(frag) {
    const h = new Date().getHours();
    return (h < 13) ? !!frag.evening : !!frag.morning;
  }

  /** 某个 Day 的碎片 */
  function fragsOfDay(d) {
    return (state.board?.fragments || []).filter((f) => (f.day || 1) === d);
  }

  /** 这个碎片是不是「话题完成」：有对话、而且每条都点了「已发」。
   *  空碎片不算完成 —— 还能往里加对话。
   *  ⚠️ 跟后端 scriptBoard.fragmentDone() 是同一条规则，改一处要跟着改另一处。 */
  function fragDone(f) {
    const ds = (f && f.dialogues) || [];
    return ds.length > 0 && ds.every((x) => x && x.sent);
  }

  /** 这个 Day 的碎片是不是「都用过了」：有碎片、且每条对话都点了『已发』。
   *  空 Day（没有碎片）不算用过 —— 用户可以进去加碎片。 */
  function dayAllUsed(d) {
    const fs2 = fragsOfDay(d);
    return fs2.length > 0 && fs2.every(fragDone);
  }

  /** 进某一天时默认选哪个碎片：优先「还有活要干」的
   *  （没过时段、也还没发完）→ 其次没用过的 → 再次没发完的 → 实在没有才退回第一个。 */
  function pickDefault(list) {
    if (!list || !list.length) return null;
    return list.find((f) => !isStruck(f) && !fragDone(f))
      || list.find((f) => !isStruck(f))
      || list.find((f) => !fragDone(f))
      || list[0];
  }

  /** 默认打开哪一天（按话术流程）：从 Day1 起找「还没全部发完」的第一天。
   *  —— Day1 的话题碎片都用过了，就默认打开 Day2（用户 2026-09-30 的要求）。
   *  1~7 全都用完了，就停在最后一天；「后期维护」页不参与自动跳转（用户手动翻过去）。 */
  function defaultViewDay() {
    for (let d = DAY_MIN; d <= DAY_MAX; d++) {
      if (!dayAllUsed(d)) return d;
    }
    return DAY_MAX;
  }

  /* ---------------- 渲染 ---------------- */
  function renderHead() {
    const c = $('board-cust');
    if (!c) return;
    if (!state.code) { c.textContent = '未选择客户'; return; }
    c.textContent = `${state.code} · ${state.name || ''} · ${state.phone || ''} · ${pageLabel(state.day)}`;
  }

  /** 时段小图标：早（绿底）/ 晚（紫底）/ 通（蓝底），放在碎片标题前面 */
  function timeTag(f) {
    if (f.morning) return { cls: 'bp-tag-morning', ch: '早', tip: '早上的对话（下午会被划掉）' };
    if (f.evening) return { cls: 'bp-tag-evening', ch: '晚', tip: '晚上的对话（上午会被划掉）' };
    return { cls: 'bp-tag-any', ch: '通', tip: '通用对话（任何时候都能用）' };
  }

  function renderLeft() {
    const list = $('board-list');
    list.innerHTML = '';
    // 左栏标题 / 页码 / 翻页按钮都跟着当前浏览的页（Day 1 / Day 2 … / 后期维护）
    const tip = $('board-left-tip');
    if (tip) tip.textContent = `${pageLabel(state.viewDay)} 话题碎片`;
    const pageEl = $('board-page');
    if (pageEl) pageEl.textContent = pageLabel(state.viewDay);
    const prevBtn = $('board-prev');
    const nextBtn = $('board-next');
    if (prevBtn) prevBtn.disabled = state.viewDay <= DAY_MIN;
    if (nextBtn) nextBtn.disabled = state.viewDay >= PAGE_MAX;
    // 「补全新话术」：只在还没导入过 V3.7.6 段的看板上出现（导入后自动消失）
    const vBtn = $('board-v376');
    if (vBtn) vBtn.classList.toggle('hidden', !!state.hasV376);

    if (!state.board) return;
    // 只显示当前页的碎片（用户要求：按话术流程一天一页）
    const frags = fragsOfDay(state.viewDay);
    if (!frags.length) {
      const empty = document.createElement('div');
      empty.className = 'board-empty';
      empty.textContent = state.viewDay === DAY_MAINTENANCE
        ? '后期维护还没有话题碎片 —— 点左下角「＋添加」加一个'
        : `Day ${state.viewDay} 还没有话题碎片 —— 点左下角「＋添加」加一个`;
      list.appendChild(empty);
      return;
    }
    frags.forEach((f) => {
      const done = fragDone(f);
      // 已完成的话题不再按「过了时段」划掉 —— 老板明确要求：完成了也要能点进去看，不许静默
      const struck = isStruck(f) && !done;
      const div = document.createElement('div');
      div.className = 'bp-frag' + (struck ? ' struck' : '') + (done ? ' done' : '')
        + (state.selFrag === f.id ? ' active' : '');
      div.dataset.fid = f.id;
      const n = (f.dialogues || []).length;
      div.title = done
        ? `这个话题已经发完（${n}/${n}），仍可点开查看`
        : timeTag(f).tip;
      const t = timeTag(f);
      const tag = document.createElement('span');
      tag.className = 'bp-tag ' + t.cls;
      tag.textContent = t.ch;
      div.appendChild(tag);
      if (done) {
        // 绿色 ✓ 徽章：一眼看出这个话题已经完成（名字不变灰、不划线，照样能点）
        const ok = document.createElement('span');
        ok.className = 'bp-done';
        ok.textContent = '✓';
        ok.title = '这个话题的对话都发完了';
        div.appendChild(ok);
      }
      const nm = document.createElement('span');
      nm.className = 'bp-frag-name';
      nm.textContent = f.name;
      div.appendChild(nm);
      if (!struck) div.addEventListener('click', () => selectFrag(f.id));
      list.appendChild(div);
    });
  }

  function renderRight() {
    const nameEl = $('board-frag-name');
    const cards = $('board-cards');
    if (!state.selFrag) {
      nameEl.textContent = '—';
      cards.innerHTML = '<div class="board-empty">← 点左侧一个碎片查看对话</div>';
      return;
    }
    const f = state.board.fragments.find((x) => x.id === state.selFrag);
    if (!f) { nameEl.textContent = '—'; return; }
    nameEl.textContent = f.name;
    cards.innerHTML = '';
    const list = f.dialogues || [];
    if (!list.length) {
      cards.innerHTML = '<div class="board-empty">这个碎片还没有对话，点右上角「+ 添加对话」</div>';
      return;
    }
    list.forEach((d) => {
      const card = document.createElement('div');
      // sent = 已经发过了（灰掉+划线）；selected = 被点选（右上角「删」删的就是它）
      card.className = 'bp-card' + (d.sent ? ' sent' : '') + (state.selDlg === d.id ? ' selected' : '');
      card.dataset.did = d.id;
      const en = document.createElement('div');
      en.className = 'bp-en';
      en.textContent = subst(d.en);
      const zh = document.createElement('div');
      zh.className = 'bp-zh';
      zh.textContent = d.zh || '';
      const btns = document.createElement('div');
      btns.className = 'bp-card-btns';
      btns.innerHTML =
        '<button class="bp-btn" data-act="edit">修改</button>' +
        '<button class="bp-btn ' + (d.sent ? 'bp-sent-on' : 'bp-sent-off') + '" data-act="sent" title="'
          + (d.sent ? '恢复 = 取消这条的「已发」标记' : '已发 = 这条我发过了（只记本机，不联网）')
          + '">' + (d.sent ? '恢复' : '已发') + '</button>' +
        '<button class="bp-btn" data-act="copy">复制</button>' +
        '<button class="bp-btn bp-primary" data-act="send">发送</button>';
      card.appendChild(en); card.appendChild(zh); card.appendChild(btns);
      cards.appendChild(card);
    });
  }

  function renderAll() { renderHead(); renderLeft(); renderRight(); }

  /* ---------------- 交互 ---------------- */
  function selectFrag(fid) {
    state.selFrag = fid;
    state.selDlg = null;   // 换碎片就清掉右侧的点选
    renderLeft(); renderRight();
  }

  /** 翻到第 d 页的话题碎片（分页：上一页 / 下一页；最后一页是「后期维护」） */
  function gotoDay(d) {
    const nd = Math.min(PAGE_MAX, Math.max(DAY_MIN, d));
    if (nd === state.viewDay) return;
    state.viewDay = nd;
    state.selDlg = null;
    const today = fragsOfDay(nd);
    const open = pickDefault(today);
    state.selFrag = open ? open.id : null;
    renderAll();
  }

  /** 真正把某个客户的看板拉进来并渲染（不负责开窗/显隐） */
  async function loadInto(code) {
    const r = await api(`/api/board/${code}`);
    if (!r.body || r.status !== 200) { notice('读不到该客户的话术看板'); return false; }
    const sameCust = state.code === code;
    state.code = code;
    state.name = r.body.name || '';
    state.phone = r.body.phone || '';
    state.accountId = r.body.accountId;
    state.day = r.body.day || 1;
    state.board = r.body.board;
    state.hasV376 = r.body.hasV376 !== false;   // 老版本后端没这个字段 → 当作已导入，不显示按钮
    state.selDlg = null;   // 换客户：右侧点选清空
    // 默认打开哪天：换客户时按话术流程自动算；同一客户保持当前浏览的页
    if (!sameCust || !(state.viewDay >= DAY_MIN && state.viewDay <= PAGE_MAX)) {
      state.viewDay = defaultViewDay();
    }
    // 选中当前 Day 里第一个「还有活要干」的碎片
    const today = fragsOfDay(state.viewDay);
    if (!state.selFrag || !today.find((f) => f.id === state.selFrag)) {
      const open = pickDefault(today);
      state.selFrag = open ? open.id : null;
    }
    renderAll();
    return true;
  }

  async function reload() {
    if (!state.code) return;
    await loadInto(state.code);
  }

  function showPanel() { const p = $('board-panel'); if (p) p.classList.remove('hidden'); }
  function closePanel() { const p = $('board-panel'); if (p) p.classList.add('hidden'); }

  /** 点「话术编排台」按钮：桌面端开独立浮窗；浏览器端显示内嵌面板 */
  async function openFor(code) {
    if (!code) { notice('先选一个客户，再看话术编排台'); return; }
    if (STANDALONE) { await loadInto(code); return; }
    if (window.beeBoard && typeof window.beeBoard.open === 'function') {
      try { await window.beeBoard.open(code); return; } catch (e) { /* 开不了就退回内嵌面板 */ }
    }
    await loadInto(code);
    showPanel();
  }

  /** 切客户时调用：浮窗已开着就跟着换客户；没开就不打扰（不主动弹窗） */
  async function syncFor(code) {
    if (!code) return;
    state.code = code; // 记住当前客户，供顶栏按钮使用
    if (STANDALONE) { await loadInto(code); return; }
    if (window.beeBoard && typeof window.beeBoard.sync === 'function') {
      try { await window.beeBoard.sync(code); return; } catch (e) { /* ignore */ }
    }
    if ($('board-panel') && !$('board-panel').classList.contains('hidden')) {
      await loadInto(code);
    }
  }

  /* ---- 弹窗：改/添加碎片（名称 + 早上/晚上 两个勾选，都不勾=通用） ---- */
  let fragMode = 'edit';   // 'edit' | 'add'
  function syncFragChecks() {
    // 两个勾选互斥：勾上早上的对话就取消晚上的对话，反之亦然
    const m = $('bp-frag-morning');
    const e = $('bp-frag-evening');
    if (m && m.checked && e) e.checked = false;
    if (e && e.checked && m) m.checked = false;
  }
  function openFragPop(mode) {
    fragMode = (mode === 'add') ? 'add' : 'edit';
    if (fragMode === 'add') {
      $('bp-frag-title').textContent = '添加碎片';
      $('bp-frag-name').value = '';
      $('bp-frag-morning').checked = false;
      $('bp-frag-evening').checked = false;
    } else {
      if (!state.selFrag) { notice('先点左侧一个碎片'); return; }
      const f = state.board.fragments.find((x) => x.id === state.selFrag);
      if (!f) return;
      $('bp-frag-title').textContent = '修改碎片';
      $('bp-frag-name').value = f.name;
      $('bp-frag-morning').checked = !!f.morning;
      $('bp-frag-evening').checked = !!f.evening;
    }
    $('board-pop-frag').classList.remove('hidden');
    const inp = $('bp-frag-name');
    if (inp) setTimeout(() => inp.focus(), 30);
  }
  async function saveFragPop() {
    const name = $('bp-frag-name').value;
    let morning = $('bp-frag-morning').checked;
    let evening = $('bp-frag-evening').checked;
    if (morning && evening) evening = false; // 兜底互斥
    if (fragMode === 'add') {
      const r = await api(`/api/board/${state.code}/fragment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // 新碎片落到「当前浏览的 Day」（左栏现在是分 Day 的，别都塞进 Day1）
        body: JSON.stringify({ name, morning, evening, day: state.viewDay }),
      });
      $('board-pop-frag').classList.add('hidden');
      if (r.body && r.body.ok) {
        state.board = r.body.board;
        const added = state.board.fragments[state.board.fragments.length - 1];
        if (added) state.selFrag = added.id;   // 新建后自动选中，方便接着加对话
        state.selDlg = null;
        renderAll();
        if (added) notice(`已添加碎片「${added.name}」`);
      }
      return;
    }
    const r = await api(`/api/board/${state.code}/fragment/${state.selFrag}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, morning, evening }),
    });
    $('board-pop-frag').classList.add('hidden');
    if (r.body && r.body.ok) { state.board = r.body.board; renderAll(); }
  }

  /* ---- 弹窗：添加/修改对话 ---- */
  let dlgMode = null; // 'add' | 'edit'
  let dlgDid = null;
  function findDlg(did) {
    for (const f of state.board.fragments) {
      const d = (f.dialogues || []).find((x) => x.id === did);
      if (d) return d;
    }
    return null;
  }
  function openDlgPop(mode, did) {
    dlgMode = mode; dlgDid = did || null;
    if (!state.selFrag && mode === 'add') { notice('先点左侧一个碎片'); return; }
    if (mode === 'edit') {
      const hit = findDlg(did);
      $('bp-dlg-title').textContent = '修改对话';
      $('bp-dlg-en').value = hit ? hit.en : '';
      $('bp-dlg-zh').value = hit ? (hit.zh || '') : '';
    } else {
      $('bp-dlg-title').textContent = '添加对话';
      $('bp-dlg-en').value = ''; $('bp-dlg-zh').value = '';
    }
    $('board-pop-dlg').classList.remove('hidden');
  }
  async function saveDlgPop() {
    const en = $('bp-dlg-en').value;
    const zh = $('bp-dlg-zh').value;
    let r;
    if (dlgMode === 'edit') {
      r = await api(`/api/board/${state.code}/dialogue/${dlgDid}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ en, zh, fid: state.selFrag }),
      });
    } else {
      r = await api(`/api/board/${state.code}/fragment/${state.selFrag}/dialogue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ en, zh }),
      });
    }
    $('board-pop-dlg').classList.add('hidden');
    if (r.body && r.body.ok) { state.board = r.body.board; renderAll(); }
  }

  /* ---- 弹窗：删除碎片（密码） ---- */
  function openDelPop() {
    if (!state.selFrag) { notice('先点左侧一个碎片'); return; }
    const f = state.board.fragments.find((x) => x.id === state.selFrag);
    if (!f) return;
    $('bp-del-name').textContent = f.name;
    $('bp-del-pwd').value = '';
    $('board-pop-del').classList.remove('hidden');
  }
  async function doDelete() {
    const pwd = $('bp-del-pwd').value;
    $('board-pop-del').classList.add('hidden');
    const r = await api(`/api/board/${state.code}/fragment/${state.selFrag}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pwd }),
    });
    if (r.status === 403) { notice('密码错误，未删除'); return; }
    if (r.body && r.body.ok) {
      state.board = r.body.board;
      state.selFrag = null;
      state.selDlg = null;
      renderAll();
    }
  }

  /* ---- 弹窗：删除右侧「被点选的那条对话」（右上角「删」） ---- */
  function openDelDlgPop() {
    if (!state.selDlg) { notice('先在右侧点选一条对话，再点「删」'); return; }
    const d = findDlg(state.selDlg);
    if (!d) { notice('先在右侧点选一条对话，再点「删」'); return; }
    const t = subst(d.en);
    $('bp-deldlg-text').textContent = t.length > 70 ? t.slice(0, 70) + '…' : t;
    $('board-pop-del-dlg').classList.remove('hidden');
  }
  async function doDeleteDlg() {
    $('board-pop-del-dlg').classList.add('hidden');
    const did = state.selDlg;
    if (!did) return;
    const r = await api(`/api/board/${state.code}/dialogue/${did}?fid=${encodeURIComponent(state.selFrag || '')}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    });
    if (r.body && r.body.ok) {
      state.board = r.body.board;
      state.selDlg = null;
      renderAll();
      notice('已删除这条对话');
    }
  }

  /* ---- 卡片按钮：修改/已发(恢复)/复制/发送；点卡片任意处=选中 ---- */

  /** 界面上立刻改掉这条的「已发」样子（不等后端、不发网络请求）。 */
  function applySentLocal(did, sent) {
    const d = findDlg(did);
    if (d) d.sent = !!sent;
  }

  /** 把「已发 / 恢复」记到本机（后端只写本地文件，不碰云端）。
   *  界面先变、再存；存失败就回滚 —— 绝不留「看着已发、其实没记下」的假象。 */
  async function persistSent(did, sent) {
    applySentLocal(did, sent);
    renderAll();   // 左栏 ✓ 徽章、右栏按钮一起更新
    const r = await api(`/api/board/${state.code}/dialogue/${did}/sent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sent, fid: state.selFrag }),
    });
    if (r.body && r.body.ok) return true;
    applySentLocal(did, !sent);
    renderAll();
    notice('「已发」没能存到本机：' + ((r.body && r.body.error) || r.status));
    return false;
  }

  async function onCardClick(e) {
    const card = e.target.closest('.bp-card');
    if (!card) return;
    const did = card.dataset.did;
    // 点卡片任意位置（含按钮）= 把这条设为「选中」，右上角「删」删的就是它
    if (state.selDlg !== did) {
      state.selDlg = did;
      const box = $('board-cards');
      if (box) box.querySelectorAll('.bp-card').forEach((c) => c.classList.toggle('selected', c.dataset.did === did));
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'edit') { openDlgPop('edit', did); return; }
    if (act === 'copy') {
      const d = findDlg(did);
      const txt = d ? subst(d.en) : '';
      try { await navigator.clipboard.writeText(txt); notice('英文已复制到剪贴板'); }
      catch (err) { notice('复制失败：' + ((err && err.message) || err)); }
      return;
    }
    if (act === 'sent') {
      // 「已发」= 这条我发过了；再点「恢复」= 取消。只记本机，不发任何网络请求。
      const d = findDlg(did);
      const cur = d ? !!d.sent : false;
      if (await persistSent(did, !cur)) {
        notice(cur ? '已恢复（这条变回未发）' : '已标记已发（只记本机）');
      }
      return;
    }
    if (act === 'send') {
      const d = findDlg(did);
      const en = d ? subst(d.en) : '';
      if (!en) { notice('这条没有英文内容'); return; }
      // 先复制一份到剪贴板兜底
      try { await navigator.clipboard.writeText(en); } catch (e) { /* ignore */ }
      const r = await api(`/api/board/${state.code}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did }),
      });
      if (r.body && r.body.ok) {
        const m = r.body.method;
        notice(m === 'prefill'
          ? '已打开该客户 WhatsApp 对话并预填文字，回车即发出；剪贴板也已备份'
          : (m === 'typed'
            ? '没精确定位到该客户的会话，文字已放进当前最前面的对话 —— 发送前请确认是这个客户；剪贴板也已备份'
            : '已把这段文字放进最前面的 WhatsApp 对话输入框，回车即发出；剪贴板也已备份'));
        // 预填成功后顺手记成「已发」（只写本机，绝不真发送）
        await persistSent(did, true);
      } else {
        notice('未能自动预填（' + ((r.body && r.body.reason) || '未知') + '），英文已复制到剪贴板，请手动粘贴');
      }
    }
  }

  /** 「全部已发」：把当前话题里所有对话一次标完（只记本机）。
   *  ids 由界面传（它手里就是当前看到的那几条），后端不必再去猜。 */
  async function sentAll() {
    if (!state.selFrag) { notice('先点左侧一个碎片'); return; }
    const f = state.board.fragments.find((x) => x.id === state.selFrag);
    const ids = (f ? (f.dialogues || []) : []).map((d) => d.id);
    if (!ids.length) { notice('这个话题还没有对话'); return; }
    ids.forEach((id) => applySentLocal(id, true));
    renderAll();   // 先让左栏亮出 ✓，不用等网络
    const r = await api(`/api/board/${state.code}/fragment/${state.selFrag}/sentall`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sent: true, ids }),
    });
    if (r.body && r.body.ok) {
      notice(`「${f.name}」全部标记已发（只记本机）`);
      return;
    }
    ids.forEach((id) => applySentLocal(id, false));
    renderAll();
    notice('「全部已发」没能存到本机：' + ((r.body && r.body.error) || r.status));
  }

  /* V3.7.6.1 导入段：把新增的话术碎片补进这份看板。
   * 后端是幂等的 —— 只补本地没有的 id，绝不覆盖老板改过的名字/对话，
   * 所以重复点不会有副作用，也不会有任何数据风险。 */
  async function importV376() {
    if (!state.code) { notice('先选一个客户'); return; }
    if (!window.confirm('把 V3.7.6.1 新增的话术碎片补进 ' + state.code + ' 的看板？\n\n'
      + '只会补这份看板里还没有的碎片，你改过的内容一律不动。')) return;
    const r = await api(`/api/board/${state.code}/import-v376`, { method: 'POST' });
    if (r.body && r.body.ok) {
      state.board = r.body.board;
      state.hasV376 = true;
      // 补进来的是 Day1-Day6 的碎片，把视图放回 Day1 让人一眼看到
      if (state.viewDay > 6) state.viewDay = 1;
      renderAll();
      notice(r.body.added
        ? `补进 ${r.body.added} 个新碎片（这份看板共 ${r.body.total} 个新碎片）`
        : '这份看板已经补过新话术了，没有新增');
      return;
    }
    notice('补新话术失败：' + ((r.body && r.body.error) || r.status));
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    const btnBoard = $('btn-board');
    if (btnBoard) {
      btnBoard.addEventListener('click', () => {
        if (state.code) openFor(state.code);
        else notice('先选一个客户，再开话术编排台');
      });
    }

    const closeBtn = $('board-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        if (STANDALONE) window.close();   // 独立浮窗：关掉这个窗口
        else closePanel();                // 内嵌面板：收起
      });
    }

    const addFrag = $('board-add');
    if (addFrag) addFrag.addEventListener('click', () => openFragPop('add'));
    const editFrag = $('board-edit');
    if (editFrag) editFrag.addEventListener('click', () => openFragPop('edit'));
    $('board-del').addEventListener('click', openDelPop);              // 左下角「删」= 删整个碎片（带密码）
    $('board-delfrag').addEventListener('click', openDelDlgPop);       // 右上角「删」= 删右侧被点选的那条对话
    $('board-adddlg').addEventListener('click', () => openDlgPop('add'));
    $('board-sentall').addEventListener('click', sentAll);
    $('board-cards').addEventListener('click', onCardClick);

    // V3.7.6.1 导入段：一次性把新增碎片补进这份看板（幂等，可重复点）
    const vBtn = $('board-v376');
    if (vBtn) vBtn.addEventListener('click', importV376);

    // Day 分页：上一页 / 下一页（放在右栏表头红箭头位置）
    const prevBtn = $('board-prev');
    if (prevBtn) prevBtn.addEventListener('click', () => gotoDay(state.viewDay - 1));
    const nextBtn = $('board-next');
    if (nextBtn) nextBtn.addEventListener('click', () => gotoDay(state.viewDay + 1));

    $('bp-frag-cancel').addEventListener('click', () => $('board-pop-frag').classList.add('hidden'));
    $('bp-frag-save').addEventListener('click', saveFragPop);
    const mChk = $('bp-frag-morning');
    const eChk = $('bp-frag-evening');
    if (mChk) mChk.addEventListener('change', syncFragChecks);
    if (eChk) eChk.addEventListener('change', syncFragChecks);

    $('bp-dlg-cancel').addEventListener('click', () => $('board-pop-dlg').classList.add('hidden'));
    $('bp-dlg-save').addEventListener('click', saveDlgPop);
    $('bp-del-no').addEventListener('click', () => $('board-pop-del').classList.add('hidden'));
    $('bp-del-yes').addEventListener('click', doDelete);
    const dlgDelNo = $('bp-deldlg-no');
    if (dlgDelNo) dlgDelNo.addEventListener('click', () => $('board-pop-del-dlg').classList.add('hidden'));
    const dlgDelYes = $('bp-deldlg-yes');
    if (dlgDelYes) dlgDelYes.addEventListener('click', doDeleteDlg);

    // 点弹窗遮罩空白处关闭弹窗
    ['board-pop-frag', 'board-pop-dlg', 'board-pop-del', 'board-pop-del-dlg'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('click', (ev) => { if (ev.target === el) el.classList.add('hidden'); });
    });

    // 独立浮窗：进来就把 URL 里的客户加载好
    if (STANDALONE && window.__BOARD_CODE__) loadInto(window.__BOARD_CODE__);
  }

  window.Board = { openFor, syncFor, close: closePanel, reload, loadInto };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
