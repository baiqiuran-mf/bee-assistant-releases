# Telegram「对话信息 / 人物资料」拆分方案

> 只读诊断 + 方案设计，**本轮零产品代码改动**。
> 数据来源：生产库 `D:/蜜蜂采集数据/wa-assistant/data/assistant.db`（`better-sqlite3-multiple-ciphers`，`{ readonly: true }`）。
> 结论全部代码实证，判「有没有引入某段代码」前**已剥离 JS 注释**（中文注释里出现关键词会造出假失败）。
> 诊断日期：2026-10-16　库大小：`assistant.db` 188,416 B + `-wal` 407,912 B（**注意有活跃 WAL**，只读打开会连 `-shm`/`-wal` 一起读，统计口径已含 WAL 内未 checkpoint 的数据）。

---

## ① 现状体检

### 1.1 全库渠道分布（12 个客户 / 74 条消息）

| channel | 客户数 |
|---|---|
| `whatsapp-web` | 4 |
| **`telegram`** | **4** |
| `signal` | 3 |
| `whatsapp` | 1 |

🔴 **坑（已复核）**：`channel` 列只在 `customers` 表上（`src/db.js:195` 的 `ensureColumn`），`messages` 表**没有** `channel`。查 Telegram 消息必须：

```sql
SELECT m.* FROM messages m JOIN customers c ON c.code = m.customer_code
WHERE c.channel = 'telegram';
```

### 1.2 🔴 Telegram 客户 4 条，但**只有 3 个是活的**

| code | voided | void_note | wa_jid | tg_username | 消息数 |
|---|---|---|---|---|---|
| `7A00001` | **1** | 已合并进 `7A00002`（增量防裂）· 2026-10-16T03:32:22.154Z | `tg:wanyu lee` | — | **0** |
| `7A00002` | 0 | — | `tg:8696576132` | — | 6 |
| `7A00003` | 0 | — | `tg:Eileen Lin` | `EileenLin09` | 16 |
| `7A00004` | 0 | — | `tg:Xue` | `wanfengzhiqiu` | 22 |

`7A00001` 是 `src/telegramMerge.js` 的 `mergePair` 产物（调用点 `src/main.js:2423`「增量防裂」），它**标废但不物理删除**。→ **4 条记录 ≠ 4 个客户，实际 3 个真人。**

### 1.3 字段填充率（telegram，n=4）

| 类别 | 字段 | 填充 | 说明 |
|---|---|---|---|
| 标识 | `id` `code` `account_id` `wa_jid` `channel` | **4/4** | 全有 |
| 标识 | **`tg_username`** | **2/4** | 只有 7A00003 / 7A00004 |
| 标识 | `phone` | **0/4** 🔴 | 全空 |
| 标识 | `phone_src` | **0/4** 🔴 | 全空（phone 空导致） |
| 标识 | **`region`** | **0/4** 🔴 | 全空 |
| 标识 | **`timezone`** | **0/4** 🔴 | 全空 |
| 标识 | **`mood`** | **0/4** 🔴 | 全空 |
| 标识 | **`summary`** | **0/4** 🔴 | 全空 |
| 标识 | **`profile_json`** | **0/4** 🔴 | 全空（16 项档案一个都没落库） |
| 过程 | `name` | 4/4 | 全部来自 `wa_jid` 解析，非真人确认 |
| 过程 | `stage_day` `pending` `unread` `is_sim` `voided` `created_at_source` | 4/4 | 全是默认值 |
| 过程 | `created_at` `last_msg_at` `queue_since` | 4/4 | 全有 |
| 过程 | `void_note` | 1/4 | 只有 7A00001 |

**结论：能填的填了，该填的一个没填 —— 人物资料层基本是空的。**

### 1.4 消息形态分布（telegram，n=44）

| 维度 | 分布 |
|---|---|
| `direction` | `in` 32 / `out` 12 |
| 正文长度 | 1–20 字 **33 条**（75%）、21–50 字 1 条、51–100 字 5 条、101–300 字 5 条、301+ **0 条** |
| 长度 min/中位/max | **1 / 5 / 125** |
| `body_zh`（中文译文） | **8/44**（18%） |
| `translate_state` | `done` 8 / `failed` **34**（77%）/ `null` 2 |
| `processed` | 全部 `0` |
| `msg_time` | 29/44 |
| `media_path` / `media_type` / `media_zh` | **0/44**（全空） |

**正文内容特征（逐条正则扫 44 条）**：

