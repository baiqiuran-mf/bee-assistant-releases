/*
 * Windows DPAPI 解密（纯 Node，只读）
 * =====================================================================
 * 用途：从 Signal 的 Local State 里取出 safeStorage masterKey（32 字节），
 *      用来解 config.json 里的 SQLCipher key。
 *
 * ---- 为什么绕了这么大一圈（四条路都实测过）----
 *
 * ① Electron 的 safeStorage —— ❌ 解不了 Signal 的 blob
 *    Electron 44 实测：完整 283 字节 / 剥 5 字节 / 剥 8 字节 / base64 字符串，
 *    四种全试过，一律报 "Ciphertext does not appear to be encrypted"。
 *    根因：safeStorage 用的是 Chromium 的 v10/v11 格式（ASCII 'v10' 开头），
 *    而 Signal 存的是**裸 DPAPI blob**（'DPAPI\x01' 开头，283 字节）。
 *    对照实验证明 safeStorage 本身没坏：encryptString→decryptString 往返成功。
 *
 * ② Python ctypes（探针那版）—— ❌ 不能进产品
 *    怕沙箱 EBUSY，更怕用户机器没装 Python。软件是给不装开发环境的同事用的。
 *
 * ③ PowerShell + .NET ProtectedData —— ❌ 类型找不到
 *    Add-Type -AssemblyName System.Security 之后
 *    [System.Security.Cryptography.ProtectedData] 仍报「找不到类型」。
 *
 * ④ PowerShell -Command 里塞内联 C# —— ❌ 引号被吃
 *    `@"…"@` 这种 here-string 套在 -Command 参数里，Windows 参数解析会吃掉引号，
 *    编译失败 → 命令整体失败。本机实测就是这一种。
 *
 * ⑤ ✅ **PowerShell -File 跑脚本文件 + 内联 C#**（本文件采用）
 *    先把脚本写到临时 .ps1，再用 `-File` 执行，绕开命令行引号地狱。
 *    实测拿到 32 字节，hex = dd256b91…5d7e9，**与 Python ctypes 版逐字节相同**。
 *    只依赖 PowerShell（Windows 自带），不依赖 Python、不依赖 ffi、不编译原生模块。
 *
 * ---- 性能 ----
 * 每次起一个 PowerShell + 内联 C# 编译约 **1.8 秒**（实测）。
 *   → 所以 masterKey **长缓存**：用户不换 Windows 账号、不重装 Signal 的情况下
 *     这把 key 永远不变，算一次就够。之后所有检测都是 0~3ms。
 *
 * ---- 安全 ----
 * 🔴 DPAPI 只解密不加密，**Signal 的文件一个字都不改**。
 * 🔴 masterKey 只存在内存里，**不落盘**（探针阶段写的 master_key.hex 已删）。
 * 🔴 不往 PowerShell 传密钥，只传**待解的密文**（走环境变量，不进命令行，
 *    免得被任务管理器 / Get-Process 之类的命令行查看器看到）。
 * 🔴 临时 .ps1 用完立刻删（写在 os.tmpdir，不写进项目）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');

/**
 * execFile 的 Promise 版（v2.5.1034 卡顿治理）
 * 🔴 只 resolve、**永不 reject**：出错统一返回 null，调用方判 null 即可。
 *    这样「PowerShell 被沙箱吞掉 / 超时 / 没装」这类情况不会把上层异步链打断。
 * @returns {Promise<string|null>} stdout；null = 失败
 */
