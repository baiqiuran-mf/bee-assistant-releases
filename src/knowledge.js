/**
 * 知识库按需加载
 *
 * 三份每次必带（人设 / 红线 / 范例），其余按关键词命中才加载。
 * 原因很实在：一股脑全塞会稀释重点，而且每次都多花 token。
 *
 * config.yaml：
 *   knowledge:
 *     dir: ./knowledge
 *     always: [persona.md, redlines.md, templates.md]
 *     onDemand:
 *       products.md: ["价格", "尺寸", ...]
 *       stories.md:  ["猫", "过世", ...]
 */

const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');

const ROOT = runtime.dataBase(); // 开发=项目根；打包后=用户可写目录（见 src/runtime.js）

function loadYaml(file) {
  let yaml;
  try {
    yaml = require('js-yaml');
  } catch (e) {
    yaml = require('./yaml-lite');
  }
  return yaml.load(fs.readFileSync(file, 'utf8')) || {};
}

let _knowledgeCfg = null;
let _knowledgeDir = null;
const _cache = new Map(); // file -> {mtimeMs, text}

function loadKnowledgeConfig() {
  if (_knowledgeCfg) return _knowledgeCfg;
  const cfgFile = require('./paths').configFile(); // 打包后读的是用户目录那份，不是只读的程序根目录
  if (!fs.existsSync(cfgFile)) {
    _knowledgeCfg = {};
    _knowledgeDir = path.join(ROOT, 'knowledge');
    return _knowledgeCfg;
  }
  const full = loadYaml(cfgFile);
  _knowledgeCfg = full.knowledge || {};
  const dir = _knowledgeCfg.dir || './knowledge';
  _knowledgeDir = path.isAbsolute(dir) ? dir : path.resolve(ROOT, dir);
  return _knowledgeCfg;
}

/** 测试或外部注入 */
function setKnowledgeConfig(cfg, dirOverride) {
  _knowledgeCfg = cfg;
  _knowledgeDir = dirOverride || path.join(ROOT, 'knowledge');
}

function knowledgeDir() {
  if (!_knowledgeCfg) loadKnowledgeConfig();
  return _knowledgeDir;
}

/** 读文件，带 mtime 缓存：改完 knowledge/*.md 立刻生效，不用重启 */
function readFileCached(file) {
  const full = path.join(knowledgeDir(), file);
  if (!fs.existsSync(full)) return null;
  const st = fs.statSync(full);
  const hit = _cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
  const text = fs.readFileSync(full, 'utf8');
  _cache.set(file, { mtimeMs: st.mtimeMs, text });
  return text;
}

function alwaysFiles() {
  const cfg = loadKnowledgeConfig();
  return Array.isArray(cfg.always) ? cfg.always : [];
}

function onDemandRules() {
  const cfg = loadKnowledgeConfig();
  return cfg.onDemand && typeof cfg.onDemand === 'object' ? cfg.onDemand : {};
}

/**
 * 给定一段文本，返回命中的按需文件列表
 * 匹配规则：关键词不区分大小写地出现在 text 中
 * @returns {string[]}
 */
function matchFiles(text) {
  const rules = onDemandRules();
  const hay = String(text || '').toLowerCase();
  const hits = [];
  for (const [file, keywords] of Object.entries(rules)) {
    const list = Array.isArray(keywords) ? keywords : [];
    // 中文没有大小写问题，英文关键词统一转小写比较
    if (list.some((k) => k && hay.includes(String(k).toLowerCase()))) hits.push(file);
  }
  return hits;
}

/**
 * 组装喂给模型的知识块
 * @param {string} triggerText 用于关键词匹配（一般是最近对话 + 档案）
 * @returns {{text:string, always:string[], matched:string[]}}
 */
function buildBlocks(triggerText) {
  const alwayList = alwaysFiles();
  const matched = matchFiles(triggerText);

  const parts = [];
  for (const f of alwayList) {
    const body = readFileCached(f);
    if (body) parts.push(`<<${f}>>\n${body.trim()}`);
  }
  for (const f of matched) {
    if (alwayList.includes(f)) continue;
    const body = readFileCached(f);
    if (body) parts.push(`<<${f}>>\n${body.trim()}`);
  }

  return {
    text: parts.join('\n\n'),
    always: alwayList,
    matched,
  };
}

/** 列出当前实际存在的知识文件（界面上展示用） */
function listFiles() {
  const dir = knowledgeDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
}

module.exports = {
  loadKnowledgeConfig,
  setKnowledgeConfig,
  knowledgeDir,
  alwaysFiles,
  onDemandRules,
  matchFiles,
  buildBlocks,
  listFiles,
  readFileCached,
};
