/**
 * test/telegram_time_display.test.js —— v2.6.1138
 *
 * 老板 2026-10-16 原话：
 *   「好友发来的消息时间，我想把这个时间放在好友消息右侧。我发送的消息蓝色方框中
 *     对于时间问题没有修复。而且消息中还有奇怪的符号""，这些都不可以出现，
 *     而且不能两个时间。」
 *   「还有 Telegram 网页版来新消息，软件不会提示。」
 *
 * 本文件只测「时间显示 + 不可见字符」这一条线（通知那条线在 notify 专项测试里）。
 * 🔴 本项目铁律：Telegram 的抓取/清洗只认 Telegram 自己那条路，不许抽公共函数给别的渠道复用。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { stripTrailingTime, stripInvisible } = require(path.join(ROOT, 'src/telegramMerge.js'));

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; failures.push({ name, msg: e && e.message }); console.log('  ❌ ' + name + '\n     ' + (e && e.message)); }
}

console.log('\n===== 一、根因：私用区字符阻断时间剥离 =====');
console.log('  背景：Telegram 把我方(out)消息的时间用 U+E901 包在正文尾部，');
console.log('  而旧正则要求时间顶到末尾、\\s 不匹配私用区字符 → 剥不掉 → 豆腐块 + 两个时间。');

t('U+E901 不被 \\s 匹配（这就是旧正则失效的原因）', () => {
  assert.strictEqual(/\s/.test('\uE901'), false);
});
t('正文 "hi"+U+E901+"18:32"+U+E901 → body="hi" msgTime="18:32"', () => {
  const r = stripTrailingTime('hi\uE901 18:32\uE901');
  assert.strictEqual(r.body, 'hi');
  assert.strictEqual(r.msgTime, '18:32');
});
t('剥完正文里不再残留时间（不能两个时间）', () => {
  const r = stripTrailingTime('hi\uE901 18:32\uE901');
  assert.ok(!/\d{1,2}:\d{2}/.test(r.body), '正文里还有时间: ' + r.body);
});
t('库里实际出现过的三个私用区码位都能洗掉', () => {
  for (const cp of [0xE901, 0xE900, 0xEA21, 0xE918]) {
    const raw = 'x' + String.fromCodePoint(cp) + '12:30' + String.fromCodePoint(cp);
    const r = stripTrailingTime(raw);
    assert.strictEqual(r.body, 'x', 'U+' + cp.toString(16) + ' 没洗掉');
    assert.strictEqual(r.msgTime, '12:30');
  }
});
t('整个私用区 U+E000–U+F8FF 全部覆盖（穷举前 200个 + 后 200 个）', () => {
  for (let cp = 0xE000; cp < 0xE000 + 200; cp++) {
    assert.strictEqual(stripInvisible(String.fromCodePoint(cp)), '', 'U+' + cp.toString(16));
  }
  for (let cp = 0xF8FF - 199; cp <= 0xF8FF; cp++) {
    assert.strictEqual(stripInvisible(String.fromCodePoint(cp)), '', 'U+' + cp.toString(16));
  }
});

console.log('\n===== 二、正则写法回归（今天真踩的坑）=====');
console.log('  坑：把正则的「或」写成字符串拼接 → 编译成 [A][B]|[C]，零宽字符单独出现时洗不掉。');

t('零宽字符单独出现能洗掉（拼接写法的老bug）', () => {
  for (const cp of [0x200B, 0x200C, 0x200E, 0x200F, 0x202A, 0x202E, 0x2060, 0xFEFF]) {
    assert.strictEqual(stripInvisible('a' + String.fromCodePoint(cp) + 'b'), 'ab',
      'U+' + cp.toString(16).toUpperCase() + ' 没洗掉');
  }
});
t('C0/C1 控制字符能洗掉', () => {
  for (const cp of [0x0000, 0x0007, 0x0008, 0x000B, 0x000C, 0x001F, 0x007F, 0x009F]) {
    assert.strictEqual(stripInvisible('a' + String.fromCodePoint(cp) + 'b'), 'ab',
      'U+' + cp.toString(16).toUpperCase() + ' 没洗掉');
  }
});

console.log('\n===== 三、绝不能误伤（误伤就是事故）=====');

t('U+200D ZWJ 不洗（洗了 👨‍🎻 会毁掉）', () => {
  const zwj = String.fromCodePoint(0x200D);
  assert.strictEqual(stripInvisible('a' + zwj + 'b'), 'a' + zwj + 'b');
});
t('emoji 组合序列完整保留', () => {
  const s = '\u{1F468}\u200D\u{1F3BB} ok';       // 👨‍🎻
  assert.strictEqual(stripInvisible(s), s);
});
t('U+FE00–U+FE0F 变体选择符不洗（❤️ 会掉变体）', () => {
  for (const cp of [0xFE0E, 0xFE0F]) {
    const s = 'a' + String.fromCodePoint(cp);
    assert.strictEqual(stripInvisible(s), s, 'U+' + cp.toString(16) + ' 被洗了');
  }
  assert.strictEqual(stripInvisible('❤️ ok'), '❤️ ok');
});
t('换行 / 制表 / 回车保留（多行消息不能被压成一行）', () => {
  assert.strictEqual(stripInvisible('第一行\n第二行\t尾\r'), '第一行\n第二行\t尾\r');
});
t('中文与中文标点一字不动', () => {
  const s = '你好，世界。｛good｝【测试】';
  assert.strictEqual(stripInvisible(s), s);
});
t('HTML 敏感字符不被删（< > & " 都要留着给 esc() 处理）', () => {
  const s = '<b>a & b</b> "q"';
  assert.strictEqual(stripInvisible(s), s);
});

console.log('\n===== 四、原有时间剥离行为不能退化（v2.6.1136 回归）=====');

t('正常尾部时间照剥', () => {
  assert.deepStrictEqual(stripTrailingTime('Hello 14:03'), { body: 'Hello', msgTime: '14:03', onlyTime: false });
});
t('紧贴无空格 Hi18:32', () => {
  assert.deepStrictEqual(stripTrailingTime('Hi18:32'), { body: 'Hi', msgTime: '18:32', onlyTime: false });
});
t('AM/PM 形态', () => {
  assert.deepStrictEqual(stripTrailingTime('Hello 2:05 PM'), { body: 'Hello', msgTime: '2:05 PM', onlyTime: false });
});
t('中文时段词', () => {
  const r = stripTrailingTime('下午 3:07');
  assert.strictEqual(r.onlyTime, true, '只剩时间应标记 onlyTime');
});
t('纯中文不动', () => {
  assert.deepStrictEqual(stripTrailingTime('你好'), { body: '你好', msgTime: '', onlyTime: false });
});
t('null / 空串不炸', () => {
  assert.strictEqual(stripTrailingTime(null).body, '');
  assert.strictEqual(stripTrailingTime(undefined).body, '');
  assert.strictEqual(stripTrailingTime('').body, '');
});
t('通话记录不该被剥（时间在中间不是尾部）', () => {
  assert.strictEqual(stripTrailingTime('Outgoing Call 23:57, 24 seconds').msgTime, '');
});

console.log('\n===== 五、前后端两份正则必须逐字节一致 =====');
console.log('  public/app.js 不能 require src/，所以是独立副本 —— 不一致就会出现「一边洗一边没洗」。');

function loadRe(file, name) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const s = lines.findIndex((l) => l.includes(`const ${name} = new RegExp(`));
  assert.ok(s >= 0, file + ' 里找不到 ' + name);
  const e = lines.findIndex((l, i) => i > s && l.trim() === ');');
  assert.ok(e > s, name + ' 没闭合');
  const raw = lines.slice(s, e + 1);
  const first = raw[0].replace(new RegExp('^const\\s+' + name + '\\s*=\\s*'), '');
  const expr = [first, ...raw.slice(1, -1).map((l) => l.replace(/^;/, '')), ')'].join('\n');
  return new Function('return (' + expr + ')')();
}
const RE_SRC = loadRe(path.join(ROOT, 'src/telegramMerge.js'), 'INVISIBLE_RE');
const RE_WEB = loadRe(path.join(ROOT, 'public/app.js'), 'TG_INVISIBLE_RE');

t('两份正则在全部 65536 个 BMP 字符上判断一致', () => {
  const diff = [];
  for (let cp = 0; cp <= 0xFFFF; cp++) {
    const ch = String.fromCodePoint(cp);
    const a = RE_SRC.test(ch); RE_SRC.lastIndex = 0;
    const b = RE_WEB.test(ch); RE_WEB.lastIndex = 0;
    if (a !== b) diff.push('U+' + cp.toString(16).toUpperCase());
  }
  assert.strictEqual(diff.length, 0, '不一致的码位: ' + diff.slice(0, 10).join(','));
});
t('前端副本对私用区与零宽的清洗结果与采集侧一致', () => {
  const raw = 'hi\uE901 18:32\uE901';
  assert.strictEqual(raw.replace(RE_WEB, ''), 'hi 18:32');
  assert.strictEqual(RE_WEB.test('\u200B'), true, '前端副本没覆盖零宽');
});
/**
 * 把 public/app.js 里**原样**的前端时间剥离逻辑抠出来求值，返回可调用的 tgSplitTime。
 * public/app.js 是浏览器脚本（依赖 window/document），没法直接 require；
 * 这里只抠「时间剥离」这几段纯逻辑，逐字用源码 —— 重写就失去了「验证前端那一份」的意义。
 */
