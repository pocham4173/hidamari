/* 端末内の控えと既存の家庭・ログイン状態を接続する。クラウド送信はしない。 */
'use strict';
let mainicoNotebookUi=null,mainicoNotebookStore=null;
function notebookContext(){
  try{
    const userId=uid(),groupId=gid();
    const allowed=!!userId && !!groupId && !recoveryBusy && !deletionBusy && !accountClosureBusy && !accountClosureStopping && !householdDeleting;
    return {uid:userId,groupId,allowed,canSave:allowed && householdVerified};
  }catch(error){return {uid:'',groupId:'',allowed:false,canSave:false};}
}
function notebookStore(){
  if(!window.MainicoNotebook)throw new Error('notebook-unavailable');
  if(!mainicoNotebookStore)mainicoNotebookStore=window.MainicoNotebook.createStore();
  return mainicoNotebookStore;
}
function notebookUi(){
  if(!mainicoNotebookUi)mainicoNotebookUi=window.MainicoNotebook.createUi({getContext:notebookContext,store:notebookStore()});
  return mainicoNotebookUi;
}
function openMedicineNotebook(){
  try{notebookUi().open();}catch(error){alert('お薬手帳の控えを開けませんでした。通信を確認してページを読み込み直してください。保存情報は消さないでください。');}
}
function openNotebookCleanup(){
  try{notebookUi().openCleanup();}catch(error){alert('端末内の控えの削除画面を開けませんでした。削除済みとは確認できません。ページを読み込み直してください。');}
}
window.mainicoNotebookClose=function(){
  if(mainicoNotebookUi)mainicoNotebookUi.invalidate();
  if(mainicoNotebookStore)mainicoNotebookStore.abortPending();
};
window.mainicoNotebookCleanup=async function(scope,allUid=false){
  try{
    window.mainicoNotebookClose();
    if(!scope || !scope.uid)return false;
    const store=notebookStore();
    if(allUid)await store.clearUid(scope.uid);
    else if(scope.groupId)await store.clearScope(scope.uid,scope.groupId);
    return true;
  }catch(error){return false;}
};