| 特征 | 命中 |
|---|---|
| 含中文 CJK | **1/44** |
| 含西里尔字母 | 0/44 |
| 含阿拉伯字母 | 0/44 |
| **含私用区字符 U+E000–F8FF** | **0/44** ✅ |
| 含 Emoji | 0/44 |
| 含孤立代理对（豆腐块根因） | **0/44** ✅ |
| 含控制字符 | 0/44 |
| `socks5://` | 0/44 |
| **`host:port:user:pass` 代理凭据串** | **10/44** 🔴 |
| 任意 `http(s)://` URL | 10/44 |
| 裸 IP | 5/44 |

#### 🔴 安全发现：7A00003 是**代理同行**，不是买家

`7A00003` 的 16 条消息里 **10 条**是明文代理凭据，形如：

```
198.87.177.142:8022:szezcdsxxz:oqwmwemoeemoyi
https://198.87.177.142:8022/...
platinum-vip.miyavip.vip:8001:szezcdsxxz:oqwmwemoeemoyi
```

⚠️ 首次扫我用 `/socks5|proxy|api[_-]?key/` 这类关键词，**报 0 命中 —— 假失败**。换成结构化正则 `host:port:user:pass` 才抓到 10 条。**这是本轮最重要的方法论教训：判断「有没有」必须按数据结构匹配，不能按关键词猜。**

这条发现直接支撑方案：**「客户类型」字段不是概念问题，是数据已经摆在库里了，只是没人读。**

### 1.5 字段三分类 + 能填 vs 该填但空着

#### A 类 · 对话信息（messages 表 = 「聊了什么」）

`body` / `body_zh` / `direction` / `msg_ts` / `msg_time` / `media_path` / `media_type` / `media_zh` / `translate_state`

#### B 类 · 人物资料（customers 表 = 「这个人是谁」）

| 字段 | 能填? | 该填? | 写入点 `file:line` | 空着的**根因**（实证） |
|---|---|---|---|---|
| `tg_username` | ✅ 2/4 | ✅ | 写入 `src/db.js:525`（`saveTgUsername`）<br>调用 `src/main.js:2330`、`src/main.js:2435`<br>列声明 `src/db.js:214` | Telegram 用户**可能没设用户名**（隐私设置），技术上限 |
| `name` | ✅ | ✅ | `src/db.js:462`（建档）/ `src/db.js:584`（`backfillIdentity`）<br>TG 调用 `src/main.js:2325`、`src/main.js:2429` | 已填，但值来自 `wa_jid` 文本解析，非确认 |
| `phone` | ❌ | ❌ | `src/db.js:505`（写入口）<br>TG 采集 `src/main.js:2316-2325`（`getUserProfile`） | **Telegram 官方隐私：不设手机号就永远拿不到。技术硬限制** |
| `region` | ❌ | ✅ **该有** | `src/db.js:458`（建档）/ `src/db.js:584`<br>推导 `src/server.js:212`（`guessTimezone` 依赖 region） | 🔴 **TG 链路根本没传 region**：`backfillIdentity` 支持 `info.region`（`src/db.js:588`），但 7 个调用点里**只有 WA 三条传了**（`src/main.js:2566`、`2692`、`3075`）；TG 的两条（`src/main.js:2325`、`2429`）**只传 name/phone**。→ **纯代码疏漏，可修** |
| `timezone` | ❌ | ✅ **该有** | 推导 `src/server.js:212` / `src/regions.js:279`（`guessTimezone`）<br>手改 `src/server.js:2362-2381` | 🔴 **完全依赖 `region`** —— region 空 → timezone 必然空。**同一个根因** |
| `profile_json` | ❌ | ✅ **该有** | 写 `src/server.js:138`（`updateCustomerSafe`）/ `src/server.js:2440`<br>16 键定义 `src/ai.js:816-817`<br>前端提交 `public/app.js:1858-1870` | 🔴 **Telegram 从没调过 `/extract`**：`extractProfileOf`（`src/server.js:510`）只在 `POST /api/customer/:code/extract` 触发，而「对话提档」按钮**只挂在 Tele①/② 的 `tg-profile-extract`**（`public/index.html` 第 336 行区），**没有自动循环**。→ **功能存在但没人按** |
| `stage_day` | ⚪ 4/4 但全 0 | ✅ | 计算 `src/server.js:127`（`dayOf`）<br>存 `src/server.js:135`/`230`/`2436` | 恒为 0：存的是 `DEFAULT 0`（`src/db.js` 建表 `stage_day INTEGER DEFAULT 1` 但 TG 路径写入 0），**实际 Day 由前端 `daysSince()` 现算**（`public/app.js:4927`） |
| `mood` | ❌ | ⚪ 可选 | 写 `src/server.js:136` | AI 建议时产出（`src/ai.js:637` 只**读**），**从不落库** |
| `summary` | ❌ | ✅ **该有** | 写 `src/server.js:137`/`476` | 🔴 全库 `summary` 唯一写入点是 `updateCustomerSafe`，而前端 `saveProfile()`（`public/app.js:1844`）**根本没提交 summary 字段** → 永远写不到 |

