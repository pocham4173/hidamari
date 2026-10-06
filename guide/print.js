/* 使い方ガイドの印刷: 写真をすべて読み込み、よくある質問を開いてから印刷する。
 * LINEの中の画面では印刷できないことがあるので、ブラウザで開き直す案内を出す。 */
(function () {
  'use strict';
  var inLine = / Line\//i.test(navigator.userAgent);
  function prepare() {
    document.querySelectorAll('details:not([open])').forEach(function (d) { d.open = true; d.setAttribute('data-print-opened', ''); });
    var imgs = [].slice.call(document.images);
    imgs.forEach(function (im) { im.loading = 'eager'; });
    return Promise.all(imgs.map(function (im) {
      if (im.complete) return null;
      return new Promise(function (ok) { im.addEventListener('load', ok, { once: true }); im.addEventListener('error', ok, { once: true }); });
    }));
  }
  function restore() {
    document.querySelectorAll('details[data-print-opened]').forEach(function (d) { d.open = false; d.removeAttribute('data-print-opened'); });
  }
  window.addEventListener('beforeprint', prepare);
  window.addEventListener('afterprint', restore);
  document.querySelectorAll('.print-url').forEach(function (el) { el.textContent = 'このページ：' + location.origin + location.pathname; });
  document.querySelectorAll('[data-print]').forEach(function (btn) {
    btn.hidden = false;
    btn.addEventListener('click', function () {
      var note = document.getElementById('print-note');
      if (inLine && note) note.hidden = false;
      prepare().then(function () { window.print(); });
    });
  });
})();
