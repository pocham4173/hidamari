/* まいにこ「家族の1分アンケート」(2026-10-05・事業計画書 第2版 Phase 0 の判定用・任意)
 *
 * 家族のホームに、月に1回だけ小さなカードを出す。答えなくても使い方は何も変わらない。
 *  - はじめての1回: まいにこを使い始める前の1か月で、親のことで仕事を休んだ・早退した回数
 *  - その後は毎月: この1か月の回数と、親のようすを確かめる負担(減った・変わらない・増えた)
 * 答えは surveyAnswers/{利用者ID_年-月} に、答えた本人だけが読み書きできる形で保存する(ほかの家族には見えない)。
 * 運営者には、名前の分からない全体の数字だけが届く(LINE送信役の「集計」)。
 * 「今回は答えない」を押した月は、その月はもう出さない(この端末だけの控え)。ご本人の画面には出さない。
 */
(function (global) {
  'use strict';
  var ABSENCES = [[0, '0回'], [1, '1回'], [2, '2〜3回'], [4, '4回以上'], [-1, '働いていない・答えない']];
  var BURDEN = [['less', '減った'], ['same', '変わらない'], ['more', '増えた'], ['unknown', 'まだ分からない']];

  function monthOf(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* 今月、何を聞くか: 'baseline' / 'monthly' / ''(聞かない) */
  function whatToAsk(rows, now) {
    var month = monthOf(now);
    var mine = (rows || []).filter(function (v) { return v && typeof v.month === 'string'; });
    if (mine.some(function (v) { return v.month === month; })) return '';
    if (!mine.some(function (v) { return v.kind === 'baseline'; })) return 'baseline';
    return 'monthly';
  }

  function radios(name, list) {
    return '<div class="survey-opts" role="radiogroup">' + list.map(function (o) {
      return '<label class="survey-opt"><input type="radio" name="' + name + '" value="' + esc(o[0]) + '"> ' + esc(o[1]) + '</label>';
    }).join('') + '</div>';
  }

  function cardHtml(kind) {
    var q1 = kind === 'baseline'
      ? 'まいにこを使い始める<b>前の1か月</b>で、親のことで仕事を休んだり早退したりしたのは何回ですか。'
      : '<b>この1か月</b>で、親のことで仕事を休んだり早退したりしたのは何回ですか。';
    return '<div class="card survey-card" role="region" aria-label="試験運用のアンケート">' +
      '<h3>📝 試験運用のアンケート（任意・1分）</h3>' +
      '<p class="note">答えは<b>ほかの家族には見えません</b>。答えなくても、使い方は何も変わりません。</p>' +
      '<p class="survey-q">' + q1 + '</p>' + radios('survey-absences', ABSENCES) +
      (kind === 'monthly' ? '<p class="survey-q">まいにこを使って、親のようすを確かめる<b>負担</b>はどうですか。</p>' + radios('survey-burden', BURDEN) : '') +
      '<button class="big-btn family" type="button" data-survey-act="send">答える</button>' +
      '<button class="set-btn" type="button" data-survey-act="skip">今回は答えない</button>' +
      '<div class="save-state" data-survey-state aria-live="polite"></div></div>';
  }

  function create(ctx) {
    var st = { rows: [], loaded: false, unsub: null, kind: '', sending: false, thanks: false };
    function skipKey() { return 'mainicoSurveySkip-' + ctx.uid() + '-' + monthOf(ctx.now()); }
    function skipped() { try { return !!ctx.storage.getItem(skipKey()); } catch (e) { return false; } }
    function render() {
      var box = ctx.document.getElementById(ctx.cardId);
      if (!box) return;
      if (st.thanks) { box.innerHTML = '<div class="card survey-card done" role="status"><p>📝 アンケートに答えていただき、ありがとうございました。</p></div>'; return; }
      st.kind = st.loaded && ctx.isFamily() && !skipped() ? whatToAsk(st.rows, ctx.now()) : '';
      if (!st.kind) { box.innerHTML = ''; return; }
      box.innerHTML = cardHtml(st.kind);
      var q = function (s) { return box.querySelector(s); };
      var say = function (t, err) { var e = q('[data-survey-state]'); e.textContent = t; e.classList.toggle('err', !!err); };
      q('[data-survey-act="skip"]').addEventListener('click', function () {
        try { ctx.storage.setItem(skipKey(), '1'); } catch (e) {}
        render();
      });
      q('[data-survey-act="send"]').addEventListener('click', async function () {
        if (st.sending) return;
        var a = box.querySelector('input[name="survey-absences"]:checked');
        var b = box.querySelector('input[name="survey-burden"]:checked');
        if (!a || (st.kind === 'monthly' && !b)) { say('すべての質問で、どれか1つを選んでください', true); return; }
        st.sending = true; this.disabled = true; say('保存しています…');
        var month = monthOf(ctx.now());
        try {
          await ctx.save(ctx.uid() + '_' + month, {
            uid: ctx.uid(), groupId: ctx.groupId(), month: month, kind: st.kind,
            absences: Number(a.value), burden: st.kind === 'monthly' ? b.value : '',
          });
          st.thanks = true; render();
        } catch (e) {
          this.disabled = false; say('保存できませんでした。通信を確認して、もう一度押してください', true);
        } finally { st.sending = false; }
      });
    }
    function start() {
      stop();
      st.loaded = false; st.rows = []; st.thanks = false;
      st.unsub = ctx.watchMine(function (rows) { st.rows = rows; st.loaded = true; render(); });
      render();
    }
    function stop() { if (st.unsub) { try { st.unsub(); } catch (e) {} st.unsub = null; } }
    return { start: start, stop: stop, render: render };
  }

  global.MainicoSurvey = { create: create, whatToAsk: whatToAsk, cardHtml: cardHtml, monthOf: monthOf, ABSENCES: ABSENCES, BURDEN: BURDEN };
})(typeof window !== 'undefined' ? window : globalThis);