#### C 类 · 过程状态（🚫 **不该出现在人物资料里**）

| 字段 | 含义 | 写入点 |
|---|---|---|
| `pending` | 有待处理（界面红点） | `src/db.js:775` |
| `unread` | 未读新消息计数 | `src/db.js:197` |
| `is_sim` | 「模拟新消息」造的假客户 | `src/db.js:462` / `db.js:1423` |
| `processed` | 消息是否已处理 | messages 表 |
| `translate_state` / `translate_tries` | 翻译队列状态 | messages 表 |
| `media_fetch_state` / `media_fetch_tries` | 媒体下载状态 | messages 表 |
| `queue_since` | 待处理排队时间 | `src/db.js:258` |
| `created_at_source` | 加入时间来源 | `src/db.js:207` |
| `voided` / `void_note` | 合并标废 | telegramMerge |

🔴 拆分的第一价值就在这：`pending`/`unread`/`is_sim` 现在和 `name`/`region` 混在同一张卡片上，**老板看到「未读 3」会当成客户属性**。

### 1.6 前端现状（复核结论）

**Tele① 已经是三栏横排**（`public/index.html:261` `.tele-wrap`，`public/style.css:595` `display:flex`）：

| 栏 | 容器 | 宽度 | CSS |
|---|---|---|---|
| ① 好友对话 | `.tg-friends` `#tg-friends` | `flex: 0 0 240px` | `public/style.css:3101` |
| ② **对话信息** | `.tg-chat` `#tg-chat` | `flex: 1 1 auto`（弹性） | `public/style.css:3146` |
| ③ 资料卡+日志 | `.tg-conv-aside` | `flex: 0 0 300px` | `public/style.css:3154` |

渲染入口：
- `renderTgChat(code, mp)` — `public/app.js:5148`（气泡 + 译气泡 + 时间方框，`msgs.slice(-30)`）
- `renderTgConvInfo(code, mp)` — `public/app.js:5206`（**纯转调** `renderTgChat`，无独立逻辑）
- `loadTgProfile(code, mp)` — `public/app.js:4867`
- `renderTgProfile(c, autoTz, mp)` — `public/app.js:4913`（竖排单列，7 项基本信息 + 4 项 MTProto）
- 资料卡 CSS：`.tv-card` / `.tv-ln` — `public/style.css:2926`/`2944`（`public/style.css:640-780`、`3190-3215` 是 TG 专属区块）

#### 🔴🔴 最硬的约束（必须写进方案）

`.tg-conv-aside` / `.tele-wrap` **不是 Telegram 专属**，被 **7 个面板共用**：

`public/index.html` 里 `.tg-conv-aside` 出现在 **325（tele1）、447（tele2）、521（wa1）、567、607、647** 行 —— **WA①~⑤ 全部复用**。`public/style.css:3084` 的注释亲口承认：

> 「🔴 选择器必须带上 `.mid-pane[data-mp="tele1"]`：WA① 用的是同一套 `.tele-wrap` / `.tg-conv-aside`」

**所以：任何对 `.tg-conv-aside` 的裸改动都会波及 WA①~⑤。** 方案必须靠 `data-mp` 前缀隔离。

### 1.7 孤儿档案文件（7 个，已逐个核对）

DB 现有 12 个编号，档案目录 26 个 `.md`。**Telegram 孤儿 = 7 个**（DB 无对应行）：

```
7A00005_Eileen Lin_未知电话.md      7A00009_wanyu lee_未知电话.md
7A00006_Xue_14324165473.md          7A00010_Eileen Lin_未知电话.md
7A00007_Richard Bennett_未知电话.md  7A00011_Saved Messages_未知电话.md
7A00008_Xue_未知电话.md
```

⚠️ 另有 WA/Signal 孤儿 10 个（`1A00002/07/15/16/17/18/20/21/22/23`），**本方案不动它们**。
⚠️ `7A00011_Saved Messages` —— Telegram 的**自己发给自己的收藏夹**，不是客户。

