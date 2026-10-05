import {consentFixture} from './helpers/consent-fixture.mjs';
/* 再接続QR(reconnectCodes・2026-10-05、2026-10-06 審査対応)のルール動作検査。Firestoreエミュレーターで実行 */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, deleteDoc, updateDoc, collection, serverTimestamp, Timestamp, deleteField } from 'firebase/firestore';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

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
  const as = (u, claims) => env.authenticatedContext(u, claims).firestore();
  const f1 = as('f1'), f2 = as('f2'), h1 = as('h1'), p1 = as('p1'), x1 = as('x1');
  // 文書IDはコードそのものではなく SHA-256("reconnect\n"+コード) の16進64文字
  const H = (c) => createHash('sha256').update('reconnect\n' + c).digest('hex');
  const C = H('ABCDEFGH23456789');
  const code = (by, extra = {}) => ({ groupId: 'g1', targetUid: 'h1', createdBy: by, createdAt: serverTimestamp(), expiresAt: inMin(10), ...extra });
  await check('1. 承認済みの家族は、ご本人あての再接続コードを作れる', setDoc(doc(f1, 'reconnectCodes', C), code('f1')), true);
  await check('2. 作った家族は、確認できる', getDoc(doc(f1, 'reconnectCodes', C)), true);
  await check('3. ほかの家族は読めない', getDoc(doc(f2, 'reconnectCodes', C)), false);
  await check('4. ご本人も読めない(コードはサーバーだけが照合する)', getDoc(doc(h1, 'reconnectCodes', C)), false);
  await check('5. 一覧は読めない', getDocs(collection(f1, 'reconnectCodes')), false);
  await check('6. 書き換えられない', updateDoc(doc(f1, 'reconnectCodes', C), { expiresAt: inMin(60) }), false);
  await check('7. ほかの家族は取り消せない', deleteDoc(doc(f2, 'reconnectCodes', C)), false);
  await check('8. 作った家族は取り消せる', deleteDoc(doc(f1, 'reconnectCodes', C)), true);
  await check('9. 12分以上のコードは作れない', setDoc(doc(f1, 'reconnectCodes', H('A9')), code('f1', { expiresAt: inMin(12) })), false);
  await check('10. コードそのもの(16文字)を文書IDにしては作れない', setDoc(doc(f1, 'reconnectCodes', 'ABCDEFGH2345678A'), code('f1')), false);
  await check('10b. 64文字でも16進でなければ作れない', setDoc(doc(f1, 'reconnectCodes', 'G'.repeat(64)), code('f1')), false);
  await check('11. ご本人あてでないコード(家族あて)は作れない', setDoc(doc(f1, 'reconnectCodes', H('B')), code('f1', { targetUid: 'f2' })), false);
  await check('12. ご本人は自分あてのコードを作れない', setDoc(doc(h1, 'reconnectCodes', H('C')), code('h1')), false);
  await check('13. 承認待ちの人は作れない', setDoc(doc(p1, 'reconnectCodes', H('D')), code('p1')), false);
  await check('14. ほかの家庭の家族は作れない', setDoc(doc(x1, 'reconnectCodes', H('E')), code('x1')), false);
  await check('15. ほかの人の名前では作れない', setDoc(doc(f2, 'reconnectCodes', H('F')), code('f1')), false);
  await check('16. 決めた項目以外は入れられない', setDoc(doc(f1, 'reconnectCodes', H('G')), code('f1', { uid: 'h1' })), false);
  await check('17. 作った時刻はサーバーの時刻だけ', setDoc(doc(f1, 'reconnectCodes', H('H')), code('f1', { createdAt: Timestamp.fromMillis(0) })), false);

  // ---- 再接続で入ってから24時間は、取り消しにくい操作を止める(recentReconnect) ----
  const nowS = Math.floor(Date.now() / 1000);
  const fresh = { via: 'reconnect', auth_time: nowS - 3600 };          // 1時間前に再接続で入った
  const old = { via: 'reconnect', auth_time: nowS - 25 * 3600 };       // 25時間前
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    // ご本人が管理者(本人モードで家庭を作った)の家庭
    for (const id of ['h3', 'k3', 'q3', 'q4', 'q5']) await setDoc(doc(db, 'consents', id), consentFixture(Timestamp.now()));
    await setDoc(doc(db, 'groups', 'g3'), { createdBy: 'h3', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'g3', 'members', 'h3'), { status: 'approved', role: 'honnin', mode: 'honnin' });
    await setDoc(doc(db, 'groups', 'g3', 'members', 'k3'), { status: 'approved', role: 'kazoku', mode: 'kazoku' });
    for (const q of ['q3', 'q4', 'q5']) await setDoc(doc(db, 'groups', 'g3', 'members', q), { status: 'pending', role: 'kazoku', mode: 'kazoku' });
  });
  const hFresh = as('h3', fresh), hOld = as('h3', old), hPlain = as('h3'), fFresh = as('f1', fresh), fOld = as('f1', old);
  const hk = (by) => ({ type: 'hitokoe-consent', uid: 'h3', requestId: 'r1', answer: 'yes', clientAt: Date.now(), date: '2026-10-06', at: serverTimestamp() });
  await check('20. 24時間以内: 家庭の削除を始められない', updateDoc(doc(hFresh, 'groups', 'g3'), { deletionState: 'deleting', deletionStartedAt: serverTimestamp() }), false);
  await check('21. 24時間以内: 参加を承認できない', updateDoc(doc(hFresh, 'groups', 'g3', 'members', 'q3'), { status: 'approved' }), false);
  await check('22. 24時間以内: ほかの家族を解除できない', deleteDoc(doc(hFresh, 'groups', 'g3', 'members', 'q5')), false);
  await check('23. 24時間以内: 管理者の交代を頼めない', updateDoc(doc(hFresh, 'groups', 'g3'), { pendingOwner: 'k3', pendingOwnerAt: serverTimestamp() }), false);
  await check('24. 24時間以内: ひと声の了解を書けない', setDoc(doc(hFresh, 'groups', 'g3', 'events', 'hk1'), hk()), false);
  await check('25. 24時間以内: アカウントの終了手続きを始められない', setDoc(doc(hFresh, 'accountClosures', 'h3'), { requestedAt: serverTimestamp() }), false);
  await check('26. 24時間以内: 再接続コードを作れない', setDoc(doc(fFresh, 'reconnectCodes', H('R1')), code('f1')), false);
  await check('27. 24時間以内でも、ふつうの記録は書ける', setDoc(doc(hFresh, 'groups', 'g3', 'events', 'ok1'), { type: 'aisatsu', uid: 'h3', text: 'おはよう', date: '2026-10-06', at: serverTimestamp(), clientAt: Date.now() }), true);
  await check('28. 印のない鍵(LINEでログイン・ふつうのログイン)は今まで通り承認できる', updateDoc(doc(hPlain, 'groups', 'g3', 'members', 'q4'), { status: 'approved' }), true);
  await check('29. 24時間を過ぎたら: 参加を承認できる', updateDoc(doc(hOld, 'groups', 'g3', 'members', 'q3'), { status: 'approved' }), true);
  await check('30. 24時間を過ぎたら: ひと声の了解を書ける', setDoc(doc(hOld, 'groups', 'g3', 'events', 'hk2'), hk()), true);
  await check('31. 24時間を過ぎたら: 再接続コードを作れる', setDoc(doc(fOld, 'reconnectCodes', H('R2')), code('f1')), true);
  await check('32. 24時間を過ぎたら: 管理者の交代を頼める', updateDoc(doc(hOld, 'groups', 'g3'), { pendingOwner: 'k3', pendingOwnerAt: serverTimestamp() }), true);
  await check('33. 24時間を過ぎたら: ほかの家族を解除できる', deleteDoc(doc(hOld, 'groups', 'g3', 'members', 'q5')), true);
  await env.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), 'groups', 'g3'), { pendingOwner: deleteField(), pendingOwnerAt: deleteField() }); });
  await check('34. 24時間を過ぎたら: 家庭の削除を始められる', updateDoc(doc(hOld, 'groups', 'g3'), { deletionState: 'deleting', deletionStartedAt: serverTimestamp() }), true);
  await check('35. 24時間を過ぎたら: アカウントの終了手続きを始められる', setDoc(doc(hOld, 'accountClosures', 'h3'), { requestedAt: serverTimestamp() }), true);

  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'groups', 'g1'), { createdBy: 'f1', createdAt: Timestamp.now(), deletionState: 'deleting' }); });
  await check('18. 削除中の家庭では作れない', setDoc(doc(f1, 'reconnectCodes', H('J')), code('f1')), false);
  console.log('\n===== 検査結果 =====');
  for (const [mark, name] of results) console.log(mark, name);
  const ok = results.filter((r) => r[0] === '✅').length;
  console.log(`\n${results.length}件中 ${ok}件が期待どおり（再接続QR）`);
  process.exitCode = ok === results.length ? 0 : 1;
} finally { await env.cleanup(); }
