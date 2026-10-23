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
// 日本時間で指定する(2026-10-18: 判定は端末の時間帯ではなく日本時間)
const now = (h, m = 0) => new Date(Date.UTC(2026, 9, 5, h - 9, m));
const cfg = (extra) => ({ type: 'hitokoe-config', enabled: true, hour: 11, requestId: 'r1', uid: 'ani', name: '太郎', at: at(now(8)), ...extra });
// 了解・受け取りの了承は前の日(了解した日・了承した日は出さないため)
const prev = (h, m = 0) => new Date(Date.UTC(2026, 9, 4, h - 9, m));
const yes = { type: 'hitokoe-consent', uid: 'hon', requestId: 'r1', answer: 'yes', version: H.CONSENT_VERSION, at: at(prev(8, 30)) };
const recv = (uid, extra) => ({ type: 'hitokoe-receive', uid, answer: 'yes', line: false, at: at(prev(9)), ...extra });
const receiveRows = [recv('ani'), recv('imo')];
const run = (o) => H.evaluate({ configRows: [cfg()], consentRows: [yes], receiveRows, todayRows: [], members, now: now(12), day, ...o })[0];

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
assert.equal(H.evaluate({ configRows: [cfg()], consentRows: [yes], todayRows: [], members, receiveRows, now: new Date(Date.UTC(2026, 9, 5, 16)), day })[0].state, 'before-time');
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
  assert.deepEqual(written.map((w) => [w.type, w.requestId, w.answer, w.version]), [['hitokoe-consent', 'r1', 'yes', H.CONSENT_VERSION]]);
  listener(snap([cfg()]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 1, '同じお願いには2回聞かない');
  listener(snap([cfg({ enabled: false })]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 1, '切っているときは聞かない');
  // ご本人は、あとから「その他の設定」でやめられる
  listener(snap([cfg(), { type: 'hitokoe-consent', uid: 'hon', requestId: 'r1', answer: 'yes', version: H.CONSENT_VERSION, clientAt: 1 }]));
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

/* ===== 2026-10-18 安全性の見直し(架空データのみ) ===== */
// 20. 受け取る家族本人の了承がなければ、その人には出さない。届け先に選ばれた・設定した人というだけでは了承とみなさない
assert.equal(run({ receiveRows: [] }).state, 'no-receiver');
assert.equal(H.cardHtml([run({ receiveRows: [] })], 'ani'), '', '了承していない人にカードを出さない');
assert.equal(run({ receiveRows: [recv('ani'), recv('ani', { answer: 'no', at: at(prev(10)) })] }).state, 'no-receiver', '受け取らないに変えた');
assert.equal(run({ configRows: [cfg({ assignees: { 1: 'imo' } })], receiveRows: [recv('ani')] }).assignee, 'ani', '届け先が了承していなければ、了承済みの設定した人へ');
// 21. ご本人の「やめておく」は、家族が新しくお願いしても解除されない
const no1 = { ...yes, answer: 'no', at: at(prev(10)) };
assert.equal(run({ consentRows: [yes, no1], configRows: [cfg({ requestId: 'r2' })] }).state, 'declined', '本人の継続停止');
assert.equal(run({ consentRows: [yes, no1, { ...yes, requestId: 'r2', at: at(prev(11)) }], configRows: [cfg({ requestId: 'r2' })] }).state, 'show', '本人が自分で戻せば動く');
// 22. 了解した日・受け取りを了承した日(利用開始日)は出さない
assert.equal(run({ consentRows: [{ ...yes, at: at(now(8, 30)) }] }).state, 'start-day');
assert.equal(run({ receiveRows: [recv('ani', { at: at(now(9)) })] }).state, 'start-day');
// 23. 設定・了解・記録をサーバーで確かめられていないときは「判定できない」。カードは出さない
r = H.evaluate({ configRows: [cfg()], consentRows: [yes], receiveRows, todayRows: [], members, now: now(12), day, ready: false })[0];
assert.equal(r.state, 'unknown'); assert.equal(H.cardHtml([r], 'ani'), '');
// 24. 端末の時間帯がずれていても日本時間で判定する(日本時間10:59は時刻前、11:00は時刻後)
assert.equal(run({ now: new Date(Date.UTC(2026, 9, 5, 1, 59)) }).state, 'before-time');
assert.equal(run({ now: new Date(Date.UTC(2026, 9, 5, 2, 0)) }).state, 'show');
// 25. LINEへの送信の記録は「受け付け」「結果不明」などと書き、届いた・読まれた・対応したとは書かない
html = H.cardHtml([run({ todayRows: [{ type: 'hitokoe-sent', target: 'ani', status: 'accepted', date: day }] })], 'imo');
assert.match(html, /太郎さんのLINEへ送る手続きが受け付けられました（届いたか・読まれたかは分かりません）/);
html = H.cardHtml([run({ todayRows: [{ type: 'hitokoe-sent', target: 'ani', status: 'unknown', date: day }] })], 'ani');
assert.match(html, /あなたへのLINEは、送信の結果が分かりませんでした/);
assert.ok(!/届きました|既読|読まれました|対応しました/.test(html));
assert.equal(run({ todayRows: [{ type: 'hitokoe-sent', target: 'ani', status: 'accepted', date: day, uid: '' }] }).state, 'show', '送信の記録は本人の操作に数えない');
// 26. 表記: 「担当」「当番です」を使わず、対応は任意と書く。お休みには再開日を出す
const set2 = H.settingsHtml(H.latestConfig([cfg({ pauses: [{ from: '2026-10-10', to: '2026-10-12' }] })]), members, [run()], receiveRows, 'ani', true);
assert.ok(!/担当/.test(set2), '担当という言葉を使わない');
assert.match(set2, /届け先は当番ではありません。対応・返事・報告は任意です。/);
assert.match(set2, /10月13日から再開/);
assert.match(set2, /あなたの受け取り/);
assert.match(set2, /受け取る家族の了承：太郎さん＝受け取る（アプリの中だけ）/);
html = H.cardHtml([run()], 'ani');
assert.match(html, /連絡しました（任意）/); assert.match(html, /押さなくても大丈夫です/);

// 27. 家族の画面: 設定・了解とその日の記録の両方をサーバーで確かめるまでカードを出さない。読み込み失敗でも出さない
{
  const box = { innerHTML: '', querySelectorAll: () => [] };
  const document = { getElementById: (id) => (id === 'card' ? box : null), querySelector: () => null };
  const L = {};
  const written = [], confirms = [], storage = new Map();
  const ctl = H.create({
    document, col: () => ({ where: (f) => ({ onSnapshot: (opts, ok, err) => { L[f] = { ok, err, opts }; return () => {}; } }) }),
    addEvent: async (d) => { written.push(d); }, uid: () => 'ani', myName: () => '太郎', members: () => members, day: () => day,
    confirm: async (t, l) => { confirms.push([t, l]); return true; },
    storage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    cardId: 'card', settingsId: 'set',
  });
  const RD = Date; const t = now(12).getTime();
  class FD extends RD { constructor(...a) { if (a.length) super(...a); else super(t); } static now() { return t; } }
  globalThis.Date = FD;
  try {
    ctl.start();
    assert.equal(L.type.opts.includeMetadataChanges, true, '控えからサーバーへの確定を待つ');
    const snap = (rows, meta = {}) => ({ metadata: meta, forEach: (fn) => rows.forEach((v) => fn({ data: () => v })) });
    L.type.ok(snap([cfg(), yes, ...receiveRows]));
    assert.equal(box.innerHTML, '', 'その日の記録をまだ確かめていない');
    L.date.ok(snap([], { fromCache: true }));
    assert.equal(box.innerHTML, '', '端末の控えだけでは出さない');
    L.date.ok(snap([], { hasPendingWrites: true }));
    assert.equal(box.innerHTML, '', '書き込み途中の一覧では出さない');
    L.date.ok(snap([]));
    assert.match(box.innerHTML, /ひと声のきっかけ/, '両方を確かめたら出す');
    L.date.err(new Error('permission-denied'));
    assert.equal(box.innerHTML, '', '読み込みに失敗したら出さない(記録なしと扱わない)');
  } finally { globalThis.Date = RD; ctl.stop(); }
}
// 28. 受け取りに関わる家族には1回だけ「受け取りますか」と聞く。対応は任意と書く。「受け取らない」と答えた人には聞き直さない
{
  const mk = (answer) => {
    const L = {}, written = [], confirms = [], storage = new Map();
    const ctl = H.create({
      document: { getElementById: () => null, querySelector: () => null },
      col: () => ({ where: (f) => ({ onSnapshot: (opts, ok) => { L[f] = ok; return () => {}; } }) }),
      addEvent: async (d) => { written.push(d); }, uid: () => 'ani', myName: () => '太郎', members: () => members, day: () => day,
      confirm: async (t, l) => { confirms.push([t, l]); return answer; },
      storage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
      cardId: 'card', settingsId: 'set',
    });
    ctl.start();
    return { L, written, confirms, ctl };
  };
  const snap = (rows) => ({ metadata: {}, forEach: (fn) => rows.forEach((v) => fn({ data: () => v })) });
  let t = mk(true);
  t.L.type(snap([cfg({ line: true })]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.confirms.length, 1);
  assert.match(t.confirms[0][0], /当番ではありません。対応・返事・報告は任意です。/);
  assert.match(t.confirms[0][0], /LINEにも届きます/);
  assert.deepEqual(t.written.map((w) => [w.type, w.answer, w.line]), [['hitokoe-receive', 'yes', true]]);
  t.L.type(snap([cfg({ line: true })]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.confirms.length, 1, '同じお願いには2回聞かない');
  t.ctl.stop();
  t = mk(false);
  t.L.type(snap([cfg(), recv('ani', { answer: 'no' })]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.confirms.length, 0, '受け取らないと答えた人には聞かない');
  t.ctl.stop();
  t = mk(true);
  t.L.type(snap([cfg({ uid: 'imo' })]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.confirms.length, 0, '設定した人でも届け先でもない家族には聞かない');
  t.ctl.stop();
}
// 29. ご本人が「やめておく」を選んだあとは、家族が新しくお願いしても確認を出さない
{
  const asked = [];
  let listener;
  const p = H.createPersonPrompt({
    col: () => ({ where: () => ({ onSnapshot: (ok) => { listener = ok; return () => {}; } }) }),
    addEvent: async () => {}, uid: () => 'hon', members: () => members, day: () => day,
    storage: { getItem: () => null, setItem() {}, removeItem() {} }, speak() {}, ask: async (t) => { asked.push(t); return true; },
  });
  p.start();
  const snap = (rows) => ({ metadata: { fromCache: false }, forEach: (fn) => rows.forEach((v) => fn({ data: () => v })) });
  listener(snap([cfg({ requestId: 'r2' }), no1]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 0, '止めたご本人には聞き直さない');
  assert.equal(p.status().answer, 'no', 'その他の設定では「止めている」と出る');
}
// 30. 説明の版が古い「はい」では動かず、ご本人にもう一度聞く(既存の利用者も再同意まで有効にしない)
assert.equal(run({ consentRows: [{ ...yes, version: undefined }] }).state, 'waiting-consent', '古い説明への了解');
{
  const asked = [];
  let listener;
  const p = H.createPersonPrompt({
    col: () => ({ where: () => ({ onSnapshot: (ok) => { listener = ok; return () => {}; } }) }),
    addEvent: async () => {}, uid: () => 'hon', members: () => members, day: () => day,
    storage: { getItem: () => null, setItem() {}, removeItem() {} }, speak() {}, ask: async (t) => { asked.push(t); return true; },
  });
  p.start();
  listener({ metadata: { fromCache: false }, forEach: (fn) => [cfg(), { ...yes, version: undefined }].forEach((v) => fn({ data: () => v })) });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 1, '古い説明に「はい」と答えた人にも、新しい説明でもう一度聞く');
}
console.log('ひと声のきっかけ 2026-10-18 見直し: 受信の了承・本人の継続停止・利用開始日・判定できない状態・日本時間・送信の記録・表記・確定前は出さない・受け取りの確認・説明の版 11項目 passed');
