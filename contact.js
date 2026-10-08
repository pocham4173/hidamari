/* まいにこ 問い合わせフォーム(2026-10-08)
 * 書いた内容から、運営者あてのメールを作る。送信はスマホのメールアプリで行う(このページは何も送らない・保存しない)。
 * メールアプリが開かないときのために、同じ文をコピーできる。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MainicoContact = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const TO = 'pocham4173@gmail.com';
  const MAX = 800;
  /* パスワード・招待コード(8文字)・メールのリンクらしいものが入っていたら知らせる */
  function warnings(text) {
    const t = String(text || '');
    const w = [];
    if (/パスワード|password|暗証/i.test(t)) w.push('パスワードは書かないでください。');
    if (/\b[A-HJ-NP-Z2-9]{8}\b/.test(t)) w.push('招待コードのような文字があります。招待コードは書かないでください。');
    if (/https?:\/\/\S+/.test(t)) w.push('リンク（https://…）は書かないでください。確認メールのリンクは特に危険です。');
    return w;
  }
  function build(form) {
    const f = form || {};
    const kind = String(f.kind || 'その他').slice(0, 40);
    const body = [
      '【まいにこへの問い合わせ】',
      '困っていること：' + kind,
      '使っているスマホ：' + (f.phone || 'わからない'),
      '使い方：' + (f.mode || 'わからない'),
      '',
      '内容：',
      String(f.text || '').trim().slice(0, MAX),
      '',
      '（このメールは、まいにこの問い合わせフォームで作りました。お返事は、このメールのあて先に送ります）'
    ].join('\n');
    const subject = 'まいにこの問い合わせ：' + kind;
    return { to: TO, subject, body, href: 'mailto:' + TO + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body) };
  }
  return { build, warnings, TO, MAX };
});
