import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

/* LINEで予定のお知らせ：設定画面(カード形式)の表示と、ボタンを押すだけのつなぎ方 */
const src = fs.readFileSync(new URL('../line-notify.js', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(fn, label) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); }
  assert.fail('timeout: ' + label);
}

function setup({ linked = false, failLink = false } = {}) {
  const dom = new JSDOM('<div id="area"></div><div id="settings-line-log"></div>', { url: 'https://pocham4173.github.io/hidamari/', runScripts: 'outside-only' });
  const c = dom.getInternalVMContext();
  const written = [];
  let snapCb = null;
  const linkDoc = { exists: linked, data: () => ({ groupId: 'g1', linkedAt: new Date('2026-10-01T01:00:00Z') }) };
  const members = [
    { id: 'mom', data: () => ({ name: 'お母さん', status: 'approved' }) },
    { id: 'me', data: () => ({ name: 'りえ', status: 'approved' }) },
    { id: 'bro', data: () => ({ name: '兄 <b>x</b>', status: 'approved' }) },
  ];
  const logs = [
    { uid: 'mom', action: 'linked', clientAt: 2 },
    { uid: 'bro', action: 'linked', clientAt: 1 },
    { uid: 'bro', action: 'unlinked', clientAt: 3 },
  ];
  const q = (rows) => ({ get: async () => ({ forEach: (f) => rows.forEach((r) => f({ id: r.id, data: () => (r.data ? r.data() : r) })) }) });
  Object.assign(c, {
    uid: () => 'me', gid: () => 'g1',
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' }, Timestamp: { fromMillis: (n) => new Date(n) } } },
    db: { collection: (name) => ({ doc: (id) => ({
      get: async () => { if (failLink) throw new Error('offline'); return name === 'lineLinks' ? linkDoc : { exists: false }; },
      set: async (v) => { written.push({ name, id, v }); },
      delete: async () => {},
      onSnapshot: (cb) => { snapCb = cb; return () => { snapCb = null; }; },
    }) }) },
    col: (name) => ({ where: (f, op, v) => q(name === 'members' ? members : logs.map((l) => ({ ...l, type: v }))) }),
  });
  Object.defineProperty(c, 'crypto', { configurable: true, value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i * 7; return a; } } });
  vm.runInContext(src, c);
  return { c, d: dom.window.document, written, fire: (v) => snapCb && snapCb(v), hasWatch: () => !!snapCb, linkDoc };
}

{ // まだつないでいない: 3枚のカード、家族の状態、ボタンを押すだけのつなぎ方
  const t = setup();
  await t.c.MainicoLine.render('area');
  const area = t.d.getElementById('area');
  const titles = [...area.querySelectorAll('.ln-card h4')].map((e) => e.textContent);
  assert.deepEqual(titles, ['自分のLINE', '家族のLINE', '家族に頼む']);
  assert.match(area.textContent, /まだつながっていません/);
  assert.ok(area.querySelector('a[href^="https://line.me/R/ti/p/"]'), '友だち追加');
  await waitFor(() => area.querySelectorAll('.ln-family li').length === 3, 'family');
  const rows = [...area.querySelectorAll('.ln-family li')].map((li) => li.textContent);
  assert.match(rows[0], /りえ（自分）まだ/, '自分が先頭・実際の連携状態');
  assert.ok(rows.some((r) => /お母さん✓ 受け取る/.test(r)), '記録で連携中');
  assert.ok(rows.some((r) => /兄 <b>x<\/b>まだ/.test(r)), '最後が解除なら「まだ」・名前は文字として表示');
  assert.equal(area.querySelector('.ln-family b'), null);
  assert.match(area.textContent, /今は 1人 に届きます/);
  const share = area.querySelector('a.ln-line[href^="https://line.me/R/share?text="]');
  assert.ok(share, '家族に頼む');
  assert.match(decodeURIComponent(share.href.split('text=')[1]), /https:\/\/pocham4173\.github\.io\/hidamari\//);
  assert.ok(t.hasWatch(), 'つなぐ途中は状態を見守る');
  // 「LINEとつなぐ」→ コードを作り、トークにコードを入れた状態で開くリンクを出す
  area.querySelector('[data-line-act="code"]').click();
  await waitFor(() => area.querySelector('[data-line-code] a'), 'code link');
  assert.equal(t.written.length, 1);
  const { name, id, v } = t.written[0];
  assert.equal(name, 'lineLinkCodes'); assert.match(id, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(v.uid, 'me'); assert.equal(v.groupId, 'g1');
  const open = area.querySelector('[data-line-code] a');
  assert.equal(open.textContent, 'LINEを開いて送る');
  assert.equal(open.getAttribute('href'), 'https://line.me/R/oaMessage/%40187mrwbk/?' + id);
  assert.equal(area.querySelector('[data-line-code] .code-show').textContent, id, '開けないとき用のコード');
  assert.equal(area.querySelector('[data-line-act="code"]').hidden, true);
  // LINEで送信 → 送信役が lineLinks を作る → 画面が自動で「登録済み」に変わる
  t.linkDoc.exists = true;
  t.fire({ exists: true, data: () => ({ groupId: 'g1' }) });
  await waitFor(() => /自分のLINEを登録済み/.test(area.textContent), 'linked');
  assert.ok(area.querySelector('[data-line-act="unlink"]'));
  assert.equal(t.hasWatch(), false, '登録済みになったら見守りをやめる');
}

{ // 別の家庭の連携は「登録済み」にしない
  const t = setup();
  await t.c.MainicoLine.render('area');
  t.fire({ exists: true, data: () => ({ groupId: 'other' }) });
  await tick();
  assert.match(t.d.getElementById('area').textContent, /まだつながっていません/);
}

{ // 登録済み
  const t = setup({ linked: true });
  await t.c.MainicoLine.render('area');
  const area = t.d.getElementById('area');
  assert.match(area.textContent, /✓ 自分のLINEを登録済み/);
  assert.match(area.querySelector('[data-line-act="unlink"]').textContent, /つなぐのをやめる/);
  await waitFor(() => area.querySelectorAll('.ln-family li').length === 3, 'family');
  assert.match(area.textContent, /今は 2人 に届きます/);
  assert.equal(t.hasWatch(), false);
}

{ // 通信できない
  const t = setup({ failLink: true });
  await t.c.MainicoLine.render('area');
  assert.match(t.d.getElementById('area').textContent, /確認できませんでした/);
  assert.ok(t.d.querySelector('[data-line-act="reload"]'));
}
console.log('LINEの設定画面: カード・家族の状態・ボタンでつなぐ・自動で登録済み・別の家庭・通信失敗 passed');
