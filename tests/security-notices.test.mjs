/* 安全のお知らせ(security-notices.js・2026-10-06)の検査。jsdom を使う */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

await import('../security-notices.js');
const N = globalThis.MainicoSecurityNotices;
const now = new Date(2026, 9, 6, 12, 0);
const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();
const names = { fam: 'りえ', hon: 'はる', anon: 'あに' };
const nameOf = (u) => names[u] || '';

// 1. 文面: だれが・いつ。名前がなければ「家族」「ご本人」
assert.equal(N.text({ type: 'device-reconnect', uid: 'fam', targetUid: 'hon', name: 'りえ', clientAt: at(6, 9, 5) }, nameOf),
  'りえさんが、再接続QRではるさんの新しいスマホをつなぎました（10月6日 9:05）。前のスマホは使えなくなります。');
assert.equal(N.text({ type: 'line-login-signin', uid: 'anon', clientAt: at(5, 21, 30) }, nameOf),
  'あにさんのアカウントに、「LINEでログイン」で新しいスマホ（画面）から入りました（10月5日 21:30）。');
assert.match(N.text({ type: 'device-reconnect', uid: 'x', targetUid: 'y', clientAt: at(6, 9, 5) }, () => ''), /^家族さんが、再接続QRでご本人さんの/);
// 2. ホームに出すのは直近14日・新しい順・この2種類だけ
const rows = [
  { type: 'line-login-signin', uid: 'anon', clientAt: at(5, 21, 30) },
  { type: 'device-reconnect', uid: 'fam', targetUid: 'hon', name: 'りえ', clientAt: at(6, 9, 5) },
  { type: 'line-login-signin', uid: 'anon', clientAt: now.getTime() - 15 * 86400000 },
  { type: 'memo', uid: 'fam', clientAt: at(6, 10, 0) },
];
assert.deepEqual(N.recent(rows, now).map((v) => v.type), ['device-reconnect', 'line-login-signin']);
// 3. 表示: 文字として出す(HTMLとして解釈しない)・ないときは何も出さない
{
  const dom = new JSDOM('<div id="box"></div>');
  const box = dom.window.document.getElementById('box');
  N.render(box, rows, (u) => (u === 'fam' ? '<img src=x onerror=alert(1)>' : nameOf(u)), now);
  assert.match(box.textContent, /安全のお知らせ/);
  assert.equal(box.querySelectorAll('li').length, 2);
  assert.equal(box.querySelector('img'), null, '名前はHTMLとして扱わない');
  assert.match(box.textContent, /ほかのスマホを止める/);
  N.render(box, [], nameOf, now);
  assert.equal(box.innerHTML, '');
  // 監視: 届いたら描き直し、止めたら購読をやめる
  let cb, stopped = 0;
  const ctl = N.create({ document: dom.window.document, boxId: 'box', nameOf, now: () => now, watch: (f) => { cb = f; return () => { stopped++; }; } });
  ctl.start(); cb(rows.slice(0, 1));
  assert.equal(box.querySelectorAll('li').length, 1);
  ctl.stop(); assert.equal(stopped, 1);
}
// 4. つなぎ込み: 家族のホームとご本人の画面の両方・ふり返り・取り消し一覧に出さない・操作に数えない
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="security-notices"><\/div>\n      <div id="survey-card"><\/div>/);
  assert.match(html, /<div id="h-approve"><\/div>\n    <div id="person-security-notices"><\/div>/);
  assert.match(html, /initSurvey\(\);\n  initSecurityNotices\('security-notices'\);/);
  assert.match(html, /initHitokoePrompt\(\);\n  initSecurityNotices\('person-security-notices'\);/);
  assert.match(html, /<script src="security-notices\.js\?v=\d+"><\/script>/);
  assert.match(html, /'line-login-signin': function\(v\)\{ return \['安全のお知らせ'/);
  assert.match(html, /'device-reconnect':  function\(v\)\{ return \['安全のお知らせ'/);
  assert.match(html, /const CANCEL_HIDDEN_TYPES=\{'line-login-signin':1,'device-reconnect':1,/);
  assert.match(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), /'security-notices\.js'/);
  assert.match(fs.readFileSync(new URL('../hitokoe.js', import.meta.url), 'utf8'), /'line-login-signin':1,'device-reconnect':1\}/);
  const worker = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.match(worker, /HITOKOE_NOT_ACTIVITY = new Set\(\[[^\]]*'line-login-signin', 'device-reconnect'\]\)/);
  assert.match(worker, /USAGE_NOT_OPERATION = new Set\(\[[^\]]*'line-login-signin', 'device-reconnect'\]\)/);
  const rules = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.ok(!/'line-login-signin'|'device-reconnect'/.test(rules.slice(rules.indexOf('function validEventType'), rules.indexOf('match /events/{eventId}'))), 'アプリからは作れない(validEventType に入れない)');
}
console.log('安全のお知らせ: 文面・直近14日・文字として表示・購読・つなぎ込み(家族とご本人・ふり返り・操作に数えない・アプリから作れない) passed');
