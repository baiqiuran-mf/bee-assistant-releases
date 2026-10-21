/**
 * 扫描图片模型（2026-10-20 v2.6.1171）
 *
 * 「全局设置 → AI 设置 → 专项 AI → 扫描图片」下拉，选的是**服务商 key**
 * （siliconflow_ocr / chatanywhere / api2gpt / qianduoduo / no1apipro / zhichuang）。
 * 空串 = 跟随视觉任务默认（tasks.vision）。
 *
 * 为什么单独一个模块，而不是塞进 ai.js：
 *   这是「用哪家视觉模型扫描客户发来的图」**一个开关**，和 ai.js 的「任务目录 / 服务商目录」
 *   不是一回事。media.js 的看图逻辑只想知道"老板指定的是哪家"，别的都不关心。
 *
 * 内存值由 main.js 启动时、server.js 保存时注入（与 ai.setAiConfig 同一套做法），
 * media.js 每次取到的都是新的，不读盘、不用重启。
 */

/** 当前选中的服务商 key；'' = 跟随视觉任务默认 */
let _model = '';

/** 直接设值（保存后由 server.js 调） */
function set(model) {
  _model = String(model || '').trim();
  return _model;
}

/** 当前值（'' 表示不覆盖，跟随 tasks.vision） */
function getImageModel() {
  return _model;
}

/**
 * 从完整配置对象里取值并灌进来（启动时由 main.js 调）。
 * @param {object} cfg config.yaml 读出来的整个对象
 */
function fromCfg(cfg) {
  const s = cfg && cfg.scan && cfg.scan.imageModel;
  if (typeof s === 'string') return set(s);
  return set('');
}

module.exports = { set, getImageModel, fromCfg };
