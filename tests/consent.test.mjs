import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url),Consent=require('../consent.js');
const html=fs.readFileSync('index.html','utf8');
const ui=fs.readFileSync('consent-ui.js','utf8');
const fields=['privacy','sensitive','sharing','disclaimer','subject'];
function fixture(){
 const dom=new JSDOM(html,{url:'https://example.invalid/hidamari/',runScripts:'outside-only'}),c=dom.getInternalVMContext();
 const records=new Map(),listeners=[];let writes=0,resumes=0,failed=false,hold=null,stopped=0;
 const auth={currentUser:{uid:'one'}};
 const db={runTransaction:async fn=>{if(hold)await hold;return fn({get:ref=>ref.get(),set:(ref,v)=>ref.set(v),delete:ref=>ref.delete()});},collection:name=>({doc:id=>({
  get:async()=>{if(failed)throw Error('offline');return {exists:records.has(id),data:()=>records.get(id),metadata:{fromCache:false,hasPendingWrites:false}};},
  set:async v=>{if(failed)throw Error('denied');if(hold)await hold;records.set(id,v);writes++;},
  delete:async()=>{if(failed)throw Error('offline');records.delete(id);},
  onSnapshot:(opts,ok,error)=>{const item={id,ok,error,stopped:false};listeners.push(item);return ()=>item.stopped=true;}
 })})};
 Object.assign(c,{MainicoConsent:Consent,db,auth,pendingMode:null,uid:()=>auth.currentUser.uid,gid:()=>'',isKOnly:()=>false,previewStorage:{getItem:()=>null},firebase:{firestore:{FieldValue:{serverTimestamp:()=>({seconds:123})}}},stopHouseholdSubscriptions:()=>stopped++,showPage:id=>c.document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===id)),confirm:()=>true,alert:()=>{},bootHouseholdUser:async()=>resumes++});
 vm.runInContext(ui,c);
 return {dom,c,records,listeners,auth,checks:kind=>[...c.document.querySelectorAll('#consent-'+kind+' input[data-consent]')],resume:async()=>resumes++,get writes(){return writes},get resumes(){return resumes},get stopped(){return stopped},fail:v=>failed=v,hold:v=>hold=v};
}
for(const mode of ['honnin','kazoku','konly']){
 const f=fixture(),kind=mode==='konly'?'b':'a';f.c.showConsentFlow(mode,f.resume);
 assert.ok(f.checks(kind).every(x=>!x.checked));assert.equal(f.checks(kind).length,5);
 await f.c.submitConsent(kind);assert.equal(f.writes,0);assert.equal(f.resumes,0);
 for(const input of f.checks(kind)){input.checked=true;if(input!==f.checks(kind).at(-1)){await f.c.submitConsent(kind);assert.equal(f.writes,0);}}
 await f.c.submitConsent(kind);assert.equal(f.resumes,1);assert.ok(f.c.hasSessionConsent(mode));
 const value=f.records.get('one');assert.equal(value.version,Consent.VERSION);assert.equal(value.subjectBasis,mode==='honnin'?'self':'explained-and-agreed');
 f.c.clearConsentSession();assert.equal(await f.c.ensureConsentForMode(mode,f.resume),true,'再起動はサーバー同意で再開');
 f.records.set('one',{...value,version:'old'});f.c.clearConsentSession();assert.equal(await f.c.ensureConsentForMode(mode,f.resume),false);assert.ok(f.checks(kind).every(x=>!x.checked));
 f.dom.window.close();
}
{
 const f=fixture();f.c.showConsentFlow('honnin',f.resume);f.checks('a').forEach(x=>x.checked=true);f.fail(true);await f.c.submitConsent('a');assert.equal(f.resumes,0);assert.equal(f.c.hasSessionConsent('honnin'),false);assert.match(f.c.document.getElementById('consent-state-a').textContent,/保存を確認できません/);f.fail(false);
 let release;f.hold(new Promise(r=>release=r));const saving=f.c.submitConsent('a');await Promise.resolve();f.auth.currentUser={uid:'two'};release();await saving;assert.equal(f.resumes,0,'アカウント切替後は旧同意で進まない');f.dom.window.close();
}
{
 const f=fixture();f.c.showConsentFlow('kazoku',f.resume);f.checks('a').forEach(x=>x.checked=true);await f.c.submitConsent('a');
 const listener=f.listeners.at(-1);f.records.delete('one');listener.ok({exists:false,metadata:{fromCache:false,hasPendingWrites:false}});
 assert.equal(f.c.hasSessionConsent('kazoku'),false);assert.ok(f.stopped>1);assert.equal(f.c.document.querySelector('.page.active').id,'entry');
 f.c.showConsentFlow('kazoku',f.resume);f.checks('a').forEach(x=>x.checked=true);await f.c.submitConsent('a');await f.c.withdrawCurrentConsent();assert.equal(f.records.has('one'),false);assert.equal(f.c.hasSessionConsent('kazoku'),false);f.dom.window.close();
}
{
 const f=fixture();f.c.showConsentFlow('honnin',f.resume);f.c.cancelConsent();await f.c.submitConsent('a');assert.equal(f.writes,0);assert.equal(f.resumes,0);f.dom.window.close();
}
for(const mode of ['honnin','kazoku','konly'])assert.equal(Consent.valid({version:Consent.VERSION},mode),false);
console.log('consent: unchecked/partial agreement, 3 modes, server version, restart, failed save, account switch, cross-tab withdrawal and decline passed');