---

## ② 方案设计（3 套）

### 决策点速览

| # | 决策点 | 方案一 | 方案二 | 方案三 |
|---|---|---|---|---|
| 1 | 界面形态 | 右栏内**上下分栏**（资料/日志各占一屏） | 中栏内**页签切换**（对话/资料） | **左中右**三栏，资料独立成第 4 列 |
| 2 | 数据来源 | 新增 6 列到 `customers` + 复用 `profile_json` | 同方案一 | 新增**独立 `customer_profile` 表** |
| 3 | 资料字段 | 22 字段（见下） | 同方案一 | 同方案一 + 历史版本表 |
| 4 | 怎么填 | AI 提取 + **人工确认门** | AI 全自动 | AI 提取 + 人工 + 留痕版本 |
| 5 | 兼容 | 不迁移，只读展示 | 同 | 同 + 一次性回填 |

---

### 方案一 · 右栏上下分栏（原地加固）⭐ **推荐**

**1. 界面形态**
不动 `.tg-friends`（240px）和 `.tg-chat`（弹性）。把 **`.tg-conv-aside` 内部**由「资料卡 + 采集状态 + 日志」纵向堆叠，改成**上下两块**：

- **上 · 人物资料**（`flex: 1 1 auto`，可滚动）：身份 → 商业 → 跟进 → 风险 → AI 下一步
- **下 · 过程状态**（`flex: 0 0 auto`，固定高 ≈140px，可折叠）：未读 / 待处理 / 排队时间 / 翻译失败数 / 采集日志

**2. 数据来源**
`customers` 表 **新增 6 列**（全部 `TEXT`，避开已有 `stage_day`/`mood`/`summary`）：

```sql
ensureColumn('customers', 'biz_type',      "TEXT DEFAULT ''");  -- 买家/同行/代理/未知
ensureColumn('customers', 'intent_level',  "TEXT DEFAULT ''");  -- A/B/C/D
ensureColumn('customers', 'budget',        "TEXT DEFAULT ''");  -- 预算
ensureColumn('customers', 'category_pref', "TEXT DEFAULT ''");  -- 猫/狗/人物/风景
ensureColumn('customers', 'size_pref',     "TEXT DEFAULT ''");  -- 尺寸偏好
ensureColumn('customers', 'risk_note',     "TEXT DEFAULT ''");  -- 风控标注
```

**3. 人物资料字段（22 项，跨境内油画销售）**

| # | 字段 | 来源 | 现在能拿到？ | 拿不到的原因 |
|---|---|---|---|---|
| **身份** ||||
| 1 | TG 用户名 | `tg_username` | ✅ 2/4 | 用户没设则无（技术限制） |
| 2 | 显示名 | `name` | ✅ | 来自 jid 解析，需人工确认 |
| 3 | 手机号 | `phone` | ❌ | **Telegram 隐私，技术硬限制** |
| 4 | 地区 | `region` | ❌ | 🔴 **代码疏漏**：`src/main.js:2325`/`2429` 没传 region |
| 5 | 时区 | `timezone` | ❌ | 🔴 **同上，依赖 region** |
| 6 | 语言 | ➕ 新增 | ❌ | ⚪ **压根没这个概念**（44 条里 1 条中文） |
| **商业** ||||
| 7 | 客户类型 | ➕ `biz_type` | ❌ | ⚪ **没这个概念** —— 但 7A00003 的 10 条代理凭据**已经能判** |
| 8 | 意向等级 | ➕ `intent_level` | ❌ | ⚪ **没这个概念** |
| 9 | 预算 | ➕ `budget` | ❌ | ⚪ **没这个概念**（对话里没人提钱） |
| 10 | 品类偏好 | ➕ `category_pref` | ❌ | ⚪ **没这个概念** |
| 11 | 尺寸偏好 | ➕ `size_pref` | ❌ | ⚪ **没这个概念** |
| **跟进** ||||
| 12 | 来源 | ➕ 静态 | ✅ | Telegram 官方通道（`renderTgProfile` 已硬编码，`public/app.js:4962`） |
| 13 | 首次联系 | `created_at` | ✅ | 已有 |
| 14 | 当前阶段 | 现算 | ✅ | `daysSince()`（`public/app.js:4927`） |
| 15 | 下一步动作 | ➕ 新增 | ❌ | ⚪ **没这个概念** |
| **风险** ||||
| 16 | 8 国风控 | ➕ `risk_note` | ❌ | ⚪ **知识在 `knowledge/redlines.md:319-326` 但没结构化接进库** |
| 17 | 可疑标记 | ➕ `risk_note` | ⚪ | 7A00003 代理凭据 = 高危信号 |
| **AI** ||||
| 18 | AI 建议下一步 | ➕ 新增 | ❌ | 复用现有 `suggest` 链路 |

