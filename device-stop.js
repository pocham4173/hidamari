/* まいにこ「ほかのスマホを止める」(2026-10-05・作り直し設計書 A2「紛失・盗難」)
 *
 * スマホをなくしたとき、同じアカウントで使っているほかのスマホから、まいにこを使えないようにする。
 * しくみ: 今のパスワードで本人確認したうえで、新しいパスワードに変える。
 *   Firebase は、パスワードが変わると、ほかの端末のログインを無効にする(遅くとも1時間以内に使えなくなる)。
 *   この端末は、新しいパスワードでそのまま使い続けられる。記録は消えない。
 * 復旧の設定(メールアドレスとパスワード・メールの確認まで)が済んでいるアカウントで使える。
 */
(function (global) {
  'use strict';
  var MIN = 12, MAX = 128;   // 復旧の設定(account-recovery.js)と同じ

  function message(e) {
    var code = e && e.code || '';
    if (code === 'auth/wrong-password' || code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials')
      return '今のパスワードが違います。もう一度入れてください。';
    if (code === 'auth/weak-password') return '新しいパスワードが設定条件を満たしていません。' + MIN + '文字以上の、推測されにくいパスワードにしてください。';
    if (code === 'auth/too-many-requests') return '何度も試したため、しばらく使えません。時間をおいてから、もう一度お試しください。';
    if (code === 'auth/network-request-failed') return '通信できませんでした。電波のよいところで、もう一度お試しください。';
    if (code === 'auth/requires-recent-login') return '確認の期限が切れました。今のパスワードを入れ直してください。';
    if (code === 'no-recovery') return '復旧の設定（メールアドレスとパスワード）が済んでいないため、使えません。';
    return '止められませんでした。通信を確認して、もう一度お試しください。';
  }

  /* 入力の確かめ(画面の前に、まとめて案内する) */
  function check(current, next, again) {
    if (!current) return '今のパスワードを入れてください。';
    if (!next || next.length < MIN || next.length > MAX) return '新しいパスワードを' + MIN + '文字以上（' + MAX + '文字まで）で入れてください。';
    if (next !== again) return '新しいパスワードが、もう一度の欄と合っていません。';
    if (next === current) return '今と違うパスワードにしてください。';
    return '';
  }

  /* 本人確認 → 新しいパスワードに変える。成功で true */
  async function stopOthers(ctx, current, next) {
    var user = ctx.user();
    if (!user || !user.email || !Array.isArray(user.providerData) || !user.providerData.some(function (p) { return p && p.providerId === 'password'; })) {
      var e = new Error('no-recovery'); e.code = 'no-recovery'; throw e;
    }
    await user.reauthenticateWithCredential(ctx.credential(user.email, current));
    await user.updatePassword(next);
    try { await user.getIdToken(true); } catch (err) { /* 新しい鍵は次の通信で取り直される */ }
    return true;
  }

  function open(ctx) {
    var doc = ctx.document;
    var wrap = doc.createElement('div');
    wrap.className = 'modal open device-stop';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'device-stop-title');
    wrap.innerHTML = '<div class="modal-box adult-font">' +
      '<h3 id="device-stop-title" style="margin-top:0;">ほかのスマホを止める</h3>' +
      '<p class="note">なくしたスマホなど、<b>このアカウントで使っているほかのスマホ</b>から、まいにこを使えないようにします。新しいパスワードに変えると、ほかのスマホは<b>遅くとも1時間以内に</b>使えなくなります。</p>' +
      '<p class="note">このスマホは、このまま使えます。記録は消えません。新しいパスワードは、機種変更や復旧のときに使います。ご家族と一緒に控えておいてください。</p>' +
      '<label class="ln-ttl">今のパスワード<input type="password" autocomplete="current-password" data-ds="current"></label>' +
      '<label class="ln-ttl">新しいパスワード（' + MIN + '文字以上）<input type="password" autocomplete="new-password" data-ds="next"></label>' +
      '<label class="ln-ttl">新しいパスワード（もう一度）<input type="password" autocomplete="new-password" data-ds="again"></label>' +
      '<button class="big-btn family" type="button" data-ds-act="stop">ほかのスマホを止める</button>' +
      '<div class="save-state" data-ds-state role="status" aria-live="polite"></div>' +
      '<button class="modal-close" type="button" data-ds-act="close">とじる</button></div>';
    doc.body.appendChild(wrap);
    var q = function (s) { return wrap.querySelector(s); };
    var say = function (t, err) { var e = q('[data-ds-state]'); e.textContent = t; e.classList.toggle('err', !!err); };
    var busy = false;
    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    q('[data-ds-act="close"]').addEventListener('click', close);
    q('[data-ds-act="stop"]').addEventListener('click', async function () {
      if (busy) return;
      var current = q('[data-ds="current"]').value, next = q('[data-ds="next"]').value, again = q('[data-ds="again"]').value;
      var problem = check(current, next, again);
      if (problem) { say(problem, true); return; }
      busy = true; this.disabled = true; say('止めています…');
      try {
        await stopOthers(ctx, current, next);
        ['current', 'next', 'again'].forEach(function (k) { q('[data-ds="' + k + '"]').value = ''; });
        say('止めました。ほかのスマホは、遅くとも1時間以内に使えなくなります。このスマホは、新しいパスワードでこのまま使えます。');
        this.textContent = '止めました';
        if (typeof ctx.onDone === 'function') ctx.onDone();
      } catch (e) {
        this.disabled = false; say(message(e), true);
      } finally { busy = false; }
    });
    return { close: close };
  }

  global.MainicoDeviceStop = { open: open, check: check, stopOthers: stopOthers, message: message, MIN: MIN };
})(typeof window !== 'undefined' ? window : globalThis);
