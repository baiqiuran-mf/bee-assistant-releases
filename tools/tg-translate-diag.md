# Telegram 翻译失败 77% · 诊断报告

- **诊断日期**：2026-10-16
- **诊断范围**：`E:\WorkBuddy-Projects\wa-assistant`（源码）+ `D:\蜜蜂采集数据\wa-assistant\data\assistant.db`（生产库，只读）
- **纪律声明**：**本次未修改任何项目源码文件**。所有探针脚本均为新建的 `.tmp-diag-*.js`，只跑 `SELECT` / 内存计算 / 只读 HTTP 请求，生产库全程 `readonly: true` 打开，无任何 `UPDATE` / `DELETE` / `VACUUM`。

---

## 一、结论摘要（一句话）

**77% 失败率的根因只有一个：AI 服务商的 token 没有 `gpt-4o-mini` 的访问权限，翻译请求 100% 被服务端拒绝（HTTP 403）。**

跟翻译内容、消息长度、并发、批量、数据库都**没有关系**。老板看到的 10 条「成功」**没有一条是真的调用 AI 成功的** —— 那 10 条全部是**跨消息翻译记忆命中**（0 次 AI 调用直接复用旧译文），AI 实际成功率是 **0/34**。

---

## 二、失败原因分类表

| # | 根因 | 证据（file:line / 实测输出） | 占比 |
|---|---|---|---|
| **A** | **AI 服务商 token 无模型权限 → HTTP 403**（主因） | 实测：`POST https://ai.tikhub.io/v1/chat/completions` `model=gpt-4o-mini` → `HTTP 403`，body：`This token has no access to model gpt-4o-mini`。配置来源 `D:\蜜蜂采集数据\wa-assistant\config.yaml:117-119`（`tasks.translate.provider: "tikhub"` / `model: "gpt-4o-mini"`）+ `:249`（`bubble.translateModel: "tikhub"`） | **34/34（100% 的 AI 调用）** |
| **B** | 403 被 `complete()` 吞成 `null`，不抛错 → 队列误判为「翻译无返回」 | `src/ai.js:461` `throw new Error(httpError(...))` → `src/ai.js:554-558` `catch { recordError(); console.error(...); return null; }`。异常**从不冒到** `src/translator.js:258` 的 catch，所以 `lastError` 里只会留下「翻译无返回」，日志也查不到真实原因 | 34/34 |
| **C** | 「安静回退」掩盖配置错误（放大器，非独立根因） | `src/ai.js:293-305` `resolveTaskWithProvider`：providerKey 为空或那家没配好时 `return base`，**不抛错、不告警**。本次 `bubble.translateModel=tikhub` 配得好好的（有 key），所以走了 A 的 403 分支；若老板改选一家没配 key 的，会静默回落到 `tasks.translate`，界面上照样一片红 | 设计缺陷 |
| **D** | 失败计数与状态机（**行为正常，不是 bug**） | 唯一写 `failed` 的地方是 `src/translator.js:300`，且必须 `translate_tries >= MAX_AUTO_TRIES(=2)`（`src/translator.js:46`、`90`、`292-299`）。实测 34 条**全部** `translate_tries=2` → 说明每条都**老实试满了 2 次**，状态机没毛病 | 34/34（结果，非病因） |

### 已被证据**排除**的假设

| 假设 | 排除依据 |
|---|---|
| 消息太长 / token 超限 | 最长正文 122 字符（id 994-998），中位数 5 字符；`CHUNK_LIMIT=1400`（`translator.js:35`），远未触发。失败集中在 1~10 字符的串（`Hi`/`C`/`F`/`Y`） |
| 并发打爆 / 批量状态机错乱 | `CONCURRENCY=4`、`BATCH_MAX=6` 正常。**反证**：同一秒（`03:35:09`）既有 5 条 failed 又有 5 条 done，说明队列在正常逐条出结果，不是整体卡死 |
| 没网 / 网络失败 | 实测同机 HTTP 正常出网：deepseek 200 / hunyuan 200 / agnes 200 / tikhub 403。**403 是服务端业务拒绝，不是网络问题** |
| `telegram.notifySound` 影响翻译 | 已确认无关。运行时 `notifySound: true`（`config.yaml:246`），不参与翻译链路 |
| 数据库/schema 问题 | `translate_state`/`translate_tries` 列正常（`db.js:199`、`230`），44 条记录状态自洽 |
| 翻译记忆「串味」导致失败 | 记忆表 51 行、无重复 `src_norm`、无空 `body_zh`；失败条目里 19 条确实无记忆（正常走 AI），另 15 条有记忆但**仍失败** —— 恰恰证明记忆不是失败原因，而是**成功的唯一原因** |

