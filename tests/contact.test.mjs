/* 問い合わせ(2026-10-08): Googleフォームを開く。まいにこのページからは何も送らない・保存しない */
import assert from 'node:assert/strict';
import fs from 'node:fs';
const page = fs.readFileSync(new URL('../contact.html', import.meta.url), 'utf8');
const FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSfuGRFwXgJ5Rd2Gllo1Yp44o0PGs19bcdITAjRwtL7DFpl99A/viewform';
assert.ok(page.includes('<a class="send" id="open-form" href="' + FORM + '" target="_blank" rel="noopener noreferrer">✉️ 問い合わせフォームを開く</a>'));
assert.match(page, /119番・110番へ/);
assert.match(page, /名前・パスワード・招待コード・病気のこと・記録の中身は書かないでください。/);
assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|<form/.test(page), 'このページからは何も送らない');
assert.equal(page.split('<a class="mainico-back" href="./index.html" data-back>← まいにこに戻る</a>').length - 1, 2, '戻るボタン');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.equal((html.match(/<a class="set-btn" href="contact\.html">✉️ 問い合わせる<\/a>/g) || []).length, 2, 'ご本人と家族の設定から');
assert.match(fs.readFileSync(new URL('../guide/trouble.html', import.meta.url), 'utf8'), /href="\.\.\/contact\.html">✉️ 問い合わせフォーム<\/a>/);
assert.match(fs.readFileSync(new URL('../privacy.html', import.meta.url), 'utf8'), /Googleフォーム・Google LLC のサービスに保存されます/);
const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
assert.match(sw, /'invite-switch\.js', 'contact\.html'\n\];/);
assert.ok(!sw.includes('contact.js'));
console.log('問い合わせ: Googleフォーム・つなぎ込み passed');