> 复用不新增的 4 项：`name` / `tg_username` / `created_at` / 现算 Day。

**4. 人物资料怎么被填**

| 子方案 | 做法 | 代价 | 铁律合规 |
|---|---|---|---|
| **一·AI 全自动**（不推荐） | 定时跑 `/extract`，直接写库 | 🔴 模型幻觉会把「他说要 2 个」写成预算；**不可逆** | ✅ 不涉及发送 |
| **一·AI + 人工确认门** ⭐ | AI 写入 `profile_json` + 每字段带 `_src='ai'`；界面每行右侧给「✓确认 / ✗改」按钮；人工点过才置 `manual` | 中等开发量 + 每次提档多点几下 | ✅ **AI 只出中文建议** |
| **一·纯手工** | 只开界面，字段留空 | 便宜但没价值——44 条消息已足够 AI 抽 | ✅ |

🔴 **铁律保障**：人物资料区**不含任何发送动作**。「AI 建议下一步」只出中文文字，复制走预填路线 —— 落点 `src/main.js:773` `prefillChat` → `src/main.js:786` `prefillIntoPage`（**只 `typeIntoInput`，全项目无自动回车**）。资料页永不调用它。

**5. 兼容**
- **不迁移** 7A00001（`voided=1`，`telegramMerge` 已标废，天然不出现在列表）
- **不迁移** 7 个孤儿 md（不删、不改、不显示；后续走独立清理任务）
- **WA/Signal 零影响**：所有新 CSS 一律带 `.mid-pane[data-mp="tele1"]` / `[data-mp="tele2"]` 前缀；新列 `DEFAULT ''`，`updateCustomerSafe`（`src/server.js:131`）用 `?? cur.x` 兜底，旧行读出空串

**优点**：改动面最小、风险最低、右栏 300px 够用、复用全部现有渲染
**缺点**：右栏 300px 要塞 22 项，**信息密度偏高**；过程状态仍在同一栏，靠上下分区分开

---

### 方案二 · 中栏页签切换（对话 / 资料）

**1. 界面形态**
`.tg-chat`（② 号栏，弹性宽度最大）**顶部加两个页签**：`对话信息` / `人物资料`。资料页复用 `.tv-ln` 竖排单列，宽屏下舒服。

**2. 数据来源**：同方案一（`customers` +6 列）
**3. 字段**：同方案一 22 项
**4. 怎么填**：同方案一「AI + 人工确认门」

**5. 兼容**
- 🔴 **中栏被资料占住时，对话气泡宽度被腰斩**（`.tg-chat` 原本 `flex:1 1 auto` 是全app 最宽的一栏）
- 页签状态存 `state`，实时新消息 `onTelegramMessageLive`（`public/app.js:5216`）切到资料页时要决定「跳回对话 or 角标提示」—— 额外状态机
- WA/Signal 隔离同上

**优点**：**资料页拿到全宽**，22 项不挤；改动集中在一个容器内
**缺点**：🔴 **对话宽度是老板天天用的**，页签一占就缩水；实时新消息在资料页时体验割裂；页签状态是隐式状态，容易「老板不知道为啥对话空了」

---

### 方案三 · 独立第 4 栏 + 独立表（左中右右）

**1. 界面形态**
`.tele-wrap` 由 3 栏变 4 栏：好友 240 + 对话 flex + 人物资料 280 + 过程状态/日志 240。
窄屏时 ③④ 可折叠（复用 `public/style.css:3083` 那套 `flex-basis` 降级）。

**2. 数据来源**：🔴 **新建独立表** `customer_profile`（不塞 `customers`）

```sql
CREATE TABLE IF NOT EXISTS customer_profile (
  code         TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,
  lang         TEXT DEFAULT '',
  biz_type     TEXT DEFAULT '',
  intent_level TEXT DEFAULT '',
  budget       TEXT DEFAULT '',
  category_pref TEXT DEFAULT '',
  size_pref    TEXT DEFAULT '',
  risk_note    TEXT DEFAULT '',
  next_action  TEXT DEFAULT '',
  ai_next_step TEXT DEFAULT '',
  field_src    TEXT DEFAULT '',   -- JSON: 每字段 ai/manual
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_cp_channel ON customer_profile(channel);
```

