/**
 * 教练引擎 + 采纳记忆库测试
 * 不联网、不需要 API key。
 * 跑法：node --experimental-sqlite test/coach.test.js
 */

const path = require('path');
const assert = require('assert');

// 数据隔离：本测试只写临时目录，绝不碰真实 data/
require('./_isolate.js');

const db = require('../src/db');
const learn = require('../src/learn');
const coach = require('../src/coach');

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  << ' + extra}`);
  cond ? pass++ : fail++;
}

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`);
}

const CODE = '9A90001';
const mk = (direction, body, bodyZh = '', media = null) => ({
  direction,
  body,
  body_zh: bodyZh,
  media_path: media,
});

console.log('===== 阶段判定 =====');

// 一条客户消息 => Day 0
eq('只有一条客户消息 → Day 0', coach.inferDay({ stage_day: 0 }, [mk('in', 'hi')]).day, 0);

// 手动优先
eq('手动 stage_day=5 优先于自动判定', coach.inferDay({ stage_day: 5 }, [mk('in', 'hi')]).day, 5);
eq('手动判定 source=manual', coach.inferDay({ stage_day: 5 }, [mk('in', 'hi')]).source, 'manual');

// 轮次兜底
eq('3 条客户消息 → Day 1', coach.inferDay({ stage_day: 0 }, [mk('in', 'a'), mk('in', 'b'), mk('in', 'c')]).day, 1);
eq('5 条客户消息 → Day 2', coach.inferDay({ stage_day: 0 }, Array(5).fill(0).map((_, i) => mk('in', 'm' + i))).day, 2);

// 信号顶格
const photoDay = coach.inferDay({ stage_day: 0 }, [mk('in', 'hi'), mk('in', 'here is a photo of Max', '', 'media/x.jpg')]);
eq('发来图片 → 顶到 Day 2', photoDay.day, 2);

const videoDay = coach.inferDay({ stage_day: 0 }, [mk('in', 'sure we can do a video call tonight')]);
eq('提到视频通话 → 顶到 Day 3', videoDay.day, 3);
check('视频信号被记录', videoDay.signals.some((s) => s.key === 'video'), JSON.stringify(videoDay.signals));

const motiveDay = coach.inferDay({ stage_day: 0 }, [mk('in', 'its a gift for my mom, her birthday is in march')]);
eq('说出送礼动机 → 顶到 Day 4', motiveDay.day, 4);

const specDay = coach.inferDay({ stage_day: 0 }, [mk('in', 'what size do you recommend, maybe 16 inch')]);
eq('聊到尺寸 → 顶到 Day 5', specDay.day, 5);

const dealDay = coach.inferDay({ stage_day: 0 }, [mk('in', 'how do I pay, can I use zelle')]);
eq('聊到付款 → 顶到 Day 6', dealDay.day, 6);

const doneDay = coach.inferDay({ stage_day: 0 }, [mk('in', 'ok lets start, sending deposit now')]);
eq('确认开工 → 顶到 Day 7', doneDay.day, 7);

// 中文信号
const zhDay = coach.inferDay({ stage_day: 0 }, [mk('in', '这是我妈妈的生日礼物', '想定制一幅')]);
eq('中文信号也能命中（纪念/生日）', zhDay.day >= 4, true);

// 不会超过 7
eq('阶段上限 7', coach.inferDay({ stage_day: 99 }, [mk('in', 'hi')]).day, 7);

console.log('\n===== 角度选择 =====');

eq('Day 0 首选角度', coach.pickAngles(0, {}).slice(0, 3), ['curiosity', 'share', 'humor']);
eq('Day 6 首选角度', coach.pickAngles(6, {}).slice(0, 3), ['close', 'reassure', 'nudge']);
eq('Day 7 含退让', coach.pickAngles(7, {}).includes('retreat'), true);
eq('exclude 生效', coach.pickAngles(0, { exclude: ['curiosity'] }).includes('curiosity'), false);
check('9 个角度全覆盖', coach.pickAngles(3, {}).length <= 9, String(coach.pickAngles(3, {}).length));

console.log('\n===== 关键词与相似度 =====');

const kw = learn.keywords('My golden retriever Max passed away last year 我的金毛去年过世了');
check('英文词被抽出', kw.includes('golden') && kw.includes('retriever'), JSON.stringify(kw));
check('中文二字组被抽出', kw.some((k) => /[\u4e00-\u9fa5]/.test(k)), JSON.stringify(kw));
check('停用词被过滤', !kw.includes('the') && !kw.includes('的'), JSON.stringify(kw));

const s1 = learn.similarity(['cat', '照片'], ['cat', '照片']);
const s2 = learn.similarity(['cat', '照片'], ['dog', '价格']);
eq('完全相同 → 1', s1, 1);
eq('完全不同 → 0', s2, 0);
check('部分重叠在 0–1 之间', learn.similarity(['cat', '照片', '画'], ['cat', '画']) > 0, '');
eq('空集合 → 0', learn.similarity([], ['a']), 0);

console.log('\n===== 采纳记忆库 =====');

// 先清掉这个测试客户的历史，避免重复跑时互相干扰
db.db.prepare('DELETE FROM learned WHERE source_code=?').run(CODE);
db.db.prepare('DELETE FROM rejected WHERE source_code=?').run(CODE);

const a1 = learn.recordAdopt({
  angle: 'empathy',
  day: 4,
  scene: 'my cat passed away last month 我的猫上个月过世了',
  text: '我懂那种感觉，我家哆咪走的时候我也画了一幅。',
  note: '共情先于一切',
  customerCode: CODE,
});
check('采纳写入成功', a1 && a1.id > 0, JSON.stringify(a1));
eq('首次写入 dedup=false', a1.dedup, false);

const a2 = learn.recordAdopt({
  angle: 'empathy',
  day: 4,
  scene: 'my cat passed away last month 我的猫上个月过世了',
  text: '我懂那种感觉，我家哆咪走的时候我也画了一幅。',
  customerCode: CODE,
});
eq('同一客户同一句重复采纳 → dedup=true', a2.dedup, true);
eq('去重后总数仍为 1', learn.listLearned().filter((r) => r.source_code === CODE).length, 1);

learn.recordAdopt({
  angle: 'story',
  day: 2,
  scene: 'can you show me your work 想看看你的作品',
  text: '这张我画了三周，光眼睛就返工了四次。',
  customerCode: CODE,
});
eq('第二句采纳后总数 2', learn.listLearned().filter((r) => r.source_code === CODE).length, 2);

eq('空文本不入库', learn.recordAdopt({ text: '   ', customerCode: CODE }), null);

// 相似场景检索
const ex = learn.findExemplars('my cat passed away 我的猫过世了', { limit: 4 });
check('相似场景能检索到采纳过的思路', ex.length > 0, JSON.stringify(ex.map((e) => e.row.text)));
check('最相关的是共情那条', ex[0].row.angle === 'empathy', ex[0] ? ex[0].row.angle : 'none');

const ex2 = learn.findExemplars('completely unrelated topic about quantum physics 量子物理', { limit: 4 });
eq('不相关场景检索为空', ex2.length, 0);

// 同阶段加权
const ex3 = learn.findExemplars('some painting work 画作', { day: 2, limit: 4 });
check('指定 Day 2 时故事条被加权', ex3.length > 0 && ex3[0].row.day === 2, JSON.stringify(ex3.map((e) => [e.row.day, e.score])));

console.log('\n===== 不采纳 =====');

learn.recordReject({
  angle: 'nudge',
  day: 1,
  scene: 'just saying hi 刚打招呼',
  text: '要不要现在定尺寸？',
  reason: '太早了',
  customerCode: CODE,
});
eq('不采纳入库', learn.listRejected().filter((r) => r.source_code === CODE).length, 1);
eq('nudge 角度被拒 1 次', learn.rejectCountOfAngle('nudge'), 1);

const rj = learn.findRejections('hi 打招呼', { limit: 4 });
check('能检索到被否的样本', rj.length > 0, JSON.stringify(rj.map((r) => r.row.text)));

// 被否 3 次以上的角度会被压掉
learn.recordReject({ angle: 'nudge', scene: 'x', text: '第二条', customerCode: CODE });
learn.recordReject({ angle: 'nudge', scene: 'x', text: '第三条', customerCode: CODE });
eq('nudge 被拒 3 次', learn.rejectCountOfAngle('nudge'), 3);
eq('被拒 3 次后从角度池移除', coach.pickAngles(5, {}).includes('nudge'), false);

console.log('\n===== 教练上下文组装 =====');

const block = coach.buildCoachBlock({
  day: 4,
  angles: ['empathy', 'story'],
  scene: 'my cat passed away 我的猫过世了',
});

check('含当前阶段', block.includes('Day 4'), block.slice(0, 80));
check('含今日目标', block.includes('摸清他为什么想要这幅画'), '');
check('含本轮角度', block.includes('empathy') && block.includes('共情'), '');
check('含采纳过的范例区', block.includes('你以前采纳过的思路'), block.slice(0, 400));
check('含被否的负面清单', block.includes('这些路子被否过'), block.slice(0, 600));
check('负面清单含具体句子', block.includes('要不要现在定尺寸'), '');

const emptyBlock = coach.buildCoachBlock({ day: 0, angles: ['curiosity'], scene: '' });
check('无范例时不输出范例区', !emptyBlock.includes('你以前采纳过的思路'), emptyBlock);

console.log('\n===== 统计 =====');

const st = learn.stats();
check('统计含 learned 数', typeof st.learned === 'number' && st.learned >= 2, JSON.stringify(st));
check('统计含 rejected 数', typeof st.rejected === 'number' && st.rejected >= 3, JSON.stringify(st));
check('按角度分组', Array.isArray(st.byAngle) && st.byAngle.length > 0, JSON.stringify(st.byAngle));

// 清理测试客户的数据
db.db.prepare('DELETE FROM learned WHERE source_code=?').run(CODE);
db.db.prepare('DELETE FROM rejected WHERE source_code=?').run(CODE);
eq('清理后 learned 为空', learn.listLearned().filter((r) => r.source_code === CODE).length, 0);
eq('清理后 rejected 为空', learn.listRejected().filter((r) => r.source_code === CODE).length, 0);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
