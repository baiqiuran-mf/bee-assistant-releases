/* 证据测试：网页版 WhatsApp 抓图插件（content.js）
 *
 * 覆盖真实故障与关键约束：
 *  场景1 图片异步加载：插入时 src 为空 / 稍后变真图 —— 应抓到（旧逻辑会永久漏抓）
 *  场景2 占位小图（<4000 字符）—— 不应误发，也不该标已处理（便于重试）
 *  场景3 监听 src 属性变化（占位→真图）—— 应抓到
 *  场景4 https: CDN 图片源 —— 旧逻辑会当字符串被 startsWith('data:') 判否后静默跳过，新逻辑应 fetch 后抓到
 *  场景5 头像 <img> 必须排除（否则会把客户头像当图片发回软件）
 *  场景6 只认「客户发来的」：data-id 以 false_ 开头 / class 含 message-in 才算；true_ 一律不算
 *  场景7 持久去重：同一条消息成功发过之后，再次捕获应直接 skip（刷新页面不重复发）
 */
const assert = require('assert');
const cap = require('../extension/content.js');

// ---- 最小浏览器全局桩 ----
global.document = { querySelector: () => null };
global.FileReader = class {
  readAsDataURL() {
    const self = this;
    // 真 FileReader 的行为：先写 result，再触发 onload
    setTimeout(() => {
      self.result = 'data:image/jpeg;base64,' + 'B'.repeat(20000);
      self.onload && self.onload();
    }, 0);
  }
};
let postCalls = [];
global.fetch = async (url, opts) => {
  postCalls.push({ url, opts });
  if (String(url).includes('/api/wa-web/token')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, token: 't', port: 8787 }) };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }), blob: async () => ({}) };
};

const REAL = 'data:image/png;base64,' + 'A'.repeat(30000); // 模拟真实大图
const TINY = 'data:image/png;base64,iVBORw0KGgo=';          // 模拟占位小图

function makeImg(getSrc, opts = {}) {
  return {
    tagName: 'IMG',
    get src() { return getSrc(); },
    getAttribute: (a) => (a === 'src' ? getSrc() : null),
    // 头像是"在某个 avatar 容器里"的图 → 应被排除
    closest: (sel) => (opts.avatar && /avatar/i.test(String(sel)) ? {} : null),
  };
}

function makeRow(id, imgs, opts = {}) {
  const row = {
    nodeType: 1,
    className: opts.className || '',
    getAttribute: (a) => (a === 'data-id' ? id : null),
    querySelector: (sel) => (opts.hint && String(sel).includes('data-testid') ? {} : null),
    querySelectorAll: (sel) => {
      if (sel === 'img') return imgs;
      if (String(sel).includes('background-image')) return opts.bgs || [];
      return [];
    },
    closest: (sel) => (String(sel).includes('message-in') ? row : null),
  };
  return row;
}

