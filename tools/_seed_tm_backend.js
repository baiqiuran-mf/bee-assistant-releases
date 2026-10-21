'use strict';
/**
 * 把桌面「翻译.txt」里的英语↔中文短语，录入到【后台共享翻译词典】。
 * 铁律：别重复。先 pull 后台已有词条，文件内按归一化去重（首次出现优先），
 *       只 push「后台没有」的那些。
 * 默认 dry-run（只打印计划，不写后台）；带 --push 才真正写。
 */
const fs = require('fs');
const path = require('path');

const cloud = require('../src/cloud');

const SRC = 'C:/Users/Administrator/Desktop/翻译.txt';
const PULL_PATH = '/api/translate/memory/pull';
const PUSH_PATH = '/api/translate/memory/push';
const BATCH = 100;
const DO_PUSH = process.argv.includes('--push');

// 与 translationMemory.js 一致的归一化：只去首尾/压缩空白，case 不动（后台 UNIQUE 大小写敏感）
function normalize(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); }

function parse(src) {
  const lines = src.split(/\r?\n/);
  const rows = [];
  const re = /^\|\s*(\d+)\.\s+(.+?)\s*\|\s*(.+?)\s*\|\s*$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;            // 跳过表头 / 分隔线 / 说明段落
    const en = normalize(m[2]);
    const zh = normalize(m[3]);
    if (!en || !zh) continue;
    rows.push({ en, zh });
  }
  return rows;
}

(async () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const raw = parse(src);
  console.log(`[1] 文件解析：原始行 ${raw.length} 条`);

  // 文件内去重（首次出现优先）
  const seen = new Map();
  let dupInFile = 0;
  for (const r of raw) {
    const k = r.en; // normalize 已是空白归一，en 本身就是 key
    if (seen.has(k)) { dupInFile++; continue; }
    seen.set(k, r.zh);
  }
  const unique = Array.from(seen.entries()).map(([en, zh]) => ({ en, zh }));
  console.log(`[2] 文件内去重后唯一 ${unique.length} 条（文件内重复跳过 ${dupInFile} 条）`);

  // 加载本地会话令牌
  const ok = cloud.loadConfig();
  console.log(`[3] 云端会话：${ok ? '已加载令牌' : '未登录'}（operator=${JSON.stringify((cloud._state && cloud._state.operator) || null)}）`);

  // pull 后台已有词条
  console.log(`[4] 拉取后台现有词典…`);
  let existing = new Set();
  try {
    const j = await cloud.request('GET', PULL_PATH, undefined, { timeout: 8000 });
    const rows = (j && j.rows) || [];
    for (const r of rows) if (r && r.src_norm) existing.add(String(r.src_norm));
    console.log(`    后台现有词条 ${existing.size} 条`);
  } catch (e) {
    console.error(`    ✗ 拉取失败：${e.message}`);
    process.exit(1);
  }

  // 过滤：只留后台没有的
  const toAdd = unique.filter((r) => !existing.has(r.en));
  const already = unique.length - toAdd.length;
  console.log(`[5] 后台已有（跳过）${already} 条；本次将新增 ${toAdd.length} 条`);

  if (!DO_PUSH) {
    console.log('\n=== DRY-RUN 完成：未写入后台。加 --push 才真正录入 ===');
    // 预览前 10 条待新增
    console.log('待新增预览（前 10）：');
    toAdd.slice(0, 10).forEach((r) => console.log(`   ${r.en}  →  ${r.zh}`));
    return;
  }

  // 真正写入
  console.log(`\n=== 开始录入 ${toAdd.length} 条到后台 ===`);
  let applied = 0;
  for (let i = 0; i < toAdd.length; i += BATCH) {
    const chunk = toAdd.slice(i, i + BATCH);
    const payload = chunk.map((r) => ({
      src_norm: r.en,
      src_text: r.en,
      body_zh: r.zh,
      provider: 'manual',
      hits: 0,
      src_len: r.en.length,
      updated_at: new Date().toISOString(),
    }));
    try {
      const j = await cloud.request('POST', PUSH_PATH, { rows: payload }, { timeout: 120000 });
      const n = (j && Number(j.applied)) || 0;
      applied += n;
      console.log(`    batch ${Math.floor(i / BATCH) + 1}: applied=${n}/${chunk.length}`);
    } catch (e) {
      console.error(`    ✗ batch ${Math.floor(i / BATCH) + 1} 失败：${e.message}`);
      console.error(`       已成功 ${applied} 条，剩余 ${toAdd.length - i} 条未写入`);
      process.exit(1);
    }
  }
  console.log(`[6] 录入完成：applied=${applied}/${toAdd.length}`);

  // 复拉确认
  const j2 = await cloud.request('GET', PULL_PATH, undefined, { timeout: 8000 });
  const after = (j2 && j2.rows) || [];
  console.log(`[7] 复拉确认：后台现有 ${after.length} 条（新增前 ${existing.size}）`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
