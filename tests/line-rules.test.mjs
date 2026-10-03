import {consentFixture} from './helpers/consent-fixture.mjs';
/* LINEで予定のお知らせ（2026-09-26）のルール動作検査（12ケース）。Firestoreエミュレーターで実行 */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, deleteDoc, updateDoc, collection, query, where, serverTimestamp, Timestamp } from 'firebase/firestore';
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
  /* 同じ検査用プロジェクトを使う先の検査(alerts)の予定 y1 などが残っていると、
     「作成」が「上書き」扱いになって正しく判定できないため、最初に空にする(2026-10-02) */
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const id of ['m1', 'm2', 'p1', 'h1']) await setDoc(doc(db, 'consents', id), consentFixture(Timestamp.now()));
    await setDoc(doc(db, 'groups', 'g1'), { createdBy: 'm1', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm1'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm2'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'p1'), { status: 'pending' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'h1'), { status: 'approved', role: 'honnin', mode: 'honnin' });
    await setDoc(doc(db, 'lineStatus', 'quota'), { limit: 200, used: 12, remaining: 188, reserve: 50, checkedAt: Timestamp.now() });
    await setDoc(doc(db, 'lineLinks', 'm1'), { lineUserId: 'U1', groupId: 'g1', linkedAt: Timestamp.now() });
    await setDoc(doc(db, 'lineLinks', 'm2'), { lineUserId: 'U2', groupId: 'g1', linkedAt: Timestamp.now() });
  });
  const as = (uid) => env.authenticatedContext(uid).firestore();
  const m1 = as('m1'), m2 = as('m2'), p1 = as('p1'), h1 = as('h1');
  const ev = (uid, extra) => ({ uid, date: '2026-10-01', at: serverTimestamp(), name: 'テスト', ...extra });

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
  /* 記録の種類の制限(2026-10-01) */
  await check('17. アプリの記録(挨拶)は作れる',
    setDoc(doc(h1, 'groups', 'g1', 'events', 'e1'), ev('h1', { type: 'aisatsu', text: 'おはよう', slot: 'asa' })), true);
  await check('18. 決まっていない種類の記録は作れない',
    setDoc(doc(m1, 'groups', 'g1', 'events', 'e2'), ev('m1', { type: 'anything', text: 'x' })), false);
  await check('19. 種類のない記録は作れない',
    setDoc(doc(m1, 'groups', 'g1', 'events', 'e3'), ev('m1', { text: 'x' })), false);
  await check('20. 家族が「LINEで連携した」記録を偽って作れない',
    setDoc(doc(m1, 'groups', 'g1', 'events', 'e4'), ev('m1', { type: 'line-link-log', action: 'linked', via: 'code' })), false);
  await check('21. 家族が「LINEで解除した」記録を偽って作れない',
    setDoc(doc(m1, 'groups', 'g1', 'events', 'e5'), ev('m1', { type: 'line-link-log', action: 'unlinked', via: 'line' })), false);
  await check('22. アプリから解除した記録は作れる',
    setDoc(doc(m1, 'groups', 'g1', 'events', 'e6'), ev('m1', { type: 'line-link-log', action: 'unlinked', via: 'app' })), true);
  await check('23. 「ひと声のきっかけ」の了解は、ご本人なら書ける',
    setDoc(doc(h1, 'groups', 'g1', 'events', 'e7'), ev('h1', { type: 'hitokoe-consent', answer: 'yes', requestId: 'r1' })), true);
  await check('24. 「ひと声のきっかけ」の了解を家族が代わりに書くことはできない',
    setDoc(doc(m1, 'groups', 'g1', 'events', 'e8'), ev('m1', { type: 'hitokoe-consent', answer: 'yes', requestId: 'r1' })), false);
  await check('25. 家族は「ひと声のきっかけ」の設定と「連絡しました」を書ける',
    setDoc(doc(m1, 'groups', 'g1', 'events', 'e9'), ev('m1', { type: 'hitokoe-config', enabled: true, hour: 11, requestId: 'r1' }))
      .then(() => setDoc(doc(m2, 'groups', 'g1', 'events', 'e10'), ev('m2', { type: 'hitokoe-contacted', target: 'h1' }))), true);
  await check('26. 今月のLINEの残り通数は、同意済みの利用者が見られる',
    getDoc(doc(m1, 'lineStatus', 'quota')), true);
  await check('27. 残り通数を画面から書き換えることはできない',
    setDoc(doc(m1, 'lineStatus', 'quota'), { remaining: 9999 }), false);

  /* 送信先の招待と、予定ごとの相手(2026-10-04) */
  const rec = (uid, extra) => ({ groupId: 'g1', name: 'おばあちゃん', status: 'pending', createdBy: uid, createdAt: serverTimestamp(), ...extra });
  const invite = (uid, rid, hours, extra) => ({ groupId: 'g1', recipientId: rid, createdBy: uid, createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + hours * 3600000), ...extra });
  await check('28. 承認済みの家族は送信先(承認待ち)を作れる', setDoc(doc(m1, 'lineRecipients', 'r1'), rec('m1')), true);
  await check('29. 送信先を最初から「登録済み」にはできない', setDoc(doc(m1, 'lineRecipients', 'r2'), rec('m1', { status: 'joined' })), false);
  await check('30. 送信先にLINEの利用者識別子を書けない', setDoc(doc(m1, 'lineRecipients', 'r3'), rec('m1', { lineUserId: 'Uevil' })), false);
  await check('31. 承認待ちの人は送信先を作れない', setDoc(doc(p1, 'lineRecipients', 'r4'), rec('p1')), false);
  await check('32. 41文字以上の名前は拒否される', setDoc(doc(m1, 'lineRecipients', 'r5'), rec('m1', { name: 'あ'.repeat(41) })), false);
  await check('33. 家族は送信先の一覧を見られる', getDocs(query(collection(m2, 'lineRecipients'), where('groupId', '==', 'g1'))), true);
  await check('34. 承認待ちの人は送信先の一覧を見られない', getDocs(query(collection(p1, 'lineRecipients'), where('groupId', '==', 'g1'))), false);
  await check('35. 家族は送信先の名前を変えられる', updateDoc(doc(m2, 'lineRecipients', 'r1'), { name: 'ばあば' }), true);
  await check('36. 家族は送信先を「登録済み」に変えられない', updateDoc(doc(m2, 'lineRecipients', 'r1'), { status: 'joined' }), false);
  await check('37. 家族は7日間の招待を作れる', setDoc(doc(m1, 'lineInvites', 'KNVT234567'), invite('m1', 'r1', 24 * 7)), true);
  await check('38. 8日以上の招待は作れない', setDoc(doc(m1, 'lineInvites', 'KNVT234568'), invite('m1', 'r1', 24 * 8)), false);
  await check('39. 他人名義の招待は作れない', setDoc(doc(m2, 'lineInvites', 'KNVT234569'), invite('m1', 'r1', 24)), false);
  await check('40. 存在しない送信先への招待は作れない', setDoc(doc(m1, 'lineInvites', 'KNVT23456A'), invite('m1', 'nope', 24)), false);
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'lineRecipients', 'rJ'), { groupId: 'g1', name: '登録済み', status: 'joined', createdBy: 'm1', lineName: 'X' });
    await setDoc(doc(c.firestore(), 'lineRecipientIds', 'rJ'), { groupId: 'g1', lineUserId: 'Ux' });
  });
  await check('41. 登録済みの送信先への招待は作れない', setDoc(doc(m1, 'lineInvites', 'KNVT23456B'), invite('m1', 'rJ', 24)), false);
  await check('42. 送信役用の控え(LINEの利用者識別子)は画面から読めない', getDoc(doc(m1, 'lineRecipientIds', 'rJ')), false);
  await check('43. 家族は送信先を削除できる', deleteDoc(doc(m2, 'lineRecipients', 'rJ')), true);
  await check('44. 知らせる相手(notifyTo)つきの予定を作れる',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y7'), yotei('m1', { notifyAt: inMin(60), notifyTo: ['u:m1', 'r:r1'] })), true);
  await check('45. 自分の予定の知らせる相手を変えられる',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y7'), { notifyTo: null, updatedAt: serverTimestamp() }, { merge: true }), true);
  await check('46. 21件以上の相手は拒否される',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y8'), yotei('m1', { notifyTo: Array.from({ length: 21 }, (_, i) => 'u:' + i) })), false);

  console.log('\n===== 検査結果 =====');
  for (const [mark, name] of results) console.log(mark, name);
  const ok = results.filter((r) => r[0] === '✅').length;
  console.log(`\n${results.length}件中 ${ok}件が期待どおり`);
  process.exitCode = ok === results.length ? 0 : 1;
} finally {
  await env.cleanup();
}
