import {consentFixture} from './helpers/consent-fixture.mjs';
/* 世帯の分離テスト(2026-10-05・事業計画書 第2版「準備」段階の条件「他世帯のデータが見えないこと」)。
   2つの家庭を作り、家庭Bの家族が、家庭Aのどの記録も 読めない・一覧できない・作れない・変えられない・消せない ことを、
   Firestore のルールが扱う全部の場所について確かめる。Firestoreエミュレーターで実行。
   最初に「家庭Aの家族は読める」ことも確かめ、拒否が「記録が無いから」ではないことを示す。 */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, query, where, serverTimestamp, Timestamp } from 'firebase/firestore';
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
const TAG = 'A'.repeat(32), TAG_B = 'B'.repeat(32);
const later = (m) => Timestamp.fromMillis(Date.now() + m * 60000);

try {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    const now = Timestamp.now();
    for (const id of ['a1', 'h1', 'b1', 'b2', 'p1']) await setDoc(doc(db, 'consents', id), consentFixture(now));
    // 家庭A: 管理者 a1・ご本人 h1
    await setDoc(doc(db, 'groups', 'gA'), { createdBy: 'a1', createdAt: now });
    await setDoc(doc(db, 'groups', 'gA', 'members', 'a1'), { name: 'えー', status: 'approved' });
    await setDoc(doc(db, 'groups', 'gA', 'members', 'h1'), { name: 'ほんにん', status: 'approved', role: 'honnin', mode: 'honnin' });
    await setDoc(doc(db, 'accounts', 'a1'), { groupId: 'gA', updatedAt: now });
    await setDoc(doc(db, 'groups', 'gA', 'events', 'e1'), { type: 'kibun', uid: 'h1', date: '2026-10-05', at: now, name: 'ほんにん', value: '体調の記録' });
    await setDoc(doc(db, 'groups', 'gA', 'yotei', 'y1'), { kind: '🏥', date: '2026-10-06', time: '10:00', label: '通院', color: '#3D6FB4', repeat: 'none', uid: 'a1', createdAt: now, updatedAt: now, place: '病院' });
    await setDoc(doc(db, 'groups', 'gA', 'settings', 'watchTag'), { watchTagId: TAG, watchTagActive: true, watchTagUpdatedAt: now });
    await setDoc(doc(db, 'groups', 'gA', 'lineShareConsents', 'a1'), { version: 'line-share-20261004', acceptedAt: now, honninAgreed: true, name: 'えー' });
    await setDoc(doc(db, 'watchTags', TAG), { groupId: 'gA', active: true, createdBy: 'a1', createdAt: now, consentVersion: '2026-09-19.1', consentedAt: now });
    await setDoc(doc(db, 'watchTags', TAG, 'alerts', 'finder'), { type: 'found', situation: 'lost', count: 1, senderUid: 'finder', createdAt: now });
    await setDoc(doc(db, 'invites', 'ABCD2345'), { groupId: 'gA', createdBy: 'a1', createdAt: now, expiresAt: later(600), used: false });
    await setDoc(doc(db, 'lineRecipients', 'rA'), { groupId: 'gA', name: 'ヘルパーさん', status: 'joined', createdBy: 'a1', createdAt: now });
    await setDoc(doc(db, 'lineRecipientIds', 'rA'), { groupId: 'gA', lineUserId: 'Uhelper' });
    await setDoc(doc(db, 'lineInvites', 'KNVT234567'), { groupId: 'gA', recipientId: 'rA', createdBy: 'a1', createdAt: now, expiresAt: later(600) });
    await setDoc(doc(db, 'lineLinks', 'a1'), { groupId: 'gA', lineUserId: 'Ua1', linkedAt: now });
    await setDoc(doc(db, 'lineLinkCodes', 'EFGH2345'), { uid: 'a1', groupId: 'gA', createdAt: now, expiresAt: later(10) });
    await setDoc(doc(db, 'surveyAnswers', 'a1_2026-10'), { uid: 'a1', groupId: 'gA', month: '2026-10', kind: 'baseline', absences: 2, burden: '', answeredAt: now });
    await setDoc(doc(db, 'usageStats', 'uA'), { groupId: 'gA', start: '2026-10-01', through: '2026-10-04', honnin: true, days: {} });
    await setDoc(doc(db, 'ops', 'operator'), { lineUserId: 'Uop', at: now });
    // 家庭B: 管理者 b1・家族 b2。家庭Aへの参加を申請中(承認待ち)の p1
    await setDoc(doc(db, 'groups', 'gB'), { createdBy: 'b1', createdAt: now });
    await setDoc(doc(db, 'groups', 'gB', 'members', 'b1'), { name: 'びー', status: 'approved' });
    await setDoc(doc(db, 'groups', 'gB', 'members', 'b2'), { name: 'びー2', status: 'approved' });
    await setDoc(doc(db, 'accounts', 'b1'), { groupId: 'gB', updatedAt: now });
    await setDoc(doc(db, 'groups', 'gA', 'members', 'p1'), { name: '申請中', status: 'pending', inviteCode: 'ZZZZ2345' });
    await setDoc(doc(db, 'watchTags', TAG_B), { groupId: 'gB', active: true, createdBy: 'b1', createdAt: now, consentVersion: '2026-09-19.1', consentedAt: now });
  });
  const A = env.authenticatedContext('a1').firestore();
  const B = env.authenticatedContext('b1').firestore();
  const P = env.authenticatedContext('p1').firestore();
  const N = env.unauthenticatedContext().firestore();

  // ---- 確かめの前提: 家庭Aの家族は、自分の家庭の記録を読める(記録はちゃんと有る) ----
  await check('前提1. 家庭Aの家族は、自分の家庭の記録を読める', getDoc(doc(A, 'groups', 'gA', 'events', 'e1')), true);
  await check('前提2. 家庭Aの家族は、自分の家庭の予定を読める', getDoc(doc(A, 'groups', 'gA', 'yotei', 'y1')), true);
  await check('前提3. 家庭Aの家族は、自分の家庭のおまもりタグを読める', getDoc(doc(A, 'watchTags', TAG)), true);
  await check('前提4. 家庭Aの家族は、自分の家庭の送信先を読める', getDocs(query(collection(A, 'lineRecipients'), where('groupId', '==', 'gA'))), true);

  // ---- 家庭Bの家族は、家庭Aを読めない ----
  const R = [
    ['家庭の情報', getDoc(doc(B, 'groups', 'gA'))],
    ['家庭の一覧(作成者で探す)', getDocs(query(collection(B, 'groups'), where('createdBy', '==', 'a1')))],
    ['家族の名簿(1人)', getDoc(doc(B, 'groups', 'gA', 'members', 'a1'))],
    ['家族の名簿(一覧)', getDocs(collection(B, 'groups', 'gA', 'members'))],
    ['記録(挨拶・体調・薬など)(1件)', getDoc(doc(B, 'groups', 'gA', 'events', 'e1'))],
    ['記録(一覧)', getDocs(collection(B, 'groups', 'gA', 'events'))],
    ['記録(日付で探す)', getDocs(query(collection(B, 'groups', 'gA', 'events'), where('date', '==', '2026-10-05')))],
    ['予定(1件)', getDoc(doc(B, 'groups', 'gA', 'yotei', 'y1'))],
    ['予定(一覧)', getDocs(collection(B, 'groups', 'gA', 'yotei'))],
    ['おまもりタグの設定', getDoc(doc(B, 'groups', 'gA', 'settings', 'watchTag'))],
    ['送信先への同意', getDoc(doc(B, 'groups', 'gA', 'lineShareConsents', 'a1'))],
    ['送信先への同意(一覧)', getDocs(collection(B, 'groups', 'gA', 'lineShareConsents'))],
    ['おまもりタグ本体', getDoc(doc(B, 'watchTags', TAG))],
    ['おまもりタグの一覧(家庭で探す)', getDocs(query(collection(B, 'watchTags'), where('groupId', '==', 'gA')))],
    ['おまもりタグの読み取り記録', getDocs(collection(B, 'watchTags', TAG, 'alerts'))],
    ['招待コードの一覧(家庭で探す)', getDocs(query(collection(B, 'invites'), where('groupId', '==', 'gA')))],
    ['LINEの送信先(1件)', getDoc(doc(B, 'lineRecipients', 'rA'))],
    ['LINEの送信先(家庭で探す)', getDocs(query(collection(B, 'lineRecipients'), where('groupId', '==', 'gA')))],
    ['LINEの送信先の利用者番号', getDoc(doc(B, 'lineRecipientIds', 'rA'))],
    ['LINEの送信先への招待', getDoc(doc(B, 'lineInvites', 'KNVT234567'))],
    ['LINE連携', getDoc(doc(B, 'lineLinks', 'a1'))],
    ['LINE連携の一覧', getDocs(collection(B, 'lineLinks'))],
    ['LINE連携コード', getDoc(doc(B, 'lineLinkCodes', 'EFGH2345'))],
    ['家族のアンケートの答え', getDoc(doc(B, 'surveyAnswers', 'a1_2026-10'))],
    ['家族のアンケートの答え(一覧)', getDocs(collection(B, 'surveyAnswers'))],
    ['利用数の集計', getDoc(doc(B, 'usageStats', 'uA'))],
    ['利用数の集計(一覧)', getDocs(collection(B, 'usageStats'))],
    ['運営者の登録', getDoc(doc(B, 'ops', 'operator'))],
    ['復旧先(アカウント)', getDoc(doc(B, 'accounts', 'a1'))],
    ['同意の記録', getDoc(doc(B, 'consents', 'a1'))],
  ];
  for (const [name, p] of R) await check('読めない: ' + name, p, false);

  // ---- 家庭Bの家族は、家庭Aに書けない・変えられない・消せない ----
  const now = serverTimestamp();
  const W = [
    ['記録を書き込む', setDoc(doc(B, 'groups', 'gA', 'events', 'x1'), { type: 'aisatsu', uid: 'b1', date: '2026-10-05', at: now })],
    ['記録を消す', deleteDoc(doc(B, 'groups', 'gA', 'events', 'e1'))],
    ['予定を作る', setDoc(doc(B, 'groups', 'gA', 'yotei', 'x2'), { kind: '📌', date: '2026-10-06', time: '10:00', label: 'いたずら', color: '#3D6FB4', repeat: 'none', uid: 'b1', createdAt: now, updatedAt: now })],
    ['予定を書き換える', updateDoc(doc(B, 'groups', 'gA', 'yotei', 'y1'), { label: '書き換え', updatedAt: now })],
    ['予定を消す', deleteDoc(doc(B, 'groups', 'gA', 'yotei', 'y1'))],
    ['招待なしで、承認済みとして家庭に入る', setDoc(doc(B, 'groups', 'gA', 'members', 'b1'), { name: 'びー', status: 'approved' })],
    ['家族の名簿を書き換える', updateDoc(doc(B, 'groups', 'gA', 'members', 'h1'), { name: '書き換え' })],
    ['家族を外す', deleteDoc(doc(B, 'groups', 'gA', 'members', 'a1'))],
    ['家庭の削除を始める', updateDoc(doc(B, 'groups', 'gA'), { deletionState: 'deleting', deletionStartedAt: now, deletionStartedBy: 'b1' })],
    ['管理者の交代を依頼する', updateDoc(doc(B, 'groups', 'gA'), { pendingOwner: 'b1', pendingOwnerAt: now })],
    ['家庭を消す', deleteDoc(doc(B, 'groups', 'gA'))],
    ['家庭Aの招待コードを作る', setDoc(doc(B, 'invites', 'QRST2345'), { groupId: 'gA', createdBy: 'b1', createdAt: now, expiresAt: later(60), used: false })],
    ['家庭Aの招待コードを消す', deleteDoc(doc(B, 'invites', 'ABCD2345'))],
    ['家庭Aのおまもりタグを作る', setDoc(doc(B, 'watchTags', 'C'.repeat(32)), { groupId: 'gA', active: true, createdBy: 'b1', createdAt: now, consentVersion: '2026-09-19.1', consentedAt: now })],
    ['家庭Aのおまもりタグを止める', updateDoc(doc(B, 'watchTags', TAG), { active: false, stoppedAt: now })],
    ['おまもりタグの設定を書き換える', setDoc(doc(B, 'groups', 'gA', 'settings', 'watchTag'), { watchTagId: TAG_B, watchTagActive: true, watchTagUpdatedAt: now })],
    ['送信先への同意を家庭Aに作る', setDoc(doc(B, 'groups', 'gA', 'lineShareConsents', 'b1'), { version: 'line-share-20261004', acceptedAt: now, honninAgreed: true, name: 'びー' })],
    ['家庭AのLINE送信先を作る', setDoc(doc(B, 'lineRecipients', 'rX'), { groupId: 'gA', name: 'いたずら', status: 'pending', createdBy: 'b1', createdAt: now })],
    ['家庭AのLINE送信先の名前を変える', updateDoc(doc(B, 'lineRecipients', 'rA'), { name: '書き換え' })],
    ['家庭AのLINE送信先を消す', deleteDoc(doc(B, 'lineRecipients', 'rA'))],
    ['家庭AのLINE送信先への招待を作る', setDoc(doc(B, 'lineInvites', 'KNVT23456X'), { groupId: 'gA', recipientId: 'rA', createdBy: 'b1', createdAt: now, expiresAt: later(60) })],
    ['家庭AのLINE連携コードを作る', setDoc(doc(B, 'lineLinkCodes', 'JKLM2345'), { uid: 'b1', groupId: 'gA', createdAt: now, expiresAt: later(10) })],
    ['家庭AのLINE連携を消す', deleteDoc(doc(B, 'lineLinks', 'a1'))],
    ['家庭Aの名前でアンケートに答える', setDoc(doc(B, 'surveyAnswers', 'b1_2026-10'), { uid: 'b1', groupId: 'gA', month: '2026-10', kind: 'baseline', absences: 0, burden: '', answeredAt: now })],
    ['家庭Aの人のアンケートを消す', deleteDoc(doc(B, 'surveyAnswers', 'a1_2026-10'))],
    ['利用数の集計を書き換える', setDoc(doc(B, 'usageStats', 'uA'), { groupId: 'gA', start: '2026-01-01' })],
    ['運営者になりすます', setDoc(doc(B, 'ops', 'operator'), { lineUserId: 'Ub1' })],
    ['家庭Aの人の復旧先を書き換える', setDoc(doc(B, 'accounts', 'a1'), { groupId: 'gB', updatedAt: now })],
  ];
  for (const [name, p] of W) await check('できない: ' + name, p, false);

  // ---- 承認待ちの人・ログインしていない人も読めない ----
  await check('承認待ちの人は、承認されるまで記録を読めない', getDoc(doc(P, 'groups', 'gA', 'events', 'e1')), false);
  await check('承認待ちの人は、承認されるまで予定を読めない', getDocs(collection(P, 'groups', 'gA', 'yotei')), false);
  await check('承認待ちの人は、自分で承認済みにできない', updateDoc(doc(P, 'groups', 'gA', 'members', 'p1'), { status: 'approved' }), false);
  await check('ログインしていない人は、記録を読めない', getDoc(doc(N, 'groups', 'gA', 'events', 'e1')), false);
  await check('ログインしていない人は、おまもりタグの読み取り記録を読めない', getDocs(collection(N, 'watchTags', TAG, 'alerts')), false);
  await check('ルールに無い場所は、だれも読み書きできない', setDoc(doc(B, 'somethingNew', 'x'), { a: 1 }), false);

  // ---- 確かめの後: 家庭Aの記録は書き換わっていない ----
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    const y = (await getDoc(doc(db, 'groups', 'gA', 'yotei', 'y1'))).data();
    const g = (await getDoc(doc(db, 'groups', 'gA'))).data();
    const ok = y && y.label === '通院' && g && !g.deletionState && g.createdBy === 'a1'
      && (await getDoc(doc(db, 'groups', 'gA', 'events', 'e1'))).exists()
      && !(await getDoc(doc(db, 'groups', 'gA', 'members', 'b1'))).exists();
    results.push([ok ? '✅' : '❌', '後確認. 家庭Aの記録・予定・名簿・家庭の状態は、何も変わっていない']);
  });

  console.log('\n===== 世帯の分離テスト =====');
  for (const [mark, name] of results) console.log(mark, name);
  const ok = results.filter((r) => r[0] === '✅').length;
  console.log(`\n${results.length}件中 ${ok}件が期待どおり（分離テスト）`);
  process.exitCode = ok === results.length ? 0 : 1;
} finally {
  await env.cleanup();
}
