"use strict";

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore, FieldValue, Timestamp} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
const REGION = "asia-northeast1";

function requiredAuth(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "ログインが必要です");
  return request.auth.uid;
}

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function cleanId(value) {
  const id = cleanText(value, 128);
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : "";
}

async function managerMember(groupId, uid) {
  const [groupSnap, memberSnap] = await Promise.all([
    db.doc(`groups/${groupId}`).get(),
    db.doc(`groups/${groupId}/members/${uid}`).get(),
  ]);
  if (!groupSnap.exists || !memberSnap.exists) return null;
  const member = memberSnap.data();
  const legacyOwner = !Object.prototype.hasOwnProperty.call(member, "permission") &&
    groupSnap.data().createdBy === uid;
  return member.status === "approved" &&
    (["owner", "manager"].includes(member.permission) || legacyOwner) ? member : null;
}

async function deleteAuthUsers(uids) {
  const pending = [];
  for (let start = 0; start < uids.length; start += 1000) {
    const part = uids.slice(start, start + 1000);
    const result = await getAuth().deleteUsers(part);
    for (const failure of result.errors) {
      if (failure.error && failure.error.code === "auth/user-not-found") continue;
      pending.push(part[failure.index]);
    }
  }
  return pending;
}

async function purgeHouseholdData(groupId) {
  const [invites, tags, profiles, group] = await Promise.all([
    db.collection("invites").where("groupId", "==", groupId).get(),
    db.collection("watchTags").where("groupId", "==", groupId).get(),
    db.collection("userProfiles").where("groupId", "==", groupId).get(),
    db.doc(`groups/${groupId}`).get(),
  ]);
  for (const tag of tags.docs) await db.recursiveDelete(tag.ref);
  for (const invite of invites.docs) await invite.ref.delete();
  for (const profile of profiles.docs) await profile.ref.delete();
  if (group.exists) await db.recursiveDelete(group.ref);
}

exports.createHousehold = onCall({region: REGION, enforceAppCheck: true}, async (request) => {
  const uid = requiredAuth(request);
  const mode = cleanText(request.data && request.data.mode, 10);
  const name = cleanText(request.data && request.data.name, 40);
  if (!["honnin", "kazoku", "konly"].includes(mode) || !name) {
    throw new HttpsError("invalid-argument", "利用方法と名前を確認してください");
  }
  const role = mode === "honnin" ? "honnin" : "kazoku";
  const groupRef = db.collection("groups").doc();
  const memberRef = groupRef.collection("members").doc(uid);
  const profileRef = db.doc(`userProfiles/${uid}`);
  await db.runTransaction(async (tx) => {
    tx.create(groupRef, {createdBy: uid, createdAt: FieldValue.serverTimestamp(), schemaVersion: 2});
    tx.create(memberRef, {
      name, role, permission: "owner", status: "approved",
      joinedAt: FieldValue.serverTimestamp(),
    });
    tx.set(profileRef, {groupId: groupRef.id, mode, name, updatedAt: FieldValue.serverTimestamp()});
  });
  return {groupId: groupRef.id};
});

