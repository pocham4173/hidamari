import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

/* LINEで予定のお知らせ：設定画面(ヒビルカと同じ形)・送信先の招待・予定ごとに知らせる人 */
const src = fs.readFileSync(new URL('../line-notify.js', import.meta.url), 'utf8');
const ts = (iso) => ({ toDate: () => new Date(iso), toMillis: () => Date.parse(iso) });
const plain = (x) => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(fn, label) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); }
  assert.fail('timeout: ' + label);
}

function setup({ linked = false, failLink = false, recipients = [], share = true, linkFriend, extraLogs = [], extraMembers = [] } = {}) {
  const dom = new JSDOM('<div id="area"></div><div id="settings-line-log"></div><div id="who"></div>', { url: 'https://pocham4173.github.io/hidamari/', runScripts: 'outside-only' });
  const c = dom.getInternalVMContext();
  const written = [], updated = [], deleted = [];
  let snapCb = null, recCb = null, autoId = 0;
  const linkDoc = { exists: linked, data: () => ({ groupId: 'g1', linkedAt: new Date('2026-10-01T01:00:00Z'), ...(linkFriend === undefined ? {} : { friend: linkFriend }) }) };
  const members = [
    { id: 'mom', data: () => ({ name: 'お母さん', status: 'approved' }) },
    { id: 'me', data: () => ({ name: 'りえ', status: 'approved' }) },
    { id: 'bro', data: () => ({ name: '兄 <b>x</b>', status: 'approved' }) },
    ...extraMembers.map((m) => ({ id: m.id, data: () => ({ name: m.name, status: 'approved' }) })),
  ];
  const logs = [
    { uid: 'mom', action: 'linked', clientAt: 2 },
    { uid: 'bro', action: 'linked', clientAt: 1 },
    { uid: 'bro', action: 'unlinked', clientAt: 3 },
    ...extraLogs,
  ];
  const recDocs = () => recipients.map((r) => ({ id: r.id, data: () => r }));
  const snapOf = (rows) => ({ forEach: (f) => rows.forEach(f) });
  const q = (rows) => ({ get: async () => snapOf(rows) });
  Object.assign(c, {
    uid: () => 'me', gid: () => 'g1', myName: () => 'りえ',
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' }, Timestamp: { fromMillis: (n) => new Date(n) } } },
    db: { collection: (name) => ({
      doc: (id) => {
        const docId = id || 'auto' + (++autoId);
        return {
          id: docId,
          get: async () => { if (failLink) throw new Error('offline'); return name === 'lineLinks' ? linkDoc : { exists: false }; },
          set: async (v) => { written.push({ name, id: docId, v }); },
          update: async (v) => { updated.push({ name, id: docId, v }); },
          delete: async () => { deleted.push({ name, id: docId }); },
          onSnapshot: (cb) => { snapCb = cb; return () => { snapCb = null; }; },
        };
      },
      where: (f, op, v) => ({
        get: async () => snapOf(recDocs()),
        onSnapshot: (cb) => { recCb = cb; cb(snapOf(recDocs())); return () => { recCb = null; }; },
      }),
    }) },
    col: (name) => ({
      where: (f, op, v) => q(name === 'members' ? members.map((m) => ({ id: m.id, data: m.data })) : logs.map((l) => ({ id: l.uid, data: () => ({ ...l, type: v }) }))),
      doc: (id) => ({
        get: async () => ({ exists: name === 'lineShareConsents' && share, data: () => ({ version: 'line-share-20261004', honninAgreed: true }) }),
        set: async (v) => { written.push({ name: 'group/' + name, id, v }); share = true; },
        delete: async () => { deleted.push({ name: 'group/' + name, id }); share = false; },
      }),
    }),
    prompt: () => '  ばあば  ',
    appConfirm: async () => true,
  });
  Object.defineProperty(c, 'crypto', { configurable: true, value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i * 7; return a; } } });
  Object.defineProperty(c.navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { c.__copied = t; } } });
  vm.runInContext(src, c);
  return { c, d: dom.window.document, written, updated, deleted, recipients, fire: (v) => snapCb && snapCb(v), hasWatch: () => !!snapCb, linkDoc, pushRecipients: () => recCb && recCb(snapOf(recDocs())) };
}

