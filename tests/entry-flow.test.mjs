/* 入口の3つと、そのあとの質問(2026-10-10 使いやすさの見直し)
   はじめて使う → このスマホで操作するのは？(本人/家族) → 家族: ご本人も自分のスマホで使いますか？(使う/家族だけ)
   招待から参加する → 招待の印(from)があればそのまま参加、なければ 本人/家族 を聞いて参加
   つなぐ画面は、選んだ入口に合わせて「作る」か「参加」だけを出す */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const between = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return html.slice(i, j); };
const entryHtml = between('<div class="page" id="entry">', '<!-- ホーム画面への追加案内 -->');
const connectHtml = between('<div class="page" id="connect-page"', '<!-- ===== 承認待ち ===== -->');
const flowSrc = between('function showEntryChoices(on){', 'function skipInvite(){');
const connectSrc = between('function setupConnectPage(){', '/* 招待QRを、まいにこの中のカメラで読み取る');

function setup(invite) {
  const dom = new JSDOM('<!doctype html><body>' + entryHtml + '</div>' + connectHtml + '</div></body>', { runScripts: 'outside-only' });
  const w = dom.window, store = new Map(), calls = [];
  const c = dom.getInternalVMContext();
  Object.assign(w, {
    previewStorage: { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    readInvite: () => invite || null,
    pickMode: (m) => calls.push('pickMode:' + m),
    pickInvited: () => { store.set('mainicoEntryIntent', 'join'); calls.push('pickInvited'); },
    pickInvitedKonly: () => { store.set('mainicoEntryIntent', 'join'); calls.push('pickInvitedKonly'); },
    showPage: (id) => calls.push('page:' + id), entryState: () => {}, renderInviteNote: () => {},
    pendingMode: 'kazoku'
  });
  vm.runInContext(flowSrc + '\nlet pendingMode=window.pendingMode;\n' + connectSrc, c);
  const vis = (id) => !w.document.getElementById(id).hidden;
  return { w, c, store, calls, vis, run: (code) => vm.runInContext(code, c) };
}

{ // はじめて使う → 本人
  const t = setup();
  assert.ok(t.vis('select-box') && !t.vis('entry-who') && !t.vis('entry-both'));
  t.run('entryStart()');
  assert.equal(t.store.get('mainicoEntryIntent'), 'create');
  assert.ok(!t.vis('select-box') && t.vis('entry-who'), '「このスマホで操作するのは？」だけを出す');
  t.run("entryWho('honnin')");
  assert.deepEqual(t.calls, ['pickMode:honnin']);
}
{ // はじめて使う → 家族 → 使う / 家族だけ。もどるで前の質問へ
  const t = setup();
  t.run("entryStart();entryWho('family')");
  assert.ok(t.vis('entry-both') && !t.vis('entry-who'), '家族を選んだときだけ「ご本人も使いますか？」');
  t.run("entryShow('entry-who')");
  assert.ok(t.vis('entry-who') && !t.vis('entry-both'));
  t.run('entryBack()');
  assert.ok(t.vis('select-box') && !t.vis('entry-who'));
  assert.equal(t.store.has('mainicoEntryIntent'), false, '入口に戻ったら選び直せる');
}
{ // 招待から参加する: 印なし → 本人/家族を聞く。家族は招待で参加(作る方へは行かない)
  const t = setup({ code: 'ABCD2345' });
  t.run('entryJoin()');
  assert.equal(t.store.get('mainicoEntryIntent'), 'join');
  assert.ok(t.vis('entry-who'));
  t.run("entryWho('family')");
  assert.ok(t.calls.includes('pickInvited'), '家族は招待で参加');
  assert.ok(!t.vis('entry-both'), '招待で参加するときは「家族だけ」を聞かない');
}
{ // 招待から参加する: ご本人からの招待(from=h)・家族だけの家庭からの招待(from=k)は、そのまま参加へ
  let t = setup({ code: 'ABCD2345', from: 'h' });
  t.run('entryJoin()');
  assert.deepEqual(t.calls, ['pickInvited']);
  t = setup({ code: 'ABCD2345', from: 'k' });
  t.run('entryJoin()');
  assert.deepEqual(t.calls, ['pickInvitedKonly']);
}
{ // つなぐ画面: はじめて使う → 作るボタンだけ。招待から参加 → 参加の欄だけ。入口を通らない(前の版から続き) → 両方
  let t = setup();
  t.store.set('mainicoEntryIntent', 'create'); t.run('setupConnectPage()');
  assert.ok(t.vis('btn-newgroup') && !t.vis('join-box') && !t.vis('connect-or'));
  assert.equal(t.w.document.getElementById('btn-newgroup').textContent, '家族の場所を作る');
  assert.equal(t.w.document.getElementById('together-box').style.display, 'block', '本人と家族で使うときは、ご本人の了解の確認を残す');
  t = setup();
  t.store.set('mainicoEntryIntent', 'join'); t.run('setupConnectPage()');
  assert.ok(!t.vis('btn-newgroup') && t.vis('join-box'), '参加の人に「新しくはじめる」を見せない');
  t = setup();
  t.run('setupConnectPage()');
  assert.ok(t.vis('btn-newgroup') && t.vis('join-box') && t.vis('connect-or'));
}
// 入口に、復旧・LINEでログインの重複したボタンを置かない(「使っていた記録に戻る」の中にまとめる)
assert.doesNotMatch(entryHtml, /openRecovery\(|lineLoginStart\(/);
assert.doesNotMatch(connectHtml, /openRecovery\(/, 'つなぐ画面でも、作る/参加/復旧を選び直させない');
console.log('入口: 3つの入口・はじめて使う(本人/家族→本人も使う/家族だけ)・招待から参加・つなぐ画面の出し分け passed');
