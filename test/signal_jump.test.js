/**
 * Signal 跳转（signalJump.jumpViaCdp）单测 —— v2.5.1062
 *
 * 验证老板 2026-10-12 裁定后的三步流程：
 *   ① 先激活窗口（bringToFront 必须先于搜索）
 *   ② 搜索（填搜索框）
 *   ③ 确认 = 输完文字回车（必须真正发出一次 Enter，且排在搜索之后）
 * 以及：三步都走完就返回 ok:true（不再因「点不到第一条结果」而谎报失败）。
 *
 * 由于沙箱里没有真的 Signal / puppeteer，这里注入一个假 puppeteer，
 * 把 page.evaluate / keyboard.press 等调用按真实顺序录下来做断言。
 */
const path = require('path');
const sig = require('../src/signalJump');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; /* console.log('  PASS', name); */ }
  else { fail++; fails.push(name + (extra ? '  >> ' + extra : '')); console.log('  FAIL', name, extra || ''); }
}

/** 造一个假 page：evaluate 按调用次数返回 canned 值；所有动作按真实顺序记进 log */
function fakePage(fillReturn) {
  const log = [];
  let evalN = 0;
  const page = {
    log,
    bringToFront() { log.push('bringToFront'); return Promise.resolve(); },
    evaluate(fn, sels, kw) {
      evalN++;
      if (evalN === 1) { log.push('evaluate:fill'); return Promise.resolve(fillReturn); } // 填搜索框
      if (evalN === 2) { log.push('evaluate:focus'); return Promise.resolve(); }          // 回车前聚焦
      log.push('evaluate:click'); return Promise.resolve(false);                            // 兜底点结果
    },
    keyboard: {
      down() { log.push('keyboard.down'); return Promise.resolve(); },
      up() { log.push('keyboard.up'); return Promise.resolve(); },
      press(k) { log.push('keyboard.press:' + k); return Promise.resolve(); },
      type() { log.push('keyboard.type'); return Promise.resolve(); },
    },
  };
  return page;
}

function fakePuppeteer(fillReturn) {
  const page = fakePage(fillReturn);
  return {
    page,
    connect() {
      return Promise.resolve({
        pages() { return Promise.resolve([page]); },
        disconnect() { return Promise.resolve(); },
      });
    },
  };
}

function idx(log, tag) { return log.indexOf(tag); }

(async () => {
  console.log('===== signalJump 三步流程单测 =====');

  // 场景一：搜索框能填进去（正常路径）→ 必须 bringToFront 先于 fill，且后面发了 Enter，最终 ok:true
  {
    const pp = fakePuppeteer(true);
    sig.setPuppeteerForTest(pp);
    const r = await sig.jumpViaCdp(9333, { name: 'Dio' });
    const log = pp.page.log;
    check('激活窗口(bringToFront)发生在搜索(fill)之前',
      idx(log, 'bringToFront') >= 0 && idx(log, 'evaluate:fill') > idx(log, 'bringToFront'),
      JSON.stringify(log));
    check('填完搜索框之后发了回车(Enter)',
      idx(log, 'keyboard.press:Enter') > idx(log, 'evaluate:fill'),
      JSON.stringify(log));
    check('回车用的是 Enter 键（不是别的）',
      log.includes('keyboard.press:Enter'), JSON.stringify(log));
    check('三步走完返回 ok:true', r && r.ok === true, JSON.stringify(r));
    check('返回里带 confirmed:true 标记', r && r.confirmed === true, JSON.stringify(r));
    check('located 标 true（确实定位到对话）', r && r.located === true, JSON.stringify(r));
  }

  // 场景二：搜索框选择器没匹配上 → 走 Ctrl+K 兜底敲字，但同样要发回车，且最终仍 ok:true
  {
    const pp = fakePuppeteer(false); // fill 返回 false → 触发 Ctrl+K 分支
    sig.setPuppeteerForTest(pp);
    const r = await sig.jumpViaCdp(9334, { name: '土豆的铲屎官' });
    const log = pp.page.log;
    check('兜底路径也先激活了窗口', idx(log, 'bringToFront') >= 0, JSON.stringify(log));
    check('兜底路径走了 Ctrl+K（keyboard.down 存在）', log.includes('keyboard.down'), JSON.stringify(log));
    check('兜底路径敲了字（keyboard.type）', log.includes('keyboard.type'), JSON.stringify(log));
    check('兜底路径也发了回车(Enter)', idx(log, 'keyboard.press:Enter') > 0, JSON.stringify(log));
    check('兜底路径最终也 ok:true', r && r.ok === true, JSON.stringify(r));
  }

  // 场景三：没有关键字 → 直接失败，不应该去连 CDP
  {
    const pp = fakePuppeteer(true);
    sig.setPuppeteerForTest(pp);
    const r = await sig.jumpViaCdp(9333, { name: '' });
    check('没关键字直接返回 no-keyword，不连 CDP', r && r.ok === false && r.reason === 'no-keyword', JSON.stringify(r));
    check('没关键字时不发任何键盘事件', !pp.page.log.some((x) => x.startsWith('keyboard')), JSON.stringify(pp.page.log));
  }

  // 恢复生产 puppeteer（置空注入）
  sig.setPuppeteerForTest(null);

  console.log(`\n===== signal_jump 单测：${pass} 通过 / ${fail} 失败 =====`);
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
})();
