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
assert.equal(R.qrUrl(c), 'https://pocham4173.github.io/hidamari/#reconnect=' + c, 'QRにはアドレスとコードだけ。コードは # のあと(サーバーに送られない)');
assert.equal(R.parse(R.qrUrl(c)), c);
assert.equal(R.parse('https://pocham4173.github.io/hidamari/?reconnect=' + c), c, '前の形(?reconnect=)も読める');
assert.equal(R.parse('https://evil.example/hidamari/#reconnect=' + c), null);
assert.equal(R.parse(c.toLowerCase()), c);
assert.equal(R.parse('https://evil.example/hidamari/?reconnect=' + c), null, 'ほかのサイトは受け付けない');
assert.equal(R.parse('https://pocham4173.github.io/hidamari/?invite=ABCD2345'), null, '招待QRは再接続QRではない');
assert.equal(R.parse('ABCD2345'), null);
// 2b. 保存する番号は SHA-256("reconnect\n"+コード)(送信役と同じ。コードそのものは保存しない)
{
  const { createHash } = await import('node:crypto');
  assert.equal(await R.docId(c, webcrypto.subtle), createHash('sha256').update('reconnect\n' + c).digest('hex'));
}
// 2c. iPhone・iPad で、ホーム画面のまいにこ(アプリとして開いた画面)でなければ true
{
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  assert.equal(R.needsHomeApp({ userAgent: iphone, standalone: false }), true, '標準カメラ→Safari');
  assert.equal(R.needsHomeApp({ userAgent: iphone }), true);
  assert.equal(R.needsHomeApp({ userAgent: iphone, standalone: true }), false, 'ホーム画面のまいにこ');
  assert.equal(R.needsHomeApp({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }), true, 'iPad');
  assert.equal(R.needsHomeApp({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/128 Mobile', standalone: undefined }), false, 'Androidは同じ保存場所');
}
// 2d. 再接続で入ってから24時間は止める(firestore.rules と同じ判定)
{
  const t0 = Date.UTC(2026, 9, 6, 3, 0) / 1000;
  const at = (h) => new Date((t0 + h * 3600) * 1000);
  assert.ok(R.lockedUntil({ via: 'reconnect', auth_time: t0 }, at(1)) instanceof Date);
  assert.equal(R.lockedUntil({ via: 'reconnect', auth_time: t0 }, at(1)).getTime(), (t0 + 24 * 3600) * 1000);
  assert.equal(R.lockedUntil({ via: 'reconnect', auth_time: t0 }, at(24.01)), null, '24時間を過ぎたら使える');
  assert.equal(R.lockedUntil({ auth_time: t0 }, at(1)), null, '印のない鍵(LINEでログインなど)は今まで通り');
  assert.match(R.lockMessage(at(24)), /^新しいスマホをつないでから24時間は、この操作はできません（安全のため）。\d+月\d+日 \d+時\d\d分以降にお試しください。$/);
}
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
  for (const code of ['used', 'expired', 'not-allowed', 'device-in-use', 'app-check', 'network', 'open-home-app']) assert.ok(R.message({ code }).length > 10, code);
  assert.match(R.message({ code: 'open-home-app' }), /ホーム画面のまいにこ/);
}
// 3b. 画面の reconnectFinish: iPhone でホーム画面のまいにこでなければ、送信役に送らない(コードを使わない)
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const src = html.slice(html.indexOf('async function reconnectFinish(code){'), html.indexOf('/* 家族の設定: ご本人の新しいスマホをつなぐ'));
  const run = async (nav) => {
    const sent = [], state = { textContent: '' };
    const make = new Function('MainicoReconnect', 'navigator', 'reconnectStateEl', 'reconnectService', 'auth', 'db', 'gid', 'alert', 'location',
      'let reconnectBusy=false;\n' + src + '\nreturn reconnectFinish;');
    const fin = make(R, nav, () => state, () => ({ exchange: async (x) => { sent.push(x); return { customToken: 't', uid: 'hon' }; } }),
      { currentUser: null, signInWithCustomToken: async () => {} }, {}, () => '', () => {}, { reload: () => {} });
    await fin(c);
    return { sent, state: state.textContent };
  };
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
  const safari = await run({ userAgent: iphone, standalone: false });
  assert.equal(safari.sent.length, 0, 'Safari(標準カメラ)では送信役に送らない');
  assert.match(safari.state, /ホーム画面のまいにこを開いて/);
  const home = await run({ userAgent: iphone, standalone: true });
  assert.deepEqual(home.sent, [c], 'ホーム画面のまいにこでは送る');
  assert.match(html, /if\(MainicoReconnect\.needsHomeApp\(navigator\)\)\{const s=reconnectStateEl\(\);if\(s\)s\.textContent=MainicoReconnect\.message\(\{code:'open-home-app'\}\);return;\}/, 'QRで開いたときも自動では進めない');
}
// 4. 画面へのつなぎ込み
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="entry-reconnect" type="button" hidden onclick="reconnectScan\(\)">ご本人：前のスマホの記録に戻る/);
  assert.match(html, /id="welcome-reconnect" hidden onclick="reconnectScan\(\)"/);
  assert.match(html, /id="reconnect-make" hidden onclick="openReconnectMaker\(\)">ご本人の新しいスマホをつなぐ/);
  assert.match(html, /<script src="reconnect\.js\?v=\d+"><\/script>/);
  assert.match(html, /if\(inUse\)throw Object\.assign\(new Error\('device-in-use'\)/, '記録のある画面は切り替えない');
  assert.match(html, /u\.searchParams\.delete\('reconnect'\);\n    history\.replaceState\(null,'',u\.pathname\+\(u\.search\|\|''\)\+\(inHash\?'':u\.hash\)\);/, 'アドレスのコード(#・?)は読んだらすぐ消す');
  assert.match(html, /docId=await MainicoReconnect\.docId\(code,window\.crypto\.subtle\);\n      await db\.collection\('reconnectCodes'\)\.doc\(docId\)\.set/, 'コードそのものは保存しない');
  assert.match(html, /家族全員とご本人の画面に記録されます/);
  // 24時間の止める操作: 家庭の削除・家族の承認と解除・管理者の交代・ひと声の了解・アカウントの終了・再接続QRを作る
  for (const re of [/async function approveMember\(mid\)\{\n  if\(!requireHouseholdOwner\(\)\)return;\n  if\(await reconnectLocked\(\)\)return;/,
    /async function removeMember\(mid, isMe\)\{\n  mid=memberRef\(mid\);\n  isMe=mid===uid\(\);\n  if\(!isMe&&await reconnectLocked\(\)\)return;/,
    /async function honninRemove\(mid, isMe\)\{\n  mid=memberRef\(mid\);\n  isMe=mid===uid\(\);\n  if\(!isMe&&await reconnectLocked\(\)\)return;/,
    /ask:async\(text,ok\)=>\{if\(await reconnectLocked\(\)\)return false;/,
    /if\(await reconnectLockUntil\(\)\)return null;/,
    /async function openReconnectMaker\(\)\{\n  if\(await reconnectLocked\(\)\)return;/]) assert.match(html, re);
  const hu = fs.readFileSync(new URL('../household-ui.js', import.meta.url), 'utf8');
  assert.match(hu, /if\(!deletionResumeOnly && !householdDeleting && typeof reconnectLocked==='function' && await reconnectLocked\(\)\)return;/);
  assert.match(hu, /async function openAccountDeletion\(\)\{\n  if\(deletionBusy \|\| recoveryBusy \|\| accountClosureBusy\)return;\n  if\(typeof reconnectLocked==='function' && await reconnectLocked\(\)\)return;/);
  assert.match(html, /ご本人のスマホ以外に見せないでください/);
  const cfg = fs.readFileSync(new URL('../mainico-config.js', import.meta.url), 'utf8');
  assert.match(cfg, /window\.MAINICO_RECONNECT_URL = window\.MAINICO_RECONNECT_URL \|\| '';/, '本番では、まだ出さない');
  assert.match(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), /'reconnect\.js'/);
}
console.log('再接続QR(画面): コード・QRの中身(#)・読み取り・保存の番号・iPhoneのSafariでは使わない・24時間の判定・送信役との通信・つなぎ込み passed');
