# Supported features 逐项对照 · 你的软件用到了哪些、漏了哪些

> 2026-10-07 · 对照 `whatsapp-web.js` 1.34.7 README 的Supported features 表（28 项）
> **结论：安装这个包没有任何新帮助 —— 你已经装了 1.34.7，同一个版本。**

---

## 一、先纠正一个可能的误解

README 那张表列的28 项能力，是**这个库能做**什么，**不是"能拿电话号码"**。

仔细看表里跟"客户信息"沾边的只有三项：

| 表里的项| 说明 |
| --- | --- |
| **Get contact info** | 拿联系人资料 —— **你已经在用**（`identity.js:450`） |
| Get profile pictures | 拿头像 —— 你**还没用** |
| Receive location / media | 收位置 / 收媒体 —— 你已经在用 |

**这张表里根本没有"获取电话号码"这一项。** 号码不是靠这张表的能力拿的，是靠我上一轮找到的
`getContactLidAndPhone` / `LidMigrationUtils.toPn` 这类**内部 LID 换算接口**——
它们不在README 里，是读源码才能挖到的。

所以"看Supported features 决定装不装"这个思路，方向不对：**包已经在跑了，问题是调用链某一环断了。**

---

## 二、你的真实架构（重要，之前没说清）

我核对代码后发现你走的是**混合架构**，不是纯 wwjs：

| 环节 | 你实际用什么 | 位置 |
| --- | --- | --- |
| 收消息 | ✅ **wwjs 事件** `client.on('message_create')` | `session.js:274` |
| 拿联系人资料 | ✅ **wwjs 接口** `getContactById` / `msg.getContact()` | `identity.js:450` |
| 收媒体 | ✅ wwjs `downloadMedia` | `media.js` |
| **发消息** | 🔴 **不走 wwjs，直接操作网页 DOM 预填** | `main.js:391prefillIntoPage` |

发消息走 DOM 不是偷懒，是你项目铁律「**绝无自动发送**」的必然结果——
`sendMessage` API 会直接发出去，而预填完由人按回车。
**所以那5 项Send 类能力你**永远不会用**，这是设计，不是缺漏。

---

## 三、28 项逐条判定

### ✅ 已在用（5 项）
| 能力 | 用在哪 |
| --- | --- |
| Multi Device | 已装 1.34.7，本来就在 |
| Receive messages | `session.js:274` `message_create` |
| Get contact info | `identity.js:450` |
| Receive location | 归档字段 |
| Receive media | `media.js` |

### 🔴 故意不用（6 项）——铁律决定，不是缺漏
Send messages / Send media / Send stickers / Send contact cards / Send location /
群管理类（kick/promote/setSubject） / Channels

**理由**：前 5 项会绕过"人工确认发送"；后两项不是群运营场景。

### 🟡 还没用、但对你有价值的（4 项）

| 能力 | 方法 | 对油画销售的用处 | 风险 |
| --- | --- | --- | --- |
| **Get profile pictures** | `getProfilePicUrl` | 客户头像。① 识别是否真人（空白头像 vs 有头像）② **可反过来搜客户社交账号，找更多画像素材** | 只读，无风险 |
| **React to messages** | `msg.react` | 对方消息的"轻互动"（比"我读了你的消息"更自然不冷淡） | ⚠️ 会真的发出去，**与你铁律冲突，需你先拍板** |
| **Block/unblock contacts** | `blockContact` | 风控拉黑：把明确要骗样品的国家客户拉黑（对应你那份外贸风控清单） |⚠️ 会真的拉黑，需你点头 |
| **Create polls / Vote** | `createPoll` | 客户偏好调研（"你更想要A 尺寸还是 B 配色"） | ⚠️ 会真的发出 |

### ⚪ 低价值（2 项）
Mute/unmute chats、Set user status（后者理论上可自动挂"营业中"，但对私聊成交无实质帮助）

###💡 一个我新挖到的字段（不在表里）
`Contact` 结构体第 35 行：
```js
this.number = data.userid;   // Contact's phone number（官方注释就是这么写的）
```
而注入层 `Utils.js:1042` 是`res.userid = ContactMethods.getUserid(contact)`。

**这是官方注释标成"电话号码"的另一个字段，和 `id` 是两条路。**
你现在只用 `id`（`getContactModel` 第 1014 行在`contact.phoneNumber` 有值时会把 id 换成真号码）。
**诊断时应该同时读 `number` 字段** —— 如果 `id` 是 @lid 但 `number` 有值，那就是不用改任何代码直接能用。

---

## 四、直接回答你的两个问题

### Q：「安装这个 js 能有帮助吗？」
❌ **不能，而且不需要装。** 你项目 `node_modules/whatsapp-web.js` 实测就是 **1.34.7**，
和你下载的源码**完全同一个版本**。装一遍等于什么都没变。

### Q：「那要怎么做？」
**靠跑诊断定位断点，不靠看README。**

我已经把工具写好了（`tools/lid_probe.js`），它会逐层实测 7 条路，并额外读上面那个 `number` 字段：

```bash
cd E:/WorkBuddy-Projects/wa-assistant
node tools/lid_probe.js --accounts 1 --auto 20
```

跑之前先关掉正在运行的桌面软件（同一个 `chrome-acc-1` 目录不能被两个 Chrome 同时占用）。

**拿到结果后按证据改**，可能的三种情况：

| 诊断显示 | 改法 | 风险 |
| --- | --- | --- |
| `Contact.number` 有值但被当垃圾丢掉 | 读取并入库（**最理想，不用碰任何现有逻辑**） | 极低 |
| `LidMigrationUtils.toPn` 能换出号码 | 在 `resolveLidPhone` 里加为第 0 优先 | 极低，纯新增 |
| 底层返回纯数字被 `phoneFromJid` 挡掉 | 放宽后缀判断 | 中，要确认不会把 LID 数字当号码 |

---

## 五、期望上限（必须说清，避免白忙）

**纯陌生人的手机号，服务端就没有，WhatsApp 不会给。** LID 是隐私保护机制。

| 客户关系 | 能不能解 |
| --- | --- |
| 在你通讯录里 / 曾互加过 | ✅ 能 |
| 共同群成员 | ✅ 能 |
| 对方发过名片式分享 | ✅ 能 |
| **纯陌生人，没存你、无共同群** | ❌ **服务端也拿不到** |

库里的实际情况：**4 个 `@lid` 客户，3 个没号码**。
诊断工具的 L3b（`queryWidExists` 返回 `NULL`）就是服务端亲口确认"查不到"的判据——
跑一次就能把"能救的"和"救不了的"分开，不用再猜。