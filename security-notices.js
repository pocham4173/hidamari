/* まいにこ「安全のお知らせ」(2026-10-06・審査の指摘への対応)
 *
 * ログインに関わる大事な出来事を、家族全員とご本人の画面に出す。記録は送信役(サーバー)だけが書き、
 * アプリからは作れない・消せない(firestore.rules)。ふり返りにも残る。
 *  - line-login-signin : 「LINEでログイン」で、新しいスマホ(画面)から入った
 *  - device-reconnect  : 家族が、再接続QRでご本人の新しいスマホをつないだ
 * ホームには、直近 SHOW_DAYS 日の分を新しい順に出す。名前は記録の名前、なければ家族の名簿から。
 */
(function (global) {
  'use strict';
  var TYPES = ['line-login-signin', 'device-reconnect'];
  var SHOW_DAYS = 14;

  function when(v) {
    var ms = typeof v.clientAt === 'number' ? v.clientAt : (v.at && typeof v.at.toMillis === 'function' ? v.at.toMillis() : NaN);
    if (!isFinite(ms)) return '';
    var d = new Date(ms);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function text(v, nameOf) {
    var at = when(v);
    var tail = at ? '（' + at + '）' : '';
    if (v.type === 'device-reconnect') {
      var who = v.name || (nameOf && nameOf(v.uid)) || '家族';
      var target = (nameOf && nameOf(v.targetUid)) || 'ご本人';
      return who + 'さんが、再接続QRで' + target + 'さんの新しいスマホをつなぎました' + tail + '。前のスマホは使えなくなります。';
    }
    if (v.type === 'line-login-signin') {
      var name = (nameOf && nameOf(v.uid)) || '家族';
      return name + 'さんのアカウントに、「LINEでログイン」で新しいスマホ（画面）から入りました' + tail + '。';
    }
    return '';
  }
  function recent(rows, now) {
    var from = now.getTime() - SHOW_DAYS * 86400000;
    return (rows || []).filter(function (v) {
      return v && TYPES.indexOf(v.type) >= 0 && typeof v.clientAt === 'number' && v.clientAt >= from;
    }).sort(function (a, b) { return b.clientAt - a.clientAt; });
  }
  function render(box, rows, nameOf, now) {
    if (!box) return;
    var list = recent(rows, now || new Date());
    box.textContent = '';
    if (!list.length) return;
    var doc = box.ownerDocument;
    var card = doc.createElement('div');
    card.className = 'card security-notices';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', '安全のお知らせ');
    var h = doc.createElement('h3');
    h.textContent = '🔐 安全のお知らせ';
    card.appendChild(h);
    var ul = doc.createElement('ul');
    list.forEach(function (v) { var li = doc.createElement('li'); li.textContent = text(v, nameOf); ul.appendChild(li); });
    card.appendChild(ul);
    var p = doc.createElement('p');
    p.className = 'note';
    p.textContent = '心当たりがないときは、ご家族で確かめ、「設定」→「機種変更・アカウントの復旧」の「ほかのスマホを止める」を使ってください。この記録は、ふり返りにも残ります。';
    card.appendChild(p);
    box.appendChild(card);
  }
  /* ctx: { document, boxId, watch(cb)→unsubscribe, nameOf(uid), now() } */
  function create(ctx) {
    var unsub = null;
    function stop() { if (unsub) { try { unsub(); } catch (e) {} unsub = null; } }
    function start() {
      stop();
      unsub = ctx.watch(function (rows) { render(ctx.document.getElementById(ctx.boxId), rows, ctx.nameOf, ctx.now ? ctx.now() : new Date()); });
    }
    return { start: start, stop: stop };
  }

  global.MainicoSecurityNotices = { TYPES: TYPES, SHOW_DAYS: SHOW_DAYS, text: text, recent: recent, render: render, create: create };
})(typeof window !== 'undefined' ? window : globalThis);
