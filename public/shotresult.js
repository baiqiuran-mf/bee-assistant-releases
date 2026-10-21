/* 独立截图翻译窗口逻辑（不依赖主窗口 app.js）
 * 主进程把 { imageDataUrl, text } 通过 beeShot.onResultData 推过来：左边图、右边译文。 */
(function () {
  'use strict';

  function render(d) {
    if (!d) return;
    const img = document.getElementById('shot');
    if (d.imageDataUrl) img.src = d.imageDataUrl;
    document.getElementById('text').textContent = (d.text && d.text.trim()) ? d.text : '（无译文）';
  }

  if (window.beeShot && window.beeShot.onResultData) {
    window.beeShot.onResultData(render);
  }

  const closeBtn = document.getElementById('close');
  if (closeBtn) closeBtn.onclick = () => { if (window.beeShot) window.beeShot.closeResult(); };

  const copyBtn = document.getElementById('copy');
  if (copyBtn) copyBtn.onclick = () => {
    const t = document.getElementById('text').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(() => {
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制译文'; }, 1200);
      }).catch(() => { /* 忽略 */ });
    }
  };
})();
