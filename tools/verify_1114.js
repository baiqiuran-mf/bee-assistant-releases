// v2.6.1114 asar 标记自检（宁窄不宽：只认真实代码形态）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '.tmp-asar-1114');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CHECKS = [
  ['版本号 = 2.6.1114', () => {
    const v = JSON.parse(read('package.json')).version;
    return v === '2.6.1114' ? `version=${v}` : null;
  }],
  ['build 段未丢（工作区·electron-builder 会正常剥 asar 内）', () => {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return !!(p.build && p.scripts && p.devDependencies)
      ? `version=${p.version} build/scripts/devDependencies 齐全`
      : null;
  }],
  ['latest.yml 指向 2.6.1114', () => {
    const y = fs.readFileSync(path.join(__dirname, '..', 'dist', 'latest.yml'), 'utf8');
    return /version:\s*2\.6\.1114/.test(y) ? 'dist/latest.yml OK' : null;
  }],
  ['CHANGELOG 有 2.6.1114 条目', () => {
    const c = read('CHANGELOG.md');
    return c.indexOf('2.6.1114') >= 0 ? '已收录' : null;
  }],

  // ── v2.6.1114 本版核心 ──
  ['1114 getAccountStates返 TG', 'src/main.js', 'TELEGRAM_ACCS[.]map[(]\\(t\\) => accountStates[.]get\\(t[.]id\\)\\)'],
  ['1114 wa.concat(tg)', 'src/main.js', 'return wa[.]concat\\(tg\\)'],
  ['1114 openTelegramAccount 定义', 'src/main.js', 'async function openTelegramAccount\\(id\\)'],
  ['1114 openTelegramAccount 路由注入', 'src/main.js', 'openTelegramAccount, prefillChat'],
  ['1114 openTelegramAccount 导出', 'src/main.js', 'openTelegramAccount'],
  ['1114 /api/telegram/account/:id/open 路由', 'src/server.js', 'telegram\\\\/account\\\\/\\(\\\\d\\+\\)\\\\/open'],
  ['1114 startWatching 默认不拉浏览器', 'src/telegramRead.js', 'autostart = false'],
  ['1114 startWatching 提前 return', 'src/telegramRead.js', 'if \\(!autostart\\)'],
  ['1114 watchAccount 末尾广播 online', 'src/telegramRead.js', 'onState'],
  ['1114 ensureWatching 跳过未运行', 'src/telegramRead.js', 'ensureWatching'],

  // ── v2.6.1113 ──
  ['1113 acquireBrowser 互斥锁', 'src/telegramRead.js', 'acquireBrowser'],
  ['1113 launching Promise 单例', 'src/telegramRead.js', 'launching'],
  ['1113 顶栏 tg-accounts 容器', 'public/index.html', 'id="tg-accounts"'],
  ['1113 Tele② 页签', 'public/index.html', 'data-mp="tele2"'],
  ['1113 Tele② 日志区', 'public/index.html', 'tg-collect-log-t2'],
  ['1113 Tele① 日志区', 'public/index.html', 'tg-collect-log-tele1'],
  ['1113 renderTgAccounts', 'public/app.js', 'renderTgAccounts'],
  ['1113 appendTgLog', 'public/app.js', 'appendTgLog'],
  ['1113 tgCodeOf 双页签隔离', 'public/app.js', 'tgCodeOf'],
  ['1113 .tg-log 样式', 'public/style.css', '.tg-log'],

  // ── v2.6.1112 ──
  ['1112 main 栅格 265/1fr/500', 'public/style.css', '265px minmax\\(0, 1fr\\) 500px'],
  ['1112 容器查询 tgw', 'public/style.css', 'container-name: tgw'],
  ['1112 右栏 80px 档', 'public/style.css', '80px'],
  ['1112 竖排按钮', 'public/style.css', 'writing-mode: vertical-rl'],
  ['1112 panel-auto-toggle', 'public/index.html', 'panel-auto-toggle'],
  ['1112 applyPanelWidthMode', 'public/app.js', 'applyPanelWidthMode'],

  // ── v2.6.1111 ──
  ['1111 单线版 A 通道', 'src/telegramOfficialChannel.js', 'CHANNEL'],
  ['1111 3秒循环', 'src/loops.js', 'BEAT_MS'],

  // ── 长青红线 ──
  ['红线绝无自动发送（prefill）', 'public/app.js', 'prefill'],
  ['红线 showNotice', 'public/app.js', 'showNotice'],
  ['红线 phoneOwnerOf 总闸', 'src/db.js', 'phoneOwnerOf'],
  ['红线 单线版 MTProto', 'src/main.js', 'telegramOfficialChannel'],
];

const results = [];
for (const c of CHECKS) {
  const label = c[0];
  try {
    if (c.length === 2) {
      const v = c[1]();
      results.push({ label, ok: !!v, detail: v || '未找到' });
    } else {
      const [, file, needle] = c;
      const src = read(file);
      const rx = new RegExp(needle);
      const hit = rx.test(src);
      const line = hit ? src.slice(0, rx.exec(src).index).split('\n').length : 0;
      results.push({ label, ok: hit, detail: hit ? `${file}:${line}` : `未在 ${file} 命中` });
    }
  } catch (e) {
    results.push({ label, ok: false, detail: '读取失败: ' + e.message });
  }
}

const ok = results.filter((r) => r.ok).length;
const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.label}  [${r.detail}]`);
console.log(`\n=== ${ok}/${results.length} 命中 ===`);
if (bad.length) { console.log('未命中：'); bad.forEach((b) => console.log('  - ' + b.label + ' → ' + b.detail)); process.exit(1); }
console.log('asar 内全部标记通过 ✅');