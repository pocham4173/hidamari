import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {create,CONFIRMATION}=createRequire(import.meta.url)('../account-deletion.js');
function setup(){
 const state={owner:false,pointer:false,lock:false,deleted:false,reauth:false,fail:'',online:true};
 const user={uid:'self',email:'self@example.invalid',isAnonymous:false,providerData:[{providerId:'password'}],reauthenticateWithCredential:async()=>{if(state.fail==='reauth')throw Error('reauth');state.reauth=true;},delete:async()=>{if(state.fail==='delete')throw Error('delete');state.deleted=true;}};
 const auth={currentUser:user};
 const db={collection:name=>({doc:id=>({name,id,get:async()=>{if(state.fail==='read')throw Error('read');return {exists:name==='accounts'?state.pointer:state.lock};}}),where:()=>({limit:()=>({get:async()=>{if(state.fail==='read')throw Error('read');return {empty:!state.owner};}})})}),runTransaction:async fn=>{await fn({get:async()=>({exists:state.lock}),set:()=>{state.lock=true;if(state.race)state.race();}});}};
 const service=create({db,auth,serverTimestamp:()=>1,credential:(email,password)=>({email,password}),isOnline:()=>state.online,beforeDelete:()=>{state.stopping=true;},onDeleteFailure:()=>{state.stopping=false;}});
 return {state,auth,service};
}
for(const field of ['owner','pointer']){const {state,service}=setup();state[field]=true;await assert.rejects(service.prepare('existing'));assert.equal(state.lock,false);assert.equal(state.deleted,false);}
console.log('OK 管理世帯/復旧先が残る場合はAuth削除・閉鎖開始なし');
for(const fail of ['read','reauth']){const {state,service}=setup();state.fail=fail;await assert.rejects(service.prepare('existing'));assert.equal(state.deleted,false);assert.equal(state.lock,false);}
console.log('OK 通信・再認証失敗で削除しない');
{const {state,service}=setup();state.race=()=>{state.owner=true;};await assert.rejects(service.prepare('existing'),{code:'closure/owned-household'});assert.equal(state.lock,true);assert.equal(state.deleted,false);}
{const {state,service,auth}=setup();state.race=()=>{auth.currentUser={uid:'other'};};await assert.rejects(service.prepare('existing'),{code:'closure/session-changed'});assert.equal(state.deleted,false);}
console.log('OK 閉鎖確認中の世帯新設・UID切替は拒否');
{const {state,service,auth}=setup();await service.prepare('short-existing');assert.equal(state.reauth,true);await assert.rejects(service.finish('wrong'));assert.equal(state.deleted,false);auth.currentUser={uid:'other'};await assert.rejects(service.finish(CONFIRMATION));assert.equal(state.deleted,false);}
{const {state,service}=setup();await service.prepare('existing');state.fail='delete';await assert.rejects(service.finish(CONFIRMATION));assert.equal(state.lock,true);assert.equal(state.stopping,false);state.fail='';assert.equal((await service.finish(CONFIRMATION)).deleted,true);assert.equal(state.lock,true);}
{const {state,service,auth}=setup();auth.currentUser.isAnonymous=true;await service.prepare('');await service.finish(CONFIRMATION);assert.equal(state.deleted,true);assert.equal(state.reauth,false);}
console.log('OK 最終確認・再認証は既存パスワードを受入、失敗後再開、匿名削除、旧token閉鎖記録を維持');
