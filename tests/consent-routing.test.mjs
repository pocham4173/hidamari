// 実起動・同意・利用方法確定・画面切替を接続して検証（本番への同意や書込はしない）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
const Consent=createRequire(import.meta.url)('../consent.js');
const html=fs.readFileSync('index.html','utf8');
function source(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
const modes=['honnin','kazoku','konly'];
function fixture(localMode,memberMode,acceptedMode){
 const dom=new JSDOM(html,{url:'https://example.invalid/hidamari/',runScripts:'outside-only'}),c=dom.getInternalVMContext(),storage=dom.window.localStorage;
 for(const [k,v]of Object.entries({mainicoGid:'home',mainicoName:'テスト',mainicoPendingMode:'honnin',kazokuOnly:localMode==='konly'?'1':''}))storage.setItem(k,v);
 if(localMode)storage.setItem('mainicoMode',localMode==='honnin'?'honnin':'kazoku');
 if(acceptedMode)storage.setItem('mainicoModeChoiceV1',JSON.stringify(['one','home',acceptedMode]));
 const docs=new Map([['groups/home',{createdBy:'one'}],['groups/home/members/one',{status:'approved',role:'kazoku',mode:memberMode}],['accounts/one',{groupId:'home'}]]),listeners=[];
 const storedConsent=mode=>({version:Consent.VERSION,mode,privacyAccepted:true,sensitiveAccepted:true,sharingAccepted:true,subjectBasis:mode==='honnin'?'self':'explained-and-agreed',acceptedAt:{seconds:1}});
 if(acceptedMode)docs.set('consents/one',storedConsent(acceptedMode));
 const snap=path=>({exists:docs.has(path),data:()=>docs.get(path),metadata:{fromCache:false,hasPendingWrites:false}});
 const ref=path=>({path,get:async()=>snap(path),set:async value=>docs.set(path,value),update:async value=>docs.set(path,{...docs.get(path),...value}),delete:async()=>docs.delete(path),collection:name=>collection(path+'/'+name),onSnapshot:(opts,ok,error)=>{const item={path,ok,error,active:true};listeners.push(item);return()=>item.active=false;}});
 const collection=path=>({doc:id=>ref(path+'/'+id)});
 const db={collection,runTransaction:async fn=>fn({get:ref=>ref.get(),set:(ref,value)=>ref.set(value),delete:ref=>ref.delete()})};
 const auth={currentUser:{uid:'one'}},opened=[];
 Object.assign(c,{db,auth,MainicoConsent:Consent,previewStorage:storage,uid:()=>auth.currentUser?.uid||'',gid:()=>storage.getItem('mainicoGid')||'',isKOnly:()=>storage.getItem('kazokuOnly')==='1',grp:()=>ref('groups/'+storage.getItem('mainicoGid')),col:name=>collection('groups/'+storage.getItem('mainicoGid')+'/'+name),firebase:{firestore:{FieldValue:{serverTimestamp:()=>({seconds:123})}}},MainicoDeletion:{create:()=>({getPending:()=>null})},showPage:id=>c.document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.id===id)),showStartupProblem:message=>{throw Error(message);},alert:()=>{},confirm:()=>true,initHonnin:()=>opened.push('honnin'),initKazoku:()=>opened.push(storage.getItem('kazokuOnly')==='1'?'konly':'kazoku'),memWatchUnsub:null,honninUnsub:null,yoteiUnsub:null,evUnsub:null,ytListUnsub:null,watchTagUnsub:null,medicineInfoUnsub:null,personHistoryUnsub:null,pendingUnsub:null,familyOnlyUnsubs:[],clockTimer:null});
 vm.runInContext(fs.readFileSync('consent-ui.js','utf8'),c);
 vm.runInContext(fs.readFileSync('household-ui.js','utf8'),c);
 vm.runInContext(source('let pendingMode=null;','function setupConnectPage(){')+'\n'+source('async function finishSetup(){','async function copyPendingHelp(){')+'\n'+source('function startMode(){','function resetMode(){'),c);
 return {dom,c,storage,docs,opened,listeners,active:()=>c.document.querySelector('.page.active')?.id,async boot(){await c.bootHouseholdUser(auth.currentUser);},async choose(mode){c.pickMode(mode);const kind=mode==='konly'?'b':'a';assert.equal(this.active(),'consent-'+kind);assert.match(c.document.getElementById('consent-mode-'+kind).textContent,/選んだ使い方/);c.document.querySelectorAll('#consent-'+kind+' input[data-consent]').forEach(el=>el.checked=true);await c.submitConsent(kind);},close(){dom.window.close();}};
}

// 公開不具合の再現条件: 端末に家族、サーバーに本人、同意は未保存。
{
 const f=fixture('kazoku','honnin');await f.boot();
 assert.equal(f.active(),'entry','未選択の旧設定で同意画面やホームに直行しない');
 assert.deepEqual(f.opened,[]);assert.equal(f.c.document.querySelectorAll('#select-box button').length,3);
 await f.choose('konly');assert.deepEqual(f.opened,['konly']);f.close();
}
for(const oldMode of modes)for(const chosen of modes){
 const f=fixture(oldMode,oldMode);await f.boot();assert.equal(f.active(),'entry');
 await f.choose(chosen);
 assert.equal(f.active(),chosen==='honnin'?'honnin':'kazoku');
 assert.deepEqual(f.opened,[chosen],`${oldMode}の端末から${chosen}を選んだ直後に別モードを開かない`);
 assert.equal(f.docs.get('consents/one').mode,chosen);assert.equal(f.docs.get('groups/home/members/one').mode,chosen);
 assert.equal(f.storage.getItem('mainicoPendingMode'),chosen,'古い途中設定で選択を上書きしない');
 await f.boot();assert.deepEqual(f.opened,[chosen,chosen],'再起動でも同じ画面を開く');
 f.c.pickMode(chosen);f.c.cancelConsent();assert.equal(f.active(),'entry');f.close();
}
for(const mode of modes){
 const f=fixture(null,mode,mode);await f.boot();assert.equal(f.active(),'entry','利用方法変更・曖昧な復旧で三択を省略しない');assert.deepEqual(f.opened,[]);f.close();
}
{
 const f=fixture('honnin','honnin','honnin');f.storage.removeItem('mainicoModeChoiceV1');await f.boot();
 assert.equal(f.active(),'entry','修正前に同意済みの端末でも初回は使い方を明示的に選び直す');
 await f.choose('kazoku');assert.deepEqual(f.opened,['kazoku']);f.close();
}
{
 const f=fixture('honnin','honnin','honnin');await f.boot();assert.deepEqual(f.opened,['honnin']);
 const listener=f.listeners.findLast(x=>x.path==='consents/one'&&x.active);
 listener.ok({exists:false,metadata:{fromCache:false,hasPendingWrites:false}});
 assert.equal(f.active(),'entry','別タブ撤回でも古い使い方へ誘導しない');
 await f.choose('kazoku');assert.deepEqual(f.opened,['honnin','kazoku']);f.close();
}
{
 const f=fixture('honnin','honnin');await f.boot();
 let release,started;const wait=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const original=f.c.refreshHousehold;f.c.refreshHousehold=async()=>{started();await wait;return original();};
 const saving=f.choose('konly');await ready;f.c.showConsentModeChoice();release();await saving;
 assert.equal(f.active(),'entry','同意変更後の古い初期設定応答で三択を上書きしない');assert.deepEqual(f.opened,[]);f.close();
}
console.log('consent routing: actual boot→choice→consent→setup→home, 9 switches, stale settings, restart, reset and cross-tab withdrawal passed');
