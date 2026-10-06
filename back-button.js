/* 説明ページの「← まいにこに戻る」
 * - まいにこの画面から来たとき(document.referrer がまいにこの画面・history.length > 1)は history.back() で前の画面へ戻る。
 *   ホーム画面のまいにこでも、ログインしたまま・開く前の設定画面に戻れる。
 * - それ以外(LINEのメニュー・直接開いたなど)は、ボタンの href(まいにこの入口)を開く。
 * - 使い方ガイドの上の帯の「アプリを開く」は、まいにこから来た人には「まいにこに戻る」と表示する。
 *   まいにこから来たかどうかは、まいにこが説明ページを開くときに残す印(sessionStorage の mainicoDocReturn)でも見る。 */
(function () {
  'use strict';
  function appPath(a) { return new URL(a.getAttribute('href'), location.href).pathname; }
  function cameFromApp(a) {
    if (history.length <= 1 || !document.referrer) return false;
    try {
      var r = new URL(document.referrer), p = appPath(a);
      return r.origin === location.origin && (r.pathname === p || r.pathname === p + 'index.html' || r.pathname + 'index.html' === p);
    } catch (e) { return false; }
  }
  function openedFromApp() { try { return !!sessionStorage.getItem('mainicoDocReturn'); } catch (e) { return false; } }
  function goBack(e) {
    var a = e.currentTarget;
    if (!cameFromApp(a)) return;  // ふつうのリンクとして、まいにこの入口を開く
    e.preventDefault();
    var left = false;
    window.addEventListener('pagehide', function () { left = true; }, { once: true });
    history.back();
    setTimeout(function () { if (!left) location.href = a.href; }, 800);  // 戻れなかったときは入口へ
  }
  var open = document.querySelector('.bar a.open');
  if (open && (cameFromApp(open) || openedFromApp())) open.textContent = 'まいにこに戻る';
  document.querySelectorAll('a.mainico-back' + (open ? ', .bar a.open' : '')).forEach(function (a) { a.addEventListener('click', goBack); });
})();
