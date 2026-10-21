/**
 * 极小 YAML 解析器（零依赖兜底）
 *
 * config.yaml 用不到 YAML 的全套语法，所以这里只实现用到的子集：
 * 嵌套映射、块序列、行内 flow 序列（可跨行）、带引号字符串、布尔/数字/null、# 注释
 *
 * 装了 js-yaml 时优先用 js-yaml；装不上（离线、内网）就用这个，保证程序照常启动。
 */

function stripInlineComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += c;
  }
  return out;
}

function countIndent(line) {
  const m = /^[ ]*/.exec(line);
  return m ? m[0].length : 0;
}

/** 把跨行的行内数组 ["a", "b",\n "c"] 合并成一行 */
function joinFlowLines(rawLines) {
  const out = [];
  let buf = null;
  let depth = 0;
  for (const raw of rawLines) {
    const line = stripInlineComment(raw.replace(/\r$/, ''));
    if (buf === null) {
      const open = (line.match(/\[/g) || []).length - (line.match(/\]/g) || []).length;
      if (open > 0) {
        buf = line;
        depth = open;
        continue;
      }
      out.push(line);
    } else {
      buf += ' ' + line.trim();
      depth += (line.match(/\[/g) || []).length - (line.match(/\]/g) || []).length;
      if (depth <= 0) {
        out.push(buf);
        buf = null;
        depth = 0;
      }
    }
  }
  if (buf !== null) out.push(buf);
  return out;
}

function stripQuotes(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

function parseScalar(raw) {
  const s = String(raw).trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);

  if (s.startsWith('[') && s.endsWith(']')) return parseFlowSeq(s);
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return {};
    const obj = {};
    for (const part of splitFlow(inner)) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      obj[stripQuotes(part.slice(0, i))] = parseScalar(part.slice(i + 1));
    }
    return obj;
  }
  return stripQuotes(s);
}

function splitFlow(s) {
  const parts = [];
  let quote = null;
  let cur = '';
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ',') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseFlowSeq(s) {
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  return splitFlow(inner).map(parseScalar);
}

function applyKV(obj, content) {
  const m = /^([^:]+):\s*(.*)$/.exec(content);
  if (!m) return;
  const key = stripQuotes(m[1]);
  const rest = m[2].trim();
  obj[key] = rest === '' ? null : parseScalar(rest);
}

/**
 * 解析 YAML 文本
 * @param {string} text
 * @returns {object}
 */
function load(text) {
  const rawLines = String(text).split('\n');
  const lines = [];
  for (const l of joinFlowLines(rawLines)) {
    if (!l.trim()) continue;
    if (l.trim().startsWith('---')) continue;
    const indent = countIndent(l);
    lines.push({ indent, text: l.trim() });
  }

  let pos = 0;

  function isSeqLine(l) {
    return l === '-' || l.startsWith('- ');
  }

  function parseNode(indent) {
    const l = lines[pos];
    if (!l || l.indent < indent) return null;
    // 纯值行：跨行的行内数组 / 对象（joinFlowLines 已合并成一行）
    if (l.text.startsWith('[') || l.text.startsWith('{')) {
      pos++;
      return parseScalar(l.text);
    }
    return isSeqLine(l.text) ? parseSeq(indent) : parseMap(indent, null);
  }

  function parseSeq(indent) {
    const arr = [];
    while (pos < lines.length) {
      const l = lines[pos];
      if (!l || l.indent < indent) break;
      if (l.indent > indent) {
        pos++;
        continue;
      }
      if (!isSeqLine(l.text)) break;

      const content = l.text.replace(/^-\s*/, '');
      pos++;
      const next = lines[pos];

      if (content === '') {
        arr.push(next && next.indent > l.indent ? parseNode(next.indent) : null);
      } else if (/^[^:]+:(\s|$)/.test(content)) {
        const obj = {};
        applyKV(obj, content);
        if (next && next.indent > l.indent) {
          parseMap(next.indent, obj);
        }
        arr.push(obj);
      } else {
        arr.push(parseScalar(content));
      }
    }
    return arr;
  }

  function parseMap(indent, target) {
    const obj = target || {};
    while (pos < lines.length) {
      const l = lines[pos];
      if (!l || l.indent < indent) break;
      if (l.indent > indent) {
        pos++;
        continue;
      }
      if (isSeqLine(l.text)) break;

      const m = /^([^:]+):\s*(.*)$/.exec(l.text);
      if (!m) {
        pos++;
        continue;
      }
      const key = stripQuotes(m[1].trim());
      const rest = m[2].trim();
      pos++;
      const next = lines[pos];

      if (rest === '') {
        obj[key] = next && next.indent > l.indent ? parseNode(next.indent) : null;
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  return parseNode(0) || {};
}

module.exports = { load };
