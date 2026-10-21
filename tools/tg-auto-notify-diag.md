# Telegram 自动新消息提醒 —— 断链诊断报告

- 诊断日期：2026-10-16
- 代码：`E:\WorkBuddy-Projects\wa-assistant`（version 2.6.1139，git仅 1 个初始提交）
- 生产数据：`D:\蜜蜂采集数据\wa-assistant\`（`data\assistant.db`，config.yaml 同目录）
- 纪律：本次**全程只读**，未修改 `src/` / `public/` / `test/` / `config.yaml` 任一文件；探针脚本 `.tmp-diag2-*.js` 已逐个删除。

---

## 一、结论先行：断在哪一环

老板要的「不点任何东西就自动提醒」，断在 **第2 环：MTProto 新消息事件被自己的 handler 打死了**。

```
① Telegram 服务器推送新消息        ✅ 通（探针实测已连上、已授权）
② telegramOfficialChannel 的handler ❌ 断在这里 —— 每条消息都抛 TypeError
③ hooks.onMessages → 入库 + 提醒   ❌ 永远收不到东西
④ 前端/系统通知                    ❌ 不会触发
```

### 根因（一行代码）

**`src/telegramOfficialChannel.js:170`**

```js
ts: (m.date ? m.date.getTime() : Date.now()),
```

teleproto 的 `Api.Message.date` 是**number（unix 秒）**，不是 `Date` 对象。对 number 调 `.getTime()` 必然抛
`TypeError: m.date.getTime is not a function`。

**实测证据**（只读探针，连真实会话取真实消息，未发送任何内容）：

```
[2] dialogs = 5        对话: Xue / Eileen Lin / wanyu lee
[3] 取到消息数 = 3
   --- 消息 id= 156  out= true
       typeof date = number值 = 1792130942
       date instanceof Date = false
       ❌ 官方写法 date.getTime() 抛错: TypeError: m.date.getTime is not a function
       telegramMtproto 写法 = 2026-10-16T06:09:02.000Z
   --- 消息 id= 155 / 154  ← 同样报错
[4] 复现 telegramOfficialChannel.js:157-177 整个 handler：
   ❌ handler 抛错 → TypeError: m.date.getTime is not a function   （3/3 全挂）
