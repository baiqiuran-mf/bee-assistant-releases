# 浏览器插件采集方案 · 实施规格（方案一：插件 → 软件本地 HTTP）

> 状态：规划文档（尚未写代码）
> 目标：做一个 Chrome 插件，只读取**网页版 WhatsApp 上客户发来的图片**，连同发件人信息通过本地 HTTP 发给「蜜蜂信息采集」软件，软件走现有入站链路入库 + AI 看图出中文。
> 范围收窄（老板 2026-10-09 确认）：**只抓 `message-in`（客户→我），不抓 `message-out`（我→客户）**。

---

## 0. 数据流（一句话）

```
网页版 WhatsApp（客户发图的会话）
   │  content script 扫描 .message-in 里的 <img>
   ▼
插件 background（校验 token，POST base64 + 发件人信息）
   │  http://127.0.0.1:8787/api/ext/ingest
   ▼
server.js 新路由（token 校验 + CORS）
   ▼
main.js 新增 ingestExternalInbound()  ← 复用现有链路
   ├─ db.getOrCreateCustomer()   建/取客户（带回 @lid 真实号码）
   ├─ 落盘图片到 MEDIA_DIR
   ├─ db.saveMessage(direction='in', media_path…)
   ├─ broadcastSafe('new_message')   界面立刻出现气泡
   └─ media.describeLater()          AI 看图 → broadcast 'translated'(mediaZh)
```

---

## 1. 现有代码落点（硬证据，改动都挂在这些点上）

| 关注点 | 文件:行 | 现状 |
|---|---|---|
| 本地端口 | `src/main.js:57` | `const PORT = Number(cfg.app?.port \|\| 8787)` —— **默认 8787，不是随机**（上次口误更正）。`listenOn` 仅在 8787 被占用时回退空闲端口。 |
| HTTP 服务创建 | `src/server.js:129` | `createServer(deps, port=8787)`；内部 `http.createServer` 在 `server.js:771`，按 `p === '/api/...'` 分发路由。 |
| deps 注入处 | `src/main.js:1729-1732` | 当前传 `{ db, doc, ai, knowledge, cfg, getAccountStates, openAccount, prefillChat, simulateMessage, clearSimulated, grabProfilePhone, update, signalStatus }`。**缺 `media` 和新的 ingest 函数** —— 需要补。 |
| 入站主流程 | `src/main.js:845` `handleMessage` | 入站图标准链路：识别身份 → `getOrCreateCustomer` → `saveMedia` → `db.saveMessage` → `broadcast new_message` → `media.describeLater`。 |
| 图片落盘 | `src/main.js:750` `saveMedia` | 输出 `{ path, src, mimetype, kind }`；压到 ~10KB 存 `MEDIA_DIR`。 |
| 图片类型校验 | `src/main.js:709` `sniffImageType` | 按 magic 字节判 jpg/png/gif/webp/bmp（**不认扩展名**）—— 插件传来的 base64 也要过这一关。 |
| 消息入库 | `src/db.js:871` `saveMessage({customerCode, accountId, direction, body, bodyZh, mediaPath, mediaSrc, mediaType, waMsgId, msgTs, silent, mediaFetchState})` | 字段一览。插件图已落盘 → `mediaPath` 有值，`media_fetch_state` 自动为 `''`（不进重抓队列，正确）。 |
| 客户建/取 | `src/db.js:342` `getOrCreateCustomer(accountId, waJid, info={name,phone,region,phoneSrc,channel,isSim})` | 同渠道内按手机号合并。@lid 会话 phone 抽不到 → 新编号；插件可额外传 `senderPhone` 改善合并。 |
| 媒体目录 | `src/main.js:55` `MEDIA_DIR = paths.mediaDir()` | 图片命名 `<code>_<timestamp>.jpg`。 |
| 广播 | `src/main.js:1369` `broadcastSafe(type, payload)` | 模块内可用；`new_message` 字段见 `main.js:1031-1050`（code/isNew/account/direction/msgId/body/bodyZh/translating/mediaPath/mediaKind/mediaType/mediaSrc/mediaWaiting/unread/name/ts）。 |
| AI 看图 | `src/media.js:84` `describeLater(msgId, code, mediaPath, onDone)` | 异步排队，结果写 `media_zh` 并广播 `translated`。 |
| 客户档案 | `src/main.js:1102` `doc.writeCustomerDoc(fresh, db.listMessages.all(code))` | 图入库后刷新档案文档。 |

