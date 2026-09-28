import {consentFixture} from './helpers/consent-fixture.mjs';
/* LINEで予定のお知らせ（2026-09-26）のルール動作検査（12ケース）。Firestoreエミュレーターで実行 */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
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
const inMin = (m) => Timestamp.fromMillis(Date.now() + m * 60 * 1000);
const yotei = (uid, extra) => ({
  kind: '📌', date: '2026-10-01', time: '13:30', label: '通院', color: '#3D6FB4', repeat: 'none',
  uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra,
});
const code = (uid, groupId, minutes) => ({ uid, groupId, createdAt: serverTimestamp(), expiresAt: inMin(minutes) });

try {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const id of ['m1', 'm2', 'p1']) await setDoc(doc(db, 'consents', id), consentFixture(Timestamp.now()));
    await setDoc(doc(db, 'groups', 'g1'), { createdBy: 'm1', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm1'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm2'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'p1'), { status: 'pending' });
    await setDoc(doc(db, 'lineLinks', 'm1'), { lineUserId: 'U1', groupId: 'g1', linkedAt: Timestamp.now() });
    await setDoc(doc(db, 'lineLinks', 'm2'), { lineUserId: 'U2', groupId: 'g1', linkedAt: Timestamp.now() });
  });
  const as = (uid) => env.authenticatedContext(uid).firestore();
  const m1 = as('m1'), m2 = as('m2'), p1 = as('p1');

  await check('1. 場所とLINEで知らせる日時つきの予定を作成できる',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y1'), yotei('m1', { place: '上田市サントミューゼ', notifyAt: inMin(60) })), true);
  await check('2. 知らせない予定(notifyAt=null)も作成できる',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y2'), yotei('m1', { place: '', notifyAt: null })), true);
  await check('3. 61文字以上の場所は拒否される',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y3'), yotei('m1', { place: 'あ'.repeat(61) })), false);
  await check('4. 送信済みの印(notifiedAt)は画面からは書けない',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y4'), yotei('m1', { notifiedAt: Timestamp.now() })), false);
  await check('5. 自分の予定の場所・知らせる日時を修正できる',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y1'), { place: '上田駅', notifyAt: inMin(120), updatedAt: serverTimestamp() }, { merge: true }), true);
  await check('6. 承認済みの人は10分有効の連携コードを作れる',
    setDoc(doc(m1, 'lineLinkCodes', 'ABCD2345'), code('m1', 'g1', 10)), true);
  await check('7. 承認待ちの人は連携コードを作れない',
    setDoc(doc(p1, 'lineLinkCodes', 'EFGH2345'), code('p1', 'g1', 10)), false);
  await check('8. 他人名義の連携コードは作れない',
    setDoc(doc(m2, 'lineLinkCodes', 'JKLM2345'), code('m1', 'g1', 10)), false);
  await check('9. 有効期限が長すぎるコードは作れない',
    setDoc(doc(m1, 'lineLinkCodes', 'NPQR2345'), code('m1', 'g1', 60)), false);
  await check('10. 画面から連携(lineLinks)を作ることはできない',
    setDoc(doc(m2, 'lineLinks', 'm2'), { lineUserId: 'Uevil', groupId: 'g1', linkedAt: serverTimestamp() }), false);
  await check('11. 他人の連携状態は読めない',
    getDoc(doc(m2, 'lineLinks', 'm1')), false);
  await check('12. 自分の連携は確認・解除できる',
    getDoc(doc(m2, 'lineLinks', 'm2')).then(() => deleteDoc(doc(m2, 'lineLinks', 'm2'))), true);
  await check('13. 分類つきの予定を作成できる',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y5'), yotei('m1', { category: '病院・通院' })), true);
  await check('14. 21文字以上の分類は拒否される',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y6'), yotei('m1', { category: 'あ'.repeat(21) })), false);
  await check('15. 自分の予定の分類を変更できる',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y5'), { category: 'デイサービス', updatedAt: serverTimestamp() }, { merge: true }), true);
  await check('16. 他人の予定の分類は変更できない',
    setDoc(doc(m2, 'groups', 'g1', 'yotei', 'y5'), { category: '買い物', updatedAt: serverTimestamp() }, { merge: true }), false);

  console.log('\n===== 検査結果 =====');
  for (const [mark, name] of results) console.log(mark, name);
  const ok = results.filter((r) => r[0] === '✅').length;
  console.log(`\n${results.length}件中 ${ok}件が期待どおり`);
  process.exitCode = ok === results.length ? 0 : 1;
} finally {
  await env.cleanup();
}