```

- 类型定义佐证：`node_modules/teleproto/tl/custom/message.d.ts:242` → `date: number;`
- 运行时佐证：上面探针 `typeof date = number`、`date instanceof Date = false`
- 对照组：`src/telegramMtproto.js:153` 写法**是对的** → `new Date(msg.date * 1000).toISOString()`

### 为什么完全静默、连日志都没有

抛错点在 `telegramOfficialChannel.js:157-177` 那个**同步 handler** 里，且发生在 `:174` 调`hooks.onMessages` **之前**。
teleproto 的派发器 `node_modules/teleproto/client/updates/dispatch.js:181-193`：

```js
try { await callback(event); }
catch (e) {
  if (e instanceof StopPropagation) break;
  if (client._errorHandler) { ... }
  client._log.error(`Error in event handler: ${e}`);   // ← 只进 teleproto 自己的 logger
}
```

`client._log.error` 是 teleproto 内部 logger，**默认不输出到主进程 console**。而 `main.js:3171-3172` 的
`.catch(e => console.warn(...))` 只覆盖 `startWatching()` 的 Promise，**事件回调是异步后来的，不在那个 Promise 链里**。

所以：**一条新消息 = 一行 teleproto 内部日志 + 主进程零输出 + 前端零感知**。这完全吻合老板的描述
「不点就什么反应都没有」。

### 附带发现（同一文件，非本次断点，但会让 MTProto 路即使修好也质量残缺）

`src/telegramOfficialChannel.js:157-177` 的 handler 是**就地手搓**的映射，与 `telegramMtproto.js:134-190`
的 `toContract()` 相比**缺了一整套必要处理**：

| 能力 | telegramMtproto（`toContract`） | telegramOfficialChannel（内联handler） |
|---|---|---|
| `ts` 正确换算 | `:153` `new Date(msg.date*1000).toISOString()` | `:170` ❌ 抛错 |
| 剥尾部显示时间 | `:146` `stripTrailingTime` | ❌ 无（body 里会带时间，翻译会把时间一起翻） |
| Saved Messages 拦截 | `:172` `isSavedMessage` | ❌ 无 |
| 空消息丢弃 | `:150` `if(!body && !hasAttachment) return null` | ❌ 无（系统事件/撤回提示会造客户） |
| 取客户 name/username/phone | `:159-167` `getPeerEntity` | ❌ 硬编码 `name:'',username:'',phone:''`（`:171`） |
| 只读path 的实体缓存 | `cache` Map | ❌ 无 |

即：**两套 MTProto 实现并存**，修好 `:170` 只能让它「不报错」，姓名/翻译/收藏夹拦截仍不对。

---

## 二、逐问回答

### Q1 `telegramOfficialChannel` 与 `telegramMtproto` 是什么关系？

**结论：两个完全独立的模块，谁也不require 谁，各自有独立的 `clients` Map 和同一份会话文件。**

| | `telegramMtproto.js` | `telegramOfficialChannel.js` |
|---|---|---|
| 行数 | 459 | 346 |
| 导出 | `ensureWatching, stop, stopAccount, sessionPath, parseProxy, loadSession, saveSession, registerWatching, adoptLoggedInClient, sendToPeer, getUserProfile, hasClient` | `hasCred, credError, startWatching, stop, sendToPeer, getUserProfile, hasClient, parseProxy, loadSession, saveSession`（**无 `sessionPath`**） |
| 客户端容器 | `clients` Map（`:32`） | `clients` Map（`:46`） |
| 事件挂载 | `:282` `addEventHandler(handler, new NewMessage({}))` | `:157-177` `addEventHandler(fn, new NewMessage({}))` |
| 消息映射 | `toContract()` `:134-190` | 内联手搓 `:162-173` |
| `sessionPath` 导出 | ✅ `:458` | ❌ **没导出**（探针实测 `typeof ch.sessionPath === 'undefined'`） |

`grep` require 图（剥注释后核实）：

- `telegramOfficialChannel.js` **不 require** `telegramMtproto.js`（`:72` 只是注释里说「与 telegramMtproto 同款解析」）
- `telegramMtproto.js` **不 require** `telegramOfficialChannel.js`
- 两者都 require 了 `teleproto`、`teleproto/sessions`、`teleproto/events`

### 「有没有空壳/ 没被 require / 死代码？」——**有，三处**

**① `telegramWebView.js` 是纯死代码（整文件 59KB 全废）**

- `src/main.js:198` → `const telegramWebView = null;`（v2.6.1106 老板拍板停用）
- 因此 `:3152` `if (telegramWebView && ...)` 恒false → `telegramWebView.start()` 永不执行
- `server.js` 里 9 处 `telegramWebView.xxx` 全被 `!telegramWebView` 挡掉，返回 501/死分支
- `telegramWebView.js:19` 还 require 了 `telegramRead` —— 即「网页版内核」整条链彻底不启用

**② `telegramMtproto.ensureWatching` 从未被调用 —— 死导出**

- 全项目 grep：只有 `telegramMtproto.js:318` 定义处，**无任何调用点**
- `main.js:3196` 的 ensure 回调调的是 `telegramRead.ensureWatching`（`telegramRead.js:813`），不是 MTProto 的
- 而 `telegramMtproto.ensureWatching` 里才有那套**正确**的 `startAccount → getMe → registerWatching`（`:214-256`）
- 实际被调用的只有 `telegramMtproto.adoptLoggedInClient`（`main.js:3405`，应用内登录弹窗成功后接管）、
  `stopAccount`（`:3419`）、`sessionPath`（`:3423`）
- **含义：唯一能跑通的那套 MTProto 代码，只在「弹窗里现登录」时才挂上事件；启动时自动采集走的是坏掉的那套。**

**③ `telegramRead.ensureWatching` 是空壳（循环体只有 `continue`）**

`src/telegramRead.js:813-831`：

```js
for (const acc of (accounts || []).filter(...)) {
    if (isRunning(acc.id)) continue;
    /* ... 注释 ... */
    continue;          // ← :828 无条件 continue，函数体实际不干任何事
}
return opened;          // 永远返回 []
```

真正挂轮询的只有 `openOrFocus()`（`:843-857`，`attachPoller` 在 `:851`），而它只由**老板点顶栏 T① 按钮**触发。

### 老板在设置页填 apiId/apiHash，最终写到哪、走哪条路？

- 写入：前端设置页 → `src/server.js` 的设置接口 → `configWrite.js` 回写 `config.yaml`
  （打包版落`%APPDATA%\蜜蜂信息采集\config.yaml`；本机实测生产文件是 **`D:\蜜蜂采集数据\wa-assistant\config.yaml`**，
  6264 字节，今日 14:06 修改 —— 该目录即 Electron `userData`）
- 读取：`main.js:3131` `const hasCred = !!(cfg && cfg.telegram && cfg.telegram.apiId && cfg.telegram.apiHash)`
- 走哪条路：`main.js:3164-3166` → `telegramOfficialChannel.startWatching(...)` → **就是这条坏的**
- 附带：`server.js:60` 的 `safeRequireTelegram('./telegramOfficialChannel')` 也用同一份 config 做发送/资料

**实测生产 config.yaml**：`apiId=36460246`、`apiHash=e90d3b0c600972358b810427b11feb2f`、`notifySound: true`、
`app.desktopNotify: true` → `hasCred=true`，凭证这环**没问题**。

---

### Q2 MTProto 现在启动成功了吗？

**答：连接成功、授权成功、客户端在跑；但消息处理一收到就抛错。**

用**真实会话文件 + 生产 config**跑真实 `startWatching`（只读，未发送）：

```
[0] 生产 config: apiId=36460246  notifySound=true  desktopNotify=true
    accounts = [{id:7,enabled:true},{id:8,...},{id:9,...}]
    账号 7 会话文件存在 = true
    账号 8 会话文件存在 = false
    账号 9 会话文件存在 = false