---

## 2. 改动点 A：软件端新增路由 `/api/ext/ingest`（server.js）

在 `server.js` 的 `http.createServer` 分发区（`server.js:771` 起）新增一个分支，建议放在 `/api/manual` 附近：

```js
// ===== 插件入站采集（方案一）=====
if (p === '/api/ext/ingest' && req.method === 'POST') {
  // 1) token 校验
  const tok = req.headers['x-ext-token'] || '';
  if (!cfg.app?.extToken || tok !== cfg.app.extToken) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'bad token' }));
    return;
  }
  // 2) 读 body（JSON：{accountId, jid, base64, mimetype, senderName, senderPhone, caption}）
  // 3) 调 deps.ingestExternalInbound(...)
  // 4) 回 { ok, msgId, code }
  return;
}
// OPTIONS 预检（若从 content script 直发才需要；见 §5 建议走 background 可省）
if (p === '/api/ext/ingest' && req.method === 'OPTIONS') {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-ext-token',
  });
  res.end();
  return;
}
```

**注意**：`cfg` 已在 `createServer` 的 deps 里（`server.js:130` 解构了 `cfg`），`extToken` 从 `cfg.app.extToken` 读。

---

## 3. 改动点 B：main.js 新增 `ingestExternalInbound`（复用现有链路）

放在 `handleMessage` 附近，**不直接 fake 一个 whatsapp-web.js 的 Message 对象**（它的 `downloadMedia`/`id` 形状插件给不了），而是用现成的原子零件拼装：

```js
/**
 * 插件入站采集入口（方案一）：客户在网页版 WhatsApp 发来的图片，
 * 由浏览器插件以 base64 形式 POST 过来，这里走和 handleMessage 相同的后半段。
 * @param {{accountId:number, jid:string, base64:string, mimetype:string,
 *          senderName?:string, senderPhone?:string, caption?:string}} p
 * @returns {Promise<{ok:boolean, msgId?:number, code?:string, error?:string}>}
 */
async function ingestExternalInbound(p = {}) {
  const accountId = Number(p.accountId) || 1;       // 默认主账号
  const jid = String(p.jid || '').trim();
  if (!jid) return { ok: false, error: 'missing jid' };

  // 1) base64 → 真图校验（复用 sniffImageType，防假图/垃圾串）
  const bare = String(p.base64 || '').replace(/\s+/g, '');
  let buf;
  try { buf = Buffer.from(bare, 'base64'); } catch (e) { return { ok: false, error: 'bad base64' }; }
  const mime = sniffImageType(buf);
  if (!mime) return { ok: false, error: 'not an image' };

  // 2) 落盘（命名规则同 saveMedia：<code>_<ts>.ext）
  const ext = (EXT_BY_MIME[mime] || 'jpg');
  const file = path.join(MEDIA_DIR, `${Date.now()}.${ext}`);   // 临时名，建完客户再改名也行
  fs.writeFileSync(file, buf);

  // 3) 建/取客户（带回真实号码，补 @lid 短板）
  const { customer } = db.getOrCreateCustomer(accountId, jid, {
    name: p.senderName || '',
    phone: p.senderPhone || '',
    phoneSrc: p.senderPhone ? 'ext' : '',
    channel: 'whatsapp',
  });

  // 4) 入库（direction='in'，图已落盘 → media_fetch_state 自动为 ''）
  const saved = db.saveMessage({
    customerCode: customer.code,
    accountId,
    direction: 'in',
    body: p.caption || '',
    mediaPath: file,
    mediaSrc: 'ext',          // 区别于 download / base64
    mediaType: 'image',
    waMsgId: null,            // 插件无 WA 侧 msg id
    msgTs: new Date().toISOString(),
    silent: false,
  });
  if (!saved.changes) return { ok: true, msgId: saved.id, code: customer.code, duplicate: true };

  // 5) 立刻广播（界面出气泡）
  const fresh = db.getCustomer.get(customer.code);
  broadcastSafe('new_message', {
    code: customer.code, isNew: saved.id, account: accountId, direction: 'in',
    msgId: saved.id, body: p.caption || '', bodyZh: '', translating: false,
    mediaPath: file, mediaKind: 'image', mediaType: 'image',
    mediaSrc: 'ext', mediaWaiting: true,
    unread: fresh?.unread || 0, name: fresh?.name || '', ts: fresh?.last_msg_at,
  });

  // 6) 排 AI 看图（出中文说明）
  media.describeLater(saved.id, customer.code, file, (r) => {
    if (r.mediaZh) {
      const c = db.getCustomer.get(customer.code);
      if (c) doc.writeCustomerDoc(c, db.listMessages.all(customer.code));
    }
    broadcastSafe('translated', { code: r.code, msgId: r.msgId, bodyZh: '', mediaZh: r.mediaZh, kind: r.kind, error: r.error });
  });

  // 7) 刷新档案
  doc.writeCustomerDoc(fresh, db.listMessages.all(customer.code));
  return { ok: true, msgId: saved.id, code: customer.code };
}
```

