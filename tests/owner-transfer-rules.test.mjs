/* Firestore実動検査: 管理者の交代（作り直し第2回 2026-10-02）
   今の管理者が依頼し、引継先が自分で受け取る2段階。24時間で無効。
   受け取りは、復旧設定(メール確認済み)のパスワードで5分以内に入れ直した人だけ。 */
import {consentFixture} from './helpers/consent-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, deleteField, serverTimestamp, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-mainico-owner-transfer',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
const now = () => Math.floor(Date.now() / 1000);
/* 引継先の「入れ直した直後」のトークン。sign_in_provider は Firebase がつける値と同じ形 */
const fresh = (extra = {}) => ({
  email: 'heir@example.com', email_verified: true, auth_time: now(),
  firebase: { sign_in_provider: 'password', identities: { email: ['heir@example.com'] } }, ...extra,
});
const anon = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous', identities: {} } }).firestore();
const as = (uid, token = fresh()) => env.authenticatedContext(uid, token).firestore();
let checked = 0;
async function allowed(name, action) { await assertSucceeds(action()); checked++; console.log('OK', name); }
async function denied(name, action) { await assertFails(action()); checked++; console.log('OK 拒否:', name); }
const member = (role = 'kazoku', status = 'approved', extra = {}) => ({ name: role, role, status, joinedAt: Timestamp.now(), ...extra });
const g = (db, id = 'home') => doc(db, 'groups', id);
const ask = (db, target, id = 'home') => updateDoc(g(db, id), { pendingOwner: target, pendingOwnerAt: serverTimestamp() });
const clear = (db, id = 'home') => updateDoc(g(db, id), { pendingOwner: deleteField(), pendingOwnerAt: deleteField() });
const take = (db, uid, id = 'home', extra = {}) => updateDoc(g(db, id), { createdBy: uid, pendingOwner: deleteField(), pendingOwnerAt: deleteField(), ...extra });

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const id of ['owner', 'heir', 'other', 'person', 'waiting', 'linked', 'outsider']) await setDoc(doc(db, 'consents', id), consentFixture(Timestamp.now(), id === 'person' ? 'honnin' : 'kazoku'));
    await setDoc(doc(db, 'groups', 'home'), { createdBy: 'owner', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'home', 'members', 'owner'), member('kazoku'));
    await setDoc(doc(db, 'groups', 'home', 'members', 'heir'), member('kazoku'));
    await setDoc(doc(db, 'groups', 'home', 'members', 'other'), member('kazoku'));
    await setDoc(doc(db, 'groups', 'home', 'members', 'linked'), member('kazoku'));
    await setDoc(doc(db, 'groups', 'home', 'members', 'person'), member('honnin', 'approved', { mode: 'honnin' }));
    await setDoc(doc(db, 'groups', 'home', 'members', 'waiting'), member('kazoku', 'pending', { inviteCode: 'X' }));
    for (const id of ['owner', 'heir', 'other', 'person', 'linked']) await setDoc(doc(db, 'accounts', id), { groupId: 'home', updatedAt: Timestamp.now() });
  });
}
const setPending = (target, at = Timestamp.now(), extra = {}) => env.withSecurityRulesDisabled((ctx) =>
  updateDoc(doc(ctx.firestore(), 'groups', 'home'), { pendingOwner: target, pendingOwnerAt: at, ...extra }));
const read = async () => { let v; await env.withSecurityRulesDisabled(async (ctx) => { v = (await getDoc(doc(ctx.firestore(), 'groups', 'home'))).data(); }); return v; };

