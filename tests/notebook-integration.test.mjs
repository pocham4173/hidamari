import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../notebook-integration.js',import.meta.url),'utf8');
const lifecycle=fs.readFileSync(new URL('../household-ui.js',import.meta.url),'utf8');
function setup(){
 const calls=[];let fail=false;
 const store={clearScope:async(u,g)=>{calls.push(['scope',u,g]);if(fail)throw Error('quota');},clearUid:async u=>calls.push(['uid',u]),abortPending:()=>calls.push(['abort'])};
 const ui={open:()=>calls.push(['open']),openCleanup:()=>calls.push(['all-confirmation']),invalidate:()=>calls.push(['close'])};
 const c={window:{MainicoNotebook:{createStore:()=>store,createUi:o=>{assert.equal(o.store,store);return ui;}}},uid:()=> 'u1',gid:()=> 'g1',recoveryBusy:false,deletionBusy:false,accountClosureBusy:false,accountClosureStopping:false,householdDeleting:false,householdVerified:true,alert:()=>{}};
 vm.createContext(c);vm.runInContext(source,c);return {c,calls,fail:()=>{fail=true;}};
}
{
 const {c}=setup();assert.equal(c.notebookContext().canSave,true);c.householdVerified=false;assert.equal(c.notebookContext().allowed,true);assert.equal(c.notebookContext().canSave,false);
 for(const flag of ['recoveryBusy','deletionBusy','accountClosureBusy','accountClosureStopping','householdDeleting']){c[flag]=true;assert.equal(c.notebookContext().allowed,false);c[flag]=false;}
 c.uid=()=>'';assert.equal(c.notebookContext().allowed,false);
}
{
 const e=setup();e.c.openMedicineNotebook();assert.equal(await e.c.window.mainicoNotebookCleanup({uid:'old-user',groupId:'old-family'}),true);assert.ok(e.calls.some(x=>x[0]==='close'));assert.deepEqual(e.calls.find(x=>x[0]==='scope'),['scope','old-user','old-family']);
 assert.equal(await e.c.window.mainicoNotebookCleanup({uid:'old-user'},true),true);assert.deepEqual(e.calls.find(x=>x[0]==='uid'),['uid','old-user']);
 e.fail();assert.equal(await e.c.window.mainicoNotebookCleanup({uid:'u1',groupId:'g1'}),false);
 assert.equal(await e.c.window.mainicoNotebookCleanup({uid:'',groupId:'g1'}),false);
 e.c.openNotebookCleanup();assert.ok(e.calls.some(x=>x[0]==='all-confirmation'));
}
// A completed server deletion must not claim that failed device cleanup succeeded.
for(const success of [true,false]){
 const nodes=new Map();let notice='',captured,clearSettings=0;
 const c={deletionBusy:false,isHouseholdOwner:()=>true,deletionResumeOnly:false,uid:()=> 'u1',gid:()=> 'g1',MainicoDeletion:{CONFIRMATION:'共有データを削除'},document:{querySelectorAll:()=>[],getElementById:id=>{if(!nodes.has(id))nodes.set(id,{value:'共有データを削除',textContent:'',classList:{remove(){}}});return nodes.get(id);}},stopHouseholdSubscriptions(){},showPage(){},getDeletionService:()=>({run:async()=>{}}),clearNotebookForExit:async scope=>{captured=scope;return success;},clearMainicoDeviceData:()=>{clearSettings++;return true;},showHouseholdBlocked:m=>{notice=m;},householdDeleting:false,refreshHousehold:async()=>null};
 vm.createContext(c);vm.runInContext(lifecycle.slice(lifecycle.indexOf('async function runHouseholdDeletion(){'),lifecycle.indexOf('async function clearNotebookForExit(')),c);
 await c.runHouseholdDeletion();assert.equal(captured.uid,'u1');assert.equal(captured.groupId,'g1');assert.equal(clearSettings,1);
 assert.match(notice,success ? /この家庭・アカウントのお薬手帳/ : /消去を確認できません/);assert.equal(c.deletionBusy,false);
}
console.log('notebook integration: offline read/save gate, context closure, exact cleanup scope, failure reporting passed');
