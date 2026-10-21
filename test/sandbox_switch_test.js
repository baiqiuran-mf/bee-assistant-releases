'use strict';
/**
 * 沙盘实测：用真实 notepad 窗口验证原生 settop.exe 的
 *  1) 启动延迟（对比旧 .NET 自包含版 300ms~2s）
 *  2) 按 pid 找到窗口并调用 SetForegroundWindow 的返回（setfg=）
 *  3) 诊断输出是否完整
 * 注意：沙盘是无头/服务会话，未必有真实"前台窗口"，setfg 可能为 False；
 *       但本测试重点是"启动瞬间 + 找窗 + 调用不崩 + 诊断可读"，这正是旧版 .NET 冷启动出问题的根。
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const exe = path.join(__dirname, '..', 'bin', 'settop.exe');
const fs = require('fs');
if (!fs.existsSync(exe)) { console.error('找不到 bin/settop.exe，先编译'); process.exit(1); }

// 1) 直接起一个真实窗口（notepad），pid 已知
const np = spawn('notepad.exe', [], { windowsHide: true });
const pid = np.pid;
console.log('启动 notepad，pid =', pid);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(1200); // 等窗口真正创建
  if (!pid) { console.log('没拿到 notepad pid，跳过'); process.exit(2); }
  console.log('notepad pid =', pid);

  // 2) 测启动延迟 + 调用
  const t0 = process.hrtime.bigint();
  const r = spawnSync(exe, ['--pid', String(pid), '--wait', '2000'], { encoding: 'utf8', timeout: 15000 });
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log('--- settop 输出 ---');
  console.log('stdout:', (r.stdout || '').trim());
  console.log('stderr:', (r.stderr || '').trim());
  console.log('exit:', r.status);
  console.log('>>> 启动+执行耗时 =', ms.toFixed(1), 'ms  （旧 .NET 自包含版约 300~2000ms）');

  // 3) 清理
  spawnSync('taskkill.exe', ['/f', '/pid', String(pid)], { windowsHide: true });
  console.log('--- 结论 ---');
  if (r.status === 0 && (r.stdout || '').includes('ok')) {
    console.log('PASS: exe 正常找窗+调用+输出诊断，未崩溃');
    if (ms < 100) console.log('PASS: 启动延迟 <100ms（已达 NativeAOT 即时目标）');
    else console.log('WARN: 启动延迟偏高', ms.toFixed(1), 'ms');
  } else {
    console.log('FAIL: exe 异常', r.status);
  }
})();