function execFileP(file, args, opts) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, opts, (err, stdout) => {
        if (err) resolve(null);
        else resolve(String(stdout || ''));
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * 临时 ps1 的内容。
 * 🔴 用 base64 承载脚本体，避开所有引号 / 反引号 / `$` 的转义问题：
 *    PowerShell 侧 `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(...))`
 *    再 `Invoke-Expression`，等于把脚本原文喂进去，一个字符都不会被shell 改写。
 */
function buildScript() {
  const csharp = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public class BeeDpapi {
    [StructLayout(LayoutKind.Sequential)]
    struct DATA_BLOB { public int cbData; public IntPtr pbData; }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptUnprotectData(
        ref DATA_BLOB pIn, IntPtr szDataDescr, IntPtr pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptProtectData(
        ref DATA_BLOB pIn, IntPtr szDataDescr, IntPtr pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pOut);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr LocalFree(IntPtr hMem);

    public static byte[] Unprotect(byte[] data) {
        IntPtr tmp = Marshal.AllocHGlobal(data.Length);
        Marshal.Copy(data, 0, tmp, data.Length);
        DATA_BLOB inBlob = new DATA_BLOB { cbData = data.Length, pbData = tmp };
        DATA_BLOB outBlob = new DATA_BLOB();
        try {
            if (!CryptUnprotectData(ref inBlob, IntPtr.Zero, IntPtr.Zero,
                                    IntPtr.Zero, IntPtr.Zero, 1, ref outBlob)) {
                int err = Marshal.GetLastWin32Error();
                throw new Win32Exception(err, "CryptUnprotectData failed, win32=" + err);
            }
            byte[] result = new byte[outBlob.cbData];
            Marshal.Copy(outBlob.pbData, result, 0, outBlob.cbData);
            return result;
        } finally {
            if (outBlob.pbData != IntPtr.Zero) LocalFree(outBlob.pbData);
            if (tmp != IntPtr.Zero) Marshal.FreeHGlobal(tmp);
        }
    }

    public static byte[] Protect(byte[] data) {
        IntPtr tmp = Marshal.AllocHGlobal(data.Length);
        Marshal.Copy(data, 0, tmp, data.Length);
        DATA_BLOB inBlob = new DATA_BLOB { cbData = data.Length, pbData = tmp };
        DATA_BLOB outBlob = new DATA_BLOB();
        try {
            if (!CryptProtectData(ref inBlob, IntPtr.Zero, IntPtr.Zero,
                                    IntPtr.Zero, IntPtr.Zero, 1, ref outBlob)) {
                int err = Marshal.GetLastWin32Error();
                throw new Win32Exception(err, "CryptProtectData failed, win32=" + err);
            }
            byte[] result = new byte[outBlob.cbData];
            Marshal.Copy(outBlob.pbData, result, 0, outBlob.cbData);
            return result;
        } finally {
            if (outBlob.pbData != IntPtr.Zero) LocalFree(outBlob.pbData);
            if (tmp != IntPtr.Zero) Marshal.FreeHGlobal(tmp);
        }
    }
}
`;

  const body = `
$ErrorActionPreference = 'Stop'
if (-not ("BeeDpapi" -as [type])) {
  Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BEE_CSHARP_B64)))
}
$b = [Convert]::FromBase64String($env:BEE_DPAPI_B64)
$u = New-Object byte[] $b.Length
[Array]::Copy($b, $u, $b.Length)
$m = [BeeDpapi]::Unprotect($u)
if (-not $m -or $m.Length -eq 0) { exit 2 }
[Console]::Out.Write([Convert]::ToBase64String($m))
`;
  return {
    body,
    csharpB64: Buffer.from(csharp, 'utf8').toString('base64'),
  };
}

/** PowerShell 在这台机器上到底能不能用（只查一次） */
let _psOk = null;
function powershellWorks() {
  if (_psOk !== null) return _psOk;
  if (process.platform !== 'win32') { _psOk = false; return false; }
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "'OK'"], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    _psOk = true;
  } catch (e) {
    _psOk = false;
  }
  return _psOk;
}

/** 异步版：不阻塞主线程（v2.5.1034 卡顿治理）。结果和 powershellWorks() 共用一份结论。 */
let _psOkP = null;
async function powershellWorksAsync() {
  if (_psOkP !== null) return _psOkP;
  if (process.platform !== 'win32') { _psOkP = false; return false; }
  const out = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "'OK'"],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 1 << 20 },
  );
  _psOkP = out !== null;
  if (_psOkP) _psOk = true;   // 同步版也顺带确认，省一次探测
  return _psOkP;
}

/**
 * 剥掉给 DPAPI blob 加的 "DPAPI\x01" 5 字节头。
 * Signal 的 Local State 里这串解码后是 283 字节，头 8 字节 = 44 50 41 50 49 01 00 00。
 */
function stripDpapiHeader(blob) {
  return blob.subarray(0, 5).toString() === 'DPAPI' ? blob.subarray(5) : blob;
}

/** 把 ps1 写到临时目录，返回路径（调用方负责删） */
function writeTempScript(body) {
  const dir = path.join(os.tmpdir(), 'bee-dpapi');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `u-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.ps1`);
  // 🔴 写成 UTF-8 **无 BOM**。有 BOM 的话老版本 powershell 会把第一行当乱码。
  fs.writeFileSync(p, body, { encoding: 'utf8' });
  return p;
}

/**
 * 解一段 DPAPI 密文。
 * @param {Buffer} blob 完整 blob（含 DPAPI\x01 头）
 * @returns {Buffer} 解密后的字节
 */
function dpapiUnprotect(blob) {
  const payload = stripDpapiHeader(blob);
  const { body, csharpB64 } = buildScript();
  const ps1 = writeTempScript(body);

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
        // 只传密文和 C# 源码，不传任何密钥
        env: Object.assign({}, process.env, {
          BEE_DPAPI_B64: payload.toString('base64'),
          BEE_CSHARP_B64: csharpB64,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1 << 20,
      }
    );
    const buf = Buffer.from(String(out).trim(), 'base64');
    if (!buf.length) throw new Error('DPAPI_EMPTY');
    return buf;
  } catch (e) {
    // 把 stderr 尾巴带上，不然只有一个"Command failed"根本没法查
    const errTail = e.stderr ? String(e.stderr).trim().split('\n').slice(-4).join(' | ') : '';
    const err = new Error('DPAPI_FAILED' + (errTail ? ': ' + errTail : ''));
    err.cause = e;
    throw err;
  } finally {
    // 🔴 临时脚本必删，哪怕执行失败
    try { fs.unlinkSync(ps1); } catch (e) { /* 删不掉不影响功能 */ }
  }
}

/**
 * 异步版 DPAPI 解密（v2.5.1034 卡顿治理）
 * 🔴 与同步版唯一区别：起 PowerShell 用 execFile（子线程等），**不占住 Node 主线程**。
 *    1.8 秒的内联 C# 编译期间，界面和所有接口照常响应 —— 这是消除「启动/登录卡顿」的关键一步。
 * @param {Buffer} blob 完整 blob（含 DPAPI\x01 头）
 * @returns {Promise<Buffer>} 解密后的字节
 */
async function dpapiUnprotectAsync(blob) {
  const payload = stripDpapiHeader(blob);
  const { body, csharpB64 } = buildScript();
  const ps1 = writeTempScript(body);

  try {
    const out = await execFileP(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
        env: Object.assign({}, process.env, {
          BEE_DPAPI_B64: payload.toString('base64'),
          BEE_CSHARP_B64: csharpB64,
        }),
        maxBuffer: 1 << 20,
      },
    );
    if (out === null) throw new Error('DPAPI_FAILED: PowerShell 没返回内容');
    const buf = Buffer.from(String(out).trim(), 'base64');
    if (!buf.length) throw new Error('DPAPI_EMPTY');
    return buf;
  } catch (e) {
    const m = String((e && e.message) || e);
    if (m.startsWith('DPAPI_')) throw e;
    throw new Error('DPAPI_FAILED: ' + m);
  } finally {
    try { fs.unlinkSync(ps1); } catch (e) { /* 删不掉不影响功能 */ }
  }
}

/* ---- masterKey 长缓存 ----
 * 🔴 按 Local State 路径 keyed：Signal 多开时每个实例有自己独立的 Local State 文件，
 *    绝不能用「上一次解出来的 key」去开另一个实例的库（会 SQLITE_NOTADB）。
 *    （同 Windows 用户下这些 key 其实相同，但按路径缓存既正确又零风险。） */
const _masterCache = new Map();

/**
 * 从 Signal 的 Local State 取 32 字节 masterKey。
 * @param {string} localStatePath Local State 完整路径
 * @returns {Buffer} 32 字节 masterKey
 */
function getMasterKey(localStatePath) {
  if (_masterCache.has(localStatePath)) return _masterCache.get(localStatePath);

  if (process.platform !== 'win32') throw new Error('NOT_WINDOWS');
  if (!powershellWorks()) throw new Error('NO_POWERSHELL');
  if (!fs.existsSync(localStatePath)) throw new Error('NO_LOCAL_STATE');

  const ls = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const b64 = ls?.os_crypt?.encrypted_key;
  if (!b64) throw new Error('NO_ENCRYPTED_KEY');

  const master = dpapiUnprotect(Buffer.from(b64, 'base64'));
  if (master.length !== 32) throw new Error('BAD_MASTER_KEY');

  _masterCache.set(localStatePath, master);
  return master;
}

/**
 * 异步版取 masterKey（v2.5.1034 卡顿治理）
 * 🔴 与 getMasterKey 共用同一个 _masterCache：谁先算出来谁写，另一个直接命中，
 *    绝不重复起 PowerShell。异步版是 /api/state 与后台刷新的唯一入口。
 */
const _masterInflight = new Map();

async function getMasterKeyAsync(localStatePath) {
  if (_masterCache.has(localStatePath)) return _masterCache.get(localStatePath);
  // 同一个 Local State 正在解 → 复用同一个 Promise，不重复起进程
  const inflight = _masterInflight.get(localStatePath);
  if (inflight) return inflight;

  const task = (async () => {
    if (process.platform !== 'win32') throw new Error('NOT_WINDOWS');
    if (!(await powershellWorksAsync())) throw new Error('NO_POWERSHELL');
    if (!fs.existsSync(localStatePath)) throw new Error('NO_LOCAL_STATE');

    const ls = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    const b64 = ls?.os_crypt?.encrypted_key;
    if (!b64) throw new Error('NO_ENCRYPTED_KEY');

    const master = await dpapiUnprotectAsync(Buffer.from(b64, 'base64'));
    if (master.length !== 32) throw new Error('BAD_MASTER_KEY');

    _masterCache.set(localStatePath, master);
    return master;
  })();

  _masterInflight.set(localStatePath, task);
  try {
    return await task;
  } finally {
    _masterInflight.delete(localStatePath);
  }
}

function _clearCache() {
  _masterCache.clear();
  _masterInflight.clear();
  _psOk = null;
  _psOkP = null;
}

/* ============================================================
 * 加密孪生（v2.6.115x · 集中托管 API key 的本地「双保险」落盘）
 * 和上面的 Unprotect 调同一份 C# 类，只是 PowerShell 这侧改调 Protect。
 * 这一组函数只给密钥库用，绝不碰 Signal 的文件。
 * ============================================================ */

/** PowerShell 脚本：把待加密的明文调 BeeDpapi::Protect，输出 base64。 */
function buildProtectScript() {
  const body = `
