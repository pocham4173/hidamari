/* まいにこ: 既存UIDを保った復旧。DOM/端末ストレージには依存しない。 */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.MainicoRecovery=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const MODES=new Set(['honnin','kazoku','konly']);
  function problem(code){ const e=new Error(code);e.code=code;return e; }
  function emailValue(value){
    const email=String(value||'').trim();
    if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email))throw problem('recovery/invalid-email');
    return email;
  }
  function groupValue(value){
    if(typeof value!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(value))throw problem('recovery/no-group');
    return value;
  }
  function passwordUser(user){return !!user&&Array.isArray(user.providerData)&&user.providerData.some(p=>p.providerId==='password');}
  function message(error){
    const code=error&&error.code||'';
    const messages={
      'recovery/busy':'処理中です。このまま少しお待ちください。',
      'recovery/no-user':'ログインを確認できません。画面を開き直してください。',
      'recovery/setup-pending':'この端末で家庭の作成・参加が途中です。先にこの端末の接続を再確認してください。保存情報は消さないでください。',
      'recovery/no-group':'この端末の家族との接続を確認してから、復旧設定をしてください。',
      'recovery/invalid-email':'メールアドレスを確認してください。',
      'auth/invalid-email':'メールアドレスを確認してください。',
      'recovery/weak-password':'復旧用パスワードは12文字以上で設定してください。',
      'auth/weak-password':'パスワードが設定条件を満たしていません。12文字以上の、推測されにくいパスワードにしてください。',
      'recovery/wrong-account':'この端末の登録と異なるメールアドレスです。今の登録を確認してください。',
      'recovery/linked-elsewhere':'このメールアドレスでは現在の登録に復旧設定を追加できません。別のメールアドレスを使うか、登録済みの端末を確認してください。家族の記録は統合していません。',
      'auth/email-already-in-use':'このメールアドレスでは現在の登録に復旧設定を追加できません。別のメールアドレスを使うか、登録済みの端末を確認してください。家族の記録は統合していません。',
      'auth/credential-already-in-use':'このメールアドレスでは現在の登録に復旧設定を追加できません。別のメールアドレスを使うか、登録済みの端末を確認してください。家族の記録は統合していません。',
      'recovery/pointer-save-failed':'メールとパスワードの登録はできましたが、復旧先の保存が完了していません。今の端末のデータを消さず、同じメールとパスワードでもう一度設定してください。',
      'recovery/verification-send-failed':'登録はできましたが、確認メールを送れませんでした。今の端末のデータを消さず「確認メールを再送する」をお試しください。',
      'recovery/unverified':'メール内のリンクでアドレス確認を済ませてから、もう一度お試しください。復旧はまだ完了していません。',
      'recovery/not-configured':'このアカウントには復旧用のメールとパスワードが設定されていません。',
      'recovery/no-pointer':'このアカウントの復旧先を確認できません。元の端末で復旧設定を確認してください。',
      'recovery/no-membership':'現在、この家族の記録を開く権限がありません。家族の管理者に確認してください。',
      'recovery/deleting':'この家族の記録は削除中です。管理者に確認してください。',
      'recovery/preserve-current':'この端末の登録を確認してから復旧してください。今の登録はまだ復旧設定がありません。家族の記録がある端末では、先に今のアカウントの復旧設定を完了してください。',
      'recovery/current-unverified':'今のアカウントのメール確認を済ませ、復旧設定の完了を確認してから別の登録を復旧してください。',
      'recovery/session-changed':'処理中にログインが変わったため中止しました。画面を開き直して確認してください。',
      'auth/wrong-password':'メールアドレスとパスワードの組み合わせを確認してください。',
      'auth/invalid-credential':'メールアドレスとパスワードの組み合わせを確認してください。',
      'auth/invalid-login-credentials':'メールアドレスとパスワードの組み合わせを確認してください。',
      'auth/user-not-found':'メールアドレスとパスワードの組み合わせを確認してください。',
      'auth/user-disabled':'この方法ではログインできません。登録を確認してください。',
      'auth/operation-not-allowed':'復旧機能は準備中です。運営による設定が必要です。今の端末のデータを消さないでください。',
      'auth/network-request-failed':'通信できませんでした。接続を確認して、もう一度お試しください。',
      'unavailable':'通信できませんでした。接続を確認して、もう一度お試しください。',
      'auth/too-many-requests':'試行が続いたため、しばらく操作できません。時間をおいてからお試しください。',
      'auth/requires-recent-login':'安全確認のため再ログインが必要です。メールとパスワードで本人確認をしてからお試しください。',
      'permission-denied':'復旧先へのアクセスを確認できません。家族との接続と運営側の設定を確認してください。'
    };
    return messages[code]||'処理を完了できませんでした。今の端末のデータを消さず、時間をおいてもう一度お試しください。';
  }
  function create(options){
    const {auth,db,credential,serverTimestamp,getLocalGroupId,createIsolatedSession,beforeSwitch}=options;
    let busy=false;
    function current(){if(!auth.currentUser)throw problem('recovery/no-user');return auth.currentUser;}
    function assertCurrent(expected){if(!auth.currentUser||auth.currentUser.uid!==expected)throw problem('recovery/session-changed');}
    async function locked(work){if(busy)throw problem('recovery/busy');busy=true;try{return await work();}finally{busy=false;}}
    async function contextFor(database,user,groupId){
      groupValue(groupId);
      const groupRef=database.collection('groups').doc(groupId);
      const groupSnap=await groupRef.get({source:'server'});
      if(!groupSnap.exists)throw problem('recovery/no-membership');
      const group=groupSnap.data(),owner=group.createdBy===user.uid;
      if(group.deletionState==='deleting'){
        if(!owner)throw problem('recovery/deleting');
        return {uid:user.uid,groupId,mode:'kazoku',name:'管理者',role:'kazoku',owner:true,modeNeedsConfirmation:false,deletionPending:true};
      }
      const memberSnap=await groupRef.collection('members').doc(user.uid).get({source:'server'});
      if(!memberSnap.exists)throw problem('recovery/no-membership');
      const member=memberSnap.data();
      if(member.status!==undefined&&member.status!=='approved')throw problem('recovery/no-membership');
      const hasMode=MODES.has(member.mode);
      return {uid:user.uid,groupId,mode:hasMode?member.mode:(member.role==='honnin'?'honnin':'kazoku'),
        name:typeof member.name==='string'?member.name:'',role:member.role==='honnin'?'honnin':'kazoku',owner,
        modeNeedsConfirmation:!hasMode&&member.role!=='honnin',deletionPending:false};
    }
    async function readPointer(database,user,expectedGroupId){
      const snap=await database.collection('accounts').doc(user.uid).get({source:'server'});
      if(!snap.exists)throw problem('recovery/no-pointer');
      const groupId=snap.data().groupId;
      if(expectedGroupId&&groupId!==expectedGroupId)throw problem('recovery/no-pointer');
      return contextFor(database,user,groupId);
    }
    async function checked(user,groupId){
      await user.reload();assertCurrent(user.uid);
      if(!passwordUser(user))return {ready:false,status:'not-configured'};
      if(!user.emailVerified)return {ready:false,status:'verification-required',email:user.email||''};
      await user.getIdToken(true);assertCurrent(user.uid);
      const context=await readPointer(db,user,groupId);assertCurrent(user.uid);
      return {...context,ready:true,status:context.deletionPending?'deletion-pending':'ready',email:user.email||''};
    }
    return {
      isBusy:()=>busy,
      register:params=>locked(async()=>{
        const user=current(),expected=user.uid,email=emailValue(params.email),groupId=groupValue(params.groupId);
        const password=String(params.password||'');
        if(password.length<12||password.length>128)throw problem('recovery/weak-password');
        const context=await contextFor(db,user,groupId);assertCurrent(expected);
        if(context.deletionPending)throw problem('recovery/deleting');
        const authCredential=credential(email,password);
        if(passwordUser(user)){
          if(String(user.email||'').toLowerCase()!==email.toLowerCase())throw problem('recovery/wrong-account');
          await user.reauthenticateWithCredential(authCredential);
        }else{
          const result=await user.linkWithCredential(authCredential);
          if(result.user.uid!==expected)throw problem('recovery/session-changed');
        }
        assertCurrent(expected);
        try{await db.collection('accounts').doc(expected).set({groupId,updatedAt:serverTimestamp()});}
        catch(error){assertCurrent(expected);throw problem('recovery/pointer-save-failed');}
        assertCurrent(expected);
        await user.reload();assertCurrent(expected);
        if(user.emailVerified)return checked(user,groupId);
        try{auth.languageCode='ja';await user.sendEmailVerification();}
        catch(error){assertCurrent(expected);throw problem('recovery/verification-send-failed');}
        assertCurrent(expected);
        return {...context,ready:false,status:'verification-sent',email:user.email||email};
      }),
      checkReady:groupId=>locked(()=>checked(current(),groupId)),
      resendVerification:()=>locked(async()=>{
        const user=current();
        await user.reload();assertCurrent(user.uid);
        if(!passwordUser(user))throw problem('recovery/not-configured');
        if(user.emailVerified)return {ready:false,status:'check-required',email:user.email||''};
        auth.languageCode='ja';await user.sendEmailVerification();assertCurrent(user.uid);
        return {ready:false,status:'verification-sent',email:user.email||''};
      }),
      resetPassword:email=>locked(async()=>{
        const address=emailValue(email);auth.languageCode='ja';
        try{await auth.sendPasswordResetEmail(address);}
        catch(error){if(error.code!=='auth/user-not-found')throw error;}
        return {status:'reset-requested',message:'登録がある場合は、パスワードを再設定するメールが届きます。迷惑メールも確認してください。'};
      }),
      recover:params=>locked(async()=>{
        const before=auth.currentUser,expected=before&&before.uid;
        const localGroupId=getLocalGroupId?getLocalGroupId():null;
        const email=emailValue(params.email),password=String(params.password||'');
        if(!password)throw problem('auth/invalid-credential');
        if(before&&localGroupId){
          if(!passwordUser(before))throw problem('recovery/preserve-current');
          const ready=await checked(before,localGroupId);
          if(!ready.ready)throw problem('recovery/current-unverified');
        }
        let session;
        try{
          session=await createIsolatedSession();
          const result=await session.auth.signInWithEmailAndPassword(email,password),user=result.user;
          await user.reload();
          if(!user.emailVerified)throw problem('recovery/unverified');
          await user.getIdToken(true);
          const context=await readPointer(session.db,user);
          if((auth.currentUser&&auth.currentUser.uid)!==expected || (getLocalGroupId&&getLocalGroupId()!==localGroupId))throw problem('recovery/session-changed');
          // The UI can persist a single recovery journal and stop old listeners here.
          // A failed journal write must leave the current Auth session unchanged.
          if(beforeSwitch)await beforeSwitch({...context,email:user.email||email});
          if((auth.currentUser&&auth.currentUser.uid)!==expected || (getLocalGroupId&&getLocalGroupId()!==localGroupId))throw problem('recovery/session-changed');
          await auth.updateCurrentUser(user);
          assertCurrent(user.uid);
          return {...context,ready:true,status:context.deletionPending?'deletion-pending':'ready',email:user.email||email};
        }finally{
          if(session&&session.dispose){try{await session.dispose();}catch(error){/* Temporary in-memory session only; do not undo successful recovery. */}}
        }
      })
    };
  }
  let sessionCount=0;
  function firebaseSessionFactory(firebase,appOptions,appCheckSiteKey){
    return async function(){
      const app=firebase.initializeApp(appOptions,'mainico-recovery-'+Date.now()+'-'+(++sessionCount));
      let temporaryAuth,temporaryDb;
      async function dispose(){
        if(temporaryAuth){try{await temporaryAuth.signOut();}catch(error){}}
        if(temporaryDb&&temporaryDb.terminate){try{await temporaryDb.terminate();}catch(error){}}
        try{await app.delete();}catch(error){}
      }
      try{
        if(appCheckSiteKey)app.appCheck().activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(appCheckSiteKey),true);
        temporaryAuth=app.auth();temporaryAuth.languageCode='ja';
        await temporaryAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);
        temporaryDb=app.firestore();
        return {auth:temporaryAuth,db:temporaryDb,dispose};
      }catch(error){await dispose();throw error;}
    };
  }
  return {create,firebaseSessionFactory,message};
});
