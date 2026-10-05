/* 再接続QR(reconnect.js・2026-10-05)の画面側の検査 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
await import('../reconnect.js');
const R = globalThis.MainicoReconnect;

// 1. コード: 16文字・使わない文字(0/1/I/O)なし・毎回ちがう
const codes = new Set();
for (let i = 0; i < 200; i++) { const c = R.newCode(webcrypto); assert.match(c, /^[A-HJ-NP-Z2-9]{16}$/); codes.add(c); }
assert.equal(codes.size, 200);
// 2. QRの中身と読み取り
const c = R.newCode(webcrypto);
assert.equal(R.qrUrl(c), 'https://pocham4173.github.io/hidamari/?reconnect=' + c, 'QRにはアドレスとコードだけ');
assert.equal(R.parse(R.qrUrl(c)), c);
assert.equal(R.parse(c.toLowerCase()), c);
assert.equal(R.parse('https://evil.example/hidamari/?reconnect=' + c), null, 'ほかのサイトは受け付けない');
assert.equal(R.parse('https://pocham4173.github.io/hidamari/?invite=ABCD2345'), null, '招待QRは再接続QRではない');
assert.equal(R.parse('ABCD2345'), null);
// 3. 送信役との通信
{
  const calls = [];
  const mk = (reply, status = 200) => R.client({ baseUrl: 'https://w.example/', getAppCheckToken: async () => 'ac',
    fetch: async (u, o) => { calls.push([u, o]); return { ok: status < 400, status, json: async () => reply }; } });
  assert.equal(R.client({ baseUrl: '' }).enabled(), false, '場所が空なら出さない');
  const ok = await mk({ customToken: 'tok', uid: 'hon' }).exchange(c);
  assert.deepEqual(ok, { customToken: 'tok', uid: 'hon' });
  assert.equal(calls[0][0], 'https://w.example/auth/reconnect');
  assert.equal(calls[0][1].headers['x-firebase-appcheck'], 'ac');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0][1].body), { code: c });
  await assert.rejects(mk({ error: 'used' }, 410).exchange(c), (e) => e.code === 'used');
  await assert.rejects(mk({}).exchange(c), (e) => e.code === 'server', '応答がおかしければ入らない');
  await assert.rejects(mk({}).exchange('bad'), (e) => e.code === 'bad-request');
  const offline = R.client({ baseUrl: 'https://w.example', getAppCheckToken: async () => '', fetch: async () => { throw new Error('x'); } });
  await assert.rejects(offline.exchange(c), (e) => e.code === 'network');
  for (const code of ['used', 'expired', 'not-allowed', 'device-in-use', 'app-check', 'network']) assert.ok(R.message({ code }).length > 10, code);
}
// 4. 画面へのつなぎ込み
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="entry-reconnect" type="button" hidden onclick="reconnectScan\(\)">ご本人：前のスマホの記録に戻る/);
  assert.match(html, /id="welcome-reconnect" hidden onclick="reconnectScan\(\)"/);
  assert.match(html, /id="reconnect-make" hidden onclick="openReconnectMaker\(\)">ご本人の新しいスマホをつなぐ/);
  assert.match(html, /<script src="reconnect\.js\?v=\d+"><\/script>/);
  assert.match(html, /if\(inUse\)throw Object\.assign\(new Error\('device-in-use'\)/, '記録のある画面は切り替えない');
  assert.match(html, /u\.searchParams\.delete\('reconnect'\)/, 'アドレスのコードは読んだらすぐ消す');
  assert.match(html, /ご本人のスマホ以外に見せないでください/);
  const cfg = fs.readFileSync(new URL('../mainico-config.js', import.meta.url), 'utf8');
  assert.match(cfg, /window\.MAINICO_RECONNECT_URL = window\.MAINICO_RECONNECT_URL \|\| '';/, '本番では、まだ出さない');
  assert.match(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), /'reconnect\.js'/);
}
console.log('再接続QR(画面): コード・QRの中身・読み取り・送信役との通信・つなぎ込み passed');
