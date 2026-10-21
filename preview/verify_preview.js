/**
 * 用 jsdom 跑一遍预览页，确认界面真的渲染出来了（不是白屏）
 * 跑法：NODE_PATH=E:/WorkBuddy-Projects/.node-libs/node_modules node preview/verify_preview.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const file = path.join(__dirname, '蜜蜂信息采集_界面预览.html');
const html = fs.readFileSync(file, 'utf8');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  << ' + extra}`);
  cond ? pass++ : fail++;
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:8787/',
  virtualConsole: vc,
});

const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
const txt = (id) => ($(id) ? $(id).textContent.replace(/\s+/g, ' ').trim() : '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(1500); // 等自动打开客户 + 自动出建议

  console.log('=== 顶栏 ===');
  check('待处理数已渲染', /待处理 \d/.test(txt('pending')), txt('pending'));
  check('账号状态已渲染', txt('accounts').includes('1号'), txt('accounts'));
  check('AI 状态已渲染', txt('status').includes('AI'), txt('status'));

  console.log('\n=== 手动录入面板 ===');
  check('面板默认展开（预览用）', $('ingest') && !$('ingest').className.includes('hidden'), $('ingest')?.className);
  check('标识输入框存在', !!$('ig-ident'));
  check('多行文本框存在', !!$('ig-text'));
  check('录入按钮存在', !!$('ig-send'));

  console.log('\n=== 录入面板：每个框都说明了是干嘛的 ===');
  const ing = txt('ingest');
  check('每个输入框都有标签', doc.querySelectorAll('#ingest .ig-label').length >= 4, String(doc.querySelectorAll('#ingest .ig-label').length));
  check('粘贴框有专门说明', ing.includes('一行算一条消息'), ing.slice(0, 200));
  check('说明讲清了「我:」的规则', ing.includes('我:') && ing.includes('你发的'), ing.slice(0, 300));
  check('说明讲清了其余算客户发的', ing.includes('客户发的'), ing.slice(0, 300));
  check('客户标识提醒同一个人要一致', ing.includes('同一个人每次必须填一样的'), ing.slice(0, 300));
  check('地区说明会带出时区', ing.includes('时区'), ing.slice(0, 300));
  check('有加入时间输入框', !!$('ig-joined'), '');
  check('加入时间说明补老客户', ing.includes('真正加你的日期'), ing.slice(0, 300));
  check('提示 Ctrl+Enter', ing.includes('Ctrl + Enter'), ing.slice(0, 400));
  check('文本框里有示例', ($('ig-text')?.placeholder || '').includes('我:'), $('ig-text')?.placeholder);

  console.log('\n=== 客户列表 ===');
  check('渲染出 3 个客户', doc.querySelectorAll('.cust').length === 3, String(doc.querySelectorAll('.cust').length));
  check('有 2 个红点', doc.querySelectorAll('.cust.pending').length === 2, String(doc.querySelectorAll('.cust.pending').length));
  check('列表含客户名', txt('list').includes('Daniel Brooks'));

  console.log('\n=== 对话区 ===');
  check('渲染出气泡', doc.querySelectorAll('#msgs .bubble').length === 5, String(doc.querySelectorAll('#msgs .bubble').length));
  check('有中文翻译层', doc.querySelectorAll('#msgs .zh').length > 0, String(doc.querySelectorAll('#msgs .zh').length));
  check('有 out 方向气泡', doc.querySelectorAll('#msgs .bubble.out').length > 0);
  check('头部有客户名', txt('chat-head').includes('Daniel Brooks'), txt('chat-head'));
  // 2026-09-25 第三轮：档案条固定两行 + ★认识第N天★ + 紫色 Day 标记；两个按钮横排
  check('档案条分成两行（.fact-row × 2）',
    doc.querySelectorAll('#chat-head .ch-facts .fact-row').length === 2,
    String(doc.querySelectorAll('#chat-head .ch-facts .fact-row').length));
  check('第一行是「加入时间 + 认识第 N 天」，第二行是「地区 + 客户当地时间」', (() => {
    const rows = [...doc.querySelectorAll('#chat-head .ch-facts .fact-row')].map((x) => x.textContent.replace(/\s+/g, ' '));
    return rows.length === 2 && /加入时间/.test(rows[0]) && /认识第 \d+ 天/.test(rows[0]) && !/客户当地时间/.test(rows[0])
      && /地区/.test(rows[1]) && /客户当地时间/.test(rows[1]);
  })(), JSON.stringify([...doc.querySelectorAll('#chat-head .ch-facts .fact-row')].map((x) => x.textContent.replace(/\s+/g, ' '))));
  check('「认识第 N 天」前后各一个五角星',
    doc.querySelectorAll('#chat-head .ch-facts .fact-know .star').length === 2, '');
  check('「认识第 N 天」右边有 Day 标记',
    /Day \d+/.test(txt('chat-head')), txt('chat-head').slice(0, 200));
  check('两个按钮横排（客户档案在左、从对话里提取档案在右）', (() => {
    const a = $('ch-doc');
    const b = $('ch-extract');
    if (!a || !b) return false;
    // jsdom 不做排版（getBoundingClientRect 恒为 0），只能比文档顺序
    return (a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING) > 0;
  })(), '');

  console.log('\n=== 档案卡（极简 6 字段）===');
  check('姓名输入框有值', $('pf-name') && $('pf-name').value === 'Daniel Brooks', $('pf-name')?.value);
  check('时区自动带出', $('pf-tz') && $('pf-tz').value.includes('Los_Angeles'), $('pf-tz')?.value);
  check('阶段显示 Day 4', $('pf-stage') && $('pf-stage').value === '4', $('pf-stage')?.value);
  check('有电话号码输入框', !!$('pf-phone'), '');
  check('有地区输入框', !!$('pf-region'), $('pf-region')?.value);

  console.log('\n=== 档案：加入时间 ===');
  check('有加入时间输入框', !!$('pf-joined'), '');
  check('加入时间有值', ($('pf-joined')?.value || '').length >= 10, $('pf-joined')?.value);
  check('显示认识第几天', /认识第 \d+ 天/.test(txt('profile')), txt('profile').slice(0, 200));
  check('显示时间来源', txt('profile').includes('自动') || txt('profile').includes('手填'), txt('profile').slice(0, 200));

  console.log('\n=== 档案：只有 6 个字段（不放情绪 / 爱好 / 动机等）===');
  const pf = txt('profile');
  check('正好 6 个字段框', doc.querySelectorAll('#profile .field').length === 6,
    String(doc.querySelectorAll('#profile .field').length));
  check('六个标签都在（加入时间 / 姓名 / 电话号码 / 地区 / 时区 / 阶段）',
    ['加入时间', '姓名', '电话号码', '地区', '时区', '阶段'].every((g) => pf.includes(g)), pf.slice(0, 300));
  check('旧富档案字段已经清干净（宠物主角 / 动机 / 摆放位置 / 情绪）',
    !['宠物主角', '动机', '摆放位置', '情绪温度'].some((g) => pf.includes(g)), pf.slice(0, 300));
  check('「保存档案」在弹窗最上面（.pf-topbar 里，排在档案表 #profile 之前）', (() => {
    const s = $('pf-save');
    const p = $('profile');
    const bar = doc.querySelector('.pf-topbar');
    if (!s || !p || !bar || !bar.contains(s)) return false;
    // jsdom 不做排版（getBoundingClientRect 恒为 0），只能比文档顺序
    return (bar.compareDocumentPosition(p) & window.Node.DOCUMENT_POSITION_FOLLOWING) > 0;
  })(), $('pf-save') ? 'pf-save 不在 .pf-topbar 里 / 不在 #profile 之前' : '没有 #pf-save');
  check('「客户档案 / 从对话里提取档案」在中栏头部右端（弹窗里和左栏客户行里都没有）',
    !$('btn-extract') && doc.querySelectorAll('#chat-head .ch-doc-col #ch-doc').length === 1
    && doc.querySelectorAll('#chat-head .ch-doc-col #ch-extract').length === 1
    && doc.querySelectorAll('#list-body button').length === 0,
    `头部 ${doc.querySelectorAll('#chat-head .ch-doc-col button').length} 个 / 左栏 ${doc.querySelectorAll('#list-body button').length} 个`);
  check('档案条末尾那个重复的「客户档案 ↗」已经删掉', !$('ch-open-profile'), '');

  // 注意：点提取会重新拉客户数据，建议区会被清掉（和真跑起来一样），所以放在建议测试之后

  console.log('\n=== 建议区 ===');
  const out = txt('suggest-out');
  check('出三条建议', doc.querySelectorAll('#suggest-out .opt').length === 3, String(doc.querySelectorAll('#suggest-out .opt').length));
  check('带角度标签', out.includes('共情') && out.includes('故事'), out.slice(0, 120));
  check('显示 Day 条', out.includes('Day 4'), out.slice(0, 160));
  check('显示理由', out.includes('理由'), out.slice(0, 260));
  check('显示自查', out.includes('自查'), out.slice(0, 320));
  check('显示话术库计数', out.includes('已记住'), out.slice(-140));
  check('有 3 个采纳按钮', doc.querySelectorAll('#suggest-out .adopt').length === 3);
  check('有 3 个不要这条按钮', doc.querySelectorAll('#suggest-out .rej').length === 3);
  check('有换一批按钮', !!$('btn-again'));
  check('有理由输入框', !!$('rej-reason'));

  console.log('\n=== 换思路 ===');
  $('rej-reason').value = '太早了，他现在只想说话';
  $('btn-again').click();
  await wait(300);
  const out2 = txt('suggest-out');
  check('换了新一批三条', doc.querySelectorAll('#suggest-out .opt').length === 3, String(doc.querySelectorAll('#suggest-out .opt').length));
  check('新一批内容不同', !out2.includes('13 岁，一整辈子都在你家'), out2.slice(0, 160));
  check('换批后有理由', out2.includes('理由'), out2.slice(0, 200));

  console.log('\n=== 采纳面板 ===');
  doc.querySelector('#suggest-out .adopt').click();
  const box = doc.querySelector('#suggest-out .opt');
  check('展开可编辑文本框', !!box.querySelector('textarea.edit'), box.innerHTML.slice(0, 100));
  check('文本框里有原话', (box.querySelector('textarea.edit')?.value || '').length > 5, box.querySelector('textarea.edit')?.value);
  check('有备注输入', !!box.querySelector('input.note'));
  check('有记住按钮', !!box.querySelector('.save'));

  console.log('\n=== 切到 Dio：手填的加入时间 ===');
  const dioEl = doc.querySelector('.cust[data-code="1A00007"]');
  check('列表里有 Dio', !!dioEl, [...doc.querySelectorAll('.cust')].map((e) => e.dataset.code).join(','));
  if (dioEl) {
    dioEl.click();
    await wait(400);
    const pf2 = txt('profile');
    check('切过去后姓名是 Dio', $('pf-name')?.value === 'Dio', $('pf-name')?.value);
    check('来源显示「手填」', pf2.includes('手填'), pf2.slice(0, 200));
    check('认识天数接近 89', /认识第 8[5-9] 天/.test(pf2), pf2.slice(0, 200));
    // 字段值在 input 的 value 里（textContent 拿不到），所以要单独读一遍
    const pfVals = [...doc.querySelectorAll('#profile input')]
      .map((x) => x.value || '').join('\n');
    check('六个字段的值都读得出来（Dio / 俄勒冈 / 时区）',
      pfVals.includes('Dio') && pfVals.includes('俄勒冈') && pfVals.includes('Los_Angeles'), pfVals.slice(0, 200));
    check('档案里不再有富档案那一堆字段（宠物主角 / 要避开的雷 / 下一步）',
      !/宠物主角|要避开的雷|下一步/.test(pf2), pf2.slice(0, 200));
  }

  console.log('\n=== 运行时错误 ===');
  check('没有 JS 运行时错误', errors.length === 0, errors.join(' | ').slice(0, 300));

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})();
