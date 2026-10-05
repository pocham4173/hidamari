/* まいにこ「ご本人の新しいスマホを再接続QRでつなぐ」(2026-10-05・作り直し設計書 A2)
 *
 * 機種変更・スマホをなくしたとき、ご本人はメールやパスワードを使わずに、今までの記録に戻れる。
 *  1. 家族(承認済み・ご本人ではない)が「ご本人の新しいスマホをつなぐ」を押すと、1回限り・10分のQRが出る。
 *     コードは reconnectCodes/{16文字} に保存する(ルールで、作る人と相手=同じ家庭のご本人 を確かめる)。
 *  2. ご本人の新しいスマホで、まいにこの入口の「ご本人：前のスマホの記録に戻る」からQRを読む。
 *  3. 送信役(/auth/reconnect)がコードを確かめて使い切り、ご本人と同じUIDの1回だけのトークンを返す。
 *     前のスマホのログインは無効にする(遅くとも1時間で使えなくなる)。
 *  QRには「まいにこのアドレス + ?reconnect=コード」だけを入れる。名前や家庭の番号は入れない。
 *  記録のある画面(すでに家庭とつながっている画面)は、ほかのアカウントに切り替えない。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MainicoReconnect = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 0/1/I/O を使わない32文字
  const CODE_RE = /^[A-HJ-NP-Z2-9]{16}$/;
  const APP_ORIGIN = 'https://pocham4173.github.io';
  const APP_PATH = '/hidamari/';
  const TTL_MS = 10 * 60 * 1000;

  function problem(code) { const e = new Error(code); e.code = code; return e; }
  function message(error) {
    const code = error && error.code || '';
    return ({
      network: '通信できませんでした。電波のよいところで、もう一度お試しください。記録は変わっていません。',
      disabled: 'この機能は準備中です。',
      'app-check': '安全の確認ができませんでした。まいにこを開き直して、もう一度お試しください。',
      'bad-request': 'まいにこの再接続QRではありません。ご家族の画面に出ているQRを読んでください。',
      used: 'このQRは、すでに使われたか取り消されています。ご家族に、もう一度QRを出してもらってください。',
      expired: 'このQRは時間切れです（10分）。ご家族に、もう一度QRを出してもらってください。',
      'not-allowed': 'このQRでは、つなげません。QRを出したご家族が今も家庭に参加しているか、ご本人として参加しているかを確かめてください。',
      'account-unavailable': 'このアカウントは、いまは使えません（終了手続き中など）。',
      'device-in-use': 'このスマホは、すでに家庭とつながっています。記録が混ざらないよう、切り替えはしません。新しいスマホで読んでください。',
      'setup-pending': 'このスマホで家庭の作成・参加が途中です。先に、その手続きをやめてから読んでください。',
      'deletion-pending': 'このスマホで削除の確認が残っています。先に削除画面で確認してください。',
      'session-changed': '手続きの途中で、このスマホのログインが変わったため、中止しました。もう一度お試しください。',
      server: '混み合っています。少し待ってから、もう一度お試しください（QRは、もう一度出してもらう必要があることがあります）。',
      retry: '混み合っています。少し待ってから、もう一度お試しください。',
    })[code] || 'つなげませんでした。記録は変わっていません。時間をおいて、もう一度お試しください。';
  }

  /* 偏りのない16文字のコード */
  function newCode(crypto) {
    let out = '';
    while (out.length < 16) {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      for (const b of bytes) { if (b < 224 && out.length < 16) out += ALPHABET[b % 32]; }   // 224 = 32*7(偏り防止)
    }
    return out;
  }
  function qrUrl(code) { return APP_ORIGIN + APP_PATH + '?reconnect=' + encodeURIComponent(code); }
  /* 読み取った文字から再接続コードを取り出す(まいにこのアドレス+?reconnect=、またはコードの文字だけ) */
  function parse(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    const bare = raw.replace(/[\s-]/g, '').toUpperCase();
    if (CODE_RE.test(bare)) return bare;
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (u.origin !== APP_ORIGIN || (u.pathname !== APP_PATH && u.pathname !== APP_PATH + 'index.html')) return null;
    const code = String(u.searchParams.get('reconnect') || '').trim().toUpperCase();
    return CODE_RE.test(code) ? code : null;
  }
  function cleanBase(value) {
    const s = String(value || '').trim().replace(/\/+$/, '');
    return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(s) ? s : '';
  }

  /* 送信役との通信。baseUrl が空なら、この機能は出さない */
  function client(options) {
    const base = cleanBase(options.baseUrl);
    return {
      enabled: () => !!base,
      async exchange(code) {
        if (!base) throw problem('disabled');
        if (!CODE_RE.test(code || '')) throw problem('bad-request');
        const headers = { 'content-type': 'application/json' };
        let token = '';
        try { token = await options.getAppCheckToken(); } catch (e) { token = ''; }
        if (token) headers['x-firebase-appcheck'] = token;
        let res;
        try {
          res = await options.fetch(base + '/auth/reconnect', { method: 'POST', headers, body: JSON.stringify({ code }),
            cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
        } catch (e) { throw problem('network'); }
        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (!res.ok) throw problem(data && typeof data.error === 'string' ? data.error : 'retry');
        if (!data || typeof data.customToken !== 'string' || typeof data.uid !== 'string') throw problem('server');
        return data;
      },
    };
  }

  return { newCode, qrUrl, parse, client, message, CODE_RE, TTL_MS };
});
