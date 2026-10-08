/* 「ひと声のきっかけ」(hitokoe.js)の判定と画面の検査 */
import assert from 'node:assert/strict';
await import('../hitokoe.js');
const H = globalThis.MainicoHitokoe;
const at = (d) => ({ seconds: Math.floor(d.getTime() / 1000) });
const members = {
  hon: { name: '花子', role: 'honnin', mode: 'honnin', status: 'approved' },
  ani: { name: '太郎', role: 'kazoku', status: 'approved' },
  imo: { name: '次子', role: 'kazoku', status: 'approved' },
  wait: { name: '承認待ち', role: 'kazoku', status: 'pending' },
};
const day = '2026-10-05'; // 月曜日
const now = (h, m = 0) => new Date(2026, 9, 5, h, m);
const cfg = (extra) => ({ type: 'hitokoe-config', enabled: true, hour: 11, requestId: 'r1', uid: 'ani', name: '太郎', at: at(now(8)), ...extra });
const yes = { type: 'hitokoe-consent', uid: 'hon', requestId: 'r1', answer: 'yes', at: at(now(8, 30)) };
const run = (o) => H.evaluate({ configRows: [cfg()], consentRows: [yes], todayRows: [], members, now: now(12), day, ...o })[0];

// 1. 初めは切ってある
assert.equal(H.evaluate({ configRows: [], consentRows: [], todayRows: [], members, now: now(12), day })[0].state, 'off');
// 2. オンにしても、ご本人の了解までは動かない
assert.equal(run({ consentRows: [] }).state, 'waiting-consent');
// 3. 「やめておく」なら動かない
assert.equal(run({ consentRows: [{ ...yes, answer: 'no' }] }).state, 'declined');
// 4. 了解は、そのときのお願い(requestId)にだけ効く(切ってからオンにし直すと聞き直す)
assert.equal(run({ configRows: [cfg({ requestId: 'r2' })] }).state, 'waiting-consent');
// 5. 時刻前は出さない
assert.equal(run({ now: now(10, 59) }).state, 'before-time');
// 6. 時刻を過ぎて、ご本人の操作が何もない日だけ出る。受け取るのは設定した人(担当がないとき)
let r = run();
assert.equal(r.state, 'show'); assert.equal(r.assignee, 'ani');
// 7. 挨拶・薬・体調・お願いのどれか1つでもあれば出ない
for (const type of ['aisatsu', 'kusuri', 'kibun', 'onegai', 'family-message-back'])
  assert.equal(run({ todayRows: [{ type, uid: 'hon', date: day }] }).state, 'active', type);
