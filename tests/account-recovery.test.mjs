import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Recovery=require('../account-recovery.js');
const fail=code=>Object.assign(new Error('Do not expose server details'),{code});

function fixture(options={}){
  const records=new Map([
    ['groups/g1',{createdBy:'old'}],
    ['groups/g1/members/old',{name:'家族',role:'kazoku',mode:'konly',status:'approved'}],
    ['groups/g2',{createdBy:'restored'}],
    ['groups/g2/members/restored',{name:'復元する家族',role:'kazoku',mode:'kazoku',status:'approved'}],
    ['accounts/restored',{groupId:'g2'}]
  ]);
  const calls=[],faults={};
  function database(){
    function collection(path){return {doc:id=>doc(path+'/'+id)};}
    function doc(path){return {
      collection:name=>collection(path+'/'+name),
      get:async setting=>{assert.equal(setting.source,'server');calls.push(['get',path]);if(faults.get)throw faults.get;return {exists:records.has(path),data:()=>records.get(path)};},
      set:async value=>{calls.push(['set',path,value]);if(faults.set)throw faults.set;records.set(path,value);}
    };}
    return {collection};
  }
  function user(uid,linked=false,verified=false){return {
    uid,email:linked?uid+'@example.com':null,isAnonymous:!linked,emailVerified:verified,
    providerData:linked?[{providerId:'password'}]:[],
    reload:async()=>{calls.push(['reload',uid]);if(faults.reload)throw faults.reload;},
    getIdToken:async force=>{assert.equal(force,true);calls.push(['token',uid]);return 'not-persisted';},
    async linkWithCredential(c){calls.push(['link',uid]);if(faults.link)throw faults.link;this.email=c.email;this.isAnonymous=false;this.providerData=[{providerId:'password'}];return {user:this};},
    async reauthenticateWithCredential(){calls.push(['reauth',uid]);if(faults.reauth)throw faults.reauth;return {user:this};},
    sendEmailVerification:async()=>{calls.push(['verify',uid]);if(faults.verify)throw faults.verify;}
  };}
  const old=user('old',options.linked,options.verified),restored=user('restored',true,true);
  const auth={
    currentUser:options.noUser?null:old,
    updateCurrentUser:async user=>{calls.push(['switch',user.uid]);if(faults.switch)throw faults.switch;auth.currentUser=user;},
    sendPasswordResetEmail:async()=>{calls.push(['reset']);if(faults.reset)throw faults.reset;}
  };
  const db=database();let localGroupId=options.localGroupId??'';
  let loginHook;
  const service=Recovery.create({auth,db,
    credential:(email,password)=>({email,password}),serverTimestamp:()=>({serverTimestamp:true}),
    getLocalGroupId:()=>localGroupId,
    beforeSwitch:options.beforeSwitch,
    createIsolatedSession:async()=>{calls.push(['session']);return {
      auth:{signInWithEmailAndPassword:async()=>{calls.push(['login']);if(loginHook)await loginHook();if(faults.login)throw faults.login;return {user:restored};}},
      db:database(),dispose:async()=>{calls.push(['dispose']);}
    };}
  });
  return {service,auth,old,restored,records,calls,faults,setLoginHook:fn=>{loginHook=fn;},setLocalGroupId:value=>{localGroupId=value;}};
}
const registration={email:'owner@example.com',password:'a long private password',groupId:'g1'};
const login={email:'restored@example.com',password:'a private password'};
const code=expected=>error=>error.code===expected;
const count=(f,name)=>f.calls.filter(c=>c[0]===name).length;

test('registration links the current UID and stores only the group pointer; never claims ready before email confirmation',async()=>{
  const f=fixture();const result=await f.service.register(registration);
  assert.equal(f.auth.currentUser.uid,'old');assert.equal(count(f,'link'),1);assert.equal(count(f,'switch'),0);
  assert.deepEqual(f.records.get('accounts/old'),{groupId:'g1',updatedAt:{serverTimestamp:true}});
  assert.equal(result.ready,false);assert.equal(result.status,'verification-sent');assert.equal(result.mode,'konly');
  assert.equal(count(f,'verify'),1);
  assert.ok(!JSON.stringify([...f.records]).includes(registration.password));
});

test('email already in use does not merge users, replace the session, or save a recovery pointer',async()=>{
  const f=fixture();f.faults.link=fail('auth/email-already-in-use');
  await assert.rejects(f.service.register(registration),code('auth/email-already-in-use'));
  assert.equal(f.auth.currentUser.uid,'old');assert.equal(count(f,'set'),0);assert.equal(count(f,'switch'),0);
  assert.match(Recovery.message(f.faults.link),/統合していません/);
});