导出：在 `src/main.js:1930` 的 `module.exports` 里加 `ingestExternalInbound`；并在 `main.js:1729` 的 `createServer({...})` deps 里补 `media` 和 `ingestExternalInbound`。

---

## 4. 改动点 C：config.yaml 增加 `app.extToken`

```yaml
app:
  port: 8787            # 插件固定打这个端口
  extToken: "换成一段随机串，如 openssl rand -hex 16"
```

- token 用途：防止任意网页往软件塞数据。插件在请求头带 `x-ext-token`，server 比对。
- 生成方式：软件首次启动若 `extToken` 为空，自动 `crypto.randomBytes(16).hex` 写入并日志打印；或在「设置」页显示，方便复制到插件。
- **端口固定**：8787 已是默认，无需改代码；只在 8787 被占用才回退（回退后插件要能读实际端口——见 §9 兜底）。

---

## 5. 插件端结构（Chrome MV3）

```
wa-ext/
  manifest.json          # MV3；host_permissions 含 http://127.0.0.1:8787；action 弹窗
  background.js          # 收 content script 数据 → 带 token POST 到本地 HTTP（绕过 CORS）
  content.js             # 注入 web.whatsapp.com；扫 .message-in 的 <img> → base64；抽发件人
  popup.html / popup.js  # 「抓取当前会话图片」按钮 + 状态 + 端口/token 配置
```

**关键设计：POST 走 background，不走路 content script 直发**
- content script 受 CORS 限制；background service worker 在 `host_permissions` 含 `http://127.0.0.1:8787` 时直连 localhost **不受 CORS 约束**，token 也只在 background 持有（不暴露给页面）。
- 数据流：content script 提取 → `chrome.runtime.sendMessage` → background → `fetch('http://127.0.0.1:8787/api/ext/ingest', {headers:{'x-ext-token':TOKEN}, body:JSON})`。

**只抓客户图（message-in）**
```js
// content.js —— 仅扫描入站气泡
const ins = document.querySelectorAll('.message-in');   // 客户→我
for (const m of ins) {
  const img = m.querySelector('img');
  if (!img) continue;
  const b64 = await imgToBase64(img);   // canvas.toDataURL 重绘，绕 blob 时效
  // 抽发件人：会话头部 / m 上的 data-id（形如 15551234567@c.us 或 @lid）
  const jid = m.getAttribute('data-id') || currentChatJid();
  // 真实号码：点开联系人面板读到的 phone（非 @lid 时才有），附在 senderPhone
  payloads.push({ jid, base64: b64, mimetype: guessMime(b64), senderPhone, senderName });
}
```
- `imgToBase64`：新建 `<canvas>` 按原尺寸 drawImage → `toDataURL('image/jpeg', 0.92)`。注意 WA Web 图可能是 blob URL（刷新失效），canvas 重绘能拿到稳定 base64。
- 大图体积：base64 后可能几 MB；本地 HTTP 无压力，但建议 `maxEdge` 控制（如长边 ≤ 1280，对应软件压 ~10KB 的逻辑）。