// 8. 家族の記録や、前の日の記録は数えない
assert.equal(run({ todayRows: [{ type: 'aisatsu-back', uid: 'ani', date: day }, { type: 'aisatsu', uid: 'hon', date: '2026-10-04' }] }).state, 'show');
// 9. 了解の記録そのものは「操作」に数えない
assert.equal(run({ todayRows: [{ type: 'hitokoe-consent', uid: 'hon', date: day }] }).state, 'show');
// 10. 曜日ごとの担当(月曜は次子さん)
r = run({ configRows: [cfg({ assignees: { 1: 'imo', 3: 'imo' } })] });
assert.equal(r.assignee, 'imo'); assert.equal(r.assigneeName, '次子');
// 11. 担当が承認待ち・ご本人など受け取れない人なら、設定した人へ
assert.equal(run({ configRows: [cfg({ assignees: { 1: 'wait' } })] }).assignee, 'ani');
assert.equal(run({ configRows: [cfg({ assignees: { 1: 'hon' } })] }).assignee, 'ani');
// 12. お休み(毎週の曜日・期間)
assert.equal(run({ configRows: [cfg({ offWeekdays: [1] })] }).state, 'paused');
assert.equal(run({ configRows: [cfg({ pauses: [{ from: '2026-10-03', to: '2026-10-07' }] })] }).state, 'paused');
assert.equal(run({ configRows: [cfg({ pauses: [{ from: '2026-10-06', to: '2026-10-07' }] })] }).state, 'show');
// 13. 「連絡しました」が押されたら、ほかの家族にも出る
r = run({ todayRows: [{ type: 'hitokoe-contacted', target: 'hon', uid: 'imo', name: '次子', date: day, at: at(now(11, 20)) }] });
assert.equal(r.state, 'contacted'); assert.equal(r.contacted.name, '次子');
let html = H.cardHtml([r], 'ani');
assert.match(html, /次子さんが11:20に花子さんへ連絡しました/);
// 14. カードは担当の1人にだけ出る。文面は「声をかけるきっかけ」で、必ず書くことが入っている
r = run();
html = H.cardHtml([r], 'ani');
assert.match(html, /今日はまだ花子さんから届いていません。電話や顔を見に行くなど、あなたから声をかけるきっかけにどうぞ。/);
assert.match(html, /押し忘れや外出のことも多くあります/);
assert.match(html, /安否確認・緊急通報ではありません/);
assert.match(html, /知らせがないことは無事の保証ではありません/);
assert.match(html, /119番/);
assert.match(html, /data-hitokoe-contacted="hon"/);
assert.equal(H.cardHtml([r], 'imo'), '', '担当でない家族には出さない');
// 15. 夜中0〜4時(前の日の扱い)には出さない
assert.equal(H.evaluate({ configRows: [cfg()], consentRows: [yes], todayRows: [], members, now: new Date(2026, 9, 6, 1), day })[0].state, 'before-time');
// 16. 最新の設定が有効。切ったら出ない
assert.equal(run({ configRows: [cfg(), cfg({ enabled: false, at: at(now(9)) })] }).state, 'off');
// 17. 壊れた値でも落ちない(時刻は11時に戻す)
assert.equal(H.latestConfig([{ type: 'hitokoe-config', enabled: true, hour: 3, offWeekdays: 'x', pauses: [{ from: 'a' }], assignees: { 9: 'x' } }]).hour, 11);
// 18. 設定画面に状態と、必ず書くことが出る
const set = H.settingsHtml(H.latestConfig([cfg()]), members, [run({ consentRows: [] })]);
assert.match(set, /ご本人の了解待ちです/);
assert.match(set, /安否確認・緊急通報ではありません/);
assert.match(set, /LINEにも送る/);
assert.match(set, /LINEにも送る（1日1通・名前や様子は書きません）/);
assert.match(set, /名前や様子は書きません/);
assert.ok(!/data-hk="line" checked/.test(set), 'LINEにも送るは初め切ってある');
assert.match(H.settingsHtml(H.latestConfig([cfg({ line: true })]), members, []), /data-hk="line" checked/);
assert.equal(H.latestConfig([cfg({ line: 'yes' })]).line, false, 'true のときだけLINEにも送る');
assert.ok(!set.includes('承認待ち</option>'), '承認待ちの人は担当に選べない');
assert.ok(!set.includes('花子</option>'), 'ご本人は担当に選べない');

// 19. ご本人のスマホ: オンになったら1回だけ確認し、答えを記録する
{
  const written = [], asked = [], storage = new Map();
  let listener;
  const ctx = {
    col: () => ({ where: () => ({ onSnapshot: (ok) => { listener = ok; return () => {}; } }) }),
    addEvent: async (d) => { written.push(d); }, uid: () => 'hon', members: () => members, day: () => day,
    storage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    speak() {}, ask: async (t, y, n) => { asked.push([t, y, n]); return true; },
  };
  const p = H.createPersonPrompt(ctx); p.start();
  const snap = (rows, fromCache = false) => ({ metadata: { fromCache }, forEach: (fn) => rows.forEach((v) => fn({ data: () => v })) });
  listener(snap([cfg()], true));
  assert.equal(asked.length, 0, 'サーバーで確かめる前は聞かない');
  listener(snap([cfg()]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 1);
  assert.match(asked[0][0], /挨拶やお薬などの記録が11時までに1つもない日は、太郎さんに「声をかけるきっかけ」のお知らせが届きます。よろしいですか/);
  assert.deepEqual(asked[0].slice(1), ['はい', 'やめておく']);
  assert.deepEqual(written.map((w) => [w.type, w.requestId, w.answer]), [['hitokoe-consent', 'r1', 'yes']]);
  listener(snap([cfg()]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 1, '同じお願いには2回聞かない');
  listener(snap([cfg({ enabled: false })]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 1, '切っているときは聞かない');
  // ご本人は、あとから「その他の設定」でやめられる
  listener(snap([cfg(), { type: 'hitokoe-consent', uid: 'hon', requestId: 'r1', answer: 'yes', clientAt: 1 }]));
  assert.deepEqual(p.status(), { enabled: true, hour: 11, line: false, answer: 'yes' });
  await p.answer(false);
  assert.deepEqual(written.at(-1).answer, 'no');
  // 「LINEにも送る」のお願いでは、LINEにも届くことを確認の文に書く
  listener(snap([cfg({ line: true, requestId: 'r3' })]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 2);
  assert.match(asked[1][0], /まいにこの画面と、LINEにも届きます（LINEには名前や様子は書きません）。よろしいですか/);
}
console.log('ひと声のきっかけ: 了解・時刻・操作の判定・担当・お休み・連絡しました・文面・夜中・設定画面・ご本人への確認 19項目 passed');
