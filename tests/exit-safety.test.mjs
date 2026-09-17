import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync(new URL('../household-ui.js',import.meta.url),'utf8');
const start=source.indexOf('let disconnectedDeviceResetBusy=false;');
const end=source.indexOf('// 削除成功時のAuthイベント',start);
assert.ok(start>=0&&end>start);
const code=source.slice(start,end);
const snapshot=(data,metadata={fromCache:false,hasPendingWrites:false})=>({exists:data!==null,data:()=>data,metadata});
const denied=()=>Object.assign(Error('denied'),{code:'permission-denied'});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(){
  let user='member',group='family';
  const state={reads:[],effects:[],alerts:[],confirmations:0,pending:null,confirmed:true,
    pointer:snapshot({groupId:'family'}),group:snapshot({createdBy:'owner'}),member:snapshot(null),hooks:{}};
  const read=async(type,id,options)=>{
    assert.equal(options.source,'server');state.reads.push([type,id]);
    if(state.hooks[type])return state.hooks[type]();
    return state[type];
  };
  const c={uid:()=>user,gid:()=>group,householdBootGeneration:1,deletionBusy:false,recoveryBusy:false,accountClosureBusy:false,
    confirm:()=>{state.confirmations++;return state.confirmed;},alert:message=>state.alerts.push(message),
    getDeletionService:()=>({getPending:()=>state.pending}),
    db:{collection:name=>({doc:id=>name==='accounts'?{
      get:options=>read('pointer',id,options),
      delete:async()=>{state.effects.push(['pointer-delete',id]);if(state.hooks.delete)return state.hooks.delete();}
    }:{get:options=>read('group',id,options),collection:child=>({doc:memberId=>({get:options=>read('member',id+'/'+child+'/'+memberId,options)})})}})},
    stopHouseholdSubscriptions:()=>{state.effects.push(['stop']);c.householdBootGeneration++;},
    clearNotebookForExit:async scope=>{state.effects.push(['notebook',scope.uid,scope.groupId]);return state.hooks.notebook?state.hooks.notebook():true;},
    clearMainicoDeviceData:()=>{state.effects.push(['settings']);group='';return state.hooks.settings?state.hooks.settings():true;},
    location:{reload:()=>state.effects.push(['reload'])}};
  vm.createContext(c);vm.runInContext(code,c);
  return{c,state,changeUid:()=>user='replacement',changeGroup:()=>group='new-family',changeGeneration:()=>c.householdBootGeneration++,setGroup:value=>group=value};
}
function unchanged(f){assert.deepEqual(f.state.effects,[],'不明な接続状態では復旧先・端末保存を変更しない');}

// The original bug: unreadable member data is not a missing membership.
for(const failure of [Error('unavailable'),denied()]){
  const f=fixture();f.state.hooks.group=async()=>{throw denied();};f.state.hooks.member=async()=>{throw failure;};
  await f.c.resetDisconnectedDevice();unchanged(f);assert.match(f.state.alerts.at(-1),/保存内容は消していません/);
}
for(const field of ['pointer','group','member']){
  for(const metadata of [{fromCache:true},{fromCache:false,hasPendingWrites:true},{}]){
    const f=fixture();f.state[field]=snapshot(field==='member'?null:field==='group'?{createdBy:'owner'}:{groupId:'family'},metadata);
    await f.c.resetDisconnectedDevice();unchanged(f);
  }
  for(const invalid of [null,{},undefined]){
    const f=fixture();f.state[field]=invalid;await f.c.resetDisconnectedDevice();unchanged(f);
  }
}
{
  const f=fixture();f.state.hooks.group=async()=>{throw Error('offline');};await f.c.resetDisconnectedDevice();unchanged(f);
  assert.equal(f.state.reads.some(([kind])=>kind==='member'),false);
}
for(const member of [{status:'approved'},{status:'pending'}]){
  const f=fixture();f.state.member=snapshot(member);await f.c.resetDisconnectedDevice();unchanged(f);assert.match(f.state.alerts.at(-1),/参加中/);
}
{
  const f=fixture();f.state.group=snapshot({createdBy:'member'});await f.c.resetDisconnectedDevice();unchanged(f);assert.match(f.state.alerts.at(-1),/管理者/);
}
{
  const f=fixture();f.state.pointer=snapshot({groupId:'different-family'});await f.c.resetDisconnectedDevice();unchanged(f);
  assert.equal(f.state.reads.length,1,'別の家庭の復旧先に触れない');
}
{
  const f=fixture();f.setGroup('');await f.c.resetDisconnectedDevice();unchanged(f);
}
{
  const f=fixture();f.state.pending={groupId:'family'};await f.c.resetDisconnectedDevice();unchanged(f);assert.equal(f.state.reads.length,0);
}
{
  const f=fixture();f.state.confirmed=false;await f.c.resetDisconnectedDevice();unchanged(f);assert.equal(f.state.reads.length,0);
}
for(const busy of ['deletionBusy','recoveryBusy','accountClosureBusy']){
  const f=fixture();f.c[busy]=true;await f.c.resetDisconnectedDevice();unchanged(f);assert.equal(f.state.confirmations,0);
}