[1] hasCred(生产cfg) = true
[2] 调用 startWatching（生产 cfg，3 个账号）...
   [onState] {"accountId":7,"channel":"telegram_mtproto","connected":true}
   [tg-A] 账号 8 启动失败：Required field "phoneNumber" of auth.SendCode is missing
   [tg-A] 账号 9 启动失败：Required field "phoneNumber" of auth.SendCode is missing
[3] 返回 = {"ok":true,"opened":[7]}耗时 10679 ms
[4] hasClient(7/8/9) = true false false
[6] 20 秒内 onMessages 触发次数 = 0
```

分步证据：

- **凭证/网络/会话全部正常**：`connect()` 2081ms 成功；`isUserAuthorized()=true`；`getMe()` 返回
  `id=8430238135, username=wanfengzhiqiu, phone=16058384634, firstName=wanqiu`
- **`startWatching` 本身成功**：`{ok:true, opened:[7]}`，`hasClient(7)=true` —— 所以**不是启动失败**，老板也**不需要重新登录**
- **会话文件格式**：`telegram-session-7.txt`，369 字节，单行 base64（`wc -l` = 0，无换行），
  `StringSession` 解出 `dcId=1, serverAddress=149.154.175.54, port=443`，**免验证码直接恢复**
- **8/9 号失败是正常的**：只有 7 号有会话文件，8/9 从未登录过→ `auth.SendCode` 缺 `phoneNumber`。
  该失败被 `telegramOfficialChannel.js:114-116` 的 try/catch 吞成 `console.warn`，不影响 7 号

**唯一失败点就是 handler 里的 `m.date.getTime()`**（见第一节）。

---

### Q3 那 44 条消息是怎么进来的？

**答：全部来自「外部 Chrome 抓 web.telegram.org DOM」这条路（`telegramRead`），没有一条是 MTProto 写的。**

`messages` 表**没有** `channel` 列，渠道在 `customers.channel`，需 join 才能查（第一版探针按`messages.channel` 查会报
`no such column`）。

统计（`telegram` = 44 条，`in` 32 / `out` 12，全部 `account_id=7`）：

```
channel=telegram : in 32 / out 12
channel=whatsapp-web : in 5 / out 8
channel=signal       : in 6 / out 4
channel=whatsapp     : in 4 / out 3
```

**证据 A —— `wa_msg_id` 形态判定**（MTProto 的 key 必须纯数字 peerId、msgId 必须纯数字 `Api.Message.id`）：

```
MTProto形态(数字key:数字msgId): 4      ← 实为误判，见下
非MTProto形态: 40  ["wanyu lee:wanyu lee:October 14","8696576132:8696576132:October 9",
                    "Eileen Lin:150","Eileen Lin:149","Eileen Lin:148", ...]
