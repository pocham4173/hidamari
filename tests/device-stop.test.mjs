/* 「ほかのスマホを止める」(device-stop.js・2026-10-05)の検査。jsdom を使う */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

await import('../device-stop.js');
const D = globalThis.MainicoDeviceStop;

// 1. 入力の確かめ
assert.match(D.check('', 'abcdefghijkl', 'abcdefghijkl'), /今のパスワードを入れて/);
assert.match(D.check('now-password', 'short', 'short'), /12文字以上/, '復旧の設定と同じく12文字以上');
assert.match(D.check('now-password', 'x'.repeat(129), 'x'.repeat(129)), /128文字まで/);
assert.match(D.check('now-password', 'abcdefghijkl', 'abcdefghijkX'), /合っていません/);
assert.match(D.check('abcdefghijkl', 'abcdefghijkl', 'abcdefghijkl'), /今と違う/);
assert.equal(D.check('now-password', 'abcdefghijkl', 'abcdefghijkl'), '');

function user(over = {}) {
  const calls = [];
  return Object.assign({
    email: 'rie@example.com', providerData: [{ providerId: 'password' }], calls,
    reauthenticateWithCredential: async (c) => { calls.push(['reauth', c]); if (over.wrong) throw Object.assign(new Error('x'), { code: 'auth/invalid-credential' }); },
    updatePassword: async (p) => { calls.push(['update', p]); },
    getIdToken: async (force) => { calls.push(['token', force]); return 't'; },
  }, over.props || {});
}
async function run(u, values, done) {
  const dom = new JSDOM('<body></body>');
  const doc = dom.window.document;
  D.open({ document: doc, user: () => u, credential: (e, p) => ({ e, p }), onDone: done });
  const q = (s) => doc.querySelector(s);
  q('[data-ds="current"]').value = values[0]; q('[data-ds="next"]').value = values[1]; q('[data-ds="again"]').value = values[2];
  q('[data-ds-act="stop"]').dispatchEvent(new dom.window.Event('click'));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return { doc, state: q('[data-ds-state]').textContent, btn: q('[data-ds-act="stop"]') };
}

