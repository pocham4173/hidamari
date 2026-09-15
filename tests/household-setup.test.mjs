/* index.html の実関数で、連打・通信待ち・端末保存失敗からの再試行を検査する。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('let groupCreating=false;');
const end = html.indexOf('async function finishSetup(){', start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end);
const GROUP_JOURNAL = 'mainico_group_setup_v1';
const JOIN_JOURNAL = 'mainico_join_pending_v1';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup({ saved = {}, seed = {}, mode = 'konly' } = {}) {
  const values = new Map(Object.entries(saved));
  const records = new Map(Object.entries(seed));
  const elements = new Map();
  const alerts = [], reads = [], commits = [], storageWrites = [];
  const hooks = {};
  let generated = 0, finished = 0, pendingShown = 0, currentUid = 'owner';
  const el = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, checked: true });
    return elements.get(id);
  };
  function ref(path) {
    return {
      path, id: path.split('/').at(-1),
      collection: name => collection(path + '/' + name),
      get: async options => {
        assert.equal(options?.source, 'server');
        reads.push(path);
        if (hooks.beforeGet) await hooks.beforeGet(path);
        const value = records.get(path);
        return { exists: value !== undefined, data: () => value && { ...value } };
      },
    };
  }
  function collection(path) {
    return { doc: id => ref(path + '/' + (id === undefined ? 'generated-' + (++generated) : id)) };
  }
  const context = {
    document: { getElementById: el },
    pendingMode: mode,
    uid: () => currentUid,
    gid: () => values.get('mainicoGid') || null,
    myName: () => '家族の名前',
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TIME' } } },
    alert: text => alerts.push(text),
    finishSetup: async () => { finished++; },
    showPending: () => { pendingShown++; },
    previewStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => {
        storageWrites.push(key);
        if (hooks.beforeSet) hooks.beforeSet(key, value);
        values.set(key, value);
      },
      removeItem: key => {
        if (hooks.beforeRemove) hooks.beforeRemove(key);
        values.delete(key);
      },
    },
    db: {
      collection,
      batch: () => {
        const writes = [];
        return {
          set: (target, value) => writes.push({ kind: 'set', path: target.path, value: { ...value } }),
          update: (target, value) => writes.push({ kind: 'update', path: target.path, value: { ...value } }),
          commit: async () => {
            if (hooks.beforeCommit) await hooks.beforeCommit(writes);
            assert.ok(writes.every(op => op.kind === 'set' || records.has(op.path)), 'update target must exist');
            for (const op of writes) records.set(op.path, op.kind === 'set' ? op.value : { ...records.get(op.path), ...op.value });
            commits.push(writes);
            if (hooks.afterCommit) await hooks.afterCommit(writes);
          },
        };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    context, values, records, elements, el, hooks, alerts, reads, commits, storageWrites,
    setUid: uid => { currentUid = uid; },
    get generated() { return generated; },
    get finished() { return finished; },
    get pendingShown() { return pendingShown; },
  };
}
function inviteSeed() {
  return { 'invites/JNNN2222': { groupId: 'invited-home', used: false, expiresAt: { toMillis: () => Date.now() + 60000 } } };
}
function failGidOnce(env) {
  let failed = false;
  env.hooks.beforeSet = key => {
    if (key === 'mainicoGid' && !failed) { failed = true; throw new Error('storage quota'); }
  };
}

{
  const env = setup(), gate = deferred();
  env.hooks.beforeGet = () => gate.promise;
  const first = env.context.createGroup();
  await env.context.createGroup();
  assert.equal(env.generated, 1, '連打で新しいIDを追加発行しない');
  assert.equal(env.commits.length, 0);
  assert.equal(env.el('btn-newgroup').disabled, true);
  gate.resolve(); await first;
  assert.equal(env.commits.length, 1);
  assert.equal(env.commits[0].length, 3, 'group・member・pointerは一括書込');
  assert.equal(env.records.get('groups/generated-1/members/owner').status, 'approved');
  assert.equal(env.finished, 1);
  assert.equal(env.el('btn-newgroup').disabled, false);
  console.log('OK 作成の連打は1件だけ作成する');
}
{
  const env = setup(); failGidOnce(env);
  await env.context.createGroup();
  assert.equal(env.commits.length, 1);
  assert.equal(env.values.has('mainicoGid'), false);
  const journal = JSON.parse(env.values.get(GROUP_JOURNAL));
  assert.equal(journal.groupId, 'generated-1');
  assert.equal(env.finished, 0);
  assert.match(env.alerts.at(-1), /完了を確認できません/);
  env.context.pendingMode = 'honnin';
  await env.context.createGroup();
  assert.equal(env.generated, 1, '再試行で別groupを作らない');
  assert.equal(env.commits.length, 1, '既存groupの確認後は再送しない');
  assert.equal(env.values.get('mainicoGid'), journal.groupId);
  assert.equal(env.values.get('mainicoPendingMode'), 'konly', '作成時のmodeを保持');
  assert.equal(env.values.has(GROUP_JOURNAL), false);
  assert.equal(env.finished, 1);
  console.log('OK 作成成功後の端末保存失敗はjournalから同じ世帯へ復帰');
}
{
  const env = setup();
  env.hooks.beforeSet = key => { if (key === GROUP_JOURNAL) throw new Error('storage blocked'); };
  await env.context.createGroup();
  assert.equal(env.commits.length, 0);
  assert.equal(env.records.size, 0);
  assert.equal(env.reads.length, 0, '再開情報保存失敗ならサーバー処理へ進まない');
  assert.equal(env.el('btn-newgroup').disabled, false);
  console.log('OK journal保存不可ではサーバーを変更しない');
}
{
  const env = setup({ seed: inviteSeed() }); failGidOnce(env);
  env.el('in-code').value = 'jnnn2222';
  await env.context.joinByCode();
  assert.equal(env.commits.length, 1);
  assert.equal(env.commits[0].length, 2, 'pending memberと招待使用済み化は一括');
  assert.equal(env.records.get('invites/JNNN2222').usedBy, 'owner');
  assert.equal(env.records.get('groups/invited-home/members/owner').status, 'pending');
  assert.equal(env.values.has('mainicoGid'), false);
  assert.equal(env.values.has(JOIN_JOURNAL), true);
  assert.equal(env.pendingShown, 0);
  await env.context.joinByCode();
  assert.equal(env.commits.length, 1, '使用済み招待へ再申請しない');
  assert.ok(env.reads.includes('groups/invited-home/members/owner'), '自分の申請をサーバー確認');
  assert.equal(env.values.get('mainicoGid'), 'invited-home');
  assert.equal(env.values.has(JOIN_JOURNAL), false);
  assert.equal(env.pendingShown, 1);
  console.log('OK 招待成功後の保存失敗は同じコードの自分の申請を確認して復帰');
}
{
  const old = JSON.stringify({ uid: 'another-account', groupId: 'original-home', mode: 'kazoku', name: '別の登録' });
  const env = setup({ saved: { [GROUP_JOURNAL]: old } });
  await env.context.createGroup();
  assert.equal(env.generated, 0);
  assert.equal(env.commits.length, 0);
  assert.equal(env.reads.length, 0);
  assert.equal(env.values.get(GROUP_JOURNAL), old, '別UIDの再開情報を上書きしない');
  assert.match(env.alerts.at(-1), /別アカウント/);
  console.log('OK 別UIDのjournalがあれば新規作成を拒否し保存情報を維持');
}
{
  for (const firstName of ['createGroup', 'joinByCode']) {
    const env = setup({ seed: inviteSeed() }), gate = deferred();
    env.el('in-code').value = 'JNNN2222';
    env.hooks.beforeGet = () => gate.promise;
    const first = env.context[firstName]();
    await env.context[firstName === 'createGroup' ? 'joinByCode' : 'createGroup']();
    assert.equal(env.reads.length, 1, '作成と参加を同時に始めない');
    assert.equal(env.commits.length, 0);
    assert.equal(env.generated, firstName === 'createGroup' ? 1 : 0);
    gate.resolve(); await first;
    assert.equal(env.commits.length, 1);
    assert.equal(env.finished + env.pendingShown, 1);
  }
  console.log('OK 作成中の参加・参加中の作成をともに拒否');
}
{
  for (const method of ['createGroup', 'joinByCode']) {
    const env = setup({ seed: inviteSeed() }), gate = deferred();
    env.el('in-code').value = 'JNNN2222';
    env.hooks.beforeGet = () => gate.promise;
    const request = env.context[method]();
    env.setUid('changed-account'); gate.resolve(); await request;
    assert.equal(env.commits.length, 0, '通信待ち中の認証切替後は書き込まない');
    assert.equal(env.values.has('mainicoGid'), false);
    assert.match(env.alerts.at(-1), /アカウントが変わった/);

    const committed = setup({ seed: inviteSeed() });
    committed.el('in-code').value = 'JNNN2222';
    committed.hooks.afterCommit = () => committed.setUid('changed-account');
    await committed.context[method]();
    assert.equal(committed.commits.length, 1, '切替直前に成功した処理は1件だけ');
    assert.equal(committed.values.has('mainicoGid'), false, '別UIDの端末状態へ接続先を書き込まない');
    assert.equal(committed.finished + committed.pendingShown, 0);
    const key = method === 'createGroup' ? GROUP_JOURNAL : JOIN_JOURNAL;
    assert.equal(JSON.parse(committed.values.get(key)).uid, 'owner');
    committed.setUid('owner'); committed.hooks.afterCommit = null;
    await committed.context[method]();
    assert.equal(committed.commits.length, 1, '元のUIDへ戻っても処理を重複送信しない');
    assert.equal(committed.finished + committed.pendingShown, 1);
  }
  console.log('OK 通信中・書込成功直後のUID切替を検出し、元のUIDで重複なく再開');
}
{
  const env = setup();
  let failed = false;
  env.hooks.beforeSet = key => {
    if (key === 'mainicoName' && !failed) { failed = true; throw new Error('name storage quota'); }
  };
  await env.context.createGroup();
  assert.equal(env.commits.length, 1);
  assert.equal(env.finished, 0);
  assert.equal(env.values.has(GROUP_JOURNAL), true);
  await env.context.createGroup();
  assert.equal(env.commits.length, 1);
  assert.equal(env.generated, 1);
  assert.equal(env.finished, 1, '部分的な端末保存失敗後も再試行を閉ざさない');
  assert.equal(env.values.get('mainicoName'), '家族の名前');
  console.log('OK 名前などの部分的な端末保存失敗でも同じ世帯で再開');
}
{
  for (const method of ['createGroup', 'joinByCode']) {
    const env = setup({ seed: inviteSeed() });
    env.el('in-code').value = 'JNNN2222';
    const key = method === 'createGroup' ? GROUP_JOURNAL : JOIN_JOURNAL;
    env.hooks.beforeRemove = removeKey => { if (removeKey === key) throw new Error('cleanup blocked'); };
    await env.context[method]();
    assert.equal(env.commits.length, 1);
    assert.ok(env.values.get('mainicoGid'));
    assert.equal(env.finished + env.pendingShown, 1, '再開情報の後片付け失敗だけで完了画面への遷移を止めない');
    assert.equal(env.alerts.length, 0, '完了した操作を未完了と案内しない');
  }
  console.log('OK journal後片付けだけの失敗では正しく接続・承認待ちへ進む');
}
console.log('\n9組の初期設定・参加の失敗復旧検査が通過。');
