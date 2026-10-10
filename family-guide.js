/* はじめての道案内（家族の画面だけ・3つの手順）
   作り直し設計（第3回・2026-10-10）: 今日見ること → 記録する → 設定 の順に1回だけ案内する。
   ・この端末で一度見終わる（または閉じる）と、二度と自動では出ない。
   ・ヘルプの「もう一度見る」から出し直せる（?guide=1）。
   ・おまもりタグの未確認の知らせがあるときは出さない（知らせが最優先）。
   ・ご本人の画面では使わない（呼び出し側が家族の画面だけで start する）。 */
(function (root) {
  'use strict';
  var DONE_KEY = 'mainicoFamilyGuideDone';

  function steps(kOnly) {
    /* 2026-10-10 使いやすさの見直し: 家族のホームは「今日見ること」と「記録する」 */
    return [
      { target: 'family-handoff-heading', title: '今日見ること',
        text: kOnly
          ? '今日の様子（家族が確認・記録したこと）、直近の予定、未確認の伝言が、ここに並びます。'
          : '今日の様子（ご本人が押したこと）、直近の予定、未確認の伝言が、ここに並びます。ご本人への返事もここからできます。' },
      { target: 'card-record-actions', title: '記録する',
        text: '様子を記録する・予定を入れる・伝言を書く は、ここから。押すと入力の画面が開き、「← ホームに戻る」で戻れます。' },
      { target: 'nav-settings', title: '設定',
        text: kOnly
          ? 'LINEのお知らせは、ここから始められます。ほかの家族の招待（QRコード）や機種変更の備えも、ここです。'
          : 'ひと声のきっかけやLINEのお知らせは、ここから始められます。家族の招待（QRコード）や機種変更の備えも、ここです。' },
    ];
  }

  function create(ctx) {
    var doc = ctx.doc, storage = ctx.storage;
    var box = null, index = 0, list = [], focused = null;

    function done() { try { return storage.getItem(DONE_KEY) === '1'; } catch (e) { return false; } }
    function markDone() { try { storage.setItem(DONE_KEY, '1'); } catch (e) {} }
    function unfocus() { if (focused) { focused.classList.remove('guide-focus'); focused = null; } }

    function close(finished) {
      unfocus();
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
      if (finished) markDone();
    }

    function show(i) {
      index = i;
      var s = list[i];
      unfocus();
      var el = doc.getElementById(s.target);
      if (el) {
        focused = el; el.classList.add('guide-focus');
        try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {}
      }
      var last = i === list.length - 1;
      box.innerHTML =
        '<p class="guide-step">はじめての方へ（' + (i + 1) + '/' + list.length + '）</p>' +
        '<h3>' + s.title + '</h3><p class="guide-text">' + s.text + '</p>' +
        '<div class="guide-btns">' +
        '<button type="button" class="guide-skip" data-guide="skip">もう大丈夫</button>' +
        '<button type="button" class="guide-next" data-guide="next">' + (last ? 'はじめる' : '次へ') + '</button>' +
        '</div>';
    }

    function start(opts) {
      opts = opts || {};
      if (box) return false;
      if (!opts.force && done()) return false;
      if (ctx.tagAlert && ctx.tagAlert()) return false;
      list = steps(!!(ctx.isKOnly && ctx.isKOnly()));
      box = doc.createElement('div');
      box.id = 'family-guide';
      box.className = 'family-guide';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-live', 'polite');
      box.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-guide');
        if (t === 'skip') close(true);
        else if (t === 'next') { if (index >= list.length - 1) close(true); else show(index + 1); }
      });
      doc.body.appendChild(box);
      show(0);
      return true;
    }

    /* 知らせが届いたら道案内はいったん下げる（見終わった扱いにはしない） */
    function interrupt() { if (box) close(false); }

    return { start: start, close: close, interrupt: interrupt, isOpen: function () { return !!box; }, step: function () { return index; } };
  }

  /* ヘルプの「もう一度見る」(?guide=1) を受け取って、見終わった印を消す */
  function captureReplay(loc, storage, history) {
    try {
      var u = new URL(loc.href);
      if (u.searchParams.get('guide') !== '1') return false;
      u.searchParams.delete('guide');
      if (history && history.replaceState) history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      storage.removeItem(DONE_KEY);
      return true;
    } catch (e) { return false; }
  }

  root.MainicoFamilyGuide = { create: create, steps: steps, captureReplay: captureReplay, DONE_KEY: DONE_KEY };
})(typeof window !== 'undefined' ? window : globalThis);
