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
  Timestamp
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
