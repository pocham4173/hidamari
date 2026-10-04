/* 「ひと声のきっかけ」の家族の設定画面(保存の動き)の検査。jsdom を使う。
   LINEにも送るを新しく選んだときだけ、ご本人にもう一度了解を聞く(お願いの番号を変える)。 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

await import('../hitokoe.js');
const H = globalThis.MainicoHitokoe;
const members = {
  hon: { name: '花子', role: 'honnin', status: 'approved' },
  ani: { name: '太郎', role: 'kazoku', status: 'approved' },
};

async function save(rows, change) {
  const dom = new JSDOM('<div id="set"></div><div id="card"></div>');
  const document = dom.window.document;
  const written = [], confirms = [];
  let listener;
  const ctl = H.create({
    document, col: () => ({ where: () => ({ onSnapshot: (ok) => { listener = listener || ok; return () => {}; } }) }),
    addEvent: async (d) => { written.push(d); }, uid: () => 'ani', myName: () => '太郎', members: () => members,
    day: () => '2026-10-05', confirm: async (t, l) => { confirms.push([t, l]); return true; },
    cardId: 'card', settingsId: 'set',
  });
  ctl.start();
  listener({ forEach: (fn) => rows.forEach((v) => fn({ data: () => v })) });
  ctl.renderSettings();
  const box = document.getElementById('set');
  change(box);
  box.querySelector('[data-hk-act="save"]').dispatchEvent(new dom.window.Event('click'));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  ctl.stop();
  return { data: written[0], confirms, state: box.querySelector('[data-hk-state]').textContent };
}
const cfg = (extra) => ({ type: 'hitokoe-config', enabled: true, hour: 11, requestId: 'r1', uid: 'ani', clientAt: 1, ...extra });

// 1. 使っている家庭で「LINEにも送る」を新しく選ぶ → ご本人にLINEのことを書いて聞き直す
let r = await save([cfg()], (box) => { box.querySelector('[data-hk="line"]').checked = true; });
assert.equal(r.data.line, true);
assert.notEqual(r.data.requestId, 'r1', 'お願いの番号を変えて、ご本人に聞き直す');
assert.equal(r.confirms.length, 1);
assert.match(r.confirms[0][0], /LINEにも届きます（LINEには名前や様子は書きません）/);
assert.equal(r.confirms[0][1], 'LINEにも送る');
assert.match(r.state, /ご本人の了解を待っています/);

// 2. もうLINEにも送っている家庭で、時刻だけ変える → 聞き直さない
r = await save([cfg({ line: true })], (box) => { box.querySelector('[data-hk="hour"]').value = '10'; });
assert.equal(r.data.line, true);
assert.equal(r.data.requestId, 'r1');
assert.equal(r.data.hour, 10);
assert.equal(r.confirms.length, 0);
assert.equal(r.state, '保存しました');

// 3. LINEにも送るをやめる → 聞き直さない(届く先が減るだけ)
r = await save([cfg({ line: true })], (box) => { box.querySelector('[data-hk="line"]').checked = false; });
assert.equal(r.data.line, false);
assert.equal(r.data.requestId, 'r1');
assert.equal(r.confirms.length, 0);

// 4. 切る → LINEにも送らない
r = await save([cfg({ line: true })], (box) => { box.querySelector('[data-hk="enabled"]').checked = false; });
assert.equal(r.data.enabled, false);
assert.equal(r.data.line, false);
assert.equal(r.data.requestId, '');

// 5. 切っている状態から、アプリの中だけでオンにする → 今までどおり聞く(LINEのことは書かない)
r = await save([cfg({ enabled: false, requestId: '' })], (box) => { box.querySelector('[data-hk="enabled"]').checked = true; });
assert.equal(r.data.line, false);
assert.ok(r.data.requestId);
assert.equal(r.confirms.length, 1);
assert.ok(!/LINEにも届きます/.test(r.confirms[0][0]));
assert.equal(r.confirms[0][1], 'オンにする');

console.log('ひと声のきっかけの設定画面: LINEにも送るを選んだときだけ聞き直す・やめる・切る 5項目 passed');
