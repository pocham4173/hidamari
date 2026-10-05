/* 家族の1分アンケート(family-survey.js・2026-10-05)の画面の検査。jsdom を使う */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

await import('../family-survey.js');
const S = globalThis.MainicoSurvey;
const oct = new Date(2026, 9, 5, 10), nov = new Date(2026, 10, 2, 10);

// 1. 何を聞くか: はじめは「使う前の1か月」、次の月から毎月。答えた月は聞かない
assert.equal(S.whatToAsk([], oct), 'baseline');
assert.equal(S.whatToAsk([{ month: '2026-10', kind: 'baseline' }], oct), '', '同じ月には聞かない');
assert.equal(S.whatToAsk([{ month: '2026-10', kind: 'baseline' }], nov), 'monthly');
assert.equal(S.whatToAsk([{ month: '2026-10', kind: 'baseline' }, { month: '2026-11', kind: 'monthly' }], nov), '');
assert.match(S.cardHtml('baseline'), /使い始める<b>前の1か月<\/b>/);
assert.ok(!S.cardHtml('baseline').includes('負担'), 'はじめは負担を聞かない');
assert.match(S.cardHtml('monthly'), /<b>この1か月<\/b>/);
assert.match(S.cardHtml('monthly'), /確かめる<b>負担<\/b>/);
assert.match(S.cardHtml('monthly'), /ほかの家族には見えません/);
assert.match(S.cardHtml('monthly'), /答えなくても、使い方は何も変わりません/);

function setup({ rows = [], family = true, now = oct, fail = false } = {}) {
  const dom = new JSDOM('<div id="survey-card"></div>');
  const store = new Map(), saved = [];
  let cb;
  const ctl = S.create({
    document: dom.window.document, cardId: 'survey-card',
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    uid: () => 'u1', groupId: () => 'g1', now: () => now, isFamily: () => family,
    watchMine: (f) => { cb = f; return () => {}; },
    save: async (id, data) => { if (fail) throw new Error('offline'); saved.push([id, data]); },
  });
  ctl.start();
  cb(rows);
  const box = dom.window.document.getElementById('survey-card');
  const click = (sel) => box.querySelector(sel).dispatchEvent(new dom.window.Event('click'));
  const pick = (name, value) => { box.querySelector('input[name="' + name + '"][value="' + value + '"]').checked = true; };
  return { box, saved, store, click, pick, ctl };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// 2. ご本人の画面には出さない
assert.equal(setup({ family: false }).box.innerHTML, '');
// 3. はじめての答え: 選ばずに押すと案内、選んで押すと保存してお礼
{
  const t = setup();
  assert.match(t.box.innerHTML, /試験運用のアンケート/);
  t.click('[data-survey-act="send"]'); await tick();
  assert.match(t.box.textContent, /どれか1つを選んでください/);
  assert.equal(t.saved.length, 0);
  t.pick('survey-absences', '2');
  t.click('[data-survey-act="send"]'); await tick(); await tick();
  assert.deepEqual(t.saved, [['u1_2026-10', { uid: 'u1', groupId: 'g1', month: '2026-10', kind: 'baseline', absences: 2, burden: '' }]]);
  assert.match(t.box.textContent, /ありがとうございました/);
}
// 4. 毎月の答え: 回数と負担の両方が必要
{
  const t = setup({ rows: [{ month: '2026-10', kind: 'baseline' }], now: nov });
  t.pick('survey-absences', '0');
  t.click('[data-survey-act="send"]'); await tick();
  assert.equal(t.saved.length, 0, '負担を選ぶまで保存しない');
  t.pick('survey-burden', 'less');
  t.click('[data-survey-act="send"]'); await tick(); await tick();
  assert.deepEqual(t.saved[0], ['u1_2026-11', { uid: 'u1', groupId: 'g1', month: '2026-11', kind: 'monthly', absences: 0, burden: 'less' }]);
}
// 5. 「今回は答えない」→ その月はもう出さない(次の月はまた出る)
{
  const t = setup();
  t.click('[data-survey-act="skip"]');
  assert.equal(t.box.innerHTML, '');
  assert.ok(t.store.get('mainicoSurveySkip-u1-2026-10'));
}
// 6. 保存できなかったら、もう一度押せる
{
  const t = setup({ fail: true });
  t.pick('survey-absences', '-1');
  t.click('[data-survey-act="send"]'); await tick(); await tick();
  assert.match(t.box.textContent, /保存できませんでした/);
  assert.equal(t.box.querySelector('[data-survey-act="send"]').disabled, false);
}
// 7. 画面へのつなぎ込み
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="survey-card"><\/div>/);
  assert.match(html, /<script src="family-survey\.js\?v=\d+"><\/script>/);
  assert.match(html, /initHitokoe\(\);\n  initSurvey\(\);/);
  assert.match(html, /answeredAt:firebase\.firestore\.FieldValue\.serverTimestamp\(\)/, '答えた時刻はサーバーの時刻');
  assert.match(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), /'family-survey\.js'/);
}
console.log('家族の1分アンケート: 何を聞くか・ご本人には出さない・はじめて・毎月・答えない・保存の失敗・つなぎ込み 7項目 passed');
