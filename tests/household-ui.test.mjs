import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ui = fs.readFileSync(new URL('../household-ui.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tagStart = html.indexOf('let watchTagLoadGeneration=0;');
const tagEnd = html.indexOf('function renderWatchTag(', tagStart);
assert.ok(tagStart >= 0 && tagEnd > tagStart, 'load the real watch-tag helper');
const tagCode = html.slice(tagStart, tagEnd);
const JOURNAL = 'mainico_recovery_journal_v1';

class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.innerHTML = ''; this.hidden = false; this.disabled = false;
    this.style = {}; this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name),
      toggle: (name, value) => { if (value === undefined ? !this.classes.has(name) : value) this.classes.add(name); else this.classes.delete(name); }
    };
  }
}
function storageFixture(seed = {}) {
  const values = new Map(Object.entries(seed));
  const hooks = {};
  return {
    values, hooks,
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem(key) { hooks.get?.(key); return values.get(key) ?? null; },
    setItem(key, value) { hooks.set?.(key, value); values.set(key, String(value)); },
    removeItem(key) { hooks.remove?.(key); values.delete(key); }
  };
}
function snapshot(data, cached = false) {
  return { exists: data !== null, data: () => data, metadata: { fromCache: cached, hasPendingWrites: false } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(seed = { mainicoGid: 'family', mainicoMode: 'kazoku' }) {
  const storage = storageFixture(seed);
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const ownerControls = [new Element(), new Element()];
  const roleLabels = [new Element()];
  const deletionButtons = [element('deletion-run'), new Element()];
  const recoveryButtons = [new Element(), new Element()];
  const state = { pages: [], alerts: [], startupErrors: [], started: 0, unsubscribed: 0, subscriptions: [], reads: [], pending: null, deletionCalls: 0 };
  const auth = { currentUser: { uid: 'owner', email: 'owner@example.test' }, signInAnonymously: async () => { throw Error('unexpected anonymous creation'); } };
  const ctx = {
    auth, localStorage: storage, previewStorage: storage,
    uid: () => auth.currentUser?.uid || '', gid: () => storage.getItem('mainicoGid') || '',
    document: {
      getElementById: element,
      querySelectorAll(selector) {
        if (selector === '[data-owner-only]') return ownerControls;
        if (selector === '[data-household-role]') return roleLabels;
        if (selector === '#deletion-modal button') return deletionButtons;
        if (selector === '#recovery-modal button') return recoveryButtons;
        if (selector === '.modal.show') return [...elements.entries()].filter(([id, el]) => id.endsWith('-modal') && el.classList.contains('show')).map(([, el]) => el);
        return [];
      }
    },
    alert: message => state.alerts.push(message), confirm: () => true,
    showPage: name => state.pages.push(name), startMode: () => state.started++, showPending: () => state.pages.push('pending-page'),
    showStartupProblem: message => state.startupErrors.push(message),
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TIME' } } },
    navigator: { onLine: true }, location: { reload: () => state.pages.push('reload') },
    speechSynthesis: { cancel() {} }, clearInterval, setTimeout, clearTimeout,
    memWatchUnsub: null, honninUnsub: null, yoteiUnsub: null, evUnsub: null, ytListUnsub: null,
    watchTagUnsub: null, medicineInfoUnsub: null, personHistoryUnsub: null, pendingUnsub: null,
    familyOnlyUnsubs: [], clockTimer: null,
    MainicoRecovery: { message: error => error.message },
    MainicoDeletion: { CONFIRMATION: '共有データを削除', create: () => ({
      getPending: () => state.pending,
      run: async args => { state.deletionCalls++; return state.deleteImpl ? state.deleteImpl(args) : { status: 'complete', localCheckpointCleared: true }; }
    }) }
  };
  function listen(kind, options, ok, error) {
    assert.equal(options.includeMetadataChanges, true);
    state.subscriptions.push({ kind, ok, error });
    return () => state.unsubscribed++;
  }
  ctx.grp = () => ({
    get: async options => { assert.equal(options.source, 'server'); state.reads.push('group'); return snapshot({ createdBy: 'owner' }); },
    onSnapshot: (options, ok, error) => listen('group', options, ok, error)
  });
  ctx.col = collection => ({ doc: () => ({
    get: async options => { state.reads.push(collection); return snapshot({ status: 'approved' }); },
    onSnapshot: (options, ok, error) => listen(collection, options, ok, error)
  }) });
  ctx.db = { collection: collection => ({ doc: () => ({
    get: async options => { assert.equal(options.source, 'server'); state.reads.push(collection); return snapshot(null); },
    set: async () => {}, delete: async () => {}
  }) }) };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(ui, ctx);
  const evaluate = code => vm.runInContext(code, ctx);
  return { ctx, storage, state, element, ownerControls, roleLabels, deletionButtons, auth, evaluate };
}

{
  // Independently invalidate every identity/lifecycle component while a settings get is in flight.
  const invalidate = [
    env => env.evaluate('householdBootGeneration++'),
    env => { env.auth.currentUser.uid = 'replacement'; },
    env => env.storage.setItem('mainicoGid', 'other-family'),
    env => env.evaluate('householdVerified=false'),
    env => env.evaluate('householdDeleting=true')
  ];
  for (const change of invalidate) {
    const env = harness();
    const pending = deferred();
    let subscriptions = 0;
    env.evaluate('householdVerified=true');
    env.ctx.currentWatchTagId = '';
    env.ctx.col = () => ({ doc: () => ({ get: () => pending.promise }) });
    env.ctx.renderWatchTag = () => { throw Error('must not render an old tag'); };
    const query = { orderBy() { return this; }, limit() { return this; }, onSnapshot() { subscriptions++; return () => {}; } };
    env.ctx.db = { collection: () => ({ doc: () => ({ collection: () => query }) }) };
    vm.runInContext(tagCode, env.ctx);
    const loading = env.ctx.loadWatchTag();
    change(env);
    pending.resolve(snapshot({ watchTagActive: true, watchTagId: 'old-tag' }));
    await loading;
    assert.equal(subscriptions, 0);
    assert.equal(env.ctx.currentWatchTagId, '');
  }
  const env = harness();
  env.evaluate('householdVerified=true');
  env.ctx.currentWatchTagId = '';
  env.ctx.col = () => ({ doc: () => ({ get: async () => snapshot({ watchTagActive: true, watchTagId: 'current-tag' }) }) });
  let rendered = '', tagCallbacks;
  env.ctx.renderWatchTag = id => { rendered = id; };
  const query = { orderBy() { return this; }, limit() { return this; }, onSnapshot(options, ok, error) { tagCallbacks = { ok, error }; return () => {}; } };
  env.ctx.db = { collection: () => ({ doc: () => ({ collection: () => query }) }) };
  vm.runInContext(tagCode, env.ctx);
  await env.ctx.loadWatchTag();
  assert.equal(rendered, 'current-tag', 'the valid current response still installs its listener');
  env.element('watch-tag-alerts').innerHTML = 'new household content';
  env.evaluate('householdBootGeneration++');
  tagCallbacks.ok({ forEach() { throw Error('old snapshot must be ignored'); } });
  tagCallbacks.error(Error('old listener error'));
  assert.equal(env.element('watch-tag-alerts').innerHTML, 'new household content');
}
console.log('✅ タグ読込中の家庭・UID・世代・利用状態変更で旧応答を破棄し、停止後に購読を復活させない');

{
  for (const change of [env => env.evaluate('householdBootGeneration++'), env => env.storage.setItem('mainicoGid', 'new-family'), env => { env.auth.currentUser.uid = 'new-user'; }]) {
    const env = harness();
    env.ctx.watchHouseholdAccess();
    const old = [...env.state.subscriptions];
    change(env);
    env.ctx.watchHouseholdAccess();
    old.forEach(listener => { listener.error(Error('old access error')); listener.ok(snapshot(null)); });
    assert.deepEqual(env.state.pages, [], 'an old listener cannot close the new household');
    env.state.subscriptions.at(-1).error(Error('current access error'));
    assert.equal(env.state.pages.at(-1), 'household-status-page', 'a current access failure must block');
    assert.ok(env.state.unsubscribed >= 2);
  }
  const env = harness(); env.ctx.watchHouseholdAccess();
  env.state.subscriptions[0].ok(snapshot({ createdBy: 'attacker' }, true));
  assert.equal(env.ctx.isHouseholdOwner(), false, 'cached ownership does not become verified');
}
console.log('✅ 旧家庭の購読エラーや削除応答は新しい画面を閉じず、現在の権限エラーは利用を止める');

{
  const result = { uid: 'recovered', groupId: 'new-family', mode: 'konly', name: '復旧した家族' };
  const env = harness({ mainicoGid: 'old-family', mainicoMode: 'honnin', mainicoName: '旧利用者', mainico_preview_disaster_qr_v1: 'old private QR', 'kusuri-2026-09-15-asa': '1', unrelatedPreference: 'keep', [JOURNAL]: JSON.stringify(result) });
  const before = [...env.storage.values];
  assert.equal(env.ctx.applyRecoveryJournal(), false);
  assert.deepEqual([...env.storage.values], before, 'failed Auth switching must preserve the old household');
  env.auth.currentUser.uid = 'recovered';
  assert.equal(env.ctx.applyRecoveryJournal(), true);
  assert.equal(env.storage.getItem('mainicoGid'), 'new-family');
  assert.equal(env.storage.getItem('mainicoName'), '復旧した家族');
  assert.equal(env.storage.getItem('mainicoMode'), 'kazoku');
  assert.equal(env.storage.getItem('kazokuOnly'), '1');
  assert.equal(env.storage.getItem('mainico_preview_disaster_qr_v1'), null);
  assert.equal(env.storage.getItem('kusuri-2026-09-15-asa'), null);
  assert.equal(env.storage.getItem('unrelatedPreference'), 'keep');
  assert.equal(env.storage.getItem(JOURNAL), null);
  const legacy = harness({ [JOURNAL]: JSON.stringify({ uid: 'owner', groupId: 'legacy-family', mode: 'kazoku', name: '家族', modeNeedsConfirmation: true }) });
  assert.equal(legacy.ctx.applyRecoveryJournal(), true);
  assert.equal(legacy.storage.getItem('mainicoMode'), null, 'old ambiguous modes require the user to choose');
}
console.log('✅ 復旧ジャーナルはUID一致後だけ旧家庭の端末情報を整理し、名前・家庭・利用方法を復元する');

{
  const journal = JSON.stringify({ uid: 'owner', groupId: 'new-family', mode: 'honnin', name: '本人' });
  const env = harness({ mainicoGid: 'old-family', mainicoName: '旧利用者', [JOURNAL]: journal });
  env.storage.hooks.set = key => { if (key === 'mainicoMode') throw Error('storage full'); };
  assert.throws(() => env.ctx.applyRecoveryJournal(), /storage full/);
  assert.equal(env.storage.getItem(JOURNAL), journal, 'partial restoration preserves the journal');
  env.storage.hooks.set = null;
  assert.equal(env.ctx.applyRecoveryJournal(), true);
  assert.equal(env.storage.getItem('mainicoMode'), 'honnin');
  assert.equal(env.storage.getItem('mainicoName'), '本人');
  assert.equal(env.storage.getItem(JOURNAL), null);
  const blocked = harness({ mainicoGid: 'old-family', [JOURNAL]: journal });
  blocked.storage.hooks.remove = key => { if (key === 'mainicoGid') throw Error('storage blocked'); };
  assert.throws(() => blocked.ctx.applyRecoveryJournal(), /device-storage-unavailable/);
  assert.equal(blocked.storage.getItem(JOURNAL), journal);
  assert.equal(blocked.storage.getItem('mainicoGid'), 'old-family');
}
console.log('✅ 復旧中の端末保存・消去失敗でジャーナルを失わず、再試行して復元を完了できる');

{
  const env = harness({ mainicoGid: 'old-family' });
  env.state.pending = { uid: 'owner', groupId: 'deleting-family', stage: 'finalizing', deletedCount: 12 };
  env.ctx.col = () => { throw Error('must not read a deleted member before offering resume'); };
  env.ctx.grp = () => { throw Error('completion confirmation belongs to the deletion API'); };
  await env.ctx.bootHouseholdUser(env.auth.currentUser);
  assert.equal(env.storage.getItem('mainicoGid'), 'deleting-family');
  assert.equal(env.element('deletion-modal').classList.contains('show'), true);
  assert.equal(env.element('loading').style.display, 'none');
  assert.match(env.element('household-status-text').textContent, /完了確認|未完了/);
  assert.equal(env.state.deletionCalls, 0, 'opening a resume screen must not delete without confirmation');
  assert.deepEqual(env.state.reads, []);
  assert.equal(env.ctx.isHouseholdOwner(), false, 'the checkpoint does not grant normal administrator privileges');
  assert.equal(env.ctx.requireHouseholdOwner(), false);
  const mismatch = harness({});
  mismatch.state.pending = { uid: 'someone-else', groupId: 'not-yours', stage: 'finalizing' };
  await mismatch.ctx.bootHouseholdUser(mismatch.auth.currentUser);
  assert.equal(mismatch.element('deletion-modal').classList.contains('show'), false);
  assert.equal(mismatch.storage.getItem('mainicoGid'), null);
}
console.log('✅ 最終削除の確認待ちはmember読込より先に再開画面へ案内し、別UIDに管理権限を与えない');

{
  const env = harness();
  env.evaluate("householdVerified=true;householdOwnerId='owner';householdDeleting=false");
  env.ctx.honninUnsub = () => env.state.unsubscribed++;
  env.ctx.openHouseholdDeletion();
  env.element('deletion-confirm').value = '共有データを削除';
  env.state.deleteImpl = async () => { const error = Error('この端末に再開情報を保存できません。'); error.code = 'checkpoint-unavailable'; throw error; };
  await env.ctx.runHouseholdDeletion();
  assert.equal(env.state.deletionCalls, 1);
  assert.ok(env.state.unsubscribed > 0);
  assert.equal(env.evaluate('householdDeleting'), false, 'a preflight failure does not become a deletion tombstone');
  assert.equal(env.storage.getItem('mainicoGid'), 'family');
  assert.match(env.element('deletion-state').textContent, /完了は確認できません/);
  assert.doesNotMatch(env.element('household-status-text').textContent, /削除したことを確認しました/);
  assert.ok(env.deletionButtons.every(button => !button.disabled));
  env.ctx.closeHouseholdDeletion();
  assert.ok(env.state.started > 0 || env.state.pages.includes('household-status-page'), 'after subscriptions were stopped, the old working screen must be restarted or remain blocked');
}
console.log('✅ 削除開始前の失敗を削除中・完了と誤表示せず、購読を止めた画面を利用可能なまま残さない');

{
  const env = harness();
  env.evaluate("householdOwnerId='owner';householdVerified=false");
  env.ctx.applyHouseholdPermissions();
  assert.ok(env.ownerControls.every(control => control.hidden));
  assert.equal(env.ctx.requireHouseholdOwner(), false);
  env.evaluate('householdVerified=true');
  env.ctx.applyHouseholdPermissions();
  assert.ok(env.ownerControls.every(control => !control.hidden));
  assert.equal(env.ctx.requireHouseholdOwner(), true);
  env.auth.currentUser.uid = 'family-member';
  env.ctx.applyHouseholdPermissions();
  assert.ok(env.ownerControls.every(control => control.hidden));
  assert.match(env.roleLabels[0].textContent, /参加メンバー/);
  env.ctx.openHouseholdDeletion();
  assert.equal(env.element('deletion-modal').classList.contains('show'), false);
  await env.ctx.runHouseholdDeletion();
  assert.equal(env.state.deletionCalls, 0);
  env.auth.currentUser.uid = 'owner';
  env.evaluate('householdDeleting=true');
  env.ctx.applyHouseholdPermissions();
  assert.ok(env.ownerControls.every(control => control.hidden));
  assert.equal(env.ctx.requireHouseholdOwner(), false, 'normal admin actions stop during deletion');
  env.ctx.openHouseholdDeletion();
  assert.equal(env.element('deletion-modal').classList.contains('show'), true, 'the verified owner can still resume deletion');
}
console.log('✅ 管理操作はサーバー確認済み作成者だけに表示し、削除中は通常操作を止めて再開だけを残す');

{
  const env=harness({mainico_account_closed_v1:'1'});
  env.auth.currentUser=null;
  await env.ctx.bootHouseholdUser(null);
  assert.equal(env.state.pages.at(-1),'account-closed-page');
  assert.equal(env.state.startupErrors.length,0);
  assert.equal(env.state.started,0);
  assert.equal(env.state.reads.length,0);
  env.storage.removeItem('mainico_account_closed_v1');
  env.evaluate('accountClosureBusy=true');
  await env.ctx.bootHouseholdUser(null);
  assert.equal(env.state.startupErrors.length,0);
  console.log('✅ Auth削除時と終了後再読込で匿名アカウントを自動再作成しない');
}
{
  const env=harness();
  env.element('account-deletion-modal').classList.add('show');
  env.element('account-deletion-password').value='secret-for-test';
  env.ctx.db.collection=()=>({doc:()=>({get:async options=>{assert.equal(options.source,'server');return snapshot({requestedAt:1});}})});
  await env.ctx.closeAccountDeletion();
  assert.equal(env.element('account-deletion-password').value,'');
  assert.equal(env.state.pages.at(-1),'household-status-page');
  assert.match(env.element('household-status-text').textContent,/未完了/);
  assert.match(env.element('household-status-text').textContent,/停止/);
  console.log('✅ 閉鎖準備後のキャンセルは利用停止・未完了・再開を示し、パスワードを残さない');
}
{
  const env=harness();
  env.element('account-deletion-password').value='old password';
  env.ctx.openAccountDeletion();
  assert.match(env.element('account-deletion-state').textContent,/通常利用を停止/);
  assert.match(env.element('account-deletion-state').textContent,/取り消せません/);
  assert.equal(env.element('account-deletion-password').value,'');
  assert.equal(env.element('account-deletion-finish').disabled,true);
  assert.equal(env.state.deletionCalls,0,'画面を開くだけでは終了を始めない');
  assert.deepEqual(env.state.reads,[]);
  console.log('✅ アカウント終了画面は開始の不可逆性を先に示し、開いただけでは終了しない');
}
{
  const env=harness();
  env.element('account-deletion-password').value='secret-for-test';
  env.ctx.MainicoAccountDeletion={message:()=> '本人確認できませんでした'};
  env.ctx.testService={prepare:async()=>{throw Error('reauth');}};
  env.evaluate('accountClosureService=testService');
  await env.ctx.prepareAccountDeletion();
  assert.equal(env.element('account-deletion-password').value,'');
  assert.equal(env.element('account-deletion-finish').disabled,true);
  assert.match(env.element('account-deletion-state').textContent,/本人確認/);
  assert.equal(env.storage.values.has('mainico_account_closed_v1'),false);
  console.log('✅ 再認証失敗では最終削除を有効にせず、成功を表示せず、入力を消去する');
}

{
  const key='mainico_join_pending_v1';
  const journal=JSON.stringify({uid:'owner',groupId:'ended-family',mode:'kazoku',code:'TEST-CODE'});
  const denied=()=>Object.assign(Error('parent no longer exists'),{code:'permission-denied'});
  function joinHarness({memberGet=async()=>{throw denied();},groupGet=async()=>snapshot(null),pointerGet=async()=>snapshot(null)}={}){
    const env=harness({[key]:journal,mainicoPendingMode:'kazoku',unrelatedPreference:'keep'});
    const noWrite=()=>{throw Error('boot must not create or delete server records');};
    const read=async(kind,options,impl)=>{
      assert.equal(options.source,'server');env.state.reads.push(kind);return impl();
    };
    env.ctx.db={collection:name=>({doc:id=>{
      if(name==='groups'){
        assert.equal(id,'ended-family');
        return {
          get:options=>read('join-group',options,groupGet),set:noWrite,delete:noWrite,
          collection:collection=>({doc:memberUid=>{
            assert.equal(collection,'members');assert.equal(memberUid,'owner');
            return {get:options=>read('join-member',options,memberGet),set:noWrite,delete:noWrite};
          }})
        };
      }
      assert.ok(['accountClosures','accounts'].includes(name));
      return {get:options=>read(name,options,name==='accounts'?pointerGet:async()=>snapshot(null)),set:noWrite,delete:noWrite};
    }})};
    return env;
  }
  const ended=joinHarness();
  await ended.ctx.bootHouseholdUser(ended.auth.currentUser);
  assert.equal(ended.storage.getItem(key),null,'only confirmed absence ends the old request');
  assert.equal(ended.storage.getItem('mainicoGid'),null);
  assert.equal(ended.storage.getItem('unrelatedPreference'),'keep');
  assert.equal(ended.state.started,1,'normal start opens entry without a household');
  assert.deepEqual(ended.state.startupErrors,[]);
  assert.deepEqual(ended.state.reads,['accountClosures','join-member','join-group','accounts']);

  const uncertainGroups=[
    async()=>snapshot({createdBy:'someone'}),
    async()=>snapshot(null,true),
    async()=>({...snapshot(null),metadata:{fromCache:false,hasPendingWrites:true}}),
    async()=>({exists:false}),
    async()=>({exists:false,metadata:{fromCache:false}}),
    async()=>{throw Error('offline');},
    async()=>{throw denied();}
  ];
  for(const groupGet of uncertainGroups){
    const env=joinHarness({groupGet});
    await env.ctx.bootHouseholdUser(env.auth.currentUser);
    assert.equal(env.storage.getItem(key),journal,'uncertainty must retain the unfinished request');
    assert.equal(env.storage.getItem('mainicoGid'),null);
    assert.equal(env.state.started,0);
    assert.equal(env.state.startupErrors.length,1);
    assert.ok(!env.state.reads.includes('accounts'),'do not recover another pointer before resolving the request');
  }
  const pending=joinHarness({memberGet:async()=>snapshot({status:'pending'})});
  pending.ctx.col=()=>({doc:()=>({get:async()=>snapshot({status:'pending'})})});
  await pending.ctx.bootHouseholdUser(pending.auth.currentUser);
  assert.equal(pending.storage.getItem(key),null);
  assert.equal(pending.storage.getItem('mainicoGid'),'ended-family');
  assert.equal(pending.state.pages.at(-1),'pending-page');
  assert.ok(!pending.state.reads.includes('join-group'),'a valid pending member must not need permission to read its parent');
  for(const member of [snapshot(null,true),{...snapshot({status:'pending'}),metadata:{fromCache:false,hasPendingWrites:true}}]){
    const env=joinHarness({memberGet:async()=>member});
    await env.ctx.bootHouseholdUser(env.auth.currentUser);
    assert.equal(env.storage.getItem(key),journal);
    assert.equal(env.state.started,0);
    assert.equal(env.state.startupErrors.length,1);
    assert.ok(!env.state.reads.includes('join-group'),'parent fallback only follows a failed member read');
  }
  console.log('✅ 未完の参加申請は家庭のサーバー不存在だけで終了扱いにし、通信不明・キャッシュ・未確定応答では記録を保持する');

  const changes=[
    env=>env.evaluate('householdBootGeneration++'),
    env=>{env.auth.currentUser.uid='replacement';},
    env=>env.storage.setItem('mainicoGid','new-family'),
    env=>env.storage.setItem(key,JSON.stringify({uid:'owner',groupId:'new-request',mode:'honnin'}))
  ];
  for(const phase of ['member','group'])for(const change of changes)for(const rejects of [false,true]){
    const response=deferred(),reached=deferred();
    const read=()=>{reached.resolve();return response.promise;};
    const env=joinHarness(phase==='member'?{memberGet:read}:{groupGet:read});
    const boot=env.ctx.bootHouseholdUser(env.auth.currentUser);
    await reached.promise;
    change(env);
    const stored=env.storage.getItem(key),groupId=env.storage.getItem('mainicoGid');
    if(rejects)response.reject(denied());else response.resolve(snapshot(null));
    await boot;
    assert.equal(env.storage.getItem(key),stored,'old boot cannot clear a current request');
    assert.equal(env.storage.getItem('mainicoGid'),groupId,'old boot cannot replace the current household');
    assert.equal(env.state.started,0);
    assert.deepEqual(env.state.startupErrors,[],'stale errors cannot block the new session');
    assert.ok(!env.state.reads.includes('accounts'));
  }
  const pointer=deferred(),pointerReached=deferred();
  const switched=joinHarness({pointerGet:()=>{pointerReached.resolve();return pointer.promise;}});
  const boot=switched.ctx.bootHouseholdUser(switched.auth.currentUser);
  await pointerReached.promise;
  switched.storage.setItem('mainicoGid','new-family');
  pointer.resolve(snapshot({groupId:'old-pointer'}));
  await boot;
  assert.equal(switched.storage.getItem('mainicoGid'),'new-family');
  assert.equal(switched.state.started,0);
  console.log('✅ 参加履歴の確認中にUID・家庭・起動世代・申請が変われば旧応答を捨て、別家庭の情報や画面を変更しない');
}

{
  const env=harness(),closure=deferred(),member=deferred(),pointer=deferred();
  const db=env.ctx.db,col=env.ctx.col;
  const requests=[];
  env.ctx.db={collection:name=>name==='accountClosures'?{doc:()=>({get:()=>{requests.push('closure');return closure.promise;}})}:name==='accounts'?{doc:()=>({set:()=>{requests.push('pointer');return pointer.promise;}})}:db.collection(name)};
  env.ctx.col=name=>name==='members'?{doc:()=>({...col(name).doc(),get:()=>{requests.push('member');return member.promise;}})}:col(name);
  const boot=env.ctx.bootHouseholdUser(env.auth.currentUser);
  assert.deepEqual(requests.sort(),['closure','member'],'independent access checks begin without awaiting each other');
  member.resolve(snapshot({status:'approved'}));await Promise.resolve();
  assert.equal(env.state.started,0,'membership alone never bypasses account closure');
  closure.resolve(snapshot(null));await boot;
  assert.equal(env.state.started,1,'an unresolved recovery write cannot block home');
  assert.equal(env.element('loading').style.display,'none');
  assert.ok(requests.includes('pointer'));
  pointer.reject(Error('offline'));await new Promise(r=>setImmediate(r));
  assert.equal(env.element('recovery-sync-warning').hidden,false,'failure remains visible in recovery settings');
  assert.equal(env.state.started,1);
  env.ctx.saveRecoveryPointer=async()=>{};
  await env.ctx.syncStartupRecoveryPointer();
  assert.equal(env.element('recovery-sync-warning').hidden,true,'retry clears the warning only for this account');
}
{
  for(const status of ['pending','revoked','absent']){
    const env=harness();env.ctx.col=()=>({doc:()=>({get:async()=>snapshot(status==='absent'?null:{status})})});
    env.ctx.grp=()=>{throw Error('group contents must not be read before approval');};
    await env.ctx.bootHouseholdUser(env.auth.currentUser);
    assert.equal(env.state.started,0,status);
    assert.ok(env.state.pages.includes(status==='pending'?'pending-page':'household-status-page'));
  }
  const env=harness(),late=deferred();env.evaluate('householdVerified=true');env.ctx.saveRecoveryPointer=()=>late.promise;
  const write=env.ctx.syncStartupRecoveryPointer();env.ctx.stopHouseholdSubscriptions();late.reject(Error('old account'));await write;
  assert.equal(env.element('recovery-sync-warning').hidden,true,'old failure cannot replace current recovery state');
}
console.log('✅ 起動時の承認・終了確認は並行処理、未承認を遮断し、復旧先の保存待ちでホームを止めない');
