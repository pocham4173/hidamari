/* 利用開始と開き直しの動線(2026-10-11): 初日のアンケート・起動待ちの案内 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pick = (re) => { const m = html.match(re); assert.ok(m, 'not found: ' + re); return m[0]; };

// 1. 家庭に入った日(サーバーの joinedAt)は、アンケートを出さない。入った日が分からない古い登録は今までどおり
{
  const ctx = { memberInfoByUid: {} };
  vm.createContext(ctx); vm.runInContext(pick(/function surveyFirstDay\(me\)\{[\s\S]*?\n\}/), ctx);
  const at = (d) => ({ toDate: () => d });
  ctx.memberInfoByUid = { me: { joinedAt: at(new Date()) } };
  assert.equal(ctx.surveyFirstDay('me'), true, '入った日は出さない');
  ctx.memberInfoByUid = { me: { joinedAt: at(new Date(Date.now() - 2 * 86400000)) } };
  assert.equal(ctx.surveyFirstDay('me'), false, '次の日からは出す');
  ctx.memberInfoByUid = { me: {} };
  assert.equal(ctx.surveyFirstDay('me'), false, '入った日が分からないときは今までどおり');
  assert.match(html, /isFamily:\(\)=>uid\(\)===me&&!!memberInfoByUid\[me\]&&!memberIsHonnin\(me\)&&!surveyFirstDay\(me\)/);
}

// 2. 起動: Firebaseが自分で足す補助のファイルが読めなくても「外部ファイルを読み込めませんでした」と出さない。
//    まいにこが読むファイル(firebase本体など)が読めないときは、今までどおり知らせる
{
  const handler = pick(/window\.addEventListener\('error',function\(e\)\{[\s\S]*?\n\},true\);/);
  const run = (src) => {
    const shown = [];
    const ctx = { window: { addEventListener: (t, f) => { ctx.f = f; }, showStartupProblem: (m) => shown.push(m) }, document: { getElementById: () => ({ style: { display: 'flex' } }) }, console };
    ctx.window.window = ctx.window;
    vm.createContext(ctx); vm.runInContext(handler.replace(/^window\./, 'window.'), ctx);
    ctx.f({ target: { tagName: 'SCRIPT', src, dataset: {} } });
    return shown;
  };
  assert.deepEqual(run('https://apis.google.com/js/api.js?onload=__iframefcb1'), [], 'ログイン画面の部品');
  assert.deepEqual(run('https://www.google.com/recaptcha/enterprise.js?render=x'), [], 'reCAPTCHA');
  assert.deepEqual(run('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js'), ['外部ファイルを読み込めませんでした'], 'Firebase本体は知らせる');
  assert.deepEqual(run('https://pocham4173.github.io/hidamari/line-notify.js?v=1'), ['外部ファイルを読み込めませんでした']);
  // 15秒たっても進まないときは、もう一度読み込むボタンを出す(今までどおり)
  assert.match(html, /window\.showStartupProblem\(window\.mainicoStartupProblem\|\|'読み込みが進んでいません'\);\n\},15000\);/);
}
// 3. ご本人が管理者のとき、ご本人の「その他の設定」から家族へ管理者を引き継げる(2026-10-11)。
//    「管理者を引き継ぐ」は1つだけ置き、開いた設定画面へ移す
{
  assert.match(html, /<div id="person-owner-transfer-slot" data-owner-only hidden><\/div>/);
  assert.equal((html.match(/id="owner-transfer-sec"/g) || []).length, 1, '同じ欄を2つ置かない');
  assert.match(html, /function openPersonSettings\(\)\{ applyHouseholdPermissions\(\); placeOwnerTransfer\(true\);/);
  assert.match(html, /applyHouseholdPermissions\(\);\n  placeOwnerTransfer\(false\);/);
  const moved = [];
  const sec = { parentNode: null };
  const slots = { person: { appendChild: (n) => { n.parentNode = slots.person; moved.push('person'); } }, family: { appendChild: (n) => { n.parentNode = slots.family; moved.push('family'); } } };
  let rendered = 0;
  const ctx = { document: { getElementById: (id) => id === 'owner-transfer-sec' ? sec : id === 'person-owner-transfer-slot' ? slots.person : null, querySelector: () => slots.family },
    getOwnerTransfer: () => ({ renderSettings: () => rendered++ }) };
  vm.createContext(ctx); vm.runInContext(pick(/function placeOwnerTransfer\(person\)\{[\s\S]*?\n\}/), ctx);
  ctx.placeOwnerTransfer(true); ctx.placeOwnerTransfer(true); ctx.placeOwnerTransfer(false);
  assert.deepEqual(moved, ['person', 'family'], 'ご本人の設定へ移し、家族の設定を開くと戻す');
  assert.equal(rendered, 3, '開くたびに今の状態で描き直す');
}
console.log('利用開始と開き直し: 初日のアンケート・起動待ちの案内・ご本人からの管理者の引き継ぎ passed');