```

那 4 条「像 MTProto」的其实是 `8696576132:141` 这种 —— key `8696576132` 是**手机号**（DOM 里 `location.hash` 的
`#<peerId>` 或好友名），而 MTProto 路的 `customerKey` 来自 `peerIdOf()`（`:182-189`），只会是 `PeerUser.userId` /
`PeerChannel.channelId` 这类内部 ID，不会是 10 位手机号。所以**真实 MTProto 条数 = 0**。

**证据 B —— 出现 DOM `data-mid` 专属格式**：

```
非数字 msgId 样本: ["wanyu lee:October 14","8696576132:October 9","Xue:October 9",
                    "Xue:Today","152.0001","155.0001"]
```

`152.0001` / `155.0001` 是 **`<chatId>.<msgId>`** —— 正是 `telegramRead.js:308` 取的
`el.getAttribute('data-mid')` 原文。MTProto 不可能产生这种字符串。
另有 `Xue:Today`、`Xue:October 9` 这种把**日期文字当 msgId**的，也是 DOM 抓取兜底
（`telegramRead.js:137` `msgId || \`${chatKey}:${body.slice(0,40)}\``）。

**证据 C —— 全库没有一条 `tg:` 前缀 / wvlist / wvbubble**：

```
查询 wvlist% / wvbubble% / tg:% →[]   （0 条）
key_is_jid = 0（全部 44 条的 wa_msg_id 前缀都不是 customers.wa_jid）
```

MTProto 路必然写 `tg:<peerId>:<msgId>`（`:163` displayJid / `handleTelegramMessage` 用 `${m.customerKey}:${m.msgId}`），
一条都没有 → MTProto 从没成功写进过库。

**证据 D —— `msg_ts` vs `created_at` 差值 = 0，是抓取时刻不是服务端时刻**：

```
telegram in : n=32, lag<5s=32, lag 5s~10min=0, lag>10min=0, avg=0s, max=0.1s
telegram out: n=12, lag<5s=12, avg=0s, max=0s
```

100% 落在 0.1 秒内。`telegramRead.js:151` 明确用 `ts: new Date().toISOString()`（抓取时刻，注释也写了
「Telegram 网页不给可靠的服务端时间戳」）。而 MTProto 拿得到**真实服务端时间**
（`telegramMtproto.js:153` 用 `msg.date`），补采历史消息时差值会是几小时~几天，绝不可能全是 0。

**关于入库时间扎堆**：`03:32:21` / `03:35:09` / `03:37:16` 各一批 —— 对应 `readOpenChat()`（`telegramRead.js:341-375`）
一次把**当前打开对话**的所有气泡全扫一遍（`window.__seen` 首次全为空→ 全量上报）。
这是「点开某个好友 → 那个人历史消息一次性灌进来」的典型形态，**不是实时推送**。

---

### Q4 提醒链路本身通不通？

**答：链路本身是通的、代码是对的，没有双响残留。但它上游没有数据，所以永远不响。**

**① v2.6.1139 的下沉做得对，无残留 notify**

- 唯一发提醒处：`src/main.js:3012-3013`
  ```js
  if (m && m.direction === 'in' && tgShouldNotify(outcome.fresh, outcome.waMsgId)) {
      notifyTelegramIncoming(m, outcome);
  }
  ```
- `handleTelegramMessage` 的 `in` 分支（`:2523-2546`）**已无任何 notify 调用**。我逐行读过 `:2523-2546`：
  只有 `console.log` + `broadcastSafe('new_message', {...})`，并留了注释明确说「**绝不在两处各弹一次**（会双响）」
- 出参齐全：`handleTelegramMessage:2505-2511` 正确回填 `outcome.waMsgId / code / fresh / dup`
- 去重两层都在：`tgShouldNotify`（`:2937-2959`）先查 `fresh`（`:2941`）→ 再查内存 Set
  （`TG_NOTIFY_SEEN_MAX=500`，`:2923-2924`），且 `!key` 时宁可不响（`:2944`）
- 三重 try/catch 互不打断：`:3003-3005` 包入库、`:3014-3016` 包提醒、`:2999-3001` 包单条消息

>一个小瑕疵（非 bug）：`if (outcome) outcome.name = ...`（`:2528`）在 `if (!saved.changes) return customer;`
>（`:2513`）**之后**，所以重复消息走不到这里，`outcome.name` 为空 → `notifyTelegramIncoming:2969`
> 会退回 `m.name || 'Telegram 新消息'`。只影响提醒标题文案，不影响是否弹。

