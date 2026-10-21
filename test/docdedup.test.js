/**
 * 档案查重 / 合并（docDedup）单元测试
 *
 * 覆盖：
 *   - 新命名 编号_名称_电话.md 与旧命名 名称_地区_编号.md 的反解
 *   - 按电话号码扫描同人重复档案（文件名带电话 / 旧文件读文档头部）
 *   - 归并关系状态机 canonicalOf / mergedCodesOf / setGroup（含嵌套收编）
 *   - AI 合并的纯函数：cleanProfileObject（16 键白名单 + 阶段数值化）、promptMergeDocs（生成合并提示词）
 *
 * 运行：node --experimental-sqlite test/docdedup.test.js
 */

// 数据隔离：必须放最前，src/paths.js 在 require 那一刻解析数据目录
const { DIR } = require('./_isolate.js');
const fs = require('fs');
const path = require('path');

const docDedup = require('../src/docDedup');
const doc = require('../src/customerDoc');
const ai = require('../src/ai');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

const dir = doc.docsDir();
// 清空目录，保证每次都是干净起点
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
  try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
}

/* ============================================================
 * 1. 文件名解析：新格式 / 旧格式 / 非法
 * ============================================================ */
eq('解析新命名', docDedup_parse('3A00050_Mike_1534685245.md'), { code: '3A00050', name: 'Mike', phone: '1534685245', legacy: false });
eq('解析旧命名', docDedup_parse('Mike_旧金山_3A00050.md'), { code: '3A00050', name: 'Mike', region: '旧金山', phone: '', legacy: true });
eq('解析不了的非档案文件', doc.parseDocFileName('notes.md'), null);
// 这里用 customerDoc.parseDocFileName 暴露的能力；docDedup 内部也走它
function docDedup_parse(f) { return doc.parseDocFileName(f); }

/* ============================================================
 * 2. docFileName 新格式
 * ============================================================ */
eq('docFileName 新格式', doc.docFileName({ code: '3A00050', name: 'Mike', phone: '1534685245' }), '3A00050_Mike_1534685245.md');
eq('docFileName 缺名称/电话兜底', doc.docFileName({ code: '1A00001' }), '1A00001_未命名_未知电话.md');
eq('docFileName 清洗非法字符', doc.docFileName({ code: '3A00050', name: 'A/B:C*D?', phone: '+1 (541) 801-0646' }), '3A00050_ABCD_+15418010646.md');

/* ============================================================
 * 3. 按电话扫描重复档案
 * ============================================================ */
// 两份新命名（电话都在文件名里）+ 一份旧命名（电话在文档头部）+ 一份不匹配
fs.writeFileSync(path.join(dir, '3A00050_Mike_1534685245.md'),
  '# Mike\n| 电话号码 | 1534685245 |\n## 对话记录\n');
fs.writeFileSync(path.join(dir, '1A00001_Alice_1534685245.md'),
  '# Alice\n| 电话号码 | 1534685245 |\n## 对话记录\n');
fs.writeFileSync(path.join(dir, 'OldWang_北京_5A00005.md'),
  '# OldWang\n| 电话号码 | 1534685245 |\n## 对话记录\n'); // 旧命名，电话在头部
fs.writeFileSync(path.join(dir, '2A00002_Bob_19999999999.md'),
  '# Bob\n| 电话号码 | 19999999999 |\n## 对话记录\n');

const hits = docDedup.scanDocsByPhone('1534685245');
eq('按电话扫到 3 份（2 新 + 1 旧格式）', hits.length, 3);
check('扫到的都带正确 code', hits.every((h) => ['3A00050', '1A00001', '5A00005'].includes(h.code)), JSON.stringify(hits.map(h => h.code)));

const hitsExcl = docDedup.scanDocsByPhone('1534685245', { excluding: '3A00050' });
eq('排除当前编号后只扫到 2 份', hitsExcl.length, 2);

eq('无关电话扫不到', docDedup.scanDocsByPhone('19999999999').length, 1);
eq('太短/无效电话返回空', docDedup.scanDocsByPhone('12').length, 0);

/* ============================================================
 * 4. 归并状态机：canonicalOf / mergedCodesOf / setGroup（含嵌套收编）
 * ============================================================ */
docDedup.setGroups({});
docDedup.setGroup('3A00003', ['3A00050', '2A00002']);
eq('canonicalOf 被并编号 -> 保留编号', docDedup.canonicalOf('3A00050'), '3A00003');
eq('canonicalOf 保留编号自身', docDedup.canonicalOf('3A00003'), '3A00003');
eq('canonicalOf 未并过的编号 -> null', docDedup.canonicalOf('9A00009'), null);
eq('mergedCodesOf 列出并入的编号', docDedup.mergedCodesOf('3A00003'), ['3A00050', '2A00002']);

// 嵌套收编：4A00004 自己也是一组（含 4A00005），把它并进 3A00003 时应一起收编
docDedup.setGroups({ '4A00004': ['4A00005'] });
docDedup.setGroup('3A00003', ['4A00004']);
eq('嵌套收编：被并组的成员一起并进', docDedup.mergedCodesOf('3A00003'), ['4A00004', '4A00005']);
eq('嵌套收编：旧组头身份注销', docDedup.canonicalOf('4A00004'), '3A00003');
eq('嵌套收编：深层成员也归到新保留编号', docDedup.canonicalOf('4A00005'), '3A00003');

/* ============================================================
 * 5. AI 合并纯函数（不调真接口）
 * ============================================================ */
const cleaned = ai.cleanProfileObject({
  姓名: '王', 电话号码: '1534685245', 爱好: '钓鱼', 阶段: '2', foo: 'bar', 乱写: 'x',
});
eq('cleanProfileObject 只留 16 白名单键', Object.keys(cleaned).sort(),
  ['姓名', '电话号码', '爱好', '阶段'].sort());
eq('cleanProfileObject 阶段被数值化', cleaned.阶段, 2);
check('cleanProfileObject 丢弃非法键', !('foo' in cleaned) && !('乱写' in cleaned), JSON.stringify(cleaned));

// 英文键别名也认
const cleanedEn = ai.cleanProfileObject({ name: 'Wang', phone: '1534685245', hobby: 'fishing' });
eq('cleanProfileObject 认英文别名', cleanedEn.姓名, 'Wang');
check('cleanProfileObject 英文别名映射', cleanedEn.电话号码 === '1534685245' && cleanedEn.爱好 === 'fishing', JSON.stringify(cleanedEn));

const pm = ai.promptMergeDocs([
  { file: '3A00050_Mike_1534685245.md', code: '3A00050', text: '某客户档案内容…' },
  { file: '1A00001_Alice_1534685245.md', code: '1A00001', text: '另一份同人档案…' },
]);
check('promptMergeDocs 返回 system 文案', typeof pm.system === 'string' && pm.system.includes('合并'), '');
check('promptMergeDocs 返回 user 文案含 JSON 指令', typeof pm.user === 'string' && pm.user.includes('JSON'), '');
check('promptMergeDocs 预算走 TOKENS.mergeDocs', typeof pm.maxTokens === 'number' && pm.maxTokens > 0, String(pm.maxTokens));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
