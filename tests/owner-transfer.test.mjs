/* 管理者の交代: 画面の案内（依頼・取り消し・断る・受け取る・開き直さずに切り替わる） */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
await import('../owner-transfer.js');
const T=globalThis.MainicoOwnerTransfer;
const NOW=Date.UTC(2026,9,2,3,0);
const ts=ms=>({toMillis:()=>ms});
const members={own:{name:'太郎',role:'kazoku',status:'approved'},heir:{name:'次子',role:'kazoku',status:'approved'},
  per:{name:'花子',role:'honnin',mode:'honnin',status:'approved'},wait:{name:'待ち',role:'kazoku',status:'pending'},
  konly:{name:'三郎',role:'kazoku',mode:'konly',status:'approved'}};
// 1. 引継先の候補は、承認済みの家族だけ（ご本人・承認待ち・自分は出ない）
assert.deepEqual(T.eligible(members,'own').map(m=>m.id),['heir','konly']);
// 2. 期限
assert.equal(T.pendingOf({pendingOwner:'heir',pendingOwnerAt:ts(NOW-T.DAY+1000)},NOW).expired,false);
assert.equal(T.pendingOf({pendingOwner:'heir',pendingOwnerAt:ts(NOW-T.DAY)},NOW).expired,true);
assert.equal(T.pendingOf({},NOW),null);
// 3. 受け取れる状態か
assert.equal(T.readiness({isAnonymous:true}),'need-recovery');
assert.equal(T.readiness({isAnonymous:false,email:'a@b',emailVerified:false,providerData:[{providerId:'password'}]}),'need-verify');
assert.equal(T.readiness({isAnonymous:false,email:'a@b',emailVerified:true,providerData:[{providerId:'password'}]}),'ready');
// 4. エラーの言葉
assert.match(T.message({code:'auth/wrong-password'}),/パスワードが違います/);
assert.match(T.message({code:'permission-denied'}),/24時間/);

