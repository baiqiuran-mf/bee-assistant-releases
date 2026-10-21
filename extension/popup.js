/* 蜜蜂采集 · 网页版 WhatsApp 抓图（popup） */
(function () {
  const $ = (id) => document.getElementById(id);
  const API = 'http://127.0.0.1:8787/api/wa-web/token';

  // 软件开着就自动拉最新令牌/端口，省去手动复制（本地操作，不外传）
  async function autofill() {
    try {
      const r = await fetch(API);
      if (!r.ok) { $('st-state').textContent = '软件未响应 HTTP ' + r.status; $('st-state').className = 'bad'; return; }
      const j = await r.json();
      if (j.token) $('token').value = j.token;
      if (j.port) $('port').value = j.port;
    } catch (e) {
      $('st-state').textContent = '连不上软件（请先打开软件）';
      $('st-state').className = 'bad';
    }
  }

  // 渲染内容脚本回传的实时状态
  function renderStats(s) {
    if (!s) return;
    $('st-state').textContent = s.online ? '✅ 正在运行' : '未响应';
    $('st-state').className = s.online ? 'ok' : 'bad';
    $('st-chat').textContent = s.chat || '—';
    $('st-incoming').textContent = Number(s.incoming) || 0;
    $('st-imgs').textContent = Number(s.imgs) || 0;
    $('st-captured').textContent = Number(s.captured) || 0;
    if (s.lastError) {
      $('st-err-row').style.display = '';
      $('st-err').textContent = s.lastError;
    } else {
      $('st-err-row').style.display = 'none';
    }
  }

  // 向当前标签页的内容脚本要状态
  function askStats() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, { type: 'stats' }, (resp) => {
          if (chrome.runtime.lastError || !resp) {
            $('st-state').textContent = '当前标签页不是网页版 WhatsApp';
            $('st-state').className = 'bad';
            return;
          }
          renderStats(resp);
        });
      });
    } catch (e) { /* 忽略 */ }
  }

  chrome.storage.local.get(['port', 'accountId', 'token'], (v) => {
    if (v && v.port) $('port').value = v.port;
    if (v && v.accountId) $('accountId').value = v.accountId;
    if (v && v.token) $('token').value = v.token;
    autofill();
    askStats();
  });

  $('save').onclick = () => {
    const port = ($('port').value || '8787').trim();
    const accountId = ($('accountId').value || '1').trim();
    const token = ($('token').value || '').trim();
    chrome.storage.local.set({ port, accountId, token }, () => {
      const msg = $('msg');
      msg.textContent = '已保存，去网页版 WhatsApp 发张图试试（记得刷新一次页面）';
      setTimeout(() => { msg.textContent = ''; }, 4000);
    });
  };

  $('scan').onclick = () => {
    const msg = $('msg');
    msg.textContent = '正在扫描…';
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) { msg.textContent = '没找到当前标签页'; return; }
        chrome.tabs.sendMessage(tab.id, { type: 'scanNow' }, (resp) => {
          if (chrome.runtime.lastError || !resp) {
            msg.textContent = '请在网页版 WhatsApp 页面用这个按钮（并刷新一次页面）';
            return;
          }
          msg.textContent = `扫描完成：客户消息 ${resp.incoming} 条，本轮新发回 ${resp.sent} 张图`;
          askStats();
        });
      });
    } catch (e) {
      msg.textContent = '扫描失败：' + ((e && e.message) || e);
    }
  };
})();
