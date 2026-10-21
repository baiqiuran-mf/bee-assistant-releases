/**
 * 一次性真实诊断：复用**已登录的** Telegram 会话（partition: persist:tg-tele-7）
 * 开一个离屏 BrowserWindow，真实加载 web.telegram.org/k/，把气泡/列表的真实 DOM 结构抓下来。
 *
 * 🔴 只读：全程只 querySelector / getAttribute，不点任何按钮、不发任何消息。
 * 🔴 为什么必须这么干：老板截图里的真实网页版 Telegram 是新版版式，
 *    之前那套 `[data-mid]` / `.bubble` 选择器全部命中 0 —— 光靠读源码猜不出来，
 *    必须拿真实页面结构当硬证据。
 *
 * 用法（在能起 GUI 的 Windows 上）：
 *   node_modules\electron\dist\electron.exe tools\diag-tg-dom.js
 * 结果落盘：.tmp-tg-dom.json
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, session } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-tg-dom.json');
const PARTITION = 'persist:tg-tele-7';
const URL = 'https://web.telegram.org/k/';

/* 🔴 关键：必须用**软件那份 userData**，否则 cookies 的加密密钥对不上 → 读出来是未登录。
   （开发模式运行时 Electron 的 userData 默认就在 %APPDATA%\wa-assistant；打包后也是同一个。）*/
const USER_DATA = process.env.BEE_USER_DATA
  || path.join(process.env.APPDATA || '', 'wa-assistant');
if (fs.existsSync(USER_DATA)) app.setPath('userData', USER_DATA);
console.log('[userData] ' + app.getPath('userData'));