**3. 字段**：同方案一 22 项
**4. 怎么填**：AI 提取 + 人工确认 + **每次确认留一行版本**（`field_src` 记时间戳）

**5. 兼容**
- 新表对旧库零侵入 → 旧客户 `LEFT JOIN` 得全 NULL → 界面显示占位
- 🔴 `.tele-wrap` 是 7 个面板共用（`public/style.css:595`），**加第 4 栏会挤压 WA①~⑤** —— 必须只在 `[data-mp="tele1"]/[tele2"]` 下加 `> .tgf-profile { display:flex }`，WA 侧不写

**优点**：**结构最干净** —— 资料是独立实体，与过程状态物理隔离；带 `_src` 版本可追溯「这字段谁说的、什么时候改的」
**缺点**：🔴 **窗口宽度不够**（240+280+240 已占 760，还不含左边主窗）；新表 = 新增 12 列 + 新表 + 双写事务，**改动量约方案一的 3 倍**；`channel` 分桶意味着要处理 WhatsApp 客户的资料（**超出本轮老板要求**）

---

### ⭐ 推荐：方案一

**理由（三条）**：

1. **老板的话是「分两种」= 分类，不是「加一栏」**。方案一在**已有的三栏里**把「人物」和「过程」上下分开 —— 字面命中老板要求，且不新增窗格。
2. **窗口宽度是本项目的硬约束**。`public/style.css:3083` 一串注释全在处理「窗口窄了怎么降级」，说明这条路径已经踩过多次。方案三要 4 栏，必然重蹈覆辙。
3. **风险与工作量**。方案一新增 6 列（全 `TEXT DEFAULT ''`）、2 个新函数；方案三新增 1 表 12 列 + 跨渠道兼容。老客户 3 个、消息 44 条 —— **当前规模根本不需要独立表**，等 Telegram 客户过百再拆表不迟。

**建议路径**：先上方案一（含 AI 提取 + 人工确认门）→ 跑 2 周看 `_src=manual` 占比 → 若「人工确认率 > 60%」说明 AI 不够准，再加方案三的 `field_src` 版本留痕。

---

## ③ 落地拆解

### 3.1 文件清单（按实现顺序，括号内依赖）

| # | 文件 | 改动 | 依赖 |
|---|---|---|---|
| 1 | `src/db.js` | 6 个 `ensureColumn`（**加在 `src/db.js:304` 之后**，与既有风格一致）；`updateCustomer` 的 SET 补 6 个 `COALESCE(@x, x)` | — |
| 2 | `src/ai.js` | 新增 `promptExtractBizProfile()` + `extractBizProfile()`；**复用 `CORE/EXTRA_PROFILE_KEYS`（`src/ai.js:816-817`）的清洗层思路，但新写 12 键白名单**；`biz_type`/`intent_level` 加枚举校验 | 1 |
| 3 | `src/server.js` | ① `updateCustomerSafe`（`:131`）补 6 个 `?? cur.x`<br>② `POST /api/customer/:code/profile`（`:2436` 附近）收 6 字段<br>③ 新增 `POST /api/customer/:code/biz-extract` 调 `extractBizProfile`<br>④ `applyExtractedProfile`（`:261`）加 biz 字段落库 | 1, 2 |
| 4 | `src/regions.js` | `guessTimezone`（`:279`）加「**TG 昵称/用户名弱推断地区**」兜底：命中 8 国关键词表才判，否则返回 `null` **绝不瞎猜** | 1 |
| 5 | `src/main.js` | 🔴 **补 region**：`2325` 与 `2429` 两处 `backfillIdentity` 加 `region`（TG 昵称不含国家时传 `''`，由 4 兜底）。**一行级改动，收益最大** | 1, 4 |
| 6 | `public/index.html` | tele1 `:325` / tele2 `:447` 的 `.tg-conv-aside` **内部**加 `<div class="tgf-sec" id="tg-prof-upper">` + `<div class="tgf-sec tg-proc" id="tg-prof-lower">`；**在 `#tg-profile` 前插分隔线** | — |
| 7 | `public/app.js` | `renderTgProfile`（`:4913`）扩 22 项；新增 `renderTgProc`（过程状态区）；`tg-profile-extract`（`:3378`附近）改为调新 `/biz-extract` | 3 |
| 8 | `public/style.css` | 全部新选择器 **强制带 `.mid-pane[data-mp="tele1"]` / `[data-mp="tele2"]` 前缀**；复用 `.tv-ln`（`:2944`）与既有色板，不发明新色 | 7 |

