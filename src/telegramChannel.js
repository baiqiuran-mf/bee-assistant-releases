/**
 * telegramChannel.js — 【Telegram 通道常量·单线 A 版】
 *
 * 🔴 2026-10-13 老板拍板：取消 A / B 双版本，收敛为**一条线**。
 *
 * 原因（真实事故）：A 包与 B 包的 appId 同为 com.beeassistant.app、productName 同为
 * 「蜜蜂信息采集」、userData 同为 D:\蜜蜂采集数据\wa-assistant —— NSIS 认作同一个程序，
 * 第二个包直接覆盖第一个；即使装上两份，登录态 / SQLite / 板块文件也会互相污染。
 * 双版本在同一个 appId 下**不可能共存**，所以取消 B 版，只保留 A 版一条线。
 *
 * 现在固定走：MTProto 官方直连（telegramOfficialChannel.js）
 *   - 需在设置 →「📨 Telegram」页签填 my.telegram.org 的 api_id / api_hash
 *   - 能拿客户真实手机号、头像、最后上线时间
 *   - 不依赖 Telegram 网页是否登录
 *
 * 本文件**只导出常量**，不再读环境变量 BEE_TG_CHANNEL，也不再有运行时 if/else 分流。
 * 导出字段名（CHANNEL / IS_A / IS_B / CRED_HINT …）保持不变，
 * 这样 main.js、server.js 里的调用点一个字都不用改，牵连面最小。
 *
 * 关于 telegramWebView.js（网页版通道）：**文件保留在仓库、也保留在安装包里**，
 * 只是不再被调用。留着的理由 —— MTProto 万一连不上还能手动看网页排查，
 * 以后要恢复也只改这一行。删掉它反而是「改A 功能牵连 B 功能」。
 *
 * 铁律：绝不自动发送。发送只由操作员点「发送」触发。
 */

'use strict';

/** 固定 A 通道：MTProto 官方直连 */
const CHANNEL = 'A';
const CHANNEL_LABEL = 'Telegram 官方直连';
const CHANNEL_DESC = '走 my.telegram.org 的 api_id / api_hash 官方直连，能取到客户手机号与头像';

const IS_A = true;
/* IS_B 保留为 false：调用点（server.js 的 userinfo 兜底提示等）仍会读它，
 * 不能删，否则那些判断会变成 undefined 而走进错误分支。 */
const IS_B = false;

/** 缺凭证时的提示文案 */
const CRED_HINT = '需要 api_id / api_hash：请到设置 →「📨 Telegram」页签填写'
  + '（在 https://my.telegram.org → API development tools 创建应用获取），'
  + '保存后回主窗口点中栏「Tele①」里的 Telegram 登录按钮，用手机号 + 验证码完成一次性登录。';

module.exports = { CHANNEL, CHANNEL_LABEL, CHANNEL_DESC, IS_A, IS_B, CRED_HINT };
