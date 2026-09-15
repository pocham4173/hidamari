/* 共有データの削除。Firebase compat SDK / Spark、既知のスキーマ専用。
   親を消してもサブコレクションは消えないため、書込み停止後に子から清掃する。 */
(function (global) {
  'use strict';

  const CHECKPOINT_KEY = 'mainico_deletion_pending_v1';
  const CONFIRMATION = '共有データを削除';
  const activeRuns = new Set();
  const stages = new Set(['starting', 'invites', 'tags', 'events', 'yotei', 'settings', 'accounts', 'members', 'verifying', 'finalizing']);

  function failure(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    error.isMainicoDeletionError = true;
    if (cause) error.cause = cause;
    return error;
  }

  function create(options) {
    const { db, auth, serverTimestamp, storage } = options || {};
    if (!db || !auth || typeof serverTimestamp !== 'function' || !storage) {
      throw failure('invalid-options', '削除に必要な接続情報がありません。');
    }
    const pageSize = Math.max(2, Math.min(100, Math.floor(options.pageSize || 100)));
    const timeoutMs = Math.max(1, options.timeoutMs || 20000);
    const isOnline = options.isOnline || (() => !global.navigator || global.navigator.onLine !== false);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

    function getPending() {
      let raw;
      try { raw = storage.getItem(CHECKPOINT_KEY); }
      catch (cause) { throw failure('checkpoint-unavailable', 'この端末に削除の再開情報を保存できません。ブラウザの保存設定を確認してください。', cause); }
      if (!raw) return null;
      let value;
      try { value = JSON.parse(raw); } catch (cause) {
        throw failure('checkpoint-invalid', '削除の再開情報を読み取れません。保存情報を消さずに運営へ相談してください。', cause);
      }
      if (value.version !== 1 || typeof value.groupId !== 'string' || !value.groupId ||
          typeof value.uid !== 'string' || !value.uid || !stages.has(value.stage) ||
          !Number.isSafeInteger(value.deletedCount) || value.deletedCount < 0) {
        throw failure('checkpoint-invalid', '削除の再開情報を確認できません。保存情報を消さずに運営へ相談してください。');
      }
      return value;
    }

    async function run({ groupId, confirmation } = {}) {
      if (confirmation !== CONFIRMATION) throw failure('confirmation-required', '削除する内容を確認し、「共有データを削除」と入力してください。');
      if (typeof groupId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(groupId)) {
        throw failure('invalid-group', '削除する家族グループを確認できません。');
      }
      const ownerUid = auth.currentUser && auth.currentUser.uid;
      if (!ownerUid) throw failure('authentication-required', '管理者のアカウントで接続してから削除してください。');
      const runKey = ownerUid + '/' + groupId;
      if (activeRuns.has(runKey)) throw failure('already-running', 'この家族グループの削除処理は実行中です。');
      activeRuns.add(runKey);
      let state = { version: 1, groupId, uid: ownerUid, stage: 'starting', deletedCount: 0 };
      const groupRef = db.collection('groups').doc(groupId);
      const ownAccountRef = db.collection('accounts').doc(ownerUid);

      function notify(status, extra) {
        try { onProgress({ ...state, status, ...extra }); } catch (_) { /* 表示側の失敗で削除順序を変えない */ }
      }
      function checkConnection() {
        if (!auth.currentUser || auth.currentUser.uid !== ownerUid) {
          throw failure('account-changed', '接続中のアカウントが変わりました。削除を始めた管理者で接続し直してください。');
        }
        if (isOnline() === false) throw failure('offline', '通信がないため削除を確認できません。通信を戻して同じグループの削除を再開してください。');
      }
      function checkpoint(stage) {
        state.stage = stage;
        try { storage.setItem(CHECKPOINT_KEY, JSON.stringify(state)); }
        catch (cause) { throw failure('checkpoint-unavailable', '再開情報を保存できないため処理を止めました。削除完了ではありません。ブラウザの保存設定を確認してください。', cause); }
      }
      async function onlineOperation(action) {
        checkConnection();
        let timer;
        try {
          return await Promise.race([
            Promise.resolve().then(action),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(failure('operation-timeout', 'サーバーから削除の確認が届いていません。削除完了とは表示せず、通信を確認して再開してください。')), timeoutMs);
            })
          ]);
        } finally { clearTimeout(timer); }
      }
      async function serverRead(ref) {
        const snapshot = await onlineOperation(() => ref.get({ source: 'server' }));
        if (!snapshot || (snapshot.metadata && (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites))) {
          throw failure('server-unconfirmed', 'サーバー上の状態を確認できません。削除完了ではありません。通信を確認してください。');
        }
        return snapshot;
      }
      function assertOwner(snapshot) {
        if (!snapshot.exists) throw failure('group-not-found', '家族グループが見つかりません。過去の削除で残ったデータがないか、この画面では確認できません。');
        if (snapshot.data().createdBy !== ownerUid) throw failure('not-owner', '共有データ全体を削除できるのは、この家族グループを作成した管理者だけです。');
      }
      async function deleteRefs(refs) {
        if (!refs.length) return;
        await onlineOperation(() => {
          const batch = db.batch();
          refs.forEach(ref => batch.delete(ref));
          return batch.commit();
        });
        state.deletedCount += refs.length;
        checkpoint(state.stage);
        notify('deleting');
      }
      async function purgeQuery(query, keepId) {
        // 毎回先頭の残存ページを読む。削除済みカーソルや端末内の件数に依存しない。
        while (true) {
          const snapshot = await serverRead(query.limit(pageSize));
          const docs = snapshot.docs.filter(doc => doc.id !== keepId);
          if (!docs.length) return;
          await deleteRefs(docs.map(doc => doc.ref));
        }
      }
      async function assertEmpty(query, keepId) {
        const snapshot = await serverRead(query.limit(keepId ? 2 : 1));
        if (snapshot.docs.some(doc => doc.id !== keepId)) {
          throw failure('data-remains', 'サーバーに未削除のデータがあります。グループ本体は残しています。同じ削除を再開してください。');
        }
      }
      async function finish() {
        let localCheckpointCleared = true;
        try { storage.removeItem(CHECKPOINT_KEY); } catch (_) { localCheckpointCleared = false; }
        const result = { status: 'complete', groupId, deletedCount: state.deletedCount, localCheckpointCleared };
        notify('complete', result);
        return result;
      }

      try {
        checkConnection();
        const pending = getPending();
        if (pending && (pending.groupId !== groupId || pending.uid !== ownerUid)) {
          throw failure('different-deletion-pending', '別の家族グループまたはアカウントの削除が途中です。先にその管理者で削除を再開してください。');
        }
        if (pending) state = pending;
        notify('checking');
        const initial = await serverRead(groupRef);
        if (!initial.exists && pending && pending.stage === 'finalizing') return await finish();
        assertOwner(initial);

        // 最初の変更より先に再開情報を確実に保存する。
        checkpoint('starting');
        await onlineOperation(() => db.runTransaction(async transaction => {
          const snapshot = await transaction.get(groupRef);
          assertOwner(snapshot);
          if (snapshot.data().deletionState !== 'deleting') {
            transaction.update(groupRef, { deletionState: 'deleting', deletionStartedAt: serverTimestamp() });
          }
        }));

        const invites = db.collection('invites').where('groupId', '==', groupId);
        const tags = db.collection('watchTags').where('groupId', '==', groupId);
        const accounts = db.collection('accounts').where('groupId', '==', groupId);
        const settings = groupRef.collection('settings').doc('watchTag');

        checkpoint('invites'); notify('deleting');
        await purgeQuery(invites);
        checkpoint('tags'); notify('deleting');
        while (true) {
          const snapshot = await serverRead(tags.limit(pageSize));
          if (!snapshot.docs.length) break;
          for (const tag of snapshot.docs) {
            const alerts = tag.ref.collection('alerts');
            await purgeQuery(alerts);
            await assertEmpty(alerts);
          }
          // alert の空確認が済んだタグだけ消す。中断時は親タグが残り再開可能。
          await deleteRefs(snapshot.docs.map(doc => doc.ref));
        }
        for (const name of ['events', 'yotei']) {
          checkpoint(name); notify('deleting');
          await purgeQuery(groupRef.collection(name));
        }
        checkpoint('settings'); notify('deleting');
        const settingSnapshot = await serverRead(settings);
        if (settingSnapshot.exists) await deleteRefs([settings]);
        checkpoint('accounts'); notify('deleting');
        // 管理者の復旧経路を最終バッチまで維持する。
        await purgeQuery(accounts, ownerUid);
        checkpoint('members'); notify('deleting');
        await purgeQuery(groupRef.collection('members'));

        checkpoint('verifying'); notify('verifying');
        for (const name of ['events', 'yotei', 'members']) await assertEmpty(groupRef.collection(name));
        await assertEmpty(invites);
        await assertEmpty(tags);
        await assertEmpty(accounts, ownerUid);
        if ((await serverRead(settings)).exists) {
          throw failure('data-remains', 'タグ設定が残っています。削除完了ではありません。削除を再開してください。');
        }
        const finalGroup = await serverRead(groupRef);
        assertOwner(finalGroup);
        if (finalGroup.data().deletionState !== 'deleting') {
          throw failure('deletion-not-locked', 'グループの書込み停止を確認できません。削除完了ではありません。');
        }
        checkpoint('finalizing'); notify('finalizing');
        let finalDeleteCount = 0;
        await onlineOperation(() => db.runTransaction(async transaction => {
          checkConnection();
          const currentGroup = await transaction.get(groupRef);
          const ownAccount = await transaction.get(ownAccountRef);
          assertOwner(currentGroup);
          if (currentGroup.data().deletionState !== 'deleting') {
            throw failure('deletion-not-locked', 'グループの書込み停止を確認できません。削除完了ではありません。');
          }
          // 同じ管理者が別端末で復旧先を切り替えても、その別グループを消さない。
          const deleteOwnAccount = ownAccount.exists && ownAccount.data().groupId === groupId;
          if (deleteOwnAccount) transaction.delete(ownAccountRef);
          transaction.delete(groupRef);
          finalDeleteCount = deleteOwnAccount ? 2 : 1;
        }));
        state.deletedCount += finalDeleteCount;
        // 最終 ACK の後にもサーバーで不存在を確認する。キャッシュを完了根拠にしない。
        if ((await serverRead(groupRef)).exists) {
          throw failure('group-remains', 'グループ本体の削除を確認できません。通信を確認して削除を再開してください。');
        }
        return await finish();
      } catch (cause) {
        const error = cause && cause.isMainicoDeletionError ? cause : failure('deletion-paused', '削除処理を中断しました。完了していません。通信や接続中のアカウントを確認して、同じ削除を再開してください。', cause);
        if (cause && cause.code && !cause.isMainicoDeletionError) error.backendCode = cause.code;
        error.deletionState = { ...state, status: 'paused' };
        notify('paused', { code: error.code });
        throw error;
      } finally {
        activeRuns.delete(runKey);
      }
    }

    return Object.freeze({ run, getPending });
  }

  global.MainicoDeletion = Object.freeze({ create, CHECKPOINT_KEY, CONFIRMATION });
})(typeof window === 'undefined' ? globalThis : window);
