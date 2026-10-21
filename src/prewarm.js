/*
 * 预热互斥闸门（v2.5.1036 · 老板拍板的扫描节奏）
 * =====================================================================
 * 老板原话（2026-10-11）：
 *   「扫描是我们打开 S1 后才开始检测进程……当出现绿灯后，说明已经登陆成功，
 *     你就不需要再一直扫描，你可以 611 秒扫描一次，扫描前三秒其他的扫描不能跟它
 *     同步要都停下来，扫描结束后 1 秒才能预热其他的开始，相当于在 608 之前的
 *     预热都正常安排。大概意思这个预热块启动了，其他的预热都停下来，不能跟它走一起。」
 *
 * 所以本模块干两件事：
 *
 *  ① 【总闸 arm()】软件登录 + 数据同步走完进度条之前，**所有预热一律不动**。
 *     只有 startBackgroundServices() 调了 arm() 之后，下面的定时器才开始干活。
 *     （v2.5.1035 已经把预热挪到登录后了，这里再补一道保险：
 *       /api/state 这类被动查询也绝不允许偷偷触发扫描。）
 *
 *  ② 【互斥 gate()】进程扫描（S1~S3 状态灯）要独占一个静默窗口：
 *        扫描前 3 秒  → 别的预热全部让路
 *        扫描中      → 只有扫描在跑
 *        扫描后 1 秒  → 让机器喘口气，别的预热才重新排队
 *     其余 ~600 秒，别的预热照常各跑各的。
 *
 * 🔴 设计原则：这是一个**协作式**闸门，不是抢占式。
 *    每个预热点在动手前问一句 gate()，被闸住就跳过本轮、稍后重试。
 *    这样绝不会出现「两个重活挤在一起打架」的情况，也不用杀掉任何真实动作。
 */

/** 闸门让路到这个时间戳为止（毫秒）；0 = 没人在闸 */
let _holdUntil = 0;
/** 谁占着闸门（排障用，比如 'launcher-scan'） */
let _owner = '';
/** 总闸：登录 + 同步走完了才 true */
let _ready = false;

const now = () => Date.now();

/**
 * 把闸门压到指定时间戳。
 * 🔴 只延后、不提前：别人已经占住的窗口绝不会被缩短，防止两个预热互相踩。
 * @param {number} ts 绝对时间戳（毫秒）
 * @param {string} [owner] 占用者名字（排障用）
 */
function holdUntil(ts, owner) {
  const t = Number(ts) || 0;
  if (t > _holdUntil) {
    _holdUntil = t;
    _owner = owner || '';
  }
  return _holdUntil;
}

/** 从现在起再占 ms 毫秒 */
function hold(ms, owner) {
  return holdUntil(now() + Math.max(0, Number(ms) || 0), owner);
}

/** 此刻闸门是不是关着（别的预热该不该让路） */
function blocked() {
  return now() < _holdUntil;
}

/** 闸门还要关多久（毫秒） */
function remaining() {
  return Math.max(0, _holdUntil - now());
}

/** 闸门体检信息（给日志 / 自检用） */
function status() {
  return { blocked: blocked(), remainingMs: remaining(), owner: _owner, ready: ready() };
}

/**
 * 每个预热点动手前问一句这个。
 * @returns {{skip:boolean, retryInMs:number, owner:string}} skip=true → 本轮跳过，retryInMs 后重试
 */
function gate() {
  if (!ready()) return { skip: true, retryInMs: 5000, owner: 'not-ready' };
  if (!blocked()) return { skip: false, retryInMs: 0, owner: '' };
  return { skip: true, retryInMs: remaining() + 200, owner: _owner };
}

/**
 * 等到闸门打开（最多等 timeoutMs 毫秒）。
 * 给「开 Telegram 浏览器窗口」这种一次性重活用 —— 撞上进程扫描就先等着。
 * 🔴 超时也会照常返回（不 reject），绝不能因为等闸门把某个功能卡死不启动。
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<boolean>} true = 闸开了；false = 等到超时
 */
async function waitUntilFree(timeoutMs = 30000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (!ready() || !blocked()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !blocked();
}

/**
 * 总闸：登录成功 + 云端/本地同步走完进度条后调用（startBackgroundServices）。
 * 调用之前，任何预热（扫进程 / 解 Signal 密钥 / 读 Signal 库 / 开 Telegram / 重建 Word）都不许动。
 */
function arm() {
  _ready = true;
}

/** 总闸是否已开 */
function ready() {
  return _ready;
}

module.exports = {
  hold,
  holdUntil,
  blocked,
  remaining,
  status,
  gate,
  waitUntilFree,
  arm,
  ready,
  /** 测试用：恢复初始状态 */
  _reset() {
    _holdUntil = 0;
    _owner = '';
    _ready = false;
  },
};
