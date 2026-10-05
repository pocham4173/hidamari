import {consentFixture} from './helpers/consent-fixture.mjs';
/* 家族の1分アンケート(2026-10-05)のルール動作検査。Firestoreエミュレーターで実行 */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, deleteDoc, collection, query, where, serverTimestamp, Timestamp } from 'firebase/firestore';
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
    for (const id of ['m1', 'm2', 'p1']) await setDoc(doc(db, 'consents', id), consentFixture(Timestamp.now()));
    await setDoc(doc(db, 'groups', 'g1'), { createdBy: 'm1', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm1'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm2'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'p1'), { status: 'pending' });
    await setDoc(doc(db, 'groups', 'g2'), { createdBy: 'x', createdAt: Timestamp.now(), deletionState: 'deleting' });
    await setDoc(doc(db, 'groups', 'g2', 'members', 'm1'), { status: 'approved' });
  });
  const as = (uid) => env.authenticatedContext(uid).firestore();
  const m1 = as('m1'), m2 = as('m2'), p1 = as('p1'), nc = as('noconsent');
  const ans = (uid, extra = {}) => ({ uid, groupId: 'g1', month: '2026-10', kind: 'baseline', absences: 2, burden: '', answeredAt: serverTimestamp(), ...extra });

  await check('1. 承認済みの家族は、使う前の1か月の答え(baseline)を保存できる', setDoc(doc(m1, 'surveyAnswers', 'm1_2026-10'), ans('m1')), true);
  await check('2. 毎月の答え(monthly)を保存できる', setDoc(doc(m1, 'surveyAnswers', 'm1_2026-11'), ans('m1', { month: '2026-11', kind: 'monthly', absences: 0, burden: 'less' })), true);
  await check('3. 同じ月の答えを直せる', setDoc(doc(m1, 'surveyAnswers', 'm1_2026-11'), ans('m1', { month: '2026-11', kind: 'monthly', absences: 1, burden: 'same' })), true);
  await check('4. 自分の答えは読める', getDoc(doc(m1, 'surveyAnswers', 'm1_2026-10')), true);
  await check('5. 自分の答えだけの一覧は読める', getDocs(query(collection(m1, 'surveyAnswers'), where('uid', '==', 'm1'))), true);
  await check('6. ほかの家族の答えは読めない', getDoc(doc(m2, 'surveyAnswers', 'm1_2026-10')), false);
  await check('7. 全員分の一覧は読めない', getDocs(collection(m2, 'surveyAnswers')), false);
  await check('8. ほかの人の名前で保存できない', setDoc(doc(m2, 'surveyAnswers', 'm1_2026-12'), ans('m1', { month: '2026-12' })), false);
  await check('9. ほかの人の答えを上書きできない', setDoc(doc(m2, 'surveyAnswers', 'm1_2026-10'), ans('m2')), false);
  await check('10. 番号と月が合わないと保存できない', setDoc(doc(m2, 'surveyAnswers', 'm2_2026-09'), ans('m2')), false);
  await check('11. 決めた選択肢以外の回数は保存できない', setDoc(doc(m2, 'surveyAnswers', 'm2_2026-10'), ans('m2', { absences: 3 })), false);
  await check('12. 決めた選択肢以外の負担は保存できない', setDoc(doc(m2, 'surveyAnswers', 'm2_2026-10'), ans('m2', { kind: 'monthly', burden: 'とても' })), false);
  await check('13. 使う前の答えに負担は入れられない', setDoc(doc(m2, 'surveyAnswers', 'm2_2026-10'), ans('m2', { burden: 'less' })), false);
  await check('14. 決めた項目以外(名前など)は保存できない', setDoc(doc(m2, 'surveyAnswers', 'm2_2026-10'), ans('m2', { name: 'あに' })), false);
  await check('15. 答えた時刻はサーバーの時刻だけ', setDoc(doc(m2, 'surveyAnswers', 'm2_2026-10'), ans('m2', { answeredAt: Timestamp.fromMillis(0) })), false);
  await check('16. 承認待ちの人は保存できない', setDoc(doc(p1, 'surveyAnswers', 'p1_2026-10'), ans('p1')), false);
  await check('17. 同意していない人は保存できない', setDoc(doc(nc, 'surveyAnswers', 'noconsent_2026-10'), ans('noconsent')), false);
  await check('18. 削除中の家庭の名前では保存できない', setDoc(doc(m1, 'surveyAnswers', 'm1_2026-12'), ans('m1', { groupId: 'g2', month: '2026-12' })), false);
  await check('19. 自分の答えは消せる', deleteDoc(doc(m1, 'surveyAnswers', 'm1_2026-11')), true);
  await check('20. ほかの人の答えは消せない', deleteDoc(doc(m2, 'surveyAnswers', 'm1_2026-10')), false);
  await check('21. 未ログインでは読めない', getDoc(doc(env.unauthenticatedContext().firestore(), 'surveyAnswers', 'm1_2026-10')), false);

  console.log('\n===== 検査結果 =====');
  for (const [mark, name] of results) console.log(mark, name);
  const ok = results.filter((r) => r[0] === '✅').length;
  console.log(`\n${results.length}件中 ${ok}件が期待どおり`);
  process.exitCode = ok === results.length ? 0 : 1;
} finally {
  await env.cleanup();
}