function setup(me,user){
  const dom=new JSDOM('<div id="owner-transfer-card"></div><div id="owner-transfer-settings"></div>');
  const d=dom.window.document,updates=[],asked=[];let fail=null;
  const ctx={doc:d,uid:()=>me,members:()=>members,user:()=>user,now:()=>NOW,
    group:()=>({update:async v=>{if(fail)throw fail;updates.push(v);}}),serverTimestamp:()=>'SERVER',deleteField:()=>'DELETE',
    credential:(e,p)=>({e,p}),ask:async(t,ok)=>{asked.push([t,ok]);return true;},openRecovery:()=>{ctx.opened=true;}};
  const ctl=T.create(ctx);
  return {d,ctl,updates,asked,ctx,setFail:e=>{fail=e;},click:a=>ctl.handle(a)};
}
// 5. 今の管理者の設定: 候補を選んで頼む。大きな確認で相手の名前と意味を出す
{
  const t=setup('own',{uid:'own',isAnonymous:true});
  t.ctl.onGroup({createdBy:'own'});
  const set=t.d.getElementById('owner-transfer-settings');
  assert.match(set.innerHTML,/<option value="heir">次子<\/option>/);
  assert.doesNotMatch(set.innerHTML,/花子|待ち/);
  assert.match(set.innerHTML,/復旧の設定（メールの確認まで）/);
  t.d.getElementById('owner-transfer-target').value='heir';
  assert.equal(await t.click('request'),true);
  assert.match(t.asked[0][0],/次子さんに、管理者の引き継ぎを頼みます[\s\S]*24時間以内[\s\S]*普通の家族として残ります/);
  assert.equal(t.asked[0][1],'次子さんに頼む');
  assert.deepEqual(t.updates[0],{pendingOwner:'heir',pendingOwnerAt:'SERVER'});
  // 6. 依頼中は「頼んでいます」と取り消し。管理者はまだ自分
  t.ctl.onGroup({createdBy:'own',pendingOwner:'heir',pendingOwnerAt:ts(NOW)});
  assert.match(set.innerHTML,/次子さんに引き継ぎを頼んでいます/);
  assert.match(set.innerHTML,/受け取られるまで、管理者はあなたのままです/);
  assert.equal(await t.click('cancel'),true);
  assert.deepEqual(t.updates[1],{pendingOwner:'DELETE',pendingOwnerAt:'DELETE'});
  // 7. 期限切れは、また頼める
  t.ctl.onGroup({createdBy:'own',pendingOwner:'heir',pendingOwnerAt:ts(NOW-T.DAY-1)});
  assert.match(set.innerHTML,/期限が過ぎました/);assert.match(set.innerHTML,/この人に引き継ぎを頼む/);
  // 8. 管理者のホームには受け取りカードは出ない
  assert.equal(t.d.getElementById('owner-transfer-card').innerHTML,'');
}
// 9. 引継先: 匿名のままなら、先に復旧の設定へ案内（受け取るボタンは出さない）
{
  const t=setup('heir',{uid:'heir',isAnonymous:true});
  t.ctl.onGroup({createdBy:'own',pendingOwner:'heir',pendingOwnerAt:ts(NOW)});
  const card=t.d.getElementById('owner-transfer-card');
  assert.match(card.innerHTML,/管理者の引き継ぎを頼まれました/);assert.match(card.innerHTML,/太郎さんから/);
  assert.match(card.innerHTML,/復旧の設定（メールの確認まで）を済ませてください/);
  assert.doesNotMatch(card.innerHTML,/data-owner-transfer="accept"/);
  await t.click('recovery');assert.equal(t.ctx.opened,true);
  // 10. 断る
  assert.equal(await t.click('decline'),true);
  assert.deepEqual(t.updates[0],{pendingOwner:'DELETE',pendingOwnerAt:'DELETE'});
  assert.match(t.asked[0][0],/断りますか/);
  // 11. 引継先でない家族には出ない
  const o=setup('konly',{uid:'konly',isAnonymous:true});
  o.ctl.onGroup({createdBy:'own',pendingOwner:'heir',pendingOwnerAt:ts(NOW)});
  assert.equal(o.d.getElementById('owner-transfer-card').innerHTML,'');
}
// 12. 引継先: 復旧設定済みなら、パスワードを入れ直して受け取る（入れ直し→新しい鍵→1回で書く）
{
  const order=[];
  const user={uid:'heir',email:'heir@example.com',isAnonymous:false,emailVerified:true,providerData:[{providerId:'password'}],
    reauthenticateWithCredential:async c=>{order.push(['reauth',c.e,c.p]);},getIdToken:async f=>{order.push(['token',f]);}};
  const t=setup('heir',user);
  t.ctl.onGroup({createdBy:'own',pendingOwner:'heir',pendingOwnerAt:ts(NOW)});
  const card=t.d.getElementById('owner-transfer-card');
  assert.match(card.innerHTML,/autocomplete="current-password"/);assert.match(card.innerHTML,/heir@example\.com/);
  // 再接続など関係のない更新や名簿の更新でも、入力中のパスワードは消えない
  t.d.getElementById('owner-transfer-password').value='typing';
  t.ctl.onGroup({createdBy:'own',pendingOwner:'heir',pendingOwnerAt:ts(NOW)});
  t.ctl.renderCard();
  assert.equal(t.d.getElementById('owner-transfer-password').value,'typing');
  t.d.getElementById('owner-transfer-password').value='';
  assert.equal(await t.click('accept'),false,'パスワードが空なら書かない');
  assert.equal(t.updates.length,0);
  t.d.getElementById('owner-transfer-password').value='secret-pass-123';
  t.setFail(Object.assign(new Error('x'),{code:'permission-denied'}));
  assert.equal(await t.click('accept'),false);
  assert.match(t.d.getElementById('owner-transfer-card-state').textContent,/24時間/);
  t.setFail(null);t.d.getElementById('owner-transfer-password').value='secret-pass-123';
  assert.equal(await t.click('accept'),true);
  assert.deepEqual(order.slice(-2),[['reauth','heir@example.com','secret-pass-123'],['token',true]]);
  assert.deepEqual(t.updates.at(-1),{createdBy:'heir',pendingOwner:'DELETE',pendingOwnerAt:'DELETE'});
  assert.equal(t.d.getElementById('owner-transfer-password').value,'','パスワードは残さない');
  // 13. 交代のあと、開き直さなくても切り替わる（新しい管理者）
  t.ctl.onGroup({createdBy:'heir'});
  assert.match(card.innerHTML,/管理者を引き継ぎました/);
  assert.match(t.d.getElementById('owner-transfer-settings').innerHTML,/この人に引き継ぎを頼む|引き継げる家族/);
  await t.click('ok');assert.equal(card.innerHTML,'');
}
// 14. 交代のあと、開き直さなくても切り替わる（元の管理者）
{
  const t=setup('own',{uid:'own',isAnonymous:true});
  t.ctl.onGroup({createdBy:'own',pendingOwner:'heir',pendingOwnerAt:ts(NOW)});
  t.ctl.onGroup({createdBy:'heir'});
  assert.match(t.d.getElementById('owner-transfer-card').innerHTML,/管理者を次子さんに引き継ぎました。あなたは普通の家族として/);
  assert.match(t.d.getElementById('owner-transfer-settings').innerHTML,/今の管理者（次子さん）が依頼します/);
}
// 15. 画面への組み込み: 家庭の見張りから毎回呼ぶ・管理者だけのボタンも同時に切り替わる・設定の場所
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const ui=fs.readFileSync(new URL('../household-ui.js',import.meta.url),'utf8');
const watch=ui.slice(ui.indexOf('function watchHouseholdAccess('),ui.indexOf('async function saveRecoveryPointer('));
assert.match(watch,/applyHouseholdPermissions\(\);\s*if\(typeof ownerTransferChanged==='function'\)ownerTransferChanged\(doc\.data\(\)\);/);
assert.match(html,/function afterOwnerChanged\(\)\{[\s\S]*renderPendingCard\(lastPendingSnap\.id,lastPendingSnap\.snap\)[\s\S]*renderSetMembers\(\)[\s\S]*loadWatchTag\(\)/);
assert.match(html,/id="menu-family"[\s\S]*<h4>管理者を引き継ぐ<\/h4>[\s\S]*id="owner-transfer-settings"[\s\S]*id="menu-line"/);
assert.ok(html.indexOf('id="owner-transfer-card"')<html.indexOf('id="hitokoe-card"'),'受け取りカードは「いま見てほしいこと」に出る');
assert.match(html,/<script src="owner-transfer\.js\?v=/);
console.log('管理者の交代（画面）: 候補・期限・受け取れる状態・言葉・依頼・取り消し・期限切れ・断る・受け取り・開き直さずに切り替わる・組み込み 15項目 passed');
