// src/voiceText.js — v2.7.1321
// 语音文字：扫描下载目录里的 WA 录音(.ogg/.opus)，语音转文字 + AI 翻译，本地留痕。
// 独立功能，不碰任何采集模块（WA/Telegram/Signal/外置WA）。
const fs = require('fs');
const path = require('path');
const ai = require('./ai');

function storePath() {
  let root = '.';
  try { root = require('./paths').DATA_ROOT || '.'; } catch (e) {}
  return path.join(root, 'data', 'voice_text.json');
}

function loadStore() {
  try {
    const p = storePath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) {}
  return {};
}

function saveStore(obj) {
  const p = storePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {}
}

// 录音文件识别：优先 WhatsApp Ptt*.ogg/.opus；兜底其它常见音频
function isRecording(name) {
  if (/^whatsapp ptt.*\.(ogg|opus)$/i.test(name)) return true;
  return /\.(ogg|opus|mp3|m4a|wav|webm|flac|aac|caf|amr)$/i.test(name);
}

function asText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (x.text) return String(x.text);
  if (x.result) return String(x.result);
  return String(x);
}

function scan(dir) {
  const items = [];
  const store = loadStore();
  let files = [];
  if (dir && fs.existsSync(dir)) {
    try { files = fs.readdirSync(dir).filter(isRecording); } catch (e) { files = []; }
  }
  const seen = new Set();
  for (const name of files) {
    const fp = path.join(dir, name);
    seen.add(fp);
    const rec = store[fp];
    if (rec && rec.text) {
      items.push({ name, path: fp, status: 'done', text: rec.text, zh: rec.zh || '', mtime: rec.mtime || 0 });
    } else {
      items.push({ name, path: fp, status: 'new', text: '', zh: '', mtime: 0 });
    }
  }
  // 库里有、但目录里已不存在的记录 → 保留（标 missing），符合"没删的保留"
  for (const fp of Object.keys(store)) {
    if (seen.has(fp)) continue;
    const rec = store[fp];
    items.push({ name: path.basename(fp), path: fp, status: 'missing', text: rec.text || '', zh: rec.zh || '', mtime: rec.mtime || 0 });
  }
  const order = { new: 0, done: 1, missing: 2 };
  items.sort((a, b) => (order[a.status] - order[b.status]) || (b.mtime - a.mtime));
  return { dir: dir || '', items };
}

async function transcribe(filePath) {
  const store = loadStore();
  if (store[filePath] && store[filePath].text) {
    return { path: filePath, status: 'done', text: store[filePath].text, zh: store[filePath].zh || '', cached: true };
  }
  if (!fs.existsSync(filePath)) throw new Error('文件不存在：' + filePath);
  if (!ai.isReady('asr')) throw new Error('语音识别 AI 未配置（请在 AI 设置里填好 asr 服务商）');
  const text = asText(await ai.transcribe(filePath));
  if (!text) throw new Error('转写结果为空');
  let zh = '';
  try { if (ai.isReady('translate')) zh = asText(await ai.translate(text, null)); } catch (e) { zh = ''; }
  const rec = { text, zh, mtime: Date.now() };
  store[filePath] = rec;
  saveStore(store);
  return { path: filePath, status: 'new', text, zh, cached: false };
}

function remove(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
  const store = loadStore();
  if (store[filePath]) { delete store[filePath]; saveStore(store); }
}

function pickDir() {
  try {
    const { dialog } = require('electron');
    const r = dialog.showOpenDialogSync({ properties: ['openDirectory'] });
    return (r && r[0]) || '';
  } catch (e) { return ''; }
}

module.exports = { scan, transcribe, remove, pickDir, isRecording };
