import {consentFixture} from './helpers/consent-fixture.mjs';
/* 実Firebase compat SDK + 実rules + 実module の統合検査。
   認証identityはrules emulatorのテストトークン。Authメール配信/実機UIは対象外。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import '../household-deletion.js';
const require = createRequire(import.meta.url);
const Recovery = require('../account-recovery.js');
const Deletion = globalThis.MainicoDeletion;
const env = await initializeTestEnvironment({
  projectId: 'demo-mainico-integration',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
const timestamp = () => firebase.firestore.FieldValue.serverTimestamp();
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function user(uid) {
  return {
    uid, email: `${uid}@example.invalid`, emailVerified: true,
    providerData: [{ providerId: 'password' }],
    reload: async () => {}, getIdToken: async () => 'test-identity',
  };
}
function services(uid, options = {}) {
  const db = env.authenticatedContext(uid).firestore();
  const auth = { currentUser: user(uid) };
  return {
    db, auth,
    deletion: Deletion.create({ db, auth, serverTimestamp: timestamp, storage: storage(), pageSize: 2, ...options }),
    recovery: Recovery.create({ db, auth, serverTimestamp: timestamp }),
  };
}
function records(groupId, ownerUid, memberUid) {
  const tagA = `${groupId}-tag-active`, tagB = `${groupId}-tag-stopped`;
  const data = {
    [`groups/${groupId}`]: { createdBy: ownerUid, createdAt: firebase.firestore.Timestamp.now() },
    [`groups/${groupId}/members/${ownerUid}`]: { name: '管理者', role: 'kazoku', mode: 'konly', status: 'approved' },
    [`groups/${groupId}/members/${memberUid}`]: { name: '本人', role: 'honnin', mode: 'honnin', status: 'approved' },
    [`groups/${groupId}/members/legacy`]: { name: '旧家族', role: 'kazoku' },
    [`groups/${groupId}/settings/watchTag`]: { watchTagId: tagA, watchTagActive: true },
    [`accounts/${ownerUid}`]: { groupId, updatedAt: firebase.firestore.Timestamp.now() },
    [`accounts/${memberUid}`]: { groupId, updatedAt: firebase.firestore.Timestamp.now() },
    [`accounts/${groupId}-extra-pointer`]: { groupId, updatedAt: firebase.firestore.Timestamp.now() },
    [`watchTags/${tagA}`]: { groupId, active: true, createdBy: ownerUid },
    [`watchTags/${tagB}`]: { groupId, active: false, createdBy: ownerUid },
  };
  for (let i = 0; i < 7; i++) data[`groups/${groupId}/events/event-${i}`] = { uid: i % 2 ? ownerUid : memberUid, text: '検査用伝言' };
  for (let i = 0; i < 3; i++) {
    data[`groups/${groupId}/yotei/plan-${i}`] = { uid: memberUid, label: '検査用予定' };
    data[`invites/${groupId}-invite-${i}`] = { groupId, used: i > 0 };
  }
  for (let i = 0; i < 5; i++) data[`watchTags/${tagA}/alerts/finder-${i}`] = { senderUid: `finder-${i}`, count: i + 1 };
  for (let i = 0; i < 3; i++) data[`watchTags/${tagB}/alerts/finder-${i}`] = { senderUid: `finder-${i}`, count: i + 1 };
  return data;
}
async function seed(data) {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore(), batch = db.batch();
    for (const [path, value] of Object.entries(data)) {
      batch.set(db.doc(path), value);
      if(/^groups\/[^/]+\/members\/[^/]+$/.test(path))batch.set(db.doc('consents/'+path.split('/').at(-1)),consentFixture(firebase.firestore.Timestamp.now()));
    }
    await batch.commit();
  });
}
async function readAll(paths) {
  let snapshots;
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    snapshots = await Promise.all(paths.map(async path => {
      const snap = await db.doc(path).get({ source: 'server' });
      return { path, exists: snap.exists, value: snap.exists ? snap.data() : null };
    }));
  });
  return snapshots;
}
const run = (service, groupId) => service.run({ groupId, confirmation: Deletion.CONFIRMATION });

try {
  await env.clearFirestore();
  const home = records('full-home', 'full-owner', 'full-member');
  const other = records('untouched-home', 'other-owner', 'other-member');
  await seed({ ...home, ...other });
  const otherBefore = await readAll(Object.keys(other));
  const owner = services('full-owner');
  const member = services('full-member');
  const ownerReady = await owner.recovery.checkReady('full-home');
  assert.equal(ownerReady.ready, true);
  assert.equal(ownerReady.mode, 'konly', '実pointer→group→memberで家族記録modeを復旧');
  assert.equal(ownerReady.owner, true);
  assert.equal((await member.recovery.checkReady('full-home')).mode, 'honnin');
  console.log('OK 実SDKで復旧pointerと権限・利用modeを確認');

  await assert.rejects(run(member.deletion, 'full-home'), error => error.code === 'not-owner');
  assert.equal((await owner.db.doc('groups/full-home').get({ source: 'server' })).data().deletionState, undefined);
  console.log('OK 一般メンバーの全削除は書込前に停止');

  const complete = await run(owner.deletion, 'full-home');
  assert.equal(complete.status, 'complete');
  assert.equal(complete.deletedCount, Object.keys(home).length);
  assert.equal(owner.deletion.getPending(), null);
  assert.equal((await readAll(Object.keys(home))).filter(snap => snap.exists).length, 0, '既知doc全てを権限外監査で不存在確認');
  assert.deepEqual(await readAll(Object.keys(other)), otherBefore, '他世帯は全て保持');
  assert.equal((await readAll(['consents/full-owner']))[0].exists,true,'世帯の削除ではアカウントの同意は残る');
  await assert.rejects(owner.recovery.checkReady('full-home'), error => error.code === 'recovery/no-pointer');
  console.log(`OK 実SDKで${Object.keys(home).length}件を複数ページ全削除・他世帯保持・削除済み復旧拒否`);

  const resumable = records('resume-home', 'resume-owner', 'resume-member');
  await seed(resumable);
  let online = true, interrupted = false;
  const firstDevice = services('resume-owner', {
    isOnline: () => online,
    onProgress: progress => {
      // 実SDKの子データ清掃後、最終検証前に通信ゲートを閉じる。
      if (progress.stage === 'verifying' && progress.status === 'verifying') {
        interrupted = true; online = false;
      }
    },
  });
  await assert.rejects(run(firstDevice.deletion, 'resume-home'), error => error.code === 'offline');
  assert.equal(interrupted, true);
  const intermediate = await readAll(['groups/resume-home', 'accounts/resume-owner', 'groups/resume-home/members/resume-owner']);
  assert.equal(intermediate[0].value.deletionState, 'deleting');
  assert.equal(intermediate[1].exists, true, '最終確定までowner復旧先を維持');
  assert.equal(intermediate[2].exists, false, 'owner memberは既に清掃済み');
  assert.notEqual(firstDevice.deletion.getPending(), null);
  const newDevice = services('resume-owner');
  assert.equal(newDevice.deletion.getPending(), null, '新端末にはローカル再開情報がない');
  const recovery = await newDevice.recovery.checkReady('resume-home');
  assert.equal(recovery.ready, true);
  assert.equal(recovery.deletionPending, true);
  assert.equal(recovery.owner, true);
  console.log('OK member清掃後の中断でも実pointerから管理者の削除再開を復旧');

  const resumed = await run(newDevice.deletion, recovery.groupId);
  assert.equal(resumed.status, 'complete');
  assert.equal((await readAll(Object.keys(resumable))).filter(snap => snap.exists).length, 0);
  assert.deepEqual(await readAll(Object.keys(other)), otherBefore);
  console.log('OK 新しい端末状態から実transactionで削除再開・残存ゼロを確認');
  console.log('\n5組の実Firebase SDK・rules・module統合検査が通過。');
} finally {
  await env.cleanup();
}