**② 三条路的 hooks 都是真对象，没有 `{}` 空对象**

| 路 | 传入的 hooks | 位置 | 结论 |
|---|---|---|---|
| MTProto 官方 | `telegramHooks()` | `main.js:3166` | ✅ 完整（`onMessages` + `onState`） |
| 内置浏览器 webview | `{ onMessages: telegramHooks().onMessages, onState }` | `main.js:3149-3152` | ✅ 完整（但 `telegramWebView=null`，整段不执行） |
| 外部 Chrome | `telegramHooks()` | `main.js:3184` | ✅ 完整 |

`telegramRead.startWatching` 收到的 `onMessages` 是**具名参数**
（`main.js:3183-3187` 传 `onMessages:`，签名见 `telegramRead.js:740`），内部再组装成
`hooks = { onMessages, onState }`（`:747`）。**不存在传 `{}` 导致 `onMessages` 缺失的情况。**

**③ 提醒三件套本身可用**（`notifyTelegramIncoming:2967-2979`）

- `notify(title, message)`（`:1162-1180`）：一级 Electron 系统通知（Windows 右下角气泡，
  经 `electronBridge.bridge.notifyDesktop`）→ 二级 `node-notifier` → 三级 `console.log` + BEL 字符
- 生产 config `app.desktopNotify: true`（未false）→ 一级可用
- `playNotifySound()`（`:1198-1211`）：生产 config `telegram.notifySound: true` → 发声
- `notice()`（`:2119-2121`）→ `broadcastSafe('notice', ...)` → 界面顶部气泡

---

### Q5 前端收到 `telegram_message` 后会做什么？

**答：后端确实一条都没推过（Q1/Q3 已证）；而且就算推了，前端也主要只往采集日志写一行字 —— 老板「看着像没提醒」这个直觉是对的。**

`public/app.js:3137-3152`：

```js
es.addEventListener('telegram_message', (e) => {
  let m = {}; try { m = JSON.parse(e.data || '{}'); } catch (err) { return; }
  onTelegramMessageLive(m);                        // :3140
  tgLog(`收到新消息 · ${m.name || m.customerCode || ''}`);   // :3141
  const accNo = Number(m.accountId || m.accId || 0);
  const pane = accNo === 8 ? 'tele2' : 'tele1';
  appendTgLog(pane, 'ok', who, `采到消息 · ...`);   // :3148
});
```

- `onTelegramMessageLive(m)`（`public/app.js:5497-5511`）：
  ```js
  if (!m || m.accountId == null || m.accountId < 7) return;
  const pane = document.querySelector('.mid-pane[data-mp="tele1"]');
  if (!pane || pane.classList.contains('hidden')) return;   // 没打开 Tele① 直接返回
  renderTgFriends();
  if (tgActiveCode) renderTgChat(tgActiveCode);
  ```
  **只在Tele① 中栏页签「已打开且可见」时才重绘好友列/对话**，否则**什么都不做**
- `appendTgLog(mp, kind, who, text)`（`public/app.js:5299`）：往 Tele①/Tele② 的**采集数据日志**写一行文字

**→ 老板的「点了好友才像有反应」有两层原因叠加：**

1. **后端层**：MTProto handler 抛错，压根没推过（主因）
2. **前端层**：即便推了，`onTelegramMessageLive` 在 Tele① 没打开时直接 return；打开时也只是刷新列表+
   日志加一行，**没有弹窗、没有闪烁、没有声音**（真正的弹窗/声音在 `notifyTelegramIncoming` 那条独立路径上）

另外 `main.js:3021` 的广播条件 `if (m && m.accountId >= 7)`：MTProto 传的 `accountId=7`，满足；
而 `telegramOfficialChannel` 的消息体里 `name:''`（`:171`），所以日志里「采到消息 · 未知客户」——
**即使真推了，界面上也是一行看不出所以然的字**。

---

## 三、修复建议

### 方案 A（推荐）：修 `:170` 一行 + 补齐 handler 的必要处理

**改动 1（必做，断点本体）—— `src/telegramOfficialChannel.js:170`**

```js
// 错：m.date 是 number（unix 秒），.getTime() 必抛
ts: (m.date ? m.date.getTime() : Date.now()),
// 对：
ts: m.date ? new Date(m.date * 1000).toISOString() : new Date().toISOString(),
```

