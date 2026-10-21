/**
 * 语种小工具：判断一条消息"要不要翻译成中文"
 *
 * 规则很简单，但足够用（客户都在美国，英文为主）：
 *   1. 一个拉丁字母都没有        → 不用翻（例如：中文、数字、表情、[图片/附件] 占位）
 *   2. 中文字数量 ≥ 拉丁字母数量  → 本来就是中文，不用翻（原样显示）
 *   3. 其余（英文占多数）        → 需要翻
 *
 * 为什么不做更"聪明"的判断：翻译是我们自己花钱调 AI，
 * 宁可少翻几条也不要把客户发的中文再翻一遍（浪费钱还容易翻错意思）。
 * 判断错了也没关系——界面上「等待翻译中」会自动消失，不需要用户做任何操作。
 */

/** 中文字（含扩展 A 区）数量 */
function countCJK(s) {
  const m = String(s == null ? '' : s).match(/[\u3400-\u4dbf\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

/** 英文字母数量（含重音拉丁字母，欧洲客户的姓名里常有） */
function countLatin(s) {
  const m = String(s == null ? '' : s).match(/[A-Za-z\u00c0-\u024f]/g);
  return m ? m.length : 0;
}

/** 像一长串 base64（图片/语音等媒体字节被误塞进 body）？这种不能当文本翻，翻出来就是「抱歉，只有一串乱码…」 */
function looksLikeBase64Garbage(s) {
  const t = String(s == null ? '' : s).trim();
  if (t.startsWith('data:')) return true;
  // 长度够长、且全是 base64 字符（字母/数字/+/=/空白，不含标点）→ 是媒体字节，不是人话
  return t.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(t);
}

/** 需要翻译吗？ */
function needsTranslation(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  if (looksLikeBase64Garbage(t)) return false;  // 媒体字节（base64）误进 body，绝不当文本翻
  const cjk = countCJK(t);
  const latin = countLatin(t);
  if (latin === 0) return false;   // 规则 1
  return cjk < latin;              // 规则 2 / 3
}

/** 看起来就是中文吗？（用于界面上标一句"原文是中文，不用翻"） */
function looksChinese(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  const cjk = countCJK(t);
  return cjk > 0 && cjk >= countLatin(t);
}

/**
 * 拿不准吗？（中英混着写、字数还差不多）
 *
 * 拿不准的才会去问 ② 翻译那一步的 AI（用同一家模型）。规则是【只加不减】：
 * AI 说"要翻"就补一条翻译；AI 说"不用翻"就维持正则原本的判断（不会取消该翻的）。
 *
 * 注意：这跟 ① 接收信息无关 —— 收消息只管把消息抓下来入库，不看语种。
 */
function isAmbiguous(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  const cjk = countCJK(t);
  const latin = countLatin(t);
  if (!cjk || !latin) return false;          // 纯中文 / 纯外文，一点都不用问
  if (cjk + latin > 60) return false;        // 长句子里混几个字母很正常，别浪费钱
  return Math.abs(cjk - latin) <= 2;
}

module.exports = { countCJK, countLatin, needsTranslation, looksChinese, isAmbiguous };