/** 在页面里跑的取证脚本：只读，输出真实结构 */
function grabDom() {
  const SEL = {
    chatItem: ['a.chatlist-chat', '[data-peer-id]', 'a[href^="#"]'],
    bubble: [
      '[data-mid]', '.bubble', '.Message', '.message',
      '.bubbles > *', '.MessageBubble', '.message-content', '.msg',
      '[class*="bubble"]', '[class*="message"]',
    ],
    text: ['.text', '.text-content', '.message-content .text', '[data-text]', '.text-message'],
    title: ['.peer-title', '.chat-header .title', '.chat-info .title', '.topbar .title', '[data-peer-title]'],
    badge: ['.chat-badge', '[class*="badge"]'],
  };
  const all = (s) => { try { return Array.prototype.slice.call(document.querySelectorAll(s)); } catch (e) { return []; } };
  const txt = (e) => (e && e.textContent ? String(e.textContent).trim() : '');
  const cls = (e) => String((e && e.className) || '').slice(0, 120);

  const out = { url: location.href, title: document.title, hash: location.hash };
  out.ids = all('[id]').map((e) => e.id).filter(Boolean).slice(0, 80);

  // 每个候选选择器命中多少
  out.counts = {};
  const ALLSEL = [
    'a.chatlist-chat', '.chatlist-chat', '[data-peer-id]', '#column-left', '.column-left',
    'ul.chatlist', '.chatlist', '.chatlist-container', '.chats-container', '#MiddleColumn',
    '[data-mid]', '.bubble', '.bubbles', '.Message', '.message', '.MessageBubble',
    '.message-content', '.msg', '.text-content', '.peer-title', '.chat-badge',
    '.chat-badge-transition', '.input-message-input', '.new-message-wrapper',
    '[class*="bubble"]', '[class*="message"]', '[class*="Bubble"]', '[class*="Message"]',
  ];
  for (const s of ALLSEL) { try { out.counts[s] = document.querySelectorAll(s).length; } catch (e) { out.counts[s] = -1; } }

  // 逐个祖先链找「真正的消息元素」：先广撒网，再对每个候选打印结构
  out.candidates = {};
  for (const s of SEL.bubble) {
    const els = all(s);
    if (!els.length) continue;
    out.candidates[s] = els.slice(-6).map((e) => {
      const chain = [];
      let n = e;
      for (let i = 0; n && i < 5; i++, n = n.parentElement) {
        chain.push({ tag: n.tagName, cls: cls(n), id: n.id || '', mid: n.getAttribute('data-mid') || '' });
      }
      const tEl = SEL.text.map((x) => e.querySelector(x)).find((x) => x && txt(x));
      return {
        ownMid: e.getAttribute('data-mid') || '',
        ownCls: cls(e),
        text: txt(e).slice(0, 80),
        textFrom: tEl ? (SEL.text.find((x) => e.querySelector(x) === tEl) || '') : '',
        chain,
      };
    });
  }

  // 聊天列表样本
  out.chatSamples = (SEL.chatItem[0] ? all(SEL.chatItem[0]) : all('[data-peer-id]')).slice(0, 6).map((e) => ({
    href: e.getAttribute('href') || '',
    pid: e.getAttribute('data-peer-id') || '',
    cls: cls(e),
    txt: txt(e).replace(/\n/g, ' | ').slice(0, 70),
  }));

  /* 🔴 气泡结构取证：光靠选择器猜不行，要把**消息容器里真实的元素**抓出来。
     做法：找到中间列（#column-center）里那个装消息的滚动容器，
     打印它下面第2~4 层的子元素 tag/class/属性 —— 那就是气泡真正的样子。*/
  out.bubbleProbe = {};
  const center = document.querySelector('#column-center') || document.querySelector('.column-center');
  out.bubbleProbe.centerFound = !!center;
  if (center) {
    const walk = (node, depth, max) => {
      const kids = Array.prototype.slice.call(node.children || []);
      const rows = kids.map((k) => ({
        depth,
        tag: k.tagName,
        cls: cls(k),
        dataMid: k.getAttribute('data-mid') || '',
        dataPeer: k.getAttribute('data-peer-id') || '',
        attrs: Array.prototype.slice.call(k.attributes || []).map((a) => a.name).slice(0, 12),
        txt: txt(k).replace(/\s+/g, ' ').slice(0, 50),
      }));
      if (depth < max && kids.length) {
        // 找子元素最多的那一个（消息列表容器）继续往下钻
        const rich = kids.slice().sort((a, b) => (b.children.length) - (a.children.length))[0];
        if (rich && rich.children.length > kids.length) rows.push({ ...walk(rich, depth + 1, max), __branch: 'richest' });
      }
      return rows;
    };
    out.bubbleProbe.tree = walk(center, 1, 5).slice(0, 40);
  }
  // 反向取证：把所有「class里带message/bubble/text」的元素连同祖先一起列出来
  const anyMsg = all('[class*="message" i], [class*="bubble" i], [class*="text" i]');
  out.bubbleProbe.anyMsgCount = anyMsg.length;
  out.bubbleProbe.anyMsg = anyMsg.slice(-25).map((e) => {
    const chain = [];
    let n = e;
    for (let i = 0; n && i < 4; i++, n = n.parentElement) {
      chain.push({ tag: n.tagName, cls: cls(n).slice(0, 80), mid: n.getAttribute('data-mid') || '' });
    }
    return { ownCls: cls(e), txt: txt(e).slice(0, 40), chain };
  }).filter((r) => r.txt);

  out.headerTitle = SEL.title.map((s) => { const e = document.querySelector(s); return e ? txt(e).slice(0, 40) : ''; }).filter(Boolean)[0] || '';

  /* 🔴 兜底取证：把中间列**整个 innerHTML 前 6000 字**原样带回来。
     气泡选择器该用什么，不能靠猜 —— 直接看 Telegram 自己吐出来的标签长什么样。*/
  try {
    const cc = document.querySelector('#column-center');
    if (cc) {
      out.centerHtml = cc.innerHTML.replace(/\s+/g, ' ').slice(0, 6000);
      out.centerChildren = Array.prototype.slice.call(cc.children).map((k) => ({
        tag: k.tagName, cls: cls(k), id: k.id || '',
        kidCount: (k.children || []).length,
        kidCls: Array.prototype.slice.call(k.children || []).slice(0, 12).map((c) => c.tagName + '.' + cls(c).slice(0, 40)),
      }));
    }
  } catch (e) { out.centerHtml = 'ERR ' + (e && e.message); }

  // 全页面：带 data-* 自定义属性的元素（气泡的稳定锚点通常在这类属性上）
  out.dataAttrs = {};
  const withData = all('[data-mid],[data-peer-id],[data-message-id],[data-msg-id],[data-bubble],[data-testid]');
  const seen = {};
  for (const e of withData) {
    for (const a of (e.attributes || [])) {
      if (a.name.indexOf('data-') !== 0) continue;
      const k = a.name;
      seen[k] = seen[k] || { count: 0, sample: '' };
      if (seen[k].count < 4) seen[k].sample += String(a.value).slice(0, 24) + ' | ';
      seen[k].count++;
    }
  }
  out.dataAttrs = seen;

  /* 🔴 关键发现（实测）：新版 Telegram Web K 的**消息区不在 #column-center 里**——
     那里只有 chats-container / pinned-*。必须全页面扫「谁装了最多消息文本」。
     这一步就是把选择器定死的硬证据，不再靠猜。*/
  out.columnScan = all('#column-center, #column-left, #column-right, [class*="column"]').map((c) => ({
    id: c.id, cls: cls(c).slice(0, 50),
    kidCount: (c.children || []).length,
    txtLen: txt(c).length,
    txt: txt(c).replace(/\s+/g, ' ').slice(0, 90),
  }));

  // 全页面里，谁的文字最多 / 谁最可能是消息列表
  const containers = all('#column-center *, #column-left *, body div').filter((e) => (e.children || []).length >= 2);
  const scored = containers.map((e) => {
    const t = txt(e);
    return { e, n: t.length };
  }).filter((x) => x.n > 30 && x.n < 4000).sort((a, b) => b.n - a.n).slice(0, 6);
  out.textRichest = scored.map((x) => {
    const kids = Array.prototype.slice.call(x.e.children).slice(0, 8).map((k) => ({
      tag: k.tagName, cls: cls(k).slice(0, 60),
      mid: k.getAttribute('data-mid') || '',
      attrs: Array.prototype.slice.call(k.attributes || []).map((a) => a.name).slice(0, 10),
      txt: txt(k).replace(/\s+/g, ' ').slice(0, 40),
    }));
    return { tag: x.e.tagName, id: x.e.id, cls: cls(x.e).slice(0, 70), textLen: x.n, kids };
  });
  /* 🔴 实测拦路虎（2026-10-13）：登录后 Telegram 会弹一条
     「Someone just got access to your messages!」安全警告横幅。
     它会把 #column-right 标成 inert、消息区根本不渲染 → [data-mid] / .bubble 全是 0。
     （之前误判成「气泡选择器失效」，真因是这个横幅挡着。）
     这里只读不点：先看横幅原文与结构，交给人来决定要不要关。*/
  try {
    const warn = all('*').filter((e) => /got access to your messages/i.test(txt(e)))[0];
    out.securityBanner = warn ? {
      tag: warn.tagName, cls: cls(warn).slice(0, 60),
      txt: txt(warn).replace(/\s+/g, ' ').slice(0, 160),
      buttons: Array.prototype.slice.call(warn.querySelectorAll('button')).map((b) => txt(b)).filter(Boolean),
    } : null;
    out.columnRightInert = !!document.querySelector('#column-right[inert]');
    out.columnCenterInert = !!document.querySelector('#column-center[inert]');
  } catch (e) { out.securityBanner = 'ERR'; }

  return out;
}

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  // 🔴 关键：复用软件那份已登录的会话，登录态不用重扫
  const ses = session.fromPartition(PARTITION, { cache: true });
  const w = new BrowserWindow({
    width: 1400, height: 900,
    // 🔴 必须 show:true —— Telegram 的消息区是**虚拟滚动列表**，窗口不可见时根本不渲染，
    //   实测 show:false 时 hash 已经切到 #7207229390，但 [data-mid] / .bubble 全是 0。
    show: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  w.webContents.on('console-message', (_e, _l, m) => {
    if (/error|ERR_/i.test(String(m))) console.log('[page]', String(m).slice(0, 160));
  });
  try {
    await w.loadURL(URL);
  } catch (e) {
    console.log('[load failed]', (e && e.message) || e);
  }
  // 给 Telegram 足够时间渲染（首次加载慢）
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    let probe = {};
    try { probe = await w.webContents.executeJavaScript('({hash:location.hash,title:document.title,mid:document.querySelectorAll("[data-mid]").length,bub:document.querySelectorAll(".bubble").length})'); }
    catch (e) { probe = { err: String((e && e.message) || e) }; }
    console.log(`[wait ${(i + 1) * 5}s]`, JSON.stringify(probe));
    // 登录页就别等了
    try {
      const login = await w.webContents.executeJavaScript('!!(document.querySelector(".login-form")||document.querySelector("#sign-in-pages")||document.querySelector("#auth-pages")||document.querySelector("input[name=\\"phone\\"]"))');
      if (login) { console.log('[停在登录页 —— 说明这份会话已过期]'); break; }
    } catch (_) {}
  }
  let dom = {};
  /* 🔴 关键：必须**先真实打开一个对话**，否则中间列是空的、气泡一条都抓不到
     —— 之前的版本就是停在列表页就抓，所以才得出「气泡选择器全部命中 0」的错误结论。
     用 location.hash 直接切（虚拟列表 click 不一定触发路由，这是实测最稳的方式）。*/
  try {
    const opened = await w.webContents.executeJavaScript(`(function(){
      var items = document.querySelectorAll('a.chatlist-chat');
      for (var i = 0; i < items.length; i++) {
        var t = (items[i].textContent || '').trim();
        if (t.indexOf('Telegram') === 0) continue;
        var pid = items[i].getAttribute('data-peer-id') || '';
        location.hash = '#' + pid;
        return 'hash:' + pid + ' : ' + t.slice(0,30);
      }
      return 'no-item';
    })()`);
    console.log('[open chat] ' + opened);
  } catch (e) { console.log('[open chat failed]', (e && e.message) || e); }
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const st = await w.webContents.executeJavaScript('({hash:location.hash, mid:document.querySelectorAll("[data-mid]").length, bub:document.querySelectorAll(".bubble").length, msgs:document.querySelectorAll(".Message").length})');
      console.log(`[after-open ${(i + 1)}]`, JSON.stringify(st));
      if (st.mid || st.bub || st.msgs) break;
    } catch (_) {}
  }

  /* 🔴 实测拦路虎（2026-10-13）：登录后Telegram 弹一条安全确认
     「Someone just got access to your messages!→ Yes, it’s me / No, it’s not me!」。
     这是一条**模态 service message**：#column-center 虽是 1352px 宽，里面却只有 pinned 条，
     消息区根本没渲染 → [data-mid] / .bubble 全部命中 0。
     （之前误判成「气泡选择器失效」，真因是这个模态弹窗挡着。）
     为了抓真实气泡，这里点掉它——只关 Telegram 自己的提示框，不碰本软件业务、不发任何消息。*/
  try {
    const dismissed = await w.webContents.executeJavaScript(`(function(){
      var log = [];
      for (var round = 0; round < 4; round++) {
        var clicked = 0;
        var all = Array.prototype.slice.call(document.querySelectorAll('button, .btn, [role="button"]'));
        for (var i = 0; i < all.length; i++) {
          var t = (all[i].textContent||'').trim();
          if (/^(Yes,\s*it|Continue|OK|Got it)$/i.test(t) ||
              /it.{0,3}s me/i.test(t)) {
            all[i].click(); clicked++; log.push('closed:' + t);
          }
        }
        if (!clicked) break;
      }
      // 兜底：直接把模态容器从 DOM 里摘掉（只影响这一次诊断窗口，登录态不受影响）
      var forced = 0;
      Array.prototype.slice.call(document.querySelectorAll('.dialog, .dialog-container, [class*="dialog"]')).forEach(function(d){
        var txt = (d.textContent||'');
        if (/got access to your messages/i.test(txt) && d.offsetParent !== null) { d.remove(); forced++; }
      });
      if (forced) log.push('forced-removed:' + forced);
      return log.join(' ; ') || 'no-banner';
    })()`);
    console.log('[security banner] ' + dismissed);
    await new Promise((r) => setTimeout(r, 3000));
  } catch (e) { console.log('[banner dismiss failed]', (e && e.message) || e); }

  /* 🔴 inert 到底在谁身上？新版 K 版把消息区放在**中列**（#column-center），
     而 #column-right 是「资料侧栏」。谁 inert、谁有消息，一次问清楚，别再猜。*/
  try {
    const where = await w.webContents.executeJavaScript(`(function(){
      var q = function(s){ try { return document.querySelector(s); } catch(e){ return null; } };
      var info = function(s){
        var e = q(s); if (!e) return s + ' = MISSING';
        var r = e.getBoundingClientRect();
        return s + ' inert=' + (e.hasAttribute('inert')?'Y':'n')
          + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height)
          + ' kids=' + e.children.length
          + ' txt=' + (e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,60);
      };
      return [
        info('#column-left'), info('#column-center'), info('#column-right'),
        'querySelectorAll(#column-center .bubble)=' + document.querySelectorAll('#column-center .bubble').length,
        'any .bubble=' + document.querySelectorAll('.bubble').length,
        'any [data-mid]=' + document.querySelectorAll('[data-mid]').length,
        'html.has-dialog=' + !!document.querySelector('.dialog, .dialog-container, [class*="dialog"]'),
        'dialogs=' + document.querySelectorAll('.dialog, .dialog-container, [class*="dialog"]').length,
      ].join('\\n');
    })()`);
    console.log('[where] ' + where);
  } catch (e) { console.log('[where failed]', (e && e.message) || e); }

  // 横幅关掉后**重新**打开一次对话，确保消息区这次真的渲染出来
  try {
    const re = await w.webContents.executeJavaScript(`(function(){
      var items = document.querySelectorAll('a.chatlist-chat');
      for (var i = 0; i < items.length; i++) {
        var t = (items[i].textContent || '').trim();
        if (t.indexOf('Telegram') === 0) continue;
        location.hash = '#' + (items[i].getAttribute('data-peer-id')||'');
        return 'reopen:' + (items[i].getAttribute('data-peer-id')||'');
      }
      return 'no-item';
    })()`);
    console.log('[reopen] ' + re);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const st = await w.webContents.executeJavaScript('({mid:document.querySelectorAll("[data-mid]").length,bub:document.querySelectorAll(".bubble").length,inert:!!document.querySelector("#column-right[inert]")})').catch(() => ({}));
      console.log(`[reopen-wait ${(i + 1)}]`, JSON.stringify(st));
      if (st.mid || st.bub) break;
    }
  } catch (e) { console.log('[reopen failed]', (e && e.message) || e); }

  try { dom = await w.webContents.executeJavaScript(`(${grabDom.toString()})()`); }
  catch (e) { dom = { grabError: String((e && e.message) || e) }; }
  try { fs.writeFileSync(OUT, JSON.stringify(dom, null, 2), 'utf8'); console.log('\n[saved] ' + OUT); }
  catch (e) { console.log('[save failed]', e.message); }
  console.log(JSON.stringify(dom, null, 2).slice(0, 12000));
  w.destroy();
  app.exit(0);
}).catch((e) => { console.log('fatal', (e && e.stack) || e); app.exit(1); });