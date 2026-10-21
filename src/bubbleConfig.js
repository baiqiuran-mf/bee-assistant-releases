/**
 * 气泡翻译模型（2026-10-15 v2.6.1121）
 *
 * 「全局设置 → AI 设置 → 通用设置 → 气泡翻译模型」下拉，选的是**服务商 key**
 * （deepseek / gpt / agnes / tikhub …）。空串 = 跟随 tasks.translate（默认那家）。
 *
 * 为什么单独一个模块，而不是塞进 ai.js：
 *   这是「用哪家 AI 来翻译文气泡」**一个开关**，和 ai.js 的「任务目录 / 服务商目录」
 *   不是一回事。翻译队列（translator.js）只想知道"老板指定的是哪家"，别的都不关心。
 *
 * 取值优先级：bubble.translateModel ＞ telegram.translateModel（老键，v2.5.1083 存过的那份）
 *   —— 兼容读老键，老板不用重新选一次。
 *
 * 内存值由 main.js 启动时、server.js 保存时注入（与 ai.setAiConfig 同一套做法），
 * 翻译队列每次取到的都是新的，不读盘、不用重启。
 */

/** 当前选中的服务商 key；'' = 跟随全局翻译 */
let _model = '';

/** 直接设值（保存后由 server.js 调） */
function set(model) {
  _model = String(model || '').trim();
  return _model;
}

/** 当前值（'' 表示不覆盖，跟随 tasks.translate） */
function translateModel() {
  return _model;
}

/**
 * 从完整配置对象里取值并灌进来（启动时由 main.js 调）。
 * 🔴 只要新键存在（**哪怕是空串**）就以新键为准，不再看老键 ——
 *    否则老板把下拉选回「跟随全局翻译」后，老键那份旧值会被复活。
 *    写盘时 setScalar 会把空串写成 `translateModel: ""`，读回来是字符串，正好命中这一条。
 * @param {object} cfg config.yaml 读出来的整个对象
 */
function fromCfg(cfg) {
  const b = cfg && cfg.bubble && cfg.bubble.translateModel;
  if (typeof b === 'string') return set(b);
  const legacy = cfg && cfg.telegram && cfg.telegram.translateModel;
  if (typeof legacy === 'string') return set(legacy);
  return set('');
}

module.exports = { set, translateModel, fromCfg };
