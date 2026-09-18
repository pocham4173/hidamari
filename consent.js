/* 同意は認証UIDに結び付けてサーバーで確認する。端末の旧フラグは根拠にしない。 */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.MainicoConsent=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const VERSION='2026-09-18.1';
  const modes=['honnin','kazoku','konly'];
  function valid(value,mode){
    return !!value && modes.includes(mode) && value.version===VERSION && value.mode===mode
      && value.privacyAccepted===true && value.sensitiveAccepted===true && value.sharingAccepted===true
      && value.subjectBasis===(mode==='honnin'?'self':'explained-and-agreed') && !!value.acceptedAt;
  }
  function create({db,auth,serverTimestamp}){
    function identity(){const id=auth.currentUser?.uid;if(!id)throw new Error('consent/no-account');return id;}
    function current(id){if(identity()!==id)throw new Error('consent/account-changed');}
    async function read(mode){
      const id=identity(),snap=await db.collection('consents').doc(id).get({source:'server'});current(id);
      if(snap.metadata?.fromCache || snap.metadata?.hasPendingWrites)throw new Error('consent/unconfirmed');
      const value=snap.exists?snap.data():null;
      return {uid:id,valid:valid(value,mode),value};
    }
    async function accept(mode,checks){
      if(!modes.includes(mode) || !checks || !['privacy','sensitive','sharing','disclaimer','subject'].every(k=>checks[k]===true))throw new Error('consent/incomplete');
      const id=identity();
      const ref=db.collection('consents').doc(id);
      await read(mode);current(id);
      // オフラインの保留書込を残さず、接続とアカウントを確認して確定する。
      await db.runTransaction(async tx=>{await tx.get(ref);current(id);tx.set(ref,{version:VERSION,mode,privacyAccepted:true,sensitiveAccepted:true,sharingAccepted:true,subjectBasis:mode==='honnin'?'self':'explained-and-agreed',acceptedAt:serverTimestamp()});});
      current(id);const result=await read(mode);if(!result.valid)throw new Error('consent/unconfirmed');return result;
    }
    async function revoke(){const id=identity(),ref=db.collection('consents').doc(id);await ref.get({source:'server'});current(id);await db.runTransaction(async tx=>{await tx.get(ref);current(id);tx.delete(ref);});current(id);}
    return {read,accept,revoke};
  }
  return {VERSION,valid,create};
});
