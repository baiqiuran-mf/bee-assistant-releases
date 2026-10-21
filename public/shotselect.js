/* 截图选区遮罩逻辑（不依赖主窗口 app.js）
 * 流程：加载即抓整屏 → 设背景 → 通知主进程显示遮罩 → 用户拖拽选区 → Enter 确认 / Esc 取消。
 * 选区坐标在「窗口 CSS 像素」里记，确认时按 原图像素/窗口像素 的比例换算成图内像素，交给主进程裁剪。 */
(function () {
  'use strict';

  const bg = document.getElementById('bg');
  const sel = document.getElementById('sel');
  const info = document.getElementById('info');

  let natW = 0, natH = 0, dataUrl = '';
  let dragging = false, moved = false;
  let sx = 0, sy = 0; // 起点（窗口 CSS 像素）

  function factorX() { return natW / Math.max(1, window.innerWidth); }
  function factorY() { return natH / Math.max(1, window.innerHeight); }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function showInfo(r) {
    info.innerHTML = `位置 <b>${Math.round(r.left)}, ${Math.round(r.top)}</b> · 尺寸 <b>${Math.round(r.width)} × ${Math.round(r.height)}</b>`;
  }

  function setSel(r) {
    sel.style.display = 'block';
    sel.style.left = r.left + 'px';
    sel.style.top = r.top + 'px';
    sel.style.width = r.width + 'px';
    sel.style.height = r.height + 'px';
    showInfo(r);
  }

  function onDown(e) {
    // 只在左键、点在选区手柄之外时，重新开始一个选区
    if (e.button !== 0) return;
    if (e.target && e.target.classList && e.target.classList.contains('handle')) return;
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    setSel({ left: sx, top: sy, width: 0, height: 0 });
  }

  function onMove(e) {
    if (!dragging) return;
    moved = true;
    const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
    const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
    setSel({ left: x, top: y, width: w, height: h });
  }

  function onUp() { dragging = false; }

  function confirmSelection() {
    const r = {
      left: parseFloat(sel.style.left) || 0,
      top: parseFloat(sel.style.top) || 0,
      width: parseFloat(sel.style.width) || 0,
      height: parseFloat(sel.style.height) || 0,
    };
    if (r.width < 3 || r.height < 3) { // 太小时当没选，取消
      if (window.beeShot) window.beeShot.cancel();
      return;
    }
    const selImg = {
      x: r.left * factorX(),
      y: r.top * factorY(),
      w: r.width * factorX(),
      h: r.height * factorY(),
    };
    if (window.beeShot) window.beeShot.confirm({ dataUrl, selImg });
  }

  document.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmSelection(); }
    else if (e.key === 'Escape') { e.preventDefault(); if (window.beeShot) window.beeShot.cancel(); }
  });

  async function doCapture() {
    if (!window.beeShot) throw new Error('beeShot 不可用');
    let cap = await window.beeShot.captureScreen();
    if (!cap) {
      // 主进程兜底再试一次
      const r = await window.beeShot.captureMain();
      if (r && r.ok) cap = r;
      else throw new Error((r && r.error) ? ('主进程兜底也失败：' + r.error) : '抓屏失败');
    }
    if (!cap) throw new Error('抓屏失败');
    dataUrl = cap.dataUrl; natW = cap.width; natH = cap.height;
    bg.src = dataUrl; bg.style.display = 'block';
    // 抓屏已在隐藏时完成，通知主进程显示遮罩
    window.beeShot.ready();
  }

  function showFatal(msg) {
    const old = document.querySelector('.shot-fatal');
    if (old) old.remove();
    document.body.style.background = 'rgba(20,22,28,0.92)';
    document.body.style.cursor = 'default';
    const box = document.createElement('div');
    box.className = 'shot-fatal';
    box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);max-width:72%;background:#262a36;color:#fff;padding:20px 24px;border-radius:10px;font:14px/1.6 system-ui,sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.4)';
    box.innerHTML = '截图启动失败：' + String(msg).replace(/</g, '&lt;') + '<br><br><button id="shot-retry" style="margin-top:8px;padding:6px 18px;border:0;border-radius:6px;background:#4da3ff;color:#fff;font:13px system-ui;cursor:pointer">重试</button>';
    document.body.appendChild(box);
    if (window.beeShot) window.beeShot.ready(); // 之前 show:false，失败也要让用户看见错误
    const btn = document.getElementById('shot-retry');
    if (btn) btn.onclick = () => {
      box.remove();
      document.body.style.background = '';
      document.body.style.cursor = 'crosshair';
      init();
    };
  }

  async function init() {
    try {
      await doCapture();
    } catch (err) {
      showFatal(err && err.message ? err.message : err);
    }
  }

  init();
})();