---

## 三、关键证据链（为什么 10 条「成功」不是真成功）

这是本次诊断最反直觉、也最重要的一点。

`src/translator.js:171-177` 和 `:220-233` 在调 AI **之前**先查跨消息记忆，命中就 0 次 AI 调用直接复用：

```
job → translationMemory.lookup(body) → 命中 → return mem.zh → finish() → 'done'
```

对照数据库，**8 条 done 全部是记忆命中**：

| 消息 | 正文 | 记忆表 updated_at | 消息 created_at | 说明 |
|---|---|---|---|---|
| 988 | `October 9` | 03:37:15.607 | 03:35:08.779 | 命中 |
| 994-998 | `platinum-vip...`(5条) | 03:35:10.528~.551 | 03:35:09.453~.478 | 命中 |
| 1005 | `October 9` | 03:37:15.607 | 03:37:15.603 | 命中 |
| 1018 | `Today` | 03:38:28.386 | 03:38:28.362 | 命中 |

**决定性反证**：有 15 条 failed 的正文（`Hi`/`hi`/`hello`/`Hello`/`Y`/`F`）在记忆表里**明明有对应行**，却依然 failed —— 因为运行中的版本（`v2.6.1136`，`.tmp-asar-1123`）在**这批消息入库时**还没接上记忆/或记忆表当时是空的，之后才被回填。若记忆当时生效，它们本该秒回 done。

> **所以：AI 真实成功率 = 0%。老板看到的 10 条成功，是记忆兜的底，不是模型能用。**

---

## 四、需要老板做什么（不用改代码）

**这是外部配置问题，必须老板动手。** 任选其一：

| 方案 | 操作 | 实测结果 |
|---|---|---|
| **A（推荐）** | 把 `tasks.translate` / `bubble.translateModel` 用的 **tikhub 模型名从 `gpt-4o-mini` 改成 `gpt-4o`** | ✅ 实测 `HTTP 200`，批量路径正确返回 6 元素数组 `["他","谢谢","嗨","嗨","嗨","你好"]` |
| B | 保留 `gpt-4o-mini`，去 tikhub 后台给这个 token 开通该模型权限 | 需老板去控制台操作 |
| C | `tasks.translate` 改用 **deepseek**（`api.deepseek.com`，key 已配） | ✅ 实测 `HTTP 200`，返回「嗨」；仓库 config 里本来就是 deepseek |

> tikhub 这个 token 当前**只能访问 `gpt-4o`**。实测 `GET /v1/models` 返回：`[{"id":"gpt-4o"}]` —— 清单里**没有** `gpt-4o-mini`。所以方案 B 要么加钱开通，要么就换成 `gpt-4o`。

**改完怎么验证**：软件里点任意一条消息的「重翻这条」（`translator.js:95` `retryManual`，会清零 `translate_tries` 并绕过记忆强制重翻），或重启软件后打开客户触发 backfill。

⚠️ **注意**：光改配置不会自动翻好那 34 条 —— 它们 `translate_tries` 已经 = 2，被 `autoAllowed()`（`translator.js:90`）拉黑了。必须手动「重翻」或重启后走 backfill（`backfill()` 同样受 `autoAllowed` 约束，`translator.js:350`）。**这是第二个需要修的源码问题（见 F）。**

---

## 五、修法方案对比

### 问题 F：34 条已「烧死」的消息无法自动恢复（真正的源码缺陷）

| 方案 | 优点 | 缺点 | 推荐 |
|---|---|---|---|
| **F1 老板手动逐条点「重翻这条」** | 零改动、零风险；`retryManual` 已实现且会 `force:true` 绕过记忆 | 34 条要点 34 次；`server.js:2756` 是单条接口，没有批量入口 | ❌ 仅应急 |
| **F2 改 `MAX_AUTO_TRIES` 或让 `backfill` 忽略 tries 上限** | 一处改动批量恢复 | 削弱「防烧 token 总闸门」，可能重演老板 2026-09-30 遇到的老问题（无限重试白烧钱） | ⚠️ 需谨慎 |
| **F3 加一个「全部重翻」批量入口**（复用 `retryManual` 逻辑做批量版） | 一次点击搞定；保留总闸门；只对用户显式操作生效 | 要写新接口 + 新按钮，改动量最大 | ✅ **推荐** |
| **F4 修好 provider 后自动把 failed 放回队列一次**（带「已修复配置」的标记位） | 体验最好 | 需要状态位，复杂度偏高；可能与总闸门打架 | ⏳ 后续 |

### 问题 C：`resolveTaskWithProvider` 静默回退 + 403 被吞（可观测性缺陷）

