/* 写真つきの使い方ガイド(guide/)の検査: 写真がそろっている・アプリのメニューから開ける */
import assert from 'node:assert/strict';
import fs from 'node:fs';
const guide = fs.readFileSync(new URL('../guide/index.html', import.meta.url), 'utf8');
const imgs = [...guide.matchAll(/src="img\/([^"]+)"/g)].map((m) => m[1]);
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
console.log('使い方ガイド: 写真・注意事項・章・メニューから開ける passed');
