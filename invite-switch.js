/* まいにこ 招待を受け取ったときの判断(2026-10-07・理絵さんの2台での確認から)
 *
 * すでに家庭につながっているスマホで招待を開いても、招待を黙って捨てない。
 * この部品は「どうするか」を決めるだけで、Firestore には書かない(書くのは index.html)。
 *  - same          : 招待は、いまの家庭のもの。何もしない(招待の控えだけ消す)
 *  - unusable      : 招待が見つからない・使用済み・期限切れ。理由を知らせる
 *  - delete-and-join: いまの家庭は自分だけ(管理者)。確認1回で、いまの家庭を消して参加申請まで進む
 *  - leave-and-join : 管理者ではない。確認1回で、いまの家庭から抜けて参加申請まで進む
 *  - owner-blocked  : 管理者で、ほかにも家族がいる。移れない理由と「管理者を交代してから移る」方法を出す
 * 招待QRには、出した人がご本人なら from=h を付ける。受け取った側は「家族」として参加する。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MainicoInviteSwitch = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const MODES = ['honnin', 'kazoku', 'konly'];

  function approved(member) {
    // firestore.rules と同じ: status がない古い記録は承認済み。pending などは数えない
    return !!member && (!Object.prototype.hasOwnProperty.call(member, 'status') || member.status === 'approved');
  }
  function audience(member) {
    if (!member) return null;
    if (Object.prototype.hasOwnProperty.call(member, 'mode')) return member.mode === 'honnin' ? 'honnin' : (member.mode === 'kazoku' || member.mode === 'konly') ? 'kazoku' : null;
    return member.role === 'honnin' || member.role === 'kazoku' ? member.role : null;
  }
  /* 名前の見せ方: ご本人の既定の名前「本人」は「ご本人」 */
  function displayName(member) {
    const name = member && typeof member.name === 'string' ? member.name.trim() : '';
    if (audience(member) === 'honnin' && (!name || name === '本人')) return 'ご本人';
    return (name || '家族') + 'さん';
  }
  /* 「つながっている人：○○さん（ご本人）、△△さん（ご家族・あなた）」 */
  function peopleLine(members, ownUid) {
    const list = (members || []).filter((m) => m && approved(m.data));
    if (!list.length) return '';
    list.sort((a, b) => (audience(a.data) === 'honnin' ? 0 : 1) - (audience(b.data) === 'honnin' ? 0 : 1));
    const parts = list.map((m) => {
      const kind = audience(m.data) === 'honnin' ? 'ご本人' : 'ご家族';
      const name = displayName(m.data);
      const tags = [];
      if (name !== 'ご本人') tags.push(kind);
      if (m.id === ownUid) tags.push('あなた');
      return name + (tags.length ? '（' + tags.join('・') + '）' : '');
    });
    return 'つながっている人：' + parts.join('、') + (list.length === 1 ? '　※ほかの人はまだつながっていません' : '');
  }
  /* 招待で入るときの使い方。出した人がご本人なら「家族」。それ以外は、いまの使い方のまま */
  function joinMode(from, currentMode) {
    if (from === 'h') return 'kazoku';
    if (from === 'k') return 'konly';
    return MODES.includes(currentMode) ? currentMode : null;
  }
  /* いまの家庭の呼び名(管理者の名前) */
  function householdLabel(members, ownerUid) {
    const owner = (members || []).find((m) => m && m.id === ownerUid);
    return owner ? displayName(owner.data) + 'の家庭' : '今の家庭';
  }
  /* invite: {exists, groupId, used, expiresAtMs}  members: [{id,data}]  now: ms */
  function plan(opts) {
    const o = opts || {};
    const inv = o.invite || {};
    if (inv.exists && inv.groupId && inv.groupId === o.currentGroupId) return { kind: 'same' };
    if (!inv.exists) return { kind: 'unusable', reason: 'missing' };
    if (inv.used) return { kind: 'unusable', reason: 'used' };
    if (typeof inv.expiresAtMs === 'number' && inv.expiresAtMs < (o.now || Date.now())) return { kind: 'unusable', reason: 'expired' };
    const others = (o.members || []).filter((m) => m && m.id !== o.ownUid && approved(m.data)).length;
    if (o.ownUid && o.ownUid === o.ownerUid) {
      return others ? { kind: 'owner-blocked', others } : { kind: 'delete-and-join', others: 0 };
    }
    return { kind: 'leave-and-join', others };
  }
  const UNUSABLE_TEXT = {
    missing: '受け取った招待コードが見つかりませんでした。招待した人に、新しい招待QRを出してもらってください。',
    used: '受け取った招待コードは、もう使われています。招待した人に、新しい招待QRを出してもらってください。',
    expired: '受け取った招待コードは、期限（24時間）が切れています。招待した人に、新しい招待QRを出してもらってください。'
  };
  function confirmText(p, label) {
    if (p.kind === 'delete-and-join') return '招待された家族に移りますか？\n\n・' + label + 'には、ほかの人がつながっていません。\n・今の家庭の記録は消えます（元に戻せません）。\n・このあと、招待された家族に参加を申し込みます。相手が「参加を認める」を押すと使えます。';
    if (p.kind === 'leave-and-join') return '招待された家族に移りますか？\n\n・' + label + 'から抜けます。今の家庭の記録は見られなくなります（記録は今の家庭に残ります）。\n・このあと、招待された家族に参加を申し込みます。相手が「参加を認める」を押すと使えます。';
    return '';
  }
  function blockedText(p, label, onPersonScreen) {
    const head = 'このスマホは' + label + 'の管理者で、ほかに' + p.others + '人がつながっています。管理者がいなくなると家庭を管理できないため、このままでは移れません。\n\n';
    if (onPersonScreen) return head + 'ご本人のスマホからは、管理者を渡せません。移りたいときは、まいにこの「問い合わせる」から運営者に相談してください。';
    return head + '移るときは：\n1. 「設定」→「家族の管理」→「管理者を引き継ぐ」で、ほかの家族に管理者を渡す\n2. 渡し終わったら、もう一度この招待を開く（招待は24時間有効です。切れたら新しい招待QRをもらってください）';
  }
  return { plan, joinMode, displayName, peopleLine, householdLabel, confirmText, blockedText, UNUSABLE_TEXT, audience, approved };
});