| 方案 | 优点 | 缺点 | 推荐 |
|---|---|---|---|
| **C1 把 401/403/404 单独识别，**落库/上报**而不是吞成 null** | 改动小；老板一眼知道是「key 没权限」不是「网络卡」 | 只是诊断改善，不解决失败本身 | ✅ **推荐（与 A 同批做）** |
| C2 让 `complete()` 对鉴权类错误抛异常 | 能触发 `translator.js:258` 的 catch，错误信息更全 | 会把「配置错」和「翻译失败」混成一类；可能造成批量任务整批 `finish` 失败 | ❌ |
| C3 静默回退时打一条 warn 日志 | 成本最低 | 日志在 `logs/` 里不好找（实测该目录**只有 boot 日志，无任何翻译日志**），老板依然看不到 | ⚠️ 收益有限 |

### 关于并发 / 超时（**建议先不动**）

| 方案 | 优点 | 缺点 | 推荐 |
|---|---|---|---|
| 调 `CONCURRENCY`（4→2）或加退避重试 | 密集入库时更稳 | **当前失败与并发无关**（根因是 403）；改它无法修好这次的问题，反而掩盖真因 | ❌ 现在别动 |

---

## 六、附：本次使用的临时探针脚本（便于复核）

全部在 `E:\WorkBuddy-Projects\wa-assistant\` 根目录，均为**新建**、只读、未删改任何项目文件：

| 文件 | 用途 |
|---|---|
| `.tmp-diag-db.js` | 打开生产库，打印 `messages` 表结构、表清单（只读连通性验证） |
| `.tmp-diag-db2.js` | `messages` 全列名 + 各账号 `translate_state` 分布 |
| `.tmp-diag-db3.js` | 导出 44 条 Telegram 消息的 id/状态/tries/正文/译文 |
| `.tmp-diag-db4.js` | 按 `created_at` 排序做状态-时间相关性分析 |
| `.tmp-diag-db5.js` / `.tmp-diag-db6.js` | 导出 `translation_memory` 表结构与全部 51 行 |
| `.tmp-diag-db7.js` | 比对 34 条失败正文是否命中记忆表 |
| `.tmp-diag-bak.js` | 对比 4 份历史备份库的记忆表内容 |
| `.tmp-diag-dup.js` | 检查记忆表重复 `src_norm`、空译文 |
| `.tmp-diag-verify.js` | **核心验证**：证明 8 条 done 全是记忆命中、34 条 failed 全无 AI 成功；并列出 18 条「身份/拒答」污染记忆 |
| `.tmp-diag-ai-live.js` | 按 `ai.js:430-488` 原样复刻请求，tikhub 实测 **403**、deepseek 实测 **200** |
| `.tmp-diag-ai-live2.js` | 复刻批量路径（`ai.js:794-806`）→ 403；并查 tikhub `/models` → 只有 `gpt-4o` |
| `.tmp-diag-ai-live3.js` | 5 家 provider 逐一实测：tikhub/gpt-4o-mini ❌403，其余 4 家 ✅200 |
| `.tmp-diag-ai-live4.js` | 验证修法：批量路径 `gpt-4o-mini` 403 vs `gpt-4o` 200 且正确返回 6 元素数组 |

---

## 七、附带发现（本次诊断顺带查到，**未修**，供老板决策）

1. **翻译记忆已被污染（18 行）**：`translation_memory` 里有 18 条「译文 == 原文」或「抱歉，我无法处理这个请求」的垃圾行（例如 `F`→`F`、`Y`→`Y`、`Nilai13:3713:37`→原文、5 条 IP 串→`抱歉，我无法处理这个请求。`）。来源：模型早期把代理/测试串原样吐回，`translator.js:186` 的 `record()` 不做「译文是否等于原文」的校验就写库了。后果：**这些垃圾译文会被永久复用**，等于把噪声喂给客户。
   - 对应代码：`src/translator.js:186` `if (zh) translationMemory.record(job.body, zh, picked)` —— `zh` 非空就记，没有 `zh !== 原��` 的判断。

2. **老板提供的「5 条 failed 译文与原文一字不差」这一条线索，实际情况是 `done` 不是 `failed`**：那 5 条（id 994-998）状态是 `done`，译文确实等于原文，但**原因是记忆命中复用了污染行**（见上条），不是「failed 却写入了译文」。数据库层面已复核确认，特此更正。

3. **日志查不到翻译失败原因**：`logs/` 下只有 `boot-*.log`（`bootLog.js` 明确定位为「只记启动自检」），全目录 grep `翻译|translate|failure|error` **零命中**。`ai.js:556` 的 `console.error` 只进 electron 主进程控制台，不落文件。所以这次能定位靠的是数据库 + 复刻请求，不是日志。
