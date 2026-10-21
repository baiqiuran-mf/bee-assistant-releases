/**
 * 桌面软件测试启动器
 *
 * 它会真正验证【蜜蜂信息采集桌面应用】的功能。逻辑分两路，自动选择：
 *
 *   A. 本机 Electron 能开真实桌面窗口（你自己的 Windows 电脑）：
 *      真正拉起 Electron 桌面运行时（将来那个 .exe 跑的同一份代码），
 *      让桌面应用自己跑一遍内置自检（见 electron/main.js 的 selfTest），再退出。
 *      —— 这是"桌面软件测试"，不是网页测试。
 *
 *   B. 当前环境无法初始化 Electron 窗口（如本开发沙箱，应用子系统起不来）：
 *      改用【桌面应用同一套后端代码】（src/server.js + src/*）以 Node 跑功能自检。
 *      这同样是 .exe 运行的后端逻辑，只是不开原生窗口。
 *
 * 【数据安全】测试全程把数据写到 .tmp-test-data* 临时目录（通过 BEE_DATA_DIR），
 * 结束即删。你的真实 data/ 全程不被读写，所以不存在"还原失败污染数据"的风险。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP_DATA_WINDOW = path.join(ROOT, '.tmp-test-data-electron');

function findElectron() {
  const cand = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  return fs.existsSync(cand) ? cand : null;
}

/** 探测本机 Electron 内置模块是否可用（可用 = 能开真实桌面窗口） */
function electronUsable() {
  const electron = findElectron();
  if (!electron) return false;
  try {
    const r = spawnSync(electron, ['-e', "process.stdout.write(typeof require('electron').app)"], {
      cwd: ROOT, shell: false, timeout: 25000, encoding: 'utf8',
    });
    const out = (r.stdout || '').trim();
    return out === 'function' || out === 'object';
  } catch (e) {
    return false;
  }
}

function cleanDir(dir) {
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

/** A 路：真实 Electron 桌面运行时自检 */
function runRealElectron() {
  cleanDir(TMP_DATA_WINDOW);
  console.log('[桌面测试] 启动真实桌面运行时（Electron 窗口）…');
  console.log(`[隔离] 测试数据目录：${TMP_DATA_WINDOW}（真实 data/ 全程不被读写）`);
  const child = spawn(findElectron(), ['.'], {
    cwd: ROOT,
    env: { ...process.env, BEE_TEST: '1', BEE_DATA_DIR: TMP_DATA_WINDOW },
    stdio: ['ignore', 'pipe', 'pipe'], shell: true,
  });
  let out = ''; let done = false;
  const finish = () => {
    if (done) return; done = true;
    cleanDir(TMP_DATA_WINDOW);
    console.log('[隔离] 已清理测试数据目录，你的真实 data/ 未被改动。');
    if (/\[DESKTOP TEST\] PASS/.test(out)) { console.log('\n==== 桌面软件测试（真实 Electron 窗口运行时）：全部通过 ===='); process.exit(0); }
    else if (/\[DESKTOP TEST\] FAIL/.test(out)) { console.log('\n==== 桌面软件测试：存在失败 ===='); process.exit(1); }
    else { console.log('\n==== 桌面软件测试：未读到结果 ===='); console.log(out.slice(-1500)); process.exit(1); }
  };
  child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d); });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('exit', () => finish());
  setTimeout(() => {
    if (!done) { console.log('\n[桌面测试] 超时（300s），终止'); try { child.kill('SIGKILL'); } catch (e) {} finish(); }
  }, 300000);
}

/** B 路：本环境无法开窗口，用桌面应用同一套后端代码以 Node 跑功能自检 */
function runNodeFallback(reason) {
  console.log('[桌面测试] 本环境 Electron 无法初始化窗口（' + reason + '），');
  console.log('[桌面测试] 改用【桌面应用同一套后端代码】（src/server.js + src/*）以 Node 跑功能自检。');
  console.log('[桌面测试] 这正是将来 .exe 运行的后端逻辑；真实桌面窗口在你本机 Windows 上用 `npm start` 验证。');
  console.log('');
  const child = spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, 'run_all.js')], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  child.on('exit', (code) => {
    console.log('');
    if (code === 0) { console.log('==== 桌面软件功能自检（后端同一套代码）：全部通过 ===='); process.exit(0); }
    else { console.log('==== 桌面软件功能自检：存在失败（exit ' + code + '）===='); process.exit(1); }
  });
}

const usable = electronUsable();
console.log('[桌面测试] Electron 窗口能力探测：' + (usable ? '可用（真实桌面运行时）' : '本环境不可用'));
if (usable) runRealElectron();
else runNodeFallback('Electron 内置模块在本沙箱未注册');
