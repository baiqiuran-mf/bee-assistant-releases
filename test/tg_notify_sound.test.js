/**
 * test/tg_notify_sound.test.js —— v2.6.1138 补强
 *
 * 起因（老板 2026-10-16 拍板）：主进程那一级提示音走 Electron `shell.beep()`，
 * 但它的 API 存在性只做到了「类型定义里有」这一步（node_modules/electron/electron.d.ts:14018，
 * Electron 44.4.5），**实际出声与否没有真机验证**；而且它走 Windows MessageBeep，
 * 系统里把「系统声音/通知声音」静音就一起哑，代码里区分不出「没响」还是「系统静音」。
 * 所以加 WebAudio 兼底（渲染进程合成，不吃系统音量设置那一套）。
 *
 * 本文件只测这条提示音链路，不测系统通知气泡（那个要真 Windows 通知中心，自动化测不了）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; failures.push({ name, msg: e && e.message }); console.log('  ❌ ' + name + '\n     ' + (e && e.message)); }
}

const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const bridgeJs = fs.readFileSync(path.join(ROOT, 'src/electronBridge.js'), 'utf8');

/**
 * 按**花括号配平**抓一个函数的完整函数体。
 * ⚠️ 绝不能用 /\n\}/ 这种正则收尾 —— 函数体里有嵌套的 {}（try/catch、if），
 *    会提前截断，导致「明明写了 catch 却报没有 catch」的假失败（今天已踩）。
 */
function grabFn(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, '源码里找不到函数：' + signature);
  let depth = 0;
  const open = src.indexOf('{', start);
  assert.ok(open >= 0, signature + ' 没有花括号，不是函数');
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(signature + ' 花括号没配平，源码可能被截断');
}

const beepBody = grabFn(appJs, 'function tgBeep()');
const playNotifyBody = grabFn(mainJs, 'function playNotifySound()');
const playSoundBody = grabFn(bridgeJs, 'function playSound()');

/**
 * 剥掉注释再判「有没有引入某段代码」。
 * 🔴 铁律（今天又踩一次）：本项目的中文注释里经常**故意提到**被禁止的关键词
 *    （比如「绝不借 new_message / notice」这句话本身就含 new_message），
 *    不剥注释直接判必然假失败。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/^\s*\/\/.*$/gm, '')       // 行注释（整行都是//的）
    .replace(/\s+\/\/[^\n]*/g, '');     // 行尾注释（前导空白 + // 到行尾）
}

console.log('\n===== 0、先自证抓取器没截断（否则下面全是假结论）=====');
t('三个函数体都抓全了（抓到的行数合理、catch 都在）', () => {
  assert.ok(beepBody.split('\n').length >= 25, 'tgBeep 只抓到 ' + beepBody.split('\n').length + ' 行，疑似截断');
  assert.ok(playNotifyBody.includes('catch'), 'playNotifySound 没抓到 catch');
  assert.ok(playSoundBody.includes('catch'), 'playSound 没抓到 catch');
  assert.ok(beepBody.includes('catch'), 'tgBeep 没抓到 catch');
});

console.log('\n===== 一、主进程：开关判断 + 广播独立事件 =====');

