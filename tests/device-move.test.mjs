/* ブラウザーの引っ越し(device-move.js)の画面側の部品(2026-10-10) */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const M = createRequire(import.meta.url)('../device-move.js');
const LINE_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126 Mobile Safari/537.36 Line/14.10.0';
const LINE_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.10.0';
const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';
assert.equal(M.inAppBrowser(LINE_ANDROID), true);
assert.equal(M.inAppBrowser(LINE_IOS), true);
assert.equal(M.inAppBrowser(CHROME), false);
const code = 'a1'.repeat(16);
// Android: Chrome を直接開く(番号つき)。開けないときの行き先にも番号
const a = M.targetUrl('https://pocham4173.github.io/hidamari/index.html#x', code, LINE_ANDROID);
assert.ok(a.startsWith('intent://pocham4173.github.io/hidamari/index.html?openExternalBrowser=1&move=' + code + '#Intent;scheme=https;package=com.android.chrome;'));
assert.ok(a.includes(encodeURIComponent('https://pocham4173.github.io/hidamari/index.html?openExternalBrowser=1&move=' + code)));
// iPhone: LINE の「外のブラウザーで開く」
assert.equal(M.targetUrl('https://pocham4173.github.io/hidamari/', code, LINE_IOS), 'https://pocham4173.github.io/hidamari/?openExternalBrowser=1&move=' + code);
// 受け取り: 番号を取り出して、URLから消す
let replaced = '';
const hist = { replaceState: (s, t, u) => { replaced = u; } };
assert.equal(M.takeCode({ href: 'https://x.example/h/?openExternalBrowser=1&move=' + code + '#k' }, hist), code);
assert.equal(replaced, '/h/#k', '番号と外のブラウザーの印は消す');
replaced = '';
assert.equal(M.takeCode({ href: 'https://x.example/h/?move=bad' }, hist), '', '形の違う番号は使わない');
assert.equal(replaced, '/h/', '形が違っても消す');
replaced = 'none';
assert.equal(M.takeCode({ href: 'https://x.example/h/?invite=AB' }, hist), '');
assert.equal(replaced, 'none', '番号がなければURLは変えない');
// 送信役とのやりとり
const calls = [];
const fakeFetch = (resp) => async (u, o) => { calls.push({ u, o }); return { ok: resp.status === 200, json: async () => resp.body }; };
const user = { getIdToken: async () => 'IDT' };
assert.equal(await M.start({ base: 'https://w', auth: { currentUser: user }, fetch: fakeFetch({ status: 200, body: { code } }) }), code);
assert.equal(calls[0].u, 'https://w/auth/move/start');
assert.equal(calls[0].o.headers.authorization, 'Bearer IDT');
await assert.rejects(M.start({ base: '', auth: { currentUser: user }, fetch: fakeFetch({}) }), (e) => e.code === 'not-configured');
let signed = '';
await M.finish({ base: 'https://w', auth: { signInWithCustomToken: async (t) => { signed = t; } }, fetch: fakeFetch({ status: 200, body: { customToken: 'CT' } }) }, code);
assert.equal(signed, 'CT');
await assert.rejects(M.finish({ base: 'https://w', auth: {}, fetch: fakeFetch({ status: 410, body: { error: 'move-used' } }) }, code), (e) => e.code === 'move-used');
assert.match(M.message({ code: 'move-expired' }), /5分/);
console.log('ブラウザーの引っ越し(画面側): アプリの中の判定・Chrome/Safariを開くURL・番号の受け取りと消去・送信役とのやりとり passed');
