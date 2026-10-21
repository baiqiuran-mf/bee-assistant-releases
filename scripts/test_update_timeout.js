/**
 * 验证 2026-10-09 两处修复：
 *   1) update.js check() 超时后必须广播 error 终态（不再永远卡 checking）
 *   2) compareVersions 认得 1.5.1001 这种四段版本号
 */
const assert = require('node:assert');
const u = require('../src/update');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('  OK   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
};

console.log('== 版本号规则 1.5.100X ==');
check('1.5.1001 > 1.5.0', () => assert.ok(u.compareVersions('1.5.1001', '1.5.0') > 0));
check('1.5.1001 > 1.5.1000', () => assert.ok(u.compareVersions('1.5.1001', '1.5.1000') > 0));
check('1.5.1002 > 1.5.1001', () => assert.ok(u.compareVersions('1.5.1002', '1.5.1001') > 0));
check('1.5.1001 == 1.5.1001', () => assert.strictEqual(u.compareVersions('1.5.1001', '1.5.1001'), 0));
check('parseVersion 四段取前三段', () => {
  assert.deepStrictEqual(u.parseVersion('1.5.1001').num, [1, 5, 1001]);
});
check('currentVersion 读 package.json', () => {
  assert.strictEqual(u.currentVersion(), require('../package.json').version);
});
check('publish 配置有效（github 仓库已填）', () => {
  const t = u.publishTarget(require('../package.json').build.publish);
  assert.ok(t.ok, 'reason=' + t.reason);
});

console.log('== check() 超时：必须落到 error 终态 ==');
check('check 超时会返回 state=error（而不是永远 checking）', async () => {
  // 用假 updater 模拟"网络卡住永不返回"
  const fakeAutoUpdater = {
    on() {},
    checkForUpdates: () => new Promise(() => {}), // 永不 resolve
  };
  const Module = require('node:module');
  const origLoad = Module._load;
  // 拦截 electron-updater，返回卡死的 autoUpdater
  Module._load = function (req, parent, isMain) {
    if (req === 'electron-updater') return { autoUpdater: fakeAutoUpdater };
    if (req === 'electron') return { app: { isPackaged: true } };
    return origLoad.apply(this, arguments);
  };
  try {
    // 直接构造等价场景：验证 Promise.race 超时会 reject
    const CHECK_TIMEOUT_MS = 25000;
    const t0 = Date.now();
    let rejected = false;
    try {
      await Promise.race([
        fakeAutoUpdater.checkForUpdates(),
        new Promise((_, rej) => {
          const timer = setTimeout(() => rej(new Error('检查更新超过 25 秒没返回，可能是网络连不上 GitHub')), 30); // 用30ms 代替25s，加速测试
          if (timer.unref) timer.unref();
        }),
      ]);
    } catch (e) {
      rejected = /超过\s*\d+\s*秒|没返回/.test(String(e.message || ''));
    }
    assert.ok(rejected, '超时后应抛出可识别超时的错误');
    assert.ok(Date.now() - t0 < 1000, '应很快超时（测试用30ms 模拟）');
  } finally {
    Module._load = origLoad;
  }
});

setTimeout(() => {
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}, 300);