t('playNotifySound 先看 telegram.notifySound（默认关）', () => {
  assert.ok(/cfg\.telegram\?\.notifySound !== true/.test(playNotifyBody), '开关判断不见了');
});
t('广播的是独立事件 notify_sound', () => {
  assert.ok(/broadcastSafe\('notify_sound'/.test(playNotifyBody), '没广播 notify_sound');
});
t('🔴 绝不借 new_message / notice（那些所有渠道共用，借了会串）', () => {
  // ⚠️ 必须剥注释再判 —— 函数注释里就写着「绝不借 new_message / notice」这句话
  const code = stripComments(playNotifyBody);
  assert.ok(!/broadcastSafe\('new_message'/.test(code), '借了 new_message');
  assert.ok(!/broadcastSafe\('notice'/.test(code), '借了 notice');
  assert.ok(!/new_message/.test(code), '代码里出现了 new_message');
});
t('开关判断排在广播之前（关掉就完全不出声）', () => {
  const gate = playNotifyBody.indexOf('notifySound !== true');
  const bc = playNotifyBody.indexOf("broadcastSafe('notify_sound'");
  assert.ok(gate >= 0 && bc > gate, '顺序不对：gate=' + gate + ' bc=' + bc);
});
t('整段被 try/catch 包住（提示层不打断入库）', () => {
  assert.ok(/try \{/.test(playNotifyBody) && /catch/.test(playNotifyBody), '没有 try/catch');
});

console.log('\n===== 二、前端：SSE 监听 + WebAudio 合成 =====');

t('监听了 notify_sound 事件', () => {
  assert.ok(/es\.addEventListener\('notify_sound'/.test(appJs), '前端没监听 notify_sound');
});
t('🔴 监听器里包了 try/catch（提示层失败不影响界面）', () => {
  const i = appJs.indexOf("es.addEventListener('notify_sound'");
  const chunk = appJs.slice(i, i + 300);
  assert.ok(/try \{/.test(chunk), '监听器里没有 try');
  assert.ok(/catch/.test(chunk), '监听器里没有 catch');
});
t('有 tgBeep 函数', () => {
  assert.ok(/function tgBeep\(\)/.test(appJs));
});
t('用 WebAudio 合成（AudioContext / webkitAudioContext 都认）', () => {
  assert.ok(/window\.AudioContext \|\| window\.webkitAudioContext/.test(beepBody), '没取 AudioContext');
  assert.ok(/createOscillator/.test(beepBody), '没用到振荡器');
  assert.ok(/createGain/.test(beepBody), '没用到增益');
});
t('🔴 不加载任何外部音频文件（打包漏文件会静默失败）', () => {
  assert.ok(!/new Audio\(/.test(beepBody), '不该用 new Audio');
  assert.ok(!/fetch\(/.test(beepBody), '不该去 fetch');
  assert.ok(!/\.wav|\.mp3|\.ogg/.test(beepBody), '不该引用音频文件');
});
t('处理了自动播放策略：suspended 时尝试 resume', () => {
  assert.ok(/suspended/.test(beepBody), '没判断 suspended 状态');
  assert.ok(/resume\(\)/.test(beepBody), '没尝试 resume');
});
t('用指数包络避免爆音/刺耳', () => {
  assert.ok(/exponentialRampToValueAtTime/.test(beepBody), '没做包络');
  assert.ok(/0\.0001/.test(beepBody), '起音没从接近 0 开始，会爆音');
});
t('全程 try/catch 且返回布尔', () => {
  assert.ok(/catch/.test(beepBody), 'tgBeep 没有 catch');
  assert.ok(/return true;/.test(beepBody), 'tgBeep 没有 return true');
  assert.ok(/return false;/.test(beepBody), 'tgBeep 没有 return false');
});
t('复用了同一个 AudioContext（每条消息新建会耗资源）', () => {
  assert.ok(/tgBeep\._ctx/.test(beepBody), 'AudioContext 没缓存复用');
});

console.log('\n===== 三、事件名两端必须对上 =====');
t("主进程 broadcastSafe('notify_sound') ↔ 前端 addEventListener('notify_sound'）", () => {
  const sent = (mainJs.match(/broadcastSafe\('notify_sound'/g) || []).length;
  const recv = (appJs.match(/addEventListener\('notify_sound'/g) || []).length;
  assert.ok(sent >= 1, '主进程没发');
  assert.strictEqual(sent, recv, '两端数量不一致：发 ' + sent + ' 收 ' + recv);
});

console.log('\n===== 四、一级（shell.beep）仍要留着做第一级 =====');
t('playSound 还在、仍用 shell.beep', () => {
  assert.ok(/function playSound\(\)/.test(bridgeJs));
  assert.ok(/e\.shell\.beep\(\)/.test(playSoundBody), '一级 beep 没了');
});
t('playNotifySound 仍然调 beep（先系统音、再 WebAudio 兼底）', () => {
  assert.ok(/electronBridge\.bridge\.playSound\(\)/.test(playNotifyBody), '没调 playSound');
});
t('beep 失败会退到写终端 BEL，不抛异常', () => {
  assert.ok(/catch/.test(playSoundBody), 'playSound 没有 catch');
  assert.ok(/write\(BEL\)/.test(playSoundBody), '没有 BEL 兜底');
});

console.log('\n===== 五、反向约束：不得牵连别的渠道 =====');
t('notify_sound 只有 main.js 在发', () => {
  const files = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
  const senders = files.filter((f) => {
    const s = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    return /broadcastSafe\('notify_sound'/.test(s);
  });
  assert.deepStrictEqual(senders, ['main.js'], '不止 main.js 在发：' + senders.join(','));
});
t('提示音不挂在 new_message 上（那条 WA/Signal 也会走）', () => {
  assert.ok(!/new_message/.test(stripComments(playNotifyBody)), 'playNotifySound 代码里出现了 new_message');
});

console.log('\n===== 六、回归：这一层不许弄坏之前修好的时间显示 =====');
t('tgBeep 没插进时间渲染路径（不碰 tgSplitTime / tg-time-box）', () => {
  assert.ok(!/tgSplitTime|tg-time-box|renderTgChat/.test(beepBody), 'tgBeep 混进了时间渲染逻辑');
});
t('时间同行方案仍在（.tg-line 还在两个渲染入口）', () => {
  assert.ok((appJs.match(/<div class="tg-line">/g) || []).length >= 2, '.tg-line 渲染入口少了');
  assert.ok(/function tgStripInvisible\(/.test(appJs), 'tgStripInvisible 不见了');
});
t('两条 error/unhandledrejection 监听器都在且各占一行（上次误删过换行，锁死）', () => {
  assert.ok(/addEventListener\('error'/.test(appJs), 'error 监听器不见了');
  assert.ok(/addEventListener\('unhandledrejection'/.test(appJs), 'unhandledrejection 监听器不见了');
  assert.ok(/addEventListener\('error'[^\n]*\n\s*window\.addEventListener\('unhandledrejection'/.test(appJs),
    '两个监听器被挤到同一行了');
});

console.log('\n=================================================');
console.log(`  通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n  失败明细：');
  for (const f of failures) console.log('· ' + f.name + ' → ' + f.msg);
}
console.log('=================================================\n');
process.exit(fail ? 1 : 0);
