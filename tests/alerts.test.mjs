/* おまもりタグ通知と予定の権限ルール動作検査（19ケース） */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
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
    await setDoc(doc(db, 'groups', 'g1'), { createdBy: 'm1', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm1'), { status: 'approved', permission: 'owner', role:'kazoku', name:'管理家族' });
    await setDoc(doc(db, 'groups', 'g1', 'members', 'm2'), { status: 'approved', permission: 'member', role:'kazoku', name:'一般家族' });
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

  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db,'groups','g2'),{createdBy:'other'});
    await setDoc(doc(db,'groups','g2','members','other'),{status:'approved',permission:'owner',role:'kazoku',name:'別世帯'});
    await setDoc(doc(db,'groups','g2','events','secret'),{type:'memo',date:'2026-09-13',at:Timestamp.now(),uid:'other',text:'別世帯の記録'});
    await setDoc(doc(db,'groups','g1','members','pending'),{status:'pending',permission:'member',role:'kazoku',name:'申請中'});
  });
  const event=(uid)=>({type:'memo',date:'2026-09-13',at:serverTimestamp(),uid,text:'共有メモ'});
  await check('20. 承認済み家族は自世帯へ正しい記録を作成できる',
    setDoc(doc(m2,'groups','g1','events','valid-event'),event('m2')),true);
  await check('21. 他人名義の記録は作成できない',
    setDoc(doc(m2,'groups','g1','events','spoof-event'),event('m1')),false);
  await check('22. 未許可の項目を含む記録は作成できない',
    setDoc(doc(m2,'groups','g1','events','extra-event'),{...event('m2'),privateValue:'x'}),false);
  await check('23. 別世帯の記録は読めない',
    getDoc(doc(m2,'groups','g2','events','secret')),false);
  await check('24. 管理家族は参加申請を承認できる',
    setDoc(doc(m1,'groups','g1','members','pending'),{status:'approved'},{merge:true}),true);
  await env.withSecurityRulesDisabled(async (context)=>{
    await setDoc(doc(context.firestore(),'groups','g1','members','pending2'),{status:'pending',permission:'member',role:'kazoku',name:'申請中2'});
  });
  await check('25. 一般家族は参加申請を承認できない',
    setDoc(doc(m2,'groups','g1','members','pending2'),{status:'approved'},{merge:true}),false);
  await check('26. クライアントからメンバーを削除できない',
    deleteDoc(doc(m1,'groups','g1','members','m2')),false);
  const medicine={name:'血圧の薬',timing:'朝食後',note:'薬袋を確認',status:'active',verifiedAt:Timestamp.now(),createdAt:serverTimestamp(),updatedAt:serverTimestamp(),updatedBy:'m1'};
  await check('27. 管理家族は確認日付きのお薬情報を登録できる',
    setDoc(doc(m1,'groups','g1','medicines','med1'),medicine),true);
  await check('28. 一般家族はお薬情報を登録できない',
    setDoc(doc(m2,'groups','g1','medicines','med2'),{...medicine,updatedBy:'m2'}),false);
  const invite={groupId:'g1',createdBy:'m1',createdAt:serverTimestamp(),expiresAt:Timestamp.fromMillis(Date.now()+3600000),used:false,targetRole:'kazoku'};
  await check('29. 管理家族は期限付き招待を発行できる',
    setDoc(doc(m1,'invites','ABCDEFGH'),invite),true);
  await check('30. 一般家族は招待を発行できない',
    setDoc(doc(m2,'invites','ABCDEFGJ'),{...invite,createdBy:'m2'}),false);
  await check('31. 所有者は一般家族を管理家族に変更できる',
    setDoc(doc(m1,'groups','g1','members','m2'),{permission:'manager'},{merge:true}),true);
  await check('32. 一般家族は自分を管理家族に変更できない',
    setDoc(doc(m2,'groups','g1','members','m2'),{permission:'manager'},{merge:true}),false);
  await check('33. 招待コードの内容はクライアントから直接読めない',
    getDoc(doc(m1,'invites','ABCDEFGH')),false);

  console.log('\n===== 検査結果 =====');
  for (const [mark, name] of results) console.log(mark, name);
  const ok = results.filter((result) => result[0] === '✅').length;
  console.log(`\n${results.length}件中 ${ok}件が期待どおり`);
  process.exitCode = ok === results.length ? 0 : 1;
} finally {
  await env.cleanup();
}
