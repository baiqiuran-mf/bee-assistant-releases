/* 临时诊断工具：读软件里 Telegram 内置浏览器的真实页面结构，把页面上真实的
 * data-mid 打出来，落盘到 probe-output.txt 供分析。
 *
 * 🔴 本文件只读不改：全部通过 HTTP GET 调软件已有的公开接口，不碰任何业务代码。
 *   ① GET /api/telegram/webview/pages  → 软件里所有内嵌页面（类型/网址/标题）
 *   ② GET /api/telegram/webview/probe  → 扫描结果（含 sampleMsgs = 真气泡 + mid）
 *
 * 用法（软件必须已在运行、且中栏已点开「Tele①」）：
 *   双击  start-test.bat probe
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'probe-output.txt');
const BASE = '127.0.0.1';
const PORT = 8787;

const lines = [];
const say = (s) => { lines.push(String(s)); console.log(s); };

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: BASE, port: PORT, path: p, timeout: 8000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch (e) { resolve({ __raw: b.slice(0, 500), __parseError: String(e && e.message) }); }
      });
    });
    req.on('error', (e) => resolve({ __error: String(e && e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ __error: 'timeout' }); });
  });
}

function save() {
  try { fs.writeFileSync(OUT, lines.join('\n'), 'utf8'); say('\n[saved] ' + OUT); }
  catch (e) { say('[save failed] ' + (e && e.message)); }
}

(async () => {
  say('=== Bee Assistant · Telegram page probe ===');
  say('time: ' + new Date().toISOString());
  say('target: http://' + BASE + ':' + PORT);
  say('');
  say('前提：软件已运行，且中栏已点开「Tele①」页签、Telegram 网页已加载。');

  say('\n=== 1. 内嵌页面清单 /api/telegram/webview/pages ===');
  const pages = await get('/api/telegram/webview/pages');
  say(JSON.stringify(pages, null, 2));
  if (pages && pages.__error) {
    say('\n连不上软件后端。请确认 start-test.bat 已经把软件跑起来了（本窗口要另开一个）。');
    save();
    process.exit(2);
  }

  say('\n=== 2. 页面扫描结果 /api/telegram/webview/probe ===');
  say('（先等 6 秒，让它自己扫两轮）');
  await new Promise((r) => setTimeout(r, 6000));
  const probe = await get('/api/telegram/webview/probe');
  say(JSON.stringify(probe, null, 2));

  say('\n=== 3. 只看气泡 mid（贴译文靠它定位）===');
  const msgs = (probe && probe.sampleMsgs) || [];
  if (!msgs.length) {
    say('⚠ 没拿到气泡。原因看上面 probe.found / probe.reason / probe.reasonCode。');
  } else {
    say('抓到的气泡：');
    for (const m of msgs) {
      say('  mid=' + JSON.stringify(m.mid) + '  dir=' + m.dir + '  body=' + JSON.stringify(String(m.body || '').slice(0, 60)));
    }
    say('\n上面这些 mid 就是贴译文要对准的目标。');
  }

  say('\n=== 4. 命中了哪些选择器 probe.hit ===');
  say(JSON.stringify((probe && probe.hit) || {}, null, 2));

  save();
})().catch((e) => {
  say('诊断异常: ' + (e && e.message) + '\n' + (e && e.stack));
  save();
  process.exit(1);
});