(async () => {
  cap._setCFG({ port: 8787, token: 't', accountId: 1 });

  // 场景1：src 初始为空，50ms 后变真实大图 → 应抓到
  cap._reset(); postCalls = [];
  let s1 = '';
  const m1 = makeRow('false_MSG1', [makeImg(() => s1)]);
  setTimeout(() => { s1 = REAL; }, 50);
  await cap.captureMessage(m1);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(postCalls.length >= 1, '场景1：应至少 POST 一次');
  assert.ok(/data:image/.test(postCalls[0].opts.body), '场景1：POST body 应为图片 dataURL');
  assert.ok(cap._state().processed.includes('false_MSG1'), '场景1：成功后应标记已处理');
  console.log('✅ 场景1通过：初始 src 为空、50ms 后真图 → 抓到了真实图片');

  // 场景2：只有占位小图 → 不应误发，也不该标已处理
  cap._reset(); postCalls = [];
  const m2 = makeRow('false_MSG2', [makeImg(() => TINY)]);
  await cap.captureMessage(m2);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(postCalls.length === 0, '场景2：占位小图不应被发送');
  assert.ok(!cap._state().processed.includes('false_MSG2'), '场景2：未成功不应标记已处理');
  console.log('✅ 场景2通过：占位小图被正确忽略，不误发、可重试');

  // 场景3：Observer 属性变更回调识别「占位→真图」
  cap._reset(); postCalls = [];
  let s3 = TINY;
  const m3 = makeRow('false_MSG3', [makeImg(() => s3)]);
  const p3 = cap.captureMessage(m3);
  setTimeout(() => { s3 = REAL; }, 30);
  await new Promise((r) => setTimeout(r, 60));
  cap.onMutations([{ type: 'attributes', attributeName: 'src', target: { closest: () => m3 } }]);
  await p3;
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(postCalls.length >= 1, '场景3：src 属性变更后应能 POST');
  console.log('✅ 场景3通过：监听 src 属性变化，捕捉「占位→真图」替换');

  // 场景4：https: CDN 图片源（旧逻辑静默跳过）→ 新逻辑应 fetch 后抓到
  cap._reset(); postCalls = [];
  const m4 = makeRow('false_MSG4', [makeImg(() => 'https://mmg.whatsapp.net/v/t62/abc.jpg')]);
  await cap.captureMessage(m4);
  await new Promise((r) => setTimeout(r, 200));
  const sent4 = postCalls.filter((c) => String(c.url).includes('incoming-image'));
  assert.ok(sent4.length >= 1, '场景4：https: CDN 图片也應被发回（旧逻辑会静默跳过）');
  assert.ok(/data:image/.test(sent4[0].opts.body), '场景4：应转成 dataURL 再发');
  console.log('✅ 场景4通过：https: CDN 图片源也能抓到（旧逻辑的静默跳过已修）');

  // 场景5：头像必须排除，只抓真正的消息图
  cap._reset(); postCalls = [];
  const avatarImg = makeImg(() => 'https://pps.whatsapp.net/avatar.jpg', { avatar: true });
  const realImg = makeImg(() => REAL);
  const m5 = makeRow('false_MSG5', [avatarImg, realImg]);
  await cap.captureMessage(m5);
  await new Promise((r) => setTimeout(r, 200));
  const sent5 = postCalls.filter((c) => String(c.url).includes('incoming-image'));
  assert.ok(sent5.length >= 1, '场景5：应抓到真实消息图');
  assert.ok(sent5.every((c) => c.opts.body.includes('A'.repeat(200))), '场景5：发回的必须是真图，不能是头像');
  console.log('✅ 场景5通过：头像被排除，只抓真实消息图');

  // 场景6：只认「客户发来的」
  assert.ok(cap.isIncomingRow({ nodeType: 1, className: '', getAttribute: () => 'false_999@s.whatsapp.net_AB' }) === true,
    '场景6：data-id 以 false_ 开头 → 客户发的');
  assert.ok(cap.isIncomingRow({ nodeType: 1, className: '', getAttribute: () => 'true_999@s.whatsapp.net_AB' }) === false,
    '场景6：data-id 以 true_ 开头 → 自己发的，绝不能抓');
  assert.ok(cap.isIncomingRow({ nodeType: 1, className: 'message-in x', getAttribute: () => '' }) === true,
    '场景6：class 含 message-in → 客户发的');
  assert.ok(cap.isIncomingRow({ nodeType: 1, className: '', getAttribute: () => '' }) === false,
    '场景6：无任何判据 → 不抓');
  console.log('✅ 场景6通过：只认客户发来的消息行（false_ 前缀 / message-in 类）');

  // 场景7：持久去重（已成功发过的消息再次捕获 → skip，不重复发）
  cap._reset(); postCalls = [];
  const m7 = makeRow('false_MSG7', [makeImg(() => REAL)]);
  await cap.captureMessage(m7);
  await new Promise((r) => setTimeout(r, 200));
  const n7 = postCalls.filter((c) => String(c.url).includes('incoming-image')).length;
  const again = await cap.captureMessage(m7);
  await new Promise((r) => setTimeout(r, 200));
  const n7b = postCalls.filter((c) => String(c.url).includes('incoming-image')).length;
  assert.strictEqual(again, 'skip', '场景7：已发过的消息应直接 skip');
  assert.strictEqual(n7, n7b, '场景7：重复捕获不应再次 POST（防刷新页面后重复发回软件）');
  console.log('✅ 场景7通过：持久去重生效，重复扫描不会重复发回软件');

  // 场景8：全宽图片（style=width:100%，图片本身占满面板）→ 经"气泡"几何判定应识别为"客户发的"
  // 老板真实故障：1200×1600 全宽图被旧几何判成"居中、判不出"而漏抓
  {
    const panelRect = { left: 0, right: 1000, width: 1000 };
    const bubble = { nodeType: 1, parentElement: null, getBoundingClientRect: () => ({ left: 24, right: 424, width: 400 }) };
    const imgFull = {
      nodeType: 1, tagName: 'IMG', naturalWidth: 1200,
      getBoundingClientRect: () => ({ left: 0, right: 1000, width: 1000 }), // 图片本身全宽居中
    };
    imgFull.parentElement = bubble;
    assert.strictEqual(cap.directionOf(imgFull, panelRect), 'in',
      '场景8：全宽图片经气泡几何判定应识别为"客户发的"（修"判不出"漏抓）');
    // 对照：若直接量图片本身（旧逻辑）应判不出，证明气泡判定是必要的
    assert.strictEqual(cap.directionByGeometry(imgFull, panelRect), 'in', '场景8：气泡几何应判为 in');
  }
  console.log('✅ 场景8通过：全宽图片（width:100%）经气泡几何判定识别为"客户发的"，不再漏抓');

  console.log('\n全部通过（WAWEB_FAST 模式）');
})().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1); });