function loadWebSplitTime() {
  const webSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const lines = webSrc.split(/\r?\n/);
  const idx = (pred, from) => {
    const i = lines.findIndex((l, k) => k >= (from || 0) && pred(l));
    assert.ok(i >= 0, 'public/app.js 里找不到：' + pred);
    return i;
  };
  // 按顺序逐段抓，锚点都用「下一段一定出现的行首标记」，避免 to 标记猜错
  const a = idx((l) => l.includes('const TG_TRAIL_TIME_RE'));
  const b = idx((l) => l.includes('const TG_INVISIBLE_RE = new RegExp('), a);
  const c = idx((l) => l.trim() === ');', b);                       // INVISIBLE_RE 闭合（必须从 b 往后找）
  const d = idx((l) => l.includes('function tgStripInvisible('), c); // 清洗函数定义
  const e = idx((l) => l.includes('/** 时间方框的 HTML'), d);         // tgSplitTime 结束
  const code = [
    lines.slice(b, c + 1).join('\n'),        // TG_INVISIBLE_RE（含 'gu', 与');'）
    lines.slice(a, a + 1).join('\n'),        // TG_TRAIL_TIME_RE（单行）
    lines.slice(d, e).join('\n'),            // tgStripInvisible + tgSplitTime
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(code + '\nreturn tgSplitTime;')();
}

t('两份时间正则行为完全一致（穷举 24×60 种「H:MM」× 4 种前缀）', () => {
  // 直接比行为，不比源码文本 —— 源码抓取太脆（注释里也提到这个名字、还有跨行/空格）。
  // 前后端各跑一遍自己的剥时间逻辑，1440×4 + 边界例，结论必须逐条相同。
  const tgSplitTime = loadWebSplitTime();
  const probe = [];
  for (let h = 0; h < 24; h++) {
    for (let mnt = 0; mnt < 60; mnt++) {
      const t = h + ':' + String(mnt).padStart(2, '0');
      probe.push('Hi' + t, 'Hello ' + t, '你好' + t, t);
    }
  }
  probe.push('Hello 2:05 PM', '下午 3:07', '凌晨 0:05', '晚上 11:59', '上午 9:05',
    'Outgoing Call 23:57, 24 seconds', '你好，世界。', '', '   ', 'no time here',
    'hi\uE901 18:32\uE901', '你好\uE90114:03\uE901');
  const diff = [];
  for (const raw of probe) {
    const a = stripTrailingTime(raw);
    const b = tgSplitTime(raw, '');
    if (a.body !== b.text || a.msgTime !== b.time) {
      diff.push(JSON.stringify(raw) + ' → 采集侧 ' + JSON.stringify([a.body, a.msgTime])
        + ' / 前端 ' + JSON.stringify([b.text, b.time]));
    }
  }
  assert.strictEqual(diff.length, 0, '前后端行为不一致（' + diff.length + '/' + probe.length + '）:\n     '
    + diff.slice(0, 5).join('\n     '));
});
t('前端 tgSplitTime 也能剥掉私用区包裹的时间（老数据兜底）', () => {
  const tgSplitTime = loadWebSplitTime();
  const r = tgSplitTime('hi\uE901 18:32\uE901', '');
  assert.strictEqual(r.text, 'hi', '正文没剥干净: ' + JSON.stringify(r.text));
  assert.strictEqual(r.time, '18:32');
  assert.strictEqual(tgSplitTime('hi', '07:00').time, '07:00', 'fallback 失效');
});

console.log('\n===== 六、布局：时间与气泡同一行、out 不被裁切 =====');

t('两处渲染入口都用了 .tg-line 包住气泡+时间', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const n = (js.match(/<div class="tg-line">/g) || []).length;
  assert.ok(n >= 2, '只找到 ' + n + ' 处 .tg-line，两处渲染入口都该改');
  assert.ok(!/class="tg-bubble">\$\{esc\(body \|\| '\(图片\/媒体\)'\)\}/.test(js),
    '还留着「剥空正文渲染成(图片/媒体)」的老写法');
});
t('.tg-line CSS 存在且是横排', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  assert.ok(/\.tg-line \{[^}]*display:\s*flex/.test(css), 'CSS 里没有横排的 .tg-line');
  assert.ok(/\.tg-crow\.out \.tg-line \{[^}]*flex-end/.test(css), 'out侧没有右对齐规则');
});
t('.tg-time-box 不再自带 margin-top（同行后不需要上间距）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  const m = css.match(/\.tg-time-box \{([^}]*)\}/);
  assert.ok(m, '找不到 .tg-time-box');
  assert.ok(!/margin-top:\s*[1-9]/.test(m[1]), '.tg-time-box 还带 margin-top，会让同行看起来像下一行');
});
t('.tg-line 是新类名，不与既有类名冲突', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  const decls = (css.match(/\.tg-line\b/g) || []).length;
  assert.ok(decls >= 1);
  // 反向：确认没有别的地方定义了同名不同义的 .tg-line
  assert.strictEqual((css.match(/^\.tg-line \{/gm) || []).length, 1, '.tg-line 被定义了多处');
});

console.log('\n===== 七、"只有时间"的状态行不造空泡 =====');

t('采集侧：剥空会标onlyTime（调用方据此丢弃）', () => {
  assert.strictEqual(stripTrailingTime('00:16').onlyTime, true);
});
t('渲染侧：剥空且无媒体的分支不渲染空泡', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const n = (js.match(/if \(!text\) \{/g) || []).length
          + (js.match(/if \(!body\) \{/g) || []).length;
  assert.ok(n >= 2, '只找到 ' + n + ' 处空正文保护，两处渲染入口都该有');
});

console.log('\n===== 八、采集侧已导出 stripInvisible =====');
t('module.exports 里有 stripInvisible', () => {
  assert.strictEqual(typeof stripInvisible, 'function');
});

console.log('\n=================================================');
console.log(`  通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n  失败明细：');
  for (const f of failures) console.log('   · ' + f.name + ' → ' + f.msg);
}
console.log('=================================================\n');
process.exit(fail ? 1 : 0);