test('partial registration failures retain the original UID and give an actionable incomplete state',async()=>{
  const f=fixture();f.faults.set=fail('unavailable');
  await assert.rejects(f.service.register(registration),code('recovery/pointer-save-failed'));
  assert.equal(f.old.isAnonymous,false);assert.equal(f.auth.currentUser.uid,'old');assert.equal(count(f,'verify'),0);
  delete f.faults.set;f.faults.verify=fail('auth/network-request-failed');
  await assert.rejects(f.service.register(registration),code('recovery/verification-send-failed'));
  assert.equal(count(f,'reauth'),1);assert.equal(f.records.get('accounts/old').groupId,'g1');
  assert.equal(count(f,'link'),1);
});

test('registration requires an approved membership before adding a password provider',async()=>{
  const f=fixture();f.records.get('groups/g1/members/old').status='pending';
  await assert.rejects(f.service.register(registration),code('recovery/no-membership'));assert.equal(count(f,'link'),0);
});

test('readiness reloads email verification, checks pointer and membership on the server, and fails closed on network errors',async()=>{
  const f=fixture({linked:true});f.records.set('accounts/old',{groupId:'g1'});
  assert.equal((await f.service.checkReady('g1')).ready,false);
  assert.equal(count(f,'get'),0);
  f.old.emailVerified=true;
  const result=await f.service.checkReady('g1');assert.equal(result.ready,true);assert.equal(result.owner,true);
  f.faults.get=fail('unavailable');await assert.rejects(f.service.checkReady('g1'),code('unavailable'));
  delete f.faults.get;f.records.get('groups/g1/members/old').status='revoked';
  await assert.rejects(f.service.checkReady('g1'),code('recovery/no-membership'));
});

test('resending verification does not claim recovery readiness even when the email is already verified',async()=>{
  const f=fixture({linked:true,verified:true});
  assert.deepEqual(await f.service.resendVerification(),{ready:false,status:'check-required',email:'old@example.com'});
});

test('wrong password leaves the original anonymous session untouched and disposes the temporary session',async()=>{
  const f=fixture();f.faults.login=fail('auth/wrong-password');
  await assert.rejects(f.service.recover(login),code('auth/wrong-password'));
  assert.equal(f.auth.currentUser.uid,'old');assert.equal(count(f,'switch'),0);assert.equal(count(f,'dispose'),1);
});

test('unverified email cannot replace the current session or read a recovery pointer',async()=>{
  const f=fixture();f.restored.emailVerified=false;
  await assert.rejects(f.service.recover(login),code('recovery/unverified'));
  assert.equal(count(f,'switch'),0);assert.equal(count(f,'get'),0);assert.equal(count(f,'dispose'),1);
});

test('verified credentials alone cannot restore a missing or no longer approved membership',async()=>{
  for(const change of [f=>f.records.delete('accounts/restored'),f=>f.records.delete('groups/g2/members/restored'),f=>{f.records.get('groups/g2/members/restored').status='pending';}]){
    const f=fixture();change(f);await assert.rejects(f.service.recover(login));
    assert.equal(f.auth.currentUser.uid,'old');assert.equal(count(f,'switch'),0);assert.equal(count(f,'dispose'),1);
  }
});

test('successful recovery restores only the authenticated UID and its own server pointer; caller-supplied group is ignored',async()=>{
  const f=fixture();const result=await f.service.recover({...login,groupId:'g1'});
  assert.equal(result.uid,'restored');assert.equal(result.groupId,'g2');assert.equal(result.ready,true);
  assert.equal(result.mode,'kazoku');assert.equal(result.modeNeedsConfirmation,false);
  assert.equal(f.auth.currentUser.uid,'restored');assert.equal(count(f,'switch'),1);assert.equal(count(f,'dispose'),1);
});

test('legacy family members require mode confirmation so family observations are not silently relabeled',async()=>{
  const f=fixture();delete f.records.get('groups/g2/members/restored').mode;
  assert.equal((await f.service.recover(login)).modeNeedsConfirmation,true);
});

test('deletion can resume for the original owner even after the member document was removed; other family cannot reopen',async()=>{
  const f=fixture();f.records.get('groups/g2').deletionState='deleting';f.records.delete('groups/g2/members/restored');
  const result=await f.service.recover(login);assert.equal(result.deletionPending,true);assert.equal(result.owner,true);
  const g=fixture();g.records.get('groups/g2').deletionState='deleting';g.records.get('groups/g2').createdBy='someone-else';
  await assert.rejects(g.service.recover(login),code('recovery/deleting'));assert.equal(count(g,'switch'),0);
});

