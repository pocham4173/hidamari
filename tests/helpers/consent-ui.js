/* 起動・復旧・利用方法変更で共通の同意画面を使う。 */
let consentService=null,consentSession=null,consentWatch=null,consentFlow=null,consentSaving=false,consentGeneration=0;
function getConsentService(){
  if(!consentService)consentService=MainicoConsent.create({db,auth,serverTimestamp:()=>firebase.firestore.FieldValue.serverTimestamp()});
  return consentService;
}
function clearConsentSession(){
  consentGeneration++;consentSession=null;
  if(consentWatch)consentWatch();consentWatch=null;
}
function hasSessionConsent(mode){return !!consentSession && consentSession.uid===uid() && MainicoConsent.valid(consentSession.value,mode);}
function showConsentModeChoice(message='使い方を選んでから、同意内容を確認してください。'){
  consentFlow=null;clearConsentSession();stopHouseholdSubscriptions();pendingMode=null;
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.getElementById('loading').style.display='none';
  showPage('entry');document.getElementById('entry-state').textContent=message;
  document.querySelector('#select-box button')?.focus();
}
function showConsentFlow(mode,resume,message=''){
  clearConsentSession();stopHouseholdSubscriptions();
  pendingMode=mode;
  consentFlow={uid:uid(),mode,resume,generation:consentGeneration};
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  const kind=mode==='konly'?'b':'a';
  document.getElementById('consent-mode-'+kind).textContent='選んだ使い方：'+({honnin:'本人が使う',kazoku:'本人と家族が使う（家族用の画面）',konly:'家族だけで使う'}[mode]);
  document.querySelectorAll('#consent-'+kind+' input[type="checkbox"]').forEach(el=>el.checked=false);
  const subject=document.getElementById('consent-subject-'+kind);
  subject.textContent=mode==='honnin'?'自分の情報について、説明を理解して同意します。':'記録される本人に、取得する情報と家族への共有を分かる方法で説明し、本人の同意を確認しました。家族自身の同意とは別の確認です。';
  document.getElementById('consent-state-'+kind).textContent=message;
  document.getElementById('loading').style.display='none';
  showPage('consent-'+kind);
  /* 誤スクロール対策: 同意画面は必ず先頭から表示する(2026-09-21) */
  const wrap=document.querySelector('#consent-'+kind+' .consent-wrap');
  if(wrap)wrap.scrollTop=0;
  try{window.scrollTo({top:0,left:0,behavior:'auto'});}catch(e){window.scrollTo(0,0);}
  const title=document.getElementById('consent-title-'+kind);
  try{title.focus({preventScroll:true});}catch(e){title.focus();}
}
function watchConsent(result,mode){
  clearConsentSession();consentSession=result;
  const generation=consentGeneration,account=result.uid;
  consentWatch=db.collection('consents').doc(account).onSnapshot({includeMetadataChanges:true},snap=>{
    if(generation!==consentGeneration || uid()!==account || snap.metadata.fromCache || snap.metadata.hasPendingWrites)return;
    if(!snap.exists || !MainicoConsent.valid(snap.data(),mode))showConsentModeChoice('同意内容が変更または取り消されました。使い方を選び直して、同意内容を確認してください。');
  },()=>{
    if(generation===consentGeneration && uid()===account)showConsentModeChoice('同意を確認できません。通信を確認してから使い方を選んでください。');
  });
}
async function ensureConsentForMode(mode,resume,onRequired=message=>showConsentFlow(mode,resume,message)){
  const generation=consentGeneration,account=uid();
  try{
    const result=await getConsentService().read(mode);
    if(generation!==consentGeneration || uid()!==account)return false;
    if(!result.valid){onRequired();return false;}
    watchConsent(result,mode);return true;
  }catch(error){
    if(generation===consentGeneration && uid()===account)onRequired('同意を確認できません。通信を確認してから、もう一度お試しください。');
    return false;
  }
}
async function submitConsent(kind){
  if(consentSaving)return;
  const flow=consentFlow;
  if(!flow || flow.uid!==uid() || (flow.mode==='konly'?'b':'a')!==kind)return;
  const state=document.getElementById('consent-state-'+kind),checks={};
  document.querySelectorAll('#consent-'+kind+' input[data-consent]').forEach(el=>checks[el.dataset.consent]=el.checked);
  if(!['privacy','sensitive','sharing','disclaimer','subject'].every(k=>checks[k]===true)){state.textContent='内容を確認し、同意できる項目にチェックしてください。すべて確認するまで記録の利用は始まりません。';return;}
  consentSaving=true;document.getElementById('consent-submit-'+kind).disabled=true;state.textContent='同意を保存しています…';
  try{
    const result=await getConsentService().accept(flow.mode,checks);
    if(consentFlow!==flow || uid()!==flow.uid || consentGeneration!==flow.generation)return;
    watchConsent(result,flow.mode);consentFlow=null;
    await flow.resume();
  }catch(error){if(consentFlow===flow)state.textContent='同意の保存を確認できませんでした。記録の利用は始まっていません。通信を確認して再試行してください。';}
  finally{consentSaving=false;document.getElementById('consent-submit-'+kind).disabled=false;}
}
function cancelConsent(){if(consentSaving)return;showConsentModeChoice();}
async function openConsentExit(){
  if(consentSaving)return;
  try{
    if(gid()){
      await refreshHousehold();
      if(isHouseholdOwner()){openHouseholdDeletion();return;}
      if(confirm('家庭への参加を解除します。共有記録は残り、この端末の対象のお薬手帳の控えは削除します。続けますか？') && await leaveHouseholdAccount())location.reload();
    }else openAccountDeletion();
  }catch(error){alert('利用終了の状態を確認できません。通信を確認して再試行してください。');}
}
async function withdrawCurrentConsent(){
  if(consentSaving)return;
  if(!confirm('このアカウントの同意を取り消し、記録の利用を止めます。共有済みの記録や他の家族の同意は自動削除されません。削除・退会は別の操作で行えます。'))return;
  const mode=consentSession?.value.mode || (isKOnly()?'konly':previewStorage.getItem('mainicoMode')) || 'kazoku';
  showConsentFlow(mode,()=>afterConsent(mode),'同意の取り消しを保存しています…');
  const kind=mode==='konly'?'b':'a';
  consentSaving=true;document.getElementById('consent-submit-'+kind).disabled=true;
  try{await getConsentService().revoke();document.getElementById('consent-state-'+kind).textContent='同意を取り消しました。このアカウントの記録の利用を停止しました。';}
  catch(error){document.getElementById('consent-state-'+kind).textContent='取り消しの保存を確認できません。通信を確認し、下の「取り消しを再試行」からやり直してください。';}
  finally{consentSaving=false;document.getElementById('consent-submit-'+kind).disabled=false;}
}
