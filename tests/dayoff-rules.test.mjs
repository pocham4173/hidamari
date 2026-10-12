import {consentFixture} from './helpers/consent-fixture.mjs';
/* 家族の仕事の休み(2026-10-12 ヒビルカのカレンダーから)のルール動作検査。Firestoreエミュレーターで実行 */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, deleteDoc, collection, serverTimestamp, deleteField, Timestamp } from 'firebase/firestore';
import fs from 'node:fs';

const env = await initializeTestEnvironment({
  projectId: 'demo-mainico',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
const results = [];
async function check(name, promise, expectOk) {
  try {
    if (expectOk) await assertSucceeds(promise); else await assertFails(promise);
    results.push(['✅', name]);
  } catch (error) {
    results.push(['❌', `${name} — ${String(error).split('\n')[0].slice(0, 120)}`]);
  }
}
try {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const id of ['m1', 'm2', 'p1', 'o1']) await setDoc(doc(db, 'consents', id), consentFixture(Timestamp.now()));
    await setDoc(doc(db, 'groups', 'g1'), { createdBy: 'm1', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm1'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm2'), { status: 'approved', mode: 'honnin' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'p1'), { status: 'pending' });
    await setDoc(doc(db, 'groups', 'g9'), { createdBy: 'o1', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'g9', 'members', 'o1'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g2'), { createdBy: 'm1', createdAt: Timestamp.now(), deletionState: 'deleting' });
    await setDoc(doc(db, 'groups', 'g2', 'members', 'm1'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g2', 'dayoff', 'm2'), { days: { '2026-10-01': 'off' } });
  });
  const as = (uid) => env.authenticatedContext(uid).firestore();
  const m1 = as('m1'), m2 = as('m2'), p1 = as('p1'), o1 = as('o1'), nc = as('noconsent');
  const off = (days) => ({ days, updatedAt: serverTimestamp() });
  const big = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`2026-01-01-${i}`, 'off']));

  await check('1. 承認済みの家族は、自分の休みを入れられる', setDoc(doc(m1, 'groups', 'g1', 'dayoff', 'm1'), off({ '2026-10-08': 'off' }), { merge: true }), true);
  await check('2. 1日ずつ足せる', setDoc(doc(m1, 'groups', 'g1', 'dayoff', 'm1'), off({ '2026-10-09': 'off' }), { merge: true }), true);
  await check('3. 1日ずつ消せる', setDoc(doc(m1, 'groups', 'g1', 'dayoff', 'm1'), { days: { '2026-10-09': deleteField() }, updatedAt: serverTimestamp() }, { merge: true }), true);
  await check('4. 家庭のほかの人(ご本人)も読める', getDoc(doc(m2, 'groups', 'g1', 'dayoff', 'm1')), true);
  await check('5. 家庭の全員分の一覧も読める', getDocs(collection(m2, 'groups', 'g1', 'dayoff')), true);
  await check('6. ほかの人の休みは書けない', setDoc(doc(m2, 'groups', 'g1', 'dayoff', 'm1'), off({ '2026-10-10': 'off' }), { merge: true }), false);
  await check('7. ほかの人の休みは消せない', deleteDoc(doc(m2, 'groups', 'g1', 'dayoff', 'm1')), false);
  await check('8. ほかの家庭の人は読めない', getDoc(doc(o1, 'groups', 'g1', 'dayoff', 'm1')), false);
  await check('9. ほかの家庭の人は一覧も読めない', getDocs(collection(o1, 'groups', 'g1', 'dayoff')), false);
  await check('10. 承認待ちの人は読めない', getDoc(doc(p1, 'groups', 'g1', 'dayoff', 'm1')), false);
  await check('11. 承認待ちの人は書けない', setDoc(doc(p1, 'groups', 'g1', 'dayoff', 'p1'), off({ '2026-10-08': 'off' })), false);
  await check('12. 同意していない人は書けない', setDoc(doc(nc, 'groups', 'g1', 'dayoff', 'noconsent'), off({ '2026-10-08': 'off' })), false);
  await check('13. 決めた項目以外(名前など)は入れられない', setDoc(doc(m1, 'groups', 'g1', 'dayoff', 'm1'), { ...off({}), name: '理絵' }, { merge: true }), false);
  await check('14. 400日を超えては入れられない', setDoc(doc(m1, 'groups', 'g1', 'dayoff', 'm1'), off(big)), false);
  await check('15. 時刻はサーバーの時刻だけ', setDoc(doc(m1, 'groups', 'g1', 'dayoff', 'm1'), { days: {}, updatedAt: Timestamp.fromMillis(0) }), false);
  await check('16. days は一覧(map)だけ', setDoc(doc(m1, 'groups', 'g1', 'dayoff', 'm1'), { days: 'off', updatedAt: serverTimestamp() }), false);
  await check('17. 削除中の家庭には書けない', setDoc(doc(m1, 'groups', 'g2', 'dayoff', 'm1'), off({ '2026-10-08': 'off' })), false);
  await check('18. 家庭を消している管理者は、全員分を消せる', deleteDoc(doc(m1, 'groups', 'g2', 'dayoff', 'm2')), true);
  await check('19. 自分の休みはまとめて消せる(参加解除のとき)', deleteDoc(doc(m1, 'groups', 'g1', 'dayoff', 'm1')), true);
  await check('20. 未ログインでは読めない', getDoc(doc(env.unauthenticatedContext().firestore(), 'groups', 'g1', 'dayoff', 'm1')), false);

  console.log('\n===== 検査結果 =====');
  for (const [mark, name] of results) console.log(mark, name);
  const ok = results.filter((r) => r[0] === '✅').length;
  console.log(`\n${results.length}件中 ${ok}件が期待どおり`);
  process.exitCode = ok === results.length ? 0 : 1;
} finally {
  await env.cleanup();
}
