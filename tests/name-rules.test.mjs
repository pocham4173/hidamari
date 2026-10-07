/* Firestore実動検査: 名前を変える(2026-10-08)
   自分の名前と、ご本人(本人の画面で使う人)の名前だけを、承認済みの家族が変えられる。name 以外は変えられない。 */
import {consentFixture} from './helpers/consent-fixture.mjs';
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-mainico-name',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
const as = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous', identities: {} } }).firestore();
let checked = 0;
async function allowed(name, action) { await assertSucceeds(action()); checked++; console.log('OK', name); }
async function denied(name, action) { await assertFails(action()); checked++; console.log('OK 拒否:', name); }
const member = (role, status = 'approved', extra = {}) => ({ name: role === 'honnin' ? '本人' : role, role, status, joinedAt: Timestamp.now(), ...extra });
const m = (db, id, g = 'home') => doc(db, 'groups', g, 'members', id);
const rename = (db, id, name, g = 'home', extra = {}) => updateDoc(m(db, id, g), { name, ...extra });

await env.clearFirestore();
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  for (const id of ['owner', 'other', 'person', 'waiting', 'outsider']) await setDoc(doc(db, 'consents', id), consentFixture(Timestamp.now(), id === 'person' ? 'honnin' : 'kazoku'));
  await setDoc(doc(db, 'groups', 'home'), { createdBy: 'owner', createdAt: Timestamp.now() });
  await setDoc(m(db, 'owner'), member('kazoku', 'approved', { mode: 'kazoku' }));
  await setDoc(m(db, 'other'), member('kazoku', 'approved', { mode: 'kazoku' }));
  await setDoc(m(db, 'person'), member('honnin', 'approved', { mode: 'honnin' }));
  await setDoc(m(db, 'legacy'), { name: '本人', role: 'honnin', joinedAt: Timestamp.now() });
  await setDoc(m(db, 'waiting'), member('kazoku', 'pending', { mode: 'kazoku', inviteCode: 'X' }));
  await setDoc(doc(db, 'groups', 'away'), { createdBy: 'outsider', createdAt: Timestamp.now() });
  await setDoc(m(db, 'outsider', 'away'), member('kazoku', 'approved', { mode: 'kazoku' }));
});
try {
  await allowed('1. 自分の名前を変えられる', () => rename(as('other'), 'other', 'りえ'));
  await allowed('2. 管理者は、ご本人の名前を変えられる', () => rename(as('owner'), 'person', '花子（おばあちゃん）'));
  await allowed('3. 管理者でない家族も、ご本人の名前を変えられる', () => rename(as('other'), 'person', '花子'));
  await allowed('4. ご本人は、自分の名前を変えられる', () => rename(as('person'), 'person', 'はなこ'));
  await allowed('5. mode のない古い記録のご本人(role だけ)も変えられる', () => rename(as('other'), 'legacy', '花子'));
  await denied('6. ほかの家族(ご本人ではない)の名前は変えられない', () => rename(as('other'), 'owner', 'へんな名前'));
  await denied('7. ご本人の画面から、家族の名前は変えられない', () => rename(as('person'), 'other', 'へんな名前'));
  await denied('8. 家庭の外の人は、ご本人の名前を変えられない', () => rename(as('outsider'), 'person', 'へんな名前'));
  await denied('9. 承認待ちの人は、自分の名前も変えられない', () => rename(as('waiting'), 'waiting', 'たろう'));
  await denied('10. 空の名前にはできない', () => rename(as('other'), 'other', ''));
  await denied('11. 81文字以上にはできない', () => rename(as('other'), 'other', 'あ'.repeat(81)));
  await denied('12. 名前と一緒に、使い方(mode)は変えられない', () => rename(as('other'), 'person', '花子', 'home', { mode: 'kazoku' }));
  await denied('13. 名前と一緒に、承認(status)は変えられない', () => rename(as('waiting'), 'waiting', 'たろう', 'home', { status: 'approved' }));
  await denied('14. 名前と一緒に、役割(role)は変えられない', () => rename(as('other'), 'other', 'りえ', 'home', { role: 'honnin' }));
  await denied('15. 名前は文字だけ', () => rename(as('other'), 'other', 123));
  console.log('名前を変える: ' + checked + '件 passed');
} finally { await env.cleanup(); }
