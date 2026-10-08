/* 家庭につながっているスマホで招待を受け取ったとき(2026-10-07): 招待を黙って捨てない */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../invite-switch.js');

const now = Date.UTC(2026, 9, 7, 3);
const valid = { exists: true, groupId: 'NEW', used: false, expiresAtMs: now + 3600e3 };
const me = { id: 'A', data: { name: 'りえ', mode: 'kazoku', status: 'approved' } };
const honnin = { id: 'H', data: { name: '本人', mode: 'honnin', status: 'approved' } };
const pendingOther = { id: 'P', data: { name: 'たろう', mode: 'kazoku', status: 'pending' } };

// 1. 自分だけの家庭(管理者): 確認1回で、今の家庭を消して参加申請まで
assert.deepEqual(S.plan({ invite: valid, currentGroupId: 'OLD', members: [me], ownUid: 'A', ownerUid: 'A', now }), { kind: 'delete-and-join', others: 0 });
// 承認待ちの人だけなら「ほかのメンバー」に数えない
assert.equal(S.plan({ invite: valid, currentGroupId: 'OLD', members: [me, pendingOther], ownUid: 'A', ownerUid: 'A', now }).kind, 'delete-and-join');
// 2. ほかのメンバーがいる家庭の管理者: 移れない理由と方法
const blocked = S.plan({ invite: valid, currentGroupId: 'OLD', members: [me, honnin], ownUid: 'A', ownerUid: 'A', now });
assert.deepEqual(blocked, { kind: 'owner-blocked', others: 1 });
const label = S.householdLabel([me, honnin], 'A');
assert.equal(label, 'りえさんの家庭');
assert.match(S.blockedText(blocked, label), /「管理者を引き継ぐ」/);
assert.match(S.blockedText(blocked, label, true), /問い合わせる/, 'ご本人の画面では、運営者への相談を案内');
assert.match(S.blockedText(blocked, label), /ほかに1人がつながっています/);
// 3. 管理者ではない: 抜けて参加申請まで
assert.equal(S.plan({ invite: valid, currentGroupId: 'OLD', members: [me, honnin], ownUid: 'A', ownerUid: 'H', now }).kind, 'leave-and-join');
// 4. 同じ家庭の招待・使えない招待
assert.equal(S.plan({ invite: { ...valid, groupId: 'OLD' }, currentGroupId: 'OLD', members: [me], ownUid: 'A', ownerUid: 'A', now }).kind, 'same');
assert.deepEqual(S.plan({ invite: { exists: false }, currentGroupId: 'OLD', members: [me], ownUid: 'A', ownerUid: 'A', now }), { kind: 'unusable', reason: 'missing' });
assert.equal(S.plan({ invite: { ...valid, used: true }, currentGroupId: 'OLD', members: [me], ownUid: 'A', ownerUid: 'A', now }).reason, 'used');
assert.equal(S.plan({ invite: { ...valid, expiresAtMs: now - 1 }, currentGroupId: 'OLD', members: [me], ownUid: 'A', ownerUid: 'A', now }).reason, 'expired');
for (const r of ['missing', 'used', 'expired']) assert.match(S.UNUSABLE_TEXT[r], /新しい招待QR/);
// 確認の文: 自分だけの家庭は「記録は消えます」
assert.match(S.confirmText({ kind: 'delete-and-join' }, '今の家庭'), /今の家庭の記録は消えます/);
assert.match(S.confirmText({ kind: 'leave-and-join' }, 'ご本人の家庭'), /ご本人の家庭から抜けます/);

// 5. 使い方: ご本人からの招待なら「家族」。それ以外はいまの使い方のまま
assert.equal(S.joinMode('h', 'honnin'), 'kazoku');
assert.equal(S.joinMode('h', 'kazoku'), 'kazoku');
assert.equal(S.joinMode('k', 'kazoku'), 'konly', '家族だけで使う家庭の招待は、家族だけで使う');
assert.equal(S.joinMode('', 'konly'), 'konly');
assert.equal(S.joinMode(undefined, 'honnin'), 'honnin');

// 6. つながっている人の1行
assert.equal(S.peopleLine([me, honnin], 'A'), 'つながっている人：ご本人、りえさん（ご家族・あなた）');
assert.equal(S.peopleLine([honnin, me], 'H'), 'つながっている人：ご本人（あなた）、りえさん（ご家族）');
assert.equal(S.peopleLine([{ id: 'H', data: { name: 'はな', mode: 'honnin' } }], 'H'), 'つながっている人：はなさん（ご本人・あなた）　※ほかの人はまだつながっていません');
assert.equal(S.peopleLine([me, pendingOther], 'A'), 'つながっている人：りえさん（ご家族・あなた）　※ほかの人はまだつながっていません', '承認待ちは入れない');
assert.equal(S.displayName({ name: 'たろう', mode: 'kazoku' }), 'たろうさん');