---

## 6. 顺带解决 @lid 短板（额外价值）

网页端 `message-in` 容器附近能拿到发件人真实手机号（联系人面板 / `data-id` 解析）。插件把 `senderPhone` 一并 POST，`getOrCreateCustomer` 用它合并客户、**补上软件现在抽不到的真实号码**——这是插件比现有 puppeteer 通道多的直接收益。

---

## 7. 安全与风控

- **token 校验**：`x-ext-token` 不符即 403；token 不在页面/插件 popup 明文硬编码（background 内持有）。
- **Origin / 端口**：本地 HTTP 只监听 `127.0.0.1`（现有 `server.listen(p,'127.0.0.1')`，`main.js:111`），外网不可达。
- **只入站**：服务端不提供任何"发消息"接口（现有 `media.js` 顶部也写明"没有任何发送能力"），插件也只做读取。
- **Meta 风控**：做成**手动按钮触发**（抓当前会话），不常驻全自动扫；只读取自己账号的入站消息，敏感度最低。仍建议保留人工触发。

---

## 8. 边界与容错

- base64 不是真图 → `sniffImageType` 返回 null → 拒收（复用现有 magic 字节判据，不认扩展名）。
- 同一张图重复抓 → `db.saveMessage` 用 `INSERT OR IGNORE`（按 `wa_msg_id`）；插件无 WA id，故用 `(customer_code, msg_ts, media_path)` 去重（需在 `saveMessage` 或 ingest 函数里加一层 SHA/存在性判断，避免重复落盘同图）。见 §9 待定项。
- 端口回退：若 8787 被占用，`listenOn` 回退空闲端口；插件需能读实际端口（方案：软件把实际端口写进 `config.yaml app.port` 或暴露 `/api/state` 已有 `port` 字段，插件 popup 启动时拉一次）。
- 多账号：插件 `accountId` 默认 1（主账号）；若用户有多 WA 号，popup 里选。

---

## 9. 待定项（实现前需老板拍板）

1. **重复图去重键**：插件无 WA `wa_msg_id`，用 `media_path` 哈希 + 时间窗去重，还是在 `messages` 表加 `ext_dup_key`？—— 推荐 ingest 函数内先查"同客户 60 秒内同 md5 已存在则跳过"。
2. **accountId 默认值**：确认主账号 id（现有 `account.id` 取值，单账号大概率是 `1`）。
3. **图片尺寸上限**：插件端 `maxEdge` 取 1280 还是直接传原图让软件压？
4. **token 下发方式**：软件「设置」页显示并一键复制，还是首次启动写 config 并打印日志？

---

## 10. 实施顺序（建议，先打通再补全）

1. 软件端：`config.yaml` 加 `app.extToken` + `app.port`（已默认 8787）。
2. 软件端：`main.js` 加 `ingestExternalInbound` 并导出；`server.js` 加 `/api/ext/ingest` 路由 + deps 注入 `media`/`ingestExternalInbound`。
3. **先不用插件**，用 `curl` 打 `POST /api/ext/ingest` 验证：落盘、入库、界面出气泡、AI 出中文说明、档案刷新。
4. 插件骨架：manifest + background + content（message-in 过滤 + base64）+ popup 按钮。
5. 端到端联调：开 WA Web → 点插件按钮 → 软件收到客户图。
6. 自测：**源码跑通 + packaged build（asar 内含修复）都验证**（按老板规矩，不只验源码）。

---

## 11. 验证清单（改完必跑）

- [ ] `curl` POST 一张真图 base64 → HTTP 200 + `{ok:true,code}`
- [ ] 软件左栏出现新客户/未读，中栏出现图片气泡
- [ ] 几秒后气泡补上 AI 中文看图说明
- [ ] 客户档案文档含该图
- [ ] 传假 base64（"hello"）→ 403/no image 拒收
- [ ] token 错 → 403
- [ ] 自己发的图（`message-out`）不被插件抓取（范围收窄验证）
- [ ] packaged `.exe` 内 `asar` 含上述改动，实机联调通过
