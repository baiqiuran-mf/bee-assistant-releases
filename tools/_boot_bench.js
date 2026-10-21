'use strict';
// 启动开销基准：逐个 require 后端模块，记录每个的加载耗时（毫秒）。
// 用法：node tools/_boot_bench.js
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

// 模拟 startCore 里同顺序的 require 列表（src/main.js:152-218）
const mods = [
  './src/db', './src/customerDoc', './src/ai', './src/knowledge', './src/translator',
  './src/media', './src/mediaFetch', './src/mediaRaw', './src/waWebMedia', './src/imageShrink',
  './src/wordDoc', './src/update', './src/signalStatus', './src/signalRead', './src/telegramRead',
  './src/telegramMerge', './src/whatsappRead', './src/waBubble', './src/waChain', './src/ids',
  './src/telegramLogin', './src/telegramLogout', './src/launcher', './src/signalJump',
  './src/prewarm', './src/loops', './src/identity', './src/profileScan', './src/whatsappWebView',
  './src/cloud', './src/aiVault', './src/jumpTab', './src/silence', './src/bubbleConfig',
  './src/translationMemory', './src/scanConfig', './src/server',
];

let total = 0;
const rows = [];
for (const m of mods) {
  const t0 = process.hrtime.bigint();
  try {
    require(path.join(ROOT, m.replace(/^\.\//, '')));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    total += ms;
    rows.push([ms, m, 'ok']);
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    rows.push([ms, m, 'ERR: ' + (e && e.message || e).split('\n')[0]]);
  }
}
rows.sort((a, b) => b[0] - a[0]);
console.log('模块加载耗时（降序，ms）：');
for (const [ms, m, st] of rows) {
  console.log(`  ${String(ms.toFixed(1)).padStart(8)}  ${m}  ${st}`);
}
console.log(`\n合计（仅本批模块 require，含首次 native 加载）：${total.toFixed(1)} ms`);
console.log(`注意：sharp / better-sqlite3 等 native 模块在 main.js 顶层更早加载，未计入本批。`);