// 7. 画面へのつなぎ込み
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /async function renderInviteSwitch\(\)\{/, '家庭があるときの招待はカードで扱う');
assert.match(html, /<div class="h-body">\n    <div id="invite-switch" class="invite-switch" role="region" aria-label="受け取った招待" hidden><\/div>\n    <div id="h-approve"><\/div>/, 'ご本人のホームの一番上に、招待と「参加を認める」');
assert.match(html, /if\(gid\(\)&&typeof renderInviteSwitch==='function'\)setTimeout/, 'ホームを開いたら招待を確かめる');
assert.match(html, /loadInviteFromCache\(\)\.then\(\(\)=>\{try\{renderInviteNote\(\);\}catch\(e\)\{\}try\{renderInviteSwitch\(\);\}catch\(e\)\{\}\}\);/);
assert.match(html, /このスマホは今、別の家族（'\+esc\(label\)\+'）につながっています。/);
assert.match(html, />招待された家族に移る<\/button>/);
assert.match(html, />今のままにする<\/button>/);
assert.match(html, /await getDeletionService\(\)\.run\(\{groupId:scope\.groupId,confirmation:MainicoDeletion\.CONFIRMATION\}\)/, '自分だけの家庭は消してから移る');
assert.match(html, /if\(!await leaveHouseholdAccount\(\)\)throw new Error\('invite-switch\/leave-refused'\)/, '参加メンバーは抜けてから移る');
assert.match(html, /if\(await ensureConsentForMode\(newMode,\(\)=>afterConsent\(newMode\)\)\)afterConsent\(newMode\);/, '同意が済んでいれば、そのまま参加申請');
assert.match(html, /function openConnectOrJoin\(\)\{[\s\S]{0,200}joinByCode\(\);\}/, '受け取った招待があれば、そのまま参加を申し込む');
assert.match(html, /\(previewStorage\.getItem\('mainicoMode'\)==='honnin'\?'&from=h':\(typeof isKOnly==='function'&&isKOnly\(\)\?'&from=k':''\)\)/, 'ご本人の招待QRには from=h');
assert.match(html, /onclick="pickInvited\(\)">ご家族として参加する<\/button>/, 'ご本人からの招待は、使い方を選ばずに家族として');
assert.match(html, /が参加を待っています<\/div>/);
assert.equal((html.match(/<p class="connected-people" data-connected-people aria-live="polite"><\/p>/g) || []).length, 3, '家族のホーム・家族の設定・ご本人の設定');
assert.match(html, /id="pending-invite-note"/);
const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
assert.match(sw, /'invite-switch\.js'/);
assert.match(html, /if\(inv\.from==='h'\|\|inv\.from==='k'\)showEntryChoices\(false\);/, 'ご本人からの招待では「ご家族として参加する」だけ');
assert.match(html, /onclick="skipInvite\(\)">この招待を使わず、ほかの使い方を選ぶ<\/button>/);
assert.match(html, /\['entry-question','select-box'\]/);
assert.match(html, /<div id="person-invite-area"><\/div>\n    <div id="person-settings-approve" class="settings-approve"><\/div>/, 'ご本人の設定: 招待QRのすぐ下に「参加を認める」');
assert.match(html, /<div id="settings-invite-area"><\/div>\n          <div id="settings-approve" class="settings-approve"><\/div>/, '家族の設定: 招待QRのすぐ下に「参加を認める」');
assert.match(html, /renderPendingCard\('h-approve', snap\);renderPendingCard\('person-settings-approve', snap\);/);
assert.match(html, /renderPendingCard\('card-pending', snap\);renderPendingCard\('settings-approve', snap\);/);
// ホーム画面に追加: ご本人・家族のホームにカード、両方の設定にボタン(ブラウザーで開いているときだけ)
assert.equal((html.match(/<div class="install-card" data-install-card hidden>/g) || []).length, 2);
assert.equal((html.match(/data-install-button hidden onclick="installApp\(\)">📲 ホーム画面に追加する<\/button>/g) || []).length, 2);
assert.match(html, /document\.querySelectorAll\('\[data-install-button\]'\)\.forEach\(el=>\{el\.hidden=standalone;\}\);/);
// 家族だけで使う: 始め方とほかの家族の参加のしかた
assert.match(html, /家族だけで使うときは、まず1人が「新しくはじめる」を押して家庭を作ります。ほかの家族は、あとで「設定」→「家族の管理」→「家族を追加する」で出す招待QRを読んで参加します。/);
assert.match(html, /isKOnly\(\)\?'&from=k':''/, '家族だけで使う家庭の招待QRには from=k');
assert.match(html, /onclick="pickInvitedKonly\(\)">家族として参加する<\/button>/);
console.log('受け取った招待を黙って捨てない: 判断・つながっている人・画面のつなぎ込み passed');
