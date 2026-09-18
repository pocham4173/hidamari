/* 家庭の管理・復旧・削除。Firebase rules が権限の最終判定を行う。 */
'use strict';
let householdOwnerId='', householdDeleting=false, householdVerified=false;
let householdUnsub=null, ownMemberUnsub=null, recoveryBusy=false, deletionBusy=false;
let recoveryService=null, deletionService=null, householdBootGeneration=0;
const RECOVERY_JOURNAL='mainico_recovery_journal_v1';
let deletionResumeOnly=false;

function isHouseholdOwner(){ return householdVerified && householdOwnerId===uid(); }
function requireHouseholdOwner(){
  if(!isHouseholdOwner() || householdDeleting){
    alert(householdDeleting?'共有データを削除中です。削除画面から再開してください。':'この操作は、この家庭を最初に作成した管理者が行えます。');
    return false;
  }
  return true;
}
function applyHouseholdPermissions(){
  document.querySelectorAll('[data-owner-only]').forEach(el=>el.hidden=!isHouseholdOwner() || householdDeleting);
  document.querySelectorAll('[data-household-role]').forEach(el=>el.textContent=isHouseholdOwner()
    ?'あなたは管理者です。参加承認・招待・共有データの削除を管理します。'
    :'あなたは参加メンバーです。招待や参加承認は、最初に家庭を作成した管理者へ依頼してください。');
}
function stopHouseholdSubscriptions(){
  if(typeof stopFamilyConnection==='function')stopFamilyConnection();
  if(typeof closePersonTasks==='function')closePersonTasks();
  if(window.mainicoNotebookClose)window.mainicoNotebookClose();
  householdBootGeneration++;
  if(typeof resetRecordViews==='function')resetRecordViews();
  [householdUnsub,ownMemberUnsub,memWatchUnsub,honninUnsub,yoteiUnsub,evUnsub,ytListUnsub,watchTagUnsub,medicineInfoUnsub,personHistoryUnsub,pendingUnsub].forEach(fn=>{try{if(fn)fn();}catch(e){}});
  householdUnsub=ownMemberUnsub=null;
  familyOnlyUnsubs.forEach(fn=>{try{fn();}catch(e){}}); familyOnlyUnsubs=[];
  if(clockTimer)clearInterval(clockTimer);
  try{speechSynthesis.cancel();}catch(e){}
}
function showHouseholdBlocked(message){
  stopHouseholdSubscriptions(); householdVerified=false;
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  showPage('household-status-page');
  document.getElementById('household-status-text').textContent=message;
  document.getElementById('loading').style.display='none';
}
async function refreshHousehold(){
  if(!gid()){householdVerified=false;return null;}
  const groupId=gid(),userId=uid(),generation=householdBootGeneration;
  const doc=await grp().get({source:'server'});
  if(gid()!==groupId || uid()!==userId || generation!==householdBootGeneration)throw new Error('stale-household');
  if(!doc.exists) return null;
  householdOwnerId=doc.data().createdBy;
  householdDeleting=doc.data().deletionState==='deleting';
  householdVerified=true;
  applyHouseholdPermissions();
  return doc.data();
}
function watchHouseholdAccess(){
  if(householdUnsub)householdUnsub();
  if(ownMemberUnsub)ownMemberUnsub();
  const watchedGroup=gid(), watchedUid=uid();
  const generation=householdBootGeneration;
  const current=()=>gid()===watchedGroup && uid()===watchedUid && generation===householdBootGeneration;
  householdUnsub=grp().onSnapshot({includeMetadataChanges:true},doc=>{
    if(!current() || doc.metadata.fromCache || deletionBusy)return;
    if(!doc.exists){showHouseholdBlocked('この家庭との接続は終了しました。保存済みのコピーは各端末で削除してください。');return;}
    householdOwnerId=doc.data().createdBy; householdVerified=true;
    householdDeleting=doc.data().deletionState==='deleting';
    applyHouseholdPermissions();
    if(householdDeleting){
      if(isHouseholdOwner()){stopHouseholdSubscriptions();openHouseholdDeletion();}
      else showHouseholdBlocked('管理者が共有データを削除しています。この家庭の利用を終了しました。');
    }
  },()=>{if(current() && !deletionBusy)showHouseholdBlocked('家族との接続を確認できません。通信状態を確認して、再確認してください。');});
  ownMemberUnsub=col('members').doc(watchedUid).onSnapshot({includeMetadataChanges:true},doc=>{
    if(!current() || doc.metadata.fromCache || deletionBusy || householdDeleting)return;
    if(!doc.exists || (doc.data().status && doc.data().status!=='approved')){
      showHouseholdBlocked('このアカウントの参加が解除されました。記録の新たな取得・送信はできません。');
    }
  },()=>{if(current() && !deletionBusy)showHouseholdBlocked('参加状態を確認できません。通信状態を確認して、再確認してください。');});
}
async function saveRecoveryPointer(){
  if(!gid() || householdDeleting)return;
  await db.collection('accounts').doc(uid()).set({groupId:gid(),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
}
let recoveryPointerSync=null;
function renderRecoveryPointerSync(){
  const box=document.getElementById('recovery-sync-warning');
  if(box)box.hidden=!(recoveryPointerSync && recoveryPointerSync.groupId===gid() && recoveryPointerSync.userId===uid() && recoveryPointerSync.failed);
}
async function syncStartupRecoveryPointer(){
  if(!gid() || !householdVerified || householdDeleting)return;
  const attempt={groupId:gid(),userId:uid(),generation:householdBootGeneration,failed:false};
  recoveryPointerSync=attempt;renderRecoveryPointerSync();
  try{await saveRecoveryPointer();}
  catch(error){
    if(recoveryPointerSync!==attempt || gid()!==attempt.groupId || uid()!==attempt.userId || householdBootGeneration!==attempt.generation)return;
    attempt.failed=true;renderRecoveryPointerSync();
  }
}
function recoveryState(text,error=false){
  const el=document.getElementById('recovery-state');el.textContent=text;el.classList.toggle('err',error);
}
function getRecoveryService(){
  if(!recoveryService)recoveryService=MainicoRecovery.create({auth,db,
    credential:(email,password)=>firebase.auth.EmailAuthProvider.credential(email,password),
    serverTimestamp:()=>firebase.firestore.FieldValue.serverTimestamp(),
    getLocalGroupId:()=>gid(),createIsolatedSession:MainicoRecovery.firebaseSessionFactory(firebase,previewApp.options,window.MAINICO_RECAPTCHA_SITE_KEY),
    beforeSwitch:context=>{
      if(getDeletionService().getPending())throw new Error('deletion-pending');
      for(const key of ['mainico_group_setup_v1','mainico_join_pending_v1']){
        const pending=JSON.parse(localStorage.getItem(key)||'null');
        if(pending && pending.uid===uid()){
          const error=new Error('recovery/setup-pending');error.code='recovery/setup-pending';throw error;
        }
      }
      localStorage.setItem(RECOVERY_JOURNAL,JSON.stringify(context));
      stopHouseholdSubscriptions();
    }});
  return recoveryService;
}
function applyRecoveryJournal(){
  const raw=localStorage.getItem(RECOVERY_JOURNAL);if(!raw)return false;
  const result=JSON.parse(raw);
  if(result.uid!==uid())return false; // Auth切替が失敗した場合は元の端末情報を保持。
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(result.groupId)||!['honnin','kazoku','konly'].includes(result.mode))throw new Error('invalid-recovery-journal');
  if(!clearMainicoDeviceData([RECOVERY_JOURNAL]))throw new Error('device-storage-unavailable');
  previewStorage.setItem('mainicoGid',result.groupId);
  previewStorage.setItem('mainicoName',result.name||'');
  previewStorage.setItem('mainicoMode',result.mode==='honnin'?'honnin':'kazoku');
  previewStorage.setItem('kazokuOnly',result.mode==='konly'?'1':'');
  if(result.modeNeedsConfirmation)previewStorage.removeItem('mainicoMode');
  localStorage.removeItem(RECOVERY_JOURNAL);
  return true;
}
async function openRecovery(){
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.getElementById('recovery-modal').classList.add('show');
  document.getElementById('recovery-password').value='';
  renderRecoveryPointerSync();
  document.getElementById('recovery-register').hidden=!gid();
  document.getElementById('recovery-login').hidden=!!gid();
  document.getElementById('recovery-email').value=auth.currentUser?.email||'';
  recoveryState(gid()?'このアカウントに、復旧用のメールアドレスを登録します。確認メールのリンクを開いたあと「確認できたか調べる」を押してください。':'以前に登録・確認したメールアドレスで、家族との接続を復旧します。');
}
function closeRecovery(){
  if(recoveryBusy || accountClosureBusy)return;
  document.getElementById('recovery-password').value='';
  document.getElementById('recovery-modal').classList.remove('show');
}
async function runRecoveryAction(action){
  if(recoveryBusy)return;
  recoveryBusy=true;
  document.querySelectorAll('#recovery-modal button').forEach(el=>el.disabled=true);
  const email=document.getElementById('recovery-email').value.trim();
  const password=document.getElementById('recovery-password').value;
  recoveryState('確認しています…');
  try{
    const service=getRecoveryService();
    if(action==='register'){
      const result=await service.register({email,password,groupId:gid()});
      recoveryState(result.ready?'復旧の準備ができています。登録したメールとパスワードを安全に保管してください。':'確認メールを送りました。メールのリンクを開き、戻って「確認できたか調べる」を押してください。');
    }else if(action==='check'){
      const result=await service.checkReady(gid());
      recoveryState(result.ready?'復旧の準備ができました。このメールアドレスとパスワードを安全に保管してください。':result.status==='not-configured'?'復旧設定はまだ登録されていません。メールとパスワードを入力して登録してください。':'まだメール確認が完了していません。確認メールを開いてから、もう一度調べてください。');
    }else if(action==='resend'){
      const result=await service.resendVerification();recoveryState(result.status==='check-required'?'メールは確認済みです。「確認できたか調べる」で復旧先を確認してください。':'確認メールを再送しました。迷惑メールのフォルダも確認してください。');
    }else if(action==='reset'){
      await service.resetPassword(email);recoveryState('登録がある場合は、パスワード再設定のメールが届きます。メールの案内に従ってください。');
    }else if(action==='login'){
      const result=await service.recover({email,password});
      applyRecoveryJournal();
      recoveryState('共有記録への接続を復旧しました。写真の控えは端末内だけに保存され、別端末へは復旧しません。画面を開きます。');
      document.getElementById('recovery-modal').classList.remove('show');
      recoveryBusy=false;
      await bootHouseholdUser(auth.currentUser);
    }
  }catch(error){
    let switched=false;
    try{const journal=localStorage.getItem(RECOVERY_JOURNAL);switched=!!journal&&JSON.parse(journal).uid===uid();}catch(ignore){}
    if(switched){
      recoveryState('ログインは復旧しましたが、端末の保存が完了していません。保存情報を消さず、ブラウザーの保存設定を確認して画面を開き直してください。',true);
    }else recoveryState(MainicoRecovery.message(error),true);
  }
  finally{
    document.getElementById('recovery-password').value='';recoveryBusy=false;
    document.querySelectorAll('#recovery-modal button').forEach(el=>el.disabled=false);
  }
}
function getDeletionService(){
  if(!deletionService)deletionService=MainicoDeletion.create({db,auth,
    serverTimestamp:()=>firebase.firestore.FieldValue.serverTimestamp(),storage:localStorage,
    isOnline:()=>navigator.onLine!==false,onProgress:progress=>{
      const stages={marking:'削除の開始を記録',events:'日々の記録',yotei:'予定',invites:'招待',watchTags:'おまもりタグ',alerts:'タグのお知らせ',settings:'共有設定',members:'家族との接続',accounts:'復旧先の登録',finalizing:'残りを確認'};
      document.getElementById('deletion-state').textContent=(stages[progress.stage]||'共有データ')+'を処理しています。画面を開いたままお待ちください。';
    }});
  return deletionService;
}
function openHouseholdDeletion(){
  if(!isHouseholdOwner() && !deletionResumeOnly){alert('共有データ全体の削除は管理者が行えます。');return;}
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  if(householdDeleting){showPage('household-status-page');document.getElementById('household-status-text').textContent='共有データの削除は未完了です。下の画面から再開してください。';}
  document.getElementById('deletion-modal').classList.add('show');
  document.getElementById('deletion-confirm').value='';
  document.getElementById('deletion-state').textContent=householdDeleting?'削除の途中です。同じ確認文字を入力して再開できます。':'削除は取り消せません。対象を確認してください。';
  document.getElementById('deletion-run').disabled=false;
}
function closeHouseholdDeletion(){
  if(deletionBusy)return;
  document.getElementById('deletion-modal').classList.remove('show');
  if(householdDeleting){showHouseholdBlocked('共有データの削除は未完了です。「再確認する」から削除を再開してください。');}
}
async function runHouseholdDeletion(){
  if(deletionBusy || (!isHouseholdOwner() && !deletionResumeOnly))return;
  const confirmation=document.getElementById('deletion-confirm').value.trim();
  if(confirmation!==MainicoDeletion.CONFIRMATION){document.getElementById('deletion-state').textContent='「共有データを削除」と入力してください。';return;}
  const notebookScope={uid:uid(),groupId:gid()};
  deletionBusy=true;
  document.querySelectorAll('#deletion-modal button').forEach(el=>el.disabled=true);
  stopHouseholdSubscriptions();
  showPage('household-status-page');
  document.getElementById('household-status-text').textContent='削除操作の後は、家族との接続を再確認してください。';
  try{
    await getDeletionService().run({groupId:gid(),confirmation});
    householdDeleting=true;
    const notebookCleared=await clearNotebookForExit(notebookScope);
    const localCleared=clearMainicoDeviceData() && notebookCleared;
    document.getElementById('deletion-modal').classList.remove('show');
    showHouseholdBlocked('共有サーバーの記録・予定・招待・タグとお知らせ・家族との接続・復旧先登録を削除したことを確認しました。'+(localCleared?'この端末の、この家庭・アカウントのお薬手帳の控えとアプリ内設定を削除しました。他の家庭・アカウントの控えは別に残ります。':'この端末の保存内容は消去を確認できません。ブラウザーのサイトデータを削除してください。')+' 印刷物・撮影済みQR・他端末のコピーと、ログイン用アカウントは別に残ります。');
  }catch(error){
    try{const group=await refreshHousehold();householdDeleting=!!group&&group.deletionState==='deleting';}catch(ignore){}
    document.getElementById('deletion-state').textContent='削除の完了は確認できません。'+(error.message||'通信を確認して再開してください。')+(error.backendCode==='permission-denied'?' 管理者の確認またはサービスの設定確認が必要です。':'');
  }finally{
    deletionBusy=false;
    document.querySelectorAll('#deletion-modal button').forEach(el=>el.disabled=false);
  }
}
async function clearNotebookForExit(scope,allUid=false){
  try{return !!window.mainicoNotebookCleanup && await window.mainicoNotebookCleanup(scope,allUid)===true;}catch(error){return false;}
}
function clearMainicoDeviceData(keep=[]){
  try{
    const keys=[];for(let i=0;i<localStorage.length;i++)keys.push(localStorage.key(i));
    keys.filter(key=>!keep.includes(key)&&/^(mainico|kazokuOnly$|kusuri-|aisatsu-|kibun-)/.test(key)).forEach(key=>localStorage.removeItem(key));
    return true;
  }catch(error){return false;}
}
async function bootHouseholdUser(user){
  if(window.mainicoNotebookClose)window.mainicoNotebookClose();
  if(recoveryBusy || accountClosureBusy)return;
  if(accountClosureEnded()){showAccountClosed('ログイン登録の削除操作を行いました。再ログインは自動で行いません。完了表示を確認できなかった場合は運営者へ確認してください。');return;}
  clearConsentSession();
  const generation=++householdBootGeneration;
  householdVerified=false;
  if(!user){
    window.mainicoStartupStage='ログイン確認中';
    try{await auth.signInAnonymously();}catch(error){window.showStartupProblem('ログインできませんでした');}
    return;
  }
  let memberRead=null,memberGroup='';
  try{
    applyRecoveryJournal();
    const pending=getDeletionService().getPending();
    if(pending && pending.uid===user.uid){
      previewStorage.setItem('mainicoGid',pending.groupId);
      deletionResumeOnly=true;
      document.getElementById('loading').style.display='none';
      showPage('household-status-page');
      document.getElementById('household-status-text').textContent='前回の削除は完了確認が残っています。削除画面から確認・再開してください。';
      openHouseholdDeletion();return;
    }
    deletionResumeOnly=false;
    // 自分の参加状態と終了手続きは並行確認。共有内容は承認確認後に読む。
    memberGroup=gid();
    if(memberGroup)memberRead=col('members').doc(user.uid).get({source:'server'}).then(doc=>({doc}),error=>({error}));
    const closure=await db.collection('accountClosures').doc(user.uid).get({source:'server'});
    if(generation!==householdBootGeneration || uid()!==user.uid)return;
    if(closure.exists){
      const owned=await db.collection('groups').where('createdBy','==',user.uid).limit(1).get({source:'server'});
      if(generation!==householdBootGeneration || uid()!==user.uid)return;
      if(!owned.empty){
        previewStorage.setItem('mainicoGid',owned.docs[0].id);
        await refreshHousehold();document.getElementById('loading').style.display='none';
        openHouseholdDeletion();return;
      }
      showHouseholdBlocked('アカウント削除は未完了です。通常の記録は停止しています。「自分のログイン用アカウントを削除する」から再開してください。');
      openAccountDeletion();return;
    }
    if(!gid()){
      const joinKey='mainico_join_pending_v1',joinRaw=previewStorage.getItem(joinKey);
      const join=JSON.parse(joinRaw||'null');
      if(join && join.uid===user.uid && /^[A-Za-z0-9_-]{1,128}$/.test(join.groupId)){
        const joinUid=user.uid;
        const current=()=>generation===householdBootGeneration && uid()===joinUid && !gid() && previewStorage.getItem(joinKey)===joinRaw;
        const groupRef=db.collection('groups').doc(join.groupId);
        let member;
        try{
          member=await groupRef.collection('members').doc(joinUid).get({source:'server'});
          if(!current())return;
        }catch(error){
          if(!current())return;
          // A deleted parent denies the member read. Only confirmed server
          // absence of that household proves this unfinished request has ended.
          let group;
          try{group=await groupRef.get({source:'server'});}
          catch(groupError){if(!current())return;throw groupError;}
          if(!current())return;
          if(!group || group.exists!==false || group.metadata?.fromCache!==false || group.metadata.hasPendingWrites!==false)throw error;
          previewStorage.removeItem(joinKey);
        }
        if(member && (typeof member.exists!=='boolean' || member.metadata?.fromCache!==false || member.metadata.hasPendingWrites!==false))throw new Error('join-server-unconfirmed');
        if(member?.exists){
          previewStorage.setItem('mainicoGid',join.groupId);
          previewStorage.setItem('mainicoPendingMode',join.mode);
          previewStorage.removeItem(joinKey);
        }
      }
    }
    if(!gid()){
      const pointerUid=user.uid;
      let pointer;
      try{pointer=await db.collection('accounts').doc(pointerUid).get({source:'server'});}
      catch(error){if(generation!==householdBootGeneration || uid()!==pointerUid || gid())return;throw error;}
      if(generation!==householdBootGeneration || uid()!==pointerUid || gid())return;
      if(pointer.exists)previewStorage.setItem('mainicoGid',pointer.data().groupId);
    }
  }catch(error){window.showStartupProblem('この端末の保存情報を確認できませんでした。保存情報を消さず、再確認してください');return;}
  if(gid()){
    window.mainicoStartupStage='家族との接続確認中';
    try{
      // 自分のmemberはpendingでも読める。groupは承認前に読まない。
      const memberResult=memberRead && memberGroup===gid()?await memberRead:{doc:await col('members').doc(user.uid).get({source:'server'})};
      if(generation!==householdBootGeneration || uid()!==user.uid)return;
      if(memberResult.error)throw memberResult.error;
      const me=memberResult.doc;
      if(me.exists && me.data().status==='pending'){
        document.getElementById('loading').style.display='none';showPending();return;
      }
      if(!me.exists || (me.data().status && me.data().status!=='approved')){showHouseholdBlocked('このアカウントは家庭に参加していません。管理者に確認してください。');return;}
      const data=me.data();
      const consentMode=['honnin','kazoku','konly'].includes(data.mode)?data.mode:(data.role==='honnin'?'honnin':isKOnly()?'konly':'kazoku');
      if(!await ensureConsentForMode(consentMode,()=>bootHouseholdUser(auth.currentUser)))return;
      if(generation!==householdBootGeneration)return;
      const group=await refreshHousehold();
      if(generation!==householdBootGeneration)return;
      if(!group){showHouseholdBlocked('この家庭は見つかりませんでした。管理者に確認してください。');return;}
      if(householdDeleting){
        document.getElementById('loading').style.display='none';
        if(isHouseholdOwner()){openHouseholdDeletion();return;}
        showHouseholdBlocked('管理者が共有データを削除しています。');return;
      }
      // 復旧先の保存は画面を開いた後に行う。失敗は復旧設定に表示する。
    }catch(error){
      if(generation!==householdBootGeneration)return;
      showHouseholdBlocked('家族との接続を確認できません。通信を確認してください。参加が解除された場合は、下の「接続が終了した端末を入口に戻す」からやり直せます。');return;
    }
  }
  if(generation!==householdBootGeneration)return;
  window.mainicoStartupStage='準備完了';document.getElementById('loading').style.display='none';
  try{startMode();if(gid()){watchHouseholdAccess();void syncStartupRecoveryPointer();}}catch(error){showHouseholdBlocked('画面を開けませんでした。保存情報は消さず、再確認してください。');}
}
async function retryHouseholdConnection(){
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.getElementById('loading').style.display='flex';
  await bootHouseholdUser(auth.currentUser);
}
async function leaveHouseholdAccount(){
  if(isHouseholdOwner()){
    alert('管理者だけを参加解除すると家庭を管理できなくなるため、解除できません。家庭全体の利用を終了する場合は「共有データをすべて削除する」を選んでください。');return false;
  }
  const notebookScope={uid:uid(),groupId:gid()};
  const batch=db.batch();batch.delete(col('members').doc(uid()));batch.delete(db.collection('accounts').doc(uid()));await batch.commit();
  stopHouseholdSubscriptions();
  const notebookCleared=await clearNotebookForExit(notebookScope);
  const settingsCleared=clearMainicoDeviceData();
  if(!notebookCleared || !settingsCleared)alert('参加解除は完了しました。端末内のお薬手帳の控え・設定の削除を確認できません。入口の「端末内の控えを削除」から再確認してください。');
  return true;
}
let disconnectedDeviceResetBusy=false;
async function resetDisconnectedDevice(){
  if(disconnectedDeviceResetBusy||deletionBusy||recoveryBusy||accountClosureBusy)return;
  const notebookScope={uid:uid(),groupId:gid()};
  if(!confirm('この端末の現在の家庭の設定・災害QR・お薬手帳の控えを消して、入口に戻りますか？ サーバーの共有記録は消しません。'))return;
  let generation=householdBootGeneration,localCleanupStarted=false;
  const current=()=>notebookScope.uid===uid()&&notebookScope.groupId===gid()&&generation===householdBootGeneration;
  const assertCurrent=()=>{if(!current())throw new Error('session-changed');};
  const verified=snapshot=>{
    if(!snapshot||typeof snapshot.exists!=='boolean'||snapshot.metadata?.fromCache!==false||snapshot.metadata.hasPendingWrites===true)throw new Error('server-unconfirmed');
    return snapshot;
  };
  disconnectedDeviceResetBusy=true;
  try{
    if(!notebookScope.uid)throw new Error('authentication-required');
    if(getDeletionService().getPending())throw new Error('deletion-pending');
    const accountRef=db.collection('accounts').doc(notebookScope.uid);
    const pointer=verified(await accountRef.get({source:'server'}));assertCurrent();
    if(pointer.exists&&(!notebookScope.groupId||pointer.data().groupId!==notebookScope.groupId))throw new Error('different-household');
    if(notebookScope.groupId){
      const groupRef=db.collection('groups').doc(notebookScope.groupId);
      let group=null;
      try{group=verified(await groupRef.get({source:'server'}));assertCurrent();}
      catch(error){assertCurrent();if(error.code!=='permission-denied')throw error;}
      if(group?.exists&&group.data().createdBy===notebookScope.uid){alert('管理者の接続を失わないため、この操作では戻れません。家庭全体を終了するときは共有データを削除してください。');return;}
      // Permission denial is not proof of absence. A removed member can still read
      // their own missing membership in an active group; an unreadable result stops.
      if(!group||group.exists){
        const member=verified(await groupRef.collection('members').doc(notebookScope.uid).get({source:'server'}));assertCurrent();
        if(member.exists){alert('参加中です。設定の「利用をやめる」から参加解除してください。');return;}
      }
    }
    assertCurrent();
    if(pointer.exists){await accountRef.delete();assertCurrent();}
    stopHouseholdSubscriptions();
    generation=householdBootGeneration;assertCurrent();
    localCleanupStarted=true;
    const notebookCleared=await clearNotebookForExit(notebookScope);assertCurrent();
    if(!notebookCleared)throw new Error('notebook-storage');
    if(!clearMainicoDeviceData()){alert('端末内の設定の片付けを完了できませんでした。完了とは確認できないため、保存情報を手動で消さず、通信とブラウザーの保存設定を確認してください。');return;}
    location.reload();
  }catch(error){if(current())alert(localCleanupStarted?
    '端末内の片付けの完了を確認できませんでした。保存情報を手動で消さず、通信とブラウザーの保存設定を確認してください。':
    '接続の終了を確認できないため、端末の保存内容は消していません。通信を確認し、削除が途中なら先に再開してください。');}
  finally{disconnectedDeviceResetBusy=false;}
}

// 削除成功時のAuthイベントで匿名登録を作り直さない。終了状態だけを端末保存する。
let accountClosureBusy=false,accountClosureStopping=false,accountClosureService=null;
const ACCOUNT_CLOSED_KEY='mainico_account_closed_v1';
function accountClosureEnded(){try{return accountClosureStopping || localStorage.getItem(ACCOUNT_CLOSED_KEY)==='1';}catch(e){return accountClosureStopping;}}
function showAccountClosed(message){stopHouseholdSubscriptions();document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));document.getElementById('loading').style.display='none';showPage('account-closed-page');document.getElementById('account-closed-state').textContent=message;}
function getAccountClosureService(){
  if(!accountClosureService)accountClosureService=MainicoAccountDeletion.create({db,auth,
    serverTimestamp:()=>firebase.firestore.FieldValue.serverTimestamp(),
    credential:(email,password)=>firebase.auth.EmailAuthProvider.credential(email,password),
    isOnline:()=>navigator.onLine!==false,
    beforeDelete:()=>{localStorage.setItem(ACCOUNT_CLOSED_KEY,'1');accountClosureStopping=true;stopHouseholdSubscriptions();},
    onDeleteFailure:()=>{accountClosureStopping=false;localStorage.removeItem(ACCOUNT_CLOSED_KEY);}
  });return accountClosureService;
}
function openAccountDeletion(){
  if(deletionBusy || recoveryBusy || accountClosureBusy)return;
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.getElementById('account-deletion-modal').classList.add('show');
  document.getElementById('account-deletion-identity').textContent='削除対象：'+(auth.currentUser?.email||'この端末でログインしている、メール未登録のアカウント');
  document.getElementById('account-deletion-password').value='';document.getElementById('account-deletion-confirm').value='';
  document.getElementById('account-deletion-finish').disabled=true;
  document.getElementById('account-deletion-state').textContent='終了を開始すると通常利用を停止し、取り消せません。先に共有データ削除・参加解除の完了を確認してください。';
}
async function closeAccountDeletion(){
  if(accountClosureBusy)return;
  document.getElementById('account-deletion-password').value='';
  document.getElementById('account-deletion-modal').classList.remove('show');
  const id=uid();
  try{const lock=await db.collection('accountClosures').doc(id).get({source:'server'});if(uid()!==id)return;if(lock.exists)showHouseholdBlocked('アカウント削除は未完了です。通常の記録は停止しています。「自分のログイン用アカウントを削除する」から再開してください。');}
  catch(e){if(uid()===id)showHouseholdBlocked('アカウント削除の進行状況を確認できません。通信を確認して「再確認する」を押してください。');}
}
async function prepareAccountDeletion(){
  if(accountClosureBusy)return;accountClosureBusy=true;document.getElementById('account-deletion-finish').disabled=true;
  try{await getAccountClosureService().prepare(document.getElementById('account-deletion-password').value);document.getElementById('account-deletion-state').textContent='通常の利用を停止しました。ログイン登録の削除はまだ完了していません。確認文字を入力して削除してください。';document.getElementById('account-deletion-finish').disabled=false;}
  catch(e){document.getElementById('account-deletion-state').textContent=MainicoAccountDeletion.message(e);}
  finally{document.getElementById('account-deletion-password').value='';accountClosureBusy=false;}
}
async function finishAccountDeletion(){
  if(accountClosureBusy)return;
  const notebookScope={uid:uid(),groupId:gid()};
  accountClosureBusy=true;document.getElementById('account-deletion-finish').disabled=true;
  try{
    await getAccountClosureService().finish(document.getElementById('account-deletion-confirm').value.trim());
    const notebookCleared=await clearNotebookForExit(notebookScope,true);
    const cleared=clearMainicoDeviceData([ACCOUNT_CLOSED_KEY]) && notebookCleared;
    showAccountClosed('あなたのログイン登録を削除しました。'+(cleared?'この端末の、このアカウントのお薬手帳の控えとアプリ内設定を削除しました。他のアカウントの控えは別に残ります。':'端末内保存の削除を確認できません。ブラウザーのサイトデータを削除してください。')+' 他の家族の登録、紙、他端末のコピー、旧版の残存記録まで削除したことを示すものではありません。');
  }catch(e){document.getElementById('account-deletion-state').textContent=MainicoAccountDeletion.message(e);document.getElementById('account-deletion-finish').disabled=false;}
  finally{accountClosureBusy=false;}
}
async function restartAfterAccountClosure(){
  if(!confirm('新しいアカウントで利用を始めますか？ 削除した登録や記録は戻りません。'))return;
  try{await auth.signOut();localStorage.removeItem(ACCOUNT_CLOSED_KEY);accountClosureStopping=false;location.reload();}
  catch(e){showAccountClosed('再開できませんでした。通信とブラウザーの保存設定を確認してください。');}
}