{ // まだ登録していない: 4枚のカード、送信先の一覧、ボタンを押すだけで自分のLINEを登録
  const t = setup({ recipients: [
    { id: 'r1', groupId: 'g1', name: 'おばあちゃん', status: 'joined', lineName: 'おばあ', createdAt: ts('2026-10-01T00:00:00Z'), joinedAt: ts('2026-10-02T00:00:00Z') },
    { id: 'r2', groupId: 'g1', name: 'おじ <i>y</i>', status: 'pending', createdAt: ts('2026-10-03T00:00:00Z') },
    { id: 'r3', groupId: 'g1', name: 'いとこ', status: 'stopped' },
  ] });
  await t.c.MainicoLine.render('area');
  const area = t.d.getElementById('area');
  const titles = [...area.querySelectorAll('.ln-card h4')].map((e) => e.textContent);
  assert.deepEqual(titles, ['自分のLINEを登録する', 'LINEの送信先を追加', 'LINEの送信先', '家族に頼む']);
  assert.match(area.textContent, /最初に1回、自分のLINEを登録してください/);
  await waitFor(() => area.querySelectorAll('.ln-family li').length === 6, 'list');
  const rows = [...area.querySelectorAll('.ln-family li')].map((li) => li.textContent);
  assert.match(rows[0], /^自分（りえ）LINE：まだつないでいません/, '自分が先頭・実際の連携状態');
  assert.ok(rows.some((r) => /お母さんLINE：つないであります（友だち追加は未確認）/.test(r)), '友だち追加を確かめていない人を「受け取れます」と言い切らない');
  assert.ok(!/受け取れます/.test(area.textContent), '「受け取れます」とは表示しない');
  assert.ok(rows.some((r) => /兄 <b>x<\/b>LINE：まだ/.test(r)), '名前は文字として表示');
  assert.ok(rows.some((r) => /おばあちゃんLINEの名前：おばあLINE：つないであります（友だち追加は未確認）招待の履歴/.test(r)));
  assert.ok(rows.some((r) => /おじ <i>y<\/i>LINE：まだ登録していません（招待の文を送ると登録されます）/.test(r)));
  assert.ok(rows.some((r) => /いとこLINE：受け取りを止めました/.test(r)));
  assert.equal(area.querySelector('.ln-family b i'), null);
  assert.deepEqual([...area.querySelectorAll('.ln-group-title')].map((e) => e.textContent), ['まいにこアプリを使っている家族', 'アプリを使わず、LINEだけで受け取る人'], '2つに分けて見せる');
  assert.match(area.textContent, /LINEをつないだ人：合わせて2人（うち2人は友だち追加を確認できていません）/);
  assert.match(area.textContent, /相手のスマホに届いたか・読んだかまでは分かりません/, '送信と到着・既読を区別する');
  // 再送は承認待ちの人だけ
  assert.deepEqual([...area.querySelectorAll('[data-rec-act="resend"]')].map((b) => b.getAttribute('data-rid')), ['r2']);
  assert.ok(t.hasWatch(), '登録の途中は状態を見守る');
  // 「自分のLINEを登録する」→ トークにコードを入れて開く
  area.querySelector('[data-line-act="code"]').click();
  await waitFor(() => area.querySelector('[data-line-code] a'), 'code link');
  const code = t.written.find((w) => w.name === 'lineLinkCodes');
  assert.match(code.id, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(area.querySelector('[data-line-code] a').getAttribute('href'), 'https://line.me/R/oaMessage/%40187mrwbk/?' + code.id);
  // LINEで送信 → 自動で登録済み
  t.linkDoc.exists = true;
  t.fire({ exists: true, data: () => ({ groupId: 'g1' }) });
  await waitFor(() => /LINEは登録済みです。友だち追加は確認できていません/.test(area.textContent), 'linked');
  assert.ok(area.querySelector('[data-line-act="unlink"]'));
}

{ // 友だち追加の確認結果で表示を分ける(2026-10-09 審査の指摘)
  const t = setup({ linked: true, linkFriend: false,
    extraMembers: [{ id: 'sis', name: '妹' }, { id: 'dad', name: '父' }],
    extraLogs: [
      { uid: 'mom', action: 'friend', via: 'follow', friend: true, clientAt: 4 },   // 連携のあとで友だち追加を確認
      { uid: 'sis', action: 'linked', friend: false, clientAt: 5 },
      { uid: 'dad', action: 'linked', friend: true, clientAt: 6 },
    ],
    recipients: [
      { id: 'r1', groupId: 'g1', name: 'ヘルパー', status: 'joined', friend: false },
      { id: 'r2', groupId: 'g1', name: 'おば', status: 'joined', friend: true },
    ] });
  await t.c.MainicoLine.render('area');
  const area = t.d.getElementById('area');
  assert.match(area.textContent, /⚠ LINEは登録済みですが、まいにこの友だち追加が確認できていません/, '自分: 友だち追加なし');
  assert.ok(area.querySelector('[data-line-act="reload"]'), '友だち追加のあと確かめ直せる');
  await waitFor(() => area.querySelectorAll('.ln-family li').length === 7, 'list');
  const rows = [...area.querySelectorAll('.ln-family li')].map((li) => li.textContent);
  assert.match(rows[0], /^自分（りえ）LINE：⚠ 友だち追加が必要です/);
  assert.ok(rows.some((r) => /お母さんLINE：✓ つないであります（友だち追加 確認済み）/.test(r)), '後からの友だち追加の確認を反映');
  assert.ok(rows.some((r) => /妹LINE：⚠ 友だち追加が必要です（このままでは届きません）/.test(r)));
  assert.ok(rows.some((r) => /父LINE：✓ つないであります（友だち追加 確認済み）/.test(r)));
  assert.ok(rows.some((r) => /ヘルパーLINE：⚠ 友だち追加が必要です/.test(r)));
  assert.ok(rows.some((r) => /おばLINE：✓ つないであります（友だち追加 確認済み）/.test(r)));
  assert.match(area.textContent, /LINEをつないだ人：合わせて6人（うち3人は友だち追加を確認できていません）/);
  assert.ok(!/受け取れます/.test(area.textContent));
}
{ // 自分: 友だち追加も確認済み
  const t = setup({ linked: true, linkFriend: true });
  await t.c.MainicoLine.render('area');
  const area = t.d.getElementById('area');
  assert.match(area.textContent, /✓ 自分のLINEを登録済み（友だち追加も確認済み）/);
  assert.equal(area.querySelector('[data-line-act="reload"]'), null);
}
{ // 連携の記録: 友だち追加の確認も残り、「つないでいる人」の数には入れない
  const t = setup({ extraLogs: [{ uid: 'mom', name: 'お母さん', action: 'friend', via: 'follow', friend: true, clientAt: 4 }] });
  await t.c.MainicoLine.renderLog('settings-line-log');
  const box = t.d.getElementById('settings-line-log');
  assert.match(box.textContent, /記録上、LINEをつないでいる人：/);
  assert.match(box.textContent, /👋 友だち追加を確認しました（公式LINEを友だち追加して）/);
  assert.match(box.textContent, /つないでいる人：家族さん1/, '友だち追加の確認の記録で、つないでいる人が増えたり減ったりしない');
}
{ // 送信の記録: 送信済みを「届いた・読んだ」と同じに扱わない
  const t = setup();
  const log = t.c.MainicoLine.sendLog({ notifyLog: [{ status: 'accepted', at: ts('2026-10-09T00:00:00Z'), count: 2 }] });
  assert.match(log[0].text, /LINEへ送信済み（2人）（届いたか・読んだかは分かりません）/);
}

{ // 送信先を追加: 名前を入れて招待リンクを作る → 承認待ちの送信先と7日間の招待コード
  const t = setup();
  await t.c.MainicoLine.render('area');
  const area = t.d.getElementById('area');
  area.querySelector('[data-line-act="invite"]').click();
  await tick();
  assert.match(area.querySelector('[data-line-invite]').textContent, /名前を入れてください/);
  area.querySelector('[data-line-invite-name]').value = ' お母さん ';
  area.querySelector('[data-line-act="invite"]').click();
  await waitFor(() => area.querySelector('[data-line-invite] .ln-share'), 'invite');
  const rec = t.written.find((w) => w.name === 'lineRecipients');
  assert.deepEqual({ ...rec.v, createdAt: 'ts' }, { groupId: 'g1', name: 'お母さん', status: 'pending', createdBy: 'me', createdAt: 'ts' });
  const inv = t.written.find((w) => w.name === 'lineInvites');
  assert.match(inv.id, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.equal(inv.v.recipientId, rec.id); assert.equal(inv.v.groupId, 'g1'); assert.equal(inv.v.createdBy, 'me');
  assert.ok(inv.v.expiresAt.getTime() - Date.now() <= 7 * 86400000 && inv.v.expiresAt.getTime() - Date.now() > 6 * 86400000, '7日間');
  const box = area.querySelector('[data-line-invite]');
  assert.match(box.textContent, /お母さんさんへの招待リンクができました/);
  const share = decodeURIComponent(box.querySelector('a.ln-line').getAttribute('href').split('text=')[1]);
  assert.match(share, /りえさんから、まいにこの予定のお知らせの招待が届きました/);
  assert.ok(share.includes('https://line.me/R/oaMessage/%40187mrwbk/?' + encodeURIComponent('まいにこ招待 ' + inv.id)), '開くとトークに招待の文が入る');
  box.querySelector('[data-copy]').click();
  await waitFor(() => t.c.__copied, 'copied');
  assert.equal(t.c.__copied, share);
  assert.equal(area.querySelector('[data-line-invite-name]').value, '', '入力欄は空に戻る');
}

{ // 名前変更・招待の再送・削除
  const t = setup({ recipients: [{ id: 'r2', groupId: 'g1', name: 'おじ', status: 'pending' }] });
  await t.c.MainicoLine.render('area');
  const area = t.d.getElementById('area');
  await waitFor(() => area.querySelector('[data-rec-act]'), 'rows');
  area.querySelector('[data-rec-act="rename"]').click();
  await waitFor(() => t.updated.length, 'rename');
  assert.deepEqual(plain(t.updated[0]), { name: 'lineRecipients', id: 'r2', v: { name: 'ばあば' } });
  area.querySelector('[data-rec-act="resend"]').click();
  await waitFor(() => area.querySelector('[data-rec-box="r2"] .ln-share'), 'resend');
  assert.equal(t.written.filter((w) => w.name === 'lineInvites').at(-1).v.recipientId, 'r2');
  area.querySelector('[data-rec-act="delete"]').click();
  await waitFor(() => t.deleted.length, 'delete');
  assert.deepEqual(plain(t.deleted[0]), { name: 'lineRecipients', id: 'r2' });
}

{ // 予定ごとに知らせる人: 既定は家族全員(null)。招待した人(登録済みだけ)を選ぶと配列になる
  const t = setup({ recipients: [
    { id: 'r1', groupId: 'g1', name: 'おばあちゃん', status: 'joined' },
    { id: 'r2', groupId: 'g1', name: '承認待ち', status: 'pending' },
  ] });
  const W = t.c.MainicoLine;
  assert.equal(W.readWho('who'), undefined, '読み込む前は値を変えない');
  await W.renderWho('who', null);
  const chips = () => [...t.d.querySelectorAll('#who .ln-chip')].map((b) => b.textContent);
  assert.deepEqual(chips(), ['✓ 自分', '✓ お母さん', '✓ 兄 <b>x</b>', 'おばあちゃん'], '承認待ちの人は出ない');
  assert.equal(W.readWho('who'), null, '家族全員=今までどおり');
  t.d.querySelector('#who .ln-chip.ext').click();
  assert.deepEqual(plain(W.readWho('who')), ['u:me', 'u:mom', 'u:bro', 'r:r1']);
  t.d.querySelectorAll('#who .ln-chip')[1].click();
  assert.deepEqual(plain(W.readWho('who')), ['u:me', 'u:bro', 'r:r1']);
  // 保存済みの選び方を開き直す
  await W.renderWho('who', ['r:r1', 'r:gone']);
  assert.deepEqual(chips(), ['自分', 'お母さん', '兄 <b>x</b>', '✓ おばあちゃん']);
  assert.deepEqual(plain(W.readWho('who')), ['r:r1'], '消えた送信先は保存し直さない');
}

{ // 同意していない家族: 送信先の追加の前に、同意の画面を出す。チェック2つで同意を記録して使い始める
  const t = setup({ share: false, recipients: [{ id: 'r1', groupId: 'g1', name: 'ヘルパーさん', status: 'joined' }] });
  await t.c.MainicoLine.render('area');
  const area = t.d.getElementById('area');
  assert.equal(area.querySelector('[data-line-act="invite"]'), null, '同意の前は招待を作れない');
  assert.match(area.textContent, /使う前に、確認してください/);
  assert.match(area.textContent, /服薬・体調の記録、伝言、おまもりタグのお知らせは送りません/);
  area.querySelector('[data-line-act="share-consent"]').click();
  await tick();
  assert.match(area.textContent, /2つのチェックを入れてください/);
  assert.equal(t.written.length, 0);
  area.querySelector('[data-share-ok]').checked = true;
  area.querySelector('[data-share-honnin]').checked = true;
  area.querySelector('[data-line-act="share-consent"]').click();
  await waitFor(() => area.querySelector('[data-line-act="invite"]'), 'consented');
  const rec = t.written.find((w) => w.name === 'group/lineShareConsents');
  assert.equal(rec.id, 'me'); assert.equal(rec.v.version, 'line-share-20261004'); assert.equal(rec.v.honninAgreed, true); assert.equal(rec.v.acceptedAt, 'ts');
  // 同意をやめる
  area.querySelector('[data-line-act="share-withdraw"]').click();
  await waitFor(() => area.querySelector('[data-line-act="share-consent"]'), 'withdrawn');
  assert.deepEqual(plain(t.deleted.at(-1)), { name: 'group/lineShareConsents', id: 'me' });
  // 同意していないと、予定の「知らせる人」に招待した人は出ない
  await t.c.MainicoLine.renderWho('who', ['r:r1']);
  assert.deepEqual([...t.d.querySelectorAll('#who .ln-chip')].map((b) => b.textContent), ['自分', 'お母さん', '兄 <b>x</b>']);
  assert.deepEqual(plain(t.c.MainicoLine.readWho('who')), [], '同意をやめた人の予定には、招待した人を残さない');
}

{ // 通信できない
  const t = setup({ failLink: true });
  await t.c.MainicoLine.render('area');
  assert.match(t.d.getElementById('area').textContent, /確認できませんでした/);
  assert.ok(t.d.querySelector('[data-line-act="reload"]'));
}
console.log('LINEの設定画面: 4枚のカード・送信先の一覧・ボタンで登録・招待リンク・名前変更/再送/削除・予定ごとに知らせる人・送る前の同意・通信失敗 passed');

{ // 予定の説明: 送る時刻を20分すぎても送れていなければ「まだ送れていません」(2026-10-09)
  const t = setup();
  const W = t.c.MainicoLine;
  const at = (ms) => ({ toDate: () => new Date(Date.now() + ms) });
  assert.match(W.describe({ notifyAt: at(3600000) }), /^🔔 LINEで知らせる：/);
  assert.match(W.describe({ notifyAt: at(-10 * 60000) }), /^🔔 LINEで知らせる：/, '見回り(15分ごと)の前は、まだ予定どおり');
  assert.match(W.describe({ notifyAt: at(-35 * 60000) }), /^⚠ LINEのお知らせ（.+）が、まだ送れていません$/);
  assert.equal(W.overdue({ notifyAt: at(-35 * 60000) }), true);
  assert.equal(W.overdue({ notifyAt: at(-10 * 60000) }), false);
  assert.equal(W.overdue({ notifyAt: null, notificationStatus: 'expired' }), false, '期限切れ・上限・送信済みは「まだ送れていません」にしない');
  assert.match(W.describe({ notifyAt: null, notificationStatus: 'limited' }), /上限/);
  assert.match(W.describe({ notifyAt: null, notificationStatus: 'expired' }), /期限が過ぎました/);
  assert.match(W.describe({ notifyAt: null, notificationStatus: 'accepted', notifiedAt: at(-60000) }), /送信済み/);
  // 送信履歴の一覧も同じ判断を使う(送る時刻を過ぎたものを「送ります」と書かない・上限を「期限切れ」と書かない)
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const hist = html.slice(html.indexOf('function renderLineHistory'), html.indexOf('async function copyStagingNotifyLink'));
  assert.match(hist, /MainicoLine\.overdue/);
  assert.match(hist, /まだ送れていません/);
  assert.match(hist, /notificationStatus==='limited'/);
  console.log('LINEの予定の説明: 送れていないときの表示 passed');
}
