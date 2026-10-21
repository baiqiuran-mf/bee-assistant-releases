/* 主窗口全界面截图（老板点名要）。
 * 真HTTP 环境加载真 index.html + 真 app.js + 真 style.css，逐个界面切过去截。
 * 🔴 只读诊断：不改任何产品代码，只在诊断窗口里填假数据让界面有内容可看。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PORT = 8798;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* 🔴 假数据：只用来看排版，不落库、不写任何文件。 */
const FAKE = {
  state: {
    customers: [
      { code: '1A00004', name: 'Mark', channel: 'whatsapp', phone: '+14155550141', region: 'Texas, US', timezone: 'America/Chicago', created_at: '2026-10-08T09:12:00', unread: 3, wa_jid: '14155550141@c.us' },
      { code: '1A00003', name: 'Sophie', channel: 'whatsapp', phone: '+33612345678', region: 'Paris, FR', timezone: 'Europe/Paris', created_at: '2026-10-09T14:30:00', unread: 2, wa_jid: '33612345678@s.whatsapp.net' },
      { code: '7A00002', name: 'Eileen Lin', channel: 'telegram', region: 'Singapore', timezone: 'Asia/Singapore', created_at: '2026-10-10T08:00:00', unread: 1 },
      { code: '7A00001', name: 'Xue', channel: 'telegram', region: 'Beijing, CN', timezone: 'Asia/Shanghai', created_at: '2026-10-13T00:46:00', unread: 5 },
      { code: '5A00007', name: 'Daniel', channel: 'whatsapp', phone: '+447700900123', region: 'London, UK', timezone: 'Europe/London', created_at: '2026-10-11T11:05:00', unread: 0, wa_jid: '447700900123@c.us' },
    ],
    activeCode: '1A00004',
    stats: {},
  },
};

const SHOTS = [
  { file: '.tmp-ui-1-general.png', tab: 'general', fillGen: true, title: '① 通用（客户对话 + 回复建议）' },
  { file: '.tmp-ui-2-tele1.png', tab: 'tele1', fillGen: true, title: '② Tele①（Telegram 内置浏览器）' },
  { file: '.tmp-ui-3-wa1.png', tab: 'wa1', title: '③ WA①（WhatsApp 内置浏览器 · 新增）' },
  { file: '.tmp-ui-4-wa1-card.png', tab: 'wa1', fillWa: true, title: '④ WA① 挂上客户资料卡 + 对话信息' },
  { file: '.tmp-ui-5-profile.png', tab: 'general', fillGen: true, modal: true, title: '⑤ 客户档案弹窗（16 项）' },
  { file: '.tmp-ui-6-rpanel.png', tab: 'general', fillGen: true, rpanel: 'ft', title: '⑥ 右栏 · 手动自由翻译' },
  { file: '.tmp-ui-7-max.png', tab: 'wa1', max: true, fillWa: true, title: '⑦ WA① 主窗口最大化（红框封顶 550px）' },
];