// A missing group or an explicitly missing own membership is a verified exit.
for(const groupRemoved of [false,true]){
  const f=fixture();
  if(groupRemoved){f.state.group=snapshot(null);f.state.hooks.member=async()=>{throw Error('missing-group membership is unreadable');};}
  else f.state.hooks.group=async()=>{throw denied();};
  await f.c.resetDisconnectedDevice();
  assert.deepEqual(f.state.effects,[['pointer-delete','member'],['stop'],['notebook','member','family'],['settings'],['reload']]);
  if(groupRemoved)assert.equal(f.state.reads.some(([kind])=>kind==='member'),false);
}
{
  const f=fixture();f.state.pointer=snapshot(null);f.state.group=snapshot(null);await f.c.resetDisconnectedDevice();
  assert.equal(f.state.effects.some(([kind])=>kind==='pointer-delete'),false,'既に消えた復旧先を再削除しない');
  assert.equal(f.state.effects.at(-1)[0],'reload');
}
{
  const f=fixture();f.setGroup('');f.state.pointer=snapshot(null);await f.c.resetDisconnectedDevice();
  assert.equal(f.state.effects.some(([kind])=>kind==='pointer-delete'),false);assert.equal(f.state.effects.at(-1)[0],'reload');
}

// Every awaited stage checks the captured UID, family and boot generation.
for(const stage of ['pointer','group','member','delete','notebook']){
  for(const change of ['changeUid','changeGroup','changeGeneration']){
    const f=fixture(),waiting=deferred();f.state.hooks[stage]=()=>waiting.promise;
    const action=f.c.resetDisconnectedDevice();
    for(let i=0;i<12;i++)await Promise.resolve();
    assert.ok(stage==='delete'||stage==='notebook'?f.state.effects.some(([kind])=>kind===(stage==='delete'?'pointer-delete':'notebook')):f.state.reads.some(([kind])=>kind===stage),stage+' was reached');
    const before=JSON.stringify(f.state.effects);f[change]();
    waiting.resolve(['pointer','group','member'].includes(stage)?f.state[stage]:true);await action;
    assert.equal(JSON.stringify(f.state.effects),before,'旧 '+stage+' 応答は新しい家庭を消去しない');
    assert.equal(f.state.alerts.length,0,'旧操作の結果を新しい家庭へ出さない');
  }
}
{
  const f=fixture(),waiting=deferred();f.state.hooks.pointer=()=>waiting.promise;
  const first=f.c.resetDisconnectedDevice();await f.c.resetDisconnectedDevice();assert.equal(f.state.reads.length,1,'連打で同時に終了しない');
  waiting.reject(Error('offline'));await first;unchanged(f);
  delete f.state.hooks.pointer;await f.c.resetDisconnectedDevice();assert.equal(f.state.effects.at(-1)[0],'reload','読込失敗後に再確認できる');
}
for(const fail of ['delete','notebook','settings']){
  const f=fixture();
  if(fail==='delete')f.state.hooks.delete=async()=>{throw denied();};
  else f.state.hooks[fail]=()=>false;
  await f.c.resetDisconnectedDevice();assert.equal(f.state.effects.some(([kind])=>kind==='reload'),false);
  if(fail==='delete')assert.equal(f.state.effects.some(([kind])=>kind==='notebook'),false);
  if(fail==='notebook')assert.equal(f.state.effects.some(([kind])=>kind==='settings'),false);
  assert.ok(f.state.alerts.length>0,'片付け失敗は完了扱いしない');
}
console.log('exit safety: verified absence only, unreadable/cached/pending preservation, UID/group/generation isolation, deduplication, retry and partial failure passed');