exports.claimInvite = onCall({region: REGION, enforceAppCheck: true, consumeAppCheckToken: true}, async (request) => {
  const uid = requiredAuth(request);
  const code = cleanText(request.data && request.data.code, 8).toUpperCase();
  const mode = cleanText(request.data && request.data.mode, 10);
  const name = cleanText(request.data && request.data.name, 40);
  if (!/^[A-Z2-9]{8}$/.test(code) || !["honnin", "kazoku", "konly"].includes(mode) || !name) {
    throw new HttpsError("invalid-argument", "招待コード、利用方法、名前を確認してください");
  }
  const inviteRef = db.doc(`invites/${code}`);
  let groupId = "";
  let effectiveMode = mode;
  await db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef);
    if (!inviteSnap.exists) throw new HttpsError("not-found", "招待コードが見つかりません");
    const invite = inviteSnap.data();
    const expires = invite.expiresAt && invite.expiresAt.toMillis ? invite.expiresAt.toMillis() : 0;
    if (invite.used || expires <= Date.now()) {
      throw new HttpsError("failed-precondition", "招待コードは使用済みか期限切れです");
    }
    groupId = invite.groupId;
    const role = invite.targetRole === "honnin" ? "honnin" : "kazoku";
    effectiveMode = role === "honnin" ? "honnin" : (mode === "konly" ? "konly" : "kazoku");
    tx.create(db.doc(`groups/${groupId}/members/${uid}`), {
      name, role, permission: "member", status: "pending", inviteCode: code,
      joinedAt: FieldValue.serverTimestamp(),
    });
    tx.update(inviteRef, {used: true, usedBy: uid, usedAt: FieldValue.serverTimestamp()});
    tx.set(db.doc(`userProfiles/${uid}`), {
      groupId, mode: effectiveMode, name, updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return {groupId, mode: effectiveMode};
});

exports.removeHouseholdMember = onCall({region: REGION, enforceAppCheck: true}, async (request) => {
  const uid = requiredAuth(request);
  const groupId = cleanId(request.data && request.data.groupId);
  const targetUid = cleanId(request.data && request.data.memberId) || uid;
  if (!groupId) throw new HttpsError("invalid-argument", "家族情報を確認してください");
  const targetRef = db.doc(`groups/${groupId}/members/${targetUid}`);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) return {removed: true};
  const target = targetSnap.data();
  if (target.permission === "owner") {
    throw new HttpsError("failed-precondition", "管理家族は家族全体の削除が必要です");
  }
  if (targetUid !== uid && !(await managerMember(groupId, uid))) {
    throw new HttpsError("permission-denied", "管理家族だけが他の端末を解除できます");
  }
  const jobRef = db.doc(`deletionJobs/member-${targetUid}`);
  await jobRef.set({status: "removingMember", groupId, memberId: targetUid,
    authIds: [targetUid], updatedAt: FieldValue.serverTimestamp()});
  await db.recursiveDelete(targetRef);
  await db.doc(`userProfiles/${targetUid}`).delete().catch(() => {});
  await jobRef.update({status: "pendingAuth", updatedAt: FieldValue.serverTimestamp()});
  const pending = await deleteAuthUsers([targetUid]);
  if (!pending.length) await jobRef.delete();
  return {removed: true, pendingCleanup: pending.length > 0};
});

exports.deleteHousehold = onCall({region: REGION, timeoutSeconds: 540, enforceAppCheck: true}, async (request) => {
  const uid = requiredAuth(request);
  const groupId = cleanId(request.data && request.data.groupId);
  if (!groupId || !(await managerMember(groupId, uid))) {
    throw new HttpsError("permission-denied", "管理家族だけが全データを削除できます");
  }
  const groupRef = db.doc(`groups/${groupId}`);
  const members = await groupRef.collection("members").get();
  const memberIds = members.docs.map((doc) => doc.id);
  const [invites, tags, profiles] = await Promise.all([
    db.collection("invites").where("groupId", "==", groupId).get(),
    db.collection("watchTags").where("groupId", "==", groupId).get(),
    db.collection("userProfiles").where("groupId", "==", groupId).get(),
  ]);
  const profileIds = profiles.docs.map((doc) => doc.id);
  const authIds = Array.from(new Set(memberIds.concat(profileIds)));
  const jobRef = db.doc(`deletionJobs/${groupId}`);
  await jobRef.set({status: "deletingData", authIds, updatedAt: FieldValue.serverTimestamp()});
  for (const tag of tags.docs) await db.recursiveDelete(tag.ref);
  for (const invite of invites.docs) await invite.ref.delete();
  await db.recursiveDelete(groupRef);
  for (const profile of profiles.docs) await profile.ref.delete();
  await jobRef.update({status: "pendingAuth", updatedAt: FieldValue.serverTimestamp()});
  const pendingAuthIds = await deleteAuthUsers(authIds);
  if (pendingAuthIds.length) {
    await jobRef.set({status: "pendingAuth", authIds: pendingAuthIds, updatedAt: FieldValue.serverTimestamp()});
    return {deleted: false, pendingCleanup: true};
  }
  await jobRef.delete();
  return {deleted: true, pendingCleanup: false};
});

