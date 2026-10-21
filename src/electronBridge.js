/**
 * electronBridge.js — Electron 主进程侧的「桌面系统通知 + 新消息提示音」（v2.6.1138）
 *
 * 起因：老板 2026-10-16 报告「Telegram 网页版来新消息，软件不会提示」。查出来的真因：
 *   src/main.js 里的 notify() 原来只认 `node-notifier`，而这个包
 *   **既不在 package.json、也不在 node_modules** —— 所以 notifier 恒为 null，
 *   通知退化成「往终端打一行 log + 写一个 BEL 字符」。开发时在终端里能看见，
 *   打包成 exe 之后用户**完全看不到任何提示**。
 *
 * 这个文件只干两件事，都必须在 Electron 主进程里做：
 *   ① notifyDesktop()  弹 Windows 右下角的系统通知（Electron 内置 Notification）
 *   ② playSound()      响一声短促提示音（Electron 内置 shell.beep）
 *
 * 🔴 为什么提示音也放在主进程、不走渲染进程 WebAudio：
 *   config.yaml 的 telegram.notifySound 是个**存在但从没被用过**的开关
 *   （全项目搜不到任何 new Audio / AudioContext / beep），勾了也不会响。
 *   而渲染进程那条路要改 public/app.js 挂 IPC listener —— 那个文件正有别人
 *   在并行修改，碰了会覆盖别人的工作。主进程 shell.beep() 不需要碰任何前端文件。
 *
 * 🔴 这个文件**永远不抛异常**。它是「锦上添花」的提示层，
 *   绝不能因为通知失败把消息入库主流程打断（notify 的调用点在 handleTelegramMessage
 *   的中间，抛出去等于这条消息处理到一半炸掉）。所有对外方法都 try/catch 全包，
 *   失败一律返回 false，让调用方落到下一级兜底。
 *
 * 🔴 依赖注入：这个模块不直接 require('electron')，而是由 createBridge() 注入。
 *   好处是离线单测能塞假实现，不启Electron、不响喇叭也能验分支走向
 *   （见 tools/.tmp-notify-probe.js）。
 */

'use strict';

/** 通知正文最多给多少字符（Windows 通知气泡太长了会被截断得很难看）。 */
const BODY_MAX = 240;

/**
 * 默认的 Electron 加载器。
 *
 * 注意一个坑：纯 Node 环境（跑单测、命令行脚本）里 `require('electron')`
 * **不会抛异常** —— electron 这个包的入口会把自身可执行文件的路径导成一个字符串。
 * 所以不能只靠 try/catch 判断，必须再确认拿到的是个对象。
 *
 * @returns {object|null} electron 主进程 API 对象；不可用时返回 null
 */
function defaultLoadElectron() {
  try {
    const e = require('electron');
    if (!e || typeof e !== 'object') return null; // 纯 Node 下是路径字符串
    return e;
  } catch (err) {
    return null; // 没装 electron / 不在主进程
  }
}

/**
 * 造一个通知桥。
 *
 * @param {object} [deps] 依赖注入口（全部可选，线上调用可以不传）
 *   - loadElectron  `() => object|null` 取electron API，默认 defaultLoadElectron
 *   - write         `(string) => void` 往 stdout 写字，默认写process.stdout
 * @returns {object} 桥实例，见各方法注释
 */
function createBridge(deps = {}) {
  const loadElectron = typeof deps.loadElectron === 'function'
    ? deps.loadElectron
    : defaultLoadElectron;
  const write = typeof deps.write === 'function'
    ? deps.write
    : (s) => {
        try {
          process.stdout.write(s);
        } catch (err) {
          /* stdout 被关掉之类的极端情况，忽略 */
        }
      };

  /** undefined=还没探测过；null=探测过、这个环境里不可用。探测只做一次。 */
  let electronCache;
  /** 终端兜底用的 BEL 字符（终端响一声；打包成 exe 后听不见，仅别处都不行时用）。 */
  const BEL = String.fromCharCode(7);

  /**
   * 拿到electron API（带缓存，每个进程最多 require 一次）。
   * 为什么要缓存：通知是「每来一条新消息就调一次」的高频路径，
   * 每条都try/catch + require 一遍纯属浪费，也会把异常吞进日志里看不清。
   * @returns {object|null}
   */
  function electron() {
    if (electronCache === undefined) {
      electronCache = loadElectron() || null;
    }
    return electronCache;
  }

  /**
   * 弹一个系统通知。
   *
   * 成功返回 true（弹出去了）；不可用或抛异常返回 false，
   * 由调用方决定落到 node-notifier / 终端兜底。
   *
   * @param {string} title 通知标题
   * @param {string} message 通知正文，内部会截到 BODY_MAX 字
   * @param {boolean} [silent] 是否静默。默认 false = 让Windows 用自己的提示音。
   * @returns {boolean} 是否真的弹出了系统通知
   */
  function notifyDesktop(title, message, silent = false) {
    const e = electron();
    if (!e || typeof e.Notification !== 'function') return false;
    try {
      // 不设 icon：找不到图标文件时 Electron 会静默失败，白折腾。
      const n = new e.Notification({
        title: String(title == null ? '' : title),
        body: String(message == null ? '' : message).slice(0, BODY_MAX),
        silent: !!silent,
      });
      if (!n || typeof n.show !== 'function') return false;
      n.show();
      return true;
    } catch (err) {
      return false; // 某些环境（如通知被系统关掉）会抛，一律不当 fatal
    }
  }

  /**
   * 响一声短促提示音。
   *
   * 首选 `electron.shell.beep()` —— Windows 上它走系统默认提示音（MessageBeep），
   * 不依赖任何外部音频文件，打包成 exe 也能用。
   * 不可用时退回写终端 BEL（开发时有用，打包后基本听不见，但总比不响强）。
   *
   * @returns {boolean} 是否真的触发了发声（true=走了 shell.beep）
   */
  function playSound() {
    const e = electron();
    if (e && e.shell && typeof e.shell.beep === 'function') {
      try {
        e.shell.beep();
        return true;
      } catch (err) {
        /* 落到下面的 BEL 兜底 */
      }
    }
    try {
      write(BEL);
    } catch (err) {
      /* 真写不出去就算了，绝不抛 */
    }
    return false;
  }

  /**
   * 最后一级兜底：把通知内容打到终端 + 一个 BEL 字符。
   * 跟 v2.6.1138 之前 notify() 的兜底行为逐字一致，方便对照。
   *
   * @param {string} title
   * @param {string} message
   */
  function logFallback(title, message) {
    try {
      console.log(`\n[通知] ${title}：${message}`);
    } catch (err) {
      /* 忽略 */
    }
    write(BEL);
  }

  /**
   * 诊断用：这个进程里Electron 能力可不可用。
   * @returns {{electron: boolean, notification: boolean, beep: boolean}}
   */
  function capabilities() {
    const e = electron();
    return {
      electron: !!e,
      notification: !!(e && typeof e.Notification === 'function'),
      beep: !!(e && e.shell && typeof e.shell.beep === 'function'),
    };
  }

  return { notifyDesktop, playSound, logFallback, capabilities };
}

/** 模块级默认实例（Electron 主进程里直接能用）。 */
const bridge = createBridge();

module.exports = {
  createBridge,
  defaultLoadElectron,
  bridge,
  BODY_MAX,
};