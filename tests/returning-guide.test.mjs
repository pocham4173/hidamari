/* 前に使っていた方への案内(2026-10-09 審査の指摘)
   - 入口の最初に「前に使っていた方」を出し、まちがえて新しい家庭を作らない
   - いま使える戻り方(メールとパスワード・招待)だけを出し、準備中の機能(再接続QR)は出さない
   - LINEでログインは、公開の設定で使えるときだけ出す */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// 入口: 3つのうちの1つに、戻り方の入口がある(2026-10-10)
const entry = html.slice(html.indexOf('<div class="page" id="entry">'), html.indexOf('<!-- ホーム画面への追加案内 -->'));
assert.ok(entry.indexOf('id="entry-returning"') > 0, '入口に「使っていた記録に戻る」');
assert.ok(entry.indexOf('id="entry-returning"') < entry.indexOf('id="entry-who"'), '使い方の質問より前に出す');
assert.doesNotMatch(entry, /onclick="openRecovery\(\)"/, '復旧の入口は「使っていた記録に戻る」の中にまとめる(重複させない)');

// 案内の中身
const start = html.indexOf('<div class="modal" id="returning-modal"');
const modal = html.slice(start, html.indexOf('<!-- おまもりタグ: 読み取った方に見える画面の見本', start));
assert.match(modal, /新しい家庭になります/, '新しくはじめると別の家庭になることを先に伝える');
assert.match(modal, /前の家庭の記録は、新しくはじめても消えません/, 'データが消えたと誤解させない');
assert.match(modal, /openRecovery\(true\)/, 'メールとパスワードで戻る');
assert.match(modal, /entryJoin\(\)/, '家族は新しい招待で参加');
assert.doesNotMatch(modal, /再接続|QRでつなぐ/, '準備中の再接続QRは案内しない');
assert.match(modal, /id="returning-line" hidden/, 'LINEでログインは最初は隠す');

// 動き: LINEでログインが使えないときは隠したまま、使えるときだけ出す
const fnSrc = html.slice(html.indexOf('function openReturningGuide()'), html.indexOf('if(scheduleLink){', html.indexOf('function openReturningGuide()')));
for (const enabled of [false, true]) {
  const dom = new JSDOM('<!doctype html>' + modal, { runScripts: 'outside-only' });
  const w = dom.window;
  w.lineLoginEnabled = () => enabled;
  w.eval(fnSrc);
  w.openReturningGuide();
  assert.ok(w.document.getElementById('returning-modal').classList.contains('show'));
  assert.equal(w.document.getElementById('returning-line').hidden, !enabled, 'LINEでログイン: ' + enabled);
  w.closeReturningGuide();
  assert.ok(!w.document.getElementById('returning-modal').classList.contains('show'));
}

// LINEのお知らせから開いたときの案内: LINEでログインが使えないときは「LINEで続ける」を出さない
const note = html.slice(html.indexOf('if(scheduleLink){'), html.indexOf("window.addEventListener('hashchange'"));
assert.match(note, /lineOk\?'LINEとつないでいれば「LINEで続ける」を/, '「LINEで続ける」は使えるときだけ');

// 新しく家庭を作る前の確認は残っている
assert.match(html, /まいにこを使うのは、はじめてですか？/);
console.log('前に使っていた方への案内(入口の順番・使える戻り方だけ・LINEでログインは設定しだい・新規作成前の確認) passed');
