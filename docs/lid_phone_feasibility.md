# LID 取号可行性结论（whatsapp-web.js 1.34.7）

> 2026-10-07 · 只做了源码核查与诊断工具，**没有改任何业务代码，没有动生产数据**。

## 一句话结论

**有帮助，而且关键零件你项目里已经装了 —— 只是被"号码校验规则"自己挡住的。**

---

## 一、源码里确认存在的能力

`whatsapp-web.js` 1.34.7 有一个官方公开接口（`Client.js:3307`）：

```js
await client.getContactLidAndPhone(['123456789@lid'])
// → [{ lid: '123456789@lid', pn: '447726795080@c.us' }]
```

它内部调注入层的 `enforceLidAndPnRetrieval`（`Utils.js:1694`），核心两行：

```js
let phone = isLid
    ? window.require('WAWebApiContact').getPhoneNumber(wid)   // ← LID 换真号码
    : wid;
```

没有开关限制，是正式功能。

**还有一条更底层的路**（我新挖到的，优先级最高）：

```js
window.require('WAWebLidMigrationUtils').toPn(lidId)
```

wwjs 自己在渲染群成员列表时，就是用 `toPn` 把 participant 的 `@lid` 换成 `@c.us` 的（`Utils.js:961-965`）。这是 WhatsApp 官方的 LID 迁移通道。

---

## 二、你项目的现状（关键发现）

| 项 | 情况 |
|---|---|
| 已装版本 | `node_modules/whatsapp-web.js` = **1.34.7**（和你下载的源码同版本） |
| `getContactLidAndPhone` | **代码里已经在调了**（`src/identity.js:287`） |
| 兜底层数 | 共 5 层：官方接口 → 注入层 → Contact 模型 → DOM 抓取 → 消息正文 |

所以**不是"缺方法"，是"调了但没拿到"**。可能断在这几个点：

1. **`phoneFromJid` 把结果挡掉了** — 它只认 `@c.us` / `@s.whatsapp.net`。
   如果 `getPhoneNumber()` 返回的是**纯数字不带后缀**，会被 `plausiblePhone()` 判成"不像号码"而丢弃。
2. **`isLidPhone()` 误杀** — 判据是"LID 客户 + 号码长度 ≥ 14 位就作废"。
   某些国家的合法号码（含国际区号）可能正好踩线。
3. **8 秒超时太短** — `CONTACT_TIMEOUT = 8000`，而 `queryWidExists` 是一次真实网络往返，冷启动时可能不够。
4. **没用上 `LidMigrationUtils.toPn`** — 你现有 5 层里没有这一条。

---

## 三、诊断工具（已写好，未运行）

`tools/lid_probe.js` — 复用软件自己的登录态，只读不发送。逐层实测 7 条路：

| 层 | 测什么 |
|---|---|
| 环境自检 | 62 个 WA 内部模块哪些还在、WhatsApp 版本号、`ApiContact` 上的方法名 |
| L1 | 官方接口 `getContactLidAndPhone` |
| L2 | 注入层 `enforceLidAndPnRetrieval` |
| L3 | 底层模块直调 `ApiContact.getPhoneNumber / getCurrentLid / getAlternateUserWid` |
| L3b | 网络查询 `QueryExistsJob.queryWidExists`（会带回 pn） |
| **L3c** | **官方迁移工具 `LidMigrationUtils.toPn`（新增，最高优先级）** |
| L4 | Contact 模型的 `phoneNumber` 字段 |
| L5 | 网页 DOM（你在页面上能直接看到号码的位置） |

### 怎么跑

```bash
cd E:/WorkBuddy-Projects/wa-assistant

# 自动挑最近会话里前 20 个 @lid 来测
node tools/lid_probe.js --accounts 1 --auto 20

# 或指定客户
node tools/lid_probe.js --accounts 1# 243834688639050@lid
```

会弹出一个浏览器窗口并连上 WhatsApp（复用已登录状态，不会发任何消息）。
结果同时打到屏幕和 `tools/lid_probe_report.json`。

**跑之前请先关掉正在运行的桌面软件** —— 同一个 `chrome-acc-1` 目录不能被两个 Chrome 同时占用。

---

## 四、拿到结果后怎么改（先不动手，等你同意）

诊断结果会直接告诉我是上面 4 个断点里的哪一个。对应的改法：

| 若诊断显示 | 改法 | 风险 |
|---|---|---|
| L3c `toPn` 能出号码、但 L1/L2 出不来 | 在 `resolveLidPhone` 里把 `toPn` 加为第 0 优先 | 极低，纯新增一条路 |
| 底层返回纯数字被 `phoneFromJid` 挡掉 | 放宽后缀判断（数字 + 7~15 位就认） | 中，需确认不会把 LID 数字当号码 |
| `isLidPhone` 误杀 | 把"≥14 位"改成"≥15 位"或按区号判 | 中，会影响已存客户 |
| L3b 查询超时 | `CONTACT_TIMEOUT` 8s → 20s | 低，只是变慢 |

**任何一条都要先跑诊断拿到证据再改，不猜。**

---

## 五、一个必须说清的前提

即使全部打通，WhatsApp 对**陌生人的首次会话**本来就不下发手机号——
LID 是隐私保护机制，服务端就没有真实号码可给。
所以可解的范围是：

- ✅ 对方在通讯录里 / 曾互加过 / 曾在群里 → 通常能解
- ✅ 对方主动给你发过名片式分享 → 能解
- ❌ 纯陌生人、对方没存你、没共同群 → **服务端也拿不到，这条路走不通**

你现在遇到的"一直无法获取"，很可能有一部分是落在 ❌ 这个范围里。
诊断工具的 L3b（`queryWidExists`）能区分：它返回 `NULL` 就是服务端确认查不到。