>注意 `ts` 最终进 `messages.msg_ts`（TEXT 列），`telegramMtproto.js:153` 用的就是 ISO 字符串，保持一致。

**改动 2（强烈建议，同一次一起做）—— handler 换成复用 `telegramMtproto` 的 `toContract`**

`telegramOfficialChannel.js:157-177` 改成调用 `telegramMtproto.js` 已有的、已被生产验证过的映射逻辑，
或至少补上：`stripTrailingTime`（`:146`）、`isSavedMessage`（`:172`）、空消息丢弃（`:150`）、
`getPeerEntity` 取 name/username/phone（`:159-167`）。

- 优点：一处改动同时解决时间戳 + 姓名 + 翻译带时间 + 收藏夹误建档四个问题；`toContract` 已在 `telegramMtproto.js` 里写好
- 缺点：需要把 `telegramMtproto.toContract` 导出（目前未导出），或把实体缓存传进来

**改动 3（可延后）—— `telegramOfficialChannel.js:88` 补 `sessionPath` 导出**

现在 `main.js:3423` 的`telegramMtproto.sessionPath(...)` 和 `telegramOfficialChannel` 内部
`sessionPath()`（`:48-50`）是两份实现，探针实测 `telegramOfficialChannel.sessionPath` 为 `undefined`。
统一到一份，避免以后改路径漏改。

**验证口径**：改完必须**开着MTProto 路、不点任何 T 按钮**，让同事从另一账号发一条消息，
主进程 console 应出现 `[客户码](Telegram)：正文`，DB 出现 `wa_msg_id = <数字peerId>:<数字msgId>`、
`msg_ts` 与 `created_at` 差值 = 消息真实延迟（几秒~几分钟，不是 0），且 Windows 右下角弹气泡。

### 方案 B：改启动入口，把启动时采集交给 `telegramMtproto`（已验证可用的那套）

`main.js:3164-3166` 改成调`telegramMtproto.ensureWatching({ accounts: enabled, cfg, hooks: telegramHooks(), dataDir: DATA_ROOT })`
（即它 `:318` 那个目前**无人调用**的函数）。

- 优点：`startAccount`（`:214-256`）是**唯一**带 `client.connect() → getMe() 探活 → registerWatching` 完整链条的实现；
  `registerWatching`（`:265-294`）还额外有 20 秒 `pollDialogs` 未读统计，能点亮状态条「列表 N 项/ 未读 M 个」
- 缺点：仍然要先修好 `date` 问题？不 —— `telegramMtproto.js:153` **本来就是对的**，
  所以方案 B **不需要改任何采集代码就能立刻通**。但 `telegramOfficialChannel` 仍是发送/取资料的主路
  （`server.js:1624/1819`），会留下「采集走 mtproto、发送走 officialChannel」两个 `clients` Map 各持一个连接
- 适用：想**最快让老板看到自动提醒**，这是最小改动

> ⚠️ 两方案都会让同一账号开两个 MTProto 连接（各自 `clients` Map）。Telegram 允许多设备，
> 但同一 authKey 被两个进程/连接复用有被踢风险。**长期应二选一，只留一套。**

### 方案 C（架构正解，工作量最大）：合并成一个模块

把 `telegramOfficialChannel.js` 与 `telegramMtproto.js` 合成一个，`clients` Map、`sessionPath`、
事件 handler 各只留一份；`server.js` 的发送/取资料调用点统一指向它。

- 优点：根除「两份会话路径 / 两份 parseProxy / 两套映射」这类问题；`telegramWebView.js`（59KB 死代码）
  和 `telegramRead.js` 的空壳 `ensureWatching` 一并清掉
- 缺点：改动面大，需回归发送、取资料、登出（`telegramLogout.js` 依赖 `telegramMtproto.stopAccount`）、
  应用内登录弹窗（`telegramLogin.js:23` 依赖 `telegramMtproto.parseProxy/saveSession`）等多处

### 顺带建议（不阻塞老板的诉求，但会让体验更好）

1. **`telegramRead.startWatching` 的 `autostart=false`（`:740/754`）保持现状** ——
   老板 18:27 明确要求「点顶栏 T 按钮才开浏览器」。**这一条不能改**，改了就回退老板的另一个需求。
   DOM 路只当「MTProto 万一连不上时的人工兜底」（`telegramChannel.js:20-22` 的原意）。
