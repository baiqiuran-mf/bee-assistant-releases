/**
 * 档案重复体检（只读，不动任何文件）
 *
 * 用法：node --experimental-sqlite tools/scan_dup_docs.js
 *
 * 干什么：
 *   把 customers 目录里所有 .md 按【电话号码】分组，列出同一个号码下的多份档案；
 *   同时把数据库里同一个号码的多条客户记录也列出来（重复建档的根源）。
 *   只打印，不重命名、不合并、不删除 —— 要真的合并，去界面上点
 *   「从对话里提取档案」（那边会用 AI 合并并备份原文件）。
 */

const fs = require('fs');
const path = require('path');

const doc = require('../src/customerDoc');
const docDedup = require('../src/docDedup');

const dbFile = path.join(require('../src/paths').DATA_ROOT, 'assistant.db');

console.log(`数据目录：${require('../src/paths').DATA_ROOT}`);
console.log(`档案目录：${doc.docsDir()}`);
console.log('');

// ---- 1. 数据库里同一个电话的多条客户 ----
let rows = [];
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile);
  rows = db.prepare('SELECT code, name, phone, account_id, created_at FROM customers ORDER BY code').all();
  db.close();
} catch (e) {
  console.log(`（读不到数据库：${e.message}）`);
}

const byPhone = new Map();
for (const r of rows) {
  const p = docDedup.normalizePhone(r.phone);
  if (!p) continue;
  if (!byPhone.has(p)) byPhone.set(p, []);
  byPhone.get(p).push(r);
}

console.log('=== 数据库：同一个电话号码下的多条客户记录 ===');
let dupCustomers = 0;
for (const [phone, list] of byPhone) {
  if (list.length < 2) continue;
  dupCustomers++;
  console.log(`\n电话 ${phone} —— ${list.length} 条客户记录：`);
  for (const c of list) console.log(`   ${c.code}   ${c.name || '（未命名）'}   账号${c.account_id}   加入 ${c.created_at || '—'}`);
}
if (!dupCustomers) console.log('（没有重复）');

// ---- 2. 档案目录里同一个电话的多份文档 ----
console.log('\n=== 档案目录：同一个电话号码下的多份 .md 文件 ===');
const files = doc.listDocFiles();
const byPhoneFile = new Map();
for (const f of files) {
  let p = docDedup.normalizePhone(f.phone);
  if (!p) p = docDedup.normalizePhone(docDedup.readDocPhone(f.path));
  if (!p) continue;
  if (!byPhoneFile.has(p)) byPhoneFile.set(p, []);
  byPhoneFile.get(p).push(f);
}

let dupFiles = 0;
let dupFileCount = 0;
for (const [phone, list] of byPhoneFile) {
  if (list.length < 2) continue;
  dupFiles++;
  dupFileCount += list.length;
  console.log(`\n电话 ${phone} —— ${list.length} 份档案文件：`);
  for (const f of list) {
    const size = fs.statSync(f.path).size;
    console.log(`   ${f.file}   （编号 ${f.code}，${size} 字节${f.legacy ? '，旧命名' : ''}）`);
  }
}

console.log('');
console.log('=== 小结 ===');
console.log(`档案文件共 ${files.length} 份；其中同一个电话下有多份的：${dupFiles} 组、涉及 ${dupFileCount} 份文件。`);
if (dupFiles) {
  console.log('这些就是"相同电话却有不同档案"的重复档案。');
  console.log('在界面上打开其中任意一个客户 → 点「从对话里提取档案」，');
  console.log('软件会按电话号码查出同一个人的其它档案，用 AI 读进来合并成一份，');
  console.log('并把被合并的那几份挪进 customers/_merged_backup/（不删除）。');
} else {
  console.log('没有发现重复档案。');
}
