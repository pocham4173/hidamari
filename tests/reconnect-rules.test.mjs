import {consentFixture} from './helpers/consent-fixture.mjs';
/* 再接続QR(reconnectCodes・2026-10-05)のルール動作検査。Firestoreエミュレーターで実行 */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, deleteDoc, updateDoc, collection, serverTimestamp, Timestamp } from 'firebase/firestore';
import fs from 'node:fs';

const env = await initializeTestEnvironment({
  projectId: 'demo-mainico',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
const results = [];
async function check(name, promise, expectOk) {
  try { if (expectOk) await assertSucceeds(promise); else await assertFails(promise); results.push(['✅', name]); }
  catch (error) { results.push(['❌', `${name} — ${String(error).split('\n')[0].slice(0, 120)}`]); }
}
const inMin = (m) => Timestamp.fromMillis(Date.now() + m * 60000);
try {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    for (const id of ['f1', 'f2', 'h1', 'p1', 'x1']) await setDoc(doc(db, 'consents', id), consentFixture(Timestamp.now()));
    await setDoc(doc(db, 'groups', 'g1'), { createdBy: 'f1', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'f1'), { status: 'approved', mode: 'kazoku' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'f2'), { status: 'approved', mode: 'kazoku' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'h1'), { status: 'approved', role: 'honnin', mode: 'honnin' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'p1'), { status: 'pending', mode: 'kazoku' });
    await setDoc(doc(db, 'groups', 'g2'), { createdBy: 'x1', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'g2', 'members', 'x1'), { status: 'approved', mode: 'kazoku' });
  });
  const as = (u) => env.authenticatedContext(u).firestore();
  const f1 = as('f1'), f2 = as('f2'), h1 = as('h1'), p1 = as('p1'), x1 = as('x1');
  const C = 'ABCDEFGH23456789';
  const code = (by, extra = {}) => ({ groupId: 'g1', targetUid: 'h1', createdBy: by, createdAt: serverTimestamp(), expiresAt: inMin(10), ...extra });
  await check('1. 承認済みの家族は、ご本人あての再接続コードを作れる', setDoc(doc(f1, 'reconnectCodes', C), code('f1')), true);
  await check('2. 作った家族は、確認できる', getDoc(doc(f1, 'reconnectCodes', C)), true);
  await check('3. ほかの家族は読めない', getDoc(doc(f2, 'reconnectCodes', C)), false);
  await check('4. ご本人も読めない(コードはサーバーだけが照合する)', getDoc(doc(h1, 'reconnectCodes', C)), false);
  await check('5. 一覧は読めない', getDocs(collection(f1, 'reconnectCodes')), false);
  await check('6. 書き換えられない', updateDoc(doc(f1, 'reconnectCodes', C), { expiresAt: inMin(60) }), false);
  await check('7. ほかの家族は取り消せない', deleteDoc(doc(f2, 'reconnectCodes', C)), false);
  await check('8. 作った家族は取り消せる', deleteDoc(doc(f1, 'reconnectCodes', C)), true);
  await check('9. 12分以上のコードは作れない', setDoc(doc(f1, 'reconnectCodes', 'ABCDEFGH2345678A'), code('f1', { expiresAt: inMin(12) })), false);
  await check('10. 形のちがうコード(16文字でない・使わない文字)は作れない', setDoc(doc(f1, 'reconnectCodes', 'ABCDEFGH234567I1'), code('f1')), false);
  await check('11. ご本人あてでないコード(家族あて)は作れない', setDoc(doc(f1, 'reconnectCodes', 'ABCDEFGH2345678B'), code('f1', { targetUid: 'f2' })), false);
  await check('12. ご本人は自分あてのコードを作れない', setDoc(doc(h1, 'reconnectCodes', 'ABCDEFGH2345678C'), code('h1')), false);
  await check('13. 承認待ちの人は作れない', setDoc(doc(p1, 'reconnectCodes', 'ABCDEFGH2345678D'), code('p1')), false);
  await check('14. ほかの家庭の家族は作れない', setDoc(doc(x1, 'reconnectCodes', 'ABCDEFGH2345678E'), code('x1')), false);
  await check('15. ほかの人の名前では作れない', setDoc(doc(f2, 'reconnectCodes', 'ABCDEFGH2345678F'), code('f1')), false);
  await check('16. 決めた項目以外は入れられない', setDoc(doc(f1, 'reconnectCodes', 'ABCDEFGH2345678G'), code('f1', { uid: 'h1' })), false);
  await check('17. 作った時刻はサーバーの時刻だけ', setDoc(doc(f1, 'reconnectCodes', 'ABCDEFGH2345678H'), code('f1', { createdAt: Timestamp.fromMillis(0) })), false);
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'groups', 'g1'), { createdBy: 'f1', createdAt: Timestamp.now(), deletionState: 'deleting' }); });
  await check('18. 削除中の家庭では作れない', setDoc(doc(f1, 'reconnectCodes', 'ABCDEFGH2345678J'), code('f1')), false);
  console.log('\n===== 検査結果 =====');
  for (const [mark, name] of results) console.log(mark, name);
  const ok = results.filter((r) => r[0] === '✅').length;
  console.log(`\n${results.length}件中 ${ok}件が期待どおり（再接続QR）`);
  process.exitCode = ok === results.length ? 0 : 1;
} finally { await env.cleanup(); }
