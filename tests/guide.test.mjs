/* 写真つきの使い方ガイド(guide/)の検査: 写真がそろっている・アプリのメニューから開ける */
import assert from 'node:assert/strict';
import fs from 'node:fs';
const guide = fs.readFileSync(new URL('../guide/index.html', import.meta.url), 'utf8');
const trouble = fs.readFileSync(new URL('../guide/trouble.html', import.meta.url), 'utf8');
const line = fs.readFileSync(new URL('../guide/line.html', import.meta.url), 'utf8');
const imgs = [...(guide + trouble + line).matchAll(/src="img\/([^"]+)"/g)].map((m) => m[1]);
assert.ok(imgs.length >= 10, '写真つき');
for (const f of imgs) assert.ok(fs.existsSync(new URL('../guide/img/' + f, import.meta.url)), 'ある: ' + f);
for (const f of fs.readdirSync(new URL('../guide/img/', import.meta.url))) assert.ok(imgs.includes(f), '使っていない写真はおかない: ' + f);
assert.match(guide, /119番・110番の代わりではありません/, '注意事項');
for (const id of ['start', 'join', 'daily', 'family', 'yotei', 'kiroku', 'hitokoe', 'anshin', 'recovery', 'caution', 'faq']) assert.match(guide, new RegExp('id="' + id + '"'));
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// 家族の設定の一番上・ご本人の「その他の設定」の一番上に、すぐ見える形で置く
assert.match(html, /<button class="set-btn" type="button" onclick="openRecoveryMenu\(\)">復旧を設定する<\/button>\n    <\/div>\n    <a class="guide-link" href="guide\/"/);
assert.match(html, /<div class="ttl">その他の設定<\/div>\n  <a class="guide-link" href="guide\/"/);
assert.match(html, /<a class="consent-back" href="guide\/" target="_blank" rel="noopener">📷 写真つきの使い方<\/a>/, '入口からも');
// 準備中の「LINEでログイン」は、送信役の場所が設定されるまでメニューに出さない
assert.match(html, /id="menu-line-login" data-line-login-only hidden/);
assert.match(html, /<div class="set-sec" data-line-login-only hidden><h4>LINEでログイン/);
assert.match(html, /document\.querySelectorAll\('\[data-line-login-only\]'\)\.forEach\(el=>\{el\.hidden=!window\.MAINICO_LINE_AUTH_URL;\}\);/);
// 困ったとき(写真つき): よくある困りごと・119番の注意・問い合わせ。LINEのメニューの「困ったとき」(#trouble)からも開く
assert.match(trouble, /急ぐとき・命に関わるときは、119番・110番へ/);
for (const id of ['mistake', 'pending', 'voice', 'line', 'offline', 'newphone', 'stuck', 'home', 'nobody', 'contact']) assert.match(trouble, new RegExp('id="' + id + '"'));
const help = fs.readFileSync(new URL('../help.html', import.meta.url), 'utf8');
assert.match(help, /else if\(h==='#trouble'\)\{location\.replace\('guide\/trouble\.html'\);\}/);
assert.match(help, /<label id="memo" for="question-template">/);
assert.equal((html.match(/href="guide\/trouble\.html" target="_blank" rel="noopener">📷 困ったとき（写真つき）<\/a>/g) || []).length, 2);
// LINEで予定のお知らせ(写真つき): つなぐ・予定に時間を入れる・ほかの人・やめる。LINEのメニューの「予定のお知らせ」(#line)からも開く
for (const id of ['link', 'notify', 'others']) assert.match(line, new RegExp('id="' + id + '"'));
assert.match(line, /月200通まで/);
assert.match(help, /else if\(h==='#line'\)\{location\.replace\('guide\/line\.html'\);\}/);
assert.ok(!/help\.html#line"/.test(html), 'アプリからは写真つきの案内へ');
console.log('使い方ガイド: 写真・注意事項・章・メニューから開ける passed');