// 2. 本人確認(今のパスワード) → 新しいパスワードに変える → この端末の鍵を取り直す
{
  const u = user(); let done = 0;
  const r = await run(u, ['now-password', 'new-password-1', 'new-password-1'], () => done++);
  assert.deepEqual(u.calls, [['reauth', { e: 'rie@example.com', p: 'now-password' }], ['update', 'new-password-1'], ['token', true]]);
  assert.match(r.state, /止めました。ほかのスマホは、遅くとも1時間以内に使えなくなります/);
  assert.equal(done, 1);
  assert.equal(r.doc.querySelector('[data-ds="current"]').value, '', '入れたパスワードは画面から消す');
  assert.match(r.doc.querySelector('.device-stop').textContent, /記録は消えません/);
}
// 3. 今のパスワードが違う → 変えない・もう一度押せる
{
  const u = user({ wrong: true });
  const r = await run(u, ['wrong-pass', 'new-password-1', 'new-password-1']);
  assert.match(r.state, /今のパスワードが違います/);
  assert.ok(!u.calls.some((c) => c[0] === 'update'), 'パスワードは変えない');
  assert.equal(r.btn.disabled, false);
}
// 4. 入力が足りないときは、何もしないで案内だけ
{
  const u = user();
  const r = await run(u, ['now-password', 'short', 'short']);
  assert.match(r.state, /12文字以上/);
  assert.equal(u.calls.length, 0);
}
// 5. 復旧の設定(パスワード)がないアカウントでは使えない
{
  const u = user({ props: { providerData: [{ providerId: 'anonymous' }] } });
  const r = await run(u, ['now-password', 'new-password-1', 'new-password-1']);
  assert.match(r.state, /復旧の設定.*済んでいない/);
  assert.equal(u.calls.length, 0);
}
// 6. 画面へのつなぎ込み: 家族の設定とご本人の「その他の設定」の2か所。復旧の設定が済んだときだけ出す
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/data-device-stop hidden onclick="openDeviceStop\(\)">スマホをなくしたとき：ほかのスマホを止める/g) || []).length, 2);
  assert.match(html, /querySelectorAll\('\[data-device-stop\]'\)\.forEach\(el=>\{el\.hidden=level!=='ready';\}\)/);
  assert.match(html, /<script src="device-stop\.js\?v=\d+"><\/script>/);
  assert.match(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), /'device-stop\.js'/);
  assert.match(fs.readFileSync(new URL('../help.html', import.meta.url), 'utf8'), /ほかのスマホを止める/);
}
// 7. 後始末(LINEでログインの解除)は、本人確認のあと・パスワードを変える前。失敗しても止めることは続ける。
//    1回目がだめ('retry')なら、変えたあとに新しいパスワードで確かめ直してから、もう1回(afterChange)
{
  const runWith = async (before, opts = {}) => {
    const u = user(opts.user);
    const dom = new JSDOM('<body></body>');
    const doc = dom.window.document;
    const after = [];
    D.open({ document: doc, user: () => u, credential: (e, p) => ({ e, p }),
      beforeChange: async () => { u.calls.push(['before']); return before(); },
      afterChange: async (ok) => { u.calls.push(['after', ok]); after.push(ok); } });
    const q = (s) => doc.querySelector(s);
    q('[data-ds="current"]').value = 'now-password'; q('[data-ds="next"]').value = 'new-password-1'; q('[data-ds="again"]').value = 'new-password-1';
    q('[data-ds-act="stop"]').dispatchEvent(new dom.window.Event('click'));
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    return { u, after, state: q('[data-ds-state]').textContent };
  };
  // 1回目で外せた → 変えたあとは何もしない
  let r = await runWith(async () => 'done');
  assert.deepEqual(r.u.calls.map((c) => c[0]), ['reauth', 'before', 'update', 'token']);
  // 1回目がだめ → 変えたあとに、新しいパスワードで確かめ直してから、もう1回
  r = await runWith(async () => 'retry');
  assert.deepEqual(r.u.calls.map((c) => c[0]), ['reauth', 'before', 'update', 'token', 'reauth', 'after']);
  assert.deepEqual(r.u.calls[4][1], { e: 'rie@example.com', p: 'new-password-1' }, '新しいパスワードで確かめ直す');
  assert.deepEqual(r.after, [true]);
  assert.match(r.state, /止めました/);
  // 1回目で例外 → 同じく、もう1回
  r = await runWith(async () => { throw new Error('offline'); });
  assert.deepEqual(r.u.calls.map((c) => c[0]), ['reauth', 'before', 'update', 'token', 'reauth', 'after']);
  // 確かめ直しができなかった → afterChange(false) を呼び、止めることは成功のまま
  {
    const u = user();
    let n = 0;
    u.reauthenticateWithCredential = async (c) => { u.calls.push(['reauth', c]); if (++n === 2) throw new Error('x'); };
    const dom = new JSDOM('<body></body>'); const doc = dom.window.document; const after = [];
    D.open({ document: doc, user: () => u, credential: (e, p) => ({ e, p }), beforeChange: async () => 'retry', afterChange: async (ok) => { after.push(ok); } });
    const q = (s) => doc.querySelector(s);
    q('[data-ds="current"]').value = 'now-password'; q('[data-ds="next"]').value = 'new-password-1'; q('[data-ds="again"]').value = 'new-password-1';
    q('[data-ds-act="stop"]').dispatchEvent(new dom.window.Event('click'));
    for (let i = 0; i < 8; i++) await new Promise((r2) => setTimeout(r2, 0));
    assert.deepEqual(after, [false]);
    assert.match(q('[data-ds-state]').textContent, /止めました/);
  }
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /beforeChange:async\(\)=>\{lineState=await deviceStopLineLogin\(false\);return lineState;\}/);
  assert.match(html, /afterChange:async\(reauthOk\)=>\{lineState=reauthOk\?await deviceStopLineLogin\(true\):'failed';\}/);
  assert.match(html, /async function deviceStopLineLogin\(second\)\{\n  if\(!window\.MAINICO_LINE_AUTH_URL/, 'LINEでログインが未設定なら何もしない');
  assert.match(html, /return second\?'failed':'retry';/);
  assert.match(html, /if\(lineState==='failed'\)\{\n        lineUnlinkPending\(true\);/, '2回ともだめなら、解除できるまで設定に案内を出す');
  const ui = fs.readFileSync(new URL('../line-login-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /if\(!linked&&pending\)lineUnlinkPending\(false\);/, '解除できたら案内を消す');
  assert.match(ui, /if\(linked&&pending\)\{/);
}
console.log('ほかのスマホを止める: 入力の確かめ・本人確認と変更・違うパスワード・足りない入力・復旧なし・つなぎ込み・LINEでログインの解除の順番と再試行 7項目 passed');