### 3.2 数据库改动（幂等，照抄 `ensureColumn` 风格）

```js
/* v2.6.1140 · Telegram 人物资料商业字段（老板 2026-10-16 要求：对话信息 / 人物资料分开）
   全部 TEXT DEFAULT '' —— 老客户读出来是空串，界面显示占位，不报错、不迁移、不回填假值。
   为什么不用 JSON：这些字段要参与筛选与排序（左边按意向等级排），JSON 查不动。 */
ensureColumn('customers', 'biz_type',      "TEXT DEFAULT ''");   // 买家/同行/代理/未知
ensureColumn('customers', 'intent_level',  "TEXT DEFAULT ''");   // A/B/C/D
ensureColumn('customers', 'budget',        "TEXT DEFAULT ''");   // 预算
ensureColumn('customers', 'category_pref', "TEXT DEFAULT ''");   // 猫/狗/人物/风景
ensureColumn('customers', 'size_pref',     "TEXT DEFAULT ''");   // 尺寸偏好
ensureColumn('customers', 'risk_note',     "TEXT DEFAULT ''");   // 8 国风控 + 可疑标注
```

配套 `updateCustomer`（`src/db.js:469`）的 SET 段加 6 行（**必须 `COALESCE`，否则老调用方传 `undefined` 会把值擦掉**）：

```sql
    biz_type      = COALESCE(@biz_type, biz_type),
    intent_level  = COALESCE(@intent_level, intent_level),
    budget        = COALESCE(@budget, budget),
    category_pref = COALESCE(@category_pref, category_pref),
    size_pref     = COALESCE(@size_pref, size_pref),
    risk_note     = COALESCE(@risk_note, risk_note),
```

⚠️ **不建新表、不写迁移脚本、不 VACUUM**。

### 3.3 🔴 不改什么（硬清单）

| 不改 | 原因 |
|---|---|
| `messages` 表结构 | 对话信息已经够用，只缺翻译成功率（`failed` 34/44 是**翻译问题不是结构问题**） |
| `.tg-friends` / `.tg-chat` 的宽度 | 老板天天用的对话区，一像素都不动 |
| `.tele-wrap` 基础规则（`public/style.css:595`） | WA①~⑤ 共用 |
| `.tg-conv-aside` **裸选择器** | 同上，必须 `data-mp` 前缀隔离 |
| `renderTgChat`（`public/app.js:5148`）的气泡/译文/时间逻辑 | v2.6.1136/1138 刚修好，不碰 |
| `renderWaConvInfo` / `renderTgConvInfo` | **纯转调**，不碰 |
| `saveTgUsername` / `backfillIdentity` 的**语义** | 只在 `src/main.js` 调用点**补参数**，不改函数本身 |
| `knowledge/redlines.md` | 只读引用，不改 8 国风控原文 |
| 7 个孤儿 md、`_merged_backup/` | 不删不改，另开清理任务 |
| `7A00001`（`voided=1`） | 合并标废是 `telegramMerge` 的正确行为，**不复活、不删除** |
| WA / Signal / WA①~⑤ 全部字段 | 硬要求 |
| `package.json` / `npm install` / `npm run pack` | 本轮只出方案 |

---

## ④ 待老板拍板的问题

### Q1 🔴 最关键：资料区**放在哪**？

| 选项 | 说明 | 我的推荐 |
|---|---|---|
| **A. 右栏上下分栏**（方案一） | 资料卡上、过程状态下，300px 栏内切两屏 | ✅ **推荐**：不加窗格、不挤对话、改动最小 |
| B. 中栏页签（方案二） | 对话/资料两个页签，资料拿全宽 | ❌ 对话宽度是天天用的，页签一占就缩水 |
| C. 独立第 4 栏（方案三） | 左中右右 | ❌ 240+280+240 ≥ 760px，窄屏必崩 |

### Q2 🔴 商业字段（类型/意向/预算/品类/尺寸）**由谁填**？

| 选项 | 说明 | 代价 |
|---|---|---|
| **A. AI 提取 + 人工确认** ⭐ | AI 提，每行给「✓/✗」，人工点过才算 | 每次提档多点几下；**不会写入幻觉** |
| B. AI 全自动落库 | 定时跑直接写 | 便宜，但模型把「要 2 个」写成预算就**不可逆** |
| C. 纯手工 | 只开界面 | 没价值 —— 44 条消息足够 AI 抽 |

