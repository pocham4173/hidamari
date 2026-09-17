/* Firestore実動検査: 管理者境界、招待の同時利用、復旧先、削除の停止境界。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {classify}=createRequire(import.meta.url)('../family-connection.js');
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, collection, setDoc, updateDoc, deleteDoc, getDoc, getDocs, getDocsFromServer,
  query, where, serverTimestamp, Timestamp, writeBatch,
} from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-mainico-lifecycle',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
const dbFor = (uid) => env.authenticatedContext(uid).firestore();
const owner = dbFor('owner');
const family = dbFor('family');
const stranger = dbFor('stranger');
const tagId = 'A'.repeat(32);
const tagId2 = 'B'.repeat(32);
let checked = 0;
async function allowed(name, action) { await assertSucceeds(action()); checked++; console.log('OK', name); }
async function denied(name, action) { await assertFails(action()); checked++; console.log('OK 拒否:', name); }
const member = (status = 'approved', extra = {}) => ({
  name: '検査', role: 'kazoku', status, joinedAt: serverTimestamp(), ...extra,
});
const invite = (groupId = 'home', createdBy = 'owner') => ({
  groupId, createdBy, createdAt: serverTimestamp(),
  expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000), used: false,
});
const alert = (uid) => ({
  type: 'found', situation: 'safe', count: 1, senderUid: uid, createdAt: serverTimestamp(),
});
function join(db, uid, code, groupId = 'home', extra = {}) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'groups', groupId, 'members', uid), member('pending', { inviteCode: code, ...extra }));
  batch.update(doc(db, 'invites', code), { used: true, usedBy: uid });
  return batch.commit();
}
function createHome(db, uid, groupId) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'groups', groupId), { createdBy: uid, createdAt: serverTimestamp() });
  batch.set(doc(db, 'groups', groupId, 'members', uid), member('approved', { mode: 'konly' }));
  batch.set(doc(db, 'accounts', uid), { groupId, updatedAt: serverTimestamp() });
  return batch.commit();
}
const scoped = (db, name, groupId = 'home') => getDocs(query(collection(db, name), where('groupId', '==', groupId)));
const mark = (db, groupId = 'home') => updateDoc(doc(db, 'groups', groupId), {
  deletionState: 'deleting', deletionStartedAt: serverTimestamp(),
});

try {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'groups', 'home'), { createdBy: 'owner', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'other'), { createdBy: 'other-owner', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'legacy-home'), { createdBy: 'old-family', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'legacy-home', 'members', 'old-family'), { name: '旧家族', role: 'kazoku' });
    await setDoc(doc(db, 'groups', 'legacy-home', 'members', 'old-person'), { name: '旧本人', role: 'honnin' });
    await setDoc(doc(db, 'groups', 'legacy-home', 'members', 'still-pending'), { name: '承認待ち', role: 'honnin', status: 'pending' });
    for (const uid of ['owner', 'family', 'leaving']) {
      await setDoc(doc(db, 'groups', 'home', 'members', uid), { name: uid, role: 'kazoku', status: 'approved' });
    }
    await setDoc(doc(db, 'groups', 'home', 'members', 'legacy'), { name: '旧家族', role: 'kazoku' });
    await setDoc(doc(db, 'groups', 'home', 'members', 'pending'), { name: '申請者', role: 'kazoku', status: 'pending' });
    await setDoc(doc(db, 'groups', 'home', 'events', 'record'), { uid: 'family', date: '2026-09-15', text: 'private' });
    await setDoc(doc(db, 'groups', 'other', 'events', 'record'), { uid: 'other-owner', text: 'other household' });
    await setDoc(doc(db, 'groups', 'home', 'yotei', 'plan'), { uid: 'family', label: '予定' });
    await setDoc(doc(db, 'watchTags', tagId), { groupId: 'home', active: true, createdBy: 'owner', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'watchTags', tagId, 'alerts', 'finder'), alert('finder'));
    await setDoc(doc(db, 'groups', 'home', 'settings', 'watchTag'), {
      watchTagId: tagId, watchTagActive: true, watchTagUpdatedAt: Timestamp.now(),
    });
    await setDoc(doc(db, 'accounts', 'owner'), { groupId: 'home', updatedAt: Timestamp.now() });
    await setDoc(doc(db, 'accounts', 'family'), { groupId: 'home', updatedAt: Timestamp.now() });
    await setDoc(doc(db, 'accounts', 'other-owner'), { groupId: 'other', updatedAt: Timestamp.now() });
    await setDoc(doc(db, 'invites', 'QTHER222'), invite('other', 'other-owner'));
  });

  await allowed('通常の家族は世帯の記録を読める', () => getDoc(doc(family, 'groups', 'home', 'events', 'record')));
  await allowed('旧status無しメンバーも読める', () => getDoc(doc(dbFor('legacy'), 'groups', 'home', 'events', 'record')));
  for(const [uid,personOthers,familyOthers] of [['old-family',1,0],['old-person',0,1]]){
    await allowed('旧登録のサーバー参加一覧で返信相手を判定: '+uid,async()=>{
      const snap=await getDocsFromServer(collection(dbFor(uid),'groups','legacy-home','members'));
      assert.deepEqual(classify(snap,uid),{status:'shared',others:1,personOthers,familyOthers});
    });
  }
  await allowed('旧登録の本人が挨拶を保存できる',()=>setDoc(doc(dbFor('old-person'),'groups','legacy-home','events','hello'),{
    type:'aisatsu',text:'おはよう',slot:'asa',uid:'old-person',date:'2026-09-17',at:serverTimestamp(),
  }));
  await allowed('旧登録の家族が挨拶を取得し、返事を保存できる',async()=>{
    const hello=await getDoc(doc(dbFor('old-family'),'groups','legacy-home','events','hello'));
    assert.equal(hello.data().text,'おはよう');
    await setDoc(doc(dbFor('old-family'),'groups','legacy-home','events','reply'),{
      type:'aisatsu-back',text:'おはよう',replyTo:hello.id,uid:'old-family',date:'2026-09-17',at:serverTimestamp(),
    });
    const reply=await getDoc(doc(dbFor('old-person'),'groups','legacy-home','events','reply'));
    assert.equal(reply.data().replyTo,'hello');
  });
  await denied('旧登録の家庭でも承認待ちは会話を読めない',()=>getDoc(doc(dbFor('still-pending'),'groups','legacy-home','events','hello')));
  await denied('新規参加者がstatusを省いて旧登録扱いにはできない',()=>setDoc(doc(stranger,'groups','legacy-home','members','stranger'),{name:'検査',role:'honnin'}));
  await denied('別世帯の記録は読めない', () => getDoc(doc(owner, 'groups', 'other', 'events', 'record')));
  await denied('申請中は記録を読めない', () => getDoc(doc(dbFor('pending'), 'groups', 'home', 'events', 'record')));
  await denied('本人のroleを管理者にしても権限は増えない', () => updateDoc(doc(family, 'groups', 'home', 'members', 'family'), { role: 'admin' }));
  await denied('一般家族は参加承認できない', () => updateDoc(doc(family, 'groups', 'home', 'members', 'pending'), { status: 'approved' }));
  await allowed('作成者は参加承認できる', () => updateDoc(doc(owner, 'groups', 'home', 'members', 'pending'), { status: 'approved' }));
  await denied('一般家族は他人を解除できない', () => deleteDoc(doc(family, 'groups', 'home', 'members', 'pending')));
  await denied('一般家族は作成者を解除できない', () => deleteDoc(doc(family, 'groups', 'home', 'members', 'owner')));
  await denied('作成者は通常退会できない', () => deleteDoc(doc(owner, 'groups', 'home', 'members', 'owner')));
  await allowed('一般家族は自分で退会できる', () => deleteDoc(doc(dbFor('leaving'), 'groups', 'home', 'members', 'leaving')));
  await allowed('作成者は他の参加者を解除できる', () => deleteDoc(doc(owner, 'groups', 'home', 'members', 'pending')));
  await denied('一般家族は世帯を削除できない', () => deleteDoc(doc(family, 'groups', 'home')));
  await denied('作成者も削除マーク前は世帯を削除できない', () => deleteDoc(doc(owner, 'groups', 'home')));
  await denied('作成者の付け替えは不可', () => updateDoc(doc(owner, 'groups', 'home'), { createdBy: 'family' }));
  await allowed('自分の利用modeだけを変更できる', () => updateDoc(doc(family, 'groups', 'home', 'members', 'family'), { mode: 'konly' }));
  await denied('他人の利用modeは変更できない', () => updateDoc(doc(owner, 'groups', 'home', 'members', 'family'), { mode: 'honnin' }));
  await denied('mode変更と同時にstatusを書き換えられない', () => updateDoc(doc(family, 'groups', 'home', 'members', 'family'), { mode: 'honnin', status: 'pending' }));


  await denied('一般家族は招待発行できない', () => setDoc(doc(family, 'invites', 'FAMLY222'), invite('home', 'family')));
  await allowed('作成者は招待発行できる', () => setDoc(doc(owner, 'invites', 'JNNN2222'), invite()));
  await denied('期限が長すぎる招待は不可', () => setDoc(doc(owner, 'invites', 'LNGG2222'), { ...invite(), expiresAt: Timestamp.fromMillis(Date.now() + 2 * 24 * 60 * 60 * 1000) }));
  await denied('memberだけ作る旧非atomic参加は拒否', () => setDoc(doc(stranger, 'groups', 'home', 'members', 'stranger'), member('pending', { inviteCode: 'JNNN2222' })));
  await denied('招待だけ使用済みにする妨害は拒否', () => updateDoc(doc(stranger, 'invites', 'JNNN2222'), { used: true, usedBy: 'stranger' }));
  await denied('招待でapprovedを自己指定できない', () => join(stranger, 'stranger', 'JNNN2222', 'home', { status: 'approved' }));
  await denied('別世帯への招待流用は不可', () => join(stranger, 'stranger', 'JNNN2222', 'other'));
  await allowed('pendingと招待使用済み化のatomic参加は成功', () => join(stranger, 'stranger', 'JNNN2222'));
  await denied('使用済み招待の再利用は不可', () => join(dbFor('second'), 'second', 'JNNN2222'));
  await allowed('招待のowner限定groupId検索は可能', () => scoped(owner, 'invites'));
  await denied('一般家族の招待一覧検索は不可', () => scoped(family, 'invites'));
  await denied('作成者でも全世帯の招待検索は不可', () => getDocs(collection(owner, 'invites')));
  await allowed('同時参加用招待を発行', () => setDoc(doc(owner, 'invites', 'RACE2222'), invite()));
  const raced = await Promise.allSettled([join(dbFor('race-a'), 'race-a', 'RACE2222'), join(dbFor('race-b'), 'race-b', 'RACE2222')]);
  assert.equal(raced.filter(x => x.status === 'fulfilled').length, 1, '同じ招待で成功するのは1人だけ');
  assert.equal(raced.filter(x => x.status === 'rejected').length, 1);
  checked++; console.log('OK 招待同時利用は1人だけ成立');

  await allowed('自分の復旧先を保存できる', () => setDoc(doc(family, 'accounts', 'family'), { groupId: 'home', updatedAt: serverTimestamp() }));
  await allowed('自分の復旧先を取得できる', () => getDoc(doc(family, 'accounts', 'family')));
  await denied('他人の復旧先は読めない', () => getDoc(doc(owner, 'accounts', 'family')));
  await denied('他人の復旧先は変更できない', () => setDoc(doc(owner, 'accounts', 'family'), { groupId: 'home', updatedAt: serverTimestamp() }));
  await denied('所属していない世帯を復旧先にできない', () => setDoc(doc(family, 'accounts', 'family'), { groupId: 'other', updatedAt: serverTimestamp() }));
  await denied('申請中アカウントは復旧先を確定できない', () => setDoc(doc(stranger, 'accounts', 'stranger'), { groupId: 'home', updatedAt: serverTimestamp() }));
  await denied('復旧先にメールや秘密情報を混入できない', () => setDoc(doc(family, 'accounts', 'family'), { groupId: 'home', updatedAt: serverTimestamp(), password: 'must-not-store' }));
  await denied('削除前はownerも復旧先一覧を読めない', () => scoped(owner, 'accounts'));
  await allowed('グループ・作成者member・復旧先を同時作成', () => {
    const fresh = dbFor('new-owner'), batch = writeBatch(fresh);
    batch.set(doc(fresh, 'groups', 'new-home'), { createdBy: 'new-owner', createdAt: serverTimestamp() });
    batch.set(doc(fresh, 'groups', 'new-home', 'members', 'new-owner'), member('approved', { mode: 'konly' }));
    batch.set(doc(fresh, 'accounts', 'new-owner'), { groupId: 'new-home', updatedAt: serverTimestamp() });
    return batch.commit();
  });

  await denied('member/pointerのない孤立group作成を拒否', () => setDoc(doc(dbFor('isolated'), 'groups', 'isolated-home'), { createdBy: 'isolated', createdAt: serverTimestamp() }));
  await denied('既存世帯ownerは別groupを追加作成できない', () => createHome(owner, 'owner', 'duplicate-home'));
  await denied('既存世帯の家族も別groupを追加作成できない', () => createHome(family, 'family', 'duplicate-family-home'));
  await denied('active ownerは復旧pointerだけを消せない', () => deleteDoc(doc(owner, 'accounts', 'owner')));
  await denied('接続中の家族は復旧pointerだけを消せない', () => deleteDoc(doc(family, 'accounts', 'family')));
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'groups', 'other', 'members', 'family'), { status: 'approved' });
    await setDoc(doc(db, 'accounts', 'former-member'), { groupId: 'home', updatedAt: Timestamp.now() });
    await setDoc(doc(db, 'accounts', 'deleted-group-user'), { groupId: 'gone-home', updatedAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'home', 'members', 'leaver-atomic'), { status: 'approved' });
    await setDoc(doc(db, 'accounts', 'leaver-atomic'), { groupId: 'home', updatedAt: Timestamp.now() });
  });
  await denied('旧データで2世帯に所属していても復旧先を上書きできない', () => setDoc(doc(family, 'accounts', 'family'), { groupId: 'other', updatedAt: serverTimestamp() }));
  await allowed('解除済みの古いpointerがあっても新世帯を作れる', () => createHome(dbFor('former-member'), 'former-member', 'former-member-home'));
  await allowed('削除済みgroupを指す古いpointerから新世帯を作れる', () => createHome(dbFor('deleted-group-user'), 'deleted-group-user', 'replacement-home'));
  await allowed('通常家族の退会と自分のpointer削除は同batchで可能', () => {
    const db = dbFor('leaver-atomic'), batch = writeBatch(db);
    batch.delete(doc(db, 'groups', 'home', 'members', 'leaver-atomic'));
    batch.delete(doc(db, 'accounts', 'leaver-atomic'));
    return batch.commit();
  });

  await denied('一般家族はタグ作成できない', () => setDoc(doc(family, 'watchTags', tagId2), { groupId: 'home', active: true, createdBy: 'family', createdAt: serverTimestamp() }));
  await denied('一般家族はタグ停止できない', () => updateDoc(doc(family, 'watchTags', tagId), { active: false, stoppedAt: serverTimestamp() }));
  await denied('通常時にタグ本体だけを消して通知を孤立させられない', () => deleteDoc(doc(owner, 'watchTags', tagId)));
  await allowed('タグと設定を同batch作成できる', () => {
    const batch = writeBatch(owner);
    batch.set(doc(owner, 'watchTags', tagId2), { groupId: 'home', active: true, createdBy: 'owner', createdAt: serverTimestamp() });
    batch.set(doc(owner, 'groups', 'home', 'settings', 'watchTag'), { watchTagId: tagId2, watchTagActive: true, watchTagUpdatedAt: serverTimestamp() });
    return batch.commit();
  });
  await allowed('タグと設定を同batch停止できる', () => {
    const batch = writeBatch(owner);
    batch.update(doc(owner, 'watchTags', tagId2), { active: false, stoppedAt: serverTimestamp() });
    batch.update(doc(owner, 'groups', 'home', 'settings', 'watchTag'), { watchTagActive: false, watchTagUpdatedAt: serverTimestamp() });
    return batch.commit();
  });

  await denied('一般家族は削除開始できない', () => mark(family));
  await denied('削除開始と通常書込を同batchに入れる抜け道は不可', () => {
    const batch = writeBatch(owner);
    batch.update(doc(owner, 'groups', 'home'), { deletionState: 'deleting', deletionStartedAt: serverTimestamp() });
    batch.set(doc(owner, 'groups', 'home', 'events', 'race-write'), { uid: 'owner', text: 'late write' });
    return batch.commit();
  });
  await allowed('作成者が削除開始できる', () => mark(owner));
  await denied('削除マークを解除できない', () => updateDoc(doc(owner, 'groups', 'home'), { deletionState: 'active' }));
  await denied('削除中の一般家族は記録を読めない', () => getDoc(doc(family, 'groups', 'home', 'events', 'record')));
  await denied('削除中の一般家族はmember一覧を読めない', () => getDocs(collection(family, 'groups', 'home', 'members')));
  await denied('削除中の作成者も通常の新規記録は不可', () => setDoc(doc(owner, 'groups', 'home', 'events', 'late'), { uid: 'owner', text: 'late' }));
  await denied('削除中の本人も予定修正は不可', () => updateDoc(doc(family, 'groups', 'home', 'yotei', 'plan'), { label: 'late', updatedAt: serverTimestamp() }));
  await denied('削除中は招待を新規発行できない', () => setDoc(doc(owner, 'invites', 'LATE2222'), invite()));
  await denied('削除中もowner pointerだけを先に捨てられない', () => deleteDoc(doc(owner, 'accounts', 'owner')));
  await denied('削除中は復旧ポインタを書き戻せない', () => setDoc(doc(owner, 'accounts', 'owner'), { groupId: 'home', updatedAt: serverTimestamp() }));
  await denied('削除中は外部からタグ通知を新規作成できない', () => setDoc(doc(dbFor('new-finder'), 'watchTags', tagId, 'alerts', 'new-finder'), alert('new-finder')));
  await allowed('削除中ownerは記録を列挙できる', () => getDocs(collection(owner, 'groups', 'home', 'events')));
  await allowed('削除中ownerはタグをgroupId検索できる', () => scoped(owner, 'watchTags'));
  await allowed('削除中ownerは復旧先をgroupId検索できる', () => scoped(owner, 'accounts'));
  await denied('削除中ownerも他世帯の復旧先は検索不可', () => scoped(owner, 'accounts', 'other'));
  await denied('一般家族が復旧先を検索することは不可', () => scoped(family, 'accounts'));
  await allowed('削除中ownerは他の家族の記録を清掃できる', () => deleteDoc(doc(owner, 'groups', 'home', 'events', 'record')));
  await allowed('削除中ownerは他の家族の予定を清掃できる', () => deleteDoc(doc(owner, 'groups', 'home', 'yotei', 'plan')));
  await allowed('削除中ownerは通知を清掃できる', () => deleteDoc(doc(owner, 'watchTags', tagId, 'alerts', 'finder')));
  await allowed('削除中ownerは自分のmemberを清掃できる', () => deleteDoc(doc(owner, 'groups', 'home', 'members', 'owner')));
  await allowed('自分のmember清掃後もownerは残りを列挙できる', () => getDocs(collection(owner, 'groups', 'home', 'members')));
  await allowed('自分のmember清掃後もownerはタグを削除できる', () => deleteDoc(doc(owner, 'watchTags', tagId)));
  await denied('削除中ownerのmemberを再作成できない', () => setDoc(doc(owner, 'groups', 'home', 'members', 'owner'), member()));
  await allowed('自分のmember清掃後もownerは設定を清掃できる', () => deleteDoc(doc(owner, 'groups', 'home', 'settings', 'watchTag')));
  await allowed('削除中ownerは家族の復旧先を清掃できる', () => deleteDoc(doc(owner, 'accounts', 'family')));
  await allowed('自分の復旧先と世帯本体を最後に同batch削除できる', () => {
    const batch = writeBatch(owner);
    batch.delete(doc(owner, 'accounts', 'owner'));
    batch.delete(doc(owner, 'groups', 'home'));
    return batch.commit();
  });
  await allowed('削除後は世帯の不存在をサーバー確認できる', async () => assert.equal((await getDoc(doc(owner, 'groups', 'home'))).exists(), false));
  await denied('世帯削除後は取り残しmemberにアクセスできない', () => getDoc(doc(family, 'groups', 'home', 'members', 'family')));
  console.log(`\n${checked}件の管理権限・招待・復旧・削除境界が期待どおり。`);
} finally {
  await env.cleanup();
}