(async () => {
  await app.whenReady();
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(PUB, p.replace(/^\/+/, ''));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  console.log('[server] ' + PORT);

  const w = new BrowserWindow({ width: 1500, height: 940, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await w.loadURL(`http://127.0.0.1:${PORT}/index.html`);
  await new Promise((r) => setTimeout(r, 3000));

  // 隐藏登录浮层（软件本来就有，挡住就看不见里面）
  const bootKill = await w.webContents.executeJavaScript(`(function(){
    var n=0;
    document.querySelectorAll('div').forEach(function(d){
      if (getComputedStyle(d).position==='fixed' && d.offsetWidth>300 && d.innerHTML.indexOf('登录并加载')>=0){ d.style.display='none'; n++; }
    });
    return n;
  })()`);
  console.log('[hide-boot] ' + bootKill);

  // 灌假数据：让左栏/今日消息有内容（只改内存里的 state，不落库）
  await w.webContents.executeJavaScript(`(function(){
    var FAKE = ${JSON.stringify(FAKE)};
    try { state.customers = FAKE.state.customers; state.activeCode = FAKE.state.activeCode; } catch(e){}
    try { paintCustomers(); } catch(e){}
    try { renderToday && renderToday([]); } catch(e){}
    return 'ok';
  })()`);

  for (const s of SHOTS) {
    await w.webContents.executeJavaScript(`(function(){
      try { document.body.classList.toggle('win-max', ${!!s.max}); } catch(e){}
      try { switchMidTab('${s.tab}'); } catch(e){}
      // 关掉上一个可能开着的弹窗
      document.querySelectorAll('#pf-modal').forEach(function(m){ m.classList.add('hidden'); });
      return 1;
    })()`);
    await new Promise((r) => setTimeout(r, 700));

    if (s.fillGen) {
      // 「通用」中栏：后端没起拿不到数据，直接按真结构造 DOM 让老板看清排版（只改内存，不落库）
      await w.webContents.executeJavaScript(`(function(){
        var head = document.getElementById('chat-head');
        if (head) {
          head.innerHTML =
            '<div class="ch-top"><span class="ch-name">Mark</span>' +
            '<span class="name-label"> 1A00004 </span></div>' +
            '<div class="ch-facts">' +
              '<div class="fact-cell"><span class="fact-k">加入时间</span><span class="fact-v">10-08 09:12</span></div>' +
              '<div class="fact-cell"><span class="fact-k">认识第几天</span><span class="fact-v day">第 6 天</span></div>' +
              '<div class="fact-cell"><span class="fact-k">客户当地时间</span><span class="fact-v">10-13 04:59</span></div>' +
              '<div class="fact-cell"><span class="fact-k">阶段</span><span class="fact-v">初次咨询</span></div>' +
              '<div class="fact-cell"><span class="fact-k">地区</span><span class="fact-v">Texas, US</span></div>' +
              '<div class="fact-cell"><span class="fact-k">时差</span><span class="fact-v">UTC-5</span></div>' +
            '</div>';
        }
        var msgs = document.getElementById('msgs');
        if (msgs) {
          function row(dir, en, zh) {
            return '<div class="crow ' + dir + '"><div class="bubble">' + en +
              (zh ? '<div class="zh">' + zh + '</div>' : '') + '</div></div>';
          }
          msgs.innerHTML =
            row('in',  'Hi, I would like another painting of my dog.', '你好，我还想要一幅我家狗的画像。') +
            row('in',  'Could it be a pair with the previous one?', '能跟上一张配成一对吗？') +
            row('out', 'Of course. Would you like the same size as the last one?', '当然可以。你想要和上一张一样的尺寸吗？') +
            row('in',  'Great, same size then. Thank you!', '好的，就一样大。谢谢你！');
          msgs.scrollTop = msgs.scrollHeight;
        }
        var sub = document.getElementById('chat-sub');
        if (sub) sub.textContent = 'Texas, US · 今天 3 条';
        return 'ok';
      })()`);
      await new Promise((r) => setTimeout(r, 400));
    }

    if (s.fillWa) {
      await w.webContents.executeJavaScript(`(function(){
        var FAKE = ${JSON.stringify(FAKE)};
        var c = FAKE.state.customers[0];
        try { wa1ActiveCode = c.code; renderWaProfileRaw(c); } catch(e){}
        // 对话信息：直接造 DOM，不走后端
        var box = document.getElementById('wa1-convinfo-body');
        if (box) {
          box.innerHTML = [
            ['你好，我还想要一幅我家狗的画像，能跟上一张配成一对吗？','Hi, I would like another painting of my dog, could it be a pair with the previous one?'],
            ['当然可以。你想要和上一张一样的尺寸吗？','Of course. Would you like the same size as the last one?'],
            ['好的，就一样大。谢谢你！','Great, same size then. Thank you!']
          ].map(function(p){ return '<div class="tv-msg"><div class="tv-zh">'+p[0]+'</div><div class="tv-en">'+p[1]+'</div></div>'; }).join('');
          box.scrollTop = box.scrollHeight;
        }
        return 'ok';
      })()`);
      await new Promise((r) => setTimeout(r, 400));
    }

    if (s.modal) {
      // 后端没起 → 档案弹窗拉不到数据。直接调真的渲染函数灌一份样例进去，让老板看清 16 项真排版。
      await w.webContents.executeJavaScript(`(function(){
        try {
          // 🔴 真结构：renderProfile 要的是 { customer, duplicates, autoTimezone }（app.js:1417）
          renderProfile({
            customer: {
              code:'1A00004', name:'Mark', phone:'+14155550141', region:'Texas, US',
              timezone:'-13', created_at:'2026-10-08T09:12:00', created_at_source:'auto',
              profile_json: JSON.stringify({
                marital:'已婚，一个女儿 6 岁', alias:'朋友都叫他 Mark',
                hometown:'Austin, Texas', hobbies:'跑步、狗狗、烧烤', job:'软件工程师',
                family_economy:'收入稳定，双收入家庭', parents:'父母住在同州',
                pets:'金毛 Ruby，13 岁', children:'女儿 6 岁，很喜欢动物',
                routine:'早上 7 点上班，晚上 10 点后回消息',
              }),
            },
            duplicates: [],
            autoTimezone: 'America/Chicago',
          });
        } catch (e) { return 'renderProfile-threw: ' + (e && e.message); }
        var m = document.getElementById('pf-modal');
        if (!m) return 'no-modal';
        m.classList.remove('hidden');
        var t = document.getElementById('pf-title');
        if (t) t.textContent = '客户档案 · 1A00004 Mark';
        // 弹窗默认可能矮，撑到 860px 让 16 项全露出来
        var box = m.querySelector('.modal-box');
        if (box) { box.style.maxHeight = '860px'; box.style.height = '860px'; }
        var body = document.getElementById('pf-body');
        if (body) { body.style.flex = '1 1 auto'; body.style.minHeight = '0'; body.style.overflowY = 'auto'; }
        var n = m.querySelectorAll('#profile input, #profile textarea, #profile select').length;
        return JSON.stringify({ fields: n });
      })()`).then((s2) => console.log('[profile-fields] ' + s2));
      await new Promise((r) => setTimeout(r, 900));
    }

    if (s.rpanel) {
      await w.webContents.executeJavaScript(`(function(){
        try { switchPanelTab('${s.rpanel}'); } catch(e){}
        var t = document.querySelector('.ft-input');
        if (t) t.value = '好的，就一样大。谢谢你！';
        var o = document.getElementById('ft-out');
        if (o) o.innerHTML = '<div class="ft-card"><div class="ft-zh">Great, same size then. Thank you!</div></div>';
        return 'ok';
      })()`);
      await new Promise((r) => setTimeout(r, 500));
    }

    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(ROOT, s.file), img.toPNG());
    const w2 = await w.webContents.executeJavaScript(`(function(){
      var a = document.querySelector('.mid-pane[data-mp="wa1"] .tg-conv-aside');
      var g = document.querySelector('.mid-pane[data-mp="tele1"] .tg-conv-aside');
      var f = g ? getComputedStyle(g).flexBasis : '';
      return JSON.stringify({ waAside: a?Math.round(a.getBoundingClientRect().width):0, teleAsideFlex: f,
        teleBtnRows: (function(){var bs=document.querySelectorAll('.mid-pane[data-mp="tele1"] .tv-actions .tv-btn');
          if(!bs.length) return 0; var t=bs[0].getBoundingClientRect().top, r=0;
          bs.forEach(function(b){ if(Math.abs(b.getBoundingClientRect().top-t)>4) r++; }); return r+1;})() });
    })()`);
    console.log(`[saved] ${s.title}  ${s.file}  ${w2}`);
  }

  // 真实最大化窗口（不是加个 class 蒙混）：1920x1080 实屏尺寸，验证红框 550px 封顶
  const w2 = new BrowserWindow({ width: 1920, height: 1040, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await w2.loadURL(`http://127.0.0.1:${PORT}/index.html`);
  await new Promise((r) => setTimeout(r, 3000));
  await w2.webContents.executeJavaScript(`(function(){
    document.querySelectorAll('div').forEach(function(d){
      if (getComputedStyle(d).position==='fixed' && d.offsetWidth>300 && d.innerHTML.indexOf('登录并加载')>=0) d.style.display='none';
    });
    try { state.customers = ${JSON.stringify(FAKE)}.state.customers; paintCustomers(); } catch(e){}
    try { switchMidTab('wa1'); } catch(e){}
    var c = ${JSON.stringify(FAKE)}.state.customers[0];
    try { wa1ActiveCode = c.code; renderWaProfileRaw(c); } catch(e){}
    var box = document.getElementById('wa1-convinfo-body');
    if (box) box.innerHTML = '<div class="tv-msg"><div class="tv-zh">你好，我还想要一幅我家狗的画像，能跟上一张配成一对吗？</div><div class="tv-en">Hi, I would like another painting of my dog, could it be a pair with the previous one?</div></div><div class="tv-msg"><div class="tv-zh">当然可以。你想要和上一张一样的尺寸吗？</div><div class="tv-en">Of course. Would you like the same size as the last one?</div></div>';
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 2200));
  const img2 = await w2.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, '.tmp-ui-7-max.png'), img2.toPNG());
  const probe = await w2.webContents.executeJavaScript(`(function(){
    var a = document.querySelector('.mid-pane[data-mp="wa1"] .tg-conv-aside');
    var b = document.querySelector('.tele-browser');
    return JSON.stringify({
      winW: window.innerWidth,
      asidePx: a ? Math.round(a.getBoundingClientRect().width) : 0,
      browserPx: b ? Math.round(b.getBoundingClientRect().width) : 0,
      btnRows: (function(){var bs=document.querySelectorAll('.mid-pane[data-mp="wa1"] .tv-actions .tv-btn');
        if(!bs.length) return 0; var t=bs[0].getBoundingClientRect().top, r=0;
        bs.forEach(function(x){ if(Math.abs(x.getBoundingClientRect().top-t)>4) r++; }); return r+1;})()
    });
  })()`);
  console.log('[max-1920] ' + probe);

  w.destroy(); w2.destroy(); srv.close(); app.quit();
})().catch((e) => { console.error('[fail]', e && e.message); app.quit(); });