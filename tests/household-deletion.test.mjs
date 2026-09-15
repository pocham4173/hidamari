import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = { window: {}, setTimeout, clearTimeout };
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../household-deletion.js', import.meta.url), 'utf8'), context);
const { create, CONFIRMATION, CHECKPOINT_KEY } = context.window.MainicoDeletion;

function storageMock() {
  const values = new Map();
  return {
    values,
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
}

// In-memory Firestore adapter: queries use the live server data, commits are atomic,
// and read/commit hooks can fail before application or after a lost acknowledgement.
function firestoreMock(seed) {
  const data = new Map(Object.entries(seed).map(([path, value]) => [path, structuredClone(value)]));
  const log = [];
  const hooks = {};
  let cache = false;
  function documentSnapshot(ref) {
    const value = data.get(ref.path);
    return { id: ref.id, ref, exists: value !== undefined, data: () => structuredClone(value), metadata: { fromCache: cache, hasPendingWrites: false } };
  }
  class Ref {
    constructor(path) { this.path = path; this.id = path.split('/').at(-1); }
    collection(name) { return new Query(this.path + '/' + name); }
    async get(options) {
      assert.equal(options?.source, 'server', 'all non-transaction reads must request the server');
      log.push({ kind: 'read', path: this.path });
      await hooks.beforeRead?.(this.path, false);
      return documentSnapshot(this);
    }
  }
  class Query {
    constructor(path, filters = [], maximum = Infinity) { Object.assign(this, { path, filters, maximum }); }
    doc(id) { return new Ref(this.path + '/' + id); }
    where(field, op, value) { assert.equal(op, '=='); return new Query(this.path, [...this.filters, [field, value]], this.maximum); }
    limit(maximum) { return new Query(this.path, this.filters, maximum); }
    async get(options) {
      assert.equal(options?.source, 'server');
      log.push({ kind: 'query', path: this.path, limit: this.maximum });
      await hooks.beforeRead?.(this.path, true);
      const docs = [...data.keys()].sort().filter(path => {
        if (!path.startsWith(this.path + '/') || path.slice(this.path.length + 1).includes('/')) return false;
        return this.filters.every(([key, value]) => data.get(path)[key] === value);
      }).slice(0, this.maximum).map(path => documentSnapshot(new Ref(path)));
      return { docs, empty: !docs.length, metadata: { fromCache: cache, hasPendingWrites: false } };
    }
  }
  async function commit(operations) {
    if (!operations.length) return;
    await hooks.beforeCommit?.(operations);
    for (const op of operations) {
      if (op.kind === 'update') assert.ok(data.has(op.path), 'cannot update a missing document');
    }
    for (const op of operations) {
      if (op.kind === 'delete') data.delete(op.path);
      else data.set(op.path, { ...data.get(op.path), ...op.value });
    }
    log.push({ kind: 'commit', operations: structuredClone(operations) });
    await hooks.afterCommit?.(operations);
  }
  function writer(operations) {
    return {
      delete: ref => operations.push({ kind: 'delete', path: ref.path }),
      update: (ref, value) => operations.push({ kind: 'update', path: ref.path, value }),
      commit: () => commit(operations)
    };
  }
  const db = {
    collection: path => new Query(path),
    batch: () => writer([]),
    runTransaction: async action => {
      const operations = [];
      await action({ ...writer(operations), get: async ref => {
        log.push({ kind: 'transaction-read', path: ref.path });
        await hooks.beforeRead?.(ref.path, false);
        return documentSnapshot(ref);
      } });
      await commit(operations);
    }
  };
  return { db, data, log, hooks, setCache: value => { cache = value; } };
}

function seed() {
  const records = {
    'groups/family': { createdBy: 'owner' },
    'groups/family/settings/watchTag': { watchTagId: 'tag-a' },
    'groups/family/members/owner': { status: 'approved' },
    'groups/family/members/person': { status: 'approved' },
    'groups/family/members/family': { status: 'approved' },
    'watchTags/tag-a': { groupId: 'family', active: true },
    'watchTags/tag-b': { groupId: 'family', active: false },
    'accounts/owner': { groupId: 'family' },
    'groups/unrelated': { createdBy: 'someone-else' },
    'groups/unrelated/events/event': { text: 'keep' },
    'watchTags/unrelated': { groupId: 'unrelated' },
    'watchTags/unrelated/alerts/alert': { count: 1 },
    'invites/unrelated': { groupId: 'unrelated' },
    'accounts/unrelated': { groupId: 'unrelated' }
  };
  for (let i = 0; i < 7; i++) records['groups/family/events/event-' + i] = { uid: i % 2 ? 'person' : 'owner' };
  for (let i = 0; i < 3; i++) {
    records['groups/family/yotei/plan-' + i] = { uid: 'person' };
    records['invites/invite-' + i] = { groupId: 'family' };
  }
  for (let i = 0; i < 5; i++) records['watchTags/tag-a/alerts/finder-' + i] = { count: 1 };
  for (let i = 0; i < 2; i++) records['watchTags/tag-b/alerts/finder-' + i] = { count: 1 };
  for (let i = 0; i < 4; i++) records['accounts/member-' + i] = { groupId: 'family' };
  return records;
}
function setup(records = seed(), extra = {}) {
  const server = firestoreMock(records);
  const storage = storageMock();
  const auth = { currentUser: { uid: 'owner' } };
  const progress = [];
  const options = { db: server.db, storage, auth, pageSize: 2, serverTimestamp: () => 'SERVER_TIME', isOnline: () => true, onProgress: state => progress.push(state), ...extra };
  return { ...server, storage, auth, progress, options, service: create(options) };
}
const run = service => service.run({ groupId: 'family', confirmation: CONFIRMATION });
const commits = env => env.log.filter(item => item.kind === 'commit');
const hasFamilyData = env => [...env.data].some(([path, value]) => path === 'groups/family' || path.startsWith('groups/family/') || value.groupId === 'family' || path.startsWith('watchTags/tag-a/') || path.startsWith('watchTags/tag-b/'));

{
  const env = setup();
  const unrelated = [...env.data].filter(([path, value]) => path.includes('unrelated') || value.groupId === 'unrelated');
  const result = await run(env.service);
  assert.equal(result.status, 'complete');
  assert.equal(result.localCheckpointCleared, true);
  assert.equal(hasFamilyData(env), false);
  assert.deepEqual([...env.data], unrelated);
  assert.equal(env.service.getPending(), null);
  const writes = commits(env);
  assert.equal(writes[0].operations[0].kind, 'update');
  assert.equal(writes[0].operations[0].value.deletionState, 'deleting');
  assert.ok(writes.length > 10, 'multiple limited batches are used');
  assert.ok(writes.every(write => write.operations.length <= 2));
  const last = writes.at(-1).operations;
  assert.deepEqual(last.map(op => op.path), ['accounts/owner', 'groups/family']);
  for (const tag of ['tag-a', 'tag-b']) {
    const tagCommit = writes.findIndex(write => write.operations.some(op => op.path === 'watchTags/' + tag));
    const alertCommits = writes.map((write, index) => write.operations.some(op => op.path.startsWith('watchTags/' + tag + '/alerts/')) ? index : -1).filter(index => index >= 0);
    assert.ok(alertCommits.every(index => index < tagCommit), 'alerts must precede their tag');
  }
  assert.equal(env.log.at(-1).kind, 'read');
  assert.equal(env.log.at(-1).path, 'groups/family');
}
console.log('✅ 既知の共有データを複数バッチで清掃し、タグ通知→タグ、管理者復旧情報とグループ本体は最後に消す');

{
  const env = setup();
  env.auth.currentUser.uid = 'person';
  await assert.rejects(run(env.service), { code: 'not-owner' });
  assert.equal(commits(env).length, 0);
  env.auth.currentUser.uid = 'owner';
  await assert.rejects(env.service.run({ groupId: 'family', confirmation: '' }), { code: 'confirmation-required' });
  assert.equal(commits(env).length, 0);
  const offline = setup(undefined, { isOnline: () => false });
  await assert.rejects(run(offline.service), { code: 'offline' });
  assert.equal(offline.log.length, 0);
  const cached = setup(); cached.setCache(true);
  await assert.rejects(run(cached.service), { code: 'server-unconfirmed' });
  assert.equal(commits(cached).length, 0);
}
console.log('✅ 管理者以外・未確認入力・オフライン・キャッシュしかない状態では変更前に止まる');

{
  const env = setup();
  env.storage.setItem = () => { throw Error('storage blocked'); };
  await assert.rejects(run(env.service), { code: 'checkpoint-unavailable' });
  assert.equal(commits(env).length, 0);
  const corrupt = setup(); corrupt.storage.values.set(CHECKPOINT_KEY, '{');
  await assert.rejects(run(corrupt.service), { code: 'checkpoint-invalid' });
  assert.equal(commits(corrupt).length, 0);
}
console.log('✅ 再開情報を保存・読込できないときは破壊的な操作を始めない');

{
  const env = setup();
  let failOnce = true;
  env.hooks.beforeCommit = operations => {
    if (failOnce && operations.some(op => op.path.startsWith('groups/family/events/'))) {
      failOnce = false; throw Error('temporary connection failure');
    }
  };
  await assert.rejects(run(env.service));
  assert.equal(env.data.get('groups/family').deletionState, 'deleting');
  assert.ok(env.data.has('accounts/owner'), 'the owner can recover on another device');
  assert.equal(env.progress.at(-1).status, 'paused');
  assert.ok(!env.progress.some(state => state.status === 'complete'));
  assert.equal(env.service.getPending().stage, 'events');
  const freshService = create(env.options);
  await run(freshService);
  assert.equal(hasFamilyData(env), false);
  const tombstones = commits(env).flatMap(item => item.operations).filter(op => op.kind === 'update');
  assert.equal(tombstones.length, 1, 'a resume must not reset the original deletion-start timestamp');
}
console.log('✅ 途中失敗は削除途中として残り、同じ管理者が再開すると残存データだけを清掃する');

{
  const env = setup();
  let fail = true;
  env.hooks.beforeCommit = operations => {
    if (fail && operations.some(op => op.path === 'watchTags/tag-a')) { fail = false; throw Error('lost connection'); }
  };
  await assert.rejects(run(env.service));
  assert.ok(env.data.has('watchTags/tag-a'));
  assert.equal([...env.data.keys()].some(path => path.startsWith('watchTags/tag-a/alerts/')), false);
  await run(create(env.options));
  assert.equal(hasFamilyData(env), false);
}
console.log('✅ タグ削除直前で失敗しても親タグを保持し、通知の孤立を作らず再開できる');

{
  const env = setup();
  let verifying = false;
  env.options.onProgress = state => { env.progress.push(state); if (state.status === 'verifying') verifying = true; };
  env.hooks.beforeRead = path => { if (verifying && path === 'groups/family/yotei') throw Error('cannot verify'); };
  await assert.rejects(run(create(env.options)));
  assert.ok(env.data.has('groups/family'));
  assert.ok(env.data.has('accounts/owner'));
  assert.equal(env.progress.at(-1).status, 'paused');
  env.hooks.beforeRead = undefined;
  await run(create(env.options));
  assert.equal(hasFamilyData(env), false);
}
console.log('✅ 空確認に失敗したらグループ本体と管理者の復旧経路を残す');

{
  const env = setup();
  env.hooks.afterCommit = operations => {
    if (operations.some(op => op.path === 'groups/family' && op.kind === 'delete')) throw Error('final acknowledgement lost');
  };
  await assert.rejects(run(env.service));
  assert.equal(env.service.getPending().stage, 'finalizing');
  assert.equal(env.data.has('groups/family'), false);
  assert.ok(!env.progress.some(state => state.status === 'complete'));
  const result = await run(create(env.options));
  assert.equal(result.status, 'complete');
  assert.equal(env.service.getPending(), null);
  assert.equal(env.log.at(-1).path, 'groups/family');
}
console.log('✅ 最終応答が途絶えた場合も完了扱いにせず、再開時にサーバーの不存在を確認する');

{
  const env = setup({});
  await assert.rejects(run(env.service), { code: 'group-not-found' });
  assert.ok(!env.progress.some(state => state.status === 'complete'));
  const other = setup();
  other.storage.setItem(CHECKPOINT_KEY, JSON.stringify({ version: 1, groupId: 'other', uid: 'owner', stage: 'events', deletedCount: 2 }));
  await assert.rejects(run(other.service), { code: 'different-deletion-pending' });
  assert.equal(commits(other).length, 0);
}
console.log('✅ 初回の親不存在だけで完全削除とは言わず、別グループの再開情報を上書きしない');

{
  const env = setup();
  env.options.onProgress = state => {
    if (state.stage === 'members' && state.status === 'deleting') env.auth.currentUser.uid = 'another-user';
  };
  await assert.rejects(run(create(env.options)), { code: 'account-changed' });
  assert.ok(env.data.has('groups/family'));
  assert.ok(env.data.has('accounts/owner'));
  env.auth.currentUser.uid = 'owner';
  env.options.onProgress = () => {};
  await run(create(env.options));
}
console.log('✅ 実行中に接続アカウントが変われば止め、元の管理者で再開する');

{
  const env = setup();
  env.options.onProgress = state => {
    if (state.status === 'finalizing') env.data.set('accounts/owner', { groupId: 'unrelated' });
  };
  await run(create(env.options));
  assert.equal(env.data.get('accounts/owner').groupId, 'unrelated', 'a changed recovery pointer is preserved');
  assert.equal(env.data.has('groups/family'), false);
}
console.log('✅ 最終処理では復旧先を読み直し、管理者が切り替えた別グループの情報を消さない');

{
  const env = setup();
  env.storage.removeItem = () => { throw Error('storage removal blocked'); };
  const result = await run(env.service);
  assert.equal(result.status, 'complete');
  assert.equal(result.localCheckpointCleared, false);
  assert.equal(env.service.getPending().stage, 'finalizing');
  assert.equal(hasFamilyData(env), false);
  const timeout = setup(undefined, { timeoutMs: 5 });
  timeout.hooks.beforeRead = () => new Promise(() => {});
  await assert.rejects(run(timeout.service), { code: 'operation-timeout' });
  assert.equal(commits(timeout).length, 0);
  assert.equal(timeout.progress.at(-1).status, 'paused');
}
console.log('✅ サーバー削除と端末内の削除は区別し、応答が来ない処理を成功表示しない');