$ErrorActionPreference = 'Stop'
if (-not ("BeeDpapi" -as [type])) {
  Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BEE_CSHARP_B64)))
}
$b = [Convert]::FromBase64String($env:BEE_DPAPI_B64)
$u = New-Object byte[] $b.Length
[Array]::Copy($b, $u, $b.Length)
$m = [BeeDpapi]::Protect($u)
if (-not $m -or $m.Length -eq 0) { exit 2 }
[Console]::Out.Write([Convert]::ToBase64String($m))
`;
  return { body, csharpB64: buildScript().csharpB64 };
}

/** 同步执行一段 DPAPI 脚本（复用现有 .ps1 临时文件 + 环境变量传密文机制）。 */
function runDpapiSync(body, payloadBuf) {
  const ps1 = writeTempScript(body);
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      {
        encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: Object.assign({}, process.env, {
          BEE_DPAPI_B64: payloadBuf.toString('base64'),
          BEE_CSHARP_B64: buildScript().csharpB64,
        }),
        stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 20,
      }
    );
    const buf = Buffer.from(String(out).trim(), 'base64');
    if (!buf.length) throw new Error('DPAPI_EMPTY');
    return buf;
  } catch (e) {
    const errTail = e.stderr ? String(e.stderr).trim().split('\n').slice(-4).join(' | ') : '';
    const err = new Error('DPAPI_FAILED' + (errTail ? ': ' + errTail : ''));
    err.cause = e;
    throw err;
  } finally {
    try { fs.unlinkSync(ps1); } catch (e) { /* 删不掉不影响功能 */ }
  }
}

/** 异步执行一段 DPAPI 脚本（不占 Node 主线程）。 */
async function runDpapiAsync(body, payloadBuf) {
  const ps1 = writeTempScript(body);
  try {
    const out = await execFileP(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      {
        encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: Object.assign({}, process.env, {
          BEE_DPAPI_B64: payloadBuf.toString('base64'),
          BEE_CSHARP_B64: buildScript().csharpB64,
        }),
        maxBuffer: 1 << 20,
      }
    );
    if (out === null) throw new Error('DPAPI_FAILED: PowerShell 没返回内容');
    const buf = Buffer.from(String(out).trim(), 'base64');
    if (!buf.length) throw new Error('DPAPI_EMPTY');
    return buf;
  } catch (e) {
    const m = String((e && e.message) || e);
    if (m.startsWith('DPAPI_')) throw e;
    throw new Error('DPAPI_FAILED: ' + m);
  } finally {
    try { fs.unlinkSync(ps1); } catch (e) { /* 删不掉不影响功能 */ }
  }
}

/** DPAPI 加密一段明文（返回密文 Buffer）。 */
function dpapiProtect(blob) {
  const { body } = buildProtectScript();
  return runDpapiSync(body, blob);
}

/** 异步版 DPAPI 加密。 */
async function dpapiProtectAsync(blob) {
  const { body } = buildProtectScript();
  return runDpapiAsync(body, blob);
}

/**
 * DPAPI 解密（不加 Signal 的 "DPAPI\x01" 头剥离）。
 * 密钥库自己产生的密文不带那个头，直接喂给 BeeDpapi::Unprotect 即可。
 */
function dpapiUnprotectRaw(blob) {
  const { body } = buildScript();
  return runDpapiSync(body, blob);
}

/** 异步版 DPAPI 解密（不带头）。 */
async function dpapiUnprotectRawAsync(blob) {
  const { body } = buildScript();
  return runDpapiAsync(body, blob);
}

module.exports = {
  dpapiUnprotect,
  dpapiUnprotectAsync,
  dpapiProtect,
  dpapiProtectAsync,
  dpapiUnprotectRaw,
  dpapiUnprotectRawAsync,
  getMasterKey,
  getMasterKeyAsync,
  stripDpapiHeader,
  powershellWorks,
  powershellWorksAsync,
  _clearCache,
};
