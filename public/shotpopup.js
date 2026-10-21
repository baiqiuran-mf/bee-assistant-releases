/* 900×30 截图工具条逻辑（不依赖主窗口 app.js）
 * 主进程裁剪完会把裁剪图（dataURL）通过 beeShot.onPopupData 推过来；
 * 「翻译」→ 主进程调视觉 AI，弹独立翻译窗口；「保存图片」→ 主进程按设置路径落盘。 */
(function () {
  'use strict';

  let imageDataUrl = '';
  const msg = document.getElementById('msg');

  if (window.beeShot && window.beeShot.onPopupData) {
    window.beeShot.onPopupData((d) => { imageDataUrl = (d && d.imageDataUrl) || ''; });
  }

  document.getElementById('btn-translate').onclick = async () => {
    if (!imageDataUrl) { msg.textContent = '没有截图'; return; }
    msg.textContent = '翻译中…';
    const r = await window.beeShot.translate({ imageDataUrl });
    if (r && r.ok) msg.textContent = '已打开翻译窗口';
    else msg.textContent = (r && r.error) ? r.error : '翻译失败';
  };

  document.getElementById('btn-save').onclick = async () => {
    if (!imageDataUrl) { msg.textContent = '没有截图'; return; }
    msg.textContent = '保存中…';
    const r = await window.beeShot.save({ imageDataUrl });
    if (r && r.ok) msg.textContent = '已保存：' + (r.path || '');
    else msg.textContent = (r && r.error) ? r.error : '保存失败';
  };

  document.getElementById('btn-close').onclick = () => { if (window.beeShot) window.beeShot.closePopup(); };
})();
