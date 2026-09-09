/* おまもりタグ通知と予定の権限ルール動作検査（19ケース） */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import fs from 'node:fs';

const env = await initializeTestEnvironment({
  projectId: 'demo-mainico',
  firestore: {
    rules: fs.readFileSync('firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8080,
  },
});

const TAG = 'tag-active';
const TAG_STOP = 'tag-stopped';
const results = [];

async function check(name, promise, expectOk) {
  try {
    if (expectOk) await assertSucceeds(promise);
    else await assertFails(promise);
    results.push(['✅', name]);
  } catch (error) {
    results.push(['❌', `${name} — ${String(error).split('\n')[0].slice(0, 120)}`]);
  }
}

try {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'watchTags', TAG), { active: true, groupId: 'g1' });
    await setDoc(doc(db, 'watchTags', TAG_STOP), { active: false, groupId: 'g1' });
    const old = Timestamp.fromMillis(Date.now() - 11 * 60 * 1000);
    await setDoc(doc(db, 'watchTags', TAG, 'alerts', 'userOld'), {
      type: 'found', senderUid: 'userOld', createdAt: old,
    });
    await setDoc(doc(db, 'watchTags', TAG, 'alerts', 'userAged'), {
      type: 'found', situation: 'lost', count: 1, senderUid: 'userAged', createdAt: old,
    });
    await setDoc(doc(db, 'watchTags', TAG, 'alerts', 'userFresh'), {
      type: 'found', situation: 'lost', count: 1, senderUid: 'userFresh', createdAt: Timestamp.now(),
    });
  });

  const payload = (uid, count) => ({
    type: 'found',
    situation: 'lost',
    count,
    senderUid: uid,
    createdAt: serverTimestamp(),
  });
  const authed = (uid) => env.authenticatedContext(uid).firestore();

  await check('1. 新規のお知らせを作成できる',
    setDoc(doc(authed('userNew'), 'watchTags', TAG, 'alerts', 'userNew'), payload('userNew', 1)), true);
  await check('2. 10分未満の再送は拒否される',
    setDoc(doc(authed('userFresh'), 'watchTags', TAG, 'alerts', 'userFresh'), payload('userFresh', 2)), false);
  await check('3. 10分経過後の再送はできる',
    setDoc(doc(authed('userAged'), 'watchTags', TAG, 'alerts', 'userAged'), payload('userAged', 2)), true);
  await check('4. 停止済みタグへの通知は拒否される',
    setDoc(doc(authed('userNew2'), 'watchTags', TAG_STOP, 'alerts', 'userNew2'), payload('userNew2', 1)), false);
  await check('5. 旧形式のお知らせからの再送もできる',
    setDoc(doc(authed('userOld'), 'watchTags', TAG, 'alerts', 'userOld'), payload('userOld', 1)), true);

  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm1'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm2'), { status: 'approved' });
    await setDoc(doc(db, 'groups', 'g1', 'yotei', 'y1'), {
      label: '通院', date: '2026-09-20', uid: 'm1', createdAt: Timestamp.now(),
    });
    await setDoc(doc(db, 'groups', 'g1', 'yotei', 'y2'), {
      label: '散歩', date: '2026-09-21', uid: 'm1', createdAt: Timestamp.now(),
    });
    await setDoc(doc(db, 'groups', 'g1', 'yotei', 'yLegacy'), {
      label: '昔の予定', date: '2026-09-22',
    });
  });

  const m1 = env.authenticatedContext('m1').firestore();
  const m2 = env.authenticatedContext('m2').firestore();

  await check('6. 登録した本人は自分の予定を修正できる',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y1'), {
      label: '通院（時間変更）', updatedAt: serverTimestamp(),
    }, { merge: true }), true);
  await check('7. ほかの家族は他人の予定を修正できない',
    setDoc(doc(m2, 'groups', 'g1', 'yotei', 'y1'), {
      label: '書き換え', updatedAt: serverTimestamp(),
    }, { merge: true }), false);
  await check('8. 本人でも予定の名義（uid）は書き換えられない',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y1'), {
      uid: 'm2', updatedAt: serverTimestamp(),
    }, { merge: true }), false);
  await check('9. ほかの家族は他人の予定を削除できない',
    deleteDoc(doc(m2, 'groups', 'g1', 'yotei', 'y2')), false);
  await check('10. 登録した本人は自分の予定を削除できる',
    deleteDoc(doc(m1, 'groups', 'g1', 'yotei', 'y2')), true);
  await check('11. 名義の無い旧予定は承認済み家族が整理できる',
    setDoc(doc(m2, 'groups', 'g1', 'yotei', 'yLegacy'), {
      label: '昔の予定（整理）', updatedAt: serverTimestamp(),
    }, { merge: true }), true);

  const fullYotei = (uid) => ({
    kind: '🏥',
    date: '2026-09-25',
    time: '10:00',
    label: '検査用',
    color: '#3D6FB4',
    repeat: 'none',
    uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await check('12. 他人のuidを指定した予定の新規作成は拒否される',
    setDoc(doc(m2, 'groups', 'g1', 'yotei', 'yBad'), fullYotei('m1')), false);
  await check('13. 予定の作成日時（createdAt）の書き換えは拒否される',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y1'), {
      createdAt: Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
      updatedAt: serverTimestamp(),
    }, { merge: true }), false);
  await check('14. 許可していない項目を追加する更新は拒否される',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y1'), {
      hidden: true, updatedAt: serverTimestamp(),
    }, { merge: true }), false);
  await check('15. 自分名義の正しい新規作成はできる（回帰確認）',
    setDoc(doc(m2, 'groups', 'g1', 'yotei', 'yOk'), fullYotei('m2')), true);

  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'groups', 'g1', 'yotei', 'yLegacy2'), {
      label: '古い予定', date: '2026-09-23', memo: '旧項目', repeat: 'weekly',
    });
  });
  const claim = {
    kind: '📌',
    date: '2026-09-23',
    time: '',
    label: '古い予定（修正）',
    color: '#3D6FB4',
    repeat: 'none',
    uid: 'm2',
    updatedAt: serverTimestamp(),
  };
  await check('16. 名義の無い旧予定は、直した家族が名義を引き継げる',
    setDoc(doc(m2, 'groups', 'g1', 'yotei', 'yLegacy'), claim, { merge: true }), true);
  await check('17. 旧項目（memo等）が残る予定でも修正できる',
    setDoc(doc(m2, 'groups', 'g1', 'yotei', 'yLegacy2'), {
      label: '古い予定（整理）', updatedAt: serverTimestamp(),
    }, { merge: true }), true);
  await check('18. 偽の更新日時（updatedAt）での修正は拒否される',
    setDoc(doc(m1, 'groups', 'g1', 'yotei', 'y1'), {
      label: '改ざん',
      updatedAt: Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
    }, { merge: true }), false);
  const missingTime = {
    kind: '📌',
    date: '2026-09-26',
    label: '項目欠け',
    color: '#3D6FB4',
    repeat: 'none',
    uid: 'm2',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await check('19. 必須項目が欠けた予定の新規作成は拒否される',
    setDoc(doc(m2, 'groups', 'g1', 'yotei', 'yMissing'), missingTime), false);

  console.log('\n===== 検査結果 =====');
  for (const [mark, name] of results) console.log(mark, name);
  const ok = results.filter((result) => result[0] === '✅').length;
  console.log(`\n${results.length}件中 ${ok}件が期待どおり`);
  process.exitCode = ok === results.length ? 0 : 1;
} finally {
  await env.cleanup();
}
