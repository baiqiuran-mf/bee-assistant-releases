/**
 * 客户时区体检 / 修复
 *
 * 为什么需要它（2026-09-26 真事）：
 *   客户 Alice Wu 地区写「纽约」，时区却存的是 America/Los_Angeles（差了 3 小时）。
 *   原因是这条数据是早期写入的，后来加了 src/regions.js 本地时区表，
 *   但"手填的时区永远优先"，旧值就一直错下去。
 *   后果：按错误时区推算发送时段，会在客户半夜发消息。
 *
 * 用法（在项目根目录跑）：
 *   node --experimental-sqlite tools/fix-timezone.js          只体检，不改
 *   node --experimental-sqlite tools/fix-timezone.js --fix     把不一致的改对
 *
 * 规则：
 *   - 只动「有地区、且本地表能认出这个地区」的客户
 *   - 地区认不出来的，原样保留（不猜、不覆盖人工填写）
 *   - 改之前会打印前后对照，--fix 才真的写库
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { guessTimezone, matchedKey, tzName } = require('../src/regions.js');

const DB_PATH = path.join(__dirname, '..', 'data', 'assistant.db');
const DO_FIX = process.argv.includes('--fix');

function main() {
  const db = new DatabaseSync(DB_PATH);
  const rows = db
    .prepare("SELECT id, code, name, region, timezone FROM customers WHERE region IS NOT NULL AND TRIM(region) != ''")
    .all();

  console.log(`共 ${rows.length} 位客户填了地区\n`);

  let ok = 0;
  let mismatch = 0;
  let unknown = 0;
  const fixes = [];

  for (const r of rows) {
    const want = guessTimezone(r.region);
    if (!want) {
      unknown += 1;
      console.log(`? ${r.code} ${r.name || '(无名)'}　地区「${r.region}」本地表认不出，跳过`);
      continue;
    }
    if (r.timezone === want) {
      ok += 1;
      continue;
    }
    mismatch += 1;
    fixes.push({ id: r.id, code: r.code, name: r.name, region: r.region, from: r.timezone, to: want });
    console.log(
      `✗ ${r.code} ${r.name || '(无名)'}　地区「${r.region}」命中「${matchedKey(r.region)}」\n`
        + `    现时区 ${r.timezone || '(空)'}\n`
        + `    应改为 ${want}（${tzName(want)}）`,
    );
  }

  console.log(`\n一致 ${ok} 条 · 不一致 ${mismatch} 条 · 认不出 ${unknown} 条`);

  if (!mismatch) {
    console.log(DO_FIX ? '没有需要修的。' : '体检通过，没有时区错误。');
    return;
  }

  if (!DO_FIX) {
    console.log('\n要修正请加 --fix 再跑一次。');
    return;
  }

  const up = db.prepare('UPDATE customers SET timezone = ? WHERE id = ?');
  for (const f of fixes) up.run(f.to, f.id);
  console.log(`\n已修正 ${fixes.length} 条时区。`);
  console.log('提示：客户档案 Markdown 里的「时间差 / 时区」两行，下次生成建议时会自动重写。');
}

main();
