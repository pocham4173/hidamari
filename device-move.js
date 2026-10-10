/* まいにこ ブラウザーの引っ越し(2026-10-10 理絵さん「LINEの中から、ホーム画面に追加して、そのまま使えるように」)
 *
 * LINEの中のブラウザーで使い始めた人が、ボタン1つで同じアカウントのまま Chrome(iPhoneは Safari)へ移る。
 *  1. 今のブラウザー: ログイン中の本人として、送信役(Cloudflare Worker)に使い捨ての引っ越し番号を作ってもらう(5分・1回だけ)
 *  2. Chrome を開く(Android は intent、iPhone は LINE の openExternalBrowser)。番号はURLの ?move= で渡す
 *  3. 移った先: 起動の最初に番号を送信役に出し、同じアカウントに入る鍵(カスタムトークン)で入る
 *     → 家庭は accounts/{uid} から自動で戻る(household-ui.js の起動と同じ)
 * 番号はすぐURLから消し、画面にも記録にも出さない。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MainicoDeviceMove = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const CODE_RE = /^[0-9a-f]{32}$/;

  /* LINE などのアプリの中のブラウザーか */
  function inAppBrowser(ua) {
    ua = String(ua || '');
    return / Line\//i.test(ua) || /FBAN|FBAV|Instagram/i.test(ua) || (/Android/i.test(ua) && /; wv\)/.test(ua));
  }
  function isAndroid(ua) { return /Android/i.test(String(ua || '')); }

  /* 移る先のURL。Android は Chrome を直接開く intent、それ以外は LINE の「外のブラウザーで開く」印をつける */
  function targetUrl(appUrl, code, ua) {
    const u = new URL(appUrl);
    u.hash = '';
    u.search = '?openExternalBrowser=1' + (code ? '&move=' + code : '');
    if (!isAndroid(ua)) return u.href;
    return 'intent://' + u.host + u.pathname + u.search +
      '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(u.href) + ';end';
  }

  /* 起動の最初に、URLの ?move= を取り出して、URLから消す(戻る・共有で番号が残らないように) */
  function takeCode(loc, history) {
    try {
      const u = new URL(loc.href);
      const code = u.searchParams.get('move');
      if (code === null) return '';
      u.searchParams.delete('move');
      u.searchParams.delete('openExternalBrowser');
      if (history && history.replaceState) history.replaceState(null, '', u.pathname + (u.search === '?' ? '' : u.search) + u.hash);
      return CODE_RE.test(code) ? code : '';
    } catch (e) { return ''; }
  }

  function problem(code) { const e = new Error(code); e.code = code; return e; }

  async function post(fetchFn, base, route, body, idToken) {
    const headers = { 'content-type': 'application/json' };
    if (idToken) headers.authorization = 'Bearer ' + idToken;
    let res;
    try { res = await fetchFn(base + '/auth/move/' + route, { method: 'POST', headers, body: JSON.stringify(body || {}) }); }
    catch (e) { throw problem('network'); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw problem((data && data.error) || 'server');
    return data || {};
  }

  /* 今のブラウザーで: 引っ越し番号を作る */
  async function start(opts) {
    if (!opts.base) throw problem('not-configured');
    const user = opts.auth && opts.auth.currentUser;
    if (!user) throw problem('auth-required');
    const idToken = await user.getIdToken();
    const data = await post(opts.fetch, opts.base, 'start', {}, idToken);
    if (!CODE_RE.test(String(data.code || ''))) throw problem('server');
    return data.code;
  }

  /* 移った先で: 番号を鍵に替えて、同じアカウントに入る */
  async function finish(opts, code) {
    if (!opts.base) throw problem('not-configured');
    const data = await post(opts.fetch, opts.base, 'finish', { code });
    if (typeof data.customToken !== 'string' || !data.customToken) throw problem('server');
    await opts.auth.signInWithCustomToken(data.customToken);
  }

  const MESSAGES = {
    'network': '通信できませんでした。電波を確かめて、もう一度お試しください。',
    'move-used': 'この引っ越しのボタンは、もう使われています。元の画面で、もう一度「Chromeで開いてホームに追加」を押してください。',
    'move-expired': '引っ越しの時間（5分）が過ぎました。元の画面で、もう一度「Chromeで開いてホームに追加」を押してください。',
    'no-household': '家族への参加が済んでから、引っ越しできます。',
    'account-unavailable': 'このアカウントは使えなくなっています。',
    'not-configured': 'いまは引っ越しの準備ができていません。',
    'in-use': 'このブラウザーでは、すでにまいにこを使っています。引っ越しはしませんでした。'
  };
  function message(e) { return MESSAGES[e && e.code] || '引っ越しできませんでした。少し待って、もう一度お試しください。'; }

  return { inAppBrowser, isAndroid, targetUrl, takeCode, start, finish, message, CODE_RE };
});