**我推荐 A。** 且 `_src` 标记来源，AI 猜的显示 `待确认` 灰色，人工点过变实色。

### Q3 `region`/`timezone` **要不要现在补**？

| 选项 | 说明 | 推荐 |
|---|---|---|
| **A. 只在 TG 昵称/用户名命中 8 国关键词时才判，其余留空** | 宁可空着也不瞎猜 | ✅ **推荐** |
| B. AI 从对话文本猜地区 | 44 条里只有 1 条中文，**基本猜不准** | ❌ |
| C. 维持现状（永远空） | 资料卡永远缺 2 个字段 | ❌ |

🔴 A 方案要配**「判不出来就明说」**：界面显示 `地区：未获取（对方未授权 / 未聊过）`，沿用 `public/app.js:4888` 已有的「未获取到」口径。

### Q4 `7A00003`（10 条代理凭据）**怎么定性**？

| 选项 | 说明 | 推荐 |
|---|---|---|
| **A. 标 `biz_type='代理/同行'` + `risk_note` 记明文凭据** | 立刻兑现「客户类型」字段的价值 | ✅ **推荐** |
| B. 标可疑但不定性 | 保守 | 一般 |
| C. 当普通客户 | ❌ 浪费现成信号 | ❌ |

⚠️ 附带问：这些**明文代理凭据存在 messages 表里**，云端同步/导出文档会带出去。要不要打码？

### Q5 资料区**要不要放过程状态**（未读/待处理/翻译失败）？

| 选项 | 说明 | 推荐 |
|---|---|---|
| **A. 放，但在资料区下方独立一块、不与资料混排** | 老板随时看得到，但不污染人物属性 | ✅ **推荐** |
| B. 全部移出右栏 | 纯粹 | ❌ 「未读 3」是老板高频信息，藏起来会挨骂 |
| C. 维持现状混排 | ❌ 这正是老板要拆的原因 | ❌ |

### Q6 资料字段**首版全要，还是先上 8 个**？

| 选项 | 说明 | 推荐 |
|---|---|---|
| **A. 先上 8 个高频**（用户名/显示名/地区/时区/客户类型/意向等级/风控/AI下一步） | 快，一个月内能用 | |
| **B. 22 个全上** | 一次到位 | ✅ **推荐**（老板说「分两种」是结构性要求，一次做对免得返工） |
| C. 只做界面留空 | 看着像没做完 | ❌ |

### Q7 AI 提档的**触发方式**？

| 选项 | 说明 | 推荐 |
|---|---|---|
| **A. 手动点「对话提档」按钮**（现状已有）+ 结果要人工确认 | 零新增定时器 | ✅ **推荐** |
| B. 新消息进来自动提 | 省事 | ❌ 每条消息调一次 AI，**成本和 34 条翻译失败一样失控** |
| C. 每天定时批量提 | 省事 | ❌ 新客户要等一天 |

### Q8 Tele② / 后续 Tele③ **同步吗**？

| 选项 | 说明 | 推荐 |
|---|---|---|
| **A. tele1 + tele2 一起上** | HTML 镜像，改两处 | ✅ **推荐** |
| B. 只上 tele1 | 快 | ❌ Tele② 立刻显得残缺 |

---

## 附：本轮踩的坑（给后续同学省时间）

1. **`channel` 只在 `customers` 上** —— `messages` 没有，查 TG 消息必须 `JOIN`（`src/db.js:195`）。
2. **判「有没有」必须按数据结构匹配，不能按关键词**。我用 `/socks5|proxy|api_key/` 扫代理凭据报 **0 命中**，换成 `host:port:user:pass` 才抓到 **10 条**（全在 `7A00003`）。假失败比假成功危险。
3. **剥离注释再 grep**。`region` / `mood` / `summary` 在中文注释里被提了几十次，裸 grep 出的行号大半是注释。
4. **`.tg-conv-aside` 是 7 个面板共用**（`public/index.html` 325/447/521/567/607/647 行），`public/style.css:3084` 有明文警告。裸改必炸 WA①~⑤。
5. **生产库有活跃 WAL**（`-wal` 407KB > 主库 188KB），只读统计要连 `-wal` 一起读，否则数字会偏小。
6. **4 条 TG 记录 ≠ 4 个客户**：`7A00001` 已 `voided=1` 合并进 `7A00002`（`src/telegramMerge.js` / `src/main.js:2423`）。