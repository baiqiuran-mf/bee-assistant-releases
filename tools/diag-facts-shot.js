/* 抓「通用」中栏顶部资料卡的**真实渲染截图**（不是手画 SVG）
   —— 目的：Tele① 右侧资料卡要照它那一套排版，必须先有真图当依据。
   做法：Electron 加载真实 index.html → 注入 renderChatHead 生成的同结构 HTML
        → capturePage 截 .ch-facts / #chat-head 真实像素。 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-facts-shot.png');
const PARTITION = 'persist:tg-tele-7';

// renderChatHead() 里那段 .ch-facts 的**同结构** HTML（只把数据换成截图里那个客户）
const FACTS_HTML = `
<div class="fact-row">
  <span class="fact-cell"><span class="fact"><b class="fact-joined">加入时间</b> 10-13 00:46</span></span>
  <span class="fact-cell fact-cell-right">
    <span class="fact fact-know"><i class="star">★</i><i class="sub-fact sub-joined">认识<span class="day-num">第 1 天</span></i><i class="star">★</i></span>
    <b class="fact-day">Day 1</b>
  </span>
</div>
<div class="fact-row">
  <span class="fact-cell"><span class="fact"><b class="fact-region">地区</b> <span class="fact-empty">未填</span></span></span>
  <span class="fact-cell fact-cell-right">
    <span class="fact"><b class="fact-loc">客户当地时间</b> <span>—</span><i class="sub-fact">（在右栏填了时区就会显示）</i></span>
  </span>
</div>`;

const HEAD_HTML = `
<div class="ch-top">
  <div class="ch-name">
    <span class="code">7A00001</span><span class="name-label">名称:</span><span class="cname">Xue</span>
  </div>
  <div class="ch-doc-col">
    <button id="ch-jump" class="ch-jump">↗ 跳到聊天</button>
    <button id="ch-doc" class="ch-doc">客户档案</button>
    <button id="ch-extract" class="ch-extract">从对话里提取档案</button>
  </div>
</div>
<div class="ch-facts">${FACTS_HTML}</div>`;

(async () => {
  await app.whenReady();
  const w = new BrowserWindow({
    width: 1000, height: 420, show: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  const file = 'file:///' + path.join(ROOT, 'public', 'index.html').replace(/\\/g, '/');
  await w.loadURL(file);
  await new Promise((r) => setTimeout(r, 3500));

  // file:// 下 /style.css 这种根路径拿不到（实测全是无样式黑字），
  // 所以把真实的 style.css 整份注进去，抓到的才是**真实排版像素**。
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  await w.webContents.executeJavaScript(`(function(){
    var st = document.createElement('style');
    st.textContent = ${JSON.stringify(css)};
    document.head.appendChild(st);
    return 'css-injected:' + st.textContent.length;
  })()`).then((r) => console.log('[css] ' + r));
  await new Promise((r) => setTimeout(r, 600));

  // 把真实结构塞进 chat-head
  const ok = await w.webContents.executeJavaScript(`(function(){
    // 登录浮层会盖住整个界面（实测截图全是它），先全隐藏掉
    document.querySelectorAll('#boot, #boot-overlay, .boot, .boot-overlay, #login-mask, .modal-backdrop, .overlay')
      .forEach(function(n){ n.style.display='none'; });
    var h = document.getElementById('chat-head');
    if (!h) return 'no #chat-head';
    h.innerHTML = ${JSON.stringify(HEAD_HTML)};
    h.style.display = 'block';
    h.style.visibility = 'visible';
    return 'injected';
  })()`);
  console.log('[inject] ' + ok);
  await new Promise((r) => setTimeout(r, 1200));

  // 量一下真实盒子尺寸，供后续改动对照
  const box = await w.webContents.executeJavaScript(`(function(){
    var h = document.getElementById('chat-head');
    var f = h.querySelector('.ch-facts');
    var cs = f ? getComputedStyle(f) : null;
    return JSON.stringify({
      headW: h.getBoundingClientRect().width,
      headH: h.getBoundingClientRect().height,
      factsW: f ? f.getBoundingClientRect().width : 0,
      factsH: f ? f.getBoundingClientRect().height : 0,
      fs: cs && cs.fontSize, fw: cs && cs.fontWeight,
      bg: cs && cs.backgroundColor, radius: cs && cs.borderRadius,
      joined: (h.querySelector('.fact-joined') || {}).textContent,
      colJoined: cs && getComputedStyle(h.querySelector('.fact-joined')).color,
      colRegion: getComputedStyle(h.querySelector('.fact-region')).color,
      colLoc: getComputedStyle(h.querySelector('.fact-loc')).color,
      colDay: getComputedStyle(h.querySelector('.fact-day')).color,
      colDayNum: getComputedStyle(h.querySelector('.day-num')).color,
      colStar: getComputedStyle(h.querySelector('.star')).color,
      colNameLabel: getComputedStyle(h.querySelector('.name-label')).color,
      colCode: getComputedStyle(h.querySelector('.code')).color,
      colCname: getComputedStyle(h.querySelector('.cname')).color,
    });
  })()`);
  console.log('[box] ' + box);

  const img = await w.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('[saved] ' + OUT);

  // 第二张：把 #chat-head 单独裁出来（尺寸放宽到中栏真实宽度，看清排版细节）
  const wide = new BrowserWindow({
    width: 900, height: 500, show: false,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  await wide.loadURL(file);
  await new Promise((r) => setTimeout(r, 2500));
  await wide.webContents.executeJavaScript(`(function(){
    var st = document.createElement('style');
    st.textContent = ${JSON.stringify(css)};
    document.head.appendChild(st);
    // 只留 chat-head，其它全藏掉，专心看这一块的排版
    document.querySelectorAll('body > *:not(#app), #app > *:not(#mid)').forEach(function(n){ n.style.display='none'; });
    var mid = document.getElementById('mid'); if (mid) mid.style.display='block';
    var h = document.getElementById('chat-head');
    h.innerHTML = ${JSON.stringify(HEAD_HTML)};
    h.style.display='block'; h.style.visibility='visible';
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 1000));
  const clip = await wide.webContents.executeJavaScript(`(function(){
    var r = document.getElementById('chat-head').getBoundingClientRect();
    return { x: Math.max(0,Math.floor(r.x)), y: Math.max(0,Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  })()`);
  console.log('[clip] ' + JSON.stringify(clip));
  const img2 = await wide.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, '.tmp-facts-card.png'), img2.toPNG());
  console.log('[saved2] .tmp-facts-card.png');
  wide.destroy();

  w.destroy();
  app.quit();
})().catch((e) => { console.error('[fail]', e); app.quit(); });
