/* 問い合わせフォーム(2026-10-08): 選んで書くだけで、運営者あてのメールができる。このページは何も送らない・保存しない */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../contact.js');

const m = C.build({ kind: '家族とつながらない', phone: 'Android', mode: 'ご家族のスマホ', text: '招待QRを読んでも、つながりません。' });
assert.equal(m.to, 'pocham4173@gmail.com');
assert.equal(m.subject, 'まいにこの問い合わせ：家族とつながらない');
assert.match(m.body, /困っていること：家族とつながらない\n使っているスマホ：Android\n使い方：ご家族のスマホ\n\n内容：\n招待QRを読んでも、つながりません。/);
assert.ok(m.href.startsWith('mailto:pocham4173@gmail.com?subject='));
assert.equal(decodeURIComponent(m.href.split('&body=')[1]), m.body, '本文がそのままメールに入る');
assert.ok(C.build({ text: 'あ'.repeat(2000) }).body.includes('あ'.repeat(800)) && !C.build({ text: 'あ'.repeat(2000) }).body.includes('あ'.repeat(801)), '800文字まで');
// 書いてはいけないもの
assert.match(C.warnings('パスワードは abc です').join(), /パスワード/);
assert.match(C.warnings('コードは X5EP4H6T でした').join(), /招待コード/);
assert.match(C.warnings('https://example.com/verify?x=1').join(), /リンク/);
assert.deepEqual(C.warnings('設定を押したら止まりました'), []);

const page = fs.readFileSync(new URL('../contact.html', import.meta.url), 'utf8');
assert.match(page, /<form id="contact-form" novalidate>/);
assert.match(page, /119番・110番へ/);
assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(page), 'このページからは何も送らない');
assert.equal(page.split('<a class="mainico-back" href="./index.html" data-back>← まいにこに戻る</a>').length - 1, 2, '戻るボタン');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.equal((html.match(/<a class="set-btn" href="contact\.html">✉️ 問い合わせる<\/a>/g) || []).length, 2, 'ご本人と家族の設定から');
assert.match(fs.readFileSync(new URL('../guide/trouble.html', import.meta.url), 'utf8'), /href="\.\.\/contact\.html">✉️ 問い合わせフォーム<\/a>/);
assert.match(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), /'contact\.html', 'contact\.js'/);
console.log('問い合わせフォーム: メールの組み立て・注意・つなぎ込み passed');