test('anonymous household access must be protected before any login attempt on that device',async()=>{
  const f=fixture({localGroupId:'g1'});
  await assert.rejects(f.service.recover(login),code('recovery/preserve-current'));assert.equal(count(f,'session'),0);
  const g=fixture({localGroupId:'g1',linked:true});
  await assert.rejects(g.service.recover(login),code('recovery/current-unverified'));assert.equal(count(g,'session'),0);
});

test('an already configured current account must still have a valid server pointer before switching',async()=>{
  const f=fixture({localGroupId:'g1',linked:true,verified:true});
  await assert.rejects(f.service.recover(login),code('recovery/no-pointer'));assert.equal(count(f,'session'),0);
  f.records.set('accounts/old',{groupId:'g1'});
  assert.equal((await f.service.recover(login)).uid,'restored');
});

test('overlapping operations and a session change during login do not attach data to the wrong user',async()=>{
  const f=fixture();let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
  f.setLoginHook(()=>new Promise(resolve=>{release=resolve;entered();}));
  const pending=f.service.recover(login);await ready;
  await assert.rejects(f.service.resetPassword('someone@example.com'),code('recovery/busy'));
  f.auth.currentUser={uid:'another-tab'};release();
  await assert.rejects(pending,code('recovery/session-changed'));assert.equal(count(f,'switch'),0);assert.equal(f.service.isBusy(),false);
});

test('password-reset success and unknown account have identical text; network failure is not reported as sent',async()=>{
  const f=fixture();const sent=await f.service.resetPassword('someone@example.com');
  f.faults.reset=fail('auth/user-not-found');assert.deepEqual(await f.service.resetPassword('someone@example.com'),sent);
  f.faults.reset=fail('auth/network-request-failed');await assert.rejects(f.service.resetPassword('someone@example.com'),code('auth/network-request-failed'));
  assert.equal(Recovery.message(fail('unknown/private-detail')),'処理を完了できませんでした。今の端末のデータを消さず、時間をおいてもう一度お試しください。');
});

test('temporary Firebase sessions use in-memory persistence before login and release Auth/Firestore/app resources',async()=>{
  const calls=[];const temporaryAuth={setPersistence:async value=>calls.push(['persistence',value]),signOut:async()=>calls.push(['signOut'])};
  const temporaryDb={terminate:async()=>calls.push(['terminate'])};
  const app={auth:()=>temporaryAuth,firestore:()=>temporaryDb,delete:async()=>calls.push(['delete'])};
  const firebase={initializeApp:()=>app,auth:{Auth:{Persistence:{NONE:'none'}}}};
  const session=await Recovery.firebaseSessionFactory(firebase,{projectId:'demo'})();
  assert.deepEqual(calls,[['persistence','none']]);assert.equal(session.auth,temporaryAuth);
  await session.dispose();assert.deepEqual(calls,[['persistence','none'],['signOut'],['terminate'],['delete']]);
});


test('recovery journal is saved for the verified target before replacing the current Auth session',async()=>{
  let observed;
  const f=fixture({beforeSwitch:async context=>{
    observed=context;assert.equal(f.auth.currentUser.uid,'old');
    assert.equal(count(f,'switch'),0);f.calls.push(['journal']);
  }});
  const result=await f.service.recover(login);
  assert.equal(observed.uid,'restored');assert.equal(observed.groupId,'g2');
  assert.equal(observed.mode,'kazoku');assert.equal(observed.email,'restored@example.com');
  assert.ok(!Object.values(observed).includes(login.password));
  assert.ok(f.calls.findIndex(c=>c[0]==='journal')<f.calls.findIndex(c=>c[0]==='switch'));
  assert.equal(result.uid,'restored');
});

test('failed recovery journal storage preserves the original account and releases the temporary login',async()=>{
  const f=fixture({beforeSwitch:async()=>{throw fail('recovery/journal-save-failed');}});
  await assert.rejects(f.service.recover(login),code('recovery/journal-save-failed'));
  assert.equal(f.auth.currentUser.uid,'old');assert.equal(count(f,'switch'),0);
  assert.equal(count(f,'dispose'),1);assert.equal(f.service.isBusy(),false);
});

test('changing the account while the recovery journal is being saved aborts the switch',async()=>{
  const f=fixture({beforeSwitch:async()=>{f.auth.currentUser={uid:'another-tab'};}});
  await assert.rejects(f.service.recover(login),code('recovery/session-changed'));
  assert.equal(count(f,'switch'),0);assert.equal(f.auth.currentUser.uid,'another-tab');
});
