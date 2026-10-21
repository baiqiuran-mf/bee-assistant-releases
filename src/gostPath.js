'use strict';
/**
 * gost.exe 路径解析（v2.6.1120）
 * =====================================================================
 * gost（https://github.com/go-gost/gost）是我们用来做「本地无密码中转」的独立小工具。
 *
 * 为什么需要它：
 *   Chromium / Electron 内核**从根上不支持**代理的用户名/密码认证（SOCKS5 认证 Chromium
 *   bug 40829748 直接不支持；连 `session.setProxy({proxyRules})` 的 proxyRules 语法也压根
 *   不认 `user:pass@`，账密会被静默丢掉）。所以只要代理要账密，浏览器就必然连不上。
 *   解法：在本机开一个**无密码**的中转端口，账密只交给 gost 去连上游，浏览器只看到
 *   127.0.0.1:port —— 账密永远不经 Chromium 的手。
 *
 * 路径：
 *   - 打包后：<resources>/app.asar.unpacked/bin/gost/gost.exe（asarUnpack 解出来的，可被 spawn）
 *   - 开发态：项目根 bin/gost/gost.exe
 *
 * 单独成模块，便于单测（纯逻辑、不依赖 Electron），写法与 src/settop.js 保持一致。
 */
const fs = require('fs');
const path = require('path');

function resolveGostPath() {
  const cands = [];
  if (process.resourcesPath) {
    cands.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'gost', 'gost.exe'));
  }
  cands.push(path.join(__dirname, '..', 'bin', 'gost', 'gost.exe')); // 开发态：src/.. = 项目根
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0]; // 回退第一个，让报错信息能指出缺哪个
}

module.exports = { resolveGostPath };
