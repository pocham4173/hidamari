import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const entry=html.slice(html.indexOf('let pendingMode=null;'),html.indexOf('function agreeConsent('));
const finish=html.slice(html.indexOf('async function finishSetup(){'),html.indexOf('let pendingUnsub=null;'));
function fixture(){
 const data=new Map([['mainicoPendingMode','honnin'],['mainicoMode','kazoku']]);
 const elements=new Map();const pages=[];const errors=[];const timers=[];
 let release;const wait=new Promise(r=>release=r);
 const c={showConsentFlow:(mode)=>pages.push(mode==='konly'?'consent-b':'consent-a'),ensureConsentForMode:async()=>true,document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{textContent:''});return elements.get(id);}},previewStorage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},uid:()=> 'owner',gid:()=> 'home',showPage:p=>pages.push(p),afterConsent:()=>pages.push('after-consent'),refreshHousehold:()=>wait,householdDeleting:false,col:()=>({doc:()=>({update:async()=>{}})}),saveRecoveryPointer:async()=>{},startMode:()=>pages.push('started'),watchHouseholdAccess:()=>{},showHouseholdBlocked:m=>errors.push(m),setTimeout:f=>{timers.push(f);return timers.length;},clearTimeout:()=>{}};
 vm.createContext(c);vm.runInContext(entry+'\n'+finish,c);return{c,data,elements,pages,errors,timers,release};
}
for(const mode of ['honnin','kazoku','konly']){
 const e=fixture();e.c.pickMode(mode);assert.equal(e.pages.at(-1),mode==='konly'?'consent-b':'consent-a');
}
{
 const e=fixture();e.data.set('mainicoConsent-a','yes');e.c.pickMode('honnin');assert.equal(e.pages.at(-1),'consent-a','旧localStorageフラグで同意を省略しない');
}
{
 const e=fixture();e.c.showConsentFlow=()=>{throw Error('blocked');};e.c.pickMode('honnin');assert.match(e.elements.get('entry-state').textContent,/保存情報は消さず/);assert.equal(e.data.get('mainicoMode'),'kazoku');
}
{
 const e=fixture();const pending=e.c.finishSetup();await new Promise(setImmediate);assert.equal(e.pages[0],'household-status-page');assert.match(e.elements.get('household-status-text').textContent,/確認しています/);assert.equal(e.data.get('mainicoMode'),'kazoku');
 e.c.pickMode('konly');assert.match(e.elements.get('entry-state').textContent,/お待ち/);e.timers[0]();assert.match(e.elements.get('household-status-text').textContent,/時間がかかっています/);
 e.release();await pending;assert.equal(e.data.get('mainicoMode'),'honnin');assert.equal(e.pages.at(-1),'started');
}
{
 const e=fixture();e.c.saveRecoveryPointer=async()=>{throw Error('permission-denied');};const pending=e.c.finishSetup();e.release();await pending;assert.equal(e.data.get('mainicoMode'),'kazoku');assert.equal(e.errors.length,1);assert.ok(!e.pages.includes('started'));
}
{
 const e=fixture();const pending=e.c.finishSetup();e.c.uid=()=> 'different-account';e.release();await pending;assert.equal(e.errors.length,1);assert.equal(e.data.get('mainicoMode'),'kazoku');
}
{
 const e=fixture();e.c.gid=()=>{throw Error('storage blocked');};await e.c.finishSetup();assert.equal(e.errors.length,1);
 e.c.gid=()=> 'home';const pending=e.c.finishSetup();await new Promise(setImmediate);assert.equal(e.pages.at(-1),'household-status-page');e.release();await pending;assert.equal(e.pages.at(-1),'started');
}
{
 const e=fixture();const consent=html.slice(html.indexOf('function agreeConsent('),html.indexOf('function afterConsent('));
 const name=html.slice(html.indexOf('function saveName('),html.indexOf('let groupCreating=false;'));
 e.c.document.querySelectorAll=()=>[{checked:true}];e.c.alert=m=>e.errors.push(m);e.c.document.getElementById('in-name').value='名前';
 e.c.previewStorage.setItem=()=>{throw Error('storage blocked');};vm.runInContext(consent+'\n'+name,e.c);
 e.c.saveName();assert.equal(e.errors.length,1);assert.equal(e.pages.length,0);
}
console.log('entry mode: 10 regression groups passed');
