import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from '@firebase/rules-unit-testing';
import {
  doc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc
} from 'firebase/firestore';

const projectId = 'demo-mainico';
const tagId = 'A'.repeat(32);
const uid = 'reader-1';
let testEnv;

function minutesAgo(minutes) {
  return Timestamp.fromMillis(Date.now() - minutes * 60 * 1000);
}

async function seedTag({ active = true, alert = null } = {}) {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'watchTags', tagId), {
      groupId: 'family-1',
      active,
      createdBy: 'family-owner',
      createdAt: minutesAgo(60)
    });
    if (alert) {
      await setDoc(doc(db, 'watchTags', tagId, 'alerts', uid), alert);
    }
  });
}

async function seedSchedule() {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'groups', 'family-1'), {
      createdBy: 'family-owner'
    });
    await setDoc(doc(db, 'groups', 'family-1', 'members', 'family-owner'), {
      status: 'approved', role: 'kazoku'
    });
    await setDoc(doc(db, 'groups', 'family-1', 'members', 'family-viewer'), {
      status: 'approved', role: 'kazoku'
    });
    await setDoc(doc(db, 'groups', 'family-1', 'members', 'watcher-1'), {
      status: 'approved', role: 'mimamori'
    });
    await setDoc(doc(db, 'groups', 'family-1', 'yotei', 'plan-1'), {
      kind: '🏥', date: '2026-09-01', label: '通院', uid: 'family-owner'
    });
  });
}

function readerAlert() {
  return doc(
    testEnv.authenticatedContext(uid).firestore(),
    'watchTags', tagId, 'alerts', uid
  );
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: await readFile('firestore.rules', 'utf8')
    }
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

after(async () => {
  await testEnv.cleanup();
});

test('使用中タグへ最初の通知を1回作成できる', async () => {
  await seedTag();
  await assertSucceeds(setDoc(readerAlert(), {
    type: 'found',
    situation: 'safe',
    senderUid: uid,
    count: 1,
    createdAt: serverTimestamp()
  }));
});

test('移行期間中は公開中の旧QRからも最初の通知を作成できる', async () => {
  await seedTag();
  await assertSucceeds(setDoc(readerAlert(), {
    type: 'found',
    senderUid: uid,
    createdAt: serverTimestamp()
  }));
});

test('10分以内の連打を拒否する', async () => {
  await seedTag({
    alert: {
      type: 'found', situation: 'safe', senderUid: uid,
      count: 1, createdAt: minutesAgo(1)
    }
  });
  await assertFails(setDoc(readerAlert(), {
    situation: 'lost',
    count: 2,
    createdAt: serverTimestamp()
  }, { merge: true }));
});

test('10分経過後は同じ端末から再通知できる', async () => {
  await seedTag({
    alert: {
      type: 'found', situation: 'safe', senderUid: uid,
      count: 1, createdAt: minutesAgo(11)
    }
  });
  await assertSucceeds(setDoc(readerAlert(), {
    situation: 'lost',
    count: 2,
    createdAt: serverTimestamp()
  }, { merge: true }));
});

test('countがない旧通知も10分経過後に再通知できる', async () => {
  await seedTag({
    alert: {
      type: 'found', senderUid: uid, createdAt: minutesAgo(11)
    }
  });
  await assertSucceeds(setDoc(readerAlert(), {
    situation: 'unwell',
    count: 1,
    createdAt: serverTimestamp()
  }, { merge: true }));
});

test('停止済みタグへの新規通知と再通知を拒否する', async () => {
  await seedTag({
    active: false,
    alert: {
      type: 'found', situation: 'safe', senderUid: uid,
      count: 1, createdAt: minutesAgo(11)
    }
  });

  const otherAlert = doc(
    testEnv.authenticatedContext('reader-2').firestore(),
    'watchTags', tagId, 'alerts', 'reader-2'
  );
  await assertFails(setDoc(otherAlert, {
    type: 'found', situation: 'safe', senderUid: 'reader-2',
    count: 1, createdAt: serverTimestamp()
  }));
  await assertFails(setDoc(readerAlert(), {
    situation: 'called',
    count: 2,
    createdAt: serverTimestamp()
  }, { merge: true }));
});

test('承認済み家族は予定の内容を修正できる', async () => {
  await seedSchedule();
  const plan = doc(
    testEnv.authenticatedContext('family-owner').firestore(),
    'groups', 'family-1', 'yotei', 'plan-1'
  );
  await assertSucceeds(updateDoc(plan, {
    time: '10:00', place: '上田市内の医院', updatedAt: serverTimestamp()
  }));
});

test('予定を修正するとき作成者uidは変更できない', async () => {
  await seedSchedule();
  const plan = doc(
    testEnv.authenticatedContext('family-owner').firestore(),
    'groups', 'family-1', 'yotei', 'plan-1'
  );
  await assertFails(updateDoc(plan, { uid: 'other-user' }));
});

test('別の承認済み家族は他人が登録した予定を修正できない', async () => {
  await seedSchedule();
  const plan = doc(
    testEnv.authenticatedContext('family-viewer').firestore(),
    'groups', 'family-1', 'yotei', 'plan-1'
  );
  await assertFails(updateDoc(plan, { time: '11:00' }));
});


test('見守る人は予定を作成できない', async () => {
  await seedSchedule();
  const plan = doc(
    testEnv.authenticatedContext('watcher-1').firestore(),
    'groups', 'family-1', 'yotei', 'watcher-plan'
  );
  await assertFails(setDoc(plan, {
    kind: '📅', date: '2026-09-02', label: '見守り予定', uid: 'watcher-1'
  }));
});

test('見守る人は招待を発行できない', async () => {
  await seedSchedule();
  const invite = doc(
    testEnv.authenticatedContext('watcher-1').firestore(),
    'invites', 'watcher-invite'
  );
  await assertFails(setDoc(invite, {
    groupId: 'family-1', role: 'mimamori', used: false,
    expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000)
  }));
});

test('既存の家族役割は管理者として招待を発行できる', async () => {
  await seedSchedule();
  const invite = doc(
    testEnv.authenticatedContext('family-owner').firestore(),
    'invites', 'manager-invite'
  );
  await assertSucceeds(setDoc(invite, {
    groupId: 'family-1', role: 'mimamori', used: false,
    expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000)
  }));
});

test('招待で指定した役割と異なる役割では参加できない', async () => {
  await seedSchedule();
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'invites', 'role-invite'), {
      groupId: 'family-1', role: 'mimamori', used: false,
      expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000)
    });
  });
  const member = doc(
    testEnv.authenticatedContext('new-watcher').firestore(),
    'groups', 'family-1', 'members', 'new-watcher'
  );
  await assertFails(setDoc(member, {
    name: '見守る人', status: 'pending', role: 'kazoku',
    inviteCode: 'role-invite'
  }));
  await assertSucceeds(setDoc(member, {
    name: '見守る人', status: 'pending', role: 'mimamori',
    inviteCode: 'role-invite'
  }));
});