try {
  await seed();
  /* --- 依頼する --- */
  await denied('1. 管理者でない家族は依頼できない', () => ask(anon('other'), 'heir'));
  await denied('2. 自分自身を引継先にはできない', () => ask(anon('owner'), 'owner'));
  await denied('3. 承認待ちの人は引継先にできない', () => ask(anon('owner'), 'waiting'));
  await denied('4. ご本人(本人の画面で使う人)は引継先にできない', () => ask(anon('owner'), 'person'));
  await denied('5. 家庭の外の人は引継先にできない', () => ask(anon('owner'), 'outsider'));
  await denied('6. 依頼の時刻はサーバーの時刻だけ(過去の時刻で24時間をずらせない)', () =>
    updateDoc(g(anon('owner')), { pendingOwner: 'heir', pendingOwnerAt: Timestamp.fromMillis(Date.now() + 86400000) }));
  await denied('7. 依頼と同時に管理者を書き換えられない', () =>
    updateDoc(g(anon('owner')), { pendingOwner: 'heir', pendingOwnerAt: serverTimestamp(), createdBy: 'heir' }));
  await denied('8. 依頼と同時に削除の印は付けられない', () =>
    updateDoc(g(anon('owner')), { pendingOwner: 'heir', pendingOwnerAt: serverTimestamp(), deletionState: 'deleting' }));
  await allowed('9. 管理者は匿名のままでも、承認済みの家族へ依頼できる', () => ask(anon('owner'), 'heir'));
  let v = await read();
  assert.equal(v.createdBy, 'owner', '依頼しただけでは管理者は変わらない');
  assert.equal(v.pendingOwner, 'heir');

  /* --- 取り消す・断る --- */
  await denied('10. 関係のない家族は依頼を消せない', () => clear(anon('other')));
  await allowed('11. 引継先は断れる', () => clear(anon('heir')));
  assert.equal((await read()).pendingOwner, undefined);
  await allowed('12. 管理者は依頼し直せる', () => ask(anon('owner'), 'heir'));
  await allowed('13. 管理者は取り消せる', () => clear(anon('owner')));
  await denied('14. 依頼がないときは受け取れない', () => take(as('heir'), 'heir'));

  /* --- 受け取る --- */
  await setPending('heir');
  await denied('15. 引継先でない家族は受け取れない', () => take(as('other'), 'other'));
  await denied('16. 匿名のままでは受け取れない(復旧設定が必要)', () => take(anon('heir'), 'heir'));
  await denied('17. メール確認が済んでいないと受け取れない', () => take(as('heir', fresh({ email_verified: false })), 'heir'));
  await denied('18. パスワードの入れ直しから5分を過ぎると受け取れない', () => take(as('heir', fresh({ auth_time: now() - 6 * 60 })), 'heir'));
  await denied('19. 管理者をほかの人にすり替えられない', () => take(as('heir'), 'other'));
  // LINEでログイン(カスタムトークン)のセッション: メール確認済み・直後のログインでも、パスワードでの入れ直しなしでは受け取れない
  await denied('19b. LINEでログインしただけ(sign_in_provider=custom)では受け取れない', () =>
    take(as('heir', fresh({ firebase: { sign_in_provider: 'custom', identities: { email: ['heir@example.com'] } } })), 'heir'));
  await denied('20. 依頼を残したまま管理者だけ変えることはできない(片方だけ残らない)', () =>
    updateDoc(g(as('heir')), { createdBy: 'heir' }));
  await denied('21. 受け取りと同時に、ほかの項目は変えられない', () => take(as('heir'), 'heir', 'home', { deletionState: 'deleting' }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'accounts', 'heir'), { groupId: 'elsewhere', updatedAt: Timestamp.now() }));
  await denied('22. 復旧先がこの家庭でない人は受け取れない', () => take(as('heir'), 'heir'));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'accounts', 'heir'), { groupId: 'home', updatedAt: Timestamp.now() }));
  await env.withSecurityRulesDisabled((ctx) => deleteDoc(doc(ctx.firestore(), 'consents', 'heir')));
  await denied('23. 同意を取り消した人は受け取れない', () => take(as('heir'), 'heir'));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'consents', 'heir'), consentFixture(Timestamp.now())));
  await setPending('heir', Timestamp.fromMillis(Date.now() - 25 * 3600 * 1000));
  await denied('24. 24時間を過ぎた依頼は受け取れない', () => take(as('heir'), 'heir'));
  await allowed('25. 期限切れの依頼は、管理者が片付けられる', () => clear(anon('owner')));
  await setPending('heir');
  await allowed('26. 引継先が入れ直した直後なら受け取れる', () => take(as('heir'), 'heir'));
  v = await read();
  assert.equal(v.createdBy, 'heir'); assert.equal(v.pendingOwner, undefined); assert.equal(v.pendingOwnerAt, undefined);

  /* --- 交代のあと --- */
  const invite = (db, by) => setDoc(doc(db, 'invites', by === 'owner' ? 'ABCDEFGH' : 'ABCDEFGK'), {
    groupId: 'home', createdBy: by, createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 3600000), used: false });
  await denied('27. 元の管理者は招待を作れない', () => invite(anon('owner'), 'owner'));
  await allowed('28. 新しい管理者は招待を作れる', () => invite(anon('heir'), 'heir'));
  await denied('29. 元の管理者は依頼を出せない', () => ask(anon('owner'), 'other'));
  await denied('30. 新しい管理者は退会できない(管理者は退会できない、が移る)', () => deleteDoc(doc(anon('heir'), 'groups', 'home', 'members', 'heir')));
  await allowed('31. 元の管理者は普通の家族として、記録を読める', () => getDoc(doc(anon('owner'), 'groups', 'home')));

  /* --- 匿名から復旧を設定した人(追加1) --- */
  await seed();
  await setPending('linked');
  const linkedToken = fresh({ email: 'linked@example.com', firebase: { sign_in_provider: 'password', identities: { email: ['linked@example.com'] } } });
  await allowed('32. 匿名から復旧を設定し、パスワードで入れ直した人は「パスワードでログイン」として受け取れる', () => take(as('linked', linkedToken), 'linked'));

  /* --- 削除中の家庭 --- */
  await seed();
  await setPending('heir', Timestamp.now(), { deletionState: 'deleting', deletionStartedAt: Timestamp.now() });
  await denied('33. 削除中の家庭では受け取れない', () => take(as('heir'), 'heir'));
  await denied('34. 削除中の家庭では依頼できない', () => ask(anon('owner'), 'other'));
  /* --- 削除の開始は今までどおり --- */
  await seed();
  await denied('35. 管理者でない家族は削除を始められない', () => updateDoc(g(anon('other')), { deletionState: 'deleting', deletionStartedAt: serverTimestamp() }));
  await allowed('36. 管理者は削除を始められる(今までどおり)', () => updateDoc(g(anon('owner')), { deletionState: 'deleting', deletionStartedAt: serverTimestamp() }));
  console.log(`管理者の交代: ${checked}項目 passed`);
} finally {
  await env.cleanup();
}
