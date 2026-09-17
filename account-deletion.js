/* Auth自己削除。サーバー上の閉鎖ロックを残し、旧トークンによる再作成を拒否する。 */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.MainicoAccountDeletion=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const CONFIRMATION='アカウントを削除';
  function problem(code){const e=new Error(code);e.code=code;return e;}
  function message(e){return ({
    'closure/busy':'処理中です。少しお待ちください。',
    'closure/session-changed':'ログインが変わったため中止しました。元のアカウントで確認してください。',
    'closure/owned-household':'管理している家庭が残っています。先に共有データを削除してください。',
    'closure/connected':'家族との接続が残っています。先に参加を解除するか、共有データの削除を完了してください。',
    'closure/password':'現在のパスワードを入力してください。',
    'closure/provider':'このログイン方式はこの画面で再確認できません。運営者へお問い合わせください。',
    'closure/confirmation':'確認文字を入力し、削除対象を確認してください。',
    'closure/not-prepared':'先に「アカウントの終了を開始する」を押してください。開始後は通常利用を停止し、取り消せません。',
    'closure/offline':'通信を確認して再開してください。削除完了は確認できていません。',
    'auth/requires-recent-login':'本人確認の有効時間が切れました。現在のパスワードで本人確認をやり直し、「アカウントの終了を開始する」から再開してください。',
    'auth/wrong-password':'パスワードを確認してください。',
    'auth/invalid-credential':'パスワードを確認してください。',
  })[e?.code]||'削除完了を確認できません。通信を確認して同じアカウントで再開してください。';}
  function create({db,auth,serverTimestamp,credential,isOnline=()=>true,beforeDelete=()=>{},onDeleteFailure=()=>{}}){
    let busy=false,preparedUid='';
    function current(expected){if(!expected||auth.currentUser?.uid!==expected)throw problem('closure/session-changed');return auth.currentUser;}
    async function released(id){
      current(id);
      const owned=await db.collection('groups').where('createdBy','==',id).limit(1).get({source:'server'});current(id);
      if(!owned.empty)throw problem('closure/owned-household');
      const pointer=await db.collection('accounts').doc(id).get({source:'server'});current(id);
      if(pointer.exists)throw problem('closure/connected');
    }
    async function prepare(password){
      if(busy)throw problem('closure/busy');busy=true;preparedUid='';
      try{
        if(!isOnline())throw problem('closure/offline');
        const user=auth.currentUser,id=user?.uid;current(id);
        await released(id);
        if(!user.isAnonymous){
          if(!user.providerData?.some(p=>p.providerId==='password')||!user.email)throw problem('closure/provider');
          if(!password)throw problem('closure/password');
          await user.reauthenticateWithCredential(credential(user.email,password));current(id);
        }
        const ref=db.collection('accountClosures').doc(id);
        // transactionのリトライでも開始日時を上書きしない。
        await db.runTransaction(async tx=>{current(id);const lock=await tx.get(ref);current(id);if(!lock.exists)tx.set(ref,{requestedAt:serverTimestamp()});});
        current(id);await released(id);preparedUid=id;
        return {uid:id};
      }finally{busy=false;}
    }
    async function finish(confirmation){
      if(busy)throw problem('closure/busy');
      if(confirmation!==CONFIRMATION)throw problem('closure/confirmation');
      const id=preparedUid;if(!id)throw problem('closure/not-prepared');busy=true;
      try{
        if(!isOnline())throw problem('closure/offline');
        current(id);const lock=await db.collection('accountClosures').doc(id).get({source:'server'});current(id);
        if(!lock.exists)throw problem('closure/not-prepared');
        await released(id);const user=current(id);
        beforeDelete(id);current(id);
        try{await user.delete();}catch(e){onDeleteFailure(id);throw e;}
        preparedUid='';return {uid:id,deleted:true};
      }finally{busy=false;}
    }
    return {prepare,finish};
  }
  return {create,message,CONFIRMATION};
});
