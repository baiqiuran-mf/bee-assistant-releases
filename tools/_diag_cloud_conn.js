/* 只读诊断：探测云端后台 wa-cloud-api.weilisi0813.workers.dev 的连通性。
 * 多次尝试，看是不是「时好时坏」（间歇抽风）。不改任何东西。 */
const dns = require('dns').promises;
const https = require('https');

const HOST = 'wa-cloud-api.weilisi0813.workers.dev';
const URL = 'https://' + HOST + '/';
const PIN_IP = '172.67.176.147';
const N = 4;

function fetchGet(url, opts) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.get(url, Object.assign({ timeout: 7000 }, opts || {}), (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0, len: body.length }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(e));
  });
}

(async () => {
  console.log('=== DNS 解析 ' + HOST + ' (' + N + ' 次) ===');
  for (let i = 0; i < N; i++) {
    try {
      const r = await dns.lookup(HOST, { all: true });
      console.log('  ' + (i + 1) + ': ' + JSON.stringify(r.map((x) => x.address)));
    } catch (e) { console.log('  ' + (i + 1) + ': 解析失败 ' + (e.code || e.message)); }
  }

  console.log('=== 直连域名 GET / (' + N + ' 次) ===');
  for (let i = 0; i < N; i++) {
    try { const r = await fetchGet(URL); console.log('  ' + (i + 1) + ': ' + r.status + ' ' + r.ms + 'ms len=' + r.len); }
    catch (e) { console.log('  ' + (i + 1) + ': 失败 ' + (e.code || e.message)); }
  }

  console.log('=== 固定 IP + SNI GET / (' + N + ' 次) ===');
  for (let i = 0; i < N; i++) {
    try { const r = await fetchGet(URL, { host: PIN_IP, servername: HOST }); console.log('  ' + (i + 1) + ': ' + r.status + ' ' + r.ms + 'ms len=' + r.len); }
    catch (e) { console.log('  ' + (i + 1) + ': 失败 ' + (e.code || e.message)); }
  }
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
