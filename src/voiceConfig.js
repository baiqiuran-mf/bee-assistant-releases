/**
 * 语音识别模型（2026-10-21）
 *
 * 「AI 设置 → 专项 AI → 语音识别」下拉，选的是**服务商 key**
 * （chatanywhere / api2gpt / qianduoduo / no1apipro / zhichuang / ars_qianwen）。
 * 空串 = 跟随语音任务默认（tasks.asr，现 agnes）。
 *
 * 内存值由 main.js 启动时、server.js 保存时注入；media.js 每次取新的，不读盘、不用重启。
 */

let _model = '';

function set(model) {
  _model = String(model || '').trim();
  return _model;
}

function getVoiceModel() {
  return _model;
}

function fromCfg(cfg) {
  const s = cfg && cfg.scan && cfg.scan.voiceModel;
  if (typeof s === 'string') return set(s);
  return set('');
}

module.exports = { set, getVoiceModel, fromCfg };