2. **删掉 `telegramRead.ensureWatching` 里的 `continue`（`:828`）或整个函数** —— 现在是纯空壳，
   却让 `main.js:3196` 以为「ensure 保活」在生效。
3. **`telegramOfficialChannel` 的 `onMessages` 建议按 `telegramMtproto` 的做法加个 `onState`
   心跳/未读轮询**，让状态条能显示 MTProto 真的在收（现在只有 `connected:true` 一下就没声音了）。
4. **`telegramWebView.js`（59KB）建议删文件**，而不是靠 `main.js:198` 置 null ——
   `server.js` 里 9 处引用会一直误导后来人以为该路可用。

---

## 四、一句话回答

> **要「不点任何东西就自动提醒」，最该改的是 `src/telegramOfficialChannel.js:170`：
> 把 `ts: (m.date ? m.date.getTime() : Date.now())` 改成 `ts: m.date ? new Date(m.date * 1000).toISOString() : new Date().toISOString()`。**
>
> 这一行是整条链的唯一断点：它让 MTProto 官方直连在**每一条**新消息上抛
> `TypeError: m.date.getTime is not a function`，异常被 teleproto 的 `dispatch.js:183-193` 吞进内部 logger，
> 主进程零日志，所以 `telegramHooks().onMessages` 永远收不到东西，提醒链路（`main.js:3012`，本身是对的、也无双响残留）
> 根本没机会执行。改完 MTProto 就自动推了 —— 老板**不需要点任何按钮、不需要重新登录**
> （实测会话有效：`isUserAuthorized=true`、`getMe=wanfengzhiqiu/16058384634`、`startWatching` 返回 `{ok:true,opened:[7]}`）。
>
> 但只改这一行是「能弹提醒」而非「做对了」：同一个 handler 还缺 `stripTrailingTime` / `isSavedMessage` /
> 空消息丢弃 / 取客户姓名四项（`telegramOfficialChannel.js:162-173` 对比 `telegramMtproto.js:146-167`），
> 建议同一批一起补，否则会「翻译里带时间」「收藏夹被当客户建档」「客户名一直空」。

---

## 五、验不了的部分（如实说明）

| 项 | 状态 | 卡在哪 |
|---|---|---|
| 修完之后的端到端提醒 | **验不了** | 本次只诊断、不改代码；且不能代替老板发消息（铁律：绝不自动发送） |
| 「生产环境当时是否真抛了 TypeError」 | **无直接日志** | `client._log.error` 不落主进程 console；`bootLog` 只记启动阶段步骤（`src/bootLog.js`）。**结论基于代码 + 真实会话复现，非现场日志** |
| 8/9 号 MTProto | **验不了** | 无 `telegram-session-8/9.txt`，从未登录；实测报`Required field "phoneNumber" of auth.SendCode is missing`，属预期 |
| 内置浏览器 webview 路 | **验不了** | `main.js:198` 已置 `null`，整条路不存在，无从验证 |
| 网络/代理对生产的实际影响 | **已排除** | 探针实测 `connect()` 2081ms 成功、`getMe()` 返回真实账号，代理为空（生产 config `telegram.proxy` 未设/空）也通 |

---

## 六、探针清单（已全部删除）

| 文件 | 用途 | 结论 |
|---|---|---|
| `.tmp-diag2-db.js` | messages 表结构 / 渠道分布（第一版） | 发现 `messages` 无 `channel` 列 |
| `.tmp-diag2-db2.js` | join customers 查telegram 44 条明细 | 确认 0 条 MTProto 形态、`lag=0` |
| `.tmp-diag2-mt.js` | 真实会话 connect/getMe 只读探针 | 授权有效、账号 wanfengzhiqiu |
| `.tmp-diag2-startwatch.js` | 真实 `startWatching`（账号 7） | `{ok:true,opened:[7]}`，25s 内 0 事件 |
| `.tmp-diag2-prod.js` | 生产 config + 3 账号 `startWatching` | 7 开；8/9 缺 phoneNumber 失败（被吞成 warn） |
| `.tmp-diag2-datetype.js` | **复现 `m.date.getTime()` 抛错** | **3/3 消息全抛 TypeError（核心证据）** |

全部为 `readonly: true` 打开数据库，无UPDATE / DELETE / VACUUM，未触碰生产数据。