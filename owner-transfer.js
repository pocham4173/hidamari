/* 管理者の交代（作り直し第2回 2026-10-02）
   今の管理者が「依頼」し、引継先が自分で「受け取る」2段階。依頼は24時間有効。
   受け取る人は、復旧設定（メール確認まで）を済ませ、受け取る直前にパスワードを入れ直す。
   権限の最終判定は Firestore のルールが行う。この画面は分かりやすく案内するだけ。 */
(function (root) {
  'use strict';
  var DAY = 24 * 60 * 60 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ms(t) {
    if (!t) return 0;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    if (t instanceof Date) return t.getTime();
    return Number(t) || 0;
  }
  function when(t) {
    var d = new Date(t);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* 依頼の状態。期限切れは「依頼なし」と同じに扱う（ルールも受け取りを拒否する） */
  function pendingOf(data, now) {
    if (!data || !data.pendingOwner) return null;
    var at = ms(data.pendingOwnerAt);
    if (!at) return { target: data.pendingOwner, at: 0, until: 0, expired: false, saving: true };
    return { target: data.pendingOwner, at: at, until: at + DAY, expired: now >= at + DAY };
  }

  /* 引継先になれるのは、承認済みの「家族」（ご本人の画面で使う人・承認待ちは除く） */
  function eligible(members, me) {
    return Object.keys(members || {}).filter(function (id) {
      var m = members[id] || {};
      return id !== me && (m.status || 'approved') === 'approved' && m.role === 'kazoku' && (m.mode || 'kazoku') !== 'honnin';
    }).map(function (id) { return { id: id, name: members[id].name || '家族' }; });
  }

  /* 受け取れる状態か：メール確認済みの、パスワードでのログインがあること */
  function readiness(user) {
    if (!user || user.isAnonymous) return 'need-recovery';
    var hasPassword = (user.providerData || []).some(function (p) { return p && p.providerId === 'password'; });
    if (!hasPassword || !user.email) return 'need-recovery';
    if (!user.emailVerified) return 'need-verify';
    return 'ready';
  }

  function message(error) {
    var code = error && error.code || '';
    if (/wrong-password|invalid-credential|invalid-login-credentials/.test(code)) return 'パスワードが違います。復旧の設定で登録したパスワードを入れてください。';
    if (/too-many-requests/.test(code)) return '何度も間違えたため、しばらく受け取れません。時間をおいてやり直してください。';
    if (/permission-denied/.test(code)) return '受け取れませんでした。依頼の期限（24時間）が過ぎたか、取り消された可能性があります。管理者にもう一度頼んでもらってください。';
    if (/network|unavailable/.test(code)) return '通信を確認できませんでした。通信のよいところでやり直してください。';
    return '受け取れませんでした。通信を確認して、やり直してください。';
  }

  function create(ctx) {
    var busy = false, lastOwner = null, lastData = null, notice = '';

    function me() { return ctx.uid(); }
    function names() { return ctx.members() || {}; }
    function nameOf(id) { var m = names()[id]; return m && m.name ? m.name : '家族'; }
    function el(id) { return ctx.doc.getElementById(id); }
    function state(id, text, err) {
      var s = el(id); if (!s) return;
      s.textContent = text; if (s.classList) s.classList.toggle('err', !!err);
    }

    /* 家庭の文書が変わるたび（交代の直後も、開き直さずに）呼ばれる */
    function keyOf(d) {
      return d ? [d.createdBy || '', d.pendingOwner || '', ms(d.pendingOwnerAt)].join('|') : '';
    }
    function onGroup(data) {
      /* 通信の再接続など、管理者・依頼に関係のない更新では作り直さない(入力中のパスワードを消さない) */
      if (lastData && keyOf(lastData) === keyOf(data)) { lastData = data || null; return; }
      var owner = data && data.createdBy || '';
      if (lastOwner && owner && lastOwner !== owner) {
        if (owner === me()) notice = '管理者を引き継ぎました。招待・参加の承認・おまもりタグ・共有データの削除は、あなたが行います。';
        else if (lastOwner === me()) notice = '管理者を' + nameOf(owner) + 'さんに引き継ぎました。あなたは普通の家族として、これまでどおり使えます。';
      }
      lastOwner = owner; lastData = data || null;
      renderCard(); renderSettings();
    }

    function renderSettings() {
      var box = el('owner-transfer-settings'); if (!box) return;
      var owner = lastData && lastData.createdBy === me();
      if (!owner) {
        box.innerHTML = '<p class="note">管理者の交代は、今の管理者（' + esc(nameOf(lastData && lastData.createdBy)) + 'さん）が依頼します。</p>';
        return;
      }
      var p = pendingOf(lastData, ctx.now());
      if (p && !p.expired) {
        box.innerHTML = '<p class="note"><strong>' + esc(nameOf(p.target)) + 'さんに引き継ぎを頼んでいます</strong>' +
          (p.until ? '（' + when(p.until) + 'まで）' : '') + '。受け取られるまで、管理者はあなたのままです。</p>' +
          '<button class="set-btn" type="button" data-owner-transfer="cancel">頼むのを取り消す</button>' +
          '<div class="save-state" id="owner-transfer-state" aria-live="polite"></div>';
        return;
      }
      var list = eligible(names(), me());
      var head = '<p class="note">介護する家族が代わるときに使います。頼んだ相手が24時間以内に「受け取る」と、招待・参加の承認・おまもりタグ・共有データの削除は、その人が行うようになります。あなたは普通の家族として残り、これまでの記録はそのままです。</p>' +
        '<p class="note">受け取る人は、先に「機種変更・アカウントの復旧」で復旧の設定（メールの確認まで）を済ませておく必要があります。</p>';
      if (p && p.expired) head += '<p class="note">前の依頼（' + esc(nameOf(p.target)) + 'さん）は期限が過ぎました。管理者は変わっていません。</p>';
      if (!list.length) {
        box.innerHTML = head + '<p class="note">引き継げる家族がまだいません。家族を招待して「参加を認める」と選べるようになります。</p>';
        return;
      }
      box.innerHTML = head +
        '<label for="owner-transfer-target">引き継ぐ人</label>' +
        '<select id="owner-transfer-target">' + list.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('') + '</select>' +
        '<button class="set-btn" type="button" data-owner-transfer="request">この人に引き継ぎを頼む</button>' +
        '<div class="save-state" id="owner-transfer-state" aria-live="polite"></div>';
    }

    function renderCard() {
      var box = el('owner-transfer-card'); if (!box) return;
      var p = pendingOf(lastData, ctx.now());
      if (!p || p.expired || p.target !== me() || (lastData && lastData.createdBy === me())) {
        box.innerHTML = notice ? '<div class="card notice-card" role="status"><p><strong>' + esc(notice) + '</strong></p><button class="set-btn" type="button" data-owner-transfer="ok">わかりました</button></div>' : '';
        return;
      }
      var oldInput = el('owner-transfer-password');
      var keep = oldInput ? oldInput.value : '', hadFocus = !!(oldInput && ctx.doc.activeElement === oldInput);
      var from = nameOf(lastData.createdBy);
      var ready = readiness(ctx.user());
      var html = '<div class="card notice-card owner-transfer-card" role="region" aria-label="管理者の引き継ぎ">' +
        '<h3>管理者の引き継ぎを頼まれました</h3>' +
        '<p>' + esc(from) + 'さんから、まいにこの管理者を引き継いでほしいと頼まれています' + (p.until ? '（' + when(p.until) + 'まで）' : '') + '。</p>' +
        '<p class="note">受け取ると、招待・参加の承認・おまもりタグ・共有データの削除は、あなたが行うようになります。' + esc(from) + 'さんは普通の家族として残ります。</p>';
      if (ready === 'ready') {
        var user = ctx.user();
        html += '<p class="note">確認のため、復旧の設定で登録したパスワードを入れてください（' + esc(user.email) + '）。</p>' +
          '<input type="email" autocomplete="username" value="' + esc(user.email) + '" hidden readonly>' +
          '<label for="owner-transfer-password">パスワード</label>' +
          '<input id="owner-transfer-password" type="password" autocomplete="current-password" maxlength="128">' +
          '<button class="set-btn" type="button" data-owner-transfer="accept">受け取る</button>';
      } else {
        html += '<p class="note"><strong>' + (ready === 'need-verify'
          ? '復旧の設定のメール確認が、まだ済んでいません。確認メールのリンクを開いてから、もう一度ここを開いてください。'
          : '受け取る前に、「機種変更・アカウントの復旧」で復旧の設定（メールの確認まで）を済ませてください。') + '</strong></p>' +
          '<button class="set-btn" type="button" data-owner-transfer="recovery">復旧の設定を開く</button>';
      }
      html += '<button class="set-btn" type="button" data-owner-transfer="decline">断る</button>' +
        '<div class="save-state" id="owner-transfer-card-state" aria-live="polite"></div></div>';
      box.innerHTML = html;
      var input = el('owner-transfer-password');
      if (input && keep) { input.value = keep; if (hadFocus && input.focus) input.focus(); }
    }

    async function request() {
      if (busy) return false;
      var sel = el('owner-transfer-target'); var target = sel && sel.value;
      if (!target) return false;
      var name = nameOf(target);
      var ok = await ctx.ask(name + 'さんに、管理者の引き継ぎを頼みます。\n\n' + name + 'さんが24時間以内に「受け取る」と、招待・参加の承認・おまもりタグ・共有データの削除は' + name + 'さんが行うようになります。あなたは普通の家族として残ります。\n\n受け取られるまでは、あなたが管理者のままです。', name + 'さんに頼む');
      if (!ok) return false;
      busy = true; state('owner-transfer-state', '頼んでいます…');
      try {
        await ctx.group().update({ pendingOwner: target, pendingOwnerAt: ctx.serverTimestamp() });
        state('owner-transfer-state', name + 'さんに頼みました。' + name + 'さんのホームに「受け取る」が出ます。');
        return true;
      } catch (e) { state('owner-transfer-state', '頼めませんでした。通信を確認してください。', true); return false; }
      finally { busy = false; }
    }

    async function clear(kind) {
      if (busy) return false;
      var cancel = kind === 'cancel';
      var ok = await ctx.ask(cancel ? '管理者の引き継ぎを頼むのを取り消しますか？' : '管理者の引き継ぎを断りますか？今の管理者のままになります。', cancel ? '取り消す' : '断る');
      if (!ok) return false;
      busy = true;
      try {
        await ctx.group().update({ pendingOwner: ctx.deleteField(), pendingOwnerAt: ctx.deleteField() });
        notice = cancel ? '' : '引き継ぎを断りました。管理者は変わりません。';
        renderCard();
        return true;
      } catch (e) {
        state(cancel ? 'owner-transfer-state' : 'owner-transfer-card-state', '保存できませんでした。通信を確認してください。', true); return false;
      } finally { busy = false; }
    }

    async function accept() {
      if (busy) return false;
      var input = el('owner-transfer-password'); var password = input ? input.value : '';
      if (!password) { state('owner-transfer-card-state', 'パスワードを入れてください。', true); return false; }
      busy = true; state('owner-transfer-card-state', '確かめています…');
      try {
        var user = ctx.user();
        await user.reauthenticateWithCredential(ctx.credential(user.email, password));
        if (input) input.value = '';
        /* 入れ直した時刻(auth_time)が入った新しい鍵で書く。ルールは5分以内だけ受け付ける */
        await user.getIdToken(true);
        await ctx.group().update({ createdBy: user.uid, pendingOwner: ctx.deleteField(), pendingOwnerAt: ctx.deleteField() });
        state('owner-transfer-card-state', '引き継ぎました。');
        return true;
      } catch (e) {
        state('owner-transfer-card-state', message(e), true); return false;
      } finally { busy = false; }
    }

    function handle(action) {
      if (action === 'request') return request();
      if (action === 'cancel') return clear('cancel');
      if (action === 'decline') return clear('decline');
      if (action === 'accept') return accept();
      if (action === 'recovery') { if (ctx.openRecovery) ctx.openRecovery(); return Promise.resolve(false); }
      if (action === 'ok') { notice = ''; renderCard(); return Promise.resolve(true); }
      return Promise.resolve(false);
    }

    function reset() { lastOwner = null; lastData = null; notice = ''; busy = false; renderCard(); }

    return { onGroup: onGroup, renderSettings: renderSettings, renderCard: renderCard, handle: handle, reset: reset,
      request: request, accept: accept, clear: clear };
  }

  root.MainicoOwnerTransfer = { create: create, pendingOf: pendingOf, eligible: eligible, readiness: readiness, message: message, DAY: DAY };
})(typeof window !== 'undefined' ? window : globalThis);