exports.retryAccountDeletion = onSchedule({schedule: "every 1 hours", region: REGION}, async () => {
  const jobs = await db.collection("deletionJobs").limit(100).get();
  for (const job of jobs.docs) {
    try {
      if (job.data().status === "deletingData") {
        await purgeHouseholdData(job.id);
        await job.ref.update({status: "pendingAuth", updatedAt: FieldValue.serverTimestamp()});
      }
      if (job.data().status === "removingMember") {
        const groupId = job.data().groupId;
        const memberId = job.data().memberId;
        if (groupId && memberId) await db.recursiveDelete(db.doc(`groups/${groupId}/members/${memberId}`));
        if (memberId) await db.doc(`userProfiles/${memberId}`).delete().catch(() => {});
        await job.ref.update({status: "pendingAuth", updatedAt: FieldValue.serverTimestamp()});
      }
      const pending = await deleteAuthUsers(job.data().authIds || []);
      if (pending.length) await job.ref.update({authIds: pending, updatedAt: FieldValue.serverTimestamp()});
      else await job.ref.delete();
    } catch (error) {
      console.error("scheduled auth cleanup", job.id, error);
    }
  }
});

async function collectTokens(groupId, excludeUid) {
  const members = await db.collection(`groups/${groupId}/members`).where("status", "==", "approved").get();
  const tokens = [];
  for (const member of members.docs) {
    if (member.id === excludeUid) continue;
    const devices = await member.ref.collection("devices").get();
    for (const device of devices.docs) {
      const value = device.data().token;
      if (value) tokens.push({token: value, ref: device.ref});
    }
  }
  return tokens;
}

async function notifyGroup(groupId, excludeUid, title, kind) {
  const entries = await collectTokens(groupId, excludeUid);
  for (let start = 0; start < entries.length; start += 500) {
    const part = entries.slice(start, start + 500);
    const response = await getMessaging().sendEachForMulticast({
      tokens: part.map((entry) => entry.token),
      notification: {title: "まいにこに新しい連絡があります", body: "アプリを開いて内容を確認してください"},
      data: {groupId, kind: kind || "record"},
      webpush: {fcmOptions: {link: "https://pocham4173.github.io/hidamari/"}},
    });
    await Promise.all(response.responses.map((result, index) => {
      const code = result.error && result.error.code;
      return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token"
        ? part[index].ref.delete().catch(() => {}) : Promise.resolve();
    }));
  }
}

const EVENT_TITLES = {
  aisatsu: "ご本人から挨拶が届きました",
  kibun: "ご本人から今日の調子が届きました",
  kusuri: "ご本人がお薬の記録を押しました",
  onegai: "ご本人からお願いが届きました",
  "family-message": "家族からメッセージが届きました",
  "family-message-back": "ご本人から返事が届きました",
  "family-note": "家族の伝言が追加されました",
  "family-task": "家族のやることが追加されました",
  "disaster-help": "家族が「助けが必要」と記録しました",
};

exports.notifyFamilyEvent = onDocumentCreated({
  document: "groups/{groupId}/events/{eventId}", region: REGION,
}, async (event) => {
  const value = event.data && event.data.data();
  if (!value || !EVENT_TITLES[value.type]) return;
  await notifyGroup(event.params.groupId, value.uid, EVENT_TITLES[value.type], value.type);
});

exports.notifyWatchTag = onDocumentCreated({
  document: "watchTags/{tagId}/alerts/{alertId}", region: REGION,
}, async (event) => {
  const tag = await db.doc(`watchTags/${event.params.tagId}`).get();
  if (!tag.exists || !tag.data().active) return;
  const value = event.data.data();
  const labels = {
    lost: "おまもりタグ：道に迷っているようです",
    unwell: "おまもりタグ：体調が心配です",
    safe: "おまもりタグ：安全な場所にいます",
    called: "おまもりタグ：警察・救急へ連絡済みです",
  };
  const groupId = tag.data().groupId;
  await notifyGroup(groupId, "", labels[value.situation] || "おまもりタグが読み取られました", "tag-alert");
  await db.doc(`groups/${groupId}/events/tag-${event.params.alertId}-${value.count || 1}`).set({
    type: "tag-alert", text: labels[value.situation] || "読み取り",
    name: "おまもりタグ", date: new Date().toISOString().slice(0, 10),
    at: value.createdAt || Timestamp.now(), uid: "system",
  });
});
